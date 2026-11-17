// three.js view of the star-planet system.
// World frame = model frame: X, Y on the sky, +Z toward the observer.
// Lengths are in stellar radii, so the star is a unit sphere.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { orbitPosition, orbitPath, trueAnomaly, eventPosition } from '../core/kepler.js';
import * as SH from './shaders.js';
import { teffToRGB } from './color.js';
import { moonForView, moonPlacement } from './moonview.js';
import { mapFrame } from './planetmap.js';

// appearance by size class (see planetClass in core/derive.js)
export const PLANET_LOOKS = {
  jupiter:    { label: 'Jupiter-size', a: 0xd9a066, b: 0x8a5a3c, c: 0xf2e0c0, atmo: 0xffc98a, bands: 16 },
  neptune:    { label: 'Neptune-size', a: 0x4f86d9, b: 0x2f58b0, c: 0xbfe0ff, atmo: 0x8fc4ff, bands: 7 },
  subneptune: { label: 'sub-Neptune',  a: 0x8fc7c9, b: 0x5f9aa8, c: 0xe6f6f2, atmo: 0xb8f0ea, bands: 4 },
  earth:      { label: 'Earth-size',   a: 0x1f4f96, b: 0x4d7a3a, c: 0xf4f7fa, atmo: 0x7fb8ff, bands: 0 },
  lava:       { label: 'lava world',   a: 0x2a1a16, b: 0x7a2410, c: 0xff7a2a, atmo: 0xff8a4a, bands: 0 },
};

// Orbit event markers: viz.highlight(kind)
export const EVENT_LABELS = { transit: 'mid-transit', eclipse: 'mid-eclipse', periastron: 'periastron', apastron: 'apastron', ascending: 'ascending node' };
const AUTO_FIT_RATIO = 6;   // fit 'auto': orbits more than 6 times larger than the active one are not framed

export async function createViz(container, labelsEl, insetFrame, onFatal) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });   // kept so the view can be copied into a recorded movie
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.autoClear = false;
  renderer.info.autoReset = false;   // counted per frame in draw(), over all passes
  container.appendChild(renderer.domElement);
  const dom = renderer.domElement;

  const scene = new THREE.Scene();
  const sysGroup = new THREE.Group();   // everything except the background stars
  scene.add(sysGroup);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 80000);
  camera.position.set(6, 4, 9);
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 1.3; controls.maxDistance = 25000;
  // Orthographic cameras for anything that claims to show the line of sight. A
  // perspective camera close to the system magnifies the planet (it is nearer
  // than the star) and shifts it off the disc, so it cannot show a transit truthfully.
  const insetCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 200000);
  const earthCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200000);
  const earth = { half: 2.3, cx: 0, cy: 0 };

  // ---- star -----------------------------------------------------------------
  const starUni = { uLD: { value: new THREE.Vector4(0, 0.6, 0, 0) }, uColor: { value: new THREE.Color(1, 0.9, 0.75) }, uTime: { value: 0 }, uGran: { value: 1 }, uFlat: { value: 0 }, uOrtho: { value: 0 }, uRot: { value: 0 }, uSpin: { value: new THREE.Vector2(1, 0) } };
  const star = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.ShaderMaterial({ uniforms: starUni, vertexShader: SH.starVert, fragmentShader: SH.starFrag }));
  sysGroup.add(star);

  const glowUni = { uColor: { value: new THREE.Color(1, 0.85, 0.6) }, uScale: { value: 7 }, uStrength: { value: 1 }, uTime: { value: 0 } };
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: glowUni, vertexShader: SH.glowVert, fragmentShader: SH.glowFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.renderOrder = 2;
  sysGroup.add(glow);

  // ---- planets --------------------------------------------------------------
  // One slot per planet (mesh, halo, orbit line, label), made on demand and reused. Geometry is shared.
  const viewDir = new THREE.Vector3(0, 0, 1);
  const sharedUni = { uFlat: { value: 0 }, uViewDir: { value: viewDir }, uOrtho: { value: 0 } };
  const planetGeo = new THREE.SphereGeometry(1, 72, 48), haloGeo = new THREE.SphereGeometry(1.09, 48, 32);
  const N_ORB = 720;
  const orbitMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
  const slots = [];
  // With several planets, a small dot of fixed size on screen at each one in the Orbit and Top down views: at true scale a
  // planet 50 stellar radii out is far below a pixel. One draw call; not drawn for a single planet, from Earth, or in the inset.
  const N_DOTS = 32;
  const dotsGeo = new THREE.BufferGeometry();
  dotsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_DOTS * 3), 3));
  dotsGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N_DOTS * 3), 3));
  const dots = new THREE.Points(dotsGeo, new THREE.PointsMaterial({ size: 3.5, sizeAttenuation: false, vertexColors: true }));
  dots.frustumCulled = false; dots.visible = false; sysGroup.add(dots);
  // A planet's fitted brightness map (viz.setSystem's `map`): an RGBA texture in longitude (east of the substellar point,
  // -180..180) and latitude (south up), drawn on the planet fixed to its substellar point, so it turns with the orbit.
  const blankTex = new THREE.DataTexture(new Uint8Array(4), 1, 1); blankTex.needsUpdate = true;
  const mapUni = () => ({ uMap: { value: blankTex }, uMapOn: { value: 0 }, uSub: { value: new THREE.Vector3(1, 0, 0) }, uNorth: { value: new THREE.Vector3(0, 1, 0) } });
  function setMap(b, m) {
    if (b.mapSrc === m) return;
    b.mapSrc = m || null;
    if (!m) { b.uni.uMapOn.value = 0; return; }
    let tx = b.uni.uMap.value;
    if (tx === blankTex || tx.image.width !== m.width || tx.image.height !== m.height) {
      if (tx !== blankTex) tx.dispose();
      tx = new THREE.DataTexture(new Uint8Array(m.rgba), m.width, m.height);
      tx.wrapS = THREE.RepeatWrapping; tx.wrapT = THREE.ClampToEdgeWrapping; tx.magFilter = THREE.LinearFilter; tx.minFilter = THREE.LinearFilter;
      b.uni.uMap.value = tx;
    } else tx.image.data.set(m.rgba);
    tx.needsUpdate = true; b.uni.uMapOn.value = 1;
  }
  let bodies = [];           // the slots in use; `act` is the active one
  let act = null;
  function mkSlot(i) {
    const uni = { uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uColC: { value: new THREE.Color() }, uAtmo: { value: new THREE.Color() }, uBands: { value: 16 }, uSeed: { value: 3.7 + 2.3 * i }, ...mapUni(), ...sharedUni };
    const mesh = new THREE.Mesh(planetGeo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: SH.planetVert, fragmentShader: SH.planetFrag }));
    const halo = new THREE.Mesh(haloGeo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: SH.planetVert, fragmentShader: SH.haloFrag, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.add(halo);
    mesh.rotation.z = 0.25;
    sysGroup.add(mesh);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_ORB * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N_ORB * 3), 3));
    const line = new THREE.LineLoop(geo, orbitMat);
    sysGroup.add(line);
    return { uni, mesh, halo, geo, line, label: mkLabel('planet', 'planet'), mapSrc: null, el: null, rprs: 0.1, look: 'jupiter', name: '', color: null, rgb: new THREE.Color(), active: false, pos: [0, 0, 0], moon: null, moonObj: null, place: { planet: [0, 0, 0], moon: [0, 0, 0], rMoon: 0 } };
  }
  // A planet's moon: a small grey body and the ring of its orbit about the planet, made the first time a planet has one.
  // The ring holds the orbit as offsets from the planet, so it is moved (and, when planets are enlarged, scaled) with it.
  const moonGeo = new THREE.SphereGeometry(1, 40, 28), N_MOON = 128;
  const moonRingMat = new THREE.LineBasicMaterial({ color: 0xb9c6e0, transparent: true, opacity: 0.6 });
  function mkMoon(i) {
    const uni = { uColA: { value: new THREE.Color(0x8f8b85) }, uColB: { value: new THREE.Color(0x5d5a56) }, uColC: { value: new THREE.Color(0xc4c0b8) }, uAtmo: { value: new THREE.Color(0x777777) }, uBands: { value: 0 }, uSeed: { value: 11.3 + 1.9 * i }, ...mapUni(), ...sharedUni };
    const mesh = new THREE.Mesh(moonGeo, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: SH.planetVert, fragmentShader: SH.planetFrag }));
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_MOON * 3), 3));
    const ring = new THREE.LineLoop(geo, moonRingMat); ring.frustumCulled = false; ring.renderOrder = 1;
    sysGroup.add(mesh); sysGroup.add(ring);
    const label = mkLabel('moon', 'moon'); label.style.fontSize = '9px'; label.style.opacity = '0.85'; label.style.transform = 'translate(8px, 40%)';
    return { mesh, ring, geo, label };
  }

  // ---- grid, line of sight ---------------------------------------------------
  const N_GRID = (5 * 96 + 12) * 2;
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_GRID * 3), 3));
  const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x3a6a8a, transparent: true, opacity: 0.32 }));
  sysGroup.add(grid);

  const tubeUni = { uColor: { value: new THREE.Color(0.35, 0.8, 1.0) }, uStrength: { value: 0.16 } };
  const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true); tubeGeo.rotateX(Math.PI / 2);
  const tube = new THREE.Mesh(tubeGeo, new THREE.ShaderMaterial({ uniforms: tubeUni, vertexShader: SH.tubeVert, fragmentShader: SH.tubeFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  tube.renderOrder = 1; tube.frustumCulled = false;
  sysGroup.add(tube);
  const losGeo = new THREE.BufferGeometry();
  losGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const los = new THREE.Line(losGeo, new THREE.LineBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.55 }));
  sysGroup.add(los);

  // ---- habitable zone -------------------------------------------------------
  const HZ_NR = 128, HZ_NA = 180;
  const hzGeo = new THREE.BufferGeometry();
  hzGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HZ_NR * (HZ_NA + 1) * 3), 3));
  hzGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(HZ_NR * (HZ_NA + 1)), 1));
  { const idx = []; for (let i = 0; i < HZ_NR - 1; i++) for (let j = 0; j < HZ_NA; j++) { const a = i * (HZ_NA + 1) + j, b = a + HZ_NA + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); } hzGeo.setIndex(idx); }
  const hzUni = { uColor: { value: new THREE.Color(0.22, 0.95, 0.5) }, uStrength: { value: 0.3 }, uScale: { value: 0.05 } };
  const hzMesh = new THREE.Mesh(hzGeo, new THREE.ShaderMaterial({ uniforms: hzUni, vertexShader: SH.hzVert, fragmentShader: SH.hzFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  hzMesh.frustumCulled = false; hzMesh.visible = false; hzMesh.renderOrder = 0;
  sysGroup.add(hzMesh);
  let hz = null;

  // ---- background stars -----------------------------------------------------
  const NS = 7000, sp = new Float32Array(NS * 3), sc = new Float32Array(NS * 3);
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const tilt = new THREE.Euler(1.05, 0.4, 0.2), tmpV = new THREE.Vector3();
  for (let i = 0; i < NS; i++) {
    let lat; const lon = rnd() * Math.PI * 2;
    if (i % 5 < 2) { lat = (rnd() + rnd() + rnd() - 1.5) * 0.24; } else { lat = Math.asin(2 * rnd() - 1); }
    tmpV.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)).applyEuler(tilt).multiplyScalar(30000);
    sp.set([tmpV.x, tmpV.y, tmpV.z], i * 3);
    const [r, g, b] = teffToRGB(3000 + 9000 * rnd() * rnd() + 3000 * rnd());
    const m = 0.18 + 0.82 * Math.pow(rnd(), 3.2);
    sc.set([r * m, g * m, b * m], i * 3);
  }
  const starsGeo = new THREE.BufferGeometry();
  starsGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starsGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const stars = new THREE.Points(starsGeo, new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  stars.frustumCulled = false;
  scene.add(stars);

  // ---- labels ---------------------------------------------------------------
  const mkLabel = (cls, text) => { const e = document.createElement('div'); e.className = 'lbl ' + cls; e.textContent = text; labelsEl.appendChild(e); return e; };
  const lblEarth = mkLabel('', '→ to Earth'), lblPeri = mkLabel('', 'periastron'), lblHZ = mkLabel('hz', 'habitable zone'), lblEvent = mkLabel('event', '');
  lblEvent.style.color = '#ffe9a8'; lblEvent.style.textShadow = '0 0 4px #000, 0 0 2px #000, 0 0 8px #000'; lblEvent.style.display = 'none';
  const earthPos = new THREE.Vector3(), periPos = new THREE.Vector3(), hzPos = new THREE.Vector3();

  // ---- orbit event marker (viz.highlight) -----------------------------------
  // A ring of constant size on screen plus a dot, fixed on the active planet's orbit. Drawn without a depth test so that
  // mid-eclipse, which is behind the star, still shows from Earth.
  const evGroup = new THREE.Group(); evGroup.visible = false; sysGroup.add(evGroup);
  // rings as line segments at several radii: 1 px lines cannot be made thicker, and a dark rim keeps the ring readable on the stellar disc
  const ringGeo = (radii) => { const n = 64, pts = new Float32Array(radii.length * n * 6); let q = 0;
    for (const r of radii) for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI, b = ((i + 1) / n) * 2 * Math.PI; pts.set([r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(b), r * Math.sin(b), 0], q); q += 6; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pts, 3)); return g; };
  const evMat = (color, opacity) => ({ color, opacity, transparent: true, depthTest: false, depthWrite: false });
  const evRing = new THREE.Group(); evGroup.add(evRing);
  { const dark = new THREE.LineSegments(ringGeo([0.8, 0.87, 1.2, 1.27]), new THREE.LineBasicMaterial(evMat(0x000000, 0.75)));
    const lit = new THREE.LineSegments(ringGeo([0.96, 1.03, 1.1]), new THREE.LineBasicMaterial(evMat(0xffe9a8, 1)));
    const d = new THREE.BufferGeometry(); d.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const dot = new THREE.Points(d, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, ...evMat(0xffe9a8, 1) }));
    dark.renderOrder = 6; lit.renderOrder = 7; dot.renderOrder = 7; dark.frustumCulled = lit.frustumCulled = dot.frustumCulled = false;
    evRing.add(dark, lit); evGroup.add(dot); }
  const evPos = new THREE.Vector3();
  const EV_PX = 9;           // ring radius on screen
  let evKind = null;
  function placeEvent() {
    const on = !!(evKind && el);
    if (on) { evPos.fromArray(eventPosition(el, evKind)); evGroup.position.copy(evPos); lblEvent.textContent = EVENT_LABELS[evKind]; }
    else lblEvent.style.display = 'none';
    evGroup.visible = on;
  }

  // ---- data coverage (viz.setCoverage) --------------------------------------
  // Where on the active planet's orbit each measurement was taken: the planet's position at the time of the point, drawn
  // as a dot just outside the orbit line for radial velocities and just inside it for photometry, so the two read as two
  // tracks along the orbit. Phases that were never observed are the gaps. Not drawn from Earth or in the inset (edge-on,
  // every point lies on one line).
  const COV_MAX = 20000, COV_KINDS = { rv: { color: 0xffa94d, label: 'radial velocity', shift: 1 }, phot: { color: 0x5ce0a0, label: 'photometry', shift: -1 } };
  const covGeo = new THREE.BufferGeometry();
  covGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COV_MAX * 3), 3));
  covGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(COV_MAX * 3), 3));
  covGeo.setDrawRange(0, 0);
  const cov = new THREE.Points(covGeo, new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
  cov.frustumCulled = false; cov.visible = false; cov.renderOrder = 3; sysGroup.add(cov);
  const covLegend = document.createElement('div'); covLegend.className = 'cov-legend'; covLegend.hidden = true; labelsEl.appendChild(covLegend);
  let covSets = [], covCounts = {};
  const covPos = [0, 0, 0], covCol = new THREE.Color();
  function rebuildCoverage() {
    let n = 0; covCounts = {};
    if (el && opts.coverage) {
      const total = covSets.reduce((a, c) => a + c.t.length, 0), stride = Math.max(1, Math.ceil(total / COV_MAX));
      const P = covGeo.attributes.position.array, C = covGeo.attributes.color.array, gap = 0.035 * el.ars + 0.04;
      for (const c of covSets) {
        const K = COV_KINDS[c.kind]; if (!K) continue;
        covCol.setHex(K.color); covCounts[c.kind] = (covCounts[c.kind] || 0) + c.t.length;
        for (let i = 0; i < c.t.length && n < COV_MAX; i += stride) {
          if (!Number.isFinite(c.t[i])) continue;
          orbitPosition(el, c.t[i], covPos);
          const r = Math.hypot(covPos[0], covPos[1], covPos[2]) || 1, k = 1 + (K.shift * gap) / r;   // a fixed distance off the orbit, outward or inward
          P[n * 3] = covPos[0] * k; P[n * 3 + 1] = covPos[1] * k; P[n * 3 + 2] = covPos[2] * k;
          C[n * 3] = covCol.r; C[n * 3 + 1] = covCol.g; C[n * 3 + 2] = covCol.b; n++;
        }
      }
      covGeo.attributes.position.needsUpdate = true; covGeo.attributes.color.needsUpdate = true;
    }
    covGeo.setDrawRange(0, n);
    const kinds = Object.keys(covCounts);
    covLegend.innerHTML = kinds.map((k) => `<span><i style="background:#${COV_KINDS[k].color.toString(16).padStart(6, '0')}"></i>${COV_KINDS[k].label} · ${covCounts[k].toLocaleString('en-US')}</span>`).join('') + (kinds.length ? '<small>outside the orbit: velocities · inside: photometry</small>' : '');
  }

  // ---- state ----------------------------------------------------------------
  let el = null, rprs = 0.1, rmax = 6, rAll = 6, rprsMax = 0.1, time = 0;   // el, rprs, rmax: the active planet; rAll: the outermost apastron
  const opts = { style: 'eyes', glow: true, granulation: true, stars: true, orbit: true, grid: false, corridor: true, labels: true, enlarge: false, inset: true, look: 'auto', hz: false, fit: 'auto', coverage: false };
  let view = 'free', anim = null;
  const bg = new THREE.Color(0x000000);

  function applyLook() {
    const flat = opts.style === 'blueprint' ? 1 : 0;
    for (const b of bodies) {
      // the Look choice overrides the planet on show; the others keep the look of their own size class
      const L = PLANET_LOOKS[b.active && opts.look !== 'auto' ? opts.look : b.look] || PLANET_LOOKS.jupiter, u = b.uni;
      u.uColA.value.setHex(L.a); u.uColB.value.setHex(L.b); u.uColC.value.setHex(L.c); u.uAtmo.value.setHex(L.atmo);
      u.uBands.value = L.bands;
      b.halo.visible = !flat;
    }
    sharedUni.uFlat.value = flat; starUni.uFlat.value = flat;
    starUni.uGran.value = opts.granulation ? 1 : 0;
    bg.setHex(flat ? 0x04101c : 0x000000);
  }

  // points in the orbital plane: axes are -X and the direction of inferior conjunction
  const inPlane = (rho, th) => [-rho * Math.cos(th), -rho * Math.sin(th) * el.cosI, rho * Math.sin(th) * el.sinI];

  function rebuildOrbit() {
    const colA = opts.style === 'blueprint' ? [0.45, 0.9, 1.0] : [0.42, 0.78, 1.0];
    for (const b of bodies) {
      const path = orbitPath(b.el, N_ORB), col = b.geo.attributes.color.array;
      // the active orbit keeps the highlight colour; the others take their own colour (or grey) at reduced strength
      const c = b.active ? colA : [b.rgb.r, b.rgb.g, b.rgb.b], k = b.active ? 1 : 0.5;
      for (let i = 0; i < N_ORB; i++) {
        const front = (path[i * 3 + 2] > 0 ? 1 : 0.38) * k; // dimmer on the far side of the star
        col[i * 3] = c[0] * front; col[i * 3 + 1] = c[1] * front; col[i * 3 + 2] = c[2] * front;
      }
      b.geo.attributes.position.array.set(path); b.geo.attributes.position.needsUpdate = true; b.geo.attributes.color.needsUpdate = true;
      b.geo.computeBoundingSphere();
    }

    const seg = gridGeo.attributes.position.array; let q = 0;
    const push = (a, b) => { seg.set(a, q); seg.set(b, q + 3); q += 6; };
    const R = el.ars * (1 + el.e) * 1.25;
    for (let k = 1; k <= 5; k++) for (let j = 0; j < 96; j++) push(inPlane((R * k) / 5, (j / 96) * 2 * Math.PI), inPlane((R * k) / 5, ((j + 1) / 96) * 2 * Math.PI));
    for (let j = 0; j < 12; j++) push(inPlane(1.05, (j / 12) * 2 * Math.PI), inPlane(R, (j / 12) * 2 * Math.PI));
    gridGeo.attributes.position.needsUpdate = true; gridGeo.computeBoundingSphere();

    // the column of space in which a planet must sit to be seen in transit
    const len = el.ars * (1 + el.e) * 1.45 + 3;
    tube.scale.z = len; tube.position.z = len / 2;
    losGeo.attributes.position.array.set([0, 0, 1.02, 0, 0, len]); losGeo.attributes.position.needsUpdate = true; losGeo.computeBoundingSphere();
    earthPos.set(0, 0, len);
    const rp = el.ars * (1 - el.e), u = el.w + trueAnomaly(0, el.e);
    periPos.set(-rp * Math.cos(u), -rp * Math.sin(u) * el.cosI, rp * Math.sin(u) * el.sinI);
    rebuildHZ(); placeEvent(); rebuildCoverage();
  }

  function rebuildHZ() {
    if (!hz || !el) return;
    const P = hzGeo.attributes.position.array, A = hzGeo.attributes.aAlpha.array;
    for (let i = 0; i < HZ_NR; i++) for (let j = 0; j <= HZ_NA; j++) {
      const k = i * (HZ_NA + 1) + j;
      P.set(inPlane(hz.r[i], (j / HZ_NA) * 2 * Math.PI), k * 3); A[k] = hz.w[i];
    }
    hzGeo.attributes.position.needsUpdate = true; hzGeo.attributes.aAlpha.needsUpdate = true;
    hzUni.uScale.value = 14 / hz.outer;
    const mid = 0.5 * (hz.nominal.runaway + hz.nominal.maxGreen);
    hzPos.fromArray(inPlane(mid, Math.PI * 0.75));
  }

  // Radius the Orbit and Top down cameras frame. One planet: its apastron, as before. Several: opts.fit =
  // 'active' (the active orbit), 'all' (the outermost orbit) or 'auto': the largest orbit that is no more than
  // AUTO_FIT_RATIO times the active one. Planets further out than that are left outside the frame, so the active
  // orbit stays readable in a system that spans a wide range; zoom out or choose 'all' to see them.
  function frameRadius() {
    if (bodies.length < 2 || opts.fit === 'active') return rmax;
    if (opts.fit === 'all') return rAll;
    let R = rmax;
    for (const b of bodies) { const ra = b.el.ars * (1 + b.el.e); if (ra <= AUTO_FIT_RATIO * rmax && ra > R) R = ra; }
    return R;
  }
  const viewRadius = () => (opts.hz && hz ? Math.max(frameRadius(), hz.outer) : frameRadius());
  const farZ = () => Math.max(viewRadius(), rAll) * 2 + 50;   // where the orthographic cameras sit: beyond every orbit

  function planetRadius(b, forTrueScale) {
    if (forTrueScale || !opts.enlarge) return b.rprs;
    // enlarged: the largest planet gets a fixed size on screen and the others keep their size relative to it
    let r = (b.rprs / (rprsMax || 1)) * 0.022 * camera.position.distanceTo(controls.target) / Math.max(camera.zoom, 1);
    // several planets: framed on an outer orbit, an inner planet enlarged that much would swallow the star, so keep it well inside its own distance
    if (bodies.length > 1) r = Math.min(r, 0.3 * Math.hypot(b.pos[0], b.pos[1], b.pos[2]));
    return Math.max(b.rprs, r);
  }
  // Sizes for this pass, and each moon beside its planet: the moon's radius and its distance from the planet take the
  // planet's enlargement, so the pair stays to scale with itself; at true scale it is the geometry of the light-curve model.
  const scalePlanets = (trueScale) => {
    for (const b of bodies) {
      const r = planetRadius(b, trueScale); b.mesh.scale.setScalar(r);
      if (!b.moon) continue;
      const k = r / b.rprs, m = b.moonObj, pl = moonPlacement(b.el, b.moon, time, k, b.place);
      m.mesh.position.set(pl.moon[0], pl.moon[1], pl.moon[2]); m.mesh.scale.setScalar(Math.max(pl.rMoon, 1e-6));
      m.ring.position.set(pl.planet[0], pl.planet[1], pl.planet[2]); m.ring.scale.setScalar(k);
    }
  };
  const showMoons = (rings) => { for (const b of slots) if (b.moonObj) { const on = !!b.moon && bodies.includes(b); b.moonObj.mesh.visible = on; b.moonObj.ring.visible = on && rings; } };

  function setView(name, instant) {
    view = name;
    controls.enabled = name !== 'earth';
    if (name === 'earth') { anim = null; earth.half = Math.max(2.3, Math.min(1.3 + 2 * rprs, 6)); earth.cx = 0; earth.cy = 0; return; }
    let D = viewRadius() * 2.4 + 5;
    // looking straight down: make sure the whole framed circle is inside the shorter side of the window (2.4 R + 5 crops it once R > 6)
    if (name === 'top') D = Math.max(D, (1.1 * viewRadius()) / (Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, camera.aspect)));
    const to = name === 'top'
      ? new THREE.Vector3(0.02, el ? el.sinI - 0.02 * el.cosI : 1, el ? el.cosI + 0.02 * el.sinI : 0.02).normalize().multiplyScalar(D)
      : new THREE.Vector3(0.62, 0.36, 0.7).normalize().multiplyScalar(D);
    anim = { from: camera.position.clone(), to, t: instant ? 1 : 0 };
  }

  // zoom and pan for the orthographic Earth view (OrbitControls is switched off there)
  dom.addEventListener('wheel', (e) => {
    if (view !== 'earth') return; e.preventDefault();
    earth.half = Math.min(Math.max(earth.half * Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015))), 0.02), Math.max(8, rAll * 1.6));
  }, { passive: false });
  // one finger (or the mouse) pans, two fingers pinch; in the Orbit and Top down views OrbitControls does the same for its camera
  let drag = null, pinch = null;
  const fingers = new Map();
  const spread = () => { const [a, b] = [...fingers.values()]; return Math.max(8, Math.hypot(a[0] - b[0], a[1] - b[1])); };
  dom.addEventListener('pointerdown', (e) => {
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (view !== 'earth') return;
    dom.setPointerCapture(e.pointerId);
    if (fingers.size === 2) { pinch = { d: spread(), half: earth.half }; drag = null; } else drag = [e.clientX, e.clientY, earth.cx, earth.cy];
  });
  dom.addEventListener('pointermove', (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (view !== 'earth') return;
    if (pinch && fingers.size === 2) { earth.half = Math.min(Math.max((pinch.half * pinch.d) / spread(), 0.02), Math.max(8, rAll * 1.6)); return; }
    if (drag) { const s = (2 * earth.half) / container.clientHeight; earth.cx = drag[2] - (e.clientX - drag[0]) * s; earth.cy = drag[3] + (e.clientY - drag[1]) * s; }
  });
  const lift = (e) => { fingers.delete(e.pointerId); if (fingers.size < 2) pinch = null; drag = null; };
  dom.addEventListener('pointerup', lift); dom.addEventListener('pointercancel', lift);
  dom.addEventListener('dblclick', () => { if (view === 'earth') { earth.cx = 0; earth.cy = 0; earth.half = 2.3; } });

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const v3 = new THREE.Vector3();
  function placeLabel(node, p, show, cam) {
    if (!show) { node.style.display = 'none'; return; }
    v3.copy(p).project(cam);
    if (v3.z > 1 || Math.abs(v3.x) > 1.05 || Math.abs(v3.y) > 1.05) { node.style.display = 'none'; return; }
    node.style.display = '';
    node.style.left = ((v3.x * 0.5 + 0.5) * container.clientWidth).toFixed(1) + 'px';
    node.style.top = ((-v3.y * 0.5 + 0.5) * container.clientHeight).toFixed(1) + 'px';
  }

  // the event marker's label: beside the ring, or pinned to the edge with an arrow when the point is outside the frame
  function placeEventLabel(cam) {
    if (!evGroup.visible || !opts.labels) { lblEvent.style.display = 'none'; return; }
    v3.copy(evPos).project(cam);
    if (v3.z > 1) { lblEvent.style.display = 'none'; return; }
    const out = Math.abs(v3.x) > 0.97 || Math.abs(v3.y) > 0.97, name = EVENT_LABELS[evKind];
    let x = v3.x, y = v3.y, text = name, tf = 'translate(16px, -50%)';
    if (out) {
      const s = 0.9 / Math.max(Math.abs(x), Math.abs(y)); x *= s; y *= s;
      text = Math.abs(v3.x) > Math.abs(v3.y) ? (v3.x > 0 ? name + ' →' : '← ' + name) : (v3.y > 0 ? '↑ ' + name : '↓ ' + name);
      tf = `translate(${v3.x > 0.5 ? '-100%' : v3.x < -0.5 ? '0' : '-50%'}, -50%)`;
    } else if (v3.x > 0.7) tf = 'translate(calc(-100% - 16px), -50%)';
    if (lblEvent.textContent !== text) lblEvent.textContent = text;
    lblEvent.style.transform = tf; lblEvent.style.display = '';
    lblEvent.style.left = ((x * 0.5 + 0.5) * container.clientWidth).toFixed(1) + 'px';
    lblEvent.style.top = ((-y * 0.5 + 0.5) * container.clientHeight).toFixed(1) + 'px';
  }
  const qA = new THREE.Quaternion(), qI = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3();

  let last = performance.now(), dead = false;
  function frame(now) {
    if (dead) return;
    requestAnimationFrame(frame);
    try { draw(now); } catch (err) {
      // a render error must not take the rest of the app down: hand over to the 2D view
      dead = true; renderer.dispose(); labelsEl.innerHTML = '';
      if (onFatal) onFatal(err);
    }
  }
  function draw(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!el) return;
    starUni.uTime.value += dt; glowUni.uTime.value += dt;
    const w = container.clientWidth, h = container.clientHeight, blueprint = opts.style === 'blueprint';
    for (const b of bodies) {
      // a planet with a massive moon circles their common centre: its drawn position includes that wobble
      if (b.moon) { moonPlacement(b.el, b.moon, time, 1, b.place); b.pos[0] = b.place.planet[0]; b.pos[1] = b.place.planet[1]; b.pos[2] = b.place.planet[2]; } else orbitPosition(b.el, time, b.pos);
      b.mesh.position.set(b.pos[0], b.pos[1], b.pos[2]); b.mesh.rotation.y += dt * 0.25;
      if (b.uni.uMapOn.value) { const f = mapFrame(b.pos, b.el); b.uni.uSub.value.fromArray(f.sub); b.uni.uNorth.value.fromArray(f.north); }
    }
    const nDots = bodies.length > 1 ? Math.min(bodies.length, N_DOTS) : 0;
    if (nDots) { const P = dotsGeo.attributes.position.array; for (let i = 0; i < nDots; i++) P.set(bodies[i].pos, i * 3); dotsGeo.attributes.position.needsUpdate = true; }
    const showOrbits = (on, activeOnly) => { for (const b of bodies) b.line.visible = on && (b.active || !activeOnly); };
    const showEvent = !!(evKind && el);
    renderer.info.reset();
    renderer.setClearColor(bg, 1);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.clear();
    const showHZ = opts.hz && !!hz;

    if (view === 'earth') {
      // 1. background stars with the perspective camera looking down the line of sight
      camera.position.set(0, 0, 10); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); camera.zoom = 1; camera.near = 0.02; camera.updateProjectionMatrix();
      sysGroup.visible = false; stars.visible = opts.stars && !blueprint;
      renderer.render(scene, camera);
      // 2. the system, orthographic and at true scale: exactly the geometry the light curve model uses
      renderer.clearDepth();
      const a = w / h;
      earthCam.left = earth.cx - earth.half * a; earthCam.right = earth.cx + earth.half * a; earthCam.top = earth.cy + earth.half; earthCam.bottom = earth.cy - earth.half;
      earthCam.position.set(0, 0, farZ()); earthCam.updateProjectionMatrix(); earthCam.updateMatrixWorld();
      sysGroup.visible = true; stars.visible = false;
      dots.visible = false; cov.visible = false; covLegend.hidden = true;
      scalePlanets(true);   // every planet at true scale: the star's depth buffer hides the ones behind it, so simultaneous transits and overlaps show as they are
      showMoons(opts.orbit);
      evGroup.visible = showEvent; evRing.quaternion.copy(earthCam.quaternion); evRing.scale.setScalar((EV_PX * 2 * earth.half) / h);
      showOrbits(opts.orbit, true); grid.visible = false; tube.visible = false;   // edge-on, seven orbit lines across the disc hide the transits: only the active one los.visible = false; hzMesh.visible = false;
      glow.visible = opts.glow && !blueprint; glow.scale.setScalar(7); glowUni.uScale.value = 7; glowUni.uStrength.value = 0.8;
      glow.quaternion.copy(earthCam.quaternion);
      starUni.uOrtho.value = 1; sharedUni.uOrtho.value = 1;
      renderer.render(scene, earthCam);
      for (const b of bodies) { placeLabel(b.label, b.mesh.position, opts.labels && b.pos[2] > 0, earthCam); if (b.moonObj) placeLabel(b.moonObj.label, b.moonObj.mesh.position, !!b.moon && b.active && opts.labels && b.place.moon[2] > 0, earthCam); }
      placeEventLabel(earthCam);
      lblEarth.style.display = 'none'; lblPeri.style.display = 'none'; lblHZ.style.display = 'none';
      insetFrame.hidden = true;
      return;
    }

    if (anim) {
      anim.t = Math.min(1, anim.t + dt / 0.9);
      const k = anim.t * anim.t * (3 - 2 * anim.t);
      if (anim.arc) {   // swing round the star at a smoothly changing distance (used by highlight(kind, { fly: true }))
        vA.copy(anim.from).normalize(); vB.copy(anim.to).normalize(); qA.setFromUnitVectors(vA, vB); qI.identity().slerp(qA, k);
        camera.position.copy(vA).applyQuaternion(qI).multiplyScalar(anim.from.length() + (anim.to.length() - anim.from.length()) * k);
      } else camera.position.lerpVectors(anim.from, anim.to, k);
      controls.target.set(0, 0, 0);
      if (anim.t >= 1) anim = null;
    }
    controls.update();
    const dist = camera.position.length();
    camera.near = Math.max(0.02, dist * 0.002); camera.updateProjectionMatrix();

    sysGroup.visible = true;
    scalePlanets(false); showMoons(opts.orbit); dots.visible = nDots > 0;
    cov.visible = opts.coverage && covGeo.drawRange.count > 0; covLegend.hidden = !cov.visible;
    evGroup.visible = showEvent; evRing.quaternion.copy(camera.quaternion);
    evRing.scale.setScalar((EV_PX * 2 * camera.position.distanceTo(evPos) * Math.tan((camera.fov * Math.PI) / 360)) / h);
    showOrbits(opts.orbit); grid.visible = opts.grid || blueprint; stars.visible = opts.stars && !blueprint;
    tube.visible = opts.corridor; los.visible = opts.corridor; hzMesh.visible = showHZ;
    glow.visible = opts.glow && !blueprint;
    const gs = Math.max(7, dist * 0.09); // never let the star shrink to nothing when zoomed far out
    glow.scale.setScalar(gs); glowUni.uScale.value = gs; glowUni.uStrength.value = 1;
    glow.quaternion.copy(camera.quaternion);
    starUni.uOrtho.value = 0; sharedUni.uOrtho.value = 0;
    renderer.render(scene, camera);

    for (const b of bodies) { placeLabel(b.label, b.mesh.position, opts.labels, camera); if (b.moonObj) placeLabel(b.moonObj.label, b.moonObj.mesh.position, !!b.moon && b.active && opts.labels, camera); }
    placeEventLabel(camera);
    placeLabel(lblEarth, earthPos, opts.labels && opts.corridor, camera);
    placeLabel(lblPeri, periPos, opts.labels && opts.orbit && el.e > 0.02 && evKind !== 'periastron', camera);
    placeLabel(lblHZ, hzPos, opts.labels && showHZ, camera);

    // inset: orthographic view along the line of sight at true scale
    insetFrame.hidden = !opts.inset;
    if (opts.inset) {
      const r = insetFrame.getBoundingClientRect(), c = container.getBoundingClientRect();
      const x = r.left - c.left, y = c.bottom - r.bottom, s = r.width;
      scalePlanets(true); showMoons(false); dots.visible = false; cov.visible = false;
      evGroup.visible = false;
      showOrbits(false); grid.visible = false; stars.visible = false; tube.visible = false; los.visible = false; hzMesh.visible = false;
      glow.scale.setScalar(7); glowUni.uScale.value = 7; glowUni.uStrength.value = 0.7;
      insetCam.position.set(0, 0, farZ()); insetCam.lookAt(0, 0, 0);
      glow.quaternion.copy(insetCam.quaternion);
      starUni.uOrtho.value = 1; sharedUni.uOrtho.value = 1;
      renderer.setScissorTest(true);
      renderer.setViewport(x, y, s, s); renderer.setScissor(x, y, s, s);
      renderer.clear();
      renderer.render(scene, insetCam);
      renderer.setScissorTest(false);
    }
  }
  requestAnimationFrame(frame);

  return {
    kind: 'three',
    // sys: { el, rprs, claret, teff, name, look, hz, moon } for the planet on show, and optionally
    //      planets: [{ el, rprs, name, look, active, color, moon }] to draw the whole system. `moon` is a planet's moon
    //      ({ rmoon, permoon, phmoon, mmoon, imoon, mplanet, mstar } as core/exomoon.js takes them): drawn orbiting it.
    //      `map` ({ width, height, rgba: Uint8Array, row 0 = south, column 0 = 180° west of the substellar point }): the planet's
    //      brightness map, drawn on it fixed to the substellar point (pass the same object again to keep the texture). With `planets` absent or of
    //      length one the view is the single-planet view. The active entry is the one flagged `active`, else the one
    //      whose `el` is sys.el, else the first; fields it lacks fall back to the top-level ones.
    setSystem(sys) {
      const first = !el, prev = viewRadius();
      const list = Array.isArray(sys.planets) && sys.planets.length > 1 ? sys.planets.filter((p) => p && p.el) : [];
      let ia = list.findIndex((p) => p.active); if (ia < 0) ia = list.findIndex((p) => p.el === sys.el); if (ia < 0) ia = 0;
      const src = list.length > 1 ? list.map((p, i) => (i === ia ? { el: p.el || sys.el, rprs: p.rprs ?? sys.rprs, name: p.name ?? sys.name, look: p.look || sys.look, color: p.color, moon: p.moon ?? sys.moon, map: p.map ?? sys.map, active: true } : { ...p, active: false }))
        : [{ el: sys.el, rprs: sys.rprs, name: sys.name, look: sys.look, moon: sys.moon, map: sys.map, active: true }];
      while (slots.length < src.length) slots.push(mkSlot(slots.length));
      slots.forEach((b, i) => { const on = i < src.length; b.mesh.visible = on; b.line.visible = on; if (!on) { b.label.style.display = 'none'; b.moon = null; setMap(b, null); } });
      bodies = slots.slice(0, src.length);
      bodies.forEach((b, i) => {
        const p = src[i];
        b.el = p.el; b.rprs = p.rprs; b.active = p.active; b.color = p.color || null; b.name = p.name || 'planet';
        if (p.look) b.look = p.look;
        setMap(b, p.map || null);
        b.rgb.setRGB(0.6, 0.66, 0.74); if (b.color) { try { b.rgb.set(b.color); } catch { /* keep the grey */ } }
        // active: the full name, as before. Others: a small label with the planet's letter.
        const L = b.label, tail = b.name.trim().split(/\s+/).pop();
        L.textContent = b.active ? b.name : (tail.length <= 2 ? tail : b.name);
        L.style.fontSize = b.active ? '' : '9px'; L.style.opacity = b.active ? '' : '0.8'; L.style.color = b.active ? '' : (b.color || '#aebccc');
        L.style.transform = b.active ? '' : 'translate(7px, -140%)'; L.style.zIndex = b.active ? '1' : '';
        b.line.renderOrder = b.active ? 1 : 0;
        // the planet's moon, when the model has one: its orbit about the planet as a ring of offsets
        b.moon = moonForView(p.el, p.moon ? { ...p.moon, rprs: p.moon.rprs ?? p.rprs } : null);
        if (b.moon) { if (!b.moonObj) b.moonObj = mkMoon(i); b.moonObj.geo.attributes.position.array.set(b.moon.ring); b.moonObj.geo.attributes.position.needsUpdate = true; }
      });
      for (const b of slots) if (b.moonObj && !b.moon) { b.moonObj.mesh.visible = false; b.moonObj.ring.visible = false; b.moonObj.label.style.display = 'none'; }
      act = bodies.find((b) => b.active);
      { const C = dotsGeo.attributes.color.array; bodies.slice(0, N_DOTS).forEach((b, i) => C.set(b.active ? [1, 1, 1] : [b.rgb.r, b.rgb.g, b.rgb.b], i * 3));
        dotsGeo.attributes.color.needsUpdate = true; dotsGeo.setDrawRange(0, Math.min(bodies.length, N_DOTS)); }
      el = act.el; rprs = act.rprs; rmax = el.ars * (1 + el.e);
      rAll = Math.max(...bodies.map((b) => b.el.ars * (1 + b.el.e))); rprsMax = Math.max(...bodies.map((b) => b.rprs));
      starUni.uLD.value.set(sys.claret[0], sys.claret[1], sys.claret[2], sys.claret[3]);
      // Rossiter-McLaughlin: the stellar rotation drawn on the disc when the model has v sin i (sys.rm = { vsini km/s, lambda deg })
      if (sys.rm && sys.rm.vsini > 0) { const L = (sys.rm.lambda || 0) * Math.PI / 180; starUni.uRot.value = 1; starUni.uSpin.value.set(Math.cos(L), Math.sin(L)); } else starUni.uRot.value = 0;
      const [r, g, b] = teffToRGB(sys.teff);
      starUni.uColor.value.setRGB(r, g, b); glowUni.uColor.value.setRGB(r, g * 0.92, b * 0.8);
      hz = sys.hz || null;
      const half = Math.max(1.6, Math.min(4, 1.25 + rprs));
      insetCam.left = -half; insetCam.right = half; insetCam.top = half; insetCam.bottom = -half; insetCam.updateProjectionMatrix();
      rebuildOrbit(); applyLook();
      if (first) setView(view, true);
      else if (view !== 'earth' && Math.abs(viewRadius() - prev) / prev > 0.5) setView(view, false);
    },
    setTime(t) { time = t; },
    // The measurements to place on the active planet's orbit (shown with the option `coverage`): [{ kind: 'rv' | 'phot',
    // t: times in the model's frame }]. Pass the same arrays again freely: positions are recomputed only with the orbit.
    setCoverage(sets) {
      const next = (sets || []).filter((c) => c && c.t && c.t.length && COV_KINDS[c.kind]);
      if (next.length === covSets.length && next.every((c, i) => c.t === covSets[i].t && c.kind === covSets[i].kind)) return;
      covSets = next; rebuildCoverage();
    },
    setOptions(o) {
      const hzWas = opts.hz, rWas = viewRadius();
      Object.assign(opts, o); applyLook();
      if (el) rebuildOrbit();
      if (el && opts.hz !== hzWas && view !== 'earth') setView(opts.hz ? 'top' : view, false);   // step back far enough to see the zone
      else if (el && view !== 'earth' && viewRadius() !== rWas) setView(view, false);             // opts.fit changed what is framed
    },
    setView(name) { setView(name, false); },
    getView: () => view,
    getOptions: () => ({ ...opts }),
    // Mark a point on the ACTIVE planet's orbit: 'transit' | 'eclipse' | 'periastron' | 'apastron' | 'ascending', or null to clear.
    // The marker is fixed in space (it does not move with setTime) and follows the active planet across setSystem calls.
    // { fly: true } swings the Orbit camera round so the marker is on the near side and inside the frame.
    highlight(kind, o) {
      evKind = kind && EVENT_LABELS[kind] ? kind : null;
      placeEvent();
      if (evKind && el && o && o.fly && view === 'free') {
        const n = vB.set(0.15, el.sinI, el.cosI).normalize();   // roughly the orbit normal, so the camera stays above the plane
        const to = vA.copy(evPos).normalize().multiplyScalar(0.8).addScaledVector(n, 0.55).normalize()
          .multiplyScalar(Math.max((anim ? anim.to : camera.position).length(), evPos.length() * 2.4 + 5));
        anim = { from: camera.position.clone(), to: to.clone(), t: 0, arc: true };
      }
    },
    // [X, Y, Z] in stellar radii of that point for the active planet (the position the marker uses), or null.
    eventPosition: (kind) => (el && EVENT_LABELS[kind] ? eventPosition(el, kind) : null),
    getHighlight: () => evKind,
    // what is drawn, for tests and for a "fit" control: number of planets, framed radius and the outermost apastron (stellar radii)
    getInfo: () => ({ coverage: opts.coverage ? { ...covCounts, drawn: covGeo.drawRange.count } : null, planets: bodies.length, maps: bodies.filter((b) => b.uni.uMapOn.value).length, active: act ? bodies.indexOf(act) : -1, frameRadius: viewRadius(), outerRadius: rAll, drawCalls: renderer.info.render.calls, moons: bodies.filter((b) => b.moon).length,
      // the active planet's moon as drawn in the last pass: positions (stellar radii), radii, and whether its mesh is shown
      moon: act && act.moon ? { planet: act.mesh.position.toArray(), moon: act.moonObj.mesh.position.toArray(), rMoon: act.moonObj.mesh.scale.x, rPlanet: act.mesh.scale.x, visible: act.moonObj.mesh.visible, separation: act.moon.sep } : null }),
  };
}
