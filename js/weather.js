// Multi-model weather from Open-Meteo: ensemble means, spread, cloud layers and cloud types.
import { cachedJSON, mean, std, clamp, RateLimit } from './util.js';
import { backupForecast, backupGrid, BACKUP_NAMES } from './backup.js';

const API = 'https://api.open-meteo.com/v1/forecast';
export const POINT_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'ukmo_seamless', 'meteofrance_seamless', 'jma_seamless'];
export const MODEL_NAMES = { ecmwf_ifs025: 'ECMWF IFS', gfs_seamless: 'NOAA GFS/HRRR', icon_seamless: 'DWD ICON', gem_seamless: 'Canada GEM', ukmo_seamless: 'UK Met Office', meteofrance_seamless: 'Météo-France', jma_seamless: 'JMA', ...BACKUP_NAMES };
export const GRID_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
export const LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150];

const SURF = ['temperature_2m', 'dew_point_2m', 'relative_humidity_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'visibility', 'precipitation', 'rain', 'showers', 'snowfall', 'snow_depth', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'cape', 'lifted_index', 'convective_inhibition', 'freezing_level_height', 'is_day', 'surface_pressure'];
const PL = [];
for (const p of LEVELS) PL.push(`cloud_cover_${p}hPa`, `temperature_${p}hPa`, `geopotential_height_${p}hPa`, `relative_humidity_${p}hPa`);
PL.push('wind_speed_250hPa', 'wind_direction_250hPa', 'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_500hPa', 'wind_direction_500hPa');

const GRID_VARS = ['temperature_2m', 'dew_point_2m', 'relative_humidity_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility',
  'precipitation', 'showers', 'snowfall', 'snow_depth', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'cape', 'lifted_index'];

const r4 = x => Math.round(x * 1e4) / 1e4;

// Turn an Open-Meteo multi-model response into {t:[unix], v:{var:{mean:[], spread:[], models:{m:[]}}}}
function parse(json, vars, models) {
  const h = json.hourly, t = h.time, out = { t, elevation: json.elevation, v: {}, models: [] };
  const used = new Set();
  for (const v of vars) {
    const per = {};
    for (const m of models) {
      const a = h[`${v}_${m}`] || (models.length === 1 ? h[v] : null);
      if (a && a.some(x => x != null)) { per[m] = a; used.add(m); }
    }
    const ms = Object.values(per), n = t.length, mn = new Array(n), sp = new Array(n);
    for (let i = 0; i < n; i++) {
      const col = ms.map(a => a[i]);
      if (v === 'weather_code') { mn[i] = worstCode(col); sp[i] = 0; continue; }
      mn[i] = mean(col); sp[i] = std(col);
    }
    out.v[v] = { mean: mn, spread: sp, models: per };
  }
  out.models = [...used];
  return out;
}
// Most significant WMO code reported by at least two models (or the only one).
function worstCode(col) {
  const c = col.filter(x => x != null); if (!c.length) return null;
  const counts = {}; for (const x of c) counts[x] = (counts[x] || 0) + 1;
  const sorted = Object.keys(counts).map(Number).sort((a, b) => b - a);
  for (const k of sorted) if (counts[k] >= Math.min(2, c.length) || k < 50) return k;
  return sorted[sorted.length - 1];
}

export const POINT_WEIGHT = POINT_MODELS.length * ([...SURF, ...PL].length) / 10 + 1;   // forecast + air quality, Open-Meteo's weighting
// A saved 7-model forecast younger than this beats the lower-quality backup.
const SAVED_OK = 3 * 3600e3;
export async function pointForecast(lat, lon, opts = {}) {
  const vars = [...SURF, ...PL];
  const key = `pt:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const url = `${API}?latitude=${r4(lat)}&longitude=${r4(lon)}&hourly=${vars.join(',')}&models=${POINT_MODELS.join(',')}&forecast_days=4&past_days=1&timezone=auto&timeformat=unixtime`;
  const finish = res => { const p = parse(res.data, vars, POINT_MODELS); p.tz = res.data.timezone; p.utcOffset = res.data.utc_offset_seconds; p.fetched = res.t; p.stale = res.stale; return p; };
  // Open-Meteo's free quota is used up: MET Norway (+ US NWS), with the saved forecast filling the gaps
  const backup = async saved => {
    if (saved && Date.now() - saved.t < SAVED_OK) return finish(saved);
    try { const b = await backupForecast(lat, lon, saved ? finish(saved) : null); b.savedAt = saved ? saved.t : null; return b; }
    catch (e) { if (saved) return finish(saved); const er = new Error('rate-limited'); er.rateLimited = true; throw er; }
  };
  let res;
  try { res = await cachedJSON(key, url, 45 * 60e3, opts); }
  catch (e) { // some regions reject a model: retry with the core three
    if (opts.cacheOnly) throw e;
    if (e.rateLimited) return backup(null);
    const url2 = url.replace(POINT_MODELS.join(','), GRID_MODELS.join(','));
    res = await cachedJSON(key, url2, 45 * 60e3);
  }
  if (res.stale && !opts.cacheOnly && RateLimit.waitMs() > 0) return backup(res);
  return finish(res);
}

// Many points at once (Open-Meteo accepts comma lists). Returns array of parsed series.
export async function gridForecast(points, tag, opts = {}) {
  const models = opts.models || GRID_MODELS, vars = opts.vars || GRID_VARS, out = [];
  const chunk = opts.chunk || 60;
  for (let i = 0; i < points.length; i += chunk) {
    const P = points.slice(i, i + chunk);
    const lat = P.map(p => r4(p[0])).join(','), lon = P.map(p => r4(p[1])).join(',');
    const url = `${API}?latitude=${lat}&longitude=${lon}&hourly=${vars.join(',')}&models=${models.join(',')}&forecast_days=4&past_days=1&timezone=GMT&timeformat=unixtime`;
    let res = null;
    try { res = await cachedJSON(`grid:${tag}:${i}`, url, 50 * 60e3, { timeout: 60000 }); }
    catch (e) { if (!e.rateLimited) throw e; }
    if (!res || (res.stale && RateLimit.waitMs() > 0 && Date.now() - res.t > SAVED_OK)) {
      // quota used up: MET Norway on a coarser grid (lower quality)
      try { out.push(...await backupGrid(P)); continue; }
      catch (e) { if (!res) throw e; }
    }
    const arr = Array.isArray(res.data) ? res.data : [res.data];
    for (const j of arr) { const p = parse(j, vars, models); p.fetched = res.t; p.stale = res.stale; out.push(p); }
  }
  return out;
}

export const AQ_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export async function airQuality(lat, lon, opts = {}) {
  const url = `${AQ_API}?latitude=${r4(lat)}&longitude=${r4(lon)}&hourly=aerosol_optical_depth,dust,pm2_5&forecast_days=4&past_days=1&timeformat=unixtime`;
  try { const r = await cachedJSON(`aq:${lat.toFixed(2)},${lon.toFixed(2)}`, url, 3 * 3600e3, opts); const h = r.data.hourly; return { t: h.time, aod: h.aerosol_optical_depth, dust: h.dust, pm: h.pm2_5 }; }
  catch { return null; }
}
export async function airQualityGrid(points) {
  const lat = points.map(p => r4(p[0])).join(','), lon = points.map(p => r4(p[1])).join(',');
  const url = `${AQ_API}?latitude=${lat}&longitude=${lon}&hourly=aerosol_optical_depth&forecast_days=4&past_days=1&timeformat=unixtime`;
  try { const r = await cachedJSON(`aqg:${lat.slice(0, 40)}:${points.length}`, url, 3 * 3600e3, { timeout: 60000 }); return (Array.isArray(r.data) ? r.data : [r.data]).map(j => ({ t: j.hourly.time, aod: j.hourly.aerosol_optical_depth })); }
  catch { return null; }
}

// ---- Sampling helpers ----
export function idxAt(series, unix) {
  const t = series.t; if (unix <= t[0]) return [0, 0, 0]; if (unix >= t[t.length - 1]) return [t.length - 1, t.length - 1, 0];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= unix) lo = m; else hi = m; }
  return [lo, hi, (unix - t[lo]) / (t[hi] - t[lo])];
}
export function val(series, v, unix, kind = 'mean') {
  const a = series.v[v] && series.v[v][kind]; if (!a) return null;
  const [i, j, f] = idxAt(series, unix);
  if (v === 'weather_code') return f < 0.5 ? a[i] : a[j];
  if (a[i] == null) return a[j]; if (a[j] == null) return a[i];
  return a[i] + (a[j] - a[i]) * f;
}
export function modelVal(series, v, m, unix) {
  const a = series.v[v] && series.v[v].models[m]; if (!a) return null;
  const [i, j, f] = idxAt(series, unix); if (a[i] == null || a[j] == null) return a[i] ?? a[j];
  return a[i] + (a[j] - a[i]) * f;
}

// Vertical profile at a time: heights (m MSL), temperature, cloud cover, RH per pressure level.
export function profile(series, unix) {
  const out = [];
  for (const p of LEVELS) {
    const z = val(series, `geopotential_height_${p}hPa`, unix);
    if (z == null) continue;
    out.push({ p, z, T: val(series, `temperature_${p}hPa`, unix), cc: val(series, `cloud_cover_${p}hPa`, unix), rh: val(series, `relative_humidity_${p}hPa`, unix) });
  }
  return out;
}
// Height (m MSL) where the profile reaches a temperature (for satellite cloud-top height).
export function heightForTemp(prof, Tc, surfT, surfZ) {
  const pts = [{ z: surfZ, T: surfT }, ...prof.filter(p => p.z > surfZ + 50 && p.T != null)];
  if (Tc >= pts[0].T) return surfZ;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((Tc <= a.T && Tc >= b.T) || (Tc >= a.T && Tc <= b.T)) { const f = (Tc - a.T) / ((b.T - a.T) || 1e-6); return a.z + (b.z - a.z) * f; }
    if (b.T > a.T && b.z > 11000) return b.z; // stratosphere: overshooting top at the tropopause
  }
  return pts[pts.length - 1].z;
}

// Cloud layers with heights and types, from the model profile and the low/mid/high split.
export function cloudLayers(series, unix, groundZ) {
  const prof = profile(series, unix);
  const get = v => val(series, v, unix) ?? 0;
  const low = get('cloud_cover_low'), mid = get('cloud_cover_mid'), high = get('cloud_cover_high');
  const cape = get('cape'), li = val(series, 'lifted_index', unix) ?? 5, pr = get('precipitation'), sh = get('showers');
  const T = get('temperature_2m'), Td = val(series, 'dew_point_2m', unix) ?? T - 5, code = get('weather_code');
  const zAt = p => { const l = prof.find(x => x.p === p); return l ? l.z : null; };
  // Base of low cloud: lifting condensation level, or the lowest cloudy model level.
  const lcl = groundZ + clamp(125 * (T - Td), 80, 3000);
  let lowBase = lcl, lowTop = Math.max(lcl + 400, zAt(850) || groundZ + 1500);
  const cloudy = prof.filter(l => l.cc != null && l.cc > 25);
  const lowLv = cloudy.filter(l => l.p >= 800);
  if (lowLv.length) { lowTop = Math.max(lowTop * 0.5 + (Math.max(...lowLv.map(l => l.z)) + 300) * 0.5, lowBase + 300); }
  const fog = (code === 45 || code === 48) ? 1 : 0;
  if (fog) lowBase = groundZ;
  // Convective character
  const conv = clamp((cape - 150) / 1200, 0, 1) * clamp((1 - li) / 5, 0, 1);
  const storm = (code >= 95 ? 1 : 0) * 0.7 + clamp((cape - 800) / 2000, 0, 1) * clamp((sh + pr - 0.5) / 4, 0, 1) * 0.6;
  const cumuliform = clamp(0.25 + conv * 0.9 - (low > 85 ? 0.35 : 0) - fog, 0, 1);
  const midBase = Math.max(lowTop + 300, zAt(700) || 3000), midTop = Math.max(midBase + 700, (zAt(500) || 5500) - 300);
  const z300 = zAt(300) || 9200, z200 = zAt(200) || 11800;
  const highBase = Math.max(midTop + 500, z300 - 900), highTop = Math.max(highBase + 600, z200);
  const tropo = Math.max(10500, (zAt(150) || 13500) - 800);
  const w = d => (val(series, `wind_direction_${d}hPa`, unix) ?? 270), ws = d => (val(series, `wind_speed_${d}hPa`, unix) ?? 30) / 3.6;
  return {
    low: { cover: low / 100, base: lowBase, top: lowTop, cumuliform, fog },
    mid: { cover: mid / 100, base: midBase, top: midTop, cumuliform: mid > 75 ? 0.15 : 0.6 },
    high: { cover: high / 100, base: highBase, top: highTop },
    storm: clamp(storm, 0, 1), tropopause: tropo, conv,
    windLow: { dir: w(850), speed: ws(850) }, windMid: { dir: w(500), speed: ws(500) }, windHigh: { dir: w(250), speed: ws(250) },
    precip: pr, snowfall: get('snowfall'), rain: get('rain'), code, profile: prof,
  };
}

// Plain-language name for the dominant clouds.
export function cloudTypeNames(L) {
  const n = [];
  if (L.low.fog) n.push('Fog');
  if (L.storm > 0.35) n.push('Cumulonimbus');
  if (L.low.cover > 0.1) n.push(L.low.cumuliform > 0.65 ? (L.conv > 0.5 ? 'Towering cumulus' : 'Cumulus') : L.low.cumuliform > 0.3 ? 'Stratocumulus' : (L.precip > 0.3 ? 'Nimbostratus' : 'Stratus'));
  if (L.mid.cover > 0.1) n.push(L.mid.cover > 0.75 ? 'Altostratus' : 'Altocumulus');
  if (L.high.cover > 0.1) n.push(L.high.cover > 0.7 ? 'Cirrostratus' : 'Cirrus');
  return n.length ? n : ['Clear'];
}

export const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};

// Precipitation type and rate at a time.
export function precipState(series, unix) {
  const code = val(series, 'weather_code', unix) ?? 0, pr = val(series, 'precipitation', unix) ?? 0, sn = val(series, 'snowfall', unix) ?? 0;
  const T = val(series, 'temperature_2m', unix) ?? 10;
  let type = 'none';
  if (pr > 0.05 || (code >= 51 && code <= 99)) type = (sn > 0.05 || (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82) || T < 0.5) ? 'snow' : 'rain';
  if ((code === 66 || code === 67 || code === 56 || code === 57)) type = 'freezing';
  const thunder = code >= 95 ? 1 : 0;
  return { type, rate: Math.max(pr, code >= 51 ? 0.2 : 0), thunder, code, T };
}

// Fog likelihood 0..1 from model hints.
export function fogRisk(series, unix) {
  const vis = val(series, 'visibility', unix), rh = val(series, 'relative_humidity_2m', unix) ?? 70;
  const T = val(series, 'temperature_2m', unix) ?? 10, Td = val(series, 'dew_point_2m', unix) ?? 0, ws = val(series, 'wind_speed_10m', unix) ?? 10;
  const code = val(series, 'weather_code', unix);
  let r = 0;
  if (code === 45 || code === 48) r = 0.9;
  if (vis != null) r = Math.max(r, clamp((3000 - vis) / 2500, 0, 1));
  const dd = T - Td;
  r = Math.max(r, clamp((2.5 - dd) / 2.5, 0, 1) * clamp((12 - ws) / 10, 0, 1) * clamp((rh - 88) / 10, 0, 1));
  return clamp(r, 0, 1);
}
