// ESL's side of every comparison on the Validation page, computed from the inputs stored in public/validation/*.json.
// No DOM: the page (src/validation/main.js) and test/validation.test.mjs both call these, so the numbers shown and
// the numbers asserted come from the same code. The external codes' outputs and the truth values are in the JSON
// (written by tools/validation/*.py); nothing here knows how they were made.

import { transitModel, blockedFraction } from '../core/transit.js';
import { toClaret, prepareLD } from '../core/limbdark.js';
import { solveKepler, trueAnomaly, orbitElements, eventTimes, derived, separation } from '../core/kepler.js';
import { makeRV, semiAmplitude } from '../core/rv.js';
import { buildProblem, autoSupersample } from '../core/model.js';
import { runFit } from '../core/fitRunner.js';
import { makeRng, weightedMeanStd, weightedQuantiles } from '../core/stats.js';

/** Tolerances claimed on the page and asserted by the test. */
export const TOL = {
  transit: 1e-10,          // max |ESL - truth| in relative flux, any case of the grid
  special: 5e-10,          // the same at the kernel's branch points (within 1e-13 of a contact)
  exposure101: 1e-7,       // exposure averaging with 101 sub-samples against the 4001-point truth average
  exposureAuto: 1e-6,      // the same with the number of sub-samples the app picks by itself (1 ppm; it was 2.5e-5 until autoSupersample was fixed, 2026-11-15)
  keplerNu: 1e-11,         // max error of the true anomaly [rad], e up to 0.999 (the conditioning limit near periastron)
  keplerE: 2e-14,          // residual of Kepler's equation |E - e sin E - M|
  eventSeconds: 1e-4,      // periastron and eclipse times [s]
  durationSeconds: 1e-3,   // T14, T23, E14, E23 by bisection [s]
  rv: 1e-12,               // max |ESL - truth| / K
  amplitude: 1e-7,         // K from masses, relative (limited by the constants: GM_Sun and the Jupiter/Sun mass ratio)
  lnL: 1e-5,               // ESL's ln L against the independent Python likelihood at the same point (both lose ~1e-6 to cancellation in chi2)
  fitMean: 0.2,            // posterior mean: |ESL - reference| in units of the reference width
  fitWidth: 0.12,          // posterior width: relative difference
  lnZsigma: 3.5,           // ln Z: difference in units of the combined reported errors ...
  lnZabs: 0.8,             // ... and never more than this
  coverage68: [0.60, 0.76],// fraction of realisations with the truth inside the central 68% interval (300 realisations: 0.68 +- 0.027)
};

export const linspace = (a, b, n) => Float64Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
export const maxAbs = (a) => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };
export const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };
const sub = (a, b) => Float64Array.from(a, (v, i) => v - b[i]);
const wrapPi = (x) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
const params = (c) => ({ rprs: c.rprs, per: c.per, tmid: c.tmid, ars: c.ars, inc: c.inc, ecc: c.ecc || 0, omega: c.omega || 0, ldLaw: c.law, ld: c.ld });

// ---- 1. transit light curves ---------------------------------------------------------------------

/** One case of transit.json: ESL's flux on the stored grid, and its difference from the truth. */
export function transitCase(c) {
  const t = linspace(c.t0, c.t1, c.n), flux = transitModel(t, params(c)), res = sub(flux, c.truth);
  return { t, flux, res, max: maxAbs(res), rms: rms(res) };
}

/** Every case, with the stored statistics of the other codes alongside: [{ c, esl: {max, rms}, ... }]. */
export function transitAll(T) {
  return T.cases.map((c) => ({ c, esl: transitCase(c) }));
}

/** Kernel branch points: ESL's flux against the 30-digit truth. */
export function specialPoints(T) {
  return T.special.map((s) => {
    const ld = prepareLD(toClaret('quadratic', s.u));
    return { ...s, esl: 1 - blockedFraction(s.z, s.p, ld) - s.truth };
  });
}

/** Exposure averaging: ESL with n sub-samples against the truth average, for n = 1, 3, 7, 15, 31 and the automatic choice. */
export function exposureCase(e) {
  const t = linspace(e.t0, e.t1, e.n), p = params({ ...e.p });
  const auto = autoSupersample(e.exptime, { ...e.p });
  const run = (ns) => { const r = sub(transitModel(t, p, null, { exptime: e.exptime, supersample: ns }), e.truth); return { ns, res: r, max: maxAbs(r) }; };
  const ns = [1, 3, 7, 15, 31, 101];
  return { t, auto, byN: ns.map(run), autoRun: run(auto) };
}

/** Light curves per second for the stored timing case (n points, parameters changed on every call). */
export function timeTransit(tc, seconds = 0.4) {
  const t = linspace(tc.t0, tc.t1, tc.n), out = new Float64Array(tc.n), p = params({ ...tc.p, law: tc.p.law });
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  for (let i = 0; i < 20; i++) transitModel(t, p, out);       // warm up the JIT
  let n = 0; const t0 = now();
  while (now() - t0 < seconds * 1000) { for (let i = 0; i < 20; i++) { p.rprs = tc.p.rprs * (1 + 1e-6 * Math.random()); transitModel(t, p, out); } n += 20; }
  return n / ((now() - t0) / 1000);
}

// ---- 2. orbit and timing -------------------------------------------------------------------------

/** Kepler's equation: ESL's max error in true anomaly and in E per eccentricity, and the residual of the equation itself. */
export function keplerErrors(O) {
  const K = O.kepler;
  return K.ecc.map((e, j) => {
    let dNu = 0, dE = 0, resid = 0;
    for (let i = 0; i < K.M.length; i++) {
      const E = solveKepler(K.M[i], e);
      dE = Math.max(dE, Math.abs(wrapPi(E - K.E[j][i])));
      dNu = Math.max(dNu, Math.abs(wrapPi(trueAnomaly(E, e) - K.nu[j][i])));
      resid = Math.max(resid, Math.abs(wrapPi(E - e * Math.sin(E) - K.M[i])));
    }
    return { e, dNu, dE, resid };
  });
}

/** Time of minimum sky-projected separation near tc, by golden-section search on ESL's orbit. */
export function minSeparationTime(p, tc) {
  const el = orbitElements(p), tmp = [0, 0, 0], f = (t) => separation(el, t, tmp).d, g = (Math.sqrt(5) - 1) / 2;
  let a = tc - 0.02 * p.per, b = tc + 0.02 * p.per, x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2);
  for (let i = 0; i < 200 && b - a > 1e-13 * Math.max(1, Math.abs(tc)); i++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2); }
  }
  return 0.5 * (a + b);
}

/** Periastron and eclipse times: ESL minus truth, in seconds, modulo the period. */
export function eventErrors(O) {
  return O.events.map((c) => {
    const ev = eventTimes(c), mod = (d) => d - c.per * Math.round(d / c.per);
    return { c, tperi: ev.tperi, tecl: ev.tecl, dPeri: mod(ev.tperi - c.truth.tperi) * 86400, dEcl: mod(ev.tecl - c.truth.tecl) * 86400 };
  });
}

/** Durations: ESL's root-found values (eventTimes) and its closed-form ones (derived), with the truth. */
export function durationRows(O) {
  return O.durations.map((c) => {
    const ev = eventTimes(c), d = derived(c);
    return { c, exact: { t14: ev.t14, t23: ev.t23, e14: ev.e14, e23: ev.e23 }, closed: { t14: d.t14, t23: d.t23 }, dtMinSep: c.ecc ? minSeparationTime(c, c.tmid) - c.tmid : 0 };
  });
}

// ---- 3. radial velocities ------------------------------------------------------------------------

export function rvCase(c) {
  const t = linspace(c.t0, c.t1, c.n), f = makeRV(c), v = Float64Array.from(t, f), res = sub(v, c.truth);
  return { t, v, res, max: maxAbs(res) / c.K, quarter: f(c.tmid - c.per / 4) / c.K };
}
export function amplitudeRows(V) {
  return V.amplitude.map((r) => { const K = semiAmplitude(r.per, r.ecc, r.inc, r.mplanet, r.mstar); return { r, K, rel: K / r.truth - 1 }; });
}

// ---- 4. parameter recovery -----------------------------------------------------------------------

/** The fit specification for one problem of fits.json, exactly as the app would hand it to buildProblem. */
export function fitSpec(P, sampler = {}) {
  const free = P.keys.map((key, i) => ({ key, prior: { type: 'uniform', a: P.lo[i], b: P.hi[i] } }));
  const d = P.data;
  if (P.kind === 'lc') {
    return { data: { t: Float64Array.from(d.t), f: Float64Array.from(d.f), e: Float64Array.from(d.e), airmass: d.airmass ? Float64Array.from(d.airmass) : null },
             values: { ecc: 0, omega: 0, a2: 0, ...P.values }, ldLaw: P.ldLaw, free, exptime: 0, supersample: 1, sampler };
  }
  return { data: null, values: { rvlin: 0, rvquad: 0, 'jit@rv1': 0, ...P.values }, ldLaw: 'quadratic', free, rv: [{ t: Float64Array.from(d.t), v: Float64Array.from(d.v), e: Float64Array.from(d.e) }], sampler };
}

/** ln L at the stored points: ESL minus the independent Python likelihood. */
export function lnLCheck(P) {
  const prob = buildProblem(fitSpec(P));
  return P.lnLpoints.map((th, i) => prob.loglike(th) - P.lnL[i]);
}

/** Weighted posterior summary of a MiniNest result. */
export function summarise(r) {
  const mean = [], std = [], q = [];
  for (let k = 0; k < r.ndim; k++) {
    const x = Float64Array.from({ length: r.n }, (_, i) => r.samples[i * r.ndim + k]);
    const [m, s] = weightedMeanStd(x, r.weights); mean.push(m); std.push(s); q.push(weightedQuantiles(x, r.weights, [0.15865, 0.5, 0.84135]));
  }
  return { mean, std, q, logZ: r.logZ, logZerr: r.logZerr, ncalls: r.ncalls, ess: r.ess, elapsed: r.elapsed, nlive: r.nlive, insertionP: r.insertionP };
}

export async function runProblem(P, sampler = { nlive: 400, seed: 42 }, onProgress = () => {}) {
  return summarise(await runFit(fitSpec(P, sampler), onProgress, () => false));
}

/**
 * Compare ESL's summary with the stored ones. Reference for means and widths: the analytic answer when there is one,
 * otherwise dynesty. Returns { ref, rows: [{key, esl, ref, dMean (sigma), dWidth (relative)}], lnZ: [{name, diff, sigma}] , ok }.
 */
export function compareFit(P, S) {
  const refName = P.analytic ? 'analytic' : 'dynesty', ref = P.analytic || P.samplers.dynesty;
  const rows = P.keys.map((key, i) => ({ key, truth: P.truth[i], mean: S.mean[i], std: S.std[i], refMean: ref.mean[i], refStd: ref.std[i],
    dMean: (S.mean[i] - ref.mean[i]) / ref.std[i], dWidth: S.std[i] / ref.std[i] - 1 }));
  const lnZ = [];
  const add = (name, z, err) => lnZ.push({ name, logZ: z, logZerr: err, diff: S.logZ - z, sigma: (S.logZ - z) / Math.hypot(S.logZerr, err || 0) });
  if (P.analytic) add('analytic', P.analytic.logZ, 0);
  for (const n of ['dynesty', 'UltraNest']) if (P.samplers[n] && P.samplers[n].logZ !== undefined) add(n, P.samplers[n].logZ, P.samplers[n].logZerr);
  const okPost = rows.every((r) => Math.abs(r.dMean) < TOL.fitMean && Math.abs(r.dWidth) < TOL.fitWidth);
  const okZ = lnZ.every((z) => Math.abs(z.sigma) < TOL.lnZsigma && Math.abs(z.diff) < TOL.lnZabs);
  return { refName, rows, lnZ, okPost, okZ, ok: okPost && okZ };
}

// ---- coverage: truths drawn from the prior, data simulated, does the 68% interval hold the truth 68% of the time? ----

export const COVERAGE = {
  transit: {
    label: 'Transit: Rp/R*, T mid and inclination', n: 300,
    keys: ['rprs', 'tmid', 'inc'], lo: [0.05, -0.01, 86], hi: [0.15, 0.01, 90],
    fixed: { per: 3.5, ars: 10, ecc: 0, omega: 0, ld0: 0.4, ld1: 0.26, a2: 0 }, npts: 150, span: 0.2, sigma: 1e-3,
  },
  rv: {
    label: 'Velocities: K, e, omega and T mid', n: 300,
    keys: ['K', 'ecc', 'omega', 'tmid'], lo: [20, 0, 0, -1], hi: [120, 0.6, 360, 1],
    fixed: { per: 9, rvlin: 0, rvquad: 0, 'jit@rv1': 0 }, npts: 50, span: 40, sigma: 4,
  },
};

/** Realisation i of a coverage problem: the truth (a prior draw), the simulated data and the fit specification. Deterministic in (kind, i). */
export function coverageSpec(kind, i, sampler = { nlive: 200 }) {
  const C = COVERAGE[kind], rng = makeRng(1000 * (kind === 'rv' ? 7 : 3) + i);
  const truth = C.keys.map((_, k) => C.lo[k] + (C.hi[k] - C.lo[k]) * rng.next());
  const values = { ...C.fixed }; C.keys.forEach((k, j) => (values[k] = truth[j]));
  const free = C.keys.map((key, k) => ({ key, prior: { type: 'uniform', a: C.lo[k], b: C.hi[k] } }));
  const smp = { seed: 100 + i, ...sampler };
  if (kind === 'transit') {
    const t = linspace(-C.span / 2, C.span / 2, C.npts), m = transitModel(t, { ...values, ldLaw: 'quadratic', ld: [values.ld0, values.ld1] });
    const f = Float64Array.from(m, (v) => v + C.sigma * rng.normal()), e = new Float64Array(C.npts).fill(C.sigma);
    return { truth, spec: { data: { t, f, e, airmass: null }, values, ldLaw: 'quadratic', free, exptime: 0, supersample: 1, sampler: smp } };
  }
  const t = Float64Array.from({ length: C.npts }, () => C.span * rng.next()).sort(), f = makeRV(values);
  const v = Float64Array.from(t, (x) => 17 + f(x) + C.sigma * rng.normal()), e = new Float64Array(C.npts).fill(C.sigma);
  return { truth, spec: { data: null, values, ldLaw: 'quadratic', free, rv: [{ t, v, e }], sampler: smp } };
}

/** Fit realisation i and return, per parameter, the posterior rank of the truth (fraction of posterior mass below it). */
export async function coverageRun(kind, i, sampler) {
  const { truth, spec } = coverageSpec(kind, i, sampler), r = await runFit(spec, () => {}, () => false);
  let tot = 0; for (let j = 0; j < r.n; j++) tot += r.weights[j];
  const rank = truth.map((tv, k) => { let s = 0; for (let j = 0; j < r.n; j++) if (r.samples[j * r.ndim + k] < tv) s += r.weights[j]; return s / tot; });
  return { rank, ncalls: r.ncalls, elapsed: r.elapsed };
}

/** Coverage fractions from ranks: [{ key, c68, c95, hist (10 bins) }]. */
export function coverageSummary(kind, ranks) {
  return COVERAGE[kind].keys.map((key, k) => {
    const hist = new Array(10).fill(0); let c68 = 0, c95 = 0;
    for (const r of ranks) { const x = r[k]; hist[Math.min(9, Math.floor(x * 10))]++; if (x > 0.15865 && x < 0.84135) c68++; if (x > 0.025 && x < 0.975) c95++; }
    return { key, c68: c68 / ranks.length, c95: c95 / ranks.length, hist, n: ranks.length };
  });
}
