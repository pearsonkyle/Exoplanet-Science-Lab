// Drives MiniNest in small slices so the host (worker or main thread) can
// report progress and react to a stop request.

import { MiniNest } from './nested.js';
import { buildProblem } from './model.js';

export async function runFit(spec, onProgress, shouldStop) {
  const prob = buildProblem(spec);
  const t0 = performance.now();
  const ns = new MiniNest({
    ndim: prob.ndim, loglike: prob.loglike, transform: prob.transform,
    nlive: spec.sampler?.nlive ?? 400, fracRemain: spec.sampler?.fracRemain ?? 0.01,
    seed: spec.sampler?.seed ?? 42, maxCalls: spec.sampler?.maxCalls ?? 2e6,
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
