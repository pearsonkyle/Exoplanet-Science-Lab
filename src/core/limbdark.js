// Stellar limb darkening laws.
//
// Everything is mapped onto the Claret (2000) four-coefficient law, which is
// what EXOTIC passes to pylightcurve (keys u0..u3):
//
//     I(mu)/I(1) = 1 - sum_{n=1..4} a_n (1 - mu^(n/2)),   mu = sqrt(1 - r^2)
//
// The simpler laws are exact special cases, so one integrator serves them all:
//     linear     I = 1 - u (1-mu)                      -> a2 = u
//     quadratic  I = 1 - u1 (1-mu) - u2 (1-mu)^2       -> a2 = u1 + 2 u2, a4 = -u2
//     kipping    quadratic, sampled as (q1, q2) in the unit square
//                u1 = 2 sqrt(q1) q2, u2 = sqrt(q1) (1 - 2 q2)     (Kipping 2013)
//     sqrt       I = 1 - c (1-mu) - d (1-sqrt(mu))     -> a1 = d, a2 = c

export const LD_LAWS = {
  uniform:   { label: 'Uniform disk',          names: [],                   defaults: [] },
  linear:    { label: 'Linear',                names: ['u'],                defaults: [0.55] },
  quadratic: { label: 'Quadratic (u1, u2)',    names: ['u1', 'u2'],         defaults: [0.40, 0.26] },
  kipping:   { label: 'Quadratic (q1, q2)',    names: ['q1', 'q2'],         defaults: [0.4356, 0.303] },
  sqrt:      { label: 'Square-root',           names: ['c', 'd'],           defaults: [0.1, 0.6] },
  nonlinear: { label: 'Claret 4-parameter',    names: ['a1', 'a2', 'a3', 'a4'], defaults: [0.4939, -0.0729, 0.4578, -0.2158] },
};

/** Convert any supported law to the four Claret coefficients [a1..a4]. */
export function toClaret(law, c) {
  switch (law) {
    case 'uniform':   return [0, 0, 0, 0];
    case 'linear':    return [0, c[0], 0, 0];
    case 'quadratic': return [0, c[0] + 2 * c[1], 0, -c[1]];
    case 'kipping': {
      const s = Math.sqrt(Math.max(c[0], 0));
      const u1 = 2 * s * c[1], u2 = s * (1 - 2 * c[1]);
      return [0, u1 + 2 * u2, 0, -u2];
    }
    case 'sqrt':      return [c[1], c[0], 0, 0];
    case 'nonlinear': return [c[0], c[1], c[2], c[3]];
    default: throw new Error('unknown limb darkening law: ' + law);
  }
}

export function kippingToQuadratic(q1, q2) {
  const s = Math.sqrt(q1);
  return [2 * s * q2, s * (1 - 2 * q2)];
}
export function quadraticToKipping(u1, u2) {
  const s = u1 + u2;
  return [s * s, s === 0 ? 0.5 : u1 / (2 * s)];
}

/** I(mu)/I(1) for Claret coefficients a:  1 - sum a_n (1 - mu^(n/2)). */
export function intensity(mu, a) {
  const m = Math.max(mu, 0), s = Math.sqrt(m);
  return 1 - a[0] * (1 - s) - a[1] * (1 - m) - a[2] * (1 - m * s) - a[3] * (1 - m * m);
}

/**
 * Precompute the constants the flux integrator needs.
 *   F(r) = int_0^r I(r') r' dr'   (analytic)
 *   total disk flux = 2 pi F(1)
 */
export function prepareLD(a) {
  const c0 = 1 - a[0] - a[1] - a[2] - a[3];
  const F1 = c0 / 2 + a[0] / 2.5 + a[1] / 3 + a[2] / 3.5 + a[3] / 4;
  return {
    a1: a[0], a2: a[1], a3: a[2], a4: a[3], c0, F1,
    // quarter-power terms cost an extra sqrt per node; skip when absent
    quarter: a[0] !== 0 || a[2] !== 0,
    uniform: a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0,
  };
}

/**
 * Physical sanity check of a profile. A profile is flagged if the intensity
 * goes negative anywhere, brightens toward the limb, or the disk-integrated
 * flux is non-positive. Returns { ok, negative, nonMonotonic, limb, minI }.
 */
export function checkProfile(a, n = 200) {
  let minI = Infinity, nonMono = false, prev = intensity(0, a);
  const limb = prev;
  for (let i = 0; i <= n; i++) {
    const I = intensity(i / n, a);
    if (I < minI) minI = I;
    if (I < prev - 1e-9) nonMono = true;
    prev = I;
  }
  const ld = prepareLD(a);
  const negative = minI < -1e-12 || !(ld.F1 > 0);
  return { ok: !negative && !nonMono, negative, nonMonotonic: nonMono, limb, minI };
}
