// Checks for the calculations added or changed by the science-core audit (2026-11-15). Each line names its
// independent reference: an analytic limit, quadrature done here, or a published value.
//   node test/audit.test.mjs            AUDIT_SEEDS=32 for a tighter sampler check (default 12, about 15 s)
import { deriveSystem, summarizeDraws, summarizeEpoch, C } from '../src/core/derive.js';
import { orbitElements, orbitPosition, eventTimes, contactDuration } from '../src/core/kepler.js';
import { buildProblem, infoCriteria } from '../src/core/model.js';
import { lightTravelDelay, makePhaseCurve } from '../src/core/phasecurve.js';
import { semiAmplitude, massFromK } from '../src/core/rv.js';
import { makeRng } from '../src/core/stats.js';
import { MiniNest } from '../src/core/nested.js';
import { problems } from './stress_problems.mjs';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const rel = (a, b) => Math.abs(a / b - 1);

// ---- constants -------------------------------------------------------------------------------------------------
{
  // IAU 2015 Resolution B3 nominal values (Prsa et al. 2016, Table 1) and the IAU 2012 au
  const N = { Rsun: 6.957e8, Rjup: 7.1492e7, Rearth: 6.3781e6, TeffSun: 5772, AU: 1.495978707e11, GMsun: 1.3271244e20, GMjup: 1.2668653e17, GMearth: 3.986004e14 };
  const worst = Math.max(rel(C.Rsun, N.Rsun), rel(C.Rjup, N.Rjup), rel(C.Rearth, N.Rearth), rel(C.TeffSun, N.TeffSun), rel(C.AU, N.AU), rel(C.GMsun, N.GMsun), rel(C.Mjup_Msun, N.GMjup / N.GMsun), rel(C.Mearth_Msun, N.GMearth / N.GMsun), rel(C.G * C.Msun, C.GMsun));
  check('constants are the IAU 2015 B3 nominal set', worst < 1e-7, `largest relative difference ${worst.toExponential(1)} (GMsun: DE value against the rounded nominal one)`);
}

// ---- semi-amplitude: the two-body expression --------------------------------------------------------------------
{
  // Jupiter and the Sun, circular, edge-on: K = 2 pi a_star / P with a_star = a Mp / (M* + Mp), a from Kepler's law with the total mass
  const P = 4332.589, mp = C.Mjup_Msun, a = Math.cbrt((C.GMsun * (1 + mp) * (P * 86400) ** 2) / (4 * Math.PI ** 2));
  const Kref = (2 * Math.PI * a * mp) / (1 + mp) / (P * 86400), K = semiAmplitude(P, 0, 90, 1, 1);
  const back = massFromK(K, P, 0, 90, 1);
  check('K is the two-body semi-amplitude', rel(K, Kref) < 1e-12 && rel(back, 1) < 1e-12, `Jupiter: ${K.toFixed(4)} m/s against ${Kref.toFixed(4)} from a_star; Mp / M* in place of Mp / (M* + Mp) would give ${(Kref * (1 + mp)).toFixed(4)}; mass back ${back.toFixed(12)} M_Jup`);
}

// ---- derived quantities -------------------------------------------------------------------------------------------
{
  // GJ 1132 b with the values Kempton et al. (2018) used (Dittmann et al. 2017): their ESM is scaled to give 7.5
  const d = deriveSystem({ rprs: 0.0455, ars: 16.54, inc: 88.68, per: 1.628931, tmid: 0, ecc: 0, omega: 0 }, { rstar: 0.2105, mstar: 0.181, teff: 3270, kmag: 8.322 });
  check('ESM of GJ 1132 b', Math.abs(d.esm - 7.5) < 0.05, `${d.esm.toFixed(2)} against 7.5 (Kempton et al. 2018, the planet their metric is normalised on)`);
  // TSM: eq. 1 and 3 of the same paper evaluated separately (Python) for Rp = 2.742 R_E, Mp = 8.17 M_E, R* = 0.215, T* = 3250 K, a/R* = 14.85, J = 9.75
  const rstar = 0.215, rprs = (2.742 * C.Rearth) / (rstar * C.Rsun);
  const t = deriveSystem({ rprs, ars: 14.85, inc: 90, per: 1.58040456, tmid: 0, ecc: 0, omega: 0 }, { rstar, mstar: 0.15, teff: 3250, jmag: 9.75, mplanet: (8.17 * C.Mearth_Msun) / C.Mjup_Msun });
  check('TSM, equation 1 of Kempton et al. (2018)', rel(t.tsm, 460.23437854644783) < 1e-6, `${t.tsm.toFixed(2)} against 460.23 evaluated by hand for a GJ 1214 b-like planet`);
}
{
  // surface gravity from observables alone (Southworth et al. 2007); HD 209458 b: 9.28 +- 0.15 m/s^2 there
  const P = 3.52474859, K = 84.67, ars = 8.76, k = 0.12086, inc = 86.71;
  const mp = massFromK(K, P, 0, inc, 1.119), rstar = (Math.cbrt((C.GMsun * (1.119 + mp * C.Mjup_Msun) * (P * 86400) ** 2) / (4 * Math.PI ** 2)) / ars) / C.Rsun;
  const d = deriveSystem({ rprs: k, ars, inc, per: P, tmid: 0, ecc: 0, omega: 0 }, { rstar, mstar: 1.119, teff: 6065, mplanet: mp });
  check('planet surface gravity, two routes', rel(d.gp, d.gpRV) < 2e-3 && Math.abs(d.gpRV - 9.28) < 0.3, `G Mp / Rp^2 = ${d.gp.toFixed(3)}, from P, K, a/R*, k, i alone ${d.gpRV.toFixed(3)} m/s^2 ; Southworth et al. (2007) 9.28 ± 0.15 for HD 209458 b`);
}
{
  // Hill radius of the Earth: 0.00983 au (1.471e6 km) at perihelion
  const k = C.Rearth / C.Rsun, ars = C.AU / C.Rsun, e = 0.0167;
  const d = deriveSystem({ rprs: k, ars, inc: 90, per: 365.256363, tmid: 0, ecc: e, omega: 0 }, { rstar: 1, mstar: 1, teff: 5772, mplanet: C.Mearth_Msun / C.Mjup_Msun });
  const ref = (1 - e) * Math.cbrt(C.Mearth_Msun / 3);
  check('Hill radius', rel(d.hillAU, ref) < 1e-4 && Math.abs(d.hillAU * C.AU / 1e9 - 1.471) < 0.005, `Earth: ${d.hillAU.toFixed(6)} au = ${(d.hillAU * C.AU / 1e9).toFixed(3)} million km (1.471 at perihelion)`);
  check('insolation and equilibrium temperature of the Earth', Math.abs(d.insol - 1) < 1e-3 && Math.abs(d.teq - 278.3) < 0.2, `S = ${d.insol.toFixed(4)} S_earth, T_eq = ${d.teq.toFixed(1)} K (278.3 K = 5772 sqrt(R_sun / 2 au))`);
  // Roche limit: a planet of density 1 g/cm^3 at its fluid Roche limit has P = sqrt(3 pi 2.44^3 / (G rho)) = 12.6 h (Rappaport et al. 2013)
  const rp = 7e7, mpKg = (4 / 3) * Math.PI * rp ** 3 * 1000, mp = mpKg / C.Msun, aR = 2.44 * rp * Math.cbrt(1 / mp), Pr = (2 * Math.PI * Math.sqrt(aR ** 3 / (C.GMsun * (1 + mp)))) / 86400;
  const r = deriveSystem({ rprs: rp / C.Rsun, ars: aR / C.Rsun, inc: 90, per: Pr, tmid: 0, ecc: 0, omega: 0 }, { rstar: 1, mstar: 1, teff: 5772, mplanet: mp / C.Mjup_Msun });
  check('Roche limit', Math.abs(r.rocheRatio - 1) < 1e-3 && Math.abs(Pr * 24 - 12.6) < 0.05, `a / a_Roche = ${r.rocheRatio.toFixed(5)} at the period ${(Pr * 24).toFixed(2)} h; 12.6 h (rho / 1 g cm^-3)^-1/2 in Rappaport et al. (2013)`);
}
{
  // orbit-averaged insolation: the time average of (a/r)^2 by quadrature of the orbit, against 1 / sqrt(1 - e^2)
  const p = { rprs: 0.1, ars: 94.64, inc: 89.269, per: 111.4367, tmid: 0, ecc: 0.93132, omega: -58.699 }, el = orbitElements(p), x = [0, 0, 0];
  let s = 0; const n = 400000; for (let i = 0; i < n; i++) { orbitPosition(el, (p.per * (i + 0.5)) / n, x); s += (p.ars * p.ars) / (x[0] * x[0] + (x[1] * x[1] + x[2] * x[2])); }
  const d = deriveSystem(p, { rstar: 1.066, mstar: 1.05, teff: 5574 });
  check('orbit-averaged insolation', rel(d.insolAvg / d.insol, s / n) < 1e-6, `HD 80606 b: <(a/r)^2> = ${(s / n).toFixed(6)} by quadrature over time, 1/sqrt(1 - e^2) = ${(d.insolAvg / d.insol).toFixed(6)}; T_eq ${d.teqApo.toFixed(0)} to ${d.teqPeri.toFixed(0)} K around the orbit`);
  // light-travel delay of the eclipse
  const c = deriveSystem({ rprs: 0.1, ars: (0.05 * C.AU) / C.Rsun, inc: 90, per: 4, tmid: 0, ecc: 0, omega: 0 }, { rstar: 1, mstar: 1, teff: 5772 });
  check('light-travel delay of mid-eclipse', Math.abs(c.lttEclipse - (0.1 * C.AU) / C.c) < 1e-6 && Math.abs(d.lttEclipse - lightTravelDelay({ ...p, rstar: 1.066 }) * 86400) < 1e-6, `2a/c = ${c.lttEclipse.toFixed(2)} s at 0.05 au; HD 80606 b ${d.lttEclipse.toFixed(1)} s (eclipse near periastron; 2a/c would be ${((2 * d.aAU * C.AU) / C.c).toFixed(0)} s)`);
  // eclipse duration: definitions
  const ev = eventTimes(p), eC = contactDuration(el, 1, ev.tecl);
  check('eclipse duration of HD 80606 b by definition', Math.abs(ev.e14 - 0.0835) < 2e-4 && ev.e23 < 0.0717 && eC > 0.0717, `first to fourth contact ${ev.e14.toFixed(4)} d, second to third ${ev.e23.toFixed(4)} d, planet centre on the limb ${eC.toFixed(4)} d; the paper's 0.0717 d lies between the last two and is none of them`);
}

// ---- summaries of angles ------------------------------------------------------------------------------------------
{
  const rng = makeRng(5), a = Array.from({ length: 20000 }, () => { let x = 175 + 6 * rng.normal(); if (x > 180) x -= 360; return x; });
  const plain = summarizeDraws(a), circ = summarizeDraws(a, { period: 360 });
  check('angle summary across the wrap', Math.abs(circ.med - 175) < 0.2 && Math.abs(circ.plus - 6) < 0.25 && Math.abs(circ.minus - 6) < 0.25, `omega = 175 ± 6 deg drawn, wrapped to (-180, 180]: ${circ.med.toFixed(2)} +${circ.plus.toFixed(2)} -${circ.minus.toFixed(2)}; plain quantiles give ${plain.med.toFixed(1)} +${plain.plus.toFixed(1)} -${plain.minus.toFixed(1)}`);
  const w = a.map((_, i) => (i % 2 ? 2 : 0.5)), cw = summarizeDraws(a, { period: 360, weights: w, lo: 0 });
  check('weighted, reported in [0, 360)', Math.abs(cw.med - 175) < 0.3, `${cw.med.toFixed(2)} +${cw.plus.toFixed(2)} -${cw.minus.toFixed(2)}`);
}

// ---- likelihood -----------------------------------------------------------------------------------------------------
const rng = makeRng(11);
{
  // sqrt(e) cos(omega), sqrt(e) sin(omega) in place of e, omega: the same likelihood
  const t = Float64Array.from({ length: 30 }, (_, i) => i * 0.37), base = { rprs: 0.1, ars: 12, inc: 88, per: 5, tmid: 0.3, K: 40, mstar: 1 };
  const e = 0.31, w = 137, v = Float64Array.from(t, () => 30 * rng.normal()), er = Float64Array.from(t, () => 4);
  const A = buildProblem({ data: null, rv: [{ t, v, e: er }], values: { ...base, ecc: e, omega: w }, ldLaw: 'quadratic', free: [] }).loglike([]);
  const pb = buildProblem({ data: null, rv: [{ t, v, e: er }], values: { ...base, ecc: 0, omega: 0 }, ldLaw: 'quadratic', free: [{ key: 'secosw', prior: { type: 'uniform', a: -1, b: 1 } }, { key: 'sesinw', prior: { type: 'uniform', a: -1, b: 1 } }] });
  const th = [Math.sqrt(e) * Math.cos(w * Math.PI / 180), Math.sqrt(e) * Math.sin(w * Math.PI / 180)], B = pb.loglike(th), q = pb.detail(th).planets[0];
  check('sqrt(e) cos w, sqrt(e) sin w give the same likelihood', Math.abs(A - B) < 1e-9 && Math.abs(q.ecc - e) < 1e-12 && Math.abs(q.omega - w) < 1e-9, `ln L ${A.toFixed(6)} and ${B.toFixed(6)}; e = ${q.ecc.toFixed(4)}, omega = ${q.omega.toFixed(2)} deg back; outside the unit circle ln L = ${pb.loglike([0.9, 0.9]).toExponential(0)}`);
  // prior implied by uniform (h, k) inside the unit circle: uniform in e (Monte Carlo against the analytic CDF)
  let n = 0, below = 0; for (let i = 0; i < 400000; i++) { const h = 2 * rng.next() - 1, k = 2 * rng.next() - 1, ee = h * h + k * k; if (ee < 1) { n++; if (ee < 0.3) below++; } }
  check('uniform priors on the two are uniform in e', Math.abs(below / n - 0.3) < 0.003 && Math.abs(n / 400000 - Math.PI / 4) < 0.003, `P(e < 0.3) = ${(below / n).toFixed(4)}; ${(100 * n / 400000).toFixed(1)}% of the square is inside e < 1, so ln Z is ${Math.log(4 / Math.PI).toFixed(3)} lower than with priors on e and omega`);
}
{
  // information criteria with a free jitter
  const t = Float64Array.from({ length: 40 }, (_, i) => i * 0.31), er = Float64Array.from(t, (_, i) => 2 + (i % 3)), v = Float64Array.from(t, (x, i) => 25 * Math.cos(Math.PI / 2 + (2 * Math.PI * x) / 5) + Math.hypot(er[i], 6) * rng.normal());
  const mk = (jit) => buildProblem({ data: null, rv: [{ t, v, e: er }], values: { rprs: 0.1, ars: 12, inc: 90, per: 5, tmid: 0, ecc: 0, omega: 0, K: 25, mstar: 1, 'jit@rv1': jit }, ldLaw: 'quadratic', free: [] }).detail([]);
  const d0 = mk(0), d6 = mk(6); let pen = 0; for (let i = 0; i < t.length; i++) pen += Math.log(1 + 36 / (er[i] * er[i]));
  // -2 ln L at the best zero point, written out: chi2 + sum ln(2 pi s^2)
  const m2 = (d, jit) => { let s = d.chi2; for (let i = 0; i < t.length; i++) s += Math.log(2 * Math.PI * (er[i] * er[i] + jit * jit)); return s; };
  check('BIC with a free jitter uses -2 ln L', Math.abs(d6.chi2ic - d6.chi2 - pen) < 1e-9 && d0.chi2ic === d0.chi2 && Math.abs((d6.chi2ic - d0.chi2ic) - (m2(d6, 6) - m2(d0, 0))) < 1e-9,
    `jitter 0 → 6 m/s: chi2 ${d0.chi2.toFixed(1)} → ${d6.chi2.toFixed(1)}, -2 ln L changes by ${(m2(d6, 6) - m2(d0, 0)).toFixed(2)} = chi2ic difference ${(d6.chi2ic - d0.chi2ic).toFixed(2)}; BIC from chi2 alone would favour the jitter by ${(d0.chi2 - d6.chi2 - Math.log(40)).toFixed(1)}, from -2 ln L by ${(infoCriteria(d0.chi2ic, 1, 40).bic - infoCriteria(d6.chi2ic, 2, 40).bic).toFixed(1)}`);
}
{
  // two planets with their own light: star x transits + sum of planet fluxes
  const ld = { ld0: 0.3, ld1: 0.2 }, vals = { rprs: 0.12, ars: 5, inc: 87, per: 1.3, tmid: 0, ecc: 0, omega: 0, fpfs: 0.05, contrast: 0, hotspot: 0, 'rprs@c': 0.08, 'ars@c': 9, 'inc@c': 88.5, 'per@c': 3.1, 'tmid@c': 0.4, 'ecc@c': 0, 'omega@c': 0, 'fpfs@c': 0.08, 'contrast@c': 0, 'hotspot@c': 0, ...ld };
  const t = Float64Array.from({ length: 600 }, (_, i) => -0.3 + i * 0.006), f = Float64Array.from(t, () => 1), e = Float64Array.from(t, () => 1e-4);
  const det = buildProblem({ data: { t, f, e }, values: vals, ldLaw: 'quadratic', planets: ['', 'c'], free: [] }).detail([]);
  const pb = makePhaseCurve({ rprs: 0.12, ars: 5, inc: 87, per: 1.3, tmid: 0, ecc: 0, omega: 0, fpfs: 0.05, contrast: 0, hotspot: 0, ldLaw: 'quadratic', ld: [0.3, 0.2] }), pc = makePhaseCurve({ rprs: 0.08, ars: 9, inc: 88.5, per: 3.1, tmid: 0.4, ecc: 0, omega: 0, fpfs: 0.08, contrast: 0, hotspot: 0, ldLaw: 'quadratic', ld: [0.3, 0.2] });
  let worst = 0, old = 0, oot = 0; const Db = 0.05 * 0.0144, Dc = 0.08 * 0.0064;
  for (let i = 0; i < t.length; i++) { const ref = pb.star(t[i]) * pc.star(t[i]) + pb.planet(t[i]) + pc.planet(t[i]); worst = Math.max(worst, Math.abs(det.model[i] - ref)); old = Math.max(old, Math.abs(pb(t[i]) * pc(t[i]) - ref)); if (pb(t[i]) === 1 + Db && pc(t[i]) === 1 + Dc) oot = Math.max(oot, Math.abs(det.model[i] - (1 + Db + Dc))); }
  check('several planets with their own light are added, not multiplied', worst < 1e-15 && oot < 1e-15, `model against star × transits + Σ planets: ${worst.toExponential(1)}; out of transit and eclipse 1 + D_b + D_c to ${oot.toExponential(1)}; the product of the two curves was off by up to ${(1e6 * old).toFixed(1)} ppm here (D_b D_c = ${(1e6 * Db * Dc).toFixed(2)} ppm, and each planet's light dimmed by the other's transit)`);
}
{
  // a mid-eclipse time with light-travel time switched on
  const vals = { rprs: 0.1, ars: 10.75, inc: 90, per: 4, tmid: 0, ecc: 0, omega: 0, rstar: 1, mstar: 1 }, te = Float64Array.of(2, 6), ee = Float64Array.of(1e-4, 1e-4);
  const mk = (ltt) => buildProblem({ data: null, timing: [{ planet: '', kind: 'eclipse', t: te, e: ee }], values: vals, ldLaw: 'quadratic', phase: { ltt }, free: [] }).detail([]).timing[0].model;
  const a = mk(false), b = mk(true), ref = (2 * 10.75 * C.Rsun) / C.c;
  check('mid-eclipse times include the light-travel delay when asked', a[0] === 2 && Math.abs((b[0] - a[0]) * 86400 - ref) < 1e-4, `superior conjunction ${a[0]} d; with phase.ltt ${((b[0] - a[0]) * 86400).toFixed(3)} s later, 2a/c = ${ref.toFixed(3)} s`);
}

// ---- sampler: funnels -----------------------------------------------------------------------------------------------
{
  const P0 = problems.find((p) => p.id === 'g-funnel-4d'), P = { ...P0, ...P0.make() }, n = Number(process.env.AUDIT_SEEDS || 12);
  let s = 0, s2 = 0, calls = 0, err = 0, grown = 0, worstP = 1;
  for (let seed = 1; seed <= n; seed++) {
    const ns = new MiniNest({ ndim: P.ndim, loglike: P.loglike, transform: P.transform, nlive: 400, seed, names: P.names });
    while (!ns.step(200)); const r = ns.result(), dz = r.logZ - P.truth.lnZ;
    s += dz; s2 += dz * dz; calls += r.ncalls; err += r.logZerr; grown += r.sampling.ellipsoidGrown; worstP = Math.min(worstP, r.insertionP);
  }
  const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m)), sem = sd / Math.sqrt(n);
  check("ln Z of Neal's funnel (4-D): mean error well inside the reported error", Math.abs(m) < 0.15 && sd < 1.6 * (err / n), `${n} seeds: mean error ${m.toFixed(3)} ± ${sem.toFixed(3)} against one-dimensional quadrature (48 seeds: -0.045 ± 0.026; before the change -0.24 ± 0.05 over 32 seeds; without any ellipsoid 0.005 ± 0.027), scatter ${sd.toFixed(3)}, reported ±${(err / n).toFixed(3)}, ${Math.round(calls / n).toLocaleString('en-US')} calls per run (164,000 before); the ellipsoid was enlarged ${(grown / n).toFixed(1)} times per run`);
}
// ---- epochs that repeat every period (second audit, 2026-11-16) ----------------------------------------------
{
  // HD 189733 b-like: e = 0.01 with omega anywhere in 70-110 deg; before the fix some draws put the eclipse at
  // tmid - P/2 and others at tmid + P/2, and the periastron at tmid or tmid - P, so the summary spanned a period
  const rng = makeRng(5).next, P = 2.2186, tm = 0.3, em = [], tp = [], want = [];
  for (let i = 0; i < 4000; i++) {
    const v = { per: P, tmid: tm, rprs: 0.155, ars: 8.8, inc: 85.7, ecc: 0.01, omega: 70 + 40 * rng() }, d = deriveSystem(v, { mstar: 0.8, rstar: 0.76, teff: 5050 });
    em.push(d.emid); tp.push(d.tperi); want.push(tm + P / 2 + (2 * P / Math.PI) * 0.01 * Math.cos(v.omega * Math.PI / 180));
  }
  const e = summarizeEpoch(em, 'emid', tm, P), t = summarizeEpoch(tp, 'tperi', tm, P), w0 = want.sort((a, b) => a - b)[2000];
  check('mid-eclipse posterior is one peak, the eclipse after the transit', Math.abs(e.med - w0) < 2e-4 && e.plus < 0.01 && e.minus < 0.01 && Math.min(...em) >= tm,
    `median ${e.med.toFixed(4)} +${e.plus.toFixed(4)} -${e.minus.toFixed(4)} d against tmid + P/2 + (2P/pi) e cos w = ${w0.toFixed(4)} (before: 1.4045 +0.0033 -2.2122)`);
  check('periastron epoch posterior is one peak before the transit', t.med < tm && t.med > tm - P && t.plus + t.minus < 0.5 * P,
    `median ${t.med.toFixed(3)} +${t.plus.toFixed(3)} -${t.minus.toFixed(3)} d (before: 0.180 +0.081 -2.059); omega 70-110 deg spans ${(40 / 360 * P).toFixed(3)} d`);
}
// ---- a free mass with a catalogue K also set (third review, 2026-11-16) -----------------------------------------------
{
  // a catalogue session carries both mplanet and K; with the mass free and K not, the velocities must follow the mass
  // (before, the fixed K won and the mass was sampled without changing the model: its posterior was the prior)
  const t = Array.from({ length: 40 }, (_, i) => i * 3), v = { per: 30, tmid: 0, ecc: 0, omega: 0, inc: 90, rprs: 0.1, ars: 30, mplanet: 1, K: 100, mstar: 1, ld0: 0, ld1: 0, ld2: 0, ld3: 0 };
  const K1 = semiAmplitude(30, 0, 90, 1, 1), rv = [{ name: 'a', t, v: t.map((x) => -K1 * Math.sin(2 * Math.PI * x / 30)), e: t.map(() => 1) }];
  const p = buildProblem({ values: v, free: [{ key: 'mplanet', prior: { type: 'uniform', a: 0, b: 10 } }], rv, ldLaw: 'nonlinear' });
  const at1 = p.loglike([1]), at2 = p.loglike([2]), pk = buildProblem({ values: v, free: [{ key: 'K', prior: { type: 'uniform', a: 0, b: 1000 } }], rv, ldLaw: 'nonlinear' });
  check('a free planet mass drives the velocities even when a fixed K is also given', at1 > at2 + 100 && Math.abs(pk.loglike([K1]) - at1) < 1e-6,
    `ln L at the true mass ${at1.toFixed(1)}, at twice it ${at2.toFixed(1)}; with K free instead the same ln L at K = ${K1.toFixed(2)} m/s`);
}
process.exit(ok ? 0 : 1);
