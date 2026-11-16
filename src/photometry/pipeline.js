// The photometry pipeline between files and a light curve. No DOM: runs in the worker (and in Node for timing).
// A frame source is anything with arrayBuffer() (a File or Blob) or { buffer } plus a name.
import { openFits, parseHeader, isGzip, readImage, firstImageHdu, readTargetPixelFile, frameTime, frameAirmass, framePointing, utcToBjdTdb, pierSide, pixelScale, parseFits, gunzip } from '../core/fits.js';
import { centroidIter, fitPsf, detectSources, estimateShift, trackStars, makeMeasurements, measureFrame, optimise, linspace, optimiseTpf, tpfLightCurve, smoothScatter, segmentScatter, runningMedian, medianOf, fitSimilarity, matchAsterism, placeStars, sffDetrend, tpfMedianImage, thresholdMask } from '../core/photometry.js';
import { makeTransitFitter } from './transitfit.js';
import { detrendWithCentroids } from '../core/gp.js';
import { detrendFromColumns, pldBasis } from '../core/detrend.js';
import { buildProblem } from '../core/model.js';
import { qualityBitmask } from '../core/lcprep.js';
import { pldCorrect, thrusterFlags } from '../core/k2.js';

// what EXOTIC accepts: .fits .fit .fts, each optionally .gz or .fz (fpack), and a bare .fz; any letter case
export const FITS_NAME = /(\.(fits|fit|fts)(\.(gz|fz))?|\.fz)$/i;
import { imageHeader, demosaicBilinear, mixChannels } from '../core/fits.js';

const bytesOf = async (src) => (src.buffer ? src.buffer : await src.arrayBuffer());

/**
 * Read only the headers a frame list needs (a few kB), without decoding the image: slices a File, and for gzip
 * decompresses just the start of the stream. Returns { header, comments, primaryEmpty } and, when the primary
 * HDU holds no data, { ext, extComments, compressed }: for an image in the first extension (plain, or
 * tile-compressed as fpack writes .fz files) `header` is the primary keywords overlaid with the image's, the
 * compressed table presented as the image it holds (BITPIX, NAXISn from ZBITPIX, ZNAXISn); for a binary table
 * (a target pixel file) `ext` is the table's header and `header` the table's overlaid with the primary's.
 */
export async function readHeaderOnly(src) {
  const need = 2880 * 30;
  let u8;
  if (src.buffer) u8 = new Uint8Array(src.buffer);
  else {
    const head = new Uint8Array(await src.slice(0, 2).arrayBuffer());
    if (isGzip(head)) {
      // a .fits.gz deflated inside a zip is gzip twice over (src/core/zip.js): unwrap as many layers as there are
      const headOf = async (layers) => {
        let s = src.stream(); for (let k = 0; k < layers; k++) s = s.pipeThrough(new DecompressionStream('gzip'));
        const reader = s.getReader(), parts = []; let n = 0;
        while (n < need) { const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
        reader.cancel().catch(() => {});
        const b = new Uint8Array(n); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; }
        return b;
      };
      u8 = await headOf(1);
      if (isGzip(u8)) u8 = await headOf(2);
    } else u8 = new Uint8Array(await src.slice(0, need).arrayBuffer());
  }
  const merged = (P, E) => {
    const empty = !(P.header.NAXIS > 0);
    if (!empty || !E) return { header: P.header, comments: P.comments, primaryEmpty: empty };
    const zip = E.header.ZIMAGE === true, m = imageHeader(E.header, E.comments);
    if (zip || String(E.header.XTENSION || '').trim() === 'IMAGE') return { header: { ...P.header, ...m.header }, comments: { ...P.comments, ...m.comments }, ext: m.header, extComments: m.comments, primaryEmpty: true, compressed: zip };
    return { header: { ...E.header, ...P.header, NAXIS: P.header.NAXIS }, comments: { ...E.comments, ...P.comments }, ext: E.header, extComments: E.comments, primaryEmpty: true, compressed: false };
  };
  // the whole file: the first HDU with data, as EXOTIC takes it (or the first extension when there is no image)
  const full = async (bytes) => {
    const f = await openFits(bytes, { inflate: false }), i = firstImageHdu(f), E = f.hdus[i > 0 ? i : 1];
    return { ...merged(f.hdus[0], E && { header: E.tableHeader || E.header, comments: E.tableComments || E.comments }), hdus: f.hdus.length };
  };
  if (isGzip(u8)) return full(u8);
  const whole = !!src.buffer || u8.length < need;
  try {
    const h = parseHeader(u8, 0), empty = !(h.header.NAXIS > 0);
    if (h.missingEnd && !whole) throw new Error('header longer than the part read');
    if (!empty) return merged(h, null);
    // a primary HDU without data: the image (or pixel table) is in the first extension, whose header follows directly
    const e = h.end + 160 <= u8.length ? parseHeader(u8, h.end) : null;
    if (e && !(e.missingEnd && !whole) && e.header.NAXIS > 0) return merged(h, e);
    if (whole) return e && e.header.XTENSION ? full(u8) : merged(h, null);
    throw new Error('extension header not in the part read');
  } catch (err) {
    if (src.buffer) throw err;
    return full(await src.arrayBuffer());
  }
}

/** What kind of frame a header describes: 'light', 'dark', 'flat', 'bias' (IMAGETYP / OBSTYPE / FRAME keywords, else the file name). */
export function frameKind(H, name = '') {
  const t = String(H.IMAGETYP ?? H.OBSTYPE ?? H.FRAME ?? H.IMGTYPE ?? '').toLowerCase(), n = name.toLowerCase();
  if (/dark/.test(t)) return 'dark'; if (/flat/.test(t)) return 'flat'; if (/bias|zero|offset/.test(t)) return 'bias'; if (/light|object|science/.test(t)) return 'light';
  if (/(^|[_\-. /])(dark)s?([_\-. /\d]|$)/.test(n)) return 'dark'; if (/(^|[_\-. /])(flat)s?([_\-. /\d]|$)/.test(n)) return 'flat'; if (/(^|[_\-. /])(bias|zero)([_\-. /\d]|$)/.test(n)) return 'bias';
  return 'light';
}

/**
 * Decode the image of a frame source: the first HDU with data (as EXOTIC), plain or tile-compressed.
 * `out` reuses a buffer. opts: { plane: which plane of a cube (default 0), weights: [w0, w1, ...] for a weighted
 * sum of the planes instead, bayer: { pattern: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG', weights: 'green' | 'red' | 'blue' |
 * 'gray' | 'blueblock' | [wR, wG, wB], truncate } to demosaic a one-shot-colour frame as EXOTIC does }.
 * Returns { data, width, height, header, comments, name, planes, plane, compression }.
 */
export async function loadFrame(src, out = null, opts = {}) {
  if (out && !ArrayBuffer.isView(out)) { opts = out; out = null; }
  const fits = await openFits(await bytesOf(src)), i = firstImageHdu(fits);
  if (i < 0) throw new Error((src.name || 'file') + ': no image in this FITS file');
  const ro = out ? { out } : {};
  if (Array.isArray(opts.weights)) ro.weights = opts.weights; else if (opts.plane != null) ro.plane = opts.plane;
  const im = readImage(fits, i, ro);
  if (opts.bayer && opts.bayer.pattern && im.planes === 1) mixChannels(demosaicBilinear(im.data, im.width, im.height, opts.bayer.pattern), opts.bayer.weights ?? 'green', { out: im.data, truncate: !!opts.bayer.truncate });
  // keywords of the primary header are inherited by an image extension
  const header = i > 0 ? { ...fits.hdus[0].header, ...fits.hdus[i].header } : fits.hdus[i].header, comments = i > 0 ? { ...fits.hdus[0].comments, ...fits.hdus[i].comments } : fits.hdus[i].comments;
  return { data: im.data, width: im.width, height: im.height, header, comments, name: src.name || '', planes: im.planes, plane: im.plane, compression: im.compression };
}

/** Pixel-wise median of several frames of the same size (master dark / flat / bias). A flat is normalised to median 1. */
export async function masterFrame(sources, { normalise = false, subtract = null, onProgress = null } = {}) {
  if (!sources || !sources.length) return null;
  const frames = [];
  for (let i = 0; i < sources.length; i++) { const f = await loadFrame(sources[i]); if (frames.length && (f.width !== frames[0].width || f.height !== frames[0].height)) continue; if (subtract && subtract.length === f.data.length) for (let k = 0; k < f.data.length; k++) f.data[k] -= subtract[k]; if (normalise) { const m = medianOf(sample(f.data)); for (let k = 0; k < f.data.length; k++) f.data[k] /= m; } frames.push(f); onProgress && onProgress(i + 1, sources.length); }
  const n = frames.length, np = frames[0].data.length, out = new Float32Array(np), buf = new Float64Array(n);
  for (let p = 0; p < np; p++) { for (let k = 0; k < n; k++) buf[k] = frames[k].data[p]; buf.sort(); out[p] = n & 1 ? buf[n >> 1] : 0.5 * (buf[n / 2 - 1] + buf[n / 2]); }
  return { data: out, width: frames[0].width, height: frames[0].height, n };
}
const sample = (d) => { const st = Math.max(1, Math.floor(d.length / 20000)), o = []; for (let i = 0; i < d.length; i += st) if (d[i] === d[i]) o.push(d[i]); return o; };

/** (frame - bias - dark) / flat in place, for whichever calibration frames are given and match the size. */
export function calibrate(data, cal) {
  if (!cal) return data;
  const n = data.length, ok = (c) => c && c.data.length === n;
  if (ok(cal.bias)) { const b = cal.bias.data; for (let i = 0; i < n; i++) data[i] -= b[i]; }
  if (ok(cal.dark)) { const b = cal.dark.data; for (let i = 0; i < n; i++) data[i] -= b[i]; }
  if (ok(cal.flat)) { const b = cal.flat.data; for (let i = 0; i < n; i++) data[i] = b[i] > 0.05 ? data[i] / b[i] : NaN; }
  return data;
}

/** Version of the reduction code, written into exported settings so a light curve can be traced to what made it. */
export const PHOT_VERSION = '0.4.0';

/** The fitter a configuration asks for: EXOTIC's transit-model least squares when cfg.score === 'transit' and a planet is given, else null (the quick trapezoid fit). Functions cannot cross to a worker, so both sides build it from cfg. */
export function makeFitter(cfg) { return cfg && cfg.score === 'transit' && cfg.planet && cfg.planet.per > 0 && cfg.planet.rprs > 0 ? makeTransitFitter(cfg.planet, { loss: cfg.loss, weights: cfg.weights }) : null; }

/**
 * Photometry of a stack of frames.
 * @param sources frames in time order
 * @param cfg { stars: [{x, y}] target first, positions on sources[0];
 *              nAper = 12, nAnn = 4, aperRange = [1.5, 6], annRange = [6, 15] (in units of the target's PSF sigma on the
 *              first frame: EXOTIC's ranges), or apertures / annuli in pixels; gap = 2 px,
 *              psf: 'both' (Gaussian and Moffat; default) | 'gaussian' | 'moffat' | 'none', rotate = true (free position angle
 *              of the Gaussian, as EXOTIC), optimal = true (Naylor extraction), ellipse: false | true | 'auto' (elliptical
 *              apertures when the first frame's PSF is elongated by more than 25%), method: 'exact' | 'subpixel',
 *              timeAt: 'start' | 'mid' | 'exotic', target: { ra, dec } deg, site: { lat, lon } deg, cal: { bias, dark, flat },
 *              fit: options for quickFit, score: 'quick' | 'transit' with planet: { rprs, ars, inc, per, tmid, ecc, omega, ld, tmidUnc, perUnc },
 *              half = tracking box half-width, frame: { plane, weights, bayer } passed to loadFrame, gain [e-/ADU] }
 * @param onProgress called per frame with { stage: 'frames', done, total, name, index, jd, airmass, pos: [x0, y0, ...], fwhm, sky,
 *              live (target / comparisons at an aperture of about 3 sigma), rot [deg], relocated, elapsed, eta [s] } and during the
 *              search with { stage: 'optimise', done, total, rows: [new rows of the tried table], best }
 * @returns { M (measurements), opt (optimise result), frames: [{ name, jd, scale, keyword, airmassSource }], sigma, timeSystem, timing, settings }
 */
export async function runStack(sources, cfg, onProgress = () => {}, shouldStop = () => false) {
  const nF = sources.length, nS = cfg.stars.length, half = cfg.half || 8, psf = cfg.psf || 'both';
  let M = null, pos = new Float64Array(2 * nS), next = new Float64Array(2 * nS), refSources = null, refPos = null, sigma = 2, buf = null, shape0 = null;
  const frames = [], timing = { read: 0, measure: 0, t0: performance.now() };
  let scaleSeen = new Set(), relocated = 0, used = 0, prevJd = NaN, pier0 = null, liveA = 0, meta = null; const dts = [];
  for (let f = 0; f < nF; f++) {
    if (shouldStop()) break;
    let t = performance.now();
    let fr;
    try { fr = await loadFrame(sources[f], buf, cfg.frame || {}); } catch (err) { frames.push({ name: sources[f].name || '', error: String(err.message || err) }); continue; }
    calibrate(fr.data, cfg.cal);
    if (!(fr.data instanceof Float64Array)) buf = fr.data;
    const { data, width: w, height: h } = fr;
    timing.read += performance.now() - t; t = performance.now();
    const tm = frameTime(fr.header, fr.comments, cfg.timeAt || 'start'), pt = framePointing(fr.header), pier = pierSide(fr.header).side;
    let reloc = 0, rot = 0;
    if (!M) {
      for (let s = 0; s < nS; s++) { const c = centroidIter(data, w, h, cfg.stars[s].x, cfg.stars[s].y, half); pos[2 * s] = c[2] > 0 ? c[0] : cfg.stars[s].x; pos[2 * s + 1] = c[2] > 0 ? c[1] : cfg.stars[s].y; }
      const fit = fitPsf(data, w, h, pos[0], pos[1], Math.max(half, 8), { rotate: cfg.rotate !== false });
      sigma = fit.ok && Number.isFinite(fit.sx) ? Math.min(12, Math.max(0.8, 0.5 * (fit.sx + fit.sy))) : 2; shape0 = fit.ok ? { sx: fit.sx, sy: fit.sy, theta: fit.theta } : null;
      const ar = cfg.aperRange || [1.5, 6], nr = cfg.annRange || [6, 15];
      const apertures = cfg.apertures || linspace(ar[0], ar[1], cfg.nAper || 12).map((v) => v * sigma), annuli = cfg.annuli || linspace(nr[0], nr[1], cfg.nAnn || 4).map((v) => v * sigma);
      M = makeMeasurements(nF, nS, apertures, annuli, cfg.gap ?? 2);
      for (let a = 1; a < M.nA; a++) if (Math.abs(M.apertures[a] - 3 * sigma) < Math.abs(M.apertures[liveA] - 3 * sigma)) liveA = a;
      refPos = Float64Array.from(pos); refSources = detectSources(data, w, h, { max: 40 }).sources; pier0 = pier;
      meta = { width: w, height: h, object: typeof fr.header.OBJECT === 'string' ? fr.header.OBJECT.trim() : '', telescope: String(fr.header.TELESCOP ?? '').trim(), instrument: String(fr.header.INSTRUME ?? '').trim(), filter: String(fr.header.FILTER ?? '').trim(), observer: String(fr.header.OBSERVER ?? '').trim(), gain: Number(fr.header.GAIN ?? fr.header.EGAIN) || null, pixelScale: pixelScale(fr.header).scale ?? null, compression: fr.compression || null, bitpix: fr.header.BITPIX };
      if (cfg.ellipse && shape0) { const q = Math.min(shape0.sx, shape0.sy) / Math.max(shape0.sx, shape0.sy); if (cfg.ellipse === true || q < 0.8) cfg = { ...cfg, ellipseShape: { q, theta: -shape0.theta + (shape0.sx >= shape0.sy ? 0 : Math.PI / 2) } }; }
    } else {
      const tk = trackStars(data, w, h, pos, next, { half });
      // Is this still the same set of stars? Reasons to check against the whole field: stars lost, the target much
      // fainter than before, a jump of more than half the search box (the box may have caught a neighbour), the user's
      // stars no longer related to the first frame by a rotation and shift, a pause in the sequence (a meridian flip
      // takes minutes), or the mount reporting the other pier side.
      const c = centroidIter(data, w, h, next[0], next[1], half), prevPeak = M.peak[(used - 1) * nS];
      let need = (tk.lost >= Math.max(1, nS - 1) && nS > 1) || !(c[2] > 0) || (Number.isFinite(prevPeak) && data[Math.round(next[1]) * w + Math.round(next[0])] - c[3] < 0.25 * (prevPeak - c[3]));
      if (Math.hypot(tk.dx, tk.dy) > 0.5 * half) need = true;
      let Tf = nS >= 2 ? fitSimilarity(Array.from({ length: nS }, (_, s) => [refPos[2 * s], refPos[2 * s + 1], next[2 * s], next[2 * s + 1]])) : null;
      if (Tf && (Math.abs(Tf.scale - 1) > 0.03 || (nS >= 3 && Tf.rms > 2))) need = true;
      const dtMed = dts.length >= 3 ? medianOf(dts) : NaN;
      if (Number.isFinite(dtMed) && tm.jd - prevJd > 5 * dtMed) need = true;
      if (pier && pier0 && pier !== pier0) { need = true; pier0 = pier; }
      if (need && refSources.length >= 3) {
        const cur = detectSources(data, w, h, { max: 40 }).sources;
        let T = matchAsterism(refSources, cur, { mirror: !!cfg.mirror });
        if (!T) { const sh = estimateShift(refSources, cur, w, h); if (sh.votes >= 3) T = sh.flip ? { a: -1, b: 0, tx: w - 1 + sh.dx, ty: h - 1 + sh.dy, mirror: false, rotation: Math.PI, scale: 1 } : { a: 1, b: 0, tx: sh.dx, ty: sh.dy, mirror: false, rotation: 0, scale: 1 }; }
        if (T) { const pl = placeStars(data, w, h, refPos, T, next, { half }); Tf = pl.T || T; relocated++; reloc = 1; }
      }
      if (Tf) rot = Tf.rotation * 180 / Math.PI;
      [pos, next] = [next, pos];
    }
    const ra = Number.isFinite(cfg.target?.ra) ? cfg.target.ra : pt.ra, dec = Number.isFinite(cfg.target?.dec) ? cfg.target.dec : pt.dec;
    const lat = Number.isFinite(cfg.site?.lat) ? cfg.site.lat : pt.lat, lon = Number.isFinite(cfg.site?.lon) ? cfg.site.lon : pt.lon;
    let jd = tm.jd, scale = tm.scale;
    if (scale === 'UTC' && Number.isFinite(ra) && Number.isFinite(dec)) { jd = utcToBjdTdb(tm.jd, ra, dec); scale = 'BJD_TDB'; }
    const am = frameAirmass(fr.header, { jdUtc: tm.scale === 'UTC' ? tm.jd : NaN, ra, dec, lat, lon });
    const k = used++;
    if (Number.isFinite(prevJd) && tm.jd > prevJd) dts.push(tm.jd - prevJd); prevJd = tm.jd;
    M.time[k] = jd; M.airmass[k] = am.airmass; M.exptime[k] = tm.exptime; M.rot[k] = rot; M.relocated[k] = reloc;
    measureFrame(M, k, data, w, h, pos, { psf, method: cfg.method || 'exact', psfHalf: Math.max(6, Math.ceil(4 * sigma)), sigma0: sigma, rotate: cfg.rotate !== false, optimal: cfg.optimal !== false, ellipse: cfg.ellipseShape || null, oversample: cfg.oversample ?? (sigma < 1.5 ? 3 : 1) });
    frames.push({ name: fr.name, jd, jdHeader: tm.jd, scale, keyword: tm.keyword, shifted: tm.shifted, airmassSource: am.source, index: k });
    scaleSeen.add(scale);
    timing.measure += performance.now() - t;
    // a running light curve for the live display: target over the comparisons at the aperture nearest 3 sigma
    const nm = M.nN >> 1, fl = (s) => { const q = k * nS + s; return M.raw[q * M.nA + liveA] - M.area[q * M.nA + liveA] * M.bg[(q * M.nA + liveA) * M.nN + nm]; };
    let cs = 0; for (let s = 1; s < nS; s++) cs += fl(s);
    const el = (performance.now() - timing.t0) / 1000;
    onProgress({ stage: 'frames', done: f + 1, total: nF, name: fr.name, index: k, file: f, jd, airmass: am.airmass, pos: Array.from(pos), x: pos[0], y: pos[1], fwhm: M.fwhm[k * nS], sky: M.bg[(k * nS * M.nA + liveA) * M.nN + nm], target: fl(0), live: nS > 1 ? fl(0) / cs : fl(0), rot, relocated: reloc, elapsed: el, eta: el / (f + 1) * (nF - f - 1), sigma, liveAperture: M.apertures[liveA], gap: M.gap, liveAnnulus: M.annuli[nm] });
  }
  if (!M || used < 5) throw new Error(used ? 'Fewer than 5 frames could be measured.' : 'No frame could be read. ' + (frames[0]?.error || ''));
  M.count = used;
  timing.total = performance.now() - timing.t0;
  let t = performance.now();
  let fitter = makeFitter(cfg), scoreNote = null; const nComp = nS > 2 ? nS + (cfg.weighted === false ? 1 : 2) : nS, kinds = psf === 'none' ? 0 : (psf === 'both' ? 2 : 1) + (cfg.optimal !== false && psf !== 'moffat' ? 1 : 0);
  const total = (kinds + M.nA * M.nN * (M.rawE ? 2 : 1)) * nComp; let batch = [], last = performance.now();
  const search = (ft) => optimise(M, { fit: { ...(cfg.fit || {}), gain: cfg.gain || meta.gain || 1 }, psf: psf !== 'none', weighted: cfg.weighted !== false, fitter: ft, onRow: (row, i, best) => { batch.push(row); const now = performance.now(); if (now - last > 120 || i + 1 === total) { onProgress({ stage: 'optimise', done: i + 1, total, rows: batch, best, restart: i === 0 }); batch = []; last = now; } } });
  let opt = search(fitter);
  if (fitter && opt.best < 0) {       // the transit model could not be evaluated anywhere (limb darkening that is not a physical profile, a/R* below 1, a transit outside the night): say so and rank with the quick fit
    scoreNote = 'The transit model could not be fitted with these planet parameters (check the limb-darkening coefficients, a/R★ and the mid-transit time); candidates were ranked with the quick trapezoid fit instead.';
    fitter = null; opt = search(null);
  }
  timing.optimise = performance.now() - t;
  const settings = { software: 'Exoplanet Science Lab photometry', version: PHOT_VERSION, stars: Array.from({ length: nS }, (_, s) => ({ x: refPos[2 * s], y: refPos[2 * s + 1] })), sigma, firstFramePsf: shape0, apertures: Array.from(M.apertures), annuli: Array.from(M.annuli), gap: M.gap, psf, rotate: cfg.rotate !== false, optimal: cfg.optimal !== false, ellipse: M.ellipse, method: cfg.method || 'exact', background: 'sigma-clipped median (3 sigma, 5 iterations) of the pixels whose centres lie in the annulus', centroid: 'iterated thresholded centroid, then a Gaussian-windowed centroid', timeAt: cfg.timeAt || 'start', target: cfg.target || null, site: cfg.site || null, score: fitter ? 'transit model least squares (EXOTIC bounds)' : 'quick trapezoid fit', scoreNote, planet: fitter ? cfg.planet : null, fit: cfg.fit || {}, half, calibration: { bias: cfg.cal?.bias?.n || 0, dark: cfg.cal?.dark?.n || 0, flat: cfg.cal?.flat?.n || 0 }, frame: cfg.frame || null, meta };
  return { M, opt, frames, sigma, timeSystem: scaleSeen.size === 1 ? [...scaleSeen][0] : [...scaleSeen].join('+'), relocated, timing, kind: 'stack', settings, meta, scoreNote, usedTransit: !!fitter };
}

/**
 * Which QUALITY bits reject a cadence: lightkurve's presets (src/core/lcprep.js QUALITY_BITMASKS). The default is
 * lightkurve's 'default' (TESS 17087; Kepler and K2 1130799: attitude tweak, safe mode, coarse and Earth point,
 * desaturation, manual exclude, ...; checked to keep the same cadences as lightkurve in test/tpf_lightkurve.test.mjs).
 * Until 2026-11-16 TESS and Kepler rejected any flag, which also dropped good cadences with informational bits
 * (stray light, cosmic ray in a collateral pixel).
 */
export const defaultQuality = (mission, preset = 'default') => qualityBitmask(mission, preset);

/** Self-flat-fielding of a light curve with centroids (K2 roll systematics); lc: { time, norm, x, y, keep }. Returns sffDetrend's result with `detrended`. */
export function sffRun(lc, opts = {}) {
  const t0 = performance.now(), out = sffDetrend(lc.time, lc.norm, lc.x, lc.y, { ...opts, keep: lc.keep || null });
  return out ? { ...out, detrended: out.corrected, ms: performance.now() - t0, kind: 'sff' } : null;
}

/** Photometry of a target pixel file (bytes of the FITS file). cfg: { x, y, customMask, quality } */
export async function runTpf(buffer, cfg = {}) {
  const t0 = performance.now(), tpf = readTargetPixelFile(await openFits(buffer)), t1 = performance.now();
  cfg = { ...cfg, quality: typeof cfg.quality === 'number' ? cfg.quality : defaultQuality(tpf.mission, cfg.quality || 'default') };
  const opt = optimiseTpf(tpf, cfg);
  if (cfg.customMask && cfg.customMask.some((v) => v)) {
    const lc = tpfLightCurve(tpf, cfg.customMask, cfg), good = []; for (let i = 0; i < lc.ok.length; i++) if (lc.ok[i]) good.push(i);
    const t = Float64Array.from(good, (i) => lc.time[i]), f = Float64Array.from(good, (i) => lc.flux[i]);
    opt.tried.push({ name: 'your pixels', npix: lc.npix, scatter: segmentScatter(t, f, 0.5, true, true), exotic: segmentScatter(t, f, 0.5, false, false), flux: medianOf(f), mask: Uint8Array.from(cfg.customMask), n: good.length, custom: true, eligible: true });
    if (cfg.forceCustom) { opt.best = opt.tried.length - 1; opt.lc = { ...lc, good }; }
  }
  const timing = { read: t1 - t0, optimise: performance.now() - t1 };
  return { kind: 'tpf', opt, timing, meta: { mission: tpf.mission, object: tpf.object, id: tpf.id, sector: tpf.sector, quarter: tpf.quarter, campaign: tpf.mission === 'K2' ? tpf.quarter : null, quality: cfg.quality, ra: tpf.ra, dec: tpf.dec, exptime: tpf.exptime, cadence: tpf.cadence, nx: tpf.nx, ny: tpf.ny, ncad: tpf.ncad, bkgSubtracted: tpf.bkgSubtracted } };
}

/** The light curve of one TPF candidate (for when the user picks another row of the table). */
export async function tpfCandidate(buffer, mask, cfg = {}) {
  const tpf = readTargetPixelFile(await openFits(buffer)), lc = tpfLightCurve(tpf, mask, cfg), good = [];
  for (let i = 0; i < lc.ok.length; i++) if (lc.ok[i]) good.push(i);
  return { ...lc, good };
}

/**
 * Residuals of a light curve for the centroid regression, and the regression itself.
 * For a stack the residual is flux / quick-fit model - 1 (already in lc.resid); for a long series (TPF) it is
 * flux / running median - 1 with a window of `windowDays`, which keeps transits out of the trend only if they are
 * shorter than about a third of the window.
 */
export function gpDetrend(lc, { useTime = false, windowDays = 0.75, maxHyper = 300, maxCond = 1200 } = {}) {
  const n = lc.time.length; let resid = lc.resid, keep = lc.keep || null, norm = lc.norm;
  if (!resid) {
    const cad = (lc.time[n - 1] - lc.time[0]) / Math.max(1, n - 1), win = Math.max(5, 2 * Math.floor(windowDays / cad / 2) + 1), sm = runningMedian(lc.norm, win);
    resid = Float64Array.from(lc.norm, (v, i) => v / sm[i] - 1);
    // clip strong outliers (flares, momentum dumps) out of the fit
    const mad = 1.4826 * medianOf(Array.from(resid, Math.abs)); keep = Uint8Array.from(resid, (v) => (Math.abs(v) < 5 * mad ? 1 : 0));
  }
  const inputs = [lc.x, lc.y]; if (useTime) inputs.push(lc.time);
  const t0 = performance.now(), out = detrendWithCentroids(inputs, resid, keep, { maxHyper, maxCond });
  if (!out) return null;
  const detrended = Float64Array.from(norm, (v, i) => (Number.isFinite(out.trend[i]) ? v / (1 + out.trend[i]) : v));
  return { ...out, detrended, ms: performance.now() - t0, useTime };
}

/**
 * Decorrelation of a light curve's residuals against detector and sky state, as a preview of what the analyzer fits
 * together with the transit: linear regressors (centroid x, y and their squares and product, FWHM, sky, airmass,
 * comparison flux, a polynomial in time, PLD components) and / or nearest-neighbour Gaussian kernel regression on chosen
 * features (src/core/detrend.js). The residual 1 + r (r: the stack's residual about its fit, or a TPF's flux about a
 * running median) is fitted with buildProblem with no transit in it (Rp/R* = 1e-6), so the coefficients are the ones
 * the likelihood would integrate out; the trend is baseline - 1.
 * @param lc    { time, norm, resid?, keep?, columns: { name: array } }
 * @param spec  { columns: [names], poly, pld: [names], kernel: { features: [names], neighbors } }
 * @returns { trend, detrended (norm / (1 + trend)), rmsBefore, rmsAfter, hourBefore, hourAfter (1-hour binned rms), names, dropped, kernel: k, coeffs, ms } or null
 */
export function regressDetrend(lc, spec, { windowDays = 0.75 } = {}) {
  const t0 = performance.now(), n = lc.time.length;
  let resid = lc.resid, keep = lc.keep ? Uint8Array.from(lc.keep) : null;
  if (!resid) {
    const cad = (lc.time[n - 1] - lc.time[0]) / Math.max(1, n - 1), win = Math.max(5, 2 * Math.floor(windowDays / cad / 2) + 1), sm = runningMedian(lc.norm, win);
    resid = Float64Array.from(lc.norm, (v, i) => v / sm[i] - 1);
    const mad = 1.4826 * medianOf(Array.from(resid, Math.abs)); keep = Uint8Array.from(resid, (v) => (Math.abs(v) < 5 * mad ? 1 : 0));
  }
  const need = [...(spec.columns || []).flatMap((c) => (c === 'xy' || c === 'xc2' || c === 'yc2' ? ['xc', 'yc'] : [c])), ...(spec.pld || []), ...((spec.kernel && spec.kernel.features) || [])];
  const idx = []; for (let i = 0; i < n; i++) if ((!keep || keep[i]) && Number.isFinite(resid[i]) && Number.isFinite(lc.time[i]) && need.every((c) => !lc.columns[c] || Number.isFinite(lc.columns[c][i]))) idx.push(i);
  if (idx.length < 12) return null;
  const sub = Object.fromEntries(Object.entries(lc.columns).map(([k, a]) => [k, Float64Array.from(idx, (i) => a[i])])), t = Float64Array.from(idx, (i) => lc.time[i] - Math.floor(lc.time[0]));
  const D = detrendFromColumns(sub, spec, t, null);
  if (!D.regressors && !D.kernel) return null;
  const y = Float64Array.from(idx, (i) => 1 + resid[i]), data = { t, f: y, e: new Float64Array(idx.length).fill(1) };
  if (D.regressors) data.regressors = D.regressors; if (D.kernel) data.kernel = D.kernel;
  const flat = { rprs: 1e-6, ars: 50, inc: 60, per: 1e4, tmid: -1e3, ecc: 0, omega: 0, ld0: 0, ld1: 0, ld2: 0, ld3: 0 };
  const d = buildProblem({ data, values: flat, ldLaw: 'nonlinear', free: [{ key: 'rprs', prior: { type: 'uniform', a: 0, b: 1 } }] }).detail([1e-6]);
  if (!d) return null;
  const trend = new Float64Array(n).fill(NaN); idx.forEach((i, k) => { trend[i] = d.base[k] - 1; });
  const after = Float64Array.from(idx, (i, k) => y[k] / d.base[k] - 1), before = Float64Array.from(idx, (i) => resid[i]);
  const rms = (a) => { let m = 0; for (const v of a) m += v; m /= a.length; let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length); };
  const hour = (a) => { const b = new Map(); idx.forEach((i, k) => { const key = Math.floor(lc.time[i] * 24); if (!b.has(key)) b.set(key, []); b.get(key).push(a[k]); }); const m = [...b.values()].filter((q) => q.length >= 3).map((q) => q.reduce((s, v) => s + v, 0) / q.length); return m.length > 2 ? rms(m) : NaN; };
  const detrended = Float64Array.from(lc.norm, (v, i) => (Number.isFinite(trend[i]) ? v / (1 + trend[i]) : v));
  return { trend, detrended, rmsBefore: rms(before), rmsAfter: rms(after), hourBefore: hour(before), hourAfter: hour(after), names: D.names, dropped: D.dropped, kernel: D.kernel ? D.kernel.k : 0, coeffs: d.regCoeffs ? d.regCoeffs[0] : [], n: idx.length, ms: performance.now() - t0, kind: 'regress', spec };
}

/** PLD components of a target pixel file over the cadences `good` (indices into the file) for the pixels of `mask` (src/core/detrend.js pldBasis). */
export function tpfPld(tpf, mask, good, ncomp = 0) {
  const np = tpf.nx * tpf.ny, pix = []; for (let p = 0; p < np; p++) if (mask[p]) pix.push(Float64Array.from(good, (c) => tpf.flux[c * np + p]));
  if (pix.length < 2) return null;
  return pldBasis(pix, ncomp > 0 ? { ncomp } : {});
}

/**
 * Pixel-level decorrelation of a K2 (or TESS / Kepler) target pixel file as lightkurve's PLDCorrector sets it up for K2
 * (src/core/k2.js pldCorrect): the flux is the aperture sum over `mask`; the PLD pixels are lightkurve's 3σ threshold
 * mask ('center'), each over that flux; the background pixels are those below the median image, normalised by their
 * sum; order 3 with 16 principal components, a degree-5 spline with n / 50 columns, 5σ clipping.
 * @param good cadence indices used (e.g. tpfLightCurve's ok ones); opts as pldCorrect, plus pldMask, bkgMask
 * @returns pldCorrect's result over `good`, with pldMask, bkgMask
 */
export function k2Pld(tpf, mask, good, opts = {}) {
  const np = tpf.nx * tpf.ny, img = tpfMedianImage(tpf, 1, qualityBitmask(tpf.mission, 'default'));
  const pldMask = opts.pldMask || thresholdMask(img, tpf.nx, tpf.ny, 3, tpf.nx / 2, tpf.ny / 2, { lightkurve: true });
  const sorted = Float64Array.from(img, (v) => (v === v ? v : 0)).sort(), med = sorted.length & 1 ? sorted[sorted.length >> 1] : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]);
  const bkgMask = opts.bkgMask || Uint8Array.from(img, (v) => ((v === v ? v : 0) >= med ? 0 : 1));
  const lc = tpfLightCurve(tpf, mask, { quality: 0 }), series = (m) => { const out = []; for (let p = 0; p < np; p++) if (m[p]) { const s = Float64Array.from(good, (c) => tpf.flux[c * np + p]); if (s.every(Number.isFinite)) out.push(s); } return out; };
  const flux = Float64Array.from(good, (c) => lc.flux[c]), err = Float64Array.from(good, (c) => lc.err[c]), time = Float64Array.from(good, (c) => lc.time[c]);
  const r = pldCorrect(series(pldMask), flux, err, time, { ...opts, bkg: opts.bkg === false ? null : series(bkgMask) });
  return r ? { ...r, pldMask, bkgMask, flux, time } : null;
}

/**
 * Cadences of a TPF during K2 thruster firings (src/core/k2.js thrusterFlags), found on every cadence with a centroid so
 * that a jump is attributed to the cadence it happens at, not to the next one a quality mask kept: QUALITY bits 20 and
 * 21 plus 5σ jumps of the centroid along the roll. Returns Uint8Array over the file's cadences (1 = firing) and counts.
 */
export function k2Thrusters(tpf, mask, opts = {}) {
  const lc = tpfLightCurve(tpf, mask, { quality: 0 }), g = []; for (let c = 0; c < tpf.ncad; c++) if (lc.ok[c]) g.push(c);
  const th = thrusterFlags(Float64Array.from(g, (c) => lc.time[c]), Float64Array.from(g, (c) => lc.x[c]), Float64Array.from(g, (c) => lc.y[c]), Int32Array.from(g, (c) => tpf.quality[c]), opts);
  const flags = new Uint8Array(tpf.ncad); g.forEach((c, k) => { if (th.flags[k]) flags[c] = 1; });
  return { flags, fromQuality: th.fromQuality, fromCentroid: th.fromCentroid, both: th.both };
}

export { smoothScatter };

/**
 * Split a multi-extension FITS file whose extensions are images (plain or tile-compressed) into one frame source
 * per image: [{ name, buffer }], each a standalone FITS file (the primary header, then that extension). A file
 * with a single image comes back as one source. Used for image sequences shipped as one file.
 */
export async function splitFits(buffer, baseName = 'frame') {
  let u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (isGzip(u8)) u8 = new Uint8Array(await gunzip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)));
  const fits = parseFits(u8), hd = fits.hdus, B = 2880, end = (h) => h.dataOffset + Math.ceil(h.dataBytes / B) * B, out = [];
  const isImg = (h) => (h.type === 'image' || h.type === 'compressed') && h.shape.length >= 2;
  if (hd.filter(isImg).length <= 1) return [{ name: baseName, buffer: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) }];
  const head = hd[0].type === 'empty' ? u8.subarray(0, hd[0].dataOffset) : null;
  for (let i = 0; i < hd.length; i++) {
    if (!isImg(hd[i])) continue;
    const a = i === 0 ? 0 : end(hd[i - 1]), b = Math.min(u8.length, end(hd[i])), name = (hd[i].name && hd[i].name !== 'PRIMARY' && hd[i].name !== 'COMPRESSED_IMAGE' ? hd[i].name : `${baseName}[${i}]`);
    if (i === 0 || !head) { if (i === 0) out.push({ name, buffer: u8.slice(0, b).buffer }); continue; }
    const bytes = new Uint8Array(head.length + Math.ceil((b - a) / B) * B); bytes.set(head, 0); bytes.set(u8.subarray(a, b), head.length);
    out.push({ name, buffer: bytes.buffer });
  }
  return out;
}
