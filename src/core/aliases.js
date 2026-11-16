// Period aliases of a planet seen in only a few, widely spaced transits.
//
// Transits seen at t_1 < t_2 < ... separated by S (or multiples of it) fix the period only to P = S / N for a whole
// number N of orbits between them. Coverage removes most N: an alias that predicts a transit inside data that were
// taken, where none was seen, is excluded. What survives goes to the sampler in one of two ways (model.js, buildProblem):
//
//   * one categorical parameter: the planet's "nalias" (planet-scoped, "nalias@d") with the prior
//     { type: 'categorical', values: allowed N, weights? } and "palias" = S (fixed, or free with a narrow prior); the
//     period is palias / nalias. One run then gives the evidence of the whole set (the prior-weighted mean of the
//     evidences of each N) and the posterior probability of each alias (the weight of its samples);
//   * one run per allowed N (aliasRuns) with the evidences compared afterwards (combineAliasEvidence).
// The two agree (test/aliases.test.mjs); the first costs about one run, the second gives each alias its own posterior.
//
// The scan is the rule of EXOTIC's toi1873_extract.py (stage_alias_scan): a predicted transit is "covered" when more
// than half (minCoverage) of the window [x - T14/2, x + T14/2] has data, and "missed" when covered and more than
// matchTol (0.1 d) from every transit that was seen. T14 is that of each alias (a/R* from Kepler's law at that
// period), so long aliases need more of a gap to be excluded.

import { arsFromKepler } from './rv.js';

/**
 * Merged time intervals covered by data. t: times (any order), cadence: one number (days) or one per point; each point
 * covers t +- cadence/2; spans closer than maxGap (default: one cadence) are joined. Returns [[start, end], ...] sorted.
 */
export function coverageIntervals(t, cadence, { maxGap } = {}) {
  const n = t.length, idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b]), out = [];
  for (const i of idx) {
    const c = typeof cadence === 'number' ? cadence : cadence[i], a = t[i] - c / 2, b = t[i] + c / 2, gap = maxGap ?? 1.01 * c;
    if (out.length && a <= out[out.length - 1][1] + gap) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Length of [a, b] covered by the sorted, disjoint intervals. An interval may instead be a run of exposures,
 * [first centre, last centre, cadence]: it then contributes cadence x (number of centres strictly inside (a, b)), the
 * rule of EXOTIC's alias scan (sum of the cadences of the points in the window).
 */
export function coveredLength(iv, a, b) {
  let lo = 0, hi = iv.length;
  const end = (r) => (r.length > 2 ? r[1] + r[2] / 2 : r[1]), start = (r) => (r.length > 2 ? r[0] - r[2] / 2 : r[0]);
  while (lo < hi) { const m = (lo + hi) >> 1; if (end(iv[m]) <= a) lo = m + 1; else hi = m; }
  let s = 0;
  for (let k = lo; k < iv.length && start(iv[k]) < b; k++) {
    const r = iv[k];
    if (r.length > 2) {
      const c = r[2], K = Math.round((r[1] - r[0]) / c), k0 = Math.max(0, Math.floor((a - r[0]) / c) + 1), k1 = Math.min(K, Math.ceil((b - r[0]) / c) - 1);
      if (k1 >= k0) s += c * (k1 - k0 + 1);
    } else s += Math.max(0, Math.min(b, r[1]) - Math.max(a, r[0]));
  }
  return s;
}

/**
 * Total transit duration [d] (first to fourth contact): P / pi asin( sqrt((1 + k)^2 - b^2) / (a/R* sin i) ), b = a/R* cos i,
 * times sqrt(1 - e^2) / (1 + e sin omega) for an eccentric orbit. a/R* from Kepler's law (mstar [M_sun], rstar [R_sun])
 * unless g.ars is given. NaN when the planet does not transit.
 */
export function transitDuration(P, g) {
  const ars = g.ars > 0 ? g.ars : arsFromKepler(P, g.mstar, g.mplanet || 0, g.rstar), inc = ((g.inc ?? 90) * Math.PI) / 180, k = g.rprs || 0;
  const b = ars * Math.cos(inc), x = (1 + k) ** 2 - b * b;
  if (!(x > 0)) return NaN;
  const e = g.ecc || 0, f = e ? Math.sqrt(1 - e * e) / (1 + e * Math.sin(((g.omega || 0) * Math.PI) / 180)) : 1;
  return (P / Math.PI) * Math.asin(Math.min(1, Math.sqrt(x) / (ars * Math.sin(inc)))) * f;
}

/**
 * Which aliases survive the coverage.
 * o = { transits: [times seen],
 *       span: S (default: the smallest spacing between consecutive transits seen, averaged over the whole set when every
 *             spacing is a multiple of it),
 *       coverage: [[start, end], ...] (coverageIntervals), runs [[first, last, cadence], ...] (coveredLength), or { t, cadence },
 *       duration: days | (P) => days | { rprs, mstar, rstar, inc?, ecc?, omega? } (transitDuration),
 *       nMax (25), minCoverage (0.5), matchTol (0.1 d),
 *       reference: time from which transits are predicted (default the first transit seen) }
 * Returns { span, rows: [{ N, per, t14, predicted, covered, missed, missedTimes, consistent, allowed }], allowed: [N ...] }.
 * consistent: every transit seen lies within matchTol of a predicted one (false when S / N does not divide the spacings).
 */
export function aliasScan(o) {
  const tr = [...o.transits].sort((a, b) => a - b);
  let span = o.span;
  if (!(span > 0)) {
    // the smallest spacing, refined as (last - first) / (whole number of such spacings between them) when every spacing
    // is a multiple of it (900.1885 d for TOI-1873 d, the README's value, from spacings of 900.191 and 900.186 d)
    let dmin = Infinity; for (let i = 1; i < tr.length; i++) dmin = Math.min(dmin, tr[i] - tr[i - 1]);
    if (!Number.isFinite(dmin)) throw new Error('aliasScan needs two transits or a span');
    let m = 0, whole = true; for (let i = 1; i < tr.length; i++) { const r = (tr[i] - tr[i - 1]) / dmin; m += Math.round(r); if (Math.abs(r - Math.round(r)) * dmin > (o.matchTol ?? 0.1)) whole = false; }
    span = whole ? (tr[tr.length - 1] - tr[0]) / m : dmin;
  }
  const iv = Array.isArray(o.coverage) ? o.coverage : coverageIntervals(o.coverage.t, o.coverage.cadence);
  const t0 = iv[0][0], t1 = iv[iv.length - 1][1], ref = o.reference ?? tr[0];
  const dur = typeof o.duration === 'function' ? o.duration : typeof o.duration === 'number' ? () => o.duration : (P) => transitDuration(P, o.duration);
  const nMax = o.nMax || 25, minCov = o.minCoverage ?? 0.5, tol = o.matchTol ?? 0.1, rows = [];
  for (let N = 1; N <= nMax; N++) {
    const P = span / N, d = dur(P);
    let predicted = 0, covered = 0, missed = 0; const missedTimes = [];
    const k0 = Math.floor((t0 - ref) / P) - 1, k1 = Math.ceil((t1 - ref) / P) + 1;
    for (let k = k0; k <= k1; k++) {
      const x = ref + k * P; if (!(x > t0 && x < t1)) continue;
      predicted++;
      if (coveredLength(iv, x - d / 2, x + d / 2) / d > minCov) {
        covered++;
        let near = Infinity; for (const s of tr) near = Math.min(near, Math.abs(s - x));
        if (near > tol) { missed++; missedTimes.push(x); }
      }
    }
    const consistent = tr.every((s) => { const r = (s - ref) / P; return Math.abs(r - Math.round(r)) * P <= tol; });
    rows.push({ N, per: P, t14: d, predicted, covered, missed, missedTimes, consistent, allowed: missed === 0 && consistent });
  }
  return { span, rows, allowed: rows.filter((r) => r.allowed).map((r) => r.N) };
}

/**
 * Categorical prior over the allowed N. weights: 'uniform' (default) or 'geometric': proportional to the transit
 * probability R* / a, i.e. N^(2/3) at fixed span (a shorter period is more likely to transit), as in the owner's
 * TOI-1873 alias comparison ("geom. prior" column); or an array.
 */
export function aliasPrior(allowed, weights = 'uniform') {
  const w = Array.isArray(weights) ? weights : weights === 'geometric' ? allowed.map((N) => Math.pow(N, 2 / 3)) : allowed.map(() => 1);
  return { type: 'categorical', values: [...allowed], weights: w };
}

/**
 * One fit specification per alias: the planet's nalias is fixed at each N (and dropped from the free list).
 * spec: a buildProblem specification in which planet sfx has nalias (free with a categorical prior, or fixed) and palias.
 * Returns [{ N, spec }].
 */
export function aliasRuns(spec, sfx, allowed) {
  const key = sfx ? 'nalias@' + sfx : 'nalias';
  const Ns = allowed || (spec.free.find((f) => f.key === key) || {}).prior?.values;
  if (!Ns) throw new Error(`aliasRuns: no allowed N for ${key}`);
  return Ns.map((N) => ({ N, spec: { ...spec, values: { ...spec.values, [key]: N }, free: spec.free.filter((f) => f.key !== key) } }));
}

/**
 * Combine the evidences of one run per alias: runs = [{ N, logZ, logZerr }], weights as in aliasPrior.
 * Returns { logZ (of the whole set: the prior-weighted mean), logZerr, probs: [{ N, p, err }] } where p = w_N Z_N / sum.
 */
export function combineAliasEvidence(runs, weights = 'uniform') {
  const pr = aliasPrior(runs.map((r) => r.N), weights), W = pr.weights.reduce((a, b) => a + b, 0);
  const lw = runs.map((r, i) => r.logZ + Math.log(pr.weights[i] / W)), m = Math.max(...lw), s = lw.reduce((a, x) => a + Math.exp(x - m), 0);
  const p = lw.map((x) => Math.exp(x - m) / s);
  // error propagation with independent ln Z errors
  const logZerr = Math.sqrt(runs.reduce((a, r, i) => a + (p[i] * (r.logZerr || 0)) ** 2, 0));
  return { logZ: m + Math.log(s), logZerr, probs: runs.map((r, i) => ({ N: r.N, p: p[i], err: p[i] * Math.sqrt(((1 - p[i]) * (r.logZerr || 0)) ** 2 + runs.reduce((a, q, j) => a + (j === i ? 0 : (p[j] * (q.logZerr || 0)) ** 2), 0)) })) };
}
