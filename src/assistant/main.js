// The assistant's chat window: a small panel that opens from the bubble at the bottom right of every page of
// the site (src/site/nav.js mounts the bubble and fetches this chunk the first time it is needed). It talks to a
// language model the user chooses (any OpenAI-compatible server: one of the presets of presets.js, the first
// preselected, or an address the user types) and operates the page
// through tools: the analyzer through window.__esl.api, the other pages through the few actions each declares in
// window.__esl.<page>, and `navigate` between them. The conversation, its files and the settings are kept in
// this browser, so a request can start on one page and finish on another.
//
// This file is the DOM. The loop is agent.js, the tools are pages.js and tools.js, what is remembered is store.js.

import './assistant.css';
import { createTools, memoryFiles } from './tools.js';
import { createSiteTools, pageOf, PAGES } from './pages.js';
import { createAgent, listModels, normalizeBase, describeError, SERVER_KINDS, HISTORY_BUDGET, PRIMER } from './agent.js';
import { createStore } from './store.js';
import { PRESETS, CUSTOM, presetById, presetOf, diagnose, testConnection } from './presets.js';
import { updateProject, projectCard, emptyProject } from './project.js';
import { fitsHeaderText } from './ops.js';
import { mathSegments, mathHtml } from './mathtext.js';
import { toTrainingRecord, toJsonl, fromTrainingRecord, FORMAT } from './sft.js';

const STARTERS = {
  home: ['Plan tonight\'s transits from Kitt Peak', 'Open the single-transit example and fit it', 'What has this site been validated against?'],
  plan: ['Which transits can I observe tonight from Kitt Peak?', 'Plan the next transits of WASP-43 b, then open the best one in the sky view', 'Only planets brighter than magnitude 11, deeper than 10 ppt'],
  observe: ['Show WASP-43 b and play the night', 'Where is Jupiter right now?'],
  photometry: ['What frames are loaded?', 'Run the reduction and send the light curve to Analyze'],
  analyze: ['Fit the transit in the file I attached', 'Compare a circular and an eccentric orbit', 'What do these results mean?', 'Load the single-transit example and run the fit'],
  search: ['Transiting planets with periods under 2 days, brightest first', 'Show WASP-43 b with its references, then plan it'],
  validation: ['How well does the transit model agree with batman?', 'What does the page say about the sampler?'],
};
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (v === null || v === undefined || v === false) continue; if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k in e && typeof v !== 'string') e[k] = v; else e.setAttribute(k, v === true ? '' : v); }
  e.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return e;
};
const el = (tag, cls, ...kids) => h(tag, cls ? { class: cls } : {}, ...kids);
const saveFile = (name, data) => { const a = h('a', { href: URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'text/plain' })), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
const blobFromDataUrl = async (url) => (await fetch(url)).blob();

let panel = null;
/** Called by the bubble (nav.js): build the panel once; open or close it, or (auto) carry on what was left. */
export function mountPanel({ root, launcher, auto = false } = {}) {
  if (!panel) panel = build({ root, launcher });
  if (auto) panel.autoStart(); else panel.toggle();
  return panel;
}
/** The analyzer's own "Assistant" button opens the same panel. */
export function openAssistant({ root } = {}) {
  if (!panel) panel = build({ root: root || new URL(document.querySelector('meta[name=esl-root]')?.content || './', document.baseURI), launcher: document.getElementById('esl-ai-launch') });
  panel.show();
  return panel;
}

function build({ root, launcher }) {
  root = new URL(root, document.baseURI);
  const store = createStore(), S = store.loadSettings(), chat = store.loadChat(), page = pageOf(location.href, root);
  let models = [], agent = null, working = false, allowAll = chat.allowAll, site = null, toolsKey = null, pending = chat.pending, navigateTo = null, seenAction = 0, project = store.loadProject(), autoTested = false, testing = false;
  const log = chat.log.slice();     // every event the panel drew, for the transcript, the next page and the headless checks
  const acts = chat.actions.slice(); // what the assistant changed: { page, name, summary, at, undone }

  // ---- what the tools need from the page ------------------------------------------------------------------------
  const fetchJson = async (name) => { const r = await fetch(new URL('catalog/' + name, root)); if (!r.ok) throw new Error(`The parameter catalog could not be read (${name}: HTTP ${r.status}).`); return r.json(); };
  const FIG = { light_curve: '#lccanvas', corner: '#corner', oc: '#occanvas', periodogram: '#pgcanvas', limb_darkening: '#ldcanvas' };
  const hooks = {
    /** The rendered "Runs & model comparison" table of the Results tab: the page's own reading of the evidences. */
    comparison() {
      const tb = document.querySelector('#tab-results table.res.cmp'); if (!tb) return null;
      const runs = [...tb.querySelectorAll('tbody tr')].map((tr) => {
        const td = tr.children, first = td[0].cloneNode(true), small = first.querySelector('small'), law = small ? small.textContent : ''; if (small) small.remove();
        const m = /^#(\d+)\s*(.*)$/.exec(first.textContent.trim()) || [], al = td[3].querySelector('.alarm'), n = al ? Number((al.textContent.match(/\d+/) || [0])[0]) : 0; const rd = td[3].cloneNode(true); if (rd.querySelector('.alarm')) rd.querySelector('.alarm').remove();
        return { id: Number(m[1]), name: m[2] || '', law, lnZ: td[1].textContent.trim(), delta: td[2].textContent.trim() === '—' ? '' : td[2].textContent.trim(), reading: rd.textContent.trim(), nCautions: n };
      }).filter((r) => r.id);
      const wrap = tb.closest('.tablewrap'), callout = wrap && wrap.nextElementSibling, notes = [...document.querySelectorAll('#tab-results p.note')];
      return { runs, verdict: callout && callout.classList.contains('callout') ? callout.textContent.trim() : '', cautions: [...document.querySelectorAll('#tab-results details.cautions p.note')].map((p) => p.textContent.trim()),
        note: (notes.map((p) => p.textContent).find((t) => /Δ ln Z is the log Bayes factor/.test(t)) || '').replace(/^Click a row to bring that run back\.\s*/, '') };
    },
    /** A figure of the page as a PNG blob, on the page's dark background; null when it is not drawn. */
    figure(which) {
      const cv = document.querySelector(FIG[which]); if (!cv || !cv.width || !cv.height) return Promise.resolve(null);
      const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
      const g = out.getContext('2d'); g.fillStyle = '#0b0f18'; g.fillRect(0, 0, out.width, out.height); g.drawImage(cv, 0, 0);
      return new Promise((res) => out.toBlob((b) => res(b), 'image/png'));
    },
  };
  const files = memoryFiles({ onWrite: (f) => { store.files.put({ name: f.name, text: f.text, blob: f.blob && f.size < 60e6 ? f.blob : null, size: f.size, origin: f.origin, mime: f.mime, about: f.about }); drawFiles(); if (f.origin === 'written' && f.blob && /^image\//.test(f.mime || '')) { onEvent({ type: 'figure', name: f.name }); } } });

  /** Is what this page offers the assistant there yet? (the analyzer and the page modules set it up as they load) */
  // errors the page itself throws: when its tools never appear, the model is told why instead of guessing
  const pageErrors = [];
  window.addEventListener('error', (e) => { if (pageErrors.length < 3) pageErrors.push(`a script error: ${String((e && e.message) || e).slice(0, 120)}`); });
  window.addEventListener('unhandledrejection', (e) => { if (pageErrors.length < 3) pageErrors.push(`a script error: ${String((e && e.reason && e.reason.message) || (e && e.reason) || '').slice(0, 120)}`); });
  const pageReady = () => { const E = window.__esl || {}; return page === 'home' || PAGES[page].noTools ? true : page === 'analyze' ? !!E.api : !!(E[page] && (!E[page].ready || E[page].ready())); };
  function buildTools() {
    const E = window.__esl || {}, api = page === 'analyze' ? E.api || null : null, pageApi = page !== 'analyze' && page !== 'home' ? E[page] || null : null;
    const key = (api ? 'a' : '-') + (pageApi ? 'p' + (pageApi.tools || []).length : '-'), offKey = (S.disabledTools || []).join(',');
    if (site && key === toolsKey) { if (site.offKey !== offKey) { site = gate(site.raw); if (agent) agent.setTools(site); } return site; }
    const analyzer = api ? createTools({ api, files, page: hooks, fetchJson, where: 'browser', blobFromDataUrl, planned: () => project.planned && project.planned.mid_bjd_tdb, siteProject: () => { try { return (window.__esl && window.__esl.project && window.__esl.project.get()) || null; } catch { return null; } }, reduction: () => { try { return JSON.parse(localStorage.getItem('esl.reduction.last') || 'null'); } catch { return null; } } }) : null;
    site = gate(createSiteTools({ page, root: root.href, analyzer, analyzerApi: api, pageApi, files, project: () => project, pageProblem: () => pageErrors[0] || '' })); toolsKey = key; seenAction = 0;
    if (site.problems.length) console.warn('assistant: tool declarations of this page', site.problems);
    if (agent) agent.setTools(site);
    return site;
  }
  /**
   * The tools the user switched off (Settings, Tools; kept in the settings, so on every page) are taken out of what
   * the model is offered, and a call to one is refused with a sentence saying so. `all` keeps the full list for the card.
   */
  function gate(raw) {
    const off = new Set(S.disabledTools || []), o = Object.create(raw);
    o.raw = raw; o.offKey = (S.disabledTools || []).join(','); o.all = raw.specs; o.specs = raw.specs.filter((t) => !off.has(t.name)); o.names = o.specs.map((t) => t.name);
    o.call = (name, args, opts) => (off.has(name) ? Promise.resolve({ ok: false, args, text: `ERROR: the user switched the tool "${name}" off in the assistant's settings. Do the step another way, or tell the user it is off (Settings, Tools).` }) : raw.call(name, args, opts));
    return o;
  }
  /** Wait (up to `ms`) for the page to be ready for the assistant, then make sure the tools are those of this page. */
  async function ensureTools(ms = 0) { const t0 = Date.now(); while (!pageReady() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150)); return buildTools(); }

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const msgs = el('div', 'ai-msgs'), filesRow = el('div', 'ai-files'), status = el('div', 'ai-status'), logBox = el('div', 'ai-log'), settings = el('div', 'ai-settings');
  msgs.setAttribute('aria-live', 'polite'); msgs.setAttribute('role', 'log'); settings.hidden = true; logBox.hidden = true; status.setAttribute('role', 'status');
  const input = h('textarea', { class: 'ai-input', rows: 2, placeholder: 'Ask for something: set this page up, run a fit, try two models…', 'aria-label': 'Message to the assistant' });
  const sendBtn = h('button', { class: 'ai-btn primary ai-send', type: 'button', onclick: () => submit() }, 'Send');
  const stopBtn = h('button', { class: 'ai-btn danger ai-stop', type: 'button', hidden: true, title: 'Stop the assistant (and a fit it is running)', onclick: () => agent && agent.stop() }, 'Stop');
  const fileInput = h('input', { type: 'file', class: 'ai-file', multiple: true, hidden: true, onchange: (e) => { attach(e.target.files); e.target.value = ''; } });
  const attachBtn = h('button', { class: 'ai-chip ai-attach', type: 'button', title: 'Attach files: light curves, velocities, timing lists (CSV or text), session files (JSON), FITS images. They stay in this browser.', 'aria-label': 'Attach files', onclick: () => fileInput.click() },
    h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/></svg>' }), ' Attach');
  const ICON = {
    cog: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 7.5V12l3 2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };
  // header: Actions, Settings (cog) and New (+); the model and the tools are chosen inside Settings
  const setBtn = h('button', { class: 'ai-chip ai-icon ai-setbtn', type: 'button', title: 'Settings: model server, model and the tools the assistant may use', 'aria-label': 'Settings', 'aria-expanded': 'false', onclick: () => toggleSettings() }, h('span', { html: ICON.cog }));
  const logBtn = h('button', { class: 'ai-chip', type: 'button', title: 'What the assistant did, with undo', 'aria-expanded': 'false', onclick: () => toggleLog() }, 'Actions');
  const histBtn = h('button', { class: 'ai-chip ai-icon', type: 'button', title: 'History: past conversations, to open again or export (also as training data)', 'aria-label': 'Conversation history', 'aria-expanded': 'false', onclick: () => toggleHistory() }, h('span', { html: ICON.clock }));
  const histBox = h('div', { class: 'ai-log ai-history', hidden: true });
  const importInput = h('input', { type: 'file', class: 'ai-import', accept: '.jsonl,.json,application/json', hidden: true, onchange: (e) => { importHistory(e.target.files[0]); e.target.value = ''; } });
  const root_ = h('section', { class: 'ai-panel', id: 'assistant', role: 'dialog', 'aria-label': 'Assistant', hidden: true },
    el('div', 'ai-head', el('span', 'ai-title', 'Assistant'), h('span', { class: 'ai-page', title: 'The page the assistant is operating' }, page), el('span', 'ai-grow'), logBtn, histBtn, setBtn,
      h('button', { class: 'ai-chip ai-icon', type: 'button', title: 'New conversation (the page and the files are kept)', 'aria-label': 'New conversation', onclick: () => newChat() }, h('span', { html: ICON.plus })),
      h('button', { class: 'ai-chip ai-icon ai-close', type: 'button', 'aria-label': 'Close the assistant', title: 'Close (Esc)', onclick: () => hide() }, '✕')),
    settings, logBox, histBox, importInput, msgs, status, filesRow,
    el('div', 'ai-compose', input, el('div', 'ai-actions', attachBtn, fileInput, el('span', 'ai-grow'), stopBtn, sendBtn)));
  document.body.append(root_);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  root_.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!settings.hidden && S.base && S.model) toggleSettings(false); else hide(); } });
  root_.addEventListener('dragover', (e) => { e.preventDefault(); root_.classList.add('drop'); });
  root_.addEventListener('dragleave', () => root_.classList.remove('drop'));
  root_.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); root_.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) attach(e.dataTransfer.files); });

  // ---- settings: the set-up card ----------------------------------------------------------------------------------
  // A preset (or "Custom…" with an address), an optional key, "Test connection" with a diagnosis in plain words,
  // the model list of that server, and the budgets. The default preset is preselected and tested on first opening.
  function drawSettings(msg = '', cls = '') {
    settings.innerHTML = '';
    const choice = S.preset && S.preset !== CUSTOM && presetById(S.preset) ? S.preset : CUSTOM;
    const pick = h('select', { class: 'ai-preset', 'aria-label': 'Model server' }, ...PRESETS.map((p) => h('option', { value: p.id, selected: p.id === choice }, p.label)), h('option', { value: CUSTOM, selected: choice === CUSTOM }, 'Custom…'));
    const base = h('input', { type: 'url', class: 'ai-base', value: choice === CUSTOM ? S.base : presetById(choice).base, placeholder: 'base URL of your server, ends in /v1', 'aria-label': 'Model server address', spellcheck: 'false', autocomplete: 'off', inputmode: 'url', readOnly: choice !== CUSTOM });
    const about = h('p', { class: 'ai-note ai-about' }, choice === CUSTOM ? 'Any server that speaks the OpenAI chat protocol: ' + SERVER_KINDS.join(', ') + ', or a hosted one.' : presetById(choice).about);
    const key = h('input', { type: 'password', class: 'ai-key', value: S.apiKey || '', placeholder: 'only if the server asks for one', 'aria-label': 'API key', autocomplete: 'off' });
    const sel = h('select', { class: 'ai-modelsel', 'aria-label': 'Model' }, ...(models.length ? models.map((m) => h('option', { value: m.id, selected: m.id === S.model }, m.id + (m.context ? ` · ${Math.round(m.context / 1000)}k context` : ''))) : [h('option', { value: S.model || '' }, S.model || 'press Test connection to list the models')]));
    const ctx = h('input', { type: 'number', class: 'ai-ctx', value: S.context || '', placeholder: 'from the server', min: 2000, step: 1000, 'aria-label': 'Context window in tokens' });
    const hist = h('input', { type: 'number', class: 'ai-hist', value: S.historyBudget || HISTORY_BUDGET, min: 1000, max: 200000, step: 500, 'aria-label': 'History budget in tokens', title: 'How many tokens the conversation itself may take in each request; older requests are summarised beyond it.' });
    const steps = h('input', { type: 'number', class: 'ai-steps', value: S.maxSteps, min: 1, max: 60, 'aria-label': 'Steps before asking to continue' });
    const ask = h('input', { type: 'checkbox', checked: S.askConfirm !== false }), remember = h('input', { type: 'checkbox', checked: !!S.rememberKey });
    const out = h('p', { class: 'ai-test ' + cls, role: 'status' }, msg), pre = h('p', { class: 'ai-test bad ai-mixed', hidden: true });
    const testBtn = h('button', { class: 'ai-btn primary ai-testbtn', type: 'button', onclick: () => test() }, 'Test connection');
    const warn = () => { const d = diagnose(normalizeBase(base.value)); pre.hidden = !d.blocked || d.kind === 'invalid' || !base.value.trim(); pre.textContent = d.blocked ? d.message : ''; pre.dataset.kind = d.kind; };
    const read = () => { S.preset = pick.value; S.base = normalizeBase(pick.value === CUSTOM ? base.value : presetById(pick.value).base); S.apiKey = key.value.trim(); S.model = sel.value || S.model; S.context = Number(ctx.value) > 0 ? Number(ctx.value) : null; S.historyBudget = Math.max(1000, Number(hist.value) || HISTORY_BUDGET); S.maxSteps = Math.max(1, Math.min(60, Number(steps.value) || 14)); S.askConfirm = ask.checked; S.rememberKey = remember.checked; };
    async function test() {
      if (testing) return; read(); warn();
      if (!S.base) { out.className = 'ai-test bad'; out.textContent = 'Type the address of your model server first: its OpenAI-compatible base URL, which usually ends in /v1.'; return; }
      testing = true; testBtn.disabled = true; out.className = 'ai-test'; out.textContent = `Testing ${S.base}…`;
      const r = await testConnection(S.base, { apiKey: S.apiKey, model: S.model, listModels }).catch((e) => ({ ok: false, kind: 'error', message: String(e.message || e), models: [] }));
      testing = false; models = r.models || [];
      if (r.ok || models.length) { if (!models.some((m) => m.id === S.model)) S.model = r.model || models[0].id; const m = models.find((x) => x.id === S.model); if (m && m.context) S.context = m.context; }
      if (r.ok) S.lastGood = { preset: S.preset, base: S.base, model: S.model, at: Date.now() };
      apply();
      const m = models.find((x) => x.id === S.model);
      drawSettings(r.ok ? `${r.message} Using ${S.model}${m && m.context ? ` (${m.context} tokens of context)` : ' (context size not reported: 8192 assumed; set it below if you know it)'}.` + (S.context && S.context < 8000 ? ' That context is small for an assistant with tools: 16k or more works best.' : '') : r.message, r.ok ? 'ok' : 'bad');
    }
    pick.addEventListener('change', () => { const p = presetById(pick.value); models = []; S.preset = pick.value; if (p) { S.base = p.base; S.model = S.lastGood && S.lastGood.base === p.base ? S.lastGood.model : ''; } apply(); drawSettings(); if (p) test(); else setTimeout(() => settings.querySelector('.ai-base')?.focus(), 30); });
    sel.addEventListener('change', () => { read(); const m = models.find((x) => x.id === S.model); S.context = m && m.context ? m.context : null; if (S.lastGood && S.lastGood.base === S.base) S.lastGood = { ...S.lastGood, model: S.model }; apply(); drawSettings(); });
    for (const x of [ctx, hist, steps, ask, remember, key]) x.addEventListener('change', () => { read(); apply(); });
    base.addEventListener('input', warn);
    base.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); test(); } });
    const good = S.lastGood && S.lastGood.base === S.base ? `Last worked ${new Date(S.lastGood.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} with ${S.lastGood.model}.` : '';
    settings.append(
      h('p', { class: 'ai-lead' }, S.model ? 'The language model the assistant uses.' : 'The assistant needs a language model: choose a server (the first is preselected) and press Test connection.'),
      el('label', 'ai-field', el('span', '', 'Server'), pick), about,
      el('label', 'ai-field' + (choice === CUSTOM ? '' : ' ai-readonly'), el('span', '', 'Address'), base), pre,
      el('label', 'ai-field', el('span', '', 'API key'), key),
      el('label', 'ai-check', remember, ' remember the key in this browser (otherwise it is forgotten when this tab closes)'),
      el('div', 'ai-row', testBtn, out),
      ...(good && !msg ? [h('p', { class: 'ai-note ai-lastgood' }, good)] : []),
      el('label', 'ai-field', el('span', '', 'Model'), sel),
      el('div', 'ai-row', el('label', 'ai-field small', el('span', '', 'Context (tokens)'), ctx), el('label', 'ai-field small', el('span', '', 'History budget'), hist), el('label', 'ai-field small', el('span', '', 'Steps per request'), steps)),
      el('label', 'ai-check', ask, ' ask me before the assistant replaces loaded data or deletes a saved analysis'),
      h('p', { class: 'ai-note' }, 'A model with tool calling and a context of 16k tokens or more works best. The history budget is how much of each request the conversation may take before older requests are summarised (6000 suits a 16k to 32k model). The address and the key are kept in this browser only and are sent nowhere but to that server.'),
      toolsCard(),
      el('div', 'ai-row', h('button', { class: 'ai-btn ai-done', type: 'button', onclick: () => { read(); apply(); toggleSettings(false); } }, 'Done')));
    warn();
    if (!autoTested && !S.model && !msg) { autoTested = true; setTimeout(test, 0); }   // first use: test the preselected server at once
  }
  // ---- the tools this page offers, grouped, each with a switch -----------------------------------------------------
  const GROUP_LABEL = { site: 'Moving between pages', system: 'System and catalogue', data: 'Data', fit: 'Fitting', results: 'Results and experiments', timing: 'Timing', view: 'View', export: 'Reports and exports', saves: 'Saved analyses', files: 'Files', analyzer: 'Archives and set-up', plan: 'Plan page', observe: 'Observe page', photometry: 'Photometry page', spectroscopy: 'Spectroscopy page', search: 'Search page', methods: 'Methods page' };
  function toolsCard() {
    let all = []; try { all = (buildTools().all || []); } catch { all = []; }
    const off = new Set(S.disabledTools || []), on = all.filter((t) => !off.has(t.name)).length;
    const box = h('details', { class: 'ai-tools' }, h('summary', {}, `Tools on this page: ${on} of ${all.length} on`));
    if (!all.length) { box.append(h('p', { class: 'ai-note' }, 'This page has not offered its tools yet (it may still be loading).')); return box; }
    box.append(h('p', { class: 'ai-note' }, 'What the assistant can do here, through the same controls you have. Switch a tool off and the model is not offered it; the choice is kept for every page. Tools marked ✎ change something; the others only read.'));
    const set = (name, v) => { const x = new Set(S.disabledTools || []); if (v) x.delete(name); else x.add(name); S.disabledTools = [...x]; store.saveSettings(S); buildTools(); box.querySelector('summary').textContent = `Tools on this page: ${site.specs.length} of ${all.length} on`; };
    const groups = new Map(); for (const t of all) { const g = t.group || 'other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
    for (const [g, list] of groups) {
      const sec = el('div', 'ai-tgroup', el('div', 'ai-tghead', el('b', '', GROUP_LABEL[g] || g), h('button', { class: 'ai-link', type: 'button', onclick: () => { const anyOn = list.some((t) => !(S.disabledTools || []).includes(t.name) && t.name !== 'navigate'); for (const t of list) if (t.name !== 'navigate') set(t.name, !anyOn); sec.querySelectorAll('input').forEach((c) => { if (!c.disabled) c.checked = !anyOn; }); } }, 'all on / off')));
      for (const t of list) {
        const cb = h('input', { type: 'checkbox', checked: !off.has(t.name), disabled: t.name === 'navigate', onchange: (e) => set(t.name, e.target.checked) });
        sec.append(h('label', { class: 'ai-tool', title: t.description || '' }, cb, el('span', 'ai-tname', t.name.replace(/_/g, ' ') + (t.readOnly ? '' : ' ✎')), el('span', 'ai-tdesc', String(t.description || '').split(/(?<=\.)\s/)[0])));
      }
      box.append(sec);
    }
    return box;
  }
  function toggleSettings(on) { settings.hidden = on === undefined ? !settings.hidden : !on; root_.classList.toggle('setup', !settings.hidden); setBtn.setAttribute('aria-expanded', String(!settings.hidden)); if (!settings.hidden) { logBox.hidden = true; drawSettings(); setTimeout(() => settings.querySelector('input')?.focus(), 30); } else input.focus(); }
  /** Push the settings into the agent (creating it the first time) and remember them. */
  function apply() {
    store.saveSettings(S);
    setBtn.classList.toggle('on', !S.model); setBtn.title = S.model ? `Settings · model ${S.model}` : 'Settings: choose a model first';
    const conf = { base: S.base, model: S.model, apiKey: S.apiKey, contextLimit: S.context, maxSteps: S.maxSteps, historyBudget: S.historyBudget || HISTORY_BUDGET };
    if (!agent) { agent = createAgent({ ...conf, tools: buildTools(), onEvent, confirm }); if (chat.turns.length) agent.restore(chat.turns); }
    else agent.configure(conf);
    drawEmpty();
  }

  // ---- files ----------------------------------------------------------------------------------------------------
  async function attach(list) {
    for (const f of list) {
      if (f.size > 200e6) { say('note', `${f.name} is ${(f.size / 1e6).toFixed(0)} MB: too large to attach.`); continue; }
      const fits = /\.(fits?|fts)$/i.test(f.name), buf = fits || f.size < 30e6 ? await f.arrayBuffer() : null, hdr = buf ? fitsHeaderText(buf) : null;
      if (hdr !== null) { const ob = (/^OBJECT\s*=\s*'([^']*)'/m.exec(hdr) || [])[1], nx = (/^NAXIS1\s*=\s*(\d+)/m.exec(hdr) || [])[1], ny = (/^NAXIS2\s*=\s*(\d+)/m.exec(hdr) || [])[1]; files.add(f.name, hdr, 'attached', { blob: f, size: f.size, mime: 'application/fits', about: `FITS image${nx && ny ? ` ${nx} x ${ny}` : ''}${ob ? `, ${ob.trim()}` : ''}: read_file shows its header` }); continue; }
      if (/\.(fits?|fts)\.(gz|fz)$/i.test(f.name)) { files.add(f.name, '(compressed FITS: the header is read when the photometry page loads it)', 'attached', { blob: f, size: f.size, mime: 'application/fits', about: 'compressed FITS image' }); continue; }
      if (!buf) { say('note', `${f.name} is ${(f.size / 1e6).toFixed(0)} MB: too large for a text file (30 MB at most).`); continue; }
      const text = new TextDecoder().decode(buf);
      if (/\u0000/.test(text.slice(0, 4000))) { say('note', `${f.name} is not a text file. The assistant reads CSV and text light curves, velocities and timing lists, session files (JSON) and FITS images.`); continue; }
      files.add(f.name, text, 'attached');
    }
    drawFiles(); input.focus();
  }
  const sizeText = (n) => (n > 2e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 2048 ? Math.round(n / 1024) + ' kB' : n + ' B');
  function drawFiles() {
    filesRow.innerHTML = '';
    const all = files.list(), made = all.filter((f) => f.origin === 'written');
    if (made.length) filesRow.append(el('span', 'ai-fhead', `Produced (${made.length})`));
    for (const f of [...made, ...all.filter((x) => x.origin !== 'written')]) {
      const rec = files.get(f.name);
      filesRow.append(el('span', 'ai-file ' + f.origin, h('span', { class: 'ai-fname', title: f.about || '' }, f.name), el('small', '', sizeText(f.size)),
        f.origin === 'written' ? h('button', { class: 'ai-dl', type: 'button', title: 'Download ' + f.name, onclick: () => saveFile(f.name, rec.blob || new Blob([rec.text], { type: rec.mime || 'text/plain' })) }, 'Download') : null,
        h('button', { class: 'ai-x', type: 'button', 'aria-label': 'Remove ' + f.name, title: 'Remove from the conversation', onclick: () => { files.remove(f.name); store.files.remove(f.name); drawFiles(); } }, '✕')));
    }
    filesRow.hidden = !filesRow.children.length;
  }

  // ---- conversation ---------------------------------------------------------------------------------------------
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  /** Just enough Markdown for an answer: paragraphs, lists, tables, rules, bold, inline code, fenced code, and TeX ($...$, $$...$$, \\( \\), \\[ \\]) as MathML (mathtext.js). Text is escaped first. */
  function md(text) {
    const inline = (s) => mathSegments(s).map((g) => (g.math ? mathHtml(g, esc) : inlineText(g.text))).join('');
    const inlineText = (s) => esc(s.replace(/\\([*_`#|])/g, (m, c) => `&#${c.charCodeAt(0)};`)).replace(/&amp;#(\d+);/g, '&#$1;').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    const out = []; let list = null, code = null, table = null;
    const endTable = () => { if (table) { out.push('<div class="ai-tw"><table><thead><tr>' + table[0].map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + table.slice(1).map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>'); table = null; } };
    const src = String(text).replace(/\$\$([\s\S]+?)\$\$/g, (m, x) => '$$' + x.replace(/\s*\n\s*/g, ' ') + '$$').replace(/\\\[([\s\S]+?)\\\]/g, (m, x) => '\\[' + x.replace(/\s*\n\s*/g, ' ') + '\\]');
    for (const line of src.split('\n')) {
      if (/^```/.test(line)) { endTable(); if (code) { out.push('<pre>' + esc(code.join('\n')) + '</pre>'); code = null; } else { if (list) { out.push(`</${list}>`); list = null; } code = []; } continue; }
      if (code) { code.push(line); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) { if (list) { out.push(`</${list}>`); list = null; } const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim()); if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; (table = table || []).push(cells); continue; }
      endTable();
      const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line), hd = /^#{1,4}\s+(.*)$/.exec(line), want = li ? (/\d/.test(li[1]) ? 'ol' : 'ul') : null;
      if (list && list !== want) { out.push(`</${list}>`); list = null; }
      if (/^\s*-{3,}\s*$/.test(line)) out.push('<hr>');
      else if (li) { if (!list) { out.push(`<${want}>`); list = want; } out.push('<li>' + inline(li[2]) + '</li>'); }
      else if (hd) out.push('<p class="ai-h">' + inline(hd[1]) + '</p>');
      else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    }
    endTable(); if (code) out.push('<pre>' + esc(code.join('\n')) + '</pre>'); if (list) out.push(`</${list}>`);
    return out.join('');
  }
  const atBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const add = (node) => { const stick = atBottom(); msgs.querySelector('.ai-empty')?.remove(); msgs.append(node); if (stick) msgs.scrollTop = msgs.scrollHeight; return node; };
  function say(kind, text) { return add(h('div', { class: 'ai-msg ' + kind, html: /^assistant/.test(kind) ? md(text) : esc(text).replace(/\n/g, '<br>') })); }
  function drawEmpty() {
    if (msgs.querySelector('.ai-msg, .ai-step, .ai-fig')) return;
    msgs.innerHTML = '';
    const ready = S.base && S.model;
    msgs.append(el('div', 'ai-empty',
      h('p', {}, ready ? `Ask for anything this site can do. The assistant works through the same controls you have, on this page (${page}) and, when a request needs it, on the others; what it changes is listed under Actions and can be undone in the analyzer.` : 'The assistant can set pages up, run fits and experiments, and hand you the files. It needs a language model first: none is built in.'),
      ready ? el('div', 'ai-starters', ...(STARTERS[page] || STARTERS.home).map((t) => h('button', { class: 'ai-chip', type: 'button', onclick: () => { input.value = t; submit(); } }, t))) : h('button', { class: 'ai-btn primary', type: 'button', onclick: () => toggleSettings(true) }, 'Set up a model')));
  }
  function newChat() { if (working) return; archive(); chat.id = null; if (agent) agent.reset(); if (site) site.resetRuns(); chat.turns = []; log.length = 0; acts.length = 0; allowAll = false; pending = null; msgs.innerHTML = ''; status.textContent = ''; drawLog(); drawEmpty(); persist(); drawHistory(); }

  const stepsEl = new Map(); let live = null, timer = null, replaying = false;
  const brief = (args) => { const s = JSON.stringify(args ?? {}); return s === '{}' ? '' : s.length > 80 ? s.slice(0, 80) + '…' : s; };
  function showFigure(name) {
    const rec = files.get(name); if (!rec || !rec.blob) return;
    const url = URL.createObjectURL(rec.blob);
    add(h('figure', { class: 'ai-fig' }, h('img', { src: url, alt: `Figure ${name}`, loading: 'lazy' }), h('figcaption', {}, name, ' · ', h('button', { class: 'ai-dl', type: 'button', onclick: () => saveFile(name, rec.blob) }, 'Download'))));
  }
  function onEvent(ev) {
    if (!replaying && ev.type !== 'assistant_delta' && ev.type !== 'tool_progress') log.push({ t: Date.now(), page, ...ev, data: undefined });
    if (ev.type === 'user') { if (replaying) say('user', ev.text); }
    else if (ev.type === 'assistant_delta') { if (!live) live = say('assistant streaming', ''); live._text = (live._text || '') + ev.text; const stick = atBottom(); live.innerHTML = md(live._text); if (stick) msgs.scrollTop = msgs.scrollHeight; }
    else if (ev.type === 'assistant') { if (live) { live.remove(); live = null; } if (ev.text) say('assistant' + (ev.final ? '' : ' aside'), ev.text); }
    else if (ev.type === 'tool_start') {
      if (live) { live.remove(); live = null; }
      const head = h('summary', {}, el('span', 'ai-dot'), el('b', '', ev.name), el('span', 'ai-args', brief(ev.args)), el('span', 'ai-ms', replaying ? '' : '…'));
      const body = el('div', 'ai-stepbody', el('div', 'ai-k', 'arguments'), h('pre', {}, JSON.stringify(ev.args ?? {}, null, 1)));
      const d = h('details', { class: 'ai-step run' }, head, body); stepsEl.set(ev.id, { d, body, t0: Date.now() }); add(d);
      if (replaying) return;
      status.textContent = `Running ${ev.name}…`;
      clearInterval(timer); timer = setInterval(() => { const s = stepsEl.get(ev.id); if (s && s.d.classList.contains('run')) s.d.querySelector('.ai-ms').textContent = ((Date.now() - s.t0) / 1000).toFixed(0) + ' s'; }, 500);
    } else if (ev.type === 'tool_progress') { const s = stepsEl.get(ev.id), p = ev.progress || {}; if (s && Number.isFinite(p.ncalls)) status.textContent = `${p.variant ? p.variant + ': ' : ''}fitting… ${p.ncalls.toLocaleString('en')} likelihood calls${Number.isFinite(p.logZ) ? `, ln Z ${p.logZ.toFixed(1)}` : ''}`; }
    else if (ev.type === 'tool_end') {
      clearInterval(timer); const s = stepsEl.get(ev.id); if (!s) return;
      s.d.classList.remove('run'); s.d.classList.add(ev.denied ? 'denied' : ev.ok ? 'ok' : 'bad');
      s.d.querySelector('.ai-ms').textContent = ev.denied ? 'declined' : ev.ms < 1000 ? ev.ms + ' ms' : (ev.ms / 1000).toFixed(1) + ' s';
      let pretty = ev.text || ''; try { if (ev.ok) pretty = JSON.stringify(JSON.parse(ev.text), null, 1); } catch { /* plain text */ }
      s.body.append(el('div', 'ai-k', 'result'), h('pre', {}, pretty.length > 6000 ? pretty.slice(0, 6000) + '\n…' : pretty));
      s.d.querySelector('.ai-confirm')?.remove();
      if (replaying) return;
      status.textContent = 'Thinking…';
      // the action log: what this call changed
      const last = site && site.actions[site.actions.length - 1];
      if (ev.ok && last && last.id > seenAction && last.name === ev.name) { seenAction = last.id; acts.push({ page, name: last.name, summary: last.summary || brief(last.args), at: last.at, live: last.id }); drawLog(); }
      // the project as the tool results tell it, for the next request on any page
      const np = updateProject(project, { page, name: ev.name, args: ev.args, data: ev.data, ok: ev.ok }); if (np !== project) { project = np; store.saveProject(project); }
      persist();
    } else if (ev.type === 'figure') showFigure(ev.name);
    else if (ev.type === 'note') say('note', ev.text);
    else if (ev.type === 'context' && ev.trimmed) say('note ctx', `To keep each request within ${ev.budget} tokens (history budget ${ev.history}): ${ev.trimmed}.`);
    else if (ev.type === 'error') say('note bad', ev.message);
    else if (ev.type === 'cap') { if (!replaying) add(el('div', 'ai-msg note cap', `The assistant has taken ${ev.steps} steps on this request. `, h('button', { class: 'ai-btn', type: 'button', onclick: (e) => { e.target.closest('.cap').remove(); go(() => agent.resume()); } }, 'Continue'), ' or send a new message.')); }
    else if (ev.type === 'halt' && ev.halt && ev.halt.reason === 'navigate') { if (!replaying) { navigateTo = ev.halt; pending = { at: Date.now(), page: ev.halt.page, after: ev.halt.after || null }; } say('note nav', `Going to the ${ev.halt.page} page to continue…`); }
    else if (ev.type === 'done') { if (!replaying) { status.textContent = ev.reason === 'stopped' ? 'Stopped.' : ''; persist(); } }
  }
  /** Ask the user before a call that replaces or deletes something. */
  function confirm({ id, name, reason }) {
    if (S.askConfirm === false || (allowAll && name !== 'delete_saved')) return Promise.resolve(true);
    return new Promise((resolve) => {
      const s = stepsEl.get(id), always = h('input', { type: 'checkbox' });
      const done = (yes) => { if (yes && always.checked) allowAll = true; box.remove(); resolve(yes); };
      const allow = h('button', { class: 'ai-btn primary ai-allow', type: 'button', onclick: () => done(true) }, 'Allow');
      const box = el('div', 'ai-confirm', el('p', '', reason), el('div', 'ai-row', allow, h('button', { class: 'ai-btn ai-deny', type: 'button', onclick: () => done(false) }, 'Decline'),
        name === 'delete_saved' ? null : el('label', 'ai-check', always, ' do not ask again in this conversation')));
      box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', 'The assistant asks before going on');
      if (s) { s.d.open = true; s.d.append(box); msgs.scrollTop = msgs.scrollHeight; } else add(box);
      status.textContent = 'Waiting for your answer…'; if (!root_.hidden) allow.focus();
    });
  }
  async function go(fn) {
    working = true; sendBtn.hidden = true; stopBtn.hidden = false; status.textContent = 'Thinking…'; root_.classList.add('busy'); if (launcher) launcher.classList.add('busy');
    let end = null;
    try { end = await fn(); } catch (err) { say('note bad', describeError(err, S.base)); }
    finally { working = false; sendBtn.hidden = false; stopBtn.hidden = true; root_.classList.remove('busy'); if (launcher) launcher.classList.remove('busy'); if (live) { live.remove(); live = null; } if (/Thinking|Running|Waiting|fitting/.test(status.textContent)) status.textContent = ''; }
    if (end === 'navigate' && navigateTo) { persist(); location.assign(navigateTo.url); return; }   // the conversation continues on that page
    pending = null; persist();
  }
  async function submit() {
    const text = input.value.trim(); if (!text || working) return;
    if (!S.base || !S.model) { toggleSettings(true); return; }
    if (!agent) apply();
    input.value = ''; say('user', text);
    go(async () => { await ensureTools(pageReady() ? 0 : 6000); return agent.send(text); });
  }
  function transcript() {
    const out = [`# Assistant conversation`, '', `Model: ${S.model}`, '']; let tok = [];
    for (const ev of log) {
      if (ev.type === 'usage') { tok.push(ev.prompt_tokens || `~${ev.estimate}`); continue; }
      if (ev.type === 'user') out.push(`## You`, '', ev.text, '');
      else if (ev.type === 'assistant') out.push(ev.final ? '## Assistant' : '_Assistant (while working):_', '', ev.text, '');
      else if (ev.type === 'tool_start') out.push(`- **${ev.name}** \`${JSON.stringify(ev.args ?? {})}\`${ev.page ? ` (${ev.page} page)` : ''}`);
      else if (ev.type === 'tool_end') out.push(`  - ${ev.denied ? 'declined' : ev.ok ? 'ok' : 'failed'} in ${ev.ms} ms: \`${ev.text.length > 600 ? ev.text.slice(0, 600) + '…' : ev.text}\``, '');
      else if (ev.type === 'note' || ev.type === 'error') out.push(`> ${ev.text || ev.message}`, '');
      else if (ev.type === 'done') { out.push(`_${ev.reason}: ${ev.steps} model steps, ${ev.seconds.toFixed(1)} s${tok.length ? `; prompt tokens per request ${tok.join(', ')}` : ''}_`, ''); tok = []; }
    }
    return out.join('\n');
  }

  // ---- the action log --------------------------------------------------------------------------------------------
  function drawLog() {
    logBtn.textContent = acts.length ? `Actions (${acts.length})` : 'Actions';
    if (logBox.hidden) return;
    logBox.innerHTML = '';
    const can = !!(site && site.canUndo()) && !working;
    logBox.append(el('div', 'ai-loghead', el('b', '', 'What the assistant did'), h('button', { class: 'ai-btn ai-undo', type: 'button', disabled: !can, title: can ? 'Undo the assistant\'s last change to the analysis' : 'Undo works on changes made to the analysis on this visit to the analyze page', onclick: () => undoLast() }, 'Undo last change'), h('button', { class: 'ai-chip', type: 'button', title: 'Save this conversation, with every tool call and result, as a Markdown file', onclick: () => saveFile('assistant_transcript.md', transcript()) }, 'Save transcript'), h('button', { class: 'ai-chip', type: 'button', 'aria-label': 'Close the list of actions', onclick: () => toggleLog(false) }, '✕')));
    const pj = projectCard(project);
    if (pj) logBox.append(el('details', 'ai-project', h('summary', {}, 'Project, as the assistant knows it on every page'), h('pre', {}, pj.replace(/^PROJECT[^\n]*\n/, '')), h('button', { class: 'ai-chip', type: 'button', title: 'Forget the project (site, planned event, fits); the conversation stays', onclick: () => { project = emptyProject(); store.clearProject(); drawLog(); } }, 'Forget the project')));
    if (!acts.length) { logBox.append(h('p', { class: 'ai-note' }, 'Nothing yet. Every change the assistant makes to a page is listed here; reading and looking things up is not.')); return; }
    const ol = el('ol', 'ai-acts');
    for (const a of [...acts].reverse()) ol.append(h('li', { class: a.undone ? 'undone' : '' }, el('span', 'ai-apage', a.page), el('b', '', a.name.replace(/_/g, ' ')), a.summary ? el('span', 'ai-asum', a.summary) : null, el('time', '', new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), a.undone ? el('em', '', 'undone') : null));
    logBox.append(ol);
  }
  function toggleLog(on) { logBox.hidden = on === undefined ? !logBox.hidden : !on; logBtn.setAttribute('aria-expanded', String(!logBox.hidden)); if (!logBox.hidden) { settings.hidden = true; root_.classList.remove('setup'); toggleHistory(false); } drawLog(); }
  function undoLast() {
    if (!site || working) return;
    const r = site.undoAction(); if (!r.action) return;
    const a = acts.find((x) => x.live === r.action.id); if (a) a.undone = true;
    onEvent({ type: 'note', text: r.ok ? `Undone: ${r.action.name.replace(/_/g, ' ')}${r.action.summary ? ' (' + r.action.summary + ')' : ''}. The analyzer's Redo brings it back.` : `Undo of ${r.action.name.replace(/_/g, ' ')}: ${r.why}.` });
    drawLog(); persist();
  }

  // ---- history: past conversations, kept in this browser (store.history), to open again or export ---------------
  const titleOf = (turns) => { const u = (turns[0] && turns[0].user) || 'Conversation'; return u.length > 80 ? u.slice(0, 79) + '…' : u; };
  /** The open conversation as a history record (nothing when it is empty). */
  function currentRecord() {
    const turns = agent ? agent.turns : chat.turns; if (!turns.length) return null;
    chat.id = chat.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return { id: chat.id, title: titleOf(turns), at: Date.now(), page, model: S.model || '', turns: JSON.parse(JSON.stringify(turns)), log: log.slice(-400), actions: acts.map(({ live: _l, ...a }) => a) };
  }
  let histTimer = 0;
  const archive = () => { const r = currentRecord(); return r ? store.history.put(r) : Promise.resolve(null); };
  const archiveSoon = () => { clearTimeout(histTimer); histTimer = setTimeout(archive, 1500); };
  /** A conversation as one training record (sft.js), with the tool schemas and the primer the assistant uses. */
  function trainingRecord(rec) {
    const info = agent ? agent.info() : {};
    return toTrainingRecord({ turns: rec.turns, primer: PRIMER, specs: buildTools().specs, model: rec.model || S.model, protocol: info.native === false ? 'text' : 'native', page: rec.page, meta: { conversation_id: rec.id, title: rec.title, saved: new Date(rec.at).toISOString() } });
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  async function exportRecords(recs, name) {
    if (!recs.length) return;
    saveFile(name, new Blob([toJsonl(recs.map(trainingRecord))], { type: 'application/x-ndjson' }));
  }
  async function openFromHistory(id) {
    if (working) return;
    const rec = await store.history.get(id); if (!rec) return;
    await archive();
    if (agent) agent.reset(); if (site) site.resetRuns();
    chat.id = rec.id; chat.turns = rec.turns || []; log.length = 0; log.push(...(rec.log || [])); acts.length = 0; acts.push(...(rec.actions || []));
    if (agent) agent.restore(chat.turns);
    msgs.innerHTML = ''; replaying = true; try { for (const ev of log) onEvent(ev); } finally { replaying = false; }
    if (!log.length) for (const t of chat.turns) { say('user', t.user); if (t.final) say('assistant', t.final); }
    drawEmpty(); drawLog(); persist(); toggleHistory(false);
    say('note', `Opened “${rec.title}” from the history. The page itself is as you left it: the conversation's earlier results may describe another analysis.`);
  }
  async function importHistory(file) {
    if (!file) return;
    try {
      const text = await file.text(), lines = text.trim().split(/\n+/).filter(Boolean); let n = 0;
      for (const line of lines) {
        const rec = JSON.parse(line), m = rec.metadata || {}, turns = fromTrainingRecord(rec);
        if (!turns.length) continue;
        await store.history.put({ id: m.conversation_id || `c${Date.now().toString(36)}${n}`, title: m.title || titleOf(turns), at: Date.parse(m.saved || m.created) || Date.now(), page: m.page || page, model: m.model || '', turns, log: [], actions: [] }); n++;
      }
      say('note', n ? `Imported ${n} conversation${n > 1 ? 's' : ''} into the history.` : 'No conversation found in that file: it should be the JSONL the history exports.');
      drawHistory();
    } catch (err) { say('note', `Could not import ${file.name}: ${err.message}`); }
  }
  async function drawHistory() {
    if (histBox.hidden) return;
    await archive();
    const list = await store.history.list();
    histBox.innerHTML = '';
    histBox.append(el('div', 'ai-loghead', el('b', '', 'Past conversations'),
      h('button', { class: 'ai-chip', type: 'button', title: 'Every conversation in one JSONL file: OpenAI-style messages with reasoning and tool calls, and the tool schemas, for supervised fine-tuning (format ' + FORMAT + ')', disabled: !list.length, onclick: async () => exportRecords((await Promise.all(list.map((x) => store.history.get(x.id)))).filter(Boolean), `esl-conversations-${stamp()}.jsonl`) }, 'Export all'),
      h('button', { class: 'ai-chip', type: 'button', title: 'Add conversations from a JSONL file exported here', onclick: () => importInput.click() }, 'Import')));
    if (!list.length) { histBox.append(h('p', { class: 'ai-note' }, 'No conversations yet. Each one is kept here when you start a new one, and can be opened again or exported.')); return; }
    const ol = el('ol', 'ai-acts ai-hlist');
    for (const x of list) {
      const cur = x.id === chat.id;
      ol.append(h('li', { class: cur ? 'cur' : '' },
        h('button', { class: 'ai-hopen', type: 'button', title: cur ? 'The open conversation' : 'Open this conversation', disabled: cur || working, onclick: () => openFromHistory(x.id) }, x.title),
        el('span', 'ai-asum', `${x.requests} request${x.requests === 1 ? '' : 's'} · ${x.page} · ${new Date(x.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${x.model ? ' · ' + x.model : ''}`),
        h('button', { class: 'ai-chip ai-hx', type: 'button', title: 'Download as JSONL training data', onclick: async () => { const r = await store.history.get(x.id); if (r) exportRecords([r], `esl-conversation-${x.id}.jsonl`); } }, 'Export'),
        h('button', { class: 'ai-chip ai-hd', type: 'button', title: cur ? 'Start a new conversation first' : 'Delete from the history', 'aria-label': `Delete “${x.title}”`, disabled: cur, onclick: async () => { await store.history.remove(x.id); drawHistory(); } }, 'Delete')));
    }
    histBox.append(ol);
  }
  function toggleHistory(on) {
    histBox.hidden = on === undefined ? !histBox.hidden : !on; histBtn.setAttribute('aria-expanded', String(!histBox.hidden));
    if (!histBox.hidden) { logBox.hidden = true; logBtn.setAttribute('aria-expanded', 'false'); settings.hidden = true; root_.classList.remove('setup'); drawHistory(); }
  }

  // ---- remembering ------------------------------------------------------------------------------------------------
  function persist() { if ((agent ? agent.turns : chat.turns).length) archiveSoon(); store.saveChat({ id: chat.id, turns: agent ? agent.turns : chat.turns, log, actions: acts.map(({ live: _l, ...a }) => a), open: !root_.hidden, pending, allowAll }); }
  window.addEventListener('pagehide', () => { if (!navigateTo) persist(); });
  // the site's observing project was deleted (src/site/project.js reset): forget the project and the conversation
  window.addEventListener('esl-project-deleted', () => { if (working && agent) agent.stop(); project = emptyProject(); store.clearProject(); newChat(); say('note', 'The observing project was deleted: the assistant forgot it and started a new conversation.'); });

  const relayout = () => window.dispatchEvent(new Event('resize'));
  function show() { root_.hidden = false; document.body.classList.add('ai-open'); if (launcher) { launcher.setAttribute('aria-expanded', 'true'); launcher.setAttribute('aria-label', 'Close the assistant'); } relayout(); if (!S.base || !S.model) toggleSettings(true); else setTimeout(() => input.focus(), 30); msgs.scrollTop = msgs.scrollHeight; persist(); }
  function hide() { root_.hidden = true; document.body.classList.remove('ai-open'); if (launcher) { launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-label', 'Open the assistant'); launcher.focus(); } relayout(); persist(); }
  const toggle = () => (root_.hidden ? show() : hide());

  // ---- start: the files and the conversation kept from before -----------------------------------------------------
  const ready = (async () => {
    for (const rec of await store.files.all()) files.put(rec);
    drawFiles();
    replaying = true; try { for (const ev of log) onEvent(ev); } finally { replaying = false; }
    for (const s of stepsEl.values()) if (s.d.classList.contains('run')) { s.d.classList.remove('run'); s.d.classList.add('bad'); }   // a call cut short by a page change
    if (S.base && S.model) apply(); else { setBtn.classList.add('on'); drawEmpty(); }
    drawLog();
  })();
  /** A page load with something left to do: carry on a request that changed page, or just reopen the panel. */
  async function autoStart() {
    await ready;
    const was = pending; pending = null;
    show();
    if (!was || !agent || !agent.turns.length || working) { persist(); return; }
    persist();   // cleared before resuming: a reload must not start it again
    go(async () => { status.textContent = `Waiting for the ${page} page…`; await ensureTools(15000); if (!pageReady()) onEvent({ type: 'note', text: `The ${page} page did not finish loading its tools; the assistant continues with what is there.` }); if (was.after && site.names.includes(was.after.tool)) { status.textContent = `Running ${was.after.tool}…`; await agent.runTool(was.after.tool, was.after.args); } status.textContent = 'Thinking…'; return agent.resume(); });
  }

  const handle = { show, hide, toggle, autoStart, ready, log, files, page, get tools() { return buildTools(); }, get agent() { return agent; }, settings: S, acts, get project() { return project; }, forgetProject() { project = emptyProject(); store.clearProject(); },
    /** The set-up card's own test, for scripted checks: { ok, kind, message, models }. */
    testConnection: (base = S.base) => testConnection(normalizeBase(base), { apiKey: S.apiKey, model: S.model, listModels }),
    attachText: (name, text) => { files.add(name, text, 'attached'); drawFiles(); }, attach, transcript,
    /** The open conversation as one training record (sft.js), or null when it is empty: for scripted checks and data collection. */
    trainingRecord: () => { const r = currentRecord(); return r ? trainingRecord(r) : null; }, send: (t) => { input.value = t; return submit(); }, undoLast, newChat, get working() { return working; },
    /** For scripted checks: use this server for the page's lifetime without typing it into the card. */
    configure: async (o = {}) => { Object.assign(S, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null))); S.base = normalizeBase(S.base); S.preset = presetOf(S.base); if (!S.model && S.base) { models = await listModels(S.base, { apiKey: S.apiKey }); S.model = models[0].id; S.context = S.context || models[0].context; } apply(); toggleSettings(false); } };
  window.__eslAssistant = handle;   // for scripted checks (test/assistant_live.py)
  return handle;
}
