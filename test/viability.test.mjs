// Physical-viability priors (src/core/physical.js, spec.physical in buildProblem).
//   1. Gladman (1993) eq. 21 against a numpy transcription (test/make_viability_reference.py) on 200 random pairs, and its
//      circular limit against 2 sqrt(3) mutual Hill radii (the analytic small-mass limit) and scipy's root.
//   2. Laskar & Petit (2017) critical AMD and beta against a numpy/brentq implementation on 100 random systems.
//   3. Known cases: two Jupiters around a Sun 3.0 and 4.0 mutual Hill radii apart (Hill unstable / stable), crossing and
//      Roche cases, and a short MEGNO screen on a regular and a chaotic pair.
//   4. Evidence bookkeeping: with a flat likelihood, ln Z of the sampler equals ln V, the prior mass the crossing test
//      leaves, and V from physicalPriorVolume matches the analytic area.
//   5. What each test does to ln Z and to the eccentricities of a two-planet velocity fit (printed numbers).
import { readFileSync } from 'node:fs';
import { gladmanMargin, mutualHillRadius, amdStability, makePhysicalCheck, physicalPriorVolume } from '../src/core/physical.js';
import { buildProblem } from '../src/core/model.js';
import { runFit } from '../src/core/fitRunner.js';
import { makeRV, semiAmplitude } from '../src/core/rv.js';
import { makeRng, weightedQuantiles } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const R = JSON.parse(readFileSync(new URL('./viability_reference.json', import.meta.url)));

// ---- 1. Gladman
{
  let w = 0, flips = 0;
  for (const c of R.gladman) { const m = gladmanMargin(c.mu1, c.mu2, c.a1, c.a2, c.e1, c.e2); w = Math.max(w, Math.abs(m - c.margin) / Math.max(1, Math.abs(c.margin))); if ((m > 0) !== (c.margin > 0)) flips++; }
  check('Gladman (1993) eq. 21 against numpy, 200 random eccentric pairs', w < 1e-12 && flips === 0, `largest relative difference ${w.toExponential(1)}; ${R.gladman.filter((c) => c.margin > 0).length} stable, none classified differently`);
  const rows = [];
  let wA = 0;
  for (const c of R.circular) {
    let lo = 1 + 1e-9, hi = 3; for (let i = 0; i < 200; i++) { const mid = 0.5 * (lo + hi); if (gladmanMargin(c.mu1, c.mu2, 1, mid) > 0) hi = mid; else lo = mid; }
    const a2 = 0.5 * (lo + hi), dh = (a2 - 1) / mutualHillRadius(c.mu1, c.mu2, 1, a2);
    wA = Math.max(wA, Math.abs(a2 - c.a2_crit)); rows.push(`μ ${c.mu1.toExponential(0)}: ${dh.toFixed(4)}`);
  }
  const d7 = Math.abs(R.circular[0].delta_hill - 2 * Math.sqrt(3)), d3 = Math.abs(R.circular[4].delta_hill - 2 * Math.sqrt(3));
  check('circular limit: critical separation in mutual Hill radii tends to 2√3 = 3.4641 as the masses go to 0', wA < 1e-12 && d7 < 1e-3 && d3 > d7, `${rows.join(', ')} (scipy's root to ${wA.toExponential(0)})`);
}

// ---- 2. AMD
{
  let wb = 0, wc = 0, flips = 0;
  for (const s of R.amd) {
    const r = amdStability(s.m.map((m, k) => ({ m, a: s.a[k], e: s.e[k] })));
    wc = Math.max(wc, Math.abs(r.amd - s.amd) / s.amd, Math.abs(r.betaStar - s.beta_star) / s.beta_star);
    r.pairs.forEach((p, k) => { wb = Math.max(wb, Math.abs(p.beta - s.pairs[k].beta) / s.pairs[k].beta, Math.abs(p.Cc - s.pairs[k].Cc) / s.pairs[k].Cc); });
    if (r.stable !== s.stable) flips++;
  }
  check('Laskar & Petit (2017) AMD, critical AMD and beta against numpy/brentq, 100 systems of 2 to 4 planets', wb < 1e-9 && wc < 1e-12 && flips === 0, `largest relative difference ${wb.toExponential(1)} (C_c, beta), ${wc.toExponential(1)} (AMD); ${R.amd.filter((s) => s.stable).length} AMD-stable, none classified differently`);
}

// ---- 3. known cases
{
  const MJ = 9.5459426398e-4, G = 2.959122082855911e-4, perOf = (a) => 2 * Math.PI * Math.sqrt(a ** 3 / (G * (1 + MJ)));
  // two Jupiters, a1 = 1 au; a2 at 3.0 and 4.0 mutual Hill radii (R_H = ((2 MJ)/3)^(1/3) (a1 + a2)/2 solved for a2)
  const aAt = (D) => { const k = Math.cbrt((2 * MJ) / 3) / 2; return (1 + D * k) / (1 - D * k); };
  const chk = makePhysicalCheck({ hill: true });
  const sys = (D, e2 = 0) => [{ per: perOf(1), ecc: 0, mplanet: 1 }, { per: perOf(aAt(D)), ecc: e2, mplanet: 1 }];
  check('two Jupiters around a Sun, circular: 3.0 mutual Hill radii apart rejected, 4.0 accepted (Gladman: 2√3 = 3.46)', chk(sys(3.0), 1) === 'hill' && chk(sys(4.0), 1) === null);
  check('the same pair 4.0 R_H apart is Hill stable with e_out = 0.10 and unstable with 0.12 (eccentricity shrinks the margin)', chk(sys(4.0, 0.1), 1) === null && chk(sys(4.0, 0.12), 1) === 'hill', `margin ${gladmanMargin(MJ, MJ, 1, aAt(4), 0, 0).toExponential(2)} circular, ${gladmanMargin(MJ, MJ, 1, aAt(4), 0, 0.1).toExponential(2)} at e = 0.10, ${gladmanMargin(MJ, MJ, 1, aAt(4), 0, 0.12).toExponential(2)} at 0.12`);
  const cross = makePhysicalCheck({ crossing: true });
  check('crossing: P = 10 and 15 d (a ratio 1.3104; limit e_out < 1 - 1.2 / 1.3104 = 0.0843 for e_in = 0.2) allows e_out = 0.08, not 0.09', cross([{ per: 10, ecc: 0.2 }, { per: 15, ecc: 0.08 }], 1) === null && cross([{ per: 10, ecc: 0.2 }, { per: 15, ecc: 0.09 }], 1) === 'crossing');
  const spc = makePhysicalCheck({ hillSpacing: 10 });
  check('hillSpacing 10: two Jupiters 8 R_H apart rejected, 12 accepted', spc(sys(8), 1) === 'hillSpacing' && spc(sys(12), 1) === null);
  // Roche: Rp/R* = 0.1, Mp = 1 MJ around 1 M_sun: f Rp (M*/Mp)^(1/3) = 2.16 x 0.1 x 10.16 = 2.195 R*
  const ro = makePhysicalCheck({ roche: true }), lim = 2.16 * 0.1 * Math.cbrt(1 / MJ);
  check(`Roche: periastron at 2.1 R* rejected, 2.3 R* accepted (limit 2.16 Rp (M*/Mp)^(1/3) = ${lim.toFixed(3)} R*); 1.05 R* is inside the star`, ro([{ per: 1, ecc: 0, ars: 2.1, rprs: 0.1, mplanet: 1 }], 1) === 'roche' && ro([{ per: 1, ecc: 0, ars: 2.3, rprs: 0.1, mplanet: 1 }], 1) === null && ro([{ per: 1, ecc: 0, ars: 1.05, rprs: 0.1, mplanet: 1 }], 1) === 'surface');
  const t0 = performance.now(), mg = makePhysicalCheck({ megno: { orbits: 200, max: 2.5 } });
  const regular = mg([{ per: 10, ecc: 0, mplanet: 1, tmid: 0 }, { per: 30, ecc: 0, mplanet: 1, tmid: 3 }], 1), chaotic = mg(sys(3.0, 0.05).map((q, i) => ({ ...q, tmid: i * 50 })), 1);
  check('MEGNO screen (200 outer orbits): well separated Jupiters at 10 and 30 d pass, two Jupiters 3 R_H apart fail', regular === null && chaotic === 'megno', `${((performance.now() - t0) / 1000).toFixed(1)} s for both`);
}

// ---- 4. evidence bookkeeping with a flat likelihood
const flatSpec = (physical) => ({ data: null, rv: [], timing: [], planets: ['', 'c'], values: { per: 10, 'per@c': 15, tmid: 0, 'tmid@c': 0, inc: 90, 'inc@c': 90, mstar: 1 }, ldLaw: 'quadratic',
  free: [{ key: 'ecc', prior: { type: 'uniform', a: 0, b: 0.6 } }, { key: 'ecc@c', prior: { type: 'uniform', a: 0, b: 0.6 } }], physical, sampler: { nlive: 400, seed: 3 } });
{
  const r = Math.pow(1.5, 2 / 3), c = r - 1, E = 0.6, n = 200000; let area = 0;
  for (let i = 0; i < n; i++) { const e1 = ((i + 0.5) / n) * E; area += Math.min(E, Math.max(0, (c - e1) / r)); }
  const V = (area * (E / n)) / (E * E);
  const prob = buildProblem(flatSpec({ crossing: true })), mc = physicalPriorVolume(prob, { n: 40000 });
  check('physicalPriorVolume: Monte Carlo prior mass of the crossing test matches the analytic area', Math.abs(mc.lnV - Math.log(V)) < 4 * mc.lnVerr, `V = ${V.toFixed(4)} analytic, ${mc.V.toFixed(4)} ± ${(mc.V * mc.lnVerr).toFixed(4)} from ${mc.n} draws`);
  const res = await runFit(flatSpec({ crossing: true }), () => {}, () => false), base = await runFit(flatSpec(null), () => {}, () => false);
  // the run ends on "likelihood is flat" once the excluded plateau is retired, so its own error bar is not meaningful here:
  // the scatter of ln X after retiring a fraction 1 - V of N live points is sqrt((1 - V) / (N V))
  const sd = Math.sqrt((1 - V) / (400 * V));
  check('flat likelihood: nested ln Z with the crossing test equals ln V (the sampler integrates L pi over the allowed region only)', Math.abs(res.logZ - Math.log(V)) < 3 * sd && Math.abs(base.logZ) < 1e-9,
    `ln Z = ${res.logZ.toFixed(3)} against ln V = ${Math.log(V).toFixed(3)} (expected scatter ${sd.toFixed(3)}, ${res.stopReason}); without the test ${base.logZ.toFixed(3)}`);
}

// ---- 5. two planets in velocities: what each test does
{
  const rng = makeRng(5), gauss = rng.normal;
  const truth = { per: 12, tmid: 1, ecc: 0.05, omega: 40, mplanet: 1.0, 'per@c': 30, 'tmid@c': 7, 'ecc@c': 0.1, 'omega@c': -70, 'mplanet@c': 1.5 };
  const K1 = semiAmplitude(12, 0.05, 90, 1.0, 1), K2 = semiAmplitude(30, 0.1, 90, 1.5, 1), f1 = makeRV({ per: 12, tmid: 1, ecc: 0.05, omega: 40, K: K1 }), f2 = makeRV({ per: 30, tmid: 7, ecc: 0.1, omega: -70, K: K2 });
  const t = Float64Array.from({ length: 30 }, () => 200 * rng.next()).sort(), sig = 25;
  const rv = [{ name: 'sim', t, v: Float64Array.from(t, (x) => f1(x) + f2(x) + sig * gauss()), e: new Float64Array(t.length).fill(sig) }];
  const spec = (physical) => ({ data: null, rv, timing: [], planets: ['', 'c'], values: { ...truth, inc: 90, 'inc@c': 90, mstar: 1, rvlin: 0, rvquad: 0 }, ldLaw: 'quadratic', physical,
    free: [['per', 11.8, 12.2], ['tmid', 0, 2], ['mplanet', 0.2, 3], ['ecc', 0, 0.9], ['omega', -180, 180], ['per@c', 29, 31], ['tmid@c', 5, 9], ['mplanet@c', 0.2, 4], ['ecc@c', 0, 0.9], ['omega@c', -180, 180]].map(([key, a, b]) => ({ key, prior: { type: 'uniform', a, b } })),
    sampler: { nlive: 300, seed: 9 } });
  const rows = [], out = {};
  // the true pair is (30/12)^(2/3) - 1 = 0.842 a_b apart, 6.4 mutual Hill radii: hillSpacing 8 excludes the truth on purpose
  for (const [name, ph] of [['none', null], ['crossing', { crossing: true }], ['hill', { hill: true }], ['amd', { amd: true }], ['hillSpacing 8 (excludes the truth)', { hillSpacing: 8 }]]) {
    const sp = spec(ph), res = await runFit(sp, () => {}, () => false), prob = buildProblem(sp), vol = ph ? physicalPriorVolume(prob, { n: 40000 }) : { lnV: 0, lnVerr: 0 };
    const col = (k) => Float64Array.from({ length: res.n }, (_, i) => res.samples[i * res.ndim + k]);
    const e1 = weightedQuantiles(col(3), res.weights, [0.5, 0.95]), e2 = weightedQuantiles(col(8), res.weights, [0.5, 0.95]);
    out[name] = { lnZ: res.logZ, err: res.logZerr, lnV: vol.lnV, e2_95: e2[1] };
    rows.push(`${name}: ln Z ${res.logZ.toFixed(2)} ± ${res.logZerr.toFixed(2)}, ln V ${vol.lnV.toFixed(2)}, ln Z − ln V ${(res.logZ - vol.lnV).toFixed(2)}, e_b ${e1[0].toFixed(3)} (95% < ${e1[1].toFixed(3)}), e_c ${e2[0].toFixed(3)} (95% < ${e2[1].toFixed(3)})`);
  }
  console.log('     two planets, 30 velocities with 25 m/s errors (truth e = 0.05, 0.10; P = 12, 30 d; 1.0, 1.5 M_Jup):\n       ' + rows.join('\n       '));
  const tol = (a, b) => Math.abs(out[a].lnZ - out[b].lnZ) < 3 * Math.hypot(out[a].err, out[b].err) + 0.3;
  check('each test removes prior mass (ln V < 0), Hill and AMD more than crossing', out.crossing.lnV < 0 && out.amd.lnV < out.crossing.lnV && out.hill.lnV < out.crossing.lnV);
  const hs = out['hillSpacing 8 (excludes the truth)'];
  check('a spacing that excludes the true system costs evidence far beyond ln V (the data object): hillSpacing 8 for a pair 6.4 R_H apart', hs.lnZ - out.none.lnZ < hs.lnV - 10, `Δ ln Z = ${(hs.lnZ - out.none.lnZ).toFixed(1)} against ln V = ${hs.lnV.toFixed(2)}`);
  check('the data sit in the allowed region: ln Z changes by about ln(fraction of the posterior removed), never by ln V', tol('none', 'crossing') && out.hill.lnZ - out.none.lnZ > out.hill.lnV - 0.5 && out.amd.lnZ - out.none.lnZ > out.amd.lnV - 0.5);
}

// ---- 6. sessions: the "physical" block reaches buildProblem and runSession records the prior mass removed
{
  const t = Array.from({ length: 12 }, (_, i) => 2460000 + 7 * i), f1 = makeRV({ per: 12, tmid: 1, ecc: 0, omega: 0, K: 80 });
  const s = { format: 'esl-session', version: 1, name: 'toy', planets: [{ letter: 'b', parameters: { per: 12, tmid: 2460001, ecc: 0, omega: 0, inc: 90, mplanet: 1 } }, { letter: 'c', parameters: { per: 30, tmid: 2460007, ecc: 0, omega: 0, inc: 90, mplanet: 1 } }],
    star: { mstar: 1 }, time_reference: 2460000, physical: { crossing: true, hill_spacing: 3 },
    data: { radial_velocity: [{ name: 'sim', time: t, velocity: t.map((x) => f1(x - 2460000)), velocity_err: t.map(() => 5), exposure_min: 10 }] },
    fit: { free: [{ key: 'ecc', prior: { type: 'uniform', a: 0, b: 0.9 } }, { key: 'ecc@c', prior: { type: 'uniform', a: 0, b: 0.9 } }], fixed: { rvlin: 0, rvquad: 0 }, sampler: { nlive: 80, seed: 2 } } };
  const { specFromSession, runSession } = await import('../src/core/session.js');
  const sp = specFromSession(s), pr = buildProblem(sp);
  check('session "physical" block (snake_case) reaches buildProblem; RV exposure_min reaches rv[d].exptime', pr.physical && pr.physical.crossing && pr.physical.hillSpacing === 3 && Math.abs(sp.rv[0].exptime - 10 / 1440) < 1e-15);
  const { session } = await runSession(s);
  const pv = session.result.prior_volume;
  check('runSession records the prior mass the tests remove and ln Z renormalised', pv && pv.lnV < 0 && Math.abs(pv.logZ_renormalised - (session.result.logZ - pv.lnV)) < 1e-12, pv ? `ln V = ${pv.lnV.toFixed(3)}, rejected ${JSON.stringify(pv.rejected)}` : '');
}

process.exit(ok ? 0 : 1);
