// Tileable 3D noise volumes for clouds: Perlin-Worley shape (64^3) and Worley detail (32^3).
function hash3(x, y, z, p) { x = ((x % p) + p) % p; y = ((y % p) + p) % p; z = ((z % p) + p) % p; let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function worley(x, y, z, cells) {
  const px = x * cells, py = y * cells, pz = z * cells, ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let md = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, cz = iz + k;
    const fx = cx + hash3(cx, cy, cz, cells), fy = cy + hash3(cx + 31, cy, cz, cells), fz = cz + hash3(cx, cy + 57, cz, cells);
    const d = (fx - px) ** 2 + (fy - py) ** 2 + (fz - pz) ** 2; if (d < md) md = d;
  }
  return Math.min(1, Math.sqrt(md));
}
function grad(ix, iy, iz, p, x, y, z) {
  const h = Math.floor(hash3(ix, iy, iz, p) * 12);
  const g = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]][h];
  return g[0] * x + g[1] * y + g[2] * z;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
function perlin(x, y, z, p) {
  const X = x * p, Y = y * p, Z = z * p, ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z), fx = X - ix, fy = Y - iy, fz = Z - iz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(grad(ix, iy, iz, p, fx, fy, fz), grad(ix + 1, iy, iz, p, fx - 1, fy, fz), u), l(grad(ix, iy + 1, iz, p, fx, fy - 1, fz), grad(ix + 1, iy + 1, iz, p, fx - 1, fy - 1, fz), u), v),
    l(l(grad(ix, iy, iz + 1, p, fx, fy, fz - 1), grad(ix + 1, iy, iz + 1, p, fx - 1, fy, fz - 1), u), l(grad(ix, iy + 1, iz + 1, p, fx, fy - 1, fz - 1), grad(ix + 1, iy + 1, iz + 1, p, fx - 1, fy - 1, fz - 1), u), v), w);
}
const remap = (v, a, b, c, d) => c + (v - a) / (b - a) * (d - c);
onmessage = () => {
  const N = 64, shape = new Uint8Array(N * N * N * 4);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    let pf = 0, a = 1, s = 0; for (let o = 0; o < 4; o++) { pf += perlin(u, v, w, 4 << o) * a; s += a; a *= 0.5; }
    pf = pf / s * 0.5 + 0.5;
    const w1 = 1 - worley(u, v, w, 4), w2 = 1 - worley(u, v, w, 8), w3 = 1 - worley(u, v, w, 16), w4 = 1 - worley(u, v, w, 32);
    const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    const pw = Math.max(0, Math.min(1, remap(pf, 0, 1, wf, 1)));
    const k = ((z * N + y) * N + x) * 4;
    shape[k] = pw * 255; shape[k + 1] = (w2 * 0.625 + w3 * 0.25 + w4 * 0.125) * 255; shape[k + 2] = (w3 * 0.75 + w4 * 0.25) * 255; shape[k + 3] = pf * 255;
  }
  const M = 32, detail = new Uint8Array(M * M * M * 4);
  for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const u = x / M, v = y / M, w = z / M;
    const a = 1 - worley(u, v, w, 4), b = 1 - worley(u, v, w, 8), c = 1 - worley(u, v, w, 16);
    const k = ((z * M + y) * M + x) * 4;
    detail[k] = (a * 0.625 + b * 0.25 + c * 0.125) * 255; detail[k + 1] = b * 255; detail[k + 2] = c * 255; detail[k + 3] = 255;
  }
  postMessage({ shape, detail, N, M }, [shape.buffer, detail.buffer]);
};
