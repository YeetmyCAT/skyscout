// Astronomy overlays: alt/az grid, horizon, cardinal points, meridian, celestial equator, ecliptic, constellation lines,
// and HTML labels for planets, bright stars, Moon, Sun, light domes and storm targets.
import * as THREE from '../../vendor/three.module.min.js';
import { altAzToVec, raDecVec, OBLIQ, refraction } from '../astro.js';
import { REFR, refrUniform } from './glsl.js';
// a sky direction as it is seen: raised by refraction near the horizon (labels follow the refracted stars)
function seen(v) { const l = Math.hypot(v[0], v[1], v[2]), y = v[1] / l, h = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI; if (h > 89) return v; const a = (h + refraction(h, refrUniform.value)) * Math.PI / 180, hl = Math.hypot(v[0], v[2]) || 1; return [v[0] / hl * Math.cos(a) * l, Math.sin(a) * l, v[2] / hl * Math.cos(a) * l]; }

const RAD = 1e6;
// refr: sky lines (equator, ecliptic, constellations) are raised by refraction like the stars they connect
function lineMat(color, opacity, refr) {
  return new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Color(color) }, uO: { value: opacity }, uRefrK: refrUniform }, transparent: true, depthWrite: false,
    vertexShader: refr
      ? '#include <common>\n' + REFR + '\n#include <logdepthbuf_pars_vertex>\nvoid main(){ vec3 dd = (modelMatrix*vec4(position,1.0)).xyz - cameraPosition; float len = length(dd); dd = refrApparent(dd/len)*len; gl_Position = projectionMatrix*viewMatrix*vec4(cameraPosition + dd, 1.0);\n#include <logdepthbuf_vertex>\n}'
      : '#include <common>\n#include <logdepthbuf_pars_vertex>\nvoid main(){ gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}',
    fragmentShader: 'uniform vec3 uC; uniform float uO;\n#include <logdepthbuf_pars_fragment>\nvoid main(){\n#include <logdepthbuf_fragment>\n gl_FragColor = vec4(uC, uO); }',
  });
}
function segs(arr, mat) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); const l = new THREE.LineSegments(g, mat); l.frustumCulled = false; return l; }

export class Overlays {
  constructor(container, constLines, starData) {
    this.group = new THREE.Group(); this.horGroup = new THREE.Group(); this.eqGroup = new THREE.Group();
    this.group.add(this.horGroup, this.eqGroup);
    this.labels = document.createElement('div'); this.labels.className = 'labels3d'; container.append(this.labels);
    this.items = []; this.on = { grid: false, cardinals: true, ecliptic: false, equator: false, meridian: false, constellations: false, labels: false, domes: true };
    // alt/az grid
    const g = [];
    for (let alt = 0; alt < 90; alt += 10) for (let az = 0; az < 360; az += 2) g.push(...v(alt, az), ...v(alt, az + 2));
    for (let az = 0; az < 360; az += 15) for (let alt = 0; alt < 88; alt += 2) g.push(...v(alt, az), ...v(alt + 2, az));
    this.grid = segs(g, lineMat(0x7fb6ff, 0.18)); this.horGroup.add(this.grid);
    const hz = []; for (let az = 0; az < 360; az += 1) hz.push(...v(0, az), ...v(0, az + 1));
    this.horizon = segs(hz, lineMat(0x9fd0ff, 0.45)); this.horGroup.add(this.horizon);
    const mer = []; for (let alt = 0; alt < 180; alt += 1) { const a = alt <= 90 ? alt : 180 - alt, z = alt <= 90 ? 180 : 0; const b = alt + 1 <= 90 ? alt + 1 : 179 - alt, z2 = alt + 1 <= 90 ? 180 : 0; mer.push(...v(a, z), ...v(b, z2)); }
    this.meridian = segs(mer, lineMat(0xffd27f, 0.4)); this.horGroup.add(this.meridian);
    // equatorial frame lines (J2000), transformed every frame
    const eq = [], ec = [];
    for (let ra = 0; ra < 360; ra += 1) { eq.push(...raDecVec(ra, 0).map(x => x * RAD), ...raDecVec(ra + 1, 0).map(x => x * RAD)); }
    for (let l = 0; l < 360; l += 1) { ec.push(...ecl(l), ...ecl(l + 1)); }
    this.equator = segs(eq, lineMat(0x8fe3a8, 0.35, true)); this.ecliptic = segs(ec, lineMat(0xffb070, 0.5, true));
    const cl = []; for (const line of constLines) for (let i = 0; i < line.length - 1; i++) cl.push(...raDecVec(...line[i]).map(x => x * RAD), ...raDecVec(...line[i + 1]).map(x => x * RAD));
    this.constellations = segs(cl, lineMat(0x88aaff, 0.22, true));
    this.eqGroup.add(this.equator, this.ecliptic, this.constellations);
    // star names
    this.stars = Object.entries(starData.n).map(([i, name]) => ({ name, v: raDecVec(starData.s[i * 4], starData.s[i * 4 + 1]), mag: starData.s[i * 4 + 2] }));
    this.apply();
  }
  apply() {
    this.grid.visible = this.on.grid; this.horizon.visible = this.on.grid || this.on.cardinals; this.meridian.visible = this.on.meridian;
    this.equator.visible = this.on.equator; this.ecliptic.visible = this.on.ecliptic; this.constellations.visible = this.on.constellations;
  }
  setEq(m3) { const m = new THREE.Matrix4(); m.set(m3[0], m3[1], m3[2], 0, m3[3], m3[4], m3[5], 0, m3[6], m3[7], m3[8], 0, 0, 0, 0, 1); this.eqGroup.matrixAutoUpdate = false; this.eqGroup.matrix.copy(m); this.eqMat = m3; }
  // dynamic labels: [{text, alt, az, cls}] plus internal ones
  setDynamic(list) { this.dynamic = list; }
  update(camera, w, h) {
    this.group.position.copy(camera.position);
    const L = [];
    if (this.on.cardinals) {
      const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      names.forEach((n, i) => L.push({ t: n, alt: 0.6, az: i * 45, cls: n.length === 1 ? 'cardi main' : 'cardi' }));
    }
    if (this.on.grid) { for (const a of [10, 30, 50, 70]) for (let az = 0; az < 360; az += 90) L.push({ t: a + '°', alt: a, az: az + 7.5, cls: 'gridlbl' }); }
    if (this.on.meridian) L.push({ t: 'meridian', alt: 45, az: 180, cls: 'gridlbl mer' });
    if (this.on.labels && this.eqMat && !(this.sunAlt > -7)) {
      const m = this.eqMat;
      for (const s of this.stars) { const v = s.v; const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2], y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2], z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2]; if (y > 0.02) L.push({ t: s.name, vec: seen([x, y, z]), cls: 'star' }); }
    }
    if (this.on.ecliptic && this.eqMat) L.push(...[0, 90, 180, 270].map(l => { const e = ecl(l).map(x => x / RAD), m = this.eqMat; return { t: 'ecliptic', vec: seen([m[0] * e[0] + m[1] * e[1] + m[2] * e[2], m[3] * e[0] + m[4] * e[1] + m[5] * e[2], m[6] * e[0] + m[7] * e[1] + m[8] * e[2]]), cls: 'gridlbl ecl' }; }).filter(x => x.vec[1] > 0));
    for (const d of this.dynamic || []) if (this.on.labels || d.always) if (!(d.dome && !this.on.domes)) L.push(d);
    // project, most important first; drop labels that would overlap one already placed
    const pri = c => /cardi/.test(c) ? 0 : /planet|storm/.test(c) ? 1 : /dome|mw/.test(c) ? 2 : /star/.test(c) ? 4 : 3;
    L.sort((a, b) => pri(a.cls) - pri(b.cls));
    const boxes = [];
    const out = [], P = new THREE.Vector3();
    for (const l of L) {
      const vv = l.vec || altAzToVec(l.alt, l.az);
      if (vv[1] < -0.012 && !l.always) continue;
      P.set(vv[0], vv[1], vv[2]).multiplyScalar(1000).add(camera.position).project(camera);
      if (P.z > 1 || Math.abs(P.x) > 1.05 || Math.abs(P.y) > 1.05) continue;
      const x = (P.x + 1) / 2 * w, y = (1 - P.y) / 2 * h, bw = String(l.t).length * 6.6 + 8, bh = 15;
      const bx = /cardi/.test(l.cls) ? x - 6 : x + 6, by = y - 7;
      if (boxes.some(b => bx < b[0] + b[2] && bx + bw > b[0] && by < b[1] + b[3] && by + bh > b[1])) continue;
      boxes.push([bx, by, bw, bh]);
      out.push(`<div class="${l.cls}" style="transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px)">${l.t}</div>`);
    }
    const html = out.join('');
    if (html !== this.lastHtml) { this.labels.innerHTML = html; this.lastHtml = html; }
  }
}
function v(alt, az) { return altAzToVec(alt, az).map(x => x * RAD); }
function ecl(lonDeg) {
  const l = lonDeg * Math.PI / 180, x = Math.cos(l), y = Math.sin(l) * Math.cos(OBLIQ), z = Math.sin(l) * Math.sin(OBLIQ);
  return [x * RAD, y * RAD, z * RAD];
}
