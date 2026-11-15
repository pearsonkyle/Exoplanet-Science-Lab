// Reproducing EXOTIC's examples (github.com/rzellem/EXOTIC, examples/) with ESL's core.
// Reference numbers come from EXOTIC and pylightcurve themselves: test/make_exotic_reference.py
// (models, chi2 on the example data, EXOTIC's stored fits) and test/make_exotic_fits.py (EXOTIC's
// fits of seeded single- and multiple-transit data). The example data sit in public/examples/.
import { readFileSync, existsSync } from 'node:fs';
import { buildProblem, jitterKey, planetKey, GAMMA_PRIOR_WIDTH } from '../src/core/model.js';
import { makeTransit } from '../src/core/transit.js';
import { makeRV, semiAmplitude, massFromK, arsFromKepler } from '../src/core/rv.js';
import { orbitElements, eclipseTime, orbitPosition } from '../src/core/kepler.js';
import { fitEphemeris } from '../src/core/ephemeris.js';
import { combineEpochs } from '../src/core/data.js';
import { runFit } from '../src/core/fitRunner.js';
import { weightedMeanStd, weightedQuantiles } from '../src/core/stats.js';
import { C } from '../src/core/derive.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const url = (p) => new URL(p, import.meta.url);
const R = JSON.parse(readFileSync(url('./exotic_reference.json')));
const csv = (p) => { const [head, ...rows] = readFileSync(url('../public/examples/' + p), 'utf8').trim().split(/\r?\n/); const names = head.split(','); return rows.map((r) => Object.fromEntries(r.split(',').map((c, i) => [names[i], Number.isNaN(Number(c)) ? c : Number(c)]))); };
const LD = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];
const post = (r, k) => weightedMeanStd(Float64Array.from({ length: r.n }, (_, i) => r.samples[i * r.ndim + k]), r.weights);
console.log('reference: ' + R.generator);

// ---- 1. models ------------------------------------------------------------------------------
{
  let worstT = 0, worstRV = 0, worstRVraw = 0, worstE = 0, worstA = 0, info = [];
  for (const [name, c] of Object.entries(R.models)) {
    const p = c.params, f = makeTransit({ ...p, ldLaw: 'nonlinear', ld: LD });
    let dT = 0; c.t_transit.forEach((t, i) => (dT = Math.max(dT, Math.abs(f(t) - c.transit[i]))));
    // EXOTIC scales the reflex motion by m_p/M*, the two-body value is m_p/(M* + m_p): compare shapes after removing that factor
    const K = semiAmplitude(p.per, p.ecc, p.inc, p.mplanet, p.mstar), rv = makeRV({ ...p, K }), fac = 1 + p.mplanet * C.Mjup_Msun / p.mstar;
    let dR = 0, dRraw = 0; c.t_rv.forEach((t, i) => { dR = Math.max(dR, Math.abs(rv(t) * fac - c.rv_fine[i]) / K); dRraw = Math.max(dRraw, Math.abs(rv(t) * fac - c.rv[i]) / K); });
    const el = orbitElements(p), dE = Math.abs(((eclipseTime(el) - c.emid) / p.per) - Math.round((eclipseTime(el) - c.emid) / p.per)) * p.per;
    const dA = Math.abs(arsFromKepler(p.per, p.mstar, p.mplanet, p.rstar) / p.ars - 1);
    worstT = Math.max(worstT, dT); worstRV = Math.max(worstRV, dR); worstRVraw = Math.max(worstRVraw, dRraw); worstE = Math.max(worstE, dE); worstA = Math.max(worstA, dA);
    info.push(`${name}: transit ${dT.toExponential(1)}, RV ${dR.toExponential(1)} K (${dRraw.toExponential(1)} K at EXOTIC's step), eclipse ${(dE * 86400).toFixed(1)} s`);
  }
  info.forEach((s) => console.log('   ' + s));
  check('transit model matches pylightcurve (Claret law, as EXOTIC calls it)', worstT < 2e-6, `max |Δflux| ${worstT.toExponential(1)} over 5 planets`);
  check('RV curve matches EXOTIC after its m_p/M* scaling', worstRV < 2e-5, `max ${worstRV.toExponential(1)} of K with a centred difference; ${worstRVraw.toExponential(1)} of K against EXOTIC's forward difference (dt = 1e-4 d)`);
  check('a/R* from Kepler matches EXOTIC', worstA < 2e-4, `max relative difference ${worstA.toExponential(1)} (constants)`);
  check('mid-eclipse time matches pylightcurve', worstE < 2e-4, `max ${(worstE * 86400).toFixed(1)} s`);
  // K: closed form against the numerical velocity of the planet along the line of sight
  // (times measured from near the transit: at Julian-date magnitudes a 1e-4 d step is only known to 5e-6 of itself)
  const p = { ...R.models['eccentric'].params, tmid: 0.2 }, el = orbitElements({ ...p, ars: arsFromKepler(p.per, p.mstar, p.mplanet, p.rstar) }), v = [0, 0, 0], h = 1e-4, K = semiAmplitude(p.per, p.ecc, p.inc, p.mplanet, p.mstar), rv = makeRV({ ...p, K });
  const mu = p.mplanet * C.Mjup_Msun / (p.mstar + p.mplanet * C.Mjup_Msun); let d = 0;
  for (let i = 0; i < 200; i++) { const t = p.tmid + (p.per * i) / 200; const z1 = orbitPosition(el, t + h, v)[2], z0 = orbitPosition(el, t - h, v)[2]; d = Math.max(d, Math.abs(((z1 - z0) / (2 * h)) * mu * p.rstar * C.Rsun / C.day - rv(t)) / K); }
  check('RV = mass ratio x line-of-sight velocity of the orbit used for transits', d < 1e-6, `max ${d.toExponential(1)} of K`);
  check('mass from K inverts K from mass', Math.abs(massFromK(K, p.per, p.ecc, p.inc, p.mstar) / p.mplanet - 1) < 1e-12);
  const toyK = Object.entries(R.toy.K).map(([k, Kx]) => { const q = R.models['toy ' + k].params; return semiAmplitude(q.per, q.ecc, q.inc, q.mplanet, q.mstar) * (1 + q.mplanet * C.Mjup_Msun / q.mstar) / Kx - 1; });
  check('toy semi-amplitudes (2.97, 6.05, 1.63 m/s)', toyK.every((x) => Math.abs(x) < 2e-4), toyK.map((x) => x.toExponential(1)).join(', '));
}
console.log(`   pylightcurve's eclipse_duration for HD 80606 b returns ${R.hd80606_durations.eclipse_duration.toExponential(1)} d (its solver fails at e = 0.93); published E14 is ${R.hd80606_durations.published.e14} d, so that routine is not where the published value came from`);

// ---- 2. three-planet toy (examples/multi_planet): EXOTIC's chi2 at the injected truth ---------
const toySys = JSON.parse(readFileSync(url('../public/examples/toy1873/multi_system.json')));
const TREF = 2459000;
const lcs = ['b', 'c', 'd'].map((k) => { const r = csv(`toy1873/tess_${k}.csv`); return { name: 'tess_' + k, tRef: TREF, t: Float64Array.from(r, (x) => x.BJD - TREF), f: Float64Array.from(r, (x) => x.flux), e: Float64Array.from(r, (x) => x.ferr), airmass: null }; });
const toyLC = combineEpochs(lcs);
const rvRows = csv('toy1873/rv_neid.csv'), toyRV = { name: 'NEID', t: Float64Array.from(rvRows, (x) => x.BJD - TREF), v: Float64Array.from(rvRows, (x) => x.vel), e: Float64Array.from(rvRows, (x) => x.velerr) };
const toyValues = { mstar: 1.02, rstar: 0.974, ld0: LD[0], ld1: LD[1], ld2: LD[2], ld3: LD[3], rvlin: toySys.trend.rv_linear, [jitterKey(0)]: toySys.noise.rv_jitter };
['b', 'c', 'd'].forEach((k, i) => { const p = toySys.planets[k], s = i ? k : ''; for (const fld of ['rprs', 'per', 'inc', 'ecc', 'omega', 'mplanet']) toyValues[planetKey(fld, s)] = p[fld]; toyValues[planetKey('tmid', s)] = p.tmid - TREF; });
const toySpec = (free = [], values = {}) => ({ data: toyLC, rv: [toyRV], values: { ...toyValues, ...values }, planets: ['', 'c', 'd'], kepler: true, ldLaw: 'nonlinear', free, exptime: 0, supersample: 1 });
{
  const prob = buildProblem(toySpec()), det = prob.detail([]);
  // chi2 of each light-curve file with its own normalisation (ESL's weighted optimum against EXOTIC's plain mean of flux/model)
  const per = [0, 1, 2].map((s) => { let c = 0; for (let i = 0; i < toyLC.t.length; i++) if (toyLC.epoch[i] === s) c += ((toyLC.f[i] - det.base[i] * det.transit[i]) / toyLC.e[i]) ** 2; return c; });
  const refLC = ['tess_b', 'tess_c', 'tess_d'].map((k) => R.toy.lc[k]);
  check('toy light curves: chi2 at the truth matches EXOTIC', per.every((c, s) => Math.abs(refLC[s].chi2 - c) < 0.02) && Math.abs(det.chi2lc - per.reduce((a, b) => a + b)) < 1e-6, per.map((c, s) => `${c.toFixed(2)} vs ${refLC[s].chi2.toFixed(2)} (N ${refLC[s].n})`).join(', '));
  check('toy flux scales match', det.a1s.every((a, s) => Math.abs(a - refLC[s].scale) < 2e-5), det.a1s.map((a) => a.toFixed(6)).join(', '));
  check('toy RV: chi2 and zero point at the truth match EXOTIC', Math.abs(det.chi2rv - R.toy.rv.chi2) < 0.02 && Math.abs(det.rv[0].gamma - R.toy.rv.offset) < 0.01, `chi2 ${det.chi2rv.toFixed(2)} vs ${R.toy.rv.chi2.toFixed(2)} (N ${R.toy.rv.n}), offset ${det.rv[0].gamma.toFixed(3)} vs ${R.toy.rv.offset.toFixed(3)} m/s`);
  let dm = 0; R.toy.rv.model.forEach((m, i) => (dm = Math.max(dm, Math.abs(det.rv[0].model[i] - m))));
  check('toy RV model (three planets + trend) matches point by point', dm < 2e-3, `max ${dm.toExponential(1)} m/s (the m_p/M* factor is 1e-4 of 6 m/s)`);
  check('problem bookkeeping', prob.ndata === 368 && prob.nrv === 1 && prob.ntotal === 408 && prob.nlinear === 4 && det.transits.length === 3 && det.planets.length === 3);
  // the RV zero point integrated out analytically, against Simpson's rule over gamma
  const s2 = Array.from(toyRV.e, (x) => x * x + toySys.noise.rv_jitter ** 2), res = Array.from(toyRV.v, (x, i) => x - det.rv[0].model[i]);
  const lnp = (g) => res.reduce((a, r, i) => a - 0.5 * (r - g) ** 2 / s2[i] - 0.5 * Math.log(2 * Math.PI * s2[i]), 0);
  const g0 = det.rv[0].gamma, sg = 1 / Math.sqrt(s2.reduce((a, x) => a + 1 / x, 0)), n = 4000, h = (24 * sg) / n, ref = lnp(g0); let sum = 0;
  for (let j = 0; j <= n; j++) sum += (j === 0 || j === n ? 1 : j % 2 ? 4 : 2) * Math.exp(lnp(g0 - 12 * sg + j * h) - ref);
  const lnRV = ref + Math.log((sum * h) / 3 / GAMMA_PRIOR_WIDTH), lnLC = buildProblem({ ...toySpec(), rv: [] }).loglike([]);
  check('RV zero point marginalised: ln L matches quadrature', Math.abs(det.lnL - lnLC - lnRV) < 1e-7, `difference ${(det.lnL - lnLC - lnRV).toExponential(1)}`);
}

// ---- 3. the toy joint fit, as examples/multi_planet/multi_fit.py runs it by default -----------
{
  const b = toySys.bounds, free = [
    { key: 'mplanet', prior: { type: 'uniform', a: 0, b: b.b.mplanet[1] } }, { key: 'rvlin', prior: { type: 'uniform', a: -0.1, b: 0.1 } },
    { key: 'mplanet@c', prior: { type: 'uniform', a: 0, b: b.c.mplanet[1] } }, { key: 'mplanet@d', prior: { type: 'uniform', a: 0, b: b.d.mplanet[1] } },
    { key: jitterKey(0), prior: { type: 'uniform', a: 0, b: 15 } }];
  const r = await runFit({ ...toySpec(free), sampler: { nlive: 400, seed: 3 } }, () => {}, () => false);
  const E = R.toy.exotic_fit, names = ['b_mplanet', 'b_rv_linear', 'c_mplanet', 'd_mplanet', 'rv_neid_rv_jitter'], truth = [toySys.planets.b.mplanet, toySys.trend.rv_linear, toySys.planets.c.mplanet, toySys.planets.d.mplanet, toySys.noise.rv_jitter];
  console.log(`   ESL: ${r.ncalls} calls, ${r.elapsed.toFixed(1)} s, ${r.stopReason}, lnZ ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}; EXOTIC used ${E.ncall} calls`);
  let okTruth = true, okWidth = true, okBest = true; const lines = [];
  names.forEach((nm, k) => {
    const [m, s] = post(r, k), eb = E.parameters[nm], es = E.errors[nm];
    lines.push(`${nm}: ESL ${m.toPrecision(4)} ± ${s.toPrecision(3)} (best ${r.maxPoint[k].toPrecision(4)}) | EXOTIC best ${eb.toPrecision(4)} ± ${es.toPrecision(3)} | truth ${truth[k].toPrecision(4)}`);
    if (Math.abs(m - truth[k]) > 3 * s) okTruth = false;
    if (Math.abs(s / es - 1) > 0.15) okWidth = false;
    if (Math.abs(r.maxPoint[k] - eb) > 0.5 * es) okBest = false;
  });
  lines.forEach((s) => console.log('   ' + s));
  check('toy joint fit: injected values recovered within 3σ', okTruth);
  check('toy joint fit: posterior widths match EXOTIC within 15%', okWidth);
  check('toy joint fit: best-fit point within 0.5σ of EXOTIC', okBest);
  // planet d's semi-amplitude was injected below the jitter: it should come back as an upper limit
  const [md, sd] = post(r, 3), p = toySys.planets.d, col = Float64Array.from({ length: r.n }, (_, i) => r.samples[i * r.ndim + 3]);
  const [q3, q95] = weightedQuantiles(col, r.weights, [0.00135, 0.95]), Kof = (m) => semiAmplitude(p.per, 0, p.inc, m, 1.02);
  check('outer planet is an upper limit, not a detection', md / sd < 3 && Kof(q3) < 0.2 && Kof(md) < 1.2 * toySys.noise.rv_jitter, `K_d = ${Kof(md).toFixed(2)} m/s (${(md / sd).toFixed(1)}σ from zero; injected ${Kof(p.mplanet).toFixed(2)}, jitter ${toySys.noise.rv_jitter}); 95% upper limit ${Kof(q95).toFixed(2)} m/s`);
}

// ---- 4. ephemeris example (examples/ephemeris/fit_ephemeris.py): statsmodels WLS --------------
{
  const e = R.ephemeris, f = fitEphemeris(e.orbit, e.tmid, e.err, 1), w = e.wls;
  check('ephemeris example: weighted least squares of 40 times', Math.abs(f.t0 - w.T0) < 1e-3 * w.T0_err + 1e-9 && Math.abs(f.per - w.P) < 1e-4 * w.P_err && Math.abs(f.err.t0 / w.T0_err - 1) < 1e-6 && Math.abs(f.err.per / w.P_err - 1) < 1e-6,
    `T0 ${f.t0.toFixed(6)} ± ${f.err.t0.toFixed(6)}, P ${f.per.toFixed(9)} ± ${f.err.per.toExponential(3)} (statsmodels: ${w.T0.toFixed(6)} ± ${w.T0_err.toFixed(6)}, ${w.P.toFixed(9)} ± ${w.P_err.toExponential(3)})`);
  const keep = e.tmid.map((t, i) => Math.abs((t - f.model(e.orbit[i])) / e.err[i]) < 3), pick = (a) => a.filter((_, i) => keep[i]), f2 = fitEphemeris(pick(e.orbit), pick(e.tmid), pick(e.err), 1), w2 = e.wls_clipped;
  check('ephemeris example: after its 3σ clip', keep.filter(Boolean).length === e.kept && Math.abs(f2.per - w2.P) < 1e-4 * w2.P_err && Math.abs(f2.err.per / w2.P_err - 1) < 1e-6, `${e.kept} of 40 kept; P ${f2.per.toFixed(9)} ± ${f2.err.per.toExponential(3)}; chi2/dof before the clip ${(f.chi2 / f.dof).toFixed(1)}`);
}

// ---- 5. single transit (examples/single_transit): EXOTIC's lc_fitter on the same seeded data ---
const FITS = existsSync(url('./exotic_fits.json')) ? JSON.parse(readFileSync(url('./exotic_fits.json'))) : null;
const median = (a) => Float64Array.from(a).sort()[a.length >> 1];
if (FITS && FITS.single) {
  // (EXOTIC's fitter overwrites its prior dict with the best fit, so the injected values are restated here)
  const X = FITS.single, pr = { ...X.prior, rprs: 0.02, tmid: 0.75, inc: 88.5 }, med = median(X.flux);
  const data = { t: Float64Array.from(X.t), f: Float64Array.from(X.flux, (x) => x / med), e: Float64Array.from(X.err, (x) => x / med), airmass: null };
  const free = Object.entries(X.bounds).map(([key, b]) => ({ key, prior: { type: 'uniform', a: Math.max(b[0], 1e-4), b: b[1] } }));
  const r = await runFit({ data, values: { ...pr, ld0: pr.u0, ld1: pr.u1, ld2: pr.u2, ld3: pr.u3 }, ldLaw: 'nonlinear', free, exptime: 0, supersample: 1, sampler: { nlive: 400, seed: 5 } }, () => {}, () => false);
  let good = true; const lines = [];
  free.forEach((f, k) => { const [m, sd] = post(r, k), em = X.posterior_mean[f.key], es = X.errors[f.key]; lines.push(`${f.key}: ESL ${m.toPrecision(6)} ± ${sd.toPrecision(3)} | EXOTIC ${em.toPrecision(6)} ± ${es.toPrecision(3)} | truth ${pr[f.key]}`); if (Math.abs(m - em) > 0.25 * es || Math.abs(sd / es - 1) > 0.15 || Math.abs(m - pr[f.key]) > 3 * sd) good = false; });
  lines.forEach((x) => console.log('   ' + x));
  check('single transit: posterior matches EXOTIC (means within 0.25σ, widths within 15%) and the truth', good, `ESL ${r.ncalls} calls in ${r.elapsed.toFixed(1)} s, EXOTIC ${X.ncall} calls in ${X.seconds.toFixed(0)} s`);
} else console.log('info  test/exotic_fits.json missing: single and multiple transit comparisons skipped (run test/make_exotic_fits.py)');

// ---- 6. several transits with airmass (examples/multiple_transit): EXOTIC's glc_fitter ---------
if (FITS && FITS.multiple) {
  const X = FITS.multiple, tr = X.truth;
  const data = combineEpochs(X.sets.map((d, i) => { const med = median(d.flux); return { name: 'epoch ' + d.epoch, tRef: 0, t: Float64Array.from(d.t), f: Float64Array.from(d.flux, (x) => x / med), e: Float64Array.from(d.err, (x) => x / med), airmass: Float64Array.from(d.airmass) }; }));
  const free = [...Object.entries(X.bounds).map(([key, b]) => ({ key, prior: { type: 'uniform', a: Math.max(b[0], 1e-4), b: b[1] } })), ...X.sets.map((_, i) => ({ key: 'a2@' + (i + 1), prior: { type: 'uniform', a: -0.75, b: 0.25 } }))];
  const values = { ...tr, ecc: 0, omega: 0, ld0: tr.ld[0], ld1: tr.ld[1], ld2: tr.ld[2], ld3: tr.ld[3] };
  const r = await runFit({ data, values, ldLaw: 'nonlinear', free, exptime: 0, supersample: 1, sampler: { nlive: 400, seed: 6 } }, () => {}, () => false);
  // EXOTIC's parameter order: globals, then local_<n>_a2
  const ex = Object.fromEntries(X.paramnames.map((nm, i) => [nm, [X.posterior_mean[i], X.posterior_stdev[i]]]));
  let good = true, worstM = 0, worstS = 0; const lines = [];
  free.forEach((f, k) => {
    const [m, sd] = post(r, k), nm = f.key.startsWith('a2@') ? `local_a2_${Number(f.key.slice(3)) - 1}` : f.key, [em, es] = ex[nm];
    const truth = f.key.startsWith('a2@') ? X.sets[Number(f.key.slice(3)) - 1].a2 : tr[f.key];
    worstM = Math.max(worstM, Math.abs(m - em) / es); worstS = Math.max(worstS, Math.abs(sd / es - 1));
    if (k < 4) lines.push(`${f.key}: ESL ${m.toPrecision(7)} ± ${sd.toPrecision(3)} | EXOTIC ${em.toPrecision(7)} ± ${es.toPrecision(3)} | truth ${truth}`);
    if (Math.abs(m - truth) > 3.5 * sd) good = false;
  });
  lines.forEach((x) => console.log('   ' + x));
  check('multiple transits: every parameter within 3.5σ of the truth', good);
  check('multiple transits: posterior matches EXOTIC (9 parameters)', worstM < 0.3 && worstS < 0.2, `largest mean difference ${worstM.toFixed(2)}σ, largest width difference ${(100 * worstS).toFixed(0)}%; ESL ${r.ncalls} calls in ${r.elapsed.toFixed(1)} s, EXOTIC ${X.ncall} calls in ${X.seconds.toFixed(0)} s`);
}

// ---- 7. HD 80606 b (examples/radial_velocity, examples/joint_rv_transit; Pearson et al. 2022) ---
{
  const T0 = 2458887, rows = csv('hd80606/HD80606_RV.csv'), seen = new Set(), sets = new Map();
  for (const r of rows) {                                   // as joint_fit.py: drop duplicate dates, split HRS by error bar
    if (seen.has(r.BJD)) continue; seen.add(r.BJD);
    const name = r.Telescope === 'HRS' ? (r['ErrVel(m/s)'] < 5 ? 'HRS_1' : 'HRS_2') : r.Telescope;
    if (!sets.has(name)) sets.set(name, []); sets.get(name).push(r);
  }
  const rv = [...sets.entries()].map(([name, rr]) => ({ name, t: Float64Array.from(rr, (x) => x.BJD - T0), v: Float64Array.from(rr, (x) => x['Vel(m/s)']), e: Float64Array.from(rr, (x) => x['ErrVel(m/s)']) }));
  const J = R.hd80606_joint, refN = Object.fromEntries(J.rv_datasets.map((d) => [d.name, d.n]));
  check('HD 80606 velocities: same seven datasets as EXOTIC', rv.length === 7 && rv.every((d) => refN[d.name] === d.t.length), rv.map((d) => `${d.name} ${d.t.length}`).join(', '));
  const lcRows = readFileSync(url('../public/examples/hd80606/2458888_08_lightcurve.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map(Number));
  const lc = { t: Float64Array.from(lcRows, (x) => x[0] - T0), f: Float64Array.from(lcRows, (x) => x[1]), e: Float64Array.from(lcRows, (x) => x[2]), airmass: null };
  const values = { rprs: 0.1, per: 111.4367, inc: 89.269, ecc: 0.93132, omega: -58.699, tmid: 2458888.0757 - T0, mplanet: 4.20, mstar: 1.05, rstar: 1.05, ld0: LD[0], ld1: LD[1], ld2: LD[2], ld3: LD[3] };
  const U = (key, a, b) => ({ key, prior: { type: 'uniform', a, b } });

  // (a) velocities alone, the four parameters and bounds of rv_example.py
  const rvFree = [U('per', 111.3, 111.5), U('omega', -65, -55), U('ecc', 0.92, 0.94), U('mplanet', 3, 4.5)];
  const ra = await runFit({ data: null, rv, values, kepler: true, ldLaw: 'nonlinear', free: rvFree, sampler: { nlive: 400, seed: 8 } }, () => {}, () => false);
  const pa = Object.fromEntries(rvFree.map((f, k) => [f.key, post(ra, k)]));
  const best = buildProblem({ data: null, rv, values: { ...values, ...Object.fromEntries(rvFree.map((f, k) => [f.key, ra.maxPoint[k]])) }, kepler: true, ldLaw: 'nonlinear', free: [] }), bd = best.detail([]);
  const Ka = semiAmplitude(pa.per[0], pa.ecc[0], values.inc, pa.mplanet[0], 1.05);
  console.log(`   RV only: ${ra.ncalls} calls, ${ra.elapsed.toFixed(1)} s, ${ra.stopReason}; chi2 ${bd.chi2rv.toFixed(0)} for ${best.ntotal} velocities`);
  console.log('   ' + rvFree.map((f) => `${f.key} ${pa[f.key][0].toPrecision(8)} ± ${pa[f.key][1].toPrecision(2)}`).join(', ') + `, K ${Ka.toFixed(2)} m/s`);
  console.log('   zero points: ' + rv.map((d, i) => `${d.name} ${bd.rv[i].gamma.toFixed(1)} (EXOTIC ${J.offsets[d.name + '_offset'][0].toFixed(1)})`).join(', '));
  // published: K = 469.22 m/s, e = 0.93183, omega = -58.887 deg, P = 111.436765 d (Table 7); EXOTIC's stored joint fit is the other reference
  check('HD 80606 RV only: K, e, omega and P against the paper and EXOTIC', Math.abs(Ka - 469.22) < 5 && Math.abs(pa.ecc[0] - 0.93183) < 0.002 && Math.abs(pa.omega[0] + 58.887) < 0.5 && Math.abs(pa.per[0] - 111.436765) < 0.002,
    `K ${Ka.toFixed(1)} (paper 469.2, EXOTIC ${J.parameters.K.toFixed(1)}), e ${pa.ecc[0].toFixed(5)} (0.93183, ${J.parameters.ecc.toFixed(5)}), ω ${pa.omega[0].toFixed(3)} (−58.887, ${J.parameters.omega.toFixed(3)}), P ${pa.per[0].toFixed(5)} (111.436765, ${J.parameters.per.toFixed(6)})`);
  check('HD 80606 RV only: instrument zero points match EXOTIC', rv.every((d, i) => Math.abs(bd.rv[i].gamma - J.offsets[d.name + '_offset'][0]) < Math.max(3, 4 * J.offsets[d.name + '_offset'][1])));

  // (b) transit + velocities + mid-transit and mid-eclipse times, as joint_fit.py
  const tm = [[2455210.6420, 0.004], [2454987.7842, 0.0049], [2459556.6942, 0.0035], [2455210.6502, 0.0064]], noise = tm.reduce((a, x) => a + x[1], 0) / tm.length / 2;
  const timing = [{ planet: '', kind: 'transit', t: tm.map((x) => x[0] - T0), e: tm.map((x) => x[1] + noise) },     // EXOTIC adds its noise term to sigma linearly
    { planet: '', kind: 'eclipse', t: [2454424.736 - T0], e: [0.00025] }];
  // as joint_fit.py: the velocity-only posterior, widened to ± 5σ, bounds the parameters the velocities constrain
  const w5 = (k) => U(k, pa[k][0] - 5 * pa[k][1], pa[k][0] + 5 * pa[k][1]);
  const free = [w5('per'), U('tmid', values.tmid - 0.2, values.tmid + 0.2), U('inc', 87, 90), w5('omega'), w5('ecc'), w5('mplanet'), U('rprs', 0.01, 0.2)];
  const rj = await runFit({ data: lc, rv, timing, values, kepler: true, ldLaw: 'nonlinear', free, exptime: 2 / 1440, supersample: 1, sampler: { nlive: 400, seed: 9 } }, () => {}, () => false);
  const pj = Object.fromEntries(free.map((f, k) => [f.key, post(rj, k)]));
  const jb = buildProblem({ data: lc, rv, timing, values: { ...values, ...Object.fromEntries(free.map((f, k) => [f.key, rj.maxPoint[k]])) }, kepler: true, ldLaw: 'nonlinear', free: [], exptime: 0, supersample: 1 }), jd = jb.detail([]);
  const Kj = semiAmplitude(pj.per[0], pj.ecc[0], pj.inc[0], pj.mplanet[0], 1.05), ars = arsFromKepler(pj.per[0], 1.05, pj.mplanet[0], 1.05);
  console.log(`   joint: ${rj.ncalls} calls, ${rj.elapsed.toFixed(1)} s, ${rj.stopReason}, lnZ ${rj.logZ.toFixed(1)} ± ${rj.logZerr.toFixed(1)}; chi2 light curve ${jd.chi2lc.toFixed(0)}/${lc.t.length}, velocities ${jd.chi2rv.toFixed(0)}/${jb.ntotal - lc.t.length - 5}, timing ${jd.chi2tim.toFixed(1)}/5`);
  const ref = { per: [111.436765, 'P'], inc: [89.24, 'i'], ecc: [0.93183, 'e'], omega: [-58.887, 'ω'], tmid: [2458888.07466 - T0, 'T mid − 2458887'], mplanet: [4.1641, 'Mp'], rprs: [null, 'Rp/R★'] };
  free.forEach((f) => console.log(`   ${ref[f.key][1]}: ESL ${pj[f.key][0].toPrecision(9)} ± ${pj[f.key][1].toPrecision(2)} | EXOTIC ${(J.parameters[f.key] - (f.key === 'tmid' ? T0 : 0)).toPrecision(9)} ± ${J.errors[f.key].toPrecision(2)}` + (ref[f.key][0] !== null ? ` | paper ${ref[f.key][0]}` : '')));
  console.log(`   derived: K ${Kj.toFixed(2)} m/s (paper 469.22, EXOTIC ${J.parameters.K.toFixed(2)}), a/R★ ${ars.toFixed(3)} (paper 94.452, EXOTIC ${J.parameters.ars.toFixed(3)})`);
  const d = (k, x) => Math.abs(pj[k][0] - x);
  check('HD 80606 joint fit against Pearson et al. (2022) Table 7', d('per', 111.436765) < 5e-4 && d('inc', 89.24) < 0.03 && d('ecc', 0.93183) < 0.001 && d('omega', -58.887) < 0.25 && d('tmid', 2458888.07466 - T0) < 0.004 && Math.abs(Kj - 469.22) < 3 && Math.abs(ars - 94.452) < 0.15,
    'P within 5e-4 d, i within 0.03°, e within 0.001, ω within 0.25°, T mid within 0.004 d, K within 3 m/s, a/R★ within 0.15');
  check('HD 80606 joint fit against EXOTIC\'s stored fit', d('per', J.parameters.per) < 5e-4 && d('inc', J.parameters.inc) < 0.03 && d('ecc', J.parameters.ecc) < 0.001 && d('omega', J.parameters.omega) < 0.25 && d('tmid', J.parameters.tmid - T0) < 0.004 && d('rprs', J.parameters.rprs) < 0.002,
    `Rp/R★ ${pj.rprs[0].toFixed(4)} vs ${J.parameters.rprs.toFixed(4)}; mass ${pj.mplanet[0].toFixed(3)} vs ${J.parameters.mplanet.toFixed(3)} M Jup (EXOTIC's m_p/M* scaling makes its mass ${(100 * J.parameters.mplanet * C.Mjup_Msun / 1.05).toFixed(2)}% lower for the same K)`);
}
process.exit(ok ? 0 : 1);
