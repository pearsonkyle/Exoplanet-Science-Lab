// Time-series spectroscopy (src/core/spectroscopy.js, src/core/missionbands.js and the linear regressors of
// buildProblem) against independent references made by test/make_spectroscopy_reference.py:
//   astropy.io.fits for the x1dints reader (two synthetic files in both pipeline layouts, and the real JWST
//   files when they are in test/data/jwst), numpy / scipy.integrate.tplquad for the marginal likelihood with
//   regressors, scipy.integrate.quad for the photon rate, astropy constants for the scale height, astropy's ECSV
//   reader for the exported spectrum, batman for the injected channel light curves, and the published G395H
//   spectrum of WASP-39 b (Alderson et al. 2023, Zenodo 10.5281/zenodo.7185300) for the real data.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFits } from '../src/core/fits.js';
import { buildProblem, REG_PRIOR_WIDTH, A1_PRIOR_WIDTH } from '../src/core/model.js';
import { transitModel } from '../src/core/transit.js';
import { expandSpectral } from '../src/core/ldspec.js';
import { LD_SPECTRAL_COMPACT } from '../src/data/ld_spectral.js';
import { validateSession, specFromSession } from '../src/core/session.js';
import { MISSION_BANDS, TELESCOPES, instrumentChannels, bandsOf } from '../src/core/missionbands.js';
import * as S from '../src/core/spectroscopy.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const skip = (name, info) => console.log('skip ' + name + '   ' + info);
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ref = JSON.parse(readFileSync(here('./spectroscopy_reference.json')));
const T0 = performance.now(), ex = (v) => v.toExponential(1), ppm = (v) => (1e6 * v).toFixed(0);
const maxAbs = (a, b) => { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i])); return w; };
const maxRel = (a, b) => { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i]) / Math.abs(b[i])); return w; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const pullStats = (res, truth) => { const p = res.map((r, i) => (r.depth - truth[i]) / (r.depth > truth[i] ? r.depthMinus : r.depthPlus)); return { p, mean: mean(p), std: std(p), c1: p.filter((x) => Math.abs(x) < 1).length / p.length, c2: p.filter((x) => Math.abs(x) < 2).length / p.length, n: p.length }; };
const pullText = (q) => `pull mean ${q.mean.toFixed(3)}, std ${q.std.toFixed(3)}, within 1 sigma ${(100 * q.c1).toFixed(0)}%, within 2 sigma ${(100 * q.c2).toFixed(0)}% (n = ${q.n})`;
const table = expandSpectral(LD_SPECTRAL_COMPACT);

// --- 1. linear regressors in buildProblem, integrated out analytically
{
  const R = ref.regressors, sys = R.system;
  const data = { t: Float64Array.from(R.t), f: Float64Array.from(R.f), e: Float64Array.from(R.e), regressors: [Float64Array.from(R.x1), Float64Array.from(R.x2)] };
  const values = { rprs: sys.rprs, ars: sys.ars, inc: sys.inc, per: sys.per, tmid: sys.tmid, ecc: 0, omega: 0, ld0: sys.u[0], ld1: sys.u[1] };
  const prob = buildProblem({ data, values, ldLaw: 'quadratic', free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.05, b: 0.2 } }], exptime: 0, supersample: 1 });
  let wA = 0, wB = 0, wBeta = 0, wM = 0, wBrute = 0;
  for (const c of R.cases) {
    const lnL = prob.loglike([c.rprs]), det = prob.detail([c.rprs]);
    wA = Math.max(wA, Math.abs(lnL - c.lnL_analytic)); wB = Math.max(wB, Math.abs(lnL - c.lnL_brute)); wBrute = Math.max(wBrute, Math.abs(c.lnL_analytic - c.lnL_brute));
    wBeta = Math.max(wBeta, Math.abs(det.a1 - c.beta[0]), Math.abs(det.regCoeffs[0][0] - c.beta[1]), Math.abs(det.regCoeffs[0][1] - c.beta[2]));
    wM = Math.max(wM, maxAbs(det.transit, c.model));
  }
  check('regressors: marginal ln L against numpy and against brute-force integration (scipy tplquad)', wA < 0.02 && wB < 0.02 && wBrute < 1e-9,
    `largest |d lnL| ${ex(wA)} (analytic), ${ex(wB)} (numerical integral over a1, c1, c2); the two references differ by ${ex(wBrute)}; transit model against batman ${ex(wM)}; 3 values of Rp/R*; tolerance 0.02`);
  check('regressors: coefficients (a1, slope, step) against numpy.linalg.solve', wBeta < 2e-6, `largest difference ${ex(wBeta)}; tolerance 2e-6 (the transit models differ by ${ex(wM)})`);
  check('regressors: prior widths are those the reference assumed', REG_PRIOR_WIDTH === R.prior_widths.c && A1_PRIOR_WIDTH === R.prior_widths.a1, `a1 ~ U(0, ${A1_PRIOR_WIDTH}), c ~ U(-${REG_PRIOR_WIDTH / 2}, ${REG_PRIOR_WIDTH / 2})`);
  // without regressors nothing changes: the same data with the columns removed gives the one-parameter formula
  const p0 = buildProblem({ data: { t: data.t, f: data.f, e: data.e }, values, ldLaw: 'quadratic', free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.05, b: 0.2 } }], exptime: 0, supersample: 1 });
  const d0 = p0.detail([0.12]); let sdm = 0, smm = 0, sdd = 0, ln = 0; for (let i = 0; i < data.t.length; i++) { const w = 1 / data.e[i] ** 2, m = d0.transit[i]; sdm += w * data.f[i] * m; smm += w * m * m; sdd += w * data.f[i] ** 2; ln += Math.log(data.e[i] ** 2); }
  const want = -0.5 * (ln + data.t.length * Math.log(2 * Math.PI)) - Math.log(A1_PRIOR_WIDTH) - 0.5 * (sdd - sdm * sdm / smm) + 0.5 * Math.log(2 * Math.PI / smm);
  check('regressors: a fit without them is unchanged (one-parameter formula)', Math.abs(p0.loglike([0.12]) - want) < 1e-9 && p0.nlinear === 1 && prob.nlinear === 3, `|d lnL| ${ex(Math.abs(p0.loglike([0.12]) - want))}; linear parameters 1 and 3`);
  // collinear regressors are rejected, two epochs get their own coefficients
  const bad = buildProblem({ data: { ...data, regressors: [data.regressors[0], data.regressors[0]] }, values, ldLaw: 'quadratic', free: [], exptime: 0, supersample: 1 });
  const ep = Int32Array.from(R.t, (_, i) => (i < 80 ? 0 : 1)), two = buildProblem({ data: { ...data, regressors: [data.regressors[0]], epoch: ep, segments: [{}, {}] }, values, ldLaw: 'quadratic', free: [], exptime: 0, supersample: 1 }).detail([]);
  check('regressors: collinear columns are outside the prior; every epoch has its own coefficients', bad.detail([]) === null && two.regCoeffs.length === 2 && two.regCoeffs[0][0] !== two.regCoeffs[1][0], `epoch slopes ${two.regCoeffs.map((c) => c[0].toFixed(5)).join(', ')}`);
}

// --- 2. readers
{
  const A = ref.rows, cube = S.readX1dints(parseFits(readFileSync(here('./data/spec_x1dints_rows.fits'))));
  let nb = 0; for (const b of cube.bad) nb += b; let sum = 0; for (let i = 0; i < cube.flux.length; i++) if (!cube.bad[i]) sum += cube.flux[i];
  const badOk = A.bad.every(([i, j]) => cube.bad[i * cube.nW + j] === 1);
  check('x1dints, one row per integration: times, wavelengths, fluxes, errors, flags against astropy', cube.nT === A.nT && cube.nW === A.nW && maxAbs(cube.time, A.time) < 1e-9 && maxAbs(cube.wave, A.wave) === 0 && maxAbs(cube.flux.subarray(2 * A.nW, 3 * A.nW), A.flux_row2) === 0 && maxAbs(cube.err.subarray(2 * A.nW, 3 * A.nW), A.err_row2) === 0 && nb === A.n_bad && badOk && Math.abs(sum - A.sum_good) < 1e-12,
    `${cube.nT} x ${cube.nW} (3 NaN-padded columns dropped), time error ${ex(maxAbs(cube.time, A.time))} d, ${nb} flagged (NaN flux and DQ bit 1; DQ = 4 is kept), sum of good fluxes differs by ${ex(Math.abs(sum - A.sum_good))}; layout "${cube.meta.layout}", times from ${cube.meta.timeSource}`);
  const sb = S.readX1dints(parseFits(readFileSync(here('./data/spec_x1dints_rows.fits'))), { column: 'SURF_BRIGHT' });
  check('x1dints: the SURF_BRIGHT column on request', Math.abs(sb.flux[2 * A.nW + 4] / A.flux_row2[4] - 1e3) < 1e-9 && sb.meta.fluxUnit === 'MJy/sr', `unit ${sb.meta.fluxUnit}`);
  const B = ref.exts, f2 = parseFits(readFileSync(here('./data/spec_x1dints_exts.fits')));
  const o1 = S.readX1dints(f2), o2 = S.readX1dints(f2, { order: 2 });
  let w = 0; for (let r = 0; r < B.nT; r++) { w = Math.max(w, maxAbs(o1.flux.subarray(r * B.nW, (r + 1) * B.nW), B.orders['1'].flux[r]), maxAbs(o2.flux.subarray(r * B.nW, (r + 1) * B.nW), B.orders['2'].flux[r])); }
  check('x1dints, one extension per integration: two orders, descending wavelengths, a segment, against astropy', o1.nT === B.nT && o1.nW === B.nW && w === 0 && maxAbs(o1.wave, B.orders['1'].wave) === 0 && maxAbs(o2.wave, B.orders['2'].wave) === 0 && maxAbs(o1.time, B.time) < 1e-9 && o1.meta.intStart === 5 && o1.bad[B.bad_order1[0][0] * B.nW + B.bad_order1[0][1]] === 1,
    `${o1.nT} x ${o1.nW} per order, orders ${o1.meta.orders.join(' and ')}, integrations ${o1.meta.intStart} to ${o1.meta.intEnd} matched to INT_TIMES by number, time error ${ex(maxAbs(o1.time, B.time))} d, flux differences ${w}`);
  let threw = ''; try { S.readX1dints(parseFits(readFileSync(here('./data/syn_small_f32.fits')))); } catch (e) { threw = e.message; }
  check('x1dints: a file without EXTRACT1D is refused in words', /EXTRACT1D/.test(threw), threw);
  const L = ref.long, lc = S.parseSpectralText(readFileSync(here('./data/spec_long.ecsv'), 'utf8'));
  check('text cube, long table written by astropy (ECSV)', lc.nT === 5 && lc.nW === 3 && maxAbs(lc.time, L.time) < 1e-9 && maxAbs(lc.wave, L.wave) === 0 && maxRel(lc.flux, L.flux.flat()) < 1e-12 && maxRel(lc.err, L.err.flat()) < 1e-12, `5 x 3, largest relative difference ${ex(maxRel(lc.flux, L.flux.flat()))}`);
  const back = S.parseSpectralText(S.cubeToCSV(cube.err ? { ...o1 } : o1));
  check('text cube, one row per time: written and read back', back.nT === o1.nT && back.nW === o1.nW && maxRel(back.flux, o1.flux) < 1e-8 && maxRel(back.err, o1.err) < 1e-4 && maxAbs(back.time, o1.time) < 1e-7, `flux ${ex(maxRel(back.flux, o1.flux))}, errors ${ex(maxRel(back.err, o1.err))} (written to 9 and 5 digits)`);
  // segments in time and detectors in wavelength
  const cut = (c, a, b) => ({ ...c, nT: b - a, time: c.time.slice(a, b), flux: c.flux.slice(a * c.nW, b * c.nW), err: c.err.slice(a * c.nW, b * c.nW), bad: c.bad.slice(a * c.nW, b * c.nW) });
  const joined = S.mergeCubes([cut(cube, 12, 24), cut(cube, 0, 14)]);
  const det2 = { ...cube, wave: cube.wave.map((x) => x + 1), meta: { ...cube.meta, detector: 'NRS2' } }, both = S.mergeCubes([det2, cube]);
  let threw2 = ''; try { S.mergeCubes([det2, cut(cube, 0, 20)]); } catch (e) { threw2 = e.message; }
  check('joining: segments in time (overlap kept once), detectors in wavelength, a mismatch refused', joined.nT === cube.nT && maxAbs(joined.flux.filter(Number.isFinite), cube.flux.filter(Number.isFinite)) === 0 && both.nW === 2 * cube.nW && both.part[cube.nW] === 1 && both.meta.detector === 'NRS1+NRS2' && /not parts of one observation/.test(threw2), `${joined.nT} integrations from 12 + 14; ${both.nW} columns from two detectors`);
}

// --- 3. cleaning and binning
{
  const sim = S.simulateSpectroscopy({ system: { rprs: 0.1, ars: 9, inc: 88, per: 3, tmid: 2460000.5 }, star: { teff: 5500, rstar: 1, distance: 100 }, telescope: 'JWST', channels: Array.from({ length: 200 }, (_, j) => ({ lo: 1 + 0.01 * j, hi: 1.01 + 0.01 * j, wl: 1.005 + 0.01 * j })), seed: 5 });
  const c = { ...sim.cube, flux: Float64Array.from(sim.cube.flux), bad: Uint8Array.from(sim.cube.bad) }; delete c.lo; delete c.hi;
  const nW = c.nW, spikes = [[10, 20], [50, 20], [100, 77], [150, 150], [151, 150]];
  for (const [i, j] of spikes) c.flux[i * nW + j] *= 1.05;
  c.flux[30 * nW + 5] = NaN; c.bad[30 * nW + 5] = 1;
  for (let i = 0; i < c.nT; i++) c.flux[i * nW + 120] = -3;                       // a dead column
  for (let i = 0; i < c.nT; i += 3) c.bad[i * nW + 60] = 1;                      // a column with a third of its points flagged
  const cl = S.rejectOutliers(c), fixed = [...spikes, [30, 5]].every(([i, j]) => Math.abs(cl.flux[i * nW + j] / sim.cube.flux[i * nW + j] - 1) < 0.01);
  check('outliers in time: injected spikes and flagged points replaced, bad columns dropped', fixed && cl.replaced >= 6 && cl.replaced < 6 + 0.001 * c.flux.length && !cl.colOk[120] && !cl.colOk[60] && cl.deadColumns === 2 && cl.outlierColumns === 1, `${cl.replaced} of ${c.flux.length} points replaced (6 injected), ${cl.deadColumns} columns dropped (one negative, one with 33% flagged)`);
  const bR = S.makeBins(cl, { mode: 'R', R: 20 }), q = 41 / 39, ratios = bR.slice(0, -1).map((b) => b.hi / b.lo);
  const bW = S.makeBins(cl, { mode: 'width', width: 0.25 }), bN = S.makeBins(cl, { mode: 'n', n: 7 }), bC = S.makeBins(cl, { mode: 'columns', columns: 10 }), bNat = S.makeBins(cl, { mode: 'native' }), bX = S.makeBins(cl, { mode: 'R', R: 20, wlMin: 1.5, wlMax: 2.2 });
  const contiguous = (b) => b.every((x, k) => k === 0 || x.j0 === b[k - 1].j1);
  check('bins: constant R, constant width, N bins, N columns, native, a range', Math.max(...ratios.map((r) => Math.abs(r - q))) < 0.012 && contiguous(bR) && contiguous(bW) && bW.slice(0, -1).every((b) => Math.abs(b.hi - b.lo - 0.25) < 0.011) && bN.length === 7 && bC.length === 20 && bNat.length === 198 && bX[0].lo >= 1.49 && bX[bX.length - 1].hi <= 2.21,
    `R = 20: ${bR.length} bins, hi/lo within ${ex(Math.max(...ratios.map((r) => Math.abs(r - q))))} of (2R+1)/(2R-1) (whole columns); width 0.25: ${bW.length}; native: ${bNat.length} of 200 columns`);
  const ch = S.binCube(cl, bR), wh = S.whiteLight(cl);
  // sum of the bins' unnormalised fluxes is the white light curve; errors add in quadrature
  let w1 = 0, w2 = 0; for (let i = 0; i < cl.nT; i += 7) { let s = 0, v = 0; for (const x of ch) { s += x.flux[i] * x.scale; v += (x.err[i] * x.scale) ** 2; } w1 = Math.max(w1, Math.abs(s / (wh.flux[i] * wh.scale) - 1)); w2 = Math.max(w2, Math.abs(Math.sqrt(v) / (wh.err[i] * wh.scale) - 1)); }
  let direct = 0, dv = 0; for (let j = bR[3].j0; j < bR[3].j1; j++) if (cl.colOk[j]) { direct += cl.flux[40 * nW + j]; dv += cl.err[40 * nW + j] ** 2; }
  check('binning: channels sum to the white light curve, errors in quadrature', w1 < 1e-12 && w2 < 1e-12 && Math.abs(ch[3].flux[40] * ch[3].scale - direct) < 1e-9 * direct && Math.abs(ch[3].err[40] * ch[3].scale - Math.sqrt(dv)) < 1e-9 * Math.sqrt(dv), `flux ${ex(w1)}, error ${ex(w2)} (relative)`);
  const noErr = S.binCube({ ...cl, err: null }, bR)[2], sc = S.pointScatter(noErr.flux);
  check('binning without errors: the point-to-point scatter stands in', noErr.errSource === 'point-to-point scatter' && Math.abs(sc / ch[2].err[0] - 1) < 0.15, `scatter ${ppm(sc)} ppm against a propagated ${ppm(ch[2].err[0])} ppm`);
  const st = S.findStep(wh.time, Float64Array.from(wh.time, (_, i) => (i < 200 ? 0 : -1e-3) + 1e-5 * Math.sin(i)));
  check('findStep: a step of -1000 ppm at point 200', st.index === 200 && Math.abs(st.size + 1e-3) < 2e-5, `index ${st.index}, size ${ppm(st.size)} ppm`);
  const cm = S.applyCommonMode([ch[0]], { time: wh.time, ratio: Float64Array.from(wh.time, () => 1.001), err: wh.err });
  check('common mode: flux divided by the white ratio, the white error added in quadrature', Math.abs(cm[0].flux[9] * 1.001 - ch[0].flux[9]) < 1e-15 && Math.abs(cm[0].err[9] * 1.001 - Math.hypot(ch[0].err[9], ch[0].flux[9] * wh.err[9])) < 1e-18, '');
}

// --- 4. bands, photon rate, simulator noise, scale height, posterior on a grid
{
  const ariel = instrumentChannels('Ariel'), n = (b) => ariel.filter((c) => c.band === b).length;
  check('bands: 8 JWST modes and 6 Ariel channels; Ariel simulation channels', bandsOf('JWST').length === 8 && bandsOf('Ariel').length === 6 && n('Ariel VISPhot') === 1 && n('Ariel FGS1') === 1 && n('Ariel FGS2') === 1 && ariel.every((c, k) => c.hi > c.lo && (k === 0 || c.lo >= ariel[k - 1].hi - 1e-12)) && Math.abs(ariel[ariel.length - 1].hi - 7.8) < 1e-12 && TELESCOPES.Ariel.area === 0.64 && TELESCOPES.JWST.area === 25.4,
    `${ariel.length} channels: 3 photometers, NIRSpec ${n('Ariel NIRSpec')} at R = 15, AIRS-Ch0 ${n('Ariel AIRS-Ch0')} at R = 50, AIRS-Ch1 ${n('Ariel AIRS-Ch1')} at R = 15; 0.5 to 7.8 micron`);
  const star = { teff: 5485, logg: 4.41, feh: 0 }, rows = Object.entries(MISSION_BANDS).map(([name, b]) => { const r = S.channelLimbDarkening(table, star, b.micron[0], b.micron[1], 'quadratic'); return { name, r, b }; });
  const okLd = rows.every(({ r }) => r.coeffs.length === 2 && r.coeffs.every(Number.isFinite) && r.coeffs[0] + r.coeffs[1] > 0 && r.coeffs[0] + r.coeffs[1] < 1);
  const flagged = rows.filter((x) => x.r.extrapolated).map((x) => x.name).sort().join(', ');
  check('bands: limb darkening for every mode from the spectral table; bands beyond 5.5 micron are flagged', okLd && flagged === 'Ariel AIRS-Ch1, JWST MIRI LRS' && rows.find((x) => x.name === 'JWST MIRI LRS').r.band.join() === '5000,5500' && S.channelLimbDarkening(table, star, 6, 7).band.join() === '5300,5500',
    `quadratic u1 + u2 from ${Math.min(...rows.map((x) => x.r.coeffs[0] + x.r.coeffs[1])).toFixed(3)} to ${Math.max(...rows.map((x) => x.r.coeffs[0] + x.r.coeffs[1])).toFixed(3)} (Teff 5485 K); extrapolated: ${flagged} (the part inside the table is used; a channel wholly beyond it uses 5.3-5.5 micron)`);
  const w = Math.max(...ref.photon.map((p) => Math.abs(S.photonRate(p, p.lo, p.hi) / p.rate - 1)));
  check('photon rate of a black-body star against scipy.integrate.quad', w < 1e-8, `largest relative difference ${ex(w)} over 4 stars and bands (Simpson, 400 intervals); e.g. ${S.photonRate(ref.photon[0], 0.5, 0.6).toExponential(4)} photons/s/m2 for 5400 K, 0.9 Rsun, 215 pc in 0.5-0.6 micron`);
  // simulator: the scatter of each channel is the stated formula
  const sys = { rprs: 0.145, ars: 11.4, inc: 87.8, per: 4.0552941, tmid: 2459791.612 }, st2 = { teff: 5400, rstar: 0.9, distance: 215 };
  const sim = S.simulateSpectroscopy({ system: sys, star: st2, telescope: 'Ariel', seed: 11, cadence: 30, excess: 0.2 }), c = sim.cube, d = sim.inputs;
  let wf = 0, ratio = [];
  sim.truth.forEach((tr, j) => {
    const Ne = S.photonRate(st2, tr.lo, tr.hi) * 0.64 * 0.3 * 30, want = Math.sqrt(1.2 ** 2 / Ne + (20e-6) ** 2 * (sim.t14 / (30 / 86400)));
    wf = Math.max(wf, Math.abs(tr.sigma / want - 1));
    const col = Float64Array.from({ length: c.nT }, (_, i) => c.flux[i * c.nW + j] / tr.electrons); ratio.push(S.pointScatter(col) / tr.sigma);
  });
  check('simulator: per-point noise is the documented formula, and the simulated scatter matches it', wf < 1e-12 && Math.abs(mean(ratio) - 1) < 0.03 && d.area_m2 === 0.64 && d.throughput === 0.3 && d.noise_floor_ppm === 20,
    `formula ${ex(wf)}; measured / stated scatter ${mean(ratio).toFixed(3)} +- ${std(ratio).toFixed(3)} over ${c.nW} channels of ${c.nT} points; Ariel 0.64 m2, throughput 0.3, floor 20 ppm, 20% excess: ${ppm(sim.truth[0].sigma)} ppm (VISPhot) to ${ppm(sim.truth[c.nW - 1].sigma)} ppm (7.5 micron) per 30 s for a K = 10.2 star at 215 pc`);
  const jw = S.simulateSpectroscopy({ system: sys, star: st2, telescope: 'JWST', seed: 1 }), ar = S.simulateSpectroscopy({ system: sys, star: st2, telescope: 'Ariel', channels: jw.truth.map((t) => ({ lo: t.lo, hi: t.hi, wl: t.wl })), noiseFloorPpm: 0, seed: 1 }), j0 = S.simulateSpectroscopy({ system: sys, star: st2, telescope: 'JWST', noiseFloorPpm: 0, seed: 1 });
  check('simulator: JWST settings; photon noise scales as 1 / sqrt(area)', jw.inputs.area_m2 === 25.4 && Math.abs(ar.truth[5].sigma / j0.truth[5].sigma - Math.sqrt(25.4 / 0.64)) < 1e-9, `${jw.cube.nW} channels of NIRSpec PRISM at R = 50; Ariel / JWST noise ratio ${(ar.truth[5].sigma / j0.truth[5].sigma).toFixed(3)} = sqrt(25.4 / 0.64)`);
  const H = ref.scale_height, sh = S.scaleHeight(H), n1 = S.toScaleHeights([{ depth: 0.021, err: 1e-4 }, { depth: 0.021 + 3 * H.depth_per_H, err: 1e-4 }], { H: sh.H, rplanet: H.rplanet, rstar: H.rstar });
  check('scale height H = kT / (mu g) and depth per scale height against astropy constants', Math.abs(sh.H / H.H - 1) < 2e-4 && Math.abs(sh.g / H.g - 1) < 2e-4 && Math.abs(n1.depthPerH / H.depth_per_H - 1) < 2e-3 && Math.abs(n1.span - 3) < 0.01,
    `H = ${(sh.H / 1000).toFixed(1)} km (reference ${(H.H / 1000).toFixed(1)}), g = ${sh.g.toFixed(3)} m/s2, ${ppm(n1.depthPerH)} ppm of depth per scale height for WASP-39 b at 1100 K, mu = 2.3; relative differences ${ex(Math.abs(sh.H / H.H - 1))}, ${ex(Math.abs(n1.depthPerH / H.depth_per_H - 1))} (nominal radii)`);
  // posterior1D: a Gaussian likelihood truncated by the prior, against the closed form
  const g = S.posterior1D((x) => -0.5 * ((x - 0.3) / 0.01) ** 2, 0, 1), g2 = S.posterior1D((x) => -0.5 * ((x - 0.005) / 0.01) ** 2, 0, 1);
  // truncated at 0: median of N(0.005, 0.01) restricted to x > 0
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2)), p0 = Phi(-0.5), invMed = quant(p0 + 0.5 * (1 - p0)) * 0.01 + 0.005;
  check('posterior on a grid: Gaussian (median, 16th and 84th percentiles, evidence), and one truncated at the prior edge', Math.abs(g.median - 0.3) < 1e-6 && Math.abs(g.hi - g.median - 0.01) < 2e-6 && Math.abs(g.median - g.lo - 0.01) < 2e-6 && Math.abs(g.lnZ - Math.log(0.01 * Math.sqrt(2 * Math.PI))) < 1e-5 && Math.abs(g2.median - invMed) < 2e-5,
    `median error ${ex(Math.abs(g.median - 0.3))}, width errors ${ex(Math.abs(g.hi - g.median - 0.01))}, ln Z error ${ex(Math.abs(g.lnZ - Math.log(0.01 * Math.sqrt(2 * Math.PI))))}; truncated median ${g2.median.toFixed(6)} against ${invMed.toFixed(6)}`);
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function quant(p) { let a = -8, b = 8; for (let i = 0; i < 80; i++) { const m = 0.5 * (a + b); if (0.5 * (1 + erf(m / Math.SQRT2)) < p) a = m; else b = m; } return 0.5 * (a + b); }

// --- 5. injection and recovery: channel light curves made with batman
let injection = null;
{
  const I = ref.injection, geo = { rprs: 0.145, ars: I.geometry.ars, inc: I.geometry.inc, per: I.geometry.per, tmid: I.geometry.tmid, ecc: 0, omega: 0 };
  const cube = S.rejectOutliers(S.parseSpectralText(readFileSync(here('./data/spec_batman_cube.csv'), 'utf8')));
  cube.exptime = I.cadence_s / 86400;
  const ch = S.binCube(cube, S.makeBins(cube, { mode: 'native' })), k = I.clean_channel;
  // this code's model for one channel against batman's (both averaged over the 60 s exposure)
  const tp = { rprs: Math.sqrt(I.depth[k]), ars: geo.ars, inc: geo.inc, per: geo.per, tmid: geo.tmid - 2459791, ecc: 0, omega: 0, ldLaw: 'quadratic', ld: [I.u1[k], I.u2[k]] }, tt = Float64Array.from(cube.time, (t) => t - 2459791);
  const m = transitModel(tt, tp), mx = transitModel(tt, tp, null, { exptime: cube.exptime, supersample: 7 });
  check('one channel of the injection: this model against batman', maxAbs(m, I.clean_instant) < 1e-6 && maxAbs(mx, I.clean) < 6e-6, `largest difference ${(1e6 * maxAbs(m, I.clean_instant)).toFixed(3)} ppm over ${m.length} points (depth ${ppm(I.depth[k])} ppm); averaged over the 60 s exposure with 7 sub-samples ${(1e6 * maxAbs(mx, I.clean)).toFixed(2)} ppm, because batman spaces its sub-samples from end to end of the exposure and this code puts them at the middles of 7 equal parts`);
  const ldFor = (c) => { let j = 0; I.wl.forEach((w, q) => { if (Math.abs(w - c.wl) < Math.abs(I.wl[j] - c.wl)) j = q; }); return { law: 'quadratic', coeffs: [I.u1[j], I.u2[j]] }; };
  const tA = performance.now(), resTrue = await S.fitChannels(ch, { ...geo }, { ldFor, baseline: 'linear', errorMode: 'pipeline' }), dtA = performance.now() - tA;
  const qT = pullStats(resTrue, I.depth);
  check('injection (batman), geometry fixed at the truth: pulls of the recovered depths', Math.abs(qT.mean) < 0.45 && qT.std > 0.7 && qT.std < 1.35, `${pullText(qT)}; expected mean 0 +- ${(1 / Math.sqrt(qT.n)).toFixed(2)}, std 1 +- ${(1 / Math.sqrt(2 * qT.n)).toFixed(2)}; 36 channels 0.6-5 micron, slope and two Gaussian features injected; ${(dtA / 36).toFixed(0)} ms per channel`);
  const white = S.whiteLight(cube);
  const wf = await S.fitWhiteLight(white, geo, { ld: I.white_u, ldLaw: 'quadratic', baseline: 'linear', errorMode: 'pipeline' });
  const par = Object.fromEntries(wf.parameters.map((p) => [p.key, p]));
  check('injection: white-light fit recovers the mid-time and the inclination', Math.abs(par.tmid.median - geo.tmid) < 4 * par.tmid.plus && Math.abs(par.inc.median - geo.inc) < 4 * par.inc.plus && wf.converged, `T mid ${(86400 * (par.tmid.median - geo.tmid)).toFixed(1)} +- ${(86400 * par.tmid.plus).toFixed(1)} s from the truth, i = ${par.inc.median.toFixed(3)} +${par.inc.plus.toFixed(3)} -${par.inc.minus.toFixed(3)} (true ${geo.inc}), white depth ${ppm(wf.depth.median)} +- ${ppm(wf.depth.plus)} ppm, residual rms ${ppm(wf.stats.rms)} ppm (${wf.stats.ratio.toFixed(2)} x the error bars), ${wf.ncalls} likelihood calls`);
  const res = await S.fitChannels(ch, wf.values, { ldFor, baseline: 'linear', errorMode: 'pipeline', keep: true }), q = pullStats(res, I.depth);
  check('injection (batman), geometry from the white-light fit: pulls of the recovered depths', Math.abs(q.mean) < 0.6 && q.std > 0.7 && q.std < 1.35, `${pullText(q)}; the inclination of the white fit is shared, so its error moves all channels together (mean pull) and is not in the per-channel error bars`);
  const rr = res.map((r) => r.ratio), bb = res.map((r) => r.beta);
  check('injection: residual rms against the error bars, and the time-averaging test', Math.abs(mean(rr) - 1) < 0.03 && mean(bb) < 1.6, `rms / expected ${mean(rr).toFixed(3)} +- ${std(rr).toFixed(3)}; beta ${mean(bb).toFixed(2)} on average, largest ${Math.max(...bb).toFixed(2)} (white noise: beta is the maximum over bin sizes, so above 1)`);
  // the nested-sampling path (limb darkening free with a prior) agrees with the grid
  const tN = performance.now(), nres = [];
  for (const j of [5, 28]) nres.push(await S.fitChannel(ch[j], wf.values, { ldLaw: 'quadratic', ld: ldFor(ch[j]).coeffs, ldSigma: 0.05, baseline: 'linear', errorMode: 'pipeline', sampler: { nlive: 200, fracRemain: 0.02, seed: 3, maxCalls: 200000 } }));
  const dN = [5, 28].map((j, i) => (nres[i].depth - res[j].depth) / res[j].depthPlus), wN = [5, 28].map((j, i) => nres[i].depthPlus / res[j].depthPlus);
  check('per-channel limb darkening with a prior (nested sampling) against the fixed case (grid)', nres.every((r) => r.method === 'nested') && res[5].method === 'grid' && Math.max(...dN.map(Math.abs)) < 1.5 && wN.every((x) => x > 0.9 && x < 2.5), `depth shifts ${dN.map((x) => x.toFixed(2)).join(', ')} sigma, error bars ${wN.map((x) => x.toFixed(2)).join(', ')} times wider with u1, u2 ~ N(table, 0.05); ${((performance.now() - tN) / 2000).toFixed(1)} s per channel`);
  injection = { res, wf, white, ch, I };
}

// --- 6. injection and recovery with the simulator: Ariel channels, several noise realisations; JWST; an eclipse
{
  const star = { teff: 5400, rstar: 0.9, distance: 215, logg: 4.5, feh: 0 }, sys = { rprs: 0.145, ars: 11.4, inc: 87.8, per: 4.0552941, tmid: 2459791.612, ecc: 0, omega: 0 };
  const ldFor = (lo, hi) => { const r = S.channelLimbDarkening(table, star, lo, hi, 'quadratic'); return { law: 'quadratic', coeffs: r.coeffs }; };
  const depth = { depth0: 0.021, slope: -3e-4, features: [{ wl: 4.3, sigma: 0.25, amp: 1.5e-3 }, { wl: 1.4, sigma: 0.1, amp: 5e-4 }] };
  const all = [], allT = []; let n = 0, errs = [];
  for (const seed of [1, 2, 3, 4]) {
    const sim = S.simulateSpectroscopy({ system: sys, star, telescope: 'Ariel', depth, ldFor, seed, slopePpmPerHr: 30 }), cube = S.rejectOutliers(sim.cube);
    const ch = S.binCube(cube, S.makeBins(cube, { mode: 'native' })), white = S.whiteLight(cube), wld = S.channelLimbDarkening(table, star, white.lo, white.hi, 'quadratic');
    const wf = await S.fitWhiteLight(white, sys, { ld: wld.coeffs, errorMode: 'pipeline', sampler: { nlive: 250, fracRemain: 0.02, seed: 40 + seed, maxCalls: 400000 } });
    const res = await S.fitChannels(ch, wf.values, { ldFor: (c) => ldFor(c.lo, c.hi), errorMode: 'pipeline' });
    res.forEach((r, i) => { all.push(r); allT.push(sim.truth[i].depth); errs.push(r.depthPlus); }); n = sim.cube.nW;
  }
  const q = pullStats(all, allT);
  check('injection (Ariel simulation, 4 noise realisations): pulls of the recovered depths', Math.abs(q.mean) < 0.25 && Math.abs(q.std - 1) < 0.15 && Math.abs(q.c1 - 0.683) < 0.09 && q.c2 > 0.9,
    `${pullText(q)}; expected 68% and 95%; ${n} channels each, geometry from each white-light fit, limb darkening per channel from the PHOENIX table, baseline slope 30 ppm/h injected and fitted; depth errors ${ppm(Math.min(...errs))} to ${ppm(Math.max(...errs))} ppm for one transit of a WASP-39-like system`);
  const simJ = S.simulateSpectroscopy({ system: sys, star, telescope: 'JWST', depth, ldFor, seed: 9 }), cj = S.rejectOutliers(simJ.cube), chJ = S.binCube(cj, S.makeBins(cj, { mode: 'native' }));
  const wJ = S.whiteLight(cj), wfJ = await S.fitWhiteLight(wJ, sys, { ld: S.channelLimbDarkening(table, star, wJ.lo, wJ.hi, 'quadratic').coeffs, errorMode: 'pipeline' });
  const rJ = await S.fitChannels(chJ, wfJ.values, { ldFor: (c) => ldFor(c.lo, c.hi), errorMode: 'pipeline' }), qJ = pullStats(rJ, simJ.truth.map((t) => t.depth));
  check('injection (JWST-like settings, NIRSpec PRISM range at R = 50): pulls', Math.abs(qJ.mean) < 0.5 && qJ.std > 0.75 && qJ.std < 1.3, `${pullText(qJ)}; depth errors ${ppm(Math.min(...rJ.map((r) => r.depthPlus)))} to ${ppm(Math.max(...rJ.map((r) => r.depthPlus)))} ppm`);
  // emission: an eclipse with Fp/F* rising with wavelength
  const sysE = { ...sys, rprs: 0.12, ars: 5, inc: 86, per: 1.5, fpfs: 0.05 }, dE = (wl) => 2e-4 * wl;
  const simE = S.simulateSpectroscopy({ system: sysE, star: { ...star, distance: 60 }, telescope: 'JWST', kind: 'eclipse', depth: dE, bands: ['JWST NIRSpec G395H'], simR: { 'JWST NIRSpec G395H': 30 }, seed: 4 });
  const cE = S.rejectOutliers(simE.cube), chE = S.binCube(cE, S.makeBins(cE, { mode: 'native' })), wE = S.whiteLight(cE);
  const wfE = await S.fitWhiteLight(wE, sysE, { kind: 'eclipse', ldLaw: 'quadratic', ld: [0.1, 0.1], errorMode: 'pipeline' });
  const rE = await S.fitChannels(chE, { ...sysE, tmid: wfE.values.tmid }, { kind: 'eclipse', ldLaw: 'quadratic', ld: [0.1, 0.1], errorMode: 'pipeline' }), qE = pullStats(rE, simE.truth.map((t) => t.depth));
  const wantE = simE.truth.reduce((a, t) => a + t.electrons * t.depth, 0) / simE.truth.reduce((a, t) => a + t.electrons, 0);
  check('emission spectrum: eclipse depths Fp/F* (Rp/R*)^2 recovered', Math.abs(qE.mean) < 0.7 && qE.std > 0.5 && qE.std < 1.6 && Math.abs(wfE.depth.median - wantE) < 4 * wfE.depth.plus, `${pullText(qE)}; white eclipse depth ${ppm(wfE.depth.median)} +- ${ppm(wfE.depth.plus)} ppm (photon-weighted mean of the injected depths ${ppm(wantE)}), channel errors about ${ppm(mean(rE.map((r) => r.depthPlus)))} ppm`);
}

// --- 7. products: ECSV / CSV, session
{
  const rows = [0, 1, 2, 3].map((k) => ({ wl: 1 + 0.5 * k, lo: 0.75 + 0.5 * k, hi: 1.25 + 0.5 * k, depth: 0.021 + 1e-4 * k, plus: 5.1e-5 + 1e-6 * k, minus: 4.9e-5, rms: 3e-4, expected: 2.9e-4, beta: k === 2 ? NaN : 1.1 + 0.1 * k }));
  const text = S.spectrumToECSV(rows, { target: 'WASP-39 b', kind: 'transit', channels: 4, note: "it's a test" }), E = ref.ecsv;
  check('spectrum as ECSV: the text astropy read (columns, units, metadata, a NaN)', text === E.text && E.columns.length === 9 && E.units.wavelength === 'um' && maxAbs(E.depth, rows.map((r) => r.depth)) < 1e-12 && E.beta_nan_row === 2 && E.meta.target === 'WASP-39 b' && E.meta.note === "it's a test" && E.meta.channels === 4, `astropy.table.Table.read(format='ascii.ecsv'): ${E.columns.length} columns, wavelength in ${E.units.wavelength}, meta ${Object.keys(E.meta).join(', ')}`);
  const csv = S.spectrumToCSV(rows, { target: 'WASP-39 b' }).trim().split('\n');
  check('spectrum as CSV: comment lines, a header with units, one row per channel', csv[0] === '# software: Exoplanet Science Lab' && csv[2].startsWith('wavelength_um,') && csv.length === 3 + 4 && csv[3].split(',').length === 9, csv[2]);
  const { res, wf, white, ch, I } = injection, spectrum = S.spectrumTable(res);
  const st = { name: 'injection', star: { teff: 5400, logg: 4.5, feh: 0, rstar: 0.9, mstar: 0.9 }, system: wf.values, kind: 'transit', ldLaw: 'quadratic', whiteLd: I.white_u, white, channels: ch, bins: { mode: 'native' }, settings: { baseline: 'linear' }, whiteFit: wf, spectrum, source: { kind: 'text', files: ['spec_batman_cube.csv'] } };
  const doc = JSON.parse(JSON.stringify(S.spectroscopyToSession(st)));
  let valid = true, lnL = NaN; try { validateSession(doc); const spec = specFromSession(doc); const p = buildProblem(spec); lnL = p.loglike(spec.free.map((f) => doc.planets[0].parameters[f.key] - (f.key === 'tmid' ? doc.time_reference : 0))); } catch (e) { valid = false; console.log(e); }
  const back = S.spectroscopyFromSession(doc);
  check('session: a valid ESL session that buildProblem accepts, and the spectroscopy block restores the state', valid && lnL > 0 && back.channels.length === ch.length && maxRel(back.channels[7].flux, ch[7].flux) < 1e-8 && maxAbs(back.white.time, white.time) < 1e-7 && back.spectrum.length === spectrum.length && back.spectrum[3].depth === spectrum[3].depth && back.whiteFitSummary.values.inc === wf.values.inc && back.kind === 'transit' && doc.spectroscopy.white_light.detrended_in_session === true,
    `ln L of the session's (detrended) white light curve at the fitted parameters ${lnL.toFixed(1)}; ${back.channels.length} channels, ${(JSON.stringify(doc).length / 1024).toFixed(0)} kB`);
  let threw = ''; try { S.spectroscopyFromSession({ format: 'esl-session', version: 1 }); } catch (e) { threw = e.message; }
  check('session: a plain session is refused in words', /spectroscopy/.test(threw), threw);
}

// --- 8. real data: WASP-39 b, JWST NIRSpec G395H (ERS 1366), when the files are in test/data/jwst
{
  const dir = here('./data/jwst/'), names = ['nrs1', 'nrs2'].flatMap((d) => [1, 2, 3].map((s) => `jw01366003001_04101_00001-seg00${s}_${d}_x1dints.fits`));
  if (!names.every((n) => existsSync(dir + n))) skip('WASP-39 b G395H (real JWST data)', 'the six x1dints files (207 MB) are not in test/data/jwst; the URLs are at the top of test/make_spectroscopy_reference.py');
  else {
    const J = JSON.parse(readFileSync(here('./spectroscopy_jwst_reference.json'))), pub = JSON.parse(readFileSync(here('./spectroscopy_wasp39_published.json')));
    const t0 = performance.now(), cubes = names.map((n) => S.readX1dints(parseFits(readFileSync(dir + n))));
    let w = 0, nbOk = true;
    names.forEach((n, k) => { const c = cubes[k], r = J[n]; let nb = 0; for (const b of c.bad) nb += b; let s = 0; for (let j = 0; j < c.nW; j++) if (!c.bad[100 * c.nW + j]) s += c.flux[100 * c.nW + j];
      w = Math.max(w, Math.abs(c.time[0] - r.time_first), Math.abs(c.time[c.nT - 1] - r.time_last), Math.abs(c.wave[0] - r.wave_first), Math.abs(c.wave[c.nW - 1] - r.wave_last), Math.abs(c.flux[100 * c.nW + 600] - r.flux_100_600), Math.abs(c.err[100 * c.nW + 600] - r.err_100_600), Math.abs(s / r.sum_good_row100 - 1));
      if (nb !== r.n_bad || c.nT !== r.nrows || c.nW !== r.nwave || c.meta.intStart !== r.int_num[0] || c.meta.intEnd !== r.int_num[1]) nbOk = false; });
    check('real x1dints (WASP-39 b, G395H, 6 files): times, wavelengths, fluxes, flags against astropy', w < 1e-9 && nbOk, `largest difference ${ex(w)}; pipeline ${cubes[0].meta.calVersion}, layout "${cubes[0].meta.layout}", ${cubes[0].meta.integrationSeconds} s integrations, read in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const cube = S.rejectOutliers(S.mergeCubes(cubes));
    check('real data joined: 465 integrations, two detectors', cube.nT === 465 && cube.nW === 1272 + 2048 && cube.meta.detector === 'NRS1+NRS2', `${cube.nT} x ${cube.nW}, ${cube.wave[0].toFixed(3)} to ${cube.wave[cube.nW - 1].toFixed(3)} micron; ${cube.replaced} points replaced, ${cube.deadColumns} columns dropped (${cube.outlierColumns} by the spectral test)`);
    // WASP-39: Mancini et al. 2018 (A&A 613, A41): M* 0.913, R* 0.939, Teff 5485, log g 4.41, [Fe/H] 0.01; P from the same
    const star = { teff: 5485, logg: 4.41, feh: 0.01 }, sys = { rprs: 0.1457, inc: 87.5, per: 4.0552941, tmid: 2455342.96913, ecc: 0, omega: 0, mstar: 0.913, rstar: 0.939, mplanet: 0.281 };
    const white = S.whiteLight(cube), wld = S.channelLimbDarkening(table, star, white.lo, white.hi, 'quadratic');
    const free = [...S.defaultWhiteFree(white, sys).free, { key: 'rstar', prior: { type: 'normal', a: 0.939, b: 0.022 } }];
    const first = await S.fitWhiteLight(white, sys, { ld: wld.coeffs, kepler: true, free, baseline: 'linear' }), step = S.findStep(white.time, first.resid);
    check('real data: the mirror tilt event is found as a step in the white-light residuals', step.index === 270 && step.significance > 20, `after integration ${step.index} (BJD ${step.time.toFixed(5)}), ${ppm(step.size)} ppm, ${step.significance.toFixed(0)} sigma; residual rms without a step ${ppm(first.stats.rms)} ppm (Alderson et al. 2023 report the tilt event near integration 269)`);
    const wf = await S.fitWhiteLight(white, sys, { ld: wld.coeffs, kepler: true, free, baseline: 'linear', steps: [step.time] }), par = Object.fromEntries(wf.parameters.map((p) => [p.key, p]));
    check('real data: white-light fit with a slope and a step', wf.converged && wf.stats.rms < 3e-4 && Math.abs(par.rprs.median - 0.1457) < 0.002, `Rp/R* = ${par.rprs.median.toFixed(5)} +- ${par.rprs.plus.toFixed(5)}, T mid = ${par.tmid.median.toFixed(6)} +- ${par.tmid.plus.toFixed(6)} BJD_TDB, i = ${par.inc.median.toFixed(3)} +- ${par.inc.plus.toFixed(3)}, a/R* = ${wf.values.ars.toFixed(3)} (Kepler, R* = ${par.rstar.median.toFixed(4)} +- ${par.rstar.plus.toFixed(4)} with prior 0.939 +- 0.022), depth ${ppm(wf.depth.median)} +- ${ppm(wf.depth.plus)} ppm; residual rms ${ppm(wf.stats.rms)} ppm = ${wf.stats.ratio.toFixed(2)} x the error bars (scaled by ${wf.errScale.toFixed(2)}), beta ${wf.stats.beta.toFixed(2)}`);
    const bins = S.makeBins(cube, { mode: 'R', R: 100 }), ch = S.binCube(cube, bins), t1 = performance.now();
    const res = await S.fitChannels(ch, wf.values, { ldFor: (c) => { const r = S.channelLimbDarkening(table, star, c.lo, c.hi, 'quadratic'); return { law: 'quadratic', coeffs: r.coeffs }; }, baseline: 'linear', steps: [step.time] });
    const sp = S.spectrumTable(res);
    // the published 10-pixel spectrum averaged into these bins (inverse-variance weights)
    const cmp = sp.map((r) => { let sw = 0, s = 0, n = 0; pub.wavelength_um.forEach((wl, k) => { if (wl >= r.lo && wl < r.hi) { const wt = 1 / pub.depth_err[k] ** 2; sw += wt; s += wt * pub.depth[k]; n++; } }); return n ? { wl: r.wl, mine: r.depth, err: r.err, pub: s / sw, pubErr: Math.sqrt(1 / sw), n } : null; }).filter(Boolean);
    const diff = cmp.map((c) => c.mine - c.pub), z = cmp.map((c) => (c.mine - c.pub) / Math.hypot(c.err, c.pubErr)), off = mean(diff);
    const corr = (() => { const a = cmp.map((c) => c.mine), b = cmp.map((c) => c.pub), ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; a.forEach((x, i) => { sab += (x - ma) * (b[i] - mb); saa += (x - ma) ** 2; sbb += (b[i] - mb) ** 2; }); return sab / Math.sqrt(saa * sbb); })();
    check('real data: transmission spectrum against the published one (Alderson et al. 2023, weighted-average reduction)', Math.abs(off) < 4e-4 && std(diff) < 4e-4 && corr > 0.8,
      `${cmp.length} channels at R = 100 (${((performance.now() - t1) / res.length).toFixed(0)} ms each): mean difference ${ppm(off)} ppm, scatter of the differences ${ppm(std(diff))} ppm (rms ${std(z).toFixed(2)} in units of the combined errors, mean ${mean(z).toFixed(2)}), correlation ${corr.toFixed(3)}; my errors ${ppm(Math.min(...sp.map((r) => r.err)))} to ${ppm(Math.max(...sp.map((r) => r.err)))} ppm; residual rms / error bars ${mean(res.map((r) => r.ratio)).toFixed(2)}, error scale ${mean(res.map((r) => r.errScale)).toFixed(2)}, beta ${mean(res.map((r) => r.beta)).toFixed(2)} on average`);
    for (const target of [3.0, 3.4, 4.05, 4.3, 4.45, 4.9]) { const c = cmp.reduce((a, b) => (Math.abs(b.wl - target) < Math.abs(a.wl - target) ? b : a)); console.log(`       ${c.wl.toFixed(3)} micron   this code ${ppm(c.mine)} +- ${ppm(c.err)} ppm   published ${ppm(c.pub)} +- ${ppm(c.pubErr)} ppm (${c.n} bins)   difference ${ppm(c.mine - c.pub)} ppm`); }
    const peak = cmp.reduce((a, b) => (b.mine > a.mine ? b : a)), peakPub = cmp.reduce((a, b) => (b.pub > a.pub ? b : a)), lowM = mean(cmp.filter((c) => c.wl > 3.0 && c.wl < 3.6).map((c) => c.mine)), lowP = mean(cmp.filter((c) => c.wl > 3.0 && c.wl < 3.6).map((c) => c.pub));
    check('real data: the CO2 band at 4.3 micron stands out as published', Math.abs(peak.wl - peakPub.wl) < 0.12 && Math.abs((peak.mine - lowM) / (peakPub.pub - lowP) - 1) < 0.25, `largest depth at ${peak.wl.toFixed(2)} micron (published ${peakPub.wl.toFixed(2)}); it rises ${ppm(peak.mine - lowM)} ppm above the 3.0-3.6 micron mean (published ${ppm(peakPub.pub - lowP)} ppm)`);
  }
}

console.log(`total ${((performance.now() - T0) / 1000).toFixed(1)} s`);
process.exit(ok ? 0 : 1);
