// Photometry one frame at a time: what runStack (src/photometry/pipeline.js) does for each frame of a folder,
// for frames that arrive while the night goes on (the Run page, esl.observe). The first frame fixes the stars'
// positions, the PSF width and the apertures; each later frame is tracked, re-found in the field when tracking
// looks wrong (stars lost, a jump, a pause, a pier flip), and measured at every aperture and annulus. The
// measurement arrays grow as frames come. The choice of aperture and comparison stars (optimise) and the transit
// fit stay at the end, as in runStack. No DOM.
//
//   const R = createReducer(cfg)        cfg as runStack takes it (stars, apertures, psf, target, site, ...)
//   R.add(frame)                        frame = { data (calibrated), width, height, header, comments, name } -> progress
//   R.result()                          { M (count = frames measured), frames, sigma, refPos, shape0, meta, relocated, timeSystem, cfg }
//   chooseStars(data, w, h, opts)       the target and comparison stars of a first frame, for cfg.stars

import { frameTime, frameAirmass, framePointing, utcToBjdTdb, pierSide, pixelScale } from './fits.js';
import { rankComparisons } from './imexam.js';
import { centroidIter, fitPsf, detectSources, estimateShift, trackStars, makeMeasurements, measureFrame, linspace, medianOf, fitSimilarity, matchAsterism, placeStars } from './photometry.js';

const clockMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** The measurements of makeMeasurements with room for nF frames, the frames already measured copied over. */
export function growMeasurements(M, nF) {
  const N = makeMeasurements(nF, M.nS, M.apertures, M.annuli, M.gap);
  N.count = M.count;
  for (const k of Object.keys(M)) {
    const a = M[k];
    if (ArrayBuffer.isView(a) && a.length && a.length % M.nF === 0 && k !== 'apertures' && k !== 'annuli') {
      if (!N[k] || N[k].length !== a.length / M.nF * nF) N[k] = new a.constructor(a.length / M.nF * nF).fill(k === 'rawE' ? NaN : 0);
      N[k].set(a);
    }
  }
  if (M.ellipse) N.ellipse = M.ellipse;
  return N;
}

export function createReducer(cfg0, { capacity = 64, timing = { measure: 0, t0: clockMs() } } = {}) {
  let cfg = cfg0;
  const nS = cfg.stars.length, half = cfg.half || 8, psf = cfg.psf || 'both';
  let M = null, pos = new Float64Array(2 * nS), next = new Float64Array(2 * nS), refSources = null, refPos = null, sigma = 2, shape0 = null;
  const frames = [], scaleSeen = new Set(), dts = [];
  let relocated = 0, used = 0, prevJd = NaN, pier0 = null, liveA = 0, meta = null;

  function add(fr) {
    const t = clockMs();
    const { data, width: w, height: h } = fr;
    const tm = frameTime(fr.header, fr.comments, cfg.timeAt || 'start'), pt = framePointing(fr.header), pier = pierSide(fr.header).side;
    let reloc = 0, rot = 0;
    if (!M) {
      for (let s = 0; s < nS; s++) { const c = centroidIter(data, w, h, cfg.stars[s].x, cfg.stars[s].y, half); pos[2 * s] = c[2] > 0 ? c[0] : cfg.stars[s].x; pos[2 * s + 1] = c[2] > 0 ? c[1] : cfg.stars[s].y; }
      const fit = fitPsf(data, w, h, pos[0], pos[1], Math.max(half, 8), { rotate: cfg.rotate !== false });
      sigma = fit.ok && Number.isFinite(fit.sx) ? Math.min(12, Math.max(0.8, 0.5 * (fit.sx + fit.sy))) : 2; shape0 = fit.ok ? { sx: fit.sx, sy: fit.sy, theta: fit.theta } : null;
      const ar = cfg.aperRange || [1.5, 6], nr = cfg.annRange || [6, 15];
      const apertures = cfg.apertures || linspace(ar[0], ar[1], cfg.nAper || 12).map((v) => v * sigma), annuli = cfg.annuli || linspace(nr[0], nr[1], cfg.nAnn || 4).map((v) => v * sigma);
      M = makeMeasurements(capacity, nS, apertures, annuli, cfg.gap ?? 2);
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
    if (used >= M.nF) M = growMeasurements(M, M.nF * 2);
    const k = used++;
    if (Number.isFinite(prevJd) && tm.jd > prevJd) dts.push(tm.jd - prevJd); prevJd = tm.jd;
    M.time[k] = jd; M.airmass[k] = am.airmass; M.exptime[k] = tm.exptime; M.rot[k] = rot; M.relocated[k] = reloc;
    measureFrame(M, k, data, w, h, pos, { psf, method: cfg.method || 'exact', psfHalf: Math.max(6, Math.ceil(4 * sigma)), sigma0: sigma, rotate: cfg.rotate !== false, optimal: cfg.optimal !== false, ellipse: cfg.ellipseShape || null, oversample: cfg.oversample ?? (sigma < 1.5 ? 3 : 1) });
    frames.push({ name: fr.name, jd, jdHeader: tm.jd, scale, keyword: tm.keyword, shifted: tm.shifted, airmassSource: am.source, index: k });
    scaleSeen.add(scale);
    timing.measure += clockMs() - t;
    // a running light curve for the live display: target over the comparisons at the aperture nearest 3 sigma
    const nm = M.nN >> 1, fl = (s) => { const q = k * nS + s; return M.raw[q * M.nA + liveA] - M.area[q * M.nA + liveA] * M.bg[(q * M.nA + liveA) * M.nN + nm]; };
    let cs = 0; for (let s = 1; s < nS; s++) cs += fl(s);
    return { name: fr.name, index: k, jd, airmass: am.airmass, pos: Array.from(pos), x: pos[0], y: pos[1], fwhm: M.fwhm[k * nS], sky: M.bg[(k * nS * M.nA + liveA) * M.nN + nm], target: fl(0), live: nS > 1 ? fl(0) / cs : fl(0), rot, relocated: reloc, sigma, liveAperture: M.apertures[liveA], gap: M.gap, liveAnnulus: M.annuli[nm] };
  }

  return {
    add,
    /** A frame that could not be read, kept in the frame list. */
    skip(name, error) { frames.push({ name: name || '', error: String(error) }); },
    get used() { return used; },
    get M() { return M; },
    get sigma() { return sigma; },
    result() {
      if (M) M.count = used;
      return { M, frames, sigma, refPos, shape0, meta, relocated, timeSystem: scaleSeen.size === 1 ? [...scaleSeen][0] : [...scaleSeen].join('+'), cfg, half, psf, timing };
    },
  };
}

/**
 * The stars to measure on a first (calibrated) frame: the target is the star nearest the expected position (the
 * field centre, where the pointing puts it, unless `at` is given) that is not a faint field star; the comparison
 * stars are ranked by rankComparisons (src/core/imexam.js): similar brightness, unsaturated, no neighbour brighter
 * than 10% of the star inside the largest sky annulus, and far enough from the edge for the largest sky annulus (`annulus` sigma of
 * the PSF, 15 as createReducer's default range, plus the gap), and at least a quarter as bright as the target. Stars
 * that fail those tests are used only when fewer than `min` (3) pass, and are reported in `warnings`.
 * Crowded comparison stars bias a transit's depth: a neighbour's light moves in and out of the aperture and the sky
 * annulus as the seeing changes, and the seeing follows the airmass through the night (2026-11-19: a pair 2 FWHM
 * apart took 88% of a simulated transit's depth away).
 * @returns { stars: [{ x, y }] target first, sigma (PSF of the target), comparisons: the ranked candidates used, warnings }
 */
export function chooseStars(data, w, h, { at = null, maxAdu = 65535, n = 5, min = 3, annulus = 15, gap = 2, crowd = null } = {}) {
  const { sources } = detectSources(data, w, h, { max: 60, saturation: maxAdu * 0.8 });
  if (!sources.length) return null;
  const cx = at ? at.x : (w - 1) / 2, cy = at ? at.y : (h - 1) / 2, dist = (s) => Math.hypot(s.x - cx, s.y - cy);
  // candidates: unsaturated stars not much fainter than the brightest unsaturated one (a saturated star must not set the bar)
  const unsat = sources.filter((s) => !s.saturated), pool = unsat.length ? unsat : sources, fmax = Math.max(...pool.map((s) => s.flux));
  const bright = pool.filter((s) => s.flux > 0.1 * fmax);
  const tgt = (bright.length ? bright : pool).slice().sort((a, b) => dist(a) - dist(b))[0];
  const fit = fitPsf(data, w, h, tgt.x, tgt.y, 8, {});
  const sigma = fit.ok && Number.isFinite(fit.sx) ? Math.min(12, Math.max(0.8, 0.5 * (fit.sx + fit.sy))) : 2, fwhm = 2.3548 * sigma;
  // isolation out to the largest sky annulus: a neighbour there changes the sky with the seeing
  const ranked = rankComparisons(sources, tgt, { w, h, fwhm, edge: annulus * sigma + gap + 1, crowd: crowd ?? (annulus * sigma + gap) / fwhm, saturation: maxAdu * 0.8 });
  // isolated stars at least a quarter as bright as the target; a faint comparison's flux is mostly sky, and its
  // sky error follows the seeing (2026-11-19: three comparisons at 6-17 % of the target took a third of the depth)
  const brightEnough = (r) => r.ratio >= 0.25 && !r.notes.includes('saturated');
  const good = ranked.filter((r) => r.usable && brightEnough(r)), warnings = [];
  let use = good.slice(0, n);
  if (use.length < min) {
    const extra = ranked.filter((r) => !use.includes(r) && brightEnough(r)).slice(0, min - use.length);
    const last = extra.length + use.length < min ? ranked.filter((r) => !use.includes(r) && !extra.includes(r)).slice(0, min - use.length - extra.length) : [];
    for (const r of extra.concat(last)) warnings.push(`comparison at (${r.x.toFixed(0)}, ${r.y.toFixed(0)}) used although ${r.notes.length ? r.notes.join(', ') : 'faint'}`);
    use = use.concat(extra, last);
  }
  // the target's own neighbours, found with a small centroid box (the default box pulls a close neighbour onto the star)
  const fine = detectSources(data, w, h, { max: 200, half: 3, minSep: 3, saturation: maxAdu * 0.8 }).sources;
  const tf = fine.reduce((b, s) => (Math.hypot(s.x - tgt.x, s.y - tgt.y) < Math.hypot(b.x - tgt.x, b.y - tgt.y) ? s : b), fine[0] || tgt);   // the target in the same small box
  const crowdT = fine.filter((s) => s !== tf && Math.hypot(s.x - tgt.x, s.y - tgt.y) > 1.5 * fwhm && s.flux > 0.1 * tf.flux && Math.hypot(s.x - tgt.x, s.y - tgt.y) < 4 * fwhm);
  if (crowdT.length) warnings.push(`the target has ${crowdT.length} neighbour${crowdT.length > 1 ? 's' : ''} within 4 FWHM: its depth will be diluted unless the aperture excludes ${crowdT.length > 1 ? 'them' : 'it'}`);
  return { stars: [tgt, ...use].map((s) => ({ x: s.x, y: s.y })), sigma, comparisons: use, warnings };
}
