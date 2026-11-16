// The session format: a session built from EXOTIC's three-planet example gives the same likelihood as the
// specification written out by hand in test/exotic.test.mjs (whose reference is EXOTIC itself), and runs.
import { readFileSync } from 'node:fs';
import { buildProblem } from '../src/core/model.js';
import { specFromSession, runSession, validateSession, FORMAT } from '../src/core/session.js';
import { parseLightCurve, parseRV, combineEpochs } from '../src/core/data.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const rd = (p) => readFileSync(new URL('../public/examples/' + p, import.meta.url), 'utf8');
const R = JSON.parse(readFileSync(new URL('./exotic_reference.json', import.meta.url)));
const sys = JSON.parse(rd('toy1873/multi_system.json')), LD = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];
const lc = combineEpochs(['b', 'c', 'd'].map((k) => ({ ...parseLightCurve(rd(`toy1873/tess_${k}.csv`), 'tess_' + k), name: 'tess_' + k })));
const rv = parseRV(rd('toy1873/rv_neid.csv'), 'NEID').sets[0];
const session = {
  format: FORMAT, version: 1, name: 'toy-1873', star: { teff: 5605, rstar: 0.974, mstar: 1.02 },
  limb_darkening: { law: 'nonlinear', mode: 'coeffs', coefficients: LD },
  planets: ['b', 'c', 'd'].map((k) => { const p = sys.planets[k]; return { letter: k, parameters: { rprs: p.rprs, inc: p.inc, per: p.per, tmid: p.tmid, ecc: 0, omega: 0, mplanet: p.mplanet } }; }),
  kepler: true, time_reference: lc.tRef,
  data: { light_curve: { name: 'TESS', time: Array.from(lc.t, (x) => x + lc.tRef), flux: Array.from(lc.f), flux_err: Array.from(lc.e), airmass: null, exposure_min: 0, epoch: Array.from(lc.epoch), epochs: lc.segments.map((s) => ({ name: s.name, airmass: false })) },
    radial_velocity: [{ name: 'NEID', time: Array.from(rv.t), velocity: Array.from(rv.v), velocity_err: Array.from(rv.e) }], timing: [] },
  fit: { use: { lc: true, rv: true, timing: false }, fixed: { rvlin: sys.trend.rv_linear, 'jit@rv1': sys.noise.rv_jitter },
    free: [{ key: 'mplanet', prior: { type: 'uniform', a: 0, b: sys.bounds.b.mplanet[1] } }, { key: 'mplanet@c', prior: { type: 'uniform', a: 0, b: sys.bounds.c.mplanet[1] } }, { key: 'mplanet@d', prior: { type: 'uniform', a: 0, b: sys.bounds.d.mplanet[1] } }],
    sampler: { nlive: 300, seed: 4 } },
  result: null,
};
const viaJSON = JSON.parse(JSON.stringify(session));   // what a reader of the file gets
const spec = specFromSession(viaJSON), det = buildProblem({ ...spec, free: [] }).detail([]);
const ref = R.toy.lc.tess_b.chi2 + R.toy.lc.tess_c.chi2 + R.toy.lc.tess_d.chi2;
check('session -> specification reproduces EXOTIC\'s chi2 on the three-planet example', Math.abs(det.chi2lc - ref) < 0.03 && Math.abs(det.chi2rv - R.toy.rv.chi2) < 0.02, `light curves ${det.chi2lc.toFixed(2)} vs ${ref.toFixed(2)}, velocities ${det.chi2rv.toFixed(2)} vs ${R.toy.rv.chi2.toFixed(2)}`);
check('times are relative inside the fit and three planets are resolved', Math.abs(spec.values.tmid - (sys.planets.b.tmid - lc.tRef)) < 1e-9 && spec.planets.join() === ',c,d' && spec.values['per@d'] === 128);
const out = await runSession(viaJSON, { keepSamples: true });
const r = out.session.result, m = Object.fromEntries(r.parameters.map((p) => [p.key, p]));
const truth = { mplanet: sys.planets.b.mplanet, 'mplanet@c': sys.planets.c.mplanet, 'mplanet@d': sys.planets.d.mplanet };
check('running the session recovers the injected masses', r.converged && Object.keys(truth).every((k) => Math.abs(m[k].median - truth[k]) < 3 * Math.max(m[k].plus, m[k].minus)), Object.keys(truth).map((k) => `${k} ${m[k].median.toFixed(4)} +${m[k].plus.toFixed(4)} -${m[k].minus.toFixed(4)} (${truth[k].toFixed(4)})`).join(', '));
check('result carries derived quantities per planet, absolute times, and draws', r.derived.K && r.derived['K@c'] && r.derived['K@d'] && Math.abs(r.derived.K.median - 3.0) < 1.5 && Math.abs(r.best.tmid - sys.planets.b.tmid) < 1e-6 && r.samples.values.length >= 200 && Array.isArray(r.samples.values[0]) && r.samples.values[0].length === 3 && Math.abs(r.samples.values.reduce((a, x) => a + x[1], 0) / r.samples.values.length - m['mplanet@c'].median) < 0.01 && r.samples.keys.length === 3 && r.n_data === 408,
  `K = ${r.derived.K.median.toFixed(2)}, ${r.derived['K@c'].median.toFixed(2)}, ${r.derived['K@d'].median.toFixed(2)} m/s; ${r.samples.values.length} draws; chi2 ${r.chi2.toFixed(1)} for ${r.n_data}`);
check('the result survives JSON', JSON.parse(JSON.stringify(out.session)).result.parameters.length === 3);
let threw = 0; for (const bad of [null, { format: 'x' }, { ...session, version: 99 }, { ...session, planets: [] }]) { try { validateSession(bad); } catch { threw++; } }
check('unusable documents are refused', threw === 4);
process.exit(ok ? 0 : 1);
