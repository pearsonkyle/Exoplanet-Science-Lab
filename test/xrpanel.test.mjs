// The floating windows and gestures of the immersive mode (src/sky/xrPanel.js): hit zones in canvas pixels, the
// window geometry (facing, moving, resizing), the menu's tabs, and the gesture state machines fed synthetic poses
// and button states frame by frame. No WebXR here; the references are closed forms and xrInput.js's rayPanel.
import * as X from '../src/sky/xrInput.js';
import * as P from '../src/sky/xrPanel.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const RAD = Math.PI / 180, DEG = 180 / Math.PI, close = (a, b, tol) => Math.abs(a - b) <= tol;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const along = (o, d, t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];

// --- hit zones in canvas pixels
{
  const W = 800, H = 600, title = P.titleRects([{ id: 'fold', label: 'Fold', w: 110 }, { id: 'exit', label: 'Exit VR', w: 200 }], W);
  const body = X.layoutRows([[{ id: 'a', label: 'A' }, { id: 'b', label: 'B', disabled: true }]], W, { top: 200 }).rects, win = { W, H, title, rects: body };
  check('title buttons: right-aligned inside the bar, in order, not overlapping', title[1].x + title[1].w === W - 8 && title[0].x + title[0].w < title[1].x && title.every((r) => r.y >= 0 && r.y + r.h <= P.TITLE_H), title.map((r) => `${r.id} ${r.x}-${r.x + r.w}`).join(', '));
  const z = (x, y) => { const h = P.hitZone(win, x, y); return h ? h.zone + (h.item ? ':' + h.item.id : '') : 'null'; };
  const got = [z(20, 30), z(title[1].x + 5, 30), z(title[0].x + 5, 30), z(W - 5, H - 5), z(W - P.HANDLE - 2, H - 5), z(body[0].x + 5, body[0].y + 5), z(body[1].x + 5, body[1].y + 5), z(400, 500), z(-1, 10), z(10, H + 1)];
  const want = ['title', 'button:exit', 'button:fold', 'resize', 'body', 'button:a', 'body', 'body', 'null', 'null'];
  check('hit zones: title bar, its buttons, the corner handle, body buttons, a disabled one, bare body, outside', got.join() === want.join(), got.join(', '));
  check('a window without a frame has no title bar or handle', P.hitZone({ ...win, frame: false }, 20, 30).zone === 'body' && P.hitZone({ ...win, frame: false }, W - 5, H - 5).zone === 'body');
}

// --- a window facing the head
{
  const headPos = [0.1, 1.6, 0.2]; let worst = 0, worstUp = 0;
  for (const c of [[0, 1.2, -0.9], [0.8, 1.9, 0.1], [-0.5, 0.6, 0.7], [0.1, 3, 0.25]]) {
    const g = P.facePanel(c, headPos, 0.6, 0.4), n = X.cross(g.right, g.up), toHead = X.norm(headPos.map((v, i) => v - c[i]));
    worst = Math.max(worst, X.angle(n, toHead)); worstUp = Math.max(worstUp, Math.abs(g.right[1]), Math.abs(X.dot(g.right, g.up)), Math.abs(Math.hypot(...g.up) - 1));
  }
  check('facePanel: the window\'s normal points at the head, its right edge is level, its axes orthonormal', worst < 1e-12 && worstUp < 1e-12, `normal ${worst.toExponential(1)} rad off; axes ${worstUp.toExponential(1)}`);
  // rayPanel on a faced window: the ray through panelPoint(u, v) gives back (u, v)
  const g = P.facePanel([0.4, 1.3, -0.8], headPos, 0.7, 0.5); let e = 0;
  for (const [u, v] of [[0.1, 0.1], [0.5, 0.5], [0.93, 0.77]]) { const q = X.panelPoint(g, u, v), h = X.rayPanel(headPos, X.norm(q.map((x, i) => x - headPos[i])), g); e = Math.max(e, Math.abs(h.u - u), Math.abs(h.v - v)); }
  check('rayPanel(panelPoint(u, v)) = (u, v) on a faced window', e < 1e-12, e.toExponential(1));
}

// --- moving a window: the point grabbed stays on the ray at the same distance
{
  const headPos = [0, 1.6, 0], g0 = P.facePanel([0, 1.2, -0.85], headPos, 0.84, 0.6);
  const o = [0.25, 1.35, -0.2], grab = X.panelPoint(g0, 0.3, 0.04), d0 = X.norm(grab.map((v, i) => v - o[i])), h0 = X.rayPanel(o, d0, g0);
  const m = P.moveStart(g0, h0.point, h0.t); let worst = 0, g = g0;
  for (let k = 1; k <= 12; k++) {
    const a = k * 4 * RAD, d = X.norm([Math.cos(a) * d0[0] - Math.sin(a) * d0[2], d0[1] + 0.01 * k, Math.sin(a) * d0[0] + Math.cos(a) * d0[2]]);
    g = P.moveWindow(m, { origin: o, dir: d }, headPos, g0.w, g0.h);
    const h = X.rayPanel(o, d, g); worst = Math.max(worst, h ? Math.hypot(h.u - 0.3, h.v - 0.04) : 1, h ? Math.abs(h.t - h0.t) : 1);
  }
  const n = X.cross(g.right, g.up);
  check('moveWindow: the grabbed point stays under the ray (u, v and distance), over a 48 deg sweep', worst < 1e-9, `worst ${worst.toExponential(1)}`);
  check('... and the moved window still faces the head', X.angle(n, X.norm(headPos.map((v, i) => v - g.centre[i]))) < 1e-9 && g.w === g0.w && g.h === g0.h);
  check('pushPull: the stick pushed away moves the window out, clamped', close(P.pushPull(1, -1, 0.5), 1.6, 1e-12) && P.pushPull(3.9, -1, 1) === 4 && P.pushPull(0.4, 1, 1) === 0.3);
}

// --- resizing from the corner: top-left stays, aspect kept, width clamped
{
  const headPos = [0, 1.6, 0], g0 = P.facePanel([0, 1.4, -1], headPos, 0.6, 0.45), o = [0.2, 1.3, -0.1];
  const handle = X.panelPoint(g0, 0.97, 0.96), d0 = X.norm(handle.map((v, i) => v - o[i])), r = P.resizeStart(g0, X.rayPanel(o, d0, g0).point);
  const tl = (g) => X.panelPoint(g, 0, 0), br = (g) => X.panelPoint(g, 1, 1);
  const same = P.resizeWindow(r, { origin: o, dir: d0 });
  check('resize: no movement, no change', dist(same.centre, g0.centre) < 1e-12 && close(same.w, g0.w, 1e-12));
  // drag the corner 0.3 m to the right along the window: 0.6 -> 0.9 m wide, height follows
  const target = along(handle, g0.right, 0.3), g1 = P.resizeWindow(r, { origin: o, dir: X.norm(target.map((v, i) => v - o[i])) });
  check('resize: the corner follows the ray, the top-left corner stays, the aspect is kept', close(g1.w, 0.9, 1e-9) && close(g1.h / g1.w, 0.75, 1e-12) && dist(tl(g1), tl(g0)) < 1e-12, `w ${g1.w.toFixed(4)} m, h ${g1.h.toFixed(4)} m, top-left moved ${dist(tl(g1), tl(g0)).toExponential(1)} m`);
  // dragged down only: the height leads
  const g2 = P.resizeWindow(r, { origin: o, dir: X.norm(along(handle, g0.up, -0.15).map((v, i) => v - o[i])) });
  check('resize: dragged down, the height leads (0.45 -> 0.60 m)', close(g2.h, 0.6, 1e-9) && dist(tl(g2), tl(g0)) < 1e-12, `h ${g2.h.toFixed(4)} m`);
  const g3 = P.resizeWindow(r, { origin: o, dir: X.norm(along(along(handle, g0.right, -0.5), g0.up, 0.4).map((v, i) => v - o[i])) }), g4 = P.resizeWindow(r, { origin: o, dir: X.norm(along(handle, g0.right, 5).map((v, i) => v - o[i])) });
  check('resize: clamped to 0.3..2.4 m', g3.w === P.MIN_W && g4.w === P.MAX_W, `${g3.w}, ${g4.w}`);
  check('resize: a ray away from the plane changes nothing (null)', P.resizeWindow(r, { origin: o, dir: [0, 0, 1] }) === null);
  const k = P.keepTop(g0, 0.7);
  check('keepTop: a taller window keeps its top edge', dist(tl(k), tl(g0)) < 1e-12 && close(br(k)[1], tl(g0)[1] - 0.7 * g0.up[1], 1e-9));
}

// --- summoning and folding the menu
{
  const head = { pos: [0, 1.6, 0], fwd: [0, 0, -1] }, g = P.facePanel([0, 1.2, -0.85], head.pos, 0.8, 0.6), off = P.offAxis(g, head);
  const look = (deg) => ({ pos: head.pos, fwd: [Math.sin(deg * RAD), 0, -Math.cos(deg * RAD)] });
  check('summon: folded -> open; open and in view -> fold; open out of view -> bring in front', P.summon(false, off) === 'open' && P.summon(true, off) === 'fold' && P.summon(true, P.offAxis(g, look(90))) === 'place', `menu ${(off * DEG).toFixed(1)} deg below the gaze`);
}

// --- tabs: a long menu one section at a time
{
  const cap = (label) => Object.assign([{ label }], { h: 30 });
  const rows = [[{ id: 'night', label: 'Play the night' }], [{ id: 'next', label: 'Next' }], cap('Transits tonight (above 30°)'), [{ id: 'tn:0', label: 'X b' }], cap('Visible: now, brightest first'), [{ id: 'vis:1', label: 'Y' }], cap('Show'), [{ id: 'layer:labels', label: 'Names' }], cap('Stars with planets, by discovery method'), [{ id: 'disc:t', label: 'Transit' }], Object.assign(cap('Compass: you started facing 180° S'), { tab: 'Compass' }), [{ id: 'xr:align', label: 'Point & set' }]];
  const sp = P.splitTabs(rows);
  check('splitTabs: head rows, then one tab per caption, named from the caption', sp.head.length === 2 && sp.tabs.map((t) => t.name).join('|') === 'Transits tonight|Visible|Show|Stars with planets|Compass' && sp.tabs[2].rows.length === 2, sp.tabs.map((t) => t.name).join(', '));
  const m = P.composeTabs({ title: '22:00', rows }, 'Show'), ids = m.rows.flat().map((r) => r.id || '(' + r.label + ')');
  check('composeTabs: head + tab bar + the active section only', m.tab === 'Show' && ids.join() === 'night,next,xr:tab:Transits tonight,xr:tab:Visible,xr:tab:Show,xr:tab:Stars with planets,xr:tab:Compass,(Show),layer:labels' && m.rows[2].find((t) => t.on).id === 'xr:tab:Show', ids.join(' '));
  check('composeTabs: an unknown or vanished tab falls back to the first', P.composeTabs({ rows }, 'Nope').tab === 'Transits tonight' && P.composeTabs({ rows }, null).tab === 'Transits tonight');
  check('composeTabs: a menu with one section or none is left as it is', P.composeTabs({ rows: rows.slice(0, 4) }, 'x').rows.length === 4 && P.composeTabs({ rows: rows.slice(0, 2) }).rows.length === 2);
}

// --- gestures, stepped at 72 Hz
const DT = 1000 / 72;
{
  // B / Y: a short press is a tap (on release), a held press fires once at 1 s
  const run = (frames, total) => { let s = {}, tap = 0, long = 0, maxP = 0, firstBar = -1; for (let i = 0; i < total; i++) { s = P.holdButton(s, i < frames, DT); tap += s.tap; long += s.long; if (s.progress > 0 && firstBar < 0) firstBar = i; maxP = Math.max(maxP, s.progress); } return { tap, long, maxP, firstBar }; };
  const tap = run(10, 20), longp = run(90, 100), hold = run(400, 410);
  check('holdButton: a 0.14 s press is one tap and no bar', tap.tap === 1 && tap.long === 0 && tap.maxP === 0);
  check('holdButton: held 1.25 s: one long press at 1 s, no tap on release, the bar from 0.25 s', longp.long === 1 && longp.tap === 0 && close(longp.maxP, 1, 1e-12) && close(longp.firstBar * DT, 250, 1.5 * DT), `bar from ${(longp.firstBar * DT).toFixed(0)} ms`);
  check('holdButton: held 5.5 s still fires once', hold.long === 1 && hold.tap === 0);
}
{
  check('pinched: hysteresis (closes under 15 mm, opens over 30 mm)', P.pinched(false, 0.014) && !P.pinched(false, 0.02) && P.pinched(true, 0.025) && !P.pinched(true, 0.031));
  // a hand closing and opening, distances in metres over frames
  const seq = [0.06, 0.04, 0.02, 0.012, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.025, 0.035, 0.05];
  const run = (nativeAtFrame) => { let s = {}, starts = [], ends = []; for (let i = 0; i < seq.length; i++) { const now = i * DT, native = nativeAtFrame == null ? -Infinity : nativeAtFrame * DT; s = P.pinchFallback(s, seq[i], now, i >= (nativeAtFrame ?? Infinity) ? native : -Infinity); if (s.start) starts.push(i); if (s.end) ends.push(i); } return { starts, ends }; };
  const none = run(null), native = run(3), late = run(10);
  check('pinchFallback: no select event from the browser: one start 250 ms after closing, one end when it opens', none.starts.length === 1 && close((none.starts[0] - 3) * DT, 250, DT) && none.ends.length === 1 && none.ends[0] === 27, `start at frame ${none.starts[0]}, end at ${none.ends[0]}`);
  check('pinchFallback: the browser sent a select as the fingers met: nothing synthetic', native.starts.length === 0 && native.ends.length === 0);
  check('pinchFallback: a select 100 ms later still counts as the browser\'s', late.starts.length === 0);
  let s = {}; for (const d of [0.01, null, 0.01]) s = P.pinchFallback(s, d, 0);
  check('pinchFallback: joints lost mid-pinch open it', s.closed && s.closedAt === 0 && !s.synthetic);
}
{
  // palm normal from synthetic joints: a right hand palm down (thumb to the left), then turned palm up; a left hand mirrored
  const wrist = [0, 1.2, -0.3], rDown = { im: [-0.02, 1.2, -0.38], pm: [0.03, 1.2, -0.37] }, rUp = { im: [0.02, 1.2, -0.38], pm: [-0.03, 1.2, -0.37] };
  const nD = P.palmNormal(wrist, rDown.im, rDown.pm, 'right'), nU = P.palmNormal(wrist, rUp.im, rUp.pm, 'right'), lU = P.palmNormal(wrist, rDown.im, rDown.pm, 'left');
  check('palmNormal: right palm down -> -y, turned over -> +y; a left hand with the right\'s palm-down layout faces up', close(nD[1], -1, 1e-12) && close(nU[1], 1, 1e-12) && close(lU[1], 1, 1e-12), `${nD[1]}, ${nU[1]}, ${lU[1]}`);
  // palm up and looked at for 0.5 s fires once; turning it down re-arms; not looked at: nothing
  const run = (frames) => { let s = {}, fires = []; frames.forEach(([up, look], i) => { s = P.palmUp(s, up, look, DT); if (s.fire) fires.push(i); }); return fires; };
  const f1 = run([...Array(30).fill([0.95, 0.9]), ...Array(60).fill([0.95, 0.9])]);
  const f2 = run([...Array(50).fill([0.95, 0.9]), ...Array(5).fill([0.1, 0.9]), ...Array(50).fill([0.95, 0.9])]);
  const f3 = run(Array(100).fill([0.95, 0.3])), f4 = run(Array(100).fill([0.6, 0.9]));
  check('palmUp: fires once after 0.5 s, not again while held', f1.length === 1 && close((f1[0] + 1) * DT, 500, DT), `at ${((f1[0] + 1) * DT).toFixed(0)} ms`);
  check('palmUp: turned down and up again fires again', f2.length === 2);
  check('palmUp: not looked at, or only half up: nothing', f3.length === 0 && f4.length === 0);
}

console.log(ok ? 'xr panel: all checks passed' : 'xr panel: FAILURES'); if (!ok) process.exit(1);
