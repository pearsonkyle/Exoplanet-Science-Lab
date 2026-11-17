// The floating windows of the immersive mode and the gestures that drive them, with no WebXR, three.js or DOM in
// it, so that it runs in Node (test/xrpanel.test.mjs). xr.js draws the windows and feeds this file poses.
//
// A window is a canvas W x H pixels shown on a rectangle in the reference space ({ centre, right, up, w, h }, see
// xrInput.js). It has a title bar TITLE_H pixels high (grab it to move the window; its buttons sit at the right),
// a resize handle in the bottom-right corner, and a body of buttons laid out by xrInput.layoutRows.
//
// Gestures (each a small state machine, stepped once per frame with the time since the last frame):
//   holdButton     tap (released before `long` ms) or long press (B / Y held: exit)
//   pinchFallback  a pinch read from the hand's joints, for browsers that track hands but send no select event
//   palmUp         palm turned up and looked at for half a second: bring the menu
import { norm, cross, dot, angle } from './xrInput.js';

export const TITLE_H = 64;      // pixels of the title bar
export const HANDLE = 64;       // pixels of the square resize handle in the bottom-right corner
export const MIN_W = 0.3, MAX_W = 2.4;     // metres: the narrowest and widest a window can be made
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// ---------------------------------------------------------------- layout and hit testing in canvas pixels
/** The title bar's buttons, right-aligned: items [{ id, label, w (pixels, default 120) }] -> rects. */
export function titleRects(items, W, { h = TITLE_H, pad = 8, gap = 8 } = {}) {
  const out = []; let x = W - pad;
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i], w = it.w || 120; x -= w; out.unshift({ ...it, x, y: pad, w, h: h - 2 * pad, frame: true }); x -= gap; }
  return out;
}
/**
 * What is under the canvas point (x, y) of a window W x H: { zone: 'button', item } (a title-bar or a body button),
 * { zone: 'resize' }, { zone: 'title' }, { zone: 'body' }, or null (off the window). frame: false for a window
 * without a title bar or handle (the folded menu). Disabled buttons and captions are body.
 */
export function hitZone(win, x, y) {
  const { W, H, title = [], rects = [], frame = true } = win;
  if (!(x >= 0 && x <= W && y >= 0 && y <= H)) return null;
  const inR = (r) => r.id && !r.disabled && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  if (frame) {
    const t = title.find(inR); if (t) return { zone: 'button', item: t };
    if (x >= W - HANDLE && y >= H - HANDLE) return { zone: 'resize' };
    if (y < TITLE_H) return { zone: 'title' };
  }
  const b = rects.find(inR);
  return b ? { zone: 'button', item: b } : { zone: 'body' };
}

// ---------------------------------------------------------------- windows in the room
/** A window centred at `centre`, upright (its right edge level) and facing the head. */
export function facePanel(centre, headPos, w, h) {
  let f = [centre[0] - headPos[0], 0, centre[2] - headPos[2]]; if (Math.hypot(f[0], f[2]) < 1e-3) f = [0, 0, -1]; f = norm(f);
  const out = norm(sub(centre, headPos)), right = norm(cross(f, [0, 1, 0])), up = norm(cross(right, out));
  return { centre: [...centre], right, up, w, h };
}
/** Where a ray meets the plane of a window, ignoring its edges: { point, t, x, y (metres from the centre along right and up) } or null. */
export function planeHit(origin, dir, g) {
  const n = cross(g.right, g.up), den = dot(dir, n); if (Math.abs(den) < 1e-9) return null;
  const t = dot(sub(g.centre, origin), n) / den; if (t <= 0) return null;
  const point = add(origin, dir, t), q = sub(point, g.centre);
  return { point, t, x: dot(q, g.right), y: dot(q, g.up) };
}
/** Start moving a window: the ray met it `t` metres out, at (du, dv) metres from its centre. */
export function moveStart(g, hitPoint, t) { const q = sub(hitPoint, g.centre); return { t, du: dot(q, g.right), dv: dot(q, g.up) }; }
/**
 * Follow a move: the point that was grabbed stays on the ray, `m.t` metres out (the thumbstick may change it), and
 * the window turns to face the head. Returns the new window.
 */
export function moveWindow(m, ray, headPos, w, h) {
  const p = add(ray.origin, ray.dir, m.t);
  // the centre whose facing orientation puts the grabbed point on p: a fixed point, found in a few steps
  let g = facePanel(p, headPos, w, h);
  for (let k = 0; k < 30; k++) { const c = add(add(p, g.right, -m.du), g.up, -m.dv), moved = Math.hypot(...sub(c, g.centre)); g = facePanel(c, headPos, w, h); if (moved < 1e-13) break; }
  return g;
}
/** The distance of a moved window along the ray, pushed or pulled by the thumbstick (y < 0: away). */
export const pushPull = (t, stickY, dtSec, { rate = 1.2, min = 0.3, max = 4 } = {}) => clamp(t - stickY * rate * dtSec, min, max);
/** Start a resize: remember the corner (the window's bottom right) and where on the handle the ray took it. */
export function resizeStart(g, hitPoint) {
  const br = add(add(g.centre, g.right, g.w / 2), g.up, -g.h / 2);
  return { g0: { ...g }, grip: sub(hitPoint, br), aspect: g.h / g.w };
}
/**
 * Follow a resize: the top-left corner stays, the bottom-right follows the ray on the window's plane, the aspect
 * ratio is kept (the canvas decides it) and the width stays within MIN_W..MAX_W. Returns the new window, or null
 * when the ray is off the plane.
 */
export function resizeWindow(r, ray, { min = MIN_W, max = MAX_W } = {}) {
  const g0 = r.g0, hit = planeHit(ray.origin, ray.dir, g0); if (!hit) return null;
  const tl = add(add(g0.centre, g0.right, -g0.w / 2), g0.up, g0.h / 2), q = sub(sub(hit.point, r.grip), tl);
  const w = clamp(Math.max(dot(q, g0.right), -dot(q, g0.up) / r.aspect), min, max), h = w * r.aspect;
  return { centre: add(add(tl, g0.right, w / 2), g0.up, -h / 2), right: [...g0.right], up: [...g0.up], w, h };
}
/** The same window with a new height (the content grew or shrank): its top edge stays where it is. */
export function keepTop(g, hNew) { return { ...g, centre: add(g.centre, g.up, (g.h - hNew) / 2), h: hNew }; }
/** The angle (radians) between where the head looks and the window's centre. */
export const offAxis = (g, head) => angle(head.fwd, norm(sub(g.centre, head.pos)));
/**
 * The A / X button, the folded menu's "Menu" button and the palm gesture: 'open' (folded: open it where it was if
 * that is in view, else in front), 'place' (open but out of view: bring it in front), 'fold' (open and in view).
 */
export function summon(open, offAxisRad, inView = 45 * Math.PI / 180) { return !open ? 'open' : offAxisRad > inView ? 'place' : 'fold'; }

// ---------------------------------------------------------------- tabs: the long menu in pages
/** A caption row (one item without an id, with its own height): the start of a section. */
export const isCaption = (row) => Array.isArray(row) && row.length === 1 && !row[0].id && !!row.h;
/** The name of a section's tab: row.tab, else the caption up to its first bracket, colon or comma. */
export const tabName = (row) => row.tab || String(row[0].label || '').split(/[(:,]/)[0].trim() || 'More';
/** Rows -> { head: the rows before the first caption (always shown), tabs: [{ name, rows (from the caption on) }] }. */
export function splitTabs(rows) {
  const head = [], tabs = [];
  for (const r of rows || []) { if (isCaption(r)) tabs.push({ name: tabName(r), rows: [r] }); else if (tabs.length) tabs[tabs.length - 1].rows.push(r); else head.push(r); }
  return { head, tabs };
}
/** A menu model shown one tab at a time: the head rows, a row of tabs, the active section. active: a tab's name. */
export function composeTabs(model, active) {
  const { head, tabs } = splitTabs(model.rows);
  if (tabs.length < 2) return { ...model, tab: tabs.length ? tabs[0].name : null };
  const i = Math.max(0, tabs.findIndex((t) => t.name === active)), bar = tabs.map((t, k) => ({ id: 'xr:tab:' + t.name, label: t.name, on: k === i }));
  return { ...model, rows: [...head, bar, ...tabs[i].rows], tab: tabs[i].name, tabs: tabs.map((t) => t.name) };
}

// ---------------------------------------------------------------- gestures
/**
 * A button held or tapped. st: {} at first; pressed: the button now. Returns the new state with tap (released before
 * the long press fired), long (held `long` ms: fires once per hold) and progress 0..1 (0 for the first `grace` ms,
 * so that a tap does not flash a bar).
 */
export function holdButton(st, pressed, dtMs, { long = 1000, grace = 250 } = {}) {
  if (!pressed) return { down: false, ms: 0, fired: false, tap: !!st.down && !st.fired, long: false, progress: 0 };
  const ms = st.down ? (st.ms || 0) + dtMs : 0, fire = !st.fired && ms >= long;
  return { down: true, ms, fired: !!st.fired || fire, tap: false, long: fire, progress: ms < grace ? 0 : Math.min(1, ms / long) };
}
/** Pinch with hysteresis: closes when thumb and index tips are within `on` metres, opens beyond `off`. */
export const pinched = (was, dist, on = 0.015, off = 0.03) => (was ? dist < off : dist < on);
/**
 * A pinch from the hand's joints, used only where the browser sends no select event for it. st: {} at first;
 * dist: thumb tip to index tip (metres, null when the joints are not tracked); now: ms; nativeAt: the time of the
 * last select event of any input source (-Infinity when none). A pinch that closes waits `wait` ms: if a select
 * event came within `window` ms of its closing, the browser has it and nothing fires; otherwise `start` fires, and
 * `end` when it opens.
 */
export function pinchFallback(st, dist, now, nativeAt = -Infinity, { wait = 250, window = 400 } = {}) {
  const closed = dist != null && pinched(!!st.closed, dist);
  const out = { closed, closedAt: st.closedAt, pending: !!st.pending, synthetic: !!st.synthetic, start: false, end: false };
  if (closed && !st.closed) { out.closedAt = now; out.pending = true; }
  if (!closed && st.closed) { out.end = !!st.synthetic; out.pending = false; out.synthetic = false; }
  if (closed && out.pending) {
    if (Math.abs(nativeAt - out.closedAt) <= window) out.pending = false;
    else if (now - out.closedAt >= wait) { out.pending = false; out.synthetic = true; out.start = true; }
  }
  return out;
}
/** The normal of the palm (out of the palm's face) from the wrist and the index and little finger metacarpals. */
export function palmNormal(wrist, indexMcp, pinkyMcp, handedness) {
  const n = norm(cross(sub(indexMcp, wrist), sub(pinkyMcp, wrist)));
  return handedness === 'left' ? [-n[0], -n[1], -n[2]] : n;
}
/**
 * Palm up, looked at, for `need` ms: fires once; the palm has to turn down (upDot < off) to arm it again.
 * upDot: the palm normal's y; lookDot: cosine of the angle between the gaze and the direction to the wrist.
 */
export function palmUp(st, upDot, lookDot, dtMs, { need = 500, on = 0.75, off = 0.35, look = 0.7 } = {}) {
  const armed = st.armed === undefined ? true : st.armed;
  if (upDot == null || upDot < off) return { ms: 0, armed: true, fire: false, progress: 0 };
  if (!armed || upDot < on || lookDot < look) return { ms: 0, armed, fire: false, progress: 0 };
  const ms = (st.ms || 0) + dtMs, fire = ms >= need;
  return { ms: fire ? 0 : ms, armed: !fire, fire, progress: fire ? 1 : ms / need };
}
/** A pinch (or a press of a hand or a transient pointer) on the sky becomes a drag once the ray has turned this far. */
export const DRAG_START = 3 * Math.PI / 180;
