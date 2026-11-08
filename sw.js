// Offline support: app files cache-first, map tiles stale-while-revalidate. Forecast data is kept in IndexedDB by the app.
const APP = 'skyscout-app-v11', TILES = 'skyscout-tiles-v1';
const FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'vendor/three.module.min.js', 'vendor/astronomy.browser.min.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'js/main.js', 'js/util.js', 'js/weather.js', 'js/satellite.js', 'js/terrain.js', 'js/lightpol.js', 'js/lpworker.js', 'js/astro.js', 'js/osm.js', 'js/routing.js', 'js/scout.js', 'js/sprites.js', 'js/map.js', 'js/atlas.js', 'js/horizon.js', 'js/pmtiles.js', 'js/space.js', 'js/backup.js', 'js/view3d/canopy.js', 'js/view3d/skyevents.js', 'data/milkyway.jpg', 'data/stars8.bin', 'vendor/satellite.min.js', 'vendor/tz-lookup.js',
  'js/view3d/view.js', 'js/view3d/glsl.js', 'js/view3d/sky.js', 'js/view3d/clouds.js', 'js/view3d/noiseworker.js', 'js/view3d/ground.js', 'js/view3d/structures.js', 'js/view3d/weatherfx.js', 'js/view3d/overlays.js', 'js/view3d/farms.js',
  'data/stars.json', 'data/constlines.json', 'data/milkyway.json', 'data/ircolormap.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(APP).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => null))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== APP && n !== TILES).map(n => caches.delete(n))))); self.clients.claim(); });
const TILE_HOSTS = /tile\.openstreetmap\.org|arcgisonline\.com|tilecache\.rainviewer\.com|gibs\.earthdata\.nasa\.gov/;
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    // app files: network first when online (so updates arrive), cache when offline
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(APP).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  if (TILE_HOSTS.test(u.host) && !u.pathname.includes('WMTSCapabilities')) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trim(c); } return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
let trimming = false;
async function trim(c) { if (trimming) return; trimming = true; const k = await c.keys(); if (k.length > 2500) for (const r of k.slice(0, k.length - 2000)) await c.delete(r); trimming = false; }
