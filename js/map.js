// 2D map: base maps, live satellite / radar / night-light overlays, cloud forecast overlay, results.
import { gibsTime, decodeIR } from './satellite.js';
import { BLACK_MARBLE_TILES } from './lightpol.js';
import { tomtomKey } from './routing.js';
import { cachedJSON } from './util.js';
import { ATLAS_TILES } from './atlas.js';

const L = window.L;
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

// Infrared tiles decoded to brightness temperature: clear warm ground is transparent, clouds white,
// cold convective tops coloured (so you can see storms and cloud height at a glance).
let CM = null;
const cmReady = fetch('data/ircolormap.json').then(r => r.json()).then(a => { CM = new Map(); for (let i = 0; i < a.length; i += 4) CM.set((a[i] << 16) | (a[i + 1] << 8) | a[i + 2], a[i + 3]); });
const IRLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = async () => {
      await cmReady;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 256, 256);
      try {
        const d = g.getImageData(0, 0, 256, 256), p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          if (p[i + 3] < 10) continue;
          const T = decodeIR(CM, p[i], p[i + 1], p[i + 2]);
          if (!isFinite(T) || T < -86) { p[i + 3] = 0; continue; }   // off-disk space and the cold limb edge
          const a = Math.max(0, Math.min(1, (2 - T) / 30));
          let r = 235, gg = 240, b = 255;
          if (T < -45) { const k = Math.min(1, (-45 - T) / 30); r = 255; gg = 240 - 180 * k; b = 255 - 220 * k; }       // deep convection: yellow to red
          if (T < -75) { r = 255; gg = 60; b = 200; }                                                           // overshooting tops: magenta
          p[i] = r * (0.55 + 0.45 * a); p[i + 1] = gg * (0.55 + 0.45 * a); p[i + 2] = b * (0.55 + 0.45 * a); p[i + 3] = a * 235;
        }
        g.putImageData(d, 0, 0);
      } catch { }
      done(null, c);
    };
    img.onerror = () => done(null, c);
    img.src = this.getTileUrl(coords);
    return c;
  },
});

export class MapView {
  constructor(el, onPick) {
    const map = this.map = L.map(el, { zoomControl: false, worldCopyJump: true, attributionControl: true, minZoom: 2, maxZoom: 18, zoomSnap: 0.5 });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    this.bases = {
      dark: L.layerGroup([L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors' }),
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, pane: 'labels' })]),
      streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
      imagery: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' }),
    };
    // panes: IR clouds blend with "screen" so warm clear ground (dark) vanishes and cold cloud tops glow
    map.createPane('wx'); map.getPane('wx').style.zIndex = 350; 
    map.createPane('labels'); map.getPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none';
    this.baseKey = localStorage.getItem('ss_base') || 'imagery';
    this.base = (this.bases[this.baseKey] || this.bases.imagery).addTo(map);
    const t = gibsTime(Date.now() - 30 * 60e3);
    const ir = (sat) => new IRLayer(`${GIBS}/${sat}_Band13_Clean_Infrared/default/${t}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`, { maxNativeZoom: 6, maxZoom: 18, opacity: 0.95, pane: 'wx', attribution: 'NASA GIBS / NOAA GOES / JMA Himawari' });
    const gc = (sat) => L.tileLayer(`${GIBS}/${sat}_GeoColor/default/${t}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`, { maxNativeZoom: 7, maxZoom: 18, opacity: 0.85, pane: 'wx' });
    this.ov = {
      ir: L.layerGroup([ir('Himawari_AHI'), ir('GOES-West_ABI'), ir('GOES-East_ABI')]),
      geocolor: L.layerGroup([gc('GOES-West_ABI'), gc('GOES-East_ABI')]),
      radar: L.layerGroup(),
      lights: L.tileLayer(BLACK_MARBLE_TILES, { maxNativeZoom: 8, maxZoom: 18, opacity: 0.75, attribution: 'NASA Black Marble (VIIRS)' }),
      atlas: L.tileLayer(ATLAS_TILES, { minZoom: 2, maxNativeZoom: 8, maxZoom: 19, tileSize: 1024, zoomOffset: -2, opacity: 0.55, attribution: 'Light Pollution Atlas 2025, D. Lorenz (VIIRS)' }),
      cloudfc: L.layerGroup(),
      traffic: L.layerGroup(),
    };
    this.ov.ir.addTo(map);
    this.results = L.layerGroup().addTo(map); this.routes = L.layerGroup().addTo(map); this.storms = L.layerGroup().addTo(map);
    this.selMarker = null;
    map.on('click', e => onPick(e.latlng.lat, e.latlng.lng));
    const last = JSON.parse(localStorage.getItem('ss_view') || 'null');
    if (last) map.setView(last.c, last.z); else map.setView([39.5, -96], 4);
    map.on('moveend', () => { try { localStorage.setItem('ss_view', JSON.stringify({ c: map.getCenter(), z: map.getZoom() })); } catch { } });
  }
  setBase(k) { this.map.removeLayer(this.base); this.base = this.bases[k].addTo(this.map); if (this.base.bringToBack) this.base.bringToBack(); this.baseKey = k; try { localStorage.setItem('ss_base', k); } catch { } }
  async toggle(k, on) {
    const m = this.map, layer = this.ov[k];
    if (!on) { m.removeLayer(layer); return ''; }
    if (k === 'radar') {
      layer.clearLayers();
      try {
        const r = await cachedJSON('rainviewer', 'https://api.rainviewer.com/public/weather-maps.json', 5 * 60e3);
        const f = r.data.radar.past.at(-1);
        layer.addLayer(L.tileLayer(`${r.data.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`, { maxNativeZoom: 7, maxZoom: 18, opacity: 0.7, attribution: 'RainViewer' }));
        layer.addTo(m); return `Radar ${new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      } catch { return 'Radar unavailable'; }
    }
    if (k === 'traffic') {
      layer.clearLayers(); const key = tomtomKey();
      if (!key) return 'Add a TomTom key in Settings for live traffic.';
      layer.addLayer(L.tileLayer(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`, { maxZoom: 18, opacity: 0.9, attribution: 'TomTom Traffic' }));
      layer.addTo(m); return '';
    }
    layer.addTo(m);
    if (k === 'ir') return 'Infrared shows cloud tops; brighter/colder = higher. Europe/Africa: no geostationary layer available, models only.';
    return '';
  }
  select(lat, lon) {
    if (this.selMarker) this.selMarker.remove();
    this.selMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="selmk"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(this.map);
  }
  // Cloud cover forecast overlay from a grid: values[j][i] 0..1 over bounds
  setCloudOverlay(grid, bounds) {
    this.ov.cloudfc.clearLayers();
    if (!grid) return;
    const n = grid.length, m = grid[0].length, S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fy = y / (S - 1) * (n - 1), fx = x / (S - 1) * (m - 1), j = Math.min(n - 2, Math.floor(fy)), i = Math.min(m - 2, Math.floor(fx)), u = fx - i, v = fy - j;
      const c = (grid[j][i] * (1 - u) + grid[j][i + 1] * u) * (1 - v) + (grid[j + 1][i] * (1 - u) + grid[j + 1][i + 1] * u) * v;
      const k = (y * S + x) * 4; img.data[k] = img.data[k + 1] = 235; img.data[k + 2] = 255; img.data[k + 3] = Math.max(0, Math.min(255, c * 210));
    }
    g.putImageData(img, 0, 0);
    L.imageOverlay(cv.toDataURL(), bounds, { opacity: 0.85, interactive: false }).addTo(this.ov.cloudfc);
  }
}
