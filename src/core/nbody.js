// Gravitational N-body dynamics for planetary systems: dynamical transit times, transit timing variations,
// radial velocities of the star, stability checks, and the interpretation of an O - C signal by a grid of
// simulations over a hypothetical perturber. No DOM, no dependencies outside src/core. Runs in Node.
//
// ============================================================================================================
// INTEGRATION (for the owner of src/core/model.js; nothing here edits it)
// ============================================================================================================
// 1. Timing likelihood (do this first). `buildProblem` compares each mid-transit time with
//    `t0 + E * per` in its "---- timing" loop. With `spec.nbody` set, replace that prediction with
//
//        const dyn = dynamicalModel(
//          { mstar: v.mstar, rstar: v.rstar, epoch: spec.nbody.epoch,           // times relative to data.tRef, like tmid
//            planets: pv.map((q) => ({ per: q.per, tmid: q.tmid, ecc: q.ecc, omega: q.omega, inc: q.inc, mplanet: q.mplanet })) },
//          { timing: tim.map((x) => ({ planet: x.p, t: x.t })),                 // x.p = index into spec.planets
//            rv: rvs.map((d) => ({ t: d.t })), event: 'conjunction', dt: spec.nbody.dt });
//        if (!dyn.ok) return null;                                              // unbound, close encounter, missing transit
//        // timing:   x.model[i] = dyn.timing[k].model[i];  x.epoch[i] = dyn.timing[k].epoch[i]
//        // velocity: replace  sum_p rvFns[p](D.t[i])  by  dyn.rv[d][i]   (m/s, positive = receding, no zero point)
//
//    Requirements: every planet needs `mplanet` (M Jup) and the star `mstar` (the spec.kepler case already has
//    both); `per`, `tmid`, `ecc`, `omega`, `inc` keep their keys but become OSCULATING elements at
//    `spec.nbody.epoch` (see "Reference epoch" below), so with all masses zero the result is identical to the
//    present Keplerian one. Only kind 'transit' is produced: mid-eclipse times need the same root finding on the
//    far side (Z < 0), which `simulate` does not report yet. Cost: one simulation per likelihood call; see the
//    timings at the end of this header. `nbodyTimingProblem` below is the same likelihood as a stand-alone
//    problem ({ ndim, keys, transform, loglike }) for MiniNest, used by test/nbody.test.mjs.
//
// 2. Photodynamics (next step, not built). A light curve from N-body positions needs, for each planet and
//    each exposure, the sky-projected separation from the star in stellar radii and whether the planet is in
//    front. `makeTransit(tp)` in transit.js builds its own Keplerian orbit from `tp`; it would need either
//      (a) a per-transit ephemeris: for transit k of planet p, call makeTransit with
//          { ...tp, tmid: T_k, per: local period, inc: from the simulated impact parameter b_k } and evaluate each
//          point with the transit nearest in time. `simulate` returns T_k, b_k and the sky speed for this. Good to
//          the size of the change of the orbit within one transit, which is negligible for planets; or
//      (b) a variant `makeTransitFromSeparation(tp)` returning flux(d, front) so that the caller supplies
//          d(t) from `simulate(..., { times })` positions (samples.x, relative to the star, in stellar radii).
//    (a) needs no change to transit.js and is what TTVFast-based photodynamical codes do for well-separated
//    planets; (b) is needed only for mutual events and strongly perturbed (circumbinary-like) orbits.
//
// ============================================================================================================
// Units and frame
// ============================================================================================================
// Internal units: AU, days, solar masses; G = GM_sun day^2 / AU^3 from the constants `C` in derive.js
// (2.9591220828559e-4, the IAU 2012 AU and the nominal GM_sun). Planet masses are given in Jupiter masses
// (C.Mjup_Msun) and converted at the boundary; positions are returned in stellar radii when `rstar` [R_sun]
// is given, velocities of the star in m/s.
//
// Frame: that of kepler.js. X, Y in the plane of the sky, +Z toward the observer. A planet's position on
// its osculating orbit is
//     X = -r cos(omega + nu),   Y = -r sin(omega + nu) cos i,   Z = r sin(omega + nu) sin i
// rotated about the line of sight by the optional `Omega` (degrees, default 0):
//     X' = X cos Omega - Y sin Omega,   Y' = X sin Omega + Y cos Omega.
// This is REBOUND's (and Winn 2010's) convention with the longitude of the ascending node at Omega + 180 deg:
// REBOUND's x, y are -X, -Y here and its z is Z. Only differences of Omega between planets matter.
// Mid-transit is inferior conjunction, omega + nu = pi/2. Radial velocity is -dZ/dt of the star in the
// barycentric frame, positive when it recedes, as in rv.js.
//
// ============================================================================================================
// Initial conditions, reference epoch and the Keplerian limit
// ============================================================================================================
// `buildSystem` turns the app's parameters {per, tmid, ecc, omega, inc, Omega, mplanet} of each planet into
// positions and velocities at one instant, `epoch` (default: the earliest tmid). The parameters are the
// OSCULATING elements at that instant: `tmid` fixes the phase through the mean anomaly
//     M(epoch) = M_transit(e, omega) + 2 pi (epoch - tmid) / per
// i.e. tmid is the time at which the planet WOULD be at inferior conjunction if it kept the orbit it has at
// `epoch`. It need not lie near `epoch`, but a tmid far from it (more than about a TTV period) is no longer
// close to any actual transit. Choose `epoch` inside or at the start of the data, as EXOTIC's
// NbodySystem.from_multiplanet does.
//
// Elements are Jacobi elements by default (coords: 'jacobi'): planets are ordered by period, and planet k
// orbits the centre of mass of the star and the planets inside it with
//     a_k^3 = G (M* + m_1 + ... + m_k) per_k^2 / (4 pi^2).
// This is what REBOUND's sim.add(m=, P=, ...) does, hence what EXOTIC's nbody.py does, and TTVFast's default
// input. coords: 'astrocentric' takes each planet's elements relative to the star with G (M* + m_k).
// For a single planet both are the two-body orbit of rv.js (same a, same K).
//
// Keplerian limit: with every planet mass zero, all the choices above reduce to a test particle around M*
// with exactly the period `per`, and the interaction part of the integrator vanishes identically, so the map
// is the exact two-body solution. Transit times are then tmid + k per to rounding (measured in the tests:
// 1e-4 s after 5000 circular orbits, 7e-3 s after 1000 orbits of HD 80606 b at 2300 steps per orbit; under
// 1e-12 of the elapsed time in both cases).
//
// ============================================================================================================
// What a "mid-transit time" is
// ============================================================================================================
//   event: 'minsep'       (default) the instant of minimum sky-projected separation of planet and star with the
//                         planet in front: the root of  (R_sky . V_sky) = 0,  as in TTVFast (Deck et al. 2014).
//                         This is the centre of the light curve.
//   event: 'conjunction'  the instant the planet crosses the plane through the line of sight and the normal to its
//                         line of nodes (X' = 0 with Z > 0). This is what kepler.js calls `tmid`.
// The two coincide for circular or edge-on orbits. Otherwise the centre of the light curve comes earlier or
// later than conjunction by about  b R* (dr/dt) cos i / v_sky^2 : 684 s (11.4 min) for HD 80606 b (e = 0.93,
// i = 89.27 deg, b = 0.78), under a second for hot Jupiters with e < 0.05. `dynamicalModel` defaults to
// 'conjunction' because it stands in for `tmid + E per` in the timing likelihood and because the app's light
// curves are built on tmid = conjunction.
// Light-travel time across the system is not applied (neither do REBOUND-based codes or TTVFast).
//
// ============================================================================================================
// Integrators
// ============================================================================================================
//   'wh'     Wisdom-Holman map in Jacobi coordinates with the same splitting as REBOUND's WHFast (Rein & Tamayo
//            2015): Kepler drift of each planet about the mass interior to it (universal variables, Stumpff
//            series), interaction kick. Drift-kick-drift, combined between outputs. Optional symplectic
//            correctors of order 3 to 11 (Wisdom 2006; coefficients as in WHFast) reduce the error from
//            O(eps dt^2) to O(eps dt^4 + eps^2 dt^2), eps = planet/star mass ratio; they are applied once at the
//            start and undone on a copy of the state wherever an output or a transit is needed. Fixed step,
//            time-reversible, symplectic. Not valid when two planets come within about a mutual Hill radius
//            (the result is flagged).
//   'ias15'  Gauss-Radau 15th-order predictor-corrector with adaptive step (Everhart 1985; Rein & Spiegel 2015,
//            with their original global step criterion, epsilon = 1e-9). Machine-precision energy, handles close
//            encounters; its interpolating polynomial gives transit times and outputs inside a step at no cost.
//            Used as the internal cross-check and whenever the Wisdom-Holman map is flagged.
// Transit times: a sign change of the event function between consecutive steps is refined by re-stepping from
// the synchronised state (Wisdom-Holman) or on the interpolating polynomial (IAS15), then polished by Newton
// iteration on a two-body arc. The root is found to better than 1e-9 d; the accuracy of the time itself is
// that of the integration and is given in the README section and in test/nbody.test.mjs.
//
// References
//   Wisdom & Holman 1991, AJ 102, 1528; Wisdom, Holman & Touma 1996; Wisdom 2006, AJ 131, 2294 (correctors)
//   Rein & Tamayo 2015, MNRAS 452, 376 (WHFast); Rein & Spiegel 2015, MNRAS 446, 1424 (IAS15)
//   Deck, Agol, Holman & Nesvorny 2014, ApJ 787, 132 (TTVFast)
//   Agol, Steffen, Sari & Clarkson 2005, MNRAS 359, 567; Holman & Murray 2005, Science 307, 1288
//   Lithwick, Xie & Wu 2012, ApJ 761, 122 (near-resonant TTV amplitudes)
//   Gladman 1993, Icarus 106, 247; Chambers, Wetherill & Boss 1996, Icarus 119, 261 (Hill spacing)
//   Laskar & Petit 2017, A&A 605, A72 (AMD stability)
//   Pearson 2019, AJ 158, 243 (Nbody-AI: the grid/prior idea reproduced by ttvGrid)

import { solveKepler, trueAnomaly, meanAnomalyAtTransit } from './kepler.js';
import { C } from './derive.js';
import { fitEphemeris } from './ephemeris.js';
import { timingPeriodogram } from './periodogram.js';
import { makeTransform } from './priors.js';

const TWO_PI = 2 * Math.PI, DEG = Math.PI / 180;

/** Constants of the internal unit system (AU, day, M_sun). */
export const NB = {
  G: (C.GMsun * C.day * C.day) / (C.AU * C.AU * C.AU),
  Mjup: C.Mjup_Msun,
  Rsun_AU: C.Rsun / C.AU,
  AUday_ms: C.AU / C.day,
};
const G = NB.G;

// ------------------------------------------------------------------------------------------------------------
// Two-body propagation in universal variables
// ------------------------------------------------------------------------------------------------------------

const cs = new Float64Array(4);
/** Stumpff functions c0..c3 of z into cs (series after quartering the argument, then the duplication formulae). */
function stumpff(z) {
  let n = 0;
  while (z > 0.1 || z < -0.1) { z *= 0.25; n++; }
  // c2 = 1/2! - z/4! + z^2/6! ...   c3 = 1/3! - z/5! + z^2/7! ...
  let c2 = 1 - z / 182, c3 = 1 - z / 210;
  c2 = 1 - (z / 132) * c2; c3 = 1 - (z / 156) * c3;
  c2 = 1 - (z / 90) * c2; c3 = 1 - (z / 110) * c3;
  c2 = 1 - (z / 56) * c2; c3 = 1 - (z / 72) * c3;
  c2 = 1 - (z / 30) * c2; c3 = 1 - (z / 42) * c3;
  c2 = (1 - (z / 12) * c2) / 2; c3 = (1 - (z / 20) * c3) / 6;
  let c1 = 1 - z * c3, c0 = 1 - z * c2;
  for (; n > 0; n--) { c3 = (c2 + c0 * c3) * 0.25; c2 = c1 * c1 * 0.5; c1 = c0 * c1; c0 = 2 * c0 * c0 - 1; }
  cs[0] = c0; cs[1] = c1; cs[2] = c2; cs[3] = c3;
}

/**
 * Advance the two-body orbit of the vector at offset k of X, V by dt about a centre of gravitational
 * parameter mu, in place. Elliptic, parabolic and hyperbolic motion. Returns false when it did not converge.
 */
function keplerDrift(X, V, k, mu, dt) {
  const x0 = X[k], y0 = X[k + 1], z0 = X[k + 2], vx0 = V[k], vy0 = V[k + 1], vz0 = V[k + 2];
  const r0 = Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0), r0i = 1 / r0, v2 = vx0 * vx0 + vy0 * vy0 + vz0 * vz0;
  const beta = 2 * mu * r0i - v2, eta0 = x0 * vx0 + y0 * vy0 + z0 * vz0, zeta0 = mu - beta * r0;
  let s;
  if (beta > 0) {
    // bound: remove whole periods, start from the second-order series
    const sb = Math.sqrt(beta), period = TWO_PI * mu / (beta * sb);
    if (dt > period || dt < -period) dt -= period * Math.trunc(dt / period);
    const q = dt * r0i;
    s = q * (1 - 0.5 * q * eta0 * r0i);
    const smax = TWO_PI / sb;
    if (s > smax || s < -smax) s = (dt > 0 ? 0.5 : -0.5) * smax;
  } else s = 0;
  let G1 = 0, G2 = 0, G3 = 0, s1 = NaN, s2 = NaN, done = false;
  for (let it = 0; it < 30; it++) {
    stumpff(beta * s * s);
    G1 = cs[1] * s; G2 = cs[2] * s * s; G3 = cs[3] * s * s * s;
    const F = r0 * s + eta0 * G2 + zeta0 * G3 - dt, dF = r0 + eta0 * G1 + zeta0 * G2;
    const sn = s - F / dF;
    if (sn === s || sn === s1 || sn === s2) { done = true; break; }
    s2 = s1; s1 = s; s = sn;
    if (!(Math.abs(s) < 1e300)) break;
  }
  if (!done) {
    // bisection on the monotonic Kepler equation in s
    let lo, hi;
    if (beta > 0) { const smax = TWO_PI / Math.sqrt(beta); lo = dt > 0 ? 0 : -smax; hi = dt > 0 ? smax : 0; }
    else { const w = Math.abs(dt) * r0i + 1; lo = dt > 0 ? 0 : -w; hi = dt > 0 ? w : 0; for (let j = 0; j < 200; j++) { stumpff(beta * (dt > 0 ? hi : lo) ** 2); const e = dt > 0 ? hi : lo; const Fe = r0 * e + eta0 * cs[2] * e * e + zeta0 * cs[3] * e * e * e - dt; if (dt > 0 ? Fe > 0 : Fe < 0) break; if (dt > 0) hi *= 2; else lo *= 2; } }
    for (let j = 0; j < 200; j++) {
      s = 0.5 * (lo + hi); stumpff(beta * s * s);
      const F = r0 * s + eta0 * cs[2] * s * s + zeta0 * cs[3] * s * s * s - dt;
      if (F > 0) hi = s; else lo = s;
      if (hi - lo <= 4e-16 * Math.abs(s)) break;
    }
    stumpff(beta * s * s);
    G1 = cs[1] * s; G2 = cs[2] * s * s; G3 = cs[3] * s * s * s;
    if (!Number.isFinite(s)) return false;
  }
  const ri = 1 / (r0 + eta0 * G1 + zeta0 * G2);
  const fm1 = -mu * G2 * r0i, g = dt - mu * G3, fd = -mu * G1 * r0i * ri, gdm1 = -mu * G2 * ri;
  X[k] = x0 + fm1 * x0 + g * vx0; X[k + 1] = y0 + fm1 * y0 + g * vy0; X[k + 2] = z0 + fm1 * z0 + g * vz0;
  V[k] = vx0 + fd * x0 + gdm1 * vx0; V[k + 1] = vy0 + fd * y0 + gdm1 * vy0; V[k + 2] = vz0 + fd * z0 + gdm1 * vz0;
  return Number.isFinite(X[k]);
}

// ------------------------------------------------------------------------------------------------------------
// Coordinates, forces, conserved quantities
// ------------------------------------------------------------------------------------------------------------

/** Inertial -> Jacobi (linear; used for positions, velocities and accelerations). out[0..2] is the centre of mass. */
function toJacobi(n, m, x, out) {
  let sx = m[0] * x[0], sy = m[0] * x[1], sz = m[0] * x[2], eta = m[0];
  for (let i = 1, k = 3; i < n; i++, k += 3) {
    const ei = 1 / eta;
    out[k] = x[k] - sx * ei; out[k + 1] = x[k + 1] - sy * ei; out[k + 2] = x[k + 2] - sz * ei;
    sx += m[i] * x[k]; sy += m[i] * x[k + 1]; sz += m[i] * x[k + 2]; eta += m[i];
  }
  const ei = 1 / eta; out[0] = sx * ei; out[1] = sy * ei; out[2] = sz * ei;
}
/** Jacobi -> inertial. eta[i] = m_0 + ... + m_i. */
function fromJacobi(n, m, eta, xj, out) {
  let Rx = xj[0], Ry = xj[1], Rz = xj[2];
  for (let i = n - 1, k = 3 * (n - 1); i >= 1; i--, k -= 3) {
    const f = m[i] / eta[i];
    Rx -= f * xj[k]; Ry -= f * xj[k + 1]; Rz -= f * xj[k + 2];
    out[k] = Rx + xj[k]; out[k + 1] = Ry + xj[k + 1]; out[k + 2] = Rz + xj[k + 2];
  }
  out[0] = Rx; out[1] = Ry; out[2] = Rz;
}

/**
 * Newtonian accelerations. skip01: leave out the star - first planet pair (it cancels in the Wisdom-Holman
 * interaction). pmin (n*n, optional): running minimum of the squared distance of each pair.
 */
function accel(n, m, x, a, skip01, pmin) {
  for (let k = 0; k < 3 * n; k++) a[k] = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const ki = 3 * i, kj = 3 * j, dx = x[kj] - x[ki], dy = x[kj + 1] - x[ki + 1], dz = x[kj + 2] - x[ki + 2];
    const r2 = dx * dx + dy * dy + dz * dz;
    if (pmin && r2 < pmin[i * n + j]) pmin[i * n + j] = r2;
    if (skip01 && j === 1) continue;
    const w = G / (r2 * Math.sqrt(r2)), wi = w * m[j], wj = w * m[i];
    a[ki] += wi * dx; a[ki + 1] += wi * dy; a[ki + 2] += wi * dz;
    a[kj] -= wj * dx; a[kj + 1] -= wj * dy; a[kj + 2] -= wj * dz;
  }
}

/** Total energy [M_sun AU^2 / d^2] of an inertial state. */
export function energy(n, m, x, v) {
  let e = 0;
  for (let i = 0; i < n; i++) {
    const k = 3 * i; e += 0.5 * m[i] * (v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2]);
    for (let j = i + 1; j < n; j++) { const q = 3 * j; e -= (G * m[i] * m[j]) / Math.hypot(x[q] - x[k], x[q + 1] - x[k + 1], x[q + 2] - x[k + 2]); }
  }
  return e;
}
/** Total angular momentum vector [M_sun AU^2 / d] of an inertial state. */
export function angularMomentum(n, m, x, v) {
  const L = [0, 0, 0];
  for (let i = 0; i < n; i++) { const k = 3 * i; L[0] += m[i] * (x[k + 1] * v[k + 2] - x[k + 2] * v[k + 1]); L[1] += m[i] * (x[k + 2] * v[k] - x[k] * v[k + 2]); L[2] += m[i] * (x[k] * v[k + 1] - x[k + 1] * v[k]); }
  return L;
}

// ------------------------------------------------------------------------------------------------------------
// Initial conditions
// ------------------------------------------------------------------------------------------------------------

/**
 * Initial conditions from the app's parameters.
 * p = {
 *   mstar [M_sun], rstar [R_sun] (optional; needed for impact parameters, durations, positions in stellar radii),
 *   planets: [{ per [d] (or a [AU]), tmid [d], ecc, omega [deg], inc [deg], Omega [deg] (optional), mplanet [M_Jup],
 *               rprs (optional, for T14), letter (optional) }],
 *   epoch [d]   instant at which the elements are osculating (default: the earliest tmid),
 *   coords      'jacobi' (default) | 'astrocentric'
 * }
 * Returns { n (bodies, star first), np, m [M_sun], x, v (barycentric, AU and AU/d, bodies ordered by period),
 *           epoch, order (order[j] = index in p.planets of body j+1), slot (inverse), per, a [AU], ecc, rstarAU, rprs,
 *           nodeC, nodeS (cos, sin of each body's Omega), mstar, coords }.
 * Throws on parameters that do not describe a bound orbit.
 */
export function buildSystem(p) {
  const pl = p.planets || [], np = pl.length, n = np + 1, m0 = p.mstar;
  if (!(m0 > 0)) throw new Error('N-body needs the stellar mass (mstar, solar masses)');
  const astro = p.coords === 'astrocentric';
  const perOf = (q) => (q.per > 0 ? q.per : q.a > 0 ? TWO_PI * Math.sqrt((q.a * q.a * q.a) / (G * m0)) : NaN);
  const order = pl.map((_, i) => i).sort((a, b) => perOf(pl[a]) - perOf(pl[b]));
  let epoch = p.epoch;
  if (epoch === undefined || epoch === null) { epoch = Infinity; for (const q of pl) if (q.tmid < epoch) epoch = q.tmid; if (!Number.isFinite(epoch)) epoch = 0; }
  const m = new Float64Array(n), x = new Float64Array(3 * n), v = new Float64Array(3 * n);
  const per = new Float64Array(n), sma = new Float64Array(n), ecc = new Float64Array(n), rprs = new Float64Array(n), nodeC = new Float64Array(n), nodeS = new Float64Array(n);
  m[0] = m0; nodeC[0] = 1;
  // running centre of mass of the bodies placed so far (Jacobi), relative to the star
  let eta = m0, sx = 0, sy = 0, sz = 0, svx = 0, svy = 0, svz = 0;
  for (let j = 0; j < np; j++) {
    const q = pl[order[j]], b = j + 1, k = 3 * b, mp = (q.mplanet || 0) * NB.Mjup;
    const e = q.ecc || 0, w = (q.omega || 0) * DEG, inc = (q.inc ?? 90) * DEG, Om = (q.Omega || 0) * DEG;
    if (!(e >= 0 && e < 1)) throw new Error('eccentricity must be in [0, 1)');
    if (!(mp >= 0)) throw new Error('planet masses must be zero or positive');
    const mu = G * ((astro ? m0 : eta) + mp);
    let P = q.per, a;
    if (P > 0) a = Math.cbrt((mu * P * P) / (TWO_PI * TWO_PI)); else if (q.a > 0) { a = q.a; P = TWO_PI * Math.sqrt((a * a * a) / mu); } else throw new Error('each planet needs a period (per) or a semi-major axis (a)');
    const M = meanAnomalyAtTransit(e, w) + (TWO_PI * (epoch - q.tmid)) / P;
    const E = solveKepler(M, e), nu = trueAnomaly(E, e), r = a * (1 - e * Math.cos(E)), u = w + nu;
    const cu = Math.cos(u), su = Math.sin(u), ci = Math.cos(inc), si = Math.sin(inc), cO = Math.cos(Om), sO = Math.sin(Om);
    const vh = Math.sqrt(mu / (a * (1 - e * e)));                 // mu / h
    const X = -r * cu, Y = -r * su * ci, Z = r * su * si;
    const VX = vh * (su + e * Math.sin(w)), VY = -vh * (cu + e * Math.cos(w)) * ci, VZ = vh * (cu + e * Math.cos(w)) * si;
    const ox = astro ? 0 : sx / eta, oy = astro ? 0 : sy / eta, oz = astro ? 0 : sz / eta;
    const ovx = astro ? 0 : svx / eta, ovy = astro ? 0 : svy / eta, ovz = astro ? 0 : svz / eta;
    x[k] = ox + X * cO - Y * sO; x[k + 1] = oy + X * sO + Y * cO; x[k + 2] = oz + Z;
    v[k] = ovx + VX * cO - VY * sO; v[k + 1] = ovy + VX * sO + VY * cO; v[k + 2] = ovz + VZ;
    m[b] = mp; per[b] = P; sma[b] = a; ecc[b] = e; rprs[b] = q.rprs || 0; nodeC[b] = cO; nodeS[b] = sO;
    sx += mp * x[k]; sy += mp * x[k + 1]; sz += mp * x[k + 2]; svx += mp * v[k]; svy += mp * v[k + 1]; svz += mp * v[k + 2]; eta += mp;
  }
  // to the barycentre
  for (let i = 0; i < n; i++) { const k = 3 * i; x[k] -= sx / eta; x[k + 1] -= sy / eta; x[k + 2] -= sz / eta; v[k] -= svx / eta; v[k + 1] -= svy / eta; v[k + 2] -= svz / eta; }
  const slot = new Int32Array(np); order.forEach((src, j) => (slot[src] = j + 1));
  return { n, np, m, x, v, epoch, order, slot, per, a: sma, ecc, rstarAU: (p.rstar || 0) * NB.Rsun_AU, rprs, nodeC, nodeS, mstar: m0, coords: astro ? 'astrocentric' : 'jacobi' };
}

/**
 * Default Wisdom-Holman step [d]: the shortest "periastron period"  P (1 - e)^(3/2) / sqrt(1 + e)  of the planets,
 * divided by stepsPerOrbit (default 30). For circular orbits this is P/30; an eccentric orbit needs its
 * periastron passage resolved (HD 80606 b: 1/75 of the period per unit, so about 2300 steps per orbit).
 */
export function defaultStep(sys, stepsPerOrbit = 30) {
  let tp = Infinity;
  for (let i = 1; i < sys.n; i++) { const e = sys.ecc[i]; tp = Math.min(tp, (sys.per[i] * Math.pow(1 - e, 1.5)) / Math.sqrt(1 + e)); }
  return tp / (stepsPerOrbit || 30);
}

/** Mutual Hill radius [AU] of two planets (masses in M_sun). */
const mutualHill = (a1, a2, m1, m2, m0) => 0.5 * (a1 + a2) * Math.cbrt((m1 + m2) / (3 * m0));

// ------------------------------------------------------------------------------------------------------------
// The simulation
// ------------------------------------------------------------------------------------------------------------

// WHFast corrector coefficients (Wisdom 2006; Rein & Tamayo 2015)
const CA1 = 0.41833001326703777398908601289259374469640768464934;       // a_k = k CA1
const CORR_B = {
  3: [-0.024900596027799867499350357910273437184309981229127],
  5: [-0.0083001986759332891664501193034244790614366604097090, 0.041500993379666445832250596517122395307183302048545],
  7: [0.0024926811426922105779030593952776964450539008582219, -0.018270923246702131478062356884535264841652263842597, 0.053964399093127498721765893493510877532452806339655],
  11: [0.00020361579647854651301632818774633716473696537436847, -0.0023487215292295354188307328851055489876255097419754, 0.012309078592019946317544564763237909911330686448336, -0.038121613681288650508647613260247372125243616270670, 0.072593394748842738674253180742744961827622366521517],
};

// Gauss-Radau spacings and the conversion between divided differences g and power-series coefficients b
const GR_H = [0, 0.0562625605369221464656521910318, 0.180240691736892364987579942780, 0.352624717113169637373907769648, 0.547153626330555383001448554766, 0.734210177215410531523210605558, 0.885320946839095768090359771030, 0.977520613561287501891174488626];
const GR_C = (() => {
  // GR_C[k][j]: coefficient of h^(j+1) in  h (h - h1) ... (h - hk)
  const out = [];
  let p = [1];
  for (let k = 0; k < 7; k++) {
    if (k > 0) { const q = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { q[j + 1] += p[j]; q[j] -= GR_H[k] * p[j]; } p = q; }
    out.push(Float64Array.from(p));
  }
  return out;
})();

/**
 * Integrate a system and collect transits, radial velocities and positions.
 *
 * sys: from buildSystem (not modified).
 * opt = {
 *   tStart, tEnd      window [d] (same time system as tmid/epoch). The integration starts at sys.epoch and runs
 *                     forward to tEnd and, when tStart < epoch, backward to tStart. Defaults: epoch.
 *   integrator        'wh' (default) | 'ias15'
 *   dt                Wisdom-Holman step [d]; default: defaultStep(sys, stepsPerOrbit)
 *   stepsPerOrbit     default 30 (per shortest periastron period, see defaultStep)
 *   corrector         0 | 3 | 5 (default) | 7 | 11: order of the symplectic corrector
 *   exactSync         true (default): undo the corrector at every transit and output. false: skip that, which
 *                     is up to twice as fast and adds a bounded error of order eps dt^2 to the times (at most
 *                     0.12 s in the reference systems of test/nbody.test.mjs)
 *   epsilon           IAS15 accuracy parameter (default 1e-9)
 *   transits          true (default): find mid-transit times of every planet
 *   event             'minsep' (default) | 'conjunction'
 *   times             output times [d] (any order, inside the window): radial velocity and positions there
 *   positions         true: also return positions at `times` (default false)
 *   maxTransits       capacity per planet (default from the window and the periods)
 * }
 * Returns {
 *   ok, status ('ok' | 'unbound' | 'close encounter' | 'not converged'), warnings: [strings],
 *   integrator, dt, steps, forceEvaluations, seconds,
 *   transits: [per planet, in the order of p.planets]
 *              { n, t (mid-transit times, sorted), b (sky separation at mid-transit in stellar radii; AU when
 *                rstar is not given), vsky [stellar radii or AU per day], dur (first to fourth contact, days;
 *                0 when grazing-out or rstar unknown), z (always > 0) }  as Float64Array views,
 *   rv:  Float64Array, m/s at opt.times in the order given (positive = receding), barycentric, no zero point,
 *   samples: { x: [per body incl. star, Float64Array 3*nt] } positions relative to the barycentre at opt.times
 *            (stellar radii when rstar is given, else AU),
 *   energy: { initial, final, relErr (|dE/E| at the end), maxRelErr (largest seen at the checks) },
 *   angmom: { relErr },
 *   minSepHill: smallest planet-planet distance met, in mutual Hill radii (Infinity for one planet),
 *   minStar: smallest planet-star distance met [AU],
 *   state: { t, x, v } inertial state at the end of the forward leg (tEnd; or the epoch when there is none)
 * }
 */
export function simulate(sys, opt = {}) {
  const t00 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const n = sys.n, n3 = 3 * n, m = sys.m, epoch = sys.epoch;
  const tEnd = opt.tEnd ?? epoch, tStart = opt.tStart ?? epoch;
  const useIAS = opt.integrator === 'ias15';
  const wantTr = opt.transits !== false, conj = opt.event === 'conjunction';
  let pMin = Infinity; for (let i = 1; i < n; i++) if (sys.per[i] < pMin) pMin = sys.per[i];
  const dt0 = opt.dt > 0 ? opt.dt : defaultStep(sys, opt.stepsPerOrbit);
  const corr = opt.corrector ?? 5, exact = opt.exactSync !== false;
  const lenU = sys.rstarAU > 0 ? 1 / sys.rstarAU : 1;
  const warnings = [];

  // ---- storage (everything is allocated here, nothing in the step loops)
  const eta = new Float64Array(n), mu = new Float64Array(n);
  { let s = 0; for (let i = 0; i < n; i++) { s += m[i]; eta[i] = s; mu[i] = G * s; } }
  const x = new Float64Array(n3), v = new Float64Array(n3), a = new Float64Array(n3), aj = new Float64Array(n3);
  const xj = new Float64Array(n3), vj = new Float64Array(n3);
  const bxj = new Float64Array(n3), bvj = new Float64Array(n3);     // synchronised base state for sub-steps
  const sxj = new Float64Array(n3), svj = new Float64Array(n3);     // sub-step scratch
  const ox = new Float64Array(n3), ov = new Float64Array(n3);       // inertial state at an output/transit instant
  const pmin = new Float64Array(n * n).fill(Infinity);
  const kx = new Float64Array(3), kv = new Float64Array(3), mx = new Float64Array(3), mv = new Float64Array(3);
  const gPrev = new Float64Array(n), gNow = new Float64Array(n);
  const span = Math.max(tEnd - epoch, 0) + Math.max(epoch - tStart, 0);
  const cap = new Int32Array(n), cnt = new Int32Array(n);
  const trT = [], trB = [], trV = [], trD = [], trZ = [];
  for (let i = 0; i < n; i++) {
    cap[i] = i && wantTr ? opt.maxTransits || Math.ceil((1.5 * span) / sys.per[i]) + 8 : 0;
    trT.push(new Float64Array(cap[i])); trB.push(new Float64Array(cap[i])); trV.push(new Float64Array(cap[i])); trD.push(new Float64Array(cap[i])); trZ.push(new Float64Array(cap[i]));
  }
  const times = opt.times ? Float64Array.from(opt.times) : new Float64Array(0), nt = times.length;
  const tIdx = Array.from({ length: nt }, (_, i) => i).sort((p, q) => times[p] - times[q]);
  const rv = new Float64Array(nt), wantPos = !!opt.positions && nt > 0;
  const samples = wantPos ? Array.from({ length: n }, () => new Float64Array(3 * nt)) : null;
  let status = 'ok', steps = 0, fevals = 0;
  const e0 = energy(n, m, sys.x, sys.v), L0 = angularMomentum(n, m, sys.x, sys.v), L0n = Math.hypot(L0[0], L0[1], L0[2]);
  let eMax = 0, eFinal = e0, lErr = 0;
  const endState = { t: epoch, x: Float64Array.from(sys.x), v: Float64Array.from(sys.v) };

  // ---- event function and its time derivative (two-body acceleration) for body i from an inertial state
  let gVal = 0, gDer = 0;
  const evalG = (X, V, i) => {
    const k = 3 * i, rx = X[k] - X[0], ry = X[k + 1] - X[1], vx = V[k] - V[0], vy = V[k + 1] - V[1];
    if (conj) { gVal = rx * sys.nodeC[i] + ry * sys.nodeS[i]; gDer = vx * sys.nodeC[i] + vy * sys.nodeS[i]; return gVal; }
    const rz = X[k + 2] - X[2], r2 = rx * rx + ry * ry + rz * rz, w = -G * (m[0] + m[i]) / (r2 * Math.sqrt(r2));
    gVal = rx * vx + ry * vy; gDer = vx * vx + vy * vy + w * (rx * rx + ry * ry);
    return gVal;
  };
  const evalAll = (X, V, out) => { for (let i = 1; i < n; i++) out[i] = evalG(X, V, i); };

  // ---- store one transit of body i: (X, V) is the inertial state at time t, already near the root
  const record = (i, t, X, V) => {
    const k = 3 * i, mui = G * (m[0] + m[i]);
    mx[0] = X[k] - X[0]; mx[1] = X[k + 1] - X[1]; mx[2] = X[k + 2] - X[2];
    mv[0] = V[k] - V[0]; mv[1] = V[k + 1] - V[1]; mv[2] = V[k + 2] - V[2];
    // Newton polish on the two-body arc through this state
    let del = 0;
    for (let it = 0; it < 8; it++) {
      kx[0] = mx[0]; kx[1] = mx[1]; kx[2] = mx[2]; kv[0] = mv[0]; kv[1] = mv[1]; kv[2] = mv[2];
      if (del !== 0 && !keplerDrift(kx, kv, 0, mui, del)) return false;
      let g, gd;
      if (conj) { g = kx[0] * sys.nodeC[i] + kx[1] * sys.nodeS[i]; gd = kv[0] * sys.nodeC[i] + kv[1] * sys.nodeS[i]; }
      else { const r2 = kx[0] * kx[0] + kx[1] * kx[1] + kx[2] * kx[2], w = -mui / (r2 * Math.sqrt(r2)); g = kx[0] * kv[0] + kx[1] * kv[1]; gd = kv[0] * kv[0] + kv[1] * kv[1] + w * (kx[0] * kx[0] + kx[1] * kx[1]); }
      const d = -g / gd;
      if (!(Math.abs(d) < 0.25 * sys.per[i])) break;
      del += d;
      if (Math.abs(d) < 1e-13 * sys.per[i]) { kx[0] = mx[0]; kx[1] = mx[1]; kx[2] = mx[2]; kv[0] = mv[0]; kv[1] = mv[1]; kv[2] = mv[2]; if (del !== 0) keplerDrift(kx, kv, 0, mui, del); break; }
    }
    if (!(kx[2] > 0)) return true;                                 // behind the star: an occultation, not stored
    const tt = t + del;
    if (tt < tStart - 1e-9 || tt > tEnd + 1e-9) return true;
    if (cnt[i] >= cap[i]) { if (!warnings.length || !warnings[warnings.length - 1].startsWith('More transits')) warnings.push('More transits than the reserved capacity; pass maxTransits.'); return true; }
    const c = cnt[i]++, bs = Math.hypot(kx[0], kx[1]), vs = Math.hypot(kv[0], kv[1]);
    trT[i][c] = tt; trB[i][c] = bs * lenU; trV[i][c] = vs * lenU; trZ[i][c] = kx[2] * lenU; trD[i][c] = 0;
    if (sys.rstarAU > 0) {
      const Lc = (1 + sys.rprs[i]) * sys.rstarAU;
      if (bs < Lc) {
        // contacts: |R_sky| = (1 + k) R*, by Newton on the two-body arc, each side
        const cx = kx[0], cy = kx[1], cz = kx[2], cvx = kv[0], cvy = kv[1], cvz = kv[2];
        let dur = 0;
        for (let side = -1; side <= 1; side += 2) {
          let d = (side * Math.sqrt(Lc * Lc - bs * bs)) / vs;
          for (let it = 0; it < 8; it++) {
            kx[0] = cx; kx[1] = cy; kx[2] = cz; kv[0] = cvx; kv[1] = cvy; kv[2] = cvz;
            keplerDrift(kx, kv, 0, mui, d);
            const h = kx[0] * kx[0] + kx[1] * kx[1] - Lc * Lc, hd = 2 * (kx[0] * kv[0] + kx[1] * kv[1]), dd = -h / hd;
            d += dd; if (Math.abs(dd) < 1e-12) break;
          }
          dur += side * d;
        }
        trD[i][c] = dur;
      }
    }
    return true;
  };

  // ---- outputs: radial velocity and positions from an inertial state
  const output = (j, X, V) => {
    rv[j] = -V[2] * NB.AUday_ms;
    if (wantPos) for (let i = 0; i < n; i++) { const s = samples[i]; s[3 * j] = X[3 * i] * lenU; s[3 * j + 1] = X[3 * i + 1] * lenU; s[3 * j + 2] = X[3 * i + 2] * lenU; }
  };
  const monitor = (X, V) => {
    const e = energy(n, m, X, V), r = e0 !== 0 ? Math.abs((e - e0) / e0) : 0; if (r > eMax) eMax = r; eFinal = e;
    const L = angularMomentum(n, m, X, V); if (L0n > 0) lErr = Math.max(lErr, Math.hypot(L[0] - L0[0], L[1] - L0[1], L[2] - L0[2]) / L0n);
  };

  // =========================================================================================================
  // Wisdom-Holman
  // =========================================================================================================
  const kepAll = (XJ, VJ, h) => {
    for (let i = 1; i < n; i++) if (!keplerDrift(XJ, VJ, 3 * i, mu[i], h)) return false;
    XJ[0] += h * VJ[0]; XJ[1] += h * VJ[1]; XJ[2] += h * VJ[2];
    return true;
  };
  const kick = (XJ, VJ, h, track) => {
    fromJacobi(n, m, eta, XJ, x);
    accel(n, m, x, a, true, track ? pmin : null); fevals++;
    toJacobi(n, m, a, aj);
    for (let i = 1, k = 3; i < n; i++, k += 3) {
      let ax = aj[k], ay = aj[k + 1], az = aj[k + 2];
      if (i > 1) { const rx = XJ[k], ry = XJ[k + 1], rz = XJ[k + 2], r2 = rx * rx + ry * ry + rz * rz, w = mu[i] / (r2 * Math.sqrt(r2)); ax += w * rx; ay += w * ry; az += w * rz; }
      VJ[k] += h * ax; VJ[k + 1] += h * ay; VJ[k + 2] += h * az;
    }
  };
  const corrZ = (XJ, VJ, ca, cb) => { kepAll(XJ, VJ, ca); kick(XJ, VJ, -cb, false); kepAll(XJ, VJ, -2 * ca); kick(XJ, VJ, cb, false); kepAll(XJ, VJ, ca); };
  const corrB = corr ? CORR_B[corr] : null;
  if (corr && !corrB) throw new Error('corrector must be 0, 3, 5, 7 or 11');
  const corrector = (XJ, VJ, h, inv) => {
    const nb = corrB.length;
    if (nb === 1) { corrZ(XJ, VJ, CA1 * h, -inv * corrB[0] * h); corrZ(XJ, VJ, -CA1 * h, inv * corrB[0] * h); return; }
    for (let q = 0; q < nb; q++) corrZ(XJ, VJ, -(nb - q) * CA1 * h, -inv * corrB[q] * h);
    for (let q = nb - 1; q >= 0; q--) corrZ(XJ, VJ, (nb - q) * CA1 * h, inv * corrB[q] * h);
  };
  /** One uncorrected step of length tau from the base state into (sxj, svj) and (ox, ov). */
  const subStep = (tau) => {
    sxj.set(bxj); svj.set(bvj);
    if (tau !== 0) { if (!kepAll(sxj, svj, 0.5 * tau)) return false; kick(sxj, svj, tau, false); if (!kepAll(sxj, svj, 0.5 * tau)) return false; }
    fromJacobi(n, m, eta, sxj, ox); fromJacobi(n, m, eta, svj, ov);
    return true;
  };

  const runWH = (dir, tStop) => {
    const h = dir * dt0, K = Math.max(1, Math.ceil((Math.abs(tStop - epoch) / dt0) * (1 - 1e-12)));
    toJacobi(n, m, sys.x, xj); toJacobi(n, m, sys.v, vj);
    // base for the first half window: the true initial state
    bxj.set(xj); bvj.set(vj);
    let baseK = 0, outPtr = dir > 0 ? 0 : nt - 1;
    const inLeg = (t) => (dir > 0 ? t >= epoch : t < epoch);
    const doOutputs = (k, last) => {
      // all requested times whose nearest step is k
      while (outPtr >= 0 && outPtr < nt) {
        const j = tIdx[outPtr], t = times[j];
        if (!inLeg(t)) { outPtr += dir; continue; }
        const kk = Math.min(K, Math.round(Math.abs(t - epoch) / dt0));
        if (kk > k || (kk === k && false)) break;
        if (kk === k) { if (!subStep(t - (epoch + k * h))) { status = 'unbound'; return; } output(j, ox, ov); }
        outPtr += dir;
        if (last && kk > k) break;
      }
    };
    if (wantTr) { subStep(0); evalAll(ox, ov, gPrev); }
    if (nt) doOutputs(0, false);
    if (corr) corrector(xj, vj, h, 1);
    if (!kepAll(xj, vj, 0.5 * h)) { status = 'unbound'; return; }
    let tPrev = epoch;                                             // nominal time of the previous check point
    for (let k = 1; k <= K; k++) {
      kick(xj, vj, h, true);
      const last = k === K;
      if (!kepAll(xj, vj, last ? 0.5 * h : h)) { status = 'unbound'; return; }
      steps++;
      const tk = epoch + k * h, tNow = last ? tk : tk + 0.5 * h;
      let need = false;
      if (wantTr) {
        fromJacobi(n, m, eta, xj, ox); fromJacobi(n, m, eta, vj, ov);
        evalAll(ox, ov, gNow);
        for (let i = 1; i < n; i++) if (gPrev[i] * dir < 0 && gNow[i] * dir >= 0) need = true;
      }
      if (nt && outPtr >= 0 && outPtr < nt) { const t = times[tIdx[outPtr]]; if (inLeg(t) && Math.min(K, Math.round(Math.abs(t - epoch) / dt0)) <= k) need = true; }
      if (need || last) {
        // synchronised true state at t_k: undo the half drift, then the corrector
        bxj.set(xj); bvj.set(vj);
        if (!last) kepAll(bxj, bvj, -0.5 * h);
        if (corr && (exact || last)) corrector(bxj, bvj, h, -1);
        baseK = k;
        if (wantTr) for (let i = 1; i < n; i++) if (gPrev[i] * dir < 0 && gNow[i] * dir >= 0) {
          // first guess by linear interpolation of g between the two check points, then Newton with re-stepping
          let tau = tPrev + ((tNow - tPrev) * gPrev[i]) / (gPrev[i] - gNow[i]) - tk, good = false;
          for (let it = 0; it < 6; it++) {
            if (!subStep(tau)) { status = 'unbound'; return; }
            evalG(ox, ov, i);
            const d = -gVal / gDer;
            if (Math.abs(d) < 0.02 * dt0) { good = true; break; }
            if (!(Math.abs(d) < 2 * dt0)) break;
            tau += d;
          }
          if (!good) {
            // bisection between the check points
            let lo = tPrev - tk, hi = tNow - tk;
            for (let it = 0; it < 40; it++) { tau = 0.5 * (lo + hi); subStep(tau); if (evalG(ox, ov, i) * dir < 0) lo = tau; else hi = tau; }
          }
          if (!record(i, tk + tau, ox, ov)) { status = 'unbound'; return; }
        }
        if (nt) doOutputs(k, last);
        if (last) {
          // the run ends here: (bxj, bvj) is the final true state
          fromJacobi(n, m, eta, bxj, ox); fromJacobi(n, m, eta, bvj, ov); monitor(ox, ov);
          if (dir > 0) { endState.t = tk; endState.x.set(ox); endState.v.set(ov); }
        }
      }
      if (wantTr) { gPrev.set(gNow); }
      tPrev = tNow;
      if ((k & 255) === 0) { fromJacobi(n, m, eta, vj, ov); let bad = false; for (let q = 0; q < n3; q++) if (!Number.isFinite(x[q]) || !Number.isFinite(ov[q])) bad = true; if (bad) { status = 'unbound'; return; } }
    }
    void baseK;
  };

  // =========================================================================================================
  // IAS15
  // =========================================================================================================
  const runIAS = (dir, tStop) => {
    const eps = opt.epsilon || 1e-9, SAFETY = 0.25;
    const x0 = new Float64Array(n3), v0 = new Float64Array(n3), a0 = new Float64Array(n3), at = new Float64Array(n3), xt = new Float64Array(n3);
    const cx = new Float64Array(n3), cv = new Float64Array(n3);
    const g = new Float64Array(7 * n3), b = new Float64Array(7 * n3), e = new Float64Array(7 * n3), br = new Float64Array(7 * n3), er = new Float64Array(7 * n3);
    x0.set(sys.x); v0.set(sys.v);
    let t = epoch, dt = dir * Math.min(pMin / 50, Math.abs(tStop - epoch) || pMin / 50), dtLast = 0, outPtr = dir > 0 ? 0 : nt - 1;
    const inLeg = (tt) => (dir > 0 ? tt >= epoch : tt < epoch);
    // dense output at fraction hh of the current step
    const dense = (hh, dtc) => {
      const s = dtc * hh;
      for (let q = 0; q < n3; q++) {
        const b0 = b[q], b1 = b[n3 + q], b2 = b[2 * n3 + q], b3 = b[3 * n3 + q], b4 = b[4 * n3 + q], b5 = b[5 * n3 + q], b6 = b[6 * n3 + q];
        ox[q] = x0[q] + s * (v0[q] + s * (a0[q] / 2 + hh * (b0 / 6 + hh * (b1 / 12 + hh * (b2 / 20 + hh * (b3 / 30 + hh * (b4 / 42 + hh * (b5 / 56 + hh * b6 / 72))))))));
        ov[q] = v0[q] + s * (a0[q] + hh * (b0 / 2 + hh * (b1 / 3 + hh * (b2 / 4 + hh * (b3 / 5 + hh * (b4 / 6 + hh * (b5 / 7 + hh * b6 / 8)))))));
      }
    };
    if (wantTr) evalAll(x0, v0, gPrev);
    let guard = 0;
    while (dir * (tStop - t) > 1e-13 * Math.max(1, Math.abs(tStop))) {
      if (++guard > 5e7) { status = 'not converged'; return; }
      let clipped = false, dtNat = dt;
      if (dir * (t + dt - tStop) > 0) { dt = tStop - t; clipped = true; }
      accel(n, m, x0, a0, false, pmin); fevals++;
      // g from b
      for (let q = 0; q < n3; q++) {
        for (let k = 6; k >= 0; k--) { let s = b[k * n3 + q]; for (let l = k + 1; l < 7; l++) s -= GR_C[l][k] * g[l * n3 + q]; g[k * n3 + q] = s; }
      }
      let pcErr = 1e300, pcLast = 2, iter = 0;
      for (;;) {
        if (pcErr < 1e-16) break;
        if (iter > 2 && pcLast <= pcErr) break;
        if (iter >= 12) { if (!warnings.includes('IAS15 predictor-corrector did not converge in a step')) warnings.push('IAS15 predictor-corrector did not converge in a step'); break; }
        pcLast = pcErr; pcErr = 0; iter++;
        let maxA = 0, maxB = 0;
        for (let nn = 1; nn < 8; nn++) {
          const hh = GR_H[nn], s = dt * hh;
          for (let q = 0; q < n3; q++) {
            const b0 = b[q], b1 = b[n3 + q], b2 = b[2 * n3 + q], b3 = b[3 * n3 + q], b4 = b[4 * n3 + q], b5 = b[5 * n3 + q], b6 = b[6 * n3 + q];
            xt[q] = x0[q] + s * (v0[q] + s * (a0[q] / 2 + hh * (b0 / 6 + hh * (b1 / 12 + hh * (b2 / 20 + hh * (b3 / 30 + hh * (b4 / 42 + hh * (b5 / 56 + hh * b6 / 72))))))));
          }
          accel(n, m, xt, at, false, pmin); fevals++;
          const kq = (nn - 1) * n3, Ck = GR_C[nn - 1];
          for (let q = 0; q < n3; q++) {
            let val = (at[q] - a0[q]) / hh;
            for (let l = 1; l < nn; l++) val = (val - g[(l - 1) * n3 + q]) / (hh - GR_H[l]);
            const tmp = val - g[kq + q]; g[kq + q] = val;
            for (let j = 0; j < nn; j++) b[j * n3 + q] += tmp * Ck[j];
            if (nn === 7) { const ab = Math.abs(tmp), aa = Math.abs(at[q]); if (ab > maxB) maxB = ab; if (aa > maxA) maxA = aa; }
          }
        }
        pcErr = maxB / maxA;
      }
      // step size control (global criterion of Rein & Spiegel 2015)
      let maxA = 0, maxB6 = 0;
      for (let q = 0; q < n3; q++) { const aa = Math.abs(at[q]), bb = Math.abs(b[6 * n3 + q]); if (aa > maxA) maxA = aa; if (bb > maxB6) maxB6 = bb; }
      const err = maxB6 / maxA, dtDone = dt;
      let dtNew = err > 0 && Number.isFinite(err) ? Math.pow(eps / err, 1 / 7) * dtDone : dtDone / SAFETY;
      if (Math.abs(dtNew / dtDone) < SAFETY) {
        // reject and retry with the smaller step
        dt = dtNew;
        if (dtLast !== 0) predict(dt / dtLast, er, br, e, b, n3);
        continue;
      }
      if (Math.abs(dtNew / dtDone) > 1 / SAFETY) dtNew = dtDone / SAFETY;
      if (clipped && Math.abs(dtNew) < Math.abs(dtNat)) dtNat = dtNew; else if (!clipped) dtNat = dtNew;
      // ---- the step is accepted: events and outputs inside it, from the interpolating polynomial
      const t1 = t + dtDone;
      dense(1, dtDone);
      if (wantTr) {
        evalAll(ox, ov, gNow);
        for (let i = 1; i < n; i++) if (gPrev[i] * dir < 0 && gNow[i] * dir >= 0) {
          // Illinois regula falsi on the fraction of the step
          let lo = 0, hi = 1, glo = gPrev[i], ghi = gNow[i], hh = 0.5, side = 0;
          for (let it = 0; it < 60; it++) {
            hh = (lo * ghi - hi * glo) / (ghi - glo);
            dense(hh, dtDone); const gm = evalG(ox, ov, i);
            if (Math.abs(gm / gDer) < 1e-12) break;
            if (gm * dir < 0) { lo = hh; glo = gm; if (side === -1) ghi *= 0.5; side = -1; } else { hi = hh; ghi = gm; if (side === 1) glo *= 0.5; side = 1; }
            if (hi - lo < 1e-15) break;
          }
          if (!record(i, t + hh * dtDone, ox, ov)) { status = 'unbound'; return; }
        }
        gPrev.set(gNow);
      }
      while (outPtr >= 0 && outPtr < nt) {
        const j = tIdx[outPtr], tt = times[j];
        if (!inLeg(tt)) { outPtr += dir; continue; }
        if (dir * (tt - t1) > 0) break;
        dense((tt - t) / dtDone, dtDone); output(j, ox, ov); outPtr += dir;
      }
      // ---- advance with compensated summation
      dense(1, dtDone);
      for (let q = 0; q < n3; q++) {
        let y = ox[q] - x0[q] - cx[q], s = x0[q] + y; cx[q] = (s - x0[q]) - y; x0[q] = s;
        y = ov[q] - v0[q] - cv[q]; s = v0[q] + y; cv[q] = (s - v0[q]) - y; v0[q] = s;
      }
      t = t1; steps++; dtLast = dtDone;
      er.set(e); br.set(b);
      dt = dtNat;
      predict(dt / dtDone, er, br, e, b, n3);
      if ((steps & 63) === 0) monitor(x0, v0);
      let fin = true; for (let q = 0; q < n3; q++) if (!Number.isFinite(x0[q])) fin = false;
      if (!fin) { status = 'unbound'; return; }
    }
    monitor(x0, v0);
    if (dir > 0) { endState.t = t; endState.x.set(x0); endState.v.set(v0); }
  };

  // ---- run the legs
  const run = useIAS ? runIAS : runWH;
  if (tEnd > epoch) run(1, tEnd);
  if (status === 'ok' && tStart < epoch) run(-1, tStart);
  if (status === 'ok' && !(tEnd > epoch) && !(tStart < epoch) && nt) { for (let j = 0; j < nt; j++) output(j, sys.x, sys.v); }

  // ---- monitors
  let minSepHill = Infinity, minStar = Infinity;
  for (let i = 1; i < n; i++) {
    if (pmin[i] < minStar * minStar) minStar = Math.sqrt(pmin[i]);
    for (let j = i + 1; j < n; j++) { const rh = mutualHill(sys.a[i], sys.a[j], m[i], m[j], m[0]); if (rh > 0) minSepHill = Math.min(minSepHill, Math.sqrt(pmin[i * n + j]) / rh); }
  }
  if (status === 'ok') {
    if (sys.rstarAU > 0 && minStar < sys.rstarAU) { status = 'unbound'; warnings.push('A planet came within the stellar radius: it would have hit the star.'); }
    else if (!useIAS && minSepHill < 1) { status = 'close encounter'; warnings.push(`Two planets came within ${minSepHill.toFixed(2)} mutual Hill radii. The Wisdom-Holman map is not valid there: rerun with integrator 'ias15'. The system is very likely unstable.`); }
    else if (minSepHill < 1) warnings.push(`Two planets came within ${minSepHill.toFixed(2)} mutual Hill radii: a close encounter, the system is very likely unstable.`);
    if (status === 'ok' && !useIAS && eMax > 1e-4) warnings.push(`The energy changed by ${eMax.toExponential(1)} of its value: the step (${dt0.toPrecision(3)} d) is too long for this system, or the orbits are being disrupted.`);
  } else if (status === 'unbound' && !warnings.length) warnings.push('A planet left its orbit (unbound or non-finite state): the configuration is unstable.');

  // ---- transits, per planet in the caller's order, sorted in time
  const transits = [];
  for (let s = 0; s < sys.np; s++) {
    const i = sys.slot[s], c = cnt[i], idx = Array.from({ length: c }, (_, q) => q).sort((p, q) => trT[i][p] - trT[i][q]);
    const pick = (arr) => Float64Array.from(idx, (q) => arr[q]);
    transits.push({ n: c, t: pick(trT[i]), b: pick(trB[i]), vsky: pick(trV[i]), dur: pick(trD[i]), z: pick(trZ[i]) });
  }
  const t01 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    ok: status === 'ok', status, warnings, integrator: useIAS ? 'ias15' : 'wh', dt: useIAS ? null : dt0, corrector: useIAS ? null : corr, steps, forceEvaluations: fevals, seconds: (t01 - t00) / 1000,
    transits, rv, samples: wantPos ? { x: bodyOrder(samples, sys) } : null,
    energy: { initial: e0, final: eFinal, relErr: e0 !== 0 ? Math.abs((eFinal - e0) / e0) : 0, maxRelErr: eMax }, angmom: { relErr: lErr },
    minSepHill, minStar, state: endState,
  };
}

/** Positions per body in the caller's planet order: [star, planets[0], planets[1], ...]. */
function bodyOrder(samples, sys) { const out = [samples[0]]; for (let s = 0; s < sys.np; s++) out.push(samples[sys.slot[s]]); return out; }

/** IAS15: predict e and b for a step `ratio` times the last one from the stored (er, br). */
function predict(ratio, er, br, e, b, n3) {
  if (ratio > 20 || !(ratio > 0)) { e.fill(0); b.fill(0); return; }
  const q1 = ratio, q2 = q1 * q1, q3 = q1 * q2, q4 = q2 * q2, q5 = q2 * q3, q6 = q3 * q3, q7 = q3 * q4;
  for (let q = 0; q < n3; q++) {
    const b0 = br[q], b1 = br[n3 + q], b2 = br[2 * n3 + q], b3 = br[3 * n3 + q], b4 = br[4 * n3 + q], b5 = br[5 * n3 + q], b6 = br[6 * n3 + q];
    const d0 = b0 - er[q], d1 = b1 - er[n3 + q], d2 = b2 - er[2 * n3 + q], d3 = b3 - er[3 * n3 + q], d4 = b4 - er[4 * n3 + q], d5 = b5 - er[5 * n3 + q], d6 = b6 - er[6 * n3 + q];
    const e0 = q1 * (b6 * 7 + b5 * 6 + b4 * 5 + b3 * 4 + b2 * 3 + b1 * 2 + b0);
    const e1 = q2 * (b6 * 21 + b5 * 15 + b4 * 10 + b3 * 6 + b2 * 3 + b1);
    const e2 = q3 * (b6 * 35 + b5 * 20 + b4 * 10 + b3 * 4 + b2);
    const e3 = q4 * (b6 * 35 + b5 * 15 + b4 * 5 + b3);
    const e4 = q5 * (b6 * 21 + b5 * 6 + b4);
    const e5 = q6 * (b6 * 7 + b5);
    const e6 = q7 * b6;
    e[q] = e0; e[n3 + q] = e1; e[2 * n3 + q] = e2; e[3 * n3 + q] = e3; e[4 * n3 + q] = e4; e[5 * n3 + q] = e5; e[6 * n3 + q] = e6;
    b[q] = e0 + d0; b[n3 + q] = e1 + d1; b[2 * n3 + q] = e2 + d2; b[3 * n3 + q] = e3 + d3; b[4 * n3 + q] = e4 + d4; b[5 * n3 + q] = e5 + d5; b[6 * n3 + q] = e6 + d6;
  }
}

/**
 * One call from parameters to results: simulate(buildSystem(p), opt).
 * p as in buildSystem; opt as in simulate. Returns the simulate result with `system` attached.
 */
export function nbody(p, opt = {}) {
  const sys = buildSystem(p), r = simulate(sys, opt);
  r.system = sys;
  return r;
}

// ------------------------------------------------------------------------------------------------------------
// Likelihood hook
// ------------------------------------------------------------------------------------------------------------

/**
 * Dynamical transit times and radial velocities in place of the Keplerian ones.
 *
 * system: { mstar [M_sun], rstar [R_sun, optional], epoch [d, default earliest tmid], coords,
 *           planets: [{ per, tmid, ecc, omega [deg], inc [deg], Omega [deg, optional], mplanet [M_Jup] }] }
 *         times in any consistent system (the app uses days relative to data.tRef)
 * req:    { timing: [{ planet: index into system.planets, t: observed mid-transit times }],
 *           rv:     [{ t: times }],
 *           event: 'conjunction' (default here) | 'minsep',
 *           integrator, dt, stepsPerOrbit, corrector, exactSync, epsilon   (passed to simulate),
 *           pad: extra time simulated beyond the first and last datum, in periods of the longest orbit (default 0.6) }
 * Returns { ok, status, warnings,
 *           timing: [{ model: Float64Array (simulated mid-transit time nearest each observed one),
 *                      epoch: Int32Array (index of that transit counted from the first simulated one at or after
 *                             the start of the window; consecutive transits differ by 1),
 *                      miss: number of observed times with no simulated transit within half a period }],
 *           rv: [Float64Array m/s, positive = receding, no zero point],
 *           sim: the simulate() result (transits of every planet, energy error, ...) }
 * ok is false when the integration failed, a close encounter invalidated the Wisdom-Holman map, or an observed
 * time has no simulated transit near it (the planet stopped transiting or left).
 */
export function dynamicalModel(system, req = {}) {
  const sys = buildSystem(system), tim = req.timing || [], rvs = req.rv || [];
  let lo = sys.epoch, hi = sys.epoch, pMax = 0;
  for (let i = 1; i < sys.n; i++) pMax = Math.max(pMax, sys.per[i]);
  for (const x of tim) for (let i = 0; i < x.t.length; i++) { if (x.t[i] < lo) lo = x.t[i]; if (x.t[i] > hi) hi = x.t[i]; }
  let nrv = 0; for (const d of rvs) { nrv += d.t.length; for (let i = 0; i < d.t.length; i++) { if (d.t[i] < lo) lo = d.t[i]; if (d.t[i] > hi) hi = d.t[i]; } }
  const pad = (req.pad ?? 0.6) * pMax, times = new Float64Array(nrv);
  { let q = 0; for (const d of rvs) for (let i = 0; i < d.t.length; i++) times[q++] = d.t[i]; }
  const sim = simulate(sys, {
    tStart: lo < sys.epoch ? lo - pad : sys.epoch, tEnd: hi + pad, event: req.event || 'conjunction', times, transits: tim.length > 0,
    integrator: req.integrator, dt: req.dt, stepsPerOrbit: req.stepsPerOrbit, corrector: req.corrector, exactSync: req.exactSync, epsilon: req.epsilon,
  });
  let ok = sim.ok;
  const timing = tim.map((x) => {
    const tr = sim.transits[x.planet] || { n: 0, t: [] }, P = system.planets[x.planet].per, N = x.t.length;
    const model = new Float64Array(N), epoch = new Int32Array(N); let miss = 0;
    for (let i = 0; i < N; i++) {
      // nearest simulated transit by bisection
      let a = 0, b = tr.n - 1;
      if (b < 0) { model[i] = NaN; miss++; continue; }
      while (b - a > 1) { const c = (a + b) >> 1; if (tr.t[c] <= x.t[i]) a = c; else b = c; }
      const j = Math.abs(tr.t[a] - x.t[i]) <= Math.abs(tr.t[b] - x.t[i]) ? a : b;
      model[i] = tr.t[j]; epoch[i] = j;
      if (!(Math.abs(tr.t[j] - x.t[i]) < 0.5 * P)) miss++;
    }
    if (miss) ok = false;
    return { model, epoch, miss };
  });
  const rv = []; { let q = 0; for (const d of rvs) { rv.push(sim.rv.slice(q, q + d.t.length)); q += d.t.length; } }
  return { ok, status: sim.status, warnings: sim.warnings, timing, rv, sim };
}

/**
 * A timing likelihood on dynamical transit times, as a stand-alone problem for MiniNest (nested.js):
 *   lnL = sum_i -0.5 [ (t_i - T_nbody(E_i))^2 / s_i^2 + ln(2 pi s_i^2) ],   s_i^2 = err_i^2 + noise^2
 * spec = {
 *   system: as in dynamicalModel (the starting values),
 *   timing: [{ planet: index, t, e }],
 *   free:   [{ key, prior }]   key = '<field>@<planet index>' with field one of per, tmid, ecc, omega, inc, Omega,
 *                              mplanet, or 'mstar'; prior as in priors.js ({ type, a, b })
 *   linear: true to remove, for each timing set, the best straight line in transit number from the residuals
 *           before chi-square (a profile over that planet's T0 and period, as ttvGrid does). Then `per` and `tmid`
 *           of that planet need not be free: two fewer dimensions, and they are the two most tightly constrained,
 *   noise:  days, added in quadrature (default 0),
 *   sim:    options passed to dynamicalModel (integrator, dt, stepsPerOrbit, corrector, event ...)
 * }
 * Returns { ndim, keys, transform(u, theta), loglike(theta), detail(theta) -> { lnL, chi2, dyn, system } }.
 */
export function nbodyTimingProblem(spec) {
  const keys = spec.free.map((f) => f.key), tf = spec.free.map((f) => makeTransform(f.prior));
  const base = { ...spec.system, planets: spec.system.planets.map((q) => ({ ...q })) };
  const where = keys.map((k) => { const [f, p] = k.split('@'); return p === undefined ? { f } : { f, p: +p }; });
  const noise2 = (spec.noise || 0) ** 2, BAD = -1e100;
  const evaluate = (theta) => {
    for (let i = 0; i < keys.length; i++) { const w = where[i]; if (w.p === undefined) base[w.f] = theta[i]; else base.planets[w.p][w.f] = theta[i]; }
    for (const q of base.planets) if (!(q.per > 0) || !(q.ecc >= 0 && q.ecc < 0.99) || !(q.mplanet >= 0)) return null;
    let dyn;
    try { dyn = dynamicalModel(base, { ...(spec.sim || {}), timing: spec.timing }); } catch { return null; }
    if (!dyn.ok) return null;
    let lnL = 0, chi2 = 0;
    spec.timing.forEach((x, k) => {
      const mod = dyn.timing[k].model, ep = dyn.timing[k].epoch, N = x.t.length;
      let c0 = 0, c1 = 0, eM = 0;
      if (spec.linear && N > 2) {
        // best straight line in transit number through the residuals (profiles out T0 and P of this planet)
        let sw = 0, swe = 0; for (let i = 0; i < N; i++) { const w = 1 / (x.e[i] * x.e[i] + noise2); sw += w; swe += w * ep[i]; }
        eM = swe / sw; let a = 0, b = 0, c = 0, d = 0, f = 0;
        for (let i = 0; i < N; i++) { const w = 1 / (x.e[i] * x.e[i] + noise2), E = ep[i] - eM, r = x.t[i] - mod[i]; a += w; b += w * E; c += w * E * E; d += w * r; f += w * E * r; }
        const det = a * c - b * b; if (det > 0) { c0 = (c * d - b * f) / det; c1 = (a * f - b * d) / det; }
      }
      for (let i = 0; i < N; i++) { const s2 = x.e[i] * x.e[i] + noise2, r = x.t[i] - mod[i] - c0 - c1 * (ep[i] - eM); chi2 += (r * r) / s2; lnL += -0.5 * ((r * r) / s2 + Math.log(s2) + 1.8378770664093453); }
    });
    return { lnL, chi2, dyn, system: base };
  };
  return {
    ndim: keys.length, keys,
    transform(u, theta) { for (let i = 0; i < tf.length; i++) theta[i] = tf[i](u[i]); },
    loglike(theta) { const r = evaluate(theta); return r ? r.lnL : BAD; },
    detail: evaluate,
  };
}

// ------------------------------------------------------------------------------------------------------------
// TTV products
// ------------------------------------------------------------------------------------------------------------

/**
 * O - C of a sequence of mid-transit times against its best linear ephemeris, and what is periodic in it.
 * times: consecutive transits (days). opt: { errs (default: equal weights), epochs (default 0, 1, 2, ...),
 *        periodogram: true (default) to run timingPeriodogram (needs at least 6 times), sigma: nominal error in
 *        days used when errs is not given (default 1 s; it only sets the scale of chi-square) }
 * Returns { n, epochs, t0, per (linear ephemeris), oc (days), rms, amplitude (half the peak-to-peak, days),
 *           periods: [{ period (epochs), periodDays, power, amp (days, of the fitted sinusoid when it is the first) }],
 *           pg: the timingPeriodogram result or null }.
 * With noiseless simulated times the false-alarm probabilities in pg are meaningless (the error bars are nominal);
 * the periods and amplitudes are not affected.
 */
export function ttvSummary(times, opt = {}) {
  const n = times.length, epochs = opt.epochs ? Array.from(opt.epochs) : Array.from({ length: n }, (_, i) => i);
  const errs = opt.errs ? Array.from(opt.errs) : new Array(n).fill(opt.sigma || 1 / 86400);
  if (n < 3) return { n, epochs, t0: times[0], per: NaN, oc: new Float64Array(n), rms: 0, amplitude: 0, periods: [], pg: null };
  const T = Array.from(times), fit = fitEphemeris(epochs, T, errs, 1);
  const oc = Float64Array.from(T, (_, i) => fit.residual(i));
  let lo = Infinity, hi = -Infinity, s2 = 0; for (const r of oc) { lo = Math.min(lo, r); hi = Math.max(hi, r); s2 += r * r; }
  let pg = null, periods = [];
  if (opt.periodogram !== false && n >= 6 && hi - lo > 0) {
    try {
      pg = timingPeriodogram(epochs, T, errs, { nPeaks: 5, ...(opt.pgOpt || {}) });
      periods = pg.periodograms[0].peaks.map((p, i) => ({ period: p.period, periodDays: p.periodDays, power: p.power, amp: i === 0 && pg.models[1] ? pg.models[1].terms[0].amp : null }));
    } catch { pg = null; }
  }
  return { n, epochs, t0: fit.t0, per: fit.per, oc, rms: Math.sqrt(s2 / n), amplitude: 0.5 * (hi - lo), periods, pg };
}

// ---- analytic expectations --------------------------------------------------------------------------------

/** Laplace coefficient b_s^(j)(alpha) and its derivative with respect to alpha, by the trapezoid rule (spectrally accurate). */
export function laplaceCoefficient(s, j, alpha) {
  const N = 2048; let b = 0, db = 0;
  for (let k = 0; k < N; k++) {
    const th = (TWO_PI * k) / N, c = Math.cos(th), den = 1 - 2 * alpha * c + alpha * alpha, cj = Math.cos(j * th);
    b += cj * Math.pow(den, -s); db += cj * (-s) * (2 * alpha - 2 * c) * Math.pow(den, -s - 1);
  }
  return { b: (2 * b) / N, db: (2 * db) / N };
}

/**
 * The first-order mean-motion resonance j : j-1 nearest to a pair of periods (inner P1 < outer P2).
 * Returns { j, delta (normalised distance  (P2/P1) (j-1)/j - 1), superPeriod (days) = 1 / |j/P2 - (j-1)/P1| }.
 * The super-period is the period of the near-resonant TTV of both planets (Lithwick, Xie & Wu 2012, eq. 5).
 */
export function nearestFirstOrder(P1, P2) {
  if (P1 > P2) [P1, P2] = [P2, P1];
  let best = null;
  for (let j = 2; j <= 12; j++) { const delta = (P2 / P1) * ((j - 1) / j) - 1; if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { j, delta }; }
  best.superPeriod = 1 / Math.abs(best.j / P2 - (best.j - 1) / P1);
  return best;
}

/**
 * Near-resonant TTV of a pair close to a first-order resonance (Lithwick, Xie & Wu 2012, eqs. 8-10 and A1-A2):
 *   V1 = P1 mu2 / (pi j^(2/3) (j-1)^(1/3) Delta) * (-f - (3/2) conj(Zfree) / Delta)
 *   V2 = P2 mu1 / (pi j Delta)                   * (-g + (3/2) conj(Zfree) / Delta),     Zfree = f z1 + g z2
 * with mu = planet/star mass ratio, z = e exp(i pomega), and the TTV of planet k a sinusoid of amplitude |Vk| at
 * the super-period. f and g are the sums of Laplace coefficients evaluated at the actual period ratio.
 * P1, P2 must be the MEAN periods (those of the ephemerides), not osculating periods at some instant: a
 * Jupiter-mass neighbour shifts the osculating period by a few tenths of a percent, which near a resonance
 * changes Delta, and with it the super-period and the amplitude, by ten percent or more.
 * p = { mstar [M_sun], P1, P2 [d], m1, m2 [M_Jup], e1 = 0, e2 = 0, omega1 = 0, omega2 = 0 [deg, kepler.js convention] }
 * Longitudes of pericentre are measured from the line of sight, pomega = omega - 90 deg (coplanar, Omega = 0).
 * Returns { j, delta, superPeriod, f, g, V1: [re, im], V2: [re, im], amp1, amp2 (days), zfree: [re, im], valid }.
 * valid is false within |Delta| < about 2 (mu)^(2/3) of the resonance, where the formula (linear in the masses,
 * no libration) does not apply, and for |Delta| > 0.1 where other terms are as large.
 */
export function lithwickTTV(p) {
  const P1 = Math.min(p.P1, p.P2), P2 = Math.max(p.P1, p.P2), r = nearestFirstOrder(P1, P2), j = r.j, D = r.delta;
  const alpha = Math.pow(P1 / P2, 2 / 3), bj = laplaceCoefficient(0.5, j, alpha), bj1 = laplaceCoefficient(0.5, j - 1, alpha);
  const f = -(j * bj.b + 0.5 * alpha * bj.db), g = (j - 0.5) * bj1.b + 0.5 * alpha * bj1.db - (j === 2 ? 0.5 / (alpha * alpha) : 0);
  const mu1 = ((p.m1 || 0) * NB.Mjup) / p.mstar, mu2 = ((p.m2 || 0) * NB.Mjup) / p.mstar;
  const w1 = ((p.omega1 || 0) - 90) * DEG, w2 = ((p.omega2 || 0) - 90) * DEG, e1 = p.e1 || 0, e2 = p.e2 || 0;
  const zr = f * e1 * Math.cos(w1) + g * e2 * Math.cos(w2), zi = f * e1 * Math.sin(w1) + g * e2 * Math.sin(w2);
  const c1 = (P1 * mu2) / (Math.PI * Math.pow(j, 2 / 3) * Math.cbrt(j - 1) * D), c2 = (P2 * mu1) / (Math.PI * j * D);
  const V1 = [c1 * (-f - (1.5 * zr) / D), c1 * ((1.5 * zi) / D)], V2 = [c2 * (-g + (1.5 * zr) / D), c2 * ((-1.5 * zi) / D)];
  return { j, delta: D, superPeriod: r.superPeriod, f, g, V1, V2, amp1: Math.hypot(V1[0], V1[1]), amp2: Math.hypot(V2[0], V2[1]), zfree: [zr, zi],
    valid: Math.abs(D) < 0.1 && Math.abs(D) > 2 * Math.pow(Math.max(mu1, mu2), 2 / 3) };
}

/**
 * Order-of-magnitude TTV scalings of Agol, Steffen, Sari & Clarkson (2005) for a transiting planet (period P,
 * mass m) and a perturber (period Pp, mass mp, eccentricity ep). Masses in M_Jup, mstar in M_sun, times in days.
 * Returns {
 *   regime: 'interior' | 'exterior',
 *   wobble:     interior perturber, star's reflex motion (their eq. 7): amplitude  (mp/M*) (Pp/P)^(2/3) P / (2 pi)
 *               (0 for an exterior perturber),
 *   tidal:      exterior perturber on an eccentric orbit with Pp >> P (their eq. 25, after Borkovits et al. 2003):
 *               dt = beta (f - M + ep sin f),  beta = mp / (2 pi (M* + m)) (P^2 / Pp) (1 - ep^2)^(-3/2);
 *               the value returned is the half range of that expression over one orbit of the perturber
 *               (0 for a circular or interior perturber),
 *   resonant:   maximum for a pair IN a first-order j:j+1 resonance (their eq. 33):  P / (4.5 j) mp / (mp + m),
 *   libration:  period of that resonant TTV (their eq. 32):  0.5 j^(-4/3) ((m + mp)/M*)^(-2/3) P,
 *   j }
 * These are scalings: the tests compare `wobble` and `tidal` with simulations to the stated tolerance; `resonant`
 * and `libration` are quoted as the paper gives them and are not tested here.
 */
export function agolTTV(p) {
  const M = p.mstar, m = (p.m || 0) * NB.Mjup, mp = (p.mp || 0) * NB.Mjup, P = p.P, Pp = p.Pp, ep = p.ep || 0;
  const interior = Pp < P, r = nearestFirstOrder(P, Pp), j = Math.max(1, r.j - 1);
  let tidal = 0;
  if (!interior && ep > 0) {
    const beta = (mp / (TWO_PI * (M + m))) * ((P * P) / Pp) * Math.pow(1 - ep * ep, -1.5);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 720; k++) { const Mm = (TWO_PI * k) / 720 - Math.PI, E = solveKepler(Mm, ep), f = trueAnomaly(E, ep), val = f - Mm + ep * Math.sin(f); lo = Math.min(lo, val); hi = Math.max(hi, val); }
    tidal = 0.5 * beta * (hi - lo);
  }
  return {
    regime: interior ? 'interior' : 'exterior',
    wobble: interior ? (mp / M) * Math.pow(Pp / P, 2 / 3) * P / TWO_PI : 0,
    tidal, resonant: (P / (4.5 * j)) * (mp / (mp + m || 1)), libration: 0.5 * Math.pow(j, -4 / 3) * Math.pow((m + mp) / M, -2 / 3) * P, j,
  };
}

// ------------------------------------------------------------------------------------------------------------
// Stability
// ------------------------------------------------------------------------------------------------------------

/**
 * Critical relative AMD of a pair for collision (Laskar & Petit 2017, eqs. 35 and 39).
 * alpha = a_inner / a_outer, gamma = m_inner / m_outer. Returns { Cc, e, ep } (the eccentricities at the critical point).
 */
export function amdCritical(alpha, gamma) {
  const F = (e) => alpha * e + (gamma * e) / Math.sqrt(alpha * (1 - e * e) + gamma * gamma * e * e) - 1 + alpha;
  let lo = 0, hi = Math.min(1, 1 / alpha - 1);
  if (gamma === 0) { const ep = 1 - alpha; return { Cc: 1 - Math.sqrt(1 - ep * ep), e: 0, ep }; }
  for (let i = 0; i < 200; i++) { const mid = 0.5 * (lo + hi); if (F(mid) < 0) lo = mid; else hi = mid; }
  const e = 0.5 * (lo + hi), ep = 1 - alpha - alpha * e;
  return { Cc: gamma * Math.sqrt(alpha) * (1 - Math.sqrt(1 - e * e)) + 1 - Math.sqrt(Math.max(0, 1 - ep * ep)), e, ep };
}

/**
 * Stability checks that need no integration, plus (opt.integrate) a short monitored one.
 * p: as in buildSystem. opt: { integrate: number of orbits of the outermost planet to integrate (default 0: none),
 *                              stepsPerOrbit (default 30), shadow: true (default) also integrate a copy displaced by
 *                              1e-10 and report how fast the two diverge }
 * Returns {
 *   pairs: [{ inner, outer (indices into p.planets), periodRatio, deltaHill (separation in mutual Hill radii),
 *             hillStable (deltaHill > 2 sqrt(3), Gladman 1993: two planets on circular coplanar orbits can never
 *             have a close encounter), crossing (the osculating orbits overlap: a_in (1 + e_in) > a_out (1 - e_out)),
 *             amdBeta (AMD / critical AMD of the pair, Laskar & Petit 2017; < 1 means collisions are impossible
 *             as long as the semi-major axes stay put), resonance: { j, delta } }],
 *   amd (total, M_sun AU^2 / d), amdStable (every pair and the star: beta < 1), amdBetaStar (innermost planet reaching the star),
 *   chambers: smallest deltaHill when there are three or more planets (Chambers et al. 1996: below about 10 such
 *             systems go unstable within about 1e8 orbits),
 *   integration: null | { orbits, days, ok, status, energyErr, minSepHill, divergence (growth factor of the
 *                         displacement), chaotic (grew far faster than the shear of regular orbits), seconds },
 *   stable: true | false | null   (null: the criteria do not decide),
 *   findings: [strings]   plain-language statements, most important first
 * }
 */
export function stabilityReport(p, opt = {}) {
  const sys = buildSystem(p), n = sys.n, m = sys.m, findings = [], letter = (b) => p.planets[sys.order[b - 1]].letter || String.fromCharCode(97 + sys.order[b - 1] + 1);
  // osculating elements of each planet relative to the star, and the invariant plane
  const L = angularMomentum(n, m, sys.x, sys.v), Ln = Math.hypot(L[0], L[1], L[2]) || 1;
  const el = [null];
  for (let i = 1; i < n; i++) {
    const k = 3 * i, rx = sys.x[k] - sys.x[0], ry = sys.x[k + 1] - sys.x[1], rz = sys.x[k + 2] - sys.x[2], vx = sys.v[k] - sys.v[0], vy = sys.v[k + 1] - sys.v[1], vz = sys.v[k + 2] - sys.v[2];
    const mu = G * (m[0] + m[i]), r = Math.hypot(rx, ry, rz), v2 = vx * vx + vy * vy + vz * vz, a = 1 / (2 / r - v2 / mu);
    const hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx, h2 = hx * hx + hy * hy + hz * hz;
    const e = Math.sqrt(Math.max(0, 1 - h2 / (mu * a))), cosI = Ln > 0 && m[i] > 0 ? (hx * L[0] + hy * L[1] + hz * L[2]) / (Math.sqrt(h2) * Ln) : 1;
    el.push({ a, e, cosI: Math.min(1, cosI), lam: m[i] * Math.sqrt(G * m[0] * a) });
  }
  let amd = 0; for (let i = 1; i < n; i++) amd += el[i].lam * (1 - Math.sqrt(1 - el[i].e ** 2) * el[i].cosI);
  const pairs = []; let amdStable = true, minDelta = Infinity, anyCross = false, anyHillUnstable = false;
  for (let i = 1; i < n - 1; i++) {
    const A = el[i], B = el[i + 1], rh = mutualHill(A.a, B.a, m[i], m[i + 1], m[0]), deltaHill = rh > 0 ? (B.a - A.a) / rh : Infinity;
    const crossing = A.a * (1 + A.e) > B.a * (1 - B.e), res = nearestFirstOrder(sys.per[i], sys.per[i + 1]);
    let amdBeta = 0;
    if (m[i + 1] > 0) { const cc = amdCritical(A.a / B.a, m[i] / m[i + 1]).Cc; amdBeta = amd / B.lam / cc; } else if (m[i] > 0) amdBeta = Infinity;
    if (amdBeta >= 1) amdStable = false;
    if (crossing) anyCross = true; if (deltaHill < 2 * Math.sqrt(3)) anyHillUnstable = true;
    minDelta = Math.min(minDelta, deltaHill);
    pairs.push({ inner: sys.order[i - 1], outer: sys.order[i], periodRatio: sys.per[i + 1] / sys.per[i], deltaHill, hillStable: deltaHill > 2 * Math.sqrt(3), crossing, amdBeta, resonance: { j: res.j, delta: res.delta } });
  }
  // innermost planet against the star: critical AMD is that of e = 1 (Laskar & Petit 2017, eq. 42)
  let amdBetaStar = 0;
  if (n > 1 && m[1] > 0) { amdBetaStar = amd / el[1].lam; if (amdBetaStar >= 1) amdStable = false; }

  let integration = null;
  if (opt.integrate > 0 && n > 1) {
    let pMax = 0; for (let i = 1; i < n; i++) pMax = Math.max(pMax, sys.per[i]);
    const days = opt.integrate * pMax, so = { tEnd: sys.epoch + days, transits: false, stepsPerOrbit: opt.stepsPerOrbit || 30 };
    const r = simulate(sys, so);
    integration = { orbits: opt.integrate, days, ok: r.ok, status: r.status, energyErr: r.energy.maxRelErr, minSepHill: r.minSepHill, divergence: null, chaotic: null, seconds: r.seconds };
    if (r.ok && opt.shadow !== false) {
      const s2 = { ...sys, x: Float64Array.from(sys.x), v: Float64Array.from(sys.v) }, d0 = 1e-10 * sys.a[1];
      s2.x[3] += d0;
      const r2 = simulate(s2, so);
      if (r2.ok) {
        let d = 0; for (let q = 0; q < 3 * n; q++) d += (r2.state.x[q] - r.state.x[q]) ** 2;
        let pMin = Infinity; for (let i = 1; i < n; i++) pMin = Math.min(pMin, sys.per[i]);
        const growth = Math.sqrt(d) / d0, shear = Math.max(1, (3 * Math.PI * days) / pMin) * Math.max(1, sys.a[n - 1] / sys.a[1]);
        integration.divergence = growth; integration.chaotic = growth > 1e3 * shear; integration.seconds += r2.seconds;
      }
    }
  }

  // ---- findings
  const fx = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'infinite');
  const pctAmd = (v) => (v < 0.001 ? 'under 0.1' : (100 * v).toFixed(1));
  if (integration && !integration.ok) findings.push(`A direct integration over ${integration.orbits} orbits of the outer planet failed (${integration.status}): the configuration is unstable.`);
  for (const q of pairs) if (q.crossing) findings.push(`The orbits of ${letter(sys.slot[q.inner])} and ${letter(sys.slot[q.outer])} cross (inner apastron beyond outer periastron). Only a resonance could protect them.`);
  for (const q of pairs) if (!q.crossing && !q.hillStable) findings.push(`${letter(sys.slot[q.inner])} and ${letter(sys.slot[q.outer])} are ${fx(q.deltaHill)} mutual Hill radii apart, inside the limit of 2√3 ≈ 3.46 below which two planets can have close encounters (Gladman 1993).`);
  if (n > 3 && minDelta < 10 && minDelta >= 2 * Math.sqrt(3)) findings.push(`The tightest pair is ${fx(minDelta)} mutual Hill radii apart. Systems of three or more planets closer than about 10 are usually unstable within 10^8 orbits (Chambers et al. 1996); resonant chains such as TRAPPIST-1 are the known exception.`);
  if (pairs.length && amdStable) findings.push(`AMD-stable (Laskar & Petit 2017): the angular momentum deficit is ${pctAmd(Math.max(amdBetaStar, ...pairs.map((q) => q.amdBeta)))}% of what a collision would need, so no pair can collide while the semi-major axes hold.`);
  else if (pairs.length) findings.push(`Not AMD-stable (Laskar & Petit 2017): the eccentricities and inclinations hold ${fx(Math.max(amdBetaStar, ...pairs.map((q) => q.amdBeta)), 2)} times the angular momentum deficit a collision needs. This does not prove instability, but long-term stability is not guaranteed by the secular dynamics.`);
  for (const q of pairs) if (Math.abs(q.resonance.delta) < 0.002) findings.push(`${letter(sys.slot[q.inner])} and ${letter(sys.slot[q.outer])} have a period ratio within 0.2% of ${q.resonance.j}:${q.resonance.j - 1}: they may be in the resonance, where transit timing variations are large and the Hill and AMD criteria do not apply.`);
  else if (Math.abs(q.resonance.delta) < 0.05) findings.push(`${letter(sys.slot[q.inner])} and ${letter(sys.slot[q.outer])} are ${fx(100 * Math.abs(q.resonance.delta), 1)}% ${q.resonance.delta > 0 ? 'wide' : 'short'} of the ${q.resonance.j}:${q.resonance.j - 1} resonance: expect transit timing variations with a period of ${fx(nearestFirstOrder(sys.per[sys.slot[q.inner]], sys.per[sys.slot[q.outer]]).superPeriod, 1)} d. The Hill and AMD criteria ignore resonances.`);
  if (integration && integration.ok) {
    findings.push(`Integrated for ${integration.orbits} orbits of the outer planet (${fx(integration.days, 0)} d): no close encounter (closest approach ${fx(integration.minSepHill)} mutual Hill radii), energy conserved to ${integration.energyErr.toExponential(1)}.${integration.chaotic === true ? ' Two copies displaced by 1e-10 diverged exponentially: the motion is chaotic on this time scale.' : integration.chaotic === false ? ' Two copies displaced by 1e-10 separated no faster than regular orbits do.' : ''} This says nothing about longer times.`);
  }
  if (n === 2) findings.push('One planet: a two-body orbit, stable.');
  let stable = null;
  if ((integration && (!integration.ok || integration.chaotic)) || anyCross) stable = false;
  else if (n === 2 || (n === 3 && !anyHillUnstable && amdStable) || (amdStable && minDelta > 10)) stable = true;
  return { pairs, amd, amdStable, amdBetaStar, chambers: n > 3 ? minDelta : null, integration, stable, findings };
}

// ------------------------------------------------------------------------------------------------------------
// Interpreting an O - C signal: a grid of simulations over the perturber
// ------------------------------------------------------------------------------------------------------------

/**
 * One simulation of the grid: the transiting planet with a perturber of the given mass [M_Jup], period [d] and
 * starting phase (0..1: fraction of its orbit by which its conjunction follows the start of the simulation),
 * scored against the observed times after a straight line in epoch (T0 and period of the transiting planet) has
 * been removed by weighted least squares. Returns { ok, status, chi2, amp, c0, c1 }.
 */
export function ttvGridSim(prep, mass, period, phase) {
  const { obs, base, opt } = prep;
  const system = { mstar: base.mstar, rstar: base.rstar, epoch: prep.epoch, planets: [
    { ...base.planet, tmid: prep.tmid0 },
    { ecc: 0, omega: 0, inc: base.planet.inc ?? 90, ...(base.perturber || {}), per: period, mplanet: mass, tmid: prep.epoch + phase * period },
  ] };
  let sim;
  try { sim = nbody(system, { tEnd: prep.tEnd, event: 'conjunction', stepsPerOrbit: opt.stepsPerOrbit, corrector: opt.corrector, exactSync: opt.exactSync, dt: opt.dt }); } catch (err) { return { ok: false, status: String(err.message || err), chi2: Infinity, amp: 0 }; }
  prep.nSim++;
  if (!sim.ok) return { ok: false, status: sim.status, chi2: Infinity, amp: 0 };
  const tr = sim.transits[0];
  let sw = 0, swe = 0, swee = 0, swr = 0, swer = 0, swrr = 0;
  for (let i = 0; i < obs.n; i++) {
    const j = obs.epoch[i] - prep.e0;
    if (j < 0 || j >= tr.n) return { ok: false, status: 'missing transits', chi2: Infinity, amp: 0 };
    const r = obs.t[i] - tr.t[j], w = obs.w[i], E = obs.epoch[i] - prep.eMean;
    sw += w; swe += w * E; swee += w * E * E; swr += w * r; swer += w * E * r; swrr += w * r * r;
  }
  const det = sw * swee - swe * swe, c0 = (swee * swr - swe * swer) / det, c1 = (sw * swer - swe * swr) / det;
  // amplitude of the simulated TTV over the simulated span (half peak-to-peak about its own straight line)
  let s0 = 0, s1 = 0, s2 = 0, sy = 0, sxy = 0; const N = tr.n, tA = tr.t[0];
  for (let q = 0; q < N; q++) { const y = tr.t[q] - tA; s0++; s1 += q; s2 += q * q; sy += y; sxy += q * y; }
  const d = s0 * s2 - s1 * s1, A = (s2 * sy - s1 * sxy) / d, B = (s0 * sxy - s1 * sy) / d; let lo = Infinity, hi = -Infinity;
  for (let q = 0; q < N; q++) { const r = tr.t[q] - tA - A - B * q; if (r < lo) lo = r; if (r > hi) hi = r; }
  return { ok: true, status: 'ok', chi2: swrr - c0 * swr - c1 * swer, amp: 0.5 * (hi - lo), c0, c1, system, sim };
}

/**
 * One cell of the grid (exported so a Web Worker can evaluate cells): the best chi-square over the perturber's
 * phase for one mass and one period. Returns { chi2, phase, amp, stable, status }.
 */
export function ttvGridCell(prep, mass, period) {
  const nPh = prep.opt.phases;
  let best = { chi2: Infinity, phase: 0, amp: 0, stable: false, status: 'ok' };
  for (let k = 0; k < nPh; k++) {
    const r = ttvGridSim(prep, mass, period, k / nPh);
    if (!r.ok) { if (best.chi2 === Infinity) best.status = r.status; continue; }
    if (r.chi2 < best.chi2) best = { chi2: r.chi2, phase: k / nPh, amp: r.amp, stable: true, status: 'ok' };
  }
  return best;
}

/**
 * Polish a grid cell: minimise chi-square over (ln mass, period, phase) of the perturber by the Nelder-Mead
 * simplex, starting from `start` = { mass, period, phase } (e.g. ttvGrid(...).best). The chi-square surface is
 * narrow in period and phase (the TTV must stay in step with the data over many super-periods), so the grid
 * minimum is usually a poor fit until it is polished.
 * opt: as ttvGrid, plus { maxSim = 400, tol = 1e-3 (in chi-square) }.
 * Returns { mass, period (osculating, at the start of the simulation), periodMean (mean period between the
 *           perturber's conjunctions: the number to compare with an ephemeris), phase, chi2, ndata, amp (days), nSim, converged,
 *           planet: { per, tmid } of the transiting planet after the linear refit,
 *           oc: { epoch, obs, err, model }  observed O - C and the simulated one at the same epochs, both against the
 *                 straight line fitted to the observations (days),
 *           curve: { E, y } simulated O - C at every epoch of the simulation (days) }.
 */
export function ttvGridRefine(obs, base, start, opt = {}) {
  const prep = ttvGridPrepare(obs, base, opt), maxSim = opt.maxSim || 400;
  const f = (x) => { const m = Math.exp(x[0]); if (!(x[1] > 0) || !(m < 100)) return Infinity; return ttvGridSim(prep, m, x[1], x[2] - Math.floor(x[2])).chi2; };
  const x0 = [Math.log(start.mass), start.period, start.phase || 0], step = [0.1, 0.004 * start.period, 0.02];
  const S = [x0, ...step.map((h, i) => x0.map((v, j) => (i === j ? v + h : v)))].map((x) => ({ x, f: f(x) }));
  let it = 0, converged = false;
  while (prep.nSim < maxSim) {
    S.sort((a, b) => a.f - b.f);
    if (S[3].f - S[0].f < (opt.tol || 1e-3) && it > 10) { converged = true; break; }
    it++;
    const c = [0, 1, 2].map((j) => (S[0].x[j] + S[1].x[j] + S[2].x[j]) / 3), at = (k) => c.map((v, j) => v + k * (S[3].x[j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < S[0].f) { const xe = at(-2), fe = f(xe); S[3] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr }; }
    else if (fr < S[2].f) S[3] = { x: xr, f: fr };
    else { const xc = at(fr < S[3].f ? -0.5 : 0.5), fc = f(xc); if (fc < Math.min(fr, S[3].f)) S[3] = { x: xc, f: fc }; else for (let i = 1; i < 4; i++) { S[i].x = S[i].x.map((v, j) => S[0].x[j] + 0.5 * (v - S[0].x[j])); S[i].f = f(S[i].x); } }
  }
  S.sort((a, b) => a.f - b.f);
  const mass = Math.exp(S[0].x[0]), period = S[0].x[1], phase = S[0].x[2] - Math.floor(S[0].x[2]), r = ttvGridSim(prep, mass, period, phase);
  if (!r.ok) return { mass, period, phase, chi2: Infinity, ndata: prep.obs.n, nSim: prep.nSim, converged: false };
  // observed and simulated O - C against the straight line of the observations
  const P = base.planet.per, tm = base.planet.tmid, o = prep.obs, tr = r.sim.transits[0];
  let a = 0, b = 0, cc = 0, d = 0, g = 0;
  for (let i = 0; i < o.n; i++) { const E = o.epoch[i] - prep.eMean, y = o.t[i] - tm - o.epoch[i] * P; a += o.w[i]; b += o.w[i] * E; cc += o.w[i] * E * E; d += o.w[i] * y; g += o.w[i] * E * y; }
  const det = a * cc - b * b, l0 = (cc * d - b * g) / det, l1 = (a * g - b * d) / det;
  const line = (E) => tm + E * P + l0 + l1 * (E - prep.eMean);
  // the simulation's times shifted by the refit (c0 + c1 E) are the model for the observed times
  const model = (j) => tr.t[j] + r.c0 + r.c1 * (j + prep.e0 - prep.eMean);
  return {
    mass, period, phase, chi2: r.chi2, ndata: o.n, amp: r.amp, nSim: prep.nSim, converged,
    periodMean: r.sim.transits[1].n > 1 ? (r.sim.transits[1].t[r.sim.transits[1].n - 1] - r.sim.transits[1].t[0]) / (r.sim.transits[1].n - 1) : NaN,
    planet: { per: (tr.t[tr.n - 1] - tr.t[0]) / (tr.n - 1) + r.c1, tmid: model(0) },
    oc: { epoch: Array.from(o.epoch), obs: Array.from(o.t, (t, i) => t - line(o.epoch[i])), err: Array.from(o.w, (w) => 1 / Math.sqrt(w)), model: Array.from(o.epoch, (E) => model(E - prep.e0) - line(E)) },
    curve: { E: Array.from({ length: tr.n }, (_, j) => j + prep.e0), y: Array.from({ length: tr.n }, (_, j) => model(j) - line(j + prep.e0)) },
  };
}

/** Shared preparation for ttvGrid and its workers: epochs, weights, the simulation window. */
export function ttvGridPrepare(obsIn, base, optIn = {}) {
  const t = Array.from(obsIn.t), e = Array.from(obsIn.e), n = t.length;
  const P = base.planet.per, tm = base.planet.tmid;
  const epoch = Int32Array.from(t, (x) => Math.round((x - tm) / P));
  let e0 = Infinity, e1 = -Infinity, sw = 0, swe = 0; const w = Float64Array.from(e, (s) => 1 / (s * s));
  for (let i = 0; i < n; i++) { e0 = Math.min(e0, epoch[i]); e1 = Math.max(e1, epoch[i]); sw += w[i]; swe += w[i] * epoch[i]; }
  // the simulation starts half an orbit before the first observed transit so that transit index 0 is epoch e0
  const tmid0 = tm + e0 * P, start = tmid0 - 0.5 * P;
  // chi-square of the straight line alone (no perturber)
  let a = 0, b = 0, c = 0, d = 0, f = 0, g = 0; const eMean = swe / sw;
  for (let i = 0; i < n; i++) { const E = epoch[i] - eMean, r = t[i] - tm - epoch[i] * P; a += w[i]; b += w[i] * E; c += w[i] * E * E; d += w[i] * r; f += w[i] * E * r; g += w[i] * r * r; }
  const det = a * c - b * b, c0 = (c * d - b * f) / det, c1 = (a * f - b * d) / det;
  const opt = { phases: optIn.phases || 8, stepsPerOrbit: optIn.stepsPerOrbit || 20, corrector: optIn.corrector ?? 5, exactSync: optIn.exactSync ?? false, dt: optIn.dt };
  return { obs: { t: Float64Array.from(t), w, epoch, n }, base, opt, epoch: start, tmid0, e0, eMean, tEnd: tm + (e1 + 0.75) * P, chi2Linear: g - c0 * d - c1 * f, nSim: 0 };
}

/**
 * How well does a perturber of each (mass, period) explain observed mid-transit times of one planet?
 * The EXOTIC/Nbody-AI interpretation step (Pearson 2019), but scoring each simulation against the times
 * themselves instead of only the amplitude and period of the periodogram peak.
 *
 * obs:  { t: mid-transit times [d], e: 1-sigma errors [d] }  of the transiting planet
 * base: { mstar [M_sun], rstar [R_sun, optional],
 *         planet: { per, tmid (linear ephemeris of the data), ecc, omega, inc, mplanet [M_Jup] },
 *         perturber: { ecc = 0, omega = 0, inc = planet.inc, Omega = 0 }   fixed properties of the perturber }
 * grid: { mass: [M_Jup ...], period: [days ...]  (or periodRatio: [...] relative to the planet's period) }
 * opt:  { phases = 8        starting orbital phases of the perturber tried in each cell (the best is kept);
 *                           each costs one simulation,
 *         stepsPerOrbit = 20, corrector = 5, exactSync = false, dt       integrator settings (coarser than simulate's
 *                           defaults: a grid needs the shape of the O - C to a few seconds, not the absolute times),
 *         ampTol = 0.3, perTol = 0.15   relative tolerances of the EXOTIC-style mask (needs opt.observed),
 *         observed: { amp [d], period [d] }   amplitude and period of the periodogram peak, for the mask,
 *         onProgress(fraction) }
 * Each simulation spans the data; the transiting planet's T0 and period are refitted linearly for every cell.
 * Returns {
 *   mass, period (Float64Array axes), nm, np,
 *   chi2 (Float64Array nm*np, row = mass index, column = period index; Infinity where no stable simulation),
 *   dchi2 (chi2 - min), amp (simulated TTV half-amplitude of the transiting planet, days), phase (best, 0..1),
 *   stable (Uint8Array), hill (separation in mutual Hill radii),
 *   mask (Uint8Array | null: cells whose simulated amplitude matches opt.observed.amp within ampTol and whose
 *         super-period matches opt.observed.period within perTol: EXOTIC's estimate_prior),
 *   best: { im, ip, mass, period, chi2, phase, amp }, chi2Linear (no perturber), ndata,
 *   region: cells with dchi2 < 2.30, 6.18 (1 and 2 sigma for two parameters): { n1, n2, massRange1, periodRange1 },
 *   nSim, seconds, simsPerSecond
 * }
 */
export function ttvGrid(obs, base, grid, opt = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const prep = ttvGridPrepare(obs, base, opt);
  const mass = Float64Array.from(grid.mass), period = Float64Array.from(grid.period || grid.periodRatio.map((r) => r * base.planet.per));
  const nm = mass.length, np = period.length, N = nm * np;
  const chi2 = new Float64Array(N).fill(Infinity), amp = new Float64Array(N), phase = new Float64Array(N), stable = new Uint8Array(N), hill = new Float64Array(N);
  for (let im = 0; im < nm; im++) {
    for (let ip = 0; ip < np; ip++) {
      const c = ttvGridCell(prep, mass[im], period[ip]), q = im * np + ip;
      chi2[q] = c.chi2; amp[q] = c.amp; phase[q] = c.phase; stable[q] = c.stable && c.chi2 < Infinity ? 1 : 0;
    }
    if (opt.onProgress) opt.onProgress((im + 1) / nm);
  }
  const out = ttvGridAssemble(prep, base, mass, period, chi2, amp, phase, stable, hill, opt);
  out.nSim = prep.nSim; out.seconds = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / 1000; out.simsPerSecond = out.nSim / out.seconds;
  return out;
}

/** Turn filled grid arrays into the ttvGrid result (also used after a worker pool has filled them). */
export function ttvGridAssemble(prep, base, mass, period, chi2, amp, phase, stable, hill, opt = {}) {
  const nm = mass.length, np = period.length, N = nm * np, P = base.planet.per, mpl = (base.planet.mplanet || 0) * NB.Mjup;
  let best = { chi2: Infinity };
  for (let im = 0; im < nm; im++) for (let ip = 0; ip < np; ip++) {
    const q = im * np + ip, a1 = Math.cbrt(P * P), a2 = Math.cbrt(period[ip] * period[ip]);
    const rh = mutualHill(Math.min(a1, a2), Math.max(a1, a2), mpl, mass[im] * NB.Mjup, base.mstar);
    hill[q] = rh > 0 ? Math.abs(a2 - a1) / rh : Infinity;
    if (chi2[q] < best.chi2) best = { im, ip, mass: mass[im], period: period[ip], chi2: chi2[q], phase: phase[q], amp: amp[q] };
  }
  const dchi2 = Float64Array.from(chi2, (c) => c - best.chi2);
  let mask = null;
  if (opt.observed) {
    mask = new Uint8Array(N);
    const aT = opt.ampTol ?? 0.3, pT = opt.perTol ?? 0.15;
    for (let im = 0; im < nm; im++) for (let ip = 0; ip < np; ip++) {
      const q = im * np + ip, sp = nearestFirstOrder(P, period[ip]).superPeriod;
      if (stable[q] && Math.abs(amp[q] / opt.observed.amp - 1) < aT && Math.abs(sp / opt.observed.period - 1) < pT) mask[q] = 1;
    }
  }
  const region = { n1: 0, n2: 0, massRange1: [Infinity, -Infinity], periodRange1: [Infinity, -Infinity] };
  for (let im = 0; im < nm; im++) for (let ip = 0; ip < np; ip++) {
    const d = dchi2[im * np + ip];
    if (d < 6.18) region.n2++;
    if (d < 2.30) { region.n1++; region.massRange1[0] = Math.min(region.massRange1[0], mass[im]); region.massRange1[1] = Math.max(region.massRange1[1], mass[im]); region.periodRange1[0] = Math.min(region.periodRange1[0], period[ip]); region.periodRange1[1] = Math.max(region.periodRange1[1], period[ip]); }
  }
  return { mass, period, nm, np, chi2, dchi2, amp, phase, stable, hill, mask, best, chi2Linear: prep.chi2Linear, ndata: prep.obs.n, region };
}
