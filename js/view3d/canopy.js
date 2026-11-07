// Individual tree crowns found in high-resolution aerial photos (Esri World Imagery, ~0.9-1.8 m/pixel).
// No global tree database can be read from a browser (Meta's 1 m canopy map and city inventories aren't
// served with CORS; 10 m land cover calls whole suburbs "built"), so crowns are found where the photo shows
// them: vegetation darker and less saturated than the surrounding lawn. Conservative: unsure spots get no tree.
import { imageryCanvas } from '../terrain.js';

export async function detectCanopy(local, half, mobile) {
  // finest zoom that stays a reasonable download
  const mpp17 = 156543.03 * Math.cos(local.lat0 * Math.PI / 180) / 2 ** 17;
  let z = 17; if ((2 * half / (mpp17 * 256) + 1) ** 2 > 170) z = 16;
  const mpp = mpp17 * (z === 17 ? 1 : 2), px = Math.min(mobile ? 1700 : 3072, Math.round(2 * half / mpp));
  const cv = await imageryCanvas(local, half, z, px, undefined, 200);
  if (!cv) return null;
  const W = cv.width, D = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, W).data, N = W * W;
  const m = 2 * half / W;                                 // metres per pixel in the canvas
  // per-pixel: luminance, vegetation (green/olive, not grey asphalt or blue shadow), bright surfaces (roofs, pavement)
  const L = new Uint8Array(N), GR = new Int16Array(N), V = new Uint8Array(N), B = new Uint8Array(N);
  for (let i = 0, k = 0; i < N; i++, k += 4) {
    const r = D[k], g = D[k + 1], b = D[k + 2], l = 0.3 * r + 0.59 * g + 0.11 * b;
    L[i] = Math.round(l); GR[i] = g - r; V[i] = g >= b + 8 && g >= r - 6 && l > 18 && l < 150 ? 1 : 0;
    B[i] = l > 150 || (Math.abs(r - g) < 10 && Math.abs(g - b) < 12 && l > 115) ? 1 : 0;
  }
  const integ = a => { const I = new Uint32Array((W + 1) * (W + 1));   // exact integer sums, half the memory of doubles
     for (let y = 0; y < W; y++) { let s = 0; for (let x = 0; x < W; x++) { s += a[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } } return I; };
  const mulV = (a, off) => { const o = new Uint16Array(N); for (let i = 0; i < N; i++) o[i] = V[i] ? a[i] + off : 0; return o; };
  const IV = integ(V), ILV = integ(mulV(L, 0)), IGV = integ(mulV(GR, 256)), IB = integ(B);
  const box = (I, x, y, r) => { const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(W, y + r + 1); return ((I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) >>> 0) / ((x1 - x0) * (y1 - y0)); };   // >>> 0 undoes 32-bit wraparound
  // crown pixels: vegetation that is darker AND less saturated-green than the lawn within ~14 m (leaf-on crowns with
  // their inner shadows, or olive/brown leaf-off crowns over grass), or very dark olive canopy (woods).
  // Mowing stripes and shaded lawn keep the lawn's hue, so they don't count.
  const rb = Math.max(2, Math.round(14 / m)), T = new Uint8Array(N);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!V[i]) continue;
    const fv = Math.max(box(IV, x, y, rb), 1e-3), vL = box(ILV, x, y, rb) / fv, vGR = box(IGV, x, y, rb) / fv - 256;
    if ((L[i] < vL - 7 && L[i] < 120 && GR[i] < vGR - 5) || (L[i] < 60 && GR[i] < 12)) T[i] = 1;
  }
  const IT = integ(T), r = Math.max(1, Math.round(2.2 / m));   // ~4.5 m window: one small crown
  const step = Math.max(1, Math.round(2 / m)), G = Math.floor(W / step), S = new Float32Array(G * G);
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const x = gx * step + (step >> 1), y = gy * step + (step >> 1);
    S[gy * G + gx] = Math.min(1, Math.max(0, (box(IT, x, y, r) - 0.4) / 0.3)) * Math.max(0, 1 - box(IB, x, y, r) * 4);
  }
  // crowns: strongest cells first, one tree per ~5.5 m, crown size from how much canopy surrounds it
  const cells = []; for (let i = 0; i < G * G; i++) if (S[i] > 0.4) cells.push(i);
  cells.sort((a, b) => S[b] - S[a]);
  const cs = step * m, minD = 5.5 / cs, taken = new Uint8Array(G * G), out = [], rr = Math.ceil(minD);
  const cap = mobile ? 6000 : 16000;
  for (const i of cells) {
    if (taken[i]) continue;
    const gx = i % G, gy = (i / G) | 0;
    let cover = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= G || y >= G) continue; n++; if (S[y * G + x] > 0.2) cover++; }
    if (cover / n < 0.25) continue;                        // a lone rough green speck, not a crown
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) { const x = gx + dx, y = gy + dy; if (x >= 0 && y >= 0 && x < G && y < G && dx * dx + dy * dy <= minD * minD) taken[y * G + x] = 1; }
    const wx = (gx + 0.5) * cs - half, wz = (gy + 0.5) * cs - half;   // canvas row 0 is north = -z
    out.push({ x: wx, z: wz, h: 7 + 11 * (cover / n) * (0.8 + 0.4 * S[i]), est: true, kind: -1 });
  }
  // over the budget: keep the crowns nearest the viewer
  if (out.length > cap) { out.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z)); out.length = cap; }
  return out;
}
