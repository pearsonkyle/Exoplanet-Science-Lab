// Clock offset estimation (src/core/clocksync.js) against simulated servers whose true offset is known: random,
// asymmetric network delays, whole-second (HTTP Date) and millisecond resolution, a server hiccup. The reference
// here is the simulation's truth; the claim tested is that the true offset lies inside the reported bound, and
// how tight that bound is.
import { sampleBounds, estimateOffset, nextProbeAt, chooseClock, agedUncertainty, describeClock } from '../src/core/clocksync.js';
import { makeRng } from '../src/core/stats.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// one simulated exchange: local send at t0, the server reads its clock after the outbound delay, the answer comes back
function exchange(t0, theta, resolution, rng, { out = [10, 60], back = [10, 60] } = {}) {
  const d1 = out[0] + rng() * (out[1] - out[0]), d2 = back[0] + rng() * (back[1] - back[0]);
  const read = t0 + d1 + theta, server = resolution > 1 ? Math.floor(read / resolution) * resolution : resolution === 1 ? Math.floor(read) : read;
  return { t0, t1: t0 + d1 + d2, server, resolution };
}
function run(theta, resolution, nProbe, rng, net) {
  let now = 1.8e12 + rng() * 1e6, est = null, rtt = 100;
  const samples = [];
  for (let i = 0; i < nProbe; i++) {
    const t0 = nextProbeAt(est, resolution, now, rtt);
    const s = exchange(t0, theta, resolution, rng, net);
    samples.push(s); rtt = Math.min(rtt, s.t1 - s.t0); est = estimateOffset(samples); now = s.t1 + 5;
  }
  return est;
}

const R = makeRng(7), rng = () => R.next();
check('one sample bounds the offset whatever the split of the round trip', (() => {
  const b = sampleBounds({ t0: 1000, t1: 1100, server: 5000, resolution: 1000 }); return b.lo === 3900 && b.hi === 5000 && b.delay === 100;
})());

for (const [label, res, n, net, maxUnc] of [
  ['HTTP Date header (1 s), 8 probes, 20-120 ms round trips', 1000, 8, undefined, 80],
  ['HTTP Date header, asymmetric (out 5-15 ms, back 80-200 ms)', 1000, 8, { out: [5, 15], back: [80, 200] }, 140],
  ['millisecond API, 5 probes', 1, 5, undefined, 60],
]) {
  let covered = 0, worstUnc = 0, worstErr = 0; const N = 400;
  for (let k = 0; k < N; k++) {
    const theta = (rng() - 0.5) * 2 * 3.6e6;                      // up to an hour off
    const e = run(theta, res, n, rng, net);
    const err = Math.abs(e.offset - theta);
    if (err <= e.unc + 1e-9) covered++;
    worstUnc = Math.max(worstUnc, e.unc); worstErr = Math.max(worstErr, err);
  }
  check(label + ': truth inside the bound every time', covered === N, `${covered}/${N}; largest error ${worstErr.toFixed(1)} ms, largest ±${worstUnc.toFixed(1)} ms`);
  check(label + ': bound below 2/3 of the slowest round trip', worstUnc < maxUnc, `largest ±${worstUnc.toFixed(1)} ms; limit ${maxUnc} ms`);
}

// probing on the second boundary beats probing at random times
{
  let a = 0, b = 0; const N = 200;
  for (let k = 0; k < N; k++) {
    const theta = (rng() - 0.5) * 1e5;
    a += run(theta, 1000, 8, rng).unc;
    const samples = []; let now = 1.8e12;
    for (let i = 0; i < 8; i++) { const s = exchange(now, theta, 1000, rng); samples.push(s); now = s.t1 + 150; }
    b += estimateOffset(samples).unc;
  }
  check('probes timed at the second boundary: tighter than evenly spaced ones', a < b / 2, `mean ±${(a / N).toFixed(1)} ms against ±${(b / N).toFixed(1)} ms`);
}

// a sample that disagrees (the laptop slept, the server hiccupped) is dropped
{
  const theta = 2500, samples = [];
  let now = 1.8e12;
  for (let i = 0; i < 6; i++) { const s = exchange(now, theta, 1, rng); samples.push(s); now = s.t1 + 50; }
  samples.push({ t0: now, t1: now + 400, server: now + theta + 5000, resolution: 1 });
  const e = estimateOffset(samples);
  check('an inconsistent slow sample is dropped', !e.consistent && e.dropped === 1 && Math.abs(e.offset - theta) <= e.unc, `offset ${e.offset.toFixed(1)} ± ${e.unc.toFixed(1)} ms (truth ${theta})`);
}

// choosing among sources
{
  const now = 1e6;
  const c = chooseClock([
    { source: 'https-date', label: 'site Date header', offset: 10, unc: 30, at: now },
    { source: 'helper-ntp', label: 'helper NTP', offset: 12, unc: 4, at: now - 3.6e6 },           // an hour old: 4 + 72 ms
    { source: 'serial-gps', label: 'USB GPS', offset: 11, unc: 125, at: now },
  ], now);
  check('the smallest uncertainty after ageing wins', c.source === 'https-date' && Math.abs(agedUncertainty(4, 3.6e6) - 76) < 1e-9, describeClock(c));
  const s = chooseClock([], now);
  check('nothing answered: the system clock, said plainly', s.source === 'system' && s.offset === 0 && describeClock(s) === 'system clock (not checked)');
  check('ties go to the better kind of source', chooseClock([{ source: 'https-date', offset: 0, unc: 5, at: now }, { source: 'helper-gps', offset: 0, unc: 5, at: now }], now).source === 'helper-gps');
}

process.exit(ok ? 0 : 1);
