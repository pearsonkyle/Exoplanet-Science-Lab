// The arithmetic of the immersive mode (src/sky/xrInput.js): rays, picking, the menu's hit test, the thumbstick
// and grip mappings, and the compass alignment. No WebXR here: the references are closed forms, src/core/astro.js
// (itself tested against astropy) and the star catalogue of the page.
import { readFileSync } from 'node:fs';
import * as X from '../src/sky/xrInput.js';
import * as A from '../src/core/astro.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const RAD = Math.PI / 180, DEG = 180 / Math.PI, close = (a, b, tol) => Math.abs(a - b) <= tol;

// --- frames
{
  let worst = 0;
  for (let h = -3; h <= 3; h += 0.37) for (const [alt, az] of [[0.2, 1], [1.2, 4], [-0.3, 5.9], [0, 0]]) {
    const w = X.dirOfAltAz(alt, az), r = X.worldToRef(w, h), back = X.refToWorld(r, h), a = X.altAzOfDir(back);
    worst = Math.max(worst, Math.abs(a.alt - alt), Math.abs(X.wrapPi(a.az - az)), Math.abs(r[1] - w[1]));
  }
  check('world <-> reference round trip, altitude kept', worst < 1e-12, `worst ${worst.toExponential(1)} rad`);
  // facing forward (-z) with heading h is looking at azimuth h on the horizon; +x (the right hand) is azimuth h + 90
  const h = 200 * RAD, f = X.altAzOfDir(X.refToWorld([0, 0, -1], h)), r = X.altAzOfDir(X.refToWorld([1, 0, 0], h));
  check('forward is the heading, right is heading + 90 deg', close(f.az * DEG, 200, 1e-9) && close(r.az * DEG, 290, 1e-9) && close(f.alt, 0, 1e-12), `${(f.az * DEG).toFixed(3)}, ${(r.az * DEG).toFixed(3)} deg`);
  // a pose matrix: rotation about y by 90 deg to the left (column-major), at (1, 1.5, 2): its ray goes along -x
  const ray = X.rayOfMatrix([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1.5, 2, 1]);
  check('ray of a pose matrix', ray.origin.join() === '1,1.5,2' && close(ray.dir[0], -1, 1e-12) && close(ray.dir[2], 0, 1e-12));
  check('angle between directions, small and large', close(X.angle(X.dirOfAltAz(0.5, 1), X.dirOfAltAz(0.5 + 1e-7, 1)), 1e-7, 1e-12) && close(X.angle([1, 0, 0], [-1, 0, 0]), Math.PI, 1e-12));
}

// --- picking: the real catalogue, a real night. Vega and Altair from Tucson, 2026-07-15 05:00 UTC.
{
  const buf = readFileSync(new URL('../public/sky/stars.bin', import.meta.url)), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), hlen = dv.getUint32(4, true), head = JSON.parse(buf.subarray(8, 8 + hlen).toString()), n = head.count;
  const names = JSON.parse(readFileSync(new URL('../public/sky/starnames.json', import.meta.url))).names;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), hip = new Uint32Array(n), eq = [];
  for (let i = 0, o = 8 + hlen; i < n; i++, o += 16) { const ra = dv.getFloat32(o, true), dec = dv.getFloat32(o + 4, true); eq.push([ra, dec]); mag[i] = dv.getInt16(o + 8, true) / 100; hip[i] = dv.getUint32(o + 12, true); pos.set(A.sphToVec(ra * RAD, dec * RAD), i * 3); }
  const idx = (name) => { for (let i = 0; i < n; i++) if ((names[hip[i]] || '').split('|')[0] === name) return i; return -1; };
  const ms = Date.UTC(2026, 6, 15, 5, 0, 0), lat = 32.2226 * RAD, lon = -110.9747 * RAD, sys = A.solarSystem(ms, lat, lon, 0);
  const ENU = [1, 0, 0, 0, 0, 1, 0, -1, 0], j2w = A.matMul(A.matMul(ENU, A.equatorialToHorizontalMatrix(lat, sys.lst)), A.j2000ToDateMatrix(sys.T)), w2j = A.transpose(j2w);
  const heading = 137 * RAD, tol = 1.5 * RAD;
  for (const name of ['Vega', 'Altair', 'Arcturus']) {
    const i = idx(name), h = A.fixedAltAz(eq[i][0] * RAD, eq[i][1] * RAD, ms, lat, lon);
    // the direction a controller has to point in the reference space, from the independent alt-az of astro.js
    const rayRef = X.worldToRef(X.dirOfAltAz(h.alt, h.az), heading), back = X.refToWorld(rayRef, heading), hit = X.scanCatalog(A.matVec(w2j, back), pos, n, tol, (k) => mag[k] <= 6, (k) => 0.12 * mag[k]);
    check(`a ray at ${name} picks it`, hit && hit.i === i, `alt ${(h.alt * DEG).toFixed(2)} az ${(h.az * DEG).toFixed(2)} deg, found ${(names[hip[hit?.i]] || '').split('|')[0]} at ${(hit.sep * 3600 * DEG).toFixed(0)}" (precession and nutation of the matrix path against fixedAltAz)`);
    // 1 degree off: still the bright star, not a faint neighbour that is nearer
    const off = X.refToWorld(X.worldToRef(X.dirOfAltAz(h.alt + 1 * RAD, h.az), heading), heading), hit2 = X.scanCatalog(A.matVec(w2j, off), pos, n, tol, (k) => mag[k] <= 6, (k) => 0.12 * mag[k]);
    check(`a ray 1 deg from ${name} still picks it`, hit2 && hit2.i === i, `separation ${(hit2.sep * DEG).toFixed(3)} deg`);
  }
  const empty = X.scanCatalog(A.matVec(w2j, X.dirOfAltAz(40 * RAD, 10 * RAD)), pos, n, 0.2 * RAD, (k) => mag[k] <= 2);
  check('nothing bright within the tolerance: null', empty === null);
  // candidates with a disc: the Moon (radius 0.26 deg) wins 0.2 deg from its centre over a planet 0.1 deg from the ray
  const moon = X.dirOfAltAz(0.5, 2), ray = X.dirOfAltAz(0.5 + 0.2 * RAD, 2), pl = X.dirOfAltAz(0.5 + 0.3 * RAD, 2);
  const c = X.pickCandidates(ray, [{ id: 'planet', dir: pl, bias: 0 }, { id: 'moon', dir: moon, bias: 0.26 * RAD }], 1 * RAD);
  check('a disc counts from its edge', c.id === 'moon' && close(c.d * DEG, -0.06, 1e-6), `d = ${(c.d * DEG).toFixed(3)} deg`);
  check('no candidate inside the tolerance', X.pickCandidates(X.dirOfAltAz(1, 5), [{ id: 'moon', dir: moon }], 1 * RAD) === null);
}

// --- alignment and grabbing
{
  // the sky is drawn with a wrong heading; the user points at where the Moon really is (azimuth 123.4 deg), which in
  // the reference space is at -z turned 40 deg to the right and 30 deg up; after alignment the drawn Moon is there
  const trueAz = 123.4 * RAD, alt = 30 * RAD, a = 40 * RAD, rayRef = [Math.cos(alt) * Math.sin(a), Math.sin(alt), -Math.cos(alt) * Math.cos(a)];
  const h = X.alignHeading(rayRef, trueAz), drawn = X.worldToRef(X.dirOfAltAz(alt, trueAz), h);
  check('alignment puts the object under the ray', X.angle(drawn, rayRef) < 1e-12 && close(h * DEG, 83.4, 1e-9), `heading ${(h * DEG).toFixed(3)} deg (123.4 - 40), residual ${X.angle(drawn, rayRef).toExponential(1)} rad`);
  // the ray's altitude does not matter (a controller held a little high or low): same heading
  const h2 = X.alignHeading([Math.cos(0.1) * Math.sin(a), Math.sin(0.1), -Math.cos(0.1) * Math.cos(a)], trueAz);
  check('alignment uses the azimuth of the ray only', close(h2, h, 1e-12));
  check('no alignment at the zenith', X.alignHeading(X.dirOfAltAz(87 * RAD, 1), 1) === null && X.alignHeading(X.dirOfAltAz(84 * RAD, 1), 1) !== null);
  // grab: the sky point under the ray at the start stays under it
  const h0 = 0.7, r0 = X.dirOfAltAz(0.3, 0.2), g = X.grabStart(r0, h0), star = X.refToWorld(r0, h0);
  let worst = 0, turned = 0;
  for (let k = 1; k <= 50; k++) { const r = X.dirOfAltAz(0.3, 0.2 + k * 0.17); turned = X.grabMove(g, r); worst = Math.max(worst, X.angle(X.worldToRef(star, X.grabHeading(h0, turned)), r)); }
  check('grabbed sky follows the ray through more than a full turn', worst < 1e-9 && close(turned, 50 * 0.17, 1e-9), `turned ${(turned * DEG).toFixed(1)} deg, worst ${worst.toExponential(1)} rad`);
  // scrub: 15 degrees of sweep is one hour; a sweep back is negative; three hours for 45 degrees
  check('grip scrub: 15 deg per hour', close(X.grabTime(1000, 15 * RAD), 1000 + 3600000, 1e-6) && close(X.grabTime(0, -45 * RAD), -3 * 3600000, 1e-6));
  // and that is the sky's own rate: a star on the celestial equator due south moves 15.04 deg of hour angle per hour
  check('scrub rate against the sidereal rate', close(A.SIDEREAL_RATE * 3600000 / X.SCRUB_RAD_PER_HOUR, 1.0027379, 1e-6), `ratio ${(A.SIDEREAL_RATE * 3600000 / X.SCRUB_RAD_PER_HOUR).toFixed(7)}`);
}

// --- thumbstick
{
  check('dead zone', X.deadzone(0.1) === 0 && X.deadzone(-0.15) === 0 && close(X.deadzone(1), 1, 1e-12) && close(X.deadzone(-0.575), -0.5, 1e-12));
  const r = [0.2, 0.5, 1, -1].map((x) => X.stickTimeRate(x));
  check('time rate: cubic, 2 h/s at the stop, odd', close(r[2], 7200, 1e-9) && close(r[3], -7200, 1e-9) && close(r[1], 7200 * (0.35 / 0.85) ** 3, 1e-9) && r[0] > 0 && r[0] < 2, `${r.map((v) => v.toFixed(1)).join(', ')} s/s at 0.2, 0.5, 1, -1`);
  check('step: up (y = -1) is positive, 1.5 per second', close(X.stickStep(-1, 0.5), 0.75, 1e-12) && X.stickStep(0.1, 1) === 0 && close(X.stickStep(1, 1), -1.5, 1e-12));
  check('thumbstick axes of xr-standard', X.stickOf([0, 0, 0.3, -0.4]).join() === '0.3,-0.4' && X.stickOf([0.1, 0.2]).join() === '0.1,0.2' && X.stickOf([]).join() === '0,0');
  const prev = []; const e1 = X.pressedEdges(prev, [{ pressed: false }, { pressed: true }]), e2 = X.pressedEdges(prev, [{ pressed: true }, { pressed: true }]), e3 = X.pressedEdges(prev, [{ pressed: true }, { pressed: false }]);
  check('button edges', e1.join() === '1' && e2.join() === '0' && e3.join() === '');
}

// --- panels and the menu
{
  const head = [0.2, 1.6, -0.1], p = X.placePanel(head, [0.3, -0.4, -0.9], { dist: 0.9, drop: 0.45, w: 0.7, h: 0.5 });
  const n = X.cross(p.right, p.up), toHead = X.norm([head[0] - p.centre[0], head[1] - p.centre[1], head[2] - p.centre[2]]);
  check('panel: at its distance, below eye level, facing the head', close(Math.hypot(p.centre[0] - head[0], p.centre[1] - head[1], p.centre[2] - head[2]), 0.9, 1e-12) && close(head[1] - p.centre[1], 0.9 * Math.sin(0.45), 1e-12) && X.angle(n, toHead) < 1e-9 && close(X.dot(p.right, p.up), 0, 1e-12) && close(p.right[1], 0, 1e-12));
  // a ray from the head to a known point of the panel comes back with the same (u, v)
  let worst = 0;
  for (const [u, v] of [[0.5, 0.5], [0.02, 0.03], [0.97, 0.9], [0.25, 0.75]]) { const q = X.panelPoint(p, u, v), d = X.norm([q[0] - head[0], q[1] - head[1], q[2] - head[2]]), hit = X.rayPanel(head, d, p); worst = Math.max(worst, Math.abs(hit.u - u), Math.abs(hit.v - v)); }
  check('ray -> panel coordinates round trip', worst < 1e-12, `worst ${worst.toExponential(1)}`);
  const off = X.panelPoint(p, 1.05, 0.5), dOff = X.norm([off[0] - head[0], off[1] - head[1], off[2] - head[2]]);
  check('off the panel, behind, parallel: null', X.rayPanel(head, dOff, p) === null && X.rayPanel(head, toHead, p) === null && X.rayPanel(head, p.right, p) === null);
  const yawed = X.placePanel([0, 1.6, 0], [0, 0, -1], { yaw: 0.6, drop: 0 });
  check('panel turned to the right', yawed.centre[0] > 0 && close(Math.atan2(yawed.centre[0], -yawed.centre[2]), 0.6, 1e-12));
  // layout: 3 rows, spans, no overlap, inside the width; the centre of each rect hits it
  const rows = [[{ id: 'a', label: 'A' }, { id: 'b', label: 'B', span: 2 }, { id: 'c', label: 'C' }], [{ label: 'caption' }], [{ id: 'd', label: 'D' }, { id: 'e', label: 'E', disabled: true }]];
  const L = X.layoutRows(rows, 800, { pad: 12, gap: 8, rowH: 64 }), R = Object.fromEntries(L.rects.filter((r) => r.id).map((r) => [r.id, r]));
  check('layout: widths by span, rows stacked', close(R.a.w, 188, 1e-9) && close(R.b.w, 384, 1e-9) && close(R.b.x, 208, 1e-9) && close(R.c.x + R.c.w, 788, 1e-9) && R.d.y === 12 + 2 * 72 && L.height === 12 + 3 * 64 + 2 * 8 + 12, `a ${R.a.w} px, b ${R.b.w} px, height ${L.height} px`);
  check('hit test: centres, gaps, captions, disabled', ['a', 'b', 'c', 'd'].every((id) => X.hitRects(L.rects, R[id].x + R[id].w / 2, R[id].y + R[id].h / 2).id === id) && X.hitRects(L.rects, R.a.x + R.a.w + 4, 40) === null && X.hitRects(L.rects, 400, 12 + 72 + 30) === null && X.hitRects(L.rects, R.e.x + 5, R.e.y + 5) === null);
  // the whole path: a controller ray to a button of a panel 0.7 m wide drawn on an 800 px canvas
  const hit = X.rayPanel(head, X.norm(X.panelPoint(p, (R.b.x + 10) / 800, (R.b.y + 10) / L.height).map((x, i) => x - head[i])), p), b = X.hitRects(L.rects, hit.u * 800, hit.v * L.height);
  check('ray -> panel -> button', b && b.id === 'b');
}

// --- gaze, pinch, session
{
  let st = {}, fired = 0, at = 0;
  for (let t = 0; t < 3000; t += 100) { st = X.dwell(st, 'x', 100, 1200); if (st.fire) { fired++; at = t + 100; } }
  check('dwell fires once, after 1.2 s', fired === 1 && at === 1300 && st.progress === 1, `fired at ${at} ms (the first frame only sets the target)`);
  st = X.dwell(st, 'y', 100); const moved = st.ms === 0 && !st.fired; st = X.dwell(st, null, 100);
  check('dwell restarts on a new target and clears on none', moved && st.id === null && st.progress === 0);
  check('pinch hysteresis', X.pinching(false, 0.02) === false && X.pinching(false, 0.01) === true && X.pinching(true, 0.02) === true && X.pinching(true, 0.04) === false);
  const vr = X.sessionInit('vr'), ar = X.sessionInit('ar', {}), ar0 = X.sessionInit('ar');
  check('session arguments', vr.mode === 'immersive-vr' && !vr.init.requiredFeatures && vr.init.optionalFeatures.join() === 'local-floor,hand-tracking' && ar.mode === 'immersive-ar' && ar.init.optionalFeatures.includes('dom-overlay') && !!ar.init.domOverlay && !ar0.init.domOverlay);
  check('frame rate: 72 of Quest rates, the highest when below, none', X.chooseFrameRate([72, 80, 90, 120]) === 72 && X.chooseFrameRate(new Float32Array([60])) === 60 && X.chooseFrameRate([90, 120]) === 90 && X.chooseFrameRate(undefined) === null);
  const m = X.supportMessages({ hasXR: true, secure: true, vr: true, ar: false });
  check('support messages', m.vr === '' && /passthrough/.test(m.ar) && /secure/.test(X.supportMessages({ secure: false }).vr) && /no WebXR/.test(X.supportMessages({ secure: true, hasXR: false }).ar));
  check('cycle through targets', X.cycle(['a', 'b', 'c'], 'c', 1) === 0 && X.cycle(['a', 'b', 'c'], 'a', -1) === 2 && X.cycle(['a', 'b'], 'zz', 1) === 0 && X.cycle(['a', 'b'], null, -1) === 1 && X.cycle([], 'a', 1) === -1);
  const ring = X.altitudeRing(30 * RAD, 72);
  check('altitude ring: closed, all at 30 deg', ring.length === 73 && ring.every((d) => close(Math.asin(d[1]) * DEG, 30, 1e-9)) && X.angle(ring[0], ring[72]) < 1e-12);
}
process.exit(ok ? 0 : 1);
