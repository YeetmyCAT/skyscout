// Astronomy: Sun, Moon, planets, sky rotation and night timing, using astronomy-engine (global `Astronomy`).
const A = () => window.Astronomy;
export const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

export function observer(lat, lon, h = 0) { return new (A().Observer)(lat, lon, h); }

export function bodyHor(body, date, obs, refr = true) {
  const eq = A().Equator(body, date, obs, true, true);
  const hor = A().Horizon(date, obs, eq.ra, eq.dec, refr ? 'normal' : null);
  return { alt: hor.altitude, az: hor.azimuth, ra: eq.ra, dec: eq.dec, dist: eq.dist };
}

// Unit vector in the app's world frame (x east, y up, z south) from alt/az in degrees.
export function altAzToVec(alt, az) {
  const a = alt * Math.PI / 180, z = az * Math.PI / 180;
  return [Math.cos(a) * Math.sin(z), Math.sin(a), -Math.cos(a) * Math.cos(z)];
}
export function vecToAltAz(x, y, z) {
  const alt = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
  let az = Math.atan2(x, -z) * 180 / Math.PI; if (az < 0) az += 360;
  return { alt, az };
}

// 3x3 matrix (row-major array of 9) taking J2000 equatorial unit vectors to world (x east, y up, z south).
export function eqjToWorld(date, obs) {
  const rot = A().Rotation_EQJ_HOR(date, obs), cols = [];
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const h = A().RotateVector(rot, new (A().Vector)(v[0], v[1], v[2], A().MakeTime(date)));
    cols.push([-h.y, h.z, -h.x]); // HOR is (north, west, zenith)
  }
  return [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
}

export function sunMoon(date, lat, lon, h = 0) {
  const obs = observer(lat, lon, h);
  const sun = bodyHor('Sun', date, obs), moon = bodyHor('Moon', date, obs);
  const ill = A().Illumination('Moon', date);
  const phase = A().MoonPhase(date); // 0 new, 90 first quarter, 180 full
  // Bright-limb orientation: position angle from the moon toward the sun on the sky.
  return { sun, moon, moonFrac: ill.phase_fraction, moonPhaseAngle: ill.phase_angle, moonMag: ill.mag, phase, moonDistKm: moon.dist * 149597870.7 };
}
export function planets(date, lat, lon, h = 0) {
  const obs = observer(lat, lon, h);
  return PLANETS.map(p => { const hp = bodyHor(p, date, obs); let mag = 6; try { mag = A().Illumination(p, date).mag; } catch { } return { name: p, alt: hp.alt, az: hp.az, mag }; });
}
export function phaseName(deg) {
  const n = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  return n[Math.round(deg / 45) % 8];
}

function search(fn) { try { const t = fn(); return t ? t.date : null; } catch { return null; } }

// Night timing for the night that starts on the local evening nearest `date`.
export function nightInfo(date, lat, lon, h = 0) {
  const obs = observer(lat, lon, h), Ast = A();
  // start from local noon (approx by longitude) before the evening
  // Local solar noon before the evening; morning hours belong to the previous night.
  const localHour = (date.getUTCHours() + date.getUTCMinutes() / 60 + lon / 15 + 48) % 24;
  const noon = new Date(date.getTime() - (localHour >= 12 ? localHour - 12 : localHour + 12) * 3600e3);
  const T = d => search(d);
  const r = {
    noon,
    sunset: T(() => Ast.SearchRiseSet('Sun', obs, -1, noon, 1.2)),
    civilDusk: T(() => Ast.SearchAltitude('Sun', obs, -1, noon, 1.2, -6)),
    nautDusk: T(() => Ast.SearchAltitude('Sun', obs, -1, noon, 1.2, -12)),
    astroDusk: T(() => Ast.SearchAltitude('Sun', obs, -1, noon, 1.2, -18)),
  };
  const after = r.sunset || noon;
  r.astroDawn = T(() => Ast.SearchAltitude('Sun', obs, +1, after, 1.2, -18));
  r.nautDawn = T(() => Ast.SearchAltitude('Sun', obs, +1, after, 1.2, -12));
  r.civilDawn = T(() => Ast.SearchAltitude('Sun', obs, +1, after, 1.2, -6));
  r.sunrise = T(() => Ast.SearchRiseSet('Sun', obs, +1, after, 1.2));
  r.moonrise = T(() => Ast.SearchRiseSet('Moon', obs, +1, noon, 1.5));
  r.moonset = T(() => Ast.SearchRiseSet('Moon', obs, -1, noon, 1.5));
  // Dark windows: sun below -18 and moon below horizon, sampled every 10 minutes.
  const start = r.astroDusk || r.nautDusk || r.sunset, end = r.astroDawn || r.nautDawn || r.sunrise;
  r.dark = []; r.samples = [];
  if (start && end) {
    let cur = null;
    for (let t = start.getTime(); t <= end.getTime(); t += 600e3) {
      const d = new Date(t), m = bodyHor('Moon', d, obs), s = bodyHor('Sun', d, obs);
      const frac = A().Illumination('Moon', d).phase_fraction;
      const moonUp = m.alt > -0.5;
      r.samples.push({ t, moonAlt: m.alt, moonFrac: frac, sunAlt: s.alt });
      const darkNow = s.alt < -17.5 && (!moonUp || frac < 0.08);
      if (darkNow && !cur) cur = { start: d }; if (!darkNow && cur) { cur.end = d; r.dark.push(cur); cur = null; }
    }
    if (cur) { cur.end = end; r.dark.push(cur); }
  }
  r.darkHours = r.dark.reduce((s, w) => s + (w.end - w.start) / 3600e3, 0);
  return r;
}

// Milky Way core (Sgr A*) and galactic plane helpers in J2000.
export const GAL_CENTER = { ra: 266.405, dec: -28.936 };
// Rotation matrix J2000 equatorial -> galactic (row-major).
export const EQ2GAL = [-0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.4448296300, 0.7469822445, -0.8676661490, -0.1980763734, 0.4559837762];
export function raDecVec(raDeg, decDeg) { const a = raDeg * Math.PI / 180, d = decDeg * Math.PI / 180; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; }
export const OBLIQ = 23.4393 * Math.PI / 180;
