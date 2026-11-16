// K2 systematics: the spacecraft rolls about its boresight under solar pressure and the thrusters fire every 6 h to
// bring it back, so the star slides along an arc on the detector and the flux follows the pixel response.
// Two corrections are offered besides the self-flat-field (photometry.js sffDetrend):
//   thrusterFlags  the cadences of a thruster firing, from QUALITY bits 20 and 21 and from jumps of the centroid
//                  along the roll arc (Vanderburg & Johnson 2014 drop them before the fit).
//   pldCorrect     pixel-level decorrelation as EVEREST (Luger et al. 2016, 2018) and lightkurve's PLDCorrector do it:
//                  the fractional pixel fluxes, their products up to `order` (principal components at each order),
//                  principal components of the background pixels, and a B-spline in time for the star itself, fitted
//                  together by least squares with Gaussian priors on the coefficients and iterative 5σ clipping; the
//                  pixel and background parts are removed, the spline (stellar variability, the transits' context) is
//                  kept. Transits are masked out of the fit with `cadenceMask`.
// No DOM; checked against lightkurve 2.6 in test/k2.test.mjs (reference: test/make_lightkurve_reference.py).
import { symEig } from './detrend.js';
import { nanMedian, nanStd, sigmaClipKeep, K2_THRUSTER_BITS } from './lcprep.js';

const fin = Number.isFinite;

/**
 * Flag thruster firings. From QUALITY (bits 1048576 and 524288 when `quality` is given) and from the centroid:
 * the position along the roll (arclength: the first principal axis of the centroids in windows of `windowDays`) moves
 * slowly and jumps back when the thrusters fire; a step |Δs − median| larger than `sigma` robust standard deviations
 * (1.4826 MAD of the steps) marks the cadence after the jump.
 * @returns { flags: Uint8Array (1 = firing), fromQuality, fromCentroid, both, steps (Float64Array of Δs) }
 */
export function thrusterFlags(time, x, y, quality = null, opts = {}) {
  const { sigma = 5, windowDays = 6 } = opts, n = time.length, flags = new Uint8Array(n), fromQ = new Uint8Array(n), fromC = new Uint8Array(n);
  if (quality) for (let i = 0; i < n; i++) if (quality[i] & K2_THRUSTER_BITS) { fromQ[i] = 1; flags[i] = 1; }
  const good = []; for (let i = 0; i < n; i++) if (fin(time[i]) && fin(x[i]) && fin(y[i])) good.push(i);
  const arc = arclength(time, x, y, good, windowDays), steps = new Float64Array(n).fill(NaN);
  for (let k = 1; k < good.length; k++) steps[good[k]] = arc[good[k]] - arc[good[k - 1]];
  const s = Array.from(steps).filter(fin), med = nanMedian(s), mad = 1.4826 * nanMedian(s.map((v) => Math.abs(v - med)));
  if (mad > 0) for (let i = 0; i < n; i++) if (fin(steps[i]) && Math.abs(steps[i] - med) > sigma * mad) { fromC[i] = 1; flags[i] = 1; }
  let both = 0, nq = 0, nc = 0; for (let i = 0; i < n; i++) { nq += fromQ[i]; nc += fromC[i]; both += fromQ[i] & fromC[i]; }
  return { flags, fromQuality: nq, fromCentroid: nc, both, steps, arclength: arc };
}

/** Position along the first principal axis of the centroids, window by window (as photometry.js sffDetrend). */
export function arclength(time, x, y, good, windowDays = 6) {
  const n = time.length, arc = new Float64Array(n).fill(NaN); if (good.length < 3) return arc;
  const t0 = time[good[0]], span = time[good[good.length - 1]] - t0 || 1, nw = Math.max(1, Math.round(span / windowDays)), wins = Array.from({ length: nw }, () => []);
  for (const i of good) wins[Math.min(nw - 1, Math.floor((time[i] - t0) / span * nw))].push(i);
  for (const W of wins) {
    if (W.length < 3) continue;
    let mx = 0, my = 0; for (const i of W) { mx += x[i]; my += y[i]; } mx /= W.length; my /= W.length;
    let sxx = 0, sxy = 0, syy = 0; for (const i of W) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), s = Math.sin(th);
    for (const i of W) arc[i] = (x[i] - mx) * c + (y[i] - my) * s;
  }
  return arc;
}

// ------------------------------------------------------------------------------------------------ linear algebra

/** Columns (Float64Array each, length n) → their leading k principal components: U (left singular vectors of the centred matrix), as fbpca.pca returns. */
export function pcaColumns(cols, k, opts = {}) {
  const p = cols.length; if (!p) return [];
  const n = cols[0].length; k = Math.min(k, p);
  const C = cols.map((c) => { let m = 0; for (let i = 0; i < n; i++) m += c[i]; m /= n; return Float64Array.from(c, (v) => v - m); });
  if (p <= (opts.exactBelow ?? 160)) {
    const G = new Float64Array(p * p);
    for (let a = 0; a < p; a++) for (let b = 0; b <= a; b++) { let s = 0; const ca = C[a], cb = C[b]; for (let i = 0; i < n; i++) s += ca[i] * cb[i]; G[a * p + b] = G[b * p + a] = s; }
    const { values, vectors } = symEig(G, p), out = [];
    for (let j = 0; j < k; j++) { if (!(values[j] > 1e-12 * values[0])) break; const v = vectors[j], u = new Float64Array(n), sc = 1 / Math.sqrt(values[j]); for (let a = 0; a < p; a++) { const w = v[a] * sc; if (w) { const ca = C[a]; for (let i = 0; i < n; i++) u[i] += w * ca[i]; } } out.push(u); }
    return out;
  }
  // randomized subspace iteration (Halko et al. 2011, as fbpca with n_iter = 10), deterministic seed
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
  const l = Math.min(p, k + 8), mulA = (Z) => Array.from({ length: Z.length }, (_, j) => { const y = new Float64Array(n), z = Z[j]; for (let a = 0; a < p; a++) { const w = z[a]; if (w) { const ca = C[a]; for (let i = 0; i < n; i++) y[i] += w * ca[i]; } } return y; });
  const mulAt = (Y) => Y.map((y) => Float64Array.from(C, (ca) => { let s = 0; for (let i = 0; i < n; i++) s += ca[i] * y[i]; return s; }));
  let Y = mulA(Array.from({ length: l }, () => Float64Array.from({ length: p }, rnd)));
  for (let it = 0; it < (opts.iters ?? 10); it++) { Y = orth(Y); Y = mulA(orth(mulAt(Y))); }
  Y = orth(Y);
  const B = mulAt(Y), M = new Float64Array(l * l);    // B = Yᵀ A (l × p); eigenvectors of B Bᵀ rotate Y into U
  for (let a = 0; a < l; a++) for (let b = 0; b <= a; b++) { let s = 0; for (let j = 0; j < p; j++) s += B[a][j] * B[b][j]; M[a * l + b] = M[b * l + a] = s; }
  const { values, vectors } = symEig(M, l), out = [];
  for (let j = 0; j < k; j++) { if (!(values[j] > 1e-12 * values[0])) break; const u = new Float64Array(n); for (let a = 0; a < l; a++) { const w = vectors[j][a]; for (let i = 0; i < n; i++) u[i] += w * Y[a][i]; } out.push(u); }
  return out;
}
function orth(V) {     // modified Gram–Schmidt, twice
  const out = [];
  for (const v0 of V) {
    const v = Float64Array.from(v0);
    for (let pass = 0; pass < 2; pass++) for (const q of out) { let d = 0; for (let i = 0; i < v.length; i++) d += q[i] * v[i]; for (let i = 0; i < v.length; i++) v[i] -= d * q[i]; }
    let nn = 0; for (const x of v) nn += x * x; nn = Math.sqrt(nn);
    if (nn > 1e-300) { for (let i = 0; i < v.length; i++) v[i] /= nn; out.push(v); }
  }
  return out;
}
/** Solve the symmetric positive-definite system A x = b (Cholesky; A is m × m row-major, overwritten). */
function cholSolve(A, b, m) {
  for (let j = 0; j < m; j++) {
    let s = A[j * m + j]; for (let k = 0; k < j; k++) s -= A[j * m + k] * A[j * m + k];
    if (!(s > 0)) return null; const d = Math.sqrt(s); A[j * m + j] = d;
    for (let i = j + 1; i < m; i++) { let t = A[i * m + j]; for (let k = 0; k < j; k++) t -= A[i * m + k] * A[j * m + k]; A[i * m + j] = t / d; }
  }
  const x = Float64Array.from(b);
  for (let i = 0; i < m; i++) { let s = x[i]; for (let k = 0; k < i; k++) s -= A[i * m + k] * x[k]; x[i] = s / A[i * m + i]; }
  for (let i = m - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < m; k++) s -= A[k * m + i] * x[k]; x[i] = s / A[i * m + i]; }
  return x;
}

/**
 * B-spline basis of degree `degree` with `df` columns over x (patsy bs(x, df, degree, include_intercept=True), as
 * lightkurve's create_spline_matrix): interior knots at quantiles of x, boundary knots at its ends.
 */
export function splineBasis(x, df, degree = 3) {
  const n = x.length, s = Float64Array.from(x).sort(), lo = s[0], hi = s[n - 1], nInt = Math.max(0, df - degree - 1), inner = [];
  for (let j = 1; j <= nInt; j++) { const q = j / (nInt + 1) * (n - 1), a = Math.floor(q), u = q - a; inner.push(a + 1 < n ? s[a] * (1 - u) + s[a + 1] * u : s[a]); }
  const kn = [...Array(degree + 1).fill(lo), ...inner, ...Array(degree + 1).fill(hi)], nb = kn.length - degree - 1, cols = Array.from({ length: nb }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const v = x[i]; let span = degree; while (span < nb - 1 && v >= kn[span + 1]) span++;
    // Cox–de Boor, de Boor's algorithm for the basis values N_{span-degree..span}
    const N = new Float64Array(degree + 1), left = new Float64Array(degree + 1), right = new Float64Array(degree + 1); N[0] = 1;
    for (let j = 1; j <= degree; j++) { left[j] = v - kn[span + 1 - j]; right[j] = kn[span + j] - v; let saved = 0; for (let r = 0; r < j; r++) { const den = right[r + 1] + left[j - r], tmp = den ? N[r] / den : 0; N[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp; } N[j] = saved; }
    for (let j = 0; j <= degree; j++) cols[span - degree + j][i] = N[j];
  }
  return cols.slice(0, df);
}

// ------------------------------------------------------------------------------------------------ PLD

/**
 * Pixel-level decorrelation of a target pixel file's light curve (EVEREST / lightkurve PLDCorrector).
 * @param pix      array of series of the pixels in the PLD aperture (background-subtracted fluxes), each over the cadences used
 * @param flux     the aperture flux over the same cadences (sum of the aperture's pixels), err its uncertainty
 * @param time     times (days)
 * @param opts     { order = 3 (K2) , ncomp = 16 (principal components per order and of the background), bkg: array of
 *                   background-pixel series (optional; normalised by their sum as lightkurve does for K2),
 *                   knots: spline columns (default n / 50), degree = 5 (lightkurve's correct() default), cadenceMask:
 *                   Uint8Array, 1 = use in the fit (transits 0), sigma = 5, niters = 5, priorScale = 10, restoreTrend = true }
 * @returns { corrected, model (pixel + background part, median removed), spline (median removed), coefficients, used: count of
 *            cadences in the final fit, clipped, ncols, names }
 */
export function pldCorrect(pix, flux, err, time, opts = {}) {
  const n = flux.length, order = opts.order ?? 3, ncomp = opts.ncomp ?? 16, scale = opts.priorScale ?? 10;
  const sd = nanStd(flux), prior = sd * scale;
  // fractional pixel fluxes, PCA, products of the components up to `order`, PCA again at each order
  const frac = pix.map((p) => Float64Array.from(p, (v, i) => v / flux[i]));
  const base = ncomp > 0 ? pcaColumns(frac, ncomp) : frac;
  const groups = [], names = [];
  for (let o = 1; o <= order; o++) {
    const prods = [];
    const rec = (start, depth, acc) => { if (depth === o) { prods.push(acc); return; } for (let a = start; a < base.length; a++) rec(a, depth + 1, acc ? Float64Array.from(acc, (v, i) => v * base[a][i]) : Float64Array.from(base[a])); };
    rec(0, 0, null);
    const cols = ncomp > 0 ? pcaColumns(prods, ncomp) : prods;
    groups.push({ cols, sigma: ncomp > 0 ? prior / ncomp : prior / prods.length, kind: 'pld' }); names.push(`PLD order ${o}: ${cols.length} components of ${prods.length}`);
  }
  if (opts.bkg && opts.bkg.length) {
    const sum = new Float64Array(n); for (const b of opts.bkg) for (let i = 0; i < n; i++) sum[i] += b[i];
    const bn = opts.bkg.map((b) => Float64Array.from(b, (v, i) => (opts.normaliseBkg === false ? v : v / sum[i])));
    const cols = pcaColumns(bn, ncomp > 0 ? ncomp : bn.length); groups.push({ cols, sigma: prior, kind: 'bkg' }); names.push(`background: ${cols.length} components`);
  }
  const knots = Math.max(4, opts.knots ?? Math.floor(n / 50)), spl = splineBasis(time, knots, opts.degree ?? 5);
  groups.push({ cols: [...spl, new Float64Array(n).fill(1)], sigma: prior, kind: 'spline' }); names.push(`spline: ${knots} B-splines of degree ${opts.degree ?? 5} + constant`);
  const X = [], kind = [], psig = [];
  for (const g of groups) for (const c of g.cols) { X.push(c); kind.push(g.kind); psig.push(g.sigma); }
  const m = X.length, use = Uint8Array.from({ length: n }, (_, i) => ((opts.cadenceMask ? opts.cadenceMask[i] : 1) && fin(flux[i]) ? 1 : 0)), outl = new Uint8Array(n);
  const e = Float64Array.from({ length: n }, (_, i) => (err && fin(err[i]) && err[i] > 0 ? err[i] : 1));
  let beta = null, model = new Float64Array(n);
  for (let it = 0; it < (opts.niters ?? 5); it++) {
    const A = new Float64Array(m * m), b = new Float64Array(m);
    for (let i = 0; i < n; i++) { if (!use[i] || outl[i]) continue; const w = 1 / (e[i] * e[i]); for (let a = 0; a < m; a++) { const xa = X[a][i] * w; if (!xa) continue; b[a] += xa * flux[i]; for (let c = 0; c <= a; c++) A[a * m + c] += xa * X[c][i]; } }
    for (let a = 0; a < m; a++) { for (let c = 0; c < a; c++) A[c * m + a] = A[a * m + c]; A[a * m + a] += 1 / (psig[a] * psig[a]); }
    beta = cholSolve(A, b, m); if (!beta) return null;
    model = new Float64Array(n); for (let a = 0; a < m; a++) { const w = beta[a]; for (let i = 0; i < n; i++) model[i] += w * X[a][i]; }
    const res = Float64Array.from(flux, (v, i) => (use[i] && !outl[i] ? v - model[i] : NaN)), keep = sigmaClipKeep(res, opts.sigma ?? 5);
    for (let i = 0; i < n; i++) if (use[i] && !outl[i] && !keep[i]) outl[i] = 1;
  }
  const sys = new Float64Array(n), splv = new Float64Array(n);
  for (let a = 0; a < m; a++) { const w = beta[a], tgt = kind[a] === 'spline' ? splv : sys; for (let i = 0; i < n; i++) tgt[i] += w * X[a][i]; }
  // lightkurve: corrected = flux − (full model − its median) [+ (spline − its median) when the trend is restored]
  const full = Float64Array.from(sys, (v, i) => v + splv[i]), mf = nanMedian(full), ms = nanMedian(splv), restore = opts.restoreTrend !== false;
  const corrected = Float64Array.from(flux, (v, i) => v - (full[i] - mf) + (restore ? splv[i] - ms : 0));
  let used = 0, clipped = 0; for (let i = 0; i < n; i++) { if (use[i] && !outl[i]) used++; if (outl[i]) clipped++; }
  return { corrected, model: Float64Array.from(sys, (v) => v - nanMedian(sys)), spline: Float64Array.from(splv, (v) => v - ms), coefficients: beta, used, clipped, ncols: m, names };
}
