// Shared GLSL: sky-view LUT lookup, log-depth decode, noise, transmittance.
// Atmospheric refraction: objects near the horizon look higher than they are (~0.57 deg at the horizon at sea level,
// ~0.1 deg at 10 deg up), and since the lift shrinks with height the Sun and Moon look squashed. uRefrK scales it by
// the air's pressure and temperature at the viewer (1 = 1010 hPa and 10 C): weaker on a mountain or a hot day.
export const refrUniform = { value: 1 };
export const REFR = /* glsl */`
uniform float uRefrK;
// lift (degrees) of an object at true altitude h (Saemundsson), and the lift to remove from an apparent altitude (Bennett)
float refrLift(float h){ float hh = max(h, -1.5); return clamp(1.02/tan(radians(hh + 10.3/(hh + 5.11)))/60.0, 0.0, 0.75)*uRefrK; }
float refrLiftApp(float h){ float hh = max(h, -1.0); return clamp(1.0/tan(radians(hh + 7.31/(hh + 4.4)))/60.0, 0.0, 0.75)*uRefrK; }
vec3 refrSetAlt(vec3 d, float hDeg){ vec2 hz = d.xz; float l = length(hz); hz = l > 1e-6 ? hz/l : vec2(0.0, -1.0); float hr = radians(hDeg); return vec3(hz.x*cos(hr), sin(hr), hz.y*cos(hr)); }
// true direction -> where it is seen; seen direction -> true direction (both unit vectors, world frame, y up)
vec3 refrApparent(vec3 d){ float h = degrees(asin(clamp(d.y, -1.0, 1.0))); return h > 89.0 ? d : refrSetAlt(d, h + refrLift(h)); }
vec3 refrTrue(vec3 d){ float h = degrees(asin(clamp(d.y, -1.0, 1.0))); return h > 89.0 ? d : refrSetAlt(d, h - refrLiftApp(h)); }
`;
export const COMMON = REFR + /* glsl */`
#ifndef PI
#define PI 3.141592653589793
#endif
uniform sampler2D uSkyLUT, uSkyLUTLow;   // pre-exposed sky radiance, u = azimuth/2pi, v = sqrt-altitude mapping
uniform float uExposure;     // luminance (cd/m^2) -> pre-exposed units
uniform vec3 uSunDir, uMoonDir;
uniform vec3 uSunE, uMoonE;  // illuminance at the top of the atmosphere (lux), coloured
uniform float uAOD, uTime, uNight, uSnow, uWet, uVisKm, uOvercast;
uniform vec4 uFlash;         // xyz position (m, world), w = intensity (pre-exposed)
vec2 lutUV(vec3 d){
  float az = atan(d.x, -d.z); if (az < 0.0) az += 2.0*PI;
  float h = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5*sign(h)*sqrt(abs(h)/(0.5*PI));
  return vec2(az/(2.0*PI), v);
}
vec3 skyL(vec3 d){ return texture(uSkyLUT, lutUV(normalize(d))).rgb; }
float airmass(float sinh){ sinh = max(sinh, -0.02); return 1.0/(max(sinh,0.0) + 0.025*exp(-11.0*max(sinh,0.0)) + 0.0001); }
// Broad-band extinction for a direct source at elevation sinh (zenith optical depth per channel).
vec3 directT(float sinh){ vec3 tau = vec3(0.10, 0.17, 0.33) + uAOD*vec3(0.9, 1.0, 1.1); return exp(-tau*min(airmass(sinh), 40.0)); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
float ign(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
// Horizon haze colour. Under a cloud deck it is lit by the dim cloud base, not the open sky,
// and loses the bright forward-scattering glow around the hidden Sun.
// low = true: only light from the lower atmosphere (no airglow, zodiacal light or starlight from beyond the clouds)
vec3 skyS(vec3 d, bool low){ vec2 uv = lutUV(normalize(d)); return low ? texture(uSkyLUTLow, uv).rgb : texture(uSkyLUT, uv).rgb; }
vec3 hazeLx(vec3 dir, bool low){
  vec3 d = normalize(dir);
  vec3 b = 0.5*(skyS(vec3(-uSunDir.x, 0.05, -uSunDir.z) + 1e-4, low) + skyS(vec3(uSunDir.z, 0.05, -uSunDir.x) + 1e-4, low));
  vec3 a;
  float dep = max(-d.y, 0.0);
  if (dep < 0.002) a = skyS(vec3(d.x, max(d.y, 0.01), d.z), low);
  else {
    // Looking down, the haze between us and the ground scatters light from a wide range of directions, not just
    // the horizon straight ahead. Spread the horizon sample in azimuth more the steeper we look, so a low sun or a
    // city's light dome becomes a soft glow over the land instead of a stripe running down to the nadir.
    float az = atan(d.x, -d.z), spread = 2.0*pow(smoothstep(0.0, 0.6, dep), 0.6);
    a = vec3(0.0); float ws = 0.0;
    for (int i = -4; i <= 4; i++) {
      float o = float(i)/4.0, w = 1.0 - 0.6*o*o;
      float az2 = az + o*spread;
      a += skyS(vec3(sin(az2)*0.9999, 0.012, -cos(az2)*0.9999), low) * w; ws += w;
    }
    a /= ws;
    a = mix(a, b, smoothstep(0.3, 0.8, dep));   // steep views: plain side-lit haze, no glow direction left
  }
  return mix(a, b, uOvercast) * (1.0 - 0.78*uOvercast);
}
vec3 hazeL(vec3 dir){ return hazeLx(dir, false); }
// Open water: wind ripples, Fresnel reflection of the sky (and skyglow at night), sun/moon glint.
vec3 waterShade(vec3 W, float rough){
  vec3 V = normalize(W - cameraPosition);
  float t = uTime*0.6;
  vec2 q = W.xz;
  float h1 = fbm2(q*0.08 + vec2(t*0.11, t*0.07)), h2 = fbm2(q*0.35 - vec2(t*0.2, -t*0.13));
  vec2 g = vec2(fbm2(q*0.08 + vec2(0.7, 0.0) + vec2(t*0.11, t*0.07)) - h1, fbm2(q*0.08 + vec2(0.0, 0.7) + vec2(t*0.11, t*0.07)) - h1) * 1.4
         + vec2(fbm2(q*0.35 + vec2(0.4, 0.0) - vec2(t*0.2, -t*0.13)) - h2, fbm2(q*0.35 + vec2(0.0, 0.4) - vec2(t*0.2, -t*0.13)) - h2) * 0.8;
  vec3 n = normalize(vec3(-g.x*rough, 1.0, -g.y*rough));
  float c = max(dot(-V, n), 0.0), F = 0.02 + 0.98*pow(1.0 - c, 5.0);
  vec3 R = reflect(V, n); R.y = abs(R.y);
  vec3 refl = hazeL(R) * (1.0 - uOvercast*0.2);
  vec3 deep = vec3(0.012, 0.022, 0.026) * (skyL(vec3(0.0, 1.0, 0.0)) + (uSunE*max(uSunDir.y, 0.0)*directT(uSunDir.y))*uExposure*0.2/PI);
  vec3 col = mix(deep, refl, F);
  float gs = pow(max(dot(R, uSunDir), 0.0), 600.0) * 40.0, gm = pow(max(dot(R, uMoonDir), 0.0), 400.0) * 40.0;
  col += (uSunE*directT(uSunDir.y)*gs*step(0.0, uSunDir.y) + uMoonE*directT(uMoonDir.y)*gm*step(0.0, uMoonDir.y)) * uExposure * 1e-3 * (1.0 - uOvercast);
  return col;
}
// Aerial perspective: blend toward the horizon sky colour with distance (metres).
vec3 aerial(vec3 col, vec3 dir, float dist){
  float k = 3.912 / max(uVisKm*1000.0, 500.0);
  float f = 1.0 - exp(-dist * k);
  return mix(col, hazeL(dir), f);
}
`;

// log-depth helpers (three's logarithmic depth buffer)
export const LOGDEPTH_DECODE = /* glsl */`
uniform float uLogFar; // log2(far + 1)
float viewDistFromDepth(float d){ return exp2(d * uLogFar) - 1.0; }
`;
