// Small DOM and formatting helpers of the Validation page.
import { REFS, CODES, refLink, refLinks } from './refs.js';

export const $ = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bad = (x) => x === null || x === undefined || Number.isNaN(x);
/** 3.1e-11 as "3.1 × 10⁻¹¹" would be prettier, but e-notation is what the tests print and what people search for. */
export const e1 = (x) => (bad(x) ? 'n/a' : x === 0 ? '0' : Math.abs(x).toExponential(1));
export const se1 = (x) => (bad(x) ? 'n/a' : x === 0 ? '0' : (x < 0 ? '−' : '+') + Math.abs(x).toExponential(1));
export const fx = (x, d = 3) => (bad(x) || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
export const sig = (x, n = 5) => (bad(x) || !Number.isFinite(x) ? 'n/a' : Number(x.toPrecision(n)).toString());
export const int = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : 'n/a');
export const signed = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
/** A relative flux difference in parts per million, in words a reader can weigh: 3.1e-11 -> "0.00003 ppm". */
export const ppm = (x) => { const v = Math.abs(x) * 1e6; return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v >= 1e-6 ? String(Number(v.toPrecision(1))) : v.toExponential(0)) + ' ppm'; };
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
export const pill = (ok, text) => `<span class="pill ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${esc(text || (ok ? 'pass' : 'outside'))}</span>`;
export const heat = (v) => { if (bad(v)) return '<td class="na">·</td>'; const a = v <= 0 ? 0 : Math.max(0, Math.min(1, (Math.log10(v) + 11) / 7)) * 0.75; return `<td class="heat" style="background:rgba(57,135,229,${a.toFixed(3)})">${e1(v)}</td>`; };
export const L = (s) => `<td class="l">${s}</td>`, N = (s, cls = '') => `<td class="num ${cls}">${s}</td>`;

/**
 * Table from header labels and rows of cell HTML (a cell may be a full <td ...> string). `cls` 'stack' turns each row
 * into a labelled block on a phone (the labels are the headers); other tables scroll sideways inside their own box.
 */
export function table(head, rows, cls = '', caption = '') {
  const plain = (h) => h.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '');
  const td = (c, i) => { const s = typeof c === 'string' && c.startsWith('<td') ? c : `<td class="num">${c}</td>`; return s.replace('<td', `<td data-label="${esc(plain(head[i] || ''))}"`); };
  const w = $('div', 'vtwrap' + (cls.includes('stack') ? ' stackwrap' : '')); w.tabIndex = 0; w.setAttribute('role', 'region'); w.setAttribute('aria-label', caption || 'Table: ' + plain(head[0]));
  const first = rows.find((r) => !r.raw), cells0 = first ? first.cells || first : [], left = (i) => i === 0 || (typeof cells0[i] === 'string' && cells0[i].startsWith('<td class="l"'));
  w.innerHTML = `<table class="vt ${cls}">${caption ? `<caption>${caption}</caption>` : ''}<thead><tr>${head.map((h, i) => `<th scope="col"${left(i) ? ' class="l"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => (r.raw ? r.raw : `<tr${r.cls ? ` class="${r.cls}"` : ''}${r.attr || ''}>${(r.cells || r).map(td).join('')}</tr>`)).join('')}</tbody></table>`;
  return w;
}

/** A collapsed block. `fill(body)` runs on first opening, so heavy tables and charts cost nothing until asked for. */
export function details(parent, summary, fill, { open = false, id = '' } = {}) {
  const d = $('details', 'vd'), body = $('div', 'vdbody'); if (id) d.id = id; d.innerHTML = `<summary>${summary}</summary>`; d.append(body);
  let done = false; const go = () => { if (!done) { done = true; fill(body); } };
  d.addEventListener('toggle', () => { if (d.open) go(); }); if (open) { d.open = true; go(); }
  parent.append(d); return d;
}

/** The number to remember: value, unit, what it means, and whether it was computed in this browser or stored. */
export const keyNumber = (value, unit, means, live = true) => `<div class="vkey"><div class="vkv"><b>${value}</b> <span class="u">${unit}</span></div><p>${means}</p><span class="src ${live ? 'live' : 'stored'}" title="${live ? 'Computed in this browser when the page loaded' : 'From a stored run; see “Reproduce it”'}">${live ? 'recomputed now' : 'stored run'}</span></div>`;

/** Inline citation linking to the reference list; several keys give "A 2015; B 2016". */
export function cite(...keys) { return keys.map((k) => { if (!REFS[k]) throw new Error('unknown reference: ' + k); return `<a class="cite" href="#ref-${k}">${esc(REFS[k].short)}</a>`; }).join('; '); }
/** A code's name linked to its repository. */
export function code(k, label) { const c = CODES[k]; if (!c) throw new Error('unknown code: ' + k); return `<a class="ext" href="${c.repo}" rel="noopener">${esc(label || c.name)}</a>`; }
export const ext = (href, text) => `<a class="ext" href="${href}" rel="noopener">${text}</a>`;

/** One entry of the reference list. */
export function refEntry(k) {
  const r = REFS[k];
  return `<li id="ref-${k}"><span class="rauth">${esc(r.authors)}${r.year ? ' ' + r.year : ''}.</span> ${r.title ? `<a href="${refLink(k)}" rel="noopener">${esc(r.title)}</a>. ` : ''}<span class="rwhere">${esc(r.where)}.</span> ${refLinks(k).map(([t, u]) => `<a class="rid" href="${u}" rel="noopener">${esc(t)}</a>`).join(' · ')}${r.note ? ` <span class="rnote">${esc(r.note)}</span>` : ''}</li>`;
}
