// The model servers the set-up card offers before "Custom…", and the diagnosis of a connection to one.
//
// PRESETS is the only place in the site where a model server's address is written: LM Studio on this computer, the
// one preset the public site ships (test/assistant.test.mjs fails on any other address, anywhere). Any other server
// (vLLM, Ollama, llama.cpp, a hosted API, your own machine over a VPN) is entered as Custom and remembered.
// No key is written here or anywhere else: a server that needs one gets it from the user.
//
// Browsers decide what a page may call, and a failed call says only "Failed to fetch". diagnose() and
// testConnection() turn the page's address, the browser and the outcome of a few small requests into one plain
// sentence of what is wrong and what to do. No DOM; fetch and the page address are passed in, so Node tests run it.

export const PRESETS = [
  { id: 'lmstudio', label: 'LM Studio on this computer', base: 'http://localhost:1234/v1', kind: 'LM Studio',
    about: 'LM Studio\'s local server (Developer tab, Start server, port 1234), with "Enable CORS" switched on in its server settings.' },
];
export const CUSTOM = 'custom';
export const DEFAULT_PRESET = PRESETS[0].id;
export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;
const strip = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
/** The preset a base URL is, or 'custom'. */
export const presetOf = (base) => (PRESETS.find((p) => strip(p.base) === strip(base)) || { id: CUSTOM }).id;

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|[^/:]+\.localhost)$/i;
/** 'safari' | 'chromium' | 'firefox' | 'other', from a user-agent string. */
export function browserOf(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const u = String(ua || '');
  if (/Firefox\/|FxiOS\//.test(u)) return 'firefox';
  if (/Chrome\/|Chromium\/|CriOS\/|Edg\//.test(u)) return 'chromium';
  if (/Safari\//.test(u) && /Version\//.test(u)) return 'safari';
  return 'other';
}

export const HELP = {
  mixed: (host) => `This page is served over https, and browsers do not let an https page call a plain http address on another machine (${host}): it is blocked as "mixed content" before it leaves the browser. Three ways round it: run the site on your own computer (npm run dev, or any static server on the built site) and open it over http://localhost; put the model server behind https (a reverse proxy with a certificate, or "tailscale serve" on the server); or use the MCP server in mcp/ from a desktop client instead of this chat.`,
  safari: 'Safari does not let an https page call http://localhost (it blocks it as mixed content, unlike Chrome and Firefox). Open this site in Chrome, Edge or Firefox, or run the site on your own computer and open it over http://localhost.',
  lmstudioCors: 'In LM Studio open the Developer tab (Local Server), switch on "Enable CORS" in the server settings, and make sure the server is started on port 1234. Then press Test connection again.',
  pna: 'Chrome may also ask whether this site may "access other apps and services on this device" or "devices on your local network": choose Allow. If you blocked it before, click the icon left of the address bar, open Site settings and allow Local network access, then reload the page.',
  cors: (kind) => `The server answers, but it does not allow calls from web pages (CORS). ${kind === 'LM Studio' ? 'In LM Studio: Developer tab, server settings, switch on "Enable CORS".' : kind === 'Ollama' ? 'For Ollama: set OLLAMA_ORIGINS to this site\'s address (or *) and restart it.' : 'vLLM and llama.cpp allow it by default; with vLLM check --allowed-origins, with a proxy check that it passes the CORS headers and answers OPTIONS requests.'}`,
};

/**
 * What can be said before anything is sent: is the call blocked by the browser outright, and what to expect.
 * -> { ok, base, kind: 'invalid' | 'mixed' | 'safari' | 'loopback' | 'plain', blocked, message, browser }
 */
export function diagnose(base, { pageUrl = typeof location !== 'undefined' ? location.href : '', userAgent } = {}) {
  let b, p = null; const browser = browserOf(userAgent);
  try { b = new URL(base); if (!/^https?:$/.test(b.protocol)) throw new Error('scheme'); } catch { return { ok: false, base, kind: 'invalid', blocked: true, browser, message: 'That is not a web address. A model server\'s address looks like http://host:port/v1.' }; }
  try { p = new URL(pageUrl); } catch { p = null; }
  const https = !!p && p.protocol === 'https:', loop = LOOPBACK.test(b.hostname), plain = b.protocol === 'http:';
  if (https && plain && !loop) return { ok: false, base, kind: 'mixed', blocked: true, browser, message: HELP.mixed(b.host) };
  if (https && plain && loop && browser === 'safari') return { ok: false, base, kind: 'safari', blocked: true, browser, message: HELP.safari };
  if (loop) return { ok: true, base, kind: 'loopback', blocked: false, browser, message: https && browser === 'chromium' ? 'An https page may call this computer\'s localhost in Chrome, but the server must allow it (CORS), and Chrome may ask you to allow local network access.' : '' };
  return { ok: true, base, kind: 'plain', blocked: false, browser, message: '' };
}

const timeout = (ms, f, url, init = {}) => {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null, t = ac ? setTimeout(() => ac.abort(), ms) : null;
  return f(url, { ...init, ...(ac ? { signal: ac.signal } : {}) }).finally(() => t && clearTimeout(t));
};
const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'TimeoutError');

/**
 * Test a server the way the assistant will use it: list the models (a simple GET), then one tiny chat request
 * (a POST with a JSON body, which makes the browser send a CORS preflight first). When a call fails without an
 * answer, a no-cors probe tells "nothing is listening" from "it answers but CORS refuses the page".
 * -> { ok, kind, message, models: [{ id, context }], model, ms, steps: [text] }
 *   kind: ok | invalid | mixed | safari | unreachable | timeout | cors | preflight | auth | not_openai | no_models | http
 */
export async function testConnection(base, { apiKey = '', model = '', fetch: f = globalThis.fetch, pageUrl, userAgent, listModels, ms = 8000, kindName } = {}) {
  const pre = diagnose(base, { pageUrl, userAgent }), steps = [], t0 = Date.now();
  const preset = PRESETS.find((p) => strip(p.base) === strip(base)), kind = kindName || (preset ? preset.kind : '');
  const host = (() => { try { return new URL(base).host; } catch { return base; } })(), loop = pre.kind === 'loopback';
  const done = (o) => ({ models: [], model: '', ms: Date.now() - t0, steps, ...o });
  if (pre.blocked) return done({ ok: false, kind: pre.kind, message: pre.message });
  const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
  const https = (() => { try { return new URL(pageUrl || (typeof location !== 'undefined' ? location.href : '')).protocol === 'https:'; } catch { return false; } })();
  const unreachable = () => (loop
    ? (https && pre.browser !== 'firefox'
      ? `The browser could not reach ${host}. From an https page Chrome lets a site reach this computer only with your permission ("Local network access"), and blocks it when the prompt was dismissed or denied. ${HELP.pna} If it is allowed, check that the server is started (in LM Studio: Developer tab, Start server, port 1234) with "Enable CORS" on.`
      : `Nothing answered at ${host}. Start the server (in LM Studio: Developer tab, Start server, port 1234) and check the port. ${pre.browser === 'chromium' ? HELP.pna : ''}`.trim())

      : `Nothing answered at ${host}. Check that the server is running, the address and port, and any firewall or VPN in between.`);
  /** A call that failed without an answer: is anything listening? (an opaque no-cors answer means yes) */
  async function why(e, what) {
    if (isAbort(e)) return { kind: 'timeout', message: `${host} did not answer ${what} within ${Math.round(ms / 1000)} s. ${loop ? 'Is the server started?' : 'Is the VPN connected and the server running? A large model may also still be loading.'}` };
    let listening = false;
    try { await timeout(4000, f, base + '/models', { mode: 'no-cors', credentials: 'omit' }); listening = true; } catch { listening = false; }
    if (!listening) return { kind: 'unreachable', message: unreachable() };
    return null;
  }
  // 1. the model list
  let res;
  try { res = await timeout(ms, f, base + '/models', { headers, credentials: 'omit' }); }
  catch (e) {
    const w = await why(e, 'the request for its models');
    if (w) return done({ ok: false, ...w });
    return done({ ok: false, kind: 'cors', message: HELP.cors(kind) + (loop && kind === 'LM Studio' ? ' ' + HELP.lmstudioCors : '') + (loop && pre.browser === 'chromium' ? ' ' + HELP.pna : '') });
  }
  if (res.status === 401 || res.status === 403) return done({ ok: false, kind: 'auth', message: `${host} refused the request (HTTP ${res.status}): it wants an API key, or the key is wrong.` });
  if (res.status === 404) return done({ ok: false, kind: 'not_openai', message: `${base}/models answered "not found" (HTTP 404): this is not an OpenAI-compatible base URL. It usually ends in /v1.` });
  if (!res.ok) return done({ ok: false, kind: 'http', message: `${host} answered HTTP ${res.status} to the request for its models.` });
  let models;
  try { models = listModels ? await listModels(base, { apiKey, fetch: f }) : null; } catch (e) { return done({ ok: false, kind: 'not_openai', message: String(e.message || e) }); }
  if (!models) { const j = await res.json().catch(() => null), list = j && (j.data || j.models); models = Array.isArray(list) ? list.map((m) => ({ id: m.id || m.name, context: m.max_model_len || m.context_length || null })).filter((m) => m.id) : null; }
  if (!models) return done({ ok: false, kind: 'not_openai', message: `${base}/models did not answer with a model list: is this an OpenAI-compatible base URL? It usually ends in /v1.` });
  if (!models.length) return done({ ok: false, kind: 'no_models', message: `${host} answers but lists no model: load one in it first${kind === 'LM Studio' ? ' (LM Studio: Developer tab, select a model to load)' : ''}.` });
  steps.push(`listed ${models.length} model${models.length > 1 ? 's' : ''}`);
  // LM Studio's OpenAI list says nothing of context or which model is loaded; its own REST list does
  if (models.every((m) => !m.context)) {
    try {
      const r = await timeout(3000, f, new URL(base).origin + '/api/v0/models', { headers, credentials: 'omit' }), j = r.ok ? await r.json() : null, info = new Map(((j && j.data) || []).map((m) => [m.id, m]));
      if (info.size) models = models.map((m) => { const x = info.get(m.id); return x ? { ...m, context: x.loaded_context_length || x.max_context_length || null, loaded: x.state === 'loaded' } : m; });
    } catch { /* not LM Studio */ }
  }
  const use = models.some((m) => m.id === model) ? model : (models.find((m) => m.loaded) || models[0]).id;
  // 2. one tiny chat request: the POST the assistant makes, with its preflight
  const t1 = Date.now();
  try {
    const r = await timeout(Math.max(ms, 30000), f, base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, credentials: 'omit', body: JSON.stringify({ model: use, messages: [{ role: 'user', content: 'Reply with the word ready.' }], max_tokens: 4, temperature: 0 }) });
    if (r.status === 401 || r.status === 403) return done({ ok: false, kind: 'auth', models, model: use, message: `${host} lists its models but refused a chat request (HTTP ${r.status}): it wants an API key, or the key is wrong.` });
    if (!r.ok) { const body = String(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200); return done({ ok: false, kind: 'http', models, model: use, message: `${host} lists its models, but a chat request to ${use} failed (HTTP ${r.status}). ${body}` }); }
    steps.push(`a chat request to ${use} answered in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  } catch (e) {
    if (isAbort(e)) return done({ ok: false, kind: 'timeout', models, model: use, message: `${host} lists its models, but ${use} did not answer a one-word request within 30 s: it may still be loading.` });
    return done({ ok: false, kind: 'preflight', models, model: use, message: `${host} lists its models, but the browser blocked the chat request: the server does not answer the browser's CORS preflight (an OPTIONS request) for it. ${kind === 'LM Studio' || loop ? HELP.lmstudioCors : HELP.cors(kind)}${loop && pre.browser === 'chromium' ? ' ' + HELP.pna : ''}` });
  }
  return done({ ok: true, kind: 'ok', models, model: use, message: `Connected to ${host}: ${models.length} model${models.length > 1 ? 's' : ''}; ${steps[1]}.` });
}
