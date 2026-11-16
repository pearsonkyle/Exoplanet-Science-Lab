// Starts the MCP server and drives it through the SDK's client: lists the tools, runs EXOTIC's three-planet
// example as a session end to end (the session is built as in test/session.test.mjs), reads the result files
// back, and checks that no path leaves the workspace.   node mcp/test.mjs   (about a minute)
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseLightCurve, parseRV, combineEpochs } from '../src/core/data.js';
import { FORMAT } from '../src/core/session.js';
import { toolsFor } from '../src/assistant/toolspec.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const HERE = dirname(fileURLToPath(import.meta.url)), rd = (p) => readFileSync(join(HERE, '../public/examples', p), 'utf8');
const ws = mkdtempSync(join(tmpdir(), 'esl-mcp-'));

// the three-planet session, as test/session.test.mjs builds it
const sys = JSON.parse(rd('toy1873/multi_system.json')), LD = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];
const lc = combineEpochs(['b', 'c', 'd'].map((k) => ({ ...parseLightCurve(rd(`toy1873/tess_${k}.csv`), 'tess_' + k), name: 'tess_' + k })));
const rv = parseRV(rd('toy1873/rv_neid.csv'), 'NEID').sets[0];
const session = {
  format: FORMAT, version: 1, name: 'toy-1873', star: { teff: 5605, rstar: 0.974, mstar: 1.02 },
  limb_darkening: { law: 'nonlinear', mode: 'coeffs', coefficients: LD },
  planets: ['b', 'c', 'd'].map((k) => { const p = sys.planets[k]; return { letter: k, parameters: { rprs: p.rprs, inc: p.inc, per: p.per, tmid: p.tmid, ecc: 0, omega: 0, mplanet: p.mplanet } }; }),
  kepler: true, time_reference: lc.tRef,
  data: { light_curve: { name: 'TESS', time: Array.from(lc.t, (x) => x + lc.tRef), flux: Array.from(lc.f), flux_err: Array.from(lc.e), airmass: null, exposure_min: 0, epoch: Array.from(lc.epoch), epochs: lc.segments.map((s) => ({ name: s.name, airmass: false })) },
    radial_velocity: [{ name: 'NEID', time: Array.from(rv.t), velocity: Array.from(rv.v), velocity_err: Array.from(rv.e) }], timing: [] },
  fit: { use: { lc: true, rv: true, timing: false }, fixed: { rvlin: sys.trend.rv_linear, 'jit@rv1': sys.noise.rv_jitter },
    free: [{ key: 'mplanet', prior: { type: 'uniform', a: 0, b: sys.bounds.b.mplanet[1] } }, { key: 'mplanet@c', prior: { type: 'uniform', a: 0, b: sys.bounds.c.mplanet[1] } }, { key: 'mplanet@d', prior: { type: 'uniform', a: 0, b: sys.bounds.d.mplanet[1] } }],
    sampler: { nlive: 300, seed: 4 } },
  result: null,
};
writeFileSync(join(ws, 'toy1873_session.json'), JSON.stringify(session));
writeFileSync(join(ws, 'times.csv'), rd('ephemeris/wasp12_decay_times.csv'));
writeFileSync(join(tmpdir(), 'esl-mcp-outside.txt'), 'secret');
try { symlinkSync(join(tmpdir(), 'esl-mcp-outside.txt'), join(ws, 'link.txt')); } catch { /* no symlinks here */ }

const client = new Client({ name: 'esl-mcp-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(HERE, 'server.mjs'), '--workspace', ws], stderr: 'ignore' }));
const call = async (name, args = {}, opts) => { const r = await client.callTool({ name, arguments: args }, undefined, opts); const text = r.content[0].text; let data = null; try { data = JSON.parse(text); } catch { /* an error sentence */ } return { text, data, isError: !!r.isError, table: r.content[1] ? r.content[1].text : '' }; };

// tools that need a call only the web page has (figures of the page, the companion search) are not offered here
const listed = (await client.listTools()).tools, want = toolsFor('mcp').filter((t) => !t.needs).map((t) => t.name);
check('the server lists the tools of the shared table', listed.length === want.length && want.every((n) => listed.some((t) => t.name === n)), `${listed.length} tools`);
check('every tool has a description, an object schema and hints', listed.every((t) => t.description.length > 30 && t.inputSchema.type === 'object' && t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
check('the server sends its instructions', /ESL session/.test(client.getInstructions() || ''));

const files = await call('list_files');
check('the workspace is listed with what each file holds', files.data.files.some((f) => f.name === 'toy1873_session.json' && /ESL session/.test(f.about)) && files.data.files.some((f) => f.name === 'times.csv'), files.data.files.map((f) => f.name).join(', '));
const opened = await call('import_session', { file: 'toy1873_session.json' });
check('the three-planet session opens', !opened.isError && opened.data.planets.join() === 'b,c,d' && opened.data.free.join() === 'mplanet,mplanet@c,mplanet@d', opened.text.slice(0, 200));
const st = await call('get_state');
check('its state is described without arrays', st.data.data.length === 2 && st.data.data[0].points === lc.t.length && st.data.kepler_mode === true && st.text.length < 6000, `${st.text.length} characters, light curve ${st.data.data[0].points} points in ${st.data.data[0].epochs} epochs`);

let progress = 0; const t0 = Date.now();
const fit = await call('run_fit', { label: 'masses' }, { onprogress: () => { progress++; }, timeout: 600000, resetTimeoutOnProgress: true });
const truth = { mplanet: sys.planets.b.mplanet, 'mplanet@c': sys.planets.c.mplanet, 'mplanet@d': sys.planets.d.mplanet };
check('run_fit runs the session to convergence', !fit.isError && fit.data.converged === true && Object.keys(fit.data.parameters).length === 3, `${((Date.now() - t0) / 1000).toFixed(0)} s, ln Z ${fit.data && fit.data.evidence ? fit.data.evidence.lnZ : '?'}; ${fit.isError ? fit.text : Object.entries(fit.data.parameters).map(([k, v]) => `${k} = ${v}`).join('; ')}`);
check('progress notifications arrive while it runs', progress >= 1, `${progress} notifications`);

const exp = await call('export_file', { kinds: ['session'], name: 'toy1873_fitted.json' });
check('the fitted session is written into the workspace', !exp.isError && existsSync(join(ws, 'toy1873_fitted.json')), exp.text);
const out = JSON.parse(readFileSync(join(ws, 'toy1873_fitted.json'), 'utf8')), m = Object.fromEntries(out.result.parameters.map((p) => [p.key, p]));
check('the result file holds the injected masses within 3 sigma, derived K per planet and the draws', out.result.converged && Object.keys(truth).every((k) => Math.abs(m[k].median - truth[k]) < 3 * Math.max(m[k].plus, m[k].minus)) && out.result.derived.K && out.result.derived['K@d'] && out.result.samples.values.length >= 200,
  Object.keys(truth).map((k) => `${k} ${m[k].median.toFixed(4)} +${m[k].plus.toFixed(4)} -${m[k].minus.toFixed(4)} (${truth[k]})`).join(', '));
const rep = await call('export_file', { kinds: ['report'] }), back = await call('read_file', { name: rep.data.written[0].file, max_chars: 1500 });
check('a Markdown report is written and read back through the server', !back.isError && /^# /.test(back.data.content) && /toy-1873/.test(back.data.content), `${rep.data.written[0].file}, ${rep.data.written[0].size_bytes} bytes`);
const csvf = await call('export_file', { kinds: ['results_csv'] });
check('a results table is written as CSV', !csvf.isError && /mplanet@c/.test(readFileSync(join(ws, csvf.data.written[0].file), 'utf8')));
const res = await call('get_results', { derived: true }), cmp = await call('compare_runs');
check('results and the comparison come back as summaries', res.data.has_result && Object.keys(res.data.derived).length > 10 && cmp.data.runs.length === 1 && /One run so far/.test(cmp.data.verdict));
const model = await call('compute_model', { file: 'model.csv' });
check('the model curve is computed and written', !model.isError && model.data.planets.c.depth_ppm > 0 && existsSync(join(ws, 'model.csv')), `chi2 ${model.data.chi2} for ${model.data.n_data} points`);

// a new session, the catalogue, timing
const fresh = await call('new_session', { name: 'My target' });
check('a blank session can be started', !fresh.isError && fresh.data.started === 'My target');
const look = await call('lookup_planet', { name: 'WASP-12 b' });
check('a planet is found in the catalogue snapshot', !look.isError && look.data.loaded === 'WASP-12' && Math.abs(look.data.period_d - 1.0914) < 1e-3, look.text.slice(0, 120));
await call('set_timings', { file: 'times.csv' });
const eph = await call('fit_ephemeris'), pg = await call('timing_periodogram');
check('ephemeris and periodogram work on a timing file from the workspace', !eph.isError && eph.data.times > 400 && /-\d/.test(eph.data.quadratic.dPdt_ms_per_year) && /strongly preferred/.test(eph.data.reading) && !pg.isError && typeof pg.data.verdict === 'string', eph.isError ? eph.text : `dP/dt = ${eph.data.quadratic.dPdt_ms_per_year} ms/yr; ${eph.data.reading}`);

// the capabilities shared with the site's assistant: a queue of variants, optional models, derived values, the run history
check('the newer tools of the shared table are offered, those that need the web page are not', ['set_phase_curve', 'set_moon', 'set_nbody', 'get_derived', 'list_runs', 'run_experiment'].every((n) => listed.some((t) => t.name === n)) && !['companion_search', 'add_companion', 'restore_run', 'fit_progress', 'get_figure', 'set_view'].some((n) => listed.some((t) => t.name === n)));
await call('load_example', { id: 'single', fresh: true }); await call('set_sampler', { nlive: 60 });
const queue = await call('run_experiment', { kind: 'custom', report: 'ld_queue.md', variants: [{ name: 'linear law', setup: [{ tool: 'set_limb_darkening', args: { law: 'linear' } }] }, { name: 'quadratic law' }] }, { timeout: 600000 });
check('run_experiment runs a queue of variants with set-up steps and returns the comparison as data and as a table', !queue.isError && queue.data.variants.length === 2 && queue.data.variants.every((v) => v.run) && queue.data.comparison.runs.every((r) => /±/.test(r.lnZ)) && /\| Run \| Free parameters \| ln Z \|/.test(queue.table) && queue.table.includes(queue.data.comparison.verdict) && existsSync(join(ws, 'ld_queue.md')), queue.isError ? queue.text : queue.data.comparison.verdict);
await call('add_planet', { parameters: { per: 9 } });
const withc = await call('run_experiment', { kind: 'companion', report: 'companion.md' }, { timeout: 600000 }), after = await call('get_state');
check('"with and without the companion": both fits run, and the system ends with the companion in place', !withc.isError && withc.data.variants.map((v) => v.name).join() === 'without planet c,with planet c' && withc.data.comparison.runs.length === 2 && after.data.planets.join() === 'b,c', withc.isError ? withc.text : withc.data.comparison.runs.map((r) => `${r.run}: ${r.lnZ}`).join('; '));
const hist = await call('list_runs'), der = await call('get_derived', { planet: 'b' });
check('the run history and the derived quantities come back as the software computed them', !hist.isError && hist.data.runs.length === 5 && hist.data.runs.filter((r) => r.on_current_data).length === 4 && hist.data.runs.every((r) => /±|not converged/.test(r.lnZ)) && !der.isError && Object.keys(der.data.derived || der.data.planets).length > 0, `${hist.data.runs.length} runs`);
const moon = await call('set_moon', { parameters: { rmoon: 0.02, permoon: 0.4 } }), st2 = await call('get_state'), moonOff = await call('set_moon', { on: false }), ph = await call('set_phase_curve', { mode: 'harmonic', parameters: { fpfs: 0.001 } }), st3 = await call('get_state'), nb = await call('set_nbody', { on: true });
check('a moon and the planet\'s own light are switched on the session document; N-body dynamics ask for Kepler mode first', !moon.isError && st2.data.parameters.some((p) => p.key === 'rmoon' && p.value === 0.02) && !moonOff.isError && !ph.isError && st3.data.parameters.some((p) => p.key === 'fpfs') && !st3.data.parameters.some((p) => p.key === 'rmoon') && nb.isError && /Kepler mode/.test(nb.text), nb.text.slice(0, 90));

// nothing outside the workspace
const esc = [await call('read_file', { name: '../esl-mcp-outside.txt' }), await call('read_file', { name: '/etc/hosts' }), await call('import_session', { file: '../../etc/passwd' }), await call('write_file', { name: '../evil.txt', content: 'x' }), await call('export_file', { kinds: ['session'], name: '../../evil.json' })];
check('paths outside the workspace are refused (relative, absolute, on read and on write)', esc.every((r) => r.isError) && !existsSync(join(ws, '../evil.txt')), esc.map((r) => r.text.slice(7, 60)).join(' | '));
if (existsSync(join(ws, 'link.txt'))) { const l = await call('read_file', { name: 'link.txt' }); check('a symbolic link that leaves the workspace is refused', l.isError && /outside/.test(l.text), l.text); }
const over = await call('write_file', { name: 'times.csv', content: 'x' });
check('a file the server did not write is not overwritten', over.isError && readFileSync(join(ws, 'times.csv'), 'utf8').length > 100, over.text);
const bad = await call('set_free', { free: ['ars'] }), unknown = await call('no_such_tool', {});
check('a refused call comes back as an error result the client can read', bad.isError && /never fitted/.test(bad.text) && unknown.isError && /no tool/.test(unknown.text));
await client.close();

// streamable HTTP
const port = 18000 + Math.floor(Math.random() * 2000), http = spawn(process.execPath, [join(HERE, 'server.mjs'), '--workspace', ws, '--http', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((r) => { http.stderr.on('data', (d) => { if (/ready/.test(String(d))) r(); }); setTimeout(r, 4000); });
try {
  const c2 = new Client({ name: 'esl-mcp-test-http', version: '0' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const n = (await c2.listTools()).tools.length, r = await c2.callTool({ name: 'list_examples', arguments: {} });
  check('the same tools are served over streamable HTTP on 127.0.0.1', n === want.length && /single/.test(r.content[0].text), `${n} tools on port ${port}`);
  const { request } = await import('node:http');
  const wrongHost = await new Promise((r) => { const q = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', 'content-type': 'application/json' } }, (x) => { x.resume(); r(x.statusCode); }); q.on('error', () => r(0)); q.end('{}'); });
  check('a request with a foreign Host header is refused', wrongHost === 403, `HTTP ${wrongHost}`);
  await c2.close();
} catch (err) { check('streamable HTTP', false, err.message); }
http.kill();
rmSync(ws, { recursive: true, force: true }); rmSync(join(tmpdir(), 'esl-mcp-outside.txt'), { force: true });
process.exit(ok ? 0 : 1);
