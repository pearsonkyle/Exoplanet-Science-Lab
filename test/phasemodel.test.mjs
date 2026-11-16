// The phase curve inside the shared likelihood (buildProblem): the same numbers as phasecurve.js used directly.
import fs from 'fs';
import { buildProblem, activeParams, phaseKeysFor } from '../src/core/model.js';
import { specFromSession, valuesFromSession } from '../src/core/session.js';
import { makePhaseCurve } from '../src/core/phasecurve.js';
import { toTransitParams } from '../src/core/model.js';

let fail = 0;
const ok = (name, cond, note = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}   ${note}`); if (!cond) fail++; };
const root = new URL('../public/examples/phasecurve/', import.meta.url);

for (const [file, mode] of [['wasp43b_phasecurve.json', 'harmonic'], ['wasp43b_eclipse_map.json', 'map'], ['wasp18b_sim_eclipse_map.json', 'map']]) {
  const s = JSON.parse(fs.readFileSync(new URL(file, root))), spec = specFromSession(s), v = spec.values;
  const prob = buildProblem({ ...spec, free: [] }), det = prob.detail([]);
  // independent: the model from phasecurve.js, each epoch's normalisation solved by weighted least squares
  const pp = { ...toTransitParams({ ...v }, spec.ldLaw), rstar: v.rstar };
  for (const k of phaseKeysFor(s.phase)) if (v[k] !== undefined) pp[k] = v[k];
  const f = makePhaseCurve(pp, { ltt: !!s.phase.ltt, map: mode === 'map' }), d = spec.data, N = d.t.length;
  // exposure averaging: the session's setting, or each epoch's own exposure when it has one
  const ns = spec.supersample, m = new Float64Array(N);
  for (let i = 0; i < N; i++) { const sg = d.segments && d.segments[d.epoch[i]], ex = sg && sg.exptime !== undefined ? sg.exptime : spec.exptime, n = sg && sg.supersample !== undefined ? sg.supersample : ns, dt = ex / n; let a = 0; for (let j = 0; j < n; j++) a += f(d.t[i] + (j - (n - 1) / 2) * dt); m[i] = a / n; }
  const nE = d.epoch ? Math.max(...d.epoch) + 1 : 1, sdm = new Float64Array(nE), smm = new Float64Array(nE); let chi2 = 0;
  for (let i = 0; i < N; i++) { const e = d.epoch ? d.epoch[i] : 0, w = 1 / d.e[i] ** 2; sdm[e] += w * d.f[i] * m[i]; smm[e] += w * m[i] * m[i]; }
  for (let i = 0; i < N; i++) { const e = d.epoch ? d.epoch[i] : 0; chi2 += ((d.f[i] - (sdm[e] / smm[e]) * m[i]) / d.e[i]) ** 2; }
  ok(`${file}: chi2 through buildProblem = direct`, Math.abs(det.chi2 - chi2) < 1e-6 * chi2, `${det.chi2.toFixed(4)} vs ${chi2.toFixed(4)} (N ${N}, ${nE} epochs, supersample ${ns})`);
  ok(`${file}: chi2/N near 1 at the stored parameters`, Math.abs(det.chi2 / N - 1) < 0.1, (det.chi2 / N).toFixed(3));
  // without the planet's light the same data are much worse: the eclipse is in the likelihood
  const v2 = { ...v }; for (const k of Object.keys(v2)) if (phaseKeysFor(s.phase).includes(k)) delete v2[k];
  const bare = buildProblem({ ...spec, values: v2, free: [] }).detail([]);
  ok(`${file}: transit-only model is rejected by the data`, bare.chi2 - det.chi2 > 100, `Δchi2 ${(bare.chi2 - det.chi2).toFixed(0)}`);
  // a negative planet is outside the prior
  const neg = buildProblem({ ...spec, values: { ...v, fpfs: -0.01 }, free: [] });
  ok(`${file}: negative Fp/F* has zero likelihood`, !(neg.loglike([]) > -1e99));
}
const act = activeParams('quadratic', false, { planets: [{ sfx: '', letter: 'b' }, { sfx: 'c', letter: 'c' }], phase: { c: { mode: 'map', lmax: 2 } } });
const ph = act.filter((p) => p.group === 'phase').map((p) => p.key);
ok('activeParams lists the map keys of the planet that has them, scoped', ph.includes('fpfs@c') && ph.includes('y22@c') && !ph.includes('y33@c') && !ph.includes('fpfs') && !ph.includes('contrast@c'), ph.join(' '));
ok('a/R* is still never listed with Kepler on', !activeParams('quadratic', false, { kepler: true, phase: { '': { mode: 'harmonic' } } }).some((p) => p.base === 'ars'));
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log('phase model: all ok');
