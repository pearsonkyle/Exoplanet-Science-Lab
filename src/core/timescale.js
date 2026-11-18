// Time scales: the one leap-second table of the code and the clock offsets between UTC, TAI, TT, GPS and TDB.
// No imports, no DOM: astro.js (sky view), observability.js (planner), fits.js (photometry) and fitsheader.js
// (frames we write) all read the table from here.
//
// Conventions
//   jd     Julian date; the scale is in the name (jdUtc, jdTdb). ms = Unix milliseconds (UTC, no leap seconds).
//   UTC before 1972 is taken as TAI - 10 s (the "rubber second" era is not modelled).
//   TDB - TT is the two largest periodic terms (1.657 ms, 14 us; Fairhead & Bretagnon 1990 truncated): 44 us from
//   astropy at most in the test; the observatory's position on the Earth (up to 2 us) is left out.
//   GPS time = TAI - 19 s (it has no leap seconds; GPS - UTC = 18 s since 2017).
// test/timescale.test.mjs checks every function against astropy (test/timescale_reference.json).

export const UNIX_EPOCH_JD = 2440587.5, MJD_ZERO = 2400000.5, DAY_MS = 86400000;
export const TT_MINUS_TAI = 32.184, TAI_MINUS_GPS = 19;

/** TAI - UTC [s]: [Julian date (UTC) at 0h of the day it took effect, seconds]. IERS Bulletin C; none since 2017-01-01. */
export const LEAP_SECONDS = [[2441317.5, 10], [2441499.5, 11], [2441683.5, 12], [2442048.5, 13], [2442413.5, 14], [2442778.5, 15], [2443144.5, 16], [2443509.5, 17],
  [2443874.5, 18], [2444239.5, 19], [2444786.5, 20], [2445151.5, 21], [2445516.5, 22], [2446247.5, 23], [2447161.5, 24], [2447892.5, 25], [2448257.5, 26],
  [2448804.5, 27], [2449169.5, 28], [2449534.5, 29], [2450083.5, 30], [2450630.5, 31], [2451179.5, 32], [2453736.5, 33], [2454832.5, 34], [2456109.5, 35],
  [2457204.5, 36], [2457754.5, 37]];
/** The last entry: the table holds this value after it (no leap second has been announced since). */
export const LEAP_LAST = { jd: LEAP_SECONDS[LEAP_SECONDS.length - 1][0], taiMinusUtc: LEAP_SECONDS[LEAP_SECONDS.length - 1][1] };

export const jdFromMs = (ms) => ms / DAY_MS + UNIX_EPOCH_JD;
export const msFromJd = (jd) => (jd - UNIX_EPOCH_JD) * DAY_MS;
export const mjdFromJd = (jd) => jd - MJD_ZERO;
export const jdFromMjd = (mjd) => mjd + MJD_ZERO;

/** TAI - UTC [s] at a UTC Julian date. */
export function taiMinusUtc(jdUtc) {
  let v = 10;
  for (const [jd, s] of LEAP_SECONDS) { if (jdUtc >= jd) v = s; else break; }
  return v;
}
/** TT - UTC [s] at a UTC Julian date. */
export const ttMinusUtc = (jdUtc) => taiMinusUtc(jdUtc) + TT_MINUS_TAI;
/** GPS - UTC [s] at a UTC Julian date (0 before GPS time began on 1980-01-06, where it equals UTC by definition). */
export const gpsMinusUtc = (jdUtc) => taiMinusUtc(jdUtc) - TAI_MINUS_GPS;
/** TDB - TT [s] at a Julian date in TT or TDB (the difference between those is below 2 ms: no effect here). */
export function tdbMinusTt(jdTt) {
  const g = (357.53 + 0.9856003 * (jdTt - 2451545.0)) * Math.PI / 180;
  return 0.001657 * Math.sin(g) + 0.000014 * Math.sin(2 * g);
}
/** TDB - UTC in DAYS at a UTC Julian date (the form fits.js has always used). */
export const tdbMinusUtc = (jdUtc) => (ttMinusUtc(jdUtc) + tdbMinusTt(jdUtc)) / 86400;

export const SCALES = ['UTC', 'TAI', 'TT', 'GPS', 'TDB'];
/** Seconds to add to a UTC reading to get the same instant in `scale`. */
export function offsetFromUtc(jdUtc, scale) {
  switch (scale) {
    case 'UTC': return 0;
    case 'TAI': return taiMinusUtc(jdUtc);
    case 'TT': return ttMinusUtc(jdUtc);
    case 'GPS': return gpsMinusUtc(jdUtc);
    case 'TDB': { const tt = ttMinusUtc(jdUtc); return tt + tdbMinusTt(jdUtc + tt / 86400); }
    default: throw new Error(`unknown time scale ${scale}`);
  }
}
/** A UTC Julian date as a Julian date in another scale. */
export const utcTo = (jdUtc, scale) => jdUtc + offsetFromUtc(jdUtc, scale) / 86400;
/**
 * A Julian date in `scale` as UTC. Iterated (the offset depends on the UTC date). Inside a positive leap second
 * (23:59:60 UTC) there is no UTC Julian date; the result is then the first instant of the next day.
 */
export function toUtc(jd, scale) {
  if (scale === 'UTC') return jd;
  let u = jd - offsetFromUtc(jd, scale) / 86400, prev = u;
  for (let i = 0; i < 4; i++) { prev = u; u = jd - offsetFromUtc(u, scale) / 86400; }
  return u === prev ? u : Math.max(u, prev);           // the two alternate only inside a leap second
}
/** Convert a Julian date between any two of SCALES. */
export const convertJd = (jd, from, to) => (from === to ? jd : utcTo(toUtc(jd, from), to));

/**
 * Compare a leap-second count reported by a clock (a GNSS receiver's GPS - UTC, a server's TAI - UTC) with the
 * table, so that a stale table is noticed instead of silently putting every time 1 s off.
 * @returns { ok, table: GPS-UTC from the table, reported, message }
 */
export function leapCheck(jdUtc, { gpsMinusUtc: gps = null, taiMinusUtc: tai = null } = {}) {
  const table = gpsMinusUtc(jdUtc), reported = gps != null ? gps : tai != null ? tai - TAI_MINUS_GPS : null;
  if (reported == null || !Number.isFinite(reported)) return { ok: true, table, reported: null, message: 'no leap-second count reported' };
  const ok = reported === table;
  return { ok, table, reported, message: ok ? `leap seconds agree (GPS - UTC = ${table} s)` : `the clock reports GPS - UTC = ${reported} s but the table says ${table} s: a leap second the code does not know about? Update LEAP_SECONDS in src/core/timescale.js.` };
}
