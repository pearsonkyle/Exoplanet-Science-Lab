// Section 5 of the validation part of the Methods page (tab "Validation"): one card per entry of topics.js, rendered from its declarative description and the
// stored output of its tests (public/validation/project.json, or a JSON file of the topic's own with the same shape).
// Nothing here knows about a particular topic: to add a section, add an entry to topics.js (recipe in validation/README.md).

import { chart, rangesHeight } from './plot.js';
import { $, esc, pill, table, details, keyNumber, cite, code, L, vdata } from './ui.js';
import { vid } from './anchors.js';
import { TOPICS } from './topics.js';

/** The stored data of one topic: { date, tests: { file: { exit, checks } }, plot }. */
async function load(ctx, t) {
  const P = ctx.data.P;
  if (!t.json || t.json.startsWith('project.json')) return { date: P.date, node: P.node, tests: Object.fromEntries(t.tests.filter((f) => P.tests?.[f]).map((f) => [f, P.tests[f]])), plot: P.plots?.[t.id] };
  try { const r = await fetch(vdata(t.json)); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); return { date: j.date, node: j.node, tests: Array.isArray(j.tests) ? Object.fromEntries(j.tests.map((x) => [x.file, x])) : j.tests || {}, plot: j.plot }; }
  catch (err) { return { error: `${t.json}: ${err.message}`, tests: {} }; }
}

/** Does the stored output still contain what the topic quotes? Returns the check it was found in. */
export function findQuote(tests, t, row) {
  const f = row.test || t.tests[0], T = tests[f]; if (!T) return null;
  const c = T.checks.find((q) => q.name.includes(row.check)); if (!c) return null;
  return { c, ok: !row.quote || `${c.name}   ${c.info} ${(c.more || []).join(' ')}`.includes(row.quote) };
}

export async function projectBlock(ctx) {
  const host = document.querySelector(`#${vid('project')} .vbody`), done = TOPICS.filter((t) => t.status === 'done'), planned = TOPICS.filter((t) => t.status !== 'done');
  const grid = $('div', 'vtopics'); host.append(grid);
  for (const t of done) {
    const D = await load(ctx, t), art = $('article', 'vtopic'); art.id = vid(t.id); grid.append(art);
    const files = Object.entries(D.tests), nAll = files.reduce((a, [, x]) => a + x.checks.length, 0), nBad = files.reduce((a, [, x]) => a + x.checks.filter((c) => !c.ok).length, 0), exitBad = files.filter(([, x]) => x.exit !== 0).length;
    const stale = t.rows.filter((r) => { const q = findQuote(D.tests, t, r); return !q || !q.ok; });
    const ok = files.length === t.tests.length && !exitBad && !stale.length;
    ctx.check(t.id, t.title, ok, D.error ? D.error : files.length < t.tests.length ? 'no stored output: run node tools/validation/project_reference.mjs' : `${nAll - nBad} of ${nAll} printed checks passed${nBad ? ' (the rest are reported by the test itself as known limits)' : ''}; ${t.rows.length - stale.length} of ${t.rows.length} numbers quoted here found in the stored output of ${D.date}`, false);
    art.append($('h3', '', esc(t.title)));
    art.append($('p', 'vpurpose', t.purpose));
    art.insertAdjacentHTML('beforeend', keyNumber(t.headline.value, '', t.headline.label, false));
    details(art, `Details and all ${nAll} checks`, (b) => {
      if (t.plot && D.plot) chart(b, t.plot.type, D.plot, { title: t.plot.title, sub: t.plot.sub, label: t.plot.alt, height: t.plot.height || (t.plot.type === 'ranges' ? rangesHeight(D.plot.rows.length) : t.plot.type === 'intervals' ? 44 + D.plot.rows.reduce((a, r) => a + 15 * r.items.length + 8, 0) : 210) });
      if (t.caveat) b.append($('p', 'vcaveat', `<b>Limits.</b> ${t.caveat}`));
      b.append(table(['Check', 'Result'], t.rows.map((r) => { const q = findQuote(D.tests, t, r); return [L(r.what), L(`${r.result}${!q || !q.ok ? ` ${pill(false, 'not in the stored output')}` : ''}`)]; }), 'left stack'));
      b.append($('ul', 'vlist', [
        `Test: ${t.tests.map((f) => ctx.path(f)).join(', ')}. Rerun with <code>${esc(t.command || t.tests.map((f) => 'node ' + f).join(' && '))}</code>.`,
        t.generators?.length ? `Reference generators: ${t.generators.map((f) => ctx.path(f)).join(', ')}.` : '',
        t.stored?.length ? `Stored references in the repository: ${t.stored.map((f) => `<code>${esc(f)}</code>`).join(', ')}.` : '',
        t.against?.length ? `Compared with: ${t.against.map((k) => code(k)).join(', ')} (versions: <a href="#codes">the table of codes</a> and each stored reference).` : '',
        t.refs?.length ? `Cite: ${cite(...t.refs)}.` : '',
        `Output stored ${esc(D.date || 'n/a')} (Node ${esc(D.node || '')}) by ${ctx.path('tools/validation/project_reference.mjs')}; nothing in this card is recomputed in your browser.`,
      ].filter(Boolean).map((x) => `<li>${x}</li>`).join('')));
      for (const [f, x] of files) {
        const fails = x.checks.filter((c) => !c.ok).length;
        details(b, `<code>${esc(f)}</code>: ${x.checks.length ? `${x.checks.length} checks${fails ? `, ${fails} not passed` : ', all passed'}` : `exit code ${x.exit}`} (${x.seconds} s)`, (bb) => {
          if (x.checks.length) bb.append(table(['Check, as printed', 'Result', 'Numbers, as printed'], x.checks.map((c) => [L(esc(c.name)), `<td>${pill(c.ok)}</td>`, L(esc(c.info) + (c.more?.length ? `<br><span class="vnote">${c.more.map(esc).join('<br>')}</span>` : ''))]), 'left stack'));
          else bb.append($('pre', 'vcmd', esc((x.tail || []).join('\n') || 'The test prints no per-check lines; it passed (exit code 0).')));
        });
      }
    });
  }
  if (planned.length) {
    const box = $('div', 'vplanned'); box.id = 'val-planned'; host.append(box);
    box.innerHTML = `<h3>Being added</h3><p>Not yet validated; each gets a card once its test exists.</p><ul class="vlist">${planned.map((t) => `<li id="${vid(t.id)}"><b>${esc(t.title)}.</b> ${esc(t.purpose)}</li>`).join('')}</ul>`;
  }
}
