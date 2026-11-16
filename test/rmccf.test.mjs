// Rossiter–McLaughlin options (src/core/rm.js, spec.rm in buildProblem): the CCF form, exposure averaging, the spectrograph's
// own limb darkening, a catalogue v sin i prior.
//   1. The out-of-transit CCF width beta_0 and the CCF anomaly against a brute-force disc integration with Gaussian fits in
//      scipy (test/make_rm_ccf_reference.py): v sin i / beta = 0.57 to 4, with and without macroturbulence, two obliquities,
//      two planet sizes, six positions on the chord. The first moment (the default) is checked against the same pixels.
//   2. Exposure averaging against a 4001-point average of the instantaneous anomaly.
//   3. buildProblem: spec.rm.method 'ccf', rv[d].exptime, spec.rm.ld, and the truncated-normal v sin i prior.
import { readFileSync } from 'node:fs';
import { rmAnomaly, rmAnomalyCCF, ccfWidth, ccfFit, ccfWidthTable, makeRM, vsiniPrior, trueObliquity } from '../src/core/rm.js';
import { prepareLD, toClaret } from '../src/core/limbdark.js';
import { buildProblem } from '../src/core/model.js';
import { makeTransform } from '../src/core/priors.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const R = JSON.parse(readFileSync(new URL('./rm_ccf_reference.json', import.meta.url)));

// ---- 1. CCF
{
  const ld = prepareLD(toClaret('quadratic', R.cases[0].u)), tab = ccfWidthTable(ld);
  const groups = new Map();
  for (const c of R.cases) { const k = `${c.vsini}/${c.beta}/${c.zeta}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const rows = []; let worstW = 0, worstC = 0, worstM = 0, worstUncorr = 0;
  for (const [k, cs] of groups) {
    const c0 = cs[0], bp = Math.sqrt(c0.beta ** 2 + 0.5 * c0.zeta ** 2), fit = ccfFit(c0.vsini, bp, ld), b0 = fit.beta0, b0t = tab(c0.vsini, bp).beta0;
    worstW = Math.max(worstW, Math.abs(b0 - c0.beta0) / c0.beta0, Math.abs(b0t - c0.beta0) / c0.beta0);
    let amp = 0, dC = 0, dM = 0, dU = 0;
    for (const c of cs) {
      const ccf = rmAnomalyCCF(c.X, c.Y, c.p, ld, c.vsini, c.lam, { betaP: bp, beta0: b0, gain: fit.gain }), mom = rmAnomaly(c.X, c.Y, c.p, ld, c.vsini, c.lam);
      amp = Math.max(amp, Math.abs(c.dv_ccf)); dC = Math.max(dC, Math.abs(ccf - c.dv_ccf)); dM = Math.max(dM, Math.abs(mom - c.dv_moment) / Math.max(1e-9, Math.abs(c.dv_moment))); dU = Math.max(dU, Math.abs(mom - c.dv_ccf));
    }
    worstC = Math.max(worstC, dC / amp); worstM = Math.max(worstM, dM); worstUncorr = Math.max(worstUncorr, dU / amp);
    rows.push(`v sin i ${c0.vsini}, β ${c0.beta}${c0.zeta ? `, ζ ${c0.zeta}` : ''}: β0 ${b0.toFixed(3)} (scipy ${c0.beta0.toFixed(3)}) km/s, gain ${fit.gain.toFixed(4)}; CCF anomaly within ${(100 * dC / amp).toFixed(2)}% of the largest, first moment off by ${(100 * dU / amp).toFixed(1)}%`);
  }
  console.log('     ' + rows.join('\n     '));
  check('out-of-transit CCF width beta_0 (direct and tabulated) against the scipy Gaussian fit of the pixel profile', worstW < 2e-3, `largest relative difference ${worstW.toExponential(1)}`);
  check('CCF anomaly (linearised Gaussian fit) against the scipy fit of the in-transit pixel profile, 120 cases', worstC < 0.03, `largest difference ${(100 * worstC).toFixed(2)}% of the largest anomaly of each setting`);
  check('first moment (default method) against the same pixels', worstM < 2e-3, `largest relative difference ${worstM.toExponential(1)} (pixel discretisation)`);
  check('the CCF correction matters once v sin i approaches the line width', worstUncorr > 0.1, `the first moment misses the Gaussian-fit centre by up to ${(100 * worstUncorr).toFixed(0)}% of the anomaly`);
}

// ---- 2. exposure averaging
{
  const p = { rprs: 0.1, per: 3, tmid: 0, ars: 8, inc: 87, ecc: 0, omega: 0, vsini: 5, lambda: 30, ldLaw: 'quadratic', ld: [0.45, 0.25] };
  const inst = makeRM(p), ex = 20 / 1440, avg = makeRM({ ...p, exptime: ex, supersample: 7 }), rows = []; let worst = 0, amp = 0;
  for (let t = -0.08; t <= 0.08; t += 0.004) {
    let s = 0; const n = 4001; for (let j = 0; j < n; j++) s += inst(t + ((j + 0.5) / n - 0.5) * ex); s /= n;
    worst = Math.max(worst, Math.abs(avg(t) - s)); amp = Math.max(amp, Math.abs(inst(t)));
  }
  const smear = Math.max(...Array.from({ length: 41 }, (_, i) => -0.08 + 0.004 * i).map((t) => { let s = 0; for (let j = 0; j < 4001; j++) s += inst(t + ((j + 0.5) / 4001 - 0.5) * ex); return Math.abs(s / 4001 - inst(t)); }));
  check('exposure averaging (20 min, 7 sub-samples) against a 4001-point average', worst < 0.01 * smear + 0.05, `largest difference ${worst.toFixed(3)} m/s; the exposure changes the anomaly by up to ${smear.toFixed(2)} m/s of ${amp.toFixed(1)}`);
}

// ---- 3. buildProblem
{
  const per = 3, t = Float64Array.from({ length: 60 }, (_, i) => -0.1 + (0.2 * i) / 59);
  const base = { rprs: 0.1, per, tmid: 0, ars: 8, inc: 87, ecc: 0, omega: 0, K: 0, ld0: 0.3, ld1: 0.2, vsini: 6, lambda: 30, rvlin: 0, rvquad: 0 };
  const ldRM = [0.6, 0.15], ex = 15 / 1440;
  const truth = makeRM({ ...base, ldLaw: 'quadratic', ld: ldRM, method: 'ccf', beta: 3, zeta: 2, exptime: ex, supersample: 5 });
  const rv = [{ name: 'spec', t, v: Float64Array.from(t, truth), e: new Float64Array(60).fill(1), exptime: ex }];
  const spec = { data: null, rv, timing: [], planets: [''], ldLaw: 'quadratic', values: base, free: [], rm: { ldLaw: 'quadratic', ld: ldRM, method: 'ccf', beta: 3, zeta: 2, supersample: 5 } };
  const d = buildProblem(spec).detail([]);
  const plain = buildProblem({ ...spec, rm: { ldLaw: 'quadratic', ld: ldRM } }).detail([]);
  check('buildProblem with rm.method "ccf", the spectrograph\'s limb darkening and the dataset\'s exposure reproduces makeRM', d.chi2 < 0.01, `χ² ${d.chi2.toExponential(1)} for 60 points at 1 m/s (beta_0 from the table instead of the direct fit; first moment, instantaneous: χ² ${plain.chi2.toFixed(0)} at 1 m/s errors)`);
  let threw = false; try { buildProblem({ ...spec, rm: { method: 'ccf' } }); } catch { threw = true; }
  check('method "ccf" without beta is refused', threw);
  const pr = vsiniPrior({ vsini: 1.7, vsiniErr: 0.3 }), tf = makeTransform(pr);
  check('catalogue v sin i prior: normal truncated at 0', pr.type === 'truncnormal' && Math.abs(tf(0.5) - 1.7) < 1e-6 && tf(1e-12) >= 0 && Math.abs(tf(0.8413447) - 2.0) < 1e-5);
  check('true obliquity: aligned star and orbit give 0, i* = 90 gives psi = lambda for an edge-on orbit', trueObliquity(0, 90, 90) < 1e-6 && Math.abs(trueObliquity(42, 90, 90) - 42) < 1e-9);
}

// ---- 4. the session's "rm" block
{
  const { specFromSession } = await import('../src/core/session.js');
  const sp = specFromSession({ format: 'esl-session', version: 1, planets: [{ letter: 'b', parameters: { per: 3, tmid: 0, rprs: 0.1, ars: 8, inc: 87 } }], fit: { free: [] },
    rm: { ld_law: 'quadratic', ld: [0.6, 0.15], method: 'ccf', beta: 3, exposure_min: 15 } });
  check('session "rm" block: ld_law, method, beta and exposure_min reach spec.rm', sp.rm.ldLaw === 'quadratic' && sp.rm.method === 'ccf' && sp.rm.beta === 3 && Math.abs(sp.rm.exptime - 15 / 1440) < 1e-15 && !('exposure_min' in sp.rm));
}

process.exit(ok ? 0 : 1);
