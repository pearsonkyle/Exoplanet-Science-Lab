// Light-curve edits of the analyzer (src/ui/dataedit.js: trim, sigma clip, bin, keep) against values worked out
// independently here: the weighted mean and its error written out term by term, the MAD scatter of a known sample,
// and the white-noise scaling of binned errors (sigma / sqrt(N)).
//   node test/dataedit.test.mjs
import { keepPoints, trimData, clipData, binData } from '../src/ui/dataedit.js';
import { combineEpochs } from '../src/core/data.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// ---- binning: three points by hand ------------------------------------------------------------------------
{
  const d = { name: 'x', tRef: 0, t: Float64Array.of(0, 0.001, 0.002, 0.011, 0.012), f: Float64Array.of(1.0, 0.998, 1.004, 0.99, 0.992), e: Float64Array.of(0.001, 0.002, 0.004, 0.001, 0.001), airmass: Float64Array.of(1.1, 1.2, 1.3, 1.4, 1.5) };
  const b = binData(d, 0.01);
  const w = [1e6, 2.5e5, 6.25e4], sw = w[0] + w[1] + w[2];
  const f0 = (w[0] * 1.0 + w[1] * 0.998 + w[2] * 1.004) / sw, t0 = (w[1] * 0.001 + w[2] * 0.002) / sw, a0 = (w[0] * 1.1 + w[1] * 1.2 + w[2] * 1.3) / sw;
  check('bin: two bins from five points', b.t.length === 2);
  check('bin: weighted mean flux, time and airmass of the first bin', Math.abs(b.f[0] - f0) < 1e-15 && Math.abs(b.t[0] - t0) < 1e-15 && Math.abs(b.airmass[0] - a0) < 1e-15, `f ${b.f[0].toFixed(9)} (by hand ${f0.toFixed(9)})`);
  check('bin: error of the first bin is 1/sqrt(sum w)', Math.abs(b.e[0] - 1 / Math.sqrt(sw)) < 1e-18, `${b.e[0].toExponential(6)}`);
  check('bin: second bin is the plain mean with error sigma/sqrt(2)', Math.abs(b.f[1] - 0.991) < 1e-15 && Math.abs(b.e[1] - 0.001 / Math.SQRT2) < 1e-18);
  check('bin: the input is untouched', d.t.length === 5 && d.e[0] === 0.001);
}

// ---- binning white noise: scatter and error bars both fall as 1/sqrt(N) ------------------------------------
{
  const rng = makeRng(3), n = 20000, sig = 1e-3, t = new Float64Array(n), f = new Float64Array(n), e = new Float64Array(n).fill(sig);
  for (let i = 0; i < n; i++) { t[i] = (i + 0.5) / 1440; f[i] = 1 + sig * rng.normal(); }
  const b = binData({ name: 'wn', tRef: 0, t, f, e, airmass: null }, 10 / 1440);
  let s = 0; for (let i = 0; i < b.f.length; i++) s += (b.f[i] - 1) ** 2;
  const rms = Math.sqrt(s / b.f.length), want = sig / Math.sqrt(10);
  check('bin: 20000 one-minute points in 10-minute bins give 2000 points', b.t.length === 2000, `${b.t.length}`);
  check('bin: error bars are sigma/sqrt(10)', Math.abs(b.e[7] / want - 1) < 1e-12);
  check('bin: scatter of the binned flux is sigma/sqrt(10) within 5%', Math.abs(rms / want - 1) < 0.05, `rms ${(rms * 1e6).toFixed(1)} ppm, expected ${(want * 1e6).toFixed(1)} ppm`);
}

// ---- clipping ---------------------------------------------------------------------------------------------
{
  // residuals 1..9 in units of 1e-4 and one outlier: median 5.5e-4, MAD 2.5e-4, scatter 1.4826 * 2.5e-4
  const r = [1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map((x) => x * 1e-4), n = r.length;
  const d = { name: 'c', tRef: 0, t: Float64Array.from({ length: n }, (_, i) => i * 0.01), f: Float64Array.from(r, (x) => 1 + x), e: new Float64Array(n).fill(1e-4), airmass: null };
  const c = clipData(d, r, 4);
  check('clip: robust scatter is 1.4826 x MAD', Math.abs(c.scatter[0] - 1.4826 * 2.5e-4) < 1e-18, `${(c.scatter[0] * 1e6).toFixed(2)} ppm`);
  check('clip: the outlier goes, nothing else', c.removed === 1 && c.data.t.length === 9 && c.data.f[8] === 1 + 9e-4);
  const none = clipData(d, r, 100);
  check('clip: a loose threshold removes nothing', none.removed === 0);
}

// ---- trim and keep with several epochs --------------------------------------------------------------------
{
  const mk = (t0, n, am) => ({ name: 'n' + t0, tRef: 0, t: Float64Array.from({ length: n }, (_, i) => t0 + i * 0.01), f: new Float64Array(n).fill(1), e: new Float64Array(n).fill(1e-3), airmass: am ? new Float64Array(n).fill(1.5) : null });
  const d = combineEpochs([mk(0, 10, true), mk(5, 12, false), mk(10, 8, true)]);
  const a = trimData(d, 4.9, 20);
  check('trim: the first epoch is gone, two are left and renumbered', a.segments.length === 2 && a.epoch[0] === 0 && a.epoch[a.epoch.length - 1] === 1 && a.t.length === 20);
  check('trim: segment sizes and spans recomputed', a.segments[0].n === 12 && a.segments[1].n === 8 && Math.abs(a.segments[0].t0 - 5) < 1e-12 && Math.abs(a.segments[1].t1 - 10.07) < 1e-12);
  check('trim: airmass flags follow their epochs', a.segments[0].airmass === false && a.segments[1].airmass === true && a.airmass.length === 20);
  const one = trimData(d, 4.9, 5.2);
  check('trim to one epoch gives a single light curve without an airmass column', !one.epoch && !one.segments && one.airmass === null && one.t.length === 12);
  const half = keepPoints(d, (i) => i % 2 === 0);
  check('keep: every second point, three epochs kept', half.t.length === 15 && half.segments.length === 3 && half.segments.map((s) => s.n).join() === '5,6,4');
  let threw = false; try { trimData(d, 100, 200); } catch (err) { threw = /every point/.test(err.message); }
  check('an edit that would remove every point is refused in plain words', threw);
  const b = binData(d, 0.05);
  check('bin: bins do not straddle epochs', b.segments.map((s) => s.n).join() === '2,3,2', b.segments.map((s) => s.n).join());
}
process.exit(ok ? 0 : 1);
