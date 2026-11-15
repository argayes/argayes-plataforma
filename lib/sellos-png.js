// Dibuja la franja de sellos ("strip") que va en el pase de Apple Wallet:
// una fila (o dos, si son más de 10) con los sellos que ya juntó el cliente
// llenos y los que le faltan vacíos, con la forma y los colores que eligió
// el negocio. Sin esta imagen, Apple Wallet solo podía mostrar un número
// ("0 PUNTOS"), no la tarjeta de sellos que el negocio diseñó en su panel.
//
// Se genera aquí mismo en PNG, sin librerías nativas (canvas, sharp...),
// para que el despliegue en Render siga siendo un "npm install" simple.
const zlib = require('zlib');

// Tamaños oficiales de la franja de una "storeCard" (Apple Wallet):
// 375×123 puntos, con versiones @2x y @3x para pantallas retina.
const TAMANOS = { 1: [375, 123], 2: [750, 246], 3: [1125, 369] };

// ---------- PNG mínimo (RGBA de 8 bits) ----------
const TABLA_CRC = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
              let c = n;
              for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
              t[n] = c >>> 0;
      }
      return t;
})();
function crc32(buf) {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
}
function bloque(tipo, datos) {
      const largo = Buffer.alloc(4);
      largo.writeUInt32BE(datos.length);
      const tipoYDatos = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(tipoYDatos));
      return Buffer.concat([largo, tipoYDatos, crc]);
}
function codificarPng(ancho, alto, rgba) {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(ancho, 0);
      ihdr.writeUInt32BE(alto, 4);
      ihdr[8] = 8; // bits por canal
      ihdr[9] = 6; // RGBA
      const filas = Buffer.alloc((ancho * 4 + 1) * alto);
      for (let y = 0; y < alto; y++) {
              filas[y * (ancho * 4 + 1)] = 0; // sin filtro
              rgba.copy(filas, y * (ancho * 4 + 1) + 1, y * ancho * 4, (y + 1) * ancho * 4);
      }
      return Buffer.concat([
              Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              bloque('IHDR', ihdr),
              bloque('IDAT', zlib.deflateSync(filas, { level: 9 })),
              bloque('IEND', Buffer.alloc(0))
      ]);
}

// ---------- colores ----------
function hexARgb(hex, porDefecto) {
      const h = /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex.slice(1) : porDefecto.slice(1);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function esClaro([r, g, b]) {
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}

// ---------- formas ----------
// Cada forma responde "¿el punto (x, y) está dentro?" con coordenadas
// normalizadas: el sello ocupa el cuadro de -1 a 1 en ambos ejes.
const ESTRELLA = (() => {
      const puntos = [];
      for (let i = 0; i < 10; i++) {
              const ang = -Math.PI / 2 + (i * Math.PI) / 5;
              const r = i % 2 === 0 ? 1 : 0.44;
              puntos.push([Math.cos(ang) * r, Math.sin(ang) * r + 0.06]);
      }
      return puntos;
})();
function dentroDePoligono(x, y, pts) {
      let dentro = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
              const [xi, yi] = pts[i];
              const [xj, yj] = pts[j];
              if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
      }
      return dentro;
}
const FORMAS = {
      circulo: (x, y) => x * x + y * y <= 1,
      cuadrado: (x, y) => {
              const r = 0.32;
              const ax = Math.abs(x);
              const ay = Math.abs(y);
              if (ax > 1 || ay > 1) return false;
              if (ax <= 1 - r || ay <= 1 - r) return true;
              const dx = ax - (1 - r);
              const dy = ay - (1 - r);
              return dx * dx + dy * dy <= r * r;
      },
      corazon: (x, y) => {
              const hx = x * 1.18;
              const hy = -(y * 1.18) + 0.2;
              const a = hx * hx + hy * hy - 1;
              return a * a * a - hx * hx * hy * hy * hy <= 0;
      },
      estrella: (x, y) => dentroDePoligono(x * 0.86, y * 0.86, ESTRELLA)
};

function formaDe(nombre) {
      return FORMAS[nombre] || FORMAS.circulo;
}

// ---------- sellos con dibujo (emojis) ----------
// Los sellos tipo taco, tijeras, café... se dibujan con imágenes PNG de
// 128×128 que viven en lib/sellos-emoji/<slug>.png (generadas con la
// fuente Noto Color Emoji, licencia OFL). Se cargan una vez y se guardan
// en memoria ya decodificadas.
const path = require('path');
const fs = require('fs');
const CARPETA_EMOJI = path.join(__dirname, 'sellos-emoji');
const cacheEmoji = new Map();

// Decodifica un PNG RGBA de 8 bits sin entrelazar (el formato exacto de
// los archivos de sellos-emoji). Devuelve {ancho, alto, px} o null.
function decodificarPng(buf) {
      if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
      let pos = 8;
      let ancho = 0;
      let alto = 0;
      const idat = [];
      while (pos + 8 <= buf.length) {
              const largo = buf.readUInt32BE(pos);
              const tipo = buf.toString('ascii', pos + 4, pos + 8);
              const datos = buf.subarray(pos + 8, pos + 8 + largo);
              if (tipo === 'IHDR') {
                      ancho = datos.readUInt32BE(0);
                      alto = datos.readUInt32BE(4);
                      if (datos[8] !== 8 || datos[9] !== 6 || datos[12] !== 0) return null;
              } else if (tipo === 'IDAT') idat.push(datos);
              else if (tipo === 'IEND') break;
              pos += 12 + largo;
      }
      if (!ancho || !alto || !idat.length) return null;
      const crudo = zlib.inflateSync(Buffer.concat(idat));
      const bpf = ancho * 4; // bytes por fila
      const px = Buffer.alloc(bpf * alto);
      for (let y = 0; y < alto; y++) {
              const filtro = crudo[y * (bpf + 1)];
              const ini = y * (bpf + 1) + 1;
              for (let x = 0; x < bpf; x++) {
                      const a = x >= 4 ? px[y * bpf + x - 4] : 0;
                      const b = y > 0 ? px[(y - 1) * bpf + x] : 0;
                      const c = x >= 4 && y > 0 ? px[(y - 1) * bpf + x - 4] : 0;
                      let v = crudo[ini + x];
                      if (filtro === 1) v += a;
                      else if (filtro === 2) v += b;
                      else if (filtro === 3) v += (a + b) >> 1;
                      else if (filtro === 4) {
                              const p = a + b - c;
                              const pa = Math.abs(p - a);
                              const pb = Math.abs(p - b);
                              const pc = Math.abs(p - c);
                              v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                      }
                      px[y * bpf + x] = v & 0xff;
              }
      }
      return { ancho, alto, px };
}

function emojiDe(slug) {
      if (!/^[a-z]+$/.test(slug || '')) return null;
      if (cacheEmoji.has(slug)) return cacheEmoji.get(slug);
      let img = null;
      try {
              img = decodificarPng(fs.readFileSync(path.join(CARPETA_EMOJI, slug + '.png')));
      } catch (e) {
              img = null;
      }
      cacheEmoji.set(slug, img);
      return img;
}

// Pinta un emoji centrado en (cx, cy). Lleno = a todo color; vacío = gris
// y transparente, igual que se ve en el panel y en la tarjeta web.
function pintarEmoji(px, ancho, alto, cx, cy, radio, img, lleno) {
      const lado = radio * 2.3; // los emojis tienen aire alrededor; un poco más grandes que un círculo
      const x0 = Math.max(0, Math.floor(cx - lado / 2));
      const x1 = Math.min(ancho - 1, Math.ceil(cx + lado / 2));
      const y0 = Math.max(0, Math.floor(cy - lado / 2));
      const y1 = Math.min(alto - 1, Math.ceil(cy + lado / 2));
      const N = 3;
      const escala = img.ancho / lado;
      for (let y = y0; y <= y1; y++) {
              for (let x = x0; x <= x1; x++) {
                      let r = 0;
                      let g = 0;
                      let b = 0;
                      let a = 0;
                      for (let sy = 0; sy < N; sy++) {
                              for (let sx = 0; sx < N; sx++) {
                                      const u = Math.floor((x + (sx + 0.5) / N - (cx - lado / 2)) * escala);
                                      const v = Math.floor((y + (sy + 0.5) / N - (cy - lado / 2)) * escala);
                                      if (u < 0 || v < 0 || u >= img.ancho || v >= img.alto) continue;
                                      const i = (v * img.ancho + u) * 4;
                                      const al = img.px[i + 3] / 255;
                                      r += img.px[i] * al;
                                      g += img.px[i + 1] * al;
                                      b += img.px[i + 2] * al;
                                      a += al;
                              }
                      }
                      if (a <= 0) continue;
                      r /= a;
                      g /= a;
                      b /= a;
                      let alfa = a / (N * N);
                      if (!lleno) {
                              const gris = 0.299 * r + 0.587 * g + 0.114 * b;
                              r = r * 0.4 + gris * 0.6;
                              g = g * 0.4 + gris * 0.6;
                              b = b * 0.4 + gris * 0.6;
                              alfa *= 0.35;
                      }
                      const i = (y * ancho + x) * 4;
                      px[i] = Math.round(px[i] * (1 - alfa) + r * alfa);
                      px[i + 1] = Math.round(px[i + 1] * (1 - alfa) + g * alfa);
                      px[i + 2] = Math.round(px[i + 2] * (1 - alfa) + b * alfa);
              }
      }
}

// Pinta un sello en el lienzo con suavizado (4×4 muestras por pixel).
function pintarSello(px, ancho, alto, cx, cy, radio, forma, color, alfa, anillo) {
      const grosor = 0.16; // grosor del contorno de un sello vacío
      const interior = 1 - grosor;
      const x0 = Math.max(0, Math.floor(cx - radio - 1));
      const x1 = Math.min(ancho - 1, Math.ceil(cx + radio + 1));
      const y0 = Math.max(0, Math.floor(cy - radio - 1));
      const y1 = Math.min(alto - 1, Math.ceil(cy + radio + 1));
      const N = 4;
      for (let y = y0; y <= y1; y++) {
              for (let x = x0; x <= x1; x++) {
                      let cubiertos = 0;
                      for (let sy = 0; sy < N; sy++) {
                              for (let sx = 0; sx < N; sx++) {
                                      const u = (x + (sx + 0.5) / N - cx) / radio;
                                      const v = (y + (sy + 0.5) / N - cy) / radio;
                                      if (!forma(u, v)) continue;
                                      if (anillo && forma(u / interior, v / interior)) continue;
                                      cubiertos++;
                              }
                      }
                      if (!cubiertos) continue;
                      const a = (cubiertos / (N * N)) * alfa;
                      const i = (y * ancho + x) * 4;
                      px[i] = Math.round(px[i] * (1 - a) + color[0] * a);
                      px[i + 1] = Math.round(px[i + 1] * (1 - a) + color[1] * a);
                      px[i + 2] = Math.round(px[i + 2] * (1 - a) + color[2] * a);
              }
      }
}

// Devuelve el PNG de la franja para una escala (1, 2 o 3).
function franjaDeSellos({ color, selloForma, umbral, puntos }, escala) {
      const [ancho, alto] = TAMANOS[escala] || TAMANOS[2];
      const fondo = hexARgb(color, '#b8872b');
      const tinta = esClaro(fondo) ? [27, 31, 35] : [255, 255, 255];
      const total = Math.min(20, Math.max(1, Number(umbral) || 10));
      const llenos = Math.min(total, Math.max(0, Number(puntos) || 0));
      const emoji = FORMAS[selloForma] ? null : emojiDe(selloForma);
      const forma = formaDe(selloForma);

      const px = Buffer.alloc(ancho * alto * 4);
      for (let i = 0; i < ancho * alto; i++) {
              px[i * 4] = fondo[0];
              px[i * 4 + 1] = fondo[1];
              px[i * 4 + 2] = fondo[2];
              px[i * 4 + 3] = 255;
      }

      // Una fila hasta 10 sellos; con más, dos filas.
      const filas = total > 10 ? 2 : 1;
      const porFila = Math.ceil(total / filas);
      const margenX = ancho * 0.06;
      const celdaX = (ancho - margenX * 2) / Math.max(porFila, 5);
      const celdaY = (alto * 0.86) / filas;
      const radio = Math.min(celdaX, celdaY) * 0.36;
      const anchoUsado = celdaX * porFila;
      const inicioX = (ancho - anchoUsado) / 2 + celdaX / 2;
      const inicioY = (alto - celdaY * filas) / 2 + celdaY / 2;

      for (let i = 0; i < total; i++) {
              const fila = Math.floor(i / porFila);
              const enFila = fila === filas - 1 ? total - porFila * (filas - 1) : porFila;
              const col = i % porFila;
              // La última fila, si queda incompleta, se centra.
              const desplazamiento = ((porFila - enFila) * celdaX) / 2;
              const cx = inicioX + desplazamiento + col * celdaX;
              const cy = inicioY + fila * celdaY;
              const lleno = i < llenos;
              if (emoji) pintarEmoji(px, ancho, alto, cx, cy, radio, emoji, lleno);
              else pintarSello(px, ancho, alto, cx, cy, radio, forma, tinta, lleno ? 1 : 0.5, !lleno);
      }
      return codificarPng(ancho, alto, px);
}

// El logo que subió el negocio, si es un PNG (es como lo guarda el panel).
// Apple Wallet solo acepta PNG; cualquier otra cosa se ignora.
function logoPngDe(logoUrl) {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(logoUrl || '');
      if (!m) return null;
      const buf = Buffer.from(m[1], 'base64');
      const firmaPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      return buf.length > 8 && buf.subarray(0, 4).equals(firmaPng) ? buf : null;
}

module.exports = { franjaDeSellos, logoPngDe, codificarPng, decodificarPng };
