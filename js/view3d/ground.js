// Terrain from real elevation in three nested rings out to the horizon (with Earth curvature), aerial imagery,
// snow cover, wet ground, light pools from mapped lamps, procedural grass, and distant city lights from VIIRS.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';
import { heightField, imageryCanvas } from '../terrain.js';
import { curveDrop, hash } from '../util.js';

export function terrainMaterial(U, albedo, opts = {}) {
  const uni = { ...U, uAlb: { value: albedo }, uHasAlb: { value: albedo ? 1 : 0 }, uLightMap: U.uLightMap, uLightHalf: U.uLightHalf, uUseLM: { value: opts.lightmap ? 1 : 0 }, uBase: { value: new THREE.Color(opts.base || 0x4d5a3c) } };
  return new THREE.ShaderMaterial({
    uniforms: uni,
    vertexShader: '#include <common>\n' + /* glsl */`
      out vec2 vUv; out vec3 vN; out vec3 vW;
      #include <logdepthbuf_pars_vertex>
      void main(){ vUv = uv; vN = normal; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: COMMON + /* glsl */`
      in vec2 vUv; in vec3 vN; in vec3 vW;
      uniform sampler2D uAlb, uLightMap; uniform float uHasAlb, uUseLM, uLightHalf; uniform vec3 uBase;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        vec3 alb = uHasAlb > 0.5 ? texture(uAlb, vUv).rgb : uBase;
        alb = pow(alb, vec3(2.2)) * 0.8;         // imagery is sRGB and a little bright for reflectance
        float lum = dot(alb, vec3(0.3, 0.59, 0.11));
        float green = clamp((alb.g - max(alb.r, alb.b))*8.0 + 0.3, 0.0, 1.0);
        float forest = smoothstep(0.05, 0.02, lum) * green;
        float water = smoothstep(0.0, 0.02, alb.b - alb.g*0.95) * smoothstep(0.08, 0.02, lum);
        // fine procedural variation so close ground is not a blurry photo
        float nz = fbm2(vW.xz*0.35) * 0.35 + fbm2(vW.xz*3.0)*0.15;
        alb *= 0.8 + nz;
        // snow: slopes and forests show less of it
        float slope = 1.0 - n.y;
        float snow = uSnow * (1.0 - 0.75*forest) * smoothstep(0.65, 0.35, slope) * (1.0 - water*0.8);
        snow *= smoothstep(0.2, 0.6, fbm2(vW.xz*0.02) + uSnow*0.6);
        alb = mix(alb, vec3(0.82, 0.85, 0.9), clamp(snow, 0.0, 1.0));
        alb *= mix(1.0, 0.55, uWet * (1.0 - snow));
        // light: Sun, Moon, sky, artificial
        vec3 E = uSunE * directT(uSunDir.y) * max(dot(n, uSunDir), 0.0) * smoothstep(-0.01, 0.02, uSunDir.y)
               + uMoonE * directT(uMoonDir.y) * max(dot(n, uMoonDir), 0.0) * smoothstep(-0.01, 0.02, uMoonDir.y);
        vec3 sky = mix(skyL(vec3(0.6, 0.15, 0.0))*0.5 + skyL(vec3(-0.6, 0.15, 0.0))*0.5, skyL(vec3(0.0, 1.0, 0.0)), 0.5 + 0.5*n.y) * PI;
        vec3 col = alb/PI * (E*uExposure*(1.0 - 0.9*uOvercast) + sky*0.85*(1.0 - 0.65*uOvercast));
        if (uUseLM > 0.5){
          vec2 luv = vW.xz/(2.0*uLightHalf) + 0.5;
          if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) col += alb/PI * texture(uLightMap, luv).rgb * 40.0 * uExposure * uNight;
        }
        // specular sheen on wet ground / water from the sky
        col += (uWet*0.08 + water*0.25) * hazeL(reflect(normalize(vW - cameraPosition), n)) * pow(1.0 - max(dot(-normalize(vW - cameraPosition), n), 0.0), 3.0);
        col += vec3(0.85,0.88,1.0)*uFlash.w*0.02*alb * exp(-length(vW - uFlash.xyz)/8000.0);
        col = aerial(col, normalize(vW - cameraPosition), length(vW - cameraPosition));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function gridMesh(N, half, hfn, holeHalf, drop, local) {
  const pos = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) * 2 - 1) * half, z = (j / (N - 1) * 2 - 1) * half;
    let y = hfn(x, z) - curveDrop(Math.hypot(x, z));
    if (holeHalf && Math.abs(x) < holeHalf && Math.abs(z) < holeHalf) y -= drop;
    const k = j * N + i; pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    uv[k * 2] = (x + half) / (2 * half); uv[k * 2 + 1] = (half - z) / (2 * half);
  }
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b = a + 1, c = a + N, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

export class Ground {
  constructor(U, local, groundZ, quality) {
    this.U = U; this.local = local; this.groundZ = groundZ; this.q = quality; this.group = new THREE.Group();
    this.nearHalf = 4000; this.midHalf = 40000; this.farHalf = 180000;
    U.uLightMap = { value: null }; U.uLightHalf = { value: this.nearHalf };
  }
  async build(progress) {
    const { local } = this, [lat, lon] = [local.lat0, local.lon0];
    progress('Loading elevation…');
    const [hn, hm, hf] = await Promise.all([heightField(lat, lon, this.nearHalf * 1.5, 13), heightField(lat, lon, this.midHalf * 1.45, 10), heightField(lat, lon, this.farHalf * 1.45, 7)]);
    this.hn = hn; this.hm = hm; this.hf = hf;
    if (hn.ok) { const z = hn.sample(lat, lon); if (isFinite(z) && z > -500) this.groundZ = z; }
    const gz = this.groundZ;
    const H = s => (x, z) => { const [la, lo] = local.toLL(x, -z); return s.sample(la, lo) - gz; };
    this.heightAt = (x, z) => { const ax = Math.abs(x), az = Math.abs(z); const s = ax < this.nearHalf * 1.4 && az < this.nearHalf * 1.4 ? hn : ax < this.midHalf * 1.4 && az < this.midHalf * 1.4 ? hm : hf; return H(s)(x, z) - curveDrop(Math.hypot(x, z)); };
    progress('Loading aerial imagery…');
    const big = this.q.mobile ? 1536 : 2048;
    const [cn, cm, cf] = await Promise.all([imageryCanvas(local, this.nearHalf, 14, big).catch(() => null), imageryCanvas(local, this.midHalf, 10, big).catch(() => null), imageryCanvas(local, this.farHalf, 7, 1024).catch(() => null)]);
    this.nearCanvas = cn;
    const tex = c => { if (!c) return null; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
    progress('Building terrain…');
    const n = this.q.mobile ? 160 : 256;
    const gn = gridMesh(n, this.nearHalf, H(hn), 0, 0, local);
    const gm = gridMesh(n, this.midHalf, H(hm), this.nearHalf * 0.97, 40, local);
    const gf = gridMesh(this.q.mobile ? 128 : 192, this.farHalf, H(hf), this.midHalf * 0.97, 120, local);
    this.near = new THREE.Mesh(gn, terrainMaterial(this.U, tex(cn), { lightmap: true }));
    this.mid = new THREE.Mesh(gm, terrainMaterial(this.U, tex(cm)));
    this.far = new THREE.Mesh(gf, terrainMaterial(this.U, tex(cf)));
    this.group.add(this.near, this.mid, this.far);
    // imagery pixels for grass colour/density
    if (cn) { const g = cn.getContext('2d', { willReadFrequently: true }); this.nearPx = g.getImageData(0, 0, cn.width, cn.height); }
    return this;
  }
  imageryAt(x, z) {
    const P = this.nearPx; if (!P) return [80, 100, 60];
    const i = Math.floor((x + this.nearHalf) / (2 * this.nearHalf) * P.width), j = Math.floor((z + this.nearHalf) / (2 * this.nearHalf) * P.height);
    if (i < 0 || j < 0 || i >= P.width || j >= P.height) return [80, 100, 60];
    const k = (j * P.width + i) * 4; return [P.data[k], P.data[k + 1], P.data[k + 2]];
  }
  // Light map (lux, linear /40) from lamp positions and lit areas
  setLights(lamps, areas) {
    const S = this.q.mobile ? 1024 : 2048, half = this.nearHalf, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, S, S); g.globalCompositeOperation = 'lighter';
    const px = m => m / (2 * half) * S;
    for (const L of lamps) {
      const x = px(L.x + half), y = px(L.z + half), r = px(L.r || 22);
      if (x < -r || y < -r || x > S + r || y > S + r) continue;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const c = L.c || [255, 190, 120], I = L.i || 0.5;
      gr.addColorStop(0, `rgba(${c[0] * I | 0},${c[1] * I | 0},${c[2] * I | 0},1)`); gr.addColorStop(0.35, `rgba(${c[0] * I * 0.35 | 0},${c[1] * I * 0.35 | 0},${c[2] * I * 0.35 | 0},1)`); gr.addColorStop(1, 'rgba(0,0,0,1)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (const A of areas || []) {
      g.fillStyle = `rgba(${A.c[0]},${A.c[1]},${A.c[2]},1)`; g.beginPath();
      A.ring.forEach(([x, z], i) => i ? g.lineTo(px(x + half), px(z + half)) : g.moveTo(px(x + half), px(z + half))); g.closePath(); g.fill();
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.flipY = false;
    this.U.uLightMap.value = t;
  }
}

// Procedural grass around the viewer: density and colour from imagery, season and snow.
export class Grass {
  constructor(U, ground, opts) {
    this.ground = ground; this.count = opts.mobile ? 6000 : 16000; this.radius = 38;
    const blade = new THREE.BufferGeometry();
    const w = 0.045, h = 1;
    blade.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, -w * 0.6, h * 0.5, 0, w * 0.6, h * 0.5, 0, 0, h, 0], 3));
    blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    const off = new Float32Array(this.count * 4), col = new Float32Array(this.count * 3);
    blade.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4)); blade.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 3));
    const ig = new THREE.InstancedBufferGeometry().copy(blade); ig.instanceCount = this.count;
    this.geo = ig; this.season = opts.season; // {green:0..1, height:m}
    const mat = new THREE.ShaderMaterial({
      uniforms: U, side: THREE.DoubleSide,
      vertexShader: '#include <common>\n' + COMMON + /* glsl */`
        attribute vec4 aOff; attribute vec3 aCol; out vec3 vCol; out vec3 vW; out float vH;
        #include <logdepthbuf_pars_vertex>
        void main(){
          float ang = aOff.w*6.2831; float hgt = 0.12 + fract(aOff.w*37.1)*0.35;
          vec3 p = position; p.y *= hgt * (1.0 - uSnow*0.9);
          float sway = sin(uTime*1.7 + aOff.x*0.3 + aOff.z*0.2)*0.06*p.y;
          p = vec3(p.x*cos(ang), p.y, p.x*sin(ang)) + vec3(sway, 0.0, sway*0.5);
          vec3 w = p + aOff.xyz; vW = w; vH = position.y; vCol = aCol;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
          #include <logdepthbuf_vertex>
          if (uSnow > 0.85) gl_Position = vec4(2.0,2.0,2.0,1.0);
        }`,
      fragmentShader: COMMON + /* glsl */`
        in vec3 vCol; in vec3 vW; in float vH;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          vec3 alb = vCol * (0.55 + 0.45*vH);
          alb = mix(alb, vec3(0.8, 0.83, 0.88), uSnow*smoothstep(0.3, 1.0, vH));
          vec3 E = uSunE*directT(uSunDir.y)*max(uSunDir.y, 0.0)*0.8 + uMoonE*directT(uMoonDir.y)*max(uMoonDir.y,0.0)*0.8;
          vec3 sky = skyL(vec3(0.0,1.0,0.0))*PI*0.8;
          vec3 col = alb/PI*(E*uExposure*(1.0 - 0.9*uOvercast) + sky*(1.0 - 0.65*uOvercast));
          col = aerial(col, normalize(vW - cameraPosition), length(vW - cameraPosition));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(ig, mat); this.mesh.frustumCulled = false;
    this.center = null;
  }
  update(cam) {
    const c = cam.position;
    if (this.center && Math.hypot(c.x - this.center.x, c.z - this.center.z) < 8) return;
    this.center = c.clone();
    const off = this.geo.attributes.aOff.array, col = this.geo.attributes.aCol.array;
    const s = this.season;
    let n = 0;
    for (let i = 0; i < this.count * 3 && n < this.count; i++) {
      const r = this.radius * Math.sqrt(hash(i * 7 + 1)), a = hash(i * 13 + 5) * Math.PI * 2;
      const x = Math.round(c.x / 4) * 4 + r * Math.cos(a), z = Math.round(c.z / 4) * 4 + r * Math.sin(a);
      const im = this.ground.imageryAt(x, z);
      const sat = Math.max(...im) - Math.min(...im), green = im[1] - Math.max(im[0], im[2]);
      const pave = sat < 14 && im[0] > 95; const water = im[2] > im[1] + 8 && im[2] > im[0] + 10;
      if (pave || water || hash(i * 3 + 9) > 0.35 + green / 25) continue;
      if (this.exclude && this.exclude(x, z)) continue;
      const y = this.ground.heightAt(x, z);
      off[n * 4] = x; off[n * 4 + 1] = y; off[n * 4 + 2] = z; off[n * 4 + 3] = hash(i * 17 + 3);
      // season: summer green to dormant tan
      const v = 0.85 + hash(i * 23) * 0.3;
      const g = [0.06 * v, 0.13 * v, 0.035 * v], d = [0.2 * v, 0.16 * v, 0.08 * v];
      col[n * 3] = g[0] + (d[0] - g[0]) * (1 - s.green); col[n * 3 + 1] = g[1] + (d[1] - g[1]) * (1 - s.green); col[n * 3 + 2] = g[2] + (d[2] - g[2]) * (1 - s.green);
      n++;
    }
    this.geo.instanceCount = n;
    this.geo.attributes.aOff.needsUpdate = true; this.geo.attributes.aCol.needsUpdate = true;
  }
}

// Distant lights: thousands of point lights scattered by VIIRS radiance (towns, highways) on the terrain.
export function distantLights(U, lights, local, heightAt, excludeHalf, mobile) {
  const pos = [], inten = [], col = [];
  const max = mobile ? 25000 : 60000;
  if (!lights) return null;
  const P = lights.pts; let total = 0;
  for (let i = 0; i < P.length; i += 5) if (P[i + 3] < 45) total += P[i + 2];
  const per = Math.max(total / max, 0.02);
  let seed = 1;
  for (let i = 0; i < P.length && pos.length / 3 < max; i += 5) {
    if (P[i + 3] > 45) continue;
    const [x, y] = local.toXY(P[i], P[i + 1]), z = -y;
    if (Math.abs(x) < excludeHalf && Math.abs(z) < excludeHalf) continue;
    const nL = Math.min(40, Math.floor(P[i + 2] / per + hash(seed++)));
    const pxM = 40075000 * Math.cos(local.lat0 * Math.PI / 180) / 256 / 256;
    for (let k = 0; k < nL; k++) {
      const xx = x + (hash(seed++) - 0.5) * pxM, zz = z + (hash(seed++) - 0.5) * pxM;
      pos.push(xx, heightAt(xx, zz) + 6, zz);
      inten.push(0.5 + hash(seed++));
      const warm = hash(seed++) < 0.55; col.push(...(warm ? [1, 0.72, 0.42] : [0.95, 0.93, 1]));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aI', new THREE.Float32BufferAttribute(inten, 1)); g.setAttribute('aC', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n' + COMMON + /* glsl */`
      attribute float aI; attribute vec3 aC; out vec3 vC; uniform float uPxSr;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec4 mv = viewMatrix * vec4(position, 1.0); float d = -mv.z;
        // a street light ~ 15 000 lm; seen as a point its illuminance falls with distance squared
        float E = 2.5e3 * aI / (d*d);
        float tr = exp(-d * 3.912 / max(uVisKm*1000.0, 500.0));
        vC = aC * E * tr / (uPxSr * 4.0) * uExposure * uNight;
        gl_PointSize = 2.0;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`in vec3 vC;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord*2.0-1.0; float r = dot(p,p); if (r>1.0) discard; gl_FragColor = vec4(vC*exp(-r*3.0), 1.0); }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false;
  return pts;
}
