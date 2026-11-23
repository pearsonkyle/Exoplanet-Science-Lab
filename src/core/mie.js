// Mie scattering by a homogeneous sphere, and its average over a log-normal distribution of sizes.
// The algorithm is that of Bohren & Huffman (1983, Absorption and Scattering of Light by Small Particles, appendix A,
// BHMIE): the logarithmic derivative D_n(mx) by downward recurrence, the Riccati-Bessel functions of x by upward
// recurrence. Refractive index m = n + i k (k >= 0 absorbs). test/haze.test.mjs compares it with a calculation from
// scipy's spherical Bessel functions (test/make_haze_reference.py), which shares nothing with this recurrence.

/**
 * Efficiencies of a sphere with size parameter x = 2 pi r / wavelength and refractive index n + i k.
 * Returns { qext, qsca, qabs, g } (g: asymmetry parameter, the mean cosine of the scattering angle).
 */
export function mie(x, n, k = 0) {
  if (!(x > 0)) return { qext: 0, qsca: 0, qabs: 0, g: 0 };
  if (x < 0.02) {   // Rayleigh limit with its first correction left out: errors of order x^2
    const a = n * n - k * k, b = 2 * n * k, dr = a + 2, den = dr * dr + b * b, re = ((a - 1) * dr + b * b) / den, im = (b * dr - (a - 1) * b) / den;
    const qsca = (8 / 3) * x ** 4 * (re * re + im * im), qabs = 4 * x * im;
    return { qext: qsca + qabs, qsca, qabs, g: 0 };
  }
  const nstop = Math.floor(x + 4 * Math.cbrt(x) + 2), ymod = x * Math.hypot(n, k), nmx = Math.floor(Math.max(nstop, ymod)) + 15;
  // D_n(mx), complex, downward from zero at nmx
  const dre = new Float64Array(nmx + 1), dim = new Float64Array(nmx + 1), yr = x * n, yi = x * k, y2 = yr * yr + yi * yi;
  for (let j = nmx; j >= 1; j--) {
    const cr = (j * yr) / y2, ci = (-j * yi) / y2, tr = dre[j] + cr, ti = dim[j] + ci, t2 = tr * tr + ti * ti;   // j / y, then 1 / (D_j + j / y)
    dre[j - 1] = cr - tr / t2; dim[j - 1] = ci + ti / t2;
  }
  let psi0 = Math.cos(x), psi1 = Math.sin(x), chi0 = -Math.sin(x), chi1 = Math.cos(x);
  let qsca = 0, qext = 0, gs = 0, anr = 0, ani = 0, bnr = 0, bni = 0;
  const m2 = n * n + k * k;
  for (let j = 1; j <= nstop; j++) {
    const psi = ((2 * j - 1) / x) * psi1 - psi0, chi = ((2 * j - 1) / x) * chi1 - chi0;   // xi = psi - i chi
    // a_n = ((D/m + j/x) psi - psi1) / ((D/m + j/x) xi - xi1),  b_n = ((m D + j/x) psi - psi1) / ((m D + j/x) xi - xi1)
    const ar = (dre[j] * n + dim[j] * k) / m2 + j / x, ai = (dim[j] * n - dre[j] * k) / m2, br = dre[j] * n - dim[j] * k + j / x, bi = dre[j] * k + dim[j] * n;
    const div = (pr, pi) => {   // (p psi - psi1) / (p xi - xi1), p = pr + i pi
      const nr = pr * psi - psi1, ni = pi * psi, qr = pr * psi + pi * chi - psi1, qi = pi * psi - pr * chi + chi1, q2 = qr * qr + qi * qi;
      return [(nr * qr + ni * qi) / q2, (ni * qr - nr * qi) / q2];
    };
    const [a1, a2] = div(ar, ai), [b1, b2] = div(br, bi);
    qsca += (2 * j + 1) * (a1 * a1 + a2 * a2 + b1 * b1 + b2 * b2); qext += (2 * j + 1) * (a1 + b1);
    if (j > 1) gs += (((j - 1) * (j + 1)) / j) * (anr * a1 + ani * a2 + bnr * b1 + bni * b2);
    gs += ((2 * j + 1) / (j * (j + 1))) * (a1 * b1 + a2 * b2);
    anr = a1; ani = a2; bnr = b1; bni = b2; psi0 = psi1; psi1 = psi; chi0 = chi1; chi1 = chi;
  }
  qsca *= 2 / (x * x); qext *= 2 / (x * x);
  return { qext, qsca, qabs: qext - qsca, g: qsca > 0 ? (4 * gs) / (x * x * qsca) : 0 };
}

/** Linear interpolation of optical constants { wl, n, k } (wl ascending, micron) at one wavelength, in log wavelength and log k; held at the ends. */
export function refractiveIndex(optics, wl) {
  const w = optics.wl, N = w.length; if (wl <= w[0]) return [optics.n[0], optics.k[0]]; if (wl >= w[N - 1]) return [optics.n[N - 1], optics.k[N - 1]];
  let lo = 0, hi = N - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (w[mid] <= wl) lo = mid; else hi = mid; }
  const f = Math.log(wl / w[lo]) / Math.log(w[hi] / w[lo]), k0 = optics.k[lo], k1 = optics.k[hi];
  return [optics.n[lo] + f * (optics.n[hi] - optics.n[lo]), k0 > 0 && k1 > 0 ? Math.exp(Math.log(k0) + f * Math.log(k1 / k0)) : k0 + f * (k1 - k0)];
}

const GH = { x: [-2.0201828704560856, -0.9585724646138185, 0, 0.9585724646138185, 2.0201828704560856], w: [0.019953242059045913, 0.3936193231522412, 0.9453087204829419, 0.3936193231522412, 0.019953242059045913] };   // Gauss-Hermite, 5 points
const MEMO = new Map();
/**
 * Cross-sections of particles of one material at the wavelengths wl [micron], averaged over a log-normal distribution
 * of radii with median `radius` [micron] and width `sigma` (the standard deviation of ln r; 0: one size).
 * Returns { ext, sca: Float64Array (mean cross-sections in units of pi radius^2, so "efficiencies" of the median
 * particle), albedo, g }. Kept for the last few (material, radius, sigma, grid) asked for.
 */
export function particleOptics(optics, wl, radius, sigma = 0.4) {
  const key = `${optics.name}|${radius}|${sigma}|${wl.length}|${wl[0]}|${wl[wl.length - 1]}`; let r = MEMO.get(key); if (r) return r;
  const N = wl.length, ext = new Float64Array(N), sca = new Float64Array(N), albedo = new Float64Array(N), g = new Float64Array(N), pts = sigma > 0 ? GH.x.map((x, i) => [radius * Math.exp(Math.SQRT2 * sigma * x), GH.w[i] / Math.sqrt(Math.PI)]) : [[radius, 1]];
  for (let i = 0; i < N; i++) {
    const [n, k] = refractiveIndex(optics, wl[i]); let e = 0, s = 0, gg = 0;
    for (const [rad, w] of pts) { const q = mie((2 * Math.PI * rad) / wl[i], n, k), a = w * (rad / radius) ** 2; e += a * q.qext; s += a * q.qsca; gg += a * q.qsca * q.g; }
    ext[i] = e; sca[i] = s; albedo[i] = e > 0 ? s / e : 0; g[i] = s > 0 ? gg / s : 0;
  }
  r = { ext, sca, albedo, g }; if (MEMO.size > 12) MEMO.delete(MEMO.keys().next().value); MEMO.set(key, r);
  return r;
}
