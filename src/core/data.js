// Light curve inputs: synthetic generation and text parsing.

import { transitModel } from './transit.js';
import { toTransitParams, autoSupersample } from './model.js';
import { derived } from './kepler.js';
import { makeRng } from './stats.js';
import { utcToBjdTdb, tdbMinusUtc } from './fits.js';
import { earthHeliocentric } from './astro.js';
import { detrendFromColumns, gaussianWeights } from './detrend.js';

/**
 * Simulate an observation of the current system.
 * o: { exptimeMin, noisePpm, baselineHr (out-of-transit time on each side), airmass (bool), k, seed,
 *      nEpochs (transits observed, default 1), epochStep (orbits between them, default 1) }
 * The number of points follows from the length of the observation and the exposure.
 * With several epochs the first is at values.tmid, each has its own noise, and the result
 * carries the per-point epoch index (see combineEpochs).
 */
export function synthesize(values, ldLaw, o) {
  const n = Math.max(1, Math.min(200, Math.round(o.nEpochs || 1)));
  if (n === 1) return synthOne(values, ldLaw, o);
  const step = Math.max(1, Math.round(o.epochStep || 1)), parts = [];
  for (let j = 0; j < n; j++) parts.push({ ...synthOne({ ...values, tmid: values.tmid + j * step * values.per }, ldLaw, { ...o, seed: (o.seed ?? 1) + 7919 * j }), name: `transit ${j * step}` });
  return { ...combineEpochs(parts), name: `Synthetic observation · ${n} transits`, synthetic: true, exptimeMin: parts[0].exptimeMin };
}
function synthOne(values, ldLaw, o) {
  const rng = makeRng(o.seed ?? 1);
  const d = derived(values);
  const exp = Math.max(o.exptimeMin || 1, 0.05) / 1440;
  const half = Math.max((d.t14 || 0.08) / 2 + Math.max(o.baselineHr ?? 1, 0) / 24, 0.01);
  const n = Math.min(20000, Math.max(12, Math.round((2 * half) / exp)));
  const t = new Float64Array(n), f = new Float64Array(n), e = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = values.tmid - half + (2 * half * (i + 0.5)) / n;
  const m = transitModel(t, toTransitParams(values, ldLaw), null, { exptime: exp, supersample: autoSupersample(exp, values) });
  const sig = o.noisePpm * 1e-6;
  let airmass = null;
  if (o.airmass) {
    // target rises, culminates two thirds of the way through, then sets
    airmass = new Float64Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1) - 0.66) * 1.25; airmass[i] = 1.04 + 1.1 * x * x + 0.35 * x * x * x * x; }
  }
  for (let i = 0; i < n; i++) {
    const base = airmass ? Math.exp((o.k ?? 0) * airmass[i]) : 1;
    f[i] = m[i] * base + sig * rng.normal();
    e[i] = sig;
  }
  return { name: 'Synthetic observation', tRef: 0, t, f, e, airmass, synthetic: true, exptimeMin: exp * 1440 };
}

// ---- reading files ------------------------------------------------------------------

export const TIME_SYSTEMS = {
  jd:   { label: 'JD / BJD', offset: 0 },
  mjd:  { label: 'MJD (JD − 2400000.5)', offset: 2400000.5 },
  rjd:  { label: 'RJD (JD − 2400000)', offset: 2400000 },
  btjd: { label: 'BTJD, TESS (JD − 2457000)', offset: 2457000 },
  bkjd: { label: 'BKJD, Kepler (JD − 2454833)', offset: 2454833 },
  rel:  { label: 'Relative days', offset: 0 },
};
export const FLUX_UNITS = { flux: 'Flux', magnitude: 'Magnitude', millimagnitude: 'Millimagnitude' };

// ---- time standards ---------------------------------------------------------------------------------------------
// The offset (TIME_SYSTEMS) says where day zero is; the standard says what the days are: where the clock sits (Earth,
// Sun, barycentre) and which time scale it keeps (UTC, TDB). Fits want BJD_TDB. A JD in UTC differs from it by up to
// ±8.3 min plus 69 s, an HJD in UTC by up to ±4 s plus 69 s, a BJD in UTC by 69 s (in 2017-2026).
export const TIME_STANDARDS = {
  bjd_tdb: { label: 'BJD_TDB (barycentric, TDB)', frame: 'barycentric', scale: 'TDB' },
  bjd: { label: 'BJD, scale not stated (taken as TDB)', frame: 'barycentric', scale: 'TDB' },
  bjd_utc: { label: 'BJD_UTC (barycentric, UTC)', frame: 'barycentric', scale: 'UTC' },
  hjd_utc: { label: 'HJD_UTC (heliocentric, UTC)', frame: 'heliocentric', scale: 'UTC' },
  jd_utc: { label: 'JD_UTC (at the Earth, UTC)', frame: 'geocentric', scale: 'UTC' },
  jd: { label: 'JD, frame and scale not stated (taken as BJD_TDB)', frame: 'barycentric', scale: 'TDB' },
  unknown: { label: 'not stated (taken as BJD_TDB)', frame: 'barycentric', scale: 'TDB' },
};
/**
 * The time standard a file states, from the AAVSO DATE_TYPE line, the time column's name, and comment lines that
 * name it. `offsetKey` is the TIME_SYSTEMS key the reader chose (BTJD and BKJD are BJD_TDB by definition).
 * Returns { key, from } with key a TIME_STANDARDS key and `from` saying what it was read from.
 */
export function detectTimeStandard({ dateType = '', column = '', comments = [], offsetKey = '' } = {}) {
  if (offsetKey === 'btjd' || offsetKey === 'bkjd') return { key: 'bjd_tdb', from: offsetKey === 'btjd' ? 'TESS time (BTJD is BJD_TDB − 2457000)' : 'Kepler time (BKJD is BJD_TDB − 2454833)' };
  if (offsetKey === 'rel') return { key: 'unknown', from: 'relative days' };
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const read = (s) => {
    const x = norm(s);
    if (/bjdtdb|bjdtbd|tdbbjd/.test(x)) return 'bjd_tdb';
    if (/bjdutc|utcbjd/.test(x)) return 'bjd_utc';
    if (/hjd/.test(x)) return 'hjd_utc';   // HJD in another scale is rare; HJD_UTC is what IRAF and most pipelines wrote
    if (/bjd|barycentric/.test(x)) return 'bjd';
    if (/jdutc|utcjd|^mjdobs|^jdobs|^dateobs/.test(x)) return 'jd_utc';
    if (/^(time)?(m|r)?jd$|juliandate/.test(x)) return 'jd';   // "JD" alone is written for BJD_TDB as often as for UTC (EXOTIC's "Time (JD)" is BJD_TDB)
    return null;
  };
  if (dateType) { const k = read(dateType); if (k) return { key: k, from: `the file’s DATE_TYPE (“${String(dateType).trim()}”)` }; }
  if (column) { const k = read(column); if (k) return { key: k, from: `the time column’s name (“${column}”)` }; }
  for (const c of comments) { const m = String(c).match(/\b(BJD[_ ]?TDB|BJD[_ ]?UTC|HJD[_ ]?UTC|HJD|JD[_ ]?UTC)\b/i); if (m) return { key: read(m[1]), from: `a comment line (“${m[1]}”)` }; }
  return { key: 'unknown', from: 'nothing in the file' };
}
const C_AU_DAY_HEL = 173.1446326846693;
/** Light-travel time [days] from the Earth to the Sun's centre along a J2000 target direction (HJD − JD in one scale). */
export function heliocentricDelay(jdUtc, raDeg, decDeg) {
  const T = (jdUtc + tdbMinusUtc(jdUtc) - 2451545.0) / 36525, p = earthHeliocentric(T), a = (raDeg * Math.PI) / 180, d = (decDeg * Math.PI) / 180;
  return (p[0] * Math.cos(d) * Math.cos(a) + p[1] * Math.cos(d) * Math.sin(a) + p[2] * Math.sin(d)) / C_AU_DAY_HEL;
}
/**
 * One absolute time in a TIME_STANDARDS standard -> BJD_TDB, for a target at J2000 ra, dec (degrees).
 * JD_UTC: leap seconds, TT − UTC, TDB − TT and the barycentric light time (src/core/fits.js utcToBjdTdb, the photometry
 * page's conversion). HJD_UTC: the heliocentric light time is taken off first (two iterations). BJD_UTC: TDB − UTC only.
 */
export function toBjdTdb(t, standard, raDeg, decDeg) {
  if (standard === 'jd_utc') return utcToBjdTdb(t, raDeg, decDeg);
  if (standard === 'hjd_utc') { let jd = t - heliocentricDelay(t, raDeg, decDeg); jd = t - heliocentricDelay(jd, raDeg, decDeg); return utcToBjdTdb(jd, raDeg, decDeg); }
  if (standard === 'bjd_utc') return t + tdbMinusUtc(t);
  return t;
}
const needsConversion = (k) => k === 'jd_utc' || k === 'hjd_utc' || k === 'bjd_utc';
const needsPosition = (k) => k === 'jd_utc' || k === 'hjd_utc';

/** EXOTIC's flux_conversion(): differential magnitudes to flux, error as the geometric mean of the two sides. */
function magToFlux(m, s, conv) {
  const f = Math.pow(10, -0.4 * (m / conv));
  return [f, Math.sqrt(Math.abs(Math.pow(10, -0.4 * ((m + s) / conv)) - f) * Math.abs(Math.pow(10, -0.4 * ((m - s) / conv)) - f))];
}

/**
 * Parse a light curve from text. Understands:
 *   - comma, semicolon, tab, pipe or whitespace separated columns (or an AAVSO "#DELIM=" line)
 *   - a header row, or a header written as the last comment line
 *     ("#DATE,DIFF,ERR,DETREND_1,DETREND_2", "# BJD_TDB,Orbital Phase,Flux,Uncertainty,Model,Airmass")
 *   - AAVSO exoplanet reports and EXOTIC FinalLightCurve files, including their "#KEY=VALUE" metadata
 *   - time in JD/BJD, MJD, RJD, BTJD, BKJD or relative days; flux, magnitudes or millimagnitudes
 * opts.time / opts.flux override the automatic guess ('auto' or a key of TIME_SYSTEMS / FLUX_UNITS).
 * Time standard: read from DATE_TYPE, the time column's name or comments (detectTimeStandard), or opts.timeStandard
 * (a TIME_STANDARDS key). JD_UTC, HJD_UTC and BJD_UTC are converted to BJD_TDB when opts.coords = { ra, dec } (J2000
 * degrees) is given (BJD_UTC needs no position); otherwise a note says plainly that they were not. opts.convertTime
 * false keeps the times as they are. The result carries timeStandard, timeStandardFrom, timeConverted, timeShiftSec.
 * Returns { t, f, e, airmass|null, tRef, timeSystem, fluxUnits, meta, notes } or throws a readable error.
 */
export function parseLightCurve(text, name = 'Uploaded light curve', opts = {}) {
  const all = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!all.length) throw new Error('The file is empty.');
  const meta = {}, notes = [], comments = [], rowsTxt = [];
  for (const l of all) {
    if (/^[#%!]/.test(l)) {
      const m = l.match(/^#\s*([A-Za-z_\-]+)\s*=\s*(.*)$/);
      if (m) meta[m[1].toUpperCase()] = m[2].trim(); else comments.push(l.replace(/^[#%!]+\s*/, ''));
    } else rowsTxt.push(l);
  }
  if (!rowsTxt.length) throw new Error('No data rows found (every line is a comment).');
  // delimiter: the declared one, else whichever splits the first data row into the most fields
  const probe = rowsTxt[Math.min(1, rowsTxt.length - 1)];
  let delim = meta.DELIM && meta.DELIM.length === 1 ? meta.DELIM : [',', ';', '\t', '|'].map((d) => [d, probe.split(d).length]).sort((a, b) => b[1] - a[1])[0];
  if (Array.isArray(delim)) delim = delim[1] > 1 ? delim[0] : null;
  const split = (l) => (delim ? l.split(delim).map((c) => c.trim()) : l.split(/\s+/));
  const isNum = (s) => s !== '' && Number.isFinite(Number(s));
  const ncol = split(probe).length;
  // header: first data row if it is not numeric, otherwise the last comment line with the right number of names
  let head = null, start = 0;
  if (split(rowsTxt[0]).some((c) => !isNum(c))) { head = split(rowsTxt[0]); start = 1; }
  else for (let i = comments.length - 1; i >= 0 && !head; i--) { const c = split(comments[i]); if (c.length === ncol && c.every((x) => x && !isNum(x))) head = c; }
  let col = { t: 0, f: 1, e: ncol > 2 ? 2 : -1, am: ncol > 3 ? 3 : -1 };
  let headTime = '', headFlux = '', headTimeRaw = '';
  if (head) {
    const hl = head.map((x) => x.toLowerCase().replace(/[\s_\-()\[\]]+/g, ''));
    const find = (re, not) => hl.findIndex((x) => re.test(x) && !(not && not.test(x)));
    const ct = find(/^(time|date|bjd|hjd|jd|mjd|rjd|btjd|bkjd|t|epoch)/, /err|unc/), ce = find(/err|unc|sig|^e$|std|ferr|merr/);
    const cf = find(/flux|^diff$|^mag|mmag|^f$|rel|counts|^y$/, /err|unc|sig|model|phase/);
    const final = hl.some((x) => /phase/.test(x)) && hl.some((x) => /^model$/.test(x));   // EXOTIC FinalLightCurve: already detrended
    const ca = final ? -1 : find(/airmass|secz|^am$|^detrend1$/);
    if (ct >= 0 && cf >= 0) { col = { t: ct, f: cf, e: ce, am: ca }; headTime = hl[ct]; headFlux = hl[cf]; headTimeRaw = head[ct]; }
    if (final) notes.push('EXOTIC final light curve: flux is already detrended, so its airmass-model column is ignored');
  }
  // further numeric columns (centroids, sky, FWHM, ...) are kept by name for detrending (applyDetrend)
  const extra = head ? head.map((nm, i) => [colName(nm), i]).filter(([nm, i]) => nm && ![col.t, col.f, col.e, col.am].includes(i)) : [];
  const X = Object.fromEntries(extra.map(([nm]) => [nm, []]));
  const T = [], F = [], E = [], A = []; let bad = 0;
  for (let i = start; i < rowsTxt.length; i++) {
    const p = split(rowsTxt[i]).map((c) => (c === '' ? NaN : Number(c)));
    const tt = p[col.t], ff = p[col.f];
    if (!Number.isFinite(tt) || !Number.isFinite(ff)) { bad++; continue; }
    T.push(tt); F.push(ff);
    E.push(col.e >= 0 && Number.isFinite(p[col.e]) && p[col.e] > 0 ? p[col.e] : NaN);
    A.push(col.am >= 0 && Number.isFinite(p[col.am]) ? p[col.am] : NaN);
    for (const [nm, i] of extra) X[nm].push(Number.isFinite(p[i]) ? p[i] : NaN);
  }
  if (T.length < 10) throw new Error('Found fewer than 10 numeric rows. Expected columns: time, flux, error, airmass.');
  if (bad) notes.push(`${bad} unreadable row${bad > 1 ? 's' : ''} skipped`);

  // ---- time system
  const tmed = T.slice().sort((a, b) => a - b)[T.length >> 1];
  const dateType = (meta.DATE_TYPE || '').toLowerCase() + ' ' + headTime;
  let ts = opts.time && opts.time !== 'auto' ? opts.time
    : /btjd/.test(dateType) ? 'btjd' : /bkjd/.test(dateType) ? 'bkjd' : /mjd/.test(dateType) ? 'mjd' : /rjd/.test(dateType) ? 'rjd'
    : tmed > 2.3e6 ? 'jd' : tmed > 4e4 && tmed < 8e4 ? 'mjd' : tmed > 1000 && tmed < 5000 ? 'btjd' : 'rel';
  const tOff = TIME_SYSTEMS[ts].offset;

  // ---- flux units
  const fs = F.slice().sort((a, b) => a - b), fmed = fs[F.length >> 1], fspread = fs[Math.floor(0.9 * (F.length - 1))] - fs[Math.floor(0.1 * (F.length - 1))];
  const fluxHint = (meta.MEASUREMENT_TYPE || '').toLowerCase() + ' ' + headFlux;
  let fu = opts.flux && opts.flux !== 'auto' ? opts.flux
    : /mmag|millimag/.test(fluxHint) ? 'millimagnitude' : /mag/.test(fluxHint) ? 'magnitude' : /flux|rnflux/.test(fluxHint) ? 'flux'
    : fs[0] < 0 && Math.abs(fmed) < 0.5 ? (fspread > 2 ? 'millimagnitude' : 'magnitude')      // differential magnitudes scatter about zero
    : fmed > 5 && fmed < 25 && fspread < 1 ? 'magnitude' : 'flux';
  if (!(opts.flux && opts.flux !== 'auto') && fu !== 'flux' && !/mag/.test(fluxHint)) notes.push(`values look like ${fu}s; change the flux units below if that is wrong`);

  const idx = T.map((_, i) => i).sort((a, b) => T[a] - T[b]);
  // drop exact duplicate times
  const keep = idx.filter((j, i) => i === 0 || T[j] !== T[idx[i - 1]]);
  if (keep.length < idx.length) notes.push(`${idx.length - keep.length} duplicate time stamps removed`);
  const n = keep.length;
  // ---- time standard: what the days are (BJD_TDB, HJD_UTC, JD_UTC, ...), converted to BJD_TDB when the target is known
  const det = opts.timeStandard && opts.timeStandard !== 'auto' && TIME_STANDARDS[opts.timeStandard] ? { key: opts.timeStandard, from: 'your choice' } : detectTimeStandard({ dateType: meta.DATE_TYPE || '', column: headTimeRaw, comments, offsetKey: ts });
  const co = opts.coords || {}, havePos = Number.isFinite(co.ra) && Number.isFinite(co.dec);
  const absT = keep.map((j) => T[j] + tOff), dated = absT[0] > 2e6;
  let converted = false, shift = 0;
  if (dated && needsConversion(det.key) && opts.convertTime !== false && (havePos || !needsPosition(det.key))) {
    for (let i = 0; i < n; i++) absT[i] = toBjdTdb(absT[i], det.key, co.ra, co.dec);
    shift = (absT[0] - (T[keep[0]] + tOff)) * 86400; converted = true;
    notes.push(`times read as ${TIME_STANDARDS[det.key].label.split(' (')[0]} (from ${det.from}) and converted to BJD_TDB${havePos ? ` for RA ${co.ra.toFixed(4)}°, Dec ${co.dec.toFixed(4)}°` : ''}: ${shift >= 0 ? '+' : '−'}${Math.abs(shift).toFixed(1)} s at the first point`);
  } else if (dated && needsConversion(det.key)) {
    notes.push(`times are ${TIME_STANDARDS[det.key].label.split(' (')[0]} (from ${det.from}) and were NOT converted to BJD_TDB because ${opts.convertTime === false ? 'conversion was switched off' : 'the target’s coordinates are not known'}: mid-transit times are off by up to ${det.key === 'jd_utc' ? '8.3 min' : det.key === 'hjd_utc' ? '4 s' : '0 s'} plus 69 s. Look the planet up (Start page) or give its RA and Dec, then load the file again`);
  } else if (dated && (det.key === 'unknown' || det.key === 'jd')) notes.push(`${det.key === 'jd' ? `times are labelled JD (from ${det.from}) without saying where or in which scale` : 'the file does not say which time standard it uses'}: taken as BJD_TDB. If they are JD or HJD in UTC, choose that under “Time standard” below and they are converted`);
  else if (dated && det.key === 'bjd') notes.push(`times are BJD (from ${det.from}); the time scale is not stated and is taken as TDB`);
  const abs0 = absT[0], tRef = abs0 > 1000 ? Math.floor(abs0) : 0;
  const t = new Float64Array(n), f = new Float64Array(n), e = new Float64Array(n);
  const hasAm = A.every((a) => Number.isFinite(a)) && new Set(A).size > 1;
  const airmass = hasAm ? new Float64Array(n) : null;
  const conv = fu === 'millimagnitude' ? 1000 : 1;
  keep.forEach((j, i) => {
    t[i] = absT[i] - tRef;
    if (fu === 'flux') { f[i] = F[j]; e[i] = E[j]; } else { const [ff, ee] = magToFlux(F[j], Number.isFinite(E[j]) ? E[j] : NaN, conv); f[i] = ff; e[i] = ee; }
    if (airmass) airmass[i] = A[j];
  });
  if (fu !== 'flux') notes.push(`${fu}s converted to flux as EXOTIC does`);
  const med = Float64Array.from(f).sort()[n >> 1];
  if (!(med > 0)) throw new Error('Flux must be positive. If this file holds magnitudes, set the flux units to magnitude.');
  if (Math.abs(med - 1) > 0.02 || fu !== 'flux') { for (let i = 0; i < n; i++) { f[i] /= med; e[i] /= med; } if (Math.abs(med - 1) > 0.02) notes.push(`flux divided by its median (${med.toPrecision(4)})`); }
  if (e.some((x) => !Number.isFinite(x) || x <= 0)) {
    // no usable error column: estimate white noise from point-to-point differences
    const dif = []; for (let i = 1; i < n; i++) dif.push(Math.abs(f[i] - f[i - 1]));
    dif.sort((a, b) => a - b);
    const s = (1.4826 * dif[dif.length >> 1]) / Math.SQRT2;
    e.fill(s > 0 ? s : 1e-3);
    notes.push(`no usable error column: using ${(e[0] * 1e6).toFixed(0)} ppm estimated from point-to-point scatter`);
  }
  if (tRef) notes.push(`times shown as ${ts === 'jd' ? 'JD' : 'JD (from ' + TIME_SYSTEMS[ts].label.split(',')[0].split(' (')[0] + ')'} − ${tRef}`);

  // ---- metadata worth carrying into the app
  const out = { name: meta.EXOPLANET_NAME ? `${meta.EXOPLANET_NAME} — ${name}` : name, tRef, t, f, e, airmass, notes, timeSystem: ts, fluxUnits: fu, meta: {},
    timeStandard: det.key, timeStandardFrom: det.from, timeConverted: converted, timeShiftSec: shift, ...(converted && havePos ? { timeCoords: { ra: co.ra, dec: co.dec } } : {}) };
  const usable = extra.filter(([nm]) => X[nm].some(Number.isFinite) && new Set(X[nm].filter(Number.isFinite)).size > 1);
  if (usable.length) { out.columns = Object.fromEntries(usable.map(([nm]) => [nm, Float64Array.from(keep, (j) => X[nm][j])])); notes.push(`further columns kept for detrending: ${usable.map(([nm]) => nm).join(', ')}`); }
  if (meta.EXOPLANET_NAME) out.meta.planet = meta.EXOPLANET_NAME;
  if (meta.FILTER) out.meta.filter = meta.FILTER;
  const ex = Number(meta.EXPOSURE_TIME); if (ex > 0) out.meta.exptimeMin = ex / 60;
  if (meta.PRIORS) {
    const pr = {}, grab = (re, key) => { const m = meta.PRIORS.match(re); if (m && Number.isFinite(Number(m[1]))) pr[key] = Number(m[1]); };
    grab(/Period=([-\d.eE+]+)/, 'per'); grab(/Rp\/R\*=([-\d.eE+]+)/, 'rprs'); grab(/a\/R\*=([-\d.eE+]+)/, 'ars'); grab(/inc=([-\d.eE+]+)/, 'inc'); grab(/ecc=([-\d.eE+]+)/, 'ecc');
    for (let i = 0; i < 4; i++) grab(new RegExp(`u${i}=([-\\d.eE+]+)`), 'ld' + i);
    if (Object.keys(pr).length) out.meta.priors = pr;
  }
  if (meta.RESULTS) { const m = meta.RESULTS.match(/Tc=([-\d.eE+]+)/); if (m) out.meta.tmid = (converted ? toBjdTdb(Number(m[1]), det.key, co.ra, co.dec) : Number(m[1])) - tRef; }
  return out;
}

/** A column header as a detrending name: centroids are xc and yc, background sky, PSF width fwhm; others lower-cased. */
export function colName(h) {
  const x = String(h || '').toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '');
  if (!x || /^(phase|orbitalphase|model|epoch|flag|quality)$/.test(x)) return null;
  if (/^(xc|xcen|xcentroid|centroidx|x|xpos|xcent)$/.test(x)) return 'xc';
  if (/^(yc|ycen|ycentroid|centroidy|y|ypos|ycent)$/.test(x)) return 'yc';
  if (/^(sky|bkg|background|skybkg|skybackground)$/.test(x)) return 'sky';
  if (/^(fwhm|psffwhm|seeing)$/.test(x)) return 'fwhm';
  return x;
}

/**
 * A light curve with its systematics model: from `d.columns` (one array per point, by name) and `detrend` =
 * { columns: [names], poly: 0-3, pld: ['pld1', ...], kernel: null | { features: [names], neighbors } } (src/core/detrend.js).
 * Returns a NEW dataset carrying `detrend`, `regressors` (standardised within each epoch) or null, `kernel` (built epoch by
 * epoch, so no point borrows neighbours from another night; its n is the number of points) or null, and
 * `detrendInfo` { names, dropped: [{ name, why }], kernel: features | null }. A null `detrend` takes the model off.
 */
export function applyDetrend(d, detrend) {
  const out = { ...d }; delete out.regressors; delete out.kernel; delete out.detrendInfo;
  if (!detrend || !d.columns) { out.detrend = detrend && !d.columns ? detrend : null; if (detrend && !d.columns) out.detrendInfo = { names: [], dropped: [{ name: 'all', why: 'the light curve carries no detrending columns' }], kernel: null }; return out; }
  const cols = d.columns, epoch = d.epoch || null, n = d.t.length;
  const r = detrendFromColumns(cols, { ...detrend, kernel: null }, d.t, epoch);
  let kernel = null, kfeat = null;
  const kd = detrend.kernel;
  if (kd && kd.features && kd.features.length) {
    kfeat = kd.features.filter((nm) => cols[nm] && Array.prototype.every.call(cols[nm], Number.isFinite));
    for (const nm of kd.features) if (!kfeat.includes(nm)) r.dropped.push({ name: 'kernel ' + nm, why: cols[nm] ? 'has missing values' : 'not in the data' });
    if (kfeat.length) {
      const ne = epoch ? Math.max(...epoch) + 1 : 1, groups = Array.from({ length: ne }, () => []);
      for (let i = 0; i < n; i++) groups[epoch ? epoch[i] : 0].push(i);
      const k = Math.max(1, Math.min(kd.neighbors ?? 50, ...groups.map((g) => g.length - 1)));
      const idx = new Int32Array(n * k), w = new Float64Array(n * k);
      for (const g of groups) {
        if (g.length < 2) continue;
        const gw = gaussianWeights(kfeat.map((nm) => Float64Array.from(g, (i) => cols[nm][i])), { neighbors: k, w: kd.w ?? 1 });
        g.forEach((i, a) => { for (let q = 0; q < k; q++) { idx[i * k + q] = g[gw.idx[a * gw.k + q]]; w[i * k + q] = gw.w[a * gw.k + q]; } });
      }
      kernel = { idx, w, k, n };
    } else kfeat = null;
  }
  out.detrend = detrend; out.regressors = r.regressors; out.kernel = kernel;
  out.detrendInfo = { names: r.names, dropped: r.dropped, kernel: kfeat };
  return out;
}

/** Move tmid by whole periods so the nearest transit falls inside the data. */
export function nearestEpoch(tmid, per, t) {
  const mid = 0.5 * (t[0] + t[t.length - 1]);
  return tmid + per * Math.round((mid - tmid) / per);
}

// ---- several epochs in one dataset --------------------------------------------------

/** Start, end, size and airmass flag of each epoch of a dataset (one entry when it has no epoch index). */
export function epochList(d) {
  if (!d.epoch) return [{ name: d.name, n: d.t.length, t0: d.t[0], t1: d.t[d.t.length - 1], airmass: !!d.airmass }];
  return d.segments;
}

/**
 * Merge light curves of the same planet into one dataset. Each input (itself possibly made of
 * several epochs) keeps its own epochs, so each keeps its own baseline in the fit.
 * Times are put on the reference of the earliest input and sorted; `epoch` holds each point's
 * epoch index and `segments` describes the epochs, ordered by start time. Points of epochs
 * without an airmass column get airmass 0, which leaves their baseline flat.
 */
export function combineEpochs(list) {
  if (!list.length) throw new Error('nothing to combine');
  const dated = list.filter((d) => d.tRef > 0).length;
  if (dated && dated < list.length) throw new Error('Cannot combine light curves with Julian dates and light curves with relative times: the gap between them is unknown.');
  const tRef = Math.min(...list.map((d) => d.tRef || 0));
  const segs = [];
  for (const d of list) {
    const off = (d.tRef || 0) - tRef, parts = epochList(d);
    parts.forEach((p, s) => {
      const idx = []; for (let i = 0; i < d.t.length; i++) if (!d.epoch || d.epoch[i] === s) idx.push(i);
      if (idx.length) segs.push({ d, idx, off, name: d.epoch ? p.name : d.name, airmass: !!(d.airmass && p.airmass), t0: d.t[idx[0]] + off });
    });
  }
  segs.sort((a, b) => a.t0 - b.t0);
  // detrending columns survive when every input has them (by name: the ones all share)
  const cnames = list.every((d) => d.columns) ? Object.keys(list[0].columns).filter((nm) => list.every((d) => d.columns[nm])) : [];
  const rows = [];
  segs.forEach((sg, s) => { for (const i of sg.idx) rows.push([sg.d.t[i] + sg.off, sg.d.f[i], sg.d.e[i], sg.airmass ? sg.d.airmass[i] : 0, s, cnames.map((nm) => sg.d.columns[nm][i])]); });
  rows.sort((a, b) => a[0] - b[0] || a[4] - b[4]);
  const n = rows.length, t = new Float64Array(n), f = new Float64Array(n), e = new Float64Array(n), am = new Float64Array(n), epoch = new Int32Array(n);
  const segments = segs.map((sg) => ({ name: sg.name, n: 0, t0: Infinity, t1: -Infinity, airmass: sg.airmass }));
  rows.forEach((r, i) => { t[i] = r[0]; f[i] = r[1]; e[i] = r[2]; am[i] = r[3]; epoch[i] = r[4]; const sg = segments[r[4]]; sg.n++; sg.t0 = Math.min(sg.t0, r[0]); sg.t1 = Math.max(sg.t1, r[0]); });
  const any = segments.some((sg) => sg.airmass);
  const columns = cnames.length ? Object.fromEntries(cnames.map((nm, c) => [nm, Float64Array.from(rows, (r) => r[5][c])])) : null;
  const detrend = columns ? (list.find((d) => d.detrend) || {}).detrend || null : null;
  if (segments.length === 1) return { name: segments[0].name, tRef, t, f, e, airmass: any ? am : null, notes: list[0].notes || [], ...(columns ? { columns, detrend } : {}) };
  return { name: `${segments.length} epochs`, tRef, t, f, e, airmass: any ? am : null, epoch, segments, notes: [...new Set(list.flatMap((d) => d.notes || []))], ...(columns ? { columns, detrend } : {}) };
}

/** The dataset without one of its epochs. */
export function removeEpoch(d, s) {
  if (!d.epoch || d.segments.length < 2) throw new Error('only one epoch');
  const parts = d.segments.map((sg, k) => ({ ...pickEpoch(d, k), name: sg.name })).filter((_, k) => k !== s);
  return combineEpochs(parts);
}
function pickEpoch(d, s) {
  const idx = []; for (let i = 0; i < d.t.length; i++) if (d.epoch[i] === s) idx.push(i);
  const take = (a) => Float64Array.from(idx, (i) => a[i]);
  return { tRef: d.tRef, t: take(d.t), f: take(d.f), e: take(d.e), airmass: d.airmass && d.segments[s].airmass ? take(d.airmass) : null, notes: d.notes, ...takeColumns(d, take) };
}

/**
 * Give every orbit covered by a long light curve its own epoch (and so its own baseline):
 * the epoch of a point is the whole number of periods between it and tmid. Returns the
 * dataset unchanged when it covers a single orbit. Only orbits with at least minPoints are kept.
 */
export function splitByOrbit(d, per, tmid, minPoints = 5) {
  const groups = new Map();
  for (let i = 0; i < d.t.length; i++) { const E = Math.round((d.t[i] - tmid) / per); if (!groups.has(E)) groups.set(E, []); groups.get(E).push(i); }
  const keep = [...groups.entries()].filter(([, idx]) => idx.length >= minPoints).sort((a, b) => a[0] - b[0]);
  if (keep.length < 2) return d;
  const E0 = keep[0][0];
  const parts = keep.map(([E, idx]) => { const take = (a) => Float64Array.from(idx, (i) => a[i]); return { name: `orbit ${E - E0}`, tRef: d.tRef, t: take(d.t), f: take(d.f), e: take(d.e), airmass: d.airmass ? take(d.airmass) : null, notes: d.notes, ...takeColumns(d, take) }; });
  return { ...combineEpochs(parts), name: d.name };
}

/** The detrending columns (and their settings) of a subset of the points: { columns, detrend } or nothing. */
export function takeColumns(d, take) { return d.columns ? { columns: Object.fromEntries(Object.entries(d.columns).map(([nm, a]) => [nm, take(a)])), detrend: d.detrend || null } : {}; }

/** Times folded on the period: each is moved by whole periods to within half a period of tmid. */
export function foldTimes(t, per, tmid) {
  return Float64Array.from(t, (x) => { const p = (x - tmid) / per; return tmid + (p - Math.round(p)) * per; });
}

// ---- radial velocities ---------------------------------------------------------------

/**
 * Read radial velocities from text: columns time, velocity, uncertainty and optionally an
 * instrument name, in any order when there is a header ("BJD,Vel(m/s),ErrVel(m/s),Telescope"),
 * otherwise in that order. Rows are grouped by instrument, because each has its own zero point.
 * Velocities are returned in m/s (a header mentioning km/s converts). Times are absolute days.
 * Returns { sets: [{ name, t, v, e }], notes }.
 */
export function parseRV(text, name = 'RV') {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[#%!]/.test(l));
  if (!lines.length) throw new Error('No rows found.');
  const delim = [',', ';', '\t', '|'].map((d) => [d, lines[Math.min(1, lines.length - 1)].split(d).length]).sort((a, b) => b[1] - a[1])[0];
  const split = (l) => (delim[1] > 1 ? l.split(delim[0]) : l.split(/\s+/)).map((c) => c.trim());
  const isNum = (s) => s !== '' && Number.isFinite(Number(s));
  let head = null, start = 0;
  const first = split(lines[0]);
  if (first.filter(isNum).length < 2) { head = first.map((x) => x.toLowerCase()); start = 1; }
  let ct = 0, cv = 1, ce = 2, cn = -1, kms = false;
  const ncol = split(lines[start] || '').length;
  if (head) {
    const find = (re, not) => head.findIndex((x) => re.test(x) && !(not && not.test(x)));
    const e = find(/err|unc|sig|^e_|std/), v = find(/vel|^rv|mnvel|radial/, /err|unc|sig|^e_/), t = find(/bjd|hjd|jd|time|date|^t$|epoch/, /err|unc/), n = find(/tel|inst|source|obs|name|spectrograph/);
    if (t >= 0 && v >= 0) { ct = t; cv = v; ce = e; cn = n; }
    kms = /km/.test(head[cv] || '');
  } else {
    // no header: a column that is not numeric holds the instrument name
    const probe = split(lines[start]); cn = probe.findIndex((x) => !isNum(x));
    const nums = probe.map((_, i) => i).filter((i) => i !== cn); [ct, cv, ce] = [nums[0], nums[1], nums[2] ?? -1];
  }
  if (ncol < 2) throw new Error('Expected columns: time, velocity, uncertainty, and optionally the instrument.');
  const groups = new Map(), seen = new Set(); let bad = 0, dup = 0;
  for (let i = start; i < lines.length; i++) {
    const c = split(lines[i]), t = Number(c[ct]), v = Number(c[cv]), e = ce >= 0 ? Number(c[ce]) : NaN;
    if (!Number.isFinite(t) || !Number.isFinite(v)) { bad++; continue; }
    const g = cn >= 0 && c[cn] ? c[cn] : name, key = g + '|' + t;
    if (seen.has(key)) { dup++; continue; } seen.add(key);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([t, v * (kms ? 1000 : 1), e * (kms ? 1000 : 1)]);
  }
  const notes = [];
  if (bad) notes.push(`${bad} unreadable row${bad > 1 ? 's' : ''} skipped`);
  if (dup) notes.push(`${dup} repeated row${dup > 1 ? 's' : ''} dropped`);
  if (kms) notes.push('km/s converted to m/s');
  const tsd = head ? detectTimeStandard({ column: head[ct] || '' }) : { key: 'unknown', from: 'no header' };
  if (needsConversion(tsd.key)) notes.push(`times are ${TIME_STANDARDS[tsd.key].label.split(' (')[0]} (from ${tsd.from}): velocities are fitted as if they were BJD_TDB, which shifts them by up to ${tsd.key === 'jd_utc' ? '8.3 min' : '69 s'}; negligible for orbits of days unless the light curve times them`);
  const sets = [];
  for (const [g, rows] of groups) {
    rows.sort((a, b) => a[0] - b[0]);
    let e = rows.map((r) => r[2]);
    if (e.some((x) => !(x > 0))) {
      // no usable uncertainties: the scatter about the mean is a (generous) stand-in until a jitter is fitted
      const m = rows.reduce((a, r) => a + r[1], 0) / rows.length, s = Math.sqrt(rows.reduce((a, r) => a + (r[1] - m) ** 2, 0) / Math.max(1, rows.length - 1)) || 1;
      e = rows.map(() => s); notes.push(`${g}: no uncertainties, using the scatter (${s.toFixed(1)} m/s)`);
    }
    sets.push({ name: g, t: Float64Array.from(rows, (r) => r[0]), v: Float64Array.from(rows, (r) => r[1]), e: Float64Array.from(e) });
  }
  if (!sets.length || sets.every((s) => s.t.length < 2)) throw new Error('Found fewer than two velocities.');
  sets.sort((a, b) => a.t[0] - b.t[0]);
  return { sets, notes, timeStandard: tsd.key };
}
