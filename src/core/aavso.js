// The AAVSO Exoplanet Watch report that EXOTIC writes for a ground-based light curve (exotic/output_files.py,
// OutputFiles.aavso and aavso_dicts; exotic/utils.py round_to_2), reproduced character for character so a reduction
// made here can be submitted to the AAVSO Exoplanet Database the same way. No DOM.
// Checked in test/aavso.test.mjs against EXOTIC's own OutputFiles.aavso run in its conda environment
// (test/make_aavso_reference.py).

/** Python's repr() of a float (what an f-string prints): shortest round trip, '.0' on integers, exponent below 1e-4 or from 1e16. */
export function pyFloat(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const a = Math.abs(x);
  if (a >= 1e16 || a < 1e-4) {
    const [m, e] = x.toExponential().split('e'), ev = Number(e);
    return `${m}e${ev < 0 ? '-' : '+'}${String(Math.abs(ev)).padStart(2, '0')}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : s + '.0';
}

/** Python's round(x, n) for a float: the exact binary value rounded to n decimals, ties to even. */
export function pyRound(x, n) {
  if (!Number.isFinite(x)) return x;
  if (n > 20 || n < -20) return x;
  if (n < 0) { const p = 10 ** -n, q = x / p, r = Math.round(q); return (Math.abs(q - Math.trunc(q)) === 0.5 ? 2 * Math.round(q / 2) : r) * p; }
  // exact decimal expansion (toFixed gives the exactly rounded digits; 60 more than needed show a tie)
  const s = Math.abs(x).toFixed(Math.min(100, n + 60)), dot = s.indexOf('.'), keep = s.slice(0, dot + 1 + n), rest = s.slice(dot + 1 + n);
  let up;
  if (rest[0] > '5') up = true; else if (rest[0] < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else { const last = keep.replace('.', '').slice(-1); up = Number(last) % 2 === 1; }       // an exact tie: to even
  let v = Number(keep.endsWith('.') ? keep.slice(0, -1) : keep);
  if (up) v = Number((v + 10 ** -n).toFixed(n));
  return x < 0 ? -v : v;
}

/** numpy's round(x, n) for a float64 (np.round, and round() of an np.float64): rint(x * 10^n) / 10^n, half to even on the product. */
export function npRound(x, n) {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** Math.abs(n), y = n >= 0 ? x * f : x / f, fl = Math.floor(y), d = y - fl;
  const r = d > 0.5 ? fl + 1 : d < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1);
  return n >= 0 ? r / f : r * f;
}

/** EXOTIC's round_to_2(x[, y]): x rounded to the decimal of y's second significant figure (2 decimals when |y| >= 1 or y = 0). */
export function roundTo2(x, y = x, numpy = false) {
  const rv = Math.floor(y) >= 1 || y === 0 ? 2 : -Math.floor(Math.log10(Math.abs(y))) + 1;
  return numpy ? npRound(x, rv) : pyRound(x, rv);
}
// the planet's priors are Python floats in EXOTIC (Python's round); the fit's values and the light curve are numpy float64 (numpy's round)
const r2 = (x, y) => pyFloat(roundTo2(x, y));
const n2 = (x, y) => pyFloat(roundTo2(x, y, true));

/** json.dumps with Python's defaults (', ' and ': ' separators, floats by repr, None as null, non-ASCII escaped). */
export function pyDumps(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) && !v.__float ? String(v) : pyFloat(v);
  if (typeof v === 'string') return '"' + v.replace(/[\\"\u0000-\u001f\u007f-￿]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))) + '"';
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (v instanceof PyFloat) return pyFloat(v.x);
  return '{' + Object.entries(v).map(([k, x]) => pyDumps(String(k)) + ': ' + pyDumps(x)).join(', ') + '}';
}
/** A number that Python holds as a float (printed "2.0", not "2"). */
export class PyFloat { constructor(x) { this.x = x; } }
const F = (x) => new PyFloat(x);

/** Python's str() of a float, or a value passed through as Python would print it in an f-string. */
const pyStr = (v) => (v === null || v === undefined ? 'None' : typeof v === 'number' ? pyFloat(v) : String(v));
// the dict entries EXOTIC writes: str(round_to_2(v, u)), and the uncertainty as str(...) when it is truthy, else the value itself
const unc = (u) => (u ? String(pyFloat(roundTo2(u))) : u === undefined ? null : u === 0 ? F(0) : u);

const NOTICE = "# EXOTIC is developed by Exoplanet Watch (exoplanets.nasa.gov/exoplanet-watch/), a citizen science "
  + "project managed by NASA's Jet Propulsion Laboratory on behalf of NASA's Universe of Learning. "
  + 'This work is supported by NASA under award number NNX16AC65A to the '
  + 'Space Telescope Science Institute.\n'
  + '# Use of this data is governed by the AAVSO Data Usage Guidelines: '
  + 'aavso.org/data-usage-guidelines\n';

/**
 * The text of an AAVSO exoplanet report (EXOTIC's AAVSO_<planet>_<date>.txt).
 * @param r {
 *   software: e.g. 'EXOTIC v4.3.1' (default: 'Exoplanet Science Lab photometry'),
 *   obscode, secondaryObscodes, camera (OBSTYPE, e.g. 'CCD'), star, planet, binning ('1x1'), exposure [s], notes,
 *   compStar: the #COMP_STAR-XC object (EXOTIC: { ra, dec, x, y } of the comparison, or null),
 *   filter, filterDesc, wlMin, wlMax [nm],
 *   prior: { per, perUnc, rprs, rprsUnc, ars, arsUnc, inc, incUnc, ecc },
 *   ld: [[value, uncertainty] x 4] (Claret nonlinear u0..u3),
 *   fit: { tmid, rprs, inc, a1, a2 } and errors: { tmid, rprs, inc, a1, a2 },
 *   durations: [days] (EXOTIC: the transit duration of each posterior draw; mean and std are written),
 *   epwMd5 (optional), rows: { time (BJD_TDB), flux, err, airmass, airmassModel } }
 * @returns string
 */
export function aavsoReport(r) {
  const p = r.prior, fit = r.fit, er = r.errors, ld = r.ld, durs = r.durations || [NaN];
  const mean = durs.reduce((a, b) => a + b, 0) / durs.length, sd = Math.sqrt(durs.reduce((a, b) => a + (b - mean) ** 2, 0) / durs.length);
  const priors = {
    Period: { value: String(r2(p.per, p.perUnc)), uncertainty: unc(p.perUnc), units: 'days' },
    'Rp/R*': { value: String(r2(p.rprs, p.rprsUnc)), uncertainty: unc(p.rprsUnc) },
    'a/R*': { value: String(r2(p.ars, p.arsUnc)), uncertainty: unc(p.arsUnc) },
    inc: { value: String(r2(p.inc, p.incUnc)), uncertainty: unc(p.incUnc), units: 'degrees' },
    ecc: { value: String(r2(p.ecc)), uncertainty: null },
  };
  for (let i = 0; i < 4; i++) priors['u' + i] = { value: String(r2(ld[i][0], ld[i][1])), uncertainty: String(r2(ld[i][1])) };
  const filter = { name: r.filter, desc: r.filterDesc ?? null, fwhm: [{ value: r.wlMin ? pyStr(r.wlMin) : r.wlMin ?? null, units: 'nm' }, { value: r.wlMax ? pyStr(r.wlMax) : r.wlMax ?? null, units: 'nm' }] };
  const results = {
    Tc: { value: String(n2(fit.tmid, er.tmid)), uncertainty: String(n2(er.tmid)), units: 'BJD_TDB' },
    'Rp/R*': { value: String(n2(fit.rprs, er.rprs)), uncertainty: String(n2(er.rprs)) },
    inc: { value: String(n2(fit.inc, er.inc)), uncertainty: String(n2(er.inc)) },
    Am1: { value: String(n2(fit.a1, er.a1)), uncertainty: String(n2(er.a1)) },
    Am2: { value: String(n2(fit.a2, er.a2)), uncertainty: String(n2(er.a2)) },
    Duration: { value: String(n2(mean)), uncertainty: String(n2(sd)), units: 'days' },
  };
  let s = '#TYPE=EXOPLANET\n'
    + `#OBSCODE=${pyStr(r.obscode)}\n`
    + `#SECONDARY_OBSCODES=${pyStr(r.secondaryObscodes ?? '')}\n`
    + `#SOFTWARE=${r.software || 'Exoplanet Science Lab photometry'}\n`
    + '#DELIM=,\n'
    + '#DATE_TYPE=BJD_TDB\n'
    + `#OBSTYPE=${pyStr(r.camera)}\n`
    + `#STAR_NAME=${pyStr(r.star)}\n`
    + `#EXOPLANET_NAME=${pyStr(r.planet)}\n`
    + `#BINNING=${pyStr(r.binning ?? '1x1')}\n`
    + `#EXPOSURE_TIME=${pyStr(r.exposure ?? -1)}\n`
    + `#COMP_STAR-XC=${pyDumps(r.compStar ?? null)}\n`
    + `#NOTES=${pyStr(r.notes ?? '')}\n`
    + '#DETREND_PARAMETERS=AIRMASS, AIRMASS CORRECTION FUNCTION\n'
    + '#MEASUREMENT_TYPE=Rnflux\n'
    + `#FILTER=${pyStr(r.filter)}\n`
    + `#FILTER-XC=${pyDumps(filter)}\n`
    + `#PRIORS=Period=${r2(p.per, p.perUnc)} +/- ${r2(p.perUnc)}`
    + `,Rp/R*=${r2(p.rprs, p.rprsUnc)} +/- ${r2(p.rprsUnc)}`
    + `,a/R*=${r2(p.ars, p.arsUnc)} +/- ${r2(p.arsUnc)}`
    + `,inc=${r2(p.inc, p.incUnc)} +/- ${r2(p.incUnc)}`
    + `,ecc=${r2(p.ecc)}`
    + ld.map((u, i) => `,u${i}=${r2(u[0], u[1])} +/- ${r2(u[1])}`).join('') + '\n'
    + `#PRIORS-XC=${pyDumps(priors)}\n`
    + `#RESULTS=Tc=${n2(fit.tmid, er.tmid)} +/- ${n2(er.tmid)}`
    + `,Rp/R*=${n2(fit.rprs, er.rprs)} +/- ${n2(er.rprs)}`
    + `,inc=${n2(fit.inc, er.inc)} +/- ${n2(er.inc)}`
    + `,Am1=${n2(fit.a1, er.a1)} +/- ${n2(er.a1)}`
    + `,Am2=${n2(fit.a2, er.a2)} +/- ${n2(er.a2)}\n`
    + `#RESULTS-XC=${pyDumps(results)}\n`;
  if (r.epwMd5) s += `#EPW_MD5-XC=${pyDumps({ epw_checkout_md5: r.epwMd5 })}\n`;
  s += NOTICE + '#DATE,DIFF,ERR,DETREND_1,DETREND_2\n';
  const R = r.rows;
  for (let i = 0; i < R.time.length; i++) s += `${pyFloat(npRound(R.time[i], 8))},${pyFloat(npRound(R.flux[i], 7))},${pyFloat(npRound(R.err[i], 7))},${pyFloat(npRound(R.airmass[i], 7))},${pyFloat(npRound(R.airmassModel[i], 7))}\n`;
  return s;
}
