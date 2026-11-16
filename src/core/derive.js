// Derived system parameters, following the rows of Table 7 in Pearson et al.
// (2022, arXiv:2208.14520) plus a few extras. Pure functions of the model
// parameters and the stellar inputs, so they can be evaluated per posterior draw.

import { eventTimes } from './kepler.js';

// Constants: the nominal values of IAU 2015 Resolution B3 (Prsa et al. 2016, AJ 152, 41) for the Sun, Earth and
// Jupiter (R_sun, T_eff,sun, equatorial R_earth and R_jup, GM ratios), the IAU 2012 astronomical unit, CODATA 2018 G.
// GMsun is the DE value 1.32712440018e20 (the nominal one is rounded to 1.3271244e20: 1.4e-10 apart). Radii in "R_jup"
// and "R_earth" are equatorial ones throughout (the volumetric mean radius of Jupiter is 2.2% smaller, of Earth 0.1%).
// Msun = GMsun / G is only used for densities, where G cancels against the G in Kepler's law to 1e-5.
export const C = {
  Rsun: 6.957e8, Rjup: 7.1492e7, Rearth: 6.3781e6, AU: 1.495978707e11,
  GMsun: 1.32712440018e20, Mjup_Msun: 9.5459426398e-4 /* IAU 2015 nominal GM_Jup / GM_Sun = 1.26686534e17 / 1.32712440018e20 */, G: 6.6743e-11, Msun: 1.98841e30, day: 86400, TeffSun: 5772, c: 299792458, Mearth_Msun: 3.0034893e-6 /* IAU 2015 nominal GM_E / GM_S = 3.986004e14 / 1.3271244e20 */,
};

/**
 * v: model parameters {rprs, ars, inc, per, tmid, ecc, omega}
 * star: {rstar [Rsun], mstar [Msun], teff [K], mplanet [Mjup] or null, jmag, kmag (2MASS, optional)}
 *
 * Besides the rows of the paper's table:
 *   insolAvg     orbit-averaged insolation, insol / sqrt(1 - e^2) (the mean of 1/r^2 over time)
 *   teqPeri, teqApo   the same zero-albedo, full-redistribution temperature at periastron and apastron distance
 *   lttEclipse   seconds by which light-travel time delays mid-eclipse against the conjunction time `emid`
 *                (r_transit + r_eclipse) sin i / c: 2a/c for a circular orbit
 *   gp, loggp    surface gravity of the planet [m/s^2, log10 cgs] from its mass and radius. gpRV is the same from
 *                observables alone, 2 pi sqrt(1 - e^2) K / (P (Rp/a)^2 sin i) (Southworth et al. 2007), no stellar mass or radius
 *   hillAU, hillRp    Hill radius at periastron, a (1 - e) (Mp / 3 M*)^(1/3), in au and in planet radii
 *   rocheAU, rocheRatio   fluid Roche limit of the planet about its star, 2.44 R* (rho_star / rho_planet)^(1/3), and
 *                periastron distance over it (below 1 the planet would be losing mass); rho_star from M* and R*
 *   tsm, esm     transmission and emission spectroscopy metrics of Kempton et al. (2018, PASP 130, 114401), eqs. 1 and 4,
 *                with their T_eq (zero albedo, full redistribution) and T_day = 1.1 T_eq; tsm needs the mass, a radius
 *                under 10 R_earth and star.jmag; esm needs star.kmag. Outside 10 R_earth tsm uses the last scale factor
 *                and `tsmExtrapolated` is true.
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
  out.insolAvg = out.insol / Math.sqrt(1 - e * e);
  out.teqPeri = out.teq / Math.sqrt(1 - e); out.teqApo = out.teq / Math.sqrt(1 + e);
  if (star.rstar > 0) out.lttEclipse = (v.ars * (1 - e * e) * (1 / (1 + e * Math.sin(w)) + 1 / (1 - e * Math.sin(w))) * Math.sin(inc) * star.rstar * C.Rsun) / C.c;
  if (Number.isFinite(star.kmag) && star.teff > 0) {
    const B = (T) => 1 / Math.expm1(14387.768775 / (7.5 * T));   // Planck function at 7.5 micron up to a constant
    out.esm = 4.29e6 * (B(1.1 * out.teq) / B(star.teff)) * depth * Math.pow(10, -star.kmag / 5);
  }
  if (star.mstar > 0) {
    out.aKeplerAU = Math.cbrt((C.GMsun * star.mstar * P * P) / (4 * Math.PI * Math.PI)) / C.AU;
    out.arsKepler = (out.aKeplerAU * C.AU) / (star.rstar * C.Rsun);
    if (star.mplanet > 0) {
      const mp = star.mplanet * C.Mjup_Msun;
      out.K = Math.cbrt((2 * Math.PI * C.GMsun) / P) * (mp * Math.sin(inc)) / Math.pow(star.mstar + mp, 2 / 3) / Math.sqrt(1 - e * e);
      const rp = out.rpJup * C.Rjup;
      out.rhoPlanet = (star.mplanet * C.Mjup_Msun * C.Msun * 1e3) / ((4 / 3) * Math.PI * (rp * 100) ** 3);  // g/cm^3
      out.gp = (C.GMsun * mp) / (rp * rp); out.loggp = Math.log10(out.gp * 100);
      out.gpRV = (2 * Math.PI * Math.sqrt(1 - e * e) * out.K * v.ars * v.ars) / (P * kTrue * kTrue * Math.sin(inc));
      const aM = out.aKeplerAU * C.AU;
      out.hillAU = (aM * (1 - e) * Math.cbrt(mp / (3 * star.mstar))) / C.AU; out.hillRp = (out.hillAU * C.AU) / rp;
      // (rho_star / rho_planet)^(1/3) = (M* / Mp)^(1/3) Rp / R*
      out.rocheAU = (2.44 * rp * Math.cbrt(star.mstar / mp)) / C.AU; out.rocheRatio = (aM * (1 - e)) / (out.rocheAU * C.AU);
      if (Number.isFinite(star.jmag)) {
        const re = out.rpEarth, sf = re < 1.5 ? 0.190 : re < 2.75 ? 1.26 : re < 4 ? 1.28 : 1.15;
        out.tsm = (sf * re ** 3 * out.teq) / ((mp / C.Mearth_Msun) * star.rstar * star.rstar) * Math.pow(10, -star.jmag / 5);
        out.tsmExtrapolated = re >= 10;
      }
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

/**
 * Median and 68% interval of posterior draws (optionally weighted): { med, plus, minus }, or null without finite draws.
 * opts.period (e.g. 360 for an angle in degrees): the draws are first unwrapped about their circular mean, so a
 * posterior that straddles the wrap (omega = 175 deg and -178 deg) is summarised as one peak 6 deg wide rather than
 * as the whole circle. The median is returned in [lo, lo + period) with lo = opts.lo (default -period / 2).
 */
/**
 * Posterior summary of an epoch that repeats every period (mid-eclipse `emid`, periastron `tperi`), taken about the
 * circular mean with that period, so a posterior across the branch point is one peak. Reported with the same
 * convention as kepler.js eventTimes: the eclipse nearest the transit (after it when more than 0.4 P away) and the
 * periastron before it; tmid and P are the posterior medians.
 * @returns { med, plus, minus } like summarizeDraws, or null
 */
export function summarizeEpoch(a, key, tmid, per, weights = null) {
  if (!(per > 0) || !Number.isFinite(tmid)) return summarizeDraws(a, { weights });
  if (key === 'tperi') return summarizeDraws(a, { weights, period: per, lo: tmid - per });
  const c = summarizeDraws(a, { weights, period: per, lo: tmid - per / 2 });
  if (c && Math.abs(c.med - tmid) > 0.4 * per) c.med = tmid + (((c.med - tmid) % per) + per) % per;
  return c;
}

export function summarizeDraws(a, opts = {}) {
  const w = opts.weights || null, idx = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && (!w || w[i] > 0)) idx.push(i);
  if (!idx.length) return null;
  let x = idx.map((i) => a[i]), centre = 0;
  const ww = idx.map((i) => (w ? w[i] : 1)), P = opts.period;
  if (P > 0) {
    let sc = 0, ss = 0; const k = (2 * Math.PI) / P;
    for (let j = 0; j < x.length; j++) { sc += ww[j] * Math.cos(k * x[j]); ss += ww[j] * Math.sin(k * x[j]); }
    centre = Math.atan2(ss, sc) / k;
    x = x.map((v) => { const d = v - centre; return d - P * Math.round(d / P); });   // offsets from the circular mean, in [-P/2, P/2]
  }
  const order = x.map((_, j) => j).sort((p, q) => x[p] - x[q]);
  let tot = 0; for (const q of ww) tot += q;
  const quant = (p) => { let acc = 0; for (const j of order) { acc += ww[j]; if (acc >= p * tot) return x[j]; } return x[order[order.length - 1]]; };
  const lo = quant(0.15865525393145707), med = quant(0.5), hi = quant(0.8413447460685429);
  let m = med + centre;
  if (P > 0) { const base = opts.lo ?? -P / 2; m = m - P * Math.floor((m - base) / P); }
  return { med: m, plus: hi - med, minus: med - lo };
}
