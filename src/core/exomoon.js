// A planet with a moon in front of a limb-darkened star: geometry, photometry, timing, search.
//
// ---------------------------------------------------------------------------------------------
// INTEGRATION (for the owner of src/core/model.js; nothing here edits that file)
//
//   import { makePlanetMoonTransit, moonParamsFrom, MOON_FIELDS } from './exomoon.js';
//
//   In evaluate(), where a planet's light curve is compiled, replace
//       fluxes[p] = makeTransit(tp);
//   with
//       const moon = moonParamsFrom(v, sfx[p], { mplanet: q.mplanet, mstar: v.mstar });
//       if (moon) {
//         const f = makePlanetMoonTransit({ ...tp, ...moon });   // tp: what toTransitParams() returns, with q.ars
//         if (!f.ok) return null;                                // separation not computable, or the moon inside the planet
//         // optional, stricter prior: if (!f.validity.bound) return null;   (outside the Hill sphere)
//         fluxes[p] = f;
//       } else fluxes[p] = makeTransit(tp);
//
//   f(t) has the signature of makeTransit's result (relative flux, 1 out of transit), so the exposure
//   averaging, the product over planets and the a1 / airmass baseline need no change.
//
//   * Keys. A moon belongs to one planet: planet b reads rmoon, permoon, phmoon, mmoon, imoon, amoon;
//     planet c reads rmoon@c, permoon@c, ... moonParamsFrom() does NOT fall back from "rmoon@c" to
//     "rmoon" (that would hand planet b's moon to planet c), unlike the fallback buildProblem uses for
//     PLANET_FIELDS. So do not add MOON_FIELDS to PLANET_FIELDS; read them through moonParamsFrom().
//     A planet has a moon when its rmoon key is present (a number, 0 included) in values or in free.
//   * Registry. MOON_PARAMS has the entries in the style of PARAMS (plus `prior`, the default prior);
//     add them to PARAM_BY_KEY so paramFor('rmoon@c') resolves, and to activeParams() for planets that
//     have a moon (group 'moon').
//   * Separation. With mplanet [M Jup] and mstar [M Sun] given (they already exist as keys) the
//     planet-moon separation follows from the moon's period by Kepler's third law. Without masses,
//     give amoon (stellar radii) or amoonrp (planet radii). See moonGeometry().
//   * Exposure. autoSupersample() looks at the planet's ingress only. The moon's ingress is shorter
//     by about rmoon / rprs; for long exposures use max(planet's, moonSupersample(exptime, params)).
//   * Masses. With spec.kepler, a/R* comes from M* + Mp; the moon's mass is not added (a relative change of
//     Mm / 3 M* in a/R*, 6e-6 for a 6 Earth-mass moon of a Jupiter). The moon's separation does use Mp + Mm.
//   * fitRunner.runFit() only takes a buildProblem spec, so until model.js has the moon a fit needs its own
//     likelihood on MiniNest (test/exomoon.test.mjs does this). Start it from moonSearch(): the period has
//     aliases at 1/P + k/per that the search lists in `peaks`, and one narrow prior per peak is the safe way.
//   * Plots. f.components(t) gives the isolated pieces; moonComponents(times, params) gives arrays.
//   * 3D view. moonPosition(el, params, t), planetPosition(el, params, t) and moonOrbitPath(el, params, t)
//     use the frame of orbitPosition() in kepler.js.
// ---------------------------------------------------------------------------------------------
//
// THE MODEL
//
// Geometry. The barycentre of planet and moon moves on the planet's Keplerian orbit (kepler.js: sky
// plane X, Y in stellar radii, +Z toward the observer, mid-transit at inferior conjunction, where the
// barycentre moves toward +X). The moon's orbit about the planet is circular, with radius a_m:
//     moon - planet = a_m (cos theta e1 + sin theta e2),   theta = pi/2 + 2 pi (phmoon + (t - tmid) / permoon)
//     e1 = (-1, 0, 0),  e2 = (0, -cos(i + imoon), sin(i + imoon))
// With imoon = 0 these are the axes of the planet's own orbit, so the moon is coplanar and prograde
// (it circles the planet in the same sense as the planet circles the star). theta is measured like
// the planet's omega + nu: phmoon = 0 puts the moon between the planet and the observer at the
// planet's mid-transit, 0.25 ahead of the planet (it transits first), 0.5 behind the planet, 0.75
// trailing. imoon tilts the moon's orbit about the axis along the transit chord: the moon's orbit
// is then inclined i + imoon to the sky, and imoon = 180 is a coplanar retrograde orbit. One angle
// only: the line of nodes is fixed along the chord (a longitude of the node would be the next step).
//     planet = barycentre - q/(1+q) (moon - planet),   moon = barycentre + 1/(1+q) (moon - planet),   q = Mm/Mp
// q = 0 (the default) switches the barycentric wobble off: depth and period can be searched first.
//
// Separation (moonGeometry). Default, when the planet's and the star's masses are known: Kepler's
// third law for both orbits gives, with mu = (Mp + Mm) / M*,
//     a_m / R* = (a/R*) (permoon / per)^(2/3) (mu / (1 + mu))^(1/3)
// which needs no stellar radius, and makes the moon's period the single quantity that sets both when
// and where the moon appears. It is the default because the period is what a search finds, and a
// separation that is free of the period lets the sampler put the moon anywhere. Without masses, or
// to override: amoonrp (planet radii) or amoon (stellar radii), in that order of precedence.
//
// Photometry. Both bodies are opaque discs, so the blocked flux is that of the union of the discs:
//     blocked = B(planet) + B(moon) - B(planet AND moon AND star)
// B of one disc is transit.js's blockedFraction. The last term (the lens where the discs overlap,
// clipped by the stellar limb) uses the same Green's theorem as the kernel: the region is convex and
// bounded by at most one arc of each of the three circles, and
//     B = (1 / 2 pi F(1)) * sum over arcs of  int F(r)/r^2 (x dy - y dx)
// An arc of the stellar limb contributes F(1) times its angle. An arc of a disc's limb is split at
// the point furthest from the star's centre (if it holds one), each piece is halved, and each half
// gets 20 Gauss-Legendre nodes after the phi -> u^2 substitution that clusters them at its outer
// end, where the arc may touch the stellar limb. Whether the moon is in front of or behind the
// planet makes no difference. A moon wholly inside the planet's disc leaves the light curve of the
// planet alone, exactly. Accuracy against scipy adaptive quadrature: see test/exomoon.test.mjs.
//
// What is left out: an eccentric moon orbit, a second orientation angle, precession, the planet's
// oblateness, light-travel time across the moon's orbit, the moon's own light, three-body effects
// (the moon's orbit is a fixed circle), and the TDV from a changing impact parameter (Kipping 2009b),
// which the geometry produces when imoon is not 0 but which has no closed form here.

import { orbitElements, solveKepler, trueAnomaly, contactDuration } from './kepler.js';
import { blockedFraction, makeTransit, hOf, gaussLegendre } from './transit.js';
import { prepareLD, toClaret } from './limbdark.js';
import { C } from './derive.js';
import { makeRng } from './stats.js';

const PI = Math.PI, TWO_PI = 2 * Math.PI, DEG = Math.PI / 180;

// ---- parameters ---------------------------------------------------------------------------------

/**
 * Registry entries in the style of PARAMS in model.js, plus `prior` (default prior) and `group`.
 * Keys take the planet scope like any planet-level key: rmoon for the first planet, rmoon@c for planet c.
 */
export const MOON_PARAMS = [
  { key: 'rmoon',   label: 'Rm/R★',   unit: '',  min: 0,    max: 0.1,  step: 0.0001, digits: 4, group: 'moon', prior: { type: 'uniform', a: 0, b: 0.05 },
    help: 'Moon-to-star radius ratio. Its own transit is about this squared deep' },
  { key: 'permoon', label: 'P moon',  unit: 'd', min: 0.05, max: 100,  step: 0.0001, digits: 5, group: 'moon', prior: { type: 'uniform', a: 0.3, b: 10 },
    help: 'Orbital period of the moon about the planet. A prograde moon is stable only below about a fifth of the planet\'s period' },
  { key: 'phmoon',  label: 'φ moon',  unit: '',  min: 0,    max: 1,    step: 0.001,  digits: 4, group: 'moon', periodic: true, prior: { type: 'uniform', a: 0, b: 1 },
    help: 'Moon\'s orbital phase at the planet\'s mid-transit, in cycles: 0 in front of the planet, 0.25 ahead of it, 0.5 behind, 0.75 trailing' },
  { key: 'mmoon',   label: 'Mm/Mp',   unit: '',  min: 0,    max: 0.2,  step: 0.0001, digits: 4, group: 'moon', prior: { type: 'uniform', a: 0, b: 0.1 },
    help: 'Moon-to-planet mass ratio. Sets the planet\'s wobble about the barycentre (timing and duration variations); 0 = no wobble' },
  { key: 'imoon',   label: 'i moon',  unit: '°', min: 0,    max: 180,  step: 0.1,    digits: 2, group: 'moon', prior: { type: 'uniform', a: 0, b: 60 },
    help: 'Tilt of the moon\'s orbit from the planet\'s orbital plane, about the transit chord; 0 = coplanar prograde, 180 = retrograde' },
  { key: 'amoon',   label: 'a moon/R★', unit: '', min: 0,   max: 50,   step: 0.001,  digits: 4, group: 'moon', optional: true, prior: { type: 'uniform', a: 0.1, b: 5 },
    help: 'Planet-moon separation in stellar radii. Leave unset to derive it from the moon\'s period and the planet\'s mass (Kepler\'s third law)' },
];
/** The unscoped moon keys. */
export const MOON_FIELDS = MOON_PARAMS.map((p) => p.key);
export const MOON_PARAM_BY_KEY = Object.fromEntries(MOON_PARAMS.map((p) => [p.key, p]));
/** Key of a moon parameter of the planet with suffix sfx ('' for the first planet): "rmoon", "rmoon@c". */
export const moonKey = (field, sfx) => (sfx ? field + '@' + sfx : field);

/**
 * The moon's parameters of one planet from a flat table of values (keys as in the analyzer), or null
 * when that planet has no moon (no rmoon key). No fallback to another planet's moon.
 * extra: { mplanet [M Jup], mstar [M Sun] } of this planet and its star, for the Kepler separation.
 */
export function moonParamsFrom(v, sfx = '', extra = {}) {
  const r = v[moonKey('rmoon', sfx)];
  if (r === undefined || r === null) return null;
  const g = (f) => v[moonKey(f, sfx)];
  const out = { rmoon: r, permoon: g('permoon'), phmoon: g('phmoon') || 0, mmoon: g('mmoon') || 0, imoon: g('imoon') || 0 };
  if (g('amoon') > 0) out.amoon = g('amoon');
  if (g('amoonrp') > 0) out.amoonrp = g('amoonrp');
  if (extra.mplanet !== undefined) out.mplanet = extra.mplanet;
  if (extra.mstar !== undefined) out.mstar = extra.mstar;
  return out;
}

// Stability limits of Domingos, Winter & Yokoyama (2006, MNRAS 373, 1227), in Hill radii, for a
// moon on a circular orbit: prograde 0.4895 (1 - 1.0305 e_p), retrograde 0.9309 (1 - 1.0764 e_p).
const STABLE_PRO = 0.4895, STABLE_RETRO = 0.9309;

/**
 * Resolve the moon's orbit and check that it is physical.
 * p: the planet's { rprs, per, ars, inc, ecc } and the moon's { rmoon, permoon, phmoon, mmoon, imoon,
 *    amoon | amoonrp (optional), mplanet [M Jup], mstar [M Sun] (optional), rhoRatio (optional) }
 * returns {
 *   aMoon [R*], aMoonRp [planet radii], mode: 'kepler' | 'rstar' | 'rp' | 'none',
 *   q (Mm/Mp), aWobble [R*] (radius of the planet's orbit about the barycentre),
 *   mu: (Mp + Mm)/M* used, or the value implied by the given separation and period,
 *   hill [R*], hillFrac (aMoon / Hill radius), stableFrac (limit for this orbit, in Hill radii),
 *   maxPeriod [d] (longest stable period), roche [R*] and rocheRp (fluid Roche limit),
 *   bound, stable, outsideRoche, clear (not touching the planet), ok (all four), reasons: [strings] }
 *
 * Hill radius r_H = a (1 - e) (mu / 3)^(1/3). With Kepler's law for both orbits
 * aMoon / r_H = (3 / (1 + mu))^(1/3) (permoon / per)^(2/3) / (1 - e): a statement about the period
 * ratio alone. A prograde moon inside 0.4895 r_H has permoon < 0.198 per (Kipping 2009: about P/5).
 * Roche limit for a fluid moon: 2.44 Rp (rho_p / rho_m)^(1/3). rho_p / rho_m is rhoRatio if given,
 * else (rmoon / rprs)^3 / q when the mass ratio is known, else 1.
 */
export function moonGeometry(p) {
  const rp = Math.abs(p.rprs), rm = Math.abs(p.rmoon || 0), q = Math.max(0, p.mmoon || 0), e = p.ecc || 0;
  const per = p.per, pm = p.permoon, ars = p.ars;
  const muGiven = p.mplanet > 0 && p.mstar > 0 ? ((p.mplanet * C.Mjup_Msun) / p.mstar) * (1 + q) : NaN;
  let aMoon = NaN, mode = 'none', mu = muGiven;
  if (p.amoonrp > 0) { aMoon = p.amoonrp * rp; mode = 'rp'; }
  else if (p.amoon > 0) { aMoon = p.amoon; mode = 'rstar'; }
  else if (muGiven > 0 && pm > 0 && per > 0 && ars > 0) { aMoon = ars * Math.pow(pm / per, 2 / 3) * Math.cbrt(muGiven / (1 + muGiven)); mode = 'kepler'; }
  if (mode !== 'kepler' && aMoon > 0 && pm > 0 && per > 0 && ars > 0) {
    // the planet-to-star mass ratio that this separation and period imply
    const x = Math.pow(aMoon / ars, 3) * Math.pow(per / pm, 2);
    mu = x < 1 ? x / (1 - x) : Infinity;
  }
  const retro = (p.imoon || 0) > 90;
  const stableFrac = Math.max(0, retro ? STABLE_RETRO * (1 - 1.0764 * e) : STABLE_PRO * (1 - 1.0305 * e));
  const hill = ars * (1 - e) * Math.cbrt(mu / 3), hillFrac = aMoon / hill;
  const maxPeriod = per * Math.pow(stableFrac * (1 - e), 1.5) * Math.sqrt((1 + (mu > 0 && Number.isFinite(mu) ? mu : 0)) / 3);
  const rho = p.rhoRatio > 0 ? p.rhoRatio : q > 0 && rm > 0 ? Math.pow(rm / rp, 3) / q : 1;
  const rocheRp = 2.44 * Math.cbrt(rho), roche = rocheRp * rp;
  const bound = hillFrac < 1, stable = hillFrac < stableFrac, outsideRoche = aMoon > roche, clear = aMoon > rp + rm;
  const reasons = [];
  if (!(aMoon > 0)) reasons.push('the planet-moon separation is not defined: give the planet and star masses, or amoon');
  else {
    if (!clear) reasons.push('the moon is inside the planet');
    else if (!outsideRoche) reasons.push(`the moon is inside the Roche limit (${rocheRp.toFixed(2)} planet radii)`);
    if (!bound) reasons.push(`the moon is outside the planet's Hill sphere (${hillFrac.toFixed(2)} Hill radii)`);
    else if (!stable) reasons.push(`the moon is beyond the stable region (${hillFrac.toFixed(2)} of ${stableFrac.toFixed(2)} Hill radii for a ${retro ? 'retrograde' : 'prograde'} orbit)`);
  }
  return { aMoon, aMoonRp: aMoon / rp, mode, q, aWobble: (aMoon * q) / (1 + q), mu, hill, hillFrac, stableFrac, maxPeriod, roche, rocheRp, bound, stable, outsideRoche, clear, ok: aMoon > 0 && bound && stable && outsideRoche && clear, reasons };
}

/** Moon period [d] that puts the moon at separation aMoon [R*] by Kepler's law (inverse of the default in moonGeometry). */
export function moonPeriodFor(aMoon, p) {
  const mu = ((p.mplanet * C.Mjup_Msun) / p.mstar) * (1 + Math.max(0, p.mmoon || 0));
  return p.per * Math.pow(aMoon / p.ars, 1.5) * Math.sqrt((1 + mu) / mu);
}

/** Sub-samples per exposure that resolve the moon's ingress (see autoSupersample in model.js for the planet's). */
export function moonSupersample(exptimeDays, p) {
  if (!(exptimeDays > 0) || !(p.rmoon > 0)) return 1;
  const v = (TWO_PI * p.ars) / p.per, tau = Math.max((2 * p.rmoon) / v, 1e-5);   // central crossing of the limb
  if (exptimeDays < tau / 8) return 1;
  return Math.min(31, 2 * Math.ceil((1.5 * exptimeDays) / tau) + 1);
}

// ---- photometry: two discs on a limb-darkened star -------------------------------------------------

const NQ = 20, GLQ = gaussLegendre(NQ), QU2 = new Float64Array(NQ), QW = new Float64Array(NQ);
for (let k = 0; k < NQ; k++) { const u = 0.5 * (GLQ.x[k] + 1); QU2[k] = u * u; QW[k] = GLQ.w[k] * u; }

// int_a^b h(r^2) R (R + cx cos phi + cy sin phi) dphi along the circle of radius R about (cx, cy);
// the two halves of [a, b] each carry NQ nodes clustered at the outer end.
function arcHalves(cx, cy, R, a, b, ld) {
  const zz = cx * cx + cy * cy + R * R, R2 = 2 * R, half = 0.5 * (b - a);
  let sum = 0;
  for (let k = 0; k < NQ; k++) {
    const d = half * QU2[k], p1 = a + d, p2 = b - d;
    const c1 = cx * Math.cos(p1) + cy * Math.sin(p1), c2 = cx * Math.cos(p2) + cy * Math.sin(p2);
    sum += QW[k] * (hOf(zz + R2 * c1, ld) * (R + c1) + hOf(zz + R2 * c2, ld) * (R + c2));
  }
  return sum * half * R;
}
function arcIntegral(cx, cy, R, a, b, ld) {
  // split where the circle is furthest from the star's centre: the only place inside an arc where it can graze the limb
  let psi = Math.atan2(cy, cx);
  psi += TWO_PI * Math.ceil((a - psi) / TWO_PI);
  if (psi > a + 1e-12 && psi < b - 1e-12) return arcHalves(cx, cy, R, a, psi, ld) + arcHalves(cx, cy, R, psi, b, ld);
  return arcHalves(cx, cy, R, a, b, ld);
}

// Part of the circle (cx, cy, R) that lies inside the disc (ox, oy, Q): an interval of half-width
// alpha about the direction psi. alpha = -1: none of it; alpha = pi: all of it.
const _A = { psi: 0, alpha: 0 }, _B = { psi: 0, alpha: 0 };
function insideArc(cx, cy, R, ox, oy, Q, out) {
  const dx = ox - cx, dy = oy - cy, d = Math.sqrt(dx * dx + dy * dy);
  out.psi = 0;
  if (d + R <= Q) { out.alpha = PI; return; }
  if (d >= R + Q || d + Q <= R) { out.alpha = -1; return; }
  const c = (d * d + R * R - Q * Q) / (2 * d * R);
  out.psi = Math.atan2(dy, dx); out.alpha = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

const _CX = new Float64Array(3), _CY = new Float64Array(3), _CR = new Float64Array(3);
/**
 * Fraction of the stellar flux inside both discs at once: disc 1 at (x1, y1) with radius r1, disc 2
 * at (x2, y2) with radius r2 (stellar radii, star at the origin with radius 1), clipped by the star.
 * ld: prepareLD(toClaret(law, coefficients)).
 */
export function overlapBlocked(x1, y1, r1, x2, y2, r2, ld) {
  _CX[0] = 0; _CY[0] = 0; _CR[0] = 1; _CX[1] = x1; _CY[1] = y1; _CR[1] = r1; _CX[2] = x2; _CY[2] = y2; _CR[2] = r2;
  let tot = 0;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, k = (i + 2) % 3, cx = _CX[i], cy = _CY[i], R = _CR[i];
    insideArc(cx, cy, R, _CX[j], _CY[j], _CR[j], _A);
    if (_A.alpha < 0) continue;
    insideArc(cx, cy, R, _CX[k], _CY[k], _CR[k], _B);
    if (_B.alpha < 0) continue;
    const piece = (lo, hi) => { tot += i === 0 ? ld.F1 * (hi - lo) : arcIntegral(cx, cy, R, lo, hi, ld); };
    if (_A.alpha === PI && _B.alpha === PI) piece(-PI, PI);
    else if (_A.alpha === PI) piece(_B.psi - _B.alpha, _B.psi + _B.alpha);
    else if (_B.alpha === PI) piece(_A.psi - _A.alpha, _A.psi + _A.alpha);
    else {
      let del = _B.psi - _A.psi; del -= TWO_PI * Math.round(del / TWO_PI);
      for (let m = -1; m <= 1; m++) {
        const lo = Math.max(-_A.alpha, del - _B.alpha + TWO_PI * m), hi = Math.min(_A.alpha, del + _B.alpha + TWO_PI * m);
        if (hi > lo) piece(_A.psi + lo, _A.psi + hi);
      }
    }
  }
  const f = tot / (TWO_PI * ld.F1);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// The part of the blocked flux counted twice when both discs are on the star (b1, b2 > 0 are their own
// blocked fractions). Discs closer than 1e-11 of their size to touching, from outside or from inside, are
// treated as touching: the lens is then narrower than rounding can resolve (its arcs nearly cancel).
function pairOverlap(x1, y1, r1, b1, x2, y2, r2, b2, ld) {
  const dx = x2 - x1, dy = y2 - y1, s = Math.sqrt(dx * dx + dy * dy), rs = r1 + r2, tol = 1e-11 * rs;
  if (s >= rs - tol) return 0;
  if (s <= r1 - r2 + tol) return b2;
  if (s <= r2 - r1 + tol) return b1;
  return overlapBlocked(x1, y1, r1, x2, y2, r2, ld);
}

/**
 * Fraction of the stellar flux blocked by the union of two opaque discs (stellar radii, star at the
 * origin). out, if given, receives { first, second, overlap }: each disc alone and the part counted twice.
 */
export function unionBlocked(x1, y1, r1, x2, y2, r2, ld, out) {
  const b1 = r1 > 0 ? blockedFraction(Math.sqrt(x1 * x1 + y1 * y1), r1, ld) : 0;
  const b2 = r2 > 0 ? blockedFraction(Math.sqrt(x2 * x2 + y2 * y2), r2, ld) : 0;
  const ov = b1 > 0 && b2 > 0 ? pairOverlap(x1, y1, r1, b1, x2, y2, r2, b2, ld) : 0;
  if (out) { out.first = b1; out.second = b2; out.overlap = ov; }
  return b2 === ov ? b1 : b1 === ov ? b2 : b1 + b2 - ov;
}

// ---- the composite light curve ------------------------------------------------------------------------

/**
 * Compile a planet + moon parameter set into a fast evaluator: the function for the likelihood.
 *
 * params: everything makeTransit takes  { rprs, per, tmid, ars, inc, ecc, omega, ldLaw, ld: [...] }
 *   plus the moon                        { rmoon, permoon, phmoon, mmoon = 0, imoon = 0,
 *                                          amoon | amoonrp (optional), mplanet [M Jup], mstar [M Sun] }
 *   plus switches, all true by default   { wobble, moonTransit, mutual }
 *     wobble: false       the planet stays on the barycentre's orbit whatever mmoon is (no TTV / TDV)
 *     moonTransit: false  the moon blocks no light (only its pull on the planet remains)
 *     mutual: false       the discs' overlap is not corrected: planet and moon dips are simply added
 *
 * returns flux(t) -> relative flux (1 out of transit), with these properties:
 *   flux.ok          false when the separation cannot be computed or the moon would be inside the planet
 *                    (flux(t) is then the moonless transit); a likelihood should reject the point
 *   flux.geometry    moonGeometry(params): separation, Hill and Roche checks, reasons
 *   flux.validity    the same object (alias, reads better in a prior: flux.validity.bound)
 *   flux.components(t, out = {}) -> { total, planet, moon, overlap, moonless, diff, wobble }
 *       planet    flux with the planet alone, where the wobble puts it        (1 - B_planet)
 *       moon      flux with the moon alone                                    (1 - B_moon)
 *       overlap   flux given back because the discs overlap, >= 0             (B of the lens)
 *       total     planet + moon - 1 + overlap = flux(t)
 *       moonless  the planet on the barycentre's orbit, no moon: makeTransit(params)(t)
 *       diff      total - moonless: everything the moon does to the light curve
 *       wobble    planet - moonless: the timing and duration signature alone
 *   flux.positions(t, planet = [0,0,0], moon = [0,0,0]) -> writes both positions [X, Y, Z] in stellar radii
 */
export function makePlanetMoonTransit(params) {
  const g = moonGeometry(params), base = makeTransit(params);
  const el = orbitElements(params), { e, w, n, M0, tmid, ars, cosI, sinI } = el;
  const ld = prepareLD(toClaret(params.ldLaw || 'nonlinear', params.ld || [0, 0, 0, 0]));
  const rp = Math.abs(params.rprs), aM = g.aMoon, ok = aM > 0 && g.clear && params.permoon > 0;
  const rm = ok && params.moonTransit !== false ? Math.abs(params.rmoon || 0) : 0, mutual = params.mutual !== false;
  const fw = ok && params.wobble !== false ? g.q / (1 + g.q) : 0, fm = 1 - fw;
  const nm = ok ? TWO_PI / params.permoon : 0, th0 = PI / 2 + TWO_PI * (params.phmoon || 0);
  const incM = el.inc + (params.imoon || 0) * DEG, cosM = Math.cos(incM), sinM = Math.sin(incM);
  const aMs = ok ? aM : 0, limP = (1 + rp) * (1 + rp), limM = (1 + rm) * (1 + rm);
  const reach = 1 + Math.max(rp + fw * aMs, rm + fm * aMs), reach2 = reach * reach;
  let Bp = 0, Bm = 0, Bo = 0;
  let xp = 0, yp = 0, zp = 0, xm = 0, ym = 0, zm = 0;

  // positions of both bodies; returns false when neither can be in front of the star (positions not needed)
  function place(t, always) {
    let u, r;
    if (e === 0) { u = PI / 2 + n * (t - tmid); r = ars; }
    else { const E = solveKepler(M0 + n * (t - tmid), e); u = w + trueAnomaly(E, e); r = ars * (1 - e * Math.cos(E)); }
    const su = Math.sin(u), cu = Math.cos(u);
    const Xb = -r * cu, Yb = -r * su * cosI, Zb = r * su * sinI;
    if (!always && (Zb <= -aMs || Xb * Xb + Yb * Yb >= reach2)) return false;
    const th = th0 + nm * (t - tmid), ct = Math.cos(th), st = Math.sin(th);
    const rx = -aMs * ct, ry = -aMs * st * cosM, rz = aMs * st * sinM;
    xp = Xb - fw * rx; yp = Yb - fw * ry; zp = Zb - fw * rz;
    xm = Xb + fm * rx; ym = Yb + fm * ry; zm = Zb + fm * rz;
    return true;
  }
  function blocked(t) {
    Bp = 0; Bm = 0; Bo = 0;
    if (!place(t, false)) return 0;
    const dp2 = xp * xp + yp * yp;
    if (zp > 0 && dp2 < limP) Bp = blockedFraction(Math.sqrt(dp2), rp, ld);
    if (rm > 0 && zm > 0) {
      const dm2 = xm * xm + ym * ym;
      if (dm2 < limM) {
        Bm = blockedFraction(Math.sqrt(dm2), rm, ld);
        if (mutual && Bp > 0 && Bm > 0) Bo = pairOverlap(xp, yp, rp, Bp, xm, ym, rm, Bm, ld);
      }
    }
    return Bp + (Bm - Bo);     // in this order a wholly hidden moon (Bo = Bm) leaves exactly the planet's value
  }
  const flux = ok && (rm > 0 || fw > 0) ? (t) => 1 - blocked(t) : base;
  flux.ok = ok; flux.geometry = g; flux.validity = g;
  flux.components = (t, out = {}) => {
    const moonless = base(t);
    if (!ok) { out.total = moonless; out.planet = moonless; out.moon = 1; out.overlap = 0; out.moonless = moonless; out.diff = 0; out.wobble = 0; return out; }
    const b = blocked(t);
    out.total = 1 - b; out.planet = 1 - Bp; out.moon = 1 - Bm; out.overlap = Bo; out.moonless = moonless;
    out.diff = out.total - moonless; out.wobble = out.planet - moonless;
    return out;
  };
  flux.positions = (t, planet = [0, 0, 0], moon = [0, 0, 0]) => {
    place(t, true);
    planet[0] = xp; planet[1] = yp; planet[2] = zp; moon[0] = xm; moon[1] = ym; moon[2] = zm;
    return { planet, moon };
  };
  return flux;
}

/**
 * The isolated pieces on an array of times, for plotting.
 * opts: { exptime (days), supersample } average every piece over the exposure, as transitModel does.
 * returns Float64Arrays { total, planet, moon, overlap, moonless, diff, wobble } (see makePlanetMoonTransit) and ok.
 */
export function moonComponents(times, params, opts) {
  const f = makePlanetMoonTransit(params), N = times.length, names = ['total', 'planet', 'moon', 'overlap', 'moonless', 'diff', 'wobble'];
  const out = Object.fromEntries(names.map((k) => [k, new Float64Array(N)])), c = {};
  const ns = opts && opts.exptime > 0 ? Math.max(1, opts.supersample | 0) : 1, dt = ns > 1 ? opts.exptime / ns : 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < ns; j++) {
    f.components(times[i] + (j - (ns - 1) / 2) * dt, c);
    for (const k of names) out[k][i] += c[k];
  }
  if (ns > 1) for (const k of names) for (let i = 0; i < N; i++) out[k][i] /= ns;
  out.ok = f.ok; out.geometry = f.geometry;
  return out;
}

// ---- positions for the views -----------------------------------------------------------------------------

// el: orbitElements() of the planet. moonParams: the moon's parameters (rmoon, permoon, phmoon, mmoon, imoon,
// amoon / amoonrp, mplanet, mstar) and the planet's rprs; per, ars, ecc are taken from el when absent.
function resolve(el, mp) {
  const g = moonGeometry({ per: el.per, ars: el.ars, ecc: el.e, ...mp });
  const incM = el.inc + (mp.imoon || 0) * DEG, a = g.aMoon > 0 ? g.aMoon : 0;
  return { a, fw: mp.wobble === false ? 0 : g.q / (1 + g.q), nm: mp.permoon > 0 ? TWO_PI / mp.permoon : 0, th0: PI / 2 + TWO_PI * (mp.phmoon || 0), cosM: Math.cos(incM), sinM: Math.sin(incM) };
}
function bary(el, t, out) {
  let u, r;
  if (el.e === 0) { u = PI / 2 + el.n * (t - el.tmid); r = el.ars; }
  else { const E = solveKepler(el.M0 + el.n * (t - el.tmid), el.e); u = el.w + trueAnomaly(E, el.e); r = el.ars * (1 - el.e * Math.cos(E)); }
  out[0] = -r * Math.cos(u); out[1] = -r * Math.sin(u) * el.cosI; out[2] = r * Math.sin(u) * el.sinI;
  return out;
}
function offset(el, mp, t, frac, out) {
  const s = resolve(el, mp), th = s.th0 + s.nm * (t - el.tmid), ct = Math.cos(th), st = Math.sin(th);
  const k = frac === 'moon' ? 1 - s.fw : -s.fw;
  bary(el, t, out);
  out[0] += k * -s.a * ct; out[1] += k * -s.a * st * s.cosM; out[2] += k * s.a * st * s.sinM;
  return out;
}
/** The moon's position [X, Y, Z] in stellar radii at time t, in the frame of orbitPosition(). Writes into out. */
export function moonPosition(el, moonParams, t, out = [0, 0, 0]) { return offset(el, moonParams, t, 'moon', out); }
/** The planet's position at time t, displaced from its Keplerian orbit by the moon's pull (equal to orbitPosition() when mmoon = 0). */
export function planetPosition(el, moonParams, t, out = [0, 0, 0]) { return offset(el, moonParams, t, 'planet', out); }
/**
 * The moon's orbit as n points, Float32Array(3n), for drawing. The ring is centred on the planet where it is
 * at time t, so the moon's position at t lies on it. opts.center: 'planet' (default), 'barycentre' (the moon's
 * circle about the common centre) or 'none' (offsets from the planet, not positions).
 */
export function moonOrbitPath(el, moonParams, t, n = 128, opts = {}) {
  const s = resolve(el, moonParams), c = [0, 0, 0], out = new Float32Array(3 * n), mode = opts.center || 'planet';
  if (mode === 'planet') planetPosition(el, moonParams, t, c); else if (mode === 'barycentre') bary(el, t, c);
  const a = mode === 'barycentre' ? s.a * (1 - s.fw) : s.a;
  for (let i = 0; i < n; i++) {
    const th = (TWO_PI * i) / n, ct = Math.cos(th), st = Math.sin(th);
    out[3 * i] = c[0] - a * ct; out[3 * i + 1] = c[1] - a * st * s.cosM; out[3 * i + 2] = c[2] + a * st * s.sinM;
  }
  return out;
}

// ---- timing and duration variations ------------------------------------------------------------------------

/**
 * Analytic amplitudes of the planet's transit timing and duration variations caused by the moon
 * (Kipping 2009a, MNRAS 392, 181, for a circular coplanar moon orbit). With a_w = a_m q / (1 + q) the
 * radius of the planet's orbit about the barycentre and v_B the barycentre's sky velocity at mid-transit,
 * (2 pi a / P)(1 + e sin omega) / sqrt(1 - e^2):
 *     TTV:  the planet is displaced a_w cos(theta) along its path     peak a_w / v_B
 *     TDV:  its velocity changes by a_w (2 pi / permoon) sin(theta)   peak Tbar (2 pi a_w / permoon) / v_B
 * For a circular planet orbit these are Kipping's  a_w P / (2 pi a)  and  Tbar a_w P / (a permoon); his
 * delta_TTV and delta_TDV are the rms values, peak / sqrt(2). The two are a quarter of a cycle apart, and
 * their ratio 2 pi Tbar / permoon gives the moon's period without knowing its mass.
 * returns { aWobble [R*], vSky [stellar radii per day], tbar [d] (centre on the limb to centre on the limb), ttv, tdv (peaks, d),
 *           ttvRms, tdvRms, ratio (tdv / ttv) }
 */
export function ttvTdvAmplitudes(params) {
  const g = moonGeometry(params), el = orbitElements(params);
  const vSky = (TWO_PI * el.ars / el.per) * (1 + el.e * Math.sin(el.w)) / Math.sqrt(1 - el.e * el.e);
  const tbar = contactDuration(el, 1, el.tmid), aw = params.wobble === false ? 0 : g.aWobble;
  const ttv = aw / vSky, tdv = (tbar * (TWO_PI * aw / params.permoon)) / vSky;
  return { aWobble: aw, vSky, tbar, ttv, tdv, ttvRms: ttv / Math.SQRT2, tdvRms: tdv / Math.SQRT2, ratio: tdv / ttv };
}

/**
 * The planet's transit times and durations measured from the geometry, transit by transit.
 * epochs: array of whole orbit numbers E (the transit near tmid + E per).
 * A transit runs from the planet's centre crossing the stellar limb inward to crossing it outward
 * (Kipping's Tbar); its mid-time is the mean of the two.
 * returns { epoch, tlin (tmid + E per), tmid (measured), ttv (tmid - tlin), dur, tdv (dur - moonless dur),
 *           theta (the moon's orbital angle at tlin, rad), durMoonless }, arrays; NaN where the centre never crosses the limb.
 */
export function moonTimings(params, epochs) {
  const f = makePlanetMoonTransit({ ...params, moonTransit: false }), el = orbitElements(params);
  const P = [0, 0, 0], M = [0, 0, 0], sep = (t) => { f.positions(t, P, M); return Math.hypot(P[0], P[1]); };
  const dur0 = contactDuration(el, 1, el.tmid), nE = epochs.length;
  const out = { epoch: Float64Array.from(epochs), tlin: new Float64Array(nE), tmid: new Float64Array(nE), ttv: new Float64Array(nE), dur: new Float64Array(nE), tdv: new Float64Array(nE), theta: new Float64Array(nE), durMoonless: dur0 };
  for (let i = 0; i < nE; i++) {
    const tc = el.tmid + epochs[i] * el.per;
    out.tlin[i] = tc; out.theta[i] = PI / 2 + TWO_PI * ((params.phmoon || 0) + (tc - el.tmid) / params.permoon);
    if (!(dur0 > 0) || !(sep(tc) < 1)) { out.tmid[i] = out.ttv[i] = out.dur[i] = out.tdv[i] = NaN; continue; }
    const edge = (dir) => {
      let a = tc, b = tc; const h = dur0 / 40;
      do { a = b; b += dir * h; } while (sep(b) < 1 && Math.abs(b - tc) < 2 * dur0 + 1);
      for (let k = 0; k < 60; k++) { const m = 0.5 * (a + b); if (sep(m) < 1) a = m; else b = m; }
      return 0.5 * (a + b);
    };
    const t1 = edge(-1), t2 = edge(1);
    out.tmid[i] = 0.5 * (t1 + t2); out.ttv[i] = out.tmid[i] - tc; out.dur[i] = t2 - t1; out.tdv[i] = out.dur[i] - dur0;
  }
  return out;
}

// ---- search --------------------------------------------------------------------------------------------------

/**
 * Search a light curve for a moon's own transits, with the planet's transit model already fitted.
 *
 * For a trial moon (period, phase at the planet's mid-transit) the moon's dips have a known shape, and
 * their depth is very nearly proportional to rmoon^2. With residuals r = planet model - data and the
 * template m = flux blocked by a moon of the reference radius, the best amplitude is A = sum(w r m) /
 * sum(w m^2) and the fit improves by delta chi2 = (sum w r m)^2 / sum(w m^2): a matched filter. The map
 * returned is the signed signal-to-noise  snr = sum(w r m) / sqrt(sum w m^2)  (so delta chi2 = snr^2,
 * positive snr = a dimming moon), with rmoon = rmoonRef sqrt(A).
 *
 * To make the grid cheap the sums are built per transit: for a coarse set of periods (which fix the
 * separation and the moon's motion during a transit) and a grid of moon phases at each transit's own
 * mid-time, sum(w r m) and sum(w m^2) of every transit are tabulated once. A fine period then only
 * decides which phase each transit has, and costs one table lookup per transit.
 *
 * The planet's depth is refitted with every trial moon (opts.fitDepth, on by default): a planet-only fit to
 * a light curve that holds a moon has already absorbed part of the moon into the planet's depth, and
 * without this the search prefers moons that stay clear of the planet. In effect the template is made
 * orthogonal to the planet's dip p = 1 - model:  snr = (S_rm - S_mp S_rp / S_pp) / sqrt(S_mm - S_mp^2 / S_pp).
 *
 * The planet's mid-time in every transit is refitted as well (opts.fitTiming, on by default), by projecting
 * d(model)/dt out of each transit: a moon massive enough to be seen also shifts the planet's transits by
 * minutes, and the residuals of that shift at ingress and egress are larger than the moon's own dip. The
 * duration is not refitted.
 *
 * Aliases. Transits sample the moon once per planet period, so periods with 1/P' = 1/P + k/per put the moon
 * at the same phase at every transit. They differ only through the separation (Kepler) and the moon's
 * motion during a transit, and show as a comb of peaks in `profile`.
 *
 * Assumptions: coplanar moon (opts.imoon to change), no wobble (mmoon = 0: the planet model is the
 * fitted one), the moon contributes nothing while its disc is wholly inside the planet's, partial
 * overlaps are not corrected, white Gaussian noise with the given error bars.
 *
 * data:   { t, f, e } normalised flux (baseline 1), times as in the planet's tmid
 * planet: makeTransit's parameters, plus mplanet [M Jup] and mstar [M Sun] (or amoon / amoonrp for a
 *         fixed separation)
 * opts:   { periods: [min, max] in days (default: from the fluid Roche limit to the longest stable prograde period),
 *           nPhases (48), oversample (12: fine periods per 1 / baseline in frequency), maxPeriods (20000),
 *           nCoarse (coarse periods, default 12 per octave), rmoonRef (reference radius, default 0.3 rprs),
 *           model (Float64Array: the planet model at data.t, default makeTransit(planet)), imoon (0), fitDepth (true), fitTiming (true),
 *           nNull (0): noise-only realisations searched in the same pass, seed (1) }
 * returns { periods, phases, snr (Float32Array, index ip * nPhases + ih), rmoon (same shape, 0 where snr <= 0),
 *           profile (max snr over phase for each period), peaks: [{ permoon, snr }] (its 8 strongest separate maxima),
 *           best: { permoon, phmoon, rmoon, snr, dchi2, amoon }, inverted: { permoon, phmoon, snr } (the strongest
 *           brightening "moon"; on noise it is about as large as best.snr, and it goes negative when every trial moon
 *           dims the star, which is the orbital sampling effect of a real one),
 *           nullMax (largest snr of each noise realisation), fap ((1 + number of nulls >= best) / (1 + nNull)),
 *           ntransits, npoints, ms }
 */
export function moonSearch(data, planet, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const t = data.t, f = data.f, er = data.e, N = t.length;
  const el = orbitElements(planet), rp = Math.abs(planet.rprs);
  const ld = prepareLD(toClaret(planet.ldLaw || 'nonlinear', planet.ld || [0, 0, 0, 0]));
  const pf = makeTransit(planet), model = opts.model || Float64Array.from(t, pf);
  const r0 = opts.rmoonRef || 0.3 * rp, nPh = opts.nPhases || 48, K = opts.nNull || 0;
  const incM = el.inc + (opts.imoon || 0) * DEG, cosM = Math.cos(incM);
  const sepFor = (P) => moonGeometry({ ...planet, rmoon: r0, permoon: P, mmoon: 0 });
  // period range
  let pMin, pMax;
  if (opts.periods) [pMin, pMax] = opts.periods;
  else {
    const g = sepFor(1);
    if (g.mode !== 'kepler') throw new Error('moonSearch: give opts.periods when the separation is fixed');
    pMin = moonPeriodFor(Math.max(g.roche, rp + r0), planet); pMax = g.maxPeriod;
  }
  if (!(pMax > pMin && pMin > 0)) throw new Error('moonSearch: empty period range');
  // transits
  let jMin = Infinity, jMax = -Infinity, tLo = Infinity, tHi = -Infinity;
  const jt = new Int32Array(N);
  for (let i = 0; i < N; i++) { const j = Math.round((t[i] - el.tmid) / el.per); jt[i] = j; if (j < jMin) jMin = j; if (j > jMax) jMax = j; if (t[i] < tLo) tLo = t[i]; if (t[i] > tHi) tHi = t[i]; }
  const nT = jMax - jMin + 1, span = Math.max(tHi - tLo, el.per);
  // barycentre (= planet) position, weights, residual
  const Xb = new Float64Array(N), Yb = new Float64Array(N), dtj = new Float64Array(N), wr = new Float64Array(N), wi = new Float64Array(N), wp = new Float64Array(N), front = new Uint8Array(N), tmp = [0, 0, 0];
  const ortho = opts.fitDepth !== false; let Spp = 0, Srp = 0;
  for (let i = 0; i < N; i++) {
    bary(el, t[i], tmp); Xb[i] = tmp[0]; Yb[i] = tmp[1]; front[i] = tmp[2] > 0 ? 1 : 0;
    dtj[i] = t[i] - (el.tmid + jt[i] * el.per); wi[i] = 1 / (er[i] * er[i]); wr[i] = wi[i] * (model[i] - f[i]);
    const dip = 1 - model[i]; wp[i] = wi[i] * dip; Spp += wp[i] * dip; Srp += wr[i] * dip;
  }
  let gn = null; const Gp = new Float64Array(K);
  if (K) {
    const rng = makeRng(opts.seed ?? 1); gn = new Float64Array(K * N);
    for (let i = 0; i < K * N; i++) gn[i] = rng.normal();
    for (let k = 0; k < K; k++) for (let i = 0; i < N; i++) { gn[k * N + i] /= er[i]; Gp[k] += gn[k * N + i] * (1 - model[i]); }
  }
  // the planet's own mid-time in every transit is a nuisance too (a moon heavy enough to see also moves the planet):
  // q = d(model)/dt, and per transit the sums with it, used below to project it out of residuals, templates and the dip
  const timing = opts.fitTiming !== false, wq = new Float64Array(N), Sqq = new Float64Array(nT), Srq = new Float64Array(nT), Spq = new Float64Array(nT), Gq = new Float64Array(K * nT);
  if (timing) {
    const h = 1e-4 * (contactDuration(el, 1 + rp, el.tmid) || 0.1);
    for (let i = 0; i < N; i++) {
      const q = (pf(t[i] + h) - pf(t[i] - h)) / (2 * h), j = jt[i] - jMin; if (q === 0) continue;
      wq[i] = wi[i] * q; Sqq[j] += wq[i] * q; Srq[j] += wr[i] * q; Spq[j] += wp[i] * q;
      for (let k = 0; k < K; k++) Gq[k * nT + j] += gn[k * N + i] * q;
    }
    for (let j = 0; j < nT; j++) if (Sqq[j] > 0) { Spp -= (Spq[j] * Spq[j]) / Sqq[j]; Srp -= (Srq[j] * Spq[j]) / Sqq[j]; for (let k = 0; k < K; k++) Gp[k] -= (Gq[k * nT + j] * Spq[j]) / Sqq[j]; }
  }
  const useP = ortho && Spp > 0, kp = useP ? Srp / Spp : 0;
  // blocked fraction of the reference moon against its distance from the star's centre
  const NT = 2048, zMax = 1 + r0, tab = new Float64Array(NT + 2), zs = NT / zMax, lim2 = zMax * zMax;
  for (let i = 0; i <= NT; i++) tab[i] = blockedFraction((i / NT) * zMax, r0, ld);
  // coarse periods (log-spaced), tables per transit and phase
  const nC = Math.max(1, opts.nCoarse || Math.ceil(12 * Math.log2(pMax / pMin)) + 1), nPt = nPh, hid2 = rp > r0 ? (rp - r0) * (rp - r0) : 0;
  const cP = Float64Array.from({ length: nC }, (_, c) => (nC === 1 ? Math.sqrt(pMin * pMax) : pMin * Math.pow(pMax / pMin, c / (nC - 1))));
  const SA = new Float64Array(nC * nT * nPt), SB = new Float64Array(nC * nT * nPt), SC = new Float64Array(nC * nT * nPt), SD = timing ? new Float64Array(nC * nT * nPt) : null, SN = K ? new Float64Array(nC * K * nT * nPt) : null;
  const cs = new Float64Array(N), sn = new Float64Array(N), act = new Int32Array(N), cPh = new Float64Array(nPt), sPh = new Float64Array(nPt);
  for (let k = 0; k < nPt; k++) { const th = PI / 2 + (TWO_PI * k) / nPt; cPh[k] = Math.cos(th); sPh[k] = Math.sin(th); }
  for (let c = 0; c < nC; c++) {
    const aM = sepFor(cP[c]).aMoon, nm = TWO_PI / cP[c], xr = zMax + aM;
    let na = 0;
    for (let i = 0; i < N; i++) if (front[i] && Math.abs(Xb[i]) < xr) { act[na++] = i; cs[i] = Math.cos(nm * dtj[i]); sn[i] = Math.sin(nm * dtj[i]); }
    for (let k = 0; k < nPt; k++) {
      const C0 = cPh[k], S0 = sPh[k];
      for (let a = 0; a < na; a++) {
        const i = act[a], ct = cs[i] * C0 - sn[i] * S0, rx = aM * ct, xm = Xb[i] - rx;
        if (xm >= zMax || xm <= -zMax) continue;
        const st = sn[i] * C0 + cs[i] * S0, ry = aM * st * cosM, ym = Yb[i] - ry, z2 = xm * xm + ym * ym;
        if (z2 >= lim2 || rx * rx + ry * ry < hid2) continue;
        const zz = Math.sqrt(z2) * zs, iz = zz | 0, m = tab[iz] + (tab[iz + 1] - tab[iz]) * (zz - iz);
        const cell = (c * nT + (jt[i] - jMin)) * nPt + k;
        SA[cell] += wr[i] * m; SB[cell] += wi[i] * m * m; SC[cell] += wp[i] * m; if (timing) SD[cell] += wq[i] * m;
        for (let q = 0; q < K; q++) SN[((c * K + q) * nT + (jt[i] - jMin)) * nPt + k] += gn[q * N + i] * m;
      }
    }
  }
  if (timing) for (let c = 0; c < nC; c++) for (let j = 0; j < nT; j++) {
    if (!(Sqq[j] > 0)) continue;
    for (let k = 0; k < nPt; k++) {
      const cell = (c * nT + j) * nPt + k, x = SD[cell] / Sqq[j]; if (x === 0) continue;
      SA[cell] -= Srq[j] * x; SB[cell] -= SD[cell] * x; SC[cell] -= Spq[j] * x;
      for (let q = 0; q < K; q++) SN[((c * K + q) * nT + j) * nPt + k] -= Gq[q * nT + j] * x;
    }
  }
  // fine periods, uniform in frequency
  const fLo = 1 / pMax, fHi = 1 / pMin;
  const nP = Math.max(2, Math.min(opts.maxPeriods || 20000, Math.ceil((opts.oversample || 12) * span * (fHi - fLo)) + 1));
  const periods = new Float64Array(nP), phases = Float64Array.from({ length: nPh }, (_, k) => k / nPh);
  const snr = new Float32Array(nP * nPh), rmoon = new Float32Array(nP * nPh), profile = new Float32Array(nP).fill(-Infinity), nullMax = new Float64Array(K).fill(-Infinity);
  const k0 = new Int32Array(nT), fr = new Float64Array(nT), numN = new Float64Array(K);
  let best = { snr: -Infinity }, inv = { snr: Infinity };
  const lr = nC > 1 ? (nC - 1) / Math.log(pMax / pMin) : 0;
  for (let ip = 0; ip < nP; ip++) {
    const P = 1 / (fHi - ((fHi - fLo) * ip) / (nP - 1)); periods[ip] = P;
    const c = nC > 1 ? Math.min(nC - 1, Math.max(0, Math.round(Math.log(P / pMin) * lr))) : 0;
    // the moon's phase at transit j is phmoon + j per / P: table position and interpolation weight
    for (let j = 0; j < nT; j++) { let x = ((jMin + j) * el.per) / P; x = (x - Math.floor(x)) * nPt; k0[j] = x | 0; fr[j] = x - k0[j]; }
    for (let ih = 0; ih < nPh; ih++) {
      let num = 0, den = 0, crs = 0; numN.fill(0);
      for (let j = 0; j < nT; j++) {
        let ka = k0[j] + ih; if (ka >= nPt) ka -= nPt; let kb = ka + 1; if (kb >= nPt) kb = 0;
        const base = (c * nT + j) * nPt, u = fr[j];
        num += SA[base + ka] * (1 - u) + SA[base + kb] * u; den += SB[base + ka] * (1 - u) + SB[base + kb] * u; crs += SC[base + ka] * (1 - u) + SC[base + kb] * u;
        for (let q = 0; q < K; q++) { const bn = ((c * K + q) * nT + j) * nPt; numN[q] += SN[bn + ka] * (1 - u) + SN[bn + kb] * u; }
      }
      // the template made orthogonal to the planet's own dip: its depth is refitted along with every trial moon
      // (a template that keeps less than a twentieth of its weight is the planet's dip in all but name: skipped)
      if (!(den > 0)) continue;
      if (useP) { const d0 = den; num -= crs * kp; den -= (crs * crs) / Spp; if (!(den > 0.05 * d0)) continue; }
      const sd = Math.sqrt(den), z = num / sd, cell = ip * nPh + ih;
      snr[cell] = z; if (z > 0) rmoon[cell] = r0 * Math.sqrt(num / den);
      if (z > profile[ip]) profile[ip] = z;
      if (z > best.snr) best = { snr: z, ip, ih };
      if (z < inv.snr) inv = { snr: z, ip, ih };
      for (let q = 0; q < K; q++) { const zq = (useP ? numN[q] - (crs * Gp[q]) / Spp : numN[q]) / sd; if (zq > nullMax[q]) nullMax[q] = zq; }
    }
  }
  const bestOut = best.ip === undefined ? null : { permoon: periods[best.ip], phmoon: phases[best.ih], rmoon: rmoon[best.ip * nPh + best.ih], snr: best.snr, dchi2: best.snr * best.snr, amoon: sepFor(periods[best.ip]).aMoon };
  const invOut = inv.ip === undefined ? null : { permoon: periods[inv.ip], phmoon: phases[inv.ih], snr: -inv.snr };
  // the strongest separate peaks of the profile (aliases show here): local maxima at least 1.5 / baseline apart in frequency
  const order = Array.from({ length: nP }, (_, i) => i).filter((i) => profile[i] > 0).sort((a, b) => profile[b] - profile[a]), peaks = [], df = 1.5 / span;
  for (const i of order) { if (peaks.length >= 8) break; if (peaks.every((pk) => Math.abs(1 / periods[i] - 1 / pk.permoon) > df)) peaks.push({ permoon: periods[i], snr: profile[i] }); }
  let fap = NaN;
  if (K && bestOut) { let ge = 0; for (let q = 0; q < K; q++) if (nullMax[q] >= bestOut.snr) ge++; fap = (1 + ge) / (1 + K); }
  return { periods, phases, snr, rmoon, profile, peaks, best: bestOut, inverted: invOut, nullMax, fap, ntransits: nT, npoints: N, rmoonRef: r0,
    ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 };
}

/**
 * Orbital sampling effect (Heller 2014, ApJ 787, 14): over many transits a moon is seen at every phase of
 * its orbit, so the residuals from the planet's model, stacked on the planet's period, show its average
 * dimming: wings before and after the planet's transit, out to the moon's separation.
 * data: { t, f, e }; planet: makeTransit's parameters;
 * opts: { nbins (40), window (half-width in days, default: the data's largest offset from a mid-transit), model }
 * returns { x (days from mid-transit, bin centres), y (weighted mean of data - model), e, n } with empty bins left out.
 */
export function oseStack(data, planet, opts = {}) {
  const t = data.t, N = t.length, pf = makeTransit(planet), model = opts.model || Float64Array.from(t, pf);
  const dx = new Float64Array(N); let win = opts.window || 0;
  for (let i = 0; i < N; i++) { dx[i] = t[i] - planet.tmid - planet.per * Math.round((t[i] - planet.tmid) / planet.per); if (!opts.window && Math.abs(dx[i]) > win) win = Math.abs(dx[i]); }
  const nb = opts.nbins || 40, sw = new Float64Array(nb), sy = new Float64Array(nb), cnt = new Int32Array(nb);
  for (let i = 0; i < N; i++) {
    const b = Math.floor(((dx[i] + win) / (2 * win)) * nb); if (b < 0 || b >= nb) continue;
    const w = 1 / (data.e[i] * data.e[i]); sw[b] += w; sy[b] += w * (data.f[i] - model[i]); cnt[b]++;
  }
  const x = [], y = [], e = [], n = [];
  for (let b = 0; b < nb; b++) if (sw[b] > 0) { x.push(-win + ((b + 0.5) * 2 * win) / nb); y.push(sy[b] / sw[b]); e.push(1 / Math.sqrt(sw[b])); n.push(cnt[b]); }
  return { x: Float64Array.from(x), y: Float64Array.from(y), e: Float64Array.from(e), n: Int32Array.from(n), window: win };
}

/**
 * What the orbital sampling effect looks like for a given moon: the difference from the moonless light curve
 * averaged over nPhase equally spaced moon phases, at offsets x (days) from mid-transit.
 */
export function oseModel(params, x, nPhase = 48) {
  const out = new Float64Array(x.length), c = {};
  for (let k = 0; k < nPhase; k++) {
    const f = makePlanetMoonTransit({ ...params, phmoon: k / nPhase });
    for (let i = 0; i < x.length; i++) out[i] += f.components(params.tmid + x[i], c).diff / nPhase;
  }
  return out;
}
