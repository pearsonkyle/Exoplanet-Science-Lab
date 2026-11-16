// Web Worker for the spectroscopy page: one white-light fit (nested sampling, with progress) or one channel fit per message.
// In:  { type: 'white', id, lc, sys, opts } | { type: 'channel', id, ch, geo, opts }
// Out: { type: 'progress', id, ... } | { type: 'done', id, result } | { type: 'error', id, message }
import { fitWhiteLight, fitChannel } from '../core/spectroscopy.js';

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'white') {
      const result = await fitWhiteLight(m.lc, m.sys, m.opts, (p) => self.postMessage({ type: 'progress', id: m.id, ncalls: p.ncalls, remFrac: p.remFrac, logZ: p.logZ, callsFrac: p.callsFrac, elapsed: p.elapsed }));
      self.postMessage({ type: 'done', id: m.id, result });
    } else if (m.type === 'channel') {
      self.postMessage({ type: 'done', id: m.id, result: await fitChannel(m.ch, m.geo, m.opts) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
