// Long space light curves on the photometry page: several sectors (quarters, campaigns) of TESS / Kepler / K2 light-curve
// files or target pixel files, stitched, and prepared for transit fitting the way the owner's TOI extraction does it
// (EXOTIC examples/toi-3planet/toi1873_extract.py stage_extract): per sector the post-gap trim, EXOTIC's 4σ clip with
// the transits protected, the biweight window chosen by injected transits (or given), the transit-masked biweight
// flatten, the per-sector scatter as the error; then the sectors joined (a cadence within 1 s of another dropped), and a
// window of ±2.5 T14 cut around every transit of every planet, other planets' transits flagged (and divided out when
// their geometry is known). No DOM: runs in the worker and in Node. Science in src/core/lcprep.js (tested there).
import { openFits, readTargetPixelFile } from '../core/fits.js';
import { lightCurveFromFits } from '../core/lcfits.js';
import { optimiseTpf, segmentScatter, smoothScatter, medianOf } from '../core/photometry.js';
import { qualityBitmask, transitMask, clipOutliers, trimAfterGaps, binSeries, optimizeWindow, flatten, stitch, transitWindows, durationT14, cdpp as cdppCadences, nanStd, nanMedian } from '../core/lcprep.js';

/**
 * lightkurve's CDPP over 6.5 h whatever the cadence: its defaults (13 cadences, a Savitzky-Golay window of 101) are
 * 6.4 h and 2.1 d at Kepler's 29.4-minute cadence; at other cadences both are scaled to the same durations (TESS 2 min:
 * 191 and 1,485 cadences), so that sectors of different cadence can be compared.
 */
export function cdpp(t, f) {
  const d = []; for (let i = 1; i < t.length; i++) { const x = t[i] - t[i - 1]; if (x > 0) d.push(x); }
  const c = nanMedian(d) * 1440; if (!(c > 0)) return NaN;
  const k = 29.4244 / c, n = Math.max(1, Math.round(13 * k)), w = Math.max(5, 2 * Math.round(50 * k) + 1);   // Kepler long cadence: 13, 101
  return cdppCadences(t, f, { transitDuration: n, savgolWindow: w });
}
import { k2Thrusters, k2Pld } from './pipeline.js';

/**
 * A light-curve FITS file (SPOC, TESS-SPOC, QLP, Kepler, K2) as a part: { name, mission, sector, author, t (BJD_TDB), f, e,
 * exptime [s], fluxColumn, kept, dropped }. opts: { flux: 'pdcsap' | 'sap' | column name, quality: lightkurve preset }.
 */
export async function partFromLcFits(buffer, name, opts = {}) {
  const col = opts.flux === 'sap' ? 'SAP_FLUX' : opts.flux && opts.flux !== 'pdcsap' ? opts.flux : undefined;
  let r;
  try { r = await lightCurveFromFits(buffer, { flux: col, quality: opts.quality || 'default' }); } catch (err) { if (col === 'SAP_FLUX') r = await lightCurveFromFits(buffer, { quality: opts.quality || 'default' }); else throw err; }
  const m = r.meta, A = r.arrays, mission = /K2/i.test(m.mission) ? 'K2' : /TESS/i.test(m.mission) ? 'TESS' : /Kepler/i.test(m.mission) ? 'Kepler' : m.mission || 'unknown';
  // cadence from TIMEDEL (EXPOSURE in a light-curve file is the total exposure of the sector, in days)
  const cad = m.cadenceDays > 0 ? Math.round(m.cadenceDays * 86400 * 100) / 100 : null;
  return { name, mission, sector: m.sector, quarter: m.quarter, campaign: m.campaign, author: m.author, t: A.time, f: A.flux, e: A.err, exptime: opts.exptime || cad, fluxColumn: m.fluxColumn, kept: m.kept, dropped: m.dropped, object: m.object, ra: m.ra, dec: m.dec, source: 'light-curve file' };
}

/**
 * A target pixel file as a part: the aperture with the least robust scatter (photometry.js optimiseTpf: the pipeline
 * aperture, its dilations, threshold masks, circles), lightkurve's 'default' quality mask, with centroids, β and sky.
 * opts.k2: 'pld' | 'sff' | null for K2 (and any TPF): pixel-level decorrelation (src/core/k2.js) of the chosen aperture;
 * opts.thrusters: drop K2 thruster firings found from the centroid.
 */
export async function partFromTpf(buffer, name, opts = {}) {
  const tpf = readTargetPixelFile(await openFits(buffer)), q = qualityBitmask(tpf.mission, opts.quality || 'default');
  const o = optimiseTpf(tpf, { quality: q });
  if (o.best < 0) throw new Error(`${name}: no aperture gave a usable light curve`);
  const lc = o.lc; let g = lc.good;
  let thr = null; if (opts.thrusters && tpf.mission === 'K2') { thr = k2Thrusters(tpf, o.tried[o.best].mask); g = g.filter((c) => !thr.flags[c]); }
  const pick = (a) => Float64Array.from(g, (c) => a[c]);
  let f = pick(lc.flux), corr = null;
  if (opts.k2 === 'pld') { const P = k2Pld(tpf, o.tried[o.best].mask, g, { order: opts.pldOrder ?? 3 }); if (P) { corr = { method: `PLD order ${opts.pldOrder ?? 3} (${P.ncols} regressors)`, before: cdpp(pick(lc.time), f), after: cdpp(pick(lc.time), P.corrected) }; f = P.corrected; } }
  return { name, mission: tpf.mission, sector: tpf.sector, quarter: tpf.mission === 'Kepler' ? tpf.quarter : null, campaign: tpf.mission === 'K2' ? tpf.quarter : null, author: 'pixels', t: pick(lc.time), f, e: pick(lc.err), x: pick(lc.x), y: pick(lc.y), beta: pick(lc.beta), bkg: pick(lc.bkg),
    exptime: tpf.exptime, aperture: o.tried[o.best].name, npix: o.tried[o.best].npix, object: tpf.object, ra: tpf.ra, dec: tpf.dec, source: 'target pixel file', correction: corr, thrusters: thr ? { dropped: lc.good.length - g.length, fromQuality: thr.fromQuality, fromCentroid: thr.fromCentroid } : null };
}

/**
 * Planets for the transit mask: [{ name, per, tmid, t14 (days), rprs?, ars?, inc? }]; t14 from the geometry when only
 * that is known (EXOTIC duration_t14), else the catalogue's duration, else 3 h.
 */
export function planetsForMask(list) {
  return list.filter((p) => p && p.per > 0 && Number.isFinite(p.tmid)).map((p) => {
    let t14 = p.t14 > 0 ? p.t14 : NaN;
    if (!(t14 > 0) && p.rprs > 0 && p.ars > 1) t14 = durationT14(p.per, p.rprs, p.ars, p.inc ?? 90, p.ecc || 0, p.omega || 0);
    return { ...p, t14: t14 > 0 ? t14 : 0.125, t14Assumed: !(t14 > 0) };
  });
}

/**
 * Prepare parts (each one sector) for transit fitting.
 * @param opts { window: days or 'auto' (injection test, grid [0.5 ... 8]), pad = 1.5 (mask ±pad·T14/2), clipSigma = 4,
 *               trimMinutes = 30 (0: off), gapHours = 1, binTo: seconds (0: native), durations = 2.5 (window half-width
 *               in T14), divideOthers = true, step: biweight step in days for the injection scan (default 10 min) }
 * @returns { t, f, e, trend, raw, segment, inTransit, names, perPart: [...], windows, planets, cdppBefore, cdppAfter, dropped }
 */
export function prepareParts(parts, planetList, opts = {}, onProgress = () => {}) {
  const planets = planetsForMask(planetList), pad = opts.pad ?? 1.5, t14max = planets.length ? Math.max(...planets.map((p) => p.t14)) : 0.125;
  const out = [], perPart = [];
  parts.forEach((P, k) => {
    onProgress({ stage: 'part', done: k, total: parts.length, name: P.name });
    const n = P.t.length; let good = Uint8Array.from({ length: n }, (_, i) => (Number.isFinite(P.t[i]) && Number.isFinite(P.f[i]) && P.f[i] > 0 ? 1 : 0));
    const trim = opts.trimMinutes === 0 ? new Uint8Array(n) : trimAfterGaps(P.t, good, opts.trimMinutes ?? 30, (opts.gapHours ?? 1) / 24);
    const tmask = transitMask(P.t, planets, pad), clip = clipOutliers(P.t, P.f, tmask, opts.clipSigma ?? 4);
    let nTrim = 0, nClip = 0; for (let i = 0; i < n; i++) { if (good[i] && trim[i]) nTrim++; else if (good[i] && !clip[i]) nClip++; good[i] = good[i] && !trim[i] && clip[i] ? 1 : 0; }
    const idx = []; for (let i = 0; i < n; i++) if (good[i]) idx.push(i);
    if (idx.length < 30) { perPart.push({ name: P.name, skipped: `only ${idx.length} usable cadences` }); return; }
    let t = Float64Array.from(idx, (i) => P.t[i]), f = Float64Array.from(idx, (i) => P.f[i]), e = Float64Array.from(idx, (i) => P.e ? P.e[i] : NaN), m = Uint8Array.from(idx, (i) => tmask[i]);
    // optional binning to a common cadence after the native-cadence clip (EXOTIC fit_cadence_s)
    const cad = medianOf(Float64Array.from({ length: t.length - 1 }, (_, i) => t[i + 1] - t[i])) * 86400;
    if (opts.binTo > 0 && cad < opts.binTo - 1) { const nb = Math.round(opts.binTo / cad); if (nb >= 2) { const b = binSeries(t, f, m, { e }, nb); t = b.t; f = b.f; m = b.m; e = Float64Array.from(b.chan.e, (v) => v / Math.sqrt(nb)); } }
    let window = opts.window, scan = null;
    if (window === 'auto' || !(window > 0)) { const inBox = t14max / (cad / 86400), o = optimizeWindow(t, f, m, t14max, { grid: opts.grid, breakTolerance: (opts.gapHours ?? 1) / 24, step: opts.step ?? 10 / 1440, seed: k, minBox: Math.max(2, Math.min(5, Math.floor(0.6 * inBox))), minNear: Math.max(3, Math.min(10, Math.floor(1.2 * inBox))) }); window = o.window; scan = o.scan; }
    const { flat, trend } = flatten(t, f, { window, mask: m, breakTolerance: (opts.gapHours ?? 1) / 24 });
    // error: the pipeline's, through the trend, or EXOTIC's per-sector 30-min scatter of the flattened flux
    const oot = []; for (let i = 0; i < t.length; i++) if (!m[i] && Number.isFinite(flat[i])) oot.push(i);
    const sc = smoothScatter(Float64Array.from(oot, (i) => t[i]), Float64Array.from(oot, (i) => flat[i]), 0.5, true, false);
    const err = Float64Array.from(e, (v, i) => (Number.isFinite(v) && v > 0 ? v / trend[i] : sc));
    perPart.push({ name: P.name, mission: P.mission, sector: P.sector ?? P.quarter ?? P.campaign, source: P.source, aperture: P.aperture || null, fluxColumn: P.fluxColumn || null, n: t.length, trimmed: nTrim, clipped: nClip, window, scan, scatterPpm: 1e6 * nanStd(Float64Array.from(oot, (i) => flat[i])), scatter30Ppm: 1e6 * sc, cdppRaw: cdpp(t, f), cdppFlat: cdpp(Float64Array.from(oot, (i) => t[i]), Float64Array.from(oot, (i) => flat[i])), exptime: P.exptime, correction: P.correction || null, thrusters: P.thrusters || null, binned: opts.binTo > 0 && cad < opts.binTo - 1 ? opts.binTo : null });
    const cols = { trend, raw: f, mask: Float64Array.from(m) };
    out.push({ name: P.name, t, f: flat, e: err, columns: cols });
  });
  if (!out.length) throw new Error('No sector had enough usable cadences.');
  // the parts are already flat (≈ 1): stitch only orders them and drops repeated cadences; its median is ≈ 1
  const S = stitch(out), n = S.t.length;
  const inTransit = transitMask(S.t, planets, 1);
  const W = transitWindows(S.t, S.f, planets, { durations: opts.durations ?? 2.5, divideOthers: opts.divideOthers !== false });
  return { t: S.t, f: W.fOut, flatRaw: S.f, e: S.e, trend: S.columns.trend, raw: S.columns.raw, masked: Uint8Array.from(S.columns.mask), segment: S.segment, names: S.names, inTransit, windows: W.windows, planets, perPart, dropped: S.dropped, n };
}

/** CSV text of a prepared light curve: every point, or only those inside the transit windows (with their window number). */
export function preparedCsv(R, { windowsOnly = false, planet = null } = {}) {
  const rows = ['# prepared on the Exoplanet Science Lab photometry page: per-sector biweight flatten with known transits masked (EXOTIC toi1873_extract method)', `# sectors: ${R.perPart.filter((p) => !p.skipped).map((p) => `${p.name} (window ${p.window} d, ${p.scatterPpm.toFixed(0)} ppm)`).join('; ')}`, `# column epoch: ${windowsOnly ? 'the transit window' : 'the part (sector)'} of each point, numbered from 0`, 'BJD_TDB,flux,flux_err,epoch'];
  if (windowsOnly) {
    const ws = R.windows.filter((w) => !planet || w.planet === planet), seen = new Set();
    ws.forEach((w, k) => { for (const i of w.idx) { if (seen.has(i)) continue; seen.add(i); rows.push(`${R.t[i].toFixed(7)},${R.f[i].toPrecision(9)},${(R.e[i] || 0).toPrecision(6)},${k}`); } });
    rows.splice(4, rows.length - 4, ...rows.slice(4).sort((a, b) => parseFloat(a) - parseFloat(b)));
  } else for (let i = 0; i < R.t.length; i++) rows.push(`${R.t[i].toFixed(7)},${R.f[i].toPrecision(9)},${(R.e[i] || 0).toPrecision(6)},${R.segment[i]}`);
  return rows.join('\n') + '\n';
}

/** One CSV per transit window: [{ name, text }] (EXOTIC writes lc_<tmid>.csv per transit). */
export function windowCsvs(R) {
  return R.windows.map((w) => ({ name: `${String(w.planet).replace(/[^\w.\-]+/g, '_')}_E${w.epoch}_${w.tc.toFixed(4)}.csv`,
    text: `# ${w.planet}, epoch ${w.epoch}, predicted mid-transit ${w.tc.toFixed(6)} BJD_TDB${w.overlaps.length ? `; overlaps ${w.overlaps.join(', ')}` : ''}\nBJD_TDB,flux,flux_err\n` + w.idx.map((i) => `${R.t[i].toFixed(7)},${R.f[i].toPrecision(9)},${(R.e[i] || 0).toPrecision(6)}`).join('\n') + '\n' }));
}

export { segmentScatter };
