// Genera el link "Guardar en Google Wallet" sin necesidad de llamar antes a
// la API para crear la clase/objeto: se firma un JWT que trae la definición
// de la tarjeta adentro, y Google la crea en automático cuando el cliente
// toca "Guardar". Para actualizar el saldo después (Paso 8 de la guía), eso
// sí usa la API con el access token del service account (ver patchPuntos).
const jwt = require('jsonwebtoken');

// Google exige imágenes con URL pública HTTPS (no admite base64). El logo
// del negocio y la franja de sellos los genera este mismo backend en
// /api/wallet/google-img/... (ver server.js). Cada URL lleva una "versión"
// (huella del diseño): Google guarda las imágenes en caché por URL, así que
// cuando el negocio cambia su color, logo o sellos, la URL cambia y Google
// descarga la nueva.
const crypto = require('crypto');
const BASE_URL = (process.env.PUBLIC_URL || 'https://argayes-backend.onrender.com').replace(/\/$/, '');

function huella(...partes) {
  return crypto.createHash('sha1').update(partes.map((p) => String(p == null ? '' : p)).join('|')).digest('hex').slice(0, 12);
}
function umbralDe(empresa) {
  return Math.min(20, Math.max(1, Number(empresa.umbral) || 10));
}
function urlLogo(empresa) {
  return `${BASE_URL}/api/wallet/google-img/logo/${empresa.id}/${huella(empresa.logoUrl, empresa.color, empresa.selloForma)}.png`;
}
function urlSellos(empresa, puntos) {
  const umbral = umbralDe(empresa);
  const llenos = Math.min(umbral, Math.max(0, Number(puntos) || 0));
  return `${BASE_URL}/api/wallet/google-img/sellos/${empresa.id}/${llenos}/${huella(empresa.color, empresa.selloForma, empresa.selloTamano, umbral)}.png`;
}

function credenciales() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  // Puede ser la ruta a un archivo .json o el JSON pegado directo en la env var.
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    return JSON.parse(require('fs').readFileSync(raw, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Cada negocio tiene SU PROPIA clase (su nombre, color, logo y recompensa).
// Antes todos compartían una sola ("argayes_lealtad"): la clase la definía
// el primer negocio que guardó un pase, y cada vez que CUALQUIER negocio
// editaba su tarjeta se sobreescribía para todos — los clientes de un
// negocio terminaban viendo en su Google Wallet el nombre, el color y la
// recompensa de otro. (Los pases guardados antes de este cambio siguen
// ligados a la clase vieja; los nuevos ya salen con la de su negocio.)
function claseId(issuerId, empresa) {
  return `${issuerId}.argayes_${empresa.id}`;
}

function objetoId(issuerId, clienteId) {
  return `${issuerId}.cliente_${clienteId}`;
}

// La tarjeta copia el diseño del panel del negocio: su nombre arriba, su
// logo, su color de fondo, "SELLOS 3/10", la franja con sus sellos (forma o
// emoji, y el tamaño que eligió), la recompensa, el nombre del cliente y el
// QR. Nada de la marca ARGAYES al frente: el protagonista es el negocio.
function construirLoyaltyClass(issuerId, empresa) {
  return {
    id: claseId(issuerId, empresa),
    issuerName: empresa.nombre,
    programName: empresa.nombre,
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: /^#[0-9a-fA-F]{6}$/.test(empresa.color || '') ? empresa.color : '#b8872b',
    programLogo: {
      sourceUri: { uri: urlLogo(empresa) },
      contentDescription: { defaultValue: { language: 'es', value: `Logo de ${empresa.nombre}` } }
    }
  };
}

// Lo que cambia por cliente (sus sellos) va en el OBJETO.
function camposDelCliente(empresa, cliente) {
  const umbral = umbralDe(empresa);
  const llenos = Math.min(umbral, Math.max(0, Number(cliente.puntos) || 0));
  const campos = {
    loyaltyPoints: { label: 'SELLOS', balance: { string: `${llenos}/${umbral}` } },
    heroImage: {
      sourceUri: { uri: urlSellos(empresa, cliente.puntos) },
      contentDescription: { defaultValue: { language: 'es', value: `${llenos} de ${umbral} sellos` } }
    }
  };
  if (empresa.recompensa) {
    campos.secondaryLoyaltyPoints = { label: 'RECOMPENSA', balance: { string: String(empresa.recompensa).slice(0, 60) } };
  }
  return campos;
}

function construirLoyaltyObject(issuerId, empresa, cliente) {
  return {
    id: objetoId(issuerId, cliente.id),
    classId: claseId(issuerId, empresa),
    state: 'ACTIVE',
    accountName: cliente.nombre,
    accountId: cliente.id,
    ...camposDelCliente(empresa, cliente),
    barcode: {
      type: 'QR_CODE',
      value: cliente.id
    }
  };
}

// Devuelve el link https://pay.google.com/gp/v/save/<jwt> listo para abrir
// o meter dentro de un QR.
function generarSaveUrl(empresa, cliente) {
  const creds = credenciales();
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  if (!creds || !issuerId) {
    throw new Error(
      'Faltan GOOGLE_SERVICE_ACCOUNT_JSON y/o GOOGLE_ISSUER_ID en las variables de entorno (ver README, Paso 3).'
    );
  }

  const payload = {
    iss: creds.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [],
    payload: {
      loyaltyClasses: [construirLoyaltyClass(issuerId, empresa)],
      loyaltyObjects: [construirLoyaltyObject(issuerId, empresa, cliente)]
    }
  };

  const token = jwt.sign(payload, creds.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// Las llamadas de aquí en adelante sí necesitan la API real de Google
// Wallet (no solo el JWT de "guardar") — piden un access token OAuth2
// del service account. Esto es lo que se repite en patchPuntos y en
// patchClase, así que queda en un solo lugar.
// El access token de Google dura 1 hora: se guarda y se reutiliza en vez de
// pedir uno nuevo en CADA visita escaneada (era una llamada extra a Google
// por cada sello).
let tokenCache = { valor: null, expira: 0, cuenta: null };
async function tokenDeAcceso(creds) {
  if (tokenCache.valor && tokenCache.cuenta === creds.client_email && Date.now() < tokenCache.expira) {
    return tokenCache.valor;
  }
  const accessTokenJwt = jwt.sign(
    {
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
      aud: 'https://oauth2.googleapis.com/token',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    },
    creds.private_key,
    { algorithm: 'RS256' }
  );

  // Intercambiar el JWT firmado por un access token real de Google (OAuth2).
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: accessTokenJwt
    })
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) return null;
  // Se renueva 5 minutos antes de que venza de verdad.
  const segundos = Number(tokenJson.expires_in) || 3600;
  tokenCache = { valor: tokenJson.access_token, expira: Date.now() + Math.max(60, segundos - 300) * 1000, cuenta: creds.client_email };
  return tokenCache.valor;
}

// Para empujar un saldo nuevo a un pase que el cliente YA guardó (Paso 8).
async function patchPuntos(empresa, cliente) {
  const creds = credenciales();
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  if (!creds || !issuerId) return { ok: false, razon: 'sin_credenciales' };

  const accessToken = await tokenDeAcceso(creds);
  if (!accessToken) return { ok: false, razon: 'oauth_fallo' };

  const patchRes = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objetoId(issuerId, cliente.id)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(camposDelCliente(empresa, cliente))
    }
  );

  return { ok: patchRes.ok, status: patchRes.status };
}

// Cuando el negocio edita su tarjeta en el panel (color, logo, nombre,
// recompensa), esto actualiza la CLASE una sola vez en la API de Google —
// y como todos los pases ya guardados de ese negocio apuntan a la misma
// clase, a todos les llega el cambio solos, sin tocar cliente por cliente.
// Es el equivalente, para Google Wallet, del push silencioso que se le
// manda a los iPhones con Apple Wallet (ver avisarActualizacion).
async function patchClase(empresa) {
  const creds = credenciales();
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  if (!creds || !issuerId) return { ok: false, razon: 'sin_credenciales' };

  const accessToken = await tokenDeAcceso(creds);
  if (!accessToken) return { ok: false, razon: 'oauth_fallo' };

  const patchRes = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${claseId(issuerId, empresa)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(construirLoyaltyClass(issuerId, empresa))
    }
  );

  return { ok: patchRes.ok, status: patchRes.status };
}

// Tras un cambio de diseño, la franja de sellos de cada pase ya guardado
// apunta a una imagen vieja: se actualizan uno por uno (de 4 en 4, sin
// bloquear nada) los clientes que abrieron su link de Google Wallet.
async function patchObjetos(empresa, clientes) {
  let i = 0;
  async function trabajador() {
    while (i < clientes.length) {
      const c = clientes[i++];
      await patchPuntos(empresa, c).catch(() => {});
    }
  }
  await Promise.all([trabajador(), trabajador(), trabajador(), trabajador()]);
}

module.exports = { generarSaveUrl, patchPuntos, patchClase, patchObjetos, objetoId };
