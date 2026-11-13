require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./lib/db');
const googleWallet = require('./lib/google-wallet');
const appleWallet = require('./lib/apple-wallet');
const { enviarCodigoReset } = require('./lib/email');

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
app.use(cors());
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
      windowMs: 15 * 60 * 1000,
      limit: 40,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' }
});

// IMPORTANTE: con Postgres, cada ruta ahora es "async" y puede rechazar su
// promesa (por ejemplo si alguien manda un id que no es un UUID válido, o si
// la base de datos tiene un hipo momentáneo). Express 4 NO atrapa esos
// errores solo: si una ruta async truena sin este envoltorio, Node.js la
// trata como un error no manejado y TUMBA TODO EL SERVIDOR para TODOS los
// negocios, no solo para quien hizo la petición mala. "ah" envuelve cada
// ruta para que cualquier error termine como una respuesta 500 normal
// (ver el manejador de errores hasta abajo del archivo) en vez de tirar
// el proceso completo.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sinDatosSensibles(empresa) {
      const { passwordHash, ...resto } = empresa;
      return resto;
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
              return res.status(403).json({ error: 'Tu suscripción no está activa. Contacta a ARGAYES para reactivarla.' });
      }
      req.empresa = empresa;
      next();
});

// Protege las rutas de super-admin (solo tú, dueño de ARGAYES) con una
// clave fija por header — no hace falta login de usuario para esto.
function requireAdmin(req, res, next) {
      const clave = req.headers['x-admin-secret'];
      if (!clave || clave !== ADMIN_SECRET) {
              return res.status(401).json({ error: 'Clave de administrador incorrecta' });
      }
      next();
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

// ---------- Cuenta del negocio: alta y login (Paso 6-A) ----------
app.post('/api/auth/registro', limitadorRegistro, ah(async (req, res) => {
      const { nombre, email, password, recompensa, umbral, color } = req.body;
      if (!nombre || !email || !password) {
              return res.status(400).json({ error: 'Falta nombre, email o password' });
      }
      try {
              // La cuenta se crea SIN aprobar y SIN activar (ver db.crearEmpresa):
              // cualquiera con el link del panel puede llegar hasta aquí, así que
              // no se le da acceso automático. Por eso ya no se regresa un token
              // de sesión — tiene que esperar a que ARGAYES la apruebe desde el
              // panel de super-admin antes de poder iniciar sesión.
              await db.crearEmpresa({ nombre, email, password, recompensa, umbral, color });
              res.status(201).json({
                      pendiente: true,
                      mensaje: 'Solicitud de suscripción enviada. Nuestro equipo la revisará y activaremos tu cuenta en breve.'
              });
      } catch (e) {
              res.status(409).json({ error: e.message });
      }
}));

app.post('/api/auth/login', limitadorLogin, ah(async (req, res) => {
      const { email, password } = req.body;
      const empresa = await db.validarLogin(email, password);
      if (!empresa) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      if (empresa.activa === false) {
              const mensaje = empresa.aprobada === false
                      ? 'Tu solicitud de suscripción sigue en revisión. Te avisaremos en cuanto sea aprobada.'
                      : 'Tu suscripción no está activa. Contacta a ARGAYES para reactivarla.';
              return res.status(403).json({ error: mensaje });
      }
      const token = jwt.sign({ empresaId: empresa.id }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ token, empresa: sinDatosSensibles(empresa) });
}));

// ---------- Olvidé mi contraseña (solo negocios) ----------
app.post('/api/auth/olvide-password', limitadorReset, ah(async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Falta el email' });
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
      const { email, codigo, nuevaPassword } = req.body;
      if (!email || !codigo || !nuevaPassword) {
              return res.status(400).json({ error: 'Falta email, código o nueva contraseña' });
      }
      if (String(nuevaPassword).length < 6) {
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
app.get('/api/admin/empresas', requireAdmin, ah(async (req, res) => {
      const empresas = await db.listarEmpresas();
      res.json(empresas.map(sinDatosSensibles));
}));

app.patch('/api/admin/empresas/:id/activa', requireAdmin, ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const empresa = await db.setActivaEmpresa(req.params.id, !!req.body.activa);
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
      res.json(sinDatosSensibles(empresa));
}));

app.patch('/api/mi-empresa', requireAuth, ah(async (req, res) => {
      const { nombre, color, colorBoton, fuente, selloForma, selloTamano, recompensa, umbral, logoUrl } = req.body;
      try {
              const empresa = await db.actualizarEmpresa(req.empresaId, { nombre, color, colorBoton, fuente, selloForma, selloTamano, recompensa, umbral, logoUrl });
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

// Alta directa de empresa sin password (uso interno/pruebas con curl).
app.get('/api/empresas/:id', ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const empresa = await db.obtenerEmpresa(req.params.id);
      if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json(sinDatosSensibles(empresa));
}));

// ---------- Paso 6-B: alta de cliente (pública: la usa el cliente final
// desde el link/QR que le da el negocio, sin necesitar cuenta ni login) ----------
app.post('/api/clientes', limitadorClientes, ah(async (req, res) => {
      const { empresaId, nombre, contacto } = req.body;
      if (!empresaId || !nombre) return res.status(400).json({ error: 'Falta empresaId o nombre' });
      if (!esUuidValido(empresaId)) return res.status(400).json({ error: 'empresaId inválido' });
      if (!(await db.obtenerEmpresa(empresaId))) return res.status(404).json({ error: 'Empresa no encontrada' });
      const cliente = await db.crearCliente({ empresaId, nombre, contacto });
      res.status(201).json(cliente);
}));

app.get('/api/clientes/:id', ah(async (req, res) => {
      if (!esUuidValido(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const cliente = await db.obtenerCliente(req.params.id);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      res.json(cliente);
}));

// ---------- Paso 5: generar el pase ----------
app.get('/api/wallet/google/:clienteId', ah(async (req, res) => {
      if (!esUuidValido(req.params.clienteId)) return res.status(400).json({ error: 'Id inválido' });
      const cliente = await db.obtenerCliente(req.params.clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      const empresa = await db.obtenerEmpresa(cliente.empresaId);
      try {
              const saveUrl = googleWallet.generarSaveUrl(empresa, cliente);
              res.json({ saveUrl });
      } catch (e) {
              res.status(500).json({ error: e.message });
      }
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
              res.status(500).json({ error: e.message });
      }
}));

// ---------- Paso 7: escaneo en tienda, suma de puntos ----------
// Requiere sesión de la empresa (el empleado entra con la cuenta del
// negocio y escanea desde ahí) — así un cliente no puede llamar esto él
// mismo desde su celular para auto-otorgarse visitas.
app.post('/api/visita', requireAuth, requireEmpresaActiva, ah(async (req, res) => {
      const { clienteId } = req.body;
      if (!esUuidValido(clienteId)) return res.status(400).json({ error: 'clienteId inválido' });
      const cliente = await db.obtenerCliente(clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (cliente.empresaId !== req.empresaId) {
              return res.status(403).json({ error: 'Ese cliente no pertenece a tu negocio' });
      }

                                                                if (await db.yaVisitoHoy(clienteId)) {
                                                                        return res.status(409).json({ error: 'Ya se registró una visita hoy para este cliente' });
                                                                }

                                                                let actualizado;
                                                                try {
                                                                        actualizado = await db.registrarVisita(clienteId);
                                                                } catch (e) {
                                                                        // Ver comentario en db.registrarVisita: esto solo puede pasar si otra
                                                                        // petición para el mismo cliente ganó la carrera justo entre el
                                                                        // "yaVisitoHoy" de arriba y este registro.
                                                                        if (e.yaVisito) return res.status(409).json({ error: e.message });
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

                                                                const listoParaCanje = actualizado.puntos >= empresa.umbral;
      res.json({ cliente: actualizado, listoParaCanje });
}));

// ---------- Paso 9: recompensa y canje de un solo uso ----------
// También requiere sesión de la empresa, por la misma razón que /api/visita:
// el canje lo debe generar y confirmar el negocio, no el cliente desde su casa.
app.post('/api/canje', requireAuth, requireEmpresaActiva, ah(async (req, res) => {
      const { clienteId } = req.body;
      if (!esUuidValido(clienteId)) return res.status(400).json({ error: 'clienteId inválido' });
      const cliente = await db.obtenerCliente(clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      if (cliente.empresaId !== req.empresaId) {
              return res.status(403).json({ error: 'Ese cliente no pertenece a tu negocio' });
      }
      const empresa = req.empresa;
      if (cliente.puntos < empresa.umbral) {
              return res.status(400).json({ error: 'El cliente todavía no llega al umbral de puntos' });
      }
      const canje = await db.crearCanje(clienteId);
      res.status(201).json(canje);
}));

app.post('/api/canje/confirmar', requireAuth, requireEmpresaActiva, ah(async (req, res) => {
      const { codigo } = req.body;
      if (!esUuidValido(codigo)) return res.status(400).json({ error: 'codigo inválido' });
      const resultado = await db.confirmarCanje(codigo, req.empresaId);
      if (!resultado.ok) {
              const status = resultado.razon === 'no_pertenece' ? 403 : 409;
              return res.status(status).json({ error: resultado.razon });
      }
      res.json(resultado);
}));

// ---------- Manejador de errores: red de seguridad para TODO lo anterior ----------
// Si cualquier ruta (envuelta en "ah") truena por lo que sea — un id raro,
// un hipo de la base de datos, lo que sea — termina aquí en vez de tirar el
// servidor completo. Debe ir DESPUÉS de todas las rutas.
app.use((err, req, res, next) => {
      console.error('Error no manejado en una ruta:', err);
      if (res.headersSent) return next(err);
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
  .then(() => {
          app.listen(PORT, () => {
                    console.log(`ARGAYES backend corriendo en http://localhost:${PORT}`);
          });
  })
  .catch((e) => {
          console.error('No se pudo inicializar la base de datos:', e.message);
          process.exit(1);
  });
