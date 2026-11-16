// Time-series spectroscopy: spectra per integration in, a transmission or emission spectrum out. No DOM.
//
//   read      readX1dints(fits)        JWST Stage 2/3 `x1dints.fits` (both layouts, see below)
//             parseSpectralText(text)  a plain "time x wavelength" table (CSV / ECSV / whitespace)
//             mergeCubes([cube...])    segments in time, detectors in wavelength
//   prepare   rejectOutliers, makeBins, binCube, whiteLight, applyCommonMode
//   fit       fitWhiteLight (shared geometry, nested sampling) and fitChannel (depth per channel), both
//             through buildProblem of model.js: the same likelihood as every other fit on the site
//   products  spectrumTable, spectrumToECSV / spectrumToCSV, scaleHeight, toScaleHeights
//   simulate  simulateSpectroscopy: Ariel- or JWST-like channels with a simple radiometric noise estimate
//   session   spectroscopyToSession / spectroscopyFromSession (docs/FORMAT.md, "Spectroscopy")
//
// A cube is { time (BJD_TDB, absolute, one per integration), wave (micron, ascending, one per column),
//             flux, err (Float64Array nT * nW, integration-major; err may be null), bad (Uint8Array, 1 = unusable),
//             lo, hi (optional column edges in micron: simulated channels), exptime (days), meta }.
// A light curve here is { time (absolute), flux, err, exptime (days) } with flux normalised to a median of 1.
//
// Not read: HST/WFC3 spatial scans and other 2-D spectral images (`spec2d`, `calints`, `rateints`): there is
// no spectral extraction here. Start from extracted 1-D spectra.

import { readBinTable } from './fits.js';
import { buildProblem, autoSupersample } from './model.js';
import { runFit } from './fitRunner.js';
import { makeTransit } from './transit.js';
import { makeEclipse } from './phasecurve.js';
import { derived } from './kepler.js';
import { arsFromKepler } from './rv.js';
import { LD_LAWS } from './limbdark.js';
import { bandCoefficients } from './ldspec.js';
import { weightedQuantiles, makeRng } from './stats.js';
import { rmsVsBin } from './psd.js';
import { C } from './derive.js';
import { TELESCOPES, instrumentChannels, LD_TABLE_MAX_NM } from './missionbands.js';

const MJD0 = 2400000.5;
const median = (a) => { const b = Float64Array.from(a).filter(Number.isFinite).sort(); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : 0.5 * (b[n / 2 - 1] + b[n / 2])) : NaN; };
const str = (x) => (typeof x === 'string' ? x.trim() : x ?? null);

// =================================================================================================
// Readers

/**
 * A JWST time-series `x1dints` product (parseFits / openFits output) as a cube.
 *
 * Two layouts exist. Pipeline versions up to 1.16 wrote one EXTRACT1D extension per integration (and per
 * spectral order), each a table with one row per wavelength. Later versions (the files MAST serves after
 * reprocessing, CAL_VER 1.17 and above) write one EXTRACT1D extension per order with one row per integration and
 * vector columns (`1272D`), plus INT_NUM and TDB-MID per row. Both are read.
 *
 * Times: TDB-MID of each row when present, else `int_mid_BJD_TDB` of the INT_TIMES extension matched by integration
 * number (by position when the numbers are absent). Both are stored by the pipeline as BJD_TDB - 2400000.5.
 * opts: { order (SPORDER to take when several are present, default the first), column ('FLUX' | 'SURF_BRIGHT') }
 * Points with a non-finite flux or the DO_NOT_USE bit (1) of DQ are flagged in `bad`.
 */
export function readX1dints(fits, opts = {}) {
  const P = fits.hdus[0].header, ext = fits.hdus.filter((h) => h.type === 'bintable' && h.name === 'EXTRACT1D');
  if (!ext.length) throw new Error('No EXTRACT1D extension: this is not a JWST x1d / x1dints product.');
  const orders = [...new Set(ext.map((h) => h.header.SPORDER).filter((o) => o !== undefined))];
  const order = opts.order ?? orders[0], mine = orders.length > 1 ? ext.filter((h) => h.header.SPORDER === order) : ext;
  if (!mine.length) throw new Error(`No EXTRACT1D extension for spectral order ${order} (the file has ${orders.join(', ')}).`);
  const fcol = (opts.column || 'FLUX').toUpperCase(), ecol = fcol === 'SURF_BRIGHT' ? 'SB_ERROR' : 'FLUX_ERROR';
  // INT_TIMES
  const it = fits.hdus.find((h) => h.type === 'bintable' && h.name === 'INT_TIMES');
  let itNum = null, itMid = null;
  if (it) { const T = readBinTable(fits, it.index); itNum = T.column('integration_number'); itMid = T.column('int_mid_BJD_TDB'); if (!itMid || !itMid.length) itMid = null; }
  const tab0 = readBinTable(fits, mine[0].index), wcol = tab0.col('WAVELENGTH');
  if (!wcol || !tab0.col(fcol)) throw new Error(`The EXTRACT1D table has no WAVELENGTH / ${fcol} column.`);
  const vector = wcol.repeat > 1 || mine.length === 1 && tab0.col('INT_NUM');
  let nT, nW, wave, flux, err, dq, time, intNum, layout, waveSpread = 0;
  if (vector) {
    layout = 'row per integration';
    // several extensions of this layout are segments or slits; rows are appended
    const parts = mine.map((h) => readBinTable(fits, h.index));
    nW = wcol.repeat; nT = parts.reduce((a, t) => a + t.nrows, 0);
    flux = new Float64Array(nT * nW); err = new Float64Array(nT * nW); dq = new Uint8Array(nT * nW); time = new Float64Array(nT).fill(NaN); intNum = new Int32Array(nT);
    const w0 = Float64Array.from(tab0.column('WAVELENGTH', [0, 1]));
    let r0 = 0, haveErr = false;
    for (const t of parts) {
      if (t.col('WAVELENGTH').repeat !== nW) throw new Error('EXTRACT1D extensions with different numbers of wavelengths.');
      const W = t.column('WAVELENGTH'), F = t.column(fcol), E = t.column(ecol), D = t.column('DQ'), num = t.column('INT_NUM'), tdb = t.column('TDB-MID');
      for (let r = 0; r < t.nrows; r++) {
        const o = (r0 + r) * nW;
        for (let j = 0; j < nW; j++) {
          flux[o + j] = F[r * nW + j]; if (E) { err[o + j] = E[r * nW + j]; if (E[r * nW + j] > 0) haveErr = true; }
          if (D && (D[r * nW + j] % 2) >= 1) dq[o + j] = 1;
          const dw = Math.abs(W[r * nW + j] - w0[j]); if (dw > waveSpread) waveSpread = dw;
        }
        intNum[r0 + r] = num ? num[r] : r0 + r + 1;
        if (tdb && Number.isFinite(tdb[r]) && tdb[r] > 0) time[r0 + r] = tdb[r] + MJD0;
      }
      r0 += t.nrows;
    }
    if (!haveErr) err = null;
    wave = w0;
  } else {
    layout = 'extension per integration';
    nT = mine.length; nW = tab0.nrows; wave = Float64Array.from(tab0.column('WAVELENGTH'));
    flux = new Float64Array(nT * nW); err = new Float64Array(nT * nW); dq = new Uint8Array(nT * nW); time = new Float64Array(nT).fill(NaN); intNum = new Int32Array(nT);
    let haveErr = false;
    mine.forEach((h, r) => {
      const t = r ? readBinTable(fits, h.index) : tab0;
      if (t.nrows !== nW) throw new Error(`Integration ${r + 1} has ${t.nrows} wavelengths, the first has ${nW}.`);
      const W = t.column('WAVELENGTH'), F = t.column(fcol), E = t.column(ecol), D = t.column('DQ'), o = r * nW;
      for (let j = 0; j < nW; j++) {
        flux[o + j] = F[j]; if (E) { err[o + j] = E[j]; if (E[j] > 0) haveErr = true; }
        if (D && (D[j] % 2) >= 1) dq[o + j] = 1;
        const dw = Math.abs(W[j] - wave[j]); if (dw > waveSpread) waveSpread = dw;
      }
      intNum[r] = typeof h.header.INT_NUM === 'number' ? h.header.INT_NUM : (P.INTSTART || 1) + r;
    });
    if (!haveErr) err = null;
  }
  // times from INT_TIMES where the rows did not carry them
  let timeSource = 'TDB-MID column';
  if (!time.every(Number.isFinite)) {
    if (!itMid) throw new Error('No integration times: the file has neither TDB-MID per row nor an INT_TIMES extension.');
    timeSource = 'INT_TIMES int_mid_BJD_TDB';
    const byNum = new Map(); if (itNum) for (let i = 0; i < itNum.length; i++) byNum.set(itNum[i], itMid[i]);
    const matched = itNum && Array.from(intNum).every((n) => byNum.has(n));
    if (!matched && itMid.length !== nT) throw new Error(`INT_TIMES has ${itMid.length} rows for ${nT} integrations and the integration numbers do not match.`);
    for (let r = 0; r < nT; r++) time[r] = (matched ? byNum.get(intNum[r]) : itMid[r]) + MJD0;
    if (!matched) timeSource += ' (by position)';
  }
  const cube = finishCube({ time, wave, flux, err, bad: dq, nT, nW });
  cube.exptime = (typeof P.EFFINTTM === 'number' ? P.EFFINTTM : 0) / 86400;
  cube.meta = {
    source: 'JWST x1dints', layout, timeSource, timeSystem: 'BJD_TDB', telescope: str(P.TELESCOP), instrument: str(P.INSTRUME), detector: str(P.DETECTOR),
    grating: str(P.GRATING), filter: str(P.FILTER), pupil: str(P.PUPIL), exptype: str(P.EXP_TYPE), target: str(P.TARGPROP) || str(P.TARGNAME), program: str(P.PROGRAM), observation: str(P.OBSERVTN),
    ra: P.TARG_RA ?? null, dec: P.TARG_DEC ?? null, nints: P.NINTS ?? nT, intStart: intNum[0], intEnd: intNum[nT - 1], segment: P.EXSEGNUM ?? null, segments: P.EXSEGTOT ?? null,
    integrationSeconds: P.EFFINTTM ?? null, calVersion: str(P.CAL_VER), dateObs: str(P['DATE-OBS']), order: orders.length ? order : null, orders,
    fluxColumn: fcol, fluxUnit: tab0.col(fcol).unit, wavelengthUnit: wcol.unit || 'um', wavelengthSpread: waveSpread,
  };
  return cube;
}

/** Drop columns with no finite wavelength, sort ascending, flag non-finite fluxes. */
function finishCube({ time, wave, flux, err, bad, nT, nW, lo = null, hi = null }) {
  const keep = []; for (let j = 0; j < nW; j++) if (Number.isFinite(wave[j]) && wave[j] > 0) keep.push(j);
  keep.sort((a, b) => wave[a] - wave[b]);
  const n = keep.length, W = new Float64Array(n), F = new Float64Array(nT * n), E = err ? new Float64Array(nT * n) : null, B = new Uint8Array(nT * n);
  for (let k = 0; k < n; k++) {
    const j = keep[k]; W[k] = wave[j];
    for (let r = 0; r < nT; r++) {
      const x = flux[r * nW + j], e = err ? err[r * nW + j] : 0;
      F[r * n + k] = x; if (E) E[r * n + k] = e;
      if (!Number.isFinite(x) || (bad && bad[r * nW + j]) || (err && !(e > 0))) B[r * n + k] = 1;
    }
  }
  const out = { time: Float64Array.from(time), wave: W, flux: F, err: E, bad: B, nT, nW: n, exptime: 0, meta: {} };
  if (lo && hi) { out.lo = Float64Array.from(keep, (j) => lo[j]); out.hi = Float64Array.from(keep, (j) => hi[j]); }
  return out;
}

/**
 * A plain-text cube. Two shapes are recognised:
 *   long   one row per (time, wavelength): columns named like time|bjd|mjd|jd, wave*|wl|lambda, flux, and optionally
 *          err|error|sigma|unc (ECSV comment lines starting with # are skipped; the column line is the first other line)
 *   wide   one row per time: first column time, then one column per wavelength whose header is the wavelength in
 *          micron (optionally prefixed f_), then optionally the same number of error columns (prefixed e_)
 * Separators: comma, tab, semicolon or spaces. Wavelengths above 50 are taken to be nm and converted to micron.
 * Times below 2400000 that look like MJD (above 40000) get 2400000.5 added.
 */
export function parseSpectralText(text, name = 'spectra') {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) throw new Error('The file has no table.');
  const split = (l) => (/[,;\t]/.test(l) ? l.split(/[,;\t]/) : l.split(/\s+/)).map((s) => s.trim());
  const head = split(lines[0]), isNum = (s) => s !== '' && Number.isFinite(Number(s));
  const hasHeader = !head.every(isNum);
  if (!hasHeader) throw new Error('The table needs a header line naming its columns (time, wavelength, flux, ...).');
  const lc = head.map((s) => s.toLowerCase().replace(/^["']|["']$/g, ''));
  const find = (re) => lc.findIndex((s) => re.test(s));
  const iT = find(/^(time|bjd|mjd|jd|t|bjd_tdb|int_mid_bjd_tdb)\b/), iW = find(/^(wave|wl|lambda|wavelength)/), iF = lc.findIndex((s, i) => i !== iW && /^(flux|f|spec)($|[^a-z]*$)/.test(s) && !/err|unc/.test(s)), iE = find(/(err|sigma|unc)/);
  const rows = lines.slice(1).map(split);
  let cube;
  if (iT >= 0 && iW >= 0 && iF >= 0) {
    const ts = [], ws = [], tIdx = new Map(), wIdx = new Map();
    for (const r of rows) { const t = Number(r[iT]), w = Number(r[iW]); if (!tIdx.has(t)) { tIdx.set(t, ts.length); ts.push(t); } if (!wIdx.has(w)) { wIdx.set(w, ws.length); ws.push(w); } }
    const nT = ts.length, nW = ws.length, flux = new Float64Array(nT * nW).fill(NaN), err = iE >= 0 ? new Float64Array(nT * nW).fill(NaN) : null;
    for (const r of rows) { const o = tIdx.get(Number(r[iT])) * nW + wIdx.get(Number(r[iW])); flux[o] = Number(r[iF]); if (err) err[o] = Number(r[iE]); }
    const order = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
    const f2 = new Float64Array(nT * nW), e2 = err ? new Float64Array(nT * nW) : null;
    order.forEach((src, r) => { f2.set(flux.subarray(src * nW, (src + 1) * nW), r * nW); if (e2) e2.set(err.subarray(src * nW, (src + 1) * nW), r * nW); });
    cube = finishCube({ time: order.map((i) => ts[i]), wave: Float64Array.from(ws), flux: f2, err: e2, bad: null, nT, nW });
    cube.meta = { source: 'text (long table)', name };
  } else {
    const wl = head.slice(1).map((s) => s.replace(/^["']|["']$/g, ''));
    const nF = wl.findIndex((s) => /^e_/i.test(s)), nW = nF < 0 ? wl.length : nF;
    const wave = Float64Array.from(wl.slice(0, nW), (s) => Number(s.replace(/^f_/i, '')));
    if (!nW || !wave.every(Number.isFinite)) throw new Error('Could not find the columns. Use a header "time, wavelength, flux, flux_err" (one row per time and wavelength) or "time, <wavelength 1>, <wavelength 2>, ..." (one row per time).');
    const hasErr = nF >= 0 && wl.length === 2 * nW, nT = rows.length;
    const time = new Float64Array(nT), flux = new Float64Array(nT * nW), err = hasErr ? new Float64Array(nT * nW) : null;
    rows.forEach((r, i) => { time[i] = Number(r[0]); for (let j = 0; j < nW; j++) { flux[i * nW + j] = Number(r[1 + j]); if (err) err[i * nW + j] = Number(r[1 + nW + j]); } });
    cube = finishCube({ time, wave, flux, err, bad: null, nT, nW });
    cube.meta = { source: 'text (one row per time)', name };
  }
  if (cube.wave.length && cube.wave[cube.wave.length - 1] > 50) { for (let j = 0; j < cube.nW; j++) cube.wave[j] /= 1000; cube.meta.wavelengthConverted = 'nm to micron'; }
  if (cube.time[0] > 40000 && cube.time[0] < 2400000) { for (let i = 0; i < cube.nT; i++) cube.time[i] += MJD0; cube.meta.timeConverted = 'MJD + 2400000.5'; }
  const dts = []; for (let i = 1; i < cube.nT; i++) dts.push(cube.time[i] - cube.time[i - 1]);
  cube.exptime = median(dts) || 0; cube.meta.timeSystem = 'as given';
  return cube;
}

/** The cube as text, one row per time: "time,f_<wl>...,e_<wl>...". parseSpectralText reads it back. */
export function cubeToCSV(cube) {
  const { nT, nW } = cube, head = ['time', ...Array.from(cube.wave, (w) => 'f_' + +w.toPrecision(8))];
  if (cube.err) head.push(...Array.from(cube.wave, (w) => 'e_' + +w.toPrecision(8)));
  const out = [head.join(',')];
  for (let i = 0; i < nT; i++) {
    const r = [cube.time[i].toFixed(7)];
    for (let j = 0; j < nW; j++) r.push(String(+cube.flux[i * nW + j].toPrecision(9)));
    if (cube.err) for (let j = 0; j < nW; j++) r.push(String(+cube.err[i * nW + j].toPrecision(5)));
    out.push(r.join(','));
  }
  return out.join('\n') + '\n';
}

const sameGrid = (a, b, tol) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

/**
 * Join cubes: those with the same wavelength grid are segments and are appended in time; the resulting groups
 * (detectors, orders) must then have the same times and are placed side by side in wavelength.
 * Integrations that appear twice (same time within a tenth of the cadence) are kept once.
 */
export function mergeCubes(list) {
  if (!list.length) throw new Error('No spectra to join.');
  if (list.length === 1) return list[0];
  const groups = [];
  for (const c of list) { const g = groups.find((q) => sameGrid(q[0].wave, c.wave, 1e-6)); if (g) g.push(c); else groups.push([c]); }
  const joined = groups.map((g) => {
    g.sort((a, b) => a.time[0] - b.time[0]);
    const nW = g[0].nW, anyErr = g.every((c) => c.err), dt = g[0].exptime || (g[0].nT > 1 ? g[0].time[1] - g[0].time[0] : 0);
    const rows = []; let last = -Infinity;
    for (const c of g) for (let r = 0; r < c.nT; r++) { if (c.time[r] - last <= 0.1 * dt) continue; rows.push([c, r]); last = c.time[r]; }
    const nT = rows.length, out = { time: new Float64Array(nT), wave: g[0].wave, flux: new Float64Array(nT * nW), err: anyErr ? new Float64Array(nT * nW) : null, bad: new Uint8Array(nT * nW), nT, nW, exptime: g[0].exptime, meta: { ...g[0].meta, segments: g.length, intEnd: g[g.length - 1].meta.intEnd } };
    if (g[0].lo) { out.lo = g[0].lo; out.hi = g[0].hi; }
    rows.forEach(([c, r], i) => { out.time[i] = c.time[r]; out.flux.set(c.flux.subarray(r * nW, (r + 1) * nW), i * nW); if (out.err) out.err.set(c.err.subarray(r * nW, (r + 1) * nW), i * nW); out.bad.set(c.bad.subarray(r * nW, (r + 1) * nW), i * nW); });
    return out;
  });
  if (joined.length === 1) return joined[0];
  joined.sort((a, b) => a.wave[0] - b.wave[0]);
  const A = joined[0], nT = A.nT, tol = 0.1 * (A.exptime || 1e-4);
  for (const c of joined) if (c.nT !== nT || !sameGrid(c.time, A.time, tol)) throw new Error('These files have different wavelength grids and different times: they are not parts of one observation. (Detectors of one exposure share their integration times; segments share their wavelengths.)');
  const nW = joined.reduce((a, c) => a + c.nW, 0), anyErr = joined.every((c) => c.err);
  const out = { time: A.time, wave: new Float64Array(nW), flux: new Float64Array(nT * nW), err: anyErr ? new Float64Array(nT * nW) : null, bad: new Uint8Array(nT * nW), nT, nW, exptime: A.exptime, meta: { ...A.meta, detector: joined.map((c) => c.meta.detector).filter(Boolean).join('+') || A.meta.detector, parts: joined.map((c) => ({ detector: c.meta.detector, wave: [c.wave[0], c.wave[c.nW - 1]], columns: c.nW })) } };
  // each part is normalised to its own median spectrum level so a flux-calibration step between detectors does not matter downstream (bins never straddle parts)
  out.part = new Uint8Array(nW);
  let o = 0; joined.forEach((c, k) => { out.wave.set(c.wave, o); out.part.fill(k, o, o + c.nW); for (let r = 0; r < nT; r++) { out.flux.set(c.flux.subarray(r * c.nW, (r + 1) * c.nW), r * nW + o); if (out.err) out.err.set(c.err.subarray(r * c.nW, (r + 1) * c.nW), r * nW + o); out.bad.set(c.bad.subarray(r * c.nW, (r + 1) * c.nW), r * nW + o); } o += c.nW; });
  return out;
}

// =================================================================================================
// Cleaning, binning

/**
 * Reject outliers in time, wavelength by wavelength: each column is compared with its running median over
 * `window` integrations; points further than `nsigma` robust standard deviations (1.4826 x MAD of the differences)
 * are flagged and, like the points already flagged in `bad`, replaced by the running median (their error by the
 * column's median error). A column with more than `maxBadFrac` of its points flagged is dropped from every later sum,
 * and so (unless spectral is false, or the columns are simulated channels) is a column that does not belong to the
 * spectrum (see below). Returns a new cube with { replaced (count), deadColumns (count, all reasons), outlierColumns
 * (count, the spectral test), colOk (Uint8Array) }; the input is not changed.
 */
export function rejectOutliers(cube, { window = 11, nsigma = 5, maxBadFrac = 0.2, spectral = true, colTolerance = 0.5, errFactor = 5 } = {}) {
  const { nT, nW } = cube, flux = Float64Array.from(cube.flux), err = cube.err ? Float64Array.from(cube.err) : null, bad = new Uint8Array(nT * nW), colOk = new Uint8Array(nW);
  const half = Math.max(1, window >> 1), col = new Float64Array(nT), med = new Float64Array(nT), buf = [];
  let replaced = 0, dead = 0, outlierColumns = 0;
  for (let j = 0; j < nW; j++) {
    let nb = 0;
    for (let i = 0; i < nT; i++) { col[i] = cube.bad[i * nW + j] ? NaN : cube.flux[i * nW + j]; if (!Number.isFinite(col[i])) nb++; }
    if (nb > maxBadFrac * nT) { dead++; for (let i = 0; i < nT; i++) bad[i * nW + j] = 1; continue; }
    for (let i = 0; i < nT; i++) { buf.length = 0; for (let k = Math.max(0, i - half); k <= Math.min(nT - 1, i + half); k++) if (Number.isFinite(col[k])) buf.push(col[k]); med[i] = buf.length ? median(buf) : NaN; }
    const dev = []; for (let i = 0; i < nT; i++) if (Number.isFinite(col[i]) && Number.isFinite(med[i])) dev.push(Math.abs(col[i] - med[i]));
    const sig = 1.4826 * median(dev), eMed = err ? median(Array.from({ length: nT }, (_, i) => (cube.bad[i * nW + j] ? NaN : cube.err[i * nW + j]))) : 0;
    let nrep = 0;
    for (let i = 0; i < nT; i++) {
      const out = !Number.isFinite(col[i]) || (sig > 0 && Math.abs(col[i] - med[i]) > nsigma * sig);
      if (!out) continue;
      if (!Number.isFinite(med[i])) { bad[i * nW + j] = 1; continue; }
      flux[i * nW + j] = med[i]; if (err) err[i * nW + j] = eMed; nrep++;
    }
    if (nrep + 0 > maxBadFrac * nT) { dead++; for (let i = 0; i < nT; i++) bad[i * nW + j] = 1; continue; }
    replaced += nrep; colOk[j] = 1;
  }
  // columns that do not belong to the spectrum: a median flux that is not positive, or more than `colTolerance`
  // (a fraction) away from the median of its 14 neighbours, or error bars `errFactor` times larger, relative to the
  // flux, than the median column's. One such column can dominate a sum. Skipped for fewer than 30 columns.
  if (spectral !== false && !cube.lo && nW >= 30) {
    const cm = new Float64Array(nW).fill(NaN), ce = new Float64Array(nW).fill(NaN);
    for (let j = 0; j < nW; j++) if (colOk[j]) { for (let i = 0; i < nT; i++) col[i] = flux[i * nW + j]; cm[j] = median(col); if (err) { for (let i = 0; i < nT; i++) col[i] = err[i * nW + j]; ce[j] = median(col) / Math.abs(cm[j]); } }
    const eMed = err ? median(ce) : NaN, kill = [];
    for (let j = 0; j < nW; j++) {
      if (!colOk[j]) continue;
      buf.length = 0; for (let k = Math.max(0, j - 7); k <= Math.min(nW - 1, j + 7); k++) if (colOk[k] && k !== j && !(cube.part && cube.part[k] !== cube.part[j])) buf.push(cm[k]);
      const ref = buf.length >= 4 ? median(buf) : cm[j];
      if (!(cm[j] > 0) || Math.abs(cm[j] / ref - 1) > colTolerance || (err && ce[j] > errFactor * eMed)) kill.push(j);
    }
    for (const j of kill) { colOk[j] = 0; dead++; outlierColumns++; for (let i = 0; i < nT; i++) bad[i * nW + j] = 1; }
  }
  return { ...cube, outlierColumns, flux, err, bad, colOk, replaced, deadColumns: dead, cleaned: { window, nsigma, maxBadFrac } };
}

/** Edges of the cube's columns in micron: given (simulated channels) or half-way between neighbouring wavelengths. */
export function columnEdges(cube) {
  const n = cube.nW, w = cube.wave, lo = new Float64Array(n), hi = new Float64Array(n);
  if (cube.lo && cube.hi) return { lo: cube.lo, hi: cube.hi };
  for (let j = 0; j < n; j++) {
    const jump = (a, b) => cube.part && cube.part[a] !== cube.part[b];
    const dl = j > 0 && !jump(j, j - 1) ? w[j] - w[j - 1] : j + 1 < n && !jump(j, j + 1) ? w[j + 1] - w[j] : 0, dr = j + 1 < n && !jump(j, j + 1) ? w[j + 1] - w[j] : dl;
    lo[j] = w[j] - 0.5 * dl; hi[j] = w[j] + 0.5 * dr;
  }
  return { lo, hi };
}

/**
 * Wavelength bins on the cube's grid. A bin is a run of whole columns [j0, j1).
 *   { mode: 'R', R }           constant resolving power lambda / dlambda
 *   { mode: 'width', width }   constant width in micron
 *   { mode: 'n', n }           that many bins with equal numbers of columns
 *   { mode: 'columns', columns }   that many columns (detector pixels) per bin
 *   { mode: 'native' }         every column its own bin
 *   { mode: 'edges', edges }   explicit edges in micron
 * Common: wlMin, wlMax (micron) restrict the range. Bins never straddle a detector gap (cube.part) or a gap in
 * the wavelength grid wider than five columns. Bins left with no usable column are dropped.
 * Returns [{ lo, hi, wl (centre), j0, j1, ncol }] in micron.
 */
export function makeBins(cube, opts = {}) {
  const { lo, hi } = columnEdges(cube), n = cube.nW, w = cube.wave, ok = cube.colOk || null;
  const wlMin = opts.wlMin ?? -Infinity, wlMax = opts.wlMax ?? Infinity, mode = opts.mode || 'native';
  let a = 0; while (a < n && w[a] < wlMin) a++;
  let b = n; while (b > a && w[b - 1] > wlMax) b--;
  if (b <= a) throw new Error('No wavelengths inside the chosen range.');
  // stretches of contiguous columns
  const runs = []; let s = a; const dmed = median(Array.from({ length: Math.max(1, b - a - 1) }, (_, k) => w[a + k + 1] - w[a + k]));
  for (let j = a + 1; j <= b; j++) if (j === b || (cube.part && cube.part[j] !== cube.part[j - 1]) || (dmed > 0 && w[j] - w[j - 1] > 5 * dmed && !(cube.lo))) { runs.push([s, j]); s = j; }
  const bins = [], push = (j0, j1) => { if (j1 <= j0) return; let nc = 0; for (let j = j0; j < j1; j++) if (!ok || ok[j]) nc++; if (nc) bins.push({ lo: lo[j0], hi: hi[j1 - 1], wl: j1 - j0 === 1 ? w[j0] : 0.5 * (lo[j0] + hi[j1 - 1]), j0, j1, ncol: nc }); };
  for (const [r0, r1] of runs) {
    if (mode === 'native') { for (let j = r0; j < r1; j++) push(j, j + 1); continue; }
    if (mode === 'columns') { const k = Math.max(1, Math.round(opts.columns || 10)); for (let j = r0; j < r1; j += k) push(j, Math.min(r1, j + k)); continue; }
    if (mode === 'n') { const nb = Math.max(1, Math.round((opts.n || 10) * (r1 - r0) / (b - a))); for (let k = 0; k < nb; k++) push(r0 + Math.round((k * (r1 - r0)) / nb), r0 + Math.round(((k + 1) * (r1 - r0)) / nb)); continue; }
    let edges;
    if (mode === 'edges') edges = Array.from(opts.edges);
    else {
      edges = [lo[r0]]; const end = hi[r1 - 1];
      if (mode === 'R') { const q = (2 * opts.R + 1) / (2 * opts.R - 1); if (!(opts.R > 0.5)) throw new Error('R must be positive.'); while (edges[edges.length - 1] * q < end) edges.push(edges[edges.length - 1] * q); }
      else if (mode === 'width') { if (!(opts.width > 0)) throw new Error('The bin width must be positive.'); while (edges[edges.length - 1] + opts.width < end) edges.push(edges[edges.length - 1] + opts.width); }
      else throw new Error('Unknown binning mode: ' + mode);
      const lastW = edges.length > 1 ? edges[edges.length - 1] - edges[edges.length - 2] : end - edges[0];
      if (end - edges[edges.length - 1] >= 0.5 * lastW || edges.length === 1) edges.push(end); else edges[edges.length - 1] = end;
    }
    // a column belongs to the bin that holds its centre
    let j = r0;
    for (let k = 0; k + 1 < edges.length; k++) { while (j < r1 && w[j] < edges[k]) j++; const j0 = j; while (j < r1 && (w[j] < edges[k + 1] || (k + 2 === edges.length && w[j] <= edges[k + 1]))) j++; push(j0, j); }
  }
  if (!bins.length) throw new Error('The binning left no usable channel.');
  return bins;
}

/** Robust point-to-point scatter of a series: 1.4826 MAD of f[i] - (f[i-1] + f[i+1]) / 2, divided by sqrt(1.5). */
export function pointScatter(f) {
  const d = []; for (let i = 1; i + 1 < f.length; i++) d.push(f[i] - 0.5 * (f[i - 1] + f[i + 1]));
  if (d.length < 3) return NaN;
  const m = median(d); return 1.4826 * median(d.map((x) => Math.abs(x - m))) / Math.sqrt(1.5);
}

/**
 * Light curves of the bins: in every integration the fluxes of the bin's usable columns are summed and their
 * errors added in quadrature; the series is then divided by its median. Integrations where any usable column is
 * still flagged are dropped from that channel (after rejectOutliers there are none).
 * Without errors in the cube the error of every point is the channel's point-to-point scatter (pointScatter).
 * Returns [{ lo, hi, wl, ncol, time, flux, err, scale (the median that was divided out), exptime, errSource }].
 */
export function binCube(cube, bins) {
  const { nT, nW } = cube, ok = cube.colOk || null;
  return bins.map((bn) => {
    const t = [], f = [], e = [];
    for (let i = 0; i < nT; i++) {
      let s = 0, v = 0, good = true;
      for (let j = bn.j0; j < bn.j1; j++) { if (ok && !ok[j]) continue; const o = i * nW + j; if (cube.bad[o]) { good = false; break; } s += cube.flux[o]; if (cube.err) v += cube.err[o] * cube.err[o]; }
      if (good) { t.push(cube.time[i]); f.push(s); e.push(Math.sqrt(v)); }
    }
    const scale = median(f), flux = Float64Array.from(f, (x) => x / scale);
    let err, errSource = 'propagated';
    if (cube.err) err = Float64Array.from(e, (x) => x / Math.abs(scale)); else { const sg = pointScatter(flux); err = new Float64Array(flux.length).fill(sg); errSource = 'point-to-point scatter'; }
    return { lo: bn.lo, hi: bn.hi, wl: bn.wl, ncol: bn.ncol, time: Float64Array.from(t), flux, err, scale, exptime: cube.exptime || 0, errSource };
  });
}

/** The white light curve: every usable column between wlMin and wlMax summed. With several detectors each is normalised first and they are averaged with inverse-variance weights. */
export function whiteLight(cube, { wlMin, wlMax } = {}) {
  const parts = cube.part ? [...new Set(cube.part)] : [0], lcs = [];
  for (const p of parts) {
    let j0 = 0, j1 = cube.nW;
    if (cube.part) { j0 = cube.part.indexOf(p); j1 = cube.part.lastIndexOf(p) + 1; }
    while (j0 < j1 && cube.wave[j0] < (wlMin ?? -Infinity)) j0++; while (j1 > j0 && cube.wave[j1 - 1] > (wlMax ?? Infinity)) j1--;
    if (j1 <= j0) continue;
    const { lo, hi } = columnEdges(cube);
    lcs.push(binCube(cube, [{ lo: lo[j0], hi: hi[j1 - 1], wl: 0.5 * (lo[j0] + hi[j1 - 1]), j0, j1, ncol: j1 - j0 }])[0]);
  }
  if (!lcs.length) throw new Error('No wavelengths inside the chosen range.');
  if (lcs.length === 1 || lcs.some((l) => l.time.length !== lcs[0].time.length)) return lcs[0];
  const n = lcs[0].time.length, flux = new Float64Array(n), err = new Float64Array(n);
  for (let i = 0; i < n; i++) { let sw = 0, s = 0; for (const l of lcs) { const w = 1 / (l.err[i] * l.err[i]); sw += w; s += w * l.flux[i]; } flux[i] = s / sw; err[i] = Math.sqrt(1 / sw); }
  return { lo: lcs[0].lo, hi: lcs[lcs.length - 1].hi, wl: 0.5 * (lcs[0].lo + lcs[lcs.length - 1].hi), ncol: lcs.reduce((a, l) => a + l.ncol, 0), time: lcs[0].time, flux, err, scale: 1, exptime: lcs[0].exptime, errSource: lcs[0].errSource, parts: lcs.length };
}

/**
 * Common-mode correction: divide every channel by the white light curve's ratio to its fitted model
 * (data / (transit x baseline)), which removes whatever all wavelengths share. The white curve's own noise is
 * divided in too: it is added in quadrature to the channel's errors, and because it is the same in every
 * channel it moves all depths together rather than adding scatter between them.
 * `ratio` is one value per white-light point (time, ratio); channels are matched by time.
 */
export function applyCommonMode(channels, white) {
  const key = (t) => Math.round(t * 1e7), map = new Map(); white.time.forEach((t, i) => map.set(key(t), i));
  return channels.map((ch) => {
    const flux = new Float64Array(ch.flux.length), err = new Float64Array(ch.flux.length);
    for (let i = 0; i < flux.length; i++) {
      const k = map.get(key(ch.time[i])), r = k === undefined ? 1 : white.ratio[k], ew = k === undefined || !white.err ? 0 : white.err[k];
      flux[i] = ch.flux[i] / r; err[i] = Math.hypot(ch.err[i], ch.flux[i] * ew) / r;
    }
    return { ...ch, flux, err, commonMode: true };
  });
}

// =================================================================================================
// Limb darkening per channel

/**
 * Limb darkening coefficients for a channel from the wavelength-resolved table (expandSpectral of ldspec.js).
 *   star = { teff, logg, feh }, lo and hi in micron.
 * The table ends at 5.5 micron. A channel partly beyond it uses the part inside; a channel wholly beyond it uses
 * the reddest 200 nm of the table (limb darkening changes slowly there, but this is an extrapolation and
 * `extrapolated` is set). Returns { law, coeffs, clamped, extrapolated, coverage, band: [nm, nm] }.
 */
export function channelLimbDarkening(table, star, lo, hi, law = 'quadratic') {
  let a = lo * 1000, b = hi * 1000, extrapolated = false;
  const max = table.range ? table.range[1] : LD_TABLE_MAX_NM, min = table.range ? table.range[0] : 200;
  if (a >= max - 1) { a = max - 200; b = max; extrapolated = true; } else if (b > max) { b = max; extrapolated = true; }
  if (b <= min + 1) { a = min; b = min + 50; extrapolated = true; }
  const r = bandCoefficients(table, { teff: star.teff, logg: star.logg ?? 4.5, feh: star.feh ?? 0 }, [a, b], law);
  return { law, coeffs: Array.from(r.coeffs), clamped: !!r.starClamped, extrapolated, coverage: r.coverage, band: [a, b] };
}

// =================================================================================================
// Fits

const TWO_SIDED = [0.1587, 0.5, 0.8413];

/** Regressors for the baseline of a light curve: time scaled to [-1, 1] ('linear'), plus its square ('quadratic'), plus any extra columns centred and scaled to unit variance, plus one step per entry of `steps` (times in the units of `time`). */
export function baselineRegressors(time, baseline = 'linear', extra = [], steps = []) {
  const n = time.length, t0 = 0.5 * (time[0] + time[n - 1]), h = 0.5 * (time[n - 1] - time[0]) || 1, out = [];
  // a step in the baseline at a given time (a mirror segment "tilt event", a re-pointing): -1/2 before, +1/2 after
  for (const ts of steps || []) if (ts > time[0] && ts < time[n - 1]) out.push(Float64Array.from(time, (t) => (t < ts ? -0.5 : 0.5)));
  if (baseline === 'linear' || baseline === 'quadratic') out.push(Float64Array.from(time, (t) => (t - t0) / h));
  if (baseline === 'quadratic') out.push(Float64Array.from(time, (t) => ((t - t0) / h) ** 2 - 1 / 3));
  for (const x of extra || []) { let m = 0; for (let i = 0; i < n; i++) m += x[i]; m /= n; let v = 0; for (let i = 0; i < n; i++) v += (x[i] - m) ** 2; const s = Math.sqrt(v / n) || 1; out.push(Float64Array.from(x, (q) => (q - m) / s)); }
  return out;
}

/**
 * The fit specification (what buildProblem takes) for one light curve of a spectroscopic data set.
 *   lc      { time (absolute), flux, err, exptime (days) }
 *   sys     { rprs, ars, inc, per, tmid (absolute), ecc, omega, fpfs?, mstar?, rstar?, mplanet? }
 *   opts    { kind: 'transit' | 'eclipse', ldLaw, ld: [coefficients], baseline: 'none' | 'linear' | 'quadratic',
 *             regressors: [extra columns], steps: [absolute times of steps in the baseline], free: [{ key, prior }] (tmid priors absolute), kepler, errScale, tRef, sampler }
 * a/R* is a fixed value, or with opts.kepler follows from M*, R*, P; it is never free.
 * Returns { spec, tRef }.
 */
export function lightCurveSpec(lc, sys, opts = {}) {
  const tRef = opts.tRef ?? Math.floor(lc.time[0]), kind = opts.kind || 'transit', ldLaw = opts.ldLaw || 'quadratic', s = opts.errScale || 1;
  const values = { rprs: sys.rprs, ars: sys.ars, inc: sys.inc, per: sys.per, tmid: sys.tmid - tRef, ecc: sys.ecc || 0, omega: sys.omega || 0, a2: 0 };
  (opts.ld || []).forEach((c, i) => (values['ld' + i] = c));
  if (opts.kepler) { values.mstar = sys.mstar; values.rstar = sys.rstar; values.mplanet = sys.mplanet || 0; values.ars = arsFromKepler(sys.per, sys.mstar, sys.mplanet || 0, sys.rstar); }
  const spec = { values, ldLaw, kepler: !!opts.kepler, sampler: opts.sampler || { nlive: 250, fracRemain: 0.02, seed: 42, maxCalls: 400000 } };
  if (kind === 'eclipse') { Object.assign(values, { fpfs: sys.fpfs ?? 1e-3, contrast: 0, hotspot: 0, h2c: 0, h2s: 0, ellip: 0, beam: 0 }); spec.phase = { mode: 'harmonic', ltt: false }; }
  const time = Float64Array.from(lc.time, (t) => t - tRef), reg = baselineRegressors(time, opts.baseline ?? 'linear', opts.regressors, (opts.steps || []).map((x) => x - tRef));
  spec.data = { t: time, f: lc.flux, e: s === 1 ? lc.err : Float64Array.from(lc.err, (x) => x * s) };
  if (reg.length) spec.data.regressors = reg;
  spec.exptime = lc.exptime || 0; spec.supersample = autoSupersample(spec.exptime, values);
  spec.free = (opts.free || []).map((f) => ({ key: f.key, prior: f.key.split('@')[0] === 'tmid' ? { ...f.prior, a: f.prior.a - tRef, b: f.prior.type === 'uniform' ? f.prior.b - tRef : f.prior.b } : { ...f.prior } }));
  return { spec, tRef };
}

/** How much the errors are scaled: 1 ('pipeline'), scatter / median error ('scatter'), or the larger of the two ('max'). */
export function errorScaleFor(lc, mode = 'max') {
  if (mode === 'pipeline') return 1;
  const sg = pointScatter(lc.flux), em = median(lc.err), r = sg / em;
  if (!(r > 0)) return 1;
  return mode === 'scatter' ? r : Math.max(1, r);
}

/** Default priors of a white-light fit: Rp/R* (or Fp/F*), the mid-time and the inclination, uniform. */
export function defaultWhiteFree(lc, sys, kind = 'transit') {
  const d = derived(sys), t14 = d.t14 || 0.1, n = lc.time.length;
  let tc = sys.tmid;
  if (kind === 'eclipse') tc += sys.per * 0.5;        // circular guess; the model itself places the eclipse from e and omega
  tc += Math.round((0.5 * (lc.time[0] + lc.time[n - 1]) - tc) / sys.per) * sys.per;
  const tm = sys.tmid + Math.round((0.5 * (lc.time[0] + lc.time[n - 1]) - sys.tmid) / sys.per) * sys.per, w = Math.max(0.02, 0.25 * t14);
  if (kind === 'eclipse') return { tmidNear: tm, free: [{ key: 'fpfs', prior: { type: 'uniform', a: 0, b: Math.max(5 * (sys.fpfs || 0), 0.01 / (sys.rprs * sys.rprs)) } }] };
  const b = d.b, incLo = Math.max(60, sys.inc - 4), free = [
    { key: 'rprs', prior: { type: 'uniform', a: sys.rprs / 3, b: Math.min(0.9, sys.rprs * 3) } },
    { key: 'tmid', prior: { type: 'uniform', a: tm - w, b: tm + w } },
    { key: 'inc', prior: { type: 'uniform', a: incLo, b: 90 } },
  ];
  return { tmidNear: tm, free, b };
}

function summarize(res, spec, tRef) {
  const d = res.ndim, n = res.n, col = (k) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = res.samples[i * d + k]; return a; };
  return spec.free.map((f, k) => { const [lo, med, hi] = weightedQuantiles(col(k), res.weights, TWO_SIDED), off = f.key.split('@')[0] === 'tmid' ? tRef : 0; return { key: f.key, median: med + off, plus: hi - med, minus: med - lo, best: res.maxPoint[k] + off }; });
}

/**
 * The largest step in a series of residuals: the difference between the means of the K points after and the K
 * points before each position. Returns { index (first point after the step), time (half-way between the two
 * points), size, significance (size over its standard error from the point-to-point scatter) }. A mirror-segment
 * tilt event in a JWST time series shows up as one; pass `time` to the fits as opts.steps = [time].
 */
export function findStep(time, resid, K = 12) {
  const n = resid.length; let best = 0, bi = -1;
  for (let i = K; i <= n - K; i++) { let a = 0, b = 0; for (let k = 0; k < K; k++) { a += resid[i - 1 - k]; b += resid[i + k]; } const d = (b - a) / K; if (Math.abs(d) > Math.abs(best)) { best = d; bi = i; } }
  if (bi < 0) return null;
  const sg = pointScatter(resid) * Math.sqrt(2 / K);
  return { index: bi, time: 0.5 * (time[bi - 1] + time[bi]), size: best, significance: Math.abs(best) / sg };
}

/** Residual statistics of a fitted light curve: rms, the mean error bar, chi2, and the time-averaging test (psd.js rmsVsBin). */
export function residualStats(resid, err, nFree = 0) {
  const n = resid.length; let s2 = 0, chi2 = 0, se = 0; for (let i = 0; i < n; i++) { s2 += resid[i] * resid[i]; chi2 += (resid[i] / err[i]) ** 2; se += err[i] * err[i]; }
  const out = { n, rms: Math.sqrt(s2 / n), expected: Math.sqrt(se / n), chi2, redChi2: chi2 / Math.max(1, n - nFree) };
  out.ratio = out.rms / out.expected;
  if (n >= 40) { const rb = rmsVsBin(resid, { minBins: 8 }); out.beta = rb.beta; out.betaBin = rb.nBeta; out.binned = { n: Array.from(rb.n), rms: Array.from(rb.rms), expected: Array.from(rb.expected), M: Array.from(rb.M) }; } else { out.beta = NaN; out.betaBin = 0; out.binned = null; }
  return out;
}

/**
 * White-light fit: the geometry all channels share. Nested sampling through buildProblem (fitRunner.js).
 * opts as lightCurveSpec, plus errorMode ('pipeline' | 'scatter' | 'max', default 'max') and free (defaults: defaultWhiteFree).
 * Returns { kind, parameters: [{ key, median, plus, minus, best }], values (the system at the best point, tmid absolute:
 *   pass it to fitChannel), depth: { median, plus, minus } (Rp/R*)^2 or Fp/F* (Rp/R*)^2, errScale, logZ, ncalls, converged,
 *   warnings, stats (residualStats), time, model (transit x baseline), baseline, detrended (flux / baseline), resid, ld, ldLaw }.
 */
export async function fitWhiteLight(lc, sys, opts = {}, onProgress = () => {}, shouldStop = () => false) {
  const kind = opts.kind || 'transit', dflt = defaultWhiteFree(lc, sys, kind);
  const sys0 = { ...sys, tmid: dflt.tmidNear }, free = opts.free || dflt.free;
  const errScale = opts.errScale ?? errorScaleFor(lc, opts.errorMode || 'max');
  const { spec, tRef } = lightCurveSpec(lc, sys0, { ...opts, kind, free, errScale });
  const res = await runFit(spec, onProgress, shouldStop);
  const parameters = summarize(res, spec, tRef);
  const best = { ...spec.values }; spec.free.forEach((f, k) => (best[f.key] = res.maxPoint[k]));
  const prob = buildProblem({ ...spec, values: best, free: [] }), det = prob.detail([]);
  const n = lc.time.length, model = new Float64Array(n), resid = new Float64Array(n), detr = new Float64Array(n);
  for (let i = 0; i < n; i++) { model[i] = det.base[i] * det.transit[i]; resid[i] = lc.flux[i] - model[i]; detr[i] = lc.flux[i] / det.base[i]; }
  const values = { ...sys0 }; for (const f of spec.free) values[f.key] = f.key === 'tmid' ? best.tmid + tRef : best[f.key];
  values.ars = det.planets[0].ars;
  // depth from the posterior draws: (Rp/R*)^2, or Fp/F* (Rp/R*)^2 for an eclipse
  const kD = spec.free.findIndex((f) => f.key === (kind === 'eclipse' ? 'fpfs' : 'rprs')), kR = spec.free.findIndex((f) => f.key === 'rprs');
  let depth = null;
  if (kD >= 0) {
    const a = new Float64Array(res.n); for (let i = 0; i < res.n; i++) { const x = res.samples[i * res.ndim + kD], r = kR >= 0 ? res.samples[i * res.ndim + kR] : best.rprs; a[i] = kind === 'eclipse' ? x * r * r : x * x; }
    const [lo, med, hi] = weightedQuantiles(a, res.weights, TWO_SIDED); depth = { median: med, plus: hi - med, minus: med - lo };
  }
  return {
    kind, parameters, values, depth, errScale, logZ: res.logZ, logZerr: res.logZerr, ncalls: res.ncalls, seconds: res.elapsed, converged: res.stopReason === 'converged', warnings: res.warnings || [],
    stats: residualStats(resid, spec.data.e, spec.free.length + prob.nlinear), time: lc.time, model, baseline: det.base, transit: det.transit, detrended: detr, resid,
    ld: opts.ld || [], ldLaw: spec.ldLaw, baselineKind: opts.baseline ?? 'linear', free: free.map((f) => ({ key: f.key, prior: { ...f.prior } })), regCoeffs: det.regCoeffs ? det.regCoeffs[0] : [],
  };
}

/**
 * The posterior of ONE parameter on a grid: maximum by a scan and golden-section search, half-widths where
 * ln L has fallen by 1/2, then 241 points over +-8 of those widths (clipped to [a, b]), integrated by the
 * trapezoid rule. The prior is uniform on [a, b]. Returns { best, median, lo, hi (16th and 84th percentiles),
 * lnZ (evidence with that prior), x, p (the grid and the normalised density) }.
 */
export function posterior1D(loglike, a, b) {
  const NS = 64; let bi = 0, bl = -Infinity; const xs = new Float64Array(NS + 1), ls = new Float64Array(NS + 1);
  for (let i = 0; i <= NS; i++) { xs[i] = a + ((b - a) * i) / NS; ls[i] = loglike(xs[i]); if (ls[i] > bl) { bl = ls[i]; bi = i; } }
  if (!(bl > -1e99)) return null;
  let lo = xs[Math.max(0, bi - 1)], hi = xs[Math.min(NS, bi + 1)]; const g = 0.6180339887498949;
  let c = hi - g * (hi - lo), d = lo + g * (hi - lo), fc = loglike(c), fd = loglike(d);
  for (let it = 0; it < 60 && hi - lo > 1e-12 * (b - a) + 1e-15; it++) { if (fc > fd) { hi = d; d = c; fd = fc; c = hi - g * (hi - lo); fc = loglike(c); } else { lo = c; c = d; fc = fd; d = lo + g * (hi - lo); fd = loglike(d); } }
  const x0 = 0.5 * (lo + hi), l0 = Math.max(loglike(x0), bl), halfWidth = (dir) => {
    const end = dir > 0 ? b : a; if (l0 - loglike(end) < 0.5) return Math.abs(end - x0);
    let p = x0, q = end; for (let it = 0; it < 50; it++) { const m = 0.5 * (p + q); if (l0 - loglike(m) < 0.5) p = m; else q = m; }
    return Math.abs(0.5 * (p + q) - x0);
  };
  const sl = Math.max(halfWidth(-1), 1e-9 * (b - a)), sr = Math.max(halfWidth(1), 1e-9 * (b - a));
  const g0 = Math.max(a, x0 - 8 * sl), g1 = Math.min(b, x0 + 8 * sr), NG = 240, x = new Float64Array(NG + 1), p = new Float64Array(NG + 1), cdf = new Float64Array(NG + 1);
  for (let i = 0; i <= NG; i++) { x[i] = g0 + ((g1 - g0) * i) / NG; p[i] = Math.exp(loglike(x[i]) - l0); }
  for (let i = 1; i <= NG; i++) cdf[i] = cdf[i - 1] + 0.5 * (p[i] + p[i - 1]) * (x[i] - x[i - 1]);
  const Z = cdf[NG], q = (u) => { const y = u * Z; let i = 1; while (i < NG && cdf[i] < y) i++; const f = (y - cdf[i - 1]) / Math.max(cdf[i] - cdf[i - 1], 1e-300); return x[i - 1] + f * (x[i] - x[i - 1]); };
  for (let i = 0; i <= NG; i++) p[i] /= Z;
  return { best: x0, lnLbest: l0, median: q(0.5), lo: q(0.1587), hi: q(0.8413), lnZ: l0 + Math.log(Z / (b - a)), x, p };
}

/**
 * One channel: the depth with the geometry of the white-light fit.
 *   ch    { lo, hi, wl, time, flux, err, exptime }
 *   geo   the system at the white-light solution (fitWhiteLight().values)
 *   opts  { kind, ldLaw, ld (this channel's coefficients), ldSigma (0: fixed; > 0: every coefficient free with a normal
 *           prior of that width), geometry: 'fixed' | 'prior' (tmid and inc free with normal priors geoPriors = { tmid: sd, inc: sd }),
 *           baseline, regressors, errorMode, keep (return the per-point arrays), sampler }
 * With only the depth free the posterior is computed on a grid (posterior1D): exact and deterministic. Anything
 * more goes to the nested sampler. Either way the likelihood is buildProblem's, with the baseline coefficients
 * integrated out analytically.
 * Returns { lo, hi, wl, kind, depth, depthPlus, depthMinus, value (Rp/R* or Fp/F*), valuePlus, valueMinus, best, method,
 *           rms, expected, ratio, beta, betaBin, chi2, redChi2, n, errScale, logZ, ld, [time, model, baseline, detrended, resid, binned] }.
 */
export async function fitChannel(ch, geo, opts = {}) {
  const kind = opts.kind || 'transit', key = kind === 'eclipse' ? 'fpfs' : 'rprs';
  const errScale = opts.errScale ?? errorScaleFor(ch, opts.errorMode || 'max');
  const r0 = geo.rprs, range = kind === 'eclipse' ? [0, Math.max(5 * (geo.fpfs || 0), 0.01 / (r0 * r0))] : [Math.min(1e-3, r0 / 10), Math.min(0.9, 3 * r0 + 0.02)];
  const free = [{ key, prior: { type: 'uniform', a: range[0], b: range[1] } }];
  const law = opts.ldLaw || 'quadratic', nLd = LD_LAWS[law].names.length;
  if (opts.ldSigma > 0) for (let i = 0; i < nLd; i++) free.push({ key: 'ld' + i, prior: { type: 'normal', a: opts.ld[i], b: opts.ldSigma } });
  if (opts.geometry === 'prior') { const gp = opts.geoPriors || {}; if (gp.tmid > 0) free.push({ key: 'tmid', prior: { type: 'normal', a: geo.tmid, b: gp.tmid } }); if (gp.inc > 0) free.push({ key: 'inc', prior: { type: 'normal', a: geo.inc, b: gp.inc } }); }
  const { spec, tRef } = lightCurveSpec(ch, geo, { ...opts, kind, free, errScale });
  let value, logZ, best, method;
  if (free.length === 1) {
    method = 'grid';
    const prob = buildProblem(spec), th = [0], post = posterior1D((x) => { th[0] = x; return prob.loglike(th); }, range[0], range[1]);
    if (!post) throw new Error('The model could not be evaluated for this channel.');
    value = { median: post.median, plus: post.hi - post.median, minus: post.median - post.lo }; best = { ...spec.values, [key]: post.best }; logZ = post.lnZ;
  } else {
    method = 'nested';
    const res = await runFit(spec, () => {}, () => false), pr = summarize(res, spec, tRef)[0];
    value = { median: pr.median, plus: pr.plus, minus: pr.minus }; best = { ...spec.values }; spec.free.forEach((f, k) => (best[f.key] = res.maxPoint[k])); logZ = res.logZ;
  }
  const prob = buildProblem({ ...spec, values: best, free: [] }), det = prob.detail([]);
  const n = ch.time.length, model = new Float64Array(n), resid = new Float64Array(n);
  for (let i = 0; i < n; i++) { model[i] = det.base[i] * det.transit[i]; resid[i] = ch.flux[i] - model[i]; }
  const st = residualStats(resid, ch.err, free.length + prob.nlinear), r2 = kind === 'eclipse' ? r0 * r0 : null;
  const toDepth = (x) => (kind === 'eclipse' ? x * r2 : x * x), dm = toDepth(value.median);
  const out = {
    lo: ch.lo, hi: ch.hi, wl: ch.wl, kind, depth: dm, depthPlus: toDepth(value.median + value.plus) - dm, depthMinus: dm - toDepth(value.median - value.minus),
    value: value.median, valuePlus: value.plus, valueMinus: value.minus, best: best[key], method,
    rms: st.rms, expected: st.expected, ratio: st.ratio, beta: st.beta, betaBin: st.betaBin, chi2: st.chi2, redChi2: st.redChi2, n, errScale, logZ, ld: opts.ld || [], ldLaw: law,
  };
  if (opts.keep) Object.assign(out, { time: ch.time, flux: ch.flux, model, baseline: det.base, transit: det.transit, detrended: Float64Array.from(ch.flux, (f, i) => f / det.base[i]), resid, binned: st.binned });
  return out;
}

/** All channels in turn (the page spreads them over workers instead). `ldFor(ch)` gives each channel's { law, coeffs }. */
export async function fitChannels(channels, geo, opts = {}, onProgress = () => {}) {
  const out = [];
  for (let k = 0; k < channels.length; k++) {
    const ld = opts.ldFor ? opts.ldFor(channels[k]) : { law: opts.ldLaw, coeffs: opts.ld };
    out.push(await fitChannel(channels[k], geo, { ...opts, ldLaw: ld.law, ld: ld.coeffs }));
    onProgress(k + 1, channels.length);
  }
  return out;
}

// =================================================================================================
// Spectrum products

/** Rows of the spectrum from the channel fits: wavelength, bin edges, depth and its 1-sigma interval, and the noise columns. */
export function spectrumTable(results) {
  return results.filter(Boolean).map((r) => ({ wl: r.wl, lo: r.lo, hi: r.hi, depth: r.depth, plus: r.depthPlus, minus: r.depthMinus, err: 0.5 * (r.depthPlus + r.depthMinus), value: r.value, rms: r.rms, expected: r.expected, ratio: r.ratio, beta: r.beta, errScale: r.errScale, redChi2: r.redChi2, n: r.n }));
}

const SPEC_COLS = [
  ['wavelength', 'um', 'wl', 6, 'centre of the channel'], ['wavelength_lo', 'um', 'lo', 6, 'blue edge'], ['wavelength_hi', 'um', 'hi', 6, 'red edge'],
  ['depth', '', 'depth', 6, 'transit depth (Rp/R*)^2, or eclipse depth Fp/F* (Rp/R*)^2'], ['depth_err_plus', '', 'plus', 3, '84th percentile minus median'], ['depth_err_minus', '', 'minus', 3, 'median minus 16th percentile'],
  ['residual_rms', '', 'rms', 4, 'rms of the residuals of the channel light curve'], ['expected_rms', '', 'expected', 4, 'rms expected from the error bars'], ['beta', '', 'beta', 3, 'time-averaging factor (binned rms over white-noise expectation)'],
];
/** The spectrum as ECSV (astropy reads it with Table.read(..., format='ascii.ecsv')). `meta` is written into the header. */
export function spectrumToECSV(spectrum, meta = {}) {
  const L = ['# %ECSV 1.0', '# ---', '# datatype:'];
  for (const [name, unit, , , desc] of SPEC_COLS) L.push(`# - {name: ${name}, ${unit ? `unit: ${unit}, ` : ''}datatype: float64, description: '${desc}'}`);
  L.push('# meta: !!omap');
  for (const [k, v] of Object.entries({ software: 'Exoplanet Science Lab', ...meta })) if (v !== undefined && v !== null && typeof v !== 'object') L.push(`# - {${k}: ${typeof v === 'number' || typeof v === 'boolean' ? v : `'${String(v).replace(/'/g, "''")}'`}}`);
  L.push('# schema: astropy-2.0', SPEC_COLS.map((c) => c[0]).join(' '));
  for (const r of spectrum) L.push(SPEC_COLS.map(([, , k, d]) => (Number.isFinite(r[k]) ? String(+r[k].toPrecision(d + 3)) : 'nan')).join(' '));
  return L.join('\n') + '\n';
}
/** The spectrum as CSV with `# key: value` comment lines for the metadata. */
export function spectrumToCSV(spectrum, meta = {}) {
  const L = Object.entries({ software: 'Exoplanet Science Lab', ...meta }).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object').map(([k, v]) => `# ${k}: ${v}`);
  L.push(SPEC_COLS.map((c) => (c[1] ? `${c[0]}_${c[1]}` : c[0])).join(','));
  for (const r of spectrum) L.push(SPEC_COLS.map(([, , k, d]) => (Number.isFinite(r[k]) ? String(+r[k].toPrecision(d + 3)) : '')).join(','));
  return L.join('\n') + '\n';
}

const K_B = 1.380649e-23, M_U = 1.66053906660e-27;
/**
 * Pressure scale height H = k T / (mu m_u g) in metres, with g = G Mp / Rp^2.
 *   { teq [K], mu (mean molecular weight in atomic mass units, 2.3 for H2/He), mplanet [M Jup], rplanet [R Jup] } or { teq, mu, g [m/s^2] }
 * For interpretation only: T is taken to be the equilibrium temperature, and the atmosphere isothermal.
 */
export function scaleHeight({ teq, mu = 2.3, mplanet, rplanet, g }) {
  const grav = g ?? (C.G * mplanet * C.Mjup_Msun * C.Msun) / (rplanet * C.Rjup) ** 2;
  return { H: (K_B * teq) / (mu * M_U * grav), g: grav };
}
/**
 * The change of transit depth that one scale height of extra radius makes, 2 H Rp / R*^2 (first order in H / Rp),
 * and the spectrum expressed in scale heights above its minimum: n = (depth - min depth) / (2 H Rp / R*^2).
 *   { H [m], rplanet [R Jup], rstar [R Sun] }
 */
export function toScaleHeights(spectrum, { H, rplanet, rstar }) {
  const per = (2 * H * rplanet * C.Rjup) / (rstar * C.Rsun) ** 2, ref = Math.min(...spectrum.map((r) => r.depth));
  return { depthPerH: per, reference: ref, n: spectrum.map((r) => (r.depth - ref) / per), err: spectrum.map((r) => r.err / per), span: (Math.max(...spectrum.map((r) => r.depth)) - ref) / per };
}

// =================================================================================================
// Simulator

const H_PLANCK = 6.62607015e-34, C_LIGHT = 299792458, PC = 3.0856775814913673e16;
/**
 * Photons per second per square metre arriving from a star that radiates as a black body, between lo and hi (micron):
 *     N = pi (R* / d)^2 * integral of 2 c / lambda^4 / (exp(h c / lambda k T) - 1) d lambda
 * (pi B_lambda is the surface flux; dividing by the photon energy h c / lambda gives photons). Simpson's rule, 400 intervals.
 *   { teff [K], rstar [R Sun], distance [pc] }
 */
export function photonRate({ teff, rstar, distance }, lo, hi) {
  const a = lo * 1e-6, b = hi * 1e-6, n = 400, h = (b - a) / n, f = (l) => (2 * C_LIGHT) / (l ** 4 * Math.expm1((H_PLANCK * C_LIGHT) / (l * K_B * teff)));
  let s = f(a) + f(b); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return Math.PI * ((rstar * C.Rsun) / (distance * PC)) ** 2 * (s * h) / 3;
}

/**
 * A toy depth spectrum for testing a retrieval of depths: a level, a slope and Gaussian features. It is not an
 * atmosphere model.   depth(wl) = depth0 + slope * ln(wl / wl0) + sum amp_k exp(-(wl - c_k)^2 / (2 s_k^2))
 *   { depth0, slope, wl0 (micron, default 1), features: [{ wl, sigma (micron), amp (depth units) }] }
 */
export function toySpectrum(wl, { depth0, slope = 0, wl0 = 1, features = [] }) {
  let d = depth0 + slope * Math.log(wl / wl0);
  for (const f of features) d += f.amp * Math.exp(-((wl - f.wl) ** 2) / (2 * f.sigma * f.sigma));
  return d;
}

/**
 * Simulated spectroscopic light curves of one transit (or eclipse): a simple radiometric estimate, NOT a
 * reproduction of ArielRad, ExoSim, PandExo or any instrument simulator.
 *
 * Noise of one exposure in one channel, relative to the star:
 *     N_e      = photonRate(star, lo, hi) * area * throughput * t_exp          detected photo-electrons
 *     sigma^2  = (1 + excess)^2 / N_e  +  floor^2 * (T14 / dt)
 * The first term is photon noise of the star alone (black body; no background, read noise, dark current,
 * saturation or pointing jitter), widened by `excess` (0.2 = 20% above photon noise). The second is white noise sized
 * so that it alone averages to `floor` (noiseFloorPpm) over one transit duration T14: a floor on what one transit
 * can reach. dt is the cadence and t_exp = dt * duty.
 *
 *   o = { system: { rprs, ars, inc, per, tmid, ecc, omega, fpfs? }, star: { teff, rstar, distance, logg, feh },
 *         telescope: 'Ariel' | 'JWST' | { area, throughput, noiseFloorPpm }, area, throughput, noiseFloorPpm, excess (overrides),
 *         channels: [{ lo, hi, wl, name }] (default: instrumentChannels of the telescope), bands, simR,
 *         kind: 'transit' | 'eclipse', depth: (wl) => depth or a toySpectrum description (default: flat at rprs^2 or fpfs rprs^2),
 *         cadence [s] (60), duty (1), baselineHr (out-of-transit time each side, default one T14), slopePpmPerHr (0),
 *         ldFor: (lo, hi) => { law, coeffs } (default: quadratic 0.1, 0.1 everywhere; pass channelLimbDarkening), seed }
 * The cube's fluxes are in detected electrons per exposure, so a white light curve summed from it weights the
 * channels by their photons, as a real one does.
 * Returns { cube (columns are the channels, with lo / hi), truth: [{ wl, lo, hi, depth, rprs or fpfs, sigma (per point),
 *           electrons, ld }], inputs (everything that went in, with units), t14 }.
 */
export function simulateSpectroscopy(o) {
  const tel = typeof o.telescope === 'string' ? TELESCOPES[o.telescope] : (o.telescope || TELESCOPES.Ariel);
  if (!tel) throw new Error('Unknown telescope: ' + o.telescope);
  const area = o.area ?? tel.area, thr = o.throughput ?? tel.throughput, floor = (o.noiseFloorPpm ?? tel.noiseFloorPpm ?? 0) * 1e-6, excess = o.excess ?? 0;
  const channels = o.channels || instrumentChannels(tel, o.bands, o.simR || {}), kind = o.kind || 'transit', sys = o.system, star = o.star;
  if (!(star.distance > 0)) throw new Error('The simulator needs the distance of the star (pc) to estimate photon noise.');
  const d = derived(sys), t14 = d.t14, cad = (o.cadence ?? 60) / 86400, duty = o.duty ?? 1;
  if (!(t14 > 0)) throw new Error('This planet does not transit with the given a/R* and inclination.');
  const half = t14 / 2 + (o.baselineHr ?? t14 * 24) / 24;
  let tc = sys.tmid; if (kind === 'eclipse') tc = sys.tmid + eclipseOffset(sys);
  const nT = Math.max(8, Math.round((2 * half) / cad)), time = Float64Array.from({ length: nT }, (_, i) => tc - half + (i + 0.5) * cad);
  const nW = channels.length, flux = new Float64Array(nT * nW), err = new Float64Array(nT * nW), rng = makeRng(o.seed ?? 1), truth = [];
  const depthOf = typeof o.depth === 'function' ? o.depth : o.depth ? (wl) => toySpectrum(wl, o.depth) : () => (kind === 'eclipse' ? (sys.fpfs ?? 1e-3) * sys.rprs * sys.rprs : sys.rprs * sys.rprs);
  const ns = autoSupersample(cad, sys), slope = (o.slopePpmPerHr || 0) * 1e-6 * 24;
  channels.forEach((ch, j) => {
    const depth = depthOf(ch.wl), ld = o.ldFor ? o.ldFor(ch.lo, ch.hi) : { law: 'quadratic', coeffs: [0.1, 0.1] };
    const Ne = photonRate(star, ch.lo, ch.hi) * area * thr * cad * 86400 * duty;
    const sigma = Math.sqrt((1 + excess) ** 2 / Ne + floor * floor * (t14 / cad));
    const tp = { rprs: kind === 'eclipse' ? sys.rprs : Math.sqrt(depth), ars: sys.ars, inc: sys.inc, per: sys.per, tmid: sys.tmid, ecc: sys.ecc || 0, omega: sys.omega || 0, ldLaw: ld.law, ld: ld.coeffs };
    const fn = kind === 'eclipse' ? makeEclipse({ ...tp, fpfs: depth / (sys.rprs * sys.rprs) }) : makeTransit(tp);
    for (let i = 0; i < nT; i++) {
      let m = 0; for (let k = 0; k < ns; k++) m += fn(time[i] + (k - (ns - 1) / 2) * (cad / ns)); m /= ns;
      if (kind === 'eclipse') m /= 1 + depth;               // normalised to the star plus planet outside eclipse
      flux[i * nW + j] = Ne * (m * (1 + slope * (time[i] - tc)) + sigma * rng.normal()); err[i * nW + j] = Ne * sigma;     // in electrons per exposure, so sums over channels are photon weighted
    }
    truth.push({ name: ch.name, wl: ch.wl, lo: ch.lo, hi: ch.hi, depth, [kind === 'eclipse' ? 'fpfs' : 'rprs']: kind === 'eclipse' ? depth / (sys.rprs * sys.rprs) : Math.sqrt(depth), sigma, electrons: Ne, ld });
  });
  const cube = { time, wave: Float64Array.from(channels, (c) => c.wl), lo: Float64Array.from(channels, (c) => c.lo), hi: Float64Array.from(channels, (c) => c.hi), flux, err, bad: new Uint8Array(nT * nW), nT, nW, exptime: cad,
    meta: { source: 'simulation', telescope: tel.name || 'custom', timeSystem: 'BJD_TDB', simulated: true, kind } };
  return { cube, truth, t14, inputs: { telescope: tel.name || 'custom', area_m2: area, throughput: thr, noise_floor_ppm: floor * 1e6, excess, cadence_s: cad * 86400, duty, kind, teff_K: star.teff, rstar_Rsun: star.rstar, distance_pc: star.distance, t14_d: t14, seed: o.seed ?? 1, slope_ppm_per_hr: o.slopePpmPerHr || 0 } };
}

/** Time from mid-transit to the next mid-eclipse (days): half a period for a circular orbit, shifted by about (2 P / pi) e cos(omega) otherwise. */
export function eclipseOffset(sys) {
  const e = sys.ecc || 0, w = ((sys.omega || 0) * Math.PI) / 180;
  return sys.per * (0.5 + (2 / Math.PI) * e * Math.cos(w));
}

// =================================================================================================
// Session

const arr = (a, d = 9) => Array.from(a, (x) => (Number.isFinite(x) ? +x.toPrecision(d) : null));

/**
 * A spectroscopic analysis as an ESL session document (docs/FORMAT.md). The white light curve is the session's
 * light curve, so the analyzer and runSession can open the file; everything else is in the "spectroscopy" block.
 * When a white-light fit exists the session's light curve is the DETRENDED one (flux / fitted baseline), because
 * the session format has no regressors; the raw one is kept in spectroscopy.white_light.
 *   st = { name, star, system (tmid absolute), kind, ldLaw, whiteLd, white (light curve), channels (light curves),
 *          bins (makeBins options), settings, whiteFit (fitWhiteLight result or null), spectrum (spectrumTable or null),
 *          source ({ kind, files, meta }), simulation (simulateSpectroscopy inputs + truth, or null) }
 */
export function spectroscopyToSession(st) {
  const wf = st.whiteFit, lc = st.white, sys = wf ? wf.values : st.system, tRef = Math.floor(lc.time[0]), law = st.ldLaw || 'quadratic';
  const P = { rprs: sys.rprs, ars: sys.ars, inc: sys.inc, per: sys.per, tmid: sys.tmid, ecc: sys.ecc || 0, omega: sys.omega || 0 };
  if (st.kind === 'eclipse') Object.assign(P, { fpfs: sys.fpfs ?? 1e-3, contrast: 0, hotspot: 0, h2c: 0, h2s: 0 });
  if (sys.mplanet > 0) P.mplanet = sys.mplanet;
  const dflt = defaultWhiteFree(lc, sys, st.kind);
  const doc = {
    format: 'esl-session', version: 1, software: { name: 'exoplanet-science-lab', page: 'observe/spectroscopy' }, created: st.created || new Date().toISOString(),
    name: st.name || 'spectroscopy', title: `${st.name || 'Spectroscopy'}: white light curve and ${st.kind === 'eclipse' ? 'emission' : 'transmission'} spectrum`, notes: '',
    star: { ...(st.star || {}) },
    limb_darkening: { law, mode: 'coeffs', band: 'Custom range', band_custom: [Math.round(lc.lo * 1000), Math.round(lc.hi * 1000)], coefficients: Array.from(st.whiteLd || []) },
    planets: [{ letter: 'b', parameters: P }], kepler: false, time_reference: tRef,
    data: { light_curve: { name: 'white light' + (wf ? ' (detrended)' : ''), time: arr(lc.time, 14), flux: arr(wf ? wf.detrended : lc.flux), flux_err: arr(wf ? Float64Array.from(lc.err, (e) => e * wf.errScale) : lc.err, 5), airmass: null, exposure_min: +(lc.exptime * 1440).toPrecision(6), epoch: null, epochs: [] }, radial_velocity: [], timing: [] },
    fit: { use: { lc: true, rv: false, timing: false }, free: (wf ? wf.free : dflt.free).map((f) => ({ key: f.key, prior: { ...f.prior } })), fixed: {}, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1000000 } },
    result: null,
    spectroscopy: {
      version: 1, kind: st.kind || 'transit', source: st.source || null, settings: st.settings || {}, bins: st.bins || null,
      white_light: { lo: lc.lo, hi: lc.hi, time: arr(lc.time, 14), flux: arr(lc.flux), flux_err: arr(lc.err, 5), exposure_min: +(lc.exptime * 1440).toPrecision(6), detrended_in_session: !!wf },
      white_fit: wf ? { parameters: wf.parameters, values: wf.values, depth: wf.depth, err_scale: wf.errScale, logZ: wf.logZ, ncalls: wf.ncalls, converged: wf.converged, baseline: wf.baselineKind, free: wf.free, ld: wf.ld, ld_law: wf.ldLaw, residual_rms: wf.stats.rms, expected_rms: wf.stats.expected, beta: wf.stats.beta } : null,
      channels: (st.channels || []).map((c) => ({ lo: c.lo, hi: c.hi, wl: c.wl, ncol: c.ncol ?? null, scale: c.scale ?? null, time: c.time.length === lc.time.length ? null : arr(c.time, 14), flux: arr(c.flux), flux_err: arr(c.err, 5) })),
      spectrum: st.spectrum || null, simulation: st.simulation || null,
    },
  };
  return doc;
}

/** The state spectroscopyToSession was given, from a session document. Throws when the document has no spectroscopy block. */
export function spectroscopyFromSession(doc) {
  const sp = doc && doc.spectroscopy;
  if (!doc || doc.format !== 'esl-session' || !sp) throw new Error('This file is not a spectroscopy session (an ESL session with a "spectroscopy" block).');
  if (sp.version > 1) throw new Error(`Spectroscopy block version ${sp.version} is newer than this build reads (1).`);
  const f64 = (a) => Float64Array.from(a, (x) => (x === null ? NaN : x)), wl = sp.white_light, time = f64(wl.time), ex = (wl.exposure_min || 0) / 1440;
  const white = { lo: wl.lo, hi: wl.hi, wl: 0.5 * (wl.lo + wl.hi), time, flux: f64(wl.flux), err: f64(wl.flux_err), exptime: ex };
  const P = doc.planets[0].parameters;
  return {
    name: doc.name, created: doc.created, star: { ...(doc.star || {}) }, system: { ...P }, kind: sp.kind || 'transit', ldLaw: doc.limb_darkening.law, whiteLd: doc.limb_darkening.coefficients || [],
    white, channels: (sp.channels || []).map((c) => ({ lo: c.lo, hi: c.hi, wl: c.wl, ncol: c.ncol, scale: c.scale, time: c.time ? f64(c.time) : time, flux: f64(c.flux), err: f64(c.flux_err), exptime: ex })),
    bins: sp.bins, settings: sp.settings || {}, source: sp.source, spectrum: sp.spectrum, simulation: sp.simulation, whiteFitSummary: sp.white_fit,
  };
}
