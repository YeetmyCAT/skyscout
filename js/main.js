// SkyScout: app controller — location, time, panels, map overlays, 3D view, scouting, sprites, offline.
import { $, el, clamp, makeLocal, Net, fmtAgo, cachedJSON, haversine, bearing, destination, DEG, idbPrune, RateLimit } from './util.js';
import { POINT_WEIGHT, pointForecast, gridForecast, airQuality, val, cloudLayers, cloudTypeNames, fogRisk, precipState, MODEL_NAMES, WMO, profile, GRID_MODELS } from './weather.js';
import { loadIR, analyseIR, satLayer } from './satellite.js';
import { atlasRatio, ratioToSqm } from './atlas.js';
import { calibrateToAtlas, loadLights, skyBrightness, domeNames, bortle, BORTLE_TXT, nelm, lum2mag, NAT_SKY, loadRegionalLights, quickLP, QUICK } from './lightpol.js';
import { nightInfo, sunMoon, phaseName } from './astro.js';
import { scout, urbanLookup } from './scout.js';
import { findSprites } from './sprites.js';
import { route, roadHazards, congestion, tomtomKey, driveTable } from './routing.js';
import { loadStructures, loadOverture } from './osm.js';
import { MapView } from './map.js';

const S = {
  sel: null, time: new Date(), t0: 0, data: null, view: null, assets: null, units: localStorage.getItem('ss_units') || 'metric',
  scoutRes: null, spriteRes: null, playing: false,
};
const U = {
  t: c => S.units === 'imperial' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`,
  km: k => S.units === 'imperial' ? `${(k * 0.6214).toFixed(k < 10 ? 1 : 0)} mi` : `${k.toFixed(k < 10 ? 1 : 0)} km`,
  m: m => S.units === 'imperial' ? `${Math.round(m * 3.281)} ft` : `${Math.round(m)} m`,
  kmh: v => S.units === 'imperial' ? `${Math.round(v * 0.6214)} mph` : `${Math.round(v)} km/h`,
  cm: c => S.units === 'imperial' ? `${(c / 2.54).toFixed(1)} in` : `${c.toFixed(c < 10 ? 1 : 0)} cm`,
};
const dirName = az => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16];
const fmtT = (d, tz) => d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz }) : '—';
const fmtDT = (d, tz) => d ? d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }) : '—';
const fmtDur = s => s == null ? '—' : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min`;
const colorFor = v => v > 0.7 ? 'var(--good)' : v > 0.45 ? 'var(--ok)' : 'var(--bad)';
const tz = () => (S.data && S.data.point.tz) || undefined;

// ---------------- boot ----------------
const map = new MapView($('#map'), (la, lo) => selectLocation(la, lo));
S.map = map;
// iOS home-screen apps report a viewport short by the status bar; size the app from the real screen there.
function fitApp() {
  const portrait = matchMedia('(orientation: portrait)').matches;
  const h = navigator.standalone ? (portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width)) : innerHeight;
  document.documentElement.style.setProperty('--appH', h + 'px');
}
fitApp(); addEventListener('resize', fitApp); addEventListener('orientationchange', () => setTimeout(fitApp, 300));
function boot() {
  setupUI();
  updateOffline();
  Net.listeners.add(updateOffline);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
  idbPrune('json', 10 * 864e5);
  const last = JSON.parse(localStorage.getItem('ss_sel') || 'null');
  initTime();
  if (last) selectLocation(last.lat, last.lon, last.name, true);
}

function initTime() {
  S.t0 = Math.floor(Date.now() / 900e3) * 900e3 - 3 * 3600e3; // slider starts 3 h ago
  const r = $('#time'); r.min = 0; r.max = 4 * 87; r.value = 12;
  S.time = new Date(S.t0 + 12 * 900e3);
  showTime();
}
function showTime() {
  const d = S.time, z = tz();
  const now = Math.abs(d - Date.now()) < 8 * 60e3;
  $('#timeLbl').innerHTML = `${d.toLocaleDateString([], { weekday: 'short', timeZone: z })}<br><b>${fmtT(d, z)}</b>${now ? ' <span class="muted">now</span>' : ''}`;
  if ($('#h3dTime')) $('#h3dTime').textContent = fmtDT(d, z) + (now ? ' · now' : '');
}
let timeTimer = null;
function setTime(d, from) {
  S.time = d;
  if (from !== 'slider') $('#time').value = Math.round((d - S.t0) / 900e3);
  showTime();
  clearTimeout(timeTimer);
  timeTimer = setTimeout(() => { if (S.data) { renderNow(); updateCloudOverlay(); } if (S.view && S.view.running) { S.view.setTime(S.time); checkSpritePrompt(); } }, from === 'slider' ? 60 : 0);
  if (S.view && S.view.running && from === 'play') S.view.setTime(S.time);
}

const fmtWait = w => w > 3600e3 ? `${Math.floor(w / 3600e3)} h ${Math.floor(w % 3600e3 / 60e3)} min` : `${Math.ceil(w / 60e3)} min`;
// Banner: stays up for as long as the condition lasts (other popups draw over it).
function updateOffline() {
  const b = $('#offline'), w = RateLimit.waitMs(), P = S.data && S.data.point;
  let txt = '';
  if (!Net.online) txt = `You're offline — showing the last data saved ${Net.lastOnline ? fmtAgo(Net.lastOnline) : ''}`;
  else if (w > 0) {
    const head = `Free 7-model weather limit reached · trying again in ${fmtWait(w)}`;
    if (P && P.backup) txt = `${head} — using the lower-quality backup forecast (${P.models.map(m => m === 'nws' ? 'US NWS' : 'MET Norway').join(' + ')})`;
    else if (P && P.stale) txt = `${head} — showing the forecast saved ${fmtAgo(P.fetched)}`;
    else if (P) txt = `${head} — this forecast was saved ${fmtAgo(P.fetched)}`;
    else txt = `${head} — new forecasts use a lower-quality backup until then`;
  } else if (P && P.backup) txt = 'Tap here to try the full 7-model forecast again';
  else if (P && P.stale) txt = `Couldn't reach the forecast servers — showing data from ${fmtAgo(P.fetched)}`;
  // phones: a small chip that opens to the full text when tapped, so it never covers much of the screen
  const short = !Net.online ? '⚠ Offline · saved data' : w > 0 ? `⚠ ${P && P.backup ? 'Backup weather' : 'Weather limit'} · ${fmtWait(w)}` : P && P.backup ? '↻ Full forecast' : P && P.stale ? '⚠ Saved data' : '';
  const phone = matchMedia('(max-width: 820px), (max-height: 520px) and (pointer: coarse)').matches;
  b.textContent = phone && !b.classList.contains('open') ? short : txt; b.classList.toggle('hidden', !txt); b.classList.toggle('chip', phone);
  const canUpgrade = Net.online && w === 0 && P && P.backup;
  b.classList.toggle('tap', !!canUpgrade);
  b.onclick = !canUpgrade ? (phone ? () => { b.classList.toggle('open'); updateOffline(); } : null) : async () => {
    const tok = selToken, { lat, lon } = S.sel; b.textContent = 'Loading 7 weather models…';
    try { const [point, aq] = await Promise.all([pointForecast(lat, lon), airQuality(lat, lon)]); if (tok === selToken) await showForecast(tok, point, aq); }
    catch { updateOffline(); }
  };
}
setInterval(updateOffline, 30e3);
addEventListener('resize', () => updateOffline());

// ---------------- UI wiring ----------------
function setupUI() {
  $('#layersBtn').onclick = () => $('#layersCard').classList.toggle('show');
  document.querySelectorAll('input[name=base]').forEach(r => { r.checked = r.value === map.baseKey; r.onchange = () => map.setBase(r.value); });
  document.querySelectorAll('[data-ov]').forEach(c => c.onchange = async () => { const k = c.dataset.ov; const note = await map.toggle(k, c.checked); $('#layerNote').textContent = note || ''; if (k === 'cloudfc' && c.checked) updateCloudOverlay(true); });
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'scout') renderScoutTab(); if (b.dataset.tab === 'sprites') renderSpriteTab();
    $('#panel').classList.remove('min');
  });
  // bottom sheet drag on phones
  const sheet = $('#panel'), grab = sheet.querySelector('.grab'); let y0 = null;
  const tabs = sheet.querySelector('.tabs');
  for (const h of [grab, tabs]) {
    h.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
    h.addEventListener('touchend', e => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; if (dy < -30) sheet.classList.contains('min') ? sheet.classList.remove('min') : sheet.classList.add('max'); else if (dy > 30) sheet.classList.contains('max') ? sheet.classList.remove('max') : sheet.classList.add('min'); }, { passive: true });
  }
  grab.onclick = () => sheet.classList.toggle('min');
  // time
  $('#time').oninput = e => setTime(new Date(S.t0 + +e.target.value * 900e3), 'slider');
  $('#nowBtn').onclick = () => setTime(new Date(Math.round(Date.now() / 900e3) * 900e3));
  $('#tonightBtn').onclick = () => { if (S.data) setTime(bestTime(S.data)); };
  $('#playBtn').onclick = () => {
    S.playing = !S.playing; $('#playBtn').textContent = S.playing ? '❚❚' : '▶';
    const step = () => { if (!S.playing) return; let v = +$('#time').value + 1; if (v > +$('#time').max) v = 0; $('#time').value = v; setTime(new Date(S.t0 + v * 900e3), 'play'); S.playTimer = setTimeout(step, S.view && S.view.running ? 350 : 500); };
    step();
  };
  // search
  let st = null;
  $('#q').oninput = () => { clearTimeout(st); st = setTimeout(suggest, 300); };
  $('#search').onsubmit = async e => { e.preventDefault(); clearTimeout(st); await suggest(true); const s = $('#sugg').firstChild; if (s) s.click(); };
  $('#locate').onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition(p => { map.map.setView([p.coords.latitude, p.coords.longitude], 10); selectLocation(p.coords.latitude, p.coords.longitude); }, () => alert('Location unavailable (needs HTTPS and permission).'), { enableHighAccuracy: true, timeout: 10000 });
  // settings
  $('#settingsBtn').onclick = () => { $('#ttKey').value = tomtomKey(); $('#units').value = S.units; $('#settings').classList.remove('hidden'); };
  $('#closeSettings').onclick = () => { localStorage.setItem('ss_tomtom', $('#ttKey').value.trim()); S.units = $('#units').value; localStorage.setItem('ss_units', S.units); $('#settings').classList.add('hidden'); if (S.data) renderConditions(); };
  $('#clearCache').onclick = async () => { indexedDB.deleteDatabase('skyscout'); if (window.caches) for (const k of await caches.keys()) await caches.delete(k); alert('Saved data cleared.'); };
  // 3D
  $('#close3d').onclick = close3D;
  $('#menu3dBtn').onclick = () => { $('#menu3d').classList.toggle('hidden'); document.body.classList.toggle('menu-open', !$('#menu3d').classList.contains('hidden')); };
  $('#loadStruct').onclick = loadStructuresNow;
}
async function suggest(force) {
  const q = $('#q').value.trim(), box = $('#sugg'); box.innerHTML = '';
  if (q.length < 2) { box.classList.add('hidden'); return; }
  const m = q.match(/^\s*(-?\d+(\.\d+)?)\s*[, ]\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) { const d = el('div', { onclick: () => { box.classList.add('hidden'); map.map.setView([+m[1], +m[3]], 10); selectLocation(+m[1], +m[3]); } }, `Go to ${m[1]}, ${m[3]}`); box.append(d); box.classList.remove('hidden'); return; }
  // Open-Meteo's place search, with Photon (OpenStreetMap) as a backup when it fails or finds nothing
  let list = [];
  try {
    const r = await cachedJSON('geo:' + q.toLowerCase(), `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en`, 30 * 864e5, { quiet: true });
    list = (r.data.results || []).map(g => ({ name: g.name, lat: g.latitude, lon: g.longitude, region: g.admin1, country: g.country }));
  } catch { }
  if (!list.length) try {
    const r = await cachedJSON('photon:' + q.toLowerCase(), `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`, 30 * 864e5, { quiet: true });
    list = (r.data.features || []).map(f => ({ name: f.properties.name || q, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], region: f.properties.state || f.properties.county, country: f.properties.country }));
  } catch { }
  if (q !== $('#q').value.trim()) return;   // the user kept typing
  for (const g of list) box.append(el('div', { onclick: () => { box.classList.add('hidden'); $('#q').value = g.name; map.map.setView([g.lat, g.lon], 10); selectLocation(g.lat, g.lon, `${g.name}${g.region ? ', ' + g.region : ''}`); } }, `${g.name}${g.region ? ', ' + g.region : ''}${g.country ? ', ' + g.country : ''}`));
  box.classList.toggle('hidden', !box.children.length);
}

// ---------------- location ----------------
let selToken = 0;
// Picking a place only shows it; the forecast is fetched when asked (saves the free service's quota).
async function selectLocation(lat, lon, name, restoring) {
  const tok = ++selToken;
  S.sel = { lat, lon, name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
  S.data = null;
  map.select(lat, lon); save();
  if (!restoring && innerWidth <= 820) $('#panel').classList.remove('min');
  const box = $('#tab-cond');
  box.innerHTML = `<div class="place">${S.sel.name}</div><div class="sub">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>
    <button class="btn primary big" id="fetchBtn">Fetch forecast</button><div class="small muted" id="fetchNote"></div>`;
  document.querySelector('.tabs button[data-tab=cond]').click();
  $('#fetchBtn').onclick = () => fetchForecast(tok);
  updateFetchButton();
  if (!name) reverseName(lat, lon).then(n => { if (n && tok === selToken) { S.sel.name = n; save(); const p = document.querySelector('#tab-cond .place'); if (p) p.textContent = n; $('#h3dName').textContent = n; } });
  // a saved forecast for this spot loads instantly without using the service
  try {
    const [point, aq] = await Promise.all([pointForecast(lat, lon, { cacheOnly: true }), airQuality(lat, lon, { cacheOnly: true })]);
    if (tok === selToken && point && !point.stale) await showForecast(tok, point, aq);
  } catch { }
}
// Button text: forecasts left in the free quota, or a live countdown while the service is blocking us.
let fetchTimer = null;
function updateFetchButton() {
  clearInterval(fetchTimer);
  const tick = () => {
    const b = $('#fetchBtn'); if (!b) { clearInterval(fetchTimer); return; }
    const w = RateLimit.waitMs();
    if (w > 0) {
      const sec = Math.ceil(w / 1000), txt = sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor(sec % 3600 / 60)} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      b.disabled = false; b.textContent = `Fetch backup forecast (lower quality) · trying the full 7-model forecast again in ${txt}`;
    } else {
      const left = Math.floor(RateLimit.remaining() / POINT_WEIGHT);
      b.disabled = false; b.textContent = `Fetch forecast · about ${left} left before the free limit`;
    }
  };
  tick(); fetchTimer = setInterval(tick, 1000);
}
async function fetchForecast(tok) {
  const { lat, lon } = S.sel, note = $('#fetchNote');
  $('#fetchBtn').disabled = true; $('#fetchBtn').textContent = RateLimit.waitMs() > 0 ? 'Loading the backup forecast (MET Norway, US NWS)…' : 'Loading 7 weather models…';
  try {
    const [point, aq] = await Promise.all([pointForecast(lat, lon), airQuality(lat, lon)]);
    if (tok !== selToken) return;
    await showForecast(tok, point, aq);
  } catch (e) {
    console.error(e);
    if (note) note.textContent = e.rateLimited ? 'The free weather service is pausing requests from this device, and the backup forecast could not be reached either.' : `Couldn't load the forecast (${e.message}). ${Net.online ? 'Try again in a moment.' : 'You are offline and nothing is saved for this place yet.'}`;
    updateFetchButton();
  }
}
async function showForecast(tok, point, aq) {
  const { lat, lon } = S.sel;
  S.data = { point, aq, lat, lon, lights: null, lp: null, domes: [] };
  updateOffline();
  renderConditions();
  const lights = await loadLights(lat, lon);
  if (tok !== selToken) return;
  S.data.lights = lights;
  if (lights) {
    await computeLP();
    domeNames(lights, lat, lon).then(d => { if (tok === selToken) { S.data.domes = d; renderConditions(); } });
  }
  renderConditions();
}
async function computeLP() {
  const d = S.data; if (!d || !d.lights) return;
  const t = S.time.getTime() / 1000;
  const snow = clamp((val(d.point, 'snow_depth', t) ?? 0) / 0.06, 0, 1);
  const aod = d.aq ? d.aq.aod[Math.max(0, d.aq.t.findIndex(x => x >= t))] ?? 0.12 : 0.12;
  const L = cloudLayers(d.point, t, d.point.elevation);
  d.lp = await skyBrightness(d.lights, { lat: d.lat, lon: d.lon, aod, snow, cloudBaseKm: Math.max(0.3, (L.low.base - d.point.elevation) / 1000), obsZ: d.point.elevation });
  d.atlas = await atlasRatio(d.lat, d.lon).catch(() => null);
  calibrateToAtlas(d.lp, d.atlas, snow);
  d.lpSnow = snow;
  const q = quickLP(d.lights, d.lat, d.lon);
  if (q.zen > 0 && d.lp.zenith > 0) d.quickZenRatio = d.lp.zenith / q.zen;
}
function save() { try { localStorage.setItem('ss_sel', JSON.stringify(S.sel)); } catch { } }
async function reverseName(lat, lon) {
  try {
    const r = await cachedJSON(`rev:${lat.toFixed(3)},${lon.toFixed(3)}`, `https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, 90 * 864e5, { timeout: 8000 });
    const a = r.data.address || {}; return [a.village || a.town || a.city || a.hamlet || a.county, a.state].filter(Boolean).join(', ');
  } catch { return null; }
}

// Best time tonight: darkest, clearest hour.
function bestTime(d) {
  const n = nightInfo(new Date(), d.lat, d.lon, d.point.elevation);
  let best = null, bs = -1;
  for (const s of n.samples) {
    if (s.sunAlt > -16) continue;
    const t = s.t / 1000, cc = val(d.point, 'cloud_cover', t) ?? 50;
    const sc = (1 - cc / 100) * (s.moonAlt > 0 ? 1 - 0.6 * s.moonFrac : 1);
    if (sc > bs) { bs = sc; best = s.t; }
  }
  return new Date(best || (n.astroDusk || n.sunset || new Date()).getTime());
}

// ---------------- conditions panel ----------------
function nightScore(d, night) {
  const hrs = night.samples.filter(s => s.sunAlt < -12);
  if (!hrs.length) return { score: 0, clear: 0 };
  let sum = 0, cs = 0;
  for (const s of hrs) {
    const t = s.t / 1000, cc = val(d.point, 'cloud_cover', t) ?? 50;
    const moon = s.moonAlt > 0 ? 1 - 0.7 * s.moonFrac * clamp(s.moonAlt / 25, 0.3, 1) : 1;
    sum += (1 - cc / 100) * moon; cs += 1 - cc / 100;
  }
  const sqm = d.lp ? lum2mag(NAT_SKY + d.lp.zenith) : 21.5;
  const dark = clamp((sqm - 17.5) / 4.3, 0, 1);
  return { score: Math.round(100 * (sum / hrs.length) * (0.45 + 0.55 * dark)), clear: cs / hrs.length, sqm, dark };
}
function renderConditions() {
  const d = S.data; if (!d) return;
  const P = d.point, z = P.tz, night = nightInfo(S.time, d.lat, d.lon, P.elevation);
  d.night = night;
  const ns = nightScore(d, night);
  const sqm = d.lp ? lum2mag(NAT_SKY + d.lp.zenith) : null;
  const sm = sunMoon(S.time, d.lat, d.lon, P.elevation);
  const box = $('#tab-cond');
  const lpHtml = d.lp ? `
    <div class="grid2">
      <div class="stat"><div class="k">Zenith sky brightness</div><div class="v">${sqm.toFixed(2)} <small>mag/arcsec²</small></div></div>
      <div class="stat"><div class="k">Bortle class</div><div class="v">${bortle(sqm)} <small>${BORTLE_TXT[bortle(sqm)]}</small></div></div>
      <div class="stat"><div class="k">Naked-eye limit (no moon)</div><div class="v">${nelm(sqm).toFixed(1)} <small>mag</small></div></div>
      <div class="stat"><div class="k">Artificial / natural</div><div class="v">${(d.lp.zenith / NAT_SKY * 100).toFixed(0)}% <small>at zenith</small></div></div>
    </div>
    <div class="small muted">${d.atlas ? `Zenith from the Light Pollution Atlas ${d.atlas.year} (D. Lorenz, VIIRS)${d.lpSnow > 0.05 ? ', brightened for snow cover' : ''}; whole-sky glow from SkyScout's scattering model.` : 'Zenith from the SkyScout scattering model (atlas unavailable here).'}</div>
    <canvas class="polar" id="lpPolar" width="380" height="380"></canvas>
    <div class="small muted" style="text-align:center">Whole-sky light pollution: brightness by direction and height (N up). Domes: ${(d.domes || []).map(x => `${x.name || '?'} ${dirName(x.az)}`).join(' · ') || '—'}</div>`
    : `<div class="small muted">${d.lights === null ? 'Loading night-lights data…' : 'Night-lights data unavailable.'}</div>`;
  box.innerHTML = `
    <div class="place">${S.sel.name}</div>
    <div class="sub">${d.lat.toFixed(4)}, ${d.lon.toFixed(4)} · ${U.m(P.elevation)} · ${P.backup ? 'Backup forecast' : `${P.models.length} models`}: ${P.models.map(m => MODEL_NAMES[m]).join(', ')}</div>
    ${P.backup ? `<div class="warnbox small">Lower-quality backup: the free 7-model service's limit is used up (it is tried again in ${fmtWait(RateLimit.waitMs())}). ${P.models.length} source${P.models.length > 1 ? 's' : ''} instead of 7, cloud layers only as low/mid/high, no instability data for storms${P.filled && P.filled.length ? `; cloud heights, snow depth and storm data come from the 7-model forecast saved ${fmtAgo(P.savedAt)}` : ', no snow depth'}.</div>` : ''}
    <div class="score"><div class="num" style="color:${colorFor(ns.score / 100)}">${ns.score}</div>
      <div><b>Astrophotography tonight</b><div class="small muted">${(ns.clear * 100).toFixed(0)}% clear in the dark hours · ${night.darkHours.toFixed(1)} h moon-free darkness${sqm ? ` · Bortle ${bortle(sqm)}` : ''}</div></div></div>
    <button class="btn primary big" id="open3dBtn">Open 3D sky view</button>
    <div class="cardhead">Clouds — all models (3 days)</div>
    <canvas class="chart" id="cloudChart"></canvas>
    <div class="legend"><span><i style="background:#fff"></i>model mean</span><span><i style="background:#7cb4ff55"></i>model spread</span><span><i style="background:#3a4670"></i>night</span><span><i style="background:#e8c35a88"></i>moon up</span></div>
    <div id="nowBlock"></div>
    <div class="cardhead">Night of ${night.noon.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: z })}</div>
    <div class="grid2">
      <div class="stat"><div class="k">Sunset → Sunrise</div><div class="v">${fmtT(night.sunset, z)} → ${fmtT(night.sunrise, z)}</div></div>
      <div class="stat"><div class="k">Astronomical dark</div><div class="v">${fmtT(night.astroDusk, z)} → ${fmtT(night.astroDawn, z)}</div></div>
      <div class="stat"><div class="k">Moon</div><div class="v">${phaseName(sm.phase)} <small>${(sm.moonFrac * 100).toFixed(0)}%</small></div></div>
      <div class="stat"><div class="k">Moonrise / set</div><div class="v">${fmtT(night.moonrise, z)} / ${fmtT(night.moonset, z)}</div></div>
    </div>
    <div class="small muted">Moon-free dark windows: ${night.dark.map(w => `${fmtT(w.start, z)}–${fmtT(w.end, z)}`).join(', ') || 'none'}</div>
    <div class="cardhead">Light pollution</div>
    ${lpHtml}
    <div class="row" style="margin-top:12px"><button class="btn" id="goScout">Find darker, clearer spots nearby</button><button class="btn" id="goSprites">Sprite / TLE finder</button></div>
  `;
  $('#open3dBtn').onclick = () => open3D();
  $('#goScout').onclick = () => document.querySelector('.tabs button[data-tab=scout]').click();
  $('#goSprites').onclick = () => document.querySelector('.tabs button[data-tab=sprites]').click();
  drawCloudChart($('#cloudChart'), d);
  if (d.lp) drawPolar($('#lpPolar'), d.lp, d.domes);
  renderNow();
  drawTimeline();
}
// Block for the selected time
function renderNow() {
  const d = S.data, box = $('#nowBlock'); if (!d || !box) return;
  const P = d.point, t = S.time.getTime() / 1000;
  const g = k => val(P, k, t);
  const L = cloudLayers(P, t, P.elevation), types = cloudTypeNames(L);
  const ps = precipState(P, t), fog = fogRisk(P, t);
  const spread = val(P, 'cloud_cover', t, 'spread') ?? 0;
  const aod = d.aq ? d.aq.aod[Math.max(0, d.aq.t.findIndex(x => x >= t))] : null;
  const jet = g('wind_speed_250hPa');
  const hz = roadHazards(g('snowfall') ?? 0, g('snow_depth') ?? 0, g('precipitation') ?? 0, g('temperature_2m') ?? 10, g('visibility'), g('wind_gusts_10m') ?? 0, g('weather_code'));
  const perModel = Object.entries(P.v.cloud_cover.models).map(([m, a]) => { const [i, j, f] = [0, 0, 0]; return `${MODEL_NAMES[m]} ${Math.round(modelAt(P, 'cloud_cover', m, t))}%`; });
  const sm = sunMoon(S.time, d.lat, d.lon, P.elevation);
  box.innerHTML = `
    <div class="cardhead">At ${fmtDT(S.time, P.tz)}</div>
    <div class="grid2">
      <div class="stat"><div class="k">Cloud cover (mean)</div><div class="v">${Math.round(g('cloud_cover') ?? 0)}% <small>±${Math.round(spread)}</small></div></div>
      <div class="stat"><div class="k">Low / mid / high</div><div class="v">${Math.round(g('cloud_cover_low') ?? 0)} / ${Math.round(g('cloud_cover_mid') ?? 0)} / ${Math.round(g('cloud_cover_high') ?? 0)}%</div></div>
      <div class="stat"><div class="k">Cloud types</div><div class="v" style="font-size:14px">${types.join(', ')}</div></div>
      <div class="stat"><div class="k">Cloud base / tops</div><div class="v" style="font-size:14px">${L.low.cover > 0.05 ? U.m(L.low.base - P.elevation) + ' AGL' : '—'}${L.high.cover > 0.05 ? ' · cirrus ' + U.m(L.high.base) : ''}</div></div>
      <div class="stat"><div class="k">Weather</div><div class="v" style="font-size:14px">${WMO[g('weather_code')] || '—'}${ps.type !== 'none' ? ` · ${(g('precipitation') ?? 0).toFixed(1)} mm/h` : ''}</div></div>
      <div class="stat"><div class="k">Temp / dew point</div><div class="v">${U.t(g('temperature_2m') ?? 0)} / ${U.t(g('dew_point_2m') ?? 0)}</div></div>
      <div class="stat"><div class="k">Wind / gusts</div><div class="v">${U.kmh(g('wind_speed_10m') ?? 0)} <small>${U.kmh(g('wind_gusts_10m') ?? 0)}</small></div></div>
      <div class="stat"><div class="k">Fog risk</div><div class="v" style="color:${colorFor(1 - fog)}">${fog > 0.6 ? 'High' : fog > 0.3 ? 'Moderate' : 'Low'}</div></div>
      <div class="stat"><div class="k">Transparency (aerosol)</div><div class="v">${aod != null ? (aod < 0.1 ? 'Excellent' : aod < 0.2 ? 'Good' : aod < 0.4 ? 'Hazy' : 'Poor') + ` <small>AOD ${aod.toFixed(2)}</small>` : '—'}</div></div>
      <div class="stat"><div class="k">Seeing (jet stream)</div><div class="v">${jet != null ? (jet < 60 ? 'Good' : jet < 120 ? 'Average' : 'Poor') + ` <small>${U.kmh(jet)}</small>` : '—'}</div></div>
      <div class="stat"><div class="k">Snow on ground</div><div class="v">${(g('snow_depth') ?? 0) > 0.005 ? U.cm((g('snow_depth') ?? 0) * 100) : 'None'}</div></div>
      <div class="stat"><div class="k">Sun / Moon altitude</div><div class="v">${sm.sun.alt.toFixed(0)}° / ${sm.moon.alt.toFixed(0)}°</div></div>
    </div>
    <div class="small muted">Per model: ${perModel.join(' · ')}</div>
    ${hz.length ? `<div style="margin-top:6px">${hz.map(h => `<span class="tag bad">${h}</span>`).join('')}</div>` : '<div style="margin-top:6px"><span class="tag good">Roads: no weather hazards forecast</span></div>'}`;
}
function modelAt(P, v, m, t) { const a = P.v[v].models[m]; if (!a) return NaN; let i = P.t.findIndex(x => x >= t); if (i < 0) i = a.length - 1; return a[i] ?? NaN; }

function drawCloudChart(cv, d) {
  const P = d.point, dpr = devicePixelRatio || 1, W = cv.clientWidth * dpr, H = cv.clientHeight * dpr; cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
  const t0 = Date.now() / 1000 - 3 * 3600, t1 = t0 + 87 * 3600;
  const X = t => (t - t0) / (t1 - t0) * W, Y = c => H - 14 * dpr - c / 100 * (H - 22 * dpr);
  // nights and moon
  for (let t = t0; t < t1; t += 1800) {
    const sm = sunMoon(new Date(t * 1000), d.lat, d.lon);
    if (sm.sun.alt < -6) { g.fillStyle = sm.sun.alt < -18 ? '#2a3458' : '#323d63'; g.fillRect(X(t), 0, X(t + 1800) - X(t) + 1, H - 14 * dpr); }
    if (sm.moon.alt > 0 && sm.sun.alt < -6) { g.fillStyle = `rgba(232,195,90,${0.15 + 0.4 * sm.moonFrac})`; g.fillRect(X(t), H - 14 * dpr, X(t + 1800) - X(t) + 1, 4 * dpr); }
  }
  // spread band
  const mean = P.v.cloud_cover.mean, sp = P.v.cloud_cover.spread;
  g.beginPath(); let first = true;
  P.t.forEach((t, i) => { if (t < t0 || t > t1 || mean[i] == null) return; const y = Y(Math.min(100, mean[i] + sp[i])); first ? g.moveTo(X(t), y) : g.lineTo(X(t), y); first = false; });
  for (let i = P.t.length - 1; i >= 0; i--) { const t = P.t[i]; if (t < t0 || t > t1 || mean[i] == null) continue; g.lineTo(X(t), Y(Math.max(0, mean[i] - sp[i]))); }
  g.closePath(); g.fillStyle = '#7cb4ff40'; g.fill();
  for (const [m, a] of Object.entries(P.v.cloud_cover.models)) { g.beginPath(); first = true; P.t.forEach((t, i) => { if (t < t0 || t > t1 || a[i] == null) return; first ? g.moveTo(X(t), Y(a[i])) : g.lineTo(X(t), Y(a[i])); first = false; }); g.strokeStyle = '#9fb4e655'; g.lineWidth = dpr; g.stroke(); }
  g.beginPath(); first = true; P.t.forEach((t, i) => { if (t < t0 || t > t1 || mean[i] == null) return; first ? g.moveTo(X(t), Y(mean[i])) : g.lineTo(X(t), Y(mean[i])); first = false; }); g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr; g.stroke();
  // labels
  g.fillStyle = '#94a0c4'; g.font = `${10 * dpr}px sans-serif`;
  for (let t = Math.ceil(t0 / 86400) * 86400; t < t1; t += 86400) { const x = X(t); g.fillText(new Date(t * 1000).toLocaleDateString([], { weekday: 'short', timeZone: P.tz }), x + 3, H - 2 * dpr); }
  g.fillText('100%', 3, 10 * dpr); g.fillText('0%', 3, H - 16 * dpr);
  const sx = X(S.time / 1000); g.fillStyle = '#ffffffcc'; g.fillRect(sx - dpr, 0, 2 * dpr, H);
  cv.onclick = e => { const r = cv.getBoundingClientRect(); setTime(new Date((t0 + (e.clientX - r.left) / r.width * (t1 - t0)) * 1000)); drawCloudChart(cv, d); };
}
function drawPolar(cv, lp, domes) {
  const g = cv.getContext('2d'), W = cv.width, c = W / 2, R = W / 2 - 18;
  g.clearRect(0, 0, W, W);
  // colour: artificial brightness relative to natural, log scale
  const col = v => { const x = clamp(Math.log10(1 + v / NAT_SKY) / 2.2, 0, 1); const h = 240 - 220 * x; return `hsl(${h},85%,${18 + 50 * x}%)`; };
  for (let ia = 0; ia < lp.nAz; ia++) for (let k = 0; k < lp.alts.length - 1; k++) {
    const a0 = (ia - 0.5) / lp.nAz * 2 * Math.PI, a1 = (ia + 0.5) / lp.nAz * 2 * Math.PI;
    const r0 = R * (1 - lp.alts[k] / 90), r1 = R * (1 - lp.alts[k + 1] / 90);
    g.beginPath(); g.arc(c, c, r0, a0 - Math.PI / 2, a1 - Math.PI / 2); g.arc(c, c, r1, a1 - Math.PI / 2, a0 - Math.PI / 2, true); g.closePath();
    g.fillStyle = col(lp.clear[ia * lp.alts.length + k]); g.fill();
  }
  g.strokeStyle = '#ffffff30'; for (const a of [30, 60]) { g.beginPath(); g.arc(c, c, R * (1 - a / 90), 0, 7); g.stroke(); }
  g.fillStyle = '#cfe0ff'; g.font = '15px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([n, a]) => g.fillText(n, c + Math.sin(a * DEG) * (R + 10), c - Math.cos(a * DEG) * (R + 10)));
  g.font = '12px sans-serif'; g.fillStyle = '#ffd7a8';
  for (const d of domes || []) if (d.name) g.fillText(d.name, c + Math.sin(d.az * DEG) * R * 0.78, c - Math.cos(d.az * DEG) * R * 0.78);
}
function drawTimeline() {
  const cv = $('#tlCanvas'), d = S.data; if (!cv) return;
  const dpr = devicePixelRatio || 1, W = cv.clientWidth * dpr, H = cv.clientHeight * dpr; cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#1b2544'; g.fillRect(0, 0, W, H);
  if (!d) return;
  const n = +$('#time').max;
  for (let i = 0; i < n; i += 2) {
    const t = S.t0 + i * 900e3, sm = sunMoon(new Date(t), d.lat, d.lon), x = i / n * W, w = 2 / n * W + 1;
    const s = sm.sun.alt; g.fillStyle = s > 0 ? '#4c78c8' : s > -6 ? '#3b4f8a' : s > -12 ? '#28345e' : s > -18 ? '#1c2444' : '#111731'; g.fillRect(x, 0, w, H);
    const cc = val(d.point, 'cloud_cover', t / 1000) ?? 0; g.fillStyle = `rgba(220,226,240,${cc / 100 * 0.55})`; g.fillRect(x, H * 0.45, w, H * 0.55);
    if (sm.moon.alt > 0 && s < -6) { g.fillStyle = 'rgba(232,195,90,0.6)'; g.fillRect(x, 0, w, 3 * dpr); }
  }
}
window.addEventListener('resize', () => { drawTimeline(); if (S.data && $('#cloudChart')) drawCloudChart($('#cloudChart'), S.data); });

// Regional cloud-forecast overlay for the map at the slider time
let cfTimer = null;
async function updateCloudOverlay(now) {
  if (!document.querySelector('[data-ov=cloudfc]').checked) return;
  clearTimeout(cfTimer);
  cfTimer = setTimeout(async () => {
    // Grid over the visible map (padded), evenly spaced in Web-Mercator so the image lines up at any zoom.
    const b = map.map.getBounds().pad(0.15), n = 13;
    const S0 = Math.max(-80, b.getSouth()), N0 = Math.min(80, b.getNorth()), W0 = b.getWest(), E0 = b.getEast();
    const my = la => Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)), iy = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
    // snap the box so small pans reuse cached forecasts
    const q = Math.max(0.25, Math.pow(2, Math.round(Math.log2((E0 - W0) / 24))));
    const w = Math.floor(W0 / q) * q, e = Math.ceil(E0 / q) * q, s0 = Math.floor(S0 / q) * q, n0 = Math.ceil(N0 / q) * q;
    const y0 = my(s0), y1 = my(n0), pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push([iy(y1 - (y1 - y0) * j / (n - 1)), ((w + (e - w) * i / (n - 1) + 540) % 360) - 180]);
    try {
      const ser = await gridForecast(pts, `cf${w},${s0},${e},${n0}`, { vars: ['cloud_cover'] });
      const t = S.time.getTime() / 1000, grid = [];
      for (let j = 0; j < n; j++) { grid.push([]); for (let i = 0; i < n; i++) grid[j].push((val(ser[j * n + i], 'cloud_cover', t) ?? 0) / 100); }
      map.setCloudOverlay(grid, [[s0, w], [n0, e]]);
      $('#layerNote').textContent = ser[0] && ser[0].backup ? `Cloud forecast (backup: MET Norway, coarser and lower quality) for ${fmtDT(S.time, tz())}` : `Cloud forecast (3-model mean) for ${fmtDT(S.time, tz())}`;
    } catch (e) { $('#layerNote').textContent = 'Cloud forecast unavailable: ' + e.message; }
  }, now ? 0 : 500);
}
map.map.on('moveend', () => updateCloudOverlay());

// ---------------- 3D view ----------------
async function loadAssets() {
  if (S.assets) return S.assets;
  const j = u => fetch(u).then(r => r.json());
  const { loadNoise } = await import('./view3d/clouds.js');
  const [stars, constLines, milkyway, noise] = await Promise.all([j('data/stars.json'), j('data/constlines.json'), j('data/milkyway.json'), loadNoise()]);
  return S.assets = { stars, constLines, milkyway, noise };
}
async function open3D(site) {
  if (!S.data) return;
  const d = S.data, lat = site ? site.lat : d.lat, lon = site ? site.lon : d.lon;
  $('#view3d').classList.remove('hidden'); $('#load3d').classList.remove('hidden'); document.body.classList.add('in3d');
  $('#view3d').appendChild($('#offline'));   // banner sits under the 3D readouts and menus
  $('#h3dName').textContent = site ? site.name : S.sel.name; showTime();
  const prog = t => { $('#load3dTxt').textContent = t; };
  try {
    prog('Preparing sky, stars and cloud noise…');
    const assets = await loadAssets();
    const { Immersive } = await import('./view3d/view.js');
    if (!S.view) { S.view = new Immersive($('#view3d'), assets); setup3DMenu(); }
    // data for this spot (another site reuses the same pipeline)
    let point = d.point, aq = d.aq, lights = d.lights, lp = d.lp, domes = d.domes;
    if (site) {
      prog('Loading forecast for this site…');
      [point, aq] = await Promise.all([pointForecast(lat, lon), airQuality(lat, lon)]);
      lights = await loadLights(lat, lon);
      lp = null; domes = [];
    }
    const local = makeLocal(lat, lon);
    prog(RateLimit.waitMs() > 0 ? 'Loading the backup cloud field around you (MET Norway, ±120 km)…' : 'Loading the 3-model cloud field around you (±120 km)…');
    const n = 9, half = 120000, pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(local.toLL((i / (n - 1) * 2 - 1) * half, (j / (n - 1) * 2 - 1) * half));
    const series = await gridForecast(pts, `3d${lat.toFixed(2)},${lon.toFixed(2)}`).catch(() => null);
    let sat = null;
    if (Math.abs(S.time - Date.now()) < 7 * 3600e3 && satLayer(lon)) {
      prog('Reading the latest satellite cloud tops…');
      const ir = await loadIR(lat, lon, 175).catch(() => null);
      if (ir) {
        const now = Date.now() / 1000;
        sat = { obs: ir.obs, half, grid: analyseIR(ir, local, half, 96, profile(point, now), val(point, 'temperature_2m', now) ?? 10, point.elevation), name: ir.sat.name };
      }
    }
    if (lights && !lp) {
      prog('Modelling light pollution across the whole sky…');
      const t = S.time.getTime() / 1000, L = cloudLayers(point, t, point.elevation);
      const snow = clamp((val(point, 'snow_depth', t) ?? 0) / 0.06, 0, 1);
      lp = await skyBrightness(lights, { lat, lon, aod: 0.12, snow, cloudBaseKm: Math.max(0.3, (L.low.base - point.elevation) / 1000), obsZ: point.elevation });
      calibrateToAtlas(lp, await atlasRatio(lat, lon).catch(() => null), snow);
      domes = await domeNames(lights, lat, lon).catch(() => []);
    }
    const ctx = { lat, lon, name: site ? site.name : S.sel.name, time: S.time, local, groundZ: point.elevation, point, utcOffset: point.utcOffset, aq, lights, lp, domes,
      grid: series ? { series, n, half } : null, sat, sprites: site && site.sprites ? site.sprites : [] };
    await S.view.open(ctx, prog);
    if (site && site.spriteData) { S.view.setStormForecast(site.spriteData); S.view.U.uSpriteMode.value = 1; $('#spriteSim').classList.add('on'); S.spriteView = { t0: S.time.getTime() / 1000 }; }
    else if (site && site.farStorms) { S.view.setFarStorms(site.farStorms); S.spriteView = null; }
    else { S.view.setFarStorms([]); S.spriteView = null; }
    $('#spritePrompt') && $('#spritePrompt').classList.add('hidden');
    if (site && site.lookAz != null) { S.view.yaw = site.lookAz; S.view.pitch = site.lookAlt || 10; }
    S.view.urban = lights ? urbanLookup(lights) : null;
    S.view3dSite = { lat, lon, lights };
    $('#structStatus').textContent = 'Buildings, trees and lights are off for speed — load them from here.';
    S.view.start();
    S.view.onPick = showPick;
    S.view.onFrame = hudRead;
    $('#load3d').classList.add('hidden');
    $('#pick3d').classList.add('hidden');
    hudRead(true);
  } catch (e) {
    console.error(e); prog('Could not build the 3D view: ' + e.message);
  }
}
function close3D() { if (S.view) S.view.stop(); $('#view3d').classList.add('hidden'); document.body.classList.remove('in3d'); document.body.insertBefore($('#offline'), $('#top')); }
let hudT = 0;
function hudRead(force) {
  const v = S.view; if (!v) return; const now = performance.now(); if (!force && now - hudT < 200) return; hudT = now;
  const L = v.layers, sm = v.sm;
  const types = L ? cloudTypeNames(L).join(', ') : '';
  const sqm = v.lp ? lum2mag(NAT_SKY + v.lp.zenith) : null;
  $('#read3d').innerHTML = `Looking ${dirName(v.yaw)} ${Math.round(v.yaw)}° · alt ${v.pitch.toFixed(0)}° · FOV ${v.fov.toFixed(0)}°<br>
    Sun ${sm.sun.alt.toFixed(1)}° · Moon ${sm.moon.alt.toFixed(0)}° (${(sm.moonFrac * 100).toFixed(0)}%)${sqm ? ` · zenith ${sqm.toFixed(2)} mag/″² (Bortle ${bortle(sqm)})` : ''}<br>
    ${types}${v.snowDepth > 0.005 ? ` · snow on ground ${U.cm(v.snowDepth * 100)}` : ''}${v.precipNow && v.precipNow.type !== 'none' ? ` · ${v.precipNow.type} ${v.precipNow.rate.toFixed(1)} mm/h` : ''}${v.ctx.sat ? ` · satellite ${v.ctx.sat.name} ${new Date(v.ctx.sat.obs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
}
function showPick(p) {
  const box = $('#pick3d');
  const o = p.object;
  box.innerHTML = `${o ? `<b>${o.name}</b>${o.mag != null && o.kind !== 'sun' ? ` · mag ${o.mag.toFixed(1)}` : ''}<br>` : ''}Alt ${p.alt.toFixed(1)}° · Az ${p.az.toFixed(1)}° (${dirName(p.az)})${p.sqm ? `<br>Sky brightness there (clear, no moon): ${p.sqm.toFixed(2)} mag/arcsec²` : ''}`;
  box.classList.remove('hidden');
  clearTimeout(box._t); box._t = setTimeout(() => box.classList.add('hidden'), 6000);
}
function setup3DMenu() {
  const v = S.view, chips = $('#ovChips');
  const names = { grid: 'Alt/Az grid', cardinals: 'N E S W', meridian: 'Meridian', ecliptic: 'Ecliptic', equator: 'Celestial equator', constellations: 'Constellations', labels: 'Labels', domes: 'Light domes' };
  for (const [k, n] of Object.entries(names)) {
    const b = el('button', { class: 'chip' + (v.overlays.on[k] ? ' on' : '') }, n);
    b.onclick = () => { v.overlays.on[k] = !v.overlays.on[k]; b.classList.toggle('on', v.overlays.on[k]); v.overlays.apply(); };
    chips.append(b);
  }
  $('#ev').oninput = e => v.ev = +e.target.value;
  const mode = cam => { v.cameraMode = cam; $('#modeEye').classList.toggle('on', !cam); $('#modeCam').classList.toggle('on', cam); };
  $('#modeEye').onclick = () => mode(false); $('#modeCam').onclick = () => mode(true); mode(false);
  $('#eyeH').onchange = e => { v.eye = +e.target.value; v.escape(); };
  // on-screen walking stick (phones and tablets); WASD/arrows on a keyboard
  if (matchMedia('(pointer: coarse)').matches) {
    const joy = el('div', { class: 'hud joy' }, el('b', {}, 'walk'), el('i')), knob = joy.querySelector('i');
    $('#view3d').append(joy);
    let id = null, cx = 0, cy = 0;
    const set = (x, y) => { const R = 50, dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy), k = d > R ? R / d : 1; knob.style.transform = `translate(${dx * k}px,${dy * k}px)`; v.joy = { f: -dy * k / R, r: dx * k / R, run: d > R * 1.6 }; };
    joy.addEventListener('pointerdown', e => { e.stopPropagation(); id = e.pointerId; joy.setPointerCapture(id); const r = joy.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; set(e.clientX, e.clientY); });
    joy.addEventListener('pointermove', e => { if (e.pointerId === id) set(e.clientX, e.clientY); });
    const end = e => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; v.joy = null; };
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
  }
  $('#gyroBtn').onclick = async () => { const on = await v.enableGyro(!v.gyro); $('#gyroBtn').classList.toggle('on', on); $('#gyroBtn').textContent = on ? '📱 Look with phone: on' : '📱 Look with phone'; };
  $('#soundBtn').onclick = () => { if (v.audio.on) v.audio.disable(); else v.audio.enable(); $('#soundBtn').classList.toggle('on', v.audio.on); };
  $('#spriteSim').classList.toggle('on', v.U.uSpriteMode.value > 0.5);
  $('#spriteSim').onclick = () => { const on = v.U.uSpriteMode.value < 0.5; v.U.uSpriteMode.value = on ? 1 : 0; $('#spriteSim').classList.toggle('on', on); };
  $('#quality').onchange = e => { const q = e.target.value; v.q.cloudScale = q === 'low' ? 0.25 : q === 'high' ? (v.mobile ? 0.5 : 0.75) : (v.mobile ? 0.34 : 0.5); v.U.uSteps.value = q === 'low' ? 28 : q === 'high' ? 80 : v.mobile ? 36 : 56; v.mkTargets(); };
}
async function loadStructuresNow() {
  const v = S.view; if (!v || !v.ctx) return;
  const st = $('#structStatus'), btn = $('#loadStruct'); btn.disabled = true;
  const detail = +$('#structDetail').value;
  st.textContent = 'Downloading OpenStreetMap buildings, trees, lamps, power lines…';
  try {
    const { detectCanopy } = await import('./view3d/canopy.js');
    const [osm, ov, canopy] = await Promise.all([loadStructures(v.ctx.lat, v.ctx.lon, detail), loadOverture(v.ctx.lat, v.ctx.lon, detail).catch(() => null),
      $('#estTrees').checked ? detectCanopy(v.ctx.local, Math.min(detail * 1.6, 1200), v.mobile).catch(e => (console.warn('canopy', e), null)) : null]);
    osm.overture = osm.fallback ? { buildings: [], addrs: [], cover: ov ? ov.cover : { grass: [], tree: [] } } : ov;   // fallback scene already is Overture
    st.textContent = `Building 3D models for ${osm.buildings.length} buildings, ${osm.trees.length} mapped trees, ${osm.forests.length} woods…`;
    await new Promise(r => setTimeout(r, 30));
    const lat = v.ctx.lat, al = Math.abs(lat), coniferShare = al > 58 ? 0.92 : al > 50 ? 0.6 : al > 42 ? 0.35 : al < 23 ? 0 : 0.2;
    const urban = v.urban ? ((x, z) => { const [la, lo] = v.ctx.local.toLL(x, -z); return v.urban(la, lo); }) : (() => 0);
    const stats = v.setStructures(osm, { detail, canopyTrees: canopy, imageryTrees: $('#estTrees').checked, estimateLamps: $('#estLamps').checked, urbanAt: urban, coniferShare });
    st.textContent = `Loaded ${stats.buildings} buildings${stats.extraBuildings ? ` (${stats.extraBuildings} footprints from Microsoft/Google/other maps via Overture)` : ''}${stats.addrHouses ? ` (${stats.addrHouses} generic houses at addresses with no footprint)` : ''}, ${stats.trees} trees${canopy ? ` (incl. crowns seen in aerial photos)` : ''}, ${stats.lamps} lights${v.structures.powerStats ? `, ${v.structures.powerStats.towers + v.structures.powerStats.poles} power structures` : ''}${stats.farms ? `. Fields: ${stats.farms}` : ''} (${stats.ms} ms).${osm.stale ? ' (saved copy)' : ''}${osm.fallback ? ' OpenStreetMap servers were busy, so this scene uses Overture Maps data (no lamps or tree points).' : ''}`;
  } catch (e) { st.textContent = 'Could not load map data: ' + e.message; }
  btn.disabled = false;
}

// ---------------- Best spots ----------------
function renderScoutTab() {
  const box = $('#tab-scout');
  if (!S.sel) { box.innerHTML = '<div class="empty">Pick your starting point on the map first.</div>'; return; }
  if (box.dataset.for === `${S.sel.lat},${S.sel.lon}` && S.scoutRes) return;
  box.dataset.for = `${S.sel.lat},${S.sel.lon}`;
  box.innerHTML = `
    <div class="sub">Starting from <b>${S.sel.name}</b></div>
    <div class="row"><label>Max drive <select id="scDrive"><option value="0.75">45 min</option><option value="1">1 h</option><option value="1.5" selected>1.5 h</option><option value="2">2 h</option><option value="3">3 h</option><option value="4">4 h</option></select></label>
    <label>Night <select id="scNight"><option value="0">Tonight</option><option value="1">Tomorrow</option><option value="2">In 2 nights</option></select></label></div>
    <div class="row"><label>Goal <select id="scGoal"><option value="mw">Milky Way / wide-field</option><option value="deep">Deep-sky imaging</option><option value="land">Nightscape (moon OK)</option><option value="planet">Planets / Moon (seeing)</option></select></label></div>
    <div class="row"><label>Access <select id="scRoad"><option value="road">Right next to a road (no walking)</option><option value="walk">Walk-in spots OK (up to 3 km)</option></select></label></div>
    <div class="row"><label>Rank by <select id="scRank"><option value="score">Everything (overall score)</option><option value="clear">Clear sky only</option><option value="dark">Darkness / light pollution only</option><option value="horizon">Open horizon only</option><option value="weather">Weather only (clouds, fog, haze)</option><option value="drive">Shortest drive</option><option value="seeing">Seeing only</option></select></label></div>
    <button class="btn primary big" id="scGo">Find the best spots</button>
    <div id="scProg" class="small muted"></div><div id="scList"></div>`;
  $('#scGo').onclick = runScout;
  $('#scRank').onchange = () => listScout();
  if (S.scoutRes) listScout();
}
async function runScout() {
  const home = [S.sel.lat, S.sel.lon], maxH = +$('#scDrive').value, nightOff = +$('#scNight').value, goal = $('#scGoal').value;
  const prog = t => $('#scProg').textContent = t;
  const d0 = new Date(Date.now() + nightOff * 864e5);
  const night = nightInfo(d0, home[0], home[1]);
  const W = { mw: {}, deep: { dark: 0.3, clear: 0.38, transp: 0.1 }, land: { dark: 0.12, clear: 0.45, fog: 0.12 }, planet: { dark: 0.05, seeing: 0.25, clear: 0.42, transp: 0.04 } }[goal];
  const radiusKm = maxH * 75;
  try {
    prog('Loading regional night lights…');
    const regional = await loadRegionalLights(home[0], home[1], radiusKm + 120);
    // tie the quick estimator to the full model where both exist
    if (regional && S.data && S.data.lp && Math.abs(S.data.lat - home[0]) < 1e-6) { const q = quickLP(regional, home[0], home[1]); if (q.zen > 0) QUICK.zen = clamp(S.data.lp.zenith / q.zen, 3e-7, 3e-5); const hz = S.data.lp.horizon.reduce((a, b) => a + b, 0) / S.data.lp.horizon.length; if (q.hor > 0 && hz > 0) QUICK.hor = clamp(hz / q.hor, 1e-7, 1e-4); }
    const depart = new Date(Math.max(Date.now(), (night.sunset || d0).getTime() - maxH * 3600e3));
    const res = await scout(home, { radiusKm, night, regional, departLocal: depart, weights: W, maxDriveH: maxH, allowOffRoad: $('#scRoad').value === 'walk' }, prog);
    res.night = night; res.home = home; res.regional = regional; res.depart = depart;
    S.scoutRes = res; if (!res.sites.length) { prog(`No reachable sites: ${res.candidates} candidates were all on water or more than ${$('#scRoad').value === 'walk' ? '3 km' : '2.5 km'} from a road. Try a longer drive or walk-in spots.`); listScout(); return; }
    prog(`${res.noRouting ? '⚠ Drive times are straight-line estimates (routing unavailable). ' : ''}Checked ${res.sites.length} reachable sites (${$('#scRoad').value === 'walk' ? 'walk-in spots allowed' : 'all right at a road'}) ${res.backup ? 'with the lower-quality backup forecast (MET Norway; the free 7-model service is at its limit)' : 'with 3 models'} for ${night.noon.toLocaleDateString([], { weekday: 'long' })} night.`);
    listScout();
  } catch (e) { console.error(e); prog('Scouting failed: ' + e.message); }
}
function listScout() {
  const r = S.scoutRes, box = $('#scList'); if (!r || !box) return;
  map.results.clearLayers(); map.routes.clearLayers();
  // Rank by one trait if asked; reachable sites (within the drive limit) only.
  const rank = ($('#scRank') || {}).value || 'score';
  const metric = {
    score: s => s.score, clear: s => s.clear - s.spread / 400, dark: s => s.sqm, horizon: s => s.horizon ?? -1,
    weather: s => s.clear * 0.7 + (1 - s.fog) * 0.15 + s.transp * 0.15 - s.spread / 400, drive: s => -s.driveTraffic, seeing: s => s.seeing,
  }[rank];
  const pool = rank === 'score' ? r.sites : r.sites.filter(s => s.reachable);
  const top = [...pool].sort((a, b) => metric(b) - metric(a)).slice(0, 12);
  box.innerHTML = rank === 'horizon' ? '<div class="small muted">Horizon is checked for the strongest ~40 sites (terrain plus mapped forests and buildings).</div>' : '';
  top.forEach((s, i) => {
    const c = s.score > 70 ? '#5ad19a' : s.score > 50 ? '#e8c35a' : '#ff7b6b';
    const m = L.marker(s.p, { icon: L.divIcon({ className: '', html: `<div class="mk" style="background:${c}">${s.score}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map.results);
    const bars = [['Clear', s.clear], ['Dark', clamp((s.sqm - 18) / 3.9, 0, 1)], ['Horizon', s.horizon ?? 0], ['No fog', 1 - s.fog], ['Transp.', s.transp], ['Seeing', s.seeing]];
    const card = el('div', { class: 'site' });
    card.innerHTML = `<div class="top"><div><b>#${i + 1}</b> · ${U.km(s.dist)} ${dirName(bearing(r.home[0], r.home[1], s.p[0], s.p[1]))} · ${U.m(s.elev || 0)}</div><div style="color:${c};font-weight:800;font-size:18px">${s.score}</div></div>
      <div class="small">${s.driveTraffic != null ? `🚗 ${fmtDur(s.driveTraffic)}${s.drive && s.driveTraffic > s.drive * 1.05 ? ` <span class="muted">(${fmtDur(s.drive)} without traffic)</span>` : ''}` : 'No road route found'} · SQM ${s.sqm.toFixed(2)} (Bortle ${s.bortle}) · clouds ${(100 - s.clear * 100).toFixed(0)}% ±${s.spread.toFixed(0)}</div>
      <div class="grid2" style="grid-template-columns:repeat(3,1fr);gap:4px 10px;margin:6px 0 2px">${bars.map(([k, v]) => `<div class="small">${k}<div class="bar"><i style="width:${(v * 100).toFixed(0)}%;background:${colorFor(v)}"></i></div></div>`).join('')}</div>
      ${s.hazards.length ? s.hazards.map(h => `<span class="tag bad">${h}</span>`).join('') : ''}${s.snowDepth > 0.01 ? `<span class="tag">Snow ${U.cm(s.snowDepth * 100)}</span>` : ''}${s.fog > 0.4 ? '<span class="tag ok">Fog possible</span>' : ''}${s.walk > 60 ? `<span class="tag ok">Park at the road, walk ${U.km(s.walk / 1000)}</span>` : '<span class="tag good">At the road</span>'}${s.horizon == null ? '<span class="tag">Horizon not checked</span>' : s.horizonWorst > 8 ? `<span class="tag ok">Obstructed up to ${Math.round(s.horizonWorst)}° in places</span>` : s.horizon > 0.85 ? '<span class="tag good">Open horizon</span>' : ''}${s.hazards.length || s.snowDepth > 0.01 ? '' : ''}`;
    const act = el('div', { class: 'row' });
    act.append(el('button', { class: 'btn', onclick: e => { e.stopPropagation(); open3D({ lat: s.p[0], lon: s.p[1], name: `Spot #${i + 1}` }); } }, '3D view'),
      el('a', { class: 'btn', href: `https://maps.apple.com/?daddr=${(s.parkAt || s.p)[0]},${(s.parkAt || s.p)[1]}&dirflg=d`, target: '_blank' }, 'Apple Maps'),
      el('a', { class: 'btn', href: `https://www.google.com/maps/dir/?api=1&destination=${(s.parkAt || s.p)[0]},${(s.parkAt || s.p)[1]}&travelmode=driving`, target: '_blank' }, 'Google Maps'));
    card.append(act);
    card.onclick = () => selectSite(s, card);
    m.on('click', () => { selectSite(s, card); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    box.append(card);
  });
  const b = L.latLngBounds([r.home, ...top.map(s => s.p)]); map.map.fitBounds(b.pad(0.15));
}
async function selectSite(s, card) {
  document.querySelectorAll('.site').forEach(c => c.classList.toggle('sel', c === card));
  map.routes.clearLayers();
  const r = S.scoutRes;
  let rt = s.route;
  if (!rt) { try { rt = await route(r.home, s.p, r.depart, urbanLookup(r.regional), () => s.roadK); s.route = rt; } catch { } }
  if (!rt) return;
  if (rt.segs) for (const sg of rt.segs) L.polyline([sg.a, sg.b], { color: sg.k > 1.35 ? '#ff5a4a' : sg.k > 1.12 ? '#ffb14a' : '#5ad19a', weight: 5, opacity: 0.85 }).addTo(map.routes);
  else L.polyline(rt.line, { color: '#7cb4ff', weight: 5 }).addTo(map.routes);
  L.polyline(rt.line, { color: '#000', weight: 9, opacity: 0.25 }).addTo(map.routes).bringToBack();
}

// ---------------- Sprites ----------------
function renderSpriteTab() {
  const box = $('#tab-sprites');
  if (!S.sel) { box.innerHTML = '<div class="empty">Pick your starting point on the map first.</div>'; return; }
  if (box.dataset.for === `${S.sel.lat},${S.sel.lon}` && S.spriteRes) return;
  box.dataset.for = `${S.sel.lat},${S.sel.lon}`;
  box.innerHTML = `
    <div class="sub">Red sprites, elves and other TLEs flash 50–90 km above big thunderstorm systems. You see them best from 150–400 km away, with clear sky toward the storm, the storm itself below your horizon line, and no moon.</div>
    <div class="row"><label>Night <select id="spNight"><option value="0">Tonight</option><option value="1">Tomorrow</option><option value="2">In 2 nights</option></select></label>
    <label>Max distance <select id="spDist"><option value="150">150 km</option><option value="300" selected>300 km</option><option value="500">500 km</option></select></label></div>
    <button class="btn primary big" id="spGo">Find sprite-viewing spots</button>
    <div id="spProg" class="small muted"></div><div id="spList"></div>`;
  $('#spGo').onclick = runSprites;
}
async function runSprites() {
  const home = [S.sel.lat, S.sel.lon], off = +$('#spNight').value, maxD = +$('#spDist').value;
  const prog = t => $('#spProg').textContent = t;
  const night = nightInfo(new Date(Date.now() + off * 864e5), home[0], home[1]);
  try {
    prog('Loading night lights…');
    const regional = await loadRegionalLights(home[0], home[1], maxD + 200).catch(() => null);
    const res = await findSprites(home, { night, regional, maxDriveKm: maxD }, prog);
    // put each viewing spot on a drivable road (never in a lake)
    if (res.best.length) {
      prog('Snapping viewing spots to roads…');
      const dt = await driveTable(home, res.best.map(r => r.p));
      res.best = res.best.filter((r, i) => { const d = dt[i]; if (!d || !d.snap || d.snapDist > 3000) return false; r.p = d.snap; r.drive = d.dur; return true; });
    }
    S.spriteRes = res; listSprites(res, night);
  } catch (e) { console.error(e); prog('Sprite search failed: ' + e.message); }
}
function openSpriteSpot(r, name) {
  setTime(new Date(r.t * 1000));
  open3D({ lat: r.p[0], lon: r.p[1], name, lookAz: r.bearing, lookAlt: r.spriteAlt * 0.6, spriteData: { stormsByHour: S.spriteRes.stormsByHour } });
}
// Every 3 hours of forecast time the storms have moved: suggest the best viewing spot for the new time.
function checkSpritePrompt() {
  const sv = S.spriteView, res = S.spriteRes; if (!sv || !res || !res.all || !S.view || !S.view.running) return;
  const t = S.time.getTime() / 1000;
  if (Math.abs(t - sv.t0) < 3 * 3600) return;
  sv.t0 = t;
  const hourly = res.all.filter(r => Math.abs(r.t - t) <= 1800).sort((a, b) => b.score - a.score);
  let box = $('#spritePrompt');
  if (!box) { box = el('div', { id: 'spritePrompt', class: 'hud card' }); $('#view3d').append(box); }
  if (!hourly.length) { box.innerHTML = `<b>Storms have moved</b><div class="small">No good sprite viewing spot is forecast for ${fmtDT(S.time, tz())}.</div><div class="row"><button class="btn" id="spOk">OK</button></div>`; }
  else {
    const b = hourly[0];
    box.innerHTML = `<b>3 hours later: storms have moved</b><div class="small">Best sprite spot for ${fmtDT(S.time, tz())}: ${U.km(b.dHome)} from your start, look ${dirName(b.bearing)} at a storm ${U.km(b.dist)} away.</div><div class="row"><button class="btn primary" id="spGo2">Go there</button><button class="btn" id="spOk">Stay here</button></div>`;
    box.querySelector('#spGo2').onclick = () => { box.classList.add('hidden'); openSpriteSpot(b, 'Sprite spot (updated)'); };
  }
  box.querySelector('#spOk').onclick = () => box.classList.add('hidden');
  box.classList.remove('hidden');
}
function listSprites(res, night) {
  const box = $('#spList'); map.storms.clearLayers(); map.results.clearLayers();
  const z = tz();
  const nStorms = res.stormsByHour.reduce((s, h) => s + h.clusters.length, 0);
  $('#spProg').textContent = res.best.length ? `Found ${res.best.length} viewing spots.` : nStorms ? 'Storms are forecast, but none are well placed with clear sky toward them tonight.' : 'No sprite-capable thunderstorm systems are forecast within range for this night.';
  if (res.backup) $('#spProg').textContent += ' (Lower-quality backup forecast: the free 7-model service is at its limit, so storms are found only from forecast thunder, without instability data.)'
  box.innerHTML = '';
  // storm cells at the best hour
  const bestT = res.best[0] ? res.best[0].t : (res.stormsByHour.find(h => h.clusters.length) || {}).t;
  const sh = res.stormsByHour.find(h => h.t === bestT);
  if (sh) sh.s.forEach((v, k) => { if (v > 0.22) L.circle(res.grid.pts[k], { radius: res.grid.stepKm * 500, color: '#ff4d6d', weight: 0, fillOpacity: 0.15 + v * 0.45 }).addTo(map.storms); });
  res.best.forEach((r, i) => {
    const t = new Date(r.t * 1000);
    L.marker(r.p, { icon: L.divIcon({ className: '', html: `<div class="mk" style="background:#ff4d6d;color:#fff">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map.storms);
    L.polyline([r.p, [r.storm.la, r.storm.lo]], { color: '#ff8aa0', weight: 2, dashArray: '6 6' }).addTo(map.storms);
    const card = el('div', { class: 'site' });
    card.innerHTML = `<div class="top"><div><b>#${i + 1}</b> · ${U.km(r.dHome)} from start</div><div style="color:var(--sprite);font-weight:800">${Math.round(r.score * 100)}</div></div>
      <div class="small">${fmtDT(t, z)} · look <b>${dirName(r.bearing)} (${Math.round(r.bearing)}°)</b> · storm ${U.km(r.dist)} away · sprites ~${r.spriteAlt.toFixed(0)}° up, anvil top ${r.anvilAlt.toFixed(1)}°</div>
      <div class="small muted">Storm system ~${Math.round(r.storm.area / 1000)}k km² · clear path ${(r.clearPath * 100).toFixed(0)}% · sky overhead ${(r.localClear * 100).toFixed(0)}% clear · moon ${r.moonPen > 0.05 ? 'up' : 'down'}</div>`;
    const act = el('div', { class: 'row' });
    act.append(el('button', { class: 'btn', onclick: e => { e.stopPropagation(); setTime(t); openSpriteSpot(r, `Sprite spot #${i + 1}`); } }, '3D view toward storm'),
      el('a', { class: 'btn', href: `https://maps.apple.com/?daddr=${r.p[0]},${r.p[1]}&dirflg=d`, target: '_blank' }, 'Directions'));
    card.append(act);
    box.append(card);
  });
}

boot();
window.SS = S; S.api = { open3D, setTime, close3D, selectLocation };
