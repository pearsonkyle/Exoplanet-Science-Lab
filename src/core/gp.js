// Gaussian-process regression with a Gaussian (squared-exponential) kernel, used to remove the part of a light
// curve's residuals that follows the star's position on the detector (the way Spitzer intrapixel systematics
// are handled: flux residual as a smooth function of the x and y centroid, optionally of time too).
//
// Model.  r_i = g(x_i) + e_i, with x_i the d inputs of point i (x centroid, y centroid[, time]), g a zero-mean
// Gaussian process with covariance
//     k(x, x') = A^2 exp( -1/2 sum_d (x_d - x'_d)^2 / l_d^2 )
// and e_i independent Gaussian noise of standard deviation s. The d + 2 hyperparameters are the amplitude A,
// one length scale l_d per input (anisotropic, "ARD") and the white noise s.
//
// How the hyperparameters are chosen.  By maximising the log marginal likelihood
//     ln L = -1/2 r^T K^-1 r - 1/2 ln det K - n/2 ln 2 pi,     K = k(X, X) + s^2 I
// with Nelder-Mead in the logarithms of (A, l_1..l_d, s), started from A = std(r), l = the scatter of each
// input, s = std(r) / 2, restarted once from the optimum, and with the logs clamped to a box (below).
// Nothing is marginalised: these are point estimates, and the prediction's variance does not include their
// uncertainty.
//
// Cost.  One likelihood evaluation is one Cholesky factorisation: n^3 / 6 multiply-adds and n^2 doubles of
// memory. Measured in this implementation (plain JS, one thread, Node 22 on an Apple M-series laptop,
// test/gp.test.mjs prints it): 2 ms at n = 200, 27 ms at n = 500, 0.19 s at n = 1000; by the n^3 law about 1.5 s
// at n = 2000 and 32 MB of memory. The optimisation needs 100-250 evaluations, so the hyperparameters are
// fitted on at most `maxHyper` points (default 300, every k-th point), and the prediction conditions on at most
// `maxCond` points (default 1200), costing one factorisation plus n_cond operations per predicted point. Beyond
// those sizes the result is the "subset of data" approximation: exact for the subset, and good for smooth
// trends in position as long as the subset samples the range of centroids.
//
// No DOM. Checked against scikit-learn's GaussianProcessRegressor in test/gp.test.mjs.

const LN2PI = Math.log(2 * Math.PI);

/** In-place Cholesky of the lower triangle of the n x n matrix A (row-major). Returns false if not positive definite. */
export function cholesky(A, n) {
  for (let j = 0; j < n; j++) {
    const jn = j * n; let d = A[jn + j];
    for (let k = 0; k < j; k++) d -= A[jn + k] * A[jn + k];
    if (!(d > 0)) return false;
    d = Math.sqrt(d); A[jn + j] = d;
    for (let i = j + 1; i < n; i++) { const inn = i * n; let s = A[inn + j]; for (let k = 0; k < j; k++) s -= A[inn + k] * A[jn + k]; A[inn + j] = s / d; }
  }
  return true;
}
function solveLower(L, n, b) { for (let i = 0; i < n; i++) { let s = b[i]; const r = i * n; for (let k = 0; k < i; k++) s -= L[r + k] * b[k]; b[i] = s / L[r + i]; } return b; }
function solveUpperT(L, n, b) { for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[k]; b[i] = s / L[i * n + i]; } return b; }

/** Kernel value between row i of X (n x d, row-major) and row j of Y. hyper = { amp, scales[d], noise }. */
function kern(X, i, Y, j, d, inv, a2) { let q = 0; for (let k = 0; k < d; k++) { const u = (X[i * d + k] - Y[j * d + k]) * inv[k]; q += u * u; } return a2 * Math.exp(-0.5 * q); }

function factor(X, n, d, hyper) {
  const K = new Float64Array(n * n), inv = hyper.scales.map((l) => 1 / l), a2 = hyper.amp * hyper.amp, s2 = hyper.noise * hyper.noise;
  for (let i = 0; i < n; i++) { for (let j = 0; j < i; j++) K[i * n + j] = kern(X, i, X, j, d, inv, a2); K[i * n + i] = a2 + s2; }
  return cholesky(K, n) ? K : null;
}

/** Log marginal likelihood of the residuals y (length n) at inputs X (n x d, row-major) for hyper = { amp, scales, noise }. */
export function gpLogLike(X, y, n, d, hyper) {
  const L = factor(X, n, d, hyper); if (!L) return -Infinity;
  const a = solveLower(L, n, Float64Array.from(y)); let q = 0, ld = 0;
  for (let i = 0; i < n; i++) { q += a[i] * a[i]; ld += Math.log(L[i * n + i]); }
  return -0.5 * q - ld - 0.5 * n * LN2PI;
}

/**
 * Predictive mean (and, with withStd, standard deviation) at inputs Xs (ns x d), given the n training points.
 * The standard deviation is that of the latent function g; withNoise adds the white noise s^2 to the variance,
 * which is what scikit-learn returns when the kernel contains a WhiteKernel.
 */
export function gpPredict(X, y, n, d, hyper, Xs, ns, withStd = false, withNoise = false) {
  const L = factor(X, n, d, hyper); if (!L) throw new Error('GP covariance is not positive definite');
  const alpha = solveUpperT(L, n, solveLower(L, n, Float64Array.from(y)));
  const inv = hyper.scales.map((l) => 1 / l), a2 = hyper.amp * hyper.amp, mean = new Float64Array(ns), std = withStd ? new Float64Array(ns) : null, ks = new Float64Array(n);
  for (let i = 0; i < ns; i++) {
    let m = 0; for (let j = 0; j < n; j++) { ks[j] = kern(Xs, i, X, j, d, inv, a2); m += ks[j] * alpha[j]; }
    mean[i] = m;
    if (withStd) { solveLower(L, n, ks); let v = a2 + (withNoise ? hyper.noise * hyper.noise : 0); for (let j = 0; j < n; j++) v -= ks[j] * ks[j]; std[i] = Math.sqrt(Math.max(0, v)); }
  }
  return { mean, std };
}

/** Nelder-Mead minimiser of f over R^m from x0 with initial step `step`. Returns { x, f, evals }. */
export function nelderMead(f, x0, step = 0.7, maxEvals = 300, tol = 1e-5) {
  const m = x0.length, P = [x0.slice()], F = [f(x0)]; let evals = 1;
  for (let i = 0; i < m; i++) { const p = x0.slice(); p[i] += step; P.push(p); F.push(f(p)); evals++; }
  const cen = new Array(m), pt = (a, b, t) => a.map((v, i) => v + t * (b[i] - v));
  while (evals < maxEvals) {
    const o = F.map((v, i) => i).sort((a, b) => F[a] - F[b]), lo = o[0], hi = o[m], nh = o[m - 1];
    if (Math.abs(F[hi] - F[lo]) < tol * (1 + Math.abs(F[lo]))) break;
    cen.fill(0); for (const i of o.slice(0, m)) for (let k = 0; k < m; k++) cen[k] += P[i][k] / m;
    const xr = pt(cen, P[hi], -1), fr = f(xr); evals++;
    if (fr < F[lo]) { const xe = pt(cen, P[hi], -2), fe = f(xe); evals++; if (fe < fr) { P[hi] = xe; F[hi] = fe; } else { P[hi] = xr; F[hi] = fr; } }
    else if (fr < F[nh]) { P[hi] = xr; F[hi] = fr; }
    else {
      const xc = fr < F[hi] ? pt(cen, xr, 0.5) : pt(cen, P[hi], 0.5), fc = f(xc); evals++;
      if (fc < Math.min(fr, F[hi])) { P[hi] = xc; F[hi] = fc; }
      else for (const i of o.slice(1)) { P[i] = pt(P[lo], P[i], 0.5); F[i] = f(P[i]); evals++; }
    }
  }
  let b = 0; for (let i = 1; i <= m; i++) if (F[i] < F[b]) b = i;
  return { x: P[b], f: F[b], evals };
}

/**
 * Choose the hyperparameters by maximum marginal likelihood (see the top of this file).
 * Bounds on the logs: A in [1e-3, 1e3] std(y); l_d in [0.05, 100] times the scatter of input d; s in [1e-3, 10] std(y).
 * @returns { hyper: { amp, scales, noise }, lnL, evals }
 */
export function gpFit(X, y, n, d, opts = {}) {
  const { maxEvals = 250 } = opts;
  let my = 0; for (let i = 0; i < n; i++) my += y[i]; my /= n; let sy = 0; for (let i = 0; i < n; i++) sy += (y[i] - my) * (y[i] - my); sy = Math.sqrt(sy / n) || 1;
  const sx = new Array(d).fill(0);
  for (let k = 0; k < d; k++) { let m = 0; for (let i = 0; i < n; i++) m += X[i * d + k]; m /= n; let q = 0; for (let i = 0; i < n; i++) q += (X[i * d + k] - m) * (X[i * d + k] - m); sx[k] = Math.sqrt(q / n) || 1; }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toHyper = (th) => ({ amp: sy * Math.exp(clamp(th[0], -6.9, 6.9)), scales: sx.map((s, k) => s * Math.exp(clamp(th[1 + k], -3, 4.6))), noise: sy * Math.exp(clamp(th[1 + d], -6.9, 2.3)) });
  const nll = (th) => { const v = -gpLogLike(X, y, n, d, toHyper(th)); return Number.isFinite(v) ? v : 1e300; };
  const start = [Math.log(1), ...new Array(d).fill(0), Math.log(0.5)];
  let r = nelderMead(nll, start, 0.7, Math.ceil(maxEvals * 0.6));
  const r2 = nelderMead(nll, r.x, 0.3, Math.ceil(maxEvals * 0.4));
  const evals = r.evals + r2.evals; if (r2.f < r.f) r = r2;
  return { hyper: toHyper(r.x), lnL: -r.f, evals };
}

/**
 * Detrend residuals against the centroid.
 * @param inputs  array of d arrays (x centroid, y centroid[, time]), each of length N
 * @param resid   residual flux (data / model - 1 or data - model), length N
 * @param keep    optional Uint8Array: points to use (others are predicted but not fitted)
 * @param opts    { maxHyper = 300, maxCond = 1200, maxEvals = 250 }
 * @returns { trend (length N: the GP mean at every point, plus the residual mean), hyper, lnL, nHyper, nCond,
 *            rmsBefore, rmsAfter (of the kept points), evals }
 */
export function detrendWithCentroids(inputs, resid, keep = null, opts = {}) {
  const { maxHyper = 300, maxCond = 1200, maxEvals = 250 } = opts, d = inputs.length, N = resid.length;
  const idx = []; for (let i = 0; i < N; i++) if ((!keep || keep[i]) && Number.isFinite(resid[i]) && inputs.every((v) => Number.isFinite(v[i]))) idx.push(i);
  if (idx.length < 10) return null;
  const mean = idx.reduce((a, i) => a + resid[i], 0) / idx.length;
  const pick = (m) => { if (idx.length <= m) return idx; const o = []; for (let k = 0; k < m; k++) o.push(idx[Math.floor(k * idx.length / m)]); return o; };
  const build = (ii) => { const X = new Float64Array(ii.length * d), y = new Float64Array(ii.length); ii.forEach((i, r) => { for (let k = 0; k < d; k++) X[r * d + k] = inputs[k][i]; y[r] = resid[i] - mean; }); return { X, y, n: ii.length }; };
  const h = build(pick(maxHyper)), fit = gpFit(h.X, h.y, h.n, d, { maxEvals });
  const c = build(pick(maxCond)), Xs = new Float64Array(N * d);
  for (let i = 0; i < N; i++) for (let k = 0; k < d; k++) { const v = inputs[k][i]; Xs[i * d + k] = Number.isFinite(v) ? v : 0; }
  const pred = gpPredict(c.X, c.y, c.n, d, fit.hyper, Xs, N), trend = new Float64Array(N);
  let b = 0, a = 0;
  for (let i = 0; i < N; i++) trend[i] = inputs.every((v) => Number.isFinite(v[i])) ? pred.mean[i] + mean : NaN;
  for (const i of idx) { b += (resid[i] - mean) * (resid[i] - mean); a += (resid[i] - trend[i]) * (resid[i] - trend[i]); }
  return { trend, hyper: fit.hyper, lnL: fit.lnL, nHyper: h.n, nCond: c.n, n: idx.length, rmsBefore: Math.sqrt(b / idx.length), rmsAfter: Math.sqrt(a / idx.length), evals: fit.evals };
}
