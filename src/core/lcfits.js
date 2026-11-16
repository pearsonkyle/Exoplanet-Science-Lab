// Light curves stored as FITS binary tables: TESS and Kepler/K2 light-curve files (SPOC, TESS-SPOC, QLP, K2SFF,
// EVEREST, ...) and any table with a time column and a flux column. The result is CSV text that the analyzer's
// parseLightCurve reads like any other file, so every later step is shared.
import { openFits, readBinTable } from './fits.js';
import { qualityBitmask } from './lcprep.js';

const TIME_COLS = ['TIME', 'BJD', 'BJD_TDB', 'BTJD', 'BKJD', 'JD', 'MJD', 'HJD', 'T'];
// flux columns in order of preference: systematics-corrected first
const FLUX_COLS = ['PDCSAP_FLUX', 'KSPSAP_FLUX', 'DET_FLUX', 'FCOR', 'FLUX', 'SAP_FLUX', 'FLUX_RAW', 'FRAW', 'F', 'DIFF', 'REL_FLUX'];
const ERR_OF = { PDCSAP_FLUX: ['PDCSAP_FLUX_ERR'], KSPSAP_FLUX: ['KSPSAP_FLUX_ERR'], DET_FLUX: ['DET_FLUX_ERR'], SAP_FLUX: ['SAP_FLUX_ERR'], FLUX: ['FLUX_ERR', 'FLUX_ERROR', 'ERR', 'E_FLUX'], FCOR: ['FCOR_ERR'], F: ['E', 'ERR', 'F_ERR'] };

/**
 * Read a light curve from a FITS file (ArrayBuffer, gzip allowed).
 * Time: TIME with BJDREFI + BJDREFF (TESS: BTJD = BJD_TDB - 2457000; Kepler: BKJD = BJD_TDB - 2454833), or a column
 * named for its system. Cadences with a non-zero QUALITY flag (opts.quality 'default'; 'none' keeps them), non-finite
 * time or flux are dropped. Flux is divided by its median (errors too).
 * opts.quality: undefined or 'any' drops a cadence with any QUALITY bit set (the analyzer's behaviour); 'none' keeps
 * them; 'default' | 'hard' | 'hardest' use lightkurve's bitmask for the mission (src/core/lcprep.js); a number is a bitmask.
 * The result also carries `arrays` (the kept rows: time in BJD, the column's flux and error before normalising, QUALITY),
 * which the photometry page stitches sector by sector.
 * @param opts { flux: column name to use, quality, hdu: index }
 * @returns { csv, meta: { object, mission, sector, quarter, campaign, author, fluxColumn, timeColumn, bjdRef, timeSystem,
 *            kept, dropped: { quality, nonfinite }, columns: [names], ra, dec, exptime } }
 */
export async function lightCurveFromFits(buffer, opts = {}) {
  const fits = await openFits(buffer);
  const idx = opts.hdu ?? fits.hdus.findIndex((u) => u.type === 'bintable');
  if (idx < 0) throw new Error('No table in this FITS file: is it an image? Open images on the Photometry page.');
  const T = readBinTable(fits, idx), H0 = fits.hdus[0].header || {}, H = { ...H0, ...T.header }, names = T.columns.map((c) => c.name.toUpperCase());
  const pick = (list) => list.find((n) => names.includes(n));
  const tName = pick(TIME_COLS); if (!tName) throw new Error(`No time column among ${names.join(', ')}.`);
  const fName = opts.flux ? String(opts.flux).toUpperCase() : pick(FLUX_COLS); if (!fName || !names.includes(fName)) throw new Error(`No flux column among ${names.join(', ')}.`);
  const eName = (ERR_OF[fName] || [fName + '_ERR']).find((n) => names.includes(n)) || (names.includes(fName + '_ERR') ? fName + '_ERR' : null);
  const qName = ['QUALITY', 'SAP_QUALITY', 'DQUALITY'].find((n) => names.includes(n));
  const t = T.column(tName), f = T.column(fName), e = eName ? T.column(eName) : null, qAll = qName ? T.column(qName) : null, q = qName && opts.quality !== 'none' ? qAll : null;
  const missionOf = String(H.MISSION || H.TELESCOP || '').trim();
  const qbits = opts.quality == null || opts.quality === 'any' ? 0x7fffffff : typeof opts.quality === 'number' ? opts.quality : opts.quality === 'none' ? 0 : qualityBitmask(/K2/i.test(missionOf) ? 'K2' : missionOf, opts.quality);
  const refI = Number(H.BJDREFI), refF = Number(H.BJDREFF), bjdRef = (Number.isFinite(refI) ? refI : 0) + (Number.isFinite(refF) ? refF : 0);
  const tsys = String(H.TIMESYS || '').trim().toUpperCase(), tref = String(H.TIMEREF || '').trim().toUpperCase();
  const barycentric = /SOLARSYSTEM|BARYCENT/.test(tref) || /^B(T|K)JD$|^BJD/.test(tName) || bjdRef > 2.4e6;
  // values recorded relative to a reference: add it back, so the CSV carries full BJD
  const offset = tName === 'TIME' && bjdRef > 0 ? bjdRef : tName === 'BTJD' ? 2457000 : tName === 'BKJD' ? 2454833 : 0;
  const rows = []; let dq = 0, dn = 0;
  for (let i = 0; i < T.nrows; i++) {
    if (q && (q[i] & qbits)) { dq++; continue; }
    const ti = t[i] + offset, fi = f[i], ei = e ? e[i] : NaN;
    if (!Number.isFinite(ti) || !Number.isFinite(fi)) { dn++; continue; }
    rows.push([ti, fi, ei, qAll ? qAll[i] : 0]);
  }
  if (rows.length < 3) throw new Error(`Only ${rows.length} usable rows in ${fName} (${dq} flagged, ${dn} without time or flux).`);
  const fs = rows.map((r) => r[1]).sort((a, b) => a - b), med = fs[fs.length >> 1] || 1;
  const scale = /^(F|DIFF|REL_FLUX|DET_FLUX|FCOR)$/.test(fName) && Math.abs(med - 1) < 0.2 ? 1 : med;   // already relative: keep it
  const sysName = barycentric ? (tsys === 'TDB' || !tsys ? 'BJD_TDB' : `BJD_${tsys}`) : (tsys ? `JD_${tsys}` : 'JD');
  const mission = String(H.MISSION || H.TELESCOP || '').trim(), author = String(H.ORIGIN || H.PROCVER || H.CREATOR || '').trim();
  const meta = {
    object: String(H.OBJECT || (H.TICID ? 'TIC ' + H.TICID : H.KEPLERID ? 'KIC ' + H.KEPLERID : '')).trim(), mission, author,
    sector: H.SECTOR ?? null, quarter: H.QUARTER ?? null, campaign: H.CAMPAIGN ?? null,
    fluxColumn: fName, errorColumn: eName, timeColumn: tName, bjdRef: offset, timeSystem: sysName, kept: rows.length,
    dropped: { quality: dq, nonfinite: dn }, columns: names, ra: Number(H.RA_OBJ ?? H.RA) || null, dec: Number(H.DEC_OBJ ?? H.DEC) || null,
    exptime: Number(H.EXPOSURE ?? H.TIMEDEL ?? H.INT_TIME) || null, normalisedBy: scale, qualityBitmask: q ? qbits : 0,
    cadenceDays: Number(H.TIMEDEL) || null,
  };
  const head = [`# ${meta.object || 'light curve'}${mission ? ' · ' + mission : ''}${meta.sector != null ? ' sector ' + meta.sector : meta.quarter != null ? ' quarter ' + meta.quarter : meta.campaign != null ? ' campaign ' + meta.campaign : ''}`,
    `# from the FITS column ${fName}${eName ? ' (errors ' + eName + ')' : ''}, divided by ${scale === 1 ? '1 (already relative)' : 'its median ' + scale.toPrecision(6)}; ${dq} cadences with a quality flag and ${dn} without time or flux left out`,
    `# time system ${sysName}${offset ? ` (FITS ${tName} + ${offset})` : ''}`, e ? `${sysName},flux,err` : `${sysName},flux`];
  const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : 'nan'), sig = (v) => (Number.isFinite(v) ? String(+v.toPrecision(10)) : 'nan');
  const csv = head.join('\n') + '\n' + rows.map((r) => (e ? `${fmt(r[0], 7)},${sig(r[1] / scale)},${sig(r[2] / scale)}` : `${fmt(r[0], 7)},${sig(r[1] / scale)}`)).join('\n') + '\n';
  const arrays = { time: Float64Array.from(rows, (r) => r[0]), flux: Float64Array.from(rows, (r) => r[1]), err: Float64Array.from(rows, (r) => r[2]), quality: Int32Array.from(rows, (r) => r[3]) };
  return { csv, meta, arrays };
}

/** True when the bytes look like FITS (a "SIMPLE  =" card) or gzip. */
export function looksLikeFits(buf) { const u = new Uint8Array(buf, 0, Math.min(9, buf.byteLength)); return (u[0] === 0x1f && u[1] === 0x8b) || String.fromCharCode(...u) === 'SIMPLE  ='; }
