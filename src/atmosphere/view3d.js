// The 3D view of the Atmosphere page (three.js): the planet in transit in front of its star, and a cutaway of the
// planet. What it draws is computed in src/viz/atmoview.js and src/core/colour.js (tested in Node); this file only
// puts those colours on geometry. World frame as in the analyzer: +Z toward the observer, lengths in stellar radii.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SH from '../viz/shaders.js';

const strip = (data, size, float) => {
  const t = float ? new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.FloatType) : new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = float ? THREE.NearestFilter : THREE.LinearFilter; t.minFilter = t.magFilter; t.wrapS = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
};

/**
 * createView(container) -> { set(data), setMode('planet' | 'transit' | 'cutaway'), lookFrom(where), zoomTo(onLimb), resize(), canvas, dispose() }
 * 'planet' is the ray-marched view (atmoPlanetFrag): data.shell = { ext, sca: Float32Array(4 N), inner }, starR and
 * starDist in planet radii, thermal and surface: [r, g, b], exposure, henyey.
 * data: { rprs (top of the atmosphere over the star's radius), inner (opaque radius over the top radius),
 *         stretch (>= 1: the ring drawn that many times thicker), limb: Float32Array(4 n) RGBA factors bottom to top,
 *         star: Float32Array(3 n) linear sRGB centre-to-limb by mu, face: Uint8Array(4 n) radial strip,
 *         day: [r, g, b], night: [r, g, b] linear sRGB }
 */
export function createView(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });   // kept so the view can be saved as a PNG
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the shaders encode sRGB themselves (src/viz/shaders.js)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);
  // transit: orthographic, so the planet's disc has its true size against the star whatever its distance in front;
  // cutaway: perspective. Each camera has its own controls; only the active one listens.
  const scene = new THREE.Scene(), camT = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.01, 500), camC = new THREE.PerspectiveCamera(30, 1, 0.01, 500);
  const ctlT = new OrbitControls(camT, renderer.domElement), ctlC = new OrbitControls(camC, renderer.domElement);
  for (const c of [ctlT, ctlC]) { c.enableDamping = true; c.dampingFactor = 0.08; }
  ctlT.enableRotate = false;   // the transit is a view along the line of sight: turning it would leave the planet's disc in front of the star from every side
  ctlT.minZoom = 0.5; ctlT.maxZoom = 400; ctlC.minDistance = 1.3; ctlC.maxDistance = 30;
  camT.position.set(0, 0, 20); camC.position.set(2.7, 1.0, 2.6);   // oblique: the cut face and the lit outside both show
  let camera = camT, controls = ctlT, aspect = 1;

  const white = () => strip(new Uint8Array([255, 255, 255, 255]), 1, false);
  const star = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.ShaderMaterial({ vertexShader: SH.atmoVert, fragmentShader: SH.atmoStarFrag, uniforms: { uLimb: { value: white() }, uGain: { value: 1 } } }));
  // transit: a disc facing the observer that multiplies the star behind it
  const limb = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.ShaderMaterial({ vertexShader: SH.atmoVert, fragmentShader: SH.atmoLimbFrag, uniforms: { uTrans: { value: white() }, uInner: { value: 0.9 } },
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor }));
  limb.position.set(0, 0, 1.5);   // anywhere in front of the star: the camera is orthographic
  // cutaway: the half of the planet behind the cut plane, and the cut face in front of it
  const cut = new THREE.Group();
  const surfMat = new THREE.ShaderMaterial({ vertexShader: SH.atmoVert, fragmentShader: SH.atmoSurfaceFrag, uniforms: { uDay: { value: new THREE.Vector3(0.4, 0.5, 0.8) }, uNight: { value: new THREE.Vector3(0, 0, 0) }, uStar: { value: new THREE.Vector3(1, 0.35, -0.3).normalize() } }, side: THREE.DoubleSide });
  const half = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64, Math.PI, Math.PI), surfMat);   // the hemisphere with z < 0
  const face = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.ShaderMaterial({ vertexShader: SH.atmoVert, fragmentShader: SH.atmoFaceFrag, uniforms: { uStrip: { value: white() }, uStripNight: { value: white() }, uDayDir: { value: new THREE.Vector2(40, 14).normalize() } } }));
  cut.add(half, face);
  // planet: one full-screen pass that follows a ray per pixel (src/viz/shaders.js, atmoPlanetFrag). The star is on -Z,
  // so a camera on +Z sees the transit and one on -Z the day side.
  const camP = new THREE.PerspectiveCamera(35, 1, 0.01, 5000), ctlP = new OrbitControls(camP, renderer.domElement);
  ctlP.enableDamping = true; ctlP.dampingFactor = 0.08; ctlP.minDistance = 1.15; ctlP.maxDistance = 1e6; ctlP.enablePan = false; camP.position.set(2.6, 1.0, -2.4);
  const U = { uInvProj: { value: camP.projectionMatrixInverse }, uCamWorld: { value: camP.matrixWorld }, uCam: { value: camP.position }, uExt: { value: white() }, uSca: { value: white() }, uStarLimb: { value: white() },
    uN: { value: 1 }, uInner: { value: 0.9 }, uStarDir: { value: new THREE.Vector3(0, 0, -1) }, uStarDist: { value: 100 }, uStarR: { value: 10 }, uThermal: { value: new THREE.Vector3() }, uThermalNight: { value: new THREE.Vector3() }, uSurface: { value: new THREE.Vector3(0.3, 0.3, 0.3) }, uExposure: { value: 1 }, uHenyey: { value: 0 } };
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: SH.atmoPlanetVert, fragmentShader: SH.atmoPlanetFrag, uniforms: U, depthTest: false, depthWrite: false }));
  sky.frustumCulled = false;
  scene.add(star, limb, cut, sky);

  let mode = 'transit', rprs = 0.1, dirty = true, raf = 0, alive = true;
  function frame() {
    sky.visible = mode === 'planet';
    if (mode === 'planet') { star.visible = limb.visible = cut.visible = false; camP.updateMatrixWorld(); }
    else if (mode === 'transit') {
      star.visible = limb.visible = true; cut.visible = false; star.position.set(0, 0, 0); star.scale.setScalar(1);
      limb.scale.setScalar(rprs); limb.quaternion.copy(camera.quaternion);
    } else {
      cut.visible = true; limb.visible = false; star.visible = true;
      star.position.set(40, 14, -12); star.scale.setScalar(4);   // far off to the side the curved surface faces: where the light comes from
    }
  }
  function setMode(m) {
    mode = m; camera = m === 'transit' ? camT : m === 'planet' ? camP : camC; controls = m === 'transit' ? ctlT : m === 'planet' ? ctlP : ctlC;
    ctlT.enabled = m === 'transit'; ctlC.enabled = m === 'cutaway'; ctlP.enabled = m === 'planet';
    controls.update(); dirty = true;
  }
  /** Transit view: frame the star, or the planet's limb (`limb` true: the ring fills about half the height). */
  function zoomTo(onLimb) { camT.position.set(0, 0, 20); ctlT.target.set(0, 0, 0); camT.zoom = onLimb ? 0.75 / Math.max(rprs, 1e-3) : 1; camT.updateProjectionMatrix(); ctlT.update(); dirty = true; }
  /** Planet view: 'day' (from the star's side), 'terminator' (side on), 'night', 'transit' (far off, the star behind) or 'eclipse' (far off beyond the star: the full day side beside the star's limb; turn the view and the star hides it). */
  function lookFrom(where) {
    const far = where === 'transit' || where === 'eclipse', dist = far ? 25 * U.uStarDist.value : 3.4, off = Math.min(0.9, (1.25 * U.uStarR.value) / U.uStarDist.value);   // eclipse: from beyond the star, the planet just clear of its limb   // far enough that the planet has its true size against the star (4% large)
    const dir = { day: [0.45, 0.3, -1], terminator: [1, 0.25, -0.12], night: [0.5, 0.3, 1], transit: [0, 0, 1], eclipse: [off, 0, -Math.sqrt(1 - off * off)] }[where] || [1, 0.3, -1], len = Math.hypot(...dir);
    camP.position.set((dir[0] / len) * dist, (dir[1] / len) * dist, (dir[2] / len) * dist); camP.fov = far ? Math.min(35, 3.4 * (180 / Math.PI) * Math.atan(U.uStarR.value / (U.uStarDist.value + dist))) : 35;
    camP.updateProjectionMatrix(); ctlP.target.set(0, 0, 0); ctlP.update(); dirty = true;
  }
  function set(d) {
    const swap = (u, tex) => { if (u.value) u.value.dispose(); u.value = tex; };
    if (d.shell) { swap(U.uExt, strip(d.shell.ext, d.shell.ext.length / 4, true)); swap(U.uSca, strip(d.shell.sca, d.shell.sca.length / 4, true)); U.uN.value = d.shell.ext.length / 4; U.uInner.value = d.shell.inner; }
    if (d.star) { const n = d.star.length / 3, px = new Float32Array(4 * n); for (let k = 0; k < n; k++) { px[4 * k] = d.star[3 * k]; px[4 * k + 1] = d.star[3 * k + 1]; px[4 * k + 2] = d.star[3 * k + 2]; px[4 * k + 3] = 1; } const t = strip(px, n, true); t.magFilter = t.minFilter = THREE.NearestFilter; swap(U.uStarLimb, t); }
    if (d.starR) U.uStarR.value = d.starR; if (d.starDist) U.uStarDist.value = d.starDist;
    if (d.thermal) { U.uThermal.value.set(...d.thermal); U.uThermalNight.value.set(...(d.thermalNight || d.thermal)); } if (d.surface) U.uSurface.value.set(...d.surface);
    if (d.exposure) U.uExposure.value = d.exposure; if (d.henyey != null) U.uHenyey.value = d.henyey;
    if (d.star) { const n = d.star.length / 3, px = new Float32Array(4 * n); for (let k = 0; k < n; k++) { px[4 * k] = d.star[3 * k]; px[4 * k + 1] = d.star[3 * k + 1]; px[4 * k + 2] = d.star[3 * k + 2]; px[4 * k + 3] = 1; } swap(star.material.uniforms.uLimb, strip(px, n, true)); }
    if (d.limb) swap(limb.material.uniforms.uTrans, strip(d.limb, d.limb.length / 4, true));
    if (d.face) { swap(face.material.uniforms.uStrip, strip(d.face, d.face.length / 4, false)); const nf = d.faceNight || d.face; swap(face.material.uniforms.uStripNight, strip(nf, nf.length / 4, false)); }
    if (d.rprs) {
      // the ring from the opaque radius to the top is drawn `stretch` times thicker; the opaque radius keeps its true size
      const s = d.stretch || 1, inner = d.inner ?? 0.9, top = inner + (1 - inner) * s;
      rprs = d.rprs * top; limb.material.uniforms.uInner.value = inner / top;
    }
    if (d.day) surfMat.uniforms.uDay.value.set(...d.day);
    if (d.night) surfMat.uniforms.uNight.value.set(...d.night);
    dirty = true;
  }
  function resize() {
    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    renderer.setSize(w, h, false); aspect = w / h;
    camC.aspect = aspect; camC.updateProjectionMatrix(); camP.aspect = aspect; camP.updateProjectionMatrix();
    camT.left = -1.5 * aspect; camT.right = 1.5 * aspect; camT.updateProjectionMatrix(); dirty = true;
  }
  for (const c of [ctlT, ctlC, ctlP]) c.addEventListener('change', () => { dirty = true; });
  function loop() {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    controls.update();
    if (!dirty) return;
    dirty = false; frame(); renderer.render(scene, camera);
  }
  resize(); setMode('transit'); loop();
  return { set, setMode, zoomTo, lookFrom, resize, canvas: renderer.domElement, render: () => { frame(); renderer.render(scene, camera); }, mode: () => mode,
    dispose() { alive = false; cancelAnimationFrame(raf); for (const c of [ctlT, ctlC, ctlP]) c.dispose(); renderer.dispose(); } };
}
