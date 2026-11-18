// Time scales (src/core/timescale.js) and the display scales (src/core/timeformat.js) against astropy/ERFA
// (test/timescale_reference.json, made by test/make_timescale_reference.py with .venv-phot: astropy 6.0.1).
// Instants are compared as seconds since JD 2451545.0 counted in each scale, which is well defined even on the
// day of a leap second. UT1 = UTC on both sides.
import { readFileSync } from 'node:fs';
import { jdFromMs, utcTo, toUtc, convertJd, taiMinusUtc, gpsMinusUtc, ttMinusUtc, tdbMinusTt, leapCheck, LEAP_LAST, mjdFromJd } from '../src/core/timescale.js';
import { formatScale, lstHours, hourAngle, hms, DISPLAY_SCALES } from '../src/core/timeformat.js';
import { ttMinusUtc as astroTt } from '../src/core/astro.js';
import { ttMinusUtc as obsTt } from '../src/core/observability.js';
import { taiMinusUtc as fitsTai, tdbMinusUtc as fitsTdb } from '../src/core/fits.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const REF = JSON.parse(readFileSync(new URL('./timescale_reference.json', import.meta.url), 'utf8'));
const J2K = 2451545.0, GPS_EPOCH_JD = 2444244.5;
const secJ2k = (jd) => (jd - J2K) * 86400;

// ---- the table and its users
check('one leap-second table: astro, observability and fits read timescale.js', [Date.UTC(1990, 5, 1), Date.UTC(2017, 0, 1), Date.UTC(2026, 10, 18)].every((ms) => {
  const jd = jdFromMs(ms); return astroTt(ms) === ttMinusUtc(jd) && obsTt(jd) === ttMinusUtc(jd) && fitsTai(jd) === taiMinusUtc(jd) && Math.abs(fitsTdb(jd) * 86400 - ttMinusUtc(jd) - tdbMinusTt(jd)) < 1e-12;
}));
check('table ends with TAI - UTC = 37 s from 2017-01-01', LEAP_LAST.jd === 2457754.5 && LEAP_LAST.taiMinusUtc === 37 && gpsMinusUtc(jdFromMs(Date.UTC(2026, 10, 18))) === 18);

// ---- against astropy
let wTai = 0, wTt = 0, wTdb = 0, wGps = 0, wMjd = 0, nNormal = 0;
for (const r of REF.rows) {
  if (r.iso.endsWith(':60')) continue;
  const ms = Date.parse(r.iso + 'Z'), jd = jdFromMs(ms);
  wTai = Math.max(wTai, Math.abs(secJ2k(utcTo(jd, 'TAI')) - r.tai_s));
  wTt = Math.max(wTt, Math.abs(secJ2k(utcTo(jd, 'TT')) - r.tt_s));
  wTdb = Math.max(wTdb, Math.abs(secJ2k(utcTo(jd, 'TDB')) - r.tdb_s));
  if (r.gps_seconds != null) wGps = Math.max(wGps, Math.abs((utcTo(jd, 'GPS') - GPS_EPOCH_JD) * 86400 - r.gps_seconds));
  if (r.unix != null && Math.abs(r.unix - ms / 1000) < 1e-3) { wMjd = Math.max(wMjd, Math.abs(mjdFromJd(jd) - r.mjd) * 86400); nNormal++; }
}
const n = REF.rows.length - 1;
check('UTC -> TAI against astropy, leap-second days included', wTai < 1e-4, `largest difference ${(wTai * 1e6).toFixed(1)} us over ${n} instants 1975-2030; tolerance 100 us (float64 Julian dates: 40 us)`);
check('UTC -> TT against astropy', wTt < 1e-4, `largest difference ${(wTt * 1e6).toFixed(1)} us`);
check('UTC -> TDB against astropy (geocentre)', wTdb < 1e-4, `largest difference ${(wTdb * 1e6).toFixed(1)} us; two periodic terms; tolerance 100 us`);
check('GPS seconds against astropy Time.gps', wGps < 1e-4, `largest difference ${(wGps * 1e6).toFixed(1)} us`);
check('MJD against astropy', wMjd < 1e-4 && nNormal > 10, `largest difference ${(wMjd * 1e6).toFixed(1)} us over ${nNormal} instants off leap-second days`);

// ---- inverses, and the leap second itself
const leap = REF.rows.find((r) => r.iso === '2016-12-31T23:59:60'), after = REF.rows.find((r) => r.iso === '2017-01-01T00:00:00');
const jdTaiLeap = J2K + leap.tai_s / 86400;
check('23:59:60 UTC: no UTC Julian date; toUtc gives the first instant of the next day', Math.abs(toUtc(jdTaiLeap, 'TAI') - 2457754.5) < 1e-9 && after.tai_s - leap.tai_s === 1);
let wInv = 0;
for (const r of REF.rows) {
  if (r.iso.endsWith(':60')) continue;
  const jd = jdFromMs(Date.parse(r.iso + 'Z'));
  for (const s of ['TAI', 'TT', 'GPS', 'TDB']) wInv = Math.max(wInv, Math.abs(toUtc(utcTo(jd, s), s) - jd) * 86400);
  wInv = Math.max(wInv, Math.abs(convertJd(convertJd(jd, 'UTC', 'TDB'), 'TDB', 'GPS') - utcTo(jd, 'GPS')) * 86400);
}
check('toUtc inverts utcTo for every scale; convertJd chains', wInv < 1e-5, `largest round-trip error ${(wInv * 1e6).toFixed(2)} us`);

// ---- leap-second check against what a clock reports
const now = jdFromMs(Date.UTC(2026, 10, 18));
check('leapCheck: GNSS GPS - UTC = 18 agrees (time.jeffgeerling.com reported "leap": 18 on 2026-11-18)', leapCheck(now, { gpsMinusUtc: 18 }).ok);
check('leapCheck: a 19 s report is flagged as a leap second the table lacks', !leapCheck(now, { gpsMinusUtc: 19 }).ok && /LEAP_SECONDS/.test(leapCheck(now, { gpsMinusUtc: 19 }).message));
check('leapCheck: TAI - UTC = 37 accepted; nothing reported is fine', leapCheck(now, { taiMinusUtc: 37 }).ok && leapCheck(now).ok);

// ---- display scales
let wLst = 0, wBjd = 0;
for (const r of REF.rows) {
  if (r.iso.endsWith(':60')) continue;
  const ms = Date.parse(r.iso + 'Z');
  for (const l of r.lst) { let d = Math.abs(lstHours(ms, l.lon) - l.hours); d = Math.min(d, 24 - d); wLst = Math.max(wLst, d * 3600); }
  for (const b of r.bjd) wBjd = Math.max(wBjd, Math.abs(formatScale(ms, 'bjd', { target: b }).value - b.bjd_tdb) * 86400);
}
check('LST (apparent) against astropy sidereal_time("apparent")', wLst < 0.1, `largest difference ${wLst.toFixed(3)} s of time over 3 sites; IAU 1982 + 4 nutation terms; tolerance 0.1 s`);
check('BJD_TDB display against astropy light_travel_time (builtin)', wBjd < 0.25, `largest difference ${wBjd.toFixed(3)} s over 3 targets; utcToBjdTdb claims 0.2 s`);

const t0 = Date.UTC(2026, 10, 18, 22, 0, 0), site = { lon: -111.5967, tz: 'America/Phoenix' }, target = { ra: 31.0428, dec: 46.6878 };
const f = (s) => formatScale(t0, s, { site, target });
check('menu: Local, Site, UTC, JD (UTC), MJD, BJD_TDB, LST', DISPLAY_SCALES.map((s) => s.label).join(',') === 'Local,Site,UTC,JD (UTC),MJD,BJD_TDB,LST');
check('UTC and Site clocks', f('utc').text === '2026-11-18 22:00:00' && f('site').text === '2026-11-18 15:00:00' && f('site').unit === 'MST', `${f('utc').text} UTC · ${f('site').text} ${f('site').unit}`);
check('JD and MJD text', f('jd').text === (2440587.5 + t0 / 86400000).toFixed(5) && f('mjd').text === (t0 / 86400000 + 40587).toFixed(5), `${f('jd').text} · ${f('mjd').text}`);
check('LST with the target’s hour angle', /^\d\d:\d\d:\d\d$/.test(f('lst').text) && Math.abs(f('lst').ha - hourAngle(t0, site.lon, target.ra)) < 1e-12 && f('lst').note.startsWith('HA '), `${f('lst').text} · ${f('lst').note}`);
check('BJD_TDB and LST say what is missing', formatScale(t0, 'bjd', {}).value === null && /target/.test(formatScale(t0, 'bjd', {}).note) && formatScale(t0, 'lst', {}).value === null);
check('hms of a clock wraps at 24 h', hms(23.9999999) === '00:00:00' && hms(12.5) === '12:30:00', hms(23.9999999));
check('hms of an hour angle', hms(-1.5, { sign: true }) === '−01:30:00' && hms(2.25, { sign: true }) === '+02:15:00');

process.exit(ok ? 0 : 1);
