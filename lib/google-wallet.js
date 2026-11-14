// Genera el link "Guardar en Google Wallet" sin necesidad de llamar antes a
// la API para crear la clase/objeto: se firma un JWT que trae la definición
// de la tarjeta adentro, y Google la crea en automático cuando el cliente
// toca "Guardar". Para actualizar el saldo después (Paso 8 de la guía), eso
// sí usa la API con el access token del service account (ver patchPuntos).
const jwt = require('jsonwebtoken');

// Google exige programLogo con una URL pública HTTPS (no admite base64/data:URI).
// El logo que guarda cada empresa en el panel llega como base64, así que por
// ahora se usa un logo genérico de ARGAYES servido por este mismo backend;
// si en el futuro empresa.logoUrl llega a ser una URL http(s) real, se usa esa.
const BASE_URL = process.env.PUBLIC_URL || 'https://argayes-backend.onrender.com';
const LOGO_POR_DEFECTO = `${BASE_URL}/public/logo-argayes.png`;

function logoDe(empresa) {
  if (empresa.logoUrl && /^https?:\/\//i.test(empresa.logoUrl)) return empresa.logoUrl;
  return LOGO_POR_DEFECTO;
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

// La recompensa va en la CLASE (no en cada objeto/cliente) a propósito:
// todos los clientes de un negocio comparten la misma recompensa, y así
// un solo PATCH a la clase (ver patchClase, más abajo) actualiza a TODOS
// los que ya tengan el pase guardado — igual que pasa con Apple Wallet.
function construirLoyaltyClass(issuerId, empresa) {
  const clase = {
    id: claseId(issuerId, empresa),
    issuerName: empresa.nombre,
    programName: `${empresa.nombre} — Lealtad`,
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: empresa.color || '#b8872b',
    programLogo: {
      sourceUri: { uri: logoDe(empresa) },
      contentDescription: { defaultValue: { language: 'es', value: `Logo de ${empresa.nombre}` } }
    }
  };
  // Sin esto, el pase solo decía los puntos que llevas, no para qué son —
  // se veía vacío de valor comparado con la tarjeta personalizada.
  if (empresa.recompensa) {
    clase.textModulesData = [
      { id: 'recompensa', header: 'Recompensa', body: empresa.recompensa }
    ];
  }
  return clase;
}

function construirLoyaltyObject(issuerId, empresa, cliente) {
  return {
    id: objetoId(issuerId, cliente.id),
    classId: claseId(issuerId, empresa),
    state: 'ACTIVE',
    accountName: cliente.nombre,
    accountId: cliente.id,
    loyaltyPoints: {
      label: 'Puntos',
      balance: { int: cliente.puntos }
    },
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
      body: JSON.stringify({ loyaltyPoints: { label: 'Puntos', balance: { int: cliente.puntos } } })
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

module.exports = { generarSaveUrl, patchPuntos, patchClase };
