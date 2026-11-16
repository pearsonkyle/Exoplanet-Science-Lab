// Secondary eclipses, phase curves and eclipse mapping.
//
// ============================== INTEGRATION ==================================
// For the owner of src/core/model.js. Nothing here edits model.js; three small changes there
// switch the light curve from "transit" to "transit + planet":
//
// 1. Keys. Add the phase keys to the fields a planet may scope, so "fpfs@c" works:
//        import { makePhaseCurve, PHASE_PARAMS, PHASE_FIELDS, toPhaseParams } from './phasecurve.js';
//        export const PLANET_FIELDS = ['rprs', ..., 'K', ...PHASE_FIELDS];
//    and add PHASE_PARAMS to PARAM_BY_KEY (and to activeParams with group: 'phase' when the fit
//    has spec.phase set). None of the keys collides with PARAMS, RV_PARAMS, MASS_PARAMS or
//    STAR_PARAMS today. If one ever does, rename it in PHASE_PARAMS only: every other place in
//    this file reads keys through PHASE_PARAMS / MAP_KEYS, apart from the literal property
//    names in resolvePhase() (one line each).
//    `pv[p]` in buildProblem needs the same fields: copy them with
//        for (const k of PHASE_FIELDS) q[k] = v[nm[k]];
//
// 2. Inside evaluate(), where the transit is compiled (the line `fluxes[p] = makeTransit(tp);`):
//        if (spec.phase) {
//          const pc = makePhaseCurve(toPhaseParams(q, tp, v), spec.phaseOpts);   // q = pv[p], tp = transit params
//          if (!pc.ok) return null;          // negative planet flux (or map, with phaseOpts.positiveMap): outside the prior
//          fluxes[p] = pc;                   // pc(t) = star x transit + planet, 1 + Fp/F* out of eclipse
//        } else fluxes[p] = makeTransit(tp);
//    Everything downstream is unchanged: exposure averaging calls fluxes[p](t) per sub-sample,
//    a1 (and per-epoch a1_s) is still integrated out, airmass still multiplies. pc(t) is the
//    system flux relative to the star alone, so a1 is the stellar flux, not the out-of-eclipse level.
//    With several planets model.js uses pc.two(t): flux = prod_p star_p(t) + sum_p planet_p(t), so the
//    star's light is counted once and no planet's light is dimmed by another planet's transit of the star.
//    Light-travel time is off unless spec.phaseOpts = { ltt: true }; it needs R* in solar radii, which
//    toPhaseParams copies from v.rstar (without it the delay is zero).
//
// 3. pieces(): `transit: tr` is now transit + planet. For plots use pc.parts(t), which returns
//    { star, planet, visible, phase } per time.
//
// What the session format (docs/FORMAT.md) lacks for this: a place to say the model is on
// (`"phase": { "mode": "harmonic" | "map", "ltt": bool, "band": [lo, hi] }` at the top level is what
// the example sessions in public/examples/phasecurve use; readers ignore unknown keys) and a
// band per light curve (the planet's flux ratio and the limb darkening both depend on it).
// Planet parameters already accept the extra keys.
// =============================================================================
//
// MODEL
//
//   F(t) = S(t) * T(t) + Fp(t) * V(t)            relative to the star alone
//
// T: transit (same kernel and limb darkening as transit.js). S = 1 unless the stellar terms are
// used. Fp: planet flux over stellar flux. V: fraction of the planet's light that reaches the
// observer (1 except behind the star). The orbit is the one the transit uses; phi is the orbital
// angle from superior conjunction, phi = omega + nu + 90 deg, so phi = 0 at mid-eclipse and 180 deg
// at mid-transit for every eccentricity (opts.phase = 'time' uses 2 pi (t - t_eclipse) / P instead,
// which is what EXOTIC does; the two are the same for circular orbits).
//
// Harmonic model (no map coefficients set), D = fpfs * rprs^2 the eclipse depth:
//   Fp(phi) = off + amp cos(phi + hotspot) + D [h2c (cos 2 phi - 1) + h2s sin 2 phi]
//   amp = D C / (2 - C + C cos hotspot),  off = D (2 - C) / (2 - C + C cos hotspot),  C = contrast
// so that Fp(0) = D exactly, (max - min) / max = C for the first-order curve, and Fp >= 0 for
// every C in [0, 1]. hotspot > 0 is an eastward hot spot: the curve peaks `hotspot` degrees of
// phase before mid-eclipse. V is the uniform-disc occultation (exact lens area, any eccentricity).
//
//   EXOTIC (multi_fitter.phasecurve, joint_fitter.phasecurve):
//     1 + c0 + c1 cos(phi) + c2 sin(phi) + c3 cos(2 phi) + c4 sin(2 phi),  c0 = D - c1 - c3
//     c1 = amp cos(hotspot)      c2 = -amp sin(hotspot)      c3 = D h2c      c4 = D h2s
//     c0 = off - D h2c                                           (harmonicCoefficients() does this)
//   Differences from EXOTIC, on purpose: (1) EXOTIC makes the eclipse with a transit of a body of
//   radius rprs sqrt(fpfs), so its ingress is sqrt(fpfs) times too short; here ingress lasts as long
//   as the planet's limb takes to cross the star's. (2) EXOTIC switches from the harmonic series to
//   a constant-depth eclipse where its eclipse model leaves 1, a step of Fp(phi_contact) - D; here Fp
//   is continuous and multiplied by V. (3) EXOTIC multiplies the planet's light by the transit; here
//   only the star is transited. (4) EXOTIC's phasecurve reads u1..u4 and calls the quadratic law with
//   four Claret coefficients; here limb darkening is the transit's (params.ldLaw, params.ld).
//   (5) c1, c2 free allow negative flux; contrast in [0, 1] cannot.
//
// Stellar terms (second order in phase, not eclipsed, may have either sign), in ppm:
//   S = 1 - ellip 1e-6 (a/r)^3 cos(2 phi) - beam 1e-6 [cos(omega + nu) + e cos(omega)]
// ellipsoidal: brightest at quadrature; beaming: brightest when the star approaches (a quarter
// of an orbit after transit). beam is degenerate with hotspot in a single band, as c2 is.
//
// Map model (any of y1m1 ... y33 set): the planet's brightness is
//   I(lat, lon) = I0 [1 + sum_lm y_lm Ylm(lat, lon)],   lon east from the substellar point
// with real spherical harmonics normalised as in starry (Luger et al. 2019): Y00 = 1,
// Y10 = sqrt(3) * (cosine of the angle from the substellar point), Y11 = sqrt(3) * east,
// Y1-1 = sqrt(3) * north, ... (table at MAP_BASIS). The planet keeps the same face to the star
// (synchronous; for an eccentric orbit this is a map fixed to the star-planet line). I0 is set so
// that the unocculted flux at phi = 0 is D = fpfs * rprs^2, as in the harmonic model.
//   Out of eclipse (Funk-Hecke): Fp = Dn [1 + (2/3) v.o + (1/4) o.Q.o], o the direction of the
//   observer in the planet's frame, v and Q the degree 1 and 2 parts of the map. Degree 3 is
//   invisible in the phase curve and visible only while the star's limb crosses the planet.
//   During ingress and egress the map is integrated over the part of the disc outside the star's
//   limb: ten moments of x^a y^b z^c over the lens, each a line integral (Green's theorem) with a
//   closed form on the planet's limb and 12 Gauss-Legendre nodes on the star's limb.
// contrast and hotspot remain valid in map mode: they are turned into y10 and y11
// (firstOrderToMap) and added to whatever y10, y11 are given.
//
//   Exoplanet-Mapping (fit_map.py, starry ydeg = 1, theta0 = 180): its parameters are in flux units,
//     y00 = Dn    y10 = Dn * y10    y11 = Dn * y11    y1m1 = Dn * y1m1    (exoplanetMappingCoefficients())
//   with Dn = D / (1 + (2/sqrt 3)(y10 sin i + y1m1 cos i) + ...), y10 the day-night term, y11 the
//   hot-spot offset (east positive), y1m1 latitude. It interpolates precomputed starry curves on an
//   inclination grid; here the curves are computed at the sampled orbit.
//
// Light-travel time (opts.ltt, needs params.rstar in R_sun): the planet is evaluated at
// t' = t - [Z_transit - Z(t)] R* / c, so the transit stays at tmid and the eclipse arrives late by
// (r_transit + r_eclipse) sin i / c: 2a/c for a circular orbit. lightTravelDelay() returns it:
// 50 s for a = 0.05 au, 13.5 s for WASP-43 b, 166 s for HD 80606 b (not the 460 s of 2a/c: its
// eclipse is near periastron). One fixed-point step; the neglected term is under 0.05 s.

import { orbitElements, solveKepler, trueAnomaly, eclipseTime } from './kepler.js';
import { blockedFraction } from './transit.js';
import { prepareLD, toClaret } from './limbdark.js';

const PI = Math.PI, DEG = PI / 180;
const S3 = Math.sqrt(3), S5 = Math.sqrt(5), S7 = Math.sqrt(7), S15 = Math.sqrt(15), S105 = Math.sqrt(105), S21_8 = Math.sqrt(21 / 8), S35_8 = Math.sqrt(35 / 8);
/** Days light takes to cross one solar radius (IAU nominal R_sun = 695700 km). */
export const RSUN_LIGHT_DAYS = 6.957e8 / 299792458 / 86400;

// ---- parameters -------------------------------------------------------------

/**
 * Real spherical harmonics of the map, starry normalisation (each is Y_lm / Y_00), in the planet's frame:
 * x east (longitude +90 deg on the equator), y north (the orbit normal), z toward the star (substellar point).
 */
export const MAP_BASIS = [
  { key: 'y1m1', l: 1, m: -1, label: 'Y1,-1', formula: '√3 y', help: 'North-south gradient (latitude of the hot spot). Seen only in eclipse ingress and egress' },
  { key: 'y10', l: 1, m: 0, label: 'Y1,0', formula: '√3 z', help: 'Day-night gradient' },
  { key: 'y11', l: 1, m: 1, label: 'Y1,1', formula: '√3 x', help: 'East-west gradient (hot-spot offset, east positive)' },
  { key: 'y2m2', l: 2, m: -2, label: 'Y2,-2', formula: '√15 xy', help: 'Degree 2: north-east against south-east. Eclipse only' },
  { key: 'y2m1', l: 2, m: -1, label: 'Y2,-1', formula: '√15 yz', help: 'Degree 2: north-south asymmetry of the dayside. Eclipse only (edge-on)' },
  { key: 'y20', l: 2, m: 0, label: 'Y2,0', formula: '(√5/2)(2z² − x² − y²)', help: 'Degree 2: substellar and antistellar points against the terminator' },
  { key: 'y21', l: 2, m: 1, label: 'Y2,1', formula: '√15 xz', help: 'Degree 2: east-west asymmetry of the dayside; sin 2φ in the phase curve' },
  { key: 'y22', l: 2, m: 2, label: 'Y2,2', formula: '(√15/2)(x² − y²)', help: 'Degree 2: equator against poles; cos 2φ in the phase curve' },
  { key: 'y3m3', l: 3, m: -3, label: 'Y3,-3', formula: '√(35/8) (3x² − y²) y' },
  { key: 'y3m2', l: 3, m: -2, label: 'Y3,-2', formula: '√105 xyz' },
  { key: 'y3m1', l: 3, m: -1, label: 'Y3,-1', formula: '√(21/8) y (4z² − x² − y²)' },
  { key: 'y30', l: 3, m: 0, label: 'Y3,0', formula: '(√7/2) z (2z² − 3x² − 3y²)' },
  { key: 'y31', l: 3, m: 1, label: 'Y3,1', formula: '√(21/8) x (4z² − x² − y²)' },
  { key: 'y32', l: 3, m: 2, label: 'Y3,2', formula: '(√105/2)(x² − y²) z' },
  { key: 'y33', l: 3, m: 3, label: 'Y3,3', formula: '√(35/8) (x² − 3y²) x' },
];
/** Keys of the map coefficients up to degree lmax (1 to 3). */
export const mapKeys = (lmax = 2) => MAP_BASIS.filter((b) => b.l <= lmax).map((b) => b.key);
export const MAP_KEYS = mapKeys(3);

/**
 * Parameter registry in the style of PARAMS in model.js, with a default prior for each
 * (uniform over [prior.a, prior.b]) and the value a new fit starts from (`def`).
 * All are planet-level keys: "fpfs" for the first planet, "fpfs@c" for planet c.
 */
export const PHASE_PARAMS = [
  { key: 'fpfs', label: 'Fp/F★', unit: '', min: 0, max: 1, step: 0.0001, digits: 5, def: 0.1, prior: { type: 'uniform', a: 0, b: 0.5 }, group: 'phase',
    help: 'Dayside surface brightness of the planet over the star\'s in this band. Eclipse depth = Fp/F★ × (Rp/R★)², as in EXOTIC' },
  { key: 'contrast', label: 'day-night', unit: '', min: 0, max: 1, step: 0.001, digits: 3, def: 0.5, prior: { type: 'uniform', a: 0, b: 1 }, group: 'phase',
    help: 'Day-night contrast of the first-order phase curve, (max − min) / max. 0: flat; 1: dark night side' },
  { key: 'hotspot', label: 'hot spot', unit: '°', min: -180, max: 180, step: 0.1, digits: 2, def: 0, prior: { type: 'uniform', a: -90, b: 90 }, group: 'phase',
    help: 'Phase offset of the brightest hemisphere, east positive: the phase curve peaks this many degrees of orbit before mid-eclipse' },
  { key: 'h2c', label: 'cos 2φ', unit: '× depth', min: -0.5, max: 0.5, step: 0.001, digits: 4, def: 0, prior: { type: 'uniform', a: -0.25, b: 0.25 }, group: 'phase',
    help: 'Second harmonic of the planet\'s phase curve, cosine term, as a fraction of the eclipse depth (EXOTIC c3 / depth)' },
  { key: 'h2s', label: 'sin 2φ', unit: '× depth', min: -0.5, max: 0.5, step: 0.001, digits: 4, def: 0, prior: { type: 'uniform', a: -0.25, b: 0.25 }, group: 'phase',
    help: 'Second harmonic of the planet\'s phase curve, sine term, as a fraction of the eclipse depth (EXOTIC c4 / depth)' },
  { key: 'ellip', label: 'ellipsoidal', unit: 'ppm', min: -500, max: 2000, step: 0.1, digits: 1, def: 0, prior: { type: 'uniform', a: 0, b: 500 }, group: 'phase',
    help: 'Ellipsoidal variation of the star: semi-amplitude of −cos 2φ, not eclipsed' },
  { key: 'beam', label: 'beaming', unit: 'ppm', min: -200, max: 200, step: 0.01, digits: 2, def: 0, prior: { type: 'uniform', a: -50, b: 50 }, group: 'phase',
    help: 'Doppler beaming of the star: semi-amplitude, brightest a quarter orbit after transit' },
  ...MAP_BASIS.map((b) => ({ key: b.key, label: b.label, unit: '', min: -1.5, max: 1.5, step: 0.001, digits: 4, def: 0, map: true, l: b.l, m: b.m, group: 'phase',
    prior: { type: 'uniform', a: b.l === 1 ? -0.6 : -0.3, b: b.l === 1 ? 0.6 : 0.3 },
    help: `Map coefficient of ${b.formula}, relative to the uniform term. ${b.help || 'Degree 3: eclipse ingress and egress only'}` })),
];
/** Field names to append to PLANET_FIELDS in model.js. */
export const PHASE_FIELDS = PHASE_PARAMS.map((p) => p.key);
export const PHASE_BY_KEY = Object.fromEntries(PHASE_PARAMS.map((p) => [p.key, p]));

/**
 * Parameters for makePhaseCurve from model.js's objects: q = one planet's resolved values (pv[p], with
 * the phase fields copied in), tp = its transit parameters (toTransitParams), v = all values (for rstar).
 */
export function toPhaseParams(q, tp, v = {}) {
  const o = { ...tp };
  for (const k of PHASE_FIELDS) if (q[k] !== undefined) o[k] = q[k];
  if (v.rstar !== undefined) o.rstar = v.rstar;
  return o;
}

// ---- geometry kernels ---------------------------------------------------------

/** Area common to a unit circle and a circle of radius R whose centre is d away, divided by pi. */
export function lensFraction(d, R) {
  if (d >= 1 + R) return 0;
  if (d <= R - 1) return 1;
  if (d <= 1 - R) return R * R;
  const k0 = Math.acos(Math.min(1, Math.max(-1, (R * R + d * d - 1) / (2 * R * d))));
  const k1 = Math.acos(Math.min(1, Math.max(-1, (1 - R * R + d * d) / (2 * d))));
  return (R * R * k0 + k1 - 0.5 * Math.sqrt(Math.max(0, 4 * d * d - (1 + d * d - R * R) ** 2))) / PI;
}

// Gauss-Legendre nodes on (0, 1)
function gl01(n) {
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < (n + 1) >> 1; i++) {
    let z = Math.cos(PI * (i + 0.75) / (n + 0.5)), pp = 1;
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
      pp = n * (z * p1 - p2) / (z * z - 1);
      const dz = p1 / pp; z -= dz;
      if (Math.abs(dz) < 1e-16) break;
    }
    x[i] = 0.5 * (1 - z); x[n - 1 - i] = 0.5 * (1 + z);
    w[i] = w[n - 1 - i] = 1 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
}
const N_ARC = 12;
const ARC = gl01(N_ARC), ARC_SIN = new Float64Array(N_ARC), ARC_W = new Float64Array(N_ARC);
for (let k = 0; k < N_ARC; k++) { const psi = 0.5 * PI * ARC.x[k]; ARC_SIN[k] = Math.sin(psi); ARC_W[k] = ARC.w[k] * 0.5 * PI * Math.cos(psi); }

/**
 * Moments of the visible part of the planet's disc, (1/pi) int x^a y^b z^c dA over the unit disc outside a
 * circle of radius R centred at (-d, 0), z = sqrt(1 - x^2 - y^2). Needs |R - d| < 1 (partial occultation).
 * out = [m000, m100, m200, m020, m300, m120, m001, m101, m201, m021]; odd powers of y vanish by symmetry.
 */
export function visibleMoments(d, R, out) {
  // planet-limb arc of the occulted region: alpha in (pi - beta, pi + beta)
  const cb = (d * d + 1 - R * R) / (2 * d), beta = Math.acos(cb > 1 ? 1 : cb < -1 ? -1 : cb);
  const S0 = 2 * beta, S1 = -2 * Math.sin(beta), S2 = Math.sin(2 * beta), S3_ = -2 * Math.sin(3 * beta) / 3, S4 = Math.sin(4 * beta) / 2, S5_ = -2 * Math.sin(5 * beta) / 5;
  let k000 = (S0 + S2) / 2, k100 = (3 * S1 + S3_) / 8, k200 = (3 * S0 + 4 * S2 + S4) / 24, k020 = (S0 - S4) / 8;
  let k300 = (10 * S1 + 5 * S3_ + S5_) / 64, k120 = (2 * S1 - S3_ - S5_) / 32;
  let k001 = S0 / 3, k101 = 0, k201 = (S0 + S2) / 15, k021 = (S0 - S2) / 15;
  // star-limb arc: theta in (-theta0, theta0) about the star's centre, theta = theta0 sin(psi)
  const sh2 = (1 - (d - R) * (d - R)) / (4 * d * R), th0 = 2 * Math.asin(Math.sqrt(sh2 > 0 ? (sh2 < 1 ? sh2 : 1) : 0));
  const dR4 = 4 * d * R;
  for (let k = 0; k < N_ARC; k++) {
    const th = th0 * ARC_SIN[k], w = 2 * th0 * ARC_W[k];          // factor 2: both halves of the arc
    const sth = Math.sin(th), hs = Math.sin(0.5 * th), cth = 1 - 2 * hs * hs;
    const x = (R - d) - 2 * R * hs * hs, y = R * sth, y2 = y * y, x2 = x * x;
    const z2 = Math.max(0, dR4 * Math.sin(0.5 * (th0 - th)) * Math.sin(0.5 * (th0 + th))), z = Math.sqrt(z2), z3 = z2 * z;
    const s = 1 - z2;                                             // rho^2
    const wy = w * R * cth;                                       // dy
    k000 += wy * x; k100 += wy * x2 / 2; k200 += wy * x2 * x / 3; k020 += wy * x * y2;
    k300 += wy * x2 * x2 / 4; k120 += wy * x2 * y2 / 2;
    let h0, h2;
    if (s < 0.02) { h0 = 0.5 - s * (1 / 8 + s * (1 / 48 + s * (1 / 128 + s / 256))); h2 = 0.25 - s * (1 / 12 + s * (1 / 64 + s * (1 / 160 + s * 5 / 1536))); }
    else { h0 = (1 - z3) / (3 * s); h2 = ((1 - z3) / 3 - (1 - z3 * z2) / 5) / (s * s); }
    const wr = w * R * ((R - d) + 2 * d * hs * hs);               // x dy - y dx
    k001 += wr * h0; k201 += wr * h2 * x2; k021 += wr * h2 * y2;
    k101 -= wy * z3 / 3;
  }
  out[0] = 1 - k000 / PI; out[1] = -k100 / PI; out[2] = 0.25 - k200 / PI; out[3] = 0.25 - k020 / PI; out[4] = -k300 / PI; out[5] = -k120 / PI;
  out[6] = 2 / 3 - k001 / PI; out[7] = -k101 / PI; out[8] = 2 / 15 - k201 / PI; out[9] = 2 / 15 - k021 / PI;
  return out;
}

// ---- the map as a polynomial ---------------------------------------------------

/**
 * Degree 1, 2 and 3 parts of the map as a vector, a symmetric matrix and a symmetric rank-3 tensor in the
 * planet's frame (east, north, substellar):  I/I0 = 1 + v.b + b.Q.b + T(b, b, b).
 * y: object with any of the MAP_KEYS. Returns { v, Q (9), T (27) | null, lmax }.
 */
export function mapTensors(y) {
  const g = (k) => +y[k] || 0;
  const v = [S3 * g('y11'), S3 * g('y1m1'), S3 * g('y10')];
  const Q = new Float64Array(9);
  const a = g('y2m2'), b = g('y2m1'), c = g('y20'), d = g('y21'), e = g('y22');
  Q[0] = -0.5 * S5 * c + 0.5 * S15 * e; Q[4] = -0.5 * S5 * c - 0.5 * S15 * e; Q[8] = S5 * c;
  Q[1] = Q[3] = 0.5 * S15 * a; Q[5] = Q[7] = 0.5 * S15 * b; Q[2] = Q[6] = 0.5 * S15 * d;
  let T = null, lmax = (a || b || c || d || e) ? 2 : (v[0] || v[1] || v[2]) ? 1 : 0;
  const c3 = ['y3m3', 'y3m2', 'y3m1', 'y30', 'y31', 'y32', 'y33'].map(g);
  if (c3.some((x) => x)) {
    T = new Float64Array(27); lmax = 3;
    const add = (i, j, k, val) => {            // coefficient of the monomial b_i b_j b_k, spread over its permutations
      const perms = new Set([[i, j, k], [i, k, j], [j, i, k], [j, k, i], [k, i, j], [k, j, i]].map((q) => 9 * q[0] + 3 * q[1] + q[2]));
      for (const idx of perms) T[idx] += val / perms.size;
    };
    const [m3, m2, m1, z0, p1, p2, p3] = c3;
    add(0, 0, 1, 3 * S35_8 * m3); add(1, 1, 1, -S35_8 * m3);
    add(0, 1, 2, S105 * m2);
    add(1, 2, 2, 4 * S21_8 * m1); add(0, 0, 1, -S21_8 * m1); add(1, 1, 1, -S21_8 * m1);
    add(2, 2, 2, S7 * z0); add(0, 0, 2, -1.5 * S7 * z0); add(1, 1, 2, -1.5 * S7 * z0);
    add(0, 2, 2, 4 * S21_8 * p1); add(0, 0, 0, -S21_8 * p1); add(0, 1, 1, -S21_8 * p1);
    add(0, 0, 2, 0.5 * S105 * p2); add(1, 1, 2, -0.5 * S105 * p2);
    add(0, 0, 0, S35_8 * p3); add(0, 1, 1, -3 * S35_8 * p3);
  }
  return { v, Q, T, lmax };
}

function polyAt(mt, bx, by, bz) {
  const { v, Q, T } = mt;
  let s = 1 + v[0] * bx + v[1] * by + v[2] * bz
    + Q[0] * bx * bx + Q[4] * by * by + Q[8] * bz * bz + 2 * (Q[1] * bx * by + Q[2] * bx * bz + Q[5] * by * bz);
  if (T) {      // symmetric: ten distinct monomials
    s += T[0] * bx * bx * bx + T[13] * by * by * by + T[26] * bz * bz * bz + 3 * (T[1] * bx * bx * by + T[2] * bx * bx * bz + T[4] * bx * by * by + T[14] * by * by * bz + T[8] * bx * bz * bz + T[17] * by * bz * bz) + 6 * T[5] * bx * by * bz;
  }
  return s;
}

/** Brightness of the map relative to its uniform term at latitude and longitude (degrees, east from the substellar point). */
export function mapIntensity(y, latDeg, lonDeg) {
  const mt = y && y.v ? y : mapTensors(y), la = latDeg * DEG, lo = lonDeg * DEG, cl = Math.cos(la);
  return polyAt(mt, cl * Math.sin(lo), Math.sin(la), cl * Math.cos(lo));
}

// eigenvalues and eigenvectors of a symmetric 3 x 3 matrix (cyclic Jacobi): { val: [3], vec: [3][3] (vec[k] = k-th eigenvector) }
function eigSym3(Q) {
  const A = [[Q[0], Q[1], Q[2]], [Q[3], Q[4], Q[5]], [Q[6], Q[7], Q[8]]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2; if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), c = Math.cos(th), sn = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
    }
  }
  const ord = [0, 1, 2].sort((i, j) => A[i][i] - A[j][j]);
  return { val: ord.map((i) => A[i][i]), vec: ord.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}

/**
 * Smallest brightness of a map over the whole sphere, relative to its uniform term (negative: the map is unphysical).
 * Degree 1: 1 - |v| exactly. Degree 2: min of 1 + v.b + b.Q.b on |b| = 1, a trust-region problem solved exactly: with
 * Q = sum q_k e_k e_k^T (q ascending) and w_k = e_k.v, the minimiser is b = -sum w_k e_k / (2 (q_k - mu)) with the
 * multiplier mu < q_1 the root of sum w_k^2 / (4 (q_k - mu)^2) = 1 (bisection), or, when w_1 is too small for a root
 * (the "hard case"), that point plus the multiple of e_1 that puts it on the sphere. Degree 3: a 5 degree grid and a
 * pattern search from its lowest point. The whole sphere is tested, including the polar cap an inclined orbit never
 * turns toward the observer (latitudes beyond i from the visible pole: under 3 degrees for a transiting planet).
 */
export function mapMinimum(y) {
  const mt = y && y.v ? y : mapTensors(y), v = mt.v;
  if (mt.lmax <= 1) return 1 - Math.hypot(v[0], v[1], v[2]);
  if (mt.lmax === 2) {
    const { val: q, vec: E } = eigSym3(mt.Q), w = E.map((e) => e[0] * v[0] + e[1] * v[1] + e[2] * v[2]);
    const vn = Math.hypot(v[0], v[1], v[2]), at = (bk) => { let f = 1; for (let k = 0; k < 3; k++) f += q[k] * bk[k] * bk[k] + w[k] * bk[k]; return f; };
    if (vn === 0) return 1 + q[0];
    const phi = (t) => { let s = 0; for (let k = 0; k < 3; k++) { const d = q[k] - q[0] + t; s += (w[k] * w[k]) / (4 * d * d); } return s; };   // mu = q_1 - t, t > 0
    let best = Infinity;
    // regular case: phi(t) falls from +inf (t -> 0, w_1 != 0) to phi(vn / 2) <= 1
    let lo = 0, hi = vn / 2 + 1e-300;
    if (phi(1e-15 * (1 + vn)) > 1) {
      for (let it = 0; it < 200; it++) { const mid = 0.5 * (lo + hi); if (phi(mid) > 1) lo = mid; else hi = mid; }
      const t = 0.5 * (lo + hi), bk = q.map((qk, k) => -w[k] / (2 * (qk - q[0] + t)));
      best = at(bk);
    }
    // hard case (and a guard near it): mu = q_1, components along the other eigenvectors fixed, the rest along e_1
    const bk = [0, 0, 0]; let r2 = 0;
    for (let k = 1; k < 3; k++) { const d = q[k] - q[0]; bk[k] = d > 1e-14 ? -w[k] / (2 * d) : 0; r2 += bk[k] * bk[k]; }
    if (r2 <= 1) { const tau = Math.sqrt(1 - r2); bk[0] = tau; const f1 = at(bk); bk[0] = -tau; best = Math.min(best, f1, at(bk)); }
    return best;
  }
  let minI = Infinity, bla = 0, blo = 0;
  for (let i = 0; i <= 36; i++) { const la = -PI / 2 + (i * PI) / 36, cl = Math.cos(la), sl = Math.sin(la); for (let j = 0; j < (i === 0 || i === 36 ? 1 : 72); j++) { const lo = (j * PI) / 36, I = polyAt(mt, cl * Math.sin(lo), sl, cl * Math.cos(lo)); if (I < minI) { minI = I; bla = la; blo = lo; } } }
  for (let step = PI / 72; step > 1e-6; step /= 2) for (let rep = 0; rep < 3; rep++) for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const la = Math.max(-PI / 2, Math.min(PI / 2, bla + da * step)), lo = blo + (db * step) / Math.max(0.05, Math.cos(bla)), cl = Math.cos(la), I = polyAt(mt, cl * Math.sin(lo), Math.sin(la), cl * Math.cos(lo));
    if (I < minI) { minI = I; bla = la; blo = lo; }
  }
  return minI;
}

/**
 * y10 and y11 that give a first-order phase curve with this contrast and hot-spot offset at inclination inc (deg):
 * 1 + a cos(phi + hotspot), a = C / (2 - C). A map of degree 1 is non-negative only for C <= 0.8 at 90 deg.
 */
export function firstOrderToMap(contrast, hotspotDeg, incDeg = 90) {
  const a = contrast / (2 - contrast), s = (2 / S3) * Math.sin(incDeg * DEG), h = hotspotDeg * DEG;
  return { y10: (a * Math.cos(h)) / s, y11: (a * Math.sin(h)) / s };
}

// ---- parameter resolution -----------------------------------------------------

function resolvePhase(params, opts) {
  const p = Math.abs(params.rprs), D = (+params.fpfs || 0) * p * p;
  const C = Math.min(1, Math.max(0, +params.contrast || 0)), hs = (+params.hotspot || 0) * DEG;
  const h2c = +params.h2c || 0, h2s = +params.h2s || 0;
  const mapMode = opts.map !== undefined ? !!opts.map : MAP_KEYS.some((k) => +params[k]);
  const den = 2 - C + C * Math.cos(hs);
  const amp = (D * C) / den, off = (D * (2 - C)) / den;
  // the map: given coefficients plus the first-order terms from contrast / hotspot
  const y = {}; for (const k of MAP_KEYS) y[k] = +params[k] || 0;
  if (C > 0) { const f = firstOrderToMap(C, hs / DEG, params.inc); y.y10 += f.y10; y.y11 += f.y11; }
  const mt = mapTensors(y);
  return { p, D, C, hs, h2c, h2s, amp, off, mapMode, y, mt, ellip: (+params.ellip || 0) * 1e-6, beam: (+params.beam || 0) * 1e-6 };
}

/** Disc-integrated flux of the map seen from direction o = (east, north, substellar), over that of the uniform term. */
function mapPhase(mt, ox, oy, oz) {
  const { v, Q } = mt;
  return 1 + (2 / 3) * (v[0] * ox + v[1] * oy + v[2] * oz)
    + 0.25 * (Q[0] * ox * ox + Q[4] * oy * oy + Q[8] * oz * oz + 2 * (Q[1] * ox * oy + Q[2] * ox * oz + Q[5] * oy * oz));
}

// ---- the light curve ------------------------------------------------------------

/**
 * Compile a parameter set into a fast evaluator of the system flux relative to the star alone.
 *
 * params: { rprs, per, tmid, ars, inc (deg), ecc, omega (deg), ldLaw, ld: [...],       the transit's own
 *           fpfs, contrast, hotspot (deg), h2c, h2s, ellip (ppm), beam (ppm),          PHASE_PARAMS
 *           y1m1, y10, y11, y2m2 ... y33,                                              map coefficients (MAP_KEYS)
 *           rstar (R_sun, only for light-travel time) }
 * opts:   { phase: 'orbit' (default) | 'time',   phase angle from the true anomaly, or linear in time as in EXOTIC
 *           ltt: bool,                            light-travel delay of the planet's light (needs params.rstar)
 *           map: bool,                            force the map model on or off (default: on when a y_lm is non-zero)
 *           positiveMap: bool,                    ok = false when the map is negative anywhere (default: only flux is checked)
 *           clamp: bool }                         false: let the planet's flux go negative instead of flooring it at 0 (basis curves)
 *
 * Returns a function flux(t) with properties:
 *   star(t)     transit x stellar terms            planet(t)   planet flux reaching the observer
 *   parts(t)    { star, planet, visible (0..1), phase (rad from mid-eclipse) }
 *   two(t, out) the same two numbers without an allocation: out[0] = star, out[1] = planet
 *   phaseFlux(phi)  unocculted planet flux at phase phi (rad), for a circular orbit at this inclination
 *   depth       fpfs rprs^2                        tecl        mid-eclipse time (with the delay when ltt)
 *   lttDelay    days the eclipse is late           mode        'harmonic' | 'map'
 *   minFlux     smallest unocculted planet flux over the orbit (clamped to 0 in flux(t) if negative)
 *   minIntensity  smallest map brightness over the sphere relative to its mean (map mode and harmonic first order)
 *   negative    minFlux < 0                        negativeMap minIntensity < 0
 *   ok          !negative (and !negativeMap with opts.positiveMap)
 *   y, tensors  the map coefficients in use (including those from contrast / hotspot)
 */
export function makePhaseCurve(params, opts = {}) {
  const el = orbitElements(params), q = resolvePhase(params, opts);
  const ld = prepareLD(toClaret(params.ldLaw || 'nonlinear', params.ld || [0, 0, 0, 0]));
  const { e, w, n, M0, tmid, ars, cosI, sinI } = el;
  const { p, D, amp, off, h2c, h2s, mt, mapMode, ellip, beam } = q;
  const lim = (1 + p) * (1 + p), R = 1 / p, chs = Math.cos(q.hs), shs = Math.sin(q.hs);
  const stellar = ellip !== 0 || beam !== 0, ecw = e * Math.cos(w), harm2 = h2c !== 0 || h2s !== 0;
  const clamp = opts.clamp !== false, tecl0 = eclipseTime(el), timePhase = opts.phase === 'time' && e > 0;
  // light-travel time
  const rTr = (ars * (1 - e * e)) / (1 + e * Math.sin(w)), rEc = (ars * (1 - e * e)) / (1 - e * Math.sin(w));
  const kappa = opts.ltt && params.rstar > 0 ? params.rstar * RSUN_LIGHT_DAYS : 0, zTr = rTr * sinI;
  const lttDelay = kappa * (rTr + rEc) * sinI;
  // map normalisation: unocculted flux at phi = 0 is D
  const Ge = mapPhase(mt, 0, cosI, sinI), Dn = mapMode ? D / Ge : D;
  const mom = new Float64Array(10), Mr = new Float64Array(9);

  // unocculted planet flux at orbital angle with cos(phi) = cph, sin(phi) = sph
  const harmonic = (cph, sph) => {
    let f = off + amp * (cph * chs - sph * shs);
    if (harm2) f += D * (h2c * (2 * cph * cph - 2) + h2s * 2 * sph * cph);
    return f;
  };
  const second = (cph, sph) => D * (h2c * (2 * cph * cph - 2) + h2s * 2 * sph * cph);
  const phaseFlux = (phi) => {
    const c = Math.cos(phi), s = Math.sin(phi);
    return mapMode ? Dn * mapPhase(mt, -s * sinI, cosI, c * sinI) + (harm2 ? second(c, s) : 0) : harmonic(c, s);
  };
  // diagnostics: smallest flux over the orbit (a trigonometric polynomial of degree <= 2: 72 samples and a parabola
  // through the lowest three), smallest brightness over the sphere (closed form for degree 1, else a 15 degree grid
  // refined by a pattern search)
  // (the nightside, phi = 180 deg, is one of these phases: a curve that is non-negative everywhere has a non-negative nightside)
  let minFlux = Infinity, iMin = 0; const NPH = 72, fl = new Float64Array(NPH);
  for (let i = 0; i < NPH; i++) { fl[i] = phaseFlux((2 * PI * i) / NPH); if (fl[i] < minFlux) { minFlux = fl[i]; iMin = i; } }
  { // golden-section search between the neighbours of the lowest sample (the curve is smooth on that scale)
    let a = (2 * PI * (iMin - 1)) / NPH, b = (2 * PI * (iMin + 1)) / NPH;
    for (let it = 0; it < 40; it++) { const m1 = a + 0.381966 * (b - a), m2 = a + 0.618034 * (b - a); if (phaseFlux(m1) < phaseFlux(m2)) b = m2; else a = m1; }
    minFlux = Math.min(minFlux, phaseFlux(0.5 * (a + b)));
  }
  const minIntensity = mapMinimum(mt);
  if (!(Ge > 0)) minFlux = -Infinity;
  const negative = minFlux < -1e-15 * Math.max(D, 1e-300) || !(Ge > 0), negativeMap = minIntensity < -1e-12;

  // map flux during a partial eclipse: rotate the polynomial into the frame of the lens and contract with its moments
  const partialMap = (X, Y, z, cu, su) => {
    visibleMoments(z * R, R, mom);
    const ax = [-su, cu * cosI, -cu * sinI], ay = [0, sinI, cosI], az = [cu, su * cosI, -su * sinI];   // east, north, substellar on the sky
    const e1x = X / z, e1y = Y / z;
    Mr[0] = ax[0] * e1x + ax[1] * e1y; Mr[1] = -ax[0] * e1y + ax[1] * e1x; Mr[2] = ax[2];
    Mr[3] = ay[0] * e1x + ay[1] * e1y; Mr[4] = -ay[0] * e1y + ay[1] * e1x; Mr[5] = ay[2];
    Mr[6] = az[0] * e1x + az[1] * e1y; Mr[7] = -az[0] * e1y + az[1] * e1x; Mr[8] = az[2];
    const { v, Q, T } = mt;
    const m000 = mom[0], m100 = mom[1], m200 = mom[2], m020 = mom[3], m300 = mom[4], m120 = mom[5], m001 = mom[6], m101 = mom[7], m201 = mom[8], m021 = mom[9];
    let f = m000;
    f += (v[0] * Mr[0] + v[1] * Mr[3] + v[2] * Mr[6]) * m100 + (v[0] * Mr[2] + v[1] * Mr[5] + v[2] * Mr[8]) * m001;
    if (mt.lmax >= 2) {
      const qf = (j, k) => {
        let s = 0;
        for (let a = 0; a < 3; a++) { const ma = Mr[3 * a + j]; if (ma === 0) continue; s += ma * (Q[3 * a] * Mr[k] + Q[3 * a + 1] * Mr[3 + k] + Q[3 * a + 2] * Mr[6 + k]); }
        return s;
      };
      f += qf(0, 0) * m200 + qf(1, 1) * m020 + qf(2, 2) * (m000 - m200 - m020) + 2 * qf(0, 2) * m101;
    }
    if (T) {
      const tf = (j, k, l) => {
        let s = 0;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { const mm = Mr[3 * a + j] * Mr[3 * b + k]; s += mm * (T[9 * a + 3 * b] * Mr[l] + T[9 * a + 3 * b + 1] * Mr[3 + l] + T[9 * a + 3 * b + 2] * Mr[6 + l]); }
        return s;
      };
      f += tf(0, 0, 0) * m300 + 3 * tf(0, 1, 1) * m120 + 3 * tf(0, 2, 2) * (m100 - m300 - m120)
        + 3 * tf(0, 0, 2) * m201 + 3 * tf(1, 1, 2) * m021 + tf(2, 2, 2) * (m001 - m201 - m021);
    }
    return f;
  };

  // state shared by flux(), star(), planet(), parts()
  let stS = 1, stP = 0, stV = 1, stPhi = 0;
  const evalAt = (t) => {
    let u, r, E = 0;
    const orbit = (tt) => {
      if (e === 0) { u = PI / 2 + n * (tt - tmid); r = ars; }
      else { E = solveKepler(M0 + n * (tt - tmid), e); u = w + trueAnomaly(E, e); r = ars * (1 - e * Math.cos(E)); }
    };
    orbit(t);
    if (kappa > 0) orbit(t - kappa * (zTr - r * Math.sin(u) * sinI));
    const su = Math.sin(u), cu = Math.cos(u);
    const X = -r * cu, Y = -r * su * cosI, d2 = X * X + Y * Y, front = su * sinI > 0;
    // star
    let S = 1;
    if (stellar) { const x = ars / r; S -= ellip * x * x * x * (2 * su * su - 1) + beam * (cu + ecw); }
    if (front && d2 < lim) S *= 1 - blockedFraction(Math.sqrt(d2), p, ld);
    // planet: cos(phi) = -sin(u), sin(phi) = cos(u)
    let cph = -su, sph = cu;
    if (timePhase) { const ph = n * (t - tecl0 - lttDelay); cph = Math.cos(ph); sph = Math.sin(ph); }
    let Fp, V = 1;
    const hidden = !front && d2 < lim;
    if (!mapMode) {
      Fp = harmonic(cph, sph); if (Fp < 0 && clamp) Fp = 0;
      if (hidden) { V = 1 - lensFraction(Math.sqrt(d2), p) / (p * p); Fp *= V; }
    } else {
      let extra = harm2 ? second(cph, sph) : 0;
      if (!hidden) { Fp = Dn * mapPhase(mt, -sph * sinI, cosI, cph * sinI) + extra; if (Fp < 0 && clamp) Fp = 0; }
      else {
        const z = Math.sqrt(d2);
        if (z <= 1 - p) { Fp = 0; V = 0; }
        else {
          const g = partialMap(X, Y, z, cu, su);
          V = mom[0]; Fp = Dn * g + extra * V; if (Fp < 0 && clamp) Fp = 0;
        }
      }
    }
    stS = S; stP = Fp; stV = V; stPhi = Math.atan2(sph, cph);
  };
  const flux = (t) => { evalAt(t); return stS + stP; };
  flux.star = (t) => { evalAt(t); return stS; };
  flux.planet = (t) => { evalAt(t); return stP; };
  flux.parts = (t) => { evalAt(t); return { star: stS, planet: stP, visible: stV, phase: stPhi }; };
  // both parts in one evaluation, for the sum over several planets in model.js: out[0] = star, out[1] = planet
  flux.two = (t, out) => { evalAt(t); out[0] = stS; out[1] = stP; return out; };
  flux.phaseFlux = phaseFlux;
  flux.depth = D; flux.tecl = tecl0 + lttDelay; flux.lttDelay = lttDelay; flux.mode = mapMode ? 'map' : 'harmonic';
  flux.minFlux = minFlux; flux.minIntensity = minIntensity; flux.negative = negative; flux.negativeMap = negativeMap;
  flux.ok = !negative && !(opts.positiveMap && negativeMap);
  flux.y = q.y; flux.tensors = mt; flux.norm = Dn; flux.elements = el;
  return flux;
}

/** Evaluate the model on an array of times; opts.exptime (days) and opts.supersample average over each exposure. */
export function phaseCurveModel(times, params, out, opts = {}) {
  const f = makePhaseCurve(params, opts), N = times.length;
  out = out || new Float64Array(N);
  const ns = opts.exptime > 0 ? Math.max(1, opts.supersample | 0) : 1;
  if (ns === 1) for (let i = 0; i < N; i++) out[i] = f(times[i]);
  else { const dt = opts.exptime / ns; for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < ns; j++) s += f(times[i] + (j - (ns - 1) / 2) * dt); out[i] = s / ns; } }
  return out;
}

/** Eclipse of a uniformly bright planet only (no phase variation): 1 + depth outside, 1 during totality. */
export function makeEclipse(params, opts = {}) {
  return makePhaseCurve({ ...params, contrast: 0, hotspot: 0, h2c: 0, h2s: 0, ...Object.fromEntries(MAP_KEYS.map((k) => [k, 0])) }, { ...opts, map: false });
}

/** Days by which light-travel time delays mid-eclipse relative to mid-transit: (r_transit + r_eclipse) sin i R* / c. */
export function lightTravelDelay(params) {
  const e = params.ecc || 0, w = (params.omega || 0) * DEG, s = Math.sin(params.inc * DEG);
  const rT = (params.ars * (1 - e * e)) / (1 + e * Math.sin(w)), rE = (params.ars * (1 - e * e)) / (1 - e * Math.sin(w));
  return (rT + rE) * s * (params.rstar || 0) * RSUN_LIGHT_DAYS;
}

/** EXOTIC's c0..c4 for the harmonic model at these parameters (phase from mid-eclipse). */
export function harmonicCoefficients(params) {
  const q = resolvePhase(params, { map: false });
  return { edepth: q.D, c0: q.off - q.D * q.h2c, c1: q.amp * Math.cos(q.hs), c2: -q.amp * Math.sin(q.hs), c3: q.D * q.h2c, c4: q.D * q.h2s };
}
/** The reverse: fpfs, contrast, hotspot, h2c, h2s from EXOTIC's { fpfs, rprs, c1, c2, c3, c4 }. */
export function fromHarmonicCoefficients(c) {
  const D = c.fpfs * c.rprs * c.rprs, amp = Math.hypot(c.c1, c.c2 || 0), hs = Math.atan2(-(c.c2 || 0), c.c1), off = D - amp * Math.cos(hs);
  return { fpfs: c.fpfs, contrast: amp > 0 ? (2 * amp) / (off + amp) : 0, hotspot: hs / DEG, h2c: D ? (c.c3 || 0) / D : 0, h2s: D ? (c.c4 || 0) / D : 0 };
}
/** Exoplanet-Mapping's flux-unit coefficients (y00, y10, y11, y1m1, ...) for these parameters. */
export function exoplanetMappingCoefficients(params) {
  const pc = makePhaseCurve(params, { map: true }), o = { y00: pc.norm };
  for (const k of MAP_KEYS) if (pc.y[k]) o[k] = pc.norm * pc.y[k];
  return o;
}

// ---- linear solve for the map ---------------------------------------------------

/**
 * Light curve of each basis function at fixed orbit: what Exoplanet-Mapping tabulates with starry.
 * Returns { star: Float64Array (transit x stellar terms), keys: ['y00', ...], curves: { y00: uniform planet of unit
 * flux (1 outside eclipse), y10: flux of Y10 alone, ... } }. The system flux is
 *   star + Dn (curves.y00 + sum y_lm curves.y_lm).
 */
export function basisCurves(times, params, lmax = 2, opts = {}) {
  const base = { ...params, fpfs: 1 / (params.rprs * params.rprs), contrast: 0, hotspot: 0, h2c: 0, h2s: 0 };
  for (const k of MAP_KEYS) base[k] = 0;
  const N = times.length, keys = mapKeys(lmax), o = { ...opts, map: true, clamp: false };
  const f0 = makePhaseCurve(base, o), star = new Float64Array(N), y00 = new Float64Array(N);
  for (let i = 0; i < N; i++) { const pr = f0.parts(times[i]); star[i] = pr.star; y00[i] = pr.planet; }
  const curves = { y00 };
  for (const k of keys) {
    // Dn = 1 / G_e for unit eclipse depth; undo it so the curve is that of (1 + Y_lm) with unit uniform term
    const f = makePhaseCurve({ ...base, [k]: 1 }, o), c = new Float64Array(N), g = 1 / f.norm;
    for (let i = 0; i < N; i++) c[i] = f.planet(times[i]) * g - y00[i];
    curves[k] = c;
  }
  return { star, keys: ['y00', ...keys], curves };
}

/**
 * Weighted linear least squares for the map coefficients at fixed non-linear parameters (orbit, rprs, limb darkening).
 * data: { t, f, e, epoch? }   flux normalised to about 1 in every epoch; each epoch gets its own stellar level
 * opts: { lmax (default 2), keys (subset of the map keys to solve for), ridge (lambda: adds lambda * y_lm^2 / sigma_D^2-free
 *         penalty in units of the fitted uniform term; default 0), ltt, phase }
 * Returns { fpfs, depth, y: { y10: ... }, yErr, depthErr, a1: [levels], chi2, dof, cov, keys, model: Float64Array,
 *           rankDeficient, minIntensity, negativeMap, params (input params with fpfs and the y_lm filled in) }.
 * Degree 3 (and y1m1, y2m2, y2m1 for an edge-on orbit) is constrained only by points in ingress and egress.
 */
export function solveMap(data, params, opts = {}) {
  const lmax = opts.lmax || 2, N = data.t.length;
  const B = basisCurves(data.t, params, lmax, opts);
  const use = ['y00', ...(opts.keys || B.keys.slice(1))];
  let nE = 1; if (data.epoch) for (let i = 0; i < N; i++) if (data.epoch[i] >= nE) nE = data.epoch[i] + 1;
  const nc = nE + use.length, A = Array.from({ length: nc }, () => new Float64Array(nc)), rhs = new Float64Array(nc), row = new Float64Array(nc);
  for (let i = 0; i < N; i++) {
    const wi = 1 / (data.e[i] * data.e[i]), s = data.epoch ? data.epoch[i] : 0;
    row.fill(0); row[s] = B.star[i];
    for (let k = 0; k < use.length; k++) row[nE + k] = B.curves[use[k]][i];
    for (let a = 0; a < nc; a++) { if (row[a] === 0) continue; rhs[a] += wi * row[a] * data.f[i]; for (let b = a; b < nc; b++) A[a][b] += wi * row[a] * row[b]; }
  }
  for (let a = 0; a < nc; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
  // ridge on the non-uniform coefficients, scaled by the uniform column's weight so lambda is dimensionless
  if (opts.ridge > 0) for (let k = 1; k < use.length; k++) A[nE + k][nE + k] += opts.ridge * A[nE][nE];
  // invert by Gauss-Jordan with scaling (the columns differ by orders of magnitude)
  const sc = A.map((r, i) => Math.sqrt(r[i]) || 1), Minv = Array.from({ length: nc }, (_, i) => { const r = new Float64Array(nc); r[i] = 1; return r; });
  const Mx = A.map((r, i) => Float64Array.from(r, (x, j) => x / (sc[i] * sc[j])));
  let rankDeficient = false;
  for (let c = 0; c < nc; c++) {
    let piv = c; for (let r = c + 1; r < nc; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[piv][c])) piv = r;
    if (Math.abs(Mx[piv][c]) < 1e-11) { rankDeficient = true; Mx[piv][c] = 1e-11; }
    [Mx[c], Mx[piv]] = [Mx[piv], Mx[c]]; [Minv[c], Minv[piv]] = [Minv[piv], Minv[c]];
    const d = Mx[c][c]; for (let j = 0; j < nc; j++) { Mx[c][j] /= d; Minv[c][j] /= d; }
    for (let r = 0; r < nc; r++) if (r !== c) { const fct = Mx[r][c]; if (fct !== 0) for (let j = 0; j < nc; j++) { Mx[r][j] -= fct * Mx[c][j]; Minv[r][j] -= fct * Minv[c][j]; } }
  }
  const cov = Minv.map((r, i) => Float64Array.from(r, (x, j) => x / (sc[i] * sc[j])));
  const th = new Float64Array(nc); for (let a = 0; a < nc; a++) for (let b = 0; b < nc; b++) th[a] += cov[a][b] * rhs[b];
  const model = new Float64Array(N); let chi2 = 0;
  const predict = () => {
    chi2 = 0;
    for (let i = 0; i < N; i++) {
      let m = th[data.epoch ? data.epoch[i] : 0] * B.star[i];
      for (let k = 0; k < use.length; k++) m += th[nE + k] * B.curves[use[k]][i];
      model[i] = m; chi2 += ((data.f[i] - m) / data.e[i]) ** 2;
    }
  };
  predict();
  // iterative refinement: the uniform, constant-offset and stellar columns are nearly parallel, and the normal
  // equations square the condition number; two passes on the residuals recover the lost digits
  for (let pass = 0; pass < 2 && !opts.ridge; pass++) {
    const g = new Float64Array(nc);
    for (let i = 0; i < N; i++) {
      const r = (data.f[i] - model[i]) / (data.e[i] * data.e[i]); g[data.epoch ? data.epoch[i] : 0] += r * B.star[i];
      for (let k = 0; k < use.length; k++) g[nE + k] += r * B.curves[use[k]][i];
    }
    for (let a = 0; a < nc; a++) for (let b2 = 0; b2 < nc; b2++) th[a] += cov[a][b2] * g[b2];
    predict();
  }
  // back to model parameters: theta_00 = a1 Dn, theta_lm = a1 Dn y_lm (a1 = mean level of the epochs)
  const a1 = Array.from(th.slice(0, nE)), aBar = a1.reduce((s, x) => s + x, 0) / nE, t00 = th[nE], Dn = t00 / aBar;
  const y = {}, yErr = {};
  for (let k = 1; k < use.length; k++) {
    const v = th[nE + k] / t00; y[use[k]] = v;
    yErr[use[k]] = Math.abs(v) * Math.sqrt(Math.max(0, cov[nE + k][nE + k] / (th[nE + k] ** 2 || Infinity) + cov[nE][nE] / (t00 * t00) - (2 * cov[nE][nE + k]) / (th[nE + k] * t00 || Infinity))) || Math.sqrt(cov[nE + k][nE + k]) / Math.abs(t00);
  }
  const inc = params.inc * DEG, Ge = mapPhase(mapTensors(y), 0, Math.cos(inc), Math.sin(inc)), depth = Dn * Ge;
  // depth = (theta_00 + sum theta_lm g_lm) / a1: propagate the covariance of the planet block
  const g = use.map((k, i) => (i === 0 ? 1 : mapPhase(mapTensors({ [k]: 1 }), 0, Math.cos(inc), Math.sin(inc)) - 1));
  let vD = 0; for (let a = 0; a < use.length; a++) for (let b = 0; b < use.length; b++) vD += g[a] * g[b] * cov[nE + a][nE + b];
  const out = { ...params, fpfs: depth / (params.rprs * params.rprs), contrast: 0, hotspot: 0 };
  for (const k of MAP_KEYS) out[k] = y[k] || 0;
  const pc = makePhaseCurve(out, { ...opts, map: true });
  return { fpfs: out.fpfs, depth, depthErr: Math.sqrt(vD) / aBar, y, yErr, a1, chi2, dof: N - nc, cov, keys: use, theta: th, model,
    rankDeficient, minIntensity: pc.minIntensity, negativeMap: pc.negativeMap, negative: pc.negative, params: out };
}

// ---- temperatures -----------------------------------------------------------------

/** Band edges in micron (top-hat), the ranges Exoplanet-Mapping integrates over for IRAC. */
export const BANDS = {
  'IRAC 3.6': [3.15, 3.95], 'IRAC 4.5': [4.0, 5.0], 'IRAC 5.8': [4.9, 6.2], 'IRAC 8.0': [6.5, 9.1],
  'TESS': [0.6, 1.0], 'Kepler': [0.43, 0.89], 'WFC3 G141': [1.1, 1.7], 'MIRI LRS': [5.0, 12.0], 'NIRSpec G395H': [2.87, 5.14], 'F1500W': [13.5, 16.6],
};
const C2 = 14387.768775;   // hc/k in micron K
/** Planck function B_lambda (arbitrary constant factor) at wavelength in micron. */
export const planck = (lam, T) => 1 / (lam ** 5 * Math.expm1(C2 / (lam * T)));
/** Band-integrated Planck function (energy), by Simpson's rule. band: micron, [lo, hi], a name in BANDS, or { wl: [], resp: [] }. */
export function bandPlanck(T, band) {
  if (typeof band === 'string') band = BANDS[band];
  if (typeof band === 'number') return planck(band, T);
  if (Array.isArray(band)) {
    const n = 64, h = (band[1] - band[0]) / n; let s = planck(band[0], T) + planck(band[1], T);
    for (let i = 1; i < n; i++) s += (i & 1 ? 4 : 2) * planck(band[0] + i * h, T);
    return (s * h) / 3;
  }
  let s = 0; for (let i = 1; i < band.wl.length; i++) s += 0.5 * (band.wl[i] - band.wl[i - 1]) * (band.resp[i] * planck(band.wl[i], T) + band.resp[i - 1] * planck(band.wl[i - 1], T));
  return s;
}
/**
 * Brightness temperature: T with B_band(T) = ratio x B_band(tstar), ratio the planet's surface brightness over the
 * star's (fpfs, or flux ratio / rprs^2). The star is a blackbody at its effective temperature, as in Exoplanet-Mapping's
 * brightnessTemp. Returns NaN for a negative ratio, 0 for 0.
 */
export function brightnessTemperature(ratio, tstar, band) {
  if (!(ratio >= 0)) return NaN; if (ratio === 0) return 0;
  const target = ratio * bandPlanck(tstar, band);
  let lo = 1, hi = 1e5;
  if (bandPlanck(hi, band) < target) return Infinity;
  for (let i = 0; i < 200 && hi - lo > 1e-9 * hi; i++) { const mid = 0.5 * (lo + hi); if (bandPlanck(mid, band) < target) lo = mid; else hi = mid; }
  return 0.5 * (lo + hi);
}

/**
 * Heat budget from dayside and nightside temperatures (Cowan & Agol 2011, ApJ 729, 54, eqs. 4 and 5):
 *   T0 = T* / sqrt(a/R*)                       irradiation temperature at the substellar point
 *   Td = T0 (1 - A_B)^(1/4) (2/3 - 5 eps / 12)^(1/4)       Tn = T0 (1 - A_B)^(1/4) (eps / 4)^(1/4)
 * inverted:  A_B = 1 - (3 Td^4 + 5 Tn^4) / (2 T0^4),   eps = 8 Tn^4 / (3 Td^4 + 5 Tn^4).
 * Also Teq = T0 / sqrt(2) (zero albedo, full redistribution) and the dayside factor f of
 * Td = T0 [f (1 - A_B)]^(1/4) (Lopez-Morales & Seager 2007: 1/4 uniform, 2/3 no redistribution), here for A_B = 0.
 * These equate brightness temperature in one band with effective temperature: A_B < 0 means the band is brighter
 * than a blackbody in equilibrium could be.
 */
export function heatRedistribution({ tday, tnight, tstar, ars }) {
  const T0 = tstar / Math.sqrt(ars), x = (tday / T0) ** 4, y = (Math.max(tnight, 0) / T0) ** 4;
  return { T0, teq: T0 / Math.SQRT2, bondAlbedo: 1 - (3 * x + 5 * y) / 2, epsilon: (8 * y) / (3 * x + 5 * y), fDay: x, tdayMax: T0 * (2 / 3) ** 0.25 };
}
/** The forward relations: { tday, tnight } for a Bond albedo and redistribution efficiency. */
export function dayNightTemperatures({ bondAlbedo, epsilon, tstar, ars }) {
  const T0 = tstar / Math.sqrt(ars), k = (1 - bondAlbedo) ** 0.25;
  return { T0, tday: T0 * k * (2 / 3 - (5 * epsilon) / 12) ** 0.25, tnight: T0 * k * (epsilon / 4) ** 0.25 };
}

/**
 * Brightness and temperature of the planet on a latitude-longitude grid.
 * params as for makePhaseCurve (harmonic first order is drawn as its degree-1 map; h2c, h2s have no map).
 * opts: { tstar (K), band, nlat (default 45), nlon (default 90) }
 * Returns { lat[nlat], lon[nlon] (deg, cell centres, lon -180..180 east of the substellar point),
 *           ratio: Float64Array(nlat*nlon) planet/star surface brightness (row = latitude from south),
 *           temp: Float64Array | null (K; NaN where the map is negative), tmin, tmax,
 *           hotspot: { lat, lon, temp, ratio } brightest point, negativeFraction (of the sphere's area), nlat, nlon }.
 */
export function temperatureMap(params, opts = {}) {
  const nlat = opts.nlat || 45, nlon = opts.nlon || 90, pc = makePhaseCurve(params, { ...opts, map: true });
  const I0 = pc.norm / (params.rprs * params.rprs), mt = pc.tensors;
  const lat = Float64Array.from({ length: nlat }, (_, i) => -90 + ((i + 0.5) * 180) / nlat), lon = Float64Array.from({ length: nlon }, (_, j) => -180 + ((j + 0.5) * 360) / nlon);
  const ratio = new Float64Array(nlat * nlon), temp = opts.tstar ? new Float64Array(nlat * nlon) : null;
  let best = -Infinity, bi = 0, bj = 0, neg = 0, area = 0, tmin = Infinity, tmax = -Infinity;
  // temperature by interpolation in a table of ratio(T): one inversion per cell would be slow for movies
  let tab = null;
  if (temp) { const nT = 400, Tt = Float64Array.from({ length: nT }, (_, i) => 50 * Math.pow(400, i / (nT - 1))), bs = bandPlanck(opts.tstar, opts.band); tab = { T: Tt, r: Float64Array.from(Tt, (T) => bandPlanck(T, opts.band) / bs) }; }
  const tOf = (r) => {
    if (!(r > 0)) return NaN;
    const { T, r: rr } = tab; if (r <= rr[0] || r >= rr[rr.length - 1]) return brightnessTemperature(r, opts.tstar, opts.band);
    let a = 0, b = rr.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (rr[m] < r) a = m; else b = m; }
    const u = (Math.log(r) - Math.log(rr[a])) / (Math.log(rr[b]) - Math.log(rr[a])); return T[a] * Math.pow(T[b] / T[a], u);
  };
  for (let i = 0; i < nlat; i++) {
    const cl = Math.cos(lat[i] * DEG), sl = Math.sin(lat[i] * DEG);
    for (let j = 0; j < nlon; j++) {
      const lo = lon[j] * DEG, r = I0 * polyAt(mt, cl * Math.sin(lo), sl, cl * Math.cos(lo));
      ratio[i * nlon + j] = r; area += cl; if (r < 0) neg += cl;
      if (r > best) { best = r; bi = i; bj = j; }
      if (temp) { const T = tOf(r); temp[i * nlon + j] = T; if (T < tmin) tmin = T; if (T > tmax) tmax = T; }
    }
  }
  // refine the brightest point on a fine local grid
  let hl = lat[bi], ho = lon[bj];
  for (let pass = 0, step = 180 / nlat; pass < 6; pass++, step /= 4) {
    let bl = hl, bo = ho;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const la = Math.max(-90, Math.min(90, hl + a * step)), lo = ho + b * step * 2, r = I0 * mapIntensity(mt, la, lo);
      if (r > best) { best = r; bl = la; bo = lo; }
    }
    hl = bl; ho = bo;
  }
  ho = ((((ho + 180) % 360) + 360) % 360) - 180;
  return { lat, lon, nlat, nlon, ratio, temp, tmin, tmax, negativeFraction: neg / area,
    hotspot: { lat: hl, lon: ho, ratio: best, temp: temp ? brightnessTemperature(best, opts.tstar, opts.band) : null } };
}

/**
 * Everything derived from a phase curve or map at given parameters.
 * opts: { tstar, band, ltt, phase, nphase (default 361) }
 * Returns {
 *   depth, fday (flux ratio at phi = 0), fnight (phi = 180 deg), fmax, fmin, amplitude ((fmax - fmin) / 2),
 *   contrast ((fmax - fmin) / fmax), phaseOfMax (deg from mid-eclipse, negative = before eclipse),
 *   hotspotOffset (deg east: -phaseOfMax),
 *   phase: Float64Array (deg, -180..180), flux: Float64Array (unocculted planet/star flux at each phase),
 *   temp: Float64Array | null (disc-integrated brightness temperature the observer sees at each phase),
 *   tday, tnight, tmaxPhase, tminPhase,  T0, teq, bondAlbedo, epsilon (heatRedistribution),
 *   map: temperatureMap(...) (hotspot.lon / .lat is the brightest point of the map, which differs from hotspotOffset),
 *   lttDelay (days), mode, negative, negativeMap, minIntensity,
 *   physical (flux >= 0 at every phase, and in map mode brightness >= 0 everywhere) }
 * opts.requirePositive: true -> the derived temperatures, albedo, redistribution and hot-spot numbers are NaN when the model is
 *   not physical; 'map' -> also when the degree-1 map equivalent of a harmonic curve is negative somewhere.
 */
export function phaseSummary(params, opts = {}) {
  const pc = makePhaseCurve(params, opts), n = opts.nphase || 361, p2 = params.rprs * params.rprs;
  const phase = new Float64Array(n), flux = new Float64Array(n), temp = opts.tstar ? new Float64Array(n) : null;
  let fmax = -Infinity, fmin = Infinity, imax = 0;
  for (let i = 0; i < n; i++) {
    phase[i] = -180 + (360 * i) / (n - 1); const f = pc.phaseFlux(phase[i] * DEG); flux[i] = f;
    if (f > fmax) { fmax = f; imax = i; } if (f < fmin) fmin = f;
    if (temp) temp[i] = brightnessTemperature(Math.max(f, 0) / p2, opts.tstar, opts.band);
  }
  // refine the maximum by golden section around the best sample
  let a = (phase[Math.max(0, imax - 1)]) * DEG, b = (phase[Math.min(n - 1, imax + 1)]) * DEG;
  for (let i = 0; i < 60; i++) { const m1 = a + 0.381966 * (b - a), m2 = a + 0.618034 * (b - a); if (pc.phaseFlux(m1) > pc.phaseFlux(m2)) b = m2; else a = m1; }
  const phMax = 0.5 * (a + b); fmax = pc.phaseFlux(phMax);
  const fday = pc.phaseFlux(0), fnight = pc.phaseFlux(PI);
  const out = { depth: pc.depth, fday, fnight, fmax, fmin, amplitude: (fmax - fmin) / 2, contrast: fmax > 0 ? (fmax - fmin) / fmax : 0,
    phaseOfMax: phMax / DEG, hotspotOffset: -phMax / DEG, phase, flux, temp, lttDelay: lightTravelDelay(params), mode: pc.mode,
    negative: pc.negative, negativeMap: pc.negativeMap, minIntensity: pc.minIntensity, map: temperatureMap(params, opts) };
  if (opts.tstar) {
    out.tday = brightnessTemperature(Math.max(fday, 0) / p2, opts.tstar, opts.band); out.tnight = brightnessTemperature(Math.max(fnight, 0) / p2, opts.tstar, opts.band);
    out.tmaxPhase = brightnessTemperature(Math.max(fmax, 0) / p2, opts.tstar, opts.band); out.tminPhase = brightnessTemperature(Math.max(fmin, 0) / p2, opts.tstar, opts.band);
    Object.assign(out, heatRedistribution({ tday: out.tday, tnight: out.tnight, tstar: opts.tstar, ars: params.ars }));
  }
  // physical: the planet's flux is non-negative at every phase and (map mode, or the degree-1 map of a first-order curve)
  // its surface brightness is non-negative everywhere. opts.requirePositive: derived quantities of an unphysical model are
  // NaN (temperatures, albedo, redistribution, hot-spot offset), so posterior summaries are taken over physical draws only.
  out.physical = !pc.negative && !(pc.mode === 'map' && pc.negativeMap);
  if (opts.requirePositive && !(out.physical && (opts.requirePositive !== 'map' || !pc.negativeMap))) {
    for (const k of ['tday', 'tnight', 'tmaxPhase', 'tminPhase', 'bondAlbedo', 'epsilon', 'fDay', 'hotspotOffset', 'phaseOfMax']) if (k in out) out[k] = NaN;
    if (out.map && out.map.hotspot) out.map.hotspot = { lat: NaN, lon: NaN, ratio: NaN, temp: NaN };
  }
  return out;
}
