// Detrending in sessions: specFromSession / runSession (src/core/session.js) rebuild the systematics model a session
// stores (light_curve.columns + light_curve.detrend, docs/FORMAT.md) the way the analyzer does on import
// (main.js importSession -> setData -> applyDetrend), so a session re-run headlessly or from Python is fitted with
// its regressors and kernel instead of without them.
//   1. The regressors of the session equal columns standardised by hand within each epoch plus a Legendre P1 in
//      time, and the likelihood equals buildProblem on the analyzer's own path.
//   2. runSession recovers the injected planet with the regressors; without them the systematics bias it.
//   3. A column with a missing value is dropped as in the analyzer; a kernel model reaches buildProblem.
// `node test/sessiondetrend.test.mjs --write <file>` also writes the session (for the browser check in the README).
import { writeFileSync } from 'node:fs';
import { buildProblem } from '../src/core/model.js';
import { specFromSession, runSession, FORMAT } from '../src/core/session.js';
import { applyDetrend } from '../src/core/data.js';
import { makeTransit } from '../src/core/transit.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// ---- a two-night light curve with centroid and sky systematics
const rng = makeRng(17), tRef = 2460000, P = { rprs: 0.1, ars: 9, inc: 88, per: 2.5, tmid: 0.2, ecc: 0, omega: 0 };
const tr = makeTransit({ ...P, ldLaw: 'quadratic', ld: [0.4, 0.25] });
const t = [], epoch = [], xc = [], yc = [], sky = [];
for (let s = 0; s < 2; s++) { let x = 0, y = 0; for (let i = 0; i < 260; i++) { t.push(P.tmid + s * P.per - 0.13 + 0.26 * i / 259); epoch.push(s); x += 0.05 * rng.normal(); y += 0.05 * rng.normal(); xc.push(512.3 + x + 0.3 * s); yc.push(300.1 + y); sky.push(40 + 5 * Math.sin(i / 40) + rng.normal()); } }
const n = t.length, std = (a) => { const out = new Float64Array(n); for (let s = 0; s < 2; s++) { const idx = [...Array(n).keys()].filter((i) => epoch[i] === s), m = idx.reduce((q, i) => q + a[i], 0) / idx.length, sd = Math.sqrt(idx.reduce((q, i) => q + (a[i] - m) ** 2, 0) / idx.length); for (const i of idx) out[i] = (a[i] - m) / sd; } return out; };
const p1 = (() => { const out = new Float64Array(n); for (let s = 0; s < 2; s++) { const idx = [...Array(n).keys()].filter((i) => epoch[i] === s), lo = Math.min(...idx.map((i) => t[i])), hi = Math.max(...idx.map((i) => t[i])); for (const i of idx) out[i] = (t[i] - 0.5 * (lo + hi)) / (0.5 * (hi - lo)); } return out; })();
const X = std(xc), Y = std(yc), coef = [[0.004, -0.003, 0.002], [-0.002, 0.0035, -0.0015]], a1 = [1.002, 0.997];
const flux = t.map((ti, i) => { const c = coef[epoch[i]]; return tr(ti) * (a1[epoch[i]] + c[0] * X[i] + c[1] * Y[i] + c[2] * p1[i]) + 8e-4 * rng.normal(); });
const detrend = { columns: ['xc', 'yc'], poly: 1, pld: [], kernel: null };
const session = (det, cols = { xc, yc, sky }) => JSON.parse(JSON.stringify({
  format: FORMAT, version: 1, name: 'detrend test', star: { teff: 5600, rstar: 1, mstar: 1 }, limb_darkening: { law: 'quadratic', mode: 'coeffs', coefficients: [0.4, 0.25] },
  planets: [{ letter: 'b', parameters: { ...P, tmid: P.tmid + tRef } }], kepler: false, time_reference: tRef,
  data: { light_curve: { name: 'two nights', time: t.map((x) => x + tRef), flux, flux_err: new Array(n).fill(8e-4), airmass: null, exposure_min: 0, epoch, epochs: [{ name: 'n1', airmass: false }, { name: 'n2', airmass: false }], columns: cols, detrend: det }, radial_velocity: [], timing: [] },
  fit: { use: { lc: true }, free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.05, b: 0.15 } }, { key: 'tmid', prior: { type: 'uniform', a: tRef + 0.18, b: tRef + 0.22 } }], fixed: {}, sampler: { nlive: 250, seed: 3 } }, result: null }));
const doc = session(detrend);
if (process.argv.includes('--write')) writeFileSync(process.argv[process.argv.indexOf('--write') + 1], JSON.stringify(doc));

// ---- 1. the regressors and the likelihood
{
  const spec = specFromSession(doc), R = spec.data.regressors || [];
  let w = 0; for (const [k, ref] of [X, Y, p1].entries()) for (let i = 0; i < n; i++) w = Math.max(w, Math.abs(R[k][i] - ref[i]));
  check('session regressors = centroids standardised per epoch + Legendre P1(t)', R.length === 3 && spec.data.detrendInfo.names.join() === 'xc,yc,P1(t)' && w < 1e-8, `${spec.data.detrendInfo.names.join(", ")}; largest difference (times through JD 2460000 and back) ${w.toExponential(1)}`);
  const det = buildProblem({ ...spec, free: [] }).detail([]);
  const hand = buildProblem({ ...spec, data: { t: spec.data.t, f: spec.data.f, e: spec.data.e, epoch: spec.data.epoch, segments: spec.data.segments, regressors: [X, Y, p1] }, free: [] }).detail([]);
  // the analyzer's path: importSession builds the light curve (columns: null -> NaN) and setData applies applyDetrend
  const L = doc.data.light_curve, lc = { name: L.name, tRef, t: Float64Array.from(L.time, (x) => x - tRef), f: Float64Array.from(L.flux), e: Float64Array.from(L.flux_err), airmass: null,
    columns: Object.fromEntries(Object.entries(L.columns).map(([nm, a]) => [nm, Float64Array.from(a, (x) => (x === null ? NaN : x))])), detrend: L.detrend, epoch: Int32Array.from(L.epoch), segments: spec.data.segments };
  const app = buildProblem({ ...spec, data: applyDetrend(lc, lc.detrend), free: [] }).detail([]);
  const plain = buildProblem({ ...specFromSession(session(null)), free: [] }).detail([]);
  check('likelihood equals hand-built regressors and the analyzer\'s import path', Math.abs(det.lnL - hand.lnL) < 1e-5 && det.lnL === app.lnL,
    `ln L ${det.lnL.toFixed(6)} (hand-built ${(hand.lnL - det.lnL).toExponential(1)} away, analyzer path ${(app.lnL - det.lnL).toExponential(1)}); chi2 ${det.chi2.toFixed(2)} for ${n} points, ${plain.chi2.toFixed(2)} without the regressors`);
  check('fitted regressor coefficients are the injected ones', det.regCoeffs.every((c, s) => c.every((x, k) => Math.abs(x / det.a1s[s] - coef[s][k] / a1[s]) < 4e-4)),
    det.regCoeffs.map((c, s) => c.map((x) => (x / det.a1s[s]).toFixed(4)).join(' ')).join(' | ') + ' (relative to a1)');
}

// ---- 2. runSession
{
  const out = await runSession(doc), r = out.session.result, q = Object.fromEntries(r.parameters.map((p) => [p.key, p]));
  const out0 = await runSession(session(null)), q0 = Object.fromEntries(out0.session.result.parameters.map((p) => [p.key, p]));
  const s = 0.5 * (q.rprs.plus + q.rprs.minus), s0 = 0.5 * (q0.rprs.plus + q0.rprs.minus);
  check('runSession fits with the session\'s regressors and recovers Rp/R*', r.converged && Math.abs(q.rprs.median - P.rprs) < 3 * s && Math.abs(r.chi2 - buildProblem({ ...out.spec, values: { ...out.spec.values, rprs: r.best.rprs, tmid: r.best.tmid - tRef }, free: [] }).detail([]).chi2) < 1e-6,
    `Rp/R* ${q.rprs.median.toFixed(4)} ± ${s.toFixed(4)} (0.1), chi2 ${r.chi2.toFixed(1)}; without detrending ${q0.rprs.median.toFixed(4)} ± ${s0.toFixed(4)}, chi2 ${out0.session.result.chi2.toFixed(1)}`);
  check('the evidence prefers the session with its systematics model', r.logZ > out0.session.result.logZ + 10, `ln Z ${r.logZ.toFixed(1)} vs ${out0.session.result.logZ.toFixed(1)}`);
}

// ---- 3. missing values, kernel
{
  const yNull = yc.slice(); yNull[10] = null;
  const sp = specFromSession(session(detrend, { xc, yc: yNull, sky }));
  check('a column with a missing value is dropped, as in the analyzer', sp.data.detrendInfo.names.join() === 'xc,P1(t)' && sp.data.detrendInfo.dropped.some((d) => d.name === 'yc'), JSON.stringify(sp.data.detrendInfo.dropped));
  const sk = specFromSession(session({ columns: [], poly: 0, pld: [], kernel: { features: ['xc', 'yc'], neighbors: 30 } }));
  const dk = buildProblem({ ...sk, free: [] }).detail([]);
  check('a kernel model in the session reaches buildProblem', sk.data.kernel && sk.data.kernel.n === n && sk.data.kernel.k === 30 && dk.kernel && dk.kernel.length === n, `k = ${sk.data.kernel && sk.data.kernel.k}, chi2 ${dk.chi2.toFixed(1)}`);
  const none = specFromSession(session(null));
  check('columns without a detrending model leave the baseline alone', !none.data.regressors && !none.data.kernel);
}
process.exit(ok ? 0 : 1);
