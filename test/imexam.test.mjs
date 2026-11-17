// Image examination (src/core/imexam.js): radial profiles, curves of growth and Gaussian FWHM against photutils
// on a real frame (reference: test/make_imexam_reference.py), Moffat fits against scipy, region statistics
// against astropy, and recovery of known widths, shapes and focus patterns from synthetic frames made here.
import { readFileSync } from 'node:fs';
import { openFits, readImage } from '../src/core/fits.js';
import { fitPsf, centroidIter } from '../src/core/photometry.js';
import { radialProfile, lineProfile, regionStats, pixelTable, psfShape, psfMoments, focusMap, rankComparisons, saturationLevel, bilinear, lmFit } from '../src/core/imexam.js';
import { makeRng } from '../src/core/stats.js';
import { splitFits } from '../src/photometry/pipeline.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./imexam_reference.json', import.meta.url)));
const pct = (a, b) => 100 * Math.abs(a / b - 1);

// erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7) for pixel-integrated Gaussians
const erf = (x) => { const s = Math.sign(x), t = 1 / (1 + 0.3275911 * Math.abs(x)); return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const Phi = (u) => 0.5 * (1 + erf(u / Math.SQRT2));

/** add a star: 'gauss' integrated exactly over each pixel; others averaged over os x os points. Rotation th (deg) of the sx axis from +x. */
function addStar(img, w, h, s) {
  const { x0, y0, flux, kind = 'gauss', sx = 2, sy = sx, th = 0, gamma = 3, beta = 2.5, os = 7 } = s, R = Math.ceil(8 * Math.max(sx, sy, gamma));
  const c = Math.cos(th * Math.PI / 180), sn = Math.sin(th * Math.PI / 180);
  for (let y = Math.max(0, Math.floor(y0 - R)); y <= Math.min(h - 1, Math.ceil(y0 + R)); y++) for (let x = Math.max(0, Math.floor(x0 - R)); x <= Math.min(w - 1, Math.ceil(x0 + R)); x++) {
    let v = 0;
    if (kind === 'gauss' && !th && sx === sy) v = flux * (Phi((x + 0.5 - x0) / sx) - Phi((x - 0.5 - x0) / sx)) * (Phi((y + 0.5 - y0) / sy) - Phi((y - 0.5 - y0) / sy));
    else {
      for (let j = 0; j < os; j++) for (let i = 0; i < os; i++) {
        const dx = x - 0.5 + (i + 0.5) / os - x0, dy = y - 0.5 + (j + 0.5) / os - y0, u = dx * c + dy * sn, q = -dx * sn + dy * c;
        v += kind === 'gauss' ? Math.exp(-0.5 * (u * u / (sx * sx) + q * q / (sy * sy))) / (2 * Math.PI * sx * sy) : (beta - 1) / (Math.PI * gamma * gamma) * Math.pow(1 + (u * u + q * q) / (gamma * gamma), -beta);
      }
      v *= flux / (os * os);
    }
    img[y * w + x] += v;
  }
}

// --- radial profile machinery against photutils on the real frame (same centre and sky)
{
  const raw = readFileSync(new URL('./data/hatp32_exotic_sample.fits', import.meta.url));
  const parts = await splitFits(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'hatp32');
  const im = readImage(await openFits(parts[0].buffer)), { data, width: w, height: h } = im;
  let wp = 0, wg = 0, wf = 0, wm = 0, w50 = 0, wc = 0;
  for (const s of ref.stars) {
    const r = radialProfile(data, w, h, s.x, s.y, { rmax: ref.rmax, bin: ref.bin, growthStep: ref.bin, recentre: false, background: s.background });
    const pk = Math.max(...s.profile);
    for (let i = 0; i < s.profile.length; i++) wp = Math.max(wp, Math.abs(r.profile.v[i] - s.profile[i]) / pk);
    for (let i = 0; i < s.growth.length; i++) { const k = r.growth.r.findIndex((q) => Math.abs(q - s.growthR[i]) < 1e-9); wg = Math.max(wg, k < 0 ? 1 : Math.abs(r.growth.flux[k] - s.growth[i]) / s.growth[s.growth.length - 1]); }
    wf = Math.max(wf, pct(r.binned.gaussian.fwhm, s.gaussianFwhm)); wm = Math.max(wm, pct(r.binned.moffat.fwhm, s.moffat.fwhm)); w50 = Math.max(w50, Math.abs(r.r50 - s.r50));
    const c = centroidIter(data, w, h, s.x, s.y, 6); wc = Math.max(wc, Math.hypot(c[0] - s.x, c[1] - s.y));
  }
  const n = ref.stars.length;
  check('binned radial profile = photutils RadialProfile (exact overlaps)', wp < 1e-9, `${n} stars of the HAT-P-32 frame; largest difference ${wp.toExponential(1)} of the peak; tolerance 1e-9`);
  check('curve of growth = photutils CurveOfGrowth', wg < 1e-9, `largest difference ${wg.toExponential(1)} of the total; tolerance 1e-9`);
  check('Gaussian FWHM of the binned profile = photutils gaussian_fwhm', wf < 0.5, `FWHM ${ref.stars.map((s) => s.gaussianFwhm.toFixed(3)).join(', ')} px; largest difference ${wf.toFixed(3)}%; tolerance 0.5%`);
  check('Moffat FWHM of the binned profile = scipy curve_fit', wm < 1, `largest difference ${wm.toFixed(3)}%; tolerance 1%`);
  check('half-flux radius from the curve of growth', w50 < 1e-6, `largest difference ${w50.toExponential(1)} px (both interpolating 1 px steps); tolerance 1e-6 px`);
  check('centroid used for recentring agrees with photutils centroid_2dg', wc < 0.25, `largest offset ${wc.toFixed(3)} px ; tolerance 0.25 px`);

  // the focus map on this real frame: every measured star above the S/N limit and far from saturation, every skipped one with a reason
  {
    const lvl = saturationLevel(im.header || {}).level, fm = focusMap(data, w, h, { saturation: lvl }), S = fm.summary, tot = S.n + Object.values(S.rejected).reduce((a, b) => a + b, 0);
    check('focus map on the HAT-P-32 frame: measured stars bright and unsaturated, skipped ones counted by reason', S.n >= 5 && fm.stars.every((s) => s.snr >= 30 && !(s.peak >= 0.9 * lvl)) && fm.rejected.every((r) => ['saturated', 'crowded', 'edge', 'faint', 'fit'].includes(r.reason)),
      `${S.n} of ${tot} detected stars measured (S/N >= 30), skipped ${JSON.stringify(S.rejected)}; median FWHM ${S.fwhm.toFixed(2)} px, elongation ${(100 * S.ellipticity).toFixed(1)}%, ${(100 * S.coherence).toFixed(0)}% in one direction; coma ${S.coma.toFixed(3)}, asymmetry ${S.asymmetry.toFixed(3)}; tilt ${(100 * S.plane.fraction).toFixed(0)}% (${S.plane.sigma.toFixed(1)} sigma)`);
  }

  // region statistics against astropy
  const R = ref.region, st = regionStats(data, w, h, { shape: 'box', x0: R.x0, y0: R.y0, x1: R.x1, y1: R.y1 });
  const worst = Math.max(...['mean', 'median', 'std', 'min', 'max', 'sum'].map((k) => Math.abs(st[k] - R[k]) / Math.max(1, Math.abs(R[k]))), ...['mean', 'median', 'std'].map((k) => Math.abs(st.clipped[k] - R.clipped[k]) / Math.max(1, Math.abs(R.clipped[k]))));
  check('region statistics = numpy and astropy sigma_clipped_stats', st.n === R.n && worst < 1e-9, `${st.n} px, mean ${st.mean.toFixed(2)}, clipped std ${st.clipped.std.toFixed(3)}; largest relative difference ${worst.toExponential(1)}`);
}

// --- known widths on synthetic stars
{
  const w = 101, h = 101, sig = 2.2, img = new Float64Array(w * h).fill(500);
  addStar(img, w, h, { x0: 50.37, y0: 47.81, flux: 2e5, sx: sig });
  const r = radialProfile(img, w, h, 49, 48, { rmax: 15 });
  const fw = 2.354820045 * Math.sqrt(sig * sig + 1 / 12);       // a Gaussian integrated over square pixels is close to sigma^2 + 1/12
  check('recentred on a synthetic Gaussian star', Math.hypot(r.x - 50.37, r.y - 47.81) < 0.01, `offset ${Math.hypot(r.x - 50.37, r.y - 47.81).toFixed(4)} px from a start 1.4 px away`);
  check('Gaussian FWHM of a pixel-integrated Gaussian', pct(r.gaussian.fwhm, fw) < 1, `${r.gaussian.fwhm.toFixed(4)} px against 2.3548 sqrt(sigma^2 + 1/12) = ${fw.toFixed(4)}; ${pct(r.gaussian.fwhm, fw).toFixed(2)}%; tolerance 1%`);
  check('half-flux diameter of a Gaussian equals its FWHM', pct(r.hfd, fw) < 1, `HFD ${r.hfd.toFixed(4)} px; ${pct(r.hfd, fw).toFixed(2)}%; tolerance 1%`);
  check('flux inside 15 px', pct(r.flux, 2e5) < 0.05, `${r.flux.toFixed(1)} against 200000`);
  const ee80 = sig * Math.sqrt(-2 * Math.log(0.2)), r80 = Math.sqrt(sig * sig + 1 / 12) * Math.sqrt(-2 * Math.log(0.2));
  check('80% encircled-energy radius', Math.abs(r.r80 - r80) < 0.05, `${r.r80.toFixed(3)} px against ${r80.toFixed(3)} (${ee80.toFixed(3)} for the unpixelated star)`);

  // a Moffat star, wide enough that the pixels hardly change its shape (they add about 2.3548^2 / 12 px^2 to FWHM^2)
  const m = new Float64Array(w * h).fill(200); addStar(m, w, h, { x0: 50.6, y0: 50.2, flux: 3e5, kind: 'moffat', gamma: 5, beta: 2.7 });
  const rm = radialProfile(m, w, h, 50, 50, { rmax: 30 }), mf0 = 2 * 5 * Math.sqrt(Math.pow(2, 1 / 2.7) - 1), mf = Math.sqrt(mf0 * mf0 + 2.3548 ** 2 / 12);
  check('Moffat FWHM of a Moffat star', pct(rm.moffat.fwhm, mf) < 1 && Math.abs(rm.moffat.beta - 2.7) < 0.15, `FWHM ${rm.moffat.fwhm.toFixed(3)} against ${mf.toFixed(3)} px (${mf0.toFixed(3)} before pixelation), ${pct(rm.moffat.fwhm, mf).toFixed(2)}%; beta ${rm.moffat.beta.toFixed(2)} against 2.7`);
  check('a Gaussian fitted to a Moffat star is narrower than its half-flux diameter (wings)', rm.gaussian.fwhm < rm.hfd, `Gaussian ${rm.gaussian.fwhm.toFixed(2)}, HFD ${rm.hfd.toFixed(2)} px`);
}

// --- shapes of elongated stars from the rotated Gaussian fit
{
  let worstA = 0, worstE = 0;
  for (const th of [0, 30, 75, 120, 160]) {
    const w = 41, h = 41, img = new Float64Array(w * h).fill(100);
    addStar(img, w, h, { x0: 20.3, y0: 19.6, flux: 1e5, sx: 3.0, sy: 1.8, th, os: 5 });
    const f = fitPsf(img, w, h, 20, 20, 12, { model: 'gaussian', rotate: true, sigma: 2 }), s = psfShape(f);
    let d = Math.abs(s.angle - th) % 180; d = Math.min(d, 180 - d);
    worstA = Math.max(worstA, d); worstE = Math.max(worstE, Math.abs(s.ellipticity - 0.4));
  }
  check('major-axis direction of elongated stars', worstA < 1, `five angles 0 to 160 deg; largest error ${worstA.toFixed(3)} deg; tolerance 1 deg`);
  check('ellipticity 1 - b/a', worstE < 0.01, `true 0.4; largest error ${worstE.toFixed(4)}; tolerance 0.01`);
}

// --- focus across the field: curvature, tilt and trailing on synthetic fields
function field(widthFn, opts = {}) {
  const w = 480, h = 360, rng = makeRng(opts.seed ?? 7).next, img = new Float64Array(w * h).fill(1000), truth = [];
  for (let k = 0; k < 170; k++) {
    const x0 = 15 + rng() * (w - 30), y0 = 15 + rng() * (h - 30);
    if (truth.some((t) => Math.hypot(t.x - x0, t.y - y0) < 26)) continue;
    const { sx, sy = sx, th = 0 } = widthFn(x0, y0, w, h), flux = 2e4 * Math.exp(2 * rng());
    addStar(img, w, h, { x0, y0, flux, sx, sy, th, os: 3 });
    truth.push({ x: x0, y: y0, fwhm: 2.3548 * Math.sqrt(Math.sqrt((sx * sx + 1 / 12) * (sy * sy + 1 / 12))) });
  }
  for (let i = 0; i < img.length; i++) img[i] += Math.sqrt(img[i]) * (rng() + rng() + rng() + rng() - 2) * Math.sqrt(3);
  return { img, w, h, truth };
}
const cellTruth = (F, c) => { const v = F.truth.filter((t) => t.x >= c.x0 && t.x < c.x1 && t.y >= c.y0 && t.y < c.y1).map((t) => t.fwhm).sort((a, b) => a - b); return v.length ? (v.length & 1 ? v[v.length >> 1] : 0.5 * (v[v.length / 2 - 1] + v[v.length / 2])) : NaN; };
{
  const F = field((x, y, w, h) => { const r2 = ((x - w / 2) ** 2 + (y - h / 2) ** 2) / ((w / 2) ** 2 + (h / 2) ** 2); return { sx: 1.6 * (1 + 0.7 * r2) }; });
  const fm = focusMap(F.img, F.w, F.h), errs = fm.cells.filter((c) => c.n >= 3).map((c) => pct(c.fwhm, cellTruth(F, c)));
  check('focus map: cell median FWHM on a curved field', Math.max(...errs) < 3, `${fm.summary.n} of ${F.truth.length} stars measured; ${errs.length} cells; largest error ${Math.max(...errs).toFixed(2)}%; tolerance 3%`);
  const corner = [0, 2, 6, 8].map((i) => cellTruth(F, fm.cells[i])), tc = corner.reduce((a, b) => a + b, 0) / 4 / cellTruth(F, fm.cells[4]) - 1;
  check('focus map: field curvature reported', Math.abs(fm.summary.curvature - tc) < 0.03 && fm.summary.verdict.some((v) => /curvature/.test(v)) && fm.summary.best && Math.hypot(fm.summary.best.x - F.w / 2, fm.summary.best.y - F.h / 2) < 40,
    `corners ${(100 * fm.summary.curvature).toFixed(1)}% softer than the centre against ${(100 * tc).toFixed(1)}% from the true widths; best focus at (${fm.summary.best ? fm.summary.best.x.toFixed(0) + ', ' + fm.summary.best.y.toFixed(0) : '-'}) against (240, 180)`);
}
{
  const F = field((x, y, w) => ({ sx: 1.5 * (1 + 0.6 * x / w) }), { seed: 11 }), fm = focusMap(F.img, F.w, F.h);
  check('focus map: tilt across the field', fm.summary.tilt > 0.3 && /right/.test(fm.summary.worstCorner) && fm.summary.verdict.some((v) => /tilted/.test(v)), `corners differ by ${(100 * fm.summary.tilt).toFixed(0)}% of the centre; worst ${fm.summary.worstCorner}`);
}
{
  const F = field(() => ({ sx: 2.6, sy: 1.6, th: 60 }), { seed: 3 }), fm = focusMap(F.img, F.w, F.h);
  check('focus map: trailed stars all point the same way', fm.summary.coherence > 0.8 && Math.abs(fm.summary.angle - 60) < 3 && fm.summary.verdict.some((v) => /tracking/.test(v)), `coherence ${fm.summary.coherence.toFixed(2)}, direction ${fm.summary.angle.toFixed(1)} deg against 60, median ellipticity ${fm.summary.ellipticity.toFixed(2)}`);
  const G = field(() => ({ sx: 1.9 }), { seed: 5 }), gm = focusMap(G.img, G.w, G.h);
  check('focus map: an even field is called even', gm.summary.verdict.length === 1 && /even/.test(gm.summary.verdict[0]), `curvature ${(100 * gm.summary.curvature).toFixed(1)}%, tilt ${(100 * gm.summary.tilt).toFixed(1)}%, ellipticity ${gm.summary.ellipticity.toFixed(3)}`);
}
// --- tip/tilt plane, the signal-to-noise cutoff, saturation without a header level, and the coma pattern
{
  // FWHM growing linearly to the right: the plane must give the change across the frame and point to +x
  const F = field((x, y, w) => ({ sx: 1.5 * (1 + 0.6 * x / w) }), { seed: 11 }), fm = focusMap(F.img, F.w, F.h), P = fm.summary.plane;
  const fw = (x) => 2.3548 * Math.sqrt((1.5 * (1 + 0.6 * x / F.w)) ** 2 + 1 / 12), frac = (fw(F.w - 1) - fw(0)) / fw((F.w - 1) / 2);
  const dA = Math.min(P.angle, 360 - P.angle);
  check('focus map: tip/tilt plane across the field', Math.abs(P.fraction - frac) < 0.05 && dA < 5 && P.sigma > 10 && fm.summary.verdict.some((v) => /tip\/tilt/.test(v)),
    `FWHM rises ${(100 * P.fraction).toFixed(1)}% across the frame toward ${P.angle.toFixed(1)} deg (${P.sigma.toFixed(0)} sigma) against ${(100 * frac).toFixed(1)}% toward 0 deg`);
  // faint stars are left out, and reported as faint
  const G = field(() => ({ sx: 1.9 }), { seed: 5 }), all = focusMap(G.img, G.w, G.h, { minSnr: 0 }), strict = focusMap(G.img, G.w, G.h, { minSnr: 150 });
  check('focus map: stars under the S/N limit are not measured, and are listed as faint', strict.summary.n < all.summary.n && strict.summary.n > 0 && strict.stars.every((s) => s.snr >= 150) && strict.summary.rejected.faint === all.summary.n - strict.summary.n,
    `S/N >= 150: ${strict.summary.n} of ${all.summary.n} measured, ${strict.summary.rejected.faint} faint`);
  // a clipped star in a floating-point frame (no SATURATE): a flat top at the frame's maximum
  const S = field(() => ({ sx: 1.8 }), { seed: 9 }), cx = 240, cy = 180;
  for (let i = 0; i < S.img.length; i++) { const x = i % S.w, y = Math.floor(i / S.w); if (Math.hypot(x - cx, y - cy) < 12) S.img[i] = 1000; }
  addStar(S.img, S.w, S.h, { x0: cx, y0: cy, flux: 3e6, sx: 2, sy: 2, th: 0, os: 3 });
  let top = 0; for (const v of S.img) top = Math.max(top, v); for (let i = 0; i < S.img.length; i++) S.img[i] = Math.min(S.img[i], 0.7 * top);
  const sm = focusMap(S.img, S.w, S.h);
  check('focus map: a clipped star without a header level is rejected as saturated', sm.rejected.some((r) => r.reason === 'saturated' && Math.hypot(r.x - cx, r.y - cy) < 2) && !sm.stars.some((s) => Math.hypot(s.x - cx, s.y - cy) < 2), `rejected: ${JSON.stringify(sm.summary.rejected)}`);
  // every star with a faint tail toward 210 degrees: a field-wide coma
  const C = field(() => ({ sx: 1.7 }), { seed: 4 }), th = 210 * Math.PI / 180;
  for (let i = 0; i < C.img.length; i++) C.img[i] = 1000;
  const rng = makeRng(21).next;
  for (const t of C.truth) { addStar(C.img, C.w, C.h, { x0: t.x, y0: t.y, flux: 6e4, sx: 1.7, sy: 1.7, th: 0, os: 3 }); addStar(C.img, C.w, C.h, { x0: t.x + 2.6 * Math.cos(th), y0: t.y + 2.6 * Math.sin(th), flux: 2e4, sx: 2.4, sy: 2.4, th: 0, os: 3 }); }
  for (let i = 0; i < C.img.length; i++) C.img[i] += Math.sqrt(C.img[i]) * (rng() + rng() + rng() + rng() - 2) * Math.sqrt(3);
  const cm = focusMap(C.img, C.w, C.h), dC = Math.abs(((cm.summary.comaAngle - 210) + 540) % 360 - 180);
  const R = focusMap(G.img, G.w, G.h).summary;
  check('focus map: a coma common to every star is found, with its direction; round stars show none', cm.summary.comaCoherence > 0.9 && dC < 5 && cm.summary.verdict.some((v) => /trail/.test(v)) && R.coma < 0.1 && !R.verdict.some((v) => /trail/.test(v)),
    `tails toward 210 deg: coma ${cm.summary.coma.toFixed(2)} toward ${cm.summary.comaAngle.toFixed(1)} deg, coherence ${cm.summary.comaCoherence.toFixed(2)}, asymmetry ${cm.summary.asymmetry.toFixed(3)}; round stars: coma ${R.coma.toFixed(3)}, asymmetry ${R.asymmetry.toFixed(3)}`);
}

// --- moments of a star (psfMoments) against the analytic moments of Gaussian mixtures. A Gaussian sampled at pixel
// centres has the moments of the continuous one to far below 1e-9 for sigma >= 1.5 px (Poisson summation), and the
// circle of radius 9 sigma loses nothing measurable, so these are exact references.
{
  const w = 90, h = 90;
  const mix = (comps) => { const img = new Float64Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (const c of comps) { const dx = x - c.x, dy = y - c.y, ca = Math.cos(c.th || 0), sa = Math.sin(c.th || 0), u = dx * ca + dy * sa, q = -dx * sa + dy * ca; v += c.wt * Math.exp(-0.5 * (u * u / (c.sa * c.sa) + q * q / (c.sb * c.sb))); } img[y * w + x] = v; } return img; };
  // analytic central moments of a mixture of Gaussians (component covariance S, weights wt / (2 pi sa sb) * that norm)
  const truth = (comps) => {
    const W = comps.reduce((a, c) => a + c.wt * c.sa * c.sb, 0), cx = comps.reduce((a, c) => a + c.wt * c.sa * c.sb * c.x, 0) / W, cy = comps.reduce((a, c) => a + c.wt * c.sa * c.sb * c.y, 0) / W;
    let xx = 0, yy = 0, xy = 0, xxx = 0, xyy = 0, xxy = 0, yyy = 0;
    for (const c of comps) {
      const m = c.wt * c.sa * c.sb / W, ca = Math.cos(c.th || 0), sa = Math.sin(c.th || 0), a2 = c.sa * c.sa, b2 = c.sb * c.sb;
      const Sxx = a2 * ca * ca + b2 * sa * sa, Syy = a2 * sa * sa + b2 * ca * ca, Sxy = (a2 - b2) * ca * sa, dx = c.x - cx, dy = c.y - cy;
      xx += m * (Sxx + dx * dx); yy += m * (Syy + dy * dy); xy += m * (Sxy + dx * dy);
      xxx += m * (dx ** 3 + 3 * Sxx * dx); yyy += m * (dy ** 3 + 3 * Syy * dy);
      xyy += m * (dx * dy * dy + Syy * dx + 2 * Sxy * dy); xxy += m * (dx * dx * dy + Sxx * dy + 2 * Sxy * dx);
    }
    const s3 = Math.pow((xx + yy) / 2, 1.5);
    return { cx, cy, xx, yy, xy, coma: [(xxx + xyy) / s3, (xxy + yyy) / s3] };
  };
  const cases = [
    { name: 'round star', comps: [{ x: 44.3, y: 45.7, sa: 2.2, sb: 2.2, wt: 1 }] },
    { name: 'elongated, 35 deg', comps: [{ x: 45.1, y: 44.6, sa: 3.0, sb: 1.8, th: 35 * Math.PI / 180, wt: 1 }] },
    { name: 'core and a tail to +x (coma)', comps: [{ x: 44.2, y: 45.4, sa: 2.0, sb: 2.0, wt: 1 }, { x: 47.6, y: 45.4, sa: 2.6, sb: 2.6, wt: 0.25 }] },
    { name: 'core and a tail toward 120 deg', comps: [{ x: 45, y: 45, sa: 2.1, sb: 1.9, th: 0.3, wt: 1 }, { x: 45 - 2.2, y: 45 + 3.8, sa: 2.4, sb: 2.4, wt: 0.3 }] },
  ];
  let worst = 0; const notes = [];
  for (const k of cases) {
    const m = psfMoments(mix(k.comps), w, h, Math.round(k.comps[0].x), Math.round(k.comps[0].y), { radius: 26 }), t = truth(k.comps);
    const e = Math.max(Math.abs(m.x - t.cx), Math.abs(m.y - t.cy), Math.abs(m.ixx - t.xx), Math.abs(m.iyy - t.yy), Math.abs(m.ixy - t.xy), Math.abs(m.coma.x - t.coma[0]), Math.abs(m.coma.y - t.coma[1]));
    worst = Math.max(worst, e); notes.push(`${k.name}: coma (${m.coma.x.toFixed(4)}, ${m.coma.y.toFixed(4)})`);
  }
  check('star moments: centroid, second moments and coma vector of Gaussian mixtures', worst < 1e-7, `${cases.length} cases, largest error ${worst.toExponential(1)}; ${notes.slice(2).join('; ')}`);
  const el = psfMoments(mix(cases[1].comps), w, h, 45, 45, { radius: 26 });
  check('star moments: ellipticity 1 - b/a and major-axis direction of an elongated star', Math.abs(el.ellipticity - (1 - 1.8 / 3.0)) < 1e-7 && Math.abs(el.angle - 35) < 1e-5 && Math.abs(el.fwhm - 2.3548200450309493 * Math.sqrt((9 + 3.24) / 2)) < 1e-6,
    `ellipticity ${el.ellipticity.toFixed(8)} against 0.4, angle ${el.angle.toFixed(6)} deg against 35`);
  // with a Gaussian weight of sigma_w about the centroid, a Gaussian star of covariance S has the moments of
  // (S^-1 + I / sigma_w^2)^-1: an elongated star becomes rounder by exactly that much
  {
    const sa = 3.0, sb = 1.8, th = 35 * Math.PI / 180, swt = 2.5, A = 1 / (sa * sa) + 1 / (swt * swt), B = 1 / (sb * sb) + 1 / (swt * swt);
    const aw = 1 / Math.sqrt(A), bw = 1 / Math.sqrt(B), c = Math.cos(th), sn = Math.sin(th);
    const exx = aw * aw * c * c + bw * bw * sn * sn, eyy = aw * aw * sn * sn + bw * bw * c * c, exy = (aw * aw - bw * bw) * c * sn;
    const wm = psfMoments(mix(cases[1].comps), w, h, 45, 45, { radius: 26, weight: swt }), wr = psfMoments(mix(cases[0].comps), w, h, 44, 46, { radius: 26, weight: swt });
    const err = Math.max(Math.abs(wm.ixx - exx), Math.abs(wm.iyy - eyy), Math.abs(wm.ixy - exy), Math.abs(wm.x - 45.1), Math.abs(wm.y - 44.6));
    check('star moments with a Gaussian weight: (S^-1 + I/sigma_w^2)^-1, and no coma for a round star', err < 1e-6 && Math.abs(wm.ellipticity - (1 - bw / aw)) < 1e-6 && Math.abs(wm.angle - 35) < 1e-4 && wr.coma.size < 1e-6,
      `largest error ${err.toExponential(1)}; ellipticity ${wm.ellipticity.toFixed(6)} against ${(1 - bw / aw).toFixed(6)} (0.4 unweighted)`);
  }
  const tail = psfMoments(mix(cases[3].comps), w, h, 45, 45, { radius: 26 });
  check('star moments: the coma vector points to the tail', Math.abs(tail.coma.angle - 120) < 6 && psfMoments(mix(cases[0].comps), w, h, 44, 46, { radius: 26 }).coma.size < 1e-7, `tail at 120 deg: coma at ${tail.coma.angle.toFixed(1)} deg (the core's own elongation turns it a little)`);
  // asymmetry: zero for a point-symmetric star; for an asymmetric one, against the analytic image rotated by 180 degrees
  // about the measured centroid (no interpolation in the reference)
  const sym = psfMoments(mix(cases[1].comps), w, h, 45, 45, { radius: 26 });
  const comps = [{ x: 44.6, y: 45.3, sa: 4, sb: 4, wt: 1 }, { x: 49.1, y: 46.2, sa: 4.5, sb: 4.5, wt: 0.3 }], img = mix(comps), am = psfMoments(img, w, h, 45, 45, { radius: 26 });
  const f = (x, y) => comps.reduce((a, c) => a + c.wt * Math.exp(-0.5 * ((x - c.x) ** 2 + (y - c.y) ** 2) / (c.sa * c.sa)), 0);
  let num = 0, den = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if ((x - am.x) ** 2 + (y - am.y) ** 2 > 26 * 26) continue; const v = f(x, y); num += Math.abs(v - f(2 * am.x - x, 2 * am.y - y)); den += Math.abs(v); }
  const aRef = num / (2 * den);
  check('star moments: 180-degree asymmetry (0 when symmetric; against the analytic rotated image)', sym.asymmetry < 0.003 && Math.abs(am.asymmetry - aRef) < 0.003 && aRef > 0.03,
    `symmetric ${sym.asymmetry.toFixed(5)}; with a companion ${am.asymmetry.toFixed(4)} against ${aRef.toFixed(4)} (cubic interpolation of the rotated image)`);
}

// --- line cut, pixel table, saturation, comparison ranking
{
  const w = 30, h = 20, img = Float64Array.from({ length: w * h }, (_, i) => 3 * (i % w) - 2 * Math.floor(i / w) + 7);
  const lp = lineProfile(img, w, h, 2.25, 3.5, 20.75, 15.1, 0.37);
  let worst = 0; for (let i = 0; i < lp.s.length; i++) worst = Math.max(worst, Math.abs(lp.v[i] - (3 * lp.x[i] - 2 * lp.y[i] + 7)));
  check('line cut is exact on a plane (bilinear)', worst < 1e-12 && Number.isNaN(bilinear(img, w, h, -0.1, 3)), `${lp.s.length} samples over ${lp.length.toFixed(2)} px; largest error ${worst.toExponential(1)}`);
  const pt = pixelTable(img, w, h, 4.4, 5.6, 2);
  check('pixel table rows run from the top', pt.rows[0][0] === img[8 * w + 2] && pt.rows[4][4] === img[4 * w + 6] && pt.cx === 4 && pt.cy === 6, `centre (${pt.cx}, ${pt.cy})`);
  check('saturation level from the header', saturationLevel({ SATURATE: 50000, BITPIX: 16 }).level === 50000 && saturationLevel({ BITPIX: 16, BZERO: 32768 }).level === 65535 && saturationLevel({ BITPIX: -32 }).level === Infinity, 'SATURATE, BITPIX 16 + BZERO, float');
  const t = { x: 100, y: 100, flux: 1e5 }, src = [t, { x: 200, y: 140, flux: 1.1e5, peak: 9000 }, { x: 300, y: 50, flux: 9e4, peak: 60000, saturated: true }, { x: 160, y: 300, flux: 1.05e5, peak: 9000 }, { x: 166, y: 305, flux: 5e4, peak: 5000 }, { x: 5, y: 250, flux: 1e5, peak: 9000 }, { x: 260, y: 260, flux: 6e5, peak: 30000 }];
  const rk = rankComparisons(src, t, { w: 400, h: 400, fwhm: 4, saturation: 60000 });
  check('comparison ranking: similar, isolated, unsaturated star first', rk[0].x === 200 && rk.find((s) => s.x === 300).notes.includes('saturated') && rk.find((s) => s.x === 160).notes.some((n) => /neighbour/.test(n)) && rk.find((s) => s.x === 5).notes.includes('near the edge') && rk.length === 6,
    rk.map((s) => `(${s.x}, ${s.y}) ${s.score.toFixed(2)}${s.notes.length ? ' ' + s.notes.join('; ') : ''}`).join(' | '));
}
// --- the small least-squares fitter on a known problem
{
  const x = Array.from({ length: 30 }, (_, i) => i / 3), y = x.map((v) => 4.2 * Math.exp(-0.35 * v) + 0.7);
  const f = lmFit((p, v) => p[0] * Math.exp(-p[1] * v) + p[2], x, y, [1, 1, 0]);
  check('Levenberg-Marquardt recovers an exponential', Math.abs(f.p[0] - 4.2) < 1e-6 && Math.abs(f.p[1] - 0.35) < 1e-6 && Math.abs(f.p[2] - 0.7) < 1e-6, `${f.p.map((v) => v.toFixed(7)).join(', ')} in ${f.iters} iterations`);
}
process.exit(ok ? 0 : 1);
