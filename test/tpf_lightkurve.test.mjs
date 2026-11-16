// Target pixel files read and reduced here against lightkurve 2.6 on the same real files (test/make_lightkurve_reference.py):
// TESS (WASP-18, sector 2, 700 cadences), Kepler (TrES-2, quarter 1) and K2 (K2-3, campaign 1, a 10 × 10 px crop of the
// first 1,200 cadences). Quality presets, times as BJD_TDB, the pipeline-aperture light curve (flux, error, centroids,
// background), the threshold mask, the pipeline's own SAP_FLUX in the light-curve file, and the CDPP.
import { readFileSync } from 'node:fs';
import { openFits, readTargetPixelFile } from '../src/core/fits.js';
import { tpfLightCurve, pipelineMask, thresholdMask, tpfMedianImage } from '../src/core/photometry.js';
import { qualityBitmask, cdpp } from '../src/core/lcprep.js';
import { defaultQuality } from '../src/photometry/pipeline.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const R = JSON.parse(readFileSync(new URL('./lightkurve_reference.json', import.meta.url)));
const load = (name) => { const b = readFileSync(new URL('./data/' + name, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

for (const key of ['tess', 'kepler', 'k2']) {
  const r = R[key], tpf = readTargetPixelFile(await openFits(load(r.file))), M = tpf.mission;
  check(`${key}: mission`, M === r.mission, `${M} ${tpf.object}, ${tpf.ncad} cadences of ${tpf.nx} × ${tpf.ny} px`);
  // quality presets: the cadences lightkurve keeps
  const counts = {}, firstLast = {};
  for (const p of ['none', 'default', 'hard', 'hardest']) { const bm = qualityBitmask(M, p), kept = []; for (let c = 0; c < tpf.ncad; c++) if (!(tpf.quality[c] & bm)) kept.push(c); counts[p] = kept.length; firstLast[p] = [tpf.cadenceno[kept[0]], tpf.cadenceno[kept[kept.length - 1]]]; }
  check(`${key}: quality presets keep the cadences lightkurve keeps`, ['none', 'default', 'hard', 'hardest'].every((p) => counts[p] === r.quality[p].n && firstLast[p][0] === r.quality[p].cadenceno_first && firstLast[p][1] === r.quality[p].cadenceno_last),
    `none ${counts.none}, default ${counts.default}, hard ${counts.hard}, hardest ${counts.hardest} (lightkurve ${r.quality.none.n}, ${r.quality.default.n}, ${r.quality.hard.n}, ${r.quality.hardest.n}); the page's default is lightkurve's 'default' (${defaultQuality(M)})`);
  const bm = qualityBitmask(M, 'default'), lc = tpfLightCurve(tpf, pipelineMask(tpf), { quality: bm });
  const kept = []; for (let c = 0; c < tpf.ncad; c++) if (!(tpf.quality[c] & bm)) kept.push(c);
  // times
  let wt = 0, wc = true; kept.forEach((c, k) => { wt = Math.max(wt, Math.abs(lc.time[c] - r.time_bjd[k])); wc &&= tpf.cadenceno[c] === r.cadenceno[k]; });
  check(`${key}: times as BJD_TDB (TIME + BJDREFI + BJDREFF) equal lightkurve's Time.tdb.jd`, wt < 2e-9 && wc, `largest difference ${(wt * 86400 * 1e6).toFixed(1)} µs over ${kept.length} cadences (${M === 'TESS' ? 'BTJD + 2457000' : 'BKJD + 2454833'}); cadence numbers identical`);
  // simple aperture photometry with the pipeline mask
  const S = r.sap; let wf = 0, we = 0, wx = 0, wxr = 0, wb = 0, nf = 0, nanLk = 0;
  kept.forEach((c, k) => {
    if (S.flux[k] === null || !Number.isFinite(lc.flux[c])) { if (S.flux[k] !== null && !Number.isFinite(lc.flux[c])) nanLk++; return; }
    nf++; wf = Math.max(wf, Math.abs(lc.flux[c] / S.flux[k] - 1)); we = Math.max(we, Math.abs(lc.err[c] / S.flux_err[k] - 1));
    const dx = Math.abs(lc.x[c] + tpf.col0 - S.centroid_col[k]), dy = Math.abs(lc.y[c] + tpf.row0 - S.centroid_row[k]);
    wx = Math.max(wx, dx, dy); wxr = Math.max(wxr, dx / S.centroid_col[k], dy / S.centroid_row[k]);
    if (S.bkg_sum[k]) wb = Math.max(wb, Math.abs(lc.bkg[c] * lc.npix / S.bkg_sum[k] - 1));
  });
  check(`${key}: pipeline-aperture flux, error, centroids and background equal lightkurve's to_lightcurve`, wf < 1e-6 && we < 1e-6 && wxr < 1e-6 && wb < 1e-6 && lc.npix === r.pipeline_npix,
    `${lc.npix} px; ${nf} cadences: flux ${wf.toExponential(1)}, error ${we.toExponential(1)} relative, centroid ${wx.toExponential(1)} px = ${wxr.toExponential(1)} of the CCD column / row (lightkurve divides by a float32 sum of the pixels: 1e-7 of a coordinate near ${Math.round(S.centroid_col[0])}), background ${wb.toExponential(1)}${nanLk ? `; ${nanLk} cadences with a NaN pixel are NaN here and summed with NaN as 0 by lightkurve` : ''}`);
  // the pipeline's own SAP_FLUX for the same cadences
  if (r.lcfile) {
    let ws = 0, ns = 0; kept.forEach((c, k) => { const s = r.lcfile.sap_flux[k]; if (s === null || !Number.isFinite(lc.flux[c])) return; ns++; ws = Math.max(ws, Math.abs(lc.flux[c] / s - 1)); });
    let wtl = 0; kept.forEach((c, k) => { const tl = r.lcfile.time[k]; if (tl !== null) wtl = Math.max(wtl, Math.abs(lc.time[c] - tpf.bjdRef - tl)); });
    check(`${key}: equals the ${M === 'TESS' ? 'SPOC' : 'Kepler pipeline'} SAP_FLUX of ${r.lcfile.file}`, ws < 1e-6 && ns >= 0.98 * kept.length && wtl < 1e-9, `${ns} cadences matched by CADENCENO, largest relative difference ${ws.toExponential(1)} (lightkurve: ${r.lcfile.lightkurve_vs_sap.max_abs.toExponential(1)}); TIME columns identical to ${(wtl * 86400 * 1e6).toFixed(2)} µs`);
  }
  // CDPP of the SAP light curve
  const g = kept.filter((c) => Number.isFinite(lc.flux[c])), cd = cdpp(Float64Array.from(g, (c) => lc.time[c]), Float64Array.from(g, (c) => lc.flux[c]));
  check(`${key}: CDPP of the SAP light curve as lightkurve's estimate_cdpp`, Math.abs(cd / r.cdpp_sap - 1) < 1e-4, `${cd.toFixed(4)} ppm (lightkurve ${r.cdpp_sap.toFixed(4)} on float64 flux, ${r.cdpp_sap_float32.toFixed(2)} on the file's float32, whose running mean it sums in float32; 13 cadences; tolerance 1e-4: our sums are float64, lightkurve sums the float32 pixels in float32, 2e-7 per point)${r.lcfile ? `; PDCSAP_FLUX of the pipeline: ${r.lcfile.cdpp_pdcsap.toFixed(1)} ppm` : ''}`);
  // threshold mask (3σ above the median image, the region nearest the centre)
  const img = tpfMedianImage(tpf, 1, bm), th = thresholdMask(img, tpf.nx, tpf.ny, 3, tpf.nx / 2, tpf.ny / 2, { lightkurve: true });
  let diff = 0; for (let i = 0; i < th.length; i++) if (th[i] !== r.threshold3.mask[i]) diff++;
  check(`${key}: 3σ threshold mask as lightkurve create_threshold_mask(3, 'center')`, diff === 0, `${th.reduce((a, b) => a + b, 0)} px (lightkurve ${r.threshold3.npix}), ${diff} pixels differ`);
}
process.exit(ok ? 0 : 1);
