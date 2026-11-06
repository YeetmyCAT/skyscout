// Rain, snow, lightning (with bolts and thunder), distant storms on the horizon, and red sprites / elves above them.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';
import { curveDrop } from '../util.js';

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
      fragmentShader: 'uniform float uI, uExposure;\n#include <logdepthbuf_pars_fragment>\nvoid main(){\n#include <logdepthbuf_fragment>\n gl_FragColor = vec4(vec3(0.8,0.85,1.0)*uI, 1.0); }',
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
    this.U = U; this.group = new THREE.Group(); this.storms = []; this.sprites = [];
    U.uSpriteMode = { value: 0 };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uKind: { value: 0 }, uI: { value: 1 }, uSeed: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: '#include <common>\nout vec2 vP;\n#include <logdepthbuf_pars_vertex>\nvoid main(){ vP = uv; gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}',
      fragmentShader: COMMON + /* glsl */`
        in vec2 vP; uniform float uKind, uI, uSeed;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          vec2 p = vP;
          if (uKind < 0.5){
            // sprite cluster: bright red head 70-85 km, diffuse halo, blue-ish tendrils hanging down to ~50 km
            float x = (p.x - 0.5)*2.0;
            float cols = 0.0;
            for (int i = 0; i < 7; i++){
              float cx = (hash12(vec2(float(i), uSeed)) - 0.5)*1.4;
              float w = 0.025 + 0.03*hash12(vec2(uSeed, float(i)));
              float top = 0.75 + 0.15*hash12(vec2(float(i)*3.1, uSeed));
              float col = exp(-pow((x - cx)/w, 2.0)) * smoothstep(0.15, 0.55, p.y) * smoothstep(top + 0.08, top - 0.05, p.y);
              float tendr = exp(-pow((x - cx + 0.05*sin(p.y*40.0 + float(i)))/(w*0.35), 2.0)) * smoothstep(0.0, 0.5, p.y) * (1.0 - smoothstep(0.3, 0.55, p.y));
              cols += col + tendr*0.5;
            }
            float halo = exp(-pow(x/0.7, 2.0) - pow((p.y - 0.88)/0.06, 2.0));
            vec3 c = vec3(1.0, 0.12, 0.18)*cols + vec3(1.0, 0.25, 0.3)*halo*0.6;
            c = mix(c, vec3(0.4, 0.3, 1.0)*cols, smoothstep(0.45, 0.2, p.y)*0.6);
            gl_FragColor = vec4(c * uI * 0.02 * uExposure, 1.0);
          } else {
            // distant thunderstorm: towers rising into a flat anvil, a dark silhouette against the sky,
            // lit from inside by lightning
            float x = (p.x - 0.5)*2.0, y = p.y;
            float n1 = fbm2(vec2(x*6.0, y*5.0) + uSeed), n2 = fbm2(vec2(x*18.0, y*14.0) + uSeed*1.7);
            float towers = smoothstep(0.55 + 0.25*sin(x*7.0 + uSeed)*(1.0 - y), 0.2, abs(x)*1.6 + (y - 0.1)*0.4) * step(y, 0.84);
            float anvilW = 0.35 + 0.65*smoothstep(0.6, 0.86, y);
            float anvil = smoothstep(0.78, 0.84, y) * smoothstep(0.95, 0.88, y + n1*0.04) * smoothstep(anvilW, anvilW - 0.15, abs(x - 0.25*smoothstep(0.75, 0.9, y)));
            float d = clamp(max(towers, anvil) * (0.75 + 0.5*n2), 0.0, 1.0);
            d *= smoothstep(0.0, 0.04, y);
            if (d < 0.02) discard;
            vec3 sil = skyL(vec3(0.0, 0.03, -1.0)) * 0.45;
            float glow = exp(-pow((x - 0.1*sin(uSeed*7.0))*2.5, 2.0) - pow((y - 0.45)*2.2, 2.0));
            vec3 flash = vec3(0.8, 0.82, 1.0) * uI * (0.25 + glow) * 0.06 * uExposure;
            gl_FragColor = vec4(sil + flash*d, d*0.9);
          }
        }`,
    });
  }
  // storms: [{az, distKm, topKm, strength}]
  set(storms) {
    for (const o of this.group.children.slice()) this.group.remove(o);
    this.storms = storms.map((s, i) => {
      const d = s.distKm * 1000, az = s.az * Math.PI / 180, x = Math.sin(az) * d, z = -Math.cos(az) * d;
      const drop = curveDrop(d);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), this.mat.clone());
      m.material.uniforms.uKind.value = 1; m.material.uniforms.uSeed.value = i * 3.7; m.material.blending = THREE.NormalBlending;
      m.position.set(x, -drop, z); m.scale.set(s.widthKm * 1000 || 60000, s.topKm * 1000 * 1.1, 1); m.lookAt(0, -drop, 0);
      m.frustumCulled = false; m.material.uniforms.uI.value = 0;
      this.group.add(m);
      return { ...s, x, z, drop, mesh: m, next: 0 };
    });
  }
  update(now, spriteMode, night) {
    for (const s of this.storms) {
      // internal flicker: several flashes per second for a strong MCS
      if (now > s.next) { s.next = now + (-Math.log(Math.random())) / (0.5 + s.strength * 3); s.flashT = now; s.flashI = 0.2 + Math.random(); }
      const f = s.flashT ? Math.exp(-(now - s.flashT) / 0.06) * s.flashI : 0;
      s.mesh.material.uniforms.uI.value = f * s.strength;
      // sprites: rare, after strong +CG strokes in large systems
      if (spriteMode && night && s.strength > 0.3 && f > 0.9 && Math.random() < 0.08 * s.strength) this.spawnSprite(s, now);
    }
    this.sprites = this.sprites.filter(sp => {
      const t = now - sp.t0; const I = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / 0.07);
      sp.mesh.material.uniforms.uI.value = I * sp.I;
      if (t > 0.6) { this.group.remove(sp.mesh); return false; }
      return true;
    });
  }
  spawnSprite(s, now) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), this.mat.clone());
    m.material.uniforms.uKind.value = 0; m.material.uniforms.uSeed.value = Math.random() * 100;
    const off = (Math.random() - 0.5) * 60000;
    m.position.set(s.x + Math.cos(s.az * Math.PI / 180) * off, 45000 - s.drop, s.z + Math.sin(s.az * Math.PI / 180) * off);
    m.scale.set(30000 + Math.random() * 30000, 45000, 1); m.lookAt(0, m.position.y, 0); m.frustumCulled = false;
    this.group.add(m); this.sprites.push({ mesh: m, t0: now, I: 2 + Math.random() * 3 });
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
