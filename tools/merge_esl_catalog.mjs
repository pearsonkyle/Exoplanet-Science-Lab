// Merge step of the ESL catalogue (run by tools/build_esl_catalog.py; see tools/README.md).
//
//   node tools/merge_esl_catalog.mjs [--public public] [--out public/esl-catalog] [--stats stats.json] [--toi]
//
// Reads the three snapshots already under public/ and writes ONE compact file, public/esl-catalog/catalog.json, with
// for every planet: the merged best values (each with error, source catalogue and reference), the gap-filled
// estimates (each with the relation used), and suggested priors. Nothing is selected or estimated here: this script
// only calls the site's own code and packs what it returns.
//
//   merged values, provenance, estimates   loadSources + buildTable         (src/core/sources/index.js)
//   priors, planets of the NASA archive    loadIndex + lookupHost + systemFromRows(rows, { use })   (src/core/catalog.js)
//                                          use = 'transit' for a transiting planet, 'rv' for a non-transiting one with
//                                          radial velocities, 'all' otherwise (imaging, microlensing, timing ...).
//                                          Stored: its .priors, the chosen reference and the stellar reference.
//   priors, every other planet             suggestPriors(values) with values built from the merged row: kind 'other'
//                                          for a catalogue value, 'derived' for a gap-filled estimate, so every `why`
//                                          ends in "(value is other)" or "(value is derived)". Basis 'merged'.
//
// Each input file is read once (bytes -> SHA-256 -> JSON), so a snapshot being rewritten while this runs cannot
// give a mixed state; the hashes go to the manifest. The output depends only on the inputs: no clock, no random
// numbers (the time-dependent `drift` column of buildTable is left out), rows sorted by name.
//
// Rounding: periods and mid-transit times and their errors are stored exactly as the snapshot has them; other
// catalogue values to 12 significant digits, their errors to 10 (unit conversions such as hours -> days leave binary
// noise beyond that); estimates and prior bounds to 9, except the priors on the period (15) and T_mid (16).
// A prior that suggestPriors returns with a >= b (uniform) or a zero width (normal) is dropped and listed in the
// manifest (oddities.unusablePriors): it comes from a catalogue value outside the physical range.
//
// TESS candidates (--toi) are left out by default: see the manifest for why.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSources, buildTable, SOURCES, FIELDS } from '../src/core/sources/index.js';
import { loadIndex, lookupHost, systemFromRows, suggestPriors } from '../src/core/catalog.js';
import { RELATIONS } from '../src/core/relations.js';

export const FORMAT = 'esl-catalog', VERSION = 1, DATA_FILE = 'catalog.json';
/** suggestPriors key -> field of the merged row. */
export const PRIOR_KEYS = ['per', 'tmid', 'rprs', 'ars', 'inc', 'b', 't14', 'ecc', 'omega', 'K', 'mplanet', 'teff', 'logg', 'feh', 'rstar', 'mstar'];
export const PRIOR_FIELD = { mplanet: 'mass' };
export const BASES = ['transit', 'rv', 'all', 'merged'];
const EXACT = new Set(['per', 'tmid']);                          // stored digit for digit
const SKIP = new Set(['name', 'host', 'transit', 'drift']);
const ADS = 'https://ui.adsabs.harvard.edu/abs/';
const fin = Number.isFinite;
const sig = (x, n) => Number(x.toPrecision(n));

/** What systemFromRows should optimise for, from the flags of the per-reference catalogue. */
export const useFor = (p) => (p.transit ? 'transit' : p.rv ? 'rv' : 'all');

/** The `values` object suggestPriors expects, from a merged row of buildTable. */
export function valuesFromRow(row) {
  const values = {};
  for (const k of PRIOR_KEYS) {
    const f = PRIOR_FIELD[k] || k, x = row.v[f];
    if (!fin(x)) continue;
    const e = row.e[f];
    values[k] = { value: x, err: e ? (e[0] + e[1]) / 2 : null, kind: row.est[f] ? 'derived' : 'other', source: row.est[f] ? 'computed' : row.src[f] || '', note: '' };
  }
  return values;
}

function intern() {
  const at = new Map(), list = [];
  return { list, id(key, make) { let i = at.get(key); if (i === undefined) { i = list.length; at.set(key, i); list.push(make ? make() : key); } return i; } };
}

export async function merge({ pub, withToi = false }) {
  const t0 = performance.now();
  const inputs = {};
  // every file exactly once: bytes -> hash -> JSON
  const read = (rel) => { const buf = readFileSync(path.join(pub, rel)); inputs[rel] = { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }; return JSON.parse(buf.toString('utf8')); };
  const ids = withToi ? ['nea', 'eu', 'toi'] : ['nea', 'eu'];
  const loaded = await loadSources(async (file) => read(file), ids);
  for (const id of ids) if (loaded[id].error) throw new Error(`${loaded[id].source.file}: ${loaded[id].error}`);
  // `now` only enters the drift column, which is not stored; fixed anyway so that nothing depends on the clock
  const now = Date.parse(loaded.nea.meta.date + 'T00:00:00Z') / 86400000 + 2440587.5;
  const table = buildTable(loaded, { prefer: 'nea', now });
  const index = await loadIndex(async (name) => read('catalog/' + name));
  const fetchShard = async (name) => read('catalog/' + name);
  const tMerged = performance.now();

  const srcIds = SOURCES.map((s) => s.id);
  const fieldKeys = Object.keys(FIELDS).filter((k) => !SKIP.has(k));
  const fieldAt = new Map(fieldKeys.map((k, i) => [k, i]));
  const fIdx = (k) => { const i = fieldAt.get(k); if (i === undefined) throw new Error(`field ${k} is not in fields.js`); return i; };
  const relKeys = Object.keys(RELATIONS), relAt = new Map(relKeys.map((k, i) => [k, i]));
  const refs = intern(), prov = intern(), strs = intern(), estInfo = intern(), priorWhy = intern();
  const refId = (label, url = '') => {
    if (!label) return -1;
    const link = url.startsWith(ADS) && url.endsWith('/abstract') ? url.slice(ADS.length, -'/abstract'.length) : url;
    return refs.id(label + '\n' + link, () => [label, link]);
  };

  const odd = { neaNotInPs: [], chooseFailed: [], emptyPriors: [], nonFinitePriors: [], unusablePriors: [], duplicateNames: [] };
  const systems = new Map();
  async function psPriors(name) {
    const entry = index.exact.get(name);
    if (!entry || entry.type !== 'planet') { odd.neaNotInPs.push(name); return null; }
    const use = useFor(entry), key = entry.hostIndex + '|' + use;
    if (!systems.has(key)) {
      let sys = null;
      try { const host = await lookupHost(index, name, fetchShard); sys = host && systemFromRows(host.rows, { use }); }
      catch (err) { sys = { error: String(err && err.message || err) }; }
      systems.set(key, sys);
    }
    const sys = systems.get(key), p = sys && sys.planets && sys.planets.find((x) => x && x.planet === name);
    if (!p) { odd.chooseFailed.push(name + (sys && sys.error ? ': ' + sys.error : '')); return null; }
    return { basis: use, priors: p.priors, ref: refId(p.reference.label, p.reference.url), star: refId(p.reference.stellar, p.reference.stellarUrl) };
  }

  const count = { planets: 0, nea: 0, eu: 0, toi: 0, both: 0, neaOnly: 0, euOnly: 0, transiting: 0, withPriors: 0, withEstimates: 0, withLimits: 0,
    values: 0, estimates: 0, priors: 0, priorsBasis: Object.fromEntries(BASES.map((b) => [b, 0])), estimatesByRelation: {} };
  const out = [];
  for (const row of table.rows) {
    const P = { n: row.name, h: row.host, c: 0 };
    for (const id of row.cats) P.c |= 1 << srcIds.indexOf(id);
    if (row.v.transit) { P.t = 1; count.transiting++; }
    const alt = row.cats.map((id) => row.recs[id].name).filter((x, i, a) => x !== row.name && a.indexOf(x) === i);
    if (alt.length) P.a = alt;

    // catalogue values, grouped by provenance: [[provenance, field, value, error, field, value, error, ...], ...]
    const groups = new Map();
    for (const k of Object.keys(row.v)) {
      if (SKIP.has(k) || row.est[k]) continue;
      const x = row.v[k], f = FIELDS[k];
      if (!f) throw new Error(`row value ${k} is not in fields.js`);
      const str = f.kind === 'str';
      if (str ? !(typeof x === 'string' && x) : !(f.kind === 'num' && fin(x))) continue;
      const src = row.src[k], rec = src && row.recs[src], si = srcIds.indexOf(src), ri = refId(row.ref[k], (rec && rec.refUrl[k]) || '');
      const pv = prov.id(si + '|' + ri, () => [si, ri]);
      if (!groups.has(pv)) groups.set(pv, [pv]);
      const e = row.e[k], r = (y) => (EXACT.has(k) ? y : sig(y, 10));
      groups.get(pv).push(fIdx(k), str ? strs.id(x) : EXACT.has(k) ? x : sig(x, 12), str || !e ? 0 : e[0] === e[1] ? r(e[0]) : [r(e[0]), r(e[1])]);
      count.values++;
    }
    P.v = [...groups.values()];

    // limits: [field, value, sign, source] ...
    const l = [];
    for (const k of Object.keys(row.lim)) l.push(fIdx(k), sig(row.lim[k].value, 12), row.lim[k].sign, srcIds.indexOf(row.lim[k].src));
    if (l.length) { P.l = l; count.withLimits++; }

    // estimates: [field, value, info] ...
    const e = [];
    for (const k of Object.keys(row.est)) {
      const s = row.est[k];
      if (!relAt.has(s.rel)) throw new Error(`estimate of ${k} for ${row.name} names an unknown relation ${s.rel}`);
      const from = s.from.map(fIdx), note = s.note ? strs.id(s.note) : -1;
      e.push(fIdx(k), sig(s.value, 9), estInfo.id([relAt.get(s.rel), from.join(','), note, s.chain ? 1 : 0].join('|'), () => [relAt.get(s.rel), from, note, s.chain ? 1 : 0]));
      count.estimatesByRelation[s.rel] = (count.estimatesByRelation[s.rel] || 0) + 1;
    }
    if (e.length) { P.e = e; count.withEstimates++; count.estimates += e.length / 3; }

    // priors: [key, a, b, why] ... and their basis [basis, reference, stellar reference]
    let pr = row.recs.nea ? await psPriors(row.recs.nea.name) : null;
    if (!pr) pr = { basis: 'merged', priors: suggestPriors(valuesFromRow(row)), ref: -1, star: -1 };
    const p = [];
    for (const k of Object.keys(pr.priors)) {
      const q = pr.priors[k], ki = PRIOR_KEYS.indexOf(k);
      if (ki < 0) throw new Error(`suggestPriors returned an unknown key ${k}`);
      if (!fin(q.a) || !fin(q.b)) { odd.nonFinitePriors.push(`${row.name} ${k}`); continue; }
      // a prior no sampler can use (a catalogue value outside the physical range, e.g. e > 1 for an interstellar object) is not stored
      if (q.type === 'uniform' ? !(q.a < q.b) : !(q.b > 0)) { odd.unusablePriors.push(`${row.name} ${k} ${q.type}(${q.a}, ${q.b})`); continue; }
      const n = k === 'tmid' ? 16 : k === 'per' ? 15 : 9;
      p.push(ki, sig(q.a, n), sig(q.b, n), priorWhy.id(q.type + '\n' + q.why, () => [q.type === 'normal' ? 1 : 0, q.why]));
      if (q.type !== 'normal' && q.type !== 'uniform') throw new Error(`unknown prior type ${q.type}`);
    }
    if (p.length) { P.p = p; P.pb = [BASES.indexOf(pr.basis), pr.ref, pr.star]; count.withPriors++; count.priors += p.length / 4; count.priorsBasis[pr.basis]++; }
    else odd.emptyPriors.push(row.name);

    count.planets++;
    const nea = row.cats.includes('nea'), eu = row.cats.includes('eu');
    if (nea) count.nea++; if (eu) count.eu++; if (row.cats.includes('toi')) count.toi++;
    if (nea && eu) count.both++; else if (nea) count.neaOnly++; else if (eu) count.euOnly++;
    out.push(P);
  }
  out.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  for (let i = 1; i < out.length; i++) if (out[i].n === out[i - 1].n) odd.duplicateNames.push(out[i].n);

  const used = ids.map((id) => loaded[id]);
  const credits = used.map((L) => ({ id: L.source.id, label: L.source.label, url: L.source.url, licence: L.meta.licence || '', acknowledgement: L.meta.acknowledgement || L.source.acknowledgement }));
  const data = {
    format: FORMAT, v: VERSION,
    about: 'Exoplanet Science Lab catalogue: NASA Exoplanet Archive and exoplanet.eu merged, with gap-filled estimates and suggested priors. Reader: src/core/sources/eslcatalog.js; layout: manifest.json (schema) and tools/README.md.',
    snapshots: { ...Object.fromEntries(used.map((L) => [L.source.id, L.meta.date])), ps: index.date },
    credits,
    sources: srcIds,
    fields: fieldKeys.map((k) => [k, FIELDS[k].kind === 'str' ? 's' : 'n', FIELDS[k].unit || '', FIELDS[k].desc]),
    priorKeys: PRIOR_KEYS, priorTypes: ['uniform', 'normal'], bases: BASES,
    relations: relKeys.map((k) => [k, RELATIONS[k].name, RELATIONS[k].cite]),
    refs: refs.list, prov: prov.list, strs: strs.list, estInfo: estInfo.list, priorWhy: priorWhy.list,
    planets: out,
  };
  const t1 = performance.now();
  const cap = (a) => ({ n: a.length, first: a.slice(0, 25) });
  const stats = {
    format: FORMAT, v: VERSION, file: DATA_FILE, withToi,
    snapshots: [
      ...used.map((L) => ({ id: L.source.id, label: L.source.label, file: L.source.file, table: L.meta.table || '', url: L.meta.url || L.source.url, date: L.meta.date, rows: L.records.length, ...inputs[L.source.file] })),
      { id: 'ps', label: 'NASA Exoplanet Archive, every published reference', file: 'catalog/index.json + ' + index.nshards + ' shards', table: index.source, url: 'https://exoplanetarchive.ipac.caltech.edu/', date: index.date,
        rows: index.rows, planets: index.nplanets, hosts: index.nhosts, shardsRead: index.cache.size, ...inputs['catalog/index.json'],
        shardsSha256: (() => { const h = createHash('sha256'); for (const k of Object.keys(inputs).filter((x) => /^catalog\/shard-/.test(x)).sort()) h.update(inputs[k].sha256); return h.digest('hex'); })() },
    ],
    credits,
    counts: { ...count, match: table.match ? table.match.stats : null,
      tables: { refs: refs.list.length, prov: prov.list.length, strs: strs.list.length, estInfo: estInfo.list.length, priorWhy: priorWhy.list.length } },
    oddities: Object.fromEntries(Object.entries(odd).map(([k, a]) => [k, cap(a)])),
    seconds: { sourcesAndMerge: +((tMerged - t0) / 1000).toFixed(2), priorsAndPacking: +((t1 - tMerged) / 1000).toFixed(2) },
  };
  return { data, stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pub = path.resolve(opt('--public', path.join(root, 'public'))), outDir = path.resolve(opt('--out', path.join(pub, 'esl-catalog')));
  const t0 = performance.now();
  const { data, stats } = await merge({ pub, withToi: args.includes('--toi') });
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, DATA_FILE), text = JSON.stringify(data);
  writeFileSync(file + '.tmp', text); renameSync(file + '.tmp', file);                 // never a half-written catalogue
  stats.seconds.total = +((performance.now() - t0) / 1000).toFixed(2);
  const sp = opt('--stats', null);
  if (sp) writeFileSync(sp, JSON.stringify(stats, null, 1));
  const c = stats.counts;
  console.log(`${DATA_FILE}: ${c.planets} planets (${c.both} in both catalogues, ${c.neaOnly} NASA only, ${c.euOnly} exoplanet.eu only${c.toi ? ', ' + c.toi + ' TOIs' : ''}), ` +
    `${c.withPriors} with priors, ${c.withEstimates} with estimates, ${(text.length / 1e6).toFixed(2)} MB, ${stats.seconds.total} s`);
}
