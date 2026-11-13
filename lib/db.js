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
const SELLO_FORMAS_VALIDAS = ['circulo', 'estrella', 'corazon', 'cuadrado'];
const SELLO_TAMANOS_VALIDOS = ['pequeno', 'mediano', 'grande'];
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function colorValido(valor, porDefecto) {
      return (typeof valor === 'string' && HEX_COLOR_RE.test(valor.trim())) ? valor.trim() : porDefecto;
}
function opcionValida(valor, opciones, porDefecto) {
      return (typeof valor === 'string' && opciones.includes(valor)) ? valor : porDefecto;
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
      try {
              const { rows } = await pool.query(
                        `INSERT INTO empresas (id, nombre, email, password_hash, logo_url, color, color_boton, fuente, sello_forma, sello_tamano, recompensa, umbral, activa, aprobada)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
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
                                    aprobada
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
      for (const campo of ['nombre', 'color', 'colorBoton', 'fuente', 'selloForma', 'selloTamano', 'recompensa', 'umbral', 'logoUrl']) {
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
              logoUrl: 'logo_url'
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
              }
              if (invalido) {
                        const mensajes = {
                                    umbral: 'El umbral de puntos debe ser un número entero entre 1 y 20',
                                    color: 'El color de la tarjeta debe ser un color hexadecimal válido (ej. #b8872b)',
                                    colorBoton: 'El color de los botones debe ser un color hexadecimal válido (ej. #1b1f23)',
                                    fuente: 'Esa tipografía no está en la lista de opciones disponibles',
                                    selloForma: 'Esa forma de sello no está en la lista de opciones disponibles',
                                    selloTamano: 'Ese tamaño de sello no está en la lista de opciones disponibles'
                        };
                        const error = new Error(mensajes[campo] || 'Dato inválido');
                        error.datosInvalidos = true;
                        throw error;
              }
              valores.push(valorFinal);
              sets.push(`${columnas[campo]} = $${valores.length}`);
      }
      if (sets.length === 0) return obtenerEmpresa(id);
      const { rows } = await pool.query(
              `UPDATE empresas SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
              valores
            );
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
                        `INSERT INTO clientes (id, empresa_id, nombre, contacto, puntos)
                               VALUES ($1,$2,$3,$4,0) RETURNING *`,
                        [id, data.empresaId, data.nombre, contacto]
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
              `UPDATE clientes SET puntos = puntos + 1 WHERE id = $1 RETURNING *`,
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
              `UPDATE clientes SET puntos = GREATEST(0, puntos - $2) WHERE id = $1 RETURNING *`,
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
      validarLogin,
      actualizarEmpresa,
      listarEmpresas,
      setActivaEmpresa,
      eliminarEmpresa,
      clientesDeEmpresa,
      estadisticasDeEmpresa,
      crearCliente,
      obtenerCliente,
      actualizarCliente,
      yaVisitoHoy,
      registrarVisita,
      crearCanje,
      confirmarCanje,
      crearSolicitudReset,
      validarYConsumirReset,
      actualizarPasswordEmpresa,
      estadisticasTemporales,
      topNegociosPorClientes
};
