// The session of test/session.test.mjs (EXOTIC's three-planet example, masses free), built the same way,
// for the tests that compare Python with JavaScript. `variant`: 'masses' (3 free, as session.test.mjs) or
// 'exotic' (masses, trend and jitter free: EXOTIC's default for this toy).
import { readFileSync } from 'node:fs';
import { FORMAT } from '../../../src/core/session.js';
import { parseLightCurve, parseRV, combineEpochs } from '../../../src/core/data.js';

const rd = (p) => readFileSync(new URL('../../../public/examples/' + p, import.meta.url), 'utf8');
export const LD = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];

export function toySession(variant = 'masses') {
  const sys = JSON.parse(rd('toy1873/multi_system.json'));
  const lc = combineEpochs(['b', 'c', 'd'].map((k) => ({ ...parseLightCurve(rd(`toy1873/tess_${k}.csv`), 'tess_' + k), name: 'tess_' + k })));
  const rv = parseRV(rd('toy1873/rv_neid.csv'), 'NEID').sets[0];
  const U = (key, a, b) => ({ key, prior: { type: 'uniform', a, b } });
  const masses = [U('mplanet', 0, sys.bounds.b.mplanet[1]), U('mplanet@c', 0, sys.bounds.c.mplanet[1]), U('mplanet@d', 0, sys.bounds.d.mplanet[1])];
  const session = {
    format: FORMAT, version: 1, name: 'toy-1873', star: { teff: 5605, rstar: 0.974, mstar: 1.02 },
    limb_darkening: { law: 'nonlinear', mode: 'coeffs', coefficients: LD },
    planets: ['b', 'c', 'd'].map((k) => { const p = sys.planets[k]; return { letter: k, parameters: { rprs: p.rprs, inc: p.inc, per: p.per, tmid: p.tmid, ecc: 0, omega: 0, mplanet: p.mplanet } }; }),
    kepler: true, time_reference: lc.tRef,
    data: { light_curve: { name: 'TESS', time: Array.from(lc.t, (x) => x + lc.tRef), flux: Array.from(lc.f), flux_err: Array.from(lc.e), airmass: null, exposure_min: 0, epoch: Array.from(lc.epoch), epochs: lc.segments.map((s) => ({ name: s.name, airmass: false })) },
      radial_velocity: [{ name: 'NEID', time: Array.from(rv.t), velocity: Array.from(rv.v), velocity_err: Array.from(rv.e) }], timing: [] },
    fit: variant === 'exotic'
      ? { use: { lc: true, rv: true, timing: false }, fixed: { rvquad: 0 }, free: [...masses, U('rvlin', -0.1, 0.1), U('jit@rv1', 0, 15)], sampler: { nlive: 300, seed: 4 } }
      : { use: { lc: true, rv: true, timing: false }, fixed: { rvlin: sys.trend.rv_linear, 'jit@rv1': sys.noise.rv_jitter }, free: masses, sampler: { nlive: 300, seed: 4 } },
    result: null,
  };
  return { session: JSON.parse(JSON.stringify(session)), sys };
}
