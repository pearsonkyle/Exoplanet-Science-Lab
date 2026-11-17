// The assistant's tool registry: the declarative table of toolspec.js joined with handlers that act through
// an `api` object with the shape of the analyzer's window.__esl.api (makeAPI() in src/main.js). In the page
// that is the real thing; in the MCP server and in the tests it is docApi.js, the same surface on a session
// document. Handlers never touch the DOM: what needs the page (figures, the rendered comparison table) comes
// through ctx.page, and files through ctx.files.
//
// createTools({ api, files, page, fetchJson, where }) ->
//   { specs, names, call(name, args, { signal, onProgress }) -> { ok, text, data }, confirmFor(name, args) -> sentence | null,
//     stateCard() -> text, runs }
//   files: { list() -> [{ name, size, origin, about }], readText(name) -> Promise<string>, write(name, data, mime) -> Promise<{ name, size }> }
//   page:  { comparison() -> { runs, verdict, cautions, note } | null, figure(which) -> Promise<Blob | null> }   (browser only)
//
// Results are compact on purpose: counts, key numbers and sentences. Data stay where they are and are named
// by handle; a model with a small context never sees an array.

import { TOOL_SPECS, toolsFor, checkArgs } from './toolspec.js';
import * as ops from './ops.js';
import { loadIndex, searchNames } from '../core/catalog.js';
import { LD_LAWS } from '../core/limbdark.js';
import { projectReport } from '../core/report.js';
import { explainMethod, extractSymbol, SOURCE_FILE } from './knowledge.js';

export { TOOL_SPECS };
const sig = ops.sig;
const cut = (s, n) => (s.length > n ? s.slice(0, n) + `… [${s.length - n} chars cut]` : s);
const priorText = (p) => (!p ? '' : p.type === 'normal' ? `normal(${sig(p.a, 9)}, sd ${sig(p.b, 4)})` : `uniform(${sig(p.a, 9)} .. ${sig(p.b, 9)})`);

// read_source: the code as published on GitHub (the browser), or the files of this checkout (the MCP server passes readSource)
const REPO_RAW = 'https://raw.githubusercontent.com/pearsonkyle/Exoplanet-Science-Lab/main', REPO_BLOB = 'https://github.com/pearsonkyle/Exoplanet-Science-Lab/blob/main';

/** The words of a request or a query that can tell examples apart: numbers always count ("40"), filler does not. */
export const exampleWords = (text) => String(text || '').toLowerCase().split(/[^a-z0-9+-]+/).map((w) => w.replace(/^-+|-+$/g, ''))
  .filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !['the', 'and', 'example', 'examples', 'with', 'from', 'open', 'fit', 'then', 'tell', 'its', 'for', 'show', 'load', 'run', 'give'].includes(w));
/** How well an example matches those words: a word of the title counts 2, of its description 1, a number 3 more. */
export function exampleScore(e, words) {
  const title = `${e.id} ${e.title}`.toLowerCase(), about = String(e.about || '').toLowerCase();
  return words.reduce((a, w) => a + (title.includes(w) ? 2 : about.includes(w) ? 1 : 0) + ((title.includes(w) || about.includes(w)) && /^\d+$/.test(w) ? 3 : 0), 0);
}

export function createTools(ctx) {
  const { api, files, page = null, fetchJson = null, where = 'browser' } = ctx;
  const readSource = ctx.readSource || defaultReadSource;
  const has = (m) => typeof api[m] === 'function';
  const specs = [...toolsFor(where).filter((t) => !t.needs || has(t.needs)), ...describedTools(api)].map((t) => (t.name === 'load_example' ? withExampleList(t) : t)), runs = [];
  /** load_example names every example this page has, with its title: a small model picks from a list, it does not guess ids. */
  function withExampleList(t) {
    let ex = []; try { ex = api.examples() || []; } catch { /* no examples here */ }
    if (!ex.length) return t;
    return { ...t, description: `Open a worked example. The examples (id: title): ${ex.map((e) => `${e.id}: ${e.title}`).join('; ')}. It opens with its stored posterior when it has one; fresh=true opens it without a result. Replaces what is loaded.`,
      parameters: { ...t.parameters, properties: { ...t.parameters.properties, id: { ...t.parameters.properties.id, description: 'An id from the list above, or words of its title ("orbital decay of WASP-12 b").' } } } };
  }
  let catalog = null, nextRun = 1, lastSearch = null;

  const doc = (withResult = false) => api.exportSession(withResult);
  const tRef = () => (api.state().lightCurve || {}).timeReference || 0;
  /** tmid may be given as an absolute date: the api takes days from the time reference. */
  const relTime = (key, v) => (ops.isTimeKey(key) && v > 1e5 && tRef() > 0 ? v - tRef() : v);
  const paramList = () => api.state().parameters;
  const STAR = ['teff', 'feh', 'mstar', 'rstar', 'logg'];
  function needKeys(keys, { star = false } = {}) {
    const have = paramList().map((p) => p.key), bad = keys.filter((k) => !have.includes(k) && !(star && STAR.includes(k)));
    if (bad.length) throw new Error(`not parameters of the current set-up: ${bad.join(', ')}. The parameters are: ${have.join(', ')}${star ? ', and the star\'s teff, feh, logg, mstar, rstar' : ''}.` + (bad.some((k) => /^(mplanet|K)/.test(k)) ? ' The planet mass appears once Kepler mode is on or velocities are loaded.' : '') + (bad.some((k) => k.split('@')[0] === 'a2') ? ' a2 exists only when the light curve has an airmass column.' : ''));
  }
  /** Change the session document and load it back (for what the api has no call for). */
  function roundTrip(fn) { const out = fn(doc(false)); api.importSession(out.doc); return out; }
  /** The planets' letters and key suffixes as the api reports them. */
  const sfxOf = (letter) => { const s = api.state(), L = letter ? String(letter).trim().slice(-1) : s.planets[0]; if (!s.planets.includes(L)) throw new Error(`there is no planet "${letter}": the planets are ${s.planets.join(', ')}`); return { letter: L, sfx: L === s.planets[0] ? '' : L }; };
  async function sourceText(args, what) {
    if (args.file) return { text: await files.readText(args.file), name: args.name || args.file };
    if (typeof args.text === 'string' && args.text.trim()) return { text: args.text, name: args.name || what };
    const have = files.list().map((f) => f.name);
    throw new Error(`give "file" (the name of an attached file) or "text". ${have.length ? 'Files available: ' + have.join(', ') + '.' : 'No file is attached: ask the user to attach one (the paperclip, or drop it on the panel).'}`);
  }
  const dataLines = (d = doc(false)) => ops.describeData(d).map(ops.dataLine);
  /** Would replacing what is loaded lose something of the user's? (a simulated stand-in without a fit is nothing to lose) */
  function somethingToLose() {
    try { const s = api.state(); if (s.hasResult || s.radialVelocity.length || s.timing.points) return true; const L = doc(false).data.light_curve; return !!(L && L.time.length && !L.synthetic); } catch { return true; }
  }
  function recordRun(label) {
    const d = doc(true); if (!d.result) return null;
    const rec = ops.runRecord(d, { id: nextRun++, label });
    const pr = pageRuns();
    if (pr && pr.length) rec.pageId = (pr.find((r) => r.showing) || pr[pr.length - 1]).id;
    else if (page && page.comparison) { try { const c = page.comparison(); if (c && c.runs.length) rec.pageId = Math.max(...c.runs.map((r) => r.id)); } catch { /* the table is optional */ } }
    runs.push(rec); return rec;
  }
  /** The comparison of the runs on the current data: the page's own table when it has every run, else the same rules on the run log. */
  /** The analyzer's own run history (api.runs()), or null where there is none. */
  const pageRuns = () => { if (!has('runs')) return null; try { const r = api.runs(); return Array.isArray(r) ? r : null; } catch { return null; } };
  /**
   * The comparison of runs. In the page it is the analyzer's own: its run history and its compare() of every run
   * with the best one, in its words. Elsewhere (the MCP server, or runs the page no longer holds) the same rules
   * on the log of this conversation (ops.compareRuns). Nothing is computed here.
   */
  function comparison(ids) {
    const pool = ids ? runs.filter((r) => ids.includes(r.id)) : runs, mine = ops.compareRuns(pool, ids ? undefined : ops.dataKey(doc(false)));
    const pr = pageRuns();
    if (pr && has('compare')) {
      const wanted = ids ? pool.map((r) => r.pageId) : pr.filter((r) => r.same_data).map((r) => r.id), here = pr.filter((r) => wanted.includes(r.id));
      if (here.length && here.length === wanted.length && here.length >= (ids ? pool.length : 1)) {
        try {
          const label = (id) => { const r = runs.find((x) => x.pageId === id); return '#' + id + (r && r.label ? ' ' + r.label : ''); };
          const lnz = (r) => (r.converged ? `${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}` : `> ${r.logZ.toFixed(1)} (not converged)`);
          const conv = here.filter((r) => r.converged), top = (conv.length ? conv : here).reduce((a, b) => (b.logZ > a.logZ ? b : a));
          const pairs = here.filter((r) => r !== top).map((r) => ({ r, c: api.compare(r.id, top.id) }));
          const rows = here.map((r) => { const p = pairs.find((x) => x.r === r); return { run: label(r.id), free: (r.labels || (r.free || []).join(', ')), limb_darkening: r.model, lnZ: lnz(r), delta_lnZ: p && p.c.comparable ? `${p.c.delta_lnZ.toFixed(2)} ± ${p.c.delta_lnZ_err.toFixed(2)}` : null, reading: p ? p.c.reading : 'reference', cautions: (r.cautions || []).length }; });
          const verdict = here.length === 1 ? 'One run so far: an evidence means something only next to another model fitted to the same data.' : pairs.map((p) => p.c.words).join(' ');
          return { source: 'the analyzer\'s run history and its own comparison of each run with the best one', runs: rows, verdict, cautions: [...new Set([...pairs.flatMap((p) => p.c.cautions), ...ops.sameModel(pool.filter((x) => wanted.includes(x.pageId)))])], rule: mine.rule };
        } catch { /* fall through to the rules restated in ops.js */ }
      }
    }
    if (ids) return { source: 'the runs of this experiment, read with the rules of the analyzer\'s comparison table', ...mine };
    if (page && page.comparison) {
      let c = null; try { c = page.comparison(); } catch { c = null; }
      if (c && c.runs.length && c.runs.length >= mine.runs.length) {
        const label = (id) => { const r = runs.find((x) => x.pageId === id); return r && r.label ? ' ' + r.label : ''; };
        return { source: 'the analyzer\'s "Runs & model comparison" table', runs: c.runs.map((r) => ({ run: '#' + r.id + label(r.id), free: r.name, limb_darkening: r.law, lnZ: r.lnZ, delta_lnZ: r.delta || null, reading: r.reading, cautions: r.nCautions || 0 })), verdict: c.verdict, cautions: [...c.cautions, ...ops.sameModel(runs.filter((x) => x.dataKey === ops.dataKey(doc(false))))], rule: c.note || mine.rule };
      }
    }
    return { source: 'this conversation\'s runs, read with the rules of the analyzer\'s comparison table', ...mine };
  }
  /** What identifies a set-up (not its fit result): to know when stepping back has reached it. */
  const setupKey = (d) => JSON.stringify([d.name, d.star, d.limb_darkening, d.planets, !!d.kepler, d.phase || null, d.nbody || null, (d.fit.free || []).map((f) => [f.key, f.prior]), d.fit.fixed, d.fit.use, ops.dataKey({ ...d, fit: { use: { lc: true, rv: true, timing: true } } })]);
  /**
   * Back to the set-up an experiment started from. The analyzer's undo is tried first, because it keeps the run
   * history (and with it the analyzer's own comparison); loading the saved document is the fallback.
   */
  function backTo(baseline, key) {
    for (let i = 0; i < 40; i++) { let now; try { now = setupKey(doc(false)); } catch { break; } if (now === key) return 'undo'; if (api.undo() === false) break; }
    try { if (setupKey(doc(false)) === key) return 'undo'; } catch { /* load it instead */ }
    api.importSession(baseline); return 'import';
  }
  async function fit(label, onProgress, signal) {
    const stop = () => { try { api.stop(); } catch { /* not running */ } };
    if (signal) { if (signal.aborted) throw new Error('stopped by the user'); signal.addEventListener('abort', stop, { once: true }); }
    try { const r = await api.run({ onProgress }); const rec = recordRun(label); return { result: r, rec }; }
    finally { if (signal) signal.removeEventListener('abort', stop); }
  }

  /** The first planet's T mid as an absolute date (BJD) when the data are dated, with its value as the api holds it. */
  const tmidNow = () => { const s = api.state(), p = s.parameters.find((x) => x.key === 'tmid'), tr = s.lightCurve.timeReference || 0; return p ? { p, tr, abs: p.value > 1e5 ? p.value : p.value + tr, per: (s.parameters.find((x) => x.key === 'per') || {}).value } : null; };
  /** Set T mid to a value in the api's own frame, its prior moved by the same amount. */
  function shiftTmid(value) {
    const { p } = tmidNow(), dt = value - p.value;
    if (p.prior) api.setPrior('tmid', p.prior.type === 'uniform' ? { type: 'uniform', a: p.prior.a + dt, b: p.prior.b + dt } : { ...p.prior, a: p.prior.a + dt });
    api.setValue('tmid', value);
  }
  /**
   * The date a simulation of a given night is centred on: a BJD (or days from the time reference), or "planned", the
   * mid-transit BJD of the event chosen on the plan page (ctx.planned). Returns { abs, note } or throws.
   */
  function nightOf(mid) {
    const now = tmidNow(); if (!now) throw new Error('this set-up has no tmid to move');
    const pv = ctx.planned ? ctx.planned() : null, planned = pv === null || pv === undefined || pv === '' ? NaN : Number(pv);
    let abs;
    if (/^\s*(planned|plan|that night|the planned (night|event|transit))\s*$/i.test(String(mid))) { if (!Number.isFinite(planned)) throw new Error('no event was planned on the plan page in this project: give mid_transit as a BJD'); abs = planned; }
    else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(String(mid).trim())) {
      // a UTC time is not a BJD; it is taken as the planned event when it is that event's time (within the hour)
      const jd = Date.parse(String(mid).trim().replace(/Z?$/, 'Z')) / 864e5 + 2440587.5;
      if (!(Number.isFinite(planned) && Math.abs(jd - planned) < 1 / 24)) throw new Error('mid_transit is a BJD_TDB, not a UTC time: give "planned" for the event chosen on the plan page, or the BJD_TDB a tool returned');
      abs = planned;
    } else { const v = Number(mid); if (!Number.isFinite(v)) throw new Error('mid_transit is a BJD such as 2461360.9, days from the time reference, or "planned"'); abs = v > 1e5 ? v : v + now.tr; }
    const orbits = now.per > 0 ? Math.round((abs - now.abs) / now.per) : null;
    const off = Number.isFinite(planned) && Math.abs(abs - planned) > 0.3 ? ` This is not the planned event (mid-transit BJD_TDB ${planned} on the plan page): to simulate that night, call simulate_light_curve with mid_transit "planned".` : '';
    return { abs, note: `T mid was set to the requested mid-transit${orbits !== null ? ` (${orbits} orbits from the catalogue epoch)` : ''}, and its prior moved with it.${off}` };
  }
  /** Simulate, centred on `abs` when given; checked afterwards, and done again when the analyzer moved the time reference. */
  function simulateAt(abs, run) {
    if (abs === null) return run();
    const before = tmidNow(); shiftTmid(abs > 1e5 && before.p.value <= 1e5 ? abs - before.tr : abs);
    let out = run(); const after = tmidNow();
    if (Math.abs(after.abs - abs) > 1e-4) { shiftTmid(after.p.value > 1e5 || !after.tr ? abs : abs - after.tr); out = run(); }
    return out;
  }

  const H = {
    // ---- system ---------------------------------------------------------------------------------------------
    get_state() {
      const s = api.state(), d = doc(false);
      return { system: s.name, planets: s.planets, showing: s.showing, kepler_mode: s.kepler, star: Object.fromEntries(Object.entries(s.star).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, sig(v, 6)])),
        limb_darkening: { ...s.limbDarkening, coefficient_names: LD_LAWS[s.limbDarkening.law].names }, time_reference: s.lightCurve.timeReference,
        data: ops.describeData(d), in_fit: { light_curve: s.lightCurve.inFit, radial_velocity: s.rvInFit, timing: s.timing.inFit },
        parameters: s.parameters.map((p) => ({ key: p.key, label: p.label, unit: p.unit || undefined, value: sig(p.value, 10), free: p.free, prior: p.prior ? priorText(p.prior) : undefined, group: p.group })),
        sampler: s.sampler, fit_running: s.running, has_result: s.hasResult, chi2_at_current_values: sig(s.chi2, 6) };
    },
    list_examples: () => ({ examples: api.examples().map((e) => ({ id: e.id, title: e.title, about: e.about, kinds: e.kinds })) }),
    async load_example({ id, fresh }, opts = {}) {
      // an id, or words of a title or description ("orbital decay of WASP-12 b", "40 mid-transit times")
      let hit; const ex = api.examples(), q = String(id || '').toLowerCase(), words = exampleWords(q), score = (e) => exampleScore(e, words);
      hit = ex.find((e) => e.id === id) || ex.find((e) => e.id.includes(q) || e.title.toLowerCase().includes(q)) || ex.map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e)[0];
      if (!hit) throw new Error(`no example "${id}". The examples are: ${ex.map((e) => `${e.id} (${e.title})`).join('; ')}.`);
      // the user's own words describe another example much better than the one chosen ("the example with 40 mid-transit times"
      // and the model picked "multi"): open the one the user described, and say so
      let switched = '';
      if (opts.request) {
        const rw = exampleWords(opts.request), sc = (e) => exampleScore(e, rw);
        const best = ex.map((e) => ({ e, s: sc(e) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.e !== hit && best.s >= sc(hit) + 3) { switched = `the request describes "${best.e.title}", not "${hit.title}": that example was opened`; hit = best.e; }
      }
      await api.loadExample(hit.id, { fresh: !!fresh });
      const s = api.state(); if (s.hasResult) recordRun('stored example result');
      return { ...(switched ? { note: switched } : {}), opened: hit.title, system: s.name, data: dataLines(), free: s.parameters.filter((p) => p.free).map((p) => p.key), has_result: s.hasResult, next: (hit.kinds || []).length === 1 && hit.kinds[0] === 'ephemeris' ? 'This example is a list of mid-transit times: fit_ephemeris fits a linear and a quadratic ephemeris (period, T0, dP/dt, BIC of each); timing_periodogram searches the O − C residuals for a periodic signal. run_fit is not needed for those.' : s.hasResult ? 'It opened with a stored result (get_results). run_fit samples it again.' : 'Choose free parameters (set_free) and call run_fit.' };
    },
    async search_catalog({ query, limit = 8 }) {
      if (!fetchJson) throw new Error('the catalogue is not available here');
      if (!catalog) catalog = await loadIndex(fetchJson);
      const hits = searchNames(catalog, query, limit);
      return { snapshot: catalog.date, matches: hits.map((h) => ({ name: h.label, type: h.type, host: h.host, has_transit: h.transit, has_rv: h.rv })), note: hits.length ? undefined : `nothing matches "${query}" among ${catalog.nplanets} planets` };
    },
    async lookup_planet({ name, kinds = ['transit'] }) {
      // observations the user loaded outlive a change of system: only a simulated stand-in is replaced
      const before = doc(false), L0 = before.data.light_curve, keepLC = !!(L0 && L0.time.length && !L0.synthetic), rv0 = before.data.radial_velocity || [], tim0 = before.data.timing || [];
      try { await api.lookup(name, kinds); }
      catch (err) { let held = ''; try { held = api.state().name; } catch { /* no state */ } throw new Error(`${String(err.message || err).replace(/\.$/, '')}. Nothing was loaded: the analyzer still holds ${held || 'what it held before'}, which is not "${name}". Do not fit it or report results as ${name}: tell the user, or choose another planet.`); }
      const kept = []; let moved = null;
      if (keepLC || rv0.length || tim0.length) {
        const d = doc(false);
        if (keepLC) {
          d.data.light_curve = L0; d.time_reference = before.time_reference || 0; d.fit.use = { ...d.fit.use, lc: true };
          const mid = 0.5 * (L0.time[0] + L0.time[L0.time.length - 1]), shiftPrior = (pr, dt) => (pr ? (pr.type === 'uniform' ? { ...pr, a: pr.a + dt, b: pr.b + dt } : { ...pr, a: pr.a + dt }) : pr);
          d.planets.forEach((pl, i) => {
            const q = pl.parameters, n = Math.round((mid - q.tmid) / q.per), dt = n * q.per, key = i ? `tmid@${pl.letter}` : 'tmid'; if (!n || !Number.isFinite(dt)) return;
            q.tmid += dt; if (d.fit.priors && d.fit.priors[key]) d.fit.priors[key] = shiftPrior(d.fit.priors[key], dt);
            for (const f of d.fit.free) if (f.key === key) f.prior = shiftPrior(f.prior, dt);
            if (!i) moved = { orbits: n, tmid: q.tmid };
          });
          kept.push(ops.dataLine(ops.describeData(before).find((x) => x.handle === 'light_curve')));
        }
        if (rv0.length) { d.data.radial_velocity = rv0; d.fit.use = { ...d.fit.use, rv: !!(before.fit.use || {}).rv, ...(keepLC ? {} : { lc: false }) }; d.kepler = d.kepler || before.kepler; kept.push(`${rv0.length} velocity set(s)`); }   // no real light curve: the simulated stand-in stays out of the fit
        if (tim0.length) { const letters = d.planets.map((x) => x.letter); d.data.timing = tim0.map((r) => (letters.includes(r.planet) ? r : { ...r, planet: letters[0] })); kept.push(`${tim0.length} mid-transit times`); }
        api.importSession(d);
      }
      // velocities and no light curve: start from the orbit, not from a transit set-up the data cannot measure
      let rvSetup = null;
      if (!keepLC && rv0.length && !tim0.length) {
        const st = api.state(), keys = st.parameters.map((p) => p.key), want = ['mplanet', 'per', 'ecc', 'omega', 'tmid', ...keys.filter((k) => /^jit@rv\d+$/.test(k))].filter((k) => keys.includes(k));
        for (const p of st.parameters) if (p.free && !want.includes(p.key)) api.setFree(p.key, false);
        for (const k of want) api.setFree(k, true);
        rvSetup = want;
      }
      const s = api.state(), val = (k) => sig((s.parameters.find((p) => p.key === k) || {}).value, 10), tp = (s.parameters.find((p) => p.key === 'tmid') || {}).prior;
      return { loaded: s.name, planets: s.planets, period_d: val('per'), rprs: val('rprs'), mid_transit: sig(val('tmid') + s.lightCurve.timeReference, 12), star: { teff: s.star.teff, rstar: s.star.rstar, mstar: s.star.mstar }, kepler_mode: s.kepler,
        kept_data: kept.length ? kept : undefined, data: kept.length ? undefined : dataLines(),
        tmid_note: moved ? `T mid was moved ${moved.orbits} orbits from the catalogue epoch onto the data; its prior is ${priorText(tp)} days from the time reference. A catalogue ephemeris drifts over many orbits: if the fitted tmid sits at an edge of that prior, widen it with set_prior.` : undefined,
        free: s.parameters.filter((p) => p.free).map((p) => p.key), note: 'Values are from the NASA Exoplanet Archive snapshot with wide priors.' + (kept.length ? ' The observations that were loaded are kept.' : ' No observations were fetched: any light curve shown is a simulated stand-in.'),
        ...(rvSetup ? { set_up: `Only velocities are loaded, so the orbit was set up for them: free ${rvSetup.join(', ')} (rprs and inc cannot be measured without a light curve).` } : {}),
        next: rvSetup ? 'The set-up is ready for the velocities: check the priors with get_state if needed, then run_fit.' : kept.length ? 'Choose free parameters with set_free (usually rprs, inc, tmid), then run_fit.' : 'Load the user\'s data (load_light_curve with an attached file) or simulate_light_curve, then run_fit.' };
    },
    new_session({ name }) {
      if (!ctx.blankSession) throw new Error('new_session is not available here');
      api.importSession(ctx.blankSession(name)); const s = api.state();
      return { started: s.name, planets: s.planets, parameters: Object.fromEntries(s.parameters.map((p) => [p.key, sig(p.value, 8)])), note: 'These are placeholders, not a real system.', next: 'set_parameters with the real values (and the star with teff, rstar, mstar), then load data.' };
    },
    set_parameters({ values }) {
      const keys = Object.keys(values || {}); if (!keys.length) throw new Error('values is empty: give a map such as {"rprs": 0.12}');
      needKeys(keys, { star: true });
      if (keys.some((k) => k.split('@')[0] === 'ars') && api.state().kepler) throw new Error('Kepler mode is on, so a/R* follows from the stellar mass and radius, the period and the planet mass. Change those, or turn Kepler mode off (set_kepler).');
      const set = {}; for (const k of keys) { api.setValue(k, relTime(k, values[k])); set[k] = sig(relTime(k, values[k]), 10); }
      const s = api.state();
      return { set, chi2_at_current_values: sig(s.chi2, 6), note: s.hasResult ? undefined : 'Any earlier fit result was cleared: the values changed.' };
    },
    add_planet(args) {
      if (has('addPlanet')) { const letter = api.addPlanet({ ...(args.letter ? { letter: String(args.letter).trim().slice(-1) } : {}), ...(args.parameters ? { values: args.parameters } : {}) }), s = api.state(); return { added: letter, planets: s.planets, its_keys: s.parameters.filter((p) => p.key.endsWith('@' + letter)).map((p) => `${p.key} = ${sig(p.value, 7)}`), next: 'Set its values with set_parameters (keys carry the letter) and free what the data can measure.' }; }
      const o = roundTrip((d) => ops.addPlanet(d, args)); return { added: o.letter, planets: api.state().planets, its_keys: o.keys, next: 'Set its values with set_parameters (keys carry the letter) and free what the data can measure.' };
    },
    remove_planet({ letter }) {
      if (has('removePlanet')) { const L = String(letter).trim().slice(-1); api.removePlanet(L); return { removed: L, planets: api.state().planets }; }
      const o = roundTrip((d) => ops.removePlanet(d, letter)); return { removed: o.removed, planets: api.state().planets };
    },
    set_kepler({ on }) { api.setKepler(!!on); const s = api.state(); return { kepler_mode: s.kepler, note: s.kepler ? 'a/R* now follows from M*, R*, the period and the planet mass; mstar and rstar are parameters.' : 'a/R* is now a fixed number (ars).', parameters: s.parameters.map((p) => p.key) }; },
    set_limb_darkening(args) {
      if (has('setLimbDarkening')) {
        const o = api.setLimbDarkening({ ...(args.law ? { law: args.law } : {}), ...(args.coefficients ? { coeffs: args.coefficients } : args.follow_star ? { coeffs: 'star' } : {}), ...(args.follow_star !== undefined ? { mode: args.follow_star ? 'star' : 'coeffs' } : {}), ...(args.band !== undefined ? { band: args.band } : {}) }), names = LD_LAWS[o.law].names;
        return { law: o.law, mode: o.mode === 'star' ? 'the coefficients follow the star (Teff, [Fe/H]) in the band' : 'the coefficients are parameters', band: o.band || undefined, coefficients: Object.fromEntries(names.map((n, i) => [`ld${i} (${n})`, sig((o.coeffs || [])[i], 6)])) };
      }
      if (!args.law) throw new Error('give "law"'); if (args.follow_star || args.band !== undefined) throw new Error('limb darkening that follows the star is only available in the web app: give the coefficients');
      const o = roundTrip((d) => ops.setLimbDarkening(d, args));
      return { law: o.law, coefficients: Object.fromEntries(o.names.map((n, i) => [`ld${i} (${n})`, o.coefficients[i]])), note: o.defaulted ? 'The coefficients are the law\'s generic defaults, not values for this star and band: free them (set_free) or set them.' : undefined };
    },
    async set_phase_curve(args) {
      const { letter, sfx } = sfxOf(args.planet), on = args.on !== false;
      if (has('setPhase')) {
        // the analyzer's call acts on the planet on show
        if (api.state().showing !== letter) api.showPlanet(letter);
        api.setPhase(on ? { ...(args.mode ? { mode: args.mode } : {}), ...(args.lmax ? { lmax: args.lmax } : {}) } : null);
        if (on) for (const [k, v] of Object.entries(args.parameters || {})) api.setValue(sfx ? `${k}@${sfx}` : k, v);
      } else roundTrip((d) => ops.setPhase(d, { ...args, planet: letter }));
      const keys = paramList().filter((p) => p.group === 'phase' && (p.key.split('@')[1] || '') === sfx);
      return { planet: letter, own_light: on, keys: keys.map((p) => `${p.key} = ${sig(p.value, 6)}`), next: on ? 'Free what the data can measure (set_free, e.g. fpfs), then run_fit. A phase curve needs data that cover the eclipse or the whole orbit.' : undefined };
    },
    async set_moon(args) {
      const { letter, sfx } = sfxOf(args.planet), on = args.on !== false;
      if (has('setMoon')) { if (api.state().showing !== letter) api.showPlanet(letter); api.setMoon(on ? (args.parameters && Object.keys(args.parameters).length ? args.parameters : true) : false); }
      else roundTrip((d) => ops.setMoon(d, { ...args, planet: letter }));
      const keys = paramList().filter((p) => p.group === 'moon' && (p.key.split('@')[1] || '') === sfx);
      return { planet: letter, moon: on, keys: keys.map((p) => `${p.key} = ${sig(p.value, 6)}`), next: on ? 'Free the moon parameters the data can measure (set_free), then run_fit; compare with a run without the moon (run_experiment) before claiming one.' : undefined };
    },
    async set_nbody(args) {
      if (has('setNbody')) api.setNbody(args.on ? { ...(args.epoch !== undefined ? { epoch: args.epoch } : {}), ...(args.linear !== undefined ? { linear: args.linear } : {}) } : null);
      else roundTrip((d) => ops.setNbody(d, args));
      return { nbody: !!args.on, note: args.on ? 'Mid-transit times and velocities now come from an N-body integration; the light curve and mid-eclipse times stay Keplerian. An evidence from this model is not comparable with a Keplerian fit.' : 'Back to Keplerian orbits.' };
    },
    async companion_search({ options }) {
      const r = await api.companionSearch(options || {});
      lastSearch = r; return { best_companion: slim(r, 2200), next: r && r.significant === false ? 'The search does not find a significant companion: say so; do not add one.' : 'add_companion adds it as a planet with N-body dynamics on; then run_fit, and run_experiment kind "companion" compares the fit with and without it.' };
    },
    async add_companion({ candidate }) {
      const cell = candidate && typeof candidate === 'object' ? candidate : lastSearch;
      if (!cell) throw new Error('run companion_search first: add_companion takes what it found');
      const letter = await api.addCompanion(cell), s = api.state();
      return { added: letter, planets: s.planets, free: s.parameters.filter((p) => p.free).map((p) => p.key), next: 'run_fit fits the times with the companion; run_experiment kind "companion" compares the fit with and without it.' };
    },

    // ---- data -----------------------------------------------------------------------------------------------
    describe_data() { const s = api.state(), d = ops.describeData(doc(false)); return { data: d, in_fit: { light_curve: s.lightCurve.inFit, radial_velocity: s.rvInFit, timing: s.timing.inFit }, time_reference: s.lightCurve.timeReference, note: d.length ? undefined : 'No data are loaded.' }; },
    async load_light_curve(args) {
      const { text, name } = await sourceText(args, 'Light curve'), pv = ops.previewLightCurve(text, name);
      if (pv.points < 5) throw new Error(`only ${pv.points} usable rows were found in ${name}`);
      const before = api.state(), tm0 = (before.parameters.find((p) => p.key === 'tmid') || {}).value + before.lightCurve.timeReference;
      let epochs = 1;
      if (args.add_epoch) epochs = api.addLightCurveEpoch(text, name).epochs; else api.loadLightCurve(text, name);
      if (args.exposure_min !== undefined) roundTrip((d) => ops.editData(d, { exposure_min: args.exposure_min }));
      const s = api.state(), d = ops.describeData(doc(false)).find((x) => x.handle === 'light_curve');
      if (!d || (!args.add_epoch && d.points !== pv.points)) throw new Error(`the analyzer did not take the file (it still holds ${d ? d.points : 0} points)`);
      const tm1 = (s.parameters.find((p) => p.key === 'tmid') || {}).value + s.lightCurve.timeReference;
      if (args.planet) {
        // the user said which planet this is: take its parameters from the catalogue (the file stays loaded)
        let look; try { look = await H.lookup_planet({ name: args.planet }); } catch (err) { look = null; var lookErr = err.message; }
        const s2 = api.state();
        return { loaded: ops.dataLine(d), time_system: pv.time_system, flux_units: pv.flux_units, time_reference: s2.lightCurve.timeReference, reader_notes: pv.notes,
          system: look ? { name: look.loaded, period_d: look.period_d, rprs: look.rprs, mid_transit: look.mid_transit, from: 'the catalogue snapshot' } : undefined, tmid_note: look ? look.tmid_note : undefined,
          planet_lookup_failed: look ? undefined : `${lookErr} The system is still ${s2.name}: try search_catalog for the spelling, or set the parameters by hand.`,
          free: s2.parameters.filter((p) => p.free).map((p) => p.key), next: 'set_free (typically rprs, inc, tmid, and a2 when there is an airmass column), then run_fit.' };
      }
      return { loaded: ops.dataLine(d), time_system: pv.time_system, flux_units: pv.flux_units, time_reference: s.lightCurve.timeReference, epochs: args.add_epoch ? epochs : undefined, reader_notes: pv.notes,
        mid_transit: Math.abs(tm1 - tm0) > 1e-6 ? `T mid moved by whole periods onto the data: now ${sig(tm1, 12)}` : undefined, free: s.parameters.filter((p) => p.free).map((p) => p.key),
        system_now: `${s.name} (P = ${sig((s.parameters.find((p) => p.key === 'per') || {}).value, 6)} d). The fit will use THIS system's parameters and priors.`,
        next: `If the file is of a planet other than ${s.name}, call lookup_planet with its name now (the file stays loaded), or load it again with the "planet" argument. Then set_free (typically rprs, inc, tmid, and a2 when there is an airmass column) and run_fit.` };
    },
    async load_radial_velocities(args) {
      const { text, name } = await sourceText(args, 'RV'), pv = ops.previewRV(text, name);
      const sets = api.addRadialVelocities(text, name); let s = api.state(), standIn = false;
      // a simulated stand-in light curve (lookup_planet shows one) must not join a fit of real velocities
      if (s.lightCurve.synthetic && s.lightCurve.inFit && has('setUse')) { api.setUse({ lc: false }); s = api.state(); standIn = true; }
      // a transit set-up left free by lookup_planet (rprs, inc) cannot be measured by velocities alone: fix it now
      let fixedNow = [];
      if (!s.lightCurve.inFit && !s.timing.inFit) {
        fixedNow = s.parameters.filter((p) => p.free && /^(rprs|inc|ld\d|a2|dilution)(@|$)/.test(p.key)).map((p) => p.key); for (const k of fixedNow) api.setFree(k, false);
        // and the orbit set up for the velocities (the same as lookup_planet does when velocities are already loaded)
        const keys = s.parameters.map((p) => p.key); for (const k of ['mplanet', 'per', 'ecc', 'omega', 'tmid', ...keys.filter((x) => /^jit@rv\d+$/.test(x))]) if (keys.includes(k)) api.setFree(k, true);
        s = api.state();
      }
      const jit = s.parameters.map((p) => p.key).filter((k) => /^jit@rv\d+$/.test(k)), free = s.parameters.filter((p) => p.free).map((p) => p.key);
      // with no light curve in the fit, a transit set-up (rprs, inc free) cannot be measured: say exactly what to free instead
      const onlyRV = !s.lightCurve.inFit, suggest = ['mplanet', 'per', 'ecc', 'omega', 'tmid', ...jit];
      return { added: pv.sets, all_sets: sets, reader_notes: pv.notes, in_fit: { light_curve: s.lightCurve.inFit, radial_velocity: s.rvInFit }, kepler_mode: s.kepler, free, jitter_keys: jit,
        ...(standIn ? { light_curve_note: 'The simulated stand-in light curve was taken out of the fit: only real data are fitted.' } : {}),
        ...(fixedNow.length ? { now_fixed: `${fixedNow.join(', ')}: velocities alone cannot measure ${fixedNow.length > 1 ? 'them' : 'it'}, so ${fixedNow.length > 1 ? 'they were' : 'it was'} fixed.` } : {}),
        ...(onlyRV ? { suggested_free: suggest } : {}),
        next: onlyRV ? `Only velocities are in the fit, so the orbit was set up for them: free ${free.join(', ')} (the planet mass, period, e, omega, the time of transit, which sets the orbital phase, and each instrument's extra noise). Check the priors with get_state if needed, then run_fit.` : 'Velocities add the planet mass (mplanet), e and omega to the fit. Each set has a jitter (' + jit.join(', ') + ') that can be freed with set_free. run_fit when ready.' };
    },
    async set_timings(args) {
      const { text } = await sourceText(args, 'timings'), pv = ops.previewTimings(text);
      api.setTimings(pv.text);
      return { times: pv.times, skipped_lines: pv.skipped_lines, from: pv.from, to: pv.to, median_error_min: pv.median_error_min, planet: api.state().showing, next: 'fit_ephemeris gives the period and T0; timing_periodogram searches for variations; choose_data {timing: true} adds them to the fit.' };
    },
    simulate_light_curve(args) {
      const night = args.mid_transit !== undefined ? nightOf(args.mid_transit) : null, at = () => { const t = tmidNow(); return night ? { mid_transit: sig(t.abs, 12), time_reference: t.tr || undefined, tmid_note: night.note } : {}; };
      if (has('simulate')) { const o = simulateAt(night ? night.abs : null, () => api.simulate({ ...(args.noise_ppm !== undefined ? { noise_ppm: args.noise_ppm } : {}), ...(args.exposure_min !== undefined ? { cadence_min: args.exposure_min } : {}), ...(args.baseline_hr !== undefined ? { baseline_hr: args.baseline_hr } : {}), ...(args.airmass !== undefined ? { airmass: args.airmass } : {}), ...(args.n_epochs !== undefined ? { epochs: args.n_epochs } : {}), ...(args.epoch_step !== undefined ? { epoch_step: args.epoch_step } : {}), ...(args.seed !== undefined ? { seed: args.seed } : {}) })); return { simulated: dataLines().find((l) => l.startsWith('light curve')), options: slim(o, 400), ...at(), note: 'This is simulated data from the current parameters, not an observation.', next: 'set_free then run_fit recovers the parameters that were put in.' }; }
      const o = simulateAt(night ? night.abs : null, () => roundTrip((d) => ops.simulateInto(d, args))); return { simulated: dataLines().find((l) => l.startsWith('light curve')), options: o.options, ...at(), note: 'This is simulated data from the current parameters, not an observation.', next: 'set_free then run_fit recovers the parameters that were put in.' };
    },
    edit_data(args) {
      const done = [], lc = {}, rest = {};
      for (const k of ['remove_epoch', 'trim', 'clip_sigma', 'bin_min']) if (args[k] !== undefined) lc[k] = args[k];
      for (const k of ['exposure_min', 'remove_velocities', 'clear_timings']) if (args[k] !== undefined) rest[k] = args[k];
      if (Object.keys(lc).length) {
        if (has('editData')) { const o = api.editData(lc); done.push(...(o.steps || [`light curve edited: ${o.points} points left, ${o.removed} removed`])); }
        else if (lc.trim || lc.clip_sigma || lc.bin_min) throw new Error('trimming, clipping and binning are only available in the web app');
        else rest.remove_epoch = lc.remove_epoch;
      }
      if (Object.keys(rest).length) done.push(...roundTrip((d) => ops.editData(d, rest)).done);
      if (!done.length) throw new Error('nothing to do: give exposure_min, remove_epoch, trim, clip_sigma, bin_min, remove_velocities or clear_timings');
      return { done, data: dataLines(), note: Object.keys(lc).length ? 'The data changed: evidences of earlier runs are no longer comparable with new ones.' : undefined };
    },

    // ---- fit ------------------------------------------------------------------------------------------------
    choose_data(args) {
      const use = {}; if (args.light_curve !== undefined) use.lc = args.light_curve; if (args.radial_velocity !== undefined) use.rv = args.radial_velocity; if (args.timing !== undefined) use.timing = args.timing;
      if (!Object.keys(use).length) throw new Error('give at least one of light_curve, radial_velocity, timing (true or false)');
      const s0 = api.state();
      if (use.rv && !s0.radialVelocity.length) throw new Error('no radial velocities are loaded: load_radial_velocities first');
      if (use.timing && !s0.timing.points) throw new Error('the timing list is empty: set_timings first');
      api.setUse(use); const s = api.state();
      return { in_fit: { light_curve: s.lightCurve.inFit, radial_velocity: s.rvInFit, timing: s.timing.inFit } };
    },
    set_free({ free = [], fixed = [] }) {   // reassigned below
      if (!free.length && !fixed.length) throw new Error('give "free" and/or "fixed": lists of parameter keys');
      const ars = free.filter((k) => k.split('@')[0] === 'ars');
      if (ars.length) throw new Error('a/R* (ars) is never fitted. Turn Kepler mode on (set_kepler) and free mstar or rstar instead; or leave ars fixed.');
      fixed = fixed.filter((k) => k.split('@')[0] !== 'ars' && !free.includes(k));   // a/R* is always fixed; a key in both lists is taken as free
      needKeys([...free, ...fixed], { star: false });
      // with only velocities in the fit, transit-shape parameters cannot be measured: leave them fixed and say so
      const st0 = api.state(), lcOff = !st0.lightCurve.inFit && !st0.timing.inFit;
      const blind = lcOff ? free.filter((k) => /^(rprs|inc|ld\d|a2|dilution)(@|$)/.test(k)) : [];
      if (blind.length) { free = free.filter((k) => !blind.includes(k)); fixed = [...new Set([...fixed, ...blind])]; }
      for (const k of free) api.setFree(k, true);
      for (const k of fixed) api.setFree(k, false);
      const s = api.state();
      return { free: s.parameters.filter((p) => p.free).map((p) => `${p.key} ~ ${priorText(p.prior)}`), fixed_now: fixed.map((k) => `${k} = ${sig((s.parameters.find((p) => p.key === k) || {}).value, 8)}`),
        ...(blind.length ? { left_fixed: `${blind.join(', ')}: no light curve is in the fit, so the velocities cannot measure ${blind.length > 1 ? 'them' : 'it'}; kept fixed.` } : {}),
        next: 'run_fit when the set-up is right. Priors can be changed with set_prior.' };
    },
    set_prior({ key, type, a, b }) {
      needKeys([key], { star: true });
      if (type === 'uniform' && !(b > a)) throw new Error(`a uniform prior needs maximum (b = ${b}) above minimum (a = ${a})`);
      if (type === 'normal' && !(b > 0)) throw new Error('a normal prior needs a positive standard deviation (b)');
      api.setPrior(key, { type, a: relTime(key, a), b: type === 'uniform' ? relTime(key, b) : b });
      const p = api.state().parameters.find((x) => x.key === key);
      return { key, prior: p ? priorText(p.prior) : `${type}(${a}, ${b})`, free: p ? p.free : undefined, note: p && !p.free ? 'This parameter is fixed: the prior applies once it is freed (set_free).' : undefined };
    },
    set_sampler(args) {
      const o = {}; if (args.nlive !== undefined) o.nlive = args.nlive; if (args.frac_remain !== undefined) o.fracRemain = args.frac_remain; if (args.max_calls !== undefined) o.maxCalls = args.max_calls; if (args.max_seconds !== undefined) o.maxSeconds = args.max_seconds; if (args.seed !== undefined) o.seed = args.seed;
      if (!Object.keys(o).length) throw new Error('give at least one of nlive, frac_remain, max_calls, max_seconds, seed');
      api.setSampler(o); return { sampler: api.state().sampler };
    },
    async run_fit({ label }, { onProgress, signal } = {}) {
      const s = api.state(), free = s.parameters.filter((p) => p.free);
      if (!free.length) throw new Error('nothing is free. Choose what to fit with set_free, e.g. {"free": ["rprs", "inc", "tmid"]}.');
      // a simulated stand-in in the fit while the user attached their own data: fitting it would report on fake data
      if (s.lightCurve.inFit && s.lightCurve.synthetic) {
        const att = files.list().filter((f) => f.origin === 'attached' && !/\.fits?$|\.fz$|\.json$/i.test(f.name));
        if (att.length) throw new Error(`the light curve in the fit is the simulated stand-in, but the user attached ${att.map((f) => f.name).join(', ')}. Load the user's data first: load_light_curve {"file": "${att[0].name}"} (or load_radial_velocities for velocities), then run_fit.`);
      }
      // parameters no data in the fit can measure would only return their priors, and a small model reports them as results
      if (!s.lightCurve.inFit && !s.timing.inFit) {
        const blind = free.map((p) => p.key).filter((k) => /^(rprs|inc|ld\d|a2|ars|dilution)(@|$)/.test(k));
        if (blind.length) { const jit = s.parameters.map((p) => p.key).filter((k) => /^jit@rv\d+$/.test(k)); throw new Error(`${blind.join(', ')} ${blind.length > 1 ? 'are' : 'is'} free but no light curve is in the fit, so the data cannot measure ${blind.length > 1 ? 'them' : 'it'}: the "result" would be the prior. Fix the free list first, e.g. set_free {"free": ${JSON.stringify(['mplanet', 'per', 'ecc', 'omega', 'tmid', ...jit])}}, then run_fit.`); }
      }
      if (s.running) throw new Error('a fit is already running: wait for it or stop_fit');
      const { result, rec } = await fit(label, onProgress, signal);
      const flat = /flat/i.test(result.stop_reason || ''), twin = rec && runs.find((x) => x.id !== rec.id && x.model === rec.model && x.dataKey === rec.dataKey);
      if (twin && !flat) return { run: '#' + rec.id + (label ? ' ' + label : ''), same_model_as: `#${twin.id}${twin.label ? ' ' + twin.label : ''}`, ...ops.summarizeResult(result),
        next: `Nothing was changed since run #${twin.id}: this is the same model (same free parameters, priors and fixed values), so the two runs differ only by sampling noise and comparing them means nothing. To fit a different model, change what is free or fixed first (set_free, set_parameters). To compare a circular with an eccentric orbit, or other standard pairs, call run_experiment: it sets up each model for you.` };
      const dl = dataLines().filter((l, i) => { const st = api.state(); return l.startsWith('light curve') ? st.lightCurve.inFit : l.startsWith('velocities') ? st.rvInFit : st.timing.inFit; });
      return { run: rec ? '#' + rec.id + (label ? ' ' + label : '') : undefined, fitted: `the system ${s.name} against ${dl.join(' + ') || 'the data in the fit'}`, ...ops.summarizeResult(result),
        next: flat ? `This is not a measurement: the model did not change anywhere inside the priors, so the numbers above are just the priors. The usual causes: the loaded system (${s.name}) is not the planet in the data (call lookup_planet with the right name), or the tmid prior does not contain the transit (widen it with set_prior). Fix that and run again; do not report these values as results.` : 'Report these numbers as they are. compare_runs reads the evidence against other runs on the same data; export_file writes a report.' };
    },
    fit_progress() { return slim(api.progress(), 1200); },
    stop_fit() { const was = api.state().running; api.stop(); return { stopped: was, note: was ? 'The fit was told to stop; the partial posterior is not converged.' : 'No fit was running.' }; },

    // ---- results --------------------------------------------------------------------------------------------
    get_results({ derived, keys }) { return ops.summarizeResult(api.results(), { derived, keys }); },
    explain_results() { return ops.explainResult(doc(true)); },
    residual_periodogram(args) { return ops.residualPeriodogramOf(doc(false), args || {}); },
    ...knowledgeHandlers(readSource),
    get_derived({ planet }) {
      const want = planet ? sfxOf(planet) : null, mine = (k) => !want || (k.split('@')[1] || '') === want.sfx;
      if (has('derived')) {
        // the rows of the analyzer's system table, with the formatting of the result tables
        const many = api.state().planets.length > 1, rows = (api.derived() || []).filter((x) => !want || !many || !/^Planet /.test(x.section || '') || x.section === 'Planet ' + want.letter);
        if (rows.length) return { source: 'the analyzer\'s system table' + (rows.some((x) => x.plus !== null && x.plus !== undefined) ? ' (median and 68% interval)' : ' at the current values (no fit yet, so no intervals)'), rows: rows.slice(0, 70).map((x) => ({ section: x.section || '', quantity: x.label, value: ops.pmText({ median: x.value, plus: x.plus ?? 0, minus: x.minus ?? 0 }) + (x.unit ? ' ' + x.unit : ''), kind: x.kind })) };
      }
      const r = api.results();
      if (r) { const all = ops.summarizeResult(r, { derived: true }).derived; return { source: 'the current fit (median and 68% interval)', derived: Object.fromEntries(Object.entries(all).filter(([k]) => mine(k.split(' ')[0]))) }; }
      const m = ops.modelOf(doc(false)); return { source: 'the model at the current parameter values (no fit yet, so no intervals)', planets: want ? { [want.letter]: m.planets[want.letter] } : m.planets };
    },
    list_runs() {
      const mine = runs.map((x) => ({ run: '#' + x.id + (x.label ? ' ' + x.label : ''), free: x.free.join(', '), lnZ: x.converged ? `${x.logZ.toFixed(2)} ± ${x.err.toFixed(2)}` : `> ${x.logZ.toFixed(1)} (not converged)`, on_current_data: x.dataKey === ops.dataKey(doc(false)), fitted: x.headline }));
      const page = pageRuns();
      if (page && page.length) return { source: 'the analyzer\'s run history', runs: page.map((x) => { const rec = runs.find((y) => y.pageId === x.id); return { run: '#' + x.id + (rec && rec.label ? ' ' + rec.label : ''), free: (x.free || []).join(', '), limb_darkening: x.model, lnZ: x.converged ? `${x.logZ.toFixed(2)} ± ${x.logZerr.toFixed(2)}` : `> ${x.logZ.toFixed(1)} (not converged)`, on_current_data: x.same_data, showing: x.showing || undefined, cautions: (x.cautions || []).length ? x.cautions : undefined }; }), next: 'restore_run brings one back; compare_runs reads their evidences.' };
      return { source: 'the fits made in this conversation', runs: mine, note: mine.length ? undefined : 'No runs yet.' };
    },
    async restore_run({ run }) {
      const id = Number(String(run).replace(/^#/, '').split(' ')[0]);
      await api.restoreRun(id); const s = api.state();
      return { restored: '#' + id, system: s.name, free: s.parameters.filter((p) => p.free).map((p) => p.key), has_result: s.hasResult, ...(s.hasResult ? { result: ops.resultLine(api.results()) } : {}) };
    },
    compare_runs() { return comparison(); },
    async run_experiment({ kind, variants, planet, report }, { onProgress, signal } = {}) {
      const s0 = api.state(), P = Object.fromEntries(s0.parameters.map((p) => [p.key, p]));
      let plan;
      if (kind === 'eccentricity') { if (!P.ecc) throw new Error('this set-up has no eccentricity parameter'); plan = [{ name: 'circular', fixed: { ecc: 0, ...(P.omega ? { omega: P.omega.value } : {}) } }, { name: 'eccentric', free: ['ecc', ...(P.omega ? ['omega'] : [])] }]; }
      else if (kind === 'limb_darkening') { const ld = s0.parameters.filter((p) => p.group === 'ld').map((p) => p.key); if (!ld.length) throw new Error('the uniform-disc law has no coefficients to free: choose another law with set_limb_darkening'); plan = [{ name: 'limb darkening fixed', fixed: Object.fromEntries(ld.map((k) => [k, P[k].value])) }, { name: 'limb darkening free', free: ld }]; }
      else if (kind === 'airmass') { const am = s0.parameters.filter((p) => p.group === 'baseline').map((p) => p.key); if (!am.length) throw new Error('the light curve has no airmass column, so there is no airmass slope to test'); plan = [{ name: 'no airmass trend', fixed: Object.fromEntries(am.map((k) => [k, 0])) }, { name: 'airmass trend', free: am }]; }
      else if (kind === 'companion') {
        if (s0.planets.length < 2) throw new Error('the system has one planet. Add the companion first (add_planet, or companion_search and add_companion), set its values and free what the data can measure; then run this experiment.');
        const L = planet ? sfxOf(planet).letter : s0.planets[s0.planets.length - 1];
        plan = [{ name: `without planet ${L}`, setup: [{ tool: 'remove_planet', args: { letter: L } }] }, { name: `with planet ${L}` }];
      }
      else { if (!variants || variants.length < 2) throw new Error('kind "custom" needs "variants": at least two, each { name, free: [keys], fixed: { key: value }, setup: [{ tool, args }] }'); plan = variants.map((v) => ({ name: v.name, free: v.free || [], fixed: v.fixed || {}, setup: v.setup || [] })); }
      const SETUP = ['set_parameters', 'set_prior', 'set_kepler', 'set_limb_darkening', 'add_planet', 'remove_planet', 'set_phase_curve', 'set_moon', 'set_nbody', 'choose_data'];
      for (const v of plan) for (const st of v.setup || []) if (!SETUP.includes(st.tool)) throw new Error(`"${st.tool}" cannot be a set-up step of a variant. Allowed: ${SETUP.join(', ')}.`);
      const keysOf = (v) => [...(v.free || []), ...Object.keys(v.fixed || {})], touched = [...new Set(plan.flatMap(keysOf))];
      // keys of a variant without set-up steps must exist now; those of one with steps are checked after its steps ran
      needKeys([...new Set(plan.filter((v) => !(v.setup || []).length).flatMap(keysOf))]);
      if (touched.some((k) => k.split('@')[0] === 'ars')) throw new Error('a/R* (ars) is never fitted, so it cannot be part of an experiment');
      const others = s0.parameters.filter((p) => p.free && !touched.includes(p.key)).map((p) => p.key);
      if (!others.length && plan.some((v) => !(v.free || []).length && !(v.setup || []).length)) throw new Error('one variant would have nothing free: free the parameters every variant shares first (set_free, e.g. rprs, inc, tmid)');
      const done = [], anySetup = plan.some((v) => (v.setup || []).length), baseline = anySetup ? doc(false) : null, baseKey = anySetup ? setupKey(baseline) : null; let dirty = false;
      for (const v of plan) {
        if (signal && signal.aborted) break;
        const entry = { name: v.name, lines: [] };
        try {
          // every variant starts from the set-up the experiment was called with
          if (dirty) { backTo(baseline, baseKey); dirty = false; }
          for (const k of touched) { if (!P[k] || !paramList().some((p) => p.key === k)) continue; api.setFree(k, P[k].free); if (!P[k].free) api.setValue(k, P[k].value); }
          for (const st of v.setup || []) { dirty = true; const r = await call(st.tool, st.args || {}); if (!r.ok) throw new Error(`set-up step ${st.tool}: ${r.text.replace(/^ERROR: /, '')}`); entry.lines.push(`set-up: ${st.tool} ${JSON.stringify(st.args || {})}`); }
          if ((v.setup || []).length) needKeys(keysOf(v));
          for (const [k, x] of Object.entries(v.fixed || {})) { api.setFree(k, false); api.setValue(k, relTime(k, x)); }
          for (const k of v.free || []) api.setFree(k, true);
          if (!api.state().parameters.some((p) => p.free)) throw new Error('nothing is free in this variant');
          const { result, rec } = await fit(v.name, onProgress ? (p) => onProgress({ ...p, variant: v.name }) : undefined, signal);
          const sum = ops.summarizeResult(result);
          entry.run = rec ? rec.id : null; entry.lnZ = sum.evidence; entry.converged = sum.converged;
          entry.lines.push(`free: ${api.state().parameters.filter((p) => p.free).map((p) => p.key).join(', ')}`, ...Object.entries(v.fixed || {}).map(([k, x]) => `${k} fixed at ${sig(x, 8)}`), ...Object.entries(sum.parameters).map(([k, q]) => `${k} = ${q}`), ...Object.entries(sum.derived).map(([k, t]) => `${k} = ${t} (derived)`), `chi2 = ${sum.chi2} for ${sum.n_data} points`, ...sum.warnings.map((w) => `warning: ${w}`));
        } catch (err) { entry.error = err.message; }
        done.push(entry);
      }
      const ids = done.map((v) => v.run).filter(Boolean), cmp = comparison(ids), d = doc(false), file = report || 'experiment_report.md';
      const title = kind === 'custom' ? `Model comparison: ${plan.map((v) => v.name).join(' vs ')}` : { eccentricity: 'Circular against eccentric orbit', limb_darkening: 'Limb darkening fixed against free', airmass: 'With and without an airmass trend', companion: `${plan[0].name} against ${plan[1].name}` }[kind];
      const forReport = cmp.runs && cmp.runs.every((r) => r.run !== undefined && r.lnZ !== undefined) ? cmp : { ...ops.compareRuns(runs.filter((r) => ids.includes(r.id))) };
      const text = ops.experimentReport({ title, system: `${d.name} (planet${d.planets.length > 1 ? 's' : ''} ${d.planets.map((p) => p.letter).join(', ')})`, data: ops.describeData(d).map(ops.dataLine), variants: done, comparison: { cautions: [], rule: ops.compareRuns([]).rule, ...forReport } });
      const w = await files.write(file, text, 'text/markdown');
      return { experiment: title, variants: done.map((v) => (v.error ? { name: v.name, failed: v.error } : { name: v.name, run: '#' + v.run, converged: v.converged, fitted: v.lines.filter((l) => / = /.test(l) && !/derived|chi2/.test(l)).join('; ') })), comparison: { source: cmp.source, runs: forReport.runs, verdict: forReport.verdict, cautions: forReport.cautions }, report_file: w.name,
        left_loaded: done.length && !done[done.length - 1].error ? `the page shows the last run (${done[done.length - 1].name})` : undefined, stopped_early: signal && signal.aborted ? true : undefined,
        next: 'Give the user the comparison table as it is (each ln Z with its ±), then the verdict and the cautions in the software\'s words, and say the report file is ready to download. Do not add an interpretation of your own.' };
    },

    // ---- timing ---------------------------------------------------------------------------------------------
    fit_ephemeris({ planet, upcoming }) { return ops.ephemerisOf(doc(false), { planet, upcoming: upcoming ?? 3 }); },
    timing_periodogram({ planet, bootstrap }) { return ops.periodogramOf(doc(false), { planet, bootstrap: bootstrap || 0 }); },
    async compute_model({ file }) {
      const m = ops.modelOf(doc(false), { wantCurve: !!file }), text = m.csv; delete m.csv;
      if (file && text) { const w = await files.write(file, text, 'text/csv'); m.curve_file = w.name; }
      return m;
    },

    // ---- views and exports ----------------------------------------------------------------------------------
    set_view({ tab, plot, fold, all_planets, planet }) {
      const did = [];
      if (planet) { api.showPlanet(String(planet).trim().slice(-1)); did.push(`showing planet ${planet}`); }
      if (plot !== undefined || fold !== undefined || all_planets !== undefined) { api.setView({ ...(plot ? { view: plot } : {}), ...(fold !== undefined ? { fold } : {}), ...(all_planets !== undefined ? { allPlanets: all_planets } : {}) }); did.push('plot updated'); }
      if (tab) { api.showTab(tab); did.push(`${tab} tab open`); }
      if (!did.length) throw new Error('give at least one of tab, plot, fold, all_planets, planet');
      return { done: did };
    },
    async export_file({ kinds, name }) {
      if (!kinds.length) throw new Error('kinds is empty: name at least one file to write, e.g. ["report"]');
      const d = doc(true), written = [], failed = [];
      for (const kind of [...new Set(kinds)]) { try { const f = ops.exportText(d, kind, kinds.length === 1 ? name : undefined), w = await files.write(f.name, f.text, f.mime); written.push({ kind, file: w.name, size_bytes: w.size }); } catch (err) { failed.push({ kind, why: err.message }); } }
      if (!written.length) throw new Error(failed.map((x) => `${x.kind}: ${x.why}`).join('; '));
      return { written, failed: failed.length ? failed : undefined, note: where === 'browser' ? 'The files are listed under the conversation for the user to download.' : 'Written to the workspace.' };
    },
    async write_report({ title, author, figures = true }) {
      const d = doc(true), stem = String(title || d.name || 'analysis').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'analysis', written = [], figs = [];
      if (figures) for (const which of ['light_curve', ...(d.result ? ['corner'] : [])]) { try { const r = await H.get_figure({ which, name: `${stem}_${which}.png` }); figs.push(r.written); } catch { /* a figure that is not drawn is left out */ } }
      const sess = ops.exportText(d, 'session', `${stem}_session.json`), ws = await files.write(sess.name, sess.text, sess.mime); written.push(ws.name);
      let verdict = ''; try { const c = page && page.comparison ? page.comparison() : null; verdict = (c && c.verdict) || ''; } catch { /* optional */ }
      const R = projectReport(d, { project: ctx.siteProject ? ctx.siteProject() : null, reduction: ctx.reduction ? ctx.reduction() : null, runs, verdict, figures: figs, files: [ws.name, `${stem}_report.bib`], title, author, sessionFile: ws.name });
      const wm = await files.write(`${stem}_report.md`, R.markdown, 'text/markdown'), wb = await files.write(`${stem}_report.bib`, R.bibtex, 'application/x-bibtex');
      return { written: [wm.name, wb.name, ws.name, ...figs], sections: R.markdown.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3)), cited: R.keys, to_check: R.notes.slice(0, 4),
        note: (ctx.siteProject && ctx.siteProject() ? '' : 'There is no observing project, so the target-and-observation section says so. ') + (ctx.reduction && ctx.reduction() ? '' : 'No photometry record was found, so the reduction section asks the user to describe it. ') + 'Tell the user the report is ready to download, and list what it still asks them to check.' };
    },
    async get_figure({ which, name, dark }) {
      let blob = null; const view = { light_curve: 'lc', oc: 'timing' }[which] || which;
      if (has('figure') && !['periodogram', 'limb_darkening'].includes(which)) {
        // the analyzer draws any of its views with the code of its exported figures, on screen or not
        const url = await api.figure(view, dark ? { theme: 'dark' } : {});
        if (typeof url === 'string' && url.startsWith('data:') && ctx.blobFromDataUrl) blob = await ctx.blobFromDataUrl(url);
      }
      if (!blob) { if (!page || !page.figure) throw new Error('figures are only available in the browser'); blob = await page.figure(which); }
      if (!blob) throw new Error(`the ${which} figure is not on screen. ${{ corner: 'It needs a fit result: run_fit, then set_view {tab: "results"}.', oc: 'Open the timing tab (set_view {tab: "timing"}) with at least two times loaded.', periodogram: 'Open the timing tab with at least six times loaded.', limb_darkening: 'Open the system tab (set_view {tab: "system"}).', light_curve: 'The light-curve panel may be folded away.', rv: 'Load radial velocities and show them (set_view {plot: "rv"}).' }[which] || ''}`);
      const w = await files.write(name || `${which}.png`, blob, 'image/png');
      return { written: w.name, size_bytes: w.size, shown: 'The figure is shown to the user in the chat and listed with the files.' };
    },
    async import_session({ file }) {
      const text = await files.readText(file); let d;
      try { d = JSON.parse(text); } catch { throw new Error(`${file} is not JSON, so it is not a session file. For a data file use load_light_curve, load_radial_velocities or set_timings.`); }
      api.importSession(d); const s = api.state(); if (s.hasResult) recordRun('from ' + file);
      return { opened: d.title || d.name, system: s.name, planets: s.planets, data: dataLines(), free: s.parameters.filter((p) => p.free).map((p) => p.key), has_result: s.hasResult };
    },

    // ---- local saves ----------------------------------------------------------------------------------------
    async save_analysis({ name }) { const m = await api.save(name); return { saved: m.name || name, id: m.id, summary: m.summary }; },
    async list_saved() { const all = await api.listSaved(); return { saved: all.slice(0, 40).map((m) => ({ id: m.id, name: m.name, system: m.system, updated: m.updated, summary: m.summary })), count: all.length }; },
    async open_saved({ id }) { const all = await api.listSaved(), hit = all.find((m) => String(m.id) === String(id)) || all.find((m) => m.name === id); if (!hit) throw new Error(`no saved analysis "${id}". Saved: ${all.map((m) => `${m.id} (${m.name})`).join('; ') || 'none'}.`); await api.openSaved(hit.id); const s = api.state(); return { opened: hit.name, system: s.name, data: dataLines(), has_result: s.hasResult }; },
    async delete_saved({ id }) { const all = await api.listSaved(), hit = all.find((m) => String(m.id) === String(id)) || all.find((m) => m.name === id); if (!hit) throw new Error(`no saved analysis "${id}"`); await api.deleteSaved(hit.id); return { deleted: hit.name, id: hit.id }; },
    undo({ redo }) { const r = redo ? api.redo() : api.undo(); const s = api.state(); return { done: r === false ? false : true, note: r === false ? `nothing to ${redo ? 'redo' : 'undo'}` : undefined, system: s.name, has_result: s.hasResult }; },

    // ---- files ----------------------------------------------------------------------------------------------
    ...fileHandlers(files, where, (a) => H.read_source(a)),
  };

  /** The sentence the user is asked to confirm before a call runs, or null when it may simply run. */
  function confirmFor(name, args = {}) {
    const spec = specs.find((t) => t.name === name); if (!spec || !spec.confirm) return null;
    if (name === 'load_light_curve' && args.add_epoch) return null;
    if (name === 'edit_data' && args.remove_epoch === undefined && args.remove_velocities === undefined && !args.clear_timings) return null;
    if (name === 'delete_saved') return spec.confirm;
    if (name === 'lookup_planet') { try { return api.state().hasResult ? spec.confirm : null; } catch { return spec.confirm; } }
    return somethingToLose() ? spec.confirm : null;
  }

  /** Run a tool. Never throws: a failure comes back as { ok: false, text: 'ERROR: …' } for the model to read and correct. */
  async function call(name, rawArgs, opts = {}) {
    const spec = specs.find((t) => t.name === name);
    if (!spec) { const guess = specs.map((t) => t.name).filter((n) => n.includes(String(name).replace(/^.*[.:]/, '')) || String(name).includes(n)); return { ok: false, text: `ERROR: there is no tool "${name}".${guess.length ? ' Did you mean ' + guess.slice(0, 3).join(' or ') + '?' : ''} The tools are: ${specs.map((t) => t.name).join(', ')}.` }; }
    if (name === 'set_free' && rawArgs && typeof rawArgs === 'object' && !rawArgs.free && !rawArgs.fixed && rawArgs.values && typeof rawArgs.values === 'object' && !Array.isArray(rawArgs.values)) rawArgs = { free: Object.keys(rawArgs.values) };
    let { args, error } = checkArgs(spec, rawArgs), ignored = [];
    // an argument the tool does not take, and nothing else wrong: it is dropped and the call runs (the result says so)
    if (error && rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) && spec.parameters && spec.parameters.properties && spec.parameters.additionalProperties === false) {
      const extra = Object.keys(rawArgs).filter((k) => !(k in spec.parameters.properties));
      if (extra.length) { const again = checkArgs(spec, Object.fromEntries(Object.entries(rawArgs).filter(([k]) => !extra.includes(k)))); if (!again.error) { args = again.args; error = null; ignored = extra; } }
    }
    if (error) return { ok: false, args, text: 'ERROR: ' + error };
    try {
      let data = await H[name](args, opts);
      if (ignored.length && data && typeof data === 'object' && !Array.isArray(data)) data = { ...data, ignored_arguments: `${ignored.join(', ')} (${name} does not take ${ignored.length > 1 ? 'them' : 'it'})` };
      let table = ''; try { table = ops.tableFor(name, data); } catch { table = ''; }
      return { ok: true, args, data, table, text: JSON.stringify(data, (k, v) => (v === undefined || v === null ? undefined : typeof v === 'number' && !Number.isFinite(v) ? undefined : v)) };
    } catch (err) { return { ok: false, args, text: 'ERROR: ' + String((err && err.message) || err).replace(/★/g, '*') }; }
  }

  /**
   * The live state card: what is loaded, what is free, whether a fit exists and its headline numbers, which files
   * are at hand. Regenerated for every model step so the model never has to ask what is there.
   */
  function stateCard() {
    let s; try { s = api.state(); } catch (err) { return `CURRENT STATE: unavailable (${err.message})`; }
    const L = [], d = (() => { try { return ops.describeData(doc(false)); } catch { return []; } })();
    L.push(`System loaded in the app (not necessarily the one the user is asking about): ${s.name} · planet${s.planets.length > 1 ? 's' : ''} ${s.planets.join(', ')}${s.planets.length > 1 ? ` (showing ${s.showing})` : ''} · Kepler mode ${s.kepler ? 'ON (a/R* derived)' : 'off (a/R* = ars, fixed)'} · limb darkening ${s.limbDarkening.law}`);
    L.push(`Star: Teff ${s.star.teff} K, R* ${s.star.rstar ?? '?'} Rsun, M* ${s.star.mstar ?? '?'} Msun`);
    L.push('Data loaded (in the page; refer to it, do not ask for it):');
    const inFit = (h) => (h === 'light_curve' ? s.lightCurve.inFit : h.startsWith('velocities') ? s.rvInFit : s.timing.inFit);
    if (d.length) for (const x of d) L.push(`  - ${ops.dataLine(x)} [${inFit(x.handle) ? 'in the fit' : 'NOT in the fit'}]`); else L.push('  - none');
    if (s.lightCurve.timeReference) L.push(`Time reference: ${s.lightCurve.timeReference} (tmid below is days after it)`);
    const fr = s.parameters.filter((p) => p.free), fx = s.parameters.filter((p) => !p.free);
    L.push(`Free parameters (${fr.length}): ${fr.map((p) => `${p.key} = ${sig(p.value, 7)} ~ ${priorText(p.prior)}`).join('; ') || 'none'}`);
    L.push(`Fixed parameters: ${fx.map((p) => `${p.key} = ${sig(p.value, 7)}`).join('; ') || 'none'}`);
    L.push(`Sampler: nlive ${s.sampler.nlive}${s.sampler.maxCalls ? ', max calls ' + Number(s.sampler.maxCalls).toExponential(0) : ''}${s.sampler.maxSeconds ? ', max ' + s.sampler.maxSeconds + ' s' : ''}${s.running ? ' · A FIT IS RUNNING' : ''}`);
    let r = null; try { r = api.results(); } catch { r = null; }
    L.push(`Fit result: ${ops.resultLine(r)}${r ? ' (for what the numbers mean: explain_results)' : ''}`);
    const key = (() => { try { return ops.dataKey(doc(false)); } catch { return null; } })(), here = runs.filter((x) => x.dataKey === key);
    if (here.length) L.push(`Runs on the data now loaded: ${here.slice(-6).map((x) => `#${x.id}${x.label ? ' ' + x.label : ''} lnZ ${x.logZ.toFixed(2)}${x.converged ? '' : ' (not converged)'}`).join('; ')}`);
    const fl = files.list();
    L.push(`Files: ${fl.length ? fl.slice(0, 12).map((f) => `${f.name} (${f.size > 2048 ? Math.round(f.size / 1024) + ' kB' : f.size + ' B'}, ${f.origin}${f.about ? ': ' + cut(f.about, 70) : ''})`).join('; ') : 'none attached'}`);
    return 'CURRENT STATE OF THE APP (live; regenerated every step)\n' + L.join('\n');
  }

  // methods the analyzer describes (api.describe()) that no declared tool wraps: called as they are
  for (const t of specs) if (t.apiMethod && !H[t.name]) H[t.name] = async (args) => { const m = t.apiMethod, a = t.positional ? t.positional.map((k) => args[k]) : [args]; const r = await api[m](...a); return r === undefined ? { done: true } : slim(r, 3000); };
  const missing = specs.filter((t) => typeof H[t.name] !== 'function').map((t) => t.name);
  return { specs, names: specs.map((t) => t.name), handlers: H, missing, call, confirmFor, stateCard, runs, comparison, fileNames: () => files.list().map((f) => f.name), resetRuns() { runs.length = 0; nextRun = 1; } };
}

/**
 * explain_method and read_source: the Methods document and the site's own code, on every page and in the MCP server.
 * readSource(path) -> text; the default reads the published copy on GitHub.
 */
export function knowledgeHandlers(readSource = defaultReadSource) {
  return {
    async explain_method(args) { const content = await import('../methods/content.js'); return explainMethod(content, args || {}); },
    async read_source({ file, symbol }) {
      // a Methods section names some files with a hint: "src/core/session.js (summarizeFit)"
      const hint = /\(([A-Za-z_$][\w$]*)\)\s*$/.exec(String(file || '')); if (hint && !symbol) symbol = hint[1];
      const f = String(file || '').replace(/\s*\(.*\)\s*$/, '').trim().replace(/^\.?\//, '');
      if (!SOURCE_FILE.test(f)) throw new Error('read_source opens the site\'s own code only: a path such as "src/core/rv.js" (see the "code" of a Methods section)');
      const text = await readSource(f);
      if (!symbol) { const r = extractSymbol(text, '\u0000'); return { file: f, lines: text.split('\n').length, defines: r.symbols }; }
      const r = extractSymbol(text, String(symbol).trim());
      return r.error ? { file: f, error: r.error, defines: r.symbols } : { file: f, symbol: r.name, line: r.line, code: r.text, source: `${REPO_BLOB}/${f}#L${r.line}` };
    },
  };
}
// in the browser the published code on GitHub, through the site's network notice; in Node (MCP) the caller passes its own reader
const defaultReadSource = async (f) => { if (typeof window !== 'undefined') { const { fetchOr } = await import('../site/net.js'); return fetchOr(`${REPO_RAW}/${f}`, { what: 'GitHub (source files)', as: 'text', credentials: 'omit', quiet404: true }); } const r = await fetch(`${REPO_RAW}/${f}`); if (!r.ok) throw new Error(`${f}: not found (HTTP ${r.status}); the file list is in the Methods section's "code"`); return r.text(); };
export const KNOWLEDGE_TOOLS = ['explain_method', 'read_source'];

/** list_files, read_file and write_file on a file store: the same on every page of the site and in the MCP server. */
export function fileHandlers(files, where = 'browser', readSourceTool = null) {
  return {
    list_files() { const all = files.list(); return { files: all.map((f) => ({ name: f.name, size_bytes: f.size, origin: f.origin, about: f.about })), note: all.length ? undefined : (where === 'browser' ? 'No files yet. The user can attach files with the paperclip or by dropping them on the chat.' : 'The workspace is empty.') }; },
    async read_file({ name, max_chars = 2000, offset = 0 }) {
      // a path of the site's own code is not an attached file: read_source opens it (models mix the two up)
      if (readSourceTool && SOURCE_FILE.test(String(name || '').replace(/^\.?\//, '')) && !files.list().some((f) => f.name === name)) return readSourceTool({ file: name });
      const text = await files.readText(name), about = ops.describeText(text, name);
      if (offset >= text.length && text.length) throw new Error(`offset ${offset} is past the end of ${name} (${text.length} characters)`);
      const part = text.slice(offset, offset + max_chars), whole = offset === 0 && text.length <= max_chars;
      return { name, ...about, content: part, ...(whole ? {} : { showing: `characters ${offset} to ${offset + part.length} of ${text.length}`, read_on: offset + part.length < text.length ? `read_file with offset ${offset + part.length}` : undefined, advice: about.columns ? 'This is a data table: do not read it all. Pass the file name to load_light_curve, load_radial_velocities or set_timings (on the analyze page).' : undefined }) };
    },
    async write_file({ name, content }) {
      if (!/^[\w][\w .()+-]{0,120}$/.test(name) || name.includes('..')) throw new Error('a file name is letters, digits, spaces, dots, dashes and underscores, without folders');
      const w = await files.write(name, content, /\.json$/i.test(name) ? 'application/json' : /\.csv$/i.test(name) ? 'text/csv' : /\.md$/i.test(name) ? 'text/markdown' : 'text/plain');
      return { written: w.name, size_bytes: w.size };
    },
  };
}

/** A value cut down to what a model should read: no long arrays, no draws, strings and depth capped. */
export function slim(v, budget = 2000, depth = 0) {
  const walk = (x, d) => {
    if (x === null || x === undefined) return x;
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (typeof x === 'string') return x.length > 400 ? x.slice(0, 400) + '…' : x;
    if (typeof x !== 'object') return typeof x === 'function' ? undefined : x;
    if (ArrayBuffer.isView(x)) return `[${x.length} numbers]`;
    if (Array.isArray(x)) { if (x.length > 12 && x.every((y) => typeof y === 'number')) return `[${x.length} numbers]`; const head = x.slice(0, 12).map((y) => walk(y, d + 1)); return x.length > 12 ? [...head, `… ${x.length - 12} more`] : head; }
    if (d > 4) return '{…}';
    return Object.fromEntries(Object.entries(x).filter(([k]) => !/^(samples|draws|chain|posterior)$/i.test(k)).map(([k, y]) => [k, walk(y, d + 1)]).filter(([, y]) => y !== undefined));
  };
  const out = walk(v, depth), text = JSON.stringify(out);
  return text && text.length > budget ? { summary: text.slice(0, budget) + '…', note: 'cut by the app: ask for a narrower result' } : out;
}

// The api methods the declared tools already wrap: a description of one of these adds no tool.
const WRAPPED = ['state', 'examples', 'loadExample', 'lookup', 'setValue', 'setFree', 'setPrior', 'setUse', 'setKepler', 'setSampler', 'loadLightCurve', 'addLightCurveEpoch', 'addRadialVelocities', 'setTimings', 'showPlanet', 'setView', 'showTab', 'run', 'stop', 'results', 'exportSession', 'importSession', 'save', 'listSaved', 'openSaved', 'deleteSaved', 'undo', 'redo',
  'addPlanet', 'removePlanet', 'setLimbDarkening', 'simulate', 'editData', 'progress', 'runs', 'compare', 'restoreRun', 'figure', 'setPhase', 'setMoon', 'setNbody', 'companionSearch', 'addCompanion', 'derived', 'describe'];
/**
 * Tools made from the analyzer's own description of its scripting surface (api.describe()), for the methods no
 * declared tool wraps. Accepts a list or a map of { name | method, description | summary, parameters | params | args }
 * where the parameters are a JSON schema, a map of name -> type or schema, or a list of names.
 */
export function describedTools(api) {
  if (!api || typeof api.describe !== 'function') return [];
  let d; try { d = api.describe(); } catch { return []; }
  const list = Array.isArray(d) ? d : d && Array.isArray(d.methods) ? d.methods : d && typeof d === 'object' ? Object.entries(d.methods || d).map(([name, v]) => (v && typeof v === 'object' ? { name, ...v } : { name, description: String(v) })) : [];
  const out = [];
  for (const m of list) {
    const method = m && (m.method || m.name); if (!method || WRAPPED.includes(method) || typeof api[method] !== 'function' || method.startsWith('_')) continue;
    const ordered = Array.isArray(m.args) && m.args.every((a) => a && typeof a === 'object' && a.name) ? m.args : null;
    const raw = ordered ? Object.fromEntries(ordered.map((a) => [a.name, a.schema || {}])) : m.parameters || m.params || m.args || {}, tool = 'api_' + String(method).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    let parameters, positional = null;
    if (!ordered && raw && raw.type === 'object') parameters = { additionalProperties: true, ...raw };
    else {
      const names = Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x : x.name)) : Object.keys(raw), props = {};
      names.forEach((n, i) => { const v = Array.isArray(raw) ? raw[i] : raw[n], sch = v && typeof v === 'object' && !Array.isArray(v) ? v : { type: typeof v === 'string' && ['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(v) ? v : undefined }; const clean = String(n).replace(/\?$/, ''); props[clean] = { ...(sch.type ? { type: sch.type } : {}), description: sch.description || sch.about || clean, ...(sch.enum ? { enum: sch.enum } : {}), ...(sch.type === 'array' ? { items: sch.items || {} } : {}) }; });
      parameters = { type: 'object', properties: props, required: ordered ? ordered.filter((a) => a.required).map((a) => a.name) : [], additionalProperties: true }; positional = names.map((n) => String(n).replace(/\?$/, ''));
    }
    const about = String(m.description || m.summary || m.about || method);
    out.push({ name: tool, group: 'analyzer', apiMethod: method, positional, core: /(archiv|fetch|download|retriev|radial|velocit|project|coach|guide)/i.test(method + ' ' + String(m.description || m.summary || '')) || undefined, readOnly: !!(m.readOnly || m.readonly), confirm: m.confirm || (m.destructive ? 'This replaces or deletes something in the analysis.' : undefined), description: (about.length < 30 ? `${about} (the analyzer's ${method} call).` : about).slice(0, 690), parameters });
  }
  return out;
}

/** An in-memory file store (the browser keeps attachments here; the tests use it as is). onWrite(file) is told of each new file. */
export function memoryFiles({ onWrite } = {}) {
  const all = new Map();
  const about = (name, text) => { try { return ops.describeText(text, name).kind; } catch { return ''; } };
  return {
    add(name, text, origin = 'attached', extra = {}) { const f = { name, text, size: text.length, origin, about: about(name, text), ...extra }; all.set(name, f); if (onWrite && origin === 'attached') onWrite(f); return f; },
    list: () => [...all.values()].map((f) => ({ name: f.name, size: f.size, origin: f.origin, about: f.about })),
    get: (name) => all.get(name) || null,
    async readText(name) {
      const f = all.get(name) || [...all.values()].find((x) => x.name.toLowerCase() === String(name).toLowerCase()) || ([...all.values()].filter((x) => x.name.toLowerCase().includes(String(name).toLowerCase())).length === 1 ? [...all.values()].find((x) => x.name.toLowerCase().includes(String(name).toLowerCase())) : null);
      if (!f) throw new Error(`there is no file "${name}". ${all.size ? 'Files: ' + [...all.keys()].join(', ') + '.' : 'No file is attached: ask the user to attach it.'}`);
      if (f.text === null) throw new Error(`${f.name} is not a text file`);
      return f.text;
    },
    async write(name, data, mime = 'text/plain') {
      const isText = typeof data === 'string', f = { name, text: isText ? data : null, blob: isText ? null : data, size: isText ? data.length : data.size, origin: 'written', mime, about: isText ? about(name, data) : 'image' };
      all.set(name, f); if (onWrite) onWrite(f); return { name, size: f.size };
    },
    remove(name) { all.delete(name); },
    /** Put back a stored record as it is (a file kept from another page of the site). */
    put(rec) { all.set(rec.name, { about: '', origin: 'attached', mime: 'text/plain', text: null, blob: null, ...rec }); },
    clear() { all.clear(); },
  };
}
