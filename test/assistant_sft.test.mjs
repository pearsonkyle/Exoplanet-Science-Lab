// The assistant's conversation export as training data (src/assistant/sft.js): a conversation driven through the
// real harness (agent.js) against a scripted model, then exported and checked field by field, and read back.
import { createAgent, PRIMER } from '../src/assistant/agent.js';
import { toTrainingRecord, toJsonl, fromTrainingRecord, FORMAT } from '../src/assistant/sft.js';
import { TOOL_SPECS } from '../src/assistant/toolspec.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// a scripted OpenAI-compatible server: replies in order, non-streaming, with reasoning
const reply = (m) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: m, finish_reason: m.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100 } }), text: async () => '' });
const script = [
  { content: '', reasoning_content: 'The user wants the example loaded first.', tool_calls: [{ id: 'x1', type: 'function', function: { name: 'load_example', arguments: '{"id":"single"}' } }] },
  { content: 'Now the fit.', reasoning_content: 'Loaded; run the fit.', tool_calls: [{ id: 'x2', type: 'function', function: { name: 'run_fit', arguments: '{}' } }] },
  { content: 'Rp/R* is 0.1406 +0.0009 -0.0009.', reasoning_content: 'Quote the number with its interval.' },
  { content: 'The depth follows from $\\delta \\simeq (R_p/R_\\star)^2$.', reasoning_content: 'A follow-up question; answer from the methods.' },
];
let i = 0;
const fetch = async (url, init) => { if (/\/models$/.test(url)) return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) }; const body = JSON.parse(init.body); if (body.stream) return { ok: false, status: 400, text: async () => 'stream not supported', json: async () => ({}) }; return reply(script[i++]); };
const specs = TOOL_SPECS.filter((t) => ['load_example', 'run_fit', 'get_results'].includes(t.name));
let state = 'CURRENT STATE OF THE APP (live; regenerated every step)\nnothing loaded';
const tools = {
  specs, names: specs.map((t) => t.name), stateCard: () => state, confirmFor: () => null, fileNames: () => [],
  async call(name) { if (name === 'load_example') { state = 'CURRENT STATE OF THE APP (live; regenerated every step)\nsingle transit loaded'; return { ok: true, text: '{"loaded":"single"}' }; } return { ok: true, text: '{"rprs":"0.1406 +0.0009 -0.0009"}' }; },
};
const agent = createAgent({ base: 'http://llm.test/v1', model: 'm', tools, fetch, contextLimit: 32000, stream: false, checkNumbers: false });
await agent.send('Load the single-transit example and fit it.');
await agent.send('How is the depth related to Rp/R*?');

const rec = toTrainingRecord({ turns: agent.turns, primer: PRIMER, specs, model: 'm', page: 'analyze' });
const M = rec.messages, roles = M.map((m) => m.role).join(',');
check('messages: system, user, assistant(tool) , tool, assistant(tool), tool, assistant, user, assistant', roles === 'system,user,assistant,tool,assistant,tool,assistant,user,assistant', roles);
check('system message is the primer', M[0].content === PRIMER);
check('the first user message has the state card, then the request last', /^CURRENT STATE[\s\S]*nothing loaded[\s\S]*THE USER'S REQUEST:\nLoad the single-transit example and fit it\.$/.test(M[1].content));
const a1 = M[2];
check('assistant tool call: id, type, function name and JSON arguments', a1.tool_calls.length === 1 && a1.tool_calls[0].type === 'function' && a1.tool_calls[0].function.name === 'load_example' && JSON.parse(a1.tool_calls[0].function.arguments).id === 'single');
check('assistant messages keep the model\'s reasoning', a1.reasoning_content === 'The user wants the example loaded first.' && M[6].reasoning_content === 'Quote the number with its interval.');
check('tool message: tool_call_id matches its call, name and full result', M[3].tool_call_id === a1.tool_calls[0].id && M[3].name === 'load_example' && M[3].content.startsWith('{"loaded":"single"}'));
check('the state card the model saw before its next step follows the tool result', /single transit loaded/.test(M[3].content));
check('final answer is the model\'s own text', M[6].content === 'Rp/R* is 0.1406 +0.0009 -0.0009.' && !M[6].tool_calls);
check('second request with its own state card; LaTeX kept as written', /single transit loaded[\s\S]*THE USER'S REQUEST:\nHow is the depth/.test(M[7].content) && M[8].content.includes('$\\delta \\simeq'));
check('tools: OpenAI function schemas of every tool', rec.tools.length === specs.length && rec.tools.every((t) => t.type === 'function' && t.function.name && t.function.parameters && t.function.parameters.type === 'object'));
check('metadata: format, counts', rec.metadata.format === FORMAT && rec.metadata.turns === 2 && rec.metadata.tool_calls === 2 && rec.metadata.steps === 4, JSON.stringify(rec.metadata));
const line = toJsonl([rec, rec]);
check('JSONL: one record per line, each parses', line.trim().split('\n').length === 2 && line.trim().split('\n').every((l) => JSON.parse(l).messages.length === M.length));
// every tool_call has exactly one tool answer, in order, before the next assistant message
let pairs = true; for (let k = 0; k < M.length; k++) if (M[k].tool_calls) { const ids = M[k].tool_calls.map((c) => c.id); const ans = M.slice(k + 1, k + 1 + ids.length).map((m) => m.role === 'tool' && m.tool_call_id); if (ids.join() !== ans.join()) pairs = false; }
check('every tool call is answered right after it (chat templates require this)', pairs);

const back = fromTrainingRecord(JSON.parse(line.split('\n')[0]));
check('read back: requests, calls, results and answers', back.length === 2 && back[0].user === 'Load the single-transit example and fit it.' && back[0].steps.length === 2 && back[0].steps[0].calls[0].name === 'load_example' && back[0].steps[1].results[0].text === '{"rprs":"0.1406 +0.0009 -0.0009"}' && back[0].final === 'Rp/R* is 0.1406 +0.0009 -0.0009.' && back[1].final.startsWith('The depth'));
// an answer the app added a table to: the record keeps the model's words, the metadata counts it
const t2 = JSON.parse(JSON.stringify(agent.turns)); t2[0].final += '\n\n| app table |'; const r2 = toTrainingRecord({ turns: t2, primer: PRIMER, specs });
check('the app\'s number-check table is not trained on', r2.messages[6].content === 'Rp/R* is 0.1406 +0.0009 -0.0009.' && r2.metadata.answers_with_app_table === 1);

process.exit(ok ? 0 : 1);
