// Immersive 360° view: assembles sky, clouds, terrain, structures and weather for one place and time.
import * as THREE from '../../vendor/three.module.min.js';
import { makeSkyLUT, makeSkyBackground, makeStars, makePlanets, makeMoon, milkyWayPhoto, makeFaintStars, lpSkyTexture } from './sky.js';
import { SkyEvents } from './skyevents.js';
import { loadKp, kpAt, MAG_POLE, ecef, enuBasis, magLat, loadSatellites, loadOvation, synthAurora, auroraOval } from '../space.js';
import { loadNoise, makeCloudPass, weatherTextures, R_EFF } from './clouds.js';
import { Ground, Grass, distantLights } from './ground.js';
import { roadMasks } from '../terrain.js';
import { Structures } from './structures.js';
import { Farms, CROP_NAMES } from './farms.js';
import { Precip, Lightning, FarStorms, WxAudio } from './weatherfx.js';
import { Overlays } from './overlays.js';
import { sunMoon, planets as planetPos, altAzToVec, vecToAltAz, eqjToWorld, observer, EQ2GAL, OBLIQ, phaseName } from '../astro.js';
import { val, cloudLayers, precipState, fogRisk, idxAt } from '../weather.js';
import { groundFluxGrid, NAT_SKY, lum2mag } from '../lightpol.js';
import { clamp, smooth, lerp, DEG, curveDrop } from '../util.js';
import { congestion } from '../routing.js';

const SAFE = 'vec3 safeC(vec3 c){ return vec3(c.r >= 0.0 ? min(c.r, 3.0e4) : 0.0, c.g >= 0.0 ? min(c.g, 3.0e4) : 0.0, c.b >= 0.0 ? min(c.b, 3.0e4) : 0.0); }';
const FSQ = new THREE.BufferGeometry(); FSQ.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
function fsPass(frag, uniforms, opts = {}) {
  const m = new THREE.ShaderMaterial({ uniforms, depthTest: !!opts.depth, depthWrite: !!opts.depth, depthFunc: THREE.AlwaysDepth,
    vertexShader: 'out vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: frag });
  const mesh = new THREE.Mesh(FSQ, m); mesh.frustumCulled = false; const s = new THREE.Scene(); s.add(mesh); return { scene: s, mat: m };
}
const CAM = new THREE.Camera();

export class Immersive {
  constructor(container, assets) {
    this.el = container; this.assets = assets;
    this.mobile = /iPhone|iPad|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && innerWidth < 900);
    this.q = { mobile: this.mobile, dpr: Math.min(devicePixelRatio, this.mobile ? 2 : 1.5), cloudScale: this.mobile ? 0.34 : 0.5, steps: this.mobile ? 36 : 56 };
    const canvas = document.createElement('canvas'); canvas.className = 'gl'; container.prepend(canvas);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', alpha: false });
    r.setPixelRatio(this.q.dpr); r.autoClear = false; r.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 2.2e6);
    this.camera.rotation.order = 'YXZ';
    this.yaw = 180; this.pitch = 15; this.fov = 70; this.eye = 1.7; this.walk = new THREE.Vector3();
    const U = this.U = {
      uSkyLUT: { value: null }, uExposure: { value: 1 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunE: { value: new THREE.Vector3() }, uMoonE: { value: new THREE.Vector3() }, uAOD: { value: 0.12 }, uTime: { value: 0 }, uNight: { value: 0 },
      uSnow: { value: 0 }, uWet: { value: 0 }, uOvercast: { value: 0 }, uVisKm: { value: 40 }, uFlash: { value: new THREE.Vector4() }, uLogFar: { value: Math.log2(2.2e6 + 1) },
      uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uLitFrac: { value: 0.5 }, uLeafFrac: { value: 1 }, uAutumn: { value: 0 }, uSpring: { value: 0 }, uGreen: { value: 1 }, uLeafOff: { value: 0 }, uCrop: { value: new THREE.Vector4() },
    };
    this.lut = makeSkyLUT(r, U); U.uSkyLUT.value = this.lut.rt.texture;
    this.main = new THREE.Scene(); this.fg = new THREE.Scene();
    this.skyBg = makeSkyBackground(U, milkyWayPhoto()); this.main.add(this.skyBg);
    this.events = new SkyEvents(U); this.main.add(this.events.group);
    makeFaintStars(U).then(p => { this.faintStars = p; this.main.add(p); }).catch(() => { });
    this.stars = makeStars(U, assets.stars); this.main.add(this.stars);
    this.planets = makePlanets(U); this.main.add(this.planets);
    this.moon = makeMoon(U); this.main.add(this.moon);
    this.overlays = new Overlays(container, assets.constLines, assets.stars); this.fg.add(this.overlays.group);
    this.audio = new WxAudio();
    this.precip = new Precip(U, this.mobile); this.fg.add(this.precip.group);
    this.lightning = new Lightning(U, this.audio); this.fg.add(this.lightning.group);
    this.farStorms = new FarStorms(U); this.main.add(this.farStorms.group);
    this.clouds = makeCloudPass(U, assets.noise);
    U.uSteps.value = this.q.steps;
    this.mkTargets();
    this.composite = fsPass(`in vec2 vUv; uniform sampler2D tScene, tCloud, tDepth; uniform vec2 uCloudPx; ${SAFE}
      vec4 cl(vec2 uv){ vec4 c = texture(tCloud, uv); return (c.a >= 0.0 && c.a <= 1.0) ? vec4(safeC(c.rgb), c.a) : vec4(0.0, 0.0, 0.0, 1.0); }
      void main(){
        // soften the upsampled low-res cloud buffer with a small tent filter
        vec4 c = cl(vUv)*0.4 + (cl(vUv + vec2(uCloudPx.x, 0.0)) + cl(vUv - vec2(uCloudPx.x, 0.0)) + cl(vUv + vec2(0.0, uCloudPx.y)) + cl(vUv - vec2(0.0, uCloudPx.y)))*0.15;
        vec3 s = safeC(texture(tScene, vUv).rgb);
        gl_FragColor = vec4(safeC(s*c.a + c.rgb), 1.0); gl_FragDepth = texture(tDepth, vUv).r; }`,
      { tScene: { value: null }, tCloud: { value: null }, tDepth: { value: null }, uCloudPx: { value: new THREE.Vector2() } }, { depth: true });
    // temporal accumulation of the jittered cloud march while the view is still
    this.accum = fsPass(`in vec2 vUv; uniform sampler2D tNew, tOld; uniform float k; ${SAFE}
      vec4 ok(vec4 c){ return (c.a >= 0.0 && c.a <= 1.0) ? vec4(safeC(c.rgb), c.a) : vec4(0.0, 0.0, 0.0, 1.0); }
      void main(){ gl_FragColor = mix(ok(texture(tOld, vUv)), ok(texture(tNew, vUv)), k); }`, { tNew: { value: null }, tOld: { value: null }, k: { value: 1 } });
    this.bright = fsPass(`in vec2 vUv; uniform sampler2D t; ${SAFE} void main(){ vec3 c = safeC(texture(t, vUv).rgb); vec3 b = max(c - 1.5, 0.0); gl_FragColor = vec4(b/(1.0 + dot(b, vec3(0.3))*0.02), 1.0); }`, { t: { value: null } });
    this.blur = fsPass(`in vec2 vUv; uniform sampler2D t; uniform vec2 d; void main(){ vec3 s = texture(t, vUv).rgb*0.227; for (int i = 1; i < 5; i++){ float w = float[5](0.227,0.194,0.121,0.054,0.016)[i]; s += (texture(t, vUv + d*float(i)).rgb + texture(t, vUv - d*float(i)).rgb)*w; } gl_FragColor = vec4(s, 1.0); }`, { t: { value: null }, d: { value: new THREE.Vector2() } });
    this.final = fsPass(`in vec2 vUv; uniform sampler2D t, tB1, tB2; uniform float uScot, uDither; ${SAFE}
      uniform float uCam;
      vec3 tm(vec3 x){ return x*(1.0 + x/9.0)/(1.0 + x); }
      void main(){
        vec2 o1 = 0.6/vec2(textureSize(tB1, 0)), o2 = 0.6/vec2(textureSize(tB2, 0));
        vec3 b1 = (texture(tB1, vUv + o1*vec2(1,1)).rgb + texture(tB1, vUv + o1*vec2(-1,1)).rgb + texture(tB1, vUv + o1*vec2(1,-1)).rgb + texture(tB1, vUv - o1).rgb)*0.25;
        vec3 b2 = (texture(tB2, vUv + o2*vec2(1,1)).rgb + texture(tB2, vUv + o2*vec2(-1,1)).rgb + texture(tB2, vUv + o2*vec2(1,-1)).rgb + texture(tB2, vUv - o2).rgb)*0.25;
        vec3 c = safeC(texture(t, vUv).rgb) + safeC(b1)*0.06 + safeC(b2)*0.05;
        float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(L)*vec3(0.78, 0.92, 1.18), uScot);      // Purkinje shift / rod vision
        c = max(mix(vec3(L), c, 1.0 + 0.45*uCam), 0.0);           // a camera records colour the eye can't see (airglow, aurora, sprites)
        c = tm(max(c, 0.0));
        c = pow(c, vec3(1.0/2.2));
        // triangular dither: two decorrelated noise values hide 8-bit steps in dark gradients
        float n1 = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float n2 = fract(52.9829189*fract(dot(gl_FragCoord.xy + vec2(17.3, 41.7), vec2(0.00583715, 0.06711056))));
        gl_FragColor = vec4(c + (n1 + n2 - 1.0)/255.0*uDither, 1.0);
      }`, { t: { value: null }, tB1: { value: null }, tB2: { value: null }, uScot: { value: 0 }, uDither: { value: 2.0 }, uCam: { value: 0 } });
    this.adaptL = 1; this.ev = 0; this.cameraMode = false; this.running = false; this.clock = new THREE.Clock();
    this.bindControls();
    addEventListener('resize', () => this.resize());
  }
  mkTargets() {
    const r = this.renderer, w = Math.max(2, Math.floor(this.el.clientWidth * this.q.dpr)), h = Math.max(2, Math.floor(this.el.clientHeight * this.q.dpr));
    this.size = [w, h];
    const hf = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    if (this.rtMain) [this.rtMain, this.rtComp, this.rtCloud, this.rtB1, this.rtB1b, this.rtB2, this.rtB2b, ...(this.rtAcc || [])].forEach(t => t.dispose());
    this.rtMain = new THREE.WebGLRenderTarget(w, h, { ...hf, depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType) });
    this.rtMain.depthTexture.format = THREE.DepthFormat; this.rtMain.depthTexture.type = THREE.FloatType;
    this.rtComp = new THREE.WebGLRenderTarget(w, h, { ...hf, depthBuffer: true });
    const cs = this.q.cloudScale;
    this.rtCloud = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w * cs)), Math.max(2, Math.floor(h * cs)), { ...hf, depthBuffer: false });
    this.rtAcc = [0, 1].map(() => new THREE.WebGLRenderTarget(this.rtCloud.width, this.rtCloud.height, { ...hf, depthBuffer: false }));
    this.accN = 0;
    const b = (s) => new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w / s)), Math.max(2, Math.floor(h / s)), { ...hf, depthBuffer: false });
    this.rtB1 = b(4); this.rtB1b = b(4); this.rtB2 = b(16); this.rtB2b = b(16);
  }
  resize() {
    if (!this.running) return;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.mkTargets();
  }

  // ---------- data ----------
  async open(ctx, progress = () => { }) {
    this.ctx = ctx;
    for (const o of [this.groundObj, this.grass, this.cityLights, this.structures && this.structures.group, this.structGlowFg, this.carsFg]) if (o) { (o.group || o).removeFromParent && (o.group || o).removeFromParent(); }
    if (this.structures) { this.structures.dispose(); this.structures = null; }
    const { local, groundZ } = ctx;
    this.ground = new Ground(this.U, local, groundZ, this.q);
    const roadsP = roadMasks(local).catch(() => null);   // in parallel with the terrain
    await this.ground.build(progress);
    ctx.groundZ = this.ground.groundZ;
    this.groundObj = this.ground.group; this.main.add(this.groundObj);
    progress('Placing grass and city lights…');
    this.season = seasonFor(ctx.lat, ctx.time || new Date(), ctx.point);
    this.grass = new Grass(this.U, this.ground, { mobile: this.mobile, season: this.season }); this.main.add(this.grass.mesh);
    this.roadMask = await roadsP;
    this.cityLights = distantLights(this.U, ctx.lights, local, (x, z) => this.ground.heightAt(x, z), 3500, this.mobile, this.roadMask);
    if (this.cityLights) this.fg.add(this.cityLights);
    // ground flux for cloud bases
    if (ctx.lights) {
      const fg = groundFluxGrid(ctx.lights, local, 60, 96);
      const t = new THREE.DataTexture(fg.data, fg.n, fg.n, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.flipY = false; t.needsUpdate = true;
      // grid rows run south->north in latitude; flip to world z (south positive)
      const d = fg.data, n = fg.n, f = new Uint8Array(d.length); for (let j = 0; j < n; j++) f.set(d.subarray(j * n * 4, (j + 1) * n * 4), (n - 1 - j) * n * 4);
      t.image.data = f;
      this.U.uFlux.value = t; this.U.uFluxHalf.value = 60000;
    } else { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; this.U.uFlux.value = t; }
    this.setLP(ctx.lp);
    // Earth-fixed frame for the aurora shell intersections
    const B = enuBasis(ctx.lat, ctx.lon), o = ecef(ctx.lat, ctx.lon, (ctx.groundZ || 0) / 1000), mp = ecef(MAG_POLE.lat, MAG_POLE.lon, -6370);
    this.U.uENU.value.set(B.e[0], B.n[0], B.u[0], B.e[1], B.n[1], B.u[1], B.e[2], B.n[2], B.u[2]);
    this.U.uObsECEF.value.set(...o); this.U.uMagAxis.value.set(...mp).normalize();
    this.magLat = Math.abs(magLat(ctx.lat, ctx.lon));
    this.auroraSrc = null; this.auroraSynth = null;
    Promise.all([loadKp(), loadOvation()]).then(([k, ov]) => { this.kp = k; this.ovation = ov; this.applyAurora(); });
    loadSatellites().then(sv => this.events.setSatellites(sv));
    this.camera.position.set(0, this.ground.heightAt(0, 0) + this.eye, 0);
    this.lastWxKey = null;
    this.setTime(ctx.time || new Date(), true);
    return this;
  }
  setLP(lp) {
    this.lp = lp;
    if (lp) { this.U.uLPSky.value = lpSkyTexture(lp); this.U.uHasLP.value = 1; }
    else { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; this.U.uLPSky.value = t; this.U.uHasLP.value = 0; }
  }
  setStructures(osm, opts) {
    if (this.structures) { this.structures.group.removeFromParent(); if (this.structures.glow) this.structures.glow.removeFromParent(); if (this.structures.carPts) this.structures.carPts.removeFromParent(); this.structures.dispose(); }
    const ctx = this.ctx;
    if (this.farms) { this.farms.group.removeFromParent(); this.farms = null; }
    const farms = new Farms(this.U, ctx.local, this.ground, { detail: opts.detail, mobile: this.mobile }).build(osm.farms || []);
    this.farms = farms; farms.setDate(ctx.lat, this.date, this.season); this.main.add(farms.group);
    // land cover (Overture) plus parks, sports grounds and cemeteries from both maps
    { const c = (osm.overture && osm.overture.cover) || { grass: [], tree: [] }; this.ground.setCover({ ...c, parks: [...(c.parks || []), ...(osm.parks || []).map(p => p.ring)] }); }
    if (this.grass) { this.grass.exclude = (x, z) => farms.isCrop(x, z) || (this.structures && this.structures.onPavement(x, z, 0.6)); this.grass.center = null; }
    const s = new Structures(this.U, ctx.local, this.ground, {
      extraTrees: farms.orchardTrees, canopyTrees: opts.canopyTrees || null, farms,
      detail: opts.detail, mobile: this.mobile, imageryTrees: opts.imageryTrees !== false, estimateLamps: opts.estimateLamps !== false,
      urbanAt: opts.urbanAt || (() => 0), ledShare: opts.ledShare ?? 0.6, coniferShare: opts.coniferShare ?? 0.3,
      windDir: val(ctx.point, 'wind_direction_10m', this.unix) ?? 270, windSpeed: (val(ctx.point, 'wind_speed_10m', this.unix) ?? 15) / 3.6,
    });
    s.build(osm);
    // light glows and traffic go in the foreground pass (never hidden behind clouds)
    if (s.glow) { s.group.remove(s.glow); this.fg.add(s.glow); }
    if (s.carPts) { s.group.remove(s.carPts); this.fg.add(s.carPts); }
    this.main.add(s.group);
    this.structures = s;
    // don't start inside a house or a tree: find the nearest open spot
    this.escape();
    // replace far-light points with a version that skips the structures zone
    if (this.cityLights) { this.cityLights.removeFromParent(); }
    this.cityLights = distantLights(this.U, ctx.lights, ctx.local, (x, z) => this.ground.heightAt(x, z), opts.detail * 2.4, this.mobile, this.roadMask);
    if (this.cityLights) this.fg.add(this.cityLights);
    this.applyTimeDependent();
    s.stats.farms = Object.entries(farms.counts).map(([k, n]) => `${n} ${CROP_NAMES[k] || k}`).join(', ');
    return s.stats;
  }
  clearStructures() {
    if (!this.structures) return;
    this.structures.group.removeFromParent(); this.structures.glow && this.structures.glow.removeFromParent(); this.structures.carPts && this.structures.carPts.removeFromParent();
    this.structures.dispose(); this.structures = null; this.U.uLightMap.value = null;
    if (this.farms) { this.farms.group.removeFromParent(); this.farms = null; if (this.grass) { this.grass.exclude = null; this.grass.center = null; } }
  }
  setFarStorms(list) { this.farStorms.setForecast(null); this.farStorms.set(list || []); }
  setStormForecast(data) { this.farStorms.setForecast(data, this.ctx.lat, this.ctx.lon); this.farStorms.atTime(this.unix); this.updateLabels(); }

  // ---------- time ----------
  setTime(date, force) {
    this.date = date; this.unix = date.getTime() / 1000;
    const { lat, lon, groundZ } = this.ctx, U = this.U;
    const sm = sunMoon(date, lat, lon, groundZ);
    this.sm = sm; this.overlays.sunAlt = sm.sun.alt;
    const sv = altAzToVec(sm.sun.alt, sm.sun.az), mv = altAzToVec(sm.moon.alt, sm.moon.az);
    U.uSunDir.value.set(...sv); U.uMoonDir.value.set(...mv);
    U.uSunE.value.set(1.0, 0.985, 0.95).multiplyScalar(1.27e5);
    const moonLux = Math.pow(10, -0.4 * (sm.moonMag + 13.99));
    U.uMoonE.value.set(1.0, 0.94, 0.86).multiplyScalar(moonLux);
    const AU = 1.496e8, ml = new THREE.Vector3(...sv).multiplyScalar(AU).sub(new THREE.Vector3(...mv).multiplyScalar(sm.moonDistKm)).normalize();
    U.uMoonLight.value.copy(ml);
    U.uMoonRadius.value = Math.atan(1737.4 / sm.moonDistKm);
    U.uMoonLum.value = 2900;
    // sky rotation
    const m = eqjToWorld(date, observer(lat, lon, groundZ));
    U.uEqToWorld.value.set(...m); this.overlays.setEq(m);
    U.uGal.value.set(...EQ2GAL);
    const ce = Math.cos(OBLIQ), se = Math.sin(OBLIQ);
    const E = new THREE.Matrix3().set(1, 0, 0, 0, ce, se, 0, -se, ce);
    U.uEclip.value.copy(E.multiply(new THREE.Matrix3().set(...m).transpose()));
    // planets
    const pl = planetPos(date, lat, lon, groundZ); this.pl = pl;
    const P = this.planets.geometry.attributes.position.array, M = this.planets.geometry.attributes.mag.array;
    pl.forEach((p, i) => { P.set(altAzToVec(p.alt, p.az), i * 3); M[i] = p.mag; });
    this.planets.geometry.attributes.position.needsUpdate = true; this.planets.geometry.attributes.mag.needsUpdate = true;
    U.uObsKm.value = 0.0 + Math.max(0, groundZ) / 1000 * 0;
    this.applyWeather(force);
    this.applyTimeDependent();
    this.applyAurora(); this.dateSetAt = performance.now();
    if (this.farStorms.forecast) this.farStorms.atTime(this.unix);
    this.updateLabels();
  }
  // Auroral oval from the planetary Kp index at this time (observed, or NOAA's 3-day forecast).
  // Brightness everywhere comes from a chance-of-aurora map: NOAA's live OVATION nowcast when viewing within ~2.5 h
  // of it, otherwise a stand-in built from Kp (observed, or NOAA's 3-day forecast) and fitted to OVATION.
  applyAurora() {
    const ms = this.date ? this.date.getTime() : Date.now();
    const kp = kpAt(this.kp, ms) ?? 2;
    this.kpNow = kp;
    let src = this.ovation && Math.abs(ms - this.ovation.t) < 2.5 * 3600e3 ? this.ovation : null;
    if (!src) {
      const key = kp.toFixed(2) + ':' + Math.round(ms / 1800e3);
      if (!this.auroraSynth || this.auroraSynth.key !== key) { this.auroraSynth = synthAurora(kp, ms); this.auroraSynth.key = key; }
      src = this.auroraSynth;
    }
    if (this.auroraSrc !== src) {
      this.auroraSrc = src;
      const t = this.U.uAurP.value;
      const tex = new THREE.DataTexture(src.grid, 360, 181, THREE.RedFormat, THREE.UnsignedByteType);
      tex.wrapS = THREE.RepeatWrapping; tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
      this.U.uAurP.value = tex; if (t && t.dispose) t.dispose();
      this.auroraOval = auroraOval(src.grid, this.ctx.lat, this.ctx.lon);
    }
    const O = this.auroraOval;
    // skip the shader work when nothing within ~2000 km reaches 8 %
    this.U.uAurora.value.set(O.center * DEG, O.spread * DEG, O.near >= 8 ? 1 : 0, kp);
    this.auroraLive = src.live;
  }
  applyTimeDependent() {
    const U = this.U, sunAlt = this.sm.sun.alt;
    U.uNight.value = smooth(-0.5, -5, sunAlt);
    const local = new Date(this.date.getTime() + ((this.ctx.utcOffset || 0) - (-this.date.getTimezoneOffset() * 60)) * 1000);
    const h = local.getHours() + local.getMinutes() / 60;
    const lit = h >= 17 || h < 1 ? 0.55 - Math.max(0, h - 21) * 0.06 : h < 5 ? 0.08 : h < 8 ? 0.3 : 0.15;
    U.uLitFrac.value = lit;
    if (this.structures) this.structures.setTraffic((congestion(local) - 1) * 0.9 + (h > 6 && h < 22 ? 0.45 : 0.08));
  }

  // Weather fields at the current time: cloud layers, textures, precipitation, fog, snow.
  applyWeather(force) {
    const ctx = this.ctx, U = this.U, t = this.unix, gz = ctx.groundZ;
    const pt = ctx.point;
    const L = cloudLayers(pt, t, gz);
    this.layers = L;
    U.uOvercast.value = clamp(Math.max(L.low.cover, L.mid.cover * 0.85, L.storm) * 1.15 - 0.15, 0, 1);
    const rel = z => Math.max(0, z - gz);
    U.uLowBase.value = L.low.fog ? 0 : rel(L.low.base); U.uLowTop.value = rel(L.low.top);
    U.uMidBase.value = rel(L.mid.base); U.uMidTop.value = rel(L.mid.top);
    U.uHighBase.value = rel(L.high.base); U.uHighTop.value = rel(L.high.top); U.uTropo.value = rel(L.tropopause);
    // advection: displace noise with the wind over time so clouds move as you scrub
    const wv = (w, s) => { const a = (w.dir + 180) * DEG; return new THREE.Vector2(-Math.sin(a) * w.speed * s, Math.cos(a) * w.speed * s); };
    const secs = t - 1.7e9;
    U.uWindLow.value.copy(wv(L.windLow, secs % 2e5)); U.uWindMid.value.copy(wv(L.windMid, secs % 2e5)); U.uWindHigh.value.copy(wv(L.windHigh, secs % 2e5));
    const ha = (L.windHigh.dir + 180) * DEG; U.uCirrusDir.value.set(Math.sin(ha), -Math.cos(ha)).normalize();
    // precipitation and visibility
    const ps = precipState(pt, t); this.precipNow = ps;
    const lw = wv(L.windLow, 1);
    this.precip.set(ps.type, ps.rate, [lw.x * 0.3, lw.y * 0.3]);
    U.uPrecipSnow.value = ps.type === 'snow' ? 1 : 0;
    const vis = val(pt, 'visibility', t), fog = fogRisk(pt, t);
    let visKm = vis != null ? vis / 1000 : 35; if (fog > 0.6) visKm = Math.min(visKm, 0.6);
    if (ps.type !== 'none') visKm = Math.min(visKm, ps.type === 'snow' ? 2 / Math.max(0.2, ps.rate) : 12 / Math.max(0.3, ps.rate));
    U.uVisKm.value = clamp(visKm, 0.15, 80);
    const aod = ctx.aq ? ctx.aq.aod[Math.max(0, ctx.aq.t.findIndex(x => x >= t))] : null; U.uAOD.value = clamp(aod ?? 0.12, 0.03, 1.2);
    const sd = val(pt, 'snow_depth', t) ?? 0; U.uSnow.value = clamp(sd / 0.06, 0, 1);
    this.snowDepth = sd;
    // wet if rain in the last 3 hours
    let wet = 0; for (let k = 0; k <= 3; k++) { const pr = val(pt, 'precipitation', t - k * 3600) ?? 0; if (pr > 0.1) wet = Math.max(wet, 1 - k / 4); }
    U.uWet.value = (val(pt, 'temperature_2m', t) ?? 5) > 0 ? wet : 0;
    U.uFluxSnow.value = 1 + 1.6 * U.uSnow.value;
    U.uGroundAlb.value = 0.12 + 0.6 * U.uSnow.value;
    this.season = seasonFor(ctx.lat, this.date, pt);
    Object.assign(this.season, { leafFrac: this.season.leafFrac });
    U.uLeafFrac.value = this.season.leafFrac; U.uAutumn.value = this.season.autumn; U.uSpring.value = this.season.spring; U.uGreen.value = this.season.green;
    U.uLeafOff.value = this.season.leafFrac < 0.3 ? 1 : 0;
    if (this.grass) { if (this.grass.season && Math.abs(this.grass.season.green - this.season.green) > 0.05) this.grass.center = null; this.grass.season = this.season; }
    if (this.farms) this.farms.setDate(ctx.lat, this.date, this.season);
    // rebuild cloud textures at most every 10 minutes of forecast time
    const key = Math.round(t / 600);
    if (force || key !== this.lastWxKey) { this.lastWxKey = key; this.buildCloudTextures(t); }
    // lightning
    const cells = this.stormCells || [];
    const rate = cells.reduce((s, c) => s + c.strength, 0) * 4 + (ps.thunder ? 4 : 0);
    if (ps.thunder && !cells.length) cells.push({ x: 4000, z: -3000, strength: 1, base: U.uLowBase.value });
    this.lightning.setStorms(cells, rate);
  }
  buildCloudTextures(t) {
    const ctx = this.ctx, grid = ctx.grid, half = 120000, N = 160;
    const satW = ctx.sat ? Math.exp(-Math.abs(t * 1000 - ctx.sat.obs) / (2.5 * 3600e3)) * (Math.abs(t * 1000 - ctx.sat.obs) < 7 * 3600e3 ? 1 : 0) : 0;
    const L = this.layers;
    // per grid point classification at this time
    const per = grid ? grid.series.map(S => {
      if (!S) return null;
      const g = k => val(S, k, t) ?? 0;
      const cape = g('cape'), li = val(S, 'lifted_index', t) ?? 3, pr = g('precipitation'), sh = g('showers'), code = g('weather_code');
      const conv = clamp((cape - 150) / 1200, 0, 1) * clamp((1 - li) / 5, 0, 1);
      const storm = Math.max(code >= 95 ? 0.8 : 0, clamp((cape - 700) / 2000, 0, 1) * clamp((pr + sh - 0.8) / 5, 0, 1));
      const T = g('temperature_2m'), Td = val(S, 'dew_point_2m', t) ?? T - 5;
      return { low: g('cloud_cover_low') / 100, mid: g('cloud_cover_mid') / 100, high: g('cloud_cover_high') / 100, cu: clamp(0.25 + conv - (g('cloud_cover_low') > 85 ? 0.35 : 0), 0, 1), storm, precip: clamp(pr / 4, 0, 1), lcl: clamp(125 * (T - Td), 100, 3000) };
    }) : null;
    const n = grid ? grid.n : 0;
    const gridAt = (x, z) => {
      if (!per) return { low: L.low.cover, mid: L.mid.cover, high: L.high.cover, cu: L.low.cumuliform, storm: L.storm, precip: clamp(L.precip / 4, 0, 1) };
      const fx = clamp((x / grid.half + 1) / 2 * (n - 1), 0, n - 1.001), fy = clamp((-z / grid.half + 1) / 2 * (n - 1), 0, n - 1.001);
      const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const P = (a, b) => per[b * n + a] || per[Math.floor(n * n / 2)];
      const a = P(i, j), b = P(i + 1, j), c = P(i, j + 1), d = P(i + 1, j + 1);
      const o = {}; for (const k of ['low', 'mid', 'high', 'cu', 'storm', 'precip']) o[k] = (a[k] * (1 - u) + b[k] * u) * (1 - v) + (c[k] * (1 - u) + d[k] * u) * v;
      return o;
    };
    const sat = ctx.sat, sn = sat ? sat.grid.n : 0;
    const satAt = (x, z) => {
      if (!sat || satW <= 0.02) return null;
      const fx = (x / sat.half + 1) / 2 * (sn - 1), fy = (-z / sat.half + 1) / 2 * (sn - 1);
      const i = Math.round(fx), j = Math.round(fy); if (i < 0 || j < 0 || i >= sn || j >= sn) return null;
      const k = j * sn + i; if (sat.grid.frac[k] < 0) return null; return { f: sat.grid.frac[k], top: sat.grid.top[k] - ctx.groundZ };
    };
    const cells = [];
    const lowThick = Math.max(300, (L.low.top - L.low.base));
    const [t1, t2] = weatherTextures(N, half, (x, z) => {
      const g = gridAt(x, z);
      let { low, mid, high, storm } = g;
      const s = satAt(x, z);
      if (s) {
        // observed cloud field: clear where the satellite sees ground, cloud at the measured top height
        if (s.f < 0.15) { const k = 1 - satW * 0.85; low *= k; mid *= k; high *= k; storm *= k; }
        else {
          const w = satW * s.f;
          if (s.top < 2800) low = lerp(low, Math.max(low, s.f), w);
          else if (s.top < 6500) mid = lerp(mid, Math.max(mid, s.f), w);
          else { high = lerp(high, Math.max(high, s.f), w); if (s.top > 9500 && g.storm > 0.1) storm = Math.max(storm, w); }
        }
      }
      const stormTop = Math.max(L.tropopause - ctx.groundZ, 9000) * (0.85 + 0.15 * storm);
      return { low, mid, high, storm, cumuliform: g.cu, precip: g.precip, lowThick: lowThick * (0.7 + 0.6 * g.cu) + storm * 0, stormTop };
    });
    for (const old of [this.U.uWx1.value, this.U.uWx2.value]) if (old) old.dispose();
    this.U.uWx1.value = t1; this.U.uWx2.value = t2;
    // storm cells for lightning (coarse scan)
    for (let x = -half; x <= half; x += 15000) for (let z = -half; z <= half; z += 15000) { const g = gridAt(x, z); if (g.storm > 0.25) cells.push({ x, z, strength: g.storm, base: this.U.uLowBase.value }); }
    this.stormCells = cells;
  }

  // ---------- exposure ----------
  adaptation() {
    const sunAlt = this.sm.sun.alt, moonAlt = this.sm.moon.alt, U = this.U;
    let La = sunAlt > 0 ? 300 + 6000 * Math.pow(Math.sin(sunAlt * DEG), 0.8) : 300 * Math.pow(10, sunAlt * 0.33);
    if (moonAlt > 0) La += 2.6e-3 * Math.pow(this.sm.moonFrac, 1.5) * Math.pow(Math.sin(moonAlt * DEG), 0.5);
    const cover = this.layers ? clamp(Math.max(this.layers.low.cover, this.layers.mid.cover * 0.8, this.layers.storm), 0, 1) : 0;
    const lpZ = this.lp ? this.lp.zenith : 0;
    const lpCloud = this.lp ? (this.lp.cloud[this.lp.alts.length - 1] || lpZ) : 0;
    La += lpZ * (1 - cover) + lpCloud * cover * 0.5 + NAT_SKY * (1 - 0.6 * cover);
    if (sunAlt > 0) La *= 1 - 0.5 * cover;
    return La;
  }

  // ---------- controls ----------
  bindControls() {
    const el = this.el; let drag = null; const pts = new Map(); let pinch0 = 0, fov0 = 70;
    el.addEventListener('pointerdown', e => { if (e.target.closest('.hud')) return; el.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, t: performance.now(), moved: false }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); fov0 = this.fov; } });
    el.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); this.fov = clamp(fov0 * pinch0 / d, 3, 110); drag = null; return; }
      if (!drag || this.gyro) return;
      const k = this.fov / el.clientHeight;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      this.yaw = (drag.yaw - (e.clientX - drag.x) * k + 360) % 360; this.pitch = clamp(drag.pitch + (e.clientY - drag.y) * k, -89, 89);
    });
    const up = e => { if (drag && !drag.moved && performance.now() - drag.t < 400 && this.onPick) this.onPick(this.pick(e.clientX, e.clientY)); pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; drag = null; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { e.preventDefault(); this.fov = clamp(this.fov * Math.exp(e.deltaY * 0.001), 3, 110); }, { passive: false });
    this.keys = new Set();
    addEventListener('keydown', e => { if (!this.running || e.target.tagName === 'INPUT') return; this.keys.add(e.key.toLowerCase()); });
    addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
  }
  async enableGyro(on) {
    if (!this.gyroHandler) this.gyroHandler = e => {
      if (!this.gyro || e.beta == null) return;
      const heading = e.webkitCompassHeading != null ? e.webkitCompassHeading : (360 - (e.alpha || 0));
      const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      let pitch = e.beta - 90, yaw = heading;
      if (so === 90 || so === -90 || so === 270) { pitch = 90 - Math.abs(e.gamma); yaw = heading + (so === 90 ? 90 : -90); }
      this.yaw = (yaw + 360) % 360; this.pitch = clamp(pitch, -89, 89);
    };
    if (on) {
      try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return false; } } catch { return false; }
      if (!this.gyroListening) { addEventListener('deviceorientation', this.gyroHandler); this.gyroListening = true; }
      this.gyro = true; return true;
    }
    this.gyro = false;
    if (this.gyroListening) { removeEventListener('deviceorientation', this.gyroHandler); this.gyroListening = false; }
    return false;
  }
  pick(cx, cy) {
    const r = this.el.getBoundingClientRect();
    const v = new THREE.Vector3((cx - r.left) / r.width * 2 - 1, -(cy - r.top) / r.height * 2 + 1, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const aa = vecToAltAz(v.x, v.y, v.z);
    let best = null, bd = 2.5 * this.fov / 70;
    const consider = (name, x, y, z, mag, extra) => { const d = Math.acos(clamp(v.x * x + v.y * y + v.z * z, -1, 1)) / DEG; if (d < bd) { bd = d; best = { name, mag, ...vecToAltAz(x, y, z), ...extra }; } };
    const sd = this.assets.stars.s, m = this.U.uEqToWorld.value.elements; // column-major
    for (let i = 0; i < sd.length; i += 4) {
      if (sd[i + 2] > 4.5 && this.fov > 30) continue;
      const ra = sd[i] * DEG, de = sd[i + 1] * DEG, e = [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)];
      const x = m[0] * e[0] + m[3] * e[1] + m[6] * e[2], y = m[1] * e[0] + m[4] * e[1] + m[7] * e[2], z = m[2] * e[0] + m[5] * e[1] + m[8] * e[2];
      consider(this.assets.stars.n[i / 4] || `Star (mag ${sd[i + 2].toFixed(1)})`, x, y, z, sd[i + 2], { kind: 'star', bv: sd[i + 3] });
    }
    for (const p of this.pl) { const q = altAzToVec(p.alt, p.az); bd = Math.min(bd + 0.6, 4); consider(p.name, ...q, p.mag, { kind: 'planet' }); }
    for (const st of this.events.visibleSats || []) { const q = altAzToVec(st.alt, st.az); consider(`${st.name} (satellite, sunlit, ${Math.round(st.range)} km away)`, ...q, st.mag, { kind: 'satellite' }); }
    const mv = this.U.uMoonDir.value; consider(`Moon — ${phaseName(this.sm.phase)}, ${(this.sm.moonFrac * 100).toFixed(0)}% lit`, mv.x, mv.y, mv.z, this.sm.moonMag, { kind: 'moon' });
    const sv = this.U.uSunDir.value; consider('Sun', sv.x, sv.y, sv.z, -26.7, { kind: 'sun' });
    // sky brightness in that direction
    let sqm = null;
    if (this.lp && aa.alt > 0) {
      const lp = this.lp, ia = Math.round(aa.az / 360 * lp.nAz) % lp.nAz; let k = 0; while (k < lp.alts.length - 1 && lp.alts[k + 1] < aa.alt) k++;
      sqm = lum2mag(lp.clear[ia * lp.alts.length + k] + NAT_SKY * (1 / Math.sqrt(1 - 0.96 * Math.cos(aa.alt * DEG) ** 2)) * 0.8);
    }
    return { alt: aa.alt, az: aa.az, object: best, sqm };
  }

  // ---------- frame ----------
  start() {
    if (this.running) return; this.running = true; this.resize();
    if (!this.fovSet && this.el.clientWidth < this.el.clientHeight) { this.fov = 88; } this.fovSet = true;
    const loop = () => { if (!this.running) return; this.raf = requestAnimationFrame(loop); this.frame(); };
    loop();
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); this.audio.disable(); }
  frame() {
    // keep the render buffers the exact shape of the screen: on iPhones the app's height changes without a resize
    // event (keyboard, toolbar, rotation), and a mismatched buffer turns every star into an oval
    if (this.size && (Math.max(2, Math.floor(this.el.clientWidth * this.q.dpr)) !== this.size[0] || Math.max(2, Math.floor(this.el.clientHeight * this.q.dpr)) !== this.size[1])) this.resize();
    const dt = Math.min(0.1, this.clock.getDelta()), U = this.U, cam = this.camera;
    const now = performance.now() / 1000; U.uTime.value = now;
    // movement
    if (this.keys.size) {
      const sp = (this.keys.has('shift') ? 25 : 5) * dt, a = this.yaw * DEG;
      const f = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)), r = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      let mx = 0, mz = 0;
      if (this.keys.has('w')) { mx += f.x * sp; mz += f.z * sp; } if (this.keys.has('s')) { mx -= f.x * sp; mz -= f.z * sp; }
      if (this.keys.has('d')) { mx += r.x * sp; mz += r.z * sp; } if (this.keys.has('a')) { mx -= r.x * sp; mz -= r.z * sp; }
      if (mx || mz) this.move(mx, mz);
      if (this.keys.has('arrowleft')) this.yaw = (this.yaw - 60 * dt + 360) % 360; if (this.keys.has('arrowright')) this.yaw = (this.yaw + 60 * dt) % 360;
      if (this.keys.has('arrowup')) this.pitch = Math.min(89, this.pitch + 40 * dt); if (this.keys.has('arrowdown')) this.pitch = Math.max(-89, this.pitch - 40 * dt);
    }
    if (this.joy && (this.joy.f || this.joy.r)) {
      const a = this.yaw * DEG, sp = (this.joy.run ? 18 : 4.5) * dt;
      this.move((Math.sin(a) * this.joy.f + Math.cos(a) * this.joy.r) * sp, (-Math.cos(a) * this.joy.f + Math.sin(a) * this.joy.r) * sp);
    }
    if (this.ground && this.ground.heightAt) { const gy = this.ground.heightAt(this.walk.x, this.walk.z); cam.position.set(this.walk.x, gy + this.eye, this.walk.z); }
    cam.fov = this.fov; cam.aspect = this.el.clientWidth / Math.max(1, this.el.clientHeight); cam.updateProjectionMatrix();
    cam.rotation.set(this.pitch * DEG, -this.yaw * DEG, 0);
    cam.updateMatrixWorld();
    // exposure (eye adaptation in log space)
    let La = this.adaptation();
    // daytime and twilight: measure the rendered sky (log-average of the sky LUT) instead of a formula
    if (this.sm.sun.alt > -8) {
      if (!this.lutBuf || (this.frameN = (this.frameN || 0) + 1) % 15 === 0) this.measureSky();
      if (this.skyLa) { const cover = this.layers ? clamp(Math.max(this.layers.low.cover, this.layers.mid.cover * 0.8, this.layers.storm), 0, 1) : 0; La = lerp(La, this.skyLa * (1 - 0.8 * cover), smooth(-8, -2, this.sm.sun.alt)); }
    }
    this.adaptL = Math.exp(lerp(Math.log(this.adaptL), Math.log(La), 1 - Math.exp(-dt * 3)));
    const night = this.sm.sun.alt < -4;
    let E = 0.0922 / Math.pow(this.adaptL, 0.72) * Math.pow(2, this.ev);
    E *= lerp(1, 0.4, smooth(0, -3.3, Math.log10(this.adaptL)));   // night scenes read darker to the eye
    if (this.cameraMode && night) E *= 10;
    U.uExposure.value = E;
    this.final.mat.uniforms.uScot.value = this.cameraMode ? 0 : smooth(0.004, 0.0002, this.adaptL) * 0.6;
    this.final.mat.uniforms.uCam.value = this.cameraMode && night ? 1 : 0;
    // pixel solid angle for point sources
    const pxRad = (cam.fov * DEG) / (this.el.clientHeight * this.q.dpr);
    U.uPxSr.value = pxRad * pxRad; U.uPxScale.value = this.q.dpr;
    U.uZoomGain.value = clamp(2.2 * Math.log10(70 / cam.fov), 0, 2.5);   // zooming in acts like binoculars
    {
      const sqm = lum2mag(Math.max(this.adaptL, 1e-5)), lim = 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1);
      const simDate = new Date(this.date.getTime() + (performance.now() - (this.dateSetAt || performance.now())));   // satellites keep moving in real time
      U.uAGT.value = (simDate.getTime() / 1000) % 864000;   // airglow waves drift with the clock and the time slider
      const m = this.U.uEqToWorld.value.elements, rm = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
      this.events.update(now, simDate, this.ctx, rm, lim, this.sm.sun.alt);
    }
    U.uInvProjView.value.copy(cam.projectionMatrixInverse).premultiply(cam.matrixWorld);
    U.uCamPos.value.copy(cam.position); U.uCamFwd.value.set(0, 0, -1).applyQuaternion(cam.quaternion);
    U.uFrame.value++;
    // updates
    if (this.grass) this.grass.update(cam);
    if (this.farms) this.farms.update(cam);
    if (this.structures) this.structures.update(now);
    this.lightning.update(dt, now, cam.position, (x, z) => this.ground.heightAt(x, z));
    this.farStorms.update(now, U.uSpriteMode.value > 0.5, this.sm.sun.alt < -12);
    this.audio.rain(this.precipNow && this.precipNow.type === 'rain' ? Math.min(1, this.precipNow.rate / 4) : 0);
    this.overlays.update(cam, this.el.clientWidth, this.el.clientHeight);
    // passes
    const r = this.renderer;
    this.lut.render(); this.lutExposure = U.uExposure.value;
    r.setRenderTarget(this.rtMain); r.clear(); r.render(this.main, cam);
    U.uDepth.value = this.rtMain.depthTexture;
    r.setRenderTarget(this.rtCloud); r.clear(); r.render(this.clouds.scene, CAM);
    // Accumulate jittered cloud frames. Small view changes (hand shake, phone sensors) keep part of the history;
    // big turns, moves or a new time start over.
    const A = this.accLast || {}, dAng = Math.abs(((this.yaw - (A.yaw ?? 1e9)) + 540) % 360 - 180) + Math.abs(this.pitch - (A.pitch ?? 0)) + Math.abs(this.fov - (A.fov ?? 0)) * 0.5;
    const dPos = A.pos ? cam.position.distanceTo(A.pos) : 1e9;
    if (dAng > 4 || dPos > 3 || this.unix !== A.unix) this.accN = 0;
    else if (dAng > 0.02 || dPos > 0.05) this.accN = Math.min(this.accN, 3);
    this.accLast = { yaw: this.yaw, pitch: this.pitch, fov: this.fov, pos: cam.position.clone(), unix: this.unix };
    this.accN = Math.min(this.accN + 1, 16);
    const au = this.accum.mat.uniforms, src = this.rtAcc[this.accI = 1 - (this.accI || 0)], dst = this.rtAcc[1 - this.accI];
    au.tNew.value = this.rtCloud.texture; au.tOld.value = src.texture; au.k.value = 1 / this.accN;
    r.setRenderTarget(dst); r.render(this.accum.scene, CAM);
    const cu = this.composite.mat.uniforms; cu.tScene.value = this.rtMain.texture; cu.tCloud.value = dst.texture; cu.tDepth.value = this.rtMain.depthTexture; cu.uCloudPx.value.set(0.7 / dst.width, 0.7 / dst.height);
    r.setRenderTarget(this.rtComp); r.clear(); r.render(this.composite.scene, CAM);
    r.render(this.fg, cam);
    // bloom
    this.bright.mat.uniforms.t.value = this.rtComp.texture; r.setRenderTarget(this.rtB1); r.render(this.bright.scene, CAM);
    const bl = (src, dst, dx, dy) => { this.blur.mat.uniforms.t.value = src.texture; this.blur.mat.uniforms.d.value.set(dx / src.width, dy / src.height); r.setRenderTarget(dst); r.render(this.blur.scene, CAM); };
    bl(this.rtB1, this.rtB1b, 1, 0); bl(this.rtB1b, this.rtB1, 0, 1);
    bl(this.rtB1, this.rtB2, 2, 0); bl(this.rtB2, this.rtB2b, 0, 2); bl(this.rtB2b, this.rtB2, 2, 0); bl(this.rtB2, this.rtB2b, 0, 2);
    const fu = this.final.mat.uniforms; fu.t.value = this.rtComp.texture; fu.tB1.value = this.rtB1.texture; fu.tB2.value = this.rtB2b.texture;
    r.setRenderTarget(null); r.clear(); r.render(this.final.scene, CAM);
    // frame time tracking for adaptive quality
    this.ft = lerp(this.ft || dt, dt, 0.05);
    if (this.onFrame) this.onFrame();
  }
  // move the viewer out of anything solid (buildings, trees, poles), nearest free spot first
  escape() {
    const s = this.structures; if (!s || !s.blocked) return;
    const gy = this.ground.heightAt(this.walk.x, this.walk.z), y = gy + this.eye;
    if (!s.blocked(this.walk.x, this.walk.z, y, 0.6)) return;
    for (let r = 2; r < 200; r += 2) for (let a = 0; a < 360; a += 15) {
      const x = this.walk.x + r * Math.cos(a * DEG), z = this.walk.z + r * Math.sin(a * DEG);
      if (!s.blocked(x, z, this.ground.heightAt(x, z) + this.eye, 0.8)) { this.walk.set(x, 0, z); return; }
    }
  }
  // walk with simple collision: slide along walls instead of passing through
  move(dx, dz) {
    const s = this.structures, w = this.walk;
    const ok = (x, z) => !s || !s.blocked || !s.blocked(x, z, this.ground.heightAt(x, z) + this.eye);
    if (ok(w.x + dx, w.z + dz)) { w.x += dx; w.z += dz; }
    else if (ok(w.x + dx, w.z)) w.x += dx;
    else if (ok(w.x, w.z + dz)) w.z += dz;
  }
  measureSky() {
    const rt = this.lut.rt, W = rt.width, H = rt.height;
    if (!this.lutBuf) this.lutBuf = new Uint16Array(W * H * 4);
    try { this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, this.lutBuf); } catch { return; }
    const E = this.lutExposure || this.U.uExposure.value, b = this.lutBuf, h2f = THREE.DataUtils.fromHalfFloat;
    let s = 0, n = 0;
    // rows from ~3 deg to ~60 deg altitude (v = 0.5 + 0.5*sqrt(h/90))
    for (let j = Math.floor(H * 0.6); j < Math.floor(H * 0.92); j += 3) for (let i = 0; i < W; i += 8) {
      const k = (j * W + i) * 4, L = (0.2126 * h2f(b[k]) + 0.7152 * h2f(b[k + 1]) + 0.0722 * h2f(b[k + 2])) / E;
      if (L > 0) { s += Math.log(L); n++; }
    }
    if (n) this.skyLa = Math.exp(s / n) * 1.6;
  }
  updateLabels() {
    const d = [];
    for (const p of this.pl || []) if (p.alt > -1) d.push({ t: p.name, alt: p.alt + 0.8, az: p.az, cls: 'planet' });
    if (this.kpNow != null && this.U.uAurora.value.z > 0 && this.sm.sun.alt < -10) d.push({ t: `Aurora: up to ${this.auroraOval ? this.auroraOval.near : 0}% chance nearby (${this.auroraLive ? 'NOAA OVATION now' : `Kp ${this.kpNow.toFixed(1)}${this.date && this.date.getTime() > Date.now() + 1800e3 ? ' forecast' : ''}`})`, alt: 8, az: (this.ctx.lat >= 0 ? 0 : 180), cls: 'dome', always: false });
    if (this.sm.moon.alt > -1) d.push({ t: 'Moon', alt: this.sm.moon.alt + 1.2, az: this.sm.moon.az, cls: 'planet' });
    if (this.sm.sun.alt > -1) d.push({ t: 'Sun', alt: this.sm.sun.alt + 1.2, az: this.sm.sun.az, cls: 'planet sun' });
    for (const dm of this.ctx.domes || []) d.push({ t: `${dm.name || 'Light dome'} glow`, alt: 3 + dm.strength * 4, az: dm.az, cls: 'dome', dome: true });
    const storms = this.farStorms.forecast ? this.farStorms.storms : (this.ctx.sprites || []);
    for (const s of storms) d.push({ t: `⚡ Storm ${Math.round(s.distKm)} km — sprites ~${(s.spriteAlt ?? 10).toFixed(0)}° up`, alt: Math.max(2, (s.spriteAlt ?? 10) * 0.7), az: s.az, cls: 'storm', always: true });
    // Milky Way core
    const m = this.U.uEqToWorld.value.elements, ra = 266.4 * DEG, de = -28.9 * DEG, e = [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)];
    const x = m[0] * e[0] + m[3] * e[1] + m[6] * e[2], y = m[1] * e[0] + m[4] * e[1] + m[7] * e[2], z = m[2] * e[0] + m[5] * e[1] + m[8] * e[2];
    if (y > 0 && this.sm.sun.alt < -10) d.push({ t: 'Galactic core', vec: [x, y, z], cls: 'mw' });
    this.overlays.setDynamic(d);
  }
}

function inPoly(x, z, p) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if (((p[i][1] > z) !== (p[j][1] > z)) && (x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c; } return c; }

// Season from latitude, date and temperature (temperate deciduous cycle; tropics evergreen).
export function seasonFor(lat, date, point) {
  const doy = (date - new Date(Date.UTC(date.getUTCFullYear(), 0, 1))) / 864e5;
  const d = lat < 0 ? (doy + 182.5) % 365 : doy;     // southern hemisphere: shift by half a year
  const a = Math.abs(lat);
  const T = point ? (val(point, 'temperature_2m', date.getTime() / 1000) ?? 10) : 10;
  if (a < 23) return { leafFrac: 1, autumn: 0, spring: 0, green: 1, leafOff: 0, d, zone: 'tropical' };
  // leaf-out later and leaf-fall earlier further from the equator
  const shift = (a - 40) * 1.6;
  const outA = 100 + shift, outB = 140 + shift, colA = 262 - shift * 0.8, colB = 295 - shift * 0.8, dropA = 288 - shift * 0.8, dropB = 318 - shift * 0.8;
  const r = (x, a0, b0) => clamp((x - a0) / (b0 - a0), 0, 1);
  const leafFrac = a < 30 ? 1 : r(d, outA, outB) * (1 - r(d, dropA, dropB));
  const autumn = a < 30 ? 0 : r(d, colA, colB) * (1 - r(d, dropB, dropB + 20));
  const spring = a < 30 ? 0 : r(d, outA - 10, outA + 10) * (1 - r(d, outB + 5, outB + 35));
  const green = a < 30 ? 0.9 : clamp(r(d, outA - 15, outB) * (1 - 0.65 * r(d, colA, dropB)) * (T > 3 ? 1 : 0.7), 0.12, 1);
  return { leafFrac, autumn, spring, green, leafOff: leafFrac < 0.3 ? 1 : 0, d, zone: a > 58 ? 'boreal' : 'temperate' };
}
