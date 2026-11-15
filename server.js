require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./lib/db');
const googleWallet = require('./lib/google-wallet');
const sellosPng = require('./lib/sellos-png');
const appleWallet = require('./lib/apple-wallet');
const { enviarCodigoReset, enviarRecordatorioInactividad, enviarAvisoNuevoNegocio, enviarAlertaAdmin } = require('./lib/email');
const totp = require('./lib/totp');
const stripePagos = require('./lib/stripe-pagos');

// No hay valor "por default" para estas dos claves a propósito: si faltan,
// el servidor se niega a arrancar en vez de arrancar inseguro sin avisar
// (antes tenían un valor de respaldo tipo "cambia-esto-en-produccion", que
// es justo lo que un atacante probaría primero). Se configuran en Render →
// Environment → Environment Variables.
const JWT_SECRET = process.env.APP_JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!JWT_SECRET || !ADMIN_SECRET) {
      console.error(
              'Faltan APP_JWT_SECRET y/o ADMIN_SECRET en las variables de entorno. ' +
              'El servidor no arranca sin ellas (ver Render → Environment).'
            );
      process.exit(1);
}

const app = express();
// Render pone un proxy delante del servidor. Sin esto Express cree que TODAS
// las peticiones vienen de la misma dirección (la del proxy), y los límites
// de intentos de más abajo se compartían entre todos los negocios y clientes
// del mundo: 20 inicios de sesión cada 15 minutos EN TOTAL, no por persona
// (y express-rate-limit llenaba los logs con ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors());

// La dirección real de quien hace la petición. Render recibe el tráfico a
// través de Cloudflare, que la manda en "CF-Connecting-IP" (el visitante no
// puede falsificarla: Cloudflare la sobreescribe). Si no viene, se usa la
// que calcula Express con "trust proxy".
function ipCliente(req) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(cf)) return cf;
      return req.ip;
}

// Cabeceras básicas de seguridad HTTP (equivalente a lo mínimo de "helmet",
// sin agregar esa dependencia): evita que el navegador adivine el tipo de
// contenido, bloquea que esta API se cargue dentro de un <iframe> ajeno, y
// no manda el Referer completo a terceros.
app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      // Las respuestas de la API llevan datos de negocios y clientes: que
      // ningún navegador ni proxy intermedio las guarde en caché.
      if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
      next();
});

// IMPORTANTE: con Postgres, cada ruta ahora es "async" y puede rechazar su
// promesa (por ejemplo si alguien manda un id que no es un UUID válido, o si
// la base de datos tiene un hipo momentáneo). Express 4 NO atrapa esos
// errores solo: si una ruta async truena sin este envoltorio, Node.js la
// trata como un error no manejado y TUMBA TODO EL SERVIDOR para TODOS los
// negocios, no solo para quien hizo la petición mala. "ah" envuelve cada
// ruta para que cualquier error termine como una respuesta 500 normal
// (ver el manejador de errores hasta abajo del archivo) en vez de tirar
// el proceso completo. Va hasta arriba (antes incluso de express.json())
// porque la ruta del webhook de Stripe, justo abajo, ya la necesita.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// A dónde regresa el negocio después de pagar (o de abrir el portal de
// facturación) en Stripe. Es el panel, no el backend — por eso es una
// variable separada de PUBLIC_URL (que es la URL del backend).
const PANEL_URL = (process.env.PANEL_URL || 'https://argayes.com').replace(/\/$/, '');

// El webhook de Stripe necesita el cuerpo CRUDO (sin parsear) para poder
// verificar la firma — por eso esta ruta va ANTES de express.json(), con
// su propio parser "raw". Cualquier otra ruta nueva que se agregue abajo
// de esto sí recibe el body ya parseado como de costumbre.
app.post('/api/pagos/webhook', express.raw({ type: 'application/json' }), ah(async (req, res) => {
      const firma = req.headers['stripe-signature'];
      try {
              await stripePagos.manejarWebhook(db, req.body, firma);
              res.json({ recibido: true });
      } catch (e) {
              // Si la firma no cuadra o algo más falla, respondemos 400 — así
              // Stripe lo marca como fallido y lo reintenta solo, en vez de
              // darlo por bueno y perder el evento.
              console.error('Error procesando webhook de Stripe:', e.message);
              res.status(400).json({ error: e.message });
      }
}));

// Límite más alto que el default (100kb) porque el logo del negocio llega
// como imagen codificada en base64 dentro del JSON (puede pesar varios MB).
app.use(express.json({ limit: '8mb' }));

// Sirve el logo por defecto que usa Google Wallet (programLogo es obligatorio
// para poder guardar la tarjeta de lealtad: necesita una URL pública HTTPS,
// no sirve una imagen en base64). Queda en /public/logo-argayes.png.
app.use('/public', express.static(path.join(__dirname, 'public')));

// Freno a intentos de adivinar contraseña a fuerza bruta: máximo 20 intentos
// de login por IP cada 15 minutos. No afecta el uso normal (una empresa no
// falla su contraseña 20 veces en 15 minutos).
const limitadorLogin = rateLimit({
      keyGenerator: ipCliente,
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' }
});

// Mismo freno de fuerza bruta, pero para "olvidé mi contraseña" — evita que
// alguien use ese formulario para mandar correos en cadena a un negocio, o
// para probar miles de códigos de 6 dígitos adivinando.
const limitadorReset = rateLimit({
      keyGenerator: ipCliente,
      windowMs: 15 * 60 * 1000,
      limit: 8,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' }
});

// Freno para solicitudes de registro de NEGOCIO: sin esto, cualquiera podía
// mandar miles de solicitudes de suscripción falsas sin límite (no cuesta
// nada intentarlo, solo llenaría tu lista de "pendientes" de basura).
const limitadorRegistro = rateLimit({
      keyGenerator: ipCliente,
      windowMs: 60 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiadas solicitudes de registro desde esta conexión. Intenta de nuevo más tarde.' }
});

// Freno para alta de CLIENTES: esta ruta es pública a propósito (la usa
// cualquier cliente final desde el link de registro, sin cuenta ni login),
// así que sin límite alguien podría automatizar la creación de miles de
// clientes falsos para un negocio. El número es generoso a propósito: un
// stand de registro real puede tener a varias personas dándose de alta
// seguido desde el mismo wifi.
const limitadorClientes = rateLimit({
      keyGenerator: ipCliente,
      windowMs: 15 * 60 * 1000,
      limit: 40,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' }
});

// Freno a quien intente adivinar la clave de super-admin: 10 intentos
// fallidos por conexión cada 15 minutos (los aciertos no cuentan, así que
// usar el panel de super-admin con normalidad nunca lo dispara).
const limitadorAdmin = rateLimit({
      keyGenerator: ipCliente,
      windowMs: 15 * 60 * 1000,
      limit: 10,
      skipSuccessfulRequests: true,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' }
});

// Recordatorios por correo: máximo 4 envíos por hora por negocio — para que
// un botón apretado varias veces no termine en correos repetidos.
const limitadorRecordatorios = rateLimit({
      keyGenerator: (req) => 'recordatorio:' + req.empresaId,
      windowMs: 60 * 60 * 1000,
      limit: 4,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Ya enviaste recordatorios hace poco. Intenta de nuevo en un rato.' }
});

function sinDatosSensibles(empresa) {
      const { passwordHash, ...resto } = empresa;
      return resto;
}

// Lo ÚNICO de un negocio que puede ver cualquiera con su link de registro:
// lo que se necesita para pintar su tarjeta. Antes esta ruta pública
// regresaba todo el registro (correo del dueño, ids de Stripe, estado de la
// suscripción...).
function empresaPublica(empresa) {
      return {
              id: empresa.id,
              nombre: empresa.nombre,
              logoUrl: empresa.logoUrl,
              color: empresa.color,
              colorBoton: empresa.colorBoton,
              fuente: empresa.fuente,
              selloForma: empresa.selloForma,
              selloTamano: empresa.selloTamano,
              slug: empresa.slug,
              recompensa: empresa.recompensa,
              umbral: empresa.umbral
      };
}

// Lo mismo para un cliente: su tarjeta pública no necesita (ni debe
// mostrar) su teléfono o correo.
function clientePublico(cliente) {
      return {
              id: cliente.id,
              empresaId: cliente.empresaId,
              nombre: cliente.nombre,
              puntos: cliente.puntos,
              creado: cliente.creado
      };
}

// Protege las rutas del panel: solo responde si el token es válido, y
// mete req.empresaId para que cada ruta filtre SOLO lo de esa empresa —
// así una empresa nunca puede ver ni tocar los datos de otra.
function requireAuth(req, res, next) {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Falta el token de sesión' });
      try {
              const payload = jwt.verify(token, JWT_SECRET);
              req.empresaId = payload.empresaId;
              next();
      } catch (e) {
              res.status(401).json({ error: 'Sesión inválida o vencida' });
      }
}

// Además de un token válido, confirma que la suscripción de esa empresa
// siga activa (ARGAYES puede desactivarla si no paga). Se separa de
// requireAuth porque necesita consultar la base de datos (async).
const requireEmpresaActiva = ah(async (req, res, next) => {
      const empresa = await db.obtenerEmpresa(req.empresaId);
      if (!empresa) return res.status(401).json({ error: 'Sesión inválida o vencida' });
      if (empresa.activa === false) {
              return res.status(403).json({ error: 'Tu suscripción no está activa. Reactívala en Ajustes → Suscripción para seguir sumando visitas.' });
      }
      if (db.pruebaVencida(empresa)) {
              return res.status(403).json({ error: 'Tu prueba gratis terminó. Activa tu suscripción en Ajustes → Suscripción para seguir sumando visitas.' });
      }
      req.empresa = empresa;
      next();
});

// ---------- Super-admin: clave + código del teléfono (2 pasos) ----------
// Entrar al super-admin pide la clave (ADMIN_SECRET) Y un código de 6
// dígitos de una app autenticadora (Google Authenticator, etc.). Con las
// dos se emite una sesión de 8 horas. La sesión se firma con una llave
// derivada de APP_JWT_SECRET + ADMIN_SECRET: cambiar ADMIN_SECRET en Render
// cierra al instante todas las sesiones abiertas del super-admin. Y como es
// otra llave, un token de negocio nunca sirve como token de admin (ni al
// revés).
const LLAVE_SESION_ADMIN = crypto.createHash('sha256').update('argayes-admin:' + JWT_SECRET + ':' + ADMIN_SECRET).digest();
const AJUSTE_TOTP = 'totp_secreto';
const AJUSTE_TOTP_PENDIENTE = 'totp_pendiente';
let ultimoContadorTotp = null; // un código ya usado no se acepta otra vez

function claveAdminCorrecta(clave) {
      const a = crypto.createHash('sha256').update(String(clave || '')).digest();
      const b = crypto.createHash('sha256').update(ADMIN_SECRET).digest();
      return !!clave && crypto.timingSafeEqual(a, b);
}

function firmarSesionAdmin(alcance) {
      return jwt.sign({ adm: alcance }, LLAVE_SESION_ADMIN, { expiresIn: alcance === 'completo' ? '8h' : '15m' });
}

function sesionAdminDe(req) {
      const header = req.headers.authorization || '';
      if (!header.startsWith('Bearer ')) return null;
      try {
              const p = jwt.verify(header.slice(7), LLAVE_SESION_ADMIN);
              return p && p.adm ? p.adm : null;
      } catch (e) {
              return null;
      }
}

// Rutas normales del super-admin: solo con sesión completa (clave + código).
function requireAdmin(req, res, next) {
      if (sesionAdminDe(req) !== 'completo') {
              return res.status(401).json({ error: 'Tu sesión de super-admin expiró. Vuelve a entrar.' });
      }
      next();
}

// Alertas por correo. Las entradas exitosas se avisan siempre; los
// intentos fallidos se juntan y se avisa máximo una vez cada 15 minutos
// (para que un ataque no te llene el correo de mensajes).
// Además hay un freno global: más de 30 fallos en 15 minutos (desde
// cualquier conexión) bloquea la entrada al super-admin 15 minutos, por si
// alguien intenta adivinar desde muchas conexiones distintas.
const fallosAdmin = { lista: [], ultimoAviso: 0, pendientes: 0, bloqueadoHasta: 0 };
function registrarFalloAdmin(req, motivo) {
      const ahora = Date.now();
      fallosAdmin.lista = fallosAdmin.lista.filter((t) => ahora - t < 15 * 60 * 1000);
      fallosAdmin.lista.push(ahora);
      fallosAdmin.pendientes++;
      if (fallosAdmin.lista.length > 30) fallosAdmin.bloqueadoHasta = ahora + 15 * 60 * 1000;
      if (ahora - fallosAdmin.ultimoAviso > 15 * 60 * 1000) {
              const n = fallosAdmin.pendientes;
              fallosAdmin.ultimoAviso = ahora;
              fallosAdmin.pendientes = 0;
              enviarAlertaAdmin(
                      'Alerta: intento fallido de entrar al super-admin',
                      n === 1 ? 'Alguien intentó entrar al super-admin y falló.' : `Hubo ${n} intentos fallidos de entrar al super-admin.`,
                      [['Motivo', motivo], ['IP', ipCliente(req)], ['Navegador', String(req.headers['user-agent'] || '—').slice(0, 160)], ['Hora', new Date().toLocaleString('es-MX', { timeZone: db.ZONA_HORARIA })]]
              ).catch((e) => console.error('Alerta admin:', e.message));
      }
}
function avisarEntradaAdmin(req, detalle) {
      enviarAlertaAdmin(
              'Alguien entró al super-admin de ARGAYES',
              'Se inició sesión en el super-admin.',
              [['Detalle', detalle], ['IP', ipCliente(req)], ['Navegador', String(req.headers['user-agent'] || '—').slice(0, 160)], ['Hora', new Date().toLocaleString('es-MX', { timeZone: db.ZONA_HORARIA })]]
      ).catch((e) => console.error('Aviso entrada admin:', e.message));
}

// Valida que un id tenga forma de UUID antes de usarlo en una consulta —
// así un id raro (o alguien probando a mano en la URL) responde 400 en vez
// de llegar a Postgres y tronar la consulta.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function esUuidValido(id) {
      return typeof id === 'string' && UUID_RE.test(id);
}

// Ruta mínima para saber que el backend está vivo (healthcheck de Render /
// de quien sea) — sin esto, visitar la URL del backend a secas solo daba 404.
app.get('/', (req, res) => {
      res.json({ ok: true, servicio: 'ARGAYES backend' });
});

// Versión de los Términos y el Aviso de Privacidad publicados en index.html
// (sección "Información legal"). Se guarda junto con la fecha de aceptación;
// súbela cuando cambies esos textos de forma importante.
const TERMINOS_VERSION = '2026-11';

// ---------- Cuenta del negocio: alta y login (Paso 6-A) ----------
app.post('/api/auth/registro', limitadorRegistro, ah(async (req, res) => {
      const { nombre, email, password, recompensa, umbral, color, aceptaTerminos } = req.body || {};
      if (!nombre || !email || !password) {
              return res.status(400).json({ error: 'Falta nombre, email o password' });
      }
      if (!db.textoValido(nombre, 80)) {
              return res.status(400).json({ error: 'Escribe el nombre de tu negocio (máximo 80 caracteres)' });
      }
      if (!db.emailValido(email)) {
              return res.status(400).json({ error: 'Escribe un email válido' });
      }
      if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
              return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }
      if (recompensa !== undefined && recompensa !== null && db.textoValido(String(recompensa), 120, true) === null) {
              return res.status(400).json({ error: 'La recompensa no puede pasar de 120 caracteres' });
      }
      // Sin aceptar los Términos y el Aviso de Privacidad no se crea la cuenta
      // (se guarda la fecha y la versión de lo que aceptó — ver db.crearEmpresa).
      if (aceptaTerminos !== true) {
              return res.status(400).json({ error: 'Para crear tu cuenta debes aceptar los Términos y condiciones y el Aviso de privacidad' });
      }
      try {
              // La cuenta se crea SIN aprobar y SIN activar (ver db.crearEmpresa):
              // cualquiera con el link del panel puede llegar hasta aquí, así que
              // no se le da acceso automático. Por eso ya no se regresa un token
              // de sesión — tiene que esperar a que ARGAYES la apruebe desde el
              // panel de super-admin antes de poder iniciar sesión.
              await db.crearEmpresa({ nombre, email, password, recompensa: recompensa == null ? '' : String(recompensa), umbral, color, terminosAceptados: true, terminosVersion: TERMINOS_VERSION });
              // Mejor esfuerzo: si el correo de aviso falla, la cuenta ya quedó
              // registrada igual — no se bloquea la respuesta por esto.
              enviarAvisoNuevoNegocio(nombre, email).catch((e) => console.error('No se pudo avisar la cuenta nueva:', e.message));
              res.status(201).json({
                      pendiente: true,
                      mensaje: 'Solicitud de suscripción enviada. Nuestro equipo la revisará y activaremos tu cuenta en breve.'
              });
      } catch (e) {
              // Solo "ya existe esa cuenta" se le explica a quien se registra;
              // cualquier otro error es nuestro (base de datos, etc.) y cae al
              // manejador general en vez de mostrarle un mensaje interno.
              if (/Ya existe/.test(e.message)) return res.status(409).json({ error: e.message });
              throw e;
      }
}));

app.post('/api/auth/login', limitadorLogin, ah(async (req, res) => {
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || typeof password !== 'string') {
              return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      }
      const empresa = await db.validarLogin(email, password);
      if (!empresa) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      if (empresa.aprobada === false) {
              return res.status(403).json({ error: 'Tu solicitud de suscripción sigue en revisión. Te avisaremos en cuanto sea aprobada.' });
      }
      // Una cuenta ya aprobada pero con la suscripción inactiva (falló el
      // cobro, la canceló...) SÍ puede entrar: antes se quedaba fuera con
      // "contacta a ARGAYES" y no tenía forma de llegar al botón para
      // actualizar su tarjeta o volver a suscribirse. Lo que no puede hacer
      // mientras siga inactiva es operar (sumar visitas, canjear, mandar
      // recordatorios) — eso lo bloquea requireEmpresaActiva.
      const token = jwt.sign({ empresaId: empresa.id }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ token, empresa: sinDatosSensibles(empresa) });
}));

// ---------- Olvidé mi contraseña (solo negocios) ----------
app.post('/api/auth/olvide-password', limitadorReset, ah(async (req, res) => {
      const { email } = req.body || {};
      if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Falta el email' });
      const empresa = await db.obtenerEmpresaPorEmail(String(email).trim());
      // Responde igual exista o no esa cuenta, para no revelar a quien solo
      // está probando direcciones qué emails sí están registrados en ARGAYES.
      if (empresa) {
              const codigo = await db.crearSolicitudReset(empresa.id);
              try {
                      await enviarCodigoReset(empresa.email, codigo, empresa.nombre);
              } catch (e) {
                      // No se le dice al que pidió el código que falló el envío (de
                      // nuevo, para no filtrar si la cuenta existe) — pero sí queda
                      // registrado en los logs de Render para que tú te enteres.
                      console.error('Error enviando correo de recuperación:', e.message);
              }
      }
      res.json({ ok: true });
}));

app.post('/api/auth/restablecer-password', limitadorReset, ah(async (req, res) => {
      const { email, codigo, nuevaPassword } = req.body || {};
      if (!email || !codigo || !nuevaPassword) {
              return res.status(400).json({ error: 'Falta email, código o nueva contraseña' });
      }
      if (typeof nuevaPassword !== 'string' || nuevaPassword.length < 6 || nuevaPassword.length > 200) {
              return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }
      const empresa = await db.obtenerEmpresaPorEmail(String(email).trim());
      if (!empresa) return res.status(400).json({ error: 'Código inválido o vencido' });
      const valido = await db.validarYConsumirReset(empresa.id, String(codigo).trim());
      if (!valido) return res.status(400).json({ error: 'Código inválido o vencido' });
      await db.actualizarPasswordEmpresa(empresa.id, nuevaPassword);
      res.json({ ok: true });
}));

// ---------- Super-admin (ARGAYES): ver y activar/desactivar negocios ----------
app.use('/api/admin', limitadorAdmin);

// Paso único de entrada: { clave, codigo }.
// - Si la verificación en dos pasos ya está activada: clave + código → sesión completa.
// - Si todavía no: la clave sola da una sesión de 15 minutos que SOLO sirve
//   para activar la verificación (no deja ver ni tocar negocios).
app.post('/api/admin/sesion', ah(async (req, res) => {
      if (Date.now() < fallosAdmin.bloqueadoHasta) {
              return res.status(429).json({ error: 'Demasiados intentos fallidos. La entrada está bloqueada unos minutos.' });
      }
      const { clave, codigo } = req.body || {};
      if (!claveAdminCorrecta(clave)) {
              registrarFalloAdmin(req, 'Clave incorrecta');
              return res.status(401).json({ error: 'Contraseña incorrecta' });
      }
      const secreto = await db.leerAjusteAdmin(AJUSTE_TOTP);
      if (!secreto) {
              return res.json({ token: firmarSesionAdmin('configurar'), configurar2fa: true });
      }
      if (!codigo) return res.status(401).json({ error: 'Escribe el código de 6 dígitos de tu app autenticadora.', requiere2fa: true });
      const contador = totp.verificar(secreto, codigo, ultimoContadorTotp);
      if (contador === null) {
              registrarFalloAdmin(req, 'Clave correcta, código del teléfono incorrecto');
              return res.status(401).json({ error: 'Código incorrecto o vencido. Usa el que aparece ahora en tu app.', requiere2fa: true });
      }
      ultimoContadorTotp = contador;
      avisarEntradaAdmin(req, 'Clave + código del teléfono');
      res.json({ token: firmarSesionAdmin('completo') });
}));

// Genera un secreto nuevo para escanear con la app autenticadora.
app.post('/api/admin/2fa/nuevo', ah(async (req, res) => {
      const alcance = sesionAdminDe(req);
      if (alcance !== 'configurar') return res.status(401).json({ error: 'Vuelve a entrar con tu clave.' });
      if (await db.leerAjusteAdmin(AJUSTE_TOTP)) return res.status(400).json({ error: 'La verificación en dos pasos ya está activada.' });
      // Si ya hay un QR pendiente de hace menos de 15 minutos, se regresa el
      // MISMO (antes, entrar dos veces generaba otro QR y el que ya habías
      // escaneado dejaba de servir).
      const previo = String((await db.leerAjusteAdmin(AJUSTE_TOTP_PENDIENTE)) || '').split('|');
      let secreto = previo[0];
      if (!secreto || !(Date.now() - Number(previo[1] || 0) < 15 * 60 * 1000)) {
              secreto = totp.generarSecreto();
              await db.guardarAjusteAdmin(AJUSTE_TOTP_PENDIENTE, secreto + '|' + Date.now());
      }
      res.json({ secreto, url: totp.urlOtpauth(secreto, 'super-admin'), horaServidor: Date.now() });
}));

// Confirma con el primer código que la app quedó bien configurada.
app.post('/api/admin/2fa/activar', ah(async (req, res) => {
      if (sesionAdminDe(req) !== 'configurar') return res.status(401).json({ error: 'Vuelve a entrar con tu clave.' });
      if (await db.leerAjusteAdmin(AJUSTE_TOTP)) return res.status(400).json({ error: 'La verificación en dos pasos ya está activada.' });
      const pendiente = String((await db.leerAjusteAdmin(AJUSTE_TOTP_PENDIENTE)) || '').split('|')[0];
      const contador = pendiente ? totp.verificar(pendiente, (req.body || {}).codigo, null) : null;
      if (contador === null) {
              // Diagnóstico (sin secretos): ¿había QR pendiente? ¿el código
              // habría coincidido con otra hora? (desfase en ventanas de 30 s)
              let desfase = null;
              if (pendiente) {
                      const ahora = Math.floor(Date.now() / 30000);
                      for (let d = -40; d <= 40 && desfase === null; d++) {
                              if (totp.codigoEn(pendiente, ahora + d) === String((req.body || {}).codigo || '').replace(/\s/g, '')) desfase = d;
                      }
              }
              console.warn('[2FA] activación fallida', JSON.stringify({ hayPendiente: !!pendiente, desfaseVentanas: desfase, horaServidor: new Date().toISOString() }));
              registrarFalloAdmin(req, 'Código incorrecto al activar la verificación en dos pasos');
              return res.status(400).json({ error: 'Ese código no coincide. Revisa que escaneaste el QR y usa el código que aparece ahora.' });
      }
      await db.guardarAjusteAdmin(AJUSTE_TOTP, pendiente);
      await db.borrarAjusteAdmin(AJUSTE_TOTP_PENDIENTE);
      ultimoContadorTotp = contador;
      avisarEntradaAdmin(req, 'Se ACTIVÓ la verificación en dos pasos y se inició sesión');
      res.json({ token: firmarSesionAdmin('completo') });
}));
app.get('/api/admin/empresas', requireAdmin, ah(async (req, res) => {
      const empresas = await db.listarEmpresas();
      res.json(empresas.map(sinDatosSensibles));
}));

app.patch('/api/admin/empresas/:id/activa', requireAdmin, ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const activa = !!(req.body && req.body.activa);
      let diasPrueba;
      if (activa && req.body.diasPrueba !== undefined) {
              const d = Number(req.body.diasPrueba);
              if (!Number.isInteger(d) || d < 0 || d > 365) return res.status(400).json({ error: 'Días de prueba inválidos' });
              diasPrueba = d;
      }
      const empresa = await db.setActivaEmpresa(req.params.id, activa, diasPrueba);
      if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json(sinDatosSensibles(empresa));
}));

// Denegar una solicitud de suscripción (o dar de baja definitiva un
// negocio): borra el registro por completo, junto con sus clientes.
app.delete('/api/admin/empresas/:id', requireAdmin, ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const borrado = await db.eliminarEmpresa(req.params.id);
      if (!borrado) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json({ ok: true });
}));

// Detalle de un negocio para el panel de super-admin: sus datos, sus
// clientes registrados (con puntos) y sus estadísticas de movimiento —
// todo junto, para verlo desde una sola pantalla sin tener que entrar
// con la cuenta del negocio.
app.get('/api/admin/empresas/:id/detalle', requireAdmin, ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const empresa = await db.obtenerEmpresa(req.params.id);
      if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
      const [clientes, estadisticas] = await Promise.all([
              db.clientesDeEmpresa(req.params.id),
              db.estadisticasDeEmpresa(req.params.id)
            ]);
      res.json({ empresa: sinDatosSensibles(empresa), clientes, estadisticas });
}));

// Gráficas del panel de super-admin: series de tiempo (negocios nuevos,
// clientes nuevos, visitas, canjes confirmados) por día/semana/mes/año, y
// el ranking de negocios con más clientes registrados.
const PERIODOS_VALIDOS = ['dia', 'semana', 'mes', 'anio'];
app.get('/api/admin/estadisticas', requireAdmin, ah(async (req, res) => {
      const periodo = PERIODOS_VALIDOS.includes(req.query.periodo) ? req.query.periodo : 'mes';
      const datos = await db.estadisticasTemporales(periodo);
      res.json(datos);
}));

app.get('/api/admin/top-negocios', requireAdmin, ah(async (req, res) => {
      const limite = req.query.limite ? Number(req.query.limite) : 10;
      const top = await db.topNegociosPorClientes(limite);
      res.json(top);
}));

// ---------- Panel: solo ve y toca lo de SU PROPIA empresa ----------
app.get('/api/mi-empresa', requireAuth, ah(async (req, res) => {
      const empresa = await db.obtenerEmpresa(req.empresaId);
      // La cuenta pudo haberse borrado mientras el negocio seguía con la
      // sesión abierta (antes esto tronaba con un error 500).
      if (!empresa) return res.status(401).json({ error: 'Sesión inválida o vencida' });
      res.json(sinDatosSensibles(empresa));
}));

// ---------- Suscripción: cobro automático con Stripe ----------
// Manda al negocio a pagar (primera vez) o a reactivar su suscripción
// (si Stripe la había desactivado por falta de pago).
app.post('/api/pagos/checkout', requireAuth, ah(async (req, res) => {
      if (!stripePagos.listo()) {
              return res.status(500).json({ error: 'Los pagos con tarjeta todavía no están configurados. Contacta a ARGAYES.' });
      }
      const empresa = await db.obtenerEmpresa(req.empresaId);
      if (!empresa) return res.status(401).json({ error: 'Sesión inválida o vencida' });
      // Si ya está pagando, no se abre otro cobro: un segundo "checkout"
      // crearía una SEGUNDA suscripción y le cobraría doble cada mes.
      if (empresa.suscripcionEstado === 'active' || empresa.suscripcionEstado === 'trialing') {
              return res.status(400).json({ error: 'Tu suscripción ya está activa. Usa "Administrar mi suscripción" para cambiar tu tarjeta o ver tus recibos.' });
      }
      try {
              const url = await stripePagos.crearSesionCheckout(empresa, PANEL_URL);
              res.json({ url });
      } catch (e) {
              console.error('No se pudo crear la sesión de pago de', req.empresaId, ':', e.message);
              res.status(500).json({ error: 'No se pudo abrir la página de pago. Intenta de nuevo en un momento.' });
      }
}));

// Portal de Stripe: cambiar tarjeta, ver recibos o cancelar — solo si ya
// tiene una suscripción (si nunca ha pagado, no hay nada que mostrar ahí).
app.post('/api/pagos/portal', requireAuth, ah(async (req, res) => {
      const empresa = await db.obtenerEmpresa(req.empresaId);
      if (!empresa) return res.status(401).json({ error: 'Sesión inválida o vencida' });
      try {
              const url = await stripePagos.crearSesionPortal(empresa, PANEL_URL);
              res.json({ url });
      } catch (e) {
              res.status(400).json({ error: e.message });
      }
}));

app.patch('/api/mi-empresa', requireAuth, ah(async (req, res) => {
      const { nombre, color, colorBoton, fuente, selloForma, selloTamano, recompensa, umbral, logoUrl, slug } = req.body || {};
      try {
              const empresa = await db.actualizarEmpresa(req.empresaId, { nombre, color, colorBoton, fuente, selloForma, selloTamano, recompensa, umbral, logoUrl, slug });
              // db.actualizarEmpresa ya marcó a todos los clientes de este
              // negocio como "cambiados" si lo que se editó se ve en la
              // tarjeta — aquí solo se les avisa a sus iPhones que la vuelvan
              // a pedir. Mejor esfuerzo: no bloquea la respuesta del panel.
              db.pushTokensDeEmpresa(req.empresaId)
                      .then((tokens) => appleWallet.avisarActualizacion(tokens))
                      .catch((e) => console.error('No se pudo avisar la actualización de Apple Wallet del negocio', req.empresaId, ':', e.message));
              // Lo mismo pero para Google Wallet: un solo PATCH a la clase
              // (no por cliente) alcanza para que a TODOS los que ya tengan
              // el pase guardado les llegue el color/logo/recompensa nuevos.
              googleWallet.patchClase(empresa)
                      .then(() => db.clientesConGoogleWallet(req.empresaId))
                      .then((clientes) => googleWallet.patchObjetos(empresa, clientes))
                      .catch((e) => console.error('No se pudo avisar la actualización de Google Wallet del negocio', req.empresaId, ':', e.message));
              res.json(sinDatosSensibles(empresa));
      } catch (e) {
              if (e.datosInvalidos) return res.status(400).json({ error: e.message });
              throw e;
      }
}));

app.get('/api/mis-clientes', requireAuth, ah(async (req, res) => {
      res.json(await db.clientesDeEmpresa(req.empresaId));
}));

app.get('/api/mis-estadisticas', requireAuth, ah(async (req, res) => {
      res.json(await db.estadisticasDeEmpresa(req.empresaId));
}));

// Lo accionable del panel: quién ya puede cobrar su recompensa, a quién le
// falta poco, mejores clientes, días y horas fuertes, clientes que dejaron
// de venir (ver db.insightsDeEmpresa).
app.get('/api/mis-insights', requireAuth, ah(async (req, res) => {
      res.json(await db.insightsDeEmpresa(req.empresaId));
}));

app.get('/api/mis-estadisticas-avanzadas', requireAuth, ah(async (req, res) => {
      res.json(await db.estadisticasAvanzadasDeEmpresa(req.empresaId, req.query.dias));
}));

app.get('/api/mis-visitas-semana', requireAuth, ah(async (req, res) => {
      res.json(await db.visitasPorSemanaDeEmpresa(req.empresaId, req.query.historico === 'true'));
}));

// Borrar un cliente propio — "requireAuth" ya limita a la empresa que hizo
// la petición, y "eliminarCliente" vuelve a filtrar por empresaId adentro
// (defensa doble: ni confiando solo en el token se puede borrar el cliente
// de otro negocio).
app.delete('/api/mis-clientes/:id', requireAuth, ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const borrado = await db.eliminarCliente(req.empresaId, req.params.id);
      if (!borrado) return res.status(404).json({ error: 'Cliente no encontrado' });
      res.json({ ok: true });
}));

// Recordatorio manual a clientes inactivos: lo dispara el negocio desde el
// panel (botón, no automático). Solo llega a quienes dejaron un correo (no
// hay SMS todavía) y no han vuelto en "dias" días. Sigue mandando aunque
// alguno falle (buzón inválido, etc.) — al final reporta cuántos sí y
// cuáles no, en vez de tronar toda la operación por un correo malo.
const MAX_RECORDATORIOS_POR_ENVIO = 60;
const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.post('/api/mis-recordatorios', requireAuth, requireEmpresaActiva, limitadorRecordatorios, ah(async (req, res) => {
      const dias = Number(req.body && req.body.dias) || 14;
      const empresa = req.empresa;
      // "inactivos" ya excluye a quien recibió un recordatorio en los últimos
      // 7 días y a quien se registró hace menos de "dias" días.
      const inactivos = await db.clientesInactivos(req.empresaId, dias);
      // Tope por envío: la petición no puede quedarse abierta minutos, y el
      // servicio de correo limita cuántos mensajes acepta por segundo.
      const lote = inactivos.slice(0, MAX_RECORDATORIOS_POR_ENVIO);
      let enviados = 0;
      const fallidos = [];
      for (const cliente of lote) {
              try {
                      await enviarRecordatorioInactividad(cliente.contacto, cliente.nombre, empresa.nombre, empresa.recompensa);
                      await db.marcarRecordatorioEnviado(cliente.id);
                      enviados++;
              } catch (e) {
                      console.error('No se pudo enviar el recordatorio a un cliente de', req.empresaId, ':', e.message);
                      fallidos.push({ cliente: cliente.nombre });
              }
              await pausa(350);
      }
      res.json({ totalInactivos: inactivos.length, enviados, fallidos, pendientes: inactivos.length - lote.length });
}));

// Datos públicos de un negocio (los usa la página de registro y la tarjeta
// del cliente). Solo lo necesario para pintar la tarjeta: ver empresaPublica.
app.get('/api/empresas/:id', ah(async (req, res) => {
      if (typeof req.params.id !== 'string' || req.params.id.length > 60) {
              return res.status(404).json({ error: 'Empresa no encontrada' });
      }
      // Acepta el id real (UUID, los links viejos) o el slug con marca
      // propia (los links nuevos) — así los dos tipos de link siguen
      // funcionando sin que el que llama tenga que saber cuál es.
      const empresa = await db.obtenerEmpresaPorIdOSlug(req.params.id);
      if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json(empresaPublica(empresa));
}));

// ---------- Paso 6-B: alta de cliente (pública: la usa el cliente final
// desde el link/QR que le da el negocio, sin necesitar cuenta ni login) ----------
app.post('/api/clientes', limitadorClientes, ah(async (req, res) => {
      const { empresaId, nombre, contacto, consentimiento } = req.body || {};
      if (!empresaId || !nombre) return res.status(400).json({ error: 'Falta empresaId o nombre' });
      if (!esUuidValido(empresaId)) return res.status(400).json({ error: 'empresaId inválido' });
      if (!db.textoValido(nombre, 80)) {
              return res.status(400).json({ error: 'Escribe tu nombre (máximo 80 caracteres)' });
      }
      if (typeof contacto !== 'string' || contacto.length > 120 || !db.normalizarContacto(contacto)) {
              return res.status(400).json({ error: 'Escribe tu teléfono (10 dígitos) o tu correo: es lo que identifica tu tarjeta.' });
      }
      // El checkbox de privacidad es obligatorio: sin la aceptación explícita
      // del cliente no se guarda su nombre y contacto. No aplica a clientes
      // que ya existían antes de este checkbox (esos ya están creados).
      if (!consentimiento) return res.status(400).json({ error: 'Falta aceptar el aviso de privacidad' });
      if (!(await db.obtenerEmpresa(empresaId))) return res.status(404).json({ error: 'Empresa no encontrada' });
      const cliente = await db.crearCliente({ empresaId, nombre, contacto, consentimiento: true });
      res.status(cliente.yaExistia ? 200 : 201).json({ ...clientePublico(cliente), yaExistia: !!cliente.yaExistia });
}));

app.get('/api/clientes/:id', ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const cliente = await db.obtenerCliente(req.params.id);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      res.json(clientePublico(cliente));
}));

// ---------- Paso 5: generar el pase ----------
app.get('/api/wallet/google/:clienteId', ah(async (req, res) => {
      if (!esUuidValido(req.params.clienteId)) return res.status(400).json({ error: 'Id inválido' });
      const cliente = await db.obtenerCliente(req.params.clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      const empresa = await db.obtenerEmpresa(cliente.empresaId);
      try {
              const saveUrl = googleWallet.generarSaveUrl(empresa, cliente);
              if (process.env.GOOGLE_ISSUER_ID) {
                      db.marcarGoogleWallet(cliente.id, googleWallet.objetoId(process.env.GOOGLE_ISSUER_ID, cliente.id)).catch(() => {});
              }
              res.json({ saveUrl });
      } catch (e) {
              // El detalle (qué credencial falta, etc.) va a los logs; al
              // cliente final solo se le dice que no se pudo.
              console.error('No se pudo generar el pase de Google Wallet:', e.message);
              res.status(503).json({ error: 'Google Wallet no está disponible en este momento. Tu tarjeta ya quedó registrada: puedes usarla desde "Ver mi tarjeta".' });
      }
}));

// Imágenes públicas para Google Wallet (Google solo acepta URLs https, no
// base64). La "versión" en la URL es una huella del diseño: si el negocio
// cambia algo, la URL cambia; por eso se pueden guardar en caché un año.
app.get('/api/wallet/google-img/logo/:empresaId/:version.png', ah(async (req, res) => {
      if (!esUuidValido(req.params.empresaId)) return res.status(400).end();
      const empresa = await db.obtenerEmpresa(req.params.empresaId);
      if (!empresa) return res.status(404).end();
      const png = sellosPng.logoCuadrado({ logoUrl: empresa.logoUrl, color: empresa.color, selloForma: empresa.selloForma }, 660);
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=31536000, immutable').send(png);
}));
app.get('/api/wallet/google-img/sellos/:empresaId/:puntos/:version.png', ah(async (req, res) => {
      if (!esUuidValido(req.params.empresaId)) return res.status(400).end();
      const puntos = Number(req.params.puntos);
      if (!Number.isInteger(puntos) || puntos < 0 || puntos > 20) return res.status(400).end();
      const empresa = await db.obtenerEmpresa(req.params.empresaId);
      if (!empresa) return res.status(404).end();
      const png = sellosPng.franjaDeSellos(
              { color: empresa.color, selloForma: empresa.selloForma, selloTamano: empresa.selloTamano, umbral: empresa.umbral, puntos },
              null,
              { ancho: 1032, alto: 336, anchoSeguro: 0.86 }
      );
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=31536000, immutable').send(png);
}));

app.get('/api/wallet/apple/:clienteId.pkpass', ah(async (req, res) => {
      if (!esUuidValido(req.params.clienteId)) return res.status(400).json({ error: 'Id inválido' });
      const cliente = await db.obtenerCliente(req.params.clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      const empresa = await db.obtenerEmpresa(cliente.empresaId);
      try {
              const buffer = await appleWallet.generarPkpass(empresa, cliente);
              res.set('Content-Type', 'application/vnd.apple.pkpass');
              res.set('Content-Disposition', `attachment; filename=${cliente.id}.pkpass`);
              res.send(buffer);
      } catch (e) {
              console.error('No se pudo generar el pase de Apple Wallet:', e.message);
              res.status(503).json({ error: 'Apple Wallet no está disponible en este momento. Tu tarjeta ya quedó registrada: puedes usarla desde "Ver mi tarjeta".' });
      }
}));

// ---------- Servicio web de Apple Wallet (actualizaciones automáticas) ----------
// Estas 5 rutas las llama directo el iPhone del cliente (no el panel, no
// nuestro frontend) — su forma exacta (nombres, verbos, status codes) la
// define Apple, no nosotros: https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
// El iPhone las descubre solas porque el .pkpass lleva "webServiceURL"
// apuntando aquí (ver lib/apple-wallet.js).
//
// "authenticationToken" que Apple manda en cada petición (como
// "Authorization: ApplePass <token>") es el mismo id del cliente que se usó
// al crear el pase — no es nada nuevo que haya que generar ni guardar aparte.
function tokenDePasePeticion(req) {
      const header = req.get('Authorization') || '';
      const m = header.match(/^ApplePass (.+)$/);
      return m ? m[1] : null;
}

// 1) El iPhone avisa "este dispositivo quiere actualizaciones para este pase".
app.post('/api/apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serialNumber', ah(async (req, res) => {
      const { deviceLibraryId, passTypeId, serialNumber } = req.params;
      if (!esUuidValido(serialNumber)) return res.status(400).end();
      const token = tokenDePasePeticion(req);
      if (!token || token !== serialNumber) return res.status(401).end();
      const cliente = await db.obtenerCliente(serialNumber);
      if (!cliente) return res.status(404).end();
      const pushToken = req.body && req.body.pushToken;
      if (!pushToken) return res.status(400).end();
      const yaEstaba = await db.yaRegistradoDispositivoPase(deviceLibraryId, passTypeId, serialNumber);
      await db.registrarDispositivoPase(deviceLibraryId, passTypeId, serialNumber, pushToken);
      res.status(yaEstaba ? 200 : 201).end();
}));

// 2) El iPhone avisa "ya no quiero más actualizaciones" (quitó el pase, o lo
//    sobrescribió con otro). Debe responder 200 aunque ya no existiera.
app.delete('/api/apple/v1/devices/:deviceLibraryId/registrations/:passTypeId/:serialNumber', ah(async (req, res) => {
      const { deviceLibraryId, passTypeId, serialNumber } = req.params;
      const token = tokenDePasePeticion(req);
      if (!token || token !== serialNumber) return res.status(401).end();
      await db.borrarDispositivoPase(deviceLibraryId, passTypeId, serialNumber);
      res.status(200).end();
}));

// 3) El iPhone pregunta "¿cuáles de mis pases de este tipo cambiaron desde
//    tal fecha?" — esto es lo que Apple llama cuando llega el push silencioso.
//    No lleva Authorization (es a nivel dispositivo, no a nivel de un pase).
app.get('/api/apple/v1/devices/:deviceLibraryId/registrations/:passTypeId', ah(async (req, res) => {
      const { deviceLibraryId, passTypeId } = req.params;
      // "passesUpdatedSince" es la fecha que nosotros mismos le dimos antes
      // al iPhone; si llega algo que no es una fecha, se ignora (pide todo)
      // en vez de mandarle un texto inválido a la base de datos.
      const desdeCrudo = req.query.passesUpdatedSince;
      const desde = (typeof desdeCrudo === 'string' && !Number.isNaN(Date.parse(desdeCrudo))) ? desdeCrudo : null;
      const filas = await db.seriesActualizadasParaDispositivo(deviceLibraryId, passTypeId, desde);
      if (filas.length === 0) return res.status(204).end();
      const ultima = filas[filas.length - 1].actualizado_en.toISOString();
      res.json({ lastUpdated: ultima, serialNumbers: filas.map((f) => f.id) });
}));

// 4) El iPhone pide el pase actualizado de verdad — aquí se regenera con los
//    datos actuales del cliente y su negocio (igual que la descarga inicial).
app.get('/api/apple/v1/passes/:passTypeId/:serialNumber', ah(async (req, res) => {
      const { serialNumber } = req.params;
      if (!esUuidValido(serialNumber)) return res.status(400).end();
      const token = tokenDePasePeticion(req);
      if (!token || token !== serialNumber) return res.status(401).end();
      const cliente = await db.obtenerCliente(serialNumber);
      if (!cliente) return res.status(404).end();
      const empresa = await db.obtenerEmpresa(cliente.empresaId);
      try {
              const buffer = await appleWallet.generarPkpass(empresa, cliente);
              res.set('Content-Type', 'application/vnd.apple.pkpass');
              res.set('Last-Modified', new Date().toUTCString());
              res.send(buffer);
      } catch (e) {
              console.error('No se pudo regenerar el pase de Apple Wallet:', e.message);
              res.status(500).end();
      }
}));

// 5) Apple manda aquí cualquier error que le pase al iPhone con nuestro
//    servicio web — no hace falta hacer nada con esto, solo no tronar.
app.post('/api/apple/v1/log', (req, res) => {
      console.log('[Apple Wallet log]', JSON.stringify(req.body || {}).slice(0, 2000));
      res.status(200).end();
});

// ---------- Paso 7: escaneo en tienda, suma de puntos ----------
// Requiere sesión de la empresa (el empleado entra con la cuenta del
// negocio y escanea desde ahí) — así un cliente no puede llamar esto él
// mismo desde su celular para auto-otorgarse visitas.
app.post('/api/visita', requireAuth, requireEmpresaActiva, ah(async (req, res) => {
      const { clienteId } = req.body || {};
      if (!esUuidValido(clienteId)) return res.status(400).json({ error: 'clienteId inválido' });
      const cliente = await db.obtenerCliente(clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (cliente.empresaId !== req.empresaId) {
              return res.status(403).json({ error: 'Ese cliente no pertenece a tu negocio' });
      }

      // Si ya tiene sello de hoy, se regresa también cómo va: si ya completó
      // su tarjeta, el escáner ofrece entregarle la recompensa.
      const respuestaYaVisito = (mensaje) => res.status(409).json({
              error: mensaje,
              cliente: clientePublico(cliente),
              umbral: req.empresa.umbral,
              listoParaCanje: cliente.puntos >= req.empresa.umbral
      });
      if (await db.yaVisitoHoy(clienteId)) {
              return respuestaYaVisito('Ya se registró una visita hoy para este cliente');
      }

                                                                let actualizado;
                                                                try {
                                                                        actualizado = await db.registrarVisita(clienteId);
                                                                } catch (e) {
                                                                        // Ver comentario en db.registrarVisita: esto solo puede pasar si otra
                                                                        // petición para el mismo cliente ganó la carrera justo entre el
                                                                        // "yaVisitoHoy" de arriba y este registro.
                                                                        if (e.yaVisito) return respuestaYaVisito(e.message);
                                                                        throw e;
                                                                }
      const empresa = req.empresa;

                                                                // Mejor esfuerzo: si hay credenciales de Google, empuja el saldo nuevo al
                                                                // pase que el cliente ya tiene guardado (Paso 8). Si falla, la visita ya
                                                                // quedó registrada en la base de datos de todas formas — pero sí se
                                                                // registra en los logs de Render, para poder notar si Google Wallet deja
                                                                // de actualizar pases sin que nadie se dé cuenta.
                                                                googleWallet.patchPuntos(empresa, actualizado).catch((e) => {
                                                                        console.error('No se pudo actualizar el pase de Google Wallet del cliente', clienteId, ':', e.message);
                                                                });
                                                                // Mismo "mejor esfuerzo" para Apple Wallet: si el cliente ya tiene el
                                                                // pase guardado con notificaciones automáticas, se le avisa a Apple
                                                                // que vuelva a pedirlo (ver lib/apple-wallet.js y /api/apple/v1/...).
                                                                db.pushTokensDeCliente(clienteId)
                                                                        .then((tokens) => appleWallet.avisarActualizacion(tokens))
                                                                        .catch((e) => console.error('No se pudo avisar la actualización de Apple Wallet del cliente', clienteId, ':', e.message));

      const listoParaCanje = actualizado.puntos >= empresa.umbral;
      res.json({ cliente: clientePublico(actualizado), umbral: empresa.umbral, listoParaCanje });
}));

// ---------- Paso 9: recompensa y canje de un solo uso ----------
// También requiere sesión de la empresa, por la misma razón que /api/visita:
// el canje lo debe generar y confirmar el negocio, no el cliente desde su casa.
app.post('/api/canje', requireAuth, requireEmpresaActiva, ah(async (req, res) => {
      const { clienteId } = req.body || {};
      if (!esUuidValido(clienteId)) return res.status(400).json({ error: 'clienteId inválido' });
      const cliente = await db.obtenerCliente(clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (cliente.empresaId !== req.empresaId) {
              return res.status(403).json({ error: 'Ese cliente no pertenece a tu negocio' });
      }
      const empresa = req.empresa;
      if (cliente.puntos < empresa.umbral) {
              return res.status(400).json({ error: `Todavía no completa su tarjeta: lleva ${cliente.puntos} de ${empresa.umbral} sellos.` });
      }
      const canje = await db.crearCanje(clienteId);
      res.status(201).json(canje);
}));

app.post('/api/canje/confirmar', requireAuth, requireEmpresaActiva, ah(async (req, res) => {
      const { codigo } = req.body || {};
      if (!esUuidValido(codigo)) return res.status(400).json({ error: 'codigo inválido' });
      const resultado = await db.confirmarCanje(codigo, req.empresaId);
      if (!resultado.ok) {
              const status = resultado.razon === 'no_pertenece' ? 403 : 409;
              return res.status(status).json({ error: resultado.razon });
      }
      db.pushTokensDeCliente(resultado.cliente.id)
              .then((tokens) => appleWallet.avisarActualizacion(tokens))
              .catch((e) => console.error('No se pudo avisar la actualización de Apple Wallet tras el canje:', e.message));
      // Antes el pase de Google Wallet se quedaba con los puntos de ANTES
      // del canje (solo se actualizaba al sumar una visita).
      googleWallet.patchPuntos(req.empresa, resultado.cliente).catch((e) => {
              console.error('No se pudo actualizar el pase de Google Wallet tras el canje:', e.message);
      });
      res.json({ ok: true, cliente: clientePublico(resultado.cliente) });
}));

// ---------- Manejador de errores: red de seguridad para TODO lo anterior ----------
// Si cualquier ruta (envuelta en "ah") truena por lo que sea — un id raro,
// un hipo de la base de datos, lo que sea — termina aquí en vez de tirar el
// servidor completo. Debe ir DESPUÉS de todas las rutas.
// Cualquier dirección que no exista responde JSON (no la página HTML de
// error de Express), igual que el resto de la API.
app.use((req, res) => {
      res.status(404).json({ error: 'No encontrado' });
});

app.use((err, req, res, next) => {
      if (res.headersSent) return next(err);
      // Errores de quien llama, no nuestros: JSON mal formado o un cuerpo
      // más grande que el límite. Antes salían como "Error interno del
      // servidor" (500) y ensuciaban los logs como si algo se hubiera roto.
      if (err && err.type === 'entity.too.large') {
              return res.status(413).json({ error: 'El archivo o los datos enviados son demasiado grandes' });
      }
      if (err && err.type === 'entity.parse.failed') {
              return res.status(400).json({ error: 'Los datos enviados no tienen un formato válido' });
      }
      if (err && err.datosInvalidos) {
              return res.status(400).json({ error: err.message });
      }
      console.error('Error no manejado en una ruta:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
});

// Red de seguridad final: si por alguna razón algo truena FUERA de una ruta
// envuelta en "ah" (no debería pasar, pero mejor prevenir), se registra el
// error y el proceso sigue vivo en vez de tumbarse para todos los negocios.
process.on('unhandledRejection', (err) => {
      console.error('unhandledRejection (el servidor sigue corriendo):', err);
});
process.on('uncaughtException', (err) => {
      console.error('uncaughtException (el servidor sigue corriendo):', err);
});

const PORT = process.env.PORT || 3000;

db.init()
  .then(async () => {
          // Recuperación si pierdes el teléfono: pon ADMIN_2FA_RESET=si en
          // Render, deja que reinicie, entra y vuelve a escanear el QR, y
          // luego BORRA esa variable (si se queda, cada reinicio la vuelve
          // a desactivar).
          if (process.env.ADMIN_2FA_RESET === 'si') {
                  await db.borrarAjusteAdmin('totp_secreto');
                  console.warn('ADMIN_2FA_RESET=si: se desactivó la verificación en dos pasos del super-admin. Quita esa variable en cuanto la vuelvas a activar.');
          }
          app.listen(PORT, () => {
                    console.log(`ARGAYES backend corriendo en http://localhost:${PORT}`);
          });
  })
  .catch((e) => {
          console.error('No se pudo inicializar la base de datos:', e.message);
          process.exit(1);
  });
