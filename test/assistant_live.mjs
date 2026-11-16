// Live check of the assistant's harness against a real OpenAI-compatible endpoint, without a browser: the
// same tools on a session document (src/assistant/docApi.js). Not part of `npm test`.
//   ESL_LLM=http://host:1234/v1 node test/assistant_live.mjs ["a request" ...]      (ESL_LLM_MODEL, ESL_LLM_KEY, ESL_STEPS optional)
// Prints every tool call with its result and the final answer, then steps and seconds per request.
import { readFileSync } from 'node:fs';
import { createTools, memoryFiles } from '../src/assistant/tools.js';
import { createDocApi } from '../src/assistant/docApi.js';
import { createAgent, listModels, normalizeBase } from '../src/assistant/agent.js';
const base = normalizeBase(process.env.ESL_LLM || '');
if (!base) { console.error('set ESL_LLM to the base URL of an OpenAI-compatible server'); process.exit(2); }
const pub = (p) => new URL('../public/' + p, import.meta.url);
const api = createDocApi({ fetchText: async (p) => readFileSync(pub(p), 'utf8'), fetchJson: async (n) => JSON.parse(readFileSync(pub('catalog/' + n), 'utf8')) });
const files = memoryFiles(), tools = createTools({ api, files, fetchJson: async (n) => JSON.parse(readFileSync(pub('catalog/' + n), 'utf8')), where: 'mcp' });
for (const a of (process.env.ESL_ATTACH || '').split(',').filter(Boolean)) files.add(a.split('/').pop(), readFileSync(a, 'utf8'));
const models = await listModels(base, { apiKey: process.env.ESL_LLM_KEY }), model = models.find((m) => m.id === process.env.ESL_LLM_MODEL) || models[0];
console.log(`endpoint ${base} · model ${model.id} · context ${model.context ?? 'unknown'}`);
const agent = createAgent({ base, model: model.id, apiKey: process.env.ESL_LLM_KEY, contextLimit: process.env.ESL_CTX ? Number(process.env.ESL_CTX) : model.context, tools, maxSteps: Number(process.env.ESL_STEPS || 12), protocol: process.env.ESL_PROTOCOL || 'auto', stream: process.env.ESL_STREAM !== '0',
  confirm: async ({ name, reason }) => { console.log(`   [confirm] ${name}: ${reason} -> yes`); return true; },
  onEvent(ev) {
    if (ev.type === 'tool_start') console.log(` -> ${ev.name} ${JSON.stringify(ev.args)}`);
    else if (ev.type === 'tool_end') console.log(`    ${ev.ok ? 'ok' : 'FAILED'} (${ev.ms} ms) ${ev.text.slice(0, 400)}${ev.text.length > 400 ? '…' : ''}`);
    else if (ev.type === 'assistant') console.log(`${ev.final ? '\nANSWER' : ' ..'} ${ev.text}`);
    else if (ev.type === 'note' || ev.type === 'error') console.log(` [${ev.type}] ${ev.text || ev.message}`);
    else if (ev.type === 'context' && ev.trimmed) console.log(` [context] ${ev.tokens} of ${ev.limit} tokens: ${ev.trimmed}`);
    else if (ev.type === 'cap') console.log(` [cap] ${ev.steps} steps: continuing would need the user's click`);
    else if (ev.type === 'done') console.log(`\n== ${ev.reason}: ${ev.steps} model steps, ${ev.seconds.toFixed(1)} s ==`);
  } });
const asks = process.argv.slice(2).length ? process.argv.slice(2) : ['Load the single-transit example, free the eccentricity, run the fit and tell me Rp/R*.'];
for (const q of asks) { console.log(`\nUSER ${q}`); await agent.send(q); }
console.log(JSON.stringify(agent.info()));
