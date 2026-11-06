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
      uniform float uAOD, uObsKm, uExposure, uNatSky, uLPScale;
      uniform sampler2D uLPSky; uniform float uHasLP;
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
        float az = vUv.x*2.0*PI; float s = vUv.y*2.0 - 1.0; float h = sign(s)*s*s*0.5*PI;
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
        vec3 airglow = vec3(0.85, 1.0, 0.8) * uNatSky * 0.55 * vr * extn;
        vec3 ecl = uEclip * rd; float beta = asin(clamp(ecl.z,-1.0,1.0));
        float elong = acos(clamp(dot(rd, uSunDir), -1.0, 1.0));
        float zod = (0.25 + 2.2*exp(-(elong - 0.5)/0.35)) * exp(-abs(beta)/0.28) + 0.1;
        float sunDown = smoothstep(-0.12, -0.3, uSunDir.y);
        vec3 zodiacal = vec3(1.0, 0.97, 0.9) * uNatSky * 0.3 * zod * sunDown * extn;
        vec3 diffuse = vec3(0.9, 0.95, 1.0) * uNatSky * 0.22 * extn;
        vec3 nat = (airglow + zodiacal + diffuse);
        vec3 lp = lpSky(rd) * uLPScale * vec3(1.0, 0.86, 0.68);
        vec3 col = L + nat + lp;
        if (ground) col = col * 0.6 + T * vec3(0.05) * (uSunE * max(uSunDir.y, 0.0) + uMoonE*max(uMoonDir.y,0.0)) / PI * 0.0;
        gl_FragColor = vec4(min(col * uExposure, vec3(60000.0)), 1.0);
      }`,
  });
  Object.assign(U, {
    uObsKm: { value: 0 }, uNatSky: { value: 1.71e-4 }, uLPScale: { value: 1 }, uLPSky: { value: null }, uHasLP: { value: 0 },
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
  Object.assign(U, { uMW: { value: mwTex }, uEqToWorld: { value: new THREE.Matrix3() }, uGal: { value: new THREE.Matrix3() }, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uMWScale: { value: 1 } });
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vec4 w = uInvProjView * vec4(position.xy, 1.0, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: COMMON + /* glsl */`
      in vec3 vDir; uniform sampler2D uMW; uniform mat3 uEqToWorld, uGal; uniform float uMWScale;
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
        // Milky Way in J2000 RA/Dec with galactic-coordinate dust texture
        if (sh > -0.05) {
          vec3 e = transpose(uEqToWorld) * d;
          float ra = atan(e.y, e.x); if (ra < 0.0) ra += 2.0*PI; float dec = asin(clamp(e.z,-1.0,1.0));
          float mw = texture(uMW, vec2(ra/(2.0*PI), dec/PI + 0.5)).r;
          vec3 g = uGal * e; float gl = atan(g.y, g.x), gb = asin(clamp(g.z,-1.0,1.0));
          float dust = fbm2(vec2(gl*9.0, gb*28.0)), mott = fbm2(vec2(gl*40.0, gb*40.0));
          float core = exp(-pow(gl/0.5, 2.0) - pow(gb/0.18, 2.0));
          float lanes = smoothstep(0.35, 0.75, dust) * exp(-pow(gb/0.06, 2.0)) * (0.5 + core);
          float m = mw * (0.75 + 0.5*mott) * (1.0 - 0.7*lanes) + core*0.35*(1.0-lanes);
          vec3 mwc = mix(vec3(0.85, 0.88, 1.0), vec3(1.0, 0.9, 0.75), core);
          vec3 T = directT(max(sh, 0.0));
          col += mwc * m * 1.3e-3 * uMWScale * uExposure * T * smoothstep(-0.05, 0.03, sh);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false; mesh.renderOrder = -100;
  return mesh;
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
function starMaterial(U, eq) {
  Object.assign(U, { uPxSr: { value: 1e-6 }, uPxScale: { value: 1 }, uSeeing: { value: 1 } });
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n' + COMMON + /* glsl */`
      attribute float mag; attribute vec3 color; uniform mat3 uEqToWorld; uniform float uPxSr, uPxScale, uSeeing;
      out vec3 vCol; out float vSize;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec3 d = ${eq ? 'uEqToWorld * position' : 'position'};
        // refraction lift near the horizon
        float h = asin(clamp(d.y,-1.0,1.0))*57.2958;
        float rf = 1.02/tan(radians(h + 10.3/(h + 5.11)))/60.0; h += max(rf, 0.0);
        float hr = radians(h); vec2 hz = normalize(d.xz); d = vec3(hz.x*cos(hr), sin(hr), hz.y*cos(hr));
        float m = mag;
        vec3 T = directT(d.y);
        // local sky brightness -> naked-eye limiting magnitude (Schaefer); stars fade as the sky brightens
        vec3 sky = skyL(d) / uExposure; float Ls = max(dot(sky, vec3(0.2126,0.7152,0.0722)), 1e-6);
        float sqm = 12.583 - 2.5*log(Ls)/log(10.0);
        float lim = 7.93 - 5.0*log(pow(10.0, 4.316 - sqm/5.0) + 1.0)/log(10.0);
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
        float g = exp(-r2*4.0); gl_FragColor = vec4(vCol * g * 1.6, 1.0);
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
        gl_FragColor = vec4(c * edge * smoothstep(-0.01, 0.005, uMoonDir.y), 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -80;
  return m;
}
