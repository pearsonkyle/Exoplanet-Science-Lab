// Web Worker for image photometry: reads the frames, measures them, searches the apertures, runs the GP.
// Messages in: { type: 'stack', id, files, cfg, cal: { bias, dark, flat: [files] } } | { type: 'tpf', id, buffer, cfg }
//              | { type: 'candidate', id, buffer, mask, cfg } | { type: 'gp', id, lc, opts } | { type: 'sff', id, lc, opts } | { type: 'stop' }
// Messages out: { type: 'progress', id, ... } | { type: 'done', id, result } | { type: 'error', id, message }
import { runStack, runTpf, tpfCandidate, gpDetrend, sffRun, masterFrame } from '../photometry/pipeline.js';

let stop = false;
self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'stop') { stop = true; return; }
  try {
    if (m.type === 'stack') {
      stop = false;
      const cal = {};
      if (m.cal) {
        const prog = (what) => (i, n) => self.postMessage({ type: 'progress', id: m.id, stage: what, done: i, total: n });
        if (m.cal.bias?.length) cal.bias = await masterFrame(m.cal.bias, { onProgress: prog('bias') });
        if (m.cal.dark?.length) cal.dark = await masterFrame(m.cal.dark, { subtract: cal.bias?.data, onProgress: prog('dark') });
        if (m.cal.flat?.length) cal.flat = await masterFrame(m.cal.flat, { subtract: cal.bias?.data, normalise: true, onProgress: prog('flat') });
      }
      const res = await runStack(m.files, { ...m.cfg, cal }, (p) => self.postMessage({ type: 'progress', id: m.id, stage: 'frames', ...p }), () => stop);
      res.cal = { bias: cal.bias?.n || 0, dark: cal.dark?.n || 0, flat: cal.flat?.n || 0 };
      self.postMessage({ type: 'done', id: m.id, result: res });
    } else if (m.type === 'tpf') {
      self.postMessage({ type: 'done', id: m.id, result: await runTpf(m.buffer, m.cfg) });
    } else if (m.type === 'candidate') {
      self.postMessage({ type: 'done', id: m.id, result: await tpfCandidate(m.buffer, m.mask, m.cfg) });
    } else if (m.type === 'sff') {
      self.postMessage({ type: 'done', id: m.id, result: sffRun(m.lc, m.opts) });
    } else if (m.type === 'gp') {
      self.postMessage({ type: 'done', id: m.id, result: gpDetrend(m.lc, m.opts) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
