// Códigos de 6 dígitos que cambian cada 30 segundos (TOTP, RFC 6238): los
// mismos que generan Google Authenticator, Microsoft Authenticator, Authy,
// 1Password, etc. Se usan como segundo paso para entrar al super-admin:
// aunque alguien consiga la clave, sin el teléfono del dueño no entra.
// Implementado con "crypto" de Node, sin dependencias.
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
      let bits = 0;
      let valor = 0;
      let out = '';
      for (const byte of buf) {
              valor = (valor << 8) | byte;
              bits += 8;
              while (bits >= 5) {
                      out += ALFABETO[(valor >>> (bits - 5)) & 31];
                      bits -= 5;
              }
      }
      if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
      return out;
}

function desdeBase32(texto) {
      const limpio = String(texto || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
      let bits = 0;
      let valor = 0;
      const out = [];
      for (const c of limpio) {
              valor = (valor << 5) | ALFABETO.indexOf(c);
              bits += 5;
              if (bits >= 8) {
                      out.push((valor >>> (bits - 8)) & 255);
                      bits -= 8;
              }
      }
      return Buffer.from(out);
}

function generarSecreto() {
      return base32(crypto.randomBytes(20));
}

function codigoEn(secreto, contador) {
      const msg = Buffer.alloc(8);
      msg.writeBigUInt64BE(BigInt(contador));
      const h = crypto.createHmac('sha1', desdeBase32(secreto)).update(msg).digest();
      const o = h[h.length - 1] & 0xf;
      const num = (h.readUInt32BE(o) & 0x7fffffff) % 1000000;
      return String(num).padStart(6, '0');
}

// Devuelve el "contador" (ventana de 30 s) en que el código es válido, o
// null. Acepta hasta 2.5 minutos de diferencia (5 ventanas antes o
// después): en producción el teléfono del dueño iba ~1.5 min adelantado
// respecto al servidor. Sigue siendo seguro: un código de 6 dígitos con
// intentos limitados no se puede adivinar en esa ventana. "ultimoUsado" evita que el mismo código
// se pueda usar dos veces (si alguien lo ve por encima del hombro).
function verificar(secreto, codigo, ultimoUsado) {
      const limpio = String(codigo || '').replace(/\s/g, '');
      if (!/^\d{6}$/.test(limpio) || !secreto) return null;
      const ahora = Math.floor(Date.now() / 30000);
      for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]) {
              const c = ahora + d;
              if (ultimoUsado != null && c <= ultimoUsado) continue;
              const esperado = codigoEn(secreto, c);
              if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(limpio))) return c;
      }
      return null;
}

function urlOtpauth(secreto, cuenta) {
      const emisor = 'ARGAYES';
      return `otpauth://totp/${encodeURIComponent(emisor + ':' + cuenta)}?secret=${secreto}&issuer=${emisor}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generarSecreto, verificar, urlOtpauth, codigoEn };
