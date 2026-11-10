// Shared helpers: math, geography, tile maths, cached network access with offline fallback.
export const DEG = Math.PI / 180, RAD = 180 / Math.PI;
export const R_EARTH = 6371000;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
export const std = a => { const v = a.filter(x => x != null && isFinite(x)); if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length); };

// Deterministic hash-based random for stable procedural detail.
export function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

// Geography
export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}
export function destination(lat, lon, brgDeg, dist) {
  const d = dist / R_EARTH, b = brgDeg * DEG, p1 = lat * DEG, l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * RAD, ((l2 * RAD + 540) % 360) - 180];
}
// Local tangent plane (metres east, north) around an origin, good to a few hundred km.
export function makeLocal(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * DEG), ky = 110574;
  return {
    lat0, lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}
// Earth curvature drop with standard refraction (k = 0.13).
export const curveDrop = d => d * d / (2 * R_EARTH / (1 - 0.13));

// Web Mercator tiles
export const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
export const lat2y = (lat, z) => { const r = lat * DEG; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
export const x2lon = (x, z) => x / 2 ** z * 360 - 180;
export const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return RAD * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

// ---------- IndexedDB cache ----------
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('skyscout', 2);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['json', 'blob', 'state']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }).catch(() => null);
  return dbp;
}
export async function idbGet(store, key) {
  const d = await db(); if (!d) return null;
  return new Promise(res => { try { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch { res(null); } });
}
export async function idbPut(store, key, val) {
  const d = await db(); if (!d) return;
  return new Promise(res => { try { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); t.oncomplete = () => res(); t.onerror = () => res(); } catch { res(); } });
}
export async function idbPrune(store, maxAgeMs) {
  const d = await db(); if (!d) return;
  try {
    const t = d.transaction(store, 'readwrite'), s = t.objectStore(store), now = Date.now();
    s.openCursor().onsuccess = e => { const c = e.target.result; if (!c) return; if (c.value && c.value.t && now - c.value.t > maxAgeMs) c.delete(); c.continue(); };
  } catch { }
}

// ---------- Network status ----------
export const Net = {
  online: navigator.onLine, lastOnline: +localStorage.getItem('ss_lastOnline') || 0, listeners: new Set(),
  set(on) {
    if (on) { this.lastOnline = Date.now(); try { localStorage.setItem('ss_lastOnline', this.lastOnline); } catch { } }
    if (on !== this.online) { this.online = on; this.listeners.forEach(f => f(on)); }
  },
};
addEventListener('online', () => Net.set(true));
addEventListener('offline', () => Net.set(false));

async function fetchT(url, opts = {}, ms = 25000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); return r; } finally { clearTimeout(t); }
}

// ---------- Open-Meteo free-tier budget (600 calls/min, 5000/h, 10000/day; big requests count as several) ----------
export const RateLimit = {
  limits: [[60e3, 600], [3600e3, 5000], [864e5, 10000]],
  load() { try { this.log = JSON.parse(localStorage.getItem('ss_om_use') || '[]'); this.until = +localStorage.getItem('ss_om_until') || 0; this.until = Math.min(this.until, Date.now() + 3600e3); } catch { this.log = []; this.until = 0; } },
  save() { try { const t = Date.now(); this.log = this.log.filter(e => t - e[0] < 864e5); localStorage.setItem('ss_om_use', JSON.stringify(this.log)); localStorage.setItem('ss_om_until', String(this.until)); } catch { } },
  // weight of one request, as the service counts it
  weight(url) {
    try {
      const u = new URL(url), q = u.searchParams, locs = (q.get('latitude') || '').split(',').length;
      // Open-Meteo's formula: locations x (variables x models / 10) x (days / 14), each factor at least 1
      const nv = (q.get('hourly') || '').split(',').filter(Boolean).length * Math.max(1, (q.get('models') || '').split(',').filter(Boolean).length);
      const days = (+q.get('forecast_days') || 7) + (+q.get('past_days') || 0);
      return locs * Math.max(1, nv / 10) * Math.max(1, days / 14);
    } catch { return 1; }
  },
  record(url) { this.load(); this.log.push([Date.now(), this.weight(url)]); this.save(); },   // reload first: other tabs share the log
  // what's left in the hourly and daily windows (the minute window refills within a minute)
  remaining(includeMinute = false) {
    const t = Date.now(); let r = Infinity;
    for (const [win, cap] of this.limits) { if (win < 3600e3 && !includeMinute) continue; r = Math.min(r, cap - this.log.filter(e => t - e[0] < win).reduce((a, e) => a + e[1], 0)); }
    return Math.max(0, r);
  },
  // the service said no: block until its window resets
  blocked(reason) {
    const t = Date.now(), d = new Date(t);
    // refused although this device has used little: someone else on the same internet connection used the quota
    this.shared = /daily/i.test(reason) ? this.remaining() > 3000 : /hourly/i.test(reason) ? this.remaining() > 1500 : false;
    // The daily limit is not a midnight-UTC reset (it behaves like a rolling 24 h window), so don't promise a time:
    // pause for an hour, then let the next forecast request check again. A refused request isn't counted.
    if (/daily/i.test(reason)) this.until = t + 3600e3;
    else if (/hourly/i.test(reason)) this.until = Math.ceil(t / 3600e3) * 3600e3;
    else this.until = Math.ceil(t / 60e3) * 60e3 + 1000;
    this.save();
  },
  waitMs() { return Math.max(0, this.until - Date.now()); },
};
RateLimit.load();
// one time: before v19 rejected forecast requests (HTTP 400: a 7-model try, then its 3-model retry, weights 51.1 and 21.9)
// were counted against the quota; drop those pairs from this device's log
try {
  if (!localStorage.getItem('ss_om_fix400')) {
    const L = RateLimit.log, drop = new Set();
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i][1] - 21.9) < 0.01) {
      drop.add(i);
      for (let j = i - 1; j >= 0 && L[i][0] - L[j][0] < 15000; j--) if (Math.abs(L[j][1] - 51.1) < 0.01 && !drop.has(j)) { drop.add(j); break; }
    }
    if (drop.size) { RateLimit.log = L.filter((e, i) => !drop.has(i)); RateLimit.save(); }
    localStorage.setItem('ss_om_fix400', '1');
  }
} catch { }
// tabs and the home-screen app on this device share one log (another device can't be seen without a server)
try { addEventListener('storage', e => { if (e.key === 'ss_om_use' || e.key === 'ss_om_until') RateLimit.load(); }); } catch { }
const isOpenMeteo = url => /\/\/(api|air-quality-api|ensemble-api)[.]open-meteo[.]com/.test(url);   // the forecast quota (place search is separate)

// JSON with cache: fresh copy within ttl, else network, else stale copy (offline mode).
export async function cachedJSON(key, url, ttlMs, opts = {}) {
  const hit = await idbGet('json', key);
  if (hit && Date.now() - hit.t < ttlMs) return { data: hit.data, t: hit.t, stale: false };
  if (opts.cacheOnly) { if (hit) return { data: hit.data, t: hit.t, stale: true }; throw new Error('not saved'); }
  const om = isOpenMeteo(url);
  if (om && RateLimit.waitMs() > 0) { if (hit) return { data: hit.data, t: hit.t, stale: true }; const e = new Error('rate-limited'); e.rateLimited = true; throw e; }
  if (om && typeof document !== 'undefined' && document.hidden) { if (hit) return { data: hit.data, t: hit.t, stale: true }; throw new Error('paused while the app is in the background'); }   // an app left open in the background never spends the quota
  try {
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await fetchT(url, opts.fetch || {}, opts.timeout || 30000);
      if (om && r.status === 429) break;                      // don't hammer it: report the wait instead
      if ((r.status === 429 || r.status === 503 || r.status === 504) && attempt < 3) { await sleep(4000 * (attempt + 1) ** 2); continue; }
      break;
    }
    if (om && r.ok) RateLimit.record(url);   // refused or rejected requests (429, 400...) aren't counted by the service
    if (r.status === 429) {
      let reason = ''; try { reason = (await r.json()).reason || ''; } catch { }
      if (om) RateLimit.blocked(reason);
      const e = new Error(om ? 'rate-limited' : 'the service is rate-limiting requests'); e.rateLimited = om; throw e;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data && data.error) throw new Error(data.reason || 'API error');
    Net.set(true);
    idbPut('json', key, { t: Date.now(), data });
    return { data, t: Date.now(), stale: false };
  } catch (e) {
    if (!opts.quiet && (e.name === 'TypeError' || e.name === 'AbortError')) Net.set(navigator.onLine && e.name === 'AbortError');
    if (hit) return { data: hit.data, t: hit.t, stale: true };
    throw e;
  }
}
// Binary (tiles) with cache. Returns a Blob or null.
export async function cachedBlob(url, ttlMs = 30 * 864e5, timeout = 20000) {
  const hit = await idbGet('blob', url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.b;
  try {
    const r = await fetchT(url, { mode: 'cors' }, timeout);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob(); Net.set(true);
    idbPut('blob', url, { t: Date.now(), b });
    return b;
  } catch (e) {
    if (e.name === 'TypeError') Net.set(false);
    return hit ? hit.b : null;
  }
}
// Decode an image tile into RGBA pixels.
export async function tilePixels(url, ttlMs) {
  const b = await cachedBlob(url, ttlMs); if (!b) return null;
  try {
    const bmp = await createImageBitmap(b);
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: g.getImageData(0, 0, bmp.width, bmp.height).data, bmp };
  } catch { return null; }
}
// Run async jobs with limited concurrency.
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
export function fmtTime(d, tz) {
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });
}
export function fmtAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400 * 2) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' days ago';
}
export const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
export const $ = s => document.querySelector(s);
