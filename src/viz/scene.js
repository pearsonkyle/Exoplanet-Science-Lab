// three.js view of the star-planet system.
// World frame = model frame: X, Y on the sky, +Z toward the observer.
// Lengths are in stellar radii, so the star is a unit sphere.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { orbitPosition, orbitPath, trueAnomaly } from '../core/kepler.js';
import * as SH from './shaders.js';
import { teffToRGB } from './color.js';

// appearance by size class (see planetClass in core/derive.js)
export const PLANET_LOOKS = {
  jupiter:    { label: 'Jupiter-size', a: 0xd9a066, b: 0x8a5a3c, c: 0xf2e0c0, atmo: 0xffc98a, bands: 16 },
  neptune:    { label: 'Neptune-size', a: 0x4f86d9, b: 0x2f58b0, c: 0xbfe0ff, atmo: 0x8fc4ff, bands: 7 },
  subneptune: { label: 'sub-Neptune',  a: 0x8fc7c9, b: 0x5f9aa8, c: 0xe6f6f2, atmo: 0xb8f0ea, bands: 4 },
  earth:      { label: 'Earth-size',   a: 0x1f4f96, b: 0x4d7a3a, c: 0xf4f7fa, atmo: 0x7fb8ff, bands: 0 },
  lava:       { label: 'lava world',   a: 0x2a1a16, b: 0x7a2410, c: 0xff7a2a, atmo: 0xff8a4a, bands: 0 },
};

export async function createViz(container, labelsEl, insetFrame, onFatal) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });   // kept so the view can be copied into a recorded movie
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.autoClear = false;
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
  const starUni = { uLD: { value: new THREE.Vector4(0, 0.6, 0, 0) }, uColor: { value: new THREE.Color(1, 0.9, 0.75) }, uTime: { value: 0 }, uGran: { value: 1 }, uFlat: { value: 0 }, uOrtho: { value: 0 } };
  const star = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.ShaderMaterial({ uniforms: starUni, vertexShader: SH.starVert, fragmentShader: SH.starFrag }));
  sysGroup.add(star);

  const glowUni = { uColor: { value: new THREE.Color(1, 0.85, 0.6) }, uScale: { value: 7 }, uStrength: { value: 1 }, uTime: { value: 0 } };
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: glowUni, vertexShader: SH.glowVert, fragmentShader: SH.glowFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.renderOrder = 2;
  sysGroup.add(glow);

  // ---- planet ---------------------------------------------------------------
  const viewDir = new THREE.Vector3(0, 0, 1);
  const planetUni = { uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uColC: { value: new THREE.Color() }, uAtmo: { value: new THREE.Color() }, uBands: { value: 16 }, uFlat: { value: 0 }, uSeed: { value: 3.7 }, uViewDir: { value: viewDir }, uOrtho: { value: 0 } };
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 48), new THREE.ShaderMaterial({ uniforms: planetUni, vertexShader: SH.planetVert, fragmentShader: SH.planetFrag }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.09, 48, 32), new THREE.ShaderMaterial({ uniforms: planetUni, vertexShader: SH.planetVert, fragmentShader: SH.haloFrag, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  planet.add(halo);
  planet.rotation.z = 0.25;
  sysGroup.add(planet);

  // ---- orbit, grid, line of sight -------------------------------------------
  const N_ORB = 720;
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_ORB * 3), 3));
  orbitGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N_ORB * 3), 3));
  const orbitLine = new THREE.LineLoop(orbitGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
  sysGroup.add(orbitLine);

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
  const lblPlanet = mkLabel('planet', 'planet'), lblEarth = mkLabel('', '→ to Earth'), lblPeri = mkLabel('', 'periastron'), lblHZ = mkLabel('hz', 'habitable zone');
  const earthPos = new THREE.Vector3(), periPos = new THREE.Vector3(), hzPos = new THREE.Vector3();

  // ---- state ----------------------------------------------------------------
  let el = null, rprs = 0.1, rmax = 6, time = 0, autoLook = 'jupiter';
  const opts = { style: 'eyes', glow: true, granulation: true, stars: true, orbit: true, grid: false, corridor: true, labels: true, enlarge: false, inset: true, look: 'auto', hz: false };
  const pos = [0, 0, 0];
  let view = 'free', anim = null;
  const bg = new THREE.Color(0x000000);

  function applyLook() {
    const L = PLANET_LOOKS[opts.look === 'auto' ? autoLook : opts.look] || PLANET_LOOKS.jupiter;
    planetUni.uColA.value.setHex(L.a); planetUni.uColB.value.setHex(L.b); planetUni.uColC.value.setHex(L.c); planetUni.uAtmo.value.setHex(L.atmo);
    planetUni.uBands.value = L.bands;
    const flat = opts.style === 'blueprint' ? 1 : 0;
    planetUni.uFlat.value = flat; starUni.uFlat.value = flat;
    starUni.uGran.value = opts.granulation ? 1 : 0;
    bg.setHex(flat ? 0x04101c : 0x000000);
    halo.visible = !flat;
  }

  // points in the orbital plane: axes are -X and the direction of inferior conjunction
  const inPlane = (rho, th) => [-rho * Math.cos(th), -rho * Math.sin(th) * el.cosI, rho * Math.sin(th) * el.sinI];

  function rebuildOrbit() {
    const path = orbitPath(el, N_ORB);
    const colA = opts.style === 'blueprint' ? [0.45, 0.9, 1.0] : [0.42, 0.78, 1.0];
    const col = orbitGeo.attributes.color.array;
    for (let i = 0; i < N_ORB; i++) {
      const front = path[i * 3 + 2] > 0 ? 1 : 0.38; // dimmer on the far side of the star
      col[i * 3] = colA[0] * front; col[i * 3 + 1] = colA[1] * front; col[i * 3 + 2] = colA[2] * front;
    }
    orbitGeo.attributes.position.array.set(path); orbitGeo.attributes.position.needsUpdate = true; orbitGeo.attributes.color.needsUpdate = true;
    orbitGeo.computeBoundingSphere();

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
    rebuildHZ();
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

  const viewRadius = () => (opts.hz && hz ? Math.max(rmax, hz.outer) : rmax);

  function planetRadius(forTrueScale) {
    if (forTrueScale || !opts.enlarge) return rprs;
    return Math.max(rprs, 0.022 * camera.position.distanceTo(controls.target) / Math.max(camera.zoom, 1));
  }

  function setView(name, instant) {
    view = name;
    controls.enabled = name !== 'earth';
    if (name === 'earth') { anim = null; earth.half = Math.max(2.3, Math.min(1.3 + 2 * rprs, 6)); earth.cx = 0; earth.cy = 0; return; }
    const D = viewRadius() * 2.4 + 5;
    const to = name === 'top'
      ? new THREE.Vector3(0.02, el ? el.sinI - 0.02 * el.cosI : 1, el ? el.cosI + 0.02 * el.sinI : 0.02).normalize().multiplyScalar(D)
      : new THREE.Vector3(0.62, 0.36, 0.7).normalize().multiplyScalar(D);
    anim = { from: camera.position.clone(), to, t: instant ? 1 : 0 };
  }

  // zoom and pan for the orthographic Earth view (OrbitControls is switched off there)
  dom.addEventListener('wheel', (e) => {
    if (view !== 'earth') return; e.preventDefault();
    earth.half = Math.min(Math.max(earth.half * Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015))), 0.02), Math.max(8, rmax * 1.6));
  }, { passive: false });
  let drag = null;
  dom.addEventListener('pointerdown', (e) => { if (view === 'earth') { drag = [e.clientX, e.clientY, earth.cx, earth.cy]; dom.setPointerCapture(e.pointerId); } });
  dom.addEventListener('pointermove', (e) => { if (drag && view === 'earth') { const s = (2 * earth.half) / container.clientHeight; earth.cx = drag[2] - (e.clientX - drag[0]) * s; earth.cy = drag[3] + (e.clientY - drag[1]) * s; } });
  dom.addEventListener('pointerup', () => { drag = null; });
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
    orbitPosition(el, time, pos);
    planet.position.set(pos[0], pos[1], pos[2]);
    planet.rotation.y += dt * 0.25;
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
      earthCam.position.set(0, 0, viewRadius() * 2 + 50); earthCam.updateProjectionMatrix(); earthCam.updateMatrixWorld();
      sysGroup.visible = true; stars.visible = false;
      planet.scale.setScalar(planetRadius(true));
      orbitLine.visible = opts.orbit; grid.visible = false; tube.visible = false; los.visible = false; hzMesh.visible = false;
      glow.visible = opts.glow && !blueprint; glow.scale.setScalar(7); glowUni.uScale.value = 7; glowUni.uStrength.value = 0.8;
      glow.quaternion.copy(earthCam.quaternion);
      starUni.uOrtho.value = 1; planetUni.uOrtho.value = 1;
      renderer.render(scene, earthCam);
      placeLabel(lblPlanet, planet.position, opts.labels && pos[2] > 0, earthCam);
      lblEarth.style.display = 'none'; lblPeri.style.display = 'none'; lblHZ.style.display = 'none';
      insetFrame.hidden = true;
      return;
    }

    if (anim) {
      anim.t = Math.min(1, anim.t + dt / 0.9);
      const k = anim.t * anim.t * (3 - 2 * anim.t);
      camera.position.lerpVectors(anim.from, anim.to, k);
      controls.target.set(0, 0, 0);
      if (anim.t >= 1) anim = null;
    }
    controls.update();
    const dist = camera.position.length();
    camera.near = Math.max(0.02, dist * 0.002); camera.updateProjectionMatrix();

    sysGroup.visible = true;
    planet.scale.setScalar(planetRadius(false));
    orbitLine.visible = opts.orbit; grid.visible = opts.grid || blueprint; stars.visible = opts.stars && !blueprint;
    tube.visible = opts.corridor; los.visible = opts.corridor; hzMesh.visible = showHZ;
    glow.visible = opts.glow && !blueprint;
    const gs = Math.max(7, dist * 0.09); // never let the star shrink to nothing when zoomed far out
    glow.scale.setScalar(gs); glowUni.uScale.value = gs; glowUni.uStrength.value = 1;
    glow.quaternion.copy(camera.quaternion);
    starUni.uOrtho.value = 0; planetUni.uOrtho.value = 0;
    renderer.render(scene, camera);

    placeLabel(lblPlanet, planet.position, opts.labels, camera);
    placeLabel(lblEarth, earthPos, opts.labels && opts.corridor, camera);
    placeLabel(lblPeri, periPos, opts.labels && opts.orbit && el.e > 0.02, camera);
    placeLabel(lblHZ, hzPos, opts.labels && showHZ, camera);

    // inset: orthographic view along the line of sight at true scale
    insetFrame.hidden = !opts.inset;
    if (opts.inset) {
      const r = insetFrame.getBoundingClientRect(), c = container.getBoundingClientRect();
      const x = r.left - c.left, y = c.bottom - r.bottom, s = r.width;
      planet.scale.setScalar(planetRadius(true));
      orbitLine.visible = false; grid.visible = false; stars.visible = false; tube.visible = false; los.visible = false; hzMesh.visible = false;
      glow.scale.setScalar(7); glowUni.uScale.value = 7; glowUni.uStrength.value = 0.7;
      insetCam.position.set(0, 0, viewRadius() * 2 + 50); insetCam.lookAt(0, 0, 0);
      glow.quaternion.copy(insetCam.quaternion);
      starUni.uOrtho.value = 1; planetUni.uOrtho.value = 1;
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
    setSystem(sys) {
      const first = !el, prev = viewRadius();
      el = sys.el; rprs = sys.rprs; rmax = el.ars * (1 + el.e);
      starUni.uLD.value.set(sys.claret[0], sys.claret[1], sys.claret[2], sys.claret[3]);
      const [r, g, b] = teffToRGB(sys.teff);
      starUni.uColor.value.setRGB(r, g, b); glowUni.uColor.value.setRGB(r, g * 0.92, b * 0.8);
      lblPlanet.textContent = sys.name || 'planet';
      if (sys.look) autoLook = sys.look;
      hz = sys.hz || null;
      const half = Math.max(1.6, Math.min(4, 1.25 + rprs));
      insetCam.left = -half; insetCam.right = half; insetCam.top = half; insetCam.bottom = -half; insetCam.updateProjectionMatrix();
      rebuildOrbit(); applyLook();
      if (first) setView(view, true);
      else if (view !== 'earth' && Math.abs(viewRadius() - prev) / prev > 0.5) setView(view, false);
    },
    setTime(t) { time = t; },
    setOptions(o) {
      const hzWas = opts.hz;
      Object.assign(opts, o); applyLook();
      if (el) rebuildOrbit();
      if (el && opts.hz !== hzWas && view !== 'earth') setView(opts.hz ? 'top' : view, false);   // step back far enough to see the zone
    },
    setView(name) { setView(name, false); },
    getView: () => view,
    getOptions: () => ({ ...opts }),
  };
}
