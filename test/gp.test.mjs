// Gaussian-process regression (src/core/gp.js) against scikit-learn's GaussianProcessRegressor with the kernel
// ConstantKernel * RBF(anisotropic) + WhiteKernel (reference: test/make_photometry_reference.py), and recovery of
// an injected intrapixel-style systematic.
import { readFileSync } from 'node:fs';
import { gpLogLike, gpPredict, gpFit, detrendWithCentroids, cholesky } from '../src/core/gp.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const G = JSON.parse(readFileSync(new URL('./photometry_reference.json', import.meta.url))).gp;
const n = G.X.length, d = 2, X = Float64Array.from(G.X.flat()), y = Float64Array.from(G.y), ns = G.Xs.length, Xs = Float64Array.from(G.Xs.flat());

// --- fixed hyperparameters: likelihood and prediction
{
  const hyper = { amp: G.fixed.amp, scales: G.fixed.scales, noise: G.fixed.noise };
  const lnL = gpLogLike(X, y, n, d, hyper);
  check('log marginal likelihood matches scikit-learn', Math.abs(lnL - G.fixed.lnL) < 1e-8, `${lnL.toFixed(6)} against ${G.fixed.lnL.toFixed(6)}, difference ${Math.abs(lnL - G.fixed.lnL).toExponential(1)}; tolerance 1e-8`);
  const p = gpPredict(X, y, n, d, hyper, Xs, ns, true, true);
  let wm = 0, ws = 0; for (let i = 0; i < ns; i++) { wm = Math.max(wm, Math.abs(p.mean[i] - G.fixed.mean[i])); ws = Math.max(ws, Math.abs(p.std[i] / G.fixed.std_with_noise[i] - 1)); }
  check('predictive mean matches scikit-learn', wm < 1e-11, `largest difference ${wm.toExponential(1)} on values of order 3e-3; tolerance 1e-11`);
  check('predictive standard deviation matches scikit-learn', ws < 1e-8, `largest relative difference ${ws.toExponential(1)}; tolerance 1e-8`);
}

// --- hyperparameters by maximum marginal likelihood
{
  const fit = gpFit(X, y, n, d, { maxEvals: 500 }), o = G.optimised;
  check('optimised likelihood reaches scikit-learn\'s optimum', fit.lnL > o.lnL - 0.05, `ln L = ${fit.lnL.toFixed(3)} here after ${fit.evals} evaluations, ${o.lnL.toFixed(3)} from L-BFGS-B with restarts; tolerance 0.05`);
  const p = gpPredict(X, y, n, d, fit.hyper, Xs, ns); let wm = 0; for (let i = 0; i < ns; i++) wm = Math.max(wm, Math.abs(p.mean[i] - o.mean[i]));
  const sd = Math.sqrt(y.reduce((a, b) => a + b * b, 0) / n);
  check('prediction with optimised hyperparameters matches', wm < 0.03 * sd, `largest difference ${wm.toExponential(1)}, ${(100 * wm / sd).toFixed(2)}% of the data's scatter; tolerance 3% (the likelihood is flat near its top)`);
  check('optimised hyperparameters', Math.abs(Math.log(fit.hyper.noise / o.noise)) < 0.05 && fit.hyper.scales.every((s, k) => Math.abs(Math.log(s / o.scales[k])) < 0.25), `amp ${fit.hyper.amp.toExponential(2)} (${o.amp.toExponential(2)}), scales ${fit.hyper.scales.map((s) => s.toFixed(3))} (${o.scales.map((s) => s.toFixed(3))}), noise ${fit.hyper.noise.toExponential(2)} (${o.noise.toExponential(2)}); tolerances 5% on the noise, 25% on the scales`);
}

// --- an injected position-dependent systematic is removed, and the sub-sampling path is exercised
{
  const rng = makeRng(11), N = 900, xs = new Float64Array(N), ys = new Float64Array(N), r = new Float64Array(N), sys = new Float64Array(N), white = 0.0006;
  for (let i = 0; i < N; i++) {
    xs[i] = 5.2 + 0.25 * Math.sin(i / 37) + 0.03 * rng.normal(); ys[i] = 7.5 + 0.2 * Math.cos(i / 53) + 0.03 * rng.normal();
    sys[i] = 0.004 * Math.sin(5 * (xs[i] - 5.2)) + 0.05 * (ys[i] - 7.5) ** 2;
    r[i] = sys[i] + white * rng.normal();
  }
  const t0 = performance.now(), out = detrendWithCentroids([xs, ys], r, null, { maxHyper: 250, maxCond: 600 }), dt = performance.now() - t0;
  let q = 0; const ms = sys.reduce((a, b) => a + b, 0) / N; let mt = 0; for (let i = 0; i < N; i++) mt += out.trend[i]; mt /= N;
  for (let i = 0; i < N; i++) q += (out.trend[i] - mt - (sys[i] - ms)) ** 2; q = Math.sqrt(q / N);
  check('GP trend recovers the injected systematic', q < 0.35 * white && out.rmsAfter < 1.1 * white && out.rmsBefore > 3 * white, `rms error of the trend ${(1e6 * q).toFixed(0)} ppm with white noise ${(1e6 * white).toFixed(0)} ppm; residual rms ${(1e6 * out.rmsBefore).toFixed(0)} -> ${(1e6 * out.rmsAfter).toFixed(0)} ppm; ${N} points, hyperparameters on ${out.nHyper}, conditioned on ${out.nCond}, ${dt.toFixed(0)} ms`);
  check('white noise is not absorbed', out.rmsAfter > 0.85 * white && Math.abs(out.hyper.noise / white - 1) < 0.15, `fitted noise ${(1e6 * out.hyper.noise).toFixed(0)} ppm`);
}

// --- cost of one factorisation
{
  const line = [];
  for (const m of [200, 500, 1000]) {
    const A = new Float64Array(m * m); for (let i = 0; i < m; i++) { for (let j = 0; j < i; j++) A[i * m + j] = Math.exp(-0.5 * ((i - j) / 30) ** 2); A[i * m + i] = 1.01; }
    const t = performance.now(); const good = cholesky(A, m); line.push(`n = ${m}: ${(performance.now() - t).toFixed(0)} ms${good ? '' : ' (failed)'}`);
  }
  check('Cholesky timing (informational)', true, line.join(', '));
}
process.exit(ok ? 0 : 1);
