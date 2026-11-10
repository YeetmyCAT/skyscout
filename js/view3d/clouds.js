// Volumetric clouds: ray-marched layers placed at their forecast altitudes, with distinct shapes per type.
// Low: cumulus / stratocumulus / stratus / fog. Mid: altocumulus / altostratus. High: cirrus / cirrostratus.
// Convective: cumulonimbus towers with anvils spreading downwind, rain/snow shafts underneath.
import * as THREE from '../../vendor/three.module.min.js';
import { COMMON, LOGDEPTH_DECODE } from './glsl.js';

export const R_EFF = 6.371e6 / (1 - 0.13);

export function loadNoise() {
  return new Promise(res => {
    const w = new Worker(new URL('./noiseworker.js', import.meta.url));
    w.onmessage = e => {
      const { shape, detail, N, M } = e.data;
      const mk = (d, n) => { const t = new THREE.Data3DTexture(d, n, n, n); t.format = THREE.RGBAFormat; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true; return t; };
      res({ shape: mk(shape, N), detail: mk(detail, M) }); w.terminate();
    };
    w.postMessage(0);
  });
}

export function makeCloudPass(U, noise) {
  Object.assign(U, {
    uShape: { value: noise.shape }, uDetail: { value: noise.detail },
    uWx1: { value: null }, uWx2: { value: null }, uDomain: { value: 120000 },
    uLowBase: { value: 1200 }, uLowTop: { value: 2200 }, uMidBase: { value: 3500 }, uMidTop: { value: 5000 }, uHighBase: { value: 8500 }, uHighTop: { value: 11000 }, uTropo: { value: 12500 },
    uWindLow: { value: new THREE.Vector2() }, uWindMid: { value: new THREE.Vector2() }, uWindHigh: { value: new THREE.Vector2() }, uCirrusDir: { value: new THREE.Vector2(1, 0) },
    uFlux: { value: null }, uFluxHalf: { value: 60000 }, uFluxScale: { value: 9e-4 }, uFluxSnow: { value: 1 },
    uDepth: { value: null }, uLogFar: { value: 1 }, uCamFwd: { value: new THREE.Vector3() }, uSteps: { value: 48 }, uFrame: { value: 0 },
    uGroundAlb: { value: 0.15 }, uMaxDist: { value: 150000 }, uPrecipSnow: { value: 0 }, uRainNear: { value: 0 },
  });
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec3 vDir; out vec2 vUv; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vUv = position.xy*0.5+0.5; vec4 w = uInvProjView * vec4(position.xy, 1.0, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: COMMON + LOGDEPTH_DECODE + /* glsl */`
      precision highp sampler3D;
      in vec3 vDir; in vec2 vUv;
      uniform sampler3D uShape, uDetail; uniform sampler2D uWx1, uWx2, uFlux, uDepth;
      uniform float uDomain, uLowBase, uLowTop, uMidBase, uMidTop, uHighBase, uHighTop, uTropo;
      uniform vec2 uWindLow, uWindMid, uWindHigh, uCirrusDir;
      uniform float uFluxHalf, uFluxScale, uFluxSnow, uSteps, uFrame, uGroundAlb, uMaxDist, uPrecipSnow;
      uniform vec3 uCamPos, uCamFwd;
      const float REFF = ${R_EFF.toFixed(1)};
      float remap(float v, float a, float b, float c, float d){ return c + (v-a)/(b-a)*(d-c); }
      float alt(vec3 p){ return p.y + dot(p.xz, p.xz)/(2.0*REFF); }
      vec2 wxUV(vec2 xz){ return xz/(2.0*uDomain) + 0.5; }
      // returns density (extinction per metre) and writes a type tag for lighting
      float density(vec3 p, bool detail, out float precipShaft, out float iceFrac){
        float a = alt(p); precipShaft = 0.0; iceFrac = 0.0;
        if (a > uTropo + 1500.0) return 0.0;
        vec2 uv = wxUV(p.xz);
        vec4 w1 = texture(uWx1, uv), w2 = texture(uWx2, uv);
        float d = 0.0;
        // ---- low layer
        float lowTop = uLowBase + max(w2.b*6000.0, 250.0);
        if (w1.r > 0.01 && a > uLowBase - 50.0 && a < lowTop + 400.0){
          vec3 q = p + vec3(uWindLow.x, 0.0, uWindLow.y);
          float h = clamp((a - uLowBase)/(lowTop - uLowBase), 0.0, 1.0);
          float cu = w2.r;
          vec4 s = texture(uShape, q/vec3(9000.0, 6000.0, 9000.0));
          vec4 sl = texture(uShape, q/vec3(36000.0, 20000.0, 36000.0));
          float lf = s.g*0.625 + s.b*0.25 + s.a*0.125;
          float base = clamp((remap(s.r, -(1.0 - lf), 1.0, 0.0, 1.0) - 0.74)/0.17, 0.0, 1.0);
          float strat = clamp((sl.a*0.6 + sl.r*0.4 - 0.47)/0.26, 0.0, 1.0);
          base = mix(strat, base, cu);           // stratus: broad and smooth
          // towers: per-cell top height variation for cumulus
          float topVar = mix(1.0, 0.35 + 0.65*sl.r, cu);
          float hh = h / topVar;
          float gS = smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.7, h);
          float gC = smoothstep(0.0, 0.06, hh) * smoothstep(1.0, 0.25, hh);
          float g = mix(gS, gC, cu);
          float cov = w1.r;
          // coverage threshold with a soft edge: cloudy patches are solid, gaps are clear sky
          float c = smoothstep(1.0 - cov, 1.0 - cov + mix(0.08, 0.3, cu), base*mix(1.0, g, cu)) * g;
          if (detail && c > 0.0){
            vec4 dn = texture(uDetail, q/1100.0 + vec3(0.0, uTime*0.002, 0.0));
            float df = dn.r*0.625 + dn.g*0.25 + dn.b*0.125;
            // a finer octave for crisp cauliflower edges on cumuliform clouds (within ~15 km)
            if (cu > 0.4 && length(p - uCamPos) < 15000.0) { vec4 d2 = texture(uDetail, q/330.0 + vec3(uTime*0.001, 0.0, 0.0)); df = mix(df, d2.r*0.6 + d2.g*0.4, 0.35); }
            df = mix(df, 1.0 - df, clamp(h*4.0, 0.0, 1.0));
            c = remap(c, df*mix(0.15, 0.35, cu), 1.0, 0.0, 1.0);
          }
          d += max(c, 0.0) * mix(0.025, 0.06, cu) * mix(0.55 + 0.9*sl.g, 1.0, cu);   // stratus: uneven thickness shows as darker patches
        }
        // ---- mid layer
        if (w1.g > 0.01 && a > uMidBase - 200.0 && a < uMidTop + 200.0){
          vec3 q = p + vec3(uWindMid.x, 0.0, uWindMid.y);
          float h = clamp((a - uMidBase)/(uMidTop - uMidBase), 0.0, 1.0);
          float cu = w2.r*0.0 + (w1.g > 0.75 ? 0.15 : 0.7);
          vec4 s = texture(uShape, q/vec3(3500.0, 2500.0, 3500.0));
          vec4 sl = texture(uShape, q/vec3(30000.0, 15000.0, 30000.0));
          float base = mix(clamp((sl.a*0.7 + 0.25 - 0.5)/0.2, 0.0, 1.0), clamp((s.r*0.7 + s.g*0.3 - 0.5)/0.32, 0.0, 1.0), cu);
          float g = smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.6, h);
          float c = smoothstep(1.0 - w1.g, 1.0 - w1.g + 0.15, base) * g;
          if (detail && c > 0.0){ float dn = texture(uDetail, q/700.0).r; c = remap(c, dn*0.3*cu, 1.0, 0.0, 1.0); }
          d += max(c, 0.0) * mix(0.008, 0.02, cu);
        }
        // ---- high layer: cirrus streaks along the upper wind
        if (w1.b > 0.01 && a > uHighBase - 300.0 && a < uHighTop + 300.0){
          vec2 dir = uCirrusDir; vec2 xz = p.xz + uWindHigh;
          vec2 r = vec2(dot(xz, dir), dot(xz, vec2(-dir.y, dir.x)));
          float h = clamp((a - uHighBase)/(uHighTop - uHighBase), 0.0, 1.0);
          vec4 s1 = texture(uShape, vec3(r.x/60000.0, a/9000.0, r.y/9000.0));
          vec4 s2 = texture(uShape, vec3(r.x/14000.0 + s1.r*0.2, a/3000.0, r.y/1400.0));
          float fib = clamp((s1.a*0.55 + s2.b*0.45 + 0.1*s2.a - 0.3)/0.45, 0.0, 1.0);
          float hook = smoothstep(0.2, 0.5, h + (s1.g - 0.5)*0.6);
          float g = smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.55, h);
          float sheet = smoothstep(0.65, 0.95, w1.b);
          float c = remap(mix(fib, 0.7 + 0.3*s1.a, sheet)*g*(0.7 + 0.3*hook), 1.0 - w1.b, 1.0, 0.0, 1.0) * w1.b;
          d += max(c, 0.0) * mix(0.00035, 0.00018, sheet); iceFrac = c > 0.0 ? 1.0 : 0.0;
        }
        // ---- cumulonimbus towers and anvils
        float st = w1.a;
        float topZ = max(w2.a*20000.0, uLowTop + 2000.0);
        if (st > 0.02 && a > uLowBase - 100.0 && a < topZ + 500.0){
          vec3 q = p + vec3(uWindLow.x, 0.0, uWindLow.y);
          float h = clamp((a - uLowBase)/(topZ - uLowBase), 0.0, 1.0);
          vec4 s = texture(uShape, q/vec3(14000.0, 16000.0, 14000.0));
          float body = smoothstep(1.0 - st, 1.0 - st + 0.2, clamp((s.r*0.7 + s.g*0.3 - 0.55)/0.3, 0.0, 1.0));
          float g = smoothstep(0.0, 0.03, h) * smoothstep(1.0, 0.9, h);
          float c = body * g;
          if (detail && c > 0.0){ float dn = texture(uDetail, q/1600.0).r; c = remap(c, dn*0.25, 1.0, 0.0, 1.0); }
          d += max(c, 0.0) * 0.07;
        }
        // anvil: spread storm coverage blurred and blown downwind near the tropopause
        float anv = textureLod(uWx1, wxUV(p.xz - uCirrusDir*6000.0), 4.0).a;
        float aTop = max(textureLod(uWx2, wxUV(p.xz - uCirrusDir*6000.0), 4.0).a*20000.0, uHighBase);
        if (anv > 0.03 && a > aTop - 2600.0 && a < aTop + 200.0){
          vec3 q = p + vec3(uWindHigh.x, 0.0, uWindHigh.y);
          float h = clamp((a - (aTop - 2600.0))/2800.0, 0.0, 1.0);
          float s = clamp((texture(uShape, q/vec3(20000.0, 6000.0, 20000.0)).g - 0.25)/0.45, 0.0, 1.0);
          float c = remap(s*smoothstep(0.0, 0.5, h)*smoothstep(1.0, 0.85, h), 1.0 - min(anv*2.2, 1.0), 1.0, 0.0, 1.0);
          d += max(c, 0.0) * 0.012; iceFrac = max(iceFrac, step(0.0, c)*0.6);
        }
        // ---- precipitation shafts below the cloud base
        float pr = w2.g;
        if (pr > 0.02 && a < uLowBase + 200.0){
          vec3 q = p + vec3(uWindLow.x, 0.0, uWindLow.y);
          float streak = texture(uShape, vec3(q.x/2500.0, a/30000.0, q.z/2500.0)).g;
          float c = pr * smoothstep(0.25, 0.7, streak) * smoothstep(uLowBase + 200.0, uLowBase - 300.0, a);
          float k = mix(0.00035, 0.0009, uPrecipSnow);
          d += c * k; precipShaft = c;
        }
        return d;
      }
      float hg(float c, float g){ return (1.0 - g*g)/(4.0*PI*pow(1.0 + g*g - 2.0*g*c, 1.5)); }
      // Sun/Moon light reaching altitude a (the light can still be above the horizon up there)
      vec3 lightAt(vec3 L, vec3 E, float a){
        float dip = sqrt(max(2.0*a/REFF, 0.0));
        float s = sin(asin(clamp(L.y, -1.0, 1.0)) + dip);
        return E * directT(s) * smoothstep(-0.004, 0.004, s);
      }
      void main(){
        vec3 rd = normalize(vDir), ro = uCamPos;
        float dep = texture(uDepth, vUv).r;
        float maxT = uMaxDist;
        if (dep < 0.99999) maxT = min(maxT, viewDistFromDepth(dep) / max(dot(rd, uCamFwd), 0.05));
        // ray segment inside the cloud shell (curved Earth)
        float A = dot(rd.xz, rd.xz)/(2.0*REFF), B = rd.y + dot(ro.xz, rd.xz)/REFF;
        float top = uTropo + 1500.0;
        float C = alt(ro) - top;
        float disc = B*B - 4.0*A*C;
        float tTop = A > 1e-12 ? (-B + sqrt(max(disc, 0.0)))/(2.0*A) : (rd.y > 0.0 ? -C/rd.y : 1e9);
        float t1 = min(maxT, tTop);
        float t0 = 0.0;
        if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
        int N = int(uSteps);
        float jit = fract(ign(gl_FragCoord.xy) + float(int(uFrame) % 64)*0.61803398875);   // golden-ratio sequence: decorrelated frame to frame
        vec3 col = vec3(0.0); float T = 1.0, dsum = 0.0, wsum = 0.0;
        float cs = dot(rd, uSunDir), cm = dot(rd, uMoonDir);
        float phS = mix(hg(cs, 0.8), hg(cs, -0.25), 0.4), phM = mix(hg(cm, 0.8), hg(cm, -0.25), 0.4);
        vec3 skyTop = skyL(vec3(0.0, 1.0, 0.0)), skyHz = hazeLx(rd, true);   // haze in front of a cloud: lower air only
        float prev = t0;
        for (int i = 1; i <= 128; i++){
          if (i > N || T < 0.01) break;
          float f = (float(i) - 1.0 + jit)/float(N);
          float t = t0 + (t1 - t0)*f*f;
          float dt = t - prev; prev = t;
          vec3 p = ro + rd*t;
          float ps, ice;
          float sig = density(p, true, ps, ice);
          if (sig <= 1e-7) continue;
          float a = alt(p);
          // light march toward Sun and Moon (shared), cheap density
          vec3 Ldir = uSunDir.y > -0.2 ? uSunDir : uMoonDir;
          float od = 0.0, ls = 120.0;
          for (int k = 0; k < 5; k++){ float pp, ii; vec3 q = p + Ldir*ls*(float(k)+0.5); od += density(q, false, pp, ii)*ls; ls *= 1.9; }
          float Tl = max(exp(-od), 0.75*exp(-od*0.25)) ; // multiple-scattering octave
          float powder = 1.0 - 0.6*exp(-sig*400.0);
          vec3 sun = lightAt(uSunDir, uSunE, a) * phS, moon = lightAt(uMoonDir, uMoonE, a) * phM;
          vec3 direct = (uSunDir.y > -0.2 ? sun*Tl + moon*0.6 : moon*Tl + sun*0.2) * uExposure * powder;
          // ambient: sky above, ground below (sunlit/moonlit ground and city light)
          float hf = clamp((a - uLowBase)/max(uHighTop - uLowBase, 1.0), 0.0, 1.0);
          vec2 fuv = p.xz/(2.0*uFluxHalf) + 0.5;
          vec3 fl = texture(uFlux, fuv).rgb;
          float lvl = clamp(a/6000.0, 0.0, 1.0);
          float fluxEnc = mix(mix(fl.r, fl.g, smoothstep(0.0, 0.3, lvl)), fl.b, smoothstep(0.3, 1.0, lvl));
          float flux = (pow(10.0, fluxEnc*3.0) - 1.0) * step(abs(fuv.x - 0.5), 0.5) * step(abs(fuv.y - 0.5), 0.5);
          vec3 cityUp = vec3(1.0, 0.78, 0.55) * flux * uFluxScale * uFluxSnow * uExposure;
          vec3 groundUp = (uSunE*max(uSunDir.y, 0.0)*directT(uSunDir.y) + uMoonE*max(uMoonDir.y,0.0)*directT(uMoonDir.y)) * uGroundAlb / PI * uExposure;
          vec3 amb = mix((groundUp + cityUp)*1.0, skyTop*1.2*(0.12 + 0.88*exp(-od*0.08)), hf*0.7 + 0.15) * mix(1.0, 0.6, ice);
          amb += cityUp * (1.0 - hf) * 0.6;
          // lightning inside the cloud
          float fd = length(p - uFlash.xyz);
          vec3 flash = vec3(0.85, 0.88, 1.0) * uFlash.w * exp(-fd/2200.0);
          vec3 S = sig * (direct + amb + flash);
          if (ps > 0.0) S = sig * (amb*0.9 + direct*0.25 + flash);   // rain shafts: grey, dimly lit
          float stepT = exp(-sig*dt);
          vec3 Sint = (S - S*stepT)/sig;
          col += T * Sint;
          float w = T*(1.0 - stepT); dsum += w*t; wsum += w;
          T *= stepT;
        }
        // distant clouds sink into the haze
        float dm = wsum > 0.0 ? dsum/wsum : 0.0;
        float e = exp(-dm * 3.912/max(uVisKm*1000.0*1.6, 2000.0));
        if (T < 0.02) T = 0.0;     // opaque: nothing behind (the Sun disc must not leak through)
        vec3 cMean = col/max(1.0 - T, 1e-3);
        col = col*e + (1.0 - T)*mix(skyHz, cMean, 0.6)*(1.0 - e);
        if (!(T >= 0.0 && T <= 1.0)) T = 1.0;
        col = vec3(col.r >= 0.0 ? min(col.r, 3.0e4) : 0.0, col.g >= 0.0 ? min(col.g, 3.0e4) : 0.0, col.b >= 0.0 ? min(col.b, 3.0e4) : 0.0);
        gl_FragColor = vec4(col, T);
      }`,
  });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  return { scene, mat };
}

// Build the two weather textures for the cloud domain from layer data.
// fields: functions of (x, z) metres -> {low, mid, high, storm, cumuliform, precip, lowTopAbove, stormTop}
export function weatherTextures(N, half, fieldFn) {
  const a = new Uint8Array(N * N * 4), b = new Uint8Array(N * N * 4);
  const c = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) * 2 - 1) * half, z = (j / (N - 1) * 2 - 1) * half;
    const f = fieldFn(x, z), k = (j * N + i) * 4;
    a[k] = c(f.low); a[k + 1] = c(f.mid); a[k + 2] = c(f.high); a[k + 3] = c(f.storm);
    b[k] = c(f.cumuliform); b[k + 1] = c(f.precip); b[k + 2] = c(f.lowThick / 6000); b[k + 3] = c(f.stormTop / 20000);
  }
  const mk = d => { const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t; };
  return [mk(a), mk(b)];
}
