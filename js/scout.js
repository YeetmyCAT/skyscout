// Best astrophotography sites: weighs clouds (multi-model), darkness (whole sky), moon, fog, transparency,
// seeing, snow, road conditions and drive time with traffic.
import { destination, clamp, mean, haversine } from './util.js';
import { gridForecast, airQualityGrid, val, fogRisk } from './weather.js';
import { quickLP, QUICK, NAT_SKY, lum2mag, bortle } from './lightpol.js';
import { driveTable, congestion, roadWeatherFactor, roadHazards, route } from './routing.js';
import { atlasMany, ratioToSqm } from './atlas.js';
import { terrainHorizons, localObstructions, horizonScore, horizonWorst } from './horizon.js';
import { waterMany } from './terrain.js';

const SCOUT_VARS = ['temperature_2m', 'dew_point_2m', 'relative_humidity_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility',
  'precipitation', 'snowfall', 'snow_depth', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'wind_speed_250hPa'];

export function candidateGrid(home, radiusKm, n = 9) {
  const pts = [home.slice()], step = radiusKm / n;
  for (let r = 1; r <= n; r++) {
    const ring = Math.max(6, Math.round(2 * Math.PI * r));
    for (let k = 0; k < ring; k++) pts.push(destination(home[0], home[1], (k + (r % 2) * 0.5) / ring * 360, r * step * 1000));
  }
  return pts;
}

// night: from astro.nightInfo; regional: loadRegionalLights result
export async function scout(home, opts, progress = () => { }) {
  const { radiusKm = 150, night, regional, departLocal, weights = {} } = opts;
  const W = { clear: 0.36, dark: 0.22, horizon: 0.10, transp: 0.07, fog: 0.07, seeing: 0.04, roads: 0.06, drive: 0.08, ...weights };
  const n = radiusKm > 220 ? 8 : radiusKm > 120 ? 7 : 5;
  const pts = candidateGrid(home, radiusKm, n);
  progress(`Fetching forecasts for ${pts.length} sites from 3 models…`);
  const wx = await gridForecast(pts, `scout${home[0].toFixed(2)},${home[1].toFixed(2)}:${radiusKm}`, { vars: SCOUT_VARS, chunk: 50 });
  progress('Fetching aerosol forecast…');
  const aq = await airQualityGrid(pts);
  // Hours to evaluate: the dark window (or nautical night if no astronomical darkness)
  const t0 = (night.astroDusk || night.nautDusk || night.sunset || new Date()).getTime() / 1000;
  const t1 = (night.astroDawn || night.nautDawn || night.sunrise || new Date(Date.now() + 8 * 3600e3)).getTime() / 1000;
  const hours = []; for (let t = t0; t <= t1; t += 3600) hours.push(t);
  if (!hours.length) hours.push(t0);
  // Moon weight per hour (same for all sites): moonlit hours count less
  const moonW = hours.map(t => { const s = night.samples.reduce((b, x) => Math.abs(x.t / 1000 - t) < Math.abs(b.t / 1000 - t) ? x : b, night.samples[0] || { moonAlt: -10, moonFrac: 0 }); return s.moonAlt > 0 ? 1 - 0.75 * s.moonFrac * clamp(s.moonAlt / 25, 0.3, 1) : 1; });
  progress('Scoring darkness for every site…');
  const res = pts.map((p, i) => {
    const S = wx[i]; if (!S) return null;
    let cw = 0, cs = 0, sp = 0, best = null;
    const perHour = hours.map((t, k) => {
      const cc = val(S, 'cloud_cover', t) ?? 50, spread = val(S, 'cloud_cover', t, 'spread') ?? 20;
      const clear = 1 - cc / 100;
      cw += moonW[k]; cs += clear * moonW[k]; sp += spread;
      return { t, clear, cc, spread, fog: fogRisk(S, t) };
    });
    const clearScore = cs / cw;
    const fog = Math.max(...perHour.map(h => h.fog));
    const rh = mean(hours.map(t => val(S, 'relative_humidity_2m', t)));
    const aod = aq && aq[i] ? mean(hours.map(t => { const j = aq[i].t.findIndex(x => x >= t); return j >= 0 ? aq[i].aod[j] : null; })) : null;
    const transp = clamp(1 - ((aod ?? 0.15) - 0.05) / 0.45, 0, 1) * clamp(1 - (rh - 75) / 40, 0.4, 1);
    const jet = mean(hours.map(t => val(S, 'wind_speed_250hPa', t))) ?? 80; // km/h
    const seeing = clamp(1 - (jet - 60) / 140, 0, 1);
    const tMid = hours[Math.floor(hours.length / 2)];
    const snowDepth = val(S, 'snow_depth', tMid) ?? 0, snowfall = Math.max(...hours.map(t => val(S, 'snowfall', t) ?? 0));
    const precip = Math.max(...hours.map(t => val(S, 'precipitation', t) ?? 0)), T = val(S, 'temperature_2m', tMid) ?? 10;
    const vis = val(S, 'visibility', tMid), gust = val(S, 'wind_gusts_10m', tMid) ?? 0, code = val(S, 'weather_code', tMid);
    const roadK = roadWeatherFactor(snowfall, snowDepth, precip, T, vis, gust);
    const hazards = roadHazards(snowfall, snowDepth, precip, T, vis, gust, code);
    // Darkness: zenith and the brightest/average horizon, with snow brightening artificial glow
    let sqm = 21.9, horGlow = 0, lp = null;
    if (regional) {
      lp = quickLP(regional, p[0], p[1]);
      const snowK = 1 + 1.6 * clamp(snowDepth / 0.05, 0, 1);
      const zl = NAT_SKY + lp.zen * QUICK.zen * snowK;
      sqm = lum2mag(zl); horGlow = lp.hor * QUICK.hor * snowK / NAT_SKY;
    }
    const dark = clamp((sqm - 18.0) / 3.9, 0, 1) * 0.75 + clamp(1 - Math.log10(1 + horGlow) / 2, 0, 1) * 0.25;
    const wind = val(S, 'wind_speed_10m', tMid) ?? 0;
    const score0 = W.clear * clearScore * (1 - 0.25 * clamp(sp / hours.length / 40, 0, 1)) + W.dark * dark + W.transp * transp + W.fog * (1 - fog) + W.seeing * seeing + W.roads * clamp(2 - roadK, 0, 1);
    return {
      p, elev: S.elevation, darkS: dark, clear: clearScore, spread: sp / hours.length, fog, transp, aod, rh, seeing, jet, sqm, bortle: bortle(sqm), horGlow, lpAz: lp && lp.az,
      snowDepth, snowfall, roadK, hazards, T, wind, perHour, score0, dist: haversine(home[0], home[1], p[0], p[1]) / 1000,
    };
  }).filter(Boolean);
  // Drive times for every site; OSRM also snaps each site onto the nearest drivable road,
  // so no destination ends up in a lake or a field with no access.
  progress('Getting driving times and snapping sites to roads…');
  const dt = await driveTable(home, res.map(r => r.p));
  const cong = congestion(departLocal || new Date());
  const maxH = opts.maxDriveH || radiusKm / 70;
  const urbanHome = clamp(Math.log10(1 + (regional ? quickLP(regional, home[0], home[1]).zen * QUICK.zen / NAT_SKY : 1)) / 1.5, 0, 0.8);
  let all = res.map((r, i) => {
    const d = dt[i]; if (!d || !d.snap) return null;
    if (opts.allowOffRoad) {
      // keep the dark spot itself; drive to the nearest road point and walk the rest (up to 3 km)
      if (d.snapDist > 3000) return null;
      r.parkAt = d.snap; r.walk = d.snapDist;
    } else {
      if (d.snapDist > 2500) return null;   // water, or nowhere near a road
      r.p = d.snap; r.parkAt = d.snap; r.walk = 0;
    }
    r.snapDist = d.snapDist;
    r.dist = haversine(home[0], home[1], r.p[0], r.p[1]) / 1000;
    r.drive = d.dur; r.roadDist = d.dist;
    r.driveTraffic = r.drive * (1 + (cong - 1) * urbanHome * Math.min(1, 25000 / Math.max(5000, r.roadDist || 1))) * r.roadK;
    return r;
  }).filter(Boolean);
  // Walk-in spots: drop any that sit on open water (aerial photo colour)
  if (opts.allowOffRoad) {
    progress('Checking walk-in spots for water…');
    const wet = await waterMany(all.filter(r => r.walk > 60).map(r => r.p));
    let k = 0; all = all.filter(r => !(r.walk > 60 && wet[k++]));
  }
  // Darkness at the snapped spot from the light pollution atlas (VIIRS); horizon glow from the regional model.
  progress('Reading the light pollution atlas…');
  const at = await atlasMany(all.map(r => r.p)).catch(() => []);
  all.forEach((r, i) => {
    const snowK = 1 + 1.5 * clamp(r.snowDepth / 0.05, 0, 1);
    if (at[i]) { r.sqm = ratioToSqm(at[i].ratio * snowK); r.atlas = true; }
    else if (regional) r.sqm = lum2mag(NAT_SKY + quickLP(regional, r.p[0], r.p[1]).zen * QUICK.zen * snowK);
    r.bortle = bortle(r.sqm);
    r.darkS = clamp((r.sqm - 18.0) / 3.9, 0, 1) * 0.75 + clamp(1 - Math.log10(1 + r.horGlow) / 2, 0, 1) * 0.25;
  });
  const scoreOf = r => {
    const hrs = r.driveTraffic / 3600;
    r.reachable = hrs <= maxH * 1.15; r.driveScore = clamp(1 - hrs / (maxH * 1.3), 0, 1);
    const hz = r.horizon ?? 0.6;
    r.score = Math.round(100 * (W.clear * r.clear * (1 - 0.25 * clamp(r.spread / 40, 0, 1)) + W.dark * r.darkS + W.horizon * hz + W.transp * r.transp + W.fog * (1 - r.fog) + W.seeing * r.seeing + W.roads * clamp(2 - r.roadK, 0, 1) + W.drive * r.driveScore) * (r.reachable ? 1 : 0.6));
  };
  all.forEach(scoreOf);
  // Horizon check for the strongest candidates overall and for each single trait.
  progress('Checking the horizon at the best sites (terrain, forests, buildings)…');
  const pick = new Set();
  const byK = (k, n, asc) => [...all].filter(r => r.reachable).sort((a, b) => asc ? a[k] - b[k] : b[k] - a[k]).slice(0, n).forEach(r => pick.add(r));
  byK('score', 24); byK('darkS', 10); byK('clear', 10); byK('transp', 4); byK('driveTraffic', 4, true);
  const chk = [...pick];
  const [tz, lo] = await Promise.all([terrainHorizons(home, radiusKm, chk.map(r => r.p)), localObstructions(chk.map(r => r.p))]);
  chk.forEach((r, i) => { r.horizon = horizonScore(tz[i], lo[i]); r.horizonWorst = horizonWorst(tz[i], lo[i]); r.hzTerrain = tz[i]; r.hzLocal = lo[i]; scoreOf(r); });
  all.sort((a, b) => b.score - a.score);
  // Refine the leaders with full routes: congestion where the route crosses bright (urban) areas.
  progress('Checking routes for traffic…');
  const urban = urbanLookup(regional);
  for (const r of all.slice(0, 6)) {
    try {
      const rt = await route(home, r.p, departLocal || new Date(), urban, () => r.roadK);
      r.route = rt; r.driveTraffic = rt.dur; r.drive = rt.free; scoreOf(r);
    } catch { }
  }
  all.sort((a, b) => b.score - a.score);
  return { sites: all, hours, moonW, others: [] };
}

// 0..1 urban-ness from night-light radiance, on a 0.05 degree lookup grid.
export function urbanLookup(L) {
  if (!L) return () => 0;
  const g = new Map();
  for (let i = 0; i < L.pts.length; i += 5) { const k = Math.round(L.pts[i] * 20) + ',' + Math.round(L.pts[i + 1] * 20); g.set(k, Math.max(g.get(k) || 0, L.pts[i + 4])); }
  return (la, lo) => clamp(Math.log10(1 + (g.get(Math.round(la * 20) + ',' + Math.round(lo * 20)) || 0)) / 1.7 - 0.2, 0, 1);
}
