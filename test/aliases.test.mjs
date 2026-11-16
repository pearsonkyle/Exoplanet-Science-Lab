// Period aliases (src/core/aliases.js; nalias / palias in buildProblem).
//   1. TOI-1873 d, the owner's case (EXOTIC/examples/toi-3planet/README.md): three transits 900.191 and 900.186 d apart,
//      TESS coverage of 16 sectors (test/make_alias_reference.py stores it as merged intervals). The scan must allow
//      N = 1..4 and 7 and reproduce, for every N up to 25, the number of covered and missed predicted transits of
//      EXOTIC's own scan (its stored output) and of the numpy transcription on the full cadences.
//   2. The geometric weights reproduce the README's "geom. prior" differences (N^(2/3)).
//   3. Sampling: a planet with three transits 900 d apart (truth P = 300 d, N = 3) in a light curve with a/R* from
//      Kepler's law. One run with a categorical N over the allowed set, and one run per N: the posterior probability of
//      every N from the first must match exp(ln Z_N) normalised from the second.
import { readFileSync } from 'node:fs';
import { aliasScan, aliasPrior, aliasRuns, combineAliasEvidence, coverageIntervals, coveredLength, transitDuration } from '../src/core/aliases.js';
import { makeTransform, validatePrior, priorPdf } from '../src/core/priors.js';
import { makeTransit } from '../src/core/transit.js';
import { arsFromKepler } from '../src/core/rv.js';
import { buildProblem } from '../src/core/model.js';
import { runFit } from '../src/core/fitRunner.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// ---- 1. TOI-1873 d
{
  const R = JSON.parse(readFileSync(new URL('./alias_reference.json', import.meta.url)));
  const scan = aliasScan({ transits: R.epochs, coverage: R.intervals, duration: { rprs: R.rprs, ...R.star }, nMax: 25 });
  const diff = scan.rows.filter((r, i) => r.covered !== R.exotic_stored[i].covered || r.missed !== R.exotic_stored[i].missed || r.covered !== R.scan[i].covered || r.missed !== R.scan[i].missed);
  const dT = Math.max(...scan.rows.map((r, i) => Math.abs(r.t14 - R.scan[i].t14) * 86400));
  check('TOI-1873 d: allowed N = 1, 2, 3, 4, 7 (900.19, 450.09, 300.06, 225.05, 128.598 d), as in the owner\'s README', JSON.stringify(scan.allowed) === '[1,2,3,4,7]',
    `span ${scan.span.toFixed(4)} d (last minus first over two spacings); shortest alias ${(scan.span / 7).toFixed(4)} d`);
  check('covered and missed transits for every N = 1..25 equal EXOTIC\'s stored scan and the numpy rule on the full 212433 cadences', diff.length === 0,
    `${R.intervals.length} runs of cadences; N = 5: ${scan.rows[4].covered} covered / ${scan.rows[4].missed} missed, N = 6: ${scan.rows[5].covered} / ${scan.rows[5].missed}; T14 within ${dT.toFixed(2)} s of numpy`);
  const iv = coverageIntervals([0, 0.01, 0.02, 0.5], 0.01);
  check('coverage intervals and covered length', iv.length === 2 && Math.abs(coveredLength(iv, -1, 1) - 0.04) < 1e-12 && Math.abs(coveredLength(iv, 0.0, 0.01) - 0.01) < 1e-12);
  const t90 = transitDuration(10, { rprs: 0.1, ars: 20 });
  check('duration at i = 90: P / pi asin((1 + k) / a)', Math.abs(t90 - (10 / Math.PI) * Math.asin(1.1 / 20)) < 1e-15);
}

// ---- 2. priors
{
  const pr = aliasPrior([1, 2, 3, 4, 7], 'geometric'), lw = (N) => Math.log(priorPdf(pr, N));
  check('geometric alias weights: ln w(7) - ln w(1) = (2/3) ln 7 = 1.297, the README\'s geom. prior column (-4.67 - (-5.96) = 1.29)', Math.abs(lw(7) - lw(1) - (2 / 3) * Math.log(7)) < 1e-12);
  const tf = makeTransform({ type: 'categorical', values: [1, 2, 3, 4, 7] }), c = {};
  for (let i = 0; i < 1000; i++) { const N = tf((i + 0.5) / 1000); c[N] = (c[N] || 0) + 1; }
  check('categorical transform: equal cells for equal weights; validatePrior', JSON.stringify(c) === '{"1":200,"2":200,"3":200,"4":200,"7":200}' && validatePrior(pr) === null && validatePrior({ type: 'categorical', values: [] }) !== null);
}

// ---- 3. sampling a categorical N against one run per N
{
  const S = 900, Ptrue = 300, rprs = 0.04, b = 0.3, ld = [0.4, 0.25];
  const arsT = arsFromKepler(Ptrue, 1, 0, 1), incT = Math.acos(b / arsT) * 180 / Math.PI;
  const f = makeTransit({ rprs, ars: arsT, inc: incT, per: Ptrue, tmid: 0, ecc: 0, omega: 0, ldLaw: 'quadratic', ld });
  const rng = makeRng(17), t = [], fl = [], e = [], sig = 4e-4;
  for (const tc of [0, S, 2 * S]) for (let x = -0.6; x <= 0.6; x += 10 / 1440) { t.push(tc + x); fl.push(f(tc + x) + sig * rng.normal()); e.push(sig); }
  const allowed = [1, 2, 3, 4, 7];
  const spec = { data: { t: Float64Array.from(t), f: Float64Array.from(fl), e: Float64Array.from(e) }, rv: [], timing: [], planets: [''], kepler: true, ldLaw: 'quadratic',
    values: { rprs, inc: 89.9, tmid: 0, ecc: 0, omega: 0, mplanet: 0, mstar: 1, rstar: 1, ld0: ld[0], ld1: ld[1], palias: S, nalias: 3 },
    free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.02, b: 0.07 } }, { key: 'inc', prior: { type: 'uniform', a: 89.3, b: 90 } }, { key: 'tmid', prior: { type: 'uniform', a: -0.03, b: 0.03 } },
      { key: 'palias', prior: { type: 'uniform', a: S - 0.02, b: S + 0.02 } }, { key: 'nalias', prior: aliasPrior(allowed) }],
    sampler: { nlive: 400, seed: 5 } };
  const t0 = performance.now();
  const mix = await runFit(spec, () => {}, () => false);
  const k = mix.keys.indexOf('nalias'), pMix = {}; let W = 0;
  for (let i = 0; i < mix.n; i++) { const N = mix.samples[i * mix.ndim + k]; pMix[N] = (pMix[N] || 0) + mix.weights[i]; W += mix.weights[i]; }
  const runs = [];
  for (const r of aliasRuns(spec, '', allowed)) { const res = await runFit(r.spec, () => {}, () => false); runs.push({ N: r.N, logZ: res.logZ, logZerr: res.logZerr }); }
  const comb = combineAliasEvidence(runs);
  const rows = comb.probs.map((q) => `N ${q.N}: ${(pMix[q.N] / W || 0).toFixed(3)} vs ${q.p.toFixed(3)} ± ${q.err.toFixed(3)}`);
  const worst = Math.max(...comb.probs.map((q) => Math.abs((pMix[q.N] / W || 0) - q.p) / Math.max(q.err, 0.02)));
  console.log('     ln Z per N: ' + runs.map((r) => `${r.N}: ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}`).join(', ') + `   (${((performance.now() - t0) / 1000).toFixed(0)} s for six runs)`);
  check('categorical N: posterior probability of every alias equals its evidence share from one run per N', worst < 3, rows.join('; '));
  check('categorical N: ln Z of the mixed run equals the prior-weighted mean of the per-N evidences', Math.abs(mix.logZ - comb.logZ) < 3 * Math.hypot(mix.logZerr, comb.logZerr) + 0.05, `${mix.logZ.toFixed(2)} ± ${mix.logZerr.toFixed(2)} against ${comb.logZ.toFixed(2)} ± ${comb.logZerr.toFixed(2)}`);
  const best = comb.probs.reduce((a, q) => (q.p > a.p ? q : a));
  check('the true alias (N = 3, P = 300 d) is the most probable', best.N === 3, `p(N = 3) = ${best.p.toFixed(3)}`);
  const bad = buildProblem({ ...spec, free: [], values: { ...spec.values, nalias: 2.5 } });
  check('a non-integer N is outside the prior', bad.loglike([]) < -1e99);
}

process.exit(ok ? 0 : 1);
