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
