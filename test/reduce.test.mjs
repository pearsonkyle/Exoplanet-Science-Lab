// The frame-at-a-time reducer (src/core/reduce.js) on a simulated night (src/core/simsky.js): frames written as
// FITS by frameHeader + encodeFits and read back, calibrated with master bias / dark / flat, reduced one by one.
// References: the injected transit (depth, mid-time, duration) of the simulation, and runStack's own arrays
// (growing the measurement arrays frame by frame must give exactly what a stack sized up front gives).
import { createReducer, growMeasurements } from '../src/core/reduce.js';
import { createSimSky } from '../src/core/simsky.js';
import { frameHeader } from '../src/core/fitsheader.js';
import { encodeFits, parseFits, readImage } from '../src/core/fits.js';
import { fluxOf, makeMeasurements, trapezoid } from '../src/core/photometry.js';
import { jdFromMs } from '../src/core/timescale.js';
import { utcToBjdTdb } from '../src/core/fits.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const site = { name: 'Kitt Peak', lat: 31.9583, lon: -111.5967, elev: 2096 }, target = { name: 'HAT-P-32', ra: 31.0428, dec: 46.6878 };
const tmid = Date.UTC(2026, 10, 19, 6, 30), W = 160, H = 120, EXP = 60, CAD = 90e3;
const sky = createSimSky({ width: W, height: H, tmid, depth: 0.012, duration: 2, site, target, flux: 6000, seed: 11 });
const camera = { name: 'Simulated', width: W, height: H, pixelSize: 3.76, gain: 100, egain: 1 }, telescope = { name: 'Sim', focalLength: 1625 };
const fits = (img, kind, start, i) => encodeFits(img, W, H, frameHeader({ exposure: { start, duration: kind === 'bias' ? 0 : kind === 'flat' ? 1 : EXP, kind }, clock: { source: 'https-date', label: 'test', offset: 0, unc: 20 }, site, target, camera, telescope, sequence: { id: 's', frame: i } }), { bitpix: 16 });
const read = (bytes, name) => { const f = parseFits(bytes), im = readImage(f); return { data: Float32Array.from(im.data), width: im.width, height: im.height, header: f.hdus[0].header, comments: f.hdus[0].comments, name }; };
const median = (frames) => { const out = new Float32Array(W * H), b = new Float64Array(frames.length); for (let p = 0; p < out.length; p++) { frames.forEach((f, k) => { b[k] = f[p]; }); b.sort(); out[p] = b[b.length >> 1]; } return out; };

// calibration frames, as a sequence takes them before the night
const t0 = tmid - 3.2 * 3600e3;
const bias = median(Array.from({ length: 7 }, (_, i) => read(fits(sky.frame('bias', t0, 0, 1000 + i), 'bias', t0, i), 'b').data));
const dark = median(Array.from({ length: 5 }, (_, i) => read(fits(sky.frame('dark', t0, EXP, 2000 + i), 'dark', t0, i), 'd').data)).map((v, p) => v - bias[p]);
const flatRaw = median(Array.from({ length: 7 }, (_, i) => read(fits(sky.frame('flat', t0, 1, 3000 + i), 'flat', t0, i), 'f').data)).map((v, p) => v - bias[p]);
const fm = [...flatRaw].sort((a, b) => a - b)[flatRaw.length >> 1], flat = flatRaw.map((v) => v / fm);
const calibrate = (d) => { for (let p = 0; p < d.length; p++) d[p] = (d[p] - bias[p] - dark[p]) / flat[p]; return d; };

// the night: 6.4 h around mid-transit, one frame every 90 s
const n = Math.floor(6.4 * 3600e3 / CAD), T = sky.truth;
const cfg = { stars: [T.target, ...T.comps], target, site, timeAt: 'start', psf: 'none', optimal: false, apertures: [5, 6, 7, 8], annuli: [12, 18] };
const R = createReducer(cfg, { capacity: 4 }), R2 = createReducer(cfg, { capacity: n });
let live = [];
for (let i = 0; i < n; i++) {
  const start = t0 + i * CAD, fr = read(fits(sky.frame('light', start, EXP, i), 'light', start, i), `f${i}.fits`);
  calibrate(fr.data);
  live.push(R.add(fr));
  R2.add({ ...fr, data: Float32Array.from(fr.data) });
}
const A = R.result(), B = R2.result();
check('every frame measured, frame by frame', A.M.count === n && A.frames.length === n && A.frames.every((f) => f.scale === 'BJD_TDB'), `${n} frames; arrays grew from 4 to ${A.M.nF}`);
const same = ['time', 'airmass', 'x', 'y', 'raw', 'area', 'bg'].every((k) => { for (let i = 0; i < n * (A.M[k].length / A.M.nF); i++) if (!(A.M[k][i] === B.M[k][i] || (Number.isNaN(A.M[k][i]) && Number.isNaN(B.M[k][i])))) return false; return true; });
check('growing arrays: identical to a reducer sized up front (as runStack)', same);
check('growMeasurements keeps NaN fills and the frames already there', (() => { const m = makeMeasurements(2, 2, [3], [8]); m.time[0] = 5; m.count = 1; const g = growMeasurements(m, 5); return g.nF === 5 && g.time[0] === 5 && Number.isNaN(g.time[3]) && g.count === 1 && g.raw.length === 5 * 2; })());

// times: the BJD_TDB of mid-exposure from the header we wrote
const bjd0 = utcToBjdTdb(jdFromMs(t0 + EXP * 500), target.ra, target.dec);
check('frame times are BJD_TDB at mid-exposure', Math.abs(A.M.time[0] - bjd0) * 86400 < 1e-3, `${((A.M.time[0] - bjd0) * 86400 * 1000).toFixed(3)} ms`);

// the light curve: target over the summed comparisons at a 7 px aperture; depth by least squares with the injected shape
const a = 2, nn = 0, tgt = fluxOf(A.M, 0, a, nn), comps = [1, 2, 3, 4].map((s) => fluxOf(A.M, s, a, nn));
const rel = Array.from(tgt, (v, f) => v / comps.reduce((s, c) => s + c[f], 0));
const tmidBjd = utcToBjdTdb(jdFromMs(tmid), target.ra, target.dec), shape = Array.from(A.M.time, (t, f) => (f < n ? trapezoid(t, tmidBjd, T.duration) : 0)).slice(0, n);
// model: rel = c0 + c1 (t - t̄) + c2 (airmass - 1) - depth * c0 * shape   (linear in c0, c1, c2, d = depth * c0)
const tb = A.M.time.slice(0, n).reduce((s, t) => s + t, 0) / n;
const X = rel.map((_, f) => [1, A.M.time[f] - tb, A.M.airmass[f] - 1, -shape[f]]);
const solve = (X, y) => { const k = X[0].length, N = Array.from({ length: k }, () => new Float64Array(k + 1)); X.forEach((r, i) => { for (let p = 0; p < k; p++) { for (let q = 0; q < k; q++) N[p][q] += r[p] * r[q]; N[p][k] += r[p] * y[i]; } }); for (let p = 0; p < k; p++) { for (let r = p + 1; r < k; r++) { const m = N[r][p] / N[p][p]; for (let q = p; q <= k; q++) N[r][q] -= m * N[p][q]; } } const c = new Float64Array(k); for (let p = k - 1; p >= 0; p--) { let s = N[p][k]; for (let q = p + 1; q < k; q++) s -= N[p][q] * c[q]; c[p] = s / N[p][p]; } return { c, N }; };
const { c } = solve(X, rel);
const resid = rel.map((y, f) => y - X[f].reduce((s, x, p) => s + x * c[p], 0)), sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / (n - 4));
// error of the depth from the normal matrix
const k4 = 4, NN = Array.from({ length: k4 }, () => new Float64Array(k4)); X.forEach((r) => { for (let p = 0; p < k4; p++) for (let q = 0; q < k4; q++) NN[p][q] += r[p] * r[q]; });
const inv = (() => { const m = NN.map((r, i) => [...r, ...Array.from({ length: k4 }, (_, j) => (i === j ? 1 : 0))]); for (let p = 0; p < k4; p++) { const pv = m[p][p]; for (let q = 0; q < 2 * k4; q++) m[p][q] /= pv; for (let r = 0; r < k4; r++) if (r !== p) { const f = m[r][p]; for (let q = 0; q < 2 * k4; q++) m[r][q] -= f * m[p][q]; } } return m.map((r) => r.slice(k4)); })();
const depth = c[3] / c[0], err = sd * Math.sqrt(inv[3][3]) / c[0];
check('injected 1.2% transit recovered from the live reduction', Math.abs(depth - T.depth) < 3 * err + 5e-4, `depth ${(depth * 100).toFixed(3)} ± ${(err * 100).toFixed(3)} % (injected ${(T.depth * 100).toFixed(1)} %), scatter ${(sd * 1e3).toFixed(2)} ppt per ${EXP} s frame`);
check('the running light curve is there from the second frame', live.length === n && live.every((p) => Number.isFinite(p.live) && p.live > 0 && Number.isFinite(p.sky)), `${live.length} points; FWHM is measured only with PSF fits on`);
check('stars tracked through the drift', Math.abs(A.M.x[(n - 1) * 5] - (T.target.x + 1.2 * 6.4 * 0.98)) < 2, `target x ${A.M.x[0].toFixed(1)} -> ${A.M.x[(n - 1) * 5].toFixed(1)} px`);

// tracking error: a poorly tracking mount (random walk, periodic error, 9 px jumps); the reducer must follow the
// field (re-finding it after the jumps) and the target's measured positions must follow the simulation's pointing
{
  const sky2 = createSimSky({ width: W, height: H, tmid, depth: 0.012, duration: 2, site, target, flux: 6000, seed: 5, tracking: 'poor', centre: true, t0 });
  const T2 = sky2.truth, R3 = createReducer({ ...cfg, stars: [T2.target, ...T2.comps] });
  let worst = 0, jumps = 0, prev = null, n2 = 0, err = [];
  for (let i = 0; i < 160; i++) {
    const start = t0 + i * CAD, fr = read(fits(sky2.frame('light', start, EXP, i), 'light', start, i), `j${i}.fits`), tr = sky2.last;
    calibrate(fr.data);
    const p = R3.add(fr), hrs = (start + EXP * 500 - t0) / 3600e3;
    const ex = T2.target.x + 1.2 * hrs + 0.2 * Math.sin(hrs * 40) + (tr.dx - (1.2 * hrs + 0.2 * Math.sin(hrs * 40))), ey = T2.target.y + tr.dy;
    const d = Math.hypot(p.x - ex, p.y - ey); err.push(d); worst = Math.max(worst, d); n2++;
    if (prev && Math.hypot(tr.dx - prev.dx, tr.dy - prev.dy) > 4) jumps++;
    prev = tr;
  }
  err.sort((a, b) => a - b);
  check('poor tracking (walk, periodic error, jumps): the target followed every frame', worst < 1.0, `${jumps} jumps over 4 px between frames; position error median ${err[err.length >> 1].toFixed(3)} px, worst ${worst.toFixed(3)} px; field re-found ${R3.result().relocated} times`);
  check('the tracking model is reproducible (same seed, same night)', (() => { const a = createSimSky({ width: W, height: H, tmid, tracking: 'poor', seed: 5, t0 }).tracking.over(t0 + 3600e3, 60), b = createSimSky({ width: W, height: H, tmid, tracking: 'poor', seed: 5, t0 }).tracking.over(t0 + 3600e3, 60); return a.dx === b.dx && a.dy === b.dy && a.blur === b.blur; })());
}

process.exit(ok ? 0 : 1);
