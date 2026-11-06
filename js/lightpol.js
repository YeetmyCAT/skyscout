// Light pollution from VIIRS night lights (NASA Black Marble via GIBS), propagated over the whole sky.
import { tilePixels, lon2x, lat2y, x2lon, y2lat, pool, haversine, bearing, DEG, clamp, cachedJSON } from './util.js';

const BM = (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;
export const BLACK_MARBLE_TILES = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
export const NAT_SKY = 1.71e-4; // cd/m^2, natural zenith ~22.0 mag/arcsec^2
export let LP_CAL = 6.5e-3;     // radiance-flux units -> cd/m^2 (calibrated against SQM readings)
export const mag2lum = m => 10.8e4 * Math.pow(10, -0.4 * m);
export const lum2mag = L => 12.583 - 2.5 * Math.log10(Math.max(L, 1e-9));
export function bortle(sqm) {
  const t = [21.99, 21.89, 21.69, 20.49, 19.5, 18.94, 18.38, 17.8];
  for (let i = 0; i < t.length; i++) if (sqm >= t[i]) return i + 1; return 9;
}
export const BORTLE_TXT = ['', 'Excellent dark site', 'Truly dark site', 'Rural sky', 'Rural/suburban transition', 'Suburban sky', 'Bright suburban sky', 'Suburban/urban transition', 'City sky', 'Inner-city sky'];
// Naked-eye limiting magnitude for a sky brightness (Schaefer approximation).
export const nelm = sqm => 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1);

// Black Marble pixel -> radiance proxy (nW/cm^2/sr). The product is a stretched visual composite.
export let RAD_K = 60, RAD_P = 2.0;
export function pixRad(r, g, b) {
  const y = (0.35 * r + 0.5 * g + 0.15 * b) / 255;
  return RAD_K * Math.pow(y, RAD_P);
}
export function setRadMap(k, p, cal) { RAD_K = k; RAD_P = p; if (cal) LP_CAL = cal; }
// Black Marble saturates in city cores: brighten saturated pixels by how deep they sit inside a saturated area.
function tileRadiance(px) {
  const d = px.data, w = px.w, n = w * w, rad = new Float32Array(n), sat = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const k = i * 4; if (d[k + 3] < 10) { rad[i] = -1; continue; } rad[i] = pixRad(d[k], d[k + 1], d[k + 2]); sat[i] = (0.35 * d[k] + 0.5 * d[k + 1] + 0.15 * d[k + 2]) > 240 ? 1 : 0; }
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i; if (!sat[k]) continue;
    let c = 0; for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) { const x = i + a, y = j + b; if (x >= 0 && y >= 0 && x < w && y < w && sat[y * w + x]) c++; }
    rad[k] *= 1 + 8 * Math.pow(c / 49, 2);
  }
  return rad;
}

// Grid of radiance around a point, two resolutions merged into one sampler.
async function radianceTiles(lat, lon, radiusKm, z) {
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos(lat * DEG));
  const x0 = Math.floor(lon2x(lon - dLon, z)), x1 = Math.floor(lon2x(lon + dLon, z));
  const y0 = Math.max(0, Math.floor(lat2y(Math.min(84, lat + dLat), z))), y1 = Math.floor(lat2y(Math.max(-84, lat - dLat), z));
  const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push({ x, y });
  const got = await pool(list, 6, async t => ({ ...t, px: await tilePixels(BM(z, ((t.x % 2 ** z) + 2 ** z) % 2 ** z, t.y), 400 * 864e5) }));
  return { z, tiles: got.filter(t => t && t.px) };
}

export async function loadLights(lat, lon, radiusKm = 280) {
  const [far, near] = await Promise.all([radianceTiles(lat, lon, radiusKm, 7), radianceTiles(lat, lon, 45, 8)]);
  if (!far.tiles.length && !near.tiles.length) return null;
  // Flatten into point sources {lat, lon, flux}; near tiles replace far ones within 40 km.
  const pts = [];
  const add = (set, keep) => {
    const z = set.z;
    for (const t of set.tiles) {
      const d = t.px.data, w = t.px.w, R = tileRadiance(t.px);
      for (let j = 0; j < w; j++) {
        const la = y2lat(t.y + (j + 0.5) / w, z);
        const pxKm = 40075 * Math.cos(la * DEG) / 2 ** z / w; const area = pxKm * pxKm;
        for (let i = 0; i < w; i++) {
          const rad = R[j * w + i]; if (rad < 0.05) continue;
          const lo = x2lon(t.x + (i + 0.5) / w, z);
          const dist = haversine(lat, lon, la, lo) / 1000;
          if (!keep(dist) || dist > radiusKm) continue;
          pts.push(la, lo, rad * area, dist, rad);
        }
      }
    }
  };
  add(far, d => d >= 40 || !near.tiles.length);
  add(near, d => d < 40);
  return { lat, lon, pts, near, far };
}

// Radiance at a point (for map readouts / scouting), nW/cm^2/sr.
export function radianceAt(L, lat, lon) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < L.pts.length; i += 5) {
    const d = Math.abs(L.pts[i] - lat) + Math.abs(L.pts[i + 1] - lon) * Math.cos(lat * DEG);
    if (d < bd) { bd = d; best = L.pts[i + 4]; }
  }
  return bd < 0.02 ? best : 0;
}

// Quick estimators (Walker-type sums) for many candidate sites; calibrated to the full model.
export function quickLP(L, lat, lon) {
  let zen = 0, hor = 0; const az = new Float32Array(16);
  const kx = 111.32 * Math.cos(lat * DEG), ky = 110.57, P = L.pts;
  for (let i = 0; i < P.length; i += 5) {
    const dx = (P[i + 1] - lon) * kx, dy = (P[i] - lat) * ky, d2 = dx * dx + dy * dy;
    if (d2 > 90000) continue;
    const d = Math.max(0.35, Math.sqrt(d2)), f = P[i + 2];
    zen += f * Math.pow(d, -2.0) * Math.exp(-d / 400);   // matched to the full scattering model at urban and rural test sites
    const hz = f * Math.pow(d, -1.9) * Math.exp(-d / 220);
    hor += hz;
    let b = Math.atan2(dx, dy); if (b < 0) b += 2 * Math.PI;
    az[Math.floor(b / (2 * Math.PI) * 16) % 16] += hz;
  }
  return { zen, hor, az };
}
// Coarse lights over a whole region (for scouting many sites).
export async function loadRegionalLights(lat, lon, radiusKm) {
  const set = await radianceTiles(lat, lon, radiusKm, 6);
  if (!set.tiles.length) return null;
  const pts = [];
  for (const t of set.tiles) {
    const w = t.px.w, R = tileRadiance(t.px);
    for (let j = 0; j < w; j++) {
      const la = y2lat(t.y + (j + 0.5) / w, 6), pxKm = 40075 * Math.cos(la * DEG) / 64 / w, area = pxKm * pxKm;
      for (let i = 0; i < w; i++) {
        const rad = R[j * w + i]; if (rad < 0.08) continue;
        pts.push(la, x2lon(t.x + (i + 0.5) / w, 6), rad * area, 0, rad);
      }
    }
  }
  return { lat, lon, pts };
}
// Defaults linking the quick sums to luminance (cd/m^2); refined when the full model runs.
export const QUICK = { zen: 3.2e-6, hor: 4e-6 };

// Full-sky brightness via the worker. Returns textures-ready arrays plus summary.
let worker = null;
export function skyBrightness(L, opts) {
  const { lat, lon, aod = 0.12, snow = 0, cloudBaseKm = 1.5, obsZ = 0 } = opts;
  // Bin the sources by azimuth (4 deg) and log distance; keep pixels near the observer individually.
  const NA = 72, ND = 34, bins = new Map(), src = [];
  for (let i = 0; i < L.pts.length; i += 5) {
    const la = L.pts[i], lo = L.pts[i + 1], f = L.pts[i + 2];
    const d = Math.max(0.25, haversine(lat, lon, la, lo) / 1000), az = bearing(lat, lon, la, lo) * DEG;
    if (d < 0.6) { src.push(d, az, f); continue; }
    const ia = Math.floor(az / (2 * Math.PI) * NA) % NA, id = Math.max(0, Math.floor(Math.log(d / 0.6) / Math.log(300 / 0.6) * ND));
    const k = ia * ND + id; let b = bins.get(k); if (!b) bins.set(k, b = [0, 0, 0, 0, 0]);
    b[0] += f; b[1] += f * d; b[2] += f * Math.sin(az); b[3] += f * Math.cos(az);
  }
  for (const b of bins.values()) if (b[0] > 0) src.push(b[1] / b[0], Math.atan2(b[2], b[3]), b[0]);
  const alts = [0, 1, 2, 3, 4.5, 6, 8, 10, 13, 16, 20, 25, 30, 37, 45, 55, 67, 80, 90];
  const nAz = 36;
  if (!worker) worker = new Worker(new URL('./lpworker.js', import.meta.url));
  return new Promise(res => {
    worker.onmessage = e => {
      const { clear, cloud } = e.data;
      const toLum = a => a.map(v => v * LP_CAL);
      const C = toLum(clear), K = toLum(cloud);
      const zen = C.filter((_, i) => i % alts.length === alts.length - 1).reduce((s, v) => s + v, 0) / nAz;
      const hz = [], hAt = alts.indexOf(6);
      for (let a = 0; a < nAz; a++) hz.push(C[a * alts.length + hAt]);
      res({ clear: C, cloud: K, nAz, alts, zenith: zen, horizon: hz, sources: src.length });
    };
    // light travelling sideways from distant towns crosses less haze than a vertical column suggests
    worker.postMessage({ sources: Float32Array.from(src), nAz, alts, aod: aod * 0.33, snow, cloudBase: cloudBaseKm, obsZ: obsZ / 1000 });
  });
}

// Upward light from the ground around the observer, for lighting cloud bases in 3D.
export function groundFluxGrid(L, local, halfKm, n = 96) {
  const g = new Float32Array(n * n), cell = 2 * halfKm / n;
  for (let i = 0; i < L.pts.length; i += 5) {
    const [x, y] = local.toXY(L.pts[i], L.pts[i + 1]);
    const ix = Math.floor((x / 1000 + halfKm) / cell), iy = Math.floor((y / 1000 + halfKm) / cell);
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) continue;
    g[iy * n + ix] += L.pts[i + 2] / (cell * cell); // mean radiance in the cell
  }
  // three blur radii packed into RGB: local glow, 5 km, 15 km
  const blur = (src, r) => {
    const t = new Float32Array(n * n), o = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < n) { s += src[y * n + xx]; c++; } } t[y * n + x] = s / c; }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < n) { s += t[yy * n + x]; c++; } } o[y * n + x] = s / c; }
    return o;
  };
  const b1 = blur(g, 1), b2 = blur(g, Math.max(1, Math.round(5 / cell))), b3 = blur(g, Math.max(2, Math.round(15 / cell)));
  const data = new Uint8Array(n * n * 4), enc = v => clamp(Math.log10(1 + v) / 3, 0, 1) * 255;
  for (let i = 0; i < n * n; i++) { data[i * 4] = enc(b1[i]); data[i * 4 + 1] = enc(b2[i]); data[i * 4 + 2] = enc(b3[i]); data[i * 4 + 3] = 255; }
  return { data, n, halfKm };
}

// Names of the brightest light domes (reverse geocode the strongest directions).
export async function domeNames(L, lat, lon) {
  const az = new Map();
  for (let i = 0; i < L.pts.length; i += 5) {
    const d = L.pts[i + 3]; if (d < 8) continue;
    const k = Math.floor(bearing(lat, lon, L.pts[i], L.pts[i + 1]) / 15);
    const w = L.pts[i + 2] * Math.pow(d, -1.9);
    const b = az.get(k) || { w: 0, la: 0, lo: 0, d: 0 }; b.w += w; b.la += L.pts[i] * w; b.lo += L.pts[i + 1] * w; b.d += d * w; az.set(k, b);
  }
  const top = [...az.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 4);
  const max = top.length ? top[0][1].w : 1;
  const out = [];
  for (const [k, b] of top) {
    if (b.w < max * 0.15) continue;
    const la = b.la / b.w, lo = b.lo / b.w;
    let name = '';
    try {
      const r = await cachedJSON(`rev:${la.toFixed(1)},${lo.toFixed(1)}`, `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${la.toFixed(3)}&lon=${lo.toFixed(3)}`, 90 * 864e5, { timeout: 8000 });
      const a = r.data.address || {}; name = a.city || a.town || a.county || a.state || r.data.name || '';
    } catch { }
    out.push({ az: k * 15 + 7.5, dist: b.d / b.w, strength: b.w / max, name });
  }
  return out;
}
