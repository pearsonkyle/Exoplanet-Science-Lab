// Host shims for running the core outside a browser or Node: an embedded V8 (PyMiniRacer) or QuickJS has the
// language but none of the web platform. Imported first by the bundle entry that tools/build_core_bundle.mjs
// generates, so these exist before any core module is evaluated (the limb darkening table decodes base64 at
// import, fits.js makes a TextDecoder, fitRunner.js reads the clock and yields with setTimeout).
// Nothing here touches numerics. Each shim is installed only where the host lacks the real thing.

const G = globalThis;

if (typeof G.performance === 'undefined' || typeof G.performance.now !== 'function') {
  const t0 = Date.now();
  G.performance = { now: () => Date.now() - t0 };
}

if (typeof G.atob !== 'function') {
  const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', LUT = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) LUT[ABC.charCodeAt(i)] = i;
  G.atob = (b64) => {
    const s = String(b64).replace(/[\s=]+/g, ''), parts = [];
    let buf = 0, bits = 0, chunk = [];
    for (let i = 0; i < s.length; i++) {
      const v = LUT[s.charCodeAt(i) & 127];
      if (v < 0) throw new Error('atob: invalid character');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; chunk.push((buf >> bits) & 255); if (chunk.length === 8192) { parts.push(String.fromCharCode.apply(null, chunk)); chunk = []; } }
    }
    parts.push(String.fromCharCode.apply(null, chunk));
    return parts.join('');
  };
}

if (typeof G.TextDecoder === 'undefined') {
  // latin1 exactly; utf-8 for the basic plane and beyond (enough for FITS headers and text files)
  G.TextDecoder = class TextDecoder {
    constructor(label = 'utf-8') { this.encoding = String(label).toLowerCase(); }
    decode(input) {
      const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
      let out = '';
      if (this.encoding === 'latin1' || this.encoding === 'iso-8859-1' || this.encoding === 'ascii') { for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return out; }
      for (let i = 0; i < b.length;) {
        const c = b[i++];
        if (c < 128) out += String.fromCharCode(c);
        else if (c < 224) out += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
        else if (c < 240) { out += String.fromCharCode(((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63)); i += 2; }
        else { const cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; out += String.fromCodePoint(cp); }
      }
      return out;
    }
  };
}

if (typeof G.console === 'undefined') {
  const log = []; const push = (...a) => { if (log.length < 200) log.push(a.map(String).join(' ')); };
  G.console = { log: push, warn: push, error: push, info: push, debug: push, _lines: log };
}

/**
 * Timers. A host with an event loop (Node, a browser) has setTimeout and nothing is done. An embedded engine has
 * none, or has one whose loop the caller does not drive: there `manualTimers()` replaces setTimeout by a queue
 * that the host empties with `pumpTimers()` between calls. fitRunner.js yields with `setTimeout(r, 0)` about
 * eight times a second, so one pump lets a fit advance by one slice and hands control back to Python (which is
 * how progress is streamed and a stop request gets through).
 */
const queue = [];
let manual = false;
export function manualTimers() {
  if (manual) return;
  manual = true;
  G.setTimeout = (fn, _ms, ...args) => { queue.push(() => fn(...args)); return queue.length; };
  G.clearTimeout = () => {};
}
export function pumpTimers() {
  const run = queue.splice(0);
  for (const fn of run) fn();
  return run.length;
}
export const timersPending = () => queue.length;
if (typeof G.setTimeout !== 'function') manualTimers();
