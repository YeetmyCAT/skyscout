// Space weather and moving sky objects:
// - Aurora from NOAA SWPC planetary Kp (observed and 3-day forecast): oval position and brightness.
// - The brightest satellites (CelesTrak "visual" group, ~150 objects) propagated with SGP4 (satellite.js),
//   shown only when sunlit, with magnitudes from range and phase.
// - Meteors: sporadic background plus the major showers (IMO calendar values), rates scaled by radiant
//   altitude and limiting magnitude (so light pollution hides most of them).
import { cachedJSON, DEG } from './util.js';

// ---------------- Aurora ----------------
let kpCache = null;
export async function loadKp() {
  if (kpCache) return kpCache;
  const out = [];
  for (const u of ['https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json']) {
    try {
      const r = await cachedJSON('kp:' + u.slice(-30), u, 30 * 60e3, { timeout: 15000 });
      for (const row of r.data) {
        if (Array.isArray(row)) { if (row[0] === 'time_tag') continue; out.push({ t: Date.parse(row[0] + 'Z'), kp: +row[1] }); }
        else if (row && row.time_tag) out.push({ t: Date.parse(row.time_tag + 'Z'), kp: +(row.kp ?? row.Kp) });   // the observed feed spells it 'Kp', the forecast 'kp'
      }
    } catch { }
  }
  out.sort((a, b) => a.t - b.t);
  // one value per 3-hour slot (both feeds overlap): keep the first, i.e. the observed one
  const seen = new Set();
  kpCache = out.filter(x => isFinite(x.kp) && isFinite(x.t) && !seen.has(x.t) && seen.add(x.t));
  return kpCache;
}
export function kpAt(list, ms) {
  if (!list || !list.length) return null;
  let best = list[0]; for (const x of list) if (Math.abs(x.t + 90 * 60e3 - ms) < Math.abs(best.t + 90 * 60e3 - ms)) best = x;
  return Math.abs(best.t - ms) < 2 * 864e5 ? best.kp : null;
}
// Oval equatorward edge (magnetic latitude, deg), width and peak brightness (kR) for a Kp value.
export function auroraParams(kp) {
  // magnetic latitude of the main (brightest, poleward-border) arcs: ~64 deg at Kp 3, ~59 deg at Kp 6, ~54.6 deg at Kp 9.
  // At Kp 3 that leaves only a faint glow a few degrees above the northern horizon at ~55 deg (Upper Michigan),
  // aurora high up near Fairbanks (~65 deg). Brightness rises from a few kR when quiet to ~250 kR in severe storms.
  const center = 69 - 1.6 * kp, kR = 1.5 * Math.pow(10, kp / 4);
  return { center, edge: center, kR, red: Math.max(0, Math.min(1, (kp - 4) / 5)) };
}
// IGRF-2025 dipole north pole (geographic)
export const MAG_POLE = { lat: 80.8, lon: -72.7 };
export function ecef(lat, lon, hKm = 0) {
  const a = lat * DEG, b = lon * DEG, R = 6371 + hKm;
  return [R * Math.cos(a) * Math.cos(b), R * Math.cos(a) * Math.sin(b), R * Math.sin(a)];
}
// columns: east, north, up in Earth-fixed coordinates
export function enuBasis(lat, lon) {
  const a = lat * DEG, b = lon * DEG;
  return { e: [-Math.sin(b), Math.cos(b), 0], n: [-Math.sin(a) * Math.cos(b), -Math.sin(a) * Math.sin(b), Math.cos(a)], u: [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)] };
}
// ---- Probability of aurora (0-100 %, NOAA OVATION style) on a 1-degree grid: index (lat + 90) * 360 + (lon mod 360) ----
// Live OVATION nowcast from NOAA SWPC (valid about the next hour), cached for 10 minutes.
export async function loadOvation() {
  try {
    const r = await cachedJSON('ovation', 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', 10 * 60e3, { timeout: 20000, quiet: true });
    const g = new Uint8Array(360 * 181);
    for (const [lo, la, v] of r.data.coordinates) g[(la + 90) * 360 + ((lo % 360) + 360) % 360] = Math.min(100, v);
    return { t: Date.parse(r.data['Forecast Time']), grid: g, live: true };
  } catch { return null; }
}
// Stand-in for other times, fitted to OVATION: at Kp 3 the night-side peak is ~18 % near 70 deg magnetic latitude
// (10 % from ~66 deg); the oval moves equatorward and the chances rise with Kp (~64 % peak at Kp 6, ~100 % from Kp 7).
// The day side is ~3.5 deg further poleward and much weaker.
export function synthAurora(kp, ms) {
  const g = new Uint8Array(360 * 181), utcH = (ms / 3600e3) % 24;
  // severe storms push the oval much further than the linear trend (Kp saturates at 9: May 2024 reached ~45 deg)
  const Cm = 75 - 1.7 * kp - 0.6 * Math.max(0, kp - 6) ** 2, w = 3 + 0.6 * kp, pmax = Math.min(100, 5 * Math.pow(10, kp / 5.4));
  const A = ecef(MAG_POLE.lat, MAG_POLE.lon, -6370);
  const n = Math.hypot(...A); A[0] /= n; A[1] /= n; A[2] /= n;
  for (let la = -90; la <= 90; la++) {
    const cl = Math.cos(la * DEG), sl = Math.sin(la * DEG);
    for (let lo = 0; lo < 360; lo++) {
      const ml = Math.abs(Math.asin(cl * Math.cos(lo * DEG) * A[0] + cl * Math.sin(lo * DEG) * A[1] + sl * A[2])) / DEG;
      const lt = (utcH + (lo > 180 ? lo - 360 : lo) / 15 + 24) % 24, f = (1 + Math.cos(2 * Math.PI * lt / 24)) / 2;   // 1 at midnight
      const c = Cm + 3.5 * (1 - f), pm = pmax * (0.25 + 0.75 * f);
      g[(la + 90) * 360 + lo] = Math.round(pm * Math.exp(-(((ml - c) / w) ** 2)));
    }
  }
  return { t: ms, grid: g, live: false };
}
// Arc placement for an observer: probability-weighted magnetic latitude of the oval in their sector, its spread,
// and the highest chance within ~2000 km.
export function auroraOval(grid, lat, lon) {
  let sw = 0, sm = 0, sm2 = 0, near = 0;
  const hemi = lat >= 0 ? 1 : -1;
  for (let la = 40 * hemi; Math.abs(la) <= 89; la += hemi) for (let dl = -35; dl <= 35; dl++) {
    const lo = Math.round(lon) + dl, v = grid[(la + 90) * 360 + ((lo % 360) + 360) % 360]; if (!v) continue;
    const ml = Math.abs(magLat(la, lo)), w = v * v;
    sw += w; sm += w * ml; sm2 += w * ml * ml;
    const dkm = 111 * Math.hypot(la - lat, dl * Math.cos(lat * DEG));
    if (dkm < 2000) near = Math.max(near, v);
  }
  if (!sw) return { center: 70, spread: 3, near: 0 };
  const c = sm / sw, sd = Math.sqrt(Math.max(0, sm2 / sw - c * c));
  return { center: c, spread: Math.max(1, Math.min(4.5, sd * 0.7)), near };
}
export function magLat(lat, lon) {
  const p = ecef(MAG_POLE.lat, MAG_POLE.lon, -6371 + 1), q = ecef(lat, lon, -6371 + 1);
  return Math.asin(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) / DEG;
}

// ---------------- Satellites ----------------
// Intrinsic magnitudes (1000 km range, half lit) for well-known bright objects; others use a typical value.
const STDMAG = { 25544: -1.8, 48274: -1.0, 20580: 2.2, 25994: 3.4, 27424: 3.6, 28654: 4.0, 33591: 4.1, 37820: 1.0, 43013: 4.5, 39084: 4.4 };
let satCache = null;
export async function loadSatellites() {
  if (satCache) return satCache;
  const S = window.satellite; if (!S) return [];
  let text = null;
  try {
    const r = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle');
    if (r.ok) { text = await r.text(); try { localStorage.setItem('ss_tle', JSON.stringify({ t: Date.now(), text })); } catch { } }
  } catch { }
  if (!text) { try { text = JSON.parse(localStorage.getItem('ss_tle') || 'null')?.text; } catch { } }
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean), out = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i] && lines[i].trim(), l1 = lines[i + 1], l2 = lines[i + 2];
    if (!l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') continue;
    try { const rec = S.twoline2satrec(l1, l2); const id = +l1.slice(2, 7); out.push({ name, id, rec, std: STDMAG[id] ?? 4.2 }); } catch { }
  }
  satCache = out.slice(0, 160);
  return satCache;
}
// Sun direction in ECI (unit), low-precision almanac
function sunECI(date) {
  const n = (date.getTime() / 864e5 + 2440587.5) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG, eps = (23.439 - 4e-7 * n) * DEG;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}
// Positions for this instant: [{name, alt, az, mag}] for satellites above the horizon and in sunlight.
export function satellitesAt(sats, date, lat, lon, hM) {
  const S = window.satellite; if (!S || !sats.length) return [];
  const gmst = S.gstime(date), obs = { latitude: lat * DEG, longitude: lon * DEG, height: hM / 1000 };
  const sun = sunECI(date), obsEci = S.ecfToEci(S.geodeticToEcf(obs), gmst), out = [];
  for (const s of sats) {
    let pv; try { pv = S.propagate(s.rec, date); } catch { continue; }
    const r = pv && pv.position; if (!r || typeof r === 'boolean' || !isFinite(r.x)) continue;
    const la = S.ecfToLookAngles(obs, S.eciToEcf(r, gmst)), alt = la.elevation / DEG;
    if (alt < 0) continue;
    // Earth's shadow (cylinder)
    const dot = r.x * sun[0] + r.y * sun[1] + r.z * sun[2];
    if (dot < 0) { const px = r.x - dot * sun[0], py = r.y - dot * sun[1], pz = r.z - dot * sun[2]; if (Math.hypot(px, py, pz) < 6371) continue; }
    // phase angle at the satellite between the Sun and the observer
    const vx = obsEci.x - r.x, vy = obsEci.y - r.y, vz = obsEci.z - r.z, rng = Math.hypot(vx, vy, vz);
    const cph = (vx * sun[0] + vy * sun[1] + vz * sun[2]) / rng, ph = Math.acos(Math.max(-1, Math.min(1, cph)));
    const F = Math.max(1e-3, Math.sin(ph) + (Math.PI - ph) * Math.cos(ph));
    const mag = s.std + 5 * Math.log10(rng / 1000) - 2.5 * Math.log10(F);   // F = 1 when half lit (phase 90 deg)
    out.push({ name: s.name, alt, az: (la.azimuth / DEG + 360) % 360, mag, range: rng });
  }
  return out;
}

// ---------------- Meteors ----------------
// name, peak (month, day), ZHR, radiant RA/Dec (deg), activity half-width (days), speed km/s
export const SHOWERS = [
  ['Quadrantids', 1, 3.5, 80, 230, 49, 0.6, 41], ['Lyrids', 4, 22, 18, 271, 34, 1.3, 49], ['eta Aquariids', 5, 6, 50, 338, -1, 4, 66],
  ['Southern delta Aquariids', 7, 30, 25, 340, -16, 5, 41], ['alpha Capricornids', 7, 30, 5, 307, -10, 6, 23], ['Perseids', 8, 12.5, 100, 48, 58, 2.5, 59],
  ['Draconids', 10, 8.5, 10, 262, 54, 0.5, 20], ['Orionids', 10, 21, 20, 95, 16, 3, 66], ['Southern Taurids', 10, 10, 5, 32, 9, 12, 27],
  ['Northern Taurids', 11, 12, 5, 58, 22, 12, 29], ['Leonids', 11, 17, 15, 152, 22, 1.5, 71], ['Geminids', 12, 14, 150, 112, 33, 1.5, 35], ['Ursids', 12, 22, 10, 217, 76, 0.7, 33],
];
export function activeShowers(date) {
  const y = date.getUTCFullYear(), out = [];
  for (const [name, mo, day, zhr, ra, dec, w, v] of SHOWERS) {
    let best = 1e9;
    for (const yy of [y - 1, y, y + 1]) best = Math.min(best, Math.abs((date - Date.UTC(yy, mo - 1, Math.floor(day), (day % 1) * 24)) / 864e5));
    const z = zhr * Math.exp(-Math.pow(best / w, 2) * 0.7);
    if (z >= 0.5) out.push({ name, zhr: z, ra, dec, v });
  }
  return out;
}
