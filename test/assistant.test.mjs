// The assistant: the tool table, the handlers (against a fake api object, and against the session-document
// api with real fits), and the harness loop against a scripted fake OpenAI-compatible endpoint.
// No network. `node test/assistant.test.mjs` (about 15 s)
import { readFileSync } from 'node:fs';
import { TOOL_SPECS, toolsFor, openAITools, checkArgs, lintSpecs } from '../src/assistant/toolspec.js';
import { createTools, memoryFiles } from '../src/assistant/tools.js';
import { createDocApi, blankSession } from '../src/assistant/docApi.js';
import { createAgent, listModels, normalizeBase, parseTextCalls, slimSpecs, CORE_TOOLS, PRESETS, PRIMER } from '../src/assistant/agent.js';
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
check('the table converts to OpenAI tool definitions', oa.every((t) => t.type === 'function' && t.function.name && t.function.parameters.type === 'object') && JSON.stringify(oa).length < 40000, `${JSON.stringify(oa).length} characters for ${oa.length} tools`);
const slim = slimSpecs(toolsFor('browser').filter((t) => CORE_TOOLS.includes(t.name)), 2);
check('for a small context: a core set of tools with short descriptions', CORE_TOOLS.every((n) => TOOL_SPECS.some((t) => t.name === n)) && JSON.stringify(openAITools(slim)).length < 0.45 * JSON.stringify(oa).length && slim.every((t) => t.description.length <= 151), `${JSON.stringify(openAITools(slim)).length} characters for ${slim.length} tools`);
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
  return { agent, events, f, api: a, files: fl };
}
{
  const h = harness([toolCall('set_free', { free: ['ecc'] }), say('Done: e is free.')], { apiKey: 'sk-test' });
  const end = await h.agent.send('free the eccentricity');
  const [q1, q2] = h.f.seen, lastMsg = q2.body.messages[q2.body.messages.length - 1];
  check('loop: tool call, result, final answer (streamed)', end === 'answered' && h.api.calls.some((c) => c[0] === 'setFree' && c[1] === 'ecc') && h.events.some((e) => e.type === 'tool_end' && e.ok) && h.events.find((e) => e.type === 'assistant' && e.final).text === 'Done: e is free.' && h.events.filter((e) => e.type === 'assistant_delta').length === 2);
  check('the request carries the primer, the tools and the live state card after the newest message', q1.body.messages[0].role === 'system' && q1.body.messages[0].content === PRIMER && q1.body.tools.length === toolsFor('browser').length && /CURRENT STATE OF THE APP/.test(q1.body.messages[1].content) && q1.body.messages[1].content.trim().endsWith('free the eccentricity') && lastMsg.role === 'tool' && /CURRENT STATE OF THE APP/.test(lastMsg.content) && /ecc = 0 ~/.test(lastMsg.content) && !/CURRENT STATE/.test(q2.body.messages[1].content));
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
  check('a call repeated with the same result is refused the third time', ends.length === 3 && ends[0].ok && ends[1].ok && !ends[2].ok && /exact call was just made/.test(ends[2].text));
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
  check('context: a long tool result is capped when stored', stored.length < 2400 && /chars cut by the harness/.test(stored), `${stored.length} characters kept of ${big.length}`);
  if (process.env.DEBUG) console.log(ctx, h.agent.preview().tokens, lastReq.messages.map((m) => m.role + ':' + m.content.length + ':' + m.content.slice(0, 80)));
  check('context: near the limit, old results shrink and old requests become a summary; the prompt stays inside the budget', ctx.length > 0 && /summarised/.test(ctx.at(-1).trimmed) && /\[Earlier in this conversation, summarised by the app\]/.test(lastReq.messages[1].content) && /Tools used: write_file/.test(lastReq.messages[1].content) && lastReq.messages.at(-1).content.includes('thanks, what now?') && h.agent.preview().tokens <= ctx.at(-1).budget && lastReq.tools.length < toolsFor('browser').length, `${ctx.at(-1).trimmed}; ${chars} characters sent; ${lastReq.tools.length} core tools with short descriptions`);
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
  const h3 = harness([say('I will load the example now.'), toolCall('get_state', {}), say('done')]); await h3.agent.send('load it');
  check('a promise without a call is nudged once into acting', h3.f.seen.length === 3 && /called no tool/.test(h3.f.seen[1].body.messages.at(-1).content));
}
{
  const f = async (url, init) => { f.seen = { url, init }; return json({ object: 'list', data: [{ id: 'gemma', max_model_len: 131072 }, { id: 'text-embedding-x' }, { id: 'small', context_length: 4096 }] }); };
  const m = await listModels('localhost:1234', { fetch: f, apiKey: 'k' });
  check('models are listed with their context window; embedding models are skipped', m.length === 2 && m[0].context === 131072 && m[1].context === 4096 && f.seen.url === 'http://localhost:1234/v1/models' && f.seen.init.headers.Authorization === 'Bearer k' && f.seen.init.credentials === 'omit');
  check('addresses are normalised', normalizeBase('http://localhost:11434') === 'http://localhost:11434/v1' && normalizeBase(' https://x.test/api/v1/chat/completions ') === 'https://x.test/api/v1' && normalizeBase('') === '');
  check('the presets are local servers only (no hosted or private address is shipped)', PRESETS.length >= 3 && PRESETS.every((p) => /^http:\/\/localhost:\d+\/v1$/.test(p.base)));
}
process.exit(ok ? 0 : 1);
