// OpenStreetMap features via Overpass: buildings, trees, forests, roads, lamps, power lines, towers, turbines.
import { cachedJSON } from './util.js';
import { overtureFeatures } from './pmtiles.js';

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

function bbox(lat, lon, r) { const dl = r / 111000, dn = r / (111000 * Math.cos(lat * Math.PI / 180)); return `${(lat - dl).toFixed(5)},${(lon - dn).toFixed(5)},${(lat + dl).toFixed(5)},${(lon + dn).toFixed(5)}`; }

// detail: radius of buildings/trees in metres
export async function loadStructures(lat, lon, detail = 1500) {
  const near = bbox(lat, lon, detail), mid = bbox(lat, lon, Math.max(detail * 2.5, 4000)), far = bbox(lat, lon, 20000);
  const q = `[out:json][timeout:90][maxsize:200000000];
(
 way["building"](${near});
 node["natural"="tree"](${near});
 way["natural"="tree_row"](${near});
 way["natural"="wood"](${mid}); way["landuse"="forest"](${mid});
 relation["natural"="wood"](${mid}); relation["landuse"="forest"](${mid});
 way["landuse"~"^(farmland|orchard|vineyard|meadow|allotments|plant_nursery)$"](${mid});
 relation["landuse"~"^(farmland|meadow)$"](${mid});
 way["natural"="water"](${mid}); way["waterway"="riverbank"](${mid}); relation["natural"="water"](${mid});
 way["waterway"~"^(river|canal|stream)$"](${mid});
 way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|track|road)$"](${mid});
 way["highway"~"^(footway|path|cycleway|pedestrian|bridleway)$"](${near});
 way["railway"~"^(rail|light_rail|narrow_gauge|tram|subway|preserved|monorail)$"](${mid});
 way["amenity"="parking"](${mid}); way["area:highway"](${near}); way["highway"="pedestrian"]["area"="yes"](${near});
 node["addr:housenumber"](${near}); node["building"](${near});
 node["highway"="street_lamp"](${mid});
 node["man_made"="street_lamp"](${mid});
 way["power"~"^(line|minor_line)$"](${far});
 node["power"="generator"]["generator:source"="wind"](${far});
 node["man_made"~"^(mast|tower|communications_tower|chimney|water_tower|flare)$"](${far});
 way["man_made"~"^(chimney|water_tower|silo|storage_tank)$"](${mid});
 way["power"="plant"](${far}); way["landuse"="industrial"](${mid});
 way["leisure"~"^(pitch|stadium|sports_centre)$"]["lit"="yes"](${mid});
 way["amenity"="fuel"](${mid}); node["amenity"="fuel"](${mid});
 way["aeroway"~"^(runway|apron)$"](${far});
);
out geom qt;`;
  const key = `osm2:${lat.toFixed(3)},${lon.toFixed(3)}:${detail}`;
  const tryOverpass = async () => {
    let lastErr;
    for (const m of MIRRORS) {
      try {
        const r = await cachedJSON(key, m, 14 * 864e5, { fetch: { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, timeout: 60000 });
        if (!r.data || !r.data.elements) throw new Error('bad reply');
        return classify(r.data, r);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass unavailable');
  };
  // OSM's query servers are often overloaded: if no answer within 25 s, build from Overture Maps instead.
  const osm = tryOverpass();
  const timer = new Promise(res => setTimeout(() => res('timeout'), 25000));
  const first = await Promise.race([osm.catch(() => 'failed'), timer]);
  if (first !== 'timeout' && first !== 'failed') return first;
  const fb = await loadOvertureScene(lat, lon, detail);
  fb.fallback = true;
  return fb;
}

const num = v => { if (v == null) return null; const m = String(v).match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };

function classify(data, meta) {
  const out = { addrs: [], rails: [], paved: [], buildings: [], farms: [], rivers: [], trees: [], forests: [], water: [], roads: [], lamps: [], powerLines: [], turbines: [], towers: [], lit: [], industrial: [], parking: [], fuel: [], runways: [], fetched: meta.t, stale: meta.stale };
  for (const e of data.elements || []) {
    const t = e.tags || {};
    const geom = e.geometry ? e.geometry.map(p => [p.lat, p.lon]) : null;
    if (e.type === 'node') {
      const p = [e.lat, e.lon];
      if (t.natural === 'tree') out.trees.push({ p, h: num(t.height), leaf: t.leaf_type, crown: num(t.diameter_crown) });
      else if (t.highway === 'street_lamp' || t.man_made === 'street_lamp') out.lamps.push({ p, mapped: true });
      else if (t.power === 'generator') out.turbines.push({ p, h: num(t.height) || num(t['generator:height']) || 90, rotor: num(t['rotor:diameter']) || 100 });
      else if (t.man_made) out.towers.push({ p, kind: t.man_made, h: num(t.height) || ({ mast: 90, tower: 60, communications_tower: 150, chimney: 60, water_tower: 35, flare: 30 }[t.man_made] || 40) });
      else if (t.amenity === 'fuel') out.fuel.push({ p });
      else if (t.building || t['addr:housenumber']) out.addrs.push({ p, building: t.building, levels: num(t['building:levels']), h: num(t.height), shop: !!(t.shop || t.amenity || t.office || t.craft) });
      continue;
    }
    if (e.type === 'relation') {
      const rings = (e.members || []).filter(m => m.role === 'outer' && m.geometry).map(m => m.geometry.map(p => [p.lat, p.lon]));
      if (t.natural === 'water') { for (const r of rings) out.water.push({ ring: r }); continue; }
      if (/farmland|meadow/.test(t.landuse || '')) { for (const r of rings) out.farms.push({ ring: r, kind: t.landuse, crop: t.crop, id: e.id }); continue; }
      for (const r of rings) out.forests.push({ ring: r, leaf: t.leaf_type });
      continue;
    }
    if (!geom) continue;
    if (t.building) {
      const levels = num(t['building:levels']), h = num(t.height);
      out.buildings.push({ ring: geom, type: t.building, h, levels, roofShape: t['roof:shape'], roofLevels: num(t['roof:levels']), minH: num(t.min_height), colour: t['building:colour'], roofColour: t['roof:colour'] });
    } else if (t.natural === 'tree_row') out.trees.push(...geom.map(p => ({ p, row: true, leaf: t.leaf_type })));
    else if (/^(farmland|orchard|vineyard|meadow|allotments|plant_nursery)$/.test(t.landuse || '')) out.farms.push({ ring: geom, kind: t.landuse, crop: t.crop, id: e.id });
    else if (t.natural === 'wood' || t.landuse === 'forest') out.forests.push({ ring: geom, leaf: t.leaf_type });
    else if (/^(river|canal|stream)$/.test(t.waterway || '')) out.rivers.push({ line: geom, w: t.waterway === 'stream' ? 3 : num(t.width) || (t.waterway === 'canal' ? 15 : 25) });
    else if (t.natural === 'water' || t.waterway) out.water.push({ ring: geom });
    else if (t['area:highway'] || (t.highway && t.area === 'yes')) out.paved.push({ ring: geom, kind: 'pedestrian' });
    else if (t.highway) { if (t.tunnel && t.tunnel !== 'no') continue; out.roads.push({ line: geom, kind: t.highway, lanes: num(t.lanes), lit: t.lit === 'yes', name: t.name || t.ref || '', surface: t.surface || (t.highway === 'track' ? (t.tracktype === 'grade1' ? 'paved' : 'unpaved') : ''), oneway: t.oneway === 'yes' || /motorway$|_link/.test(t.highway) && t.oneway !== 'no', width: num(t.width), footway: t.footway, service: t.service, bridge: !!(t.bridge && t.bridge !== 'no') }); }
    else if (t.railway) { if (t.tunnel && t.tunnel !== 'no') continue; out.rails.push({ line: geom, kind: t.railway, bridge: !!(t.bridge && t.bridge !== 'no') }); }
    else if (t.power === 'line' || t.power === 'minor_line') out.powerLines.push({ line: geom, minor: t.power === 'minor_line', voltage: num(t.voltage), cables: num(t.cables) });
    else if (t.man_made) out.towers.push({ p: geom[0], ring: geom, kind: t.man_made, h: num(t.height) || ({ chimney: 60, water_tower: 35, silo: 25, storage_tank: 14 }[t.man_made] || 20) });
    else if (t.power === 'plant') out.industrial.push({ ring: geom, plant: true, name: t.name });
    else if (t.landuse === 'industrial') out.industrial.push({ ring: geom });
    else if (t.leisure) out.lit.push({ ring: geom });
    else if (t.amenity === 'parking') { out.parking.push({ ring: geom }); if (!t.parking || /surface|lane/.test(t.parking)) out.paved.push({ ring: geom, kind: 'parking' }); }
    else if (t.amenity === 'fuel') out.fuel.push({ p: geom[0], ring: geom });
    else if (t.aeroway === 'apron') out.paved.push({ ring: geom, kind: 'apron' });
    else if (t.aeroway) out.runways.push({ line: geom, kind: t.aeroway, width: num(t.width) || 45 });
  }
  return out;
}

// Raw Overpass query with mirror fallback and caching.
export async function overpassQuery(q, key, ttl = 30 * 864e5, timeout = 90000) {
  let lastErr;
  for (const m of MIRRORS) {
    try {
      const r = await cachedJSON(key, m, ttl, { fetch: { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, timeout });
      return r.data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unavailable');
}

const ringArea = r => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][1] * r[i + 1][0] - r[i + 1][1] * r[i][0]; return a / 2; };
// Overture Maps extras: building footprints from all its sources (OSM, Microsoft, Google...), addresses, land cover.
export async function loadOverture(lat, lon, detail) {
  const [b, a, lc, lu] = await Promise.all([
    overtureFeatures('buildings', 'building', lat, lon, detail, 14).catch(() => []),
    overtureFeatures('addresses', 'address', lat, lon, detail, 14).catch(() => []),
    overtureFeatures('base', 'land_cover', lat, lon, Math.max(detail * 1.3, 2000), 13).catch(() => []),
    overtureFeatures('base', 'land_use', lat, lon, Math.max(detail * 1.3, 2000), 13).catch(() => []),
  ]);
  // buildings are clipped at tile edges: keep the largest piece of each id
  const byId = new Map();
  for (const f of b) {
    if (f.type !== 3 || !f.rings.length) continue;
    const pr = f.props, src = String(pr['@geometry_source'] || pr.sources || '');
    if (/OpenStreetMap/i.test(src)) continue;            // already have these from OSM, with richer tags
    if (pr.is_underground) continue;
    let best = null, ba = 0;
    for (const r of f.rings) { const ar = Math.abs(ringArea(r)); if (ar > ba) { ba = ar; best = r; } }
    const id = pr.id || Math.random();
    const prev = byId.get(id);
    if (!prev || prev.a < ba) byId.set(id, { a: ba, ring: best, pr });
  }
  const buildings = [...byId.values()].map(({ ring, pr }) => ({
    ring, type: pr.subtype === 'residential' ? 'house' : pr.class || pr.subtype || 'yes', h: pr.height || null, levels: pr.num_floors || null,
    roofShape: pr.roof_shape, source: String(pr['@geometry_source'] || 'Overture'),
  }));
  const addrs = a.filter(f => f.type === 1).map(f => ({ p: f.rings[0][0], overture: true }));
  const cover = { grass: [], tree: [], crop: [], urban: [] };
  for (const f of lc) { if (f.type !== 3) continue; const k = f.props.subtype; if (k === 'grass' || k === 'shrub' || k === 'moss' || k === 'wetland') cover.grass.push(...f.rings); else if (k === 'tree' || k === 'forest' || k === 'mangrove') cover.tree.push(...f.rings); else if (k === 'crop') cover.crop.push(...f.rings); else if (k === 'urban') cover.urban.push(...f.rings); }
  for (const f of lu) { if (f.type !== 3) continue; const c = (f.props.class || '') + ' ' + (f.props.subtype || ''); if (/bunker|parking|water_hazard/.test(c)) continue; if (/park|grass|golf|fairway|green|tee|rough|cemetery|recreation|meadow|village_green|garden|pitch|playground|lawn|common/.test(c)) cover.grass.push(...f.rings); }
  return { buildings, addrs, cover, counts: { buildings: buildings.length, addrs: addrs.length } };
}

const ROAD_CLASS = { motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary', residential: 'residential', living_street: 'living_street', unclassified: 'unclassified', service: 'service', pedestrian: 'pedestrian', footway: 'footway', sidewalk: 'footway', crosswalk: 'footway', steps: 'footway', cycleway: 'cycleway', path: 'path', track: 'track', bridleway: 'bridleway', unknown: 'residential' };
const jsonish = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
export async function loadOvertureScene(lat, lon, detail) {
  const mid = Math.max(detail * 1.6, 2400);
  const [b, a, seg, infra, lu, lc] = await Promise.all([
    overtureFeatures('buildings', 'building', lat, lon, detail, 14).catch(() => []),
    overtureFeatures('addresses', 'address', lat, lon, detail, 14).catch(() => []),
    overtureFeatures('transportation', 'segment', lat, lon, mid, 14).catch(() => []),
    overtureFeatures('base', 'infrastructure', lat, lon, Math.max(mid, 6000), 13).catch(() => []),
    overtureFeatures('base', 'land_use', lat, lon, mid, 13).catch(() => []),
    overtureFeatures('base', 'land_cover', lat, lon, mid, 13).catch(() => []),
  ]);
  const out = { addrs: [], rails: [], paved: [], buildings: [], farms: [], rivers: [], trees: [], forests: [], water: [], roads: [], lamps: [], powerLines: [], turbines: [], towers: [], lit: [], industrial: [], parking: [], fuel: [], runways: [], fetched: Date.now(), stale: false };
  const byId = new Map();
  for (const f of b) {
    if (f.type !== 3 || !f.rings.length || f.props.is_underground) continue;
    let best = null, ba = 0; for (const r of f.rings) { const ar = Math.abs(ringArea(r)); if (ar > ba) { ba = ar; best = r; } }
    const id = f.props.id || Math.random(), prev = byId.get(id);
    if (!prev || prev.a < ba) byId.set(id, { a: ba, ring: best, pr: f.props });
  }
  for (const { ring, pr } of byId.values()) out.buildings.push({ ring, type: pr.subtype === 'residential' ? 'house' : pr.class || pr.subtype || 'yes', h: pr.height || null, levels: pr.num_floors || null, roofShape: pr.roof_shape });
  for (const f of a) if (f.type === 1) out.addrs.push({ p: f.rings[0][0] });
  const segIds = new Set();
  for (const f of seg) {
    if (f.type !== 2) continue;
    const pr = f.props, key = pr.id + ':' + f.rings.length + ':' + (f.rings[0] && f.rings[0][0] && f.rings[0][0].join());
    if (segIds.has(key)) continue; segIds.add(key);
    const surf = jsonish(pr.road_surface), surface = Array.isArray(surf) ? (surf[0] && surf[0].value) : (surf || '');
    const flags = String(pr.road_flags || '') + String(pr.rail_flags || '');
    if (/is_tunnel|is_underground/.test(flags)) continue;
    for (const line of f.rings) {
      if (line.length < 2) continue;
      if (pr.subtype === 'rail') out.rails.push({ line, kind: /tram/.test(pr.class || '') ? 'tram' : 'rail', bridge: /is_bridge/.test(flags) });
      else if (pr.subtype === 'road') out.roads.push({ line, kind: ROAD_CLASS[pr.class] || 'residential', surface: surface || '', oneway: false, bridge: /is_bridge/.test(flags), lanes: null, width: null, lit: false, name: pr['@name'] || '' });
    }
  }
  for (const f of infra) {
    const c = f.props.class || '';
    if (f.type === 2 && /power_line|minor_line|cable/.test(c)) for (const line of f.rings) out.powerLines.push({ line, minor: /minor/.test(c), voltage: null });
    else if (f.type === 1 && /street_lamp/.test(c)) out.lamps.push({ p: f.rings[0][0], mapped: true });
    else if (f.type === 1 && /communication_tower|mast|tower|chimney|water_tower/.test(c)) out.towers.push({ p: f.rings[0][0], kind: /chimney/.test(c) ? 'chimney' : /water/.test(c) ? 'water_tower' : 'mast', h: f.props.height || 60 });
    else if (f.type === 1 && /wind_turbine|generator/.test(c)) out.turbines.push({ p: f.rings[0][0], h: 90, rotor: 100 });
  }
  for (const f of lu) {
    if (f.type !== 3) continue; const c = f.props.class || '';
    for (const ring of f.rings) {
      if (/farmland|orchard|vineyard|meadow/.test(c)) out.farms.push({ ring, kind: c === 'meadow' ? 'meadow' : c === 'orchard' ? 'orchard' : c === 'vineyard' ? 'vineyard' : 'farmland', id: f.props.id });
      else if (/industrial/.test(c)) out.industrial.push({ ring });
      else if (/parking/.test(c)) { out.parking.push({ ring }); out.paved.push({ ring, kind: 'parking' }); }
    }
  }
  for (const f of lc) if (f.type === 3 && /forest/.test(f.props.subtype || '')) for (const ring of f.rings) out.forests.push({ ring });
  return out;
}
