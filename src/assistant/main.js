// The assistant panel of the analyzer: a docked chat that drives the page through window.__esl.api.
// The analyzer loads this chunk the first time its "Assistant" button is pressed and calls
// openAssistant({ api, h, root, saveFile }). The language model is one the user chooses: any
// OpenAI-compatible server, typically on their own machine. Nothing is sent anywhere else.
//
// This file is the DOM: settings, the conversation with tool calls as collapsible steps, attachments,
// downloads, confirmations. The loop is agent.js, the tools are tools.js.

import './assistant.css';
import { createTools, memoryFiles } from './tools.js';
import { createAgent, listModels, normalizeBase, PRESETS, describeError } from './agent.js';

const STORE = 'esl.assistant.v1';
const STARTERS = ['Fit the transit in the file I attached', 'Compare a circular and an eccentric orbit', 'What do these results mean?', 'Load the single-transit example and run the fit'];
const loadSettings = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const saveSettings = (s) => { try { const { apiKey, ...rest } = s; localStorage.setItem(STORE, JSON.stringify(s.rememberKey ? s : rest)); } catch { /* storage unavailable */ } };

let panel = null;

/** Open (or bring back) the assistant. api: window.__esl.api; h: the analyzer's DOM helper; root: site root URL; saveFile(name, data): download helper. */
export function openAssistant({ api, h, root, saveFile }) {
  if (panel) { panel.show(); return panel; }
  panel = build({ api, h, root, saveFile });
  panel.show();
  return panel;
}

function build({ api, h, root, saveFile }) {
  const S = { base: '', model: '', context: null, maxSteps: 12, askConfirm: true, rememberKey: false, apiKey: '', ...loadSettings() };
  let models = [], agent = null, working = false, allowAll = false;
  const log = [];   // every harness event, for the transcript export and the headless checks

  // ---- what the tools need from the page ------------------------------------------------------------------------
  const fetchJson = async (name) => { const r = await fetch(new URL('catalog/' + name, root)); if (!r.ok) throw new Error(`The parameter catalog could not be read (${name}: HTTP ${r.status}).`); return r.json(); };
  const FIG = { light_curve: '#lccanvas', corner: '#corner', oc: '#occanvas', periodogram: '#pgcanvas', limb_darkening: '#ldcanvas' };
  const page = {
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
  const files = memoryFiles({ onWrite: () => drawFiles() });
  const tools = createTools({ api, files, page, fetchJson, where: 'browser' });

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const el = (tag, cls, ...kids) => h(tag, cls ? { class: cls } : {}, ...kids);
  const msgs = el('div', 'ai-msgs'), filesRow = el('div', 'ai-files'), status = el('div', 'ai-status');
  msgs.setAttribute('aria-live', 'polite');
  const input = h('textarea', { class: 'ai-input', rows: 2, placeholder: 'Ask for something: load a file, set up a fit, explain a result…', 'aria-label': 'Message to the assistant' });
  const sendBtn = h('button', { class: 'btn primary ai-send', onclick: () => submit() }, 'Send');
  const stopBtn = h('button', { class: 'btn danger ai-stop', hidden: true, onclick: () => agent && agent.stop() }, 'Stop');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { attach(e.target.files); e.target.value = ''; } });
  const attachBtn = h('button', { class: 'chip small ai-attach', title: 'Attach files (light curves, velocities, timing lists, session files). They stay in this browser.', 'aria-label': 'Attach files', onclick: () => fileInput.click() }, '📎 Attach');
  const modelChip = h('button', { class: 'chip small ai-model', title: 'Model server and model', onclick: () => toggleSettings() }, 'Choose a model');
  const settings = el('div', 'ai-settings'); settings.hidden = true;
  const root_ = h('aside', { class: 'ai-panel', id: 'assistant', 'aria-label': 'Assistant' },
    el('div', 'ai-head', el('span', 'ai-title', 'Assistant'), modelChip,
      h('button', { class: 'chip small', title: 'Start a new conversation (the analysis itself is kept)', onclick: () => newChat() }, 'New'),
      h('button', { class: 'chip small', title: 'Save this conversation as a Markdown file', 'aria-label': 'Save transcript', onclick: () => saveFile('assistant_transcript.md', transcript()) }, '⤓'),
      h('button', { class: 'chip small ai-close', 'aria-label': 'Close the assistant', onclick: () => hide() }, '✕')),
    settings, msgs, status, filesRow,
    el('div', 'ai-compose', input, el('div', 'ai-actions', attachBtn, fileInput, el('span', 'ai-grow'), stopBtn, sendBtn)),
    el('p', 'ai-privacy', 'Your messages, a summary of the page (parameter values, data counts, file names) and tool results go only to the model server you chose. Data and attached files stay in this browser; the model sees a file\'s text only when it reads the file.'));
  document.body.append(root_);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  root_.addEventListener('dragover', (e) => { e.preventDefault(); root_.classList.add('drop'); });
  root_.addEventListener('dragleave', () => root_.classList.remove('drop'));
  root_.addEventListener('drop', (e) => { e.preventDefault(); root_.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) attach(e.dataTransfer.files); });

  // ---- settings -------------------------------------------------------------------------------------------------
  function drawSettings(msg = '', cls = '') {
    settings.innerHTML = '';
    const base = h('input', { type: 'text', class: 'ai-base', value: S.base, placeholder: 'http://localhost:1234/v1', 'aria-label': 'Model server address', spellcheck: 'false', autocomplete: 'off' });
    const key = h('input', { type: 'password', class: 'ai-key', value: S.apiKey || '', placeholder: 'only if your server needs one', 'aria-label': 'API key', autocomplete: 'off' });
    const sel = h('select', { class: 'ai-modelsel', 'aria-label': 'Model' }, ...(models.length ? models.map((m) => h('option', { value: m.id, selected: m.id === S.model }, m.id + (m.context ? ` · ${Math.round(m.context / 1000)}k context` : ''))) : [h('option', { value: S.model || '' }, S.model || 'press Test connection')]));
    const ctx = h('input', { type: 'number', class: 'ai-ctx', value: S.context || '', placeholder: 'from the server', min: 2000, step: 1000, 'aria-label': 'Context window in tokens' });
    const steps = h('input', { type: 'number', class: 'ai-steps', value: S.maxSteps, min: 1, max: 60, 'aria-label': 'Steps before asking to continue' });
    const ask = h('input', { type: 'checkbox', checked: S.askConfirm !== false }), remember = h('input', { type: 'checkbox', checked: !!S.rememberKey });
    const out = h('p', { class: 'ai-test ' + cls }, msg);
    const read = () => { S.base = normalizeBase(base.value); S.apiKey = key.value.trim(); S.model = sel.value || S.model; S.context = Number(ctx.value) > 0 ? Number(ctx.value) : null; S.maxSteps = Math.max(1, Math.min(60, Number(steps.value) || 12)); S.askConfirm = ask.checked; S.rememberKey = remember.checked; };
    const test = async () => {
      read(); out.className = 'ai-test'; out.textContent = 'Asking ' + (S.base || '…') + ' for its models…';
      try {
        models = await listModels(S.base, { apiKey: S.apiKey });
        if (!models.length) throw new Error('The server answered but lists no model: load one in it first.');
        if (!models.some((m) => m.id === S.model)) S.model = models[0].id;
        const m = models.find((x) => x.id === S.model); if (m && m.context) S.context = m.context;
        apply(); drawSettings(`Connected: ${models.length} model${models.length > 1 ? 's' : ''}. Using ${S.model}${m && m.context ? ` (${m.context} tokens of context)` : ' (context size not reported: 8192 assumed; set it below if you know it)'}.` + (S.context && S.context < 8000 ? ' That context is small for an assistant with tools: raise it in the server if you can (16k or more works best).' : ''), 'ok');
      } catch (err) { models = []; drawSettings(String(err.message || err), 'bad'); }
    };
    sel.addEventListener('change', () => { read(); const m = models.find((x) => x.id === S.model); S.context = m && m.context ? m.context : null; apply(); drawSettings(); });
    for (const x of [ctx, steps, ask, remember]) x.addEventListener('change', () => { read(); apply(); });
    base.addEventListener('keydown', (e) => { if (e.key === 'Enter') test(); });
    settings.append(
      h('p', { class: 'ai-lead' }, 'The assistant needs a language model. Use one running on your own computer, or any server that speaks the OpenAI chat protocol.'),
      el('div', 'ai-presets', ...PRESETS.map((p) => h('button', { class: 'chip small', title: p.base, onclick: () => { base.value = p.base; test(); } }, p.label))),
      el('label', 'ai-field', el('span', '', 'Server'), base),
      el('label', 'ai-field', el('span', '', 'API key'), key),
      el('div', 'ai-row', h('button', { class: 'btn ai-testbtn', onclick: test }, 'Test connection'), el('label', 'ai-check', remember, ' remember the key in this browser')),
      out,
      el('label', 'ai-field', el('span', '', 'Model'), sel),
      el('div', 'ai-row', el('label', 'ai-field small', el('span', '', 'Context (tokens)'), ctx), el('label', 'ai-field small', el('span', '', 'Steps per request'), steps)),
      el('label', 'ai-check', ask, ' ask me before the assistant replaces loaded data or deletes a saved analysis'),
      h('p', { class: 'ai-note' }, 'A model with tool calling and a context of 16k tokens or more works best. The key, if any, is sent only to the server above.'),
      el('div', 'ai-row', h('button', { class: 'btn primary', onclick: () => { read(); apply(); toggleSettings(false); } }, 'Done')));
  }
  function toggleSettings(on) { settings.hidden = on === undefined ? !settings.hidden : !on; if (!settings.hidden) drawSettings(); }
  /** Push the settings into the agent (creating it the first time) and remember them. */
  function apply() {
    saveSettings(S);
    modelChip.textContent = S.model ? S.model : 'Choose a model'; modelChip.classList.toggle('on', !S.model);
    const conf = { base: S.base, model: S.model, apiKey: S.apiKey, contextLimit: S.context, maxSteps: S.maxSteps };
    if (!agent) agent = createAgent({ ...conf, tools, onEvent, confirm });
    else agent.configure(conf);
    drawEmpty();
  }

  // ---- files ----------------------------------------------------------------------------------------------------
  async function attach(list) {
    for (const f of list) {
      if (f.size > 30e6) { say('note', `${f.name} is ${(f.size / 1e6).toFixed(0)} MB: too large to attach (30 MB at most).`); continue; }
      const text = await f.text();
      if (/\u0000/.test(text.slice(0, 4000))) { say('note', `${f.name} is not a text file. Light curves, velocities and timing lists are read from text (CSV, TXT, JSON); FITS images belong on the Photometry page.`); continue; }
      files.add(f.name, text, 'attached');
    }
    drawFiles(); input.focus();
  }
  function drawFiles() {
    filesRow.innerHTML = '';
    for (const f of files.list()) {
      const rec = files.get(f.name), kb = f.size > 2048 ? Math.round(f.size / 1024) + ' kB' : f.size + ' B';
      filesRow.append(el('span', 'ai-file ' + f.origin, h('span', { class: 'ai-fname', title: f.about || '' }, f.name), el('small', '', kb),
        f.origin === 'written' ? h('button', { class: 'ai-dl', title: 'Download ' + f.name, onclick: () => saveFile(f.name, rec.blob || rec.text) }, 'Download') : h('button', { class: 'ai-x', 'aria-label': 'Remove ' + f.name, title: 'Remove', onclick: () => { files.remove(f.name); drawFiles(); } }, '✕')));
    }
    filesRow.hidden = !filesRow.children.length;
  }

  // ---- conversation ---------------------------------------------------------------------------------------------
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  /** Just enough Markdown for a model's answer: paragraphs, lists, bold, inline code, fenced code. Everything is escaped first. */
  function md(text) {
    const inline = (s) => esc(s.replace(/\\([*_`#])/g, (m, c) => `&#${c.charCodeAt(0)};`)).replace(/&amp;#(\d+);/g, '&#$1;').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    const out = []; let list = null, code = null;
    for (const line of String(text).split('\n')) {
      if (/^```/.test(line)) { if (code) { out.push('<pre>' + esc(code.join('\n')) + '</pre>'); code = null; } else { if (list) { out.push(`</${list}>`); list = null; } code = []; } continue; }
      if (code) { code.push(line); continue; }
      const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line), hd = /^#{1,4}\s+(.*)$/.exec(line), want = li ? (/\d/.test(li[1]) ? 'ol' : 'ul') : null;
      if (list && list !== want) { out.push(`</${list}>`); list = null; }
      if (li) { if (!list) { out.push(`<${want}>`); list = want; } out.push('<li>' + inline(li[2]) + '</li>'); }
      else if (hd) out.push('<p class="ai-h">' + inline(hd[1]) + '</p>');
      else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    }
    if (code) out.push('<pre>' + esc(code.join('\n')) + '</pre>'); if (list) out.push(`</${list}>`);
    return out.join('');
  }
  const atBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const add = (node) => { const stick = atBottom(); msgs.querySelector('.ai-empty')?.remove(); msgs.append(node); if (stick) msgs.scrollTop = msgs.scrollHeight; return node; };
  function say(kind, text) { return add(h('div', { class: 'ai-msg ' + kind, html: kind === 'assistant' ? md(text) : esc(text).replace(/\n/g, '<br>') })); }
  function drawEmpty() {
    if (msgs.querySelector('.ai-msg, .ai-step')) return;
    msgs.innerHTML = '';
    const ready = S.base && S.model;
    msgs.append(el('div', 'ai-empty',
      h('p', {}, ready ? 'Ask for anything you can do on this page. The assistant sees what is loaded and works through the same controls; every action it takes is listed here and can be undone with Undo.' : 'Choose a model server to begin.'),
      ready ? el('div', 'ai-starters', ...STARTERS.map((t) => h('button', { class: 'chip', onclick: () => { input.value = t; submit(); } }, t))) : h('button', { class: 'btn primary', onclick: () => toggleSettings(true) }, 'Set up a model')));
  }
  function newChat() { if (working) return; if (agent) agent.reset(); tools.resetRuns(); log.length = 0; allowAll = false; msgs.innerHTML = ''; status.textContent = ''; drawEmpty(); }

  const stepsEl = new Map(); let live = null, timer = null;
  const brief = (args) => { const s = JSON.stringify(args ?? {}); return s === '{}' ? '' : s.length > 90 ? s.slice(0, 90) + '…' : s; };
  function onEvent(ev) {
    log.push({ t: Date.now(), ...ev, data: undefined });
    if (ev.type === 'assistant_delta') { if (!live) live = say('assistant streaming', ''); live._text = (live._text || '') + ev.text; const stick = atBottom(); live.innerHTML = md(live._text); if (stick) msgs.scrollTop = msgs.scrollHeight; }
    else if (ev.type === 'assistant') { if (live) { live.remove(); live = null; } if (ev.text) say('assistant' + (ev.final ? '' : ' aside'), ev.text); }
    else if (ev.type === 'tool_start') {
      if (live) { live.remove(); live = null; }
      const head = h('summary', {}, el('span', 'ai-dot'), el('b', '', ev.name), el('span', 'ai-args', brief(ev.args)), el('span', 'ai-ms', '…'));
      const body = el('div', 'ai-stepbody', el('div', 'ai-k', 'arguments'), h('pre', {}, JSON.stringify(ev.args ?? {}, null, 1)));
      const d = h('details', { class: 'ai-step run' }, head, body); stepsEl.set(ev.id, { d, body, t0: Date.now() }); add(d);
      status.textContent = `Running ${ev.name}…`;
      clearInterval(timer); timer = setInterval(() => { const s = stepsEl.get(ev.id); if (s && s.d.classList.contains('run')) s.d.querySelector('.ai-ms').textContent = ((Date.now() - s.t0) / 1000).toFixed(0) + ' s'; }, 500);
    } else if (ev.type === 'tool_end') {
      clearInterval(timer); const s = stepsEl.get(ev.id); if (!s) return;
      s.d.classList.remove('run'); s.d.classList.add(ev.denied ? 'denied' : ev.ok ? 'ok' : 'bad');
      s.d.querySelector('.ai-ms').textContent = ev.denied ? 'declined' : ev.ms < 1000 ? ev.ms + ' ms' : (ev.ms / 1000).toFixed(1) + ' s';
      let pretty = ev.text; try { if (ev.ok) pretty = JSON.stringify(JSON.parse(ev.text), null, 1); } catch { /* plain text */ }
      s.body.append(el('div', 'ai-k', 'result'), h('pre', {}, pretty.length > 6000 ? pretty.slice(0, 6000) + '\n…' : pretty));
      s.d.querySelector('.ai-confirm')?.remove(); status.textContent = 'Thinking…';
    } else if (ev.type === 'note') say('note', ev.text);
    else if (ev.type === 'context' && ev.trimmed) say('note', `To stay inside the model's context (${ev.limit} tokens): ${ev.trimmed}.`);
    else if (ev.type === 'error') say('note bad', ev.message);
    else if (ev.type === 'cap') add(el('div', 'ai-msg note cap', `The assistant has taken ${ev.steps} steps on this request. `, h('button', { class: 'btn', onclick: (e) => { e.target.closest('.cap').remove(); go(() => agent.resume()); } }, 'Continue'), ' or send a new message.'));
    else if (ev.type === 'done') status.textContent = ev.reason === 'stopped' ? 'Stopped.' : '';
  }
  /** Ask the user before a call that replaces or deletes something. */
  function confirm({ id, name, reason }) {
    if (S.askConfirm === false || (allowAll && name !== 'delete_saved')) return Promise.resolve(true);
    return new Promise((resolve) => {
      const s = stepsEl.get(id), always = h('input', { type: 'checkbox' });
      const done = (yes) => { if (yes && always.checked) allowAll = true; box.remove(); resolve(yes); };
      const box = el('div', 'ai-confirm', el('p', '', reason), el('div', 'ai-row', h('button', { class: 'btn primary ai-allow', onclick: () => done(true) }, 'Allow'), h('button', { class: 'btn ai-deny', onclick: () => done(false) }, 'Decline'),
        name === 'delete_saved' ? null : el('label', 'ai-check', always, ' do not ask again in this conversation')));
      if (s) { s.d.open = true; s.d.append(box); if (atBottom() || true) msgs.scrollTop = msgs.scrollHeight; } else add(box);
      status.textContent = 'Waiting for your answer…';
    });
  }
  async function go(fn) {
    working = true; sendBtn.hidden = true; stopBtn.hidden = false; status.textContent = 'Thinking…';
    try { await fn(); } catch (err) { say('note bad', describeError(err, S.base)); }
    finally { working = false; sendBtn.hidden = false; stopBtn.hidden = true; if (live) { live.remove(); live = null; } if (/Thinking|Running|Waiting/.test(status.textContent)) status.textContent = ''; }
  }
  function submit() {
    const text = input.value.trim(); if (!text || working) return;
    if (!S.base || !S.model) { toggleSettings(true); return; }
    if (!agent) apply();
    input.value = ''; say('user', text);
    go(() => agent.send(text));
  }
  function transcript() {
    const out = [`# Assistant conversation`, '', `Model: ${S.model} at ${S.base}`, ''];
    for (const ev of log) {
      if (ev.type === 'user') out.push(`## You`, '', ev.text, '');
      else if (ev.type === 'assistant') out.push(ev.final ? '## Assistant' : '_Assistant (while working):_', '', ev.text, '');
      else if (ev.type === 'tool_start') out.push(`- **${ev.name}** \`${JSON.stringify(ev.args ?? {})}\``);
      else if (ev.type === 'tool_end') out.push(`  - ${ev.denied ? 'declined' : ev.ok ? 'ok' : 'failed'} in ${ev.ms} ms: \`${ev.text.length > 600 ? ev.text.slice(0, 600) + '…' : ev.text}\``, '');
      else if (ev.type === 'note' || ev.type === 'error') out.push(`> ${ev.text || ev.message}`, '');
      else if (ev.type === 'done') out.push(`_${ev.reason}: ${ev.steps} model steps, ${ev.seconds.toFixed(1)} s_`, '');
    }
    return out.join('\n');
  }

  const relayout = () => window.dispatchEvent(new Event('resize'));
  function show() { root_.hidden = false; document.body.classList.add('ai-open'); relayout(); if (!S.base || !S.model) toggleSettings(true); setTimeout(() => (settings.hidden ? input : settings.querySelector('input')).focus(), 30); }
  function hide() { root_.hidden = true; document.body.classList.remove('ai-open'); relayout(); }

  if (S.base && S.model) apply(); else { modelChip.classList.add('on'); drawEmpty(); }
  drawFiles();
  const handle = { show, hide, log, files, tools, get agent() { return agent; }, settings: S, attachText: (name, text) => { files.add(name, text, 'attached'); drawFiles(); }, transcript, send: (t) => { input.value = t; submit(); }, get working() { return working; } };
  window.__eslAssistant = handle;   // for scripted checks (test/assistant_live.py)
  return handle;
}
