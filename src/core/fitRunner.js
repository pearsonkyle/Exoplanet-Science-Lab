// Drives MiniNest in small slices so the host (worker or main thread) can
// report progress and react to a stop request.
//
// spec.sampler = { nlive (400), fracRemain (0.01), seed (42),
//                  maxCalls (1e6): budget of likelihood calls; the run stops cleanly when it is used up,
//                  maxSeconds (none): wall-clock budget,
//                  method ('auto' | 'region' | 'slice'), sliceSteps }
// A run that ends on a budget or on a stop request still returns a usable weighted posterior:
// res.converged is false, res.stopReason says why ('max calls reached', 'time limit reached',
// 'stopped by user'), res.budget has the numbers and res.warnings says it in words.
// onProgress receives MiniNest.progress() (it, ncalls, logZ, remFrac, eff, mode, bestL, best, live,
// maxCalls, callsFrac, maxSeconds, nclusters) plus elapsed [s] and keys.

import { MiniNest } from './nested.js';
import { buildProblem, paramFor } from './model.js';

/** Display name of a free parameter for the warnings: registry label, with the planet or dataset it belongs to. */
function labelFor(key) {
  const p = paramFor(key), sfx = key.includes('@') ? key.slice(key.indexOf('@') + 1) : '';
  if (!p) return key;
  if (!sfx) return p.label;
  return p.key === 'a2' ? `${p.label} (epoch ${sfx})` : p.key === 'jit' ? `${p.label} (${sfx})` : `${p.label} (${sfx})`;
}

export async function runFit(spec, onProgress, shouldStop) {
  const prob = buildProblem(spec);
  const t0 = performance.now();
  const ns = new MiniNest({
    ndim: prob.ndim, loglike: prob.loglike, transform: prob.transform,
    nlive: spec.sampler?.nlive ?? 400, fracRemain: spec.sampler?.fracRemain ?? 0.01,
    seed: spec.sampler?.seed ?? 42, maxCalls: spec.sampler?.maxCalls ?? 1e6, maxSeconds: spec.sampler?.maxSeconds,
    method: spec.sampler?.method, sliceSteps: spec.sampler?.sliceSteps,
    names: prob.keys, labels: prob.keys.map(labelFor),
  });
  let last = 0, stopped = false;
  while (!ns.done) {
    ns.step(25);
    const now = performance.now();
    if (now - last > 120) {
      last = now;
      onProgress({ ...ns.progress(), elapsed: (now - t0) / 1000, keys: prob.keys });
      await new Promise((r) => setTimeout(r, 0)); // let stop messages through
      if (shouldStop()) { stopped = true; break; }
    }
  }
  if (stopped && !ns.done) ns._stop('stopped by user');
  const res = ns.result();
  res.keys = prob.keys;
  res.elapsed = (performance.now() - t0) / 1000;
  return res;
}
