// Every worked example driven end to end through the assistant's harness and a real model, without a browser
// (the same tools on a session document as the MCP server). Not part of `npm test`.
//   ESL_LLM=<base URL> node test/assistant_examples.mjs [id ...]        (ESL_LLM_MODEL, ESL_LLM_KEY, ESL_STEPS optional)
// For each example: a fresh conversation asks to open it from its data (no stored result), fit it and explain the
// result. Prints, per example, whether each of those happened, the number check, steps and seconds, and writes
// the conversations as training records (src/assistant/sft.js) to ESL_OUT (default /tmp/esl-examples.jsonl).
// The address comes from the environment only and is not printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createTools, memoryFiles } from '../src/assistant/tools.js';
import { createDocApi } from '../src/assistant/docApi.js';
import { createAgent, listModels, normalizeBase, PRIMER } from '../src/assistant/agent.js';
import { toTrainingRecord, toJsonl } from '../src/assistant/sft.js';

const base = normalizeBase(process.env.ESL_LLM || '');
if (!base) { console.error('set ESL_LLM to the base URL of an OpenAI-compatible server'); process.exit(2); }
const pub = (p) => new URL('../public/' + p, import.meta.url);
const fetchJson = async (n) => JSON.parse(readFileSync(pub('catalog/' + n), 'utf8'));
const models = await listModels(base, { apiKey: process.env.ESL_LLM_KEY }), model = models.find((m) => m.id === process.env.ESL_LLM_MODEL) || models[0];
console.log(`model ${model.id} · context ${model.context ?? 'unknown'}`);

const probe = createTools({ api: createDocApi({ fetchText: async (p) => readFileSync(pub(p), 'utf8'), fetchJson }), files: memoryFiles(), fetchJson, where: 'mcp' });
const all = (await probe.call('list_examples', {})).data.examples || [];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : all.map((e) => e.id);
const rows = [], records = [];
for (const id of ids) {
  const ex = all.find((e) => e.id === id) || { id, title: id };
  const api = createDocApi({ fetchText: async (p) => readFileSync(pub(p), 'utf8'), fetchJson }), files = memoryFiles();
  const tools = createTools({ api, files, fetchJson, where: 'mcp' }), calls = [];
  const agent = createAgent({ base, model: model.id, apiKey: process.env.ESL_LLM_KEY, contextLimit: model.context, tools, maxSteps: Number(process.env.ESL_STEPS || 14),
    confirm: async () => true, onEvent(ev) { if (ev.type === 'tool_end') calls.push({ name: ev.name, ok: ev.ok, args: ev.args, text: ev.text.slice(0, 160) }); } });
  const ask = `Open the worked example "${ex.title}" (id ${id}) from its data, without its stored result, fit it, and explain the results in a few sentences.`;
  const t0 = Date.now(); let end;
  try { end = await agent.send(ask); } catch (err) { end = 'error: ' + err.message; }
  const t = agent.turns.at(-1) || {}, did = (n, pred = () => true) => calls.some((c) => c.name === n && c.ok && pred(c));
  const row = { id, end, steps: t.steps ? t.steps.length : 0, seconds: Math.round((Date.now() - t0) / 1000),
    opened: did('load_example', (c) => c.args && c.args.id === id), fresh: did('load_example', (c) => c.args && c.args.id === id && c.args.fresh === true),
    fitted: did('run_fit') || did('run_experiment'), explained: did('explain_results'), answered: !!t.final, number_check: t.check ? t.check.ok : null,
    failed_calls: calls.filter((c) => !c.ok).map((c) => `${c.name}: ${c.text.replace(/\s+/g, ' ').slice(0, 110)}`) };
  rows.push(row);
  console.log(`\n== ${id}: ${end} · ${row.steps} steps · ${row.seconds} s · opened ${row.opened}${row.fresh ? ' (fresh)' : ''} · fitted ${row.fitted} · explained ${row.explained} · number check ${row.number_check}`);
  console.log('   calls: ' + calls.map((c) => c.name + (c.ok ? '' : '✗')).join(' → '));
  for (const f of row.failed_calls) console.log('   ✗ ' + f);
  if (t.final) console.log('   answer: ' + t.final.replace(/\s+/g, ' ').slice(0, 300));
  records.push(toTrainingRecord({ turns: agent.turns, primer: PRIMER, specs: tools.specs, model: model.id, page: 'mcp', meta: { example: id } }));
}
writeFileSync(process.env.ESL_OUT || '/tmp/esl-examples.jsonl', toJsonl(records));
const n = (k) => rows.filter((r) => r[k]).length;
console.log(`\nSUMMARY ${rows.length} examples: opened ${n('opened')} (fresh ${n('fresh')}), fitted ${n('fitted')}, explained ${n('explained')}, answered ${n('answered')}, number check passed ${rows.filter((r) => r.number_check === true).length}`);
for (const r of rows) console.log(`  ${r.id.padEnd(16)} ${[r.opened && 'open', r.fresh && 'fresh', r.fitted && 'fit', r.explained && 'explain', r.answered && 'answer'].filter(Boolean).join(' ').padEnd(30)} ${r.steps} steps ${r.seconds} s${r.failed_calls.length ? ` · ${r.failed_calls.length} failed calls` : ''}`);
