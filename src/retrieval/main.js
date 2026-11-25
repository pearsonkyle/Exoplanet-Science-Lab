// Retrieval page: a model atmosphere fitted to measured spectra with the site's nested sampler, in a worker that can
// be stopped (src/retrieval/client.js). The science is in src/core (retrieval.js, rtmodel.js, atmoapi.js: tested in
// test/retrieval.test.mjs); this file is the UI: what is fitted and within which limits, the spectra, the run, and
// the result as a table, a corner plot and the spectrum with the posterior's band.
import { now } from '../site/clock.js';
import { DEFAULT_MODEL } from '../core/rtmodel.js';
import { ATM_PARAMS, defaultPrior, compareRetrievals } from '../core/retrieval.js';
import { parseSpectrumText } from '../core/atmoapi.js';
import { drawCorner } from '../ui/corner.js';
import { fitCanvas } from '../photometry/plots.js';
import { saveFile, canvasToPNG } from '../ui/export.js';
import { SPEC_THEME, PRINT_THEME } from '../spectra/plots.js';
import { renderFit } from './plots.js';
import { createRetrievalClient } from './client.js';

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'style') el.style.cssText = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const $ = (id) => document.getElementById(id);
const setStatus = (id, text, cls = '') => { const el = $(id); if (el) { el.textContent = text; el.className = 'status' + (cls ? ' ' + cls : ''); } };

// ------------------------------------------------------------------------------------------------- what can be fitted
export const GASES = ['H2O', 'CO2', 'CO', 'CH4', 'NH3', 'HCN', 'SO2', 'H2S', 'Na', 'K', 'TiO', 'VO'];
const SHORT = { teq: 'Teq (K)', tint: 'Tint (K)', t: 'T (K)', logKappaIR: 'log κIR', logGamma: 'log γ', mh: '[M/H]', co: 'C/O', rplanet: 'Rp (RJ)', logCloudTop: 'log Pcloud', cloudFraction: 'cloud cover', logHaze: 'log haze', hazeSlope: 'haze slope', nightDT: 'ΔT night (K)' };
export const shortLabel = (k) => SHORT[k] || (k.startsWith('logX_') ? 'log ' + k.slice(5) : k);
const longLabel = (k) => (ATM_PARAMS[k] ? ATM_PARAMS[k].label : `log10 ${k.slice(5)}`);
/** The rows of the parameter table: key, group, the states a row can be in, and when it applies. */
const ROWS = [
  { key: 'teq', group: 'Temperature', states: ['fixed', 'free'], when: (R) => R.tpKind === 'guillot' },
  { key: 'logKappaIR', group: 'Temperature', states: ['fixed', 'free'], when: (R) => R.tpKind === 'guillot' },
  { key: 'logGamma', group: 'Temperature', states: ['fixed', 'free'], when: (R) => R.tpKind === 'guillot' },
  { key: 'tint', group: 'Temperature', states: ['fixed', 'free'], when: (R) => R.tpKind === 'guillot' },
  { key: 't', group: 'Temperature', states: ['fixed', 'free'], when: (R) => R.tpKind === 'isothermal' },
  { key: 'mh', group: 'Composition', states: ['fixed', 'free'], when: (R) => R.chem === 'eq' },
  { key: 'co', group: 'Composition', states: ['fixed', 'free'], when: (R) => R.chem === 'eq' },
  ...GASES.map((g) => ({ key: 'logX_' + g, group: 'Composition', states: ['off', 'fixed', 'free'], when: (R) => R.chem === 'free' })),
  { key: 'rplanet', group: 'Planet', states: ['fixed', 'free'], when: () => true },
  { key: 'logCloudTop', group: 'Clouds and haze', states: ['off', 'fixed', 'free'], when: () => true },
  { key: 'cloudFraction', group: 'Clouds and haze', states: ['off', 'fixed', 'free'], when: () => true },
  { key: 'logHaze', group: 'Clouds and haze', states: ['off', 'fixed', 'free'], when: () => true },
  { key: 'hazeSlope', group: 'Clouds and haze', states: ['off', 'fixed', 'free'], when: () => true },
  { key: 'nightDT', group: 'Day and night', states: ['off', 'fixed', 'free'], when: () => true },
];
const START = { teq: 1100, logKappaIR: -3, logGamma: -0.4, tint: 100, t: 1100, mh: 0, co: 0.55, rplanet: 1.27, logCloudTop: -2, cloudFraction: 1, logHaze: 2, hazeSlope: -4, nightDT: 300 };

/** Starting points. `rows`: key -> [state, value]; what is not named is fixed (or off) at its usual value. */
export const PRESETS = {
  'Hot Jupiter, water and CO2 (quick)': { about: 'An isothermal atmosphere with two gases: four free parameters, fitted in a minute or two. A good first run.',
    planet: { mplanet: 0.69, pRef: 0.01 }, star: { rstar: 1.19, teff: 6091 }, tpKind: 'isothermal', chem: 'free',
    rows: { t: ['free', 1300], logX_H2O: ['free', -3.3], logX_CO2: ['free', -6], rplanet: ['free', 1.38] }, sim: { kind: 'transit', wlMin: 1, wlMax: 5, R: 30, noise: 60 } },
  'WASP-39 b, chemical equilibrium': { about: 'A hot Saturn in chemical equilibrium: temperature, [M/H], C/O and radius. Several minutes.',
    planet: { mplanet: 0.281, pRef: 0.01 }, star: { rstar: 0.939, teff: 5485 }, tpKind: 'guillot', chem: 'eq', opacity: ['H2O', 'CO2', 'CO', 'CH4', 'Na', 'K'],
    rows: { teq: ['free', 1100], logKappaIR: ['fixed', -3], logGamma: ['fixed', -0.4], mh: ['free', 1], co: ['free', 0.55], rplanet: ['free', 1.279] }, sim: { kind: 'transit', wlMin: 0.6, wlMax: 5.2, R: 30, noise: 50 } },
  'Hazy hot Jupiter': { about: 'The same kind of planet under a haze and a cloud deck: fit it with and without them and compare ln Z.',
    planet: { mplanet: 0.69, pRef: 0.01 }, star: { rstar: 1.19, teff: 6091 }, tpKind: 'isothermal', chem: 'free',
    rows: { t: ['free', 1300], logX_H2O: ['free', -3.3], rplanet: ['free', 1.38], logHaze: ['free', 3], logCloudTop: ['free', -1.5] }, sim: { kind: 'transit', wlMin: 0.5, wlMax: 5, R: 30, noise: 60 } },
};

const R = { preset: Object.keys(PRESETS)[0], name: '', planet: {}, star: {}, tpKind: 'isothermal', chem: 'free', opacity: [], rows: {}, data: [], truth: null, sim: {}, sampler: { nlive: 100, maxCalls: 60000, maxSeconds: 900 }, result: null, runs: [], busy: false, error: null };
const applies = (key) => { const d = ROWS.find((r) => r.key === key); return !!d && d.when(R); };
const freeKeys = () => ROWS.filter((d) => d.when(R) && R.rows[d.key].state === 'free').map((d) => d.key);
const gasesOn = () => (R.chem === 'eq' ? R.opacity.slice() : GASES.filter((g) => R.rows['logX_' + g].state !== 'off'));

/** The model as the rows describe it (free parameters at their starting values). */
function baseModel() {
  const v = (k) => R.rows[k].value, m = { ...DEFAULT_MODEL, planet: { mplanet: R.planet.mplanet, rplanet: v('rplanet'), pRef: R.planet.pRef }, star: { ...R.star }, vmr: {}, chemistry: null, night: null,
    tp: R.tpKind === 'guillot' ? { kind: 'guillot', teq: v('teq'), tint: v('tint'), kappaIR: 10 ** v('logKappaIR'), gamma: 10 ** v('logGamma') } : { kind: 'isothermal', t: v('t') } };
  if (R.chem === 'eq') m.chemistry = { mh: v('mh'), co: v('co') };
  for (const d of ROWS) { if (!d.when(R) || R.rows[d.key].state === 'off' || ['teq', 'tint', 't', 'logKappaIR', 'logGamma', 'mh', 'co', 'rplanet'].includes(d.key)) continue; if (d.key.startsWith('logX_')) m.vmr[d.key.slice(5)] = 10 ** v(d.key); else ATM_PARAMS[d.key].apply(m, v(d.key)); }
  return m;
}
function loadPreset(name) {
  const p = PRESETS[name]; R.preset = name; R.name = name; R.planet = { ...p.planet }; R.star = { ...p.star }; R.tpKind = p.tpKind; R.chem = p.chem; R.opacity = (p.opacity || ['H2O', 'CO2', 'CO', 'CH4', 'Na', 'K']).slice(); R.sim = { seed: 1, ...p.sim };
  R.rows = {};
  for (const d of ROWS) { const given = p.rows[d.key], value = given ? given[1] : d.key.startsWith('logX_') ? -5 : START[d.key]; R.rows[d.key] = { state: given ? given[0] : d.states[0], value, a: null, b: null }; }
  resetPriors(); R.data = []; R.truth = null; R.result = null; R.error = null;
}
/** Priors back to the wide defaults (the radius: ±20% of its value). */
function resetPriors(keys = ROWS.map((d) => d.key)) { const m = { planet: { rplanet: R.rows.rplanet.value } }; for (const k of keys) { const pr = defaultPrior(k, m); R.rows[k].a = pr.a; R.rows[k].b = pr.b; } }
loadPreset(R.preset);

const client = createRetrievalClient({ onStatus: (t) => setStatus('stRun', t) });
const dataKey = () => R.data.map((d) => `${d.name}:${d.kind}:${d.wl.length}:${d.y[0]}`).join('|');
const strip = (d) => ({ name: d.name, kind: d.kind, wl: d.wl, y: d.y, err: d.err, ...(d.lo && d.hi ? { lo: d.lo, hi: d.hi } : {}) });

// ------------------------------------------------------------------------------------------------- data
async function simulate(spec = {}) {
  if (client.busy()) throw new Error('a fit is running: stop it first');
  const s = { ...R.sim, ...spec }, n = Number(s.noise);
  if (!(n > 0)) throw new Error('the noise must be positive (ppm)');
  R.sim = s; setStatus('stData', 'Computing the spectrum …');
  const set = await client.simulate(baseModel(), { kind: s.kind, wlMin: Number(s.wlMin), wlMax: Number(s.wlMax), R: Number(s.R), noise: n * 1e-6, seed: Number(s.seed) || 1 }, gasesOn());
  const truth = Object.fromEntries(ROWS.filter((d) => d.when(R) && R.rows[d.key].state !== 'off').map((d) => [d.key, R.rows[d.key].value]));
  // one simulated set of a kind: a new one replaces it; the values it was made from are what a fit should return
  R.data = [...R.data.filter((d) => !(d.simulated && d.kind === set.kind)), { ...set, name: `simulated ${set.kind}`, simulated: true }];
  R.truth = R.data.every((d) => d.simulated) ? truth : null; R.result = null;
  buildData(); showResult(); if (!R.busy && /^Loading/.test($('stRun').textContent)) setStatus('stRun', 'Choose what is free, then press Fit.');
  setStatus('stData', `Simulated: ${set.wl.length} points from ${Number(s.wlMin)} to ${Number(s.wlMax)} µm at R = ${Number(s.R)}, ${n} ppm of noise (seed ${Number(s.seed) || 1}), from the values in the table. The model's own spectrum: no instrument is simulated.`, 'ok');
  return set;
}
function addSpectrum(text, { name, kind, unit }) {
  const set = parseSpectrumText(text, { name, kind, unit });
  R.data = [...R.data.filter((d) => d.name !== set.name), set]; R.truth = null; R.result = null;
  buildData(); showResult();
  setStatus('stData', `${name}: ${set.wl.length} points, ${set.wl[0].toPrecision(3)} to ${set.wl[set.wl.length - 1].toPrecision(3)} µm, median error ${(1e6 * set.err.slice().sort((a, b) => a - b)[Math.floor(set.err.length / 2)]).toFixed(0)} ppm${set.lo ? '' : '; no bin edges in the file, so the bins are taken to meet halfway between the wavelengths'}.`, 'ok');
  return set;
}
async function loadFiles(list) {
  for (const f of list) { try { addSpectrum(await f.text(), { name: f.name, kind: $('fileKind').value, unit: $('fileUnit').value }); } catch (err) { setStatus('stData', String((err && err.message) || err), 'err'); } }
}

// ------------------------------------------------------------------------------------------------- the fit
function checkSetup() {
  const free = freeKeys();
  if (!R.data.length) throw new Error('there is no spectrum yet: load a file or simulate one');
  if (!free.length) throw new Error('nothing is free: set at least one parameter to "free"');
  for (const k of free) { const r = R.rows[k]; if (!(Number(r.b) > Number(r.a))) throw new Error(`the limits of ${shortLabel(k)} must be low < high`); }
  if (R.chem === 'eq' && !R.opacity.length) throw new Error('choose at least one gas whose opacity counts');
  if (free.includes('nightDT') && R.data.every((d) => d.kind === 'transit')) throw new Error('the night-side contrast needs an eclipse or a night-side spectrum');
  return free;
}
async function fit() {
  if (R.busy) throw new Error('a fit is already running on this page');
  let free; try { free = checkSetup(); } catch (err) { R.error = err.message; setStatus('stRun', err.message, 'err'); throw err; }
  R.busy = true; R.error = null; buttons();
  const priors = Object.fromEntries(free.map((k) => [k, [Number(R.rows[k].a), Number(R.rows[k].b)]])), sm = R.sampler, t0 = now();
  const spec = { model: baseModel(), data: R.data.map(strip), free, priors, species: gasesOn(), sampler: { nlive: Math.max(25, Math.round(Number(sm.nlive) || 100)), maxCalls: Math.max(200, Math.round(Number(sm.maxCalls) || 60000)), maxSeconds: Math.max(5, Number(sm.maxSeconds) || 900), seed: 42 } };
  const sent = { free, priors, fixed: Object.fromEntries(ROWS.filter((d) => d.when(R) && R.rows[d.key].state === 'fixed').map((d) => [d.key, R.rows[d.key].value])), tpKind: R.tpKind, chem: R.chem, gases: spec.species, planet: { ...R.planet }, star: { ...R.star }, data: R.data, dataKey: dataKey(), truth: R.truth, sampler: spec.sampler };
  setStatus('stRun', 'Starting the fit …');
  try {
    const out = await client.run(spec, (q) => { R.progress = q; setStatus('stRun', `Fitting: ${q.ncalls} models in ${q.elapsed.toFixed(0)} s, ln Z ${q.logZ.toFixed(1)}, ${(100 * Math.min(1, Math.max(0, q.remFrac))).toFixed(0)}% of the evidence still to come …`); });
    R.result = { ...out.result, post: out.post, band: out.band, curve: out.curve, sent, started: t0 };
    R.runs = [...R.runs, { n: R.runs.length + 1, dataKey: sent.dataKey, what: describe(sent), free: free.slice(), logZ: out.result.logZ, logZerr: out.result.logZerr, chi2: out.result.chi2, ndata: out.result.ndata, converged: out.result.converged, ncalls: out.result.ncalls, seconds: out.result.seconds }];
    setStatus('stRun', out.result.converged ? 'The fit has finished: the result is below.' : 'The fit stopped at a limit before converging: see below.', out.result.converged ? 'ok' : 'err');
    return R.result;
  } catch (err) {
    R.error = err.stopped ? null : String((err && err.message) || err);
    setStatus('stRun', err.stopped ? 'Stopped. Nothing was kept from that run.' : R.error, err.stopped ? 'warn' : 'err'); throw err;
  } finally { R.busy = false; R.progress = null; buttons(); showResult(); }
}
const describe = (s) => `${s.tpKind === 'guillot' ? 'Guillot profile' : 'isothermal'}; ${s.chem === 'eq' ? 'chemical equilibrium' : 'gases ' + (s.gases.join(', ') || 'none')}; free: ${s.free.map(shortLabel).join(', ')}`;
function stop() { return client.stop(); }
function buttons() { if ($('bFit')) { $('bFit').disabled = R.busy; $('bStop').disabled = !R.busy; $('bSim').disabled = R.busy; } }

// ------------------------------------------------------------------------------------------------- layout
const card = (...kids) => h('div', { class: 'card' }, ...kids);
const num = (label, get, set, attrs = {}) => h('label', {}, label, h('input', { type: 'number', step: 'any', value: get(), ...attrs, onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set(v); changed(); } }));
/** Anything that changes the model or the data makes the shown result an older one's: it stays, labelled by its own run. */
function changed() { draw(); }

$('app').append(h('div', { class: 'cols' },
  h('div', { class: 'side' },
    card(h('h2', {}, 'Planet and model'),
      h('label', {}, 'Start from', h('select', { id: 'preset', onchange: (e) => { if (R.busy) { e.target.value = R.preset; return; } loadPreset(e.target.value); buildAll(); simulate().catch((err) => setStatus('stData', err.message, 'err')); } }, Object.keys(PRESETS).map((k) => h('option', { value: k }, k)))),
      h('div', { class: 'status', id: 'stPreset' }),
      h('div', { class: 'grid2', id: 'planetRows', style: 'margin-top:8px' })),
    card(h('h2', {}, 'Spectra'),
      h('div', { id: 'dataRows' }),
      h('div', { class: 'grid2', style: 'margin-top:8px' },
        h('label', {}, 'A file holds', h('select', { id: 'fileKind' }, h('option', { value: 'transit' }, 'transit depths'), h('option', { value: 'eclipse' }, 'eclipse depths'), h('option', { value: 'night' }, 'night side, planet / star'))),
        h('label', {}, 'in', h('select', { id: 'fileUnit' }, h('option', { value: 'fraction' }, 'fractions'), h('option', { value: 'percent' }, 'percent'), h('option', { value: 'ppm' }, 'ppm')))),
      h('div', { class: 'row', style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' }, h('button', { class: 'btn', onclick: () => $('file').click() }, 'Load a spectrum …'), h('input', { type: 'file', id: 'file', multiple: true, accept: '.csv,.txt,.dat,.tsv', style: 'display:none', 'aria-label': 'Spectrum files', onchange: (e) => { loadFiles([...e.target.files]); e.target.value = ''; } })),
      h('p', { class: 'note' }, 'Text files with rows of "wavelength, value, error" or "wavelength, bin low, bin high, value, error", wavelengths in micron. Several files are fitted together (a transit and an eclipse, say). Nothing is uploaded.'),
      h('h2', { style: 'margin-top:12px' }, 'Or simulate one from the model'),
      h('div', { class: 'grid2', id: 'simRows' }),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', id: 'bSim', onclick: () => simulate().catch((err) => setStatus('stData', err.message, 'err')) }, 'Simulate')),
      h('div', { class: 'status', id: 'stData' })),
    card(h('h2', {}, 'The run'),
      h('div', { class: 'grid2', id: 'samplerRows' }),
      h('p', { class: 'note' }, 'The fit stops by itself when 1% of the evidence is left. If a limit is reached first the result is marked as not converged: its numbers are then not a posterior.'))),
  h('div', { class: 'main' },
    h('h2', {}, 'What is fitted'),
    h('div', { class: 'card pad6', style: 'overflow:auto' }, h('div', { id: 'paramTable' })),
    h('p', { class: 'note' }, 'Gases are given as log10 of their mixing ratio. A free parameter is searched between its limits with equal probability everywhere (a uniform prior); a fixed one keeps its value; "off" leaves it out of the model. The value of a free parameter is only used to simulate a spectrum. a/R★ is not a parameter here: the spectra are depths, already reduced from light curves.'),
    h('div', { class: 'bar' }, h('button', { class: 'btn', id: 'bFit', onclick: () => fit().catch(() => {}) }, 'Fit'), h('button', { class: 'btn', id: 'bStop', disabled: true, onclick: () => stop() }, 'Stop'), h('button', { class: 'btn sm', onclick: () => { resetPriors(); buildParams(); } }, 'Limits back to the defaults')),
    h('div', { class: 'status', id: 'stRun' }, 'Load a spectrum or simulate one, choose what is free, then press Fit.'),
    h('h2', {}, 'Spectrum'),
    h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => saveSpectrumPng() }, 'Save figure'), h('button', { class: 'btn sm', onclick: () => saveCsv() }, 'Save CSV'), h('button', { class: 'btn sm', onclick: () => saveJson() }, 'Save result (JSON)')),
    h('div', { class: 'card pad6' }, h('canvas', { id: 'cvFit', role: 'img', 'aria-label': 'The spectra with the best-fitting model and the range the posterior allows' })),
    h('h2', {}, 'Result'),
    h('div', { id: 'resNote' }),
    h('div', { id: 'resTable' }),
    h('div', { id: 'warnings' }),
    h('h2', {}, 'Posterior'),
    h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => saveCorner() }, 'Save corner plot'), h('button', { class: 'btn sm', onclick: () => saveSamples() }, 'Save samples (CSV)')),
    h('div', { class: 'card pad6', style: 'overflow:auto' }, h('canvas', { id: 'cvCorner', role: 'img', 'aria-label': 'Corner plot of the posterior' })),
    h('p', { class: 'note', id: 'cornerNote' }, 'Every pair of fitted parameters as the nested sampler found them: contours hold 39%, 86% and 99% of the probability (1, 2 and 3 σ in two dimensions); the diagonal is each parameter alone. A tilted pair is a trade-off: an abundance against the radius, or the temperature against a cloud.'),
    h('h2', {}, 'Fits compared'),
    h('div', { id: 'runsTable' }),
    h('p', { class: 'note' }, 'Fit the same spectra twice, with and without a gas or a cloud, and the difference of ln Z says whether the data ask for it: above 5 strongly, above 2.5 yes, within 1 the data cannot tell.'),
    h('details', { class: 'card how' }, h('summary', {}, 'How this is computed, and what it leaves out'),
      h('p', {}, 'For each trial set of values the forward model of the Atmosphere page computes the spectrum, averages it over each data bin (the model\'s own bins weighted by how much of each lies inside), and compares it with the data assuming independent Gaussian errors. The nested sampler of the light-curve fits explores the space between the limits and returns the posterior and the evidence ln Z.'),
      h('p', {}, 'For speed the fit runs on 30 layers, with the opacity tables cut to the data\'s range and their bins joined as far as leaves three model bins to one data bin. Against the full model that costs about 8 ppm for the layers and 4 to 20 ppm for the bins on a hot Jupiter at R = 30: for data much better than that the numbers are not to be trusted to their quoted errors. A simulated spectrum is made with the full tables and 60 layers, so a fit of it feels those differences as real data would.'),
      h('p', {}, 'Left out: the temperature profile from radiative balance (too slow to sample), light curves (the spectra and their errors are taken as given, with no correlation between points), stellar spots and faculae, and anything not one-dimensional. A simulated spectrum is the model\'s own with white noise: recovering it shows the method works, not that the model is right for a real planet. Checks are on the Methods page, Validation tab, under Atmosphere.')))));

function buildPlanet() {
  const host = $('planetRows'); host.innerHTML = ''; setStatus('stPreset', (PRESETS[R.preset] && PRESETS[R.preset].about) || '');
  const relayout = () => { buildParams(); buildOpacity(); };
  host.append(num('Mass (M Jup)', () => R.planet.mplanet, (v) => { R.planet.mplanet = v; }, { min: 0, id: 'mplanet' }), num('Radius is at (bar)', () => R.planet.pRef, (v) => { R.planet.pRef = v; }, { min: 0 }),
    num('Star radius (R Sun)', () => R.star.rstar, (v) => { R.star.rstar = v; }, { min: 0 }), num('Star Teff (K)', () => R.star.teff, (v) => { R.star.teff = v; }, { min: 0 }),
    h('label', {}, 'Temperature profile', h('select', { id: 'tpKind', onchange: (e) => { R.tpKind = e.target.value; relayout(); } }, h('option', { value: 'isothermal', selected: R.tpKind === 'isothermal' }, 'one temperature'), h('option', { value: 'guillot', selected: R.tpKind === 'guillot' }, 'Guillot (irradiated)'))),
    h('label', {}, 'Composition', h('select', { id: 'chem', onchange: (e) => { R.chem = e.target.value; relayout(); } }, h('option', { value: 'free', selected: R.chem === 'free' }, 'each gas by hand'), h('option', { value: 'eq', selected: R.chem === 'eq' }, 'chemical equilibrium'))),
    h('div', { class: 'full', id: 'opacityRows' }));
  buildOpacity();
}
function buildOpacity() {
  const host = $('opacityRows'); if (!host) return; host.innerHTML = ''; if (R.chem !== 'eq') return;
  host.append(h('div', { style: 'font-size:12px;color:var(--dim);margin:4px 0 2px' }, 'Gases whose opacity counts'), h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px' }, GASES.map((g) => h('label', { style: 'display:flex;flex-direction:row;gap:4px;align-items:center' }, h('input', { type: 'checkbox', checked: R.opacity.includes(g), 'aria-label': `${g} opacity`, onchange: (e) => { R.opacity = GASES.filter((x) => (x === g ? e.target.checked : R.opacity.includes(x))); } }), g))));
}
function buildSim() {
  const host = $('simRows'); host.innerHTML = '';
  host.append(h('label', {}, 'Kind', h('select', { id: 'simKind', onchange: (e) => { R.sim.kind = e.target.value; } }, ['transit', 'eclipse', 'night'].map((k) => h('option', { value: k, selected: R.sim.kind === k }, k)))),
    num('Resolving power R', () => R.sim.R, (v) => { R.sim.R = v; }, { min: 3 }), num('From (µm)', () => R.sim.wlMin, (v) => { R.sim.wlMin = v; }, { min: 0.3 }), num('To (µm)', () => R.sim.wlMax, (v) => { R.sim.wlMax = v; }, { max: 50 }),
    num('Noise (ppm)', () => R.sim.noise, (v) => { R.sim.noise = v; }, { min: 0 }), num('Seed', () => R.sim.seed, (v) => { R.sim.seed = v; }, { min: 1, step: 1 }));
}
function buildSampler() {
  const host = $('samplerRows'); host.innerHTML = '';
  host.append(num('Live points', () => R.sampler.nlive, (v) => { R.sampler.nlive = v; }, { min: 25, step: 25 }), num('At most models', () => R.sampler.maxCalls, (v) => { R.sampler.maxCalls = v; }, { min: 200, step: 1000 }), num('At most seconds', () => R.sampler.maxSeconds, (v) => { R.sampler.maxSeconds = v; }, { min: 5, step: 30 }));
}
function buildData() {
  const host = $('dataRows'); host.innerHTML = '';
  if (!R.data.length) host.append(h('p', { class: 'note' }, 'No spectrum yet.'));
  R.data.forEach((d, i) => host.append(h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto 22px;gap:6px;align-items:center;margin:4px 0;font-size:12px' },
    h('span', { title: d.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, `${d.name} (${d.wl.length})`),
    h('select', { 'aria-label': `kind of ${d.name}`, disabled: !!d.simulated, onchange: (e) => { R.data = R.data.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)); R.result = null; showResult(); } }, ['transit', 'eclipse', 'night'].map((k) => h('option', { value: k, selected: d.kind === k }, k))),
    h('button', { class: 'btn sm', title: 'Remove', 'aria-label': `remove ${d.name}`, onclick: () => { R.data = R.data.filter((_, j) => j !== i); R.truth = R.data.length && R.data.every((x) => x.simulated) ? R.truth : null; R.result = null; buildData(); showResult(); } }, '×'))));
  draw();
}
function buildParams() {
  const host = $('paramTable'); host.innerHTML = ''; let group = '';
  const body = h('tbody', {}, h('tr', {}, h('th', {}, 'Parameter'), h('th', {}, ''), h('th', {}, 'Value'), h('th', {}, 'Lowest'), h('th', {}, 'Highest')));
  for (const d of ROWS) {
    if (!d.when(R)) continue; const r = R.rows[d.key];
    if (d.group !== group) { group = d.group; body.append(h('tr', {}, h('td', { colspan: 5, style: 'color:var(--dim);font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding-top:8px' }, group))); }
    const inp = (field, dis) => h('input', { type: 'number', step: 'any', value: r[field] == null ? '' : +Number(r[field]).toPrecision(6), disabled: dis, class: 'pin', 'aria-label': `${shortLabel(d.key)} ${field === 'value' ? 'value' : field === 'a' ? 'lowest' : 'highest'}`, onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { r[field] = v; if (d.key === 'rplanet' && field === 'value' && r.state !== 'free') resetPriors(['rplanet']); } changed(); } });
    body.append(h('tr', {}, h('td', { title: d.key }, longLabel(d.key)),
      h('td', {}, h('select', { 'aria-label': `${shortLabel(d.key)}: free, fixed or off`, 'data-key': d.key, onchange: (e) => { r.state = e.target.value; buildParams(); } }, d.states.map((s) => h('option', { value: s, selected: r.state === s }, s)))),
      h('td', {}, inp('value', r.state === 'off')), h('td', {}, inp('a', r.state !== 'free')), h('td', {}, inp('b', r.state !== 'free'))));
  }
  host.append(h('table', { class: 'src ptable' }, body));
}
function buildAll() { $('preset').value = R.preset; buildPlanet(); buildSim(); buildSampler(); buildData(); buildParams(); showResult(); buttons(); }

// ------------------------------------------------------------------------------------------------- result
function figureData() {
  const r = R.result, same = r && r.sent.dataKey === dataKey();
  return { title: R.name, curve: same ? r.curve : null, sets: R.data.map((d, j) => ({ ...d, lo: d.lo || null, hi: d.hi || null, best: same ? r.best.spectra[j] : null, band: same && r.band ? r.band[j] : null, truth: d.truth || null })) };
}
function draw() { const cv = $('cvFit'); if (!cv) return; const { ctx, W, H } = fitCanvas(cv, Math.max(340, 300 * Math.max(1, R.data.length))); renderFit(ctx, W, H, figureData(), SPEC_THEME); }
const sg = (v, e) => { const dg = Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(Math.max(1e-12, Math.abs(e)))))); return v.toFixed(dg); };
function drawCornerPlot() {
  const r = R.result, cv = $('cvCorner'); if (!cv) return;
  if (!r || !r.converged) { cv.width = 1; cv.height = 1; cv.style.height = '0px'; return; }
  const marks = r.sent.truth ? r.keys.map((k) => (k in r.sent.truth ? r.sent.truth[k] : NaN)) : null;
  cv.style.width = Math.min(980, Math.max(380, 150 * r.keys.length)) + 'px';
  drawCorner(cv, r.post, r.keys.map(shortLabel), marks, {});
}
function showResult() {
  const host = $('resTable'), w = $('warnings'), note = $('resNote'); if (!host) return; host.innerHTML = ''; w.innerHTML = ''; note.innerHTML = ''; draw(); drawCornerPlot(); showRuns();
  const r = R.result; if (!r) return;
  const truth = r.sent.truth, stale = r.sent.dataKey !== dataKey();
  note.append(h('div', { class: 'status ' + (r.converged ? 'ok' : 'err'), id: 'stResult' }, r.converged
    ? `Converged: ln Z = ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}, χ² = ${r.chi2.toFixed(1)} for ${r.ndata} points and ${r.keys.length} free parameters; ${r.ncalls} models in ${r.seconds.toFixed(0)} s (${r.msPerModel.toFixed(1)} ms each; ${r.layers} layers, opacity bins joined by ${r.merge}).`
    : `NOT converged: a limit was reached after ${r.ncalls} models and ${r.seconds.toFixed(0)} s, before the sampler's own stopping rule. The numbers below are where the search had got to, not a posterior: raise the limits under "The run", or free fewer parameters.`),
    ...(stale ? [h('div', { class: 'status warn' }, 'The spectra have changed since this fit: the figure above shows the new data without a model.')] : []));
  host.append(h('table', { class: 'src' }, h('tbody', {}, h('tr', {}, h('th', {}, 'Parameter'), h('th', {}, 'Median'), h('th', {}, '+'), h('th', {}, '−'), h('th', {}, 'Best fit'), h('th', {}, 'Searched between'), truth ? h('th', {}, 'Put in') : null, truth ? h('th', {}, 'Off by') : null),
    r.keys.map((k, i) => { const q = r.summary[k], up = q.hi - q.median, dn = q.median - q.lo, e = Math.min(up, dn) || 1e-12, t = truth && k in truth ? truth[k] : null, z = t == null ? null : (q.median - t) / (0.5 * (q.hi - q.lo));
      return h('tr', {}, h('td', {}, r.labels[i]), h('td', {}, sg(q.median, e)), h('td', {}, sg(up, e)), h('td', {}, sg(dn, e)), h('td', {}, sg(q.best, e)), h('td', {}, `${+r.priors[k].a.toPrecision(5)} to ${+r.priors[k].b.toPrecision(5)}`), truth ? h('td', {}, t == null ? '' : String(+t.toPrecision(6))) : null, truth ? h('td', {}, z == null ? '' : `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ`) : null); }))));
  // a posterior that leans on a limit is the limit's doing
  const edge = r.converged ? r.keys.filter((k) => { const q = r.summary[k], pr = r.priors[k], wd = pr.b - pr.a; return q.lo - pr.a < 0.02 * wd || pr.b - q.hi < 0.02 * wd; }) : [];
  const lines = [...(r.warnings || []), ...(edge.length ? [`${edge.map(shortLabel).join(', ')}: the 16 to 84% range reaches a limit of the search. Either the data do not constrain ${edge.length > 1 ? 'them' : 'it'} (an upper or lower limit, not a measurement) or the limits are too narrow.`] : []), ...(r.converged && r.chi2 > 1.5 * r.ndata ? [`χ² is ${(r.chi2 / r.ndata).toFixed(1)} per point: this model does not describe the data, and its error bars mean little.`] : [])];
  if (lines.length) w.append(h('ul', { class: 'note', id: 'fitWarnings' }, lines.map((t) => h('li', {}, t))));
}
function showRuns() {
  const host = $('runsTable'); if (!host) return; host.innerHTML = '';
  if (!R.runs.length) { host.append(h('p', { class: 'note' }, 'No fits yet.')); return; }
  const key = dataKey(), same = R.runs.filter((x) => x.dataKey === key && x.converged), best = same.reduce((a, b) => (a && a.logZ >= b.logZ ? a : b), null);
  host.append(h('table', { class: 'src' }, h('tbody', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Model'), h('th', {}, 'ln Z'), h('th', {}, 'χ² / points'), h('th', {}, 'Models'), h('th', {}, 'Against the best')),
    R.runs.map((x) => { const cmp = best && x !== best && x.dataKey === key && x.converged ? compareRetrievals(best, x) : null;
      return h('tr', {}, h('td', {}, String(x.n)), h('td', {}, x.what), h('td', {}, x.converged ? `${x.logZ.toFixed(2)} ± ${x.logZerr.toFixed(2)}` : 'not converged'), h('td', {}, `${x.chi2.toFixed(1)} / ${x.ndata}`), h('td', {}, String(x.ncalls)),
        h('td', {}, x.dataKey !== key ? 'other spectra' : !x.converged ? '' : x === best ? 'highest ln Z' : `Δ ln Z = −${cmp.dLogZ.toFixed(1)} ± ${cmp.err.toFixed(1)}: ${cmp.dLogZ < 1 ? 'the data do not tell the two apart' : cmp.dLogZ >= 5 ? 'strongly disfavoured' : cmp.dLogZ >= 2.5 ? 'disfavoured' : 'slightly disfavoured'}`)); }))));
}

// ------------------------------------------------------------------------------------------------- files to take away
const stem = () => (R.name || 'retrieval').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'retrieval';
const samplesCsv = (r) => { const p = r.post, rows = []; for (let i = 0; i < p.n; i++) if (p.weights[i] > 0) rows.push([p.weights[i].toExponential(5), p.logl[i].toFixed(4), ...Array.from(p.samples.subarray(i * p.ndim, (i + 1) * p.ndim), (v) => v.toPrecision(7))].join(',')); return `# ${R.name}: posterior samples of the retrieval (nested sampling; use the weights). Exoplanet Science Lab, ${new Date(now()).toISOString()}\nweight,ln_likelihood,${r.keys.join(',')}\n` + rows.join('\n') + '\n'; };
const spectrumCsv = (r) => { const out = [`# ${R.name}: spectra and the fitted model. Values are fractions (depths, or planet/star flux ratios).`, 'set,kind,wavelength_micron,bin_low,bin_high,value,error,best_fit,posterior_16,posterior_84'];
  R.data.forEach((d, j) => { const ok = r && r.sent.dataKey === dataKey(); d.wl.forEach((wv, i) => out.push([d.name.replace(/,/g, ' '), d.kind, wv, d.lo ? d.lo[i] : '', d.hi ? d.hi[i] : '', d.y[i], d.err[i], ok ? r.best.spectra[j][i].toPrecision(8) : '', ok && r.band ? r.band[j].lo[i].toPrecision(8) : '', ok && r.band ? r.band[j].hi[i].toPrecision(8) : ''].join(','))); }); return out.join('\n') + '\n'; };
const resultJson = (r) => JSON.stringify({ format: 'esl-retrieval', version: 1, name: R.name, saved: new Date(now()).toISOString(), converged: r.converged, logZ: r.logZ, logZerr: r.logZerr, chi2: r.chi2, ndata: r.ndata, keys: r.keys, labels: r.labels, summary: r.summary, priors: r.priors, fixed: r.sent.fixed,
  model: { profile: r.sent.tpKind, composition: r.sent.chem === 'eq' ? 'chemical equilibrium' : 'mixing ratios', gases: r.sent.gases, planet: r.sent.planet, star: r.sent.star, layers: r.layers, opacity_bins_joined: r.merge }, sampler: { ...r.sent.sampler, models: r.ncalls, seconds: r.seconds, ess: r.ess }, warnings: r.warnings, put_in: r.sent.truth,
  data: r.sent.data.map((d, j) => ({ name: d.name, kind: d.kind, simulated: !!d.simulated, wl: d.wl, lo: d.lo || null, hi: d.hi || null, y: d.y, err: d.err, best_fit: Array.from(r.best.spectra[j]) })) }, null, 1) + '\n';
const figureCanvas = () => { const n = Math.max(1, R.data.length), cv = document.createElement('canvas'); cv.width = 1800; cv.height = 2 * (120 + 340 * n); const ctx = cv.getContext('2d'); ctx.scale(2, 2); renderFit(ctx, 900, 120 + 340 * n, figureData(), PRINT_THEME); return cv; };
const cornerCanvas = () => { const r = R.result, cv = document.createElement('canvas'); drawCorner(cv, r.post, r.keys.map(shortLabel), r.sent.truth ? r.keys.map((k) => (k in r.sent.truth ? r.sent.truth[k] : NaN)) : null, { theme: 'light', width: Math.max(700, 190 * r.keys.length), scale: 2, title: R.name }); return cv; };
const needFit = () => { const r = R.result; if (!r) throw new Error('there is no fit yet'); return r; };
async function saveSpectrumPng() { await saveFile(`${stem()}_retrieval_spectrum.png`, await canvasToPNG(figureCanvas())); }
async function saveCsv() { await saveFile(`${stem()}_retrieval_spectrum.csv`, spectrumCsv(R.result)); }
async function saveJson() { if (R.result) await saveFile(`${stem()}_retrieval.json`, resultJson(R.result)); }
async function saveCorner() { if (R.result && R.result.converged) await saveFile(`${stem()}_retrieval_corner.png`, await canvasToPNG(cornerCanvas())); }
async function saveSamples() { if (R.result) await saveFile(`${stem()}_retrieval_samples.csv`, samplesCsv(R.result)); }

buildAll();
addEventListener('resize', () => { draw(); drawCornerPlot(); });
let ready = false;
simulate().then(() => { ready = true; }).catch((err) => { ready = true; setStatus('stData', String((err && err.message) || err), 'err'); });

// ------------------------------------------------------------------------------------------- window.__esl.retrieval
// What the site's assistant drives (the contract is at the top of src/assistant/pages.js). Every tool goes through the
// page's own state and functions, so the page shows what was done.
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra });
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const keysNow = () => ROWS.filter((d) => d.when(R)).map((d) => d.key);
  const setup = () => ({ planet: R.name, mass_Mjup: R.planet.mplanet, radius_at_bar: R.planet.pRef, star: { ...R.star }, temperature_profile: R.tpKind, composition: R.chem === 'eq' ? 'chemical equilibrium' : 'each gas by hand', ...(R.chem === 'eq' ? { opacity_of: R.opacity } : {}),
    parameters: Object.fromEntries(ROWS.filter((d) => d.when(R) && R.rows[d.key].state !== 'off').map((d) => { const r = R.rows[d.key]; return [d.key, r.state === 'free' ? { state: 'free', limits: [r.a, r.b], value_for_simulating: r.value } : { state: 'fixed', value: r.value }]; })),
    off: ROWS.filter((d) => d.when(R) && R.rows[d.key].state === 'off').map((d) => d.key),
    spectra: R.data.map((d) => ({ name: d.name, kind: d.kind, points: d.wl.length, from_um: +d.wl[0].toPrecision(4), to_um: +d.wl[d.wl.length - 1].toPrecision(4), median_error_ppm: +(1e6 * d.err.slice().sort((a, b) => a - b)[Math.floor(d.err.length / 2)]).toFixed(1), simulated: !!d.simulated })),
    run_limits: { ...R.sampler }, fitting_now: R.busy });
  const report = (r) => ({ converged: r.converged, ...(r.converged ? {} : { warning: 'NOT converged: a limit was reached before the sampler\'s stopping rule; these values are not a posterior. Run longer (max_models, max_seconds) or free fewer parameters.' }),
    parameters: Object.fromEntries(r.keys.map((k, i) => { const q = r.summary[k], t = r.sent.truth && k in r.sent.truth ? r.sent.truth[k] : undefined; return [k, { label: r.labels[i], value: +q.median.toPrecision(5), plus: +(q.hi - q.median).toPrecision(2), minus: +(q.median - q.lo).toPrecision(2), searched_between: [r.priors[k].a, r.priors[k].b], ...(t === undefined ? {} : { put_in: t }) }]; })),
    ...(r.converged ? { ln_Z: { value: +r.logZ.toFixed(2), error: +r.logZerr.toFixed(2) } } : {}), chi2: +r.chi2.toFixed(1), data_points: r.ndata, models_computed: r.ncalls, seconds: +r.seconds.toFixed(1), warnings: [...(r.warnings || []), ...[...document.querySelectorAll('#fitWarnings li')].map((li) => li.textContent).filter((t) => !(r.warnings || []).includes(t))],
    fits_compared: R.runs.filter((x) => x.dataKey === r.sent.dataKey).map((x) => ({ fit: x.n, model: x.what, ln_Z: x.converged ? +x.logZ.toFixed(2) : null, chi2: +x.chi2.toFixed(1) })),
    page: r.converged ? 'The page shows the table, the corner plot and the spectrum with the best fit and the posterior\'s band.' : 'The page shows the table with a warning; no corner plot is drawn for a run that did not converge.' });
  const tools = [
    { name: 'retrieval_get', core: true, description: 'What the Retrieval page holds: planet and star, the temperature profile and composition, every parameter with its state (free with limits, fixed with a value, off), the spectra loaded, the run limits, and the last fit if there is one.', parameters: obj({}),
      run: async () => ({ ...setup(), presets: Object.keys(PRESETS), last_fit: R.result ? report(R.result) : null, last_error: R.error }) },
    { name: 'retrieval_set', core: true, description: 'Change what is fitted. preset: start again from one. profile: "isothermal" (parameter t) or "guillot" (teq, tint, logKappaIR, logGamma). composition: "free" (logX_<gas>, log10 mixing ratios) or "equilibrium" (mh, co). free / fixed / off: lists of parameter keys to put in that state; besides those above: rplanet, logCloudTop, cloudFraction, logHaze, hazeSlope, nightDT. values: key -> number (a fixed value, or what a simulated spectrum is made from). limits: key -> [low, high] of a free parameter (uniform prior). opacity: with equilibrium, the gases whose opacity counts. To ask whether a gas or a cloud is needed: fit with it free, set it "off", fit again, compare ln Z.',
      parameters: obj({ preset: T('A preset name.'), profile: T('Temperature profile.', { enum: ['isothermal', 'guillot'] }), composition: T('How the gases are set.', { enum: ['free', 'equilibrium'] }), free: { type: 'array', items: T('key') }, fixed: { type: 'array', items: T('key') }, off: { type: 'array', items: T('key') },
        values: { type: 'object', description: 'key -> value' }, limits: { type: 'object', description: 'key -> [low, high]' }, opacity: { type: 'array', items: T('gas') }, mass_Mjup: N('Planet mass.'), radius_at_bar: N('Pressure the radius refers to.'), rstar: N('Star radius, solar.'), teff: N('Star effective temperature, K.'),
        max_models: { type: 'integer', description: 'Limit on models for a fit.' }, max_seconds: N('Limit on seconds for a fit.'), live_points: { type: 'integer', description: 'Live points (default 100).' } }),
      run: async (c) => {
        if (R.busy) throw new Error('a fit is running: wait for it, or retrieval_stop');
        if (c.preset) { if (!PRESETS[c.preset]) throw new Error(`no preset "${c.preset}" (presets: ${Object.keys(PRESETS).join('; ')})`); loadPreset(c.preset); }
        if (c.profile) R.tpKind = c.profile; if (c.composition) R.chem = c.composition === 'equilibrium' ? 'eq' : 'free';
        const known = (k) => { if (!R.rows[k]) throw new Error(`no parameter "${k}" (parameters: ${ROWS.map((d) => d.key).join(', ')})`); if (!applies(k)) throw new Error(`${k} is not a parameter of this model (profile ${R.tpKind}, composition ${R.chem === 'eq' ? 'equilibrium' : 'free'}): now ${keysNow().join(', ')}`); return ROWS.find((d) => d.key === k); };
        for (const st of ['free', 'fixed', 'off']) for (const k of c[st] || []) { const d = known(k); if (!d.states.includes(st)) throw new Error(`${k} cannot be "${st}" (it can be ${d.states.join(' or ')})`); R.rows[k].state = st; }
        for (const [k, v] of Object.entries(c.values || {})) { known(k); if (!Number.isFinite(Number(v))) throw new Error(`the value of ${k} must be a number`); R.rows[k].value = Number(v); if (k === 'rplanet') resetPriors(['rplanet']); }
        for (const [k, v] of Object.entries(c.limits || {})) { known(k); if (!Array.isArray(v) || !(Number(v[1]) > Number(v[0]))) throw new Error(`the limits of ${k} must be [low, high] with low < high`); R.rows[k].a = Number(v[0]); R.rows[k].b = Number(v[1]); }
        if (c.opacity) { const bad = c.opacity.filter((g) => !GASES.includes(g)); if (bad.length) throw new Error(`no opacity table of ${bad.join(', ')} (gases: ${GASES.join(', ')})`); R.opacity = c.opacity.slice(); }
        if (c.mass_Mjup > 0) R.planet.mplanet = c.mass_Mjup; if (c.radius_at_bar > 0) R.planet.pRef = c.radius_at_bar; if (c.rstar > 0) R.star.rstar = c.rstar; if (c.teff > 0) R.star.teff = c.teff;
        if (c.max_models > 0) R.sampler.maxCalls = c.max_models; if (c.max_seconds > 0) R.sampler.maxSeconds = c.max_seconds; if (c.live_points > 0) R.sampler.nlive = c.live_points;
        buildAll(); return setup();
      } },
    { name: 'retrieval_load_spectrum', core: true, description: 'Put a measured spectrum on the page. The file is a text file among the files (list_files): rows of "wavelength, value, error" or "wavelength, bin_low, bin_high, value, error", wavelengths in micron, header lines allowed. kind: "transit" (transit depth), "eclipse" (eclipse depth) or "night" (night-side planet/star ratio). Several files are fitted together. replace: true removes the spectra already there.',
      parameters: obj({ file: T('File name from list_files.'), kind: T('What the values are.', { enum: ['transit', 'eclipse', 'night'] }), unit: T('Unit of the value and error columns (default fraction).', { enum: ['fraction', 'percent', 'ppm'] }), replace: { type: 'boolean', description: 'Remove the other spectra first.' } }, ['file', 'kind']),
      run: async ({ file, kind, unit = 'fraction', replace = false }, { files }) => { if (R.busy) throw new Error('a fit is running: wait for it, or retrieval_stop'); const text = await files.readText(file); if (replace) R.data = []; addSpectrum(text, { name: file, kind, unit }); return { spectra: setup().spectra }; } },
    { name: 'retrieval_simulate', description: 'Make a spectrum from the model on the page (the values in the parameter table) with white noise, to try a fit where the answer is known. It replaces a simulated spectrum of the same kind. Not a simulation of an instrument.',
      parameters: obj({ kind: T('Which spectrum.', { enum: ['transit', 'eclipse', 'night'] }), from_um: N('Shortest wavelength, micron.'), to_um: N('Longest wavelength, micron.'), resolving_power: N('R of the bins.'), noise_ppm: N('Error of each point, ppm.'), seed: { type: 'integer', description: 'Seed of the noise.' } }),
      run: async (c) => { await simulate({ ...(c.kind ? { kind: c.kind } : {}), ...(c.from_um ? { wlMin: c.from_um } : {}), ...(c.to_um ? { wlMax: c.to_um } : {}), ...(c.resolving_power ? { R: c.resolving_power } : {}), ...(c.noise_ppm ? { noise: c.noise_ppm } : {}), ...(c.seed ? { seed: c.seed } : {}) }); return { spectra: setup().spectra, note: $('stData').textContent }; } },
    { name: 'retrieval_run', core: true, description: 'Fit the model to the spectra on the page (nested sampling) and show the result: the table, the corner plot, the spectrum with the best fit. Takes from under a minute (four parameters, isothermal) to many minutes (equilibrium chemistry, more parameters); the user can press Stop. If "converged" is false the limits ran out and the values are NOT a posterior: say so, and offer to run longer or free fewer parameters. ln Z of two fits of the same spectra can be compared (above 5: strong; within 1: no difference); "fits_compared" lists them.',
      parameters: obj({ max_models: { type: 'integer', description: 'Limit on models (default: the page\'s, 60000).' }, max_seconds: N('Limit on seconds (default: the page\'s, 900).') }),
      run: async ({ max_models, max_seconds } = {}, { onProgress } = {}) => {
        if (max_models > 0) R.sampler.maxCalls = max_models; if (max_seconds > 0) R.sampler.maxSeconds = max_seconds; buildSampler();
        const tick = setInterval(() => { if (onProgress && R.progress) onProgress({ message: `Fitting: ${R.progress.ncalls} models, ${R.progress.elapsed.toFixed(0)} s` }); }, 3000);
        try { return report(await fit()); } catch (err) { if (err.stopped) return { stopped: true, note: 'The user stopped the fit; nothing was kept from it.' }; throw err; } finally { clearInterval(tick); }
      } },
    { name: 'retrieval_stop', description: 'Stop the fit that is running. Nothing is kept from it.', parameters: obj({}), run: async () => ({ stopped: stop() }) },
    { name: 'retrieval_export', description: 'Give the user the result as files: "json" (every number, the limits, the data and the best fit), "samples" (the weighted posterior samples), "csv" (the spectra with the best fit and the posterior\'s band). Needs a fit.', parameters: obj({ what: T('Which file.', { enum: ['json', 'samples', 'csv'] }) }, ['what']),
      run: async ({ what }, { files }) => { const r = needFit(); if (what === 'json') return { written: await files.write(`${stem()}_retrieval.json`, resultJson(r)) }; if (what === 'samples') return { written: await files.write(`${stem()}_retrieval_samples.csv`, samplesCsv(r)) }; return { written: await files.write(`${stem()}_retrieval_spectrum.csv`, spectrumCsv(r)) }; } },
  ];
  (window.__esl = window.__esl || {}).retrieval = { tools, ready: () => ready, R, fit, stop, simulate, figureCanvas, cornerCanvas,
    state: () => { const r = R.result; return [`Retrieval: ${R.name}; ${R.data.length} spectr${R.data.length === 1 ? 'um' : 'a'} (${R.data.map((d) => `${d.kind}, ${d.wl.length} points`).join('; ') || 'none'}); free: ${freeKeys().join(', ') || 'nothing'}${R.busy ? '; a fit is running' : ''}.`, r ? (r.converged ? `Last fit: ln Z ${r.logZ.toFixed(2)}, χ² ${r.chi2.toFixed(1)} for ${r.ndata} points; ${r.keys.map((k) => `${k} ${+r.summary[k].median.toPrecision(4)}`).join(', ')}.` : 'Last fit: NOT converged.') : 'No fit yet. Tools: retrieval_get, retrieval_set, retrieval_load_spectrum, retrieval_simulate, retrieval_run, retrieval_stop, retrieval_export.']; } };
}
