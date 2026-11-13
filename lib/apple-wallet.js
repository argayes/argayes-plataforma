// Firma y arma el archivo .pkpass del cliente usando passkit-generator.
// Necesita los certificados del Paso 3 (Apple Developer) dentro de /certs
// y una plantilla base en /pass-model (ver ese folder y el README).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http2 = require('http2');
const { PKPass } = require('passkit-generator');
const JSZip = require('jszip');

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

// ---- diagnóstico temporal: por qué el pase trae imágenes que no son las
// que están en /pass-model (el "rombo feo") ----
// Compara, archivo por archivo: (a) lo que hay en disco en /pass-model,
// contra (b) lo que passkit-generator realmente metió dentro del .pkpass ya
// firmado (abriendo el zip resultante con JSZip). Si no coinciden, el
// problema está DENTRO de passkit-generator (o de cómo lo estamos llamando),
// no en nuestros archivos ni en el despliegue de Render.
async function diagnosticoModelo(empresaDePrueba, clienteDePrueba) {
  const carpeta = path.join(__dirname, '..', 'pass-model');
  const enDisco = {};
  for (const nombre of fs.readdirSync(carpeta)) {
    const buf = fs.readFileSync(path.join(carpeta, nombre));
    enDisco[nombre] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
  }

  let enPkpass = null;
  let error = null;
  try {
    const buffer = await generarPkpass(empresaDePrueba, clienteDePrueba);
    const zip = await JSZip.loadAsync(buffer);
    enPkpass = {};
    for (const nombre of Object.keys(zip.files)) {
      if (zip.files[nombre].dir) continue;
      const buf = await zip.files[nombre].async('nodebuffer');
      enPkpass[nombre] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
    }
    if (enPkpass['manifest.json']) {
      enPkpass['manifest.json'].contenido = (await zip.files['manifest.json'].async('nodebuffer')).toString('utf8');
    }
    if (enPkpass['pass.json']) {
      enPkpass['pass.json'].contenido = (await zip.files['pass.json'].async('nodebuffer')).toString('utf8');
    }
  } catch (e) {
    error = e.message;
  }

  // ¿passkit-generator trae sus propios icon.png/logo.png de ejemplo
  // empaquetados (de sus tests/docs) y por alguna razón los está usando en
  // vez de los nuestros? Buscamos cualquier archivo con esos nombres dentro
  // de TODO su paquete instalado, y la versión real que quedó instalada.
  let dentroDelPaquete = null;
  try {
    // La "exports" moderna de passkit-generator no deja pedir su
    // package.json directo — subimos desde su archivo principal hasta
    // encontrar la carpeta que sí lo tiene.
    let pkgDir = path.dirname(require.resolve('passkit-generator'));
    while (!fs.existsSync(path.join(pkgDir, 'package.json')) && pkgDir !== path.dirname(pkgDir)) {
      pkgDir = path.dirname(pkgDir);
    }
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const encontrados = [];
    const recorrer = (dir, profundidad) => {
      if (profundidad > 6) return;
      for (const nombre of fs.readdirSync(dir)) {
        if (nombre === 'node_modules') continue;
        const completo = path.join(dir, nombre);
        let st;
        try { st = fs.statSync(completo); } catch (e) { continue; }
        if (st.isDirectory()) { recorrer(completo, profundidad + 1); continue; }
        if (/^(icon|logo|strip|thumbnail|background|footer)(@[23]x)?\.png$/i.test(nombre)) {
          encontrados.push({ ruta: completo.replace(pkgDir, '.'), bytes: st.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(completo)).digest('hex').slice(0, 16) });
        }
      }
    };
    recorrer(pkgDir, 0);
    dentroDelPaquete = { version: pkgJson.version, pkgDir, imagenesEncontradas: encontrados };
  } catch (e) {
    dentroDelPaquete = { error: e.message };
  }

  return { enDisco, enPkpass, error, pathUsado: carpeta, dentroDelPaquete };
}

module.exports = { generarPkpass, certificadosListos, avisarActualizacion, diagnosticoModelo };
