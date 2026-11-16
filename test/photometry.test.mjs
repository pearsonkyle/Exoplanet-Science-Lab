// Photometry against photutils, astropy and scipy on a synthetic frame with known stars and on real TESS / Kepler
// target pixel files (reference: test/make_photometry_reference.py), plus recovery of injected values on a
// synthetic stack of frames made here.
import { readFileSync } from 'node:fs';
import { openFits, readImage, readTargetPixelFile } from '../src/core/fits.js';
import { apertureSum, circleRectOverlap, annulusBackground, annulusPrepare, annulusFromSorted, centroidCom, centroidIter, fitPsf, detectSources, estimateShift, trackStars, makeMeasurements, measureFrame, fluxOf, optimise, quickFit, linspace,
  pipelineMask, dilateMask, tpfLightCurve, optimiseTpf, savgol2, smoothScatter, addStars, addNoise, trapezoid, frameStats } from '../src/core/photometry.js';
import { makeRng } from '../src/core/stats.js';
import { optimalFlux, matchAsterism, fitSimilarity, applySimilarity, sffDetrend } from '../src/core/photometry.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./photometry_reference.json', import.meta.url)));
const load = (n) => { const b = readFileSync(new URL('./data/' + n, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const P = ref.photometry, stars = P.truth.stars;
const pyround = (v) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r; };      // Python rounds halves to even; the reference cut its boxes that way
const im = readImage(await openFits(load('syn_i16.fits'))), { data, width: w, height: h } = im;

// --- circle / pixel overlap: the areas must add up to pi r^2
{
  let worst = 0;
  for (const [xc, yc, r] of [[10.3, 9.7, 0.4], [10, 10, 1], [10.5, 10.5, 2.5], [9.99, 10.01, 6.123], [10.37, 9.81, 0.05]]) {
    let a = 0; for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) a += circleRectOverlap(x - 0.5 - xc, y - 0.5 - yc, x + 0.5 - xc, y + 0.5 - yc, r);
    worst = Math.max(worst, Math.abs(a / (Math.PI * r * r) - 1));
  }
  check('exact pixel overlaps sum to the circle\'s area', worst < 1e-13, `largest relative error ${worst.toExponential(1)}; tolerance 1e-13`);
}

// --- aperture sums against photutils
{
  const worst = { exact: 0, subpixel: 0, center: 0, area: 0 };
  for (const row of P.apertures) for (const m of ['exact', 'subpixel', 'center']) stars.forEach((s, i) => {
    const r = apertureSum(data, w, h, s.x, s.y, row.r, m);
    worst[m] = Math.max(worst[m], Math.abs(r[0] / row[m][i] - 1));
    if (m === 'exact') worst.area = Math.max(worst.area, Math.abs(r[1] / row.area - 1));
  });
  check('aperture sums, exact overlap, match photutils', worst.exact < 1e-12 && worst.area < 1e-12, `largest relative difference ${worst.exact.toExponential(1)} (area ${worst.area.toExponential(1)}) over ${P.apertures.length} radii x ${stars.length} stars; tolerance 1e-12`);
  check('aperture sums, 5x5 sub-pixel sampling, match photutils', worst.subpixel < 1e-12, `largest relative difference ${worst.subpixel.toExponential(1)}; tolerance 1e-12`);
  check('aperture sums, pixel centres, match photutils', worst.center < 1e-12, `largest relative difference ${worst.center.toExponential(1)}; tolerance 1e-12`);
  // noise-free Gaussians: the flux inside r approaches F (1 - exp(-r^2 / 2 sigma^2)); pixel-integration makes it inexact at small r
  const clean = new Float64Array(w * h); addStars(clean, w, h, stars);
  let wc = 0, wa = 0;
  for (const row of P.clean_exact) row.photutils.forEach((v, i) => { const r = apertureSum(clean, w, h, stars[i].x, stars[i].y, row.r)[0]; wc = Math.max(wc, Math.abs(r / v - 1)); if (row.r >= 6) wa = Math.max(wa, Math.abs(r / row.analytic_point_sampled[i] - 1)); });
  check('scene made here + aperture sum = photutils on its own scene', wc < 1e-7, `largest relative difference ${wc.toExponential(1)}; tolerance 1e-7 (the erfc in stats.js is good to about 1e-8)`);
  check('aperture sum of a Gaussian star approaches the analytic encircled flux', wa < 3e-3, `largest relative difference ${wa.toExponential(1)} for r >= 6 px (sigma 2.1 px); tolerance 3e-3 (pixel-integrated star against the continuous formula)`);
  const e = apertureSum(data, w, h, 2, 3, 5);
  check('an aperture over the edge is flagged', e[3] === 1 && e[1] < Math.PI * 25);
}

// --- sky annulus against astropy sigma_clipped_stats on photutils' annulus pixels
{
  let wm = 0, wmean = 0, ws = 0, sky = 0;
  for (const a of P.annuli) stars.forEach((s, i) => {
    const r = annulusBackground(data, w, h, s.x, s.y, a.rin, a.rout, 3, 5), e = a.stats[i];
    wm = Math.max(wm, Math.abs(r[0] - e.median)); wmean = Math.max(wmean, Math.abs(r[1] - e.mean)); ws = Math.max(ws, Math.abs(r[2] - e.std)); if (a.rin >= 9) sky = Math.max(sky, Math.abs(r[0] - P.truth.sky));
  });
  check('annulus sigma-clipped median, mean and std match astropy', wm === 0 && wmean < 1e-10 && ws < 1e-10, `median exact, mean within ${wmean.toExponential(1)}, std within ${ws.toExponential(1)} counts; tolerance 1e-10`);
  let wq = 0;
  stars.forEach((s) => { annulusPrepare(data, w, h, s.x, s.y, 6, 20); for (const a of P.annuli) { const q = Array.from(annulusFromSorted(a.rin, a.rout)), r = annulusBackground(data, w, h, s.x, s.y, a.rin, a.rout); wq = Math.max(wq, Math.abs(q[0] - r[0]), Math.abs(q[1] - r[1]), Math.abs(q[2] - r[2]), Math.abs(q[3] - r[3])); } });
  check('the shared-sort annulus path gives the same statistics', wq < 1e-10, `largest difference ${wq.toExponential(1)}`);
  check('annulus median recovers the injected sky', sky < 3.5, `largest error ${sky.toFixed(2)} counts on a sky of ${P.truth.sky} with noise ${Math.sqrt(P.truth.sky + P.truth.read ** 2).toFixed(1)} per pixel, annuli starting at >= 9 px = 4.3 sigma of the PSF; tolerance 3.5`);
}

// --- centroids
{
  let wc = 0, wt = 0;
  for (const c of P.centroids) stars.forEach((s, i) => { const r = centroidCom(data, w, h, pyround(s.x), pyround(s.y), c.half, c.bkg); wc = Math.max(wc, Math.hypot(r[0] - c.com[i][0], r[1] - c.com[i][1])); });
  check('flux-weighted centroid matches photutils centroid_com', wc < 1e-10, `largest difference ${wc.toExponential(1)} px; tolerance 1e-10`);
  stars.slice(0, 5).forEach((s) => { const r = centroidIter(data, w, h, s.x + 2.3, s.y - 1.8, 7); wt = Math.max(wt, Math.hypot(r[0] - s.x, r[1] - s.y)); });
  check('iterated centroid finds the true position from 3 px away', wt < 0.08, `largest error ${wt.toFixed(3)} px for the five brightest stars; tolerance 0.08 px`);
}

// --- PSF fits against scipy least_squares on the same pixels
{
  let wp = 0, ws = 0, wf = 0, wchi = 0, wtrue = 0, wflux = 0;
  P.gauss.forEach((g, i) => {
    const s = stars[i], f = fitPsf(data, w, h, pyround(s.x), pyround(s.y), g.half);
    wp = Math.max(wp, Math.hypot(f.x - g.p[0], f.y - g.p[1])); ws = Math.max(ws, Math.abs(f.sx - g.p[3]), Math.abs(f.sy - g.p[4])); wf = Math.max(wf, Math.abs(f.flux / g.flux - 1)); wchi = Math.max(wchi, Math.abs(f.chi2 / g.chi2 - 1));
    if (i < 4) { wtrue = Math.max(wtrue, Math.hypot(f.x - s.x, f.y - s.y)); wflux = Math.max(wflux, Math.abs(f.flux / s.flux - 1)); }
  });
  check('2D Gaussian fit matches scipy least_squares', wp < 1e-5 && ws < 1e-5 && wf < 1e-5 && wchi < 1e-8, `position ${wp.toExponential(1)} px, sigma ${ws.toExponential(1)} px, flux ${wf.toExponential(1)}, chi2 ${wchi.toExponential(1)} relative; tolerances 1e-5, 1e-5, 1e-5, 1e-8`);
  check('2D Gaussian fit recovers the injected stars', wtrue < 0.03 && wflux < 0.03, `four brightest: position within ${wtrue.toFixed(4)} px, flux within ${(100 * wflux).toFixed(2)}% (the model is sampled at pixel centres, the stars are pixel-integrated); tolerances 0.03 px, 3%`);
  // a Moffat star (beta = 3) with noise, as a cutout stored in the reference
  const mo = P.moffat_scene, md = Float64Array.from(mo.cut.flat()), mw = mo.cut[0].length, mh = mo.cut.length;
  const f = fitPsf(md, mw, mh, mo.x0, mo.y0, mo.half, { model: 'moffat' }), g = mo.fit;
  const dp = Math.hypot(f.x - g[0], f.y - g[1]), dg = Math.abs(f.gamma / g[3] - 1), db = Math.abs(f.beta / g[4] - 1), dchi = Math.abs(f.chi2 / mo.chi2 - 1), dfl = Math.abs(f.flux / mo.truth.flux - 1);
  check('Moffat fit matches scipy least_squares', dp < 1e-5 && dg < 1e-5 && db < 1e-5 && dchi < 1e-8, `position ${dp.toExponential(1)} px, gamma ${dg.toExponential(1)}, beta ${db.toExponential(1)}, chi2 ${dchi.toExponential(1)} relative; tolerances 1e-5, 1e-5, 1e-5, 1e-8`);
  check('Moffat fit recovers the injected star', Math.hypot(f.x - mo.truth.x, f.y - mo.truth.y) < 0.02 && dfl < 0.03 && Math.abs(f.beta - mo.truth.beta) < 0.2, `position within ${Math.hypot(f.x - mo.truth.x, f.y - mo.truth.y).toFixed(4)} px, flux pi A gamma^2 / (beta - 1) within ${(100 * dfl).toFixed(2)}%, beta ${f.beta.toFixed(3)} (injected ${mo.truth.beta}); tolerances 0.02 px, 3%, 0.2`);
}

// --- detection
{
  const det = detectSources(data, w, h, { nsigma: 5 }), src = det.sources;
  let wd = 0, found = 0;
  for (let i = 0; i < P.dao.x.length; i++) { const d = Math.min(...src.map((s) => Math.hypot(s.x - P.dao.x[i], s.y - P.dao.y[i]))); if (d < 1) { found++; wd = Math.max(wd, d); } }
  let wt = 0; for (const s of stars) wt = Math.max(wt, Math.min(...src.map((q) => Math.hypot(q.x - s.x, q.y - s.y))));
  check('detection finds the same stars as DAOStarFinder', found === P.dao.x.length && src.length === stars.length, `${src.length} sources here, ${P.dao.x.length} from DAOStarFinder, ${stars.length} injected; positions agree within ${wd.toFixed(2)} px (different centroid definitions)`);
  check('detected positions are the injected ones, brightest first', wt < 0.25 && Math.hypot(src[0].x - stars[1].x, src[0].y - stars[1].y) < 0.1, `largest error ${wt.toFixed(3)} px (faintest star has S/N ~ 20); tolerance 0.25 px`);
  check('frame level and noise', Math.abs(det.background - P.dao.median) < 1.5 && Math.abs(det.sigma / P.dao.std - 1) < 0.1, `median ${det.background.toFixed(1)} (astropy sigma-clipped ${P.dao.median.toFixed(1)}), sigma ${det.sigma.toFixed(2)} (${P.dao.std.toFixed(2)})`);
}

// --- a stack of frames made here: drift, a jump, a transit of known depth on the target, a common airmass trend
{
  const rng = makeRng(7), W = 160, H = 140, nF = 90, depth = 0.012, t0 = 2459000.5, span = 0.16, tmid = t0 + 0.085, dur = 0.06;
  const base = [{ x: 80.3, y: 70.6, flux: 150000 }, { x: 40.2, y: 100.4, flux: 190000 }, { x: 120.7, y: 40.1, flux: 110000 }, { x: 110.2, y: 105.9, flux: 60000 }];
  const sig = 1.9, frame = new Float32Array(W * H);
  const apertures = linspace(1.5, 6, 7).map((v) => v * sig), annuli = linspace(6, 15, 3).map((v) => v * sig);
  const M = makeMeasurements(nF, base.length, apertures, annuli, 2);
  let pos = Float64Array.from(base.flatMap((s) => [s.x, s.y])), next = new Float64Array(pos.length), worstTrack = 0, lost = 0;
  const truth = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    const t = t0 + span * f / (nF - 1), am = 1.1 + 0.5 * (f / (nF - 1)) ** 2, ext = Math.exp(-0.25 * (am - 1.1)) * (1 + 0.02 * rng.normal());        // extinction and 2% transparency changes, common to all stars
    const dx = 0.04 * f + (f >= 50 ? 3.7 : 0) + 0.3 * Math.sin(f / 3), dy = -0.025 * f + (f >= 50 ? -2.9 : 0);      // slow drift and a guiding jump
    const tr = 1 - depth * trapezoid(t, tmid, dur); truth[f] = tr;
    frame.fill(420); addStars(frame, W, H, base.map((s, i) => ({ x: s.x + dx, y: s.y + dy, flux: s.flux * ext * (i === 0 ? tr : 1), sigma: sig }))); addNoise(frame, rng, 6, 1);
    const tk = trackStars(frame, W, H, pos, next, { half: 7 }); lost += tk.lost; [pos, next] = [next, pos];
    for (let s = 0; s < base.length; s++) worstTrack = Math.max(worstTrack, Math.hypot(pos[2 * s] - base[s].x - dx, pos[2 * s + 1] - base[s].y - dy));
    M.time[f] = t; M.airmass[f] = am;
    measureFrame(M, f, frame, W, H, pos, { psf: 'gaussian' });
  }
  check('stars are followed through drift and a 4.7 px jump', worstTrack < 0.15 && lost === 0, `largest centroid error ${worstTrack.toFixed(3)} px over ${nF} frames x ${base.length} stars; tolerance 0.15 px`);
  const res = optimise(M), best = res.tried[res.best], lc = res.lc;
  const nCand = (7 * 3 + 1) * (1 + 3 + 1);
  check('every aperture, annulus and comparison choice is tried and reported', res.tried.length === nCand && res.tried.every((r) => Number.isFinite(r.scatter)), `${res.tried.length} candidates`);
  check('the optimiser prefers a comparison star to none', best.comp >= 0, `best: ${best.method}, aperture ${best.aperture.toFixed(2)} px, annulus ${best.annulus.toFixed(2)} px, comparison ${best.comp === 0 ? 'all' : best.comp}, scatter ${(100 * best.scatter).toFixed(3)}%`);
  const none = res.tried.filter((r) => r.comp < 0).reduce((a, b) => (b.scatter < a.scatter ? b : a));
  // photon + sky noise expected for the best aperture with the ensemble: about 0.3% per point here
  check('residual scatter is at the photon-noise level', best.scatter < 0.0045 && best.scatter > 0.0015, `${(100 * best.scatter).toFixed(3)}% (best without a comparison star ${(100 * none.scatter).toFixed(3)}%)`);
  check('injected transit recovered by the quick fit', lc.fit.hasTransit && Math.abs(lc.fit.depth - depth) < 0.002 && Math.abs(lc.fit.tmid - tmid) < 0.006, `depth ${(100 * lc.fit.depth).toFixed(3)}% (injected ${(100 * depth).toFixed(1)}%), mid-time off by ${((lc.fit.tmid - tmid) * 1440).toFixed(1)} min; tolerances 0.2%, 9 min`);
  let rms = 0; for (let f = 0; f < nF; f++) rms += (lc.norm[f] / (lc.baseline[f]) - truth[f]) ** 2; rms = Math.sqrt(rms / nF);
  check('normalised light curve follows the injected one', rms < 0.0045, `rms difference ${(100 * rms).toFixed(3)}%`);
  // quick fit must not invent a transit in flat data
  const flat = Float64Array.from({ length: 200 }, () => 1 + 0.002 * rng.normal()), tt = Float64Array.from({ length: 200 }, (_, i) => i * 0.001);
  check('no transit is reported for a flat series', !quickFit(tt, flat).hasTransit);
  // meridian flip: the same field rotated by 180 degrees and shifted
  const A = base.map((s) => ({ x: s.x, y: s.y })), B = base.map((s) => ({ x: W - 1 - s.x + 5.5, y: H - 1 - s.y - 3.25 })).reverse();
  const sh = estimateShift(A, B, W, H), sh2 = estimateShift(A, A.map((s) => ({ x: s.x + 21.5, y: s.y - 13 })), W, H);
  check('global shift and 180 degree flip between source lists', sh.flip && Math.abs(sh.dx - 5.5) < 1e-9 && Math.abs(sh.dy + 3.25) < 1e-9 && !sh2.flip && Math.abs(sh2.dx - 21.5) < 1e-9 && Math.abs(sh2.dy + 13) < 1e-9);
}

// --- Savitzky-Golay against scipy
{
  const y = Float64Array.from(ref.savgol.y); let w31 = 0, w7 = 0;
  savgol2(y, 31).forEach((v, i) => { w31 = Math.max(w31, Math.abs(v - ref.savgol.win31[i])); }); savgol2(y, 7).forEach((v, i) => { w7 = Math.max(w7, Math.abs(v - ref.savgol.win7[i])); });
  check('Savitzky-Golay smoothing matches scipy (interior and ends)', w31 < 1e-10 && w7 < 1e-10, `largest difference ${Math.max(w31, w7).toExponential(1)}; tolerance 1e-10`);
}

// --- target pixel files: simple aperture photometry as numpy does it, EXOTIC's scatter measure, the aperture choice
for (const [key, file] of [['tess', 'tess_wasp18_s02_sub_tp.fits'], ['kepler', 'kplr011446443-2009131105131_lpd-targ.fits.gz']]) {
  if (!ref[key]) { check(`${key} reference present`, false); continue; }
  const r = ref[key], tpf = readTargetPixelFile(await openFits(load(file))), pm = pipelineMask(tpf);
  const masks = { pipeline: pm, pipeline1: dilateMask(pm, tpf.nx, tpf.ny, 1), pipeline2: dilateMask(pm, tpf.nx, tpf.ny, 2) };
  let wm = true, ws = 0, we = 0, wc = 0, wb = 0, wsum = 0, wstd = 0, ngood = 0;
  for (const [name, m] of Object.entries(masks)) {
    const e = r.masks[name]; wm &&= e.mask.every((v, i) => v === m[i]);
    const lc = tpfLightCurve(tpf, m);
    e.sample_rows.forEach((row, j) => { ws = Math.max(ws, Math.abs(lc.flux[row] / e.sample_sap[j] - 1)); we = Math.max(we, Math.abs(lc.err[row] / e.sample_err[j] - 1)); wc = Math.max(wc, Math.abs(lc.x[row] - e.sample_cx[j]), Math.abs(lc.y[row] - e.sample_cy[j])); wb = Math.max(wb, Math.abs(lc.bkg[row] / e.sample_bkg[j] - 1)); });
    const good = []; for (let i = 0; i < tpf.ncad; i++) if (lc.ok[i]) good.push(i);
    if (name === 'pipeline') ngood = good.length;
    const t = Float64Array.from(good, (i) => lc.time[i]), f = Float64Array.from(good, (i) => lc.flux[i]);
    wsum = Math.max(wsum, Math.abs(f.reduce((a, b) => a + b, 0) / e.sap_sum_good - 1));
    wstd = Math.max(wstd, Math.abs(smoothScatter(t, f, 0.5, false) / e.check_std - 1));
  }
  check(`${key}: pipeline aperture and its dilations match scipy binary_dilation`, wm, `${r.masks.pipeline.npix}, ${r.masks.pipeline1.npix}, ${r.masks.pipeline2.npix} pixels`);
  check(`${key}: aperture flux, error, centroid and background per cadence match numpy`, ws < 1e-6 && we < 1e-6 && wc < 1e-5 && wb < 1e-6 && wsum < 1e-7 && ngood === r.n_good, `flux ${ws.toExponential(1)}, error ${we.toExponential(1)} relative, centroid ${wc.toExponential(1)} px, background ${wb.toExponential(1)}, sum over ${ngood} good cadences ${wsum.toExponential(1)}; tolerances 1e-6 (float32 pixels summed in a different order), 1e-5 px`);
  check(`${key}: EXOTIC's check_std (scatter about a Savitzky-Golay smooth) reproduced`, wstd < 1e-6, `largest relative difference ${wstd.toExponential(1)} over the three apertures; tolerance 1e-6`);
  const opt = optimiseTpf(tpf), b = opt.tried[opt.best];
  const byName = Object.fromEntries(opt.tried.map((t) => [t.name, t]));
  check(`${key}: aperture search reports every candidate and picks the lowest robust relative scatter`, opt.tried.length >= 6 && opt.tried.every((t) => !(t.eligible && t.scatter < b.scatter)) && b.eligible && b.scatter < 0.002, `${opt.tried.length} apertures; best "${b.name}" (${b.npix} px) ${(1e6 * b.scatter).toFixed(0)} ppm; pipeline ${(1e6 * byName.pipeline.scatter).toFixed(0)} ppm, +1 px ${(1e6 * (byName['pipeline + 1 px']?.scatter ?? NaN)).toFixed(0)} ppm, +2 px ${(1e6 * (byName['pipeline + 2 px']?.scatter ?? NaN)).toFixed(0)} ppm; ${opt.tried.filter((t) => !t.eligible).length} too small to be eligible`);
  check(`${key}: EXOTIC's number is reported for its three apertures`, ['pipeline', 'pipeline + 1 px', 'pipeline + 2 px'].every((nm, j) => Math.abs(byName[nm].exotic / r.masks[['pipeline', 'pipeline1', 'pipeline2'][j]].check_std - 1) < 0.05), `check_std ${['pipeline', 'pipeline + 1 px', 'pipeline + 2 px'].map((nm) => byName[nm].exotic.toFixed(2)).join(', ')} e-/s (EXOTIC's script would keep "${['pipeline', 'pipeline + 1 px', 'pipeline + 2 px'].reduce((a, nm) => (byName[nm].exotic < byName[a].exotic ? nm : a), 'pipeline')}"); here the series is scored per continuous stretch (gaps of more than an hour or five cadences split it), hence a 5% tolerance against the whole-series value; the whole-series value itself is reproduced to 1e-13 above`);
  if (key === 'tess') {
    // WASP-18 b: depth about 1%, duration about 2.2 h; the quick fit should see it in the cut-out orbit
    const g = opt.lc.good, t = Float64Array.from(g, (i) => opt.lc.time[i]), f = Float64Array.from(g, (i) => opt.lc.flux[i]);
    const q = quickFit(t, f, { order: 2 });
    check('tess: the transit of WASP-18 b is found where the ephemeris puts it', q.hasTransit && Math.abs(q.tmid - 2457000 - ref.tess_transit_btjd) < 0.01 && q.depth > 0.007 && q.depth < 0.013, `mid-time ${(q.tmid - 2457000).toFixed(4)} BTJD (ephemeris ${ref.tess_transit_btjd.toFixed(4)}), depth ${(100 * q.depth).toFixed(2)}% (published (Rp/Rs)^2 = 0.95%); tolerances 15 min, 0.7-1.3%`);
  }
}
{ const s = frameStats(data, w, h); check('frame statistics', Math.abs(s.median - P.dao.median) < 1.5); }
// =========================================================================================================
// Added 2026-11-15: partial pixels, optimal extraction and PSF photometry in the search, field rotation,
// meridian flips, jumps, and K2 roll systematics
{
  // partial pixels: the pixel fractions of a circle sum to its area for any centre and radius (the comparison with
  // photutils 'exact' is above), and a flat image gives sum = level x area whatever the sub-pixel position
  let wa = 0, wf = 0; const flat = new Float32Array(41 * 41).fill(7);
  for (const r of [0.2, 0.5, 0.9, 1.53, 2.5, 4.44, 9.75]) for (const [dx, dy] of [[0, 0], [0.5, 0.5], [0.123, -0.377], [-0.49, 0.01]]) {
    let a = 0; for (let y = -12; y <= 12; y++) for (let x = -12; x <= 12; x++) a += circleRectOverlap(x - dx - 0.5, y - dy - 0.5, x - dx + 0.5, y - dy + 0.5, r);
    wa = Math.max(wa, Math.abs(a / (Math.PI * r * r) - 1));
    const s = apertureSum(flat, 41, 41, 20 + dx, 20 + dy, r); wf = Math.max(wf, Math.abs(s[0] / (7 * Math.PI * r * r) - 1));
  }
  check('partial pixels: circle-pixel overlaps add up to pi r^2 at any sub-pixel position', wa < 1e-13 && wf < 1e-6, `area ${wa.toExponential(1)}, flat-image sum ${wf.toExponential(1)} (float32 image) over 7 radii from 0.2 to 9.75 px x 4 centres`);
}
{
  // optimal extraction (Naylor 1998) on faint, sky-limited stars: unbiased, and less noisy than the best aperture
  const rng = makeRng(11), W = 41, sig = 1.6, truth = 3000, sky = 800, nT = 400, radii = [1.5, 2, 2.5, 3, 3.5, 4, 5, 6], opt = [], ap = radii.map(() => []);
  for (let t = 0; t < nT; t++) {
    const img = new Float32Array(W * W).fill(sky), x = 20 + rng.next() - 0.5, y = 20 + rng.next() - 0.5;
    addStars(img, W, W, [{ x, y, flux: truth, sigma: sig }]); addNoise(img, rng, 5, 1);
    opt.push(optimalFlux(img, W, W, x, y, sig, sig, 0, sky, 4 * 2.3548 * sig / 2, 5));
    radii.forEach((r, k) => { const s = apertureSum(img, W, W, x, y, r); ap[k].push(s[0] - s[1] * sky); });
  }
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length, sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((u) => (u - m) ** 2))); };
  const apSn = ap.map((v) => mean(v) / sd(v)), bestK = apSn.indexOf(Math.max(...apSn)), optSn = mean(opt) / sd(opt);
  // expected for a Gaussian in the sky limit: S/N_opt = F / (sigma_sky sqrt(4 pi sigma^2)); best aperture (r = 1.585 sigma) is 0.9 of it... with star noise both lower
  check('optimal extraction: unbiased on a pixel-integrated Gaussian', Math.abs(mean(opt) / truth - 1) < 0.01, `mean ${(mean(opt) / truth).toFixed(4)} of the true flux over ${nT} frames (standard error ${(sd(opt) / truth / Math.sqrt(nT)).toFixed(4)}); tolerance 1%`);
  check('optimal extraction: higher signal-to-noise than the best circular aperture', optSn > 1.03 * apSn[bestK], `S/N ${optSn.toFixed(1)} against ${apSn[bestK].toFixed(1)} for the best aperture (r = ${radii[bestK]} px = ${(radii[bestK] / sig).toFixed(2)} sigma): a gain of ${(100 * (optSn / apSn[bestK] - 1)).toFixed(1)}% (about 10% is the limit for a star much fainter than the sky under it; this one is not)`);
}
{
  // PSF and optimal photometry compete in the same table as the apertures: a faint target on a bright sky, where they should win
  const rng = makeRng(5), W = 96, H = 80, nF = 90, stars = [{ x: 40.3, y: 38.6, flux: 4000 }, { x: 70.1, y: 22.4, flux: 60000 }, { x: 20.7, y: 60.2, flux: 45000 }];
  const M = makeMeasurements(nF, 3, linspace(1.5, 6, 8).map((v) => v * 1.7), linspace(6, 12, 3).map((v) => v * 1.7), 2), img = new Float32Array(W * H), pos = new Float64Array(6);
  for (let f = 0; f < nF; f++) {
    const sig = 1.7 + 0.1 * Math.sin(f / 7), dx = 0.4 * Math.sin(f / 5), dy = 0.3 * Math.cos(f / 9), tr = 1 + 0.01 * rng.normal();
    img.fill(900); addStars(img, W, H, stars.map((s) => ({ x: s.x + dx, y: s.y + dy, flux: s.flux * tr, sigma: sig }))); addNoise(img, rng, 6, 1);
    stars.forEach((s, k) => { const c = centroidIter(img, W, H, s.x + dx, s.y + dy, 7); pos[2 * k] = c[0]; pos[2 * k + 1] = c[1]; });
    M.time[f] = 2460000.5 + f * 0.002; M.airmass[f] = 1.2;
    measureFrame(M, f, img, W, H, pos, { psf: 'both', rotate: true, optimal: true, psfHalf: 7, sigma0: 1.7 });
  }
  const o = optimise(M, { fit: { transit: false } }), b = o.tried[o.best], bestOf = (m) => Math.min(...o.tried.filter((r) => r.method === m).map((r) => r.scatter));
  check('search: PSF fit, Moffat fit, optimal extraction and apertures are all in one table', ['psf', 'moffat', 'optimal', 'aperture'].every((m) => o.tried.some((r) => r.method === m)), `${o.tried.length} candidates; best of each: optimal ${(100 * bestOf('optimal')).toFixed(3)}%, Gaussian fit ${(100 * bestOf('psf')).toFixed(3)}%, Moffat fit ${(100 * bestOf('moffat')).toFixed(3)}%, aperture ${(100 * bestOf('aperture')).toFixed(3)}%`);
  check('search: on a faint target over a bright sky a profile-weighted method wins', b.method === 'optimal' || b.method === 'psf', `winner: ${b.method}, ${(100 * b.scatter).toFixed(3)}% (target 4000 counts on a sky of 900 per pixel)`);
}
{
  // similarity transform between star lists: any rotation, a flip, missing and spurious stars
  const rng = makeRng(3), ref = Array.from({ length: 30 }, () => ({ x: 20 + 600 * rng.next(), y: 20 + 440 * rng.next() }));
  let worst = 0, n = 0, fail = 0; const o = [0, 0];
  for (const deg of [0, 0.6, 7, 33, 90, 137, 180, 181.5, 270, -45]) {
    const th = deg * Math.PI / 180, T = { a: Math.cos(th), b: Math.sin(th), tx: 300 - 40 * rng.next(), ty: 200 + 30 * rng.next(), mirror: false };
    const cur = []; ref.forEach((p, i) => { if (i % 4 === 3) return; applySimilarity(T, p.x - 320, p.y - 240, o); cur.push({ x: o[0] + 0.15 * rng.normal(), y: o[1] + 0.15 * rng.normal() }); });
    for (let k = 0; k < 6; k++) cur.splice(Math.floor(rng.next() * cur.length), 0, { x: 640 * rng.next(), y: 480 * rng.next() });
    const m = matchAsterism(ref.map((p) => ({ x: p.x - 320, y: p.y - 240 })), cur, { nmax: 16 });
    if (!m) { fail++; continue; }
    let d = ((m.rotation - th) * 180 / Math.PI) % 360; if (d > 180) d -= 360; if (d < -180) d += 360;
    worst = Math.max(worst, Math.abs(d)); n = Math.max(n, 0) + 1; if (m.nMatch < 15) fail++;
  }
  check('asterism matching: rotation by any angle recovered with a quarter of the stars missing and 6 false ones', fail === 0 && worst < 0.1, `${n} of 10 angles from 0 to 270 degrees matched; rotation within ${worst.toFixed(3)} degrees (0.15 px position noise); tolerance 0.1 degrees`);
  const mir = ref.map((p) => ({ x: 640 - p.x + 12, y: p.y - 7 })), m2 = matchAsterism(ref, mir, { mirror: true }), m3 = matchAsterism(ref, mir, { mirror: false });
  check('asterism matching: a mirrored field is matched only when mirrors are allowed', m2 && m2.mirror && m2.nMatch === 30 && !m3, m2 ? `mirror found, ${m2.nMatch} stars, rms ${m2.rms.toExponential(1)} px` : 'no match');
  const pairs = ref.map((p) => { applySimilarity({ a: 0.6, b: 0.8, tx: 5, ty: -3, mirror: false }, p.x, p.y, o); return [p.x, p.y, o[0], o[1]]; }), fs = fitSimilarity(pairs);
  check('least-squares similarity transform recovers an exact one', Math.abs(fs.a - 0.6) < 1e-12 && Math.abs(fs.b - 0.8) < 1e-12 && Math.abs(fs.tx - 5) < 1e-9 && fs.rms < 1e-9, `rms ${fs.rms.toExponential(1)} px`);
}
{
  // whole sequences through the pipeline: alt-az field rotation, a meridian flip with a pause, guiding jumps and dithers
  const { runStack } = await import('../src/photometry/pipeline.js'), { encodeFitsImage } = await import('../src/core/fits.js');
  const W = 360, H = 280, nF = 60, sig = 1.9;
  const make = (kind) => {
    const rng = makeRng(21), field = [{ x: 0, y: 0, flux: 150000 }, { x: 42, y: -31, flux: 190000 }, { x: -55, y: 24, flux: 120000 }, { x: 18, y: 60, flux: 90000 }];
    for (let i = 0; i < 45; i++) field.push({ x: -170 + 340 * rng.next(), y: -130 + 260 * rng.next(), flux: 3000 * Math.exp(3 * rng.next()) });
    const files = [], truth = [], img = new Float32Array(W * H);
    for (let f = 0; f < nF; f++) {
      let th = 0, cx = W / 2 + 4, cy = H / 2 - 3, jd = 2460400.6 + f * 0.0015;
      if (kind === 'rotation') { th = (55 * f / (nF - 1)) * Math.PI / 180; cx += 12 * f / nF; cy -= 8 * f / nF; }
      if (kind === 'flip') { cx += 0.15 * f; cy -= 0.1 * f; if (f >= 30) { th = Math.PI + 0.004 * (f - 30); cx -= 14; cy += 9; jd += 0.012; } }
      if (kind === 'jumps') { cx += Math.round(22 * (rng.next() - 0.5)); cy += Math.round(22 * (rng.next() - 0.5)); if (f >= 40) { cx += 58; cy -= 37; } th = 0.002 * f; }
      const c = Math.cos(th), s = Math.sin(th), dip = 1 - 0.012 * trapezoid(jd, 2460400.6 + 0.05, 0.03), tr = 1 + 0.01 * rng.normal();
      const stars = field.map((p, k) => ({ x: cx + c * p.x - s * p.y, y: cy + s * p.x + c * p.y, flux: p.flux * tr * (k === 0 ? dip : 1), sigma: sig }));
      img.fill(400); addStars(img, W, H, stars); addNoise(img, rng, 6, 1);
      truth.push(stars.slice(0, 4).map((p) => [p.x, p.y]));
      const d = new Date((jd - 2440587.5) * 86400000).toISOString().replace('Z', '');
      files.push({ name: `${kind}_${f}.fits`, buffer: encodeFitsImage(img, W, H, { 'DATE-OBS': [d, 'UTC at start of exposure'], EXPTIME: 20, AIRMASS: 1.1 + 0.002 * f, ...(kind === 'flip' ? { PIERSIDE: f >= 30 ? 'WEST' : 'EAST' } : {}) }).buffer });
    }
    return { files, truth };
  };
  for (const [kind, what] of [['rotation', 'field rotation of 55 degrees with drift (alt-az mount)'], ['flip', 'meridian flip: 180 degrees, a shift and a pause half-way'], ['jumps', 'dithers of up to 11 px every frame and one jump of 69 px']]) {
    const { files, truth } = make(kind), res = await runStack(files, { stars: truth[0].map(([x, y]) => ({ x: x + 0.7, y: y - 0.5 })), psf: 'gaussian', nAper: 6, nAnn: 2 }), M = res.M;
    let worst = 0; for (let f = 0; f < M.count; f++) for (let s = 0; s < 4; s++) worst = Math.max(worst, Math.hypot(M.x[f * 4 + s] - truth[f][s][0], M.y[f * 4 + s] - truth[f][s][1]));
    const b = res.opt.tried[res.opt.best], rotEnd = M.rot[M.count - 1];
    check(`tracking: ${what}`, M.count === nF && worst < 0.15 && b.scatter < 0.004 && res.opt.lc.fit.hasTransit, `all 4 stars within ${worst.toFixed(3)} px of the truth in all ${nF} frames (tolerance 0.15 px); field re-found by asterism ${res.relocated} times; orientation of the last frame ${rotEnd.toFixed(2)} degrees; light curve scatter ${(100 * b.scatter).toFixed(3)}%, transit of 1.2% recovered at ${(100 * res.opt.lc.fit.depth).toFixed(2)}%`);
  }
}
{
  // K2 roll systematics: self-flat-fielding against the arclength along the roll
  const { syntheticRollSeries } = await import('../src/core/psd.js'), S = syntheticRollSeries({ n: 2880, sigma: 2e-4 }), flux = Float64Array.from(S.flux);
  // a transit every 9.3 days, 0.2% deep, 3 h long, must survive
  const inT = (t) => Math.abs(((t - 4.1) / 9.3) - Math.round((t - 4.1) / 9.3)) * 9.3 < 0.0625; for (let i = 0; i < flux.length; i++) if (inT(S.t[i])) flux[i] *= 0.998;
  const r = sffDetrend(S.t, flux, S.x, S.y), oot = [], it = []; for (let i = 0; i < flux.length; i++) (inT(S.t[i]) ? it : oot).push(r.corrected[i] / r.trend[i]);
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length, depth = mean(oot) - mean(it);
  check('K2: self-flat-fielding removes the roll systematics', r.rmsAfter < 1.25 * S.sigma && r.rmsBefore > 5 * S.sigma, `robust scatter ${(1e6 * r.rmsBefore).toFixed(0)} -> ${(1e6 * r.rmsAfter).toFixed(0)} ppm; injected white noise ${(1e6 * S.sigma).toFixed(0)} ppm; ${r.windows} windows of about 6 days, 15 bins of arclength each; tolerance 1.25 x the white level`);
  check('K2: a transit survives the correction', Math.abs(depth / 0.002 - 1) < 0.15, `injected 0.200%, recovered ${(100 * depth).toFixed(3)}% from ${it.length} in-transit points; tolerance 15%`);
}
process.exit(ok ? 0 : 1);
