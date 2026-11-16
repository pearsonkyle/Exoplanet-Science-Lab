import { MiniNest } from '../src/core/nested.js';
import { makeTransform } from '../src/core/priors.js';
import { weightedMeanStd, weightedQuantiles, makeRng, ndtri, normCdf } from '../src/core/stats.js';
import { buildProblem } from '../src/core/model.js';
import { transitModel } from '../src/core/transit.js';
import { runFit } from '../src/core/fitRunner.js';

function run(opts) { const ns = new MiniNest(opts); const t0 = performance.now(); while (!ns.step(200)); const r = ns.result(); r.sec = (performance.now() - t0)/1000; return r; }
const col = (r, k) => Float64Array.from({ length: r.n }, (_, i) => r.samples[i*r.ndim + k]);

// 1. correlated Gaussian in d dims, uniform prior on [-10,10]^d: analytic lnZ = -d ln 20
for (const d of [2, 5, 8]) {
  const sig = Array.from({ length: d }, (_, i) => 0.05 + 0.3*i/d), rho = 0.9;
  const loglike = (x) => { // x0,x1 correlated; rest independent
    let q = (x[0]/sig[0])**2 - 2*rho*(x[0]/sig[0])*(x[1]/sig[1]) + (x[1]/sig[1])**2; q /= (1 - rho*rho);
    let ln = -Math.log(2*Math.PI*sig[0]*sig[1]*Math.sqrt(1 - rho*rho));
    for (let i = 2; i < d; i++) { q += (x[i]/sig[i])**2; ln -= 0.5*Math.log(2*Math.PI*sig[i]*sig[i]); }
    return ln - 0.5*q;
  };
  const r = run({ ndim: d, loglike, transform: (u, x) => { for (let i = 0; i < d; i++) x[i] = -10 + 20*u[i]; }, nlive: 400, seed: 7 });
  const [m, s] = weightedMeanStd(col(r, 0), r.weights), [m2, s2] = weightedMeanStd(col(r, d-1), r.weights);
  console.log(`gauss d=${d}: lnZ=${r.logZ.toFixed(3)}±${r.logZerr.toFixed(3)} (true ${(-d*Math.log(20)).toFixed(3)})  x0 ${m.toFixed(4)}±${s.toFixed(4)} (true 0±${sig[0]})  x${d-1} ±${s2.toFixed(4)} (true ${sig[d-1].toFixed(4)})  calls=${r.ncalls} eff=${(r.niter/r.ncalls*100).toFixed(1)}% ess=${r.ess.toFixed(0)} insP=${r.insertionP.toFixed(3)} mode=${r.mode} ${r.sec.toFixed(2)}s`);
}
// 2. bimodal: two Gaussians, lnZ = ln(1) - 2 ln 20
{
  const g = (x, c) => -0.5*((x[0]-c)**2 + x[1]**2)/0.01 - Math.log(2*Math.PI*0.01);
  const r = run({ ndim: 2, loglike: (x) => Math.log(0.5*Math.exp(g(x, -4)) + 0.5*Math.exp(g(x, 4)) + 1e-300), transform: (u, x) => { x[0] = -10+20*u[0]; x[1] = -10+20*u[1]; }, nlive: 400, seed: 3 });
  const x0 = col(r, 0); let wl = 0; for (let i = 0; i < r.n; i++) if (x0[i] < 0) wl += r.weights[i];
  console.log(`bimodal: lnZ=${r.logZ.toFixed(3)}±${r.logZerr.toFixed(3)} (true ${(-2*Math.log(20)).toFixed(3)})  left-mode weight=${wl.toFixed(3)} (true 0.5) calls=${r.ncalls}`);
}
// 3. priors
{
  const rng = makeRng(5); const tn = makeTransform({ type: 'truncnormal', a: 1, b: 2, lo: 0, hi: 3 }), nm = makeTransform({ type: 'normal', a: 3, b: 0.5 }), lu = makeTransform({ type: 'loguniform', a: 1, b: 100 });
  let s = 0, s2 = 0, mn = 9, mx = -9, sl = 0; const n = 200000;
  for (let i = 0; i < n; i++) { const x = nm(rng.next()); s += x; s2 += x*x; const y = tn(rng.next()); mn = Math.min(mn, y); mx = Math.max(mx, y); sl += Math.log(lu(rng.next())); }
  console.log(`priors: normal mean ${(s/n).toFixed(4)} sd ${Math.sqrt(s2/n - (s/n)**2).toFixed(4)} | truncnormal range [${mn.toFixed(3)}, ${mx.toFixed(3)}] | loguniform <ln x>=${(sl/n).toFixed(4)} (true ${(Math.log(100)/2).toFixed(4)}) | ndtri(cdf(1.3))=${ndtri(normCdf(1.3)).toFixed(6)}`);
}
// 4. transit recovery (the real use case)
{
  const rng = makeRng(11), N = 400;
  const truth = { rprs: 0.1489, ars: 5.344, inc: 87.2, per: 2.1500082, tmid: 0.012, ecc: 0, omega: 0, ld0: 0.38, ld1: 0.27, a2: -0.012 };
  const t = Float64Array.from({ length: N }, (_, i) => -0.13 + 0.26*i/(N-1));
  const airmass = Float64Array.from(t, (x) => 1.05 + 6*(x + 0.02)**2);
  const pure = transitModel(t, { ...truth, ldLaw: 'quadratic', ld: [0.38, 0.27] });
  const f = Float64Array.from(pure, (m, i) => 1.003*m*Math.exp(truth.a2*airmass[i]) + 0.0015*rng.normal());
  const e = new Float64Array(N).fill(0.0015);
  const spec = { data: { t, f, e, airmass }, values: { ...truth, rprs: 0.12, tmid: 0, inc: 88, a2: 0 }, ldLaw: 'quadratic',
    free: [ { key: 'rprs', prior: { type: 'uniform', a: 0.05, b: 0.25 } }, { key: 'tmid', prior: { type: 'uniform', a: -0.03, b: 0.03 } },
            { key: 'inc', prior: { type: 'uniform', a: 82, b: 90 } }, { key: 'ars', prior: { type: 'normal', a: 5.344, b: 0.2 } }, { key: 'a2', prior: { type: 'uniform', a: -0.1, b: 0.1 } } ],
    sampler: { nlive: 400, seed: 1 } };
  const r = await runFit(spec, () => {}, () => false);
  console.log(`transit fit: ${r.ncalls} calls, ${r.elapsed.toFixed(2)} s, lnZ=${r.logZ.toFixed(2)}±${r.logZerr.toFixed(2)}, ess=${r.ess.toFixed(0)}, insP=${r.insertionP.toFixed(3)}, mode=${r.mode}, stop=${r.stopReason}`);
  r.keys.forEach((k, i) => { const q = weightedQuantiles(col(r, i), r.weights, [0.16, 0.5, 0.84]); console.log(`   ${k.padEnd(5)} ${q[1].toFixed(5)} +${(q[2]-q[1]).toFixed(5)} -${(q[1]-q[0]).toFixed(5)}   truth ${truth[k]}   (${((q[1]-truth[k])/((q[2]-q[0])/2)).toFixed(2)} σ)`); });
  const prob = buildProblem(spec), det = prob.detail(r.maxPoint);
  console.log(`   best fit chi2=${det.chi2.toFixed(1)} for N=${N}, a1=${det.a1.toFixed(5)} (truth 1.003)`);
}
