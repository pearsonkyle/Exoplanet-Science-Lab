// The assistant's tools on any page of the site. Three layers, joined into one registry with the interface of
// tools.js (specs, call, confirmFor, stateCard):
//
//   site      navigate (every page), and list_files / read_file / write_file where the page has no file tools
//   analyzer  tools.js on window.__esl.api (the analyze page only)
//   page      the tools a page declares itself in window.__esl.<page>:
//               { ready() -> bool, state() -> string | [string], tools: [{ name, description, parameters (JSON schema),
//                 readOnly, confirm, core, run(args, { files, signal, onProgress, request }) -> result }] }   request: the user's words
//             A result is plain data. { navigate: { page, params } } in it means "this action continues on another
//             page": the harness saves the conversation, goes there and carries on.
//
// No DOM here: the page object, the file store and the way to change page are passed in, so the Node tests run it.

import { checkArgs, lintSpecs } from './toolspec.js';
import { fileHandlers, knowledgeHandlers, KNOWLEDGE_TOOLS } from './tools.js';
import { TOOL_SPECS } from './toolspec.js';
import * as ops from './ops.js';
import { projectCard, capabilities } from './project.js';

/** The pages of the site: folder under the site root, what it is for, the query parameters it understands. */
export const PAGES = {
  home: { path: '', about: 'the landing page', params: [] },
  plan: { path: 'plan/', about: 'observable transits from a site in a range of nights', params: ['planet'] },
  observe: { path: 'observe/', about: 'the sky from a place at a time', params: ['planet', 't', 'lat', 'lon', 'elev', 'transit', 'err'] },
  photometry: { path: 'analyze/photometry/', about: 'light curves from images', params: ['demo'] },
  analyze: { path: 'analyze/', about: 'model and fit transits, velocities and timing', params: ['planet', 'handoff'] },
  search: { path: 'search/', about: 'the catalogue of known planets', params: ['planet', 'q'] },
  spectroscopy: { path: 'analyze/spectroscopy/', about: 'time-series spectra (JWST x1dints, tables, or an Ariel/JWST simulation) to a transmission or emission spectrum', params: [] },
  atmosphere: { path: 'analyze/atmosphere/', about: 'a model atmosphere: temperature profile, composition and clouds to a transmission and an emission spectrum, with preset worlds (WASP-39 b, WASP-121 b, Jupiter, Titan); it also fits the model to a measured spectrum file (a retrieval)', params: [] },
  star: { path: 'analyze/star/', about: 'the host star from its magnitudes: effective temperature, angular diameter, radius and luminosity by an SED fit, with catalogue lookup', params: [] },
  validation: { path: 'methods/', about: 'the Methods page: how every technique is done and justified, with references, and its validation against other codes and published results', params: ['topic'] },
};
export const PAGE_IDS = Object.keys(PAGES);

/** Which page a URL is, given the site root (both absolute URLs or paths). */
export function pageOf(href, root) {
  const path = new URL(href, 'http://x/').pathname, base = new URL(root, 'http://x/').pathname.replace(/\/?$/, '/');
  const rel = (path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '')).replace(/index\.html$/, '');
  const hit = PAGE_IDS.filter((id) => id !== 'home').sort((a, b) => PAGES[b].path.length - PAGES[a].path.length).find((id) => rel === PAGES[id].path || rel === PAGES[id].path.replace(/\/$/, '') || rel.startsWith(PAGES[id].path));
  return hit || 'home';
}
/** The address of a page with its parameters. The analyzer opens without its start page; a validation topic is an anchor. */
export function pageUrl(root, page, params = {}) {
  const P = PAGES[page]; if (!P) throw new Error(`there is no page "${page}". The pages are: ${PAGE_IDS.join(', ')}.`);
  const u = new URL(P.path, root), q = { ...params };
  let hash = '';
  if (page === 'validation' && q.topic) { hash = '#val-' + encodeURIComponent(String(q.topic).replace(/^#?(val-)?/, '')); delete q.topic; }
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  if (page === 'analyze' && !u.searchParams.has('planet') && !u.searchParams.has('handoff')) u.searchParams.set('skipintro', '');
  return u.href.replace(/skipintro=(&|$)/, 'skipintro$1') + hash;
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const NAVIGATE = { name: 'navigate', group: 'site', core: true,
  description: 'Go to another page of the site and continue this request there with that page\'s tools. Pages: home, plan (observable transits), observe (the sky view), photometry (images to light curves), spectroscopy (time-series spectra to a transmission or emission spectrum), atmosphere (a model atmosphere and its spectrum), star (the host star from its magnitudes), analyze (models and fits), search (the catalogue), validation. "params" are that page\'s address parameters: plan {planet}, observe {planet, t (ISO UTC), lat, lon}, analyze {planet}, search {planet} or {q}, validation {topic}. Finish what this page can do first.',
  parameters: obj({ page: { type: 'string', enum: PAGE_IDS, description: 'The page to open.' }, params: { type: 'object', description: 'Address parameters of that page, e.g. {"planet": "WASP-43 b"}.', additionalProperties: { type: ['string', 'number'] } } }, ['page']) };
const FILE_SPECS = [
  { name: 'list_files', group: 'files', readOnly: true, description: 'List the files of this conversation: those the user attached and those you produced (name, size, a one-line guess of what each holds). They travel with the conversation from page to page.', parameters: obj({}) },
  { name: 'read_file', group: 'files', readOnly: true, description: 'Look inside a file as text. Small files come back whole; large ones as a summary (lines, columns, numeric range of each column) plus the first lines. A FITS image is read as its header. To fit a data file, go to the analyze page and pass its name to load_light_curve.',
    parameters: obj({ name: { type: 'string', description: 'File name from list_files.' }, max_chars: { type: 'integer', description: 'Most characters of content to return (default 2000).', minimum: 200, maximum: 20000 }, offset: { type: 'integer', description: 'Start at this character (to read on).', minimum: 0 } }, ['name']) },
  { name: 'write_file', group: 'files', description: 'Write a text file (CSV, JSON, Markdown, a script) and give it to the user as a download.', parameters: obj({ name: { type: 'string', description: 'File name with extension, e.g. "notes.md".' }, content: { type: 'string', description: 'The whole text of the file.' } }, ['name', 'content']) },
];

const cut = (s, n) => (s.length > n ? s.slice(0, n) + `… [${s.length - n} chars cut]` : s);
const jsonText = (data) => JSON.stringify(data, (k, v) => (v === undefined || v === null ? undefined : typeof v === 'number' && !Number.isFinite(v) ? undefined : v));

/**
 * createSiteTools({ page, root, analyzer, analyzerApi, pageApi, files, maxNavigations })
 *   page         id of the page the conversation is on (PAGES)
 *   root         the site root URL
 *   analyzer     a createTools(...) registry (analyze page), or null
 *   analyzerApi  window.__esl.api, for the action log's undo
 *   pageApi      window.__esl.<page> (see the top of this file), or null
 * -> { page, specs, names, call, confirmFor, stateCard, fileNames, actions, undoAction(), canUndo(), problems }
 */
/** Today's date in the browser, for the state card: the model does not know it, and a month without a year means the next one. */
export function todayLine(now = new Date()) {
  const z = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }), time = now.toTimeString().slice(0, 5);
  return `Today: ${day} ${date}, ${time}${z ? ' ' + z : ''} (this browser's clock). Plans are for nights from today on: a date the user gives without a year is its next occurrence (in November, "January" means next January); pass dates as the user wrote them and the planner resolves them.`;
}

export function createSiteTools({ page, root, analyzer = null, analyzerApi = null, pageApi = null, files, maxNavigations = 6, project = null, pageProblem = null }) {
  if (!PAGES[page]) throw new Error(`unknown page "${page}"`);
  const pageTools = (pageApi && Array.isArray(pageApi.tools) ? pageApi.tools : []).filter((t) => t && typeof t.run === 'function').map((t) => ({ group: page, ...t, parameters: t.parameters || obj({}) }));
  // pages other than the analyzer: the files of the conversation, and the Methods and the code (how something is computed)
  const KH = knowledgeHandlers(), own = analyzer ? [] : [...FILE_SPECS, ...TOOL_SPECS.filter((t) => KNOWLEDGE_TOOLS.includes(t.name))], FH = { ...fileHandlers(files, 'browser', KH.read_source), ...KH };
  const specs = [NAVIGATE, ...pageTools.map(({ run, ...t }) => t), ...(analyzer ? analyzer.specs : []), ...own];
  // a page tool may not shadow another tool, and must be a well-formed declaration (reported, not thrown: the page still works)
  const seen = new Set(), problems = lintSpecs(specs.map((t) => ({ ...t, where: undefined }))).filter((p) => !/additional|no description/.test(p));
  for (const t of specs) { if (seen.has(t.name)) problems.push(`${t.name}: declared by two layers`); seen.add(t.name); }
  const actions = [];        // what the assistant changed, newest last: { id, page, name, args, summary, at, undo }
  let navs = 0, seq = 0;

  // ---- the action log and its undo ------------------------------------------------------------------------------
  // The analyzer's own undo steps back one internal change, and a tool call may make several; a fingerprint of
  // the analysis taken before the call says how far to go back.
  const fingerprint = () => {
    if (!analyzerApi) return null;
    try { const d = analyzerApi.exportSession(true); return JSON.stringify([d.name, d.star, d.limb_darkening, d.planets, d.kepler, d.phase || null, d.nbody || null, d.fit, d.ui && d.ui.planet, ops.dataKey({ ...d, fit: { use: { lc: true, rv: true, timing: true } } }), d.result ? [d.result.logZ, d.result.ncalls] : null]); } catch { return null; }
  };
  const summarise = (name, data) => {
    if (!data || typeof data !== 'object') return '';
    const pick = ['navigating_to', 'done', 'opened', 'loaded', 'set', 'free', 'added', 'removed', 'written', 'saved', 'deleted', 'simulated', 'site', 'dates', 'target', 'experiment', 'run', 'restored', 'started', 'note'].find((k) => data[k] !== undefined);
    if (!pick) return '';
    const v = data[pick], t = typeof v === 'string' ? v : JSON.stringify(v);
    return cut(`${pick}: ${t}`, 110);
  };
  function record(spec, args, data, before) {
    const undo = before !== null && before !== undefined && fingerprint() !== before ? { before } : null;
    const a = { id: ++seq, page, name: spec.name, args, summary: summarise(spec.name, data), at: Date.now(), undo };
    actions.push(a); if (actions.length > 80) actions.shift();
    return a;
  }
  /** The newest action that can still be undone (those after it changed nothing that undo covers). */
  const lastUndoable = () => { for (let i = actions.length - 1; i >= 0; i--) { if (actions[i].undone) continue; return actions[i].undo ? actions[i] : null; } return null; };
  /** Undo the newest undoable action with the analyzer's own undo, stepping back until the analysis is as it was before it. */
  function undoAction() {
    const a = lastUndoable(); if (!a || !analyzerApi) return { ok: false, why: 'nothing to undo here' };
    let steps = 0;
    while (steps < 60 && fingerprint() !== a.undo.before) { if (analyzerApi.undo() === false) break; steps++; }
    const ok = fingerprint() === a.undo.before;
    a.undone = true; a.undo = null;
    return { ok, steps, action: a, why: ok ? '' : 'the analyzer\'s undo history did not reach that point; it went back as far as it could' };
  }

  // ---- calls ---------------------------------------------------------------------------------------------------
  function confirmFor(name, args = {}) {
    if (analyzer && analyzer.specs.some((t) => t.name === name)) return analyzer.confirmFor(name, args);
    const t = pageTools.find((x) => x.name === name);
    if (!t || !t.confirm) return null;
    return typeof t.confirm === 'function' ? t.confirm(args) || null : t.confirm;
  }
  function goTo(to, params) {
    if (navs >= maxNavigations) throw new Error(`this request has changed page ${navs} times already: finish here and tell the user what is left`);
    // The analyzer answers ?planet= with its start dialog, which waits for a person. The assistant opens the
    // page plainly and the harness loads the planet from the catalogue on arrival (`after`), as a step the model sees.
    const q = { ...(params || {}) }; let after = null;
    if (to === 'analyze' && q.planet) { after = { tool: 'lookup_planet', args: { name: String(q.planet) } }; delete q.planet; }
    const url = pageUrl(root, to, q);
    navs++;
    return { halt: { reason: 'navigate', url, page: to, ...(after ? { after } : {}) }, data: { navigating_to: to, address_parameters: params && Object.keys(params).length ? params : undefined,
      note: `The site is opening the ${to} page. The conversation continues there: the next CURRENT STATE block describes that page, and your tools will be that page's.` + (after ? ` ${q.planet || params.planet} is loaded from the catalogue on arrival (lookup_planet).` : '') } };
  }
  async function call(name, rawArgs, opts = {}) {
    const spec = specs.find((t) => t.name === name);
    if (!spec) {
      const elsewhere = /^(plan|observe|photometry|spectroscopy|atmosphere|star|search|validation|methods)_/.test(String(name)) ? ` "${name}" looks like a tool of the ${String(name).split('_')[0] === 'methods' ? 'validation (Methods)' : String(name).split('_')[0]} page: call navigate to go there first.` : !analyzer && /^(load_|run_fit|set_free|set_prior|lookup_planet|get_results|run_experiment|export_file|import_session|simulate_)/.test(String(name)) ? ` "${name}" is a tool of the analyze page: call navigate {"page": "analyze"} first.` : '';
      return { ok: false, text: `ERROR: there is no tool "${name}" on this page (${page}).${elsewhere} The tools here are: ${specs.map((t) => t.name).join(', ')}.` };
    }
    if (analyzer && analyzer.specs.includes(spec)) {
      const before = spec.readOnly ? null : fingerprint(), r = await analyzer.call(name, rawArgs, opts);
      if (r.ok && !spec.readOnly) r.action = record(spec, r.args, r.data, before);
      return r;
    }
    const { args, error } = checkArgs(spec, rawArgs);
    if (error) return { ok: false, args, text: 'ERROR: ' + error };
    try {
      if (name === 'navigate') {
        if (args.page === page && !(args.params && Object.keys(args.params).length)) throw new Error(`you are already on the ${page} page: use its tools (${specs.filter((t) => t.group === page).map((t) => t.name).slice(0, 8).join(', ') || 'see the tool list'})`);
        // a long run on this page (a fit, a search, a reduction) dies with the page: wait for it, or stop it first
        const J = typeof window !== 'undefined' && window.__eslJobs;
        if (J && J.running()) { const j = J.list()[0]; throw new Error(`"${j.label}" is running on this page (${Math.round(100 * j.fraction)}% done${Number.isFinite(j.eta_s) ? `, about ${Math.max(1, Math.round(j.eta_s / 60))} min left` : ''}): leaving the page would stop it. Tell the user it is running and what is left to do; continue when it has finished.`); }
        const bad = Object.keys(args.params || {}).filter((k) => !PAGES[args.page].params.includes(k));
        if (bad.length) throw new Error(`the ${args.page} page has no address parameter ${bad.join(', ')}. It takes: ${PAGES[args.page].params.join(', ') || 'none'}. Go there without it and use the page's tools.`);
        const g = goTo(args.page, args.params); record(spec, args, g.data, null);
        return { ok: true, args, data: g.data, text: jsonText(g.data), halt: g.halt };
      }
      if (FH[name] && own.includes(spec)) { const data = await FH[name](args); if (name === 'write_file') record(spec, args, data, null); return { ok: true, args, data, text: jsonText(data), table: '' }; }
      const t = pageTools.find((x) => x.name === name);
      let data = await t.run(args, { files, signal: opts.signal, onProgress: opts.onProgress, request: opts.request || '' });
      if (data === undefined) data = { done: true };
      let halt = null;
      // a transit opened in the analyzer: its predicted mid-time as a BJD (the planner's own number) goes with it,
      // so that the analyzer can be set up for that night without the model converting a UTC time
      // a TESS candidate is not in the analyzer's catalogue: say so here, before a page change that would end in a failed lookup
      if (name === 'plan_open_transit' && data && data.navigate && args.in === 'analyze' && data.transit && data.transit.tess_candidate) {
        return { ok: false, args, text: `ERROR: ${data.transit.planet} is a TESS candidate (${data.transit.tess_candidate}): the analyzer's catalogue holds confirmed planets only, so it cannot load it. To analyse, pick a confirmed planet from plan_list_transits (one without "tess_candidate"); a candidate can still be opened in "observe" or "details".` };
      }
      if (name === 'plan_open_transit' && data && data.navigate && args.in === 'analyze' && !data.mid_bjd_tdb) {
        try { const det = await t.run({ ...args, in: 'details' }, { files }); if (det && det.mid_bjd_tdb) { data = { ...data, mid_bjd_tdb: det.mid_bjd_tdb, ephemeris: det.ephemeris, dark_baseline: det.dark_baseline }; } } catch { /* the details are a bonus */ }
      }
      if (data && typeof data === 'object' && data.navigate) {
        const n = typeof data.navigate === 'string' ? { page: data.navigate } : data.navigate, g = goTo(n.page, n.params);
        halt = g.halt; data = { ...data, navigate: undefined, ...g.data };
      }
      if (!spec.readOnly) record(spec, args, data, null);
      let table = ''; try { table = ops.tableFor(name, data); } catch { table = ''; }
      return { ok: true, args, data, table, text: jsonText(data), halt };
    } catch (err) { return { ok: false, args, text: 'ERROR: ' + String((err && err.message) || err).replace(/★/g, '*') }; }
  }

  /** The live card the model reads at every step: where it is, what that page shows, the files at hand. */
  function stateCard() {
    const L = [`CURRENT STATE (live; regenerated every step)`, `Page: ${page} (${PAGES[page].about}). Other pages are reached with navigate: ${PAGE_IDS.filter((p) => p !== page).join(', ')}.`];
    L.splice(1, 0, todayLine());
    let pj = ''; try { pj = projectCard(project ? project() : null, { caps: capabilities(analyzer ? analyzer.specs : null, page) }); } catch { pj = ''; }
    if (pj) L.push(pj);
    if (pageApi && typeof pageApi.state === 'function') { try { const s = pageApi.state(); L.push(...[].concat(s).filter(Boolean).map((x) => cut(String(x), 600))); } catch (err) { L.push(`The page's state is unavailable (${err.message}).`); } }
    else if (!analyzer) {
      const why = typeof pageProblem === 'function' ? pageProblem() : pageProblem;
      L.push(page === 'home' ? 'The landing page has nothing to operate: navigate to the page the request needs.'
        : PAGES[page].noTools ? 'This page offers the assistant no tools of its own yet: say what the user can do on it by hand, or navigate to another page.'
          : `THE ${page.toUpperCase()} PAGE'S TOOLS ARE NOT AVAILABLE: the page did not finish loading${why ? ` (${cut(String(why), 160)})` : ''}. Do not call navigate to this page again and do not guess its tools: tell the user the ${page} page is not working right now, and do what can be done on another page.`);
    }
    if (analyzer) L.push(analyzer.stateCard().replace(/^CURRENT STATE OF THE APP[^\n]*\n/, ''));
    else { const fl = files.list(); L.push(`Files: ${fl.length ? fl.slice(0, 12).map((f) => `${f.name} (${f.size > 2048 ? Math.round(f.size / 1024) + ' kB' : f.size + ' B'}, ${f.origin}${f.about ? ': ' + cut(f.about, 70) : ''})`).join('; ') : 'none attached'}`); }
    return L.join('\n');
  }

  return { page, specs, names: specs.map((t) => t.name), call, confirmFor, stateCard, fileNames: () => files.list().map((f) => f.name), actions, undoAction, canUndo: () => !!lastUndoable(), problems,
    resetRuns() { if (analyzer) analyzer.resetRuns(); }, get runs() { return analyzer ? analyzer.runs : []; } };
}
