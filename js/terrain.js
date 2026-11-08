// Real elevation (AWS Terrarium tiles) and aerial imagery (Esri World Imagery) around a location.
import { tilePixels, cachedBlob, lon2x, lat2y, x2lon, y2lat, pool } from './util.js';

const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// Esri's dark-gray canvas basemap paints all water one flat dark colour: a clean water mask.
export const WATERBASE = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
export const isWaterPixel = (r, g, b) => r < 56 && g < 56 && b < 62 && b >= r;
// Esri's light-gray canvas draws every road in pure white on grey land: a clean road map without labels.
export const ROADBASE = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
// Road masks near to far (~12 m, ~24 m, ~60 m per pixel), so distant lights go only on real streets.
export async function roadMasks(local) {
  const specs = [[12000, 13, 2048], [25000, 12, 2048], [46000, 11, 1536]];
  const res = await Promise.all(specs.map(([half, z, px]) => imageryCanvas(local, half, z, px, ROADBASE, 144).catch(() => null)));
  const out = [];
  res.forEach((cv, k) => {
    if (!cv) return;
    const [half, , px] = specs[k], d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, px, px).data, m = new Uint8Array(px * px);
    for (let i = 0; i < m.length; i++) m[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) >= 244 ? 1 : 0;
    out.push({ half, px, m });
  });
  if (!out.length) return null;
  return {
    // true on a road, false off-road, null outside the masks
    onRoad(x, z) {
      for (const M of out) if (Math.abs(x) < M.half && Math.abs(z) < M.half) {
        const i = Math.floor((x + M.half) / (2 * M.half) * M.px), j = Math.floor((z + M.half) / (2 * M.half) * M.px);
        return M.m[j * M.px + i] === 1;
      }
      return null;
    },
  };
}
// Mask canvas: white where water, black on land.
export async function waterMaskCanvas(local, halfSize, z, px = 1024) {
  const c = await imageryCanvas(local, halfSize, z, px, WATERBASE).catch(() => null);
  if (!c) return null;
  const g = c.getContext('2d', { willReadFrequently: true }), d = g.getImageData(0, 0, px, px), a = d.data;
  // the canvas starts filled with an earthy colour, so untiled areas read as land
  for (let i = 0; i < a.length; i += 4) { const w = isWaterPixel(a[i], a[i + 1], a[i + 2]) ? 255 : 0; a[i] = a[i + 1] = a[i + 2] = w; a[i + 3] = 255; }
  g.putImageData(d, 0, 0);
  return c;
}
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
export async function imageryCanvas(local, halfSize, z, px = 2048, urlFn = IMAGERY, maxTiles = 100) {
  const [latN, lonW] = local.toLL(-halfSize, halfSize), [latS, lonE] = local.toLL(halfSize, -halfSize);
  const x0 = Math.floor(lon2x(lonW, z)), x1 = Math.floor(lon2x(lonE, z));
  const y0 = Math.floor(lat2y(latN, z)), y1 = Math.floor(lat2y(latS, z));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles) return null;
  const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push({ x, y });
  const imgs = await pool(list, 6, async t => { const b = await cachedBlob(urlFn(z, t.x, t.y), 120 * 864e5); return b ? { ...t, bmp: await createImageBitmap(b).catch(() => null) } : null; });
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

// Open water at points, from the Esri dark-gray basemap (water is one flat dark colour).
export async function waterMany(points, z = 14, frac = 0.5) {
  const out = [];
  for (const [la, lo] of points) {
    const fx = lon2x(lo, z), fy = lat2y(la, z), tx = Math.floor(fx), ty = Math.floor(fy);
    const px = await tilePixels(WATERBASE(z, tx, ty), 120 * 864e5);
    if (!px) { out.push(false); continue; }
    const cx = Math.floor((fx - tx) * px.w), cy = Math.floor((fy - ty) * px.h);
    let wet = 0, n = 0;
    for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) {
      const x = Math.max(0, Math.min(px.w - 1, cx + dx)), y = Math.max(0, Math.min(px.h - 1, cy + dy)), k = (y * px.w + x) * 4;
      if (isWaterPixel(px.data[k], px.data[k + 1], px.data[k + 2])) wet++; n++;
    }
    out.push(wet / n > frac);
  }
  return out;
}
