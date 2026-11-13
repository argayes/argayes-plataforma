// Respaldo mensual de la base de datos de ARGAYES.
//
// Este archivo NO lo corre el backend normal (server.js) — está pensado
// para un "Cron Job" aparte en Render (Render → New → Cron Job), que es un
// tipo de servicio que Render enciende solo, corre un comando una vez, y
// apaga — ideal para algo que debe pasar una vez al mes y nada más.
//
// Qué hace: junta TODAS las filas de TODAS las tablas (ver
// lib/db.js → exportarTodo), las comprime en un .json.gz, y se las manda
// por correo al dueño del negocio vía Resend — el mismo servicio que ya
// usa ARGAYES para el correo de "olvidé mi contraseña". Así el respaldo
// queda guardado donde tú ya revisas (tu correo), sin pagar ni configurar
// ningún servicio de almacenamiento aparte.
//
// Variables de entorno que necesita (configúralas en el Cron Job de
// Render, las dos primeras ya existen en el backend — se pueden copiar
// igual):
//   DATABASE_URL      la misma que usa el backend
//   RESEND_API_KEY    la misma que usa el backend (si no la has
//                     configurado todavía, este script va a fallar con un
//                     error claro explicando qué falta)
//   EMAIL_FROM        opcional, mismo remitente que el backend
//   BACKUP_EMAIL_TO   a qué correo mandar el respaldo cada mes (el tuyo)
//
// Cómo programarlo en Render (una sola vez):
//   1. Dashboard de Render → "New +" → "Cron Job"
//   2. Conecta el mismo repo de GitHub (argayes-plataforma)
//   3. Build Command:  npm install
//      Start Command:  node scripts/respaldo-mensual.js
//   4. Schedule (cron):  0 9 1 * *      (el día 1 de cada mes, 9am UTC)
//   5. En "Environment", agrega las 4 variables de arriba.
// Render se encarga solo de correrlo cada mes desde ahí en adelante.

require('dotenv').config();
const zlib = require('zlib');
const db = require('../lib/db');
const { enviarConAdjunto } = require('../lib/email');

async function main() {
      const destino = process.env.BACKUP_EMAIL_TO;
      if (!destino) {
              throw new Error('Falta BACKUP_EMAIL_TO — configúralo en el Cron Job de Render con el correo donde quieres recibir el respaldo.');
      }

      console.log('Exportando la base de datos...');
      const datos = await db.exportarTodo();
      const json = JSON.stringify(datos, null, 0);
      const comprimido = zlib.gzipSync(Buffer.from(json, 'utf8'));
      console.log(`Respaldo listo: ${datos.empresas.length} negocios, ${datos.clientes.length} clientes, ${(comprimido.length / 1024).toFixed(1)} KB comprimido.`);

      const fecha = new Date().toISOString().slice(0, 10);
      const nombreArchivo = `argayes-respaldo-${fecha}.json.gz`;

      await enviarConAdjunto(
              destino,
              `Respaldo mensual de ARGAYES — ${fecha}`,
              `<p>Adjunto va el respaldo de tu base de datos del ${fecha}.</p>
               <p>Es un archivo <b>.json.gz</b> — contiene todos los negocios, clientes, visitas y canjes
               registrados hasta hoy (sin contraseñas). Guárdalo en algún lugar seguro
               (Google Drive, por ejemplo). Si alguna vez necesitas restaurarlo, pide ayuda
               para hacerlo — no es algo que se deba hacer sin cuidado.</p>`,
              nombreArchivo,
              comprimido.toString('base64')
      );

      console.log(`Respaldo enviado a ${destino}.`);
      process.exit(0);
}

main().catch((e) => {
      console.error('El respaldo mensual falló:', e.message);
      process.exit(1);
});
