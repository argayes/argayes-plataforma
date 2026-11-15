// Firma y arma el archivo .pkpass del cliente usando passkit-generator.
// Necesita los certificados del Paso 3 (Apple Developer) dentro de /certs
// y una plantilla base en /pass-model.pass (ver ese folder y el README).
//
// IMPORTANTE: el folder de plantilla DEBE llamarse "<algo>.pass" — sin esa
// extensión, passkit-generator no avisa con un error claro: en vez de leer
// nuestras imágenes, usa en silencio un folder viejo que ya traía el
// proyecto desde el import original ("pass-model.pass", con imágenes de
// relleno en forma de rombo y sin "storeCard" en su pass.json). Así nació
// el bug del "rombo feo": nuestro código apuntaba a "pass-model" (sin
// ".pass"), así que SIEMPRE se armó el pase con ese folder de relleno, sin
// importar qué tan seguido actualizáramos los archivos reales.
const path = require('path');
const fs = require('fs');
const http2 = require('http2');
const { PKPass } = require('passkit-generator');
const { franjaDeSellos, logoPngDe } = require('./sellos-png');

function certificadosListos() {
      return (
              process.env.APPLE_WWDR_PATH &&
              process.env.APPLE_SIGNER_CERT_PATH &&
              process.env.APPLE_SIGNER_KEY_PATH &&
              fs.existsSync(process.env.APPLE_WWDR_PATH) &&
              fs.existsSync(process.env.APPLE_SIGNER_CERT_PATH) &&
              fs.existsSync(process.env.APPLE_SIGNER_KEY_PATH)
            );
}

async function generarPkpass(empresa, cliente) {
      if (!certificadosListos()) {
              throw new Error(
                        'Faltan los certificados de Apple en /certs (wwdr.pem, signerCert.pem, signerKey.pem). Ver README, Paso 3.'
                      );
      }

  const pass = await PKPass.from(
      {
                model: path.join(__dirname, '..', 'pass-model.pass'),
                certificates: {
                            wwdr: fs.readFileSync(process.env.APPLE_WWDR_PATH),
                            signerCert: fs.readFileSync(process.env.APPLE_SIGNER_CERT_PATH),
                            signerKey: fs.readFileSync(process.env.APPLE_SIGNER_KEY_PATH),
                            signerKeyPassphrase: process.env.APPLE_SIGNER_KEY_PASSPHRASE || undefined
                }
      },
      {
                serialNumber: cliente.id,
                description: `${empresa.nombre} — Lealtad`,
                organizationName: empresa.nombre,
                // Nombre de la empresa dueña de este pase (NO "ARGAYES" — cada negocio
                // que usa la plataforma ve su propio nombre aquí). Va aquí, dentro de
                // las propiedades que recibe PKPass.from(), porque pass.logoText = ...
                // después de creado el pase NO funciona en esta librería.
                logoText: empresa.nombre,
                teamIdentifier: process.env.APPLE_TEAM_ID,
                passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
                backgroundColor: hexToRgb(empresa.color || '#b8872b'),
                // El color del texto se elige según el fondo: sobre un color
                // claro (amarillo, rosa pastel, blanco...) el texto blanco de
                // antes no se alcanzaba a leer.
                foregroundColor: fondoEsClaro(empresa.color || '#b8872b') ? 'rgb(27, 31, 35)' : 'rgb(255, 255, 255)',
                labelColor: fondoEsClaro(empresa.color || '#b8872b') ? 'rgb(70, 74, 79)' : 'rgb(235, 235, 235)',
                webServiceURL: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/api/apple` : undefined,
                authenticationToken: cliente.id
      }
        );

  pass.type = 'storeCard';

      // La tarjeta es DEL NEGOCIO: arriba va su logo (si subió uno) y su
      // nombre — nada de "ARGAYES" en grande. Sin logo, el nombre se queda
      // con todo el ancho del encabezado y los nombres largos ya no se cortan
      // tan pronto con "...".
      const logo = logoPngDe(empresa.logoUrl);
      if (logo) {
            pass.addBuffer('logo.png', logo);
            pass.addBuffer('logo@2x.png', logo);
      }

      // Los sellos dibujados, con la forma y los colores del negocio (antes
      // solo se veía un número, "0 PUNTOS").
      const umbral = Math.min(20, Math.max(1, Number(empresa.umbral) || 10));
      const puntos = Math.max(0, Number(cliente.puntos) || 0);
      const datosFranja = { color: empresa.color, selloForma: empresa.selloForma, selloTamano: empresa.selloTamano, umbral, puntos };
      pass.addBuffer('strip.png', franjaDeSellos(datosFranja, 1));
      pass.addBuffer('strip@2x.png', franjaDeSellos(datosFranja, 2));
      pass.addBuffer('strip@3x.png', franjaDeSellos(datosFranja, 3));

      // "changeMessage" hace que, cuando el negocio le suma un sello, el
      // iPhone del cliente muestre una notificación ("Ya llevas 4/10 sellos").
      pass.headerFields.push({
            key: 'sellos',
            label: 'SELLOS',
            value: `${Math.min(puntos, umbral)}/${umbral}`,
            changeMessage: 'Ya llevas %@ sellos en ' + empresa.nombre
      });
      pass.secondaryFields.push({ key: 'cliente', label: 'CLIENTE', value: cliente.nombre });
      if (empresa.recompensa) {
            pass.secondaryFields.push({ key: 'recompensa', label: 'RECOMPENSA', value: empresa.recompensa, textAlignment: 'PKTextAlignmentRight' });
      }
      const faltan = umbral - puntos;
      pass.auxiliaryFields.push({
            key: 'estado',
            label: faltan <= 0 ? '¡LISTO!' : 'TE FALTAN',
            value: faltan <= 0 ? 'Pide tu recompensa en caja' : (faltan === 1 ? '1 sello' : `${faltan} sellos`),
            changeMessage: '%@'
      });

      // Reverso de la tarjeta (botón "..."): el nombre completo del negocio,
      // por si en el frente se tuvo que recortar, y cómo funciona.
      pass.backFields.push({ key: 'negocio', label: 'NEGOCIO', value: empresa.nombre });
      pass.backFields.push({
            key: 'como',
            label: 'CÓMO FUNCIONA',
            value: `Muestra el código QR en cada visita para sumar un sello. Al juntar ${umbral} sellos ganas: ${empresa.recompensa || 'tu recompensa'}. La tarjeta se actualiza sola.`
      });
      pass.backFields.push({ key: 'plataforma', label: 'TARJETA DIGITAL', value: 'Tarjeta de lealtad por ARGAYES · argayes.com' });
      pass.setBarcodes({ message: cliente.id, format: 'PKBarcodeFormatQR' });

  return pass.getAsBuffer();
}

// Luminancia aproximada del color de fondo (0 = negro, 1 = blanco).
function fondoEsClaro(hex) {
      const h = String(hex).replace('#', '');
      const r = parseInt(h.substring(0, 2), 16) || 0;
      const g = parseInt(h.substring(2, 4), 16) || 0;
      const b = parseInt(h.substring(4, 6), 16) || 0;
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}

function hexToRgb(hex) {
      const h = hex.replace('#', '');
      const r = parseInt(h.substring(0, 2), 16);
      const g = parseInt(h.substring(2, 4), 16);
      const b = parseInt(h.substring(4, 6), 16);
      return `rgb(${r}, ${g}, ${b})`;
}

// ---- avisarle a Apple que el pase de un cliente cambió ----
// Esto es lo que hace que el pase YA GUARDADO en el iPhone de un cliente se
// actualice solo, sin que tenga que volver a escanear nada: se le manda a
// Apple un "push silencioso" (sin texto, sin notificación visible) al
// pushToken que el propio iPhone registró con nosotros (ver server.js,
// /api/apple/v1/devices/...). Apple es quien, al recibirlo, le dice al
// iPhone "vuelve a pedirle ese pase al servidor" — nosotros nunca hablamos
// directo con el iPhone del cliente.
//
// Usa LOS MISMOS certificados que ya firman el .pkpass (el certificado del
// Pass Type ID sirve para las dos cosas) — no hace falta contratar ni
// configurar nada aparte de lo que ya pide el README, Paso 3.
async function enviarPushAUnDispositivo(pushToken) {
      const session = http2.connect('https://api.push.apple.com:443', {
              cert: fs.readFileSync(process.env.APPLE_SIGNER_CERT_PATH),
              key: fs.readFileSync(process.env.APPLE_SIGNER_KEY_PATH),
              passphrase: process.env.APPLE_SIGNER_KEY_PASSPHRASE || undefined
      });
      return new Promise((resolve) => {
              session.on('error', () => resolve(false));
              // Si Apple no contesta en 10 segundos se suelta la conexión —
              // sin esto, una conexión colgada se quedaba abierta para siempre.
              session.setTimeout(10000, () => { session.destroy(); resolve(false); });
              const req = session.request({
                      ':method': 'POST',
                      ':path': `/3/device/${pushToken}`,
                      'apns-topic': process.env.APPLE_PASS_TYPE_ID,
                      'apns-push-type': 'background'
              });
              req.setEncoding('utf8');
              let status = null;
              req.on('response', (headers) => { status = headers[':status']; });
              req.on('end', () => { session.close(); resolve(status === 200); });
              req.on('error', () => { session.close(); resolve(false); });
              // Payload vacío: un pase "silencioso" lleva {} como cuerpo — no es
              // una notificación visible, solo la señal de "revisa tus pases".
              req.end(JSON.stringify({}));
      });
}

// Le manda el aviso a VARIOS dispositivos a la vez (todos los que tengan
// guardado el pase de un cliente, o de todos los clientes de un negocio
// cuando se edita la tarjeta) y nunca truena el flujo principal aunque
// Apple esté caído o falten certificados — es un "mejor esfuerzo": si no
// se pudo avisar ahorita, el pase se corrige solo la próxima vez que el
// iPhone pregunte por su cuenta (cada tanto, lo hace solo).
async function avisarActualizacion(pushTokens) {
      if (!certificadosListos() || !pushTokens || pushTokens.length === 0) return;
      await Promise.all(pushTokens.map((t) => enviarPushAUnDispositivo(t).catch(() => false)));
}

module.exports = { generarPkpass, certificadosListos, avisarActualizacion };
