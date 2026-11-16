// Builds public/examples/phasecurve/: two real Spitzer data sets of WASP-43 b from the owner's
// Exoplanet-Mapping repository and one simulated eclipse-mapping case. Each is written as a CSV
// (time, flux, flux_err, epoch) and as an ESL session (docs/FORMAT.md) with the parameter values,
// what is free and the priors.
//
//   git clone --depth 1 https://github.com/pearsonkyle/Exoplanet-Mapping /tmp/Exoplanet-Mapping
//   node test/make_phasecurve_examples.mjs /tmp/Exoplanet-Mapping
//
// The numbers it prints are the ones quoted in public/examples/phasecurve/README.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as P from '../src/core/phasecurve.js';
import { eventTimes } from '../src/core/kepler.js';
import { makeRng } from '../src/core/stats.js';
import { expandSpectral, bandCoefficients } from '../src/core/ldspec.js';
import { LD_SPECTRAL_COMPACT } from '../src/data/ld_spectral.js';

const repo = process.argv[2];
if (!repo) { console.error('usage: node test/make_phasecurve_examples.mjs <path to Exoplanet-Mapping checkout>'); process.exit(2); }
const OUT = new URL('../public/examples/phasecurve/', import.meta.url); mkdirSync(OUT, { recursive: true });
const r6 = (x) => +x.toFixed(6), sig = (x, n = 6) => +x.toPrecision(n);

// ---- helpers ---------------------------------------------------------------------------------
function readVisit(visit) {
  const txt = readFileSync(`${repo}/DATA/WASP-43/IRAC 4.5um/${visit}_phasecurve_0/timeseries.csv`, 'utf8').split('\n');
  const t = [], f = [];
  for (const line of txt) { if (!line || line[0] === '#' || line.startsWith('time')) continue; const c = line.split(','); const a = +c[0], b = +c[1]; if (Number.isFinite(a) && Number.isFinite(b)) { t.push(a); f.push(b); } }
  return { t, f };
}
/** Means in bins of `sec` seconds; the error of each is the scatter inside the bin over sqrt(n). Bins with under minN points are dropped. */
function bin(t, f, sec, minN) {
  const dt = sec / 86400, out = { t: [], f: [], e: [], n: [] }; let i = 0;
  while (i < t.length) {
    const k = Math.floor((t[i] - t[0]) / dt); let st = 0, sf = 0, sff = 0, n = 0;
    while (i < t.length && Math.floor((t[i] - t[0]) / dt) === k) { st += t[i]; sf += f[i]; sff += f[i] * f[i]; n++; i++; }
    if (n >= minN) { const m = sf / n; out.t.push(st / n); out.f.push(m); out.e.push(Math.sqrt(Math.max(sff / n - m * m, 0) / (n - 1))); out.n.push(n); }
  }
  return out;
}
/** chi2 with the stellar level of every epoch solved for. */
function chi2Of(data, prm, opts) {
  const f = P.makePhaseCurve(prm, opts); if (!f.ok) return 1e30;
  let nE = 1; if (data.epoch) for (const k of data.epoch) if (k >= nE) nE = k + 1;
  const sm = new Float64Array(nE), smm = new Float64Array(nE), sdd = new Float64Array(nE);
  for (let i = 0; i < data.t.length; i++) { const k = data.epoch ? data.epoch[i] : 0, w = 1 / (data.e[i] * data.e[i]), m = f(data.t[i]); sm[k] += w * m * data.f[i]; smm[k] += w * m * m; sdd[k] += w * data.f[i] * data.f[i]; }
  let c = 0; for (let k = 0; k < nE; k++) c += sdd[k] - (sm[k] * sm[k]) / smm[k];
  return c;
}
function nelderMead(fn, x0, step, iters = 4000) {
  const n = x0.length; let S = [x0.slice()]; for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; S.push(x); }
  let F = S.map(fn);
  for (let it = 0; it < iters; it++) {
    const o = F.map((_, i) => i).sort((a, b) => F[a] - F[b]); S = o.map((i) => S[i]); F = o.map((i) => F[i]);
    if (Math.abs(F[n] - F[0]) < 1e-9 * (1 + Math.abs(F[0])) && it > 50) break;
    const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const at = (k) => c.map((cj, j) => cj + k * (S[n][j] - cj));
    const xr = at(-1), fr = fn(xr);
    if (fr < F[0]) { const xe = at(-2), fe = fn(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
    else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
    else { const xc = at(fr < F[n] ? -0.5 : 0.5), fc = fn(xc); if (fc < Math.min(fr, F[n])) { S[n] = xc; F[n] = fc; } else for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = fn(S[i]); } }
  }
  const b = F.indexOf(Math.min(...F)); return { x: S[b], f: F[b] };
}
/** 1-sigma from the curvature of chi2 along each parameter with the others re-optimised is too slow here: use the Hessian. */
function hessianErrors(fn, x, h) {
  const n = x.length, H = Array.from({ length: n }, () => new Float64Array(n)), f0 = fn(x);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
    const xp = x.slice(), xm = x.slice(), xa = x.slice(), xb = x.slice();
    if (i === j) { xp[i] += h[i]; xm[i] -= h[i]; H[i][i] = (fn(xp) - 2 * f0 + fn(xm)) / (h[i] * h[i]); }
    else { xp[i] += h[i]; xp[j] += h[j]; xm[i] -= h[i]; xm[j] -= h[j]; xa[i] += h[i]; xa[j] -= h[j]; xb[i] -= h[i]; xb[j] += h[j]; H[i][j] = H[j][i] = (fn(xp) + fn(xm) - fn(xa) - fn(xb)) / (4 * h[i] * h[j]); }
  }
  // covariance = 2 H^-1
  const A = H.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; const d = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const g = A[r][c]; for (let j = 0; j < 2 * n; j++) A[r][j] -= g * A[c][j]; } }
  return x.map((_, i) => Math.sqrt(Math.max(0, 2 * A[i][n + i])));
}
const csv = (name, d) => writeFileSync(new URL(name, OUT), 'time,flux,flux_err' + (d.epoch ? ',epoch' : '') + '\n' + d.t.map((t, i) => `${(t + d.tref).toFixed(6)},${d.f[i].toFixed(6)},${d.e[i].toFixed(6)}` + (d.epoch ? `,${d.epoch[i] + 1}` : '')).join('\n') + '\n');
function session({ name, title, notes, star, ld, band, params, tref, data, epochs, free, phase, fixed = {} }) {
  return {
    format: 'esl-session', version: 1, software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null }, created: '2026-11-15T00:00:00Z',
    name, title, notes, star,
    limb_darkening: { law: 'quadratic', mode: 'coeffs', band: band.name, band_custom: band.nm, coefficients: ld.map((x) => sig(x, 4)) },
    planets: [{ letter: 'b', parameters: params }], kepler: false, time_reference: tref,
    phase,     // not in format version 1: which planet-light model the phase keys in planets[].parameters belong to
    data: { light_curve: { name: band.name, time: data.t.map((t) => r6(t + tref)), flux: data.f.map(r6), flux_err: data.e.map(r6), airmass: null, exposure_min: data.expMin,
      epoch: data.epoch || null, epochs: epochs || [] }, radial_velocity: [], timing: [] },
    fit: { use: { lc: true, rv: false, timing: false }, free, fixed, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1000000 } },
    result: null,
  };
}
const U = (key, a, b, label, unit = '') => ({ key, label, unit, prior: { type: 'uniform', a, b } });

// ---- WASP-43: star, orbit priors (DATA/WASP-43/prior.json in the repository: Hellier et al. 2011) --------------
const star = { teff: 4400, teffErr: 200, logg: 4.49, loggErr: 0.13, feh: -0.05, fehErr: 0.17, rstar: 0.6, rstarErr: 0.05, mstar: 0.58, mstarErr: 0.05 };
const spectral = expandSpectral(LD_SPECTRAL_COMPACT), bandNm = [4000, 5000];
const ldr = bandCoefficients(spectral, star, bandNm, 'quadratic'), ld = ldr.coeffs;
console.log('limb darkening 4.0-5.0 um, quadratic:', ld.map((x) => x.toFixed(4)).join(', '), ldr.clamped ? '(clamped)' : '');
const band = { name: 'Spitzer IRAC 4.5 um', nm: bandNm }, P0 = 0.813474, ARS = 4.872;
const readme = {};

// ---- (i) full-orbit phase curve: visit 2458738 (AOR 70045696 ... of program 14059), 120 s bins ----------------------
{
  const v = readVisit('2458738'), b = bin(v.t, v.f, 120, 20), tref = Math.floor(b.t[0]);
  const data = { t: b.t.map((x) => x - tref), f: b.f, e: b.e, tref, expMin: 2 };
  const base = { rprs: 0.16, per: P0, tmid: 2458738.8348 - tref, ars: ARS, inc: 82.6, ecc: 0, omega: 0, ldLaw: 'quadratic', ld, rstar: star.rstar };
  const keys = ['tmid', 'rprs', 'inc', 'fpfs', 'contrast', 'hotspot'];
  const toP = (x) => ({ ...base, tmid: x[0], rprs: x[1], inc: x[2], fpfs: x[3], contrast: x[4], hotspot: x[5] });
  const cost = (x) => (x[4] < 0 || x[4] > 1 || x[3] < 0 || x[2] > 90 ? 1e30 : chi2Of(data, toP(x), { ltt: true }));
  let fit = nelderMead(cost, [base.tmid, 0.16, 82.6, 0.14, 0.7, 10], [0.001, 0.003, 0.3, 0.02, 0.1, 5]); fit = nelderMead(cost, fit.x, [0.0003, 0.001, 0.1, 0.005, 0.03, 2]);
  const err = hessianErrors(cost, fit.x, [1e-4, 3e-4, 0.03, 2e-3, 0.02, 1]), best = toP(fit.x);
  // inflate the errors so chi2/N = 1 (the binned scatter underestimates the red noise left by the detrending)
  const N = data.t.length, scale = Math.sqrt(fit.f / (N - keys.length - 1));
  const sum = P.phaseSummary(best, { tstar: star.teff, band: 'IRAC 4.5' });
  console.log(`(i) phase curve: ${N} points, chi2 ${fit.f.toFixed(1)}, error scale ${scale.toFixed(3)}`);
  keys.forEach((k, i) => console.log(`    ${k} = ${k === 'tmid' ? (fit.x[i] + tref).toFixed(6) : fit.x[i].toPrecision(5)} +- ${(err[i] * scale).toPrecision(2)}`));
  console.log(`    depth ${(sum.depth * 1e6).toFixed(0)} ppm, night ${(sum.fnight * 1e6).toFixed(0)} ppm, Tday ${sum.tday.toFixed(0)} K, Tnight ${sum.tnight.toFixed(0)} K, A_B ${sum.bondAlbedo.toFixed(2)}, eps ${sum.epsilon.toFixed(2)}, light-travel delay ${(sum.lttDelay * 86400).toFixed(1)} s`);
  const c = P.harmonicCoefficients(best); console.log('    EXOTIC c0..c4:', [c.c0, c.c1, c.c2, c.c3, c.c4].map((x) => x.toExponential(3)).join(', '));
  const chiFlat = chi2Of(data, { ...best, contrast: 0, hotspot: 0 }, { ltt: true }); console.log(`    flat phase curve (contrast 0) at the same orbit: chi2 ${chiFlat.toFixed(1)}`);
  data.e = data.e.map((x) => x * scale);
  const params = { rprs: sig(fit.x[1], 5), ars: ARS, inc: sig(fit.x[2], 5), per: P0, tmid: r6(fit.x[0] + tref), ecc: 0, omega: 0, fpfs: sig(fit.x[3], 4), contrast: sig(fit.x[4], 3), hotspot: sig(fit.x[5], 3) };
  csv('wasp43b_irac2_phasecurve.csv', data);
  writeFileSync(new URL('wasp43b_phasecurve.json', OUT), JSON.stringify(session({
    name: 'WASP-43', title: 'WASP-43 b: full-orbit phase curve, Spitzer IRAC 4.5 um', star, ld, band, params, tref, data, phase: { mode: 'harmonic', order: 1, ltt: true, band_micron: [4.0, 5.0] },
    notes: 'First-order phase curve phased to mid-eclipse. Data: one visit (BJD 2458738.34 to 2458739.41, 1.31 orbits: eclipse, transit, eclipse) from github.com/pearsonkyle/Exoplanet-Mapping, detrended there; binned to 120 s here, errors scaled so that chi2/N = 1 at the stored parameters. See README.md in this folder.',
    free: [U('tmid', params.tmid - 0.005, params.tmid + 0.005, 'T mid', 'd'), U('rprs', 0.14, 0.18, 'Rp/R★'), U('inc', 80, 86, 'i', '°'), U('fpfs', 0, 0.4, 'Fp/F★'), U('contrast', 0, 1, 'day-night'), U('hotspot', -60, 60, 'hot spot', '°')],
  })));
  readme.i = { N, chi2: fit.f, scale, keys, x: fit.x.map((v2, i) => (keys[i] === 'tmid' ? v2 + tref : v2)), err: err.map((e2) => e2 * scale), sum, c, chiFlat };
}

// ---- (ii) eclipse mapping with a few observations: six eclipses and three transits from the three 4.5 um visits ---------
{
  const visits = ['2456896', '2458738', '2458752'], tref = 2456896, T = [], F = [], E = [], EP = [], epochs = [];
  const tm0 = 2458738.8348;
  for (const vname of visits) {
    const v = readVisit(vname);
    if (vname === '2458738') {                      // the full-orbit visit, whole: it fixes the day-night and east-west terms
      const b = bin(v.t, v.f, 120, 20), s = epochs.length;
      for (let i = 0; i < b.t.length; i++) { T.push(b.t[i] - tref); F.push(b.f[i]); E.push(b.e[i]); EP.push(s); }
      epochs.push({ name: 'phase curve 8738 (two eclipses, one transit)', airmass: false, exposure_min: 2 }); continue;
    }
    // events inside the other visits: eclipses at half-integer orbits from tm0, transits at integer orbits
    const n0 = Math.floor((v.t[0] - tm0) / P0) - 1;
    for (let k = n0; k < n0 + 5; k += 0.5) {
      const tc = tm0 + k * P0, isEcl = Math.abs(k % 1) === 0.5, half = isEcl ? 0.062 : 0.05;
      if (tc - half < v.t[0] || tc + half > v.t[v.t.length - 1]) continue;
      const tt = [], ff = []; for (let i = 0; i < v.t.length; i++) if (Math.abs(v.t[i] - tc) < half) { tt.push(v.t[i]); ff.push(v.f[i]); }
      const b = bin(tt, ff, 60, 10), s = epochs.length;
      for (let i = 0; i < b.t.length; i++) { T.push(b.t[i] - tref); F.push(b.f[i]); E.push(b.e[i]); EP.push(s); }
      epochs.push({ name: `${isEcl ? 'eclipse' : 'transit'} ${Math.round(tc - 2450000)}`, airmass: false, exposure_min: 1 });
    }
  }
  const data = { t: T, f: F, e: E, epoch: EP, tref, expMin: 1 };
  const base = { rprs: 0.16, per: P0, tmid: tm0 - tref, ars: ARS, inc: 82.6, ecc: 0, omega: 0, ldLaw: 'quadratic', ld, rstar: star.rstar, fpfs: 0.14 };
  // non-linear parameters by simplex, the map by the linear solve at each step
  const mapKeys = ['y10', 'y11', 'y1m1'];
  const toP = (x) => ({ ...base, tmid: x[0], per: x[1], rprs: x[2], inc: x[3] });
  const cost = (x) => (x[3] > 90 || x[2] <= 0 ? 1e30 : P.solveMap(data, toP(x), { lmax: 1, keys: ['y10', 'y11'], ltt: true }).chi2);
  let fit = nelderMead(cost, [base.tmid, P0, 0.16, 82.6], [0.0005, 2e-7, 0.002, 0.2], 1500); fit = nelderMead(cost, fit.x, [0.0002, 1e-7, 0.0005, 0.05], 1500);
  const err = hessianErrors(cost, fit.x, [1e-4, 5e-8, 3e-4, 0.03]);
  const N = T.length, s2 = P.solveMap(data, toP(fit.x), { lmax: 1, keys: ['y10', 'y11'], ltt: true }), s3 = P.solveMap(data, toP(fit.x), { lmax: 1, keys: mapKeys, ltt: true }), s0 = P.solveMap(data, toP(fit.x), { lmax: 1, keys: [], ltt: true });
  const scale = Math.sqrt(s2.chi2 / (N - epochs.length - 3 - 4));
  console.log(`(ii) eclipse map: ${N} points in ${epochs.length} observations (${epochs.filter((e) => e.name.startsWith('ecl')).length} eclipse windows, ${epochs.filter((e) => e.name.startsWith('tra')).length} transit windows, 1 phase curve), chi2 ${s2.chi2.toFixed(1)}, error scale ${scale.toFixed(3)}`);
  ['tmid', 'per', 'rprs', 'inc'].forEach((k, i) => console.log(`    ${k} = ${k === 'tmid' ? (fit.x[i] + tref).toFixed(6) : fit.x[i].toPrecision(8)} +- ${(err[i] * scale).toPrecision(2)}`));
  console.log(`    depth ${(s2.depth * 1e6).toFixed(0)} +- ${(s2.depthErr * scale * 1e6).toFixed(0)} ppm (uniform disc: ${(s0.depth * 1e6).toFixed(0)} ppm, chi2 ${s0.chi2.toFixed(1)})`);
  console.log(`    y10 ${s2.y.y10.toFixed(3)} +- ${(s2.yErr.y10 * scale).toFixed(3)}, y11 ${s2.y.y11.toFixed(3)} +- ${(s2.yErr.y11 * scale).toFixed(3)}  (chi2 ${s2.chi2.toFixed(1)})`);
  console.log(`    adding latitude: y1m1 ${s3.y.y1m1.toFixed(2)} +- ${(s3.yErr.y1m1 * scale).toFixed(2)} (chi2 ${s3.chi2.toFixed(1)}; map negative: ${s3.negativeMap})`);
  data.e = data.e.map((x) => x * scale);
  const y10 = s2.y.y10, params = { rprs: sig(fit.x[2], 5), ars: ARS, inc: sig(fit.x[3], 5), per: sig(fit.x[1], 9), tmid: r6(fit.x[0] + tref), ecc: 0, omega: 0, fpfs: sig(s2.fpfs, 4), y10: sig(y10, 3), y11: sig(s2.y.y11, 3), y1m1: 0 };
  csv('wasp43b_irac2_eclipses.csv', data);
  writeFileSync(new URL('wasp43b_eclipse_map.json', OUT), JSON.stringify(session({
    name: 'WASP-43', title: 'WASP-43 b: a phase curve, four more eclipses and two transits, Spitzer IRAC 4.5 um (eclipse map, degree 1)', star, ld, band, params, tref, data, epochs, phase: { mode: 'map', lmax: 1, ltt: true, band_micron: [4.0, 5.0] },
    notes: 'Eclipse mapping with a few observations of one planet: one full-orbit visit (120 s bins) plus windows around four more eclipses and two transits from two other Spitzer visits (60 s bins), all from github.com/pearsonkyle/Exoplanet-Mapping; errors scaled so that chi2/N = 1. The phase curve fixes y10 and y11; the six eclipses are what could measure latitude (y1m1), and at Spitzer precision they do not: see README.md in this folder, and wasp18b_sim_eclipse_map.json for a case where they do.',
    free: [U('tmid', params.tmid - 0.003, params.tmid + 0.003, 'T mid', 'd'), U('per', params.per - 3e-6, params.per + 3e-6, 'P', 'd'), U('rprs', 0.14, 0.18, 'Rp/R★'), U('inc', 80, 86, 'i', '°'),
      U('fpfs', 0, 0.4, 'Fp/F★'), U('y10', 0, 0.9, 'Y1,0'), U('y11', -0.3, 0.3, 'Y1,1'), U('y1m1', -0.5, 0.5, 'Y1,-1')],
  })));
  readme.ii = { N, nObs: epochs.length, chi2: s2.chi2, scale, x: fit.x.map((v2, i) => (i === 0 ? v2 + tref : v2)), err: err.map((e2) => e2 * scale), s2, s3, s0 };
}

// ---- (iii) simulated: a case where the eclipse does map the planet ---------------------------------------------------------
{
  // WASP-18 b-like orbit (Coulombe et al. 2023, Nature 620, 292: P, a/R*, i, Rp/R*), white light of a 3-5 micron spectrograph
  const tref = 2460000, truth = { rprs: 0.09783, per: 0.94145223, tmid: 0.7312, ars: 3.483, inc: 84.39, ecc: 0, omega: 0, ldLaw: 'quadratic', ld: [0.06, 0.11], rstar: 1.24,
    fpfs: 0.36, y10: 0.42, y11: 0.07, y1m1: 0.15, y20: -0.06, y22: 0.04 };
  const f = P.makePhaseCurve(truth, { ltt: true }), ev = eventTimes(truth), rng = makeRng(20261115), sigma = 60e-6, cad = 60 / 86400;
  const T = [], F = [], E = [], EP = [], epochs = [];
  const add = (tc, half, name, level) => { const s = epochs.length; for (let t = tc - half; t <= tc + half; t += cad) { T.push(t); F.push(level * f(t) + sigma * rng.normal()); E.push(sigma); EP.push(s); } epochs.push({ name, airmass: false, exposure_min: 1 }); };
  [0, 3, 7].forEach((k, i) => add(f.tecl + k * truth.per, 0.11, `eclipse ${i + 1}`, [1.0002, 0.9997, 1.0005][i]));
  add(truth.tmid + 5 * truth.per, 0.08, 'transit', 1.0001);
  const data = { t: T, f: F, e: E, epoch: EP, tref, expMin: 1 };
  const s = P.solveMap(data, truth, { lmax: 2, keys: ['y10', 'y11', 'y1m1', 'y20', 'y22'], ltt: true }), s1 = P.solveMap(data, truth, { lmax: 1, keys: ['y10', 'y11'], ltt: true }), sU = P.solveMap(data, truth, { lmax: 1, keys: [], ltt: true });
  console.log(`(iii) simulated: ${T.length} points, ${epochs.length} observations, depth ${(f.depth * 1e6).toFixed(0)} ppm, ingress ${((ev.e14 - ev.e23) / 2 * 1440).toFixed(1)} min, noise ${sigma * 1e6} ppm per minute`);
  console.log(`    linear solve at the true orbit: chi2 ${s.chi2.toFixed(1)} / ${s.dof}; ` + s.keys.slice(1).map((k) => `${k} ${s.y[k].toFixed(3)} +- ${s.yErr[k].toFixed(3)} (${truth[k]})`).join(', ') + `; fpfs ${s.fpfs.toFixed(4)} (${truth.fpfs})`);
  console.log(`    without latitude and degree 2: chi2 ${s1.chi2.toFixed(1)}; uniform disc: chi2 ${sU.chi2.toFixed(1)}`);
  const tm = P.temperatureMap(truth, { tstar: 6400, band: [3, 5] }); console.log(`    injected hot spot at lon ${tm.hotspot.lon.toFixed(1)}°, lat ${tm.hotspot.lat.toFixed(1)}°, ${tm.hotspot.temp.toFixed(0)} K; minimum brightness ${f.minIntensity.toFixed(3)}`);
  const params = { rprs: truth.rprs, ars: truth.ars, inc: truth.inc, per: truth.per, tmid: r6(truth.tmid + tref), ecc: 0, omega: 0, fpfs: truth.fpfs, y10: truth.y10, y11: truth.y11, y1m1: truth.y1m1, y20: truth.y20, y22: truth.y22 };
  csv('wasp18b_sim_eclipses.csv', data);
  writeFileSync(new URL('wasp18b_sim_eclipse_map.json', OUT), JSON.stringify(session({
    name: 'WASP-18 (simulated)', title: 'Simulated: three eclipses and a transit at JWST precision (eclipse map, degree 2)', ld: truth.ld, band: { name: '3-5 um white light (simulated)', nm: [3000, 5000] }, params, tref, data, epochs,
    star: { teff: 6400, teffErr: 70, logg: 4.3, loggErr: 0.1, feh: 0.1, fehErr: 0.1, rstar: 1.24, rstarErr: 0.04, mstar: 1.29, mstarErr: 0.1 }, phase: { mode: 'map', lmax: 2, ltt: true, band_micron: [3.0, 5.0], simulated: true },
    notes: 'SIMULATED. Orbit of WASP-18 b (Coulombe et al. 2023); injected map fpfs 0.36, y10 0.42, y11 0.07, y1m1 0.15, y20 -0.06, y22 0.04; white Gaussian noise of 60 ppm per 60 s point (seed 20261115); stellar levels 1.0002, 0.9997, 1.0005, 1.0001; light-travel delay included. The planet parameters stored here are the injected ones. See README.md in this folder.',
    free: [U('tmid', params.tmid - 0.002, params.tmid + 0.002, 'T mid', 'd'), U('rprs', 0.09, 0.105, 'Rp/R★'), U('inc', 82, 88, 'i', '°'), U('fpfs', 0.2, 0.5, 'Fp/F★'),
      U('y10', 0, 0.577, 'Y1,0'), U('y11', -0.3, 0.3, 'Y1,1'), U('y1m1', -0.3, 0.3, 'Y1,-1'), U('y20', -0.3, 0.3, 'Y2,0'), U('y22', -0.3, 0.3, 'Y2,2')],
  })));
}

