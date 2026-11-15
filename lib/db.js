// Base de datos en Postgres (antes era un archivo JSON que Render borraba en
// cada redeploy — ver README). Todas las lecturas/escrituras del backend
// pasan por aquí, igual que antes; lo único que cambió es que ahora viven
// en una base de datos real que no se pierde.
const { Pool } = require('pg');
const crypto = require('crypto');

// Zona horaria del NEGOCIO, no la del servidor. Postgres en Render corre en
// UTC, así que "hoy" (CURRENT_DATE) cambiaba a las 7pm de Cancún / 6pm de
// CDMX: un cliente que venía a las 8pm y volvía al otro día a las 10am
// recibía "ya se registró una visita hoy" (los dos escaneos caían en el
// mismo día UTC), y uno que venía a las 5pm y otra vez a las 8pm se llevaba
// dos sellos el mismo día. Todo lo que dependa de "qué día es hoy" usa HOY
// (abajo) en vez de CURRENT_DATE. Se puede cambiar con la variable de
// entorno ZONA_HORARIA (ej. America/Mexico_City); el patrón de abajo evita
// que un valor raro termine metido en una consulta.
const ZONA_HORARIA = /^[A-Za-z]+(\/[A-Za-z_]+){1,2}$/.test(process.env.ZONA_HORARIA || '')
      ? process.env.ZONA_HORARIA
      : 'America/Cancun';
const HOY = `(now() AT TIME ZONE '${ZONA_HORARIA}')::date`;

const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // PGSSL=off solo para correr contra un Postgres local sin SSL (pruebas).
      ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }
});
// "Ahora" como fecha-hora local del negocio (sin zona), para que las semanas
// y meses de las gráficas (date_trunc) empiecen a la medianoche local.
const AHORA_LOCAL = `(now() AT TIME ZONE '${ZONA_HORARIA}')`;
// Sin este manejador, un corte de red en una conexión que está en reposo
// (pasa de vez en cuando con cualquier Postgres en la nube) se convierte en
// un error no manejado del proceso.
pool.on('error', (e) => {
      console.error('Error en una conexión inactiva de Postgres (se repone sola):', e.message);
});

// Corre "fn" dentro de una transacción: o se aplican TODOS sus cambios o
// ninguno. Se usa donde dos escrituras tienen que ir juntas sí o sí (sumar
// la visita Y el punto; marcar el canje Y restar los puntos).
async function conTransaccion(fn) {
      const client = await pool.connect();
      try {
              await client.query('BEGIN');
              const resultado = await fn(client);
              await client.query('COMMIT');
              return resultado;
      } catch (e) {
              try { await client.query('ROLLBACK'); } catch (e2) { /* la conexión ya murió */ }
              throw e;
      } finally {
              client.release();
      }
}

// Crea las tablas si no existen todavía (se llama una vez al arrancar el
// servidor, ver server.js). No borra ni toca nada si ya existen.
async function init() {
      await pool.query(`
          CREATE TABLE IF NOT EXISTS empresas (
                id uuid PRIMARY KEY,
                      nombre text NOT NULL,
                            email text UNIQUE,
                                  password_hash text,
                                        logo_url text,
                                              color text DEFAULT '#b8872b',
                                                    recompensa text DEFAULT '',
                                                          umbral integer DEFAULT 10,
                                                                activa boolean DEFAULT true,
                                                                      creado timestamptz DEFAULT now()
                                                                          );

          -- "aprobada" distingue una cuenta nueva (se registró sola desde el
          -- link público y ARGAYES todavía no la revisa) de una que tú ya
          -- aprobaste alguna vez y luego desactivaste manualmente (por
          -- ejemplo por falta de pago). DEFAULT true para que las empresas
          -- que YA existían antes de este cambio no se vuelvan "pendientes"
          -- de la nada; las nuevas se insertan con aprobada = false.
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS aprobada boolean NOT NULL DEFAULT true;

          -- Personalización de la tarjeta de fidelidad (editor nuevo del panel):
          -- color de los botones (separado del color de fondo de la tarjeta,
          -- que ya vivía en "color"), tipografía del nombre/marca, y forma y
          -- tamaño de los sellos. Todas con DEFAULT para que las empresas que
          -- ya existían se vean igual que antes hasta que alguien las cambie.
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS color_boton text DEFAULT '#1b1f23';
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS fuente text DEFAULT 'IBM Plex Sans';
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS sello_forma text DEFAULT 'circulo';
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS sello_tamano text DEFAULT 'mediano';

          -- "slug": el pedacito de link con marca propia del negocio (ej.
          -- "pizzeria-juan" en vez del id feo), usado en el QR/link de
          -- autorregistro que el negocio pone en su local. Único (el índice
          -- ignora NULL a propósito, porque las empresas que ya existían
          -- antes de este cambio no tienen uno todavía hasta que corre el
          -- backfill de abajo).
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS slug text;
          CREATE UNIQUE INDEX IF NOT EXISTS empresas_slug_unico ON empresas (slug) WHERE slug IS NOT NULL;
          -- Backfill para negocios que ya existían: un slug sencillo basado
          -- en su id (único por construcción, así no hay forma de chocar
          -- con otro). El negocio puede cambiarlo por uno más bonito desde
          -- el panel en cuanto quiera.
          UPDATE empresas SET slug = 'negocio-' || substring(id::text, 1, 8) WHERE slug IS NULL;

          -- Cobro automático con Stripe (antes la suscripción se activaba a
          -- mano después de una transferencia bancaria). Guardamos el id del
          -- "customer" y de la "subscription" de Stripe para poder: 1) saber
          -- qué negocio corresponde a cada evento que llega por webhook, y
          -- 2) mandarlo al portal de Stripe para que actualice su tarjeta.
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS stripe_customer_id text;
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS suscripcion_estado text;
          CREATE UNIQUE INDEX IF NOT EXISTS empresas_stripe_customer_unico ON empresas (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

          -- Marca de tiempo (segundos unix) del evento de Stripe que escribió
          -- por última vez el estado de la suscripción. Stripe no garantiza
          -- que los webhooks lleguen en orden (puede reintentar uno viejo
          -- después de uno nuevo) — sin esto, un reintento tardío de un
          -- evento viejo puede pisar un estado más reciente con uno
          -- desactualizado (esto de hecho ya pasó una vez: ver
          -- sincronizarSuscripcion más abajo).
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS suscripcion_evento_ts bigint;

          -- Aceptación explícita de los Términos y el Aviso de Privacidad al
          -- crear la cuenta: cuándo la aceptó y cuál versión de los términos
          -- (para poder demostrar a qué se comprometió cada negocio si algún
          -- día hay una disputa). Las cuentas que ya existían antes de esto
          -- quedan en NULL — se registraron antes de que existiera el checkbox.
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS terminos_aceptados_en timestamptz;
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS terminos_version text;

          CREATE TABLE IF NOT EXISTS password_resets (
                id uuid PRIMARY KEY,
                      empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
                            codigo_hash text NOT NULL,
                                  expira timestamptz NOT NULL,
                                        usado boolean NOT NULL DEFAULT false,
                                              creado timestamptz DEFAULT now()
                                                  );
          CREATE INDEX IF NOT EXISTS password_resets_empresa_idx ON password_resets (empresa_id);

                                                                              CREATE TABLE IF NOT EXISTS clientes (
                                                                                    id uuid PRIMARY KEY,
                                                                                          empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
                                                                                                nombre text NOT NULL,
                                                                                                      contacto text DEFAULT '',
                                                                                                            puntos integer DEFAULT 0,
                                                                                                                  google_object_id text,
                                                                                                                        creado timestamptz DEFAULT now()
                                                                                                                            );
                                                                                                                            
                                                                                                                                -- Evita duplicados a nivel de base de datos (no solo en el código): dos
                                                                                                                                    -- clientes de la misma empresa no pueden tener el mismo contacto.
                                                                                                                                        CREATE UNIQUE INDEX IF NOT EXISTS clientes_empresa_contacto_unico
                                                                                                                                              ON clientes (empresa_id, lower(btrim(contacto)))
                                                                                                                                                    WHERE contacto <> '';
                                                                                                                                                    
                                                                                                                                                        CREATE TABLE IF NOT EXISTS visitas (
                                                                                                                                                              id uuid PRIMARY KEY,
                                                                                                                                                                    cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                                                                                                                                                                          fecha date NOT NULL,
                                                                                                                                                                                hora timestamptz DEFAULT now()
                                                                                                                                                                                    );
                                                                                                                                                                                    
                                                                                                                                                                                        CREATE TABLE IF NOT EXISTS canjes (
                                                                                                                                                                                              codigo uuid PRIMARY KEY,
                                                                                                                                                                                                    cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                                                                                                                                                                                                          usado boolean DEFAULT false,
                                                                                                                                                                                                                creado timestamptz DEFAULT now(),
                                                                                                                                                                                                                      usado_el timestamptz
                                                                                                                                                                                                                          );

          -- Postgres NO crea índice automático en una columna de llave
          -- foránea (solo la restricción) — sin esto, "clientesDeEmpresa" y
          -- las gráficas hacen un recorrido completo de la tabla cada vez,
          -- y eso se nota cuando ya hay miles de filas en vez de decenas.
          CREATE INDEX IF NOT EXISTS clientes_empresa_idx ON clientes (empresa_id);
          CREATE INDEX IF NOT EXISTS canjes_cliente_idx ON canjes (cliente_id);

          -- Por si alguna vez ya se coló una visita duplicada del mismo
          -- cliente el mismo día (antes de que existiera la restricción de
          -- abajo) — se queda con la más antigua de cada grupo y borra las
          -- demás, para que la restricción única se pueda crear sin tronar.
          -- Si no hay duplicados (lo normal), esto no borra nada.
          DELETE FROM visitas v WHERE v.id IN (
                SELECT id FROM (
                      SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY cliente_id, fecha ORDER BY hora ASC, id ASC
                          ) AS rn
                      FROM visitas
                    ) x WHERE x.rn > 1
              );

          -- Antifraude a nivel de base de datos, no solo en el código: evita
          -- que dos peticiones casi simultáneas (doble tap, dos empleados
          -- escaneando a la vez, un reintento de red) le sumen dos puntos al
          -- mismo cliente el mismo día. De paso sirve como índice para
          -- "yaVisitoHoy", que antes recorría la tabla completa.
          CREATE UNIQUE INDEX IF NOT EXISTS visitas_cliente_fecha_unico ON visitas (cliente_id, fecha);

          -- "consentimiento": el cliente aceptó el checkbox de privacidad al
          -- registrarse (requerido desde el formulario de registro.html).
          ALTER TABLE clientes ADD COLUMN IF NOT EXISTS consentimiento boolean NOT NULL DEFAULT false;

          -- "actualizado_en": se actualiza cada vez que cambian los puntos
          -- de este cliente o la tarjeta de su negocio (color, logo,
          -- recompensa, umbral...). Es la marca de tiempo que usa el
          -- servicio web de Apple Wallet para saber si el pase guardado en
          -- el celular del cliente ya quedó viejo y avisarle que lo
          -- actualice (ver /api/apple/v1/... en server.js).
          ALTER TABLE clientes ADD COLUMN IF NOT EXISTS actualizado_en timestamptz NOT NULL DEFAULT now();

          -- Un dispositivo (iPhone) se registra aquí la primera vez que el
          -- cliente agrega su pase a Apple Wallet con las notificaciones de
          -- actualización activadas. Guarda el token de empuje (push_token)
          -- que se necesita para avisarle a Apple "este pase cambió, que el
          -- celular lo vuelva a pedir" — sin esto, el pase se queda
          -- congelado con los datos de cuando se descargó.
          CREATE TABLE IF NOT EXISTS dispositivos_pase (
                device_library_id text NOT NULL,
                pass_type_id text NOT NULL,
                cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                push_token text NOT NULL,
                creado timestamptz DEFAULT now(),
                PRIMARY KEY (device_library_id, pass_type_id, cliente_id)
          );
          CREATE INDEX IF NOT EXISTS dispositivos_pase_cliente_idx ON dispositivos_pase (cliente_id);

          -- Corrige las visitas que se guardaron con la fecha de UTC en vez
          -- de la fecha local del negocio (ver ZONA_HORARIA arriba). Solo
          -- toca las que quedaron con el día equivocado y cuya fecha
          -- correcta no choca con otra visita del mismo cliente; una vez
          -- corregidas, esto ya no encuentra nada que cambiar.
          UPDATE visitas v SET fecha = (v.hora AT TIME ZONE '${ZONA_HORARIA}')::date
                WHERE v.fecha <> (v.hora AT TIME ZONE '${ZONA_HORARIA}')::date
                AND NOT EXISTS (
                      SELECT 1 FROM visitas o
                      WHERE o.cliente_id = v.cliente_id AND o.id <> v.id
                      AND o.fecha = (v.hora AT TIME ZONE '${ZONA_HORARIA}')::date
                );

          -- Un solo código de canje pendiente por cliente. Antes cada toque
          -- en "Generar código" creaba uno nuevo y todos seguían siendo
          -- válidos: con dos códigos de la misma recompensa se podían
          -- confirmar dos entregas con los puntos de una sola. Primero se
          -- borran los pendientes repetidos (se queda el más reciente) para
          -- que el índice único se pueda crear.
          DELETE FROM canjes k WHERE k.usado = false AND EXISTS (
                SELECT 1 FROM canjes o
                WHERE o.cliente_id = k.cliente_id AND o.usado = false
                AND (o.creado, o.codigo) > (k.creado, k.codigo)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS canjes_pendiente_unico ON canjes (cliente_id) WHERE usado = false;

          -- Intentos fallidos por código de "olvidé mi contraseña": después
          -- de 5 el código deja de servir aunque no haya vencido.
          ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS intentos integer NOT NULL DEFAULT 0;

          -- Cuándo se le mandó el último recordatorio a cada cliente, para
          -- no escribirle otra vez a los pocos días.
          ALTER TABLE clientes ADD COLUMN IF NOT EXISTS recordatorio_enviado_en timestamptz;

          CREATE INDEX IF NOT EXISTS visitas_fecha_idx ON visitas (fecha);

          -- Prueba gratis con fecha de fin: el super-admin elige 14 o 30
          -- días al aprobar un negocio. NULL = sin límite. Si el negocio
          -- paga su suscripción en Stripe, esta fecha deja de importar.
          ALTER TABLE empresas ADD COLUMN IF NOT EXISTS prueba_hasta timestamptz;

          -- Ajustes del super-admin (ej. el secreto de la verificación en
          -- dos pasos). Clave/valor para no crear una tabla por cada ajuste.
          CREATE TABLE IF NOT EXISTS admin_config (
                  clave text PRIMARY KEY,
                  valor text NOT NULL,
                  actualizado timestamptz NOT NULL DEFAULT now()
          );
          `);
}

function filaAEmpresa(fila) {
      if (!fila) return null;
      return {
              id: fila.id,
              nombre: fila.nombre,
              email: fila.email,
              passwordHash: fila.password_hash,
              logoUrl: fila.logo_url,
              color: fila.color,
              colorBoton: fila.color_boton,
              fuente: fila.fuente,
              selloForma: fila.sello_forma,
              selloTamano: fila.sello_tamano,
              slug: fila.slug,
              recompensa: fila.recompensa,
              umbral: fila.umbral,
              activa: fila.activa,
              aprobada: fila.aprobada,
              stripeCustomerId: fila.stripe_customer_id,
              stripeSubscriptionId: fila.stripe_subscription_id,
              suscripcionEstado: fila.suscripcion_estado,
              terminosAceptadosEn: fila.terminos_aceptados_en ? fila.terminos_aceptados_en.toISOString() : null,
              terminosVersion: fila.terminos_version || null,
              pruebaHasta: fila.prueba_hasta ? fila.prueba_hasta.toISOString() : null,
              creado: fila.creado.toISOString()
      };
}

function filaACliente(fila) {
      if (!fila) return null;
      return {
              id: fila.id,
              empresaId: fila.empresa_id,
              nombre: fila.nombre,
              contacto: fila.contacto,
              puntos: fila.puntos,
              googleObjectId: fila.google_object_id,
              consentimiento: fila.consentimiento,
              creado: fila.creado.toISOString(),
              // Solo vienen cuando la consulta los calcula (lista del panel).
              ...(fila.visitas !== undefined ? { visitas: fila.visitas, ultimaVisita: fila.ultima_visita || null } : {})
      };
}

// ---- empresas ----

// Normaliza el email SIEMPRE de la misma forma (sin espacios, en minúsculas)
// antes de guardarlo o de buscarlo. Sin esto, "Juan@Empresa.com" al
// registrarse y "juan@empresa.com" al iniciar sesión (típico: el teclado del
// celular pone mayúscula la primera letra solo) se tratan como cuentas
// distintas y el negocio ve "Email o contraseña incorrectos" sin entender
// por qué, con la contraseña correcta.
function normalizarEmail(email) {
      return String(email || '').trim().toLowerCase();
}

// Umbral de puntos válido: entero >= 1. "Number(v) || 10" (lo que había
// antes) tiene una trampa clásica de JavaScript: si alguien manda
// explícitamente 0, "0 || 10" da 10 porque 0 es "falsy" — se ignoraba el 0
// en silencio. Esta versión solo usa el valor por default cuando lo que
// llega de verdad no es un número válido.
function umbralValido(valor, porDefecto) {
      const n = Number(valor);
      // Tope de 20: una tarjeta con más sellos que eso ya no se ve bien en el
      // editor ni en el pase de Wallet, y en la práctica ningún negocio pide
      // tantas visitas para una sola recompensa.
      return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : porDefecto;
}

// ---- validación del editor de tarjeta de fidelidad ----
// Listas cerradas (no texto libre) para que nadie mande, por error o a
// propósito, un nombre de fuente o una forma que no existe en el editor —
// si no está en la lista, se usa el valor por defecto en vez de guardar
// basura o tronar la consulta.
const FUENTES_VALIDAS = ['IBM Plex Sans', 'Poppins', 'Montserrat', 'Playfair Display', 'Roboto Slab', 'Quicksand', 'Oswald', 'Nunito'];
// Las 4 de siempre (dibujadas a mano en SVG) + un catálogo amplio de
// emojis de comida/bebida y de negocios/servicios comunes (pizzería,
// barbería, lavandería, sushi, etc.), para que cada negocio pueda elegir
// un sello que se parezca a lo que vende. Sigue siendo una LISTA CERRADA
// como las demás (colorValido, opcionValida...) — nunca texto libre — así
// que cualquier slug nuevo que se agregue aquí tiene que agregarse
// también en public-frontend/index.html y mi-tarjeta.html (EMOJI_SELLOS),
// que es donde de verdad se dibuja cada uno.
const SELLO_FORMAS_VALIDAS = [
      'circulo', 'estrella', 'corazon', 'cuadrado',
      // comida y bebida
      'pizza', 'hamburguesa', 'hotdog', 'taco', 'burrito', 'sushi', 'bento',
      'ramen', 'ensalada', 'papas', 'pollo', 'carne', 'sandwich', 'cuernito',
      'bagel', 'pan', 'queso', 'hotcakes', 'waffle', 'huevo', 'dona',
      'galleta', 'pastel', 'cupcake', 'rebanada', 'chocolate', 'dulce',
      'paleta', 'helado', 'copahelado', 'raspado', 'sandia', 'fresa',
      'uvas', 'limon', 'aguacate', 'cafe', 'te', 'bubbletea', 'refresco',
      'cerveza', 'vino', 'coctel', 'brindis', 'champan',
      // negocios y servicios
      'tijeras', 'barberia', 'corte', 'unas', 'labial', 'locion', 'jabon',
      'lavanderia', 'camisa', 'vestido', 'tenis', 'bolsa', 'anillo',
      'lentes', 'reloj', 'celular', 'laptop', 'impresion', 'camara',
      'videojuego', 'libros', 'pluma', 'arte', 'musica', 'cine', 'gym',
      'futbol', 'basquet', 'yoga', 'auto', 'bici', 'gasolina', 'mascota',
      'perro', 'gato', 'planta', 'flor', 'ramo', 'regalo', 'globo',
      'fiesta', 'casa', 'llave', 'herramientas', 'tuercas', 'foco',
      'salud', 'medicina', 'dental', 'spa', 'bano'
];
const SELLO_TAMANOS_VALIDOS = ['pequeno', 'mediano', 'grande'];
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function esUuidValido(valor) {
      return typeof valor === 'string' && UUID_RE.test(valor);
}

// Texto corto escrito por una persona (nombre del negocio, recompensa,
// nombre del cliente...): se recorta y se le quitan los caracteres de
// control. Devuelve null si no es texto o si rebasa el máximo — así nadie
// guarda, por error o a propósito, un "nombre" de varios megas.
function textoValido(valor, max, permitirVacio) {
      if (typeof valor !== 'string') return null;
      const limpio = valor.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (limpio.length > max) return null;
      if (!permitirVacio && limpio.length === 0) return null;
      return limpio;
}

// El logo llega como imagen en base64 ("data:image/png;base64,...") ya
// reducida por el panel. Se valida el formato exacto: ese valor termina
// dentro de un <img> en la tarjeta que ven los CLIENTES de ese negocio, así
// que si se aceptara cualquier texto, un negocio malintencionado podría
// colar código en la página de sus clientes. null = quitar el logo.
const LOGO_DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const LOGO_MAX_CARACTERES = 1500000; // ~1.1 MB de imagen
function logoValido(valor) {
      if (valor === null || valor === '') return { ok: true, valor: null };
      if (typeof valor !== 'string' || valor.length > LOGO_MAX_CARACTERES) return { ok: false };
      if (LOGO_DATA_RE.test(valor)) return { ok: true, valor };
      if (/^https:\/\/[^\s"'<>]{1,500}$/.test(valor)) return { ok: true, valor };
      return { ok: false };
}

const EMAIL_FORMATO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function emailValido(valor) {
      return typeof valor === 'string' && valor.length <= 254 && EMAIL_FORMATO_RE.test(valor.trim());
}

function colorValido(valor, porDefecto) {
      return (typeof valor === 'string' && HEX_COLOR_RE.test(valor.trim())) ? valor.trim() : porDefecto;
}
function opcionValida(valor, opciones, porDefecto) {
      return (typeof valor === 'string' && opciones.includes(valor)) ? valor : porDefecto;
}

// ---- slug (link con marca propia) ----
// Solo minúsculas, números y guiones simples — nada de espacios, acentos ni
// símbolos: esto termina en una URL pública, y cualquier carácter raro ahí
// genera problemas al copiarlo/pegarlo o al compartirlo por WhatsApp.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function slugValido(valor) {
      const v = String(valor || '').trim().toLowerCase();
      return (SLUG_RE.test(v) && v.length >= 3 && v.length <= 40) ? v : null;
}
// Convierte el nombre del negocio en un slug de arranque (sin garantizar
// que esté libre todavía — eso lo revisa crearEmpresa probando sufijos
// -2, -3... hasta encontrar uno que nadie esté usando).
function slugBaseDesdeNombre(nombre) {
      const base = String(nombre || '')
              .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (é -> e)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 40);
      return base || 'negocio';
}
async function slugExiste(slug) {
      const { rows } = await pool.query('SELECT 1 FROM empresas WHERE slug = $1', [slug]);
      return rows.length > 0;
}
async function slugDisponibleDesdeNombre(nombre) {
      const base = slugBaseDesdeNombre(nombre);
      let candidato = base;
      let intento = 1;
      // Tope de intentos solo para no quedar en un loop infinito en un caso
      // absurdo (cientos de negocios con el mismo nombre) — en la práctica
      // esto casi nunca pasa de intento 1 o 2.
      while (intento < 200 && (await slugExiste(candidato))) {
              intento += 1;
              candidato = `${base}-${intento}`;
      }
      return candidato;
}

function hashPassword(password) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(password, salt, 64).toString('hex');
      return `${salt}:${hash}`;
}

function verificarPassword(password, almacenado) {
      // Si llega algo que no es texto (un número, un objeto, nada) o el hash
      // guardado no tiene la forma esperada, simplemente "no coincide" — en
      // vez de tronar con un error 500.
      if (typeof password !== 'string' || typeof almacenado !== 'string') return false;
      const [salt, hash] = almacenado.split(':');
      if (!salt || !hash) return false;
      const esperado = Buffer.from(hash, 'hex');
      const intento = crypto.scryptSync(password, salt, 64);
      if (esperado.length !== intento.length) return false;
      return crypto.timingSafeEqual(esperado, intento);
}

async function crearEmpresa(data) {
      const id = crypto.randomUUID();
      // Por default una cuenta nueva queda SIN aprobar y SIN activar: se da
      // de alta sola desde el link público (cualquiera que lo tenga puede
      // llegar a este formulario), así que hasta que tú la apruebes en el
      // panel de super-admin no puede iniciar sesión. Si en algún momento
      // se necesita dar de alta una empresa ya aprobada desde otro lado
      // (ej. un script interno), se puede pasar data.aprobada = true.
      const aprobada = data.aprobada === true;
      // El slug (link con marca propia) se genera solo a partir del nombre
      // del negocio, probando sufijos -2, -3... si ya hay otro con ese
      // mismo nombre. El negocio lo puede cambiar luego desde el panel por
      // uno a su gusto (PATCH /api/mi-empresa).
      const slug = await slugDisponibleDesdeNombre(data.nombre);
      try {
              const { rows } = await pool.query(
                        `INSERT INTO empresas (id, nombre, email, password_hash, logo_url, color, color_boton, fuente, sello_forma, sello_tamano, recompensa, umbral, activa, aprobada, slug, terminos_aceptados_en, terminos_version)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16) RETURNING *`,
                        [
                                    id,
                                    textoValido(data.nombre, 80) || 'Mi negocio',
                                    data.email ? normalizarEmail(data.email) : null,
                                    data.password ? hashPassword(data.password) : null,
                                    data.logoUrl || null,
                                    colorValido(data.color, '#b8872b'),
                                    colorValido(data.colorBoton, '#1b1f23'),
                                    opcionValida(data.fuente, FUENTES_VALIDAS, 'IBM Plex Sans'),
                                    opcionValida(data.selloForma, SELLO_FORMAS_VALIDAS, 'circulo'),
                                    opcionValida(data.selloTamano, SELLO_TAMANOS_VALIDOS, 'mediano'),
                                    textoValido(data.recompensa, 120, true) || '',
                                    umbralValido(data.umbral, 10),
                                    aprobada,
                                    slug,
                                    data.terminosAceptados === true ? new Date() : null,
                                    data.terminosAceptados === true ? (data.terminosVersion || null) : null
                                  ]
                      );
              return filaAEmpresa(rows[0]);
      } catch (e) {
              if (e.code === '23505') {
                        throw new Error('Ya existe una empresa registrada con ese email');
              }
              throw e;
      }
}

async function obtenerEmpresa(id) {
      const { rows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
      return filaAEmpresa(rows[0]);
}

async function obtenerEmpresaPorEmail(email) {
      // Compara normalizando el email guardado Y el que llega — así funciona
      // también para cuentas que ya existían antes de este cambio con el
      // email guardado en mayúsculas/minúsculas distintas a como lo escriben
      // al iniciar sesión.
      const { rows } = await pool.query(
              'SELECT * FROM empresas WHERE lower(btrim(email)) = $1',
              [normalizarEmail(email)]
            );
      return filaAEmpresa(rows[0]);
}

async function obtenerEmpresaPorSlug(slug) {
      const { rows } = await pool.query('SELECT * FROM empresas WHERE slug = $1', [String(slug || '').toLowerCase()]);
      return filaAEmpresa(rows[0]);
}

// Usado por la página de registro: el link que comparte el negocio puede
// traer el id real (UUID, los links viejos) o el slug bonito (los nuevos) —
// esta función acepta cualquiera de los dos sin que el que llama tenga que
// saber cuál es.
async function obtenerEmpresaPorIdOSlug(valor) {
      if (esUuidValido(valor)) {
              const porId = await obtenerEmpresa(valor);
              if (porId) return porId;
      }
      return obtenerEmpresaPorSlug(valor);
}

async function listarEmpresas() {
      // Con cada negocio, cuántos clientes tiene y cuántas visitas tuvo en
      // los últimos 30 días (para el super-admin).
      const { rows } = await pool.query(`
              SELECT e.*,
                     (SELECT count(*) FROM clientes c WHERE c.empresa_id = e.id)::int AS total_clientes,
                     (SELECT count(*) FROM visitas v JOIN clientes c2 ON c2.id = v.cliente_id WHERE c2.empresa_id = e.id AND v.fecha >= ${HOY} - 30)::int AS visitas_30d
                FROM empresas e
               ORDER BY e.creado DESC`);
      return rows.map((fila) => ({ ...filaAEmpresa(fila), totalClientes: fila.total_clientes, visitas30d: fila.visitas_30d }));
}

async function setActivaEmpresa(id, activa, diasPrueba) {
      // Activar (desde el panel de super-admin) siempre cuenta como
      // aprobar: así el mismo botón sirve tanto para reactivar un negocio
      // que ya conocías como para aprobar una solicitud nueva. Desactivar
      // NO quita la aprobación.
      //
      // diasPrueba (solo al activar): un número de días → la prueba gratis
      // termina en esa fecha; 0 → sin límite; undefined → no se toca.
      let sql;
      const params = [id];
      if (!activa) {
              sql = 'UPDATE empresas SET activa = false WHERE id = $1 RETURNING *';
      } else if (diasPrueba === undefined) {
              sql = 'UPDATE empresas SET activa = true, aprobada = true WHERE id = $1 RETURNING *';
      } else if (diasPrueba === 0) {
              sql = 'UPDATE empresas SET activa = true, aprobada = true, prueba_hasta = NULL WHERE id = $1 RETURNING *';
      } else {
              sql = `UPDATE empresas SET activa = true, aprobada = true,
                            prueba_hasta = now() + make_interval(days => $2::int) WHERE id = $1 RETURNING *`;
              params.push(diasPrueba);
      }
      const { rows } = await pool.query(sql, params);
      return filaAEmpresa(rows[0]);
}

// ¿Se le acabó la prueba gratis y no está pagando? Una suscripción de
// Stripe activa siempre gana sobre la fecha de prueba.
function pruebaVencida(empresa) {
      if (!empresa || !empresa.pruebaHasta) return false;
      if (empresa.suscripcionEstado === 'active' || empresa.suscripcionEstado === 'trialing') return false;
      return new Date(empresa.pruebaHasta).getTime() < Date.now();
}

async function leerAjusteAdmin(clave) {
      const { rows } = await pool.query('SELECT valor FROM admin_config WHERE clave = $1', [clave]);
      return rows[0] ? rows[0].valor : null;
}
async function guardarAjusteAdmin(clave, valor) {
      await pool.query(
              `INSERT INTO admin_config (clave, valor) VALUES ($1, $2)
               ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = now()`,
              [clave, valor]
      );
}
async function borrarAjusteAdmin(clave) {
      await pool.query('DELETE FROM admin_config WHERE clave = $1', [clave]);
}

async function validarLogin(email, password) {
      const empresa = await obtenerEmpresaPorEmail(email);
      if (!empresa || !empresa.passwordHash) return null;
      if (!verificarPassword(password, empresa.passwordHash)) return null;
      return empresa;
}

// ---- recuperación de contraseña (solo negocios, no clientes) ----

// Código de 6 dígitos, fácil de copiar desde un correo en el celular.
function generarCodigoReset() {
      return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function crearSolicitudReset(empresaId) {
      const id = crypto.randomUUID();
      const codigo = generarCodigoReset();
      // Se guarda con el mismo hash seguro que las contraseñas (nunca el
      // código en texto plano) — así, aunque alguien leyera la base de
      // datos, no podría usar los códigos directamente.
      const codigoHash = hashPassword(codigo);
      const expira = new Date(Date.now() + 15 * 60 * 1000); // vence en 15 minutos
      await pool.query(
              `INSERT INTO password_resets (id, empresa_id, codigo_hash, expira, usado)
                     VALUES ($1,$2,$3,$4,false)`,
              [id, empresaId, codigoHash, expira]
            );
      return codigo;
}

// Revisa el código contra TODAS las solicitudes vigentes (no usadas, no
// vencidas) de esa empresa — por si pidió el código más de una vez y usa
// uno de los anteriores que todavía no venció. Si coincide, lo marca usado
// de una vez para que no se pueda reutilizar.
async function validarYConsumirReset(empresaId, codigo) {
      const { rows } = await pool.query(
              `SELECT * FROM password_resets
                     WHERE empresa_id = $1 AND usado = false AND expira > now() AND intentos < 5
                           ORDER BY creado DESC`,
              [empresaId]
            );
      for (const fila of rows) {
              if (verificarPassword(String(codigo), fila.codigo_hash)) {
                        // Se invalidan TODOS los códigos de esa cuenta, no solo
                        // el que se usó: si pidió varios, los demás ya no deben
                        // servir una vez que la contraseña cambió.
                        await pool.query('UPDATE password_resets SET usado = true WHERE empresa_id = $1', [empresaId]);
                        return true;
              }
      }
      // Código equivocado: cuenta como intento contra todos los códigos
      // vigentes. Un código de 6 dígitos solo es seguro si no se puede
      // probar miles de veces — al quinto fallo deja de servir.
      await pool.query(
              'UPDATE password_resets SET intentos = intentos + 1 WHERE empresa_id = $1 AND usado = false AND expira > now()',
              [empresaId]
            );
      return false;
}

async function actualizarPasswordEmpresa(empresaId, password) {
      await pool.query(
              'UPDATE empresas SET password_hash = $2 WHERE id = $1',
              [empresaId, hashPassword(password)]
            );
}

async function actualizarEmpresa(id, cambios) {
      const permitido = {};
      for (const campo of ['nombre', 'color', 'colorBoton', 'fuente', 'selloForma', 'selloTamano', 'recompensa', 'umbral', 'logoUrl', 'slug']) {
              if (cambios[campo] !== undefined) permitido[campo] = cambios[campo];
      }
      const columnas = {
              nombre: 'nombre',
              color: 'color',
              colorBoton: 'color_boton',
              fuente: 'fuente',
              selloForma: 'sello_forma',
              selloTamano: 'sello_tamano',
              recompensa: 'recompensa',
              umbral: 'umbral',
              logoUrl: 'logo_url',
              slug: 'slug'
      };
      const sets = [];
      const valores = [id];
      for (const [campo, valor] of Object.entries(permitido)) {
              // Antes este valor se mandaba tal cual a Postgres: si llegaba
              // texto raro o un número fuera de rango en "umbral" (por un bug
              // del frontend, o alguien llamando a la API directo), la base
              // de datos lo rechazaba y el negocio veía "Error interno del
              // servidor" en vez de un aviso claro. Lo mismo para los campos
              // nuevos del editor de tarjeta: si llega algo que no es un hex
              // válido o no está en la lista cerrada de opciones, se avisa con
              // un error claro en vez de guardar basura o tronar la consulta.
              let valorFinal = valor;
              let invalido = false;
              if (campo === 'umbral') {
                        valorFinal = umbralValido(valor, null);
                        invalido = valorFinal === null;
              } else if (campo === 'color' || campo === 'colorBoton') {
                        valorFinal = colorValido(valor, null);
                        invalido = valorFinal === null;
              } else if (campo === 'fuente') {
                        valorFinal = opcionValida(valor, FUENTES_VALIDAS, null);
                        invalido = valorFinal === null;
              } else if (campo === 'selloForma') {
                        valorFinal = opcionValida(valor, SELLO_FORMAS_VALIDAS, null);
                        invalido = valorFinal === null;
              } else if (campo === 'selloTamano') {
                        valorFinal = opcionValida(valor, SELLO_TAMANOS_VALIDOS, null);
                        invalido = valorFinal === null;
              } else if (campo === 'slug') {
                        valorFinal = slugValido(valor);
                        invalido = valorFinal === null;
              } else if (campo === 'nombre') {
                        valorFinal = textoValido(valor, 80);
                        invalido = valorFinal === null;
              } else if (campo === 'recompensa') {
                        valorFinal = textoValido(valor, 120, true);
                        invalido = valorFinal === null;
              } else if (campo === 'logoUrl') {
                        const logo = logoValido(valor);
                        valorFinal = logo.ok ? logo.valor : null;
                        invalido = !logo.ok;
              }
              if (invalido) {
                        const mensajes = {
                                    umbral: 'El umbral de puntos debe ser un número entero entre 1 y 20',
                                    color: 'El color de la tarjeta debe ser un color hexadecimal válido (ej. #b8872b)',
                                    colorBoton: 'El color de los botones debe ser un color hexadecimal válido (ej. #1b1f23)',
                                    fuente: 'Esa tipografía no está en la lista de opciones disponibles',
                                    selloForma: 'Esa forma de sello no está en la lista de opciones disponibles',
                                    selloTamano: 'Ese tamaño de sello no está en la lista de opciones disponibles',
                                    slug: 'El link debe tener entre 3 y 40 letras/números, sin espacios ni acentos (solo guiones para separar palabras)',
                                    nombre: 'El nombre del negocio no puede quedar vacío ni pasar de 80 caracteres',
                                    recompensa: 'La recompensa no puede pasar de 120 caracteres',
                                    logoUrl: 'El logo debe ser una imagen PNG, JPG o WebP de máximo 1 MB'
                        };
                        const error = new Error(mensajes[campo] || 'Dato inválido');
                        error.datosInvalidos = true;
                        throw error;
              }
              valores.push(valorFinal);
              sets.push(`${columnas[campo]} = $${valores.length}`);
      }
      if (sets.length === 0) return obtenerEmpresa(id);
      let rows;
      try {
              ({ rows } = await pool.query(
                        `UPDATE empresas SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
                        valores
                      ));
      } catch (e) {
              if (e.code === '23505') {
                        const error = new Error('Ese link ya lo está usando otro negocio — elige otro.');
                        error.datosInvalidos = true;
                        throw error;
              }
              throw e;
      }
      // Si cambió algo que se VE en la tarjeta (no solo el nombre del
      // negocio para efectos internos), los pases de Apple Wallet que ya
      // tienen los clientes de este negocio quedaron "viejos" — se marca a
      // todos sus clientes para que el servicio web de Apple (server.js)
      // sepa que debe avisarles que lo actualicen.
      const CAMPOS_VISUALES = ['color', 'colorBoton', 'fuente', 'selloForma', 'selloTamano', 'recompensa', 'umbral', 'logoUrl', 'nombre'];
      if (Object.keys(permitido).some((c) => CAMPOS_VISUALES.includes(c))) {
              await pool.query('UPDATE clientes SET actualizado_en = now() WHERE empresa_id = $1', [id]);
      }
      return filaAEmpresa(rows[0]);
}

// ---- consultas filtradas por empresa, para el panel ----
async function clientesDeEmpresa(empresaId) {
      const { rows } = await pool.query(
              `SELECT c.*, x.n AS visitas, to_char(x.ultima, 'YYYY-MM-DD') AS ultima_visita
                     FROM clientes c
                     JOIN LATERAL (
                           SELECT count(*)::int AS n, max(fecha) AS ultima FROM visitas WHERE cliente_id = c.id
                     ) x ON true
                     WHERE c.empresa_id = $1
                     ORDER BY c.creado DESC`,
              [empresaId]
            );
      return rows.map(filaACliente);
}

async function estadisticasDeEmpresa(empresaId) {
      // Una sola consulta con contadores (antes se traían TODAS las filas de
      // clientes a memoria solo para contarlas y sumar sus puntos).
      const { rows } = await pool.query(
              `SELECT
                     (SELECT count(*)::int FROM clientes WHERE empresa_id = $1) AS total_clientes,
                     (SELECT COALESCE(sum(puntos), 0)::int FROM clientes WHERE empresa_id = $1) AS puntos,
                     (SELECT count(*)::int FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                            WHERE c.empresa_id = $1 AND v.fecha = ${HOY}) AS visitas_hoy,
                     (SELECT count(*)::int FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                            WHERE c.empresa_id = $1) AS visitas_totales,
                     (SELECT count(*)::int FROM canjes k JOIN clientes c ON c.id = k.cliente_id
                            WHERE c.empresa_id = $1 AND k.usado = false) AS canjes_pendientes,
                     (SELECT count(*)::int FROM canjes k JOIN clientes c ON c.id = k.cliente_id
                            WHERE c.empresa_id = $1 AND k.usado = true) AS recompensas_entregadas,
                     (SELECT count(*)::int FROM clientes c JOIN empresas e ON e.id = c.empresa_id
                            WHERE c.empresa_id = $1 AND c.puntos >= e.umbral) AS recompensas_listas`,
              [empresaId]
            );
      const r = rows[0];
      return {
              totalClientes: r.total_clientes,
              visitasHoy: r.visitas_hoy,
              visitasTotales: r.visitas_totales,
              canjesPendientes: r.canjes_pendientes,
              puntosRepartidos: r.puntos,
              // Clientes que YA juntaron sus sellos y todavía no reclaman.
              recompensasListas: r.recompensas_listas,
              recompensasEntregadas: r.recompensas_entregadas
      };
}

// "Qué hago con esto": lo accionable del panel. Quién ya puede cobrar su
// recompensa, a quién le falta poquito (son los que conviene invitar a
// volver), quiénes son los mejores clientes, qué días y a qué horas llega
// más gente, y qué clientes frecuentes dejaron de venir.
async function insightsDeEmpresa(empresaId) {
      const [segmentos, cercanos, top, dias, horas, riesgo, recompensas, wallet] = await Promise.all([
              pool.query(
                      `WITH vc AS (
                             SELECT c.id, count(v.id)::int AS n, max(v.fecha) AS ultima
                             FROM clientes c LEFT JOIN visitas v ON v.cliente_id = c.id
                             WHERE c.empresa_id = $1
                             GROUP BY c.id
                       )
                       SELECT count(*) FILTER (WHERE n = 0)::int AS sin_visitas,
                              count(*) FILTER (WHERE n = 1)::int AS nuevos,
                              count(*) FILTER (WHERE n BETWEEN 2 AND 4)::int AS recurrentes,
                              count(*) FILTER (WHERE n >= 5)::int AS leales,
                              count(*) FILTER (WHERE n >= 2 AND ultima < ${HOY} - 30)::int AS en_riesgo
                       FROM vc`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT c.id, c.nombre, c.puntos, e.umbral,
                              count(*) FILTER (WHERE c.puntos >= e.umbral) OVER ()::int AS total_listos,
                              count(*) FILTER (WHERE c.puntos < e.umbral) OVER ()::int AS total_cerca
                       FROM clientes c JOIN empresas e ON e.id = c.empresa_id
                       WHERE c.empresa_id = $1 AND c.puntos > 0 AND c.puntos >= e.umbral - 2
                       ORDER BY c.puntos DESC, c.nombre ASC
                       LIMIT 60`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT c.id, c.nombre, count(v.id)::int AS visitas, to_char(max(v.fecha), 'YYYY-MM-DD') AS ultima
                       FROM clientes c JOIN visitas v ON v.cliente_id = c.id
                       WHERE c.empresa_id = $1
                       GROUP BY c.id, c.nombre
                       ORDER BY visitas DESC, max(v.fecha) DESC, c.nombre ASC
                       LIMIT 5`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT EXTRACT(isodow FROM v.fecha)::int AS d, count(*)::int AS n
                       FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                       WHERE c.empresa_id = $1 AND v.fecha > ${HOY} - 90
                       GROUP BY 1`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT EXTRACT(hour FROM v.hora AT TIME ZONE '${ZONA_HORARIA}')::int AS h, count(*)::int AS n
                       FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                       WHERE c.empresa_id = $1 AND v.fecha > ${HOY} - 90
                       GROUP BY 1`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT c.id, c.nombre, x.n AS visitas, to_char(x.ultima, 'YYYY-MM-DD') AS ultima
                       FROM clientes c
                       JOIN LATERAL (
                             SELECT count(*)::int AS n, max(fecha) AS ultima FROM visitas WHERE cliente_id = c.id
                       ) x ON true
                       WHERE c.empresa_id = $1 AND x.n >= 2 AND x.ultima < ${HOY} - 30
                       ORDER BY x.n DESC, x.ultima DESC
                       LIMIT 6`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT count(*) FILTER (WHERE k.usado)::int AS total,
                              count(*) FILTER (WHERE k.usado AND k.usado_el > now() - interval '30 days')::int AS ultimos30
                       FROM canjes k JOIN clientes c ON c.id = k.cliente_id
                       WHERE c.empresa_id = $1`,
                      [empresaId]
              ),
              pool.query(
                      `SELECT count(DISTINCT d.cliente_id)::int AS n
                       FROM dispositivos_pase d JOIN clientes c ON c.id = d.cliente_id
                       WHERE c.empresa_id = $1`,
                      [empresaId]
              )
      ]);

      const sg = segmentos.rows[0];
      const filasCercanas = cercanos.rows;
      const listos = filasCercanas.filter((f) => f.puntos >= f.umbral);
      const cerca = filasCercanas.filter((f) => f.puntos < f.umbral);

      // Lunes a domingo (isodow 1..7) y las 24 horas, rellenando con 0 lo
      // que no tuvo visitas — la gráfica necesita la serie completa.
      const porDiaSemana = [0, 0, 0, 0, 0, 0, 0];
      dias.rows.forEach((f) => { if (f.d >= 1 && f.d <= 7) porDiaSemana[f.d - 1] = f.n; });
      const porHora = new Array(24).fill(0);
      horas.rows.forEach((f) => { if (f.h >= 0 && f.h <= 23) porHora[f.h] = f.n; });

      return {
              listosParaCanje: {
                      total: filasCercanas[0] ? filasCercanas[0].total_listos : 0,
                      lista: listos.slice(0, 6).map((f) => ({ id: f.id, nombre: f.nombre, puntos: f.puntos }))
              },
              cercaDeRecompensa: {
                      total: filasCercanas[0] ? filasCercanas[0].total_cerca : 0,
                      lista: cerca.slice(0, 6).map((f) => ({ id: f.id, nombre: f.nombre, puntos: f.puntos, faltan: f.umbral - f.puntos }))
              },
              topClientes: top.rows.map((f) => ({ id: f.id, nombre: f.nombre, visitas: f.visitas, ultimaVisita: f.ultima })),
              porDiaSemana,
              porHora,
              segmentos: {
                      sinVisitas: sg.sin_visitas,
                      nuevos: sg.nuevos,
                      recurrentes: sg.recurrentes,
                      leales: sg.leales
              },
              enRiesgo: {
                      total: sg.en_riesgo,
                      lista: riesgo.rows.map((f) => ({ id: f.id, nombre: f.nombre, visitas: f.visitas, ultimaVisita: f.ultima }))
              },
              recompensas: { entregadas: recompensas.rows[0].total, entregadasUltimos30: recompensas.rows[0].ultimos30 },
              walletApple: wallet.rows[0].n
      };
}

// Periodos permitidos para "Tus números claros" — una lista cerrada (no
// cualquier número de días) para que no se pueda pedir una ventana
// absurdamente grande ni negativa.
const DIAS_PERIODO_VALIDOS = [30, 120, 365];
function diasPeriodoValido(valor) {
      const n = Number(valor);
      return DIAS_PERIODO_VALIDOS.includes(n) ? n : 30;
}

// Las 4 tarjetas de "Tus números claros": cuántos clientes ya registrados
// vinieron en el periodo, qué % de los que tuvieron oportunidad de volver
// de verdad volvieron, cuántos miembros nuevos se dieron de alta, y cada
// cuántos días en promedio repiten — cada una comparada contra el periodo
// inmediato anterior de la misma duración, para el "↑/↓ X% contra el
// periodo anterior" en verde/rojo. Son pocas consultas (una por tarjeta,
// cada una resuelve el periodo actual Y el anterior de una sola pasada con
// FILTER) en vez de 8 viajes separados a la base de datos.
async function estadisticasAvanzadasDeEmpresa(empresaId, dias) {
      const n = diasPeriodoValido(dias);

      const vinieronYNuevosPromesa = pool.query(
              `SELECT
                       (SELECT count(*)::int FROM clientes WHERE empresa_id = $1) AS total_miembros,
                       (SELECT count(*)::int FROM clientes WHERE empresa_id = $1 AND creado > now() - ($2::int || ' days')::interval) AS nuevos_actual,
                       (SELECT count(*)::int FROM clientes WHERE empresa_id = $1
                              AND creado <= now() - ($2::int || ' days')::interval
                              AND creado > now() - (2 * $2::int || ' days')::interval) AS nuevos_anterior,
                       (SELECT count(DISTINCT v.cliente_id)::int FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                              WHERE c.empresa_id = $1 AND v.fecha > ${HOY} - $2::int) AS vinieron_actual,
                       (SELECT count(DISTINCT v.cliente_id)::int FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                              WHERE c.empresa_id = $1
                              AND v.fecha <= ${HOY} - $2::int
                              AND v.fecha > ${HOY} - 2 * $2::int) AS vinieron_anterior
                      `,
              [empresaId, n]
            );

      // Retención: de los clientes cuya PRIMERA visita cayó dentro de la
      // ventana (y por lo tanto ya tuvieron los "n" días completos para
      // regresar), qué % sí volvió al menos una vez dentro de esos "n" días
      // después de esa primera visita. La ventana "anterior" es la misma
      // definición, recorrida "n" días más atrás.
      const retencionPromesa = pool.query(
              `WITH primeras AS (
                     SELECT v.cliente_id, MIN(v.fecha) AS primera_fecha
                     FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                     WHERE c.empresa_id = $1
                     GROUP BY v.cliente_id
               ),
               cohortes AS (
                     SELECT p.cliente_id, p.primera_fecha,
                            EXISTS (
                                   SELECT 1 FROM visitas v2
                                   WHERE v2.cliente_id = p.cliente_id
                                   AND v2.fecha > p.primera_fecha
                                   AND v2.fecha <= p.primera_fecha + $2::int
                            ) AS regreso
                     FROM primeras p
                     WHERE p.primera_fecha <= ${HOY} - $2::int
                     AND p.primera_fecha > ${HOY} - 3 * $2::int
               )
               SELECT
                     count(*) FILTER (WHERE primera_fecha > ${HOY} - 2 * $2::int)::int AS elegibles_actual,
                     count(*) FILTER (WHERE primera_fecha > ${HOY} - 2 * $2::int AND regreso)::int AS regresaron_actual,
                     count(*) FILTER (WHERE primera_fecha <= ${HOY} - 2 * $2::int)::int AS elegibles_anterior,
                     count(*) FILTER (WHERE primera_fecha <= ${HOY} - 2 * $2::int AND regreso)::int AS regresaron_anterior
               FROM cohortes`,
              [empresaId, n]
            );

      // Cada cuántos días en promedio regresa un cliente: el promedio de los
      // "huecos" entre visitas consecutivas de un mismo cliente, contando
      // solo visitas dentro de la ventana (y la ventana anterior, para su
      // propio promedio de comparación).
      const promedioDiasPromesa = pool.query(
              `WITH huecos AS (
                     SELECT v.fecha,
                            v.fecha - LAG(v.fecha) OVER (PARTITION BY v.cliente_id ORDER BY v.fecha) AS hueco
                     FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                     WHERE c.empresa_id = $1 AND v.fecha > ${HOY} - 2 * $2::int
               )
               SELECT
                     avg(hueco) FILTER (WHERE fecha > ${HOY} - $2::int)::float AS promedio_actual,
                     avg(hueco) FILTER (WHERE fecha <= ${HOY} - $2::int)::float AS promedio_anterior
               FROM huecos WHERE hueco IS NOT NULL`,
              [empresaId, n]
            );

      const [vinieronYNuevos, retencion, promedioDias] = await Promise.all([
              vinieronYNuevosPromesa, retencionPromesa, promedioDiasPromesa
      ]);
      const vn = vinieronYNuevos.rows[0];
      const rt = retencion.rows[0];
      const pd = promedioDias.rows[0];

      // % de cambio contra el periodo anterior — null cuando el periodo
      // anterior fue 0 (no hay base contra qué comparar, no es "infinito%").
      function deltaPct(actual, anterior) {
              if (!anterior) return actual > 0 ? null : 0;
              return Math.round(((actual - anterior) / anterior) * 1000) / 10;
      }
      function pctOrNull(parte, total) {
              return total > 0 ? Math.round((parte / total) * 1000) / 10 : null;
      }

      return {
              dias: n,
              totalMiembros: vn.total_miembros,
              vinieron: { actual: vn.vinieron_actual, deltaPct: deltaPct(vn.vinieron_actual, vn.vinieron_anterior) },
              nuevosMiembros: { actual: vn.nuevos_actual, deltaPct: deltaPct(vn.nuevos_actual, vn.nuevos_anterior) },
              retencion: {
                      pct: pctOrNull(rt.regresaron_actual, rt.elegibles_actual),
                      deltaPuntos: (() => {
                              const actualPct = pctOrNull(rt.regresaron_actual, rt.elegibles_actual);
                              const anteriorPct = pctOrNull(rt.regresaron_anterior, rt.elegibles_anterior);
                              if (actualPct === null || anteriorPct === null) return null;
                              return Math.round((actualPct - anteriorPct) * 10) / 10;
                      })()
              },
              promedioDiasEntreVisitas: {
                      valor: pd.promedio_actual !== null ? Math.round(pd.promedio_actual * 10) / 10 : null,
                      deltaDias: (pd.promedio_actual !== null && pd.promedio_anterior !== null)
                              ? Math.round((pd.promedio_actual - pd.promedio_anterior) * 10) / 10
                              : null
              }
      };
}

// Serie semanal de visitas (para la gráfica de barras apiladas), separando
// cada visita en "primera" (la primera vez de ese cliente en la vida del
// negocio) o "regresa" (ya había venido antes). "historico" trae todas las
// semanas desde que la empresa se dio de alta; si no, solo las últimas 12.
async function visitasPorSemanaDeEmpresa(empresaId, historico) {
      let pasos = 12;
      if (historico) {
              const empresa = await obtenerEmpresa(empresaId);
              const diasDesdeAlta = empresa
                      ? Math.max(1, Math.ceil((Date.now() - new Date(empresa.creado).getTime()) / 86400000))
                      : 7;
              pasos = Math.min(520, Math.max(1, Math.ceil(diasDesdeAlta / 7) + 1));
      }
      const { rows } = await pool.query(
              `SELECT to_char(b.bucket, 'YYYY-MM-DD') AS semana,
                      COALESCE(t.primeras, 0)::int AS primeras,
                      COALESCE(t.regresan, 0)::int AS regresan
               FROM generate_series(
                      date_trunc('week', ${AHORA_LOCAL}) - ((${pasos - 1})::text || ' week')::interval,
                      date_trunc('week', ${AHORA_LOCAL}),
                      interval '1 week'
               ) AS b(bucket)
               LEFT JOIN (
                      SELECT date_trunc('week', v.fecha::timestamp) AS bucket,
                             count(*) FILTER (WHERE v.fecha = pf.primera_fecha)::int AS primeras,
                             count(*) FILTER (WHERE v.fecha <> pf.primera_fecha)::int AS regresan
                      FROM visitas v
                      JOIN clientes c ON c.id = v.cliente_id
                      JOIN (
                             SELECT v2.cliente_id, MIN(v2.fecha) AS primera_fecha
                             FROM visitas v2 JOIN clientes c2 ON c2.id = v2.cliente_id
                             WHERE c2.empresa_id = $1
                             GROUP BY v2.cliente_id
                      ) pf ON pf.cliente_id = v.cliente_id
                      WHERE c.empresa_id = $1
                      GROUP BY 1
               ) t ON t.bucket = b.bucket
               ORDER BY b.bucket ASC`,
              [empresaId]
            );
      return rows;
}

// ---- clientes ----
// Teléfono o correo del cliente en una forma única, para que "998 123 4567",
// "998-123-4567" y "9981234567" cuenten como el MISMO teléfono (y
// "Ana@Correo.com" igual a "ana@correo.com"). Devuelve null si no parece ni
// un correo ni un teléfono de 10 a 15 dígitos.
function normalizarContacto(valor) {
      const c = String(valor || '').trim();
      if (!c) return null;
      if (c.includes('@')) return emailValido(c) ? c.toLowerCase() : null;
      if (/[^0-9+\s().-]/.test(c)) return null;
      const digitos = c.replace(/\D/g, '');
      if (digitos.length < 10 || digitos.length > 15) return null;
      return (c.startsWith('+') ? '+' : '') + digitos;
}

// Busca un cliente de esa empresa con ese contacto. Compara también solo
// los dígitos, para encontrar teléfonos que se guardaron con espacios o
// guiones antes de que existiera normalizarContacto.
async function buscarClientePorContacto(empresaId, contacto) {
      const esCorreo = contacto.includes('@');
      const { rows } = await pool.query(
              esCorreo
                ? `SELECT * FROM clientes WHERE empresa_id = $1 AND lower(btrim(contacto)) = $2 LIMIT 1`
                : `SELECT * FROM clientes WHERE empresa_id = $1
                     AND (btrim(contacto) = $2 OR (contacto NOT LIKE '%@%' AND regexp_replace(contacto, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')))
                   ORDER BY creado LIMIT 1`,
              [empresaId, contacto]
      );
      return rows[0] || null;
}

// Crea la tarjeta de un cliente. El contacto (teléfono o correo) es
// obligatorio: es lo que distingue a una persona de otra (dos clientes se
// pueden llamar igual). Si ese contacto ya tiene tarjeta en este negocio,
// se regresa la existente con yaExistia = true en vez de crear otra.
async function crearCliente(data) {
      const nombre = textoValido(data.nombre, 80);
      if (!nombre) {
              const error = new Error('Escribe tu nombre (máximo 80 caracteres)');
              error.datosInvalidos = true;
              throw error;
      }
      const contacto = normalizarContacto(data.contacto);
      if (!contacto) {
              const error = new Error('Escribe un teléfono de 10 dígitos o un correo válido.');
              error.datosInvalidos = true;
              throw error;
      }
      const existente = await buscarClientePorContacto(data.empresaId, contacto);
      if (existente) return { ...filaACliente(existente), yaExistia: true };

      const id = crypto.randomUUID();
      try {
              const { rows } = await pool.query(
                        `INSERT INTO clientes (id, empresa_id, nombre, contacto, puntos, consentimiento)
                               VALUES ($1,$2,$3,$4,0,$5) RETURNING *`,
                        [id, data.empresaId, nombre, contacto, !!data.consentimiento]
                      );
              return { ...filaACliente(rows[0]), yaExistia: false };
      } catch (e) {
              // Carrera: dos registros al mismo tiempo con el mismo contacto.
              if (e.code === '23505') {
                      const fila = await buscarClientePorContacto(data.empresaId, contacto);
                      if (fila) return { ...filaACliente(fila), yaExistia: true };
              }
              throw e;
      }
}

async function obtenerCliente(id) {
      const { rows } = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
      return filaACliente(rows[0]);
}

// Borra un cliente — siempre filtrado también por empresaId en el WHERE
// (no solo por el id del cliente): así una empresa nunca puede borrar, ni
// por error ni a propósito, el cliente de OTRA empresa aunque adivinara su
// id. Por el ON DELETE CASCADE de las tablas visitas/canjes, sus visitas y
// canjes se van con él.
async function eliminarCliente(empresaId, clienteId) {
      const { rows } = await pool.query(
              'DELETE FROM clientes WHERE id = $1 AND empresa_id = $2 RETURNING id',
              [clienteId, empresaId]
            );
      return rows.length > 0;
}

// Clientes de un negocio que abrieron su link de Google Wallet (para
// actualizarles el pase cuando el negocio cambia el diseño de su tarjeta).
async function clientesConGoogleWallet(empresaId) {
      const { rows } = await pool.query(
              'SELECT * FROM clientes WHERE empresa_id = $1 AND google_object_id IS NOT NULL ORDER BY actualizado_en DESC NULLS LAST LIMIT 2000',
              [empresaId]
      );
      return rows.map(filaACliente);
}

async function marcarGoogleWallet(clienteId, objetoId) {
      await pool.query('UPDATE clientes SET google_object_id = $2 WHERE id = $1 AND google_object_id IS DISTINCT FROM $2', [clienteId, objetoId]);
}

async function actualizarCliente(id, cambios) {
      const campoPorClave = { puntos: 'puntos', googleObjectId: 'google_object_id', nombre: 'nombre', contacto: 'contacto' };
      const sets = [];
      const valores = [id];
      for (const [campo, valor] of Object.entries(cambios)) {
              const columna = campoPorClave[campo];
              if (!columna) continue;
              valores.push(valor);
              sets.push(`${columna} = $${valores.length}`);
      }
      if (sets.length === 0) return obtenerCliente(id);
      const { rows } = await pool.query(
              `UPDATE clientes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
              valores
            );
      return filaACliente(rows[0]);
}

// ---- visitas (antifraude: una por día por cliente) ----
async function yaVisitoHoy(clienteId) {
      const { rows } = await pool.query(
              `SELECT 1 FROM visitas WHERE cliente_id = $1 AND fecha = ${HOY} LIMIT 1`,
              [clienteId]
            );
      return rows.length > 0;
}

async function registrarVisita(clienteId) {
      const id = crypto.randomUUID();
      // La visita y el punto van en UNA transacción: antes eran dos pasos
      // sueltos, y si el segundo fallaba (un hipo de la base de datos justo
      // en medio) quedaba la visita registrada sin su punto — y el cliente
      // ya no podía volver a intentarlo ese día ("ya se registró una visita
      // hoy").
      return conTransaccion(async (tx) => {
              try {
                        await tx.query(
                                    `INSERT INTO visitas (id, cliente_id, fecha) VALUES ($1,$2,${HOY})`,
                                    [id, clienteId]
                                  );
              } catch (e) {
                        // "yaVisitoHoy" ya revisa esto antes de llegar aquí, pero
                        // esa revisión y este INSERT son dos pasos separados: si
                        // otra petición para el mismo cliente se mete justo en
                        // medio (dos empleados escaneando a la vez, o un
                        // reintento de red), las dos podrían pasar la revisión.
                        // El índice único de la tabla es quien de verdad lo
                        // evita; aquí solo se traduce ese choque en el error
                        // que ya conoce el resto del código.
                        if (e.code === '23505') {
                                    const error = new Error('Ya se registró una visita hoy para este cliente');
                                    error.yaVisito = true;
                                    throw error;
                        }
                        throw e;
              }
              const { rows } = await tx.query(
                        `UPDATE clientes SET puntos = puntos + 1, actualizado_en = now() WHERE id = $1 RETURNING *`,
                        [clienteId]
                      );
              return filaACliente(rows[0]);
      });
}

// ---- canjes (código de un solo uso, distinto al QR del cliente) ----
async function crearCanje(clienteId) {
      const codigo = crypto.randomUUID();
      // Si el cliente ya tiene un código pendiente se reutiliza ESE (el
      // índice único canjes_pendiente_unico solo permite uno por cliente):
      // tocar "Generar código" dos veces ya no deja dos códigos válidos para
      // la misma recompensa.
      const { rows } = await pool.query(
              `INSERT INTO canjes (codigo, cliente_id, usado) VALUES ($1,$2,false)
                     ON CONFLICT (cliente_id) WHERE usado = false
                     DO UPDATE SET creado = now()
                     RETURNING *`,
              [codigo, clienteId]
            );
      return { codigo: rows[0].codigo, clienteId: rows[0].cliente_id, usado: rows[0].usado, creado: rows[0].creado.toISOString() };
}

async function confirmarCanje(codigo, empresaId) {
      // Todo en una transacción y con las filas bloqueadas (FOR UPDATE): si
      // el mismo código llega dos veces casi al mismo tiempo (doble toque en
      // "Confirmar entrega", un reintento de red), la segunda petición espera
      // a que termine la primera y entonces lo ve como "ya_usado".
      return conTransaccion(async (tx) => {
              const { rows } = await tx.query(
                        `SELECT k.usado, k.cliente_id, c.empresa_id, c.puntos, e.umbral
                               FROM canjes k
                               JOIN clientes c ON c.id = k.cliente_id
                               JOIN empresas e ON e.id = c.empresa_id
                               WHERE k.codigo = $1
                               FOR UPDATE OF k, c`,
                        [codigo]
                      );
              const canje = rows[0];
              if (!canje) return { ok: false, razon: 'codigo_no_existe' };
              if (canje.usado) return { ok: false, razon: 'ya_usado' };
              // Un negocio solo puede confirmar canjes de SUS propios clientes.
              if (empresaId && canje.empresa_id !== empresaId) {
                        return { ok: false, razon: 'no_pertenece' };
              }
              // El código se generó cuando el cliente sí tenía los puntos,
              // pero pudo quedarse guardado: si entre tanto ya cobró su
              // recompensa (o el negocio subió el umbral), este código ya no
              // alcanza. Antes se confirmaba igual y se entregaba una
              // recompensa "gratis" dejando los puntos en 0.
              if (canje.puntos < canje.umbral) {
                        return { ok: false, razon: 'puntos_insuficientes' };
              }
              await tx.query('UPDATE canjes SET usado = true, usado_el = now() WHERE codigo = $1', [codigo]);
              const { rows: clienteRows } = await tx.query(
                        `UPDATE clientes SET puntos = puntos - $2, actualizado_en = now() WHERE id = $1 RETURNING *`,
                        [canje.cliente_id, canje.umbral]
                      );
              return { ok: true, cliente: filaACliente(clienteRows[0]) };
      });
}

// ---- estadísticas para las gráficas del panel de super-admin ----

// Mapa cerrado de periodos permitidos -> unidad de date_trunc de Postgres y
// cuántos "cubos" hacia atrás se muestran. Nunca se mete el periodo que
// manda el cliente directo al SQL (solo se usa para buscar aquí) — así no
// hay forma de inyectar nada por esa vía.
const PERIODOS = {
      dia: { unidad: 'day', pasos: 14 },
      semana: { unidad: 'week', pasos: 12 },
      mes: { unidad: 'month', pasos: 12 },
      anio: { unidad: 'year', pasos: 5 }
};

// Arma una serie de tiempo continua (sin huecos, aunque algún día/semana/mes
// no haya tenido movimiento) para una tabla y columna de fecha dadas, en la
// unidad y cantidad de cubos del periodo pedido.
async function _serieTemporal(unidad, pasos, tabla, columnaFecha, filtroExtra) {
      const sql = `
            SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket, COALESCE(t.total, 0)::int AS total
            FROM generate_series(
                   date_trunc('${unidad}', ${AHORA_LOCAL}) - ((${pasos - 1})::text || ' ${unidad}')::interval,
                   date_trunc('${unidad}', ${AHORA_LOCAL}),
                   ('1 ' || '${unidad}')::interval
                 ) AS b(bucket)
            LEFT JOIN (
                  SELECT date_trunc('${unidad}', ${columnaFecha} AT TIME ZONE '${ZONA_HORARIA}') AS bucket, count(*) AS total
                  FROM ${tabla}
                  ${filtroExtra || ''}
                  GROUP BY 1
            ) t ON t.bucket = b.bucket
            ORDER BY b.bucket ASC`;
      const { rows } = await pool.query(sql);
      return rows;
}

async function estadisticasTemporales(periodoKey) {
      const cfg = PERIODOS[periodoKey] || PERIODOS.mes;
      const periodo = PERIODOS[periodoKey] ? periodoKey : 'mes';
      const { unidad, pasos } = cfg;
      const [negocios, clientes, visitas, canjes] = await Promise.all([
              _serieTemporal(unidad, pasos, 'empresas', 'creado'),
              _serieTemporal(unidad, pasos, 'clientes', 'creado'),
              _serieTemporal(unidad, pasos, 'visitas', 'hora'),
              _serieTemporal(unidad, pasos, 'canjes', 'usado_el', 'WHERE usado = true')
            ]);
      return { periodo, negocios, clientes, visitas, canjes };
}

// Ranking histórico (no depende del periodo elegido): qué negocios tienen
// más clientes registrados en total desde que entraron a la plataforma.
async function topNegociosPorClientes(limite) {
      const n = Math.min(Math.max(Number(limite) || 10, 1), 50);
      const { rows } = await pool.query(
              `SELECT e.id, e.nombre, count(c.id)::int AS total
                     FROM empresas e
                     LEFT JOIN clientes c ON c.empresa_id = e.id
                     GROUP BY e.id, e.nombre
                     ORDER BY total DESC, e.nombre ASC
                     LIMIT $1`,
              [n]
            );
      return rows;
}

// ---- servicio web de Apple Wallet (actualizaciones automáticas del pase) ----
// Ver server.js, rutas /api/apple/v1/... — ahí se explica el protocolo completo.

async function registrarDispositivoPase(deviceLibraryId, passTypeId, clienteId, pushToken) {
      // "ON CONFLICT ... DO UPDATE" en vez de solo "DO NOTHING": si Apple
      // vuelve a mandar el mismo registro con un pushToken distinto (puede
      // pasar si el sistema operativo se lo renueva), se actualiza en vez de
      // quedarse con el viejo y ya no poder avisarle a ese dispositivo.
      await pool.query(
              `INSERT INTO dispositivos_pase (device_library_id, pass_type_id, cliente_id, push_token)
                     VALUES ($1,$2,$3,$4)
                     ON CONFLICT (device_library_id, pass_type_id, cliente_id)
                     DO UPDATE SET push_token = EXCLUDED.push_token`,
              [deviceLibraryId, passTypeId, clienteId, pushToken]
            );
}

async function yaRegistradoDispositivoPase(deviceLibraryId, passTypeId, clienteId) {
      const { rows } = await pool.query(
              `SELECT 1 FROM dispositivos_pase WHERE device_library_id = $1 AND pass_type_id = $2 AND cliente_id = $3`,
              [deviceLibraryId, passTypeId, clienteId]
            );
      return rows.length > 0;
}

async function borrarDispositivoPase(deviceLibraryId, passTypeId, clienteId) {
      const { rows } = await pool.query(
              `DELETE FROM dispositivos_pase WHERE device_library_id = $1 AND pass_type_id = $2 AND cliente_id = $3 RETURNING cliente_id`,
              [deviceLibraryId, passTypeId, clienteId]
            );
      return rows.length > 0;
}

// Series (= ids de cliente) registradas en ESTE dispositivo cuyo pase cambió
// después de "desde" (el "passesUpdatedSince" que manda el iPhone). Si
// "desde" viene vacío, Apple pide TODAS las registradas en este dispositivo.
async function seriesActualizadasParaDispositivo(deviceLibraryId, passTypeId, desde) {
      const { rows } = await pool.query(
              `SELECT c.id, c.actualizado_en FROM dispositivos_pase d
                     JOIN clientes c ON c.id = d.cliente_id
                     WHERE d.device_library_id = $1 AND d.pass_type_id = $2
                           AND ($3::timestamptz IS NULL OR c.actualizado_en > $3::timestamptz)
                     ORDER BY c.actualizado_en ASC`,
              [deviceLibraryId, passTypeId, desde || null]
            );
      return rows;
}

// Todos los push tokens de los dispositivos que tienen guardado el pase de
// este cliente (normalmente uno, pero nada impide que lo haya agregado
// desde más de un iPhone).
async function pushTokensDeCliente(clienteId) {
      const { rows } = await pool.query(
              `SELECT DISTINCT push_token FROM dispositivos_pase WHERE cliente_id = $1`,
              [clienteId]
            );
      return rows.map((r) => r.push_token);
}

// Igual, pero de TODOS los clientes de un negocio — se usa cuando el
// negocio edita su tarjeta (color, logo, recompensa...) y hay que avisarle
// a todos los dispositivos de todos sus clientes a la vez.
async function pushTokensDeEmpresa(empresaId) {
      const { rows } = await pool.query(
              `SELECT DISTINCT d.push_token FROM dispositivos_pase d
                     JOIN clientes c ON c.id = d.cliente_id
                     WHERE c.empresa_id = $1`,
              [empresaId]
            );
      return rows.map((r) => r.push_token);
}

// ---- recordatorio a clientes inactivos ----
// Solo clientes con un contacto que se ve como correo (no hay forma de
// mandar SMS todavía) y que no han visitado en los últimos "dias" días (o
// nunca han visitado desde que se registraron, si ya pasó ese tiempo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function clientesInactivos(empresaId, dias) {
      const n = Math.min(Math.max(Number(dias) || 14, 1), 365);
      const { rows } = await pool.query(
              `SELECT c.* FROM clientes c
                     WHERE c.empresa_id = $1
                           AND c.contacto ~ '@'
                           -- Alguien que se registró ayer y todavía no vuelve no
                           -- es "inactivo": tiene que llevar registrado al menos
                           -- el mismo tiempo que se pide de inactividad.
                           AND c.creado <= now() - ($2::int * interval '1 day')
                           -- Y no se le escribe otra vez si ya recibió un
                           -- recordatorio en la última semana.
                           AND (c.recordatorio_enviado_en IS NULL OR c.recordatorio_enviado_en < now() - interval '7 days')
                           AND NOT EXISTS (
                                 SELECT 1 FROM visitas v
                                       WHERE v.cliente_id = c.id AND v.fecha > ${HOY} - $2::int
                           )
                     ORDER BY c.creado ASC`,
              [empresaId, n]
            );
      return rows.map(filaACliente).filter((c) => EMAIL_RE.test(c.contacto || ''));
}

async function marcarRecordatorioEnviado(clienteId) {
      await pool.query('UPDATE clientes SET recordatorio_enviado_en = now() WHERE id = $1', [clienteId]);
}

// ---- respaldo mensual (ver scripts/respaldo-mensual.js) ----
// Vuelca TODAS las filas de TODAS las tablas a un objeto plano. No usa
// pg_dump (ese programa no viene instalado en un servicio normal de
// Render) — es un respaldo "lógico" hecho con las mismas consultas que ya
// usa el resto del backend, así que no depende de nada aparte de "pg".
// No incluye password_hash de empresas ni codigo_hash de password_resets:
// un respaldo no necesita esos datos para ser útil, y así, si el archivo
// llegara a filtrarse, no expone contraseñas.
async function exportarTodo() {
      const [empresas, clientes, visitas, canjes, dispositivos] = await Promise.all([
              pool.query('SELECT id, nombre, email, logo_url, color, color_boton, fuente, sello_forma, sello_tamano, slug, recompensa, umbral, activa, aprobada, stripe_customer_id, stripe_subscription_id, suscripcion_estado, terminos_aceptados_en, terminos_version, prueba_hasta, creado FROM empresas ORDER BY creado'),
              pool.query('SELECT id, empresa_id, nombre, contacto, puntos, google_object_id, consentimiento, creado, actualizado_en FROM clientes ORDER BY creado'),
              pool.query('SELECT id, cliente_id, fecha, hora FROM visitas ORDER BY hora'),
              pool.query('SELECT codigo, cliente_id, usado, creado, usado_el FROM canjes ORDER BY creado'),
              pool.query('SELECT device_library_id, pass_type_id, cliente_id, creado FROM dispositivos_pase ORDER BY creado')
      ]);
      return {
              generadoEl: new Date().toISOString(),
              empresas: empresas.rows,
              clientes: clientes.rows,
              visitas: visitas.rows,
              canjes: canjes.rows,
              dispositivosPase: dispositivos.rows
      };
}

// Denegar una solicitud de suscripción (o quitar un negocio por completo):
// borra la empresa, y por las referencias ON DELETE CASCADE se van con ella
// sus clientes, visitas, canjes y códigos de recuperación — pensado para
// solicitudes nuevas que todavía no tienen nada registrado.
async function eliminarEmpresa(id) {
      const { rows } = await pool.query('DELETE FROM empresas WHERE id = $1 RETURNING id', [id]);
      return rows.length > 0;
}

// ---- Stripe (cobro automático de la suscripción mensual) ----

// La primera vez que una empresa paga, Stripe nos da un "customer id" nuevo
// — lo guardamos para poder reconocer a esa empresa en cada webhook futuro
// (los webhooks de Stripe solo traen ids de Stripe, nunca el id de ARGAYES).
async function guardarStripeCustomerId(empresaId, stripeCustomerId) {
      const { rows } = await pool.query(
              'UPDATE empresas SET stripe_customer_id = $2 WHERE id = $1 RETURNING *',
              [empresaId, stripeCustomerId]
            );
      return filaAEmpresa(rows[0]);
}

// Esto es lo que de verdad activa/desactiva el acceso al panel según el
// estado real de la suscripción en Stripe (reemplaza el toggle manual que
// antes solo movía ARGAYES a mano tras una transferencia bancaria). Se
// llama desde el webhook cada vez que Stripe avisa que algo cambió.
// "eventoTs" es el "created" (segundos unix) del evento de Stripe que
// disparó esta sincronización. La condición "suscripcion_evento_ts IS NULL
// OR $5 >= suscripcion_evento_ts" hace que un webhook viejo que llega
// tarde (reintento de Stripe, o solo llegó fuera de orden) nunca pueda
// pisar un estado más nuevo que ya se guardó — se ignora en silencio en
// vez de regresar la suscripción a un estado pasado.
async function sincronizarSuscripcion(stripeCustomerId, { subscriptionId, estado, activa, eventoTs }) {
      const { rows } = await pool.query(
              `UPDATE empresas
                     SET stripe_subscription_id = $2, suscripcion_estado = $3, activa = $4, aprobada = true,
                         suscripcion_evento_ts = COALESCE($5::bigint, suscripcion_evento_ts)
                     WHERE stripe_customer_id = $1
                       -- Los "::bigint" son obligatorios: sin ellos Postgres
                       -- rechaza la consulta entera ("could not determine data
                       -- type of parameter $5") y NINGÚN aviso de suscripción
                       -- de Stripe se guardaba.
                       AND (suscripcion_evento_ts IS NULL OR $5::bigint IS NULL OR $5::bigint >= suscripcion_evento_ts)
                     RETURNING *`,
              [stripeCustomerId, subscriptionId || null, estado || null, activa, eventoTs || null]
            );
      return filaAEmpresa(rows[0]);
}

async function obtenerEmpresaPorStripeCustomer(stripeCustomerId) {
      const { rows } = await pool.query('SELECT * FROM empresas WHERE stripe_customer_id = $1', [stripeCustomerId]);
      return filaAEmpresa(rows[0]);
}

module.exports = {
      init,
      crearEmpresa,
      obtenerEmpresa,
      obtenerEmpresaPorEmail,
      obtenerEmpresaPorSlug,
      obtenerEmpresaPorIdOSlug,
      validarLogin,
      actualizarEmpresa,
      listarEmpresas,
      setActivaEmpresa,
      pruebaVencida,
      leerAjusteAdmin,
      guardarAjusteAdmin,
      borrarAjusteAdmin,
      eliminarEmpresa,
      guardarStripeCustomerId,
      sincronizarSuscripcion,
      obtenerEmpresaPorStripeCustomer,
      clientesDeEmpresa,
      estadisticasDeEmpresa,
      insightsDeEmpresa,
      estadisticasAvanzadasDeEmpresa,
      visitasPorSemanaDeEmpresa,
      crearCliente,
      obtenerCliente,
      actualizarCliente,
      eliminarCliente,
      yaVisitoHoy,
      registrarVisita,
      crearCanje,
      confirmarCanje,
      crearSolicitudReset,
      validarYConsumirReset,
      actualizarPasswordEmpresa,
      estadisticasTemporales,
      topNegociosPorClientes,
      registrarDispositivoPase,
      yaRegistradoDispositivoPase,
      borrarDispositivoPase,
      seriesActualizadasParaDispositivo,
      pushTokensDeCliente,
      pushTokensDeEmpresa,
      clientesInactivos,
      marcarRecordatorioEnviado,
      exportarTodo,
      textoValido,
      normalizarContacto,
      clientesConGoogleWallet,
      marcarGoogleWallet,
      emailValido,
      ZONA_HORARIA
};
