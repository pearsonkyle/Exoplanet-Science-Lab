// The Methods page: methods, validation and references in five tabs (src/methods/tabs.js). This module renders
// src/methods/content.js (the same source as docs/METHODS.md) into the Methods, Reproducibility, References and How to
// cite tabs; the Validation tab is filled by src/validation/main.js. It adds the one interactive part of the methods,
// the "How to cite and report" tool, which runs methodsParagraph() of src/core/methodsText.js on a stored
// example or on a session file the visitor chooses. Nothing is uploaded.
import * as CONTENT from './content.js';
import { RESULTS } from './results.generated.js';
import { buildHtml } from './render.js';
import { TOPICS } from '../validation/topics.js';
import { REFS } from '../validation/refs.js';
import { methodsParagraph } from '../core/methodsText.js';
import { siteRoot } from '../site/nav.js';
import { initTabs } from './tabs.js';

const $ = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

function citeTool(host) {
  const root = siteRoot(), ids = Object.keys(RESULTS.examples);
  const row = $('div', 'vrow'), sel = $('select'), file = $('input'), status = $('span', 'vnote');
  sel.id = 'citeExample'; sel.setAttribute('aria-label', 'Stored example');
  for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = (CONTENT.EXAMPLES.find((e) => e.id === id) || { title: id }).title; sel.append(o); }
  file.type = 'file'; file.accept = '.json,application/json'; file.id = 'citeFile'; file.setAttribute('aria-label', 'Your own session file');
  const lab1 = $('label', '', 'Stored example '), lab2 = $('label', '', 'or your session file ');
  lab1.htmlFor = sel.id; lab2.htmlFor = file.id; status.setAttribute('role', 'status');
  row.append(lab1, sel, lab2, file); host.append(row, status);
  const box = (title, id) => { const w = $('div', 'mout'), head = $('div', 'mouthead', `<b>${title}</b>`), ta = $('textarea'), b = $('button', 'btn', 'Copy'); b.type = 'button'; ta.id = id; ta.readOnly = true; ta.spellcheck = false; ta.setAttribute('aria-label', title);
    b.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copied'; } catch { ta.select(); b.textContent = 'Select and copy'; } setTimeout(() => (b.textContent = 'Copy'), 1500); };
    head.append(b); w.append(head, ta); host.append(w); return ta; };
  const text = box('Methods paragraph (a draft to adapt)', 'citeText'), notesHead = $('p', 'mnotes-h', '<b>To state or check by hand</b>'), notes = $('ul', 'vlist mnotes');
  host.append(notesHead, notes);
  const bib = box('BibTeX of the references this session needs', 'citeBib');
  const show = (session, label) => {
    try {
      const r = methodsParagraph(session);
      text.value = r.text; bib.value = r.bibtex; notes.innerHTML = r.notes.map((n) => `<li>${n.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</li>`).join('');
      text.rows = Math.min(24, Math.max(8, Math.ceil(r.text.length / 95))); bib.rows = 14;
      status.textContent = `${label}: ${r.text.split(/\s+/).length} words, ${r.keys.length} references (${r.keys.join(', ')}).`;
      host.dataset.ready = '1';
    } catch (err) { status.textContent = `${label}: ${err.message}`; text.value = ''; bib.value = ''; notes.innerHTML = ''; }
  };
  const load = async (id) => {
    status.textContent = 'Loading the stored session…';
    try { const r = await fetch(new URL(`examples/results/${id}.json`, root)); if (!r.ok) throw new Error('HTTP ' + r.status); show(await r.json(), `${id}.json`); }
    catch (err) { status.textContent = `Could not load ${id}.json (${err.message}).`; }
  };
  sel.onchange = () => { file.value = ''; load(sel.value); };
  file.onchange = async () => { const f = file.files[0]; if (!f) return; try { show(JSON.parse(await f.text()), f.name); } catch (err) { status.textContent = `${f.name}: not a JSON session (${err.message}).`; } };
  sel.value = ids.includes('hd80606-joint') ? 'hd80606-joint' : ids[0]; load(sel.value);
}

function main() {
  document.getElementById('lead').textContent = CONTENT.LEAD;
  const { toc, parts } = buildHtml({ ...CONTENT, TOPICS, REFS, RESULTS }, document.querySelector('meta[name=esl-root]').content);
  document.getElementById('msections').innerHTML = parts.methods;
  document.getElementById('reproHost').innerHTML = parts.reproducibility;
  document.getElementById('refsHost').innerHTML = parts.references;
  document.getElementById('citeHost').innerHTML = parts.cite;
  document.querySelector('#mtoc ol').innerHTML = toc.map((t) => `<li><a href="#${t.id}">${t.title}</a></li>`).join('');
  citeTool(document.getElementById('citeTool'));
  // MathML is rendered natively; where it is not, show the LaTeX source instead of unstyled glyph soup
  if (!(window.MathMLElement && document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math') instanceof window.MathMLElement)) {
    document.documentElement.classList.add('no-mathml');
    for (const m of document.querySelectorAll('math')) { const a = m.querySelector('annotation'), c = $('code', 'mtex'); c.textContent = a ? a.textContent : m.textContent; m.replaceWith(c); }
  }
  initTabs();   // shows the tab of the address's anchor (Methods when there is none) and follows later changes
  document.documentElement.dataset.methods = 'ready';
  window.__methods = { sections: toc.length, equations: document.querySelectorAll('.meq').length, refs: document.querySelectorAll('.vrefs li').length };
}
main();
