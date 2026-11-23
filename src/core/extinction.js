// Interstellar extinction: the mean curve of Fitzpatrick (1999, PASP 111, 63) as a function of R_V = A_V / E(B-V).
// Ultraviolet (shortward of 2700 angstrom): the Fitzpatrick & Massa (1990) form with his coefficients; optical and
// infrared: a natural cubic spline through his anchor points, in inverse micron. test/sed.test.mjs compares it with the
// dust_extinction package's F99 (test/make_sed_reference.py), an independent implementation of the same paper.

const X0 = 4.596, GAMMA = 0.99, C3 = 3.23, C4 = 0.41;
/** k(lambda - V) = E(lambda - V) / E(B - V) in the ultraviolet, x = 1 / lambda [1/micron]. */
function fmUV(x, rv) {
  const c2 = -0.824 + 4.717 / rv, c1 = 2.03 - 3.007 * c2, x2 = x * x, d = x2 / ((x2 - X0 * X0) ** 2 + x2 * GAMMA * GAMMA);
  let k = c1 + c2 * x + C3 * d; if (x >= 5.9) { const y = x - 5.9; k += C4 * (0.5392 * y * y + 0.05644 * y * y * y); }
  return k;
}
/** Natural cubic spline: second derivatives at the knots. */
function spline(xs, ys) {
  const n = xs.length, y2 = new Float64Array(n), u = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) { const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]), p = sig * y2[i - 1] + 2; y2[i] = (sig - 1) / p; u[i] = (6 * ((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1])) / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p; }
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
  return (x) => { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] > x) hi = m; else lo = m; } const h = xs[hi] - xs[lo], a = (xs[hi] - x) / h, b = (x - xs[lo]) / h; return a * ys[lo] + b * ys[hi] + ((a * a * a - a) * y2[lo] + (b * b * b - b) * y2[hi]) * (h * h) / 6; };
}
const CURVES = new Map();
/**
 * A(lambda) / A_V at wavelength wl [micron] (0.1 to 30; beyond 3.3 micron the spline runs on toward zero at infinite
 * wavelength), for R_V (default 3.1).
 */
export function extinctionF99(wl, rv = 3.1) {
  let f = CURVES.get(rv);
  if (!f) {
    const xs = [0, 1e4 / 26500, 1e4 / 12200, 1e4 / 6000, 1e4 / 5470, 1e4 / 4670, 1e4 / 4110, 1e4 / 2700, 1e4 / 2600];
    const ys = [0 - rv, (0.26469 * rv) / 3.1 - rv, (0.82925 * rv) / 3.1 - rv,
      -4.22809e-1 + 1.0027 * rv + 2.13572e-4 * rv * rv - rv, -5.1354e-2 + 1.00216 * rv - 7.35778e-5 * rv * rv - rv, 7.00127e-1 + 1.00184 * rv - 3.32598e-5 * rv * rv - rv,
      1.19456 + 1.01707 * rv - 5.46959e-3 * rv * rv + 7.97809e-4 * rv ** 3 - 4.45636e-5 * rv ** 4 - rv, fmUV(1e4 / 2700, rv), fmUV(1e4 / 2600, rv)];
    f = spline(xs, ys); CURVES.set(rv, f);
  }
  const x = 1 / wl, k = x >= 1e4 / 2700 ? fmUV(x, rv) : f(x);
  return Math.max(0, (k + rv) / rv);
}
