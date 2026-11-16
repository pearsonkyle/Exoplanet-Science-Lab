// The observing project: one small record that follows a user across the site, from choosing a target to the report,
// and a compact checklist in the site bar that says what to do on each page and links to the next one.
//
// The record (localStorage "esl.project.v1"; plain JSON, everything optional except v and the timestamps):
//   { v: 1, id, created, updated, title,
//     target: { name (planet, e.g. "HD 80606 b"), host, ra, dec (J2000 deg), per (d), tmid (BJD_TDB), t14 (d), source },
//     site:   { name, lat, lon (deg, east +), elev (m) },
//     event:  { kind: 'transit' | 'eclipse', mid (BJD_TDB), ingress, egress (ISO UTC), night (YYYY-MM-DD), sigma_min },
//     files:  [{ kind: 'images' | 'lightcurve' | 'rv' | 'session' | 'report' | 'other', name, page, at (ISO), n, note }],
//     fits:   [{ at, page, run, free: [keys], use: { lc, rv, timing }, logZ, logZerr, chi2, n_data, converged, values: { key: { median, plus, minus } } }],
//     done:   { stepId: ISO time },     marked by hand or by advance()
//     step:   the step the user is on (a STEPS id); null = the first one not done
//     notes:  free text }
// The pure functions (normalize, stepStates, currentStep, stepHref, merge) take the record as data and run in Node
// (test/project.test.mjs). The panel at the bottom needs a page.

export const PROJECT_KEY = 'esl.project.v1';
const UI_KEY = 'esl.project.ui.v1';
// what the assistant (src/assistant/store.js KEYS) keeps about a project: its project memory and the conversation
const ASSISTANT_KEYS = ['esl.assistant.project.v1', 'esl.assistant.chat.v1'];

const has = (p, kind) => (p.files || []).some((f) => f.kind === kind);
const fitWith = (p, test) => (p.fits || []).some((f) => test(f.use || {}));
/**
 * The stages of an observing project. `page`: the site section it happens on (nav.js SECTIONS ids, or
 * 'photometry'); `auto(p)`: true when the record shows the step is done without the user saying so.
 */
export const STEPS = [
  { id: 'target', label: 'Choose a target', page: 'search', auto: (p) => !!(p.target && p.target.name),
    coach: 'Pick a planet. Search the catalogue for one you can observe (bright host, deep transit), or open Plan to see which transits happen from your site in the coming nights. Type its name below or press “Use as target” on a planet’s page.' },
  { id: 'plan', label: 'Plan the observation', page: 'plan', auto: (p) => !!(p.event && (p.event.mid || p.event.ingress)),
    coach: 'Find a transit you can see whole: the target high (airmass under about 2), the Sun well down, and an hour of baseline before ingress and after egress. The uncertainty of the predicted time grows with every orbit since the last measurement: add it to the window.' },
  { id: 'observe', label: 'Observe the night', page: 'observe', auto: (p) => has(p, 'images'),
    coach: 'On the night: the sky view shows where the target is, the transit window and the Moon. Keep the star on the same pixels, do not change the exposure during the transit, and take flats, darks and bias frames.' },
  { id: 'reduce', label: 'Reduce the images', page: 'photometry', auto: (p) => has(p, 'lightcurve'),
    coach: 'Photometry turns the frames into a light curve: choose the target and several comparison stars of similar brightness and colour, check the aperture against the seeing, and look at the comparison stars’ own light curves for clouds. Send the result to Analyze.' },
  { id: 'fit', label: 'Fit the light curve', page: 'analyze', auto: (p) => fitWith(p, (u) => u.lc),
    coach: 'Load the light curve (Data tab), check the baseline and errors (rescale them to the residual scatter if χ²/N is far from 1), free Rp/R★, the inclination, the mid-transit time and the airmass term, and run the fit.' },
  { id: 'rv', label: 'Add archival velocities', page: 'analyze', auto: (p) => has(p, 'rv'),
    coach: 'Data tab, “Find radial velocities”: the HIRES, HARPS and Lick archives on VizieR are searched at the star’s position. Add each instrument era as its own set (each has its own zero point and jitter). Earlier mid-transit times go on the Timing tab.' },
  { id: 'joint', label: 'Joint fit', page: 'analyze', auto: (p) => fitWith(p, (u) => u.lc && (u.rv || u.timing)),
    coach: 'Tie a/R★ to Kepler’s law (System tab) so photometry, velocities and times share one orbit; free the mass, the jitters, e and ω (or √e cos ω, √e sin ω), and M★, R★ with their catalogue priors. Run it.' },
  { id: 'compare', label: 'Compare models', page: 'analyze', auto: (p) => (p.fits || []).length >= 2,
    coach: 'Run the alternatives on the same data and error bars: circular against eccentric, with and without a trend. The Results tab reads Δ ln Z in words; a difference smaller than about 1 (or twice its error) does not choose a model, so keep the simpler one.' },
  { id: 'report', label: 'Report', page: 'analyze', auto: (p) => has(p, 'report'),
    coach: 'Results tab: the Methods paragraph (with the BibTeX of what it cites), the LaTeX tables and the session file, which reopens the whole analysis here or in the Python package. Submit the light curve to AAVSO Exoplanet Watch if it came from your telescope.' },
];
export const stepById = (id) => STEPS.find((s) => s.id === id) || null;

const now = () => new Date().toISOString();
/** A record with every list present and unknown fields dropped; null when `p` is not a project. */
export function normalize(p) {
  if (!p || typeof p !== 'object' || p.v !== 1) return null;
  const arr = (x) => (Array.isArray(x) ? x : []);
  return { v: 1, id: String(p.id || 'p' + Date.now().toString(36)), created: p.created || now(), updated: p.updated || p.created || now(), title: p.title || '',
    target: p.target && typeof p.target === 'object' ? { ...p.target } : null, site: p.site && typeof p.site === 'object' ? { ...p.site } : null, event: p.event && typeof p.event === 'object' ? { ...p.event } : null,
    files: arr(p.files).slice(-200), fits: arr(p.fits).slice(-100), done: p.done && typeof p.done === 'object' ? { ...p.done } : {}, step: stepById(p.step) ? p.step : null, notes: typeof p.notes === 'string' ? p.notes : '' };
}
/** A new project, optionally with a target. */
export function newProject(o = {}) { const t = now(); return normalize({ v: 1, created: t, updated: t, ...o }); }
/** `p` with `patch` applied: objects (target, site, event, done) are merged, lists replaced, `null` clears a field. */
export function merge(p, patch = {}) {
  const out = { ...p };
  for (const [k, v] of Object.entries(patch)) {
    if (['v', 'id', 'created'].includes(k)) continue;
    if (v === null) out[k] = k === 'done' ? {} : k === 'files' || k === 'fits' ? [] : null;
    else if (['target', 'site', 'event', 'done'].includes(k) && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(p[k] || {}), ...v };
    else out[k] = v;
  }
  out.updated = now();
  return normalize(out);
}
/** Each step with its state: { ...step, done (by hand or by the record), auto, current }. */
export function stepStates(p) {
  const cur = currentStep(p);
  return STEPS.map((s) => { const auto = !!(p && s.auto(p)), byHand = !!(p && p.done[s.id]); return { ...s, done: auto || byHand, auto, byHand, current: s.id === cur.id }; });
}
/** The step the user is on: the one they chose, else the first not done (the last when all are). */
export function currentStep(p) {
  if (p && p.step && stepById(p.step)) return stepById(p.step);
  const st = STEPS.find((s) => !(p && (s.auto(p) || p.done[s.id])));
  return st || STEPS[STEPS.length - 1];
}
/** Mark the current step (or `id`) done and move to the next step that is not done. */
export function advance(p, id) {
  const s = id ? stepById(id) : currentStep(p);
  if (!s) throw new Error(`there is no step “${id}”; the steps are ${STEPS.map((x) => x.id).join(', ')}`);
  const q = merge(p, { done: { [s.id]: now() }, step: null });
  const i = STEPS.indexOf(s), next = STEPS.slice(i + 1).find((x) => !(x.auto(q) || q.done[x.id]));
  return merge(q, { step: next ? next.id : null });
}
/** Where a step happens, relative to the site root, with the project's target and event in the address. */
export function stepHref(step, p) {
  const t = p && p.target, name = t && t.name ? encodeURIComponent(t.name) : '', ev = p && p.event;
  switch (step.page) {
    case 'search': return name ? `search/?planet=${name}` : 'search/';
    case 'plan': return name ? `plan/?planet=${name}` : 'plan/';
    case 'observe': return 'observe/' + (name ? `?planet=${name}` + (ev && ev.ingress && ev.egress && ev.midUtc ? `&transit=${encodeURIComponent([ev.ingress, ev.midUtc, ev.egress].join(','))}` : '') : '');
    case 'photometry': return 'analyze/photometry/';
    default: return 'analyze/' + (step.id === 'rv' ? (name ? `?planet=${name}&rv=find` : '?skipintro&tab=data') : step.id === 'fit' && name && !(p.fits || []).length ? `?planet=${name}` : `?skipintro&tab=${step.id === 'joint' ? 'fit' : step.id === 'fit' ? 'data' : 'results'}`);
  }
}
/** One fit as the project keeps it: the run's key numbers. `res` is api.results(), `use` the kinds of data. */
export function fitRecord(res, { page = 'analyze', run = null, use = {} } = {}) {
  const values = {};
  for (const x of res.parameters || []) values[x.key] = { median: x.median, plus: x.plus, minus: x.minus };
  for (const k of ['K', 'rpJup', 'mplanet', 'ecc', 'omega']) { const q = res.derived && res.derived[k]; if (q && !(k in values)) values[k] = { median: q.median, plus: q.plus, minus: q.minus }; }
  return { at: now(), page, run, free: (res.parameters || []).map((x) => x.key), use: { lc: !!use.lc, rv: !!use.rv, timing: !!use.timing }, logZ: res.logZ, logZerr: res.logZerr, chi2: res.chi2, n_data: res.n_data, converged: !!res.converged, values };
}

// ---- storage and the handle on window.__esl.project -------------------------------------------------------------
const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
export function loadProject(storage = store()) { try { return storage ? normalize(JSON.parse(storage.getItem(PROJECT_KEY) || 'null')) : null; } catch { return null; } }
export function saveProject(p, storage = store()) {
  if (!storage) return p;
  if (p) storage.setItem(PROJECT_KEY, JSON.stringify(p)); else storage.removeItem(PROJECT_KEY);
  if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new CustomEvent('esl-project', { detail: p }));
  return p;
}
const update = (fn) => { const p = loadProject() || newProject(); return saveProject(fn(p)); };

/**
 * window.__esl.project: what the assistant and the pages use. Every call returns the record (or null).
 *   get()                 the record, or null when there is no project
 *   set(patch)            merge a patch (creates the project when there is none); { target: {...} }, { step: 'rv' }, ...
 *   advance(stepId?)      mark the current (or named) step done and move to the next
 *   start(target?)        a new project, replacing the old one;  reset(): delete it
 *   addFile(file), addFit(fit)   append to files / fits (only when a project exists; returns null otherwise)
 *   steps()               every step with { id, label, page, coach, done, current, href }
 *   describe()            these functions with one line each
 */
export const PROJECT_API_DOC = {
  get: 'The project record, or null when there is none.',
  set: 'Merge a patch into the record (creates a project when there is none): target, site, event, done, step, notes, title.',
  advance: 'Mark the current step (or the one named) done and move to the next step not done.',
  start: 'Start a new project, replacing any other; optional target { name, ra, dec, per, tmid, t14 }.',
  reset: 'Delete the project, and the assistant\'s memory of it and its conversation.',
  addFile: 'Record a file the project produced: { kind: images|lightcurve|rv|session|report|other, name, page, n, note }.',
  addFit: 'Record a fit: { free, use, logZ, logZerr, chi2, n_data, converged, values }.',
  steps: 'The steps with their state: { id, label, page, coach, done, current, href }.',
  describe: 'This list.',
};
export function projectHandle() {
  const h = {
    get: () => loadProject(),
    set: (patch) => update((p) => merge(p, patch || {})),
    advance: (id) => update((p) => advance(p, id)),
    start: (target) => saveProject(newProject(target ? { target } : {})),
    // deleting the project also clears what the assistant kept about it (its project memory and the conversation),
    // so the next request starts clean; src/assistant/main.js listens for 'esl-project-deleted' when it is open
    reset: () => { const st = store(); if (st) for (const k of ASSISTANT_KEYS) { try { st.removeItem(k); } catch { /* storage unavailable */ } } const out = saveProject(null); if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new CustomEvent('esl-project-deleted')); return out; },
    addFile: (f) => { const p = loadProject(); if (!p || !f) return null; return saveProject(merge(p, { files: [...p.files, { at: now(), ...f }] })); },
    addFit: (f) => { const p = loadProject(); if (!p || !f) return null; return saveProject(merge(p, { fits: [...p.fits, { at: now(), ...f }] })); },
    steps: () => { const p = loadProject(); return stepStates(p).map((s) => ({ id: s.id, label: s.label, page: s.page, coach: s.coach, done: s.done, current: s.current, href: stepHref(s, p) })); },
    describe: () => Object.entries(PROJECT_API_DOC).map(([name, description]) => ({ name, description })),
  };
  return h;
}
/** Put the handle on window.__esl.project, and keep it there when a page replaces window.__esl. */
export function installProjectHandle() {
  if (typeof window === 'undefined') return null;
  const h = projectHandle(), put = () => { if (!window.__esl || typeof window.__esl !== 'object') window.__esl = {}; if (window.__esl.project !== h) window.__esl.project = h; };
  put(); for (const ms of [0, 300, 1500, 4000]) setTimeout(put, ms); window.addEventListener('load', put);
  return h;
}

// ---- the panel in the site bar --------------------------------------------------------------------------------
const ui = () => { try { return JSON.parse((store() && store().getItem(UI_KEY)) || '{}') || {}; } catch { return {}; } };
const setUI = (o) => { try { store().setItem(UI_KEY, JSON.stringify({ ...ui(), ...o })); } catch { /* storage unavailable */ } };
const PROJECT_CSS = `
.sitebar .siteproject { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 5px; height: calc(var(--bar-h) - 10px); padding: 0 9px; background: none; border: 1px solid var(--line2); border-radius: 999px; color: var(--dim); font: 600 10.5px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; cursor: pointer; white-space: nowrap; position: relative; }
.sitebar .siteproject b { color: var(--text); font-weight: 600; }
.sitebar .siteproject:hover, .sitebar .siteproject[aria-expanded=true] { color: #fff; background: #5fd4ff14; border-color: #5fd4ff66; }
.sitebar .siteproject:focus-visible { outline: 2px solid var(--model); outline-offset: 1px; }
.sitebar .siteproject .pj-here { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.sitebar .siteproject ~ nav, .sitebar .siteproject ~ .sitemenu { margin-left: 4px; }
.projpanel { position: fixed; z-index: 95; top: calc(var(--bar-h) + 6px); right: max(8px, env(safe-area-inset-right)); width: min(360px, calc(100vw - 16px)); max-height: calc(100dvh - var(--bar-h) - 16px); overflow: auto; background: #0b0f18; border: 1px solid var(--line2); border-radius: 10px; box-shadow: 0 14px 36px #000b; padding: 10px 12px 10px; color: var(--text); font: 12.5px/1.45 var(--sans); }
.projpanel .pj-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.projpanel .pj-head b { font-size: 13px; letter-spacing: .02em; }
.projpanel button { font: inherit; color: inherit; cursor: pointer; }
.projpanel .pj-x { background: none; border: 0; color: var(--dim); padding: 4px 6px; min-width: 32px; min-height: 32px; }
.projpanel .pj-meta { color: var(--dim); margin: 0 0 6px; font-size: 11.5px; }
.projpanel .pj-list { list-style: none; margin: 0 0 8px; padding: 0; display: grid; gap: 1px; }
.projpanel .pj-step { width: 100%; text-align: left; background: none; border: 0; border-radius: 6px; padding: 5px 6px; display: flex; align-items: center; gap: 8px; color: var(--dim); min-height: 30px; }
.projpanel .pj-step:hover { background: #ffffff0a; color: var(--text); }
.projpanel li.cur .pj-step { background: #5fd4ff17; color: #fff; }
.projpanel li.done .pj-step { color: #b7c2d8; }
.projpanel .pj-step small { margin-left: auto; color: var(--ok); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.projpanel .pj-n { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--line2); display: inline-grid; place-items: center; font-size: 10px; flex: none; }
.projpanel li.done .pj-n { background: #6fe3a522; border-color: #6fe3a588; color: var(--ok); }
.projpanel .pj-cur { border-top: 1px solid var(--line); padding-top: 8px; }
.projpanel .pj-coach { color: #c6d0e4; margin: 4px 0 8px; }
.projpanel .pj-row { display: grid; grid-template-columns: 56px 1fr; align-items: center; gap: 8px; margin: 0 0 8px; color: var(--dim); }
.projpanel input { background: #05070c; border: 1px solid var(--line2); border-radius: 6px; color: var(--text); padding: 6px 8px; font: inherit; min-width: 0; }
.projpanel .pj-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.projpanel .pj-go { background: #5fd4ff26; border: 1px solid #5fd4ff88; border-radius: 6px; padding: 6px 10px; min-height: 32px; color: #e9f8ff; }
.projpanel .pj-done { background: none; border: 1px solid var(--line2); border-radius: 6px; padding: 6px 10px; min-height: 32px; color: var(--dim); }
.projpanel .pj-foot { margin-top: 8px; text-align: right; }
.projpanel .pj-reset { background: none; border: 0; color: var(--faint); font-size: 11px; padding: 4px; }
.sitebar .siteproject .pj-ic { display: none; width: 16px; height: 16px; flex: none; color: var(--model); }
/* a phone: the word gives way to a checklist icon, in a chip as tall as a finger (the bar is 44 px there) */
@media (max-width: 640px) { .sitebar .siteproject .pj-l { display: none; } .sitebar .siteproject .pj-ic { display: block; } .sitebar .siteproject { height: calc(var(--bar-h) - 4px); min-width: 40px; justify-content: center; padding: 0 10px; font-size: 12px; } }
/* fingers: every control in the panel at least 40 px, 16 px text in the field (no zoom on focus in iOS) */
@media (pointer: coarse), (max-width: 640px) {
  .projpanel { font-size: 13.5px; padding: 10px 12px 12px; }
  .projpanel .pj-step { min-height: 40px; }
  .projpanel .pj-x { min-width: 40px; min-height: 40px; font-size: 16px; }
  .projpanel .pj-go, .projpanel .pj-done, .projpanel .pj-reset { min-height: 40px; }
  .projpanel .pj-reset { font-size: 12px; padding: 4px 8px; }
  .projpanel .pj-step small { font-size: 11px; }
  .projpanel .pj-n { width: 22px; height: 22px; font-size: 11.5px; }
  .projpanel .pj-meta { font-size: 12.5px; }
  .projpanel input { font-size: 16px; min-height: 40px; }
}
`;
const PJ_ICON = '<svg class="pj-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 3.6l1.3 1.3 2.2-2.4M1.8 8.6l1.3 1.3 2.2-2.4"/><path d="M7.5 4h6.7M7.5 9h6.7M7.5 13.5h6.7M2.4 13.5h1.6"/></svg>';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * A "Project" chip in the site bar (re-inserted if the bar is rebuilt) and the panel it opens: the checklist, the
 * coach note of the current step, and a button to the page of the next step with the project's target in its
 * address. `opts.page`: this page's section id (the bar's data-active by default); `opts.root`: the site root URL.
 * On the page where a step happens, its button dispatches 'esl-project-step' ({ detail: step id }) instead of
 * reloading, so the page can bring the right tab forward.
 */
export function mountProject(opts = {}) {
  if (typeof document === 'undefined' || new URLSearchParams(location.search).has('noproject')) return null;
  const bar = document.getElementById('sitebar'); if (!bar) return null;
  // once per page: the module can be evaluated twice (the dev server serves it under two URLs, a hot reload re-runs it)
  if (window.__eslProjectMount) return window.__eslProjectMount;
  document.querySelectorAll('.siteproject, #esl-project-panel').forEach((e) => e.remove());
  const handle = installProjectHandle();
  const page = () => { const a = opts.page || bar.dataset.active || ''; return a === 'analyze' && /\/photometry\//.test(location.pathname) ? 'photometry' : a; };
  const root = () => { const m = document.querySelector('meta[name=esl-root]'); return opts.root || new URL((m && m.content) || './', document.baseURI); };
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'siteproject'; chip.setAttribute('aria-haspopup', 'dialog'); chip.setAttribute('aria-expanded', 'false'); chip.setAttribute('aria-controls', 'esl-project-panel');
  const panel = document.createElement('div');
  panel.id = 'esl-project-panel'; panel.className = 'projpanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Observing project'); panel.hidden = true;
  document.body.append(panel);
  const place = () => { if (!bar.contains(chip)) { const at = bar.querySelector('.sitemenu') || bar.querySelector('nav'); bar.insertBefore(chip, at || null); } };
  if (!document.getElementById('esl-project-css')) { const st = document.createElement('style'); st.id = 'esl-project-css'; st.textContent = PROJECT_CSS; document.head.append(st); }
  const open = (on) => { panel.hidden = !on; chip.setAttribute('aria-expanded', String(on)); setUI({ open: on }); if (on) render(); };
  const go = (s, p) => {
    const url = new URL(stepHref(s, p), root()), samePage = s.page === page();
    // on the analyzer the step is a tab: no reload. Elsewhere, a page opened without the target is opened again with it.
    if (samePage && (page() === 'analyze' || !url.searchParams.get('planet') || new URLSearchParams(location.search).get('planet') === url.searchParams.get('planet'))) { window.dispatchEvent(new CustomEvent('esl-project-step', { detail: s.id })); open(false); return; }
    location.href = url.href;
  };
  function render() {
    const p = loadProject(), cur = currentStep(p), states = stepStates(p), n = states.filter((s) => s.done).length;
    chip.innerHTML = PJ_ICON + (p ? `<span class="pj-l">Project</span> <b>${n}/${STEPS.length}</b>${cur.page === page() ? '<i class="pj-here" title="The current step is on this page"></i>' : ''}` : '<span class="pj-l">Project</span>');
    chip.setAttribute('aria-label', p ? `Observing project, ${n} of ${STEPS.length} steps done` : 'Observing project');
    chip.title = p ? `Observing project${p.target ? ' · ' + p.target.name : ''}: ${cur.label}` : 'Start an observing project: a checklist from choosing a target to the report';
    if (panel.hidden) return;
    const here = page();
    if (!p) {
      panel.innerHTML = `<div class="pj-head"><b>Observing project</b><button class="pj-x" aria-label="Close">✕</button></div>
        <p class="pj-coach">A checklist that follows you through the site: choose a target, plan and observe a transit, reduce the images, fit the light curve, add archival radial velocities, fit everything together, compare models and write it up. It lives in this browser only.</p>
        <label class="pj-row"><span>Target</span><input id="pj-target" placeholder="planet, e.g. HAT-P-32 b" autocomplete="off"></label>
        <div class="pj-btns"><button class="pj-go" id="pj-start">Start the project</button></div>`;
      panel.querySelector('#pj-start').onclick = () => { const v = panel.querySelector('#pj-target').value.trim(); handle.start(v ? { name: v } : null); render(); };
    } else {
      const list = states.map((s, i) => `<li class="${s.done ? 'done' : ''}${s.current ? ' cur' : ''}"><button class="pj-step" data-id="${s.id}" aria-current="${s.current ? 'step' : 'false'}"><span class="pj-n">${s.done ? '✓' : i + 1}</span>${esc(s.label)}${s.page === here ? ' <small>here</small>' : ''}</button></li>`).join('');
      const nextS = STEPS[STEPS.indexOf(cur) + 1];
      const t = p.target;
      panel.innerHTML = `<div class="pj-head"><b>${esc(p.title || (t && t.name) || 'Observing project')}</b><button class="pj-x" aria-label="Close">✕</button></div>
        ${((m) => (m.length ? `<p class="pj-meta">${m.join(' · ')}</p>` : ''))([t && p.title ? esc(t.name) : '', t && Number.isFinite(t.per) ? `P ${Number(t.per.toPrecision(7))} d` : '', p.event && p.event.night ? `night of ${esc(p.event.night)}` : '', p.files.length ? `${p.files.length} file${p.files.length > 1 ? 's' : ''}` : '', p.fits.length ? `${p.fits.length} fit${p.fits.length > 1 ? 's' : ''}` : ''].filter(Boolean))}
        <ol class="pj-list">${list}</ol>
        <div class="pj-cur"><b>${STEPS.indexOf(cur) + 1}. ${esc(cur.label)}</b><p class="pj-coach">${esc(cur.coach)}</p>
        ${cur.id === 'target' ? `<label class="pj-row"><span>Target</span><input id="pj-target" value="${esc(t ? t.name : '')}" placeholder="planet name" autocomplete="off"></label>` : ''}
        <div class="pj-btns">${cur.page === here ? `<button class="pj-go" data-go="${cur.id}">Show me here</button>` : `<button class="pj-go" data-go="${cur.id}">Go to ${esc(cur.page === 'photometry' ? 'Photometry' : cur.page[0].toUpperCase() + cur.page.slice(1))} →</button>`}
          <button class="pj-done">${states.find((s) => s.id === cur.id).done ? 'Next step' : 'Mark done'}${nextS ? ' · ' + esc(nextS.label) : ''}</button></div></div>
        <div class="pj-foot"><button class="pj-reset" title="Delete this project from this browser">Delete project</button></div>`;
      panel.querySelectorAll('.pj-step').forEach((b) => (b.onclick = () => { handle.set({ step: b.dataset.id }); render(); }));
      panel.querySelector('[data-go]').onclick = () => { const ti = panel.querySelector('#pj-target'); if (ti && ti.value.trim()) handle.set({ target: { name: ti.value.trim() } }); go(cur, loadProject()); };
      panel.querySelector('.pj-done').onclick = () => { const ti = panel.querySelector('#pj-target'); if (ti && ti.value.trim()) handle.set({ target: { name: ti.value.trim() } }); handle.advance(cur.id); render(); };
      panel.querySelector('.pj-reset').onclick = () => { if (confirm('Delete this observing project? Its checklist, and what the assistant remembers of it (the project and the conversation), are cleared. Analyses saved in this browser are kept.')) { handle.reset(); open(false); chip.focus(); } };
    }
    panel.querySelector('.pj-x').onclick = () => { open(false); chip.focus(); };
  }
  chip.addEventListener('click', () => open(panel.hidden));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); chip.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !chip.contains(e.target)) open(false); });
  window.addEventListener('esl-project', render);
  window.addEventListener('storage', (e) => { if (e.key === PROJECT_KEY) render(); });
  new MutationObserver(() => { if (!bar.contains(chip)) { place(); render(); } }).observe(bar, { childList: true });
  place(); render();
  if (ui().open && loadProject() && !matchMedia('(max-width: 640px)').matches) open(true);
  return (window.__eslProjectMount = { handle, render, open });
}
