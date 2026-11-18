// "Now" in the time scales an observer reads: Local, Site, UTC, JD (UTC), MJD (UTC), BJD_TDB of the target, and
// local apparent sidereal time (with the target's hour angle). One function for the Plan and Observe readouts,
// the Run page and the FITS headers, so they cannot disagree. No DOM (Intl only, which Node has).

import { jdFromMs, mjdFromJd } from './timescale.js';
import { localSiderealTime, RAD } from './astro.js';
import { utcToBjdTdb } from './fits.js';

/** The display scales, in menu order: id, label, what it is. */
export const DISPLAY_SCALES = [
  { id: 'local', label: 'Local', hint: 'this computer’s time zone' },
  { id: 'site', label: 'Site', hint: 'the observatory’s time zone' },
  { id: 'utc', label: 'UTC', hint: 'Coordinated Universal Time' },
  { id: 'jd', label: 'JD (UTC)', hint: 'Julian date, UTC' },
  { id: 'mjd', label: 'MJD', hint: 'modified Julian date (JD − 2400000.5), UTC' },
  { id: 'bjd', label: 'BJD_TDB', hint: 'barycentric Julian date of the target, TDB (light arriving at the solar-system barycentre)' },
  { id: 'lst', label: 'LST', hint: 'local apparent sidereal time; the hour angle of a target is LST − RA' },
];
export const isDisplayScale = (id) => DISPLAY_SCALES.some((s) => s.id === id);

const mod = (x, m) => ((x % m) + m) % m;
/** Hours as HH:MM:SS (sign kept for hour angles). */
export function hms(hours, { sign = false, decimals = 0 } = {}) {
  const neg = hours < 0, h = Math.abs(hours);
  let tot = Math.round(h * 3600 * 10 ** decimals) / 10 ** decimals;
  if (!sign) tot = mod(tot, 86400);                      // a clock reading: 23:59:59.7 rounds to 00:00:00, not 24:00:00
  const H = Math.floor(tot / 3600), M = Math.floor((tot - H * 3600) / 60), S = tot - H * 3600 - M * 60;
  const ss = decimals ? S.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.round(S)).padStart(2, '0');
  return (neg ? '−' : sign ? '+' : '') + String(H).padStart(2, '0') + ':' + String(M).padStart(2, '0') + ':' + ss;
}
/** Local apparent sidereal time [hours] at a Unix time for an east longitude in degrees. */
export const lstHours = (ms, lonDeg) => localSiderealTime(ms, lonDeg * RAD) / RAD / 15;
/** Hour angle [hours, -12..12] of a right ascension [deg]. */
export const hourAngle = (ms, lonDeg, raDeg) => mod(lstHours(ms, lonDeg) - raDeg / 15 + 12, 24) - 12;

const fmtCache = new Map();
function clockText(ms, timeZone, seconds) {
  const key = (timeZone || '') + seconds;
  let f = fmtCache.get(key);
  if (!f) {
    const opt = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' };
    if (seconds) opt.second = '2-digit';
    try { f = new Intl.DateTimeFormat('en-CA', timeZone ? { ...opt, timeZone } : opt); } catch { f = new Intl.DateTimeFormat('en-CA', { ...opt, timeZone: 'UTC' }); }
    fmtCache.set(key, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${seconds ? ':' + p.second : ''}`, zone: p.timeZoneName || timeZone || '' };
}

/**
 * One instant in a display scale.
 * @param ms     Unix milliseconds (UTC), e.g. clock.now()
 * @param scale  one of DISPLAY_SCALES ids
 * @param opts   { site: { lon [deg east], tz (IANA) }, target: { ra, dec [deg] }, seconds: true, decimals: 5 (JD-type) }
 * @returns { text, value (number for jd/mjd/bjd/lst hours; null for clocks or when it cannot be computed), unit, label, note }
 */
export function formatScale(ms, scale, opts = {}) {
  const { site = null, target = null, seconds = true, decimals = 5 } = opts;
  const label = (DISPLAY_SCALES.find((s) => s.id === scale) || { label: scale }).label;
  const jd = jdFromMs(ms);
  switch (scale) {
    case 'local': { const c = clockText(ms, null, seconds); return { text: c.text, value: null, unit: c.zone, label, note: '' }; }
    case 'site': {
      if (!site || !site.tz) return { ...formatScale(ms, 'utc', opts), label, note: 'the site has no time zone: UTC shown' };
      const c = clockText(ms, site.tz, seconds); return { text: c.text, value: null, unit: c.zone, label, note: '' };
    }
    case 'utc': { const c = clockText(ms, 'UTC', seconds); return { text: c.text, value: null, unit: 'UTC', label, note: '' }; }
    case 'jd': return { text: jd.toFixed(decimals), value: jd, unit: 'JD', label, note: '' };
    case 'mjd': { const m = mjdFromJd(jd); return { text: m.toFixed(decimals), value: m, unit: 'MJD', label, note: '' }; }
    case 'bjd': {
      if (!target || !Number.isFinite(target.ra) || !Number.isFinite(target.dec)) return { text: '—', value: null, unit: 'BJD_TDB', label, note: 'choose a target for BJD_TDB' };
      const b = utcToBjdTdb(jd, target.ra, target.dec);
      return { text: b.toFixed(decimals), value: b, unit: 'BJD_TDB', label, note: '' };
    }
    case 'lst': {
      if (!site || !Number.isFinite(site.lon)) return { text: '—', value: null, unit: 'LST', label, note: 'the site has no longitude' };
      const h = lstHours(ms, site.lon);
      const ha = target && Number.isFinite(target.ra) ? hourAngle(ms, site.lon, target.ra) : null;
      return { text: hms(h), value: h, unit: 'LST', label, note: ha == null ? '' : `HA ${hms(ha, { sign: true })}`, ha };
    }
    default: throw new Error(`unknown display scale ${scale}`);
  }
}
