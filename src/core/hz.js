// Habitable zone from the Kopparapu et al. (2013, 2014) effective-flux fits:
//   S_eff = S_sun + a T + b T^2 + c T^3 + d T^4,  T = Teff - 5780 K  (2600-7200 K)
//   d = sqrt(L / S_eff) AU
// With L = R^2 (Teff/Tsun)^4 the distance in units of the stellar radius does not
// depend on R at all:  d/R* = 215.032 (Teff/Tsun)^2 / sqrt(S_eff). Tsun = 5780 K
// here, the value the fits were normalised with.

const K14 = {
  recentVenus: [1.776, 2.136e-4, 2.533e-8, -1.332e-11, -3.097e-15],
  runaway:     [1.107, 1.332e-4, 1.580e-8, -8.308e-12, -1.931e-15],
  maxGreen:    [0.356, 6.171e-5, 1.698e-9, -3.198e-12, -5.575e-16],
  earlyMars:   [0.320, 5.547e-5, 1.526e-9, -2.874e-12, -5.011e-16],
};
const AU_RSUN = 215.032;

export function seff(limit, teff) {
  const c = K14[limit], T = Math.min(7200, Math.max(2600, teff)) - 5780;
  return c[0] + T * (c[1] + T * (c[2] + T * (c[3] + T * c[4])));
}

/** HZ edges in stellar radii: optimistic [recentVenus, earlyMars], conservative [runaway, maxGreen]. */
export function hzEdges(teff) {
  const r = (lim) => AU_RSUN * (teff / 5780) ** 2 / Math.sqrt(seff(lim, teff));
  return { recentVenus: r('recentVenus'), runaway: r('runaway'), maxGreen: r('maxGreen'), earlyMars: r('earlyMars') };
}

/**
 * Radial membership profile that folds in what we do not know.
 *   teff, teffErr : the star's temperature and its 1-sigma uncertainty
 *   albedo [lo, hi]: range of planetary Bond albedo. The climate models behind
 *     the fits assume an Earth-like albedo near 0.3; a planet that reflects
 *     more absorbs less, so every edge is moved by sqrt((1-A)/(1-0.3)). This
 *     scaling is a heuristic layered on the published limits, not part of them.
 * Returns { r, w } with w in [0,1]: 1 where every draw puts r inside the
 * conservative zone, lower where only some draws (or only the optimistic
 * limits) include it.
 */
export function hzProfile({ teff, teffErr = 0, albedo = [0.2, 0.4] }, n = 128) {
  const GH = [-2, -1.2, -0.6, 0, 0.6, 1.2, 2], GW = [0.03, 0.11, 0.21, 0.30, 0.21, 0.11, 0.03];
  const draws = [];
  for (let i = 0; i < GH.length; i++) for (let j = 0; j < 7; j++) {
    const T = teff + GH[i] * teffErr, A = albedo[0] + ((albedo[1] - albedo[0]) * j) / 6;
    const s = Math.sqrt(Math.max(0.02, 1 - A) / 0.7), e = hzEdges(T);
    draws.push({ w: GW[i] / 7, in1: e.runaway * s, out1: e.maxGreen * s, in0: e.recentVenus * s, out0: e.earlyMars * s });
  }
  let lo = Infinity, hi = 0;
  for (const d of draws) { lo = Math.min(lo, d.in0); hi = Math.max(hi, d.out0); }
  lo *= 0.9; hi *= 1.08;
  const r = new Float32Array(n), w = new Float32Array(n);
  let sw = 0; for (const d of draws) sw += d.w;
  for (let k = 0; k < n; k++) {
    const x = lo + ((hi - lo) * k) / (n - 1); r[k] = x;
    let a = 0;
    for (const d of draws) a += d.w * (x >= d.in1 && x <= d.out1 ? 1 : x >= d.in0 && x <= d.out0 ? 0.4 : 0);
    w[k] = a / sw;
  }
  return { r, w, inner: lo, outer: hi, nominal: hzEdges(teff) };
}
