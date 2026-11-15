// Keplerian orbit geometry for transit modelling.
//
// Frame (same physical convention as pylightcurve.planet_orbit, relabelled):
//   X, Y  : plane of the sky, in units of the stellar radius
//   Z     : toward the observer. Z > 0 means the planet is in front of the star.
// Mid-transit (inferior conjunction) is where  omega + nu = pi/2.

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

/**
 * Solve Kepler's equation  E - e sin E = M  for the eccentric anomaly.
 *
 * pylightcurve iterates plain Newton from E0 = M to |dE| < 1e-7 on the whole
 * array. That start is poor for e > ~0.8 (HD 80606 b, e = 0.93) and the loose
 * tolerance leaves ~1e-7 rad of phase error. Here: Danby's starter and a
 * quartic (Halley+1) update, iterated to machine precision. Converges in
 * 2-4 iterations for every e < 1.
 */
export function solveKepler(M, e) {
  // reduce to [-pi, pi]
  M = M - TWO_PI * Math.floor((M + Math.PI) / TWO_PI);
  if (e === 0) return M;
  const s = Math.sin(M);
  let E = M + 0.85 * e * (s < 0 ? -1 : 1);
  for (let it = 0; it < 30; it++) {
    const sE = Math.sin(E), cE = Math.cos(E);
    const f = E - e * sE - M;
    const f1 = 1 - e * cE;
    const f2 = e * sE;
    const f3 = e * cE;
    const d1 = -f / f1;
    const d2 = -f / (f1 + 0.5 * d1 * f2);
    const d3 = -f / (f1 + 0.5 * d2 * f2 + d2 * d2 * f3 / 6);
    E += d3;
    if (Math.abs(d3) < 1e-15 * Math.max(1, Math.abs(E))) break;
  }
  return E;
}

/** True anomaly from eccentric anomaly (atan2 form, safe near E = pi). */
export function trueAnomaly(E, e) {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

/** Mean anomaly at inferior conjunction (mid-transit) for given e, omega [rad]. */
export function meanAnomalyAtTransit(e, omega) {
  if (e === 0) return Math.PI / 2 - omega;
  const nu = Math.PI / 2 - omega;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return E - e * Math.sin(E);
}

/**
 * Precompute everything that does not depend on time.
 * p: { per, tmid, ars, inc (deg), ecc, omega (deg) }
 */
export function orbitElements(p) {
  const e = Math.min(Math.max(p.ecc || 0, 0), 0.999);
  const w = (p.omega || 0) * DEG;
  const inc = p.inc * DEG;
  const M0 = meanAnomalyAtTransit(e, w);
  return {
    per: p.per, tmid: p.tmid, ars: p.ars, e, w, inc,
    sinI: Math.sin(inc), cosI: Math.cos(inc),
    M0, n: TWO_PI / p.per,
    tperi: p.tmid - (M0 / TWO_PI) * p.per,
  };
}

/** Position at time t. Writes [X, Y, Z] (stellar radii) into out. */
export function orbitPosition(el, t, out) {
  let u; // omega + nu
  let r;
  if (el.e === 0) {
    u = Math.PI / 2 + el.n * (t - el.tmid);
    r = el.ars;
  } else {
    const M = el.M0 + el.n * (t - el.tmid);
    const E = solveKepler(M, el.e);
    const nu = trueAnomaly(E, el.e);
    u = el.w + nu;
    r = el.ars * (1 - el.e * Math.cos(E));
  }
  const cu = Math.cos(u), su = Math.sin(u);
  out[0] = -r * cu;
  out[1] = -r * su * el.cosI;
  out[2] = r * su * el.sinI;
  return out;
}

/** Sample the full orbit as n points (for drawing). Returns Float32Array(3n). */
export function orbitPath(el, n = 512) {
  const out = new Float32Array(3 * n);
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    // uniform in eccentric anomaly gives even spacing along the ellipse
    const E = (TWO_PI * i) / n;
    const nu = trueAnomaly(E, el.e);
    const r = el.ars * (1 - el.e * Math.cos(E));
    const u = el.w + nu;
    v[0] = -r * Math.cos(u);
    v[1] = -r * Math.sin(u) * el.cosI;
    v[2] = r * Math.sin(u) * el.sinI;
    out.set(v, 3 * i);
  }
  return out;
}

/** Derived transit quantities (Winn 2010, eqs. 7, 14-16). Durations in days. */
export function derived(p) {
  const e = p.ecc || 0, w = (p.omega || 0) * DEG, inc = p.inc * DEG;
  const k = p.rprs;
  const rho = (1 - e * e) / (1 + e * Math.sin(w)); // r/a at conjunction
  const b = p.ars * Math.cos(inc) * rho;
  const fac = (p.per / Math.PI) * Math.sqrt(1 - e * e) / (1 + e * Math.sin(w));
  const arg = (x) => {
    const v = (Math.sqrt(Math.max((1 + x) ** 2 - b * b, 0)) / p.ars) / Math.sin(inc);
    return Math.asin(Math.min(1, v));
  };
  const t14 = b < 1 + k ? fac * arg(k) : 0;
  const t23 = b < 1 - k ? fac * arg(-k) : 0;
  // mean stellar density from a/Rs and P (circular-equivalent), g/cm^3
  const G = 6.6743e-8, day = 86400;
  const rhoStar = (3 * Math.PI * p.ars ** 3) / (G * (p.per * day) ** 2);
  return { b, t14, t23, depth: k * k, rhoStar, grazing: b > 1 - k && b < 1 + k, transits: b < 1 + k };
}

// ---- event times and durations ------------------------------------------------

/** Projected star-planet separation (stellar radii) and whether the planet is in front. */
export function separation(el, t, tmp = [0, 0, 0]) {
  orbitPosition(el, t, tmp);
  return { d: Math.hypot(tmp[0], tmp[1]), front: tmp[2] > 0 };
}

/**
 * Contact-to-contact duration of an occultation centred near tc, found
 * numerically from the orbit (bisection on separation = limit). Exact for any
 * eccentricity, unlike the closed-form approximations. Returns 0 if the discs
 * never reach `limit` at tc.
 */
export function contactDuration(el, limit, tc) {
  const tmp = [0, 0, 0];
  const sep = (t) => { orbitPosition(el, t, tmp); return Math.hypot(tmp[0], tmp[1]); };
  if (!(sep(tc) < limit)) return 0;
  const edge = (dir) => {
    let h = el.per * 1e-5, a = tc, b = tc + dir * h;
    while (sep(b) < limit) { a = b; h *= 2; b = tc + dir * h; if (h > el.per / 2) return dir * el.per / 2; }
    for (let i = 0; i < 60; i++) { const m = 0.5 * (a + b); if (sep(m) < limit) a = m; else b = m; }
    return 0.5 * (a + b) - tc;
  };
  return edge(1) - edge(-1);
}

/** Time of superior conjunction (mid-eclipse) nearest to tmid, from precomputed elements. */
export function eclipseTime(el) {
  const nuE = -Math.PI / 2 - el.w;
  const Ee = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(nuE / 2), Math.sqrt(1 + el.e) * Math.cos(nuE / 2));
  const t = el.tmid + (Ee - el.e * Math.sin(Ee) - el.M0) / el.n;
  return t - el.per * Math.round((t - el.tmid) / el.per);
}

/**
 * Times of periastron and of superior conjunction (mid-eclipse), each chosen as
 * the one nearest to tmid, plus numerically exact transit and eclipse durations.
 */
export function eventTimes(p) {
  const el = orbitElements(p), k = Math.abs(p.rprs);
  const near = (t) => t - el.per * Math.round((t - el.tmid) / el.per);
  let tperi = el.tmid - el.M0 / el.n;
  if (tperi > el.tmid) tperi -= el.per;                 // the periastron passage preceding this transit
  const nuE = -Math.PI / 2 - el.w;
  const Ee = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(nuE / 2), Math.sqrt(1 + el.e) * Math.cos(nuE / 2));
  const tecl = near(el.tmid + (Ee - el.e * Math.sin(Ee) - el.M0) / el.n);
  return {
    tperi, tecl,
    t14: contactDuration(el, 1 + k, el.tmid), t23: contactDuration(el, 1 - k, el.tmid),
    e14: contactDuration(el, 1 + k, tecl), e23: contactDuration(el, 1 - k, tecl),
  };
}
