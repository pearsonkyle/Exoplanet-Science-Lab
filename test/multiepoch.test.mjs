// Several epochs in one fit: the per-epoch marginalised likelihood against brute-force quadrature,
// additivity over epochs, the data utilities, and a joint fit of the period checked against a
// second route (each epoch's mid-time measured on its own, then a least-squares ephemeris).
import { buildProblem, activeParams, epochKey, paramFor, A1_PRIOR_WIDTH } from '../src/core/model.js';
import { transitModel } from '../src/core/transit.js';
import { combineEpochs, removeEpoch, splitByOrbit, foldTimes, synthesize, epochList } from '../src/core/data.js';
import { fitEphemeris } from '../src/core/ephemeris.js';
import { runFit } from '../src/core/fitRunner.js';
import { makeRng, weightedMeanStd } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const truth = { rprs: 0.1489, ars: 5.344, inc: 87.2, per: 2.1500082, tmid: 0.012, ecc: 0, omega: 0, ld0: 0.38, ld1: 0.27 };
const tp = (v) => ({ ...v, ldLaw: 'quadratic', ld: [v.ld0, v.ld1] });
/** One night: N points around the transit `orbit` periods after tmid, baseline a1 exp(k airmass). */
function night(orbit, N, sig, a1, k, seed, tRef = 0) {
  const rng = makeRng(seed), tc = truth.tmid + orbit * truth.per;
  const t = Float64Array.from({ length: N }, (_, i) => tc - 0.13 + (0.26 * i) / (N - 1));
  const am = Float64Array.from(t, (x) => 1.05 + 6 * (x - tc + 0.02) ** 2), pure = transitModel(t, tp(truth));
  return { name: 'night ' + orbit, tRef, t: Float64Array.from(t, (x) => x - tRef), f: Float64Array.from(pure, (m, i) => a1 * m * Math.exp((k ?? 0) * am[i]) + sig * rng.normal()), e: new Float64Array(N).fill(sig), airmass: k === null ? null : am };
}
const spec = (data, values, free = []) => ({ data, values: { ...truth, ...values }, ldLaw: 'quadratic', free, exptime: 0, supersample: 1 });

// ln of  int_0^W  prod_i N(f_i | a1 m_i, e_i) da1 / W  by brute force: Simpson's rule on a fine grid around the peak
function lnMarginal(f, e, m) {
  let sdm = 0, smm = 0; for (let i = 0; i < f.length; i++) { sdm += (f[i] * m[i]) / e[i] ** 2; smm += (m[i] * m[i]) / e[i] ** 2; }
  const a0 = sdm / smm, s = 1 / Math.sqrt(smm), lo = Math.max(0, a0 - 12 * s), hi = Math.min(A1_PRIOR_WIDTH, a0 + 12 * s), n = 4000, h = (hi - lo) / n;
  const lnp = (a) => { let v = 0; for (let i = 0; i < f.length; i++) v += -0.5 * ((f[i] - a * m[i]) / e[i]) ** 2 - Math.log(e[i]) - 0.9189385332046727; return v; };
  const ref = lnp(a0); let sum = 0;
  for (let j = 0; j <= n; j++) sum += (j === 0 || j === n ? 1 : j % 2 ? 4 : 2) * Math.exp(lnp(lo + j * h) - ref);
  return ref + Math.log((sum * h) / 3 / A1_PRIOR_WIDTH);
}

// --- three nights: two with their own airmass slope, one with no airmass column
const nights = [night(0, 180, 0.0015, 1.003, -0.012, 1), night(3, 140, 0.0022, 0.97, 0.02, 2), night(10, 200, 0.0012, 1.02, null, 3)];
const D = combineEpochs(nights), ks = { 'a2@1': -0.012, 'a2@2': 0.02 };
check('combined dataset: epochs, order, airmass', D.segments.length === 3 && D.t.length === 520 && D.epoch[0] === 0 && D.epoch[519] === 2 && D.segments.map((s) => s.airmass).join() === 'true,true,false' && D.airmass[519] === 0);
{
  // off the best fit on purpose, so the test does not depend on being at a maximum
  const v = { rprs: 0.142, tmid: 0.0135, ...ks, 'a2@2': 0.015 }, p = buildProblem(spec(D, v)), det = p.detail([]);
  let brute = 0, add = 0;
  nights.forEach((n, s) => {
    const idx = []; for (let i = 0; i < D.t.length; i++) if (D.epoch[i] === s) idx.push(i);
    brute += lnMarginal(idx.map((i) => D.f[i]), idx.map((i) => D.e[i]), idx.map((i) => det.model[i]));
    add += buildProblem(spec(n, { ...v, a2: v[epochKey(s)] ?? 0 })).loglike([]);
  });
  check('ln L = sum over epochs of the a1-marginal by quadrature', Math.abs(det.lnL - brute) < 1e-6,   // the closed form subtracts sums of order 1e8, so it carries about 1e-8 of rounding
    `${det.lnL.toFixed(6)} vs ${brute.toFixed(6)}, difference ${(det.lnL - brute).toExponential(1)}`);
  check('ln L = sum of single-epoch problems', Math.abs(det.lnL - add) < 1e-9, `difference ${(det.lnL - add).toExponential(1)}`);
  check('problem reports its size', p.nepochs === 3 && p.ndata === 520);
}
{
  const det = buildProblem(spec(D, ks)).detail([]), a1 = [1.003, 0.97, 1.02];
  // sigma(a1) ~ sigma / sqrt(N): 1.1e-4, 1.9e-4, 0.85e-4
  const pulls = det.a1s.map((a, s) => (a - a1[s]) / (nights[s].e[0] / Math.sqrt(nights[s].t.length)));
  let dev = 0; for (let i = 0; i < D.t.length; i++) dev = Math.max(dev, Math.abs(det.base[i] * det.transit[i] - det.a1s[D.epoch[i]] * det.model[i]));
  check('each epoch recovers its own normalisation', pulls.every((x) => Math.abs(x) < 3.5), det.a1s.map((a, s) => `${a.toFixed(5)} (${a1[s]}, ${pulls[s].toFixed(1)}σ)`).join('  '));
  check('chi2 at the truth is about N', Math.abs(det.chi2 - 520) < 4 * Math.sqrt(2 * 520), `${det.chi2.toFixed(1)} for 520 points`);
  check('detail: baseline x transit = model', dev < 1e-15 && det.base.length === 520);
}
{
  // one epoch: identical to a dataset with no epoch index, and a2 still works as before
  const n = nights[0], a = buildProblem(spec(n, { a2: -0.01 })).loglike([]), b = buildProblem(spec({ ...n, epoch: new Int32Array(n.t.length) }, { a2: -0.01 })).loglike([]);
  const m = buildProblem(spec(n, { a2: -0.01 })).detail([]).model;
  check('single epoch unchanged', a === b && Math.abs(a - lnMarginal(n.f, n.e, m)) < 1e-6, `difference from quadrature ${(a - lnMarginal(n.f, n.e, m)).toExponential(1)}`);
  check('per-epoch key falls back to a2', buildProblem(spec(D, { a2: 0.004 })).loglike([]) === buildProblem(spec(D, { 'a2@1': 0.004, 'a2@2': 0.004 })).loglike([]));
}

// --- registry
{
  const one = activeParams('quadratic', true).map((p) => p.key), many = activeParams('quadratic', [true, false, true]);
  check('registry: per-epoch airmass keys', one.at(-1) === 'a2' && activeParams('quadratic', [true]).at(-1).key === 'a2' && many.slice(-2).map((p) => p.key).join() === 'a2@1,a2@3' && !many.some((p) => p.key === 'a2') && paramFor('a2@3').key === 'a2' && paramFor('rprs').key === 'rprs' && !activeParams('quadratic', [false, false]).some((p) => p.key.startsWith('a2')));
}

// --- data utilities
{
  const a = night(0, 50, 0.001, 1, null, 5, 0), b = { ...night(4, 60, 0.001, 1, 0.01, 6), tRef: 0 };
  // same nights given with different date references: 2459000 + t and 2459008 + (t - 8)
  const A = { ...a, tRef: 2459000 }, B = { ...b, tRef: 2459008, t: Float64Array.from(b.t, (x) => x - 8) }, C = combineEpochs([B, A]);
  let sorted = true; for (let i = 1; i < C.t.length; i++) if (C.t[i] < C.t[i - 1]) sorted = false;
  check('combine: common time reference, sorted, named', C.tRef === 2459000 && sorted && Math.abs(C.t[50] - b.t[0]) < 1e-9 && C.segments[0].name === 'night 0' && C.segments[1].n === 60 && C.name === '2 epochs');
  let threw = false; try { combineEpochs([A, b]); } catch { threw = true; }
  check('combine: refuses dated + relative times', threw);
  const R = removeEpoch(D, 1);
  check('remove an epoch', R.segments.length === 2 && R.t.length === 380 && R.segments[1].name === 'night 10' && !R.segments[1].airmass && R.segments[0].airmass && removeEpoch(R, 0).epoch === undefined && removeEpoch(R, 0).t.length === 200);
  // a continuous light curve from 0.56 periods before tmid to 4.04 after: six orbits, the first and last partial
  const N = 4000, t = Float64Array.from({ length: N }, (_, i) => -1.2 + (9.9 * i) / (N - 1)), long = { name: 'long', tRef: 2457000, t, f: transitModel(t, tp(truth)), e: new Float64Array(N).fill(1e-3), airmass: null };
  const Sp = splitByOrbit(long, truth.per, truth.tmid);
  const okSplit = Sp.segments.length === 6 && Sp.t.length === N && Sp.segments.slice(1, 5).every((s, k) => Math.abs((s.t0 + s.t1) / 2 - (truth.tmid + k * truth.per)) < 0.01 * truth.per) && Sp.epoch.every((s, i) => s === Math.round((t[i] - truth.tmid) / truth.per) + 1);
  check('split a long light curve by orbit', okSplit && splitByOrbit(nights[0], truth.per, truth.tmid) === nights[0], Sp.segments.map((s) => `${s.name}: ${s.n}`).join(', '));
  const F = foldTimes(t, truth.per, truth.tmid); let worst = 0, span = 0;
  for (let i = 0; i < N; i++) { span = Math.max(span, Math.abs(F[i] - truth.tmid)); worst = Math.max(worst, Math.abs(((t[i] - F[i]) / truth.per) - Math.round((t[i] - F[i]) / truth.per))); }
  const pure = transitModel(F, tp(truth)); let dm = 0; for (let i = 0; i < N; i++) dm = Math.max(dm, Math.abs(pure[i] - long.f[i]));
  check('fold: whole periods, within half a period, same model', worst < 1e-9 && span <= truth.per / 2 + 1e-12 && dm < 1e-9, `model difference ${dm.toExponential(1)}`);
  const Sy = synthesize({ ...truth, a2: -0.01 }, 'quadratic', { exptimeMin: 2, noisePpm: 800, baselineHr: 1, airmass: true, k: -0.01, seed: 3, nEpochs: 4, epochStep: 5 });
  const mids = Sy.segments.map((s) => (s.t0 + s.t1) / 2 - truth.tmid);
  check('simulate several transits', Sy.segments.length === 4 && Sy.synthetic && mids.every((m, j) => Math.abs(m - 5 * j * truth.per) < 0.01) && epochList(Sy).every((s) => s.airmass) && Math.abs(Sy.f[0] - Sy.f[Sy.segments[0].n]) > 0 && epochList(synthesize(truth, 'quadratic', { noisePpm: 500 })).length === 1);
}

// --- the period from a joint fit, against per-epoch mid-times + a least-squares ephemeris
{
  const orbits = [0, 3, 10, 40, 41], sig = 0.0015, data = combineEpochs(orbits.map((o, j) => night(o, 160, sig, 1 + 0.01 * j, null, 20 + j)));
  // route 2: mid-time of each night alone from its likelihood on a grid (everything else at the truth), then fitEphemeris
  const tm = [], te = [];
  orbits.forEach((o, s) => {
    const idx = []; for (let i = 0; i < data.t.length; i++) if (data.epoch[i] === s) idx.push(i);
    const one = { t: Float64Array.from(idx, (i) => data.t[i]), f: Float64Array.from(idx, (i) => data.f[i]), e: Float64Array.from(idx, (i) => data.e[i]), airmass: null };
    const c = truth.tmid + o * truth.per, G = 801, x = [], l = [];
    for (let g = 0; g < G; g++) { const tmid = c - 0.004 + (0.008 * g) / (G - 1); x.push(tmid); l.push(buildProblem(spec(one, { tmid })).loglike([])); }
    const mx = Math.max(...l), w = l.map((v) => Math.exp(v - mx)), [mean, sd] = weightedMeanStd(x, w);
    tm.push(mean); te.push(sd);
  });
  const eph = fitEphemeris(orbits, tm, te, 1);
  const free = [{ key: 'tmid', prior: { type: 'uniform', a: truth.tmid - 0.004, b: truth.tmid + 0.004 } }, { key: 'per', prior: { type: 'uniform', a: truth.per - 4e-4, b: truth.per + 4e-4 } }];
  const r = await runFit({ ...spec(data, {}, free), sampler: { nlive: 400, seed: 2 } }, () => {}, () => false);
  const col = (k) => Float64Array.from({ length: r.n }, (_, i) => r.samples[i * r.ndim + k]);
  const [t0, t0e] = weightedMeanStd(col(0), r.weights), [P, Pe] = weightedMeanStd(col(1), r.weights);
  console.log(`   joint fit: ${r.ncalls} calls, ${r.elapsed.toFixed(1)} s, stop=${r.stopReason}, insertion p=${r.insertionP.toFixed(3)}`);
  console.log(`   per-epoch mid-time errors: ${te.map((v) => (v * 86400).toFixed(0)).join(', ')} s`);
  check('joint fit recovers the period', Math.abs(P - truth.per) < 3.5 * Pe && Math.abs(t0 - truth.tmid) < 3.5 * t0e, `P = ${P.toFixed(7)} ± ${Pe.toFixed(7)} (truth ${truth.per}, ${((P - truth.per) / Pe).toFixed(1)}σ)`);
  check('period agrees with the per-epoch route', Math.abs(P - eph.per) < 0.35 * Pe && Math.abs(Pe / eph.err.per - 1) < 0.12, `ephemeris of 5 mid-times: ${eph.per.toFixed(7)} ± ${eph.err.per.toFixed(7)}; difference ${((P - eph.per) / Pe).toFixed(2)}σ, error ratio ${(Pe / eph.err.per).toFixed(3)}`);
  check('reference mid-time agrees too', Math.abs(t0 - eph.t0) < 0.35 * t0e && Math.abs(t0e / eph.err.t0 - 1) < 0.12, `${t0.toFixed(6)} ± ${t0e.toFixed(6)} vs ${eph.t0.toFixed(6)} ± ${eph.err.t0.toFixed(6)}`);
}
process.exit(ok ? 0 : 1);
