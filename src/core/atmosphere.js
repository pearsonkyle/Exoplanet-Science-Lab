// One-dimensional atmosphere structure for the radiative transfer models (transmission.js, emission.js):
// a pressure grid, a temperature-pressure profile, mixing ratios, mean molecular weight and hydrostatic radii.
//
// Conventions
//   - layers are counted from the top: layer 0 is the lowest pressure. `pLev` has n + 1 entries, `pLay` n.
//   - pressures are given in bar and stored in pascal (`pLev`, `pLay`); radii in metres from the planet's centre;
//     temperatures in kelvin; number densities in m^-3; mixing ratios are by volume (number).
//   - a layer is isothermal at the temperature of its centre (the geometric mean of its two level pressures).
//
// Hydrostatic balance with g = G M / r^2 and an ideal gas gives d(1/r) = k T / (mu m_u G M) dlnP, which is exact for
// a layer of constant T and mu, so the radii below have no integration error beyond the layering of T and mu itself.
// With `constantG` the gravity is frozen at its value at the reference radius: dr = -k T / (mu m_u g) dlnP
// (the textbook isothermal atmosphere, kept for the closed-form checks).
//
// References: Guillot (2010, A&A 520, A27) eq. 29; Madhusudhan & Seager (2009, ApJ 707, 24) eqs. 1-2.

import { C } from './derive.js';

export const K_B = 1.380649e-23, M_U = 1.66053906660e-27, BAR = 1e5;

/** Molar masses in atomic mass units (standard atomic weights; main isotopologue mixtures). */
export const MASS = {
  H2: 2.01588, He: 4.002602, H: 1.00794, H2O: 18.01528, CO2: 44.0095, CO: 28.0101, CH4: 16.0425, NH3: 17.03052,
  HCN: 27.0253, SO2: 64.0638, H2S: 34.0809, C2H2: 26.0373, Na: 22.98977, K: 39.0983, TiO: 63.8664, VO: 66.9409,
  FeH: 56.853, N2: 28.0134, O2: 31.9988, O3: 47.9982, PH3: 33.99758, 'H-': 1.00849, 'e-': 5.4858e-4,
};

/** Level pressures in bar, n + 1 of them, uniform in log P from pTop to pBottom. */
export function pressureLevels({ pTop = 1e-6, pBottom = 100, nLayers = 60 } = {}) {
  const p = new Float64Array(nLayers + 1), a = Math.log(pTop), b = Math.log(pBottom);
  for (let i = 0; i <= nLayers; i++) p[i] = Math.exp(a + ((b - a) * i) / nLayers);
  return p;
}

// ---- temperature-pressure profiles: functions of pressure in bar -------------------------------------------------

/** Isothermal. */
export const isothermal = (T) => () => T;

/**
 * Guillot (2010) eq. 29, the global average: T^4 = 3/4 Tint^4 (2/3 + tau) + 3/4 Tirr^4 f [2/3 + 1/(gamma sqrt3)
 * + (gamma/sqrt3 - 1/(gamma sqrt3)) exp(-gamma tau sqrt3)], with tau = kappaIR P / g and Tirr = sqrt2 Teq.
 *   { teq [K], tint [K], kappaIR [m^2/kg], gamma (visible over infrared opacity), g [m/s^2], f = 1/4 }
 * f = 1/4 averages over the whole planet, 1/2 over the day side (Guillot's eq. 29 and its text).
 */
export function guillot({ teq, tint = 100, kappaIR = 1e-3, gamma = 0.4, g, f = 0.25 }) {
  const s3 = Math.sqrt(3), tirr4 = 4 * teq ** 4;   // (sqrt2 Teq)^4
  return (pBar) => {
    const tau = (kappaIR * pBar * BAR) / g;
    const irr = 2 / 3 + 1 / (gamma * s3) + (gamma / s3 - 1 / (gamma * s3)) * Math.exp(-gamma * tau * s3);
    return Math.pow(0.75 * tint ** 4 * (2 / 3 + tau) + 0.75 * tirr4 * f * irr, 0.25);
  };
}

/**
 * Madhusudhan & Seager (2009): three layers with P = P0 exp(a1 sqrt(T - T0)) above P1, P = P2 exp(a2 sqrt(T - T2))
 * between P1 and P3, isothermal below P3. T2 and T3 follow from continuity. P2 > P1 gives a thermal inversion.
 *   { t0 [K] at p0, a1, a2 [K^-1/2], p1, p2, p3 [bar], p0 = 1e-6 bar }
 */
export function madhusudhanSeager({ t0, a1, a2, p1, p2, p3, p0 = 1e-6 }) {
  const sq = (x) => x * x;
  const t1 = t0 + sq(Math.log(p1 / p0) / a1);
  const t2 = t1 - sq(Math.log(p1 / p2) / a2);
  const t3 = t2 + sq(Math.log(p3 / p2) / a2);
  const f = (pBar) => (pBar <= p0 ? t0 : pBar < p1 ? t0 + sq(Math.log(pBar / p0) / a1) : pBar < p3 ? t2 + sq(Math.log(pBar / p2) / a2) : t3);
  f.nodes = { t1, t2, t3 };
  return f;
}

/** A profile from a description: { kind: 'isothermal' | 'guillot' | 'ms09' | 'table', ... }. `g` is filled in for Guillot. */
export function profileFrom(tp, g) {
  if (typeof tp === 'function') return tp;
  if (typeof tp === 'number') return isothermal(tp);
  if (tp.kind === 'isothermal') return isothermal(tp.t);
  if (tp.kind === 'guillot') return guillot({ g, ...tp });
  if (tp.kind === 'ms09') return madhusudhanSeager(tp);
  if (tp.kind === 'table') {   // linear in log P between nodes, constant outside
    const lp = tp.p.map(Math.log), T = tp.t;
    return (pBar) => {
      const x = Math.log(pBar); if (x <= lp[0]) return T[0]; const n = lp.length; if (x >= lp[n - 1]) return T[n - 1];
      let i = 1; while (lp[i] < x) i++;
      return T[i - 1] + ((T[i] - T[i - 1]) * (x - lp[i - 1])) / (lp[i] - lp[i - 1]);
    };
  }
  if (tp.kind === 'consistent') throw new Error('a "consistent" temperature profile is solved first: withConsistentProfile in src/core/climate.js');
  throw new Error('unknown temperature profile: ' + tp.kind);
}

// ---- composition ------------------------------------------------------------------------------------------------

/**
 * Per-layer volume mixing ratios from constants or arrays, with H2 and He filling the rest at a fixed ratio.
 *   vmr: { H2O: 1e-3, CO2: Float64Array(n), ... }; H2 or He given is kept as given, and the other takes the rest;
 *        with both given nothing is added. The sum may not exceed 1.
 *   heH2: number ratio He / H2 of the fill gas (0.17: solar, X = 0.74, Y = 0.25)
 *   fill: true (H2 and He take the rest), false (the listed gases are all there is), or a species name (it takes the rest)
 * Returns { species: { name: Float64Array(n) }, mu: Float64Array(n) }.
 */
export function composition(vmr, nLayers, { heH2 = 0.17, fill = true } = {}) {
  const species = {}, mu = new Float64Array(nLayers), rest = new Float64Array(nLayers).fill(1);
  for (const [name, v] of Object.entries(vmr || {})) {
    if (!(name in MASS)) throw new Error('no molar mass for ' + name);
    const a = new Float64Array(nLayers);
    for (let i = 0; i < nLayers; i++) { a[i] = typeof v === 'number' ? v : v[i]; rest[i] -= a[i]; }
    species[name] = a;
  }
  for (let i = 0; i < nLayers; i++) {
    if (!Number.isFinite(rest[i])) throw new Error('a mixing ratio is not a number in layer ' + i);
    if (rest[i] < -1e-9) throw new Error('mixing ratios sum to more than 1 in layer ' + i);
  }
  const hasH2 = 'H2' in species, hasHe = 'He' in species;
  if (typeof fill === 'string') {   // another bulk gas (N2 for Titan, CO2 for Venus or Mars) takes what the listed gases leave
    if (!(fill in MASS)) throw new Error('no molar mass for the bulk gas ' + fill);
    const a = species[fill] || new Float64Array(nLayers); for (let i = 0; i < nLayers; i++) a[i] += Math.max(0, rest[i]); species[fill] = a;
  } else if (fill && !(hasH2 && hasHe)) {
    const h2 = hasH2 ? null : new Float64Array(nLayers), he = hasHe ? null : new Float64Array(nLayers);
    for (let i = 0; i < nLayers; i++) {
      const r = Math.max(0, rest[i]);
      if (h2 && he) { h2[i] = r / (1 + heH2); he[i] = r - h2[i]; } else (h2 || he)[i] = r;   // one of them given: the other takes the rest
    }
    if (h2) species.H2 = h2; if (he) species.He = he;
  }
  for (const [name, a] of Object.entries(species)) for (let i = 0; i < nLayers; i++) mu[i] += a[i] * MASS[name];
  return { species, mu };
}

// ---- the atmosphere -----------------------------------------------------------------------------------------------

/**
 * Build the layered atmosphere.
 *   mplanet [M Jup], rplanet [R Jup]: mass, and the radius at the reference pressure pRef [bar] (default 0.01)
 *   tp: a profile description (see profileFrom), a function of pressure in bar, or a number (isothermal)
 *   vmr: mixing ratios (see composition); pTop, pBottom [bar], nLayers; or `levels` (bar, increasing) to set the grid
 *   constantG: freeze gravity at its value at the reference radius
 *   mu: mean molecular weight per layer [amu], when `vmr` does not list the whole gas (equilibrium chemistry)
 * Returns { n, pLev, pLay [Pa], tLay [K], mu, species, rLev, rLay [m], dr, nd [m^-3], g [m/s^2 at each layer centre],
 *           gRef, r0, pRef [Pa], gm, dudlnp }. dudlnp is d(1/r)/dlnP of each layer (dr/dlnP with constantG): inside
 *           layer j the pressure at radius r is pLay[j] exp((u(r) - u(rLay[j])) / dudlnp[j]), u = 1/r or r.
 */
export function buildAtmosphere({ mplanet, rplanet, pRef = 0.01, tp, vmr = {}, heH2 = 0.17, pTop = 1e-6, pBottom = 100, nLayers = 60, levels, constantG = false, fill = true, mu: muGiven = null }) {
  if (![mplanet, rplanet, pRef].every((v) => Number.isFinite(v) && v > 0)) throw new Error('the planet needs a mass, a radius and a reference pressure');
  if (!levels && !(pBottom > pTop && pTop > 0)) throw new Error('the top pressure must be below the bottom pressure');
  const pBar = levels ? Float64Array.from(levels) : pressureLevels({ pTop, pBottom, nLayers });
  const n = pBar.length - 1;
  const gm = C.GMsun * mplanet * C.Mjup_Msun, r0 = rplanet * C.Rjup, gRef = gm / (r0 * r0);
  const T = profileFrom(tp, gRef);
  const pLev = new Float64Array(n + 1), pLay = new Float64Array(n), tLay = new Float64Array(n);
  for (let i = 0; i <= n; i++) pLev[i] = pBar[i] * BAR;
  for (let i = 0; i < n; i++) { pLay[i] = Math.sqrt(pLev[i] * pLev[i + 1]); tLay[i] = T(pLay[i] / BAR); }
  const comp = composition(vmr, n, { heH2, fill }), species = comp.species, mu = muGiven ? Float64Array.from(muGiven) : comp.mu;   // muGiven: of the whole gas, when the species listed are not all of it

  // u = 1/r (variable gravity) or r (constant gravity), accumulated from the top level, then shifted so that the
  // reference pressure sits at r0. Within a layer u is linear in ln P, so the shift is exact.
  const u = new Float64Array(n + 1), lnP = Array.from(pLev, Math.log), lnRef = Math.log(pRef * BAR);
  const slope = (i) => (constantG ? -(K_B * tLay[i]) / (mu[i] * M_U * gRef) : (K_B * tLay[i]) / (mu[i] * M_U * gm));
  for (let i = 0; i < n; i++) u[i + 1] = u[i] + slope(i) * (lnP[i + 1] - lnP[i]);
  const uAt = (x) => {
    if (x <= lnP[0]) return u[0] + slope(0) * (x - lnP[0]);
    if (x >= lnP[n]) return u[n] + slope(n - 1) * (x - lnP[n]);
    let i = 0; while (lnP[i + 1] < x) i++;
    return u[i] + slope(i) * (x - lnP[i]);
  };
  const shift = (constantG ? r0 : 1 / r0) - uAt(lnRef);
  const radius = (x) => (constantG ? uAt(x) + shift : 1 / (uAt(x) + shift));
  const rLev = new Float64Array(n + 1), rLay = new Float64Array(n), dr = new Float64Array(n), nd = new Float64Array(n), g = new Float64Array(n);
  for (let i = 0; i <= n; i++) rLev[i] = radius(lnP[i]);
  for (let i = 0; i < n; i++) {
    rLay[i] = radius(Math.log(pLay[i])); dr[i] = rLev[i] - rLev[i + 1];
    nd[i] = pLay[i] / (K_B * tLay[i]); g[i] = constantG ? gRef : gm / (rLay[i] * rLay[i]);
  }
  if (!(rLev[0] > 0) || !Number.isFinite(rLev[0])) throw new Error('the atmosphere is unbound at the top level: raise pTop or the mass');
  const dudlnp = new Float64Array(n); for (let i = 0; i < n; i++) dudlnp[i] = slope(i);
  return { n, pLev, pLay, tLay, mu, species, rLev, rLay, dr, nd, g, gRef, r0, pRef: pRef * BAR, gm, constantG, dudlnp };
}

/** Column number density of each layer along the vertical [m^-2]: nd dr (the hydrostatic value dP / (mu m_u g) to first order). */
export function columns(atm) { const c = new Float64Array(atm.n); for (let i = 0; i < atm.n; i++) c[i] = atm.nd[i] * atm.dr[i]; return c; }
