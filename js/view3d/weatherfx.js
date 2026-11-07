// Rain, snow, lightning (with bolts and thunder), distant storms on the horizon, and red sprites / elves above them.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';
import { curveDrop, haversine, bearing } from '../util.js';

export class Precip {
  constructor(U, mobile) {
    this.U = U; this.max = mobile ? 9000 : 22000;
    U.uPrecipRate = { value: 0 }; U.uWindVec = { value: new THREE.Vector2() }; U.uBox = { value: 36 };
    // rain: line segments, two vertices per drop
    const seeds = new Float32Array(this.max * 2 * 4);
    for (let i = 0; i < this.max; i++) { const a = Math.random(), b = Math.random(), c = Math.random(); for (let k = 0; k < 2; k++) { const o = (i * 2 + k) * 4; seeds[o] = a; seeds[o + 1] = b; seeds[o + 2] = c; seeds[o + 3] = k; } }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 2 * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.rain = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: '#include <common>\n' + COMMON + /* glsl */`
        attribute vec4 aSeed; uniform float uPrecipRate, uBox; uniform vec2 uWindVec; out float vA; out vec3 vW;
        #include <logdepthbuf_pars_vertex>
        void main(){
          float speed = 8.5 + aSeed.z*2.0;
          float y = mod(aSeed.y*uBox - uTime*speed, uBox);
          vec3 c = cameraPosition;
          vec3 p = vec3(mod(aSeed.x*uBox - c.x + uWindVec.x*uTime*0.0, uBox) - uBox*0.5 + c.x, y - uBox*0.35 + c.y, mod(aSeed.z*uBox - c.z, uBox) - uBox*0.5 + c.z);
          vec3 v = normalize(vec3(uWindVec.x, -speed, uWindVec.y));
          p += v * aSeed.w * 0.55;
          float vis = step(aSeed.x, uPrecipRate);
          vA = vis; vW = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: COMMON + /* glsl */`
        in float vA; in vec3 vW; uniform sampler2D uLightMap; uniform float uLightHalf;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          if (vA < 0.5) discard;
          vec3 amb = skyL(vec3(0.0, 1.0, 0.0)) * 0.9 + skyL(normalize(vec3(1.0, 0.1, 0.3))) * 0.6;
          vec2 luv = vW.xz/(2.0*uLightHalf) + 0.5; vec3 lm = vec3(0.0);
          if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) lm = texture(uLightMap, luv).rgb * 40.0 * uExposure * uNight * 0.05;
          vec3 c = amb * 0.12 + lm + vec3(0.9)*uFlash.w*0.0015;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    this.rain.frustumCulled = false;
    // snow: points with flutter
    const sg = new THREE.BufferGeometry();
    const ss = new Float32Array(this.max * 4); for (let i = 0; i < ss.length; i++) ss[i] = Math.random();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3)); sg.setAttribute('aSeed', new THREE.BufferAttribute(ss, 4));
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: U, transparent: true, depthWrite: false,
      vertexShader: '#include <common>\n' + COMMON + /* glsl */`
        attribute vec4 aSeed; uniform float uPrecipRate, uBox, uPxScale; uniform vec2 uWindVec; out float vA; out vec3 vW;
        #include <logdepthbuf_pars_vertex>
        void main(){
          float B = uBox*0.7;
          float fall = 0.8 + aSeed.w*0.6;
          vec3 c = cameraPosition;
          vec3 p = vec3(aSeed.x*B + uWindVec.x*uTime*0.6 + sin(uTime*1.3 + aSeed.y*30.0)*0.4, aSeed.y*B - uTime*fall, aSeed.z*B + uWindVec.y*uTime*0.6 + cos(uTime*1.1 + aSeed.x*20.0)*0.4);
          p = mod(p - c + B*0.5, B) - B*0.5 + c;
          vA = step(aSeed.x, uPrecipRate); vW = p;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(60.0/(-mv.z), 1.0, 9.0) * uPxScale;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: COMMON + /* glsl */`
        in float vA; in vec3 vW; uniform sampler2D uLightMap; uniform float uLightHalf;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          if (vA < 0.5) discard;
          vec2 q = gl_PointCoord*2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard;
          vec3 amb = skyL(vec3(0.0,1.0,0.0))*1.1 + (uSunE*max(uSunDir.y,0.0) + uMoonE*max(uMoonDir.y,0.0))*uExposure*0.25;
          vec2 luv = vW.xz/(2.0*uLightHalf) + 0.5; vec3 lm = vec3(0.0);
          if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) lm = texture(uLightMap, luv).rgb * 40.0 * uExposure * uNight * 0.3;
          gl_FragColor = vec4((amb*0.6 + lm + vec3(0.9)*uFlash.w*0.003) * (1.0 - r*0.5), 0.85);
        }`,
    }));
    this.snow.frustumCulled = false;
    this.group = new THREE.Group(); this.group.add(this.rain, this.snow);
  }
  set(type, rate, wind) {
    // rate mm/h -> fraction of particles shown
    const f = type === 'none' ? 0 : Math.min(1, 0.06 + Math.sqrt(rate) * 0.35);
    this.U.uPrecipRate.value = f;
    this.rain.visible = type === 'rain' || type === 'freezing';
    this.snow.visible = type === 'snow';
    this.U.uWindVec.value.set(wind[0], wind[1]);
  }
}

// Lightning: flashes inside storm cells, branching cloud-to-ground bolts, thunder with correct delay.
export class Lightning {
  constructor(U, audio) {
    this.U = U; this.audio = audio; this.events = []; this.next = 0; this.rate = 0; this.cells = [];
    this.group = new THREE.Group();
    this.boltMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uI: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: '#include <common>\n#include <logdepthbuf_pars_vertex>\nvoid main(){ gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}',
      fragmentShader: 'uniform float uI, uExposure;\n#include <logdepthbuf_pars_fragment>\nvoid main(){\n#include <logdepthbuf_fragment>\n gl_FragColor = vec4(vec3(0.8,0.85,1.0)*min(uI, 3.0e4), 1.0); }',
    });
  }
  // cells: [{x, z, top, strength}] in metres; rate: flashes per minute in total
  setStorms(cells, ratePerMin) { this.cells = cells; this.rate = ratePerMin; }
  bolt(x, z, base, groundY) {
    const pts = []; let p = new THREE.Vector3(x, base, z);
    const segs = [];
    const grow = (p, len, depth) => {
      let cur = p.clone();
      while (cur.y > groundY && len-- > 0) {
        const nx = cur.clone().add(new THREE.Vector3((Math.random() - 0.5) * 180, -(60 + Math.random() * 120), (Math.random() - 0.5) * 180));
        segs.push(cur.x, cur.y, cur.z, nx.x, nx.y, nx.z);
        if (depth < 2 && Math.random() < 0.12) grow(nx, 6 + Math.random() * 10, depth + 1);
        cur = nx;
      }
    };
    grow(p, 200, 0);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    const m = new THREE.LineSegments(g, this.boltMat); m.frustumCulled = false; return m;
  }
  update(dt, now, camPos, heightAt) {
    const U = this.U;
    if (this.rate > 0 && this.cells.length && now > this.next) {
      this.next = now + (-Math.log(Math.random()) * 60 / this.rate);
      const tot = this.cells.reduce((s, c) => s + c.strength, 0); let r = Math.random() * tot, c = this.cells[0];
      for (const k of this.cells) { r -= k.strength; if (r <= 0) { c = k; break; } }
      const x = c.x + (Math.random() - 0.5) * 6000, z = c.z + (Math.random() - 0.5) * 6000, y = 3000 + Math.random() * 5000;
      const cg = Math.random() < 0.3;
      const strokes = cg ? 2 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2);
      const ev = { x, y, z, t0: now, strokes, cg, I: 0.6 + Math.random() };
      if (cg) { ev.mesh = this.bolt(x, z, c.base || 1500, heightAt(x, z)); this.group.add(ev.mesh); }
      this.events.push(ev);
      const dist = Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z);
      if (this.audio) this.audio.thunder(dist, cg, ev.I);
    }
    let fl = 0, fx = 0, fy = 0, fz = 0;
    this.events = this.events.filter(e => {
      const t = now - e.t0;
      let I = 0;
      for (let k = 0; k < e.strokes; k++) { const tk = t - k * 0.09; if (tk > 0) I += Math.exp(-tk / 0.035) * (k ? 0.7 : 1); }
      I *= e.I;
      if (I > fl) { fl = I; fx = e.x; fy = e.y; fz = e.z; }
      if (e.mesh) e.mesh.visible = I > 0.05;
      if (t > 1.2) { if (e.mesh) { this.group.remove(e.mesh); e.mesh.geometry.dispose(); } return false; }
      return true;
    });
    // flash luminance scale: a nearby flash lights a whole cloud to ~1e3 cd/m^2 for a few ms
    U.uFlash.value.set(fx, fy, fz, fl * 300 * U.uExposure.value);
    this.boltMat.uniforms.uI.value = fl * 4e4 * U.uExposure.value;
  }
}

// Storms beyond the cloud domain (from the sprite/storm forecast): anvils on the horizon with flicker and sprites.
export class FarStorms {
  constructor(U) {
    this.U = U; this.group = new THREE.Group(); this.storms = []; this.sprites = []; this.forecast = null;
    U.uSpriteMode = { value: 1 };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uKind: { value: 0 }, uI: { value: 1 }, uSeed: { value: 0 }, uGlow: { value: new THREE.Vector2() }, uDist: { value: 200000 }, uShear: { value: 0.2 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: '#include <common>\nout vec2 vP;\n#include <logdepthbuf_pars_vertex>\nvoid main(){ vP = uv; gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}',
      fragmentShader: COMMON + /* glsl */`
        in vec2 vP; uniform float uKind, uI, uSeed, uDist, uShear; uniform vec2 uGlow;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          vec2 p = vP;
          if (uKind < 0.5){
            // sprite cluster: red crowns at 70-85 km with a diffuse halo, blue-purple tendrils reaching down to ~50 km
            float x = (p.x - 0.5)*2.0, cols = 0.0;
            for (int i = 0; i < 9; i++){
              float cx = (hash12(vec2(float(i), uSeed)) - 0.5)*1.5;
              float w = 0.02 + 0.03*hash12(vec2(uSeed, float(i)));
              float top = 0.72 + 0.18*hash12(vec2(float(i)*3.1, uSeed));
              float carrot = exp(-pow((x - cx)/(w*(0.6 + 1.6*smoothstep(0.35, top, p.y))), 2.0)) * smoothstep(0.3, 0.6, p.y) * smoothstep(top + 0.06, top - 0.04, p.y);
              float tendr = exp(-pow((x - cx + 0.04*sin(p.y*50.0 + float(i)*2.0))/(w*0.3), 2.0)) * smoothstep(0.02, 0.45, p.y) * (1.0 - smoothstep(0.35, 0.6, p.y));
              cols += carrot + tendr*0.6;
            }
            float halo = exp(-pow(x/0.8, 2.0) - pow((p.y - 0.9)/0.05, 2.0));
            vec3 c = vec3(1.0, 0.1, 0.16)*cols + vec3(1.0, 0.3, 0.32)*halo*0.7;
            c = mix(c, vec3(0.45, 0.3, 1.0)*cols, smoothstep(0.5, 0.2, p.y)*0.6);
            // ~1 MR peak in the red is ~2e-2 cd/m^2, and a few-ms flash looks ~20x dimmer to the eye
            gl_FragColor = vec4(min(c * uI * 2.5e-4 * uExposure, vec3(3.0e4)), 1.0);
          } else if (uKind < 1.5){
            // elve: a fast expanding red ring at ~90 km
            vec2 q = (p - 0.5)*2.0; q.y *= 6.0;
            float r = length(q), ring = exp(-pow((r - 0.6)/0.18, 2.0));
            gl_FragColor = vec4(vec3(1.0, 0.15, 0.1) * ring * uI * 1.0e-4 * uExposure, 1.0);
          } else {
            // distant thunderstorm complex: towers (turrets) feeding a flat anvil sheared downwind; dark against the
            // sky, lit by sun or moon, and from inside by lightning
            float x = (p.x - 0.5)*2.0, y = p.y;
            vec2 wq = vec2(x*3.0, y*4.0) + uSeed;
            vec2 warp = vec2(fbm2(wq), fbm2(wq + 5.2)) - 0.5;
            float n1 = fbm2(vec2(x*7.0, y*6.0) + warp*1.5 + uSeed), n2 = fbm2(vec2(x*22.0, y*18.0) + warp*3.0);
            float turrets = 0.0;
            for (int i = 0; i < 5; i++){
              float cx = (hash12(vec2(float(i), uSeed)) - 0.5)*1.2, w = 0.08 + 0.1*hash12(vec2(uSeed, float(i) + 3.0));
              float top = 0.55 + 0.35*hash12(vec2(float(i)*7.0, uSeed));
              turrets = max(turrets, smoothstep(w*1.6, w*0.4, abs(x - cx - warp.x*0.08)) * smoothstep(top + 0.05, top - 0.15, y + (n1 - 0.5)*0.12));
            }
            float anvilW = 0.4 + 0.6*smoothstep(0.62, 0.86, y);
            float ax = x - uShear*smoothstep(0.7, 0.9, y);
            float anvil = smoothstep(0.76, 0.82, y + (n1 - 0.5)*0.05) * smoothstep(0.95, 0.88, y + (n1 - 0.5)*0.04) * smoothstep(anvilW, anvilW - 0.25, abs(ax));
            float base = smoothstep(0.0, 0.05, y) * smoothstep(0.75, 0.2, abs(x)) * step(y, 0.3);
            float d = clamp(max(max(turrets, anvil), base*0.8) * (0.7 + 0.6*n2), 0.0, 1.0);
            if (d < 0.03) discard;
            // daylight / moonlight on the cloud, then the long air path in front of it
            vec3 lit = (uSunE*directT(max(uSunDir.y, 0.02))*smoothstep(-0.05, 0.05, uSunDir.y) + uMoonE*directT(max(uMoonDir.y, 0.02))*smoothstep(-0.05, 0.05, uMoonDir.y)) * uExposure * 0.5/PI * (0.6 + 0.6*y)
                     + skyL(vec3(0.0, 1.0, 0.0)) * 0.6;
            vec3 hz = hazeL(vec3(0.0, 0.03, -1.0));
            vec3 col = mix(lit, hz, 1.0 - exp(-uDist * 3.912 / max(uVisKm*1000.0*6.0, 60000.0)));
            float glow = exp(-pow((x - uGlow.x)*3.0, 2.0) - pow((y - uGlow.y)*3.0, 2.0));
            col += vec3(0.82, 0.84, 1.0) * uI * (0.15 + glow) * 0.08 * uExposure * (0.5 + n2);
            gl_FragColor = vec4(min(col, vec3(3.0e4)), d*0.95);
          }
        }`,
    });
  }
  // Forecast storm complexes by hour (from the sprite finder): they move and grow/decay with time.
  setForecast(data, lat, lon) { this.forecast = data ? { ...data, lat, lon } : null; }
  atTime(unix) {
    const F = this.forecast; if (!F || !F.stormsByHour || !F.stormsByHour.length) { this.set([]); return; }
    const H = F.stormsByHour;
    let i = 0; while (i < H.length - 2 && H[i + 1].t <= unix) i++;
    const a = H[i], b = H[Math.min(i + 1, H.length - 1)];
    if (unix < a.t - 1800 || unix > b.t + 1800) { this.set([]); return; }
    const f = b.t > a.t ? Math.max(0, Math.min(1, (unix - a.t) / (b.t - a.t))) : 0;
    const used = new Set(), out = [];
    const dist = (p, q) => haversine(p.la, p.lo, q.la, q.lo) / 1000;
    for (const [k, c] of a.clusters.entries()) {
      let best = -1, bd = 250;
      b.clusters.forEach((d, j) => { const x = dist(c, d); if (x < bd && !used.has(j)) { bd = x; best = j; } });
      if (best >= 0) { used.add(best); const d = b.clusters[best]; out.push({ id: `${i}:${k}`, la: c.la + (d.la - c.la) * f, lo: c.lo + (d.lo - c.lo) * f, area: c.area + (d.area - c.area) * f, peak: c.peak + (d.peak - c.peak) * f, topKm: c.topKm + (d.topKm - c.topKm) * f }); }
      else out.push({ id: `${i}:${k}`, ...c, peak: c.peak * (1 - f) });           // dying
    }
    b.clusters.forEach((d, j) => { if (!used.has(j)) out.push({ id: `n${i}:${j}`, ...d, peak: d.peak * f }); });   // forming
    const list = [];
    for (const c of out) {
      const dKm = haversine(F.lat, F.lon, c.la, c.lo) / 1000;
      // the near edge of the complex sets the geometry; too close (overhead) or beyond ~650 km: no sprite view
      const edge = Math.max(10, dKm - Math.sqrt(c.area) / 2);
      if (edge < 80 || edge > 650 || c.peak < 0.08) continue;
      const az = bearing(F.lat, F.lon, c.la, c.lo);
      const drop = curveDrop(edge * 1000) / 1000;
      list.push({ id: c.id, az, distKm: edge, topKm: c.topKm, strength: c.peak, widthKm: Math.min(400, Math.sqrt(c.area) * 1.1), area: c.area, spriteAlt: Math.atan((75 - drop) / edge) * 180 / Math.PI });
    }
    this.set(list);
  }
  // storms: [{id, az, distKm, topKm, strength, widthKm}]
  set(storms) {
    const keep = new Map(this.storms.map(s => [s.id, s]));
    for (const o of this.group.children.slice()) if (!this.sprites.some(sp => sp.mesh === o)) this.group.remove(o);
    this.storms = storms.map((s, i) => {
      const d = s.distKm * 1000, az = s.az * Math.PI / 180, x = Math.sin(az) * d, z = -Math.cos(az) * d;
      const drop = curveDrop(d);
      const old = keep.get(s.id);
      const m = old ? old.mesh : new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), this.mat.clone());
      const u = m.material.uniforms;
      u.uKind.value = 2; u.uSeed.value = (typeof s.id === 'string' ? s.id.length * 3.1 : 0) + i * 3.7; u.uDist.value = d; u.uShear.value = 0.25;
      m.material.blending = THREE.NormalBlending;
      m.position.set(x, -drop, z); m.scale.set((s.widthKm || 60) * 1000, s.topKm * 1000 * 1.1, 1); m.lookAt(0, -drop, 0);
      m.frustumCulled = false; if (!old) u.uI.value = 0;
      this.group.add(m);
      return { ...s, x, z, drop, mesh: m, next: old ? old.next : 0, nextSprite: old ? old.nextSprite : 0, flashT: old && old.flashT };
    });
  }
  update(now, spriteMode, night) {
    for (const s of this.storms) {
      // internal flicker: a big system flashes every second or so
      if (now > s.next) { s.next = now + (-Math.log(Math.random())) / (0.4 + s.strength * 2.5); s.flashT = now; s.flashI = 0.2 + Math.random(); s.mesh.material.uniforms.uGlow.value.set((Math.random() - 0.5) * 1.2, 0.25 + Math.random() * 0.5); }
      const f = s.flashT ? Math.exp(-(now - s.flashT) / 0.06) * s.flashI : 0;
      s.mesh.material.uniforms.uI.value = f * s.strength;
      // sprites: large systems produce one every few seconds to a minute (shown a little more often than real)
      if (spriteMode && night && s.strength > 0.15) {
        if (!s.nextSprite) s.nextSprite = now + 1 + Math.random() * 3;
        if (now > s.nextSprite) {
          const rate = 0.15 * s.strength * Math.max(0.5, Math.min(3, (s.area || 40000) / 40000));
          s.nextSprite = now + (-Math.log(Math.random())) / rate;
          s.flashT = now; s.flashI = 1.6;                      // the parent +CG stroke lights the cloud
          this.spawnSprite(s, now);
        }
      }
    }
    this.sprites = this.sprites.filter(sp => {
      const t = now - sp.t0; const I = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / sp.decay);
      sp.mesh.material.uniforms.uI.value = I * sp.I;
      if (t > sp.decay * 8) { this.group.remove(sp.mesh); return false; }
      return true;
    });
  }
  spawnSprite(s, now) {
    // over the trailing stratiform part of the complex, 50-90 km up
    const az = s.az * Math.PI / 180, side = (Math.random() - 0.5) * (s.widthKm || 80) * 1000 * 0.8, along = (Math.random() - 0.3) * 40000;
    const d = s.distKm * 1000 + along, drop = curveDrop(d);
    const bx = Math.sin(az) * d + Math.cos(az) * side, bz = -Math.cos(az) * d + Math.sin(az) * side;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), this.mat.clone());
    m.material.uniforms.uKind.value = 0; m.material.uniforms.uSeed.value = Math.random() * 100;
    m.position.set(bx, 45000 - drop, bz); m.scale.set(20000 + Math.random() * 40000, 45000, 1); m.lookAt(0, m.position.y, 0); m.frustumCulled = false;
    this.group.add(m); this.sprites.push({ mesh: m, t0: now, I: 3 + Math.random() * 4, decay: 0.05 + Math.random() * 0.08 });
    if (Math.random() < 0.2) {   // an elve sometimes precedes the sprite
      const e = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), this.mat.clone());
      e.material.uniforms.uKind.value = 1; e.position.set(bx, 80000 - drop, bz); e.scale.set(300000, 30000, 1); e.lookAt(0, e.position.y, 0); e.frustumCulled = false;
      this.group.add(e); this.sprites.push({ mesh: e, t0: now, I: 2, decay: 0.02 });
    }
  }
}

// Procedural audio: rain hiss and thunder (no samples needed).
export class WxAudio {
  constructor() { this.ctx = null; this.on = false; }
  enable() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const len = this.ctx.sampleRate * 4, b = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = b.getChannelData(0);
      let last = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.5 + last * 3; }
      this.noise = b;
      this.rainGain = this.ctx.createGain(); this.rainGain.gain.value = 0;
      const src = this.ctx.createBufferSource(); src.buffer = b; src.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 900;
      src.connect(f).connect(this.rainGain).connect(this.ctx.destination); src.start();
    }
    this.ctx.resume(); this.on = true;
  }
  disable() { this.on = false; if (this.ctx) this.ctx.suspend(); }
  rain(level) { if (this.rainGain) this.rainGain.gain.setTargetAtTime(this.on ? level * 0.25 : 0, this.ctx.currentTime, 0.5); }
  thunder(distM, cg, I) {
    if (!this.on || !this.ctx || distM > 25000) return;
    const c = this.ctx, delay = distM / 343, t0 = c.currentTime + delay;
    const near = Math.max(0, 1 - distM / 3000);
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 120 + 1800 * near;
    const g = c.createGain(); const peak = Math.min(1, 0.6 * I * 4000 / (distM + 1500));
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak * (near > 0.3 ? 1 : 0.35), t0 + (near > 0.3 ? 0.02 : 0.5));
    // rolling rumble
    let t = t0 + 0.5; for (let k = 0; k < 6; k++) { g.gain.linearRampToValueAtTime(peak * (0.25 + Math.random() * 0.6) * (1 - k / 7), t); t += 0.4 + Math.random() * 0.9; }
    g.gain.linearRampToValueAtTime(0, t + 1.5);
    lp.frequency.linearRampToValueAtTime(90, t + 1);
    src.connect(lp).connect(g).connect(c.destination); src.start(t0, Math.random() * 3); src.stop(t + 2);
  }
}
