// Packs the faint stars (6.6 < mag <= 8.0) from d3-celestial's stars.8.json into data/stars8.bin:
// per star 6 bytes: uint16 RA (0..360 deg), int16 Dec (-90..90), uint8 mag*20 (0..12.75), int8 B-V*50.
const fs = require('fs'), path = require('path');
const raw = process.argv[2] || 'D:/Claude/.tmp/skyraw';
const j = JSON.parse(fs.readFileSync(path.join(raw, 'stars.8.json'), 'utf8'));
const rows = [];
for (const f of j.features) {
  const m = f.properties.mag; if (!(m > 6.6 && m <= 8.05)) continue;
  let [ra, dec] = f.geometry.coordinates; if (ra < 0) ra += 360;
  rows.push([ra, dec, m, +f.properties.bv || 0.6]);
}
const buf = Buffer.alloc(rows.length * 6);
rows.forEach(([ra, dec, m, bv], i) => {
  buf.writeUInt16LE(Math.round(ra / 360 * 65535), i * 6);
  buf.writeInt16LE(Math.round(dec / 90 * 32767), i * 6 + 2);
  buf.writeUInt8(Math.min(255, Math.round(m * 20)), i * 6 + 4);
  buf.writeInt8(Math.max(-127, Math.min(127, Math.round(bv * 50))), i * 6 + 5);
});
fs.writeFileSync(path.join(__dirname, '..', 'data', 'stars8.bin'), buf);
console.log('faint stars', rows.length, 'bytes', buf.length);
