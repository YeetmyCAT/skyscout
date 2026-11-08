// Red sprite / TLE finder: forecast storm complexes (MCS) at night, then find viewing spots 120–500 km away
// with a clear line of sight above the storm, dark sky, and the moon down.
import { destination, haversine, bearing, clamp, curveDrop, R_EARTH } from './util.js';
import { val } from './weather.js';
import { spriteStormField } from './spritestorms.js';
import { quickLP, QUICK, NAT_SKY } from './lightpol.js';

// Storm complexes come from the shared method in spritestorms.js (the 3D view uses the same one).
export { stormGrid } from './spritestorms.js';

export async function findSprites(home, opts, progress = () => { }) {
  const { night, regional, maxDriveKm = 300 } = opts;
  const t0 = (night.nautDusk || night.sunset).getTime() / 1000, t1 = (night.nautDawn || night.sunrise).getTime() / 1000;
  const hours = []; for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) hours.push(t);
  const field = await spriteStormField(home, hours, { models: 'fetch' }, progress);
  const G = field.grid, wx = field.wx || [];
  const results = [], stormsByHour = field.stormsByHour;
  for (const { t, s, clusters } of stormsByHour) {

    if (!clusters.length) continue;
    // moon and darkness at this hour
    const sm = night.samples.reduce((b, x) => Math.abs(x.t / 1000 - t) < Math.abs(b.t / 1000 - t) ? x : b, night.samples[0] || { moonAlt: -10, moonFrac: 0, sunAlt: -20 });
    const moonPen = sm.moonAlt > 0 ? 0.7 * sm.moonFrac * clamp(sm.moonAlt / 20, 0.3, 1) : 0;
    const twilight = clamp((sm.sunAlt + 18) / 8, 0, 1);
    // Observer candidates: grid cells within driving range
    for (let k = 0; k < G.pts.length; k++) {
      const O = G.pts[k], dHome = haversine(home[0], home[1], O[0], O[1]) / 1000;
      if (dHome > maxDriveKm) continue;
      const localClear = wx[k] ? 1 - (val(wx[k], 'cloud_cover', t) ?? 50) / 100 : 0.6;
      if (localClear < 0.25) continue;
      for (const c of clusters) {
        if (!(c.spriteRate > 0)) continue;   // only sprite-capable complexes (MCS-scale)
        // distance to the nearest storm cell of the complex
        let dmin = 1e9; for (const m of c.cells) dmin = Math.min(dmin, haversine(O[0], O[1], G.pts[m][0], G.pts[m][1]) / 1000);
        const geo = dmin < 90 ? 0 : clamp((dmin - 90) / 70, 0, 1) * clamp((650 - dmin) / 250, 0, 1);
        if (geo <= 0) continue;
        const brg = bearing(O[0], O[1], c.la, c.lo);
        // Elevation of a 75 km sprite above the near edge of the complex
        const drop = curveDrop(dmin * 1000) / 1000;
        const spriteAlt = Math.atan((75 - drop) / dmin) * 180 / Math.PI;
        const anvilAlt = Math.atan((c.topKm - drop) / dmin) * 180 / Math.PI;
        // Line of sight clarity: walk toward the storm; clouds block only where the ray is still below them.
        let T = 1;
        for (let x = 0; x < dmin * 0.85; x += 30) {
          const P = destination(O[0], O[1], brg, x * 1000);
          const kk = nearestCell(G, P); if (kk < 0) continue;
          const lowAlt = Math.max(1, (spriteAlt + anvilAlt) / 2) * Math.PI / 180;
          const rayH = x * Math.tan(lowAlt) + (x * 1000) ** 2 / (2 * R_EARTH) / 1000;
          const S0 = wx[kk], lo = S0 ? (val(S0, 'cloud_cover_low', t) ?? 0) / 100 : 0, mi = S0 ? (val(S0, 'cloud_cover_mid', t) ?? 0) / 100 : 0, hi = S0 ? (val(S0, 'cloud_cover_high', t) ?? 0) / 100 : 0;
          const block = (rayH < 2 ? lo : 0) + (rayH < 6 ? mi * 0.9 : 0) + (rayH < 12 ? hi * 0.6 : 0) + (rayH < 15 ? s[kk] * 0.8 : 0);
          T *= 1 - clamp(block, 0, 0.95) * (x < 1 ? 1 : 0.6);
        }
        let lpPen = 0;
        if (regional) { const q = quickLP(regional, O[0], O[1]); const bin = Math.floor(brg / 22.5) % 16; lpPen = clamp(Math.log10(1 + q.az[bin] * QUICK.hor * 16 / NAT_SKY) / 2.5, 0, 0.6); }
        const score = c.spriteRate * geo * T * localClear * (1 - moonPen) * (1 - 0.35 * lpPen) * (1 - twilight);
        if (score < 0.03) continue;
        results.push({ t, p: O, dHome, storm: { la: c.la, lo: c.lo, area: c.area, peak: c.peak, topKm: c.topKm, spriteRate: c.spriteRate, source: c.source }, dist: dmin, bearing: brg, spriteAlt, anvilAlt, clearPath: T, localClear, moonPen, lpPen, score });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  // keep the best per site
  const seen = new Set(), best = [];
  for (const r of results) { const k = r.p.join(); if (seen.has(k)) continue; seen.add(k); best.push(r); if (best.length >= 12) break; }
  return { best, all: results.slice(0, 2000), stormsByHour, grid: G, hours, backup: field.modelKind === 'backup', config: field.config };
}
function nearestCell(G, P) {
  const N = G.n, half = (N - 1) / 2, home = G.center;
  const dy = haversine(home[0], home[1], P[0], home[1]) / 1000 * Math.sign(P[0] - home[0]);
  const dx = haversine(P[0], home[1], P[0], P[1]) / 1000 * Math.sign(P[1] - home[1]);
  const i = Math.round(dx / G.stepKm) + half, j = Math.round(dy / G.stepKm) + half;
  if (i < 0 || j < 0 || i >= N || j >= N) return -1; return j * N + i;
}
