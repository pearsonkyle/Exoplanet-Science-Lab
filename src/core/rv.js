// Radial velocity of the star from the reflex motion of its planets.
//
// Same orbit as the transit model (kepler.js): u = omega + nu, mid-transit at u = pi/2,
// +Z toward the observer. The planet's line-of-sight velocity is
//     dZ/dt = (n a sin i / sqrt(1 - e^2)) [cos u + e cos omega]
// and the star moves the other way scaled by m_p / (M* + m_p). With velocities positive
// when the star recedes (the spectroscopic convention):
//     RV(t) = K [cos(omega + nu(t)) + e cos omega]
//     K = (2 pi G / P)^(1/3) m_p sin i / ((M* + m_p)^(2/3) sqrt(1 - e^2))
// so the star recedes before mid-transit and approaches after it.
//
// EXOTIC gets the same curve by differencing the planet's position numerically and scaling
// by mu = m_p / M* (not m_p / (M* + m_p)), with a/R* from the total mass: its amplitude is
// larger than the two-body value here by the factor 1 + m_p/M*.

import { solveKepler, trueAnomaly, meanAnomalyAtTransit } from './kepler.js';
import { C } from './derive.js';

const DEG = Math.PI / 180, TWO_PI = 2 * Math.PI;

/** Semi-amplitude K in m/s. per [d], inc [deg], mplanet [M Jup], mstar [M Sun]. */
export function semiAmplitude(per, ecc, inc, mplanet, mstar) {
  const mp = mplanet * C.Mjup_Msun, P = per * C.day;
  return Math.cbrt((TWO_PI * C.GMsun) / P) * (mp * Math.sin(inc * DEG)) / Math.pow(mstar + mp, 2 / 3) / Math.sqrt(1 - ecc * ecc);
}

/** Planet mass [M Jup] that gives semi-amplitude K [m/s] (inverse of semiAmplitude, by fixed-point iteration). */
export function massFromK(K, per, ecc, inc, mstar) {
  const P = per * C.day, c = Math.cbrt((TWO_PI * C.GMsun) / P) * Math.sin(inc * DEG) / Math.sqrt(1 - ecc * ecc);
  let mp = (K / c) * Math.pow(mstar, 2 / 3);
  for (let i = 0; i < 50; i++) { const next = (K / c) * Math.pow(mstar + mp, 2 / 3); if (Math.abs(next - mp) < 1e-15 * mp) { mp = next; break; } mp = next; }
  return mp / C.Mjup_Msun;
}

/** a/R* from Kepler's third law with the total mass. per [d], mstar [M Sun], mplanet [M Jup], rstar [R Sun]. */
export function arsFromKepler(per, mstar, mplanet, rstar) {
  const P = per * C.day, mu = C.GMsun * (mstar + (mplanet || 0) * C.Mjup_Msun);
  return Math.cbrt((mu * P * P) / (4 * Math.PI * Math.PI)) / (rstar * C.Rsun);
}

/**
 * Compile one planet's contribution: p = { per, tmid, ecc, omega (deg), K (m/s) }.
 * Returns rv(t) in m/s, without any zero point or trend.
 */
export function makeRV(p) {
  const e = Math.min(Math.max(p.ecc || 0, 0), 0.999), w = (p.omega || 0) * DEG, n = TWO_PI / p.per, K = p.K, tmid = p.tmid;
  if (e === 0) return (t) => K * Math.cos(Math.PI / 2 + n * (t - tmid));
  const M0 = meanAnomalyAtTransit(e, w), ecw = e * Math.cos(w);
  return (t) => K * (Math.cos(w + trueAnomaly(solveKepler(M0 + n * (t - tmid), e), e)) + ecw);
}
