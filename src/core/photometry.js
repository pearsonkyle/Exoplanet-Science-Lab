// Photometry on images: background, centroids, aperture and PSF photometry, source detection, tracking stars
// from frame to frame, and the choice of aperture / sky annulus / comparison star by residual scatter, the way
// EXOTIC does it (exotic/exotic.py: aperPhot, skybg_phot, fit_centroid and the loop over `apers` and `annuli`).
// No DOM. Images are typed arrays, data[y * width + x], pixel centres at integer coordinates (photutils'
// convention), and nothing here allocates per pixel: scratch buffers are module-level and reused.
//
// Checked against astropy + photutils + scipy in test/photometry.test.mjs (reference made by
// test/make_photometry_reference.py).

import { erfc } from './stats.js';
import { ensembleWeights } from './detrend.js';

// ---------------------------------------------------------------------------------------------------------
// Exact overlap of a circle with a pixel (the algorithm of photutils.geometry.circular_overlap_grid, 'exact')

function areaArc(x1, y1, x2, y2, r) {
  const a = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)), th = 2 * Math.asin(Math.min(1, 0.5 * a / r));
  return 0.5 * r * r * (th - Math.sin(th));
}
const areaTri = (x1, y1, x2, y2, x3, y3) => 0.5 * Math.abs(x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));

// rectangle entirely in the first quadrant, circle centred on the origin
function overlapCore(xmin, ymin, xmax, ymax, r) {
  const r2 = r * r;
  if (xmin * xmin + ymin * ymin > r2) return 0;
  if (xmax * xmax + ymax * ymax < r2) return (xmax - xmin) * (ymax - ymin);
  const d1 = Math.sqrt(xmax * xmax + ymin * ymin), d2 = Math.sqrt(xmin * xmin + ymax * ymax);
  if (d1 < r && d2 < r) {
    const x1 = Math.sqrt(r2 - ymax * ymax), y1 = ymax, x2 = xmax, y2 = Math.sqrt(r2 - xmax * xmax);
    return (xmax - xmin) * (ymax - ymin) - areaTri(x1, y1, x2, y2, xmax, ymax) + areaArc(x1, y1, x2, y2, r);
  }
  if (d1 < r) {
    const x1 = xmin, y1 = Math.sqrt(r2 - xmin * xmin), x2 = xmax, y2 = Math.sqrt(r2 - xmax * xmax);
    return areaArc(x1, y1, x2, y2, r) + areaTri(x1, y1, x1, ymin, xmax, ymin) + areaTri(x1, y1, x2, ymin, x2, y2);
  }
  if (d2 < r) {
    const x1 = Math.sqrt(r2 - ymin * ymin), y1 = ymin, x2 = Math.sqrt(r2 - ymax * ymax), y2 = ymax;
    return areaArc(x1, y1, x2, y2, r) + areaTri(x1, y1, xmin, y1, xmin, ymax) + areaTri(x1, y1, xmin, y2, x2, y2);
  }
  const x1 = Math.sqrt(r2 - ymin * ymin), y1 = ymin, x2 = xmin, y2 = Math.sqrt(r2 - xmin * xmin);
  return areaArc(x1, y1, x2, y2, r) + areaTri(x1, y1, x2, y2, xmin, ymin);
}

/** Area of the rectangle [xmin, xmax] x [ymin, ymax] inside the circle of radius r centred on the origin. */
export function circleRectOverlap(xmin, ymin, xmax, ymax, r) {
  if (xmin >= 0) {
    if (ymin >= 0) return overlapCore(xmin, ymin, xmax, ymax, r);
    if (ymax <= 0) return overlapCore(-ymax, xmin, -ymin, xmax, r);
    return circleRectOverlap(xmin, ymin, xmax, 0, r) + circleRectOverlap(xmin, 0, xmax, ymax, r);
  }
  if (xmax <= 0) {
    if (ymin >= 0) return overlapCore(-xmax, ymin, -xmin, ymax, r);
    if (ymax <= 0) return overlapCore(-xmax, -ymax, -xmin, -ymin, r);
    return circleRectOverlap(xmin, ymin, xmax, 0, r) + circleRectOverlap(xmin, 0, xmax, ymax, r);
  }
  return circleRectOverlap(xmin, ymin, 0, ymax, r) + circleRectOverlap(0, ymin, xmax, ymax, r);
}

const RES = new Float64Array(8);

/**
 * Sum of the image inside a circular aperture of radius r centred on (xc, yc).
 * method 'exact': each pixel weighted by its exact overlap area with the circle (photutils method='exact').
 * method 'subpixel': each pixel split into subpixels^2 and weighted by the fraction of sub-pixel centres inside
 *   (photutils method='subpixel'). method 'center': pixels whose centre is inside.
 * Non-finite pixels are skipped (and counted). Pixels outside the image contribute nothing; `clipped` says so.
 * @returns the same Float64Array each call: [sum, area, max pixel value, clipped (0/1), number of NaN pixels]
 */
export function apertureSum(data, w, h, xc, yc, r, method = 'exact', subpixels = 5) {
  const x0 = Math.floor(xc - r + 0.5), x1 = Math.ceil(xc + r - 0.5), y0 = Math.floor(yc - r + 0.5), y1 = Math.ceil(yc + r - 0.5);
  const clipped = x0 < 0 || y0 < 0 || x1 >= w || y1 >= h;
  const xa = Math.max(0, x0), xb = Math.min(w - 1, x1), ya = Math.max(0, y0), yb = Math.min(h - 1, y1);
  const rin = r - 0.7072, rin2 = rin > 0 ? rin * rin : -1, rout = r + 0.7072, rout2 = rout * rout, r2 = r * r;
  let sum = 0, area = 0, peak = -Infinity, nan = 0;
  for (let y = ya; y <= yb; y++) {
    const dy = y - yc, row = y * w;
    for (let x = xa; x <= xb; x++) {
      const dx = x - xc, d2 = dx * dx + dy * dy;
      if (d2 >= rout2) continue;
      let f;
      if (d2 <= rin2) f = 1;
      else if (method === 'exact') f = circleRectOverlap(dx - 0.5, dy - 0.5, dx + 0.5, dy + 0.5, r);
      else if (method === 'center') f = d2 < r2 ? 1 : 0;
      else {
        let c = 0; const s = subpixels, st = 1 / s;
        for (let j = 0; j < s; j++) { const sy = dy - 0.5 + (j + 0.5) * st; for (let i = 0; i < s; i++) { const sx = dx - 0.5 + (i + 0.5) * st; if (sx * sx + sy * sy < r2) c++; } }
        f = c / (s * s);
      }
      if (f === 0) continue;
      const v = data[row + x];
      if (v !== v) { nan++; continue; }
      sum += f * v; area += f; if (v > peak) peak = v;
    }
  }
  RES[0] = sum; RES[1] = area; RES[2] = peak; RES[3] = clipped ? 1 : 0; RES[4] = nan;
  return RES;
}

// ---------------------------------------------------------------------------------------------------------
// Background

let SCR = new Float64Array(4096);
const scratch = (n) => { if (SCR.length < n) SCR = new Float64Array(Math.max(n, SCR.length * 2)); return SCR; };

/**
 * Sigma-clipped statistics of the first n values of `v` (sorted in place): clip about the median at
 * sigma * std, repeat up to maxiters times or until nothing is rejected. This is astropy's
 * sigma_clipped_stats(sigma, maxiters, cenfunc='median', stdfunc='std').
 * @returns the shared Float64Array [median, mean, std, count]
 */
export function sigmaClippedStats(v, n, sigma = 3, maxiters = 5, presorted = false) {
  const a = v.subarray(0, n); if (!presorted) a.sort();
  let lo = 0, hi = n;                                   // the kept window [lo, hi) of the sorted values
  const stats = () => {
    const m = hi - lo; if (m <= 0) return [NaN, NaN, NaN];
    const med = m & 1 ? a[lo + (m >> 1)] : 0.5 * (a[lo + (m >> 1) - 1] + a[lo + (m >> 1)]);
    let s = 0; for (let i = lo; i < hi; i++) s += a[i];
    const mean = s / m; let q = 0; for (let i = lo; i < hi; i++) { const d = a[i] - mean; q += d * d; }
    return [med, mean, Math.sqrt(q / m)];
  };
  let [med, mean, std] = stats();
  for (let it = 0; it < maxiters && hi - lo > 1; it++) {
    const lcut = med - sigma * std, hcut = med + sigma * std;
    let l2 = lo, h2 = hi;
    while (l2 < h2 && a[l2] < lcut) l2++;
    while (h2 > l2 && a[h2 - 1] > hcut) h2--;
    if (l2 === lo && h2 === hi) break;
    lo = l2; hi = h2; [med, mean, std] = stats();
  }
  RES[0] = med; RES[1] = mean; RES[2] = std; RES[3] = hi - lo;
  return RES;
}

/**
 * Sky background in an annulus rin <= d < rout about (xc, yc): pixels whose centres are in the annulus
 * (photutils CircularAnnulus mask, method='center'), sigma-clipped.
 * @returns the shared Float64Array [median, mean, std, count]   (count 0 and NaN values when the annulus is empty)
 */
export function annulusBackground(data, w, h, xc, yc, rin, rout, sigma = 3, maxiters = 5) {
  const xa = Math.max(0, Math.ceil(xc - rout)), xb = Math.min(w - 1, Math.floor(xc + rout)), ya = Math.max(0, Math.ceil(yc - rout)), yb = Math.min(h - 1, Math.floor(yc + rout));
  const buf = scratch(Math.max(1, (xb - xa + 1) * (yb - ya + 1))), r1 = rin * rin, r2 = rout * rout;
  let n = 0;
  for (let y = ya; y <= yb; y++) {
    const dy = y - yc, row = y * w;
    for (let x = xa; x <= xb; x++) {
      const dx = x - xc, d2 = dx * dx + dy * dy;
      if (d2 < r1 || d2 >= r2) continue;
      const v = data[row + x]; if (v === v) buf[n++] = v;
    }
  }
  if (!n) { RES[0] = RES[1] = RES[2] = NaN; RES[3] = 0; return RES; }
  return sigmaClippedStats(buf, n, sigma, maxiters);
}

// quicksort of v[lo..hi] carrying d along (values and their squared distances)
function sortPair(v, d, lo, hi) {
  const stack = [lo, hi];
  while (stack.length) {
    let h = stack.pop(), l = stack.pop();
    while (h - l > 16) {
      const m = (l + h) >> 1;
      if (v[m] < v[l]) { let t = v[m]; v[m] = v[l]; v[l] = t; t = d[m]; d[m] = d[l]; d[l] = t; }
      if (v[h] < v[l]) { let t = v[h]; v[h] = v[l]; v[l] = t; t = d[h]; d[h] = d[l]; d[l] = t; }
      if (v[h] < v[m]) { let t = v[h]; v[h] = v[m]; v[m] = t; t = d[h]; d[h] = d[m]; d[m] = t; }
      const pv = v[m]; let i = l, j = h;
      while (i <= j) { while (v[i] < pv) i++; while (v[j] > pv) j--; if (i <= j) { let t = v[i]; v[i] = v[j]; v[j] = t; t = d[i]; d[i] = d[j]; d[j] = t; i++; j--; } }
      if (j - l < h - i) { stack.push(i, h); h = j; } else { stack.push(l, j); l = i; }
    }
    for (let i = l + 1; i <= h; i++) { const x = v[i], y = d[i]; let j = i - 1; while (j >= l && v[j] > x) { v[j + 1] = v[j]; d[j + 1] = d[j]; j--; } v[j + 1] = x; d[j + 1] = y; }
  }
}
let PV = new Float64Array(4096), PD = new Float64Array(4096), PN = 0;
/**
 * Prepare several annuli about one centre: the pixels between rmin and rmax are collected and sorted by value
 * once; annulusFromSorted then gives the statistics of any annulus inside that range by one pass, with the same
 * result as annulusBackground (the sort is the cost, and a grid of annuli shares it).
 */
export function annulusPrepare(data, w, h, xc, yc, rmin, rmax) {
  const xa = Math.max(0, Math.ceil(xc - rmax)), xb = Math.min(w - 1, Math.floor(xc + rmax)), ya = Math.max(0, Math.ceil(yc - rmax)), yb = Math.min(h - 1, Math.floor(yc + rmax));
  const cap = Math.max(1, (xb - xa + 1) * (yb - ya + 1)); if (PV.length < cap) { PV = new Float64Array(cap * 2); PD = new Float64Array(cap * 2); }
  const r1 = rmin * rmin, r2 = rmax * rmax; let n = 0;
  for (let y = ya; y <= yb; y++) { const dy = y - yc, row = y * w; for (let x = xa; x <= xb; x++) { const dx = x - xc, d2 = dx * dx + dy * dy; if (d2 < r1 || d2 >= r2) continue; const v = data[row + x]; if (v === v) { PV[n] = v; PD[n++] = d2; } } }
  if (n > 1) sortPair(PV, PD, 0, n - 1);
  PN = n;
}
export function annulusFromSorted(rin, rout, sigma = 3, maxiters = 5) {
  const buf = scratch(Math.max(1, PN)), r1 = rin * rin, r2 = rout * rout; let n = 0;
  for (let i = 0; i < PN; i++) { const d = PD[i]; if (d >= r1 && d < r2) buf[n++] = PV[i]; }
  if (!n) { RES[0] = RES[1] = RES[2] = NaN; RES[3] = 0; return RES; }
  return sigmaClippedStats(buf, n, sigma, maxiters, true);
}

/**
 * Level and noise of a whole frame from a strided sample (at most ~`nsample` pixels): median and 1.4826 * MAD.
 * @returns { median, sigma }
 */
export function frameStats(data, w, h, nsample = 100000) {
  const n = w * h, step = Math.max(1, Math.floor(n / nsample)) | 1, buf = scratch(Math.ceil(n / step) + 1);
  let m = 0;
  for (let i = (step >> 1); i < n; i += step) { const v = data[i]; if (v === v) buf[m++] = v; }
  if (!m) return { median: NaN, sigma: NaN };
  const a = buf.subarray(0, m); a.sort();
  const med = a[m >> 1];
  for (let i = 0; i < m; i++) a[i] = Math.abs(a[i] - med);
  a.sort();
  return { median: med, sigma: 1.4826 * a[m >> 1] };
}

// ---------------------------------------------------------------------------------------------------------
// Centroids

/**
 * Flux-weighted centroid over the box of half-width `half` about (round(x0), round(y0)), after subtracting `bkg`:
 * sum(v x) / sum(v). This is photutils.centroids.centroid_com on the same cutout. Returns [x, y] in a shared array.
 */
export function centroidCom(data, w, h, x0, y0, half, bkg = 0) {
  const cx = Math.round(x0), cy = Math.round(y0);
  const xa = Math.max(0, cx - half), xb = Math.min(w - 1, cx + half), ya = Math.max(0, cy - half), yb = Math.min(h - 1, cy + half);
  let s = 0, sx = 0, sy = 0;
  for (let y = ya; y <= yb; y++) { const row = y * w; for (let x = xa; x <= xb; x++) { const v = data[row + x] - bkg; if (v !== v) continue; s += v; sx += v * x; sy += v * y; } }
  RES[0] = sx / s; RES[1] = sy / s; RES[2] = s;
  return RES;
}

/**
 * A centroid that survives a poor starting guess and a sloping sky: the level is the median of the box's
 * border, pixels under level + 3 sigma are ignored, and the box is re-centred until the centre moves by less
 * than 0.01 px (at most `iters` times); the position is then refined with a Gaussian-windowed centroid.
 * Returns [x, y, flux above the threshold, border level, border sigma, window sigma].
 */
export function centroidIter(data, w, h, x0, y0, half = 7, iters = 6) {
  let x = x0, y = y0, flux = 0, lev = 0, sig = 0;
  const buf = scratch(8 * half + 8);
  for (let it = 0; it < iters; it++) {
    const cx = Math.round(x), cy = Math.round(y);
    const xa = Math.max(0, cx - half), xb = Math.min(w - 1, cx + half), ya = Math.max(0, cy - half), yb = Math.min(h - 1, cy + half);
    if (xb - xa < 2 || yb - ya < 2) break;
    let n = 0;
    for (let xx = xa; xx <= xb; xx++) { let v = data[ya * w + xx]; if (v === v) buf[n++] = v; v = data[yb * w + xx]; if (v === v) buf[n++] = v; }
    for (let yy = ya + 1; yy < yb; yy++) { let v = data[yy * w + xa]; if (v === v) buf[n++] = v; v = data[yy * w + xb]; if (v === v) buf[n++] = v; }
    if (n < 4) break;
    const st = sigmaClippedStats(buf, n, 3, 3); lev = st[0]; sig = st[2];
    const thr = lev + 3 * sig;
    let s = 0, sx = 0, sy = 0;
    for (let yy = ya; yy <= yb; yy++) { const row = yy * w; for (let xx = xa; xx <= xb; xx++) { const v = data[row + xx]; if (!(v > thr)) continue; const f = v - lev; s += f; sx += f * xx; sy += f * yy; } }
    if (!(s > 0)) { flux = 0; break; }
    const nx = sx / s, ny = sy / s, moved = Math.hypot(nx - x, ny - y);
    x = nx; y = ny; flux = s;
    if (moved < 0.01) break;
  }
  if (flux > 0) {
    // second stage: Gaussian-windowed centroid (SExtractor's XWIN/YWIN), which is close to a PSF fit in precision
    // and is not pulled by noise pixels far from the star. Window sigma from the thresholded second moment.
    let cx = Math.round(x), cy = Math.round(y);
    let xa = Math.max(0, cx - half), xb = Math.min(w - 1, cx + half), ya = Math.max(0, cy - half), yb = Math.min(h - 1, cy + half);
    const thr = lev + 3 * sig; let s = 0, m2 = 0;
    for (let yy = ya; yy <= yb; yy++) { const row = yy * w; for (let xx = xa; xx <= xb; xx++) { const v = data[row + xx]; if (!(v > thr)) continue; const f = v - lev; s += f; m2 += f * ((xx - x) * (xx - x) + (yy - y) * (yy - y)); } }
    const sw = Math.min(half / 2, Math.max(1, Math.sqrt(m2 / (2 * s || 1)) * 1.15)), k = -0.5 / (sw * sw);
    for (let it = 0; it < 12; it++) {
      let sf = 0, sx = 0, sy = 0;
      for (let yy = ya; yy <= yb; yy++) { const row = yy * w, dy = yy - y; for (let xx = xa; xx <= xb; xx++) { const v = data[row + xx]; if (v !== v) continue; const dx = xx - x, wf = Math.exp(k * (dx * dx + dy * dy)) * (v - lev); sf += wf; sx += wf * dx; sy += wf * dy; } }
      if (!(sf > 0)) break;
      const ddx = 2 * sx / sf, ddy = 2 * sy / sf;
      if (!(Math.abs(ddx) < half && Math.abs(ddy) < half)) break;
      x += ddx; y += ddy;
      if (Math.abs(ddx) + Math.abs(ddy) < 0.002) break;
    }
    RES[5] = sw;
  }
  RES[0] = x; RES[1] = y; RES[2] = flux; RES[3] = lev; RES[4] = sig;
  return RES;
}

// ---- Levenberg-Marquardt for the small PSF fits (up to 7 parameters), normal equations accumulated per pixel
const NP = 7, JTJ = new Float64Array(NP * NP), JTR = new Float64Array(NP), GR = new Float64Array(NP), PTRY = new Float64Array(NP), MAT = new Float64Array(NP * NP), STEP = new Float64Array(NP);

function solveSym(A, b, n, x) {       // Cholesky; returns false when not positive definite
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j]; for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
    if (i === j) { if (!(s > 0)) return false; A[i * n + i] = Math.sqrt(s); } else A[i * n + j] = s / A[j * n + j];
  }
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= A[i * n + k] * x[k]; x[i] = s / A[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= A[k * n + i] * x[k]; x[i] = s / A[i * n + i]; }
  return true;
}

// model value and gradient at (dx, dy from the box origin); kind 0 Gaussian (p = x0, y0, amp, sx, sy, bg[, theta]), 1 Moffat (p = x0, y0, amp, gamma, beta, bg)
function psfEval(kind, p, x, y, np, g) {
  const dx = x - p[0], dy = y - p[1];
  if (kind === 0) {
    const th = np > 6 ? p[6] : 0, c = Math.cos(th), s = Math.sin(th), rx = dx * c - dy * s, ry = dx * s + dy * c;
    const u = rx / (p[3] * p[3]), v = ry / (p[4] * p[4]), E = Math.exp(-0.5 * (rx * u + ry * v)), AE = p[2] * E;
    g[0] = AE * (u * c + v * s); g[1] = AE * (-u * s + v * c); g[2] = E; g[3] = AE * rx * u / p[3]; g[4] = AE * ry * v / p[4]; g[5] = 1;
    if (np > 6) g[6] = AE * rx * ry * (1 / (p[3] * p[3]) - 1 / (p[4] * p[4]));
    return AE + p[5];
  }
  const g2 = p[3] * p[3], q = (dx * dx + dy * dy) / g2, base = 1 + q, M = Math.pow(base, -p[4]), k = p[2] * p[4] * M / base;
  g[0] = k * 2 * dx / g2; g[1] = k * 2 * dy / g2; g[2] = M; g[3] = k * 2 * q / p[3]; g[4] = -p[2] * M * Math.log(base); g[5] = 1;
  return p[2] * M + p[5];
}

// the model averaged over os x os points inside the pixel (os = 1: sampled at the centre), value and gradient
const GS = new Float64Array(NP);
function psfEvalOS(kind, p, x, y, np, g, os) {
  if (os <= 1) return psfEval(kind, p, x, y, np, g);
  let v = 0; for (let i = 0; i < np; i++) g[i] = 0;
  for (let j = 0; j < os; j++) for (let i = 0; i < os; i++) { v += psfEval(kind, p, x + (i + 0.5) / os - 0.5, y + (j + 0.5) / os - 0.5, np, GS); for (let q = 0; q < np; q++) g[q] += GS[q]; }
  const n = os * os; for (let i = 0; i < np; i++) g[i] /= n;
  return v / n;
}
function psfChi2(kind, p, np, data, w, xa, xb, ya, yb, os = 1) {
  let c = 0;
  for (let y = ya; y <= yb; y++) { const row = y * w; for (let x = xa; x <= xb; x++) { const v = data[row + x]; if (v !== v) continue; const r = psfEvalOS(kind, p, x, y, np, GR, os) - v; c += r * r; } }
  return c;
}

/**
 * Fit a PSF plus a constant background to the box of half-width `half` about (x0, y0) by least squares
 * (Levenberg-Marquardt, analytic derivatives, unweighted). The model is sampled at pixel centres as EXOTIC does,
 * or, with opts.oversample = n > 1, averaged over n x n points inside each pixel, which matters when the PSF is
 * narrower than about 1.5 px sigma (an undersampled star is not a Gaussian sampled at pixel centres).
 *   model 'gaussian': bg + amp * exp(-(rx^2 / 2 sx^2 + ry^2 / 2 sy^2)), optionally rotated (opts.rotate);
 *                     flux = 2 pi amp sx sy
 *   model 'moffat':   bg + amp * (1 + r^2 / gamma^2)^-beta;  flux = pi amp gamma^2 / (beta - 1);  fwhm = 2 gamma sqrt(2^(1/beta) - 1)
 * @returns { x, y, amp, sx, sy, theta, gamma, beta, bg, flux, fwhm, chi2, npix, iters, ok }
 */
export function fitPsf(data, w, h, x0, y0, half = 7, opts = {}) {
  const kind = opts.model === 'moffat' ? 1 : 0, np = kind === 0 && opts.rotate ? 7 : 6, os = Math.max(1, opts.oversample | 0);
  const cx = Math.round(x0), cy = Math.round(y0);
  const xa = Math.max(0, cx - half), xb = Math.min(w - 1, cx + half), ya = Math.max(0, cy - half), yb = Math.min(h - 1, cy + half);
  let mn = Infinity, mx = -Infinity, npix = 0;
  for (let y = ya; y <= yb; y++) { const row = y * w; for (let x = xa; x <= xb; x++) { const v = data[row + x]; if (v !== v) continue; npix++; if (v < mn) mn = v; if (v > mx) mx = v; } }
  const fail = { x: NaN, y: NaN, amp: NaN, sx: NaN, sy: NaN, theta: 0, gamma: NaN, beta: NaN, bg: NaN, flux: NaN, fwhm: NaN, chi2: NaN, npix, iters: 0, ok: false };
  if (npix < np + 3 || !(mx > mn)) return fail;
  const p = new Float64Array(np);
  const s0 = opts.sigma || 1.5;
  p[0] = x0; p[1] = y0; p[2] = mx - mn; p[5] = mn;
  if (kind === 0) { p[3] = s0; p[4] = s0; if (np > 6) p[6] = 0; } else { p[3] = s0 * 2; p[4] = 2.5; }
  const lim = (q) => {            // keep the fit physical: widths positive and inside the box, centre inside the box
    q[0] = Math.min(xb + 0.5, Math.max(xa - 0.5, q[0])); q[1] = Math.min(yb + 0.5, Math.max(ya - 0.5, q[1]));
    if (q[2] < 0) q[2] = 0;
    if (kind === 0) { q[3] = Math.min(4 * half, Math.max(0.3, Math.abs(q[3]))); q[4] = Math.min(4 * half, Math.max(0.3, Math.abs(q[4]))); if (np > 6) q[6] = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, q[6])); }
    else { q[3] = Math.min(8 * half, Math.max(0.3, Math.abs(q[3]))); q[4] = Math.min(50, Math.max(1.05, q[4])); }
  };
  let chi2 = psfChi2(kind, p, np, data, w, xa, xb, ya, yb, os), lambda = 1e-3, iters = 0, ok = false;
  for (; iters < 60; iters++) {
    JTJ.fill(0); JTR.fill(0);
    for (let y = ya; y <= yb; y++) {
      const row = y * w;
      for (let x = xa; x <= xb; x++) {
        const v = data[row + x]; if (v !== v) continue;
        const r = psfEvalOS(kind, p, x, y, np, GR, os) - v;
        for (let i = 0; i < np; i++) { const gi = GR[i]; JTR[i] += gi * r; for (let j = 0; j <= i; j++) JTJ[i * np + j] += gi * GR[j]; }
      }
    }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      for (let i = 0; i < np; i++) { for (let j = 0; j <= i; j++) MAT[i * np + j] = JTJ[i * np + j]; MAT[i * np + i] = JTJ[i * np + i] * (1 + lambda) + 1e-300; }
      if (!solveSym(MAT, JTR, np, STEP)) { lambda *= 10; continue; }
      for (let i = 0; i < np; i++) PTRY[i] = p[i] - STEP[i];
      lim(PTRY);
      const c2 = psfChi2(kind, PTRY, np, data, w, xa, xb, ya, yb, os);
      if (c2 < chi2) {
        let big = 0; for (let i = 0; i < np; i++) big = Math.max(big, Math.abs(PTRY[i] - p[i]) / (Math.abs(p[i]) + 1e-3));
        const rel = (chi2 - c2) / (chi2 || 1);
        p.set(PTRY.subarray(0, np)); chi2 = c2; lambda = Math.max(1e-9, lambda / 10); improved = true;
        if (big < 1e-9 || rel < 1e-14) ok = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) { ok = true; break; }
    if (ok) break;
  }
  if (iters >= 60) ok = true;        // ran out of iterations while still improving: the values are usable
  const res = { ...fail, x: p[0], y: p[1], amp: p[2], bg: p[5], chi2, iters, ok: ok && p[2] > 0 };
  if (kind === 0) { res.sx = p[3]; res.sy = p[4]; res.theta = np > 6 ? p[6] : 0; res.flux = 2 * Math.PI * p[2] * p[3] * p[4]; res.fwhm = 2.354820045 * Math.sqrt(p[3] * p[4]); }
  else { res.gamma = p[3]; res.beta = p[4]; res.flux = p[4] > 1 ? Math.PI * p[2] * p[3] * p[3] / (p[4] - 1) : NaN; res.fwhm = 2 * p[3] * Math.sqrt(Math.pow(2, 1 / p[4]) - 1); res.sx = res.sy = res.fwhm / 2.354820045; }
  return res;
}

// ---------------------------------------------------------------------------------------------------------
// Detection and tracking

let SM = null, SM2 = null;
/**
 * Find stars: 3x3 box smoothing, local maxima above nsigma (noise of the smoothed frame), then a centroid and a
 * rough flux for each. Single hot pixels are rejected (more than `sharp` of the 3x3 flux in one pixel).
 * @param opts { nsigma = 5, max = 60, border = 8, minSep = 6, sharp = 0.85, saturation = Infinity, half = 6 }
 * @returns { sources: [{ x, y, flux, peak, saturated }] sorted by flux, brightest first; background, sigma }
 */
export function detectSources(data, w, h, opts = {}) {
  const { nsigma = 5, max = 60, border = 8, minSep = 6, sharp = 0.85, saturation = Infinity, half = 6 } = opts;
  const n = w * h, { median, sigma } = frameStats(data, w, h);
  if (!SM || SM.length < n) { SM = new Float32Array(n); SM2 = new Float32Array(n); }
  const a = SM2, s = SM;
  // separable 3x3 sum; NaN pixels count as the background
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let p = data[row], c = p; if (p !== p) p = c = median;
    for (let x = 0; x < w; x++) { let nx = x + 1 < w ? data[row + x + 1] : c; if (nx !== nx) nx = median; a[row + x] = p + c + nx; p = c; c = nx; }
  }
  for (let y = 0; y < h; y++) { const row = y * w, up = (y > 0 ? y - 1 : y) * w, dn = (y + 1 < h ? y + 1 : y) * w; for (let x = 0; x < w; x++) s[row + x] = a[up + x] + a[row + x] + a[dn + x]; }
  const thr = 9 * median + nsigma * 3 * sigma, found = [];
  const b = Math.max(2, border);
  for (let y = b; y < h - b; y++) {
    const row = y * w;
    for (let x = b; x < w - b; x++) {
      const v = s[row + x];
      if (!(v > thr)) continue;
      // strict local maximum of the smoothed frame in 5x5
      let isMax = true;
      for (let j = -2; j <= 2 && isMax; j++) { const r2 = row + j * w; for (let i = -2; i <= 2; i++) { if (!i && !j) continue; const o = s[r2 + x + i]; if (o > v || (o === v && (j < 0 || (j === 0 && i < 0)))) { isMax = false; break; } } }
      if (!isMax) continue;
      const raw = data[row + x] - median, tot = v - 9 * median;
      if (raw > sharp * tot) continue;                                 // a hot pixel or cosmic ray, not a star
      found.push({ x, y, flux: tot, peak: data[row + x] });
    }
  }
  found.sort((p, q) => q.flux - p.flux);
  const out = [];
  for (const f of found) {
    if (out.length >= max) break;
    const c = centroidIter(data, w, h, f.x, f.y, half);
    const cx = c[0], cy = c[1], fl = c[2];
    if (!(fl > 0) || cx < b || cy < b || cx > w - 1 - b || cy > h - 1 - b) continue;
    if (out.some((o) => Math.hypot(o.x - cx, o.y - cy) < minSep)) continue;
    out.push({ x: cx, y: cy, flux: fl, peak: f.peak, saturated: f.peak >= saturation });
  }
  out.sort((p, q) => q.flux - p.flux);
  return { sources: out, background: median, sigma };
}

/**
 * Translation (and optionally a 180 degree flip, as after a meridian flip) that maps reference source positions
 * onto the sources of another frame, by voting on pairwise offsets among the brightest sources.
 * @returns { dx, dy, flip, votes }   new = ref + (dx, dy), or new = (w-1-ref.x, h-1-ref.y) + (dx, dy) when flip
 */
export function estimateShift(ref, cur, w, h, opts = {}) {
  const { nmax = 25, tol = 2, tryFlip = true } = opts;
  const A = ref.slice(0, nmax), B = cur.slice(0, nmax);
  let best = { dx: 0, dy: 0, flip: false, votes: 0 };
  for (const flip of tryFlip ? [false, true] : [false]) {
    const offs = [];
    for (const a of A) { const ax = flip ? w - 1 - a.x : a.x, ay = flip ? h - 1 - a.y : a.y; for (const b of B) offs.push([b.x - ax, b.y - ay]); }
    for (const o of offs) {
      let v = 0, sx = 0, sy = 0;
      for (const q of offs) if (Math.abs(q[0] - o[0]) <= tol && Math.abs(q[1] - o[1]) <= tol) { v++; sx += q[0]; sy += q[1]; }
      if (v > best.votes) best = { dx: sx / v, dy: sy / v, flip, votes: v };
    }
  }
  return best;
}

/**
 * Follow stars into a new frame. Each star is re-centred from its previous position; the median shift of the
 * stars that were found is then applied to any star that was lost or that moved differently from the others
 * (by more than `tol` px), so one star cannot wander off on its own.
 * @param prev  Float64Array [x0, y0, x1, y1, ...] positions in the previous frame
 * @param out   Float64Array of the same length for the new positions
 * @returns { lost: number of stars placed by the median shift, dx, dy: the median shift }
 */
export function trackStars(data, w, h, prev, out, opts = {}) {
  const { half = 7, tol = 3 } = opts, ns = prev.length >> 1;
  const dxs = [], dys = [], okv = new Uint8Array(ns);
  for (let s = 0; s < ns; s++) {
    const c = centroidIter(data, w, h, prev[2 * s], prev[2 * s + 1], half);
    out[2 * s] = c[0]; out[2 * s + 1] = c[1];
    if (c[2] > 0 && Number.isFinite(c[0])) { okv[s] = 1; dxs.push(c[0] - prev[2 * s]); dys.push(c[1] - prev[2 * s + 1]); }
  }
  const med = (v) => { if (!v.length) return 0; const q = v.slice().sort((a, b) => a - b), m = q.length; return m & 1 ? q[m >> 1] : 0.5 * (q[m / 2 - 1] + q[m / 2]); };
  const mdx = med(dxs), mdy = med(dys);
  let lost = 0;
  for (let s = 0; s < ns; s++) {
    const bad = !okv[s] || (ns > 2 && Math.hypot(out[2 * s] - prev[2 * s] - mdx, out[2 * s + 1] - prev[2 * s + 1] - mdy) > tol);
    if (bad) { out[2 * s] = prev[2 * s] + mdx; out[2 * s + 1] = prev[2 * s + 1] + mdy; lost++; }
  }
  return { lost, dx: mdx, dy: mdy };
}

// ---------------------------------------------------------------------------------------------------------
// Measuring a stack of frames on a grid of apertures and annuli

/** n values from a to b inclusive. */
export const linspace = (a, b, n) => Float64Array.from({ length: n }, (_, i) => (n === 1 ? a : a + (b - a) * i / (n - 1)));

/**
 * Storage for the photometry of nF frames, nS stars (star 0 is the target), on nA aperture radii and nN annulus
 * widths. The flux of star s in frame f for aperture a and annulus n is raw - area * bg (see fluxOf).
 * The sky annulus runs from r_aper + gap to r_aper + gap + width, as in EXOTIC (gap = 2 px there).
 */
export function makeMeasurements(nF, nS, apertures, annuli, gap = 2) {
  const nA = apertures.length, nN = annuli.length;
  return {
    nF, nS, nA, nN, apertures: Float64Array.from(apertures), annuli: Float64Array.from(annuli), gap, count: 0,
    time: new Float64Array(nF).fill(NaN), airmass: new Float64Array(nF).fill(NaN), exptime: new Float64Array(nF).fill(NaN),
    x: new Float64Array(nF * nS), y: new Float64Array(nF * nS), fwhm: new Float64Array(nF * nS), peak: new Float64Array(nF * nS),
    psfFlux: new Float64Array(nF * nS), psfBg: new Float64Array(nF * nS), lost: new Uint8Array(nF),
    // Gaussian fit shape (EXOTIC's psf_data columns), Moffat-fit flux, optimal-extraction flux, per frame and star
    psfAmp: new Float64Array(nF * nS).fill(NaN), psfSx: new Float64Array(nF * nS).fill(NaN), psfSy: new Float64Array(nF * nS).fill(NaN), psfTheta: new Float64Array(nF * nS),
    mofFlux: new Float64Array(nF * nS).fill(NaN), optFlux: new Float64Array(nF * nS).fill(NaN),
    // elliptical apertures of the same areas as the circles (only measured when measureFrame is given cfg.ellipse)
    rawE: null, areaE: null, ellipse: null,
    // field orientation relative to the first frame (rotation in degrees, 1 after a relocation by asterism matching)
    rot: new Float64Array(nF), relocated: new Uint8Array(nF),
    raw: new Float64Array(nF * nS * nA), area: new Float64Array(nF * nS * nA), bg: new Float64Array(nF * nS * nA * nN), bgStd: new Float64Array(nF * nS * nA * nN), clipped: new Uint8Array(nF * nS),
  };
}

/**
 * Measure every star of one frame at every aperture and annulus and store it as frame f.
 * @param pos  Float64Array [x0, y0, ...] the centroids to use (from trackStars)
 * @param cfg  { psf: 'gaussian' | 'moffat' | 'none', psfHalf, method: 'exact' | 'subpixel', sigma, maxiters }
 */
export function measureFrame(M, f, data, w, h, pos, cfg = {}) {
  const { psf = 'gaussian', psfHalf = 7, method = 'exact', sigma = 3, maxiters = 5, rotate = false, optimal = false, oversample = 1 } = cfg, { nS, nA, nN } = M;
  const doG = psf === 'gaussian' || psf === 'both', doM = psf === 'moffat' || psf === 'both';
  let shape = null, shapeAmp = -Infinity;
  if (cfg.ellipse && !M.rawE) { M.rawE = new Float64Array(M.nF * nS * nA).fill(NaN); M.areaE = new Float64Array(M.nF * nS * nA); M.ellipse = { q: cfg.ellipse.q, theta: cfg.ellipse.theta }; }
  for (let s = 0; s < nS; s++) {
    const x = pos[2 * s], y = pos[2 * s + 1], k = f * nS + s;
    M.x[k] = x; M.y[k] = y; M.psfFlux[k] = NaN; M.fwhm[k] = NaN; M.mofFlux[k] = NaN; M.optFlux[k] = NaN; M.psfBg[k] = NaN;
    if (doG) {
      const fit = fitPsf(data, w, h, x, y, psfHalf, { model: 'gaussian', sigma: cfg.sigma0, rotate, oversample });
      M.psfFlux[k] = fit.ok ? fit.flux : NaN; M.psfBg[k] = fit.bg; M.fwhm[k] = fit.ok ? fit.fwhm : NaN;
      M.psfAmp[k] = fit.amp; M.psfSx[k] = fit.sx; M.psfSy[k] = fit.sy; M.psfTheta[k] = fit.theta;
      if (fit.ok && fit.amp > shapeAmp && fit.sx < psfHalf && fit.sy < psfHalf) { shapeAmp = fit.amp; shape = fit; }
    }
    if (doM) {
      const fit = fitPsf(data, w, h, x, y, psfHalf, { model: 'moffat', sigma: cfg.sigma0, oversample });
      if (doG) M.mofFlux[k] = fit.ok ? fit.flux : NaN;
      else { M.psfFlux[k] = fit.ok ? fit.flux : NaN; M.psfBg[k] = fit.bg; M.fwhm[k] = fit.ok ? fit.fwhm : NaN; }      // psf: 'moffat' alone keeps the old meaning
    }
    let clipped = 0, peak = -Infinity;
    annulusPrepare(data, w, h, x, y, M.apertures[0] + M.gap, M.apertures[nA - 1] + M.gap + M.annuli[nN - 1]);
    for (let a = 0; a < nA; a++) {
      const r = M.apertures[a], res = apertureSum(data, w, h, x, y, r, method);
      M.raw[k * nA + a] = res[4] > 0 ? NaN : res[0]; M.area[k * nA + a] = res[1]; if (res[3]) clipped = 1; if (res[2] > peak) peak = res[2];
      if (M.rawE) { const q = M.ellipse.q, e = ellipseSum(data, w, h, x, y, r / Math.sqrt(q), r * Math.sqrt(q), M.ellipse.theta); M.rawE[k * nA + a] = e[4] > 0 ? NaN : e[0]; M.areaE[k * nA + a] = e[1]; }
      for (let n = 0; n < nN; n++) {
        const b = annulusFromSorted(r + M.gap, r + M.gap + M.annuli[n], sigma, maxiters);
        M.bg[(k * nA + a) * nN + n] = b[0]; M.bgStd[(k * nA + a) * nN + n] = b[2];
      }
    }
    M.clipped[k] = clipped; M.peak[k] = peak;
  }
  // optimal extraction: one profile (the brightest well-fitted star's) for every star of the frame, sky from the
  // widest annulus about the largest aperture
  if (optimal && shape) for (let s = 0; s < nS; s++) {
    const k = f * nS + s, bg = M.bg[(k * nA + nA - 1) * nN + nN - 1];
    M.optFlux[k] = M.clipped[k] ? NaN : optimalFlux(data, w, h, pos[2 * s], pos[2 * s + 1], shape.sx, shape.sy, shape.theta, bg, Math.min(1.4 * psfHalf, 2 * shape.fwhm), oversample);
  }
  if (f + 1 > M.count) M.count = f + 1;
}

/** Background-subtracted flux of star s for aperture index a and annulus index n, all frames, into `out`. */
export function fluxOf(M, s, a, n, out = new Float64Array(M.count)) {
  const { nS, nA, nN } = M;
  for (let f = 0; f < M.count; f++) { const k = f * nS + s; out[f] = M.clipped[k] ? NaN : M.raw[k * nA + a] - M.area[k * nA + a] * M.bg[(k * nA + a) * nN + n]; }
  return out;
}

/** The names of the ways a flux can be measured, in the order they are tried. */
export const METHODS = ['psf', 'moffat', 'optimal', 'aperture', 'ellipse'];
export const METHOD_LABEL = { psf: 'PSF fit (Gaussian)', moffat: 'PSF fit (Moffat)', optimal: 'optimal extraction', aperture: 'aperture', ellipse: 'elliptical aperture' };

/** Flux of star s by any method ('psf', 'moffat', 'optimal', 'aperture', 'ellipse'; a, n only matter for the last two), all frames, into `out`. */
export function seriesOf(M, kind, s, a, n, out = new Float64Array(M.count)) {
  const { nS, nA, nN } = M;
  if (kind === 'aperture') return fluxOf(M, s, a, n, out);
  if (kind === 'ellipse') { for (let f = 0; f < M.count; f++) { const k = f * nS + s; out[f] = M.clipped[k] || !M.rawE ? NaN : M.rawE[k * nA + a] - M.areaE[k * nA + a] * M.bg[(k * nA + a) * nN + n]; } return out; }
  const src = kind === 'psf' ? M.psfFlux : kind === 'moffat' ? M.mofFlux : M.optFlux;
  for (let f = 0; f < M.count; f++) out[f] = src[f * nS + s];
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Elliptical apertures and optimal extraction

// Signed area of the triangle (origin, p1, p2) inside the circle of radius r about the origin.
function triCircle(x1, y1, x2, y2, r) {
  const r2 = r * r, dx = x2 - x1, dy = y2 - y1, a = dx * dx + dy * dy;
  if (a === 0) return 0;
  const sector = (ax, ay, bx, by) => 0.5 * r2 * Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  const b = 2 * (x1 * dx + y1 * dy), c = x1 * x1 + y1 * y1 - r2, disc = b * b - 4 * a * c;
  if (disc <= 0) return sector(x1, y1, x2, y2);
  const sq = Math.sqrt(disc), t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  if (t1 >= 1 || t2 <= 0) return sector(x1, y1, x2, y2);
  if (t1 <= 0 && t2 >= 1) return 0.5 * (x1 * y2 - x2 * y1);
  if (t1 <= 0) { const qx = x1 + t2 * dx, qy = y1 + t2 * dy; return 0.5 * (x1 * qy - qx * y1) + sector(qx, qy, x2, y2); }
  if (t2 >= 1) { const qx = x1 + t1 * dx, qy = y1 + t1 * dy; return sector(x1, y1, qx, qy) + 0.5 * (qx * y2 - x2 * qy); }
  const ax = x1 + t1 * dx, ay = y1 + t1 * dy, bx = x1 + t2 * dx, by = y1 + t2 * dy;
  return sector(x1, y1, ax, ay) + 0.5 * (ax * by - bx * ay) + sector(bx, by, x2, y2);
}

/**
 * Exact area of the unit pixel centred at (dx, dy) inside the ellipse of semi-axes a, b centred on the origin with
 * the a axis at angle theta from +x (counter-clockwise): the pixel is mapped to a parallelogram in the frame where
 * the ellipse is the unit circle, and the polygon-circle intersection is summed edge by edge.
 */
export function ellipsePixelOverlap(dx, dy, a, b, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const u = (x, y) => (x * c + y * s) / a, v = (x, y) => (-x * s + y * c) / b;
  const X = [dx - 0.5, dx + 0.5, dx + 0.5, dx - 0.5], Y = [dy - 0.5, dy - 0.5, dy + 0.5, dy + 0.5];
  let area = 0;
  for (let i = 0; i < 4; i++) { const j = (i + 1) & 3; area += triCircle(u(X[i], Y[i]), v(X[i], Y[i]), u(X[j], Y[j]), v(X[j], Y[j]), 1); }
  return Math.abs(area) * a * b;
}

/**
 * Sum of the image inside an elliptical aperture (semi-axes a >= or < b, a axis at angle theta from +x), every pixel
 * weighted by its exact overlap (photutils EllipticalAperture, method='exact').
 * @returns the shared Float64Array [sum, area, max pixel value, clipped (0/1), number of NaN pixels]
 */
export function ellipseSum(data, w, h, xc, yc, a, b, theta = 0) {
  const R = Math.max(a, b), rm = Math.min(a, b), c = Math.cos(theta), s = Math.sin(theta);
  const x0 = Math.floor(xc - R + 0.5), x1 = Math.ceil(xc + R - 0.5), y0 = Math.floor(yc - R + 0.5), y1 = Math.ceil(yc + R - 0.5);
  const clipped = x0 < 0 || y0 < 0 || x1 >= w || y1 >= h, mar = 0.7072 / rm;
  let sum = 0, area = 0, peak = -Infinity, nan = 0;
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    const dy = y - yc, row = y * w;
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      const dx = x - xc, uu = (dx * c + dy * s) / a, vv = (-dx * s + dy * c) / b, d = Math.sqrt(uu * uu + vv * vv);
      if (d >= 1 + mar) continue;
      const f = d <= 1 - mar ? 1 : ellipsePixelOverlap(dx, dy, a, b, theta);
      if (f <= 0) continue;
      const val = data[row + x];
      if (val !== val) { nan++; continue; }
      sum += f * val; area += f; if (val > peak) peak = val;
    }
  }
  RES[0] = sum; RES[1] = area; RES[2] = peak; RES[3] = clipped ? 1 : 0; RES[4] = nan;
  return RES;
}

/**
 * Optimal (variance-weighted) extraction in the sky-limited form of Naylor (1998, MNRAS 296, 339): with a profile
 * P normalised to unit sum and a uniform variance, the minimum-variance flux is sum(P (d - bg)) / sum(P^2) over
 * the pixels within `rclip` of the star. P is a Gaussian (sx, sy, theta) about (x, y), sampled at pixel centres or
 * (os > 1) averaged over os x os points in each pixel.
 * Used with the same profile for every star of a frame, the estimate is a fixed fraction of each star's flux even
 * when the profile is not exactly the PSF, so ratios between stars are unbiased.
 */
export function optimalFlux(data, w, h, x, y, sx, sy, theta, bg, rclip, os = 1) {
  const c = Math.cos(theta), s = Math.sin(theta), norm = 1 / (2 * Math.PI * sx * sy), r2 = rclip * rclip;
  const xa = Math.max(0, Math.ceil(x - rclip)), xb = Math.min(w - 1, Math.floor(x + rclip)), ya = Math.max(0, Math.ceil(y - rclip)), yb = Math.min(h - 1, Math.floor(y + rclip));
  let num = 0, den = 0;
  for (let yy = ya; yy <= yb; yy++) {
    const dy = yy - y, row = yy * w;
    for (let xx = xa; xx <= xb; xx++) {
      const dx = xx - x; if (dx * dx + dy * dy > r2) continue;
      const v = data[row + xx]; if (v !== v) continue;
      let P = 0;
      for (let j = 0; j < os; j++) for (let i = 0; i < os; i++) { const ex = dx + (os > 1 ? (i + 0.5) / os - 0.5 : 0), ey = dy + (os > 1 ? (j + 0.5) / os - 0.5 : 0), rx = ex * c - ey * s, ry = ex * s + ey * c; P += Math.exp(-0.5 * (rx * rx / (sx * sx) + ry * ry / (sy * sy))); }
      P *= norm / (os * os);
      num += P * (v - bg); den += P * P;
    }
  }
  return den > 0 ? num / den : NaN;
}

// ---------------------------------------------------------------------------------------------------------
// Quick light-curve fit and the search over apertures

const median = (v) => { const a = Float64Array.from(v).filter((x) => x === x).sort(); const m = a.length; return m ? (m & 1 ? a[m >> 1] : 0.5 * (a[m / 2 - 1] + a[m / 2])) : NaN; };
export { median as medianOf };

/** Trapezoid transit shape in [0, 1]: 1 inside the flat bottom, linear ingress/egress of fraction `ing` of the duration each. */
export function trapezoid(t, tmid, dur, ing = 0.15) {
  const x = Math.abs(t - tmid) / dur;
  if (x >= 0.5) return 0;
  const flat = 0.5 - ing;
  return x <= flat ? 1 : (0.5 - x) / ing;
}

// least squares for a few basis functions by normal equations; returns chi2 and writes coefficients to c
function lsq(B, nb, y, keep, n, c) {
  const A = new Float64Array(nb * nb), b = new Float64Array(nb);
  for (let i = 0; i < n; i++) { if (!keep[i]) continue; for (let p = 0; p < nb; p++) { const bp = B[p][i]; b[p] += bp * y[i]; for (let q = 0; q <= p; q++) A[p * nb + q] += bp * B[q][i]; } }
  for (let p = 0; p < nb; p++) A[p * nb + p] *= 1 + 1e-12;
  if (!solveSym(A, b, nb, c)) return Infinity;
  let chi = 0;
  for (let i = 0; i < n; i++) { if (!keep[i]) continue; let m = 0; for (let p = 0; p < nb; p++) m += c[p] * B[p][i]; chi += (y[i] - m) * (y[i] - m); }
  return chi;
}

/**
 * Quick model of a light curve, for ranking candidates and for residuals, with no knowledge of the planet:
 *   flux = c0 + c1 * (airmass - mean)  [or c1 * time when airmass is missing or constant]  (+ c2 * time^2 when order = 2)
 *          - depth * trapezoid(t; tmid, duration)
 * linear least squares for the coefficients at each (tmid, duration) of a grid, keeping the best. The transit
 * term is kept only if it lowers the BIC by more than 10 and the depth is positive; otherwise the result is the
 * baseline alone. Points more than `clip` robust sigma from the model are dropped once and the fit repeated.
 * (EXOTIC fits its full transit model times a1 * exp(a2 * airmass) here, which needs the planet's parameters.)
 * @param opts { airmass, order = 1, transit = true, tmid: [lo, hi] or null, durations: [d] or null, clip = 4, ntmid = 40 (steps across a given tmid range), refine = true }
 * @returns { model, baseline, resid, keep (Uint8Array), scatter (std of residuals / median flux, EXOTIC's measure),
 *            robust (1.4826 MAD / median), depth (fractional), tmid, duration, hasTransit, coef, n }
 */
export function quickFit(t, f, opts = {}) {
  const { airmass = null, order = 1, transit = true, clip = 4, ntmid = 40 } = opts, n = t.length;
  const keep = new Uint8Array(n); let nk = 0, t0 = Infinity, t1 = -Infinity, am = 0, amN = 0, amLo = Infinity, amHi = -Infinity;
  for (let i = 0; i < n; i++) if (Number.isFinite(t[i]) && Number.isFinite(f[i]) && f[i] > 0) { keep[i] = 1; nk++; if (t[i] < t0) t0 = t[i]; if (t[i] > t1) t1 = t[i]; }
  const empty = { model: new Float64Array(n).fill(NaN), baseline: new Float64Array(n).fill(NaN), resid: new Float64Array(n).fill(NaN), keep, scatter: Infinity, robust: Infinity, depth: 0, tmid: NaN, duration: NaN, hasTransit: false, coef: [], n: nk };
  if (nk < 8) return empty;
  const span = t1 - t0 || 1, tc = 0.5 * (t0 + t1);
  let useAm = false;
  if (airmass) { for (let i = 0; i < n; i++) if (keep[i] && Number.isFinite(airmass[i])) { am += airmass[i]; amN++; if (airmass[i] < amLo) amLo = airmass[i]; if (airmass[i] > amHi) amHi = airmass[i]; } useAm = amN === nk && amHi - amLo > 1e-3; am /= amN || 1; }
  const one = new Float64Array(n).fill(1), lin = new Float64Array(n), quad = new Float64Array(n), shape = new Float64Array(n);
  for (let i = 0; i < n; i++) { const tau = (t[i] - tc) / span; lin[i] = useAm ? airmass[i] - am : tau; quad[i] = tau * tau; }
  const base = order >= 2 ? [one, lin, quad] : order >= 1 ? [one, lin] : [one], nb = base.length;
  const c = new Float64Array(nb + 1), cb = new Float64Array(nb + 1);
  const durs = opts.durations || [0.02, 0.04, 0.06, 0.08, 0.1, 0.125, 0.16, 0.2].filter((d) => d < 0.8 * span);
  const tlo = opts.tmid ? opts.tmid[0] : t0, thi = opts.tmid ? opts.tmid[1] : t1;
  let out = null;
  for (let pass = 0; pass < 2; pass++) {
    const chi0 = lsq(base, nb, f, keep, n, c);
    let best = { chi: chi0, coef: Array.from(c.subarray(0, nb)), tmid: NaN, dur: NaN, has: false };
    if (transit && durs.length && nk > nb + 4) {
      let bt = null;
      const tryAt = (tm, dur) => {
        let inT = 0; for (let i = 0; i < n; i++) { shape[i] = -trapezoid(t[i], tm, dur); if (keep[i] && shape[i] < -0.5) inT++; }
        if (inT < 3 || inT > nk - 4) return;
        const chi = lsq([...base, shape], nb + 1, f, keep, n, cb);
        if (cb[nb] > 0 && (!bt || chi < bt.chi)) bt = { chi, coef: Array.from(cb), tmid: tm, dur, has: true };
      };
      // coarse grid: mid-times a third of a duration apart (or ntmid steps when a range is given), then two rounds of refinement
      for (const dur of durs) { const nt = opts.tmid ? ntmid : Math.max(8, Math.min(400, Math.ceil(3 * (thi - tlo) / dur))); for (let j = 0; j < nt; j++) tryAt(tlo + (thi - tlo) * (j + 0.5) / nt, dur); }
      if (bt && opts.refine !== false) for (let round = 0, st = bt.dur / 3, fd = 0.15; round < 2; round++, st /= 4, fd /= 3) {
        const c0 = bt.tmid, d0 = bt.dur;
        for (const dm of [1 - fd, 1, 1 + fd]) for (let j = -4; j <= 4; j++) tryAt(c0 + st * j / 4, d0 * dm);
      }
      // BIC: one extra linear parameter and two grid parameters
      if (bt && nk * Math.log(bt.chi / chi0) + 3 * Math.log(nk) < -10) best = bt;
    }
    const model = new Float64Array(n), baseline = new Float64Array(n), resid = new Float64Array(n);
    for (let i = 0; i < n; i++) { let b = 0; for (let p = 0; p < nb; p++) b += best.coef[p] * base[p][i]; baseline[i] = b; model[i] = b - (best.has ? best.coef[nb] * trapezoid(t[i], best.tmid, best.dur) : 0); resid[i] = f[i] - model[i]; }
    const kept = []; for (let i = 0; i < n; i++) if (keep[i]) kept.push(resid[i]);
    const rm = median(kept), mad = 1.4826 * median(kept.map((r) => Math.abs(r - rm)));
    let mean = 0; for (const r of kept) mean += r; mean /= kept.length; let q = 0; for (const r of kept) q += (r - mean) * (r - mean);
    const fm = median(Array.from(f).filter((_, i) => keep[i]));
    out = { model, baseline, resid, keep, scatter: Math.sqrt(q / kept.length) / fm, robust: mad / fm, depth: best.has ? best.coef[nb] / median(Array.from(baseline).filter((_, i) => keep[i])) : 0, tmid: best.tmid, duration: best.dur, hasTransit: best.has, coef: best.coef, n: kept.length, usedAirmass: useAm };
    if (pass === 1 || !(clip > 0) || !(mad > 0)) break;
    let dropped = 0; for (let i = 0; i < n; i++) if (keep[i] && Math.abs(resid[i] - rm) > clip * mad) { keep[i] = 0; dropped++; nk--; }
    if (!dropped) break;
  }
  return out;
}

/**
 * EXOTIC-style optimisation over the measurements of a stack: for every aperture radius, every annulus width and
 * every choice of comparison (none, each comparison star alone, all comparison stars summed when there are
 * several), and for PSF-fit fluxes with each comparison, form target / comparison, fit quickFit, and rank by the
 * residual scatter std(residual) / median(flux). Returns the table of everything tried and the best light curve.
 * @param opts { fit: options for quickFit (airmass is taken from M), comps: 'all' (default) | 'single' | 'none' ,
 *               ensemble = true, psf = true, metric: 'scatter' | 'robust' }
 * @returns { tried: [{ method, aperture, annulus, comp, scatter, robust, n, depth }], best: index into tried,
 *            lc: { time, flux, err, norm, normErr, model, baseline, resid, keep, target, comparison, fit } }
 */
export function optimise(M, opts = {}) {
  const { ensemble = true, psf = true, metric = 'scatter', methods = METHODS } = opts, nF = M.count, nC = M.nS - 1;
  // the airmass goes to the fits unless the detrending asked for is a polynomial in time (opts.fit.detrend 'linear' / 'quadratic')
  const poly = opts.fit && (opts.fit.detrend === 'linear' || opts.fit.detrend === 'quadratic');
  const time = M.time.subarray(0, nF), amOK = !poly && M.airmass.subarray(0, nF).every(Number.isFinite), fitOpts = { ...(opts.fit || {}), airmass: amOK ? M.airmass.subarray(0, nF) : null };
  const fitter = opts.fitter || null, onRow = opts.onRow || null;
  const T = new Float64Array(nF), C = new Float64Array(nF), R = new Float64Array(nF), tmp = new Float64Array(nF);
  // -1 none, j star j, 0 all summed, 'w' the inverse-variance weighted ensemble (detrend.js ensembleWeights)
  const comps = [-1]; for (let j = 1; j <= nC; j++) comps.push(j); if (ensemble && nC > 1) comps.push(0); if (ensemble && nC > 1 && opts.weighted !== false) comps.push('w');
  const tried = []; let best = -1, bestVal = Infinity;
  const fill = (kind, a, n, comp) => {       // target flux in T, comparison in C, ratio in R
    seriesOf(M, kind, 0, a, n, T);
    if (comp === 'w') { const W = weightedComparison(M, kind, a, n, T); C.set(W.comparison); W.weights.forEach((w, j) => { wts[j] = w; }); }
    else if (comp < 0) C.fill(1); else if (comp > 0) seriesOf(M, kind, comp, a, n, C); else { C.fill(0); for (let j = 1; j <= nC; j++) { seriesOf(M, kind, j, a, n, tmp); for (let f = 0; f < nF; f++) C[f] += tmp[f]; } }
    for (let f = 0; f < nF; f++) R[f] = T[f] / C[f];
  };
  const wts = new Array(nC).fill(0);
  const tryOne = (kind, a, n, comp) => {
    fill(kind, a, n, comp);
    const fit = fitter ? fitter(time, R, { airmass: fitOpts.airmass, target: T, comp: C, noComp: comp < 0 }) : quickFit(time, R, fitOpts), val = metric === 'robust' ? fit.robust : fit.scatter, ap = kind === 'aperture' || kind === 'ellipse';
    const row = { method: kind, aperture: ap ? M.apertures[a] : 0, annulus: ap ? M.annuli[n] : 0, ia: a, in: n, comp, scatter: fit.scatter, robust: fit.robust, n: fit.n, depth: fit.depth };
    if (comp === 'w') row.weights = wts.slice();
    if (fit.params) row.params = fit.params;
    tried.push(row);
    if (Number.isFinite(val) && fit.n >= 0.5 * nF && val < bestVal) { bestVal = val; best = tried.length - 1; }
    if (onRow) onRow(row, tried.length - 1, best);
  };
  // Where the transit is (if any) is found once, on a middle aperture with the widest choice of comparison, by the
  // full grid; every candidate is then fitted with the mid-time and duration free only near that solution.
  if (!fitter && !fitOpts.tmid && fitOpts.transit !== false) {
    fill('aperture', M.nA >> 1, M.nN >> 1, comps[comps.length - 1]);
    const f0 = quickFit(time, R, fitOpts);
    if (f0.hasTransit) { fitOpts.tmid = [f0.tmid - f0.duration / 4, f0.tmid + f0.duration / 4]; fitOpts.durations = [0.85, 1, 1.15].map((k) => k * f0.duration); fitOpts.ntmid = 9; }
    else fitOpts.transit = false;
  }
  const has = (a) => a && a.subarray(0, nF * M.nS).some(Number.isFinite);
  if (psf) {
    if (methods.includes('psf') && has(M.psfFlux)) for (const c of comps) tryOne('psf', 0, 0, c);
    if (methods.includes('moffat') && has(M.mofFlux)) for (const c of comps) tryOne('moffat', 0, 0, c);
    if (methods.includes('optimal') && has(M.optFlux)) for (const c of comps) tryOne('optimal', 0, 0, c);
  }
  if (methods.includes('aperture')) for (let a = 0; a < M.nA; a++) for (let n = 0; n < M.nN; n++) for (const c of comps) tryOne('aperture', a, n, c);
  if (methods.includes('ellipse') && M.rawE) for (let a = 0; a < M.nA; a++) for (let n = 0; n < M.nN; n++) for (const c of comps) tryOne('ellipse', a, n, c);
  if (best < 0) return { tried, best, lc: null, fitOpts };
  return { tried, best, lc: lightCurveFor(M, tried[best], fitOpts, fitter), fitOpts };
}

/**
 * The comparison stars of a stack combined with inverse-variance weights (ensembleWeights in detrend.js: each star's
 * white noise from the pairwise flux ratios, the target included as one of the series). Frames where any star has no
 * flux are left out of the noise estimate. @returns { comparison (median 1), weights, sigma, medians, series }
 */
export function weightedComparison(M, kind, a, n, target) {
  const nC = M.nS - 1, series = []; for (let j = 1; j <= nC; j++) series.push(seriesOf(M, kind, j, a, n));
  const keep = Uint8Array.from({ length: M.count }, (_, f) => (Number.isFinite(target[f]) && target[f] > 0 && series.every((s) => Number.isFinite(s[f]) && s[f] > 0) ? 1 : 0));
  const W = ensembleWeights(series, target, { keep });
  return { ...W, medians: series.map((s) => median(Array.from(s).filter((v, f) => keep[f]))), series };
}

/** Number of pixels a method effectively sums (for noise estimates): the aperture area, or 4 pi sx sy for a Gaussian profile. */
function effectivePixels(M, row, f, s) {
  const k = f * M.nS + s;
  if (row.method === 'aperture') return M.area[k * M.nA + row.ia];
  if (row.method === 'ellipse') return M.areaE[k * M.nA + row.ia];
  const sx = M.psfSx[k], sy = M.psfSy[k];
  return Number.isFinite(sx * sy) ? 4 * Math.PI * sx * sy : 4 * Math.PI * 4;
}

/**
 * The light curve of one row of the tried table (or any { method, ia, in, comp }).
 * `photErr` is the relative noise expected for each point from the CCD equation with the sky variance measured in
 * the annulus (which already holds the sky's photon noise, the read noise and the dark current):
 *   var(star) = flux / gain + npix * sigma_sky^2 * (1 + npix / nsky)      [ADU^2; gain in e-/ADU, opts.gain, default 1]
 * for the target and the comparison, added in quadrature. `photErrStar` is the same without the sky terms.
 */
export function lightCurveFor(M, row, fitOpts = {}, fitter = null) {
  const nF = M.count, nC = M.nS - 1, T = new Float64Array(nF), C = new Float64Array(nF), R = new Float64Array(nF), tmp = new Float64Array(nF);
  const ap = row.method === 'aperture' || row.method === 'ellipse', ia = ap ? row.ia : M.nA - 1, inn = ap ? row.in : M.nN - 1;
  seriesOf(M, row.method, 0, row.ia, row.in, T);
  const W = row.comp === 'w' ? weightedComparison(M, row.method, row.ia, row.in, T) : null;
  if (W) C.set(W.comparison); else if (row.comp < 0) C.fill(1); else if (row.comp > 0) seriesOf(M, row.method, row.comp, row.ia, row.in, C); else { for (let j = 1; j <= nC; j++) { seriesOf(M, row.method, j, row.ia, row.in, tmp); for (let f = 0; f < nF; f++) C[f] += tmp[f]; } }
  for (let f = 0; f < nF; f++) R[f] = T[f] / C[f];
  const time = M.time.slice(0, nF), fit = fitter ? fitter(time, R, { airmass: fitOpts.airmass, target: T, comp: C, noComp: row.comp < 0, full: true }) : quickFit(time, R, fitOpts);
  // normalised by the baseline's median; the uncertainty is the robust scatter of the residuals (EXOTIC also
  // replaces photon-noise errors by the out-of-transit scatter)
  const b0 = median(Array.from(fit.baseline).filter((_, i) => fit.keep[i])), norm = new Float64Array(nF), normErr = new Float64Array(nF).fill(fit.robust > 0 ? fit.robust : fit.scatter);
  for (let f = 0; f < nF; f++) norm[f] = R[f] / b0;
  const bg = new Float64Array(nF), photErr = new Float64Array(nF), photErrStar = new Float64Array(nF), gain = fitOpts.gain > 0 ? fitOpts.gain : 1;
  const rA = M.apertures[ia] + M.gap, nsky = Math.PI * ((rA + M.annuli[inn]) ** 2 - rA * rA);
  for (let f = 0; f < nF; f++) {
    bg[f] = row.method === 'psf' ? M.psfBg[f * M.nS] : M.bg[((f * M.nS) * M.nA + ia) * M.nN + inn];
    let vT = 0, vT0 = 0, vC = 0, vC0 = 0;
    const one = (s, flux) => { const np = effectivePixels(M, row, f, s), sd = M.bgStd[((f * M.nS + s) * M.nA + ia) * M.nN + inn]; return [flux / gain, np * sd * sd * (1 + np / nsky)]; };
    { const [p, q] = one(0, T[f]); vT0 = p; vT = p + q; }
    if (W) for (let j = 1; j <= nC; j++) { const Fj = W.series[j - 1][f], [p, q] = one(j, Fj), sc = (W.weights[j - 1] / W.medians[j - 1]) ** 2; vC0 += sc * p; vC += sc * (p + q); }   // var(sum w_j F_j / med_j)
    else if (row.comp > 0) { const [p, q] = one(row.comp, C[f]); vC0 = p; vC = p + q; } else if (row.comp === 0) for (let j = 1; j <= nC; j++) { const [p, q] = one(j, seriesOf(M, row.method, j, row.ia, row.in, tmp)[f]); vC0 += p; vC += p + q; }
    const cc = row.comp < 0 ? 0 : 1 / (C[f] * C[f]);
    photErr[f] = Math.sqrt(Math.max(0, vT) / (T[f] * T[f]) + Math.max(0, vC) * cc); photErrStar[f] = Math.sqrt(Math.max(0, vT0) / (T[f] * T[f]) + Math.max(0, vC0) * cc);
  }
  const pick = (a, s = 0) => Float64Array.from({ length: nF }, (_, f) => a[f * M.nS + s]);
  return { time, flux: R, norm, normErr, photErr, photErrStar, weights: W ? W.weights : null, compSeries: W ? W.series : null, model: fit.model.map((v) => v / b0), baseline: fit.baseline.map((v) => v / b0), resid: fit.resid.map((v) => v / b0), keep: fit.keep, target: T, comparison: C, fit, background: bg,
    airmass: M.airmass.slice(0, nF), exptime: M.exptime.slice(0, nF), x: pick(M.x), y: pick(M.y), fwhm: pick(M.fwhm), rot: M.rot.slice(0, nF) };
}

// ---------------------------------------------------------------------------------------------------------
// Target pixel files (TESS, Kepler, K2, TESScut)

/** Grow a mask by one pixel in the 4-connected sense (scipy.ndimage.binary_dilation's default), `iters` times. */
export function dilateMask(mask, nx, ny, iters = 1) {
  let m = Uint8Array.from(mask);
  for (let it = 0; it < iters; it++) {
    const o = Uint8Array.from(m);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (m[y * nx + x]) { if (x > 0) o[y * nx + x - 1] = 1; if (x < nx - 1) o[y * nx + x + 1] = 1; if (y > 0) o[(y - 1) * nx + x] = 1; if (y < ny - 1) o[(y + 1) * nx + x] = 1; }
    m = o;
  }
  return m;
}

/** The pipeline's optimal aperture from the APERTURE image (bit 2 = "used in the optimal aperture"), or null. */
export function pipelineMask(tpf) {
  if (!tpf.aperture) return null;
  const m = new Uint8Array(tpf.nx * tpf.ny); let any = 0;
  for (let i = 0; i < m.length; i++) if (tpf.aperture[i] & 2) { m[i] = 1; any++; }
  return any ? m : null;
}

/**
 * Median image over cadences (every `step`-th cadence whose QUALITY has none of the bits of `qmask` set; default any
 * flag), for display and for threshold masks. NaN pixels are ignored and an even count takes the mean of the two middle
 * values (numpy nanmedian, as lightkurve's median image when step = 1 and qmask is its quality bitmask).
 */
export function tpfMedianImage(tpf, step = 0, qmask = 0x7fffffff) {
  const { nx, ny, ncad } = tpf, np = nx * ny, st = step || Math.max(1, Math.floor(ncad / 200)), out = new Float32Array(np), buf = new Float64Array(Math.ceil(ncad / st));
  for (let p = 0; p < np; p++) { let m = 0; for (let c = 0; c < ncad; c += st) { const v = tpf.flux[c * np + p]; if (v === v && !(tpf.quality[c] & qmask)) buf[m++] = v; } if (!m) { out[p] = NaN; continue; } const a = buf.subarray(0, m); a.sort(); out[p] = m & 1 ? a[m >> 1] : 0.5 * (a[m / 2 - 1] + a[m / 2]); }
  return out;
}

/**
 * Pixels brighter than median + nsigma × 1.4826 MAD of the median image, connected (4-neighbours) to the target
 * (lightkurve's 'threshold' mask). Default: the region starts from the above-threshold pixel nearest (x0, y0) if it is
 * within 2.5 px (else the mask is empty). opts.lightkurve: exactly create_threshold_mask(nsigma, reference_pixel), i.e.
 * pixels >= the cut (NaN as 0), the region whose pixel is nearest (x0, y0) however far, with x0, y0 = nx/2, ny/2 for
 * its 'center'.
 */
export function thresholdMask(img, nx, ny, nsigma, x0, y0, opts = {}) {
  const fin = Float64Array.from(img).filter((v) => v === v).sort(), mid = (a) => (a.length & 1 ? a[a.length >> 1] : 0.5 * (a[a.length / 2 - 1] + a[a.length / 2]));
  const med = opts.lightkurve ? mid(fin) : fin[fin.length >> 1], dev = fin.map((v) => Math.abs(v - med)).sort(), mad = 1.4826 * (opts.lightkurve ? mid(dev) : median(dev)), cut = med + nsigma * mad;
  const above = new Uint8Array(nx * ny); for (let i = 0; i < above.length; i++) above[i] = opts.lightkurve ? ((img[i] === img[i] ? img[i] : 0) >= cut ? 1 : 0) : img[i] > cut ? 1 : 0;
  // start from the above-threshold pixel nearest the requested position, then flood fill
  let start = -1, bd = Infinity; for (let i = 0; i < above.length; i++) if (above[i]) { const d = Math.hypot((i % nx) - x0, Math.floor(i / nx) - y0); if (d < bd) { bd = d; start = i; } }
  const m = new Uint8Array(nx * ny); if (start < 0 || (!opts.lightkurve && bd > 2.5)) return m;
  const stack = [start]; m[start] = 1;
  while (stack.length) { const i = stack.pop(), x = i % nx, y = (i - x) / nx; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue; const j = yy * nx + xx; if (above[j] && !m[j]) { m[j] = 1; stack.push(j); } } }
  return m;
}

/** Pixels whose centres lie within r of (x0, y0). */
export function circleMask(nx, ny, x0, y0, r) { const m = new Uint8Array(nx * ny); for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if ((x - x0) * (x - x0) + (y - y0) * (y - y0) <= r * r) m[y * nx + x] = 1; return m; }

/**
 * Simple aperture photometry of a target pixel file with a pixel mask: per cadence the sum of FLUX over the mask,
 * its uncertainty (FLUX_ERR in quadrature), the flux-weighted centroid over the mask (lightkurve's
 * estimate_centroids), and the background per pixel. Cadences with a non-zero QUALITY flag, a NaN time or a NaN
 * pixel in the mask have ok = 0.
 * When the file's fluxes are not background-subtracted (TESScut cutouts), the background per cadence is the
 * sigma-clipped median of the pixels outside the mask grown by two pixels, and it is subtracted.
 * Also the noise-pixel parameter β = (Σf)² / Σf² over the mask (the PSF-width proxy the owner's TOI extraction records).
 * @param opts { quality: bitmask of flags to reject (default all; the page uses lightkurve's 'default'), subtract: 'auto' | true | false }
 * @returns { time (BJD_TDB), flux, err, bkg (per pixel), x, y (pixel coordinates in the cutout), beta, ok, npix }
 */
export function tpfLightCurve(tpf, mask, opts = {}) {
  const { nx, ny, ncad } = tpf, np = nx * ny, qmask = opts.quality ?? 0x7fffffff;
  const sub = opts.subtract === 'auto' || opts.subtract == null ? !tpf.bkgSubtracted : !!opts.subtract;
  const idx = []; for (let i = 0; i < np; i++) if (mask[i]) idx.push(i);
  const sky = []; if (sub) { const grown = dilateMask(mask, nx, ny, 2); for (let i = 0; i < np; i++) if (!grown[i]) sky.push(i); }
  const time = new Float64Array(ncad), flux = new Float64Array(ncad), err = new Float64Array(ncad), bkg = new Float64Array(ncad), xs = new Float64Array(ncad), ys = new Float64Array(ncad), beta = new Float64Array(ncad), ok = new Uint8Array(ncad);
  const buf = scratch(np);
  for (let c = 0; c < ncad; c++) {
    const o = c * np; let s = 0, e2 = 0, sx = 0, sy = 0, s2 = 0, bad = false, b = 0;
    if (sub) { let m = 0; for (const i of sky) { const v = tpf.flux[o + i]; if (v === v) buf[m++] = v; } b = m ? sigmaClippedStats(buf, m, 3, 5)[0] : NaN; }
    else if (tpf.fluxBkg) { let bs = 0; for (const i of idx) bs += tpf.fluxBkg[o + i]; b = bs / idx.length; }
    for (const i of idx) {
      const v = tpf.flux[o + i] - (sub ? b : 0);
      if (v !== v) { bad = true; break; }
      s += v; s2 += v * v; sx += v * (i % nx); sy += v * ((i / nx) | 0);
      if (tpf.fluxErr) { const e = tpf.fluxErr[o + i]; e2 += e * e; }
    }
    time[c] = tpf.time[c] + tpf.bjdRef; flux[c] = bad ? NaN : s; err[c] = bad ? NaN : Math.sqrt(e2); bkg[c] = b; xs[c] = bad ? NaN : sx / s; ys[c] = bad ? NaN : sy / s; beta[c] = bad || !s2 ? NaN : s * s / s2;
    ok[c] = !bad && Number.isFinite(tpf.time[c]) && !(tpf.quality[c] & qmask) && idx.length > 0 ? 1 : 0;
  }
  return { time, flux, err, bkg, x: xs, y: ys, beta, ok, npix: idx.length };
}

/**
 * Savitzky-Golay smoothing (local polynomial of order 2 in a window of `win` points, odd), with the ends taken
 * from the polynomial fitted to the first / last window: scipy.signal.savgol_filter(y, win, 2, mode='interp').
 */
export function savgol2(y, win) {
  const n = y.length, out = new Float64Array(n), hw = win >> 1;
  if (n < win || win < 3) { out.set(y); return out; }
  // centre weights for a quadratic: w_k = (3 (3 m^2 + 3 m - 1) - 15 k^2) / ((2m - 1)(2m + 1)(2m + 3)), m = hw
  const m = hw, den = (2 * m - 1) * (2 * m + 1) * (2 * m + 3), wts = new Float64Array(win);
  for (let k = -m; k <= m; k++) wts[k + m] = (3 * (3 * m * m + 3 * m - 1) - 15 * k * k) / den;
  for (let i = hw; i < n - hw; i++) { let s = 0; for (let k = 0; k < win; k++) s += wts[k] * y[i - hw + k]; out[i] = s; }
  const edge = (start, i0, i1) => {            // quadratic through y[start .. start+win), evaluated at i0..i1
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let k = 0; k < win; k++) { const x = k - hw, v = y[start + k], x2 = x * x; s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; b0 += v; b1 += v * x; b2 += v * x2; }
    const A = Float64Array.from([s0, 0, 0, s1, s2, 0, s2, s3, s4]), c = new Float64Array(3);
    solveSym(A, Float64Array.from([b0, b1, b2]), 3, c);
    for (let i = i0; i < i1; i++) { const x = i - start - hw; out[i] = c[0] + c[1] * x + c[2] * x * x; }
  };
  edge(0, 0, hw); edge(n - win, n - hw, n);
  return out;
}

/** Running median of y over a window of `win` points (odd; shorter at the ends). */
export function runningMedian(y, win) {
  const n = y.length, out = new Float64Array(n), hw = win >> 1, buf = new Float64Array(win);
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - hw), b = Math.min(n, i + hw + 1); let m = 0; for (let k = a; k < b; k++) if (y[k] === y[k]) buf[m++] = y[k]; if (!m) { out[i] = NaN; continue; } const s = buf.subarray(0, m); s.sort(); out[i] = m & 1 ? s[m >> 1] : 0.5 * (s[m / 2 - 1] + s[m / 2]); }
  return out;
}

/**
 * The scatter EXOTIC's TESS script uses to compare apertures (examples/tess/tess.py check_std): the standard
 * deviation of flux minus a Savitzky-Golay smooth of window 1 + 2 * max(15, int(dt_hours / 24 / cadence)), order 2.
 * EXOTIC compares that in flux units; `relative` divides by the median flux so that apertures of different size
 * are comparable (a larger aperture collects more flux and more absolute noise); `robust` uses 1.4826 x the median
 * absolute deviation instead of the standard deviation, so that transits and flares (a few per cent of the points)
 * do not set the value.
 */
export function smoothScatter(time, flux, dtHours = 0.5, relative = true, robust = false) {
  const n = time.length; if (n < 35) return NaN;
  const cad = (time[n - 1] - time[0]) / (n - 1), win = 1 + 2 * Math.max(15, Math.floor(dtHours / 24 / cad));
  if (n < win) return NaN;
  const sm = savgol2(flux, win), d = new Float64Array(n); let mean = 0; for (let i = 0; i < n; i++) { d[i] = flux[i] - sm[i]; mean += d[i]; } mean /= n;
  let sd;
  if (robust) { const md = median(d); sd = 1.4826 * median(d.map((v) => Math.abs(v - md))); }
  else { let q = 0; for (let i = 0; i < n; i++) q += (d[i] - mean) * (d[i] - mean); sd = Math.sqrt(q / n); }
  return sd / (relative ? median(flux) : 1);
}

/**
 * Choose the aperture of a target pixel file. Candidates: the pipeline's optimal aperture and that aperture grown
 * by one and by two pixels (EXOTIC's three), threshold masks at 3, 5, 10 and 20 sigma about the target, and circles of
 * radius 1 to 4 px on the target. Each is ranked by the robust scatter of its good cadences about a Savitzky-Golay
 * smooth, relative to its median flux (smoothScatter with relative and robust set, per stretch of continuous data).
 * An aperture holding less than `minFlux` (default 0.6) of the flux of the pipeline aperture (of the brightest
 * candidate when there is no pipeline aperture) is listed but cannot win: a few bright pixels can have low white
 * noise and still lose a varying fraction of the star's light as the pointing moves.
 * EXOTIC's own number (standard deviation, in flux units) is reported as `exotic` for comparison.
 * @param opts { x, y: the target's pixel position in the cutout (default: the brightest pixel near the centre),
 *               radii, thresholds, dtHours = 0.5, minFlux = 0.6 }
 * @returns { tried: [{ name, npix, scatter, exotic, flux (median), mask, n, eligible }], best, lc: tpfLightCurve of the best
 *            with a `good` index list, target: { x, y }, image: the median image }
 */
export function optimiseTpf(tpf, opts = {}) {
  const { nx, ny } = tpf, img = tpfMedianImage(tpf);
  let x0 = opts.x, y0 = opts.y;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
    const pm = pipelineMask(tpf); let bv = -Infinity; x0 = (nx - 1) / 2; y0 = (ny - 1) / 2;
    const cx = (nx - 1) / 2, cy = (ny - 1) / 2;
    for (let i = 0; i < nx * ny; i++) { const x = i % nx, y = (i / nx) | 0; if ((pm ? pm[i] : Math.hypot(x - cx, y - cy) <= 2.5) && img[i] > bv) { bv = img[i]; x0 = x; y0 = y; } }
    // refine to the flux-weighted centre of the 3x3 around the peak
    let s = 0, sx = 0, sy = 0; const fl = Float64Array.from(img).filter((v) => v === v).sort(), lev = fl[fl.length >> 2];
    for (let y = Math.max(0, y0 - 1); y <= Math.min(ny - 1, y0 + 1); y++) for (let x = Math.max(0, x0 - 1); x <= Math.min(nx - 1, x0 + 1); x++) { const v = img[y * nx + x] - lev; if (v > 0) { s += v; sx += v * x; sy += v * y; } }
    if (s > 0) { x0 = sx / s; y0 = sy / s; }
  }
  const cands = [], pm = pipelineMask(tpf);
  if (pm) { cands.push({ name: 'pipeline', mask: pm }); cands.push({ name: 'pipeline + 1 px', mask: dilateMask(pm, nx, ny, 1) }); cands.push({ name: 'pipeline + 2 px', mask: dilateMask(pm, nx, ny, 2) }); }
  for (const ns of opts.thresholds || [3, 5, 10, 20]) cands.push({ name: `threshold ${ns}σ`, mask: thresholdMask(img, nx, ny, ns, x0, y0) });
  for (const r of opts.radii || [1, 1.5, 2, 2.5, 3, 4]) cands.push({ name: `circle r = ${r} px`, mask: circleMask(nx, ny, x0, y0, r) });
  const tried = [], lcs = [];
  for (const c of cands) {
    const npix = c.mask.reduce((a, b) => a + b, 0);
    if (!npix || npix >= nx * ny) { continue; }
    if (tried.some((t) => t.npix === npix && t.mask.every((v, i) => v === c.mask[i]))) continue;      // same pixels under another name
    const lc = tpfLightCurve(tpf, c.mask, opts), good = []; for (let i = 0; i < lc.ok.length; i++) if (lc.ok[i]) good.push(i);
    const t = Float64Array.from(good, (i) => lc.time[i]), f = Float64Array.from(good, (i) => lc.flux[i]);
    // each stretch between gaps of more than an hour is scored separately (a smooth across a gap is meaningless), then combined
    tried.push({ name: c.name, npix, scatter: segmentScatter(t, f, opts.dtHours ?? 0.5, true, true), exotic: segmentScatter(t, f, opts.dtHours ?? 0.5, false, false), flux: median(f), mask: c.mask, n: good.length });
    lcs.push({ ...lc, good });
  }
  const refFlux = tried.length && tried[0].name === 'pipeline' ? tried[0].flux : Math.max(...tried.map((t) => t.flux));
  let best = -1, bv = Infinity;
  tried.forEach((t, i) => { t.eligible = t.flux > 0 && t.flux >= (opts.minFlux ?? 0.6) * refFlux; if (t.eligible && Number.isFinite(t.scatter) && t.scatter < bv) { bv = t.scatter; best = i; } });
  return { tried, best, lc: best >= 0 ? lcs[best] : null, target: { x: x0, y: y0 }, image: img };
}

/** smoothScatter on each stretch of data between gaps longer than `gap` days (default: an hour, or five cadences if longer), combined as an RMS weighted by length. */
export function segmentScatter(t, f, dtHours = 0.5, relative = true, robust = false, gap = 0) {
  const n = t.length; let a = 0, q = 0, m = 0; const med = median(f);
  if (!(gap > 0)) { const dts = new Float64Array(Math.max(0, n - 1)); for (let i = 1; i < n; i++) dts[i - 1] = t[i] - t[i - 1]; gap = Math.max(1 / 24, 5 * median(dts)); }
  for (let i = 1; i <= n; i++) if (i === n || t[i] - t[i - 1] > gap) {
    const s = smoothScatter(t.subarray(a, i), f.subarray(a, i), dtHours, false, robust);
    if (Number.isFinite(s)) { q += s * s * (i - a); m += i - a; }
    a = i;
  }
  return m ? Math.sqrt(q / m) / (relative ? med : 1) : NaN;
}

// ---------------------------------------------------------------------------------------------------------
// Synthetic frames (the page's demo, timing runs, and tests that need a frame with a known answer)

const erf = (x) => 1 - erfc(x);
/**
 * Add Gaussian stars to a frame, each integrated over the pixels (not sampled at their centres).
 * stars: [{ x, y, flux, sigma }]. `data` is modified in place.
 */
export function addStars(data, w, h, stars) {
  for (const s of stars) {
    const half = Math.ceil(6 * s.sigma), cx = Math.round(s.x), cy = Math.round(s.y), k = 1 / (Math.SQRT2 * s.sigma), nb = 2 * half + 1;
    const ex = new Float64Array(nb), ey = new Float64Array(nb);
    for (let i = 0; i < nb; i++) { const px = cx - half + i, py = cy - half + i; ex[i] = 0.5 * (erf((px + 0.5 - s.x) * k) - erf((px - 0.5 - s.x) * k)); ey[i] = 0.5 * (erf((py + 0.5 - s.y) * k) - erf((py - 0.5 - s.y) * k)); }
    for (let j = 0; j < nb; j++) { const y = cy - half + j; if (y < 0 || y >= h) continue; const fy = s.flux * ey[j], row = y * w; for (let i = 0; i < nb; i++) { const x = cx - half + i; if (x < 0 || x >= w) continue; data[row + x] += fy * ex[i]; } }
  }
  return data;
}

/** Add Gaussian noise (rng from makeRng in stats.js) of variance read^2 + max(0, value) / gain (after any stars are in). */
export function addNoise(data, rng, read = 5, gain = 1) {
  for (let i = 0; i < data.length; i++) data[i] += Math.sqrt(read * read + Math.max(0, data[i]) / gain) * rng.normal();
  return data;
}

// ---------------------------------------------------------------------------------------------------------
// Field rotation, flips and jumps: similarity transforms between star lists

/**
 * Least-squares similarity transform taking (x, y) to (X, Y) from pairs [[x, y, X, Y], ...]:
 *   X = a x - b y + tx,  Y = b x + a y + ty          (mirror: y is negated first, i.e. X = a x + b y + tx, Y = b x - a y + ty)
 * @returns { a, b, tx, ty, mirror, scale, rotation [rad, counter-clockwise in image coordinates], rms [px], n }
 */
export function fitSimilarity(pairs, mirror = false) {
  const n = pairs.length; if (n < 1) return null;
  let mx = 0, my = 0, mX = 0, mY = 0; const sg = mirror ? -1 : 1;
  for (const p of pairs) { mx += p[0]; my += sg * p[1]; mX += p[2]; mY += p[3]; } mx /= n; my /= n; mX /= n; mY /= n;
  let sxx = 0, sa = 0, sb = 0;
  for (const p of pairs) { const dx = p[0] - mx, dy = sg * p[1] - my, dX = p[2] - mX, dY = p[3] - mY; sxx += dx * dx + dy * dy; sa += dx * dX + dy * dY; sb += dx * dY - dy * dX; }
  const a = n > 1 && sxx > 0 ? sa / sxx : 1, b = n > 1 && sxx > 0 ? sb / sxx : 0, tx = mX - (a * mx - b * my), ty = mY - (b * mx + a * my);
  const T = { a, b, tx, ty, mirror, scale: Math.hypot(a, b), rotation: Math.atan2(b, a), rms: 0, n };
  let q = 0; const o = [0, 0]; for (const p of pairs) { applySimilarity(T, p[0], p[1], o); q += (o[0] - p[2]) ** 2 + (o[1] - p[3]) ** 2; }
  T.rms = Math.sqrt(q / n);
  return T;
}
/** Apply a transform from fitSimilarity to a point; writes [X, Y] into out. */
export function applySimilarity(T, x, y, out = [0, 0]) { const yy = T.mirror ? -y : y; out[0] = T.a * x - T.b * yy + T.tx; out[1] = T.b * x + T.a * yy + T.ty; return out; }

// triangles of a point list: [i (opposite the shortest side), j (opposite the middle), k (opposite the longest), r1 = short / long, r2 = middle / long, longest side, orientation]
function triangles(P, minSide) {
  const out = [], n = P.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const dij = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y), djk = Math.hypot(P[j].x - P[k].x, P[j].y - P[k].y), dik = Math.hypot(P[i].x - P[k].x, P[i].y - P[k].y);
    const s = [[dij, k], [djk, i], [dik, j]].sort((p, q) => p[0] - q[0]);          // side length and the vertex opposite it
    if (s[0][0] < minSide || s[2][0] > 0.985 * (s[0][0] + s[1][0])) continue;       // too small, or nearly collinear
    if (s[1][0] / s[2][0] - s[0][0] / s[2][0] < 0.02 || 1 - s[1][0] / s[2][0] < 0.02) continue;   // nearly isosceles: the vertex order is ambiguous
    const A = P[s[0][1]], B = P[s[1][1]], C = P[s[2][1]], cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    out.push([s[0][1], s[1][1], s[2][1], s[0][0] / s[2][0], s[1][0] / s[2][0], s[2][0], cr > 0 ? 1 : -1]);
  }
  return out;
}

/**
 * The similarity transform (translation, rotation by any angle including the 180 degrees of a meridian flip, scale,
 * and optionally a mirror) that maps a reference star list onto the stars of another frame, by matching triangles
 * (Groth 1986; Valdes et al. 1995; the idea behind astroalign, which EXOTIC uses): triangles of the brightest
 * `nmax` stars of each list are compared by their side ratios, each matched pair of triangles votes for three
 * star pairs, the best-voted pairs give a first transform, and all stars within `tol` px of their predicted place
 * then refine it.
 * @param ref, cur  [{ x, y }] brightest first
 * @param opts { nmax = 14, tol = 2.5 [px], ratioTol = 0.012, scaleTol = 0.05 (allowed change of scale; null = any), mirror = false (also try mirror images), minSide = 12,
 *               minFrac = 0.3 (share of the shorter list, counted up to 20 stars, that must match) }
 * @returns null when no consistent match, else the transform of fitSimilarity plus { nMatch, votes, pairs: [[iRef, iCur]] }
 */
export function matchAsterism(ref, cur, opts = {}) {
  const { nmax = 14, tol = 2.5, ratioTol = 0.012, scaleTol = 0.05, mirror = false, minSide = 12, minFrac = 0.3 } = opts;
  const A = ref.slice(0, nmax), B = cur.slice(0, nmax);
  if (A.length < 3 || B.length < 3) return null;
  const TA = triangles(A, minSide), TB = triangles(B, minSide);
  let best = null;
  for (const par of mirror ? [1, -1] : [1]) {
    const votes = new Int32Array(A.length * B.length);
    for (const ta of TA) for (const tb of TB) {
      if (Math.abs(ta[3] - tb[3]) > ratioTol || Math.abs(ta[4] - tb[4]) > ratioTol || ta[6] * tb[6] !== par) continue;
      if (scaleTol != null && Math.abs(tb[5] / ta[5] - 1) > scaleTol) continue;
      for (let v = 0; v < 3; v++) votes[ta[v] * B.length + tb[v]]++;
    }
    const cand = []; for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (votes[i * B.length + j] > 0) cand.push([votes[i * B.length + j], i, j]);
    cand.sort((p, q) => q[0] - p[0]);
    if (!cand.length) continue;
    const usedA = new Set(), usedB = new Set(), pairs = [], top = cand[0][0];
    for (const [v, i, j] of cand) { if (v < Math.max(1, 0.4 * top) || usedA.has(i) || usedB.has(j)) continue; usedA.add(i); usedB.add(j); pairs.push([A[i].x, A[i].y, B[j].x, B[j].y]); }
    if (pairs.length < 3) continue;
    // first transform from the three best-voted pairs, then grow: stars of the full lists within tol of the prediction
    let T = fitSimilarity(pairs.slice(0, 3), par < 0), matched = [];
    const o = [0, 0];
    for (let it = 0; it < 4 && T; it++) {
      matched = []; const taken = new Set();
      for (let i = 0; i < ref.length; i++) {
        applySimilarity(T, ref[i].x, ref[i].y, o);
        let bj = -1, bd = (it === 0 ? 2 : 1) * tol;
        for (let j = 0; j < cur.length; j++) { if (taken.has(j)) continue; const d = Math.hypot(cur[j].x - o[0], cur[j].y - o[1]); if (d < bd) { bd = d; bj = j; } }
        if (bj >= 0) { taken.add(bj); matched.push([i, bj]); }
      }
      if (matched.length < 3) { T = null; break; }
      T = fitSimilarity(matched.map(([i, j]) => [ref[i].x, ref[i].y, cur[j].x, cur[j].y]), par < 0);
    }
    if (!T || T.rms > tol) continue;
    if (matched.length < minFrac * Math.min(ref.length, cur.length, 20)) continue;          // three stars can line up by chance; a real match holds a fair share of the field
    if (scaleTol != null && Math.abs(T.scale - 1) > scaleTol) continue;
    if (!best || matched.length > best.nMatch) best = { ...T, nMatch: matched.length, votes: top, pairs: matched };
  }
  return best;
}

/**
 * Place stars in a new frame given their reference positions and a transform: each is re-centred from its
 * predicted position; a star whose centroid fails, or lands more than `tol` px from where the transform refitted to
 * the others puts it, is left at the predicted position.
 * @returns { lost, T: the transform refitted to the stars that were found (null with fewer than 2) }
 */
export function placeStars(data, w, h, refPos, T, out, opts = {}) {
  const { half = 7, tol = 3 } = opts, ns = refPos.length >> 1, o = [0, 0], pairs = [], okv = new Uint8Array(ns);
  for (let s = 0; s < ns; s++) {
    applySimilarity(T, refPos[2 * s], refPos[2 * s + 1], o);
    const c = centroidIter(data, w, h, o[0], o[1], half);
    if (c[2] > 0 && Number.isFinite(c[0]) && Math.hypot(c[0] - o[0], c[1] - o[1]) < half) { out[2 * s] = c[0]; out[2 * s + 1] = c[1]; okv[s] = 1; pairs.push([refPos[2 * s], refPos[2 * s + 1], c[0], c[1]]); }
    else { out[2 * s] = o[0]; out[2 * s + 1] = o[1]; }
  }
  let lost = ns - pairs.length;
  const T2 = pairs.length >= 3 ? fitSimilarity(pairs, T.mirror) : null;
  if (T2) for (let s = 0; s < ns; s++) { if (!okv[s]) continue; applySimilarity(T2, refPos[2 * s], refPos[2 * s + 1], o); if (Math.hypot(out[2 * s] - o[0], out[2 * s + 1] - o[1]) > tol) { applySimilarity(T, refPos[2 * s], refPos[2 * s + 1], o); out[2 * s] = o[0]; out[2 * s + 1] = o[1]; lost++; } }
  return { lost, T: T2 };
}

// ---------------------------------------------------------------------------------------------------------
// Self-flat-fielding for K2 (Vanderburg & Johnson 2014, PASP 126, 948)

/**
 * Remove the roll systematics of a K2 light curve: the flux is divided by a slow trend, and in each window of
 * `windowDays` the remainder is binned against the star's position along its arc on the detector (the first
 * principal axis of the centroids within the window); the binned relation, interpolated, is the correction. This
 * is iterated. Transits survive because the bins take medians and the trend is a running median longer than a
 * transit.
 * @param opts { windowDays = 6, bins = 15, trendDays = 1.5, iters = 3, keep (Uint8Array) }
 * @returns { corrected (flux / correction), correction, trend, arclength, rmsBefore, rmsAfter (of flux / trend - 1, robust) }
 */
export function sffDetrend(time, flux, x, y, opts = {}) {
  const { windowDays = 6, bins = 15, trendDays = 1.5, iters = 3, keep = null } = opts, n = time.length;
  const good = []; for (let i = 0; i < n; i++) if ((!keep || keep[i]) && Number.isFinite(flux[i]) && Number.isFinite(x[i]) && Number.isFinite(y[i]) && Number.isFinite(time[i])) good.push(i);
  const corr = new Float64Array(n).fill(1), arc = new Float64Array(n).fill(NaN), trend = new Float64Array(n).fill(NaN);
  if (good.length < 4 * bins) return null;
  const t0 = time[good[0]], span = time[good[good.length - 1]] - t0, nw = Math.max(1, Math.round(span / windowDays)), wins = Array.from({ length: nw }, () => []);
  for (const i of good) wins[Math.min(nw - 1, Math.floor((time[i] - t0) / span * nw))].push(i);
  for (const W of wins) {                       // arclength: position along the first principal axis of the window's centroids
    if (W.length < 3) continue;
    let mx = 0, my = 0; for (const i of W) { mx += x[i]; my += y[i]; } mx /= W.length; my /= W.length;
    let sxx = 0, sxy = 0, syy = 0; for (const i of W) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), s = Math.sin(th);
    for (const i of W) arc[i] = (x[i] - mx) * c + (y[i] - my) * s;
  }
  const cad = median(Float64Array.from({ length: good.length - 1 }, (_, k) => time[good[k + 1]] - time[good[k]])), win = Math.max(5, 2 * Math.floor(trendDays / cad / 2) + 1);
  const g = Float64Array.from(good, (i) => flux[i]), r = new Float64Array(good.length);
  const rob = (v) => { const m = median(v); return 1.4826 * median(v.map((u) => Math.abs(u - m))); };
  let rmsBefore = NaN, sm = null;
  for (let it = 0; it < iters; it++) {
    sm = runningMedian(Float64Array.from(good, (i, k) => g[k] / corr[i]), win);
    for (let k = 0; k < good.length; k++) r[k] = g[k] / sm[k];
    if (it === 0) rmsBefore = rob(r);
    const pos = new Map(good.map((i, k) => [i, k]));
    for (const W of wins) {
      if (W.length < 3 * bins) { for (const i of W) corr[i] = 1; continue; }
      const order = W.slice().sort((p, q) => arc[p] - arc[q]), nb = Math.min(bins, Math.floor(W.length / 6)), bx = [], by = [];
      for (let b = 0; b < nb; b++) { const seg = order.slice(Math.floor(b * order.length / nb), Math.floor((b + 1) * order.length / nb)); bx.push(median(seg.map((i) => arc[i]))); by.push(median(seg.map((i) => r[pos.get(i)]))); }
      for (const i of W) {
        const a = arc[i]; let v;
        if (a <= bx[0]) v = by[0]; else if (a >= bx[nb - 1]) v = by[nb - 1];
        else { let b = 1; while (bx[b] < a) b++; const u = (a - bx[b - 1]) / (bx[b] - bx[b - 1] || 1); v = by[b - 1] + u * (by[b] - by[b - 1]); }
        corr[i] = v;
      }
    }
  }
  const corrected = Float64Array.from(flux, (v, i) => v / corr[i]);
  const sm2 = runningMedian(Float64Array.from(good, (i) => corrected[i]), win);
  good.forEach((i, k) => { trend[i] = sm2[k]; });
  return { corrected, correction: corr, trend, arclength: arc, rmsBefore, rmsAfter: rob(Float64Array.from(good, (i, k) => corrected[i] / sm2[k])), n: good.length, windows: nw };
}
