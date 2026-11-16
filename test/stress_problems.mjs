// Problems with known answers for stress-testing the nested sampler (used by stress.test.mjs,
// make_stress_reference.mjs and the UltraNest bridge stress_like_server.mjs).
//
// Every problem is { id, group, tier ('fast' | 'full'), title, make() }, and make() returns
//   { ndim, names, loglike(theta), transform(u, theta), truth, check?, nlive?, note? }
// truth = { lnZ, mean[], sd[], corr: [[i, j, rho], ...], modes: [{ name, test(theta), w }] }; any part may be missing.
// Truths are analytic, or one-dimensional quadrature written out below, or (transit cases) brute-force
// quadrature stored in stress_reference.json by make_stress_reference.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { buildProblem, jitterKey, planetKey } from '../src/core/model.js';
import { synthesize, combineEpochs } from '../src/core/data.js';
import { makeRng, normCdf, logAddExp } from '../src/core/stats.js';

const url = (p) => new URL(p, import.meta.url);
const REF = existsSync(url('./stress_reference.json')) ? JSON.parse(readFileSync(url('./stress_reference.json'))) : {};
const LN2PI = Math.log(2 * Math.PI);
const box = (lo, hi) => (u, x) => { for (let i = 0; i < lo.length; i++) x[i] = lo[i] + (hi[i] - lo[i]) * u[i]; };
const phi = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const simpson = (f, a, b, n) => { const h = (b - a) / n; let s = f(a) + f(b); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h); return (s * h) / 3; };
const BAD = -1e100;

export const problems = [];
const add = (p) => problems.push(p);

// ---- (a) strongly correlated Gaussians ------------------------------------------------------------
// Equicorrelated: Sigma = s^2 [(1 - rho) I + rho 11^T] on [-1, 1]^d. Normalised density, so ln Z = -d ln 2.
// Sigma^-1 = (1/(s^2 (1-rho))) [I - rho/(1 + (d-1) rho) 11^T], det = s^2d (1-rho)^(d-1) (1 + (d-1) rho).
function corrGauss(d, rho, s = 0.05) {
  const c1 = 1 / (s * s * (1 - rho)), c2 = rho / (1 + (d - 1) * rho);
  const lnNorm = -0.5 * (d * LN2PI + 2 * d * Math.log(s) + (d - 1) * Math.log(1 - rho) + Math.log(1 + (d - 1) * rho));
  const corr = []; for (let j = 1; j < Math.min(d, 4); j++) corr.push([0, j, rho]);
  return {
    ndim: d, names: Array.from({ length: d }, (_, i) => 'x' + i),
    loglike: (x) => { let q = 0, sum = 0; for (let i = 0; i < d; i++) { q += x[i] * x[i]; sum += x[i]; } return lnNorm - 0.5 * c1 * (q - c2 * sum * sum); },
    transform: box(new Array(d).fill(-1), new Array(d).fill(1)),
    truth: { lnZ: -d * Math.log(2), mean: new Array(d).fill(0), sd: new Array(d).fill(s), corr },
  };
}
for (const [d, rho, tier] of [[2, 0.99, 'fast'], [2, 0.999, 'fast'], [5, 0.99, 'fast'], [10, 0.99, 'fast'], [5, 0.999, 'full'], [10, 0.999, 'full'], [15, 0.99, 'full'], [20, 0.99, 'full'], [20, 0.999, 'full']])
  add({ id: `a-gauss-d${d}-r${rho}`, group: 'a', tier, title: `Gaussian, ${d}-D, all pairs correlated ${rho}`, make: () => corrGauss(d, rho) });

// ---- (b) curved degeneracy -------------------------------------------------------------------------
// x0 ~ N(0, 1), x_k | x0 ~ N(x0^2, sig) for k >= 1: a parabola-shaped ridge of thickness sig.
// Normalised, so ln Z = -ln(prior volume). E x_k = 1, Var x_k = sig^2 + 2, cov(x0, x_k) = 0, corr(x_j, x_k) = 2 / (2 + sig^2).
function banana(d, sig) {
  const lo = [-5.5, ...new Array(d - 1).fill(-3)], hi = [5.5, ...new Array(d - 1).fill(33)];
  const lnNorm = -0.5 * d * LN2PI - (d - 1) * Math.log(sig);
  return {
    ndim: d, names: Array.from({ length: d }, (_, i) => 'x' + i),
    loglike: (x) => { let q = x[0] * x[0]; const m = x[0] * x[0]; for (let k = 1; k < d; k++) q += ((x[k] - m) / sig) ** 2; return lnNorm - 0.5 * q; },
    transform: box(lo, hi),
    truth: { lnZ: -Math.log(11) - (d - 1) * Math.log(36), mean: [0, ...new Array(d - 1).fill(1)], sd: [1, ...new Array(d - 1).fill(Math.sqrt(sig * sig + 2))], corr: d > 2 ? [[0, 1, 0], [1, 2, 2 / (2 + sig * sig)]] : [[0, 1, 0]] },
  };
}
add({ id: 'b-banana-2d', group: 'b', tier: 'fast', title: 'Banana ridge, 2-D, thickness 0.1', make: () => banana(2, 0.1) });
add({ id: 'b-banana-2d-thin', group: 'b', tier: 'fast', title: 'Banana ridge, 2-D, thickness 0.02', make: () => banana(2, 0.02) });
add({ id: 'b-banana-5d', group: 'b', tier: 'full', title: 'Banana ridge, 5-D, thickness 0.1', make: () => banana(5, 0.1) });

// ---- (c) the a/R* - inclination degeneracy of a real transit ------------------------------------------
// Simulated transit (src/core/data.js) fitted with the app's likelihood. Reference: quadrature (stress_reference.json).
export function transitCase(b, ppm, freeArs, ld = false) {
  const ars = 9, inc = (Math.acos(b / ars) * 180) / Math.PI;
  const truthV = { rprs: 0.1, ars, inc, per: 3.2, tmid: 0, ecc: 0, omega: 0, ld0: 0.4, ld1: 0.25, a2: 0 };
  const data = synthesize(truthV, 'quadratic', { noisePpm: ppm, exptimeMin: 2, baselineHr: 1, airmass: false, seed: 21 });
  const U = (key, a, b2) => ({ key, prior: { type: 'uniform', a, b: b2 } });
  const free = ld ? [U('rprs', 0.05, 0.2), U('ld0', -1.5, 1.5), U('ld1', -1.5, 1.5)]
    : [U('inc', 75, 90), U('rprs', 0.05, 0.2), U('tmid', -0.02, 0.02), ...(freeArs ? [U('ars', 3, 25)] : [])];
  const spec = { data, values: { ...truthV }, ldLaw: 'quadratic', free, exptime: 0, supersample: 1 };
  const prob = buildProblem(spec);
  return { ndim: prob.ndim, names: prob.keys, loglike: prob.loglike, transform: prob.transform, spec, lo: free.map((f) => f.prior.a), hi: free.map((f) => f.prior.b), injected: free.map((f) => truthV[f.key]) };
}
const tid = (b, ppm, freeArs) => `c-transit-b${b}-${ppm}ppm-${freeArs ? 'ars+inc' : 'inc'}`;
for (const [b, ppm, tier] of [[0.5, 1000, 'fast'], [0.1, 1000, 'full'], [0.85, 1000, 'full'], [0.5, 300, 'full'], [0.1, 3000, 'full'], [0.85, 3000, 'full']])
  for (const freeArs of [true, false]) {
    const id = tid(b, ppm, freeArs);
    add({ id, group: 'c', tier: freeArs ? tier : (tier === 'fast' ? 'fast' : 'full'), title: `Transit, b = ${b}, ${ppm} ppm, ${freeArs ? 'a/R* and i free' : 'i free, a/R* fixed'}`, reference: { kind: 'transit', b, ppm, freeArs },
      make: () => { const c = transitCase(b, ppm, freeArs); return { ...c, truth: REF[id] || {}, note: REF[id] ? '' : 'no stored reference' }; } });
  }

// ---- (d) period aliases: separated modes of unequal weight ---------------------------------------------
// Two transit times 120 d apart and a period known to 0.05 d from discovery: every whole number of orbits in
// between fits. The app's timing likelihood (buildProblem, timing only) with a normal prior on P.
// Reference: each alias integrated on its own local grid (the modes are 2000 sigma apart).
export function aliasCase(sigP = 0.05) {
  const t = [0.0003, 120.0007], e = [0.001, 0.001], w = 0.02, muP = 3.0;
  const spec = { data: null, timing: [{ planet: '', kind: 'transit', t, e }], values: { rprs: 0.1, ars: 9, inc: 88, per: 3, tmid: 0, ecc: 0, omega: 0, ld0: 0.4, ld1: 0.25 }, ldLaw: 'quadratic',
    free: [{ key: 'per', prior: { type: 'normal', a: muP, b: sigP } }, { key: 'tmid', prior: { type: 'uniform', a: -w, b: w } }] };
  const prob = buildProblem(spec), th = new Float64Array(2);
  // local quadrature of likelihood x prior density around each alias P_n = (t2 - t1) / n
  const modes = []; let lnZ = -Infinity;
  for (let n = 30; n <= 52; n++) {
    const Pn = (t[1] - t[0]) / n, sP = Math.hypot(e[0], e[1]) / n, sT = e[0], G = 160, L = 9;
    let z = 0, mP = 0, mT = 0, vP = 0, vT = 0;
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      th[0] = Pn + ((i + 0.5) / G * 2 - 1) * L * sP; th[1] = t[0] + ((j + 0.5) / G * 2 - 1) * L * sT;
      const p = Math.exp(prob.loglike(th)) * (phi((th[0] - muP) / sigP) / sigP) / (2 * w);
      z += p; mP += p * th[0]; mT += p * th[1]; vP += p * th[0] * th[0]; vT += p * th[1] * th[1];
    }
    const cell = (2 * L * sP / G) * (2 * L * sT / G);
    modes.push({ n, P: Pn, z: z * cell, mP: mP / z, mT: mT / z, vP: vP / z - (mP / z) ** 2, vT: vT / z - (mT / z) ** 2 });
    lnZ = logAddExp(lnZ, Math.log(z * cell + 1e-320));
  }
  const Z = Math.exp(lnZ); let mP = 0, mT = 0, sP2 = 0, sT2 = 0;
  for (const m of modes) { m.w = m.z / Z; mP += m.w * m.mP; mT += m.w * m.mT; }
  for (const m of modes) { sP2 += m.w * (m.vP + (m.mP - mP) ** 2); sT2 += m.w * (m.vT + (m.mT - mT) ** 2); }
  const half = (t[1] - t[0]) / 40 - (t[1] - t[0]) / 40.5;
  return { ndim: 2, names: prob.keys, loglike: prob.loglike, transform: prob.transform,
    truth: { lnZ, mean: [mP, mT], sd: [Math.sqrt(sP2), Math.sqrt(sT2)],
      modes: modes.filter((m) => m.w > 0.002).map((m) => ({ name: `P=${m.P.toFixed(4)} (${m.n} orbits)`, w: m.w, test: (x) => Math.abs(x[0] - m.P) < half })) } };
}
add({ id: 'd-aliases', group: 'd', tier: 'fast', title: 'Period aliases: two transit times, P known to 0.05 d', make: () => aliasCase(0.05) });
add({ id: 'd-aliases-wide', group: 'd', tier: 'full', title: 'Period aliases: two transit times, P known to 0.15 d', make: () => aliasCase(0.15) });
// Two Gaussian modes of the same shape and weight 0.9 / 0.1, in d dimensions. (With a much narrower second
// mode, s2 = 0.003, only about 4 of 400 live points sit in it while the first is compressed, and it is lost
// by chance in most runs, here and in UltraNest: mode weights need live points in proportion to the modes'
// prior volumes, not their posterior weights.)
function twoModes(d) {
  const s1 = 0.01, s2 = 0.01, w1 = 0.9, c = 0.5;
  const g = (x, c0, s) => { let q = (x[0] - c0) ** 2; for (let i = 1; i < d; i++) q += x[i] * x[i]; return -0.5 * q / (s * s) - d * (0.5 * LN2PI + Math.log(s)); };
  const m0 = w1 * -c + (1 - w1) * c, v0 = w1 * (s1 * s1 + (-c - m0) ** 2) + (1 - w1) * (s2 * s2 + (c - m0) ** 2), vk = w1 * s1 * s1 + (1 - w1) * s2 * s2;
  return { ndim: d, names: Array.from({ length: d }, (_, i) => 'x' + i),
    loglike: (x) => logAddExp(Math.log(w1) + g(x, -c, s1), Math.log(1 - w1) + g(x, c, s2)), transform: box(new Array(d).fill(-1), new Array(d).fill(1)),
    truth: { lnZ: -d * Math.log(2), mean: [m0, ...new Array(d - 1).fill(0)], sd: [Math.sqrt(v0), ...new Array(d - 1).fill(Math.sqrt(vk))], modes: [{ name: 'left', w: w1, test: (x) => x[0] < 0 }, { name: 'right', w: 1 - w1, test: (x) => x[0] > 0 }] } };
}
add({ id: 'd-twomodes-4d', group: 'd', tier: 'fast', title: 'Two modes, weights 0.9 / 0.1, 4-D', make: () => twoModes(4) });
add({ id: 'd-twomodes-8d', group: 'd', tier: 'full', title: 'Two modes, weights 0.9 / 0.1, 8-D', make: () => twoModes(8) });

// ---- (e) narrow posterior in a very wide prior ---------------------------------------------------------
// Independent Gaussians of width s on [0, 1]^d plus one correlated pair (0.8). ln Z = 0 (unit cube).
// Information H = d (-ln s - 0.5 ln(2 pi e)) - 0.5 ln(1 - 0.64).
function narrow(d, s) {
  const rho = 0.8, lnNorm = -d * (0.5 * LN2PI + Math.log(s)) - 0.5 * Math.log(1 - rho * rho);
  const c = Array.from({ length: d }, (_, i) => 0.3 + 0.4 * ((i * 0.618) % 1));
  return { ndim: d, names: Array.from({ length: d }, (_, i) => 'x' + i),
    loglike: (x) => { const a = (x[0] - c[0]) / s, b = (x[1] - c[1]) / s; let q = (a * a - 2 * rho * a * b + b * b) / (1 - rho * rho); for (let i = 2; i < d; i++) q += ((x[i] - c[i]) / s) ** 2; return lnNorm - 0.5 * q; },
    transform: (u, x) => { for (let i = 0; i < d; i++) x[i] = u[i]; },
    truth: { lnZ: 0, mean: c, sd: new Array(d).fill(s), corr: [[0, 1, rho]], H: d * (-Math.log(s) - 0.5 * Math.log(2 * Math.PI * Math.E)) - 0.5 * Math.log(1 - rho * rho) } };
}
add({ id: 'e-narrow-7d-H38', group: 'e', tier: 'fast', title: 'Narrow posterior, 7-D, widths 1e-3 of the prior (38 nats)', make: () => narrow(7, 1e-3) });
add({ id: 'e-narrow-8d-H63', group: 'e', tier: 'full', title: 'Narrow posterior, 8-D, widths 1e-4 of the prior (63 nats)', make: () => narrow(8, 1e-4) });

// ---- (f) plateaus and hard walls -----------------------------------------------------------------------
// f1: Gaussian (sd 0.1) in [-1, 1]^3; models with x0 + x1 < 0.05 are invalid (the constant -1e100), a wall
// that cuts through the peak. Z = (1 - Phi(c / tau)) / 8, tau^2 = 0.02; x0 = (s + q) / 2 with s truncated.
function wall() {
  const sd = 0.1, c = 0.05, tau = sd * Math.SQRT2, a = c / tau, tail = 1 - normCdf(a), lam = phi(a) / tail;
  const ms = tau * lam, vs = tau * tau * (1 + a * lam - lam * lam), sd01 = Math.sqrt(vs / 4 + (tau * tau) / 4);
  return { ndim: 3, names: ['x0', 'x1', 'x2'],
    loglike: (x) => (x[0] + x[1] < c ? BAD : -0.5 * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]) / (sd * sd) - 3 * (0.5 * LN2PI + Math.log(sd))),
    transform: box([-1, -1, -1], [1, 1, 1]),
    truth: { lnZ: Math.log(tail / 8), mean: [ms / 2, ms / 2, 0], sd: [sd01, sd01, sd], corr: [[0, 1, (vs / 4 - (tau * tau) / 4) / (sd01 * sd01)]] } };
}
add({ id: 'f-wall', group: 'f', tier: 'fast', title: 'Hard wall through the peak (invalid models = constant)', make: wall });
// f2: a constant likelihood over 98% of the prior (every model whose transit misses the data), and a
// Gaussian peak inside radius R = 4 sigma. Z = c (1 - pi R^2 / V) + (1 - exp(-R^2 / 2 s^2)) / V, V = 4.
// (A peak smaller than 1 / nlive of the prior is simply not found: with R = 0.04 the original run ended
// after 400 calls with 'likelihood is flat over the whole prior'.)
function plateau() {
  const s = 0.04, R = 4 * s, V = 4, lnc = -3, inside = 1 - Math.exp(-8), Zp = Math.exp(lnc) * (1 - (Math.PI * R * R) / V), Zg = inside / V, Z = Zp + Zg;
  // second moments: plateau part is uniform over the square minus the disc; peak part a Gaussian truncated at 4 sigma
  const m2p = (V * (1 / 3) - (Math.PI * R ** 4) / 4) / (V - Math.PI * R * R), m2g = s * s * (1 - (8 * Math.exp(-8)) / inside);
  const sdx = Math.sqrt((Zp * m2p + Zg * m2g) / Z);
  return { ndim: 2, names: ['x0', 'x1'], loglike: (x) => { const r2 = x[0] * x[0] + x[1] * x[1]; return r2 < R * R ? -0.5 * r2 / (s * s) - LN2PI - 2 * Math.log(s) : lnc; },
    transform: box([-1, -1], [1, 1]), truth: { lnZ: Math.log(Z), mean: [0, 0], sd: [sdx, sdx], modes: [{ name: 'peak', w: Zg / Z, test: (x) => x[0] * x[0] + x[1] * x[1] < R * R }] } };
}
add({ id: 'f-plateau', group: 'f', tier: 'fast', title: 'Flat likelihood over 98% of the prior, one peak', make: plateau });
// f3: real limb-darkening walls: quadratic coefficients free in [-1.5, 1.5]; most of that square gives a
// negative or limb-brightened profile, which the app rejects. Reference: quadrature.
add({ id: 'f-ldwalls', group: 'f', tier: 'full', title: 'Transit with free quadratic limb darkening (invalid profiles)', reference: { kind: 'ld' },
  make: () => { const c = transitCase(0.3, 500, false, true); return { ...c, truth: REF['f-ldwalls'] || {}, note: REF['f-ldwalls'] ? '' : 'no stored reference' }; } });

// ---- (g) funnels -----------------------------------------------------------------------------------
// Neal's funnel in a box: v ~ N(0, sv) on [-8, 8], x_k | v ~ N(0, exp(v / 2)) on [-B, B]. The box truncates
// the wide end; everything below is one-dimensional quadrature over v.
function funnel(k) {
  const sv = 2, B = 50, V = 16 * (2 * B) ** k;
  const mass = (v) => { const a = B / Math.exp(v / 2); return (2 * normCdf(a) - 1) ** k * phi(v / sv) / sv; };
  const Z0 = simpson(mass, -8, 8, 4000), mv = simpson((v) => v * mass(v), -8, 8, 4000) / Z0, vv = simpson((v) => v * v * mass(v), -8, 8, 4000) / Z0 - mv * mv;
  const vx = simpson((v) => { const sg = Math.exp(v / 2), a = B / sg; return mass(v) * sg * sg * (1 - (2 * a * phi(a)) / (2 * normCdf(a) - 1)); }, -8, 8, 4000) / Z0;
  return { ndim: k + 1, names: ['v', ...Array.from({ length: k }, (_, i) => 'x' + i)],
    loglike: (x) => { const v = x[0]; let q = 0; for (let i = 1; i <= k; i++) q += x[i] * x[i]; return -0.5 * (v / sv) ** 2 - 0.5 * LN2PI - Math.log(sv) - 0.5 * q * Math.exp(-v) - k * (0.5 * LN2PI + 0.5 * v); },
    transform: box([-8, ...new Array(k).fill(-B)], [8, ...new Array(k).fill(B)]),
    truth: { lnZ: Math.log(Z0 / V), mean: [mv, ...new Array(k).fill(0)], sd: [Math.sqrt(vv), ...new Array(k).fill(Math.sqrt(vx))] } };
}
add({ id: 'g-funnel-4d', group: 'g', tier: 'fast', title: "Neal's funnel, 1 scale + 3 offsets", make: () => funnel(3) });
add({ id: 'g-funnel-10d', group: 'g', tier: 'full', title: "Neal's funnel, 1 scale + 9 offsets", make: () => funnel(9) });
// Radial-velocity jitter consistent with zero: the app's likelihood, K and jitter free, jitter prior U(0, 1000) m/s
// (the registry range) or log-uniform. Reference: two-dimensional quadrature on a grid refined toward zero jitter.
export function jitterCase(logPrior) {
  const rng = makeRng(77), n = 25, per = 5, K0 = 12, err = 3;
  const t = Float64Array.from({ length: n }, () => 60 * rng.next()), v = Float64Array.from(t, (x) => K0 * Math.cos(Math.PI / 2 + (2 * Math.PI * x) / per) + err * rng.normal()), e = new Float64Array(n).fill(err);
  const jk = jitterKey(0), jpr = logPrior ? { type: 'loguniform', a: 0.01, b: 1000 } : { type: 'uniform', a: 0, b: 1000 };
  const spec = { data: null, rv: [{ t, v, e }], values: { rprs: 0.1, ars: 12, inc: 90, per, tmid: 0, ecc: 0, omega: 0, K: K0, mstar: 1, ld0: 0.4, ld1: 0.25, [jk]: 0 }, ldLaw: 'quadratic',
    free: [{ key: 'K', prior: { type: 'uniform', a: 0, b: 100 } }, { key: jk, prior: jpr }] };
  const prob = buildProblem(spec), th = new Float64Array(2);
  // quadrature in (K, s = ln(jitter + 0.01)) so the grid is fine near zero
  const G = 500, kLo = 0, kHi = 40, s0 = Math.log(logPrior ? 0.01 : 0.01), s1 = Math.log(1000.01); let z = 0, m = [0, 0], q = [0, 0];
  for (let i = 0; i < G; i++) for (let j = 0; j < 4 * G; j++) {
    const s = s0 + ((j + 0.5) / (4 * G)) * (s1 - s0), jit = logPrior ? Math.exp(s) : Math.exp(s) - 0.01;
    th[0] = kLo + ((i + 0.5) / G) * (kHi - kLo); th[1] = jit;
    // prior density in jitter times d(jitter)/ds
    const pj = logPrior ? 1 / Math.log(1000 / 0.01) : Math.exp(s) / 1000;
    const p = Math.exp(prob.loglike(th) - 0) * pj / 100;
    z += p; m[0] += p * th[0]; m[1] += p * jit; q[0] += p * th[0] ** 2; q[1] += p * jit * jit;
  }
  const cell = ((kHi - kLo) / G) * ((s1 - s0) / (4 * G));
  return { ndim: 2, names: prob.keys, loglike: prob.loglike, transform: prob.transform,
    truth: { lnZ: Math.log(z * cell), mean: m.map((x) => x / z), sd: q.map((x, i) => Math.sqrt(x / z - (m[i] / z) ** 2)) } };
}
add({ id: 'g-jitter-uniform', group: 'g', tier: 'fast', title: 'RV jitter consistent with zero, prior U(0, 1000) m/s', make: () => jitterCase(false) });
add({ id: 'g-jitter-log', group: 'g', tier: 'fast', title: 'The same with a log-uniform jitter prior (0.01 to 1000 m/s)', make: () => jitterCase(true) });

// ---- (r) reparameterisations, emulated in test-local likelihoods (src/core/model.js is not changed) -----
// r1: impact parameter b = a/R* cos i sampled instead of i, on the data of c-transit-b0.5-1000ppm-ars+inc.
// The prior is uniform in b instead of uniform in i, so ln Z and the posterior differ slightly; what is
// compared is the cost and the correlation the sampler has to follow.
export function transitB(ppm = 1000, b0 = 0.5, arsPrior = null, duration = false) {
  const c = transitCase(b0, ppm, true), th = new Float64Array(4), iInc = c.names.indexOf('inc'), iArs = c.names.indexOf('ars'), iK = c.names.indexOf('rprs');
  if (duration) {
    // (T14, b) instead of (a/R*, i), circular orbit: sin(pi T14 / P) = sqrt((1 + k)^2 - b^2) / sqrt((a/R*)^2 - b^2)
    const per = c.spec.values.per, T0 = (per / Math.PI) * Math.asin(Math.sqrt((1.1 ** 2 - b0 * b0) / (81 - b0 * b0)));
    return { ndim: 4, names: c.names.map((n) => (n === 'inc' ? 'b' : n === 'ars' ? 'T14' : n)),
      transform: (u, x) => { c.transform(u, x); x[iInc] = 1.2 * u[iInc]; x[iArs] = 0.03 + 0.27 * u[iArs]; },
      loglike: (x) => { const b = x[iInc], k = x[iK], q = (1 + k) ** 2 - b * b; if (!(q > 0)) return BAD; const sn = Math.sin((Math.PI * x[iArs]) / per), ars = Math.sqrt(b * b + q / (sn * sn));
        th.set(x); th[iArs] = ars; th[iInc] = (Math.acos(b / ars) * 180) / Math.PI; return c.loglike(th); },
      truth: { injected: c.injected.map((v, k) => (k === iInc ? b0 : k === iArs ? T0 : v)) } };
  }
  if (arsPrior) {
    // a/R* from the star: normal prior of the given relative width, inclination still sampled
    const spec = { ...c.spec, free: c.spec.free.map((f) => (f.key === 'ars' ? { key: 'ars', prior: { type: 'normal', a: 9, b: 9 * arsPrior } } : f)) }, prob = buildProblem(spec);
    return { ndim: 4, names: prob.keys, loglike: prob.loglike, transform: prob.transform, truth: { injected: c.injected } };
  }
  return { ndim: 4, names: c.names.map((n) => (n === 'inc' ? 'b' : n)),
    transform: (u, x) => { c.transform(u, x); x[iInc] = 1.2 * u[iInc]; },
    loglike: (x) => { if (!(x[iInc] < x[iArs])) return BAD; th.set(x); th[iInc] = (Math.acos(x[iInc] / x[iArs]) * 180) / Math.PI; return c.loglike(th); },
    truth: { injected: c.injected.map((v, k) => (k === iInc ? b0 : v)) } };
}
add({ id: 'r-transit-b+ars', group: 'r', tier: 'full', title: 'Transit b = 0.5, 1000 ppm: impact parameter b and a/R* free (instead of i and a/R*)', make: () => transitB() });
add({ id: 'r-transit-b+T14', group: 'r', tier: 'full', title: 'The same data with impact parameter b and duration T14 free (a/R* and i follow)', make: () => transitB(1000, 0.5, null, true) });
add({ id: 'r-transit-inc+ars-density', group: 'r', tier: 'full', title: 'The same with i free and a/R* known to 3% from the stellar density', make: () => transitB(1000, 0.5, 0.03) });
// r2: eccentricity and argument of periastron from velocities of a nearly circular orbit (e = 0.05), sampled as
// (e, omega) and as (sqrt(e) cos omega, sqrt(e) sin omega). The second has the same prior (uniform in e and
// omega) on a disc, so the posteriors are identical and ln Z differs by ln(pi / 4), the part of the square the disc fills.
export function eccCase(hk, w0 = 60, id = 'r-ecc-omega') {
  const rng = makeRng(31), n = 40, per = 10, K0 = 30, e0 = 0.05, err = 3, eMax = 0.95;
  const val = { rprs: 0.1, ars: 20, inc: 90, per, tmid: 0, ecc: e0, omega: w0, K: K0, mstar: 1, ld0: 0.4, ld1: 0.25 };
  const t = Float64Array.from({ length: n }, () => 60 * rng.next());
  const clean = buildProblem({ data: null, rv: [{ t, v: new Float64Array(n), e: new Float64Array(n).fill(err) }], values: val, ldLaw: 'quadratic', free: [] }).detail([]).rv[0].model;
  const v = Float64Array.from(clean, (m) => m + err * rng.normal()), e = new Float64Array(n).fill(err);
  const U2 = (key, a, b) => ({ key, prior: { type: 'uniform', a, b } });
  const spec = { data: null, rv: [{ t, v, e }], values: val, ldLaw: 'quadratic', free: [U2('K', 0, 100), U2('ecc', 0, eMax), U2('omega', -180, 180)] };
  const prob = buildProblem(spec), th = new Float64Array(3), R = Math.sqrt(eMax), ref = REF[id] || {};
  if (!hk) return { ndim: 3, names: prob.keys, loglike: prob.loglike, transform: prob.transform, truth: ref, grid: { lo: [22, 0, -180], hi: [40, 0.3, 180], n: [72, 240, 360], priorLo: [0, 0, -180], priorHi: [100, eMax, 180] } };
  return { ndim: 3, names: ['K', 'sqrt(e) cos w', 'sqrt(e) sin w'],
    transform: (u, x) => { x[0] = 100 * u[0]; x[1] = R * (2 * u[1] - 1); x[2] = R * (2 * u[2] - 1); },
    loglike: (x) => { const ee = x[1] * x[1] + x[2] * x[2]; if (!(ee < eMax)) return BAD; th[0] = x[0]; th[1] = ee; th[2] = (Math.atan2(x[2], x[1]) * 180) / Math.PI; return prob.loglike(th); },
    truth: ref.lnZ !== undefined ? { lnZ: ref.lnZ + Math.log(Math.PI / 4) } : {} };
}
add({ id: 'r-ecc-omega', group: 'r', tier: 'full', title: 'RV, e = 0.05: K, e, omega free', reference: { kind: 'grid' }, make: () => eccCase(false) });
add({ id: 'r-ecc-sqrt', group: 'r', tier: 'full', title: 'The same sampled as K, sqrt(e) cos omega, sqrt(e) sin omega', make: () => eccCase(true) });
add({ id: 'r-ecc-omega-wrap', group: 'r', tier: 'full', title: 'RV, e = 0.05, omega = 175 deg (the posterior straddles the +-180 deg edge): K, e, omega free', reference: { kind: 'grid' }, make: () => eccCase(false, 175, 'r-ecc-omega-wrap') });
add({ id: 'r-ecc-sqrt-wrap', group: 'r', tier: 'full', title: 'The same sampled as K, sqrt(e) cos omega, sqrt(e) sin omega', make: () => eccCase(true, 175, 'r-ecc-omega-wrap') });

// ---- (h), (i): the real multi-planet and HD 80606 fits ------------------------------------------------
const csv = (p) => { const [head, ...rows] = readFileSync(url('../public/examples/' + p), 'utf8').trim().split(/\r?\n/); const names = head.split(','); return rows.map((r) => Object.fromEntries(r.split(',').map((c, i) => [names[i], Number.isNaN(Number(c)) ? c : Number(c)]))); };
const LD = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];
const U = (key, a, b) => ({ key, prior: { type: 'uniform', a, b } });

/** Three-planet toy exactly as test/exotic.test.mjs builds it; `which` picks the free set. */
export function toyCase(which = 'all') {
  const toySys = JSON.parse(readFileSync(url('../public/examples/toy1873/multi_system.json'))), TREF = 2459000;
  const lcs = ['b', 'c', 'd'].map((k) => { const r = csv(`toy1873/tess_${k}.csv`); return { name: 'tess_' + k, tRef: TREF, t: Float64Array.from(r, (x) => x.BJD - TREF), f: Float64Array.from(r, (x) => x.flux), e: Float64Array.from(r, (x) => x.ferr), airmass: null }; });
  const toyLC = combineEpochs(lcs);
  const rvRows = csv('toy1873/rv_neid.csv'), toyRV = { name: 'NEID', t: Float64Array.from(rvRows, (x) => x.BJD - TREF), v: Float64Array.from(rvRows, (x) => x.vel), e: Float64Array.from(rvRows, (x) => x.velerr) };
  const values = { mstar: 1.02, rstar: 0.974, ld0: LD[0], ld1: LD[1], ld2: LD[2], ld3: LD[3], rvlin: toySys.trend.rv_linear, [jitterKey(0)]: toySys.noise.rv_jitter };
  ['b', 'c', 'd'].forEach((k, i) => { const p = toySys.planets[k], s = i ? k : ''; for (const fld of ['rprs', 'per', 'inc', 'ecc', 'omega', 'mplanet']) values[planetKey(fld, s)] = p[fld]; values[planetKey('tmid', s)] = p.tmid - TREF; });
  const free = [], bnd = toySys.bounds;
  ['b', 'c', 'd'].forEach((k, i) => { const s = i ? k : '';
    for (const fld of which === 'all' ? ['rprs', 'per', 'inc', 'tmid', 'mplanet'] : ['mplanet']) { const [a, b] = bnd[k][fld]; free.push(U(planetKey(fld, s), fld === 'tmid' ? a - TREF : a, fld === 'tmid' ? b - TREF : b)); } });
  free.push(U('rvlin', -0.1, 0.1), U(jitterKey(0), 0, 15));
  const spec = { data: toyLC, rv: [toyRV], values, planets: ['', 'c', 'd'], kepler: true, ldLaw: 'nonlinear', free, exptime: 0, supersample: 1 };
  const prob = buildProblem(spec);
  return { ndim: prob.ndim, names: prob.keys, loglike: prob.loglike, transform: prob.transform, spec, injected: free.map((f) => values[f.key]) };
}
add({ id: 'h-toy-17d', group: 'h', tier: 'full', title: 'Three planets, transits + RV, 17 free parameters', make: () => { const c = toyCase('all'); return { ...c, truth: { ...(REF['h-toy-17d'] || {}), injected: c.injected } }; } });

/** HD 80606 b joint fit as test/exotic.test.mjs; wide = the bounds of EXOTIC's joint_fit.py, else +-5 sigma of its RV-only fit. */
export function hd80606Case(wide = true) {
  const T0 = 2458887, rows = csv('hd80606/HD80606_RV.csv'), seen = new Set(), sets = new Map();
  for (const r of rows) { if (seen.has(r.BJD)) continue; seen.add(r.BJD); const name = r.Telescope === 'HRS' ? (r['ErrVel(m/s)'] < 5 ? 'HRS_1' : 'HRS_2') : r.Telescope; if (!sets.has(name)) sets.set(name, []); sets.get(name).push(r); }
  const rv = [...sets.entries()].map(([name, rr]) => ({ name, t: Float64Array.from(rr, (x) => x.BJD - T0), v: Float64Array.from(rr, (x) => x['Vel(m/s)']), e: Float64Array.from(rr, (x) => x['ErrVel(m/s)']) }));
  const lcRows = readFileSync(url('../public/examples/hd80606/2458888_08_lightcurve.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map(Number));
  const lc = { t: Float64Array.from(lcRows, (x) => x[0] - T0), f: Float64Array.from(lcRows, (x) => x[1]), e: Float64Array.from(lcRows, (x) => x[2]), airmass: null };
  const values = { rprs: 0.1, per: 111.4367, inc: 89.269, ecc: 0.93132, omega: -58.699, tmid: 2458888.0757 - T0, mplanet: 4.20, mstar: 1.05, rstar: 1.05, ld0: LD[0], ld1: LD[1], ld2: LD[2], ld3: LD[3] };
  const tm = [[2455210.6420, 0.004], [2454987.7842, 0.0049], [2459556.6942, 0.0035], [2455210.6502, 0.0064]], noise = tm.reduce((a, x) => a + x[1], 0) / tm.length / 2;
  const timing = [{ planet: '', kind: 'transit', t: tm.map((x) => x[0] - T0), e: tm.map((x) => x[1] + noise) }, { planet: '', kind: 'eclipse', t: [2454424.736 - T0], e: [0.00025] }];
  // +-5 sigma of the velocity-only fit, the numbers test/exotic.test.mjs prints
  const rvPost = { per: [111.43675, 0.000084], omega: [-58.831926, 0.042], ecc: [0.93156423, 0.00012], mplanet: [4.1873022, 0.0030] }, w5 = (k) => U(k, rvPost[k][0] - 5 * rvPost[k][1], rvPost[k][0] + 5 * rvPost[k][1]);
  const free = wide ? [U('per', 111, 112), U('tmid', values.tmid - 0.2, values.tmid + 0.2), U('inc', 87, 90), U('omega', -61, -55), U('ecc', 0.92, 0.94), U('mplanet', 3, 4.5), U('rprs', 0.01, 0.2)]
    : [w5('per'), U('tmid', values.tmid - 0.2, values.tmid + 0.2), U('inc', 87, 90), w5('omega'), w5('ecc'), w5('mplanet'), U('rprs', 0.01, 0.2)];
  const spec = { data: lc, rv, timing, values, kepler: true, ldLaw: 'nonlinear', free, exptime: 2 / 1440, supersample: 1 };
  const prob = buildProblem(spec);
  // prior volume of the four narrowed parameters relative to the wide box: ln Z(wide) = ln Z(narrow) + this, if nothing else fits
  const wideW = { per: 1, omega: 6, ecc: 0.02, mplanet: 1.5 }; let lnVol = 0; for (const k in rvPost) lnVol += Math.log((10 * rvPost[k][1]) / wideW[k]);
  return { ndim: prob.ndim, names: prob.keys, loglike: prob.loglike, transform: prob.transform, spec, lnVolNarrowOverWide: lnVol };
}
add({ id: 'i-hd80606-narrow', group: 'i', tier: 'full', title: 'HD 80606 b joint fit, priors +-5 sigma of the RV-only fit', make: () => { const c = hd80606Case(false); return { ...c, truth: REF['i-hd80606-narrow'] || {} }; } });
add({ id: 'i-hd80606-wide', group: 'i', tier: 'full', title: "HD 80606 b joint fit, the wide bounds of EXOTIC's joint_fit.py (P 111 to 112 d)", make: () => { const c = hd80606Case(true); return { ...c, truth: REF['i-hd80606-wide'] || {} }; } });
