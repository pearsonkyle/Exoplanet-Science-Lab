// Web Worker for the perturber grid of src/core/nbody.js: evaluates a slice of grid cells and posts them back.
// A pool of these (one per core) divides a grid among themselves; see test/nbody_harness.html for a pool.
//
//   postMessage({ id, obs: { t, e }, base, opt, cells: [{ q, mass, period }] })
//   -> { id, done: [{ q, chi2, amp, phase, stable }], nSim, seconds }
import { ttvGridPrepare, ttvGridCell } from '../core/nbody.js';

self.onmessage = (ev) => {
  const { id, obs, base, opt, cells } = ev.data, t0 = performance.now();
  const prep = ttvGridPrepare(obs, base, opt), done = [];
  for (const c of cells) { const r = ttvGridCell(prep, c.mass, c.period); done.push({ q: c.q, chi2: r.chi2, amp: r.amp, phase: r.phase, stable: r.stable && r.chi2 < Infinity ? 1 : 0 }); }
  self.postMessage({ id, done, nSim: prep.nSim, seconds: (performance.now() - t0) / 1000 });
};
