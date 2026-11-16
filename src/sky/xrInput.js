// The arithmetic of the immersive (WebXR) mode, with no WebXR, three.js or DOM in it, so that it runs in Node
// (test/xr.test.mjs) and the same functions serve the headset, the emulator and the flat page.
//
// Frames
//   world      the sky frame of renderer.js: x east, y up (zenith), z south. A direction with altitude h and azimuth A
//              (from north through east) is (cos h sin A, sin h, -cos h cos A).
//   reference  the WebXR reference space ('local-floor' or 'local'): x right, y up, -z where the viewer faced when
//              the session began. It has no compass: `heading` is the azimuth that its -z axis points to, and the
//              only thing that ties the two frames together. ref = Ry(heading) world, the uView of the shaders.
//   panel      a rectangle in the reference space: { centre, right, up (unit vectors), w, h (metres) }; a point on it
//              has u in 0..1 from its left edge and v in 0..1 from its top edge (the way a canvas is addressed).
const TAU = 2 * Math.PI;
export const wrapPi = (x) => { const y = ((x + Math.PI) % TAU + TAU) % TAU - Math.PI; return y; };
export const wrap2pi = (x) => ((x % TAU) + TAU) % TAU;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Angle between two unit vectors, accurate for small angles too. */
export const angle = (a, b) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

export const dirOfAltAz = (alt, az) => [Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)];
export const altAzOfDir = (w) => ({ alt: Math.asin(clamp(w[1], -1, 1)), az: wrap2pi(Math.atan2(w[0], -w[2])) });

/** Reference-space direction -> world direction, for a heading in radians. */
export function refToWorld(d, heading) { const c = Math.cos(heading), s = Math.sin(heading); return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]]; }
/** World direction -> reference-space direction (what the shaders' uView does). */
export function worldToRef(w, heading) { const c = Math.cos(heading), s = Math.sin(heading); return [c * w[0] + s * w[2], w[1], -s * w[0] + c * w[2]]; }
/** The "azimuth" of a reference-space direction, measured from -z through +x. */
export const refAzimuth = (d) => Math.atan2(d[0], -d[2]);

/** Origin and direction of the pointing ray of a pose given as a column-major 4x4 (a three.js matrixWorld): -z of the pose. */
export function rayOfMatrix(e) { return { origin: [e[12], e[13], e[14]], dir: norm([-e[8], -e[9], -e[10]]) }; }

// ---------------------------------------------------------------- picking on the sky
/**
 * The nearest of a list of candidates to a direction. cands: [{ dir, bias (radians taken off the distance: the
 * radius of a disc, or a preference), ... }]. Returns { ...candidate, d } for the smallest d = angle - bias below
 * tol, or null.
 */
export function pickCandidates(w, cands, tol) {
  let best = null;
  for (const c of cands) { if (!c || !c.dir) continue; const d = angle(w, c.dir) - (c.bias || 0); if (d < tol && (!best || d < best.d)) best = { ...c, d }; }
  return best;
}
/**
 * The best entry of a catalogue of unit vectors (pos: flat array, 3 per entry) within tol of v. ok(i) filters;
 * weight(i) is added to the distance in units of the tolerance, so that a bright star wins over a faint one that
 * is slightly nearer. Returns { i, s (the score, below 1 + weight), sep (radians) } or null.
 */
export function scanCatalog(v, pos, n, tol, ok = () => true, weight = () => 0) {
  const cosTol = Math.cos(tol); let bi = -1, bs = Infinity, bc = 1;
  for (let i = 0; i < n; i++) {
    const c = pos[i * 3] * v[0] + pos[i * 3 + 1] * v[1] + pos[i * 3 + 2] * v[2];
    if (c < cosTol || !ok(i)) continue;
    const s = Math.acos(Math.min(1, c)) / tol + weight(i);
    if (s < bs) { bs = s; bi = i; bc = c; }
  }
  return bi < 0 ? null : { i: bi, s: bs, sep: Math.acos(Math.min(1, bc)) };
}

// ---------------------------------------------------------------- heading: alignment and grabbing the sky
/**
 * One-step compass alignment. The ray (a reference-space direction) points at the real object whose azimuth is
 * trueAz: the heading that puts the drawn object under the ray. Altitude is not used (the horizon comes from the
 * reference space, which is level). Returns null when the ray is within 5 degrees of the vertical, where the
 * azimuth is not defined well enough.
 */
export function alignHeading(rayRef, trueAz) {
  if (Math.hypot(rayRef[0], rayRef[2]) < Math.sin(5 * Math.PI / 180)) return null;
  return wrapPi(trueAz - refAzimuth(rayRef));
}
/** Start of a grab: remember where the ray was. */
export function grabStart(rayRef, value) { return { az: refAzimuth(rayRef), turned: 0, value }; }
/** Follow a grab: the angle the ray has turned about the vertical since it began, without wrapping (several turns add up). */
export function grabMove(g, rayRef) {
  if (Math.hypot(rayRef[0], rayRef[2]) < 0.05) return g.turned;      // through the zenith: keep the last value
  const az = refAzimuth(rayRef); g.turned += wrapPi(az - g.az); g.az = az; return g.turned;
}
/** Grab and turn the sky: the point of the sky that was under the ray stays under it. heading0: the heading at the start. */
export const grabHeading = (heading0, turned) => wrapPi(heading0 - turned);
/** Radians of hand movement per hour of time when the grip scrubs the clock: the sky's own rate, 15 degrees an hour. */
export const SCRUB_RAD_PER_HOUR = 15 * Math.PI / 180;
/** Grab and scrub: sweeping the hand toward larger azimuth (the way the southern sky moves, east to west) runs time forward. */
export const grabTime = (t0, turned, radPerHour = SCRUB_RAD_PER_HOUR) => t0 + turned / radPerHour * 3600000;

// ---------------------------------------------------------------- thumbstick
/** Deflection beyond a dead zone, rescaled to -1..1. */
export function deadzone(x, dead = 0.15) { const a = Math.abs(x); return a <= dead ? 0 : Math.sign(x) * Math.min(1, (a - dead) / (1 - dead)); }
/**
 * Thumbstick left/right -> the rate of the clock in seconds of sky time per second: cubic in the deflection, so
 * that a light push steps through minutes and the stop runs the night in a few seconds (2 hours per second).
 */
export function stickTimeRate(x, { dead = 0.15, max = 7200 } = {}) { const f = deadzone(x, dead); return f * f * f * max; }
/** Thumbstick up/down (the Gamepad y axis is negative when pushed away) -> a change over dt seconds: `perSecond` at the stop. */
export function stickStep(y, dtSec, { dead = 0.15, perSecond = 1.5 } = {}) { return -deadzone(y, dead) * perSecond * dtSec; }
/** The thumbstick of an xr-standard gamepad (axes 2 and 3; a touchpad-only device has just 0 and 1). */
export function stickOf(axes) { if (!axes || axes.length < 2) return [0, 0]; return axes.length >= 4 ? [axes[2] || 0, axes[3] || 0] : [axes[0] || 0, axes[1] || 0]; }
/** Which buttons went down since the last frame. prev: array of booleans (updated in place). Returns the indices. */
export function pressedEdges(prev, buttons) {
  const out = [];
  for (let i = 0; i < (buttons ? buttons.length : 0); i++) { const p = !!(buttons[i] && (buttons[i].pressed ?? buttons[i] > 0.5)); if (p && !prev[i]) out.push(i); prev[i] = p; }
  return out;
}
/** xr-standard button indices. */
export const BUTTON = { trigger: 0, squeeze: 1, touchpad: 2, stick: 3, a: 4, b: 5 };

// ---------------------------------------------------------------- panels in the world
/**
 * A panel in front of a head: `dist` metres along the horizontal direction the head faces (turned by `yaw` radians
 * to the right), `drop` radians below eye level, facing the head. Returns { centre, right, up, w, h }.
 */
export function placePanel(headPos, headForward, { dist = 0.9, drop = 0.45, yaw = 0, w = 0.7, h = 0.5 } = {}) {
  let f = [headForward[0], 0, headForward[2]]; if (Math.hypot(f[0], f[2]) < 0.05) f = [0, 0, -1]; f = norm(f);
  const c = Math.cos(yaw), s = Math.sin(yaw); f = [c * f[0] - s * f[2], 0, s * f[0] + c * f[2]];       // to the right for yaw > 0
  const out = [f[0] * Math.cos(drop), -Math.sin(drop), f[2] * Math.cos(drop)];
  const centre = [headPos[0] + out[0] * dist, headPos[1] + out[1] * dist, headPos[2] + out[2] * dist];
  const right = norm(cross(f, [0, 1, 0])), up = norm(cross(right, out));
  return { centre, right, up, w, h };
}
/** Where a ray meets a panel: { u, v, t (metres along the ray), point } or null (parallel, behind, or off the panel). */
export function rayPanel(origin, dir, p) {
  const n = cross(p.right, p.up), den = dot(dir, n); if (Math.abs(den) < 1e-9) return null;
  const rel = [p.centre[0] - origin[0], p.centre[1] - origin[1], p.centre[2] - origin[2]], t = dot(rel, n) / den; if (t <= 0) return null;
  const point = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], q = [point[0] - p.centre[0], point[1] - p.centre[1], point[2] - p.centre[2]];
  const u = dot(q, p.right) / p.w + 0.5, v = 0.5 - dot(q, p.up) / p.h;
  return u < 0 || u > 1 || v < 0 || v > 1 ? null : { u, v, t, point };
}
/** The reference-space position of (u, v) on a panel. */
export function panelPoint(p, u, v) { const a = (u - 0.5) * p.w, b = (0.5 - v) * p.h; return [p.centre[0] + p.right[0] * a + p.up[0] * b, p.centre[1] + p.right[1] * a + p.up[1] * b, p.centre[2] + p.right[2] * a + p.up[2] * b]; }

/**
 * Lay rows of buttons out on a canvas W pixels wide. rows: [[{ id, label, span (columns, default 1), ... }], ...];
 * a row of k columns shares the width equally. Returns { rects: [{ ...item, x, y, w, h }], height }.
 */
export function layoutRows(rows, W, { pad = 12, gap = 8, rowH = 64, top = 0 } = {}) {
  const rects = []; let y = top + pad;
  for (const row of rows) {
    const h = row.h || rowH, cols = row.reduce((s, it) => s + (it.span || 1), 0) || 1, cw = (W - 2 * pad - gap * (cols - 1)) / cols; let col = 0;
    for (const it of row) { const sp = it.span || 1; rects.push({ ...it, x: pad + col * (cw + gap), y, w: cw * sp + gap * (sp - 1), h }); col += sp; }
    y += h + gap;
  }
  return { rects, height: y - gap + pad };
}
/** The button under a canvas point (pixels), or null. Items without an id (captions) and disabled ones are not hit. */
export function hitRects(rects, x, y) { for (const r of rects) if (r.id && !r.disabled && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r; return null; }

// ---------------------------------------------------------------- gaze and hands
/**
 * Gaze and dwell. st: { id, ms, fired } (start with {}); id: what is under the gaze now (null: nothing).
 * Returns the new state with `progress` 0..1 and `fire` true on the frame the dwell completes. It fires once; the
 * gaze has to leave and come back to fire again.
 */
export function dwell(st, id, dtMs, need = 1200) {
  if (id == null) return { id: null, ms: 0, fired: false, progress: 0, fire: false };
  if (id !== st.id) return { id, ms: 0, fired: false, progress: 0, fire: false };
  const ms = (st.ms || 0) + dtMs, fire = !st.fired && ms >= need;
  return { id, ms, fired: st.fired || fire, progress: st.fired || fire ? 1 : ms / need, fire };
}
/** Pinch with hysteresis: closes when thumb tip and index tip are within `on` metres, opens beyond `off`. */
export const pinching = (was, dist, on = 0.015, off = 0.03) => (was ? dist < off : dist < on);

// ---------------------------------------------------------------- the session
/** Arguments of navigator.xr.requestSession for 'vr' or 'ar'. Nothing is required, so that a plain viewer still gets a session. */
export function sessionInit(kind, overlayRoot) {
  const optionalFeatures = ['local-floor', 'hand-tracking'];
  if (kind === 'ar' && overlayRoot) return { mode: 'immersive-ar', init: { optionalFeatures: [...optionalFeatures, 'dom-overlay'], domOverlay: { root: overlayRoot } } };
  return { mode: kind === 'ar' ? 'immersive-ar' : 'immersive-vr', init: { optionalFeatures } };
}
/** The frame rate to ask for: the lowest the display offers that is at least `want` (72 Hz suits a standalone headset), else its highest. */
export function chooseFrameRate(supported, want = 72) {
  const r = Array.from(supported || []).filter((x) => x > 0).sort((a, b) => a - b); if (!r.length) return null;
  return r.find((x) => x >= want) ?? r[r.length - 1];
}
/** What to tell the user about immersive modes. env: { hasXR, secure, vr, ar }. Returns { vr, ar } with '' when available. */
export function supportMessages({ hasXR, secure, vr, ar }) {
  if (!secure) { const m = 'WebXR needs a secure page (https or localhost).'; return { vr: m, ar: m }; }
  if (!hasXR) { const m = 'This browser has no WebXR. Open the page in a headset browser (Meta Quest, Pico, Vision Pro) or Chrome on Android.'; return { vr: m, ar: m }; }
  return { vr: vr ? '' : 'This device offers no immersive VR session.', ar: ar ? '' : 'This device offers no passthrough (immersive AR) session.' };
}

// ---------------------------------------------------------------- small things shared with the page
/** The next or previous entry of a list after the one whose key is `cur` (wraps; the first or last when cur is not in it). */
export function cycle(keys, cur, step) {
  if (!keys.length) return -1; const i = keys.indexOf(cur);
  return i < 0 ? (step > 0 ? 0 : keys.length - 1) : (i + step + keys.length) % keys.length;
}
/** n + 1 world directions around the circle of altitude alt (radians), closed. */
export function altitudeRing(alt, n = 120) { const out = []; for (let i = 0; i <= n; i++) out.push(dirOfAltAz(alt, i / n * TAU)); return out; }
