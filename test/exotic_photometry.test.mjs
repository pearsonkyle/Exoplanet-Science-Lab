// Image photometry against EXOTIC on EXOTIC's own sample data (HAT-P-32 b, 142 frames from a 6-inch
// MicroObservatory telescope, 2017-12-20; github.com/rzellem/EXOTIC_sampledata).
//
// What EXOTIC did was recorded by running EXOTIC itself (test/exotic_record.py wraps four of its functions and
// calls its main()); test/make_exotic_photometry_reference.py turned that into exotic_photometry_reference.json
// and cut every third frame down to a 152 x 166 px window around the three stars
// (test/data/hatp32_exotic_sample.fits, 48 Rice-compressed images, 1.1 MB). This code's run on all 142 full
// frames is recorded in exotic_photometry_full.json (test/make_exotic_photometry_full.mjs); the cut-outs are
// checked to reproduce it, and with ESL_EXOTIC_SAMPLE=<directory of the 142 FITS files> the full run is repeated.
//
// Tolerances are what the comparison measures plus headroom, not design goals; each line prints the number.
import { readFileSync, existsSync } from 'node:fs';
import { splitFits, loadFrame, runStack } from '../src/photometry/pipeline.js';
import { apertureSum, annulusBackground, fitPsf, ellipseSum, ellipsePixelOverlap, seriesOf, addStars, medianOf, lightCurveFor } from '../src/core/photometry.js';
import { fitTransitLsq, makeTransitFitter, exoticBounds } from '../src/photometry/transitfit.js';
import { makeRng } from '../src/core/stats.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const url = (p) => new URL(p, import.meta.url);
const R = JSON.parse(readFileSync(url('./exotic_photometry_reference.json'))), F = JSON.parse(readFileSync(url('./exotic_photometry_full.json')));
console.log('reference: ' + R.generator);
const P = R.planet, planet = { rprs: P.rprs, ars: P.aRs, inc: P.inc, per: P.pPer, tmid: P.midT, ecc: P.ecc, omega: P.omega, ld: R.ld, tmidUnc: P.midTUnc, perUnc: P.pPerUnc };
const pct = (v) => (100 * v).toFixed(3) + '%', max = (a) => a.reduce((m, v) => Math.max(m, v), -Infinity), rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length), mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) * (v - m)))); };

// ---- 1. the frames: one file of 48 tile-compressed images, read by this code's own Rice decoder -------------
const raw = readFileSync(url('./data/hatp32_exotic_sample.fits'));
const sources = await splitFits(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'hatp32');
const frames = []; for (const s of sources) frames.push(await loadFrame(s));
check('cut-outs: 48 Rice-compressed frames decode to the window size, headers intact', frames.length === 48 && frames.every((f, k) => f.width === R.cutout.width && f.height === R.cutout.height && f.compression === 'RICE_1' && f.header.CROPX0 === R.offsets[k][0] && f.header.CROPY0 === R.offsets[k][1]), `${raw.length} bytes; UT-OBS "${frames[0].header['UT-OBS']}"`);

// ---- 2. this code on the cut-outs, with EXOTIC's star positions, apertures and annuli ----------------------
const o0 = R.offsets[0];
const cfg = { stars: R.stars.map(([x, y]) => ({ x: x - o0[0], y: y - o0[1] })), timeAt: 'exotic', target: { ra: P.ra, dec: P.dec }, site: R.site, apertures: R.apers, annuli: R.annuli, score: 'transit', planet, weighted: false };   // the weighted ensemble: detrend.test.mjs
const t0 = performance.now(), res = await runStack(sources, cfg), M = res.M, secs = (performance.now() - t0) / 1000;
check('all 48 frames measured', M.count === 48, `${secs.toFixed(1)} s including ${res.opt.tried.length} transit-model fits; field re-found by asterism ${res.relocated} times (the window steps by 8 px, the mount drifts 272 px over the night)`);
{
  let dt = 0, da = 0; R.sel.forEach((i, k) => { dt = Math.max(dt, Math.abs(M.time[k] - R.bjd[i]) * 86400); da = Math.max(da, Math.abs(M.airmass[k] - R.airmass[i])); });
  check("time: BJD_TDB of each frame equals EXOTIC's (UT-OBS + half the exposure, barycorrpy)", dt < 0.1, `largest difference ${dt.toFixed(3)} s; tolerance 0.1 s (this code leaves out the observatory's position on the Earth, at most 0.02 s)`);
  check("airmass: sec z from TELALT equals EXOTIC's", da < 1e-12, `largest difference ${da.toExponential(1)}`);
}

// ---- 3. centroids ------------------------------------------------------------------------------------------
// EXOTIC fits a Gaussian and then replaces its centre by the flux-weighted mean of the 31 x 31 box WITHOUT
// subtracting the sky (fit_centroid, weightedcenter=True). The sky dominates that sum, so the result stays within
// a fraction of a pixel of the box centre, i.e. of the position predicted from the first frame.
const X = (k, s) => M.x[k * 3 + s] + R.offsets[k][0], Y = (k, s) => M.y[k * 3 + s] + R.offsets[k][1];
{
  const dG = [], dW = [], gw = [];
  R.sel.forEach((i, k) => { for (let s = 0; s < 3; s++) { dG.push(Math.hypot(X(k, s) - R.gauss[i][s][0], Y(k, s) - R.gauss[i][s][1])); dW.push(Math.hypot(X(k, s) - R.centroid[i][s][0], Y(k, s) - R.centroid[i][s][1])); gw.push(Math.hypot(R.gauss[i][s][0] - R.centroid[i][s][0], R.gauss[i][s][1] - R.centroid[i][s][1])); } });
  check("centroids agree with the centre of EXOTIC's own Gaussian fit", max(dG) < 0.45 && medianOf(dG) < 0.12, `median ${medianOf(dG).toFixed(3)} px, largest ${max(dG).toFixed(3)} px over 144 star images (PSF sigma is about 0.8 px); tolerances 0.12 and 0.45 px`);
  check("the centroid EXOTIC actually uses is far from both", medianOf(dW) > 0.7 && medianOf(gw) > 0.7, `median distance from this code ${medianOf(dW).toFixed(2)} px (largest ${max(dW).toFixed(2)}), from EXOTIC's own Gaussian centre ${medianOf(gw).toFixed(2)} px (largest ${max(gw).toFixed(2)})`);
  // Which is right? A small aperture collects the most light when it is centred on the star.
  const r = R.apers[0], ratio = [], fE = [[], [], []], fT = [[], [], []];
  R.sel.forEach((i, k) => { const fr = frames[k]; for (let s = 0; s < 3; s++) {
    const xe = R.centroid[i][s][0] - R.offsets[k][0], ye = R.centroid[i][s][1] - R.offsets[k][1], xt = M.x[k * 3 + s], yt = M.y[k * 3 + s];
    const bg = annulusBackground(fr.data, fr.width, fr.height, xt, yt, 8, 16)[0];
    const a = apertureSum(fr.data, fr.width, fr.height, xe, ye, r), e = a[0] - a[1] * bg, b = apertureSum(fr.data, fr.width, fr.height, xt, yt, r), t = b[0] - b[1] * bg;
    ratio.push(t / e); fE[s].push(e); fT[s].push(t);
  } });
  const sc = (v) => 1.4826 * medianOf(v.map((u) => Math.abs(u / medianOf(v) - 1)));
  check("evidence: an r = 1.5 px aperture holds more light, and steadier, on this code's centroid than on EXOTIC's", medianOf(ratio) > 1.3 && sc(fT[0]) < sc(fE[0]), `median flux ratio ${medianOf(ratio).toFixed(2)} over 144 star images (same pixels, same sky; the aperture that holds more of a star's light is the better centred one); robust frame-to-frame scatter of the target's flux ${pct(sc(fT[0]))} against ${pct(sc(fE[0]))}`);
}

// ---- 4. PSF fits: the same rotated Gaussian, the same 31 x 31 box, the same starting point ------------------
{
  const dF = [], dB = [], dS = []; let bound = 0;
  R.sel.forEach((i, k) => { const fr = frames[k]; for (let s = 0; s < 3; s++) {
    const [amp, sx, sy, rot, bg] = R.psf[i][s], gx = R.guess[i][s][0] - R.offsets[k][0], gy = R.guess[i][s][1] - R.offsets[k][1];
    if (Math.abs(Math.abs(rot) - Math.PI / 4) < 1e-3 || sx <= 0.5001 || sy <= 0.5001) { bound++; return; }      // EXOTIC's fit stopped on one of its bounds
    const fit = fitPsf(fr.data, fr.width, fr.height, gx, gy, 15, { rotate: true, sigma: 1 });
    dF.push(fit.flux / (2 * Math.PI * amp * sx * sy) - 1); dB.push(fit.bg - bg); dS.push(Math.sqrt(fit.sx * fit.sy) / Math.sqrt(sx * sy) - 1);
  } });
  const aF = dF.map(Math.abs).sort((a, b) => a - b), q90 = aF[Math.floor(0.9 * aF.length)];
  check("PSF fit: Gaussian flux 2 pi A sx sy matches EXOTIC's fit", medianOf(aF) < 2e-3 && q90 < 0.03, `median |difference| ${medianOf(aF).toExponential(1)}, 90% within ${pct(q90)}, largest ${pct(max(aF))} over ${dF.length} fits (${bound} more left out because EXOTIC's fit ended on a bound: rotation at ±45°, or sigma at 0.5 px); width ${pct(medianOf(dS.map(Math.abs)))} median; fitted sky differs by ${rms(dB).toFixed(2)} counts rms. Tolerances 0.2% median, 3% for 90%: the least-squares surface is nearly flat in (sx, sy, rotation) for a star 0.8 px wide, and scipy stops at xtol = None, ftol = 1e-8`);
}

// ---- 5. aperture sums and sky ------------------------------------------------------------------------------
// EXOTIC's sky (skybg_phot): the MODE of every pixel of the box around the annulus (star and gap included) that is
// not above the 99th percentile of the annulus pixels. Ported here to compare like with like.
const rnd = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };     // numpy rounds half to even
function exoticSky(data, w, h, xc, yc, r, dr) {
  const box = rnd(r + dr), px = rnd(xc), py = rnd(yc), ann = [], all = [];
  for (let y = Math.max(0, py - box); y < Math.min(h, py + box + 1); y++) for (let x = Math.max(0, px - box); x < Math.min(w, px + box + 1); x++) { const v = data[y * w + x], rv = Math.hypot(x - xc, y - yc); all.push(v); if (rv > r && rv < r + dr) ann.push(v); }
  ann.sort((a, b) => a - b); const pos = 0.99 * (ann.length - 1), lo = Math.floor(pos), cut = ann[lo] + (pos - lo) * ((ann[Math.min(ann.length - 1, lo + 1)]) - ann[lo]);
  const cnt = new Map(); for (const v of all) if (v <= cut) cnt.set(v, (cnt.get(v) || 0) + 1);
  let best = NaN, bc = 0; for (const [v, c] of cnt) if (c > bc || (c === bc && v < best)) { best = v; bc = c; }
  return best;
}
{
  let worstSum = 0, worstSky = 0, n = 0; const dSky = [], skyE = [], skyT = [];
  for (const [a, an] of R.combos) {
    const key = `${a},${an}`, r = R.apers[a], dr = R.annuli[an];
    R.sel.forEach((i, k) => { const fr = frames[k]; for (let s = 0; s < 3; s++) {
      const xe = R.centroid[i][s][0] - R.offsets[k][0], ye = R.centroid[i][s][1] - R.offsets[k][1], fE = R.flux[key][i][s], bE = R.bg[key][i][s];
      const ap = apertureSum(fr.data, fr.width, fr.height, xe, ye, r), mine = ap[0] - ap[1] * bE;
      worstSum = Math.max(worstSum, Math.abs(mine - fE) / Math.abs(fE)); n++;
      worstSky = Math.max(worstSky, Math.abs(exoticSky(fr.data, fr.width, fr.height, xe, ye, r + 2, dr) - bE));
      if (a === R.best.ia && an === R.best.in) { const b = annulusBackground(fr.data, fr.width, fr.height, xe, ye, r + 2, r + 2 + dr)[0]; dSky.push(b - bE); skyE.push(bE); skyT.push(b); }
    } });
  }
  check("aperture sums at EXOTIC's centroids, radii and sky equal EXOTIC's (photutils 'exact')", worstSum < 2e-6, `largest relative difference ${worstSum.toExponential(1)} over ${n} sums (5 aperture/annulus pairs x 48 frames x 3 stars); tolerance 2e-6, set by the reference's centroids being stored to 1e-6 px`);
  check("EXOTIC's sky estimator, ported, reproduces EXOTIC's sky on the real frames exactly", worstSky === 0, `largest difference ${worstSky} counts over ${n} annuli`);
  check("sky: this code's clipped annulus median against EXOTIC's mode", Math.abs(mean(dSky)) < 2 && rms(dSky) < 3, `at EXOTIC's chosen annulus: mean difference ${mean(dSky).toFixed(2)} counts (this - EXOTIC), rms ${rms(dSky).toFixed(2)}, sky about ${medianOf(skyE).toFixed(0)} counts; over 400 px of aperture a 1 count error is ${(100 * 62 / 7400).toFixed(1)}% of the target's flux`);
  // who is closer to the truth: frames with a known sky, a star like the target, Poisson noise, integer counts
  const rng = makeRng(7), W = 64, eE = [], eT = [], trueSky = 370.4, r = R.best.aperture, dr = R.best.annulus;
  for (let t = 0; t < 300; t++) {
    const img = new Float32Array(W * W).fill(trueSky); addStars(img, W, W, [{ x: 32 + rng.next() - 0.5, y: 32 + rng.next() - 0.5, flux: 7400, sigma: 0.85 }, { x: 32 + 9, y: 32 - 6, flux: 600, sigma: 0.85 }]);
    for (let i = 0; i < img.length; i++) img[i] = Math.round(img[i] + Math.sqrt(Math.max(1, img[i])) * rng.normal());
    eE.push(exoticSky(img, W, W, 32, 32, r + 2, dr) - trueSky); eT.push(annulusBackground(img, W, W, 32, 32, r + 2, r + 2 + dr)[0] - trueSky);
  }
  check('evidence: on synthetic frames with a known sky the clipped median is closer than the mode', rms(eT) < 0.5 * rms(eE), `300 frames, sky 370.4 counts with Poisson noise, a faint neighbour in the annulus: error of this code ${mean(eT).toFixed(2)} ± ${std(eT).toFixed(2)} counts, of EXOTIC's mode ${mean(eE).toFixed(2)} ± ${std(eE).toFixed(2)} (the mode of integer counts over about 300 pixels is decided by a handful of ties)`);
}

// ---- 6. the fit that scores each candidate ------------------------------------------------------------------
// EXOTIC's lc_fitter(mode='lm') passes SQUARED normalised residuals to scipy.optimize.least_squares, so it minimises
// sum(r^4). Reproduce that on EXOTIC's own fluxes, then fit the same fluxes by chi^2.
const tAll = Float64Array.from(R.bjd), amAll = Float64Array.from(R.airmass);
{
  let worstStd = 0, worstR = 0, worstT = 0, nCmp = 0; const shift = [];
  for (const [a, an] of R.combos) for (let c = 0; c < 3; c++) {
    const rec = R.lmFits[`${a},${an}`][c]; if (!rec || rec.n !== 142) continue;                       // EXOTIC's clip is random; compare where it removed nothing
    const fl = R.flux[`${a},${an}`], T = Float64Array.from(fl, (v) => v[0]), C = c ? Float64Array.from(fl, (v) => v[c]) : new Float64Array(142).fill(1);
    const ratio = T.map((v, i) => v / C[i]), e = c ? T.map((v, i) => Math.sqrt(v / (C[i] * C[i]) + v * v / (C[i] ** 3))) : T.map(Math.sqrt);
    const fq = fitTransitLsq(tAll, ratio, e, amAll, planet, { loss: 'exotic' }), f2 = fitTransitLsq(tAll, ratio, e, amAll, planet);
    worstStd = Math.max(worstStd, Math.abs(fq.scatter / rec.std - 1)); worstR = Math.max(worstR, Math.abs(fq.params.rprs - rec.pars.rprs)); worstT = Math.max(worstT, Math.abs(fq.params.tmid - rec.pars.tmid) * 1440); nCmp++;
    shift.push([f2.params.rprs - rec.pars.rprs, (f2.params.tmid - rec.pars.tmid) * 1440, f2.scatter / rec.std - 1]);
  }
  check("EXOTIC's candidate fits are reproduced when its objective, sum(r^4), is used", worstStd < 0.01 && worstR < 0.003 && worstT < 1, `${nCmp} fits of EXOTIC's own fluxes: residual scatter within ${pct(worstStd)}, Rp/R* within ${worstR.toFixed(4)}, mid-time within ${worstT.toFixed(2)} min; tolerances 1%, 0.003, 1 min (two optimisers on a quartic surface; inclination is often on its bound)`);
  check('the same fluxes fitted by chi^2 give different parameters: the quartic objective matters', max(shift.map((s) => Math.abs(s[0]))) > 0.0005, `chi^2 minus EXOTIC over those fits: Rp/R* by up to ${max(shift.map((s) => Math.abs(s[0]))).toFixed(4)}, mid-time by up to ${max(shift.map((s) => Math.abs(s[1]))).toFixed(2)} min, scatter by up to ${pct(max(shift.map((s) => Math.abs(s[2]))))}`);
}

// ---- 7. the choice of aperture, annulus and comparison star (recorded full runs) ---------------------------
{
  const E = R.best, B = F.transit.best, eb = F.transit.grid.none[E.ia][E.in];
  console.log(`   EXOTIC, 142 frames: aperture ${E.aperture.toFixed(2)} px, annulus ${E.annulus.toFixed(2)} px, comparison ${E.comp ? 'C' + E.comp : 'none'}, scatter ${pct(E.std)}; its PSF photometry ${pct(R.scatterPsf[0])} (C1), ${pct(R.scatterPsf[1])} (C2)`);
  console.log(`   this code, 142 frames: ${B.method} ${B.aperture.toFixed(2)} px, annulus ${B.annulus.toFixed(2)} px, comparison ${B.comp < 0 ? 'none' : B.comp === 0 ? 'both summed' : 'C' + B.comp}, scatter ${pct(B.scatter)}; at EXOTIC's aperture, annulus and no comparison ${pct(eb)}`);
  console.log('   this code, best of each method: ' + Object.entries(F.transit.bestBy).sort((a, b) => a[1].scatter - b[1].scatter).map(([k, r]) => `${k} ${pct(r.scatter)}`).join(', '));
  const g = R.scatterGrid, minOf = (c) => { let m = Infinity; for (const row of g) for (const v of row) if (v[c] < m) m = v[c]; return m; }, mine = (k) => Math.min(...F.transit.grid[k].flat());
  check('recorded: this code reaches a lower residual scatter than EXOTIC for every choice of comparison star', mine('none') < minOf(0) && mine('C1') < minOf(1) && mine('C2') < minOf(2), `none ${pct(mine('none'))} / ${pct(minOf(0))}, C1 ${pct(mine('C1'))} / ${pct(minOf(1))}, C2 ${pct(mine('C2'))} / ${pct(minOf(2))} (this / EXOTIC); the ensemble of both, which EXOTIC does not try, ${pct(mine('all'))}`);
  // the two tables side by side: how many of the 20 x 19 aperture/annulus cells are better here
  let better = 0, tot = 0; for (let a = 0; a < 20; a++) for (let n = 0; n < 19; n++) { tot++; if (F.transit.grid.none[a][n] < g[a][n][0]) better++; }
  check('recorded: cell by cell (no comparison star), this code is lower in most of the grid', better > 0.7 * tot, `${better} of ${tot} cells; the cells where EXOTIC is lower are its largest apertures, where a misplaced aperture loses nothing`);
  check('recorded: the quick trapezoid score picks the same method, aperture and comparison as the transit-model score', F.quick.best.method === B.method && F.quick.best.ia === B.ia && F.quick.best.comp === B.comp, `quick: annulus ${F.quick.best.annulus.toFixed(2)} px, scatter ${pct(F.quick.best.scatter)}; transit model: annulus ${B.annulus.toFixed(2)} px, ${pct(B.scatter)}; search ${(F.quick.timing.optimise / 1000).toFixed(1)} s against ${(F.transit.timing.optimise / 1000).toFixed(1)} s for ${F.transit.candidates} candidates (EXOTIC: ${(R.fitMs * 1142 / 1000).toFixed(0)} s for 1142)`);
  // the cut-outs reproduce the recorded full-frame run at the frames they hold
  let dx = 0, dfl = 0; const Tc = seriesOf(M, 'aperture', 0, B.ia, B.in);
  R.sel.forEach((i, k) => { for (let s = 0; s < 3; s++) dx = Math.max(dx, Math.hypot(X(k, s) - F.transit.x[i * 3 + s], Y(k, s) - F.transit.y[i * 3 + s])); dfl = Math.max(dfl, Math.abs(Tc[k] / F.transit.best.targetFlux[i] - 1)); });
  check('the cut-outs reproduce the recorded full-frame run', dx < 0.05 && dfl < 1e-3, `centroids within ${dx.toFixed(4)} px, target flux within ${dfl.toExponential(1)} at the 48 frames; tolerances 0.05 px and 1e-3 (the iterated centroid settles a few hundredths of a pixel apart when it starts from a different place)`);
}

// ---- 8. the light curves, point by point, and the transit each one gives -----------------------------------
{
  const key = `${R.best.ia},${R.best.in}`, TE = Float64Array.from(R.flux[key], (v) => v[0]);                                   // EXOTIC's best: target alone
  const fitter = makeTransitFitter(planet), one = new Float64Array(142).fill(1);
  const fE = fitter(tAll, TE, { airmass: amAll, target: TE, comp: one, noComp: true });
  const B = F.transit.best, TB = Float64Array.from(B.targetFlux), CB = Float64Array.from(B.compFlux), RB = TB.map((v, i) => v / CB[i]);
  const fB = fitter(Float64Array.from(F.transit.time), RB, { airmass: Float64Array.from(F.transit.airmass), target: TB, comp: CB, noComp: false });
  // this code with EXOTIC's settings (its aperture, annulus, no comparison), from the cut-outs: point by point against EXOTIC's flux
  const mine = seriesOf(M, 'aperture', 0, R.best.ia, R.best.in), d = [], nE = [], nM = [];
  R.sel.forEach((i, k) => { nE.push(TE[i] / fE.baseline[i]); });
  const tS = Float64Array.from(R.sel, (i) => R.bjd[i]), aS = Float64Array.from(R.sel, (i) => R.airmass[i]), fS = fitter(tS, mine, { airmass: aS, target: mine, comp: new Float64Array(48).fill(1), noComp: true });
  R.sel.forEach((i, k) => { nM.push(mine[k] / fS.baseline[k]); d.push(nM[k] - nE[k]); });
  check("light curve at EXOTIC's settings, point by point against EXOTIC's (48 frames)", rms(d) < 0.006 && max(d.map(Math.abs)) < 0.02, `detrended flux differs by ${pct(rms(d))} rms, ${pct(max(d.map(Math.abs)))} at most: the two measure the same pixels with centroids about 1.5 px and skies about 0.3 count apart, and that difference is as large as the scatter of either curve (EXOTIC ${pct(fE.scatter)} over 142 points)`);
  const line = (n, f) => `   ${n.padEnd(34)} Rp/R* ${f.params.rprs.toFixed(4)} ± ${f.errors.rprs.toFixed(4)}   T_mid ${(f.params.tmid - 2458107).toFixed(5)} ± ${f.errors.tmid.toFixed(5)}   i ${f.params.inc.toFixed(2)}${f.atBound.includes('inc') ? ' (bound)' : ' ± ' + f.errors.inc.toFixed(2)}   a2 ${f.params.a2.toFixed(4)}   scatter ${pct(f.scatter)}   n ${f.n}`;
  console.log('   fitted the same way (chi^2, EXOTIC bounds, photon weights, clip at 3 sigma; errors formal, scaled by sqrt(chi2/dof)):');
  console.log(line("EXOTIC's light curve", fE)); console.log(line("this code's best light curve", fB));
  console.log(`   EXOTIC's own results: least squares Rp/R* ${R.best.lm.rprs.toFixed(4)}, T_mid ${(R.best.lm.tmid - 2458107).toFixed(5)}, i ${R.best.lm.inc.toFixed(2)}; nested sampling Rp/R* ${R.final.nested.rprs[0]} ± ${R.final.nested.rprs[1]}, T_mid ${(R.final.nested.tmid[0] - 2458107).toFixed(4)} ± ${R.final.nested.tmid[1]}, i ${R.final.nested.inc[0]} ± ${R.final.nested.inc[1]}, scatter ${pct(R.final.nested.scatter)}`);
  const sR = Math.hypot(fE.errors.rprs, fB.errors.rprs), sT = Math.hypot(fE.errors.tmid, fB.errors.tmid);
  check('transit parameters from the two light curves agree within their uncertainties', Math.abs(fE.params.rprs - fB.params.rprs) < 3 * sR && Math.abs(fE.params.tmid - fB.params.tmid) < 3 * sT, `Rp/R* differs by ${((fE.params.rprs - fB.params.rprs) / sR).toFixed(1)} sigma, mid-time by ${((fE.params.tmid - fB.params.tmid) / sT).toFixed(1)} sigma (${((fE.params.tmid - fB.params.tmid) * 1440).toFixed(1)} min); tolerance 3 sigma of the two formal errors combined. The curves are not independent (same photons), so this is a consistency check, not a significance`);
  check("this code's light curve has the lower scatter and the smaller formal errors", fB.scatter < fE.scatter && fB.errors.rprs < fE.errors.rprs, `scatter ${pct(fB.scatter)} against ${pct(fE.scatter)}; Rp/R* error ${fB.errors.rprs.toFixed(4)} against ${fE.errors.rprs.toFixed(4)}; mid-time error ${(fB.errors.tmid * 1440).toFixed(2)} against ${(fE.errors.tmid * 1440).toFixed(2)} min`);
  const lit = P.rprs; check('both agree with the published radius ratio to a few per cent', Math.abs(fB.params.rprs / lit - 1) < 0.06 && Math.abs(fE.params.rprs / lit - 1) < 0.06, `published (inits file) ${lit.toFixed(4)}; this ${fB.params.rprs.toFixed(4)}, EXOTIC's curve ${fE.params.rprs.toFixed(4)}; unfiltered ("Clear") data against a value from another band, tolerance 6%`);
  // EXOTIC's exported light curve (FinalLightCurve csv) is its best candidate divided by its fitted airmass baseline,
  // which the file gives in the column it calls "Airmass": candidate / (Flux x that column) must be one constant
  const iF = R.final.bjd.map((t) => R.bjd.findIndex((b) => Math.abs(b - t) < 1e-6)), rr = R.final.flux.map((v, k) => TE[iF[k]] / (v * R.final.airmass[k]));
  check("EXOTIC's exported light curve is its best candidate over its airmass baseline", iF.every((i) => i >= 0) && std(rr) / mean(rr) < 1e-6, `${R.final.bjd.length} points; candidate / (exported flux x exported baseline) constant to ${(std(rr) / mean(rr)).toExponential(1)}, so the candidate fluxes in the reference are the light curve EXOTIC reports`);
}

// ---- 9. elliptical apertures against photutils --------------------------------------------------------------
{
  const W = 64, H = 48, img = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y * W + x] = 100 + 30 * Math.sin(0.37 * x + 0.11 * y * y / 48) + 20 * Math.cos(0.23 * y - 0.05 * x) + 500 * Math.exp(-((x - 30.3) ** 2 + (y - 22.6) ** 2) / 8);
  let ws = 0, wa = 0; for (const c of R.ellipse.cases) { const e = ellipseSum(img, W, H, c.x, c.y, c.a, c.b, c.theta); ws = Math.max(ws, Math.abs(e[0] / c.sum - 1)); wa = Math.max(wa, Math.abs(e[1] / c.area - 1)); }
  check("elliptical apertures: sums and areas equal photutils EllipticalAperture method='exact'", ws < 1e-12 && wa < 1e-12, `largest relative difference ${ws.toExponential(1)} (sum), ${wa.toExponential(1)} (area) over ${R.ellipse.cases.length} ellipses, axis ratios 1 to 6, one smaller than a pixel`);
  let wc = 0; for (const r of [0.3, 1.7, 4.44, 9.1]) for (const [dx, dy] of [[0.2, -0.3], [0, 0], [0.5, 0.5]]) { const e = Array.from(ellipseSum(img, W, H, 30 + dx, 22 + dy, r, r, 0.6)), c = apertureSum(img, W, H, 30 + dx, 22 + dy, r), s0 = c[0], a0 = c[1]; wc = Math.max(wc, Math.abs(e[0] / s0 - 1), Math.abs(e[1] / a0 - 1)); }
  check('an ellipse with equal axes equals the circular aperture', wc < 1e-12, `largest relative difference ${wc.toExponential(1)}; the two use different geometry code`);
  let tot = 0; for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) tot += ellipsePixelOverlap(x + 0.3, y - 0.1, 5.5, 2.25, 0.9);
  check('partial pixels of an ellipse add up to its area', Math.abs(tot / (Math.PI * 5.5 * 2.25) - 1) < 1e-13, `relative error ${Math.abs(tot / (Math.PI * 5.5 * 2.25) - 1).toExponential(1)}`);
}

// ---- 10. the full frames, when they are at hand --------------------------------------------------------------
{
  const dir = process.env.ESL_EXOTIC_SAMPLE;
  if (dir && existsSync(dir)) {
    const { runFull, summarise } = await import('./make_exotic_photometry_full.mjs'), { res: full, seconds } = await runFull(dir, R, 'transit'), S = summarise(full);
    let dx = 0; for (let i = 0; i < S.x.length; i++) dx = Math.max(dx, Math.abs(S.x[i] - F.transit.x[i]), Math.abs(S.y[i] - F.transit.y[i]));
    check('full frames: the run on all 142 frames reproduces the recorded one', S.frames === 142 && dx < 1e-6 && Math.abs(S.best.scatter - F.transit.best.scatter) < 1e-9 && S.best.ia === F.transit.best.ia && S.best.in === F.transit.best.in && S.best.comp === F.transit.best.comp, `${seconds.toFixed(1)} s; centroids within ${dx.toExponential(1)} px; best ${S.best.method} ${S.best.aperture.toFixed(2)} px, scatter ${pct(S.best.scatter)}`);
  } else console.log('skip full frames: set ESL_EXOTIC_SAMPLE to the folder holding the 142 FITS files of EXOTIC_sampledata-1.0.0 to rerun on them');
}

console.log(ok ? '\nexotic photometry tests passed' : '\nexotic photometry tests FAILED');
process.exit(ok ? 0 : 1);
