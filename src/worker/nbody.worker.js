// Web Worker for src/core/nbody.js. Two kinds of message:
//
// 1. A slice of the perturber grid (a pool of these, one per core, divides a grid; see test/nbody_harness.html):
//      postMessage({ id, obs: { t, e }, base, opt, cells: [{ q, mass, period }] })
//      -> { id, done: [{ q, chi2, amp, phase, stable }], nSim, seconds }
//
// 2. A stability report with its integration and MEGNO, which takes a second or more and should not block the page:
//      postMessage({ id, task: 'stability', system, opt })      opt as in stabilityReport, e.g. { integrate: 1000 }
//      -> { id, task: 'stability', report }                     (or { id, task, error })
//      postMessage({ id, task: 'megno', system, opt })          opt as in megno, e.g. { orbits: 3000 }
//      -> { id, task: 'megno', result }
import { ttvGridPrepare, ttvGridCell, stabilityReport, megno } from '../core/nbody.js';

self.onmessage = (ev) => {
  const { id, task, obs, base, opt, cells, system } = ev.data, t0 = performance.now();
  if (task === 'stability' || task === 'megno') {
    try {
      if (task === 'megno') self.postMessage({ id, task, result: megno(system, opt || {}) });
      else self.postMessage({ id, task, report: stabilityReport(system, opt || {}) });
    } catch (err) { self.postMessage({ id, task, error: String(err.message || err) }); }
    return;
  }
  const prep = ttvGridPrepare(obs, base, opt), done = [];
  for (const c of cells) { const r = ttvGridCell(prep, c.mass, c.period); done.push({ q: c.q, chi2: r.chi2, amp: r.amp, phase: r.phase, stable: r.stable && r.chi2 < Infinity ? 1 : 0 }); }
  self.postMessage({ id, done, nSim: prep.nSim, seconds: (performance.now() - t0) / 1000 });
};
