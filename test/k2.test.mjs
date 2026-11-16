// K2 systematics (src/core/k2.js, and the self-flat-field of src/core/photometry.js) on real K2 pixels against lightkurve 2.6
// (test/make_lightkurve_reference.py): K2-3 (EPIC 201367065, campaign 1), a 10 × 10 px crop of the first 1,200 cadences
// committed in test/data, and the whole campaign and stamp when the downloaded file is in the cache (ESL_K2_TPF or the
// path the reference script used). Reported: lightkurve's CDPP (6.5 h) before and after each correction, lightkurve's
// SFFCorrector and PLDCorrector with their defaults, and the thruster firings found.
import { readFileSync, existsSync } from 'node:fs';
import { openFits, readTargetPixelFile } from '../src/core/fits.js';
import { tpfLightCurve, pipelineMask, sffDetrend, runningMedian } from '../src/core/photometry.js';
import { qualityBitmask, cdpp, nanMedian } from '../src/core/lcprep.js';
import { pldCorrect, thrusterFlags, splineBasis, pcaColumns } from '../src/core/k2.js';
import { k2Pld, k2Thrusters } from '../src/photometry/pipeline.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const R = JSON.parse(readFileSync(new URL('./lightkurve_reference.json', import.meta.url)));
const readTpf = async (path) => { const b = readFileSync(path); return readTargetPixelFile(await openFits(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); };

// pieces against independent definitions
{
  const x = Float64Array.from({ length: 200 }, (_, i) => i / 199), B = splineBasis(x, 9, 3); let ws = 0;
  for (let i = 0; i < 200; i++) { let s = 0; for (const c of B) s += c[i]; ws = Math.max(ws, Math.abs(s - 1)); }
  check('B-spline basis: 9 columns (patsy df) that sum to one everywhere (partition of unity)', B.length === 9 && ws < 1e-12, `largest deviation ${ws.toExponential(1)}`);
  // principal components: exact (eigen) and randomized subspace iteration agree on a matrix with a clear spectrum
  const n = 400, p = 200, cols = Array.from({ length: p }, (_, j) => Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.05 * (1 + (j % 3))) * (3 - (j % 3)) + 0.01 * Math.cos(i * j)));
  const a = pcaColumns(cols, 3, { exactBelow: 1000 }), b = pcaColumns(cols, 3, { exactBelow: 0 });
  const dots = a.map((u, k) => Math.abs(u.reduce((s, v, i) => s + v * b[k][i], 0)));
  check('principal components: randomized subspace iteration = exact eigenvectors (fbpca-style, |cos| of each pair)', dots.every((d) => d > 0.9999), dots.map((d) => d.toFixed(6)).join(', '));
}

async function run(tpf, r, label) {
  const bm = qualityBitmask('K2', 'default'), pm = pipelineMask(tpf), lc = tpfLightCurve(tpf, pm, { quality: bm });
  const g = []; for (let c = 0; c < tpf.ncad; c++) if (lc.ok[c]) g.push(c);
  const t = Float64Array.from(g, (c) => lc.time[c]), f = Float64Array.from(g, (c) => lc.flux[c]), e = Float64Array.from(g, (c) => lc.err[c]), x = Float64Array.from(g, (c) => lc.x[c]), y = Float64Array.from(g, (c) => lc.y[c]), q = Int32Array.from(g, (c) => tpf.quality[c]);
  const raw = cdpp(t, f), C = r.correctors;
  check(`${label}: CDPP of the raw SAP light curve as lightkurve`, Math.abs(raw / C.cdpp_raw - 1) < 1e-4, `${raw.toFixed(1)} ppm (lightkurve ${C.cdpp_raw.toFixed(1)}), ${t.length} cadences`);
  // thruster firings: on every cadence (quality 'none'), the centroid jumps against the QUALITY bit 20 the pipeline set
  {
    const lc0 = tpfLightCurve(tpf, pm, { quality: 0 }), g0 = []; for (let c = 0; c < tpf.ncad; c++) if (lc0.ok[c]) g0.push(c);
    const th0 = thrusterFlags(Float64Array.from(g0, (c) => lc0.time[c]), Float64Array.from(g0, (c) => lc0.x[c]), Float64Array.from(g0, (c) => lc0.y[c]));
    const F = Uint8Array.from(g0, (c) => (tpf.quality[c] & 1048576 ? 1 : 0)); let hit = 0, nf = 0, extra = 0;
    for (let i = 0; i < g0.length; i++) { if (F[i]) { nf++; if (th0.flags[i] || th0.flags[i - 1] || th0.flags[i + 1]) hit++; } if (th0.flags[i] && !(F[i] || F[i - 1] || F[i + 1])) extra++; }
    check(`${label}: thruster firings found from jumps of the centroid along the roll match the pipeline's flags`, hit >= 0.85 * nf, `${hit} of ${nf} cadences with QUALITY bit 20 (thruster firing) found within one cadence, ${extra} more flagged (unflagged firings or attitude tweaks); 5σ of the arclength steps`);
  }
  // the firings the default quality mask leaves in (found on all cadences, k2Thrusters), dropped for the "without" numbers
  const TH = k2Thrusters(tpf, pm), keep = Uint8Array.from(g, (c) => 1 - TH.flags[c]), kidx = []; keep.forEach((v, i) => { if (v) kidx.push(i); });
  const th = { fromCentroid: g.length - kidx.length }; void q;
  const pick = (a) => Float64Array.from(kidx, (i) => a[i]);
  // self-flat-field (this code) and lightkurve's SFFCorrector
  const s0 = sffDetrend(t, f, x, y), s1 = sffDetrend(t, f, x, y, { keep });
  const cs0 = cdpp(t, s0.corrected), cs1 = cdpp(pick(t), pick(s1.corrected));
  check(`${label}: self-flat-field brings the CDPP down by more than 10×`, cs0 < raw / 10, `${raw.toFixed(0)} → ${cs0.toFixed(1)} ppm (${cs1.toFixed(1)} ppm with the ${th.fromCentroid} cadences of unflagged firings the default quality mask left in taken out); lightkurve SFFCorrector ${C.cdpp_sff.toFixed(1)} ppm, the pipeline's PDCSAP ${r.lcfile.cdpp_pdcsap.toFixed(1)} ppm`);
  // PLD as lightkurve's PLDCorrector for K2: threshold-mask pixels over the SAP flux, order 3, 16 components, background
  // pixels (below the median image) normalised, a degree-5 spline with n/50 knots, 5σ clipping
  const t0 = performance.now(), P = k2Pld(tpf, pm, g, { order: 3, ncomp: 16 }), ms = performance.now() - t0;
  const cp = cdpp(t, P.corrected), cpk = (() => { const P2 = k2Pld(tpf, pm, g, { order: 3, ncomp: 16, cadenceMask: keep }); return cdpp(pick(t), pick(P2.corrected)); })();
  const P2 = k2Pld(tpf, pm, g, { order: 2, ncomp: 16 }), cp2 = cdpp(t, P2.corrected);
  check(`${label}: PLD (EVEREST / lightkurve PLDCorrector form) does at least as well as lightkurve's (within 15%) and better than the self-flat-field`, cp < 1.15 * C.cdpp_pld && cp < cs0, `order 3: ${cp.toFixed(1)} ppm (lightkurve ${C.cdpp_pld.toFixed(1)}; its PCA is randomized: 32.8 and 33.3 ppm in two runs on the crop), ${cpk.toFixed(1)} ppm with thruster firings out of the fit and the metric; order 2: ${cp2.toFixed(1)} ppm (lightkurve ${C.cdpp_pld_order2.toFixed(1)}); ${P.ncols} regressors, ${P.clipped} clipped, ${(ms / 1000).toFixed(1)} s`);
  if (C.pld_flux) {
    // the split of slow trends between the spline and the pixel components is degenerate, so compare what the CDPP sees:
    // both corrected light curves with a 1-day running median removed
    const hp = (v) => { const m = nanMedian(v), h = runningMedian(Float64Array.from(v, (u) => u / m), 49); return Float64Array.from(v, (u, i) => u / m - h[i]); };
    const rob = (v) => { const m = nanMedian(v); return 1.4826 * nanMedian(Array.from(v, (u) => Math.abs(u - m))); };
    const ha = hp(Float64Array.from(C.pld_flux)), hb = hp(P.corrected), dd = rob(Float64Array.from(ha, (v, i) => v - hb[i]));
    check(`${label}: PLD-corrected flux follows lightkurve's point by point`, dd < 0.4 * Math.min(rob(ha), rob(hb)), `robust rms of the difference ${(1e6 * dd).toFixed(1)} ppm per point, against a scatter of ${(1e6 * rob(hb)).toFixed(1)} ppm (lightkurve ${(1e6 * rob(ha)).toFixed(1)} ppm), after a 1-day running median`);
  }
  return { raw, sff: cs0, sffNoFiring: cs1, pld: cp, pldNoFiring: cpk, pld2: cp2 };
}

const crop = R.k2, tc = await readTpf(new URL('./data/' + crop.file, import.meta.url));
const a = await run(tc, crop, 'K2-3 crop (1,042 cadences)');
const full = process.env.ESL_K2_TPF || R.k2_full.path;
if (full && existsSync(full)) { const tf = await readTpf(full); await run(tf, R.k2_full, 'K2-3 whole campaign 1'); }
else console.log(`skip the whole campaign (download ${R.k2_full.file} and set ESL_K2_TPF)`);
console.log(`   summary (crop): CDPP raw ${a.raw.toFixed(0)}, SFF ${a.sff.toFixed(1)}, PLD order 3 ${a.pld.toFixed(1)}, order 2 ${a.pld2.toFixed(1)} ppm`);
process.exit(ok ? 0 : 1);
