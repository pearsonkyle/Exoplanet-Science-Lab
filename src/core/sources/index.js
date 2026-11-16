// The catalogues the Search and Plan pages read, as plug-ins, and the table built from them. No DOM.
//
// A plug-in (nea.js, eu.js, toi.js) is { id, short, label, file, url, about, acknowledgement, planetUrl(rec),
// records(json) -> { meta, records } }: it turns its snapshot into records whose values are keyed by the common
// fields of fields.js, in ESL units, each with its errors and (where the catalogue has one) its reference.
// Adding a catalogue is adding such a module to SOURCES and a builder for its snapshot in tools/.
//
// buildTable() merges the records into one row per object: planets of the primary catalogue matched to those of
// the others (match.js), every value labelled with the catalogue it came from, disagreements between catalogues
// listed, and gaps filled from named relations (fill.js).

import nea from './nea.js';
import eu from './eu.js';
import toi from './toi.js';
import { matchCatalogues } from './match.js';
import { fillGaps } from './fill.js';
import { FIELDS, NUMERIC_FIELDS } from './fields.js';

export { FIELDS, NUMERIC_FIELDS, matchCatalogues, fillGaps };
export const SOURCES = [nea, eu, toi];
export const sourceById = (id) => SOURCES.find((s) => s.id === id);

/**
 * Load the snapshots. fetchJson(file) resolves a path under the site's public folder ('catalog-table/nea.json').
 * ids: which sources. Returns { [id]: { source, meta, records } }; a source that fails to load has `error` instead.
 */
export async function loadSources(fetchJson, ids = SOURCES.map((s) => s.id)) {
  const out = {};
  await Promise.all(ids.map(async (id) => {
    const source = sourceById(id);
    try { out[id] = { source, ...source.records(await fetchJson(source.file)) }; }
    catch (err) { out[id] = { source, meta: {}, records: [], error: String(err && err.message || err) }; }
  }));
  return out;
}

// ---- disagreement between two catalogues on one quantity ---------------------------------------------------------
// [relative floor, absolute floor]: a difference must exceed 3 sigma (when errors are quoted) AND one of these to be listed.
const DIFF = {
  per: [1e-4, 0], t14: [0.1, 0], rp: [0.1, 0], mass: [0.15, 0], ecc: [0, 0.05], inc: [0, 1.5], a: [0.05, 0], K: [0.15, 0], b: [0, 0.15],
  teff: [0, 150], rstar: [0.1, 0], mstar: [0.1, 0], feh: [0, 0.15], dist: [0.1, 0], vmag: [0, 0.3], teq: [0.1, 0],
};
const sig = (e) => (e ? (e[0] + e[1]) / 2 : 0);
/** Compare field values a, b with errors ea, eb ([lo, hi] or undefined). Returns null when they agree, else { nsigma, frac }. */
export function disagreement(field, a, b, ea, eb) {
  const lim = DIFF[field];
  if (!lim || !Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  const d = Math.abs(a - b), frac = d / Math.max(Math.abs(a), Math.abs(b), 1e-300), s = Math.hypot(sig(ea), sig(eb));
  const big = (lim[0] && frac > lim[0]) || (lim[1] && d > lim[1]);
  if (!big) return null;
  if (s > 0 && d / s <= 3) return null;
  return { nsigma: s > 0 ? d / s : null, frac };
}
// Mid-transit times are compared as predictions: one ephemeris propagated to the other's epoch.
function tmidDisagreement(A, B) {
  const P = A.v.per, ta = A.v.tmid, tb = B.v.tmid;
  if (!(P > 0) || !Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  const n = Math.round((tb - ta) / P), d = Math.abs(tb - (ta + n * P));
  const s = Math.hypot(sig(A.e.tmid), sig(B.e.tmid), n * sig(A.e.per));
  if (d < 10 / 1440 || (s > 0 && d / s <= 3)) return null;
  return { nsigma: s > 0 ? d / s : null, frac: d / P, minutes: d * 1440, epochs: n };
}

const MASS_TRUE = (k) => !/sin/i.test(k || '');

/**
 * One table row from the records of one object in each catalogue. recs: { nea?, eu?, toi? }; prefer: source id
 * whose value is shown when several have one.
 * Row: { key, name, host, cats: ['nea', 'eu'], recs, v, e, src: {field: source id}, ref: {field: label}, lim,
 *        diff: {field: {a, b, nsigma, frac}}, est: {field: {value, rel, from, note}}, match }
 */
export function makeRow(recs, prefer = 'nea', now = Date.now() / 86400000 + 2440587.5, match = null) {
  const order = [prefer, ...SOURCES.map((s) => s.id).filter((id) => id !== prefer)].filter((id) => recs[id]);
  const first = recs[order[0]];
  const row = { key: first.id, name: (recs.nea || first).name, host: (recs.nea || first).host, cats: SOURCES.map((s) => s.id).filter((id) => recs[id]), recs, v: {}, e: {}, src: {}, ref: {}, lim: {}, diff: {}, est: {}, match };
  for (const id of order) {
    const r = recs[id];
    for (const k in r.v) {
      if (row.v[k] !== undefined && row.v[k] !== '') continue;
      if (r.v[k] === '' || r.v[k] == null) continue;
      // period and epoch travel together: never take one from each catalogue
      if ((k === 'per' || k === 'tmid') && row.src.per && row.src.per !== id && row.v.tmid !== undefined) continue;
      row.v[k] = r.v[k]; row.src[k] = id;
      if (r.e[k]) row.e[k] = r.e[k];
      if (r.ref[k]) row.ref[k] = r.ref[k];
    }
    for (const k in r.lim) if (!(k in row.lim)) row.lim[k] = { ...r.lim[k], src: id };
  }
  row.v.name = row.name; row.v.host = row.host;
  row.v.transit = order.some((id) => recs[id].v.transit);
  if (recs.nea && recs.eu) {
    const A = recs.nea, B = recs.eu;
    for (const k of Object.keys(DIFF)) {
      if (k === 'mass' && MASS_TRUE(A.v.massKind) !== MASS_TRUE(B.v.massKind)) continue;        // a mass against an M sin i is not a disagreement
      const d = disagreement(k, A.v[k], B.v[k], A.e[k], B.e[k]);
      if (d) row.diff[k] = { ...d, nea: A.v[k], eu: B.v[k] };
    }
    const t = tmidDisagreement(A, B);
    if (t) row.diff.tmid = { ...t, nea: A.v.tmid, eu: B.v.tmid };
  }
  row.ndiff = Object.keys(row.diff).length;
  row.est = fillGaps(row.v);
  for (const k in row.est) row.v[k] = row.est[k].value;
  row.nest = Object.keys(row.est).length;
  // predicted timing uncertainty today
  if (row.v.per > 0 && Number.isFinite(row.v.tmid) && row.e.per && row.e.tmid) {
    row.v.drift = Math.hypot(sig(row.e.tmid), (now - row.v.tmid) / row.v.per * sig(row.e.per)) * 1440;
    row.src.drift = row.src.per;
  }
  return row;
}

/**
 * The whole table. loaded: the result of loadSources. opts.prefer: 'nea' | 'eu'.
 * Returns { rows, match: the result of matchCatalogues(nea, eu) or null, counts: { both, neaOnly, euOnly, toi } }.
 */
export function buildTable(loaded, opts = {}) {
  const prefer = opts.prefer || 'nea', now = opts.now ?? Date.now() / 86400000 + 2440587.5;
  const A = loaded.nea ? loaded.nea.records : [], B = loaded.eu ? loaded.eu.records : [], T = loaded.toi ? loaded.toi.records : [];
  const rows = [];
  let match = null;
  if (A.length && B.length) {
    match = matchCatalogues(A, B);
    for (const p of match.pairs) rows.push(makeRow({ nea: p.a, eu: p.b }, prefer, now, { stage: p.stage, sep: p.sep, dper: p.dper, flags: p.flags }));
    for (const a of match.onlyA) rows.push(makeRow({ nea: a }, prefer, now));
    for (const b of match.onlyB) rows.push(makeRow({ eu: b }, prefer, now));
  } else {
    for (const a of A) rows.push(makeRow({ nea: a }, prefer, now));
    for (const b of B) rows.push(makeRow({ eu: b }, prefer, now));
  }
  for (const t of T) rows.push(makeRow({ toi: t }, prefer, now));
  return { rows, match, counts: { both: match ? match.pairs.length : 0, neaOnly: match ? match.onlyA.length : A.length, euOnly: match ? match.onlyB.length : B.length, toi: T.length } };
}

/** Find a row by a name as a person would type it (planet name or alias, any catalogue). Returns the row or null. */
export function findRow(rows, name) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''), k = norm(name);
  if (!k) return null;
  let alias = null;
  for (const r of rows) {
    if (norm(r.name) === k) return r;
    if (!alias) for (const id of r.cats) { const rec = r.recs[id]; if (norm(rec.name) === k || rec.aliases.some((a) => norm(a) === k)) { alias = r; break; } }
  }
  return alias;
}
