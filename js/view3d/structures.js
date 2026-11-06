// Mapped obstructions and light sources from OpenStreetMap, made to look real:
// buildings (real footprints, procedural facades, gable/hip roofs, lit windows), trees and forests,
// street lamps, porch lights, power lines with towers and sagging wires, wind turbines with aviation lights,
// masts/chimneys/water towers, roads with moving traffic lights, industrial flood lights.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';
import { hash, clamp } from '../util.js';

export const LIT_VS = '#include <common>\n' + COMMON + /* glsl */`
  attribute vec4 aInfo; // building: seed, kind, isRoof, floors | instanced: seed, kind
  out vec3 vW; out vec3 vN; out vec2 vUv; out vec4 vInfo;
  #include <logdepthbuf_pars_vertex>
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    #ifdef USE_INSTANCING
      w = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    #else
      vN = normalize(mat3(modelMatrix) * normal);
    #endif
    vW = w.xyz; vUv = uv; vInfo = aInfo;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
  }`;

export function lighting() {
  return /* glsl */`
  uniform sampler2D uLightMap; uniform float uLightHalf;
  vec3 shade(vec3 alb, vec3 n, vec3 W, float lmHeightFade){
    vec3 E = uSunE * directT(uSunDir.y) * max(dot(n, uSunDir), 0.0) * smoothstep(-0.01, 0.02, uSunDir.y)
           + uMoonE * directT(uMoonDir.y) * max(dot(n, uMoonDir), 0.0) * smoothstep(-0.01, 0.02, uMoonDir.y);
    vec3 sky = mix(skyL(normalize(vec3(n.x, 0.12, n.z))), skyL(vec3(0.0,1.0,0.0)), 0.5 + 0.5*n.y) * PI * (0.75 + 0.25*n.y);
    vec3 col = alb/PI * (E*uExposure*(1.0 - 0.9*uOvercast) + sky*0.85*(1.0 - 0.65*uOvercast));
    vec2 luv = W.xz/(2.0*uLightHalf) + 0.5;
    if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) col += alb/PI * texture(uLightMap, luv).rgb * 40.0 * uExposure * uNight * lmHeightFade;
    col += vec3(0.85,0.88,1.0)*uFlash.w*0.02*alb*exp(-length(W - uFlash.xyz)/8000.0);
    return aerial(col, normalize(W - cameraPosition), length(W - cameraPosition));
  }`;
}

function buildingMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: LIT_VS,
    fragmentShader: COMMON + lighting() + /* glsl */`
      in vec3 vW; in vec3 vN; in vec2 vUv; in vec4 vInfo;
      uniform float uLitFrac;
      #include <logdepthbuf_pars_fragment>
      vec3 pal(float s, float kind){
        if (kind > 1.5) return mix(vec3(0.55,0.55,0.52), vec3(0.42,0.45,0.48), s);       // industrial metal
        if (kind > 0.5) return mix(vec3(0.62,0.58,0.52), vec3(0.45,0.38,0.33), s);       // commercial: concrete / brick
        vec3 a[6] = vec3[6](vec3(0.86,0.85,0.80), vec3(0.78,0.72,0.60), vec3(0.62,0.64,0.62), vec3(0.55,0.62,0.70), vec3(0.55,0.30,0.24), vec3(0.72,0.68,0.58));
        return a[int(s*5.99)];
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        float seed = vInfo.x, kind = vInfo.y, roof = vInfo.z;
        vec3 alb; vec3 emit = vec3(0.0);
        if (roof > 0.5){
          vec3 shingle = mix(vec3(0.16,0.16,0.17), vec3(0.28,0.20,0.15), fract(seed*7.3));
          vec3 flat_ = vec3(0.45,0.45,0.43);
          alb = n.y > 0.97 && kind > 0.5 ? flat_ : shingle;
          alb *= 0.85 + 0.3*fbm2(vW.xz*2.0);
          if (n.y < 0.97) alb *= 0.9 + 0.1*step(0.5, fract(vUv.y*4.0));  // shingle courses
          alb = mix(alb, vec3(0.85,0.87,0.9), uSnow*smoothstep(0.2, 0.5, n.y));
        } else {
          alb = pal(fract(seed*13.7), kind);
          float u = vUv.x, v = vUv.y;
          if (kind < 0.5) alb *= 0.93 + 0.07*step(0.5, fract(v*5.0));     // lap siding
          // window grid
          float fh = kind > 0.5 ? 3.6 : 2.8, fw = kind > 0.5 ? 2.4 : 3.6;
          float fl = floor(v/fh), col = floor(u/fw);
          vec2 c = vec2(fract(u/fw), fract(v/fh));
          float ww = kind > 1.5 ? 0.0 : (kind > 0.5 ? 0.42 : 0.22), wh = kind > 0.5 ? 0.30 : 0.28;
          float win = step(abs(c.x - 0.5), ww) * step(abs(c.y - 0.55), wh) * step(fl, vInfo.w - 1.0) * step(0.0, v - 0.5);
          if (kind < 0.5) win *= step(0.3, hash12(vec2(col, fl) + seed*17.0));
          if (win > 0.5){
            float r = hash12(vec2(col*1.7 + seed*31.0, fl*3.1));
            vec3 glass = vec3(0.05,0.06,0.07);
            vec3 refl = hazeL(reflect(normalize(vW - cameraPosition), n)) * 0.25 / max(uExposure, 1e-9);
            alb = glass;
            // lit windows at night: warm or cool interior light behind curtains
            float on = step(r, uLitFrac * (kind > 0.5 ? 0.6 : 1.0)) * uNight;
            vec3 lc = mix(vec3(1.0, 0.68, 0.38), vec3(0.85, 0.88, 1.0), step(0.75, fract(r*9.1)));
            emit = lc * on * (2.5 + 9.0*fract(r*5.3));   // curtained rooms: a few to ~10 cd/m^2
          }
          if (kind < 0.5 && v < 2.1 && abs(fract(u/11.0) - 0.5) < 0.05 && fract(seed*3.3) > 0.4) alb = vec3(0.25,0.18,0.12); // door
        }
        float fade = clamp(1.0 - vUv.y/14.0, 0.15, 1.0);
        vec3 col = shade(alb, n, vW, fade);
        col += emit * uExposure * exp(-length(vW - cameraPosition) * 3.912 / max(uVisKm*1000.0, 500.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function vegMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: LIT_VS.replace('vInfo = aInfo;', 'vInfo = aInfo;\n#ifdef USE_INSTANCING\n    vInfo.x = instanceMatrix[3].x*0.013 + instanceMatrix[3].z*0.007;\n#endif\n'),
    fragmentShader: COMMON + lighting() + /* glsl */`
      in vec3 vW; in vec3 vN; in vec2 vUv; in vec4 vInfo;
      uniform float uLeafFrac, uAutumn, uSpring, uGreen;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        float part = vInfo.z; // 0 crown, 1 trunk
        float kind = vInfo.y; // 0 broadleaf, 1 conifer
        vec3 alb;
        float s = fract(vInfo.x*91.0), s2 = fract(vInfo.x*37.3);
        float bare = 0.0;
        if (part > 0.5) alb = vec3(0.16, 0.12, 0.09);
        else if (kind > 0.5) {
          // evergreen conifers: dark green all year, a little paler new growth in spring
          alb = mix(vec3(0.045,0.09,0.055), vec3(0.075,0.115,0.065), s);
          alb = mix(alb, vec3(0.10,0.16,0.07), uSpring*0.3);
          alb *= 0.6 + 0.8*fbm2(vW.xz*1.3 + vW.y*0.9);
        } else {
          // each tree has its own timing: early and late leafers, early and late colour change
          float leaf = clamp(uLeafFrac + (s - 0.5)*0.35, 0.0, 1.0);
          float aut = clamp(uAutumn + (s2 - 0.5)*0.6, 0.0, 1.0);
          vec3 summer = mix(vec3(0.09,0.16,0.06), vec3(0.14,0.20,0.08), s);
          vec3 spring = vec3(0.20, 0.30, 0.09);
          vec3 fall = s2 < 0.25 ? vec3(0.42,0.07,0.04) : s2 < 0.5 ? vec3(0.50,0.20,0.04) : s2 < 0.8 ? vec3(0.50,0.38,0.06) : vec3(0.27,0.16,0.07);
          alb = mix(summer, spring, uSpring*(1.0 - leaf*0.5));
          alb = mix(alb, fall, smoothstep(0.0, 1.0, aut));
          alb *= 0.6 + 0.8*fbm2(vW.xz*1.3 + vW.y*0.9);
          // crowns thin out as leaves drop or before they open: the twig mass shows through
          float holes = fbm2(vW.xy*2.5 + vW.zy*1.9);
          if (holes > leaf*0.62 + 0.3) {
            if (holes < 0.53 + leaf*0.4) alb = vec3(0.17, 0.14, 0.12) * (0.8 + 0.4*holes); else discard;
            bare = 1.0;
          }
        }
        if (part < 0.5) alb = mix(alb, vec3(0.8,0.83,0.88), uSnow*smoothstep(0.1, 0.7, n.y)*(kind > 0.5 ? 0.8 : 0.35 + 0.3*bare));
        gl_FragColor = vec4(shade(alb, n, vW, 0.6), 1.0);
      }`,
  });
}

function plainLit(U, colorHex) {
  const c = new THREE.Color(colorHex);
  return new THREE.ShaderMaterial({
    uniforms: { ...U, uCol: { value: new THREE.Vector3(c.r, c.g, c.b) } },
    vertexShader: LIT_VS,
    fragmentShader: COMMON + lighting() + /* glsl */`
      in vec3 vW; in vec3 vN; in vec2 vUv; in vec4 vInfo; uniform vec3 uCol;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        vec3 alb = mix(uCol, vec3(0.8,0.83,0.88), uSnow*smoothstep(0.6, 0.9, n.y)*0.8);
        gl_FragColor = vec4(shade(alb, n, vW, 1.0), 1.0);
      }`,
  });
}

// Point lights seen as glare points. intensity in candela toward the viewer.
export function lightPoints(U, list, opts = {}) {
  const n = list.length, pos = new Float32Array(n * 3), cd = new Float32Array(n), col = new Float32Array(n * 3), blink = new Float32Array(n);
  list.forEach((L, i) => { pos.set([L.x, L.y, L.z], i * 3); cd[i] = L.cd; col.set(L.c, i * 3); blink[i] = L.blink || 0; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aCd', new THREE.BufferAttribute(cd, 1)); g.setAttribute('aC', new THREE.BufferAttribute(col, 3)); g.setAttribute('aBlink', new THREE.BufferAttribute(blink, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n' + COMMON + /* glsl */`
      attribute float aCd, aBlink; attribute vec3 aC; out vec3 vC; uniform float uPxSr, uPxScale;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec4 mv = viewMatrix * vec4(position, 1.0); float d = max(-mv.z, 1.0);
        float E = aCd / (d*d);
        float tr = exp(-d * 3.912 / max(uVisKm*1000.0, 300.0));
        float on = aBlink > 0.5 ? step(fract(uTime*0.5 + aBlink*0.0), 0.3) : 1.0;  // aviation: ~30 flashes/min, synchronised
        float night = aBlink > 0.5 ? max(uNight, 0.0) : uNight;
        float size = clamp(2.0 + 300.0/d, 2.0, 9.0) * uPxScale;
        vC = aC * E * tr / (uPxSr * size*size*0.6) * uExposure * night * on;
        gl_PointSize = size;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`in vec3 vC;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord*2.0-1.0; float r = dot(p,p); if (r > 1.0) discard; gl_FragColor = vec4(vC*exp(-r*4.0)*1.8, 1.0); }`,
  });
  const p = new THREE.Points(g, mat); p.frustumCulled = false; return p;
}

export function ringLocal(local, ring) {
  const pts = ring.map(([la, lo]) => { const [x, y] = local.toXY(la, lo); return [x, -y]; });
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 0.01) pts.pop();
  return pts;
}
export function area(p) { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i][0] * p[j][1] - p[j][0] * p[i][1]; } return a / 2; }
export function pointInPoly(x, z, p) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if (((p[i][1] > z) !== (p[j][1] > z)) && (x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c; } return c; }

export class Structures {
  constructor(U, local, ground, ctx) {
    this.U = U; this.local = local; this.ground = ground; this.ctx = ctx; this.group = new THREE.Group();
    this.anim = []; this.lamps = []; this.areas = [];
  }
  build(osm) {
    const t0 = performance.now();
    this.buildBuildings(osm.buildings);
    this.buildTrees(osm);
    this.buildRoads(osm.roads);
    this.buildLamps(osm);
    this.buildPower(osm.powerLines);
    this.buildTurbines(osm.turbines);
    this.buildTowers(osm.towers);
    this.buildAreas(osm);
    this.ground.setLights(this.lamps, this.areas);
    const pts = this.lamps.filter(l => l.glow !== false).map(l => ({ x: l.x, y: l.y, z: l.z, cd: l.cd, c: l.cc || [1, 0.75, 0.45], blink: l.blink }));
    this.glow = lightPoints(this.U, pts); this.group.add(this.glow);
    this.stats = { buildings: osm.buildings.length, trees: this.treeCount, lamps: this.lamps.length, ms: Math.round(performance.now() - t0) };
    return this;
  }
  h(x, z) { return this.ground.heightAt(x, z); }

  buildBuildings(list) {
    const pos = [], nor = [], uv = [], info = [];
    const push = (p, n, u, inf) => { pos.push(...p); nor.push(...n); uv.push(...u); info.push(...inf); };
    const quad = (a, b, y0, y1, u0, u1, inf) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, n = [dz / L, 0, -dx / L];
      const P = [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]];
      const UV = [[u0, 0], [u1, 0], [u1, y1 - y0], [u0, y1 - y0]];
      for (const k of [0, 1, 2, 0, 2, 3]) push(P[k], n, UV[k], inf);
    };
    const tri = (A, B, C, inf, uvs) => {
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map(v => v / l);
      if (n[1] < -0.01) { n = n.map(v => -v); [B, C] = [C, B]; }
      push(A, n, uvs ? uvs[0] : [A[0], A[2]], inf); push(B, n, uvs ? uvs[1] : [B[0], B[2]], inf); push(C, n, uvs ? uvs[2] : [C[0], C[2]], inf);
    };
    let id = 0;
    for (const b of list) {
      let p = ringLocal(this.local, b.ring); if (p.length < 3) continue;
      const A = area(p); if (A < 0) p.reverse(); const a = Math.abs(A); if (a < 6) continue;
      // pull each footprint in by 15 cm so walls shared by attached buildings don't flicker
      { let cx = 0, cz = 0; p.forEach(q => { cx += q[0]; cz += q[1]; }); cx /= p.length; cz /= p.length; p = p.map(([x, z]) => { const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1; return [x - dx / l * 0.15, z - dz / l * 0.15]; }); }
      id++; const seed = hash(id * 7919);
      const t = b.type;
      const kind = /^(industrial|warehouse|factory|manufacture|hangar|barn|farm_auxiliary|storage_tank|silo)$/.test(t) ? 2 : /^(commercial|retail|office|school|hospital|church|university|public|civic|hotel|supermarket|apartments|government)$/.test(t) ? 1 : 0;
      const small = /^(garage|garages|shed|carport|hut|cabin|kiosk)$/.test(t);
      let levels = b.levels || (small ? 1 : kind === 2 ? 2 : kind === 1 ? (t === 'apartments' ? 4 : a > 1500 ? 2 : 1) : (a < 60 ? 1 : 2));
      let eave = b.h ? b.h * (kind === 0 && !b.roofShape ? 0.78 : 1) : levels * (kind === 1 ? 3.6 : kind === 2 ? 4.5 : 2.9) + 0.3;
      const ys = p.map(([x, z]) => this.h(x, z)); const base = Math.min(...ys) - 0.5, top = Math.max(...ys) + eave;
      const floors = Math.max(1, Math.round(eave / (kind ? 3.6 : 2.8)));
      const inf = [seed, kind, 0, floors];
      // walls
      let u = 0;
      for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length], L = Math.hypot(q[0] - p[i][0], q[1] - p[i][1]); quad(p[i], q, base, top, u, u + L, inf); u += L; }
      // roof
      const rinf = [seed, kind, 1, floors];
      const pitched = (b.roofShape && b.roofShape !== 'flat') || (kind === 0 && a < 450 && !b.roofShape);
      const ridgeH = Math.min(5, Math.sqrt(a) * 0.28 + 1);
      if (pitched && p.length === 4) {
        // gable along the long axis
        const d01 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), d12 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
        const s = d01 >= d12 ? 0 : 1;
        const P = i => p[(i + s) % 4];
        const m1 = [(P(1)[0] + P(2)[0]) / 2, (P(1)[1] + P(2)[1]) / 2], m2 = [(P(3)[0] + P(0)[0]) / 2, (P(3)[1] + P(0)[1]) / 2];
        const R1 = [m1[0], top + ridgeH, m1[1]], R2 = [m2[0], top + ridgeH, m2[1]], V = i => [P(i)[0], top, P(i)[1]];
        const hip = b.roofShape === 'hipped' || hash(id * 3) < 0.25;
        if (hip) { const k = 0.22; const r1 = [R1[0] + (R2[0] - R1[0]) * k, R1[1], R1[2] + (R2[2] - R1[2]) * k], r2 = [R2[0] + (R1[0] - R2[0]) * k, R2[1], R2[2] + (R1[2] - R2[2]) * k]; tri(V(0), V(1), r1, rinf); tri(V(0), r1, r2, rinf); tri(V(2), V(3), r2, rinf); tri(V(2), r2, r1, rinf); tri(V(1), V(2), r1, rinf); tri(V(3), V(0), r2, rinf); }
        else {
          tri(V(0), V(1), R1, rinf); tri(V(0), R1, R2, rinf); tri(V(2), V(3), R2, rinf); tri(V(2), R2, R1, rinf);
          // gable ends are wall
          const ginf = inf; const g1 = [V(1), V(2), R1], g2 = [V(3), V(0), R2];
          for (const G of [g1, g2]) { const e = [G[1][0] - G[0][0], G[1][2] - G[0][2]], L = Math.hypot(...e) || 1; const n = [e[1] / L, 0, -e[0] / L]; push(G[0], n, [0, eave], ginf); push(G[1], n, [L, eave], ginf); push(G[2], n, [L / 2, eave + ridgeH], ginf); }
        }
      } else if (pitched && p.length <= 12) {
        let cx = 0, cz = 0; p.forEach(q => { cx += q[0]; cz += q[1]; }); cx /= p.length; cz /= p.length;
        const apex = [cx, top + ridgeH * 0.8, cz];
        for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; tri([p[i][0], top, p[i][1]], [q[0], top, q[1]], apex, rinf); }
      } else {
        const tris = THREE.ShapeUtils.triangulateShape(p.map(q => new THREE.Vector2(q[0], q[1])), []);
        for (const [i, j, k] of tris) tri([p[i][0], top, p[i][1]], [p[j][0], top, p[j][1]], [p[k][0], top, p[k][1]], rinf);
      }
      // porch light on houses
      if (kind === 0 && !small && hash(id * 11) < 0.5) {
        let best = 0, bi = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length], L = Math.hypot(q[0] - p[i][0], q[1] - p[i][1]); if (L > best) { best = L; bi = i; } }
        const q = p[(bi + 1) % p.length], dx = q[0] - p[bi][0], dz = q[1] - p[bi][1], L = Math.hypot(dx, dz);
        const mx = (p[bi][0] + q[0]) / 2 + dz / L * 0.4, mz = (p[bi][1] + q[1]) / 2 - dx / L * 0.4;
        this.lamps.push({ x: mx, z: mz, y: this.h(mx, mz) + 2.2, cd: 60, r: 7, i: 0.25, c: [255, 190, 120], cc: [1, 0.72, 0.45] });
      }
      if (kind === 2 && hash(id * 5) < 0.6) { // wall packs on industrial buildings
        for (let i = 0; i < p.length; i += 2) { const q = p[(i + 1) % p.length], mx = (p[i][0] + q[0]) / 2, mz = (p[i][1] + q[1]) / 2; this.lamps.push({ x: mx, z: mz, y: base + 5, cd: 1500, r: 25, i: 0.6, c: [255, 170, 90], cc: [1, 0.62, 0.3] }); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
    const m = new THREE.Mesh(g, buildingMaterial(this.U)); m.frustumCulled = false; this.group.add(m);
    this.buildingPolys = list.map(b => ringLocal(this.local, b.ring));
  }

  buildTrees(osm) {
    const trees = [], half = this.ctx.detail * 1.6;
    const ok = (x, z) => Math.abs(x) < half && Math.abs(z) < half;
    for (const t of osm.trees) { const [x, y] = this.local.toXY(t.p[0], t.p[1]); const z = -y; if (ok(x, z)) trees.push({ x, z, h: t.h, kind: t.leaf === 'needleleaved' ? 1 : t.leaf === 'broadleaved' ? 0 : -1 }); }
    for (const t of this.ctx.extraTrees || []) trees.push(t);
    // fill mapped forests
    const max = this.ctx.mobile ? 9000 : 26000;
    let seed = 1;
    for (const f of osm.forests) {
      const p = ringLocal(this.local, f.ring); if (p.length < 3) continue;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; p.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
      x0 = Math.max(x0, -half); x1 = Math.min(x1, half); z0 = Math.max(z0, -half); z1 = Math.min(z1, half);
      if (x1 <= x0 || z1 <= z0) continue;
      const sp = 7.5;
      for (let x = x0; x < x1; x += sp) for (let z = z0; z < z1; z += sp) {
        if (trees.length > max) break;
        const jx = x + (hash(seed++) - 0.5) * sp, jz = z + (hash(seed++) - 0.5) * sp;
        if (!pointInPoly(jx, jz, p)) continue;
        trees.push({ x: jx, z: jz, kind: f.leaf === 'needleleaved' ? 1 : f.leaf === 'broadleaved' ? 0 : -1 });
      }
    }
    // estimated trees from aerial imagery (unmapped yard and street trees), near the viewer
    if (this.ctx.imageryTrees && this.ground.nearPx) {
      const r = Math.min(half, 1200), sp = 6;
      for (let x = -r; x < r; x += sp) for (let z = -r; z < r; z += sp) {
        if (trees.length > max) break;
        const jx = x + (hash(seed++) - 0.5) * sp, jz = z + (hash(seed++) - 0.5) * sp;
        const [R, G, B] = this.ground.imageryAt(jx, jz);
        const lum = 0.3 * R + 0.59 * G + 0.11 * B, green = G - Math.max(R, B);
        const treeLike = (lum < 70 && green > 2) || (lum < 55 && Math.abs(R - G) < 12 && B < G); // canopy or bare canopy shadow
        if (!treeLike || hash(seed++) > 0.45) continue;
        if (this.buildingPolys && this.buildingPolys.some(bp => bp.length > 2 && Math.abs(bp[0][0] - jx) < 40 && Math.abs(bp[0][1] - jz) < 40 && pointInPoly(jx, jz, bp))) continue;
        trees.push({ x: jx, z: jz, kind: -1, est: true });
      }
    }
    this.treeCount = trees.length; this.treePts = trees;
    const conRatio = this.ctx.coniferShare;
    const con = [], dec = [];
    trees.forEach((t, i) => { const k = t.kind >= 0 ? t.kind : (hash(i * 31 + 7) < conRatio ? 1 : 0); (k ? con : dec).push(t); });
    const mk = (list, crown, trunk, kind) => {
      if (!list.length) return;
      const mat = vegMaterial(this.U);
      const add = (geo, part) => {
        geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 4).map((_, j) => j % 4 === 1 ? kind : j % 4 === 2 ? part : 0), 4));
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
        list.forEach((t, i) => {
          const H = t.h || (kind ? 14 : 12) * (0.65 + hash(i * 3 + kind) * 0.7);
          q.setFromAxisAngle(up, hash(i * 5) * 6.28);
          s.set(H * (0.9 + hash(i * 9) * 0.25), H, H * (0.9 + hash(i * 13) * 0.25));
          p.set(t.x, this.h(t.x, t.z) - 0.3, t.z);
          M.compose(p, q, s); im.setMatrixAt(i, M);
        });
        im.frustumCulled = false; this.group.add(im);
      };
      add(crown, 0); add(trunk, 1);
    };
    // unit-height geometries
    const trunk = new THREE.CylinderGeometry(0.018, 0.028, 0.45, 5).translate(0, 0.225, 0);
    const decCrown = new THREE.IcosahedronGeometry(0.36, 3); { const p = decCrown.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const k = 1 + 0.18 * Math.sin(x * 17 + y * 11) * Math.cos(z * 13); p.setXYZ(i, x * k, y * k * 0.85 + 0.62, z * k); } decCrown.computeVertexNormals(); }
    const conCrown = (() => { const parts = [0, 1, 2].map(k => new THREE.ConeGeometry(0.22 - k * 0.05, 0.42, 7).translate(0, 0.35 + k * 0.22, 0)); return mergeGeos(parts); })();
    mk(dec, decCrown, trunk, 0); mk(con, conCrown, trunk.clone(), 1);
  }

  buildRoads(roads) {
    const W = { motorway: 15, trunk: 13, primary: 10, secondary: 9, tertiary: 8, unclassified: 6, residential: 6.5, living_street: 5, service: 4, motorway_link: 6, trunk_link: 6, primary_link: 6 };
    const half = this.ctx.detail * 2.4;
    const pos = [], nor = [], uv = [], info = [];
    this.carPaths = [];
    for (const r of roads) {
      const pts = ringLocalLine(this.local, r.line);
      if (!pts.some(([x, z]) => Math.abs(x) < half && Math.abs(z) < half)) continue;
      const w = (W[r.kind] || 6) / 2;
      // densify to follow terrain
      const d = []; for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 12)); for (let k = 0; k < n; k++) d.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); } d.push(pts.at(-1));
      let u = 0;
      for (let i = 0; i < d.length - 1; i++) {
        const a = d[i], b = d[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L * w, nz = dx / L * w;
        const ya = this.h(a[0], a[1]) + 0.25, yb = this.h(b[0], b[1]) + 0.25;
        const P = [[a[0] + nx, ya, a[1] + nz], [a[0] - nx, ya, a[1] - nz], [b[0] - nx, yb, b[1] - nz], [b[0] + nx, yb, b[1] + nz]];
        const UV = [[u, 1], [u, -1], [u + L, -1], [u + L, 1]];
        for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...P[k]); nor.push(0, 1, 0); uv.push(...UV[k]); info.push(0, W[r.kind] || 6, /motorway|trunk|primary|secondary/.test(r.kind) ? 1 : 0, 0); }
        u += L;
      }
      if (/motorway|trunk|primary|secondary|tertiary/.test(r.kind)) this.carPaths.push({ pts: d, kind: r.kind, len: u });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.U, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      vertexShader: LIT_VS,
      fragmentShader: COMMON + lighting() + /* glsl */`
        in vec3 vW; in vec3 vN; in vec2 vUv; in vec4 vInfo;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          vec3 alb = vec3(0.075) * (0.85 + 0.3*fbm2(vW.xz*0.8));
          float edge = smoothstep(0.88, 0.92, abs(vUv.y)) * step(abs(vUv.y), 0.96);
          float centre = vInfo.z > 0.5 ? step(abs(vUv.y), 0.025) * step(0.5, fract(vUv.x/9.0)) : 0.0;
          alb = mix(alb, vec3(0.55, 0.5, 0.3), centre); alb = mix(alb, vec3(0.6), edge*0.6);
          alb = mix(alb, vec3(0.75, 0.77, 0.8), uSnow*0.35*(0.5 + 0.5*fbm2(vW.xz*0.3)));
          alb *= mix(1.0, 0.6, uWet);
          vec3 col = shade(alb, vec3(0.0,1.0,0.0), vW, 1.0);
          vec3 V = normalize(vW - cameraPosition);
          col += uWet * 0.12 * hazeL(reflect(V, vec3(0.0,1.0,0.0))) * pow(1.0 - abs(V.y), 4.0);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; this.group.add(m);
    this.roadsMesh = m;
    this.buildCars();
  }
  // Moving head/tail lights on major roads, density from typical traffic for the hour.
  buildCars() {
    const cars = [];
    const dens = { motorway: 1 / 45, trunk: 1 / 70, primary: 1 / 110, secondary: 1 / 180, tertiary: 1 / 300 };
    let s = 1;
    for (const p of this.carPaths) { const n = Math.min(400, Math.floor(p.len * (dens[p.kind] || 1 / 300))); for (let i = 0; i < n; i++) cars.push({ path: p, s0: hash(s++) * p.len, dir: hash(s++) < 0.5 ? 1 : -1, v: (p.kind === 'motorway' ? 30 : p.kind === 'trunk' ? 25 : 17) * (0.85 + hash(s++) * 0.3) }); }
    this.cars = cars.slice(0, this.ctx.mobile ? 800 : 2500);
    const n = this.cars.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.U, uTraffic: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: '#include <common>\n' + COMMON + /* glsl */`
        attribute vec3 aDir; out vec3 vC; uniform float uPxSr, uPxScale, uTraffic;
        #include <logdepthbuf_pars_vertex>
        void main(){
          vec4 mv = viewMatrix * vec4(position, 1.0); float d = max(-mv.z, 1.0);
          vec3 toCam = normalize(cameraPosition - position);
          float facing = dot(aDir, toCam);
          // headlights are bright toward the viewer, tail lights dim red
          vec3 c = facing > 0.0 ? vec3(1.0, 0.95, 0.85) * (300.0 + 4000.0*pow(facing, 8.0)) : vec3(1.0, 0.08, 0.04) * 40.0;
          float tr = exp(-d * 3.912 / max(uVisKm*1000.0, 300.0));
          float size = clamp(1.5 + 120.0/d, 1.5, 6.0) * uPxScale;
          vC = c / (d*d) * tr / (uPxSr*size*size*0.6) * uExposure * max(uNight, 0.15);
          gl_PointSize = size; gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          if (fract(position.x*0.37 + position.z*0.11) > uTraffic) gl_Position = vec4(2.0,2.0,2.0,1.0);
        }`,
      fragmentShader: /* glsl */`in vec3 vC;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          vec2 p = gl_PointCoord*2.0-1.0; float r = dot(p,p); if (r > 1.0) discard; gl_FragColor = vec4(vC*exp(-r*4.0)*1.8, 1.0); }`,
    });
    this.carPts = new THREE.Points(g, mat); this.carPts.frustumCulled = false; this.group.add(this.carPts);
    this.anim.push(t => this.updateCars(t));
  }
  updateCars(t) {
    if (!this.cars || !this.cars.length) return;
    const P = this.carPts.geometry.attributes.position.array, D = this.carPts.geometry.attributes.aDir.array;
    this.cars.forEach((c, i) => {
      const p = c.path, L = p.len; let s = ((c.s0 + c.dir * c.v * t) % L + L) % L;
      // walk the polyline (cached segment lengths)
      if (!p.cum) { p.cum = [0]; for (let k = 1; k < p.pts.length; k++) p.cum.push(p.cum[k - 1] + Math.hypot(p.pts[k][0] - p.pts[k - 1][0], p.pts[k][1] - p.pts[k - 1][1])); }
      let lo = 0, hi = p.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m] <= s) lo = m; else hi = m; }
      const a = p.pts[lo], b = p.pts[hi], f = (s - p.cum[lo]) / ((p.cum[hi] - p.cum[lo]) || 1);
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, side = c.dir * 2.2;
      const x = a[0] + dx * f - dz / l * side, z = a[1] + dz * f + dx / l * side;
      if (c.y == null || i % 7 === (this.frame | 0) % 7) c.y = this.h(x, z) + 0.8;
      P[i * 3] = x; P[i * 3 + 1] = c.y; P[i * 3 + 2] = z; D[i * 3] = dx / l * c.dir; D[i * 3 + 1] = 0; D[i * 3 + 2] = dz / l * c.dir;
    });
    this.frame = (this.frame || 0) + 1;
    this.carPts.geometry.attributes.position.needsUpdate = true; this.carPts.geometry.attributes.aDir.needsUpdate = true;
  }
  setTraffic(f) { if (this.carPts) this.carPts.material.uniforms.uTraffic.value = clamp(f, 0.05, 1); }

  buildLamps(osm) {
    const poles = [];
    const LED = [235, 235, 255], HPS = [255, 170, 80];
    const addLamp = (x, z, mapped) => {
      const led = hash(Math.round(x * 3.1 + z * 7.7)) < this.ctx.ledShare;
      const y = this.h(x, z);
      this.lamps.push({ x, z, y: y + 8.5, cd: led ? 2200 : 1800, r: 24, i: led ? 0.65 : 0.75, c: led ? LED : HPS, cc: led ? [0.95, 0.95, 1] : [1, 0.62, 0.28], mapped });
      poles.push([x, y, z]);
    };
    for (const l of osm.lamps) { const [x, y] = this.local.toXY(l.p[0], l.p[1]); addLamp(x, -y, true); }
    // estimated lamps along urban or lit roads where none are mapped
    if (this.ctx.estimateLamps) {
      const half = this.ctx.detail * 2.4;
      const mappedNear = osm.lamps.length;
      for (const r of osm.roads) {
        if (!/primary|secondary|tertiary|residential|trunk|unclassified|living_street/.test(r.kind)) continue;
        const pts = ringLocalLine(this.local, r.line);
        const urban = this.ctx.urbanAt(pts[0][0], pts[0][1]);
        if (!r.lit && urban < 0.35) continue;
        if (mappedNear > 50 && !r.lit) continue;
        const sp = r.kind === 'residential' ? 45 : 38, off = r.kind === 'residential' ? 4.5 : 7;
        let acc = hash(pts.length) * sp, side = 1;
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!L) continue;
          for (let s = acc; s < L; s += sp) {
            const x = a[0] + (b[0] - a[0]) * s / L - (b[1] - a[1]) / L * off * side, z = a[1] + (b[1] - a[1]) * s / L + (b[0] - a[0]) / L * off * side;
            if (Math.abs(x) < half && Math.abs(z) < half) addLamp(x, z, false);
            side = r.kind === 'residential' ? -side : side;
          }
          acc = ((acc - L) % sp + sp) % sp;
        }
      }
    }
    if (poles.length) {
      const pole = mergeGeos([new THREE.CylinderGeometry(0.08, 0.12, 8.6, 5).translate(0, 4.3, 0), new THREE.BoxGeometry(1.6, 0.15, 0.3).translate(0.75, 8.5, 0)]);
      pole.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(pole.attributes.position.count * 4), 4));
      const im = new THREE.InstancedMesh(pole, plainLit(this.U, 0x555555), poles.length);
      const M = new THREE.Matrix4(); poles.forEach((p, i) => { M.makeRotationY(hash(i) * 6.28); M.setPosition(p[0], p[1], p[2]); im.setMatrixAt(i, M); });
      im.frustumCulled = false; this.group.add(im);
    }
  }

  buildPower(lines) {
    const towers = [], poles = [], wire = [];
    const range = this.ctx.mobile ? 6000 : 9000;
    for (const L of lines) {
      const p = ringLocalLine(this.local, L.line);
      if (!p.some(([x, z]) => Math.abs(x) < range && Math.abs(z) < range)) continue;
      const major = !L.minor && (L.voltage == null || L.voltage >= 60000);
      const H = major ? (L.voltage >= 300000 ? 45 : 32) : 11;
      const arms = major ? [[-7, H - 4], [0, H - 1.5], [7, H - 4]] : [[-1, H - 0.4], [0, H], [1, H - 0.4]];
      const tops = p.map((q, i) => {
        const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
        const inR = Math.abs(q[0]) < range && Math.abs(q[1]) < range; const y = inR ? this.h(q[0], q[1]) : 0; if (inR) (major ? towers : poles).push([q[0], y, q[1], Math.atan2(dx, dz)]);
        if (!inR) return null;
        return { x: q[0], y, z: q[1], nx: -dz / l, nz: dx / l };
      });
      for (let i = 0; i < tops.length - 1; i++) {
        const A = tops[i], B = tops[i + 1]; if (!A || !B) continue; const span = Math.hypot(B.x - A.x, B.z - A.z); if (span > 1200) continue;
        for (const [o, hh] of arms) {
          const ax = A.x + A.nx * o, az = A.z + A.nz * o, ay = A.y + hh, bx = B.x + B.nx * o, bz = B.z + B.nz * o, by = B.y + hh;
          const sag = span * (major ? 0.03 : 0.02), N = 10;
          let prev = [ax, ay, az];
          for (let k = 1; k <= N; k++) { const f = k / N; const cur = [ax + (bx - ax) * f, ay + (by - ay) * f - 4 * sag * f * (1 - f), az + (bz - az) * f]; wire.push(...prev, ...cur); prev = cur; }
        }
      }
    }
    if (wire.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
      const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.85 }));
      ls.frustumCulled = false; this.group.add(ls); this.wires = ls;
    }
    const place = (list, geo, color) => {
      if (!list.length) return;
      geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
      const im = new THREE.InstancedMesh(geo, plainLit(this.U, color), list.length), M = new THREE.Matrix4();
      list.forEach((t, i) => { M.makeRotationY(t[3] + Math.PI / 2); M.setPosition(t[0], t[1], t[2]); im.setMatrixAt(i, M); });
      im.frustumCulled = false; this.group.add(im);
    };
    place(towers, latticeTower(), 0x6b6f72);
    place(poles, mergeGeos([new THREE.CylinderGeometry(0.13, 0.17, 11.5, 6).translate(0, 5.75, 0), new THREE.BoxGeometry(2.6, 0.12, 0.12).translate(0, 10.8, 0)]), 0x4a3a2c);
    this.powerStats = { towers: towers.length, poles: poles.length };
  }

  buildTurbines(list) {
    if (!list.length) return;
    const wd = (this.ctx.windDir || 270) * Math.PI / 180, ws = this.ctx.windSpeed || 6;
    const tow = [], rot = [];
    for (const t of list) {
      const [x, y] = this.local.toXY(t.p[0], t.p[1]), z = -y;
      if (Math.hypot(x, z) > 30000) continue;
      const g = this.h(x, z); tow.push({ x, g, z, h: t.h, D: t.rotor });
      this.lamps.push({ x, z, y: g + t.h + 3, cd: 2000, r: 1, i: 0, c: [0, 0, 0], cc: [1, 0.05, 0.02], blink: 1 });
    }
    const towerGeo = mergeGeos([new THREE.CylinderGeometry(0.018, 0.035, 1, 10).translate(0, 0.5, 0), new THREE.BoxGeometry(0.05, 0.035, 0.11).translate(0, 1.0, 0.02)]);
    towerGeo.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(towerGeo.attributes.position.count * 4), 4));
    const im = new THREE.InstancedMesh(towerGeo, plainLit(this.U, 0xd8dadc), tow.length), M = new THREE.Matrix4(), S = new THREE.Matrix4();
    tow.forEach((t, i) => { M.makeRotationY(-wd); S.makeScale(t.h, t.h, t.h); M.multiply(S); M.setPosition(t.x, t.g, t.z); im.setMatrixAt(i, M); });
    im.frustumCulled = false; this.group.add(im);
    // rotors: three blades, unit radius
    const blade = new THREE.BoxGeometry(0.06, 1, 0.01).translate(0, 0.5, 0);
    const rotor = mergeGeos([0, 1, 2].map(k => blade.clone().rotateZ(k * 2 * Math.PI / 3)));
    rotor.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(rotor.attributes.position.count * 4), 4));
    const rm = new THREE.InstancedMesh(rotor, plainLit(this.U, 0xe4e6e8), tow.length); rm.frustumCulled = false; this.group.add(rm);
    const rpm = ws < 3 ? 0 : Math.min(15, 4 + ws * 1.2);
    const Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), Sc = new THREE.Vector3();
    this.anim.push(time => {
      tow.forEach((t, i) => {
        E.set(0, -wd, hash(i) * 6.28 + time * rpm / 60 * 2 * Math.PI, 'YXZ'); Q.setFromEuler(E);
        P.set(t.x + Math.sin(-wd) * 0.07 * t.h * 0, t.g + t.h, t.z); const r = t.D / 2; Sc.set(r, r, r);
        M.compose(P, Q, Sc); rm.setMatrixAt(i, M);
      });
      rm.instanceMatrix.needsUpdate = true;
    });
  }

  buildTowers(list) {
    const geoms = { mast: latticeMast(), communications_tower: latticeMast(), tower: latticeMast(), chimney: new THREE.CylinderGeometry(0.035, 0.06, 1, 12).translate(0, 0.5, 0), water_tower: mergeGeos([new THREE.CylinderGeometry(0.03, 0.05, 0.7, 8).translate(0, 0.35, 0), new THREE.SphereGeometry(0.2, 14, 10).scale(1, 0.75, 1).translate(0, 0.82, 0)]), silo: new THREE.CylinderGeometry(0.18, 0.18, 1, 14).translate(0, 0.5, 0), storage_tank: new THREE.CylinderGeometry(0.9, 0.9, 1, 20).translate(0, 0.5, 0), flare: new THREE.CylinderGeometry(0.02, 0.02, 1, 6).translate(0, 0.5, 0) };
    const by = {};
    for (const t of list) {
      const [x, y] = this.local.toXY(t.p[0], t.p[1]), z = -y; if (Math.hypot(x, z) > 25000) continue;
      const g = this.h(x, z); (by[t.kind] = by[t.kind] || []).push({ x, z, g, h: t.h });
      if (t.h > 45 && /mast|tower|chimney/.test(t.kind)) {
        const flashing = t.h > 150; // tall masts: flashing red; others steady
        for (let f = 1; f <= Math.max(1, Math.floor(t.h / 60)); f++) this.lamps.push({ x, z, y: g + t.h * f / Math.max(1, Math.floor(t.h / 60)), cd: f === Math.floor(t.h / 60) ? 2000 : 300, r: 1, i: 0, c: [0, 0, 0], cc: [1, 0.05, 0.02], blink: flashing ? 1 : 0 });
      }
      if (t.kind === 'flare') this.lamps.push({ x, z, y: g + t.h + 3, cd: 50000, r: 120, i: 0.6, c: [255, 150, 60], cc: [1, 0.55, 0.2] });
    }
    for (const [k, arr] of Object.entries(by)) {
      const geo = (geoms[k] || geoms.tower).clone();
      geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
      const im = new THREE.InstancedMesh(geo, plainLit(this.U, k === 'chimney' ? 0x8a6a5a : k === 'water_tower' ? 0xb8bcc0 : 0x9a9a9a), arr.length), M = new THREE.Matrix4(), S = new THREE.Matrix4();
      arr.forEach((t, i) => { M.makeScale(t.h, t.h, t.h); M.setPosition(t.x, t.g, t.z); im.setMatrixAt(i, M); });
      im.frustumCulled = false; this.group.add(im);
    }
  }

  // Lit areas: industrial yards, power plants, sports fields, parking lots, petrol stations.
  buildAreas(osm) {
    const half = this.ctx.detail * 2.4;
    const addArea = (ring, lux, c, lampEvery, lampCd, lampC) => {
      const p = ringLocal(this.local, ring); if (p.length < 3 || !p.some(([x, z]) => Math.abs(x) < half * 2 && Math.abs(z) < half * 2)) return;
      this.areas.push({ ring: p, c: c.map(v => Math.min(255, v * lux / 40)) });
      if (lampEvery) {
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; p.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
        let n = 0;
        for (let x = x0; x < x1 && n < 60; x += lampEvery) for (let z = z0; z < z1 && n < 60; z += lampEvery) if (pointInPoly(x, z, p)) { this.lamps.push({ x, z, y: this.h(x, z) + 12, cd: lampCd, r: 1, i: 0, c: [0, 0, 0], cc: lampC }); n++; }
      }
    };
    for (const a of osm.industrial) addArea(a.ring, a.plant ? 18 : 6, [255, 170, 90], a.plant ? 60 : 110, a.plant ? 9000 : 4000, [1, 0.62, 0.3]);
    for (const a of osm.lit) addArea(a.ring, 25, [240, 240, 255], 70, 30000, [0.95, 0.95, 1]);
    for (const a of osm.parking) addArea(a.ring, 8, [235, 235, 255], 35, 2500, [0.95, 0.95, 1]);
    for (const f of osm.fuel) if (f.ring) addArea(f.ring, 120, [245, 245, 255], 0, 0); else { const [x, y] = this.local.toXY(f.p[0], f.p[1]); this.lamps.push({ x, z: -y, y: this.h(x, -y) + 5, cd: 15000, r: 30, i: 1, c: [245, 245, 255], cc: [0.95, 0.95, 1] }); }
  }
  update(time, frameInfo) { for (const f of this.anim) f(time); }
  dispose() { this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); }); }
}

function ringLocalLine(local, line) { return line.map(([la, lo]) => { const [x, y] = local.toXY(la, lo); return [x, -y]; }); }

export function mergeGeos(list) {
  const pos = [], nor = [], uv = [];
  for (let g of list) {
    g = g.index ? g.toNonIndexed() : g;
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    if (g.attributes.uv) uv.push(...g.attributes.uv.array); else uv.push(...new Array(g.attributes.position.count * 2).fill(0));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}
function latticeTower() {
  const parts = [];
  // four tapered legs, cross arms, and bracing
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const leg = new THREE.CylinderGeometry(0.12, 0.2, 30, 4); leg.rotateZ(sx * 0.045); leg.rotateX(-sz * 0.045); leg.translate(sx * 0.95, 15, sz * 0.95); parts.push(leg); }
  parts.push(new THREE.BoxGeometry(15, 0.4, 0.6).translate(0, 28, 0), new THREE.BoxGeometry(9, 0.35, 0.5).translate(0, 31.5, 0));
  for (let y = 4; y < 27; y += 5) parts.push(new THREE.BoxGeometry(2.6 - y * 0.05, 0.12, 0.12).translate(0, y, 0.9 - y * 0.02), new THREE.BoxGeometry(0.12, 0.12, 2.6 - y * 0.05).translate(0.9 - y * 0.02, y, 0));
  parts.push(new THREE.ConeGeometry(1.0, 4, 4).translate(0, 33.5, 0));
  return mergeGeos(parts);
}
function latticeMast() {
  const parts = [new THREE.CylinderGeometry(0.004, 0.009, 1, 3).translate(0, 0.5, 0)];
  for (let y = 0.1; y < 1; y += 0.12) parts.push(new THREE.BoxGeometry(0.014, 0.002, 0.014).translate(0, y, 0));
  return mergeGeos(parts);
}
