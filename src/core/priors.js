// Prior distributions as unit-cube transforms (the form nested sampling needs):
// each maps u ~ U(0,1) to a draw from the prior via its inverse CDF.

import { ndtri, normCdf } from './stats.js';

// The fitting UI offers these two; makeTransform also understands 'truncnormal'
// and 'loguniform' for programmatic use.
export const PRIOR_TYPES = {
  uniform: { label: 'Uniform', args: [['a', 'min'], ['b', 'max']] },
  normal:  { label: 'Normal',  args: [['a', 'mean'], ['b', 'std']] },
};

/** Build u -> x for one prior spec { type, a, b, lo, hi }. */
export function makeTransform(pr) {
  switch (pr.type) {
    case 'uniform': {
      const lo = pr.a, w = pr.b - pr.a;
      return (u) => lo + w * u;
    }
    case 'normal': {
      const m = pr.a, s = pr.b;
      // clip the extreme tails so u = 0 or 1 never maps to +-Infinity
      return (u) => m + s * ndtri(Math.min(Math.max(u, 1e-15), 1 - 1e-15));
    }
    case 'truncnormal': {
      const m = pr.a, s = pr.b;
      const ca = normCdf((pr.lo - m) / s), cb = normCdf((pr.hi - m) / s);
      return (u) => {
        const x = m + s * ndtri(Math.min(Math.max(ca + u * (cb - ca), 1e-15), 1 - 1e-15));
        return x < pr.lo ? pr.lo : x > pr.hi ? pr.hi : x;
      };
    }
    case 'loguniform': {
      const la = Math.log(pr.a), w = Math.log(pr.b) - la;
      return (u) => Math.exp(la + w * u);
    }
    default: throw new Error('unknown prior type: ' + pr.type);
  }
}

/** Returns an error string, or null if the prior is usable. */
export function validatePrior(pr) {
  const f = Number.isFinite;
  if (pr.type === 'uniform') return f(pr.a) && f(pr.b) && pr.b > pr.a ? null : 'needs min < max';
  if (pr.type === 'loguniform') return f(pr.a) && f(pr.b) && pr.a > 0 && pr.b > pr.a ? null : 'needs 0 < min < max';
  if (pr.type === 'normal') return f(pr.a) && pr.b > 0 ? null : 'needs sigma > 0';
  if (pr.type === 'truncnormal') return f(pr.a) && pr.b > 0 && f(pr.lo) && f(pr.hi) && pr.hi > pr.lo ? null : 'needs sigma > 0 and min < max';
  return 'unknown prior';
}

/** Prior density (unnormalised is fine) for drawing the prior curve in the UI. */
export function priorPdf(pr, x) {
  switch (pr.type) {
    case 'uniform': return x >= pr.a && x <= pr.b ? 1 / (pr.b - pr.a) : 0;
    case 'loguniform': return x >= pr.a && x <= pr.b ? 1 / (x * Math.log(pr.b / pr.a)) : 0;
    case 'normal': return Math.exp(-0.5 * ((x - pr.a) / pr.b) ** 2) / (pr.b * 2.5066282746310002);
    case 'truncnormal': return x >= pr.lo && x <= pr.hi ? Math.exp(-0.5 * ((x - pr.a) / pr.b) ** 2) / (pr.b * 2.5066282746310002) : 0;
    default: return 0;
  }
}
