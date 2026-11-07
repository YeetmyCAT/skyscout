// Physically based sky: single + approximate multiple scattering for Sun and Moon (Rayleigh, Mie, ozone, Earth's
// shadow), artificial skyglow from the light-pollution model, airglow, zodiacal light; then stars, planets, Milky Way, Moon.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON } from './glsl.js';

const FSQ = new THREE.BufferGeometry();
FSQ.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

export function makeSkyLUT(renderer, U) {
  const rt = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false });
  rt.texture.wrapS = THREE.RepeatWrapping;
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      #define PI 3.14159265
      in vec2 vUv;
      uniform vec3 uSunDir, uMoonDir, uSunE, uMoonE;
      uniform float uAOD, uObsKm, uExposure, uNatSky, uLPScale, uTime;
      uniform sampler2D uLPSky; uniform float uHasLP;
      uniform float uAGT;   // simulated time for airglow motion (s, wrapped)
      float agHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(agHash(i), agHash(i+vec2(1,0)), f.x), mix(agHash(i+vec2(0,1)), agHash(i+vec2(1,1)), f.x), f.y); }
      float fbm3(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s/0.875; }
      uniform mat3 uEclip; // world -> ecliptic frame (for zodiacal light)
      const float Rg = 6360.0, Rt = 6460.0;
      const vec3 bR = vec3(5.802e-3, 13.558e-3, 33.1e-3);
      const vec3 bO = vec3(0.650e-3, 1.881e-3, 0.085e-3);
      vec2 rs(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r*r, d = b*b - c; if (d < 0.0) return vec2(-1.0); d = sqrt(d); return vec2(-b-d, -b+d); }
      vec3 dens(float h){ return vec3(exp(-h/8.0), exp(-h/1.2), max(0.0, 1.0 - abs(h-25.0)/15.0)); }
      vec3 ext(vec3 d){ float bM = uAOD/1.2; return bR*d.x + vec3(bM*1.11)*d.y + bO*d.z; }
      // transmittance from p toward the light; 0 inside Earth's shadow (soft edge)
      vec3 lightT(vec3 p, vec3 l){
        float g = rs(p, l, Rg).x;
        float r = length(p), mu = dot(p, l)/r;
        // soft shadow: how far the ray grazes below the ground
        float grazing = r*sqrt(max(0.0, 1.0 - mu*mu)) - Rg;
        float vis = mu > 0.0 ? 1.0 : smoothstep(-0.5, 2.0, grazing);
        if (vis <= 0.0) return vec3(0.0);
        float t1 = rs(p, l, Rt).y; vec3 od = vec3(0.0); float dt = t1/8.0;
        for (int i = 0; i < 8; i++){ vec3 q = p + l*dt*(float(i)+0.5); od += dens(length(q)-Rg)*dt; }
        return exp(-ext(od))*vis;
      }
      float pR(float c){ return 3.0/(16.0*PI)*(1.0+c*c); }
      float pM(float c){ float g = 0.76; return 3.0/(8.0*PI)*((1.0-g*g)*(1.0+c*c))/((2.0+g*g)*pow(1.0+g*g-2.0*g*c, 1.5)); }
      vec3 lpSky(vec3 d){
        float az = atan(d.x, -d.z); if (az < 0.0) az += 2.0*PI;
        float h = max(asin(clamp(d.y,-1.0,1.0)), 0.0);
        vec2 e = texture(uLPSky, vec2(az/(2.0*PI), sqrt(h/(0.5*PI)))).rg;
        return pow(vec3(10.0), vec3(e.r*7.0 - 8.0)) * uHasLP;
      }
      void main(){
        float az = vUv.x*2.0*PI; float s = vUv.y*2.0 - 1.0; float h = max(sign(s)*s*s*0.5*PI, 0.004);
        vec3 rd = vec3(cos(h)*sin(az), sin(h), -cos(h)*cos(az));
        vec3 ro = vec3(0.0, Rg + uObsKm, 0.0);
        vec2 top = rs(ro, rd, Rt); vec2 gr = rs(ro, rd, Rg);
        float tMax = top.y; bool ground = gr.x > 0.0; if (ground) tMax = gr.x;
        tMax = min(tMax, 600.0);
        vec3 L = vec3(0.0), T = vec3(1.0);
        float cs = dot(rd, uSunDir), cm = dot(rd, uMoonDir);
        float bM = uAOD/1.2;
        const int N = 28;
        float prev = 0.0;
        for (int i = 1; i <= N; i++){
          float t = tMax * pow(float(i)/float(N), 2.0);
          float dt = t - prev; float tm = (t + prev)*0.5; prev = t;
          vec3 p = ro + rd*tm; float hh = length(p) - Rg;
          vec3 d = dens(hh);
          vec3 sR = bR*d.x, sM = vec3(bM*d.y);
          vec3 Ts = lightT(p, uSunDir), Tm = lightT(p, uMoonDir);
          vec3 S = (sR*pR(cs) + sM*pM(cs))*Ts*uSunE + (sR*pR(cm) + sM*pM(cm))*Tm*uMoonE;
          // cheap multiple scattering: isotropic, from the light that reaches this point and the lit sky above it
          S += (sR + sM) * (Ts*uSunE + Tm*uMoonE) * 0.11 / (4.0*PI);
          vec3 stepT = exp(-ext(d)*dt);
          L += T * S * (1.0 - stepT) / max(ext(d), vec3(1e-7));
          T *= stepT;
        }
        // Natural night sky: airglow (van Rhijn brightening toward the horizon), zodiacal light, diffuse starlight
        float hp = max(h, 0.0);
        float vr = 1.0/sqrt(1.0 - 0.96*cos(hp)*cos(hp));
        float X = 1.0/(sin(hp) + 0.025*exp(-11.0*sin(hp)));
        float extn = exp(-0.25*min(X, 30.0));
        // Airglow: green 557.7 nm layer (~95 km) with slow gravity-wave banding, a weak red 630 nm layer above it.
        // Structure lives on the 95 km layer itself: find where this line of sight crosses it (km east/north of us),
        // then lay gravity waves on that patch of sky. Seen from below, distant wave crests crowd into bands that
        // converge toward the horizon, like long-exposure photos show. Waves drift at 30-80 m/s and slowly evolve.
        float azr = atan(rd.x, -rd.z);
        float dGround = 6371.0*(acos(clamp(6371.0*cos(hp)/6466.0, -1.0, 1.0)) - hp);   // km along the ground
        vec2 P = dGround*vec2(sin(azr), cos(azr));
        float t = uAGT;
        // main wave field: its direction wanders over ~800 km, crests wiggle, and it comes in patches
        vec2 u = vec2(sin(azr), cos(azr));
        float Lp = min(8.0/max(tan(hp), 0.02), 400.0);   // path through the ~8 km thick layer: low views blur crests that face us
        float th = 6.2832*vnoise(P/800.0 + vec2(4.2, t*0.3e-4));
        vec2 k1 = vec2(cos(th), sin(th));
        float ph = dot(P, k1)*6.2832/85.0 + 5.0*fbm3(P/220.0 + vec2(t*0.5e-4, -3.3)) - t*6.2832*0.05/85.0;
        float pk = smoothstep(0.42, 0.68, fbm3(P/380.0 + vec2(t*0.4e-4, 1.7)));
        float a1 = dot(k1, u)*6.2832/85.0*Lp;
        float w1 = sin(ph)*pk*exp(-a1*a1/24.0);
        // shorter ripples in small patches, running another way
        vec2 k2 = vec2(cos(th + 1.3), sin(th + 1.3));
        float ph2 = dot(P, k2)*6.2832/30.0 + 3.0*fbm3(P/70.0 + vec2(9.1, t*1.0e-4)) - t*6.2832*0.04/30.0;
        float pk2 = smoothstep(0.52, 0.72, fbm3(P/150.0 + vec2(t*1.5e-4, 6.6)));
        float a2 = dot(k2, u)*6.2832/30.0*Lp;
        float w2 = sin(ph2)*pk2*exp(-a2*a2/24.0);
        float broad = fbm3(P/450.0 + vec2(t*0.3e-4, 2.0)) - 0.5;          // broad brighter and dimmer regions
        float far = smoothstep(1500.0, 500.0, dGround), farR = smoothstep(600.0, 200.0, dGround);
        float waves = 0.92 + 0.36*w1*far + 0.18*w2*farR + 0.5*broad;      // averages 1: brightness unchanged
        float vrR = 1.0/sqrt(1.0 - 0.93*cos(hp)*cos(hp));
        vec3 airglow = (vec3(0.55, 1.0, 0.5) * 0.36 * vr * waves + vec3(1.0, 0.25, 0.2) * 0.07 * vrR) * uNatSky * extn;
        // Zodiacal light from the dust in the ecliptic: brightness in S10 units fitted to Leinert et al. (1998),
        // falling away from the Sun and from the ecliptic, with the gegenschein opposite the Sun.
        vec3 ecl = uEclip * rd; float beta = abs(asin(clamp(ecl.z,-1.0,1.0)))*57.2958;
        float elong = max(acos(clamp(dot(rd, uSunDir), -1.0, 1.0))*57.2958, 12.0);
        float s0 = elong < 90.0 ? 430.0*pow(90.0/elong, 1.9) : 200.0 + 230.0*exp(-(elong - 90.0)/25.0) + 60.0*exp(-pow((180.0 - elong)/10.0, 2.0));
        float S10 = 60.0 + (s0 - 60.0)*exp(-beta/(12.0 + 0.15*elong));
        vec3 zodiacal = vec3(1.0, 0.96, 0.88) * uNatSky * S10/300.0 * extn;
        vec3 diffuse = vec3(0.9, 0.95, 1.0) * uNatSky * 0.15 * extn;
        vec3 nat = (airglow + zodiacal + diffuse);
        vec3 lp = lpSky(rd) * uLPScale * vec3(1.0, 0.86, 0.68);
        vec3 col = L + nat + lp;
        if (ground) col = col * 0.6 + T * vec3(0.05) * (uSunE * max(uSunDir.y, 0.0) + uMoonE*max(uMoonDir.y,0.0)) / PI * 0.0;
        gl_FragColor = vec4(min(col * uExposure, vec3(60000.0)), 1.0);
      }`,
  });
  Object.assign(U, {
    uAGT: { value: 0 }, uObsKm: { value: 0 }, uNatSky: { value: 1.71e-4 }, uLPScale: { value: 1 }, uLPSky: { value: null }, uHasLP: { value: 0 },
    uEclip: { value: new THREE.Matrix3() },
  });
  const scene = new THREE.Scene(), cam = new THREE.Camera();
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false; scene.add(mesh);
  return { rt, render() { const o = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(o); } };
}

// Light-pollution sky texture from the worker output (log-encoded, uniform in sqrt-altitude).
export function lpSkyTexture(lp) {
  const W = lp.nAz, H = 32, data = new Uint8Array(W * H * 4);
  const enc = L => Math.max(0, Math.min(255, Math.round((Math.log10(Math.max(L, 1e-8)) + 8) / 7 * 255)));
  const sampleAlt = (arr, a, altDeg) => {
    const al = lp.alts; let k = 0; while (k < al.length - 2 && al[k + 1] < altDeg) k++;
    const f = Math.max(0, Math.min(1, (altDeg - al[k]) / (al[k + 1] - al[k])));
    const v0 = arr[a * al.length + k], v1 = arr[a * al.length + k + 1];
    return Math.exp(Math.log(Math.max(v0, 1e-9)) * (1 - f) + Math.log(Math.max(v1, 1e-9)) * f);
  };
  for (let j = 0; j < H; j++) {
    const alt = (j / (H - 1)) ** 2 * 90;
    for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 4;
      data[k] = enc(sampleAlt(lp.clear, i, alt)); data[k + 1] = enc(sampleAlt(lp.cloud, i, alt)); data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

// Background: sky LUT + sun disc + Milky Way. Drawn first, at the far plane.
export function makeSkyBackground(U, mwTex) {
  Object.assign(U, { uMW: { value: mwTex }, uEqToWorld: { value: new THREE.Matrix3() }, uGal: { value: new THREE.Matrix3() }, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uMWScale: { value: 1 },
    uAurora: { value: new THREE.Vector4() }, uENU: { value: new THREE.Matrix3() }, uObsECEF: { value: new THREE.Vector3(0, 0, 6371) }, uMagAxis: { value: new THREE.Vector3(0, 0, 1) } });
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vec4 w = uInvProjView * vec4(position.xy, 1.0, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: COMMON + /* glsl */`
      in vec3 vDir; uniform sampler2D uMW; uniform mat3 uEqToWorld, uGal, uENU; uniform float uMWScale; uniform vec4 uAurora; uniform vec3 uObsECEF, uMagAxis;
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = skyL(d);
        float sh = d.y;
        // Sun disc with limb darkening, reddened by extinction
        float cs = dot(d, uSunDir), r = acos(clamp(cs, -1.0, 1.0));
        float R = 0.00465;
        if (r < R*1.6 && sh > -0.02) {
          float mu = sqrt(max(0.0, 1.0 - (r/R)*(r/R)));
          float limb = r < R ? (0.4 + 0.6*mu) : 0.0;
          col += uSunE * 2.15e4 * limb * directT(uSunDir.y) * uExposure * smoothstep(-0.02, 0.0, sh);
        }
        // Milky Way from an all-sky photograph (ESO/S. Brunier), stars removed, mapped in galactic coordinates
        // (coordinates and their screen derivatives outside the branch, where derivatives are well defined)
        vec3 mwE = transpose(uEqToWorld) * d;
        vec3 g = uGal * mwE; float gl = atan(g.y, g.x), gb = asin(clamp(g.z,-1.0,1.0));
        // longitude wraps from 1 to 0 at l = 180 deg: take the mip-level gradients across the wrap, or that pixel
        // column picks the blurriest level and draws a thin seam through the sky
        vec2 mwUV = vec2(0.5 - gl/(2.0*PI), 0.5 + gb/PI);
        vec2 gx = dFdx(mwUV), gy = dFdy(mwUV); gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
        if (sh > -0.05) {
          vec3 mw = textureGrad(uMW, mwUV, gx, gy).rgb; mw *= mw;   // stored sqrt-encoded
          vec3 T = directT(max(sh, 0.0));
          col += mw * 1.3e-3 * uMWScale * uExposure * T * smoothstep(-0.05, 0.03, sh);
        }
        // Aurora: emission between ~100 and ~250 km where the auroral oval sits (green below, red above)
        if (uAurora.z > 0.0 && sh > -0.02) {
          vec3 dE = uENU * vec3(d.x, -d.z, d.y);            // world (east, up, south) -> Earth-fixed
          float Rk = 6371.0, acc = 0.0, red = 0.0;
          for (int k = 0; k < 5; k++) {
            float hk = 100.0 + float(k)*35.0;
            float b = dot(uObsECEF, dE), c = dot(uObsECEF, uObsECEF) - (Rk + hk)*(Rk + hk);
            float tk = -b + sqrt(max(b*b - c, 0.0));
            vec3 P = uObsECEF + dE*tk; vec3 Pn = normalize(P);
            float ml = asin(clamp(dot(Pn, uMagAxis), -1.0, 1.0));
            float aml = abs(ml);
            float band = smoothstep(uAurora.x - 0.02, uAurora.x + 0.015, aml) * smoothstep(uAurora.x + uAurora.y + 0.03, uAurora.x + uAurora.y - 0.01, aml);
            if (band <= 0.001) continue;
            vec3 ref = normalize(cross(uMagAxis, vec3(0.0, 0.0, 1.0)) + 1e-4);
            float mlon = atan(dot(Pn, cross(uMagAxis, ref)), dot(Pn, ref));
            // curtains: folded arcs with fine vertical rays, drifting slowly
            float arcs = fbm2(vec2(mlon*18.0 + uTime*0.02, aml*90.0));
            float rays = 0.55 + 0.45*fbm2(vec2(mlon*260.0 + uTime*0.15, uTime*0.05));
            float curtain = smoothstep(0.42, 0.7, arcs) * rays;
            float layer = exp(-pow((hk - 115.0)/30.0, 2.0)), upper = smoothstep(150.0, 230.0, hk);
            acc += curtain * band * layer * 0.35;
            red += curtain * band * upper * 0.25;
          }
          // a 1 kR green aurora is ~1.9e-4 cd/m^2; uAurora.z is the peak brightness in kR
          // looking obliquely through the emitting layer collects more light (up to ~5x toward the horizon)
          float slant = min(5.0, 1.0/max(sqrt(1.0 - pow(6371.0*cos(asin(clamp(sh, -1.0, 1.0)))/(6371.0 + 110.0), 2.0)), 0.2));
          vec3 aur = (vec3(0.15, 1.0, 0.35)*acc + vec3(1.0, 0.12, 0.25)*red*(0.4 + uAurora.w)) * uAurora.z * 1.9e-4 * slant * 2.5;
          col += aur * directT(max(sh, 0.0)) * uExposure * smoothstep(-0.02, 0.02, sh);
        }
        gl_FragColor = vec4(min(col, vec3(3.0e4)), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false; mesh.renderOrder = -100;
  return mesh;
}

// Milky Way photograph (galactic coordinates), see tools/milkyway.py
export function milkyWayPhoto() {
  const t = new THREE.TextureLoader().load('data/milkyway.jpg');
  t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}
// Milky Way brightness map from contour polygons (equirectangular RA/Dec), blurred.
export function milkyWayTexture(levels) {
  const W = 2048, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const lv = [0.18, 0.2, 0.22, 0.2, 0.2];
  levels.forEach((L, li) => {
    g.filter = `blur(${[6, 4, 3, 2, 2][li] || 2}px)`;
    g.fillStyle = `rgba(255,255,255,${lv[li] || 0.2})`;
    for (const ring of L.polys) {
      // unwrap RA so rings crossing 0h stay continuous, then draw at three offsets
      const pts = []; let prev = null;
      for (const [ra, dec] of ring) { let r = ra; if (prev != null) { while (r - prev > 180) r -= 360; while (prev - r > 180) r += 360; } pts.push([r, dec]); prev = r; }
      for (const off of [-360, 0, 360]) {
        g.beginPath();
        pts.forEach(([r, d], i) => { const x = (r + off) / 360 * W, y = (d + 90) / 180 * H; i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.closePath(); g.fill('evenodd');
      }
    }
  });
  g.filter = 'none';
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Stars and planets as PSF splats; extinction, scintillation, and fading by local sky brightness (limiting magnitude).
export function makeStars(U, starData) {
  const s = starData.s, n = s.length / 4;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ra = s[i * 4] * Math.PI / 180, de = s[i * 4 + 1] * Math.PI / 180;
    pos[i * 3] = Math.cos(de) * Math.cos(ra); pos[i * 3 + 1] = Math.cos(de) * Math.sin(ra); pos[i * 3 + 2] = Math.sin(de);
    mag[i] = s[i * 4 + 2];
    const c = bvToRGB(s[i * 4 + 3]); col.set(c, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = starMaterial(U, true);
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = -90;
  return pts;
}
export function makePlanets(U) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
  geo.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(7), 1));
  const c = [[0.9, 0.85, 0.8], [1, 0.98, 0.9], [1, 0.6, 0.4], [1, 0.92, 0.82], [1, 0.9, 0.7], [0.75, 0.9, 1], [0.6, 0.75, 1]];
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(c.flat()), 3));
  const pts = new THREE.Points(geo, starMaterial(U, false)); pts.frustumCulled = false; pts.renderOrder = -89;
  return pts;
}
export function starMaterial(U, eq) {
  if (!U.uPxSr) Object.assign(U, { uPxSr: { value: 1e-6 }, uPxScale: { value: 1 }, uSeeing: { value: 1 }, uZoomGain: { value: 0 } });
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n' + COMMON + /* glsl */`
      attribute float mag; attribute vec3 color; uniform mat3 uEqToWorld; uniform float uPxSr, uPxScale, uSeeing, uZoomGain;
      out vec3 vCol; out float vSize;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec3 d = ${eq ? 'uEqToWorld * position' : 'position'};
        // refraction lift near the horizon
        float h = asin(clamp(d.y,-1.0,1.0))*57.2958;
        float hh = max(h, -1.0); float rf = 1.02/tan(radians(hh + 10.3/(hh + 5.11)))/60.0; h += clamp(rf, 0.0, 0.6);
        float hr = radians(h); vec2 hz = normalize(d.xz); d = vec3(hz.x*cos(hr), sin(hr), hz.y*cos(hr));
        float m = mag;
        vec3 T = directT(d.y);
        // local sky brightness -> naked-eye limiting magnitude (Schaefer); stars fade as the sky brightens
        vec3 sky = skyL(d) / uExposure; float Ls = max(dot(sky, vec3(0.2126,0.7152,0.0722)), 1e-6);
        float sqm = 12.583 - 2.5*log(Ls)/log(10.0);
        float lim = 7.93 - 5.0*log(pow(10.0, 4.316 - sqm/5.0) + 1.0)/log(10.0) + uZoomGain;
        float mObs = m - 2.5*log(max(dot(T, vec3(0.2126,0.7152,0.0722)), 1e-5))/log(10.0);
        float vis = smoothstep(lim + 0.4, lim - 0.9, mObs) * smoothstep(-0.03, 0.01, d.y);
        float E = 2.54e-6 * pow(10.0, -0.4*m); // lux
        // twinkling grows toward the horizon
        float tw = 1.0 + 0.45*sin(uTime*(13.0 + fract(position.x*91.7)*20.0) + position.y*300.0) * clamp(1.6/(max(d.y,0.02)*12.0+1.0), 0.0, 1.0);
        float size = (2.6 + max(0.0, 2.5 - m)*1.4) * uPxScale * uSeeing;
        float area = 3.1416*size*size*0.25;
        vCol = color * T * E / (uPxSr*area) * uExposure * vis * tw * 9.0;   // the eye integrates point sources better than a pixel does
        vSize = size;
        gl_PointSize = size;
        vec4 mv = viewMatrix * vec4(d*1.0e6 + cameraPosition, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
        if (vis <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      in vec3 vCol; in float vSize;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord*2.0-1.0; float r2 = dot(p,p); if (r2 > 1.0) discard;
        float g = exp(-r2*4.0); gl_FragColor = vec4(min(vCol * g * 1.6, vec3(3.0e4)), 1.0);
      }`,
  });
}
// Rough blackbody colour from B-V.
export function bvToRGB(bv) {
  bv = Math.max(-0.4, Math.min(2, bv));
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = t / 100; let r, g, b;
  r = k <= 66 ? 255 : 329.7 * Math.pow(k - 60, -0.1332);
  g = k <= 66 ? 99.47 * Math.log(k) - 161.1 : 288.1 * Math.pow(k - 60, -0.0755);
  b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5 * Math.log(k - 10) - 305;
  const c = [r, g, b].map(v => Math.max(0, Math.min(255, v)) / 255);
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // desaturate: the eye sees star colours only weakly
  return c.map(v => (v / l) * 0.55 + 0.45);
}

// Moon: lit sphere with procedural maria, correct phase from the true Sun direction, earthshine, extinction.
export function makeMoon(U) {
  Object.assign(U, { uMoonLight: { value: new THREE.Vector3() }, uMoonRadius: { value: 0.0045 }, uMoonLum: { value: 2500 } });
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      #include <common>
      uniform vec3 uMoonDir; uniform float uMoonRadius; out vec2 vP;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vP = position.xy;
        vec3 f = normalize(uMoonDir), up0 = abs(f.y) > 0.99 ? vec3(1,0,0) : vec3(0,1,0);
        vec3 r = normalize(cross(up0, f)), u = cross(f, r);
        float s = tan(uMoonRadius) * 1.0e6 * 1.02;
        vec3 w = cameraPosition + f*1.0e6 + (r*position.x + u*position.y)*s;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: COMMON + /* glsl */`
      in vec2 vP; uniform vec3 uMoonLight; uniform float uMoonLum;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        float r2 = dot(vP, vP); if (r2 > 1.0) discard;
        vec3 f = normalize(uMoonDir), up0 = abs(f.y) > 0.99 ? vec3(1,0,0) : vec3(0,1,0);
        vec3 rr = normalize(cross(up0, f)), uu = cross(f, rr);
        vec3 n = normalize(rr*vP.x + uu*vP.y - f*sqrt(1.0 - r2)); // surface normal facing us
        float ci = dot(n, uMoonLight), ce = sqrt(1.0 - r2);
        // selenographic-ish coordinates for maria (near side faces Earth; north roughly toward celestial north)
        vec2 sl = vP;
        float maria = 0.0;
        maria += smoothstep(0.32, 0.0, length((sl - vec2(-0.35, 0.42))*vec2(1.0,1.3)));  // Imbrium
        maria += smoothstep(0.22, 0.0, length(sl - vec2(0.15, 0.40)));                     // Serenitatis
        maria += smoothstep(0.25, 0.0, length(sl - vec2(0.38, 0.12)));                     // Tranquillitatis
        maria += smoothstep(0.17, 0.0, length(sl - vec2(0.72, 0.30)));                     // Crisium
        maria += smoothstep(0.45, 0.0, length((sl - vec2(-0.62, 0.05))*vec2(1.4,0.9)));    // Procellarum
        maria += smoothstep(0.17, 0.0, length(sl - vec2(-0.28, -0.35)));                    // Nubium
        maria += smoothstep(0.16, 0.0, length(sl - vec2(0.45, -0.18)));                     // Fecunditatis
        maria += smoothstep(0.14, 0.0, length(sl - vec2(-0.05, 0.05)));                     // Vaporum/Medii
        float alb = mix(0.16, 0.075, clamp(maria, 0.0, 1.0)) * (0.85 + 0.3*fbm2(sl*12.0));
        alb += 0.08*smoothstep(0.06, 0.0, length(sl - vec2(-0.15, -0.72)));                 // Tycho
        float ls = ci > 0.0 ? ci/(ci + ce) : 0.0;          // Lommel-Seeliger
        float L = uMoonLum * alb/0.12 * ls * 2.0;
        float earthshine = uMoonLum * 1.2e-4 * alb/0.12 * (0.5 - 0.5*dot(uMoonLight, -f));
        vec3 T = directT(uMoonDir.y);
        vec3 c = vec3(1.0, 0.95, 0.88) * (L + earthshine) * T * uExposure;
        float edge = smoothstep(1.0, 0.96, r2);
        gl_FragColor = vec4(min(c * edge * smoothstep(-0.01, 0.005, uMoonDir.y), vec3(3.0e4)), 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -80;
  return m;
}

// Faint stars (6.6 < V <= 8) loaded on demand; they only show when zoomed in under dark skies.
export async function makeFaintStars(U) {
  const buf = await (await fetch('data/stars8.bin')).arrayBuffer(), dv = new DataView(buf), n = buf.byteLength / 6;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ra = dv.getUint16(i * 6, true) / 65535 * 2 * Math.PI, de = dv.getInt16(i * 6 + 2, true) / 32767 * Math.PI / 2;
    pos[i * 3] = Math.cos(de) * Math.cos(ra); pos[i * 3 + 1] = Math.cos(de) * Math.sin(ra); pos[i * 3 + 2] = Math.sin(de);
    mag[i] = dv.getUint8(i * 6 + 4) / 20; col.set(bvToRGB(dv.getInt8(i * 6 + 5) / 50), i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, starMaterial(U, true)); pts.frustumCulled = false; pts.renderOrder = -91;
  return pts;
}
