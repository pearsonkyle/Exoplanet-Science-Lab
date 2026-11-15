import { runFit } from '../core/fitRunner.js';

let stop = false;
self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'stop') { stop = true; return; }
  if (msg.type === 'run') {
    stop = false;
    try {
      const res = await runFit(msg.spec, (p) => self.postMessage({ type: 'progress', p }), () => stop);
      self.postMessage({ type: 'done', res }, [res.samples.buffer, res.weights.buffer, res.logl.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }
};
