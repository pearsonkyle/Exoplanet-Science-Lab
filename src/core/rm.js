// Rossiter–McLaughlin effect: the radial-velocity anomaly while a planet covers part of a rotating star.
//
// The star rotates as a solid body. In the sky frame of kepler.js (X, Y in stellar radii, +Z toward the observer)
// the planet crosses the disc moving toward +X and the orbit normal projects onto +Y (the transit chord is at
// Y = -b). The sky-projected stellar spin axis is turned from the projected orbit normal by the projected
// obliquity lambda, toward the planet's direction of motion: s = (sin lambda, cos lambda). A point (x, y) of the
// disc then recedes from the observer at
//     v(x, y) = v sin i*  (x cos lambda - y sin lambda)
// (velocities positive away from the observer, as in rv.js), so for lambda = 0 the planet first covers the
// approaching half and the anomaly starts positive. This is ellc's convention (Maxted 2016, lambda_1): test/rm.test.mjs
// compares whole curves with ellc's flux-weighted velocities for lambda = 0, 30, -45 and 120 degrees, where the
// opposite sign of lambda would differ by 5 to 52 m/s.
//
// The anomaly is the shift of the flux-weighted mean velocity of the light that is left:
//     dV = - int_occ I v dA / (F_star - int_occ I dA),     int over the disc of I v dA = 0,
// the quantity Ohta et al. (2005) expand for a small planet. It is not what a fit of a Gaussian to the
// cross-correlation function measures for a well-resolved line (Hirano et al. 2010, Boué et al. 2013), which is
// smaller by up to tens of per cent when v sin i is comparable to the line width.
//
// Both integrals over the occulted area are line integrals around its boundary (Green's theorem). With
// F(r) = int_0^r I(r') r' dr' (closed form for the Claret law; transit.js hOf) the field (F(r), 0) has divergence
// I(r) x, so the first moment of the intensity along the line from the star's centre to the planet's is
//     M = int_occ I x' dA = oint F(r) dy'
// around the occulted region: an arc of the planet's limb, plus during ingress and egress an arc of the stellar
// limb where F = F(1). The occulted region is symmetric about that line, so the perpendicular moment vanishes.
// The blocked flux is the transit kernel's (transit.js blockedFraction).

import { orbitElements, orbitPosition } from './kepler.js';
import { prepareLD, toClaret } from './limbdark.js';
import { blockedFraction, hOf, gaussLegendre } from './transit.js';

const PI = Math.PI, DEG = PI / 180;
const NQ = 40;
const GL = gaussLegendre(NQ), U2 = new Float64Array(NQ), WU = new Float64Array(NQ);
// phi = a + (pi - a) u^2 puts the nodes near phi = a, where the arc meets (or comes closest to) the stellar limb
for (let k = 0; k < NQ; k++) { const u = 0.5 * (GL.x[k] + 1); U2[k] = u * u; WU[k] = GL.w[k] * u; }

/** F(r) = int_0^r I r dr with s = r^2 (clamped to the disc). */
const Fof = (s, ld) => { const q = s < 1 ? s : 1; return q * hOf(q, ld); };

/**
 * First moment of the intensity over the occulted part of the disc, along the direction from the star's centre to
 * the planet's: int I(r) x' dA, with I(0) = 1 and the stellar radius 1. z: centre-to-centre distance, p: Rp/R*,
 * ld: prepareLD(...) of the Claret coefficients.
 */
export function occultedMoment(z, p, ld) {
  if (!(p > 0) || !(z > 0) || z >= 1 + p) return 0;
  if (p >= 1 && z <= p - 1) return 0;                       // the whole star is covered (and the moment is zero)
  let phiA = 0, limb = 0;
  if (z + p > 1) {
    // ingress or egress: the planet's limb inside the star from phiA to 2 pi - phiA, and the stellar limb between the crossings
    const cphi = (1 - z * z - p * p) / (2 * z * p), cth = (1 + z * z - p * p) / (2 * z);
    phiA = Math.acos(cphi > 1 ? 1 : cphi < -1 ? -1 : cphi);
    const th0 = Math.acos(cth > 1 ? 1 : cth < -1 ? -1 : cth);
    limb = 2 * ld.F1 * Math.sin(th0);
  }
  // planet's limb: points (z + p cos phi, p sin phi), dy' = p cos phi dphi, symmetric about phi = pi
  const span = PI - phiA, zz = z * z + p * p, zp2 = 2 * z * p;
  let sum = 0;
  for (let k = 0; k < NQ; k++) { const c = Math.cos(phiA + span * U2[k]); sum += WU[k] * Fof(zz + zp2 * c, ld) * c; }
  return 2 * p * span * sum + limb;
}

/**
 * Velocity anomaly (same unit as vsini) with the planet's centre at sky position (X, Y) in stellar radii, in front of
 * the star. p: Rp/R*, ld: prepareLD(...) of Claret coefficients, lambda in degrees.
 */
export function rmAnomaly(X, Y, p, ld, vsini, lambda) {
  const z = Math.hypot(X, Y);
  if (!(z < 1 + p) || !(z > 0)) return 0;
  const fb = blockedFraction(z, p, ld);
  if (!(fb < 1)) return 0;
  const l = lambda * DEG, xs = (X * Math.cos(l) - Y * Math.sin(l)) / z;
  return (-vsini * occultedMoment(z, p, ld) * xs) / (2 * PI * ld.F1 * (1 - fb));
}

/**
 * Ohta et al. (2005) small-planet limit: the planet as a point that removes pi p^2 I(mu) of light at its centre,
 *     dV = - v sin i* x_s pi p^2 I(mu) / (F_star - pi p^2 I(mu)),   x_s = X cos lambda - Y sin lambda.
 * For checks; the model is rmAnomaly.
 */
export function rmSmallPlanet(X, Y, p, a, vsini, lambda) {
  const r2 = X * X + Y * Y; if (r2 >= 1) return 0;
  const mu = Math.sqrt(1 - r2), s = Math.sqrt(mu), I = 1 - a[0] * (1 - s) - a[1] * (1 - mu) - a[2] * (1 - mu * s) - a[3] * (1 - mu * mu);
  const Ftot = 2 * PI * prepareLD(a).F1, l = lambda * DEG, dF = PI * p * p * I;
  return (-vsini * (X * Math.cos(l) - Y * Math.sin(l)) * dF) / (Ftot - dF);
}

// ---- what a Gaussian fit to the cross-correlation function measures (spec.rm.method = 'ccf') ----------------------------
//
// Model of the line profile: every surface element contributes a Gaussian of dispersion beta_p (thermal, microturbulent and
// instrumental broadening; macroturbulence zeta adds zeta^2 / 2 to beta_p^2, the Gaussian approximation of an isotropic
// macroturbulence, not Hirano et al. 2011's radial-tangential profile) at its rotation velocity. Out of transit the CCF is
// that profile summed over the disc, and a Gaussian of dispersion beta_0 is fitted to it. In transit the occulted part, a
// fraction f of the light with mean velocity v_p (both from the integrals above) and dispersion beta_p, is missing. To first
// order in f the centre of the fitted Gaussian moves by (linearised least squares; the even and odd parts decouple)
//     dV = - f/(1 - f) v_p (2 beta_0^2 / S^2)^(3/2) exp(-v_p^2 / (2 S^2)),      S^2 = beta_0^2 + beta_p^2,
// Hirano et al. (2010) eq. 26 and Boué et al. (2013) eq. 11 up to the expansion of the exponential (they keep 1 - v_p^2 / S^2).
// For a line much broader than the rotation (beta_0 = beta_p, v_p << beta) the bracket is 1 and dV is the first moment
// above. beta_0 is the measured out-of-transit CCF width (spec.rm.beta0) or, when not given, the dispersion of the Gaussian
// that fits best (least squares) the modelled disc-integrated profile: ccfFit(), tabulated in v sin i / beta_p once per
// fit. The rotation-broadened profile is not a Gaussian; ccfFit also returns the factor ("gain") by which that changes the
// linearised shift (area ratio and the residual's curvature term): 1.000 to 0.974 for v sin i / beta_p = 0 to 4.
// test/rmccf.test.mjs checks the whole chain against a brute-force disc integration with a Gaussian fit in scipy.

/** Rotation kernel of the limb-darkened disc: k(x) = int I(x, y) dy over the chord at x (x in stellar radii), unnormalised. */
function rotationKernel(ld, nx = 241) {
  const xs = new Float64Array(nx), k = new Float64Array(nx), a = [ld.a1, ld.a2, ld.a3, ld.a4];
  for (let i = 0; i < nx; i++) {
    const x = -1 + (2 * (i + 0.5)) / nx, h = Math.sqrt(1 - x * x); let sm = 0;
    for (let q = 0; q < NQ; q++) {        // y = h sin(theta), theta on Gauss-Legendre nodes of (-pi/2, pi/2)
      const th = 0.5 * PI * GL.x[q], y = h * Math.sin(th), mu = Math.sqrt(Math.max(0, 1 - x * x - y * y)), sq = Math.sqrt(mu);
      const I = 1 - a[0] * (1 - sq) - a[1] * (1 - mu) - a[2] * (1 - mu * sq) - a[3] * (1 - mu * mu);
      sm += GL.w[q] * I * h * Math.cos(th) * 0.5 * PI;
    }
    xs[i] = x; k[i] = sm;
  }
  return { xs, k };
}

/**
 * The Gaussian that best fits (least squares over the line, free amplitude) the disc-integrated profile: the rotation
 * kernel of v sin i (limb darkening ld = prepareLD(...)) convolved with a Gaussian of dispersion beta_p, on 301
 * velocities over +- (v sin i + 6 beta_p). Returns { beta0 (same unit as the inputs), gain }: gain = kappa / (1 - c) corrects
 * the linearised shift for a profile that is not Gaussian: kappa is the profile's area over the fitted Gaussian's, and c
 * = <r0, d2m/dmu2> / <dm/dmu, dm/dmu> the curvature term of the Gauss-Newton Hessian left by the residual r0 of the
 * out-of-transit fit (both 1 and 0 for a Gaussian profile).
 */
export function ccfFit(vsini, betaP, ld, kern) {
  if (!(vsini > 0)) return { beta0: betaP, gain: 1 };
  const K = kern || rotationKernel(ld), r = vsini / betaP, nv = 301, vmax = r + 6, dv = (2 * vmax) / (nv - 1);
  const P = new Float64Array(nv), V = Float64Array.from({ length: nv }, (_, j) => -vmax + j * dv);
  for (let j = 0; j < nv; j++) { let sm = 0; for (let i = 0; i < K.xs.length; i++) { const d = V[j] - r * K.xs[i]; sm += K.k[i] * Math.exp(-0.5 * d * d); } P[j] = sm; }
  const chi = (s) => { let pg = 0, gg = 0, pp = 0; for (let j = 0; j < nv; j++) { const g = Math.exp((-0.5 * V[j] * V[j]) / (s * s)); pg += P[j] * g; gg += g * g; pp += P[j] * P[j]; } return pp - (pg * pg) / gg; };
  let a = 0.5, b = Math.sqrt(1 + r * r) + 1;
  for (let it = 0; it < 100; it++) { const m1 = a + 0.381966 * (b - a), m2 = a + 0.618034 * (b - a); if (chi(m1) < chi(m2)) b = m2; else a = m1; }
  const s = 0.5 * (a + b);
  let pg = 0, gg = 0, area = 0; for (let j = 0; j < nv; j++) { const g = Math.exp((-0.5 * V[j] * V[j]) / (s * s)); pg += P[j] * g; gg += g * g; area += P[j] * dv; }
  const A = pg / gg; let JJ = 0, rH = 0;
  for (let j = 0; j < nv; j++) { const v2 = V[j] * V[j], g = A * Math.exp((-0.5 * v2) / (s * s)), J = (V[j] / (s * s)) * g, H = g * (v2 / (s * s * s * s) - 1 / (s * s)); JJ += J * J; rH += (P[j] - g) * H; }
  const kappa = area / (A * Math.sqrt(2 * PI) * s);
  return { beta0: s * betaP, gain: kappa / (1 - rH / JJ) };
}
/** Dispersion beta_0 of the best-fitting Gaussian (ccfFit). */
export const ccfWidth = (vsini, betaP, ld, kern) => ccfFit(vsini, betaP, ld, kern).beta0;

/** ccfFit tabulated against v sin i / beta_p for one limb darkening (interpolated linearly): (vsini, betaP) -> { beta0, gain }. */
export function ccfWidthTable(ld, rMax = 30, n = 121) {
  const kern = rotationKernel(ld), r = Float64Array.from({ length: n }, (_, i) => rMax * (i / (n - 1)) ** 2), fits = Array.from(r, (x) => ccfFit(x, 1, ld, kern));
  return (vsini, betaP) => {
    const x = vsini / betaP; if (!(x > 0)) return { beta0: betaP, gain: 1 }; if (x >= rMax) return ccfFit(vsini, betaP, ld, kern);
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m] < x) lo = m; else hi = m; }
    const u = (x - r[lo]) / (r[hi] - r[lo]);
    return { beta0: betaP * (fits[lo].beta0 + u * (fits[hi].beta0 - fits[lo].beta0)), gain: fits[lo].gain + u * (fits[hi].gain - fits[lo].gain) };
  };
}

/**
 * Anomaly a Gaussian fit to the CCF measures, planet at (X, Y): as rmAnomaly with o = { betaP, beta0, gain (default 1) }
 * (velocities in the unit of vsini).
 */
export function rmAnomalyCCF(X, Y, p, ld, vsini, lambda, o) {
  const z = Math.hypot(X, Y);
  if (!(z < 1 + p) || !(z > 0)) return 0;
  const fb = blockedFraction(z, p, ld);
  if (!(fb > 0 && fb < 1)) return 0;
  const l = lambda * DEG, xs = (X * Math.cos(l) - Y * Math.sin(l)) / z;
  const vp = (vsini * occultedMoment(z, p, ld) * xs) / (2 * PI * ld.F1 * fb), S2 = o.beta0 * o.beta0 + o.betaP * o.betaP;
  return (-fb / (1 - fb)) * (o.gain ?? 1) * vp * Math.pow((2 * o.beta0 * o.beta0) / S2, 1.5) * Math.exp((-vp * vp) / (2 * S2));
}

/**
 * Compile one planet's anomaly as a function of time: p = { rprs, per, tmid, ars, inc, ecc, omega, vsini [km/s],
 * lambda [deg], ldLaw, ld } (or claret: [a1..a4] in place of ldLaw, ld). Returns rv(t) in m/s.
 * p.method = 'ccf' gives what a Gaussian fit to the CCF measures, with p.beta (km/s: the local line's dispersion,
 * instrumental and thermal), p.zeta (km/s, macroturbulence, optional) and p.beta0 (km/s, the out-of-transit CCF
 * dispersion; computed from the model when absent, through p.widthTable = ccfWidthTable(ld) if given).
 * p.exptime [d] with p.supersample (default 5): the anomaly averaged over each exposure.
 */
export function makeRM(p) {
  const el = orbitElements(p), k = Math.abs(p.rprs), lim = (1 + k) * (1 + k);
  const ld = prepareLD(p.claret || toClaret(p.ldLaw || 'nonlinear', p.ld || [0, 0, 0, 0]));
  const vs = (p.vsini || 0) * 1000, lam = p.lambda || 0, pos = [0, 0, 0];
  if (!(vs !== 0) || !(k > 0)) return () => 0;
  let at;
  if (p.method === 'ccf') {
    if (!(p.beta > 0)) throw new Error("Rossiter–McLaughlin method 'ccf' needs beta (km/s), the dispersion of the local line");
    const betaP = 1000 * Math.sqrt(p.beta * p.beta + 0.5 * (p.zeta || 0) ** 2);
    // a measured beta0 is used as given (with the gain of the modelled profile, which is 1 for a Gaussian one)
    const fit = p.widthTable ? p.widthTable(vs, betaP) : ccfFit(vs, betaP, ld);
    const o = { betaP, beta0: p.beta0 > 0 ? 1000 * p.beta0 : fit.beta0, gain: fit.gain };
    at = (X, Y) => rmAnomalyCCF(X, Y, k, ld, vs, lam, o);
  } else at = (X, Y) => rmAnomaly(X, Y, k, ld, vs, lam);
  const one = (t) => {
    orbitPosition(el, t, pos);
    if (pos[2] <= 0 || pos[0] * pos[0] + pos[1] * pos[1] >= lim) return 0;
    return at(pos[0], pos[1]);
  };
  const ns = p.exptime > 0 ? Math.max(1, (p.supersample ?? 5) | 0) : 1;
  if (ns === 1) return one;
  const dt = p.exptime / ns;
  return (t) => { let sm = 0; for (let j = 0; j < ns; j++) sm += one(t + (j - (ns - 1) / 2) * dt); return sm / ns; };
}

/**
 * Prior on v sin i from a catalogue value: normal truncated at 0 (and at +10 sigma), in the form of fit.free priors.
 * star: { vsini, vsiniErr } in km/s.
 */
export function vsiniPrior(star) {
  if (!(star && star.vsini >= 0 && star.vsiniErr > 0)) throw new Error('vsiniPrior needs star.vsini and star.vsiniErr (km/s)');
  return { type: 'truncnormal', a: star.vsini, b: star.vsiniErr, lo: 0, hi: star.vsini + 10 * star.vsiniErr };
}

/**
 * True (3-D) obliquity psi [deg] from the sky-projected lambda, the orbit's inclination and the star's i* (all degrees):
 * cos psi = cos i* cos i + sin i* sin i cos lambda (Fabrycky & Winn 2009).
 */
export function trueObliquity(lambda, inc, istar) {
  const c = Math.cos(istar * DEG) * Math.cos(inc * DEG) + Math.sin(istar * DEG) * Math.sin(inc * DEG) * Math.cos(lambda * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}
