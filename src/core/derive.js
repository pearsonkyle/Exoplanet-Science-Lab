// Derived system parameters, following the rows of Table 7 in Pearson et al.
// (2022, arXiv:2208.14520) plus a few extras. Pure functions of the model
// parameters and the stellar inputs, so they can be evaluated per posterior draw.

import { eventTimes } from './kepler.js';

export const C = {
  Rsun: 6.957e8, Rjup: 7.1492e7, Rearth: 6.3781e6, AU: 1.495978707e11,
  GMsun: 1.32712440018e20, Mjup_Msun: 9.545942e-4 /* IAU 2015 nominal GM_Jup / GM_Sun */, G: 6.6743e-11, Msun: 1.98841e30, day: 86400, TeffSun: 5772,
};

/**
 * v: model parameters {rprs, ars, inc, per, tmid, ecc, omega}
 * star: {rstar [Rsun], mstar [Msun], teff [K], mplanet [Mjup] or null}
 */
export function deriveSystem(v, star) {
  const DEG = Math.PI / 180, e = v.ecc || 0, w = (v.omega || 0) * DEG, inc = v.inc * DEG;
  const depth = v.rprs * v.rprs, kTrue = v.rprs;
  const ev = eventTimes(v);
  const aAU = (v.ars * star.rstar * C.Rsun) / C.AU;
  const P = v.per * C.day;
  const out = {
    rprs: v.rprs, depth,
    rpJup: (kTrue * star.rstar * C.Rsun) / C.Rjup, rpEarth: (kTrue * star.rstar * C.Rsun) / C.Rearth,
    per: v.per, tmid: v.tmid, t14: ev.t14, t23: ev.t23, emid: ev.tecl, e14: ev.e14, tperi: ev.tperi,
    inc: v.inc, ars: v.ars, aAU, ecc: e, omega: v.omega || 0,
    b: v.ars * Math.cos(inc) * (1 - e * e) / (1 + e * Math.sin(w)),
    bOcc: v.ars * Math.cos(inc) * (1 - e * e) / (1 - e * Math.sin(w)),
    rhoStar: (3 * Math.PI * v.ars ** 3) / (C.G * 1e3 * P * P) ,   // g/cm^3, circular-orbit photometric density
    // zero-albedo, full-redistribution equilibrium temperature at the semi-major axis
    teq: star.teff * Math.sqrt(1 / (2 * v.ars)),
    insol: (star.rstar * star.rstar * Math.pow(star.teff / C.TeffSun, 4)) / (aAU * aAU),  // Earth = 1
  };
  if (star.mstar > 0) {
    out.aKeplerAU = Math.cbrt((C.GMsun * star.mstar * P * P) / (4 * Math.PI * Math.PI)) / C.AU;
    out.arsKepler = (out.aKeplerAU * C.AU) / (star.rstar * C.Rsun);
    if (star.mplanet > 0) {
      const mp = star.mplanet * C.Mjup_Msun;
      out.K = Math.cbrt((2 * Math.PI * C.GMsun) / P) * (mp * Math.sin(inc)) / Math.pow(star.mstar + mp, 2 / 3) / Math.sqrt(1 - e * e);
      const rp = out.rpJup * C.Rjup;
      out.rhoPlanet = (star.mplanet * C.Mjup_Msun * C.Msun * 1e3) / ((4 / 3) * Math.PI * (rp * 100) ** 3);  // g/cm^3
    }
  }
  return out;
}

/** Size class used to pick the planet's appearance. */
export function planetClass(rpEarth, teq) {
  if (rpEarth < 1.6) return teq > 1500 ? { key: 'lava', label: 'lava world' } : { key: 'earth', label: 'Earth-size' };
  if (rpEarth < 3.5) return { key: 'subneptune', label: 'sub-Neptune' };
  if (rpEarth < 7) return { key: 'neptune', label: 'Neptune-size' };
  return { key: 'jupiter', label: 'Jupiter-size' };
}
