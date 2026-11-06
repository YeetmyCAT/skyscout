// Light pollution sky-brightness integrator (runs in a Web Worker).
// Single scattering by molecules and aerosols of light emitted by every city pixel within ~300 km,
// on a curved Earth, with Garstang's city emission function. Output: artificial luminance per sky direction.
const R = 6371 / (1 - 0.13); // effective Earth radius with refraction, km

function emission(theta, G) { // per steradian, normalised so a city's total upward flux is ~1
  const F = 0.15;
  return (2 * G * (1 - F) * Math.cos(theta) + 0.554 * F * theta ** 4) / Math.PI;
}
// Optical depth along a straight path from height z0 to z1 (km) of length L for a scale height H.
function tau(k, H, z0, z1, L) {
  const dz = z1 - z0;
  if (Math.abs(dz) < 0.01) return k * L * Math.exp(-z0 / H);
  return k * L * H / dz * (Math.exp(-z0 / H) - Math.exp(-z1 / H));
}
const PR = c => 3 / (16 * Math.PI) * (1 + c * c);
function PA(c, g = 0.7) { return (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * c, 1.5)); }

onmessage = e => {
  const { sources, nAz, alts, aod, snow, cloudBase, obsZ } = e.data;
  const kR = 0.0116 * Math.exp(-obsZ / 8), kA = Math.max(0.02, aod) / 1.4 * Math.exp(-obsZ / 1.4);
  const G = 0.15 + 0.45 * snow; // ground reflectance rises with snow cover
  const ns = sources.length / 3;
  const sx = new Float32Array(ns), sy = new Float32Array(ns), sz = new Float32Array(ns), sf = new Float32Array(ns);
  for (let s = 0; s < ns; s++) {
    const d = sources[s * 3], az = sources[s * 3 + 1];
    sx[s] = d * Math.sin(az); sy[s] = d * Math.cos(az); sz[s] = -d * d / (2 * R); sf[s] = sources[s * 3 + 2];
  }
  const nAlt = alts.length, clear = new Float32Array(nAz * nAlt), cloud = new Float32Array(nAz * nAlt);
  // Steps along each ray, log-spaced from 30 m to 200 km.
  const NS = 26, xs = [], dxs = [];
  for (let i = 0; i < NS; i++) { const a = 0.03 * Math.pow(200 / 0.03, i / (NS - 1)), b = 0.03 * Math.pow(200 / 0.03, (i + 1) / (NS - 1)); xs.push((a + b) / 2); dxs.push(b - a); }
  for (let ia = 0; ia < nAz; ia++) {
    const A = ia / nAz * 2 * Math.PI, sa = Math.sin(A), ca = Math.cos(A);
    for (let ih = 0; ih < nAlt; ih++) {
      const h = Math.max(alts[ih], 0.2) * Math.PI / 180, sh = Math.sin(h), ch = Math.cos(h);
      const vx = ch * sa, vy = ch * ca, vz = sh;
      let B = 0, Bc = 0, cloudDone = false;
      for (let i = 0; i < NS; i++) {
        const x = xs[i], dx = dxs[i];
        const z = x * sh + x * x * ch * ch / (2 * R);
        if (z > 30) break;
        const px = x * vx, py = x * vy;
        const tObs = tau(kR, 8, 0, z, x) + tau(kA, 1.4, 0, z, x);
        if (tObs > 8) break;
        const eObs = Math.exp(-tObs);
        const sigR = kR * Math.exp(-z / 8), sigA = 0.9 * kA * Math.exp(-z / 1.4);
        // cloud base hit: luminance of a diffuse cloud underside lit by the city light
        const atCloud = !cloudDone && cloudBase > 0 && z >= cloudBase;
        let Ec = 0;
        let S = 0;
        for (let s = 0; s < ns; s++) {
          const rx = px - sx[s], ry = py - sy[s];
          const rho2 = rx * rx + ry * ry, rho = Math.sqrt(rho2);
          // z is P's true altitude; seen from the source it sits rho^2/2R lower because of curvature.
          const hgt = Math.max(z, 0.001);
          const r2 = rho2 + hgt * hgt, r = Math.sqrt(r2);
          const psi = Math.atan2(hgt - rho2 / (2 * R), rho);
          if (psi <= 0) continue;
          const theta = Math.PI / 2 - psi;
          const te = tau(kR, 8, 0, hgt, r) + tau(kA, 1.4, 0, hgt, r);
          if (te > 8) continue;
          const I = sf[s] * emission(theta, G) / r2 * Math.exp(-te);
          if (atCloud) { Ec += I * Math.max(0, Math.sin(psi)); continue; }
          const ux = rx / r, uy = ry / r, uz = hgt / r;
          const c = -(ux * vx + uy * vy + uz * vz);
          S += I * (sigR * PR(c) + sigA * PA(c));
        }
        if (atCloud) { Bc = B + 0.7 / Math.PI * Ec * eObs; cloudDone = true; }
        B += S * eObs * dx;
      }
      clear[ia * nAlt + ih] = B;
      cloud[ia * nAlt + ih] = cloudDone ? Bc : B;
    }
  }
  postMessage({ clear, cloud });
};
