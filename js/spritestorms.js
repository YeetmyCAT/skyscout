// One method for sprite-producing thunderstorms, used by both the Sprite finder and the 3D view.
// Sprites come from large mature storm complexes (mesoscale convective systems) with wide stratiform rain and strong
// positive cloud-to-ground strokes; isolated thunderstorms rarely make them. So only big, powerful complexes count:
//   forecast models: storm areas spanning >= 2 cells of a 120 km grid (~29 000 km2+) with strong storm signals;
//   satellite (infrared): a cold cloud shield (<= -52 C) of >= 30 000 km2 with very deep cores (<= -62 C).
// How the sources combine depends on what is available at each hour:
//   full forecast + satellite  -> forecast leads, satellite confirms (unconfirmed forecast storms are suppressed)
//   backup forecast + satellite-> satellite leads, the backup forecast only adds a little confirmation
//   full forecast only         -> forecast, discounted a little (unconfirmed)
//   backup forecast only       -> only very large complexes, low confidence
//   satellite only             -> satellite complexes
// The satellite only applies within 3 h of its image. Every complex (big or small) still flickers with lightning on
// the horizon; `spriteRate` (0..1) is what decides sprites.
import { destination, haversine, clamp } from './util.js';
import { gridForecast, val } from './weather.js';
import { loadIR, satLayer } from './satellite.js';
import { makeLocal } from './util.js';

const VARS = ['cape', 'lifted_index', 'precipitation', 'showers', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'weather_code', 'lightning_potential'];
export const SAT_WINDOW = 3 * 3600;

// The storm grid is centred on a 1-degree lattice point, so the finder and the 3D view share it (and its cache).
export function stormGrid(home, halfKm = 840, stepKm = 120) {
  const c = [Math.round(home[0]), Math.round(home[1])];
  const n = Math.round(halfKm / stepKm), pts = [], idx = [];
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const [la, lo] = destination(c[0], c[1], 0, j * stepKm * 1000);
    const p = destination(la, lo, 90, i * stepKm * 1000);
    pts.push(p); idx.push([i + n, j + n]);
  }
  return { pts, idx, n: 2 * n + 1, stepKm, center: c, halfKm };
}

// Storm strength 0..1 at one grid cell and hour from a model series.
function stormIndex(S, t) {
  const cape = val(S, 'cape', t) ?? 0, li = val(S, 'lifted_index', t), pr = val(S, 'precipitation', t) ?? 0, sh = val(S, 'showers', t) ?? 0;
  const hi = val(S, 'cloud_cover_high', t) ?? 0, code = val(S, 'weather_code', t) ?? 0, lp = val(S, 'lightning_potential', t);
  let s = clamp((cape - 400) / 2200, 0, 1) * clamp((pr + sh - 0.8) / 6, 0, 1) * clamp(hi / 80, 0.3, 1);
  if (li != null) s *= clamp((2 - li) / 6, 0.2, 1.2);
  if (code >= 95) s = Math.max(s, 0.55 + clamp(cape / 4000, 0, 0.4));
  if (lp != null && lp > 0) s = Math.max(s, clamp(lp / 600, 0, 1));
  return clamp(s, 0, 1);
}

// Satellite complexes on a 10 km grid around the storm grid's centre: cold cloud shields and their deepest cores.
function satComplexes(ir, G) {
  const C = 10000, R = (G.halfKm + 60) * 1000, n = Math.round(2 * R / C), local = makeLocal(G.center[0], G.center[1]);
  const T = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const [la, lo] = local.toLL((i + 0.5) * C - R, (j + 0.5) * C - R); T[j * n + i] = ir.sample(la, lo); }
  const seen = new Uint8Array(n * n), out = [];
  for (let s0 = 0; s0 < n * n; s0++) {
    if (seen[s0] || !(T[s0] <= -52)) continue;
    const st = [s0], cells = []; seen[s0] = 1; let minT = 0;
    while (st.length) {
      const c = st.pop(); cells.push(c); minT = Math.min(minT, T[c]);
      const ci = c % n, cj = (c / n) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= n || b >= n) continue; const k = b * n + a; if (!seen[k] && T[k] <= -52) { seen[k] = 1; st.push(k); } }
    }
    const area = cells.length * 100;                    // km2
    let la = 0, lo = 0; const ll = cells.map(c => local.toLL((c % n + 0.5) * C - R, (((c / n) | 0) + 0.5) * C - R));
    for (const p of ll) { la += p[0]; lo += p[1]; } la /= ll.length; lo /= ll.length;
    // sprite-capable only for big, very deep complexes (MCS); smaller cold areas are ordinary storms
    const mcs = area >= 30000 && minT <= -62 ? Math.sqrt(clamp((area - 30000) / 90000, 0, 1)) * clamp((-minT - 60) / 15, 0, 1) : 0;
    const gridCells = new Set(ll.map(p => nearestIdx(G, p[0], p[1])).filter(k => k >= 0));   // which 120 km cells it covers
    // warmest ground the satellite sees within ~300 km (clear patches read close to the surface temperature)
    let i0 = n, i1 = 0, j0 = n, j1 = 0; for (const c of cells) { const ci = c % n, cj = (c / n) | 0; i0 = Math.min(i0, ci); i1 = Math.max(i1, ci); j0 = Math.min(j0, cj); j1 = Math.max(j1, cj); }
    // a robust reading (95th percentile), so a single bad pixel can't pass for warm ground
    const vals = [];
    for (let j = Math.max(0, j0 - 30); j <= Math.min(n - 1, j1 + 30); j += 2) for (let i = Math.max(0, i0 - 30); i <= Math.min(n - 1, i1 + 30); i += 2) { const v = T[j * n + i]; if (isFinite(v)) vals.push(v); }
    vals.sort((a, b) => a - b);
    const warmT = vals.length ? vals[Math.floor(vals.length * 0.95)] : -99;
    out.push({ la, lo, area, minT, mcs, gridCells, warmT, convective: minT <= -55 });
  }
  return out;
}

// Storm support: cold tops alone can be winter jet-stream cirrus or a frontal cloud shield, which don't rain hard,
// thunder or make sprites. They count as a storm only with storm conditions in the primary forecast nearby
// (instability, thunder or a lightning signal) or warm air near the ground (clear ground the satellite sees within
// ~300 km reads 12 C or more at the 95th percentile, as in summer or the tropics). Without the primary forecast
// (backup only, or none), warm ground alone decides.
export const WARM_GROUND_C = 12;
function forecastSupport(wx, cells, t) {
  if (!wx) return false;
  for (const k of cells) {
    const S = wx[k]; if (!S || S.backup) continue;   // instability (CAPE) is only in the primary forecast; with the backup, warm ground alone decides
    if ((val(S, 'cape', t) ?? 0) >= 150 || (val(S, 'weather_code', t) ?? 0) >= 95 || (val(S, 'lightning_potential', t) ?? 0) > 0) return true;
  }
  return false;
}
const nearestIdx = (G, la, lo) => { let best = -1, bd = 1e18; for (let k = 0; k < G.pts.length; k++) { const d = (G.pts[k][0] - la) ** 2 + ((G.pts[k][1] - lo) * Math.cos(la * Math.PI / 180)) ** 2; if (d < bd) { bd = d; best = k; } } return best; };

// home: [lat, lon]; hours: unix seconds; opts.models: 'fetch' (may use the free forecast quota) | 'cache' (only what is
// already saved). Returns { stormsByHour: [{t, s, clusters}], grid, config: {label, short, perHour}, wx }.
export async function spriteStormField(home, hours, opts = {}, progress = () => { }) {
  const G = stormGrid(home);
  // forecast models (GFS + ICON on the grid)
  let wx = null;
  try {
    if (opts.models === 'fetch') progress(`Forecasting storms over ${G.pts.length} grid points (±840 km, GFS + ICON)…`);
    wx = await gridForecast(G.pts, `storm${G.center[0]},${G.center[1]}`, { vars: VARS, models: ['gfs_seamless', 'icon_seamless'], chunk: 60, cacheOnly: opts.models !== 'fetch' });
    if (!wx || !wx.some(Boolean)) wx = null;
  } catch { wx = null; }
  const modelKind = !wx ? 'none' : wx.some(x => x && x.backup) ? 'backup' : 'primary';
  // satellite (infrared), only meaningful near the time of the image
  let sat = null;
  const now = Date.now() / 1000;
  if (satLayer(G.center[1]) && hours.some(t => Math.abs(t - now) < SAT_WINDOW + 3600)) {
    progress('Reading the satellite image for storm complexes…');
    const ir = opts.ir || await loadIR(G.center[0], G.center[1], G.halfKm + 60).catch(() => null);
    if (ir) sat = { obs: ir.obs / 1000, name: ir.sat.name, complexes: satComplexes(ir, G), sample: ir.sample };
  }
  const N = G.n, at = (i, j) => j * N + i, stormsByHour = [], perHour = [];
  for (const t of hours) {
    const useSat = sat && Math.abs(t - sat.obs) <= SAT_WINDOW;
    const s = new Float32Array(N * N);
    if (wx) for (let k = 0; k < G.pts.length; k++) if (wx[k]) s[k] = stormIndex(wx[k], t);
    // model clusters (8-connected areas of storm signal)
    const lab = new Int32Array(N * N).fill(-1), model = [];
    for (let k = 0; k < N * N; k++) {
      if (s[k] < 0.22 || lab[k] >= 0) continue;
      const c = { cells: [], sum: 0, la: 0, lo: 0 }, q = [k]; lab[k] = model.length;
      while (q.length) {
        const m = q.pop(), i = m % N, j = (m / N) | 0; c.cells.push(m); c.sum += s[m]; c.la += G.pts[m][0] * s[m]; c.lo += G.pts[m][1] * s[m];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const mm = at(ii, jj); if (lab[mm] < 0 && s[mm] >= 0.22) { lab[mm] = model.length; q.push(mm); }
        }
      }
      c.la /= c.sum; c.lo /= c.sum; c.area = c.cells.length * G.stepKm * G.stepKm; c.peak = Math.max(...c.cells.map(m => s[m]));
      // MCS-scale only: one grid cell (an isolated storm) never counts; needs a strong core too
      c.modelRate = c.cells.length >= 2 && c.peak >= 0.4 ? Math.pow(clamp((c.area - 20000) / 80000, 0, 1), 0.6) * c.peak : 0;
      c.topKm = 12 + 5 * c.peak;
      model.push(c);
    }
    // satellite complexes mapped onto the grid
    const ringK = ks => { const r = new Set(); for (const m of ks) { const i = m % N, j = (m / N) | 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < N && jj < N) r.add(at(ii, jj)); } } return r; };
    const satCl = useSat ? sat.complexes.filter(x => x.convective && x.area >= 2500 && (x.warmT >= WARM_GROUND_C || forecastSupport(wx, ringK(x.gridCells), t))) : [];
    const near = (a, b, km) => haversine(a.la, a.lo, b.la, b.lo) / 1000 < km;
    // a satellite complex matches a model cluster when it covers one of its cells or a neighbouring cell (~120 km)
    const ring = c => { const r = new Set(); for (const m of c.cells) { const i = m % N, j = (m / N) | 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < N && jj < N) r.add(at(ii, jj)); } } return r; };
    const satNear = c => { const r = ring(c); return satCl.filter(x => [...x.gridCells].some(k => r.has(k)) || near(c, x, 200)); };
    const clusters = [];
    let kind;
    if (modelKind === 'primary' && useSat) {
      kind = 'primary+sat';
      for (const c of model) {
        const sx = satNear(c), best = sx.reduce((m, x) => Math.max(m, x.mcs), 0);
        const conf = best > 0 ? 1 : sx.length ? 0.5 : 0.15;     // satellite confirms an MCS / only ordinary storms / nothing
        clusters.push({ ...c, spriteRate: c.modelRate * conf, source: 'forecast' + (best > 0 ? ' + satellite' : '') });
      }
      for (const x of satCl) if (x.mcs > 0 && !model.some(c => satNear(c).includes(x))) clusters.push(satCluster(x, G, 0.8));
      for (const x of satCl) if (!x.mcs && !model.some(c => satNear(c).includes(x))) clusters.push(satCluster(x, G, 0));   // flicker only
    } else if (modelKind === 'backup' && useSat) {
      kind = 'backup+sat';
      for (const x of satCl) {
        const confirm = model.some(c => c.peak >= 0.5 && satNear(c).includes(x)) ? 1.2 : 1;
        clusters.push(satCluster(x, G, Math.min(1, confirm)));
      }
    } else if (modelKind === 'primary') {
      kind = 'primary';
      for (const c of model) clusters.push({ ...c, spriteRate: c.modelRate * 0.85, source: 'forecast' });
    } else if (modelKind === 'backup') {
      kind = 'backup';
      for (const c of model) clusters.push({ ...c, spriteRate: c.cells.length >= 3 ? c.modelRate * 0.4 : 0, source: 'backup forecast' });
    } else if (useSat) {
      kind = 'sat';
      for (const x of satCl) clusters.push(satCluster(x, G, 1));
    } else kind = 'none';
    const sModel = s.slice();
    // the storm field used for line-of-sight blocking: model where available, satellite cold cores otherwise
    if (!wx && useSat) for (const c of clusters) for (const m of c.cells) s[m] = Math.max(s[m], 0.6);
    for (const c of clusters) c.peak = c.peak ?? 0.6;
    stormsByHour.push({ t, s, clusters, sModel: sModel });
    perHour.push(kind);
  }
  // How stormy it is at one place and time from the same storm data as the sprites, so the weather where you stand
  // agrees with the storms seen from far away wherever the satellite observes them. strength 0..1, thunder true/false.
  const stormAt = (la, lo, t) => {
    let hb = 0; for (let k = 0; k < hours.length; k++) if (Math.abs(hours[k] - t) < Math.abs(hours[hb] - t)) hb = k;
    if (!hours.length || Math.abs(hours[hb] - t) > 5400) return { strength: 0, thunder: false };
    const kind = perHour[hb], H = stormsByHour[hb];
    const k = nearestIdx(G, la, lo), m = k >= 0 && H.sModel ? H.sModel[k] : 0;
    const model = m >= 0.22 ? m : 0;
    let satS = 0, satT = NaN;
    if (kind.includes('sat') && sat && sat.sample) {
      // coldest top within ~20 km: under an anvil it rains; very cold (deep) tops mean heavy convective rain and lightning
      const d = 0.18, cs = Math.cos(la * Math.PI / 180);
      for (const [a, b] of [[0, 0], [d, 0], [-d, 0], [0, d / cs], [0, -d / cs]]) { const T = sat.sample(la + a, lo + b); if (isFinite(T)) satT = isFinite(satT) ? Math.min(satT, T) : T; }
      if (satT <= -50) {
        // storm support here: forecast instability/thunder in this or a neighbouring cell, or warm clear ground nearby
        let ok = forecastSupport(wx, k >= 0 ? (() => { const r = []; const i = k % N, j = (k / N) | 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < N && jj < N) r.push(at(ii, jj)); } return r; })() : [], hours[hb]);
        if (!ok) {
          const vals = [];
          for (const rKm of [50, 100, 150, 200, 250, 300]) for (let q = 0; q < 16; q++) {
            const a = q / 16 * 2 * Math.PI, T = sat.sample(la + rKm / 111 * Math.cos(a), lo + rKm / 111 / Math.max(0.2, cs) * Math.sin(a));
            if (isFinite(T)) vals.push(T);
          }
          vals.sort((a, b) => a - b);
          ok = vals.length > 10 && vals[Math.floor(vals.length * 0.95)] >= WARM_GROUND_C;   // 95th percentile, not one pixel
        }
        if (ok) satS = clamp((-satT - 50) / 18, 0, 1);
      }
    }
    const seen = isFinite(satT) && satT <= -45;     // the satellite sees cold, high cloud here
    // Accuracy first: the satellite is an observation, so where it applies its storm overrides a dry point forecast
    // (the forecast storm field adds only where the satellite confirms cold cloud). In forecast-only hours the
    // 7-model forecast at the exact spot is the better local estimate than a 120 km storm-grid cell, so no override.
    let strength;
    if (kind === 'primary+sat') strength = Math.max(satS, seen ? model * 0.6 : 0);
    else if (kind === 'backup+sat' || kind === 'sat') strength = satS;
    else strength = 0;
    return { strength, thunder: strength >= 0.45 || (satS > 0 && satT <= -58), kind, satT };
  };
  return { stormsByHour, grid: G, wx, config: describe(perHour, modelKind, sat, hours), modelKind, sat: sat && { obs: sat.obs, name: sat.name }, stormAt };
}

function satCluster(x, G, w) {
  const cells = [...x.gridCells];
  return { cells, la: x.la, lo: x.lo, area: x.area, peak: clamp((-x.minT - 45) / 30, 0.3, 1), topKm: 10 + clamp((-x.minT - 45) / 30, 0, 1) * 6,
    spriteRate: clamp(x.mcs * w, 0, 1), source: 'satellite' };
}

const NAMES = {
  'primary+sat': 'forecast models (GFS + ICON) confirmed by satellite',
  'backup+sat': 'satellite, lightly confirmed by the lower-quality backup forecast',
  primary: 'forecast models (GFS + ICON) only, no satellite for these hours',
  backup: 'lower-quality backup forecast only (low confidence, very large complexes only)',
  sat: 'satellite only (run the Sprite finder to add forecast models)',
  none: 'no storm data for these hours',
};
const SHORT = { 'primary+sat': 'forecast + satellite', 'backup+sat': 'satellite + backup forecast', primary: 'forecast only', backup: 'backup forecast only (low confidence)', sat: 'satellite only', none: 'no storm data' };
function describe(perHour, modelKind, sat, hours) {
  const satTxt = sat ? ` (${sat.name}, image ${new Date(sat.obs * 1000).toISOString().slice(11, 16)} UTC)` : '';
  let kinds = [...new Set(perHour)]; if (kinds.length > 1) kinds = kinds.filter(k => k !== 'none');
  const label = kinds.map(k => NAMES[k] + (k.includes('sat') ? satTxt : '')).join('; at other hours ');
  // per-hour lookup for the 3D readout
  const at = t => { let b = 0; for (let k = 0; k < hours.length; k++) if (Math.abs(hours[k] - t) < Math.abs(hours[b] - t)) b = k; return SHORT[perHour[b]] || SHORT.none; };
  return { label, short: kinds.map(k => SHORT[k]).join(' / '), perHour, hours, at };
}
