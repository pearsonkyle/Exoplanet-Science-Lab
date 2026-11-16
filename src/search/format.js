// Number and text formatting shared by the Search and Plan pages. No DOM.
import { RJUP_REARTH, MJUP_MEARTH } from '../core/relations.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = Number.isFinite;
/** Fixed decimals, trimmed to a sensible number of significant digits for big and small numbers. */
export function num(x, dec = 2) {
  if (!fin(x)) return '';
  const a = Math.abs(x);
  if (a !== 0 && (a < 10 ** -(dec + 1) || a >= 1e7)) return x.toExponential(2);
  return x.toFixed(dec);
}
/** A duration given in minutes as "12 min", "3.4 h" or "2.1 d". */
export function minutes(m) {
  if (!fin(m)) return '';
  const a = Math.abs(m);
  return a < 1 ? m.toFixed(2) + ' min' : a < 100 ? m.toFixed(a < 10 ? 1 : 0) + ' min' : a < 2880 ? (m / 60).toFixed(1) + ' h' : (m / 1440).toFixed(a < 144000 ? 1 : 0) + ' d';
}
/** Right ascension in degrees as "hh:mm:ss.s", declination as "+dd:mm:ss". */
export function hms(ra) { const h = ((ra % 360) + 360) % 360 / 15, H = Math.floor(h), m = (h - H) * 60, M = Math.floor(m), s = (m - M) * 60; return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`; }
export function dms(dec) { const a = Math.abs(dec), D = Math.floor(a), m = (a - D) * 60, M = Math.floor(m), s = Math.round((m - M) * 60); return `${dec < 0 ? '−' : '+'}${String(D).padStart(2, '0')}:${String(M).padStart(2, '0')}:${String(Math.min(s, 59)).padStart(2, '0')}`; }

/**
 * How each common field is shown: [scale, unit, decimals]. `units` is 'earth' or 'jup' for planet mass and radius.
 * display(field, value, units) -> text; unitOf(field, units) -> unit label.
 */
export function shown(field, units = 'earth') {
  switch (field) {
    case 'per': return [1, 'd', null];
    case 'tmid': return [1, 'BJD', 5];
    case 't14': return [24, 'h', 2];
    case 'depth': return [1000, 'ppt', 2];
    case 'rp': return units === 'earth' ? [RJUP_REARTH, 'R⊕', 2] : [1, 'RJ', 3];
    case 'mass': return units === 'earth' ? [MJUP_MEARTH, 'M⊕', 1] : [1, 'MJ', 3];
    case 'rprs': return [1, '', 4];
    case 'ars': return [1, '', 2];
    case 'b': return [1, '', 2];
    case 'inc': return [1, '°', 2];
    case 'ecc': return [1, '', 3];
    case 'omega': return [1, '°', 1];
    case 'a': return [1, 'au', 4];
    case 'K': return [1, 'm/s', 2];
    case 'teq': case 'teff': return [1, 'K', 0];
    case 'insol': return [1, 'S⊕', 1];
    case 'rstar': return [1, 'R☉', 2];
    case 'mstar': return [1, 'M☉', 2];
    case 'logg': return [1, '', 2];
    case 'feh': return [1, 'dex', 2];
    case 'lum': return [1, 'L☉', 3];
    case 'ra': case 'dec': return [1, '°', 4];
    case 'dist': return [1, 'pc', 1];
    case 'year': return [1, '', 0];
    case 'vmag': case 'gmag': case 'tmag': case 'jmag': case 'kmag': case 'mag': return [1, '', 2];
    default: return [1, '', 2];
  }
}
export const unitOf = (field, units) => (field === 'drift' ? '' : shown(field, units)[1]);
export function display(field, value, units) {
  if (!fin(value)) return '';
  if (field === 'drift') return minutes(value);
  const [scale, , dec] = shown(field, units), x = value * scale;
  if (field === 'per') return x < 10 ? x.toFixed(5) : x < 100 ? x.toFixed(4) : x < 1e4 ? x.toFixed(2) : x.toFixed(0);
  if (field === 'mass' && units === 'earth' && Math.abs(x) >= 1000) return x.toFixed(0);
  return num(x, dec);
}
/** "1.234 +0.010 −0.020" or "1.234 ± 0.010" in display units; errors as [minus, plus]. */
export function withError(field, value, err, units) {
  if (!fin(value)) return '';
  if (field === 'drift') return display(field, value, units);
  const [scale, , dec] = shown(field, units), sc = Math.abs(scale);
  const es = err ? err.filter((e) => e > 0).map((e) => e * sc) : [];
  if (!es.length) return field === 'per' || field === 'tmid' ? String(+(value * scale).toPrecision(12)) : display(field, value, units);
  // enough decimals to show two digits of the smaller error
  const d = Math.min(10, Math.max(field === 'per' || field === 'tmid' ? 1 : dec ?? 2, Math.ceil(-Math.log10(Math.min(...es))) + 1)), f = (e) => (e * sc).toFixed(d);
  const t = (value * scale).toFixed(d);
  return err[0] === err[1] ? `${t} ± ${f(err[0])}` : `${t} +${f(err[1])} −${f(err[0])}`;
}
