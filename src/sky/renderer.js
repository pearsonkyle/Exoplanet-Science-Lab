// WebGL drawing of the sky view. three.js is used for the GL plumbing (buffers, programs, draw order); the projection
// is our own: a stereographic view of the celestial sphere done in the vertex shaders, so that wide fields
// (up to 140 degrees) keep their shapes, as in Stellarium.
//
// World frame of every shader: x east, y up (zenith), z south. A direction with altitude h and azimuth A (from north
// through east) is (cos h sin A, sin h, -cos h cos A). The view is a 3x3 matrix world -> camera (x right, y up,
// -z forward); a camera vector v maps to the screen at 2 v.xy / (1 - v.z), scaled so that `fov` spans the larger side.
//
// Perspective mode (setMode('perspective')): the same scene, geometry and fragment shaders, but every vertex
// shader is compiled with PERSPECTIVE defined and sends a direction through three.js's own viewMatrix and
// projectionMatrix as a point at distance 1 with the camera's translation dropped (the sky is at infinity). That is
// what WebXR needs: three.js then renders once per eye with the headset's matrices. uView is in that mode the
// rotation about the vertical from our world frame to the XR reference space (the heading). The screen-filling
// passes (sky, ground) get the direction of each pixel from the inverse of the projection instead of from the
// stereographic formula. With ?xrdebug=1 the page uses this mode on the ordinary canvas with a PerspectiveCamera.
import { WebGLRenderer, Scene, Camera, PerspectiveCamera, Matrix3, Matrix4, Vector2, Vector3, Color, ShaderMaterial, BufferGeometry, BufferAttribute, Mesh, Points, LineSegments, NormalBlending, AdditiveBlending, DataTexture, DataUtils, RedFormat, HalfFloatType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping } from 'three';

const COMMON = /* glsl */`
uniform mat3 uView;
uniform vec2 uScale;
const float CULL = -0.8;     // cos of the largest angle from the view centre that is drawn (143 deg)
vec3 refr(vec3 w, float on) {  // Saemundsson refraction, lifting a true direction to the apparent one
  float h = degrees(asin(clamp(w.y, -1.0, 1.0)));
  if (on < 0.5 || h < -2.0) return w;
  float R = radians(1.02 / tan(radians(h + 10.3 / (h + 5.11))) / 60.0) * smoothstep(-2.0, -0.8, h);
  vec3 t = vec3(0.0, 1.0, 0.0) - w * w.y; float l = length(t);
  if (l < 1e-4) return w;
  return normalize(w + t / l * R);
}
#ifdef PERSPECTIVE
vec4 proj(vec3 w, out float c) {
  c = 1.0;
  return projectionMatrix * vec4(mat3(viewMatrix) * (uView * w), 1.0);
}
#else
vec4 proj(vec3 w, out float c) {
  vec3 v = uView * w; c = -v.z;
  return vec4(v.xy * (2.0 / (1.0 + max(c, CULL))) * uScale, 0.0, 1.0);
}
#endif`;

const STAR_VS = /* glsl */`
attribute float aMag; attribute vec3 aColor;
uniform mat3 uFrame; uniform float uMagLimit, uPx, uRefract, uExtinct, uSize;
varying vec3 vColor; varying float vRadius, vHalf, vGlow, vInt;
${COMMON}
void main() {
  vec3 w = refr(normalize(uFrame * position), uRefract);
  float c; gl_Position = proj(w, c);
  float m = aMag;
  if (uExtinct > 0.5) {      // extinction, 0.2 mag per airmass (Rozenberg airmass); none for what is under the ground
    float s = max(w.y, 0.0), X = 1.0 / (s + 0.025 * exp(-11.0 * s));
    m += 0.2 * (X - 1.0) * smoothstep(-0.05, -0.005, w.y);
  }
  float d = uMagLimit - m;
  if (d < 0.0 || c < CULL) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vRadius = (0.70 + 0.30 * d + 0.034 * d * d) * uSize * uPx;
  vGlow = smoothstep(3.0, 7.5, d);
  vHalf = vRadius * (1.0 + 2.6 * vGlow) + 1.5 * uPx;
  vInt = clamp(0.38 + 0.50 * d, 0.0, 1.0);
  vColor = aColor;
  gl_PointSize = 2.0 * vHalf;
}`;
const STAR_FS = /* glsl */`
varying vec3 vColor; varying float vRadius, vHalf, vGlow, vInt;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0 * vHalf;
  float core = 1.0 - smoothstep(vRadius * 0.45, vRadius + 0.75, r);     // soft disc
  float halo = vGlow * 0.42 * exp(-1.9 * r / vRadius) + vGlow * 0.06 * max(0.0, 1.0 - r / vHalf);
  vec3 col = mix(vColor, vec3(1.0), 0.18 * core * core) * core * vInt + vColor * halo;
  gl_FragColor = vec4(col, 1.0);
}`;

const LINE_VS = /* glsl */`
attribute vec3 aOther; attribute float aA;
uniform mat3 uFrame; uniform float uRefract;
varying float vA;
${COMMON}
void main() {
  float c, c2; gl_Position = proj(refr(normalize(uFrame * position), uRefract), c);
  proj(normalize(uFrame * aOther), c2);
  // a segment is dropped whole when either end is near the point opposite the view centre, where the projection diverges
  if (min(c, c2) < CULL) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vA = aA;
}`;
const LINE_FS = /* glsl */`
uniform vec3 uColor; uniform float uAlpha; varying float vA;
void main() { gl_FragColor = vec4(uColor, uAlpha * vA); }`;

const SCREEN_VS = /* glsl */`
varying vec2 vNdc; varying vec3 vRay;
void main() {
  vNdc = position.xy; vRay = vec3(0.0);
#ifdef PERSPECTIVE
  // the camera-space ray through this corner (works for the off-centre projections of a headset), turned to the
  // reference space; interpolating it across the triangle is exact because it is linear in the screen position
  vec3 r = vec3((position.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (position.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0);
  vRay = r * mat3(viewMatrix);
#endif
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
const UNPROJECT = /* glsl */`
uniform mat3 uView; uniform vec2 uScale; varying vec2 vNdc; varying vec3 vRay;
#ifdef PERSPECTIVE
vec3 worldDir() { return normalize(vRay) * uView; }
#else
vec3 worldDir() {
  vec2 p = vNdc / uScale; float q = dot(p, p), c = (4.0 - q) / (4.0 + q);
  return vec3(p * (1.0 + c) * 0.5, -c) * uView;       // v * M = transpose(M) * v
}
#endif`;
// A small analytic sky: a zenith-to-horizon gradient scaled by how much daylight is left, a warm band toward the Sun
// in twilight, an aureole around the Sun, and a faint night floor. Tuned by eye against photographs, not a
// radiative-transfer model.
const SKY_FS = /* glsl */`
${UNPROJECT}
uniform vec3 uSun; uniform float uDay, uGlow, uDusk;
void main() {
  vec3 w = worldDir();
  float h = max(w.y, 0.0), below = smoothstep(0.0, -0.12, w.y);
  float cg = dot(w, uSun);
  vec3 zen = vec3(0.09, 0.24, 0.60), hor = vec3(0.50, 0.66, 0.90);
  vec3 day = mix(hor, zen, pow(h, 0.45));
  day += vec3(1.0, 0.93, 0.80) * (0.22 * pow(max(cg, 0.0), 6.0) + 0.9 * pow(max(cg, 0.0), 90.0));
  vec3 col = day * uDay;
  vec2 a = normalize(w.xz + 1e-5), s = normalize(uSun.xz + 1e-5);
  float toward = 0.5 + 0.5 * dot(a, s);
  vec3 warm = mix(vec3(0.95, 0.36, 0.10), vec3(0.98, 0.70, 0.38), clamp(h * 4.0, 0.0, 1.0));
  col += warm * uGlow * exp(-h * 6.5) * (0.12 + 0.88 * pow(toward, 4.0));
  col += vec3(0.035, 0.07, 0.19) * uDusk * (0.55 + 0.45 * toward) * (1.0 - 0.6 * h);       // the blue of deep twilight
  col += vec3(0.010, 0.014, 0.028) * (1.0 + 1.6 * exp(-h * 7.0));                           // night floor, brighter at the horizon
  col *= mix(1.0, 0.35, below);
  gl_FragColor = vec4(1.0 - exp(-1.9 * col), 1.0);
}`;
const GROUND_FS = /* glsl */`
${UNPROJECT}
uniform float uAlpha, uDay, uPixel, uTerrain;
uniform sampler2D uHorizon;      // apparent horizon altitude in radians against azimuth / 2 pi (one row, linear, repeating)
void main() {
  vec3 w = worldDir();
  float alt = asin(clamp(w.y, -1.0, 1.0));
  if (uTerrain > 0.5 && alt < 0.6) alt -= texture2D(uHorizon, vec2(atan(w.x, -w.z) / 6.283185307, 0.5)).r;
  float edge = smoothstep(uPixel, -uPixel, alt);
  if (edge <= 0.0) discard;
  float depth = clamp(-alt / 1.2, 0.0, 1.0);
  vec3 col = mix(vec3(0.060, 0.068, 0.058), vec3(0.022, 0.026, 0.024), sqrt(depth));
  col += uDay * mix(vec3(0.20, 0.23, 0.16), vec3(0.09, 0.12, 0.07), sqrt(depth));
  col += vec3(0.10, 0.12, 0.14) * (0.3 + 0.7 * uDay) * exp(alt * 30.0);          // haze just under the horizon
  gl_FragColor = vec4(col, uAlpha * edge);
}`;

const POINT_VS = /* glsl */`
attribute float aSize; attribute vec4 aColor;
uniform mat3 uFrame; uniform float uPx, uRefract;
varying vec4 vColor; varying float vHalf;
${COMMON}
void main() {
  float c; gl_Position = proj(refr(normalize(uFrame * position), uRefract), c);
  if (c < CULL || aSize <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vColor = aColor; vHalf = aSize * uPx; gl_PointSize = 2.0 * vHalf;
}`;
// uStyle 0: soft dot, 1: ring (host stars; dashed for candidates), 2: Sun (disc and glow), 3: Moon (lit by uLight)
const POINT_FS = /* glsl */`
uniform float uStyle, uPx, uDark; uniform vec3 uLight;
varying vec4 vColor; varying float vHalf;
void main() {
  vec2 uv = (gl_PointCoord - 0.5) * 2.0; uv.y = -uv.y;
  float r = length(uv), px = r * vHalf;
  if (uStyle < 0.5) { gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(vHalf * 0.45, vHalf, px))); }
  else if (uStyle < 1.5) {     // a ring; dashed (eight dashes) when the alpha is below 0.925: the TESS candidates
    float w = 0.9 * uPx, dash = vColor.a < 0.925 ? smoothstep(-0.25, 0.25, sin(atan(uv.y, uv.x) * 8.0)) : 1.0;
    gl_FragColor = vec4(vColor.rgb, vColor.a * dash * (1.0 - smoothstep(w * 0.5, w * 1.4, abs(px - (vHalf - 1.6 * uPx))))); }
  else if (uStyle < 2.5) {     // the disc fills a quarter of the sprite, the rest is glow
    float disc = 1.0 - smoothstep(0.25 - 1.0 / vHalf, 0.25 + 1.0 / vHalf, r);
    float glow = 0.55 * exp(-(r - 0.25) * 7.0) * (1.0 - smoothstep(0.7, 1.0, r));
    gl_FragColor = vec4(mix(vColor.rgb, vec3(1.0), disc * 0.6), max(disc, glow) * vColor.a);
  } else {                     // the disc fills two thirds of the sprite
    float R = 0.667, q = r / R;
    float disc = 1.0 - smoothstep(1.0 - 1.5 / (vHalf * R), 1.0, q);
    vec3 n = vec3(uv / R, sqrt(max(0.0, 1.0 - q * q)));
    float lit = smoothstep(-0.03, 0.10, dot(n, uLight));
    vec3 col = mix(vec3(0.055, 0.065, 0.085), vColor.rgb * (0.80 + 0.20 * n.z), lit);
    // the unlit part hides the stars at night and lets the daytime sky through (uDark = 1 at night)
    float glow = 0.10 * uDark * (0.5 + 0.5 * uLight.z) * exp(-(q - 1.0) * 5.0) * step(1.0, q) * (1.0 - smoothstep(1.3, 1.5, q));
    gl_FragColor = vec4(mix(vColor.rgb, col, disc), max(disc * mix(0.92 * uDark, 1.0, lit), glow) * vColor.a);
  }
}`;

// The markers of the stars with planets: one shape per discovery group (discovery.js shapeSvg draws the same for the
// page): 0 ring, 1 ring crossed by a bar (transit), 2 square, 3 diamond, 4 triangle, 5 dashed ring. A line of uLine
// CSS pixels with a dark rim on both sides, so that the marker stands out on the Milky Way and keeps its shape when a
// filter turns everything one hue (the Night theme). The shape fills (vHalf - rim) of the sprite.
const HOST_VS = /* glsl */`
attribute float aSize, aShape; attribute vec4 aColor;
uniform mat3 uFrame; uniform float uPx, uRefract;
varying vec4 vColor; varying float vHalf, vShape;
${COMMON}
void main() {
  float c; gl_Position = proj(refr(normalize(uFrame * position), uRefract), c);
  if (c < CULL || aSize <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vColor = aColor; vShape = aShape; vHalf = aSize * uPx; gl_PointSize = 2.0 * vHalf;
}`;
const HOST_FS = /* glsl */`
uniform float uPx, uLine;
varying vec4 vColor; varying float vHalf, vShape;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * 2.0 * vHalf; p.y = -p.y;      // pixels from the centre, y up
  float rim = 1.6 * uPx, ext = vHalf - rim - 0.5 * uLine * uPx, R = 0.74 * ext, r = length(p), d;
  if (vShape < 0.5 || vShape > 4.5) d = abs(r - R);
  else if (vShape < 1.5) d = min(abs(r - R), max(abs(p.y), abs(p.x) - ext));
  else if (vShape < 2.5) d = abs(max(abs(p.x), abs(p.y)) - 0.86 * R);
  else if (vShape < 3.5) d = abs((abs(p.x) + abs(p.y)) * 0.7071 - 0.80 * R);
  else d = abs(max(-p.y, max(dot(p, vec2(0.866, 0.5)), dot(p, vec2(-0.866, 0.5)))) - 0.56 * R);
  float w = 0.5 * uLine * uPx;
  float line = 1.0 - smoothstep(w - 0.6, w + 0.6, d), halo = 1.0 - smoothstep(w + rim * 0.5, w + rim, d);
  if (vShape > 4.5) line *= smoothstep(-0.3, 0.3, sin(atan(p.y, p.x) * 8.0));      // dashed: the TESS candidates
  float a = max(line, 0.6 * halo);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(mix(vec3(0.0, 0.01, 0.03), vColor.rgb, line / max(a, 1e-3)), a * vColor.a);
}`;

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** B-V colour index to a display colour: Ballesteros' temperature, a black-body fit, then pulled toward white. */
export function bvToRgb(bv, whiten = 0.08) {
  if (!(bv > -1 && bv < 5)) bv = 0.6;
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const t = 46 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));       // temperature / 100 K
  let r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  let g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  let b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const m = Math.max(r, g, b, 1);
  return [r, g, b].map((v) => whiten + (1 - whiten) * Math.max(0, Math.min(255, v)) / m);
}

/** Split the great-circle arc a -> b (unit vectors) into pieces of at most `step` radians; pushes segment end pairs. */
function arcSegments(a, b, step, out) {
  const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))), n = Math.max(1, Math.ceil(d / step)), s = Math.sin(d) || 1;
  let p = a;
  for (let i = 1; i <= n; i++) {
    const f = i / n, k1 = Math.sin((1 - f) * d) / s, k2 = Math.sin(f * d) / s;
    const q = i === n ? b : [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
    out.push(p, q); p = q;
  }
}
function lineGeometry(pairs, alphas) {
  const n = pairs.length, pos = new Float32Array(n * 3), oth = new Float32Array(n * 3), al = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos.set(pairs[i], i * 3); oth.set(pairs[i ^ 1], i * 3); al[i] = alphas ? alphas[i >> 1] : 1; }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3)); g.setAttribute('aOther', new BufferAttribute(oth, 3)); g.setAttribute('aA', new BufferAttribute(al, 1));
  return g;
}
/** A graticule in a frame whose pole is +z (x toward longitude 0): parallels every `dLat`, meridians every `dLon` degrees. */
function graticule(dLat, dLon, toVec) {
  const pairs = [], alphas = [], R = Math.PI / 180, step = 2;
  for (let lat = -90 + dLat; lat < 90; lat += dLat) for (let lon = 0; lon < 360; lon += step) { pairs.push(toVec(lon * R, lat * R), toVec((lon + step) * R, lat * R)); alphas.push(lat === 0 ? 2.2 : 1); }
  for (let lon = 0; lon < 360; lon += dLon) for (let lat = -90; lat < 90; lat += step) { pairs.push(toVec(lon * R, lat * R), toVec(lon * R, (lat + step) * R)); alphas.push(lon % 90 === 0 ? 1.5 : 1); }
  return lineGeometry(pairs, alphas);
}

export function createSkyRenderer(canvas) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x010207, 1);
  const scene = new Scene(), camera = new Camera(), pcam = new PerspectiveCamera(60, 1, 0.01, 1000);
  pcam.matrixAutoUpdate = false;
  const materials = [];
  let mode = 'stereo', fovY = 1;
  const shared = { uView: { value: new Matrix3() }, uScale: { value: new Vector2(1, 1) }, uPx: { value: 1 } };
  const m3 = (a = IDENTITY) => new Matrix3().set(...a);
  const mat = (vs, fs, uniforms, blending = NormalBlending) => { const m = new ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...shared, ...uniforms }, blending, transparent: true, depthTest: false, depthWrite: false }); if (mode === 'perspective') m.defines = { PERSPECTIVE: 1 }; materials.push(m); return m; };
  const add = (obj, order) => { obj.frustumCulled = false; obj.renderOrder = order; scene.add(obj); return obj; };

  const tri = new BufferGeometry(); tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const sky = add(new Mesh(tri, mat(SCREEN_VS, SKY_FS, { uSun: { value: new Vector3(0, -1, 0) }, uDay: { value: 0 }, uGlow: { value: 0 }, uDusk: { value: 0 } })), 0);
  const flatHorizon = new DataTexture(new Uint16Array([0, 0]), 2, 1, RedFormat, HalfFloatType); flatHorizon.needsUpdate = true;
  const ground = add(new Mesh(tri, mat(SCREEN_VS, GROUND_FS, { uAlpha: { value: 1 }, uDay: { value: 0 }, uPixel: { value: 0.001 }, uTerrain: { value: 0 }, uHorizon: { value: flatHorizon } })), 60);

  const lineMat = (color) => mat(LINE_VS, LINE_FS, { uFrame: { value: m3() }, uRefract: { value: 0 }, uColor: { value: new Color(color) }, uAlpha: { value: 0.5 } });
  const toAzAlt = (az, alt) => [Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)];
  const toEq = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const azGrid = add(new LineSegments(graticule(10, 15, toAzAlt), lineMat(0x4f8f6a)), 10);
  const eqGrid = add(new LineSegments(graticule(10, 15, toEq), lineMat(0x4a7fc0)), 11);
  let conLines = null, stars = null, hosts = null, track = null, horizonTex = null;
  const lines = new Map();

  const starMat = (frame) => mat(STAR_VS, STAR_FS, { uFrame: { value: m3(frame) }, uMagLimit: { value: 6 }, uRefract: { value: 0 }, uExtinct: { value: 0 }, uSize: { value: 1 } }, AdditiveBlending);
  const pointMat = (style) => mat(POINT_VS, POINT_FS, { uFrame: { value: m3() }, uRefract: { value: 0 }, uStyle: { value: style }, uDark: { value: 1 }, uLight: { value: new Vector3(0, 0, 1) } });
  const pointGeom = (n) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('aSize', new BufferAttribute(new Float32Array(n), 1)); g.setAttribute('aColor', new BufferAttribute(new Float32Array(n * 4), 4));
    return g;
  };
  const setPoint = (g, i, dir, size, color) => { g.attributes.position.setXYZ(i, dir[0], dir[1], dir[2]); g.attributes.aSize.setX(i, size); g.attributes.aColor.setXYZW(i, color[0], color[1], color[2], color[3] ?? 1); };
  const touch = (g) => { for (const k of ['position', 'aSize', 'aColor']) g.attributes[k].needsUpdate = true; };

  // planets share the star shader (world frame, refraction already applied by the caller)
  const NP = 8, planetGeom = new BufferGeometry();
  planetGeom.setAttribute('position', new BufferAttribute(new Float32Array(NP * 3), 3)); planetGeom.setAttribute('aMag', new BufferAttribute(new Float32Array(NP).fill(99), 1)); planetGeom.setAttribute('aColor', new BufferAttribute(new Float32Array(NP * 3), 3));
  const planets = add(new Points(planetGeom, starMat(IDENTITY)), 31);
  const sunPts = add(new Points(pointGeom(1), pointMat(2)), 32), moonPts = add(new Points(pointGeom(1), pointMat(3)), 33);
  // the bright asteroids (src/core/asteroids.js): stars of their magnitude, in the world frame like the planets
  const NAST = 16, astGeom = new BufferGeometry();
  astGeom.setAttribute('position', new BufferAttribute(new Float32Array(NAST * 3), 3)); astGeom.setAttribute('aMag', new BufferAttribute(new Float32Array(NAST).fill(99), 1)); astGeom.setAttribute('aColor', new BufferAttribute(new Float32Array(NAST * 3), 3));
  const astPts = add(new Points(astGeom, starMat(IDENTITY)), 31);
  const MAXSAT = 512, satPts = add(new Points(pointGeom(MAXSAT), pointMat(0)), 40);

  let W = 1, H = 1, P = 1, px = 1;
  const view = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const api = {
    renderer, MAXSAT,
    get width() { return W; }, get height() { return H; },
    /** radians per CSS pixel at the view centre */
    get pixelAngle() { return 1 / P; },
    resize(w, h) {
      W = Math.max(1, w); H = Math.max(1, h); px = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(px); renderer.setSize(W, H, false); shared.uPx.value = px;
    },
    /** rows: world -> camera (9 numbers, row-major); fov in radians across the larger side of the canvas */
    setView(rows, fov) {
      for (let i = 0; i < 9; i++) view[i] = rows[i];
      if (mode === 'perspective') {
        // an ordinary pinhole camera with the same orientation: `fov` across the larger side, at most 120 degrees
        const f = Math.min(fov, 120 * Math.PI / 180); P = (Math.max(W, H) / 2) / Math.tan(f / 2); fovY = 2 * Math.atan((H / 2) / P);
        pcam.fov = fovY * 180 / Math.PI; pcam.aspect = W / H; pcam.updateProjectionMatrix();
        pcam.matrix.set(rows[0], rows[3], rows[6], 0, rows[1], rows[4], rows[7], 0, rows[2], rows[5], rows[8], 0, 0, 0, 0, 1);       // camera -> world is the transpose
        pcam.updateMatrixWorld(true);
        shared.uView.value.set(...IDENTITY);
        return;
      }
      shared.uView.value.set(...rows);
      P = (Math.max(W, H) / 2) / (2 * Math.tan(fov / 4));
      shared.uScale.value.set(P / (W / 2), P / (H / 2));
    },
    /** world direction -> CSS pixel [x, y, cos(angle from centre)] or null when it is behind the drawn field */
    project(w) {
      const x = view[0] * w[0] + view[1] * w[1] + view[2] * w[2], y = view[3] * w[0] + view[4] * w[1] + view[5] * w[2], c = -(view[6] * w[0] + view[7] * w[1] + view[8] * w[2]);
      if (mode === 'perspective') return c < 0.02 ? null : [W / 2 + x / c * P, H / 2 - y / c * P, c];
      if (c < -0.8) return null;
      const k = 2 / (1 + c) * P;
      return [W / 2 + x * k, H / 2 - y * k, c];
    },
    /** CSS pixel -> world direction */
    unproject(x, y) {
      const X = (x - W / 2) / P, Y = (H / 2 - y) / P;
      let cx, cy, cz;
      if (mode === 'perspective') { const l = Math.hypot(X, Y, 1); cx = X / l; cy = Y / l; cz = -1 / l; }
      else { const q = X * X + Y * Y, c = (4 - q) / (4 + q); cx = X * (1 + c) / 2; cy = Y * (1 + c) / 2; cz = -c; }
      return [view[0] * cx + view[3] * cy + view[6] * cz, view[1] * cx + view[4] * cy + view[7] * cz, view[2] * cx + view[5] * cy + view[8] * cz];
    },
    scene, get camera() { return mode === 'perspective' ? pcam : camera; }, get mode() { return mode; },
    /** 'stereo' (the flat view) or 'perspective' (WebXR and ?xrdebug=1): recompiles the vertex shaders. */
    setMode(m) {
      if (m === mode) return; mode = m;
      for (const x of materials) { if (m === 'perspective') x.defines = { ...x.defines, PERSPECTIVE: 1 }; else if (x.defines) delete x.defines.PERSPECTIVE; x.needsUpdate = true; }
      if (m !== 'perspective') shared.uScale.value.set(1, 1);
    },
    /** In perspective mode under WebXR: the rotation about the vertical (radians) from the world frame to the reference space. */
    setHeading(yaw) { const c = Math.cos(yaw), s = Math.sin(yaw); shared.uView.value.set(c, 0, s, 0, 1, 0, -s, 0, c); },
    setPointScale(v) { shared.uPx.value = v; },
    /** Under WebXR, where setView() is not called: pixels per radian at the centre of an eye, in the units of setPointScale. */
    setPixelFocal(v) { if (v > 0) P = v; },
    /**
     * A named polyline of world directions (the 30 degree ring, the part of the track during the transit); null removes it.
     * These are GL lines, so they are drawn in the flat view and, once per eye, in a headset.
     */
    setLine(name, dirs, { color = 0x5fd4ff, alpha = 0.9, order = 46, frame = 'world', alphas = null } = {}) {
      const old = lines.get(name);
      if (old) { scene.remove(old); old.geometry.dispose(); materials.splice(materials.indexOf(old.material), 1); old.material.dispose(); lines.delete(name); }
      if (!dirs || dirs.length < 2) return;
      const pairs = []; for (let i = 0; i + 1 < dirs.length; i++) pairs.push(dirs[i], dirs[i + 1]);
      // frame 'j2000': the directions are J2000 vectors and turn with the stars (a path among the stars); 'world': fixed to the horizon
      const l = add(new LineSegments(lineGeometry(pairs, alphas), lineMat(color)), order); l.material.uniforms.uAlpha.value = alpha; l.userData.frame = frame; lines.set(name, l);
    },
    /** The apparent horizon as altitudes in degrees at equal steps of azimuth from north through east, or null for a flat one. */
    setHorizon(altDeg) {
      if (horizonTex) { horizonTex.dispose(); horizonTex = null; }
      if (altDeg) {
        const a = new Uint16Array(altDeg.length); for (let i = 0; i < a.length; i++) a[i] = DataUtils.toHalfFloat(altDeg[i] * Math.PI / 180);
        horizonTex = new DataTexture(a, a.length, 1, RedFormat, HalfFloatType); horizonTex.magFilter = horizonTex.minFilter = LinearFilter; horizonTex.wrapS = RepeatWrapping; horizonTex.wrapT = ClampToEdgeWrapping; horizonTex.needsUpdate = true;
      }
      ground.material.uniforms.uHorizon.value = horizonTex || flatHorizon; ground.material.uniforms.uTerrain.value = horizonTex ? 1 : 0;
    },
    /** A polyline of world directions (the path of the target through the night), alphas per segment; null removes it. */
    setTrack(dirs, alphas, color = 0xffb454) {
      if (track) { scene.remove(track); track.geometry.dispose(); materials.splice(materials.indexOf(track.material), 1); track.material.dispose(); track = null; }
      if (!dirs || dirs.length < 2) return;
      const pairs = []; for (let i = 0; i + 1 < dirs.length; i++) pairs.push(dirs[i], dirs[i + 1]);
      track = add(new LineSegments(lineGeometry(pairs, alphas), lineMat(color)), 45); track.material.uniforms.uAlpha.value = 0.95;
    },
    setStars(s) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(s.pos, 3)); g.setAttribute('aMag', new BufferAttribute(s.mag, 1)); g.setAttribute('aColor', new BufferAttribute(s.color, 3));
      stars = add(new Points(g, starMat()), 30);
    },
    /** lines: { id: [[ra, dec, ra, dec, ...] degrees, ...] } */
    setConstellations(lines) {
      const pairs = [], R = Math.PI / 180;
      for (const segs of Object.values(lines)) for (const s of segs) for (let i = 0; i + 3 < s.length; i += 2) arcSegments(toEq(s[i] * R, s[i + 1] * R), toEq(s[i + 2] * R, s[i + 3] * R), 3 * R, pairs);
      conLines = add(new LineSegments(lineGeometry(pairs), lineMat(0x7fa6e8)), 20);
    },
    /** hosts: Float32Array of J2000 unit vectors; sizes, colours and shapes (aShape, see HOST_FS) are set by the page */
    setHosts(pos, n) {
      const g = pointGeom(n); g.attributes.position.array.set(pos); g.attributes.position.needsUpdate = true;
      g.setAttribute('aShape', new BufferAttribute(new Float32Array(n), 1));
      hosts = add(new Points(g, mat(HOST_VS, HOST_FS, { uFrame: { value: m3() }, uRefract: { value: 0 }, uLine: { value: 1.7 } })), 35);
      return g;
    },
    /** f: everything that changes per frame (see main.js) */
    draw(f) {
      const L = f.layers, set = (obj, on) => { if (obj) obj.visible = !!on; };
      set(sky, L.atmosphere); set(ground, L.ground); set(azGrid, L.azgrid); set(eqGrid, L.eqgrid); set(conLines, L.constellations); set(hosts, L.hosts && f.hostsReady);
      set(planets, L.planets); set(sunPts, L.planets); set(moonPts, L.planets); set(satPts, L.satellites && f.sats && f.sats.length);
      const refr = L.atmosphere ? 1 : 0;
      sky.material.uniforms.uSun.value.set(...f.sunDir); sky.material.uniforms.uDay.value = f.day; sky.material.uniforms.uGlow.value = f.glow; sky.material.uniforms.uDusk.value = f.dusk;
      ground.material.uniforms.uAlpha.value = f.groundAlpha; ground.material.uniforms.uDay.value = L.atmosphere ? f.day : 0; ground.material.uniforms.uPixel.value = 0.75 / (P * px);
      eqGrid.material.uniforms.uFrame.value.set(...f.dateToWorld); eqGrid.material.uniforms.uAlpha.value = 0.32; azGrid.material.uniforms.uAlpha.value = 0.30;
      if (conLines) { const u = conLines.material.uniforms; u.uFrame.value.set(...f.j2000ToWorld); u.uRefract.value = refr; u.uAlpha.value = 0.34 * f.starFade; }
      if (stars) { const u = stars.material.uniforms; u.uFrame.value.set(...f.j2000ToWorld); u.uMagLimit.value = f.magLimit; u.uRefract.value = refr; u.uExtinct.value = refr; u.uSize.value = f.starSize; }
      if (hosts) { const u = hosts.material.uniforms; u.uFrame.value.set(...f.j2000ToWorld); u.uRefract.value = refr; }
      for (const l of lines.values()) if (l.userData.frame === 'j2000') { const u = l.material.uniforms; u.uFrame.value.set(...f.j2000ToWorld); u.uRefract.value = refr; }
      { const g = astGeom, n = Math.min(f.asteroids ? f.asteroids.length : 0, NAST); set(astPts, L.planets && n);
        if (n) { const u = astPts.material.uniforms; u.uMagLimit.value = f.magLimit; u.uExtinct.value = refr; u.uSize.value = f.starSize;
          for (let i = 0; i < NAST; i++) { const a = f.asteroids[i]; g.attributes.position.setXYZ(i, ...(a ? a.dir : [0, -1, 0])); g.attributes.aMag.setX(i, a ? a.mag : 99); g.attributes.aColor.setXYZ(i, 0.86, 0.84, 0.78); }
          g.attributes.position.needsUpdate = g.attributes.aMag.needsUpdate = g.attributes.aColor.needsUpdate = true; } }
      { const u = planets.material.uniforms; u.uMagLimit.value = f.magLimit; u.uExtinct.value = refr; u.uSize.value = f.starSize * 1.15;
        const g = planetGeom; f.planets.forEach((p, i) => { g.attributes.position.setXYZ(i, ...p.dir); g.attributes.aMag.setX(i, p.drawMag); g.attributes.aColor.setXYZ(i, ...p.color); });
        g.attributes.position.needsUpdate = g.attributes.aMag.needsUpdate = g.attributes.aColor.needsUpdate = true; }
      setPoint(sunPts.geometry, 0, f.sun.dir, f.sun.sprite, f.sun.color); touch(sunPts.geometry);
      setPoint(moonPts.geometry, 0, f.moon.dir, f.moon.sprite, f.moon.color); touch(moonPts.geometry); moonPts.material.uniforms.uLight.value.set(...f.moon.light); moonPts.material.uniforms.uDark.value = L.atmosphere ? 1 - Math.min(1, f.day * 1.6) : 1;
      if (f.sats) {
        const g = satPts.geometry, n = Math.min(f.sats.length, MAXSAT);
        for (let i = 0; i < n; i++) { const s = f.sats[i]; setPoint(g, i, s.dir, s.sunlit ? 2.6 : 1.8, s.sunlit ? [1, 0.93, 0.7, 0.95] : [0.55, 0.6, 0.7, 0.5]); }
        g.setDrawRange(0, n); touch(g);
      }
      if (f.xr) { set(sky, L.atmosphere && !f.xr.passthrough); if (f.xr.passthrough) ground.material.uniforms.uAlpha.value = Math.min(f.groundAlpha, 0.4); }
      renderer.render(scene, mode === 'perspective' ? pcam : camera);
    },
  };
  return api;
}
