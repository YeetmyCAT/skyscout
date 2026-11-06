// Converts raw catalogs (d3-celestial, GIBS colormap) into compact files the app loads.
// Run: node tools/prepdata.js D:/Claude/.tmp/skyraw
const fs = require('fs'), path = require('path');
const raw = process.argv[2] || 'D:/Claude/.tmp/skyraw';
const out = path.join(__dirname, '..', 'data');
const J = f => JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8'));

// Stars: [raDeg, decDeg, mag, bv] flattened; HIP ids kept for names.
const st = J('stars.6.json');
const stars = [], ids = [];
for (const f of st.features) {
  let [ra, dec] = f.geometry.coordinates; if (ra < 0) ra += 360;
  const m = f.properties.mag; if (m > 6.6) continue;
  stars.push(+ra.toFixed(3), +dec.toFixed(3), +m.toFixed(2), +(+f.properties.bv || 0.6).toFixed(2));
  ids.push(f.id);
}
// Names for the brightest stars only.
const nm = J('starnames.json'), names = {};
ids.forEach((id, i) => { const n = nm[id]; if (n && n.name && stars[i * 4 + 2] < 2.6) names[i] = n.name; });
fs.writeFileSync(path.join(out, 'stars.json'), JSON.stringify({ s: stars, n: names }));

// Constellation lines: arrays of [ra,dec] polylines.
const cl = J('constellations.lines.json'), lines = [];
for (const f of cl.features) for (const ln of f.geometry.coordinates)
  lines.push(ln.map(([ra, dec]) => [+((ra + 360) % 360).toFixed(2), +dec.toFixed(2)]));
fs.writeFileSync(path.join(out, 'constlines.json'), JSON.stringify(lines));

// Milky Way brightness contours: 5 levels of polygons, rounded and thinned.
const mw = J('mw.json'), levels = [];
for (const f of mw.features) {
  const polys = [];
  const g = f.geometry; const P = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  for (const poly of P) for (const ring of poly) {
    const r = []; let last = null;
    for (const [ra, dec] of ring) {
      const p = [+((ra + 360) % 360).toFixed(2), +dec.toFixed(2)];
      if (last && Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) < 0.25) continue;
      r.push(p); last = p;
    }
    if (r.length > 2) polys.push(r);
  }
  levels.push({ id: f.id, polys });
}
fs.writeFileSync(path.join(out, 'milkyway.json'), JSON.stringify(levels));

// GIBS clean IR colormap: rgb -> brightness temperature (C), midpoint of each bin.
const xml = fs.readFileSync(path.join(raw, 'cm.xml'), 'utf8'), cm = [];
for (const m of xml.matchAll(/<ColorMapEntry rgb="(\d+),(\d+),(\d+)"[^>]*value="([^"]*)"/g)) {
  const nums = m[4].match(/-?[\d.]+/g); if (!nums) continue;
  const v = nums.length > 1 ? (+nums[0] + +nums[1]) / 2 : +nums[0];
  cm.push(+m[1], +m[2], +m[3], +v.toFixed(1));
}
fs.writeFileSync(path.join(out, 'ircolormap.json'), JSON.stringify(cm));
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
console.log('stars', stars.length / 4, 'names', Object.keys(names).length, 'cm', cm.length / 4, 'mw', levels.map(l => l.polys.length));
