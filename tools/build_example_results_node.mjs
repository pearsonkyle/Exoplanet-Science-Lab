// Stored results for worked examples whose session uses blocks the analyzer page does not carry yet ("physical",
// "rm", the period alias "nalias"): the example's session file (src/ui/examples.js sessionFile + adjust) is run with
// runSession, the same sampler and likelihood as the page, and written to public/examples/results/<id>.json with its
// posterior draws. The other examples are stored from the page by tools/build_example_results.py.
//   node tools/build_example_results_node.mjs <id> [<id> ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { runSession } from '../src/core/session.js';
import { EXAMPLES } from '../src/ui/examples.js';

const P = (p) => new URL('../' + p, import.meta.url);
for (const id of process.argv.slice(2)) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex || !ex.sessionFile) throw new Error(`${id}: not an example with a session file`);
  let doc = JSON.parse(readFileSync(P('public/' + ex.sessionFile), 'utf8'));
  if (ex.adjust) doc = ex.adjust(doc);
  doc.title = ex.title; doc.created = new Date().toISOString(); doc.result = null;
  const t0 = Date.now(); let last = 0;
  const out = await runSession(doc, { keepSamples: true, maxSamples: 1500, onProgress: (p) => { if (Date.now() - last > 60000) { last = Date.now(); console.log(`  ${id}: ${p.ncalls} calls, ln Z ${p.logZ.toFixed(1)}`); } } });
  const r = out.session.result;
  writeFileSync(P(`public/examples/results/${id}.json`), JSON.stringify(out.session));
  console.log(`${id}: ${r.parameters.length} free, ${r.ncalls} calls, converged ${r.converged}, lnZ ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}` +
    (r.prior_volume ? `, prior volume ${r.prior_volume.V.toFixed(4)} (ln Z renormalised ${r.prior_volume.logZ_renormalised.toFixed(2)})` : '') + `, ${((Date.now() - t0) / 1000).toFixed(0)} s` + (r.warnings.length ? `  warnings: ${JSON.stringify(r.warnings)}` : ''));
}
