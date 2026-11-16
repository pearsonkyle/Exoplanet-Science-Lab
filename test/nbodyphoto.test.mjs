// Photodynamics, mid-eclipse times, MEGNO and mean-ephemeris elements of src/core/nbody.js, against
//   REBOUND 5.2.2 IAS15 positions pushed through batman's quadratic limb-darkening kernel, REBOUND's event times and
//   its MEGNO (test/nbodyphoto_reference.json, written by test/make_nbodyphoto_reference.py), and the Keplerian model
//   of transit.js / kepler.js in the limit of massless planets. Every tolerance is stated where it is used.
//   About 25 s. NBODY_FIT=1 adds the nested-sampling fit with the transiting planet's own period and T0 free (about 7 minutes).
import { readFileSync } from 'node:fs';
import { nbody, dynamicalModel, megno, stabilityReport, osculatingFromMean, AU_LIGHT_DAYS } from '../src/core/nbody.js';
import { buildProblem } from '../src/core/model.js';
import { specFromSession } from '../src/core/session.js';
import { blockedFraction } from '../src/core/transit.js';
import { prepareLD, toClaret } from '../src/core/limbdark.js';
import { orbitElements, eclipseTime } from '../src/core/kepler.js';
import { MiniNest } from '../src/core/nested.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./nbodyphoto_reference.json', import.meta.url)));
const S = 86400, ex = (v, d = 1) => v.toExponential(d), ppm = (v) => (v * 1e6 < 0.1 ? (v * 1e6).toExponential(1) : (v * 1e6).toFixed(v * 1e6 < 10 ? 2 : 1));
const best = (f, n = 15) => { let b = Infinity, r; for (let i = 0; i < n; i++) { const t0 = performance.now(); r = f(); b = Math.min(b, performance.now() - t0); } return { ms: b, r }; };
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// the strongly perturbed pair of the reference as a fit specification
const st = ref.strong, sys = st.system, tS = Float64Array.from(st.t), NS = tS.length;
const strongValues = { mstar: sys.mstar, rstar: sys.rstar, ld0: st.ld_quadratic[0], ld1: st.ld_quadratic[1] };
sys.planets.forEach((p, i) => { const s = i ? '@c' : ''; for (const k of ['per', 'tmid', 'ecc', 'omega', 'inc', 'mplanet']) strongValues[k + s] = p[k]; strongValues['rprs' + s] = st.rprs[i]; });
const lcSpec = (t, extra = {}) => ({ data: { t, f: new Float64Array(t.length).fill(1), e: new Float64Array(t.length).fill(1e-4) }, values: strongValues, ldLaw: 'quadratic', free: [], planets: ['', 'c'], kepler: true, ...extra });

// =============================================================================================================
console.log('--- photodynamics: the Keplerian limit');
{
  // two eccentric, inclined planets with zero mass: the positions from the integration must give the light curve of transit.js
  const values = { rprs: 0.1, inc: 88, per: 3.52474859, tmid: 0.4321, ecc: 0.12, omega: 70, mplanet: 0, 'rprs@c': 0.05, 'inc@c': 89, 'per@c': 7.9, 'tmid@c': 2.2, 'ecc@c': 0.2, 'omega@c': -40, 'mplanet@c': 0, mstar: 1.1, rstar: 1.2, ld0: 0.4, ld1: 0.2 };
  const N = 2000, t = Float64Array.from({ length: N }, (_, i) => (i * 27) / N), base = { data: { t, f: new Float64Array(N).fill(1), e: new Float64Array(N).fill(1e-3) }, values, ldLaw: 'quadratic', free: [], planets: ['', 'c'], kepler: true };
  const k = buildProblem(base).detail([]); let depth = 0; for (const m of k.model) depth = Math.max(depth, 1 - m);
  const d150 = buildProblem({ ...base, nbody: { epoch: 0 } }).detail([]), d600 = buildProblem({ ...base, nbody: { epoch: 0, nodesPerOrbit: 600 } }).detail([]), dI = buildProblem({ ...base, nbody: { epoch: 0, integrator: 'ias15', nodesPerOrbit: 600 } }).detail([]);
  const a = maxDiff(k.model, d150.model), b = maxDiff(k.model, d600.model), c = maxDiff(k.model, dI.model);
  check('massless planets: photodynamical light curve = Keplerian light curve, tolerances 2e-9 (150 nodes per orbit) and 2e-11 (600)', d150.nbody.photo && a < 2e-9 && b < 2e-11 && c < 2e-11, `largest difference ${ex(a)} of the flux with the default 150 nodes per orbit (the cubic interpolation), ${ex(b)} with 600, ${ex(c)} with IAS15; 2000 points over 27 d, two eccentric planets, deepest ${(depth * 1e6).toFixed(0)} ppm`);
  // the integration runs backward from the epoch as well: epoch in the middle of the data, and after its end
  const dm = buildProblem({ ...base, nbody: { epoch: 13.5 } }).detail([]), da = buildProblem({ ...base, nbody: { epoch: 40, integrator: 'ias15' } }).detail([]);
  const vm = { ...values, mplanet: 1, 'mplanet@c': 2, 'per@c': 7.2 }, wm = buildProblem({ ...base, values: vm, nbody: { epoch: 13.5, stepsPerOrbit: 200 } }).detail([]), im = buildProblem({ ...base, values: vm, nbody: { epoch: 13.5, integrator: 'ias15' } }).detail([]);
  check('reference epoch inside or after the data (backward integration): same limit, tolerance 2e-9; with masses the two integrators agree to 0.05 ppm', maxDiff(dm.model, k.model) < 2e-9 && maxDiff(da.model, k.model) < 2e-9 && maxDiff(wm.model, im.model) < 5e-8 && maxDiff(im.model, k.model) > 1e-3,
    `${ex(maxDiff(dm.model, k.model))} (epoch mid-data), ${ex(maxDiff(da.model, k.model))} (epoch after the data, IAS15); 1 and 2 M_Jup at 3.5 and 7.2 d, epoch mid-data: Wisdom-Holman at 200 steps per orbit against IAS15 ${ppm(maxDiff(wm.model, im.model))} ppm (the curve differs from the Keplerian one by ${ppm(maxDiff(im.model, k.model))} ppm)`);
  // the same through the exposure averaging, one light curve and two epochs with their own exposures
  const ke = buildProblem({ ...base, exptime: 0.02, supersample: 7 }).detail([]), de = buildProblem({ ...base, exptime: 0.02, supersample: 7, nbody: { epoch: 0 } }).detail([]);
  const epoch = Int32Array.from({ length: N }, (_, i) => (i < N / 2 ? 0 : 1)), segs = [{ exptime: 0.004, supersample: 3 }, { exptime: 0.03, supersample: 11 }], dataE = { ...base.data, epoch, segments: segs };
  const k2 = buildProblem({ ...base, data: dataE }).detail([]), d2 = buildProblem({ ...base, data: dataE, nbody: { epoch: 0 } }).detail([]);
  const ae = maxDiff(ke.model, de.model), a2 = maxDiff(k2.model, d2.model);
  check('massless planets, exposure averaging (29 min in 7 sub-samples; two epochs with 6 and 43 min): same as Keplerian, tolerance 2e-9', ae < 2e-9 && a2 < 2e-9 && maxDiff(ke.model, k.model) > 1e-5, `${ex(ae)} and ${ex(a2)}; the averaging itself changes the curve by ${ppm(maxDiff(ke.model, k.model))} ppm`);
  // without spec.kepler the stellar radius follows from the first planet's a/R*
  const ars = k.planets.map((q) => q.ars), noK = { ...base, kepler: false, values: { ...values, rstar: undefined, ars: ars[0], 'ars@c': ars[1] } };
  const dk = buildProblem({ ...noK, nbody: { epoch: 0 } }).detail([]);
  check('without spec.kepler: R* from the first planet\'s a/R* gives the same light curve, tolerance 2e-9', dk && maxDiff(dk.model, k.model) < 2e-9, `${ex(maxDiff(dk.model, k.model))}`);
  const off = buildProblem({ ...base, values: { ...values, mplanet: 2, 'mplanet@c': 2 }, nbody: { epoch: 0, photo: false } }).detail([]), kOn = buildProblem({ ...base, values: { ...values, mplanet: 2, 'mplanet@c': 2 } }).detail([]);
  check('nbody.photo: false keeps the Keplerian light curve', !off.nbody && maxDiff(off.model, kOn.model) === 0, 'identical');
}

// =============================================================================================================
console.log('--- photodynamics: a strongly perturbed pair against REBOUND + batman');
{
  const ld = prepareLD(toClaret('quadratic', st.ld_quadratic));
  // the kernels alone: transit.js against batman on REBOUND's separations
  let kd = 0; for (let p = 0; p < 2; p++) for (let i = 0; i < NS; i++) kd = Math.max(kd, Math.abs(1 - blockedFraction(st.d[p][i], st.rprs[p], ld) - st.flux_planet[p][i]));
  check('transit kernel of transit.js = batman\'s quadratic kernel on the same separations, tolerance 0.05 ppm', kd < 5e-8, `largest difference ${ppm(kd)} ppm over ${NS} points`);
  const kep = buildProblem(lcSpec(tS)).detail([]), dKep = maxDiff(kep.model, st.flux);
  const run = (nb) => buildProblem(lcSpec(tS, { nbody: { epoch: sys.epoch, ...nb } })).detail([]);
  const ias = run({ integrator: 'ias15' }), wh = run({}), wh60 = run({ stepsPerOrbit: 60 }), whFast = run({ stepsPerOrbit: 20, exactSync: false });
  const dI = maxDiff(ias.model, st.flux), dW = maxDiff(wh.model, st.flux), dW60 = maxDiff(wh60.model, st.flux), dF = maxDiff(whFast.model, st.flux);
  let deep = 0; for (const f of st.flux) deep = Math.max(deep, 1 - f);
  check('how strongly perturbed: the Keplerian light curve of the same elements is wrong by more than 5000 ppm', dKep > 5e-3, `largest difference ${ppm(dKep)} ppm (transits ${(deep * 1e6).toFixed(0)} ppm deep, 1 and 2 M_Jup at 10 and 20.3 d, ${NS} points over ${st.span} d, ${st.transits[0].length} + ${st.transits[1].length} transits)`);
  check('photodynamical light curve (IAS15) = REBOUND IAS15 positions through batman, tolerance 0.05 ppm', dI < 5e-8, `largest difference ${ppm(dI)} ppm`);
  // the Wisdom-Holman map: the difference is its timing error (a phase error that grows with time), not the interpolation
  const simW = nbody(sys, { tEnd: st.span, event: 'conjunction' }); let tW = 0; for (let p = 0; p < 2; p++) st.transits[p].forEach((x, i) => (tW = Math.max(tW, Math.abs(x - simW.transits[p].t[i]) * S)));
  check('photodynamical light curve (Wisdom-Holman, defaults) against the same, tolerance 100 ppm; 60 steps per orbit 25 ppm', dW < 1e-4 && dW60 < 2.5e-5 && dW60 < dW / 3, `largest difference ${ppm(dW)} ppm at 30 steps per orbit, ${ppm(dW60)} ppm at 60, ${ppm(dF)} ppm at the grid settings (20 steps, no re-synchronisation): the map's transit times are off by up to ${tW.toFixed(1)} s here, and ${tW.toFixed(1)} s of ingress is that much flux`);
  // exposure averaging against an independent average of 15 sub-exposures in the reference
  const E = st.exposure, tE = Float64Array.from(E.t), de = buildProblem(lcSpec(tE, { exptime: E.exptime, supersample: E.nsub, nbody: { epoch: sys.epoch, integrator: 'ias15' } })).detail([]);
  const inst = buildProblem(lcSpec(tE, { nbody: { epoch: sys.epoch, integrator: 'ias15' } })).detail([]);
  check('30-minute exposures (15 sub-samples) = the reference averaged the same way, tolerance 0.05 ppm', maxDiff(de.model, E.flux) < 5e-8, `largest difference ${ppm(maxDiff(de.model, E.flux))} ppm over ${tE.length} points (the averaging changes the curve by ${ppm(maxDiff(inst.model, de.model))} ppm)`);
  // light-travel time: each body where it was when the light left it
  const lt = run({ integrator: 'ias15', ltt: true }), dL = maxDiff(lt.model, st.flux_ltt), eff = maxDiff(st.flux, st.flux_ltt);
  check('light-travel time: photodynamical light curve = REBOUND with each body at its retarded time, tolerance 0.05 ppm', dL < 5e-8 && eff > 1e-4, `largest difference ${ppm(dL)} ppm; the effect itself is ${ppm(eff)} ppm (transits arrive ${(st.transit_zbary[0][0] * AU_LIGHT_DAYS * S).toFixed(1)} and ${(st.transit_zbary[1][0] * AU_LIGHT_DAYS * S).toFixed(1)} s early)`);
  // sparse data: nodes only where there are data
  const sparse = Float64Array.from([...Array.from({ length: 300 }, (_, i) => 1.0 + i * 0.002), ...Array.from({ length: 300 }, (_, i) => 101.0 + i * 0.002)]);
  const dynS = dynamicalModel(sys, { lc: { t: sparse } }), dynD = dynamicalModel(sys, { lc: { t: tS } });
  const o1 = [0, 0, 0], o2 = [0, 0, 0]; let dp = 0; for (const t of sparse) { dynS.photo.position(0, t, o1); dynD.photo.position(0, t, o2); dp = Math.max(dp, Math.hypot(o1[0] - o2[0], o1[1] - o2[1])); }
  check('position tracks cover only the data: two nights 100 d apart use two short runs of nodes', dynS.photo.clusters.length === 2 && dynS.photo.nodes < 40 && dp < 1e-6, `${dynS.photo.nodes} nodes in ${dynS.photo.clusters.length} runs (${dynD.photo.nodes} for the ${NS}-point curve), positions equal to the other track's to ${ex(dp)} R*`);
}

// =============================================================================================================
console.log('--- mid-eclipse times from the integration');
{
  // massless: superior conjunction of kepler.js
  let worst = 0; const rows = [];
  for (const [e, w, inc, per] of [[0, 0, 90, 3.3], [0.3, 40, 88, 3.3], [0.93132, -58.699, 89.269, 111.4367]]) {
    const p = { per, tmid: 1.234, ecc: e, omega: w, inc, mplanet: 0 }, el = orbitElements({ ...p, ars: 10 }), te = eclipseTime(el);
    const r = nbody({ mstar: 1.05, rstar: 1.05, epoch: 0, planets: [p] }, { tEnd: 40 * per, event: 'conjunction', eclipses: true }), ec = r.eclipses[0];
    let mx = 0; for (let i = 0; i < ec.n; i++) { const k = Math.round((ec.t[i] - te) / per); mx = Math.max(mx, Math.abs(ec.t[i] - te - k * per)); if (!(ec.z[i] < 0)) mx = Infinity; }
    worst = Math.max(worst, mx * S); rows.push(`e=${e}: ${ec.n} eclipses ${ex(mx * S)} s`);
  }
  check('massless planet: mid-eclipse times equal the superior conjunction of kepler.js + k P, tolerance 1e-4 s', worst < 1e-4, rows.join('; '));
  // against REBOUND: both definitions, both integrators
  const res = {};
  for (const [event, key] of [['conjunction', 'eclipses'], ['minsep', 'eclipses_minsep']]) for (const integrator of ['ias15', 'wh']) {
    const r = nbody(sys, { tEnd: st.span, event, eclipses: true, integrator }); let mx = 0, same = true;
    for (let p = 0; p < 2; p++) { if (r.eclipses[p].n !== st[key][p].length) same = false; st[key][p].forEach((x, i) => (mx = Math.max(mx, Math.abs(x - r.eclipses[p].t[i]) * S))); }
    res[event + integrator] = { mx, same, n: r.eclipses[0].n + r.eclipses[1].n };
  }
  const hd = ref.hd80606, rh = nbody(hd.system, { tEnd: 600, event: 'conjunction', eclipses: true, integrator: 'ias15' }); let mh = 0; hd.eclipses.forEach((x, i) => (mh = Math.max(mh, Math.abs(x - rh.eclipses[0].t[i]) * S)));
  check('mid-eclipse times of the perturbed pair = REBOUND IAS15 (bisection), tolerance 1e-3 s with IAS15 and 15 s with the map', res.conjunctionias15.same && res.minsepias15.same && res.conjunctionias15.mx < 1e-3 && res.minsepias15.mx < 1e-3 && res.conjunctionwh.mx < 15 && res.minsepwh.mx < 15 && rh.eclipses[0].n === hd.eclipses.length && mh < 2e-3,
    `${res.conjunctionias15.n} eclipses: ${ex(res.conjunctionias15.mx)} s (conjunction), ${ex(res.minsepias15.mx)} s (closest approach) with IAS15; ${res.conjunctionwh.mx.toFixed(1)} and ${res.minsepwh.mx.toFixed(1)} s with Wisdom-Holman at its defaults (its transit times: see above); a 4.1 M_Jup HD 80606 b, ${hd.eclipses.length} eclipses, ${ex(mh)} s`);
  // through the likelihood: a timing set of kind 'eclipse' is compared with the integration, and with zero masses it is the Keplerian model
  const obs = st.eclipses[1].map((x) => x + 2e-4), spec = { data: null, values: strongValues, ldLaw: 'quadratic', free: [], planets: ['', 'c'], kepler: true, timing: [{ planet: 'c', kind: 'eclipse', t: obs, e: obs.map(() => 1e-4) }, { planet: '', kind: 'transit', t: st.transits[0], e: st.transits[0].map(() => 1e-4) }] };
  const d = buildProblem({ ...spec, nbody: { epoch: 0, integrator: 'ias15' } }).detail([]), kp = buildProblem(spec).detail([]);
  const z0 = { ...strongValues, mplanet: 0, 'mplanet@c': 0 }, dz = buildProblem({ ...spec, values: z0, nbody: { epoch: 0 } }).detail([]), kz = buildProblem({ ...spec, values: z0 }).detail([]);
  check('likelihood: eclipse times from the integration (chi2 = the 2e-4 d offset put in), Keplerian with zero masses', Math.abs(d.chi2 - 4 * obs.length) < 0.05 && kp.chi2 > 1e4 && Math.abs(dz.chi2 - kz.chi2) < 1e-3 * kz.chi2 && maxDiff(dz.timing[0].model, kz.timing[0].model) * S < 1e-4,
    `chi2 ${d.chi2.toFixed(3)} for ${obs.length} eclipses of c offset by 2 sigma and ${st.transits[0].length} transits of b (expected ${4 * obs.length}; the Keplerian model gives ${kp.chi2.toExponential(1)}); zero masses: eclipse model equal to Keplerian to ${ex(maxDiff(dz.timing[0].model, kz.timing[0].model) * S)} s`);
  // light-travel time on the event times: transit early by Z/c, eclipse late
  const a = dynamicalModel(sys, { integrator: 'ias15', timing: [{ planet: 0, t: st.transits[0] }, { planet: 0, t: st.eclipses[0], kind: 'eclipse' }] }), b = dynamicalModel(sys, { integrator: 'ias15', ltt: true, timing: [{ planet: 0, t: st.transits[0] }, { planet: 0, t: st.eclipses[0], kind: 'eclipse' }] });
  let dt = 0, de = 0; st.transits[0].forEach((_, i) => (dt = Math.max(dt, Math.abs(b.timing[0].model[i] - a.timing[0].model[i] + st.transit_zbary[0][i] * AU_LIGHT_DAYS) * S))); st.eclipses[0].forEach((_, i) => (de = Math.max(de, Math.abs(b.timing[1].model[i] - a.timing[1].model[i] + st.eclipse_zbary[0][i] * AU_LIGHT_DAYS) * S)));
  // and the centre of the photodynamical transit with light-travel time is that shifted time
  const T0 = b.timing[0].model[3], tt = Float64Array.from({ length: 241 }, (_, i) => T0 + (i - 120) * 0.0015), ph = dynamicalModel(sys, { integrator: 'ias15', ltt: true, lc: { t: tt } }), o = [0, 0, 0];
  let lo = T0 - 0.01, hi = T0 + 0.01; for (let it = 0; it < 50; it++) { const m = 0.5 * (lo + hi); ph.photo.position(0, m, o); if (o[0] < 0) lo = m; else hi = m; }
  check('light-travel time on event times: shift = -Z/c of REBOUND\'s barycentric Z to 0.3% (the star\'s own delay, m_p/M* of the shift); light curve and timing agree to 0.01 s', dt < 0.15 && de < 0.15 && Math.abs(0.5 * (lo + hi) - T0) * S < 0.01,
    `transits ${((b.timing[0].model[0] - a.timing[0].model[0]) * S).toFixed(2)} s, eclipses +${((b.timing[1].model[0] - a.timing[1].model[0]) * S).toFixed(2)} s; the planet's -Z/c alone is ${ex(dt)} and ${ex(de)} s from that; conjunction on the retarded track (which REBOUND confirms above) ${ex(Math.abs(0.5 * (lo + hi) - T0) * S)} s from the timing model`);
}

// =============================================================================================================
console.log('--- MEGNO');
{
  const M = ref.megno;
  const one = [1, 2, 3].map((seed) => megno({ mstar: 1, planets: [{ per: 10, tmid: 0.7, mplanet: 1, ecc: 0.2, omega: 30 }] }, { orbits: 3000, seed }).megno);
  check('one planet (a Kepler orbit, where nearby orbits separate linearly): MEGNO = 2, tolerance 0.02', one.every((v) => Math.abs(v - 2) < 0.02), `${one.map((v) => v.toFixed(4)).join(', ')} for three initial displacements after 3000 orbits`);
  const reg = [1, 2, 3].map((seed) => megno(M.regular.system, { orbits: M.regular.orbits, seed })), str = [1, 2, 3].map((seed) => megno(M.strong.system, { orbits: M.strong.orbits, seed }));
  check('regular pairs: MEGNO = 2 as REBOUND finds, tolerance 0.03 (the example system) and 0.06 (the strongly perturbed pair)', reg.every((r) => r.ok && !r.chaotic && Math.abs(r.megno - 2) < 0.03) && str.every((r) => r.ok && !r.chaotic && Math.abs(r.megno - 2) < 0.06) && Math.abs(M.regular.ias15.megno - 2) < 0.03 && Math.abs(M.strong.seed2.megno - 2) < 0.06,
    `example system, ${M.regular.orbits} outer orbits: ${reg.map((r) => r.megno.toFixed(4)).join(', ')} (three displacements; REBOUND IAS15 ${M.regular.ias15.megno.toFixed(4)}, ${M.regular.seed2.megno.toFixed(4)}, WHFast ${M.regular.whfast.megno.toFixed(4)}); 1 + 2 M_Jup near 2:1, ${M.strong.orbits} orbits: ${str.map((r) => r.megno.toFixed(4)).join(', ')} (REBOUND ${M.strong.ias15.megno.toFixed(4)}, ${M.strong.seed2.megno.toFixed(4)}); ${reg[0].seconds.toFixed(2)} s each`);
  const ch = [1, 2].map((seed) => megno(M.chaotic.system, { orbits: M.chaotic.orbits, seed })), full = megno(M.chaotic.system, { orbits: M.chaotic.orbits, seed: 2, stopAbove: 0 });
  check('two Jupiters 1.6 Hill radii apart: MEGNO grows without bound, as in REBOUND; stopped once it passes 20', ch.every((r) => r.chaotic && r.stopped && r.megno > 20 && r.orbits < 1000) && full.megno > 50 && M.chaotic.ias15.megno > 50,
    `passes 20 after ${ch.map((r) => r.orbits.toFixed(0)).join(' and ')} outer orbits (${ch[0].seconds.toFixed(2)} s); run to ${full.orbits.toFixed(0)} orbits: ${full.megno.toFixed(0)} (${full.status}), Lyapunov time ${full.lyapunovTime.toFixed(0)} d; REBOUND: ${M.chaotic.ias15.megno.toFixed(0)} and ${M.chaotic.seed2.megno.toFixed(0)} for two displacements, Lyapunov times ${(1 / M.chaotic.ias15.lyapunov).toFixed(0)} and ${(1 / M.chaotic.seed2.lyapunov).toFixed(0)} d (a chaotic orbit has no reproducible value)`);
  const A = stabilityReport(M.regular.system, { integrate: 500 }), B = stabilityReport(M.chaotic.system, { integrate: 500 }), C = stabilityReport(M.regular.system, { integrate: 100, megno: false });
  check('stabilityReport carries MEGNO into its findings', A.integration.chaotic === false && Math.abs(A.integration.megno - 2) < 0.05 && A.findings.some((f) => f.startsWith('MEGNO 2.0')) && B.integration.chaotic === true && B.stable === false && B.findings.some((f) => f.startsWith('MEGNO passed')) && C.integration.megno === null,
    `"${A.findings.find((f) => f.startsWith('MEGNO'))}" | "${B.findings.find((f) => f.startsWith('MEGNO'))}"`);
}

// =============================================================================================================
console.log('--- mean-ephemeris elements (nbody.elements: \'mean\')');
{
  const dir = new URL('../public/examples/nbody/', import.meta.url), s = JSON.parse(readFileSync(new URL('session.json', dir))), truth = JSON.parse(readFileSync(new URL('truth.json', dir)));
  const spec = specFromSession(s), tRef = s.time_reference, obs = spec.timing[0];
  const [b, c] = truth.planets, vals = { ...spec.values };
  for (const f of ['per', 'tmid', 'ecc', 'omega', 'inc', 'mplanet', 'rprs']) { vals[f] = f === 'tmid' ? b[f] - tRef : b[f]; vals[f + '@c'] = f === 'tmid' ? c[f] - tRef : c[f]; }
  const epoch = truth.epoch - tRef, simOpt = { stepsPerOrbit: 20, exactSync: false }, two = { ...spec, planets: ['', 'c'], values: vals, free: [] };
  const lo = Math.min(...obs.t), hi = Math.max(...obs.t), osys = { mstar: vals.mstar, rstar: vals.rstar, epoch, planets: [b, c].map((p) => ({ ...p, tmid: p.tmid - tRef })) };
  // the straight lines through the true system's simulated transits over the span of the data
  const sim = nbody(osys, { tEnd: hi + 4, event: 'conjunction', ...simOpt });
  const line = (tr, P, kRef) => { let n = 0, sE = 0, sEE = 0, sT = 0, sET = 0; for (let k = 0; k < tr.n; k++) { const t = tr.t[k]; if (t < lo - 0.5 * P || t > hi + 0.5 * P) continue; const E = k - kRef; n++; sE += E; sEE += E * E; sT += t; sET += E * t; } const det = n * sEE - sE * sE; return { T: (sEE * sT - sE * sET) / det, P: (n * sET - sE * sT) / det }; };
  const mb = line(sim.transits[0], b.per, 0), mc = line(sim.transits[1], c.per, 100);
  const msys = { ...osys, planets: [{ ...osys.planets[0], per: mb.P, tmid: mb.T }, { ...osys.planets[1], per: mc.P, tmid: mc.T }] };
  const trace = [], r = osculatingFromMean(msys, { tStart: epoch, tEnd: hi + 4, lo, hi, trace, ...simOpt });
  const dP = Math.max(Math.abs(r.osculating[0].per - b.per), Math.abs(r.osculating[1].per - c.per)), dT = Math.max(Math.abs(r.osculating[0].tmid - osys.planets[0].tmid), Math.abs(r.osculating[1].tmid - 100 * r.osculating[1].per - osys.planets[1].tmid));
  check('mean ephemeris -> osculating elements: recovers the elements the lines came from, tolerances 1e-9 d (period) and 0.05 s (phase)', r.ok && dP < 1e-9 && dT * S < 0.05, `${r.iterations} simulations, residual of the line ${trace.map((x) => ex(x * S, 0)).join(' → ')} s; periods to ${ex(dP)} d (mean ${mb.P.toFixed(6)} and ${mc.P.toFixed(6)} d against osculating ${b.per} and ${c.per.toFixed(6)} d), phases to ${ex(dT * S)} s`);
  const mv = { ...vals, per: mb.P, tmid: mb.T, 'per@c': mc.P, 'tmid@c': mc.T };
  const pOsc = buildProblem({ ...two, nbody: { epoch, ...simOpt } }), pMean = buildProblem({ ...two, values: mv, nbody: { epoch, elements: 'mean', ...simOpt } });
  const cO = pOsc.detail([]), cM = pMean.detail([]);
  check('the same system given either way has the same chi2, tolerance 0.01', Math.abs(cO.chi2 - cM.chi2) < 0.01 && cM.nbody.osculating.length === 2, `${cM.chi2.toFixed(4)} (mean elements, ${cM.nbody.iterations} simulations) against ${cO.chi2.toFixed(4)} (osculating)`);
  // why: change the companion and leave the transiting planet's own period and T0 alone
  const rows = []; let worstM = 0, bestO = Infinity;
  for (const [what, dv] of [['mass +20%', { 'mplanet@c': 1.2 * c.mplanet }], ['mass -20%', { 'mplanet@c': 0.8 * c.mplanet }]]) {
    const o = buildProblem({ ...two, values: { ...vals, ...dv }, nbody: { epoch, ...simOpt } }).detail([]), m = buildProblem({ ...two, values: { ...mv, ...dv }, nbody: { epoch, elements: 'mean', ...simOpt } }).detail([]);
    rows.push(`${what}: chi2 ${m.chi2.toFixed(0)} with mean elements, ${o.chi2.toFixed(0)} with osculating ones`); worstM = Math.max(worstM, m.chi2); bestO = Math.min(bestO, o.chi2);
  }
  check('changing the companion\'s mass by 20% at fixed P and T0 of b: a modest change of chi2 with mean elements, a ruinous one with osculating', worstM < 3 * cO.chi2 && bestO > 20 * cO.chi2, `${rows.join('; ')} (${cO.chi2.toFixed(0)} at the truth): with osculating elements b's own period and T0 must follow the companion's mass along a narrow ridge`);
  const tm = best(() => pMean.loglike([]), 10), to = best(() => pOsc.loglike([]), 10);
  {
    // cost per call when the sampler moves: points drawn from the prior box of the fit below, and from a tenth of it
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }, out = [];
    for (const scale of [1, 0.1]) {
      const prob = buildProblem({ ...two, values: mv, free: ['per', 'tmid', 'mplanet@c', 'per@c', 'tmid@c'].map((key) => ({ key, prior: { type: 'uniform', a: 0, b: 1 } })), nbody: { epoch, elements: 'mean', ...simOpt } });
      let it = 0, bad = 0; const n = 200, t0 = performance.now();
      for (let k = 0; k < n; k++) { const u = () => scale * (2 * rnd() - 1), th = [mb.P + 4e-5 * u(), mb.T + 0.004 * u(), 0.14 + 0.11 * u(), mc.P + 0.004 * u(), mc.T + 0.3 * u()], d = prob.detail(th); if (d) it += d.nbody.iterations; else bad++; }
      out.push(`${(it / (n - bad)).toFixed(1)} simulations and ${((performance.now() - t0) / n).toFixed(1)} ms per call over ${scale === 1 ? 'the prior box' : 'a tenth of it'}${bad ? ` (${bad} of ${n} rejected)` : ''}`);
    }
    console.log(`info  timing likelihood of the example (72 times over 1110 d): ${to.ms.toFixed(2)} ms with osculating elements; with mean elements ${tm.ms.toFixed(2)} ms at a repeated point, ${out.join(', ')}`);
  }

  if (process.env.NBODY_FIT) {
    // the fit that did not converge with osculating elements: P and T0 of b sampled together with the companion's mass, period and phase
    const free = [
      { key: 'per', prior: { type: 'uniform', a: spec.values.per - 4e-5, b: spec.values.per + 4e-5 } },
      { key: 'tmid', prior: { type: 'uniform', a: spec.values.tmid - 0.004, b: spec.values.tmid + 0.004 } },
      { key: 'mplanet@c', prior: { type: 'uniform', a: 0.03, b: 0.25 } },
      { key: 'per@c', prior: { type: 'uniform', a: mc.P - 0.004, b: mc.P + 0.004 } },
      { key: 'tmid@c', prior: { type: 'uniform', a: mc.T - 0.3, b: mc.T + 0.3 } },
    ];
    const prob = buildProblem({ ...two, values: mv, free, nbody: { epoch, elements: 'mean', ...simOpt } });
    const t0 = performance.now(), ns = new MiniNest({ ndim: prob.ndim, loglike: prob.loglike, transform: prob.transform, nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 150000, names: prob.keys });
    while (!ns.done) ns.step(25);
    const res = ns.result(), d = prob.ndim, w = res.weights, col = (j) => { let m = 0, sd = 0, sw = 0; for (let i = 0; i < w.length; i++) { m += w[i] * res.samples[i * d + j]; sw += w[i]; } m /= sw; for (let i = 0; i < w.length; i++) sd += w[i] * (res.samples[i * d + j] - m) ** 2; return [m, Math.sqrt(sd / sw)]; };
    const st5 = prob.keys.map((_, j) => col(j)), sec = (performance.now() - t0) / 1000, truthV = prob.keys.map((k) => mv[k]);
    const within = st5.every(([m, sd], j) => Math.abs(m - truthV[j]) < 3.5 * sd);
    check('nested sampling with P and T0 of b free (5 parameters, mean elements) converges within 150,000 calls and recovers the system within 3.5 sigma', res.converged !== false && res.ncalls < 150000 && within && st5[2][1] < 0.03,
      `${res.converged === false ? 'NOT CONVERGED (' + res.stopReason + '); ' : ''}${res.ncalls} calls in ${sec.toFixed(0)} s, lnZ ${res.logZ.toFixed(2)}; companion ${st5[2][0].toFixed(4)} ± ${st5[2][1].toFixed(4)} M_Jup (injected ${c.mplanet}), mean period ${st5[3][0].toFixed(5)} ± ${st5[3][1].toFixed(5)} d (${mc.P.toFixed(5)}); b: P ${st5[0][0].toFixed(7)} ± ${st5[0][1].toFixed(7)} d (${mb.P.toFixed(7)}), T0 ${st5[1][0].toFixed(5)} ± ${st5[1][1].toFixed(5)} (${mb.T.toFixed(5)})`);
  } else console.log('skip  nested-sampling fit with mean elements, 5 free parameters (about 7 minutes: run with NBODY_FIT=1)');
}

// =============================================================================================================
console.log('--- speed (this machine, one thread)');
{
  // two planets, 2000 light-curve points: 27 d of continuous photometry, and the same number of points on 12 nights over 125 d
  const N = 2000, cont = Float64Array.from({ length: N }, (_, i) => 0.3 + (i * 27) / N);
  const nights = Float64Array.from({ length: N }, (_, i) => st.transits[0][Math.floor(i / 167) % 12] - 0.2 + ((i % 167) * 0.4) / 167).sort();
  const row = (name, t, extra = {}) => {
    const k = buildProblem(lcSpec(t, extra)), w = buildProblem(lcSpec(t, { ...extra, nbody: { epoch: 0 } })), f = buildProblem(lcSpec(t, { ...extra, nbody: { epoch: 0, stepsPerOrbit: 20, exactSync: false } })), i = buildProblem(lcSpec(t, { ...extra, nbody: { epoch: 0, integrator: 'ias15' } }));
    const a = best(() => k.loglike([]), 25), b = best(() => w.loglike([]), 25), c = best(() => f.loglike([]), 25), d = best(() => i.loglike([]), 8);
    console.log(`info  ${name}: ${b.ms.toFixed(2)} ms per likelihood call (Wisdom-Holman defaults), ${c.ms.toFixed(2)} ms (20 steps per orbit, no re-synchronisation), ${d.ms.toFixed(1)} ms (IAS15); Keplerian ${a.ms.toFixed(2)} ms; ${w.detail([]).nbody.photo ? dynamicalModel(sys, { lc: { t } }).photo.nodes : 0} track nodes`);
    return b.ms;
  };
  const m1 = row('2 planets, 2000 points over 27 d', cont), m2 = row('2 planets, 2000 points on 12 nights over 125 d', nights), m3 = row('2 planets, 2000 points over 27 d, 30-min exposures in 7 sub-samples', cont, { exptime: 30 / 1440, supersample: 7 });
  check('photodynamical likelihood of 2 planets and 2000 points under 10 ms per call', m1 < 10 && m2 < 10 && m3 < 20, `${m1.toFixed(2)}, ${m2.toFixed(2)} and ${m3.toFixed(2)} ms`);
}

console.log(ok ? '\nnbody photodynamics: all checks passed' : '\nnbody photodynamics: FAILURES');
process.exit(ok ? 0 : 1);
