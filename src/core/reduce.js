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

import { frameTime, frameAirmass, framePointing, utcToBjdTdb, pierSide, pixelScale } from './fits.js';
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
