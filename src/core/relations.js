// Published relations used to estimate a value a catalogue does not give. No DOM.
//
// Every relation has an entry in RELATIONS with its citation, what it needs and where it holds; the functions
// return plain numbers (NaN outside the range of validity unless stated) and the gap filler in
// src/core/sources/fill.js attaches the entry to each estimate so that a page can say what a number came from.
// Tested in test/relations.test.mjs against test/relations_reference.json (test/make_relations_reference.py:
// the forecaster package's posterior, astropy constants and units, numpy interpolation of the original table).
//
// Units follow the catalogue code: planet masses and radii in Jupiter units unless a name says Earth, stellar
// ones in solar units, periods and durations in days, angles in degrees, a in au, K in m/s.

import { C } from './derive.js';

const DEG = Math.PI / 180, fin = Number.isFinite;
/** Jupiter in Earth units, from the IAU 2015 nominal values (equatorial radii; GM ratio). */
export const RJUP_REARTH = C.Rjup / C.Rearth;                       // 11.2089
export const MJUP_MEARTH = 317.82838;                               // GM_Jup / GM_Earth, IAU 2015 nominal
const MSUN_MEARTH = 332946.0487;                                    // GM_Sun / GM_Earth, IAU 2015 nominal
const SIGMA_SB = 5.670374419e-8, LSUN = 3.828e26;                    // W m^-2 K^-4; IAU 2015 nominal solar luminosity [W]

export const RELATIONS = {
  ck17: {
    id: 'ck17', name: 'Mass-radius relation (Chen & Kipping 2017)',
    cite: 'Chen & Kipping 2017, ApJ 834, 17', url: 'https://ui.adsabs.harvard.edu/abs/2017ApJ...834...17C/abstract',
    formula: 'log10 R = C + S log10 M in four pieces (Terran, Neptunian, Jovian, Stellar), Table 2 (the published values)',
    valid: 'masses 3e-4 Mearth to 0.87 Msun. Radius to mass is only single-valued below 11.3 Rearth: above it a Neptunian, a Jovian and a low-mass star all fit',
  },
  otegi20: {
    id: 'otegi20', name: 'Mass-radius relation (Otegi et al. 2020)',
    cite: 'Otegi, Bouchy & Helled 2020, A&A 634, A43', url: 'https://ui.adsabs.harvard.edu/abs/2020A&A...634A..43O/abstract',
    formula: 'rocky (density above 3.3 g/cm^3): M = 0.90 R^3.45, R = 1.03 M^0.29; volatile-rich: M = 1.74 R^1.58, R = 0.70 M^0.63 (Earth units)',
    valid: 'M < 120 Mearth; the rocky branch up to about 25 Mearth (R < 2.2 Rearth or so), the volatile-rich one from about 5 Mearth',
  },
  pm13: {
    id: 'pm13', name: 'Mean dwarf sequence (Pecaut & Mamajek 2013)',
    cite: 'Pecaut & Mamajek 2013, ApJS 208, 9; online table version 2022.04.16', url: 'https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt',
    formula: 'radius, mass and luminosity of a main-sequence star interpolated in log Teff between the tabulated spectral types',
    valid: 'main-sequence stars only, 2350 K (M9.5V) to 10700 K (B9V). Wrong for subgiants and giants: needs log g > 4 or no log g at all',
  },
  torres10: {
    id: 'torres10', name: 'Mass and radius from Teff, log g, [Fe/H] (Torres et al. 2010)',
    cite: 'Torres, Andersen & Gimenez 2010, A&ARv 18, 67, eq. 4', url: 'https://ui.adsabs.harvard.edu/abs/2010A&ARv..18...67T/abstract',
    formula: 'polynomials in log Teff - 4.1, log g and [Fe/H] (src/core/stellar.js)',
    valid: 'calibrated on eclipsing binaries above 0.6 Msun; scatter 6% in mass, 3% in radius',
  },
  gravity: {
    id: 'gravity', name: 'Surface gravity', cite: 'g = G M / R^2', url: '',
    formula: 'M* = g R*^2 / G, R* = sqrt(G M* / g) or log g = log10(G M* / R*^2)', valid: 'exact; as good as its inputs',
  },
  kepler3: {
    id: 'kepler3', name: "Kepler's third law", cite: 'a^3 = G (M* + Mp) P^2 / 4 pi^2', url: '',
    formula: 'a = (G M P^2 / 4 pi^2)^(1/3); a/R* = a / R*', valid: 'exact for two bodies; the planet mass is included when known',
  },
  sb: {
    id: 'sb', name: 'Stefan-Boltzmann law', cite: 'L = 4 pi R^2 sigma Teff^4', url: '',
    formula: 'L/Lsun = (R/Rsun)^2 (Teff/5772 K)^4; insolation S/Searth = (L/Lsun) / (a/au)^2', valid: 'exact by definition of Teff',
  },
  teq: {
    id: 'teq', name: 'Equilibrium temperature', cite: 'e.g. Seager 2010, Exoplanet Atmospheres, eq. 3.9', url: '',
    formula: 'Teq = Teff sqrt(R*/a) [f (1 - A)]^(1/4) with Bond albedo A = 0 and f = 1/4 (heat spread over the whole planet)',
    valid: 'a definition, not a prediction of the real temperature; circular orbit (uses a, not the orbit-averaged distance)',
  },
  depth: {
    id: 'depth', name: 'Transit depth from the radii', cite: 'Seager & Mallen-Ornelas 2003, ApJ 585, 1038, eq. 1', url: 'https://ui.adsabs.harvard.edu/abs/2003ApJ...585.1038S/abstract',
    formula: 'depth = (Rp/R*)^2', valid: 'no limb darkening (the measured mid-transit depth is deeper), full (non-grazing) transit',
  },
  t14: {
    id: 't14', name: 'Transit duration from the geometry', cite: 'Winn 2010, in Exoplanets (ed. Seager), eqs. 14 and 16', url: 'https://ui.adsabs.harvard.edu/abs/2010exop.book...55W/abstract',
    formula: 'T14 = (P/pi) asin[ sqrt((1 + k)^2 - b^2) / (a/R* sin i) ] sqrt(1 - e^2) / (1 + e sin omega)',
    valid: 'exact for a circular orbit; for e > 0 the factor assumes constant speed during the transit',
  },
  impact: {
    id: 'impact', name: 'Impact parameter', cite: 'Winn 2010, eq. 7', url: 'https://ui.adsabs.harvard.edu/abs/2010exop.book...55W/abstract',
    formula: 'b = (a/R*) cos i (1 - e^2) / (1 + e sin omega)', valid: 'exact',
  },
  rvk: {
    id: 'rvk', name: 'Radial-velocity semi-amplitude', cite: 'e.g. Lovis & Fischer 2010, in Exoplanets (ed. Seager), eq. 14', url: 'https://ui.adsabs.harvard.edu/abs/2010exop.book...27L/abstract',
    formula: 'K = (2 pi G / P)^(1/3) Mp sin i / [(M* + Mp)^(2/3) sqrt(1 - e^2)]', valid: 'exact for two bodies',
  },
};

// ------------------------------------------------------------------------------------------------ planets

// Chen & Kipping (2017) Table 2: log10(R/Rearth) = C_k + S_k log10(M/Mearth); sigma_k is the intrinsic scatter in log10 R.
const CK = (() => {
  const S = [0.2790, 0.589, -0.044, 0.881], sig = [0.0403, 0.146, 0.0737, 0.0443];
  const T = [Math.log10(2.04), Math.log10(0.414 * MJUP_MEARTH), Math.log10(0.0800 * MSUN_MEARTH)];
  const Cc = [0.00346];
  for (let k = 1; k < 4; k++) Cc[k] = Cc[k - 1] + T[k - 1] * (S[k - 1] - S[k]);       // continuity at the transitions
  return { S, sig, T, C: Cc, names: ['Terran', 'Neptunian', 'Jovian', 'Stellar'] };
})();
/** Largest radius [Rearth] that Chen & Kipping's relation maps to one mass: the radius at the Jovian / Stellar transition. */
export const CK17_RMAX_SINGLE = 10 ** (CK.C[2] + CK.S[2] * CK.T[2]);
const CK_MMIN = 3e-4, CK_MMAX = 0.87 * MSUN_MEARTH;

/**
 * Chen & Kipping (2017) mean radius for a mass, both in Earth units.
 * Returns { value, sigmaLog (intrinsic scatter in log10 R), regime } or null outside 3e-4 Mearth to 0.87 Msun.
 */
export function radiusFromMassCK17(mEarth) {
  if (!(mEarth >= CK_MMIN && mEarth <= CK_MMAX)) return null;
  const x = Math.log10(mEarth), k = x < CK.T[0] ? 0 : x < CK.T[1] ? 1 : x < CK.T[2] ? 2 : 3;
  return { value: 10 ** (CK.C[k] + CK.S[k] * x), sigmaLog: CK.sig[k], regime: CK.names[k] };
}
/**
 * The inverse on the Terran and Neptunian branches: the mass [Mearth] whose mean radius is rEarth.
 * Returns { value, sigmaLog (scatter in log10 M: that of R divided by the slope), regime }, or null where the
 * relation is not single-valued (rEarth above CK17_RMAX_SINGLE = 11.3: hot Jupiters, brown dwarfs and small stars
 * share those radii) or below its range.
 */
export function massFromRadiusCK17(rEarth) {
  if (!(rEarth > 0) || rEarth > CK17_RMAX_SINGLE) return null;
  const y = Math.log10(rEarth), yT = CK.C[0] + CK.S[0] * CK.T[0], k = y < yT ? 0 : 1;
  const m = 10 ** ((y - CK.C[k]) / CK.S[k]);
  if (!(m >= CK_MMIN)) return null;
  return { value: m, sigmaLog: CK.sig[k] / CK.S[k], regime: CK.names[k] };
}

/** Otegi et al. (2020) eq. 1 and 2, Earth units. `rocky` picks the branch; by default rocky below 5 Mearth. NaN above 120 Mearth. */
export function radiusFromMassOtegi20(mEarth, rocky = mEarth < 5) {
  if (!(mEarth > 0 && mEarth <= 120)) return NaN;
  return rocky ? 1.03 * mEarth ** 0.29 : 0.70 * mEarth ** 0.63;
}
/** Otegi et al. (2020) inverse fits, Earth units. By default rocky below 1.8 Rearth (where their two populations separate at low mass). NaN when the mass would exceed 120 Mearth. */
export function massFromRadiusOtegi20(rEarth, rocky = rEarth < 1.8) {
  if (!(rEarth > 0)) return NaN;
  const m = rocky ? 0.90 * rEarth ** 3.45 : 1.74 * rEarth ** 1.58;
  return m <= 120 ? m : NaN;
}

// ------------------------------------------------------------------------------------------------ stars

// Mamajek's mean dwarf sequence, version 2022.04.16: [spectral type, Teff K, log10 L/Lsun, R/Rsun, M/Msun], B9V to M9.5V.
export const DWARF_SEQUENCE = [
  ['B9V', 10700, 1.86, 2.49, 2.75], ['B9.5V', 10400, 1.8, 2.45, 2.68], ['A0V', 9700, 1.58, 2.193, 2.18], ['A1V', 9300, 1.49, 2.136, 2.05], ['A2V', 8800, 1.38, 2.117, 1.98],
  ['A3V', 8600, 1.23, 1.861, 1.86], ['A4V', 8250, 1.13, 1.794, 1.93], ['A5V', 8100, 1.09, 1.785, 1.88], ['A6V', 7910, 1.05, 1.775, 1.83], ['A7V', 7760, 1, 1.75, 1.77],
  ['A8V', 7590, 0.96, 1.747, 1.81], ['A9V', 7400, 0.92, 1.747, 1.75], ['F0V', 7220, 0.86, 1.728, 1.61], ['F1V', 7020, 0.79, 1.679, 1.5], ['F2V', 6820, 0.71, 1.622, 1.46],
  ['F3V', 6750, 0.67, 1.578, 1.44], ['F4V', 6670, 0.62, 1.533, 1.38], ['F5V', 6550, 0.56, 1.473, 1.33], ['F6V', 6350, 0.43, 1.359, 1.25], ['F7V', 6280, 0.39, 1.324, 1.21],
  ['F8V', 6180, 0.29, 1.221, 1.18], ['F9V', 6050, 0.22, 1.167, 1.13], ['F9.5V', 5990, 0.18, 1.142, 1.08], ['G0V', 5930, 0.13, 1.1, 1.06], ['G1V', 5860, 0.08, 1.06, 1.03],
  ['G2V', 5770, 0.01, 1.012, 1], ['G3V', 5720, -0.01, 1.002, 0.99], ['G4V', 5680, -0.04, 0.991, 0.985], ['G5V', 5660, -0.05, 0.977, 0.98], ['G6V', 5600, -0.1, 0.949, 0.97],
  ['G7V', 5550, -0.13, 0.927, 0.95], ['G8V', 5480, -0.17, 0.914, 0.94], ['G9V', 5380, -0.26, 0.853, 0.9], ['K0V', 5270, -0.34, 0.813, 0.88], ['K1V', 5170, -0.39, 0.797, 0.86],
  ['K2V', 5100, -0.43, 0.783, 0.82], ['K3V', 4830, -0.55, 0.755, 0.78], ['K4V', 4600, -0.69, 0.713, 0.73], ['K5V', 4440, -0.76, 0.701, 0.7], ['K6V', 4300, -0.86, 0.669, 0.69],
  ['K7V', 4100, -1, 0.63, 0.64], ['K8V', 3990, -1.06, 0.615, 0.62], ['K9V', 3930, -1.1, 0.608, 0.59], ['M0V', 3850, -1.16, 0.588, 0.57], ['M0.5V', 3770, -1.27, 0.544, 0.54],
  ['M1V', 3660, -1.39, 0.501, 0.5], ['M1.5V', 3620, -1.44, 0.482, 0.47], ['M2V', 3560, -1.54, 0.446, 0.44], ['M2.5V', 3470, -1.64, 0.421, 0.4], ['M3V', 3430, -1.79, 0.361, 0.37],
  ['M3.5V', 3270, -2.03, 0.3, 0.27], ['M4V', 3210, -2.14, 0.274, 0.23], ['M4.5V', 3110, -2.4, 0.217, 0.184], ['M5V', 3060, -2.52, 0.196, 0.162], ['M5.5V', 2930, -2.79, 0.156, 0.123],
  ['M6V', 2810, -2.98, 0.137, 0.102], ['M6.5V', 2740, -3.1, 0.126, 0.093], ['M7V', 2680, -3.19, 0.12, 0.09], ['M7.5V', 2630, -3.24, 0.116, 0.088], ['M8V', 2570, -3.28, 0.114, 0.085],
  ['M8.5V', 2420, -3.47, 0.104, 0.08], ['M9V', 2380, -3.52, 0.102, 0.079], ['M9.5V', 2350, -3.57, 0.101, 0.078],
];

/**
 * A main-sequence star of this effective temperature on the mean dwarf sequence: { rstar, mstar, logL, sptype }.
 * Linear interpolation in log10 Teff (of log R, log M and log L) between the tabulated types; sptype is the nearer
 * one. Returns null outside 2350 to 10700 K.
 */
export function dwarfFromTeff(teff) {
  const T = DWARF_SEQUENCE, n = T.length;
  if (!(teff >= T[n - 1][1] && teff <= T[0][1])) return null;
  let i = 0;
  while (i < n - 2 && T[i + 1][1] > teff) i++;
  const a = T[i], b = T[i + 1], f = (Math.log10(teff) - Math.log10(a[1])) / (Math.log10(b[1]) - Math.log10(a[1]));
  const lerpLog = (k) => 10 ** (Math.log10(a[k]) + f * (Math.log10(b[k]) - Math.log10(a[k])));
  return { rstar: lerpLog(3), mstar: lerpLog(4), logL: a[2] + f * (b[2] - a[2]), sptype: f < 0.5 ? a[0] : b[0] };
}

/** Stellar mass [Msun] from log g (cgs) and radius [Rsun]. */
export const massFromLogg = (logg, rstar) => 10 ** logg / 100 * (rstar * C.Rsun) ** 2 / C.GMsun;
/** Stellar radius [Rsun] from log g (cgs) and mass [Msun]. */
export const radiusFromLogg = (logg, mstar) => Math.sqrt(C.GMsun * mstar / (10 ** logg / 100)) / C.Rsun;
/** log10 of the surface gravity (cgs) from mass [Msun] and radius [Rsun]. */
export const loggFromMassRadius = (mstar, rstar) => Math.log10(C.GMsun * mstar / (rstar * C.Rsun) ** 2 * 100);
/** Luminosity [Lsun] from radius [Rsun] and Teff [K] (IAU 2015 nominal solar values). */
export const luminosity = (rstar, teff) => 4 * Math.PI * (rstar * C.Rsun) ** 2 * SIGMA_SB * teff ** 4 / LSUN;

// ------------------------------------------------------------------------------------------------ orbit and transit

/** Semi-major axis [au] from the total mass [Msun] and the period [days]. */
export const semiMajorAxis = (mTotal, per) => Math.cbrt(C.GMsun * mTotal * (per * C.day) ** 2 / (4 * Math.PI * Math.PI)) / C.AU;
/** a/R* from a [au] and R* [Rsun]. */
export const scaledAxis = (aAU, rstar) => aAU * C.AU / (rstar * C.Rsun);
/** Rp/R* from Rp [Rjup] and R* [Rsun]. */
export const radiusRatio = (rpJup, rstar) => rpJup * C.Rjup / (rstar * C.Rsun);
/** Transit depth as a fraction, no limb darkening. */
export const transitDepth = (rprs) => rprs * rprs;
/** Insolation in units of the Earth's from Teff [K], R* [Rsun] and a [au]. */
export const insolation = (teff, rstar, aAU) => luminosity(rstar, teff) / (aAU * aAU);
/** Equilibrium temperature [K] for Bond albedo A and redistribution factor f (1/4: whole planet, 1/2: day side only). */
export const equilibriumTemperature = (teff, ars, albedo = 0, f = 0.25) => teff * Math.sqrt(1 / ars) * (f * (1 - albedo)) ** 0.25;
/** Impact parameter from a/R*, inclination, e and omega [deg]. */
export const impactParameter = (ars, inc, ecc = 0, omega = 0) => ars * Math.cos(inc * DEG) * (1 - ecc * ecc) / (1 + ecc * Math.sin(omega * DEG));
/** Inclination [deg] that gives impact parameter b; NaN when b is not reachable. */
export function inclinationFromImpact(ars, b, ecc = 0, omega = 0) {
  const c = b / ars * (1 + ecc * Math.sin(omega * DEG)) / (1 - ecc * ecc);
  return c >= 0 && c <= 1 ? Math.acos(c) / DEG : NaN;
}
/**
 * First-to-fourth-contact duration [days] (Winn 2010 eq. 14 with the eccentricity factor of eq. 16), from the
 * period, a/R*, Rp/R*, the impact parameter b and e, omega [deg]. 0 when (1 + k) <= b (no transit).
 */
export function transitDuration(per, ars, rprs, b = 0, ecc = 0, omega = 0) {
  const q = (1 + rprs) ** 2 - b * b;
  if (!(q > 0) || !(ars > 0)) return 0;
  const fac = (1 - ecc * ecc) / (1 + ecc * Math.sin(omega * DEG));                  // r_transit / a
  const cosI = b / (ars * fac), sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI));
  const x = Math.sqrt(q) / (ars * sinI);
  return per / Math.PI * Math.asin(Math.min(1, x)) * Math.sqrt(1 - ecc * ecc) / (1 + ecc * Math.sin(omega * DEG));
}
/** RV semi-amplitude [m/s] of the star. mp [Mjup] (true mass with inc, or M sin i with inc = 90), mstar [Msun], per [d], inc [deg]. */
export function rvSemiAmplitude(mp, mstar, per, ecc = 0, inc = 90) {
  const m = mp * C.Mjup_Msun;
  return Math.cbrt(2 * Math.PI * C.GMsun / (per * C.day)) * m * Math.sin(inc * DEG) / Math.pow(mstar + m, 2 / 3) / Math.sqrt(1 - ecc * ecc);
}
/** Planet mass [Mjup] (or M sin i with inc = 90) from K [m/s]: the inverse of rvSemiAmplitude. */
export function massFromRvAmplitude(K, mstar, per, ecc = 0, inc = 90) {
  let m = 0;
  for (let i = 0; i < 6; i++) m = K * Math.sqrt(1 - ecc * ecc) * Math.pow(mstar + m * C.Mjup_Msun, 2 / 3) / Math.cbrt(2 * Math.PI * C.GMsun / (per * C.day)) / C.Mjup_Msun / Math.sin(inc * DEG);
  return m;
}
/** Mean density [g/cm^3] of a planet of mass [Mjup] and radius [Rjup]. */
export const planetDensity = (mp, rp) => (mp * C.Mjup_Msun * C.GMsun / C.G) / (4 / 3 * Math.PI * (rp * C.Rjup) ** 3) / 1000;

export const _internals = { CK, fin };
