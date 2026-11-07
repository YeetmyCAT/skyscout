// Minimal PMTiles v3 reader + Mapbox Vector Tile decoder, for Overture Maps tiles (buildings, addresses, land cover).
// Overture merges OpenStreetMap, Microsoft and Google building footprints (and Esri, etc.) and removes duplicates.
import { idbGet, idbPut, lon2x, lat2y, x2lon, y2lat, pool } from './util.js';

export const OVERTURE = 'https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-10-21.0/';

async function gunzip(buf) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer());
}
async function range(url, off, len, ttl = 60 * 864e5) {
  const key = `${url}#${off}+${len}`, hit = await idbGet('blob', key);
  if (hit && Date.now() - hit.t < ttl) return new Uint8Array(await hit.b.arrayBuffer());
  const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!(r.status === 206 || r.status === 200)) throw new Error('HTTP ' + r.status);
  const b = await r.blob(); idbPut('blob', key, { t: Date.now(), b });
  return new Uint8Array(await b.arrayBuffer());
}
function varint(buf, pos) {
  let v = 0, s = 1, b;
  do { b = buf[pos.p++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
  return v;
}
function parseDir(buf) {
  const pos = { p: 0 }, n = varint(buf, pos), e = [];
  let id = 0;
  for (let i = 0; i < n; i++) { id += varint(buf, pos); e.push({ id, run: 0, len: 0, off: 0 }); }
  for (let i = 0; i < n; i++) e[i].run = varint(buf, pos);
  for (let i = 0; i < n; i++) e[i].len = varint(buf, pos);
  for (let i = 0; i < n; i++) { const v = varint(buf, pos); e[i].off = (v === 0 && i > 0) ? e[i - 1].off + e[i - 1].len : v - 1; }
  return e;
}
function tileId(z, x, y) {
  let acc = 0; for (let t = 0; t < z; t++) acc += Math.pow(4, t);
  let d = 0; const xy = [x, y];
  for (let s = Math.pow(2, z - 1); s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { xy[0] = s - 1 - xy[0]; xy[1] = s - 1 - xy[1]; } const t = xy[0]; xy[0] = xy[1]; xy[1] = t; }
  }
  return acc + d;
}
function find(entries, id) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1, c = id - entries[m].id; if (c > 0) lo = m + 1; else if (c < 0) hi = m - 1; else return entries[m]; }
  if (hi >= 0) { const e = entries[hi]; if (e.run === 0) return e; if (id - e.id < e.run) return e; }
  return null;
}
const archives = new Map();
export class PMTiles {
  constructor(url) { this.url = url; this.dirs = new Map(); }
  async header() {
    if (this.h) return this.h;
    const b = await range(this.url, 0, 16384), v = new DataView(b.buffer, b.byteOffset);
    const g = o => Number(v.getBigUint64(o, true));
    const h = { rootOff: g(8), rootLen: g(16), leafOff: g(40), tileOff: g(56), ic: b[97], tc: b[98], minz: b[100], maxz: b[101] };
    let root = b.slice(h.rootOff, h.rootOff + h.rootLen); if (h.ic === 2) root = await gunzip(root);
    h.root = parseDir(root); this.h = h; return h;
  }
  async tile(z, x, y) {
    const h = await this.header(), id = tileId(z, x, y);
    let dir = h.root;
    for (let depth = 0; depth < 4; depth++) {
      const e = find(dir, id); if (!e) return null;
      if (e.run > 0) { let t = await range(this.url, h.tileOff + e.off, e.len); if (h.tc === 2) t = await gunzip(t); return t; }
      const key = e.off + ':' + e.len;
      if (!this.dirs.has(key)) { let d = await range(this.url, h.leafOff + e.off, e.len); if (h.ic === 2) d = await gunzip(d); this.dirs.set(key, parseDir(d)); }
      dir = this.dirs.get(key);
    }
    return null;
  }
}
export const archive = name => { if (!archives.has(name)) archives.set(name, new PMTiles(OVERTURE + name + '.pmtiles')); return archives.get(name); };

// --- Mapbox Vector Tile decoding (protobuf) ---
function readMsg(buf, start, end, onField) {
  const pos = { p: start };
  while (pos.p < end) {
    const tag = varint(buf, pos), f = Math.floor(tag / 8), t = tag & 7;
    if (t === 2) { const len = varint(buf, pos); onField(f, 2, pos.p, pos.p + len); pos.p += len; }
    else if (t === 0) onField(f, 0, varint(buf, pos));
    else if (t === 5) { onField(f, 5, pos.p); pos.p += 4; }
    else if (t === 1) { onField(f, 1, pos.p); pos.p += 8; }
    else break;
  }
}
const td = new TextDecoder();
function packed(buf, s, e) { const out = [], pos = { p: s }; while (pos.p < e) out.push(varint(buf, pos)); return out; }
const zz = n => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);
export function decodeMVT(buf, wanted) {
  const layers = {};
  readMsg(buf, 0, buf.length, (f, t, s, e) => {
    if (f !== 3 || t !== 2) return;
    const L = { name: '', extent: 4096, keys: [], values: [], feats: [] };
    readMsg(buf, s, e, (f2, t2, s2, e2) => {
      if (f2 === 1) L.name = td.decode(buf.subarray(s2, e2));
      else if (f2 === 5) L.extent = s2;
      else if (f2 === 3) L.keys.push(td.decode(buf.subarray(s2, e2)));
      else if (f2 === 4) { let val = null; readMsg(buf, s2, e2, (f3, t3, a, b) => {
        if (f3 === 1) val = td.decode(buf.subarray(a, b));
        else if (f3 === 2) val = new DataView(buf.buffer, buf.byteOffset + a, 4).getFloat32(0, true);
        else if (f3 === 3) val = new DataView(buf.buffer, buf.byteOffset + a, 8).getFloat64(0, true);
        else if (f3 === 4 || f3 === 5) val = a; else if (f3 === 6) val = zz(a); else if (f3 === 7) val = !!a; }); L.values.push(val); }
      else if (f2 === 2) { const F = { type: 0, tags: [], geom: [] }; readMsg(buf, s2, e2, (f3, t3, a, b) => {
        if (f3 === 3) F.type = a; else if (f3 === 2) F.tags = packed(buf, a, b); else if (f3 === 4) F.geom = packed(buf, a, b); }); L.feats.push(F); }
    });
    if (!wanted || wanted.includes(L.name)) layers[L.name] = L;
  });
  return layers;
}
// Feature -> { type: 1 point / 2 line / 3 polygon, props, rings: [[[tx,ty]...]] } in tile pixel units (0..extent)
function geomOf(F) {
  const rings = []; let cur = null, x = 0, y = 0, i = 0;
  while (i < F.geom.length) {
    const c = F.geom[i++], cmd = c & 7, n = c >> 3;
    if (cmd === 1 || cmd === 2) for (let k = 0; k < n; k++) { x += zz(F.geom[i++]); y += zz(F.geom[i++]); if (cmd === 1) { cur = []; rings.push(cur); } cur.push([x, y]); }
    else if (cmd === 7 && cur && cur.length) cur.push(cur[0].slice());
  }
  return rings;
}
function props(L, F) { const p = {}; for (let i = 0; i < F.tags.length; i += 2) p[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]]; return p; }

// All features of a layer within radiusM of a point, geometry in lat/lon.
export async function overtureFeatures(name, layer, lat, lon, radiusM, z) {
  const dLat = radiusM / 111000, dLon = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
  const x0 = Math.floor(lon2x(lon - dLon, z)), x1 = Math.floor(lon2x(lon + dLon, z)), y0 = Math.floor(lat2y(lat + dLat, z)), y1 = Math.floor(lat2y(lat - dLat, z));
  const list = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push([x, y]);
  if (list.length > 36) return [];
  const A = archive(name), out = [];
  await pool(list, 4, async ([x, y]) => {
    const buf = await A.tile(z, x, y).catch(() => null); if (!buf) return;
    const L = decodeMVT(buf, [layer])[layer]; if (!L) return;
    for (const F of L.feats) {
      const rings = geomOf(F).map(r => r.map(([tx, ty]) => [y2lat(y + ty / L.extent, z), x2lon(x + tx / L.extent, z)]));
      out.push({ type: F.type, props: props(L, F), rings });
    }
  });
  return out;
}
