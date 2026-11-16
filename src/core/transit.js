// Transit light curve for a limb-darkened star.
//
// pylightcurve integrates  I(r) * r * 2*acos(...)  radially across the star
// with fixed-order Gauss-Legendre. That integrand has square-root endpoint
// singularities, so the quadrature converges slowly and needs an acos per node.
//
// Here the area integral over the occulted region is turned into a line
// integral around its boundary (Green's theorem). With
//     F(r) = int_0^r I(r') r' dr'   (closed form for the Claret law)
// the field  V = F(r)/r^2 * (x, y)  has div V = I(r), hence
//     blocked = oint F(r)/r^2 (x dy - y dx)
// The boundary is an arc of the planet's limb plus (during ingress/egress) an
// arc of the stellar limb, where the integrand is the constant F(1).
// Along the planet's limb, parametrised by the angle phi about the planet's
// centre, the integrand is smooth and periodic: when the planet is fully on
// the disk the midpoint rule converges geometrically, and nodes are fixed so
// cos(phi) is tabulated. No acos in the inner loop.

import { orbitElements, solveKepler, trueAnomaly } from './kepler.js';
import { prepareLD, toClaret } from './limbdark.js';

const PI = Math.PI;

// ---- quadrature tables ------------------------------------------------------

function gaussLegendre(n) {
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
    x[i] = -z; x[n - 1 - i] = z;
    w[i] = w[n - 1 - i] = 2 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
}

const N_MID = 12;      // midpoint nodes on [0, pi], planet fully on the disk
const N_GL = 20;       // Gauss-Legendre nodes for arcs that touch the limb
const MID_COS = new Float64Array(N_MID);
for (let k = 0; k < N_MID; k++) MID_COS[k] = Math.cos(PI * (k + 0.5) / N_MID);
const GL = gaussLegendre(N_GL);
// map GL nodes to u in [0,1] and fold in the u^2 substitution: phi = a + (pi-a) u^2
const GL_U2 = new Float64Array(N_GL), GL_W = new Float64Array(N_GL);
for (let k = 0; k < N_GL; k++) {
  const u = 0.5 * (GL.x[k] + 1);
  GL_U2[k] = u * u;
  GL_W[k] = GL.w[k] * u; // 0.5 (interval) * 2u (jacobian) = u
}

// ---- kernel -----------------------------------------------------------------

// h(s) = F(r)/r^2 with s = r^2.
function hOf(s, ld) {
  if (s < 1e-3) {
    // series of (1 - (1-s)^q)/s about s = 0 avoids 0/0 at the stellar centre
    const ser = (q) => q * (1 - (q - 1) * s / 2 * (1 - (q - 2) * s / 3 * (1 - (q - 3) * s / 4)));
    return ld.c0 / 2 + ld.a1 * ser(1.25) / 2.5 + ld.a2 * ser(1.5) / 3 + ld.a3 * ser(1.75) / 3.5 + ld.a4 * ser(2) / 4;
  }
  const m2 = s < 1 ? 1 - s : 0;
  const m = Math.sqrt(m2);
  let F = ld.c0 * s / 2 + ld.a2 * (1 - m2 * m) / 3 + ld.a4 * (1 - m2 * m2) / 4;
  if (ld.quarter) {
    const q = Math.sqrt(m);
    F += ld.a1 * (1 - m2 * q) / 2.5 + ld.a3 * (1 - m2 * m * q) / 3.5;
  }
  return F / s;
}

// int_{phiA}^{pi} h(r^2) p (p + z cos phi) dphi, robust to a limb contact at phiA
function arcGL(z, p, phiA, ld) {
  const span = PI - phiA, zz = z * z + p * p, zp2 = 2 * z * p;
  let sum = 0;
  for (let k = 0; k < N_GL; k++) {
    const c = Math.cos(phiA + span * GL_U2[k]);
    sum += GL_W[k] * hOf(zz + zp2 * c, ld) * (p + z * c);
  }
  return sum * span * p;
}

/**
 * Fraction of the stellar flux blocked by an opaque disk of radius p whose
 * centre is at projected distance z (both in stellar radii).
 */
export function blockedFraction(z, p, ld) {
  if (p <= 0 || z >= 1 + p) return 0;
  if (p >= 1 && z <= p - 1) return 1;
  if (ld.uniform) return uniformOverlap(z, p) / PI;
  let blocked;
  if (z + p <= 1) {
    // planet entirely on the disk
    if (1 - (z + p) < 0.02 || z < p) {
      // close to the limb the quarter-power terms are nearly singular; when the
      // planet covers the centre the integrand is fine but GL is just as cheap
      blocked = 2 * arcGL(z, p, 0, ld);
    } else {
      const zz = z * z + p * p, zp2 = 2 * z * p;
      let sum = 0;
      for (let k = 0; k < N_MID; k++) {
        const c = MID_COS[k];
        sum += hOf(zz + zp2 * c, ld) * (p + z * c);
      }
      blocked = 2 * sum * (PI / N_MID) * p;
    }
  } else {
    // ingress / egress / grazing: planet limb arc + stellar limb arc
    const cphi = (1 - z * z - p * p) / (2 * z * p);
    const cth = (1 + z * z - p * p) / (2 * z);
    const phi0 = Math.acos(cphi > 1 ? 1 : cphi < -1 ? -1 : cphi);
    const th0 = Math.acos(cth > 1 ? 1 : cth < -1 ? -1 : cth);
    blocked = 2 * arcGL(z, p, phi0, ld) + 2 * th0 * ld.F1;
  }
  const f = blocked / (2 * PI * ld.F1);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// area of intersection of unit circle and circle radius p at distance z
function uniformOverlap(z, p) {
  if (z + p <= 1) return PI * p * p;
  const k0 = Math.acos(Math.min(1, Math.max(-1, (p * p + z * z - 1) / (2 * p * z))));
  const k1 = Math.acos(Math.min(1, Math.max(-1, (1 - p * p + z * z) / (2 * z))));
  return p * p * k0 + k1 - 0.5 * Math.sqrt(Math.max(0, 4 * z * z - (1 + z * z - p * p) ** 2));
}

// ---- light curve ------------------------------------------------------------

/**
 * Compile a parameter set into a fast evaluator.
 * params: { rprs, per, tmid, ars, inc, ecc, omega, ldLaw, ld: [...] }
 * returns flux(t) -> relative flux (1 out of transit)
 */
export function makeTransit(params) {
  const el = orbitElements(params);
  const ld = prepareLD(toClaret(params.ldLaw || 'nonlinear', params.ld || [0, 0, 0, 0]));
  const p = Math.abs(params.rprs);
  const lim = (1 + p) * (1 + p);
  const { e, w, n, M0, tmid, ars, cosI, sinI } = el;
  if (e === 0) {
    return (t) => {
      const u = PI / 2 + n * (t - tmid);
      const su = Math.sin(u);
      if (su * sinI <= 0) return 1;
      const X = ars * Math.cos(u), Y = ars * su * cosI;
      const d2 = X * X + Y * Y;
      if (d2 >= lim) return 1;
      return 1 - blockedFraction(Math.sqrt(d2), p, ld);
    };
  }
  return (t) => {
    const E = solveKepler(M0 + n * (t - tmid), e);
    const u = w + trueAnomaly(E, e);
    const su = Math.sin(u);
    if (su * sinI <= 0) return 1;
    const r = ars * (1 - e * Math.cos(E));
    const X = r * Math.cos(u), Y = r * su * cosI;
    const d2 = X * X + Y * Y;
    if (d2 >= lim) return 1;
    return 1 - blockedFraction(Math.sqrt(d2), p, ld);
  };
}

/**
 * Evaluate the model on an array of times.
 * opts.exptime (days) and opts.supersample (n) average the model over each
 * exposure, which matters when the cadence is comparable to ingress duration.
 */
export function transitModel(times, params, out, opts) {
  const f = makeTransit(params);
  const N = times.length;
  out = out || new Float64Array(N);
  const ns = opts && opts.exptime > 0 ? Math.max(1, opts.supersample | 0) : 1;
  if (ns === 1) {
    for (let i = 0; i < N; i++) out[i] = f(times[i]);
  } else {
    const dt = opts.exptime / ns;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let j = 0; j < ns; j++) s += f(times[i] + (j - (ns - 1) / 2) * dt);
      out[i] = s / ns;
    }
  }
  return out;
}

// Internals shared with exomoon.js, which integrates the same kernel along arcs of two overlapping discs.
export { hOf, gaussLegendre };
