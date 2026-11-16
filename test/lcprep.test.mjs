// Light-curve preparation for transit fitting (src/core/lcprep.js) against wotan 2.1, the owner's TOI extraction code
// (EXOTIC examples/toi-3planet/toi1873_extract.py, copied into the reference script) and lightkurve 2.6
// (test/make_lcprep_reference.py): biweight trend with and without transit masks, transit mask and T14, EXOTIC's
// clip, post-gap trim, binning and injection window choice, the alias scan, lightkurve's flatten and CDPP, and the
// whole chain on the real Kepler TrES-2 pixels.
import { readFileSync } from 'node:fs';
import { biweightTrend, flatten, durationT14, transitMask, clipOutliers, trimAfterGaps, binSeries, optimizeWindow, aliasScan, savgolFlatten, cdpp, stitch, transitWindows, qualityBitmask, QUALITY_BITMASKS, cadencePerPoint } from '../src/core/lcprep.js';
import { openFits, readTargetPixelFile } from '../src/core/fits.js';
import { tpfLightCurve, pipelineMask } from '../src/core/photometry.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const R = JSON.parse(readFileSync(new URL('./lcprep_reference.json', import.meta.url)));
const S = R.synthetic, t = Float64Array.from(S.toff, (x) => S.t0 + x), f = Float64Array.from(S.f, (x) => (x === null ? NaN : x)), n = t.length;
const planets = Object.entries(S.planets).map(([name, p]) => ({ name, ...p }));
const relMax = (a, b, every = 1) => { let w = 0, bad = 0; b.forEach((v, k) => { const x = a[k * every]; if (v === null) { if (Number.isFinite(x)) bad++; return; } if (!Number.isFinite(x)) { bad++; return; } w = Math.max(w, Math.abs(x / v - 1)); }); return { w, bad }; };

// T14 and the transit mask
{
  let w = 0; for (const r of R.t14) { const v = durationT14(...r.args); w = Math.max(w, r.t14 === null ? (Number.isNaN(v) ? 0 : 1) : Math.abs(v / r.t14 - 1)); }
  check('T14 as EXOTIC duration_t14 (circular, eccentric, grazing, non-transiting)', w < 1e-14, `${R.t14.length} geometries, largest relative difference ${w.toExponential(1)}`);
  const m = transitMask(t, planets, 1.5), idx = []; m.forEach((v, i) => { if (v) idx.push(i); });
  check('transit mask (±1.5 T14/2 of every planet) as EXOTIC transit_mask', idx.length === R.transit_mask_count && idx.every((v, i) => v === R.transit_mask[i]), `${idx.length} of ${n} points in transit, 3 planets`);
}
// the biweight against wotan
const tm = transitMask(t, planets, 1.5);
{
  const cases = { 'w0.5': { window: 0.5 }, 'w1.0': { window: 1.0 }, 'w1.0_mask': { window: 1.0, mask: tm }, 'w2.0_mask_bt1h': { window: 2.0, mask: tm, breakTolerance: 1 / 24 }, 'w0.75_edge': { window: 0.75, edgeCutoff: 0.2 } };
  for (const [k, o] of Object.entries(cases)) {
    const t0 = performance.now(), tr = biweightTrend(t, f, o), ms = performance.now() - t0, r = R.biweight[k], c = relMax(tr, r.trend, r.every);
    let nn = 0; tr.forEach((v) => { if (!Number.isFinite(v)) nn++; });
    check(`biweight trend = wotan flatten(method='biweight') ${k}`, c.w < 2e-8 && c.bad === 0 && nn === r.nan, `largest relative difference ${c.w.toExponential(1)} over ${r.trend.length} points (every ${r.every}th of ${n}), ${nn} NaN (wotan ${r.nan}); ${ms.toFixed(0)} ms; tolerance 2e-8 (both iterate to 1e-6 MAD)`);
  }
  {
    const ex = biweightTrend(t, f, { window: 1.0, mask: tm }), t0 = performance.now(), th = biweightTrend(t, f, { window: 1.0, mask: tm, step: 10 / 1440 }), ms = performance.now() - t0, d = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(ex[i])) d.push(Math.abs(th[i] / ex[i] - 1));
    d.sort((a, b) => a - b); const p50 = d[d.length >> 1], p99 = d[Math.floor(0.99 * d.length)], mx = d[d.length - 1];
    check('biweight evaluated every 10 min and interpolated (wotan step) stays close to the full evaluation', p99 < 2e-5 && mx < 1e-4, `relative difference median ${(1e6 * p50).toFixed(2)} ppm, 99th percentile ${(1e6 * p99).toFixed(1)} ppm, largest ${(1e6 * mx).toFixed(0)} ppm (beside a flare, where the exact estimate itself jumps from point to point); 600 ppm noise per point; ${ms.toFixed(0)} ms`);
  }
  // the mechanism the owner's README documents: an unmasked trend eats part of a long transit
  const tb = Float64Array.from({ length: R.box_series.length }, (_, i) => i * (2 / 1440)), fb = Float64Array.from(R.box_series), mb = Uint8Array.from(tb, (v) => (Math.abs(v - 5) < 0.3 ? 1 : 0));
  const depth = (m) => { const fl = flatten(tb, fb, { window: 1, mask: m }).flat, a = []; tb.forEach((v, i) => { if (Math.abs(v - 5) < 0.15) a.push(fl[i]); }); a.sort((p, q) => p - q); return 1 - (a.length & 1 ? a[a.length >> 1] : 0.5 * (a[a.length / 2 - 1] + a[a.length / 2])); };
  const du = depth(null), dm = depth(mb);
  check('a 2000 ppm, 7.2 h box under a 1 d window: depth recovered with and without the mask, as wotan', Math.abs(du - R.box_check.unmasked) < 2e-7 && Math.abs(dm - R.box_check.masked) < 2e-7, `${(1e6 * du).toFixed(1)} ppm unmasked, ${(1e6 * dm).toFixed(1)} ppm masked (wotan ${(1e6 * R.box_check.unmasked).toFixed(1)}, ${(1e6 * R.box_check.masked).toFixed(1)})`);
}
// EXOTIC's clip, trim, binning
const keep = clipOutliers(t, f, tm), dropped = []; keep.forEach((v, i) => { if (!v) dropped.push(i); });
check("outlier clip as EXOTIC clip_outliers (4σ about a Savitzky-Golay smooth, in-transit points protected)", dropped.length === R.clip.dropped.length && dropped.every((v, i) => v === R.clip.dropped[i]), `${dropped.length} points dropped (25 outliers, a flare and a NaN were put in)`);
const trim = trimAfterGaps(t, Uint8Array.from(f, (v) => (Number.isFinite(v) && v > 0 ? 1 : 0))), tr = []; trim.forEach((v, i) => { if (v) tr.push(i); });
check('post-gap trim as EXOTIC (30 min after every gap > 1 h, and the first hour)', tr.length === R.trim.length && tr.every((v, i) => v === R.trim[i]), `${tr.length} cadences`);
const good = []; for (let i = 0; i < n; i++) if (keep[i] && !trim[i]) good.push(i);
const pick = (a) => Float64Array.from(good, (i) => a[i]), tg = pick(t), fg = pick(f), mg = Uint8Array.from(good, (i) => tm[i]);
{
  const b = binSeries(tg, fg, mg, { x: Float64Array.from(tg, Math.sin), y: Float64Array.from(tg, Math.cos) }, 3), r = R.bin3;
  let w = 0; r.t.forEach((v, k) => { w = Math.max(w, Math.abs(b.t[k * r.every] - v), Math.abs(b.f[k * r.every] - r.f[k]), Math.abs(b.chan.x[k * r.every] - r.x[k])); });
  check('binning on a uniform time grid as EXOTIC bin_series (gaps never merged, a bin in transit when any member is)', b.t.length === r.n && b.m.every((v, k) => v === r.m[k]) && w < 1e-9, `${b.t.length} bins of 3, largest difference ${w.toExponential(1)}`);
}
{
  const r = R.optimize_window, t0 = performance.now(), o = optimizeWindow(tg, fg, mg, r.t14max, { grid: r.grid, epochs: r.epochs, breakTolerance: 1 / 24 }), ms = performance.now() - t0;
  let w = 0; for (const [k, v] of Object.entries(r.scan)) { const q = o.scan[+k]; if (!q) { w = Infinity; continue; } w = Math.max(w, Math.abs(q.depth_recovered - v.depth_recovered), Math.abs(q.noise_ppm / v.noise_ppm - 1), Math.abs(q.score / v.score - 1)); }
  check("window chosen by injected transits as EXOTIC optimize_window", o.window === +r.best && Object.keys(o.scan).length === Object.keys(r.scan).length && w < 1e-6, `best ${o.window} d; recovered ${Object.entries(o.scan).map(([k, v]) => `${k} d ${(100 * v.depth_recovered).toFixed(1)}%`).join(', ')}; largest difference ${w.toExponential(1)}; ${(ms / 1000).toFixed(1)} s`);
}
// alias scan
{
  const A = R.alias, ts = [], cs = [];
  for (const [a, b, c] of A.segments) for (let k = 0; ; k++) { const x = a + k * c; if (x >= b) break; if ((x - a) % 13.7 < 12.5) { ts.push(x); cs.push(c); } }
  const ars = (P) => Math.cbrt(A.G * A.mstar * A.Msun * (P * 86400) ** 2 / (4 * Math.PI ** 2)) / (A.rstar * A.Rsun);
  const s = aliasScan(Float64Array.from(ts), Float64Array.from(cs), A.epochs, { rprs: A.rprs, arsFor: ars });
  const same = s.rows.every((q, i) => q.covered === A.rows[i].covered && q.missed === A.rows[i].missed && Math.abs(q.per - A.rows[i].per) < 1e-9);
  check('alias scan as EXOTIC stage_alias_scan (coverage counted with each sector\'s own cadence)', same && Math.abs(s.baseline - A.baseline) < 1e-9, `allowed N = ${s.rows.filter((q) => q.allowed).map((q) => q.N).join(', ')}; shortest allowed ${s.minimumAllowed.toFixed(4)} d`);
  const cp = cadencePerPoint(Float64Array.from(ts), Int32Array.from(ts, (x) => A.segments.findIndex(([a, b]) => x >= a && x < b)));
  check('per-point cadence from each segment', Math.abs(cp[0] * 1440 - 2) < 1e-6 && cp.some((c) => Math.abs(c * 1440 - 30) < 1e-6));
}
// lightkurve's flatten and CDPP
{
  const gi = []; for (let i = 0; i < n; i++) if (Number.isFinite(f[i])) gi.push(i);
  const tt = Float64Array.from(gi, (i) => t[i] - 2457000), ff = Float64Array.from(gi, (i) => f[i]), tr2 = savgolFlatten(tt, ff, { window: 101 }).trend, c = relMax(tr2, R.lk_flatten_trend, 4);
  check('Savitzky-Golay flatten = lightkurve LightCurve.flatten (window 101, 3 iterations of 3σ, gaps split)', c.w < 1e-10 && c.bad === 0, `largest relative difference ${c.w.toExponential(1)}`);
  const c13 = cdpp(tt, ff), c30 = cdpp(tt, ff, { transitDuration: 30, savgolWindow: 301 });
  check('CDPP = lightkurve estimate_cdpp', Math.abs(c13 / R.lk_cdpp['13'] - 1) < 1e-8 && Math.abs(c30 / R.lk_cdpp['30'] - 1) < 1e-8, `${c13.toFixed(3)} ppm (13 cadences), ${c30.toFixed(3)} ppm (30) against ${R.lk_cdpp['13'].toFixed(3)}, ${R.lk_cdpp['30'].toFixed(3)}`);
}
// quality presets
check("quality presets are lightkurve's bitmasks", qualityBitmask('TESS', 'default') === 17087 && qualityBitmask('TESS', 'hard') === 24319 && qualityBitmask('K2', 'default') === 1130799 && qualityBitmask('Kepler', 'hard') === 1664431 && QUALITY_BITMASKS.kepler.hardest === 2096639 && qualityBitmask('TESS', 'none') === 0);
// stitching
{
  const a = { name: 's1', t: Float64Array.from([1, 2, 3, 4]), f: Float64Array.from([10, 11, 9, 10]), e: Float64Array.from([1, 1, 1, 1]) }, b = { name: 's2', t: Float64Array.from([4 + 0.5 / 86400, 5, 6]), f: Float64Array.from([200, 202, 198]) };
  const s = stitch([a, b]);
  check('stitch: each part over its own median, time order, a cadence within 1 s of another dropped', s.t.length === 6 && s.dropped === 1 && s.f[0] === 1 && Math.abs(s.f[5] - 198 / 200) < 1e-15 && s.segment[4] === 1 && s.medians[1] === 200 && Math.abs(s.e[0] - 0.1) < 1e-15, `${s.t.length} points, medians ${s.medians.join(', ')}`);
}
// the whole chain on real pixels: TrES-2, Kepler quarter 1, pipeline aperture, 'default' quality, masked biweight, clip
{
  const T = R.tres2, b = readFileSync(new URL('./data/kplr011446443-2009131105131_lpd-targ.fits.gz', import.meta.url));
  const tpf = readTargetPixelFile(await openFits(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))), lc = tpfLightCurve(tpf, pipelineMask(tpf), { quality: qualityBitmask('Kepler', 'default') });
  const idx = []; for (let i = 0; i < tpf.ncad; i++) if (Number.isFinite(lc.time[i]) && !(tpf.quality[i] & qualityBitmask('Kepler', 'default'))) idx.push(i);
  const kt = Float64Array.from(idx, (i) => lc.time[i]), kf = Float64Array.from(idx, (i) => lc.flux[i]), p = [{ name: 'b', ...T.planet }];
  const km = transitMask(kt, p, 1.5), { flat, trend } = flatten(kt, kf, { window: 0.75, mask: km, breakTolerance: 0.5 }), c = relMax(trend, T.trend);
  let nin = 0; km.forEach((v) => { nin += v; });
  check('TrES-2 (Kepler Q1 pixels): transit-masked biweight trend of our aperture flux = wotan on lightkurve\'s', kt.length === T.n && nin === T.in_transit && c.w < 1e-6 && c.bad === 0, `${kt.length} cadences, ${nin} in transit, largest relative difference ${c.w.toExponential(1)} (float32 pixels summed in another order: 1e-7)`);
  const kk = clipOutliers(kt, flat, km), dr = []; kk.forEach((v, i) => { if (!v) dr.push(i); });
  const inT = transitMask(kt, p, 0.5), med = (a) => { const s = Float64Array.from(a).filter((v) => v === v).sort(); return s.length & 1 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };
  const depth = 1e6 * (med(flat.filter((_, i) => !km[i])) - med(flat.filter((_, i) => inT[i])));
  const cd = cdpp(kt.filter((_, i) => !km[i] && kk[i]), flat.filter((_, i) => !km[i] && kk[i]));
  check('TrES-2: clip, depth and CDPP of the flattened light curve as the Python chain', dr.length === T.clip_dropped.length && dr.every((v, i) => v === T.clip_dropped[i]) && Math.abs(depth - T.depth_ppm) < 1 && Math.abs(cd / T.cdpp_flat - 1) < 1e-4, `${dr.length} clipped; depth ${depth.toFixed(0)} ppm (Python ${T.depth_ppm.toFixed(0)}; (Rp/R★)² = ${(1e6 * 0.1278 ** 2).toFixed(0)} ppm before limb darkening); CDPP ${cd.toFixed(2)} ppm (lightkurve ${T.cdpp_flat.toFixed(2)})`);
  const w = transitWindows(kt, flat, [{ name: 'TrES-2 b', ...T.planet }]);
  check('TrES-2: one window per covered transit (±2.5 T14)', w.windows.length >= 3 && w.windows.every((q) => q.during > 0 && q.before > 0 && q.after > 0), `${w.windows.length} windows: epochs ${w.windows.map((q) => q.epoch).join(', ')}, ${w.windows.map((q) => q.n).join(', ')} points`);
}
// overlapping transits flagged and divided out
{
  const tt = Float64Array.from({ length: 2000 }, (_, i) => 100 + i * 2 / 1440), pl = [{ name: 'b', per: 7, tmid: 101, t14: 0.1, rprs: 0.05, ars: 15, inc: 89.5 }, { name: 'c', per: 25, tmid: 101.03, t14: 0.15, rprs: 0.08, ars: 30, inc: 89.8 }];
  const w = transitWindows(tt, new Float64Array(2000).fill(1), pl, { divideOthers: true }), wb = w.windows.find((q) => q.planet === 'b');
  check("another planet's transit inside a window is reported, and divided out when asked", wb && wb.overlaps.includes('c') && w.fOut.some((v) => v > 1.001), `planet b's window overlaps ${wb ? wb.overlaps.join(', ') : '—'}`);
}
process.exit(ok ? 0 : 1);
