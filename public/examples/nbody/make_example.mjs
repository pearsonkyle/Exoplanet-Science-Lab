// Generates the synthetic N-body example in this folder:  node public/examples/nbody/make_example.mjs
// A hot Jupiter with an outer companion just inside the 2:1 resonance, the configuration of EXOTIC's
// examples/nbody/example.py (HAT-P-37-like star and planet b; companion of 0.1 M_Jup at 1.9 times the period,
// both starting a quarter orbit before conjunction), integrated with IAS15 in src/core/nbody.js.
// Writes transit_times.csv, truth.json and session.json. Deterministic (seeded).
import { writeFileSync } from 'node:fs';
import { nbody, ttvSummary, lithwickTTV, stabilityReport } from '../../../src/core/nbody.js';
import { fitEphemeris } from '../../../src/core/ephemeris.js';
import { makeRng } from '../../../src/core/stats.js';

const here = (f) => new URL('./' + f, import.meta.url);
const EPOCH = 2459150, PB = 2.797436, PC = PB * 1.9, NORB = 400;
const star = { mstar: 0.95, rstar: 0.877, teff: 5500, logg: 4.52, feh: 0.03 };
const system = {
  mstar: star.mstar, rstar: star.rstar, epoch: EPOCH, coords: 'jacobi',
  planets: [
    { letter: 'b', per: PB, tmid: EPOCH + PB / 4, ecc: 0, omega: 0, inc: 86.9, mplanet: 1.169, rprs: 0.1378 },
    { letter: 'c', per: PC, tmid: EPOCH + PC / 4, ecc: 0, omega: 0, inc: 85.0, mplanet: 0.1, rprs: 0.045 },
  ],
};
const sim = nbody(system, { tEnd: EPOCH + NORB * PB, integrator: 'ias15', event: 'minsep' });
const tb = sim.transits[0];
const sum = ttvSummary(tb.t);

// ---- observations: two TESS sectors of consecutive transits, and ground-based transits in three seasons
const rng = makeRng(20261115), rows = [], used = new Set();
const add = (E, lo, hi, source) => { if (used.has(E) || E < 0 || E >= tb.n) return; used.add(E); const err = (lo + (hi - lo) * rng.next()) / 86400; rows.push({ E, t: tb.t[E] + err * rng.normal(), err, source }); };
for (let E = 12; E < 22; E++) add(E, 30, 45, 'TESS');
for (let E = 271; E < 280; E++) add(E, 30, 45, 'TESS');
const seasons = [[0, 75], [128, 205], [258, 335], [388, 399]], ground = ['ExoClock', 'Exoplanet Watch', 'Unistellar'];
let tries = 0;
while (rows.length < 72 && tries++ < 10000) { const s = seasons[rng.int(seasons.length)]; add(s[0] + rng.int(s[1] - s[0] + 1), 45, 90, ground[rng.int(3)]); }
rows.sort((a, b) => a.t - b.t);
writeFileSync(here('transit_times.csv'), 'tmid,err,source\n' + rows.map((r) => `${r.t.toFixed(6)},${r.err.toFixed(6)},${r.source}`).join('\n') + '\n');

// ---- truth
const lin = fitEphemeris(rows.map((r) => r.E), rows.map((r) => r.t), rows.map((r) => r.err), 1);
// the analytic expectation needs the MEAN periods (what an ephemeris measures), not the osculating ones at the epoch:
// the Jupiter-mass inner planet makes the companion's mean period 0.32% longer than its osculating 5.3151 d
const sumC = ttvSummary(sim.transits[1].t);
const lw = lithwickTTV({ mstar: star.mstar, P1: sum.per, P2: sumC.per, m1: 1.169, m2: 0.1 });
const lwOsc = lithwickTTV({ mstar: star.mstar, P1: PB, P2: PC, m1: 1.169, m2: 0.1 });
const stab = stabilityReport(system);
const truth = {
  description: 'Synthetic two-planet system near the 2:1 resonance (EXOTIC examples/nbody/example.py configuration). Mid-transit times of planet b from an IAS15 integration (src/core/nbody.js), with Gaussian noise equal to the quoted errors.',
  generator: 'public/examples/nbody/make_example.mjs', seed: 20261115,
  units: { time: 'BJD_TDB days', mass: 'M_Jup (planets), M_sun (star)', angles: 'degrees' },
  star, epoch: EPOCH, coords: 'jacobi (osculating at epoch)', event: 'minimum projected separation',
  planets: system.planets,
  integration: { integrator: 'ias15', orbits_of_b: NORB, days: NORB * PB, energy_error: sim.energy.maxRelErr, transits_b: tb.n, transits_c: sim.transits[1].n },
  ttv_b: {
    mean_period: sum.per, t0: sum.t0, amplitude_s: sum.amplitude * 86400, rms_s: sum.rms * 86400,
    super_period_d: lw.superPeriod, super_period_epochs: lw.superPeriod / sum.per,
    lithwick_amplitude_s: lw.amp1 * 86400, resonance: `${lw.j}:${lw.j - 1}`, delta: lw.delta,
    from_osculating_periods_at_epoch: { super_period_d: lwOsc.superPeriod, delta: lwOsc.delta, lithwick_amplitude_s: lwOsc.amp1 * 86400, note: 'for comparison only: the periods the planets start with are not their mean periods' },
    dominant_period_epochs: sum.periods.length ? sum.periods[0].period : null, fitted_sinusoid_amplitude_s: sum.periods.length && sum.periods[0].amp ? sum.periods[0].amp * 86400 : null,
  },
  ttv_c: (() => { const s = sumC; return { mean_period: s.per, amplitude_s: s.amplitude * 86400, note: 'c does not transit at i = 85 deg (b = ' + sim.transits[1].b[0].toFixed(2) + '); times are of its inferior conjunctions' }; })(),
  observations: { n: rows.length, span_d: rows[rows.length - 1].t - rows[0].t, error_s: [Math.min(...rows.map((r) => r.err)) * 86400, Math.max(...rows.map((r) => r.err)) * 86400], linear_ephemeris: { t0: lin.t0, per: lin.per, chi2: lin.chi2, dof: lin.dof } },
  stability: { deltaHill: stab.pairs[0].deltaHill, amdBeta: stab.pairs[0].amdBeta, findings: stab.findings },
  noiseless: { epoch: Array.from(rows, (r) => r.E), tmid: Array.from(rows, (r) => +tb.t[r.E].toFixed(7)) },
};
writeFileSync(here('truth.json'), JSON.stringify(truth, null, 1) + '\n');

// ---- session (docs/FORMAT.md): the timing list on planet b, linear ephemeris free
const ars = Math.cbrt((6.6743e-11 * 1.98841e30 * (star.mstar) * (PB * 86400) ** 2) / (4 * Math.PI ** 2)) / (star.rstar * 6.957e8);
const session = {
  format: 'esl-session', version: 1,
  software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null },
  created: '2026-11-15T00:00:00Z',
  name: 'N-body example', title: 'Synthetic hot Jupiter with a companion near the 2:1 resonance: 72 mid-transit times',
  notes: 'Synthetic. Open the Timing tab: the O - C shows a sinusoid of about 19 orbits (53 d) from an unseen 0.1 M_Jup companion at 5.315 d. See public/examples/nbody/README.md and truth.json.',
  star: { teff: star.teff, teffErr: 100, logg: star.logg, loggErr: 0.1, feh: star.feh, fehErr: 0.1, rstar: star.rstar, rstarErr: 0.02, mstar: star.mstar, mstarErr: 0.04 },
  limb_darkening: { law: 'quadratic', mode: 'coeffs', band: 'TESS (approx.)', coefficients: [0.42, 0.24] },
  planets: [{ letter: 'b', parameters: { rprs: 0.1378, ars: +ars.toFixed(3), inc: 86.9, per: +lin.per.toFixed(7), tmid: +lin.t0.toFixed(5), ecc: 0, omega: 0, mplanet: 1.169 } }],
  kepler: false,
  time_reference: EPOCH,
  data: { light_curve: null, radial_velocity: [], timing: rows.map((r) => ({ planet: 'b', kind: 'transit', time: +r.t.toFixed(6), err: +r.err.toFixed(6), source: r.source })) },
  fit: {
    use: { lc: false, rv: false, timing: true },
    free: [
      { key: 'per', label: 'P', unit: 'd', prior: { type: 'uniform', a: +(lin.per - 0.001).toFixed(6), b: +(lin.per + 0.001).toFixed(6) } },
      { key: 'tmid', label: 'T mid', unit: 'd', prior: { type: 'uniform', a: +(lin.t0 - 0.02).toFixed(5), b: +(lin.t0 + 0.02).toFixed(5) } },
    ],
    fixed: {}, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1000000 },
  },
  result: null,
};
writeFileSync(here('session.json'), JSON.stringify(session, null, 1) + '\n');
console.log(`wrote ${rows.length} transit times; TTV amplitude of b ${(sum.amplitude * 86400).toFixed(1)} s, super-period ${lw.superPeriod.toFixed(2)} d (${(lw.superPeriod / sum.per).toFixed(2)} orbits), Lithwick ${(lw.amp1 * 86400).toFixed(1)} s`);
