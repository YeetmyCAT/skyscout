// Zenith artificial sky brightness from David Lorenz's Light Pollution Atlas (VIIRS-based, yearly, 1/120 degree grid).
// https://djlorenz.github.io/astronomy/lp/ — same family of models as lightpollutionmap.info's World Atlas layers.
import { cachedBlob } from './util.js';

const BASE = 'https://djlorenz.github.io/astronomy/binary_tiles/';
export const ATLAS_TILES = 'https://djlorenz.github.io/astronomy/image_tiles/tiles2025/tile_{z}_{x}_{y}.png';
const YEARS = [2025, 2024];
const tiles = new Map();

async function gunzip(blob) {
  const ds = new DecompressionStream('gzip');
  const buf = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
  return new Int8Array(buf);
}
// Decode a 600x600 tile: the first value is 2 bytes, then the first column holds latitude steps and each row longitude steps.
function decode(d) {
  const out = new Float32Array(600 * 600);
  let col0 = 128 * d[0] + d[1];
  for (let r = 0; r < 600; r++) {
    if (r > 0) col0 += d[600 * r + 1];
    let v = col0;
    for (let c = 0; c < 600; c++) {
      if (c > 0) v += d[600 * r + 1 + c];
      out[r * 600 + c] = (5 / 195) * (Math.exp(0.0195 * v) - 1);
    }
  }
  return out;
}
async function tile(tx, ty) {
  const key = tx + '_' + ty;
  if (tiles.has(key)) return tiles.get(key);
  const p = (async () => {
    for (const y of YEARS) {
      const b = await cachedBlob(`${BASE}${y}/binary_tile_${tx}_${ty}.dat.gz`, 180 * 864e5);
      if (!b || b.size < 1000) continue;
      try { return { year: y, grid: decode(await gunzip(b)) }; } catch { }
    }
    return null;
  })();
  tiles.set(key, p);
  if (tiles.size > 12) tiles.delete(tiles.keys().next().value);
  return p;
}
function index(lat, lon) {
  const lx = ((lon + 180) % 360 + 360) % 360, ly = lat + 65;
  const tx = Math.floor(lx / 5) + 1, ty = Math.floor(ly / 5) + 1;
  if (ty < 1 || ty > 28) return null;
  // grid points sit at the centres of 1/120 degree cells
  const fx = 120 * (lx - 5 * (tx - 1)) - 0.5, fy = 120 * (ly - 5 * (ty - 1)) - 0.5;
  return { tx, ty, fx, fy };
}
// Ratio of artificial to natural zenith brightness (bilinear). null outside coverage (|lat| > 75 or no data).
export async function atlasRatio(lat, lon) {
  const ix = index(lat, lon); if (!ix) return null;
  const t = await tile(ix.tx, ix.ty); if (!t) return null;
  const c = Math.max(0, Math.min(598, Math.floor(ix.fx))), r = Math.max(0, Math.min(598, Math.floor(ix.fy)));
  const u = Math.max(0, Math.min(1, ix.fx - c)), v = Math.max(0, Math.min(1, ix.fy - r)), g = t.grid;
  const a = g[r * 600 + c], b = g[r * 600 + c + 1], e = g[(r + 1) * 600 + c], f = g[(r + 1) * 600 + c + 1];
  return { ratio: (a * (1 - u) + b * u) * (1 - v) + (e * (1 - u) + f * u) * v, year: t.year };
}
export async function atlasMany(points) {
  const out = [];
  for (const [la, lo] of points) out.push(await atlasRatio(la, lo));
  return out;
}
export const ratioToSqm = r => 22.0 - 2.5 * Math.log10(1 + r);
