// Generates the simulated example in this folder:  node public/examples/ttvpair/make_example.mjs
// Two transiting warm Saturns just outside the 2:1 resonance (period ratio 2.04, a configuration like Kepler-9 b and c
// in its periods only): every transit of both over 1460 days (a Kepler-length baseline), integrated with IAS15 in
// src/core/nbody.js, with Gaussian timing noise equal to the quoted errors. No velocities: the point of the example is
// that the timing variations alone give both masses. Writes transit_times.csv, truth.json and session.json. Seeded.
import { writeFileSync } from 'node:fs';
import { nbody, ttvSummary, lithwickTTV, stabilityReport } from '../../../src/core/nbody.js';
import { fitEphemeris } from '../../../src/core/ephemeris.js';
import { makeRng } from '../../../src/core/stats.js';

const here = (f) => new URL('./' + f, import.meta.url);
const EPOCH = 2455000, PB = 19.24, PC = PB * 2.04, SPAN = 1460;
const star = { mstar: 1.0, rstar: 1.0, teff: 5780, logg: 4.44, feh: 0 };
const system = {
  mstar: star.mstar, rstar: star.rstar, epoch: EPOCH, coords: 'jacobi',
  planets: [
    { letter: 'b', per: PB, tmid: EPOCH + 3.1, ecc: 0, omega: 0, inc: 89.2, mplanet: 0.14, rprs: 0.080 },
    { letter: 'c', per: PC, tmid: EPOCH + 11.7, ecc: 0, omega: 0, inc: 89.4, mplanet: 0.09, rprs: 0.077 },
  ],
};
const sim = nbody(system, { tEnd: EPOCH + SPAN, integrator: 'ias15', event: 'minsep' });

// ---- observations: every transit of both planets, errors 1.5 to 3 minutes (b) and 2 to 4 minutes (c)
const rng = makeRng(20261116), rows = [];
const errRange = { b: [90, 180], c: [120, 240] };
sim.transits.forEach((tr, p) => {
  const letter = system.planets[p].letter, [lo, hi] = errRange[letter];
  for (let E = 0; E < tr.n; E++) { const err = (lo + (hi - lo) * rng.next()) / 86400; rows.push({ letter, E, t: tr.t[E] + err * rng.normal(), err, truth: tr.t[E] }); }
});
rows.sort((a, b) => a.t - b.t);
writeFileSync(here('transit_times.csv'), 'planet,tmid,err,source\n' + rows.map((r) => `${r.letter},${r.t.toFixed(6)},${r.err.toFixed(6)},simulated`).join('\n') + '\n');

// ---- what the timing signal looks like, and the linear ephemerides an observer would start from
const sb = ttvSummary(sim.transits[0].t), sc = ttvSummary(sim.transits[1].t);
const linOf = (letter) => { const r = rows.filter((x) => x.letter === letter); return fitEphemeris(r.map((x) => x.E), r.map((x) => x.t), r.map((x) => x.err), 1); };
const lb = linOf('b'), lc = linOf('c');
const lw = lithwickTTV({ mstar: star.mstar, P1: sb.per, P2: sc.per, m1: 0.14, m2: 0.09 });
const stab = stabilityReport(system);
const truth = {
  description: 'Simulated: two transiting planets just outside the 2:1 resonance (period ratio 2.04 at the epoch), mid-transit times of both from an IAS15 integration (src/core/nbody.js) with Gaussian noise equal to the quoted errors.',
  generator: 'public/examples/ttvpair/make_example.mjs', seed: 20261116,
  units: { time: 'BJD_TDB days', mass: 'M_Jup (planets), M_sun (star)', angles: 'degrees' },
  star, epoch: EPOCH, coords: 'jacobi (osculating at epoch)', event: 'minimum projected separation', planets: system.planets,
  integration: { integrator: 'ias15', days: SPAN, energy_error: sim.energy.maxRelErr, transits_b: sim.transits[0].n, transits_c: sim.transits[1].n },
  ttv: { b: { mean_period: sb.per, amplitude_min: sb.amplitude * 1440 }, c: { mean_period: sc.per, amplitude_min: sc.amplitude * 1440 },
    super_period_d: lw.superPeriod, resonance: `${lw.j}:${lw.j - 1}`, delta: lw.delta, lithwick_amplitude_min: { b: lw.amp1 * 1440, c: lw.amp2 * 1440 } },
  linear_ephemeris: { b: { t0: lb.t0, per: lb.per, chi2: lb.chi2, dof: lb.dof }, c: { t0: lc.t0, per: lc.per, chi2: lc.chi2, dof: lc.dof } },
  stability: { deltaHill: stab.pairs[0].deltaHill, amdBeta: stab.pairs[0].amdBeta, findings: stab.findings },
};
writeFileSync(here('truth.json'), JSON.stringify(truth, null, 1) + '\n');

// ---- session (docs/FORMAT.md): both planets, their times, N-body with each planet's T0 and P profiled;
// free: both masses and the outer planet's osculating period and phase at the epoch (they set the period ratio and the
// TTV phase). The starting values are what an observer has: the linear ephemerides, and no masses.
const r7 = (x) => +x.toFixed(7), r5 = (x) => +x.toFixed(5);
const tmidNear = (lin) => lin.t0 + Math.round((EPOCH + 10 - lin.t0) / lin.per) * lin.per;
const cT = tmidNear(lc);
const session = {
  format: 'esl-session', version: 1,
  software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null },
  created: '2026-11-16T00:00:00Z',
  name: 'Simulated TTV pair', title: 'Simulated: two transiting planets near the 2:1 resonance, masses from timing alone',
  notes: 'Simulated (public/examples/ttvpair/make_example.mjs): every transit of two warm Saturns at 19.2 and 39.3 days over four years, 1.5 to 4 minute errors, no velocities. Injected masses 0.14 and 0.09 M Jup.',
  star: { teff: star.teff, teffErr: 100, logg: star.logg, loggErr: 0.1, feh: star.feh, fehErr: 0.1, rstar: star.rstar, rstarErr: 0.02, mstar: star.mstar, mstarErr: 0.04 },
  limb_darkening: { law: 'quadratic', mode: 'coeffs', band: 'Kepler (approx.)', coefficients: [0.40, 0.26] },
  planets: [
    { letter: 'b', parameters: { rprs: 0.08, inc: 89.2, per: r7(lb.per), tmid: r5(tmidNear(lb)), ecc: 0, omega: 0, mplanet: 0.05 } },
    { letter: 'c', parameters: { rprs: 0.077, inc: 89.4, per: r7(lc.per), tmid: r5(cT), ecc: 0, omega: 0, mplanet: 0.05 } },
  ],
  nbody: { epoch: EPOCH, linear: true, stepsPerOrbit: 30 },
  physical: { crossing: true, hill: true },   // orbits that cross or are not Hill stable have no prior mass (src/core/physical.js)
  kepler: true,
  time_reference: EPOCH,
  data: { light_curve: null, radial_velocity: [], timing: rows.map((r) => ({ planet: r.letter, kind: 'transit', time: +r.t.toFixed(6), err: +r.err.toFixed(6), source: 'simulated' })) },
  fit: {
    use: { lc: false, rv: false, timing: true },
    free: [
      { key: 'mplanet', label: 'Mp', unit: 'M Jup', prior: { type: 'uniform', a: 0, b: 0.6 } },
      { key: 'mplanet@c', label: 'Mp · c', unit: 'M Jup', prior: { type: 'uniform', a: 0, b: 0.6 } },
      { key: 'per@c', label: 'P · c', unit: 'd', prior: { type: 'uniform', a: r5(lc.per * 0.995), b: r5(lc.per * 1.005) } },
      { key: 'tmid@c', label: 'T mid · c', unit: 'd', prior: { type: 'uniform', a: r5(cT - 0.3), b: r5(cT + 0.3) } },
    ],
    fixed: {}, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1000000 },
  },
  ui: { tab: 'timing', timing_order: 1 },
  result: null,
};
writeFileSync(here('session.json'), JSON.stringify(session, null, 1) + '\n');
console.log(`wrote ${rows.length} times (${sim.transits[0].n} of b, ${sim.transits[1].n} of c); TTV amplitude b ${(sb.amplitude * 1440).toFixed(1)} min, c ${(sc.amplitude * 1440).toFixed(1)} min; super-period ${lw.superPeriod.toFixed(0)} d (Lithwick b ${(lw.amp1 * 1440).toFixed(1)} min, c ${(lw.amp2 * 1440).toFixed(1)} min); linear chi2 b ${lb.chi2.toFixed(0)}/${lb.dof}, c ${lc.chi2.toFixed(0)}/${lc.dof}; deltaHill ${stab.pairs[0].deltaHill.toFixed(1)}`);
