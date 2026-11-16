// ESL's own slow results, stored for the Validation page so it has something to show before (or without) recomputing:
//   node tools/validation/esl_reference.mjs            (about 8 minutes)
// Writes public/validation/esl.json:
//   fits      posterior summaries and ln Z of the four problems in fits.json, from MiniNest in Node
//   coverage  posterior ranks of the truth over 300 simulated data sets per problem (src/validation/compute.js, COVERAGE)
//   timing    light curves per second in Node for the timing cases of transit.json
// The printed outcome of the project's other tests is stored separately, by tools/validation/project_reference.mjs.
// The page recomputes the cheap comparisons live and can re-run the fits; test/validation.test.mjs re-runs the fits and a
// sample of the coverage realisations and checks they reproduce what is stored here.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import * as C from '../../src/validation/compute.js';
const root = new URL('../../', import.meta.url), J = (n) => JSON.parse(readFileSync(new URL('public/validation/' + n + '.json', root)));
const only = process.argv.slice(2), want = (k) => !only.length || only.includes(k);
let prev = {}; try { prev = J('esl'); } catch { /* first run */ }
const out = { ...prev, date: new Date().toISOString().slice(0, 10), node: process.version, machine: `${os.cpus()[0].model}, ${os.platform()} ${os.arch()}` };
const r4 = (x) => Number(x.toPrecision(5));

if (want('timing')) {
  const T = J('transit'); out.timing = {};
  for (const tc of T.timing) { out.timing[tc.key] = Math.round(Math.max(C.timeTransit(tc, 1.5), C.timeTransit(tc, 1.5))); console.log('timing', tc.key, out.timing[tc.key], 'light curves per second'); }
}
if (want('fits')) {
  out.fits = {};
  for (const P of J('fits').problems) {
    const S = await C.runProblem(P); out.fits[P.id] = { ...S, sampler: 'MiniNest, 400 live points, seed 42' };
    const cmp = C.compareFit(P, S);
    console.log('fit', P.id, cmp.ok ? 'ok' : 'OUTSIDE TOLERANCE', cmp.rows.map((r) => `${r.key} ${r.dMean.toFixed(3)}σ ${(100 * r.dWidth).toFixed(1)}%`).join('  '), '| lnZ', cmp.lnZ.map((z) => `${z.name} ${z.diff.toFixed(3)} (${z.sigma.toFixed(2)}σ)`).join('  '), `| ${S.ncalls} calls, ${S.elapsed.toFixed(1)} s`);
  }
}
if (want('seeds')) {
  // ln Z from eight different seeds: is the scatter what the reported error says, and is the mean on the reference?
  out.seeds = {};
  for (const P of J('fits').problems) {
    const z = [], err = [];
    for (let s = 1; s <= 8; s++) { const S = await C.runProblem(P, { nlive: 400, seed: s }); z.push(r4(S.logZ) * 1 === 0 ? 0 : Number(S.logZ.toFixed(4))); err.push(Number(S.logZerr.toFixed(4))); }
    const m = z.reduce((a, b) => a + b) / z.length, sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1));
    out.seeds[P.id] = { logZ: z, logZerr: err, mean: m, sd };
    console.log('seeds', P.id, 'mean', m.toFixed(3), 'scatter', sd.toFixed(3), 'reported', (err.reduce((a, b) => a + b) / 8).toFixed(3), 'dynesty', P.samplers.dynesty.logZ.toFixed(3), '+-', P.samplers.dynesty.logZerr.toFixed(3));
  }
}
if (want('coverage')) {
  out.coverage = {};
  for (const kind of Object.keys(C.COVERAGE)) {
    const n = C.COVERAGE[kind].n, ranks = []; let calls = 0; const t0 = Date.now();
    for (let i = 0; i < n; i++) { const r = await C.coverageRun(kind, i); ranks.push(r.rank.map(r4)); calls += r.ncalls; if (i % 50 === 49) console.log('coverage', kind, i + 1); }
    out.coverage[kind] = { ranks, meanCalls: Math.round(calls / n), seconds: Math.round((Date.now() - t0) / 1000), sampler: 'MiniNest, 200 live points, seed 100 + i' };
    console.log('coverage', kind, C.coverageSummary(kind, ranks).map((s) => `${s.key} 68%: ${(100 * s.c68).toFixed(1)}  95%: ${(100 * s.c95).toFixed(1)}  hist ${s.hist.join(',')}`).join(' | '));
  }
}
delete out.tests;   // the outcome of the other test files moved to project.json (tools/validation/project_reference.mjs)
const path = fileURLToPath(new URL('public/validation/esl.json', root));
writeFileSync(path, JSON.stringify(out));
console.log('wrote', path, Math.round(JSON.stringify(out).length / 1024), 'kB');
