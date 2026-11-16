// Photometric detrending (src/core/detrend.js, and the regressor and kernel terms of buildProblem in src/core/model.js)
// against independent references:
//   numpy (lstsq, SVD) and a closed-form uniform-disc transit for PLD and the centroid polynomial, numpy lstsq for the
//   three-cornered-hat comparison weights (test/make_detrend_reference.py, .venv);
//   EXOTIC's own elca.gaussian_weights, weightedflux, transit and lc_fitter(features=..., mode='lm'), run read-only in its
//   conda environment (the same script with --exotic);
//   real data: the TESS target pixel file of WASP-18 (PLD) and EXOTIC's HAT-P-32 b frames (comparison ensemble).
// Tolerances are what the comparison measures plus headroom; each line prints its number. About 20 s.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { standardise, legendre, timePolynomial, buildRegressors, symEig, pldBasis, gaussianWeights, kernelSmooth, ensembleWeights, detrendFromColumns, alignColumns } from '../src/core/detrend.js';
import { buildProblem } from '../src/core/model.js';
import { fitTransitLsq } from '../src/photometry/transitfit.js';
import { openFits, readTargetPixelFile } from '../src/core/fits.js';
import { tpfLightCurve, pipelineMask, medianOf } from '../src/core/photometry.js';
import { splitFits, runStack } from '../src/photometry/pipeline.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./detrend_reference.json', import.meta.url)));
const ex = (v, d = 1) => (Number.isFinite(v) ? v.toExponential(d) : String(v)), max = (a) => a.reduce((m, v) => Math.max(m, v), -Infinity);
const S = ref.synthetic, n = S.t.length, F64 = (a) => Float64Array.from(a);
const t = F64(S.t), f = F64(S.f), e = F64(S.e), xc = F64(S.xc), yc = F64(S.yc), tr = F64(S.transit), pix = S.pix.map(F64);
const sys = S.system, values = { ...sys, ecc: 0, omega: 0, ld0: 0, ld1: 0, ld2: 0, ld3: 0, a2: 0 };
// one evaluation of buildProblem at the true transit (rprs free so there is something to evaluate)
const at = (data, rp = sys.rprs) => buildProblem({ data, values, ldLaw: 'nonlinear', free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.01, b: 0.3 } }] }).detail([rp]);

// ---- 0. the transit kernel at zero limb darkening is the closed-form uniform disc the references use
{ const d = at({ t, f, e }); let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(d.transit[i] - tr[i])); check('uniform-disc transit (closed form, numpy) equals buildProblem with zero limb darkening', m < 1e-9, `largest difference ${ex(m)}`); }

// ---- 1. building blocks
{
  const s = standardise(F64([1, 2, 3, 4, 10, 20, 30, 40]), Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1]));
  const want = [-3, -1, 1, 3].map((v) => v / Math.sqrt(5)); let d = 0; for (let i = 0; i < 8; i++) d = Math.max(d, Math.abs(s.x[i] - want[i % 4]));
  check('standardise: centred and unit variance within each epoch', d < 1e-15 && !s.constant, `largest error ${ex(d)}`);
  const P = [[0.3, -0.5, 0.25, -0.3375], [2, 3, 4, 5]], u = 0.5, lg = [legendre(0, u), legendre(1, u), legendre(2, u), legendre(3, u)], want2 = [1, 0.5, -0.125, -0.4375];
  check('Legendre polynomials by recursion', lg.every((v, i) => Math.abs(v - want2[i]) < 1e-15), lg.join(', ') + (P ? '' : ''));
  const tp = timePolynomial(F64([0, 1, 2, 3, 4]), 2); check('time polynomial: P1, P2 of time scaled to [-1, 1]', Math.abs(tp[0][0] + 1) < 1e-15 && Math.abs(tp[0][4] - 1) < 1e-15 && Math.abs(tp[1][2] + 0.5) < 1e-15, `P1 ${Array.from(tp[0]).join(' ')}; P2 at the middle ${tp[1][2]}`);
  // symmetric eigenproblem against a matrix with known eigenvalues (Q diag Q^T, Q a rotation)
  const A = [4, 1, 0.5, 1, 3, 0.25, 0.5, 0.25, 1], E = symEig(A, 3), tr3 = 8, det = 4 * (3 - 0.0625) - 1 * (1 - 0.125) + 0.5 * (0.25 - 1.5);
  const prod = E.values.reduce((a, v) => a * v, 1), sum = E.values.reduce((a, v) => a + v, 0);
  let orth = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s2 = 0; for (let k = 0; k < 3; k++) s2 += E.vectors[i][k] * E.vectors[j][k]; orth = Math.max(orth, Math.abs(s2 - (i === j ? 1 : 0))); }
  let resid = 0; for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) { let s2 = 0; for (let j = 0; j < 3; j++) s2 += A[i * 3 + j] * E.vectors[k][j]; resid = Math.max(resid, Math.abs(s2 - E.values[k] * E.vectors[k][i])); }
  check('Jacobi eigen-decomposition: trace, determinant, A v = lambda v, orthonormal vectors', Math.abs(sum - tr3) < 1e-13 && Math.abs(prod - det) < 1e-12 && resid < 1e-13 && orth < 1e-14, `|A v - lambda v| ${ex(resid)}, orthonormality ${ex(orth)}`);
}

// ---- 2. linear regressors in buildProblem: x, y, x^2, y^2, xy against numpy lstsq at the same transit
{
  const r = buildRegressors({ xc, yc }, { columns: ['xc', 'yc', 'xc2', 'yc2', 'xy'] });
  const d = at({ t, f, e, regressors: r.regressors }), want = ref.poly_xy.chi2, coef = ref.poly_xy.coef;
  const dc = max([Math.abs(d.a1s[0] - coef[0]), ...d.regCoeffs[0].map((c, k) => Math.abs(c - coef[k + 1]))]);
  check("centroid polynomial (x, y, x², y², xy): χ² and coefficients against numpy.linalg.lstsq", Math.abs(d.chi2 - want) / want < 1e-7 && dc < 1e-8, `χ² ${d.chi2.toFixed(3)} against ${want.toFixed(3)} (relative ${ex(Math.abs(d.chi2 - want) / want)}; no detrending ${ref.pld.chi2_no_detrend.toFixed(1)}); largest coefficient difference ${ex(dc)}`);
}

// ---- 3. pixel-level decorrelation
{
  const B = pldBasis(pix, { ncomp: 24 }), dAll = at({ t, f, e, regressors: B.regressors }), want = ref.pld.chi2_all_fractions;
  check('PLD: all principal components span the pixel fractions (Deming et al. 2015 regression, numpy lstsq)', Math.abs(dAll.chi2 - want) / want < 1e-7 && B.ncomp === ref.pld.rank - 0, `χ² ${dAll.chi2.toFixed(3)} against ${want.toFixed(3)} with all ${n > 0 ? 25 : 0} fractions; ${B.ncomp} components (numpy rank of the centred fractions ${ref.pld.rank})`);
  const rows = [];
  let worst = 0;
  for (const k of [1, 2, 3, 5, 8]) { const Bk = pldBasis(pix, { ncomp: k }), d = at({ t, f, e, regressors: Bk.regressors }), w = ref.pld.chi2_pcs[k]; worst = Math.max(worst, Math.abs(d.chi2 - w) / w); rows.push(`${k}: ${d.chi2.toFixed(1)}`); }
  check('PLD: leading k components against numpy SVD (k = 1, 2, 3, 5, 8)', worst < 1e-7, `χ² ${rows.join(', ')}; largest relative difference ${ex(worst)}; explained variance of the first three ${ref.pld.explained.slice(0, 3).map((v) => v.toFixed(3)).join(', ')}`);
  const auto = pldBasis(pix);
  check('PLD: default keeps the components that explain 99.9% of the variance', auto.ncomp >= 3 && auto.ncomp <= 12, `${auto.ncomp} components, explained ${auto.explained.reduce((a, b) => a + b, 0).toFixed(4)}`);
  // fit the transit with PLD (3 components) and without: depth recovered, scatter
  const planet = { ...sys, ecc: 0, omega: 0, ld: [0, 0, 0, 0], tmidUnc: 0.002 }, bounds = { tmid0: sys.tmid, rprs: [0.05, 0.15], tmid: [0.24, 0.26], inc: [84, 90], a2: [-1, 1] };
  const cols = Object.fromEntries(pldBasis(pix, { ncomp: 3 }).regressors.map((x, k) => ['pld' + (k + 1), x]));
  const f0 = fitTransitLsq(t, f, e, null, planet, { bounds }), f3 = fitTransitLsq(t, f, e, null, planet, { bounds, detrend: { columns: cols, spec: { pld: ['pld1', 'pld2', 'pld3'] } } });
  check('PLD in the transit fit: Rp/R★ recovered, scatter at the noise level', Math.abs(f3.params.rprs - sys.rprs) < 3 * f3.errors.rprs && f3.scatter < 1.15 * S.noise && f0.scatter > 2 * S.noise,
    `Rp/R★ ${f3.params.rprs.toFixed(5)} ± ${f3.errors.rprs.toFixed(5)} (injected ${sys.rprs}; without detrending ${f0.params.rprs.toFixed(5)}), scatter ${(1e6 * f0.scatter).toFixed(0)} → ${(1e6 * f3.scatter).toFixed(0)} ppm (injected white noise ${(1e6 * S.noise).toFixed(0)} ppm)`);
}

// ---- 4. nearest-neighbour Gaussian kernel regression against EXOTIC
const X = ref.exotic;
{
  const t0 = performance.now(), K = gaussianWeights([xc, yc], { neighbors: 50 }), ms = performance.now() - t0, K3 = gaussianWeights([xc, yc, Float64Array.from(xc, (v, i) => (v - 2) * (yc[i] - 2))], { neighbors: 30, w: [1, 1, 0.5] });
  const cmp = (K, gw, nb) => { let dw = 0, same = 0; for (let i = 0; i < gw.length; i++) { const mine = new Map(); for (let q = 0; q < K.k; q++) mine.set(K.idx[i * K.k + q], K.w[i * K.k + q]); let all = true; for (let q = 0; q < nb[i].length; q++) { const v = mine.get(nb[i][q]); if (v === undefined) { all = false; break; } dw = Math.max(dw, Math.abs(v - gw[i][q])); } if (all) same++; } return { dw, same }; };
  const c2 = cmp(K, X.gw, X.nearest), c3 = cmp(K3, X.gw3, X.nearest3);
  check("kernel weights: the same neighbours and weights as EXOTIC's gaussian_weights (2 features, k = 50)", c2.same === X.gw.length && c2.dw < 1e-13, `${c2.same} of ${X.gw.length} points have the same neighbour set; largest weight difference ${ex(c2.dw)}; ${ms.toFixed(0)} ms for n = ${n}`);
  check('kernel weights: 3 features with feature weights [1, 1, 0.5], k = 30', c3.same === X.gw3.length && c3.dw < 1e-13, `${c3.same} of ${X.gw3.length} points; largest weight difference ${ex(c3.dw)}`);
  // chi2 inside the likelihood at three parameter sets, a1 held at 1 as EXOTIC's lc2min_nneighbor does
  let worst = 0, worstT = 0, worstB = 0; const rows = [];
  for (const c of X.chi2_at) {
    const prob = buildProblem({ data: { t, f, e, kernel: K }, values: { ...values }, ldLaw: 'nonlinear', free: ['rprs', 'tmid', 'inc'].map((k) => ({ key: k, prior: { type: 'uniform', a: -10, b: 100 } })) });
    const d = prob.detail([c.rprs, c.tmid, c.inc]); let chi = 0, chiE = 0, dT = 0;
    const te = F64(c.transit), sE = kernelSmooth(Float64Array.from(f, (v, i) => v / te[i]), K);
    for (let i = 0; i < n; i++) { chi += ((f[i] - d.model[i]) / e[i]) ** 2; chiE += ((f[i] - te[i] * sE[i]) / e[i]) ** 2; dT = Math.max(dT, Math.abs(d.transit[i] - te[i])); }
    worst = Math.max(worst, Math.abs(chiE - c.chi2) / c.chi2); worstT = Math.max(worstT, dT); worstB = Math.max(worstB, Math.abs(chi - c.chi2) / c.chi2); rows.push(`${chi.toFixed(3)} (${c.chi2.toFixed(3)})`);
  }
  check("kernel: χ² of EXOTIC's own transit × kernelSmooth equals EXOTIC's lc2min_nneighbor at three parameter sets", worst < 1e-12, `largest relative difference ${ex(worst)}`);
  check("kernel in buildProblem: χ² against EXOTIC's at the same three sets (each with its own transit code)", worstB < 2e-4, `χ² ${rows.join(', ')}; largest relative difference ${ex(worstB)}, all from the transit models: EXOTIC's pytransit(precision=3) differs from this code's by up to ${ex(worstT)} in flux`);
  const ks = kernelSmooth(Float64Array.from(f, (v, i) => v / tr[i]), K), dk = at({ t, f, e, kernel: K }); let dmax = 0; for (let i = 0; i < n; i++) dmax = Math.max(dmax, Math.abs(dk.kernel[i] - ks[i]));
  check('kernel: detail().kernel is kernelSmooth(data / transit)', dmax < 1e-12, `largest difference ${ex(dmax)}`);
  // least-squares fit with the kernel against EXOTIC's lc_fitter(features=..., mode='lm'), which minimises sum(r^4) (HANDOFF, EXOTIC item 3)
  const planet = { ...sys, ecc: 0, omega: 0, ld: [0, 0, 0, 0] }, bounds = { tmid0: sys.tmid, rprs: [0.05, 0.15], tmid: [0.24, 0.26], inc: [84, 90], a2: [-1, 1] };
  const spec = { kernel: { features: ['xc', 'yc'], neighbors: 50 } };
  const fk = fitTransitLsq(t, f, e, null, planet, { bounds, detrend: { columns: { xc, yc }, spec } }), fe = fitTransitLsq(t, f, e, null, planet, { bounds, loss: 'exotic', detrend: { columns: { xc, yc }, spec } });
  const L = X.lm_fit, dR = Math.abs(fe.params.rprs - L.rprs), dT = Math.abs(fe.params.tmid - L.tmid) * 86400;
  check("kernel fit with EXOTIC's objective reproduces EXOTIC's lc_fitter", dR < 2e-4 && dT < 5, `Rp/R★ ${fe.params.rprs.toFixed(5)} (EXOTIC ${L.rprs.toFixed(5)}), T mid differs by ${dT.toFixed(1)} s, inc ${fe.params.inc.toFixed(3)} (${L.inc.toFixed(3)}); residual scatter ${(1e6 * fe.scatter).toFixed(1)} ppm (EXOTIC ${(1e6 * X.lm_res_std).toFixed(1)} ppm)`);
  check('kernel fit with χ²: Rp/R★ recovered', Math.abs(fk.params.rprs - sys.rprs) < 3 * fk.errors.rprs + 1e-3, `Rp/R★ ${fk.params.rprs.toFixed(5)} ± ${fk.errors.rprs.toFixed(5)}, inc ${fk.params.inc.toFixed(2)}, scatter ${(1e6 * fk.scatter).toFixed(0)} ppm (injected ${sys.rprs}, ${(1e6 * S.noise).toFixed(0)} ppm)`);
}

// ---- 5. comparison ensemble: three-cornered hat
{
  const E = ref.ensemble, comps = E.comps.map(F64), target = F64(E.target), trE = F64(E.transit);
  const W = ensembleWeights(comps, target), dw = max(W.weights.map((w, j) => Math.abs(w - E.weights[j])));
  check('ensemble weights against numpy lstsq of the pairwise ratio variances', dw < 1e-12, `weights ${W.weights.map((v) => v.toFixed(4)).join(' ')}; largest difference ${ex(dw)}`);
  const rel = max(W.sigma.map((s, j) => Math.abs(s / E.sigma_true[j] - 1)));
  check('three-cornered hat recovers each star\'s injected noise', rel < 0.15 && Math.abs(W.sigmaTarget / E.sigma_target_true - 1) < 0.15, `σ ${W.sigma.map((s) => (1e3 * s).toFixed(2)).join(' ')} ×1e-3 (injected ${E.sigma_true.map((s) => (1e3 * s).toFixed(1)).join(' ')}); target ${(1e3 * W.sigmaTarget).toFixed(2)} (${(1e3 * E.sigma_target_true).toFixed(1)}); worst ${(100 * rel).toFixed(1)}%`);
  const sc = (r) => { const q = Float64Array.from(r, (v, i) => v / trE[i]), m = medianOf(q); let s = 0, s2 = 0; for (const v of q) { s += v / m; s2 += (v / m) ** 2; } return Math.sqrt(s2 / q.length - (s / q.length) ** 2); };
  const sw = sc(Float64Array.from(target, (v, i) => v / W.comparison[i])), ssum = sc(Float64Array.from(target, (v, i) => v / comps.reduce((a, c) => a + c[i], 0))), sbest = Math.min(...comps.map((c) => sc(Float64Array.from(target, (v, i) => v / c[i]))));
  check('weighted ensemble scatters less than the plain sum and than the best single star', sw < ssum && sw < sbest && Math.abs(sw - E.scatter_weighted) < 1e-12, `${(1e3 * sw).toFixed(3)} against ${(1e3 * ssum).toFixed(3)} (sum) and ${(1e3 * sbest).toFixed(3)} (best single) ×1e-3; numpy ${(1e3 * E.scatter_weighted).toFixed(3)}`);
}

// ---- 6. the hand-off: columns to data.regressors and data.kernel in one call
{
  const D = detrendFromColumns({ xc, yc, sky: F64(S.t.map((v) => 100 + 5 * v)) }, { columns: ['xc', 'yc', 'sky', 'nothere'], poly: 2, kernel: { features: ['xc', 'yc'], neighbors: 20 } }, t);
  check('detrendFromColumns: named columns, time polynomial and kernel; unknown columns reported', D.names.join(',') === 'xc,yc,sky,P1(t),P2(t)' && D.kernel && D.kernel.k === 20 && D.dropped.length === 1 && D.dropped[0].name === 'nothere', `${D.names.join(', ')}; dropped ${D.dropped.map((x) => x.name + ' (' + x.why + ')').join(', ')}`);
  const src = F64([5.3, 5.1, 5.2, 5.2, 5.0]), A = alignColumns(src, { xc: [3, 1, 2, 9, 0] }, F64([5.0, 5.1, 5.2, 5.3, 5.4]));
  check('alignColumns: hand-off rows matched to the sorted, de-duplicated times', A.matched === 4 && Array.from(A.columns.xc).slice(0, 4).join(',') === '0,1,2,3' && Number.isNaN(A.columns.xc[4]), Array.from(A.columns.xc).join(', '));
  const c = buildRegressors({ c: new Float64Array(n).fill(3) }, { columns: ['c'] });
  check('a constant column is dropped instead of making the normal equations singular', c.regressors.length === 0 && c.dropped[0].why === 'constant within an epoch');
}

// ---- 7. real data: PLD on the TESS target pixel file of WASP-18
{
  const buf = readFileSync(new URL('./data/tess_wasp18_s02_sub_tp.fits', import.meta.url)), tpf = readTargetPixelFile(await openFits(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  const mask = pipelineMask(tpf), lc = tpfLightCurve(tpf, mask), np_ = tpf.nx * tpf.ny, good = []; for (let c = 0; c < lc.ok.length; c++) if (lc.ok[c]) good.push(c);
  const pidx = []; for (let p = 0; p < np_; p++) if (mask[p]) pidx.push(p);
  const time = Float64Array.from(good, (c) => lc.time[c]), flux = Float64Array.from(good, (c) => lc.flux[c]), med = medianOf(flux), fn = flux.map((v) => v / med);
  const pixS = pidx.map((p) => Float64Array.from(good, (c) => tpf.flux[c * np_ + p]));
  // WASP-18 b (Shporer et al. 2019): P = 0.94145223 d, T0 = 2458375.169883 BJD_TDB; out of transit and eclipse only, so the comparison is about systematics
  const P = 0.94145223, T0 = 2458375.169883, ph = Float64Array.from(time, (v) => ((((v - T0) / P) % 1) + 1.25) % 1 - 0.25), oot = Uint8Array.from(ph, (p) => (Math.abs(p) > 0.06 && Math.abs(p - 0.5) > 0.06 ? 1 : 0));
  const sel = []; for (let i = 0; i < oot.length; i++) if (oot[i]) sel.push(i);
  const T = Float64Array.from(sel, (i) => time[i] - Math.floor(time[0])), Fo = Float64Array.from(sel, (i) => fn[i]), Eo = new Float64Array(sel.length).fill(1e-3);
  const flat = { rprs: 1e-4, ars: 3.5, inc: 84.9, per: P, tmid: 0, ecc: 0, omega: 0, ld0: 0, ld1: 0, ld2: 0, ld3: 0 };
  const fitWith = (regs) => { const d = buildProblem({ data: { t: T, f: Fo, e: Eo, regressors: regs }, values: flat, ldLaw: 'nonlinear', free: [{ key: 'rprs', prior: { type: 'uniform', a: 0, b: 1 } }] }).detail([1e-4]); return Float64Array.from(Fo, (v, i) => v - d.base[i] * d.transit[i]); };
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length), hourRms = (r) => { const b = new Map(); T.forEach((tt, i) => { const k = Math.floor(tt * 24); if (!b.has(k)) b.set(k, []); b.get(k).push(r[i]); }); return rms([...b.values()].filter((a) => a.length > 10).map((a) => a.reduce((s, v) => s + v, 0) / a.length)); };
  const poly = timePolynomial(T, 3), r0 = fitWith(poly);
  const B = pldBasis(pixS.map((p) => Float64Array.from(sel, (i) => p[i])), { ncomp: 6 }), r1 = fitWith([...poly, ...B.regressors]);
  check('PLD on TESS (WASP-18, sector 2 cut-out): out-of-transit scatter with a cubic in time, then with 6 PLD components added', rms(r1) <= rms(r0) && hourRms(r1) < hourRms(r0),
    `${sel.length} cadences, ${pidx.length} pixels: per point ${(1e6 * rms(r0)).toFixed(0)} → ${(1e6 * rms(r1)).toFixed(0)} ppm, 1-hour bins ${(1e6 * hourRms(r0)).toFixed(1)} → ${(1e6 * hourRms(r1)).toFixed(1)} ppm`);
}

// ---- 8. real data: comparison ensemble on EXOTIC's HAT-P-32 b frames
{
  const R = JSON.parse(readFileSync(new URL('./exotic_photometry_reference.json', import.meta.url))), Pl = R.planet;
  const planet = { rprs: Pl.rprs, ars: Pl.aRs, inc: Pl.inc, per: Pl.pPer, tmid: Pl.midT, ecc: Pl.ecc, omega: Pl.omega, ld: R.ld, tmidUnc: Pl.midTUnc, perUnc: Pl.pPerUnc };
  const raw = readFileSync(new URL('./data/hatp32_exotic_sample.fits', import.meta.url)), sources = await splitFits(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'hatp32'), o0 = R.offsets[0];
  const cfg = { stars: R.stars.map(([x, y]) => ({ x: x - o0[0], y: y - o0[1] })), timeAt: 'exotic', target: { ra: Pl.ra, dec: Pl.dec }, site: R.site, apertures: R.apers, annuli: R.annuli, score: 'transit', planet };
  const res = await runStack(sources, cfg), rows = res.opt.tried.filter((r) => r.method === 'aperture');
  // all 142 frames of EXOTIC_sampledata-1.0.0 when they are at hand (ESL_EXOTIC_SAMPLE, as in exotic_photometry.test.mjs)
  const dir = process.env.ESL_EXOTIC_SAMPLE;
  if (dir && existsSync(dir)) {
    const names = readdirSync(dir).filter((x) => /\.fits?$/i.test(x)).sort(), files = names.map((x) => { const b = readFileSync(dir + '/' + x); return { name: x, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; });
    const full = await runStack(files, { ...cfg, stars: R.stars.map(([x, y]) => ({ x, y })) }), fr = full.opt.tried, bf = (c) => Math.min(...fr.filter((r) => r.comp === c).map((r) => r.scatter));
    check('HAT-P-32 b, all 142 frames: the weighted ensemble against the plain sum and the best single star (lowest scatter over every method)', bf('w') < bf(0), `weighted ${(100 * bf('w')).toFixed(4)}%, summed ${(100 * bf(0)).toFixed(4)}%, best single ${(100 * Math.min(bf(1), bf(2))).toFixed(4)}%, none ${(100 * bf(-1)).toFixed(4)}%; EXOTIC's own choice ${(100 * R.best.std).toFixed(4)}%`);
  } else console.log('skip HAT-P-32 b full frames: set ESL_EXOTIC_SAMPLE to the folder of the 142 FITS files of EXOTIC_sampledata-1.0.0');
  const best = (c) => Math.min(...rows.filter((r) => r.comp === c).map((r) => r.scatter));
  const bw = best('w'), bs = best(0), b1 = Math.min(best(1), best(2));
  const wr = rows.filter((r) => r.comp === 'w').reduce((a, b) => (b.scatter < a.scatter ? b : a));
  check('HAT-P-32 b (48 frames, 2 comparison stars): the weighted ensemble is one of the candidates; the search still takes the lowest scatter', Number.isFinite(bw) && res.opt.tried[res.opt.best].scatter === Math.min(...res.opt.tried.filter((r) => r.n >= 24).map((r) => r.scatter)), `lowest scatter over apertures and annuli: weighted ${(100 * bw).toFixed(4)}%, summed ${(100 * bs).toFixed(4)}%, best single ${(100 * b1).toFixed(4)}%; best overall ${res.opt.tried[res.opt.best].comp === 'w' ? 'weighted' : 'comp ' + res.opt.tried[res.opt.best].comp} (${res.opt.tried[res.opt.best].method}); weights of the best weighted row ${wr.weights.map((w) => w.toFixed(3)).join(', ')}`);
}

process.exit(ok ? 0 : 1);
