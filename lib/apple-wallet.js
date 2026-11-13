// Firma y arma el archivo .pkpass del cliente usando passkit-generator.
// Necesita los certificados del Paso 3 (Apple Developer) dentro de /certs
// y una plantilla base en /pass-model (ver ese folder y el README).
const path = require('path');
const fs = require('fs');
const http2 = require('http2');
const { PKPass } = require('passkit-generator');

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
                model: path.join(__dirname, '..', 'pass-model'),
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
                webServiceURL: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/api/apple` : undefined,
                authenticationToken: cliente.id
      }
        );

  pass.type = 'storeCard';
      pass.primaryFields.push({ key: 'puntos', label: 'PUNTOS', value: cliente.puntos });
      pass.secondaryFields.push({ key: 'cliente', label: 'CLIENTE', value: cliente.nombre });
      // La recompensa es lo que hace que el pase sirva de algo de un vistazo
      // (antes solo traía puntos y nombre, sin decir para qué son los puntos).
      if (empresa.recompensa) {
            pass.auxiliaryFields.push({ key: 'recompensa', label: 'RECOMPENSA', value: empresa.recompensa });
      }
      pass.setBarcodes({ message: cliente.id, format: 'PKBarcodeFormatQR' });

  return pass.getAsBuffer();
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
