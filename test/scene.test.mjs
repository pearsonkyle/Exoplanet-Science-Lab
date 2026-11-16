// Named orbit points used by the system view (eventAnomaly / eventPosition / eventTime in core/kepler.js), checked against
// direct evaluation of orbitPosition at independently obtained times (tmid, eventTimes().tecl and .tperi, tperi + P/2,
// and the upward zero crossing of Z found by bisection), and against the analytic distances and impact parameters.
import { orbitElements, orbitPosition, eventTimes, derived, eventAnomaly, eventPosition, eventTime } from '../src/core/kepler.js';
import { moonPosition, planetPosition } from '../src/core/exomoon.js';
import { moonForView, moonPlacement } from '../src/viz/moonview.js';
import { mapFrame, mapLonLat } from '../src/viz/planetmap.js';
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

// ---- the moon in the system view (src/viz/moonview.js: what scene.js and fallback2d.js place on screen) ----------------
// Checked against relations written out here, not taken from exomoon.js: Kepler's third law for the planet-moon
// separation, the centre of mass staying on the planet's Keplerian orbit, the moon's period, the direction of the
// moon at the phases the model defines, and the sense of the orbit from its angular momentum.
{
  const MJ = 1.26686534e17 / 1.32712440018e20;   // Jupiter mass in solar masses: IAU 2015 Resolution B3 nominal GM values
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const systems = [
    { name: 'Jupiter at 45 d, moon at 3.7 d (the worked example)', planet: { per: 45, tmid: 2.5, ars: 60.8, inc: 89.6, ecc: 0, omega: 0, rprs: 0.1 }, moon: { rmoon: 0.02, permoon: 3.7, phmoon: 0.15, mmoon: 0.01, imoon: 0, mplanet: 1, mstar: 1 } },
    { name: 'eccentric planet (e = 0.3), tilted moon', planet: { per: 120, tmid: -7, ars: 110, inc: 89.8, ecc: 0.3, omega: 70, rprs: 0.08 }, moon: { rmoon: 0.015, permoon: 6.2, phmoon: 0.62, mmoon: 0.03, imoon: 25, mplanet: 2.5, mstar: 0.9 } },
    { name: 'retrograde moon (imoon = 180), no wobble', planet: { per: 30, tmid: 0, ars: 40, inc: 90, ecc: 0, omega: 0, rprs: 0.1 }, moon: { rmoon: 0.03, permoon: 2.1, phmoon: 0.25, mmoon: 0, imoon: 180, mplanet: 0.8, mstar: 1.1 } },
  ];
  let wSep = 0, wBary = 0, wPer = 0, wK1 = 0, wScale = 0, wRing = 0, sense = true;
  for (const sy of systems) {
    const el = orbitElements(sy.planet), mp = { ...sy.moon, rprs: sy.planet.rprs }, mv = moonForView(el, mp), q = sy.moon.mmoon;
    // Kepler's third law for both orbits: a_m / a_p = [ (Mp + Mm) / (M* + Mp + Mm) ]^(1/3) (P_m / P_p)^(2/3)
    const mu = (sy.moon.mplanet * MJ * (1 + q)) / sy.moon.mstar, sep = sy.planet.ars * Math.cbrt(mu / (1 + mu)) * Math.pow(sy.moon.permoon / sy.planet.per, 2 / 3);
    wSep = Math.max(wSep, Math.abs(mv.sep / sep - 1));
    for (const dt of [-11.3, -0.4, 0, 0.07, 1.9, 23.7]) {
      const t = sy.planet.tmid + dt, a = moonPlacement(el, mv, t, 1), pl = [...a.planet], mo = [...a.moon];
      // true scale: the model's own positions
      const pm = planetPosition(el, mp, t), mm = moonPosition(el, mp, t);
      wK1 = Math.max(wK1, Math.hypot(...sub(pl, pm)), Math.hypot(...sub(mo, mm)), Math.abs(a.rMoon - sy.moon.rmoon));
      wSep = Math.max(wSep, Math.abs(Math.hypot(...sub(mo, pl)) / sep - 1));
      // centre of mass of planet and moon is on the planet's Keplerian orbit
      const bc = orbitPosition(el, t, [0, 0, 0]), cm = [0, 1, 2].map((i) => (pl[i] + q * mo[i]) / (1 + q));
      wBary = Math.max(wBary, Math.hypot(...sub(cm, bc)) / sy.planet.ars);
      // one moon period later the moon is back where it was relative to the planet
      const b = moonPlacement(el, mv, t + sy.moon.permoon, 1);
      wPer = Math.max(wPer, Math.hypot(...sub(sub(b.moon, b.planet), sub(mo, pl))) / sep);
      // enlarged k times: radius and separation both grow by k, so separation / planet radius is the true ratio
      const k = 7.5, c = moonPlacement(el, mv, t, k);
      wScale = Math.max(wScale, Math.abs(Math.hypot(...sub(c.moon, c.planet)) / (k * sy.planet.rprs) / (Math.hypot(...sub(mo, pl)) / sy.planet.rprs) - 1), Math.abs(c.rMoon / (k * sy.planet.rprs) - sy.moon.rmoon / sy.planet.rprs), Math.hypot(...sub(c.planet, pl)));
      // the ring drawn round the planet passes through the moon: nearest ring point within half a segment
      let dmin = Infinity; for (let i = 0; i < 128; i++) dmin = Math.min(dmin, Math.hypot(pl[0] + mv.ring[3 * i] - mo[0], pl[1] + mv.ring[3 * i + 1] - mo[1], pl[2] + mv.ring[3 * i + 2] - mo[2]));
      wRing = Math.max(wRing, dmin / (sep * Math.PI / 128));
    }
    // sense of the orbit: the moon's angular momentum about the planet against the planet's about the star
    const h = 1e-4, t0 = sy.planet.tmid + 0.3, r0 = moonPlacement(el, mv, t0 - h, 1), ra = sub(r0.moon, r0.planet), r1 = moonPlacement(el, mv, t0 + h, 1), rb = sub(r1.moon, r1.planet);
    const Lm = cross(ra, sub(rb, ra)), Lp = cross(orbitPosition(el, t0 - h, [0, 0, 0]), sub(orbitPosition(el, t0 + h, [0, 0, 0]), orbitPosition(el, t0 - h, [0, 0, 0])));
    const cosT = dot(Lm, Lp) / (Math.hypot(...Lm) * Math.hypot(...Lp)), want = Math.cos(sy.moon.imoon * DEG);
    if (Math.abs(cosT - want) > 1e-6) sense = false;
  }
  check('moon: planet-moon separation is Kepler\'s third law for the two orbits', wSep < 1e-10, `max relative difference ${wSep.toExponential(1)}`);
  check('moon: at true scale the view places planet and moon where the light-curve model has them', wK1 < 1e-13, `max difference ${wK1.toExponential(1)} R*`);
  check('moon: the centre of mass of planet and moon stays on the planet\'s Keplerian orbit', wBary < 1e-13, `max ${wBary.toExponential(1)} of a/R*`);
  check('moon: back at the same place relative to the planet after one moon period', wPer < 1e-9, `max ${wPer.toExponential(1)} of the separation`);
  check('moon: enlarged with its planet, the pair keeps its proportions and the planet its place', wScale < 1e-12, `max ${wScale.toExponential(1)}`);
  check('moon: the drawn orbit ring passes through the moon', wRing <= 1 + 1e-9, `nearest ring point at most ${wRing.toFixed(2)} of half a segment away`);
  check('moon: angle between the moon\'s and the planet\'s orbital angular momenta is imoon (prograde 0, retrograde 180)', sense);
  // phases: at the planet's mid-transit a moon with phase 0 is in front of the planet (toward the observer), 0.25 ahead of it (+X, the direction of motion), 0.5 behind it
  const pl = { per: 30, tmid: 0, ars: 40, inc: 90, ecc: 0, omega: 0, rprs: 0.1 }, el = orbitElements(pl), dir = (ph) => { const a = moonPlacement(el, moonForView(el, { rmoon: 0.02, permoon: 2, phmoon: ph, mmoon: 0, imoon: 0, mplanet: 1, mstar: 1, rprs: 0.1 }), 0, 1), d = sub(a.moon, a.planet), n = Math.hypot(...d); return d.map((x) => x / n); };
  const d0 = dir(0), d25 = dir(0.25), d50 = dir(0.5), v = sub(orbitPosition(el, 1e-3, [0, 0, 0]), orbitPosition(el, -1e-3, [0, 0, 0]));
  check('moon: phase 0 is toward the observer, 0.25 ahead of the planet along its motion, 0.5 behind the planet', d0[2] > 0.999999 && d50[2] < -0.999999 && d25[0] > 0.999999 && v[0] > 0, `phase 0: Z ${d0[2].toFixed(6)}; phase 0.25: X ${d25[0].toFixed(6)}; the planet moves toward +X at mid-transit`);
  check('moon: a planet without a moon, or a moon without a defined orbit, is not drawn', moonForView(el, null) === null && moonForView(el, { rmoon: 0.02, permoon: 2, rprs: 0.1 }) === null);
}
// The fitted brightness map on the 3D planet (viz/planetmap.js, mirrored by the planet shader) against the convention of
// the Map view's globes and core/phasecurve.js: the observer sees sub-observer longitude lon0 = -(phase - 0.5) * 360 deg
// (east of the substellar point; phase from mid-transit) and latitude lat0 = 90 - i. Independent of the shader: the
// observer's direction +Z is put through mapLonLat at positions from orbitPosition.
{
  for (const inc of [90, 83.5]) {
    const el = orbitElements({ per: 0.8135, tmid: 0, ars: 4.9, inc, ecc: 0, omega: 0, rprs: 0.16 });
    let worst = 0, worstLat = 0;
    for (const ph of [0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
      const f = mapFrame(orbitPosition(el, ph * el.per, [0, 0, 0]), el), ll = mapLonLat([0, 0, 1], f);
      const want = ((((-(ph - 0.5) * 360) + 180) % 360) + 360) % 360 - 180, d = Math.abs(((ll.lon - want + 540) % 360) - 180);
      worst = Math.max(worst, d); worstLat = Math.max(worstLat, Math.abs(ll.lat - (90 - inc)));
    }
    check(`planet map (i = ${inc}°): the hemisphere facing the observer is the Map view's at every phase`, worst < 1e-6 && worstLat < 1e-6, `largest longitude error ${worst.toExponential(1)}°, latitude ${worstLat.toExponential(1)}°`);
  }
  const el = orbitElements({ per: 1, tmid: 0, ars: 5, inc: 90, ecc: 0, omega: 0, rprs: 0.1 }), p = orbitPosition(el, 0.25, [0, 0, 0]), f = mapFrame(p, el);
  const toStar = mapLonLat(f.sub, f);
  check('planet map: the substellar point faces the star', Math.abs(toStar.lon) < 1e-9 && Math.abs(toStar.lat) < 1e-9);
}
process.exit(ok ? 0 : 1);
