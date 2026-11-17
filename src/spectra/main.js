// Spectroscopy page: spectra over time (files or a simulation) -> cleaning and binning -> white-light fit ->
// one fit per channel in a pool of workers -> spectrum, diagnostics, exports.
// The science is src/core/spectroscopy.js (tested in test/spectroscopy.test.mjs); this file is the UI.
import { startJob } from '../site/jobs.js';
import { siteRoot } from '../site/nav.js';
import { siteJson } from '../site/net.js';
import { openFits } from '../core/fits.js';
import { loadIndex, lookupHost, systemFromRows, searchNames } from '../core/catalog.js';
import { deriveSystem } from '../core/derive.js';
import { expandSpectral } from '../core/ldspec.js';
import { MISSION_BANDS, TELESCOPES, bandsOf } from '../core/missionbands.js';
import * as SP from '../core/spectroscopy.js';
import { fitCanvas } from '../photometry/plots.js';
import { SPEC_THEME, SPEC_DARK, PRINT_THEME, renderCubeImage, renderSpectrum, renderLightCurve, renderChannelGrid, renderNoise, renderBinnedRms } from './plots.js';

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const $ = (id) => document.getElementById(id);
const ppm = (v, d = 0) => (Number.isFinite(v) ? (1e6 * v).toFixed(d) : '–');
const num = (id) => { const v = Number($(id).value); return Number.isFinite(v) ? v : NaN; };

// WASP-39 b as the starting system (Mancini et al. 2018, A&A 613, A41); "Look up" replaces it from the site's catalogue
const P = {
  name: 'WASP-39 b', kind: 'transit', cube: null, clean: null, source: null, sim: null,
  sys: { rprs: 0.1457, ars: 11.4, inc: 87.75, per: 4.0552941, tmid: 2455342.96913, ecc: 0, omega: 0, mplanet: 0.281 },
  star: { teff: 5485, logg: 4.41, feh: 0.01, rstar: 0.939, mstar: 0.913, distance: 214 },
  settings: { clean: { window: 11, nsigma: 5 }, bins: { mode: 'R', R: 100 }, baseline: 'linear', ldLaw: 'quadratic', errorMode: 'max', commonMode: false, steps: [], kepler: false },
  bins: [], channels: [], white: null, whiteLd: null, whiteFit: null, results: [], spectrum: null, busy: false, sel: 0,
};

// ------------------------------------------------------------------------------------------- limb darkening table (lazy)
let ldTable = null;
async function table() { if (!ldTable) { const m = await import('../data/ld_spectral.js'); ldTable = expandSpectral(m.LD_SPECTRAL_COMPACT); } return ldTable; }
const ldFor = (lo, hi) => { try { return SP.channelLimbDarkening(ldTable, P.star, lo, hi, P.settings.ldLaw); } catch { return { law: 'quadratic', coeffs: [0.1, 0.1], extrapolated: true, failed: true }; } };

// ------------------------------------------------------------------------------------------- workers
const mkWorker = () => new Worker(new URL('./spectra.worker.js', import.meta.url), { type: 'module' });
let pool = [], stopFlag = false, seq = 0;
// a terminated worker never answers: its pending call is rejected here, or a stopped fit would wait for ever
const pending = new Map();
function killPool() { for (const w of pool) { w.terminate(); const r = pending.get(w); if (r) r(new Error('Stopped.')); pending.delete(w); } pool = []; }
function runOn(worker, msg, onProgress) {
  return new Promise((resolve0, reject0) => {
    const id = ++seq, resolve = (x) => { pending.delete(worker); resolve0(x); }, reject = (e) => { pending.delete(worker); reject0(e); };
    pending.set(worker, reject);
    worker.onmessage = (ev) => { const m = ev.data; if (m.id !== id) return; if (m.type === 'progress') onProgress && onProgress(m); else if (m.type === 'done') resolve(m.result); else reject(new Error(m.message)); };
    worker.onerror = (e) => reject(new Error(e.message || 'The worker failed to start.'));
    worker.postMessage({ ...msg, id });
  });
}

// ------------------------------------------------------------------------------------------- layout
const app = $('app');
const field = (label, id, value, attrs = {}) => h('label', {}, label, h('input', { type: 'number', id, value, step: 'any', ...attrs }));
const select = (label, id, options, value) => h('label', {}, label, h('select', { id }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
app.append(
  h('section', { class: 'src' },
    h('div', { class: 'card' },
      h('h2', {}, 'Your spectra'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', id: 'bOpen', onclick: () => $('inFiles').click() }, 'Open files'),
        h('input', { type: 'file', id: 'inFiles', multiple: true, accept: '.fits,.fit,.gz,.csv,.ecsv,.txt,.dat,.json', hidden: true, onchange: (e) => api.load([...e.target.files]).catch(() => {}) })),
      h('div', { class: 'drop', id: 'drop' }, 'or drop them here. JWST x1dints.fits (all segments and both detectors of one exposure together), a CSV / ECSV table with columns time, wavelength, flux, flux_err, or a session saved from this page (.json). Extracted 1-D spectra only: there is no spectral extraction from images here.'),
      h('div', { class: 'status', id: 'stLoad' })),
    h('div', { class: 'card' },
      h('h2', {}, 'Simulate an observation'),
      h('div', { class: 'grid2' },
        select('Telescope', 'simTel', [['Ariel', 'Ariel (0.64 m²)'], ['JWST', 'JWST (25.4 m²)']], 'Ariel'),
        select('Mode', 'simMode', [['', 'all six channels']], ''),
        field('Area (m²)', 'simArea', 0.64, { min: 0.01 }), field('Throughput', 'simThr', 0.3, { min: 0.01, max: 1 }),
        field('Noise floor (ppm)', 'simFloor', 20, { min: 0 }), field('Above photon noise (%)', 'simExcess', 0, { min: 0 }),
        field('Cadence (s)', 'simCad', 60, { min: 1 }), field('Resolving power R', 'simR', '', { min: 2, placeholder: 'default' }),
        field('Feature height (ppm)', 'simAmp', 400, { min: 0 }), field('Seed', 'simSeed', 1, { step: 1 })),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', id: 'bSim', onclick: () => api.simulate().catch(() => {}) }, 'Simulate'), h('span', { class: 'dim', id: 'simHint', style: 'font-size:12px' })),
      h('p', { class: 'note2' }, 'A simple radiometric estimate, not ArielRad or PandExo: photon noise of a black-body star through the stated area and throughput, plus a floor (see “How this is computed”). The injected spectrum is a level, and Gaussian features at 1.4, 2.8 and 4.3 µm of the height given: a test pattern, not an atmosphere.'),
      h('div', { class: 'status', id: 'stSim' }))),

  h('section', { class: 'card sysc' },
    h('h2', {}, 'Planet and star'),
    h('div', { class: 'row' },
      h('input', { type: 'text', class: 'wide', id: 'inPlanet', value: P.name, placeholder: 'Planet name, e.g. WASP-39 b', list: 'plNames', autocomplete: 'off', onkeydown: (e) => { if (e.key === 'Enter') api.lookup($('inPlanet').value).catch(() => {}); }, oninput: suggest }),
      h('datalist', { id: 'plNames' }),
      h('button', { class: 'btn', id: 'bLook', onclick: () => api.lookup($('inPlanet').value).catch(() => {}) }, 'Look up'),
      select('', 'kind', [['transit', 'transit (transmission)'], ['eclipse', 'eclipse (emission)']], 'transit')),
    h('div', { class: 'sysgrid', id: 'sysgrid' }),
    h('div', { class: 'status', id: 'stSys' })),

  h('section', { class: 'res', id: 'secData', hidden: true },
    h('h2', {}, 'Spectra over time'),
    h('div', { class: 'sum', id: 'sumData' }),
    h('div', { class: 'card pad6' }, h('canvas', { id: 'cvImg', role: 'img', 'aria-label': 'Flux against time and wavelength, each wavelength divided by its median' })),
    h('div', { class: 'card ctl' },
      h('div', { class: 'grid4' },
        select('Bins', 'binMode', [['R', 'constant R = λ/Δλ'], ['width', 'constant width (µm)'], ['n', 'number of bins'], ['columns', 'columns per bin'], ['native', 'every column']], 'R'),
        field('Value', 'binVal', 100, { min: 0 }), field('From (µm)', 'wlMin', '', { placeholder: 'all' }), field('To (µm)', 'wlMax', '', { placeholder: 'all' }),
        select('Baseline', 'baseline', [['linear', 'slope in time'], ['quadratic', 'slope and curvature'], ['none', 'level only']], 'linear'),
        select('Limb darkening', 'ldLaw', [['quadratic', 'quadratic, from the star'], ['nonlinear', '4-parameter, from the star'], ['linear', 'linear, from the star']], 'quadratic'),
        select('Error bars', 'errMode', [['max', 'pipeline, widened to the scatter'], ['pipeline', 'pipeline as given'], ['scatter', 'point-to-point scatter']], 'max'),
        field('Clip (σ, in time)', 'clipN', 5, { min: 2 })),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn', id: 'bBins', onclick: () => { try { api.setBins(); } catch { /* shown in the status line */ } } }, 'Apply'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'commonMode' }), 'divide channels by the white-light residuals (common mode)'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'kepler' }), 'a/R★ from Kepler’s law, R★ free with its error'),
        h('span', { class: 'grow' }), h('span', { class: 'dim mono', id: 'binInfo' })),
      h('div', { class: 'status', id: 'stBins' }))),

  h('section', { class: 'res', id: 'secWhite', hidden: true },
    h('h2', {}, 'White light curve'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', id: 'bWhite', onclick: () => api.fitWhite().catch(() => {}) }, 'Fit the white light curve'),
      h('button', { class: 'btn', id: 'bStep', onclick: addStep, title: 'Look for the largest jump in the residuals (a JWST mirror tilt event) and put a step there' }, 'Find a step'),
      h('span', { class: 'dim', id: 'stepInfo', style: 'font-size:12px' }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', id: 'bAnalyze', onclick: openInAnalyze }, 'Open the white light curve in Analyze')),
    h('progress', { id: 'pgWhite', max: 1, value: 0, hidden: true }),
    h('div', { class: 'status', id: 'stWhite' }),
    h('div', { class: 'plots' }, h('div', { class: 'card' }, h('canvas', { id: 'cvWhite' })), h('div', { class: 'card tblc' }, h('div', { id: 'whiteTable', class: 'livetbl' }))),

    h('h2', {}, 'Spectrum'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', id: 'bChan', onclick: () => api.fitChannels().catch(() => {}) }, 'Fit all channels'),
      h('button', { class: 'btn', id: 'bStop', onclick: () => { stopFlag = true; killPool(); }, hidden: true }, 'Stop'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => api.export('png') }, 'PNG'), h('button', { class: 'btn sm', onclick: () => api.export('csv') }, 'CSV'), h('button', { class: 'btn sm', onclick: () => api.export('ecsv') }, 'ECSV'),
      h('button', { class: 'btn sm', onclick: () => api.export('session') }, 'Save session')),
    h('progress', { id: 'pgChan', max: 1, value: 0, hidden: true }),
    h('div', { class: 'status', id: 'stChan' }),
    h('div', { class: 'card pad6' }, h('canvas', { id: 'cvSpec', role: 'img', 'aria-label': 'Depth against wavelength with error bars' })),
    h('p', { class: 'note2', id: 'interp' }),
    h('div', { class: 'plots two' }, h('div', { class: 'card' }, h('canvas', { id: 'cvNoise' })), h('div', { class: 'card' }, h('canvas', { id: 'cvBeta' }))),
    h('div', { class: 'card pad6', style: 'margin-top:12px' }, h('canvas', { id: 'cvGrid', role: 'img', 'aria-label': 'Light curve of every channel with its model' })),
    h('div', { class: 'card tried', id: 'chanTable' })),

  h('details', { class: 'card how' }, h('summary', {}, 'How this is computed'), h('div', { html: HOW() })),
);

function HOW() {
  return `<p><b>Reading.</b> JWST <span class="mono">x1dints</span> files hold one extracted spectrum per integration (EXTRACT1D: WAVELENGTH, FLUX, FLUX_ERROR, DQ) and the mid-times in BJD<sub>TDB</sub>. Both pipeline layouts are read. Segments are joined in time, detectors in wavelength. Points with a non-finite flux or the DO_NOT_USE flag are dropped.</p>
<p><b>Cleaning.</b> Each wavelength is compared with its running median in time; points beyond the chosen number of robust standard deviations are replaced by that median. Columns with more than a fifth of their points bad, a non-positive median, a median more than 50% from their neighbours’, or error bars five times the typical ones, are left out.</p>
<p><b>Light curves.</b> A channel is the sum of its columns, errors added in quadrature, divided by its median. The white light curve is the sum of all columns (detectors are averaged with inverse-variance weights).</p>
<p><b>Fits.</b> One likelihood for everything on this site (<span class="mono">buildProblem</span>). White light: R<sub>p</sub>/R★, mid-time and inclination free (nested sampling); a/R★ is fixed, or follows from Kepler’s law with R★ free. Channels: geometry fixed at the white-light solution, the depth free, limb darkening fixed at the PHOENIX-table value for the channel’s wavelength range and the star’s T<sub>eff</sub>, log g, [Fe/H] (table to 5.5 µm; beyond it the reddest part of the table is used). With one free parameter the posterior is integrated on a grid. The baseline (level, slope, curvature, a step) enters linearly and is integrated out analytically in every fit. Error bars of the spectrum are the 16th and 84th percentiles; they do not include the uncertainty of the shared geometry, which moves all channels together.</p>
<p><b>Noise checks.</b> Residual rms against the rms the error bars predict, and β: the largest ratio of the rms of binned residuals to the white-noise expectation σ<sub>1</sub>/√N · √(M/(M−1)).</p>
<p><b>Simulation.</b> Detected electrons per exposure N = A · τ · t · π(R★/d)² ∫ 2c/λ⁴ / (e<sup>hc/λkT</sup> − 1) dλ over the channel; noise per point σ² = (1 + x)²/N + f² · T<sub>14</sub>/Δt, where x is the stated excess over photon noise and f the noise floor, written so that the floor alone averages to f over one transit duration. No background, read noise, saturation or pointing jitter. Ariel: 0.64 m², bands of Tinetti et al. (2018) and the Ariel Red Book; JWST: 25.4 m². The throughput is one number you choose, not a measured curve.</p>
<p><b>Scale heights.</b> H = kT<sub>eq</sub>/(μ m<sub>u</sub> g) with μ = 2.3; one scale height changes the depth by 2 H R<sub>p</sub>/R★². For orientation only.</p>`;
}

// ------------------------------------------------------------------------------------------- system form
const SYS_FIELDS = [['per', 'P (d)', 'sys'], ['tmid', 'T mid (BJD)', 'sys'], ['rprs', 'Rp/R★', 'sys'], ['ars', 'a/R★', 'sys'], ['inc', 'i (°)', 'sys'], ['ecc', 'e', 'sys'], ['omega', 'ω (°)', 'sys'], ['mplanet', 'Mp (M Jup)', 'sys'], ['fpfs', 'Fp/F★', 'sys'],
  ['teff', 'T eff (K)', 'star'], ['logg', 'log g', 'star'], ['feh', '[Fe/H]', 'star'], ['rstar', 'R★ (R☉)', 'star'], ['mstar', 'M★ (M☉)', 'star'], ['distance', 'distance (pc)', 'star']];
function buildSys() {
  const g = $('sysgrid'); g.innerHTML = '';
  for (const [k, label, where] of SYS_FIELDS) {
    if (k === 'fpfs' && P.kind !== 'eclipse') continue;
    const v = P[where][k];
    g.append(h('label', {}, label, h('input', { type: 'number', step: 'any', id: 'sys_' + k, value: v ?? '', onchange: (e) => { const x = Number(e.target.value); P[where][k] = e.target.value === '' || !Number.isFinite(x) ? undefined : x; sysChanged(); } })));
  }
  $('kind').value = P.kind;
}
function sysChanged() { invalidate('white'); hints(); }
function hints() {
  const sh = scale();
  $('simHint').textContent = sh ? `1 scale height ≈ ${ppm(sh.depthPerH)} ppm of depth (H = ${(sh.H / 1000).toFixed(0)} km at ${sh.teq.toFixed(0)} K)` : '';
}
/** Scale height and depth per scale height from the current system, or null when the mass or the star is missing. */
function scale() {
  const s = P.whiteFit ? P.whiteFit.values : P.sys, st = P.star;
  if (!(s.mplanet > 0 && st.rstar > 0 && st.teff > 0 && s.ars > 0)) return null;
  const d = deriveSystem({ ...s }, { rstar: st.rstar, mstar: st.mstar, teff: st.teff, mplanet: s.mplanet });
  const sh = SP.scaleHeight({ teq: d.teq, mu: 2.3, mplanet: s.mplanet, rplanet: d.rpJup });
  return { H: sh.H, g: sh.g, teq: d.teq, rplanet: d.rpJup, depthPerH: (2 * sh.H * d.rpJup * 7.1492e7) / (st.rstar * 6.957e8) ** 2 };
}
$('kind').addEventListener('change', () => { P.kind = $('kind').value; if (P.kind === 'eclipse' && !(P.sys.fpfs > 0)) P.sys.fpfs = 0.05; buildSys(); invalidate('white'); });

// catalogue
let catIndex = null;
const fetchCat = (name) => siteJson(new URL('catalog/' + name, siteRoot()), `The catalogue (catalog/${name})`);
async function catalogue() { if (!catIndex) catIndex = await loadIndex(fetchCat); return catIndex; }
async function suggest() {
  const q = $('inPlanet').value; if (q.length < 2) return;
  try { const idx = await catalogue(), dl = $('plNames'); dl.innerHTML = ''; for (const s of searchNames(idx, q, 10)) if (s.type === 'planet') dl.append(h('option', { value: s.label })); } catch { /* no suggestions without the catalogue */ }
}
async function lookup(name) {
  setStatus('stSys', 'Looking up ' + name + ' …');
  try {
    const idx = await catalogue(), L = await lookupHost(idx, name, fetchCat);
    if (!L) throw new Error(`“${name}” is not in the catalogue.`);
    const S = systemFromRows(L.rows), pl = S.planets.find((p) => p && p.planet === L.planet) || S.planets.find(Boolean);
    if (!pl) throw new Error('No usable parameter set for ' + name + '.');
    const v = (k) => (pl.values[k] && Number.isFinite(pl.values[k].value) ? pl.values[k].value : undefined), missing = ['per', 'tmid', 'rprs', 'ars', 'inc'].filter((k) => v(k) === undefined);
    if (missing.length) throw new Error(`${pl.planet}: the catalogue has no ${missing.join(', ')}; this planet may not transit. Fill the numbers in by hand.`);
    P.name = pl.planet; P.sys = { rprs: v('rprs'), ars: v('ars'), inc: v('inc'), per: v('per'), tmid: v('tmid'), ecc: v('ecc') || 0, omega: v('omega') || 0, mplanet: v('mplanet'), fpfs: P.sys.fpfs };
    P.star = { teff: v('teff'), logg: v('logg'), feh: v('feh') ?? 0, rstar: v('rstar'), mstar: v('mstar'), distance: L.system && L.system.sy_dist };
    $('inPlanet').value = pl.planet; buildSys(); sysChanged();
    const src = [...new Set(['per', 'rprs', 'ars', 'teff'].map((k) => pl.values[k] && pl.values[k].source).filter(Boolean))].join('; ');
    setStatus('stSys', `${pl.planet}: ${src} (catalogue snapshot ${L.snapshot || idx.date}).${pl.values.tmid && /HJD/.test(pl.values.tmid.note || '') ? ' The mid-time is in HJD, not BJD_TDB: it is only a starting point, the white-light fit finds the mid-time.' : ''}`, 'ok');
    return { name: P.name, system: { ...P.sys }, star: { ...P.star } };
  } catch (err) { setStatus('stSys', err.message, 'err'); throw err; }
}

// ------------------------------------------------------------------------------------------- status, invalidation
function setStatus(id, text, cls = '') { const el = $(id); if (!el) return; el.textContent = text; el.className = 'status' + (cls ? ' ' + cls : ''); }
function invalidate(level) {
  if (level === 'white') { P.whiteFit = null; }
  P.results = []; P.spectrum = null;
  if (P.cube) redraw();
}

// ------------------------------------------------------------------------------------------- loading
async function readOne(file) {
  const name = file.name || 'data', lower = name.toLowerCase();
  if (/\.json$/.test(lower)) return { session: JSON.parse(typeof file.text === 'function' ? await file.text() : file.textContent), name };
  if (/\.(fits|fit|fts)(\.gz)?$/.test(lower) || file.buffer instanceof ArrayBuffer) {
    const buf = file.buffer || (await file.arrayBuffer()), fits = await openFits(buf);
    return { cube: SP.readX1dints(fits), name };
  }
  const text = typeof file.text === 'function' ? await file.text() : file.textContent;
  return { cube: SP.parseSpectralText(text, name), name };
}
/** files: File objects, or { name, buffer (ArrayBuffer) } / { name, textContent } for scripted use. */
async function load(files) {
  files = Array.isArray(files) ? files : [files];
  setStatus('stLoad', `Reading ${files.length} file${files.length > 1 ? 's' : ''} …`);
  try {
    const parts = []; for (const f of files) parts.push(await readOne(f));
    const ses = parts.find((p) => p.session);
    if (ses) return restore(ses.session);
    const cube = SP.mergeCubes(parts.map((p) => p.cube)), m = cube.meta || {};
    P.sim = null;
    const nz = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (m.target && !nz(P.name).startsWith(nz(m.target))) setStatus('stSys', `The files name the target “${m.target}”. Look the planet up, or check the numbers above.`);
    setCube(cube, { kind: m.source || 'files', files: parts.map((p) => p.name), meta: m });
    setStatus('stLoad', `${parts.length} file${parts.length > 1 ? 's' : ''}: ${cube.nT} integrations × ${cube.nW} wavelengths${m.instrument ? `, ${m.instrument} ${m.grating || m.filter || ''} ${m.detector || ''}` : ''}${m.target ? `, target ${m.target}` : ''}.`, 'ok');
    return summary();
  } catch (err) { setStatus('stLoad', err.message, 'err'); throw err; }
}
function setCube(cube, source) {
  P.cube = cube; P.source = source; P.whiteFit = null; P.results = []; P.spectrum = null; P.settings.steps = []; P.sel = 0;
  P.clean = SP.rejectOutliers(cube, { window: P.settings.clean.window, nsigma: P.settings.clean.nsigma });
  $('secData').hidden = false; $('secWhite').hidden = false;
  if (cube.lo) { $('binMode').value = 'native'; P.settings.bins = { mode: 'native' }; }
  else if ($('binMode').value === 'native' && cube.nW > 400) { $('binMode').value = 'R'; $('binVal').value = 100; P.settings.bins = { mode: 'R', R: 100 }; }
  applyBins();
}
function readBinForm() {
  const mode = $('binMode').value, v = num('binVal'), o = { mode };
  if (mode === 'R') o.R = v; else if (mode === 'width') o.width = v; else if (mode === 'n') o.n = v; else if (mode === 'columns') o.columns = v;
  if (Number.isFinite(num('wlMin')) && $('wlMin').value !== '') o.wlMin = num('wlMin'); if (Number.isFinite(num('wlMax')) && $('wlMax').value !== '') o.wlMax = num('wlMax');
  return o;
}
function applyBins(opts) {
  if (!P.cube) throw new Error('Open spectra or simulate an observation first.');
  if (opts) { P.settings.bins = { ...opts }; $('binMode').value = opts.mode || 'native'; const v = opts.R ?? opts.width ?? opts.n ?? opts.columns; if (v !== undefined) $('binVal').value = v; $('wlMin').value = opts.wlMin ?? ''; $('wlMax').value = opts.wlMax ?? ''; }
  try {
    P.bins = SP.makeBins(P.clean, P.settings.bins); P.channels = SP.binCube(P.clean, P.bins);
    P.white = SP.whiteLight(P.clean, { wlMin: P.settings.bins.wlMin, wlMax: P.settings.bins.wlMax });
    P.results = []; P.spectrum = null; P.whiteFit = null;
    setStatus('stBins', '');
  } catch (err) { setStatus('stBins', err.message, 'err'); throw err; }
  redraw();
  return { channels: P.channels.length, points: P.white.time.length };
}
function readSettings() {
  const s = P.settings;
  s.baseline = $('baseline').value; s.ldLaw = $('ldLaw').value; s.errorMode = $('errMode').value; s.commonMode = $('commonMode').checked; s.kepler = $('kepler').checked;
  const cn = num('clipN'); if (cn >= 2 && cn !== s.clean.nsigma) { s.clean.nsigma = cn; P.clean = SP.rejectOutliers(P.cube, { window: s.clean.window, nsigma: cn }); }
  s.bins = readBinForm();
}

// ------------------------------------------------------------------------------------------- simulation
function simModes() {
  const tel = $('simTel').value, sel = $('simMode'); sel.innerHTML = '';
  if (tel === 'Ariel') sel.append(h('option', { value: '' }, 'all six channels'));
  for (const b of bandsOf(tel)) sel.append(h('option', { value: b.name }, b.mode));
  if (tel === 'JWST') sel.value = 'JWST NIRSpec PRISM';
  $('simArea').value = TELESCOPES[tel].area; $('simThr').value = TELESCOPES[tel].throughput; $('simFloor').value = TELESCOPES[tel].noiseFloorPpm;
}
$('simTel').addEventListener('change', simModes);
async function simulate(o = {}) {
  setStatus('stSim', 'Simulating …');
  try {
    if (o.telescope && TELESCOPES[o.telescope] && $('simTel').value !== o.telescope) { $('simTel').value = o.telescope; simModes(); }
    if (o.mode !== undefined && MISSION_BANDS[o.mode]) $('simMode').value = o.mode;
    if (o.planet) await lookup(o.planet);
    if (o.kind) { P.kind = o.kind; if (P.kind === 'eclipse' && !(P.sys.fpfs > 0)) P.sys.fpfs = 0.05; buildSys(); }
    await table();
    const tel = o.telescope || $('simTel').value, mode = o.mode ?? $('simMode').value, R = o.R ?? (Number($('simR').value) || undefined);
    const bands = mode ? [mode] : TELESCOPES[tel].bands, simR = {}; if (R) for (const b of bands) if (MISSION_BANDS[b].kind !== 'photometer') simR[b] = R;
    const amp = (o.featurePpm ?? num('simAmp')) * 1e-6, sys = { ...P.sys }, d0 = P.kind === 'eclipse' ? (sys.fpfs ?? 0.05) * sys.rprs ** 2 : sys.rprs ** 2;
    const depth = o.depth || { depth0: d0, slope: 0, features: [{ wl: 1.4, sigma: 0.1, amp }, { wl: 2.8, sigma: 0.15, amp }, { wl: 4.3, sigma: 0.2, amp: 1.5 * amp }] };
    if (!(P.star.distance > 0)) throw new Error('The simulator needs the distance of the star (pc): fill it in under “Planet and star”.');
    const sim = SP.simulateSpectroscopy({ system: sys, star: P.star, telescope: tel, kind: P.kind, bands, simR, area: o.area ?? num('simArea'), throughput: o.throughput ?? num('simThr'), noiseFloorPpm: o.noiseFloorPpm ?? num('simFloor'), excess: o.excess ?? num('simExcess') / 100, cadence: o.cadence ?? num('simCad'), seed: o.seed ?? num('simSeed'), depth, slopePpmPerHr: o.slopePpmPerHr ?? 0, ldFor: (lo, hi) => { const r = ldFor(lo, hi); return { law: r.law, coeffs: r.coeffs }; } });
    P.sim = { inputs: sim.inputs, truth: sim.truth.map((t) => ({ wl: t.wl, lo: t.lo, hi: t.hi, depth: t.depth, sigma: t.sigma, electrons: t.electrons })), depth };
    setCube(sim.cube, { kind: 'simulation', files: [], meta: { ...sim.cube.meta, target: P.name, mode: mode || 'all channels' } });
    const sg = sim.truth.map((t) => t.sigma);
    setStatus('stSim', `${tel}${mode ? ', ' + MISSION_BANDS[mode].mode : ''}: ${sim.cube.nW} channels × ${sim.cube.nT} exposures of ${sim.inputs.cadence_s} s; noise per exposure ${ppm(Math.min(...sg))} to ${ppm(Math.max(...sg))} ppm.`, 'ok');
    return { channels: sim.cube.nW, points: sim.cube.nT, inputs: sim.inputs, truth: P.sim.truth };
  } catch (err) { setStatus('stSim', err.message, 'err'); throw err; }
}

// ------------------------------------------------------------------------------------------- fits
/** The settings a white-light fit depends on: when they change, the fit on the page is out of date. */
const fitKey = () => JSON.stringify([lcOpts(), P.settings.kepler, P.kind]);
function lcOpts() { const s = P.settings; return { kind: P.kind, baseline: s.baseline, steps: s.steps.slice(), errorMode: s.errorMode, ldLaw: s.ldLaw }; }
async function fitWhite(o = {}) {
  if (!P.cube) { const e = new Error('Open spectra or simulate an observation first.'); setStatus('stWhite', e.message, 'err'); throw e; }
  if (P.busy) throw new Error('A fit is running.');
  readSettings(); if (o.baseline) P.settings.baseline = o.baseline; if (o.steps) P.settings.steps = o.steps.slice();
  P.busy = true; $('bWhite').disabled = true; $('pgWhite').hidden = false; $('pgWhite').removeAttribute('value'); setStatus('stWhite', 'Fitting the white light curve …');
  const w = mkWorker();
  try {
    await table();
    P.whiteLd = ldFor(P.white.lo, P.white.hi);
    const sys = { ...P.sys, mstar: P.star.mstar, rstar: P.star.rstar }, opts = { ...lcOpts(), ld: P.whiteLd.coeffs };
    if (P.settings.kepler && P.kind === 'transit') {
      if (!(P.star.mstar > 0 && P.star.rstar > 0)) throw new Error('Kepler’s law needs the stellar mass and radius.');
      opts.kepler = true; opts.free = [...SP.defaultWhiteFree(P.white, sys).free, { key: 'rstar', prior: { type: 'normal', a: P.star.rstar, b: o.rstarErr ?? 0.03 * P.star.rstar } }];
    }
    if (o.free) opts.free = o.free;
    const wf = await runOn(w, { type: 'white', lc: P.white, sys, opts }, (p) => { setStatus('stWhite', `Fitting the white light curve … ${p.ncalls.toLocaleString()} likelihood calls`); if (o.onProgress) o.onProgress(p); });
    P.whiteFit = wf; P.whiteKey = fitKey(); P.results = []; P.spectrum = null;
    setStatus('stWhite', `${wf.converged ? 'Converged' : 'Stopped early'} after ${wf.ncalls.toLocaleString()} likelihood calls (${wf.seconds.toFixed(1)} s). Residual rms ${ppm(wf.stats.rms)} ppm, ${wf.stats.ratio.toFixed(2)} × the error bars${wf.errScale !== 1 ? ` (widened by ${wf.errScale.toFixed(2)})` : ''}; β = ${Number.isFinite(wf.stats.beta) ? wf.stats.beta.toFixed(2) : '–'}.${wf.stats.ratio > 1.5 ? ' The residuals are well above the error bars: look for a step or try a curved baseline.' : ''}${P.whiteLd.extrapolated ? ' Limb darkening beyond 5.5 µm is taken from the reddest part of the table.' : ''}`, wf.converged ? 'ok' : 'err');
    redraw(); hints();
    return whiteSummary();
  } catch (err) { setStatus('stWhite', err.message, 'err'); throw err; } finally { w.terminate(); P.busy = false; $('bWhite').disabled = false; $('pgWhite').hidden = true; }
}
function addStep() {
  if (!P.whiteFit) { setStatus('stWhite', 'Fit the white light curve first; the step is looked for in its residuals.', 'err'); return null; }
  const st = SP.findStep(P.whiteFit.time, P.whiteFit.resid);
  if (!st || st.significance < 5) { $('stepInfo').textContent = 'No step above 5σ in the residuals.'; return null; }
  P.settings.steps = [st.time]; $('stepInfo').textContent = `Step of ${ppm(st.size)} ppm at BJD ${st.time.toFixed(5)} (${st.significance.toFixed(0)}σ) added to the baseline: fit again.`;
  return st;
}
async function fitChannels(o = {}) {
  if (!P.cube) { const e = new Error('Open spectra or simulate an observation first.'); setStatus('stChan', e.message, 'err'); throw e; }
  if (!P.whiteFit) await fitWhite();
  if (P.busy) throw new Error('A fit is running.');
  P.busy = true; stopFlag = false; $('bChan').disabled = true; $('bStop').hidden = false; $('pgChan').hidden = false; $('pgChan').value = 0;
  const job = startJob({ label: 'Spectroscopy · channel fits', stop: () => { stopFlag = true; }, show: () => $('bChan').scrollIntoView({ block: 'center' }) });
  try {
    await table();
    const wf = P.whiteFit; let chans = P.channels;
    if (P.settings.commonMode) chans = SP.applyCommonMode(chans, { time: wf.time, ratio: Float64Array.from(wf.resid, (r, i) => 1 + r / wf.model[i]), err: null });
    const n = chans.length, nw = Math.max(1, Math.min(o.workers ?? 6, (navigator.hardwareConcurrency || 4) - 1, n)), out = new Array(n), t0 = performance.now();
    const lds = chans.map((c) => ldFor(c.lo, c.hi)), base = { ...lcOpts(), keep: true, ldSigma: o.ldSigma || 0, ...(o.geometry === 'prior' ? { geometry: 'prior', geoPriors: { ...o.geoPriors } } : {}) };
    killPool(); pool = Array.from({ length: nw }, mkWorker);
    let next = 0, done = 0, failed = 0;
    await Promise.all(pool.map(async (w) => {
      while (!stopFlag) {
        const k = next++; if (k >= n) break;
        try { out[k] = await runOn(w, { type: 'channel', ch: chans[k], geo: wf.values, opts: { ...base, ld: lds[k].coeffs, ldLaw: lds[k].law } }); out[k].ldExtrapolated = !!lds[k].extrapolated; }
        catch (err) { if (stopFlag) break; failed++; out[k] = null; console.warn('channel', k, err.message); }
        done++; $('pgChan').value = done / n; job.update({ fraction: done / n, detail: `channel ${done} of ${n}` }); setStatus('stChan', `Channel ${done} of ${n} on ${nw} worker${nw > 1 ? 's' : ''} …`); if (o.onProgress) o.onProgress({ done, n });
      }
    }));
    killPool();
    P.results = out; P.spectrum = SP.spectrumTable(out.filter(Boolean));
    const sp = P.spectrum, er = sp.map((r) => r.err);
    setStatus('stChan', stopFlag ? `Stopped after ${done} of ${n} channels.` : `${sp.length} channels in ${((performance.now() - t0) / 1000).toFixed(1)} s on ${nw} worker${nw > 1 ? 's' : ''}${failed ? `; ${failed} could not be fitted` : ''}. Depth errors ${ppm(Math.min(...er))} to ${ppm(Math.max(...er))} ppm.`, failed ? 'err' : 'ok');
    redraw(); job.finish(stopFlag ? 'Stopped' : 'Spectrum ready');
    return sp;
  } catch (err) { setStatus('stChan', err.message, 'err'); job.fail('Channel fits failed'); throw err; } finally { P.busy = false; $('bChan').disabled = false; $('bStop').hidden = true; $('pgChan').hidden = true; }
}

// ------------------------------------------------------------------------------------------- drawing
const draw = (id, hCss, fn, data) => { const cv = $(id); if (!cv || !cv.offsetParent) return; const { ctx, W, H } = fitCanvas(cv, hCss); fn(ctx, W, H, data, SPEC_THEME); };
const narrow = () => window.innerWidth < 700;
function specData() {
  const sh = P.kind === 'transit' ? scale() : null;
  return { rows: P.spectrum || [], kind: P.kind, title: `${P.name} · ${P.kind === 'eclipse' ? 'emission' : 'transmission'} spectrum`, truth: P.sim ? P.sim.truth : null, white: P.whiteFit && P.whiteFit.depth ? { depth: P.whiteFit.depth.median, plus: P.whiteFit.depth.plus, minus: P.whiteFit.depth.minus } : null, scale: sh, logX: P.clean && P.clean.wave[P.clean.nW - 1] / P.clean.wave[0] > 4 };
}
function redraw() {
  if (!P.cube) return;
  const c = P.clean, m = P.cube.meta || {};
  $('sumData').replaceChildren(...[
    ['Integrations', String(c.nT), `${(c.exptime * 86400).toFixed(1)} s each`], ['Wavelengths', String(c.nW), `${c.wave[0].toFixed(2)}–${c.wave[c.nW - 1].toFixed(2)} µm`],
    ['Span', ((c.time[c.nT - 1] - c.time[0]) * 24).toFixed(2) + ' h', 'from BJD ' + c.time[0].toFixed(4)], ['Replaced', String(c.replaced), `points beyond ${P.settings.clean.nsigma}σ in time`],
    ['Columns left out', String(c.deadColumns), c.outlierColumns ? `${c.outlierColumns} by the spectral test` : 'flagged or unusable'], ['Channels', String(P.channels.length), P.white ? `white light: ${ppm(P.white.err[0])} ppm per point` : ''],
  ].map(([k, v, s]) => h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, ' ', h('small', {}, s)))));
  $('binInfo').textContent = `${P.channels.length} channel${P.channels.length === 1 ? '' : 's'}`;
  draw('cvImg', narrow() ? 260 : 340, renderCubeImage, { ...c, bins: P.bins, title: `${P.source.kind === 'simulation' ? 'Simulated' : m.instrument || 'Spectra'} ${m.grating || m.mode || ''} ${m.detector || ''} · each wavelength divided by its median`.replace(/\s+/g, ' ') });
  const wf = P.whiteFit, w = P.white;
  draw('cvWhite', narrow() ? 300 : 360, renderLightCurve, wf ? { time: wf.time, flux: w.flux, err: w.err, model: wf.model, resid: wf.resid, title: `White light ${w.lo.toFixed(2)}–${w.hi.toFixed(2)} µm` } : { time: w.time, flux: w.flux, err: w.err, title: `White light ${w.lo.toFixed(2)}–${w.hi.toFixed(2)} µm (not fitted)` });
  whiteTable();
  draw('cvSpec', narrow() ? 280 : 380, renderSpectrum, specData());
  const res = P.results.filter(Boolean);
  $('cvNoise').parentElement.parentElement.hidden = !res.length; $('cvGrid').parentElement.hidden = !res.length; $('chanTable').hidden = !res.length;
  if (res.length) {
    draw('cvNoise', 240, renderNoise, { rows: res });
    const sel = res[Math.min(P.sel, res.length - 1)];
    draw('cvBeta', 240, renderBinnedRms, { binned: sel.binned, dtMin: c.exptime * 1440, title: `Binned residuals · ${sel.wl.toFixed(3)} µm · β = ${Number.isFinite(sel.beta) ? sel.beta.toFixed(2) : '–'}` });
    const cols = Math.max(2, Math.floor(($('cvGrid').parentElement.clientWidth || 600) / 170)), shown = res.length > 60 ? res.filter((_, i) => i % Math.ceil(res.length / 60) === 0) : res;
    draw('cvGrid', Math.ceil(shown.length / cols) * 92, renderChannelGrid, { cells: shown.map((r) => ({ wl: r.wl, time: r.time, detrended: r.detrended, transit: r.transit, depth: r.depth })), cols });
    chanTable(res);
  }
  interpret();
}
function whiteTable() {
  const wf = P.whiteFit, el = $('whiteTable');
  if (!wf) { el.replaceChildren(h('p', { class: 'hint' }, 'The white light curve is every wavelength added together. Its fit gives the mid-time and the inclination that all channels then share.')); return; }
  const lab = { rprs: 'Rp/R★', tmid: 'T mid (BJD)', inc: 'i (°)', fpfs: 'Fp/F★', rstar: 'R★ (R☉)' }, dig = { tmid: 6, rprs: 5, inc: 3, fpfs: 5, rstar: 4 };
  const rows = wf.parameters.map((p) => h('tr', {}, h('td', {}, lab[p.key] || p.key), h('td', {}, p.median.toFixed(dig[p.key] ?? 5)), h('td', {}, '+' + p.plus.toFixed(dig[p.key] ?? 5)), h('td', {}, '−' + p.minus.toFixed(dig[p.key] ?? 5))));
  rows.push(h('tr', {}, h('td', {}, 'a/R★' + (P.settings.kepler ? ' (Kepler)' : ' (fixed)')), h('td', {}, wf.values.ars.toFixed(3)), h('td', {}, ''), h('td', {}, '')));
  if (wf.depth) rows.push(h('tr', {}, h('td', {}, 'depth (ppm)'), h('td', {}, ppm(wf.depth.median)), h('td', {}, '+' + ppm(wf.depth.plus)), h('td', {}, '−' + ppm(wf.depth.minus))));
  rows.push(h('tr', {}, h('td', {}, 'rms (ppm)'), h('td', {}, ppm(wf.stats.rms)), h('td', { colspan: 2 }, `expected ${ppm(wf.stats.expected)}`)));
  rows.push(h('tr', {}, h('td', {}, 'limb darkening'), h('td', { colspan: 3 }, wf.ld.map((x) => x.toFixed(3)).join(', ') + ' (fixed)')));
  el.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'median'), h('th', {}, '+1σ'), h('th', {}, '−1σ'))), h('tbody', {}, rows)));
}
function chanTable(res) {
  const body = res.map((r, i) => h('tr', { class: i === P.sel ? 'sel' : '', tabindex: 0, onclick: () => { P.sel = i; redraw(); } },
    h('td', {}, r.wl.toFixed(3)), h('td', {}, `${r.lo.toFixed(3)}–${r.hi.toFixed(3)}`), h('td', {}, ppm(r.depth)), h('td', {}, '+' + ppm(r.depthPlus)), h('td', {}, '−' + ppm(r.depthMinus)), h('td', {}, ppm(r.rms)), h('td', {}, ppm(r.expected)), h('td', {}, Number.isFinite(r.beta) ? r.beta.toFixed(2) : '–'), h('td', {}, r.errScale.toFixed(2))));
  $('chanTable').replaceChildren(h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...['λ (µm)', 'range', 'depth (ppm)', '+1σ', '−1σ', 'rms', 'expected', 'β', 'error scale'].map((t) => h('th', {}, t)))), h('tbody', {}, body))));
}
/** The spectrum against the injected one of a simulation: pulls (depth - injected) / error, each channel against the
 *  nearest injected channel. Only comparable when every simulated channel is its own bin (native binning). */
function injected() {
  const sp = P.spectrum; if (!P.sim || !sp || !sp.length) return null;
  const tr = P.sim.truth, pulls = sp.map((r) => { const q = tr.reduce((a, b) => (Math.abs(b.wl - r.wl) < Math.abs(a.wl - r.wl) ? b : a)); return (r.depth - q.depth) / r.err; });
  const m = pulls.reduce((a, b) => a + b, 0) / pulls.length, s = Math.sqrt(pulls.reduce((a, b) => a + (b - m) ** 2, 0) / pulls.length);
  return { pulls, mean: m, sd: s, comparable: P.settings.bins.mode === 'native' };
}
function interpret() {
  const sp = P.spectrum, el = $('interp');
  if (!sp || !sp.length) { el.textContent = ''; return; }
  const lo = Math.min(...sp.map((r) => r.depth)), hi = Math.max(...sp.map((r) => r.depth)), med = sp.map((r) => r.err).sort((a, b) => a - b)[sp.length >> 1];
  const ratio = P.results.filter(Boolean).map((r) => r.ratio), mr = ratio.reduce((a, b) => a + b, 0) / ratio.length, betas = P.results.filter(Boolean).map((r) => r.beta).filter(Number.isFinite), mb = betas.length ? betas.reduce((a, b) => a + b, 0) / betas.length : NaN;
  let t = `${sp.length} channels; the depth runs from ${ppm(lo)} to ${ppm(hi)} ppm with a typical 1σ error of ${ppm(med)} ppm. Residual scatter is ${mr.toFixed(2)} × the error bars on average${Number.isFinite(mb) ? `, β = ${mb.toFixed(2)}` : ''}. `;
  const sh = P.kind === 'transit' ? scale() : null;
  if (sh) { const x = SP.toScaleHeights(sp, { H: sh.H, rplanet: sh.rplanet, rstar: P.star.rstar }); t += `For orientation: with T_eq = ${sh.teq.toFixed(0)} K, μ = 2.3 and g = ${sh.g.toFixed(1)} m/s² the scale height is ${(sh.H / 1000).toFixed(0)} km, or ${ppm(sh.depthPerH)} ppm of depth, so the spectrum spans about ${x.span.toFixed(1)} scale heights and one error bar is ${(med / sh.depthPerH).toFixed(1)}. `; }
  const inj = injected(); if (inj && inj.comparable) t += `Against the injected spectrum (green): mean pull ${inj.mean.toFixed(2)}, standard deviation ${inj.sd.toFixed(2)} (0 and 1 when the errors are right).`;
  if (P.results.some((r) => r && r.ldExtrapolated)) t += ' Channels beyond 5.5 µm use limb darkening from the reddest part of the table.';
  el.textContent = t;
}

// ------------------------------------------------------------------------------------------- exports, session, hand-off
const download = (data, type, name) => { const a = h('a', { href: URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const stem = () => P.name.replace(/[^\w.\-]+/g, '_');
function meta() {
  const wf = P.whiteFit, s = P.settings, m = (P.source && P.source.meta) || {};
  return { target: P.name, kind: P.kind, source: P.source ? P.source.kind : null, instrument: [m.instrument || m.telescope, m.grating || m.mode, m.detector].filter(Boolean).join(' ') || null, files: P.source && P.source.files.length ? P.source.files.join(' ') : null,
    binning: JSON.stringify(s.bins), baseline: s.baseline + (s.steps.length ? ' + step at ' + s.steps.map((x) => x.toFixed(5)).join(' ') : ''), limb_darkening: s.ldLaw + ', fixed per channel from the PHOENIX spectral table', error_bars: s.errorMode, common_mode: s.commonMode,
    tmid_bjd_tdb: wf ? +wf.values.tmid.toFixed(6) : null, inc_deg: wf ? +wf.values.inc.toFixed(4) : null, a_over_rstar: wf ? +wf.values.ars.toFixed(4) : null, period_d: P.sys.per, white_depth: wf && wf.depth ? +wf.depth.median.toPrecision(6) : null, created: new Date().toISOString(),
    note: P.sim ? 'SIMULATED data: simple radiometric noise estimate, toy spectrum' : 'geometry fixed at the white-light solution; its uncertainty is not in the channel errors' };
}
function sessionDoc() {
  if (!P.cube) throw new Error('Nothing to save yet.');
  return SP.spectroscopyToSession({ name: P.name, star: { ...P.star }, system: { ...P.sys }, kind: P.kind, ldLaw: P.settings.ldLaw, whiteLd: P.whiteLd ? P.whiteLd.coeffs : [], white: P.white, channels: P.channels, bins: P.settings.bins, settings: { ...P.settings, clean: { ...P.settings.clean } }, whiteFit: P.whiteFit, spectrum: P.spectrum, source: P.source ? { kind: P.source.kind, files: P.source.files, meta: P.source.meta } : null, simulation: P.sim });
}
function restore(doc) {
  const st = SP.spectroscopyFromSession(doc);
  P.name = st.name; P.kind = st.kind; P.star = st.star; P.sys = { ...st.system }; P.sim = st.simulation; Object.assign(P.settings, st.settings || {}); P.settings.steps = (st.settings && st.settings.steps) || [];
  // the session holds the binned light curves, not the spectra: they become a cube whose columns are the channels
  const ch = st.channels, nT = st.white.time.length, nW = ch.length, flux = new Float64Array(nT * nW), err = new Float64Array(nT * nW);
  if (ch.some((c) => c.time.length !== nT)) throw new Error('This session has channels of different lengths and cannot be restored as a cube.');
  ch.forEach((c, j) => { const s = c.scale || 1; for (let i = 0; i < nT; i++) { flux[i * nW + j] = c.flux[i] * s; err[i * nW + j] = c.err[i] * Math.abs(s); } });
  const cube = { time: st.white.time, wave: Float64Array.from(ch, (c) => c.wl), lo: Float64Array.from(ch, (c) => c.lo), hi: Float64Array.from(ch, (c) => c.hi), flux, err, bad: new Uint8Array(nT * nW), nT, nW, exptime: st.white.exptime, meta: { ...((st.source && st.source.meta) || {}), restored: true } };
  $('inPlanet').value = P.name; buildSys(); $('baseline').value = P.settings.baseline || 'linear'; $('ldLaw').value = P.settings.ldLaw || 'quadratic'; $('errMode').value = P.settings.errorMode || 'max'; $('commonMode').checked = !!P.settings.commonMode; $('kepler').checked = !!P.settings.kepler;
  const steps = P.settings.steps.slice();
  setCube(cube, { kind: (st.source && st.source.kind) || 'session', files: (st.source && st.source.files) || [], meta: cube.meta });
  P.settings.steps = steps; P.spectrum = st.spectrum || null;
  setStatus('stLoad', `Session restored: ${nW} channels × ${nT} points${st.spectrum ? `, with its spectrum (${st.spectrum.length} channels)` : ''}. The original spectra are not in a session; the channels are as they were binned. Fit again to see the light curves.`, 'ok');
  redraw();
  return summary();
}
function whiteCsv() {
  const wf = P.whiteFit, w = P.white, rows = ['BJD_TDB,flux,flux_err'];
  for (let i = 0; i < w.time.length; i++) rows.push(`${w.time[i].toFixed(7)},${(wf ? wf.detrended[i] : w.flux[i]).toFixed(7)},${(w.err[i] * (wf ? wf.errScale : 1)).toFixed(7)}`);
  return rows.join('\n') + '\n';
}
function exportAs(kind, o = {}) {
  const save = o.download !== false;
  if (kind === 'session') { const t = JSON.stringify(sessionDoc()); if (save) download(t, 'application/json', stem() + '_spectroscopy.json'); return t; }
  if (kind === 'white') { const t = whiteCsv(); if (save) download(t, 'text/csv', stem() + '_white_light.csv'); return t; }
  if (!P.spectrum || !P.spectrum.length) { setStatus('stChan', 'There is no spectrum yet: fit the channels first.', 'err'); return null; }
  if (kind === 'csv') { const t = SP.spectrumToCSV(P.spectrum, meta()); if (save) download(t, 'text/csv', stem() + '_spectrum.csv'); return t; }
  if (kind === 'ecsv') { const t = SP.spectrumToECSV(P.spectrum, meta()); if (save) download(t, 'text/plain', stem() + '_spectrum.ecsv'); return t; }
  if (kind === 'png') {
    const W = o.width || 1200, H = o.height || 640, cv = Object.assign(document.createElement('canvas'), { width: W * 2, height: H * 2 }), ctx = cv.getContext('2d'); ctx.scale(2, 2);
    renderSpectrum(ctx, W, H, specData(), o.theme === 'dark' ? SPEC_DARK : PRINT_THEME);
    if (save) cv.toBlob((b) => download(b, 'image/png', stem() + '_spectrum.png'), 'image/png');
    return cv.toDataURL('image/png');
  }
  throw new Error('Unknown export: ' + kind + ' (png, csv, ecsv, session, white).');
}
function openInAnalyze() {
  if (!P.white) { setStatus('stWhite', 'There is no white light curve yet.', 'err'); return; }
  const hand = handoffRecord();
  try { localStorage.setItem('esl.handoff', JSON.stringify(hand)); } catch { setStatus('stWhite', 'Could not hand the light curve over (storage is full or blocked): save the session and open it in Analyze.', 'err'); return; }
  location.href = new URL('analyze/?handoff=1', siteRoot()).href;
}
/** What "Open in Analyze" leaves for the analyzer: the white light curve (detrended once fitted) and its metadata. */
function handoffRecord() {
  const wf = P.whiteFit; return { kind: 'lightcurve', name: `${P.name} white light${wf ? ' (detrended)' : ''}`, text: whiteCsv(), source: 'spectroscopy', exptime: P.white.exptime * 86400, exptimeDays: P.white.exptime, target: P.name, timeSystem: 'BJD_TDB', filter: `${P.white.lo.toFixed(2)}-${P.white.hi.toFixed(2)} micron`, planet: P.name, detrended: !!wf };
}

// ------------------------------------------------------------------------------------------- scripted surface
const summary = () => ({ name: P.name, kind: P.kind, source: P.source && P.source.kind, integrations: P.clean ? P.clean.nT : 0, wavelengths: P.clean ? P.clean.nW : 0, range: P.clean ? [P.clean.wave[0], P.clean.wave[P.clean.nW - 1]] : null, channels: P.channels.length, replaced: P.clean ? P.clean.replaced : 0, columnsLeftOut: P.clean ? P.clean.deadColumns : 0, whiteFitted: !!P.whiteFit, spectrum: P.spectrum ? P.spectrum.length : 0, settings: JSON.parse(JSON.stringify(P.settings)) });
const whiteSummary = () => { const wf = P.whiteFit; return wf ? { parameters: wf.parameters, values: wf.values, depth: wf.depth, rms: wf.stats.rms, expected: wf.stats.expected, ratio: wf.stats.ratio, beta: wf.stats.beta, errScale: wf.errScale, converged: wf.converged, ncalls: wf.ncalls, ld: wf.ld } : null; };
const api = {
  /** Open files: File objects, or { name, buffer } / { name, textContent }. A saved session (.json) restores it. */
  load,
  /** Simulate: { planet, telescope: 'Ariel' | 'JWST', mode (a name in bands()), R, area, throughput, noiseFloorPpm, excess, cadence, featurePpm, seed, kind }. */
  simulate,
  /** Bins: { mode: 'R' | 'width' | 'n' | 'columns' | 'native', R | width | n | columns, wlMin, wlMax }. */
  setBins: (o) => { readSettings(); return applyBins(o || P.settings.bins); },
  /** Settings of the fits: { baseline, ldLaw, errorMode, commonMode, kepler, steps: [BJD] }. */
  set: (o = {}) => { for (const [k, id] of [['baseline', 'baseline'], ['ldLaw', 'ldLaw'], ['errorMode', 'errMode']]) if (o[k]) $(id).value = o[k]; if ('commonMode' in o) $('commonMode').checked = !!o.commonMode; if ('kepler' in o) $('kepler').checked = !!o.kepler; if (o.steps) P.settings.steps = o.steps.slice(); readSettings(); return summary().settings; },
  setSystem: (o = {}) => { for (const [k, , where] of SYS_FIELDS) if (k in o) P[where][k] = o[k]; if (o.name) P.name = o.name; if (o.kind) P.kind = o.kind; buildSys(); sysChanged(); return { system: { ...P.sys }, star: { ...P.star } }; },
  lookup, fitWhite, findStep: addStep, fitChannels,
  /** The spectrum rows: [{ wl, lo, hi, depth, plus, minus, err, rms, expected, beta, ... }] or null. */
  spectrum: () => (P.spectrum ? P.spectrum.map((r) => ({ ...r })) : null),
  white: whiteSummary,
  /** 'png' | 'csv' | 'ecsv' | 'session' | 'white'; { download: false } returns the text (a data URL for png) without saving a file. */
  export: exportAs,
  state: summary, bands: () => Object.keys(MISSION_BANDS), openInAnalyze, restore,
};
window.__esl = Object.assign(window.__esl || {}, { spectra: api });
window.__spec = P;

// ------------------------------------------------------------------------------------------- wiring
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const fs = [...(e.dataTransfer.files || [])]; if (fs.length) load(fs).catch(() => {}); });
let rz = 0; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(redraw, 120); });
buildSys(); simModes(); hints();
const q = new URLSearchParams(location.search);
if (q.has('demo')) simulate({ telescope: q.get('demo') === 'jwst' ? 'JWST' : 'Ariel' }).then(() => fitChannels()).catch((e) => console.warn(e));

// ------------------------------------------------------------------------------------------- window.__esl.spectroscopy
// What the site's assistant drives (the contract is at the top of src/assistant/pages.js). Every tool goes through the
// page's own functions above (load, simulate, applyBins, fitWhite, fitChannels, exportAs, handoffRecord) and the page
// shows what it did. Results are compact: depths in ppm with their +/- 1 sigma, never the light curves themselves.
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra }), B = (description) => ({ type: 'boolean', description });
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const r4 = (x) => (Number.isFinite(x) ? +x.toPrecision(4) : null), r6 = (x) => (Number.isFinite(x) ? +x.toPrecision(6) : null), um = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
  const pp = (x) => (Number.isFinite(x) ? +(1e6 * x).toFixed(1) : null);
  const meanOf = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const ACCEPT = /\.(fits|fit|fts)(\.gz)?$|\.(csv|ecsv|txt|dat|json)$/i;
  const needData = () => { if (!P.cube) throw new Error('nothing is loaded: spectroscopy_load_files (attached x1dints FITS, CSV/ECSV or a saved session) or spectroscopy_simulate first'); };
  const notBusy = () => { if (P.busy) throw new Error('a fit is running on the page: wait for it to finish'); };
  const fitsExist = () => !!(P.whiteFit || (P.spectrum && P.spectrum.length));
  const status = (id) => { const el = $(id); return el && el.textContent ? el.textContent : undefined; };
  const sysOut = () => ({ planet: P.name, kind: P.kind, system: Object.fromEntries(Object.entries(P.sys).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, k === 'tmid' ? +v.toFixed(6) : r6(v)])), star: Object.fromEntries(Object.entries(P.star).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, r6(v)])) });
  const settingsOut = () => { const s = P.settings; return { binning: { ...s.bins }, clip_sigma: s.clean.nsigma, clip_window: s.clean.window, baseline: s.baseline, ld_law: s.ldLaw, ld_source: 'PHOENIX spectral table for the star (Teff, log g, [Fe/H]) over each channel, fixed', error_bars: s.errorMode, common_mode: s.commonMode, kepler: s.kepler, steps_bjd: s.steps.map((x) => +x.toFixed(5)) }; };
  const dataOut = () => {
    if (!P.cube) return { loaded: false, how: 'Attach x1dints FITS files (all segments and both detectors of one exposure), a CSV/ECSV table with time, wavelength, flux, flux_err, or a session saved from this page, then spectroscopy_load_files; or spectroscopy_simulate for an Ariel or JWST observation. The page reads extracted 1-D spectra only.' };
    const c = P.clean, m = P.cube.meta || {};
    return { loaded: true, source: P.source.kind, files: P.source.files.length ? P.source.files : undefined, instrument: [m.instrument || m.telescope, m.grating || m.mode, m.filter, m.detector].filter(Boolean).join(' ') || undefined, target_in_files: m.target, time_system: m.timeSystem,
      integrations: c.nT, exposure_s: r4(c.exptime * 86400), span_h: r4((c.time[c.nT - 1] - c.time[0]) * 24), first_bjd: +c.time[0].toFixed(5), wavelengths: c.nW, range_um: [um(c.wave[0]), um(c.wave[c.nW - 1])],
      points_replaced: c.replaced, columns_left_out: c.deadColumns, columns_left_out_by_spectral_test: c.outlierColumns, channels: P.channels.length,
      white_light: P.white ? { range_um: [um(P.white.lo), um(P.white.hi)], error_per_point_ppm: pp(P.white.err[0]) } : undefined, converted: [m.wavelengthConverted, m.timeConverted].filter(Boolean).join('; ') || undefined };
  };
  const whiteOut = () => {
    const wf = P.whiteFit; if (!wf) return null;
    const par = Object.fromEntries(wf.parameters.map((p) => [p.key, p.key === 'tmid' ? { value: +p.median.toFixed(6), plus: +p.plus.toFixed(6), minus: +p.minus.toFixed(6) } : { value: r6(p.median), plus: r4(p.plus), minus: r4(p.minus) }]));
    return { free: par, a_over_rstar: { value: r6(wf.values.ars), how: P.settings.kepler && P.kind === 'transit' ? 'Kepler law from M*, R*, P' : 'fixed' }, depth_ppm: wf.depth ? { value: pp(wf.depth.median), plus: pp(wf.depth.plus), minus: pp(wf.depth.minus) } : null,
      residual_rms_ppm: pp(wf.stats.rms), expected_rms_ppm: pp(wf.stats.expected), rms_over_expected: r4(wf.stats.ratio), beta: r4(wf.stats.beta), error_scale: r4(wf.errScale), limb_darkening: { law: wf.ldLaw, coeffs: wf.ld.map(r4), fixed: true, extrapolated_beyond_table: !!(P.whiteLd && P.whiteLd.extrapolated) },
      baseline: wf.baselineKind, steps_bjd: P.settings.steps.map((x) => +x.toFixed(5)), converged: wf.converged, likelihood_calls: wf.ncalls, seconds: r4(wf.seconds), ln_Z: r6(wf.logZ), warnings: wf.warnings && wf.warnings.length ? wf.warnings : undefined };
  };
  const row = (r) => ({ wl_um: um(r.wl), lo_um: um(r.lo), hi_um: um(r.hi), depth_ppm: pp(r.depth), plus_ppm: pp(r.plus), minus_ppm: pp(r.minus), rms_ppm: pp(r.rms), expected_ppm: pp(r.expected), beta: r4(r.beta) });
  const spectrumSummary = () => {
    const sp = P.spectrum; if (!sp || !sp.length) return null;
    const er = sp.map((r) => r.err).sort((a, b) => a - b), res = P.results.filter(Boolean);
    return { channels: sp.length, depth_range_ppm: [pp(Math.min(...sp.map((r) => r.depth))), pp(Math.max(...sp.map((r) => r.depth)))], typical_error_ppm: pp(er[sp.length >> 1]), error_range_ppm: [pp(er[0]), pp(er[er.length - 1])],
      mean_rms_over_expected: res.length ? r4(meanOf(res.map((r) => r.ratio))) : undefined, mean_beta: res.length ? r4(meanOf(res.map((r) => r.beta).filter(Number.isFinite))) : undefined };
  };
  const fileFor = (files, name) => {
    const rec = files.get(name); if (!rec) throw new Error(`there is no attached file "${name}"`);
    if (rec.blob) return new File([rec.blob], name);
    if (typeof rec.text === 'string') { if (/\.(fits|fit|fts)(\.gz)?$/i.test(name)) throw new Error(`${name} was attached as text, not as a binary FITS file: ask the user to attach it again`); return { name, textContent: rec.text }; }
    throw new Error(`${name} has no content in this conversation (too large to keep?): ask the user to open it on the page instead`);
  };
  const setVal = (id, v) => { if (v === undefined) return; const el = $(id); el.value = v; };

  const tools = [
    { name: 'spectroscopy_describe', core: true, readOnly: true,
      description: 'What the spectroscopy page holds now: the data (source, instrument, integrations x wavelengths, range, cleaning counts, channels), planet and star, every setting (binning, clipping, baseline, limb darkening, error bars, common mode, Kepler, steps), the white-light fit and the spectrum in brief, the simulation inputs, and the status lines the page shows.',
      parameters: obj({}),
      run() {
        return { data: dataOut(), ...sysOut(), settings: settingsOut(), white_fit: whiteOut() || 'not fitted', spectrum: spectrumSummary() || 'none yet', simulation: P.sim ? { telescope: P.sim.inputs.telescope, bands: P.sim.inputs.bands, cadence_s: P.sim.inputs.cadence_s, inputs: Object.fromEntries(Object.entries(P.sim.inputs).filter(([, v]) => typeof v !== 'object')) } : undefined, busy: P.busy,
          status: Object.fromEntries([['load', 'stLoad'], ['simulation', 'stSim'], ['planet', 'stSys'], ['binning', 'stBins'], ['white_fit', 'stWhite'], ['channels', 'stChan']].map(([k, id]) => [k, status(id)]).filter(([, v]) => v)) };
      } },
    { name: 'spectroscopy_modes', readOnly: true,
      description: 'The telescopes and instrument modes the simulator knows (Ariel and JWST): collecting area, default throughput and noise floor, and for every band its wavelength range, resolving power, kind (spectrometer or photometer), the default simulated R, and whether it reaches beyond the limb-darkening table (5.5 um).',
      parameters: obj({ telescope: T('Only this telescope.', { enum: ['Ariel', 'JWST'] }) }),
      run({ telescope }) {
        return Object.fromEntries(Object.entries(TELESCOPES).filter(([k]) => !telescope || k === telescope).map(([k, t]) => [k, { area_m2: t.area, throughput: t.throughput, noise_floor_ppm: t.noiseFloorPpm, default_bands: t.bands, modes: bandsOf(k).map((b) => ({ mode: b.name, label: b.mode, range_um: b.micron, R: b.R, kind: b.kind, simulated_R: t.simR[b.name], beyond_ld_table: b.beyondTable || undefined, note: b.note || undefined })),
          note: k === 'Ariel' ? 'mode "" (or omitted) simulates all six Ariel channels together' : 'one JWST mode per simulation' }]));
      } },
    { name: 'spectroscopy_load_files', core: true,
      description: 'Load files the user attached to this chat into the spectroscopy page: JWST x1dints FITS (all segments and both detectors of one exposure together: they are joined in time and wavelength), a CSV / ECSV / text table with time, wavelength, flux, flux_err, or a session saved from this page (.json, restores it). Outliers are cleaned and the default binning applied.',
      confirm: () => (P.cube ? 'Loading these files replaces the spectra, fits and spectrum on the spectroscopy page.' : null),
      parameters: obj({ files: { type: 'array', items: T('file name'), description: 'Names of attached files (see list_files). Omit for every attached file the page can read.' } }),
      async run({ files: names }, { files }) {
        notBusy();
        const all = files.list().filter((f) => (names ? names.includes(f.name) : ACCEPT.test(f.name)));
        if (names) { const miss = names.filter((n) => !all.some((f) => f.name === n)); if (miss.length) throw new Error(`no attached file named ${miss.join(', ')}; attached: ${files.list().map((f) => f.name).join(', ') || 'none'}`); }
        if (!all.length) throw new Error('no attached file the page can read (.fits x1dints, .csv, .ecsv, .txt, .dat, or a .json session): ask the user to attach them (the paperclip), or to open them on the page');
        await load(all.map((f) => fileFor(files, f.name)));
        return { loaded: all.map((f) => f.name), data: dataOut(), settings: settingsOut(), note: status('stLoad'), planet_note: status('stSys'), next: 'Check the planet and star (spectroscopy_set_planet), the binning (spectroscopy_set_binning), then spectroscopy_fit_white.' };
      } },
    { name: 'spectroscopy_simulate', core: true,
      description: 'Simulate a time-series observation of the planet on the page (or of "planet", looked up first) with Ariel or JWST: photon noise of a black-body star through the area and throughput, plus a noise floor; injected spectrum a level with Gaussian features at 1.4, 2.8 and 4.3 um. Without arguments this is the page\'s demo for the telescope chosen. Not ArielRad or PandExo.',
      confirm: () => (P.cube ? 'Simulating replaces the spectra, fits and spectrum on the spectroscopy page.' : null),
      parameters: obj({
        telescope: T('Telescope (default: the one chosen on the page, Ariel at first).', { enum: ['Ariel', 'JWST'] }), mode: T('Instrument mode from spectroscopy_modes, e.g. "JWST NIRSpec G395H"; "" for all six Ariel channels. Default: all Ariel channels, or JWST NIRSpec PRISM.'),
        planet: T('Look this planet up in the catalogue first (e.g. "WASP-39 b").'), kind: T('Transit (transmission) or eclipse (emission).', { enum: ['transit', 'eclipse'] }),
        R: N('Resolving power of the simulated channels (default: the mode\'s own).', { minimum: 2 }), area_m2: N('Collecting area in m^2 (default: the telescope\'s).', { minimum: 0.01 }), throughput: N('Fraction of photons detected, 0 to 1 (default 0.3).', { minimum: 0.01, maximum: 1 }),
        noise_floor_ppm: N('Noise floor in ppm over one transit duration (default 20 Ariel, 10 JWST).', { minimum: 0 }), excess_percent: N('Noise above photon noise, in percent (default 0).', { minimum: 0 }), cadence_s: N('Time per exposure in seconds (default 60).', { minimum: 1 }),
        feature_ppm: N('Height of the injected features in ppm (default 400).', { minimum: 0 }), seed: { type: 'integer', description: 'Random seed (default 1).' }, slope_ppm_per_hr: N('A linear trend in time injected into every channel, ppm per hour (default 0).') }),
      async run(a) {
        notBusy();
        if (a.mode !== undefined && a.mode !== '' && !MISSION_BANDS[a.mode]) throw new Error(`unknown mode "${a.mode}"; the modes are: ${Object.keys(MISSION_BANDS).join(', ')}`);
        const tel = a.telescope || (a.mode ? MISSION_BANDS[a.mode].mission : $('simTel').value);
        if (a.mode && MISSION_BANDS[a.mode].mission !== tel) throw new Error(`${a.mode} is not a mode of ${tel}`);
        if (tel === 'JWST' && a.mode === '') throw new Error('JWST is simulated one mode at a time: give a mode (spectroscopy_modes)');
        if ($('simTel').value !== tel) { $('simTel').value = tel; simModes(); }
        if (a.mode !== undefined) $('simMode').value = a.mode;
        setVal('simArea', a.area_m2); setVal('simThr', a.throughput); setVal('simFloor', a.noise_floor_ppm); setVal('simExcess', a.excess_percent); setVal('simCad', a.cadence_s); setVal('simR', a.R); setVal('simAmp', a.feature_ppm); setVal('simSeed', a.seed);
        const r = await simulate({ planet: a.planet, kind: a.kind, slopePpmPerHr: a.slope_ppm_per_hr });
        const tr = r.truth, sg = tr.map((t) => t.sigma);
        return { simulated: `${tel} ${$('simMode').value ? MISSION_BANDS[$('simMode').value].mode : 'all channels'}`, planet: P.name, kind: P.kind, channels: r.channels, exposures: r.points, cadence_s: r.inputs.cadence_s, noise_per_exposure_ppm: [pp(Math.min(...sg)), pp(Math.max(...sg))], range_um: [um(tr[0].lo), um(tr[tr.length - 1].hi)],
          injected_depth_ppm: [pp(Math.min(...tr.map((t) => t.depth))), pp(Math.max(...tr.map((t) => t.depth)))], inputs: { area_m2: num('simArea'), throughput: num('simThr'), noise_floor_ppm: num('simFloor'), excess_percent: num('simExcess'), R: $('simR').value ? num('simR') : 'mode default', feature_ppm: num('simAmp'), seed: num('simSeed') }, note: status('stSim'), next: 'spectroscopy_fit_white, then spectroscopy_fit_channels.' };
      } },
    { name: 'spectroscopy_set_planet',
      description: 'Set the planet and star the fits start from: look a planet up in the site\'s catalogue ("lookup"), and/or set numbers by hand (period, mid-time BJD, Rp/R*, a/R*, inclination, e, omega, planet mass, Fp/F*, star Teff, log g, [Fe/H], R*, M*, distance), and transit or eclipse. Limb darkening and the simulator use the star. Discards the fits.',
      confirm: () => (fitsExist() ? 'Changing the planet or star discards the white-light fit and the spectrum on the page.' : null),
      parameters: obj({ lookup: T('Planet name to look up in the catalogue, e.g. "WASP-39 b". Applied before the numbers below.'), name: T('Name to show for the planet when the numbers are typed in (no look-up).'), kind: T('Transit (transmission spectrum) or eclipse (emission spectrum).', { enum: ['transit', 'eclipse'] }),
        per: N('Period (days).'), tmid: N('Mid-transit time (BJD_TDB).'), rprs: N('Rp/R*.'), ars: N('a/R* (fixed in the fits, or from Kepler\'s law).'), inc: N('Inclination (degrees).'), ecc: N('Eccentricity.'), omega: N('Argument of periastron (degrees).'), mplanet: N('Planet mass (Jupiter masses), for the scale height.'), fpfs: N('Planet-to-star flux ratio Fp/F* (eclipse).'),
        teff: N('Stellar effective temperature (K).'), logg: N('Stellar log g (cgs).'), feh: N('Stellar [Fe/H].'), rstar: N('Stellar radius (R_sun).'), mstar: N('Stellar mass (M_sun).'), distance: N('Distance (pc), for the simulator.') }),
      async run(a) {
        notBusy();
        if (a.lookup) {
          try { await lookup(a.lookup); } catch (err) { let sug = []; try { sug = searchNames(await catalogue(), a.lookup, 6).filter((s) => s.type === 'planet').map((s) => s.label); } catch { /* no suggestions */ } throw new Error(err.message + (sug.length ? ` Similar names: ${sug.join(', ')}.` : '')); }
          $('inPlanet').value = P.name;
        }
        const set = {}; for (const [k] of SYS_FIELDS) if (a[k] !== undefined) set[k] = a[k];
        if (a.name) { set.name = a.name; $('inPlanet').value = a.name; }
        if (a.kind) { set.kind = a.kind; if (a.kind === 'eclipse' && !(P.sys.fpfs > 0) && set.fpfs === undefined) set.fpfs = 0.05; }
        if (Object.keys(set).length) api.setSystem(set);
        const sh = scale();
        return { set: Object.keys(set).length ? set : undefined, looked_up: a.lookup ? P.name : undefined, ...sysOut(), scale_height: sh ? { km: r4(sh.H / 1000), teq_k: r4(sh.teq), depth_per_H_ppm: pp(sh.depthPerH) } : undefined, note: status('stSys') };
      } },
    { name: 'spectroscopy_set_binning', core: true,
      description: 'Choose the spectral channels and the cleaning: bins of constant resolving power R, constant width (um), a number of bins, columns per bin, or every column; a wavelength range; and the outlier clip in time (sigma and running-median window). Rebuilds the channels and the white light curve and discards the fits.',
      confirm: () => (fitsExist() ? 'Rebinning discards the white-light fit and the spectrum on the page.' : null),
      parameters: obj({ mode: T('How to bin: R (constant lambda/dlambda), width (um), n (number of bins), columns (columns per bin), native (every column).', { enum: ['R', 'width', 'n', 'columns', 'native'] }), value: N('R, width in um, number of bins or columns per bin (defaults 100, 0.05, 20, 10).', { minimum: 0 }),
        wl_min: N('Shortest wavelength used (um).'), wl_max: N('Longest wavelength used (um).'), full_range: B('Use every wavelength again (clears wl_min / wl_max).'),
        clip_sigma: N('Replace points beyond this many robust sigma from the running median in time (default 5).', { minimum: 2 }), clip_window: { type: 'integer', description: 'Running-median window in integrations (default 11).', minimum: 3, maximum: 201 } }),
      run(a) {
        needData(); notBusy();
        const s = P.settings, cl = s.clean;
        if ((a.clip_sigma !== undefined && a.clip_sigma !== cl.nsigma) || (a.clip_window !== undefined && a.clip_window !== cl.window)) {
          if (a.clip_sigma !== undefined) cl.nsigma = a.clip_sigma; if (a.clip_window !== undefined) cl.window = a.clip_window;
          $('clipN').value = cl.nsigma; P.clean = SP.rejectOutliers(P.cube, { window: cl.window, nsigma: cl.nsigma });
        }
        const mode = a.mode || s.bins.mode, key = { R: 'R', width: 'width', n: 'n', columns: 'columns' }[mode], dflt = { R: 100, width: 0.05, n: 20, columns: 10 };
        const o = { mode }; if (key) o[key] = a.value ?? (mode === s.bins.mode ? s.bins[key] : undefined) ?? dflt[mode];
        if (!a.full_range) { const lo = a.wl_min ?? s.bins.wlMin, hi = a.wl_max ?? s.bins.wlMax; if (lo !== undefined) o.wlMin = lo; if (hi !== undefined) o.wlMax = hi; }
        if (o.wlMin !== undefined && o.wlMax !== undefined && !(o.wlMax > o.wlMin)) throw new Error('wl_max must be larger than wl_min');
        readSettings(); applyBins(o);
        const b = P.bins, nc = b.map((x) => x.ncol);
        return { binning: { ...P.settings.bins }, channels: b.length, first: b.length ? [um(b[0].lo), um(b[0].hi)] : null, last: b.length ? [um(b[b.length - 1].lo), um(b[b.length - 1].hi)] : null, columns_per_channel: [Math.min(...nc), Math.max(...nc)], data: dataOut(), note: P.cube.lo && mode !== 'native' ? 'These are simulated channels: rebinning them merges whole channels, and the comparison with the injected spectrum is only made for native binning.' : undefined };
      } },
    { name: 'spectroscopy_set_fit_options', core: true,
      description: 'Settings both fits use: the baseline in time (level, slope, or slope and curvature), the limb-darkening law (coefficients come from the PHOENIX table for the star and each channel, fixed), the error bars (pipeline, pipeline widened to the scatter, or the scatter), dividing channels by the white-light residuals (common mode), a/R* from Kepler\'s law with R* free, and steps in the baseline (BJD). Fits already made are kept until refitted.',
      parameters: obj({ baseline: T('Baseline in time.', { enum: ['none', 'linear', 'quadratic'] }), ld_law: T('Limb-darkening law (coefficients from the star).', { enum: ['quadratic', 'nonlinear', 'linear'] }), error_bars: T('max: pipeline errors widened to the point-to-point scatter; pipeline: as given; scatter: the scatter.', { enum: ['max', 'pipeline', 'scatter'] }),
        common_mode: B('Divide every channel by the white-light residuals before its fit.'), kepler: B('a/R* from Kepler\'s law with R* free (normal prior), instead of fixed. Transit only; needs M* and R*.'),
        steps: { type: 'array', items: N('BJD_TDB'), description: 'Times of steps in the baseline (e.g. a JWST mirror tilt event); [] removes them. spectroscopy_find_step finds one.' } }),
      run(a) {
        notBusy();
        const before = JSON.stringify(settingsOut());
        api.set({ baseline: a.baseline, ldLaw: a.ld_law, errorMode: a.error_bars, ...(a.common_mode !== undefined ? { commonMode: a.common_mode } : {}), ...(a.kepler !== undefined ? { kepler: a.kepler } : {}), ...(a.steps ? { steps: a.steps } : {}) });
        if (a.steps) $('stepInfo').textContent = a.steps.length ? `Steps at BJD ${a.steps.map((x) => x.toFixed(5)).join(', ')}: fit again.` : '';
        const now = settingsOut(), changed = JSON.stringify(now) !== before;
        return { set: now, note: changed && fitsExist() ? 'The fits on the page were made with the earlier settings: run spectroscopy_fit_white (and spectroscopy_fit_channels) again.' : undefined, kepler_note: now.kepler && P.kind !== 'transit' ? 'Kepler\'s law is only used for transits.' : undefined };
      } },
    { name: 'spectroscopy_fit_white', core: true,
      description: 'Fit the white light curve (all wavelengths together) by nested sampling: by default Rp/R*, mid-time and inclination free (Fp/F* for an eclipse), a/R* fixed or from Kepler\'s law, limb darkening fixed from the star, the baseline integrated out. The geometry it finds is shared by every channel. "free" and "priors" change which parameters are free and their priors.',
      parameters: obj({ free: { type: 'array', items: T('parameter', { enum: ['rprs', 'tmid', 'inc', 'fpfs', 'rstar'] }), description: 'Parameters to fit; the rest stay at the planet values. Default: rprs, tmid, inc (transit; plus rstar with Kepler) or fpfs (eclipse).' },
        priors: { type: 'array', description: 'Priors replacing the defaults, one per parameter (tmid in BJD_TDB).', items: obj({ key: T('Parameter.', { enum: ['rprs', 'tmid', 'inc', 'fpfs', 'rstar'] }), type: T('Prior shape.', { enum: ['uniform', 'normal'] }), a: N('Lower bound (uniform) or mean (normal).'), b: N('Upper bound (uniform) or standard deviation (normal).') }, ['key', 'type', 'a', 'b']) },
        rstar_err: N('Standard deviation of the R* prior with Kepler\'s law (R_sun; default 3% of R*).', { minimum: 0 }) }),
      async run(a, { onProgress } = {}) {
        needData(); notBusy();
        const o = { onProgress: onProgress ? (p) => onProgress({ ncalls: p.ncalls, logZ: p.logZ, variant: 'white light' }) : undefined, rstarErr: a.rstar_err };
        if (a.free || a.priors) {
          await table(); readSettings();
          const sys = { ...P.sys, mstar: P.star.mstar, rstar: P.star.rstar }, kep = P.settings.kepler && P.kind === 'transit';
          const dflt = [...SP.defaultWhiteFree(P.white, sys, P.kind).free, ...(P.kind === 'eclipse' ? SP.defaultWhiteFree(P.white, sys, 'transit').free : []), ...(P.star.rstar > 0 ? [{ key: 'rstar', prior: { type: 'normal', a: P.star.rstar, b: a.rstar_err ?? 0.03 * P.star.rstar } }] : [])];
          const keys = a.free || SP.defaultWhiteFree(P.white, sys, P.kind).free.map((f) => f.key).concat(kep ? ['rstar'] : []);
          if (!keys.length) throw new Error('at least one parameter must be free');
          if (keys.includes('rstar') && !kep) throw new Error('rstar is free only with Kepler\'s law (spectroscopy_set_fit_options kepler: true) for a transit');
          if (keys.includes('fpfs') && P.kind !== 'eclipse') throw new Error('fpfs is free only for an eclipse (spectroscopy_set_planet kind: eclipse)');
          const pri = Object.fromEntries((a.priors || []).map((p) => [p.key, { type: p.type, a: p.a, b: p.b }]));
          for (const [k, p] of Object.entries(pri)) { if (!keys.includes(k)) throw new Error(`a prior for ${k}, which is not free`); if (p.type === 'uniform' && !(p.b > p.a)) throw new Error(`${k}: a uniform prior needs b > a`); if (p.type === 'normal' && !(p.b > 0)) throw new Error(`${k}: a normal prior needs b (the standard deviation) > 0`); }
          o.free = keys.map((k) => { const d = dflt.find((f) => f.key === k); return { key: k, prior: pri[k] || (d && { ...d.prior }) }; });
          const none = o.free.filter((f) => !f.prior).map((f) => f.key); if (none.length) throw new Error(`give a prior for ${none.join(', ')}`);
        }
        await fitWhite(o);
        return { ...whiteOut(), note: status('stWhite'), next: 'spectroscopy_fit_channels for the spectrum; spectroscopy_find_step if the residuals jump.' };
      } },
    { name: 'spectroscopy_find_step',
      description: 'Look for the largest jump in the white-light residuals (a JWST mirror-segment tilt event) and, when it is above 5 sigma, put a step in the baseline there. Fit the white light curve again afterwards.',
      parameters: obj({}),
      run() {
        needData(); notBusy(); if (!P.whiteFit) throw new Error('fit the white light curve first (spectroscopy_fit_white): the step is looked for in its residuals');
        const st = addStep();
        return st ? { added: { bjd: +st.time.toFixed(5), size_ppm: pp(st.size), significance_sigma: r4(st.significance) }, steps_bjd: P.settings.steps.map((x) => +x.toFixed(5)), next: 'spectroscopy_fit_white again.' } : { added: null, note: $('stepInfo').textContent };
      } },
    { name: 'spectroscopy_fit_channels', core: true,
      description: 'Fit every channel with the geometry of the white-light fit (made first if missing): the depth free, limb darkening fixed from the star (or free with a normal prior: ld_sigma), the baseline integrated out; optional normal priors on mid-time and inclination instead of fixing them. Runs in parallel workers and makes the spectrum; a white-light fit made with other settings is redone first. Depth-only fits are exact grid integrals; anything more uses nested sampling and is slower.',
      parameters: obj({ ld_sigma: N('0 (default): limb darkening fixed; > 0: every coefficient free with a normal prior of this width around the table value.', { minimum: 0, maximum: 1 }),
        tmid_sigma_min: N('Let the mid-time float per channel with a normal prior of this width (minutes) around the white-light value.', { minimum: 0 }), inc_sigma_deg: N('Let the inclination float per channel with a normal prior of this width (degrees).', { minimum: 0 }),
        workers: { type: 'integer', description: 'Parallel workers (default 6, at most the cores less one).', minimum: 1, maximum: 32 } }),
      async run(a, { signal, onProgress } = {}) {
        needData(); notBusy();
        const gp = {}; if (a.tmid_sigma_min > 0) gp.tmid = a.tmid_sigma_min / 1440; if (a.inc_sigma_deg > 0) gp.inc = a.inc_sigma_deg;
        const stop = () => { stopFlag = true; killPool(); };
        if (signal) { if (signal.aborted) throw new Error('stopped'); signal.addEventListener('abort', stop, { once: true }); }
        let refitted = false;
        if (P.whiteFit && P.whiteKey !== fitKey()) { await fitWhite({ onProgress: onProgress ? (p) => onProgress({ ncalls: p.ncalls, logZ: p.logZ, variant: 'white light' }) : undefined }); refitted = true; }
        try { await fitChannels({ ldSigma: a.ld_sigma || 0, workers: a.workers, ...(Object.keys(gp).length ? { geometry: 'prior', geoPriors: gp } : {}) }); } finally { if (signal) signal.removeEventListener('abort', stop); }
        const res = P.results, failed = res.filter((r) => !r).length;
        return { white_refitted: refitted ? 'the settings had changed since the white-light fit (baseline, steps, limb darkening, errors or Kepler): it was fitted again first' : undefined, channels_fitted: res.filter(Boolean).length, failed: failed || undefined, stopped: stopFlag || undefined, method: (res.find(Boolean) || {}).method, white_fit: { tmid: +P.whiteFit.values.tmid.toFixed(6), inc: r6(P.whiteFit.values.inc), depth_ppm: P.whiteFit.depth ? pp(P.whiteFit.depth.median) : null }, spectrum: spectrumSummary(), note: status('stChan'), interpretation: $('interp').textContent || undefined, next: 'spectroscopy_spectrum for the rows; spectroscopy_export to save them.' };
      } },
    { name: 'spectroscopy_spectrum', core: true, readOnly: true,
      description: 'The spectrum as the page computed it: per channel the wavelength and edges (um), depth with its +/- 1 sigma (16th and 84th percentiles, in ppm), residual rms against the rms the error bars predict, and beta; with the white-light depth, a summary, scale heights for orientation, and for a simulation the comparison with the injected spectrum (pulls). The errors leave out the uncertainty of the shared geometry.',
      parameters: obj({ max_rows: { type: 'integer', description: 'Most channel rows to return, evenly spread (default 40).', minimum: 0, maximum: 400 }, wl_min: N('Only channels from this wavelength (um).'), wl_max: N('Only channels up to this wavelength (um).') }),
      run({ max_rows: mr = 40, wl_min: lo = -Infinity, wl_max: hi = Infinity }) {
        const sp = P.spectrum; if (!sp || !sp.length) throw new Error(P.cube ? 'there is no spectrum yet: spectroscopy_fit_channels first' : 'nothing is loaded yet');
        const sel = sp.filter((r) => r.wl >= lo && r.wl <= hi), step = mr > 0 && sel.length > mr ? sel.length / mr : 1, rows = mr === 0 ? [] : step === 1 ? sel : Array.from({ length: mr }, (_, i) => sel[Math.floor(i * step)]);
        const sh = P.kind === 'transit' ? scale() : null, inj = injected(), wf = P.whiteFit;
        let hs; if (sh) { const x = SP.toScaleHeights(sp, { H: sh.H, rplanet: sh.rplanet, rstar: P.star.rstar }); hs = { H_km: r4(sh.H / 1000), teq_k: r4(sh.teq), g_ms2: r4(sh.g), mu: 2.3, depth_per_H_ppm: pp(sh.depthPerH), span_in_H: r4(x.span), typical_error_in_H: r4(sp.map((r) => r.err).sort((a, b) => a - b)[sp.length >> 1] / sh.depthPerH) }; }
        return { planet: P.name, kind: P.kind === 'eclipse' ? 'emission (eclipse depth Fp/F* (Rp/R*)^2)' : 'transmission (transit depth (Rp/R*)^2)', summary: spectrumSummary(), white_light_depth_ppm: wf && wf.depth ? { value: pp(wf.depth.median), plus: pp(wf.depth.plus), minus: pp(wf.depth.minus) } : undefined,
          rows_shown: rows.length, rows_total: sel.length, rows: rows.map(row), scale_heights: hs,
          against_injected: inj ? (inj.comparable ? { mean_pull: r4(inj.mean), sd_pull: r4(inj.sd), chi2_per_channel: r4(meanOf(inj.pulls.map((p) => p * p))), meaning: '0 and 1 when depths and errors are right' } : 'not comparable: the simulated channels were rebinned (use native binning)') : undefined,
          ld_extrapolated: P.results.some((r) => r && r.ldExtrapolated) ? 'channels beyond 5.5 um use limb darkening from the reddest part of the table' : undefined, caveat: 'Errors do not include the uncertainty of the shared white-light geometry, which moves all channels together.' };
      } },
    { name: 'spectroscopy_channel', readOnly: true,
      description: 'One channel in detail (by index in the spectrum, or nearest to a wavelength): depth and Rp/R* (or Fp/F*) with errors, fit method, residual rms against expected, beta, error scale, reduced chi^2, points, and its limb-darkening coefficients. Also selects it on the page (binned-residual plot, table row).',
      parameters: obj({ index: { type: 'integer', description: 'Index of the channel (0 = bluest).', minimum: 0 }, wavelength_um: N('Channel nearest this wavelength (um).') }),
      run({ index, wavelength_um: w }) {
        const res = P.results.filter(Boolean); if (!res.length) throw new Error('no channel fits yet: spectroscopy_fit_channels first');
        let k = index ?? 0; if (w !== undefined) k = res.reduce((b, r, i) => (Math.abs(r.wl - w) < Math.abs(res[b].wl - w) ? i : b), 0);
        if (k >= res.length) throw new Error(`there are ${res.length} channels (0 to ${res.length - 1})`);
        const r = res[k]; P.sel = k; redraw();
        return { index: k, of: res.length, wl_um: um(r.wl), range_um: [um(r.lo), um(r.hi)], depth_ppm: { value: pp(r.depth), plus: pp(r.depthPlus), minus: pp(r.depthMinus) }, [r.kind === 'eclipse' ? 'fpfs' : 'rprs']: { value: r6(r.value), plus: r4(r.valuePlus), minus: r4(r.valueMinus) },
          method: r.method, residual_rms_ppm: pp(r.rms), expected_rms_ppm: pp(r.expected), rms_over_expected: r4(r.ratio), beta: r4(r.beta), error_scale: r4(r.errScale), reduced_chi2: r4(r.redChi2), points: r.n, limb_darkening: { law: r.ldLaw, coeffs: (r.ld || []).map(r4), extrapolated_beyond_table: r.ldExtrapolated || undefined } };
      } },
    { name: 'spectroscopy_export',
      description: 'Write the page\'s products to the files of this conversation: the spectrum as CSV or ECSV (astropy-readable, with the settings and white-light geometry in the header), the spectrum plot as PNG, the white light curve as CSV (detrended once fitted), or the whole session as JSON (reopens on this page; the analyzer opens its white light curve).',
      parameters: obj({ kinds: { type: 'array', items: T('product', { enum: ['csv', 'ecsv', 'png', 'white', 'session'] }), description: 'What to write (default: csv and ecsv).' }, theme: T('PNG colours (default print, light background).', { enum: ['print', 'dark'] }), download: B('Also save the files to the user\'s computer, as the page\'s own buttons do (default false).') }),
      async run({ kinds = ['csv', 'ecsv'], theme, download: dl = false }, { files }) {
        needData();
        const names = { csv: stem() + '_spectrum.csv', ecsv: stem() + '_spectrum.ecsv', png: stem() + '_spectrum.png', white: stem() + '_white_light.csv', session: stem() + '_spectroscopy.json' }, mime = { csv: 'text/csv', ecsv: 'text/plain', png: 'image/png', white: 'text/csv', session: 'application/json' };
        const written = [], failed = [];
        for (const k of [...new Set(kinds)]) {
          if (['csv', 'ecsv', 'png'].includes(k) && !(P.spectrum && P.spectrum.length)) { failed.push({ kind: k, why: 'no spectrum yet: spectroscopy_fit_channels first' }); continue; }
          try {
            let out = exportAs(k, { download: dl, theme });
            if (k === 'png') out = await (await fetch(out)).blob();
            const w = await files.write(names[k], out, mime[k]); written.push({ kind: k, file: w.name, size_bytes: w.size });
          } catch (err) { failed.push({ kind: k, why: err.message }); }
        }
        if (!written.length) throw new Error(failed.map((f) => `${f.kind}: ${f.why}`).join('; '));
        return { written, failed: failed.length ? failed : undefined };
      } },
    { name: 'spectroscopy_send_to_analyze',
      description: 'Hand the white light curve (detrended by the white-light baseline once fitted, BJD_TDB, with its exposure time and target) to the analyze page and go there, as the page\'s "Open the white light curve in Analyze" button does. The request continues on the analyze page with the light curve loaded.',
      parameters: obj({}),
      run() {
        needData(); notBusy(); if (!P.white) throw new Error('there is no white light curve yet');
        const hand = handoffRecord();
        try { localStorage.setItem('esl.handoff', JSON.stringify(hand)); } catch { throw new Error('the browser storage is full or blocked: export the session (spectroscopy_export kinds ["session"]) and load it on the analyze page'); }
        return { handed_over: `${hand.name}: ${P.white.time.length} points, ${hand.filter}`, detrended: hand.detrended, navigate: { page: 'analyze', params: { handoff: 1 } } };
      } },
  ];
  P.ready = true;
  (window.__esl = window.__esl || {}).spectroscopy = { tools, ready: () => P.ready === true,
    state: () => {
      const L = [`Spectroscopy: ${P.name}, ${P.kind === 'eclipse' ? 'eclipse (emission)' : 'transit (transmission)'}${P.busy ? '; a fit is running' : ''}.`];
      if (!P.cube) { L.push('No spectra loaded: attach x1dints FITS / CSV / ECSV / a saved session (spectroscopy_load_files) or simulate Ariel or JWST (spectroscopy_simulate).'); return L; }
      const c = P.clean, b = P.settings.bins, bv = b.R ?? b.width ?? b.n ?? b.columns;
      L.push(`Data: ${P.source.kind}${P.source.files.length ? ` (${P.source.files.length} file${P.source.files.length > 1 ? 's' : ''})` : ''}, ${c.nT} integrations x ${c.nW} wavelengths, ${c.wave[0].toFixed(2)}-${c.wave[c.nW - 1].toFixed(2)} um; ${P.channels.length} channels (${b.mode}${bv !== undefined ? ' ' + bv : ''}${b.wlMin !== undefined || b.wlMax !== undefined ? `, ${b.wlMin ?? '…'}-${b.wlMax ?? '…'} um` : ''}); baseline ${P.settings.baseline}, LD ${P.settings.ldLaw}, errors ${P.settings.errorMode}${P.settings.commonMode ? ', common mode' : ''}${P.settings.kepler ? ', Kepler' : ''}${P.settings.steps.length ? `, ${P.settings.steps.length} step` : ''}.`);
      const wf = P.whiteFit;
      L.push(wf ? `White-light fit: ${wf.parameters.map((p) => `${p.key} ${p.key === 'tmid' ? p.median.toFixed(5) : p.median.toPrecision(5)} +${p.plus.toPrecision(2)} -${p.minus.toPrecision(2)}`).join(', ')}${wf.depth ? `; depth ${ppm(wf.depth.median)} +${ppm(wf.depth.plus)} -${ppm(wf.depth.minus)} ppm` : ''}; rms ${wf.stats.ratio.toFixed(2)} x expected${wf.converged ? '' : ' (stopped early)'}.` : 'White light curve not fitted yet.');
      const s = spectrumSummary();
      L.push(s ? `Spectrum: ${s.channels} channels, depth ${s.depth_range_ppm[0]}-${s.depth_range_ppm[1]} ppm, typical error ${s.typical_error_ppm} ppm${P.sim ? ' (simulated data; the injected spectrum is known)' : ''}.` : 'No spectrum yet.');
      return L;
    } };
}
