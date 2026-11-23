// GLSL for the system view. Kept separate from scene.js so the shaders can be
// compile-checked without three.js (see test/shaders.check.mjs).
// three.js injects: projectionMatrix, modelViewMatrix, modelMatrix, normalMatrix,
// cameraPosition, and the attributes position / normal / uv.

const NOISE = /* glsl */ `
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5; float s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
`;

export const starVert = /* glsl */ `
varying vec3 vN; varying vec3 vView; varying vec3 vObj;
void main(){
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

// The disc brightness is the same Claret law the light curve model integrates,
// evaluated per pixel from mu = cos(angle between surface normal and viewer).
export const starFrag = /* glsl */ `
precision highp float;
uniform vec4 uLD; uniform vec3 uColor; uniform float uTime; uniform float uGran; uniform float uFlat; uniform float uOrtho;
uniform float uRot; uniform vec2 uSpin;   // Rossiter-McLaughlin view: strength (0 off) and (cos lambda, sin lambda)
varying vec3 vN; varying vec3 vView; varying vec3 vObj;
${NOISE}
void main(){
  vec3 V = mix(normalize(vView), vec3(0.0, 0.0, 1.0), uOrtho);
  float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
  float sm = sqrt(mu);
  // Claret law: 1 - sum a_n (1 - mu^(n/2))
  float I = max(1.0 - uLD.x * (1.0 - sm) - uLD.y * (1.0 - mu) - uLD.z * (1.0 - mu * sm) - uLD.w * (1.0 - mu * mu), 0.0);
  vec3 col;
  if (uFlat > 0.5) {
    // schematic: iso-intensity contours of the limb darkening profile, every 10%
    float x = I * 10.0;
    float band = floor(x + 0.5) / 10.0;
    float e = abs(fract(x + 0.5) - 0.5);
    float line = (1.0 - smoothstep(0.0, 0.09, e)) * step(I, 0.96);
    col = mix(vec3(0.02, 0.07, 0.12), uColor * 0.5, band * band) + vec3(0.45, 0.9, 1.0) * line * 0.6;
  } else {
    float g = fbm(vObj * 24.0 + vec3(0.0, uTime * 0.05, uTime * 0.035));
    float c = noise(vObj * 70.0 + vec3(uTime * 0.2));
    float b = I * (1.0 + uGran * ((g - 0.5) * 0.30 + (c - 0.5) * 0.10));
    // cooler, redder light from the limb: we see shallower, cooler layers there
    vec3 limbTint = mix(vec3(1.0, 0.50, 0.22), vec3(1.0), pow(I, 0.8));
    col = uColor * limbTint * b * 1.1;
    col = mix(col, vec3(1.0, 0.98, 0.94), smoothstep(0.93, 1.2, b) * 0.35);
  }
  // the star's rotation, as the RM model has it (src/core/rm.js, sky frame): v = v sin i (x cos lambda - y sin lambda),
  // positive away from us. Approaching side blue, receding side red, scaled by the line-of-sight speed.
  if (uRot > 0.0) {
    vec3 p = normalize(vObj);
    float v = p.x * uSpin.x - p.y * uSpin.y;
    vec3 tint = v > 0.0 ? vec3(1.0, 0.32, 0.25) : vec3(0.3, 0.55, 1.0);
    col = mix(col, tint * max(I, 0.25) * 1.2, uRot * min(abs(v), 1.0) * 0.75);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export const glowVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// billboard corona; uScale = quad width in stellar radii
export const glowFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uScale; uniform float uStrength; uniform float uTime;
varying vec2 vUv;
${NOISE}
void main(){
  vec2 p = (vUv - 0.5) * uScale;
  float r = max(length(p), 1.0);
  float ang = atan(p.y, p.x);
  float rays = 0.75 + 0.5 * noise(vec3(cos(ang) * 3.0, sin(ang) * 3.0, uTime * 0.05 + r * 0.35));
  float a = exp(-(r - 1.0) * 2.4) * 0.42 + 0.16 * rays / (r * r);
  a *= smoothstep(uScale * 0.5, uScale * 0.3, r) * uStrength;
  gl_FragColor = vec4(uColor * a, a);
}`;

export const planetVert = /* glsl */ `
varying vec3 vNw; varying vec3 vWorld; varying vec3 vObj;
void main(){
  vObj = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNw = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Lit by the star at the origin, so the side facing the observer is dark
// during transit, as it should be.
export const planetFrag = /* glsl */ `
precision highp float;
uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uColC; uniform vec3 uAtmo;
uniform float uBands; uniform float uFlat; uniform float uSeed; uniform vec3 uViewDir; uniform float uOrtho;
uniform sampler2D uMap; uniform float uMapOn; uniform vec3 uSub; uniform vec3 uNorth;
varying vec3 vNw; varying vec3 vWorld; varying vec3 vObj;
${NOISE}
void main(){
  vec3 N = normalize(vNw);
  vec3 L = normalize(-vWorld);
  vec3 V = mix(normalize(cameraPosition - vWorld), uViewDir, uOrtho);
  float ndl = dot(N, L);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  vec3 col;
  if (uFlat > 0.5) {
    col = mix(vec3(0.02, 0.05, 0.08), vec3(0.45, 0.9, 1.0), smoothstep(0.35, 1.0, rim) * 0.9 + 0.08 * step(0.0, ndl));
  } else {
    float n = fbm(vec3(vObj.x * 2.0, vObj.y * 7.0, vObj.z * 2.0) + uSeed);
    float t = sin(vObj.y * uBands + n * 5.0) * 0.5 + 0.5;
    float s = fbm(vObj * 5.0 + uSeed * 1.7);
    vec3 base = mix(uColA, uColB, smoothstep(0.25, 0.75, t));
    base = mix(base, uColC, smoothstep(0.55, 0.8, s) * 0.6);
    float diff = smoothstep(-0.08, 0.55, ndl);
    col = base * (0.012 + diff * 1.05);
    col += uAtmo * rim * (0.08 + 0.9 * smoothstep(-0.35, 0.3, ndl));
  }
  if (uMapOn > 0.5 && uFlat < 0.5) {
    // the fitted brightness map, glowing on its own (thermal emission), fixed to the substellar point (uSub, toward the
    // star) and the orbit's pole (uNorth): longitude east = the way the surface turns, as in the Map view's globes
    vec3 E = normalize(cross(uNorth, uSub));
    float lon = atan(dot(N, E), dot(N, uSub)), lat = asin(clamp(dot(N, uNorth), -1.0, 1.0));
    vec3 m = texture2D(uMap, vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5)).rgb;
    float mu = clamp(dot(N, V), 0.0, 1.0);
    col = m * (0.6 + 0.5 * mu) + uAtmo * rim * 0.04;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export const haloFrag = /* glsl */ `
precision highp float;
uniform vec3 uAtmo; uniform vec3 uViewDir; uniform float uOrtho;
varying vec3 vNw; varying vec3 vWorld; varying vec3 vObj;
void main(){
  vec3 N = normalize(vNw);
  vec3 V = mix(normalize(cameraPosition - vWorld), uViewDir, uOrtho);
  float f = pow(clamp(-dot(N, V), 0.0, 1.0), 1.6) * 2.2;
  float lit = smoothstep(-0.45, 0.25, dot(N, normalize(-vWorld)));
  float a = f * (0.06 + lit);
  gl_FragColor = vec4(uAtmo * a, a);
}`;

export const tubeVert = glowVert;
export const tubeFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uStrength;
varying vec2 vUv;
void main(){
  float a = uStrength * (1.0 - vUv.y) * (0.6 + 0.4 * step(0.5, fract(vUv.y * 40.0)));
  gl_FragColor = vec4(uColor * a, a);
}`;

// Habitable zone annulus: per-vertex membership (0..1) from the radial profile,
// broken up with noise so it reads as a soft band rather than a hard ring.
export const hzVert = /* glsl */ `
attribute float aAlpha;
varying float vAlpha; varying vec3 vObj;
void main(){ vAlpha = aAlpha; vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const hzFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor; uniform float uStrength; uniform float uScale;
varying float vAlpha; varying vec3 vObj;
${NOISE}
void main(){
  float n = fbm(vObj * uScale);
  float a = vAlpha * uStrength * (0.55 + 0.9 * n);
  gl_FragColor = vec4(uColor * a, a);
}`;

// ---- Atmosphere page (src/atmosphere/view3d.js) ------------------------------------------------------------------
// Colours arrive in linear sRGB and are encoded here (the renderer's output colour space is set to linear, so
// nothing else converts them).
const SRGB = /* glsl */ `
vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
`;
export const atmoVert = /* glsl */ `
varying vec3 vN; varying vec3 vView; varying vec2 vUv; varying vec3 vWorldN;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
/** The star: colour from centre to limb out of a strip texture indexed by mu (src/core/colour.js, stellarLimbColours). */
export const atmoStarFrag = /* glsl */ `
precision highp float;
uniform sampler2D uLimb; uniform float uGain;
varying vec3 vN; varying vec3 vView;
${SRGB}
void main(){
  float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
  vec3 c = texture2D(uLimb, vec2((mu - 0.02) / 0.98, 0.5)).rgb;
  gl_FragColor = vec4(toSRGB(c * uGain), 1.0);
}`;
/**
 * The planet in transit, a disc facing the viewer drawn with multiply blending: black inside the opaque radius,
 * and in the ring above it the factor by which the atmosphere dims each colour of the starlight behind
 * (src/viz/atmoview.js, limbTexture). uInner: opaque radius over the disc radius, after any stretch of the ring.
 */
export const atmoLimbFrag = /* glsl */ `
precision highp float;
uniform sampler2D uTrans; uniform float uInner;
varying vec2 vUv;
void main(){
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) discard;
  vec3 t = r < uInner ? vec3(0.0) : texture2D(uTrans, vec2((r - uInner) / max(1.0 - uInner, 1e-5), 0.5)).rgb;
  // the factors multiply light that is already sRGB-encoded on screen: encode them the same way (a power law keeps 0 and 1)
  gl_FragColor = vec4(pow(clamp(t, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;
/** The cut face of the planet: a radial strip of colours, centre to edge (src/viz/atmoview.js, radialStrip). */
export const atmoFaceFrag = /* glsl */ `
precision highp float;
uniform sampler2D uStrip; uniform sampler2D uStripNight; uniform vec2 uDayDir;
varying vec2 vUv;
void main(){
  vec2 q = vUv - 0.5; float r = length(q) * 2.0;
  if (r > 1.0) discard;
  // the day side's strip toward the star, the night side's away from it, blended by the cosine of the angle between
  float w = 0.5 + 0.5 * dot(q / max(length(q), 1e-6), uDayDir);
  gl_FragColor = vec4(mix(texture2D(uStripNight, vec2(r, 0.5)).rgb, texture2D(uStrip, vec2(r, 0.5)).rgb, w), 1.0);
}`;
/**
 * The planet's outside: the day side in the colour it reflects and emits, lit as a Lambert sphere from uStar, the
 * night side in its own thermal glow. Colours linear sRGB; uDay and uNight already carry their relative brightness.
 */
export const atmoSurfaceFrag = /* glsl */ `
precision highp float;
uniform vec3 uDay; uniform vec3 uNight; uniform vec3 uStar;
varying vec3 vWorldN;
${SRGB}
void main(){
  float lit = max(dot(normalize(vWorldN), normalize(uStar)), 0.0);
  gl_FragColor = vec4(toSRGB(uDay * lit + uNight), 1.0);
}`;

/**
 * The ray-marched planet of the Atmosphere page: one full-screen pass. For every pixel a ray from the camera is
 * followed through the atmosphere's shell (radius uInner to 1); at each step the extinction and scattering
 * coefficients of the model are read from two strips (src/viz/atmoview.js, shellTextures), the starlight reaching
 * the step is attenuated along a second ray toward the star (and is zero in the planet's shadow), and what is
 * scattered toward the camera is added up. Behind the shell: the star's disc (limb-darkened, dimmed by the
 * transmittance of the ray: the ring seen in transit), or the opaque interior (its own glow plus reflected light).
 * Radiances are in units of the star's central surface brightness; uExposure and 1 - exp(-x) bring them on screen.
 * Single scattering only, a point-like star for the shadow, straight rays (no refraction).
 */
export const atmoPlanetVert = /* glsl */ `
varying vec2 vNdc;
void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
export const atmoPlanetFrag = /* glsl */ `
precision highp float;
varying vec2 vNdc;
uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec3 uCam;
uniform sampler2D uExt; uniform sampler2D uSca; uniform sampler2D uStarLimb;
uniform float uN; uniform float uInner; uniform vec3 uStarDir; uniform float uStarDist; uniform float uStarR;
uniform vec3 uThermal; uniform vec3 uThermalNight; uniform vec3 uSurface; uniform float uExposure; uniform float uHenyey;
${SRGB}
const int STEPS = 40; const int SUN = 8; const float PI = 3.14159265;
vec2 sphere(vec3 o, vec3 d, float R){   // distances along the ray to the sphere of radius R about the origin; x > y: missed
  // the discriminant from the ray's distance to the centre (a cross product): stable when the camera is far away
  float b = dot(o, d); vec3 x = cross(o, d); float h = R * R - dot(x, x);
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h); return vec2(-b - h, -b + h);
}
vec3 strip(sampler2D t, float r){   // linear interpolation by hand: float textures are sampled nearest
  float x = clamp((r - uInner) / (1.0 - uInner), 0.0, 1.0) * uN - 0.5, i = floor(x), f = x - i;
  vec3 a = texture2D(t, vec2((clamp(i, 0.0, uN - 1.0) + 0.5) / uN, 0.5)).rgb, b = texture2D(t, vec2((clamp(i + 1.0, 0.0, uN - 1.0) + 0.5) / uN, 0.5)).rgb;
  return mix(a, b, f);
}
vec3 sunlight(vec3 p){   // transmittance from p to the star; zero behind the opaque interior
  vec2 core = sphere(p, uStarDir, uInner);
  if (core.x < core.y && core.y > 0.0) return vec3(0.0);
  float far = sphere(p, uStarDir, 1.0).y; if (far <= 0.0) return vec3(1.0);
  float ds = far / float(SUN); vec3 tau = vec3(0.0);
  for (int i = 0; i < SUN; i++) tau += strip(uExt, length(p + uStarDir * (float(i) + 0.5) * ds)) * ds;
  return exp(-tau);
}
float gStarT;   // distance along the ray to the star's surface (set by starDisc; negative: missed)
vec3 starDisc(vec3 o, vec3 d){   // the star where the ray meets it, else black
  vec3 c = uStarDir * uStarDist; vec3 oc = o - c; float b = dot(oc, d); vec3 x = cross(oc, d); float h = uStarR * uStarR - dot(x, x);
  gStarT = -1.0;
  if (h < 0.0 || -b < 0.0) return vec3(0.0);
  gStarT = -b - sqrt(h);
  vec3 n = normalize(oc + d * gStarT); float mu = clamp(dot(n, -d), 0.0, 1.0);
  return texture2D(uStarLimb, vec2(mu, 0.5)).rgb;
}
void main(){
  vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0); vec3 d = normalize((uCamWorld * vec4(normalize(v.xyz / v.w), 0.0)).xyz), o = uCam;
  vec3 L = vec3(0.0), T = vec3(1.0), back = starDisc(o, d);
  vec2 sh = sphere(o, d, 1.0);
  // the star in front of the planet (seen from beyond the star: the planet in eclipse) hides it
  bool hidden = gStarT > 0.0 && sh.x < sh.y && gStarT < max(sh.x, 0.0);
  if (!hidden && sh.x < sh.y && sh.y > 0.0) {
    vec2 core = sphere(o, d, uInner); bool ground = core.x < core.y && core.x > 0.0;
    float t0 = max(sh.x, 0.0), t1 = ground ? core.x : sh.y, ds = (t1 - t0) / float(STEPS);
    // irradiance of the star at the planet, in units of its surface brightness: pi (R*/a)^2
    float E = PI * (uStarR * uStarR) / (uStarDist * uStarDist), c = dot(d, uStarDir), g = uHenyey;
    float ray = 3.0 / (16.0 * PI) * (1.0 + c * c), hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * c, 1.5)), phase = mix(ray, hg, step(0.01, g));
    for (int i = 0; i < STEPS; i++) {
      vec3 p = o + d * (t0 + (float(i) + 0.5) * ds); float r = length(p);
      vec3 ke = strip(uExt, r), ks = strip(uSca, r), dT = exp(-ke * ds);
      // the step's own emission into the beam, integrated exactly over the step
      L += T * ks * E * phase * sunlight(p) * (1.0 - dT) / max(ke, vec3(1e-9));
      T *= dT;
    }
    if (ground) {
      vec3 p = o + d * t1, n = normalize(p);
      // the interior's own glow: the day column's toward the star, the night column's away, blended as on the cutaway
      back = mix(uThermalNight, uThermal, 0.5 + 0.5 * dot(n, uStarDir)) + uSurface * E / PI * max(dot(n, uStarDir), 0.0) * sunlight(p * 1.0005);
    }
  }
  vec3 radiance = L + T * back;
  gl_FragColor = vec4(toSRGB(vec3(1.0) - exp(-uExposure * radiance)), 1.0);
}`;
