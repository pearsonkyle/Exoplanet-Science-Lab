// The same session run by Node directly on src/core (no bundle, no Python): the reference speed.
// usage: node python/benchmarks/native.mjs session.json
import { readFileSync } from 'node:fs';
import { runSession, specFromSession } from '../../src/core/session.js';
import { buildProblem } from '../../src/core/model.js';
const s = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const spec = specFromSession(s), prob = buildProblem(spec), th = new Float64Array(prob.ndim), u = new Float64Array(prob.ndim).fill(0.5);
prob.transform(u, th);
for (let i = 0; i < 2000; i++) prob.loglike(th);
let t0 = performance.now(); const N = 20000; for (let i = 0; i < N; i++) prob.loglike(th);
const perCall = (performance.now() - t0) / N;
t0 = performance.now();
const out = await runSession(s, {});
const sec = (performance.now() - t0) / 1000, r = out.session.result;
console.log(JSON.stringify({ runtime: 'node native ' + process.version, likelihood_us: perCall * 1000, ncalls: r.ncalls, seconds: sec, calls_per_s: r.ncalls / sec, logZ: r.logZ, medians: r.parameters.map((p) => p.median) }));
