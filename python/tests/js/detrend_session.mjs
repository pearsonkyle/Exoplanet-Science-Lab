// A two-night light curve with centroid systematics and its detrending model, as a session document
// (docs/FORMAT.md light_curve.columns / detrend). Shared by python/tests/js/reference.mjs.
import { makeTransit } from '../../../src/core/transit.js';
import { makeRng } from '../../../src/core/stats.js';
import { FORMAT } from '../../../src/core/session.js';

export function detrendSession(detrend = { columns: ['xc', 'yc'], poly: 1, pld: [], kernel: null }) {
  const rng = makeRng(23), tRef = 2460000, P = { rprs: 0.1, ars: 9, inc: 88, per: 2.5, tmid: 0.2, ecc: 0, omega: 0 };
  const tr = makeTransit({ ...P, ldLaw: 'quadratic', ld: [0.4, 0.25] });
  const time = [], flux = [], epoch = [], xc = [], yc = [], sky = [];
  for (let s = 0; s < 2; s++) { let x = 0, y = 0; for (let i = 0; i < 200; i++) { const t = P.tmid + s * P.per - 0.13 + 0.26 * i / 199; x += 0.05 * rng.normal(); y += 0.05 * rng.normal(); time.push(t + tRef); epoch.push(s); xc.push(512.3 + x); yc.push(300.1 + y); sky.push(i === 7 && s === 1 ? null : 40 + rng.normal()); flux.push(tr(t) * (1 + (s ? -0.002 : 0.003) * x / 0.3 + 0.0025 * y / 0.3 + 0.001 * (t - P.tmid - s * P.per) / 0.13) + 8e-4 * rng.normal()); } }
  return {
    format: FORMAT, version: 1, name: 'detrend example', star: { teff: 5600, rstar: 1, mstar: 1 }, limb_darkening: { law: 'quadratic', mode: 'coeffs', coefficients: [0.4, 0.25] },
    planets: [{ letter: 'b', parameters: { ...P, tmid: P.tmid + tRef } }], kepler: false, time_reference: tRef,
    data: { light_curve: { name: 'two nights', time, flux, flux_err: new Array(time.length).fill(8e-4), airmass: null, exposure_min: 0, epoch, epochs: [{ name: 'n1', airmass: false }, { name: 'n2', airmass: false }], columns: { xc, yc, sky }, detrend }, radial_velocity: [], timing: [] },
    fit: { use: { lc: true }, free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.05, b: 0.15 } }, { key: 'tmid', prior: { type: 'uniform', a: tRef + 0.18, b: tRef + 0.22 } }], fixed: {}, sampler: { nlive: 200, seed: 3 } }, result: null,
  };
}
