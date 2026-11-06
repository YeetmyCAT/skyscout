// Real elevation (AWS Terrarium tiles) and aerial imagery (Esri World Imagery) around a location.
import { tilePixels, cachedBlob, lon2x, lat2y, x2lon, y2lat, pool } from './util.js';

const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const IMAGERY = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Height sampler over tiles at zoom z covering a lat/lon box. Bilinear, metres.
export async function heightField(lat, lon, radiusM, z) {
  const dLat = radiusM / 111000, dLon = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
  const x0 = Math.floor(lon2x(lon - dLon, z)), x1 = Math.floor(lon2x(lon + dLon, z));
  const y0 = Math.floor(lat2y(lat + dLat, z)), y1 = Math.floor(lat2y(lat - dLat, z));
  const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push({ x, y });
  const tiles = await pool(list, 6, async t => ({ ...t, px: await tilePixels(TERRARIUM(z, t.x, t.y), 365 * 864e5) }));
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256, h = new Float32Array(W * H);
  let ok = 0;
  for (const t of tiles) {
    if (!t || !t.px) continue; ok++;
    const ox = (t.x - x0) * 256, oy = (t.y - y0) * 256, d = t.px.data;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const k = (j * 256 + i) * 4;
      h[(oy + j) * W + ox + i] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
    }
  }
  const sample = (la, lo) => {
    const fx = (lon2x(lo, z) - x0) * 256 - 0.5, fy = (lat2y(la, z) - y0) * 256 - 0.5;
    const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - ix)), ty = Math.max(0, Math.min(1, fy - iy));
    const a = h[iy * W + ix], b = h[iy * W + ix + 1], c = h[(iy + 1) * W + ix], e = h[(iy + 1) * W + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  };
  return { sample, ok: ok > 0, bounds: { n: y2lat(y0, z), s: y2lat(y1 + 1, z), w: x2lon(x0, z), e: x2lon(x1 + 1, z) } };
}

// Imagery mosaic as a canvas aligned to a local square (metres), for the ground texture.
export async function imageryCanvas(local, halfSize, z, px = 2048) {
  const [latN, lonW] = local.toLL(-halfSize, halfSize), [latS, lonE] = local.toLL(halfSize, -halfSize);
  const x0 = Math.floor(lon2x(lonW, z)), x1 = Math.floor(lon2x(lonE, z));
  const y0 = Math.floor(lat2y(latN, z)), y1 = Math.floor(lat2y(latS, z));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 100) return null;
  const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push({ x, y });
  const imgs = await pool(list, 6, async t => { const b = await cachedBlob(IMAGERY(z, t.x, t.y), 120 * 864e5); return b ? { ...t, bmp: await createImageBitmap(b).catch(() => null) } : null; });
  const cv = document.createElement('canvas'); cv.width = cv.height = px;
  const g = cv.getContext('2d'); g.fillStyle = '#4a5a3a'; g.fillRect(0, 0, px, px);
  // Map each tile's mercator box into local metres (small-area approximation is fine here).
  let n = 0;
  for (const t of imgs) {
    if (!t || !t.bmp) continue; n++;
    const [ax, ay] = local.toXY(y2lat(t.y, z), x2lon(t.x, z)), [bx, by] = local.toXY(y2lat(t.y + 1, z), x2lon(t.x + 1, z));
    const sx = v => (v + halfSize) / (2 * halfSize) * px, sy = v => (halfSize - v) / (2 * halfSize) * px;
    g.drawImage(t.bmp, sx(ax), sy(ay), sx(bx) - sx(ax), sy(by) - sy(ay));
  }
  return n ? cv : null;
}
