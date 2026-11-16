// What the assistant remembers between pages of the site: its settings, the conversation, a request that was
// interrupted by a page change (so it can carry on where it arrives), and the files of the conversation.
//
//   settings      localStorage. The API key is NOT written there unless the user ticks "remember": otherwise it
//                 lives in sessionStorage, which the browser drops when the tab closes (it has to survive a page
//                 change inside the site, or the assistant could not continue after navigating).
//   conversation  localStorage, capped in size: the agent's turns, the events the panel draws, the action log.
//   files         IndexedDB (attachments and files the assistant wrote, text or binary).
//   project       localStorage: the project as the tool results told it (project.js), carried across pages and
//                 conversations until the user clears it.
//
// The only addresses known here are the presets of presets.js: on first use the default one is preselected, and
// afterwards what the user chose (and the last server and model that answered) is remembered. Storage objects can
// be passed in, which is how the Node tests run this without a browser.

import { PRESETS, DEFAULT_PRESET, presetById, presetOf } from './presets.js';
import { HISTORY_BUDGET } from './agent.js';
import { emptyProject } from './project.js';

export const KEYS = { settings: 'esl.assistant.v2', chat: 'esl.assistant.chat.v1', key: 'esl.assistant.key', project: 'esl.assistant.project.v1' };
const MAX_CHAT = 1.2e6, MAX_LOG = 400, PENDING_MAX_AGE = 3 * 60 * 1000;
const DEFAULTS = { preset: DEFAULT_PRESET, base: presetById(DEFAULT_PRESET).base, model: '', context: null, maxSteps: 14, askConfirm: true, rememberKey: false, apiKey: '', historyBudget: HISTORY_BUDGET, lastGood: null };
export { PRESETS };

const read = (st, k) => { try { return JSON.parse(st.getItem(k)); } catch { return null; } };
const write = (st, k, v) => { try { st.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export function createStore({ local = globalThis.localStorage, session = globalThis.sessionStorage, idb = globalThis.indexedDB, now = () => Date.now() } = {}) {
  const mem = { getItem: () => null, setItem() {}, removeItem() {} };
  local = local || mem; session = session || mem;

  // ---- settings ------------------------------------------------------------------------------------------------
  function loadSettings() {
    const s = { ...DEFAULTS, ...(read(local, KEYS.settings) || {}) };
    if (!s.base) { s.preset = DEFAULT_PRESET; s.base = presetById(DEFAULT_PRESET).base; }   // never chosen: the default preset
    s.preset = presetOf(s.base);
    if (!(s.historyBudget > 0)) s.historyBudget = HISTORY_BUDGET;
    if (!s.rememberKey) { s.apiKey = ''; try { s.apiKey = session.getItem(KEYS.key) || ''; } catch { /* no session storage */ } }
    return s;
  }
  function saveSettings(s) {
    const { apiKey, ...rest } = s;
    write(local, KEYS.settings, s.rememberKey ? s : rest);
    try { if (s.rememberKey || !apiKey) session.removeItem(KEYS.key); else session.setItem(KEYS.key, apiKey); } catch { /* no session storage */ }
  }

  // ---- conversation --------------------------------------------------------------------------------------------
  const slimEvent = (ev) => { const { data, progress, ...e } = ev; if (typeof e.text === 'string' && e.text.length > 2500) e.text = e.text.slice(0, 2500) + '…'; return e; };
  /** { turns, log, actions, open, pending, allowAll }; an old pending request is dropped (the user has moved on). */
  function loadChat() {
    const c = read(local, KEYS.chat) || {};
    const out = { turns: Array.isArray(c.turns) ? c.turns : [], log: Array.isArray(c.log) ? c.log : [], actions: Array.isArray(c.actions) ? c.actions : [], open: !!c.open, pending: c.pending || null, allowAll: !!c.allowAll };
    if (out.pending && !(now() - out.pending.at < PENDING_MAX_AGE)) out.pending = null;
    return out;
  }
  /** Save the conversation; when it is too large for the storage, the oldest requests go first. Returns false when nothing could be written. */
  function saveChat(c) {
    const out = { turns: c.turns || [], log: (c.log || []).filter((e) => e.type !== 'assistant_delta' && e.type !== 'tool_progress').slice(-MAX_LOG).map(slimEvent), actions: (c.actions || []).slice(-60), open: !!c.open, pending: c.pending || null, allowAll: !!c.allowAll };
    for (let i = 0; i < 40; i++) {
      const text = JSON.stringify(out);
      if (text.length <= MAX_CHAT) { try { local.setItem(KEYS.chat, text); return true; } catch { /* over quota: cut further */ } }
      if (out.turns.length > 1) out.turns = out.turns.slice(1); else if (out.log.length > 20) out.log = out.log.slice(Math.ceil(out.log.length / 2)); else break;
    }
    return false;
  }
  function clearChat() { try { local.removeItem(KEYS.chat); } catch { /* nothing to clear */ } }
  /** Cheap look, for the page's start-up: is a request waiting to continue, or was the panel left open? */
  function peek() { const c = read(local, KEYS.chat); return c ? { pending: !!(c.pending && now() - c.pending.at < PENDING_MAX_AGE), open: !!c.open } : { pending: false, open: false }; }

  // ---- files ---------------------------------------------------------------------------------------------------
  let dbp = null;
  const db = () => (dbp ||= new Promise((resolve) => {
    if (!idb) return resolve(null);
    try {
      const req = idb.open('esl-assistant', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('files', { keyPath: 'name' }); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null); req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  }));
  const tx = async (mode, fn) => { const d = await db(); if (!d) return null; return new Promise((resolve) => { try { const t = d.transaction('files', mode), r = fn(t.objectStore('files')); t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : true); t.onerror = () => resolve(null); t.onabort = () => resolve(null); } catch { resolve(null); } }); };
  const files = {
    all: async () => (await tx('readonly', (s) => s.getAll())) || [],
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    remove: (name) => tx('readwrite', (s) => s.delete(name)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };

  // ---- project -------------------------------------------------------------------------------------------------
  const loadProject = () => ({ ...emptyProject(), ...(read(local, KEYS.project) || {}) });
  const saveProject = (p) => write(local, KEYS.project, p);
  const clearProject = () => { try { local.removeItem(KEYS.project); } catch { /* nothing to clear */ } };

  return { loadSettings, saveSettings, loadChat, saveChat, clearChat, peek, files, loadProject, saveProject, clearProject };
}
