// Best astrophotography sites: weighs clouds (multi-model), darkness (whole sky), moon, fog, transparency,
// seeing, snow, road conditions and drive time with traffic.
import { destination, clamp, mean, haversine } from './util.js';
import { gridForecast, airQualityGrid, val, fogRisk } from './weather.js';
import { quickLP, QUICK, NAT_SKY, lum2mag, bortle } from './lightpol.js';
import { driveTable, congestion, roadWeatherFactor, roadHazards, route } from './routing.js';

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
  const W = { clear: 0.40, dark: 0.25, transp: 0.08, fog: 0.08, seeing: 0.04, roads: 0.07, drive: 0.08, ...weights };
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
      p, elev: S.elevation, clear: clearScore, spread: sp / hours.length, fog, transp, aod, rh, seeing, jet, sqm, bortle: bortle(sqm), horGlow, lpAz: lp && lp.az,
      snowDepth, snowfall, roadK, hazards, T, wind, perHour, score0, dist: haversine(home[0], home[1], p[0], p[1]) / 1000,
    };
  }).filter(Boolean);
  // Drive times for the best half
  res.sort((a, b) => b.score0 - a.score0);
  const top = res.slice(0, Math.min(60, res.length));
  progress('Getting driving times…');
  const dt = await driveTable(home, top.map(r => r.p));
  const cong = congestion(departLocal || new Date());
  const maxH = opts.maxDriveH || radiusKm / 70;
  top.forEach((r, i) => {
    const d = dt[i];
    r.drive = d ? d.dur : null; r.roadDist = d ? d.dist : null;
    // Estimated traffic: congestion applies to the urban share of the trip (bright start area).
    const urbanShare = clamp(Math.log10(1 + (regional ? quickLP(regional, home[0], home[1]).zen * QUICK.zen / NAT_SKY : 1)) / 1.5, 0, 0.8);
    r.driveTraffic = r.drive != null ? r.drive * (1 + (cong - 1) * urbanShare * Math.min(1, 25000 / Math.max(5000, r.roadDist || 1))) * r.roadK : null;
    const hrs = r.driveTraffic != null ? r.driveTraffic / 3600 : r.dist / 60;
    r.reachable = r.drive != null && hrs <= maxH * 1.15;
    r.driveScore = clamp(1 - hrs / (maxH * 1.3), 0, 1);
    r.score = Math.round(100 * (r.score0 + W.drive * r.driveScore) * (r.reachable ? 1 : 0.6));
  });
  top.sort((a, b) => b.score - a.score);
  // Refine the leaders with full routes: congestion where the route crosses bright (urban) areas.
  progress('Checking routes for traffic…');
  const urban = urbanLookup(regional);
  for (const r of top.slice(0, 6)) {
    try {
      const rt = await route(home, r.p, departLocal || new Date(), urban, () => r.roadK);
      r.route = rt; r.driveTraffic = rt.dur; r.drive = rt.free;
      const hrs = rt.dur / 3600; r.reachable = hrs <= maxH * 1.15; r.driveScore = clamp(1 - hrs / (maxH * 1.3), 0, 1);
      r.score = Math.round(100 * (r.score0 + W.drive * r.driveScore) * (r.reachable ? 1 : 0.6));
    } catch { }
  }
  top.sort((a, b) => b.score - a.score);
  return { sites: top, hours, moonW, others: res.slice(top.length) };
}

// 0..1 urban-ness from night-light radiance, on a 0.05 degree lookup grid.
export function urbanLookup(L) {
  if (!L) return () => 0;
  const g = new Map();
  for (let i = 0; i < L.pts.length; i += 5) { const k = Math.round(L.pts[i] * 20) + ',' + Math.round(L.pts[i + 1] * 20); g.set(k, Math.max(g.get(k) || 0, L.pts[i + 4])); }
  return (la, lo) => clamp(Math.log10(1 + (g.get(Math.round(la * 20) + ',' + Math.round(lo * 20)) || 0)) / 1.7 - 0.2, 0, 1);
}
