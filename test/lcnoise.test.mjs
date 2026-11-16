// Light-curve jitter and dilution in buildProblem (src/core/model.js).
//   Jitter: the marginal likelihood (a1 integrated out) and chi-square at four points against a direct numerical
//   evaluation (test/make_lcnoise_reference.py: scipy quad over a1); the maximum-likelihood jitter of each epoch against
//   scipy's optimiser; recovery of an injected jitter by the sampler.
//   Dilution: the analytic depth scaling, depth(d) = depth(0) / (1 + d), at every point of a limb-darkened transit, and
//   the radius ratio recovered from a diluted light curve with and without the correction.
import { readFileSync } from 'node:fs';
import { buildProblem, activeParams } from '../src/core/model.js';
import { runFit } from '../src/core/fitRunner.js';
import { weightedQuantiles } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const R = JSON.parse(readFileSync(new URL('./lcnoise_reference.json', import.meta.url)));
const data = { t: Float64Array.from(R.data.t), f: Float64Array.from(R.data.f), e: Float64Array.from(R.data.e), epoch: Int32Array.from(R.data.epoch), segments: [{ name: 'night 1' }, { name: 'night 2' }] };
const base = { ...R.params, ecc: 0, omega: 0 };
const at = (j1, j2, d, free = []) => buildProblem({ data, values: { ...base, 'jitlc@1': j1, 'jitlc@2': j2, dil: d }, ldLaw: 'uniform', free, exptime: 0, supersample: 1 });

// ---- 1. likelihood against the direct evaluation
{
  let worst = 0, worstC = 0;
  for (const p of R.points) {
    const det = at(p.jit[0], p.jit[1], p.dil).detail([]);
    worst = Math.max(worst, Math.abs(det.lnL - p.lnL)); worstC = Math.max(worstC, Math.abs(det.chi2lc - p.chi2));
    console.log(`     jitter ${p.jit.join(', ')} ppm, d = ${p.dil}: ln L ${det.lnL.toFixed(6)} (numpy ${p.lnL.toFixed(6)}), chi2 ${det.chi2lc.toFixed(4)} (${p.chi2.toFixed(4)})`);
  }
  check('marginal ln L with jitter and dilution matches the direct integral over a1 (to 1e-5: the closed form subtracts sums of order 1e8)', worst < 1e-5, `largest difference ${worst.toExponential(2)} in ln L, ${worstC.toExponential(2)} in chi2 over ${R.points.length} points`);
  check('chi2 at the best a1 matches', worstC < 1e-5);
  const plain = at(0, 0, 0).detail([]), none = buildProblem({ data, values: base, ldLaw: 'uniform', free: [], exptime: 0, supersample: 1 }).detail([]);
  check('zero jitter and zero dilution give the likelihood without these terms', Math.abs(plain.lnL - none.lnL) < 1e-9 && Math.abs(plain.chi2 - none.chi2) < 1e-9, `${(plain.lnL - none.lnL).toExponential(1)}`);
  const one = buildProblem({ data, values: { ...base, jitlc: 900 }, ldLaw: 'uniform', free: [], exptime: 0, supersample: 1 }).detail([]), two = at(900, 900, 0).detail([]);
  check('a plain "jitlc" applies to every epoch without its own', Math.abs(one.lnL - two.lnL) < 1e-9 && one.lcJitter.join() === '900,900');
  const dj = at(1500, 600, 0).detail([]);
  let pen = 0; for (let i = 0; i < data.t.length; i++) { const j = (data.epoch[i] ? 600 : 1500) * 1e-6; pen += Math.log(1 + (j * j) / (data.e[i] * data.e[i])); }
  check('chi2ic carries sum ln(sigma^2 / e^2) of the jitter', Math.abs(dj.chi2ic - dj.chi2 - pen) < 1e-8, `penalty ${pen.toFixed(3)}`);
  check('a negative jitter or dilution at or below -1 is outside the prior', at(-1, 0, 0).detail([]) === null && at(0, 0, -1).detail([]) === null);
}

// ---- 2. maximum-likelihood jitter at the true transit and dilution
{
  const prob = at(0, 0, R.truth.dil, [{ key: 'jitlc@1', prior: { type: 'uniform', a: 0, b: 1e4 } }, { key: 'jitlc@2', prior: { type: 'uniform', a: 0, b: 1e4 } }]);
  const x = [1000, 1000], L = () => prob.loglike(x);
  const golden = (k) => { let a = 0, b = 5000; const g = (Math.sqrt(5) - 1) / 2; for (let it = 0; it < 80; it++) { const c = b - g * (b - a), d = a + g * (b - a); x[k] = c; const fc = L(); x[k] = d; const fd = L(); if (fc > fd) b = d; else a = c; } x[k] = 0.5 * (a + b); };
  for (let sweep = 0; sweep < 6; sweep++) { golden(0); golden(1); }
  const d0 = Math.abs(x[0] - R.ml_jitter[0]), d1 = Math.abs(x[1] - R.ml_jitter[1]);
  check('maximum-likelihood jitter of each epoch matches scipy', d0 < 0.5 && d1 < 0.5 && Math.abs(L() - R.ml_lnL) < 1e-5, `${x[0].toFixed(2)}, ${x[1].toFixed(2)} ppm vs ${R.ml_jitter.map((v) => v.toFixed(2)).join(', ')} (injected ${R.truth.jit.join(', ')}); ln L ${L().toFixed(6)} vs ${R.ml_lnL.toFixed(6)}`);
}

// ---- 3. the sampler recovers the injected jitter (transit free, dilution fixed at its true value)
{
  const free = [{ key: 'rprs', prior: { type: 'uniform', a: 0.05, b: 0.15 } }, { key: 'tmid', prior: { type: 'uniform', a: -0.02, b: 0.02 } },
    { key: 'jitlc@1', prior: { type: 'uniform', a: 0, b: 5000 } }, { key: 'jitlc@2', prior: { type: 'uniform', a: 0, b: 5000 } }];
  const r = await runFit({ data, values: { ...base, dil: R.truth.dil }, ldLaw: 'uniform', free, exptime: 0, supersample: 1, sampler: { nlive: 300, seed: 11 } }, () => {}, () => false);
  const q = (k) => { const col = Float64Array.from({ length: r.n }, (_, i) => r.samples[i * r.ndim + k]); const [lo, med, hi] = weightedQuantiles(col, r.weights, [0.1587, 0.5, 0.8413]); return { med, lo, hi, s: 0.5 * (hi - lo) }; };
  const j1 = q(2), j2 = q(3), rp = q(0), truth = [R.truth.jit[0], R.truth.jit[1]];
  check('injected jitter recovered within 3 sigma, both epochs', Math.abs(j1.med - truth[0]) < 3 * j1.s && Math.abs(j2.med - truth[1]) < 3 * j2.s && r.stopReason === 'converged',
    `epoch 1: ${j1.med.toFixed(0)} +${(j1.hi - j1.med).toFixed(0)} -${(j1.med - j1.lo).toFixed(0)} ppm (${truth[0]}); epoch 2: ${j2.med.toFixed(0)} +${(j2.hi - j2.med).toFixed(0)} -${(j2.med - j2.lo).toFixed(0)} ppm (${truth[1]})`);
  check('radius ratio with known dilution', Math.abs(rp.med - R.params.rprs) < 3 * rp.s, `${rp.med.toFixed(4)} ± ${rp.s.toFixed(4)} (0.1)`);
  // the same data fitted without the correction: the depth, Rp^2 / (1 + d) for a uniform star, is all that is measured
  const r0 = await runFit({ data, values: { ...base, 'jitlc@1': R.truth.jit[0], 'jitlc@2': R.truth.jit[1] }, ldLaw: 'uniform', free: free.slice(0, 2), exptime: 0, supersample: 1, sampler: { nlive: 300, seed: 12 } }, () => {}, () => false);
  const col = Float64Array.from({ length: r0.n }, (_, i) => r0.samples[i * r0.ndim]); const [lo, med, hi] = weightedQuantiles(col, r0.weights, [0.1587, 0.5, 0.8413]);
  const want = R.params.rprs / Math.sqrt(1 + R.truth.dil);
  check('without the correction Rp/R* comes out as Rp/R* / sqrt(1 + d)', Math.abs(med - want) < 3 * 0.5 * (hi - lo), `${med.toFixed(4)} ± ${(0.5 * (hi - lo)).toFixed(4)} vs ${want.toFixed(4)}`);
}

// ---- 4. dilution: analytic depth scaling of a limb-darkened, exposure-averaged transit
{
  const v = { rprs: 0.12, ars: 12, inc: 88, per: 4, tmid: 0, ecc: 0, omega: 0, ld0: 0.42, ld1: 0.21 };
  const t = Float64Array.from({ length: 401 }, (_, i) => -0.15 + 0.3 * i / 400), d0 = { t, f: new Float64Array(401).fill(1), e: new Float64Array(401).fill(1e-3) };
  const mk = (dil) => buildProblem({ data: d0, values: { ...v, dil }, ldLaw: 'quadratic', free: [], exptime: 10 / 1440, supersample: 7 }).detail([]).transit;
  const m0 = mk(0); let worst = 0;
  for (const d of [0.05, 0.5, 0.97, 3]) { const m = mk(d); for (let i = 0; i < t.length; i++) worst = Math.max(worst, Math.abs((1 - m[i]) - (1 - m0[i]) / (1 + d))); }
  const depth0 = 1 - m0[200];
  check('depth(d) = depth(0) / (1 + d) at every point', worst < 1e-15, `largest difference ${worst.toExponential(1)}; mid-transit depth ${(depth0 * 1e6).toFixed(1)} ppm -> ${(depth0 / 1.97 * 1e6).toFixed(1)} ppm at d = 0.97`);
  // TESS CROWDSAP = 1 / (1 + d): a contamination fraction D gives d = D / (1 - D)
  const D = 0.3, mD = mk(D / (1 - D));
  check('a contamination fraction D of the aperture light is d = D / (1 - D)', Math.abs((1 - mD[200]) - (1 - D) * depth0) < 1e-15);
}

// ---- 5. parameter list
{
  const one = activeParams('quadratic', false, { lcJitter: true, dilution: true }).filter((p) => p.group === 'baseline').map((p) => p.key);
  const three = activeParams('quadratic', [true, false, false], { lcJitter: true, dilution: true }).filter((p) => p.group === 'baseline').map((p) => p.key);
  check('activeParams lists jitlc and dil (one jitter per epoch)', one.join() === 'jitlc,dil' && three.join() === 'a2@1,jitlc@1,jitlc@2,jitlc@3,dil', `${one.join(' ')} | ${three.join(' ')}`);
}
process.exit(ok ? 0 : 1);
