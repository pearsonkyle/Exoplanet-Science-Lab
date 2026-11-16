// N-body dynamics (src/core/nbody.js) against independent references:
//   REBOUND 5.2 IAS15 and WHFast, TTVFast, and EXOTIC's own exotic/api/nbody.py (test/nbody_reference.json, written by
//   test/make_nbody_reference.py); kepler.js and rv.js for the two-body limit; analytic TTV formulae; scipy for the
//   critical AMD; and the bundled synthetic example (public/examples/nbody). Every tolerance is stated where it is used.
//   About 25 s. NBODY_FAST=1 node test/nbody.test.mjs skips the nested-sampling retrieval (13 s of it).
import { readFileSync } from 'node:fs';
import {
  NB, buildSystem, simulate, nbody, dynamicalModel, nbodyTimingProblem, ttvSummary, lithwickTTV, agolTTV, nearestFirstOrder,
  amdCritical, stabilityReport, ttvGrid, ttvGridRefine, energy, defaultStep,
} from '../src/core/nbody.js';
import { orbitElements, orbitPosition, eventTimes, derived } from '../src/core/kepler.js';
import { makeRV, semiAmplitude } from '../src/core/rv.js';
import { buildProblem } from '../src/core/model.js';
import { fitEphemeris, assignEpochs } from '../src/core/ephemeris.js';
import { timingPeriodogram } from '../src/core/periodogram.js';
import { validateSession, specFromSession } from '../src/core/session.js';
import { MiniNest } from '../src/core/nested.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./nbody_reference.json', import.meta.url)));
const S = 86400, ex = (v, d = 1) => v.toExponential(d);
/** Largest |a - b| in seconds, and the same after removing a straight line in the index (a period and zero-point error). */
const tdiff = (a, b) => {
  const n = Math.min(a.length, b.length); let mx = 0, s0 = 0, s1 = 0, s2 = 0, sy = 0, sxy = 0; const d = new Float64Array(n);
  for (let i = 0; i < n; i++) { d[i] = a[i] - b[i]; mx = Math.max(mx, Math.abs(d[i])); s0++; s1 += i; s2 += i * i; sy += d[i]; sxy += i * d[i]; }
  let det = 0; if (n > 2) { const D = s0 * s2 - s1 * s1, A = (s2 * sy - s1 * sxy) / D, B = (s0 * sxy - s1 * sy) / D; for (let i = 0; i < n; i++) det = Math.max(det, Math.abs(d[i] - A - B * i)); }
  return { raw: mx * S, det: det * S, same: a.length === b.length };
};
const best = (f, n = 5) => { let b = Infinity, r; for (let i = 0; i < n; i++) { const t0 = performance.now(); r = f(); b = Math.min(b, performance.now() - t0); } return { ms: b, r }; };

// =============================================================================================================
console.log('--- two-body limit: N-body equals Kepler');
{
  // massless planet: transit times are tmid + k P (the definition of tmid in kepler.js), over thousands of orbits
  let worst = 0, worstI = 0, okN = true; const rows = [];
  for (const [e, w, inc, per, norb] of [[0, 0, 90, 3.3, 5000], [0.3, 40, 88, 3.3, 5000], [0.93132, -58.699, 89.269, 111.4367, 1000]]) {
    const p = { mstar: 1.05, rstar: 1.05, epoch: 0, planets: [{ per, tmid: 1.234, ecc: e, omega: w, inc, mplanet: 0 }] };
    const r = nbody(p, { tEnd: per * norb, event: 'conjunction' }), tr = r.transits[0];
    let mx = 0; for (let i = 0; i < tr.n; i++) mx = Math.max(mx, Math.abs(tr.t[i] - (1.234 + per * i)));
    const ri = nbody(p, { tEnd: per * Math.min(norb, 500), event: 'conjunction', integrator: 'ias15' }), ti = ri.transits[0];
    let mi = 0; for (let i = 0; i < ti.n; i++) mi = Math.max(mi, Math.abs(ti.t[i] - (1.234 + per * i)));
    worst = Math.max(worst, mx / (per * norb)); worstI = Math.max(worstI, mi * S);
    rows.push(`e=${e}: ${tr.n} transits ${ex(mx * S)} s (WH, ${r.steps} steps), ${ex(mi * S)} s (IAS15, ${ti.n})`);
    if (tr.n !== norb) okN = false;
  }
  check('massless planet: transit times equal tmid + k P to rounding (Wisdom-Holman), tolerance 2e-12 of the elapsed time', okN && worst < 2e-12, rows.join('; ') + `; worst ${ex(worst)} of the elapsed time`);
  check('massless planet: the same with IAS15 over 500 orbits, tolerance 2e-3 s', worstI < 2e-3, `worst ${ex(worstI)} s (e = 0.93 costs IAS15 its last digits; REBOUND's IAS15 differs from Kepler by 8e-4 s over 20 orbits of HD 80606 b)`);
}
{
  // 'minsep' against the minimum of the separation computed from kepler.js alone; and how far it is from conjunction
  const p = { per: 111.4367, tmid: 8.0757, ars: 94.45, inc: 89.269, ecc: 0.93132, omega: -58.699, rprs: 0.1 };
  const el = orbitElements(p), tmp = [0, 0, 0], d2 = (t) => { orbitPosition(el, t, tmp); return tmp[0] * tmp[0] + tmp[1] * tmp[1]; };
  const g = (t) => d2(t + 1e-4) - d2(t - 1e-4);
  let lo = p.tmid - 0.05, hi = p.tmid + 0.05; for (let i = 0; i < 80; i++) { const m = 0.5 * (lo + hi); if (g(m) < 0) lo = m; else hi = m; }
  const tMin = 0.5 * (lo + hi);
  // the same orbit as an N-body system: a/R* = 94.45 fixes M* through Kepler's law for R* = 1.05
  const rstar = 1.05, aAU = p.ars * rstar * NB.Rsun_AU, mstar = (4 * Math.PI ** 2 * aAU ** 3) / (NB.G * p.per ** 2);
  const sys = { mstar, rstar, epoch: 0, planets: [{ per: p.per, tmid: p.tmid, ecc: p.ecc, omega: p.omega, inc: p.inc, mplanet: 0, rprs: p.rprs }] };
  const a = nbody(sys, { tEnd: 3 * p.per }), c = nbody(sys, { tEnd: 3 * p.per, event: 'conjunction' });
  const dMin = Math.abs(a.transits[0].t[0] - tMin) * S, off = (c.transits[0].t[0] - a.transits[0].t[0]) * S;
  check('minimum projected separation agrees with kepler.js, tolerance 1e-3 s', dMin < 1e-3, `${ex(dMin)} s`);
  check('HD 80606 b: centre of the light curve and conjunction differ by minutes (documented choice of event)', Math.abs(off - 684) < 5, `conjunction is ${off.toFixed(1)} s after the minimum separation`);
  // impact parameter and duration against kepler.js (first to fourth contact, numerically exact there)
  const ev = eventTimes(p), dv = derived(p);
  const dB = Math.abs(c.transits[0].b[0] - dv.b), dT = Math.abs(c.transits[0].dur[0] - ev.t14) * S;
  check('impact parameter at conjunction and T14 agree with kepler.js, tolerances 1e-8 and 0.01 s', dB < 1e-8 && dT < 0.01, `b ${c.transits[0].b[0].toFixed(6)} (diff ${ex(dB)}), T14 ${(c.transits[0].dur[0] * 24).toFixed(4)} h (diff ${ex(dT)} s)`);
}
{
  // a massive single planet is still a two-body problem: times exact, RV equal to rv.js
  const p = { mstar: 1.05, rstar: 1.05, epoch: 2458880, planets: [{ per: 111.4367, tmid: 2458888.0757, ecc: 0.93132, omega: -58.699, inc: 89.269, mplanet: 4.2 }] };
  const times = Array.from({ length: 200 }, (_, i) => 2458880 + 1.1 * i);
  const r = nbody(p, { tEnd: 2458880 + 230, event: 'conjunction', times });
  const K = semiAmplitude(111.4367, 0.93132, 89.269, 4.2, 1.05), f = makeRV({ per: 111.4367, tmid: 2458888.0757, ecc: 0.93132, omega: -58.699, K });
  let mx = 0; times.forEach((t, i) => (mx = Math.max(mx, Math.abs(r.rv[i] - f(t)))));
  const dt = Math.max(Math.abs(r.transits[0].t[0] - 2458888.0757), Math.abs(r.transits[0].t[1] - 2458888.0757 - 111.4367)) * S;
  check('single massive planet: radial velocity equals rv.js (K = ' + K.toFixed(2) + ' m/s), tolerance 1e-6 m/s', mx < 1e-6, `max difference ${ex(mx)} m/s; transit times ${ex(dt)} s from tmid + k P`);
  check('single massive planet: transit times, tolerance 1e-5 s', dt < 1e-5);
}

{
  // coords: 'astrocentric': every planet's position and velocity relative to the star are those of its own two-body
  // orbit about the star (period per with G (M* + m)), whatever the other planets are
  const pl = [{ per: 3.1, tmid: 0.4, ecc: 0.2, omega: 33, inc: 87, Omega: 5, mplanet: 2 }, { per: 9.7, tmid: 2.2, ecc: 0.1, omega: 250, inc: 88, mplanet: 5 }];
  const both = buildSystem({ mstar: 1, epoch: 0, coords: 'astrocentric', planets: pl }); let d = 0, dj = 0;
  pl.forEach((q, i) => {
    const one = buildSystem({ mstar: 1, epoch: 0, planets: [q] });
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs((both.x[3 * (i + 1) + k] - both.x[k]) - (one.x[3 + k] - one.x[k])), Math.abs((both.v[3 * (i + 1) + k] - both.v[k]) - (one.v[3 + k] - one.v[k])));
  });
  const jac = buildSystem({ mstar: 1, epoch: 0, planets: pl }); for (let k = 0; k < 3; k++) dj = Math.max(dj, Math.abs((jac.x[6 + k] - jac.x[k]) - (both.x[6 + k] - both.x[k])));
  check("coords 'astrocentric': each planet starts on its own two-body orbit about the star, tolerance 1e-15 AU", d < 1e-15 && dj > 1e-5, `${ex(d)}; the Jacobi reading of the same numbers puts the outer planet ${ex(dj)} AU elsewhere`);
}

// =============================================================================================================
console.log('--- conservation, reversibility, order');
{
  const p = ref.systems.near_2to1.system, sys = buildSystem(p), T = 300 * 2.797436;
  const w = simulate(sys, { tEnd: sys.epoch + T, transits: false }), i = simulate(sys, { tEnd: sys.epoch + T, transits: false, integrator: 'ias15' });
  check('Wisdom-Holman: energy error bounded, tolerance 1e-8 (default step P/30, corrector 5)', w.energy.maxRelErr < 1e-8, `|dE/E| ${ex(w.energy.maxRelErr)} over 300 orbits, angular momentum ${ex(w.angmom.relErr)}`);
  check('Wisdom-Holman: angular momentum, tolerance 1e-12', w.angmom.relErr < 1e-12);
  check('IAS15: energy and angular momentum, tolerance 1e-12', i.energy.maxRelErr < 1e-12 && i.angmom.relErr < 1e-12, `|dE/E| ${ex(i.energy.maxRelErr)}, |dL/L| ${ex(i.angmom.relErr)}, ${i.steps} steps`);
  // time reversibility: forward, flip the velocities, forward again
  const rows = []; let worst = 0;
  for (const corr of [0, 5]) {
    const dt = 2.797436 / 20, a = simulate(sys, { tEnd: sys.epoch + 2000 * dt, transits: false, dt, corrector: corr });
    const back = { ...sys, x: Float64Array.from(a.state.x), v: Float64Array.from(a.state.v, (q) => -q) };
    const b = simulate(back, { tEnd: sys.epoch + 2000 * dt, transits: false, dt, corrector: corr });
    let d = 0; for (let q = 0; q < 3 * sys.n; q++) d = Math.max(d, Math.abs(b.state.x[q] - sys.x[q]));
    worst = Math.max(worst, d / sys.a[1]); rows.push(`corrector ${corr}: ${ex(d / sys.a[1])}`);
  }
  check('Wisdom-Holman is time-reversible: 2000 steps there and back, tolerance 1e-9 of the orbit', worst < 1e-9, rows.join(', ') + ' (rounding only)');
}
{
  // order of convergence on a low-mass pair (so the eps^2 dt^2 floor is far below): error of the final positions
  const p = { mstar: 1, epoch: 0, planets: [{ per: 10, tmid: 1, ecc: 0.02, omega: 30, inc: 90, mplanet: 0.02 }, { per: 15.2, tmid: 4, ecc: 0.03, omega: 200, inc: 90, mplanet: 0.02 }] };
  const sys = buildSystem(p), T = 400, truth = simulate(sys, { tEnd: T, transits: false, integrator: 'ias15', epsilon: 1e-10 }).state.x;
  const err = (dt, corr) => { const r = simulate(sys, { tEnd: T, transits: false, dt, corrector: corr }); let d = 0; for (let q = 0; q < 9; q++) d = Math.max(d, Math.abs(r.state.x[q] - truth[q])); return d; };
  const e0 = [16, 32, 64].map((k) => err(10 / k, 0)), e3 = [16, 32].map((k) => err(10 / k, 3));
  const s0 = Math.log2(e0[0] / e0[2]) / 2, s3 = Math.log2(e3[0] / e3[1]);
  check('Wisdom-Holman without corrector converges as dt^2, tolerance 0.3 in the exponent', Math.abs(s0 - 2) < 0.3, `measured exponent ${s0.toFixed(2)} between P/16 and P/64 (errors ${e0.map((v) => ex(v)).join(', ')} AU)`);
  check('with the third-order corrector the error falls faster than dt^3.3 and is over 20 times smaller at P/16', s3 > 3.3 && e0[0] / e3[0] > 20, `measured exponent ${s3.toFixed(2)} between P/16 and P/32 (${e3.map((v) => ex(v)).join(', ')} AU); theory dt^4 down to the eps^2 dt^2 floor`);
}

// =============================================================================================================
console.log(`--- against REBOUND ${ref.rebound_version} (IAS15 and WHFast)`);
const TOL = {  // seconds: this app's IAS15, and its Wisdom-Holman defaults (raw, and after removing a linear ephemeris)
  exotic_example: { ias: 0.01, wh: 1, det: 0.5 }, near_2to1: { ias: 0.01, wh: 10, det: 1 }, near_3to2: { ias: 0.01, wh: 0.5, det: 0.2 },
  trappist1: { ias: 0.01, wh: 0.1, det: 0.05 }, hd80606_massless: { ias: 0.1, wh: 0.1, det: 0.1 }, hd80606: { ias: 0.1, wh: 0.1, det: 0.1 }, hj_companion: { ias: 0.01, wh: 0.01, det: 0.01 },
};
// HD 80606 b (e = 0.93) is a two-body problem with a known answer; REBOUND's own times wander from it by up to
// 0.04 s (thousands of stop-and-go outputs through periastron), which is why its tolerance is 0.1 s. The exact check
// of this app on that orbit is the Kepler block above.
{ const r = ref.systems.hd80606_massless, p = r.system.planets[0]; let m = 0; r.conjunction[0].forEach((t, k) => (m = Math.max(m, Math.abs(t - p.tmid - k * p.per) * S))); console.log(`info  REBOUND's IAS15 on massless HD 80606 b: its conjunction times differ from tmid + k P by up to ${m.toFixed(3)} s over 20 orbits`); }
const speed = {}, syncSpeed = []; let syncCost = 0;
for (const [name, r] of Object.entries(ref.systems)) {
  const sys = buildSystem(r.system), np = r.system.planets.length, tol = TOL[name];
  let d0 = 0; r.initial.forEach((row, i) => { for (let k = 0; k < 3; k++) d0 = Math.max(d0, Math.abs(row[k] - sys.x[3 * i + k]), Math.abs(row[3 + k] - sys.v[3 * i + k])); });
  const e0 = energy(sys.n, sys.m, sys.x, sys.v), dE = r.energy0 !== 0 ? Math.abs(e0 / r.energy0 - 1) : Math.abs(e0);
  check(`${name}: initial conditions and energy equal REBOUND's, tolerances 1e-13 AU and 1e-12`, d0 < 1e-13 && dE < 1e-12, `${ex(d0)} AU (AU/d), energy ${ex(dE)}`);
  // IAS15
  const si = simulate(sys, { tEnd: r.tEnd, integrator: 'ias15', times: r.rv_t }), sic = simulate(sys, { tEnd: r.tEnd, integrator: 'ias15', event: 'conjunction' });
  let mI = 0, mC = 0, n = 0, same = true, dbv = 0;
  for (let p = 0; p < np; p++) {
    const a = tdiff(si.transits[p].t, r.minsep[p]), c = tdiff(sic.transits[p].t, r.conjunction[p]); mI = Math.max(mI, a.raw); mC = Math.max(mC, c.raw); n += r.minsep[p].length; same = same && a.same && c.same;
    r.minsep_bv[p].forEach((bv, i) => { if (i < si.transits[p].n && bv[0] > 0) dbv = Math.max(dbv, Math.abs((si.transits[p].b[i] * sys.rstarAU) / bv[0] - 1) * Math.min(1, bv[0] / sys.rstarAU), Math.abs((si.transits[p].vsky[i] * sys.rstarAU) / bv[1] - 1)); });
  }
  let dRv = 0, mRv = 0; r.rv.forEach((v, i) => { dRv = Math.max(dRv, Math.abs(v - si.rv[i])); mRv = Math.max(mRv, Math.abs(v)); });
  let dF = 0; r.final.forEach((row, i) => { for (let k = 0; k < 3; k++) dF = Math.max(dF, Math.abs(row[k] - si.state.x[3 * i + k])); });
  check(`${name}: IAS15 transit times of ${n} transits, tolerance ${tol.ias} s`, same && mI < tol.ias && mC < tol.ias, `minimum separation ${ex(mI)} s, conjunction ${ex(mC)} s; impact parameter and sky speed ${ex(dbv)}`);
  check(`${name}: IAS15 radial velocity and final positions, tolerances 1e-4 m/s and 1e-8 AU`, dRv < 1e-4 && dF < 1e-8 && dbv < 1e-6, `RV ${ex(dRv)} of ${mRv.toFixed(1)} m/s; positions after ${r.span.toFixed(0)} d ${ex(dF)} AU; |dE/E| ${ex(si.energy.maxRelErr)}`);
  // Wisdom-Holman with the defaults
  const sw = simulate(sys, { tEnd: r.tEnd, times: r.rv_t });
  let mW = 0, mD = 0; same = true;
  for (let p = 0; p < np; p++) { const a = tdiff(sw.transits[p].t, r.minsep[p]); mW = Math.max(mW, a.raw); mD = Math.max(mD, a.det); same = same && a.same; }
  let dRw = 0; r.rv.forEach((v, i) => (dRw = Math.max(dRw, Math.abs(v - sw.rv[i]))));
  check(`${name}: Wisdom-Holman defaults, tolerance ${tol.wh} s (${tol.det} s after a linear ephemeris), RV 0.01 m/s`, same && mW < tol.wh && mD < tol.det && dRw < 0.01, `${ex(mW)} s raw, ${ex(mD)} s detrended, RV ${ex(dRw)} m/s; step ${(sw.dt * 24).toFixed(2)} h, ${sw.steps} steps, |dE/E| ${ex(sw.energy.maxRelErr)}`);
  // without re-synchronising at every transit (exactSync: false, what the grid uses)
  { const sf = simulate(sys, { tEnd: r.tEnd, exactSync: false }); let m = 0; for (let p = 0; p < np; p++) m = Math.max(m, tdiff(sf.transits[p].t, sw.transits[p].t).raw); syncCost = Math.max(syncCost, m); syncSpeed.push(sw.seconds / sf.seconds); }
  // the same map as WHFast: same step, same corrector, so the states agree to amplified rounding
  const sm = simulate(sys, { tEnd: r.tEnd, dt: r.whfast.dt, corrector: r.whfast.corrector, transits: false });
  let dM = 0; r.whfast.state.forEach((row, i) => { for (let k = 0; k < 3; k++) dM = Math.max(dM, Math.abs(row[k] - sm.state.x[3 * i + k])); });
  check(`${name}: same map as REBOUND's WHFast (dt ${r.whfast.dt.toPrecision(4)} d, corrector ${r.whfast.corrector}, ${r.whfast.steps} steps), tolerance 1e-9 AU`, sm.steps === r.whfast.steps && dM < 1e-9, `positions differ by ${ex(dM)} AU`);
  if (r.minsep_before) {
    const sb = simulate(sys, { tStart: r.tStart, tEnd: sys.epoch, integrator: 'ias15' }), swb = simulate(sys, { tStart: r.tStart, tEnd: sys.epoch });
    let mB = 0, mBw = 0, okN = true; for (let p = 0; p < np; p++) { const a = tdiff(sb.transits[p].t, r.minsep_before[p]), b = tdiff(swb.transits[p].t, r.minsep_before[p]); mB = Math.max(mB, a.raw); mBw = Math.max(mBw, b.raw); okN = okN && a.same && b.same; }
    check(`${name}: transits BEFORE the epoch (integrating backward ${(sys.epoch - r.tStart).toFixed(0)} d), tolerances 0.01 s (IAS15) and ${tol.wh} s (WH)`, okN && mB < 0.01 && mBw < tol.wh, `${ex(mB)} s, ${ex(mBw)} s`);
  }
  if (r.ttvfast) {
    let mT = 0, mE = 0; for (let p = 0; p < np; p++) { mT = Math.max(mT, tdiff(si.transits[p].t, r.ttvfast.times[p]).raw); if (r.ttvfast.times_elements[p].length === r.minsep[p].length) mE = Math.max(mE, tdiff(si.transits[p].t, r.ttvfast.times_elements[p]).raw); }
    check(`${name}: TTVFast (dt = P/100, same Cartesian start), tolerance 2 s`, mT < 2, `${ex(mT)} s; from the same Jacobi ELEMENTS TTVFast differs by ${ex(mE)} s (its a(P) uses G M* eta_k/eta_(k-1), not G eta_k: a convention, see make_nbody_reference.py)`);
  }
  // speed against the C code, pure stepping
  if (name === 'exotic_example' || name === 'trappist1') {
    const w = best(() => simulate(sys, { tEnd: r.tEnd, dt: r.whfast.dt, corrector: r.whfast.corrector, transits: false })), i = best(() => simulate(sys, { tEnd: r.tEnd, integrator: 'ias15', transits: false }), 3);
    speed[name] = { wh: w.ms, whC: r.whfast.seconds * 1e3, ias: i.ms, iasC: r.ias15_seconds * 1e3, steps: r.whfast.steps, iasSteps: i.r.steps, iasStepsC: r.ias15_steps };
  }
}

check('exactSync: false changes the transit times by less than 0.2 s in every reference system', syncCost < 0.2, `largest change ${ex(syncCost)} s; run time ${syncSpeed.map((v) => v.toFixed(1)).join(', ')} times shorter`);

// =============================================================================================================
console.log('--- against EXOTIC exotic/api/nbody.py on its example (examples/nbody/example.py)');
if (!ref.exotic) console.log('skip  no EXOTIC output in the reference file');
else {
  const E = ref.exotic, r = ref.systems.exotic_example;
  // EXOTIC's objects, in this app's parameters: both planets at true anomaly 0 with omega = 0 at t = 0, a quarter orbit before conjunction
  const pl = E.objects.slice(1).map((o) => ({ per: o.P, tmid: o.P / 4, ecc: o.e, omega: (o.omega * 180) / Math.PI, inc: (o.inc * 180) / Math.PI, mplanet: o.m / NB.Mjup }));
  const sim = nbody({ mstar: E.objects[0].m, rstar: 0.877, epoch: 0, planets: pl }, { tEnd: E.ndays, integrator: 'ias15', event: 'conjunction', times: E.rv.t_mid });
  const rows = []; let mx = 0, mo = 0, okN = true;
  for (let j = 0; j < 2; j++) {
    const ex0 = E.planets[j], mine = sim.transits[j].t.slice(0, ex0.tt.length), d = tdiff(mine, ex0.tt), s = ttvSummary(mine, { periodogram: false });
    let oc = 0; for (let i = 0; i < ex0.ttv.length; i++) oc = Math.max(oc, Math.abs(s.oc[i] - ex0.ttv[i]) * S);
    const dReb = tdiff(r.conjunction[j].slice(0, ex0.tt.length), ex0.tt).raw;
    okN = okN && Math.abs(sim.transits[j].n - ex0.tt.length) <= 1 && Math.abs(s.per / ex0.P - 1) < 1e-6;
    mx = Math.max(mx, d.raw); mo = Math.max(mo, oc);
    rows.push(`planet ${j + 1}: ${ex0.tt.length} transits, times ${d.raw.toFixed(2)} s (REBOUND with root finding differs from EXOTIC by ${dReb.toFixed(2)} s), O − C ${oc.toFixed(2)} s, mean period ${s.per.toFixed(7)} vs ${ex0.P.toFixed(7)} d, amplitude ${(s.amplitude * 1440).toFixed(2)} min`);
  }
  check('EXOTIC transit times and O − C reproduced, tolerance 5 s (EXOTIC interpolates linearly between hourly outputs)', okN && mx < 5 && mo < 5, '\n       ' + rows.join('\n       '));
  let dr = 0, sxy = 0, sxx = 0, syy = 0, cxy = 0, cyy = 0; E.rv.v.forEach((v, i) => { dr = Math.max(dr, Math.abs(v - sim.rv[i])); sxy += v * sim.rv[i]; sxx += v * v; syy += sim.rv[i] ** 2; cxy += E.rv_sky_axis[i] * sim.rv[i]; cyy += E.rv_sky_axis[i] ** 2; });
  check('EXOTIC radial velocity (line of sight, working copy of nbody.py), tolerance 0.5 m/s', dr < 0.5, `max difference ${dr.toFixed(3)} m/s of ${Math.sqrt(syy / E.rv.v.length * 2).toFixed(0)} m/s; correlation ${(sxy / Math.sqrt(sxx * syy)).toFixed(5)}. The committed nbody.py (main and origin/nbody) differences the sky axis x instead: correlation with the true RV ${(cxy / Math.sqrt(cyy * syy)).toFixed(3)}`);
}

// =============================================================================================================
console.log('--- analytic expectations');
{
  const a = lithwickTTV({ mstar: 1, P1: 1, P2: 2, m1: 1, m2: 1 }), b = lithwickTTV({ mstar: 1, P1: 2, P2: 3, m1: 1, m2: 1 }), c = lithwickTTV({ mstar: 1, P1: 1, P2: 2.02, m1: 1, m2: 1 });
  check('Lithwick, Xie & Wu (2012) coefficients f, g (their Table 3), tolerance 2e-3', Math.abs(a.f + 1.190) < 2e-3 && Math.abs(a.g - 0.4284) < 2e-3 && Math.abs(b.f + 2.025) < 2e-3 && Math.abs(b.g - 2.484) < 2e-3 && Math.abs((c.f - a.f) / 0.01 - 2.20) < 0.1 && Math.abs((c.g - a.g) / 0.01 + 3.69) < 0.1,
    `2:1 f ${a.f.toFixed(4)} g ${a.g.toFixed(4)}, slopes ${((c.f - a.f) / 0.01).toFixed(2)} ${((c.g - a.g) / 0.01).toFixed(2)} (published -1.190 + 2.20 Δ, 0.4284 - 3.69 Δ); 3:2 f ${b.f.toFixed(4)} g ${b.g.toFixed(4)} (-2.025, 2.484)`);
  let worst = 0; const rows = [];
  for (const [ratio, m1, m2, e1, w1, e2, w2] of [[2.06, 0.03, 0.05, 0, 0, 0, 0], [1.94, 0.03, 0.05, 0, 0, 0, 0], [1.54, 0.02, 0.03, 0, 0, 0, 0], [2.06, 0.03, 0.05, 0.02, 40, 0.03, 250], [1.47, 0.02, 0.03, 0.01, 100, 0.02, 300]]) {
    const r = nbody({ mstar: 1, rstar: 1, epoch: 0, planets: [{ per: 10, tmid: 1, ecc: e1, omega: w1, inc: 90, mplanet: m1 }, { per: 10 * ratio, tmid: 3, ecc: e2, omega: w2, inc: 90, mplanet: m2 }] }, { tEnd: 6000, event: 'conjunction' });
    const s1 = ttvSummary(r.transits[0].t), s2 = ttvSummary(r.transits[1].t);
    const lw = lithwickTTV({ mstar: 1, P1: s1.per, P2: s2.per, m1, m2, e1, e2, omega1: w1, omega2: w2 });
    const q1 = s1.periods[0].amp / lw.amp1, q2 = s2.periods[0].amp / lw.amp2, qp = s1.periods[0].periodDays / lw.superPeriod;
    worst = Math.max(worst, Math.abs(q1 - 1), Math.abs(q2 - 1), 10 * Math.abs(qp - 1));
    rows.push(`P2/P1 ${ratio}${e1 ? ' eccentric' : ''}: ${(s1.periods[0].amp * S).toFixed(0)}/${(lw.amp1 * S).toFixed(0)} s, ${(s2.periods[0].amp * S).toFixed(0)}/${(lw.amp2 * S).toFixed(0)} s, period ${s1.periods[0].periodDays.toFixed(1)}/${lw.superPeriod.toFixed(1)} d`);
  }
  check('near-resonant TTV: simulated amplitude vs Lithwick et al. within 15%, super-period within 1.5%', worst < 0.15, '\n       N-body/formula  ' + rows.join('\n                       '));
  {
    const r = nbody({ mstar: 1, epoch: 0, planets: [{ per: 3, tmid: 1, mplanet: 1 }, { per: 40.3, tmid: 3, mplanet: 0.01 }] }, { tEnd: 4000, event: 'conjunction' });
    const amp = ttvSummary(r.transits[1].t, { periodogram: false }).amplitude, an = agolTTV({ mstar: 1, m: 0.01, mp: 1, P: 40.3, Pp: 3 }).wobble;
    check('Agol et al. (2005): interior perturber moves the star, tolerance 3%', Math.abs(amp / an - 1) < 0.03, `N-body ${(amp * S).toFixed(1)} s, formula ${(an * S).toFixed(1)} s`);
    const r2 = nbody({ mstar: 1, epoch: 0, planets: [{ per: 4, tmid: 1, mplanet: 0.5 }, { per: 300, tmid: 61, ecc: 0.6, omega: 20, mplanet: 5 }] }, { tEnd: 3000, event: 'conjunction' });
    const a2 = ttvSummary(r2.transits[0].t, { periodogram: false }).amplitude, n2 = agolTTV({ mstar: 1, m: 0.5, mp: 5, P: 4, Pp: 300, ep: 0.6 }).tidal;
    const hj = ref.systems.hj_companion.system, r3 = nbody({ ...hj, planets: hj.planets.map((q) => ({ ...q, inc: 90, Omega: 0 })) }, { tEnd: hj.epoch + 1200, event: 'conjunction' });
    const a3 = ttvSummary(r3.transits[0].t, { periodogram: false }).amplitude, n3 = agolTTV({ mstar: 1.1, m: 1, mp: 8, P: 3.5, Pp: 120, ep: 0.4 }).tidal;
    check('Agol et al. (2005) eq. 25: distant eccentric perturber, tolerance 2% at P ratio 75 and 25% at ratio 34', Math.abs(a2 / n2 - 1) < 0.02 && Math.abs(a3 / n3 - 1) < 0.25, `ratio 75: ${(a2 * S).toFixed(2)} vs ${(n2 * S).toFixed(2)} s; ratio 34: ${(a3 * S).toFixed(2)} vs ${(n3 * S).toFixed(2)} s (the formula is the leading term in P/P')`);
  }
}

// =============================================================================================================
console.log('--- stability checks');
{
  let w = 0; for (const c of ref.amd) w = Math.max(w, Math.abs(amdCritical(c.alpha, c.gamma).Cc / c.Cc - 1));
  check('critical AMD (Laskar & Petit 2017) equals the brute-force minimum over the collision line (scipy), tolerance 1e-8', w < 1e-8, `${ref.amd.length} cases, max relative difference ${ex(w)}`);
  // Hill spacing: Gladman's limit is 2 sqrt(3) mutual Hill radii, in his variables Delta = 2.40 (mu1 + mu2)^(1/3) a
  const mu = 1e-4, hh = 1.2 * Math.cbrt(2 * mu), a2 = (1 + hh) / (1 - hh), st = stabilityReport({ mstar: 1, planets: [{ a: 1, tmid: 0, mplanet: mu / NB.Mjup }, { a: a2, tmid: 30, mplanet: mu / NB.Mjup }] });
  check('Hill spacing: a pair separated by Gladman\'s 2.40 (mu1+mu2)^(1/3) a is at 2√3 mutual Hill radii, tolerance 0.5%', Math.abs(st.pairs[0].deltaHill / (2 * Math.sqrt(3)) - 1) < 0.005, `${st.pairs[0].deltaHill.toFixed(3)} vs ${(2 * Math.sqrt(3)).toFixed(3)}`);
  const A = stabilityReport(ref.systems.exotic_example.system, { integrate: 1000 });
  const Bc = stabilityReport({ mstar: 1, planets: [{ per: 10, tmid: 0.7, mplanet: 1 }, { per: 12.3, tmid: 5.3, mplanet: 1 }] }, { integrate: 2000 });
  const Cc = stabilityReport({ mstar: 1, planets: [{ per: 10, tmid: 0.7, mplanet: 1, ecc: 0.3 }, { per: 14, tmid: 5.3, mplanet: 1, ecc: 0.3, omega: 180 }] }, { integrate: 500 });
  const Dc = stabilityReport(ref.systems.trappist1.system, { integrate: 300 });
  check('the example system is reported stable (Hill, AMD and 1000 outer orbits integrated)', A.stable === true && A.pairs[0].hillStable && A.amdStable && A.integration.ok && A.integration.chaotic === false, `Δ = ${A.pairs[0].deltaHill.toFixed(2)} Hill radii, AMD ${ex(A.pairs[0].amdBeta)} of critical, closest approach ${A.integration.minSepHill.toFixed(2)}, ${A.integration.seconds.toFixed(2)} s`);
  check('two Jupiters 1.6 Hill radii apart: flagged by the Hill criterion and by the integration (close encounter)', Bc.stable === false && !Bc.pairs[0].hillStable && !Bc.integration.ok, `Δ = ${Bc.pairs[0].deltaHill.toFixed(2)}; ${Bc.findings[0]}`);
  check('crossing eccentric orbits: flagged by AMD and orbit crossing', Cc.stable === false && Cc.pairs[0].crossing && !Cc.amdStable, `AMD ${Cc.pairs[0].amdBeta.toFixed(2)} times critical`);
  check('TRAPPIST-1: AMD-stable, tighter than Chambers\' 10 Hill radii, survives the integration', Dc.amdStable && Dc.chambers < 10 && Dc.integration.ok, `tightest pair ${Dc.chambers.toFixed(1)} Hill radii; verdict ${Dc.stable} (null: the criteria do not decide for a resonant chain)`);
  console.log('       example findings: ' + A.findings.join(' | '));
}

// =============================================================================================================
console.log('--- likelihood hook: dynamicalModel in place of the Keplerian timing and RV model of buildProblem');
{
  // outputs on both sides of the epoch: Wisdom-Holman against IAS15 (radial velocity and positions)
  {
    const r = ref.systems.near_3to2, sys = buildSystem(r.system), times = Array.from({ length: 60 }, (_, i) => 5 + 25.3 * i);
    const a = simulate(sys, { tStart: 0, tEnd: 1500, times, positions: true }), b = simulate(sys, { tStart: 0, tEnd: 1500, times, positions: true, integrator: 'ias15' });
    let dv = 0, dx = 0; for (let i = 0; i < 60; i++) dv = Math.max(dv, Math.abs(a.rv[i] - b.rv[i])); for (let q = 0; q < 3; q++) for (let i = 0; i < 180; i++) dx = Math.max(dx, Math.abs(a.samples.x[q][i] - b.samples.x[q][i]));
    check('radial velocity and positions at times before and after the epoch: Wisdom-Holman equals IAS15, tolerances 1e-4 m/s and 1e-4 stellar radii', dv < 1e-4 && dx < 1e-4, `${ex(dv)} m/s, ${ex(dx)} R* over 60 times from 695 d before to 800 d after the epoch`);
  }
  const values = { rprs: 0.1, ars: 12, inc: 88, per: 3.52474859, tmid: 0.4321, ecc: 0.12, omega: 70, mplanet: 0.9, mstar: 1.1, rstar: 1.2, rvlin: 0, rvquad: 0, 'jit@rv1': 0 };
  const tObs = [0.43, 7.48, 35.68, 352.9, 1410.33], rvT = Array.from({ length: 25 }, (_, i) => 3 + 17.3 * i);
  const spec = { data: null, values, ldLaw: 'quadratic', free: [{ key: 'per', prior: { type: 'uniform', a: 3.5, b: 3.6 } }], planets: [''], timing: [{ planet: '', kind: 'transit', t: tObs, e: tObs.map(() => 1e-3) }], rv: [{ t: rvT, v: rvT.map(() => 0), e: rvT.map(() => 1) }] };
  const det = buildProblem(spec).detail([values.per]);
  const sysP = { mstar: 1.1, rstar: 1.2, epoch: 0, planets: [{ per: values.per, tmid: values.tmid, ecc: values.ecc, omega: values.omega, inc: values.inc, mplanet: values.mplanet }] };
  const dyn = dynamicalModel(sysP, { timing: [{ planet: 0, t: tObs }], rv: [{ t: rvT }] });
  let dT = 0, dV = 0; tObs.forEach((_, i) => (dT = Math.max(dT, Math.abs(dyn.timing[0].model[i] - det.timing[0].model[i]) * S))); rvT.forEach((_, i) => (dV = Math.max(dV, Math.abs(dyn.rv[0][i] - det.rv[0].model[i]))));
  check('one planet: same timing model and RV model as buildProblem, tolerances 1e-5 s and 1e-6 m/s', dyn.ok && dT < 1e-5 && dV < 1e-6, `timing ${ex(dT)} s over ${(tObs[4] / values.per).toFixed(0)} orbits, RV ${ex(dV)} m/s`);
  // two planets with zero masses: still the Keplerian model; with masses: the timing changes and ok stays true
  const two = { mstar: 0.95, epoch: 0, planets: [{ per: 2.797436, tmid: 0.7, ecc: 0, omega: 0, inc: 90, mplanet: 0 }, { per: 5.3151, tmid: 1.3, ecc: 0, omega: 0, inc: 90, mplanet: 0 }] };
  const tt = Array.from({ length: 40 }, (_, i) => 0.7 + 2.797436 * 9 * i);
  const z = dynamicalModel(two, { timing: [{ planet: 0, t: tt }] });
  let dz = 0; tt.forEach((t, i) => (dz = Math.max(dz, Math.abs(z.timing[0].model[i] - t) * S)));
  const m = dynamicalModel({ ...two, planets: [{ ...two.planets[0], mplanet: 1.169 }, { ...two.planets[1], mplanet: 0.1 }] }, { timing: [{ planet: 0, t: tt }] });
  let dm = 0; tt.forEach((t, i) => (dm = Math.max(dm, Math.abs(m.timing[0].model[i] - t) * S)));
  check('two planets, zero masses: dynamical times equal tmid + E P, tolerance 1e-5 s; with masses they move', z.ok && dz < 1e-5 && m.ok && dm > 60, `${ex(dz)} s; with 1.169 and 0.1 M_Jup the times shift by up to ${dm.toFixed(0)} s over ${(tt[39] / 2.797436).toFixed(0)} orbits`);
  const bad = dynamicalModel({ mstar: 1, epoch: 0, planets: [{ per: 10, tmid: 0.7, mplanet: 3 }, { per: 11.5, tmid: 5.3, mplanet: 3 }] }, { timing: [{ planet: 0, t: Array.from({ length: 300 }, (_, i) => 0.7 + 10 * i) }] });
  check('an unstable configuration is refused (ok = false with a reason), not silently fitted', !bad.ok && bad.warnings.length > 0, `${bad.status}: ${bad.warnings[0] || 'transits missing'}`);
}

// =============================================================================================================
console.log('--- the synthetic example (public/examples/nbody)');
const exDir = new URL('../public/examples/nbody/', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('truth.json', exDir)));
const rowsCsv = readFileSync(new URL('transit_times.csv', exDir), 'utf8').trim().split(/\r?\n/);
const obsT = rowsCsv.slice(1).map((l) => +l.split(',')[0]), obsE = rowsCsv.slice(1).map((l) => +l.split(',')[1]);
let lin, pgAmp, pgPer;
{
  check('CSV has the columns tmid, err, source and errors of 30 to 90 s', rowsCsv[0] === 'tmid,err,source' && Math.min(...obsE) * S >= 30 && Math.max(...obsE) * S <= 90, `${obsT.length} times over ${(obsT[obsT.length - 1] - obsT[0]).toFixed(0)} d, errors ${(Math.min(...obsE) * S).toFixed(0)} to ${(Math.max(...obsE) * S).toFixed(0)} s`);
  // the truth file is reproduced by integrating its own parameters, and the noise is consistent with the errors
  const sim = nbody({ mstar: truth.star.mstar, rstar: truth.star.rstar, epoch: truth.epoch, planets: truth.planets }, { tEnd: truth.epoch + truth.integration.days, integrator: 'ias15' });
  let d = 0, chi = 0; truth.noiseless.epoch.forEach((E, i) => { d = Math.max(d, Math.abs(sim.transits[0].t[E] - truth.noiseless.tmid[i]) * S); chi += ((obsT[i] - sim.transits[0].t[E]) / obsE[i]) ** 2; });
  check('truth.json reproduces: noiseless times, tolerance 0.02 s (rounded to 1e-7 d); noise consistent with the errors', d < 0.02 && chi / obsT.length > 0.6 && chi / obsT.length < 1.5, `${ex(d)} s; chi2 of the data about the truth ${chi.toFixed(1)} for ${obsT.length}`);
  const sess = JSON.parse(readFileSync(new URL('session.json', exDir)));
  let sOk = true, lnL = NaN; try { validateSession(sess); const spec = specFromSession(sess), prob = buildProblem(spec); lnL = prob.loglike(spec.free.map((f) => 0.5 * (f.prior.a + f.prior.b))); sOk = spec.timing.length === 1 && spec.timing[0].t.length === obsT.length && Number.isFinite(lnL) && lnL > -1e99; } catch (err) { sOk = false; console.log('       ' + err.message); }
  check('session.json is a valid ESL session carrying the timing list (docs/FORMAT.md)', sOk, `${sess.data.timing.length} timing rows, linear-ephemeris lnL ${lnL.toFixed(1)}`);
  const { epochs } = assignEpochs(obsT, 2.7963, obsT[0]); lin = fitEphemeris(epochs, obsT, obsE, 1);
  const pg = timingPeriodogram(epochs, obsT, obsE), pk = pg.periodograms[0].peaks[0], term = pg.models[1].terms[0];
  pgAmp = term.amp; pgPer = term.periodDays;
  check('Timing-tab periodogram: one significant sinusoid at the super-period', pg.significant && pg.recommended === 1 && Math.abs(term.period / truth.ttv_b.super_period_epochs - 1) < 0.01 && pk.fap < 1e-10 && Math.abs(term.amp * S / truth.ttv_b.fitted_sinusoid_amplitude_s - 1) < 0.15,
    `period ${term.period.toFixed(2)} ± ${term.periodErr.toFixed(2)} epochs = ${term.periodDays.toFixed(2)} d (truth ${truth.ttv_b.super_period_epochs.toFixed(2)} epochs, ${truth.ttv_b.super_period_d.toFixed(2)} d), amplitude ${(term.amp * S).toFixed(0)} ± ${(term.ampErr * S).toFixed(0)} s (noiseless ${truth.ttv_b.fitted_sinusoid_amplitude_s.toFixed(0)} s), false-alarm probability ${ex(pk.fap)}, ΔBIC ${pg.deltaBic[1].toFixed(0)}, linear chi2 ${pg.models[0].chi2.toFixed(0)}/${pg.models[0].dof}`);
  console.log('       verdict: ' + pg.verdict);
  const lw = lithwickTTV({ mstar: truth.star.mstar, P1: truth.ttv_b.mean_period, P2: truth.ttv_c.mean_period, m1: truth.planets[0].mplanet, m2: truth.planets[1].mplanet });
  check('the example\'s TTV agrees with Lithwick et al. from the MEAN periods within 10% (a Jupiter-mass planet: the formula is first order)', Math.abs(lw.amp1 * S / truth.ttv_b.fitted_sinusoid_amplitude_s - 1) < 0.1 && Math.abs(lw.superPeriod / truth.ttv_b.super_period_d - 1) < 1e-6, `formula ${(lw.amp1 * S).toFixed(0)} s at ${lw.superPeriod.toFixed(2)} d; from the osculating periods at the epoch it would be ${truth.ttv_b.from_osculating_periods_at_epoch.lithwick_amplitude_s.toFixed(0)} s at ${truth.ttv_b.from_osculating_periods_at_epoch.super_period_d.toFixed(2)} d`);
}
let refined, gridInfo;
{
  // interpretation: grid over the perturber's mass and period, then polish the best cell
  const base = { mstar: truth.star.mstar, rstar: truth.star.rstar, planet: { per: lin.per, tmid: lin.t0, ecc: 0, omega: 0, inc: 86.9, mplanet: 1.169 }, perturber: { inc: 85 } };
  const mass = Array.from({ length: 12 }, (_, i) => 0.02 * Math.pow(0.5 / 0.02, i / 11)), periodRatio = Array.from({ length: 21 }, (_, i) => 1.61 + 0.03 * i);
  const g = ttvGrid({ t: obsT, e: obsE }, base, { mass, periodRatio }, { phases: 8, observed: { amp: pgAmp, period: pgPer } });
  refined = ttvGridRefine({ t: obsT, e: obsE }, base, g.best); gridInfo = g;
  let nMask = 0, maskOther = false, maskTrue = false; for (let im = 0; im < g.nm; im++) for (let ip = 0; ip < g.np; ip++) if (g.mask[im * g.np + ip]) { nMask++; if (periodRatio[ip] > 2) maskOther = true; else maskTrue = true; }
  check('grid of simulations: the best cell is next to the truth (mass within a factor 1.5, period within 1%)', g.best.mass / 0.1 < 1.5 && g.best.mass / 0.1 > 1 / 1.5 && Math.abs(g.best.period / truth.ttv_c.mean_period - 1) < 0.01,
    `best cell ${g.best.mass.toFixed(3)} M_Jup at ${g.best.period.toFixed(3)} d, chi2 ${g.best.chi2.toFixed(1)} (straight line: ${g.chi2Linear.toFixed(1)}, ${g.ndata} times); ${g.nSim} simulations of ${(obsT[obsT.length - 1] - obsT[0]).toFixed(0)} d in ${g.seconds.toFixed(1)} s = ${g.simsPerSecond.toFixed(0)} per second`);
  check('EXOTIC-style mask (amplitude and period of the periodogram peak only) keeps both sides of the resonance; the times themselves pick one', maskTrue && maskOther, `${nMask} of ${g.nm * g.np} cells match amplitude ±30% and super-period ±15%, on both sides of 2:1`);
  check('polished solution recovers the perturber: mass within 15%, mean period within 0.1%, chi2 per point below 1.4', Math.abs(refined.mass / 0.1 - 1) < 0.15 && Math.abs(refined.periodMean / truth.ttv_c.mean_period - 1) < 1e-3 && refined.chi2 / refined.ndata < 1.4,
    `${refined.mass.toFixed(4)} M_Jup (truth 0.1), mean period ${refined.periodMean.toFixed(4)} d (truth ${truth.ttv_c.mean_period.toFixed(4)}), chi2 ${refined.chi2.toFixed(1)} for ${refined.ndata} times, ${refined.nSim} more simulations`);
}
if (!process.env.NBODY_FAST) {
  // nested-sampling retrieval of the perturber around the polished solution, with a likelihood built here on
  // nbodyTimingProblem. Three free parameters: the perturber's mass, its (osculating) period and a conjunction time;
  // the transiting planet's T0 and period are profiled out (linear: true). Two choices make this tractable:
  //  * the conjunction time is quoted near the MIDDLE of the data (tmid need not be near the epoch), so that it is
  //    nearly uncorrelated with the period;
  //  * the prior on the period is +-0.004 d: the likelihood has alias modes every 0.013 d (one super-period cycle
  //    more or less over the span), each about 0.001 d wide. Find the mode with the grid first.
  // A first attempt with five free parameters (T0 and P of b sampled, conjunction time at the epoch, period +-0.03 d)
  // did not converge in 60000 simulations (197 s) and sat on an alias at 0.066 M_Jup.
  const P = lin.per, e0 = Math.round((obsT[0] - lin.t0) / P), epoch = lin.t0 + e0 * P - 0.5 * P, kMid = Math.round((0.5 * (obsT[obsT.length - 1] - obsT[0])) / refined.period);
  const tmidC = epoch + refined.phase * refined.period + kMid * refined.period;
  const system = { mstar: truth.star.mstar, rstar: truth.star.rstar, epoch, planets: [{ per: refined.planet.per, tmid: lin.t0 + e0 * P, ecc: 0, omega: 0, inc: 86.9, mplanet: 1.169 }, { per: refined.period, tmid: tmidC, ecc: 0, omega: 0, inc: 85, mplanet: refined.mass }] };
  const prob = nbodyTimingProblem({ system, timing: [{ planet: 0, t: obsT, e: obsE }], linear: true, sim: { stepsPerOrbit: 20, exactSync: false },
    free: [{ key: 'mplanet@1', prior: { type: 'uniform', a: 0.03, b: 0.25 } }, { key: 'per@1', prior: { type: 'uniform', a: refined.period - 0.004, b: refined.period + 0.004 } }, { key: 'tmid@1', prior: { type: 'uniform', a: tmidC - 0.3, b: tmidC + 0.3 } }] });
  const t0 = performance.now(), ns = new MiniNest({ ndim: prob.ndim, loglike: prob.loglike, transform: prob.transform, nlive: 200, fracRemain: 0.05, seed: 3, maxCalls: 40000, names: prob.keys });
  while (!ns.done) ns.step(25);
  const res = ns.result(), d = prob.ndim, w = res.weights, col = (j) => { let m = 0, s = 0, sw = 0; for (let i = 0; i < w.length; i++) { m += w[i] * res.samples[i * d + j]; sw += w[i]; } m /= sw; for (let i = 0; i < w.length; i++) s += w[i] * (res.samples[i * d + j] - m) ** 2; return [m, Math.sqrt(s / sw)]; };
  const [mm, ms] = col(0), [pm, ps] = col(1), sec = (performance.now() - t0) / 1000;
  check('nested-sampling retrieval (MiniNest on nbodyTimingProblem): perturber mass within 3 sigma of the truth', Math.abs(mm - 0.1) < 3 * ms && ms < 0.05, `${res.converged === false ? 'NOT CONVERGED (' + res.stopReason + '); ' : ''}mass ${mm.toFixed(4)} ± ${ms.toFixed(4)} M_Jup, osculating period ${pm.toFixed(4)} ± ${ps.toFixed(4)} d, lnZ ${res.logZ.toFixed(1)}, ${res.ncalls} simulations in ${sec.toFixed(0)} s (${(res.ncalls / sec).toFixed(0)} per second)`);
} else console.log('skip  nested-sampling retrieval (NBODY_FAST is set)');

// =============================================================================================================
console.log('--- speed (this machine, one thread)');
{
  const sysP = { mstar: 0.95, rstar: 0.877, epoch: 0, planets: [{ per: 2.797436, tmid: 0.7, mplanet: 1.169, inc: 90 }, { per: 2.797436 * 1.9, tmid: 1.3, mplanet: 0.1, inc: 90 }] }, T = 100 * 2.797436;
  const a = best(() => nbody(sysP, { tEnd: T }), 20), b = best(() => nbody(sysP, { tEnd: T, stepsPerOrbit: 20, exactSync: false }), 20), c = best(() => nbody(sysP, { tEnd: T, integrator: 'ias15' }), 10);
  console.log(`info  two planets, 100 orbits of the inner one, transit times of both: ${(1000 / a.ms).toFixed(0)} simulations/s with the defaults (P/30, corrector 5, exact synchronisation; ${a.ms.toFixed(2)} ms), ${(1000 / b.ms).toFixed(0)}/s with the grid settings (P/20, no re-synchronisation; ${b.ms.toFixed(2)} ms), ${(1000 / c.ms).toFixed(0)}/s with IAS15 (${c.ms.toFixed(1)} ms)`);
  for (const [name, s] of Object.entries(speed)) console.log(`info  ${name}: pure stepping, ${s.steps} Wisdom-Holman steps ${s.wh.toFixed(2)} ms here vs ${s.whC.toFixed(2)} ms in REBOUND's C (${(s.wh / s.whC).toFixed(1)}x slower); IAS15 ${s.ias.toFixed(1)} ms (${s.iasSteps} steps) vs ${s.iasC.toFixed(1)} ms (${s.iasStepsC} steps) (${(s.ias / s.iasC).toFixed(1)}x)`);
  check('at least 300 simulations per second for two planets over 100 orbits (defaults)', 1000 / a.ms > 300, `${(1000 / a.ms).toFixed(0)}/s`);
  void gridInfo; void defaultStep; void nearestFirstOrder;
}

console.log(ok ? '\nnbody: all checks passed' : '\nnbody: FAILURES');
process.exit(ok ? 0 : 1);
