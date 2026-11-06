// Draws the app icon (night sky gradient, crescent, stars, horizon) and writes PNGs without any dependencies.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
function png(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function draw(S) {
  const b = Buffer.alloc(S * S * 4);
  const stars = Array.from({ length: 40 }, (_, i) => [((i * 97) % 89) / 89, ((i * 53) % 61) / 61 * 0.6, 0.5 + ((i * 31) % 7) / 7]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let r = 10 + 30 * v, g = 16 + 40 * v, bl = 40 + 80 * v;
    // horizon glow
    const hz = Math.exp(-(((v - 0.78) / 0.08) ** 2)); r += 120 * hz; g += 70 * hz; bl += 40 * hz;
    // hills
    const hill = 0.8 + 0.05 * Math.sin(u * 7) + 0.03 * Math.sin(u * 17 + 1);
    if (v > hill) { r = 8; g = 10; bl = 18; }
    // crescent moon
    const dx = u - 0.66, dy = v - 0.32, d1 = Math.hypot(dx, dy), d2 = Math.hypot(dx - 0.06, dy + 0.03);
    if (d1 < 0.17 && d2 > 0.15) { r = 245; g = 236; bl = 205; }
    for (const [sx, sy, m] of stars) { const d = Math.hypot(u - sx, v - sy) * S; if (d < 1.6 * m * S / 180 && v < hill) { r = g = bl = 255; } }
    const k = (y * S + x) * 4; b[k] = Math.min(255, r); b[k + 1] = Math.min(255, g); b[k + 2] = Math.min(255, bl); b[k + 3] = 255;
  }
  return png(S, S, b);
}
const out = path.join(__dirname, '..', 'icons'); fs.mkdirSync(out, { recursive: true });
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), draw(s));
console.log('icons written');
