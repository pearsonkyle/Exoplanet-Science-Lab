// Builds the Kepler-88 (KOI-142) example from the Holczer et al. (2016) Kepler TTV catalogue rows in this folder:
//   node public/examples/kepler88/make_example.mjs
// Writes transit_times.csv (BJD_TDB mid-transit times of b with errors) and session.json (N-body, b's T0 and P profiled;
// the non-transiting planet c's mass, period, phase and both planets' eccentricity vectors free). Deterministic.
//
// Catalogue: J/ApJS/225/9 table3 (VizieR, CfA mirror), columns tn = expected mid-transit time (BJD - 2454900) and O-C
// [min] with e_O-C [min]; the observed time is tn + O-C. Rows with a nonzero outlier flag ("Out") are left out.
// The catalogue gives e_O-C to one significant figure (2 min for most transits).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProblem } from '../../../src/core/model.js';

const here = (f) => new URL('./' + f, import.meta.url);
const rows = readFileSync(here('holczer2016_table3_koi142.01.tsv'), 'utf8').split('\n').filter((l) => /^\s*\d/.test(l)).map((l) => l.split('\t'))
  .map((r) => ({ N: +r[2], tn: +r[3], oc: +r[4], eoc: +r[5], out: +r[13] }));
const keep = rows.filter((r) => r.out === 0), dropped = rows.filter((r) => r.out !== 0);
const times = keep.map((r) => ({ E: r.N, t: 2454900 + r.tn + r.oc / 1440, e: r.eoc / 1440 }));
writeFileSync(here('transit_times.csv'), 'epoch,tmid,err,source\n' + times.map((x) => `${x.E},${x.t.toFixed(6)},${x.e.toFixed(6)},Holczer et al. 2016`).join('\n') + '\n');

// Star: Weiss et al. 2020 (the NASA Exoplanet Archive default parameter set in this repository's snapshot, public/catalog).
const STAR = { teff: 5466, teffErr: 60, logg: 4.53, loggErr: 0.03, feh: 0.27, fehErr: 0.06, rstar: 0.897, rstarErr: 0.016, mstar: 0.99, mstarErr: 0.023 };
const TREF = 2454950, EPOCH = 2454954.5;
// Starting point: the best fit found by a grid in (mass, period, phase) of c (ttvGrid, ttvGridRefine in src/core/nbody.js)
// polished with eccentricities free (Nelder-Mead on the same likelihood); recorded here so the session is reproducible.
const start = { 'mplanet@c': 0.67026, 'per@c': 22.33492, 'tmid@c': TREF - 0.23324, secosw: -0.23605, sesinw: -0.01218, 'secosw@c': 0.23914, 'sesinw@c': 0.00984 };
const eo = (h, k) => ({ ecc: +(h * h + k * k).toFixed(5), omega: +(Math.atan2(k, h) * 180 / Math.PI).toFixed(2) });
const planets = [
  { letter: 'b', parameters: { rprs: 0.0352, inc: 89.0, per: 10.950813, tmid: 2454954.743814, ...eo(start.secosw, start.sesinw), mplanet: 0.03 } },
  { letter: 'c', parameters: { rprs: 0.01, inc: 87.0, per: start['per@c'], tmid: +start['tmid@c'].toFixed(5), ...eo(start['secosw@c'], start['sesinw@c']), mplanet: start['mplanet@c'] } },
];
const U = (a, b) => ({ type: 'uniform', a, b });
const free = [
  { key: 'mplanet@c', label: 'Mp · c', unit: 'M Jup', prior: U(0.2, 1.5) },
  { key: 'per@c', label: 'P · c', unit: 'd', prior: U(22.28, 22.39) },
  { key: 'tmid@c', label: 'T mid · c', unit: 'd', prior: U(+(start['tmid@c'] - 0.6).toFixed(4), +(start['tmid@c'] + 0.6).toFixed(4)) },
  { key: 'secosw', label: '√e cos ω', unit: '', prior: U(-0.5, 0.5) }, { key: 'sesinw', label: '√e sin ω', unit: '', prior: U(-0.5, 0.5) },
  { key: 'secosw@c', label: '√e cos ω · c', unit: '', prior: U(-0.5, 0.5) }, { key: 'sesinw@c', label: '√e sin ω · c', unit: '', prior: U(-0.5, 0.5) },
];
const session = {
  format: 'esl-session', version: 1, software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null }, created: '2026-11-16T00:00:00Z',
  name: 'Kepler-88', title: 'Kepler-88 (KOI-142): the mass of a hidden planet from transit timing', notes: '',
  star: STAR, limb_darkening: { law: 'quadratic', mode: 'coeffs', band: 'Kepler (approx.)', coefficients: [0.45, 0.2] },
  planets, kepler: true, time_reference: TREF,
  nbody: { epoch: EPOCH, linear: true, stepsPerOrbit: 30 },
  physical: { crossing: true, hill: true },
  data: { light_curve: null, radial_velocity: [], timing: times.map((x) => ({ planet: 'b', kind: 'transit', time: +x.t.toFixed(6), err: +x.e.toFixed(6), source: 'Holczer et al. 2016' })) },
  fit: { use: { lc: false, rv: false, timing: true }, free, fixed: { secosw: start.secosw, sesinw: start.sesinw, 'secosw@c': start['secosw@c'], 'sesinw@c': start['sesinw@c'] }, timing_noise: 0,
    sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1000000 } },
  ui: { tab: 'timing', timing_order: 1 }, result: null,
};
// The catalogue errors are rounded and too small for this model (chi2 about 2170 for 119 times at the best fit, which leaves out
// planet d and any other perturbation): a timing noise added in quadrature brings chi2 to the degrees of freedom. Found here, at the start point.
const prob = (noise) => buildProblem({ data: null, rv: [], timing: [{ planet: '', kind: 'transit', t: Float64Array.from(times, (x) => x.t - TREF), e: Float64Array.from(times, (x) => x.e) }], planets: ['', 'c'], kepler: true, ldLaw: 'quadratic',
  values: { mstar: STAR.mstar, rstar: STAR.rstar, ...Object.fromEntries(planets.flatMap((p, i) => Object.entries(p.parameters).map(([k, v]) => [i ? `${k}@c` : k, k === 'tmid' ? v - TREF : v]))), ...start, 'tmid@c': start['tmid@c'] - TREF }, free: [], nbody: { ...session.nbody, epoch: EPOCH - TREF }, timingNoise: noise });
const chi0 = prob(0).detail([]).chi2tim, dof = times.length - free.length - 2;
let lo = 0, hi = 0.02; for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (prob(m).detail([]).chi2tim > dof) lo = m; else hi = m; }
session.fit.timing_noise = +hi.toFixed(6);
writeFileSync(here('session.json'), JSON.stringify(session, null, 1) + '\n');
console.log(`${keep.length} times kept, ${dropped.length} flagged as outliers (transits ${dropped.map((r) => r.N).join(', ')}); chi2 at the start ${chi0.toFixed(1)}; timing noise ${(hi * 1440).toFixed(2)} min gives chi2 = ${dof} (degrees of freedom)`);
