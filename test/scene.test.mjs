// Named orbit points used by the system view (eventAnomaly / eventPosition / eventTime in core/kepler.js), checked against
// direct evaluation of orbitPosition at independently obtained times (tmid, eventTimes().tecl and .tperi, tperi + P/2,
// and the upward zero crossing of Z found by bisection), and against the analytic distances and impact parameters.
import { orbitElements, orbitPosition, eventTimes, derived, eventAnomaly, eventPosition, eventTime } from '../src/core/kepler.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const DEG = Math.PI / 180;

const cases = [
  { name: 'circular hot Jupiter', per: 2.150008, tmid: 0.3, ars: 6.05, inc: 88.9, ecc: 0, omega: 0, rprs: 0.15 },
  { name: 'circular, omega set but e = 0', per: 1.51, tmid: -4.2, ars: 20.5, inc: 89.7, ecc: 0, omega: 123, rprs: 0.085 },
  { name: 'mild e = 0.2, omega = 40', per: 4.05, tmid: 10, ars: 12, inc: 87, ecc: 0.2, omega: 40, rprs: 0.1 },
  { name: 'e = 0.5, omega = 200', per: 21.2, tmid: 3, ars: 30, inc: 89.5, ecc: 0.5, omega: 200, rprs: 0.08 },
  { name: 'HD 80606 b: e = 0.93, omega = -58.7, i = 89.27', per: 111.4367, tmid: 0, ars: 94.45, inc: 89.27, ecc: 0.93, omega: -58.7, rprs: 0.1 },
  { name: 'HD 80606 b with e = 0.9313 and omega = 301.3', per: 111.4367, tmid: 55.5, ars: 94.45, inc: 89.27, ecc: 0.9313, omega: 301.3, rprs: 0.1 },
  { name: 'e = 0.6, omega = 90 (periastron at transit)', per: 9, tmid: 1, ars: 15, inc: 88, ecc: 0.6, omega: 90, rprs: 0.05 },
  { name: 'e = 0.6, omega = 270 (periastron at eclipse)', per: 9, tmid: 1, ars: 15, inc: 88, ecc: 0.6, omega: 270, rprs: 0.05 },
];

let worst = { pos: 0, time: 0, r: 0, b: 0 }, signs = true, nodeOK = true, withinHalf = true;
for (const p of cases) {
  const el = orbitElements(p), ev = eventTimes(p), a = [0, 0, 0], tol = 1e-8 * p.ars;
  // independent times: tmid, eventTimes, and a bisection for the node (Z = 0 with Z rising, between the eclipse before this transit and the transit)
  const tEclBefore = ev.tecl < el.tmid ? ev.tecl : ev.tecl - el.per;
  let lo = tEclBefore, hi = el.tmid;
  for (let i = 0; i < 200; i++) { const m = 0.5 * (lo + hi); if (orbitPosition(el, m, a)[2] < 0) lo = m; else hi = m; }
  const times = { transit: el.tmid, eclipse: ev.tecl, periastron: ev.tperi, apastron: ev.tperi + el.per / 2, ascending: 0.5 * (lo + hi) };
  const d = {};
  for (const kind of Object.keys(times)) {
    const want = orbitPosition(el, times[kind], [0, 0, 0]), got = eventPosition(el, kind);
    d[kind] = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
    worst.pos = Math.max(worst.pos, d[kind] / p.ars);
    // eventTime must land on the same point (it may differ from the reference time by whole periods)
    const te = eventTime(el, kind), at = orbitPosition(el, te, [0, 0, 0]);
    worst.time = Math.max(worst.time, Math.hypot(at[0] - got[0], at[1] - got[1], at[2] - got[2]) / p.ars);
    if (Math.abs(te - el.tmid) > el.per / 2 + 1e-9) withinHalf = false;
  }
  const maxd = Math.max(...Object.values(d));
  check(`${p.name}: five events match orbitPosition`, maxd < tol, `max |dr| ${maxd.toExponential(1)} R* (transit ${d.transit.toExponential(1)}, eclipse ${d.eclipse.toExponential(1)}, peri ${d.periastron.toExponential(1)}, apo ${d.apastron.toExponential(1)}, node ${d.ascending.toExponential(1)})`);

  const T = eventPosition(el, 'transit'), E = eventPosition(el, 'eclipse'), P = eventPosition(el, 'periastron'), A = eventPosition(el, 'apastron'), N = eventPosition(el, 'ascending');
  if (!(T[2] > 0 && E[2] < 0)) signs = false;
  // analytic distances
  worst.r = Math.max(worst.r, Math.abs(Math.hypot(...P) - p.ars * (1 - el.e)) / p.ars, Math.abs(Math.hypot(...A) - p.ars * (1 + el.e)) / p.ars);
  // conjunctions: X = 0 and |Y| = impact parameter (Winn 2010 eqs. 7 and 8)
  const w = el.w, bT = derived(p).b, bE = p.ars * Math.cos(p.inc * DEG) * (1 - el.e ** 2) / (1 - el.e * Math.sin(w));
  worst.b = Math.max(worst.b, Math.abs(T[0]), Math.abs(E[0]), Math.abs(Math.abs(T[1]) - bT), Math.abs(Math.abs(E[1]) - bE), Math.abs(Math.hypot(T[0], T[1]) - bT));
  // node: in the plane of the sky, on the -X side, a quarter orbit before transit when circular, Z rising
  const eps = 1e-6 * el.per, zr = orbitPosition(el, times.ascending + eps, [0, 0, 0])[2] - orbitPosition(el, times.ascending - eps, [0, 0, 0])[2];
  if (!(Math.abs(N[2]) < 1e-9 * p.ars && N[0] < 0 && Math.abs(N[1]) < 1e-9 * p.ars && zr > 0)) nodeOK = false;
  if (el.e === 0 && Math.abs(times.ascending - (el.tmid - el.per / 4)) > 1e-9 * el.per) nodeOK = false;
}
check('all events: position error relative to a/R*', worst.pos < 1e-8, `max ${worst.pos.toExponential(1)}`);
check('eventTime lands on eventPosition and lies within half a period of tmid', worst.time < 1e-8 && withinHalf, `max ${worst.time.toExponential(1)} of a/R*`);
check('Z > 0 at transit and Z < 0 at eclipse', signs);
check('periastron and apastron distances are a(1 - e) and a(1 + e)', worst.r < 1e-12, `max relative ${worst.r.toExponential(1)}`);
check('X = 0 and |Y| = impact parameter at both conjunctions', worst.b < 1e-10, `max ${worst.b.toExponential(1)} R*`);
check('ascending node: Z = 0 rising, on the -X axis, P/4 before transit when e = 0', nodeOK);

// HD 80606 b by hand: transit impact parameter a cos i (1 - e^2) / (1 + e sin w)
{
  const p = cases[4], el = orbitElements(p), T = eventPosition(el, 'transit'), E = eventPosition(el, 'eclipse');
  const bT = 94.45 * Math.cos(89.27 * DEG) * (1 - 0.93 ** 2) / (1 + 0.93 * Math.sin(-58.7 * DEG));
  const bE = 94.45 * Math.cos(89.27 * DEG) * (1 - 0.93 ** 2) / (1 - 0.93 * Math.sin(-58.7 * DEG));
  check('HD 80606 b: Y at transit = -b, Y at eclipse = +b_ecl', Math.abs(T[1] + bT) < 1e-12 && Math.abs(E[1] - bE) < 1e-12, `b = ${bT.toFixed(4)}, b_ecl = ${bE.toFixed(4)}; star-planet distance ${Math.hypot(...T).toFixed(2)} R* at transit, ${Math.hypot(...E).toFixed(2)} R* at eclipse`);
}
check('unknown kind gives NaN', Number.isNaN(eventAnomaly(orbitElements(cases[0]), 'nope')));
process.exit(ok ? 0 : 1);
