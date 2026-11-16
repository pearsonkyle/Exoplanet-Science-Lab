// Builds rm_session.json, the Rossiter–McLaughlin example of HD 80606 b:  node public/examples/hd80606/make_rm_session.mjs
// Velocities only (HD80606_RV.csv, the compilation of EXOTIC's sample data) and the five mid-times of the joint example.
// The two nights with velocities in transit, SOPHIE 2009 February 14 (Moutou et al. 2009) and HIRES 2009 June 5
// (Winn et al. 2009), are datasets of their own (own zero point, own jitter). Rp/R* is held at 0.1001 (Winn et al. 2009):
// the TESS light curve of the joint example is diluted by HD 80607, and the anomaly scales as (Rp/R*)^2. Limb darkening
// of the anomaly: the spectrograph's band (ESL's PHOENIX table, 390 to 690 nm, quadratic). The inclination is the joint
// example's posterior median. As in test/hd80606rm.test.mjs (the check fit of the RM model).
import { readFileSync, writeFileSync } from 'node:fs';
import { expandSpectral, bandCoefficients } from '../../../src/core/ldspec.js';
import { LD_SPECTRAL_COMPACT } from '../../../src/data/ld_spectral.js';

const here = (f) => new URL('./' + f, import.meta.url);
const STAR = { teff: 5565, teffErr: 92, logg: 4.4, loggErr: 0.1, feh: 0.35, fehErr: 0.06, rstar: 1.05, rstarErr: 0.01, mstar: 1.05, mstarErr: 0.047 };
const joint = JSON.parse(readFileSync(here('../results/hd80606-joint.json'), 'utf8')), J = Object.fromEntries(joint.result.parameters.map((p) => [p.key, p]));
const rows = readFileSync(here('HD80606_RV.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')).map((x) => ({ inst: x[0], t: +x[1], v: +x[2], e: +x[3] }));
const nights = [{ inst: 'SOPHIE', t0: 2454871, t1: 2454881, name: 'SOPHIE 2009-02 (transit)' }, { inst: 'HIRES_j', t0: 2454985, t1: 2454989, name: 'HIRES 2009-06 (transit)' }];
const nightOf = (r) => nights.find((n) => r.inst === n.inst && r.t > n.t0 && r.t < n.t1);
const sets = new Map();
for (const r of rows) {
  const n = nightOf(r), name = n ? n.name : r.inst === 'HRS' ? (r.e < 5 ? 'HRS_1' : 'HRS_2') : r.inst;   // HRS: two populations of error bars, as in the RV example
  if (!sets.has(name)) sets.set(name, { name, time: [], velocity: [], velocity_err: [] });
  const s = sets.get(name); s.time.push(r.t); s.velocity.push(r.v); s.velocity_err.push(r.e);
}
const rv = [...sets.values()], jit = rv.map((s, i) => [s.name, `jit@rv${i + 1}`]).filter(([n]) => n.includes('transit'));
const ld = bandCoefficients(expandSpectral(LD_SPECTRAL_COMPACT), { teff: STAR.teff, logg: STAR.logg, feh: STAR.feh }, [390, 690], 'quadratic').coeffs.map((x) => +x.toFixed(4));
const U = (a, b) => ({ type: 'uniform', a, b });
const times = [
  { time: 2454987.7842, err: 0.0049, source: 'Winn et al. 2010' }, { time: 2455210.6420, err: 0.004, source: 'Hébrard et al. 2010' },
  { time: 2455210.6502, err: 0.0064, source: 'Shporer et al. 2010' }, { time: 2459556.6942, err: 0.0035, source: 'Exoplanet Watch, Dec 2021' },
].map((x) => ({ planet: 'b', kind: 'transit', ...x })).concat([{ planet: 'b', kind: 'eclipse', time: 2454424.736, err: 0.00025, source: 'Laughlin et al. 2009 (Spitzer)' }]);
const session = {
  format: 'esl-session', version: 1, software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null }, created: '2026-11-16T00:00:00Z',
  name: 'HD 80606', title: 'HD 80606 b: the Rossiter–McLaughlin effect', notes: '',
  star: STAR,
  limb_darkening: { law: 'quadratic', mode: 'coeffs', band: 'Custom range', band_custom: [390, 690], coefficients: ld },
  planets: [{ letter: 'b', parameters: { rprs: 0.1001, inc: +J.inc.median.toFixed(4), per: J.per.median, tmid: J.tmid.median, ecc: J.ecc.median, omega: J.omega.median, mplanet: J.mplanet.median } }],
  kepler: true, time_reference: 2454870,
  rm: { ld_law: 'quadratic', ld },
  data: { light_curve: null, radial_velocity: rv, timing: times },
  fit: {
    use: { lc: false, rv: true, timing: true },
    free: [
      { key: 'per', label: 'P', unit: 'd', prior: U(111.436, 111.4378) }, { key: 'tmid', label: 'T mid', unit: 'd', prior: U(2458887.8757, 2458888.2757) },
      { key: 'ecc', label: 'e', unit: '', prior: U(0.93, 0.933) }, { key: 'omega', label: 'ω', unit: '°', prior: U(-59.5, -58.2) },
      { key: 'mplanet', label: 'Mp', unit: 'M Jup', prior: U(4.1, 4.3) },
      { key: 'vsini', label: 'v sin i★', unit: 'km/s', prior: U(0, 6) }, { key: 'lambda', label: 'λ', unit: '°', prior: U(-180, 180) },
      ...jit.map(([n, k]) => ({ key: k, label: 'jitter · ' + n, unit: 'm/s', prior: U(0, 30) })),
    ],
    fixed: { vsini: 1.7, lambda: 40, rvlin: 0, rvquad: 0, ...Object.fromEntries(rv.map((_, i) => [`jit@rv${i + 1}`, 0])) },
    timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1500000 },
  },
  ui: { view: 'rv', fold: false, tab: 'fit' },
  result: null,
};
writeFileSync(here('rm_session.json'), JSON.stringify(session, null, 1) + '\n');
console.log(`wrote rm_session.json: ${rv.length} velocity sets (${rv.map((s) => `${s.name} ${s.time.length}`).join(', ')}); RM limb darkening ${ld.join(', ')}`);
