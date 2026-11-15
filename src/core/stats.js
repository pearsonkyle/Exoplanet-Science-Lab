// Small numerical toolbox: seeded RNG, normal distribution helpers, weighted
// summaries. No dependencies.

/** Seeded generator (sfc32). next() is uniform in [0,1) with 53-bit resolution. */
export function makeRng(seed = 1) {
  let a = 0x9e3779b9 ^ seed, b = 0x243f6a88 ^ (seed * 2654435761), c = 0xb7e15162 ^ (seed >>> 3), d = 1;
  const u32 = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 20; i++) u32();
  let spare = null;
  const next = () => (u32() * 2097152 + (u32() >>> 11)) / 9007199254740992;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = 2 * next() - 1; v = 2 * next() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * f;
    return u * f;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, normal, int };
}

/** Inverse of the standard normal CDF (Acklam; relative error ~1e-9). */
export function ndtri(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Complementary error function (fractional error < 1.2e-7). */
export function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
export const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);

export function logAddExp(a, b) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
}

/** Weighted quantiles of x (weights need not be normalised). */
export function weightedQuantiles(x, w, qs) {
  const n = x.length, idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => x[i] - x[j]);
  let tot = 0; for (let i = 0; i < n; i++) tot += w[i];
  const out = new Array(qs.length);
  let acc = 0, k = 0;
  for (let j = 0; j < n && k < qs.length; j++) {
    acc += w[idx[j]];
    while (k < qs.length && acc >= qs[k] * tot) out[k++] = x[idx[j]];
  }
  while (k < qs.length) out[k++] = x[idx[n - 1]];
  return out;
}

export function weightedMeanStd(x, w) {
  let sw = 0, m = 0;
  for (let i = 0; i < x.length; i++) { sw += w[i]; m += w[i] * x[i]; }
  m /= sw;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += w[i] * (x[i] - m) ** 2;
  return [m, Math.sqrt(v / sw)];
}

/** Systematic resampling: indices of n equally weighted draws. */
export function resampleIndices(w, n, rng) {
  let tot = 0; for (let i = 0; i < w.length; i++) tot += w[i];
  const out = new Int32Array(n), step = tot / n;
  let u = rng.next() * step, acc = w[0], j = 0;
  for (let i = 0; i < n; i++) {
    while (acc < u && j < w.length - 1) acc += w[++j];
    out[i] = j; u += step;
  }
  return out;
}

/** Kolmogorov-Smirnov p-value that values in [0,1) are uniform. */
export function ksUniformP(v) {
  const n = v.length; if (n < 8) return 1;
  const s = Float64Array.from(v).sort();
  let D = 0;
  for (let i = 0; i < n; i++) D = Math.max(D, Math.abs((i + 1) / n - s[i]), Math.abs(s[i] - i / n));
  const lam = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * D;
  let p = 0;
  for (let j = 1; j <= 100; j++) p += 2 * (j % 2 ? 1 : -1) * Math.exp(-2 * j * j * lam * lam);
  return Math.min(1, Math.max(0, p));
}
