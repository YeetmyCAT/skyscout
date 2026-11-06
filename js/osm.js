// OpenStreetMap features via Overpass: buildings, trees, forests, roads, lamps, power lines, towers, turbines.
import { cachedJSON } from './util.js';

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
 way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|motorway_link|trunk_link|primary_link|living_street)$"](${mid});
 node["highway"="street_lamp"](${mid});
 node["man_made"="street_lamp"](${mid});
 way["power"~"^(line|minor_line)$"](${far});
 node["power"="generator"]["generator:source"="wind"](${far});
 node["man_made"~"^(mast|tower|communications_tower|chimney|water_tower|flare)$"](${far});
 way["man_made"~"^(chimney|water_tower|silo|storage_tank)$"](${mid});
 way["power"="plant"](${far}); way["landuse"="industrial"](${mid});
 way["leisure"~"^(pitch|stadium|sports_centre)$"]["lit"="yes"](${mid});
 way["amenity"="parking"](${near});
 way["amenity"="fuel"](${mid}); node["amenity"="fuel"](${mid});
 way["aeroway"~"^(runway|apron)$"](${far});
);
out geom qt;`;
  let lastErr;
  for (const m of MIRRORS) {
    try {
      const r = await cachedJSON(`osm:${lat.toFixed(3)},${lon.toFixed(3)}:${detail}`, m, 14 * 864e5,
        { fetch: { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, timeout: 100000 });
      return classify(r.data, r);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unavailable');
}

const num = v => { if (v == null) return null; const m = String(v).match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };

function classify(data, meta) {
  const out = { buildings: [], farms: [], rivers: [], trees: [], forests: [], water: [], roads: [], lamps: [], powerLines: [], turbines: [], towers: [], lit: [], industrial: [], parking: [], fuel: [], runways: [], fetched: meta.t, stale: meta.stale };
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
    else if (t.highway) out.roads.push({ line: geom, kind: t.highway, lanes: num(t.lanes), lit: t.lit === 'yes', name: t.name || t.ref || '' });
    else if (t.power === 'line' || t.power === 'minor_line') out.powerLines.push({ line: geom, minor: t.power === 'minor_line', voltage: num(t.voltage), cables: num(t.cables) });
    else if (t.man_made) out.towers.push({ p: geom[0], ring: geom, kind: t.man_made, h: num(t.height) || ({ chimney: 60, water_tower: 35, silo: 25, storage_tank: 14 }[t.man_made] || 20) });
    else if (t.power === 'plant') out.industrial.push({ ring: geom, plant: true, name: t.name });
    else if (t.landuse === 'industrial') out.industrial.push({ ring: geom });
    else if (t.leisure) out.lit.push({ ring: geom });
    else if (t.amenity === 'parking') out.parking.push({ ring: geom });
    else if (t.amenity === 'fuel') out.fuel.push({ p: geom[0], ring: geom });
    else if (t.aeroway) out.runways.push({ line: geom, kind: t.aeroway });
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
