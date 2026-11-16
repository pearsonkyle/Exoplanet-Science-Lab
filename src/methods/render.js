// Renders src/methods/content.js as HTML (the Methods page) and as Markdown (docs/METHODS.md). Pure functions of
// their arguments, no DOM: the page sets the returned strings as innerHTML, tools/build_methods_md.mjs writes them.
//
// Everything that carries a number of this code is looked up, not typed here:
//   - a check { topic, rows } prints rows of src/validation/topics.js (tied to the stored test output by
//     test/validation.test.mjs);
//   - the reproducibility table prints values from RESULTS, the extract of public/examples/results/*.json that
//     tools/build_methods_md.mjs writes to src/methods/results.generated.js.

import { texToMathML } from './tex.js';
import { formatValue } from '../core/exportScript.js';
import { vid } from '../validation/anchors.js';

const SITE = 'https://exoplanet.science/';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Split a text into [isMath, piece] runs on $...$. */
const mathRuns = (text) => String(text).split(/(\$[^$]+\$)/).filter((x) => x !== '').map((x) => (x.startsWith('$') && x.endsWith('$') && x.length > 2 ? [true, x.slice(1, -1)] : [false, x]));
const CITE = /\[((?:@[A-Za-z0-9]+)(?:;\s*@[A-Za-z0-9]+)*)\]/g, LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const citeKeys = (m) => m.split(';').map((k) => k.trim().slice(1));

/** Inline markup -> HTML. ctx: { REFS, root } where root is the site root relative to the page ("../"). */
export function inlineHtml(text, ctx) {
  return mathRuns(text).map(([math, x]) => {
    if (math) return texToMathML(x);
    let h = esc(x);
    h = h.replace(/\{\{([^}]+)\}\}/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(CITE, (_, m) => citeKeys(m).map((k) => { if (!ctx.REFS[k]) throw new Error('unknown reference: ' + k); return `<a class="cite" href="#ref-${k}">${esc(ctx.REFS[k].short)}</a>`; }).join('; '));
    h = h.replace(LINK, (_, t, u) => `<a href="${u.startsWith('v:') ? `#${vid(u.slice(2))}` : u}">${t}</a>`);   // the validation part is on the same page
    return h;
  }).join('');
}
/** Inline markup -> GitHub-flavoured Markdown (maths stays as $...$). */
export function inlineMd(text, ctx, { cell = false } = {}) {
  const out = mathRuns(text).map(([math, x]) => {
    if (math) { texToMathML(x); return '$' + x + '$'; }           // parsed only to fail on a typo
    let h = x.replace(/\{\{([^}]+)\}\}/g, '`$1`');
    h = h.replace(CITE, (_, m) => citeKeys(m).map((k) => { if (!ctx.REFS[k]) throw new Error('unknown reference: ' + k); return `[${ctx.REFS[k].short}](#ref-${k})`; }).join('; '));
    h = h.replace(LINK, (_, t, u) => `[${t}](${u.startsWith('v:') ? `${SITE}methods/#${vid(u.slice(2))}` : u})`);
    return h;
  }).join('');
  return cell ? out.replace(/\|/g, '\\|') : out;
}

/** The check lines of a section: [{ text (inline markup), test }]. Throws when a topic or row does not exist. */
export function checkLines(sec, TOPICS) {
  const out = [];
  for (const c of sec.checks || []) {
    if (typeof c === 'string') { out.push({ text: c }); continue; }
    const t = TOPICS.find((x) => x.id === c.topic); if (!t) throw new Error(`${sec.id}: unknown validation topic ${c.topic}`);
    for (const i of c.rows) { const row = t.rows[i]; if (!row) throw new Error(`${sec.id}: topic ${c.topic} has no row ${i}`); out.push({ text: `${row.what}: ${row.result}.`, topic: t, test: row.test || t.tests[0] }); }
  }
  return out;
}

// ---- reproducibility ---------------------------------------------------------------------------------------------

/** "111.436864 +0.000061 −0.000065" for a stored { median, plus, minus }. */
export function valueText(v) {
  if (!v || !Number.isFinite(v.median)) return 'n/a';
  const f = formatValue(v.median, v.plus, v.minus);
  if (!f.plus && !f.minus) return f.value;
  return f.plus === f.minus ? `${f.value} ± ${f.plus}` : `${f.value} +${f.plus} −${f.minus}`;
}
/** Rows of one example's comparison: [{ what, mine, published, source, bad }]. */
export function compareRows(ex, RESULTS, TOPICS) {
  const R = ex.id ? RESULTS.examples[ex.id] : null;
  if (ex.id && !R) throw new Error(`no stored result for example ${ex.id}: run node tools/build_methods_md.mjs`);
  return ex.compare.map((c) => {
    if (c.topic) { const t = TOPICS.find((x) => x.id === c.topic), row = t && t.rows[c.row]; if (!row) throw new Error(`example ${ex.title}: no row ${c.row} in topic ${c.topic}`); return { what: row.what, mine: row.result, published: '', source: `${row.test || t.tests[0]} (Validation: ${t.title})`, anchor: t.id }; }
    if (c.fixed) return { what: c.what, mine: c.fixed, published: c.published, source: c.source, bad: c.bad };
    const key = c.get.join('.'), v = R.values[key]; if (!v) throw new Error(`example ${ex.id}: ${key} is not in the stored result`);
    return { what: c.what, mine: valueText(v) + (c.get[0] === 'calc' ? ' (from the medians)' : ''), published: c.published, source: c.source, bad: c.bad };
  });
}
const runLine = (R) => (R ? `${R.free} free, ${R.ncalls.toLocaleString('en-US')} likelihood calls, ln Z = ${R.logZ.toFixed(2)} ± ${R.logZerr.toFixed(2)}, ${R.converged ? 'converged' : 'NOT converged'}${R.warnings ? `, ${R.warnings} sampler warning${R.warnings > 1 ? 's' : ''}` : ''}; stored ${String(R.created).slice(0, 10)} with version ${R.version}` : '');

// ---- HTML --------------------------------------------------------------------------------------------------------

const refEntryHtml = (k, r) => { const link = r.doi ? 'https://doi.org/' + r.doi : r.arxiv ? 'https://arxiv.org/abs/' + r.arxiv : r.url, ids = []; if (r.doi) ids.push([`doi:${r.doi}`, 'https://doi.org/' + r.doi]); if (r.arxiv) ids.push([`arXiv:${r.arxiv}`, 'https://arxiv.org/abs/' + r.arxiv]); if (r.url) ids.push([r.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), r.url]);
  return `<li id="ref-${k}"><span class="rauth">${esc(r.authors)}${r.year ? ' ' + r.year : ''}.</span> ${r.title ? `<a href="${link}" rel="noopener">${esc(r.title)}</a>. ` : ''}<span class="rwhere">${esc(r.where)}.</span> ${ids.map(([t, u]) => `<a class="rid" href="${u}" rel="noopener">${esc(t)}</a>`).join(' · ')}${r.note ? ` <span class="rnote">${esc(r.note)}</span>` : ''} <code class="rkey">${k}</code></li>`; };
// a value with its errors ("94.452697 +0.000096 −0.000098") stays on one line; other text wraps as before
const numNw = (v) => /^[−-]?[\d.]+(?:e[−-]?\d+)?(?: [+−±] ?[\d.]+(?:e[−-]?\d+)?)+(?: \S+)?$/.test(String(v)) ? `<span class="nw">${esc(v)}</span>` : esc(v);
const tableHtml = (head, rows, cls = 'left stack') => `<div class="vtwrap${cls.includes('stack') ? ' stackwrap' : ''}" tabindex="0" role="region" aria-label="Table: ${esc(head[0])}"><table class="vt ${cls}"><thead><tr>${head.map((h) => `<th scope="col" class="l">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="l" data-label="${esc(head[i])}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

/**
 * The page body, one part per tab of the Methods page. D = { SECTIONS, INTRO, EXAMPLES, LIVE, DATA_TERMS, TOPICS, REFS,
 * RESULTS }, root = "../". Returns { toc: [{ id, title, n }] (the Methods tab), parts: { methods, reproducibility, cite,
 * references } (HTML of each tab's generated part), html (all of them) }. The Validation tab is the static skeleton of
 * methods/index.html, filled by src/validation/main.js; its anchors are those of src/validation/anchors.js.
 *
 * Nothing is quoted twice on the page: a check of a section that is a row of a validation topic links to that topic's
 * card (which shows the number), and the topic and live-comparison tables of the Markdown copy are the Validation tab here.
 */
export function buildHtml(D, root = '../') {
  const ctx = { REFS: D.REFS, root }, I = (t) => inlineHtml(t, ctx), toc = [], methods = [];
  const block = (b) => {
    if (typeof b === 'string') return `<p>${I(b)}</p>`;
    if (b.eq) return `<div class="meq" role="math">${texToMathML(b.eq, { display: true })}</div>`;
    if (b.ul) return `<ul class="vlist">${b.ul.map((x) => `<li>${I(x)}</li>`).join('')}</ul>`;
    if (b.h) return `<h3>${I(b.h)}</h3>`;
    if (b.table) return tableHtml(b.table.head.map(I), b.table.rows.map((r) => r.map(I)), 'left');
    throw new Error('unknown block');
  };
  let n = 0;
  const open = (id, title) => { n++; toc.push({ id, title, n }); return `<section id="${id}"><h2><span class="n">${n}</span>${I(title)}</h2>`; };
  const plain = (id, title) => `<section id="${id}"><h2>${I(title)}</h2>`;
  methods.push(`<div class="mintro">${D.INTRO.map((t) => `<p>${I(t)}</p>`).join('')}</div>`);
  for (const s of D.SECTIONS) {
    let h = open(s.id, s.title);
    if (s.code && s.code.length) h += `<p class="mcode">Code: ${s.code.map((c) => `<code>${esc(c)}</code>`).join(', ')}</p>`;
    if (s.stub) h += `<p class="mstub">${esc(s.stub)}</p>`;
    h += s.body.map(block).join('');
    checkLines(s, D.TOPICS);   // throws on a topic or row that does not exist
    const items = (s.checks || []).map((c) => {
      if (typeof c === 'string') return `<li>${I(c)}</li>`;
      const t = D.TOPICS.find((x) => x.id === c.topic), rows = c.rows.map((i) => t.rows[i]), tests = [...new Set(rows.map((r) => r.test || t.tests[0]))];
      return `<li class="mvlink"><a href="#${vid(t.id)}">Validation › ${esc(t.title)}</a>: ${rows.map((r) => esc(r.what)).join('; ')}. <span class="msrc">${tests.map((x) => `<code>${esc(x)}</code>`).join(', ')}</span></li>`;
    });
    if (items.length) h += `<h3>Accuracy and checks</h3><ul class="vlist mchecks">${items.join('')}</ul>`;
    if (s.limits && s.limits.length) h += `<h3>Assumptions and limits</h3><ul class="vlist mlimits">${s.limits.map((x) => `<li>${I(x)}</li>`).join('')}</ul>`;
    if (s.refs && s.refs.length) h += `<p class="mrefs">References: ${s.refs.map((k) => I(`[@${k}]`)).join('; ')}.</p>`;
    methods.push(h + '</section>');
  }

  // ---- reproducibility (the validation's own "how to rerun it" follows it in the same tab: methods/index.html)
  let h = plain('reproducibility', 'Reproducibility');
  h += `<p>For each bundled example: where the data come from and under what terms, what was reproduced, and the command that regenerates it. Values of this code are read from the stored result of each example (<code>public/examples/results/</code>, extracted ${esc(D.RESULTS.extracted)}). <b>Rows marked “not reproduced” are results this code does not match.</b> Published values are quoted as this repository records them; where it holds no uncertainty for a published value, none is shown. What each validation topic reproduced, and the command that reruns it, is in the <a href="#val-project">Validation tab</a> (open a topic’s details); how to rerun the comparisons with other codes is <a href="#val-reproduce">below</a>.</p>`;
  h += '<h3>Bundled examples</h3>';
  for (const ex of D.EXAMPLES) {
    const rows = compareRows(ex, D.RESULTS, D.TOPICS), R = ex.id ? D.RESULTS.examples[ex.id] : null;
    h += `<article class="mex${rows.some((r) => r.bad) ? ' bad' : ''}"><h4>${esc(ex.title)}${ex.id ? ` <code>${ex.id}.json</code>` : ''}</h4><dl><dt>Data</dt><dd>${esc(ex.data)}</dd><dt>Terms</dt><dd>${esc(ex.licence)}</dd>${ex.cite.length ? `<dt>Cite</dt><dd>${ex.cite.map((k) => I(`[@${k}]`)).join('; ')}</dd>` : ''}${R ? `<dt>Stored run</dt><dd>${esc(runLine(R))}</dd>` : ''}<dt>Outcome</dt><dd class="${/NOT/.test(ex.verdict) ? 'warn' : ''}">${esc(ex.verdict)}</dd><dt>Regenerate</dt><dd><code>${esc(ex.command)}</code></dd></dl>`;
    h += tableHtml(['Quantity', 'This code', 'Published or reference', 'Source of the comparison value'], rows.map((r) => [esc(r.what), numNw(r.mine) + (r.bad ? ' <span class="pill bad">not reproduced</span>' : ''), numNw(r.published), r.anchor ? `<a href="#${vid(r.anchor)}">${esc(r.source)}</a>` : esc(r.source)])) + '</article>';
  }
  h += '<h3>Third-party data in the site and their terms</h3><p>As far as the files in this repository state them. The project itself has no licence file yet.</p>';
  h += tableHtml(['Data', 'Where', 'Terms as stated in the repository', 'Cite'], D.DATA_TERMS.map((r) => [esc(r[0]), `<code>${esc(r[1])}</code>`, esc(r[2]), r[3].map((k) => I(`[@${k}]`)).join('; ')]));
  const reproducibility = h + '</section>';

  // ---- how to cite (the interactive part is added by the page)
  h = plain('cite', 'How to cite and report');
  h += `<p>A result from this software can be reported like any other fit, provided the paper states: the software and its version; the model components and the limb-darkening law with the source of its coefficients; every free parameter with its prior, and what was held fixed (in particular $a/R_\\star$ and the stellar mass and radius); the sampler settings and the outcome (convergence, likelihood calls, effective samples, $\\ln Z$ with its uncertainty, any sampler warning); the time standard of the data; and where the session file with the posterior draws is archived.</p>`.replace(/\$([^$]+)\$/g, (_, x) => texToMathML(x));
  h += '<p>The function <code>methodsParagraph(session)</code> in <code>src/core/methodsText.js</code> writes a draft of that paragraph from a session file, with the BibTeX of exactly the references its model components need. Choose a stored example or load your own exported session; nothing leaves your browser.</p>';
  h += '<div id="citeTool"></div>';
  h += '<h3>Citing the software</h3><p>Cite the software with its version (<code>CITATION.cff</code> at the repository root; BibTeX key <code>esl</code>), and the papers of the methods you used: each section of the Methods tab ends with its references, the <a href="#references">References</a> tab lists them all, and <code>docs/references.bib</code> holds them as BibTeX. If the catalogue supplied your starting values, cite the original publications named by the provenance labels and the archive’s own acknowledgement.</p>';
  const cite = h + '</section>';

  // ---- references: one list for the methods and the validation
  h = plain('references', 'References');
  const keys = Object.keys(D.REFS).sort((a, b) => D.REFS[a].authors.localeCompare(D.REFS[b].authors) || D.REFS[a].year - D.REFS[b].year);
  h += `<p>${keys.length} entries: every work cited by the methods and by the validation (<code>src/validation/refs.js</code>). Each was checked against the Crossref record of its DOI, arXiv, or the Astrophysics Source Code Library on 15 November 2026; entries that could not be checked in full say so. The key at the end of each entry is its BibTeX key in <code>docs/references.bib</code>.</p><ol class="vrefs">${keys.map((k) => refEntryHtml(k, D.REFS[k])).join('')}</ol>`;
  const references = h + '</section>';
  const parts = { methods: methods.join('\n'), reproducibility, cite, references };
  return { toc, parts, html: Object.values(parts).join('\n') };
}

// ---- Markdown ----------------------------------------------------------------------------------------------------

const mdTable = (head, rows) => `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map((c) => String(c).replace(/\n/g, ' ')).join(' | ')} |`).join('\n')}`;

/** docs/METHODS.md. D as in buildHtml, plus D.TITLE, D.LEAD and D.sample = { name, text, bibtex } for the example paragraph. */
export function buildMarkdown(D) {
  const ctx = { REFS: D.REFS }, I = (t) => inlineMd(t, ctx), C = (t) => inlineMd(t, ctx, { cell: true }), cell = (t) => String(t).replace(/\|/g, '\\|'), out = [];
  out.push(`# ${D.TITLE}`, '', `<!-- Generated by tools/build_methods_md.mjs from src/methods/content.js. Do not edit: change the source and rebuild. -->`, '', D.LEAD, '', `This is the Markdown copy of the site's Methods page (\`methods/\`, ${SITE}methods/). Equations are written in LaTeX between dollar signs.`, '');
  out.push(...D.INTRO.flatMap((t) => [I(t), '']));
  const all = [...D.SECTIONS.map((s) => [s.id, s.title]), ['validation', 'Validation'], ['reproducibility', 'Reproducibility table'], ['cite', 'How to cite and report'], ['references', 'References']];
  out.push('## Contents', '', ...all.map(([id, t], i) => `${i + 1}. [${t}](#${id})`), '');
  let n = 0;
  const head = (id, title) => { n++; out.push(`<a id="${id}"></a>`, '', `## ${n}. ${title}`, ''); };
  for (const s of D.SECTIONS) {
    head(s.id, s.title);
    if (s.code && s.code.length) out.push(`Code: ${s.code.map((c) => '`' + c + '`').join(', ')}`, '');
    if (s.stub) out.push(`> ${s.stub}`, '');
    for (const b of s.body) {
      if (typeof b === 'string') out.push(I(b), '');
      else if (b.eq) { texToMathML(b.eq); out.push('$$', b.eq, '$$', ''); }
      else if (b.ul) out.push(...b.ul.map((x) => '- ' + I(x)), '');
      else if (b.h) out.push(`### ${I(b.h)}`, '');
      else if (b.table) out.push(mdTable(b.table.head.map(C), b.table.rows.map((r) => r.map(C))), '');
    }
    const ch = checkLines(s, D.TOPICS);
    if (ch.length) out.push('### Accuracy and checks', '', ...ch.map((c) => `- ${I(c.text)}${c.topic ? ` ([Validation: ${c.topic.title}](${SITE}methods/#${vid(c.topic.id)}); \`${c.test}\`)` : ''}`), '');
    if (s.limits && s.limits.length) out.push('### Assumptions and limits', '', ...s.limits.map((x) => '- ' + I(x)), '');
    if (s.refs && s.refs.length) out.push(`References: ${s.refs.map((k) => I(`[@${k}]`)).join('; ')}.`, '');
  }

  // the summary of the Validation tab: what the page recomputes, and the checks elsewhere in the project
  head('validation', 'Validation');
  out.push(`How the models compare with other codes, with independent references and with published results. On the site this is the Validation tab of the Methods page (${SITE}methods/#validation), which recomputes this code's side of the first table in the browser, draws the comparisons and lists where this code is weaker; below are the numbers as the tests print them.`, '');
  out.push('### Comparisons with other codes', '', `Numbers as printed by \`${D.LIVE.command}\` on ${D.LIVE.date}; the page recomputes this code's side in the browser.`, '', mdTable(['Comparison', 'Reference data', 'Result'], D.LIVE.rows.map((r) => [`[${r.title}](${SITE}methods/#${vid(r.id)})`, cell(r.source), cell(r.result).replace('NOT reproduced', '**NOT REPRODUCED**')])), '');
  out.push('### Checks elsewhere in the project', '', 'Each line is printed by the test named and stored in `public/validation/project.json`; `node test/validation.test.mjs` fails when a number quoted here is no longer in that output.', '');
  out.push(mdTable(['Topic', 'Reference data and codes', 'What was reproduced', 'Regenerate'], D.TOPICS.filter((t) => t.status === 'done').map((t) => [
    `[${cell(t.title)}](${SITE}methods/#${vid(t.id)})`,
    cell(`${t.against && t.against.length ? `Against ${t.against.join(', ')}. ` : ''}${t.stored && t.stored.length ? `Stored references: ${t.stored.map((f) => '`' + f + '`').join(', ')}` : 'Analytic or computed in the test'}${t.generators && t.generators.length ? `; generated by ${t.generators.map((f) => '`' + f + '`').join(', ')}` : ''}.`),
    cell(t.rows.map((r) => `${r.what}: ${r.result}${r.failing ? ' (NOT PASSED)' : ''}`).join('<br>') + (t.caveat ? `<br>*${t.caveat}*` : '')),
    cell('`' + (t.command || t.tests.map((f) => 'node ' + f).join(' && ')) + '`<br>`node tools/validation/project_reference.mjs ' + t.id + '`'),
  ])), '');

  head('reproducibility', 'Reproducibility table');
  out.push(`For each bundled example: where the data come from and under what terms, what was reproduced, and the command that regenerates it. Values of this code are read from the stored result of each example (\`public/examples/results/\`, extracted ${D.RESULTS.extracted}). **Rows marked "NOT REPRODUCED" are results this code does not match.** Published values are quoted as this repository records them; where it holds no uncertainty for a published value, none is shown. The validation topics, with the command that reruns each, are in the [Validation](#validation) section.`, '', '### Bundled examples', '');
  for (const ex of D.EXAMPLES) {
    const rows = compareRows(ex, D.RESULTS, D.TOPICS), R = ex.id ? D.RESULTS.examples[ex.id] : null;
    out.push(`#### ${ex.title}${ex.id ? ` (\`${ex.id}.json\`)` : ''}`, '', `- Data: ${ex.data}`, `- Terms: ${ex.licence}`);
    if (ex.cite.length) out.push(`- Cite: ${ex.cite.map((k) => I(`[@${k}]`)).join('; ')}`);
    if (R) out.push(`- Stored run: ${runLine(R)}`);
    out.push(`- Outcome: ${ex.verdict}`, `- Regenerate: \`${ex.command}\``, '');
    out.push(mdTable(['Quantity', 'This code', 'Published or reference', 'Source of the comparison value'], rows.map((r) => [cell(r.what), cell(r.mine) + (r.bad ? ' **NOT REPRODUCED**' : ''), cell(r.published), cell(r.source)])), '');
  }
  out.push('### Third-party data in the site and their terms', '', 'As far as the files in this repository state them. The project itself has no licence file yet.', '', mdTable(['Data', 'Where', 'Terms as stated in the repository', 'Cite'], D.DATA_TERMS.map((r) => [cell(r[0]), '`' + r[1] + '`', cell(r[2]), r[3].map((k) => I(`[@${k}]`)).join('; ')])), '');

  head('cite', 'How to cite and report');
  out.push(I(String.raw`A result from this software can be reported like any other fit, provided the paper states: the software and its version; the model components and the limb-darkening law with the source of its coefficients; every free parameter with its prior, and what was held fixed (in particular $a/R_\star$ and the stellar mass and radius); the sampler settings and the outcome (convergence, likelihood calls, effective samples, $\ln Z$ with its uncertainty, any sampler warning); the time standard of the data; and where the session file with the posterior draws is archived.`), '');
  out.push('The function `methodsParagraph(session)` in `src/core/methodsText.js` writes a draft of that paragraph from a session file, with the BibTeX of exactly the references its model components need:', '', '```js', "import { methodsParagraph } from './src/core/methodsText.js';", "const { text, bibtex, keys, notes } = methodsParagraph(session, { ldSource, sliceUsed });", '```', '');
  if (D.sample) out.push(`Its output for the stored example \`${D.sample.name}\` (a draft to adapt; citation keys in square brackets match the BibTeX below):`, '', ...D.sample.text.split('\n').map((l) => '> ' + l), '', 'To state or check by hand:', '', ...D.sample.notes.map((x) => '- ' + x.replace(/\|/g, '/')), '', '```bibtex', D.sample.bibtex.trim(), '```', '');
  out.push('### Citing the software', '', 'Cite the software with its version (`CITATION.cff` at the repository root; BibTeX key `esl`), and the papers of the methods you used: the reference list below gives them, and `docs/references.bib` holds all of them. If the catalogue supplied your starting values, cite the original publications named by the provenance labels and the archive\'s own acknowledgement.', '');

  head('references', 'References');
  const keys = Object.keys(D.REFS).sort((a, b) => D.REFS[a].authors.localeCompare(D.REFS[b].authors) || D.REFS[a].year - D.REFS[b].year);
  out.push(`${keys.length} entries: every work cited by the methods and by the validation (\`src/validation/refs.js\`). Each was checked against the Crossref record of its DOI, arXiv, or the Astrophysics Source Code Library on 15 November 2026; entries that could not be checked in full say so. The key in brackets is the BibTeX key in \`docs/references.bib\`.`, '');
  for (const k of keys) { const r = D.REFS[k], link = r.doi ? `https://doi.org/${r.doi}` : r.arxiv ? `https://arxiv.org/abs/${r.arxiv}` : r.url; out.push(`- <a id="ref-${k}"></a>${r.authors}${r.year ? ' ' + r.year : ''}. ${r.title ? `[${r.title}](${link}). ` : ''}${r.where}.${r.doi ? ` doi:${r.doi}` : ''}${r.arxiv ? ` arXiv:${r.arxiv}` : ''}${!r.title || (!r.doi && !r.arxiv) ? ` ${link}` : ''}${r.note ? ` *${r.note}*` : ''} [\`${k}\`]`); }
  out.push('');
  return out.join('\n');
}
