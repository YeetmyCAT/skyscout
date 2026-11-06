// Red sprite / TLE finder: forecast storm complexes (MCS) at night, then find viewing spots 120–500 km away
// with a clear line of sight above the storm, dark sky, and the moon down.
import { destination, haversine, bearing, clamp, curveDrop, R_EARTH } from './util.js';
import { gridForecast, val } from './weather.js';
import { quickLP, QUICK, NAT_SKY } from './lightpol.js';

const VARS = ['cape', 'lifted_index', 'precipitation', 'showers', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'weather_code', 'lightning_potential'];

export function stormGrid(home, halfKm = 840, stepKm = 120) {
  const n = Math.round(halfKm / stepKm), pts = [], idx = [];
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const [la, lo] = destination(home[0], home[1], 0, j * stepKm * 1000);
    const p = destination(la, lo, 90, i * stepKm * 1000);
    pts.push(p); idx.push([i + n, j + n]);
  }
  return { pts, idx, n: 2 * n + 1, stepKm };
}

// Storm strength 0..1 at one grid cell and hour.
function stormIndex(S, t) {
  const cape = val(S, 'cape', t) ?? 0, li = val(S, 'lifted_index', t), pr = val(S, 'precipitation', t) ?? 0, sh = val(S, 'showers', t) ?? 0;
  const hi = val(S, 'cloud_cover_high', t) ?? 0, code = val(S, 'weather_code', t) ?? 0, lp = val(S, 'lightning_potential', t);
  let s = clamp((cape - 400) / 2200, 0, 1) * clamp((pr + sh - 0.8) / 6, 0, 1) * clamp(hi / 80, 0.3, 1);
  if (li != null) s *= clamp((2 - li) / 6, 0.2, 1.2);
  if (code >= 95) s = Math.max(s, 0.55 + clamp(cape / 4000, 0, 0.4));
  if (lp != null && lp > 0) s = Math.max(s, clamp(lp / 600, 0, 1));
  return clamp(s, 0, 1);
}

export async function findSprites(home, opts, progress = () => { }) {
  const { night, regional, maxDriveKm = 300 } = opts;
  const G = stormGrid(home);
  progress(`Forecasting storms over ${G.pts.length} grid points (±840 km, GFS + ICON)…`);
  const wx = await gridForecast(G.pts, `storm${home[0].toFixed(1)},${home[1].toFixed(1)}`, { vars: VARS, models: ['gfs_seamless', 'icon_seamless'], chunk: 60 });
  const t0 = (night.nautDusk || night.sunset).getTime() / 1000, t1 = (night.nautDawn || night.sunrise).getTime() / 1000;
  const hours = []; for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) hours.push(t);
  const N = G.n, at = (i, j) => j * N + i;
  const results = [], stormsByHour = [];
  for (const t of hours) {
    // storm field and connected complexes
    const s = new Float32Array(N * N);
    for (let k = 0; k < G.pts.length; k++) if (wx[k]) s[k] = stormIndex(wx[k], t);
    const lab = new Int32Array(N * N).fill(-1), clusters = [];
    for (let k = 0; k < N * N; k++) {
      if (s[k] < 0.22 || lab[k] >= 0) continue;
      const c = { cells: [], sum: 0, la: 0, lo: 0 }, q = [k]; lab[k] = clusters.length;
      while (q.length) {
        const m = q.pop(), i = m % N, j = (m / N) | 0; c.cells.push(m); c.sum += s[m]; c.la += G.pts[m][0] * s[m]; c.lo += G.pts[m][1] * s[m];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const mm = at(ii, jj); if (lab[mm] < 0 && s[mm] >= 0.22) { lab[mm] = clusters.length; q.push(mm); }
        }
      }
      c.la /= c.sum; c.lo /= c.sum;
      c.area = c.cells.length * G.stepKm * G.stepKm;
      c.peak = Math.max(...c.cells.map(m => s[m]));
      // Sprites favour large mature systems with wide stratiform rain (positive CG strokes).
      c.spriteRate = clamp(1 - Math.exp(-c.area / 45000), 0, 1) * clamp(c.peak * 1.2, 0, 1);
      c.topKm = 12 + 5 * c.peak;
      clusters.push(c);
    }
    stormsByHour.push({ t, s, clusters });
    if (!clusters.length) continue;
    // moon and darkness at this hour
    const sm = night.samples.reduce((b, x) => Math.abs(x.t / 1000 - t) < Math.abs(b.t / 1000 - t) ? x : b, night.samples[0] || { moonAlt: -10, moonFrac: 0, sunAlt: -20 });
    const moonPen = sm.moonAlt > 0 ? 0.7 * sm.moonFrac * clamp(sm.moonAlt / 20, 0.3, 1) : 0;
    const twilight = clamp((sm.sunAlt + 18) / 8, 0, 1);
    // Observer candidates: grid cells within driving range
    for (let k = 0; k < G.pts.length; k++) {
      const O = G.pts[k], dHome = haversine(home[0], home[1], O[0], O[1]) / 1000;
      if (dHome > maxDriveKm || !wx[k]) continue;
      const localClear = 1 - (val(wx[k], 'cloud_cover', t) ?? 50) / 100;
      if (localClear < 0.25) continue;
      for (const c of clusters) {
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
          const kk = nearestCell(G, home, P); if (kk < 0 || !wx[kk]) continue;
          const lowAlt = Math.max(1, (spriteAlt + anvilAlt) / 2) * Math.PI / 180;
          const rayH = x * Math.tan(lowAlt) + (x * 1000) ** 2 / (2 * R_EARTH) / 1000;
          const lo = (val(wx[kk], 'cloud_cover_low', t) ?? 0) / 100, mi = (val(wx[kk], 'cloud_cover_mid', t) ?? 0) / 100, hi = (val(wx[kk], 'cloud_cover_high', t) ?? 0) / 100;
          const block = (rayH < 2 ? lo : 0) + (rayH < 6 ? mi * 0.9 : 0) + (rayH < 12 ? hi * 0.6 : 0) + (rayH < 15 ? s[kk] * 0.8 : 0);
          T *= 1 - clamp(block, 0, 0.95) * (x < 1 ? 1 : 0.6);
        }
        let lpPen = 0;
        if (regional) { const q = quickLP(regional, O[0], O[1]); const bin = Math.floor(brg / 22.5) % 16; lpPen = clamp(Math.log10(1 + q.az[bin] * QUICK.hor * 16 / NAT_SKY) / 2.5, 0, 0.6); }
        const score = c.spriteRate * geo * T * localClear * (1 - moonPen) * (1 - 0.35 * lpPen) * (1 - twilight);
        if (score < 0.03) continue;
        results.push({ t, p: O, dHome, storm: { la: c.la, lo: c.lo, area: c.area, peak: c.peak, topKm: c.topKm }, dist: dmin, bearing: brg, spriteAlt, anvilAlt, clearPath: T, localClear, moonPen, lpPen, score });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  // keep the best per site
  const seen = new Set(), best = [];
  for (const r of results) { const k = r.p.join(); if (seen.has(k)) continue; seen.add(k); best.push(r); if (best.length >= 12) break; }
  return { best, stormsByHour, grid: G, hours };
}
function nearestCell(G, home, P) {
  const N = G.n, half = (N - 1) / 2;
  const dy = haversine(home[0], home[1], P[0], home[1]) / 1000 * Math.sign(P[0] - home[0]);
  const dx = haversine(P[0], home[1], P[0], P[1]) / 1000 * Math.sign(P[1] - home[1]);
  const i = Math.round(dx / G.stepKm) + half, j = Math.round(dy / G.stepKm) + half;
  if (i < 0 || j < 0 || i >= N || j >= N) return -1; return j * N + i;
}
