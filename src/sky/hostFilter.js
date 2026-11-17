// The host-star filter of the Observe page's Filter panel: which stars with planets are drawn and listed, by
// magnitude, effective temperature, spectral class, distance, number of planets, and whether a planet transits
// (or transits tonight). The discovery-method toggles are the other half of the panel (discovery.js). No DOM:
// test/hostfilter.test.mjs.
//
// Where the values come from: public/sky/hosts.json carries them in its eighth column, [Teff K, distance pc,
// spectral class, transits 0/1] (tools/build_sky_data.py, from the snapshots catalog-table/nea.json: st_teff,
// sy_dist, st_spectype, tran_flag, and catalog-table/toi.json: st_teff, st_dist for stars with candidates only);
// bakedAttributes() reads them. An older hosts.json without that column falls back on hostAttributes(), which
// reads the same values from the two tables, fetched on demand (about 8 MB).
// A star without the value is "unknown"; the panel says how many and lets them in or out (`unknown`).
//
// Spectral class: the letter of the archive's spectral type when there is one (luminosity class and subtype
// ignored; 'sdM', 'esdK' are M and K; white dwarfs 'D…' are left unknown), else from Teff with the dwarf scale of
// Pecaut & Mamajek (2013, ApJS 208, 9; table 5, version 2022.04): B0 31400 K, A0 9700, F0 7220, G0 5930, K0 5270,
// M0 3850, L0 2250 (below: L, T and Y, put together as 'L').
import { hostMag } from './visible.js';

export const SPEC_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'L'];
export const SPEC_NOTE = { O: 'hotter than 31,400 K', B: '9,700 – 31,400 K', A: '7,220 – 9,700 K', F: '5,930 – 7,220 K', G: '5,270 – 5,930 K', K: '3,850 – 5,270 K', M: '2,250 – 3,850 K', L: 'L, T, Y: brown dwarfs, cooler than 2,250 K' };
const TEFF_EDGES = [[31400, 'O'], [9700, 'B'], [7220, 'A'], [5930, 'F'], [5270, 'G'], [3850, 'K'], [2250, 'M']];
/** 'G2 V', 'K1.5IV', 'sdM4', 'T8' -> its class letter ('L' for L, T, Y); else the class of teff (K); '' when neither. */
export function spectralClass(sptype, teff) {
  const m = /^\s*(?:e?sd)?([OBAFGKMLTY])/i.exec(String(sptype || ''));
  if (m) { const c = m[1].toUpperCase(); return c === 'T' || c === 'Y' ? 'L' : c; }
  if (!(teff > 0)) return '';
  for (const [t, c] of TEFF_EDGES) if (teff >= t) return c;
  return 'L';
}

export const DEFAULT_FILTER = Object.freeze({ magMin: null, magMax: null, teffMin: null, teffMax: null, spec: '', distMin: null, distMax: null, minPlanets: 0, transiting: false, transitTonight: false, unknown: true });
const fin = Number.isFinite;
const numOrNull = (v) => (v === '' || v == null || !fin(+v) ? null : +v);
/** Any object (stored, from a tool, from the URL) -> a clean filter. Spectral classes in the order of SPEC_CLASSES. */
export function normalizeFilter(o) {
  o = o || {};
  const spec = SPEC_CLASSES.filter((c) => String(o.spec || '').toUpperCase().includes(c)).join('');
  return { magMin: numOrNull(o.magMin), magMax: numOrNull(o.magMax), teffMin: numOrNull(o.teffMin), teffMax: numOrNull(o.teffMax), spec: spec.length === SPEC_CLASSES.length ? '' : spec,
    distMin: numOrNull(o.distMin), distMax: numOrNull(o.distMax), minPlanets: Math.max(0, Math.round(+o.minPlanets || 0)), transiting: !!o.transiting, transitTonight: !!o.transitTonight, unknown: o.unknown !== false };
}
/** Which limits are set: { mag, teff, spec, dist, planets, transiting, tonight } booleans, and any. */
export function activeParts(f) {
  const p = { mag: f.magMin != null || f.magMax != null, teff: f.teffMin != null || f.teffMax != null, spec: !!f.spec, dist: f.distMin != null || f.distMax != null, planets: f.minPlanets > 0, transiting: !!f.transiting, tonight: !!f.transitTonight };
  p.any = Object.values(p).some(Boolean); return p;
}
/** Does the filter need the planet table (temperature, type, distance, the transit flag, transits tonight)? */
export const needsTable = (f) => { const p = activeParts(f); return p.teff || p.spec || p.dist || p.transiting || p.tonight; };
/** Does it need the TOI table too (temperature, type or distance of stars with candidates only)? */
export const needsToi = (f) => { const p = activeParts(f); return p.teff || p.spec || p.dist; };

const range = (lo, hi, unit, d = 0) => (lo != null && hi != null ? `${lo.toFixed(d)}–${hi.toFixed(d)}${unit}` : lo != null ? `≥ ${lo.toFixed(d)}${unit}` : `≤ ${hi.toFixed(d)}${unit}`);
/** The filter in a few words, for the chip and the assistant: ['V 6–9', 'Teff 4000–6500 K', ...]. */
export function describeFilter(f) {
  const p = activeParts(f), out = [];
  if (p.mag) out.push('mag ' + range(f.magMin, f.magMax, '', 1).replace(/\.0(?!\d)/g, ''));
  if (p.teff) out.push('Teff ' + range(f.teffMin, f.teffMax, ' K'));
  if (p.spec) out.push('type ' + f.spec.split('').join(', '));
  if (p.dist) out.push(range(f.distMin, f.distMax, ' pc'));
  if (p.planets) out.push(`≥ ${f.minPlanets} planets`);
  if (p.transiting) out.push('transiting');
  if (p.tonight) out.push('transit tonight');
  if (out.length && (p.teff || p.spec || p.dist || p.mag) && !f.unknown) out.push('unknown values out');
  return out;
}

/** URL form: 'v4..9,t3800..6500,cGK,d..100,p2,tr,tt,u0' (any part may be missing; '..' with one side open). */
export function encodeFilter(f) {
  const r = (k, lo, hi) => (lo == null && hi == null ? null : `${k}${lo ?? ''}..${hi ?? ''}`);
  return [r('v', f.magMin, f.magMax), r('t', f.teffMin, f.teffMax), f.spec ? 'c' + f.spec : null, r('d', f.distMin, f.distMax), f.minPlanets > 0 ? 'p' + f.minPlanets : null,
    f.transiting ? 'tr' : null, f.transitTonight ? 'tt' : null, f.unknown ? null : 'u0'].filter(Boolean).join(',');
}
export function decodeFilter(s) {
  const o = { ...DEFAULT_FILTER };
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([vtd])(-?[\d.]*)\.\.(-?[\d.]*)$/.exec(part);
    if (m) { const k = { v: 'mag', t: 'teff', d: 'dist' }[m[1]]; o[k + 'Min'] = m[2] === '' ? null : +m[2]; o[k + 'Max'] = m[3] === '' ? null : +m[3]; }
    else if (/^c[A-Z]+$/i.test(part)) o.spec = part.slice(1);
    else if (/^p\d+$/.test(part)) o.minPlanets = +part.slice(1);
    else if (part === 'tr') o.transiting = true; else if (part === 'tt') o.transitTonight = true; else if (part === 'u0') o.unknown = false;
  }
  return normalizeFilter(o);
}

/**
 * The TOI table (catalog-table/toi.json as the site stores it) -> Map(TIC -> { teff, dist }): the star values of
 * stars with TESS candidates. Values are [value, err+, err-] arrays or plain numbers.
 */
export function toiStarValues(toi) {
  const col = Object.fromEntries(toi.columns.map((c, i) => [c[0], i])), val = (v) => (Array.isArray(v) ? v[0] : v), out = new Map();
  for (const r of toi.rows) {
    const tic = r[col.tid]; if (tic == null) continue;
    const teff = val(r[col.st_teff]), dist = val(r[col.st_dist]), o = out.get(+tic) || {};
    if (!(o.teff > 0) && teff > 0) o.teff = teff; if (!(o.dist > 0) && dist > 0) o.dist = dist;
    out.set(+tic, o);
  }
  return out;
}

/**
 * The star values of every host (index of hosts.json): { teff, dist (Float32Array, NaN unknown), spec (Uint8Array:
 * index in SPEC_CLASSES + 1, 0 unknown), transit (Uint8Array: 1 a planet or candidate transits), known: { teff,
 * dist, spec } counts, fromToi: how many values came from the TOI table }.
 * rowsOfHost(name) -> the planet table's rows of a host ({ v: { teff, dist, sptype, transit } }) or null; toi: the
 * Map of toiStarValues, or null.
 */
export function hostAttributes(hosts, rowsOfHost, toi) {
  const n = hosts.length, teff = new Float32Array(n).fill(NaN), dist = new Float32Array(n).fill(NaN), spec = new Uint8Array(n), transit = new Uint8Array(n);
  let fromToi = 0;
  for (let i = 0; i < n; i++) {
    const h = hosts[i], rows = (rowsOfHost && rowsOfHost(h[0])) || [];
    let t = NaN, d = NaN, sp = '';
    for (const r of rows) { const v = r.v || {}; if (!fin(t) && v.teff > 0) t = v.teff; if (!fin(d) && v.dist > 0) d = v.dist; if (!sp && v.sptype) sp = v.sptype; if (v.transit) transit[i] = 1; }
    if (h[6]) {
      transit[i] = 1;       // every TESS candidate is a transit
      const o = toi && toi.get(+h[6][1]);
      if (o) { if (!fin(t) && o.teff > 0) { t = o.teff; fromToi++; } if (!fin(d) && o.dist > 0) { d = o.dist; fromToi++; } }
    }
    teff[i] = t; dist[i] = d; const c = spectralClass(sp, t); spec[i] = c ? SPEC_CLASSES.indexOf(c) + 1 : 0;
  }
  let kt = 0, kd = 0, ks = 0; for (let i = 0; i < n; i++) { if (fin(teff[i])) kt++; if (fin(dist[i])) kd++; if (spec[i]) ks++; }
  return { teff, dist, spec, transit, known: { teff: kt, dist: kd, spec: ks }, n, fromToi };
}

/** The star values of hosts.json's eighth column, in the form of hostAttributes(); null when the file has none (old build). */
export function bakedAttributes(hosts) {
  if (!hosts.length || !hosts.every((h) => Array.isArray(h[7]))) return null;
  const n = hosts.length, teff = new Float32Array(n).fill(NaN), dist = new Float32Array(n).fill(NaN), spec = new Uint8Array(n), transit = new Uint8Array(n);
  let kt = 0, kd = 0, ks = 0;
  for (let i = 0; i < n; i++) {
    const [t, d, c, tr] = hosts[i][7];
    if (t > 0) { teff[i] = t; kt++; } if (d > 0) { dist[i] = d; kd++; }
    const k = SPEC_CLASSES.indexOf(c); if (k >= 0) { spec[i] = k + 1; ks++; }
    transit[i] = tr ? 1 : 0;
  }
  return { teff, dist, spec, transit, known: { teff: kt, dist: kd, spec: ks }, n, fromToi: null, baked: true };
}

/**
 * The test of one host: (i) -> true when it passes. attrs: hostAttributes (or null before the tables: then the
 * temperature, type and distance are unknown, and "transiting" falls back on the discovery groups t and c).
 * tonight: a Set (or Map) of the host indices with a transit tonight, needed when transitTonight is set (null: none pass).
 */
export function hostTest(hosts, f, attrs, tonight) {
  const p = activeParts(f); if (!p.any) return () => true;
  const U = f.unknown, inRange = (x, lo, hi) => (fin(x) ? (lo == null || x >= lo) && (hi == null || x <= hi) : U);
  const specOk = f.spec ? SPEC_CLASSES.map((c) => f.spec.includes(c)) : null;
  return (i) => {
    const h = hosts[i];
    if (p.mag) { const m = hostMag(h); if (!inRange(m == null ? NaN : m, f.magMin, f.magMax)) return false; }
    if (p.planets && h[4] + (h[6] ? h[6][2].length : 0) < f.minPlanets) return false;
    if (p.teff && !inRange(attrs ? attrs.teff[i] : NaN, f.teffMin, f.teffMax)) return false;
    if (p.dist && !inRange(attrs ? attrs.dist[i] : NaN, f.distMin, f.distMax)) return false;
    if (p.spec) { const s = attrs ? attrs.spec[i] : 0; if (s ? !specOk[s - 1] : !U) return false; }
    if (p.transiting && !(attrs ? attrs.transit[i] : /[tc]/.test(h[5] || ''))) return false;
    if (p.tonight && !(tonight && tonight.has(i))) return false;
    return true;
  };
}
/** How many hosts pass, and how many of them only because a value is unknown (per filter part). */
export function filterCounts(hosts, f, attrs, tonight, groupOk = () => true) {
  const test = hostTest(hosts, f, attrs, tonight), p = activeParts(f), unk = { teff: 0, dist: 0, spec: 0, mag: 0 };
  let pass = 0, all = 0;
  for (let i = 0; i < hosts.length; i++) {
    if (!groupOk(i)) continue; all++;
    if (!test(i)) continue; pass++;
    if (p.teff && !(attrs && fin(attrs.teff[i]))) unk.teff++;
    if (p.dist && !(attrs && fin(attrs.dist[i]))) unk.dist++;
    if (p.spec && !(attrs && attrs.spec[i])) unk.spec++;
    if (p.mag && hostMag(hosts[i]) == null) unk.mag++;
  }
  return { pass, all, unknownIn: unk };
}
