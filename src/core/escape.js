// Atmospheric escape driven by stellar extreme-ultraviolet light, as order-of-magnitude estimates:
// the energy-limited mass-loss rate, the crossover mass above which a species is left behind, the fractionation of
// what remains, and a time integral of both over the star's history.
//
// These are estimates, not a hydrodynamic model. Each rests on assumptions stated at its function; the mass-loss
// rate of a real planet differs from the energy-limited one by factors of a few to ten (the heating efficiency, the
// radius where the light is absorbed, recombination at high flux). Nothing here is fitted to data.
//
// SI units inside (kg, m, s, W m^-2); the functions take the page's units and say so.
//
// References
//   Watson, Donahue & Walker (1981, Icarus 48, 150): energy-limited escape
//   Erkaev et al. (2007, A&A 472, 329): the Roche-lobe factor K
//   Hunten, Pepin & Walker (1987, Icarus 69, 532); Zahnle & Kasting (1986, Icarus 68, 462): crossover mass and
//     the fractionation factor
//   Ribas et al. (2005, ApJ 622, 680): the Sun's XUV flux against age
//   Mason & Marrero (1970, Adv. At. Mol. Phys. 6, 155), as used by Zahnle & Kasting (1986), Genda & Ikoma (2008),
//     Hu, Seager & Yung (2015): binary diffusion coefficients of H with He, D, O
//   The energy-limited rate and absorption radius follow the owner's notes (github.com/pearsonkyle/
//   Exoplanet-Mass-Fractionation), whose table is reproduced in test/escape.test.mjs.

import { C } from './derive.js';

const K_B = 1.380649e-23, M_U = 1.66053906660e-27;
/** Atomic masses [amu] of what a hydrogen wind can carry. */
export const ATOM = { H: 1.008, D: 2.014, He: 4.0026, C: 12.011, N: 14.007, O: 15.999, Ne: 20.180, S: 32.06, Na: 22.990 };

/** Roche-lobe factor K <= 1 (Erkaev et al. 2007, eq. 17): xi = (a / Rp) (Mp / 3 M*)^(1/3), K = 1 - 3/(2 xi) + 1/(2 xi^3). */
export function rocheFactor({ a, rplanet, mplanet, mstar }) {   // a, rplanet in the same unit; masses in the same unit
  const xi = (a / rplanet) * Math.cbrt(mplanet / (3 * mstar));
  return { xi, K: xi > 1 ? 1 - 1.5 / xi + 0.5 / xi ** 3 : 0 };
}

/**
 * The Sun's XUV flux (1-1200 angstrom) at 1 AU against age [W m^-2]: 29.7 t^-1.23 erg cm^-2 s^-1 with t in Gyr (Ribas
 * et al. 2005, eq. 1, for solar analogues from 0.1 to 6.7 Gyr), held at its 0.1 Gyr value before that (saturation).
 * Other spectral types differ: M dwarfs stay bright for longer. Use a measured luminosity where there is one.
 */
export const solarXuv = (ageGyr) => 29.7e-3 * Math.pow(Math.max(ageGyr, 0.1), -1.23);

/**
 * Radius where the XUV light is absorbed [m]: where the column of atomic hydrogen has optical depth 1 for a
 * cross-section `sigma` (5e-22 m^2, hydrogen near 20 eV), in an isothermal atmosphere above the reference pressure:
 * p_xuv = m_H g / sigma, R_xuv = R + H ln(pRef / p_xuv).
 *   { rplanet [m], mplanet [kg], T [K], mu = 2.3, pRef = 10 bar, sigma [m^2] }
 */
export function xuvRadius({ rplanet, mplanet, T, mu = 2.3, pRef = 10, sigma = 5e-22 }) {
  const g = (C.G * mplanet) / (rplanet * rplanet), H = (K_B * T) / (mu * M_U * g), pXuv = (M_U * 1.00794 * g) / sigma;
  return { rxuv: rplanet + H * Math.log((pRef * 1e5) / pXuv), H, pXuv, g };
}

/**
 * Energy-limited mass-loss rate [kg/s]: Mdot = eta pi F_xuv R R_xuv^2 / (G M K) (Watson et al. 1981; Erkaev et al. 2007).
 * The stellar light caught by the disc pi R_xuv^2, a fraction eta of it lifting gas out of the potential G M / R,
 * lowered by the Roche factor K.
 *   { fxuv [W m^-2] at the planet, rplanet, rxuv [m], mplanet [kg], eta = 0.2, K = 1 }
 */
export function energyLimited({ fxuv, rplanet, rxuv = rplanet, mplanet, eta = 0.2, K = 1 }) {
  return (eta * Math.PI * fxuv * rplanet * rxuv * rxuv) / (C.G * mplanet * K);
}

/**
 * Binary diffusion coefficient times number density, b [m^-1 s^-1], of a species in atomic hydrogen.
 * Measured power laws for He, D, O (Mason & Marrero 1970): 1.04e18 T^0.732, 7.183e17 T^0.728, 4.8e17 T^0.75 cm^-1 s^-1.
 * Anything else (C, N, S, Na): the H-O value scaled by the reduced mass, sqrt((1/m_H + 1/m) / (1/m_H + 1/m_O)), as
 * kinetic theory has it for spheres of one size. Scaled that way from oxygen, helium comes out at 0.57 and deuterium at 0.92
 * of their measured values (test/escape.test.mjs): expect a factor of two.
 */
const B_FIT = { He: [1.04e18, 0.732], D: [7.183e17, 0.728], O: [4.8e17, 0.75] };
export function diffusionB(species, T) {
  const fit = B_FIT[species];
  return fit ? fit[0] * Math.pow(T, fit[1]) * 100 : diffusionScaled(ATOM[species] ?? species, T);
}
export const diffusionScaled = (m2, T) => B_FIT.O[0] * Math.pow(T, B_FIT.O[1]) * 100 * Math.sqrt((1 / ATOM.H + 1 / m2) / (1 / ATOM.H + 1 / ATOM.O));

/**
 * Crossover mass [amu] (Hunten, Pepin & Walker 1987, eq. 6): a species heavier than this is not carried off by the
 * hydrogen wind. m_c = m_H + k T F_H / (b g X_H), with F_H the flux of hydrogen atoms [m^-2 s^-1] at the radius
 * where g is taken, and X_H their mole fraction there.
 *   { mdot [kg/s], rplanet [m], mplanet [kg], T [K], species (for b), xH = 0.9 }
 * The wind is taken as atomic hydrogen leaving over the whole sphere 4 pi R^2.
 */
export function crossoverMass({ mdot, rplanet, mplanet, T, species = 'He', xH = 0.9, b = diffusionB(species, T) }) {
  const g = (C.G * mplanet) / (rplanet * rplanet), flux = mdot / (4 * Math.PI * rplanet * rplanet * ATOM.H * M_U);
  return { mc: ATOM.H + (K_B * T * flux) / (b * g * xH * M_U), flux, b, g };
}

/**
 * Fractionation factor of a species of mass m2 [amu]: its escape flux over hydrogen's, per unit of their mixing
 * ratio, x2 = (m_c - m2) / (m_c - m_H) for m2 < m_c, else 0 (Hunten et al. 1987, eq. 9). 1: lost with the hydrogen;
 * 0: all of it stays.
 */
export const fractionation = (m2, mc) => (mc > m2 ? (mc - m2) / (mc - ATOM.H) : 0);

/**
 * What is left after a share of the hydrogen has gone: with a constant fractionation factor x, the species' inventory
 * follows N2 / N2_0 = (N_H / N_H0)^x (Rayleigh distillation), so its abundance relative to hydrogen grows by f^(x - 1),
 * f the share of hydrogen remaining.
 */
export const enrichment = (fRemaining, x) => Math.pow(fRemaining, x - 1);

/**
 * The escape of a planet through its star's history, stepped in log time.
 *   { mplanet [M Jup], rplanet [R Jup], mstar [M sun], a [AU], T [K] of the upper atmosphere (the equilibrium
 *     temperature is the usual stand-in), ageGyr, t0Gyr = 0.01 (when the disc is gone),
 *     envelope: the share of the planet's mass that is hydrogen-helium gas (1 for a gas giant),
 *     eta = 0.2, lxuv: null | W (a measured XUV luminosity now; the Ribas law is then scaled to pass through it),
 *     fxuvOf: (ageGyr) => W m^-2 at 1 AU (overrides the law), species: names of ATOM to follow, steps = 200 }
 * Held fixed, and so not modelled: the planet's radius and mass (a young planet is larger and loses more; one that
 * loses much of its envelope shrinks), the heating efficiency, and the orbit. Read the result as "this much, give or
 * take a factor of several".
 * Returns { now: { fxuv, mdot, mc: {species}, x: {species}, K, rxuv }, lostMass [kg], lostShare (of the envelope),
 *           remaining (share of hydrogen left), enrich: { species: factor on its abundance relative to H },
 *           track: [{ t, fxuv, mdot, lost }] }.
 */
export function escapeHistory({ mplanet, rplanet, mstar, a, T, ageGyr, t0Gyr = 0.01, envelope = 1, eta = 0.2, lxuv = null, fxuvOf = null, species = ['He', 'D', 'C', 'N', 'O'], xH = 0.9, steps = 200 }) {
  const M = mplanet * C.Mjup_Msun * C.Msun, R = rplanet * C.Rjup, aM = a * C.AU;
  const { K } = rocheFactor({ a: aM, rplanet: R, mplanet: M, mstar: mstar * C.Msun }), { rxuv } = xuvRadius({ rplanet: R, mplanet: M, T });
  const scale = lxuv != null ? lxuv / (4 * Math.PI * C.AU * C.AU) / solarXuv(ageGyr) : 1;
  const at1AU = fxuvOf || ((t) => scale * solarXuv(t)), state = (t) => {
    const fxuv = at1AU(t) / (a * a), mdot = energyLimited({ fxuv, rplanet: R, rxuv, mplanet: M, eta, K }), mc = {}, x = {};
    for (const s of species) { mc[s] = crossoverMass({ mdot, rplanet: R, mplanet: M, T, species: s, xH }).mc; x[s] = fractionation(ATOM[s], mc[s]); }
    return { fxuv, mdot, mc, x };
  };
  const yr = 3.15576e7 * 1e9, env = envelope * M, lnH = { v: 0 }, lnS = Object.fromEntries(species.map((s) => [s, 0])), track = [];
  let lost = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0Gyr * Math.pow(ageGyr / t0Gyr, (i + 0.5) / steps), dt = t0Gyr * (Math.pow(ageGyr / t0Gyr, (i + 1) / steps) - Math.pow(ageGyr / t0Gyr, i / steps)) * yr;
    const s = state(t), left = Math.max(env - lost, 0), dm = Math.min(s.mdot * dt, left), d = left > 0 ? Math.log(Math.max(1 - dm / left, 1e-12)) : 0;
    lost += dm; lnH.v += d; for (const k of species) lnS[k] += s.x[k] * d;
    track.push({ t, fxuv: s.fxuv, mdot: s.mdot, lost });
  }
  const enrich = Object.fromEntries(species.map((k) => [k, Math.exp(lnS[k] - lnH.v)]));
  return { now: { ...state(ageGyr), K, rxuv }, lostMass: lost, lostShare: env > 0 ? lost / env : 0, remaining: Math.exp(lnH.v), enrich, track };
}
