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

import { openAITools, TOOL_SPECS } from './toolspec.js';
import { checkNumbers, appendix } from './numcheck.js';

// No address of a model server is written in this code: the set-up card's presets are in presets.js, the only place
// one may appear. These are the names of servers known to speak the protocol, for the help text of the card.
export const SERVER_KINDS = ['LM Studio', 'Ollama', 'vLLM', 'llama.cpp'];

/** Loopback names: a page may call these over plain http even when it is served over https. */
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|[^/:]+\.localhost)$/i;
/**
 * Would the browser block this call as mixed content? True for a page served over https calling a plain-http
 * address on another machine. pageUrl defaults to the page's own address (nothing is blocked outside a browser).
 */
export function mixedContent(base, pageUrl = typeof location !== 'undefined' ? location.href : '') {
  try { const b = new URL(normalizeBase(base)), p = new URL(pageUrl); return p.protocol === 'https:' && b.protocol === 'http:' && !LOOPBACK.test(b.hostname); } catch { return false; }
}
export const MIXED_HELP = 'This page is served over https, and browsers do not let an https page call a plain http address on another machine (mixed content). Three ways round it: run the site on your own computer (npm run dev, or any static server on the built site) and open it over http; put the model server behind https (a reverse proxy with a certificate); or use the MCP server in mcp/ from a desktop client instead of this chat.';

/** "host:port" -> "http://host:port/v1"; a pasted ".../v1/chat/completions" loses its tail. */
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
  const b = normalizeBase(base); if (!b) throw new Error('Enter the address of your model server: its OpenAI-compatible base URL, which usually ends in /v1.');
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
    if (mixedContent(base)) return `Could not reach ${base}. ${MIXED_HELP}`;
    return `Could not reach ${base}. Check that the server is running, that the address and port are right, and that it allows requests from web pages (CORS): LM Studio has an "Enable CORS" switch, Ollama needs OLLAMA_ORIGINS, llama.cpp and vLLM allow it by default or with --allowed-origins.`;
  }
  return msg;
}

// ---- the system prompt -----------------------------------------------------------------------------------------
// Constant text: nothing here changes between steps, so it stays in the server's prompt cache. What changes
// (what is loaded, what is free, the latest fit, the files at hand) is in the state card.
export const PRIMER = `You are the assistant built into Exoplanet Science Lab (ESL), a website for planning, observing, reducing and fitting exoplanet observations in the user's browser. You operate the site for the user through tools. The site has several pages and you are on one of them at a time; the tools you have are those of the page you are on, plus navigate, which takes you (and the conversation) to another page.

PAGES
- plan: which transits can be observed from a site in a range of nights. observe: a view of the sky from a place at a time. photometry: light curves from images (FITS frames). analyze: model and fit transits, radial velocities and timing with nested sampling. search: the catalogue of known planets. validation: how these models compare with other codes. home: the landing page.
- To work on another page, call navigate. The page reloads there and you continue the same request with that page's tools: plan the whole request first, do everything this page can do, then navigate. Do not navigate to the page you are already on.

HOW YOU WORK
- Act by calling tools; do not describe what you would do. Call a tool, read its result, continue. When the task is done, answer briefly in plain language.
- A CURRENT STATE block is added at the end of the conversation for every step. It is live: the page you are on, what is loaded, the files at hand. Trust it over your memory, and do not call a tool for what it already shows. Its PROJECT part says what was done on other pages (site, planned event, data, fits with their numbers): use it instead of asking or redoing work.
- A long tool result is cut; read_result with its id reads the rest. A page may have more tools than you are shown: more_tools lists and adds them.
- Data stay in the app. You only ever see summaries. To use an attached file, pass its name to the tool that loads it. Never paste or retype rows of data.
- If a tool returns ERROR, read the message, correct the call and try once more. If it fails again, tell the user what is wrong.
- A few actions replace or delete the user's work; the app asks the user first. If the result says DENIED, do not retry: ask the user what they want.
- Do what was asked and no more. Do not run a fit, replace data or change page unless the request calls for it; when the user says "do not run it", stop after the set-up. Say only what the tool results show: never claim something was or was not done against them.
- If the request is unclear, or a file you need is not attached, ask one short question instead of guessing.

NUMBERS (the app checks your answer against the tool results)
- Every number you write must be copied from a tool result of this conversation, character for character. Never compute, convert, round to a different unit, estimate or recall a number: no hours from days, no percent from a fraction, no Earth radii from Jupiter radii, no differences or ratios of your own. If the user wants a quantity no tool returned, call the tool that gives it (get_derived, explain_results) or say the app does not provide it.
- A value that came with an uncertainty is always quoted with it, in the same form: write 0.1487 +0.0011 -0.0010 (not 0.1487, not ±0.001), and 1253.73 ± 0.54 for an evidence.
- Keep the unit the tool gave: depth_ppt is parts per thousand (not percent), times in BJD or days stay so.
- For model comparison give each run's ln Z and Δ ln Z as returned, then the "reading", "verdict" and "cautions" in the software's words. Do not interpret an evidence difference yourself, and never compute one.
- An answer whose numbers do not match the tool results gets the app's own table attached under it.

METHODS AND EQUATIONS
- For "how is X calculated", "what does the model assume" or "how accurate is it": call explain_method with the question, then answer from its text. Quote its equations exactly. For the code itself call read_source with a file from its "code" list and the function name.
- Write equations in LaTeX between $...$ (inline) or $$...$$ (on their own line): the chat renders them. A derivation from first principles is welcome: start from the definitions explain_method gives and go step by step in symbols. Numbers in it still come from tool results only.

ANALYZE PAGE
- Parameter keys: rprs (Rp/R*), ars (a/R*), inc (degrees), per (days), tmid (mid-transit time, days), ecc, omega (degrees), mplanet (Jupiter masses). Limb darkening: ld0..ld3. Airmass slope: a2 (a2@2 for the second epoch). Velocities: rvlin, rvquad, jit@rv1. Star: mstar, rstar, teff, feh. Keys of a second or later planet carry its letter: per@c, rprs@c.
- a/R* (ars) is never fitted. With Kepler mode on it follows from the stellar mass and radius, the period and the planet mass; with it off, ars is a fixed number.
- Times are in days, BJD when the data are dated. tmid is counted from the "time reference" in the state; tools accept either form.
- Priors: uniform (a = minimum, b = maximum) or normal (a = mean, b = standard deviation).
- The evidence ln Z compares models only when they were fitted to the same data, with the same priors on the parameters they share. A run that did not converge gives a lower bound only.

RECIPES
- Fit a transit in an attached file (analyze): load_light_curve with the file name and, when the user named the planet, the "planet" argument; if the System line of CURRENT STATE is still not the planet in the file, call lookup_planet (it keeps the loaded file); set_free (usually rprs, inc, tmid; a2 too when the file has an airmass column); run_fit; then report the fitted values with their intervals and any warning.
- Compare models, or "try A against B" (analyze): one call to run_experiment (eccentricity, limb_darkening, airmass, companion, or custom variants, which may carry set-up steps). Do not call run_fit several times for this. Then give the comparison table, the verdict and the cautions as returned.
- Explain results: call explain_results first, even when you remember the numbers, and relay its sentences and warnings.
- Transit timing: set_timings with the file, fit_ephemeris, then timing_periodogram if the user asks about variations.
- Plan an observation: on the plan page set the site, the dates and the target, then list the transits; to go on with one of them, open it in the sky view or the analyzer (the tool navigates for you). The best one is observable "yes" with the highest conditions_of_100 (for an analysis afterwards, a confirmed planet: rows marked tess_candidate are not in the analyzer's catalogue); say when (mid_utc and local_times) and why (altitude, Moon, conditions) in the words of the list.
- Analyse a planned night (analyze, after plan_open_transit with "analyze"): the planet is loaded on arrival; simulate_light_curve with mid_transit "planned" (the planned night of PROJECT); set_free rprs, inc, tmid; run_fit; get_figure light_curve; then give Rp/R* and tmid exactly as run_fit returned them.
- Look up parameters and priors (analyze): lookup_planet loads a system with its catalogue values and uncertainties; get_state lists every parameter with its value, whether it is free and its prior; set_prior changes one. Quote priors as get_state gives them.
- Reduce images (photometry page): photometry_frames, photometry_examine_star or photometry_focus_map to check the stars and the focus, photometry_pick_stars, photometry_run, then photometry_send_to_analyze.
- A whole project from the user's data (analyze), one step at a time, telling the user what each step found: (1) load the file (load_light_curve or load_radial_velocities, with "planet" when the user named it); (2) lookup_planet for the system's parameters and catalogue priors, then get_state to see them; (3) set_free for the parameters the data constrain (transit: rprs, inc, tmid; velocities: mplanet, and per, ecc, omega when the data cover the orbit, plus jit@rv1 for each instrument) and set_prior where the user or the catalogue gives one; (4) run_fit; (5) explain_results; (6) residual_periodogram to look for another periodic signal, and, if its verdict calls a peak a candidate, add_planet with that period, run_fit and compare_runs; (7) write_report. If the user asked for only some of these, do only those.
- Write up (analyze, at the end): write_report gives the standard project report with its BibTeX, session and figures; say which files were written and what the report asks the user to check.
- Files: export_file writes single outputs (session, report, python, CSV tables); get_figure makes a figure; write_file is for your own text. Only say a file was saved when a tool result shows its name.

Keep answers short: what was done, the result with its caveats, and at most one suggestion for what to do next.`;

/**
 * Parts of a request a small model often leaves out, with the tools that do them (agent: the checklist nudge).
 * A part counts as asked when the user's words match `asked`, and as done when one of its tools ran without an error.
 * (Figures have their own nudge; a fit is not on the list, because "set up a fit but do not run it" is a common request.)
 */
export const REQUEST_PARTS = [
  { what: 'an explanation of the results', asked: /\b(explain|interpret|what (?:do|does) (?:the|these) .*mean|meaning)\b/i, tools: ['explain_results'] },
  { what: 'a search for another periodic signal', asked: /\b(another|second|additional|other|more|hidden)\b[^.]{0,40}\b(signal|planet|period|periodicit)|\bperiodogram\b|\bsearch (?:the )?residuals\b/i, tools: ['residual_periodogram', 'timing_periodogram'] },
  { what: 'a report', asked: /\breport\b|\bwrite[- ]?up\b|\bsummari[sz]e (?:the|it|everything)/i, tools: ['write_report', 'export_file'] },
];

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
export const CORE_TOOLS = ['load_example', 'lookup_planet', 'set_parameters', 'describe_data', 'load_light_curve', 'load_radial_velocities', 'simulate_light_curve', 'set_free', 'set_prior', 'set_kepler', 'choose_data', 'run_fit', 'get_results', 'explain_results', 'compare_runs', 'run_experiment', 'residual_periodogram', 'add_planet', 'explain_method', 'read_source', 'get_state', 'write_report', 'get_figure', 'export_file', 'search_catalog', 'list_files', 'read_file'];
/** For a very small window (under 9k tokens) the core is smaller still. */
export const TINY_TOOLS = ['load_example', 'lookup_planet', 'set_parameters', 'describe_data', 'load_light_curve', 'load_radial_velocities', 'set_timings', 'set_free', 'set_prior', 'set_sampler', 'run_fit', 'get_results', 'explain_results', 'compare_runs', 'run_experiment', 'fit_ephemeris', 'export_file', 'list_files', 'read_file', 'write_file'];
/** A page whose tool definitions are longer than this (characters of JSON) shows its core tools and lists the rest under more_tools. */
export const TIER_CHARS = 12000;
/** The default history budget (tokens): what the conversation itself may take of a prompt, besides the primer, the tools and the state. */
export const HISTORY_BUDGET = 6000;
const gist = (t) => { const d = String(t.description || '').split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, ''); return d.length > 56 ? d.slice(0, 55).replace(/\s+\S*$/, '') + '…' : d; };
/** The harness's own tools: read the rest of a cut result; add the definitions of tools that are not shown. */
export const READ_RESULT = { name: 'read_result', readOnly: true, description: 'Read the full text of a tool result that was cut (its end says "read_result"). Give the call id; read on with offset.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'The id named in the cut result, e.g. "call_7".' }, offset: { type: 'integer', description: 'Start at this character (default 0).', minimum: 0 }, max_chars: { type: 'integer', description: 'How many characters (default 4000).', minimum: 200, maximum: 20000 } }, required: ['id'], additionalProperties: false } };
export const moreToolsSpec = (hidden, short = false) => ({ name: 'more_tools', readOnly: true, description: short ? `More tools: call more_tools with the names to add them, or call one directly. ${hidden.map((t) => t.name).join(', ')}.` : `More tools of this page, not listed above to keep the prompt short. Call more_tools with the names you need and their definitions are added; or call one directly if you know its arguments. ${hidden.map((t) => `${t.name} (${gist(t)})`).join('; ')}.`,
  parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names from the list.' } }, required: ['names'], additionalProperties: false } });

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
/** "do not run it", "don't start the fit yet", "without running": a request that says so gets no fit, whatever the model decides. */
/**
 * A request that only asks something ("How is K computed? Derive it."): it changes nothing, so the tools that change
 * the analysis are refused for it. Asking words first, and no word of an action anywhere in it.
 */
export const isQuestionOnly = (text) => /^\s*(how|what|why|which|where|when|who|whose|is|are|was|does|do|did|can you explain|explain|tell me|describe|derive|show me how|give me the (?:equation|formula))\b/i.test(text)
  && !/\b(fit|load|run|set(?:\s+up)?|open|plan|simulate|add|remove|change|save|export|delete|try|compare|use|switch|free|fix|apply|search|find|look\s+(?:\w+\s+)?up|lookup|go to|navigate|attach)\b(?!\s+(?:by|from|in|with)\s+(?:the|this)\s+(?:site|code|model))/i.test(String(text).replace(/^\s*\S+/, ''));

/** The analyzer's tools (toolspec.js): the ones a question must not use to change the analysis. */
const ANALYSIS_TOOLS = new Set(TOOL_SPECS.map((t) => t.name));

export const NOT_RUN = /\b(?:do not|don['’]?t|without|no need to|not yet|before you)\s+(?!forget|hesitate)(?:\w+\s+){0,2}?(?:run(?:ning)?|start(?:ing)?|launch(?:ing)?)\b/i;
const CHARS_PER_TOKEN = 3.2;
const hashOf = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + s.length; };
const cutText = (s, n) => (s.length > n ? s.slice(0, n) + `… [${s.length - n} chars cut by the harness]` : s);
/** A result as it is stored for the prompt: cut to n characters, the whole kept (up to 200k) for read_result. */
const storeResult = (id, name, text, n) => (text.length > n ? { id, name, text: text.slice(0, n) + `… [${text.length - n} more characters: read_result {"id": "${id}", "offset": ${n}}]`, full: text.slice(0, 200000) } : { id, name, text });

/**
 * createAgent(config) -> { send(text), resume(), stop(), reset(), configure(patch), turns, info() }
 * config: { base, model, apiKey, tools (createTools result), fetch, onEvent(ev), confirm({ name, args, reason }) -> Promise<bool>,
 *           maxSteps = 12, contextLimit (tokens; null = unknown, treated as 8192), maxTokens = 1500, temperature = 0.2,
 *           protocol = 'auto' | 'native' | 'text', stream = true, primer = PRIMER }
 * Events: user, assistant_delta { text }, assistant { text, final }, tool_start { id, name, args }, tool_progress { id, text },
 *         tool_end { id, name, ok, text, ms, denied }, note { text }, context { tokens, limit, trimmed }, cap { steps },
 *         halt { halt }, error { message }, done { steps, seconds, reason: 'answered' | 'cap' | 'stopped' | 'error' | 'navigate' }
 */
export function createAgent(config) {
  const cfg = { maxSteps: 12, maxTokens: 3000, temperature: 0.2, protocol: 'auto', stream: true, primer: PRIMER, contextLimit: null, apiKey: '', historyBudget: HISTORY_BUDGET, tiers: true, ...config };
  const f = cfg.fetch || globalThis.fetch.bind(globalThis), emit = (ev) => { try { cfg.onEvent && cfg.onEvent(ev); } catch { /* a listener's problem */ } };
  let tools = cfg.tools;
  // what the server turned out to support; each flag is dropped once, on the server's own refusal
  const cap = { native: cfg.protocol !== 'text', stream: cfg.stream !== false, usage: true };
  const turns = [];            // { user, steps: [{ content, calls: [{ id, name, args }], results: [{ id, name, text }] }], final, summary, notes: [] }
  let abort = null, busy = false, callSeq = 0, ratio = CHARS_PER_TOKEN, lastUsage = null, trimmedNote = '';
  const active = new Set();    // tools of the page beyond the core ones that this conversation has asked for or used

  const limit = () => cfg.contextLimit || 8192;
  const level = () => (limit() < 9000 ? 2 : limit() < 20000 ? 1 : 0);
  const isCore = (t) => t.core || (level() === 2 ? TINY_TOOLS : CORE_TOOLS).includes(t.name) || t.name === 'navigate';
  /** The page's tools split into those shown and those listed under more_tools (a long tool list is tiered). */
  function tiers() {
    const all = tools.specs, tier = cfg.tiers !== false && (level() === 2 || JSON.stringify(all).length > TIER_CHARS);
    if (!tier) return { shown: all, hidden: [] };
    return { shown: all.filter((t) => isCore(t) || active.has(t.name)), hidden: all.filter((t) => !isCore(t) && !active.has(t.name)) };
  }
  const anyCut = () => turns.some((t) => t.steps.some((s) => s.results.some((r) => r.full)));
  const specs = () => { const l = level(), { shown, hidden } = tiers(), s = [...shown, ...(anyCut() ? [READ_RESULT] : []), ...(hidden.length ? [moreToolsSpec(hidden, l === 2)] : [])]; return l ? slimSpecs(s, l).map((t) => (t.name === 'more_tools' ? { ...t, description: moreToolsSpec(hidden, l === 2).description } : t)) : s; };
  const names = () => [...tools.specs.map((t) => t.name), READ_RESULT.name, 'more_tools'];
  const historyBudget = () => (cfg.historyBudget > 0 ? cfg.historyBudget : Math.floor(limit() * 0.5));
  const resultCap = () => Math.round(Math.min(6000, Math.max(1200, (Math.min(historyBudget(), limit() * 0.5) * ratio) / 6)));
  const budgetTokens = () => Math.max(1500, Math.floor(limit() * 0.85) - cfg.maxTokens - 200);
  /** The harness's own tools, answered here: no page is involved. */
  function harnessCall(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (name === 'read_result') {
      const id = String(a.id || '').trim(), hit = turns.flatMap((t) => t.steps.flatMap((s) => s.results)).find((r) => r.id === id || r.id === 'call_' + id.replace(/^call_?/, ''));
      if (!hit) return { ok: false, text: `ERROR: there is no tool result "${id}". The ids are those named in a cut result, like "call_7".` };
      const full = hit.full || hit.text, off = Math.max(0, Math.floor(Number(a.offset) || 0)), n = Math.max(200, Math.min(20000, Math.floor(Number(a.max_chars) || 4000))), part = full.slice(off, off + n);
      return { ok: true, text: JSON.stringify({ id: hit.id, tool: hit.name, characters: `${off} to ${off + part.length} of ${full.length}`, text: part, read_on: off + part.length < full.length ? `read_result {"id": "${hit.id}", "offset": ${off + part.length}}` : undefined }) };
    }
    const { hidden } = tiers(), want = [].concat(a.names || a.name || []).map(String), known = want.filter((n) => tools.specs.some((t) => t.name === n)), unknown = want.filter((n) => !known.includes(n));
    for (const n of known) active.add(n);
    const defs = !cap.native ? textProtocol(tools.specs.filter((t) => known.includes(t.name))).split('\n').filter((l) => l.startsWith('- ')).join('\n') : undefined;
    return { ok: known.length > 0 || !want.length, text: JSON.stringify({ added: known.length ? known : undefined, unknown: unknown.length ? unknown : undefined, available: !want.length || unknown.length ? hidden.map((t) => t.name) : undefined, definitions: defs, note: known.length ? 'Their definitions are now in your tool list: call them.' : 'Give names from the list.' }) };
  }

  // ---- building the prompt -------------------------------------------------------------------------------------
  const turnSummary = (t) => t.summary || `The user asked: "${cutShort(t.user, 160)}". ` + (t.steps.length ? `Tools used: ${t.steps.flatMap((s) => s.calls.map((c, i) => `${c.name}${(s.results[i] && /^(ERROR|DENIED)/.test(s.results[i].text)) ? ' (failed)' : ''}`)).join(', ')}. ` : '') + (t.final ? `You answered: "${cutShort(t.final, 260)}"` : 'No answer was given.');
  const cutShort = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

  /** The message list for the next request. `plan` says how much of the history to keep whole. */
  function build(plan) {
    const text = !cap.native, sp = specs(), primer = level() === 2 ? cfg.primer.replace(/\n\nRECIPES\n[\s\S]*?(?=\n\nKeep answers short)/, '').replace(/\n\nMETHODS AND EQUATIONS\n[\s\S]*?(?=\n\nANALYZE PAGE)/, '') : cfg.primer;   // a very small window gets the rules without the recipes and the methods notes
    const msgs = [{ role: 'system', content: primer + (text ? '\n\n' + textProtocol(sp) : '') }];
    const kept = turns.slice(plan.dropTurns), gone = turns.slice(0, plan.dropTurns);
    const older = gone.length > 8 ? gone.length - 8 : 0;
    let preface = gone.length ? `[Earlier in this conversation, summarised by the app]\n${older ? `(${older} earlier request${older > 1 ? 's' : ''} before these; what they produced is in PROJECT.)\n` : ''}${gone.slice(older).map((t, i) => `${older + i + 1}. ${turnSummary(t)}`).join('\n')}\n[End of summary]\n\n` : '';
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
    const last = msgs[msgs.length - 1], cur = kept[kept.length - 1], card = tools.stateCard(); cardChars = card.length; lastCard = card;
    if (last.role === 'user' && cur && !cur.steps.length && last.content.endsWith(cur.user)) last.content = last.content.slice(0, last.content.length - cur.user.length) + card + '\n\nTHE USER\'S REQUEST:\n' + cur.user;
    else last.content = (last.content ? last.content + '\n\n' : '') + card + (cur ? `\n\nThe user's request, for reference: "${cutShort(cur.user, 400)}"` : '');
    return { msgs, sp, fixedChars: msgs[0].content.length + cardChars + (cap.native ? JSON.stringify(openAITools(sp)).length : 0) };
  }
  let cardChars = 0, lastCard = '';   // lastCard: the state card of the latest request, kept with the step it produced (export)
  const sizeOf = ({ msgs, sp }) => Math.ceil((msgs.reduce((a, m) => a + (m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 12, 0) + (cap.native ? JSON.stringify(openAITools(sp)).length : 0)) / ratio);
  /** The prompt, cut down step by step until it fits the budget: older results to a line, then oldest turns to a summary, then older steps of this request. */
  function fitPrompt() {
    const plan = { shrink: false, keepRecent: 2, dropTurns: 0, dropSteps: 0 };
    let p = build(plan), n = sizeOf(p), how = '';
    // the conversation may take historyBudget tokens besides the fixed part (primer, tools, state), and the whole must fit the context
    const fixed = Math.ceil(p.fixedChars / ratio), budget = Math.min(budgetTokens(), fixed + historyBudget());
    if (n > budget) { plan.shrink = true; p = build(plan); n = sizeOf(p); how = 'older tool results shortened'; }
    while (n > budget && plan.dropTurns < turns.length - 1) { plan.dropTurns++; p = build(plan); n = sizeOf(p); how = `${plan.dropTurns} earlier request${plan.dropTurns > 1 ? 's' : ''} summarised`; }
    const cur = turns[turns.length - 1];
    while (n > budget && cur && plan.dropSteps < cur.steps.length - 2) { plan.dropSteps++; p = build(plan); n = sizeOf(p); how = (plan.dropTurns ? `${plan.dropTurns} earlier requests summarised, ` : '') + `${plan.dropSteps} earlier step${plan.dropSteps > 1 ? 's' : ''} of this request summarised`; }
    if (how !== trimmedNote) emit({ type: 'context', tokens: n, limit: limit(), budget, history: historyBudget(), trimmed: how });
    trimmedNote = how;
    return { ...p, tokens: n, fixed, budget, plan };
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
  async function complete(signal, maxTokens = cfg.maxTokens, answerOnly = false) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = fitPrompt();
      // the answer's room: at most a quarter of a known context window (an 8k server gets 2k), never under 800
      const room = limit() ? Math.min(maxTokens, Math.max(800, Math.floor(limit() / 4))) : maxTokens;
      const body = { model: cfg.model, messages: p.msgs, temperature: cfg.temperature, max_tokens: room };
      // answerOnly: the tools stay in the prompt (it stays cached) but the model may not call one: it must answer
      if (cap.native) { body.tools = openAITools(p.sp); body.tool_choice = answerOnly ? 'none' : 'auto'; }
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
        emit({ type: 'usage', estimate: p.tokens, fixed: p.fixed, budget: p.budget, tools: p.sp.length, prompt_tokens: out.usage ? out.usage.prompt_tokens : null, completion_tokens: out.usage ? out.usage.completion_tokens : null });
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
    turn.seen = turn.seen || {};
    const t0 = Date.now(), signal = abort.signal; let halt = null, steps = 0, nudged = false, emptyRetry = false, lastKey = '', lastText = '', repeats = 0;
    const end = (reason) => { emit({ type: 'done', steps, seconds: (Date.now() - t0) / 1000, reason, usage: lastUsage }); return reason; };
    try {
      for (;;) {
        if (signal.aborted) return end('stopped');
        if (steps >= cfg.maxSteps) { turn.capped = true; emit({ type: 'cap', steps }); return end('cap'); }
        let out = await complete(signal, cfg.maxTokens, !!turn.forceAnswer);
        if (out.finish === 'length' && !out.content && !out.calls.length) out = await complete(signal, cfg.maxTokens * 2);   // it ran out of room while thinking
        steps++;
        let calls = out.calls.map((c) => { let args = {}; try { args = c.arguments ? JSON.parse(c.arguments) : {}; } catch { args = c.arguments; } return { name: c.name, args }; }), content = out.content || '';
        if (!calls.length && content) { const p = parseTextCalls(content, names()); if (p.calls.length) { calls = cap.native ? p.calls : p.calls.slice(0, 1); content = p.rest; } }
        if (!calls.length) {
          if (!content.trim() && !emptyRetry) { emptyRetry = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: '[From the app, not the user] Your last reply was empty. Call a tool, or answer the user.' }); continue; }
          // a promise instead of an action ("I will now load…"): ask once for the action itself
          if (!nudged && !turn.steps.length && content.length < 600 && /\b(i will|i'll|let me|i am going to|i'm going to|first,? i)\b/i.test(content) && !/\?\s*$/.test(content.trim())) { nudged = true; (turn.notes = turn.notes || []).push({ after: 0, text: `[From the app, not the user] You wrote: "${cutShort(content, 200)}" but called no tool. Do it now: call the tool.` }); continue; }
          // an answer that ends by promising the next action ("I'll generate the figure next."): once, do it or stop promising
          const tail = content.trim().split(/(?<=[.!])\s+/).slice(-1)[0] || '';
          if (!nudged && turn.steps.length && /\b(i will|i'll|let me|i am going to|i'm going to)\b/i.test(tail) && !/\?\s*$/.test(tail) && !/\b(if you|would you|let me know|happy to)\b/i.test(tail)) { nudged = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: `[From the app, not the user] Your answer ends with "${cutShort(tail, 160)}", but that was not done. Do it now with a tool call, then give the whole answer again; or answer without promising it.` }); continue; }
          // a figure the user asked for and no figure made in this request: once, make it
          const wantsFig = /\b(figure|plot|graph|chart)\b/i.test(turn.user) && !/\b(no|without|don'?t (?:need|want))\s+(?:a\s+|any\s+)?(figure|plot|graph)/i.test(turn.user), hasFig = tools.specs.some((t) => t.name === 'get_figure');
          // a request with several parts (fit, explain, search for another signal, report) and an answer that skips some:
          // once, name the parts that were asked for and not done. Small models tend to stop after the fit.
          if ((turn.listChecked || 0) < 2 && turn.steps.length) {
            const done = new Set(turn.steps.flatMap((st) => st.calls.map((c, k) => (st.results[k] && !/^(ERROR|DENIED)/.test(st.results[k].text) ? c.name : null)).filter(Boolean)));
            const missing = REQUEST_PARTS.filter((r) => r.asked.test(turn.user) && r.tools.some((n) => names().includes(n)) && !r.tools.some((n) => done.has(n)));
            // a second reminder only when the first got something done (fewer parts missing than then)
            if (missing.length && (!turn.listChecked || missing.length < turn.listMissing)) { turn.listChecked = (turn.listChecked || 0) + 1; turn.listMissing = missing.length; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: `[From the app, not the user] The request also asked for: ${missing.map((r) => `${r.what} (${r.tools.find((n) => names().includes(n))})`).join('; ')}. None of these was done yet. Do them now, one tool call at a time, then give the whole answer; if one cannot be done, say why.` }); emit({ type: 'note', text: `The request also asked for ${missing.map((r) => r.what).join(', ')}: the assistant was asked to do ${missing.length > 1 ? 'them' : 'it'}.` }); continue; }
          }
          if (wantsFig && hasFig && !turn.figChecked && turn.steps.length && !turn.steps.some((st) => st.results.some((r) => r.name === 'get_figure' && !/^(ERROR|DENIED)/.test(r.text)))) { turn.figChecked = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: '[From the app, not the user] The user asked for a figure and none was made in this request. Call get_figure now (which "light_curve" unless another plot was asked for), then give the whole answer again.' }); emit({ type: 'note', text: 'The request asked for a figure and none was made: the assistant was asked to make it.' }); continue; }
          // an answer that names a file nobody wrote ("I saved session.json"): one chance to write it or take the claim back
          const have = tools.fileNames ? tools.fileNames().map((n) => n.toLowerCase()) : null;
          const ghost = have ? [...new Set((content.match(/[\w][\w.()-]*\.(?:json|md|csv|py|tex|png|txt|yaml)\b/gi) || []).filter((n) => !have.includes(n.toLowerCase())))] : [];
          if (ghost.length && !turn.fileChecked && turn.steps.length) { turn.fileChecked = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: `[From the app, not the user] Your answer mentions ${ghost.join(', ')}, but no such file exists (files: ${have.join(', ') || 'none'}). If you meant to give the user that file, write it now with export_file or write_file; otherwise answer again without claiming it.` }); emit({ type: 'note', text: `The answer mentioned ${ghost.join(', ')}, which does not exist; the assistant was asked to write it or correct itself.` }); continue; }
          if (ghost.length && turn.fileChecked) emit({ type: 'note', text: `Check: the answer below mentions ${ghost.join(', ')}, but no such file was written.` });
          // the numbers of a draft answer against the tool results: once, the model gets the exact list to put right and
          // writes the answer again (its corrected words are what the user sees and what an export records)
          if (content.trim() && cfg.checkNumbers !== false && !turn.numFixAsked) {
            const pre = checkNumbers(content, numberSources());
            if (!pre.ok) {
              turn.numFixAsked = true;
              const fix = [pre.bare.length ? `quote these with their uncertainties exactly as the tools gave them: ${pre.bare.map((b) => b.full).slice(0, 12).join('; ')}` : '', pre.unsupported.length ? `these numbers are in no tool result, so remove them or use the tool's own value: ${pre.unsupported.slice(0, 12).join(', ')}` : ''].filter(Boolean).join('. Also ');
              (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: `[From the app, not the user] Before your answer goes to the user, ${fix}. Write the whole answer again with those corrections and nothing else changed, as if it were your first answer: do not mention this correction, and do not call tools.\n\nYour draft:\n${cutText(content.trim(), 3000)}` });
              emit({ type: 'note', text: 'The draft answer quoted numbers that differ from the tool results: the assistant was asked to correct them.' });
              turn.forceAnswer = true; continue;
            }
          }
          // a corrected answer that announces itself ("Here's the corrected answer:"): the announcement goes, the answer stays
          if (turn.numFixAsked) content = content.replace(/^\s*(?:\*\*)?(?:(?:ok(?:ay)?|sure|done)[,.!]?\s*)?(?:here(?:'s| is) (?:the |my |your )?(?:corrected|revised|updated|fixed|rewritten|amended)[^\n:]*:?|corrected answer:?)(?:\*\*)?\s*(?:---\s*)?/i, '');
          turn.modelFinal = content.trim();   // the model's own words, before the app adds its table (export)
          const extra = content.trim() && cfg.checkNumbers !== false ? numberCheck(content, turn) : '';
          if (extra) { content = content.trim() + extra; emit({ type: 'note', text: 'The answer quoted numbers that differ from the tool results (or dropped an uncertainty): the app\'s own table was added under it.' }); }
          if (out.reasoning) turn.finalReasoning = out.reasoning;
          turn.finalState = lastCard;   // what the model saw (export)
          turn.final = content.trim() || '(The model returned an empty answer.' + (cap.native ? ')' : ' With the JSON-in-text tool protocol this happens when the server strips the model\'s own tool-call syntax: if the server supports tool calling, let the assistant use it.)');
          emit({ type: 'assistant', text: turn.final, final: true });
          return end('answered');
        }
        // the model's reasoning is kept with its step (for the conversation export: training data needs it); it is not sent back
        const step = { content: content.trim(), calls: [], results: [], state: lastCard, ...(out.reasoning ? { reasoning: out.reasoning } : {}) };
        turn.steps.push(step);
        if (step.content) emit({ type: 'assistant', text: step.content, final: false });
        for (const c of calls) {
          const id = 'call_' + (++callSeq), key = c.name + ' ' + JSON.stringify(c.args);
          step.calls.push({ id, name: c.name, args: c.args });
          emit({ type: 'tool_start', id, name: c.name, args: c.args });
          const t1 = Date.now(); let text, ok = false, denied = false, data, table = '';
          if (signal.aborted) text = 'ERROR: stopped by the user before this call ran.';
          else if ((turn.seen[key] || {}).n >= 2 && turn.seen[key].gen === (turn.gen || 0)) text = `ERROR: this exact call was already made ${turn.seen[key].n} times in this request with the same result, and nothing has changed since. Do not make it again: use its result, or answer the user with what you have.`;
          else if (key === lastKey && repeats >= 1) text = `ERROR: this exact call was just made ${repeats + 1} times with the same result:\n${cutText(lastText, 300)}\nDo not repeat it. Use the result, try something different, or answer the user.`;
          else if (c.name === READ_RESULT.name || c.name === 'more_tools') { const r = harnessCall(c.name, c.args); ok = r.ok; text = r.text; }
          else {
            const reason = tools.confirmFor(c.name, typeof c.args === 'object' && c.args ? c.args : {}), spec = tools.specs.find((t) => t.name === c.name);
            if (spec) active.add(c.name);   // a tool the model called directly stays shown
            // only the analysis is protected: page tools (the planner's dates, the sky view's target) change what is shown, and
            // answering a question about them needs them
            if (spec && !spec.readOnly && ANALYSIS_TOOLS.has(c.name) && isQuestionOnly(turn.user)) { text = `ERROR: the user asked a question ("${cutShort(turn.user, 80)}"), so nothing should be changed: do not call ${c.name}. Answer from what the read-only tools and the Methods (explain_method) give.`; }
            else if (spec && spec.long && NOT_RUN.test(turn.user)) { text = `ERROR: the user asked not to run a fit in this request ("${cutShort((turn.user.match(NOT_RUN) || [''])[0], 60)}"). The set-up is all that was asked: do not call ${c.name}; finish and say the fit was not run.`; }
            else
            // one "no" stands for the rest of the request: the user is not asked again, and a second attempt ends the request
            if (reason && turn.denied) { denied = true; turn.deniedTwice = true; text = 'DENIED: the user already declined this in the current request.'; }
            else if (reason && cfg.confirm && !(await cfg.confirm({ id, name: c.name, args: c.args, reason }))) { denied = true; turn.denied = true; text = 'DENIED: the user declined this action. Do not retry it or try another way to do the same thing. Tell the user it was not done and ask what they would like instead.'; }
            else {
              const r = await tools.call(c.name, c.args, { signal, onProgress: (p) => emit({ type: 'tool_progress', id, progress: p }), request: turn.user });   // request: the user's words, for tools that check the model's reading of them
              ok = r.ok; text = r.text; data = r.data; if (r.table) table = r.table; if (r.halt) halt = r.halt;
              // the arguments as they ran (repaired by the tool layer, e.g. a list written as one escaped string): what the
              // model sees in its history from now on, and what a training export records
              if (r.args && typeof r.args === 'object' && !Array.isArray(r.args)) step.calls[step.calls.length - 1].args = r.args;
            }
          }
          if (!/^ERROR: this exact call/.test(text)) {
            // the same call with the same result, with nothing changed in between, counts towards the guard above
            const was = turn.seen[key], gen = turn.gen || 0, hash = hashOf(text); turn.seen[key] = was && was.hash === hash && was.gen === gen ? { n: was.n + 1, hash, gen } : { n: 1, hash, gen };
            const sp = tools.specs.find((t) => t.name === c.name); if (ok && sp && !sp.readOnly) turn.gen = gen + 1; turn.seen[key].gen = turn.gen || 0;
            repeats = key === lastKey && text === lastText ? repeats + 1 : 0; lastKey = key; lastText = text; }
          step.results.push({ ...storeResult(id, c.name, text, c.name === READ_RESULT.name ? 21000 : resultCap()), ...(table ? { table: cutText(table, 2400) } : {}) });
          emit({ type: 'tool_end', id, name: c.name, args: c.args, ok, denied, text, data, ms: Date.now() - t1 });
          // a model that keeps sending a call the guard has already refused is stuck: three in a row end the request
          turn.blocked = /^ERROR: this exact call/.test(text) ? (turn.blocked || 0) + 1 : 0;
          if (halt || turn.blocked >= 3) break;   // halt: the page is about to change, nothing more runs here
        }
        // going round in circles: a run of calls that read, or failed, with nothing changed. Once a nudge to answer, then the next request
        // is sent with tool_choice "none" so the model has to write the answer from what it has read
        for (let k = 0; k < step.calls.length; k++) { const sp = tools.specs.find((t) => t.name === step.calls[k].name), r = step.results[k]; turn.reads = (sp && sp.readOnly) || step.calls[k].name === READ_RESULT.name || step.calls[k].name === 'more_tools' || /^(ERROR|DENIED)/.test(r ? r.text : '') ? (turn.reads || 0) + 1 : 0; }   // a refused or failed call changes nothing either: only a successful change resets the count
        if (turn.reads >= 6 && !turn.readNudged) { turn.readNudged = true; (turn.notes = turn.notes || []).push({ after: turn.steps.length, text: '[From the app, not the user] You have read enough to answer: the results above hold what the request needs. Answer the user now, without calling more tools, unless something the request asks for has not been done at all.' }); emit({ type: 'note', text: 'The assistant kept reading: it was asked to answer from what it has.' }); }
        else if (turn.reads >= 9 && turn.readNudged && cap.native) turn.forceAnswer = true;
        if (turn.blocked >= 3 && cap.native && !turn.forceAnswer) { turn.forceAnswer = true; turn.blocked = 0; emit({ type: 'note', text: 'The assistant was repeating a refused call: it was asked to answer from what it has.' }); }
        if (turn.blocked >= 3) { const last = step.calls[step.calls.length - 1]; turn.final = `I got stuck: I kept repeating the same ${last ? last.name.replace(/_/g, ' ') : 'call'} call without making progress, so I stopped. The last real result is in the steps above. Tell me how to go on, or rephrase the request.`; emit({ type: 'note', text: 'The assistant repeated a refused call three times in a row: the request was stopped (the steps it had left were not used).' }); emit({ type: 'assistant', text: turn.final, final: true }); return end('stuck'); }
        if (halt) { turn.halted = halt; emit({ type: 'halt', halt }); return end(halt.reason || 'halt'); }
        if (turn.deniedTwice) { turn.final = 'I stopped here: you declined that action, so nothing was replaced or deleted. Tell me how you would like to continue.'; emit({ type: 'assistant', text: turn.final, final: true }); return end('answered'); }
      }
    } catch (err) {
      if ((err && err.name === 'AbortError') || signal.aborted) return end('stopped');
      emit({ type: 'error', message: String((err && err.message) || err) });
      return end('error');
    }
  }
  /**
   * The check on a final answer: its numbers against every tool result of the conversation, the live state and the
   * user's words. Returns the text to put under the answer ('' when it passes): the reason and the tools' own tables.
   */
  /** Everything an answer's numbers may come from: the live state, the user's words and every tool result (with its table). */
  const numberSources = () => [tools.stateCard(), ...turns.flatMap((t) => [t.user, ...t.steps.flatMap((s) => s.results.flatMap((r) => [r.text, r.table || '']))])];
  function numberCheck(content, turn) {
    const chk = checkNumbers(content, numberSources()); turn.check = { ok: chk.ok, unsupported: chk.unsupported, bare: chk.bare.map((b) => b.full) };
    if (chk.ok) return '';
    // the tables of this request, newest first; kept: those that add a value quoted without its interval, else the newest
    const all = [], seen = new Set(), tables = [], left = new Set(chk.bare.map((b) => b.full));
    for (const s of [...turn.steps].reverse()) for (const r of [...s.results].reverse()) if (r.table && !seen.has(r.name)) { seen.add(r.name); all.push(r.table); }
    for (const t of all) { const adds = [...left].filter((f) => t.includes(f)); if (adds.length && tables.length < 2) { tables.push(t); adds.forEach((f) => left.delete(f)); } }
    if (!tables.length && all.length) tables.push(all[0]);
    return appendix(chk, tables);
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
    resume() { const turn = turns[turns.length - 1]; if (!turn) throw new Error('nothing to continue'); turn.capped = false; turn.halted = null; turn.blocked = 0; return run(turn); },
    stop() { if (abort) abort.abort(); },
    reset() { turns.length = 0; trimmedNote = ''; active.clear(); },
    /** Put back a conversation saved on another page (plain data: the turns as `turns` holds them). */
    restore(saved) { turns.length = 0; for (const t of saved || []) turns.push({ notes: [], steps: [], ...t }); for (const t of turns) for (const s of t.steps) for (const c of s.calls) { const n = Number(String(c.id).replace('call_', '')); if (n > callSeq) callSeq = n; if (c.name !== 'more_tools' && c.name !== READ_RESULT.name) active.add(c.name); } trimmedNote = ''; },
    /**
     * A tool call made by the app itself as a step of the current request (what a page change promised to do on
     * arrival): it runs, is drawn and is recorded like any other, so the model reads its result at the next step.
     */
    async runTool(name, args = {}) {
      const turn = turns[turns.length - 1]; if (!turn) throw new Error('no request to add a step to');
      const id = 'call_' + (++callSeq), t1 = Date.now(), step = { content: '', calls: [{ id, name, args }], results: [] };
      turn.steps.push(step); emit({ type: 'tool_start', id, name, args });
      const r = await tools.call(name, args, {});
      step.results.push({ ...storeResult(id, name, r.text, resultCap()), ...(r.table ? { table: cutText(r.table, 2400) } : {}) });
      emit({ type: 'tool_end', id, name, args, ok: r.ok, denied: false, text: r.text, data: r.data, ms: Date.now() - t1 });
      return r;
    },
    /** Change the tool set (a new page). */
    setTools(next) { tools = next; },
    configure(patch) { Object.assign(cfg, patch); if (patch.protocol) cap.native = patch.protocol !== 'text'; if (patch.base || patch.model) { cap.native = cfg.protocol !== 'text'; cap.stream = cfg.stream !== false; cap.usage = true; } },
    info: () => ({ busy, native: cap.native, stream: cap.stream, contextLimit: limit(), known: !!cfg.contextLimit, historyBudget: historyBudget(), tools: specs().length, hidden: tiers().hidden.length, promptTokens: turns.length ? fitPromptQuiet() : 0, usage: lastUsage, resultCap: resultCap() }),
    /** The exact messages the next request would carry (for the panel's "what is sent" view and the tests). */
    preview: () => fitPrompt(),
  };
  function fitPromptQuiet() { const e = cfg.onEvent; cfg.onEvent = null; try { return fitPrompt().tokens; } finally { cfg.onEvent = e; } }
}
