// Geostationary infrared (GIBS clean longwave window, band 13): brightness temperature -> cloud mask and cloud-top height.
import { tilePixels, lon2x, lat2y, pool, clamp } from './util.js';
import { heightForTemp } from './weather.js';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
let cmap = null;
async function colormap() {
  if (cmap) return cmap;
  const a = await (await fetch('data/ircolormap.json')).json();
  cmap = new Map(); for (let i = 0; i < a.length; i += 4) cmap.set((a[i] << 16) | (a[i + 1] << 8) | a[i + 2], a[i + 3]);
  return cmap;
}
// Which satellite sees this longitude best.
export function satLayer(lon) {
  if (lon >= 75 || lon < -170) return { id: 'Himawari_AHI', name: 'Himawari-9' };
  if (lon < -108) return { id: 'GOES-West_ABI', name: 'GOES-West (GOES-18)' };
  if (lon < -20) return { id: 'GOES-East_ABI', name: 'GOES-East (GOES-19)' };
  return null; // Europe/Africa: no Meteosat in GIBS, models only
}
export function irTileURL(layer, time, z, x, y) {
  return `${GIBS}/${layer}_Band13_Clean_Infrared/default/${time}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
}
export function geoColorURL(layer, time) {
  return `${GIBS}/${layer}_GeoColor/default/${time}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`;
}
export function gibsTime(ms) {
  const d = new Date(Math.floor(ms / 600e3) * 600e3);
  return d.toISOString().slice(0, 17) + '00Z';
}

// Load IR around a point and return a sampler with brightness temps (C).
export async function loadIR(lat, lon, radiusKm = 160) {
  const sat = satLayer(lon); if (!sat) return null;
  const cm = await colormap();
  const z = 6, dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  const x0 = Math.floor(lon2x(lon - dLon, z)), x1 = Math.floor(lon2x(lon + dLon, z));
  const y0 = Math.floor(lat2y(lat + dLat, z)), y1 = Math.floor(lat2y(lat - dLat, z));
  // Newest available scan: step back from ~20 min ago until the tile has data.
  let tiles = null, obs = 0;
  for (let k = 2; k < 9 && !tiles; k++) {
    const t = Date.now() - k * 600e3, ts = gibsTime(t);
    const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push({ x, y });
    const got = await pool(list, 4, async ({ x, y }) => ({ x, y, px: await tilePixels(irTileURL(sat.id, ts, z, x, y), 7 * 864e5) }));
    if (got.every(g => g && g.px) && got.some(g => hasData(g.px))) { tiles = got; obs = Math.floor(t / 600e3) * 600e3; }
  }
  if (!tiles) return null;
  const map = new Map(tiles.map(t => [t.x + ',' + t.y, t.px]));
  const sample = (la, lo) => {
    const fx = lon2x(lo, z), fy = lat2y(la, z), tx = Math.floor(fx), ty = Math.floor(fy);
    const px = map.get(tx + ',' + ty); if (!px) return NaN;
    const i = (Math.floor((fy - ty) * px.h) * px.w + Math.floor((fx - tx) * px.w)) * 4;
    if (px.data[i + 3] < 128) return NaN;
    return decodeIR(cm, px.data[i], px.data[i + 1], px.data[i + 2]);
  };
  return { sat, obs, sample };
}
// Grey pixels are the warm ramp (resampling makes in-between greys, so interpolate); colours are cold tops.
export function decodeIR(cm, r, g, b) {
  if (r === g && g === b) return r >= 200 ? (r >= 243 ? -91.6 : -79.6 + (230 - r) / 26) : -18.9 + (197 - r) * (75.8 / 196);
  const v = cm.get((r << 16) | (g << 8) | b);
  return v == null ? nearest(cm, r, g, b) : v;
}
function hasData(px) { let n = 0; for (let i = 3; i < px.data.length; i += 4 * 97) if (px.data[i] > 128) n++; return n > 20; }
const nearCache = new Map();
function nearest(cm, r, g, b) {
  const k = (r << 16) | (g << 8) | b; if (nearCache.has(k)) return nearCache.get(k);
  let best = NaN, bd = 1e9;
  for (const [c, v] of cm) { const d = ((c >> 16) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2; if (d < bd) { bd = d; best = v; } }
  nearCache.set(k, best); return best;
}

// Cloud analysis grid for the 3D domain: per cell cloud fraction and top height (m MSL).
export function analyseIR(ir, local, halfSize, n, prof, surfT, surfZ) {
  const frac = new Float32Array(n * n), top = new Float32Array(n * n), bt = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) * 2 - 1) * halfSize, y = (j / (n - 1) * 2 - 1) * halfSize;
    const [la, lo] = local.toLL(x, y);
    const T = ir.sample(la, lo), k = j * n + i;
    bt[k] = T;
    if (!isFinite(T)) { frac[k] = -1; continue; }
    // Clear ground reads close to the 2 m temperature (a little colder at night); clouds read colder.
    const dT = (surfT - 3) - T;
    frac[k] = clamp((dT - 2) / 10, 0, 1);
    top[k] = frac[k] > 0 ? heightForTemp(prof, T, surfT, surfZ) : 0;
  }
  return { frac, top, bt, n };
}
