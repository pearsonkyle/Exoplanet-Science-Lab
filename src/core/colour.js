// From a spectrum to a displayed colour: CIE 1931 XYZ tristimulus values, then sRGB.
//
// The colour-matching functions are the analytic multi-lobe fits of Wyman, Sloan & Shirley (2013, Journal of
// Computer Graphics Techniques 2(2), 1-11, section 2.2) to the CIE 1931 2-degree observer, so no table is shipped.
// Their error against the tabulated functions is reported in test/atmosphere.test.mjs (section 5). XYZ to linear sRGB uses the
// IEC 61966-2-1 matrix (D65 white), followed by the sRGB transfer curve.
//
// Wavelengths in nanometres here (colour science's unit); the spectrum may be in any unit per unit wavelength.

const lobe = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
/** x-bar, y-bar, z-bar at wavelength nm. */
export const cmfX = (nm) => 1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2);
export const cmfY = (nm) => 0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1);
export const cmfZ = (nm) => 1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8);

/**
 * XYZ of a spectrum. Either a function of wavelength in nm (integrated 360-830 nm in 1 nm steps), or samples
 * { nm: [], f: [] } (trapezoid rule over the samples that fall in the visible; needs coverage of 400-700 nm).
 */
export function spectrumToXYZ(spec) {
  let X = 0, Y = 0, Z = 0;
  if (typeof spec === 'function') {
    for (let nm = 360; nm <= 830; nm++) { const f = spec(nm), w = nm === 360 || nm === 830 ? 0.5 : 1; X += w * f * cmfX(nm); Y += w * f * cmfY(nm); Z += w * f * cmfZ(nm); }
  } else {
    const { nm, f } = spec;
    for (let i = 1; i < nm.length; i++) {
      const a = nm[i - 1], b = nm[i]; if (b < 360 || a > 830) continue;
      const h = 0.5 * (b - a);
      X += h * (f[i - 1] * cmfX(a) + f[i] * cmfX(b)); Y += h * (f[i - 1] * cmfY(a) + f[i] * cmfY(b)); Z += h * (f[i - 1] * cmfZ(a) + f[i] * cmfZ(b));
    }
  }
  return [X, Y, Z];
}

/** Chromaticity (x, y) of XYZ. */
export const chromaticity = ([X, Y, Z]) => [X / (X + Y + Z), Y / (X + Y + Z)];

/** XYZ to linear sRGB (may fall outside 0..1). */
export const xyzToLinearSRGB = ([X, Y, Z]) => [
  3.2406 * X - 1.5372 * Y - 0.4986 * Z,
  -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
  0.0557 * X - 0.2040 * Y + 1.0570 * Z,
];

/** The sRGB transfer curve for one linear component in 0..1. */
export const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * Bring a linear RGB triple into gamut keeping its hue: negative components are lifted by adding white
 * (desaturating toward the white point), then the triple is scaled so its largest component is `peak`.
 */
export function toGamut(rgb, peak = 1) {
  const lo = Math.min(...rgb), lifted = lo < 0 ? rgb.map((c) => c - lo) : rgb.slice(), hi = Math.max(...lifted);
  return hi > 0 ? lifted.map((c) => (c * peak) / hi) : [0, 0, 0];
}

/**
 * Colour of a spectrum for display: linear sRGB normalised to its brightest channel (`linear`), the encoded
 * triple in 0..1 (`srgb`), the chromaticity, and Y (luminance in the spectrum's units, for relative brightness).
 */
export function spectrumColour(spec) {
  const xyz = spectrumToXYZ(spec), linear = toGamut(xyzToLinearSRGB(xyz));
  return { xyz, xy: chromaticity(xyz), Y: xyz[1], linear, srgb: linear.map(srgbEncode) };
}

/** Colour of a blackbody at temperature T [K]. */
export function blackbodyColour(T) {
  return spectrumColour((nm) => 1 / (nm ** 5 * Math.expm1(1.438776877e7 / (nm * T))) * 1e15);
}

/**
 * Colour of a star's disc from centre to limb, for display: the intensity leaving a grey atmosphere in radiative
 * equilibrium, I(mu, lambda) = int B_lambda(T(tau)) exp(-tau / mu) dtau / mu with T^4 = 3/4 Teff^4 (tau + q(tau))
 * (the same model as greyProfile in ldest.js), turned into linear sRGB at each mu. The limb is dimmer and redder
 * because the line of sight ends higher, where the gas is cooler. Real stars depart from grey (lines, convection);
 * this gives the right sense and size of the effect, not a model atmosphere.
 * Returns { mu: Float64Array(n), rgb: Float32Array(3 n) } with the disc centre (mu = 1) scaled to a brightest channel of 1.
 */
export function stellarLimbColours(teff, n = 32) {
  const mu = new Float64Array(n), rgb = new Float32Array(3 * n), NT = 240, XMAX = 24, raw = [];
  const q = (tau) => 0.7104 - 0.1331 * Math.exp(-3.4488 * tau);
  for (let k = 0; k < n; k++) {
    mu[k] = 0.02 + (0.98 * k) / (n - 1);
    const xyz = spectrumToXYZ((nm) => {
      let s = 0;
      for (let i = 0; i <= NT; i++) { const x = (XMAX * i) / NT, tau = mu[k] * x, T = teff * Math.pow(0.75 * (tau + q(tau)), 0.25); s += (i === 0 || i === NT ? 1 : i % 2 ? 4 : 2) * Math.exp(-x) / (nm ** 5 * Math.expm1(1.438776877e7 / (nm * T))); }
      return s * 1e15;
    });
    raw.push(xyzToLinearSRGB(xyz).map((c) => Math.max(0, c)));
  }
  const peak = Math.max(...raw[n - 1]);
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) rgb[3 * k + c] = raw[k][c] / peak;
  return { mu, rgb };
}
