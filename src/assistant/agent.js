// The assistant's harness: a tool-calling loop over an OpenAI-compatible /v1/chat/completions endpoint that
// the user chooses (LM Studio, Ollama, vLLM, llama.cpp, or any server that speaks the same protocol).
// No DOM: the panel (main.js) and the tests drive it through events.
//
// What it does for a small local model:
//   - the prompt is rebuilt for every step, stable parts first (system primer, tools) and the live
//     CURRENT STATE card last, so the model always sees what is loaded without asking and the server can
//     reuse its prompt cache;
//   - native tool calls when the server has them, streamed when it streams; otherwise it falls back, on
//     the server's own refusal, to non-streaming and then to a JSON-in-text tool protocol. Calls a model
//     writes as text although native calls are on are repaired the same way;
//   - tool results are capped when stored; when the conversation nears the context limit, older results
//     are cut to a line and the oldest turns are replaced by a summary made by the harness;
//   - a cap on autonomous steps per request (the panel shows "Continue"), a guard against a call repeated
//     with the same result, and a confirmation hook for the tools that replace or delete something.
//
// The only network traffic is to the base URL passed in; an API key, when given, goes in the
// Authorization header of those requests and nowhere else.

import { openAITools } from './toolspec.js';

export const PRESETS = [
  { id: 'lmstudio', label: 'LM Studio', base: 'http://localhost:1234/v1' },
  { id: 'ollama', label: 'Ollama', base: 'http://localhost:11434/v1' },
  { id: 'vllm', label: 'vLLM / llama.cpp', base: 'http://localhost:8000/v1' },
];

/** "localhost:1234" -> "http://localhost:1234/v1"; a pasted ".../v1/chat/completions" loses its tail. */
export function normalizeBase(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|models)$/i, '').replace(/\/+$/, '');
  try { const p = new URL(u); if (p.pathname === '' || p.pathname === '/') u = p.origin + '/v1'; } catch { return ''; }
  return u;
}
const headers = (apiKey) => ({ 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) });

/** The models a server lists, with the context window when it says (vLLM max_model_len, LM Studio, llama.cpp, Ollama variants). */
export async function listModels(base, { apiKey = '', fetch: f = globalThis.fetch, signal } = {}) {
  const b = normalizeBase(base); if (!b) throw new Error('Enter the address of a model server, for example http://localhost:1234/v1');
  let res;
  try { res = await f(b + '/models', { headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {}, credentials: 'omit', signal }); }
  catch (err) { throw new Error(describeError(err, b)); }
  if (!res.ok) throw new Error(describeError({ status: res.status, body: await res.text().catch(() => '') }, b));
  const j = await res.json().catch(() => null), list = j && (j.data || j.models);
  if (!Array.isArray(list)) throw new Error(`${b}/models did not answer with a model list. Is this an OpenAI-compatible base URL? It usually ends in /v1.`);
  return list.map((m) => ({ id: m.id || m.name || m.model, context: [m.max_model_len, m.context_length, m.context_window, m.loaded_context_length, m.max_context_length, m.meta && m.meta.n_ctx_train, m.n_ctx].find((x) => Number.isFinite(x) && x > 0) || null }))
    .filter((m) => m.id && !/embed/i.test(m.id));
}

/** A failure in words a user can act on. */
export function describeError(err, base) {
  if (err && err.name === 'AbortError') return 'Stopped.';
  if (err && err.status) {
    const body = String(err.body || '').replace(/\s+/g, ' ').slice(0, 300);
    if (err.status === 401 || err.status === 403) return `The server at ${base} refused the request (HTTP ${err.status}): it wants an API key, or the key is wrong.`;
    if (err.status === 404) return `${base} answered "not found" (HTTP 404). Is this an OpenAI-compatible base URL? It usually ends in /v1. ${body}`;
    return `The model server answered HTTP ${err.status}. ${body}`;
  }
  const msg = String((err && err.message) || err);
  if (/failed to fetch|networkerror|load failed|fetch failed|ECONNREFUSED/i.test(msg)) {
    const https = typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base);
    return `Could not reach ${base}. ` + (https ? 'This page is served over https and browsers block calls from it to a plain http address other than localhost: run the model on this computer, or put it behind https.' : 'Check that the server is running, that the address and port are right, and that it allows requests from web pages (CORS): LM Studio has a "Enable CORS" switch, Ollama needs OLLAMA_ORIGINS, llama.cpp and vLLM allow it by default or with --allowed-origins.');
  }
  return msg;
}

// ---- the system prompt -----------------------------------------------------------------------------------------
// Constant text: nothing here changes between steps, so it stays in the server's prompt cache. What changes
// (what is loaded, what is free, the latest fit, the files at hand) is in the state card.
export const PRIMER = `You are the assistant built into Exoplanet Science Lab (ESL), a web app that models and fits exoplanet transits, radial velocities and transit timing with nested sampling, in the user's browser. You operate the app for the user through tools: load and describe data, set up a fit, run it, read the results, compare models, write files.

HOW YOU WORK
- Act by calling tools; do not describe what you would do. Call a tool, read its result, continue. When the task is done, answer briefly in plain language.
- A CURRENT STATE block is added at the end of the conversation for every step. It is live: what is loaded, what is free and fixed, the latest fit, the files at hand. Trust it over your memory, and do not call get_state for what it already shows.
- Data stay in the app. You only ever see summaries. To use an attached file, pass its name to load_light_curve, load_radial_velocities, set_timings or import_session. Never paste or retype rows of data.
- Every number you report comes from a tool result. Quote it exactly as returned, with its + and - and unit (write 0.1487 +0.0011 -0.0010, not ±). Never compute, convert, estimate or invent a number, and do not add remarks about a number that no tool gave you.
- For model comparison, report the "reading", "verdict" and "cautions" fields in the software's words. Do not add your own interpretation of an evidence difference.
- If a tool returns ERROR, read the message, correct the call and try once more. If it fails again, tell the user what is wrong.
- A few actions replace or delete the user's work; the app asks the user first. If the result says DENIED, do not retry: ask the user what they want.
- If the request is unclear, or a file you need is not attached, ask one short question instead of guessing.

CONVENTIONS
- Parameter keys: rprs (Rp/R*), ars (a/R*), inc (degrees), per (days), tmid (mid-transit time, days), ecc, omega (degrees), mplanet (Jupiter masses). Limb darkening: ld0..ld3. Airmass slope: a2 (a2@2 for the second epoch). Velocities: rvlin, rvquad, jit@rv1. Star: mstar, rstar, teff, feh. Keys of a second or later planet carry its letter: per@c, rprs@c.
- a/R* (ars) is never fitted. With Kepler mode on it follows from the stellar mass and radius, the period and the planet mass; with it off, ars is a fixed number.
- Times are in days, BJD when the data are dated. Inside the app tmid is counted from the "time reference" in the state; tools accept either form.
- Priors: uniform (a = minimum, b = maximum) or normal (a = mean, b = standard deviation).
- The evidence ln Z compares models only when they were fitted to the same data, with the same priors on the parameters they share. A run that did not converge gives a lower bound only.

RECIPES
- Fit a transit in an attached file: load_light_curve with the file name and, when the user named the planet, the "planet" argument (that loads its parameters from the catalogue); if the System line of CURRENT STATE is still not the planet in the file, call lookup_planet (it keeps the loaded file); set_free (usually rprs, inc, tmid; a2 too when the file has an airmass column); run_fit; then report Rp/R*, the other fitted values and any warning. Check in CURRENT STATE that the light curve in the fit is the user's file before you run.
- Compare models: one call to run_experiment (eccentricity, limb_darkening, airmass, or custom variants). Do not call run_fit for this: two run_fit calls without a change between them are the same model. run_experiment sets up each model, runs every fit, compares them and writes a report file (text and a table, no plots). Then relay its verdict and cautions.
- Explain results ("what do these results mean?"): you MUST call explain_results first, even when you remember the numbers, and relay its sentences and warnings. Do not add conversions (hours, degrees Celsius, au, Earth radii) or interpretations that are not in it.
- Transit timing: set_timings with the file, fit_ephemeris, then timing_periodogram if the user asks about variations.
- Hand over files with export_file: list every file the user asked for in "kinds" (session, report, python, CSV tables). write_file is for your own text. Only say a file was saved when a tool result shows its name.

Keep answers short: what was done, the result with its caveats, and at most one suggestion for what to do next.`;

/** The tool list for a server without native tool calls: one line per tool, and how to call one in text. */
export function textProtocol(specs) {
  const sigOf = (t) => { const p = t.parameters.properties || {}, r = t.parameters.required || []; return Object.keys(p).map((k) => `${k}${r.includes(k) ? '' : '?'}: ${[].concat(p[k].type || 'any').join('|')}${p[k].enum ? ' (' + p[k].enum.join(' | ') + ')' : ''}`).join(', '); };
  return `TOOLS
To call a tool, reply with ONLY a JSON object in a fenced block, nothing else:
\`\`\`json
{"tool": "<name>", "args": { ... }}
\`\`\`
One call per reply. The result comes back in the next message starting with TOOL RESULT. When you have what you need, answer the user in plain text without any JSON block.
${specs.map((t) => `- ${t.name}(${sigOf(t)}): ${firstSentences(t.description, 260)}`).join('\n')}`;
}
const firstSentences = (s, n) => { if (s.length <= n) return s; const c = s.slice(0, n), i = c.lastIndexOf('. '); return i > 60 ? c.slice(0, i + 1) : c + '…'; };

/** Tool descriptions cut down for a small context window (the first sentences; short parameter notes). */
export function slimSpecs(specs, level = 1) {
  const dN = level > 1 ? 150 : 280, pN = level > 1 ? 60 : 110;
  const slim = (s) => { if (!s || typeof s !== 'object') return s; const o = { ...s }; if (o.description) o.description = firstSentences(o.description, pN); if (o.properties) o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, slim(v)])); if (o.items) o.items = slim(o.items); return o; };
  return specs.map((t) => ({ ...t, description: firstSentences(t.description, dN), parameters: { ...slim(t.parameters), description: undefined } }));
}
/** The tools a model with a very small window gets: enough for the common workflows. */
export const CORE_TOOLS = ['load_example', 'lookup_planet', 'set_parameters', 'describe_data', 'load_light_curve', 'load_radial_velocities', 'set_timings', 'set_free', 'set_prior', 'set_sampler', 'run_fit', 'get_results', 'explain_results', 'compare_runs', 'run_experiment', 'fit_ephemeris', 'export_file', 'list_files', 'read_file', 'write_file'];

// ---- calls written as text -------------------------------------------------------------------------------------
/** Every balanced {...} in a string, outermost only. */
function jsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) break; }
    }
    if (depth === 0 && j < text.length) { out.push({ start: i, end: j + 1, text: text.slice(i, j + 1) }); i = j; }
  }
  return out;
}
/**
 * Tool calls a model wrote as text: {"tool": name, "args": {...}} (also "name"/"arguments"/"parameters"),
 * <tool_call>{...}</tool_call>, and Gemma's call:name{...}. Only names in `names` count.
 * Returns { calls: [{ name, args }], rest: the text without them }.
 */
export function parseTextCalls(text, names) {
  const calls = []; let rest = String(text || '');
  const ok = (n) => typeof n === 'string' && names.includes(n);
  for (const m of [...rest.matchAll(/call:([a-z_][a-z0-9_]*)\s*(\{)/gi)]) {
    if (!ok(m[1])) continue;
    const o = jsonObjects(rest.slice(m.index + m[0].length - 1))[0]; if (!o) continue;
    try { calls.push({ name: m[1], args: JSON.parse(o.text), _cut: [m.index, m.index + m[0].length - 1 + o.end] }); } catch { /* not a call */ }
  }
  if (!calls.length) for (const o of jsonObjects(rest)) {
    let j; try { j = JSON.parse(o.text); } catch { continue; }
    const fn = j.function && typeof j.function === 'object' ? j.function : j, name = fn.tool || fn.name || fn.tool_name || fn.function;
    if (!ok(name)) continue;
    let args = fn.args ?? fn.arguments ?? fn.parameters ?? fn.input ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    calls.push({ name, args, _cut: [o.start, o.end] });
  }
  for (const c of [...calls].sort((a, b) => b._cut[0] - a._cut[0])) rest = rest.slice(0, c._cut[0]) + rest.slice(c._cut[1]);
  rest = rest.replace(/```(?:json|tool_call|tool_code)?\s*```/gi, '').replace(/<\/?\|?tool_call\|?>/gi, '').replace(/<\|?tool_call\|?>/gi, '').trim();
  return { calls: calls.map(({ name, args }) => ({ name, args })), rest };
}

// ---- the agent -------------------------------------------------------------------------------------------------
const CHARS_PER_TOKEN = 3.2;
const cutText = (s, n) => (s.length > n ? s.slice(0, n) + `… [${s.length - n} chars cut by the harness]` : s);

/**
 * createAgent(config) -> { send(text), resume(), stop(), reset(), configure(patch), turns, info() }
 * config: { base, model, apiKey, tools (createTools result), fetch, onEvent(ev), confirm({ name, args, reason }) -> Promise<bool>,
 *           maxSteps = 12, contextLimit (tokens; null = unknown, treated as 8192), maxTokens = 1500, temperature = 0.2,
 *           protocol = 'auto' | 'native' | 'text', stream = true, primer = PRIMER }
 * Events: user, assistant_delta { text }, assistant { text, final }, tool_start { id, name, args }, tool_progress { id, text },
 *         tool_end { id, name, ok, text, ms, denied }, note { text }, context { tokens, limit, trimmed }, cap { steps },
 *         error { message }, done { steps, seconds, reason: 'answered' | 'cap' | 'stopped' | 'error' }
 */
export function createAgent(config) {
  const cfg = { maxSteps: 12, maxTokens: 1500, temperature: 0.2, protocol: 'auto', stream: true, primer: PRIMER, contextLimit: null, apiKey: '', ...config };
  const f = cfg.fetch || globalThis.fetch.bind(globalThis), emit = (ev) => { try { cfg.onEvent && cfg.onEvent(ev); } catch { /* a listener's problem */ } };
  const tools = cfg.tools;
  // what the server turned out to support; each flag is dropped once, on the server's own refusal
  const cap = { native: cfg.protocol !== 'text', stream: cfg.stream !== false, usage: true };
  const turns = [];            // { user, steps: [{ content, calls: [{ id, name, args }], results: [{ id, name, text }] }], final, summary, notes: [] }
  let abort = null, busy = false, callSeq = 0, ratio = CHARS_PER_TOKEN, lastUsage = null, trimmedNote = '';

  const limit = () => cfg.contextLimit || 8192;
  const level = () => (limit() < 9000 ? 2 : limit() < 20000 ? 1 : 0);
  const specs = () => { const l = level(); let s = tools.specs; if (l === 2) s = s.filter((t) => CORE_TOOLS.includes(t.name)); return l ? slimSpecs(s, l) : s; };
  const names = () => tools.specs.map((t) => t.name);
  const resultCap = () => Math.round(Math.min(6000, Math.max(700, (limit() * ratio) / 14)));
  const budgetTokens = () => Math.max(1500, Math.floor(limit() * 0.85) - cfg.maxTokens - 200);

  // ---- building the prompt -------------------------------------------------------------------------------------
  const turnSummary = (t) => t.summary || `The user asked: "${cutShort(t.user, 160)}". ` + (t.steps.length ? `Tools used: ${t.steps.flatMap((s) => s.calls.map((c, i) => `${c.name}${(s.results[i] && /^(ERROR|DENIED)/.test(s.results[i].text)) ? ' (failed)' : ''}`)).join(', ')}. ` : '') + (t.final ? `You answered: "${cutShort(t.final, 260)}"` : 'No answer was given.');
  const cutShort = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

  /** The message list for the next request. `plan` says how much of the history to keep whole. */
  function build(plan) {
    const text = !cap.native, sp = specs(), primer = level() === 2 ? cfg.primer.replace(/\n\nRECIPES\n[\s\S]*?(?=\n\nKeep answers short)/, '') : cfg.primer;   // a very small window gets the rules without the recipes
    const msgs = [{ role: 'system', content: primer + (text ? '\n\n' + textProtocol(sp) : '') }];
    const kept = turns.slice(plan.dropTurns), gone = turns.slice(0, plan.dropTurns);
    let preface = gone.length ? `[Earlier in this conversation, summarised by the app]\n${gone.map((t, i) => `${i + 1}. ${turnSummary(t)}`).join('\n')}\n[End of summary]\n\n` : '';
    kept.forEach((t, ti) => {
      const current = ti === kept.length - 1;
      msgs.push({ role: 'user', content: preface + t.user }); preface = '';
      const steps = t.steps, dropSteps = current ? Math.min(plan.dropSteps, Math.max(0, steps.length - 2)) : 0;
      if (dropSteps) msgs[msgs.length - 1].content += `\n\n[Earlier steps of this request, summarised by the app: ${steps.slice(0, dropSteps).flatMap((s) => s.calls.map((c, i) => `${c.name} -> ${cutShort(s.results[i] ? s.results[i].text : '', 90)}`)).join(' | ')}]`;
      steps.slice(dropSteps).forEach((s, si) => {
        const recent = current && si >= steps.length - dropSteps - plan.keepRecent;
        const res = (r) => (plan.shrink && !recent ? cutText(r.text, 220) : r.text);
        if (text) {
          msgs.push({ role: 'assistant', content: (s.content ? s.content + '\n' : '') + s.calls.map((c) => '```json\n' + JSON.stringify({ tool: c.name, args: c.args }) + '\n```').join('\n') });
          msgs.push({ role: 'user', content: s.results.map((r) => `TOOL RESULT (${r.name}):\n${res(r)}`).join('\n\n') });
        } else {
          msgs.push({ role: 'assistant', content: s.content || '', tool_calls: s.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
          for (const r of s.results) msgs.push({ role: 'tool', tool_call_id: r.id, content: res(r) });
        }
      });
      for (const n of t.notes || []) if (n.after === steps.length && current) msgs.push({ role: 'user', content: n.text });
      if (t.final !== undefined && t.final !== null && !current) msgs.push({ role: 'assistant', content: t.final || '(no answer)' });
    });
    // the live state goes on the end of the last message, whatever its role: no server objects to that
    // (and the user's own words come after it, so the request is the last thing the model reads, not the state)
    const last = msgs[msgs.length - 1], cur = kept[kept.length - 1], card = tools.stateCard();
    if (last.role === 'user' && cur && !cur.steps.length && last.content.endsWith(cur.user)) last.content = last.content.slice(0, last.content.length - cur.user.length) + card + '\n\nTHE USER\'S REQUEST:\n' + cur.user;
    else last.content = (last.content ? last.content + '\n\n' : '') + card + (cur ? `\n\nThe user's request, for reference: "${cutShort(cur.user, 400)}"` : '');
    return { msgs, sp };
  }
  const sizeOf = ({ msgs, sp }) => Math.ceil((msgs.reduce((a, m) => a + (m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 12, 0) + (cap.native ? JSON.stringify(openAITools(sp)).length : 0)) / ratio);
  /** The prompt, cut down step by step until it fits the budget: older results to a line, then oldest turns to a summary, then older steps of this request. */
  function fitPrompt() {
    const plan = { shrink: false, keepRecent: 2, dropTurns: 0, dropSteps: 0 }, budget = budgetTokens();
    let p = build(plan), n = sizeOf(p), how = '';
    if (n > budget) { plan.shrink = true; p = build(plan); n = sizeOf(p); how = 'older tool results shortened'; }
    while (n > budget && plan.dropTurns < turns.length - 1) { plan.dropTurns++; p = build(plan); n = sizeOf(p); how = `${plan.dropTurns} earlier request${plan.dropTurns > 1 ? 's' : ''} summarised`; }
    const cur = turns[turns.length - 1];
    while (n > budget && cur && plan.dropSteps < cur.steps.length - 2) { plan.dropSteps++; p = build(plan); n = sizeOf(p); how = (plan.dropTurns ? `${plan.dropTurns} earlier requests summarised, ` : '') + `${plan.dropSteps} earlier step${plan.dropSteps > 1 ? 's' : ''} of this request summarised`; }
    if (how !== trimmedNote) emit({ type: 'context', tokens: n, limit: limit(), budget, trimmed: how });
    trimmedNote = how;
    return { ...p, tokens: n, plan };
  }

  // ---- one request ---------------------------------------------------------------------------------------------
  async function post(body, signal) {
    let res;
    try { res = await f(cfg.base + '/chat/completions', { method: 'POST', headers: headers(cfg.apiKey), body: JSON.stringify(body), credentials: 'omit', signal }); }
    catch (err) { if (err && err.name === 'AbortError') throw err; throw new Error(describeError(err, cfg.base)); }
    if (!res.ok) { const e = new Error('http'); e.status = res.status; e.body = await res.text().catch(() => ''); throw e; }
    return res;
  }
  async function readStream(res, signal) {
    const out = { content: '', reasoning: '', calls: [], finish: null, usage: null };
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    const line = (l) => {
      if (!l.startsWith('data:')) return; const d = l.slice(5).trim(); if (!d || d === '[DONE]') return;
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.error) { const e = new Error('http'); e.status = j.error.code || 500; e.body = j.error.message || JSON.stringify(j.error); throw e; }
      if (j.usage) out.usage = j.usage;
      const ch = j.choices && j.choices[0]; if (!ch) return;
      const dl = ch.delta || {};
      if (dl.content) { out.content += dl.content; emit({ type: 'assistant_delta', text: dl.content }); }
      if (dl.reasoning || dl.reasoning_content) out.reasoning += dl.reasoning || dl.reasoning_content;
      for (const tc of dl.tool_calls || []) { const i = tc.index ?? out.calls.length, c = (out.calls[i] = out.calls[i] || { id: '', name: '', arguments: '' }); if (tc.id) c.id = tc.id; if (tc.function && tc.function.name) c.name += tc.function.name; if (tc.function && tc.function.arguments) c.arguments += tc.function.arguments; }
      if (ch.finish_reason) out.finish = ch.finish_reason;
    };
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* closed */ } const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    }
    if (buf.trim()) line(buf.trim());
    out.calls = out.calls.filter(Boolean);
    return out;
  }
  /** Ask the model once. Degrades (usage option, streaming, native tools) when the server refuses a feature, and remembers it. */
  async function complete(signal, maxTokens = cfg.maxTokens) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = fitPrompt();
      const body = { model: cfg.model, messages: p.msgs, temperature: cfg.temperature, max_tokens: maxTokens };
      if (cap.native) { body.tools = openAITools(p.sp); body.tool_choice = 'auto'; }
      if (cap.stream) { body.stream = true; if (cap.usage) body.stream_options = { include_usage: true }; }
      try {
        const res = await post(body, signal);
        let out;
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (cap.stream && res.body && /event-stream/i.test(ct)) out = await readStream(res, signal);
        else {
          const j = await res.json();
          if (j.error) { const e = new Error('http'); e.status = 400; e.body = j.error.message || JSON.stringify(j.error); throw e; }   // a 200 with an error body
          const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
          out = { content: m.content || '', reasoning: m.reasoning || m.reasoning_content || '', calls: (m.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })), finish: j.choices && j.choices[0] && j.choices[0].finish_reason, usage: j.usage || null };
          if (cap.stream && !/event-stream/i.test(ct)) cap.stream = false;   // it ignored "stream": do not ask again
        }
        if (out.usage && out.usage.prompt_tokens > 200) { const chars = p.tokens * ratio; ratio = Math.min(5, Math.max(2, 0.5 * ratio + 0.5 * (chars / out.usage.prompt_tokens))); lastUsage = out.usage; }
        return out;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (!err.status) throw err;
        const b = String(err.body || '').toLowerCase(), soft = [400, 404, 422, 500, 501].includes(err.status);
        if (soft && cap.usage && cap.stream && /stream_options|include_usage/.test(b)) { cap.usage = false; continue; }
        if (soft && cap.native && cfg.protocol !== 'native' && /tool|function/.test(b) && !/context|too long|maximum/.test(b)) { cap.native = false; emit({ type: 'note', text: 'This server or model does not accept tool definitions, so tools are called through a JSON-in-text protocol instead.' }); continue; }
        if (soft && cap.stream && /stream/.test(b)) { cap.stream = false; emit({ type: 'note', text: 'This server does not stream; replies will arrive whole.' }); continue; }
        if (/context|too long|maximum.*tokens|exceed/.test(b) && limit() > 2048) { cfg.contextLimit = Math.floor(limit() * 0.6); emit({ type: 'note', text: `The server says the prompt is too long: the context budget is now ${cfg.contextLimit} tokens.` }); continue; }
        if (err.status === 400 && cap.usage && cap.stream) { cap.usage = false; continue; }
        if (err.status === 400 && cap.stream) { cap.stream = false; continue; }
        if (err.status === 400 && cap.native && cfg.protocol !== 'native') { cap.native = false; emit({ type: 'note', text: 'The server refused the request with tool definitions; trying the JSON-in-text tool protocol.' }); continue; }
        throw new Error(describeError(err, cfg.base));
      }
    }
    throw new Error('The model server kept refusing the request.');
  }

  // ---- the loop ------------------------------------------------------------------------------------------------
  async function loop(turn) {
    const t0 = Date.now(), signal = abort.signal; let steps = 0, nudged = false, emptyRetry = false, lastKey = '', lastText = '', repeats = 0;
    const end = (reason) => { emit({ type: 'done', steps, seconds: (Date.now() - t0) / 1000, reason, usage: lastUsage }); return reason; };
    try {
      for (;;) {
        if (signal.aborted) return end('stopped');
        if (steps >= cfg.maxSteps) { turn.capped = true; emit({ type: 'cap', steps }); return end('cap'); }
        let out = await complete(signal);
        if (out.finish === 'length' && !out.content && !out.calls.length) out = await complete(signal, cfg.maxTokens * 2);   // it ran out of room while thinking
        steps++;
        let calls = out.calls.map((c) => { let args = {}; try { args = c.arguments ? JSON.parse(c.arguments) : {}; } catch { args = c.arguments; } return { name: c.name, args }; }), content = out.content || '';
        if (!calls.length && content) { const p = parseTextCalls(content, names()); if (p.calls.length) { calls = cap.native ? p.calls : p.calls.slice(0, 1); content = p.rest; } }
        if (!calls.length) {
          if (!content.trim() && !emptyRetry) { emptyRetry = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: '[From the app, not the user] Your last reply was empty. Call a tool, or answer the user.' }); continue; }
          // a promise instead of an action ("I will now load…"): ask once for the action itself
          if (!nudged && !turn.steps.length && content.length < 600 && /\b(i will|i'll|let me|i am going to|i'm going to|first,? i)\b/i.test(content) && !/\?\s*$/.test(content.trim())) { nudged = true; (turn.notes = turn.notes || []).push({ after: 0, text: `[From the app, not the user] You wrote: "${cutShort(content, 200)}" but called no tool. Do it now: call the tool.` }); continue; }
          // an answer that names a file nobody wrote ("I saved session.json"): one chance to write it or take the claim back
          const have = tools.fileNames ? tools.fileNames().map((n) => n.toLowerCase()) : null;
          const ghost = have ? [...new Set((content.match(/[\w][\w.()-]*\.(?:json|md|csv|py|tex|png|txt|yaml)\b/gi) || []).filter((n) => !have.includes(n.toLowerCase())))] : [];
          if (ghost.length && !turn.fileChecked && turn.steps.length) { turn.fileChecked = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: `[From the app, not the user] Your answer mentions ${ghost.join(', ')}, but no such file exists (files: ${have.join(', ') || 'none'}). If you meant to give the user that file, write it now with export_file or write_file; otherwise answer again without claiming it.` }); emit({ type: 'note', text: `The answer mentioned ${ghost.join(', ')}, which does not exist; the assistant was asked to write it or correct itself.` }); continue; }
          if (ghost.length && turn.fileChecked) emit({ type: 'note', text: `Check: the answer below mentions ${ghost.join(', ')}, but no such file was written.` });
          turn.final = content.trim() || '(The model returned an empty answer.' + (cap.native ? ')' : ' With the JSON-in-text tool protocol this happens when the server strips the model\'s own tool-call syntax: if the server supports tool calling, let the assistant use it.)');
          emit({ type: 'assistant', text: turn.final, final: true });
          return end('answered');
        }
        const step = { content: content.trim(), calls: [], results: [] };
        turn.steps.push(step);
        if (step.content) emit({ type: 'assistant', text: step.content, final: false });
        for (const c of calls) {
          const id = 'call_' + (++callSeq), key = c.name + ' ' + JSON.stringify(c.args);
          step.calls.push({ id, name: c.name, args: c.args });
          emit({ type: 'tool_start', id, name: c.name, args: c.args });
          const t1 = Date.now(); let text, ok = false, denied = false, data;
          if (signal.aborted) text = 'ERROR: stopped by the user before this call ran.';
          else if (key === lastKey && repeats >= 1) text = `ERROR: this exact call was just made ${repeats + 1} times with the same result:\n${cutText(lastText, 300)}\nDo not repeat it. Use the result, try something different, or answer the user.`;
          else {
            const reason = tools.confirmFor(c.name, typeof c.args === 'object' && c.args ? c.args : {});
            // one "no" stands for the rest of the request: the user is not asked again, and a second attempt ends the request
            if (reason && turn.denied) { denied = true; turn.deniedTwice = true; text = 'DENIED: the user already declined this in the current request.'; }
            else if (reason && cfg.confirm && !(await cfg.confirm({ id, name: c.name, args: c.args, reason }))) { denied = true; turn.denied = true; text = 'DENIED: the user declined this action. Do not retry it or try another way to do the same thing. Tell the user it was not done and ask what they would like instead.'; }
            else {
              const r = await tools.call(c.name, c.args, { signal, onProgress: (p) => emit({ type: 'tool_progress', id, progress: p }) });
              ok = r.ok; text = r.text; data = r.data;
            }
          }
          if (!/^ERROR: this exact call/.test(text)) { repeats = key === lastKey && text === lastText ? repeats + 1 : 0; lastKey = key; lastText = text; }
          const stored = cutText(text, resultCap());
          step.results.push({ id, name: c.name, text: stored });
          emit({ type: 'tool_end', id, name: c.name, ok, denied, text, data, ms: Date.now() - t1 });
        }
        if (turn.deniedTwice) { turn.final = 'I stopped here: you declined that action, so nothing was replaced or deleted. Tell me how you would like to continue.'; emit({ type: 'assistant', text: turn.final, final: true }); return end('answered'); }
      }
    } catch (err) {
      if ((err && err.name === 'AbortError') || signal.aborted) return end('stopped');
      emit({ type: 'error', message: String((err && err.message) || err) });
      return end('error');
    }
  }
  async function run(turn) {
    if (busy) throw new Error('the assistant is already working');
    busy = true; abort = new AbortController();
    try { return await loop(turn); } finally { busy = false; abort = null; }
  }

  return {
    turns,
    /** A new request from the user. Resolves with how the loop ended: 'answered', 'cap', 'stopped' or 'error'. */
    send(text) { const turn = { user: String(text), steps: [], final: null, notes: [] }; turns.push(turn); emit({ type: 'user', text: turn.user }); return run(turn); },
    /** Carry on after the step cap (the "Continue" button). */
    resume() { const turn = turns[turns.length - 1]; if (!turn) throw new Error('nothing to continue'); turn.capped = false; return run(turn); },
    stop() { if (abort) abort.abort(); },
    reset() { turns.length = 0; trimmedNote = ''; },
    configure(patch) { Object.assign(cfg, patch); if (patch.protocol) cap.native = patch.protocol !== 'text'; if (patch.base || patch.model) { cap.native = cfg.protocol !== 'text'; cap.stream = cfg.stream !== false; cap.usage = true; } },
    info: () => ({ busy, native: cap.native, stream: cap.stream, contextLimit: limit(), known: !!cfg.contextLimit, tools: specs().length, promptTokens: turns.length ? fitPromptQuiet() : 0, usage: lastUsage, resultCap: resultCap() }),
    /** The exact messages the next request would carry (for the panel's "what is sent" view and the tests). */
    preview: () => fitPrompt(),
  };
  function fitPromptQuiet() { const e = cfg.onEvent; cfg.onEvent = null; try { return fitPrompt().tokens; } finally { cfg.onEvent = e; } }
}
