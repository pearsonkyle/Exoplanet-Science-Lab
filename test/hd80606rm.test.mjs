// Check fit: the Rossiter–McLaughlin effect of HD 80606 b from the velocities bundled with the examples
// (public/examples/hd80606/HD80606_RV.csv, the compilation distributed with EXOTIC's sample data).
//
// The file holds two transit nights with points in transit: SOPHIE on 2009 February 14 (Moutou et al. 2009; analysed by
// Pont et al. 2009 and Hébrard et al. 2010) and HIRES on 2009 June 5 (Winn et al. 2009). It does not hold the full-transit
// SOPHIE night of 2010 January 14 on which Hébrard et al. (2010) base lambda = 42 ± 8 deg. Each night is its own dataset
// (SOPHIE 2454871 to 2454881, HIRES 2454985 to 2454989) with its own zero point (integrated out) and jitter.
//
// Orbit: the stored joint fit (public/examples/results/hd80606-joint.json, Kepler's law with M* 1.05, R* 1.05) except
// Rp/R* = 0.1001 (Winn et al. 2009): the TESS light curve in that fit is diluted by HD 80607 (HANDOFF.md), which makes its
// Rp/R* 0.0725 too small, and the anomaly scales as (Rp/R*)^2. Limb darkening for the RM model: the spectrograph's band
// (ESL's spectral PHOENIX table over 390 to 690 nm, quadratic), spec.rm.ld.
//   A. orbit fixed; B. orbit free (P, T0, e, omega, Mp with normal priors from the joint posterior); C. as A with the CCF form
//   (spec.rm.method 'ccf', beta 3 km/s) and 10-minute exposures.
// Published (as given in the task notes, not re-read from the papers here): Hébrard et al. 2010 lambda = 42 ± 8 deg,
// v sin i about 1.7 km/s (taken as ± 0.3 below); Winn et al. 2009 lambda = 50 +61 -36 deg (one partial transit, the HIRES night).
import { readFileSync } from 'node:fs';
import { runFit } from '../src/core/fitRunner.js';
import { buildProblem } from '../src/core/model.js';
import { weightedQuantiles } from '../src/core/stats.js';
import { expandSpectral, bandCoefficients } from '../src/core/ldspec.js';
import { LD_SPECTRAL_COMPACT } from '../src/data/ld_spectral.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const rows = readFileSync(new URL('../public/examples/hd80606/HD80606_RV.csv', import.meta.url), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const tRef = 2454870;
const pick = (inst, t0, t1) => { const r = rows.filter((x) => x[0] === inst && +x[1] > t0 && +x[1] < t1); return { name: `${inst} ${t0}`, t: Float64Array.from(r, (x) => +x[1] - tRef), v: Float64Array.from(r, (x) => +x[2]), e: Float64Array.from(r, (x) => +x[3]) }; };
const rv = [pick('SOPHIE', 2454871, 2454881), pick('HIRES_j', 2454985, 2454989)];
const joint = JSON.parse(readFileSync(new URL('../public/examples/results/hd80606-joint.json', import.meta.url))).result;
const J = Object.fromEntries(joint.parameters.map((p) => [p.key, p]));
const ld = bandCoefficients(expandSpectral(LD_SPECTRAL_COMPACT), { teff: 5565, logg: 4.4, feh: 0.35 }, [390, 690], 'quadratic').coeffs;
const values = { rprs: 0.1001, inc: J.inc.median, per: J.per.median, tmid: J.tmid.median - tRef, ecc: J.ecc.median, omega: J.omega.median, mplanet: J.mplanet.median,
  mstar: 1.05, rstar: 1.05, ld0: ld[0], ld1: ld[1], rvlin: 0, rvquad: 0, vsini: 1.7, lambda: 40 };
const inTransit = rv.map((d) => { const pr = buildProblem({ data: null, rv: [d], timing: [], planets: [''], kepler: true, ldLaw: 'quadratic', values, free: [], rm: { ldLaw: 'quadratic', ld } }); const det = pr.detail([]); return det.rv[0].rm.filter((x) => Math.abs(x) > 0.5).length; });
console.log(`     ${rv[0].t.length} SOPHIE and ${rv[1].t.length} HIRES velocities; ${inTransit[0]} and ${inTransit[1]} of them in transit; RM limb darkening (390-690 nm, quadratic) ${ld.map((x) => x.toFixed(3)).join(', ')}`);

const base = { data: null, rv, timing: [], planets: [''], kepler: true, ldLaw: 'quadratic', values, rm: { ldLaw: 'quadratic', ld }, sampler: { nlive: 400, seed: 21 } };
const common = [{ key: 'vsini', prior: { type: 'uniform', a: 0, b: 6 } }, { key: 'lambda', prior: { type: 'uniform', a: -180, b: 180 } },
  { key: 'jit@rv1', prior: { type: 'uniform', a: 0, b: 30 } }, { key: 'jit@rv2', prior: { type: 'uniform', a: 0, b: 30 } }];
const nrm = (k, f = 1) => ({ key: k, prior: { type: 'normal', a: J[k].median - (k === 'tmid' ? tRef : 0), b: f * 0.5 * (J[k].plus + J[k].minus) } });
const fits = {
  'A, orbit fixed': { ...base, free: common },
  'B, orbit free': { ...base, free: [...common, nrm('per'), nrm('tmid'), nrm('ecc'), nrm('omega'), nrm('mplanet')] },
  'C, CCF form, 10 min exposures': { ...base, rv: rv.map((d) => ({ ...d, exptime: 10 / 1440 })), rm: { ...base.rm, method: 'ccf', beta: 3.0 }, free: common },
};
const out = {};
for (const [name, spec] of Object.entries(fits)) {
  const t0 = performance.now(), res = await runFit(spec, () => {}, () => false);
  const col = (k) => Float64Array.from({ length: res.n }, (_, i) => res.samples[i * res.ndim + res.keys.indexOf(k)]);
  const q = (k) => weightedQuantiles(col(k), res.weights, [0.1587, 0.5, 0.8413]);
  const vs = q('vsini'), la = q('lambda');
  out[name] = { vs, la, logZ: res.logZ };
  console.log(`     ${name}: v sin i = ${vs[1].toFixed(2)} +${(vs[2] - vs[1]).toFixed(2)} −${(vs[1] - vs[0]).toFixed(2)} km/s, λ = ${la[1].toFixed(0)} +${(la[2] - la[1]).toFixed(0)} −${(la[1] - la[0]).toFixed(0)}°, jitter ${q('jit@rv1')[1].toFixed(1)} / ${q('jit@rv2')[1].toFixed(1)} m/s, ln Z ${res.logZ.toFixed(2)} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
const A = out['A, orbit fixed'], B = out['B, orbit free'];
// difference in units of the combined error (the side of our interval that faces the published value, in quadrature with theirs)
const sig = (x, v, e) => (x[1] - v) / Math.hypot(v > x[1] ? x[2] - x[1] : x[1] - x[0], e);
for (const [nm, F] of [['A', A], ['B', B]]) {
  check(`${nm}: λ agrees with Hébrard et al. 2010 (42 ± 8°) and Winn et al. 2009 (50 +61 −36°) within 2σ`, Math.abs(sig(F.la, 42, 8)) < 2 && Math.abs(sig(F.la, 50, F.la[1] > 50 ? 61 : 36)) < 2, `${F.la[1].toFixed(0)}°: ${sig(F.la, 42, 8).toFixed(2)}σ from Hébrard, ${sig(F.la, 50, F.la[1] > 50 ? 61 : 36).toFixed(2)}σ from Winn`);
  check(`${nm}: v sin i agrees with 1.7 ± 0.3 km/s within 2σ`, Math.abs(sig(F.vs, 1.7, 0.3)) < 2, `${F.vs[1].toFixed(2)} km/s: ${sig(F.vs, 1.7, 0.3).toFixed(2)}σ`);
}
check('prograde: λ between −90° and 90°', A.la[1] > -90 && A.la[1] < 90);
process.exit(ok ? 0 : 1);
