// What the Observe page knows about exoplanet hosts beyond their positions: the name index for the search box and
// the one-row-per-planet table for the card. Both are fetched on demand, never at page load:
//   catalog/index.json (0.3 MB)        names and aliases, on the first use of the search box or a ?planet= link
//   catalog-table/nea.json (4.9 MB)    the planets' values, when the Exoplanets layer is switched on or a host card opens
// The table is read and its gaps are filled by the same code as the Search page (src/core/sources, which uses
// src/core/relations.js): nothing about the catalogue is re-derived here.
import { loadIndex, searchNames, resolveName } from '../core/catalog.js';
import { loadSources, buildTable, FIELDS } from '../core/sources/index.js';
import { RELATIONS, RJUP_REARTH } from '../core/relations.js';
import { esc, display } from '../search/format.js';

export { esc };

/**
 * Size classes by radius, in Earth radii: the Kepler classes of Borucki et al. (2011, ApJ 736, 19, sec. 3):
 * Earth-size below 1.25, super-Earth-size to 2, Neptune-size to 6, Jupiter-size to 15, larger above.
 */
export function sizeClass(rEarth) {
  if (!Number.isFinite(rEarth)) return '';
  return rEarth < 1.25 ? 'Earth-size' : rEarth < 2 ? 'super-Earth-size' : rEarth < 6 ? 'Neptune-size' : rEarth < 15 ? 'Jupiter-size' : 'larger than Jupiter';
}
export const SIZE_CLASS_NOTE = 'Size classes of Borucki et al. 2011 (Kepler): Earth-size < 1.25 R⊕, super-Earth-size < 2, Neptune-size < 6, Jupiter-size < 15';

export function createCatalog(fetchJson) {
  const st = { index: null, indexPromise: null, table: 'idle', error: '', byHost: null, date: '', tablePromise: null };
  return {
    state: st,
    /** The name index (hosts, aliases, planets). */
    index() { return st.indexPromise ||= loadIndex((n) => fetchJson('catalog/' + n)).then((i) => (st.index = i)).catch((e) => { st.indexPromise = null; throw e; }); },
    /** The planet table, grouped by host name: Map(host -> rows of buildTable). */
    table() {
      if (st.tablePromise) return st.tablePromise;
      st.table = 'loading';
      return st.tablePromise = loadSources(fetchJson, ['nea']).then((loaded) => {
        if (loaded.nea.error) throw new Error(loaded.nea.error);
        const by = new Map();
        for (const r of buildTable(loaded).rows) { if (!by.has(r.host)) by.set(r.host, []); by.get(r.host).push(r); }
        for (const rows of by.values()) rows.sort((a, b) => (a.name < b.name ? -1 : 1));
        st.byHost = by; st.date = loaded.nea.meta.date || ''; st.table = 'ready'; return by;
      }).catch((e) => { st.table = 'error'; st.error = String(e && e.message || e); st.tablePromise = null; throw e; });
    },
    rowsOfHost: (host) => (st.byHost ? st.byHost.get(host) || [] : null),
    /** Autocomplete over the index (must be loaded): [{ label, type: 'planet' | 'host' | 'alias', planet, host }]. */
    suggest: (q, limit = 8) => (st.index ? searchNames(st.index, q, limit) : []),
    /** A typed or linked name -> { host, planet | null } or null. Loads the index. */
    async resolve(name) { const i = await this.index(); const r = resolveName(i, name); return r ? { host: r.host, planet: r.planet } : null; },
  };
}

// ---------------------------------------------------------------- the card
const MAGS = [['vmag', 'V'], ['gmag', 'G'], ['tmag', 'T'], ['jmag', 'J'], ['kmag', 'K']];
/** A value in display units; an estimate gets a leading ~ and is listed (with its relation) in `notes`. */
function shown(row, k, units, notes, label) {
  const v = row.v[k]; if (!Number.isFinite(v)) return '';
  const e = row.est[k], t = esc(display(k, v, units));
  // the archive's composite table fills some gaps itself (reference "Calculated Value"): not a measurement either
  const calc = !e && /calculated/i.test(row.ref[k] || '');
  if (!e && !calc) return t;
  const R = e && RELATIONS[e.rel], why = calc ? 'calculated by the NASA Exoplanet Archive from other quantities, not measured' : `${R.name}, from ${e.from.map((f) => FIELDS[f].label).join(', ')}${e.note ? '. ' + e.note : ''}`;
  if (notes && !notes.some((n) => n[0] === label)) notes.push([label, why]);
  return `<span class="est" title="${esc('Estimated: ' + why)}">~${t}</span>`;
}

/** Magnitudes of the host as chips, every band the catalogue has. */
export function magnitudesHtml(rows, fallbackV) {
  const r = rows && rows[0], out = [];
  if (r) for (const [k, name] of MAGS) if (Number.isFinite(r.v[k])) out.push(`<span class="mag" title="${esc(FIELDS[k].desc)}"><i>${name}</i> ${r.v[k].toFixed(2)}</span>`);
  if (!out.length && Number.isFinite(fallbackV)) out.push(`<span class="mag" title="V magnitude"><i>V</i> ${fallbackV.toFixed(2)}</span>`);
  return out.length ? `<div class="mags">${out.join('')}</div>` : '<div class="mags none">no magnitude in the archive</div>';
}
/** One line about the star: spectral type, temperature, distance. */
export function starLine(rows) {
  const r = rows && rows[0]; if (!r) return '';
  return [r.v.sptype, Number.isFinite(r.v.teff) ? `${r.v.teff.toFixed(0)} K` : '', Number.isFinite(r.v.dist) ? `${r.v.dist.toFixed(r.v.dist < 100 ? 1 : 0)} pc` : ''].filter(Boolean).map(esc).join(' · ');
}

/** The planets of a host. root: URL of the site root; focus: the planet that was asked for (shown first, marked). */
export function planetsHtml(rows, root, focus) {
  const list = rows.slice().sort((a, b) => (a.name === focus ? -1 : b.name === focus ? 1 : 0));
  return list.map((r) => {
    const notes = [], kv = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');
    const rE = r.v.rp * RJUP_REARTH, cls = sizeClass(rE);
    const radius = Number.isFinite(r.v.rp) ? `${shown(r, 'rp', 'earth', notes, 'Radius')} R⊕ · ${shown(r, 'rp', 'jup', notes, 'Radius')} R<sub>J</sub>` : '';
    const msini = /sin/i.test(r.v.massKind || '') && !r.est.mass && Number.isFinite(r.v.mass);
    const mass = Number.isFinite(r.v.mass) ? `${shown(r, 'mass', 'earth', notes, 'Mass')} M⊕ · ${shown(r, 'mass', 'jup', notes, 'Mass')} M<sub>J</sub>${msini ? ' <span class="hint" title="A minimum mass from radial velocities: M sin i">sin i</span>' : ''}` : '<span class="none">not known</span>';
    const per = Number.isFinite(r.v.per) ? `${shown(r, 'per', 'earth', notes, 'Period')} d` : '';
    const teq = Number.isFinite(r.v.teq) ? `${shown(r, 'teq', 'earth', notes, 'Equilibrium temperature')} K` : '';
    let transit;
    if (r.v.transit) {
      const bits = [];
      if (Number.isFinite(r.v.depth)) bits.push(`${shown(r, 'depth', 'earth', notes, 'Transit depth')} ppt`);
      if (Number.isFinite(r.v.t14)) bits.push(`${shown(r, 't14', 'earth', notes, 'Transit duration')} h`);
      transit = 'yes' + (bits.length ? ' · ' + bits.join(' · ') : ' · depth and duration not given');
    } else transit = '<span class="none">not known to transit</span>';
    const found = [r.v.method, Number.isFinite(r.v.year) ? r.v.year.toFixed(0) : ''].filter(Boolean).map(esc).join(' · ');
    const q = encodeURIComponent(r.name), link = (page, text, cls2 = '') => `<a class="btn ${cls2}" href="${esc(new URL(page + '/?planet=' + q, root).href)}">${text}</a>`;
    return `<section class="pl${r.name === focus ? ' focus' : ''}"><div class="pl-h"><b>${esc(r.name)}</b>${cls ? `<span class="cls" title="${esc(SIZE_CLASS_NOTE)}">${r.est.rp || /calculated/i.test(r.ref.rp || '') ? '~' : ''}${cls}</span>` : ''}</div>` +
      `<div class="grid">${kv('Radius', radius)}${kv('Mass', mass)}${kv('Period', per)}${kv('Eq. temp.', teq)}${kv('Transits', transit)}${kv('Found', found)}</div>` +
      (notes.length ? `<div class="estnote">${notes.map(([l, w]) => `<span class="est">~</span> ${esc(l)}: ${esc(w)}`).join('<br>')}</div>` : '') +
      `<div class="links">${link('analyze', 'Analyze', 'primary')}${link('plan', 'Plan')}${link('search', 'Search')}</div></section>`;
  }).join('');
}

/**
 * ARCHIVE DATA: how much archive data exists for this target (TESS sectors, Kepler quarters, ground-based light
 * curves, ...) will be shown here. Nothing is known yet, so this returns an empty, hidden section: fill it in
 * here (host name and the planet rows are passed) and remove `hidden` once there is something to show.
 */
export function archiveDataHtml(/* hostName, rows */) {
  return '<section class="card-archive" data-slot="archive-data" hidden></section>';
}
