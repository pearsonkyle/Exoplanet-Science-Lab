// Stellar mass and radius from spectroscopic parameters.
//
// Torres, Andersen & Gimenez (2010, A&ARv 18, 67), eqs. (3)-(4): polynomial
// calibration on detached eclipsing binaries,
//   log M = a1 + a2 X + a3 X^2 + a4 X^3 + a5 (log g)^2 + a6 (log g)^3 + a7 [Fe/H]
//   log R = b1 + b2 X + ...                                   X = log Teff - 4.1
// Scatter 0.027 dex in log M (6.4%) and 0.014 dex in log R (3.2%). Calibrated on
// stars above 0.6 Msun; for M dwarfs it is an extrapolation and is flagged as such.

const A = [1.5689, 1.3787, 0.4243, 1.139, -0.1425, 0.01969, 0.1010];
const B = [2.4427, 0.6679, 0.1771, 0.705, -0.21415, 0.02306, 0.04173];
export const TORRES_SCATTER = { logM: 0.027, logR: 0.014 };

export function torres(teff, logg, feh = 0) {
  const X = Math.log10(teff) - 4.1, g2 = logg * logg, g3 = g2 * logg;
  const f = (c) => c[0] + c[1] * X + c[2] * X * X + c[3] * X * X * X + c[4] * g2 + c[5] * g3 + c[6] * feh;
  return { mstar: Math.pow(10, f(A)), rstar: Math.pow(10, f(B)) };
}

/**
 * Estimate with uncertainties: the input errors are propagated numerically and
 * the calibration's own scatter is added in quadrature.
 */
export function estimateMassRadius({ teff, teffErr = 0, logg, loggErr = 0, feh = 0, fehErr = 0 }) {
  const c = torres(teff, logg, feh);
  const d = (k) => {
    const p = [[teff + (teffErr || 0), logg, feh], [teff, logg + (loggErr || 0), feh], [teff, logg, feh + (fehErr || 0)]].map((a) => torres(...a)[k] - c[k]);
    return Math.hypot(...p);
  };
  const LN10 = Math.LN10;
  return {
    mstar: c.mstar, mstarErr: Math.hypot(d('mstar'), c.mstar * LN10 * TORRES_SCATTER.logM),
    rstar: c.rstar, rstarErr: Math.hypot(d('rstar'), c.rstar * LN10 * TORRES_SCATTER.logR),
    extrapolated: c.mstar < 0.6 || teff < 3800 || teff > 10000,
  };
}
