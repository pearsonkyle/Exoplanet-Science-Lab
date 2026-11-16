// Immersive mode: the sky on a celestial sphere around the viewer, driven by three.js's WebXR manager, with
// controllers, hands or the gaze to point with.
//
// Drawing. The renderer (renderer.js) is switched to its perspective mode, in which the same scene is drawn through
// three.js's view and projection matrices, once per eye, as directions at infinity. This module adds what the flat
// view draws on its 2D canvas and its DOM, which a headset cannot show: names and markers as sprites on a sphere
// that follows the head, a menu and an information card as canvas textures on panels in the room, a pointing ray
// and a reticle per controller.
//
// Sessions. 'immersive-vr' shows the whole scene; 'immersive-ar' (passthrough) leaves out the sky backdrop and
// draws a translucent ground, so the camera image shows through. Nothing is a required feature; 'local-floor',
// 'hand-tracking' and (AR) 'dom-overlay' are asked for as options. The reference space is 'local-floor' when the
// session grants it, else 'local'.
//
// Orientation. A WebXR reference space is level (y is up) but has no compass. `heading` is the azimuth of its -z
// axis; the session starts with the viewer facing the azimuth the flat view was centred on. In passthrough the
// drawn sky must be turned onto the real one once: either point at a known bright object and pull the trigger
// ("Point & set" in the menu), or hold the grip and drag the sky.
//
// Input. Everything a pointer does is decided by pure functions in xrInput.js (tested in Node); this file reads
// poses and buttons and moves objects. See the table in the README section "Immersive mode".
//   trigger / pinch / tap / dwell   press the button under the ray, else select the sky object under it
//   grip + move                     turn the sky about the vertical, or (mode switch, B / Y) scrub the time
//   thumbstick left / right         run time backwards / forwards, the rate cubic in the deflection
//   thumbstick up / down            fainter / brighter limiting magnitude
//   thumbstick click                pause and resume the clock
//   A / X                           bring the menu in front of you (or fold it away)
//
// NOT RUN on a headset or a phone. It has been run in headless Chromium against Meta's WebXR runtime emulator
// (iwer): test/xr_check.py. What that does and does not show is in the README.
import { Group, Sprite, SpriteMaterial, CanvasTexture, LinearFilter, Vector3, Mesh, PlaneGeometry, MeshBasicMaterial, BufferGeometry, BufferAttribute, Line, LineBasicMaterial, CylinderGeometry, HemisphereLight, Matrix4, DoubleSide, SRGBColorSpace } from 'three';
import * as X from './xrInput.js';

const DIST = 30;       // metres from the head to the label sphere (far enough to read as "on the sky")
const FONT = '600 44px Inter, system-ui, sans-serif';
const UI = 'Inter, system-ui, sans-serif';
const PICK_TOL = 1.6 * Math.PI / 180, GAZE_TOL = 2.2 * Math.PI / 180, DWELL_MS = 1300;

function spriteOf(canvas, order) {
  const tex = new CanvasTexture(canvas); tex.minFilter = tex.magFilter = LinearFilter; tex.generateMipmaps = false; tex.colorSpace = SRGBColorSpace;
  const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  s.userData.aspect = canvas.width / canvas.height; s.renderOrder = order; s.frustumCulled = false;
  return s;
}
function textSprite(text, color) {
  const c = document.createElement('canvas'), g = c.getContext('2d'); g.font = FONT;
  const w = Math.ceil(g.measureText(text).width) + 24; c.width = w; c.height = 64;
  g.font = FONT; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = 8; g.strokeStyle = 'rgba(2,4,10,0.7)'; g.strokeText(text, 12, 34); g.fillStyle = color; g.fillText(text, 12, 34);
  return spriteOf(c, 80);
}
/** style 'target': a ring with four ticks; 'mark': a small ring with a dot; 'reticle': a thin ring. */
function ringSprite(color, style = 'target') {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'), r = style === 'target' ? 70 : 84;
  g.strokeStyle = 'rgba(2,4,10,0.8)'; g.lineWidth = style === 'reticle' ? 20 : 16; g.beginPath(); g.arc(128, 128, r, 0, 7); g.stroke();
  g.strokeStyle = color; g.lineWidth = style === 'reticle' ? 10 : 8; g.beginPath(); g.arc(128, 128, r, 0, 7); g.stroke();
  if (style === 'target') { g.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(128 + dx * 84, 128 + dy * 84); g.lineTo(128 + dx * 122, 128 + dy * 122); } g.stroke(); }
  if (style === 'mark') { g.fillStyle = color; g.beginPath(); g.arc(128, 128, 30, 0, 7); g.fill(); }
  return spriteOf(c, 79);
}
const disposeSprite = (s) => { s.material.map.dispose(); s.material.dispose(); };

// ---------------------------------------------------------------- a panel: a canvas drawn on a rectangle in the room
// model: { type, title, sub, kv: [[key, value]], notes: [text | { text, color }], rows: [[{ id, label, sub, on, disabled, span, color }]] }
// (a button's color: a swatch beside its label, e.g. the discovery methods)
function createPanel(widthM, order, PW = 800) {      // PW: canvas pixels across the panel
  const canvas = document.createElement('canvas'); canvas.width = PW; canvas.height = 64;
  const tex = new CanvasTexture(canvas); tex.minFilter = tex.magFilter = LinearFilter; tex.generateMipmaps = false; tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }));
  mesh.renderOrder = order; mesh.frustumCulled = false; mesh.visible = false; mesh.matrixAutoUpdate = false;
  const p = { mesh, canvas, tex, widthM, pw: PW, geom: null, rects: [], height: 64, key: '', model: null, anchor: null };
  /** Draw the model; hover: the id of the button under a pointer; progress: 0..1 of a dwell on it. */
  p.draw = (model, hover = null, progress = 0) => {
    const key = JSON.stringify(model) + '|' + hover + '|' + Math.round(progress * 12); if (key === p.key) return; p.key = key; p.model = model;
    const g = canvas.getContext('2d'), wrapText = (text, font, maxW) => { g.font = font; const out = []; let line = ''; for (const w of String(text).split(' ')) { const t = line ? line + ' ' + w : w; if (line && g.measureText(t).width > maxW) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; };
    // measure first: the header, the key-value lines, the notes, then the buttons
    let y = 18; const ops = [];
    if (model.type) { const yy = y; ops.push(() => { g.font = `600 20px ${UI}`; g.fillStyle = '#5fd4ff'; g.fillText(model.type.toUpperCase(), 24, yy + 14); }); y += 30; }
    if (model.title) { const lines = wrapText(model.title, `600 40px ${UI}`, PW - 48); for (const l of lines) { const yy = y; ops.push(() => { g.font = `600 40px ${UI}`; g.fillStyle = '#ffffff'; g.fillText(l, 24, yy + 24); }); y += 48; } }
    if (model.sub) for (const l of wrapText(model.sub, `26px ${UI}`, PW - 48)) { const yy = y; ops.push(() => { g.font = `26px ${UI}`; g.fillStyle = '#9aa6c0'; g.fillText(l, 24, yy + 16); }); y += 34; }
    if (model.kv && model.kv.length) { y += 8; for (const [k, v] of model.kv) { const yy = y; ops.push(() => { g.font = `26px ${UI}`; g.fillStyle = '#9aa6c0'; g.textAlign = 'left'; g.fillText(k, 24, yy + 16); g.font = '26px ui-monospace, Menlo, monospace'; g.fillStyle = '#e6ecf8'; g.textAlign = 'right'; g.fillText(v, PW - 24, yy + 16); g.textAlign = 'left'; }); y += 36; } }
    if (model.notes) for (const n of model.notes) { y += 6; for (const l of wrapText(n.text ?? n, `24px ${UI}`, PW - 48)) { const yy = y, col = n.color || '#c6cfe0'; ops.push(() => { g.font = `24px ${UI}`; g.fillStyle = col; g.fillText(l, 24, yy + 15); }); y += 31; } }
    const L = X.layoutRows(model.rows || [], PW, { pad: 16, gap: 10, rowH: 76, top: y - 6 });
    const H = Math.max(64, Math.ceil(model.rows && model.rows.length ? L.height : y + 18));
    if (canvas.height !== H) { canvas.height = H; tex.dispose(); }
    p.rects = L.rects; p.height = H;
    g.clearRect(0, 0, PW, H); g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = 'rgba(8,11,18,0.93)'; g.strokeStyle = '#3a4668'; g.lineWidth = 3; g.beginPath(); g.roundRect(2, 2, PW - 4, H - 4, 22); g.fill(); g.stroke();
    for (const op of ops) op();
    for (const r of L.rects) {
      if (!r.id) { g.font = `600 22px ${UI}`; g.fillStyle = '#8491ad'; g.textAlign = 'left'; g.fillText(String(r.label || '').toUpperCase(), r.x + 4, r.y + r.h / 2); continue; }
      const hot = r.id === hover && !r.disabled; g.globalAlpha = r.disabled ? 0.38 : 1;
      g.fillStyle = r.on ? 'rgba(95,212,255,0.26)' : hot ? '#26314d' : '#151c2e'; g.strokeStyle = hot ? '#ffffff' : r.on ? '#5fd4ff' : '#2f3a58'; g.lineWidth = hot ? 4 : 2;
      g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 14); g.fill(); g.stroke();
      if (hot && progress > 0) { g.fillStyle = 'rgba(95,212,255,0.35)'; g.beginPath(); g.roundRect(r.x, r.y, r.w * Math.min(1, progress), r.h, 14); g.fill(); }
      g.fillStyle = r.on ? '#e9f8ff' : '#dfe6f5';
      const sw = r.color ? 30 : 0;
      if (sw) { g.fillStyle = r.color; g.beginPath(); g.arc(r.x + 22, r.y + r.h / 2, 9, 0, 7); g.fill(); g.fillStyle = r.on ? '#e9f8ff' : '#dfe6f5'; }
      let size = 28; g.font = `600 ${size}px ${UI}`; while (size > 18 && g.measureText(r.label).width > r.w - sw - (r.sub ? 0.45 * r.w : 16)) { size -= 2; g.font = `600 ${size}px ${UI}`; }
      if (r.sub) { g.textAlign = 'left'; g.fillText(r.label, r.x + 16, r.y + r.h / 2); g.font = `22px ${UI}`; g.fillStyle = '#9fb0d0'; g.textAlign = 'right'; g.fillText(r.sub, r.x + r.w - 16, r.y + r.h / 2); }
      else { g.textAlign = 'center'; g.fillText(r.label, r.x + (r.w + sw) / 2, r.y + r.h / 2); }
      g.globalAlpha = 1; g.textAlign = 'left';
    }
    tex.needsUpdate = true;
    if (p.anchor) p.place(p.anchor.head, p.anchor.forward, p.anchor.opts);      // the height may have changed
  };
  /** Put the panel in front of a head (see placePanel); its top edge stays where it is when the height changes. */
  p.place = (head, forward, opts) => {
    p.anchor = { head: [...head], forward: [...forward], opts };
    const h = widthM * p.height / PW, q = X.placePanel(head, forward, { ...opts, w: widthM, h });
    p.geom = q; const n = X.cross(q.right, q.up);
    mesh.matrix.copy(new Matrix4().set(q.right[0] * q.w, q.up[0] * q.h, n[0], q.centre[0], q.right[1] * q.w, q.up[1] * q.h, n[1], q.centre[1], q.right[2] * q.w, q.up[2] * q.h, n[2], q.centre[2], 0, 0, 0, 1));
    mesh.matrixWorldNeedsUpdate = true;
  };
  /** The button of this panel under a ray, with the distance: { item, t, point } ('item' null on bare panel), or null. */
  p.hit = (ray) => {
    if (!mesh.visible || !p.geom) return null;
    const h = X.rayPanel(ray.origin, ray.dir, p.geom); if (!h) return null;
    return { item: X.hitRects(p.rects, h.u * PW, h.v * p.height), t: h.t, point: h.point, panel: p };
  };
  return p;
}

/**
 * host (the page): everything the immersive mode needs to know or change.
 *   pick(worldDir, tolRad) -> { sel, dir (world), name } | null      select(sel | null)
 *   card() -> the panel model of the selection, or null              menu(xrState) -> the panel model of the menu
 *   act(id)                the page's own actions (ids without 'xr:')
 *   time() / setTime(ms)   the clock                                 adjustMag(delta)   the limiting magnitude
 *   togglePlay()           alignTargets() -> [{ name, az, alt }] (radians, above the horizon)
 *   onStart(kind), onEnd(kind), status(text)
 */
export function createXR(R, host = {}) {
  const renderer = R.renderer, group = new Group(), sprites = new Map(), tmp = new Vector3();
  group.visible = false; R.scene.add(group);
  const st = { session: null, kind: '', heading: 0, refType: 'local', grip: 'turn', aligning: false, alignIndex: 0, menuOpen: true, frames: 0, selects: 0, haptics: 0, lastHit: null, error: '', frameRate: null, features: null, hands: false };
  const menu = createPanel(0.84, 90, 1200), card = createPanel(0.56, 91, 800);
  group.add(menu.mesh, card.mesh, new HemisphereLight(0xffffff, 0x556070, 2.2));
  const head = { pos: [0, 1.6, 0], fwd: [0, 0, -1] };
  if (host.overlayRoot) host.overlayRoot.addEventListener('beforexrselect', (e) => e.preventDefault());       // a tap on the overlay's buttons is not a tap on the sky
  let pointers = null, gaze = null, libsPromise = null, menuClock = 0, dwellSt = {}, cardKey = '';
  const libs = () => (libsPromise ||= Promise.all([import('three/examples/jsm/webxr/XRControllerModelFactory.js'), import('three/examples/jsm/webxr/XRHandModelFactory.js')]).catch((e) => { libsPromise = null; console.warn('controller models:', e); return null; }));

  // ---- pointers: one per controller slot, and one for the gaze
  function makeVisuals() {
    const geo = new BufferGeometry(); geo.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    const line = new Line(geo, new LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false })); line.renderOrder = 94; line.frustumCulled = false; line.visible = false;
    const reticle = ringSprite('#5fd4ff', 'reticle'); reticle.renderOrder = 96; reticle.visible = false;
    group.add(line, reticle);
    return { line, reticle, name: null, nameText: '' };
  }
  function buildPointers(mods) {
    if (pointers) return;
    const cmf = mods && new mods[0].XRControllerModelFactory(), hmf = mods && new mods[1].XRHandModelFactory();
    pointers = [0, 1].map((i) => {
      const controller = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i), hand = renderer.xr.getHand(i);
      const p = { i, controller, grip, hand, source: null, prev: [], grab: null, hit: null, pickAt: 0, sky: null, ...makeVisuals() };
      // a plain wand along the ray, so that there is something in the hand before (or without) the downloaded model
      const wand = new Mesh(new CylinderGeometry(0.006, 0.012, 0.12, 12), new MeshBasicMaterial({ color: 0x8fa3c8, transparent: true, opacity: 0.9, depthTest: false })); wand.rotation.x = -Math.PI / 2; wand.position.z = -0.03; wand.renderOrder = 97; wand.frustumCulled = false; controller.add(wand); p.wand = wand;
      if (cmf) grip.add(cmf.createControllerModel(grip));
      if (hmf) hand.add(hmf.createHandModel(hand, 'spheres'));
      controller.addEventListener('connected', (e) => { p.source = e.data; p.prev = []; wand.visible = e.data.targetRayMode === 'tracked-pointer' && !e.data.hand; if (e.data.hand) st.hands = true; });
      controller.addEventListener('disconnected', () => { p.source = null; p.grab = null; p.hit = null; p.line.visible = p.reticle.visible = false; if (p.name) p.name.visible = false; });
      controller.addEventListener('squeezestart', () => { const ray = rayOf(p); p.grab = X.grabStart(ray.dir, st.grip === 'turn' ? st.heading : host.time()); pulse(p.source, 0.3, 20); });
      controller.addEventListener('squeezeend', () => { p.grab = null; });
      group.add(controller, grip, hand);
      return p;
    });
    gaze = { i: 'gaze', source: null, hit: null, pickAt: 0, sky: null, ...makeVisuals() };
  }
  const rayOf = (p) => X.rayOfMatrix(p.controller.matrixWorld.elements);
  /** Models arrive late (a download) and must be drawn after the sky, which is transparent and ignores depth. */
  function fixOrder() {
    if (!pointers) return;
    for (const p of pointers) { let model = false; p.grip.traverse((o) => { if (o.isMesh) model = true; }); p.wand.visible = !model && !!p.source && p.source.targetRayMode === 'tracked-pointer' && !p.source.hand; }
    for (const p of pointers) for (const root of [p.grip, p.hand]) root.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && !o.userData.eslOrder) { o.userData.eslOrder = true; o.renderOrder = 98; o.frustumCulled = false; for (const m of [].concat(o.material)) { m.transparent = true; m.depthWrite = true; m.needsUpdate = true; } } });
  }
  function pulse(source, strength = 0.6, ms = 35) {
    const gp = source && source.gamepad; if (!gp) return;
    try {
      if (gp.hapticActuators && gp.hapticActuators[0] && gp.hapticActuators[0].pulse) { gp.hapticActuators[0].pulse(strength, ms); st.haptics++; }
      else if (gp.vibrationActuator && gp.vibrationActuator.playEffect) { gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength }); st.haptics++; }
    } catch { /* no haptics on this device */ }
  }

  // ---- what a ray meets: a panel's button, the bare panel, or the sky
  function hitTest(ray, tol) {
    const hits = [menu.hit(ray), card.hit(ray)].filter(Boolean).sort((a, b) => a.t - b.t);
    if (hits.length) return { kind: 'panel', ...hits[0] };
    const w = X.refToWorld(ray.dir, st.heading), s = host.pick ? host.pick(w, tol) : null;
    return { kind: 'sky', world: w, found: s };
  }
  function placePanels() { menu.place(head.pos, head.fwd, { dist: 0.85, drop: 0.5 }); card.place(head.pos, head.fwd, { dist: 0.95, drop: 0.12, yaw: 0.72 }); }
  const xrState = () => ({ kind: st.kind, grip: st.grip, aligning: st.aligning, alignTarget: alignTarget(), menuOpen: st.menuOpen, heading: st.heading, hands: st.hands, gaze: gazeActive() });
  const alignList = () => (host.alignTargets ? host.alignTargets() : []);
  const alignTarget = () => { const l = alignList(); return l.length ? l[st.alignIndex % l.length] : null; };
  function drawPanels(hover, progress) {
    menu.mesh.visible = true;
    menu.draw(host.menu ? host.menu(xrState()) : { rows: [[{ id: 'xr:exit', label: 'Exit' }]] }, hover && hover.panel === menu && hover.item ? hover.item.id : null, progress);
    const c = host.card ? host.card() : null;
    card.mesh.visible = !!c;
    if (c) { const k = c.key || c.title; if (k !== cardKey) { cardKey = k; card.place(head.pos, head.fwd, { dist: 0.95, drop: 0.12, yaw: 0.72 }); } card.draw(c, hover && hover.panel === card && hover.item ? hover.item.id : null, progress); } else cardKey = '';
  }
  /** A press: of the trigger, a pinch, a tap on the screen or a completed dwell. */
  function press(ray, source, tol = PICK_TOL) {
    st.selects++;
    const h = hitTest(ray, tol);
    if (h.kind === 'panel') { st.lastHit = { kind: 'panel', id: h.item ? h.item.id : null }; if (h.item) { pulse(source); action(h.item.id); } return; }
    if (st.aligning) {
      const t = alignTarget(), hd = t && X.alignHeading(ray.dir, t.az);
      if (hd == null) { host.status && host.status('Point lower: too close to the zenith to set the compass.'); return; }
      api.setHeading(hd); st.aligning = false; pulse(source, 0.9, 60); st.lastHit = { kind: 'align', name: t.name, heading: hd };
      host.status && host.status(`Compass set on ${t.name}.`); return;
    }
    st.lastHit = { kind: 'sky', name: h.found ? h.found.name : null };
    if (h.found) pulse(source);
    host.select && host.select(h.found ? h.found.sel : null);
  }
  function action(id) {
    if (id === 'xr:exit') api.stop();
    else if (id === 'xr:hide') st.menuOpen = false;
    else if (id === 'xr:show') { st.menuOpen = true; placePanels(); }
    else if (id === 'xr:grip') st.grip = st.grip === 'turn' ? 'time' : 'turn';
    else if (id === 'xr:alignNext') { const n = alignList().length; st.alignIndex = n ? (st.alignIndex + 1) % n : 0; }
    else if (id === 'xr:align') st.aligning = !st.aligning && !!alignTarget();
    else if (id === 'xr:turnL' || id === 'xr:turnR') api.setHeading(X.wrapPi(st.heading + (id === 'xr:turnL' ? -1 : 1) * 5 * Math.PI / 180));
    else if (host.act) host.act(id);
    menu.key = '';
  }
  const gazeActive = () => !!st.session && !(pointers || []).some((p) => p.source && p.source.targetRayMode === 'tracked-pointer');

  /** Draw a pointer: the ray to what it meets and a reticle there (on the object when the ray is on one). */
  function show(p, ray, h, withLine) {
    let end, size;
    if (h.kind === 'panel') { end = h.point; size = 0.012; }
    else {
      const d = h.found ? X.worldToRef(h.found.dir, st.heading) : ray.dir;
      end = [head.pos[0] + d[0] * DIST, head.pos[1] + d[1] * DIST, head.pos[2] + d[2] * DIST]; size = DIST * Math.tan((h.found ? 1.3 : 0.5) * Math.PI / 180);
    }
    p.reticle.visible = true; p.reticle.position.set(end[0], end[1], end[2]); p.reticle.scale.set(size * 2, size * 2, 1);
    p.line.visible = !!withLine;
    if (withLine) {
      const a = p.line.geometry.attributes.position, len = h.kind === 'panel' ? h.t : 4, e = [ray.origin[0] + ray.dir[0] * len, ray.origin[1] + ray.dir[1] * len, ray.origin[2] + ray.dir[2] * len];
      a.setXYZ(0, ray.origin[0], ray.origin[1], ray.origin[2]); a.setXYZ(1, e[0], e[1], e[2]); a.needsUpdate = true;
      p.line.material.opacity = h.kind === 'panel' ? 0.9 : 0.45;
    }
    // the name of the sky object under the ray, beside the reticle
    const text = h.kind === 'sky' && h.found ? h.found.name : '';
    if (text !== p.nameText) { if (p.name) { group.remove(p.name); disposeSprite(p.name); p.name = null; } p.nameText = text; if (text) { p.name = textSprite(text, '#bfeaff'); p.name.renderOrder = 96; group.add(p.name); } }
    if (p.name) { const hgt = DIST * Math.tan(1.5 * Math.PI / 180); p.name.visible = true; p.name.position.set(end[0], end[1] - size * 1.9, end[2]); p.name.scale.set(hgt * p.name.userData.aspect, hgt, 1); p.name.center.set(0.5, 0.5); }
  }
  const hide = (p) => { p.line.visible = p.reticle.visible = false; if (p.name) p.name.visible = false; p.hit = null; };

  const api = {
    state: st, group, menu, card,
    get presenting() { return !!st.session; },
    get pointers() { return pointers; },
    /** Which immersive sessions this browser offers: { vr, ar, message: { vr, ar } } ('' when available). */
    async supported() {
      const xr = typeof navigator !== 'undefined' && navigator.xr, secure = typeof window === 'undefined' || window.isSecureContext !== false;
      const ask = (k) => (xr && xr.isSessionSupported ? xr.isSessionSupported(k).catch(() => false) : Promise.resolve(false));
      const [vr, ar] = await Promise.all([ask('immersive-vr'), ask('immersive-ar')]);
      if (vr || ar) libs();        // fetch the controller code while the user decides
      return { vr, ar, message: X.supportMessages({ hasXR: !!(xr && xr.isSessionSupported), secure, vr, ar }) };
    },
    /** Must be called from a user gesture. kind: 'vr' | 'ar'; heading: the azimuth (radians) the viewer is facing. */
    async start(kind, heading = 0) {
      if (st.session) return;
      if (!navigator.xr) throw new Error(X.supportMessages({ hasXR: false, secure: window.isSecureContext !== false }).vr);
      const { mode, init } = X.sessionInit(kind, kind === 'ar' ? host.overlayRoot : null);
      const session = await navigator.xr.requestSession(mode, init);       // first, while the user gesture is fresh
      try {
        // the floor-level space when the session grants it (the horizon is the same in both; this one knows the floor)
        st.refType = await session.requestReferenceSpace('local-floor').then(() => 'local-floor', () => 'local');
        buildPointers(await libs());
        Object.assign(st, { session, kind, heading, aligning: false, menuOpen: true, frames: 0, selects: 0, lastHit: null, hands: false, error: '' });
        st.features = session.enabledFeatures ? Array.from(session.enabledFeatures) : null;
        renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType(st.refType);
        // a light scene of points and lines: mild foveation keeps small stars and text sharp away from the centre
        renderer.xr.setFoveation(0.5);
        R.setMode('perspective'); R.setHeading(heading); R.setPointScale(1.6);
        R.camera.matrix.identity(); R.camera.updateMatrixWorld(true);
        if (kind === 'ar') renderer.setClearColor(0x000000, 0);
        group.visible = true; menu.key = card.key = cardKey = ''; menu.anchor = card.anchor = null;
        session.addEventListener('end', () => {
          st.session = null; renderer.xr.enabled = false; group.visible = false; renderer.setClearColor(0x010207, 1);
          for (const p of [...(pointers || []), gaze]) if (p) { hide(p); p.grab = null; }
          host.onEnd && host.onEnd(kind);
        });
        // the press itself, with the pose of that instant (a tap on a phone lives for one event only)
        session.addEventListener('selectstart', (e) => {
          let ray = null;
          try { const space = renderer.xr.getReferenceSpace(), pose = space && e.frame && e.frame.getPose(e.inputSource.targetRaySpace, space); if (pose) ray = X.rayOfMatrix(pose.transform.matrix); } catch { /* fall back to the last frame's pose */ }
          const p = (pointers || []).find((x) => x.source === e.inputSource);
          if (!ray && p) ray = rayOf(p);
          if (!ray) ray = { origin: head.pos, dir: head.fwd };
          press(ray, e.inputSource, e.inputSource.targetRayMode === 'tracked-pointer' ? PICK_TOL : GAZE_TOL);
        });
        await renderer.xr.setSession(session);
        // 72 Hz where the display offers a choice (Quest: 72 to 120): steady, and kind to the battery
        const rate = X.chooseFrameRate(session.supportedFrameRates);
        if (rate && session.updateTargetFrameRate) session.updateTargetFrameRate(rate).then(() => { st.frameRate = rate; }, () => {});
        host.onStart && host.onStart(kind);
      } catch (e) { st.session = null; renderer.xr.enabled = false; group.visible = false; try { await session.end(); } catch { /* already over */ } throw e; }
    },
    stop() { if (st.session) st.session.end().catch(() => {}); },
    setHeading(h) { st.heading = h; R.setHeading(h); },
    /** Once per frame while a session runs, before the scene is drawn: poses, buttons, panels. dt in milliseconds. */
    update(dt, now = performance.now()) {
      if (!st.session) return;
      st.frames++;
      const cam = renderer.xr.getCamera(), e = cam.matrixWorld.elements;
      head.pos = [e[12], e[13], e[14]]; head.fwd = X.norm([-e[8], -e[9], -e[10]]);
      // the scale of everything sized in pixels (stars, the Sun's and the Moon's discs): pixels per radian of one eye
      const eye = cam.cameras && cam.cameras[0];
      if (eye && eye.viewport && eye.viewport.z > 0) R.setPixelFocal(eye.projectionMatrix.elements[0] * eye.viewport.z / 2 / 1.6);
      if (st.frames === 2 || !menu.anchor) placePanels();
      if (st.frames % 30 === 1) fixOrder();
      if (st.session.visibilityState && st.session.visibilityState !== 'visible') return;      // the system menu is open
      let hover = null, progress = 0, rate = 0, dMag = 0;
      for (const p of pointers) {
        const s = p.source;
        if (!s || s.targetRayMode !== 'tracked-pointer') { hide(p); continue; }
        const ray = rayOf(p);
        // panels every frame; the sky (a scan of the catalogue) fifteen times a second
        let h = null; const ph = [menu.hit(ray), card.hit(ray)].filter(Boolean).sort((a, b) => a.t - b.t)[0];
        if (ph) h = { kind: 'panel', ...ph };
        else if (p.grab) h = { kind: 'sky', found: null };
        else { if (now - p.pickAt > 66) { p.pickAt = now; p.sky = hitTest(ray, PICK_TOL); } h = p.sky && p.sky.kind === 'sky' ? p.sky : { kind: 'sky', found: null }; }
        const hid = h.kind === 'panel' ? (h.item ? h.item.id : '') : h.found ? 'sky:' + h.found.name : null, was = p.hit;
        if (hid && hid !== was && h.kind === 'panel' && h.item) pulse(s, 0.15, 10);
        p.hit = hid; if (h.kind === 'panel' && h.item) hover = h;
        show(p, ray, h, true);
        if (p.grab) { const turned = X.grabMove(p.grab, ray.dir); if (st.grip === 'turn') api.setHeading(X.grabHeading(p.grab.value, turned)); else host.setTime(X.grabTime(p.grab.value, turned)); }
        const gp = s.gamepad;
        if (gp) {
          const [sx, sy] = X.stickOf(gp.axes); const r = X.stickTimeRate(sx), m = X.stickStep(sy, dt / 1000);
          if (Math.abs(r) > Math.abs(rate)) rate = r; if (Math.abs(m) > Math.abs(dMag)) dMag = m;
          for (const b of X.pressedEdges(p.prev, gp.buttons)) {
            if (b === X.BUTTON.a) { st.menuOpen = !st.menuOpen; if (st.menuOpen) placePanels(); menu.key = ''; pulse(s, 0.4, 20); }
            else if (b === X.BUTTON.b) { action('xr:grip'); pulse(s, 0.4, 20); }
            else if (b === X.BUTTON.stick) host.togglePlay && host.togglePlay();
          }
        }
      }
      st.rate = rate;
      if (rate) host.setTime(host.time() + rate * dt);
      if (dMag && host.adjustMag) host.adjustMag(dMag);
      // without a tracked controller or hand: the gaze points, a dwell presses (a Cardboard's button also presses, as a 'gaze' select)
      if (gazeActive()) {
        const ray = { origin: head.pos, dir: head.fwd }; let h; const ph = [menu.hit(ray), card.hit(ray)].filter(Boolean).sort((a, b) => a.t - b.t)[0];
        if (ph) h = { kind: 'panel', ...ph }; else { if (now - gaze.pickAt > 100) { gaze.pickAt = now; gaze.sky = hitTest(ray, GAZE_TOL); } h = gaze.sky && gaze.sky.kind === 'sky' ? gaze.sky : { kind: 'sky', found: null }; }
        const id = h.kind === 'panel' ? (h.item ? 'p:' + h.item.id : null) : h.found && !st.aligning ? 'sky:' + h.found.name : null;
        dwellSt = X.dwell(dwellSt, id, dt, DWELL_MS); progress = dwellSt.progress;
        if (h.kind === 'panel' && h.item) hover = h;
        show(gaze, ray, h, false);
        const sz = gaze.reticle.scale.x * (1 + 0.8 * (id ? 1 - progress : 0)); gaze.reticle.scale.set(sz, sz, 1);
        if (dwellSt.fire) press(ray, null, GAZE_TOL);
      } else if (gaze) { hide(gaze); dwellSt = {}; }
      if (hover || now - menuClock > 200 || !menu.key) { menuClock = now; drawPanels(hover, progress); }
    },
    /**
     * Show these labels: [{ key, text, dir: world direction, color, deg: height of the text in degrees, ring: bool | style }].
     * Sprites are made once per key and text and moved every frame. camera: the camera the scene is drawn with.
     */
    setLabels(list, camera) {
      const c = Math.cos(st.heading), s = Math.sin(st.heading), seen = new Set();
      camera.getWorldPosition(tmp); const o = st.session ? head.pos : [tmp.x, tmp.y, tmp.z];
      for (const l of list) {
        const id = l.key + '|' + (l.ring ? '' : l.text); seen.add(id);
        let sp = sprites.get(id);
        if (!sp) { sp = l.ring ? ringSprite(l.color, l.ring === true ? 'target' : l.ring) : textSprite(l.text, l.color); sprites.set(id, sp); group.add(sp); }
        const h = DIST * Math.tan((l.deg || 1.3) * Math.PI / 180), d = l.dir;
        // the same rotation as the shaders' uView, then out to the label sphere; text sits to the right of its object
        sp.position.set(o[0] + (c * d[0] + s * d[2]) * DIST, o[1] + d[1] * DIST, o[2] + (-s * d[0] + c * d[2]) * DIST);
        sp.scale.set(h * sp.userData.aspect, h, 1);
        sp.center.set(l.ring || l.centre ? 0.5 : -0.12, 0.5);
        sp.visible = true;
      }
      for (const [id, sp] of sprites) if (!seen.has(id)) { if (sprites.size > 400) { group.remove(sp); disposeSprite(sp); sprites.delete(id); } else sp.visible = false; }
    },
  };
  return api;
}
