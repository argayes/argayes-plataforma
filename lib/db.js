// Base de datos en Postgres (antes era un archivo JSON que Render borraba en
// cada redeploy — ver README). Todas las lecturas/escrituras del backend
// pasan por aquí, igual que antes; lo único que cambió es que ahora viven
// en una base de datos real que no se pierde.
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
});

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
              creado: fila.creado.toISOString()
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
      const [salt, hash] = almacenado.split(':');
      const hashIntento = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashIntento, 'hex'));
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
                        `INSERT INTO empresas (id, nombre, email, password_hash, logo_url, color, color_boton, fuente, sello_forma, sello_tamano, recompensa, umbral, activa, aprobada, slug)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14) RETURNING *`,
                        [
                                    id,
                                    data.nombre,
                                    data.email ? normalizarEmail(data.email) : null,
                                    data.password ? hashPassword(data.password) : null,
                                    data.logoUrl || null,
                                    data.color || '#b8872b',
                                    colorValido(data.colorBoton, '#1b1f23'),
                                    opcionValida(data.fuente, FUENTES_VALIDAS, 'IBM Plex Sans'),
                                    opcionValida(data.selloForma, SELLO_FORMAS_VALIDAS, 'circulo'),
                                    opcionValida(data.selloTamano, SELLO_TAMANOS_VALIDOS, 'mediano'),
                                    data.recompensa || '',
                                    umbralValido(data.umbral, 10),
                                    aprobada,
                                    slug
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
      const { rows } = await pool.query('SELECT * FROM empresas ORDER BY creado DESC');
      return rows.map(filaAEmpresa);
}

async function setActivaEmpresa(id, activa) {
      // Activar (desde el panel de super-admin) siempre cuenta como
      // aprobar: así el mismo botón "Activar"/"Aprobar" sirve tanto para
      // reactivar un negocio que ya conocías como para aprobar una
      // solicitud nueva — en ambos casos el admin decidió que esa cuenta
      // ya puede entrar. Desactivar NO quita la aprobación: un negocio ya
      // aprobado que desactivas (ej. por falta de pago) sigue siendo un
      // negocio conocido, no vuelve a aparecer como "solicitud pendiente".
      const { rows } = await pool.query(
              activa
                ? 'UPDATE empresas SET activa = true, aprobada = true WHERE id = $1 RETURNING *'
                : 'UPDATE empresas SET activa = false WHERE id = $1 RETURNING *',
              [id]
            );
      return filaAEmpresa(rows[0]);
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
                     WHERE empresa_id = $1 AND usado = false AND expira > now()
                           ORDER BY creado DESC`,
              [empresaId]
            );
      for (const fila of rows) {
              if (verificarPassword(codigo, fila.codigo_hash)) {
                        await pool.query('UPDATE password_resets SET usado = true WHERE id = $1', [fila.id]);
                        return true;
              }
      }
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
              }
              if (invalido) {
                        const mensajes = {
                                    umbral: 'El umbral de puntos debe ser un número entero entre 1 y 20',
                                    color: 'El color de la tarjeta debe ser un color hexadecimal válido (ej. #b8872b)',
                                    colorBoton: 'El color de los botones debe ser un color hexadecimal válido (ej. #1b1f23)',
                                    fuente: 'Esa tipografía no está en la lista de opciones disponibles',
                                    selloForma: 'Esa forma de sello no está en la lista de opciones disponibles',
                                    selloTamano: 'Ese tamaño de sello no está en la lista de opciones disponibles',
                                    slug: 'El link debe tener entre 3 y 40 letras/números, sin espacios ni acentos (solo guiones para separar palabras)'
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
              'SELECT * FROM clientes WHERE empresa_id = $1 ORDER BY creado DESC',
              [empresaId]
            );
      return rows.map(filaACliente);
}

async function estadisticasDeEmpresa(empresaId) {
      const { rows: clientesRows } = await pool.query(
              'SELECT * FROM clientes WHERE empresa_id = $1',
              [empresaId]
            );
      const { rows: visitasHoyRows } = await pool.query(
              `SELECT count(*)::int AS n FROM visitas v
                   JOIN clientes c ON c.id = v.cliente_id
                        WHERE c.empresa_id = $1 AND v.fecha = CURRENT_DATE`,
              [empresaId]
            );
      const { rows: canjesRows } = await pool.query(
              `SELECT count(*)::int AS n FROM canjes k
                   JOIN clientes c ON c.id = k.cliente_id
                        WHERE c.empresa_id = $1 AND k.usado = false`,
              [empresaId]
            );
      return {
              totalClientes: clientesRows.length,
              visitasHoy: visitasHoyRows[0].n,
              canjesPendientes: canjesRows[0].n,
              puntosRepartidos: clientesRows.reduce((sum, c) => sum + c.puntos, 0)
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
                              WHERE c.empresa_id = $1 AND v.fecha > CURRENT_DATE - $2::int) AS vinieron_actual,
                       (SELECT count(DISTINCT v.cliente_id)::int FROM visitas v JOIN clientes c ON c.id = v.cliente_id
                              WHERE c.empresa_id = $1
                              AND v.fecha <= CURRENT_DATE - $2::int
                              AND v.fecha > CURRENT_DATE - 2 * $2::int) AS vinieron_anterior
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
                     WHERE p.primera_fecha <= CURRENT_DATE - $2::int
                     AND p.primera_fecha > CURRENT_DATE - 3 * $2::int
               )
               SELECT
                     count(*) FILTER (WHERE primera_fecha > CURRENT_DATE - 2 * $2::int)::int AS elegibles_actual,
                     count(*) FILTER (WHERE primera_fecha > CURRENT_DATE - 2 * $2::int AND regreso)::int AS regresaron_actual,
                     count(*) FILTER (WHERE primera_fecha <= CURRENT_DATE - 2 * $2::int)::int AS elegibles_anterior,
                     count(*) FILTER (WHERE primera_fecha <= CURRENT_DATE - 2 * $2::int AND regreso)::int AS regresaron_anterior
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
                     WHERE c.empresa_id = $1 AND v.fecha > CURRENT_DATE - 2 * $2::int
               )
               SELECT
                     avg(hueco) FILTER (WHERE fecha > CURRENT_DATE - $2::int)::float AS promedio_actual,
                     avg(hueco) FILTER (WHERE fecha <= CURRENT_DATE - $2::int)::float AS promedio_anterior
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
                      date_trunc('week', now()) - ((${pasos - 1})::text || ' week')::interval,
                      date_trunc('week', now()),
                      interval '1 week'
               ) AS b(bucket)
               LEFT JOIN (
                      SELECT date_trunc('week', v.fecha) AS bucket,
                             count(*) FILTER (WHERE v.fecha = pf.primera_fecha)::int AS primeras,
                             count(*) FILTER (WHERE v.fecha <> pf.primera_fecha)::int AS regresan
                      FROM visitas v
                      JOIN clientes c ON c.id = v.cliente_id
                      JOIN (SELECT cliente_id, MIN(fecha) AS primera_fecha FROM visitas GROUP BY cliente_id) pf
                             ON pf.cliente_id = v.cliente_id
                      WHERE c.empresa_id = $1
                      GROUP BY 1
               ) t ON t.bucket = b.bucket
               ORDER BY b.bucket ASC`,
              [empresaId]
            );
      return rows;
}

// ---- clientes ----
async function crearCliente(data) {
      const contacto = (data.contacto || '').trim();
      // Evita duplicados: si ya existe un cliente con el mismo contacto
  // (teléfono o email) para esta misma empresa, se reutiliza ese cliente
  // en vez de crear uno nuevo — así la misma persona no termina con dos
  // tarjetas de lealtad distintas solo por volver a llenar el formulario.
  if (contacto) {
          const { rows } = await pool.query(
                    `SELECT * FROM clientes WHERE empresa_id = $1 AND lower(btrim(contacto)) = lower($2)`,
                    [data.empresaId, contacto]
                  );
          if (rows[0]) return filaACliente(rows[0]);
  }

  const id = crypto.randomUUID();
      try {
              const { rows } = await pool.query(
                        `INSERT INTO clientes (id, empresa_id, nombre, contacto, puntos, consentimiento)
                               VALUES ($1,$2,$3,$4,0,$5) RETURNING *`,
                        [id, data.empresaId, data.nombre, contacto, !!data.consentimiento]
                      );
              return filaACliente(rows[0]);
      } catch (e) {
              // Carrera: dos registros al mismo tiempo con el mismo contacto.
        // El índice único de la base de datos gana; devolvemos el que ya quedó.
        if (e.code === '23505' && contacto) {
                  const { rows } = await pool.query(
                              `SELECT * FROM clientes WHERE empresa_id = $1 AND lower(btrim(contacto)) = lower($2)`,
                              [data.empresaId, contacto]
                            );
                  if (rows[0]) return filaACliente(rows[0]);
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
              `SELECT 1 FROM visitas WHERE cliente_id = $1 AND fecha = CURRENT_DATE LIMIT 1`,
              [clienteId]
            );
      return rows.length > 0;
}

async function registrarVisita(clienteId) {
      const id = crypto.randomUUID();
      try {
              await pool.query(
                        `INSERT INTO visitas (id, cliente_id, fecha) VALUES ($1,$2,CURRENT_DATE)`,
                        [id, clienteId]
                      );
      } catch (e) {
              // "yaVisitoHoy" ya revisa esto antes de llegar aquí, pero esa
              // revisión y este INSERT son dos pasos separados: si otra
              // petición para el mismo cliente se mete justo en medio (dos
              // empleados escaneando a la vez, o un reintento de red), las
              // dos podrían pasar la revisión antes de que cualquiera
              // inserte. El índice único de la tabla es quien de verdad lo
              // evita; aquí solo se traduce ese choque en el mismo error que
              // ya conoce el resto del código, en vez de sumar el punto dos veces.
              if (e.code === '23505') {
                        const error = new Error('Ya se registró una visita hoy para este cliente');
                        error.yaVisito = true;
                        throw error;
              }
              throw e;
      }
      const { rows } = await pool.query(
              `UPDATE clientes SET puntos = puntos + 1, actualizado_en = now() WHERE id = $1 RETURNING *`,
              [clienteId]
            );
      return filaACliente(rows[0]);
}

// ---- canjes (código de un solo uso, distinto al QR del cliente) ----
async function crearCanje(clienteId) {
      const codigo = crypto.randomUUID();
      const { rows } = await pool.query(
              `INSERT INTO canjes (codigo, cliente_id, usado) VALUES ($1,$2,false) RETURNING *`,
              [codigo, clienteId]
            );
      return { codigo: rows[0].codigo, clienteId: rows[0].cliente_id, usado: rows[0].usado, creado: rows[0].creado.toISOString() };
}

async function confirmarCanje(codigo, empresaId) {
      const { rows } = await pool.query('SELECT * FROM canjes WHERE codigo = $1', [codigo]);
      const canje = rows[0];
      if (!canje) return { ok: false, razon: 'codigo_no_existe' };
      if (canje.usado) return { ok: false, razon: 'ya_usado' };

  const cliente = await obtenerCliente(canje.cliente_id);
      if (!cliente) return { ok: false, razon: 'cliente_no_encontrado' };
      // Un negocio solo puede confirmar canjes de SUS propios clientes —
      // sin esto, cualquier negocio con sesión podría confirmar (y restar
      // puntos de) un canje generado por otro negocio si llegara a conocer
      // el código.
      if (empresaId && cliente.empresaId !== empresaId) {
              return { ok: false, razon: 'no_pertenece' };
      }
      const empresa = await obtenerEmpresa(cliente.empresaId);
      const umbral = empresa ? empresa.umbral : 10;

  // "usado = false" va DENTRO del UPDATE (no solo en el "if" de arriba):
  // así, si el mismo código llega dos veces casi al mismo tiempo (doble tap
  // en "Confirmar entrega", o un reintento de red), solo una de las dos
  // peticiones logra marcarlo y restar los puntos — Postgres garantiza que
  // nada más una gane esa carrera. La otra ve 0 filas afectadas y se trata
  // como "ya_usado" en vez de restarle los puntos al cliente dos veces.
  const { rows: marcado } = await pool.query(
          `UPDATE canjes SET usado = true, usado_el = now() WHERE codigo = $1 AND usado = false RETURNING codigo`,
          [codigo]
        );
  if (marcado.length === 0) return { ok: false, razon: 'ya_usado' };

      const { rows: clienteRows } = await pool.query(
              `UPDATE clientes SET puntos = GREATEST(0, puntos - $2), actualizado_en = now() WHERE id = $1 RETURNING *`,
              [canje.cliente_id, umbral]
            );
      return { ok: true, cliente: filaACliente(clienteRows[0]) };
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
                   date_trunc('${unidad}', now()) - ((${pasos - 1})::text || ' ${unidad}')::interval,
                   date_trunc('${unidad}', now()),
                   ('1 ' || '${unidad}')::interval
                 ) AS b(bucket)
            LEFT JOIN (
                  SELECT date_trunc('${unidad}', ${columnaFecha}) AS bucket, count(*) AS total
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
                           AND NOT EXISTS (
                                 SELECT 1 FROM visitas v
                                       WHERE v.cliente_id = c.id AND v.fecha > CURRENT_DATE - ($2 || ' days')::interval
                           )
                     ORDER BY c.creado ASC`,
              [empresaId, n]
            );
      return rows.map(filaACliente).filter((c) => EMAIL_RE.test(c.contacto || ''));
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
              pool.query('SELECT id, nombre, email, logo_url, color, color_boton, fuente, sello_forma, sello_tamano, recompensa, umbral, activa, aprobada, creado FROM empresas ORDER BY creado'),
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
      eliminarEmpresa,
      clientesDeEmpresa,
      estadisticasDeEmpresa,
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
      exportarTodo
};
