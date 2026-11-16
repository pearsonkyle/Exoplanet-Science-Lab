// Physical-viability priors for multi-planet fits: configurations that cannot exist (crossing orbits, planets inside
// each other's Hill spheres, too much angular-momentum deficit, a planet inside the star or its own Roche limit, chaotic
// orbits) get zero prior mass. buildProblem (model.js) calls makePhysicalCheck once and the check at every likelihood
// call, before any model is computed; a point that fails returns the same "outside the prior" value as an unbound orbit.
//
// Each test is off unless spec.physical switches it on:
//   spec.physical = {
//     crossing: true,          radial ranges must not overlap: periastron of every outer planet beyond the apastron of
//                              the planet inside it, a_out (1 - e_out) > a_in (1 + e_in) for every adjacent pair (sorted by period)
//     hill: true,              Gladman (1993) two-planet Hill stability, eccentric and coplanar (eq. 21 there), for every
//                              adjacent pair:  mu^-3 (mu1 + mu2 / l^2) (mu1 g1 + mu2 g2 l)^2 > 1 + 3^(4/3) mu1 mu2 / mu^(4/3),
//                              mu_i = m_i / M*, mu = mu1 + mu2, l = sqrt(a_out / a_in), g_i = sqrt(1 - e_i^2). For circular
//                              orbits this is a_out - a_in > 2 sqrt(3) R_H with R_H = ((m1 + m2) / 3 M*)^(1/3) (a1 + a2) / 2
//                              to leading order in the masses.
//     hillSpacing: 8,          every adjacent pair at least this many mutual Hill radii apart, (a_out - a_in) / R_H
//                              (Chambers et al. 1996 style; about 10 for systems of three or more planets to survive ~1e8 orbits)
//     amd: true,               AMD stability (Laskar & Petit 2017) with coplanar orbits (sky inclinations do not give mutual
//                              ones): C = sum Lambda_k (1 - sqrt(1 - e_k^2)), Lambda_k = m_k sqrt(G M* a_k); every adjacent
//                              pair needs C / Lambda_out < C_c(alpha, gamma) (their eqs. 35, 39; amdCritical in nbody.js) and
//                              the innermost planet C / Lambda_1 < 1 (collision with the star, their eq. 42)
//     roche: true,             periastron of every planet outside the star (a (1 - e) > 1 + Rp/R*) and outside its Roche
//                              limit, a (1 - e) > f Rp/R* (M* / Mp)^(1/3) (all in stellar radii); f = rocheFactor
//     rocheFactor: 2.16,       Rappaport et al. 2013 (centrally condensed planet); 2.44 is the fluid-body value
//     megno: { orbits: 300, max: 2.5 }   (expensive) integrate the variational equations (megno() in nbody.js) for that
//                              many orbits of the outermost planet; reject a failed integration or <Y> above max
//                              (2 for regular motion). Run last, only for points that passed everything else.
//   }
//
// Semi-major axes for the pairwise tests come from Kepler's third law with each planet's period and mass and M*
// (a in au), so they are consistent with the periods even when a/R* is fixed separately. The Roche test uses the
// planet's own a/R* (fitted, fixed or from spec.kepler). Masses are mplanet [M_Jup], or follow from K when a planet
// has K instead; a planet with no mass counts as massless (Hill radius 0: only crossing is then tested for it).
//
// Evidence. A truncated prior removes prior mass: the sampler's Z is then the integral of L pi over the allowed region,
// i.e. the evidence of the model "this prior AND the system is viable" (the constraint acts like data with likelihood
// 0 or 1). The evidence of the renormalised prior pi / V is Z / V, V = the prior mass that passes. physicalPriorVolume()
// estimates V by Monte Carlo from prior draws; ln Z - ln V is the evidence with the renormalised prior. Which to quote
// depends on the question: ln Z compares "viable" models fairly against each other; ln Z - ln V compares one model's
// truncated prior with its untruncated self (it always wins by about -ln V when the data already sit in the allowed region).

import { amdCritical, megno as megnoRun, buildSystem } from './nbody.js';
import { C } from './derive.js';
import { massFromK } from './rv.js';
import { makeRng } from './stats.js';

const TWO_PI = 2 * Math.PI, MJ = C.Mjup_Msun, SQ3 = Math.sqrt(3), C43 = Math.pow(3, 4 / 3);
// G in au^3 / (M_sun d^2)
const G_AU = 2.959122082855911e-4;

/** Which tests a physical-options object switches on (normalises booleans and numbers). */
export function physicalOptions(o) {
  if (!o) return null;
  // camelCase (fit specifications) or snake_case (sessions): hillSpacing / hill_spacing, rocheFactor / roche_factor
  const hs = +(o.hillSpacing ?? o.hill_spacing), rf = +(o.rocheFactor ?? o.roche_factor);
  const out = {
    crossing: !!o.crossing, hill: !!o.hill, hillSpacing: Number.isFinite(hs) && hs > 0 ? hs : 0,
    amd: !!o.amd, roche: !!o.roche, rocheFactor: Number.isFinite(rf) && rf > 0 ? rf : 2.16,
    megno: o.megno ? { orbits: +o.megno.orbits > 0 ? +o.megno.orbits : 300, max: +o.megno.max > 0 ? +o.megno.max : 2.5, seed: o.megno.seed || 1 } : null,
    normalised: true,
  };
  return out.crossing || out.hill || out.hillSpacing || out.amd || out.roche || out.megno ? out : null;
}

/**
 * Gladman (1993) Hill-stability margin of two planets on coplanar orbits: LHS / RHS - 1 of his eq. 21 (positive: Hill
 * stable, close encounters impossible). mu1, mu2: masses over the star's; a1 < a2 (any unit); e1, e2 eccentricities.
 */
export function gladmanMargin(mu1, mu2, a1, a2, e1 = 0, e2 = 0) {
  const mu = mu1 + mu2;
  if (!(mu > 0)) return a2 * (1 - e2) > a1 * (1 + e1) ? Infinity : -1;
  const l = Math.sqrt(a2 / a1), g1 = Math.sqrt(1 - e1 * e1), g2 = Math.sqrt(1 - e2 * e2);
  const lhs = Math.pow(mu, -3) * (mu1 + mu2 / (l * l)) * (mu1 * g1 + mu2 * g2 * l) ** 2;
  const rhs = 1 + (C43 * mu1 * mu2) / Math.pow(mu, 4 / 3);
  return lhs / rhs - 1;
}

/** Mutual Hill radius ((m1 + m2) / 3 M*)^(1/3) (a1 + a2) / 2 (masses over the star's). */
export const mutualHillRadius = (mu1, mu2, a1, a2) => 0.5 * (a1 + a2) * Math.cbrt((mu1 + mu2) / 3);

/**
 * AMD stability of coplanar orbits (Laskar & Petit 2017). planets: [{ m (any unit, same for all), a (any unit), e }]
 * sorted by a. Returns { amd (in units of m sqrt(a), G M* = 1), betaStar (C / Lambda_1), pairs: [{ beta, Cc, alpha, gamma }],
 * stable }. beta = C / (Lambda_out C_c(alpha, gamma)); stable when every beta < 1.
 */
export function amdStability(planets) {
  const lam = planets.map((p) => p.m * Math.sqrt(p.a));
  let amd = 0; planets.forEach((p, k) => (amd += lam[k] * (1 - Math.sqrt(1 - p.e * p.e))));
  const pairs = []; let stable = true;
  for (let k = 0; k < planets.length - 1; k++) {
    const A = planets[k], B = planets[k + 1];
    let beta;
    if (B.m > 0) { const cc = amdCritical(A.a / B.a, A.m / B.m).Cc; beta = amd / lam[k + 1] / cc; pairs.push({ beta, Cc: cc, alpha: A.a / B.a, gamma: A.m / B.m }); }
    else { beta = A.m > 0 && amd > 0 ? Infinity : 0; pairs.push({ beta, Cc: NaN, alpha: A.a / B.a, gamma: Infinity }); }
    if (!(beta < 1)) stable = false;
  }
  const betaStar = planets.length && lam[0] > 0 ? amd / lam[0] : 0;
  if (!(betaStar < 1)) stable = false;
  return { amd, betaStar, pairs, stable };
}

/**
 * Compile the checks. opts: physicalOptions(spec.physical) (or the raw object). Returns null when nothing is on, else
 * check(planets, mstar) -> null when viable or a short reason string ('crossing', 'hill', 'hillSpacing', 'amd', 'roche',
 * 'surface', 'megno'). planets: [{ per, ecc, omega, inc, mplanet (M_Jup), K, rprs, ars, tmid }], mstar [M_sun].
 */
export function makePhysicalCheck(raw) {
  const o = raw && raw.normalised ? raw : physicalOptions(raw);
  if (!o) return null;
  const pairwise = o.crossing || o.hill || o.hillSpacing > 0 || o.amd;
  let idx = [], a = [], mu = [], e = [];
  const check = (pl, mstar) => {
    const n = pl.length;
    if (idx.length !== n) { idx = pl.map((_, i) => i); a = new Float64Array(n); mu = new Float64Array(n); e = new Float64Array(n); }
    const Ms = mstar > 0 ? mstar : 1;
    for (let i = 0; i < n; i++) {
      const q = pl[i];
      let m = q.mplanet > 0 ? q.mplanet * MJ : 0;
      if (!(m > 0) && Number.isFinite(q.K) && q.K > 0 && mstar > 0) m = massFromK(q.K, q.per, q.ecc || 0, q.inc ?? 90, mstar) * MJ;
      mu[i] = m / Ms; e[i] = q.ecc || 0;
      a[i] = Math.cbrt((G_AU * Ms * (1 + mu[i]) * q.per * q.per) / (TWO_PI * TWO_PI));
    }
    if (o.roche) for (let i = 0; i < n; i++) {
      const q = pl[i], rp = q.ars * (1 - e[i]), k = q.rprs > 0 ? q.rprs : 0;
      if (!(rp > 1 + k)) return 'surface';
      if (mu[i] > 0 && k > 0 && !(rp > o.rocheFactor * k * Math.cbrt(1 / mu[i]))) return 'roche';
    }
    if (pairwise && n > 1) {
      idx.sort((x, y) => a[x] - a[y]);
      for (let j = 0; j < n - 1; j++) {
        const I = idx[j], O = idx[j + 1];
        if (o.crossing && !(a[O] * (1 - e[O]) > a[I] * (1 + e[I]))) return 'crossing';
        if (o.hill && !(gladmanMargin(mu[I], mu[O], a[I], a[O], e[I], e[O]) > 0)) return 'hill';
        if (o.hillSpacing > 0) { const rh = mutualHillRadius(mu[I], mu[O], a[I], a[O]); if (rh > 0 && !((a[O] - a[I]) / rh >= o.hillSpacing)) return 'hillSpacing'; }
      }
      if (o.amd) { const r = amdStability(idx.map((i) => ({ m: mu[i], a: a[i], e: e[i] }))); if (!r.stable) return 'amd'; }
    }
    if (o.megno && n > 1) {
      let r;
      try { r = megnoRun(buildSystem({ mstar: Ms, planets: pl.map((q) => ({ per: q.per, tmid: q.tmid || 0, ecc: q.ecc || 0, omega: q.omega || 0, inc: q.inc ?? 90, mplanet: q.mplanet > 0 ? q.mplanet : 0 })) }), { orbits: o.megno.orbits, seed: o.megno.seed, stopAbove: o.megno.max + 1 }); }
      catch { return 'megno'; }
      if (!r.ok || !(r.megno <= o.megno.max)) return 'megno';
    }
    return null;
  };
  check.options = o;
  return check;
}

/**
 * Prior mass V that passes the optional prior tests: the fraction of n draws from the prior (unit cube through the problem's
 * transform) that pass the physical tests and, with spec.phase.positive_map, the positivity of the map, among the draws that
 * pass the model's own checks (a bound orbit, a planet flux that is nowhere negative, ...).
 * prob: from buildProblem (needs prob.priorCheck). Returns { V, lnV, lnVerr (binomial), n, nBase, nPass, reasons }.
 */
export function physicalPriorVolume(prob, { n = 20000, seed = 11 } = {}) {
  const rng = makeRng(seed), u = new Float64Array(prob.ndim), th = new Float64Array(prob.ndim), reasons = {};
  let nBase = 0, nPass = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < u.length; k++) u[k] = rng.next();
    prob.transform(u, th);
    const r = prob.priorCheck(th);
    if (r === 'invalid') continue;
    nBase++;
    if (r === null) nPass++; else reasons[r] = (reasons[r] || 0) + 1;
  }
  const V = nBase ? nPass / nBase : NaN;
  return { V, lnV: Math.log(V), lnVerr: nPass ? Math.sqrt((1 - V) / nPass) : Infinity, n, nBase, nPass, reasons };
}
