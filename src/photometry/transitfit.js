// Least-squares fit of the real transit model to a candidate light curve, the equivalent of EXOTIC's
// fit_lightcurve (exotic/exotic.py) + lc_fitter(mode='lm') (exotic/api/elca.py): the model is
//     flux = a1 * exp(a2 * airmass) * transit(t; Rp/R*, T_mid, inclination | a/R*, P, e, omega, limb darkening)
// with Rp/R*, T_mid, inclination and a2 free inside EXOTIC's bounds. The likelihood comes from buildProblem
// (src/core/model.js), which solves a1 analytically; nothing of the model is duplicated here. No DOM.
//
// Two deliberate differences from EXOTIC, both stated in the README:
//  * EXOTIC hands scipy's least_squares the SQUARED normalised residuals, so it minimises sum(r^4), not chi^2
//    (elca.py, lc2min_airmass returns ((data - model) / dataerr) ** 2). The default here is chi^2;
//    { loss: 'exotic' } reproduces EXOTIC's objective for comparisons.
//  * EXOTIC's outlier clip takes its scatter from random draws (np.random.choice); here it is 1.4826 x the median
//    absolute deviation of the same Savitzky-Golay residuals, which is deterministic.
import { buildProblem } from '../core/model.js';
import { savgol2, medianOf } from '../core/photometry.js';
import { detrendFromColumns } from '../core/detrend.js';

function solve(A, b, n) {            // Gaussian elimination with partial pivoting; returns x or null
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/**
 * Bounded Levenberg-Marquardt for a residual vector: minimises sum(resid(x)^2) inside lo <= x <= hi.
 * Jacobian by central differences (one-sided at a bound), variables held at a bound while the gradient pushes
 * outward, steps clamped to the box.
 * @param resid (x) => array of residuals, or null where the model is not defined
 * @returns { x, cost (sum of squares), iters, evals, jtj (at the solution, rows of arrays), active (variables at a bound) }
 */
export function lmMinimise(resid, x0, lo, hi, opts = {}) {
  const { maxIter = 60, xtol = 1e-9, ftol = 1e-12 } = opts, n = x0.length;
  let x = x0.map((v, i) => Math.min(hi[i], Math.max(lo[i], v))), r = resid(x), evals = 1;
  if (!r) return { x, cost: Infinity, iters: 0, evals, jtj: null, active: [] };
  const sq = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return s; };
  let cost = sq(r), lambda = 1e-3, iters = 0, JtJ = null, fixed = [];
  const m = r.length, J = Array.from({ length: n }, () => new Float64Array(m));
  for (; iters < maxIter; iters++) {
    for (let i = 0; i < n; i++) {
      const w = hi[i] - lo[i], h = Number.isFinite(w) && w > 0 ? 1e-5 * w : 1e-6 * Math.max(1, Math.abs(x[i]));
      const xp = x.slice(), xm = x.slice(); xp[i] = Math.min(hi[i], x[i] + h); xm[i] = Math.max(lo[i], x[i] - h);
      const rp = resid(xp), rm = resid(xm); evals += 2;
      const a = rp || r, b = rm || r, den = (rp ? xp[i] : x[i]) - (rm ? xm[i] : x[i]);
      for (let k = 0; k < m; k++) J[i][k] = den ? (a[k] - b[k]) / den : 0;
    }
    const g = new Array(n).fill(0); JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) { for (let k = 0; k < m; k++) g[i] += J[i][k] * r[k]; for (let j = 0; j <= i; j++) { let s = 0; for (let k = 0; k < m; k++) s += J[i][k] * J[j][k]; JtJ[i][j] = JtJ[j][i] = s; } }
    fixed = []; const free = [];
    for (let i = 0; i < n; i++) { if ((x[i] <= lo[i] && g[i] > 0) || (x[i] >= hi[i] && g[i] < 0)) fixed.push(i); else free.push(i); }
    if (!free.length) break;
    let improved = false;
    for (let tries = 0; tries < 14; tries++) {
      const A = free.map((i) => free.map((j) => JtJ[i][j] * (i === j ? 1 + lambda : 1) + (i === j ? 1e-300 : 0))), d = solve(A, free.map((i) => -g[i]), free.length);
      if (!d) { lambda *= 10; continue; }
      const xt = x.slice(); free.forEach((i, q) => { xt[i] = Math.min(hi[i], Math.max(lo[i], x[i] + d[q])); });
      const rt = resid(xt); evals++;
      const ct = rt ? sq(rt) : Infinity;
      if (ct < cost) {
        let big = 0; for (let i = 0; i < n; i++) { const w = hi[i] - lo[i]; big = Math.max(big, Math.abs(xt[i] - x[i]) / (Number.isFinite(w) && w > 0 ? w : Math.max(1e-12, Math.abs(x[i])))); }
        const rel = (cost - ct) / (cost || 1);
        x = xt; r = rt; cost = ct; lambda = Math.max(1e-10, lambda / 10); improved = true;
        if (big < xtol || rel < ftol) iters = maxIter;       // converged: leave after this step
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, cost, iters: Math.min(iters, maxIter), evals, jtj: JtJ, active: fixed };
}

/**
 * EXOTIC's outlier rejection before a fit (exotic.py sigma_clip called from fit_lightcurve): residuals about a
 * Savitzky-Golay smooth of order 2 over `win` points; points more than `nsig` scatter away are dropped.
 * @returns Uint8Array keep (1 = kept); non-finite values are dropped
 */
export function savgolClip(y, win, nsig = 3) {
  const n = y.length, keep = new Uint8Array(n), idx = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(y[i])) { keep[i] = 1; idx.push(i); }
  if (!(win > 2) || win > idx.length) return keep;
  const v = Float64Array.from(idx, (i) => y[i]), sm = savgol2(v, win | 1), res = v.map((u, k) => u - sm[k]);
  const med = medianOf(res), sd = 1.4826 * medianOf(res.map((u) => Math.abs(u - med)));
  if (!(sd > 0)) return keep;
  idx.forEach((i, k) => { if (Math.abs(res[k]) > nsig * sd) keep[i] = 0; });
  return keep;
}

/** The bounds EXOTIC puts on a fit (fit_lightcurve): tmid about the predicted transit of this night, Rp/R* in [0, 1.25 prior], inclination +-5 deg (<= 90), a2 in [-1, 1]. */
export function exoticBounds(planet, tmin, tmax) {
  const n = Math.floor((tmax - planet.tmid) / planet.per), tm = planet.tmid + n * planet.per;
  let w = Math.abs(25 * (planet.tmidUnc || 0) + n * 25 * (planet.perUnc || 0));
  if (!(w > 0) || w > 0.25 * planet.per) w = 0.25 * planet.per;
  return { tmid0: tm, epoch: n, inWindow: tm >= tmin && tm <= tmax, rprs: [0, 1.25 * planet.rprs], tmid: [tm - w, tm + w], inc: [planet.inc - 5, Math.min(90, planet.inc + 5)], a2: [-1, 1] };
}

/**
 * Fit the transit model to one light curve.
 * @param t, f, e   times (any Julian-date style, days), flux, flux uncertainty (any scale; only relative weights matter for the fit)
 * @param airmass   array or null (then a2 is not fitted and the baseline is a constant)
 * @param planet    { rprs, ars, inc, per, tmid, ecc, omega, ld: [four Claret coefficients], tmidUnc, perUnc }
 * @param opts      { keep (Uint8Array), loss: 'chi2' | 'exotic', bounds (from exoticBounds), exptime [d] and supersample for exposure averaging (EXOTIC does none),
 *                    detrend: { columns: { name: array }, spec: { columns, poly, pld, kernel } } (src/core/detrend.js detrendFromColumns; linear regressors
 *                    and the nearest-neighbour kernel go into buildProblem, so they are fitted with the transit) }
 * @returns { params: { rprs, tmid, inc, a1, a2 }, errors (formal, from the curvature, scaled by sqrt(chi2 / dof); NaN at a bound),
 *            model, baseline, transit, resid (all length n, NaN where not kept... see keep), keep, chi2, n, scatter, robust, atBound: [names] }
 */
export function fitTransitLsq(t, f, e, airmass, planet, opts = {}) {
  const n = t.length, keep = opts.keep ? Uint8Array.from(opts.keep) : new Uint8Array(n).fill(1);
  // detrending (src/core/detrend.js): opts.detrend = { columns: { name: array of length n }, spec: { columns: [names], poly, pld: [names], kernel: { features, neighbors } } }
  const dt = opts.detrend && opts.detrend.spec ? opts.detrend : null, dcol = dt ? dt.columns : {};
  const needCols = dt ? [...(dt.spec.columns || []).flatMap((c) => (c === 'xy' || c === 'xc2' || c === 'yc2' ? ['xc', 'yc'] : [c])), ...(dt.spec.pld || []), ...((dt.spec.kernel && dt.spec.kernel.features) || [])] : [];
  // every finite point is modelled; the ones not kept get a weight of nothing (with a kernel they are left out: they would be someone's neighbours)
  const idx = []; let nk = 0; for (let i = 0; i < n; i++) { if (Number.isFinite(t[i]) && Number.isFinite(f[i]) && f[i] > 0 && Number.isFinite(e[i]) && e[i] > 0 && (!airmass || Number.isFinite(airmass[i])) && needCols.every((c) => !dcol[c] || Number.isFinite(dcol[c][i])) && (keep[i] || !(dt && dt.spec.kernel))) { idx.push(i); if (keep[i]) nk++; } else keep[i] = 0; }
  if (nk < 6) return null;
  let tRef = Infinity, tMax = -Infinity; for (const i of idx) { if (t[i] < tRef) tRef = t[i]; if (t[i] > tMax) tMax = t[i]; }
  const B = opts.bounds || exoticBounds(planet, tRef, tMax); tRef = Math.floor(tRef);
  const data = { t: Float64Array.from(idx, (i) => t[i] - tRef), f: Float64Array.from(idx, (i) => f[i]), e: Float64Array.from(idx, (i) => (keep[i] ? e[i] : e[i] * 1e9)), airmass: airmass ? Float64Array.from(idx, (i) => airmass[i]) : null };
  let detrendInfo = null;
  if (dt) {
    const sub = Object.fromEntries(Object.entries(dcol).filter(([, a]) => a && a.length === n).map(([k, a]) => [k, Float64Array.from(idx, (i) => a[i])]));
    const d = detrendFromColumns(sub, dt.spec, data.t, null);
    if (d.regressors) data.regressors = d.regressors;
    if (d.kernel) data.kernel = d.kernel;
    detrendInfo = { names: d.names, kernel: !!d.kernel, neighbors: d.kernel ? d.kernel.k : 0, dropped: d.dropped };
  }
  const keys = airmass ? ['rprs', 'tmid', 'inc', 'a2'] : ['rprs', 'tmid', 'inc'];
  const lo = [B.rprs[0] + 1e-6, B.tmid[0] - tRef, B.inc[0], B.a2[0]].slice(0, keys.length), hi = [B.rprs[1], B.tmid[1] - tRef, B.inc[1], B.a2[1]].slice(0, keys.length);
  const ld = planet.ld || [0, 0, 0, 0];
  const prob = buildProblem({ data, ldLaw: 'nonlinear', exptime: opts.exptime || 0, supersample: opts.supersample || 1,
    values: { rprs: planet.rprs, ars: planet.ars, inc: planet.inc, per: planet.per, tmid: B.tmid0 - tRef, ecc: planet.ecc || 0, omega: planet.omega || 0, ld0: ld[0], ld1: ld[1], ld2: ld[2], ld3: ld[3], a2: 0 },
    free: keys.map((k, i) => ({ key: k, prior: { type: 'uniform', a: lo[i], b: hi[i] } })) });
  const m = idx.length, exotic = opts.loss === 'exotic', rv = new Float64Array(m);
  let resid, x0 = [Math.min(hi[0], Math.max(lo[0], planet.rprs)), B.tmid0 - tRef, Math.min(hi[2], Math.max(lo[2], planet.inc)), 0].slice(0, keys.length), l2 = lo, h2 = hi;
  if (!exotic) resid = (x) => { const d = prob.detail(x); if (!d) return null; for (let k = 0; k < m; k++) rv[k] = (data.f[k] - d.base[k] * d.transit[k]) / data.e[k]; return Float64Array.from(rv); };
  else {
    // EXOTIC's objective: a1 is a fifth free parameter (start: the mean flux, bounds [0.5 min, 2 max]) and the "residuals" are squared
    let s = 0, mn = Infinity, mx = -Infinity; for (let k = 0; k < m; k++) { if (!keep[idx[k]]) continue; s += data.f[k]; mn = Math.min(mn, data.f[k]); mx = Math.max(mx, data.f[k]); }
    x0 = [...x0, s / nk]; l2 = [...lo, 0.5 * mn]; h2 = [...hi, 2 * mx];
    resid = (x) => { const d = prob.detail(x.slice(0, keys.length)); if (!d) return null; const a1 = x[keys.length]; for (let k = 0; k < m; k++) { const q = (data.f[k] - a1 * d.model[k]) / data.e[k]; rv[k] = q * q; } return Float64Array.from(rv); };
  }
  const sol = lmMinimise(resid, x0, l2, h2, opts.lm || {}), d = prob.detail(sol.x.slice(0, keys.length));
  if (!d) return null;
  const a1 = exotic ? sol.x[keys.length] : d.a1, model = new Float64Array(n).fill(NaN), baseline = new Float64Array(n).fill(NaN), transit = new Float64Array(n).fill(NaN), res = new Float64Array(n).fill(NaN);
  let chi2 = 0; const kept = [];
  // the model is a1 x baseline systematics x transit in EXOTIC's loss; with the chi2 loss the integrated-out a1 and regressor coefficients (d.base)
  idx.forEach((i, k) => { const ex = d.model[k] / d.transit[k]; baseline[i] = exotic ? a1 * ex : d.base[k]; transit[i] = d.transit[k]; model[i] = exotic ? a1 * d.model[k] : d.base[k] * d.transit[k]; res[i] = f[i] - model[i]; if (keep[i]) { chi2 += (res[i] / e[i]) ** 2; kept.push(res[i]); } });
  let mean = 0; for (const v of kept) mean += v; mean /= nk; let q = 0; for (const v of kept) q += (v - mean) * (v - mean);
  const fm = medianOf(idx.filter((i) => keep[i]).map((i) => f[i])), rm = medianOf(kept), mad = 1.4826 * medianOf(kept.map((v) => Math.abs(v - rm)));
  const params = { rprs: sol.x[0], tmid: sol.x[1] + tRef, inc: sol.x[2], a1, a2: airmass ? sol.x[3] : 0 };
  // formal errors: inverse of J^T J over the variables not at a bound, scaled by chi2 / dof (chi2 loss only)
  const errors = { rprs: NaN, tmid: NaN, inc: NaN, a2: NaN };
  if (!exotic && sol.jtj) {
    const free = keys.map((_, i) => i).filter((i) => !sol.active.includes(i) && sol.x[i] > lo[i] && sol.x[i] < hi[i]), dof = Math.max(1, nk - free.length - 1);
    free.forEach((i, qi) => { const col = solve(free.map((a) => free.map((b) => sol.jtj[a][b])), free.map((_, k) => (k === qi ? 1 : 0)), free.length); if (col && col[qi] > 0) errors[keys[i]] = Math.sqrt(col[qi] * chi2 / dof); });
  }
  const atBound = keys.filter((_, i) => sol.x[i] <= lo[i] + 1e-12 * Math.abs(lo[i]) || sol.x[i] >= hi[i] - 1e-12 * Math.abs(hi[i]));
  let nIn = 0; for (const i of idx) if (keep[i] && transit[i] < 1) nIn++;
  return { params, errors, model, baseline, transit, resid: res, keep, chi2, n: nk, scatter: Math.sqrt(q / nk) / fm, robust: mad / fm, depth: params.rprs * params.rprs, atBound, evals: sol.evals, iters: sol.iters, bounds: B, nInTransit: nIn, detrend: detrendInfo, regCoeffs: d.regCoeffs || null };
}

/**
 * A fitter for optimise() and lightCurveFor() (src/core/photometry.js) that scores a candidate the way EXOTIC
 * does: sort by time, clip outliers about a Savitzky-Golay smooth (window: the odd number of points nearest 50
 * minutes, at least 5), photon-noise weights sqrt(flux) propagated to the ratio, then fitTransitLsq; the score is
 * std(residuals) / median(flux).
 * @param planet see fitTransitLsq; opts { loss, weights: 'photon' (EXOTIC) | 'equal' }
 */
export function makeTransitFitter(planet, opts = {}) {
  return (time, R, ctx = {}) => {
    const n = time.length, order = Array.from({ length: n }, (_, i) => i).filter((i) => Number.isFinite(time[i])).sort((a, b) => time[a] - time[b]);
    const empty = { model: new Float64Array(n).fill(NaN), baseline: new Float64Array(n).fill(NaN), resid: new Float64Array(n).fill(NaN), keep: new Uint8Array(n), scatter: Infinity, robust: Infinity, depth: 0, tmid: NaN, duration: NaN, hasTransit: false, coef: [], n: 0 };
    if (order.length < 8) return empty;
    const dt = (time[order[order.length - 1]] - time[order[0]]) / (order.length - 1);
    let ndt = Math.floor(25 / 1440 / dt) * 2 + 1; if (ndt > order.length) ndt = Math.floor(order.length / 4) * 2 + 1;
    const ks = savgolClip(Float64Array.from(order, (i) => R[i]), Math.max(5, ndt), 3), keep = new Uint8Array(n);
    order.forEach((i, k) => { keep[i] = ks[k]; });
    const e = new Float64Array(n), T = ctx.target, C = ctx.comp;
    for (let i = 0; i < n; i++) {
      if (opts.weights === 'equal' || !T) e[i] = 1;
      else if (ctx.noComp) e[i] = Math.sqrt(T[i]);
      else e[i] = Math.sqrt(T[i] / (C[i] * C[i]) + T[i] * T[i] / (C[i] * C[i] * C[i]));
    }
    const fit = fitTransitLsq(time, R, e, ctx.airmass || null, planet, { keep, loss: opts.loss });
    if (!fit) return empty;
    let nIn = 0, cad = dt; for (let i = 0; i < n; i++) if (fit.keep[i] && fit.transit[i] < 1) nIn++;
    return { model: fit.model, baseline: fit.baseline, resid: fit.resid, keep: fit.keep, scatter: fit.scatter, robust: fit.robust, depth: fit.depth, tmid: fit.params.tmid, duration: nIn * cad, hasTransit: true, coef: [], n: fit.n, usedAirmass: !!ctx.airmass, params: fit.params, errors: fit.errors, atBound: fit.atBound, transit: fit.transit, chi2: fit.chi2, kind: 'transit' };
  };
}
