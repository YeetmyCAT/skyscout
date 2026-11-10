// Moving sky objects in the 3D view: satellites (sunlit only) and meteors (sporadic + showers), drawn as
// point sources with physical brightness, so light pollution, moonlight, haze and clouds hide them naturally.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';
import { altAzToVec } from '../astro.js';
import { satellitesAt, activeShowers } from '../space.js';
import { starMaterial } from './sky.js';

// world direction of a J2000 RA/Dec through the sky rotation (row-major 3x3)
const dirFromRaDec = (m, ra, dec) => {
  const a = ra * Math.PI / 180, d = dec * Math.PI / 180, e = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  return [m[0] * e[0] + m[1] * e[1] + m[2] * e[2], m[3] * e[0] + m[4] * e[1] + m[5] * e[2], m[6] * e[0] + m[7] * e[1] + m[8] * e[2]];
};
const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// rotate unit vector v about unit axis k by angle t
const rot = (v, k, t) => { const c = Math.cos(t), s = Math.sin(t), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], x = cross(k, v); return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)]; };

export class SkyEvents {
  constructor(U) {
    this.U = U; this.group = new THREE.Group();
    // satellites: up to 160 point sources
    this.satGeo = new THREE.BufferGeometry();
    this.satGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(160 * 3), 3));
    this.satGeo.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(160).fill(30), 1));
    this.satGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(160 * 3).fill(1), 3));
    this.satPts = new THREE.Points(this.satGeo, starMaterial(U, false)); this.satPts.frustumCulled = false; this.satPts.renderOrder = -88;
    // meteors: heads as point sources, trains as lines
    this.maxM = 6;
    this.mGeo = new THREE.BufferGeometry();
    this.mGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxM * 3), 3));
    this.mGeo.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(this.maxM).fill(30), 1));
    this.mGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.maxM * 3).fill(1), 3));
    this.mPts = new THREE.Points(this.mGeo, starMaterial(U, false)); this.mPts.frustumCulled = false; this.mPts.renderOrder = -87;
    const SEG = 16; this.SEG = SEG;
    this.tGeo = new THREE.BufferGeometry();
    this.tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxM * SEG * 2 * 3), 3));
    this.tGeo.setAttribute('aI', new THREE.BufferAttribute(new Float32Array(this.maxM * SEG * 2), 1));
    this.tGeo.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(this.maxM * SEG * 2 * 3), 3));
    this.trail = new THREE.LineSegments(this.tGeo, new THREE.ShaderMaterial({
      uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: '#include <common>\n' + COMMON + `
        attribute float aI; attribute vec3 aC; out vec3 vC; uniform float uPxSr;
        #include <logdepthbuf_pars_vertex>
        void main(){
          vec3 d = refrApparent(normalize(position));   // raised by refraction near the horizon
          // train brightness: aI is illuminance (lux) per pixel length; extinction toward the horizon
          vC = aC * aI * directT(max(d.y, 0.0)) / (uPxSr * 1.5) * uExposure * smoothstep(-0.01, 0.02, d.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(d*1.0e6 + cameraPosition, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `in vec3 vC;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(min(vC, vec3(3.0e4)), 1.0); }`,
    }));
    this.trail.frustumCulled = false; this.trail.renderOrder = -86;
    this.group.add(this.satPts, this.mPts, this.trail);
    this.sats = []; this.meteors = []; this.nextMeteor = 0; this.visibleSats = [];
  }
  setSatellites(list) { this.sats = list || []; }
  // date: the sky time; lim: naked-eye limiting magnitude at the zenith now
  update(now, date, ctx, eqMat, lim, sunAlt) {
    // satellites (only worth computing once the sky is dark-ish)
    const P = this.satGeo.attributes.position.array, M = this.satGeo.attributes.mag.array;
    M.fill(30);
    this.visibleSats = [];
    if (this.sats.length && sunAlt < -3) {
      const vis = satellitesAt(this.sats, date, ctx.lat, ctx.lon, ctx.groundZ);
      vis.slice(0, 160).forEach((s, i) => { P.set(altAzToVec(s.alt, s.az), i * 3); M[i] = s.mag; });
      this.visibleSats = vis;
    }
    this.satGeo.attributes.position.needsUpdate = true; this.satGeo.attributes.mag.needsUpdate = true;
    this.updateMeteors(now, date, eqMat, lim, sunAlt);
  }
  updateMeteors(now, date, m, lim, sunAlt) {
    const dt = Math.min(0.1, now - (this.lastT || now)); this.lastT = now;
    // hourly rate seen by one observer: sporadics (~6/h at limit 6.5) + showers (ZHR * sin(radiant alt)),
    // scaled by r^(lim - 6.5) with population index r = 2.3
    if (!this.showers || !this.showerDay || Math.abs(date - this.showerDay) > 3600e3) { this.showers = activeShowers(date); this.showerDay = date; }
    const corr = Math.pow(2.3, Math.min(lim, 7) - 6.5);
    let rates = [{ r: 6 * corr, sporadic: true }];
    for (const s of this.showers) { const d = dirFromRaDec(m, s.ra, s.dec); if (d[1] > 0) rates.push({ r: s.zhr * d[1] * corr, s, d }); }
    if (sunAlt > -10) rates = [];
    const total = rates.reduce((a, b) => a + b.r, 0) / 3600;
    if (total > 0 && now > this.nextMeteor) {
      if (this.nextMeteor) this.spawn(rates, total * 3600, lim, m);
      this.nextMeteor = now + (-Math.log(Math.random())) / total;
    }
    // animate
    const H = this.mGeo.attributes.position.array, HM = this.mGeo.attributes.mag.array, TP = this.tGeo.attributes.position.array, TI = this.tGeo.attributes.aI.array, TC = this.tGeo.attributes.aC.array;
    HM.fill(30); TI.fill(0);
    this.meteors = this.meteors.filter(mt => now - mt.t0 < mt.dur + 1.2);
    this.meteors.slice(0, this.maxM).forEach((mt, k) => {
      const age = now - mt.t0, p = Math.min(1, age / mt.dur);
      // brightness curve: rises, peaks late, ends abruptly; the train lingers briefly
      const curve = age < mt.dur ? Math.sin(Math.PI * Math.pow(p, 0.8)) : 0;
      const head = rot(mt.start, mt.axis, mt.len * p);
      if (curve > 0) { H.set(head, k * 3); HM[k] = mt.mag - 2.5 * Math.log10(Math.max(curve, 1e-3)); }
      const E = 2.54e-6 * Math.pow(10, -0.4 * mt.mag), fadeTrain = age < mt.dur ? 1 : Math.exp(-(age - mt.dur) / 0.25);
      for (let i = 0; i < this.SEG; i++) {
        const a = Math.max(0, p - 0.35 * (i + 1) / this.SEG), b = Math.max(0, p - 0.35 * i / this.SEG);
        const A = rot(mt.start, mt.axis, mt.len * a), B = rot(mt.start, mt.axis, mt.len * b);
        const o = (k * this.SEG + i) * 2;
        TP.set(A, o * 3); TP.set(B, o * 3 + 3);
        const w = (1 - i / this.SEG) * 0.25 * E * Math.max(curve, age < mt.dur ? 0 : 0.6) * fadeTrain;
        TI[o] = w; TI[o + 1] = w; TC.set(mt.col, o * 3); TC.set(mt.col, o * 3 + 3);
      }
    });
    for (const a of ['position', 'mag']) this.mGeo.attributes[a].needsUpdate = true;
    for (const a of ['position', 'aI', 'aC']) this.tGeo.attributes[a].needsUpdate = true;
  }
  spawn(rates, total, lim, m) {
    let x = Math.random() * total, pick = rates[0];
    for (const r of rates) { x -= r.r; if (x <= 0) { pick = r; break; } }
    // magnitude from the luminosity function: brighter ones are rarer (r = 2.3)
    const mag = Math.min(lim, 6.5) + Math.log(Math.random()) / Math.log(2.3) * 1.0;
    // direction: anywhere above ~15 deg; showers stream away from the radiant
    let start, axis, len;
    const rnd = () => { const az = Math.random() * 2 * Math.PI, alt = Math.asin(0.26 + Math.random() * 0.74); return [Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)]; };
    start = rnd();
    if (pick.d) {
      const rad = pick.d, ang = (15 + Math.random() * 55) * Math.PI / 180;
      const perp = norm(cross(rad, Math.abs(rad[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), dir0 = rot(perp, rad, Math.random() * 2 * Math.PI);
      start = rot(rad, norm(cross(rad, dir0)), ang);
      if (start[1] < 0.15) return;
      axis = norm(cross(rad, start)); len = (0.35 + 0.65 * Math.sin(ang)) * (8 + Math.random() * 14) * Math.PI / 180;
    } else {
      const t = norm(cross(start, [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]));
      axis = t; len = (6 + Math.random() * 20) * Math.PI / 180;
    }
    const v = pick.s ? pick.s.v : 25 + Math.random() * 40;
    const dur = Math.max(0.15, Math.min(1.6, len * 180 / Math.PI / (v * 0.45)));
    const col = v > 55 ? [0.85, 1.0, 0.9] : v < 30 ? [1.0, 0.85, 0.65] : [1.0, 0.97, 0.9];   // fast meteors look greenish-white, slow ones yellow
    this.meteors.push({ t0: this.lastT, start, axis, len, dur, mag, col, shower: pick.s ? pick.s.name : 'sporadic' });
  }
}
