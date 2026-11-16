// Detrending diagnostics for light-curve residuals: is the noise white, and does the flux follow the star's
// position on the detector?
//
//   fft                    complex FFT of any length (radix-2; Bluestein's chirp-z for the other lengths)
//   periodogramPsd         one-sided power spectral density of an evenly sampled series, = scipy.signal.periodogram
//   welchPsd               averaged over overlapping windows, = scipy.signal.welch; windows can be kept inside
//                          gap-free segments (splitSegments) for space-based series with gaps
//   lombScarglePsd         the same quantity for uneven sampling, from periodogram.js's lombScargle
//   whiteNoiseLevel / photonNoiseLevel / photonNoise / scintillation
//                          the horizontal lines to compare a PSD with: error bars, CCD-equation noise
//   logBinPsd              log-spaced averaging for display and for the fit
//   fitRedNoise            P(f) = W + A f^-gamma by least squares on ln P, and the knee where the two terms cross
//   rmsVsBin               "rms versus bin size" (time averaging: Pont et al. 2006; Winn et al. 2008), in the exact
//                          convention of MC3's mc3.stats.time_avg (Cubillos et al. 2017, AJ 153, 3), and beta
//   pixelMap               mean residual binned on the (x, y) centroid, = scipy.stats.binned_statistic_2d
//   polySurface            2-D polynomial of total order 1..3 by least squares (Householder QR), = numpy lstsq
//   surfaceOnGrid / gpSurface   any function, or the Gaussian process of gp.js, sampled on the map's grid
//   syntheticRollSeries    a K2-like test series with a known intrapixel sensitivity (used by the test and the harness)
//
// PSD convention (all three estimators).  One-sided density: the integral of P over 0 < f < Nyquist is the
// variance of the series. Units are y^2 per unit of frequency, the frequency being in cycles per unit of dt
// (dt in days: f in 1/day and P in y^2 day; dt in seconds: Hz and y^2/Hz). Independent ("white") noise of
// variance s^2 sampled every dt has the flat level  P = 2 s^2 dt  (s^2 spread evenly over a band 1/(2 dt)).
// Correlated ("red") noise is whatever rises above that level towards low frequency.
//
// No DOM. Checked against scipy, astropy, numpy and MC3 in test/psd.test.mjs (reference: test/make_psd_reference.py).

import { lombScargle } from './periodogram.js';
import { detrendWithCentroids } from './gp.js';
import { makeRng } from './stats.js';

const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------------------------------------
// FFT

const twiddleCache = new Map();
function twiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    const c = new Float64Array(n / 2), s = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { const a = -TWO_PI * i / n; c[i] = Math.cos(a); s[i] = Math.sin(a); }
    t = { c, s }; if (twiddleCache.size > 8) twiddleCache.clear(); twiddleCache.set(n, t);
  }
  return t;
}

/** In-place forward FFT of a power-of-two length (iterative Cooley-Tukey, sign -i). */
function fftRadix2(re, im) {
  const n = re.length; if (n < 2) return;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const { c, s } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, q = 0; k < half; k++, q += step) {
        const a = i + k, b = a + half, wr = c[q], wi = s[q], xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

/**
 * Forward discrete Fourier transform X_k = sum_j x_j exp(-2 pi i j k / n), in place, any n.
 * Powers of two go straight to the radix-2 transform; other lengths use Bluestein's identity
 * jk = (j^2 + k^2 - (k - j)^2) / 2, which turns the DFT into a convolution done with three radix-2 FFTs of
 * length >= 2n - 1 (the chirp phases use j^2 mod 2n, so they stay exact for any n). Cost O(n log n) always.
 */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) === 0) { fftRadix2(re, im); return; }
  let m = 1; while (m < 2 * n - 1) m <<= 1;
  const wr = new Float64Array(n), wi = new Float64Array(n);
  for (let k = 0; k < n; k++) { const a = -Math.PI * ((k * k) % (2 * n)) / n; wr[k] = Math.cos(a); wi[k] = Math.sin(a); }
  const ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let k = 0; k < n; k++) { ar[k] = re[k] * wr[k] - im[k] * wi[k]; ai[k] = re[k] * wi[k] + im[k] * wr[k]; }
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k++) { br[k] = br[m - k] = wr[k]; bi[k] = bi[m - k] = -wi[k]; }
  fftRadix2(ar, ai); fftRadix2(br, bi);
  for (let k = 0; k < m; k++) { const r = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = -(ar[k] * bi[k] + ai[k] * br[k]); ar[k] = r; }   // conj(product), for the inverse
  fftRadix2(ar, ai);
  for (let k = 0; k < n; k++) { const cr = ar[k] / m, ci = -ai[k] / m; re[k] = cr * wr[k] - ci * wi[k]; im[k] = cr * wi[k] + ci * wr[k]; }
}

// ---------------------------------------------------------------------------------------------------------
// Periodogram and Welch

function windowOf(name, n) {
  const w = new Float64Array(n);
  if (!name || name === 'boxcar') w.fill(1);
  else if (name === 'hann') for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / n);   // periodic ("fftbins"), as scipy.signal.get_window
  else throw new Error(`unknown window "${name}"`);
  return w;
}

/** Copy y[i0, i0 + n) with the mean ('constant') or the least-squares straight line ('linear') removed. */
function detrended(y, i0, n, mode) {
  const out = new Float64Array(n);
  if (!mode || mode === 'none') { for (let i = 0; i < n; i++) out[i] = y[i0 + i]; return out; }
  let m = 0; for (let i = 0; i < n; i++) m += y[i0 + i]; m /= n;
  if (mode === 'constant') { for (let i = 0; i < n; i++) out[i] = y[i0 + i] - m; return out; }
  if (mode !== 'linear') throw new Error(`unknown detrend "${mode}"`);
  const c = (n - 1) / 2; let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - c) * (y[i0 + i] - m); sxx += (i - c) * (i - c); }
  const b = sxx > 0 ? sxy / sxx : 0;
  for (let i = 0; i < n; i++) out[i] = y[i0 + i] - m - b * (i - c);
  return out;
}

/** One-sided density of one already detrended segment: |FFT(w x)|^2 dt / sum(w^2), doubled except at f = 0 and Nyquist. */
function segmentPsd(x, w, dt, out) {
  const n = x.length, re = new Float64Array(n), im = new Float64Array(n); let s2 = 0;
  for (let i = 0; i < n; i++) { re[i] = x[i] * w[i]; s2 += w[i] * w[i]; }
  fft(re, im);
  const nf = (n >> 1) + 1, sc = dt / s2;
  for (let k = 0; k < nf; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) * sc * (k === 0 || (n % 2 === 0 && k === n / 2) ? 1 : 2);
  return out;
}

const fourierFreqs = (n, dt) => { const nf = (n >> 1) + 1, f = new Float64Array(nf); for (let k = 0; k < nf; k++) f[k] = k / (n * dt); return f; };

/**
 * Power spectral density of an evenly sampled series: the same numbers as
 * scipy.signal.periodogram(y, fs = 1/dt, window, detrend, scaling = 'density').
 * @param y     samples (no NaN), spacing dt
 * @param dt    sampling interval. Frequencies come out in cycles per unit of dt and the density in y^2 times
 *              that unit (dt in days: 1/day and y^2 day; dt in seconds: Hz and y^2/Hz)
 * @param opts  { detrend: 'constant' (default) | 'linear' | 'none', window: 'boxcar' (default) | 'hann' }
 * @returns { f, p, df, n }: f_k = k / (n dt) for k = 0 .. floor(n/2); sum(p) df = variance for the boxcar.
 *          f[0] = 0 is included (as scipy does); with a detrend its power is zero, so skip it on a log axis.
 */
export function periodogramPsd(y, dt = 1, opts = {}) {
  const n = y.length; if (n < 2) throw new Error('a periodogram needs at least 2 points');
  const x = detrended(y, 0, n, opts.detrend ?? 'constant'), p = new Float64Array((n >> 1) + 1);
  segmentPsd(x, windowOf(opts.window ?? 'boxcar', n), dt, p);
  return { f: fourierFreqs(n, dt), p, df: 1 / (n * dt), n };
}

/**
 * Split a time series at its gaps. A gap is a step larger than gapFactor (default 1.5) times the median step.
 * @returns { segments: [[i0, i1), ...] (index ranges, in order), dt (the median step) }
 */
export function splitSegments(t, opts = {}) {
  const n = t.length; if (n < 2) return { segments: n ? [[0, n]] : [], dt: NaN };
  const d = new Float64Array(n - 1); for (let i = 0; i < n - 1; i++) d[i] = t[i + 1] - t[i];
  const dt = opts.dt ?? Float64Array.from(d).sort()[(n - 1) >> 1], lim = (opts.gapFactor ?? 1.5) * dt, segments = []; let i0 = 0;
  for (let i = 0; i < n - 1; i++) if (!(d[i] <= lim)) { segments.push([i0, i + 1]); i0 = i + 1; }
  segments.push([i0, n]);
  return { segments, dt };
}

/** Bias of the median of n periodogram estimates relative to their mean (scipy.signal's _median_bias). */
function medianBias(n) { let b = 1; for (let k = 1; k <= (n - 1) >> 1; k++) b += 1 / (2 * k + 1) - 1 / (2 * k); return b; }

/**
 * Welch's averaged periodogram: the same numbers as
 * scipy.signal.welch(y, fs = 1/dt, window = 'hann', nperseg, noverlap, detrend = 'constant', scaling = 'density', average).
 * @param opts  { nperseg = 256 (reduced to the series length if longer), noverlap = floor(nperseg / 2),
 *                window = 'hann' | 'boxcar', detrend = 'constant' | 'linear' | 'none', average = 'mean' | 'median',
 *                segments: [[i0, i1), ...] from splitSegments }
 *   With `segments`, windows are laid out inside each gap-free segment separately (each exactly as scipy would
 *   on that segment alone) and all windows are averaged together; segments shorter than nperseg are skipped.
 *   Without it nperseg is reduced to the series length when the series is shorter, as scipy does.
 * @returns { f, p, df, nperseg, nWindows }.  Resolution df = 1 / (nperseg dt); the scatter of each ordinate is
 *          about 1/sqrt(nWindows) of its value (less gain from the overlap), instead of 100% for the periodogram.
 */
export function welchPsd(y, dt = 1, opts = {}) {
  const n = y.length; let nperseg = Math.floor(opts.nperseg ?? 256);
  const segs = opts.segments ?? [[0, n]];
  if (!opts.segments && nperseg > n) nperseg = n;
  if (nperseg < 2) throw new Error('nperseg must be at least 2');
  const noverlap = opts.noverlap != null ? Math.floor(opts.noverlap) : nperseg >> 1;
  if (noverlap >= nperseg) throw new Error('noverlap must be less than nperseg');
  const step = nperseg - noverlap, w = windowOf(opts.window ?? 'hann', nperseg), nf = (nperseg >> 1) + 1, all = [], buf = new Float64Array(nf);
  for (const [a, b] of segs) for (let i0 = a; i0 + nperseg <= b; i0 += step) all.push(Float64Array.from(segmentPsd(detrended(y, i0, nperseg, opts.detrend ?? 'constant'), w, dt, buf)));
  if (!all.length) throw new Error('no segment is as long as nperseg');
  const p = new Float64Array(nf), m = all.length;
  if ((opts.average ?? 'mean') === 'median') {
    const col = new Float64Array(m), bias = medianBias(m);
    for (let k = 0; k < nf; k++) { for (let j = 0; j < m; j++) col[j] = all[j][k]; col.sort(); p[k] = (m % 2 ? col[m >> 1] : 0.5 * (col[m / 2 - 1] + col[m / 2])) / bias; }
  } else if (opts.average === 'mean' || opts.average == null) {
    for (let k = 0; k < nf; k++) { let s = 0; for (let j = 0; j < m; j++) s += all[j][k]; p[k] = s / m; }
  } else throw new Error(`unknown average "${opts.average}"`);
  return { f: fourierFreqs(nperseg, dt), p, df: 1 / (nperseg * dt), nperseg, nWindows: m };
}

/**
 * Power spectral density of an unevenly sampled series, from the generalised Lomb-Scargle periodogram of
 * periodogram.js (floating mean), scaled to the convention at the top of this file:
 *     P(f) = 2 dt (n / sum w) P_psd(f),      w_i = 1 / dy_i^2 (w_i = 1 and sum w = n without error bars),
 * where P_psd = (chi2_ref - chi2(f)) / 2 is exactly astropy.timeseries.LombScargle(t, y[, dy]).power(f,
 * normalization = 'psd'), and dt = (t_max - t_min) / (n - 1) is the mean spacing. Without error bars this is
 * P = dt p_standard(f) sum (y - mean)^2. Why this is the right scale: for white noise of variance s^2 the
 * drop in chi-square from fitting one sinusoid is s^2 chi^2 with 2 degrees of freedom, so E[P_psd] = s^2 and
 * E[P] = 2 s^2 dt; and for evenly sampled data at the Fourier frequencies k / (n dt), 0 < k < n/2, P_psd =
 * |FFT|^2 / n, so P is identical to periodogramPsd(y, dt) (boxcar, detrend 'constant') ordinate by ordinate.
 * @param freqs  cycles per unit of t; null for the Fourier-like grid k / (n dt), k = 1 .. floor((n - 1) / 2)
 *               (the "average Nyquist" 1 / (2 dt) is only a guide for uneven sampling)
 * @param opts   { dy (1-sigma errors: weights), dt (override the mean spacing), fitMean = true }
 * @returns { f, p, dt }.  Cost: freqs.length * n sine/cosine pairs: fine for a ground-based night (n ~ 1000:
 *          a few ms per 100 frequencies); for n ~ 20,000 use periodogramPsd / welchPsd, or a short list of freqs.
 */
export function lombScarglePsd(t, y, freqs = null, opts = {}) {
  const n = t.length; let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { if (t[i] < lo) lo = t[i]; if (t[i] > hi) hi = t[i]; }
  const dt = opts.dt ?? (hi - lo) / (n - 1);
  if (!freqs) { const nf = (n - 1) >> 1; freqs = new Float64Array(nf); for (let k = 0; k < nf; k++) freqs[k] = (k + 1) / (n * dt); }
  let sw = n; if (opts.dy) { sw = 0; for (let i = 0; i < n; i++) sw += 1 / (opts.dy[i] * opts.dy[i]); }
  const p = lombScargle(t, y, opts.dy ?? null, freqs, { normalization: 'psd', fitMean: opts.fitMean !== false }), sc = 2 * dt * n / sw;
  for (let k = 0; k < p.length; k++) p[k] *= sc;
  return { f: Float64Array.from(freqs), p, dt };
}

// ---------------------------------------------------------------------------------------------------------
// Noise levels

/** Expected one-sided PSD level of independent noise with the given error bars: 2 mean(err^2) dt. err: array or number. */
export function whiteNoiseLevel(err, dt) {
  if (typeof err === 'number') return 2 * err * err * dt;
  let s = 0, m = 0; for (let i = 0; i < err.length; i++) if (Number.isFinite(err[i])) { s += err[i] * err[i]; m++; }
  return m ? 2 * dt * s / m : NaN;
}

/**
 * PSD level of the photon-noise limit: 2 mean(sigma^2) dt for a per-point relative noise sigma (number or array,
 * e.g. photonNoise(...).rel, in the units of the residuals: relative flux if the residuals are relative flux).
 */
export const photonNoiseLevel = (sigmaRel, dt) => whiteNoiseLevel(sigmaRel, dt);

/**
 * Scintillation noise as a fraction of the flux (Young 1967; the form in Dravins et al. 1998):
 *     sigma = 0.09 D^(-2/3) X^(7/4) (2 t)^(-1/2) exp(-h / 8000)
 * @param D diameter of the telescope in cm; airmass X; exptime t in seconds; altitude h of the site in metres.
 */
export const scintillation = ({ D, airmass = 1, exptime, altitude = 0 }) => 0.09 * Math.pow(D, -2 / 3) * Math.pow(airmass, 1.75) / Math.sqrt(2 * exptime) * Math.exp(-altitude / 8000);

/**
 * Noise of one aperture-photometry measurement from the "CCD equation" in the form of Merline & Howell (1995),
 * in electrons:
 *     sigma^2 = S + npix (1 + npix / nsky) (B + D + R^2 [+ g^2 sf^2]) [+ (sigma_scint S)^2]
 * S = gain * flux (star, sky-subtracted), B = gain * sky (per pixel), D the dark charge per pixel, R the read
 * noise per pixel; npix pixels in the aperture; the factor (1 + npix / nsky) is the cost of estimating the sky
 * from nsky pixels (the npix^2 / nsky term). With `digit` the digitisation term g^2 sf^2 (sf = 0.289) is added.
 * @param o { flux (ADU, in the aperture, sky-subtracted), sky = 0 (ADU per pixel), npix = 0, nsky = Infinity,
 *            gain = 1 (e-/ADU), readNoise = 0 (e- rms per pixel), dark = 0 (e- per pixel per exposure),
 *            scint: a fraction, or { D, airmass, exptime, altitude } for scintillation(), digit = false }
 *          flux and sky may be arrays (one value per frame); the result is then arrays.
 * @returns { sigma (e-), sigmaAdu, rel (sigma / S: the per-point relative noise), snr, photon (sqrt(S), the
 *            source-only limit, e-), relPhoton (1 / sqrt(S)) }
 */
export function photonNoise(o) {
  const { flux, sky = 0, npix = 0, nsky = Infinity, gain = 1, readNoise = 0, dark = 0, scint = 0, digit = false } = o;
  const sc = typeof scint === 'object' && scint ? scintillation(scint) : scint || 0;
  const one = (F, B) => {
    const S = gain * F, v = S + npix * (1 + npix / nsky) * (gain * B + dark + readNoise * readNoise + (digit ? gain * gain * 0.289 * 0.289 : 0)) + sc * sc * S * S, sigma = Math.sqrt(v);
    return { sigma, sigmaAdu: sigma / gain, rel: sigma / S, snr: S / sigma, photon: Math.sqrt(S), relPhoton: 1 / Math.sqrt(S) };
  };
  if (typeof flux === 'number') return one(flux, typeof sky === 'number' ? sky : sky[0]);
  const n = flux.length, out = { sigma: new Float64Array(n), sigmaAdu: new Float64Array(n), rel: new Float64Array(n), snr: new Float64Array(n), photon: new Float64Array(n), relPhoton: new Float64Array(n) };
  for (let i = 0; i < n; i++) { const r = one(flux[i], typeof sky === 'number' ? sky : sky[i]); for (const k in out) out[k][i] = r[k]; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Display binning and the red-noise fit

/**
 * Average a PSD in nbins logarithmically spaced frequency bins (for display, and to feed fitRedNoise).
 * Edges e_j = exp(ln fmin + j (ln fmax - ln fmin) / nbins) over the positive frequencies; a point belongs to
 * the last bin whose lower edge is <= f (fmax goes in the last bin). Empty bins are dropped.
 * @returns { f (geometric mean of the frequencies in the bin), p (arithmetic mean of the power, which keeps the
 *            level of a flat spectrum unbiased), n (points averaged: pass it to fitRedNoise as nAvg), lo, hi (bin edges) }
 */
export function logBinPsd(f, p, nbins = 30) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) if (f[i] > 0 && Number.isFinite(p[i])) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  if (!(hi > lo)) return { f: new Float64Array(0), p: new Float64Array(0), n: new Float64Array(0), lo: new Float64Array(0), hi: new Float64Array(0) };
  const l0 = Math.log(lo), dl = (Math.log(hi) - l0) / nbins, edges = new Float64Array(nbins + 1);
  for (let j = 0; j <= nbins; j++) edges[j] = Math.exp(l0 + j * dl);
  const sp = new Float64Array(nbins), sl = new Float64Array(nbins), cnt = new Float64Array(nbins);
  for (let i = 0; i < f.length; i++) {
    if (!(f[i] > 0) || !Number.isFinite(p[i])) continue;
    let j = Math.min(nbins - 1, Math.max(0, Math.floor((Math.log(f[i]) - l0) / dl)));
    while (j > 0 && f[i] < edges[j]) j--; while (j < nbins - 1 && f[i] >= edges[j + 1]) j++;
    sp[j] += p[i]; sl[j] += Math.log(f[i]); cnt[j]++;
  }
  const keep = []; for (let j = 0; j < nbins; j++) if (cnt[j] > 0) keep.push(j);
  return { f: Float64Array.from(keep, (j) => Math.exp(sl[j] / cnt[j])), p: Float64Array.from(keep, (j) => sp[j] / cnt[j]), n: Float64Array.from(keep, (j) => cnt[j]), lo: Float64Array.from(keep, (j) => edges[j]), hi: Float64Array.from(keep, (j) => edges[j + 1]) };
}

/** Digamma function psi(x), x > 0 (recurrence to x >= 12, then the asymptotic series; error below 1e-14). */
export function digamma(x) {
  let r = 0; while (x < 12) { r -= 1 / x; x += 1; }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x - f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f * (1 / 132)))));
}
/** Trigamma function psi'(x), x > 0 (same method; relative error below 1e-13). */
export function trigamma(x) {
  let r = 0; while (x < 12) { r += 1 / (x * x); x += 1; }
  const f = 1 / (x * x);
  return r + 1 / x + 0.5 * f + (1 / x) * f * (1 / 6 - f * (1 / 30 - f * (1 / 42 - f * (1 / 30 - f * (5 / 66)))));
}

/**
 * Fit P(f) = W + A f^-gamma (white level plus a power law) by least squares on the logarithm of the PSD.
 *
 * A periodogram ordinate is its expectation times an exponential variate (chi-square with 2 degrees of freedom,
 * halved), and the mean of m of them is a Gamma(m)/m variate, whose logarithm has mean psi(m) - ln m (-0.5772
 * for m = 1) and variance psi'(m) (pi^2 / 6 for m = 1), independent of the level: so the logarithm is the right
 * space for least squares, but a plain fit would sit a factor exp(psi(m) - ln m) too low (0.56 for a raw
 * periodogram). Minimised here:
 *     sum_i  [ ln p_i - (psi(m_i) - ln m_i) - ln(W + A f_i^-gamma) ]^2 / psi'(m_i)
 * with m_i = opts.nAvg (a number, or an array such as logBinPsd().n; default 1: a raw periodogram; for welchPsd
 * roughly nWindows). opts.correctBias = false drops the psi term (a plain log-space fit). The minimiser is
 * Levenberg-Marquardt in (ln W, ln A, gamma) from four starting slopes, with frequencies scaled by their
 * geometric mean; gamma is kept inside opts.gammaRange (default [0, 8]: a spectrum that rises towards low
 * frequency). Points with f <= 0 or p <= 0 are ignored. When the residuals are white the power law is not
 * constrained (gamma can end anywhere in its range, with the knee below the lowest frequency; at gamma = 0 the
 * two terms are the same flat level and are returned merged into W with A = 0). `red` says whether the power
 * law is needed: the fit must beat a single flat level (`whiteOnly`) by deltaCost > 9.21 (the 99% point of
 * chi-square with the 2 extra parameters; the weights make each term of the sum approximately unit variance)
 * and the knee must lie above the lowest frequency. red = false means "no red noise detected".
 * @returns { W, A, gamma, knee (the frequency where A f^-gamma = W, = (A / W)^(1/gamma); may lie outside the data),
 *            model(f), cost (the minimised sum), rmsLog (rms of the weighted log residuals: about 1 for a good fit),
 *            red, deltaCost, whiteOnly (see above),
 *            n, iterations }  -- A is in the PSD's units times (frequency unit)^gamma.
 */
export function fitRedNoise(f, p, opts = {}) {
  const idx = []; for (let i = 0; i < f.length; i++) if (f[i] > 0 && p[i] > 0 && Number.isFinite(p[i])) idx.push(i);
  const n = idx.length; if (n < 4) return null;
  const mOf = (i) => (opts.nAvg == null ? 1 : typeof opts.nAvg === 'number' ? opts.nAvg : opts.nAvg[i]);
  const x = new Float64Array(n), z = new Float64Array(n), sw = new Float64Array(n); let lf0 = 0;
  for (let k = 0; k < n; k++) lf0 += Math.log(f[idx[k]]) / n;
  for (let k = 0; k < n; k++) {
    const i = idx[k], m = Math.max(1e-3, mOf(i));
    x[k] = Math.log(f[i]) - lf0; z[k] = Math.log(p[i]) - (opts.correctBias === false ? 0 : digamma(m) - Math.log(m)); sw[k] = 1 / Math.sqrt(trigamma(m));
  }
  const cost = (th) => { let c = 0; for (let k = 0; k < n; k++) { const r = sw[k] * (z[k] - Math.log(Math.exp(th[0]) + Math.exp(th[1] - th[2] * x[k]))); c += r * r; } return c; };
  // starting point: white level from the upper third of the frequencies, power law through the lowest tenth
  const ord = Array.from({ length: n }, (_, k) => k).sort((a, b) => x[a] - x[b]), nl = Math.max(2, Math.ceil(n / 10)), nh = Math.max(2, Math.ceil(n / 3));
  let zl = 0, xl = 0, zh = 0; for (let k = 0; k < nl; k++) { zl += z[ord[k]] / nl; xl += x[ord[k]] / nl; } for (let k = 0; k < nh; k++) zh += z[ord[n - 1 - k]] / nh;
  let best = null, iterations = 0; const [gLo, gHi] = opts.gammaRange ?? [0, 8];
  for (const g0 of [0.5, 1, 2, 3]) {
    const th = [zh, Math.log(Math.max(Math.exp(zl) - Math.exp(zh), 0.1 * Math.exp(zl))) + g0 * xl, g0]; let c = cost(th), lam = 1e-3;
    for (let it = 0; it < 200; it++) {
      iterations++;
      const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
      for (let k = 0; k < n; k++) {
        const w = Math.exp(th[0]), a = Math.exp(th[1] - th[2] * x[k]), M = w + a, r = sw[k] * (z[k] - Math.log(M)), J = [sw[k] * w / M, sw[k] * a / M, -sw[k] * a * x[k] / M];
        for (let u = 0; u < 3; u++) { g[u] += J[u] * r; for (let v = 0; v < 3; v++) H[u][v] += J[u] * J[v]; }
      }
      let moved = false, done = false;
      for (let tries = 0; tries < 30; tries++) {
        const d = solve3(H, g, lam); if (!d) { lam *= 10; continue; }
        const tn = [th[0] + d[0], th[1] + d[1], Math.min(gHi, Math.max(gLo, th[2] + d[2]))], cn = cost(tn);
        if (cn <= c && Number.isFinite(cn)) {
          const small = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-12 || c - cn < 1e-15 * (1 + c);
          th[0] = tn[0]; th[1] = tn[1]; th[2] = tn[2]; c = cn; lam = Math.max(lam / 5, 1e-12); moved = true; done = small; break;
        }
        lam *= 10;
      }
      if (!moved || done) break;
    }
    if (!best || c < best.c) best = { th, c };
  }
  // white-only alternative: one level, the weighted mean of the corrected logarithms
  let zw = 0, ww = 0; for (let k = 0; k < n; k++) { zw += sw[k] * sw[k] * z[k]; ww += sw[k] * sw[k]; } zw /= ww;
  let costWhite = 0; for (let k = 0; k < n; k++) costWhite += (sw[k] * (z[k] - zw)) ** 2;
  const [lw, la, gamma] = best.th, flat = !(gamma > 1e-6), fLo = Math.exp(lf0 + x[ord[0]]);
  const W = flat ? Math.exp(lw) + Math.exp(la) : Math.exp(lw), A = flat ? 0 : Math.exp(la + gamma * lf0), knee = flat ? 0 : Math.exp(lf0 + (la - lw) / gamma), deltaCost = costWhite - best.c;
  return { W, A, gamma: flat ? 0 : gamma, knee, red: deltaCost > 9.21 && knee > fLo, deltaCost, whiteOnly: Math.exp(zw), model: (fr) => W + A * Math.pow(fr, -gamma), cost: best.c, rmsLog: Math.sqrt(best.c / n), n, iterations };
}

/** Solve (H + lam diag(H)) d = g for a symmetric 3 x 3 H (Cramer); null when singular. */
function solve3(H, g, lam) {
  const a = H[0][0] * (1 + lam) + 1e-300, b = H[0][1], c = H[0][2], d = H[1][1] * (1 + lam) + 1e-300, e = H[1][2], f = H[2][2] * (1 + lam) + 1e-300;
  const det = a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c);
  if (!(Math.abs(det) > 1e-300) || !Number.isFinite(det)) return null;
  return [
    (g[0] * (d * f - e * e) - b * (g[1] * f - e * g[2]) + c * (g[1] * e - d * g[2])) / det,
    (a * (g[1] * f - e * g[2]) - g[0] * (b * f - e * c) + c * (b * g[2] - g[1] * c)) / det,
    (a * (d * g[2] - g[1] * e) - b * (b * g[2] - g[1] * c) + g[0] * (b * e - d * c)) / det,
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Time averaging

/**
 * "rms versus bin size": the scatter of the residuals after averaging N consecutive points, against what
 * independent noise would give (Pont, Zucker & Queloz 2006; Winn et al. 2008), in the convention of MC3's
 * mc3.stats.time_avg (Cubillos et al. 2017), for each bin size N:
 *     M        = floor(n / N) non-overlapping bins of N consecutive points from the start (the remainder is dropped)
 *     rms      = sqrt( mean_j( binmean_j^2 ) )                 (about zero: the residuals are not re-centred)
 *     expected = sigma1 sqrt( M / (N (M - 1)) ),               sigma1 = the standard deviation of the unbinned
 *                residuals about their mean (divisor n), i.e. sigma1 / sqrt(N) times sqrt(M / (M - 1))
 *     rmsErr   = rms / sqrt(2 M)                               (asymptotic; MC3 replaces it below M = 36 by an
 *                asymmetric interval from an inverse-gamma distribution, which is not reproduced here)
 *     beta     = rms / expected                                (the factor by which Winn et al. inflate the errors)
 * @param resid  residuals in time order (finite values)
 * @param opts   { maxBin = floor(n / 2), binStep = 1  (MC3's maxbins and binstep: sizes 1, 1 + binStep, ...),
 *                 binSizes (explicit list, overrides), logBins (that many log-spaced sizes from 1 to maxBin;
 *                 the default for n > 5000 is 200 of them, otherwise every size as MC3 does),
 *                 minBins = 10 (beta's maximum is taken over sizes with M >= minBins: with fewer bins the rms
 *                 itself is uncertain by more than 1/sqrt(20) = 22%),
 *                 t (times) and gapFactor, or segments [[i0, i1), ...]: bins are formed inside gap-free
 *                 segments only (from the start of each, remainders dropped), M is the total over segments and
 *                 the formulae are unchanged; without gaps this is identical to MC3,
 *                 dt (kept in the result for the duration axis) }
 * @returns { n (bin sizes), M (bins used), rms, expected, rmsErr, betaCurve (rms / expected), sigma1, dt,
 *            beta (max of betaCurve over sizes with M >= minBins), nBeta (its bin size),
 *            betaAt(N) (rms / expected computed for exactly that size), betaMax(nLo, nHi) -> { beta, n } }
 */
export function rmsVsBin(resid, opts = {}) {
  const n = resid.length; if (n < 4) throw new Error('rmsVsBin needs at least 4 points');
  const segs = opts.segments ?? (opts.t ? splitSegments(opts.t, { gapFactor: opts.gapFactor }).segments : [[0, n]]);
  let mean = 0; for (let i = 0; i < n; i++) mean += resid[i]; mean /= n;
  let v = 0; for (let i = 0; i < n; i++) v += (resid[i] - mean) * (resid[i] - mean); const sigma1 = Math.sqrt(v / n);
  const maxBin = Math.max(1, Math.floor(opts.maxBin ?? n / 2));
  let sizes;
  if (opts.binSizes) sizes = Array.from(opts.binSizes, (s) => Math.floor(s)).filter((s) => s >= 1);
  else {
    const nlog = opts.logBins ?? (n > 5000 && opts.binStep == null ? 200 : 0);
    if (nlog) { const set = new Set(); for (let k = 0; k < nlog; k++) set.add(Math.round(Math.exp(Math.log(maxBin) * k / Math.max(1, nlog - 1)))); sizes = [...set].sort((a, b) => a - b); }
    else { sizes = []; for (let s = 1; s <= maxBin; s += Math.max(1, Math.floor(opts.binStep ?? 1))) sizes.push(s); }
  }
  const one = (N) => {
    let M = 0, q = 0;
    for (const [a, b] of segs) for (let i0 = a; i0 + N <= b; i0 += N) { let s = 0; for (let i = i0; i < i0 + N; i++) s += resid[i]; s /= N; q += s * s; M++; }
    const rms = M ? Math.sqrt(q / M) : NaN, expected = M > 1 ? sigma1 * Math.sqrt(M / (N * (M - 1))) : NaN;
    return { M, rms, expected, rmsErr: rms / Math.sqrt(2 * M), beta: rms / expected };
  };
  const k = sizes.length, out = { n: Float64Array.from(sizes), M: new Float64Array(k), rms: new Float64Array(k), expected: new Float64Array(k), rmsErr: new Float64Array(k), betaCurve: new Float64Array(k), sigma1, dt: opts.dt ?? null };
  sizes.forEach((N, j) => { const r = one(N); out.M[j] = r.M; out.rms[j] = r.rms; out.expected[j] = r.expected; out.rmsErr[j] = r.rmsErr; out.betaCurve[j] = r.beta; });
  const minBins = opts.minBins ?? 10;
  out.betaAt = (N) => one(Math.max(1, Math.round(N))).beta;
  out.betaMax = (nLo = 1, nHi = Infinity, mMin = minBins) => { let b = NaN, at = NaN; for (let j = 0; j < k; j++) if (sizes[j] >= nLo && sizes[j] <= nHi && out.M[j] >= mMin && !(out.betaCurve[j] <= b)) { b = out.betaCurve[j]; at = sizes[j]; } return { beta: b, n: at }; };
  const bm = out.betaMax(); out.beta = bm.beta; out.nBeta = bm.n;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Pixel map and surfaces

/** The q-th percentile (0..100) of the finite values of v, linear interpolation between order statistics (numpy's default). */
export function percentile(v, q) {
  const s = Float64Array.from(v).filter((a) => Number.isFinite(a)).sort(), n = s.length; if (!n) return NaN;
  const h = (n - 1) * q / 100, i = Math.floor(h), j = Math.min(n - 1, i + 1);
  return s[i] + (h - i) * (s[j] - s[i]);
}

/**
 * Mean residual binned on the centroid: how the measured flux depends on where the star sits on the detector.
 * Equal bins over [x0, x1] x [y0, y1]; edges x0 + i (x1 - x0) / nx; a point on an inner edge goes to the upper
 * bin and one on the last edge to the last bin (numpy.histogram2d / scipy.stats.binned_statistic_2d rule);
 * points outside the range are left out.
 * @param opts { nx = 20, ny = 20, range: [x0, x1, y0, y1] (default: the clip percentiles of the kept centroids),
 *               clip = [1, 99] (percent; [0, 100] for the full range), keep (Uint8Array: points to use) }
 * @returns { grid: { x0, x1, y0, y1, nx, ny }, mean, count, std (sample standard deviation, divisor count - 1),
 *            sem (std / sqrt(count)), all Float64Array(ny * nx) indexed [iy * nx + ix] with NaN where undefined
 *            (mean: empty bin; std, sem: fewer than 2 points), xc, yc (bin centres), nUsed, nOutside }
 */
export function pixelMap(x, y, resid, opts = {}) {
  const { nx = 20, ny = 20, clip = [1, 99], keep = null } = opts, N = resid.length, idx = [];
  for (let i = 0; i < N; i++) if ((!keep || keep[i]) && Number.isFinite(resid[i]) && Number.isFinite(x[i]) && Number.isFinite(y[i])) idx.push(i);
  let [x0, x1, y0, y1] = opts.range ?? [NaN, NaN, NaN, NaN];
  if (!opts.range) {
    const xs = idx.map((i) => x[i]), ys = idx.map((i) => y[i]);
    x0 = percentile(xs, clip[0]); x1 = percentile(xs, clip[1]); y0 = percentile(ys, clip[0]); y1 = percentile(ys, clip[1]);
    if (!(x1 > x0)) { x0 -= 0.5; x1 += 0.5; } if (!(y1 > y0)) { y0 -= 0.5; y1 += 0.5; }
  }
  const grid = { x0, x1, y0, y1, nx, ny }, ex = edgesOf(x0, x1, nx), ey = edgesOf(y0, y1, ny), m = nx * ny;
  const sum = new Float64Array(m), sq = new Float64Array(m), count = new Float64Array(m); let nUsed = 0;
  for (const i of idx) {
    const ix = binOf(x[i], ex, nx), iy = binOf(y[i], ey, ny); if (ix < 0 || iy < 0) continue;
    const k = iy * nx + ix; sum[k] += resid[i]; count[k]++; nUsed++;
  }
  const mean = new Float64Array(m).fill(NaN), std = new Float64Array(m).fill(NaN), sem = new Float64Array(m).fill(NaN);
  for (let k = 0; k < m; k++) if (count[k] > 0) mean[k] = sum[k] / count[k];
  for (const i of idx) { const ix = binOf(x[i], ex, nx), iy = binOf(y[i], ey, ny); if (ix < 0 || iy < 0) continue; const k = iy * nx + ix, d = resid[i] - mean[k]; sq[k] += d * d; }
  for (let k = 0; k < m; k++) if (count[k] > 1) { std[k] = Math.sqrt(sq[k] / (count[k] - 1)); sem[k] = std[k] / Math.sqrt(count[k]); }
  return { grid, mean, count, std, sem, xc: centresOf(x0, x1, nx), yc: centresOf(y0, y1, ny), nUsed, nOutside: idx.length - nUsed };
}
const edgesOf = (a, b, n) => { const e = new Float64Array(n + 1), s = (b - a) / n; for (let i = 0; i <= n; i++) e[i] = a + i * s; e[n] = b; return e; };
const centresOf = (a, b, n) => { const c = new Float64Array(n), s = (b - a) / n; for (let i = 0; i < n; i++) c[i] = a + (i + 0.5) * s; return c; };
function binOf(v, e, n) {
  if (!(v >= e[0] && v <= e[n])) return -1;
  let i = Math.min(n - 1, Math.max(0, Math.floor((v - e[0]) / (e[n] - e[0]) * n)));
  while (i > 0 && v < e[i]) i--; while (i < n - 1 && v >= e[i + 1]) i++;
  return i;
}

/** Sample fn(x, y) at the bin centres of a pixelMap grid. mask (e.g. the map's count): bins where it is 0 give NaN. */
export function surfaceOnGrid(fn, grid, mask = null) {
  const { nx, ny } = grid, xc = centresOf(grid.x0, grid.x1, nx), yc = centresOf(grid.y0, grid.y1, ny), out = new Float64Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) { const k = iy * nx + ix; out[k] = mask && !(mask[k] > 0) ? NaN : fn(xc[ix], yc[iy]); }
  return out;
}

/** Exponents (i, j) of x^i y^j with i + j <= order, by total degree: 1, x, y, x^2, xy, y^2, x^3, ... */
export function polyTerms(order) { const t = []; for (let d = 0; d <= order; d++) for (let j = 0; j <= d; j++) t.push([d - j, j]); return t; }

/**
 * Least-squares 2-D polynomial through the residuals as a function of the centroid:
 *     s(x, y) = sum_k coef_k (x - xc)^i_k (y - yc)^j_k,   i + j <= order (1, 2 or 3; terms in polyTerms order),
 * with (xc, yc) the mean kept centroid (or opts.centre = [xc, yc]). Solved by Householder QR of the design
 * matrix in coordinates scaled to unit scatter (no normal equations), then converted back to pixels: the same
 * solution as numpy.linalg.lstsq on the columns (x - xc)^i (y - yc)^j.
 * @param keep  optional Uint8Array: points to fit (the surface is evaluated at all points)
 * @param opts  { centre: [xc, yc], grid (a pixelMap grid: adds `surface`), mask (see surfaceOnGrid) }
 * @returns { coef, coefErr (formal 1-sigma, from the residual variance with n - terms degrees of freedom),
 *            terms, xc, yc, order, evaluate(x, y), fitted (Float64Array, at every point), surface (on opts.grid),
 *            rmsBefore (kept residuals about their mean), rmsAfter (kept residuals minus the surface), n }
 *          or null when there are fewer kept points than terms or the centroids do not span a plane.
 */
export function polySurface(x, y, resid, order = 2, keep = null, opts = {}) {
  if (!(order >= 1 && order <= 3)) throw new Error('order must be 1, 2 or 3');
  const N = resid.length, idx = [], terms = polyTerms(order), K = terms.length;
  for (let i = 0; i < N; i++) if ((!keep || keep[i]) && Number.isFinite(resid[i]) && Number.isFinite(x[i]) && Number.isFinite(y[i])) idx.push(i);
  const n = idx.length; if (n < K + 1) return null;
  let xc = 0, yc = 0, sx = 0, sy = 0, rm = 0;
  for (const i of idx) { xc += x[i] / n; yc += y[i] / n; rm += resid[i] / n; }
  if (opts.centre) [xc, yc] = opts.centre;
  for (const i of idx) { sx += (x[i] - xc) ** 2 / n; sy += (y[i] - yc) ** 2 / n; } sx = Math.sqrt(sx); sy = Math.sqrt(sy);
  if (!(sx > 0) || !(sy > 0)) return null;
  // design matrix, column-major, with the right-hand side as an extra column
  const A = new Float64Array(n * (K + 1)), pw = (u, e) => (e === 0 ? 1 : e === 1 ? u : e === 2 ? u * u : u * u * u);
  idx.forEach((i, r) => { const u = (x[i] - xc) / sx, w = (y[i] - yc) / sy; for (let k = 0; k < K; k++) A[k * n + r] = pw(u, terms[k][0]) * pw(w, terms[k][1]); A[K * n + r] = resid[i]; });
  for (let k = 0; k < K; k++) {
    let nrm = 0; for (let r = k; r < n; r++) nrm += A[k * n + r] * A[k * n + r]; nrm = Math.sqrt(nrm);
    if (!(nrm > 1e-12 * Math.sqrt(n))) return null;
    const alpha = A[k * n + k] > 0 ? -nrm : nrm, v0 = A[k * n + k] - alpha; let vv = v0 * v0; for (let r = k + 1; r < n; r++) vv += A[k * n + r] * A[k * n + r];
    for (let c = k + 1; c <= K; c++) {
      let d = v0 * A[c * n + k]; for (let r = k + 1; r < n; r++) d += A[k * n + r] * A[c * n + r];
      d = 2 * d / vv; A[c * n + k] -= d * v0; for (let r = k + 1; r < n; r++) A[c * n + r] -= d * A[k * n + r];
    }
    A[k * n + k] = alpha;   // R's diagonal; the Householder vector below it is no longer needed
  }
  const R = (r, c) => A[c * n + r], cs = new Float64Array(K);
  for (let k = K - 1; k >= 0; k--) { let s = A[K * n + k]; for (let c = k + 1; c < K; c++) s -= R(k, c) * cs[c]; cs[k] = s / R(k, k); }
  let rss = 0; for (let r = K; r < n; r++) rss += A[K * n + r] * A[K * n + r];
  // covariance diagonal: s^2 (R^T R)^-1 = s^2 R^-1 R^-T
  const Ri = Array.from({ length: K }, () => new Float64Array(K));
  for (let c = 0; c < K; c++) { Ri[c][c] = 1 / R(c, c); for (let r = c - 1; r >= 0; r--) { let s = 0; for (let q = r + 1; q <= c; q++) s -= R(r, q) * Ri[q][c]; Ri[r][c] = s / R(r, r); } }
  const s2 = rss / Math.max(1, n - K), coef = new Float64Array(K), coefErr = new Float64Array(K);
  for (let k = 0; k < K; k++) { const sc = Math.pow(sx, terms[k][0]) * Math.pow(sy, terms[k][1]); let d = 0; for (let c = k; c < K; c++) d += Ri[k][c] * Ri[k][c]; coef[k] = cs[k] / sc; coefErr[k] = Math.sqrt(s2 * d) / sc; }
  const evaluate = (px, py) => { const u = px - xc, w = py - yc; let s = 0; for (let k = 0; k < K; k++) s += coef[k] * pw(u, terms[k][0]) * pw(w, terms[k][1]); return s; };
  const fitted = new Float64Array(N); for (let i = 0; i < N; i++) fitted[i] = evaluate(x[i], y[i]);
  let b = 0, a = 0; for (const i of idx) { b += (resid[i] - rm) ** 2; a += (resid[i] - fitted[i]) ** 2; }
  return { coef, coefErr, terms, xc, yc, order, evaluate, fitted, surface: opts.grid ? surfaceOnGrid(evaluate, opts.grid, opts.mask ?? null) : null, rmsBefore: Math.sqrt(b / n), rmsAfter: Math.sqrt(a / n), n };
}

/**
 * The Gaussian-process trend of gp.js (detrendWithCentroids: squared-exponential kernel in x and y,
 * hyperparameters by maximum marginal likelihood) sampled on a pixelMap grid, so the removed surface can be
 * drawn next to the binned data. The grid centres are appended to the inputs as points that are predicted but
 * not fitted, so the surface is conditioned on exactly the same points as the trend that is subtracted.
 * @param inputsXY  [x, y] centroid arrays (two inputs only: with time as a third input the trend is not a
 *                  function of position alone and has no 2-D map)
 * @param keep      optional Uint8Array of points to fit
 * @param grid      { x0, x1, y0, y1, nx, ny } (pixelMap(...).grid)
 * @param opts      gp.js options { maxHyper, maxCond, maxEvals } and mask (see surfaceOnGrid)
 * @returns { surface (ny * nx, includes the mean residual like `trend`), trend (GP mean at every point),
 *            evaluateGrid: the same as surface, hyper, lnL, rmsBefore, rmsAfter, nHyper, nCond, n, evals } or null
 *          (fewer than 10 usable points). Far from any centroid the surface returns to the mean residual.
 */
export function gpSurface(inputsXY, resid, keep, grid, opts = {}) {
  if (inputsXY.length !== 2) throw new Error('gpSurface needs exactly the x and y centroids');
  const N = resid.length, { nx, ny } = grid, G = nx * ny, xc = centresOf(grid.x0, grid.x1, nx), yc = centresOf(grid.y0, grid.y1, ny);
  const X = new Float64Array(N + G), Y = new Float64Array(N + G), r = new Float64Array(N + G), kp = new Uint8Array(N + G);
  for (let i = 0; i < N; i++) { X[i] = inputsXY[0][i]; Y[i] = inputsXY[1][i]; r[i] = resid[i]; kp[i] = keep ? keep[i] : 1; }
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) { const k = N + iy * nx + ix; X[k] = xc[ix]; Y[k] = yc[iy]; }
  const out = detrendWithCentroids([X, Y], r, kp, opts); if (!out) return null;
  const surface = out.trend.slice(N); if (opts.mask) for (let k = 0; k < G; k++) if (!(opts.mask[k] > 0)) surface[k] = NaN;
  return { surface, trend: out.trend.slice(0, N), hyper: out.hyper, lnL: out.lnL, rmsBefore: out.rmsBefore, rmsAfter: out.rmsAfter, nHyper: out.nHyper, nCond: out.nCond, n: out.n, evals: out.evals };
}

// ---------------------------------------------------------------------------------------------------------
// Synthetic series

/**
 * A K2-like series with a known intrapixel sensitivity, for the test and the plotting harness:
 *     flux = 1 - a ((x - xs)^2 + (y - ys)^2) + white noise
 * while the star drifts across the pixel and is reset every rollPeriod (sawtooth of amplitude `amp` pixels in x,
 * -0.35 amp in y), with a slow sinusoidal drift and centroid jitter on top.
 * @param o { n = 2880, dt = 1/48 (days: 30-minute cadence), rollPeriod = 5.88 / 24 (days), amp = 1, a = 0.012
 *            (per pixel^2), sigma = 2e-4, seed = 7, x0 = 10.3, y0 = 20.1 }
 * @returns { t, x, y, flux, resid (flux - 1), sys (the noiseless systematic, flux - 1), err, a, xs, ys, sigma, dt, rollPeriod }
 */
export function syntheticRollSeries(o = {}) {
  const { n = 2880, dt = 1 / 48, rollPeriod = 5.88 / 24, amp = 1, a = 0.012, sigma = 2e-4, seed = 7, x0 = 10.3, y0 = 20.1 } = o;
  const rng = makeRng(seed), t = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n), flux = new Float64Array(n), resid = new Float64Array(n), sys = new Float64Array(n), err = new Float64Array(n).fill(sigma), xs = x0 + 0.2, ys = y0 - 0.1;
  for (let i = 0; i < n; i++) {
    t[i] = i * dt; const ph = t[i] / rollPeriod - Math.floor(t[i] / rollPeriod) - 0.5;
    x[i] = x0 + amp * ph + 0.05 * Math.sin(TWO_PI * t[i] / 15) + 0.01 * rng.normal();
    y[i] = y0 - 0.35 * amp * ph + 0.15 * Math.sin(TWO_PI * t[i] / 11) + 0.01 * rng.normal();
    sys[i] = -a * ((x[i] - xs) ** 2 + (y[i] - ys) ** 2); resid[i] = sys[i] + sigma * rng.normal(); flux[i] = 1 + resid[i];
  }
  return { t, x, y, flux, resid, sys, err, a, xs, ys, sigma, dt, rollPeriod };
}
