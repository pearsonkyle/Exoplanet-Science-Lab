// Atmosphere page: a model description -> the forward model in a worker (src/core/rtmodel.js) -> spectrum, profiles,
// opacities, maps and the 3D view. The science is in src/core (atmosphere, opacity, transmission, emission, continuum,
// colour: tested in test/atmosphere.test.mjs, opacity.test.mjs, rt_reference.test.mjs); this file is the UI.
import { siteRoot } from '../site/nav.js';
import { siteJson, fetchOr } from '../site/net.js';
import { now } from '../site/clock.js';
import { loadIndex, lookupHost, systemFromRows, searchNames } from '../core/catalog.js';
import { C } from '../core/derive.js';
import { DEFAULT_MODEL } from '../core/rtmodel.js';
import { WORLDS } from '../core/worlds.js';
import { CONDENSATES } from '../core/condensation.js';
import { blackbodyColour, stellarLimbColours, spectrumToXYZ, xyzToLinearSRGB, srgbEncode, cmfX, cmfY, cmfZ, spectrumColour } from '../core/colour.js';
import { makeZip } from '../core/zip.js';
import { bundleFiles } from './bundle.js';
import { parseSpectrumText } from '../core/atmoapi.js';
import { createRetrievalClient } from '../retrieval/client.js';
import { planckSI } from '../core/phasecurve.js';
import { K_B, M_U } from '../core/atmosphere.js';
import { solarXuv } from '../core/escape.js';
import { levelRadii, radialStrip, opaqueLevel, limbColours, limbTexture, displayWeights, displayFactors, shellExtinction, shellTextures } from '../viz/atmoview.js';
import { fitCanvas } from '../photometry/plots.js';
import { saveFile, canvasToPNG } from '../ui/export.js';
import { ATM_THEME, PRINT_THEME, SPECIES_COLOURS, renderModelSpectrum, renderProfile, renderMixing, renderOpacity, renderMap, renderColourResponse, ramp } from './plots.js';

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else if (k === 'style') el.style.cssText = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const $ = (id) => document.getElementById(id);
const setStatus = (id, text, cls = '') => { const el = $(id); if (el) { el.textContent = text; el.className = 'status' + (cls ? ' ' + cls : ''); } };

// ------------------------------------------------------------------------------------------------- state
// WASP-39 b as the starting planet (Mancini et al. 2018, A&A 613, A41); "Look up" replaces it from the site's catalogue
const M = {
  name: 'WASP-39 b',
  // the top at 1e-8 bar, where even the strongest bands are transparent along the highest ray (the tables stop at 1e-5 bar: held constant above)
  model: structuredClone({ ...DEFAULT_MODEL, pTop: 1e-8, nLayers: 80, planet: { mplanet: 0.281, rplanet: 1.279, pRef: 0.01 }, star: { rstar: 0.939, teff: 5485 }, tp: { kind: 'consistent', teq: 1166, tint: 100, kappaIR: 1e-3, gamma: 0.4, f: 0.25, t: 1166, t0: 900, a1: 0.6, a2: 0.5, p1: 1e-3, p2: 1e-2, p3: 1 } }),
  ars: 11.4,
  off: {},                                   // species switched off keep their slider value here
  ui: { kind: 'transit', range: 'wide', layerP: 1e-2, map: 'limb', view: 'planet', quantity: 'temperature', viewWl: 1.4, stretch: 3, parts: true, colour: 'true', ev: 0, look: 'day' },
  tables: null, result: null, parts: {}, busy: false, queued: false, ready: false, seq: 0, error: null, pick: {},
};
M.ui.hl = { cvVmr: null, cvOp: null, cvSpec: null, cvVis: null }; M.ui.pin = { cvVmr: null, cvOp: null, cvSpec: null, cvVis: null };   // the curve picked out in each plot, and whether a click holds it
// Wavelength ranges [micron] whose colours the 3D view can show: the shortest wavelength blue, the longest red.
const COLOUR_BANDS = { 'HST STIS, 0.3–1.0 µm': [0.3, 1.0], 'HST WFC3 G141, 1.1–1.7 µm': [1.1, 1.7], 'JWST NIRISS SOSS, 0.6–2.8 µm': [0.6, 2.8], 'JWST NIRSpec PRISM, 0.6–5.3 µm': [0.6, 5.3], 'JWST NIRSpec G395H, 2.9–5.1 µm': [2.9, 5.1], 'JWST MIRI LRS, 5–12 µm': [5, 12], 'Ariel, 0.5–7.8 µm': [0.5, 7.8] };
const RANGES = { wide: [0.3, 12], all: [0.3, 50], jwst: [0.6, 12], optical: [0.3, 1.1], nir: [0.8, 5.3], mir: [5, 28] };
const SPECIES = ['H2O', 'CO2', 'CO', 'CH4', 'NH3', 'HCN', 'SO2', 'H2S', 'Na', 'K', 'TiO', 'VO'];
// Chemistry, escape and ionization settings of the page (the model itself is M.model).
M.chem = { on: true, mh: 0, co: 0.59, quenchOn: false, quench: 1, loaded: false, loading: false };
M.mstar = 0.93; M.feh = null; M.esc = { age: 5 }; M.ion = false; M.nightDT = 300;   // a night side 300 K cooler to begin with: the size of contrast phase curves of hot Jupiters show
M.cond = { on: true, humidity: 1, only: null };   // condensation with rain-out (src/core/condensation.js)
// Starting points for the clouds and haze card: each sets every aerosol field of the model.
const CLEAR = { cloudTop: null, haze: null, cloud: null, rayleigh: true, rayleighFactor: 1, cloudFraction: 1 };
const AEROSOLS = {
  'Clear': CLEAR,
  'Grey deck at 1 mbar': { ...CLEAR, cloudTop: 1e-3 },
  'Patchy deck: half the limb': { ...CLEAR, cloudTop: 1e-3, cloudFraction: 0.5 },
  'Rayleigh haze, 100 × the gas': { ...CLEAR, rayleighFactor: 100 },
  'Steep haze, λ⁻⁸ (super-Rayleigh slope)': { ...CLEAR, haze: { factor: 300, slope: -8 } },
  'Fine haze grains, 0.03 µm, high up': { ...CLEAR, cloud: { top: 1e-6, base: 1e-3, tau: 0.02, radius: 0.03, q0: 40, albedo: 0.9 } },
  'Silicate cloud, 1 µm grains': { ...CLEAR, cloud: { top: 1e-3, base: 1e-1, tau: 3, radius: 1, q0: 10, albedo: 0.95 } },
  'Thick grey cloud, 10 µm grains': { ...CLEAR, cloud: { top: 1e-2, base: 1, tau: 30, radius: 10, q0: 10, albedo: 0.9 } },
  'Tholin haze (Titan-like), 0.2 µm grains': { ...CLEAR, cloud: { material: 'tholin', top: 1e-6, base: 1, tau: 6, radius: 0.2, sigma: 0.4, power: 0.55, q0: 40, albedo: 1 } },
};
// the gases beyond the first four start switched off, at a mixing ratio that shows their bands once ticked
const EXTRA = { NH3: 1e-6, HCN: 1e-7, SO2: 1e-6, H2S: 1e-5, Na: 1e-6, K: 1e-7, TiO: 1e-8, VO: 1e-9 };
// in chemical equilibrium (the default) every gas that matters at these temperatures is on; SO2 is made by photochemistry, not
// equilibrium, and TiO and VO need a hotter planet: those three start off (tick them to load their tables)
for (const [s, v] of Object.entries(EXTRA)) { M.model.vmr[s] = v; if (['SO2', 'TiO', 'VO'].includes(s)) M.off[s] = true; }

// ------------------------------------------------------------------------------------------------- worker
const worker = new Worker(new URL('./atmosphere.worker.js', import.meta.url), { type: 'module' });
worker.onerror = (e) => { setBusy(false); M.error = e.message || 'The worker failed to start.'; M.busy = false; M.partsPhase = false; setStatus('stRun', M.error, 'err'); };
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'error' && m.tables) { M.loading.clear(); M.error = m.message; setStatus('stRun', 'An opacity table could not be read: ' + m.message, 'err'); return; }
  if (m.type === 'chemReady') { M.chem.loaded = true; M.chem.loading = false; M.chem.source = m.source; run(); return; }
  if (m.type === 'ready') { const first = !M.ready; M.tables = m; M.ready = true; for (const t of [...m.species, ...m.cia]) { M.loaded.add(t.name); M.loading.delete(t.name); } if (first) { describeTables(); buildVmr(); } run(); return; }
  if (m.id !== M.seq) return;   // an older run
  if (m.type === 'result') { M.result = m; M.parts = {}; M.error = null; M.partsPhase = true; setBusy(false); afterResult(); }
  if ((m.type === 'result' && !M.queued) || m.type === 'error' || (m.type === 'done' && !M.queued)) { const w = idleWaiters; idleWaiters = []; for (const f of w) f(); }
  else if (m.type === 'part') { if (M.ui.parts) { M.parts[m.name] = m; drawSpectrum(); } }
  else if (m.type === 'opacity') { if (M.result) { M.result.opacity = m.opacity; drawOpacity(); } }
  else if (m.type === 'decades') { if (M.bundleWait) { M.bundleWait(m.decades); M.bundleWait = null; } }
  else if (m.type === 'done') { M.busy = false; M.partsPhase = false; if (M.queued) { M.queued = false; run(); } }
  else if (m.type === 'error') { setBusy(false); M.busy = false; M.partsPhase = false; M.error = m.message; setStatus('stRun', m.message, 'err'); if (M.queued) { M.queued = false; run(); } }
};
/** The model as the worker gets it: only the profile's own parameters, species that are switched on. */
function modelForRun() {
  const m = structuredClone(M.model), tp = m.tp;
  m.tp = tp.kind === 'table' ? { kind: 'table', p: tp.p, t: tp.t } : tp.kind === 'consistent' ? { kind: 'consistent', teq: tp.teq, tint: tp.tint, f: tp.f ?? 0.25 } : tp.kind === 'isothermal' ? { kind: 'isothermal', t: tp.t } : tp.kind === 'guillot' ? { kind: 'guillot', teq: tp.teq, tint: tp.tint, kappaIR: tp.kappaIR, gamma: tp.gamma } : { kind: 'ms09', t0: tp.t0, a1: tp.a1, a2: tp.a2, p1: tp.p1, p2: tp.p2, p3: tp.p3, p0: m.pTop };
  for (const s of Object.keys(m.vmr)) if (M.off[s]) delete m.vmr[s];
  m.star.ars = M.ars; if (M.ui.starKind === 'blackbody') m.star.spectrum = 'blackbody'; if (M.feh != null) m.star.feh = M.feh;
  // the star's extreme ultraviolet at the planet: the Sun's history at this age, scaled to the orbit
  if (M.ion) m.ionization = { mu0: 0.5, fxuv: solarXuv(M.esc.age) / ((M.ars * M.model.star.rstar * C.Rsun) / C.AU) ** 2 };
  if (M.nightDT > 0) m.night = { dT: M.nightDT };
  m.condensation = M.cond.on ? { rainout: true, humidity: M.cond.humidity, ...(M.cond.only ? { only: M.cond.only } : {}) } : null;
  if (m.cloud && m.cloud.follow && !M.cond.on) m.cloud = { ...m.cloud, follow: null };
  if (M.chem.on) { m.chemistry = { mh: M.chem.mh, co: M.chem.co, quench: M.chem.quenchOn ? M.chem.quench : null }; m.vmr = {}; m.opacityOff = SPECIES.filter((s) => M.off[s]); }
  return m;
}
function layerIndex() { const n = M.model.nLayers, a = Math.log(M.model.pTop), b = Math.log(M.model.pBottom); return Math.max(0, Math.min(n - 1, Math.floor(((Math.log(M.ui.layerP) - a) / (b - a)) * n))); }
/** While a model is being computed the figures and numbers on the page are the previous model's: they are dimmed and a
 *  small "Calculating" tag is shown, so that nobody reads them as the answer to the change just made. */
let idleWaiters = [];
/** Resolves when the page has no model running or queued (the assistant's tools wait on it before reading results).
 *  The spectra of each gas alone may still be arriving then: the model itself is done. */
function whenIdle(timeout = 120000) { return new Promise((res, rej) => { if ((!M.busy || M.partsPhase) && !M.queued && M.result && !M.error) { res(); return; } const t = setTimeout(() => { idleWaiters = idleWaiters.filter((w) => w !== done); rej(new Error('the model did not finish in two minutes')); }, timeout), done = () => { clearTimeout(t); res(); }; idleWaiters.push(done); }); }
function setBusy(on) { $('app').classList.toggle('busy', on); const t = $('busyTag'); if (t) t.hidden = !on; }
function run() {
  if (!M.ready) return;
  if (!tablesFor(Object.keys(M.model.vmr).filter((s) => !M.off[s]))) return;
  if (M.chem.on && !M.chem.loaded) { loadChem(); return; }   // 'chemReady' runs again   // a table is on its way: 'ready' runs again
  // while the worker is still on the spectra of each gas alone, a new run goes out at once: it drops them
  if (M.busy && !M.partsPhase) { M.queued = true; return; }
  M.busy = true; M.partsPhase = false; M.seq++; setBusy(true);
  worker.postMessage({ type: 'run', id: M.seq, model: modelForRun(), layer: layerIndex(), parts: M.ui.parts });
}

// The tables are fetched when first needed: at the start the collision-induced absorption and the gases that are
// switched on (8.5 MB), each other gas (2 MB) when it is ticked.
M.loaded = new Set(); M.loading = new Set(); M.failed = new Set();
const opacityRoot = () => new URL('opacity/', siteRoot());
async function fetchTables(names) {
  const want = M.index.tables.filter((t) => names.includes(t.species) && !M.loaded.has(t.species) && !M.loading.has(t.species));
  if (!want.length) return;
  for (const t of want) M.loading.add(t.species);
  setStatus('stRun', `Loading the opacity ${want.length > 1 ? 'tables' : 'table'} of ${want.map((t) => t.species).join(', ')} …`);
  const got = await Promise.all(want.map((t) => fetchOr(String(new URL(t.file, opacityRoot())), { what: `The opacity table of ${t.species}`, as: 'arrayBuffer', timeout: 120000 }).catch(() => null)));
  const buffers = [];
  // a table stays in `loading` until the worker reports it (so that it cannot be fetched and added twice)
  want.forEach((t, i) => { if (got[i] instanceof ArrayBuffer) { buffers.push(got[i]); return; } M.loading.delete(t.species); M.failed.add(t.species); if (t.kind !== 'cia') { M.off[t.species] = true; const cb = document.querySelector(`input[aria-label="${t.species} on or off"]`); if (cb) cb.checked = false; } });
  if (buffers.length) worker.postMessage({ type: 'tables', buffers }, buffers);
  else { setStatus('stRun', `The opacity ${want.length > 1 ? 'tables' : 'table'} of ${want.map((t) => t.species).join(', ')} could not be loaded.`, 'err'); if (M.ready) run(); }
}
/** Are the tables of these gases loaded? If not, start fetching them (the worker's 'ready' then runs the model). */
function tablesFor(names) {
  // collision-induced absorption is always wanted; a table whose download failed is not asked for again in this visit
  const known = new Set(M.index.tables.map((t) => t.species)), cia = M.index.tables.filter((t) => t.kind === 'cia').map((t) => t.species);
  const missing = [...names, ...cia].filter((s) => known.has(s) && !M.loaded.has(s) && !M.failed.has(s));
  if (!missing.length) return true;
  fetchTables(missing).catch((err) => setStatus('stRun', String((err && err.message) || err), 'err'));
  return false;
}
async function loadChem() {
  if (M.chem.loading) return; M.chem.loading = true;
  setStatus('stRun', 'Loading the chemistry table (5 MB) …');
  try { const buf = await fetchOr(String(new URL('chem/equilibrium.eslc', siteRoot())), { what: 'The equilibrium chemistry table', as: 'arrayBuffer', timeout: 120000 }); worker.postMessage({ type: 'chem', buffer: buf }, [buf]); }
  catch (err) { M.chem.loading = false; M.chem.on = false; $('chemMode').value = 'free'; buildVmr(); setStatus('stRun', 'The chemistry table could not be loaded; the gases are set by hand again.', 'err'); run(); }
}
async function loadTables() {
  setStatus('stRun', 'Loading the opacity tables …');
  M.index = await siteJson(new URL('index.json', opacityRoot()), 'The opacity tables (opacity/index.json)');
  const have = new Set(M.index.tables.map((t) => t.species));
  for (const s of SPECIES) if (!have.has(s)) M.off[s] = true;   // no table for it in this build
  // model stellar spectra (0.5 MB, from the PHOENIX files the limb darkening uses); without them the star is a blackbody
  fetchOr(String(new URL('stellar/phoenix.esls', siteRoot())), { what: 'The stellar spectra', as: 'arrayBuffer', timeout: 60000, fallback: null, quiet404: true }).then((b) => { if (b instanceof ArrayBuffer) { worker.postMessage({ type: 'star', buffer: b }, [b]); if (M.ready) run(); } }).catch(() => {});
  // the WebAssembly mixing kernel (2.6 times faster, the same numbers); without it the JavaScript loop runs
  fetchOr(String(new URL('wasm/mix.wasm', siteRoot())), { what: 'The fast mixing kernel', as: 'arrayBuffer', timeout: 30000, fallback: null, quiet404: true }).then((b) => { if (b instanceof ArrayBuffer) worker.postMessage({ type: 'kernel', buffer: b }, [b]); }).catch(() => {});
  await fetchTables(M.index.tables.filter((t) => t.kind === 'cia' || !M.off[t.species]).map((t) => t.species));
}

// ------------------------------------------------------------------------------------------------- layout
const app = $('app');
const num = (label, id, value, attrs = {}) => h('label', {}, label, h('input', { type: 'number', id, value, step: 'any', ...attrs }));
const sel = (label, id, options, value) => h('label', {}, label, h('select', { id }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
const seg = (id, options, value, onpick) => h('span', { class: 'seg', id }, options.map(([v, t]) => h('button', { type: 'button', 'data-v': v, class: v === value ? 'on' : '', onclick: (e) => { for (const b of e.currentTarget.parentElement.children) b.classList.toggle('on', b === e.currentTarget); onpick(v); } }, t)));
/** A row with a log slider and a number box that stay in step. */
function logSlider(label, id, value, lo, hi, onchange, { dot = null, toggle = null } = {}) {
  const r = h('input', { type: 'range', id: id + 'R', min: Math.log10(lo), max: Math.log10(hi), step: 0.05, value: Math.log10(value), 'aria-label': label + ' (log scale)' });
  const n = h('input', { type: 'number', id, value: value.toExponential(1), step: 'any', min: lo, max: hi, 'aria-label': label });
  r.addEventListener('input', () => { const v = 10 ** Number(r.value); n.value = v.toExponential(1); onchange(v); });
  n.addEventListener('change', () => { const v = Math.min(hi, Math.max(lo, Number(n.value))); if (!(v > 0)) return; r.value = Math.log10(v); onchange(v); });
  const name = h('span', { class: 'sw' }, toggle, dot ? h('span', { class: 'dot', style: 'background:' + dot }) : null, label);
  return h('div', { class: 'sl' }, name, r, n);
}
const card = (...kids) => h('div', { class: 'card' }, ...kids);

app.append(h('div', { id: 'busyTag', class: 'busytag', hidden: true, role: 'status', 'aria-live': 'polite' }, h('span', { class: 'spin' }), 'Calculating …'), h('div', { class: 'cols' },
  h('div', { class: 'side' },
    card(h('h2', {}, 'Planet and star'),
      h('label', { style: 'margin-bottom:8px' }, 'Start from a world', h('select', { id: 'world', onchange: (e) => applyWorld(e.target.value) }, Object.keys(WORLDS).map((k) => h('option', { value: k }, k)))),
      h('div', { class: 'status', id: 'stWorld' }),
      h('div', { class: 'row' }, h('input', { type: 'text', id: 'inPlanet', value: M.name, list: 'plNames', style: 'flex:1 1 120px;min-width:0', 'aria-label': 'Planet name', oninput: () => suggest() }), h('datalist', { id: 'plNames' }),
        h('button', { class: 'btn', id: 'bLook', onclick: () => lookup($('inPlanet').value).catch(() => {}) }, 'Look up')),
      h('div', { class: 'grid2', style: 'margin-top:8px' },
        num('Mass (M Jup)', 'mplanet', M.model.planet.mplanet, { min: 0.001 }), num('Radius (R Jup)', 'rplanet', M.model.planet.rplanet, { min: 0.01 }),
        num('Star radius (R Sun)', 'rstar', M.model.star.rstar, { min: 0.05 }), num('Star Teff (K)', 'teff', M.model.star.teff, { min: 2000 }),
        num('a / R★', 'ars', M.ars, { min: 1.5 }), num('Radius is at (bar)', 'pRef', M.model.planet.pRef, { min: 1e-6 })),
      h('label', { style: 'margin-top:8px' }, 'The star\'s spectrum, for eclipse depths', h('select', { id: 'starKind', onchange: (e) => { M.ui.starKind = e.target.value; run(); } }, h('option', { value: 'model' }, 'model atmosphere (PHOENIX)'), h('option', { value: 'blackbody' }, 'blackbody'))),
      h('div', { class: 'status', id: 'stStar' }),
      h('div', { class: 'status', id: 'stSys' })),
    card(h('h2', {}, 'Temperature profile'),
      h('div', { class: 'grid2' }, h('label', { class: 'full' }, 'Kind', h('select', { id: 'tpKind' }, [['consistent', 'Radiative balance (from the gases)'], ['guillot', 'Guillot (2010): irradiated, grey'], ['isothermal', 'Isothermal'], ['ms09', 'Madhusudhan & Seager (2009)'], ['table', 'Measured profile (of a preset world)']].map(([v, t]) => h('option', { value: v, selected: v === M.model.tp.kind }, t))))),
      h('div', { class: 'grid2', id: 'tpFields', style: 'margin-top:6px' }),
      h('div', { class: 'status', id: 'stTp' }),
      h('label', { style: 'margin-top:8px' }, 'Night side cooler by (K)', h('input', { type: 'number', id: 'nightDT', value: M.nightDT, min: 0, max: 3000, step: 50, onchange: (e) => { M.nightDT = Math.max(0, Number(e.target.value) || 0); run(); } })),
      h('div', { class: 'status', id: 'stNight' })),
    card(h('h2', {}, 'Composition'),
      h('label', {}, 'Gases', h('select', { id: 'chemMode', onchange: (e) => { M.chem.on = e.target.value === 'eq'; buildVmr(); run(); } }, h('option', { value: 'free', selected: !M.chem.on }, 'set each by hand'), h('option', { value: 'eq', selected: M.chem.on }, 'chemical equilibrium'))),
      h('div', { id: 'chemRow' }),
      h('div', { id: 'vmrRows' }),
      h('div', { class: 'grid2', style: 'margin-top:6px' }, num('He / H2 (by number)', 'heH2', M.model.heH2, { min: 0, max: 1 }),
        sel('Bulk gas', 'bulk', [['H2He', 'hydrogen and helium'], ['N2', 'nitrogen'], ['CO2', 'carbon dioxide']], M.model.bulk || 'H2He')),
      h('div', { class: 'status', id: 'stMu' }),
      h('label', { class: 'chk', style: 'margin-top:8px' }, h('input', { type: 'checkbox', id: 'condOn', checked: M.cond.on, onchange: (e) => { M.cond.on = e.target.checked; buildCloud(); run(); } }), 'Condense and rain out'),
      h('div', { class: 'grid2', style: 'margin-top:6px' }, h('label', {}, 'Saturation allowed (1 = 100%)', h('input', { type: 'number', id: 'condHum', value: M.cond.humidity, min: 0.05, max: 2, step: 0.05, onchange: (e) => { const v = Number(e.target.value); if (v > 0) { M.cond.humidity = v; run(); } } }))),
      h('div', { class: 'status', id: 'stCond' })),
    card(h('h2', {}, 'Clouds and haze'),
      h('label', {}, 'Start from', h('select', { id: 'aeroPreset' }, Object.keys(AEROSOLS).map((k) => h('option', { value: k }, k)))),
      h('label', { class: 'chk', style: 'margin-top:8px' }, h('input', { type: 'checkbox', id: 'cloudOn' }), 'Grey cloud deck'),
      h('div', { id: 'cloudRow' }),
      h('label', { class: 'chk', style: 'margin-top:6px' }, h('input', { type: 'checkbox', id: 'partOn' }), 'Particle layer (cloud or haze of one grain size)'),
      h('div', { id: 'partRow' }),
      h('label', { class: 'chk', style: 'margin-top:6px' }, h('input', { type: 'checkbox', id: 'hazeOn' }), 'Haze (power law)'),
      h('div', { id: 'hazeRow' }),
      h('label', { class: 'chk', style: 'margin-top:6px' }, h('input', { type: 'checkbox', id: 'rayOn', checked: true }), 'Rayleigh scattering by the gas'),
      h('div', { id: 'rayRow' }),
      h('div', { id: 'coverRow' }),
      h('div', { class: 'status', id: 'stAero' })),
    card(h('h2', {}, 'Ionization by starlight'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'ionOn', onchange: (e) => { M.ion = e.target.checked; run(); } }), 'Hydrogen, sodium and potassium ionized by the star'),
      h('div', { class: 'grid2', style: 'margin-top:6px' }, num('Star\'s age (Gyr), for its extreme ultraviolet', 'escAge', M.esc.age, { min: 0.02, max: 13 })),
      h('div', { class: 'status', id: 'ionOut' })),
    card(h('h2', {}, 'Layers'),
      h('div', { class: 'grid2' }, sel('Layers', 'nLayers', [['30', '30'], ['60', '60'], ['80', '80'], ['120', '120']], String(M.model.nLayers)), num('Top (bar)', 'pTop', M.model.pTop, { min: 1e-10, max: 1e-2 })),
      h('div', { class: 'status', id: 'stTop' }))),
  h('div', { class: 'main' },
    h('h2', {}, 'The planet, in true colour'),
    h('div', { class: 'bar' },
      seg('segView', [['planet', 'Planet'], ['transit', 'Against the star'], ['cutaway', 'Cutaway']], M.ui.view, (v) => { M.ui.view = v; if (view) view.setMode(v); update3d(); }),
      h('span', { id: 'planetL' }, ...[['day', 'Day side'], ['terminator', 'Terminator'], ['night', 'Night side'], ['transit', 'Transit'], ['eclipse', 'Eclipse']].map(([k, t]) => [h('button', { class: 'btn sm', id: 'bLook_' + k, onclick: () => { M.ui.look = k; M.ui.ev = 0; $('ev').value = 0; update3d(); if (view) view.lookFrom(k); } }, t), ' ']).flat(),
        h('label', {}, 'Exposure ', h('input', { type: 'range', id: 'ev', min: -8, max: 8, step: 0.5, value: M.ui.ev, 'aria-label': 'Exposure in stops', oninput: (e) => { M.ui.ev = Number(e.target.value); update3d(); } }))),
      h('span', { id: 'zoomL' }, h('button', { class: 'btn sm', id: 'bZoomStar', onclick: () => view && view.zoomTo(false) }, 'Whole star'), ' ', h('button', { class: 'btn sm', id: 'bZoomLimb', onclick: () => view && view.zoomTo(true) }, 'Zoom to the planet')),
      h('label', { id: 'stretchL', title: 'The atmosphere is a thin skin, a few per cent of the radius. At true scale it is hard to see, so its height above the opaque level can be drawn 3, 10 or 30 times taller. The light passing through each layer is unchanged.' }, 'Height of the atmosphere ', h('select', { id: 'stretch', onchange: (e) => { M.ui.stretch = Number(e.target.value); update3d(); } }, [1, 3, 10, 30].map((v) => h('option', { value: v, selected: v === M.ui.stretch }, v === 1 ? 'true scale' : `drawn ${v} × taller`)))),
      h('label', { id: 'quantL' }, 'Colour by ', h('select', { id: 'quantity', onchange: (e) => { M.ui.quantity = e.target.value; update3d(); } }, [['temperature', 'temperature'], ['limb', 'limb transmittance at λ'], ['contribution', 'emission contribution at λ'], ...SPECIES.map((s) => ['vmr:' + s, s + ' mixing ratio'])].map(([v, t]) => h('option', { value: v }, t))))),
    h('div', { class: 'card pad6' }, h('div', { class: 'view3d', id: 'view3d' }, h('div', { class: 'cap', id: 'err3d' }))),
    h('div', { id: 'cutLegend', class: 'cutlegend', style: 'display:none' }),
    h('div', { class: 'swatches', id: 'swatches' }),
    h('p', { class: 'note' }, 'What the eye would see: the model\'s spectrum from 0.38 to 0.75 µm under the star\'s light. "Height of the atmosphere" only makes the thin shell of gas easier to see. The details are under "How this is computed" at the foot of the page.'),
    h('h2', {}, 'Spectrum'),
    h('div', { class: 'bar' },
      seg('segKind', [['transit', 'Transmission'], ['eclipse', 'Emission']], M.ui.kind, (v) => { M.ui.kind = v; if (v === 'eclipse' && M.ui.map === 'limb') setMap('contribution'); if (v === 'transit' && M.ui.map === 'contribution') setMap('limb'); drawAll(); }),
      h('label', {}, 'Range ', h('select', { id: 'range', onchange: (e) => { M.ui.range = e.target.value; drawAll(); } }, [['wide', '0.3–12 µm'], ['jwst', '0.6–12 µm'], ['all', '0.3–50 µm'], ['optical', '0.3–1.1 µm'], ['nir', '0.8–5.3 µm'], ['mir', '5–28 µm']].map(([v, t]) => h('option', { value: v }, t)))),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'partsOn', checked: true, onchange: (e) => { M.ui.parts = e.target.checked; if (M.ui.parts) run(); else { M.parts = {}; drawSpectrum(); } } }), 'each gas alone'),
      h('button', { class: 'btn sm', id: 'bCsv', onclick: () => saveCsv() }, 'Save CSV'), h('button', { class: 'btn sm', id: 'bBundle', title: 'A zip with the model, every plotted quantity as CSV, and a Python script that redraws the figures', onclick: () => saveBundle().catch((err) => setStatus('stRun', String((err && err.message) || err), 'err')) }, 'Download everything'), h('button', { class: 'btn sm', id: 'bPng', onclick: () => savePng() }, 'Save figure'),
      h('button', { class: 'btn sm', id: 'bSend', title: 'Keeps this spectrum in the browser so the Spectroscopy page can simulate an observation of it', onclick: () => sendToSimulator() }, 'Use in the simulator')),
    h('div', { class: 'card pad6' }, h('canvas', { id: 'cvSpec', role: 'img', 'aria-label': 'Model spectrum' })),
    h('div', { class: 'status', id: 'stRun' }),
    h('h2', {}, 'Structure'),
    h('div', { class: 'bar' }, h('span', { id: 'wlHost', style: 'flex:1 1 320px;max-width:460px' })),
    h('p', { class: 'note' }, 'Left: temperature against pressure. The shaded band shows where the spectrum comes from at the wavelength set by the slider: in transmission, the pressures where starlight grazing the limb (the planet\'s edge) goes from passing to blocked; in emission, the layers the planet\'s own light leaves from. Move the slider into a strong band and the shading climbs to lower pressure. Right: how much of each gas there is. Two entries look alike and are different things: e- is free electrons, H- is the hydrogen atom that has caught one, which absorbs strongly in the red and near infrared of hot atmospheres. They are counted separately because only H- has that opacity; both rise with temperature and with ionization.'),
    h('div', { class: 'plots two' }, h('div', { class: 'card pad6' }, h('canvas', { id: 'cvTp', role: 'img', 'aria-label': 'Temperature against pressure' })), h('div', { class: 'card pad6' }, h('canvas', { id: 'cvVmr', role: 'img', 'aria-label': 'Mixing ratios against pressure' }))),
    h('h2', {}, 'Opacity and where the spectrum forms'),
    h('p', { class: 'note' }, 'Left: how strongly each gas absorbs at one pressure level, the one set by the "layer" slider (in units of optical depth per scale height: above 1, the dashed line, the layer is opaque). The axis is fixed from 10⁻⁶ to 10⁸ so that curves can be compared as the layer or the model changes; it is logarithmic, so zero is off the bottom and anything weaker than 10⁻⁶ sits on the floor. Right: for every wavelength, the pressure at which the atmosphere turns from clear to opaque along the limb (or, in emission, where the light escapes from). The white line is the level half the light passes.'),
    h('div', { class: 'bar' }, h('span', { id: 'layerHost', style: 'flex:1 1 320px;max-width:460px' }),
      h('label', {}, 'Map ', h('select', { id: 'mapKind', onchange: (e) => { M.ui.map = e.target.value; drawMap(); } }, [['limb', 'limb transmittance'], ['contribution', 'emission contribution']].map(([v, t]) => h('option', { value: v }, t))))),
    h('div', { class: 'plots two' }, h('div', { class: 'card pad6' }, h('canvas', { id: 'cvOp', role: 'img', 'aria-label': 'Extinction by absorber in one layer' })), h('div', { class: 'card pad6' }, h('canvas', { id: 'cvMap', role: 'img', 'aria-label': 'Map over wavelength and pressure' }))),
    h('details', { class: 'card how', ontoggle: () => drawColour() }, h('summary', {}, 'How this is computed, and from what'),
      h('p', {}, h('b', {}, 'The 3D view as it is set now. '), h('span', { id: 'cap3d' })),
      h('p', {}, 'The atmosphere is a stack of layers uniform in log pressure, each at one temperature, in hydrostatic balance under gravity that falls with the square of the radius. Mixing ratios are constant with height; hydrogen and helium fill the rest. Molecular opacity comes from k-tables (correlated-k), mixed by random overlap; hydrogen collision-induced absorption, Rayleigh scattering, an optional grey cloud deck and a power-law haze are added.'),
      h('p', {}, h('b', {}, 'From spectrum to colour. '), 'The planet view shows what an eye would see. Left axis, shaded: the eye\'s three responses over wavelength, the colour-matching functions x̄, ȳ and z̄ of the CIE 1931 standard observer (roughly red, green and blue; ȳ is also brightness). Right axis: the light, as energy per unit wavelength (the quantity the standard is defined on). The planet\'s light is what it reflects (the star\'s light at the planet\'s distance times the estimated albedo) plus its own thermal glow (the day side\'s emission); the three planet curves share one scale, the largest value of their sum being 1, so their sizes can be compared. The star\'s spectrum is drawn on its own scale (it is brighter by many orders of magnitude): in these units a Sun-like star peaks near 0.5 µm, though counted in photons or per unit frequency its peak lies in the near infrared. Each response curve is multiplied by the planet\'s total and summed over wavelength, giving X, Y and Z; a fixed 3 × 3 matrix turns those into the red, green and blue of a screen (sRGB), scaled to the brightest channel. Where the total sits under a shaded curve, that channel receives light.'),
      h('div', { class: 'card pad6', style: 'margin:8px 0' }, h('canvas', { id: 'cvCmf', role: 'img', 'aria-label': 'Colour-matching functions (left axis) and the star\'s and the planet\'s light (right axis)' })),
      h('p', {}, h('b', {}, 'What makes that light. '), 'Below, for the same wavelengths: how strongly each constituent removes light at the level where the atmosphere becomes opaque to visible light seen from above (optical depth 1 at 0.55 µm), which is where the reflected light comes from. Rayleigh scattering by the gas, haze and particles scatter: they are what reflects. The gases (sodium and potassium at these temperatures, TiO and VO in the hottest planets, water in the red) and H− absorb: they are what darkens the planet, and, being absorbers, also what emits its thermal glow there. Change the composition or the clouds and both figures follow. Point at a curve to pick it out.'),
      h('div', { class: 'card pad6', style: 'margin:8px 0' }, h('canvas', { id: 'cvVis', role: 'img', 'aria-label': 'Scattering and absorption by constituent across the visible, at the level the reflected light comes from' })),
      h('div', { class: 'status', id: 'stVis' }),
      h('p', {}, 'Transmission: one ray per level through the spherical shells, the absorbing area summed over impact parameter; no refraction. Emission: the formal solution through isothermal layers at 8 angles, without scattering, over a blackbody star. The reflected colour of the day side is a two-stream estimate for display only.'),
      h('p', {}, 'Checked against adaptive quadrature and against petitRADTRANS 3.4.0; the numbers and what was not compared are on the Methods page, Validation tab (Atmosphere).'),
      h('div', { id: 'srcTable' })))));

// profile fields, rebuilt when the kind changes
const TP_FIELDS = {
  guillot: [['Equilibrium T (K)', 'teq', { min: 50 }], ['Internal T (K)', 'tint', { min: 0 }], ['IR opacity (m²/kg)', 'kappaIR', { min: 1e-6 }], ['Visible / IR opacity', 'gamma', { min: 0.01 }]],
  consistent: [['Equilibrium T (K)', 'teq', { min: 50 }], ['Internal T (K)', 'tint', { min: 0 }], ['Heat spread f (¼ whole planet, ½ day side)', 'f', { min: 0.1, max: 1, step: 0.05 }]],
  table: [],
  isothermal: [['Temperature (K)', 't', { min: 50 }]],
  ms09: [['T at the top (K)', 't0', { min: 50 }], ['α1 (K^-½)', 'a1', { min: 0.02 }], ['α2 (K^-½)', 'a2', { min: 0.02 }], ['P1 (bar)', 'p1', { min: 1e-8 }], ['P2 (bar)', 'p2', { min: 1e-8 }], ['P3 (bar)', 'p3', { min: 1e-6 }]],
};
function buildTp() {
  const host = $('tpFields'); host.innerHTML = '';
  for (const [label, key, attrs] of TP_FIELDS[M.model.tp.kind]) host.append(h('label', {}, label, h('input', { type: 'number', id: 'tp_' + key, value: M.model.tp[key], step: 'any', ...attrs, onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { M.model.tp[key] = v; run(); } } })));
  setStatus('stTp', M.model.tp.kind === 'table' ? 'Temperatures at fixed pressures, as measured or adopted for this world. Choose another kind to change them.' : M.model.tp.kind === 'consistent' ? 'The profile is worked out from the gases themselves: how much starlight they absorb at each level, how well they hold heat in, and the planet\'s energy budget. It takes a few seconds, and answers to the composition, the clouds and the star. Where the gas absorbs starlight better than it holds heat (TiO and VO in the hottest planets) it comes out inverted.' : M.model.tp.kind === 'ms09' ? 'P2 above P1 (lower pressure) gives no inversion; P2 below P1 gives one.' : M.model.tp.kind === 'guillot' ? 'Averaged over the whole planet (f = 1/4).' : '');
}
$('tpKind').addEventListener('change', (e) => { if (e.target.value === 'table' && !M.model.tp.p) { e.target.value = M.model.tp.kind; setStatus('stTp', 'A measured profile comes with a preset world (Jupiter, Titan): choose one under "Start from a world".', 'warn'); return; } M.model.tp.kind = e.target.value; buildTp(); run(); });
$('bulk').addEventListener('change', (e) => { M.model.bulk = e.target.value === 'H2He' ? null : e.target.value; run(); });
function buildVmr() {
  const host = $('vmrRows'), cr = $('chemRow'); host.innerHTML = ''; cr.innerHTML = '';
  $('heH2').disabled = M.chem.on || !!M.model.bulk; $('bulk').disabled = M.chem.on;   // the chemistry table is a hydrogen-helium gas of its own
  if (M.chem.on) {
    const lin = (label, id, value, attrs, set) => h('label', {}, label, h('input', { type: 'number', id, value, step: 'any', ...attrs, onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { set(v); run(); } } }));
    cr.append(logSlider('metals × Sun', 'chemMh', 10 ** M.chem.mh, 0.1, 300, (v) => { M.chem.mh = Math.log10(v); run(); }),
      h('div', { class: 'grid2' }, lin('C/O (Sun: 0.59)', 'chemCo', M.chem.co, { min: 0.1, max: 1.5, step: 0.05 }, (v) => { M.chem.co = Math.min(1.5, Math.max(0.1, v)); }),
        h('label', { class: 'chk', style: 'align-self:end' }, h('input', { type: 'checkbox', id: 'quenchOn', checked: M.chem.quenchOn, onchange: (e) => { M.chem.quenchOn = e.target.checked; buildVmr(); run(); } }), 'Quench (mixing)')),
      M.chem.quenchOn ? logSlider('below (bar)', 'chemQ', M.chem.quench, 1e-4, 100, (v) => { M.chem.quench = v; run(); }) : '',
      h('div', { class: 'status' }, `Every gas follows from the temperature, the pressure and these two numbers${M.feh != null ? ` (the star's own metals are ${(10 ** M.feh).toFixed(2)} × the Sun's)` : ''}. Gas phase only: tick "Condense and rain out" below to take TiO, VO, Na, K, water and ammonia out where it is cool. Tick the gases whose absorption to include; the values are at 10 mbar.`));
    for (const s of SPECIES) {
      const cb = h('input', { type: 'checkbox', checked: !M.off[s], 'aria-label': s + ' on or off', onchange: (e) => { M.off[s] = !e.target.checked; M.failed.delete(s); run(); } });
      host.append(h('div', { class: 'sl' }, h('span', { class: 'sw' }, cb, h('span', { class: 'dot', style: 'background:' + SPECIES_COLOURS[s] }), s), h('span', {}), h('span', { id: 'eq_' + s, style: 'text-align:right;font-variant-numeric:tabular-nums' }, '…')));
    }
    return;
  }
  const have = M.index ? new Set(M.index.tables.map((t) => t.species)) : null;
  for (const s of SPECIES) {
    if (have && !have.has(s)) { M.off[s] = true; continue; }   // no table for it in this build
    const cb = h('input', { type: 'checkbox', checked: !M.off[s], 'aria-label': s + ' on or off', onchange: (e) => { M.off[s] = !e.target.checked; M.failed.delete(s); run(); } });
    host.append(logSlider(s, 'vmr_' + s, M.model.vmr[s] ?? 1e-6, 1e-10, 1e-1, (v) => { M.model.vmr[s] = v; run(); }, { dot: SPECIES_COLOURS[s], toggle: cb }));
  }
}
function buildCloud() {
  const m = M.model, c = $('cloudRow'), z = $('hazeRow'), pr = $('partRow'), ry = $('rayRow'), cv = $('coverRow');
  for (const e of [c, z, pr, ry, cv]) e.innerHTML = '';
  $('cloudOn').checked = m.cloudTop != null; $('hazeOn').checked = !!m.haze; $('partOn').checked = !!m.cloud; $('rayOn').checked = !!m.rayleigh;
  const lin = (label, id, value, attrs, set) => h('label', {}, label, h('input', { type: 'number', id, value, step: 'any', ...attrs, onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) { set(v); run(); } } }));
  if (m.cloudTop != null) c.append(logSlider('top (bar)', 'cloudTop', m.cloudTop, 1e-5, 10, (v) => { m.cloudTop = v; run(); }));
  if (m.cloud) pr.append(
    logSlider('top (bar)', 'partTop', m.cloud.top, 1e-7, 10, (v) => { m.cloud.top = v; run(); }),
    logSlider('base (bar)', 'partBase', m.cloud.base, 1e-6, 100, (v) => { m.cloud.base = v; run(); }),
    logSlider('grain (µm)', 'partR', m.cloud.radius, 1e-3, 30, (v) => { m.cloud.radius = v; run(); }),
    logSlider('τ at 1 µm', 'partTau', m.cloud.tau, 1e-4, 100, (v) => { m.cloud.tau = v; run(); }),
    h('div', { class: 'grid2' },
      h('label', {}, 'Made of', h('select', { id: 'partMat', onchange: (e) => { m.cloud.material = e.target.value || null; buildCloud(); run(); } }, [['', 'generic grains'], ['tholin', 'tholin (Titan\'s haze)']].map(([v, t]) => h('option', { value: v, selected: (m.cloud.material || '') === v }, t)))),
      lin('Spread with height (τ ∝ P^x)', 'partPow', m.cloud.power ?? 1, { min: 0.1, max: 3, step: 0.05 }, (v) => { m.cloud.power = Math.min(3, Math.max(0.1, v)); }),
      m.cloud.material ? null : lin('Q0 (10 silicates, 65 ices)', 'partQ0', m.cloud.q0 ?? 10, { min: 1, max: 200 }, (v) => { m.cloud.q0 = Math.max(1, v); }),
      m.cloud.material ? null : lin('Scattering share (albedo)', 'partW', m.cloud.albedo ?? 1, { min: 0, max: 1, step: 0.05 }, (v) => { m.cloud.albedo = Math.min(1, Math.max(0, v)); }),
      M.cond.on ? h('label', { class: 'full' }, 'Place it at the base of', h('select', { id: 'partFollow', onchange: (e) => { m.cloud.follow = e.target.value || null; run(); } }, [['', 'the pressures above'], ...Object.entries(CONDENSATES).map(([k, c]) => [k, `the ${c.label} cloud (${k})`])].map(([v, t]) => h('option', { value: v, selected: (m.cloud.follow || '') === v }, t)))) : null),
    h('p', { class: 'note' }, m.cloud.material ? 'Wavelength dependence and absorption from Mie theory for spheres of this material (Khare et al. 1984 for tholin). x below 1 puts relatively more haze high up, as on Titan.' : 'x = 1 is a constant mixing ratio of grains between top and base; below 1 there are relatively more of them high up.'));
  if (m.haze) z.append(logSlider('× H2 at 0.35 µm', 'hazeF', m.haze.factor, 1, 1e6, (v) => { m.haze.factor = v; run(); }), h('div', { class: 'grid2' }, lin('Slope (power of λ)', 'hazeS', m.haze.slope, { step: 0.5, min: -12, max: 0 }, (v) => { m.haze.slope = v; })));
  if (m.rayleigh) ry.append(logSlider('strength ×', 'rayF', m.rayleighFactor || 1, 1, 1e5, (v) => { m.rayleighFactor = v; buildCover(); run(); }));
  buildCover();
}
function buildCover() {
  const m = M.model, cv = $('coverRow'), any = m.cloudTop != null || m.haze || m.cloud || (m.rayleighFactor || 1) > 1; cv.innerHTML = '';
  if (any) cv.append(h('label', { style: 'margin-top:6px' }, 'Share of the planet covered (0 to 1)', h('input', { type: 'number', id: 'cover', value: m.cloudFraction ?? 1, min: 0, max: 1, step: 0.05, onchange: (e) => { m.cloudFraction = Math.min(1, Math.max(0, Number(e.target.value))); run(); } })));
  $('stAero').textContent = any ? 'Everything ticked here is the covered share; the rest of the planet is clear gas.' : '';
}
$('aeroPreset').addEventListener('change', (e) => { Object.assign(M.model, structuredClone(AEROSOLS[e.target.value])); buildCloud(); run(); });
$('cloudOn').addEventListener('change', (e) => { M.model.cloudTop = e.target.checked ? 1e-2 : null; buildCloud(); run(); });
$('partOn').addEventListener('change', (e) => { M.model.cloud = e.target.checked ? { top: 1e-4, base: 1e-2, tau: 1, radius: 0.1, q0: 10, albedo: 1 } : null; buildCloud(); run(); });
$('hazeOn').addEventListener('change', (e) => { M.model.haze = e.target.checked ? { factor: 100, slope: -4 } : null; buildCloud(); run(); });
$('rayOn').addEventListener('change', (e) => { M.model.rayleigh = e.target.checked; buildCloud(); run(); });
for (const [id, set] of [['escAge', (v) => { M.esc.age = v; }], ['mplanet', (v) => { M.model.planet.mplanet = v; }], ['rplanet', (v) => { M.model.planet.rplanet = v; }], ['rstar', (v) => { M.model.star.rstar = v; }], ['teff', (v) => { M.model.star.teff = v; }], ['ars', (v) => { M.ars = v; }], ['pRef', (v) => { M.model.planet.pRef = v; }], ['heH2', (v) => { M.model.heH2 = v; }], ['pTop', (v) => { M.model.pTop = v; }]])
  $(id).addEventListener('change', (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0 || (id === 'heH2' && v === 0)) { set(v); run(); } });
$('nLayers').addEventListener('change', (e) => { M.model.nLayers = Number(e.target.value); run(); });
watchCurves('cvVmr', drawProfiles); watchCurves('cvOp', drawOpacity); watchCurves('cvSpec', drawSpectrum); watchCurves('cvVis', drawVisible);
$('layerHost').append(logSlider('layer (bar)', 'layerP', M.ui.layerP, 1e-8, 100, (v) => { M.ui.layerP = v; if (M.result && !M.busy) worker.postMessage({ type: 'opacity', id: M.seq, layer: layerIndex() }); else run(); }));
$('wlHost').append(logSlider('wavelength (µm)', 'viewWl', M.ui.viewWl, 0.3, 30, (v) => { M.ui.viewWl = v; update3d(); drawProfiles(); }));
function setMap(v) { M.ui.map = v; $('mapKind').value = v; }

// ------------------------------------------------------------------------------------------------- catalogue
let catIndex = null;
const fetchCat = (name) => siteJson(new URL('catalog/' + name, siteRoot()), `The catalogue (catalog/${name})`);
async function catalogue() { if (!catIndex) catIndex = await loadIndex(fetchCat); return catIndex; }
async function suggest() {
  const q = $('inPlanet').value; if (q.length < 2) return;
  try { const idx = await catalogue(), dl = $('plNames'); dl.innerHTML = ''; for (const s of searchNames(idx, q, 10)) if (s.type === 'planet') dl.append(h('option', { value: s.label })); } catch { /* no suggestions without the catalogue */ }
}
async function lookup(name) {
  M.fit = null;   // the points of a fitted spectrum belong to the planet they were measured on
  setStatus('stSys', 'Looking up ' + name + ' …');
  try {
    const idx = await catalogue(), L = await lookupHost(idx, name, fetchCat);
    if (!L) throw new Error(`“${name}” is not in the catalogue.`);
    const S = systemFromRows(L.rows), pl = S.planets.find((p) => p && p.planet === L.planet) || S.planets.find(Boolean);
    if (!pl) throw new Error('No usable parameter set for ' + name + '.');
    const v = (k) => (pl.values[k] && Number.isFinite(pl.values[k].value) ? pl.values[k].value : undefined);
    const rstar = v('rstar'), teff = v('teff'), rprs = v('rprs'), ars = v('ars'), mp = v('mplanet');
    const missing = [['the star\'s radius', rstar], ['the star\'s temperature', teff], ['the radius ratio', rprs], ['the planet\'s mass', mp]].filter((x) => !(x[1] > 0)).map((x) => x[0]);
    if (missing.length) throw new Error(`${pl.planet}: the catalogue has no ${missing.join(', ')}. Fill the numbers in by hand.`);
    M.name = pl.planet; M.model.planet.mplanet = mp; M.model.planet.rplanet = (rprs * rstar * C.Rsun) / C.Rjup; M.model.star = { rstar, teff }; if (v('mstar') > 0) M.mstar = v('mstar'); M.feh = Number.isFinite(v('feh')) ? v('feh') : null;
    if (ars > 0) { M.ars = ars; const teq = teff * Math.sqrt(1 / (2 * ars)); M.model.tp.teq = Math.round(teq); M.model.tp.t = Math.round(teq); }
    for (const [id, val] of [['mplanet', mp], ['rplanet', M.model.planet.rplanet.toFixed(4)], ['rstar', rstar], ['teff', teff], ['ars', M.ars]]) $(id).value = val;
    $('inPlanet').value = pl.planet; buildTp(); run();
    const src = [...new Set(['rprs', 'mplanet', 'teff'].map((k) => pl.values[k] && pl.values[k].source).filter(Boolean))].join('; ');
    setStatus('stSys', `${pl.planet}: ${src} (catalogue snapshot ${L.snapshot || idx.date}). The profile's temperature was set to the equilibrium temperature, ${M.model.tp.teq} K.`, 'ok');
    return { name: M.name, planet: { ...M.model.planet }, star: { ...M.model.star }, ars: M.ars };
  } catch (err) { setStatus('stSys', err.message, 'err'); throw err; }
}

// ------------------------------------------------------------------------------------------------- drawing
const inRange = () => RANGES[M.ui.range];
function spectrumData() {
  const r = M.result, ecl = M.ui.kind === 'eclipse', y = ecl ? r.fpfs : r.depth;
  return { wl: r.wl, total: y, parts: Object.values(M.parts).map((p) => ({ name: p.name, y: ecl ? p.fpfs : p.depth })), scale: 1e6, range: inRange(),
    ...(M.fit && M.fit.data.some((d) => (d.kind === 'eclipse') === ecl && d.kind !== 'night') ? { data: M.fit.data.filter((d) => (d.kind === 'eclipse') === ecl && d.kind !== 'night').flatMap((d) => d.wl.map((w, i) => ({ wl: w, y: d.y[i], err: d.err[i] }))), dataLabel: M.fit.label } : {}),
    yLabel: ecl ? 'eclipse depth (ppm)' : 'transit depth (ppm)', title: `${M.name}: ${ecl ? 'emission' : 'transmission'}, R = ${M.index ? M.index.R : ''}` };
}
function drawSpectrum() { if (!M.result) return; const { ctx, W, H } = fitCanvas($('cvSpec'), 300); M.pick.cvSpec = renderModelSpectrum(ctx, W, H, { ...spectrumData(), highlight: M.ui.hl.cvSpec }, ATM_THEME).pick; }
/** Index of the table's bin that holds a wavelength. */
function wlIndex(w) { const wl = M.result.wl; let i = 0; while (i < wl.length - 1 && wl[i] < w) i++; return i; }
function drawProfiles() {
  const r = M.result; if (!r) return; const a = r.atm, n = a.n, p = Array.from(a.pLay, (v) => v / 1e5), i = wlIndex(M.ui.viewWl);
  // where the spectrum at the chosen wavelength forms: the emission contribution, or the slope of the limb transmittance
  const w = new Float64Array(n);
  if (M.ui.kind === 'eclipse') for (let j = 0; j < n; j++) w[j] = r.contribution[i * (n + 1) + j];
  else for (let j = 0; j < n; j++) w[j] = Math.max(0, r.trans[i * (n + 1) + j] - r.trans[i * (n + 1) + j + 1]);
  let c = fitCanvas($('cvTp'), 280);
  renderProfile(c.ctx, c.W, c.H, { p, t: Array.from(a.tLay), title: 'Temperature', label: r.day && r.night ? 'limb' : 'T(P)', extra: r.day && r.night ? [{ t: Array.from(r.day.tLay), colour: '#ff9d5c', label: 'day' }, { t: Array.from(r.night.tLay), colour: '#7fa8ff', label: 'night' }] : [], weight: w, weightLabel: `${M.ui.kind === 'eclipse' ? 'emission' : 'limb'} at ${M.ui.viewWl.toPrecision(3)} µm`, marks: M.model.cloudTop != null ? [{ p: M.model.cloudTop, label: 'cloud top' }] : [] }, ATM_THEME);
  c = fitCanvas($('cvVmr'), 280);
  const ions = [], io = a.ionization || {};
  for (const k of ['Na', 'K', 'H']) if (io[k] && a.species[k]) ions.push({ name: k + '+', x: Float64Array.from(a.species[k], (v, q) => (io[k].neutral[q] > 0 ? (v * io[k].ion[q]) / io[k].neutral[q] : 0)) });
  M.pick.cvVmr = renderMixing(c.ctx, c.W, c.H, { p, species: [...Object.entries(a.species).map(([name, x]) => ({ name, x })), ...ions], title: 'Composition', highlight: M.ui.hl.cvVmr }, ATM_THEME).pick;
}
function drawOpacity() {
  const r = M.result; if (!r) return; const o = r.opacity, a = r.atm, H = (K_B * o.t) / (a.mu[o.layer] * M_U * a.g[o.layer]);
  const { ctx, W, H: hh } = fitCanvas($('cvOp'), 280), [x0, x1] = inRange(), keep = []; for (let i = 0; i < o.wl.length; i++) if (o.wl[i] >= x0 && o.wl[i] <= x1) keep.push(i);
  const pick = (y) => keep.map((i) => y[i]);
  M.pick.cvOp = renderOpacity(ctx, W, hh, { wl: pick(o.wl), parts: o.parts.map((p) => ({ name: p.name, y: pick(p.y) })), total: pick(o.total), scale: H, yRange: [1e-6, 1e8], mark: 1, yLabel: 'optical depth per scale height', title: `${o.p.toExponential(1)} bar, ${o.t.toFixed(0)} K`, highlight: M.ui.hl.cvOp }, ATM_THEME).pick;
}
function drawMap() {
  const r = M.result; if (!r) return; const a = r.atm, n = a.n, [x0, x1] = inRange(), keep = []; for (let i = 0; i < r.wl.length; i++) if (r.wl[i] >= x0 && r.wl[i] <= x1) keep.push(i);
  const limb = M.ui.map === 'limb', nP = limb ? n + 1 : n, p = limb ? Array.from(a.pLev, (v) => v / 1e5) : Array.from(a.pLay, (v) => v / 1e5), z = new Float32Array(keep.length * nP), line = [];
  keep.forEach((i, q) => {
    for (let k = 0; k < nP; k++) z[q * nP + k] = limb ? r.trans[i * (n + 1) + k] : r.contribution[i * (n + 1) + k];
    if (limb) { const lv = opaqueLevel(r.trans, i, n); line.push(Number.isFinite(lv) ? Math.exp(Math.log(p[Math.floor(lv)]) + (lv - Math.floor(lv)) * Math.log(p[Math.min(n, Math.floor(lv) + 1)] / p[Math.floor(lv)])) : NaN); }
    else { let best = 0; for (let k = 1; k < n; k++) if (z[q * nP + k] > z[q * nP + best]) best = k; line.push(p[best]); }
  });
  const { ctx, W, H } = fitCanvas($('cvMap'), 280);
  renderMap(ctx, W, H, { wl: keep.map((i) => r.wl[i]), p, z, lo: 0, hi: limb ? 1 : undefined, title: limb ? 'Transmittance of the limb' : 'Where the emission comes from', label: limb ? 'transmittance' : 'share of the flux per layer', line, lineLabel: limb ? 'half the light passes' : 'peak' }, ATM_THEME);
}
function drawAll() { drawSpectrum(); drawProfiles(); drawOpacity(); drawMap(); drawColour(); }
/** The spectra the true-colour view is made from, and the three response curves they are weighed with. */
function colourData() {
  const r = M.result, nm = [], cmf = { x: [], y: [], z: [] }; for (let v = 380; v <= 750; v += 2) { nm.push(v); cmf.x.push(cmfX(v)); cmf.y.push(cmfY(v)); cmf.z.push(cmfZ(v)); }
  const at = (y, v) => { const w = v / 1e3, wl = r.wl; let i = 0; while (i < wl.length - 2 && wl[i + 1] < w) i++; const f = Math.max(0, Math.min(1, (w - wl[i]) / (wl[i + 1] - wl[i]))); return y[i] + f * (y[i + 1] - y[i]); };
  // the star as the model has it: the PHOENIX spectrum when loaded (the one the eclipse depths use), else a blackbody
  // the star as the model has it: the PHOENIX spectrum when loaded (the one the eclipse depths use), else a blackbody.
  // Everything per unit wavelength and per unit area of the planet's disc, so that the three planet curves share a scale:
  //   star       the star's surface flux
  //   reflected  the estimated geometric albedo x the star's flux at the planet, (R* / a)^2 of its surface flux
  //   thermal    the planet's own emission (the day side's)
  const star = r.starFlux ? nm.map((v) => at(r.starFlux, v)) : nm.map((v) => Math.PI * planckSI(v / 1e3, M.model.star.teff));
  const reflected = nm.map((v, k) => (at(r.albedo, v) * star[k]) / (M.ars * M.ars)), thermal = r.flux ? nm.map((v) => Math.max(0, at(r.flux, v))) : nm.map(() => 0), total = reflected.map((v, k) => v + thermal[k]);
  // for the download: the same curves by name, and the colours they give
  const css = (y) => { const c = spectrumColour({ nm, f: y }).srgb; return `rgb(${c.map((u) => Math.round(255 * u)).join(',')})`; }, any = (y) => y.some((v) => v > 0);
  const curves = [{ name: 'star surface flux', y: star }, { name: 'planet reflected', y: reflected }, { name: 'planet thermal', y: thermal }, { name: 'planet total', y: total }];
  return { nm, cmf, star, reflected, thermal, total, curves, swatches: [{ label: 'star', rgb: css(star) }, ...(any(total) ? [{ label: 'planet', rgb: css(total) }] : [])], title: 'From spectrum to colour' };
}
/** What scatters and what absorbs in the visible, at the level the reflected light comes from (the worker picks the level). */
function drawVisible() {
  const cv = $('cvVis'), r = M.result; if (!r || !r.visOpacity || !cv || !cv.offsetParent) return;
  const o = r.visOpacity, a = r.atm, Hs = (K_B * o.t) / (a.mu[o.layer] * M_U * a.g[o.layer]), keep = []; for (let i = 0; i < o.wl.length; i++) if (o.wl[i] >= 0.375 && o.wl[i] <= 0.755) keep.push(i);   // the colour figure's range
  const pick = (y) => keep.map((i) => y[i]), { ctx, W, H } = fitCanvas(cv, 280);
  M.pick.cvVis = renderOpacity(ctx, W, H, { wl: pick(o.wl).map((w) => 1e3 * w), xRange: [380, 750], xLinear: true, xLabel: 'wavelength (nm)', mR: 62, parts: o.parts.map((x) => ({ name: x.name, y: pick(x.y) })), total: pick(o.total), scale: Hs, yRange: [1e-6, 1e8], mark: 1, yLabel: 'optical depth per scale height', title: `What scatters and absorbs at ${o.p.toExponential(1)} bar`, highlight: M.ui.hl.cvVis }, ATM_THEME).pick;
  // who leads, wavelength by wavelength (a mean over wavelength would be owned by the core of one strong line)
  const sc = ['Rayleigh', 'haze', 'particles'], lead = {}, share = [];
  for (const i of keep) { let best = null, bv = 0, s1 = 0; for (const x of o.parts) { if (x.y[i] > bv) { bv = x.y[i]; best = x.name; } if (sc.includes(x.name)) s1 += x.y[i]; } if (best) lead[best] = (lead[best] || 0) + 1; share.push(o.total[i] > 0 ? s1 / o.total[i] : 0); }
  share.sort((u, v) => u - v); const med = share[share.length >> 1] || 0, rank = Object.entries(lead).sort((u, v) => v[1] - u[1]).slice(0, 5);
  setStatus('stVis', `Between 380 and 750 nm at this level the strongest is ${rank.map(([n, c]) => `${n} over ${(100 * c / keep.length).toFixed(0)}% of the wavelengths`).join(', ')}. At a typical wavelength ${(100 * med).toFixed(med < 0.1 ? 1 : 0)}% of what removes light scatters it (${sc.filter((n) => o.parts.some((x) => x.name === n)).join(', ') || 'nothing here'}); the rest is absorbed. ${med < 0.2 ? 'A dark planet in the visible: little comes back.' : med > 0.6 ? 'A bright planet in the visible: most of the light comes back.' : ''}`);
}
function drawColour() { const cv = $('cvCmf'); if (!M.result || !cv || !cv.offsetParent) return; const { ctx, W, H } = fitCanvas(cv, 280); renderColourResponse(ctx, W, H, colourData(), ATM_THEME); drawVisible(); }
/** Pointer over a plot of named curves: the curve (or legend entry) under it is picked out, the others dimmed. A tap does the same and a tap elsewhere clears it. */
function watchCurves(id, redraw) {
  const cv = $(id), at = (e) => { const b = cv.getBoundingClientRect(), f = M.pick[id]; return f ? f(e.clientX - b.left, e.clientY - b.top) : null; };
  const set = (name) => { if (M.ui.hl[id] === name) return; M.ui.hl[id] = name; cv.style.cursor = name ? 'pointer' : ''; redraw(); };
  cv.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && !M.ui.pin[id]) set(at(e)); });
  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !M.ui.pin[id]) set(null); });
  cv.addEventListener('click', (e) => { const name = at(e); M.ui.pin[id] = name && M.ui.pin[id] !== name ? name : null; M.ui.hl[id] = null; set(M.ui.pin[id]); });   // a tap or click holds the choice; again, or elsewhere, lets go
}

function afterResult() {
  const r = M.result, a = r.atm, top = Math.max(...Array.from(r.topTau).filter((_, i) => r.wl[i] >= inRange()[0] && r.wl[i] <= inRange()[1]));
  const H = (K_B * a.tLay[Math.floor(a.n / 2)]) / (a.mu[0] * M_U * a.gRef), perH = (2 * H * a.r0) / (M.model.star.rstar * C.Rsun) ** 2;
  setStatus('stRun', `${r.wl.length} bins in ${r.ms.toFixed(0)} ms. One scale height is ${(H / 1e3).toFixed(0)} km, ${(perH * 1e6).toFixed(0)} ppm of transit depth.${M.failed.size ? ' Not loaded, so left out: ' + [...M.failed].join(', ') + (M.failed.has('H2-H2') || M.failed.has('H2-He') ? ' (collision-induced absorption: reload the page to try again).' : '.') : ''}`, M.failed.size ? 'warn' : 'ok');
  if (M.fit) { const f = M.fit.result; $('stRun').textContent += ` Points: ${M.fit.label}, ${f.ndata} values. ${f.converged ? `The model was set to the fit of ${f.keys.join(', ')} (χ² ${f.chi2.toFixed(0)}, ${f.ncalls} models); it has since been changed if you moved a control.` : 'The fit stopped before it converged: the model was not changed.'}`; }
  updateChemText();
  setStatus('stStar', M.ui.starKind === 'blackbody' ? '' : !r.starModel ? 'The stellar spectra are not loaded: a blackbody is used.' : r.starClamped.length ? `Outside the grid of model stars (2300 to 8000 K, log g 4 to 5.5, [Fe/H] −0.5 to +0.5): the nearest model is used for ${r.starClamped.join(', ').replace('teff', 'the temperature').replace('logg', 'gravity').replace('feh', 'metallicity')}.` : '', r.starModel || M.ui.starKind === 'blackbody' ? '' : 'warn');
  if (r.climate && M.model.tp.kind === 'consistent') {
    const c = r.climate;
    setStatus('stTp', `Worked out from the gases in ${c.iterations} passes${c.converged ? '' : ' (not settled: last change ' + c.change.toFixed(0) + ' K)'}. The planet emits ${(100 * c.balance).toFixed(0)}% of the energy it takes in${Math.abs(c.balance - 1) > 0.05 ? ' (out of balance: the simple closure does not hold for this atmosphere, usually a strong temperature inversion)' : ''}. At 1 bar ${(100 * c.absorbed1bar).toFixed(0)}% of the starlight has been absorbed; heat is held ${c.gamma1bar < 1 ? (1 / c.gamma1bar).toFixed(1) + ' times more strongly than starlight is absorbed' : 'less strongly than starlight is absorbed (an inversion)'}.${c.convectiveTop ? ` Convective below ${c.convectiveTop.toExponential(1)} bar.` : ''} A grey-shaped solution with the model's own opacities, not full radiative-convective equilibrium.`, c.converged && Math.abs(c.balance - 1) <= 0.05 ? '' : 'warn');
  }
  setStatus('stMu', `Mean molecular weight ${a.mu[a.n - 1].toFixed(3)}; gravity ${a.gRef.toFixed(2)} m/s² at the reference radius.${M.chem.on && M.model.bulk ? ' Chemical equilibrium is a hydrogen-helium gas: the bulk gas chosen is not used.' : ''}`);
  const cd = a.condensation, bar = (v) => (v >= 0.01 ? v.toPrecision(2) : v.toExponential(1)) + ' bar';
  setStatus('stCond', !M.cond.on ? 'Off: every gas stays in the gas, however cold it is.' : !cd || !cd.clouds.length ? 'Nothing condenses anywhere in this atmosphere.'
    : 'Clouds form: ' + cd.clouds.map((c) => `${c.label} ${c.deep ? 'below the model' : 'from ' + bar(c.base)}`).join(', ') + '. ' + (Object.keys(cd.kept).length ? 'Left in the gas at the top: ' + Object.entries(cd.kept).map(([g, k]) => `${g} × ${k[0] >= 0.01 ? k[0].toFixed(2) : k[0].toExponential(0)}`).join(', ') + '. ' : '') + 'Rained-out material does not come back up; the solids named are where a cloud would sit, not a cloud that is drawn (use the particle layer for that).');
  const el = $('stTop'); el.textContent = top > 0.05 ? `The top level is not transparent in the strongest bands (optical depth up to ${top.toFixed(2)} along the highest ray): the depth there depends on where the atmosphere is cut off. Lower the top pressure.` : `The top level is transparent (optical depth at most ${top.toFixed(3)} along the highest ray).`;
  el.className = 'status' + (top > 0.05 ? ' warn' : '');
  drawAll(); update3d();
}

/** Replace the model by a preset world (src/core/worlds.js) and bring every control into line with it. */
function applyWorld(name) {
  M.fit = null;   // the points of a fitted spectrum belong to the planet they were measured on
  const w = WORLDS[name]; if (!w) return;
  const keep = { teq: Math.round(w.model.star.teff * Math.sqrt(1 / (2 * w.ars))), tint: 100, kappaIR: 1e-3, gamma: 0.4, f: 0.25, t: 0, t0: 900, a1: 0.6, a2: 0.5, p1: 1e-3, p2: 1e-2, p3: 1 }; keep.t = keep.teq;
  M.name = name; M.model = structuredClone(w.model); M.model.tp = { ...keep, ...M.model.tp }; M.ars = w.ars;
  M.chem.on = !!w.chem; M.chem.mh = w.model.chemistry ? w.model.chemistry.mh ?? 0 : 0; M.ion = false; M.nightDT = 0;
  const cd = w.model.condensation; M.cond = { on: !!cd, humidity: cd ? cd.humidity ?? 1 : 1, only: cd ? cd.only || null : null }; M.model.condensation = null; M.model.chemistry = null;
  if (M.model.cloud) M.model.cloud = { top: 1e-4, base: 1e-2, q0: 10, albedo: 1, ...M.model.cloud };   // a layer that follows a condensate still has pressures to fall back on
  M.off = {}; for (const s of SPECIES) { const on = w.chem ? w.tables.includes(s) : s in M.model.vmr; if (!(s in M.model.vmr)) M.model.vmr[s] = EXTRA[s] ?? DEFAULT_MODEL.vmr[s] ?? 1e-6; if (!on) M.off[s] = true; }
  for (const [id, val] of [['mplanet', M.model.planet.mplanet.toPrecision(4)], ['rplanet', M.model.planet.rplanet.toPrecision(4)], ['rstar', M.model.star.rstar], ['teff', M.model.star.teff], ['ars', M.ars], ['pRef', M.model.planet.pRef], ['pTop', M.model.pTop], ['nLayers', M.model.nLayers], ['heH2', M.model.heH2], ['tpKind', M.model.tp.kind], ['chemMode', M.chem.on ? 'eq' : 'free'], ['bulk', M.model.bulk || 'H2He'], ['condHum', M.cond.humidity], ['nightDT', 0], ['inPlanet', name]]) { const el = $(id); if (el) el.value = val; }
  $('condOn').checked = M.cond.on; $('ionOn').checked = false;
  setStatus('stWorld', w.about); buildTp(); buildVmr(); buildCloud(); run();
}

// ------------------------------------------------------------------------------------------------- 3D
let view = null;
const rampBytes = (u) => ramp(u).map((v) => Math.round(v));
function updateChemText() {
  const r = M.result; if (!r) return;
  const a = r.atm; let j = 0; while (j < a.n - 1 && a.pLay[j] < 1e3) j++;
  if (M.chem.on) for (const s of SPECIES) { const el = $('eq_' + s); if (el) el.textContent = a.species[s] ? a.species[s][j].toExponential(1) : '–'; }
  const ion = a.ionization, bar = (v) => (v ? v.toExponential(1) + ' bar' : 'no level of the model');
  $('ionOut').textContent = !M.ion ? '' : !ion ? 'Nothing to ionize: switch sodium or potassium on, or use chemical equilibrium (which supplies atomic hydrogen).'
    : `${ion.Na ? `Sodium is half ionized at ${bar(ion.Na.half)}; above that it no longer absorbs in its lines. ` : 'Sodium is switched off. '}${ion.K ? `Potassium at ${bar(ion.K.half)}. ` : ''}${ion.H ? `Atomic hydrogen is half ionized at ${bar(ion.H.half)}. ` : 'Atomic hydrogen comes with chemical equilibrium. '}`
      + `The spectrum only feels this where it forms that high: set the layer slider under "Opacity" above these pressures to see the sodium line drop (it is at ${M.ui.layerP.toExponential(1)} bar). Molecules are not broken up by the light. The star's ultraviolet is a blackbody for sodium and potassium and the Sun's history for hydrogen; potassium's recombination rate is taken as sodium's: the size of the effect, not a measurement.`;
  setStatus('stNight', M.nightDT > 0 && r.day && r.night ? `Day ${r.day.tLay[j].toFixed(0)} K, limb ${a.tLay[j].toFixed(0)} K, night ${r.night.tLay[j].toFixed(0)} K at 10 mbar. Emission is the day side's, transmission the limb's (the mean of the two). The cutaway shows the day side toward the star and the night side away from it.` : '');
}
let starCache = null;
/** The star's limb colours, kept while its temperature is the same (the calculation is five million exponentials). */
function starStrip(teff) { if (!starCache || starCache.teff !== teff) starCache = { teff, rgb: stellarLimbColours(teff, 48).rgb }; return starCache.rgb; }
function update3d() {
  const r = M.result; if (!r || !view) return;
  const a = r.atm, n = a.n, radii = levelRadii(a, 0.45), i = wlIndex(M.ui.viewWl), q = M.ui.quantity;
  $('zoomL').style.display = M.ui.view === 'transit' ? '' : 'none'; $('stretchL').style.display = M.ui.view === 'cutaway' ? 'none' : ''; $('quantL').style.display = M.ui.view === 'cutaway' ? '' : 'none';
  $('planetL').style.display = M.ui.view === 'planet' ? '' : 'none';
  // colours: the star by limb angle, the limb's effect on starlight, the day side
  // which wavelengths make the colours: the visible if the plotted range holds it (or it is asked for), else the
  // chosen range laid over the visible, blue to red
  const band = M.ui.colour === 'auto' ? inRange() : COLOUR_BANDS[M.ui.colour], mapped = M.ui.colour !== 'true' && !(M.ui.colour === 'auto' && band[0] <= 0.42 && band[1] >= 0.68);
  const dw = displayWeights(r.wl, { map: mapped ? { from: band } : null, teff: M.model.star.teff });
  const limb = limbColours(r.wl, r.trans, n, dw), rstar = M.model.star.rstar * C.Rsun;
  const fRefl = (wl) => Math.PI * planckSI(wl, M.model.star.teff) / (M.ars * M.ars);   // starlight reaching the planet, per unit area facing the star
  const vis = []; for (let k = 0; k < r.wl.length; k++) if (r.wl[k] >= 0.36 && r.wl[k] <= 0.83) vis.push(k);
  const spec = (f) => xyzToLinearSRGB(spectrumToXYZ({ nm: vis.map((k) => r.wl[k] * 1000), f: vis.map(f) })).map((c) => Math.max(0, c));
  const refl = spec((k) => r.albedo[k] * fRefl(r.wl[k])), therm = spec((k) => r.flux[k]), starC = spec((k) => fRefl(r.wl[k]));
  const peak = Math.max(...starC) || 1, day = refl.map((c, j) => (c + therm[j]) / peak), night = therm.map((c) => c / peak);
  // the day side is far dimmer than a white surface would be only by its albedo: scale so a perfect reflector is white
  // the quantity of each layer; with a cooler night side, also for the day and the night columns (same colour scale)
  const of = (col) => (q === 'temperature' ? Array.from(col.tLay) : q === 'limb' ? Array.from({ length: n }, (_, j) => 0.5 * (r.trans[i * (n + 1) + j] + r.trans[i * (n + 1) + j + 1])) : q === 'contribution' ? Array.from({ length: n }, (_, j) => r.contribution[i * (n + 1) + j]) : Array.from(col.species[q.slice(4)] || new Float64Array(n), (v) => Math.log10(Math.max(v, 1e-12))));
  const two = r.day && r.night && (q === 'temperature' || q.startsWith('vmr')), values = of(a), vDay = two ? of(r.day) : values, vNight = two ? of(r.night) : values;
  const lo = q === 'limb' ? 0 : Math.min(...values, ...vDay, ...vNight), hi = q === 'limb' ? 1 : Math.max(...values, ...vDay, ...vNight);
  const lv = opaqueLevel(r.trans, i, n);
  const stripOf = (v) => radialStrip(v, radii, (x) => rampBytes(hi > lo ? (x - lo) / (hi - lo) : 0.5), { size: 512, marks: Number.isFinite(lv) ? [lv] : [] });
  const face = stripOf(vDay), faceNight = two ? stripOf(vNight) : null;
  // the cutaway's legend: the colour scale with its ends, what is drawn, and which side is which
  const lg = $('cutLegend'); lg.style.display = M.ui.view === 'cutaway' ? '' : 'none';
  if (M.ui.view === 'cutaway') {
    const stops = Array.from({ length: 11 }, (_, k) => `rgb(${rampBytes(k / 10).join(',')}) ${10 * k}%`).join(', '), sci = (v) => (v >= 0.01 && v < 1e4 ? String(+v.toPrecision(3)) : v.toExponential(1));
    const [name, a0, a1] = q === 'temperature' ? ['Temperature', lo.toFixed(0) + ' K', hi.toFixed(0) + ' K'] : q === 'limb' ? [`Share of starlight passing the limb at ${M.ui.viewWl.toPrecision(3)} µm`, '0 (opaque)', '1 (clear)'] : q === 'contribution' ? [`Share of the emitted light at ${M.ui.viewWl.toPrecision(3)} µm from each layer`, sci(lo), sci(hi)] : [`Mixing ratio of ${q.slice(4)}`, sci(10 ** lo), sci(10 ** hi)];
    lg.innerHTML = ''; lg.append(h('div', { class: 'row' }, h('b', {}, name), h('span', {}, a0), h('span', { class: 'bar', style: `background:linear-gradient(to right, ${stops})` }), h('span', {}, a1)),
      h('div', { class: 'note' }, `The cut runs through the planet's centre; rings are the model's layers from the bottom of the model (centre) to its top (rim), drawn thicker than they are. ${two ? (M.nightDT > 0 ? 'The half toward the star (right, lit) is the day column, the half away from it the night column, blended across the terminator.' : '') : M.nightDT > 0 && (q === 'limb' || q === 'contribution') ? 'This quantity is the same on both sides (the limb\'s transmission, the day side\'s emission).' : 'Day and night are the same here: set "Night side cooler by" above zero to see the two sides differ.'}${Number.isFinite(lv) ? ` The red ring is where half the starlight passes the limb at ${M.ui.viewWl.toPrecision(3)} µm.` : ''}`));
  }
  const inner = radii.real[n];
  view.set({ rprs: a.rLev[0] / rstar, inner, stretch: M.ui.stretch, limb: limbTexture(limb, radii.real, 256), star: starStrip(M.model.star.teff), face, faceNight, day, night });
  // the ray-marched planet: extinction per layer and colour from the limb's transmittance, scattering from the model,
  // the interior's glow and reflectance as ratios to the star
  let kIn = n; for (let k = 1; k <= n; k++) if (Math.max(limb[3 * k], limb[3 * k + 1], limb[3 * k + 2]) < 0.02) { kIn = k; break; }
  const beta = shellExtinction(limb, radii.real), scat = new Float32Array(3 * n);
  for (let j = 0; j < n; j++) { const f = displayFactors(dw, (k) => r.scattering[k * n + j]); for (let c = 0; c < 3; c++) scat[3 * j + c] = f[c] * a.rLev[0]; }
  const sh = shellTextures(beta, scat, radii.real, radii.real[kIn], M.ui.stretch, 64), rp2 = (a.r0 / rstar) ** 2;
  const thermal = displayFactors(dw, (k) => r.fpfs[k] / rp2), surface = displayFactors(dw, (k) => Math.min(1, 1.5 * r.albedo[k]));
  const starR = rstar / (a.rLev[0] * sh.top), irr = Math.PI / (M.ars * M.ars), grain = M.model.cloud && M.model.cloud.radius > 0.3;
  const thermalNight = r.fpfsNight ? displayFactors(dw, (k) => r.fpfsNight[k] / rp2) : null;
  view.set({ shell: sh, starR, starDist: M.ars * starR, thermal, thermalNight, surface, henyey: grain ? 0.6 : 0, exposure: (M.ui.look === 'transit' ? 1.6 : 1.2 / Math.max(Math.max(...thermal), (Math.max(...surface, 0.05) * irr) / Math.PI)) * 2 ** M.ui.ev });   // planet: its brightest part (glow or lit surface) near full scale
  if (!M.looked) { M.looked = true; view.lookFrom(M.ui.look); }
  const css = (c) => `rgb(${c.map((v) => Math.round(255 * srgbEncode(Math.min(1, Math.max(0, v))))).join(',')})`, norm = (c) => { const m = Math.max(...c) || 1; return c.map((v) => v / m); };
  const mid = Number.isFinite(lv) ? Math.round(lv) : Math.floor(n / 2), limbC = [0, 1, 2].map((c) => limb[3 * mid + c]);
  const sw = $('swatches'); sw.innerHTML = '';
  const chip = (c, text) => h('span', {}, h('span', { class: 'chip', style: 'background:' + c }), text);
  const ag = vis.length ? vis.reduce((s, k) => s + r.albedo[k], 0) / vis.length : 0;
  // three things at most: the star, the planet as the eye would see it (reflected starlight and its own glow together),
  // and, with the cutaway, the red ring
  const both = refl.map((c, j) => c + therm[j]);
  sw.append(chip(css(blackbodyColour(M.model.star.teff).linear), `the star (${M.model.star.teff} K)`), chip(css(norm(both.map((c) => c + 1e-30))), 'the planet (starlight it reflects and its own glow, together)'));
  if (M.ui.view === 'cutaway' && Number.isFinite(lv)) sw.append(h('span', {}, h('span', { class: 'chip', style: 'background:none;border:0;border-top:2px dotted rgb(255,64,64);height:0;vertical-align:4px' }), `where half the starlight passes the limb at ${M.ui.viewWl.toPrecision(3)} µm`));
  const thick = 100 * radii.trueFraction;
  const how = mapped ? `Colours: ${band[0]}–${band[1]} µm laid over the visible, ${band[0]} µm blue and ${band[1]} µm red (false colour).` : 'True colour: 0.38–0.75 µm through the eye\'s colour-matching functions.';
  $('cap3d').textContent = M.ui.view === 'planet'
    ? `Each pixel follows a ray through the model's layers: starlight scattered once toward you, dimmed on the way in and out, nothing in the planet's shadow; behind the limb, the star through the atmosphere. ${how} The planet's own glow is ${(100 * Math.max(...thermal)).toPrecision(2)}% of the star's surface brightness in the reddest channel${M.ui.stretch > 1 ? `; atmosphere drawn ${M.ui.stretch} times thicker than it is` : ''}. Exposure is set for the ${M.ui.look === 'transit' ? 'star' : 'planet (the star is overexposed)'}. Drag to turn, scroll to zoom.`
    : M.ui.view === 'transit'
    ? `The planet against its star. The ring is the starlight left after crossing the limb, colour by colour${M.ui.stretch > 1 ? `; drawn ${M.ui.stretch} times thicker than it is` : ' (true scale)'}. Scroll to zoom, drag to turn.`
    : `${two ? 'The right of the cut faces the star: the day side\'s column there, the night side\'s on the left, blended between by the cosine of the angle. ' : ''}Cut through the planet, the atmosphere stretched (it is ${thick.toFixed(1)}% of the radius between ${M.model.pBottom} and ${M.model.pTop.toExponential(0)} bar). Colour: ${$('quantity').selectedOptions[0].textContent}${q === 'limb' || q === 'contribution' ? ` at ${M.ui.viewWl.toPrecision(3)} µm` : ''}, ${q.startsWith('vmr') ? `10^${lo.toFixed(1)} to 10^${hi.toFixed(1)}` : q === 'temperature' ? `${lo.toFixed(0)} to ${hi.toFixed(0)} K` : `${lo.toPrecision(2)} to ${hi.toPrecision(2)}`}, dark to bright. White ring: where half the starlight passes at ${M.ui.viewWl.toPrecision(3)} µm.`;
}
async function start3d() {
  try { const { createView } = await import('./view3d.js'); view = createView($('view3d')); view.setMode(M.ui.view); update3d(); }
  catch (err) { $('err3d').textContent = 'The 3D view needs WebGL, which this browser did not provide (' + ((err && err.message) || err) + '). The plots above are complete without it.'; }
}

// ------------------------------------------------------------------------------------------------- tables, exports
function describeTables() {
  const t = M.index; if (!t) return;
  $('srcTable').append(h('p', {}, `Opacity tables: ${(t.total / 1e6).toFixed(1)} MB in all (each gas is fetched when it is first switched on), resolving power ${t.R}, ${t.ng} g-points, made by tools/opacity/build_opacity.py.`),
    h('table', { class: 'src' }, h('tr', {}, h('th', {}, 'Absorber'), h('th', {}, 'Source'), h('th', {}, 'DOI'), h('th', {}, 'Licence')),
      t.tables.map((x) => h('tr', {}, h('td', {}, x.species), h('td', {}, x.source), h('td', {}, h('a', { href: 'https://doi.org/' + x.doi, rel: 'noopener' }, x.doi)), h('td', {}, x.licence)))),
    h('p', {}, 'The molecular tables are derived from ExoMol data and are shared under the same licence, CC BY-SA 4.0.'));
}
function spectrumRows() {
  const r = M.result; return Array.from(r.wl, (w, i) => ({ wl: w, lo: r.edges ? r.edges[i] : w, hi: r.edges ? r.edges[i + 1] : w, depth: r.depth[i], eclipse: r.fpfs[i], flux: r.flux[i], tb: r.brightness[i] }));
}
/** Everything behind the page's figures as one zip (src/atmosphere/bundle.js). The opacity by absorber is asked of the worker at one level per decade of pressure. */
async function saveBundle() {
  if (!M.result || M.busy) { setStatus('stRun', 'Wait for the model to finish, then download.', 'warn'); return; }
  const a = M.result.atm, layers = [], seen = new Set();
  for (let d = Math.ceil(Math.log10(a.pLay[0] / 1e5) - 1e-9); d <= Math.log10(a.pLay[a.n - 1] / 1e5) + 1e-9; d++) { let j = 0; while (j < a.n - 1 && a.pLay[j] / 1e5 < 10 ** d) j++; if (j > 0 && Math.abs(Math.log(a.pLay[j - 1] / 1e5 / 10 ** d)) < Math.abs(Math.log(a.pLay[j] / 1e5 / 10 ** d))) j--; if (!seen.has(j)) { seen.add(j); layers.push(j); } }
  const decades = await new Promise((res) => { M.bundleWait = res; worker.postMessage({ type: 'decades', id: M.seq, layers }); });
  const files = bundleFiles({ name: M.name, model: modelForRun(), result: M.result, parts: M.parts, decades, index: M.index, colour: colourData(), stamp: new Date(now()).toISOString(), page: location.href.split('?')[0] });
  await saveFile(`${M.name.replace(/[^\w.-]+/g, '_')}_atmosphere_model.zip`, makeZip(files));
  setStatus('stRun', `Saved ${files.length} files: the model, every plotted quantity as CSV, and figures.py, which redraws them.`, 'ok');
}
async function saveCsv() {
  if (!M.result) return;
  const head = `# ${M.name}: model spectrum, Exoplanet Science Lab (Atmosphere page)\n# model: ${JSON.stringify(modelForRun())}\n# opacities: ${M.index.tables.map((t) => t.species).join(', ')}; R = ${M.index.R}, ${M.index.ng} g-points\nwavelength_micron,bin_lo_micron,bin_hi_micron,transit_depth,eclipse_depth,planet_flux_W_m2_micron,brightness_temperature_K\n`;
  await saveFile(`${M.name.replace(/\s+/g, '_')}_model_spectrum.csv`, head + spectrumRows().map((x) => [x.wl.toPrecision(7), x.lo.toPrecision(7), x.hi.toPrecision(7), x.depth.toExponential(6), x.eclipse.toExponential(6), x.flux.toExponential(6), x.tb.toFixed(2)].join(',')).join('\n') + '\n');
}
/** The spectrum figure as it is on screen, redrawn on white at twice the size. */
function figure() { const cv = document.createElement('canvas'); cv.width = 1800; cv.height = 760; const ctx = cv.getContext('2d'); ctx.scale(2, 2); renderModelSpectrum(ctx, 900, 380, spectrumData(), PRINT_THEME); return cv; }
async function savePng() { if (M.result) await saveFile(`${M.name.replace(/\s+/g, '_')}_model_spectrum.png`, await canvasToPNG(figure())); }
function sendToSimulator() {
  if (!M.result) return;
  const r = M.result, keep = []; for (let i = 0; i < r.wl.length; i++) if (r.wl[i] >= 0.3 && r.wl[i] <= 30) keep.push(i);
  try {
    localStorage.setItem('esl.atmosphere.spectrum', JSON.stringify({ name: M.name, made: new Date(now()).toISOString(), wl: keep.map((i) => +r.wl[i].toPrecision(6)), transit: keep.map((i) => +r.depth[i].toPrecision(6)), eclipse: keep.map((i) => +r.fpfs[i].toPrecision(6)) }));
    setStatus('stRun', 'Kept for the simulator: on the Spectroscopy page, tick “Atmosphere model” under Simulate an observation.', 'ok');
  } catch (err) { setStatus('stRun', 'Could not keep the spectrum in this browser: ' + err.message, 'err'); }
}

// ------------------------------------------------------------------------------------------------- start
buildTp(); buildVmr(); buildCloud();
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawAll(); if (view) view.resize(); }, 60); });
window.addEventListener('esl-theme', () => drawAll());
start3d();
loadTables().catch((err) => { M.error = String((err && err.message) || err); setStatus('stRun', 'The opacity tables could not be loaded: ' + M.error, 'err'); });

// for tests and automation (test/atmosphere_check.py)
window.__esl = Object.assign(window.__esl || {}, { atmosphere: {
  ready: () => M.ready && !!M.result && !M.busy, error: () => M.error, state: () => ({ name: M.name, model: modelForRun(), ui: { ...M.ui } }),
  result: () => (M.result ? { n: M.result.wl.length, ms: M.result.ms, depthPpm: [Math.min(...M.result.depth) * 1e6, Math.max(...M.result.depth) * 1e6], eclipsePpm: [Math.min(...M.result.fpfs) * 1e6, Math.max(...M.result.fpfs) * 1e6], parts: Object.keys(M.parts), topTau: Math.max(...M.result.topTau) } : null),
  set(patch) { for (const [k, v] of Object.entries(patch.vmr || {})) { M.model.vmr[k] = v; M.off[k] = false; } for (const k of patch.off || []) M.off[k] = true; for (const k of ['planet', 'star', 'tp']) if (patch[k]) Object.assign(M.model[k], patch[k]); for (const k of ['cloudTop', 'haze', 'cloud', 'cloudFraction', 'rayleighFactor', 'nLayers', 'pTop', 'pBottom', 'heH2', 'rayleigh']) if (k in patch) M.model[k] = patch[k]; if (patch.ui) Object.assign(M.ui, patch.ui);
    for (const [id, val] of [['mplanet', M.model.planet.mplanet], ['rplanet', M.model.planet.rplanet], ['rstar', M.model.star.rstar], ['teff', M.model.star.teff]]) if ($(id)) $(id).value = val;
    buildTp(); buildVmr(); buildCloud(); run(); },
  lookup, view: () => view, spectrum: () => spectrumRows(), figure,
} });

// ------------------------------------------------------------------------------------------------- fit to spectra
// The model on the page fitted to measured spectra (the assistant's atmosphere_fit_spectrum; src/core/retrieval.js in
// the worker). The data are drawn on the spectrum, and the best fit becomes the page's model, so that every figure
// shows it. What the fit ran on is coarser than what the page then draws (30 layers, opacity bins joined to the
// data's resolving power): the two spectra differ by a fraction of the data's errors.
M.fit = null; M.fitJob = null;
/** Where each fitted value goes on the page (the keys of ATM_PARAMS this page can show). */
const FIT_APPLY = {
  teq: (v) => { M.model.tp.teq = v; }, tint: (v) => { M.model.tp.tint = v; }, t: (v) => { M.model.tp.t = v; }, logKappaIR: (v) => { M.model.tp.kappaIR = 10 ** v; }, logGamma: (v) => { M.model.tp.gamma = 10 ** v; },
  mh: (v) => { M.chem.on = true; M.chem.mh = v; }, co: (v) => { M.chem.on = true; M.chem.co = v; }, rplanet: (v) => { M.model.planet.rplanet = v; },
  logCloudTop: (v) => { M.model.cloudTop = 10 ** v; }, cloudFraction: (v) => { M.model.cloudFraction = v; }, logHaze: (v) => { M.model.haze = { slope: -4, ...(M.model.haze || {}), factor: 10 ** v }; }, hazeSlope: (v) => { M.model.haze = { factor: 1, ...(M.model.haze || {}), slope: v }; },
  logRayleigh: (v) => { M.model.rayleighFactor = 10 ** v; }, nightDT: (v) => { M.nightDT = v; },
};
const fitKeyOk = (k) => !!FIT_APPLY[k] || (k.startsWith('logX_') && SPECIES.includes(k.slice(5)));
/** Run a fit. spec: { data: [{ kind, wl, y, err, lo?, hi? }], free, priors, sampler, label }; onProgress(text). Resolves with the result. */
async function fitSpectra(spec, onProgress = () => {}) {
  if (M.fitJob) throw new Error('a fit is already running on this page');
  const bad = spec.free.filter((k) => !fitKeyOk(k)); if (bad.length) throw new Error(`this page cannot fit ${bad.join(', ')} (it can: ${Object.keys(FIT_APPLY).join(', ')}, logX_<gas>)`);
  // a freed gas must be switched on with its table loaded; [M/H] and C/O need the chemistry table
  const gases = spec.free.filter((k) => k.startsWith('logX_')).map((k) => k.slice(5));
  if (gases.length && M.chem.on) throw new Error('the gases are in chemical equilibrium: free mh and co, or set chemistry to "free" first');
  for (const g of gases) { M.off[g] = false; M.failed.delete(g); if (!(M.model.vmr[g] > 0)) M.model.vmr[g] = 1e-6; }
  if (spec.free.some((k) => k === 'mh' || k === 'co')) M.chem.on = true;
  refreshControls(); run();
  // a table that was just asked for must reach the worker before the fit does
  for (let i = 0; i < 600 && (M.loading.size || (M.chem.on && !M.chem.loaded)); i++) await new Promise((res) => setTimeout(res, 200));
  const lost = gases.filter((g) => !M.loaded.has(g)); if (lost.length) throw new Error(`the opacity table of ${lost.join(', ')} could not be loaded`);
  await new Promise((res) => setTimeout(res, 30)); await whenIdle(); if (M.error) throw new Error(M.error);
  const model = modelForRun();
  // the fit runs in a worker of its own (src/retrieval/client.js): the page stays usable, and Stop ends it at once
  fitClient ??= createRetrievalClient({ onStatus: (t) => setStatus('stRun', t) });
  M.fitJob = true; setStatus('stRun', 'Fitting the model to the spectrum …');
  const stopBtn = document.createElement('button'); stopBtn.className = 'btn sm'; stopBtn.id = 'bStopFit'; stopBtn.textContent = 'Stop the fit'; stopBtn.style.marginTop = '6px'; stopBtn.onclick = () => fitClient.stop(); $('stRun').after(stopBtn);
  let result;
  try {
    const out = await fitClient.run({ model, data: spec.data, free: spec.free, priors: spec.priors || null, sampler: spec.sampler, band: 0, species: SPECIES.filter((g) => M.loaded.has(g) && !M.off[g]) },
      (q) => { const t = `Fitting: ${q.ncalls} models, ${q.elapsed.toFixed(0)} s, ln Z ${q.logZ.toFixed(1)}`; setStatus('stRun', t + ' …'); onProgress(t); });
    result = out.result;
  } catch (err) { setStatus('stRun', err.stopped ? 'The fit was stopped; the model is as it was.' : String((err && err.message) || err), err.stopped ? 'warn' : 'err'); throw err; }
  finally { M.fitJob = null; stopBtn.remove(); }
  M.fit = { data: spec.data, label: spec.label || 'data', result };
  // a run that stopped short has no posterior: the data are shown, the model is left as it was
  if (result.converged) for (const k of result.keys) { const v = +result.summary[k].median.toPrecision(5); if (FIT_APPLY[k]) FIT_APPLY[k](v); else M.model.vmr[k.slice(5)] = 10 ** v; }
  refreshControls(); run(); await new Promise((res) => setTimeout(res, 30)); await whenIdle();
  return result;
}
let fitClient = null;
let refreshControls = () => {};

// ------------------------------------------------------------------------------------------- window.__esl.atmosphere
// What the site's assistant drives (the contract is at the top of src/assistant/pages.js). Every tool goes through the
// page's own state and functions, so the page shows what was done. Results are compact: numbers, never whole spectra.
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra }), B = (description) => ({ type: 'boolean', description });
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const r4 = (x) => (Number.isFinite(x) ? +x.toPrecision(4) : null), ppm = (x) => (Number.isFinite(x) ? +(1e6 * x).toFixed(1) : null);
  const need = () => { if (!M.result) throw new Error(M.error ? 'the last model failed: ' + M.error : 'no model has been computed yet: wait a moment and ask again'); };
  const at = (y, wl) => { const w = M.result.wl; let i = 0; while (i < w.length - 1 && w[i] < wl) i++; return y[i]; };
  const layerAt = (P) => { const a = M.result.atm; let j = 0; while (j < a.n - 1 && a.pLay[j] / 1e5 < P) j++; return j; };
  function summary() {
    need(); const r = M.result, a = r.atm, m = M.model, wls = [0.5, 0.59, 0.77, 1.0, 1.4, 2.0, 2.7, 3.3, 4.3, 4.6, 6.3, 7.7, 10].filter((w) => w >= r.wl[0] && w <= r.wl[r.wl.length - 1]);
    const gases = Object.keys(a.species).filter((g) => a.species[g][layerAt(1e-2)] > 1e-9).sort((x, y) => a.species[y][layerAt(1e-2)] - a.species[x][layerAt(1e-2)]).slice(0, 14);
    return { planet: M.name, mass_Mjup: r4(m.planet.mplanet), radius_Rjup: r4(m.planet.rplanet), star: { teff_K: m.star.teff, radius_Rsun: m.star.rstar, a_over_Rstar: M.ars, spectrum: r.starModel ? 'PHOENIX model' : 'blackbody' },
      temperature_profile: { kind: m.tp.kind, ...(m.tp.kind === 'consistent' && r.climate ? { passes: r.climate.iterations, settled: r.climate.converged, emitted_over_absorbed: r4(r.climate.balance) } : {}), night_side_cooler_by_K: M.nightDT, K_at_bar: Object.fromEntries([1e-6, 1e-4, 1e-2, 1, 10].filter((P) => P >= a.pLay[0] / 1e5 && P <= a.pLay[a.n - 1] / 1e5).map((P) => [P, +a.tLay[layerAt(P)].toFixed(0)])) },
      composition: { mode: M.chem.on ? `chemical equilibrium, [M/H] = ${r4(M.chem.mh)}, C/O = ${r4(M.chem.co)}` : 'mixing ratios set by hand', bulk: m.bulk || 'H2 and He', mean_molecular_weight: r4(a.mu[a.n - 1]), mixing_ratios_at_10_mbar: Object.fromEntries(gases.map((g) => [g, +a.species[g][layerAt(1e-2)].toExponential(2)])), gases_with_opacity: SPECIES.filter((g) => !M.off[g]) },
      aerosols: { cloud_deck_top_bar: m.cloudTop, haze: m.haze, particle_layer: m.cloud, rayleigh_factor: m.rayleighFactor, cover: m.cloudFraction }, condensation: M.cond.on ? (a.condensation ? a.condensation.clouds.map((c) => ({ condensate: c.name, base_bar: c.deep ? 'below the model' : r4(c.base) })) : []) : 'off', ionization: M.ion,
      transit_depth_ppm: Object.fromEntries(wls.map((w) => [w + ' um', ppm(at(r.depth, w))])), eclipse_depth_ppm: r.fpfs ? Object.fromEntries(wls.map((w) => [w + ' um', ppm(at(r.fpfs, w))])) : null,
      depth_range_ppm: (() => { let lo = Infinity, hi = -Infinity, wlo = 0, whi = 0; const [x0, x1] = inRange(); r.wl.forEach((w, i) => { if (w < x0 || w > x1) return; if (r.depth[i] < lo) { lo = r.depth[i]; wlo = w; } if (r.depth[i] > hi) { hi = r.depth[i]; whi = w; } }); return { smallest: ppm(lo), at_um: +wlo.toFixed(3), largest: ppm(hi), at_um_largest: +whi.toFixed(3), plotted_range_um: [x0, x1] }; })(),
      notes: [$('stTop').textContent, $('stStar').textContent].filter(Boolean), limits: 'One-dimensional model; see the Methods page, Atmosphere (limits).' };
  }
  const refresh = () => { for (const [id, v] of [['mplanet', M.model.planet.mplanet], ['rplanet', M.model.planet.rplanet], ['rstar', M.model.star.rstar], ['teff', M.model.star.teff], ['ars', M.ars], ['tpKind', M.model.tp.kind], ['chemMode', M.chem.on ? 'eq' : 'free'], ['bulk', M.model.bulk || 'H2He'], ['condHum', M.cond.humidity], ['nightDT', M.nightDT]]) { const el = $(id); if (el) el.value = v; } $('condOn').checked = M.cond.on; $('ionOn').checked = M.ion; buildTp(); buildVmr(); buildCloud(); };
  refreshControls = refresh;
  const go = async () => { run(); await new Promise((res) => setTimeout(res, 30)); await whenIdle(); if (M.error) throw new Error(M.error); return summary(); };
  const tools = [
    { name: 'atmosphere_get', readOnly: true, core: true, description: 'The model atmosphere now on the page: planet and star, temperature profile, composition, clouds, and the spectrum at a few wavelengths (transit and eclipse depth in ppm). Call it before changing anything and to read the result of a change.', parameters: obj({}), run: async () => { await whenIdle(); return summary(); } },
    { name: 'atmosphere_load_world', core: true, description: `Replace the model by a preset world and compute it: ${Object.keys(WORLDS).join('; ')}. Returns the new model's summary.`, parameters: obj({ world: T('The preset to load.', { enum: Object.keys(WORLDS) }) }, ['world']),
      run: async ({ world }) => { $('world').value = world; applyWorld(world); return go(); } },
    { name: 'atmosphere_lookup_planet', description: 'Set the planet and star from the site\'s catalogue of known planets (mass, radius, star, orbit; the profile\'s temperature is set to the equilibrium temperature) and compute the model.', parameters: obj({ planet: T('Planet name, e.g. "WASP-39 b".') }, ['planet']),
      run: async ({ planet }) => { $('inPlanet').value = planet; const got = await lookup(planet); await new Promise((res) => setTimeout(res, 30)); await whenIdle(); return { set: got, model: summary() }; } },
    { name: 'atmosphere_set', core: true, description: 'Change the model and compute it. Give only what should change. Temperature: profile ("consistent" = radiative balance from the gases, "guillot", "isothermal"), teq, tint, heat_spread f (0.25 whole planet, 0.5 day side), night_cooler_by. Composition: chemistry ("equilibrium" or "free"), metallicity (times solar), c_to_o, vmr {gas: mixing ratio} in free mode, gases_on / gases_off (which gases\' opacity is included), bulk, condensation, ionization. Clouds: cloud_top_bar (null removes the deck), haze {factor, slope} or null, rayleigh_factor, cloud_cover. Planet and star: mass, radius, star_radius, star_teff, a_over_rstar. Returns the new summary.',
      parameters: obj({ profile: T('Kind of temperature profile.', { enum: ['consistent', 'guillot', 'isothermal'] }), teq: N('Equilibrium temperature [K].'), tint: N('Internal temperature [K].'), heat_spread: N('f: 0.25 whole planet, 0.5 day side.'), temperature: N('Temperature of an isothermal profile [K].'), night_cooler_by: N('Night side cooler than the day side by this many kelvin (0: the same).'),
        chemistry: T('How the gases are set.', { enum: ['equilibrium', 'free'] }), metallicity: N('Metals relative to the Sun (1 = solar, 10 = ten times).'), c_to_o: N('C/O ratio (the Sun: 0.59).'), vmr: { type: 'object', description: 'Mixing ratios by gas name, for free chemistry, e.g. {"H2O": 1e-3}.', additionalProperties: { type: 'number' } },
        gases_on: { type: 'array', items: T('A gas name.', { enum: SPECIES }), description: 'Gases whose opacity to include.' }, gases_off: { type: 'array', items: T('A gas name.', { enum: SPECIES }), description: 'Gases whose opacity to leave out.' },
        bulk: T('The gas that fills the atmosphere.', { enum: ['H2He', 'N2', 'CO2'] }), condensation: B('Condense and rain out.'), ionization: B('Ionize H, Na and K by starlight.'),
        cloud_top_bar: { type: ['number', 'null'], description: 'Pressure of a grey cloud deck\'s top [bar]; null removes it.' }, haze: { type: ['object', 'null'], description: 'Power-law haze {factor (times H2 Rayleigh at 0.35 um), slope (power of wavelength, -4 is Rayleigh)}; null removes it.', properties: { factor: N('Strength.'), slope: N('Slope.') } }, rayleigh_factor: N('Multiplies the gas\'s Rayleigh scattering (1: the gas alone).'), cloud_cover: N('Share of the planet covered by the aerosols, 0 to 1.'),
        mass: N('Planet mass [M Jup].'), radius: N('Planet radius at the reference pressure [R Jup].'), star_radius: N('Star radius [R Sun].'), star_teff: N('Star effective temperature [K].'), a_over_rstar: N('Orbital distance over the star\'s radius.') }),
      run: async (c) => {
        const m = M.model, pos = (v, what) => { if (!(v > 0)) throw new Error(`${what} must be positive`); return v; };
        if (c.profile) m.tp.kind = c.profile; if (c.teq != null) { m.tp.teq = pos(c.teq, 'teq'); } if (c.tint != null) m.tp.tint = Math.max(0, c.tint); if (c.heat_spread != null) m.tp.f = Math.min(1, Math.max(0.1, c.heat_spread)); if (c.temperature != null) m.tp.t = pos(c.temperature, 'temperature');
        if (c.night_cooler_by != null) M.nightDT = Math.max(0, c.night_cooler_by);
        if (c.chemistry) M.chem.on = c.chemistry === 'equilibrium'; if (c.metallicity != null) M.chem.mh = Math.log10(pos(c.metallicity, 'metallicity')); if (c.c_to_o != null) M.chem.co = Math.min(1.5, Math.max(0.1, c.c_to_o));
        for (const [g, v] of Object.entries(c.vmr || {})) { if (!SPECIES.includes(g)) throw new Error(`no gas "${g}" (gases: ${SPECIES.join(', ')})`); m.vmr[g] = pos(v, g); M.off[g] = false; }
        for (const g of c.gases_on || []) { M.off[g] = false; M.failed.delete(g); } for (const g of c.gases_off || []) M.off[g] = true;
        if (c.bulk) m.bulk = c.bulk === 'H2He' ? null : c.bulk; if (c.condensation != null) M.cond.on = c.condensation; if (c.ionization != null) M.ion = c.ionization;
        if ('cloud_top_bar' in c) m.cloudTop = c.cloud_top_bar == null ? null : pos(c.cloud_top_bar, 'cloud_top_bar'); if ('haze' in c) m.haze = c.haze ? { factor: pos(c.haze.factor ?? 100, 'haze factor'), slope: c.haze.slope ?? -4 } : null;
        if (c.rayleigh_factor != null) m.rayleighFactor = pos(c.rayleigh_factor, 'rayleigh_factor'); if (c.cloud_cover != null) m.cloudFraction = Math.min(1, Math.max(0, c.cloud_cover));
        if (c.mass != null) m.planet.mplanet = pos(c.mass, 'mass'); if (c.radius != null) m.planet.rplanet = pos(c.radius, 'radius'); if (c.star_radius != null) m.star.rstar = pos(c.star_radius, 'star_radius'); if (c.star_teff != null) m.star.teff = pos(c.star_teff, 'star_teff'); if (c.a_over_rstar != null) M.ars = pos(c.a_over_rstar, 'a_over_rstar');
        refresh(); return go();
      } },
    { name: 'atmosphere_spectrum', readOnly: true, description: 'The model spectrum binned to a resolving power between two wavelengths, as a short table: wavelength [um], transit depth [ppm], eclipse depth [ppm], brightness temperature [K]. At most 60 rows come back; save_as writes the full-resolution spectrum as a CSV file for the user.',
      parameters: obj({ wl_min: N('Shortest wavelength [um] (default 0.3).'), wl_max: N('Longest wavelength [um] (default 12).'), R: N('Resolving power of the returned table (default 20).'), save_as: T('File name for the full spectrum as CSV, e.g. "model.csv" (optional).') }),
      run: async ({ wl_min = 0.3, wl_max = 12, R = 20, save_as }, { files }) => {
        await whenIdle(); need(); const r = M.result, rows = []; let lo = Math.max(wl_min, r.wl[0]);
        while (lo < Math.min(wl_max, r.wl[r.wl.length - 1]) && rows.length < 60) { const hi = lo * (1 + 1 / Math.max(1, R)), idx = []; r.wl.forEach((w, i) => { if (w >= lo && w < hi) idx.push(i); }); if (idx.length) { const mean = (y) => idx.reduce((u, i) => u + y[i], 0) / idx.length; rows.push([+Math.sqrt(lo * hi).toFixed(4), ppm(mean(r.depth)), r.fpfs ? ppm(mean(r.fpfs)) : null, r.brightness ? +mean(r.brightness).toFixed(0) : null]); } lo = hi; }
        let saved; if (save_as && files) saved = await files.write(save_as, 'wavelength_micron,transit_depth,eclipse_depth,brightness_temperature_K\n' + Array.from(r.wl, (w, i) => [w.toPrecision(7), r.depth[i].toExponential(6), r.fpfs ? r.fpfs[i].toExponential(6) : '', r.brightness ? r.brightness[i].toFixed(1) : ''].join(',')).join('\n') + '\n');
        return { columns: ['wavelength_um', 'transit_depth_ppm', 'eclipse_depth_ppm', 'brightness_temperature_K'], rows, ...(saved ? { written: saved } : {}) };
      } },
    { name: 'atmosphere_fit_spectrum', core: true, description: 'Fit the model on the page to a measured spectrum (a retrieval by nested sampling), draw the data on the spectrum and set the model to the fit. file: text rows of "wavelength, value, error" or "wavelength, bin_low, bin_high, value, error", micron. free: from teq, tint, logKappaIR, logGamma (Guillot), t (isothermal), mh, co (equilibrium), logX_<gas> (gases by hand), rplanet, logCloudTop, cloudFraction, logHaze, hazeSlope, logRayleigh, nightDT. Set the profile to "guillot" or "isothermal" first. Priors are uniform [low, high], wide by default. Takes minutes; the user can stop it. If "converged" is false the values are NOT a posterior: say so. The Retrieval page has the corner plot.',
      parameters: obj({ file: T('File name from list_files.'), kind: T('What the values are.', { enum: ['transit', 'eclipse'] }), unit: T('Unit of the value and error columns (default fraction).', { enum: ['fraction', 'percent', 'ppm'] }),
        free: { type: 'array', items: T('A parameter key.'), minItems: 1, description: 'Parameters to fit.' }, priors: { type: 'object', description: 'Key -> [low, high]. Optional.' },
        max_models: { type: 'integer', description: 'Budget of models (default 60000).' }, max_seconds: N('Time limit in seconds (default 600).') }, ['file', 'kind', 'free']),
      run: async ({ file, kind, unit = 'fraction', free, priors, max_models = 60000, max_seconds = 600 }, { files, onProgress }) => {
        const set = parseSpectrumText(await files.readText(file), { name: file, kind, unit }), data = [set], ok = set.wl;
        let r; try { r = await fitSpectra({ data, free, priors, label: file, sampler: { nlive: 100, maxCalls: Math.max(200, max_models), maxSeconds: Math.max(5, max_seconds), seed: 42 } }, (t) => onProgress && onProgress({ message: t })); }
        catch (err) { if (err.stopped) return { stopped: true, note: 'The user stopped the fit on the page; nothing was kept and the model is as it was.' }; throw err; }
        const sg = (v) => +v.toPrecision(5);
        return { converged: r.converged, ...(r.converged ? {} : { warning: 'NOT converged: the budget ran out before the sampler\'s stopping rule; these values are not a posterior. Run longer (max_models, max_seconds) or free fewer parameters.' }),
          parameters: Object.fromEntries(r.keys.map((key, i) => { const q = r.summary[key]; return [key, { label: r.labels[i], value: sg(q.median), plus: +(q.hi - q.median).toPrecision(2), minus: +(q.median - q.lo).toPrecision(2), prior: [r.priors[key].a, r.priors[key].b], prior_given: !!(priors && priors[key]) }]; })),
          ln_Z: r.converged ? { value: +r.logZ.toFixed(2), error: +r.logZerr.toFixed(2) } : null, chi2: +r.chi2.toFixed(1), data_points: r.ndata, models_computed: r.ncalls, seconds: +r.seconds.toFixed(1), warnings: r.warnings,
          page: !r.converged ? `The ${ok.length} points are drawn on the ${kind === 'eclipse' ? 'emission' : 'transmission'} spectrum; the model on the page was left as it was.` : `The model on the page is now the median of the fit and the ${ok.length} points are drawn on the ${kind === 'eclipse' ? 'emission' : 'transmission'} spectrum. The fit ran on 30 layers and opacity bins joined by ${r.merge}; the page's own spectrum is finer and can differ from the fitted one by a fraction of the errors.`,
          next: 'atmosphere_get gives the model as it now is.' };
      } },
  ];
  (window.__esl = window.__esl || {}).atmosphere = { tools, ready: () => M.ready === true && !!M.result,
    state: () => { if (!M.result) return ['Atmosphere: the first model is still being computed.']; const s = summary(); return [`Atmosphere: ${s.planet}${M.busy && !M.partsPhase ? '; a model is being computed' : ''}. Profile: ${s.temperature_profile.kind}; ${s.composition.mode}; gases with opacity: ${s.composition.gases_with_opacity.join(', ')}.`, `Transit depth ${s.depth_range_ppm.smallest} to ${s.depth_range_ppm.largest} ppm over ${s.depth_range_ppm.plotted_range_um.join('-')} um. Tools: atmosphere_get, atmosphere_set, atmosphere_load_world, atmosphere_lookup_planet, atmosphere_spectrum.`]; } };
}

