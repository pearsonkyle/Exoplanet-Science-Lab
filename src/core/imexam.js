// Image examination, as IRAF's imexam and DS9's analysis tools do it: radial profiles with Gaussian and Moffat
// fits, curves of growth and half-flux diameters, line cuts, region statistics, a pixel table, the focus across
// the field (FWHM, ellipticity and elongation direction of every star, mapped and summarised), and a ranking of
// comparison stars for differential photometry. No DOM: runs in Node and in the photometry page.
// Pixel coordinates are zero-based with the centre of the first pixel at (0, 0) and y up, as in photometry.js.
import { apertureSum, annulusBackground, centroidIter, fitPsf, detectSources, sigmaClippedStats, frameStats } from './photometry.js';
import { polySurface } from './psd.js';

const FWHM_SIGMA = 2 * Math.sqrt(2 * Math.LN2);           // 2.3548...

// ---------------------------------------------------------------------------------------------------------
// A small Levenberg-Marquardt for 1-D models with a handful of parameters (numerical derivatives)

function solve(A, b, n) {                                   // Gaussian elimination with partial pivoting; A is n x n row-major
  const M = A.slice(), x = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (!(Math.abs(M[p * n + c]) > 1e-300)) return null;
    if (p !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
    for (let r = c + 1; r < n; r++) { const f = M[r * n + c] / M[c * n + c]; if (!f) continue; for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k]; x[r] -= f * x[c]; }
  }
  for (let r = n - 1; r >= 0; r--) { let s = x[r]; for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k]; x[r] = s / M[r * n + r]; }
  return x;
}

/**
 * Least squares fit of y ~ f(p, x) by Levenberg-Marquardt. `clamp(p)` keeps the parameters physical.
 * @returns { p, chi2, iters, ok }
 */
export function lmFit(f, x, y, p0, { weights = null, clamp = null, maxIter = 200 } = {}) {
  const n = x.length, k = p0.length, p = Float64Array.from(p0), J = new Float64Array(n * k), r = new Float64Array(n);
  const chi = (q) => { let c = 0; for (let i = 0; i < n; i++) { const d = (y[i] - f(q, x[i])) * (weights ? weights[i] : 1); c += d * d; } return c; };
  if (clamp) clamp(p);
  let c2 = chi(p), lambda = 1e-3, iters = 0, ok = false;
  for (; iters < maxIter; iters++) {
    for (let i = 0; i < n; i++) {
      const wi = weights ? weights[i] : 1, f0 = f(p, x[i]); r[i] = (y[i] - f0) * wi;
      for (let j = 0; j < k; j++) { const h = 1e-6 * (Math.abs(p[j]) + 1e-6), s = p[j]; p[j] = s + h; J[i * k + j] = (f(p, x[i]) - f0) / h * wi; p[j] = s; }
    }
    const A = new Float64Array(k * k), g = new Float64Array(k);
    for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { g[a] += J[i * k + a] * r[i]; for (let b = 0; b <= a; b++) A[a * k + b] += J[i * k + a] * J[i * k + b]; }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) A[b * k + a] = A[a * k + b];
    let improved = false;
    for (let t = 0; t < 14; t++) {
      const B = A.slice(); for (let a = 0; a < k; a++) B[a * k + a] *= 1 + lambda;
      const step = solve(B, g, k); if (!step) { lambda *= 10; continue; }
      const q = Float64Array.from(p, (v, j) => v + step[j]); if (clamp) clamp(q);
      const c = chi(q);
      if (c <= c2) { const rel = (c2 - c) / (c2 || 1); p.set(q); c2 = c; lambda = Math.max(1e-12, lambda / 10); improved = true; if (rel < 1e-12) ok = true; break; }
      lambda *= 10;
    }
    if (!improved || ok) { ok = true; break; }
  }
  return { p: Array.from(p), chi2: c2, iters, ok };
}

// ---------------------------------------------------------------------------------------------------------
// Saturation

/**
 * The level at which a frame saturates: SATURATE or DATAMAX from the header when present, else the largest value
 * the integer format can hold (BITPIX 16 with BZERO 32768 is 65535). Floating-point frames without a keyword: Infinity.
 * @returns { level, source }
 */
export function saturationLevel(H = {}) {
  for (const k of ['SATURATE', 'SATLEVEL', 'DATAMAX', 'MAXLIN']) { const v = Number(H[k]); if (Number.isFinite(v) && v > 0) return { level: v, source: k }; }
  const bp = Number(H.BITPIX), bz = Number(H.BZERO) || 0, bs = Number(H.BSCALE) || 1;
  if (bp === 8) return { level: 255 * bs + bz, source: 'BITPIX' };
  if (bp === 16) return { level: 32767 * bs + bz, source: 'BITPIX' };
  if (bp === 32) return { level: 2147483647 * bs + bz, source: 'BITPIX' };
  return { level: Infinity, source: null };
}

// ---------------------------------------------------------------------------------------------------------
// Radial profile (imexam 'r'), curve of growth (imexam 'a'), half-flux diameter

const gauss1 = (p, r) => p[0] * Math.exp(-0.5 * r * r / (p[1] * p[1]));
const moffat1 = (p, r) => p[0] * Math.pow(1 + r * r / (p[1] * p[1]), -p[2]);

/**
 * Radial profile of the star near (x0, y0).
 * The centre is refined with centroidIter unless opts.recentre is false. The sky is the sigma-clipped median of the
 * annulus [rmax + 2, rmax + 2 + skyWidth) unless opts.background is given. The binned profile is the mean surface
 * brightness in annuli of width `bin` from the centre, with each pixel weighted by its exact overlap with the annulus
 * (photutils RadialProfile, method 'exact'); the curve of growth is the sky-subtracted sum inside circles of the
 * radii every growthStep px (photutils CurveOfGrowth). A Gaussian a exp(-r^2 / 2 s^2) and a Moffat a (1 + r^2/g^2)^-beta
 * are fitted by least squares to every pixel inside rmax (`gaussian`, `moffat`) and to the binned profile (`binned`,
 * as photutils' gaussian_fit does).
 * @param opts { rmax = 12, bin = 1, growthStep = 0.25, recentre = true, background, skyWidth = 6, gain = 1, saturation = Infinity, half }
 * @returns { x, y, background, backgroundSigma, pixels: { r, v } (every pixel inside rmax, sky subtracted),
 *            profile: { r (bin centres), edges, v, area }, growth: { r, flux },
 *            gaussian: { amp, sigma, fwhm }, moffat: { amp, gamma, beta, fwhm }, binned: { gaussian, moffat }, hfd, r50, r80, flux, peak,
 *            saturated, snr, ok }
 */
export function radialProfile(data, w, h, x0, y0, opts = {}) {
  const { rmax = 12, bin = 1, recentre = true, skyWidth = 6, gain = 1, saturation = Infinity } = opts;
  let x = x0, y = y0;
  if (recentre) { const c = centroidIter(data, w, h, x0, y0, opts.half ?? Math.max(4, Math.round(rmax / 2))); if (c[2] > 0 && Math.hypot(c[0] - x0, c[1] - y0) < rmax) { x = c[0]; y = c[1]; } }
  let bg = opts.background, bgs = NaN;
  if (!Number.isFinite(bg)) { const s = annulusBackground(data, w, h, x, y, rmax + 2, rmax + 2 + skyWidth); bg = s[0]; bgs = s[2]; }
  if (!Number.isFinite(bg)) bg = 0;
  // every pixel inside rmax
  const pr = [], pv = []; let peak = -Infinity;
  const xa = Math.max(0, Math.floor(x - rmax)), xb = Math.min(w - 1, Math.ceil(x + rmax)), ya = Math.max(0, Math.floor(y - rmax)), yb = Math.min(h - 1, Math.ceil(y + rmax));
  for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) {
    const d = Math.hypot(xx - x, yy - y); if (d > rmax) continue;
    const v = data[yy * w + xx]; if (v !== v) continue;
    pr.push(d); pv.push(v - bg); if (v > peak) peak = v;
  }
  // annuli and circles with exact pixel overlaps
  const nb = Math.max(1, Math.floor(rmax / bin + 1e-9)), edges = Float64Array.from({ length: nb + 1 }, (_, i) => i * bin);
  const S = new Float64Array(nb + 1), A = new Float64Array(nb + 1);
  for (let i = 1; i <= nb; i++) { const a = apertureSum(data, w, h, x, y, edges[i], 'exact'); S[i] = a[0]; A[i] = a[1]; }
  const prof = new Float64Array(nb), area = new Float64Array(nb), rc = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { area[i] = A[i + 1] - A[i]; prof[i] = area[i] > 0 ? (S[i + 1] - S[i]) / area[i] - bg : NaN; rc[i] = 0.5 * (edges[i] + edges[i + 1]); }
  // Fits. To every pixel inside rmax (r, value), as imexam does: unbiased by the averaging inside annuli, which widens
  // a binned profile (1.6% for a 2.2 px sigma Gaussian in 1 px bins). The Gaussian fitted to the binned profile is kept
  // as `binned`, the number photutils' RadialProfile.gaussian_fwhm gives.
  const fitTo = (rr, vv) => {
    const amp0 = Math.max(...vv, 1e-12);
    let s0 = 1.5; { const ord = rr.map((r, i) => [r, vv[i]]).sort((a, b) => a[0] - b[0]), j = ord.findIndex((q) => q[1] < amp0 / 2); if (j > 0) s0 = Math.max(0.4, ord[j][0] / Math.sqrt(2 * Math.LN2)); }
    const gf = lmFit(gauss1, rr, vv, [amp0, s0], { clamp: (p) => { p[1] = Math.min(4 * rmax, Math.max(0.2, Math.abs(p[1]))); } });
    const mf = lmFit(moffat1, rr, vv, [gf.p[0], gf.p[1] * 1.5, 2.5], { clamp: (p) => { p[1] = Math.min(8 * rmax, Math.max(0.2, Math.abs(p[1]))); p[2] = Math.min(60, Math.max(0.6, p[2])); } });
    return [{ amp: gf.p[0], sigma: gf.p[1], fwhm: FWHM_SIGMA * gf.p[1], ok: gf.ok && gf.p[0] > 0 }, { amp: mf.p[0], gamma: mf.p[1], beta: mf.p[2], fwhm: 2 * mf.p[1] * Math.sqrt(Math.pow(2, 1 / mf.p[2]) - 1), ok: mf.ok && mf.p[0] > 0 }];
  };
  const rb = [], vb = []; for (let i = 0; i < nb; i++) if (Number.isFinite(prof[i])) { rb.push(rc[i]); vb.push(prof[i]); }
  const [binnedG, binnedM] = fitTo(rb, vb), [gaussian, moffat] = pr.length >= 6 ? fitTo(pr, pv) : [binnedG, binnedM];
  // curve of growth on a finer grid for the half-flux and 80% radii (total = the flux inside rmax)
  const gs = Math.min(bin, opts.growthStep ?? 0.25), ng = Math.max(1, Math.round(rmax / gs)), gr = Float64Array.from({ length: ng + 1 }, (_, i) => Math.min(rmax, i * gs)), gf = new Float64Array(ng + 1);
  for (let i = 1; i <= ng; i++) { const a = apertureSum(data, w, h, x, y, gr[i], 'exact'); gf[i] = a[0] - bg * a[1]; }
  const total = gf[ng], at = (frac) => { const t = frac * total; for (let i = 1; i <= ng; i++) if (gf[i] >= t) { const g0 = gf[i - 1], g1 = gf[i]; return gr[i - 1] + (t - g0) / (g1 - g0 || 1) * (gr[i] - gr[i - 1]); } return NaN; };
  const r50 = total > 0 ? at(0.5) : NaN, r80 = total > 0 ? at(0.8) : NaN;
  const nArea = A[nb], sky = Number.isFinite(bgs) ? bgs : frameStats(data, w, h).sigma;
  const snr = total > 0 ? total / Math.sqrt(total / gain + nArea * sky * sky) : NaN;
  return {
    x, y, background: bg, backgroundSigma: bgs, pixels: { r: Float64Array.from(pr), v: Float64Array.from(pv) },
    profile: { r: rc, edges, v: prof, area }, growth: { r: gr, flux: gf }, gaussian, moffat, binned: { gaussian: binnedG, moffat: binnedM },
    hfd: 2 * r50, r50, r80, flux: total, peak, saturated: peak >= saturation, snr, ok: gaussian.ok && total > 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Line cut, region statistics, pixel table

/** Bilinear interpolation at (x, y); NaN outside the image. */
export function bilinear(data, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN;
  const x0 = Math.min(w - 2, Math.floor(x)), y0 = Math.min(h - 2, Math.floor(y)), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  if (w === 1 || h === 1) return data[Math.round(y) * w + Math.round(x)];
  return (1 - fy) * ((1 - fx) * data[i] + fx * data[i + 1]) + fy * ((1 - fx) * data[i + w] + fx * data[i + w + 1]);
}

/** Cubic convolution at (x, y) (Keys 1981, a = -0.5), from the 4 x 4 pixels around it; NaN where they leave the image. */
export function bicubic(data, w, h, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  if (ix < 1 || iy < 1 || ix + 2 > w - 1 || iy + 2 > h - 1) return bilinear(data, w, h, x, y);
  const k = (t) => { t = Math.abs(t); return t <= 1 ? (1.5 * t - 2.5) * t * t + 1 : t < 2 ? ((-0.5 * t + 2.5) * t - 4) * t + 2 : 0; };
  const kx = [k(1 + fx), k(fx), k(1 - fx), k(2 - fx)], ky = [k(1 + fy), k(fy), k(1 - fy), k(2 - fy)];
  let v = 0; for (let j = 0; j < 4; j++) { const row = (iy - 1 + j) * w + ix - 1; v += ky[j] * (kx[0] * data[row] + kx[1] * data[row + 1] + kx[2] * data[row + 2] + kx[3] * data[row + 3]); }
  return v;
}

/** Values along the segment (x0, y0) -> (x1, y1), sampled every `step` px (imexam 'l' and 'c' along any direction). */
export function lineProfile(data, w, h, x0, y0, x1, y1, step = 0.5) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.floor(L / step) + 1), s = new Float64Array(n), v = new Float64Array(n), px = new Float64Array(n), py = new Float64Array(n);
  for (let i = 0; i < n; i++) { const t = i / (n - 1); px[i] = x0 + t * (x1 - x0); py[i] = y0 + t * (y1 - y0); s[i] = t * L; v[i] = bilinear(data, w, h, px[i], py[i]); }
  return { s, v, x: px, y: py, length: L };
}

/**
 * Statistics of the pixels whose centres are inside a box (shape 'box': x0, y0, x1, y1 corners) or a circle
 * (shape 'circle': x0, y0 centre, r radius): count, sum, mean, median, standard deviation, min, max, and the
 * 3-sigma clipped median, mean and standard deviation (astropy sigma_clipped_stats). NaN pixels are counted apart.
 */
export function regionStats(data, w, h, reg) {
  const box = reg.shape !== 'circle';
  const xa = Math.max(0, Math.ceil(box ? Math.min(reg.x0, reg.x1) : reg.x0 - reg.r)), xb = Math.min(w - 1, Math.floor(box ? Math.max(reg.x0, reg.x1) : reg.x0 + reg.r));
  const ya = Math.max(0, Math.ceil(box ? Math.min(reg.y0, reg.y1) : reg.y0 - reg.r)), yb = Math.min(h - 1, Math.floor(box ? Math.max(reg.y0, reg.y1) : reg.y0 + reg.r));
  const vals = []; let nan = 0;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    if (!box && (x - reg.x0) ** 2 + (y - reg.y0) ** 2 > reg.r * reg.r) continue;
    const v = data[y * w + x]; if (v === v) vals.push(v); else nan++;
  }
  const n = vals.length; if (!n) return { n: 0, nan, sum: 0, mean: NaN, median: NaN, std: NaN, min: NaN, max: NaN, clipped: { median: NaN, mean: NaN, std: NaN, n: 0 } };
  const a = Float64Array.from(vals).sort();
  let s = 0; for (const v of a) s += v; const mean = s / n; let q = 0; for (const v of a) q += (v - mean) ** 2;
  const med = n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
  const c = sigmaClippedStats(Float64Array.from(a), n, 3, 5, true);
  return { n, nan, sum: s, mean, median: med, std: Math.sqrt(q / n), min: a[0], max: a[n - 1], clipped: { median: c[0], mean: c[1], std: c[2], n: c[3] } };
}

/** The (2 half + 1)^2 pixel values around the pixel nearest (x, y), as DS9's pixel table; rows from the top (y high) down. */
export function pixelTable(data, w, h, x, y, half = 2) {
  const cx = Math.round(x), cy = Math.round(y), xs = [], ys = [], rows = [];
  for (let i = -half; i <= half; i++) xs.push(cx + i);
  for (let j = half; j >= -half; j--) { const yy = cy + j; ys.push(yy); rows.push(xs.map((xx) => (xx >= 0 && yy >= 0 && xx < w && yy < h ? data[yy * w + xx] : NaN))); }
  return { cx, cy, xs, ys, rows };
}

// ---------------------------------------------------------------------------------------------------------
// Shape of one star from the rotated Gaussian fit

/**
 * FWHM, ellipticity and direction of the major axis from fitPsf's rotated Gaussian (sx along the rotated x axis).
 * fitPsf's rotation: rx = dx cos(th) - dy sin(th), so the sx axis points at angle -th from +x.
 * @returns { fwhm (geometric mean), fwhmMajor, fwhmMinor, ellipticity 1 - b/a, angle of the major axis in degrees
 *            counter-clockwise from +x (y up), in [0, 180) }
 */
export function psfShape(fit) {
  const a = Math.max(fit.sx, fit.sy), b = Math.min(fit.sx, fit.sy), th = (fit.theta || 0) * 180 / Math.PI;
  let ang = fit.sx >= fit.sy ? -th : 90 - th; ang = ((ang % 180) + 180) % 180;
  return { fwhm: FWHM_SIGMA * Math.sqrt(fit.sx * fit.sy), fwhmMajor: FWHM_SIGMA * a, fwhmMinor: FWHM_SIGMA * b, ellipticity: 1 - b / a, angle: ang };
}

// ---------------------------------------------------------------------------------------------------------
// Shape and asymmetry of one star from its moments

/**
 * The 2-D light distribution of a star described by its moments, for the asymmetry a single radial profile hides.
 * Sky-subtracted pixels whose centres lie within `radius` of the centroid are used without weighting (the centroid is
 * iterated inside that circle). With F = sum I:
 *   centroid       xc = sum I x / F
 *   second moments Ixx = sum I dx^2 / F, Iyy, Ixy: the eigenvalues l1 >= l2 give the axes a = sqrt(l1), b = sqrt(l2);
 *                  ellipticity 1 - b/a (as psfShape, so the two are comparable) and the major axis at
 *                  0.5 atan2(2 Ixy, Ixx - Iyy), counter-clockwise from +x (y up)
 *   coma           C = (Ixxx + Ixyy, Ixxy + Iyyy) / s^3 with s^2 = (Ixx + Iyy) / 2: the dipole (m = 1) part of the
 *                  third moments, dimensionless; it points from the core toward the side where the light trails, so a
 *                  pattern of C across the field reads tilt or decentring (coma) the way FWHM reads focus
 *   asymmetry      A = sum |I - I180| / (2 sum |I|), I180 the image rotated by 180 degrees about the centroid (cubic
 *                  convolution, Keys 1981: bilinear interpolation alone gives 0.01 for a perfectly symmetric 4 px star),
 *                  0 for any point-symmetric star (Abraham et al. 1996; Conselice et al. 2000); noise raises it, so
 *                  compare stars of similar signal to noise
 * With opts.weight = sigma_w every pixel is also weighted by exp(-r^2 / 2 sigma_w^2) about the centroid (iterated to its
 * fixed point), as in adaptive-moment shape measurement: the faint wings, where noise dominates the third moments,
 * count less. For a Gaussian star of covariance S the weighted moments are those of (S^-1 + sigma_w^-2 I)^-1.
 * @param opts { radius = 10, background = 0, recentre = true, weight (sigma_w, px; none by default) }
 * @returns { x, y, flux, ixx, iyy, ixy, a, b, ellipticity, angle, fwhm (2.3548 sqrt((a^2 + b^2) / 2)), coma: { x, y, size,
 *            angle }, asymmetry, n, stamp: { x0, y0, nx, ny, v (sky subtracted, row 0 = lowest y) } } or null
 */
export function psfMoments(data, w, h, x0, y0, opts = {}) {
  const R = opts.radius ?? 10, bg = opts.background ?? 0, sw = opts.weight > 0 ? opts.weight : 0, k2 = sw ? 0.5 / (sw * sw) : 0;
  let xc = x0, yc = y0;
  // every pixel inside R, its value times the weight about the current centroid (1 without one)
  const each = (fn) => {
    const xa = Math.max(0, Math.ceil(xc - R)), xb = Math.min(w - 1, Math.floor(xc + R)), ya = Math.max(0, Math.ceil(yc - R)), yb = Math.min(h - 1, Math.floor(yc + R));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const dx = x - xc, dy = y - yc, r2 = dx * dx + dy * dy; if (r2 > R * R) continue; const v = data[y * w + x]; if (v === v) fn(x, y, (v - bg) * (sw ? Math.exp(-k2 * r2) : 1), dx, dy); }
  };
  for (let it = 0; it < (opts.recentre === false ? 0 : 40); it++) {
    let F = 0, sx = 0, sy = 0; each((x, y, v) => { F += v; sx += v * x; sy += v * y; });
    if (!(F > 0)) return null;
    const nx = sx / F, ny = sy / F, moved = Math.hypot(nx - xc, ny - yc); xc = nx; yc = ny;
    if (moved < 1e-6) break;
  }
  let F = 0, n = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxxx = 0, Sxyy = 0, Sxxy = 0, Syyy = 0, Fx = 0, Fy = 0;
  each((x, y, v, dx, dy) => { F += v; n++; Fx += v * dx; Fy += v * dy; });
  if (!(F > 0) || n < 5) return null;
  // moments about the centroid of these very pixels (a residual offset after the last iteration is removed exactly)
  const ox = Fx / F, oy = Fy / F;
  each((x, y, v, dx0, dy0) => { const dx = dx0 - ox, dy = dy0 - oy; Sxx += v * dx * dx; Syy += v * dy * dy; Sxy += v * dx * dy; Sxxx += v * dx * dx * dx; Sxyy += v * dx * dy * dy; Sxxy += v * dx * dx * dy; Syyy += v * dy * dy * dy; });
  xc += ox; yc += oy;
  const ixx = Sxx / F, iyy = Syy / F, ixy = Sxy / F, tr = ixx + iyy, dif = Math.hypot((ixx - iyy) / 2, ixy);
  const l1 = tr / 2 + dif, l2 = Math.max(0, tr / 2 - dif), a = Math.sqrt(l1), b = Math.sqrt(l2);
  const angle = ((0.5 * Math.atan2(2 * ixy, ixx - iyy) * 180 / Math.PI) + 180) % 180, s3 = Math.pow(tr / 2, 1.5);
  const cx = (Sxxx + Sxyy) / F / s3, cy = (Sxxy + Syyy) / F / s3;
  // 180-degree rotational asymmetry about the centroid
  let num = 0, den = 0;
  each((x, y, v, dx, dy) => { const r = bicubic(data, w, h, 2 * xc - x, 2 * yc - y), wt = sw ? Math.exp(-k2 * (dx * dx + dy * dy)) : 1; if (r === r) { num += Math.abs(v - (r - bg) * wt); den += Math.abs(v); } });   // the weight is the same at a pixel and its mirror
  // the stamp, for drawing
  const sx0 = Math.max(0, Math.floor(xc - R)), sx1 = Math.min(w - 1, Math.ceil(xc + R)), sy0 = Math.max(0, Math.floor(yc - R)), sy1 = Math.min(h - 1, Math.ceil(yc + R));
  const snx = sx1 - sx0 + 1, sny = sy1 - sy0 + 1, sv = new Float64Array(snx * sny);
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) sv[(y - sy0) * snx + (x - sx0)] = data[y * w + x] - bg;
  return {
    x: xc, y: yc, flux: F, ixx, iyy, ixy, a, b, ellipticity: a > 0 ? 1 - b / a : 0, angle, fwhm: FWHM_SIGMA * Math.sqrt(tr / 2),
    coma: { x: cx, y: cy, size: Math.hypot(cx, cy), angle: ((Math.atan2(cy, cx) * 180 / Math.PI) + 360) % 360 },
    asymmetry: den > 0 ? num / (2 * den) : NaN, n, stamp: { x0: sx0, y0: sy0, nx: snx, ny: sny, v: sv },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Focus across the field

const median = (arr) => { const a = Float64Array.from(arr).sort(), n = a.length; return n ? (n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1])) : NaN; };

/**
 * Measure every usable star of a frame and describe the focus across the field, as CCDInspector-style tools do.
 * Stars are found with detectSources. A star is measured only when it is bright enough for its shape to mean
 * something and does not distort it; every other detected star is returned in `rejected` with the reason:
 *   'saturated'  peak at or above 90% of the saturation level (non-linear before it clips); without a level (a
 *                floating-point frame without SATURATE), a flat top: peak within 5% of the frame's maximum with at
 *                least 3 pixels of the 5 x 5 around it within 2% of the peak
 *   'edge'       the fitting box leaves the frame
 *   'faint'      signal to noise below minSnr, S/N = F / sqrt(F / gain + N sigma^2) with F the fitted flux (the
 *                detection's flux when the fit failed) and N the pixels of a circle of radius 1.5 FWHM: a faint star's
 *                width is mostly noise (and reads as soft)
 *   'fit'        the rotated-Gaussian fit failed or wandered
 *   'crowded'    a neighbour brighter than 5% of the star within the fitting box's half-width + 3 sigma, or a blend: an
 *                elongation above 0.3 and above the field's median by 0.2 (two stars too close to be separated)
 * (checked in this order, so a faint star is reported as faint whatever else applies)
 * Each star is fitted with a rotated Gaussian (fitPsf, two passes: the second with a box scaled to the median width)
 * and described by its moments (psfMoments: coma vector and 180-degree asymmetry) inside 3 FWHM, with a Gaussian
 * weight of sigma 0.7 FWHM: unweighted, the noise of the faint wings gives round stars of S/N 50 to 250 a coma of 1.8
 * (median); weighted, 0.04. The field is divided into nx x ny cells (each with the median FWHM, ellipticity and
 * the mean elongation direction), and a quadratic surface FWHM(x, y) is fitted with one 3-sigma rejection.
 * Elongation pattern: <cos 2(angle - radial direction)> weighted by ellipticity is +1 for stars stretched along the
 * radius from the centre, -1 for tangential stretching (both point to optics: field curvature, coma, astigmatism,
 * tilt), while a large |<exp(2 i angle)>| means all stars point the same way (tracking or guiding, wind shake).
 * Tip/tilt: a plane FWHM = f0 + gx (x - xc) + gy (y - yc) is fitted to the stars by least squares (one 3-sigma
 * rejection); a tilted sensor makes one side of the frame softer, so `plane` gives the change of FWHM across the frame
 * along the gradient, its direction (toward the softer side, counter-clockwise from +x) and its significance.
 * Coma pattern: the coma vectors (psfMoments) averaged as for elongation: `comaCoherence` |sum C| / sum |C| near 1 when
 * every star trails the same way (a decentred or tilted optic), `comaRadial` <C . r_hat> / <|C|> over the outer stars,
 * +1 when tails point away from the centre and -1 toward it.
 * @param opts { nx = 3, ny = 3, max = 250, nsigma = 8, saturation = Infinity, minSnr = 30, gain = 1, pixelScale }
 * @returns { stars: [{ x, y, fwhm, fwhmMajor, fwhmMinor, ellipticity, angle, peak, flux, snr, coma, asymmetry }],
 *            rejected: [{ x, y, peak, flux, reason }], cells: [{ ix, iy, x0, x1, y0, y1, n, fwhm, ellipticity, angle,
 *            coherence }], surface (polySurface result or null), summary: { n, rejected: { reason: count }, minSnr,
 *            fwhm (median), fwhmCentre, fwhmCorners [lower left, lower right, upper left, upper right], curvature, tilt,
 *            worstCorner, plane: { f0, gx, gy, across, fraction, angle, sigma, n } or null, best: {x, y} or null,
 *            ellipticity (median), radial, coherence, angle, coma (median |C|), comaCoherence, comaAngle, comaRadial,
 *            asymmetry (median), verdict: [] } }
 */
export function focusMap(data, w, h, opts = {}) {
  const { nx = 3, ny = 3, max = 250, nsigma = 8, saturation = Infinity, minSnr = 30, gain = 1 } = opts;
  const det = detectSources(data, w, h, { nsigma, max, border: 6, minSep: 4, saturation, half: 6 });
  const src = det.sources;
  // saturation: 90% of a known level; without one, a flat top at the frame's maximum
  let fmax = -Infinity; for (let i = 0; i < data.length; i++) if (data[i] > fmax) fmax = data[i];
  const flatTop = (s) => {
    if (!(s.peak >= 0.95 * fmax)) return false;
    const cx = Math.round(s.x), cy = Math.round(s.y); let k = 0;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) if (x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 0.98 * s.peak) k++;
    return k >= 3;
  };
  const isSat = (s) => (Number.isFinite(saturation) ? s.peak >= 0.9 * saturation : flatTop(s));
  const fitAll = (half, s0) => {
    const out = [], rej = [];
    for (let i = 0; i < src.length; i++) {
      const s = src[i], no = (reason) => rej.push({ x: s.x, y: s.y, peak: s.peak, flux: s.flux, reason });
      // in this order, so that a faint star is called faint whatever else is wrong with it (and is not marked)
      if (s.saturated || isSat(s)) { no('saturated'); continue; }
      if (s.x < half || s.y < half || s.x > w - 1 - half || s.y > h - 1 - half) { no('edge'); continue; }
      const f = fitPsf(data, w, h, s.x, s.y, half, { model: 'gaussian', rotate: true, sigma: s0 });
      const fitOk = f.ok && f.amp > 5 * det.sigma && f.sx > 0.35 && f.sy > 0.35 && f.sx <= half && f.sy <= half && Math.hypot(f.x - s.x, f.y - s.y) <= 2;
      const sh = fitOk ? psfShape(f) : null, fwhm0 = sh ? sh.fwhm : FWHM_SIGMA * s0, F0 = fitOk ? f.flux : s.flux;
      const snr = F0 / Math.sqrt(Math.max(0, F0) / gain + Math.PI * (1.5 * fwhm0) ** 2 * det.sigma * det.sigma);
      if (!(snr >= minSnr)) { no('faint'); continue; }
      if (!fitOk) { no('fit'); continue; }
      // crowded: a neighbour brighter than 5% of the star whose light reaches the fitting box (box half-width + 3 sigma)
      let crowded = false; const rc = half + 3 * s0; for (let j = 0; j < src.length && !crowded; j++) if (j !== i && Math.hypot(src[j].x - s.x, src[j].y - s.y) < rc && src[j].flux > 0.05 * s.flux) crowded = true;
      if (crowded) { no('crowded'); continue; }
      out.push({ x: f.x, y: f.y, ...sh, peak: s.peak, flux: f.flux, snr });
    }
    return { out, rej };
  };
  let pass = fitAll(7, 1.5);
  if (pass.out.length) { const sg = median(pass.out.map((s) => s.fwhm)) / FWHM_SIGMA, half = Math.max(5, Math.min(25, Math.round(4 * sg))); if (half !== 7) pass = fitAll(half, sg); }
  // blends: a star far more elongated than the field's stars (two stars too close to be separated) is crowded too
  let stars = pass.out; const rejected = pass.rej;
  if (stars.length >= 5) { const me = median(stars.map((s) => s.ellipticity)), lim = Math.max(0.3, me + 0.2); for (const s of stars) if (s.ellipticity > lim) rejected.push({ x: s.x, y: s.y, peak: s.peak, flux: s.flux, reason: 'crowded', blend: true }); stars = stars.filter((s) => s.ellipticity <= lim); }
  // moments of each measured star inside 3 FWHM, sky from an annulus just outside
  for (const s of stars) {
    const R = Math.max(4, 3 * s.fwhm), sky = annulusBackground(data, w, h, s.x, s.y, R + 2, R + 6)[0];
    const m = psfMoments(data, w, h, s.x, s.y, { radius: R, background: Number.isFinite(sky) ? sky : det.background, weight: 0.7 * s.fwhm });
    s.coma = m ? m.coma : null; s.asymmetry = m ? m.asymmetry : NaN;
  }
  // cells
  const cells = [];
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x0 = ix * w / nx - 0.5, x1 = (ix + 1) * w / nx - 0.5, y0 = iy * h / ny - 0.5, y1 = (iy + 1) * h / ny - 0.5;
    const inn = stars.filter((s) => s.x >= x0 && s.x < x1 && s.y >= y0 && s.y < y1);
    let c = 0, sn = 0, we = 0; for (const s of inn) { const a = 2 * s.angle * Math.PI / 180; c += s.ellipticity * Math.cos(a); sn += s.ellipticity * Math.sin(a); we += s.ellipticity; }
    cells.push({ ix, iy, x0, x1, y0, y1, n: inn.length, fwhm: median(inn.map((s) => s.fwhm)), ellipticity: median(inn.map((s) => s.ellipticity)), angle: inn.length ? ((Math.atan2(sn, c) * 90 / Math.PI) + 180) % 180 : NaN, coherence: we > 0 ? Math.hypot(c, sn) / we : NaN });
  }
  // quadratic surface with one rejection pass
  let surface = null;
  if (stars.length >= 12) {
    const X = Float64Array.from(stars, (s) => s.x), Y = Float64Array.from(stars, (s) => s.y), F = Float64Array.from(stars, (s) => s.fwhm), keep = new Uint8Array(stars.length).fill(1);
    surface = polySurface(X, Y, F, 2, keep, { centre: [(w - 1) / 2, (h - 1) / 2] });
    if (surface) { let q = 0; for (let i = 0; i < F.length; i++) q += (F[i] - surface.fitted[i]) ** 2; const sd = Math.sqrt(q / F.length); let drop = 0; for (let i = 0; i < F.length; i++) if (Math.abs(F[i] - surface.fitted[i]) > 3 * sd) { keep[i] = 0; drop++; } if (drop) surface = polySurface(X, Y, F, 2, keep, { centre: [(w - 1) / 2, (h - 1) / 2] }) || surface; }
  }
  // summary
  const cell = (ix, iy) => cells[iy * nx + ix], cx = (w - 1) / 2, cy = (h - 1) / 2;
  const centreCell = cell(Math.floor(nx / 2), Math.floor(ny / 2)), corners = [cell(0, 0), cell(nx - 1, 0), cell(0, ny - 1), cell(nx - 1, ny - 1)];
  const fc = centreCell.n ? centreCell.fwhm : surface ? surface.evaluate(cx, cy) : NaN, fco = corners.map((c) => (c.n ? c.fwhm : NaN));
  const goodCorners = fco.filter(Number.isFinite), meanCorner = goodCorners.length ? goodCorners.reduce((a, b) => a + b, 0) / goodCorners.length : NaN;
  const curvature = (meanCorner - fc) / fc, tilt = goodCorners.length >= 2 ? (Math.max(...goodCorners) - Math.min(...goodCorners)) / fc : NaN;
  const worstCorner = goodCorners.length ? ['lower left', 'lower right', 'upper left', 'upper right'][fco.indexOf(Math.max(...goodCorners))] : null;
  let rad = 0, cc = 0, ss = 0, we = 0;
  for (const s of stars) { const a = s.angle * Math.PI / 180, phi = Math.atan2(s.y - cy, s.x - cx), d = Math.hypot(s.x - cx, s.y - cy); if (d > 0.15 * Math.hypot(w, h)) rad += s.ellipticity * Math.cos(2 * (a - phi)); cc += s.ellipticity * Math.cos(2 * a); ss += s.ellipticity * Math.sin(2 * a); we += s.ellipticity; }
  const outer = stars.filter((s) => Math.hypot(s.x - cx, s.y - cy) > 0.15 * Math.hypot(w, h)).reduce((a, s) => a + s.ellipticity, 0);
  const radial = outer > 0 ? rad / outer : NaN, coherence = we > 0 ? Math.hypot(cc, ss) / we : NaN, angle = ((Math.atan2(ss, cc) * 90 / Math.PI) + 180) % 180;
  // where the quadratic surface is lowest, when it has a minimum inside the frame
  let best = null;
  if (surface) {
    const c = {}; surface.terms.forEach((t, k) => { c[t.join('')] = surface.coef[k]; });
    const a = c['20'] || 0, b = c['11'] || 0, d = c['02'] || 0, gx = c['10'] || 0, gy = c['01'] || 0, det2 = 4 * a * d - b * b;
    if (a > 0 && det2 > 0) { const ux = (-2 * d * gx + b * gy) / det2, uy = (b * gx - 2 * a * gy) / det2, bx = surface.xc + ux, by = surface.yc + uy; if (bx >= 0 && by >= 0 && bx <= w - 1 && by <= h - 1) best = { x: bx, y: by }; }
  }
  // tip/tilt: a plane through FWHM(x, y), one 3-sigma rejection
  let plane = null;
  if (stars.length >= 8) {
    const fitPlane = (use) => {
      const A = new Float64Array(9), b = new Float64Array(3); let k = 0;
      for (const s of use) { const r = [1, s.x - cx, s.y - cy]; for (let i = 0; i < 3; i++) { b[i] += r[i] * s.fwhm; for (let j = 0; j < 3; j++) A[i * 3 + j] += r[i] * r[j]; } k++; }
      const c = solve(Float64Array.from(A), Float64Array.from(b), 3); if (!c || !c.every(Number.isFinite)) return null;
      let q = 0; for (const s of use) q += (s.fwhm - (c[0] + c[1] * (s.x - cx) + c[2] * (s.y - cy))) ** 2;
      return { c, A, rms: Math.sqrt(q / Math.max(1, k - 3)), n: k };
    };
    let p = fitPlane(stars);
    if (p) { const keep = stars.filter((s) => Math.abs(s.fwhm - (p.c[0] + p.c[1] * (s.x - cx) + p.c[2] * (s.y - cy))) <= 3 * p.rms); if (keep.length >= 8 && keep.length < stars.length) p = fitPlane(keep) || p; }
    if (p) {
      // the gradient's covariance from the normal matrix: sigma of |grad| along its own direction
      const inv = (() => { const M = p.A, e = []; for (let j = 0; j < 3; j++) { const col = solve(Float64Array.from(M), Float64Array.from([0, 1, 2].map((i) => (i === j ? 1 : 0))), 3); e.push(col); } return e; })();
      const [, gx, gy] = p.c, g = Math.hypot(gx, gy), ux = g > 0 ? gx / g : 1, uy = g > 0 ? gy / g : 0;
      const varG = inv.every(Boolean) ? p.rms * p.rms * (ux * ux * inv[1][1] + 2 * ux * uy * inv[1][2] + uy * uy * inv[2][2]) : NaN;
      const across = g * (Math.abs(ux) * (w - 1) + Math.abs(uy) * (h - 1));
      plane = { f0: p.c[0], gx, gy, across, fraction: across / p.c[0], angle: ((Math.atan2(gy, gx) * 180 / Math.PI) + 360) % 360, sigma: varG > 0 ? g / Math.sqrt(varG) : NaN, n: p.n };
    }
  }
  // coma pattern
  let csx = 0, csy = 0, csz = 0, crad = 0, cout = 0;
  for (const s of stars) {
    if (!s.coma || !Number.isFinite(s.coma.size)) continue;
    csx += s.coma.x; csy += s.coma.y; csz += s.coma.size;
    const d = Math.hypot(s.x - cx, s.y - cy); if (d > 0.15 * Math.hypot(w, h)) { crad += (s.coma.x * (s.x - cx) + s.coma.y * (s.y - cy)) / d; cout += s.coma.size; }
  }
  const coma = median(stars.filter((s) => s.coma).map((s) => s.coma.size)), comaCoherence = csz > 0 ? Math.hypot(csx, csy) / csz : NaN, comaAngle = ((Math.atan2(csy, csx) * 180 / Math.PI) + 360) % 360, comaRadial = cout > 0 ? crad / cout : NaN;
  const asymmetry = median(stars.map((s) => s.asymmetry).filter(Number.isFinite));
  const rejCount = {}; for (const r of rejected) rejCount[r.reason] = (rejCount[r.reason] || 0) + 1;
  const compass = (a) => ['+x (right)', 'upper right', '+y (up)', 'upper left', '-x (left)', 'lower left', '-y (down)', 'lower right'][Math.round(a / 45) % 8];
  const ell = median(stars.map((s) => s.ellipticity)), verdict = [];
  if (stars.length < 5) verdict.push(`Too few bright, unsaturated, isolated stars to judge the focus${rejCount.faint ? ` (${rejCount.faint} fainter than S/N ${minSnr}: lower the limit, or use a longer exposure)` : ''}.`);
  else {
    if (Number.isFinite(curvature) && curvature > 0.15) verdict.push(`Corners are ${(100 * curvature).toFixed(0)}% softer than the centre: field curvature or off-axis aberration (a field flattener or the correct back-focus spacing would help).`);
    if (plane && plane.fraction > 0.1 && plane.sigma > 3) verdict.push(`The FWHM rises by ${(100 * plane.fraction).toFixed(0)}% across the frame toward the ${compass(plane.angle)} (${plane.sigma.toFixed(0)}σ): the sensor may be tilted (tip/tilt), or the frame is not centred on the optical axis.`);
    else if (Number.isFinite(tilt) && tilt > 0.15) verdict.push(`The corners differ by ${(100 * tilt).toFixed(0)}% of the central FWHM, worst ${worstCorner}: the sensor may be tilted, or the frame is not centred on the optical axis.`);
    if (coma > 0.15 && comaCoherence > 0.6) verdict.push(`Stars trail toward the ${compass(comaAngle)} across the whole field (coma ${coma.toFixed(2)}): a decentred or tilted optic (collimation), or guiding that jumped during the exposure.`);
    else if (coma > 0.15 && Number.isFinite(comaRadial) && Math.abs(comaRadial) > 0.5) verdict.push(`Off-axis stars trail ${comaRadial > 0 ? 'away from' : 'toward'} the centre of the frame: coma from the optics (collimation or back-focus spacing).`);
    if (ell > 0.15 && coherence > 0.6) verdict.push(`Stars are elongated by ${(100 * ell).toFixed(0)}% all in the same direction (${angle.toFixed(0)}° from +x): tracking, guiding or wind shake rather than the optics.`);
    else if (ell > 0.12 && Number.isFinite(radial) && Math.abs(radial) > 0.3) verdict.push(`Off-axis stars are stretched ${radial > 0 ? 'along the radius (coma-like)' : 'across the radius (astigmatism or curvature)'}.`);
    if (!verdict.length) verdict.push('The focus is even across the field.');
  }
  return {
    stars, rejected, cells, surface, background: det.background, noise: det.sigma,
    summary: { n: stars.length, rejected: rejCount, minSnr, fwhm: median(stars.map((s) => s.fwhm)), fwhmCentre: fc, fwhmCorners: fco, curvature, tilt, worstCorner, plane, best, ellipticity: ell, radial, coherence, angle, coma, comaCoherence, comaAngle, comaRadial, asymmetry, pixelScale: opts.pixelScale ?? NaN, verdict },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Comparison stars

/**
 * Rank the detected stars as comparison stars for a target: similar brightness (|ln flux ratio|), unsaturated,
 * isolated (no neighbour brighter than 10% of the star within `crowd` FWHM), far enough from the edge for the sky
 * annulus, and with a round, normal-width profile when shapes are given (a galaxy or a blend is wider than the PSF;
 * elongation counts when it exceeds 0.3 and the field's median by 0.15, so a field-wide stretch singles out no star).
 * @param sources  [{ x, y, flux, peak, saturated, fwhm? }] (detectSources output, optionally with psfShape fields)
 * @param target   { x, y, flux }
 * @param opts     { w, h, fwhm = 4, edge (px, default 4 FWHM), crowd = 4, saturation = Infinity, maxRatio = 10 }
 * @returns [{ ...source, ratio, isolation (nearest bright neighbour, FWHM), score (lower is better), usable, notes: [] }]
 *          sorted best first; the target itself is excluded
 */
export function rankComparisons(sources, target, opts = {}) {
  const { w = Infinity, h = Infinity, fwhm = 4, crowd = 4, saturation = Infinity, maxRatio = 10 } = opts, edge = opts.edge ?? 4 * fwhm;
  const wid = sources.map((s) => s.fwhm).filter(Number.isFinite), medW = wid.length ? median(wid) : NaN;
  // elongation against the field's: when every star is stretched the same way (tracking, optics), none is singled out
  const ell = sources.map((s) => s.ellipticity).filter(Number.isFinite), medE = ell.length >= 5 ? median(ell) : 0, eLim = Math.max(0.3, medE + 0.15);
  const out = [];
  for (const s of sources) {
    if (Math.hypot(s.x - target.x, s.y - target.y) < 2 * fwhm) continue;
    const notes = []; let pen = 0;
    const ratio = s.flux / target.flux; pen += Math.abs(Math.log(ratio));
    if (!(ratio > 1 / maxRatio && ratio < maxRatio)) { notes.push(ratio < 1 ? `${(1 / ratio).toFixed(0)}× fainter` : `${ratio.toFixed(0)}× brighter`); pen += 3; }
    if (s.saturated || s.peak >= saturation) { notes.push('saturated'); pen += 10; }
    let iso = Infinity; for (const o of sources) { if (o === s) continue; const d = Math.hypot(o.x - s.x, o.y - s.y) / fwhm; if (o.flux > 0.1 * s.flux && d < iso) iso = d; }
    if (iso < crowd) { notes.push(`neighbour at ${iso.toFixed(1)} FWHM`); pen += 2 * (crowd - iso) / crowd + 1; }
    const de = Math.min(s.x, s.y, w - 1 - s.x, h - 1 - s.y);
    if (de < edge) { notes.push('near the edge'); pen += 2; }
    if (Number.isFinite(s.fwhm) && medW > 0 && s.fwhm > 1.3 * medW) { notes.push('wider than the other stars'); pen += 1.5; }
    if (Number.isFinite(s.ellipticity) && s.ellipticity > eLim) { notes.push(medE > 0.15 ? 'more elongated than the other stars' : 'elongated'); pen += 1; }
    out.push({ ...s, ratio, isolation: iso, score: pen, usable: notes.length === 0 || (notes.length === 1 && /fainter|brighter/.test(notes[0]) && ratio > 0.05 && ratio < 20), notes });
  }
  return out.sort((a, b) => a.score - b.score);
}

// ---------------------------------------------------------------------------------------------------------
// Optimal aperture

/**
 * The aperture radius with the highest signal to noise, from a curve of growth (radialProfile's `growth`): for each
 * radius r, S(r) / sqrt(S(r)/gain + A(r) sky² (1 + A(r)/nSky)), with A = pi r² and sky the noise per pixel in counts
 * (sky photons and read noise; default the radial profile's annulus sigma). For a Gaussian star on a sky-limited frame
 * the maximum is at r = 1.585 sigma = 0.673 FWHM (Howell 1989, PASP 101, 616; Naylor 1998, MNRAS 296, 339); a bright
 * star's photon noise moves it outward, which is why the reduction still searches a range of radii around it.
 * @param prof radialProfile output (growth.r, growth.flux, backgroundSigma, flux)
 * @param opts { skySigma, gain = 1 (Infinity: no photon noise from the star; 'sky': gainFromSky), nSky = Infinity (pixels in the sky annulus), minRadius = 0.5 }
 * @returns { radius, snr, fraction (of the flux inside rmax), curve: { r, snr } } or null without a usable curve of growth
 */
export function optimalAperture(prof, opts = {}) {
  const { nSky = Infinity, minRadius = 0.5 } = opts, sky = Number.isFinite(opts.skySigma) ? opts.skySigma : prof.backgroundSigma;
  const gain = opts.gain === 'sky' ? gainFromSky(prof.background, prof.backgroundSigma).gain : opts.gain ?? 1;
  if (!prof || !prof.growth || !(sky >= 0)) return null;
  const { r, flux } = prof.growth, snr = new Float64Array(r.length);
  let best = -1;
  for (let i = 0; i < r.length; i++) {
    const S = flux[i], A = Math.PI * r[i] * r[i];
    snr[i] = r[i] >= minRadius && S > 0 ? S / Math.sqrt(S / gain + A * sky * sky * (1 + A / nSky)) : NaN;
    if (Number.isFinite(snr[i]) && (best < 0 || snr[i] > snr[best])) best = i;
  }
  if (best < 0) return null;
  // parabola through the peak and its neighbours, for a radius between the grid steps
  let rad = r[best];
  if (best > 0 && best < r.length - 1 && Number.isFinite(snr[best - 1]) && Number.isFinite(snr[best + 1])) { const a = snr[best - 1], b = snr[best], c = snr[best + 1], den = a - 2 * b + c; if (den < 0) rad = r[best] + 0.5 * (a - c) / den * (r[best + 1] - r[best]); }
  const total = prof.flux > 0 ? prof.flux : flux[flux.length - 1];
  return { radius: rad, snr: snr[best], fraction: total > 0 ? flux[best] / total : NaN, gain, curve: { r, snr } };
}

/**
 * A lower bound on the gain [e-/ADU] from the sky alone, when no GAIN keyword is known: the sky's variance is
 * sky / gain + read noise², so gain >= sky / variance (equal when read noise is negligible). Using the bound overstates
 * the stars' photon noise a little. A sky-subtracted frame (sky near 0) bounds nothing: gain Infinity (sky-limited).
 * `sigma` is taken to be a 3-sigma-clipped estimate (as radialProfile's backgroundSigma) and corrected for the clipping.
 * @returns { gain, bound: true when a bound was found }
 */
export function gainFromSky(sky, sigma, { clipped = 3 } = {}) {
  // a sigma-clipped standard deviation is low for Gaussian noise: by 1.3% at 3 sigma (sqrt of the truncated variance)
  const k = clipped ? Math.sqrt(1 - 2 * clipped * Math.exp(-clipped * clipped / 2) / Math.sqrt(2 * Math.PI) / (1 - 2 * normTail(clipped))) : 1, s = sigma / k;
  const g = sky > 0 && s > 0 ? sky / (s * s) : NaN;
  return Number.isFinite(g) && g > 0.05 ? { gain: g, bound: true } : { gain: Infinity, bound: false };
}

// upper tail of the standard normal, P(Z > z) (Abramowitz & Stegun 7.1.26 through erfc, |error| < 1.5e-7)
function normTail(z) { const x = z / Math.SQRT2, t = 1 / (1 + 0.3275911 * x), e = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return 0.5 * e; }
