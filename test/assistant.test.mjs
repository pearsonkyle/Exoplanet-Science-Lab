// The assistant: the tool table, the handlers (against a fake api object, and against the session-document
// api with real fits), and the harness loop against a scripted fake OpenAI-compatible endpoint.
// No network. `node test/assistant.test.mjs` (about 15 s)
import { readFileSync } from 'node:fs';
import { TOOL_SPECS, toolsFor, openAITools, checkArgs, lintSpecs } from '../src/assistant/toolspec.js';
import { createTools, memoryFiles } from '../src/assistant/tools.js';
import { createDocApi, blankSession } from '../src/assistant/docApi.js';
import { createAgent, listModels, normalizeBase, parseTextCalls, slimSpecs, CORE_TOOLS, TINY_TOOLS, TIER_CHARS, HISTORY_BUDGET, PRIMER, mixedContent, MIXED_HELP, describeError, NOT_RUN } from '../src/assistant/agent.js';
import { PRESETS, DEFAULT_PRESET, presetOf, browserOf, diagnose, testConnection } from '../src/assistant/presets.js';
import { emptyProject, updateProject, projectCard, capabilities } from '../src/assistant/project.js';
import { createTools as createToolsX, describedTools, slim as slimValue } from '../src/assistant/tools.js';
import { createSiteTools, pageOf, pageUrl, PAGES } from '../src/assistant/pages.js';
import { createStore, KEYS } from '../src/assistant/store.js';
import { numbersIn, checkNumbers, appendix } from '../src/assistant/numcheck.js';
import { readdirSync } from 'node:fs';
import * as ops from '../src/assistant/ops.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const pub = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const fetchText = async (p) => pub(p), fetchJson = async (n) => JSON.parse(pub('catalog/' + n));
const realApi = () => createDocApi({ fetchText, fetchJson });

// ---- 1. the table ------------------------------------------------------------------------------------------------
const lint = lintSpecs();
check('the tool table is well formed (names, descriptions, schemas)', lint.length === 0, lint.slice(0, 3).join('; ') || `${TOOL_SPECS.length} tools`);
for (const where of ['browser', 'mcp']) {
  const T = createTools({ api: realApi(), files: memoryFiles(), where, blankSession });
  check(`every ${where} tool has a handler, and no handler lacks a declaration`, T.missing.length === 0 && Object.keys(T.handlers).every((n) => TOOL_SPECS.some((t) => t.name === n)), `${T.specs.length} tools` + (T.missing.length ? ' missing ' + T.missing.join(',') : ''));
}
const oa = openAITools(toolsFor('browser'));
check('the table converts to OpenAI tool definitions', oa.every((t) => t.type === 'function' && t.function.name && t.function.parameters.type === 'object') && JSON.stringify(oa).length < 52000, `${JSON.stringify(oa).length} characters for ${oa.length} tools`);
const slim = slimSpecs(toolsFor('browser').filter((t) => TINY_TOOLS.includes(t.name)), 2);
check('for a small context: a core set of tools with short descriptions', [...CORE_TOOLS, ...TINY_TOOLS].every((n) => TOOL_SPECS.some((t) => t.name === n)) && JSON.stringify(openAITools(slim)).length < 0.45 * JSON.stringify(oa).length && slim.every((t) => t.description.length <= 151), `${JSON.stringify(openAITools(slim)).length} characters for ${slim.length} tools`);
const spec = (n) => TOOL_SPECS.find((t) => t.name === n);
const c1 = checkArgs(spec('set_prior'), '{"key":"rprs","type":"Uniform","a":"0.05","b":0.2}'), c2 = checkArgs(spec('set_prior'), { key: 'rprs', type: 'uniform', a: 0.05, b: 0.2, width: 3 }), c3 = checkArgs(spec('set_free'), { free: 'ecc' }), c4 = checkArgs(spec('load_example'), {}), c5 = checkArgs(spec('set_sampler'), { nlive: 5 });
check('arguments are repaired where the intent is plain ("0.05", "Uniform", a single key)', !c1.error && c1.args.a === 0.05 && c1.args.type === 'uniform' && !c3.error && Array.isArray(c3.args.free));
check('and refused with every problem named and what the tool takes', /args\.width is not a known argument/.test(c2.error) && /set_prior takes key \(required\)/.test(c2.error) && /args\.id is required/.test(c4.error) && /at least 30/.test(c5.error), c2.error);

// ---- 2. handlers against a fake api ------------------------------------------------------------------------------
function fakeApi() {
  const calls = [], S = { free: { rprs: true, inc: true, tmid: true }, values: { rprs: 0.1, ars: 8, inc: 88, per: 3, tmid: 0.5, ecc: 0, omega: 0, ld0: 0.4, ld1: 0.2 }, hasResult: false, saved: [{ id: 'k1', name: 'old run', system: 'X', updated: '2026-01-01', summary: '' }] };
  const doc = () => ({ format: 'esl-session', version: 1, name: 'Fake', star: { teff: 5000, rstar: 1, mstar: 1 }, limb_darkening: { law: 'quadratic', coefficients: [0.4, 0.2] }, planets: [{ letter: 'b', parameters: { rprs: 0.1, ars: 8, inc: 88, per: 3, tmid: 2459000.5, ecc: 0, omega: 0 } }], kepler: false, time_reference: 2459000,
    data: { light_curve: { name: 'night 1', time: [2459000.4, 2459000.5, 2459000.6], flux: [1, 0.99, 1], flux_err: [0.001, 0.001, 0.001], airmass: null, exposure_min: 1, synthetic: S.synthetic }, radial_velocity: [], timing: [] }, fit: { use: { lc: true }, free: Object.keys(S.free).filter((k) => S.free[k]).map((k) => ({ key: k, prior: { type: 'uniform', a: 0, b: 1 } })), fixed: {}, sampler: { nlive: 400 } }, result: null });
  return { calls, S,
    state: () => ({ name: 'Fake', planets: ['b'], showing: 'b', kepler: false, lightCurve: { name: 'night 1', points: 3, epochs: 1, airmass: false, inFit: true, timeReference: 2459000 }, radialVelocity: [], rvInFit: false, timing: { points: 0, inFit: false },
      parameters: Object.keys(S.values).map((k) => ({ key: k, label: k, unit: '', value: S.values[k], free: !!S.free[k], prior: { type: 'uniform', a: 0, b: 1 }, group: /^ld/.test(k) ? 'ld' : 'planet' })), star: { teff: 5000, rstar: 1, mstar: 1 }, limbDarkening: { law: 'quadratic', mode: 'coeffs', band: '' }, sampler: { nlive: 400 }, running: false, hasResult: S.hasResult, chi2: 3 }),
    examples: () => [{ id: 'single', title: 'Single transit', about: '', kinds: ['transit'] }],
    loadExample: async (id, o) => { calls.push(['loadExample', id, o]); return true; }, lookup: async (n, k) => { calls.push(['lookup', n, k]); return true; },
    setValue: (k, v) => { calls.push(['setValue', k, v]); S.values[k] = v; }, setFree: (k, on) => { calls.push(['setFree', k, on]); S.free[k] = on; }, setPrior: (k, p) => calls.push(['setPrior', k, p]), setUse: (u) => calls.push(['setUse', u]), setKepler: (on) => calls.push(['setKepler', on]), setSampler: (o) => calls.push(['setSampler', o]),
    loadLightCurve: (t, n) => { calls.push(['loadLightCurve', t.length, n]); return { points: 3 }; }, addLightCurveEpoch: (t, n) => { calls.push(['addLightCurveEpoch', n]); return { epochs: 2 }; }, addRadialVelocities: (t, n) => { calls.push(['addRadialVelocities', n]); return []; }, setTimings: (t) => { calls.push(['setTimings', t]); return { times: 2 }; },
    showPlanet: (l) => calls.push(['showPlanet', l]), setView: (o) => calls.push(['setView', o]), showTab: (t) => calls.push(['showTab', t]),
    run: async () => { calls.push(['run']); S.hasResult = true; return null; }, stop: () => calls.push(['stop']), results: () => null,
    exportSession: () => doc(), importSession: (d) => calls.push(['importSession', d.name]), save: async (n) => { calls.push(['save', n]); return { id: 'k2', name: n }; }, listSaved: async () => S.saved, openSaved: async (id) => calls.push(['openSaved', id]), deleteSaved: async (id) => calls.push(['deleteSaved', id]),
    undo: () => calls.push(['undo']), redo: () => calls.push(['redo']) };
}
{
  const api = fakeApi(), files = memoryFiles(), figs = [];
  const T = createTools({ api, files, where: 'browser', page: { comparison: () => null, figure: async (w) => { figs.push(w); return w === 'corner' ? null : { size: 1234, arrayBuffer: async () => new ArrayBuffer(4) }; } } });
  files.add('night.csv', 'time,flux,err\n' + Array.from({ length: 40 }, (_, i) => `${(2459000.4 + i * 0.005).toFixed(4)},${i > 15 && i < 25 ? 0.99 : 1},0.001`).join('\n'));
  const names = (n) => api.calls.filter((c) => c[0] === n);
  let r = await T.call('set_free', { free: ['ecc'], fixed: ['inc'] });
  check('set_free ticks and unticks through the api', r.ok && names('setFree').some((c) => c[1] === 'ecc' && c[2] === true) && names('setFree').some((c) => c[1] === 'inc' && c[2] === false));
  r = await T.call('set_free', { free: ['ars'] }); const r2 = await T.call('set_free', { free: ['bogus'] });
  check('a/R* is never freed, and an unknown key is refused with the list of keys', !r.ok && /never fitted/.test(r.text) && !r2.ok && /The parameters are: rprs, ars/.test(r2.text) && !names('setFree').some((c) => c[1] === 'ars'));
  r = await T.call('set_parameters', { values: { tmid: 2459000.52, rprs: 0.12 } });
  check('an absolute mid-transit time is given to the api relative to the time reference', r.ok && Math.abs(names('setValue').find((c) => c[1] === 'tmid')[2] - 0.52) < 1e-6 && names('setValue').find((c) => c[1] === 'rprs')[2] === 0.12);
  r = await T.call('set_prior', { key: 'tmid', type: 'uniform', a: 2459000.4, b: 2459000.6 });
  check('priors on T mid likewise; an inverted prior is refused before the api sees it', r.ok && Math.abs(names('setPrior')[0][2].a - 0.4) < 1e-6 && !(await T.call('set_prior', { key: 'rprs', type: 'uniform', a: 0.3, b: 0.1 })).ok && names('setPrior').length === 1);
  r = await T.call('load_light_curve', { file: 'night.csv', add_epoch: true });
  check('a light curve goes from an attached file to the api by name, never through the model', r.ok && names('addLightCurveEpoch').length === 1 && !/2459000\.41/.test(r.text), r.text.slice(0, 120));
  r = await T.call('load_light_curve', {}); const r3 = await T.call('load_light_curve', { file: 'nope.csv' });
  check('a missing or unknown file is explained with the files at hand', !r.ok && /Files available: night\.csv/.test(r.text) && !r3.ok && /Files: night\.csv/.test(r3.text));
  api.S.synthetic = true;
  check('confirmation: nothing asked when only a simulated stand-in would be lost', T.confirmFor('load_example', { id: 'single' }) === null && T.confirmFor('load_light_curve', { file: 'night.csv' }) === null);
  api.S.synthetic = false;
  check('confirmation: asked before the user\'s data are replaced or a saved analysis deleted; not for an added epoch or a read', /replaces/.test(T.confirmFor('load_example', { id: 'single' })) && /replaces/.test(T.confirmFor('load_light_curve', { file: 'night.csv' })) && T.confirmFor('load_light_curve', { file: 'night.csv', add_epoch: true }) === null && /permanent/.test(T.confirmFor('delete_saved', { id: 'k1' })) && T.confirmFor('get_results', {}) === null && T.confirmFor('edit_data', { exposure_min: 2 }) === null && !!T.confirmFor('edit_data', { clear_timings: true }));
  r = await T.call('delete_saved', { id: 'k1' }); const r4 = await T.call('open_saved', { id: 'zzz' });
  check('saved analyses are deleted and opened by id, with the list on a miss', r.ok && names('deleteSaved')[0][1] === 'k1' && !r4.ok && /k1 \(old run\)/.test(r4.text));
  r = await T.call('set_view', { tab: 'results', plot: 'rv', fold: true });
  check('views go through showTab and setView', r.ok && names('showTab')[0][1] === 'results' && names('setView')[0][1].view === 'rv');
  r = await T.call('get_figure', { which: 'light_curve' }); const r5 = await T.call('get_figure', { which: 'corner' });
  check('a figure is written as a PNG file, and a missing one says how to get it', r.ok && files.list().some((f) => f.name === 'light_curve.png' && f.origin === 'written') && !r5.ok && /needs a fit result/.test(r5.text));
  r = await T.call('write_file', { name: 'notes.md', content: '# hi' }); const r6 = await T.call('write_file', { name: '../x.md', content: 'x' }); const r7 = await T.call('read_file', { name: 'night.csv', max_chars: 300 });
  check('files: write, refuse a path, read a large file as summary plus head', r.ok && !r6.ok && r7.ok && r7.data.rows === 40 && r7.data.columns.length === 3 && r7.data.content.length === 300 && /load_light_curve/.test(r7.data.advice));
  r = await T.call('no_such', {}); check('an unknown tool is answered with the tool list', !r.ok && /The tools are: get_state/.test(r.text));
  const card = T.stateCard();
  check('the state card says what is loaded, what is free, the fit and the files', /System loaded in the app[^\n]*Fake/.test(card) && /light curve "night 1": 3 points/.test(card) && /Free parameters \(\d\): rprs/.test(card) && /Fit result: no fit yet/.test(card) && /night\.csv/.test(card) && card.length < 2500, `${card.length} characters`);
}

// ---- 3. handlers against the session-document api, with real fits ------------------------------------------------
const api = realApi(), files = memoryFiles(), T = createTools({ api, files, fetchJson, where: 'mcp', blankSession });
const call = async (n, a = {}) => { const r = await T.call(n, a); if (!r.ok) console.log('     ' + n + ': ' + r.text); return r; };
await call('load_example', { id: 'single', fresh: true }); await call('set_sampler', { nlive: 60 });
let r = await call('run_fit', { label: 'base' });
const byKey = (o, k) => (Object.entries(o).find(([n]) => n.split(' ')[0] === k) || [])[1];
check('run_fit returns a compact summary: evidence, values with intervals, derived (each named in plain words), warnings', r.ok && r.data.converged && /^0\.14\d+ \+0\.00\d+ -0\.00\d+$/.test(byKey(r.data.parameters, 'rprs')) && byKey(r.data.derived, 'b') && Object.keys(r.data.derived).some((k) => /impact parameter: 0 = across the centre/.test(k)) && r.text.length < 2600 && !/\[\s*-?\d+\.\d+,\s*-?\d+\.\d+,\s*-?\d/.test(r.text), `${r.text.length} characters; rprs = ${byKey(r.data.parameters, 'rprs')}`);
r = await call('run_experiment', { kind: 'eccentricity', report: 'ecc.md' });
const rep = files.get('ecc.md');
check('run_experiment runs both models, compares them with the page\'s rules and writes the report', r.ok && r.data.variants.length === 2 && r.data.comparison.runs.length === 2 && r.data.comparison.runs.some((x) => x.reading === 'reference') && /highest evidence/.test(r.data.comparison.verdict) && rep && /\| Run \| Free parameters \|/.test(rep.text) && rep.text.includes(r.data.comparison.verdict), r.data.comparison ? r.data.comparison.verdict : r.text);
r = await call('compare_runs');
check('compare_runs lists every run on the same data', r.ok && r.data.runs.length === 3 && typeof r.data.rule === 'string');
const twin = await call('run_fit', { label: 'eccentric again' }), cmp2 = await call('compare_runs');
check('a run that repeats an earlier model is flagged as the same model, in the result and in the comparison', twin.ok && /^#3/.test(twin.data.same_model_as) && /same model/.test(twin.data.next) && cmp2.data.cautions.some((c) => /#4 \(eccentric again\) and #3 \(eccentric\) are the same model/.test(c)), twin.data.same_model_as);
const mk = (id, logZ, err, extra = {}) => ({ id, label: '', name: 'x', free: ['rprs'], priors: { rprs: { type: 'uniform', a: 0, b: 1 } }, law: 'quadratic', use: { lc: true }, dataKey: 'k', logZ, err, converged: true, stopReason: 'converged', ess: 900, insertionP: 0.5, chi2: 100, n: 100, k: 1, nWarnings: 0, headline: '', ...extra });
const top = mk(1, 100, 0.2), rb = (dz, e = 0.2, x = {}) => ops.readBayes(mk(2, 100 + dz, e, x), top);
check('the reading follows the analyzer\'s thresholds (1 and twice the error, 2.5, 5; not comparable unless converged)', rb(-0.9) === 'indistinguishable' && rb(-1.5, 0.8) === 'indistinguishable' && rb(-1.5) === 'weakly disfavoured' && rb(-3) === 'moderately disfavoured' && rb(-6) === 'strongly disfavoured' && rb(-6, 0.2, { converged: false }) === 'not comparable');
const al = ops.runAlarms(mk(2, 99, 0.2, { ess: 50, chi2: 300, priors: { rprs: { type: 'uniform', a: 0, b: 2 } }, converged: false, stopReason: 'max calls reached' }), top);
check('cautions: not converged, few samples, bad chi2, different priors', al.length === 4 && /lower bound/.test(al[0]) && /prior volume/.test(al[3]), `${al.length} cautions`);
const other = ops.compareRuns([mk(1, 100, 0.2), mk(2, 90, 0.2, { dataKey: 'other' })], 'k');
check('runs on other data are left out of a comparison', other.runs.length === 1 && other.hidden === 1);
for (const kind of ['session', 'report', 'python', 'results_csv', 'samples_csv', 'light_curve_csv']) { r = await call('export_file', { kinds: [kind] }); if (!r.ok) check('export ' + kind, false, r.text); }
check('result files are written: session, report, script, tables', files.list().filter((f) => f.origin === 'written').length >= 7 && JSON.parse(files.get('hat_p_32_b_session.json').text).result.parameters.length > 0 && /^# /.test(files.get('hat_p_32_b_report.md').text));
r = await call('export_file', { kind: 'report' }); const both = await call('export_file', { kinds: ['latex', 'timing_csv'] });
check('export_file: a single "kind" is understood; several at once report what was written and what could not be', r.ok && r.data.written[0].kind === 'report' && both.ok && both.data.written[0].kind === 'latex' && /timing list is empty/.test(both.data.failed[0].why));
r = await call('explain_results'); const res0 = api.results(), t14 = res0.derived.t14.median, sent = r.data.sentences.join('\n');
check('explain_results: the software writes the plain-language reading, conversions included', r.ok && sent.includes(`which is ${Number((t14 * 24).toPrecision(3))} `) && /hours/.test(sent) && /Earth radii/.test(sent) && /0 being through the centre/.test(sent) && /says nothing about whether the model is good/.test(sent) && /do not add conversions/.test(r.data.note), r.data.sentences.find((x) => /hours/.test(x)));
files.add('lc.csv', files.get('hat_p_32_b_lightcurve.csv').text);
r = await call('lookup_planet', { name: 'HAT-P-32 b' });
check('lookup_planet replaces a simulated light curve', r.ok && !r.data.kept_data);
await call('load_light_curve', { file: 'lc.csv' }); r = await call('lookup_planet', { name: 'WASP-12 b' });
check('but keeps a light curve loaded from a file, moving T mid onto it', r.ok && r.data.kept_data && /259 points/.test(r.data.kept_data[0]) && /orbits/.test(r.data.tmid_note || '') && api.state().lightCurve.points === 259, r.data.tmid_note);
r = await call('load_light_curve', { file: 'lc.csv', planet: 'HAT-P-32 b' });
check('load_light_curve with "planet" takes the system from the catalogue', r.ok && r.data.system.name === 'HAT-P-32' && api.state().name === 'HAT-P-32');
await call('add_planet', { parameters: { per: 9 } }); const two = api.state().planets.join(); await call('set_limb_darkening', { law: 'linear' }); await call('remove_planet', { letter: 'c' });
check('planets are added and removed, the law changed, through the session document', two === 'b,c' && api.state().planets.join() === 'b' && api.state().limbDarkening.law === 'linear');
files.add('t.csv', pub('examples/ephemeris/wasp12_decay_times.csv')); await call('lookup_planet', { name: 'WASP-12 b' }); await call('set_timings', { file: 't.csv' });
r = await call('fit_ephemeris'); const pg = await call('timing_periodogram');
check('timing: ephemeris with its reading, periodogram with the page\'s verdict', r.ok && /strongly preferred/.test(r.data.reading) && pg.ok && pg.data.verdict.length > 50 && pg.data.peaks.length > 0);
r = await call('simulate_light_curve', { noise_ppm: 300, n_epochs: 2 }); const dd = await call('describe_data');
check('a simulation replaces the light curve and is described by handle', r.ok && dd.data.data[0].handle === 'light_curve' && dd.data.data[0].epochs === 2 && dd.data.data[0].simulated === true && dd.data.data[0].median_error_ppm === 300);
r = await call('search_catalog', { query: 'trappist' }); check('the catalogue is searched by name', r.ok && r.data.matches.some((m) => /TRAPPIST-1/.test(m.name)));
r = await call('undo'); check('undo steps back', r.ok && r.data.done === true);

// ---- 4. the harness against a scripted endpoint ------------------------------------------------------------------
const sse = (chunks) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const ch of chunks) c.enqueue(e.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(e.encode('data: [DONE]\n\n')); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const toolCall = (name, args, stream = true) => (stream ? sse([{ choices: [{ delta: { role: 'assistant', content: '' } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name, arguments: '' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 10 } }])
  : json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }));
const say = (text, stream = true) => (stream ? sse([{ choices: [{ delta: { content: text.slice(0, 5) } }] }, { choices: [{ delta: { content: text.slice(5) }, finish_reason: 'stop' }] }]) : json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
/** A fake server: each request takes the next scripted reply (a Response or a function of the request body). */
function endpoint(script) { const seen = []; const f = async (url, init) => { const body = init && init.body ? JSON.parse(init.body) : null; seen.push({ url, headers: init.headers, body }); if (init.signal && init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } const next = script.length > 1 ? script.shift() : script[0]; return typeof next === 'function' ? next(body, init) : next; }; f.seen = seen; return f; }
function harness(script, extra = {}) {
  const a = fakeApi(), fl = memoryFiles(), tl = createTools({ api: a, files: fl, where: 'browser' }), events = [], f = endpoint(script);
  const agent = createAgent({ base: 'http://llm.test/v1', model: 'm', tools: tl, fetch: f, contextLimit: 32000, onEvent: (e) => events.push(e), ...extra });
  return { agent, events, f, api: a, files: fl, tools: tl };
}
{
  const h = harness([toolCall('set_free', { free: ['ecc'] }), say('Done: e is free.')], { apiKey: 'sk-test' });
  const end = await h.agent.send('free the eccentricity');
  const [q1, q2] = h.f.seen, lastMsg = q2.body.messages[q2.body.messages.length - 1];
  check('loop: tool call, result, final answer (streamed)', end === 'answered' && h.api.calls.some((c) => c[0] === 'setFree' && c[1] === 'ecc') && h.events.some((e) => e.type === 'tool_end' && e.ok) && h.events.find((e) => e.type === 'assistant' && e.final).text === 'Done: e is free.' && h.events.filter((e) => e.type === 'assistant_delta').length === 2);
  check('the request carries the primer, the tools and the live state card after the newest message', q1.body.messages[0].role === 'system' && q1.body.messages[0].content === PRIMER && q1.body.tools.some((t) => t.function.name === 'more_tools') && h.tools.specs.every((t) => q1.body.tools.some((x) => x.function.name === t.name) || q1.body.tools.find((x) => x.function.name === 'more_tools').function.description.includes(t.name)) && /CURRENT STATE OF THE APP/.test(q1.body.messages[1].content) && q1.body.messages[1].content.trim().endsWith('free the eccentricity') && lastMsg.role === 'tool' && /CURRENT STATE OF THE APP/.test(lastMsg.content) && /ecc = 0 ~/.test(lastMsg.content) && !/CURRENT STATE/.test(q2.body.messages[1].content));
  check('requests go only to the configured base, with the key in the Authorization header', h.f.seen.every((s) => s.url === 'http://llm.test/v1/chat/completions' && s.headers.Authorization === 'Bearer sk-test'));
}
{
  const h = harness([json({ error: { message: 'stream is not supported' } }, 400), toolCall('get_results', {}, false), say('No fit yet.', false)]);
  const end = await h.agent.send('results?');
  check('a server without streaming: falls back once and stays non-streaming', end === 'answered' && h.f.seen.length === 3 && h.f.seen[0].body.stream === true && h.f.seen[1].body.stream === undefined && h.f.seen[2].body.stream === undefined && h.agent.info().stream === false && h.events.find((e) => e.type === 'assistant' && e.final).text === 'No fit yet.', `${h.f.seen.length} requests`);
}
{
  const h = harness([json({ error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } }, 400), say('I will free it.\n```json\n{"tool": "set_free", "args": {"free": ["ecc"]}}\n```'), say('Eccentricity is now free.')]);
  const end = await h.agent.send('free e');
  const sysmsg = h.f.seen[1].body.messages[0].content, back = h.f.seen[2].body.messages;
  check('a server without tool calling: JSON-in-text protocol', end === 'answered' && h.api.calls.some((c) => c[0] === 'setFree' && c[1] === 'ecc') && h.f.seen[1].body.tools === undefined && /TOOLS\nTo call a tool/.test(sysmsg) && /- set_free\(free\?: array, fixed\?: array\)/.test(sysmsg) && back[back.length - 1].role === 'user' && /^TOOL RESULT \(set_free\)/.test(back[back.length - 1].content) && h.events.some((e) => e.type === 'note' && /JSON-in-text/.test(e.text)) && h.agent.info().native === false);
}
{
  const h = harness([say('<|tool_call>call:set_free{"free": ["omega"]}<tool_call|>'), say('ok')]);
  await h.agent.send('free omega');
  const p = parseTextCalls('```json\n{"name":"run_fit","arguments":{"label":"a {b}"}}\n```\nand {"tool":"unknown_tool","args":{}}', ['run_fit']);
  check('calls a model writes as text are repaired (Gemma\'s form, fenced JSON), unknown names ignored', h.api.calls.some((c) => c[0] === 'setFree' && c[1] === 'omega') && p.calls.length === 1 && p.calls[0].args.label === 'a {b}');
}
{
  const h = harness([() => toolCall('get_state', {})], { maxSteps: 3 });
  const end = await h.agent.send('loop forever');
  const capped = h.f.seen.length, ends = h.events.filter((e) => e.type === 'tool_end');
  check('step cap: stops after the allowed steps and says so', end === 'cap' && capped === 3 && h.events.some((e) => e.type === 'cap' && e.steps === 3));
  check('a call repeated with the same result is refused the third time', ends.length === 3 && ends[0].ok && ends[1].ok && !ends[2].ok && /exact call was (just|already) made/.test(ends[2].text));
  h.f.seen.length = 0; const end2 = await h.agent.resume();
  check('"continue" resumes the same request for another round of steps', end2 === 'cap' && h.f.seen.length === 3 && h.f.seen[0].body.messages.filter((m) => m.role === 'tool').length === 3);
}
{
  const asked = [];
  const h = harness([toolCall('load_example', { id: 'single' }), say('I did not load it.')], { confirm: async (q) => { asked.push(q); return false; } });
  await h.agent.send('open the example');
  const te = h.events.find((e) => e.type === 'tool_end');
  check('confirmation: a declined call does not run and the model is told', asked.length === 1 && asked[0].name === 'load_example' && /replaces/.test(asked[0].reason) && te.denied && /^DENIED/.test(te.text) && !h.api.calls.some((c) => c[0] === 'loadExample') && /DENIED/.test(h.f.seen[1].body.messages.at(-1).content));
  const h5 = harness([() => toolCall('load_example', { id: 'single' })], { confirm: async (q) => { asked.push(q); return false; } }); const n0 = asked.length; await h5.agent.send('open it'); 
  check('a model that retries a declined action is not allowed to ask the user twice: the request ends', asked.length === n0 + 1 && h5.f.seen.length === 2 && /you declined that action/.test(h5.events.find((e) => e.type === 'assistant' && e.final).text) && !h5.api.calls.some((c) => c[0] === 'loadExample'));
  asked.length = 1;
  const h2 = harness([toolCall('load_example', { id: 'single' }), toolCall('set_free', { free: ['ecc'] }), say('Loaded.')], { confirm: async (q) => { asked.push(q); return true; } });
  await h2.agent.send('open the example');
  check('an allowed call runs; a harmless call is not asked about', h2.api.calls.some((c) => c[0] === 'loadExample' && c[1] === 'single') && asked.length === 2);
}
{
  const big = 'x'.repeat(30000);
  const h = harness([toolCall('write_file', { name: 'a.txt', content: 'hello' }), say('first answer ' + 'lorem '.repeat(300)), toolCall('read_file', { name: 'big.txt', max_chars: 20000 }), toolCall('read_file', { name: 'big.txt', max_chars: 20000, offset: 5 }), toolCall('read_file', { name: 'big.txt', max_chars: 20000, offset: 9 }), say('second answer'), say('third answer')], { contextLimit: 5000, maxTokens: 300 });
  h.files.add('big.txt', big);
  await h.agent.send('write a file ' + 'and consider this '.repeat(100)); await h.agent.send('now read the big file three times'); await h.agent.send('thanks, what now?');
  const lastReq = h.f.seen.at(-1).body, chars = JSON.stringify(lastReq.messages).length, stored = h.agent.turns[1].steps[0].results[0].text;
  const ctx = h.events.filter((e) => e.type === 'context' && e.trimmed);
  check('context: a long tool result is capped when stored, the whole kept for read_result', stored.length < 2400 && /more characters: read_result \{"id": "call_\d+"/.test(stored) && h.agent.turns[1].steps[0].results[0].full.length > 20000, `${stored.length} characters kept of ${big.length}`);
  if (process.env.DEBUG) console.log(ctx, h.agent.preview().tokens, lastReq.messages.map((m) => m.role + ':' + m.content.length + ':' + m.content.slice(0, 80)));
  check('context: near the limit, old results shrink and old requests become a summary; the prompt stays inside the budget', ctx.length > 0 && /summarised/.test(ctx.at(-1).trimmed) && /\[Earlier in this conversation, summarised by the app\]/.test(lastReq.messages[1].content) && /Tools used: write_file/.test(lastReq.messages[1].content) && lastReq.messages.at(-1).content.includes('thanks, what now?') && h.agent.preview().tokens <= ctx.at(-1).budget && lastReq.tools.length < h.tools.specs.length, `${ctx.at(-1).trimmed}; ${chars} characters sent; ${lastReq.tools.length} core tools with short descriptions`);
}
{
  let release; const gate = new Promise((r) => (release = r));
  const h = harness([async (b, init) => { await new Promise((res, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); gate.then(res); }); return say('late'); }]);
  const p = h.agent.send('wait'); setTimeout(() => h.agent.stop(), 20); const end = await p; release();
  check('stop aborts the request in flight', end === 'stopped' && h.events.some((e) => e.type === 'done' && e.reason === 'stopped'));
  const h2 = harness([json({ error: { message: 'model not found' } }, 404)]); const e2 = await h2.agent.send('hi');
  check('a server error ends the request with a readable message', e2 === 'error' && /not found/.test(h2.events.find((e) => e.type === 'error').message));
  const h4 = harness([toolCall('get_state', {}), say('I saved `session.json` and report.md for you.'), toolCall('write_file', { name: 'report.md', content: '# r' }), say('I wrote report.md. I did not write a session file.')]); await h4.agent.send('save things');
  check('an answer naming a file that was never written is sent back once for the file or a correction', h4.f.seen.length === 4 && /mentions session\.json, report\.md, but no such file exists/.test(h4.f.seen[2].body.messages.at(-1).content) && h4.files.list().some((f) => f.name === 'report.md') && /did not write a session/.test(h4.events.find((e) => e.type === 'assistant' && e.final).text));
  const h6 = harness([toolCall('get_state', {}), say('The fit is set up. I will write the notes next.'), toolCall('write_file', { name: 'notes.md', content: '# n' }), say('Here are the notes: notes.md.')]); await h6.agent.send('set it up and write notes');
  check('an answer that ends by promising an action is sent back once to do it', h6.f.seen.length === 4 && /ends with "I will write the notes next\."/.test(h6.f.seen[2].body.messages.at(-1).content) && h6.agent.turns[0].final === 'Here are the notes: notes.md.');
  const h7 = harness([toolCall('get_state', {}), say('Rp/R* is in the table.'), toolCall('get_figure', { which: 'light_curve' }), say('Done, with the figure.')]); await h7.agent.send('fit it and give me a figure');
  const h8 = harness([toolCall('get_state', {}), say('Done.')]); await h8.agent.send('fit it, no figure needed');
  check('a figure asked for and not made: the model is asked once to make it; not when the user said no figure', h7.f.seen.length === 4 && /asked for a figure and none was made/.test(h7.f.seen[2].body.messages.at(-1).content) && h7.events.some((e) => e.type === 'tool_end' && e.name === 'get_figure') && h8.f.seen.length === 2);
  const h3 = harness([say('I will load the example now.'), toolCall('get_state', {}), say('done')]); await h3.agent.send('load it');
  check('a promise without a call is nudged once into acting', h3.f.seen.length === 3 && /called no tool/.test(h3.f.seen[1].body.messages.at(-1).content));
}
{
  const f = async (url, init) => { f.seen = { url, init }; return json({ object: 'list', data: [{ id: 'gemma', max_model_len: 131072 }, { id: 'text-embedding-x' }, { id: 'small', context_length: 4096 }] }); };
  const m = await listModels('llm.test:9', { fetch: f, apiKey: 'k' });
  check('models are listed with their context window; embedding models are skipped', m.length === 2 && m[0].context === 131072 && m[1].context === 4096 && f.seen.url === 'http://llm.test:9/v1/models' && f.seen.init.headers.Authorization === 'Bearer k' && f.seen.init.credentials === 'omit');
  check('addresses are normalised', normalizeBase('http://llm.test:9') === 'http://llm.test:9/v1' && normalizeBase(' https://x.test/api/v1/chat/completions ') === 'https://x.test/api/v1' && normalizeBase('') === '');
}

// ---- 5. the number check on answers ------------------------------------------------------------------------------
{
  const src = ['{"parameters":{"rprs (Rp/R*)":"0.1487 +0.0011 -0.0010","inc":"88.21 +0.50 -0.45 deg"},"derived":{"t14":"0.1296 +0.0008 -0.0007 d"},"evidence":"1234.56 ± 0.12","n_data":259}'];
  const nums = numbersIn('HD 80606 b, run #3 on 2026-11-15 at 21:40: Rp/R* = 0.1487 with 3 planets, ld0 fixed, 68% interval, file hat_p_32_b.csv, 12,345 calls, version 4.3.1').map((n) => n.raw);
  check('numbers worth checking are found; names, dates, counts, keys and file names are not', nums.join() === '0.1487,12,345', nums.join(' '));
  const good = checkNumbers('Rp/R* = 0.1487 +0.0011 -0.0010, inclination 88.21 +0.50 -0.45 degrees, ln Z = 1234.56 ± 0.12 from 259 points.', src);
  const bare = checkNumbers('Rp/R* is 0.1487 and the evidence is 1234.56.', src), conv = checkNumbers('Rp/R* = 0.1487 +0.0011 -0.0010; the transit lasts 3.11 hours, a depth of 2.21%.', src), round = checkNumbers('The duration is 0.130 +0.0008 -0.0007 d.', src);
  check('an answer that quotes the tool results exactly passes', good.ok, JSON.stringify(good));
  check('a value quoted without its uncertainty is caught', !bare.ok && bare.bare.length === 2 && bare.bare[0].full === '0.1487 +0.0011 -0.0010' && !bare.unsupported.length);
  check('an invented conversion is caught (hours from days, percent from a fraction); a rounded value is not', !conv.ok && conv.unsupported.join() === '3.11,2.21' && !conv.bare.length && round.unsupported.length === 0, conv.unsupported.join(' '));
  const ap = appendix(conv, ['| Quantity | Value |\n|---|---|\n| rprs | 0.1487 +0.0011 -0.0010 |']);
  check('the appendix names the numbers and carries the tool table verbatim', /Checked by the app/.test(ap) && /3\.11, 2\.21 do not appear/.test(ap) && ap.includes('| rprs | 0.1487 +0.0011 -0.0010 |') && appendix(good, ['x']) === '');

  // through the harness, on a real stored result
  const a = realApi(), fl = memoryFiles(), tl = createTools({ api: a, files: fl, where: 'browser' }), ev = [];
  await a.loadExample('single');
  const res = a.results(), rp = ops.pmText(res.parameters.find((p) => p.key === 'rprs')), bareRp = rp.split(' ')[0];
  const f1 = endpoint([toolCall('get_results', {}), say(`The fit gives Rp/R* = ${bareRp}, so the planet blocks 2.21% of the light and the transit lasts 3.11 hours.`)]);
  const ag = createAgent({ base: 'http://llm.test/v1', model: 'm', tools: tl, fetch: f1, contextLimit: 32000, onEvent: (e) => ev.push(e) });
  await ag.send('what is the radius ratio?');
  const fin = ev.find((e) => e.type === 'assistant' && e.final).text;
  check('harness: an answer with a dropped uncertainty and invented conversions gets the tool\'s table appended verbatim', fin.startsWith('The fit gives') && /Checked by the app/.test(fin) && fin.includes(`| ${rp}`) && /\| Quantity \| Value/.test(fin) && ev.some((e) => e.type === 'note' && /table was added/.test(e.text)) && ag.turns[0].check.ok === false && ag.turns[0].check.unsupported.includes('3.11'), fin.split('\n').slice(0, 1).join(' ') + ' … ' + (fin.match(/\| rprs[^\n]*/) || [''])[0]);
  const f2 = endpoint([toolCall('get_results', {}), say(`Rp/R* = ${rp} (the fit converged).`)]), ev2 = [];
  const ag2 = createAgent({ base: 'http://llm.test/v1', model: 'm', tools: tl, fetch: f2, contextLimit: 32000, onEvent: (e) => ev2.push(e) });
  await ag2.send('radius ratio?');
  check('harness: a faithful answer is left as written', ev2.find((e) => e.type === 'assistant' && e.final).text === `Rp/R* = ${rp} (the fit converged).` && ag2.turns[0].check.ok === true);
  check('the primer forbids computing or converting and asks for uncertainties as returned', /Never compute, convert/.test(PRIMER) && /always quoted with it/.test(PRIMER) && /navigate/.test(PRIMER));
}

// ---- 6. tools per page, and a request that continues on another page ---------------------------------------------
const ROOT = 'https://esl.test/site/';
function fakePlan() {
  const st = { site: 'Greenwich', target: '', calls: [] };
  return { st, ready: () => true, state: () => [`Site: ${st.site}. Target filter: ${st.target || 'all planets'}.`],
    tools: [
      { name: 'plan_set_site', core: true, description: 'Choose where the observations are made: an observatory by name or coordinates.', parameters: { type: 'object', properties: { observatory: { type: 'string', description: 'name' } }, required: [], additionalProperties: false }, run: ({ observatory }) => { st.site = observatory; st.calls.push(['site', observatory]); return { site: observatory }; } },
      { name: 'plan_list_transits', readOnly: true, description: 'The transits found for the current site, nights, target and limits.', parameters: { type: 'object', properties: {}, additionalProperties: false }, run: () => ({ transits: [{ index: 1, planet: 'WASP-43 b', mid_utc: '2026-11-23T11:39Z', timing_1sigma: '± 0.16 min' }] }) },
      { name: 'plan_open_transit', description: 'Open one transit of the list elsewhere: the sky view, the analyzer or the catalogue.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'n' }, in: { type: 'string', enum: ['observe', 'analyze'], description: 'where' } }, required: ['index', 'in'], additionalProperties: false }, run: ({ in: where }) => ({ transit: 'WASP-43 b', navigate: { page: where, params: { planet: 'WASP-43 b' } } }) },
      { name: 'plan_clear_all', confirm: (a) => (a.sure ? null : 'This clears every setting of the planner.'), description: 'Clear every setting of the planner page (asks the user first).', parameters: { type: 'object', properties: { sure: { type: 'boolean', description: 'x' } }, additionalProperties: false }, run: () => { st.calls.push(['clear']); return { done: 'cleared' }; } },
    ] };
}
{
  check('pages: an address is mapped to its page, and a page to its address', pageOf('https://esl.test/site/plan/?planet=x', ROOT) === 'plan' && pageOf('https://esl.test/site/analyze/photometry/index.html', ROOT) === 'photometry' && pageOf('https://esl.test/site/observe/', ROOT) === 'observe' && pageOf('https://esl.test/site/', ROOT) === 'home' && pageOf('/analyze/', '/') === 'analyze'
    && pageUrl(ROOT, 'plan', { planet: 'WASP-43 b' }) === 'https://esl.test/site/plan/?planet=WASP-43+b' && pageUrl(ROOT, 'analyze') === 'https://esl.test/site/analyze/?skipintro' && pageUrl(ROOT, 'analyze', { planet: 'X b' }) === 'https://esl.test/site/analyze/?planet=X+b' && pageUrl(ROOT, 'validation', { topic: 'sampler' }) === 'https://esl.test/site/methods/#val-sampler', pageUrl(ROOT, 'analyze'));
  const fl = memoryFiles(), plan = fakePlan(), P = createSiteTools({ page: 'plan', root: ROOT, pageApi: plan, files: fl });
  const an = createTools({ api: fakeApi(), files: fl, where: 'browser' }), A = createSiteTools({ page: 'analyze', root: ROOT, analyzer: an, analyzerApi: null, files: fl });
  const H = createSiteTools({ page: 'home', root: ROOT, files: fl });
  check('tools per page: the planner has navigate, its own tools and the file tools; the analyzer its own; the landing page navigate and files', P.problems.length === 0 && P.names.join() === 'navigate,plan_set_site,plan_list_transits,plan_open_transit,plan_clear_all,list_files,read_file,write_file' && A.names[0] === 'navigate' && A.names.includes('run_fit') && A.names.filter((n) => n === 'list_files').length === 1 && !A.names.includes('plan_set_site') && H.names.join() === 'navigate,list_files,read_file,write_file', `${P.names.length} / ${A.names.length} / ${H.names.length} tools`);
  const wrong = await P.call('run_fit', {}), wrong2 = await A.call('plan_set_site', { observatory: 'x' }), same = await P.call('navigate', { page: 'plan' }), badp = await P.call('navigate', { page: 'observe', params: { zoom: 3 } });
  check('a tool of another page is refused with where to find it; so is navigating to the page one is on, or with an unknown parameter', !wrong.ok && /tool of the analyze page: call navigate/.test(wrong.text) && !wrong2.ok && /tool of the plan page/.test(wrong2.text) && !same.ok && /already on the plan page/.test(same.text) && !badp.ok && /no address parameter zoom/.test(badp.text));
  const nav = await P.call('navigate', { page: 'analyze', params: { planet: 'WASP-43 b' } }), open = await P.call('plan_open_transit', { index: 1, in: 'observe' });
  check('navigate, and a page action that continues elsewhere, stop the loop with the address to open', nav.ok && nav.halt.reason === 'navigate' && nav.halt.url === 'https://esl.test/site/analyze/?skipintro' && nav.halt.after.tool === 'lookup_planet' && nav.halt.after.args.name === 'WASP-43 b' && open.ok && open.halt.page === 'observe' && /observe\/\?planet=WASP-43\+b$/.test(open.halt.url) && open.data.navigating_to === 'observe');
  const card = P.stateCard(), cardA = A.stateCard();
  check('the state card says which page this is, what it shows and the files', /^CURRENT STATE/.test(card) && /Page: plan/.test(card) && /Site: Greenwich/.test(card) && /Files: none attached/.test(card) && /Page: analyze/.test(cardA) && /System loaded in the app/.test(cardA) && /Free parameters/.test(cardA));
  check('confirmation: a page tool says when it needs the user\'s yes', /clears every setting/.test(P.confirmFor('plan_clear_all', {})) && P.confirmFor('plan_clear_all', { sure: true }) === null && P.confirmFor('plan_set_site', {}) === null && /permanent/.test(A.confirmFor('delete_saved', { id: 1 })));
  await P.call('plan_set_site', { observatory: 'Kitt Peak' }); await P.call('plan_list_transits', {}); await P.call('write_file', { name: 'n.md', content: 'x' });
  check('the action log lists what was changed (not what was read)', P.actions.map((a) => a.name).join() === 'navigate,plan_open_transit,plan_set_site,write_file' && /navigating_to: analyze/.test(P.actions[0].summary) && /Kitt Peak/.test(P.actions[2].summary) && P.canUndo() === false, P.actions.map((a) => `${a.name}: ${a.summary}`).join(' | '));
  const lt = await P.call('plan_list_transits', {});
  check('a page tool\'s rows come with a table for the number check', /\| index \| planet \| mid_utc \| timing_1sigma \|/.test(lt.table) && lt.table.includes('± 0.16 min'));
  // the spectroscopy page declares its own tools (src/spectra/main.js; driven headlessly by test/spectroscopy_tools_check.py)
  const sp = await P.call('spectroscopy_fit_white', {});
  check('spectroscopy: a page with tools of its own, and its tool names point there from elsewhere', !PAGES.spectroscopy.noTools && !sp.ok && /tool of the spectroscopy page: call navigate/.test(sp.text), sp.text.slice(0, 120));
}
{
  // "plan the transits of WASP-43 b from Kitt Peak, then set up a fit": starts on the planner, ends in the analyzer
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  const local = mem(), session = mem(); let clock = 1e12;
  const store = createStore({ local, session, idb: null, now: () => clock });
  const fl = memoryFiles(), plan = fakePlan(), T1 = createSiteTools({ page: 'plan', root: ROOT, pageApi: plan, files: fl }), ev1 = [];
  const script = [toolCall('plan_set_site', { observatory: 'Kitt Peak' }), toolCall('plan_open_transit', { index: 1, in: 'analyze' }), toolCall('set_free', { free: ['ecc'] }), say('The planner is on Kitt Peak and the fit of WASP-43 b is set up with the eccentricity free.')];
  const f = endpoint(script);
  const a1 = createAgent({ base: 'http://llm.test/v1', model: 'm', apiKey: 'sk-page', tools: T1, fetch: f, contextLimit: 32000, onEvent: (e) => ev1.push(e) });
  const end1 = await a1.send('Plan the transits of WASP-43 b from Kitt Peak, then set up a fit.');
  const halt = ev1.find((e) => e.type === 'halt');
  check('continuation: the loop stops at the page change, with nothing sent after it', end1 === 'navigate' && f.seen.length === 2 && halt && halt.halt.url === 'https://esl.test/site/analyze/?skipintro' && halt.halt.after.args.name === 'WASP-43 b' && plan.st.site === 'Kitt Peak' && a1.turns[0].final === null && a1.turns[0].halted.page === 'analyze');
  // what the panel does at that point: save, go; and on the new page: load, rebuild the tools, resume
  store.saveSettings({ base: 'http://llm.test/v1', model: 'm', apiKey: 'sk-page', rememberKey: false, maxSteps: 14 });
  store.saveChat({ turns: a1.turns, log: ev1, actions: T1.actions, open: true, pending: { at: clock, page: 'analyze', after: halt.halt.after } });
  check('settings: the key is not written to the lasting storage unless asked; it survives the page change in the tab\'s own', !/sk-page/.test(local.getItem(KEYS.settings)) && session.getItem(KEYS.key) === 'sk-page' && store.loadSettings().apiKey === 'sk-page' && store.peek().pending === true);
  store.saveSettings({ base: 'http://llm.test/v1', model: 'm', apiKey: 'sk-page', rememberKey: true }); const kept = /sk-page/.test(local.getItem(KEYS.settings)) && session.getItem(KEYS.key) === null; store.saveSettings({ base: 'http://llm.test/v1', model: 'm', apiKey: 'sk-page', rememberKey: false });
  check('settings: with "remember" the key is kept, and dropped again when the box is cleared', kept && !/sk-page/.test(local.getItem(KEYS.settings)));
  clock += 2000;
  const chat = createStore({ local, session, idb: null, now: () => clock }).loadChat(), S2 = store.loadSettings();
  const api2 = fakeApi(), an2 = createTools({ api: api2, files: fl, where: 'browser' }), T2 = createSiteTools({ page: 'analyze', root: ROOT, analyzer: an2, files: fl }), ev2 = [];
  const a2 = createAgent({ base: S2.base, model: S2.model, apiKey: S2.apiKey, tools: T2, fetch: f, contextLimit: 32000, onEvent: (e) => ev2.push(e) });
  a2.restore(chat.turns);
  await a2.runTool(chat.pending.after.tool, chat.pending.after.args);   // what the page change promised: the planet is looked up on arrival
  const end2 = await a2.resume(), req3 = f.seen[2].body, lastTool = req3.messages.filter((m) => m.role === 'tool').at(-1);
  check('continuation: on the new page the same request resumes with that page\'s tools and state', chat.pending && chat.pending.page === 'analyze' && end2 === 'answered' && f.seen.length === 4 && req3.messages[1].content.includes('Plan the transits of WASP-43 b') && /navigating_to":"analyze/.test(req3.messages.filter((m) => m.role === 'tool').at(-2).content) && /"loaded":/.test(lastTool.content) && /Page: analyze/.test(lastTool.content) && req3.tools.some((t) => t.function.name === 'set_free') && !req3.tools.some((t) => t.function.name === 'plan_set_site') && api2.calls.some((c) => c[0] === 'lookup' && c[1] === 'WASP-43 b') && req3.messages.filter((m) => m.role === 'tool').length === 3 && api2.calls.some((c) => c[0] === 'setFree' && c[1] === 'ecc') && /eccentricity free/.test(a2.turns[0].final) && f.seen[2].headers.Authorization === 'Bearer sk-page', `${f.seen.length} requests over two pages`);
  check('continuation: tool-call ids go on from the restored conversation', a2.turns[0].steps.map((s) => s.calls[0].id).join() === 'call_1,call_2,call_3,call_4');
  clock += 10 * 60 * 1000;
  check('a pending request that is minutes old is not resumed', createStore({ local, session, idb: null, now: () => clock }).loadChat().pending === null && createStore({ local, session, idb: null, now: () => clock }).peek().pending === false);
  const big = { turns: Array.from({ length: 30 }, (_, i) => ({ user: 'q' + i, steps: [{ content: '', calls: [{ id: 'call_' + i, name: 'x', args: {} }], results: [{ id: 'call_' + i, name: 'x', text: 'y'.repeat(60000) }] }], final: 'a' })), log: [], actions: [] };
  const okSave = store.saveChat(big), back = store.loadChat();
  check('a conversation too large for the storage loses its oldest requests, not the newest', okSave && back.turns.length < 30 && back.turns.at(-1).user === 'q29' && local.getItem(KEYS.chat).length <= 1.2e6, `${back.turns.length} of 30 requests kept`);
  // a navigation loop is cut
  const T3 = createSiteTools({ page: 'plan', root: ROOT, pageApi: fakePlan(), files: fl, maxNavigations: 2 }); await T3.call('navigate', { page: 'observe' }); await T3.call('navigate', { page: 'search' }); const third = await T3.call('navigate', { page: 'analyze' });
  check('a request cannot change page without end', !third.ok && /changed page 2 times/.test(third.text));
}
{
  // confirmation through the harness for a page tool, and undo of an action in the analyzer
  const asked = [], fl = memoryFiles(), plan = fakePlan(), T = createSiteTools({ page: 'plan', root: ROOT, pageApi: plan, files: fl });
  const ag = createAgent({ base: 'http://llm.test/v1', model: 'm', tools: T, fetch: endpoint([toolCall('plan_clear_all', {}), say('I left the settings as they were.')]), contextLimit: 32000, onEvent: () => {}, confirm: async (q) => { asked.push(q); return false; } });
  await ag.send('clear the planner');
  check('confirmation flow on a page tool: asked once, declined, not run, the model told', asked.length === 1 && asked[0].name === 'plan_clear_all' && /clears every setting/.test(asked[0].reason) && !plan.st.calls.some((c) => c[0] === 'clear') && /^DENIED/.test(ag.turns[0].steps[0].results[0].text));
  const api = realApi(); await api.loadExample('single', { fresh: true });
  const an = createTools({ api, files: fl, where: 'browser' }), A = createSiteTools({ page: 'analyze', root: ROOT, analyzer: an, analyzerApi: api, files: fl });
  const free0 = api.state().parameters.filter((p) => p.free).map((p) => p.key).join();
  await A.call('set_free', { free: ['ecc', 'omega'], fixed: ['inc'] }); await A.call('get_state', {});
  const free1 = api.state().parameters.filter((p) => p.free).map((p) => p.key).join(), can = A.canUndo(), u = A.undoAction();
  check('the action log undoes a whole action through the analyzer\'s own undo, however many steps it took', can && free1 !== free0 && u.ok && u.steps === 3 && api.state().parameters.filter((p) => p.free).map((p) => p.key).join() === free0 && A.actions.length === 1 && A.actions[0].undone === true && A.canUndo() === false, `${u.steps} undo steps; free ${free1} -> ${free0}`);
}

{
  // "set it up but do not run it": the fit is refused whatever the model decides
  const h = harness([toolCall('set_free', { free: ['ecc'] }), toolCall('run_fit', {}), say('The fit is set up with the eccentricity free; it was not run.')]);
  await h.agent.send('Free the eccentricity and set up the fit (do not run it).');
  const te = h.events.filter((e) => e.type === 'tool_end');
  check('a request that says not to run gets no fit, whatever the model calls', te.length === 2 && te[0].ok && !te[1].ok && /asked not to run a fit/.test(te[1].text) && !h.api.calls.some((c) => c[0] === 'run') && NOT_RUN.test('set it up without running') && !NOT_RUN.test("Don't forget to run the fit") && !NOT_RUN.test('run the fit without fitting the eccentricity') && !NOT_RUN.test('fit it; do not change the period'));
  const cn = checkArgs({ name: 't', parameters: { type: 'object', properties: { r: { type: 'array', description: 'x', items: { type: ['number', 'null'], description: 'y' } } }, additionalProperties: false } }, { r: ['null', '10'] });
  check('"null" and "10" written as strings are read as null and 10', !cn.error && cn.args.r[0] === null && cn.args.r[1] === 10, cn.error || '');
}

// ---- 7. a queue of variants, the analyzer's own description, small helpers ----------------------------------------
{
  const api = realApi(), fl = memoryFiles(), T = createTools({ api, files: fl, where: 'mcp', blankSession });
  await T.call('load_example', { id: 'single', fresh: true }); await T.call('set_sampler', { nlive: 50 });
  const q = await T.call('run_experiment', { kind: 'custom', report: 'queue.md', variants: [{ name: 'quadratic law' }, { name: 'linear law', setup: [{ tool: 'set_limb_darkening', args: { law: 'linear' } }] }, { name: 'bad step', setup: [{ tool: 'delete_saved', args: { id: 1 } }] }] });
  check('a variant may not smuggle in a destructive step', !q.ok && /cannot be a set-up step/.test(q.text));
  const q2 = await T.call('run_experiment', { kind: 'custom', report: 'queue.md', variants: [{ name: 'linear law', setup: [{ tool: 'set_limb_darkening', args: { law: 'linear' } }] }, { name: 'quadratic law' }] });
  const lnz = q2.ok ? q2.data.comparison.runs.map((r) => r.lnZ) : [];
  check('a queue of variants with set-up steps: each starts from the same set-up, runs in turn, and is compared by the analyzer\'s rules', q2.ok && q2.data.variants.length === 2 && q2.data.variants.every((v) => v.run) && api.state().limbDarkening.law === 'quadratic' && lnz.every((z) => /^-?\d+\.\d\d ± \d+\.\d\d$/.test(z)) && q2.data.comparison.runs.some((r) => r.reading === 'reference') && /\| #\d linear law \|/.test(q2.table) && q2.table.includes(q2.data.comparison.verdict) && /set-up: set_limb_darkening/.test(fl.get('queue.md').text), q2.ok ? q2.data.comparison.verdict : q2.text);
  const one = await T.call('run_experiment', { kind: 'companion' });
  check('"with and without the companion" needs a companion', !one.ok && /has one planet/.test(one.text));
  const m = await T.call('set_moon', { parameters: { rmoon: 0.02 } }), keys = api.state().parameters.map((p) => p.key), off = await T.call('set_moon', { on: false }), ph = await T.call('set_phase_curve', { parameters: { fpfs: 0.002 } }), nb = await T.call('set_nbody', { on: true });
  check('moon and phase curve are switched on a session document; N-body is refused without a second planet', m.ok && keys.includes('rmoon') && off.ok && !api.state().parameters.some((p) => p.key === 'rmoon') && ph.ok && api.state().parameters.some((p) => p.key === 'fpfs' && p.value === 0.002) && !nb.ok && /two planets/.test(nb.text));
  const d = await T.call('get_derived', {}), lr = await T.call('list_runs', {});
  check('derived quantities and the run history are read from the software', d.ok && (d.data.derived || d.data.planets) && lr.ok && lr.data.runs.length === 2 && /±/.test(lr.data.runs[0].lnZ));
}
{
  const calls = [], api = { ...fakeApi(), describe: () => [{ name: 'setFoo', description: 'Sets the foo of the analysis to a value, as the Foo panel does.', params: { value: 'number', mode: { type: 'string', description: 'how', enum: ['a', 'b'] } } }, { name: 'state', description: 'covered already' }, { name: 'ghost', description: 'described but not there' }, { name: 'setBar', description: 'Sets the bar of the analysis, in the form the analyzer itself describes its calls.', args: [{ name: 'key', required: true, schema: { type: 'string', description: 'which' } }, { name: 'options', required: false, schema: { type: 'object', description: 'how' } }], parameters: { type: 'object', properties: {} } }], setBar: (k, o) => { calls.push(['bar', k, o]); }, setFoo: (v, m) => { calls.push([v, m]); return { foo: v, big: Array.from({ length: 500 }, (_, i) => i) }; }, companionSearch: async () => ({ period: 9.1, mass: 0.2, significant: true }), addCompanion: async (c) => { calls.push(['add', c]); return 'c'; } };
  const T = createTools({ api, files: memoryFiles(), where: 'browser' }), dt = describedTools(api);
  const r = await T.call('api_set_foo', { value: '3', mode: 'b' }), cs = await T.call('companion_search', {}), ac = await T.call('add_companion', {}), bar = await T.call('api_set_bar', { key: 'k', options: { a: 1 } }), bar2 = await T.call('api_set_bar', {});
  check('tools are generated from the analyzer\'s own description for what no declared tool covers; feature-detected tools appear with their method', dt.length === 2 && dt[0].name === 'api_set_foo' && dt[1].positional.join() === 'key,options' && bar.ok && calls.some((c) => c[0] === 'bar' && c[1] === 'k' && c[2].a === 1) && !bar2.ok && /args\.key is required/.test(bar2.text) && T.names.includes('api_set_foo') && T.names.includes('companion_search') && !createTools({ api: fakeApi(), files: memoryFiles(), where: 'browser' }).names.includes('companion_search') && r.ok && calls[0][0] === 3 && calls[0][1] === 'b' && r.data.big === '[500 numbers]' && cs.ok && ac.ok && ac.data.added === 'c' && calls.find((c) => c[0] === 'add')[1].period === 9.1 && lintSpecs(T.specs.map((t) => ({ ...t, where: undefined }))).filter((p) => !/no description/.test(p)).length === 0);
  check('a value is cut down before a model reads it', JSON.stringify(slimValue({ samples: [[1, 2]], a: new Float64Array(40), s: 'x'.repeat(900) })).length < 500);
  check('mixed content is recognised: an https page calling plain http on another machine, not on this one', mixedContent('http://llm.test:9/v1', 'https://esl.test/analyze/') && !mixedContent('https://llm.test/v1', 'https://esl.test/') && !mixedContent('http://llm.test:9/v1', 'http://esl.test/') && !mixedContent('http://' + 'local' + 'host:9/v1', 'https://esl.test/') && /reverse proxy/.test(MIXED_HELP) && /mcp\//.test(MIXED_HELP) && /npm run dev/.test(MIXED_HELP));
  const bytes = new Uint8Array(5760), card = (s) => s.padEnd(80, ' '), hdr = [card('SIMPLE  =                    T'), card('BITPIX  =                   16'), card('NAXIS   =                    2'), card('NAXIS1  =                  512'), card("OBJECT  = 'HAT-P-32'"), card('END')].join('');
  for (let i = 0; i < 2880; i++) bytes[i] = i < hdr.length ? hdr.charCodeAt(i) : 32;
  const ht = ops.fitsHeaderText(bytes.buffer), fl = memoryFiles(); fl.add('frame.fits', ht, 'attached', { size: 5760, about: 'FITS image' });
  const T2 = createSiteTools({ page: 'photometry', root: ROOT, files: fl }), rd = await T2.call('read_file', { name: 'frame.fits' });
  check('an attached FITS image is read as its header', /^SIMPLE  =/.test(ht) && /OBJECT  = 'HAT-P-32'/.test(ht) && !/END/.test(ht) && ops.fitsHeaderText(new TextEncoder().encode('time,flux').buffer) === null && rd.ok && /NAXIS1  =                  512/.test(rd.data.content));
}
// ---- 8. presets, the connection test, the history budget, tool tiers, the project across pages ------------------
{
  const VPNB = 'http://' + ['192', '168', '1', '20'].join('.') + ':8000/v1', LMSB = PRESETS[0].base,   // VPNB: a model server on another machine, entered as Custom
   HTTPS = 'https://exoplanet.science/analyze/', CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', SAFARI = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
  check('browsers are told apart (Safari, Chromium, Firefox)', browserOf(SAFARI) === 'safari' && browserOf(CHROME) === 'chromium' && browserOf('Mozilla/5.0 Gecko/20100101 Firefox/133.0') === 'firefox');
  /** A fake network: GET /models, POST /chat/completions and the no-cors probe each answer as told ('ok' | 'cors' | 'down' | 'hang' | a status). */
  const net = ({ models = 'ok', chat = 'ok', probe = 'ok' } = {}) => { const seen = []; const f = async (url, init = {}) => {
    const what = init.mode === 'no-cors' ? probe : init.method === 'POST' ? chat : models; seen.push({ url, mode: init.mode || '', method: init.method || 'GET' });
    if (what === 'hang') return new Promise((_, rej) => init.signal && init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    if (what === 'cors' || what === 'down') throw new TypeError('Failed to fetch');
    if (typeof what === 'number') return json({ error: 'no' }, what);
    return init.mode === 'no-cors' ? new Response(null, { status: 200 }) : init.method === 'POST' ? json({ choices: [{ message: { content: 'ready' } }] }) : json({ data: [{ id: 'gemma', max_model_len: 32768 }] });
  }; f.seen = seen; return f; };
  const lms = async (url, init = {}) => (/\/api\/v0\/models$/.test(url) ? json({ data: [{ id: 'a', state: 'not-loaded', max_context_length: 262144 }, { id: 'b', state: 'loaded', loaded_context_length: 32768, max_context_length: 131072 }] }) : init.method === 'POST' ? json({ choices: [{ message: { content: 'ready' } }] }) : json({ data: [{ id: 'a' }, { id: 'b' }] }));
  const lm = await testConnection(PRESETS[0].base, { fetch: lms, pageUrl: 'http://localhost:5173/', userAgent: CHROME, listModels, ms: 200 });
  check('connection to LM Studio: the context and the loaded model come from its own model list', lm.ok && lm.model === 'b' && lm.models.find((m) => m.id === 'b').context === 32768 && lm.models.find((m) => m.id === 'a').context === 262144, lm.message);
  const T = (base, o, page = 'http://localhost:5173/analyze/', ua = CHROME) => testConnection(base, { fetch: net(o), pageUrl: page, userAgent: ua, listModels, ms: 60 });
  const mixed = await T(VPNB, {}, HTTPS), saf = await T(LMSB, {}, HTTPS, SAFARI), good = await T(VPNB, {}), lmOk = await T(LMSB, {}, HTTPS);
  check('connection: an https page cannot call a model server on another machine (mixed content): said before anything is sent, with the three ways round it', !mixed.ok && mixed.kind === 'mixed' && /mixed content/.test(mixed.message) && /npm run dev/.test(mixed.message) && /https/.test(mixed.message) && /MCP/.test(mixed.message) && diagnose(VPNB, { pageUrl: HTTPS }).blocked && !diagnose(VPNB, { pageUrl: 'http://localhost:8942/' }).blocked, mixed.message.slice(0, 90));
  check('connection: Safari blocks http://localhost from an https page, Chrome does not', !saf.ok && saf.kind === 'safari' && /Safari/.test(saf.message) && lmOk.ok && diagnose(LMSB, { pageUrl: HTTPS, userAgent: CHROME }).kind === 'loopback');
  check('connection: a working server lists its models and answers a one-word chat request', good.ok && good.kind === 'ok' && good.models[0].id === 'gemma' && good.model === 'gemma' && good.steps.length === 2, good.message);
  const cors = await T(LMSB, { models: 'cors' }, HTTPS), down = await T(LMSB, { models: 'down', probe: 'down' }, HTTPS), vpnDown = await T(VPNB, { models: 'down', probe: 'down' }), pre = await T(LMSB, { chat: 'cors' }, HTTPS), auth = await T(VPNB, { models: 401 }), slow = await T(VPNB, { models: 'hang' }), n404 = await T(VPNB, { models: 404 });
  check('connection: CORS refused (the server answers a no-cors probe): "Enable CORS" in LM Studio, and Chrome\'s local-network prompt', !cors.ok && cors.kind === 'cors' && /Enable CORS/.test(cors.message) && /local network/i.test(cors.message), cors.message.slice(0, 120));
  check('connection: nothing listening on localhost, or on another machine: said so, with what to check', down.kind === 'unreachable' && /Start server/.test(down.message) && vpnDown.kind === 'unreachable');
  check('connection: models listed but the chat POST blocked: a failed CORS preflight, with the exact advice', pre.kind === 'preflight' && /preflight/.test(pre.message) && /Enable CORS/.test(pre.message) && pre.models.length === 1);
  check('connection: a key wanted, no answer in time, not an OpenAI base URL', auth.kind === 'auth' && /API key/.test(auth.message) && slow.kind === 'timeout' && /did not answer/.test(slow.message) && n404.kind === 'not_openai');
  // the settings: on first use the default preset is preselected; what the user chose is kept
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const st = createStore({ local: mem(), session: mem(), idb: null }), first = st.loadSettings();
  st.saveSettings({ ...first, preset: 'lmstudio', base: LMSB, model: 'qwen', lastGood: { preset: 'lmstudio', base: LMSB, model: 'qwen', at: 1 } }); const again = st.loadSettings();
  check('settings: first use preselects LM Studio on this computer; the last good server and model are remembered', first.preset === 'lmstudio' && first.base === LMSB && first.model === '' && first.historyBudget === HISTORY_BUDGET && again.preset === 'lmstudio' && again.base === LMSB && again.model === 'qwen' && again.lastGood.model === 'qwen');
}
{
  // the history budget: past it, older requests become the app's summary; the fixed part (primer, tools, state) is not counted
  const answers = () => Array.from({ length: 6 }, (_, i) => [toolCall('get_state', {}), say(`answer ${i} ` + 'words '.repeat(150))]).flat();
  const small = harness(answers(), { contextLimit: 131072, historyBudget: 1500 }), big = harness(answers(), { contextLimit: 131072, historyBudget: 100000 });
  for (let i = 0; i < 6; i++) { await small.agent.send(`question ${i} ` + 'context '.repeat(60)); await big.agent.send(`question ${i} ` + 'context '.repeat(60)); }
  const us = small.events.filter((e) => e.type === 'usage'), ub = big.events.filter((e) => e.type === 'usage'), lastS = small.f.seen.at(-1).body.messages, lastB = big.f.seen.at(-1).body.messages;
  const histS = us.at(-1).estimate - us.at(-1).fixed, histB = ub.at(-1).estimate - ub.at(-1).fixed;
  check('history budget: past it the oldest requests are summarised by the app; the request stays within fixed + budget', /\[Earlier in this conversation, summarised by the app\]/.test(lastS[1].content) && /question 0/.test(lastS[1].content) && us.at(-1).estimate <= us.at(-1).budget && histS <= 1500 && !/summarised by the app/.test(JSON.stringify(lastB)) && histB > 1500, `history ${histS} tokens (budget 1500) against ${histB} without a budget; ${lastS.length} against ${lastB.length} messages`);
  check('every request reports its estimate and the server\'s prompt tokens', us.length === small.f.seen.length && us.every((u) => u.estimate > 0 && u.fixed > 0) && us.some((u) => u.prompt_tokens === 900));
}
{
  // tool tiers: a long tool list shows the core and names the rest under more_tools; more_tools and a direct call add them
  const h = harness([toolCall('more_tools', { names: ['set_moon', 'nope'] }), toolCall('set_view', { tab: 'results' }), say('done')]);
  await h.agent.send('show the results tab');
  const [q1, q2, q3] = h.f.seen.map((x) => x.body.tools.map((t) => t.function.name)), mt = h.f.seen[0].body.tools.find((t) => t.function.name === 'more_tools');
  check('tool tiers: the core tools and more_tools; the others named in its description', JSON.stringify(openAITools(h.tools.specs)).length > TIER_CHARS && q1.includes('run_fit') && q1.includes('simulate_light_curve') && !q1.includes('set_moon') && !q1.includes('set_view') && /set_moon \(/.test(mt.function.description) && JSON.stringify(h.f.seen[0].body.tools).length < 0.75 * JSON.stringify(openAITools(h.tools.specs)).length, `${q1.length} of ${h.tools.specs.length} tools sent, ${JSON.stringify(h.f.seen[0].body.tools).length} of ${JSON.stringify(openAITools(h.tools.specs)).length} characters`);
  check('more_tools adds the definitions it is asked for; a hidden tool called directly runs and is shown afterwards', q2.includes('set_moon') && !q2.includes('set_view') && q3.includes('set_view') && h.api.calls.some((c) => c[0] === 'showTab') && /"unknown":\["nope"\]/.test(h.agent.turns[0].steps[0].results[0].text));
  const big = 'y'.repeat(9000), h2 = harness([toolCall('read_file', { name: 'big.txt', max_chars: 9000 }), (b) => toolCall('read_result', { id: 'call_1', offset: 2500 }), say('read')], { historyBudget: 2000 });
  h2.files.add('big.txt', big); await h2.agent.send('read the big file');
  const rr = JSON.parse(h2.agent.turns[0].steps[1].results[0].text);
  check('read_result reads the rest of a cut result from the copy the harness kept; it is offered only once something was cut', rr.characters.startsWith('2500 to') && rr.text.length === 4000 && !h2.f.seen[0].body.tools.some((t) => t.function.name === 'read_result') && h2.f.seen[1].body.tools.some((t) => t.function.name === 'read_result'), rr.characters);
  const hf = harness([toolCall('set_free', { values: { ecc: 0, omega: 0 } }), say('ok')]); await hf.agent.send('free e and w');
  const ex = await createTools({ api: fakeApi(), files: memoryFiles(), where: 'browser' }).call('set_view', { tab: 'results', colour: 'red' }), ex2 = await createTools({ api: fakeApi(), files: memoryFiles(), where: 'browser' }).call('set_prior', { key: 'rprs', type: 'uniform', a: 0, width: 3 });
  check('an argument a tool does not take is dropped when nothing else is wrong (and the result says so); with another problem the call is refused', ex.ok && /colour \(set_view does not take it\)/.test(ex.text) && !ex2.ok && /width/.test(ex2.text));
  check('set_free given a map of values (a common slip) frees its keys', hf.events.find((e) => e.type === 'tool_end').ok && hf.api.calls.some((c) => c[0] === 'setFree' && c[1] === 'omega' && c[2] === true));
}
{
  // the project across pages: built from tool results, saved, and in the state card of every page
  let p = emptyProject();
  const plan = fakePlan(); plan.tools.find((t) => t.name === 'plan_open_transit').run = ({ in: where }) => (where === 'details' ? { transit: { index: 1, planet: 'WASP-43 b' }, mid_bjd_tdb: '2461367.98612', ephemeris: 'Kokori 2023' } : { transit: { index: 1, planet: 'WASP-43 b', mid_utc: '2026-11-23T11:39Z', observable: 'yes', conditions_of_100: '87' }, navigate: { page: where, params: { planet: 'WASP-43 b' } } });
  const fl = memoryFiles(), P = createSiteTools({ page: 'plan', root: ROOT, pageApi: plan, files: fl, project: () => p });
  const open = await P.call('plan_open_transit', { index: 1, in: 'analyze' });
  const real = plan.tools.find((t) => t.name === 'plan_open_transit').run; plan.tools.find((t) => t.name === 'plan_open_transit').run = (a) => ({ ...real(a), transit: { index: 2, planet: 'TOI-3645.01', tess_candidate: 'not a confirmed planet' } });
  const toi = await createSiteTools({ page: 'plan', root: ROOT, pageApi: plan, files: fl }).call('plan_open_transit', { index: 2, in: 'analyze' }); plan.tools.find((t) => t.name === 'plan_open_transit').run = real;
  check('a transit opened in the analyzer carries the planner\'s own BJD of its mid-time; a TESS candidate is refused before the page changes', open.ok && open.data.mid_bjd_tdb === '2461367.98612' && open.halt.page === 'analyze' && !toi.ok && !toi.halt && /TESS candidate/.test(toi.text) && /confirmed planet/.test(toi.text));
  const evs = [
    { page: 'plan', name: 'plan_set_site', ok: true, data: { site: 'Kitt Peak National Observatory, Arizona (31.963° N, 111.600° W, 2120 m)' } },
    { page: 'plan', name: 'plan_list_transits', ok: true, data: { site: 'Kitt Peak National Observatory', dates: 'tonight, 7 nights', transits: [{ index: 1, planet: 'WASP-43 b', mid_utc: '2026-11-23T11:39Z', observable: 'yes', conditions_of_100: '87' }, { index: 2, planet: 'HAT-P-32 b', mid_utc: '2026-11-20T05:00Z', observable: 'yes', conditions_of_100: '60' }] } },
    { page: 'plan', name: 'plan_open_transit', args: { index: 1, in: 'analyze' }, ok: true, data: open.data },
    { page: 'analyze', name: 'lookup_planet', ok: true, data: { loaded: 'WASP-43', period_d: 0.813 } },
    { page: 'analyze', name: 'simulate_light_curve', ok: true, data: { simulated: 'light curve "Synthetic observation": 212 points (simulated)', mid_transit: 2461367.98612 } },
    { page: 'analyze', name: 'run_fit', ok: true, data: { has_result: true, run: '#1', converged: true, evidence: { lnZ: 1290.1, error: 0.2 }, parameters: { 'rprs (Rp/R*, planet-to-star radius ratio)': '0.1601 +0.0004 -0.0004', 'tmid (mid-transit time)': '2461367.98610 +0.00012 -0.00011 d' } } },
    { page: 'analyze', name: 'get_figure', ok: true, data: { written: 'light_curve.png' } },
    { page: 'analyze', name: 'run_fit', ok: false, data: null },
  ];
  const before = projectCard(evs.slice(0, 4).reduce((q, e) => updateProject(q, e, 1000), emptyProject()));
  for (const e of evs) p = updateProject(p, e, 1000);
  check('project: until the planned night is simulated, PROJECT says so and how; afterwards that it is', /No light curve of the planned night yet: simulate_light_curve with mid_transit "planned"/.test(before) && /simulated for the planned night \(mid-transit BJD_TDB 2461367\.98612\)/.test(projectCard(p)));
  const mem = new Map(), st = createStore({ local: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }, session: null, idb: null });
  st.saveProject(p); const back = st.loadProject(), card = projectCard(back);
  check('project: site, planned event (with its BJD), system, data, the fit\'s numbers and the files, from tool results only', /Kitt Peak/.test(card) && /Planned event[^\n]*WASP-43 b[^\n]*BJD_TDB 2461367\.98612/.test(card) && /System in the analyzer: WASP-43/.test(card) && /rprs 0\.1601 \+0\.0004 -0\.0004/.test(card) && /tmid 2461367\.98610 \+0\.00012 -0\.00011 d/.test(card) && /ln Z 1290\.1 ± 0\.2/.test(card) && /light_curve\.png/.test(card) && /plan → analyze/.test(card) && back.fits.length === 1 && card.length < 1400, `${card.length} characters`);
  const an = createTools({ api: fakeApi(), files: fl, where: 'browser' }), A = createSiteTools({ page: 'analyze', root: ROOT, analyzer: an, files: fl, project: () => back }), cardA = A.stateCard(), cardP = P.stateCard();
  check('project: carried into the state card of another page, with what this version cannot do', /PROJECT \(carried across pages/.test(cardA) && /BJD_TDB 2461367\.98612/.test(cardA) && /cannot fetch them from an archive/.test(cardA) && /PROJECT/.test(cardP) && !/cannot fetch/.test(cardP));
  const rvApi = { ...fakeApi(), describe: () => [{ name: 'fetchArchiveRV', description: 'Fetch the archival radial velocities of the loaded planet from the NASA Exoplanet Archive and add them as datasets.', args: [{ name: 'planet', required: false, schema: { type: 'string', description: 'name' } }] }], fetchArchiveRV: async () => ({ added: 2 }) };
  const anRV = createTools({ api: rvApi, files: fl, where: 'browser' }), ARV = createSiteTools({ page: 'analyze', root: ROOT, analyzer: anRV, files: fl, project: () => back });
  const hRV = createAgent({ base: 'http://llm.test/v1', model: 'm', tools: ARV, fetch: endpoint([say('x')]), contextLimit: 32000 });
  check('a tool that fetches archival velocities, when the analyzer describes one, is named in PROJECT and shown with the core tools', /api_fetch_archive_rv searches the archives/.test(ARV.stateCard()) && capabilities(ARV.specs, 'analyze')[0].includes('api_fetch_archive_rv') && (await (async () => { await hRV.send('rv?'); return true; })()) && hRV.preview().sp.some((t) => t.name === 'api_fetch_archive_rv'));
  // the planned night in the analyzer: T mid and its prior move to it, and the simulation is centred there
  const api = realApi(), T = createTools({ api, files: memoryFiles(), where: 'mcp', blankSession });
  await T.call('load_example', { id: 'single', fresh: true });
  const s0 = api.state(), tm = s0.parameters.find((x) => x.key === 'tmid'), per = s0.parameters.find((x) => x.key === 'per').value, abs0 = tm.value + (s0.lightCurve.timeReference || 0), want = abs0 + 250 * per;
  const r = await T.call('simulate_light_curve', { mid_transit: want }), s1 = api.state(), tm1 = s1.parameters.find((x) => x.key === 'tmid'), d = (await T.call('describe_data')).data.data[0], tr = s1.lightCurve.timeReference || 0;
  check('simulate_light_curve on a planned night: T mid and its prior moved there, the light curve centred on it', r.ok && Math.abs(tm1.value + (tm1.value > 1e5 ? 0 : tr) - want) < 1e-6 && Math.abs((tm1.prior.a + tm1.prior.b) / 2 - tm1.value) < Math.abs(tm.prior.b - tm.prior.a) && Math.abs((d.from + d.to) / 2 - (tm1.value)) < 0.05 && /250 orbits/.test(r.data.tmid_note), `${r.data.mid_transit} wanted ${want.toFixed(5)}; data ${d.from}..${d.to}`);
  const miss = await T.call('lookup_planet', { name: 'TOI-9999.01' });
  check('a planet the catalogue lacks: nothing is loaded, and the model is told what the analyzer still holds and not to report it as that planet', !miss.ok && /still holds HAT-P-32/.test(miss.text) && /Do not fit it or report results as TOI-9999\.01/.test(miss.text) && /^HAT-P-32/.test(api.state().name), miss.text.slice(0, 160));
  const plannedAt = (want + 3 * per).toFixed(5), T2 = createTools({ api, files: memoryFiles(), where: 'mcp', blankSession, planned: () => plannedAt });
  const rp = await T2.call('simulate_light_curve', { mid_transit: 'planned' }), rw = await T2.call('simulate_light_curve', { mid_transit: want }), rn = await createTools({ api, files: memoryFiles(), where: 'mcp', planned: () => null }).call('simulate_light_curve', { mid_transit: 'planned' });
  const bjd = '2461367.98612', T3 = createTools({ api, files: memoryFiles(), where: 'mcp', blankSession, planned: () => bjd }), iso = new Date((Number(bjd) - 2440587.5) * 864e5 + 60000).toISOString().slice(0, 16) + 'Z', ri = await T3.call('simulate_light_curve', { mid_transit: iso }), rbad = await T3.call('simulate_light_curve', { mid_transit: '2001-01-01T00:00Z' });
  check('a UTC time is read as the planned event only when it is that event; otherwise refused, pointing to "planned"', ri.ok && Math.abs(Number(ri.data.mid_transit) - Number(bjd)) < 1e-6 && !rbad.ok && /not a UTC time/.test(rbad.text), ri.ok ? `${iso} -> ${ri.data.mid_transit}` : ri.text);
  check('mid_transit "planned" is the plan page\'s BJD; another night is simulated but flagged as not the planned one; without a plan it is refused', rp.ok && Math.abs(Number(rp.data.mid_transit) - Number(plannedAt)) < 1e-6 && !/not the planned/.test(rp.data.tmid_note) && rw.ok && /not the planned event/.test(rw.data.tmid_note) && !rn.ok && /no event was planned/.test(rn.text), `${rp.data && rp.data.mid_transit} for ${plannedAt}`);
}
{
  // The only model-server addresses in the site are the two presets the owner asked for, in src/assistant/presets.js;
  // any other address (an IP literal, or host:port/v1), or any key, anywhere the site, the MCP server or these tests ship from, fails.
  const LMS = 'http://' + 'local' + 'host:1234/v1', ALLOWED = { '../src/assistant/presets.js': [LMS] };
  const walk = (d) => readdirSync(new URL(d, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(d + e.name + '/')) : /\.(js|mjs|md|css|json|html|py)$/.test(e.name) && e.name !== 'package-lock.json' ? [d + e.name] : []));
  const files = [...walk('../src/'), ...walk('../mcp/'), ...readdirSync(new URL('../test/', import.meta.url)).filter((n) => /^assistant/.test(n)).map((n) => '../test/' + n)], bad = [], seen = {};
  for (const fpath of files) {
    const text = readFileSync(new URL(fpath, import.meta.url), 'utf8'), allow = ALLOWED[fpath] || [];
    const urls = [...text.matchAll(/https?:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+):\d{2,5}(?:\/v1)?\b/gi)].map((m) => m[0]).filter((u) => /\/v1$/i.test(u) || /^https?:\/\/(\d|\[)/i.test(u) && !/^https?:\/\/127\.0\.0\.1:/.test(u) || /:1234$/.test(u));
    for (const u of urls) { if (allow.includes(u)) (seen[u] = (seen[u] || 0) + 1); else bad.push(`${fpath}: ${u}`); }
    const rest = allow.reduce((t, u) => t.split(u).join(''), text);
    for (const m of rest.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) if (m[0] !== '127.0.0.1' && m.slice(1).every((x) => Number(x) < 256) && !urls.some((u) => u.includes(m[0]))) bad.push(`${fpath}: ${m[0]}`);
    for (const m of text.matchAll(/\b(?:sk|lm|hf|gsk|xai)-[A-Za-z0-9_-]{16,}\b|\bBearer [A-Za-z0-9._-]{16,}/g)) bad.push(`${fpath}: a key`);
    for (const m of text.matchAll(/apiKey\s*[:=]\s*['"`]([^'"`]{8,})['"`]/g)) if (!/^sk-(test|page)$/.test(m[1])) bad.push(`${fpath}: a key`);
  }
  check('the only model-server address is the LM Studio preset, written once in presets.js; no other address or key anywhere', bad.length === 0 && seen[LMS] === 1, bad.slice(0, 4).join('; ') || `${files.length} files read`);
  check('presets: LM Studio on this computer only (the default); any other server is Custom', PRESETS.length === 1 && PRESETS[0].base === LMS && DEFAULT_PRESET === PRESETS[0].id && /LM Studio/.test(PRESETS[0].label) && presetOf(LMS + '/') === 'lmstudio' && presetOf('http://other.test:1/v1') === 'custom');
}
process.exit(ok ? 0 : 1);
