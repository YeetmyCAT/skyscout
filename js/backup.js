// Backup forecasts for when Open-Meteo's free quota is used up.
//  - MET Norway Locationforecast: worldwide, ECMWF-based (MEPS in the Nordics), no daily cap (fair use ~20 requests/s).
//  - US National Weather Service gridpoints (National Blend of Models) inside the US.
// Lower quality than the 7-model mean: one or two sources, no cloud amounts by pressure level, no CAPE, no snow depth.
// Fields the backup lacks are filled from the last saved Open-Meteo forecast when there is one.
import { cachedJSON, mean, std } from './util.js';

function zoneAt(lat, lon) { try { return typeof tzlookup === 'function' ? tzlookup(lat, lon) : undefined; } catch { return undefined; } }
function zoneOffset(tz, lon) {
  if (!tz) return Math.round(lon / 15) * 3600;
  try { const d = new Date(), f = z => new Date(d.toLocaleString('en-US', { timeZone: z })); return Math.round((f(tz) - f('UTC')) / 1000); }
  catch { return Math.round(lon / 15) * 3600; }
}
export const BACKUP_NAMES = { met_norway: 'MET Norway (ECMWF-based)', nws: 'US National Weather Service (NBM)' };
const MET = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const TTL = 45 * 60e3;

// MET Norway weather symbol -> WMO code (what the rest of the app reads)
function wmoFromSymbol(s) {
  if (!s) return null;
  s = s.replace(/_(day|night|polartwilight)$/, '');
  if (/thunder/.test(s)) return /snow|sleet/.test(s) ? 95 : /heavy/.test(s) ? 96 : 95;
  const shower = /showers/.test(s), lvl = /^light/.test(s) ? 0 : /^heavy/.test(s) ? 2 : 1;
  if (/snow/.test(s)) return shower ? (lvl === 2 ? 86 : 85) : [71, 73, 75][lvl];
  if (/sleet/.test(s)) return shower ? 81 : [61, 63, 65][lvl];
  if (/rain/.test(s)) return shower ? [80, 81, 82][lvl] : [61, 63, 65][lvl];
  return { clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45 }[s] ?? null;
}

// MET Norway throttles bursts (and its throttle reply has no CORS header, so the browser just sees a failure):
// at most 3 requests in flight, started >= 180 ms apart, with two retries.
let inFlight = 0, lastStart = 0; const waiters = [];
async function metSlot() {
  while (inFlight >= 3) await new Promise(r => waiters.push(r));
  inFlight++;
  const wait = lastStart + 180 - Date.now(); lastStart = Math.max(Date.now(), lastStart + 180);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
const metDone = () => { inFlight--; const w = waiters.shift(); if (w) w(); };
async function metJSON(key, url) {
  for (let attempt = 0; ; attempt++) {
    await metSlot();
    try { return await cachedJSON(key, url, TTL, { timeout: 25000, quiet: true }); }
    catch (e) { if (attempt >= 2) throw e; }
    finally { metDone(); }
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1) ** 2));
  }
}
async function metSeries(lat, lon) {
  const url = `${MET}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const r = await metJSON(`met:${lat.toFixed(3)},${lon.toFixed(3)}`, url);
  const ts = r.data.properties.timeseries, v = {}, t = [];
  const put = (k, i, x) => { (v[k] || (v[k] = []))[i] = x ?? null; };
  ts.forEach((e, i) => {
    t.push(Date.parse(e.time) / 1000);
    const d = e.data.instant.details, n1 = e.data.next_1_hours, n6 = e.data.next_6_hours, n12 = e.data.next_12_hours;
    const T = d.air_temperature, pr = n1 ? n1.details.precipitation_amount : n6 ? n6.details.precipitation_amount / 6 : null;
    const sym = (n1 || n6 || n12 || {}).summary?.symbol_code, code = wmoFromSymbol(sym);
    const fog = (d.fog_area_fraction ?? 0) / 100;
    const snowy = code != null && code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82 || (T != null && T < 0.5);
    put('temperature_2m', i, T); put('dew_point_2m', i, d.dew_point_temperature); put('relative_humidity_2m', i, d.relative_humidity);
    put('cloud_cover', i, d.cloud_area_fraction); put('cloud_cover_low', i, d.cloud_area_fraction_low);
    put('cloud_cover_mid', i, d.cloud_area_fraction_medium); put('cloud_cover_high', i, d.cloud_area_fraction_high);
    put('visibility', i, 24000 * (1 - fog) + 300 * fog);
    put('precipitation', i, pr); put('rain', i, pr == null ? null : snowy ? 0 : pr); put('showers', i, 0);
    put('snowfall', i, pr == null ? null : snowy ? pr * 0.7 : 0);            // cm of snow from mm of water
    put('weather_code', i, code === 45 || fog > 0.5 ? 45 : code);
    put('wind_speed_10m', i, d.wind_speed != null ? d.wind_speed * 3.6 : null); put('wind_direction_10m', i, d.wind_from_direction);
    put('wind_gusts_10m', i, d.wind_speed_of_gust != null ? d.wind_speed_of_gust * 3.6 : d.wind_speed != null ? d.wind_speed * 3.6 * 1.5 : null);
    put('surface_pressure', i, d.air_pressure_at_sea_level);
  });
  const elev = r.data.geometry.coordinates[2] ?? 0;
  if (v.surface_pressure) v.surface_pressure = v.surface_pressure.map(p => p == null ? null : p * Math.exp(-elev / 8400));
  return { t, v, elevation: elev, fetched: r.t };
}

// ISO-8601 duration ("PT3H", "P1DT6H") in hours
const durH = s => { const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(s) || []; return (+m[1] || 0) * 24 + (+m[2] || 0) || 1; };
const inUS = (lat, lon) => (lat > 24 && lat < 50 && lon > -125 && lon < -66) || (lat > 51 && lat < 72 && lon > -170 && lon < -129) || (lat > 18 && lat < 23 && lon > -161 && lon < -154) || (lat > 17.8 && lat < 18.6 && lon > -67.4 && lon < -65.2);

async function nwsSeries(lat, lon) {
  if (!inUS(lat, lon)) return null;
  const p = await cachedJSON(`nwsp:${lat.toFixed(3)},${lon.toFixed(3)}`, `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, 30 * 864e5, { timeout: 20000, quiet: true });
  const gurl = p.data.properties.forecastGridData;
  const g = await cachedJSON(`nws:${gurl}`, gurl, TTL, { timeout: 25000, quiet: true });
  const P = g.data.properties;
  // expand "valid for N hours" periods to hourly values; amounts are spread evenly over their period
  const hourly = (f, amount) => {
    const m = new Map();
    for (const x of (P[f] && P[f].values) || []) {
      const [a, d] = x.validTime.split('/'), t0 = Date.parse(a) / 1000, n = durH(d);
      for (let h = 0; h < n; h++) m.set(t0 + h * 3600, x.value == null ? null : amount ? x.value / n : x.value);
    }
    return m;
  };
  const F = { temperature_2m: hourly('temperature'), dew_point_2m: hourly('dewpoint'), relative_humidity_2m: hourly('relativeHumidity'), cloud_cover: hourly('skyCover'),
    wind_speed_10m: hourly('windSpeed'), wind_direction_10m: hourly('windDirection'), wind_gusts_10m: hourly('windGust'),
    precipitation: hourly('quantitativePrecipitation', true), snowfall: hourly('snowfallAmount', true), thunder: hourly('probabilityOfThunder'), pop: hourly('probabilityOfPrecipitation'),
    visibility: hourly('visibility') };
  // fog and precipitation type from the worded forecast
  const wx = new Map();
  for (const x of (P.weather && P.weather.values) || []) {
    const [a, d] = x.validTime.split('/'), t0 = Date.parse(a) / 1000, n = durH(d);
    const w = (x.value || []).filter(o => o && o.weather && !/slight_chance/.test(o.coverage || '')).map(o => o.weather).join(' ');
    for (let h = 0; h < n; h++) wx.set(t0 + h * 3600, w);
  }
  const keys = [...F.temperature_2m.keys()].sort((a, b) => a - b), v = {};
  for (const k of Object.keys(F)) if (!['thunder', 'pop'].includes(k)) v[k] = keys.map(t => F[k].get(t) ?? null);
  v.snowfall = v.snowfall.map(x => x == null ? null : x / 10);                 // mm -> cm
  v.rain = keys.map((t, i) => Math.max(0, (v.precipitation[i] ?? 0) - (v.snowfall[i] ?? 0) * 0.7));
  v.showers = keys.map(() => 0);
  v.weather_code = keys.map((t, i) => {
    const w = wx.get(t) || '', th = F.thunder.get(t) ?? 0, pr = v.precipitation[i] ?? 0, sc = v.cloud_cover[i] ?? 0, pop = F.pop.get(t) ?? 0;
    if (th >= 40 || /thunder/.test(w)) return 95;
    if (/fog/.test(w)) return /freezing/.test(w) ? 48 : 45;
    if (pop >= 40 && pr > 0.02) { const lv = pr > 4 ? 2 : pr > 1 ? 1 : 0; if (/snow/.test(w) || (v.snowfall[i] ?? 0) > 0.05) return [71, 73, 75][lv]; if (/freezing/.test(w)) return 66; return /showers/.test(w) ? [80, 81, 82][lv] : [61, 63, 65][lv]; }
    return sc < 12 ? 0 : sc < 40 ? 1 : sc < 75 ? 2 : 3;
  });
  return { t: keys, v, fetched: g.t, tz: p.data.properties.timeZone };
}

// linear resample of an irregular series onto hourly times (null outside its range; codes take the latest value)
function resample(ts, a, tt, step) {
  const out = new Array(tt.length).fill(null); let j = 0;
  for (let i = 0; i < tt.length; i++) {
    const t = tt[i]; if (t < ts[0] || t > ts[ts.length - 1]) continue;
    while (j < ts.length - 2 && ts[j + 1] <= t) j++;
    const x0 = a[j], x1 = a[j + 1] ?? x0, f = ts[j + 1] > ts[j] ? (t - ts[j]) / (ts[j + 1] - ts[j]) : 0;
    out[i] = step || x0 == null || x1 == null ? (f < 0.999 ? x0 : x1) ?? x1 : x0 + (x1 - x0) * f;
  }
  return out;
}

// A forecast in the same shape weather.js produces: {t, v:{var:{mean, spread, models}}, models, ...}
// `saved` is an older parsed Open-Meteo forecast for the same spot (optional).
export async function backupForecast(lat, lon, saved, opts = {}) {
  const [met, nws] = await Promise.all([metSeries(lat, lon).catch(e => (console.warn('MET Norway', e), null)), opts.nws === false ? null : nwsSeries(lat, lon).catch(() => null)]);
  const src = {}; if (met) src.met_norway = met; if (nws) src.nws = nws;
  if (!met && !nws) { const e = new Error('backup forecast unavailable'); throw e; }
  const all = Object.values(src), start = Math.min(...all.map(s => s.t[0])), end = Math.min(Math.max(...all.map(s => s.t[s.t.length - 1])), start + 4.5 * 86400);
  const t = []; for (let x = Math.floor(start / 3600) * 3600; x <= end; x += 3600) t.push(x);
  const names = new Set([...all.flatMap(s => Object.keys(s.v)), ...(saved ? Object.keys(saved.v) : [])]);
  const out = { t, v: {}, models: Object.keys(src), backup: true, filled: [], elevation: met ? met.elevation : saved ? saved.elevation : 0,
    fetched: Math.min(...all.map(s => s.fetched)), stale: false };
  // time zone: from NWS or the saved forecast, else an offline lookup by coordinates (tz-lookup)
  out.tz = (nws && nws.tz) || (saved && saved.tz) || zoneAt(lat, lon);
  out.utcOffset = saved && saved.tz === out.tz ? saved.utcOffset : zoneOffset(out.tz, lon);
  for (const name of names) {
    const per = {}, step = name === 'weather_code';
    for (const [m, s] of Object.entries(src)) if (s.v[name] && s.v[name].some(x => x != null)) per[m] = resample(s.t, s.v[name], t, step);
    if (!Object.keys(per).length && saved && saved.v[name]) {   // e.g. snow depth, CAPE, cloud heights: keep the saved multi-model values
      per.saved = resample(saved.t, saved.v[name].mean, t, step); out.filled.push(name);
    }
    if (!Object.keys(per).length) continue;
    const ms = Object.values(per), mn = new Array(t.length), sp = new Array(t.length);
    for (let i = 0; i < t.length; i++) {
      const col = ms.map(a => a[i]);
      if (step) { const c = col.filter(x => x != null); mn[i] = c.length ? Math.max(...c) : null; sp[i] = 0; continue; }
      mn[i] = mean(col); sp[i] = std(col);
    }
    out.v[name] = { mean: mn, spread: sp, models: per };
  }
  if (!out.v.cloud_cover) throw new Error('backup forecast incomplete');
  return out;
}

// Many points (map overlay, scouting, storms): MET Norway only, on a coarser grid so it stays a few dozen requests.
export async function backupGrid(points, max = 49) {
  let r = 0.1, keyOf, uniq;
  for (; ; r *= 2) {
    keyOf = p => `${Math.round(p[0] / r) * r},${Math.round(p[1] / r) * r}`;
    uniq = new Map(); for (const p of points) uniq.set(keyOf(p), [Math.round(p[0] / r) * r, Math.round(p[1] / r) * r]);
    if (uniq.size <= max || r > 3) break;
  }
  const res = new Map(), list = [...uniq.entries()];
  let k = 0;
  const worker = async () => { while (k < list.length) { const [key, [la, lo]] = list[k++]; res.set(key, await backupForecast(la, lo, null, { nws: false }).catch(() => null)); } };
  await Promise.all(Array.from({ length: 3 }, worker));
  const any = [...res.values()].find(Boolean);
  if (!any) throw new Error('backup forecast unavailable');
  return points.map(p => res.get(keyOf(p)) || any);
}
