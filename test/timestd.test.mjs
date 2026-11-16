// Time standards of the light-curve reader (src/core/data.js): detection from DATE_TYPE, column names and comments,
// and the conversion of JD_UTC, HJD_UTC and BJD_UTC to BJD_TDB against astropy (test/timestd_reference.json, made by
// test/make_timestd_reference.py with .venv-phot: astropy 6.0.1, builtin ephemeris, geocentre). Tolerance 0.1 s.
import { readFileSync } from 'node:fs';
import { detectTimeStandard, toBjdTdb, heliocentricDelay, parseLightCurve } from '../src/core/data.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const REF = JSON.parse(readFileSync(new URL('./timestd_reference.json', import.meta.url), 'utf8'));

// ---- detection
const k = (o) => detectTimeStandard(o).key;
check('DATE_TYPE=BJD_TDB (AAVSO)', k({ dateType: 'BJD_TDB' }) === 'bjd_tdb');
check('DATE_TYPE=HJD, JD_UTC', k({ dateType: 'HJD' }) === 'hjd_utc' && k({ dateType: 'JD_UTC' }) === 'jd_utc');
check('column names', k({ column: 'HJD_UTC' }) === 'hjd_utc' && k({ column: 'BJD-TDB' }) === 'bjd_tdb' && k({ column: 'BJD' }) === 'bjd' && k({ column: 'JD (UTC)' }) === 'jd_utc' && k({ column: 'Time (JD)' }) === 'jd' && k({ column: 'MJD-OBS' }) === 'jd_utc' && k({ column: 'time' }) === 'unknown');
check('TESS and Kepler offsets are BJD_TDB', k({ offsetKey: 'btjd' }) === 'bjd_tdb' && k({ offsetKey: 'bkjd' }) === 'bjd_tdb');
check('a comment naming the standard', k({ comments: ['times are HJD (UTC) mid-exposure'] }) === 'hjd_utc');

// ---- conversions against astropy
let wJ = 0, wH = 0, wD = 0;
for (const r of REF.rows) {
  const bjd = r.jd_utc + r.bjd_tdb_minus_jd_utc_s / 86400, hjd = r.jd_utc + r.hjd_utc_minus_jd_utc_s / 86400;
  wJ = Math.max(wJ, Math.abs((toBjdTdb(r.jd_utc, 'jd_utc', r.ra, r.dec) - bjd) * 86400));
  wH = Math.max(wH, Math.abs((toBjdTdb(hjd, 'hjd_utc', r.ra, r.dec) - bjd) * 86400));
  wD = Math.max(wD, Math.abs(heliocentricDelay(r.jd_utc, r.ra, r.dec) * 86400 - r.hjd_utc_minus_jd_utc_s));
}
check('JD_UTC -> BJD_TDB against astropy', wJ < 0.1, `largest difference ${wJ.toFixed(3)} s over ${REF.rows.length} target/date pairs 2000-2026; tolerance 0.1 s`);
check('heliocentric light time against astropy', wD < 0.1, `largest difference ${wD.toFixed(3)} s; tolerance 0.1 s`);
check('HJD_UTC -> BJD_TDB against astropy', wH < 0.1, `largest difference ${wH.toFixed(3)} s; tolerance 0.1 s`);

// ---- the reader: converts with coordinates, warns without, leaves BJD_TDB alone
const row = (i, t0) => `${(t0 + i * 0.002).toFixed(6)},${(1 + 0.001 * Math.sin(i)).toFixed(6)},0.001`;
const file = (head, t0) => head + '\n' + Array.from({ length: 30 }, (_, i) => row(i, t0)).join('\n');
const r0 = REF.rows.find((r) => r.name === 'HAT-P-32' && r.jd_utc === 2459500.33), co = { ra: r0.ra, dec: r0.dec };
const hjd0 = r0.jd_utc + r0.hjd_utc_minus_jd_utc_s / 86400;
const a = parseLightCurve(file('HJD_UTC,flux,err', hjd0), 'x', { coords: co });
const got = (a.t[0] + a.tRef - (r0.jd_utc + r0.bjd_tdb_minus_jd_utc_s / 86400)) * 86400;
check('HJD_UTC file + coordinates: converted to BJD_TDB', a.timeStandard === 'hjd_utc' && a.timeConverted && Math.abs(got) < 0.1 && a.notes.some((n) => /converted to BJD_TDB/.test(n)), `first point ${got.toFixed(3)} s from astropy (float64 time stamps rounded to 1e-6 d = 0.09 s in the file); shift ${a.timeShiftSec.toFixed(1)} s`);
const b = parseLightCurve(file('HJD,flux,err', hjd0), 'x');
check('HJD file without coordinates: not converted, said plainly', b.timeStandard === 'hjd_utc' && !b.timeConverted && b.notes.some((n) => /NOT converted/.test(n)) && Math.abs(b.t[0] + b.tRef - hjd0) < 1e-6);
const c = parseLightCurve(file('BJD_TDB,flux,err', 2459500.3), 'x', { coords: co });
check('BJD_TDB file is left as it is', c.timeStandard === 'bjd_tdb' && !c.timeConverted && Math.abs(c.t[0] + c.tRef - 2459500.3) < 1e-9);
const d = parseLightCurve(file('Time (JD),flux,err', 2459500.3), 'x', { coords: co });
check('"Time (JD)" (EXOTIC writes it for BJD_TDB) is not converted, with a note', d.timeStandard === 'jd' && !d.timeConverted && d.notes.some((n) => /taken as BJD_TDB/.test(n)));
const e = parseLightCurve(file('Time (JD),flux,err', 2459500.3), 'x', { coords: co, timeStandard: 'jd_utc' });
check('the user can say the JD is UTC: converted', e.timeConverted && Math.abs(e.timeShiftSec - (toBjdTdb(2459500.3, 'jd_utc', co.ra, co.dec) - 2459500.3) * 86400) < 0.01, `${e.timeShiftSec.toFixed(1)} s`);
const aav = `#TYPE=EXOPLANET\n#DATE_TYPE=JD_UTC\n#DELIM=,\n#DATE,DIFF,ERR\n` + Array.from({ length: 30 }, (_, i) => row(i, 2459500.3)).join('\n');
const f = parseLightCurve(aav, 'r', { coords: co });
check('AAVSO report with DATE_TYPE=JD_UTC: converted', f.timeStandard === 'jd_utc' && f.timeConverted);
process.exit(ok ? 0 : 1);
