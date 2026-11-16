// Photometric detrending: the columns a light curve is decorrelated against, and how they enter the one likelihood
// (buildProblem in model.js). No DOM, runs in Node.
//
// Three families, all evaluated inside buildProblem so the transit and the systematics are fitted together:
//
//  1. Linear regressors (data.regressors): centroid x and y, PSF width, sky background, airmass, the comparison
//     star's flux, a polynomial in time, and the principal components of pixel-level decorrelation (PLD, Deming et
//     al. 2015). The baseline of each epoch is a1 + sum_k c_k x_k (times the airmass exponential), and a1 and every
//     c_k are integrated out analytically. Columns are centred and scaled to unit standard deviation within each
//     epoch here, so the U(-1, 1) prior on c_k (REG_PRIOR_WIDTH in model.js) is wide: a coefficient of 1 is a 100%
//     change of flux per standard deviation of the regressor.
//
//  2. Nearest-neighbour Gaussian kernel regression (data.kernel): the systematic at point i is the Gaussian-weighted
//     mean of (data / transit) over its k nearest neighbours in a feature space (centroids, PSF width), as in EXOTIC's
//     elca.gaussian_weights + lc_fitter(features=...) and in the Spitzer analyses of Knutson et al. (2012) and Lewis
//     et al. (2013). The neighbours and weights depend only on the features, so they are computed once
//     (gaussianWeights) and the smoothing is applied at every likelihood call.
//
//  3. A comparison ensemble with inverse-variance weights (ensembleWeights), the noise of each star measured by the
//     "three-cornered hat" from the scatter of every pairwise flux ratio.
//
// Every function is checked in test/detrend.test.mjs against numpy / scipy (test/make_detrend_reference.py) and
// against EXOTIC's own gaussian_weights run in its conda environment.

const finite = Number.isFinite;

/** Epoch index of every point (0 when there is none) and the number of epochs. */
function epochsOf(n, epoch) {
  let ns = 1; if (epoch) for (let i = 0; i < n; i++) if (epoch[i] + 1 > ns) ns = epoch[i] + 1;
  return ns;
}

/**
 * Centre a column and scale it to unit (population) standard deviation within each epoch.
 * Points where `keep` is 0 or the value is not finite do not enter the mean and the scale; they are set to 0.
 * @returns { x: Float64Array, constant: true when some epoch has no spread (the column cannot be used there) }
 */
export function standardise(x, epoch = null, keep = null) {
  const n = x.length, ns = epochsOf(n, epoch), m = new Float64Array(ns), c = new Float64Array(ns), v = new Float64Array(ns);
  for (let i = 0; i < n; i++) { if ((keep && !keep[i]) || !finite(x[i])) continue; const s = epoch ? epoch[i] : 0; m[s] += x[i]; c[s]++; }
  for (let s = 0; s < ns; s++) m[s] /= c[s] || 1;
  for (let i = 0; i < n; i++) { if ((keep && !keep[i]) || !finite(x[i])) continue; const s = epoch ? epoch[i] : 0; v[s] += (x[i] - m[s]) ** 2; }
  let constant = false; const sd = Float64Array.from(v, (q, s) => { const d = Math.sqrt(q / (c[s] || 1)); if (!(d > 1e-12 * (Math.abs(m[s]) + 1e-300))) constant = true; return d > 0 ? d : 1; });
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { const s = epoch ? epoch[i] : 0; out[i] = finite(x[i]) ? (x[i] - m[s]) / sd[s] : 0; }
  return { x: out, constant };
}

/** Legendre polynomial P_n at u in [-1, 1] (Bonnet's recursion). */
export function legendre(n, u) {
  if (n === 0) return 1; let p0 = 1, p1 = u;
  for (let k = 1; k < n; k++) { const p2 = ((2 * k + 1) * u * p1 - k * p0) / (k + 1); p0 = p1; p1 = p2; }
  return p1;
}

/**
 * A polynomial in time as regressors: P_1 .. P_order of the time scaled to [-1, 1] within each epoch (Legendre
 * polynomials, nearly orthogonal on evenly spaced points, so the coefficients are not degenerate as plain powers
 * are). The constant term is a1, already in the model.
 */
export function timePolynomial(t, order, epoch = null) {
  const n = t.length, ns = epochsOf(n, epoch), lo = new Float64Array(ns).fill(Infinity), hi = new Float64Array(ns).fill(-Infinity), out = [];
  for (let i = 0; i < n; i++) { const s = epoch ? epoch[i] : 0; if (t[i] < lo[s]) lo[s] = t[i]; if (t[i] > hi[s]) hi[s] = t[i]; }
  for (let k = 1; k <= order; k++) out.push(Float64Array.from(t, (ti, i) => { const s = epoch ? epoch[i] : 0, h = 0.5 * (hi[s] - lo[s]) || 1; return legendre(k, (ti - 0.5 * (hi[s] + lo[s])) / h); }));
  return out;
}

/** The detrending columns a light curve can carry, by the names used in exported files and in the hand-off. */
export const DETREND_COLUMNS = {
  xc: 'centroid x [px]', yc: 'centroid y [px]', fwhm: 'PSF FWHM [px]', sky: 'sky background [counts/px]', airmass: 'airmass',
  comp: 'comparison flux (normalised)', xy: 'centroid x times y', xc2: 'centroid x squared', yc2: 'centroid y squared',
};

/**
 * The linear regressors of a fit (data.regressors) from named columns.
 * @param cols   { name: array, ... } one value per point (e.g. parseLightCurve(...).columns, or the photometry page's arrays)
 * @param spec   { columns: ['xc', 'yc', ...] (products 'xy', squares 'xc2', 'yc2' are formed from xc and yc),
 *                 poly: order of the time polynomial (0 = none), pld: [pc arrays] (already orthogonal, added as they are) }
 * @param t      times (needed for poly), epoch: per-point epoch index or null, keep: points that set the scaling
 * @returns { regressors: [Float64Array], names: [...], dropped: [{ name, why }] }
 */
export function buildRegressors(cols, spec = {}, t = null, epoch = null, keep = null) {
  const out = [], names = [], dropped = [];
  const raw = (nm) => {
    if (nm === 'xy' && cols.xc && cols.yc) { const a = standardise(cols.xc, epoch, keep).x, b = standardise(cols.yc, epoch, keep).x; return Float64Array.from(a, (v, i) => v * b[i]); }
    if ((nm === 'xc2' || nm === 'yc2') && cols[nm.slice(0, 2)]) { const a = standardise(cols[nm.slice(0, 2)], epoch, keep).x; return Float64Array.from(a, (v) => v * v); }
    return cols[nm] || null;
  };
  for (const nm of spec.columns || []) {
    const x = raw(nm);
    if (!x) { dropped.push({ name: nm, why: 'not in the data' }); continue; }
    if (Array.prototype.some.call(x, (v, i) => (!keep || keep[i]) && !finite(v))) { dropped.push({ name: nm, why: 'has missing values' }); continue; }
    const s = standardise(x, epoch, keep);
    if (s.constant) { dropped.push({ name: nm, why: 'constant within an epoch' }); continue; }
    out.push(s.x); names.push(nm);
  }
  if (spec.poly > 0 && t) timePolynomial(t, spec.poly | 0, epoch).forEach((x, k) => { out.push(x); names.push('P' + (k + 1) + '(t)'); });
  if (spec.pld) spec.pld.forEach((x, k) => { out.push(Float64Array.from(x)); names.push('PLD' + (k + 1)); });
  return { regressors: out, names, dropped };
}

// ------------------------------------------------------------------------------------------- PCA (Jacobi eigenvalues)

/** Eigen-decomposition of the symmetric n x n matrix A (row-major, not modified) by cyclic Jacobi rotations. Returns { values, vectors (column k = vectors[k]) } sorted by decreasing value. */
export function symEig(A, n) {
  const a = Float64Array.from(A), V = new Float64Array(n * n); for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, diag = 0; for (let i = 0; i < n; i++) { diag += a[i * n + i] ** 2; for (let j = i + 1; j < n; j++) off += a[i * n + j] ** 2; }
    if (off <= 1e-30 * diag || off === 0) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q]; if (Math.abs(apq) < 1e-300) continue;
      const th = (a[q * n + q] - a[p * n + p]) / (2 * apq), tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
      for (let k = 0; k < n; k++) { const akp = a[k * n + p], akq = a[k * n + q]; a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p * n + k], aqk = a[q * n + k]; a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k * n + p], vkq = V[k * n + q]; V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq; }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i]);
  return { values: order.map((i) => a[i * n + i]), vectors: order.map((i) => Float64Array.from({ length: n }, (_, k) => V[k * n + i])) };
}

/**
 * Pixel-level decorrelation (Deming et al. 2015): the fractional flux of each pixel, P_k / sum_j P_j, carries the
 * motion of the star on the detector independently of its brightness. Those fractions sum to one, so one of them is
 * redundant with the constant a1; they are centred and turned into principal components (eigenvectors of their
 * covariance), and the leading `ncomp` components, scaled to unit standard deviation, are the regressors. With
 * order 2 the products of the first-order components are added before a second PCA (Luger et al. 2016, EVEREST).
 * @param pix   array of nPix series (one per pixel, background-subtracted), each of length n
 * @param opts  { ncomp (default: as many as explain 99.9% of the variance, at most 12), order: 1 | 2, keep }
 * @returns { regressors: [Float64Array], explained: [fraction of variance per component], ncomp, frac: [the fractional pixel series] }
 */
export function pldBasis(pix, opts = {}) {
  const np = pix.length, n = pix[0].length, keep = opts.keep || null;
  const frac = pix.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < np; k++) s += pix[k][i]; for (let k = 0; k < np; k++) frac[k][i] = s !== 0 ? pix[k][i] / s : 0; }
  let cols = frac;
  const pcs = (C, maxc) => {
    const d = C.length, mu = C.map((c) => { let m = 0, w = 0; for (let i = 0; i < n; i++) if (!keep || keep[i]) { m += c[i]; w++; } return m / (w || 1); });
    const cov = new Float64Array(d * d); let w = 0;
    for (let i = 0; i < n; i++) { if (keep && !keep[i]) continue; w++; for (let a = 0; a < d; a++) { const xa = C[a][i] - mu[a]; for (let b = 0; b <= a; b++) cov[a * d + b] += xa * (C[b][i] - mu[b]); } }
    for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) { cov[a * d + b] /= w || 1; cov[b * d + a] = cov[a * d + b]; }
    const { values, vectors } = symEig(cov, d), tot = values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
    let nc = opts.ncomp > 0 ? Math.min(opts.ncomp, d) : 0;
    if (!nc) { let cum = 0; for (nc = 0; nc < Math.min(d, maxc); nc++) { if (cum >= 0.999 * tot) break; cum += Math.max(0, values[nc]); } }
    nc = Math.max(1, Math.min(nc, d));
    const out = [];
    for (let k = 0; k < nc; k++) { if (!(values[k] > 1e-14 * tot)) break; const v = vectors[k], z = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let a = 0; a < d; a++) s += v[a] * (C[a][i] - mu[a]); z[i] = s; } out.push(z); }
    return { out, explained: values.slice(0, out.length).map((v) => v / tot) };
  };
  let r = pcs(cols, 12);
  if (opts.order === 2) {
    const first = r.out, prod = [...first];
    for (let a = 0; a < first.length; a++) for (let b = a; b < first.length; b++) prod.push(Float64Array.from(first[a], (v, i) => v * first[b][i]));
    cols = prod.map((c) => standardise(c, null, keep).x); r = pcs(cols, 20);
  }
  const regressors = r.out.map((z) => standardise(z, null, keep).x);
  return { regressors, explained: r.explained, ncomp: regressors.length, frac };
}

// ------------------------------------------------------------------------------------------- nearest-neighbour kernel

/**
 * Gaussian-weighted nearest neighbours in a feature space: EXOTIC's elca.gaussian_weights, line for line.
 *   Xm = (X - median(X)) * w;  for every point the k nearest other points (Euclidean in Xm);
 *   the weight of neighbour j of point i is prod_d exp(-(Xm_jd - Xm_id)^2 / (2 s_d^2)), s_d the (population) standard
 *   deviation of those k offsets in feature d (an adaptive bandwidth), normalised to sum to one. A feature whose offsets
 *   all vanish gets s = 1e-12; a point whose weights all vanish gets 1/k each (both as in EXOTIC).
 * The neighbours are found by brute force (n^2 d operations: 0.4 s for n = 5000 in Node); the point itself is excluded,
 * so a point's systematic is predicted from the others only.
 * @param X     array of d feature series of length n (e.g. [xc, yc] or [xc, yc, fwhm])
 * @param opts  { neighbors = 50, w = 1 (number or one per feature) }
 * @returns { idx: Int32Array n*k, w: Float64Array n*k, k, n }
 */
export function gaussianWeights(X, opts = {}) {
  const d = X.length, n = X[0].length, k = Math.max(1, Math.min(opts.neighbors ?? 50, n - 1));
  const fw = Array.isArray(opts.w) ? opts.w : new Array(d).fill(opts.w ?? 1);
  const Xm = X.map((c, a) => { const s = Float64Array.from(c).sort(), med = n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]); return Float64Array.from(c, (v) => (v - med) * fw[a]); });
  const idx = new Int32Array(n * k), wts = new Float64Array(n * k), dist = new Float64Array(n), ord = new Int32Array(n), dX = new Float64Array(k * d), sd = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) { let s = 0; for (let a = 0; a < d; a++) { const q = Xm[a][j] - Xm[a][i]; s += q * q; } dist[j] = s; ord[j] = j; }
    dist[i] = Infinity;
    // partial selection of the k smallest distances (quickselect), then sorted
    let lo = 0, hi = n - 1; const kk = k;
    while (lo < hi) {
      const piv = dist[ord[(lo + hi) >> 1]]; let a = lo, b = hi;
      while (a <= b) { while (dist[ord[a]] < piv) a++; while (dist[ord[b]] > piv) b--; if (a <= b) { const tmp = ord[a]; ord[a] = ord[b]; ord[b] = tmp; a++; b--; } }
      if (kk - 1 <= b) hi = b; else if (kk - 1 >= a) lo = a; else break;
    }
    const sel = Array.from(ord.subarray(0, k)).sort((p, q) => dist[p] - dist[q] || p - q);
    for (let a = 0; a < d; a++) { let m = 0; for (let q = 0; q < k; q++) { dX[q * d + a] = Xm[a][sel[q]] - Xm[a][i]; m += dX[q * d + a]; } m /= k; let v = 0; for (let q = 0; q < k; q++) v += (dX[q * d + a] - m) ** 2; sd[a] = Math.sqrt(v / k) || 1e-12; }
    let sum = 0;
    for (let q = 0; q < k; q++) { let g = 1; for (let a = 0; a < d; a++) g *= Math.exp(-(dX[q * d + a] ** 2) / (2 * sd[a] * sd[a])); wts[i * k + q] = g; idx[i * k + q] = sel[q]; sum += g; }
    for (let q = 0; q < k; q++) { const x = sum > 0 ? wts[i * k + q] / sum : 1 / k; wts[i * k + q] = Number.isNaN(x) ? 0.01 : x; }
  }
  return { idx, w: wts, k, n };
}

/** Kernel-smoothed series: out_i = sum_q w_iq y[idx_iq] (EXOTIC's weightedflux). */
export function kernelSmooth(y, kern, out = new Float64Array(kern.n)) {
  const { idx, w, k, n } = kern;
  for (let i = 0; i < n; i++) { let s = 0; const o = i * k; for (let q = 0; q < k; q++) s += w[o + q] * y[idx[o + q]]; out[i] = s; }
  return out;
}

// ------------------------------------------------------------------------------------------- comparison ensemble

/**
 * Inverse-variance weights for an ensemble of comparison stars.
 * The white noise of each light curve is measured without assuming any of them is quiet, by the "three-cornered hat"
 * (Gray & Allan 1974): for every pair (i, j) of series the variance of the point-to-point differences of
 * ln(F_i / F_j), halved, is sigma_i^2 + sigma_j^2 (the atmosphere, common to all stars, cancels in the ratio; slow
 * trends and a transit hardly change point-to-point differences). The m sigma^2 follow by least squares from the
 * m(m-1)/2 pair variances; with m >= 3 series (the target counts as one) they are determined. The ensemble is then
 *   C = sum_j w_j F_j / median(F_j),   w_j = (1 / sigma_j^2) / sum_l (1 / sigma_l^2)
 * whose fractional white noise 1 / sqrt(sum 1/sigma_j^2) is the least any weighted mean of these stars can have.
 * A plain sum (EXOTIC's single best star, or this code's "all summed") is weighted by brightness instead, which is
 * optimal only when every star is photon-noise limited.
 * @param comps   array of comparison flux series (length n each)
 * @param target  the target's flux series (used only to measure the noise; recommended), or null
 * @param opts    { keep: points to use, floor: smallest sigma^2 as a fraction of the median (default 1e-3) }
 * @returns { weights (sum 1), sigma (fractional white noise of each comparison), sigmaTarget, comparison (the
 *            weighted ensemble, median 1), sigmaEnsemble, pairs: [{ i, j, v }] }
 */
export function ensembleWeights(comps, target = null, opts = {}) {
  const series = target ? [target, ...comps] : comps.slice(), m = series.length, n = series[0].length, keep = opts.keep || null;
  if (comps.length === 1) { const med = median(comps[0]); return { weights: [1], sigma: [NaN], sigmaTarget: NaN, comparison: Float64Array.from(comps[0], (v) => v / med), sigmaEnsemble: NaN, pairs: [] }; }
  const L = series.map((s) => Float64Array.from(s, (v) => (v > 0 ? Math.log(v) : NaN)));
  const pairs = [];
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    let s = 0, s2 = 0, c = 0, prev = NaN;
    for (let q = 0; q < n; q++) { if (keep && !keep[q]) continue; const r = L[i][q] - L[j][q]; if (!finite(r)) continue; if (finite(prev)) { const dd = r - prev; s += dd; s2 += dd * dd; c++; } prev = r; }
    pairs.push({ i, j, v: c > 1 ? 0.5 * (s2 / c - (s / c) ** 2) : NaN });
  }
  // least squares for sigma^2: rows e_i + e_j, right-hand side v_ij (normal equations, m x m)
  const A = new Float64Array(m * m), b = new Float64Array(m);
  for (const p of pairs) { if (!finite(p.v)) continue; for (const a of [p.i, p.j]) { b[a] += p.v; for (const c of [p.i, p.j]) A[a * m + c] += 1; } }
  let s2 = solveSmall(A, b, m);
  if (!s2) s2 = new Array(m).fill(1);
  const pos = s2.filter((v) => v > 0), med = pos.length ? median(pos) : 1, floor = (opts.floor ?? 1e-3) * med;
  s2 = s2.map((v) => (v > floor ? v : floor));
  const sc = target ? s2.slice(1) : s2, inv = sc.map((v) => 1 / v), tot = inv.reduce((a, v) => a + v, 0), weights = inv.map((v) => v / tot);
  const meds = comps.map((c) => median(c)), comparison = new Float64Array(n);
  for (let q = 0; q < n; q++) { let s = 0; for (let j = 0; j < comps.length; j++) s += weights[j] * comps[j][q] / meds[j]; comparison[q] = s; }
  return { weights, sigma: sc.map(Math.sqrt), sigmaTarget: target ? Math.sqrt(s2[0]) : NaN, comparison, sigmaEnsemble: 1 / Math.sqrt(tot), pairs };
}

function median(a) { const s = Float64Array.from(Array.prototype.filter.call(a, finite)).sort(), n = s.length; return n ? (n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN; }

function solveSmall(A, b, n) {            // Gaussian elimination with partial pivoting; null when singular
  const M = Array.from({ length: n }, (_, i) => [...A.subarray(i * n, (i + 1) * n), b[i]]);
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
 * Everything the analyzer needs from a hand-off (or a file with detrending columns) in one call.
 * @param columns  { name: array } aligned with the light curve's points (parseLightCurve(...).columns)
 * @param detrend  { columns: [names], poly, pld: [names of PLD columns, e.g. 'pld1'...], kernel: { features: [names], neighbors } }
 * @param t, epoch the light curve's times and epoch index
 * @returns { regressors: [...] | null, names, kernel: from gaussianWeights | null, dropped }
 */
export function detrendFromColumns(columns, detrend = {}, t = null, epoch = null) {
  const pld = (detrend.pld || []).filter((nm) => columns[nm]).map((nm) => standardise(columns[nm], epoch).x);
  const r = buildRegressors(columns, { columns: detrend.columns || [], poly: detrend.poly || 0, pld }, t, epoch);
  let kernel = null;
  if (detrend.kernel && detrend.kernel.features && detrend.kernel.features.length) {
    const feats = detrend.kernel.features.filter((nm) => columns[nm]);
    if (feats.length) kernel = gaussianWeights(feats.map((nm) => columns[nm]), { neighbors: detrend.kernel.neighbors ?? 50, w: detrend.kernel.w ?? 1 });
    else r.dropped.push({ name: 'kernel', why: 'none of its features is in the data' });
  }
  return { regressors: r.regressors.length ? r.regressors : null, names: r.names, kernel, dropped: r.dropped };
}

/**
 * Put columns that came with a light curve onto the points the analyzer kept: for every time in `dstTime` the row of
 * `srcTime` with the same time (within `tol` days, default 1e-6 d = 0.09 s) is taken; points with no match get NaN.
 * The light-curve reader sorts rows and drops duplicate times, so this is how the hand-off's arrays (in the order the
 * photometry page wrote them) are aligned with data.t (+ data.tRef).
 * @returns { columns: { name: Float64Array }, matched: number of points found }
 */
export function alignColumns(srcTime, columns, dstTime, tol = 1e-6) {
  const order = Array.from(srcTime, (_, i) => i).filter((i) => finite(srcTime[i])).sort((a, b) => srcTime[a] - srcTime[b]), st = Float64Array.from(order, (i) => srcTime[i]);
  const pos = new Int32Array(dstTime.length).fill(-1); let matched = 0;
  for (let k = 0; k < dstTime.length; k++) {
    const x = dstTime[k]; let lo = 0, hi = st.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (st[m] < x) lo = m + 1; else hi = m; }
    let best = -1, bd = Infinity; for (const j of [lo - 1, lo]) if (j >= 0 && j < st.length && Math.abs(st[j] - x) < bd) { bd = Math.abs(st[j] - x); best = j; }
    if (best >= 0 && bd <= tol) { pos[k] = order[best]; matched++; }
  }
  const out = {};
  for (const [nm, a] of Object.entries(columns)) out[nm] = Float64Array.from(pos, (p) => (p >= 0 ? Number(a[p]) : NaN));
  return { columns: out, matched };
}
