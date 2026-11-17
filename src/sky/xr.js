// Immersive mode: the sky on a celestial sphere around the viewer, driven by three.js's WebXR manager, with
// controllers, hands, a gaze-and-pinch pointer or the gaze alone to point with.
//
// Drawing. The renderer (renderer.js) is switched to its perspective mode, in which the same scene is drawn through
// three.js's view and projection matrices, once per eye, as directions at infinity. This module adds what the flat
// view draws on its 2D canvas and its DOM, which a headset cannot show: names and markers as sprites on a sphere
// that follows the head, floating windows (canvas textures on rectangles in the room: the menu, the card of the
// selection, a survey image of it, and the folded menu's two buttons), a pointing ray and a reticle per controller.
//
// Windows. Each has a title bar (grab it to move the window: trigger, pinch or a gaze-and-pinch held on it, or the
// grip anywhere on the window; while moving, the thumbstick pushes it away or pulls it in), a handle in the
// bottom-right corner (grab it to resize; the aspect ratio is kept) and buttons. The menu is shown a tab at a time.
// The geometry, the hit zones, the tabs and the gestures are pure functions in xrPanel.js (test/xrpanel.test.mjs).
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
// Input (the table is in the sky page's help and in docs/guide/validation.md, "Observe: the sky").
//   trigger / pinch / gaze-and-pinch / tap / dwell   press the button under the ray, else select the sky object
//   ... held on a title bar or a corner handle       move or resize that window
//   pinch or gaze-and-pinch held and dragged on the sky   turn the sky (VR) like the grip
//   grip + move                     on a window: move it; on the sky: turn it, or (B / Y tap) scrub the time
//   thumbstick left / right         run time backwards / forwards, the rate cubic in the deflection
//   thumbstick up / down            fainter / brighter limiting magnitude (while moving a window: its distance)
//   thumbstick click                pause and resume the clock
//   A / X, palm up (hands)          bring the menu in front of you, or fold it away when it is in front
//   B / Y held 1 s, "Exit VR"       leave the immersive mode (the browser's own exit works too)
//
// NOT RUN on a headset or a phone. It has been run in headless Chromium against Meta's WebXR runtime emulator
// (iwer): test/xr_check.py. Hand-joint gestures (the pinch fallback, palm up) and transient pointers (Vision Pro)
// are tested only as pure functions with synthetic poses.
import { Group, Sprite, SpriteMaterial, CanvasTexture, LinearFilter, Vector3, Mesh, PlaneGeometry, MeshBasicMaterial, BufferGeometry, BufferAttribute, Line, LineBasicMaterial, CylinderGeometry, HemisphereLight, Matrix4, DoubleSide, SRGBColorSpace } from 'three';
import * as X from './xrInput.js';
import * as XP from './xrPanel.js';

const DIST = 30;       // metres from the head to the label sphere (far enough to read as "on the sky")
const FONT = '600 44px Inter, system-ui, sans-serif';
const UI = 'Inter, system-ui, sans-serif';
const PICK_TOL = 1.6 * Math.PI / 180, GAZE_TOL = 2.2 * Math.PI / 180, DWELL_MS = 1300;
const HIPS2FITS = ['https://alasky.cds.unistra.fr/hips-image-services/hips2fits', 'https://alaskybis.cds.unistra.fr/hips-image-services/hips2fits'];
const SURVEY_FOV = [5, 12, 30, 60];      // arcmin across the survey image

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
function loadImage(url, ms = 15000) {
  return new Promise((resolve) => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    const t = setTimeout(() => { img.src = ''; resolve(null); }, ms);
    img.onload = () => { clearTimeout(t); resolve(img); }; img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

// ---------------------------------------------------------------- a window: a canvas drawn on a rectangle in the room
// model: { type, title, sub, kv: [[key, value]], notes: [text | { text, color }], image, imageKey, rows: [[{ id, label, sub, on, disabled, span, color }]], frame }
// (a button's color: a swatch beside its label, e.g. the discovery methods; frame: false draws no title bar or handle)
// ex (the window's own furniture): { title, buttons: [{ id, label, w }], hot: 'title' | 'resize' | null, exit: 0..1 }
function createPanel(name, widthM, order, PW = 800) {      // PW: canvas pixels across the window
  const canvas = document.createElement('canvas'); canvas.width = PW; canvas.height = 64;
  const tex = new CanvasTexture(canvas); tex.minFilter = tex.magFilter = LinearFilter; tex.generateMipmaps = false; tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }));
  mesh.renderOrder = order; mesh.frustumCulled = false; mesh.visible = false; mesh.matrixAutoUpdate = false;
  const p = { name, mesh, canvas, tex, widthM, w0: widthM, pw: PW, geom: null, rects: [], body: [], title: [], frame: true, height: 64, key: '', model: null, userPlaced: false, saved: null };
  p.draw = (model, hover = null, progress = 0, ex = {}) => {
    const frame = model.frame !== false;
    const key = JSON.stringify(model) + '|' + (model.imageKey || '') + '|' + hover + '|' + Math.round(progress * 12) + '|' + JSON.stringify(ex) + '|' + Math.round((ex.exit || 0) * 20); if (key === p.key) return; p.key = key; p.model = model;
    const g = canvas.getContext('2d'), wrapText = (text, font, maxW) => { g.font = font; const out = []; let line = ''; for (const w of String(text).split(' ')) { const t = line ? line + ' ' + w : w; if (line && g.measureText(t).width > maxW) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; };
    // measure first: the header, the key-value lines, the notes, an image, then the buttons
    let y = frame ? XP.TITLE_H + 12 : 18; const ops = [];
    if (model.type) { const yy = y; ops.push(() => { g.font = `600 20px ${UI}`; g.fillStyle = '#5fd4ff'; g.fillText(model.type.toUpperCase(), 24, yy + 14); }); y += 30; }
    if (model.title) { const lines = wrapText(model.title, `600 40px ${UI}`, PW - 48); for (const l of lines) { const yy = y; ops.push(() => { g.font = `600 40px ${UI}`; g.fillStyle = '#ffffff'; g.fillText(l, 24, yy + 24); }); y += 48; } }
    if (model.sub) for (const l of wrapText(model.sub, `26px ${UI}`, PW - 48)) { const yy = y; ops.push(() => { g.font = `26px ${UI}`; g.fillStyle = '#9aa6c0'; g.fillText(l, 24, yy + 16); }); y += 34; }
    if (model.kv && model.kv.length) { y += 8; for (const [k, v] of model.kv) { const yy = y; ops.push(() => { g.font = `26px ${UI}`; g.fillStyle = '#9aa6c0'; g.textAlign = 'left'; g.fillText(k, 24, yy + 16); g.font = '26px ui-monospace, Menlo, monospace'; g.fillStyle = '#e6ecf8'; g.textAlign = 'right'; g.fillText(v, PW - 24, yy + 16); g.textAlign = 'left'; }); y += 36; } }
    if (model.image && model.image.width) {
      const img = model.image, iw = PW - 48, ih = Math.round(iw * img.height / img.width), yy = y + 8;
      ops.push(() => { g.drawImage(img, 24, yy, iw, ih); g.strokeStyle = 'rgba(255,180,84,0.9)'; g.lineWidth = 3; const cx = 24 + iw / 2, cy = yy + ih / 2; g.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(cx + dx * 18, cy + dy * 18); g.lineTo(cx + dx * 46, cy + dy * 46); } g.stroke(); });
      y += ih + 16;
    }
    if (model.notes) for (const n of model.notes) { y += 6; for (const l of wrapText(n.text ?? n, `24px ${UI}`, PW - 48)) { const yy = y, col = n.color || '#c6cfe0'; ops.push(() => { g.font = `24px ${UI}`; g.fillStyle = col; g.fillText(l, 24, yy + 15); }); y += 31; } }
    const L = X.layoutRows(model.rows || [], PW, { pad: 16, gap: 10, rowH: 76, top: y - 6 });
    const title = frame ? XP.titleRects(ex.buttons || [], PW) : [];
    const H = Math.max(frame ? XP.TITLE_H + 70 : 64, Math.ceil(model.rows && model.rows.length ? L.height : y + 18) + (frame ? 52 : 0));   // frame: room for the resize handle below the buttons
    if (canvas.height !== H) { canvas.height = H; tex.dispose(); }
    const hOld = p.height; p.body = L.rects; p.title = title; p.rects = [...title, ...L.rects]; p.frame = frame; p.height = H;
    g.clearRect(0, 0, PW, H); g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = 'rgba(8,11,18,0.93)'; g.strokeStyle = '#3a4668'; g.lineWidth = 3; g.beginPath(); g.roundRect(2, 2, PW - 4, H - 4, 22); g.fill(); g.stroke();
    const button = (r, hot) => {
      g.globalAlpha = r.disabled ? 0.38 : 1;
      g.fillStyle = r.danger ? (hot ? '#7a2b33' : '#4a1d24') : r.on ? 'rgba(95,212,255,0.26)' : hot ? '#26314d' : '#151c2e'; g.strokeStyle = hot ? '#ffffff' : r.danger ? '#ff8a8a' : r.on ? '#5fd4ff' : '#2f3a58'; g.lineWidth = hot ? 4 : 2;
      g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 14); g.fill(); g.stroke();
      if (hot && progress > 0) { g.fillStyle = 'rgba(95,212,255,0.35)'; g.beginPath(); g.roundRect(r.x, r.y, r.w * Math.min(1, progress), r.h, 14); g.fill(); }
      g.fillStyle = r.on ? '#e9f8ff' : '#dfe6f5';
      const sw = r.color ? 30 : 0;
      if (sw) { g.fillStyle = r.color; g.beginPath(); g.arc(r.x + 22, r.y + r.h / 2, 9, 0, 7); g.fill(); g.fillStyle = r.on ? '#e9f8ff' : '#dfe6f5'; }
      let size = r.frame ? 26 : 28; g.font = `600 ${size}px ${UI}`; while (size > 18 && g.measureText(r.label).width > r.w - sw - (r.sub ? 0.45 * r.w : 16)) { size -= 2; g.font = `600 ${size}px ${UI}`; }
      if (r.sub) { g.textAlign = 'left'; g.fillText(r.label, r.x + 16, r.y + r.h / 2); g.font = `22px ${UI}`; g.fillStyle = '#9fb0d0'; g.textAlign = 'right'; g.fillText(r.sub, r.x + r.w - 16, r.y + r.h / 2); }
      else { g.textAlign = 'center'; g.fillText(r.label, r.x + (r.w + sw) / 2, r.y + r.h / 2); }
      g.globalAlpha = 1; g.textAlign = 'left';
    };
    if (frame) {
      // the title bar: grip dots, the window's name (or the exit countdown), its buttons; the resize handle
      const hotT = ex.hot === 'title';
      g.fillStyle = hotT ? '#2a3760' : '#1a2340'; g.beginPath(); g.roundRect(4, 4, PW - 8, XP.TITLE_H - 4, [20, 20, 6, 6]); g.fill();
      g.fillStyle = hotT ? '#ffffff' : '#7f8db0'; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { g.beginPath(); g.arc(26 + j * 12, XP.TITLE_H / 2 - 10 + i * 10 + 2, 3.2, 0, 7); g.fill(); }
      const tw = (title.length ? title[0].x : PW) - 70;
      if (ex.exit > 0) {
        g.fillStyle = 'rgba(255,110,110,0.35)'; g.beginPath(); g.roundRect(56, 12, tw * ex.exit, XP.TITLE_H - 24, 10); g.fill();
        g.font = `600 24px ${UI}`; g.fillStyle = '#ffd0d0'; g.fillText('Keep holding to exit…', 64, XP.TITLE_H / 2 + 2);
      } else { g.font = `600 24px ${UI}`; g.fillStyle = hotT ? '#ffffff' : '#c3cde4'; let t = ex.title || ''; while (t.length > 4 && g.measureText(t).width > tw) t = t.slice(0, -2); g.fillText(t === (ex.title || '') ? t : t + '…', 64, XP.TITLE_H / 2 + 2); }
      for (const r of title) button(r, r.id === hover);
      const hotR = ex.hot === 'resize', s = XP.HANDLE;
      g.strokeStyle = hotR ? '#ffffff' : '#6c7aa0'; g.lineWidth = hotR ? 5 : 3; g.beginPath();
      for (const k of [0.3, 0.55, 0.8]) { g.moveTo(PW - 10, H - 10 - s * k); g.lineTo(PW - 10 - s * k, H - 10); }
      g.stroke();
    }
    for (const op of ops) op();
    for (const r of L.rects) {
      if (!r.id) { g.font = `600 22px ${UI}`; g.fillStyle = '#8491ad'; g.textAlign = 'left'; g.fillText(String(r.label || '').toUpperCase(), r.x + 4, r.y + r.h / 2); continue; }
      button(r, r.id === hover && !r.disabled);
    }
    tex.needsUpdate = true;
    if (p.geom && H !== hOld) p.setGeom(XP.keepTop(p.geom, p.widthM * H / PW));      // the content grew or shrank: the top edge stays
  };
  /** Put the window at a rectangle { centre, right, up, w, h } in the reference space. */
  p.setGeom = (q) => {
    p.geom = q; p.widthM = q.w; const n = X.cross(q.right, q.up);
    mesh.matrix.copy(new Matrix4().set(q.right[0] * q.w, q.up[0] * q.h, n[0], q.centre[0], q.right[1] * q.w, q.up[1] * q.h, n[1], q.centre[1], q.right[2] * q.w, q.up[2] * q.h, n[2], q.centre[2], 0, 0, 0, 1));
    mesh.matrixWorldNeedsUpdate = true;
  };
  /** Put the window in front of a head (see placePanel), at its original width. */
  p.place = (head, forward, opts) => { p.widthM = p.w0; p.setGeom(X.placePanel(head, forward, { ...opts, w: p.w0, h: p.w0 * p.height / PW })); };
  /** What of this window is under a ray: { zone ('button', 'title', 'resize', 'body'), item, t, point, panel }, or null. */
  p.hit = (ray) => {
    if (!mesh.visible || !p.geom) return null;
    const h = X.rayPanel(ray.origin, ray.dir, p.geom); if (!h) return null;
    const z = XP.hitZone({ W: PW, H: p.height, title: p.title, rects: p.body, frame: p.frame }, h.u * PW, h.v * p.height); if (!z) return null;
    return { zone: z.zone, item: z.item || null, t: h.t, point: h.point, panel: p };
  };
  return p;
}

/**
 * host (the page): everything the immersive mode needs to know or change.
 *   pick(worldDir, tolRad) -> { sel, dir (world), name } | null      select(sel | null)
 *   card() -> the panel model of the selection, or null (with dir: its world direction, radec: [ra, dec] degrees
 *             for fixed objects, for "Turn to face it" and the survey image)
 *   menu(xrState) -> the panel model of the menu (sections start at caption rows; they become tabs)
 *   act(id)                the page's own actions (ids without 'xr:')
 *   time() / setTime(ms)   the clock                                 adjustMag(delta)   the limiting magnitude
 *   togglePlay()           alignTargets() -> [{ name, az, alt }] (radians, above the horizon)
 *   onStart(kind), onEnd(kind), status(text)
 */
export function createXR(R, host = {}) {
  const renderer = R.renderer, group = new Group(), sprites = new Map(), tmp = new Vector3();
  group.visible = false; R.scene.add(group);
  const st = { session: null, kind: '', heading: 0, refType: 'local', grip: 'turn', aligning: false, alignIndex: 0, menuOpen: true, menuTab: null, frames: 0, selects: 0, haptics: 0, lastHit: null, error: '', frameRate: null, features: null, hands: false, nativeSelects: 0, nativeAt: -Infinity, sawTransient: false, exit: 0, palm: 0, survey: null };
  const menu = createPanel('menu', 0.84, 90, 1200), card = createPanel('card', 0.56, 91, 800), survey = createPanel('survey', 0.5, 92, 800), pill = createPanel('pill', 0.39, 93, 560);
  const panels = [menu, card, survey, pill];
  group.add(...panels.map((p) => p.mesh), new HemisphereLight(0xffffff, 0x556070, 2.2));
  const head = { pos: [0, 1.6, 0], fwd: [0, 0, -1] };
  if (host.overlayRoot) host.overlayRoot.addEventListener('beforexrselect', (e) => e.preventDefault());       // a tap on the overlay's buttons is not a tap on the sky
  let pointers = null, gaze = null, libsPromise = null, menuClock = 0, dwellSt = {}, cardKey = '', warned = false;
  const holds = new Map();       // input source -> what it holds: a window it moves or resizes, or the sky
  const libs = () => (libsPromise ||= Promise.all([import('three/examples/jsm/webxr/XRControllerModelFactory.js'), import('three/examples/jsm/webxr/XRHandModelFactory.js')]).catch((e) => { libsPromise = null; console.warn('controller models:', e); return null; }));
  /** A bug in here must not trap anyone in the headset: report it once and carry on (the exits do not depend on it). */
  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { st.error = String((e && e.message) || e); if (!warned) { warned = true; console.warn('immersive mode:', e); } } };

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
      const p = { i, controller, grip, hand, source: null, prev: [], hit: null, pickAt: 0, sky: null, bHold: {}, pinch: {}, palm: {}, ...makeVisuals() };
      // a plain wand along the ray, so that there is something in the hand before (or without) the downloaded model
      const wand = new Mesh(new CylinderGeometry(0.006, 0.012, 0.12, 12), new MeshBasicMaterial({ color: 0x8fa3c8, transparent: true, opacity: 0.9, depthTest: false })); wand.rotation.x = -Math.PI / 2; wand.position.z = -0.03; wand.renderOrder = 97; wand.frustumCulled = false; controller.add(wand); p.wand = wand;
      if (cmf) grip.add(cmf.createControllerModel(grip));
      if (hmf) hand.add(hmf.createHandModel(hand, 'spheres'));
      controller.addEventListener('connected', (e) => { p.source = e.data; p.prev = []; p.bHold = {}; p.pinch = {}; p.palm = {}; wand.visible = e.data.targetRayMode === 'tracked-pointer' && !e.data.hand; if (e.data.hand) st.hands = true; });
      controller.addEventListener('disconnected', () => { if (p.source) holds.delete(p.source); p.source = null; p.hit = null; p.line.visible = p.reticle.visible = false; if (p.name) p.name.visible = false; });
      group.add(controller, grip, hand);
      return p;
    });
    gaze = { i: 'gaze', source: null, hit: null, pickAt: 0, sky: null, ...makeVisuals() };
  }
  const rayOf = (p) => X.rayOfMatrix(p.controller.matrixWorld.elements);
  const pointerOf = (src) => (pointers || []).find((x) => x.source === src);
  /** The ray of an input source now: its controller's pose, else (a transient pointer) its pose in this frame. */
  function sourceRay(src) {
    const p = pointerOf(src); if (p && src.targetRayMode === 'tracked-pointer') return rayOf(p);
    try { const frame = renderer.xr.getFrame(), space = renderer.xr.getReferenceSpace(), pose = frame && space && frame.getPose(src.targetRaySpace, space); if (pose) return X.rayOfMatrix(pose.transform.matrix); } catch { /* not in a frame */ }
    return p ? rayOf(p) : null;
  }
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

  // ---- what a ray meets: a window (one of its zones), or the sky
  const hitPanels = (ray) => panels.map((p) => p.hit(ray)).filter(Boolean).sort((a, b) => a.t - b.t)[0] || null;
  function hitTest(ray, tol) {
    const ph = hitPanels(ray); if (ph) return { kind: 'panel', ...ph };
    const w = X.refToWorld(ray.dir, st.heading), s = host.pick ? host.pick(w, tol) : null;
    return { kind: 'sky', world: w, found: s };
  }
  const CARD_AT = { dist: 0.95, drop: 0.12, yaw: 0.72 };
  function placeMenu() { menu.place(head.pos, head.fwd, { dist: 0.85, drop: 0.5 }); menu.userPlaced = false; }
  function placePanels() { placeMenu(); if (!card.userPlaced) card.place(head.pos, head.fwd, CARD_AT); }
  /** Open the menu (where it was if that is in view, else in front), bring it in front, or fold it: see xrPanel.summon. onlyOpen: never fold (the palm gesture). */
  function summonMenu(onlyOpen = false) {
    const g = st.menuOpen ? menu.geom : menu.saved, what = XP.summon(st.menuOpen, g ? XP.offAxis(g, head) : Math.PI);
    if (what === 'fold') { if (!onlyOpen) foldMenu(); return; }
    st.menuOpen = true; pill.mesh.visible = false; menu.key = '';
    if (what === 'open' && menu.saved && XP.offAxis(menu.saved, head) <= 45 * Math.PI / 180) menu.setGeom(menu.saved); else placeMenu();
  }
  function foldMenu() {
    if (!st.menuOpen) return;
    st.menuOpen = false; menu.saved = menu.geom; menu.mesh.visible = false; pill.key = '';
    placePill(menu.geom);
  }
  /** The folded menu's two buttons sit where the menu's title bar was (or low in front), facing the head. */
  function placePill(g) {
    g ||= X.placePanel(head.pos, head.fwd, { dist: 0.85, drop: 0.5, w: 0.84, h: 0.5 });
    const k = g.h / 2 - 0.05, top = [g.centre[0] + g.up[0] * k, g.centre[1] + g.up[1] * k, g.centre[2] + g.up[2] * k];
    pill.setGeom(XP.facePanel(top, head.pos, pill.w0, pill.w0 * pill.height / pill.pw));
  }
  const xrState = () => ({ kind: st.kind, grip: st.grip, aligning: st.aligning, alignTarget: alignTarget(), menuOpen: st.menuOpen, heading: st.heading, hands: st.hands, gaze: gazeActive() });
  const alignList = () => (host.alignTargets ? host.alignTargets() : []);
  const alignTarget = () => { const l = alignList(); return l.length ? l[st.alignIndex % l.length] : null; };
  const exitLabel = () => (st.kind === 'ar' ? 'Exit passthrough' : 'Exit VR');
  /** The card of the page, with the buttons that exist only here. */
  function cardModel() {
    const c = host.card ? host.card() : null; if (!c) return null;
    const sv = st.survey, showing = sv && sv.key === (c.key || c.title);
    return { ...c, rows: [...(c.rows || []), [{ id: 'xr:face', label: 'Turn to face it', disabled: st.kind === 'ar' || !c.dir }, { id: 'xr:survey', label: showing ? 'Hide survey image' : 'Survey image', on: !!showing, disabled: !c.radec }]] };
  }
  function surveyModel() {
    const sv = st.survey, i = SURVEY_FOV.indexOf(sv.fov);
    const notes = sv.status === 'loading' ? ['Loading the image from CDS hips2fits…'] : sv.status === 'error' ? [{ text: `The image could not be loaded (${sv.error}). It needs a connection to CDS.`, color: '#ffb454' }] : [];
    notes.push({ text: 'DSS2: Digitized Sky Survey, STScI/NASA (colour by CDS), via CDS hips2fits. North up, east left; the cross marks the catalogue position.', color: '#8491ad' });
    return { type: 'Survey image · DSS2 colour', title: sv.name, sub: `${sv.fov}′ across`, image: sv.status === 'ready' ? sv.img : null, imageKey: sv.status + sv.fov, notes, rows: [[{ id: 'xr:svIn', label: 'Closer', disabled: i <= 0 }, { id: 'xr:svOut', label: 'Wider', disabled: i >= SURVEY_FOV.length - 1 }]] };
  }
  async function loadSurvey(sv) {
    try {
      const G = await import('../core/skyfield.js'), N = 512, wcs = G.cellWcs(G.makePlane(sv.radec[0], sv.radec[1], sv.fov * 60 / N), 0, 0, N);
      for (const base of HIPS2FITS) { const img = await loadImage(G.hips2fitsUrl(base, 'CDS/P/DSS2/color', wcs, 'jpg')); if (st.survey !== sv) return; if (img) { Object.assign(sv, { status: 'ready', img }); survey.key = ''; return; } }
      throw new Error('no answer from either CDS server');
    } catch (e) { if (st.survey === sv) { Object.assign(sv, { status: 'error', error: e.message }); survey.key = ''; } }
  }
  function openSurvey(fov) {
    const c = host.card ? host.card() : null; if (!c || !c.radec) return;
    const key = c.key || c.title, sv = { key, name: c.title, radec: c.radec, fov: fov || (st.survey && st.survey.fov) || 12, status: 'loading' };
    const first = !st.survey; st.survey = sv; survey.key = ''; loadSurvey(sv);
    if (first && !survey.userPlaced) survey.place(head.pos, head.fwd, { dist: 0.95, drop: 0.12, yaw: -0.72 });
  }
  /** hover: { panel, item, zone } under a pointer (the first one); hotTitles: the windows whose title bar or handle a ray is on. */
  function drawPanels(hover, progress, hot = new Map()) {
    const hid = (p) => (hover && hover.panel === p && hover.item ? hover.item.id : null), ex = (p, title, buttons) => ({ title, buttons, hot: hot.get(p) || null, exit: st.exit });
    if (st.menuOpen) {
      menu.mesh.visible = true; pill.mesh.visible = false;
      const m = XP.composeTabs(host.menu ? host.menu(xrState()) : { rows: [] }, st.menuTab); st.menuTab = m.tab;
      menu.draw(m, hid(menu), progress, ex(menu, 'Sky controls · grab this bar to move, the corner to resize', [{ id: 'xr:hide', label: 'Fold', w: 110 }, { id: 'xr:exit', label: exitLabel(), w: 240, danger: true }]));
    } else {
      menu.mesh.visible = false; pill.mesh.visible = true;
      pill.draw({ frame: false, rows: [[{ id: 'xr:show', label: 'Menu' }, { id: 'xr:exit', label: st.exit > 0 ? 'Exiting…' : exitLabel(), danger: true }]] }, hid(pill), progress);
      if (!pill.geom) placePill(menu.saved);
    }
    const c = cardModel();
    card.mesh.visible = !!c;
    if (c) {
      const k = c.key || c.title;
      // a new selection: the card comes in front of you, unless you put it somewhere you can see
      if (k !== cardKey) { cardKey = k; if (!card.geom || !card.userPlaced || XP.offAxis(card.geom, head) > 60 * Math.PI / 180) { card.place(head.pos, head.fwd, CARD_AT); card.userPlaced = false; } }
      card.draw(c, hid(card), progress, ex(card, 'Selected', [{ id: 'close', label: 'Close', w: 120 }]));
    } else cardKey = '';
    survey.mesh.visible = !!st.survey;
    if (st.survey) survey.draw(surveyModel(), hid(survey), progress, ex(survey, 'Survey image', [{ id: 'xr:surveyClose', label: 'Close', w: 120 }]));
  }

  // ---- presses and holds
  /** A press (trigger, pinch, gaze-and-pinch, a tap on the screen, a completed dwell). src: the input source (null: the dwell). */
  function press(ray, src, tol = PICK_TOL) {
    st.selects++;
    const h = hitTest(ray, tol);
    if (h.kind === 'panel') {
      if (src && (h.zone === 'title' || h.zone === 'resize') && h.panel.frame) {
        holds.set(src, h.zone === 'title' ? { type: 'move', by: 'select', panel: h.panel, ...XP.moveStart(h.panel.geom, h.point, h.t) } : { type: 'resize', by: 'select', panel: h.panel, ...XP.resizeStart(h.panel.geom, h.point) });
        h.panel.userPlaced = true; pulse(src, 0.3, 20); st.lastHit = { kind: 'panel', zone: h.zone, panel: h.panel.name }; return;
      }
      st.lastHit = { kind: 'panel', id: h.item ? h.item.id : null, zone: h.zone, panel: h.panel.name };
      if (h.item) { pulse(src); action(h.item.id); }
      return;
    }
    if (st.aligning) {
      const t = alignTarget(), hd = t && X.alignHeading(ray.dir, t.az);
      if (hd == null) { host.status && host.status('Point lower: too close to the zenith to set the compass.'); return; }
      api.setHeading(hd); st.aligning = false; pulse(src, 0.9, 60); st.lastHit = { kind: 'align', name: t.name, heading: hd };
      host.status && host.status(`Compass set on ${t.name}.`); return;
    }
    st.lastHit = { kind: 'sky', name: h.found ? h.found.name : null };
    if (h.found) pulse(src);
    host.select && host.select(h.found ? h.found.sel : null);
    // a hand or a gaze-and-pinch has no grip: holding the pinch and dragging turns the sky
    if (src && (src.hand || src.targetRayMode === 'transient-pointer')) holds.set(src, { type: 'pending', by: 'select', dir0: ray.dir });
  }
  function grabSky(src, dir, by) { holds.set(src, { type: 'sky', by, mode: st.grip, grab: X.grabStart(dir, st.grip === 'turn' ? st.heading : host.time()) }); }
  function release(src, by) { const h = holds.get(src); if (h && h.by === by) holds.delete(src); }
  function stepHolds(dt) {
    for (const [src, h] of holds) {
      const ray = sourceRay(src); if (!ray) continue;
      if (h.type === 'pending') { if (X.angle(h.dir0, ray.dir) < XP.DRAG_START) continue; grabSky(src, h.dir0, h.by); Object.assign(h, holds.get(src)); holds.set(src, h); }
      if (h.type === 'sky') { const turned = X.grabMove(h.grab, ray.dir); if (h.mode === 'turn') api.setHeading(X.grabHeading(h.grab.value, turned)); else host.setTime(X.grabTime(h.grab.value, turned)); }
      else if (h.type === 'move') { const gp = src.gamepad; if (gp) h.t = XP.pushPull(h.t, X.deadzone(X.stickOf(gp.axes)[1]), dt / 1000); h.panel.setGeom(XP.moveWindow(h, ray, head.pos, h.panel.geom.w, h.panel.geom.h)); if (h.panel === menu) menu.saved = null; }
      else if (h.type === 'resize') { const g = XP.resizeWindow(h, ray); if (g) h.panel.setGeom(g); }
    }
  }
  function action(id) {
    if (id === 'xr:exit') api.stop();
    else if (id === 'xr:hide') foldMenu();
    else if (id === 'xr:show') summonMenu(true);
    else if (id.startsWith('xr:tab:')) st.menuTab = id.slice(7);
    else if (id === 'xr:grip') st.grip = st.grip === 'turn' ? 'time' : 'turn';
    else if (id === 'xr:alignNext') { const n = alignList().length; st.alignIndex = n ? (st.alignIndex + 1) % n : 0; }
    else if (id === 'xr:align') st.aligning = !st.aligning && !!alignTarget();
    else if (id === 'xr:turnL' || id === 'xr:turnR') api.setHeading(X.wrapPi(st.heading + (id === 'xr:turnL' ? -1 : 1) * 5 * Math.PI / 180));
    else if (id === 'xr:face') {
      const c = host.card && host.card(), hd = c && c.dir && st.kind !== 'ar' ? X.alignHeading(head.fwd, X.altAzOfDir(c.dir).az) : null;
      if (hd != null) api.setHeading(hd); else if (c && c.dir && st.kind !== 'ar') host.status && host.status('Look nearer the horizon to turn the sky.');
    }
    else if (id === 'xr:survey') { const c = host.card && host.card(); if (st.survey && c && st.survey.key === (c.key || c.title)) st.survey = null; else openSurvey(); }
    else if (id === 'xr:surveyClose') st.survey = null;
    else if (id === 'xr:svIn' || id === 'xr:svOut') { const sv = st.survey; if (sv) { const i = SURVEY_FOV.indexOf(sv.fov) + (id === 'xr:svIn' ? -1 : 1); if (i >= 0 && i < SURVEY_FOV.length) { const nsv = { ...sv, fov: SURVEY_FOV[i], status: 'loading', img: null }; st.survey = nsv; loadSurvey(nsv); } } }
    else if (host.act) host.act(id);
    menu.key = card.key = survey.key = pill.key = '';
  }
  const gazeActive = () => !!st.session && !st.sawTransient && !(pointers || []).some((p) => p.source && p.source.targetRayMode === 'tracked-pointer');

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
  /** A joint of a tracked hand in the reference space, or null. */
  const joint = (p, n) => { const j = p.hand && p.hand.joints && p.hand.joints[n]; return j && j.visible !== false ? [j.position.x, j.position.y, j.position.z] : null; };

  // ---- the session's own events: the press itself, with the pose of that instant (a tap on a phone lives for one event only)
  function eventRay(e) {
    try { const space = renderer.xr.getReferenceSpace(), pose = space && e.frame && e.frame.getPose(e.inputSource.targetRaySpace, space); if (pose) return X.rayOfMatrix(pose.transform.matrix); } catch { /* fall back to the last frame's pose */ }
    const p = pointerOf(e.inputSource); return p ? rayOf(p) : { origin: head.pos, dir: head.fwd };
  }
  const onSelectStart = safe((e) => {
    const src = e.inputSource, p = pointerOf(src);
    st.nativeSelects++; st.nativeAt = performance.now();
    if (src.targetRayMode === 'transient-pointer') st.sawTransient = true;
    if (p && p.pinch && p.pinch.synthetic) return;       // the joint pinch of this hand already pressed
    press(eventRay(e), src, src.targetRayMode === 'tracked-pointer' ? PICK_TOL : GAZE_TOL);
  });
  const onSelectEnd = safe((e) => release(e.inputSource, 'select'));
  const onSqueezeStart = safe((e) => {
    const src = e.inputSource, ray = eventRay(e), ph = hitPanels(ray);
    if (ph) { holds.set(src, { type: 'move', by: 'squeeze', panel: ph.panel, ...XP.moveStart(ph.panel.geom, ph.point, ph.t) }); ph.panel.userPlaced = true; }
    else grabSky(src, ray.dir, 'squeeze');
    pulse(src, 0.3, 20);
  });
  const onSqueezeEnd = safe((e) => release(e.inputSource, 'squeeze'));
  const onSources = safe((e) => { for (const s of e.removed || []) holds.delete(s); });

  function frameUpdate(dt, now) {
    st.frames++;
    const cam = renderer.xr.getCamera(), e = cam.matrixWorld.elements;
    head.pos = [e[12], e[13], e[14]]; head.fwd = X.norm([-e[8], -e[9], -e[10]]);
    // the scale of everything sized in pixels (stars, the Sun's and the Moon's discs): pixels per radian of one eye
    const eye = cam.cameras && cam.cameras[0];
    if (eye && eye.viewport && eye.viewport.z > 0) R.setPixelFocal(eye.projectionMatrix.elements[0] * eye.viewport.z / 2 / 1.6);
    if (st.frames === 2 || !menu.geom) placePanels();
    if (st.frames % 30 === 1) fixOrder();
    if (st.session.visibilityState && st.session.visibilityState !== 'visible') return;      // the system menu is open
    stepHolds(dt);
    let hover = null, progress = 0, rate = 0, dMag = 0, exit = 0; const hot = new Map();
    for (const p of pointers) {
      const s = p.source;
      if (!s || s.targetRayMode !== 'tracked-pointer') { hide(p); continue; }
      const ray = rayOf(p), held = holds.get(s);
      // windows every frame; the sky (a scan of the catalogue) fifteen times a second
      let h = null; const ph = hitPanels(ray);
      if (held && (held.type === 'move' || held.type === 'resize')) { h = ph && ph.panel === held.panel ? { kind: 'panel', ...ph } : { kind: 'sky', found: null }; hot.set(held.panel, held.type === 'move' ? 'title' : 'resize'); }
      else if (ph) h = { kind: 'panel', ...ph };
      else if (held && held.type === 'sky') h = { kind: 'sky', found: null };
      else { if (now - p.pickAt > 66) { p.pickAt = now; p.sky = hitTest(ray, PICK_TOL); } h = p.sky && p.sky.kind === 'sky' ? p.sky : { kind: 'sky', found: null }; }
      if (h.kind === 'panel' && (h.zone === 'title' || h.zone === 'resize') && !hot.has(h.panel)) hot.set(h.panel, h.zone);
      const hid = h.kind === 'panel' ? (h.item ? h.item.id : h.zone) : h.found ? 'sky:' + h.found.name : null, was = p.hit;
      if (hid && hid !== was && h.kind === 'panel' && (h.item || h.zone === 'title' || h.zone === 'resize')) pulse(s, 0.15, 10);
      p.hit = hid; if (h.kind === 'panel' && h.item && !hover) hover = h;
      show(p, ray, h, true);
      // a hand: the pinch from its joints where the browser sends no select, the palm turned up to bring the menu
      if (s.hand) {
        const tt = joint(p, 'thumb-tip'), it = joint(p, 'index-finger-tip');
        if (st.nativeSelects === 0 || p.pinch.closed) {       // until the browser shows it sends selects (then only to finish a pinch begun here)
          p.pinch = XP.pinchFallback(p.pinch, tt && it ? Math.hypot(tt[0] - it[0], tt[1] - it[1], tt[2] - it[2]) : null, now, st.nativeAt);
          if (p.pinch.start) press(ray, s, PICK_TOL); if (p.pinch.end) release(s, 'select');
        }
        const w = joint(p, 'wrist'), im = joint(p, 'index-finger-metacarpal'), pm = joint(p, 'pinky-finger-metacarpal');
        if (w && im && pm && !held) {
          const n = XP.palmNormal(w, im, pm, s.handedness), look = X.dot(head.fwd, X.norm([w[0] - head.pos[0], w[1] - head.pos[1], w[2] - head.pos[2]]));
          p.palm = XP.palmUp(p.palm, n[1], look, dt); st.palm = Math.max(st.palm, p.palm.progress);
          if (p.palm.fire) summonMenu(true);
        } else p.palm = {};
      }
      const gp = s.gamepad;
      if (gp) {
        const [sx, sy] = X.stickOf(gp.axes); const r = X.stickTimeRate(sx), m = held && held.type === 'move' ? 0 : X.stickStep(sy, dt / 1000);
        if (Math.abs(r) > Math.abs(rate)) rate = r; if (Math.abs(m) > Math.abs(dMag)) dMag = m;
        for (const b of X.pressedEdges(p.prev, gp.buttons)) {
          if (b === X.BUTTON.a) { summonMenu(); pulse(s, 0.4, 20); }
          else if (b === X.BUTTON.stick) host.togglePlay && host.togglePlay();
        }
        // B / Y: a tap switches what the grip does, a hold of a second leaves the immersive mode
        const bb = gp.buttons && gp.buttons[X.BUTTON.b];
        p.bHold = XP.holdButton(p.bHold, !!(bb && bb.pressed), dt);
        if (p.bHold.tap) { action('xr:grip'); pulse(s, 0.4, 20); }
        if (p.bHold.progress > 0) { exit = Math.max(exit, p.bHold.progress); if (st.frames % 8 === 0) pulse(s, 0.1 + 0.5 * p.bHold.progress, 12); }
        if (p.bHold.long) { pulse(s, 1, 80); api.stop(); return; }
      }
    }
    if (exit !== st.exit) { st.exit = exit; menu.key = pill.key = ''; }
    st.rate = rate;
    if (rate) host.setTime(host.time() + rate * dt);
    if (dMag && host.adjustMag) host.adjustMag(dMag);
    // without a tracked controller or hand (and before any gaze-and-pinch): the gaze points, a dwell presses (a Cardboard's button also presses, as a 'gaze' select)
    if (gazeActive()) {
      const ray = { origin: head.pos, dir: head.fwd }; let h; const ph = hitPanels(ray);
      if (ph) h = { kind: 'panel', ...ph }; else { if (now - gaze.pickAt > 100) { gaze.pickAt = now; gaze.sky = hitTest(ray, GAZE_TOL); } h = gaze.sky && gaze.sky.kind === 'sky' ? gaze.sky : { kind: 'sky', found: null }; }
      const id = h.kind === 'panel' ? (h.item ? 'p:' + h.item.id : null) : h.found && !st.aligning ? 'sky:' + h.found.name : null;
      dwellSt = X.dwell(dwellSt, id, dt, DWELL_MS); progress = dwellSt.progress;
      if (h.kind === 'panel' && h.item) hover = h;
      show(gaze, ray, h, false);
      const sz = gaze.reticle.scale.x * (1 + 0.8 * (id ? 1 - progress : 0)); gaze.reticle.scale.set(sz, sz, 1);
      if (dwellSt.fire) press(ray, null, GAZE_TOL);
    } else if (gaze) { hide(gaze); dwellSt = {}; }
    if (hover || hot.size || holds.size || now - menuClock > 200 || !menu.key) { menuClock = now; drawPanels(hover, progress, hot); }
    // windows ignore depth (the sky is transparent): draw the farther ones first, so a window moved in front covers the others
    const far = (p) => (p.geom ? -Math.hypot(p.geom.centre[0] - head.pos[0], p.geom.centre[1] - head.pos[1], p.geom.centre[2] - head.pos[2]) : 0);
    [...panels].sort((a, b) => far(a) - far(b)).forEach((p, i) => { p.mesh.renderOrder = 90 + i; });
  }

  const api = {
    state: st, group, menu, card, survey, pill, holds,
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
        Object.assign(st, { session, kind, heading, aligning: false, menuOpen: true, frames: 0, selects: 0, lastHit: null, hands: false, error: '', nativeSelects: 0, nativeAt: -Infinity, sawTransient: false, exit: 0, palm: 0, survey: null });
        st.features = session.enabledFeatures ? Array.from(session.enabledFeatures) : null;
        renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType(st.refType);
        // a light scene of points and lines: mild foveation keeps small stars and text sharp away from the centre
        renderer.xr.setFoveation(0.5);
        R.setMode('perspective'); R.setHeading(heading); R.setPointScale(1.6);
        R.camera.matrix.identity(); R.camera.updateMatrixWorld(true);
        if (kind === 'ar') renderer.setClearColor(0x000000, 0);
        group.visible = true; holds.clear(); cardKey = '';
        for (const p of panels) { p.key = ''; p.geom = null; p.saved = null; p.userPlaced = false; p.widthM = p.w0; p.mesh.visible = false; }
        session.addEventListener('end', () => {
          st.session = null; renderer.xr.enabled = false; group.visible = false; renderer.setClearColor(0x010207, 1);
          holds.clear(); st.survey = null; st.exit = 0;
          for (const p of panels) p.mesh.visible = false;
          for (const p of [...(pointers || []), gaze]) if (p) hide(p);
          host.onEnd && host.onEnd(kind);
        });
        session.addEventListener('selectstart', onSelectStart);
        session.addEventListener('selectend', onSelectEnd);
        session.addEventListener('squeezestart', onSqueezeStart);
        session.addEventListener('squeezeend', onSqueezeEnd);
        session.addEventListener('inputsourceschange', onSources);
        await renderer.xr.setSession(session);
        // 72 Hz where the display offers a choice (Quest: 72 to 120): steady, and kind to the battery
        const rate = X.chooseFrameRate(session.supportedFrameRates);
        if (rate && session.updateTargetFrameRate) session.updateTargetFrameRate(rate).then(() => { st.frameRate = rate; }, () => {});
        host.onStart && host.onStart(kind);
      } catch (e) { st.session = null; renderer.xr.enabled = false; group.visible = false; try { await session.end(); } catch { /* already over */ } throw e; }
    },
    stop() { if (st.session) st.session.end().catch(() => {}); },
    setHeading(h) { st.heading = h; R.setHeading(h); },
    /** Once per frame while a session runs, before the scene is drawn: poses, buttons, windows. dt in milliseconds. */
    update: (dt, now = performance.now()) => { if (st.session) safe(frameUpdate)(dt, now); },
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
