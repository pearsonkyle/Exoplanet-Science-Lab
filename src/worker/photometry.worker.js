// Web Worker for image photometry: reads the frames, measures them, searches the apertures, runs the GP.
// Messages in: { type: 'stack', id, files, cfg, cal: { bias, dark, flat: [files] } } | { type: 'tpf', id, buffer, cfg }
//              | { type: 'candidate', id, buffer, mask, cfg } | { type: 'gp', id, lc, opts } | { type: 'sff', id, lc, opts } | { type: 'regress', id, lc, spec, opts } | { type: 'stop' }
//              | { type: 'parts', id, items: [{ buffer, name, kind: 'lc' | 'tpf' }], opts }: light-curve files and TPFs to parts (src/photometry/prep.js)
//              | { type: 'prep', id, parts, planets, opts }: prepare parts for transit fitting | { type: 'pld', id, buffer, mask, good, opts }: K2 PLD of one TPF
// Messages out: { type: 'progress', id, ... } | { type: 'done', id, result } | { type: 'error', id, message }
import { runStack, runTpf, tpfCandidate, gpDetrend, sffRun, masterFrame, regressDetrend, k2Pld, k2Thrusters } from '../photometry/pipeline.js';
import { partFromLcFits, partFromTpf, prepareParts } from '../photometry/prep.js';
import { openFits, readTargetPixelFile } from '../core/fits.js';
import { cdpp } from '../core/lcprep.js';

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
    } else if (m.type === 'regress') {
      self.postMessage({ type: 'done', id: m.id, result: regressDetrend(m.lc, m.spec, m.opts) });
    } else if (m.type === 'parts') {
      const parts = [], errors = [];
      for (let k = 0; k < m.items.length; k++) {
        const it = m.items[k];
        self.postMessage({ type: 'progress', id: m.id, stage: 'parts', done: k, total: m.items.length, name: it.name });
        try { parts.push(it.kind === 'tpf' ? await partFromTpf(it.buffer, it.name, m.opts || {}) : await partFromLcFits(it.buffer, it.name, m.opts || {})); } catch (err) { errors.push({ name: it.name, error: String(err.message || err) }); }
      }
      self.postMessage({ type: 'done', id: m.id, result: { parts, errors } });
    } else if (m.type === 'prep') {
      self.postMessage({ type: 'done', id: m.id, result: prepareParts(m.parts, m.planets, m.opts || {}, (p) => self.postMessage({ type: 'progress', id: m.id, ...p })) });
    } else if (m.type === 'pld') {
      const tpf = readTargetPixelFile(await openFits(m.buffer)), t0 = performance.now();
      let good = m.good; const th = m.opts && m.opts.thrusters && tpf.mission === 'K2' ? k2Thrusters(tpf, m.mask) : null; if (th) good = good.filter((c) => !th.flags[c]);
      const r = k2Pld(tpf, m.mask, good, m.opts || {});
      if (!r) throw new Error('The PLD fit failed (too few pixels or cadences).');
      const med = r.corrected.slice().sort((a, b) => a - b)[r.corrected.length >> 1];
      self.postMessage({ type: 'done', id: m.id, result: { good, corrected: Float64Array.from(r.corrected, (v) => v / med), cdppBefore: cdpp(r.time, r.flux), cdppAfter: cdpp(r.time, r.corrected), ncols: r.ncols, names: r.names, clipped: r.clipped, thrusters: th ? { dropped: m.good.length - good.length, fromQuality: th.fromQuality, fromCentroid: th.fromCentroid } : null, ms: performance.now() - t0, kind: 'pld', order: (m.opts && m.opts.order) ?? 3 } });
    } else if (m.type === 'gp') {
      self.postMessage({ type: 'done', id: m.id, result: gpDetrend(m.lc, m.opts) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
