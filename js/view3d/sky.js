// Physically based sky: single + approximate multiple scattering for Sun and Moon (Rayleigh, Mie, ozone, Earth's
// shadow), artificial skyglow from the light-pollution model, airglow, zodiacal light; then stars, planets, Milky Way, Moon.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON, REFR } from './glsl.js';

const FSQ = new THREE.BufferGeometry();
FSQ.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

export function makeSkyLUT(renderer, U) {
  const rt = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false });
  rt.texture.wrapS = THREE.RepeatWrapping;
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: REFR + /* glsl */`
      #define PI 3.14159265
      in vec2 vUv;
      uniform vec3 uSunDir, uMoonDir, uSunE, uMoonE;
      uniform float uAOD, uObsKm, uExposure, uNatSky, uLPScale, uTime;
      uniform sampler2D uLPSky; uniform float uHasLP;
      uniform float uAGT;   // simulated time for airglow motion (s, wrapped)
      uniform float uNoNat; // 1: leave out light from beyond the clouds (airglow, zodiacal light, starlight)
      uniform float uTwAmb; // twilight skylight in Earth's shadow (cd/m2 at the zenith), set from the sun's depression
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
        tMax = min(tMax, 1200.0);   // a horizontal ray leaves the atmosphere ~1130 km away; twilight glow near the horizon comes from that far, sunlit air
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
        // airglow and zodiacal light are beyond the refracting air: work them out at the true direction
        vec3 rdT = refrTrue(rd);
        float hp = max(asin(clamp(rdT.y, -1.0, 1.0)), 0.0);
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
        vec3 ecl = uEclip * rdT; float beta = abs(asin(clamp(ecl.z,-1.0,1.0)))*57.2958;
        float elong = max(acos(clamp(dot(rdT, uSunDir), -1.0, 1.0))*57.2958, 12.0);
        float s0 = elong < 90.0 ? 430.0*pow(90.0/elong, 1.9) : 200.0 + 230.0*exp(-(elong - 90.0)/25.0) + 60.0*exp(-pow((180.0 - elong)/10.0, 2.0));
        float S10 = 60.0 + (s0 - 60.0)*exp(-beta/(12.0 + 0.15*elong));
        vec3 zodiacal = vec3(1.0, 0.96, 0.88) * uNatSky * S10/300.0 * extn;
        vec3 diffuse = vec3(0.9, 0.95, 1.0) * uNatSky * 0.15 * extn;
        vec3 nat = (airglow + zodiacal + diffuse);
        vec3 lp = lpSky(rd) * uLPScale * vec3(1.0, 0.86, 0.68);
        // Twilight: air inside Earth's shadow is still lit by light scattered from the bright twilight sky, so the
        // shadow side and the zenith stay a modest fraction of the glow instead of going black. Bluish (ozone),
        // somewhat brighter low down and toward the sun; zero in daylight and at night.
        vec3 tw = vec3(0.0);
        if (uTwAmb > 0.0) {
          float sh2 = sin(max(h, 0.0));
          float fh = pow(1.25/(sh2 + 0.25), 0.6);
          vec2 sz = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5), rz = normalize(vec2(rd.x, rd.z) + 1e-5);
          float fa = 1.0 + 0.35*dot(sz, rz)*(1.0 - sh2);
          tw = vec3(0.55, 0.85, 1.38) * uTwAmb * fh * fa * exp(-0.05*min(X, 30.0));
        }
        vec3 col = L + nat*(1.0 - uNoNat) + lp + tw;
        if (ground) col = col * 0.6 + T * vec3(0.05) * (uSunE * max(uSunDir.y, 0.0) + uMoonE*max(uMoonDir.y,0.0)) / PI * 0.0;
        gl_FragColor = vec4(min(col * uExposure, vec3(60000.0)), 1.0);
      }`,
  });
  Object.assign(U, {
    uAGT: { value: 0 }, uNoNat: { value: 0 }, uTwAmb: { value: 0 }, uObsKm: { value: 0 }, uNatSky: { value: 1.71e-4 }, uLPScale: { value: 1 }, uLPSky: { value: null }, uHasLP: { value: 0 },
    uEclip: { value: new THREE.Matrix3() },
  });
  const scene = new THREE.Scene(), cam = new THREE.Camera();
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false; scene.add(mesh);
  // a small second copy without the light from beyond the clouds: the haze in front of a cloud is lower air,
  // so it must not carry airglow waves or zodiacal light onto the cloud
  const rtLow = new THREE.WebGLRenderTarget(128, 64, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false });
  rtLow.texture.wrapS = THREE.RepeatWrapping;
  return { rt, rtLow, render() {
    const o = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(scene, cam);
    U.uNoNat.value = 1; renderer.setRenderTarget(rtLow); renderer.render(scene, cam); U.uNoNat.value = 0;
    renderer.setRenderTarget(o);
  } };
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
    uAurora: { value: new THREE.Vector4() }, uAurP: { value: (() => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; })() }, uENU: { value: new THREE.Matrix3() }, uObsECEF: { value: new THREE.Vector3(0, 0, 6371) }, uMagAxis: { value: new THREE.Vector3(0, 0, 1) } });
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vec4 w = uInvProjView * vec4(position.xy, 1.0, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: COMMON + /* glsl */`
      in vec3 vDir; uniform sampler2D uMW; uniform mat3 uEqToWorld, uGal, uENU; uniform float uMWScale; uniform vec4 uAurora; uniform sampler2D uAurP; uniform vec3 uObsECEF, uMagAxis; uniform float uAurT, uSunSquish;
      // Distance along the ray to a surface of constant magnetic latitude phi (a cone about the dipole axis A) at
      // auroral heights; which = 0 nearer crossing, 1 farther. -1 if none.
      // aurora brightness (kR) where a ray meets the emitting layer, from NOAA-style chance of aurora at that spot:
      // none below 10 %, about airglow brightness at 10 %, a little brighter at 25 %, vivid from ~75 %
      float auroraP(vec3 P){   // chance of aurora (0-100 %) at an Earth-fixed point
        float r = length(P), la = asin(clamp(P.z/r, -1.0, 1.0))*57.29578, lo = atan(P.y, P.x)*57.29578;
        return texture(uAurP, vec2(fract((lo + 0.5)/360.0), (la + 90.5)/181.0)).r*255.0;
      }
      float auroraKR(vec3 P, float kp){
        float r = length(P), la = asin(clamp(P.z/r, -1.0, 1.0))*57.29578, lo = atan(P.y, P.x)*57.29578;
        float p = texture(uAurP, vec2(fract((lo + 0.5)/360.0), (la + 90.5)/181.0)).r*255.0;
        return p < 8.0 ? 0.0 : 0.25*pow(p/10.0, 1.9)*smoothstep(8.0, 10.0, p)*(1.0 + max(kp - 5.0, 0.0)*0.6);
      }
      float auroraSheet(vec3 O, vec3 D, vec3 A, float phi, float hemi, int which, float hmin, float hmax){
        float S = sin(phi); S *= S;
        float b = dot(O, D), c = dot(O, O), a0 = dot(O, A), a1 = dot(D, A);
        float qa = a1*a1 - S, qb = 2.0*(a0*a1 - S*b), qc = a0*a0 - S*c;
        float disc = qb*qb - 4.0*qa*qc; if (disc < 0.0 || abs(qa) < 1e-7) return -1.0;
        float sq = sqrt(disc), r1 = (-qb - sq)/(2.0*qa), r2 = (-qb + sq)/(2.0*qa);
        float t = which == 0 ? min(r1, r2) : max(r1, r2);
        if (t <= 0.0 || (a0 + t*a1)*hemi <= 0.0) return -1.0;
        float h = length(O + D*t) - 6371.0;
        return (h < hmin || h > hmax) ? -1.0 : t;
      }
      // magnetic shell value (km): constant along a dipole field line, so a curtain that follows the field is a
      // surface of constant L, leaning equatorward with height like real curtains (not a vertical wall)
      float fbmA(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
      float erfA(float x){ float x2 = x*x, e = sqrt(1.0 - exp(-x2*(1.2732395 + 0.147*x2)/(1.0 + 0.147*x2))); return x < 0.0 ? -e : e; }
      float auroraL(vec3 P, vec3 A){ float r = length(P), s = dot(P, A)/r; return r/max(1.0 - s*s, 1e-4); }
      // how close an Earth-fixed point is to the arcs actually showing (their magnetic latitudes and lit segments):
      // the diffuse green glow surrounds the aurora instead of filling the whole region where aurora is possible
      float auroraHalo(vec3 Pn, vec3 A, vec3 refA, vec3 refB, float tt, float act){
        float ml = abs(asin(clamp(dot(Pn, A), -1.0, 1.0))), mlo = atan(dot(Pn, refB), dot(Pn, refA)), hs = 0.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i), lat0 = uAurora.x + (fi - 2.0)*uAurora.y, dl = (ml - lat0)/0.026;
          if (abs(dl) > 3.0) continue;
          float seg = smoothstep(0.32, 0.62, fbm2(vec2(mlo*4.0 + fi*7.3 + tt*0.002*(1.0 + 2.0*act), fi)));
          hs += (i == 2 ? 1.0 : i == 1 || i == 3 ? 0.8 : 0.6) * seg * exp(-dl*dl);
        }
        return min(hs, 1.0);
      }
      void main(){
        vec3 d = normalize(vDir);
        vec3 dT = refrTrue(d);     // where this line of sight points without the atmosphere's bending
        vec3 col = skyL(d);
        float sh = d.y;
        // Sun disc with limb darkening, reddened by extinction; squashed vertically near the horizon (refraction
        // lifts its lower edge more than its upper edge)
        vec3 sV = vec3(0.0, 1.0, 0.0) - uSunDir*uSunDir.y; sV = dot(sV, sV) > 1e-8 ? normalize(sV) : vec3(1.0, 0.0, 0.0);
        vec3 sH = cross(uSunDir, sV);
        float r = atan(length(vec2(dot(d, sH), dot(d, sV)/uSunSquish)), dot(d, uSunDir));
        float R = 0.00465;
        if (r < R*1.6 && sh > -0.02) {
          float mu = sqrt(max(0.0, 1.0 - (r/R)*(r/R)));
          float limb = r < R ? (0.4 + 0.6*mu) : 0.0;
          col += uSunE * 2.15e4 * limb * directT(uSunDir.y) * uExposure * smoothstep(-0.02, 0.0, sh);
        }
        // Milky Way from an all-sky photograph (ESO/S. Brunier), stars removed, mapped in galactic coordinates
        // (coordinates and their screen derivatives outside the branch, where derivatives are well defined)
        vec3 mwE = transpose(uEqToWorld) * dT;
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
        // Aurora: thin field-aligned sheets (curtains) folded along the auroral oval. Each view ray is intersected
        // analytically with a few arcs (surfaces of constant magnetic latitude); emission depends on height (sharp
        // green lower border ~100 km, red tops above 200 km, pink N2 fringe in strong storms), on rays along the arc,
        // and on how obliquely the ray crosses the sheet. Folds drift and rays shimmer faster with higher Kp.
        if (uAurora.z > 0.0 && sh > -0.02) {
          vec3 dE = uENU * vec3(dT.x, -dT.z, dT.y);         // world (east, up, south) -> Earth-fixed (true direction)
          vec3 O = uObsECEF, A = uMagAxis;
          float hemi = dot(O, A) >= 0.0 ? 1.0 : -1.0;
          float kp = uAurora.w, act = clamp((kp - 2.0)/5.0, 0.15, 1.4), tt = uAurT;   // simulated time: live speed, and the night's changes when skipping ahead
          vec3 refA = normalize(cross(A, vec3(0.0, 0.0, 1.0)) + 1e-4), refB = cross(A, refA);
          float grAcc = 0.0, redAcc = 0.0, pinkAcc = 0.0;
          // where the ray is inside the emitting heights (85-420 km), and a start point at 130 km
          float bR = dot(O, dE), cR = dot(O, O);
          // Step along the ray through the emitting heights (85-420 km) and, on each step, integrate exactly how much
          // of the curtain's Gaussian thickness the ray passes through (erf of the distance to the curtain's
          // field-line surface at both ends of the step). Folds, grazing views and several crossings all come out
          // continuous: no seams where a search would jump between folds.
          const int NS = 12;
          float tS[NS], LS[NS], mS[NS];
          for (int k = 0; k < NS; k++) {
            float R = 6456.0 + 335.0*pow(float(k)/float(NS - 1), 1.7);   // denser low down, where the green is
            tS[k] = -bR + sqrt(max(bR*bR - (cR - R*R), 0.0));
            vec3 Pk = O + dE*tS[k], Pkn = normalize(Pk);
            LS[k] = auroraL(Pk, A); mS[k] = atan(dot(Pkn, refB), dot(Pkn, refA));
          }
          float mRef; { float tr = -bR + sqrt(max(bR*bR - (cR - 6481.0*6481.0), 0.0)); vec3 Pr = normalize(O + dE*tr); mRef = atan(dot(Pr, refB), dot(Pr, refA)); }
          const float thick = 7.0;                                          // km (1-sigma), fuzzy
          for (int i = 0; i < 5; i++) {
            float fi = float(i), lat0 = uAurora.x + (fi - 2.0)*uAurora.y;   // arcs spread across the oval
            float cl = cos(lat0), wL = 6481.0/(cl*cl)*2.0*tan(lat0)*thick/6481.0;   // thickness in L units
            float aG = 0.0, aR = 0.0, aP = 0.0, aT = 0.0, fPrev = 0.0;
            // small fast curls (~60 km): taken once per line of sight (where it crosses 110 km), so steps far apart
            // don't draw them as kinked straight segments
            float curl = 0.0025*(vnoise(vec2(mRef*45.0 - tt*0.02*(1.0 + 4.0*act), fi*5.0)) - 0.5);
            for (int k = 0; k < NS; k++) {
              // folds: large slow meanders (on the curtain's own position along the arc) plus the small curls
              float fold = 0.009*(fbmA(vec2(mS[k]*7.0 + fi*3.1, tt*0.004*(1.0 + 3.0*act)))*1.107 - 0.5) + curl;
              float c0 = cos(lat0 + fold);
              float f = (LS[k] - 6481.0/max(c0*c0, 1e-4))/wL;           // distance to the curtain, in thicknesses
              if (k > 0 && (fPrev*f < 0.0 || min(abs(fPrev), abs(f)) < 3.5)) {
                float dt = tS[k] - tS[k - 1], df = f - fPrev;
                float inC = abs(df) < 1e-3 ? dt*exp(-f*f) : dt*0.886227*(erfA(f) - erfA(fPrev))/df;   // km inside
                if (inC > 0.02) {
                  float sc = fPrev*f < 0.0 ? fPrev/(fPrev - f) : (abs(fPrev) <= abs(f) ? 0.0 : 1.0);
                  float t = mix(tS[k - 1], tS[k], sc);
                  vec3 Pn = normalize(O + dE*t);
                  float mlon = atan(dot(Pn, refB), dot(Pn, refA)), h = length(O + dE*t) - 6371.0;
                  float seg = smoothstep(0.32, 0.62, fbm2(vec2(mlon*4.0 + fi*7.3 + tt*0.002*(1.0 + 2.0*act), fi)));   // arcs come in segments
                  float amp = (i == 2 ? 1.0 : i == 1 || i == 3 ? 0.8 : 0.6) * seg;
                  float kR = amp < 0.01 ? 0.0 : auroraKR(O + dE*t, kp);
                  if (kR > 0.0) {
                    // rays follow the magnetic field, so they vary only along the arc: soft streaks that slide and flicker
                    float rx = mlon*1400.0;
                    float rays = 0.55 + 0.35*vnoise(vec2(rx - tt*(0.6 + 2.5*act), fi*11.0)) + 0.3*vnoise(vec2(rx*0.23 + tt*0.25*act, fi*3.0 + 1.0));
                    float hb = 102.0 + 10.0*vnoise(vec2(mlon*60.0, fi*2.0 + tt*0.01));
                    float gP = smoothstep(hb - 12.0, hb + 4.0, h) * exp(-max(h - hb, 0.0)/(40.0 + 15.0*rays));   // fuzzy lower edge
                    float rP = exp(-pow((h - 230.0)/65.0, 2.0));
                    float pP = exp(-pow((h - hb + 2.0)/4.0, 2.0));
                    float pulse = 1.0 + 0.35*act*sin(tt*(1.3 + fi) + mlon*30.0);
                    float I = 0.6*amp*rays*pulse*kR*inC/(2.0*1.7725*thick);   // face-on matches the old sheet brightness
                    aG += I*gP; aR += I*rP; aP += I*pP;
                  }
                  aT += inC;
                }
              }
              fPrev = f;
            }
            float cap = inversesqrt(1.0 + aT*aT/3600.0);                    // seen edge-on: capped near 60 km of curtain
            grAcc += aG*cap; redAcc += aR*cap; pinkAcc += aP*cap;
          }
          // faint diffuse glow just equatorward of the arcs
          {
            float b = dot(O, dE), c = dot(O, O) - 6486.0*6486.0;
            float tk = -b + sqrt(max(b*b - c, 0.0)); vec3 Pn = normalize(O + dE*tk);
            float slant = min(5.0, 1.0/max(sqrt(1.0 - pow(6371.0*cos(asin(clamp(sh, -1.0, 1.0)))/6486.0, 2.0)), 0.2));
            // diffuse luminous band filling the oval: soft blobs and folds along it that drift and swell (the "glow" in photos)
            float mlat = asin(clamp(dot(Pn, A), -1.0, 1.0)), mlo = atan(dot(Pn, refB), dot(Pn, refA));
            float patchy = 0.45 + 0.9*fbm2(vec2(mlat*45.0 + 0.3*sin(mlo*5.0 + tt*0.05*act), mlo*7.0 + tt*0.006*(1.0 + 2.0*act)));
            float swell = 1.0 + 0.25*act*sin(tt*0.35 + mlo*9.0);
            // in storms the bright green sits in the high-chance core of the oval; its equatorward fringe glows mostly red
            float stormF = smoothstep(5.0, 7.0, kp), gw = mix(1.0, smoothstep(25.0, 75.0, auroraP(O + dE*tk)), stormF);
            grAcc += 0.55*auroraKR(O + dE*tk, kp)*slant*patchy*swell*gw*auroraHalo(Pn, A, refA, refB, tt, act);
            float c2 = dot(O, O) - 6531.0*6531.0, t2b = -b + sqrt(max(b*b - c2, 0.0));
            float patchy2 = 0.5 + 0.8*fbm2(vec2(mlat*30.0 + 4.0, mlo*5.0 - tt*0.004*(1.0 + 2.0*act)));
            grAcc += 0.22*auroraKR(O + dE*t2b, kp)*min(4.0, slant)*patchy2*auroraHalo(normalize(O + dE*t2b), A, refA, refB, tt, act);
            // storm-time red glow from ~300 km (high enough to be seen far equatorward of the green arcs)
            if (kp > 5.0) {
              float c3 = dot(O, O) - 6671.0*6671.0, t3 = -b + sqrt(max(b*b - c3, 0.0));
              float slant3 = min(4.0, 1.0/max(sqrt(1.0 - pow(6371.0*cos(asin(clamp(sh, -1.0, 1.0)))/6671.0, 2.0)), 0.25));
              redAcc += 0.6*auroraKR(O + dE*t3, kp)*slant3*(0.6 + 0.8*fbm2(vec2(tt*0.003, 0.0) + normalize(O + dE*t3).xy*40.0));
            }
          }
          // uAurora.z: brightness in kR (a 1 kR green aurora is ~1.9e-4 cd/m^2)
          // quiet and moderate activity: green (557.7 nm, ~100-150 km) only; red 630 nm tops (~200-300 km) and the pink
          // N2 lower fringe (~95 km) appear only in geomagnetic storms
          float pinkF = smoothstep(6.0, 8.0, kp), redF = smoothstep(5.0, 7.0, kp);
          vec3 aur = (vec3(0.15, 1.0, 0.35)*grAcc + vec3(1.0, 0.16, 0.6)*redAcc*redF*0.8 + vec3(1.0, 0.3, 0.65)*pinkAcc*0.5*pinkF) * 1.9e-4;
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
        // refraction lift near the horizon (points of light: raised, not reshaped)
        d = refrApparent(d);
        float m = mag;
        vec3 T = directT(d.y);
        // local sky brightness -> naked-eye limiting magnitude (Schaefer); stars fade as the sky brightens
        vec3 sky = skyL(d) / uExposure; float Ls = max(dot(sky, vec3(0.2126,0.7152,0.0722)), 1e-6);
        float sqm = 12.583 - 2.5*log(Ls)/log(10.0);
        float lim = 7.93 - 5.0*log(pow(10.0, 4.316 - sqm/5.0) + 1.0)/log(10.0) + uZoomGain;
        float mObs = m - 2.5*log(max(dot(T, vec3(0.2126,0.7152,0.0722)), 1e-5))/log(10.0);
        float vis = smoothstep(lim + 0.4, lim - 0.9, mObs) * smoothstep(-0.03, 0.01, d.y);
        float E = 2.54e-6 * pow(10.0, -0.4*m); // lux
        // scintillation (stars only: planets, satellites and meteors are extended or not twinkling): random flicker
        // of a few percent overhead, growing with the air mass toward the horizon
        ${eq ? `float sd = fract(position.x*91.7 + position.z*53.1)*100.0;
        float X = 1.0/(max(d.y, 0.0) + 0.025*exp(-11.0*max(d.y, 0.0)) + 0.0001);
        float sig = min(0.03*pow(min(X, 30.0), 1.25), 0.3);
        float tw = 1.0 + sig*1.6*(vnoise(vec2(uTime*9.0 + sd, sd*0.37)) + vnoise(vec2(uTime*17.0 - sd, sd*1.3)) - 1.0);` : 'float tw = 1.0;'}
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
  Object.assign(U, { uMoonLight: { value: new THREE.Vector3() }, uMoonRadius: { value: 0.0045 }, uMoonLum: { value: 2500 }, uMoonGain: { value: 1 }, uMoonAvg: { value: 0 }, uMoonCam: { value: 0 }, uMoonMapOK: { value: 0 } });
  // real albedo map: NASA LRO (SVS CGI Moon Kit, public domain), reduced to 512x256 greyscale (30 KB)
  U.uMoonMap = { value: new THREE.TextureLoader().load('data/moon.jpg', t => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; U.uMoonMapOK.value = 1; }) };
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      #include <common>
      uniform vec3 uMoonDir; uniform float uMoonRadius, uPxSr, uMoonCam, uMoonSquish; uniform mat3 uEqToWorld; out vec2 vP; out float vQ;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vP = position.xy;
        // at least ~1.5 px across so the Moon can't fall between pixels; a camera also gets room for the glare
        // around an overexposed Moon (vQ = quad size / true size)
        float Rq = max(uMoonRadius, 1.5*sqrt(uPxSr)) * mix(1.0, 7.0, uMoonCam); vQ = Rq/uMoonRadius;
        vec3 f = normalize(uMoonDir), pole = normalize(uEqToWorld * vec3(0.0, -0.3978, 0.9175)), up0 = abs(dot(pole, f)) > 0.999 ? vec3(1,0,0) : pole;   // lunar north ~ ecliptic pole
        // r = screen right, u = up: the quad faces the camera (it was wound away from it and culled, and mirrored)
        vec3 r = normalize(cross(f, up0)), u = cross(r, f);
        float s = tan(Rq) * 1.0e6 * 1.02;
        vec3 o = (r*position.x + u*position.y)*s;
        // refraction squashes the disc vertically near the horizon
        vec3 vt = vec3(0.0, 1.0, 0.0) - f*f.y; vt = dot(vt, vt) > 1e-8 ? normalize(vt) : r;
        o -= vt*dot(o, vt)*(1.0 - uMoonSquish);
        vec3 w = cameraPosition + f*1.0e6 + o;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: COMMON + /* glsl */`
      in vec2 vP; in float vQ; uniform vec3 uMoonLight; uniform float uMoonLum, uMoonGain, uMoonAvg, uPxSr, uMoonRadius, uMoonCam, uMoonMapOK; uniform mat3 uEqToWorld; uniform sampler2D uMoonMap;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        if (dot(vP, vP) > 1.0) discard;
        vec3 f = normalize(uMoonDir), pole = normalize(uEqToWorld * vec3(0.0, -0.3978, 0.9175)), up0 = abs(dot(pole, f)) > 0.999 ? vec3(1,0,0) : pole;   // lunar north ~ ecliptic pole
        vec3 T = directT(uMoonDir.y);
        vec2 q = vP*vQ; float r2 = dot(q, q);
        vec3 det = vec3(0.0);
        if (r2 <= 1.0) {
        vec3 rr = normalize(cross(f, up0)), uu = cross(rr, f);
        vec3 n = normalize(rr*q.x + uu*q.y - f*sqrt(1.0 - r2)); // surface normal facing us
        float ci = dot(n, uMoonLight), ce = sqrt(1.0 - r2);
        // albedo from the real lunar map: near side toward us (selenographic latitude/longitude on the disc);
        // grey^1.3 makes highlands ~2.5x the maria, scaled so the near-side mean albedo stays 0.12
        float slat = asin(clamp(q.y, -1.0, 1.0)), slon = atan(q.x, sqrt(1.0 - r2));
        float gm = texture(uMoonMap, vec2(0.5 + slon/(2.0*PI), 0.5 + slat/PI)).r;
        float alb = uMoonMapOK > 0.5 ? 0.12*pow(gm, 1.3)/0.4224 : 0.12;
        float ls = ci > 0.0 ? ci/(ci + ce) : 0.0;          // Lommel-Seeliger
        float L = uMoonLum * uMoonGain * alb/0.12 * ls * 2.0;   // sunlit part follows the phase curve; earthshine doesn't
        // earthshine follows the Earth's phase seen from the Moon (Lambert sphere): strong for a crescent Moon, faint
        // by the quarter, effectively gone at gibbous
        float bE = PI - acos(clamp(dot(uMoonLight, -f), -1.0, 1.0));
        float earthshine = uMoonLum * 1.32e-4 * alb/0.12 * (sin(bE) + (PI - bE)*cos(bE))/PI;
        det = vec3(1.0, 0.95, 0.88) * (L + earthshine) * T * uExposure * smoothstep(1.0, 0.96, r2);
        }
        // only a few pixels across: shade the disc evenly with its mean brightness for this phase (spread over at
        // least ~1.5 px), so its whole light reaches the image; a thin crescent no longer falls between pixel samples
        float Rs = max(uMoonRadius, 1.5*sqrt(uPxSr)), ks = uMoonRadius/Rs;
        vec2 qs = q*ks;
        vec3 avg = dot(qs, qs) <= 1.0 ? vec3(1.0, 0.95, 0.88) * uMoonAvg * ks*ks * T * uExposure : vec3(0.0);
        float w = smoothstep(3.0, 8.0, uMoonRadius/sqrt(uPxSr));
        vec3 c = mix(avg, det, w);
        // the eye's wide dynamic range: the disc is only slightly overexposed (sunlit surface just past white,
        // maria still visible); a camera exposing for the night sky blows it out
        float peak = mix(uMoonAvg*ks*ks, uMoonLum*uMoonGain, w) * dot(T, vec3(0.2126, 0.7152, 0.0722)) * uExposure;
        c *= mix(min(1.0, 3.5/max(peak, 1e-6)), 1.0, uMoonCam);
        // camera: glare from lens and sensor around the overexposed Moon, scaled by its total light
        if (uMoonCam > 0.0) {
          // fades in exactly as the disc's soft limb fades out, so there is no dark ring between them
          float d = max(length(q), 1.0), under = 1.0 - smoothstep(1.0, 0.96, min(r2, 1.0));
          c += vec3(1.0, 0.95, 0.88) * uMoonAvg * T * uExposure * 0.02 * exp(-(d - 1.0)*1.2)/(d*d) * uMoonCam * under;
        }
        gl_FragColor = vec4(min(c * smoothstep(-0.01, 0.005, uMoonDir.y), vec3(3.0e4)), 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -80;
  return m;
}

// Glare around the Moon, over everything in view (it happens in the eye or the lens, not the sky). Eye: the
// Stiles-Holladay disability-glare law, L = 10 E / theta^2 (cd/m^2, E in lux at the eye, theta in degrees), so even a
// crescent lifts the whole sky a little and a full Moon a lot. Camera: lens and sensor flare, stronger and wider.
export function makeMoonGlare(U) {
  Object.assign(U, { uMoonVis: { value: 1 }, uMoonGlare: { value: 1 } });
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vec4 w = uInvProjView * vec4(position.xy, 1.0, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: COMMON + /* glsl */`
      in vec3 vDir; uniform float uMoonCam, uMoonVis, uMoonGlare, uMoonRadius;
      void main(){
        vec3 d = normalize(vDir), m = normalize(uMoonDir);
        float th = max(acos(clamp(dot(d, m), -1.0, 1.0)), uMoonRadius*1.3) * 57.29578;   // degrees from the Moon
        float E = dot(uMoonE * directT(max(m.y, 0.0)), vec3(0.2126, 0.7152, 0.0722)) * smoothstep(-0.01, 0.01, m.y) * uMoonVis;
        float L = mix(10.0*E/(th*th), 60.0*E/pow(th, 1.6), uMoonCam) * uMoonGlare;
        gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * min(L*uExposure, 3.0e4), 1.0);
      }`,
  });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 900;
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
