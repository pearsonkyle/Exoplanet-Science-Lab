// The bundle the Python package executes (python/esl/_core/esl_core.js, built by tools/build_core_bundle.mjs):
// it builds from the current sources, exposes the API python/bundle.manifest.json promises to Python, and, loaded
// the way an embedded engine loads it (a bare context: no Node, no DOM, no timers), gives the numbers of src/core.
// A core change that would break Python fails here. If the bundle on disk is behind the sources it is rewritten
// (so the Python package always runs the code of this checkout) and the test says so.
import { readFileSync } from 'node:fs';
import { buildCoreBundle, staleFiles, loadBundle } from '../tools/build_core_bundle.mjs';
import { buildProblem } from '../src/core/model.js';
import { specFromSession, runSession } from '../src/core/session.js';
import { transitModel } from '../src/core/transit.js';
import { makeRV } from '../src/core/rv.js';
import { interpLDGrid, gridFromTable, makeLDTie } from '../src/core/ldest.js';
import { LD_TABLE } from '../src/data/ld_table.js';
import { toySession } from '../python/tests/js/toy_session.mjs';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const t0 = performance.now();
const probe = await buildCoreBundle({ write: false }), stale = staleFiles(probe);
const built = stale.length ? await buildCoreBundle({ write: true }) : probe;
if (stale.length) console.log('note  the Python bundle was behind the sources and has been rebuilt: ' + stale.join(', '));
const M = built.manifest, R = built.required;
check('the bundle builds from src/core', M.files['esl_core.js'].bytes > 3e5, `${(M.files['esl_core.js'].bytes / 1024).toFixed(0)} kB, ${Object.keys(M.modules).length} modules, ${Object.values(M.modules).reduce((a, x) => a + x.length, 0)} exports, sources ${M.sourceHash}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
check('the build is deterministic', (await buildCoreBundle({ write: false })).files['esl_core.js'] === built.files['esl_core.js']);
const missing = [...R.api.filter((n) => !M.api.includes(n)).map((n) => 'api.' + n), ...R.jobs.filter((n) => !M.jobs.includes(n)).map((n) => 'jobs.' + n),
  ...Object.entries(R.modules).flatMap(([m, names]) => names.filter((n) => !(M.modules[m] || []).includes(n)).map((n) => `${m}.${n}`))];
check('it exposes everything the Python package calls', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : `${R.api.length} API functions, ${R.jobs.length} jobs, ${Object.values(R.modules).reduce((a, x) => a + x.length, 0)} core exports`);

// ---- loaded as an embedded engine would: a context with nothing but the language
const { ESL } = loadBundle(built.files['esl_core.js'], [built.files['esl_ld_spectral.js']]);
ESL.manualTimers();
const call = (name, ...args) => { const r = JSON.parse(ESL.call(name, JSON.stringify(args))); if ('error' in r) throw new Error(r.error); return r.ok; };
const job = async (name, args, fetch) => {
  const id = ESL.start(name, JSON.stringify(args)); let polls = 0, progress = 0;
  for (;;) {
    const m = JSON.parse(ESL.poll(id)); polls++; progress += m.progress.length;
    for (const q of m.requests) { try { ESL.resolve(q.id, fetch(q.name)); } catch (e) { ESL.reject(q.id, e.message); } }
    if (m.done) { if (m.error) throw new Error(m.error); return { result: m.result, polls, progress }; }
    if (polls > 1e6) throw new Error('job never finished');
    await new Promise((r) => setImmediate(r));   // an embedded engine drains its microtasks when each call returns; inside Node we have to yield
  }
};
const info = call('info');
check('every file of src/core is a module of the bundle', Object.keys(info.modules).length >= 25 && ['session', 'model', 'nested', 'transit', 'rv', 'kepler', 'catalog', 'photometry', 'sources'].every((m) => info.modules[m]), Object.keys(info.modules).join(' '));

// transit and radial velocity: the same doubles as the modules
const p = { rprs: 0.1, ars: 94.45, inc: 89.269, per: 111.4367, tmid: 2458888.0757, ecc: 0.93132, omega: -58.699, ldLaw: 'nonlinear', ld: [0.4939, -0.0729, 0.4578, -0.2158] };
const tt = Array.from({ length: 400 }, (_, i) => 2458887.6 + i * 0.0025), direct = transitModel(tt, p), viaBundle = call('transit', tt, p);
check('transit model through the bundle equals the module, bit for bit', viaBundle.every((x, i) => x === direct[i]) && Math.min(...viaBundle) < 0.995);
const rvf = makeRV({ ...p, K: 469.2 }), rvB = call('radialVelocity', tt, { ...p, K: 469.2 });
check('radial velocity through the bundle equals the module, bit for bit', rvB.every((x, i) => x === rvf(tt[i])));
check('any core export is reachable by name (kepler.eventTimes, relations.semiMajorAxis)', Math.abs(call('invoke', 'kepler.eventTimes', [p]).t14 - 0.5) < 0.05 && call('invoke', 'relations.semiMajorAxis', [1, 365.25]) > 0.99);

// the session of test/session.test.mjs: likelihood, then a complete fit through the job interface
const { session } = toySession(), spec = specFromSession(session), det = buildProblem({ ...spec, free: [] }).detail([]), ev = call('evaluate', session);
check('session chi-square through the bundle equals buildProblem', ev.chi2 === det.chi2 && ev.chi2_parts.radial_velocity === det.chi2rv && ev.n_data === 408, `chi2 ${ev.chi2.toFixed(4)} (light curve ${ev.chi2_parts.light_curve.toFixed(2)}, velocities ${ev.chi2_parts.radial_velocity.toFixed(2)})`);
const extra = JSON.parse(JSON.stringify(session)); extra.planets[1].parameters.zz_future = 1e-4; extra.planets[1].zz_block = { mass: 0.01 }; extra.zz_top = { a: 1 };
check('planet-parameter keys the core does not know pass through untouched', call('evaluate', extra).chi2 === det.chi2);
const ref = await runSession(session, { keepSamples: true }), viaJob = await job('run', [session, { keepSamples: true }]);
const a = ref.session.result, b = viaJob.result.result;
check('a fit run through the job interface (no event loop: timers pumped by the host) equals runSession', b.ncalls === a.ncalls && b.logZ === a.logZ && b.parameters.every((q, i) => q.median === a.parameters[i].median && q.plus === a.parameters[i].plus) && b.samples.values.length === a.samples.values.length,
  `${b.ncalls} calls, ln Z ${b.logZ.toFixed(3)}, ${viaJob.polls} polls, ${viaJob.progress} progress reports`);
check('progress is streamed while the sampler runs', viaJob.progress >= 1 && viaJob.polls >= 2);
check('the result carries the software stamp', viaJob.result.software.version === M.version);

// limb darkening that follows the star: what specFromSession leaves to the application
const star = JSON.parse(JSON.stringify(session));
star.star = { ...star.star, teff: 5605, logg: 4.47, feh: 0.1 }; star.limb_darkening = { law: 'quadratic', mode: 'star', band: 'TESS (approx.)', coefficients: [9, 9] };
const want = interpLDGrid(gridFromTable(LD_TABLE, 'quadratic'), 5605, 4.47, 0.1, 'TESS (approx.)').coeffs, evS = call('evaluate', star);
check('"star" mode: the coefficients are those of the table for the star', evS.limb_darkening.every((c, i) => Math.abs(c - want[i]) < 1e-12) && Math.abs(evS.limb_darkening[0] - 9) > 1, evS.limb_darkening.map((c) => c.toFixed(4)).join(', '));
star.fit.free = [...star.fit.free, { key: 'teff', prior: { type: 'normal', a: 5605, b: 100 } }]; star.fit.sampler = { nlive: 100, seed: 2 };
const tieSpec = { law: 'quadratic', source: 'grid', band: [600, 1000], grid: gridFromTable(LD_TABLE, 'quadratic'), filter: 'TESS (approx.)', logg: 4.47, teffRange: [5005, 6205], fehRange: [0.1 - 1e-3, 0.1 + 1e-3] };
const s2 = specFromSession({ ...star, limb_darkening: { ...star.limb_darkening, coefficients: want } }); s2.ldTie = tieSpec;
const at = { teff: 5300 }, vals = { ...s2.values, teff: 5300 }, hand = buildProblem({ ...s2, values: vals, free: [] }).detail([]), viaTie = call('evaluate', star, at);
const o = [0, 0, 0, 0]; makeLDTie(tieSpec)(5300, 0.1, o);
check('"star" mode with T eff free: the likelihood is that of the tie main.js builds (tieSpec)', viaTie.chi2 === hand.chi2 && Math.abs(viaTie.limb_darkening[0] - o[0]) < 1e-12 && viaTie.chi2 !== evS.chi2, `chi2 ${viaTie.chi2.toFixed(4)} at 5300 K, ${evS.chi2.toFixed(4)} at 5605 K`);
const runS = (await job('run', [star, {}])).result.result;
check('"star" mode: a fit with T eff free runs and reports the tied coefficients', runS.parameters.some((q) => q.key === 'teff') && Number.isFinite(runS.best.ld0) && runS.best.ld0 !== 9, `T eff ${runS.parameters.find((q) => q.key === 'teff').median.toFixed(0)} K, ${runS.ncalls} calls`);
const custom = { ...star, limb_darkening: { ...star.limb_darkening, band: 'Custom range', band_custom: [600, 1000] } };
check('a custom band is served by the wavelength-resolved table once it is loaded', call('limbDarkening', { teff: 5605, logg: 4.47, feh: 0.1 }, [600, 1000], 'quadratic').source === 'spectral' && call('needsSpectral', custom) === false && Number.isFinite(call('evaluate', custom).chi2));

// the catalogue through the host's file access
const cat = (name) => readFileSync(new URL('../public/catalog/' + name, import.meta.url), 'utf8');
const L = (await job('lookup', ['HD 80606 b', { use: 'all' }], cat)).result;
check('catalogue look-up through the job interface (files supplied by the host)', L && L.host === 'HD 80606' && L.session.planets[0].letter === 'b' && Math.abs(L.session.planets[0].parameters.per - 111.4367) < 0.01, L ? `${L.host}, reference ${L.session.planets[0].reference}, P ${L.session.planets[0].parameters.per}` : 'not found');
check('errors come back as messages', JSON.parse(ESL.call('evaluate', JSON.stringify([{ format: 'x' }]))).error.includes('not an ESL session') && JSON.parse(ESL.call('nope', '[]')).error.includes('no such function'));
process.exit(ok ? 0 : 1);
