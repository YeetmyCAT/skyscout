// Driving times: OSRM (free, no traffic) with an estimated traffic model, or TomTom live traffic if a key is set.
import { cachedJSON, clamp } from './util.js';

const OSRM = 'https://router.project-osrm.org';
export const tomtomKey = () => { try { return localStorage.getItem('ss_tomtom') || ''; } catch { return ''; } };

// Typical congestion multiplier for urban roads by local weekday/hour (1 = free flow).
export function congestion(localDate) {
  const h = localDate.getHours() + localDate.getMinutes() / 60, wd = localDate.getDay();
  const weekend = wd === 0 || wd === 6;
  const bump = (c, w, a) => a * Math.exp(-(((h - c) / w) ** 2));
  if (weekend) return 1 + bump(13, 3, 0.25) + bump(18, 2, 0.15);
  return 1 + bump(8, 1.1, 0.55) + bump(17.3, 1.4, wd === 5 ? 0.85 : 0.7) + bump(12.5, 1.5, 0.15);
}

// Drive durations (s) from home to many destinations.
export async function driveTable(home, dests) {
  const out = new Array(dests.length).fill(null);
  for (let i = 0; i < dests.length; i += 90) {
    const D = dests.slice(i, i + 90);
    const coords = [home, ...D].map(p => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join(';');
    try {
      const r = await cachedJSON(`osrmt:${coords.length}:${coords.slice(0, 60)}:${coords.slice(-40)}`, `${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, 7 * 864e5, { timeout: 40000 });
      D.forEach((_, k) => { const d = r.data.durations?.[0]?.[k + 1], m = r.data.distances?.[0]?.[k + 1]; if (d != null) out[i + k] = { dur: d, dist: m }; });
    } catch { }
  }
  return out;
}

// Full route with geometry; urbanFn(lat,lon) -> 0..1 urban-ness used to apply estimated traffic.
export async function route(home, dest, departLocal, urbanFn, wx) {
  const key = tomtomKey();
  if (key) {
    try {
      const dep = new Date(Math.max(Date.now() + 60e3, departLocal.getTime())).toISOString().slice(0, 19);
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${home[0]},${home[1]}:${dest[0]},${dest[1]}/json?key=${encodeURIComponent(key)}&traffic=true&departAt=${dep}&routeRepresentation=polyline&computeTravelTimeFor=all`;
      const r = await cachedJSON(`tt:${home}:${dest}:${dep.slice(0, 13)}`, url, 10 * 60e3, { timeout: 20000 });
      const rt = r.data.routes[0], s = rt.summary;
      const line = rt.legs.flatMap(l => l.points.map(p => [p.latitude, p.longitude]));
      return { line, dur: s.travelTimeInSeconds, free: s.noTrafficTravelTimeInSeconds, delay: s.trafficDelayInSeconds, dist: s.lengthInMeters, source: 'TomTom live traffic' };
    } catch (e) { /* fall through to OSRM */ }
  }
  const url = `${OSRM}/route/v1/driving/${home[1]},${home[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson&annotations=duration`;
  const r = await cachedJSON(`osrm:${home}:${dest}`, url, 7 * 864e5, { timeout: 30000 });
  const rt = r.data.routes[0];
  const line = rt.geometry.coordinates.map(c => [c[1], c[0]]);
  const segDur = rt.legs[0].annotation?.duration || [];
  const f = congestion(departLocal);
  let dur = 0, t = 0; const segs = [];
  for (let i = 0; i < line.length - 1; i++) {
    const base = segDur[i] ?? rt.duration / line.length;
    const u = urbanFn ? urbanFn(line[i][0], line[i][1]) : 0;
    // congestion only bites in urban areas; weather slows everything
    const local = new Date(departLocal.getTime() + t * 1000);
    const k = 1 + (congestion(local) - 1) * u;
    const w = wx ? wx(line[i][0], line[i][1]) : 1;
    const d = base * k * w; dur += d; t += d;
    segs.push({ a: line[i], b: line[i + 1], k: k * w });
  }
  return { line, segs, dur, free: rt.duration, delay: dur - rt.duration, dist: rt.distance, source: 'OSRM + estimated traffic', peak: f };
}

// Weather slowdown factor for driving.
export function roadWeatherFactor(snowfallCm, snowDepthM, precipMm, T, vis, gust) {
  let k = 1;
  k += clamp(snowfallCm / 2, 0, 0.6);
  if (snowDepthM > 0.02 && T < 1) k += 0.15;
  if (precipMm > 0.2 && T < 0.5 && T > -3) k += 0.3; // icing
  if (precipMm > 4) k += 0.1;
  if (vis != null && vis < 1000) k += 0.25;
  if (gust > 70) k += 0.1;
  return k;
}
export function roadHazards(snowfallCm, snowDepthM, precipMm, T, vis, gust, code) {
  const h = [];
  if ((code === 66 || code === 67 || code === 56 || code === 57) || (precipMm > 0.1 && T <= 0.5 && T > -4)) h.push('Ice / freezing rain risk');
  if (snowfallCm > 0.5) h.push(`Snowfall ${snowfallCm.toFixed(1)} cm/h`);
  else if (snowDepthM > 0.03 && T < 0) h.push('Snow on the ground, roads may be slick');
  if (vis != null && vis < 1000) h.push(`Low visibility ${Math.round(vis)} m`);
  if (gust > 60) h.push(`Gusts ${Math.round(gust)} km/h`);
  if (precipMm > 5) h.push('Heavy rain');
  return h;
}
