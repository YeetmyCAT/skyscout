// Farm fields from OpenStreetMap (landuse=farmland / meadow / orchard / vineyard), planted with the crop most likely
// for the region and shown at the right stage of its calendar: tilled soil, emergence, full canopy, flowering,
// ripening, harvest stubble, winter cover or snow. Field surfaces cover the whole area; 3D plants grow near the viewer.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';
import { LIT_VS, lighting, pointInPoly, ringLocal } from './structures.js';
import { hash, clamp } from '../util.js';

export const CROPS = ['maize', 'soy', 'wwheat', 'swheat', 'canola', 'rice', 'cotton', 'cane', 'pasture', 'vine', 'orchard'];
const CI = Object.fromEntries(CROPS.map((c, i) => [c, i]));
export const CROP_NAMES = { maize: 'Corn (maize)', soy: 'Soybeans', wwheat: 'Winter wheat', swheat: 'Spring wheat / barley', canola: 'Canola / rapeseed', rice: 'Rice', cotton: 'Cotton', cane: 'Sugarcane', pasture: 'Pasture / hay', vine: 'Vineyard', orchard: 'Orchard' };

// Most likely crop for a field, by region (field seed picks within the regional mix).
export function cropFor(lat, lon, seed, kind, tag) {
  if (kind === 'meadow') return 'pasture';
  if (kind === 'vineyard') return 'vine';
  if (kind === 'orchard') return 'orchard';
  const t = (tag || '').toLowerCase();
  const tagMap = { maize: 'maize', corn: 'maize', soy: 'soy', soybean: 'soy', soybeans: 'soy', wheat: 'wwheat', winter_wheat: 'wwheat', barley: 'swheat', oats: 'swheat', rape: 'canola', rapeseed: 'canola', canola: 'canola', rice: 'rice', paddy: 'rice', cotton: 'cotton', sugarcane: 'cane', grass: 'pasture', hay: 'pasture' };
  for (const [k, v] of Object.entries(tagMap)) if (t.includes(k)) return v;
  const a = Math.abs(lat), pick = (...opts) => { let s = 0; for (const [c, w] of opts) { s += w; if (seed < s) return c; } return opts[opts.length - 1][0]; };
  // North America
  if (lon < -50 && lat > 0) {
    if (lat > 49 && lon < -95) return pick(['swheat', 0.5], ['canola', 0.3], ['pasture', 0.2]);
    if (lon > -98 && lon < -80 && lat > 37 && lat < 47) return pick(['maize', 0.48], ['soy', 0.4], ['pasture', 0.08], ['wwheat', 0.04]);
    if (lon <= -98 && lon > -105 && lat > 33) return pick(['wwheat', 0.6], ['maize', 0.15], ['pasture', 0.25]);
    if (lat < 37 && lat > 29 && lon > -100) return pick(['cotton', 0.3], ['soy', 0.3], ['maize', 0.2], ['pasture', 0.2]);
    if (lon < -114) return pick(['orchard', 0.25], ['swheat', 0.3], ['pasture', 0.45]);
    return pick(['maize', 0.35], ['soy', 0.25], ['pasture', 0.3], ['wwheat', 0.1]);
  }
  // South / East Asia monsoon belt
  if (lon > 68 && lon < 150 && lat > -10 && lat < 36) return pick(['rice', 0.65], ['cane', 0.1], ['maize', 0.15], ['wwheat', 0.1]);
  // Tropics elsewhere
  if (a < 23) return pick(['cane', 0.35], ['maize', 0.35], ['soy', 0.15], ['pasture', 0.15]);
  // Europe / western Asia
  if (lon > -12 && lon < 60 && lat > 35) {
    if (lat < 43) return pick(['wwheat', 0.5], ['vine', 0.15], ['orchard', 0.15], ['pasture', 0.2]);
    return pick(['wwheat', 0.4], ['swheat', 0.15], ['canola', 0.15], ['maize', 0.15], ['pasture', 0.15]);
  }
  // Southern temperate (Argentina, Australia, South Africa)
  if (lat < -23) return pick(['soy', 0.3], ['wwheat', 0.35], ['maize', 0.15], ['pasture', 0.2]);
  return pick(['wwheat', 0.4], ['maize', 0.25], ['pasture', 0.35]);
}

// Stage of each crop on a given day: A = (cover 0..1, height m, ripeness 0..1, flowering 0..1),
// B = (stubble 0..1, tilled 0..1, flooded 0..1, harvested share of fields 0..1).
export function cropStages(lat, date, season) {
  const doy = (date - new Date(Date.UTC(date.getUTCFullYear(), 0, 1))) / 864e5;
  const d = lat < 0 ? (doy + 182.5) % 365 : doy;
  const sh = (Math.abs(lat) - 40) * 1.2;              // later planting further poleward
  const r = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
  const A = [], B = [];
  const set = (i, a, b) => { A[i] = a; B[i] = b; };
  // maize
  { const p = 125 + sh, cov = r(d, p + 12, p + 70), h = 2.6 * Math.pow(r(d, p + 10, p + 80), 1.3), ripe = r(d, p + 110, p + 150), harv = r(d, p + 160, p + 195);
    const before = d < p; set(CI.maize, [before ? 0 : cov, before ? 0 : h, ripe, r(d, p + 70, p + 80) * (1 - r(d, p + 95, p + 110))], [before ? (d < p - 25 ? 1 : 0.2) : harv, before ? r(d, p - 30, p - 5) : 0, 0, harv]); }
  // soybeans
  { const p = 140 + sh, cov = r(d, p + 12, p + 60), h = 0.85 * r(d, p + 10, p + 70), ripe = r(d, p + 100, p + 125), harv = r(d, p + 128, p + 155);
    const before = d < p; set(CI.soy, [before ? 0 : cov, before ? 0 : h, ripe, 0], [before ? (d < p - 25 ? 1 : 0.2) : harv, before ? r(d, p - 25, p - 5) : 0, 0, harv]); }
  // winter wheat: autumn sown, green over winter, golden in early summer
  { const sow = 270 - sh * 0.5, g0 = 75 + sh, ripeA = 165 + sh, harvA = 190 + sh;
    let cov, h, ripe = r(d, ripeA, ripeA + 20), harv = r(d, harvA, harvA + 18), till = 0, stub = 0;
    if (d >= sow) { cov = 0.45 * r(d, sow + 10, sow + 40); h = 0.12 * r(d, sow + 10, sow + 40); till = 1 - r(d, sow + 5, sow + 25); }
    else if (d < g0) { cov = 0.45; h = 0.12; }
    else if (d < harvA + 18) { cov = 0.45 + 0.55 * r(d, g0, g0 + 50); h = 0.12 + 0.8 * r(d, g0, g0 + 75); }
    else { cov = 0; h = 0; stub = 1 - r(d, sow - 40, sow - 10); till = r(d, sow - 40, sow - 10); }
    if (d >= harvA && d < harvA + 18) stub = harv;
    set(CI.wwheat, [cov, h, d < sow && d > g0 ? ripe : 0, 0], [stub, till, 0, d >= sow || d < g0 ? 0 : harv]); }
  // spring wheat / barley
  { const p = 110 + sh, cov = r(d, p + 12, p + 60), h = 0.85 * r(d, p + 10, p + 70), ripe = r(d, p + 95, p + 118), harv = r(d, p + 120, p + 140);
    const before = d < p; set(CI.swheat, [before ? 0 : cov, before ? 0 : h, ripe, 0], [before ? (d < p - 20 ? 1 : 0.2) : harv, before ? r(d, p - 20, p - 3) : 0, 0, harv]); }
  // canola (winter rapeseed): rosettes over winter, bright yellow in spring
  { const sow = 235 - sh * 0.5, bolt = 80 + sh, flA = 108 + sh, flB = 140 + sh, ripeA = 175 + sh, harvA = 198 + sh;
    let cov = 0.5, h = 0.25, fl = r(d, flA, flA + 8) * (1 - r(d, flB - 8, flB)), ripe = r(d, ripeA, harvA), harv = r(d, harvA, harvA + 12), stub = 0, till = 0;
    if (d >= sow) { cov = 0.5 * r(d, sow + 10, sow + 45); h = 0.25 * r(d, sow + 10, sow + 45); }
    else if (d > bolt && d < harvA + 12) { cov = 0.5 + 0.5 * r(d, bolt, bolt + 30); h = 0.25 + 1.2 * r(d, bolt, flA + 15); }
    else if (d >= harvA + 12) { cov = 0; h = 0; stub = 1 - r(d, sow - 30, sow); till = r(d, sow - 30, sow); }
    set(CI.canola, [cov, h, d < sow ? ripe : 0, fl], [stub, till, 0, d < sow && d > bolt ? harv : 0]); }
  // rice: flooded paddies, transplanted seedlings, green, golden, stubble (two crops a year in the tropics)
  { const dd = Math.abs(lat) < 20 ? (d % 182.5) * 2 : d;
    const fl = r(dd, 130, 140) * (1 - r(dd, 200, 225)), cov = r(dd, 150, 215), h = 1.0 * r(dd, 145, 225), ripe = r(dd, 250, 275), harv = r(dd, 280, 300);
    set(CI.rice, [dd < 145 || dd > 300 ? 0 : cov, dd < 145 || dd > 300 ? 0 : h, ripe, 0], [dd > 280 || dd < 125 ? 1 : 0, r(dd, 115, 128) * (1 - r(dd, 128, 135)), fl, harv]); }
  // cotton: white bolls before harvest
  { const p = 120 + sh, cov = r(d, p + 15, p + 80), h = 1.1 * r(d, p + 15, p + 90), boll = r(d, p + 125, p + 150), harv = r(d, p + 165, p + 200);
    set(CI.cotton, [d < p ? 0 : cov, d < p ? 0 : h, boll * 0.5, boll], [d < p || harv > 0 ? (d < p ? 1 : harv) : 0, d < p ? r(d, p - 25, p - 5) : 0, 0, harv]); }
  // sugarcane: tall all year, about a third of fields recently cut and regrowing
  set(CI.cane, [0.95, 3.2, 0.1, 0], [0, 0, 0, 0.33]);
  // pasture / hay: green in the growing season, tan when dormant
  set(CI.pasture, [0.9, 0.25 * (0.4 + 0.6 * season.green), 1 - season.green, 0], [0, 0, 0, 0.25 * r(d, 160, 175)]);
  // vineyard rows follow the deciduous leaf cycle
  set(CI.vine, [season.leafFrac, 1.7, season.autumn, 0], [0, 0, 0, 0]);
  set(CI.orchard, [0.9, 0.2, 1 - season.green, 0], [0, 0, 0, 0]);
  return { A, B, d };
}

function fieldMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: U, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    vertexShader: LIT_VS,
    fragmentShader: COMMON + lighting() + /* glsl */`
      in vec3 vW; in vec3 vN; in vec2 vUv; in vec4 vInfo;
      uniform vec4 uStageA[11], uStageB[11];
      #include <logdepthbuf_pars_fragment>
      vec3 cropColor(int t, float ripe, float fl, float s){
        vec3 g = mix(vec3(0.06,0.14,0.04), vec3(0.09,0.17,0.05), s);
        vec3 ripeC = t == 0 ? vec3(0.34,0.27,0.15) : t == 1 ? mix(vec3(0.46,0.40,0.09), vec3(0.24,0.16,0.08), smoothstep(0.5,1.0,ripe))
                   : (t == 2 || t == 3) ? vec3(0.56,0.44,0.19) : t == 4 ? vec3(0.22,0.18,0.10) : t == 5 ? vec3(0.52,0.42,0.16)
                   : t == 6 ? vec3(0.30,0.24,0.14) : t == 8 ? vec3(0.36,0.31,0.17) : t == 9 ? vec3(0.50,0.33,0.07) : vec3(0.3,0.25,0.12);
        vec3 c = mix(g, ripeC, ripe);
        if (t == 4) c = mix(c, vec3(0.80,0.68,0.03), fl);   // canola bloom
        if (t == 6) c = mix(c, vec3(0.82,0.82,0.78), fl*0.8); // open cotton bolls
        return c;
      }
      void main(){
        #include <logdepthbuf_fragment>
        int t = int(vInfo.x + 0.5); float seed = vInfo.y, ang = vInfo.z;
        vec4 A = uStageA[t], B = uStageB[t];
        bool harvested = seed < B.w;
        float cover = harvested ? 0.0 : A.x, ripe = A.z, fl = A.w;
        vec2 dir = vec2(cos(ang), sin(ang));
        float across = dot(vW.xz, vec2(-dir.y, dir.x)), along = dot(vW.xz, dir);
        float rowSp = t == 0 || t == 1 || t == 6 ? 0.76 : t == 9 ? 2.6 : t == 10 ? 6.0 : t == 7 ? 1.5 : 0.18;
        float rr = abs(fract(across/rowSp) - 0.5)*2.0;     // 0 on the row, 1 between rows
        float rowMask = smoothstep(cover*1.05 + 0.02, cover*0.8, rr);
        if (t == 8 || t == 5 && cover > 0.7) rowMask = cover;
        float n = fbm2(vW.xz*0.9 + seed*40.0), n2 = fbm2(vW.xz*0.07 + seed*13.0);
        vec3 soil = mix(vec3(0.085,0.065,0.05), vec3(0.15,0.115,0.085), n2*0.8 + 0.1);
        soil *= mix(1.0, 0.85 + 0.3*step(0.5, fract(across/0.35)), B.y);    // fresh tillage furrows
        vec3 stubble = mix(vec3(0.40,0.34,0.21), vec3(0.30,0.25,0.16), n) ;
        vec3 ground = mix(soil, stubble, harvested || B.x > 0.5 ? 0.55*(1.0 - B.y) : B.x*0.4);
        if (harvested || B.x > 0.5) ground = mix(ground, stubble, 0.6*step(0.6, fract(across/(t == 0 ? 0.76 : 0.18)))*(1.0 - B.y));
        vec3 crop = cropColor(t, ripe, fl, seed) * (0.75 + 0.5*n);
        vec3 alb = mix(ground, crop, rowMask*min(1.0, cover*1.3));
        // flooded paddies reflect the sky
        float water = B.z * (1.0 - cover*0.85);
        // snow: fills between rows first; tall crops and stubble poke through
        float poke = clamp(A.y*0.6 + (harvested ? 0.15 : 0.0), 0.0, 0.8);
        float snow = clamp(uSnow*1.2 - poke*rowMask, 0.0, 1.0) * (0.85 + 0.15*n);
        alb = mix(alb, vec3(0.82,0.85,0.9), snow);
        vec3 col = shade(alb, vec3(0.0,1.0,0.0), vW, 1.0);
        vec3 V = normalize(vW - cameraPosition);
        col = mix(col, hazeL(reflect(V, vec3(0.0,1.0,0.0))) * 0.8, water * (0.4 + 0.6*pow(1.0 - abs(V.y), 3.0)));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function plantMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: U, side: THREE.DoubleSide,
    vertexShader: '#include <common>\n' + COMMON + /* glsl */`
      attribute vec4 aP; attribute vec2 aT; uniform vec4 uStageA[11], uStageB[11];
      out vec2 vUv; out vec3 vW; out vec2 vT; out vec4 vA;
      #include <logdepthbuf_pars_vertex>
      void main(){
        int t = int(aT.x + 0.5); vec4 A = uStageA[t], B = uStageB[t];
        bool harvested = aT.y < B.w;
        float h = harvested ? (t == 0 ? 0.3 : 0.08) : A.y;
        float w = t == 0 ? 0.7 : t == 1 || t == 6 ? 0.6 : t == 7 ? 1.2 : t == 9 ? 1.4 : 0.42;
        h *= 0.85 + 0.3*fract(aT.y*13.7);
        vec3 p = position;
        float sway = sin(uTime*1.3 + aP.x*0.4 + aP.z*0.3) * 0.05 * p.y*p.y;
        float c = cos(aP.w), s = sin(aP.w);
        vec3 q = vec3(p.x*w*c - p.z*w*s + sway, p.y*h, p.x*w*s + p.z*w*c);
        vec3 wp = aP.xyz + q;
        vUv = uv; vW = wp; vT = vec2(aT.x, harvested ? 1.0 : 0.0); vA = A;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        #include <logdepthbuf_vertex>
        if (h < 0.03 || A.x < 0.02 && !harvested) gl_Position = vec4(2.0,2.0,2.0,1.0);
      }`,
    fragmentShader: COMMON + lighting() + /* glsl */`
      in vec2 vUv; in vec3 vW; in vec2 vT; in vec4 vA;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        int t = int(vT.x + 0.5); bool harv = vT.y > 0.5;
        vec2 u = vUv; float x = u.x - 0.5, y = u.y;
        float a = 0.0; float flower = 0.0;
        if (harv) { a = step(abs(fract(u.x*9.0) - 0.5), 0.12); }
        else if (t == 0 || t == 7) {        // corn / cane: stalk + arching leaves + tassel
          a = step(abs(x), 0.025);
          for (int i = 0; i < 6; i++){ float yy = 0.18 + float(i)*0.13; float side = mod(float(i), 2.0)*2.0 - 1.0;
            float lx = x*side; float curve = yy + lx*0.9 - lx*lx*2.2; a = max(a, step(0.0, lx) * step(lx, 0.45) * step(abs(y - curve), 0.03*(1.0 - lx*1.8))); }
          if (t == 0) { float tas = step(0.92, y) * step(abs(x), 0.05 + (y - 0.92)*0.5); a = max(a, tas); flower = tas; }
        } else if (t == 2 || t == 3 || t == 5 || t == 8) {   // cereals, rice, grass: many thin blades with ears
          for (int i = 0; i < 7; i++){ float bx = (hash12(vec2(float(i), 3.1)) - 0.5)*0.9; float bh = 0.7 + 0.3*hash12(vec2(float(i), 7.7));
            a = max(a, step(abs(x - bx - y*0.08*sign(bx)), 0.018) * step(y, bh));
            if (t != 8) { float ear = step(abs(x - bx - y*0.08*sign(bx)), 0.035) * step(bh - 0.18, y) * step(y, bh); a = max(a, ear); flower = max(flower, ear); } }
        } else {                             // soy, cotton, canola, vine: bushy foliage
          float r = length(vec2(x*1.4, (y - 0.55)*1.1));
          a = step(r + (fbm2(u*14.0) - 0.5)*0.35, 0.5) * step(0.05, y);
          a = max(a, step(abs(x), 0.02) * step(y, 0.4));
          if (t == 4) flower = step(0.75, y) * step(0.45, fbm2(u*22.0));
          if (t == 6) flower = step(0.62, fbm2(u*26.0)) * step(0.3, y);
        }
        if (a < 0.5) discard;
        float ripe = vA.z, fl = vA.w;
        vec3 g = vec3(0.07,0.15,0.045) * (0.7 + 0.6*u.y);
        vec3 ripeC = t == 0 ? vec3(0.36,0.29,0.16) : t == 1 ? vec3(0.44,0.38,0.09) : (t == 2 || t == 3 || t == 5) ? vec3(0.58,0.46,0.20) : t == 9 ? vec3(0.5,0.32,0.06) : vec3(0.35,0.3,0.16);
        vec3 alb = mix(g, ripeC, ripe);
        if (t == 4) alb = mix(alb, vec3(0.85,0.72,0.03), fl*flower);
        if (t == 6) alb = mix(alb, vec3(0.85,0.85,0.82), fl*flower);
        if ((t == 2 || t == 3 || t == 5) && flower > 0.5) alb *= 1.2;
        if (harv) alb = vec3(0.42,0.36,0.22);
        alb = mix(alb, vec3(0.82,0.85,0.9), uSnow*smoothstep(0.6, 1.0, u.y)*0.7);
        // canopy self-shadowing: lower leaves sit in the shade of the plants around them
        float ao = 0.22 + 0.78*pow(u.y, 1.4);
        alb *= ao * (0.8 + 0.4*hash12(floor(vW.xz*2.0)));
        vec3 nrm = normalize(vec3(sin(vW.x*3.1 + u.x*6.0)*0.6, 0.6, cos(vW.z*2.7 + u.x*5.0)*0.6));
        gl_FragColor = vec4(shade(alb, nrm, vW, 1.0), 1.0);
      }`,
  });
}

export class Farms {
  constructor(U, local, ground, ctx) {
    this.U = U; this.local = local; this.ground = ground; this.ctx = ctx; this.group = new THREE.Group();
    U.uStageA = { value: Array.from({ length: 11 }, () => new THREE.Vector4()) };
    U.uStageB = { value: Array.from({ length: 11 }, () => new THREE.Vector4()) };
  }
  build(farms) {
    const half = this.ctx.detail * 2.6, fields = [];
    const pos = [], nor = [], uv = [], info = [];
    let id = 0;
    for (const f of farms) {
      const p = ringLocal(this.local, f.ring); if (p.length < 3) continue;
      if (!p.some(([x, z]) => Math.abs(x) < half && Math.abs(z) < half)) continue;
      id++;
      const seed = hash((f.id || id) * 2654435761 % 1e9);
      const [la, lo] = this.local.toLL(p[0][0], -p[0][1]);
      const crop = cropFor(la, lo, hash((f.id || id) * 7 + 3), f.kind, f.crop);
      if (crop === 'orchard') { fields.push({ p, crop, seed, ang: 0, orchard: true }); continue; }
      // rows follow the longest edge
      let best = 0, ang = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length], L = Math.hypot(q[0] - p[i][0], q[1] - p[i][1]); if (L > best) { best = L; ang = Math.atan2(q[1] - p[i][1], q[0] - p[i][0]); } }
      const t = CI[crop];
      fields.push({ p, crop, t, seed, ang });
      // drape: triangulate on a grid clipped to the polygon so it follows the terrain
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; p.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
      const step = Math.max(12, Math.min(40, Math.sqrt((x1 - x0) * (z1 - z0)) / 12));
      const inf = [t, seed, ang, 0];
      const H = (x, z) => this.ground.heightAt(x, z) + 0.12;
      for (let x = x0; x < x1; x += step) for (let z = z0; z < z1; z += step) {
        const c = [[x, z], [x + step, z], [x + step, z + step], [x, z + step]];
        const inside = c.map(([a, b]) => pointInPoly(a, b, p));
        if (!inside.some(Boolean)) continue;
        if (!inside.every(Boolean) && !pointInPoly(x + step / 2, z + step / 2, p)) continue;
        const v = c.map(([a, b]) => [a, H(a, b), b]);
        for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...v[k]); nor.push(0, 1, 0); uv.push(0, 0); info.push(...inf); }
      }
    }
    this.fields = fields;
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
      const m = new THREE.Mesh(g, fieldMaterial(this.U)); m.frustumCulled = false; this.group.add(m);
    }
    // near-viewer plants
    this.max = this.ctx.mobile ? 9000 : 24000;
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), q2 = quad.clone().rotateY(Math.PI / 2);
    const base = new THREE.BufferGeometry();
    const merge = [quad, q2].map(q => q.toNonIndexed());
    base.setAttribute('position', new THREE.Float32BufferAttribute([...merge[0].attributes.position.array, ...merge[1].attributes.position.array], 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute([...merge[0].attributes.uv.array, ...merge[1].attributes.uv.array], 2));
    const ig = new THREE.InstancedBufferGeometry().copy(base);
    ig.setAttribute('aP', new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4));
    ig.setAttribute('aT', new THREE.InstancedBufferAttribute(new Float32Array(this.max * 2), 2));
    ig.instanceCount = 0; this.plantGeo = ig;
    this.plants = new THREE.Mesh(ig, plantMaterial(this.U)); this.plants.frustumCulled = false; this.group.add(this.plants);
    // orchards become rows of small trees
    this.orchardTrees = [];
    for (const f of fields.filter(f => f.orchard)) {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; f.p.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
      for (let x = x0; x < x1; x += 6) for (let z = z0; z < z1; z += 5) if (pointInPoly(x, z, f.p) && this.orchardTrees.length < 6000) this.orchardTrees.push({ x, z, h: 4 + hash(x * 3 + z) * 1.5, kind: 0 });
    }
    this.fieldAtCache = new Map();
    this.isCrop = (x, z) => { const k = Math.round(x / 6) + ',' + Math.round(z / 6); if (this.fieldAtCache.has(k)) return this.fieldAtCache.get(k); const f = fields.find(f => !f.orchard && f.crop !== 'pasture' && Math.abs(f.p[0][0] - x) < 4000 && pointInPoly(x, z, f.p)); this.fieldAtCache.set(k, !!f); return !!f; };
    this.counts = {}; for (const f of fields) this.counts[f.crop] = (this.counts[f.crop] || 0) + 1;
    return this;
  }
  setDate(lat, date, season) {
    const s = cropStages(lat, date, season);
    for (let i = 0; i < 11; i++) { this.U.uStageA.value[i].set(...(s.A[i] || [0, 0, 0, 0])); this.U.uStageB.value[i].set(...(s.B[i] || [0, 0, 0, 0])); }
  }
  // scatter plants on fields around the viewer
  update(cam) {
    const c = cam.position;
    if (this.center && Math.hypot(c.x - this.center.x, c.z - this.center.z) < 10) return;
    this.center = c.clone();
    const R = this.ctx.mobile ? 26 : 34, step = 0.42;
    const near = this.fields.filter(f => !f.orchard && f.p.some(([x, z]) => Math.abs(x - c.x) < 3000 && Math.abs(z - c.z) < 3000));
    const P = this.plantGeo.attributes.aP.array, T = this.plantGeo.attributes.aT.array;
    let n = 0; const cellField = new Map();
    const fieldAt = (x, z) => { const k = Math.round(x / 4) + ',' + Math.round(z / 4); if (cellField.has(k)) return cellField.get(k); const f = near.find(f => pointInPoly(x, z, f.p)) || null; cellField.set(k, f); return f; };
    // rings outward so the nearest plants are always placed
    for (let r = 0; r < R && n < this.max; r += step) {
      const ring = Math.max(1, Math.floor(2 * Math.PI * r / step));
      for (let k = 0; k < ring && n < this.max; k++) {
        const a = k / ring * 2 * Math.PI + r;
        let x = Math.round(c.x / step) * step + Math.cos(a) * r, z = Math.round(c.z / step) * step + Math.sin(a) * r;
        const f = fieldAt(x, z); if (!f) continue;
        if (this.ground.isWater(x, z)) continue;
        const rowSp = f.t === 0 || f.t === 1 || f.t === 6 ? 0.76 : f.t === 9 ? 2.6 : f.t === 7 ? 1.5 : 0;
        if (rowSp) { // snap to crop rows
          const dx = -Math.sin(f.ang), dz = Math.cos(f.ang), across = x * dx + z * dz, snapped = Math.round(across / rowSp) * rowSp;
          if (Math.abs(across - snapped) > step * 0.6) continue;
          x += (snapped - across) * dx; z += (snapped - across) * dz;
        }
        const s = hash(n * 7 + Math.round(x * 13) + Math.round(z * 7) * 31);
        P[n * 4] = x + (s - 0.5) * 0.1; P[n * 4 + 1] = this.ground.heightAt(x, z) + 0.05; P[n * 4 + 2] = z; P[n * 4 + 3] = f.ang + (s - 0.5) * 0.8 + (rowSp ? 0 : s * 6);
        T[n * 2] = f.t; T[n * 2 + 1] = f.seed;
        n++;
      }
    }
    this.plantGeo.instanceCount = n;
    this.plantGeo.attributes.aP.needsUpdate = true; this.plantGeo.attributes.aT.needsUpdate = true;
  }
}
