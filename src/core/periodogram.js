// Periodic signals in transit-timing residuals.
//
//   lombScargle            generalised Lomb-Scargle periodogram (Zechmeister & Kuerster 2009): weighted,
//                          floating mean, on any frequency grid. Same numbers as astropy.timeseries.LombScargle.
//   frequencyGrid          astropy's autofrequency() rule, for comparisons with it
//   timingFrequencyGrid    the grid used for transit epochs (see "Frequency range" below)
//   falseAlarmProbability / falseAlarmLevel     Baluev (2008) analytic bound; also 'davies', 'naive', 'single'
//   bootstrapFalseAlarm    the same quantities by resampling the residuals
//   fitSinusoids           polynomial baseline + sinusoids by weighted least squares, linear at fixed periods,
//                          then the periods refined (Gauss-Newton) with a full covariance
//   timingPeriodogram      the sequence of EXOTIC's ephemeris_fitter.plot_periodogram: linear ephemeris ->
//                          residuals -> periodogram -> strongest period -> 1-sinusoid fit -> periodogram of what
//                          is left -> 2-sinusoid fit -> BIC comparison and a plain-language verdict
//
// Frequency range for transit epochs. Mid-transit times exist only at whole orbits, so the sampling is a
// lattice with step g epochs (g = greatest common divisor of the epoch differences, 1 in practice). On a
// lattice, frequencies f and 1/g - f give identical sinusoids at every sample: this is a true Nyquist limit,
// not the "average Nyquist" of irregular sampling. Everything that can be said about the data is inside
// 0 < f < 1/(2g) cycles per epoch, i.e. periods longer than 2g epochs; a physical signal with a shorter period
// appears at its alias inside that range. The default grid therefore runs from period 2g epochs (exclusive)
// up to twice the time span (longer periods are not distinguishable from curvature of the ephemeris), in
// steps of 1/(oversample * span) with oversample = 10. Periods are in epochs; multiply by the orbital period
// for days (the O-C is thousands of times smaller than the period, so a periodogram against time in days
// is the same curve with the axis rescaled).
//
// Normalisations (same definitions as astropy), with chi2_ref the chi-square about the weighted mean and
// chi2(f) that of the best sinusoid + mean at frequency f:
//   'standard'  1 - chi2(f)/chi2_ref            in [0, 1]   (default)
//   'model'     chi2_ref/chi2(f) - 1
//   'log'       ln(chi2_ref/chi2(f))
//   'psd'       (chi2_ref - chi2(f)) / 2
//
// Uncertainties everywhere come from the supplied error bars and are not rescaled by chi-square, like
// ephemeris.js. No DOM, no dependencies beyond ephemeris.js and the seeded generator in stats.js.

import { fitEphemeris } from './ephemeris.js';
import { makeRng } from './stats.js';

const TWO_PI = 2 * Math.PI;

/** ln Gamma(x), x > 0 (Lanczos, g = 7; relative error below 1e-14). */
export function gammaln(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x);
  x -= 1; let a = c[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(TWO_PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function invert(a) {
  // Gauss-Jordan with partial pivoting on a small symmetric matrix; null when singular
  const n = a.length, m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (!(Math.abs(m[p][c]) > 1e-11)) return null;   // columns are scaled to unit norm before this is called
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c]; if (f !== 0) for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j]; }
  }
  return m.map((row) => row.slice(n));
}

/** Weighted least squares on columns cols[j][i]; returns { coef, cov, chi2 } or null when the columns are degenerate. */
function wls(cols, y, w) {
  const k = cols.length, n = y.length, s = new Array(k);
  for (let j = 0; j < k; j++) { let v = 0; for (let i = 0; i < n; i++) v += w[i] * cols[j][i] * cols[j][i]; s[j] = Math.sqrt(v); if (!(s[j] > 0)) return null; }
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let r = 0; r < k; r++) {
    for (let i = 0; i < n; i++) b[r] += (w[i] * cols[r][i] * y[i]) / s[r];
    for (let c = r; c < k; c++) { let v = 0; for (let i = 0; i < n; i++) v += w[i] * cols[r][i] * cols[c][i]; A[r][c] = A[c][r] = v / (s[r] * s[c]); }
  }
  const C = invert(A); if (!C) return null;
  const coef = C.map((row, r) => row.reduce((acc, v, j) => acc + v * b[j], 0) / s[r]);
  const cov = C.map((row, r) => row.map((v, c) => v / (s[r] * s[c])));
  let chi2 = 0;
  for (let i = 0; i < n; i++) { let m = 0; for (let j = 0; j < k; j++) m += coef[j] * cols[j][i]; chi2 += w[i] * (y[i] - m) ** 2; }
  return { coef, cov, chi2 };
}

const weightsOf = (dy, n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = dy ? 1 / (dy[i] * dy[i]) : 1; return w; };

/**
 * Generalised Lomb-Scargle power at each frequency.
 * t, y: samples; dy: 1-sigma errors or null (equal weights); freqs: cycles per unit of t.
 * opt: { normalization: 'standard' | 'model' | 'log' | 'psd', fitMean: true }
 *   fitMean true  (default) the mean is a free parameter at every frequency (floating mean, "GLS")
 *   fitMean false           the weighted mean is subtracted once (classical Lomb-Scargle with weights)
 * Returns a Float64Array the length of freqs. Cost: freqs.length * t.length sine/cosine pairs.
 */
export function lombScargle(t, y, dy, freqs, opt = {}) {
  const n = t.length, norm = opt.normalization || 'standard', fitMean = opt.fitMean !== false;
  if (y.length !== n || (dy && dy.length !== n)) throw new Error('t, y and dy must have the same length');
  if (n < 3) throw new Error('a periodogram needs at least 3 points');
  const w = weightsOf(dy, n); let sw = 0, tm = 0, ym = 0;
  for (let i = 0; i < n; i++) { if (!(w[i] > 0) || !Number.isFinite(w[i]) || !Number.isFinite(y[i]) || !Number.isFinite(t[i])) throw new Error('every point needs a finite value and a positive uncertainty'); sw += w[i]; }
  for (let i = 0; i < n; i++) { w[i] /= sw; tm += w[i] * t[i]; ym += w[i] * y[i]; }
  const tc = new Float64Array(n), yc = new Float64Array(n); let YY = 0;
  for (let i = 0; i < n; i++) { tc[i] = t[i] - tm; yc[i] = y[i] - ym; YY += w[i] * yc[i] * yc[i]; }
  const out = new Float64Array(freqs.length);
  if (!(YY > 0)) return out;
  for (let j = 0; j < freqs.length; j++) {
    const om = TWO_PI * freqs[j]; let C = 0, S = 0, YC = 0, YS = 0, CC = 0, CS = 0;
    for (let i = 0; i < n; i++) {
      const a = om * tc[i], c = Math.cos(a), s = Math.sin(a), wc = w[i] * c;
      C += wc; S += w[i] * s; YC += wc * yc[i]; YS += w[i] * s * yc[i]; CC += wc * c; CS += wc * s;
    }
    let SS = 1 - CC;
    if (fitMean) { CC -= C * C; SS -= S * S; CS -= C * S; }
    const D = CC * SS - CS * CS; let p;
    // on a lattice the sine (or cosine) column can vanish exactly, e.g. at the Nyquist frequency: one-term fit
    if (D > 1e-12 * Math.max(CC * SS, 1e-300)) p = (SS * YC * YC + CC * YS * YS - 2 * CS * YC * YS) / (YY * D);
    else p = CC > SS ? (CC > 0 ? (YC * YC) / (YY * CC) : 0) : SS > 0 ? (YS * YS) / (YY * SS) : 0;
    p = Math.min(1, Math.max(0, p));
    out[j] = norm === 'standard' ? p : norm === 'model' ? p / (1 - p) : norm === 'log' ? -Math.log(1 - p) : 0.5 * p * YY * sw;
  }
  if (!['standard', 'model', 'log', 'psd'].includes(norm)) throw new Error(`unknown normalization "${norm}"`);
  return out;
}

/**
 * astropy's LombScargle.autofrequency(): df = 1/(samplesPerPeak * span), from minFrequency (default df/2)
 * to maxFrequency (default nyquistFactor * n / (2 span), the "average Nyquist" rule). For comparisons with astropy;
 * for transit epochs use timingFrequencyGrid.
 */
export function frequencyGrid(t, opt = {}) {
  let lo = Infinity, hi = -Infinity; for (const v of t) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = hi - lo; if (!(span > 0)) throw new Error('all samples are at the same time');
  const df = 1 / (span * (opt.samplesPerPeak ?? 5)), f0 = opt.minFrequency ?? 0.5 * df;
  const fmax = opt.maxFrequency ?? ((opt.nyquistFactor ?? 5) * 0.5 * t.length) / span;
  const nf = 1 + Math.round((fmax - f0) / df), out = new Float64Array(Math.max(1, nf));
  for (let i = 0; i < out.length; i++) out[i] = f0 + i * df;
  return out;
}

const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };

/**
 * Frequency grid for a timing series (see the header). x: epochs (whole numbers) or times.
 * opt: { oversample = 10, minPeriod, maxPeriod }  (periods in the unit of x)
 * Returns { freqs, df, span, lattice, nyquistPeriod, minPeriod, maxPeriod }.
 *   lattice        g, the step of the epoch lattice (null when x is not whole numbers)
 *   nyquistPeriod  2g; for non-integer x, twice the smallest spacing (only a guide there)
 * The grid stops strictly below 1/minPeriod, so the exactly degenerate Nyquist frequency is never evaluated.
 */
export function timingFrequencyGrid(x, opt = {}) {
  const s = Array.from(x).sort((a, b) => a - b), n = s.length, span = s[n - 1] - s[0];
  if (!(span > 0)) throw new Error('all transits are at the same epoch');
  let lattice = null, nyq;
  if (s.every(Number.isInteger)) { let g = 0; for (let i = 1; i < n; i++) g = gcd(g, s[i] - s[i - 1]); lattice = g; nyq = 2 * g; }
  else { let d = Infinity; for (let i = 1; i < n; i++) if (s[i] > s[i - 1]) d = Math.min(d, s[i] - s[i - 1]); nyq = 2 * d; }
  const minPeriod = Math.max(opt.minPeriod ?? nyq, lattice ? nyq : 0), maxPeriod = opt.maxPeriod ?? 2 * span;
  if (!(maxPeriod > minPeriod)) throw new Error('the longest period searched must exceed the shortest');
  const df = 1 / ((opt.oversample ?? 10) * span), f0 = 1 / maxPeriod, f1 = 1 / minPeriod;
  const nf = Math.max(2, Math.ceil((f1 - f0) / df - 1e-9)), freqs = new Float64Array(nf);
  for (let i = 0; i < nf; i++) freqs[i] = f0 + i * df;
  return { freqs, df, span, lattice, nyquistPeriod: nyq, minPeriod, maxPeriod };
}

// ---------------------------------------------------------------------------------------------- false alarms

function wvar(t, dy) {
  let sw = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < t.length; i++) { const w = dy ? 1 / (dy[i] * dy[i]) : 1; sw += w; s1 += w * t[i]; }
  const m = s1 / sw;
  for (let i = 0; i < t.length; i++) { const w = dy ? 1 / (dy[i] * dy[i]) : 1; s2 += w * (t[i] - m) ** 2; }
  return s2 / sw;
}
const gam = (N) => Math.sqrt(2 / N) * Math.exp(gammaln(N / 2) - gammaln((N - 1) / 2));

function fapSingle(z, N, norm) {
  const Nk = N - 3;
  if (norm === 'psd') return Math.exp(-z);
  if (norm === 'standard') return Math.pow(Math.max(0, 1 - z), 0.5 * Nk);
  if (norm === 'model') return Math.pow(1 + z, -0.5 * Nk);
  if (norm === 'log') return Math.exp(-0.5 * Nk * z);
  throw new Error(`unknown normalization "${norm}"`);
}
function tauDavies(z, N, W, norm) {
  const NH = N - 1, NK = N - 3;
  if (norm === 'psd') return W * Math.exp(-z) * Math.sqrt(z);
  if (norm === 'standard') return gam(NH) * W * Math.pow(Math.max(0, 1 - z), 0.5 * (NK - 1)) * Math.sqrt(0.5 * NH * z);
  if (norm === 'model') return gam(NK) * W * Math.pow(1 + z, -0.5 * NK) * Math.sqrt(0.5 * NK * z);
  return gam(NK) * W * Math.exp(-0.5 * z * (NK - 0.5)) * Math.sqrt(NK * Math.sinh(0.5 * z));
}

/**
 * Probability that pure noise produces a highest peak of at least z somewhere below fmax.
 * ctx: { t, dy (or null), fmax }   the sample positions, their errors, and the highest frequency SEARCHED
 * opt: { method: 'baluev' (default) | 'davies' | 'naive' | 'single', normalization: 'standard' }
 *   'baluev'  Baluev (2008) eq. 6 with the effective time span sqrt(4 pi var_w(t)): an upper limit that is
 *             close for small probabilities. Assumes white Gaussian noise and no spectral leakage.
 *   'davies'  the Davies bound it is built on (can exceed 1)
 *   'naive'   1 - (1 - p_single)^(fmax * span) independent frequencies
 *   'single'  the probability at one pre-chosen frequency (no search)
 * Same formulae as astropy 6.1 (false_alarm_probability), which the tests compare against.
 */
export function falseAlarmProbability(z, ctx, opt = {}) {
  const norm = opt.normalization || 'standard', method = opt.method || 'baluev', N = ctx.t.length;
  const fs = fapSingle(z, N, norm);
  if (method === 'single') return fs;
  if (method === 'naive') { let lo = Infinity, hi = -Infinity; for (const v of ctx.t) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return -Math.expm1(ctx.fmax * (hi - lo) * Math.log1p(-fs)); }
  const tau = tauDavies(z, N, ctx.fmax * Math.sqrt(4 * Math.PI * wvar(ctx.t, ctx.dy)), norm);
  if (method === 'davies') return fs + tau;
  if (method === 'baluev') return -Math.expm1(-tau) + fs * Math.exp(-tau);
  throw new Error(`unknown false-alarm method "${method}"`);
}

/** Power that noise exceeds with probability p (inverse of falseAlarmProbability on its falling branch). Same ctx and opt. */
export function falseAlarmLevel(p, ctx, opt = {}) {
  const norm = opt.normalization || 'standard';
  let lo = 0, hi = 1;
  if (norm !== 'standard') { while (falseAlarmProbability(hi, ctx, opt) > p && hi < 1e12) hi *= 2; }
  // the probability starts at 1 (z = 0), may rise first (davies), then falls to 0: bisect on the last crossing
  for (let i = 0; i < 200; i++) { const m = 0.5 * (lo + hi); if (falseAlarmProbability(m, ctx, opt) > p) lo = m; else hi = m; if (hi - lo < 1e-14 * Math.max(1, hi)) break; }
  return 0.5 * (lo + hi);
}

/**
 * False alarms by bootstrap: the (y, dy) pairs are shuffled with replacement over the fixed sample positions,
 * which destroys any periodicity but keeps the sampling and the noise distribution; the highest peak of each
 * shuffled series is recorded. opt: { n = 1000, seed = 1, normalization, fitMean }.
 * Returns { maxPowers (sorted Float64Array), fap(z), level(p) }. The smallest probability it can state is 1/n
 * (fap(z) is 0 above every resample; level(p) is NaN for p < 1/n).
 * Cost: n periodograms.
 */
export function bootstrapFalseAlarm(t, y, dy, freqs, opt = {}) {
  const nb = opt.n ?? 1000, rng = makeRng(opt.seed ?? 1), N = t.length, mx = new Float64Array(nb);
  const yb = new Float64Array(N), eb = dy ? new Float64Array(N) : null;
  for (let b = 0; b < nb; b++) {
    for (let i = 0; i < N; i++) { const s = rng.int(N); yb[i] = y[s]; if (eb) eb[i] = dy[s]; }
    const p = lombScargle(t, yb, eb, freqs, opt); let m = 0; for (let j = 0; j < p.length; j++) if (p[j] > m) m = p[j]; mx[b] = m;
  }
  mx.sort();
  const fap = (z) => { let lo = 0, hi = nb; while (lo < hi) { const m = (lo + hi) >> 1; if (mx[m] < z) lo = m + 1; else hi = m; } return 1 - lo / nb; };
  // a level needs at least one resample beyond it: probabilities below 1/n cannot be stated (NaN)
  const level = (p) => (p * nb < 1 - 1e-9 ? NaN : mx[Math.min(nb - 1, Math.max(0, Math.floor((1 - p) * nb)))]);
  return { maxPowers: mx, fap, level };
}

// ---------------------------------------------------------------------------------------------- sinusoid fits

/**
 * Polynomial baseline plus sinusoids:
 *   y(x) = sum_{j<=order} c_j x^j  +  sum_m [ S_m sin(2 pi x / P_m) + C_m cos(2 pi x / P_m) ]
 *        = ...                      +  sum_m A_m sin(2 pi x / P_m + phi_m)
 * x, y, dy: samples and 1-sigma errors (dy null: unit weights). periods: starting periods P_m, in the unit of x.
 * opt: { order = 0 (0 constant, 1 line, 2 parabola),
 *        refine = true   after the linear solution at the given periods, the periods are freed and the fit is
 *                        polished by Gauss-Newton; each period may move by at most one resolution element
 *                        (1/span in frequency) from where it started, so it stays on its periodogram peak }
 * Returns {
 *   n, order, refined (bool: the period refinement converged), iterations,
 *   k        free parameters counted: order + 1 + 2 per sinusoid, + 1 per refined period
 *   kLinear  order + 1 + 2 per sinusoid (the count EXOTIC/statsmodels use, period not counted)
 *   chi2, dof (n - k),
 *   poly: [c_0..c_order], polyErr          coefficients of x^j at x = 0 (so for epochs: T0, P, dP/dE / 2)
 *   terms: [{ period, periodErr, freq, freqErr, sin, cos, sinErr, cosErr, amp, ampErr, phase, phaseErr }]
 *            sin, cos, phase refer to x = 0; phase in radians in (-pi, pi]; periodErr is NaN when not refined.
 *            amp is sqrt(sin^2 + cos^2), which is biased upward when it is not well above its error.
 *   cov      covariance of the internal parameters [c'_0..c'_order, S'_1, C'_1, ..., f_1, ...] (centred, scaled x)
 *   model(x), periodic(x)   full model and the sinusoid part alone
 *   predict(x) -> { y, sigma, periodic, periodicSigma }   with 1-sigma from the full covariance (periods included)
 * }
 * Throws when there are too few points or the columns are degenerate (two equal periods, a period the sampling
 * cannot distinguish from the baseline).
 */
export function fitSinusoids(x, y, dy, periods, opt = {}) {
  const n = x.length, order = opt.order ?? 0, M = periods.length, kl = order + 1 + 2 * M, doRef = opt.refine !== false && M > 0;
  if (y.length !== n || (dy && dy.length !== n)) throw new Error('x, y and dy must have the same length');
  if (n < kl + (doRef ? M : 0) + 1) throw new Error(`need at least ${kl + (doRef ? M : 0) + 1} points for ${M} sinusoid${M === 1 ? '' : 's'} on this baseline`);
  const w = weightsOf(dy, n); let sw = 0, swx = 0, xlo = Infinity, xhi = -Infinity;
  for (let i = 0; i < n; i++) { sw += w[i]; swx += w[i] * x[i]; xlo = Math.min(xlo, x[i]); xhi = Math.max(xhi, x[i]); }
  const xm = swx / sw, span = xhi - xlo, xs = Math.max(span / 2, 1e-300);
  if (!(span > 0)) throw new Error('all samples are at the same position');
  const xc = Float64Array.from(x, (v) => v - xm);
  const polyCols = []; for (let j = 0; j <= order; j++) polyCols.push(Float64Array.from(xc, (v) => Math.pow(v / xs, j)));
  const build = (f) => { const cols = [...polyCols]; for (let m = 0; m < M; m++) { const om = TWO_PI * f[m]; cols.push(Float64Array.from(xc, (v) => Math.sin(om * v)), Float64Array.from(xc, (v) => Math.cos(om * v))); } return cols; };
  const full = (f, coef) => {   // linear columns plus the derivative of the model with respect to each frequency
    const cols = build(f);
    for (let m = 0; m < M; m++) { const S = coef[order + 1 + 2 * m], C = coef[order + 2 + 2 * m], sc = cols[order + 1 + 2 * m], cc = cols[order + 2 + 2 * m]; cols.push(Float64Array.from(xc, (v, i) => TWO_PI * v * (S * cc[i] - C * sc[i]))); }
    return cols;
  };
  let f = periods.map((p) => { if (!(p > 0) || !Number.isFinite(p)) throw new Error('periods must be positive'); return 1 / p; });
  const f0 = [...f];
  let sol = wls(build(f), y, w);
  if (!sol) throw new Error('the sinusoids cannot be separated from each other or from the baseline at these periods');
  let refined = false, it = 0;
  if (doRef) {
    const lim = 1 / span;
    for (it = 1; it <= 60; it++) {
      // Gauss-Newton step for the frequencies from the residuals of the current solution
      const cols = full(f, sol.coef), r = new Float64Array(n), lin = cols.slice(0, kl);
      for (let i = 0; i < n; i++) { let m = 0; for (let j = 0; j < kl; j++) m += sol.coef[j] * lin[j][i]; r[i] = y[i] - m; }
      const st = wls(cols, r, w); if (!st) break;
      let df = st.coef.slice(kl), ok = false, best = null, fn = f;
      for (let h = 0; h < 12 && !ok; h++) {
        fn = f.map((v, m) => Math.min(f0[m] + lim, Math.max(f0[m] - lim, v + df[m])));
        const tr = fn.every((v) => v > 0) ? wls(build(fn), y, w) : null;
        if (tr && tr.chi2 <= sol.chi2 * (1 + 1e-14)) { ok = true; best = tr; } else df = df.map((v) => v / 2);
      }
      if (!ok) { refined = it > 1; break; }
      const move = Math.max(...fn.map((v, m) => Math.abs(v - f[m]) * span)), gain = sol.chi2 - best.chi2;
      f = fn; sol = best;
      if (move < 1e-9 || gain < 1e-10 * Math.max(1, sol.chi2)) { refined = true; break; }
    }
    // a period pinned at the edge of its allowed range did not converge on a maximum
    if (f.some((v, m) => Math.abs(v - f0[m]) >= lim * (1 - 1e-9))) refined = false;
  }
  let cov = sol.cov, hasF = false;
  if (doRef && refined) { const stf = wls(full(f, sol.coef), y, w); if (stf) { cov = stf.cov; hasF = true; } else refined = false; }
  const coef = sol.coef, np = cov.length;
  const quad = (g) => { let v = 0; for (let a = 0; a < np; a++) if (g[a] !== 0) for (let b = 0; b < np; b++) v += g[a] * cov[a][b] * g[b]; return Math.sqrt(Math.max(0, v)); };
  // polynomial in raw x: c'_j ((x - xm)/xs)^j expanded
  const binom = (a, b) => { let v = 1; for (let i = 0; i < b; i++) v = (v * (a - i)) / (i + 1); return v; };
  const poly = [], polyErr = [];
  for (let j = 0; j <= order; j++) {
    const g = new Array(np).fill(0);
    for (let q = j; q <= order; q++) g[q] = (binom(q, j) * Math.pow(-xm, q - j)) / Math.pow(xs, q);
    poly.push(g.reduce((acc, v, a) => acc + (a <= order ? v * coef[a] : 0), 0)); polyErr.push(quad(g));
  }
  const terms = [];
  for (let m = 0; m < M; m++) {
    const iS = order + 1 + 2 * m, iC = iS + 1, iF = kl + m, S = coef[iS], C = coef[iC], amp = Math.hypot(S, C), fm = f[m], P = 1 / fm;
    const gA = new Array(np).fill(0), gP = new Array(np).fill(0), gF = new Array(np).fill(0);
    gA[iS] = amp > 0 ? S / amp : 1; gA[iC] = amp > 0 ? C / amp : 0;
    // phase about the centre, then moved to x = 0: phi0 = phi_c - 2 pi f xm
    if (amp > 0) { gP[iS] = -C / (amp * amp); gP[iC] = S / (amp * amp); }
    if (hasF) { gP[iF] = -TWO_PI * xm; gF[iF] = 1; }
    let ph = Math.atan2(C, S) - TWO_PI * fm * xm; ph -= TWO_PI * Math.round(ph / TWO_PI);
    const s0 = amp * Math.cos(ph), c0 = amp * Math.sin(ph);
    // errors of the x = 0 coefficients: s0 = S cos(d) + C sin(d), c0 = C cos(d) - S sin(d), d = 2 pi f xm
    const d = TWO_PI * fm * xm, gs = new Array(np).fill(0), gc = new Array(np).fill(0);
    gs[iS] = Math.cos(d); gs[iC] = Math.sin(d); gc[iC] = Math.cos(d); gc[iS] = -Math.sin(d);
    if (hasF) { gs[iF] = TWO_PI * xm * c0; gc[iF] = -TWO_PI * xm * s0; }
    const fe = hasF ? quad(gF) : NaN;
    terms.push({ period: P, periodErr: fe * P * P, freq: fm, freqErr: fe, sin: s0, cos: c0, sinErr: quad(gs), cosErr: quad(gc), amp, ampErr: quad(gA), phase: ph, phaseErr: amp > 0 ? quad(gP) : NaN });
  }
  const grad = (xv) => {   // gradients of the full model and of its periodic part with respect to the internal parameters
    const u = (xv - xm) / xs, v = xv - xm, g = new Array(np).fill(0), gp = new Array(np).fill(0); let yv = 0, pv = 0;
    for (let j = 0; j <= order; j++) { g[j] = Math.pow(u, j); yv += coef[j] * g[j]; }
    for (let m = 0; m < M; m++) {
      const iS = order + 1 + 2 * m, a = TWO_PI * f[m] * v, s = Math.sin(a), c = Math.cos(a);
      g[iS] = gp[iS] = s; g[iS + 1] = gp[iS + 1] = c; pv += coef[iS] * s + coef[iS + 1] * c;
      if (hasF) g[kl + m] = gp[kl + m] = TWO_PI * v * (coef[iS] * c - coef[iS + 1] * s);
    }
    return { g, gp, y: yv + pv, p: pv };
  };
  const k = kl + (hasF ? M : 0);
  return {
    n, order, refined: hasF, iterations: it, k, kLinear: kl, chi2: sol.chi2, dof: n - k, poly, polyErr, terms, cov,
    model: (xv) => grad(xv).y, periodic: (xv) => grad(xv).p,
    predict: (xv) => { const q = grad(xv); return { y: q.y, sigma: quad(q.g), periodic: q.p, periodicSigma: quad(q.gp) }; },
  };
}

/**
 * BIC with the noise scale left free (errors known only up to a common factor), the definition statsmodels
 * uses for WLS and therefore the one EXOTIC prints:  n ln(chi2) + n (1 + ln(2 pi / n)) - sum ln(1/err^2) + k ln n.
 * Differences between models are n ln(chi2_a / chi2_b) + (k_a - k_b) ln n. Compare with the fixed-error
 * BIC = chi2 + k ln n used elsewhere in this app: the two agree when the reduced chi-square is 1.
 */
export function bicScaled(chi2, n, k, errs) {
  let slw = 0; if (errs) for (let i = 0; i < n; i++) slw += -2 * Math.log(errs[i]);
  return n * Math.log(chi2) + n * (1 + Math.log(TWO_PI / n)) - slw + k * Math.log(n);
}

// ---------------------------------------------------------------------------------------------- the sequence

function peaksOf(freqs, power, sep, max) {
  const idx = [];
  for (let i = 0; i < power.length; i++) if ((i === 0 || power[i] >= power[i - 1]) && (i === power.length - 1 || power[i] > power[i + 1])) idx.push(i);
  idx.sort((a, b) => power[b] - power[a]);
  const out = [];
  for (const i of idx) { if (out.length >= max) break; if (out.every((j) => Math.abs(freqs[i] - freqs[j]) > sep)) out.push(i); }
  return out;
}

function refinePeak(x, y, dy, f, df, opt, flo, fhi) {
  // golden-section maximum of the power within one grid step either side, staying inside the grid
  const P = (v) => lombScargle(x, y, dy, [v], opt)[0], g = (Math.sqrt(5) - 1) / 2;
  let a = Math.max(f - df, flo), b = Math.min(f + df, fhi), c = b - g * (b - a), d = a + g * (b - a), pc = P(c), pd = P(d);
  for (let i = 0; i < 40; i++) { if (pc > pd) { b = d; d = c; pd = pc; c = b - g * (b - a); pc = P(c); } else { a = c; c = d; pc = pd; d = a + g * (b - a); pd = P(d); } }
  const fb = 0.5 * (a + b), pb = P(fb), p0 = P(f);
  return pb >= p0 ? { freq: fb, power: pb } : { freq: f, power: p0 };
}

const fmtP = (p) => (p >= 100 ? p.toFixed(0) : p >= 10 ? p.toFixed(1) : p.toFixed(2));
const fmtPct = (p) => `${+(100 * p).toPrecision(2)}%`;
const fmtFap = (p) => (p >= 0.0995 ? `${(100 * p).toFixed(0)}%` : p >= 0.00095 ? `${(100 * p).toPrecision(2)}%` : p > 0 ? `${p.toExponential(0).replace('e-', ' × 10^-')}` : '0');
const fmtAmp = (a, e) => (a * 1440 >= 1 ? `${(a * 1440).toFixed(2)} ± ${(e * 1440).toFixed(2)} min` : `${(a * 86400).toFixed(1)} ± ${(e * 86400).toFixed(1)} s`);
const strength = (d) => (d > 10 ? 'very strong' : d > 6 ? 'strong' : d > 2 ? 'positive' : 'not worth more than a mention');

/**
 * Search transit-timing residuals for periodic signals, in the manner of EXOTIC's plot_periodogram.
 *
 * epochs: whole orbit numbers; times, errs: mid-transit times and 1-sigma errors, days (Julian dates are fine:
 * times[0] is subtracted before anything is fitted).
 * opt: {
 *   order = 1          baseline: 1 linear ephemeris (EXOTIC), 2 quadratic (search on top of a period change)
 *   oversample = 10, minPeriod, maxPeriod     grid, see timingFrequencyGrid (periods in epochs)
 *   normalization = 'standard'
 *   fapLevels = [0.1, 0.01, 0.001]            levels drawn on the plot
 *   fapThreshold = 0.01                       a peak counts as significant below this (EXOTIC's "99% FAP")
 *   fapMethod = 'baluev'
 *   bootstrap = 0                             > 0: that many bootstrap periodograms for each stage (slow for large sets)
 *   seed = 1
 *   refine = true                             free the periods in the sinusoid fits
 *   countPeriods = true                       count each fitted period as a parameter in k, BIC and dof
 *                                             (false reproduces EXOTIC's count: 4 and 6 parameters)
 *   nPeaks = 5                                peaks listed per periodogram
 * }
 * Returns {
 *   n, order, tRef, period (days per epoch, from the baseline fit),
 *   epochs, errs, residuals      Float64Arrays; residuals = times - baseline ephemeris, days (what periodogram 1 saw)
 *   linear                       fitEphemeris(epochs, times, errs, 1)
 *   baseline                     fitEphemeris(..., order)   (=== linear when order is 1)
 *   grid                         from timingFrequencyGrid, without the freqs array, plus fmax
 *   periodograms: [pg1, pg2]     pg2 is of the residuals after the 1-sinusoid model (null if that fit failed)
 *     pg = { label, freq, period, power (Float64Arrays; period = 1/freq, descending), normalization,
 *            fapMethod, fapLevels: [{ fap, power }],
 *            peaks: [{ freq, period (epochs), periodDays, power, fap, fapBootstrap? }]   strongest first;
 *                   peaks[0] is refined between grid points; fap of the others is the probability for a
 *                   highest peak of that height, quoted for orientation only
 *            bootstrap: { n, levels: [{ fap, power }] } | undefined }
 *   models: [linear, sin1, sin2] (the last two null when they could not be fitted), each
 *     { key: 'linear'|'sin1'|'sin2', name, k, chi2, dof, redChi2, bic (chi2 + k ln n), bicScaled,
 *       t0, per, dPdE (0 unless order 2), err: { t0, per, dPdE },
 *       terms: [{ period, periodErr (epochs), periodDays, periodDaysErr, amp, ampErr (days), phase, phaseErr (rad, at epoch 0),
 *                 sin, cos, sinErr, cosErr (days), freq, freqErr }],
 *       refined, fit (the fitSinusoids result; null for the baseline) }
 *   best            index into models of the lowest bic
 *   bestScaled      the same with bicScaled
 *   deltaBic        [0, bic(sin1) - bic(linear), bic(sin2) - bic(linear)]  (NaN where missing)
 *   significant     peaks[0] of periodogram 1 has fap < fapThreshold (and fapBootstrap < fapThreshold when a bootstrap was run)
 *   significant2    the same for periodogram 2, and only if the first is
 *   recommended     index of the model to adopt: a sinusoid is taken only when its peak is significant AND it lowers
 *                   the BIC. The BIC alone prefers a sinusoid in most signal-free data sets, because it does not
 *                   know the period was searched for (see test/periodogram.test.mjs).
 *   nEff            (sum w)^2 / sum w^2, the number of equally weighted transits the error bars amount to
 *   fapThreshold
 *   verdict         one paragraph of plain language
 *   notes           [strings] caveats that apply (aliases, error bars too small, ...)
 *   curve(i, nPts = 400, pad = 0.04) -> { E, y, lo, hi }   model i minus the LINEAR ephemeris with its 1-sigma band,
 *                   days: the shape renderOC() takes as d.curve (null for a missing model; zeros for the linear one)
 * }
 */
export function timingPeriodogram(epochs, times, errs, opt = {}) {
  const n = epochs.length, order = opt.order ?? 1, norm = opt.normalization || 'standard', method = opt.fapMethod || 'baluev';
  const levels = opt.fapLevels || [0.1, 0.01, 0.001], thr = opt.fapThreshold ?? 0.01, lsOpt = { normalization: norm };
  if (n < 6) throw new Error('a timing periodogram needs at least 6 mid-transit times');
  const linear = fitEphemeris(epochs, times, errs, 1), base = order === 1 ? linear : fitEphemeris(epochs, times, errs, order);
  const tRef = times[0], E = Float64Array.from(epochs), sig = Float64Array.from(errs), y = Float64Array.from(times, (t) => t - tRef);
  const res = Float64Array.from(E, (_, i) => base.residual(i));
  const grid = timingFrequencyGrid(E, opt), freqs = grid.freqs, fmax = freqs[freqs.length - 1], ctx = { t: E, dy: sig, fmax };
  const period = Float64Array.from(freqs, (f) => 1 / f), per = base.per;
  const stage = (label, r) => {
    const power = lombScargle(E, r, sig, freqs, lsOpt), fapOf = (z) => Math.min(1, falseAlarmProbability(z, ctx, { normalization: norm, method }));
    const idx = peaksOf(freqs, power, 1 / grid.span, opt.nPeaks ?? 5);
    const peaks = idx.map((i, j) => { const pk = j === 0 ? refinePeak(E, r, sig, freqs[i], grid.df, lsOpt, freqs[0], fmax) : { freq: freqs[i], power: power[i] }; return { freq: pk.freq, period: 1 / pk.freq, periodDays: per / pk.freq, power: pk.power, fap: fapOf(pk.power) }; });
    const pg = { label, freq: freqs, period, power, normalization: norm, fapMethod: method, fapLevels: levels.map((p) => ({ fap: p, power: falseAlarmLevel(p, ctx, { normalization: norm, method }) })), peaks };
    if (opt.bootstrap > 0) {
      const b = bootstrapFalseAlarm(E, r, sig, freqs, { n: opt.bootstrap, seed: opt.seed ?? 1, normalization: norm });
      for (const p of peaks) p.fapBootstrap = b.fap(p.power);
      pg.bootstrap = { n: opt.bootstrap, levels: levels.map((p) => ({ fap: p, power: b.level(p) })) };
    }
    return pg;
  };
  const lnN = Math.log(n), cnt = opt.countPeriods !== false;
  const pack = (key, name, fit) => {
    const k = cnt ? fit.k : fit.kLinear, t0 = tRef + fit.poly[0];
    return {
      key, name, k, chi2: fit.chi2, dof: n - k, redChi2: fit.chi2 / (n - k), bic: fit.chi2 + k * lnN, bicScaled: bicScaled(fit.chi2, n, k, sig),
      t0, per: fit.poly[1], dPdE: order === 2 ? 2 * fit.poly[2] : 0, err: { t0: fit.polyErr[0], per: fit.polyErr[1], dPdE: order === 2 ? 2 * fit.polyErr[2] : 0 },
      terms: fit.terms.map((t) => ({ ...t, periodDays: t.period * fit.poly[1], periodDaysErr: t.periodErr * fit.poly[1] })), refined: fit.refined, fit,
    };
  };
  const models = [{
    key: 'linear', name: order === 2 ? 'Quadratic ephemeris' : 'Linear ephemeris', k: base.k, chi2: base.chi2, dof: base.dof, redChi2: base.chi2 / base.dof,
    bic: base.chi2 + base.k * lnN, bicScaled: bicScaled(base.chi2, n, base.k, sig), t0: base.t0, per: base.per, dPdE: base.dPdE, err: { ...base.err }, terms: [], refined: false, fit: null,
  }, null, null];
  const notes = [], pgs = [stage(order === 2 ? 'O − C (quadratic removed)' : 'O − C', res), null];
  const fitOpt = { order, refine: opt.refine !== false };
  try { models[1] = pack('sin1', '1 sinusoid', fitSinusoids(E, y, sig, [pgs[0].peaks[0].period], fitOpt)); } catch (e) { notes.push(`The 1-sinusoid model could not be fitted: ${e.message}.`); }
  if (models[1]) {
    const f1 = models[1].fit, r1 = Float64Array.from(E, (e, i) => y[i] - f1.model(e));
    pgs[1] = stage('O − C minus sinusoid 1', r1);
    try { models[2] = pack('sin2', '2 sinusoids', fitSinusoids(E, y, sig, [models[1].terms[0].period, pgs[1].peaks[0].period], fitOpt)); } catch (e) { notes.push(`The 2-sinusoid model could not be fitted: ${e.message}.`); }
  }
  const argmin = (key) => { let b = 0; models.forEach((m, i) => { if (m && m[key] < models[b][key]) b = i; }); return b; };
  const best = argmin('bic'), bestScaled = argmin('bicScaled'), deltaBic = models.map((m) => (m ? m.bic - models[0].bic : NaN));
  const sigOf = (p) => p.fap < thr && !(p.fapBootstrap >= thr);
  const pk = pgs[0].peaks[0], significant = sigOf(pk), baseName = order === 2 ? 'quadratic' : 'linear';
  const pk2 = pgs[1] ? pgs[1].peaks[0] : null, significant2 = !!pk2 && significant && sigOf(pk2);
  // what to adopt: a sinusoid needs both a significant peak and a lower BIC than the model without it
  const recommended = !significant || !models[1] || !(models[1].bic < models[0].bic) ? 0 : significant2 && models[2] && models[2].bic < models[1].bic ? 2 : 1;
  const bootTxt = (p) => (p.fapBootstrap === undefined ? '' : ` (bootstrap: ${p.fapBootstrap > 0 ? fmtFap(p.fapBootstrap) : `below ${fmtFap(1 / opt.bootstrap)}`})`);

  // ---- the verdict
  const s = [];
  s.push(`The strongest peak in the O − C periodogram is at ${fmtP(pk.period)} epochs (${fmtP(pk.periodDays)} d), with a false-alarm probability of ${fmtFap(pk.fap)}${bootTxt(pk)}: ${significant ? 'significant' : 'not significant'} at the ${fmtPct(thr)} level.`);
  if (models[1]) {
    const t = models[1].terms[0], d1 = -deltaBic[1];
    s.push(`A sinusoid there has amplitude ${fmtAmp(t.amp, t.ampErr)}.`);
    if (best === 0) s.push(`The BIC prefers the ${baseName} ephemeris alone (one sinusoid changes it by ${d1 >= 0 ? '−' : '+'}${Math.abs(d1).toFixed(1)}).`);
    else {
      s.push(`The BIC prefers the ${best}-sinusoid model over the ${baseName} ephemeris by ${(-deltaBic[best]).toFixed(1)} (${strength(-deltaBic[best])} evidence)${best === 2 ? `, and over one sinusoid by ${(models[1].bic - models[2].bic).toFixed(1)}` : ''}.`);
      if (best === 1 && models[2]) s.push(`A second sinusoid is not justified (BIC ${models[2].bic - models[1].bic >= 0 ? '+' : '−'}${Math.abs(models[2].bic - models[1].bic).toFixed(1)}).`);
    }
    if (best > 0 && !significant) s.push('That is not enough: the BIC does not know the period was searched for, and it prefers a sinusoid in most signal-free data sets like this one. Without a significant peak this is not a detection.');
    if (best === 0 && significant) s.push('The peak is formally significant but too weak to pay for the extra parameters.');
    if (best > 0 && significant) {
      if (best === 2 && !significant2) s.push(`The first signal passes both tests. The second (${fmtP(pk2.period)} epochs) does not: its peak has a false-alarm probability of ${fmtFap(pk2.fap)}${bootTxt(pk2)}, and the BIC alone is not a safe guide after a period search. Adopt one sinusoid.`);
      else if (best === 2) s.push(`Both signals pass both tests (second peak: ${fmtP(pk2.period)} epochs, false-alarm probability ${fmtFap(pk2.fap)}${bootTxt(pk2)}).`);
      else s.push('Both tests point to a real periodic timing variation.');
    }
  }
  if (models[0].redChi2 > 2 && bestScaled !== best) notes.push(`The ${baseName} ephemeris has a reduced chi-square of ${models[0].redChi2.toFixed(1)}, so the error bars may be too small; with the noise level left free the BIC prefers the ${models[bestScaled].name.toLowerCase()} instead.`);
  else if (models[best].redChi2 > 2) notes.push(`The preferred model still has a reduced chi-square of ${models[best].redChi2.toFixed(1)}: the error bars may be too small, which inflates every BIC difference here.`);
  let sw = 0, sw2 = 0; for (const e of sig) { sw += 1 / (e * e); sw2 += 1 / e ** 4; }
  const nEff = (sw * sw) / sw2;
  if (nEff < 0.5 * n) notes.push(`The error bars are very unequal: the fit is carried by the equivalent of ${nEff.toFixed(0)} of the ${n} transits. The analytic false-alarm probability is only as good as those error bars${opt.bootstrap > 0 ? '' : '; the bootstrap option does not depend on them being Gaussian'}.`);
  const mAfter = models[Math.max(1, recommended)];
  if (!(opt.bootstrap > 0) && significant && mAfter && mAfter.redChi2 > 1.5) notes.push(`The scatter left after the ${mAfter.name.toLowerCase()} model is larger than the error bars allow (reduced chi-square ${mAfter.redChi2.toFixed(1)}). The analytic false-alarm probability is then too optimistic; check it with the bootstrap option.`);
  for (const [i, p] of [[1, pk], [2, pk2]]) if (p && p.fapBootstrap !== undefined && p.fap < thr && p.fapBootstrap >= thr) notes.push(`Peak ${i}: the analytic false-alarm probability (${fmtFap(p.fap)}) and the bootstrap (${fmtFap(p.fapBootstrap)}) disagree; the bootstrap is used. This happens when the scatter is not Gaussian within the error bars, or when a signal is still in the residuals being shuffled.`);
  if (grid.lattice) notes.push(`Transits sample whole orbits only, so a signal with period p epochs is indistinguishable from one with period 1/(${grid.lattice === 1 ? '1' : `1/${grid.lattice}`} − 1/p); periods below ${grid.nyquistPeriod} epochs cannot be searched.`);
  if (models[1] && !models[1].refined && fitOpt.refine) notes.push('The period of the first sinusoid could not be refined; its uncertainty is not available.');
  if (pk.period > grid.span) notes.push(`The strongest period is longer than the ${grid.span} epochs observed: it cannot be told apart from a slow change of the orbital period.`);
  if (method === 'baluev') notes.push('False-alarm probabilities use Baluev\'s approximation for white Gaussian noise; the residuals have already had an ephemeris removed, which makes it slightly conservative.');

  const linRel = (e) => (linear.t0 - tRef) + linear.per * e;
  const curve = (i, nPts = 400, pad = 0.04) => {
    const m = models[i]; if (!m) return null;
    let e0 = Infinity, e1 = -Infinity; for (const e of E) { e0 = Math.min(e0, e); e1 = Math.max(e1, e); }
    const p = pad * (e1 - e0); e0 -= p; e1 += p;
    const out = { E: new Float64Array(nPts), y: new Float64Array(nPts), lo: new Float64Array(nPts), hi: new Float64Array(nPts) };
    for (let j = 0; j < nPts; j++) {
      const e = e0 + ((e1 - e0) * j) / (nPts - 1); out.E[j] = e; let v, sg;
      if (m.fit) { const q = m.fit.predict(e); v = q.y - linRel(e); sg = q.sigma; }
      else { const q = base.predict(e); v = (q.t - tRef) - linRel(e); sg = q.sigma; }
      out.y[j] = v; out.lo[j] = v - sg; out.hi[j] = v + sg;
    }
    return out;
  };
  const { freqs: _f, ...g } = grid;
  return {
    n, order, tRef, period: per, epochs: E, errs: sig, residuals: res, linear, baseline: base, grid: { ...g, fmax, nf: freqs.length },
    periodograms: pgs, models, best, bestScaled, recommended, deltaBic, significant, significant2, nEff, fapThreshold: thr, verdict: s.join(' '), notes, curve,
  };
}
