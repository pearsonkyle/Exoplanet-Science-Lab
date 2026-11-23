// Continuum opacity that needs no line list: Rayleigh scattering by H2, He and seven other gases, H- absorption, a
// power-law haze, a layer of particles (Kitzmann & Heng 2018) and a grey cloud deck. Cross-sections are in cm^2 (per molecule, or as stated), wavelengths in micron.
// Collision-induced absorption is tabulated, so it lives with the other tables in opacity.js.
//
// Sources, each coefficient checked against the petitRADTRANS 3.4.0 source (fortran_radtrans_core.f90, radtrans.py)
// and stated in test/atmosphere.test.mjs (section 4):
//   H2 Rayleigh   Dalgarno & Williams (1962, ApJ 136, 690): 8.14e-13 / l^4 + 1.28e-6 / l^6 + 1.61 / l^8, l in angstrom
//   He Rayleigh   128 pi^5 alpha^2 / (3 lambda^4) with the polarisability of Chan & Dalgarno (1965, Proc. Phys. Soc.
//                 85, 227) in units of 1.482e-25 cm^3: 2.265983321 - 3.721350022 l + 3.016150391 l^2 (l in micron)
//                 below 0.911 micron, 1.379 above
//   H- bound-free and free-free: the polynomial fits of Gray (2005, The Observation and Analysis of Stellar
//                 Photospheres, 3rd ed., eqs. 8.11-8.13) to Wishart (1979) and Bell & Berrington (1987). The plan
//                 named John (1988); Gray's fits are used because they could be checked against a second source.

import { particleOptics } from './mie.js';
import { OPTICAL } from './optical.js';

/** H2 Rayleigh cross-section [cm^2 per molecule]. */
export function rayleighH2(wl) { const a = wl * 1e4; return 8.14e-13 / a ** 4 + 1.28e-6 / a ** 6 + 1.61 / a ** 8; }

/** He Rayleigh cross-section [cm^2 per atom]. */
export function rayleighHe(wl) {
  const pol = (wl >= 0.911 ? 1.379 : 2.265983321 - 3.721350022 * wl + 3.016150391 * wl * wl) * 1.482e-25, cm = wl * 1e-4;
  return ((128 * Math.PI ** 5) / 3) * pol * pol / cm ** 4;
}

/**
 * H- bound-free cross-section [cm^2 per H- ion], zero beyond the photodetachment threshold at 1.64 micron.
 * Gray (2005) eq. 8.11: 1e-18 x a polynomial in the wavelength in angstrom.
 */
export function hMinusBoundFree(wl) {
  const a = wl * 1e4; if (!(a < 1.64e4)) return 0;
  const c = [1.99654, -1.18267e-5, 2.64243e-6, -4.40524e-10, 3.23992e-14, -1.39568e-18, 2.78701e-23];
  let s = 0; for (let i = c.length - 1; i >= 0; i--) s = s * a + c[i];
  return Math.max(0, s) * 1e-18;
}

/**
 * H- free-free absorption [cm^2 per neutral H atom per unit electron pressure in dyn cm^-2], Gray (2005) eq. 8.13.
 * Valid for 0.26-11.39 micron and T >= 2500 K; zero outside (as in petitRADTRANS).
 */
export function hMinusFreeFree(wl, T) {
  const a = wl * 1e4; if (!(a >= 2600 && a <= 113900) || !(T >= 2500)) return 0;
  const L = Math.log10(a), th = Math.log10(5040 / T);
  const f0 = -2.2763 - 1.6850 * L + 0.76661 * L * L - 0.053346 * L ** 3;
  const f1 = 15.2827 - 9.2846 * L + 1.99381 * L * L - 0.142631 * L ** 3;
  const f2 = -197.789 + 190.266 * L - 67.9775 * L * L + 10.6913 * L ** 3 - 0.625151 * L ** 4;
  return 1e-26 * 10 ** (f0 + f1 * th + f2 * th * th);
}

/**
 * Rayleigh scattering by the other gases, from the static dipole polarisability alone:
 * sigma = 128 pi^5 alpha^2 / (3 lambda^4). No dispersion (alpha grows a few per cent toward the blue) and no King
 * correction for anisotropy (1.00-1.15), so these run 5-25% under tabulated refractive-index values in the visible
 * (test/atmosphere.test.mjs has the comparison with petitRADTRANS). They matter where H2 is not the bulk gas.
 * Polarisabilities in 1e-24 cm^3: CRC Handbook of Chemistry and Physics, "Atomic and molecular polarizabilities".
 */
export const POLARISABILITY = { H2O: 1.45, CO2: 2.911, CO: 1.95, CH4: 2.593, N2: 1.7403, O2: 1.5812, NH3: 2.26 };
export function rayleighGas(species, wl) {
  const a = POLARISABILITY[species]; if (!a) return 0;
  const cm = wl * 1e-4; return ((128 * Math.PI ** 5) / 3) * (a * 1e-24) ** 2 / cm ** 4;
}

/**
 * Extinction efficiency of cloud or haze particles of radius r [micron] at wavelength wl [micron], the analytic fit
 * of Kitzmann & Heng (2018, MNRAS 475, 94, eq. 13) to Mie calculations over a size distribution:
 *   Q = 5 / (Q0 x^-4 + x^0.2),  x = 2 pi r / wl.
 * Small particles (x << 1) scatter as Rayleigh, Q = 5 x^4 / Q0; large ones are nearly grey, Q = 5 x^-0.2; the peak
 * lies between. Q0 depends on the material: about 10 for silicates and other refractory
 * condensates, up to 65 for ices and tholin-like hazes (their table 2 gives the range 9 to 65).
 */
export function particleQ(wl, r, q0 = 10) { const x = (2 * Math.PI * r) / wl; return 5 / (q0 * x ** -4 + x ** 0.2); }

/**
 * A layer of particles between two pressures: extinction [m^-1] of each layer, at each wavelength, into `out`.
 *   { top, base [bar], tau: vertical optical depth of the whole layer at `ref` micron (default 1), radius [micron],
 *     q0, albedo: single-scattering albedo (default 1, pure scattering),
 *     material: 'tholin' | null. With a material the wavelength dependence and the albedo are Mie theory's for spheres
 *       of that substance (src/core/mie.js, src/core/optical.js) with a log-normal spread of radii `sigma` (0.4) about
 *       `radius`; q0 and albedo are then not used,
 *     power: how the optical depth is spread between top and base, tau(< P) ~ P^power. 1 (default): a constant
 *       mixing ratio of particles. Below 1 the particles are relatively more abundant higher up (Titan's haze, whose
 *       scale height exceeds the gas's); above 1 they are settled toward the base }
 * `share`: 'scattering' takes the albedo's part of it, 'absorption' the rest.
 */
export function addParticleLayer(atm, wl, out, { top, base, tau = 1, radius = 0.1, q0 = 10, ref = 1, albedo = 1, material = null, sigma = 0.4, power = 1 }, share = 'both', onAdd = null) {
  const n = atm.n, nWl = wl.length, pt = top * 1e5, pb = Math.max(base, top * 1.0001) * 1e5;
  if (!(tau > 0)) return;
  radius = Math.max(radius, 1e-4);   // a radius of zero has no extinction to scale
  const rel = new Float64Array(nWl);   // extinction relative to the reference wavelength, times the share asked for
  if (material) {
    const optics = OPTICAL[material]; if (!optics) throw new Error('no optical constants for ' + material);
    const o = particleOptics(optics, wl, radius, sigma), r = particleOptics(optics, [ref], radius, sigma).ext[0];
    for (let i = 0; i < nWl; i++) rel[i] = (o.ext[i] / r) * (share === 'scattering' ? o.albedo[i] : share === 'absorption' ? 1 - o.albedo[i] : 1);
  } else {
    const f = share === 'scattering' ? albedo : share === 'absorption' ? 1 - albedo : 1, qRef = particleQ(ref, radius, q0);
    if (!(f > 0)) return;
    for (let i = 0; i < nWl; i++) rel[i] = (f * particleQ(wl[i], radius, q0)) / qRef;
  }
  const a = power > 0 ? power : 1, span = Math.pow(pb, a) - Math.pow(pt, a);
  for (let j = 0; j < n; j++) {
    const lo = Math.max(pt, atm.pLev[j]), hi = Math.min(pb, atm.pLev[j + 1]); if (!(hi > lo)) continue;
    const chi = (tau * (Math.pow(hi, a) - Math.pow(lo, a))) / span / atm.dr[j];   // at the reference wavelength
    for (let i = 0; i < nWl; i++) { const v = chi * rel[i]; if (v > 0) { out[i * n + j] += v; if (onAdd) onAdd(i, j, v); } }
  }
}

/**
 * Power-law haze as a cross-section per molecule of the whole gas [cm^2]: factor x sigma_H2(0.35 micron) x
 * (wl / 0.35)^slope. slope = -4 with factor = 1 is H2 Rayleigh scattering again (Lecavelier des Etangs et al. 2008).
 */
export const haze = (wl, { factor = 1, slope = -4 } = {}) => factor * rayleighH2(0.35) * Math.pow(wl / 0.35, slope);

/**
 * Continuum extinction of every layer at the wavelengths wl [micron], added into `out` (Float64Array(nWl * n), m^-1).
 *   rayleigh (true)   Rayleigh scattering of the gas (H2, He and the species of POLARISABILITY), counted as
 *                     extinction; a number multiplies it
 *   haze              { factor, slope }
 *   cloudTop [bar]    grey deck: layers whose centre lies at higher pressure get `cloudOpacity` m^-1 (default 1,
 *                     opaque over any path through a planet)
 *   hminus (true)     H- when the atmosphere carries 'H-' (bound-free) or both 'H' and 'e-' (free-free) mixing ratios
 *   cloud             a particle layer (addParticleLayer); cloudShare: 'scattering' | 'absorption' | 'both'
 * Returns { parts: { name: Float64Array } } when `parts` is true, the same extinction split by source.
 */
export function addContinuum(atm, wl, out, { rayleigh = true, haze: hz = null, cloudTop = null, cloudOpacity = 1, hminus = true, cloud = null, cloudShare = 'both', parts = false } = {}) {
  const n = atm.n, nWl = wl.length, CM2 = 1e-4, sp = atm.species, split = parts ? {} : null;
  const add = (name, i, j, v) => { out[i * n + j] += v; if (split) (split[name] ??= new Float64Array(nWl * n))[i * n + j] += v; };
  const rf = rayleigh === true ? 1 : Number(rayleigh) || 0;   // a number scales the gas's Rayleigh scattering (a haze of small particles)
  const others = rayleigh ? Object.keys(POLARISABILITY).filter((k) => sp[k]) : [];
  if (cloud) addParticleLayer(atm, wl, out, cloud, cloudShare, split ? (i, j, v) => { (split.particles ??= new Float64Array(nWl * n))[i * n + j] += v; } : null);
  for (let i = 0; i < nWl; i++) {
    const sO = others.map((k) => rf * rayleighGas(k, wl[i]) * CM2);
    const sH2 = rayleigh && sp.H2 ? rf * rayleighH2(wl[i]) * CM2 : 0, sHe = rayleigh && sp.He ? rf * rayleighHe(wl[i]) * CM2 : 0;
    const sHz = hz ? haze(wl[i], hz) * CM2 : 0, sBf = hminus && sp['H-'] ? hMinusBoundFree(wl[i]) * CM2 : 0;
    for (let j = 0; j < n; j++) {
      const nd = atm.nd[j];
      if (sH2 || sHe || sO.length) { let v = sH2 * (sp.H2 ? sp.H2[j] : 0) + sHe * (sp.He ? sp.He[j] : 0); for (let k = 0; k < sO.length; k++) v += sO[k] * sp[others[k]][j]; if (v) add('Rayleigh', i, j, nd * v); }
      if (sHz) add('haze', i, j, nd * sHz);
      if (sBf) add('H-', i, j, nd * sp['H-'][j] * sBf);
      if (hminus && sp.H && sp['e-']) {
        const pe = sp['e-'][j] * atm.pLay[j] * 10;   // electron pressure in dyn cm^-2
        const ff = hMinusFreeFree(wl[i], atm.tLay[j]) * CM2 * pe; if (ff) add('H-', i, j, nd * sp.H[j] * ff);
      }
      if (cloudTop != null && atm.pLay[j] > cloudTop * 1e5) add('cloud', i, j, cloudOpacity);
    }
  }
  return { parts: split };
}
