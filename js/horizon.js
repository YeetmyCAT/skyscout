// How open the horizon is at candidate sites: terrain (hills, valleys) from elevation tiles,
// plus nearby forests and buildings from OpenStreetMap. Returns per-site obstruction by azimuth.
import { heightField } from './terrain.js';
import { overpassQuery } from './osm.js';
import { destination, curveDrop, DEG, clamp } from './util.js';

const NAZ = 16;

// Highest terrain elevation angle (degrees) in each of 16 directions, out to 15 km.
export async function terrainHorizons(home, radiusKm, sites) {
  const z = radiusKm > 160 ? 8 : 9;
  const hf = await heightField(home[0], home[1], (radiusKm + 20) * 1000, z).catch(() => null);
  if (!hf || !hf.ok) return sites.map(() => null);
  return sites.map(([la, lo]) => {
    const h0 = hf.sample(la, lo) + 2, out = new Float32Array(NAZ);
    for (let a = 0; a < NAZ; a++) {
      let best = -5;
      for (const d of [400, 800, 1500, 3000, 6000, 10000, 15000]) {
        const [pa, po] = destination(la, lo, a * 360 / NAZ, d);
        const ang = Math.atan((hf.sample(pa, po) - curveDrop(d) - h0) / d) / DEG;
        if (ang > best) best = ang;
      }
      out[a] = best;
    }
    return out;
  });
}

function inPoly(x, y, p) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if (((p[i][1] > y) !== (p[j][1] > y)) && (x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c; } return c; }

// Elevation angle (degrees) of the nearest trees or buildings in each direction, from OSM, within ~400 m.
export async function localObstructions(sites) {
  if (!sites.length) return [];
  const st = sites.map(([la, lo]) => `way["landuse"="forest"](around:400,${la.toFixed(5)},${lo.toFixed(5)});way["natural"~"^(wood|tree_row|scrub)$"](around:400,${la.toFixed(5)},${lo.toFixed(5)});relation["natural"="wood"](around:400,${la.toFixed(5)},${lo.toFixed(5)});way["building"](around:220,${la.toFixed(5)},${lo.toFixed(5)});`).join('');
  const q = `[out:json][timeout:80];(${st});out geom qt;`;
  let data;
  try { data = await overpassQuery(q, 'hz:' + sites.map(p => p[0].toFixed(3) + p[1].toFixed(3)).join('').slice(0, 300) + sites.length); }
  catch { return sites.map(() => null); }
  // features in lat/lon with a nominal height
  const feats = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    const rings = e.type === 'relation' ? (e.members || []).filter(m => m.role === 'outer' && m.geometry).map(m => m.geometry) : e.geometry ? [e.geometry] : [];
    const isB = !!t.building, H = isB ? (+String(t.height || '').replace(/[^\d.]/g, '') || (+t['building:levels'] || 2) * 3 + 1.5) : t.natural === 'scrub' ? 3 : 16;
    for (const g of rings) { if (g.length < 2) continue; feats.push({ g: g.map(p => [p.lon, p.lat]), H, line: t.natural === 'tree_row' }); }
  }
  return sites.map(([la, lo]) => {
    const kx = 111320 * Math.cos(la * DEG), ky = 110574, out = new Float32Array(NAZ).fill(-5);
    const local = feats.map(f => ({ ...f, p: f.g.map(([x, y]) => [(x - lo) * kx, (y - la) * ky]) }))
      .filter(f => f.p.some(([x, y]) => Math.abs(x) < 450 && Math.abs(y) < 450));
    if (!local.length) return out;
    for (let a = 0; a < NAZ; a++) {
      const az = a * 2 * Math.PI / NAZ, dx = Math.sin(az), dy = Math.cos(az);
      for (let d = 12; d <= 420; d += 12) {
        const x = dx * d, y = dy * d;
        let hit = 0;
        for (const f of local) {
          if (f.line) { if (f.p.some(([px, py]) => Math.hypot(px - x, py - y) < 8)) hit = Math.max(hit, f.H * 0.8); }
          else if (inPoly(x, y, f.p)) hit = Math.max(hit, f.H);
        }
        if (hit) { out[a] = Math.max(out[a], Math.atan((hit - 1.7) / d) / DEG); break; }
      }
    }
    return out;
  });
}

// 0..1 openness: share of the sky near the horizon that is visible (obstructions above ~2 degrees count against it).
export function horizonScore(terrain, local) {
  if (!terrain && !local) return null;
  let s = 0;
  for (let a = 0; a < NAZ; a++) {
    const ang = Math.max(terrain ? terrain[a] : -5, local ? local[a] : -5);
    s += clamp(1 - (ang - 2) / 10, 0, 1);
  }
  return s / NAZ;
}
export function horizonWorst(terrain, local) {
  let m = -5; for (let a = 0; a < NAZ; a++) m = Math.max(m, terrain ? terrain[a] : -5, local ? local[a] : -5); return m;
}
