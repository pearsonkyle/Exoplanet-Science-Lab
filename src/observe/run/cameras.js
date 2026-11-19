// Camera drivers of the Run page. One interface for every camera:
//   connect() -> props · disconnect() · configure({ gain, offset, bin, coolerOn, setTemp }) · status() -> { ccdTemp, coolerPower, state }
//   expose({ duration [s], kind: 'light'|'bias'|'dark'|'flat', signal }) -> { data, width, height, start [Unix ms], clock, ccdTemp }
//   abort()
// alpacaCamera talks to an ASCOM Alpaca camera over HTTP: the local helper (python -m esl.bridge, which also says
// when the exposure started by its corrected clock) or any Alpaca device that sends CORS headers. simCamera makes
// frames in the page (src/core/simsky.js) so the whole sequence can be tried without hardware.

import { decodeImageBytes } from '../../core/alpacabytes.js';
import { createSimSky } from '../../core/simsky.js';
import clock from '../../site/clock.js';

const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('stopped'), { name: 'AbortError' })); }, { once: true }); });

/** An Alpaca camera at `base` (http://localhost:11111), device `n`. */
export function alpacaCamera(base = 'http://localhost:11111', n = 0) {
  const root = base.replace(/\/+$/, ''), dev = `${root}/api/v1/camera/${n}/`;
  let tx = 0, props = null, helper = false;
  const call = async (method, name, params = {}, { raw = false, signal } = {}) => {
    const q = new URLSearchParams({ ClientID: '4207', ClientTransactionID: String(++tx) });
    let r;
    try {
      if (method === 'GET') { for (const [k, v] of Object.entries(params)) q.set(k, v); r = await fetch(`${dev}${name}?${q}`, { headers: { Accept: raw ? 'application/imagebytes' : 'application/json' }, cache: 'no-store', signal }); }
      else { for (const [k, v] of Object.entries(params)) q.set(k, typeof v === 'boolean' ? String(v) : v); r = await fetch(dev + name, { method: 'PUT', body: q, signal }); }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`The camera at ${root} does not answer. Is the helper running (python -m esl.bridge), and did the browser allow this site to reach the local network?`);
    }
    if (r.status === 403) throw new Error(`The helper refused this page (${location.origin}). Start it with --allow-origin ${location.origin}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${await r.text()}`);
    if (raw && /imagebytes/.test(r.headers.get('content-type') || '')) return new Uint8Array(await r.arrayBuffer());
    const j = await r.json();
    if (j.ErrorNumber) throw Object.assign(new Error(`${name}: ${j.ErrorMessage}`), { code: j.ErrorNumber });
    return j.Value;
  };
  const get = (n2) => call('GET', n2), put = (n2, p) => call('PUT', n2, p);
  const opt = async (n2, d) => { try { const v = await get(n2); return v ?? d; } catch { return d; } };
  return {
    kind: 'alpaca', base: root,
    async connect() {
      await put('connected', { Connected: true });
      try { const r = await fetch(`${root}/esl/info`, { cache: 'no-store' }); helper = r.ok; } catch { helper = false; }
      const [name, width, height, pixelSize, maxBin, sensorType, maxAdu, egain, gainMin, gainMax, offsetMin, offsetMax, canCool] = await Promise.all([
        opt('name', 'Alpaca camera'), get('cameraxsize'), get('cameraysize'), opt('pixelsizex', NaN), opt('maxbinx', 1), opt('sensortype', 0), opt('maxadu', 65535),
        opt('electronsperadu', NaN), opt('gainmin', null), opt('gainmax', null), opt('offsetmin', null), opt('offsetmax', null), opt('cansetccdtemperature', false)]);
      const bayer = sensorType === 2 ? { pattern: 'RGGB', xoff: await opt('bayeroffsetx', 0), yoff: await opt('bayeroffsety', 0) } : null;
      props = { name, width, height, pixelSize, maxBin, sensorType, maxAdu, egain, gain: gainMax != null ? [gainMin, gainMax] : null, offset: offsetMax != null ? [offsetMin, offsetMax] : null, canCool, bayer, helper };
      return props;
    },
    async disconnect() { try { await put('connected', { Connected: false }); } catch { /* gone already */ } },
    async configure({ gain, offset, bin, coolerOn, setTemp } = {}) {
      if (bin) { await put('binx', { BinX: bin }); await put('biny', { BinY: bin }); await put('startx', { StartX: 0 }); await put('starty', { StartY: 0 }); await put('numx', { NumX: Math.floor(props.width / bin) }); await put('numy', { NumY: Math.floor(props.height / bin) }); }
      if (gain != null && props.gain) await put('gain', { Gain: Math.round(gain) });
      if (offset != null && props.offset) await put('offset', { Offset: Math.round(offset) });
      if (props.canCool && setTemp != null) await put('setccdtemperature', { SetCCDTemperature: setTemp });
      if (props.canCool && coolerOn != null) await put('cooleron', { CoolerOn: !!coolerOn });
    },
    async status() { return { ccdTemp: await opt('ccdtemperature', NaN), coolerPower: await opt('coolerpower', NaN), state: await opt('camerastate', null) }; },
    async expose({ duration, kind = 'light', signal } = {}) {
      const before = clock.now(), info0 = clock.info();
      await call('PUT', 'startexposure', { Duration: duration, Light: kind === 'light' || kind === 'flat', ...(helper ? { esl_kind: kind } : {}) }, { signal });
      const after = clock.now();
      let ccdTemp = NaN; opt('ccdtemperature', NaN).then((v) => { ccdTemp = v; });
      await sleep(Math.max(0, duration * 1000 - 50), signal);
      for (let i = 0; !(await call('GET', 'imageready', {}, { signal })); i++) { if (i > 2400) throw new Error('the camera never said the image was ready'); await sleep(Math.min(250, 20 + i * 10), signal); }
      const raw = await call('GET', 'imagearray', {}, { raw: true, signal });
      let img;
      if (raw instanceof Uint8Array) img = decodeImageBytes(raw);
      else {                                                   // JSON ImageArray [x][y]
        const W = raw.length, H = raw[0].length, d = new Int32Array(W * H);
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) d[y * W + x] = raw[x][y];
        img = { data: d, width: W, height: H };
      }
      // when the exposure started: the helper's corrected clock next to the camera; else this page's, with the request's round trip
      let start = before, clk = { source: info0.source, label: info0.label, offset: info0.offset, unc: info0.effUnc == null ? null : info0.effUnc + (after - before) };
      if (helper) { try { const e = await (await fetch(`${root}/esl/exposure`, { cache: 'no-store' })).json(); if (Number.isFinite(e.start)) { start = e.start * 1000; clk = e.clock; } } catch { /* keep the page's */ } }
      return { ...img, start, clock: clk, ccdTemp };
    },
    async abort() { try { await put('abortexposure', {}); } catch { /* nothing running */ } },
    get props() { return props; },
  };
}

/** A camera that makes its frames in the page (src/core/simsky.js). `speed` > 1 runs exposures faster than real time (tests). */
export function simCamera({ width = 320, height = 240, tmid = null, depth = 0.01, duration = 2, site = null, target = null, speed = 1, seed = 7, flux = 4000, t0 = null, tracking = 'average', lightCurve = null, now = null, clockInfo = null } = {}) {
  const tnow = now || (() => clock.now());
  let sky = null, frameNo = 0, ccdTemp = 20, setT = -10, coolerOn = false, bin = 1;
  const props = { name: 'Simulated camera (in this page)', width, height, pixelSize: 3.76, maxBin: 1, sensorType: 0, maxAdu: 65535, egain: 1, gain: [0, 300], offset: [0, 100], canCool: true, bayer: null, helper: false };
  return {
    kind: 'sim', props,
    async connect() { sky = createSimSky({ width, height, tmid: tmid ?? tnow() + 3600e3, depth, duration, site, target, seed, flux, centre: true, tracking: tracking === 'off' ? null : tracking, lightCurve, ...(t0 != null ? { t0 } : {}) }); return props; },
    async disconnect() { sky = null; },
    async configure(o = {}) { if (o.setTemp != null) setT = o.setTemp; if (o.coolerOn != null) coolerOn = !!o.coolerOn; if (o.bin) bin = 1; },
    async status() { ccdTemp += Math.max(-3, Math.min(3, (coolerOn ? setT : 20) - ccdTemp)); return { ccdTemp, coolerPower: coolerOn ? Math.min(100, 3 * (20 - setT)) : 0, state: 0 }; },
    async expose({ duration: d, kind = 'light', signal } = {}) {
      if (!sky) throw new Error('connect the camera first');
      const start = tnow(), info = clockInfo ? clockInfo() : clock.info();
      await sleep(d * 1000 / speed + 30, signal);
      const data = Uint16Array.from(sky.frame(kind, start, d, frameNo++));
      // the simulation's truth for this frame (pointing offset, PSF width), for the telemetry plots
      return { data, width, height, start, clock: { source: info.source, label: info.label, offset: info.offset, unc: info.effUnc ?? info.unc }, ccdTemp, truth: kind === 'light' ? sky.last : null };
    },
    async abort() {},
    get truth() { return sky && sky.truth; },
  };
}
