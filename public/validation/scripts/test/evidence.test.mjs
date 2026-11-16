// Is ln Z right? Compare the sampler with brute-force quadrature of likelihood x prior
// on real transit likelihoods, and check that the reported error matches the run-to-run scatter.
import { runFit } from '../src/core/fitRunner.js';
import { buildProblem } from '../src/core/model.js';
import { synthesize } from '../src/core/data.js';
import { logAddExp } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const truth = { rprs: 0.1, ars: 9, inc: 87.5, per: 3.2, tmid: 0, ecc: 0, omega: 0, ld0: 0.4, ld1: 0.25, a2: 0 };
const data = synthesize(truth, 'quadratic', { n: 150, noisePpm: 800, windowT14: 1.3, airmass: false, seed: 9 });
const P = { rprs: { type: 'uniform', a: 0.05, b: 0.2 }, tmid: { type: 'uniform', a: -0.02, b: 0.02 }, inc: { type: 'normal', a: 87.5, b: 0.4 } };
const spec = (keys) => ({ data, values: { ...truth, rprs: 0.09 }, ldLaw: 'quadratic', free: keys.map((k) => ({ key: k, prior: P[k] })) });

// reference: midpoint rule in the unit cube (the prior transform makes the prior density 1 there), optionally
// restricted to a box [lo, hi] that holds the posterior. In three dimensions a grid over the whole cube puts only
// about 11 points across the posterior and was 0.18 low (1639.835 against 1640.016, the latter stable between
// 120^3 and 170^3 points in the box and 200^3 in a box twice as wide); the box is used there.
function gridLnZ(keys, n, lo, hi) {
  const prob = buildProblem(spec(keys)), d = keys.length, u = new Float64Array(d), th = new Float64Array(d), idx = new Array(d).fill(0);
  lo = lo || new Array(d).fill(0); hi = hi || new Array(d).fill(1);
  let lz = -Infinity, vol = 0; for (let k = 0; k < d; k++) vol += Math.log(hi[k] - lo[k]);
  for (;;) {
    for (let k = 0; k < d; k++) u[k] = lo[k] + (hi[k] - lo[k]) * (idx[k] + 0.5) / n;
    prob.transform(u, th); lz = logAddExp(lz, prob.loglike(th));
    let k = 0; while (k < d && ++idx[k] === n) idx[k++] = 0;
    if (k === d) break;
  }
  return lz - d * Math.log(n) + vol;
}
for (const [keys, n, lo, hi] of [[['rprs'], 20000], [['rprs', 'tmid'], 700], [['rprs', 'tmid', 'inc'], 110, [0.2875, 0.4375, 0.05], [0.3875, 0.5625, 0.975]]]) {
  const ref = gridLnZ(keys, n, lo, hi), ref2 = gridLnZ(keys, Math.round(n * 0.7), lo, hi);
  const runs = [];
  for (let seed = 1; seed <= 6; seed++) runs.push(await runFit({ ...spec(keys), sampler: { nlive: 400, seed } }, () => {}, () => false));
  const z = runs.map((r) => r.logZ), m = z.reduce((a, b) => a + b) / z.length, sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1)), err = runs.reduce((a, r) => a + r.logZerr, 0) / runs.length;
  const pulls = runs.map((r) => (r.logZ - ref) / r.logZerr);
  check(`${keys.join('+')}: sampler vs quadrature`, Math.abs(m - ref) < 3 * err / Math.sqrt(runs.length) + 0.02 && Math.max(...pulls.map(Math.abs)) < 3.5,
    `quadrature ${ref.toFixed(3)} (grid check ${(ref - ref2).toExponential(1)})  sampler mean ${m.toFixed(3)}  scatter ${sd.toFixed(3)}  reported ±${err.toFixed(3)}  pulls ${pulls.map((p) => p.toFixed(1)).join(' ')}`);
}
// Bayes factor sanity: data simulated with a transit must prefer the transit model over a flat line
{
  const withT = await runFit({ ...spec(['rprs', 'tmid']), sampler: { nlive: 400, seed: 3 } }, () => {}, () => false);
  const flat = buildProblem({ ...spec([]), values: { ...truth, rprs: 1e-6 } }).loglike([]);
  check('transit model strongly preferred over no transit', withT.logZ - flat > 50, `Δ ln Z = ${(withT.logZ - flat).toFixed(1)}`);
}
process.exit(ok ? 0 : 1);
