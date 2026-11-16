// Search page: the catalogues as one table. State is the object S below; everything on screen is redrawn from it.
import { siteRoot } from '../site/nav.js';
import { SOURCES, loadSources, buildTable, FIELDS } from '../core/sources/index.js';
import { RELATIONS } from '../core/relations.js';
import { esc, display, unitOf, shown } from './format.js';
import { createTable } from './table.js';
import { renderDetail } from './detail.js';

const $ = (id) => document.getElementById(id);
const fetchJson = async (file) => { const r = await fetch(new URL(file, siteRoot())); if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`); return r.json(); };
const STORE = 'esl.search.v1';

// column key -> [width px, extra]. Keys are common fields, or the specials 'cats', 'mag', 'ndiff'.
const COLS = {
  name: [170], cats: [86, 'Listed in'], status: [150], method: [130], host: [140], facility: [170], year: [56],
  per: [96], drift: [92, 'T unc. now'], tmid: [128], t14: [70, 'Dur.'], depth: [88], rprs: [72], ars: [66], b: [56], inc: [64], ecc: [60], omega: [62], a: [76],
  rp: [74, 'Radius'], mass: [84], K: [76], teq: [64], insol: [80],
  teff: [62], rstar: [60], mstar: [60], logg: [58], feh: [62], lum: [72], sptype: [84],
  mag: [70], vmag: [58], gmag: [58], tmag: [58], jmag: [58], kmag: [58], ra: [84], dec: [84], dist: [72, 'Dist.'], ndiff: [62],
};
const SPECIAL = {
  cats: { label: 'Catalogues', group: 'Identity', desc: 'Which catalogues list this object' },
  mag: { label: 'Mag', group: 'Brightness', desc: 'V magnitude, or Gaia G, or TESS when there is no V', kind: 'num' },
  ndiff: { label: 'Differ', group: 'Identity', desc: 'Number of quantities on which the NASA archive and exoplanet.eu disagree', kind: 'num' },
};
const meta = (k) => { const m = FIELDS[k] || SPECIAL[k]; return COLS[k] && COLS[k][1] ? { ...m, label: COLS[k][1] } : m; };
const DEFAULT_COLS = ['name', 'cats', 'status', 'method', 'per', 'drift', 't14', 'depth', 'rp', 'mass', 'teq', 'mag', 'teff', 'rstar', 'dist', 'dec', 'ndiff'];
// range filters: field -> label (display units come from format.js)
const RANGES = ['per', 't14', 'depth', 'mag', 'dec', 'rp', 'mass', 'teff', 'teq', 'dist', 'drift', 'year'];
const STATUSES = ['Confirmed', 'Candidate', 'Known planet (TOI entry)', 'False positive'];
const statusClass = (s) => (/^Confirmed/.test(s) ? 'Confirmed' : /^Candidate/.test(s) ? 'Candidate' : /^Known/.test(s) ? 'Known planet (TOI entry)' : 'False positive');

const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
const S = {
  loaded: null, table: null, rows: [], view: [],
  sources: saved.sources || { nea: true, eu: true, toi: true },
  prefer: saved.prefer === 'eu' ? 'eu' : 'nea', units: saved.units === 'jup' ? 'jup' : 'earth',
  cols: (saved.cols || DEFAULT_COLS).filter((c) => COLS[c]),
  sort: saved.sort || { key: 'name', dir: 1 },
  q: new URLSearchParams(location.search).get('q') || '',
  // filters are remembered too (the ranges are in the units they were typed in: a change of units clears them)
  ranges: saved.filters && saved.filters.units === (saved.units === 'jup' ? 'jup' : 'earth') && saved.filters.ranges ? saved.filters.ranges : {},
  method: (saved.filters && saved.filters.method) || '', transit: (saved.filters && saved.filters.transit) || 'any', cats: (saved.filters && saved.filters.cats) || 'any',
  status: new Set(saved.status || ['Confirmed', 'Candidate']), diffOnly: !!(saved.filters && saved.filters.diffOnly), estToo: !(saved.filters && saved.filters.estToo === false),
  selected: null,
};
const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ sources: S.sources, prefer: S.prefer, units: S.units, cols: S.cols, sort: S.sort, status: [...S.status],
  filters: { units: S.units, ranges: S.ranges, method: S.method, transit: S.transit, cats: S.cats, diffOnly: S.diffOnly, estToo: S.estToo } })); } catch { /* private mode */ } };

// ------------------------------------------------------------------------------------------------ cells

const SRC_CLASS = { eu: 'k-eu', toi: 'k-toi' };
/** Sort / filter value of a column for a row, in display units. */
function value(row, key) {
  if (key === 'cats') return row.cats.join('+');
  if (key === 'ndiff') return row.ndiff || NaN;
  const v = row.v[key];
  if (typeof v !== 'number') return v;
  return key === 'drift' ? v : v * shown(key, S.units)[0];
}
function tip(row, key) {
  const e = row.est[key], d = row.diff[key];
  if (e) return `estimated, not from a catalogue: ${RELATIONS[e.rel].name} [${RELATIONS[e.rel].cite}], from ${e.from.map((k) => (FIELDS[k] ? FIELDS[k].label : k)).join(', ')}${e.note ? '. ' + e.note : ''}`;
  const src = row.src[key === 'mag' ? row.magField : key]; let t = '';
  if (src) t = SOURCES.find((s) => s.id === src).label + (row.ref[key] ? ': ' + row.ref[key] : '');
  if (d) t += ` | differs: NASA archive ${display(key, d.nea, S.units)}, exoplanet.eu ${display(key, d.eu, S.units)}` + (d.nsigma ? ` (${d.nsigma.toFixed(1)} sigma)` : '');
  return t;
}
function cell(row, key) {
  const m = meta(key), w = COLS[key][0];
  let cls = 'vt-td' + (key === 'name' ? ' pin l' : m.kind === 'num' ? '' : ' l'), text = '', html = null;
  if (key === 'cats') html = row.cats.map((c) => `<span class="tag ${c}">${SOURCES.find((s) => s.id === c).short}</span>`).join('');
  else if (key === 'ndiff') { text = row.ndiff ? String(row.ndiff) : ''; if (row.ndiff) cls += ' warn'; }
  else if (key === 'mag') text = Number.isFinite(row.v.mag) ? row.v.mag.toFixed(2) + ' ' + row.magBand : '';
  else if (key === 'transit') text = row.v.transit ? 'yes' : '';
  else if (m.kind === 'num') {
    text = display(key, row.v[key], S.units);
    if (key === 'drift' && row.v.drift > 60) cls += row.v.drift > 240 ? ' bad' : ' warn';
    if (!text && row.lim[key]) text = (row.lim[key].sign > 0 ? '<' : '>') + display(key, row.lim[key].value, S.units);
  } else text = row.v[key] || '';
  if (row.est[key]) { cls += ' est'; text = '~' + text; }
  else if (SRC_CLASS[row.src[key]] && m.kind === 'num') cls += ' ' + SRC_CLASS[row.src[key]];
  if (row.diff[key]) cls += ' diff';
  const t = tip(row, key);
  return `<div class="${cls}" style="width:${w}px"${t ? ` title="${esc(t)}"` : ''}>${html ?? esc(text)}</div>`;
}
function headCell(key) {
  const m = meta(key), u = unitOf(key, S.units), sorted = S.sort.key === key;
  return `<div class="vt-th${key === 'name' ? ' pin l' : m.kind === 'num' ? '' : ' l'}${sorted ? ' sorted' : ''}" data-key="${key}" style="width:${COLS[key][0]}px" title="${esc(m.desc || '')}" role="columnheader" aria-sort="${sorted ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(m.label)}${u ? ` <small>${esc(u)}</small>` : ''}${sorted ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</div>`;
}

// ------------------------------------------------------------------------------------------------ filter and sort

function passes(row) {
  if (!row.cats.some((c) => S.sources[c])) return false;
  if (!S.status.has(statusClass(row.v.status || ''))) return false;
  if (S.transit !== 'any' && (S.transit === 'yes') !== !!row.v.transit) return false;
  if (S.cats === 'both' ? row.cats.length < 2 : S.cats !== 'any' && !(row.cats.length === 1 && row.cats[0] === S.cats)) return false;
  if (S.diffOnly && !row.ndiff) return false;
  if (S.method && !(row.v.method || '').includes(S.method)) return false;
  for (const k in S.ranges) {
    const [lo, hi] = S.ranges[k], x = value(row, k);
    if (!Number.isFinite(x) || (lo != null && x < lo) || (hi != null && x > hi)) return false;
    if (!S.estToo && row.est[k]) return false;
  }
  if (S.qn) for (const w of S.qn) if (!row.hay.includes(w)) return false;
  return true;
}
function refresh(keepScroll) {
  S.qn = S.q.trim().toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[^a-z0-9.+]/g, '')).filter(Boolean);
  const k = S.sort.key, dir = S.sort.dir, numeric = meta(k).kind === 'num';
  const view = S.rows.filter(passes), val = new Map(view.map((r) => [r, value(r, k)]));
  view.sort((a, b) => {
    const x = val.get(a), y = val.get(b);
    if (numeric) { const fx = Number.isFinite(x), fy = Number.isFinite(y); return fx && fy ? (x - y) * dir : fx ? -1 : fy ? 1 : 0; }      // missing values last, either direction
    const sx = String(x || '').replace(/^[^A-Za-z0-9]+/, ''), sy = String(y || '').replace(/^[^A-Za-z0-9]+/, '');
    return !sx !== !sy ? (sx ? -1 : 1) : sx.localeCompare(sy, 'en', { numeric: true, sensitivity: 'base' }) * dir;
  });
  S.view = view;
  vt.setData(view, S.cols, keepScroll);
  const n = Object.keys(S.ranges).length + (S.method ? 1 : 0) + (S.transit !== 'any' ? 1 : 0) + (S.cats !== 'any' ? 1 : 0) + (S.diffOnly ? 1 : 0);
  $('s-nfilters').textContent = n ? String(n) : '';
  $('s-count').textContent = `${view.length.toLocaleString('en')} of ${S.rows.length.toLocaleString('en')} rows`;
}

// ------------------------------------------------------------------------------------------------ panels

function drawSources() {
  $('s-sources').innerHTML = SOURCES.map((s) => {
    const L = S.loaded && S.loaded[s.id], n = L ? L.records.length : 0;
    return `<label class="s-src${S.sources[s.id] ? '' : ' off'}" title="${esc(s.about)}"><input type="checkbox" data-src="${s.id}"${S.sources[s.id] ? ' checked' : ''}><span class="tag ${s.id}">${s.short}</span><b>${esc(s.label)}</b>` +
      `<small>${L ? (L.error ? 'failed to load: ' + esc(L.error) : `${n.toLocaleString('en')} rows · snapshot ${esc(L.meta.date || '')}`) : 'loading…'}</small><a href="${s.url}" target="_blank" rel="noopener" title="Open ${esc(s.label)}">↗</a></label>`;
  }).join('');
}
function drawColumns() {
  const groups = {};
  for (const k of Object.keys(COLS)) (groups[meta(k).group] ||= []).push(k);
  $('s-cols').innerHTML = Object.entries(groups).map(([g, keys]) => `<h4>${esc(g)}</h4>` + keys.map((k) => `<label title="${esc(meta(k).desc || '')}"><input type="checkbox" data-col="${k}"${S.cols.includes(k) ? ' checked' : ''}${k === 'name' ? ' disabled' : ''}>${esc(meta(k).label)}</label>`).join('')).join('') +
    '<h4></h4><label><button class="btn" id="s-cols-reset" type="button">Default columns</button></label>';
}
function drawFilters() {
  const methods = [...new Set(S.rows.flatMap((r) => (r.v.method || '').split(', ')).filter(Boolean))].sort();
  const range = (k) => { const r = S.ranges[k] || []; return `<label class="f-range" title="${esc(meta(k).desc || '')}"><span>${esc(meta(k).label)} <span class="u">${esc(k === 'drift' ? 'min' : unitOf(k, S.units))}</span></span><input type="number" step="any" data-range="${k}" data-end="0" placeholder="min" value="${r[0] ?? ''}" aria-label="${esc(meta(k).label)} minimum"><i>–</i><input type="number" step="any" data-range="${k}" data-end="1" placeholder="max" value="${r[1] ?? ''}" aria-label="${esc(meta(k).label)} maximum"></label>`; };
  const sel = (id, label, opts, cur) => `<label class="f-sel">${label}<select id="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  $('s-filters').innerHTML = RANGES.map(range).join('') +
    sel('f-method', 'Discovery method', [['', 'Any'], ...methods.map((m) => [m, m])], S.method) +
    sel('f-transit', 'Transiting', [['any', 'Any'], ['yes', 'Yes'], ['no', 'No']], S.transit) +
    sel('f-cats', 'Listed in', [['any', 'Any catalogue'], ['both', 'Both NASA archive and exoplanet.eu'], ['nea', 'NASA archive only'], ['eu', 'exoplanet.eu only'], ['toi', 'TOI list']], S.cats) +
    `<div class="f-checks"><span class="d-note">Status:</span>${STATUSES.map((s) => `<label><input type="checkbox" data-status="${esc(s)}"${S.status.has(s) ? ' checked' : ''}>${esc(s)}</label>`).join('')}` +
    `<label title="Only planets on which the two catalogues disagree"><input type="checkbox" id="f-diff"${S.diffOnly ? ' checked' : ''}>Catalogues disagree</label>` +
    `<label title="When off, a range only matches values a catalogue gives"><input type="checkbox" id="f-est"${S.estToo ? ' checked' : ''}>Ranges also match estimated values</label></div>` +
    '<div class="f-actions"><button class="btn" id="f-clear" type="button">Clear filters</button><span>Ranges are in the units shown; rows without a value fail a range.</span></div>';
}
function drawLegend() {
  $('s-legend').innerHTML = '<span>Value from: NASA archive</span><span class="k-eu">exoplanet.eu</span><span class="k-toi">TOI list</span>' +
    '<span class="est">~estimated from a published relation (hover for which)</span><span class="k-diff">≠ the two catalogues disagree</span><span>Click a row for every value, its reference and the consistency checks.</span>';
}
function selectRow(row) {
  S.selected = row;
  vt.select(row);
  const el = $('s-detail');
  if (!row) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  renderDetail(el, row, { units: S.units, fetchJson, onClose: () => selectRow(null) });
  el.scrollTop = 0;
}

function exportCsv() {
  const q = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const cols = S.cols.filter((c) => c !== 'cats');
  const head = cols.map((k) => { const u = k === 'drift' ? 'min' : unitOf(k, S.units); return meta(k).label + (u ? ` [${u}]` : ''); }).concat(['catalogues', 'estimated (field:relation)', 'catalogues disagree on', 'value sources (field:catalogue)']);
  const lines = [head.map(q).join(',')];
  for (const r of S.view) {
    const vals = cols.map((k) => { const x = k === 'mag' ? r.v.mag : value(r, k); return typeof x === 'number' ? (Number.isFinite(x) ? String(+x.toPrecision(10)) : '') : typeof x === 'boolean' ? (x ? 'yes' : 'no') : x ?? ''; });
    vals.push(r.cats.join('+'), cols.filter((k) => r.est[k]).map((k) => `${k}:${r.est[k].rel}`).join(';'), Object.keys(r.diff).join(';'), cols.filter((k) => r.src[k] && meta(k).kind === 'num').map((k) => `${k}:${r.src[k]}`).join(';'));
    lines.push(vals.map(q).join(','));
  }
  const dates = SOURCES.filter((s) => S.loaded[s.id] && !S.loaded[s.id].error).map((s) => `${s.label} snapshot ${S.loaded[s.id].meta.date}`).join('; ');
  lines.unshift(`# Exoplanet Science Lab search export, ${new Date().toISOString().slice(0, 10)}. ${dates}. Values marked estimated come from published relations, not from a catalogue.`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
  a.download = 'esl_search.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------------------------------------ wiring

const vt = createTable($('s-table'), {
  rowHeight: 27, cell, headCell, width: (k) => COLS[k][0],
  onSort: (key) => { S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: 1 }; save(); refresh(); },
  onSelect: (row) => selectRow(row === S.selected ? null : row),
});
window.__search = { S, vt };                                         // for the headless checks

function rebuild() {
  const t = buildTable(S.loaded, { prefer: S.prefer });
  for (const r of t.rows) {
    const f = Number.isFinite(r.v.vmag) ? 'vmag' : Number.isFinite(r.v.gmag) ? 'gmag' : Number.isFinite(r.v.tmag) ? 'tmag' : null;
    r.magField = f; r.magBand = f ? { vmag: 'V', gmag: 'G', tmag: 'T' }[f] : ''; if (f) r.v.mag = r.v[f];
    r.hay = [r.name, r.host, r.v.method, r.v.facility, r.v.status, r.v.sptype, ...r.cats.flatMap((c) => [r.recs[c].name, ...r.recs[c].aliases, ...r.recs[c].hostAliases])].join(' ').toLowerCase().replace(/[^a-z0-9.+ ]/g, '');
    r.hay += ' ' + r.hay.replace(/ /g, '');
  }
  S.table = t; S.rows = t.rows;
  const m = t.match && t.match.stats;
  $('s-lead').textContent = 'Known planets and candidates, with the catalogue and reference behind every number.' +
    (m ? ` ${m.matched.toLocaleString('en')} planets are in both the NASA archive and exoplanet.eu, ${m.onlyA} only in the archive, ${m.onlyB.toLocaleString('en')} only in exoplanet.eu.` : '');
  $('s-foot').innerHTML = SOURCES.filter((s) => S.loaded[s.id] && !S.loaded[s.id].error).map((s) => esc(s.acknowledgement)).join(' ') +
    (S.loaded.eu && S.loaded.eu.meta.licence ? ` exoplanet.eu: “${esc(S.loaded.eu.meta.licence)}”.` : '') + ' These are snapshots, not live queries; the dates are above.';
}

async function start() {
  drawSources(); drawColumns(); drawLegend();
  $('s-q').value = S.q; $('s-units').value = S.units; $('s-prefer').value = S.prefer;
  S.loaded = await loadSources(fetchJson);
  drawSources(); rebuild(); drawFilters(); refresh();
  // a remembered filter that hides rows must not be invisible: open the panel when any is active
  if ($('s-nfilters').textContent && $('s-filters').hidden) $('s-filters-btn').click();
  const want = new URLSearchParams(location.search).get('planet');
  if (want) { const k = want.toLowerCase().replace(/[^a-z0-9]/g, ''), r = S.rows.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === k); if (r) { selectRow(r); vt.scrollTo(r); } }
}

$('s-q').addEventListener('input', (e) => { S.q = e.target.value; refresh(); });
$('s-units').addEventListener('change', (e) => { S.units = e.target.value; S.ranges = {}; save(); drawFilters(); refresh(true); if (S.selected) selectRow(S.selected); });
$('s-prefer').addEventListener('change', (e) => { S.prefer = e.target.value; save(); const key = S.selected && S.selected.name; rebuild(); refresh(); selectRow(key ? S.rows.find((r) => r.name === key) || null : null); });
$('s-csv').addEventListener('click', exportCsv);
const toggle = (btn, panel) => $(btn).addEventListener('click', () => { const p = $(panel); p.hidden = !p.hidden; $(btn).setAttribute('aria-expanded', String(!p.hidden)); vt.resize(); });
toggle('s-filters-btn', 's-filters'); toggle('s-cols-btn', 's-cols');
$('s-sources').addEventListener('change', (e) => { const id = e.target.dataset.src; if (!id) return; S.sources[id] = e.target.checked; save(); drawSources(); refresh(); });
$('s-cols').addEventListener('change', (e) => {
  const k = e.target.dataset.col; if (!k) return;
  S.cols = Object.keys(COLS).filter((c) => (c === k ? e.target.checked : S.cols.includes(c)));
  // keep the default order for default columns, append the rest in registry order
  S.cols.sort((a, b) => { const i = DEFAULT_COLS.indexOf(a), j = DEFAULT_COLS.indexOf(b); return (i < 0 ? 100 + Object.keys(COLS).indexOf(a) : i) - (j < 0 ? 100 + Object.keys(COLS).indexOf(b) : j); });
  save(); refresh(true);
});
$('s-cols').addEventListener('click', (e) => { if (e.target.id === 's-cols-reset') { S.cols = DEFAULT_COLS.slice(); save(); drawColumns(); refresh(true); } });
$('s-filters').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.range) {
    const k = t.dataset.range, r = (S.ranges[k] || [null, null]).slice();
    r[+t.dataset.end] = t.value === '' ? null : +t.value;
    if (r[0] == null && r[1] == null) delete S.ranges[k]; else S.ranges[k] = r;
  } else if (t.dataset.status) { t.checked ? S.status.add(t.dataset.status) : S.status.delete(t.dataset.status); save(); }
  else if (t.id === 'f-method') S.method = t.value;
  else if (t.id === 'f-transit') S.transit = t.value;
  else if (t.id === 'f-cats') S.cats = t.value;
  else if (t.id === 'f-diff') S.diffOnly = t.checked;
  else if (t.id === 'f-est') S.estToo = t.checked;
  else return;
  save(); refresh();
});
$('s-filters').addEventListener('click', (e) => { if (e.target.id !== 'f-clear') return; S.ranges = {}; S.method = ''; S.transit = 'any'; S.cats = 'any'; S.diffOnly = false; S.estToo = true; save(); drawFilters(); refresh(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.selected) selectRow(null); });

start().catch((err) => { $('s-lead').textContent = 'Could not load the catalogues: ' + err.message; console.error(err); });
