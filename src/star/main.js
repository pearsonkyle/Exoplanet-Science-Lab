// Star page: catalogue magnitudes -> an SED fit in a worker (src/core/sed.js) -> temperature, angular diameter, radius
// and luminosity, with the figure and the numbers to take away. The science is in src/core (stellarspec, extinction,
// passbands, sed: tested in test/stellarspec.test.mjs and test/sed.test.mjs); this file is the UI.
import { siteRoot } from '../site/nav.js';
import { fetchOr } from '../site/net.js';
import { now } from '../site/clock.js';
import { PASSBANDS } from '../core/passbands.js';
import { magnitudeToFlux, sedLatex } from '../core/sed.js';
import { VIZIER, catalogueUrl, parseTsv, pickGaia, positionAt, photometryFrom, suggestAv } from '../core/starcat.js';
import { loadIndex, lookupHost, systemFromRows, searchNames } from '../core/catalog.js';
import { siteJson } from '../site/net.js';
import { drawCorner } from '../ui/corner.js';
import { fitCanvas } from '../photometry/plots.js';
import { saveFile, canvasToPNG } from '../ui/export.js';
import { SPEC_THEME, PRINT_THEME } from '../spectra/plots.js';
import { renderSed } from './plots.js';
import { EXAMPLES } from './examples.js';

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'style') el.style.cssText = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const $ = (id) => document.getElementById(id);
const setStatus = (id, text, cls = '') => { const el = $(id); if (el) { el.textContent = text; el.className = 'status' + (cls ? ' ' + cls : ''); } };

const first = Object.keys(EXAMPLES)[0];
const S = { name: first, obs: [], priors: {}, result: null, ready: false, busy: false, seq: 0, grid: null, runs: [] };
const blankPriors = () => ({ plx: '', plxErr: '', logg: '', loggErr: '', feh: '', fehErr: '', avMax: 0.1 });
function loadExample(name) {
  const e = EXAMPLES[name]; S.name = name; S.obs = e.obs.map((o) => ({ ...o, use: o.use !== false })); S.priors = { ...blankPriors(), ...e.priors }; S.known = e.known || null; S.result = null;
}
loadExample(first);

let fitWaiters = [];
/** Resolves when no fit is running (the assistant's tools wait on it). */
const whenFitted = (timeout = 120000) => new Promise((res, rej) => { if (!S.busy && S.ready) { res(); return; } const t = setTimeout(() => rej(new Error('the fit did not finish in two minutes')), timeout); fitWaiters.push(() => { clearTimeout(t); res(); }); });
const worker = new Worker(new URL('./star.worker.js', import.meta.url), { type: 'module' });
worker.onerror = (e) => { S.busy = false; setStatus('stRun', e.message || 'The worker failed to start.', 'err'); };
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'ready') { S.ready = true; S.grid = m.grid; setStatus('stRun', `Model stars loaded: ${m.grid.teff[0]} to ${m.grid.teff[1]} K, log g ${m.grid.logg[0]} to ${m.grid.logg[1]}, [Fe/H] ${m.grid.feh[0]} to ${m.grid.feh[1]}.`); fit(); return; }
  if (m.id !== S.seq) return;
  S.busy = false; $('bFit').disabled = false;
  if (m.type === 'error') { S.lastError = m.message; setStatus('stRun', m.message, 'err'); const w = fitWaiters; fitWaiters = []; for (const f of w) f(); return; }
  S.lastError = null;
  S.result = m; S.result.priors = S.sent.priors;
  // every fit is kept, so that fits of the same magnitudes can be compared by their evidence
  S.runs.push({ n: S.runs.length + 1, star: S.name, bands: S.sent.obs.map((o) => o.band).sort().join('|'), nb: S.sent.obs.length, what: describeRun(S.sent.priors), logZ: m.sampler.logZ, logZerr: m.sampler.logZerr, teff: m.parameters.teff, theta: m.parameters.theta_mas, chi2: m.chi2 });
  showResult();
  { const w = fitWaiters; fitWaiters = []; for (const f of w) f(); }
};

function priorsForFit() {
  const p = S.priors, n = (v) => (v === '' || v == null ? NaN : Number(v)), out = { avMax: Math.max(0, n(p.avMax) || 0) };
  if (n(p.plx) > 0 && n(p.plxErr) > 0) out.plx = [n(p.plx), n(p.plxErr)];
  if (Number.isFinite(n(p.logg)) && n(p.loggErr) > 0) out.logg = [n(p.logg), n(p.loggErr)];
  if (Number.isFinite(n(p.feh)) && n(p.fehErr) > 0) out.feh = [n(p.feh), n(p.fehErr)];
  return out;
}
const describeRun = (p) => [p.avMax > 0 ? `A_V free to ${p.avMax}` : 'A_V = 0', p.logg ? `log g ${p.logg[0]} ± ${p.logg[1]}` : 'log g free', p.feh ? `[Fe/H] ${p.feh[0]} ± ${p.feh[1]}` : '[Fe/H] free', p.plx ? 'parallax' : 'no parallax'].join('; ');

// ---- looking a star up: the site's catalogue for planet hosts (position, spectroscopic values), then VizieR for the magnitudes
let catIndex = null;
const fetchCat = (name) => siteJson(new URL('catalog/' + name, siteRoot()), `The catalogue (catalog/${name})`);
async function catalogue() { if (!catIndex) catIndex = await loadIndex(fetchCat); return catIndex; }
async function suggest() {
  const q = $('name').value; if (q.length < 2) return;
  try { const idx = await catalogue(), dl = $('starNames'); dl.innerHTML = ''; const seen = new Set(); for (const x of searchNames(idx, q, 14)) { const host = x.type === 'host' ? x.label : x.label.replace(/ [a-z]$/, ''); if (!seen.has(host)) { seen.add(host); dl.append(h('option', { value: host })); } } } catch { /* no suggestions without the catalogue */ }
}
/** One catalogue's rows from VizieR: the service, then its mirror. */
async function vizier(which, target, what) {
  let last = null;
  for (const base of VIZIER) {
    try { const text = await fetchOr(catalogueUrl(base, which, target), { what, as: 'text', timeout: 25000, fallback: null, quiet404: true }); if (typeof text === 'string' && /^-[-\t ]*$/m.test(text)) return parseTsv(text); if (typeof text === 'string' && !/<html/i.test(text)) return []; } catch (err) { last = err; }
  }
  if (last) throw last; return null;   // null: no answer from either address
}
async function lookup() {
  const name = $('name').value.trim(); if (!name) return;
  S.name = name; $('bLook').disabled = true; setStatus('stEx', `Looking up ${name} …`);
  const notes = [], priors = blankPriors(); let target = name, gmag = null, known = null;
  try {
    // a planet host: the site's catalogue has its position (near Gaia's epoch) and published spectroscopic values
    try { const idx = await catalogue(), L = await lookupHost(idx, name, fetchCat); if (L && L.system && Number.isFinite(L.system.ra)) {
      target = { ra: L.system.ra, dec: L.system.dec }; gmag = L.system.sy_gaiamag ?? null; const st = systemFromRows(L.rows).star, v = (k) => (st && st.values[k] && Number.isFinite(st.values[k].value) ? st.values[k] : null);
      if (v('logg')) { priors.logg = +v('logg').value.toFixed(3); priors.loggErr = Math.max(0.05, +(v('logg').err || 0.1).toFixed(3)); }
      if (v('feh')) { priors.feh = Math.max(-0.5, Math.min(0.5, +v('feh').value.toFixed(2))); priors.fehErr = Math.max(0.05, +(v('feh').err || 0.1).toFixed(2)); }
      known = { ...(v('teff') ? { teff: [v('teff').value, v('teff').err ?? '?'] } : {}), ...(v('rstar') ? { rstar: [v('rstar').value, v('rstar').err ?? '?'] } : {}), source: (st && st.reference) || 'the catalogue' };
      notes.push(`${L.host}: position${v('logg') ? ', log g' : ''}${v('feh') ? ', [Fe/H]' : ''} from the site's catalogue (${known.source}); log g and [Fe/H] are used as priors with at least 0.05 dex of error.`);
    } } catch { /* not a host in the catalogue: the name goes to VizieR as typed */ }
    const g = await vizier('gaia', target, 'Gaia DR3 (VizieR)'); if (g == null) throw new Error('VizieR did not answer (the service and its mirror were both tried). The magnitudes can be typed in by hand.');
    const gaia = pickGaia(g, gmag); if (!gaia) throw new Error(`No Gaia DR3 source was found for "${name}". Check the name, or type the magnitudes in.`);
    const [tmass, wise, tycho] = await Promise.all(['tmass', 'wise', 'tycho'].map((k) => vizier(k, positionAt(gaia, k), { tmass: '2MASS', wise: 'AllWISE', tycho: 'Tycho-2' }[k] + ' (VizieR)').catch(() => null)));
    const failed = [['2MASS', tmass], ['AllWISE', wise], ['Tycho-2', tycho]].filter((x) => x[1] == null).map((x) => x[0]);
    const ph = photometryFrom({ gaia, tmass: tmass || [], wise: wise || [], tycho: tycho || [] });
    S.obs = ph.obs.map((o) => ({ ...o })); if (ph.plx) { priors.plx = ph.plx[0]; priors.plxErr = ph.plx[1]; priors.avMax = suggestAv(1000 / ph.plx[0]); }
    S.priors = priors; S.known = known; S.result = null;
    if (failed.length) notes.push(`No answer from ${failed.join(', ')}: press Look up again in a moment, or add those magnitudes by hand.`);
    const off = ph.obs.filter((o) => !o.use); if (off.length) notes.push('Listed but not used: ' + off.map((o) => `${o.band} (${o.why})`).join(', ') + '.');
    if (ph.gaia && Number.isFinite(ph.gaia.teff)) notes.push(`Gaia's own estimate, for comparison only: ${ph.gaia.teff.toFixed(0)} K.`);
    buildPriors(); buildObs(); draw(); showResult();
    setStatus('stEx', [`Gaia DR3 ${ph.ids.gaia}${ph.ids.tmass ? ', 2MASS ' + ph.ids.tmass : ''}${ph.ids.wise ? ', AllWISE ' + ph.ids.wise : ''}${ph.ids.tycho ? ', ' + ph.ids.tycho : ''}.`, ...notes, ...ph.notes].join(' '), failed.length ? 'warn' : 'ok');
    fit();
  } catch (err) { setStatus('stEx', String((err && err.message) || err), 'err'); }
  $('bLook').disabled = false;
}

function fit() {
  if (!S.ready || S.busy) return;
  const obs = S.obs.filter((o) => o.use && Number.isFinite(Number(o.mag)) && Number(o.err) >= 0 && PASSBANDS[o.band]).map((o) => ({ band: o.band, mag: Number(o.mag), err: Number(o.err) }));
  if (obs.length < 3) { setStatus('stRun', 'At least three magnitudes are needed.', 'warn'); return; }
  S.busy = true; S.seq++; $('bFit').disabled = true; setStatus('stRun', `Fitting ${obs.length} magnitudes …`);
  S.sent = { obs, priors: priorsForFit() };
  worker.postMessage({ type: 'fit', id: S.seq, obs, priors: S.sent.priors });
}

// ------------------------------------------------------------------------------------------------- layout
const card = (...kids) => h('div', { class: 'card' }, ...kids);
const bandOptions = (value) => Object.keys(PASSBANDS).map((k) => h('option', { value: k, selected: k === value }, k));
$('app').append(h('div', { class: 'cols' },
  h('div', { class: 'side' },
    card(h('h2', {}, 'Star'),
      h('label', {}, 'Start from an example', h('select', { id: 'example', onchange: (e) => { loadExample(e.target.value); buildAll(); fit(); } }, Object.keys(EXAMPLES).map((k) => h('option', { value: k }, k)))),
      h('label', { style: 'margin-top:8px' }, 'Star'), h('div', { class: 'row', style: 'display:flex;gap:8px' }, h('input', { type: 'text', id: 'name', value: S.name, list: 'starNames', style: 'flex:1 1 120px;min-width:0', 'aria-label': 'Star name', oninput: (e) => { S.name = e.target.value; suggest(); }, onkeydown: (e) => { if (e.key === 'Enter') lookup(); } }), h('datalist', { id: 'starNames' }), h('button', { class: 'btn', id: 'bLook', title: 'Gaia DR3, 2MASS, AllWISE and Tycho-2 magnitudes and the parallax from VizieR; position, log g and [Fe/H] from the site\'s catalogue for planet hosts', onclick: () => lookup() }, 'Look up')),
      h('div', { class: 'status', id: 'stEx' })),
    card(h('h2', {}, 'What is known already'),
      h('div', { class: 'grid2', id: 'priorRows' }),
      h('p', { class: 'note' }, 'A parallax turns the angular diameter into a radius and a luminosity. Magnitudes say little about gravity and metallicity: give a spectroscopic value where there is one, or leave them empty. The extinction is searched between zero and the limit; nearby stars (within about 100 pc) have almost none.')),
    card(h('h2', {}, 'Magnitudes'),
      h('div', { id: 'obsRows' }),
      h('div', { class: 'row', style: 'margin-top:8px;gap:8px;display:flex;flex-wrap:wrap' }, h('button', { class: 'btn sm', onclick: () => { S.obs.push({ band: 'Johnson V', mag: '', err: 0.02, use: true }); buildObs(); } }, 'Add a band'), h('button', { class: 'btn', id: 'bFit', onclick: () => fit() }, 'Fit')),
      h('p', { class: 'note' }, 'Vega magnitudes for Gaia, Tycho, Johnson, 2MASS, WISE and APASS B, V; AB magnitudes for SDSS, Pan-STARRS, APASS g, r, i and GALEX: as the catalogues give them. Untick a band that is saturated or blended. Zero points and passbands are those of the SVO Filter Profile Service.'))),
  h('div', { class: 'main' },
    h('h2', {}, 'Spectral energy distribution'),
    h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => saveCsv() }, 'Save CSV'), h('button', { class: 'btn sm', onclick: () => savePng() }, 'Save figure'), h('button', { class: 'btn sm', onclick: () => saveJson() }, 'Save result (JSON)')),
    h('div', { class: 'card pad6' }, h('canvas', { id: 'cvSed', role: 'img', 'aria-label': 'Spectral energy distribution: measured magnitudes and the fitted model' })),
    h('div', { class: 'status', id: 'stRun' }, 'Loading the model stars …'),
    h('h2', {}, 'Result'),
    h('div', { id: 'resTable' }),
    h('div', { id: 'warnings' }),
    h('h2', {}, 'Posterior'),
    h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => saveCorner() }, 'Save corner plot'), h('button', { class: 'btn sm', onclick: () => saveSamples() }, 'Save samples (CSV)')),
    h('div', { class: 'card pad6', style: 'overflow:auto' }, h('canvas', { id: 'cvCorner', role: 'img', 'aria-label': 'Corner plot of the posterior' })),
    h('p', { class: 'note' }, 'Every pair of quantities as the nested sampler found them: contours hold 39%, 86% and 99% of the probability (1, 2 and 3 σ in two dimensions); the diagonal is each quantity alone. A tilted pair is a trade-off: temperature against extinction, or against angular diameter.'),
    h('h2', {}, 'How the sampler ran'),
    h('div', { id: 'samplerTable' }),
    h('h2', {}, 'Fits of this star, compared'),
    h('div', { id: 'runsTable' }),
    h('h2', {}, 'For a paper'),
    h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => { const t = $('latex'); t.select(); navigator.clipboard && navigator.clipboard.writeText(t.value).catch(() => {}); } }, 'Copy LaTeX'), h('button', { class: 'btn sm', onclick: () => saveLatex() }, 'Save LaTeX')),
    h('textarea', { id: 'latex', readonly: true, rows: 14, class: 'latexbox', 'aria-label': 'LaTeX tables of the result' }),
    h('details', { class: 'card how' }, h('summary', {}, 'How this is computed, and from what'),
      h('p', {}, 'For a temperature, a gravity and a metallicity, a grid of model atmospheres gives the light leaving each square metre of the star at every wavelength. A star of angular diameter θ sends the fraction (θ/2)² of that to us, dimmed by interstellar dust. The page computes the magnitude each catalogue would measure through its own passband and moves the parameters until the computed magnitudes match the measured ones. Temperature sets the shape of the curve, θ its height; with a parallax, θ becomes a radius, and the area under the curve a luminosity.'),
      h('p', {}, 'Models: PHOENIX-ACES (Husser et al. 2013), the spectra this site also uses for limb darkening, integrated over the disc; 2300 to 8000 K, log g 4 to 5.5, [Fe/H] −0.5 to +0.5, 0.1 to 5.5 µm, with a blackbody tail beyond. Extinction: Fitzpatrick (1999) with R_V = 3.1. Sampler: the nested sampler of the light-curve fits. One scatter term is fitted and added to every error bar, because zero points and models are good to a few hundredths of a magnitude, not to the catalogues\' quoted errors.'),
      h('p', {}, 'Limits: single main-sequence stars within the grid; no giants or hot stars, no binaries, no dust shells or activity. One model grid only, where codes such as AstroARIADNE average several. Checks and what was not compared are on the Methods page, Validation tab.')))));

function buildPriors() {
  const host = $('priorRows'); host.innerHTML = '';
  const f = (label, key, attrs = {}) => h('label', {}, label, h('input', { type: 'number', step: 'any', value: S.priors[key], ...attrs, onchange: (e) => { S.priors[key] = e.target.value; } }));
  host.append(f('Parallax (mas)', 'plx', { min: 0 }), f('± (mas)', 'plxErr', { min: 0 }), f('log g', 'logg'), f('±', 'loggErr', { min: 0 }), f('[Fe/H]', 'feh'), f('±', 'fehErr', { min: 0 }), f('Extinction A_V up to (mag)', 'avMax', { min: 0, max: 5, step: 0.05 }));
}
function buildObs() {
  const host = $('obsRows'); host.innerHTML = '';
  S.obs.forEach((o, i) => host.append(h('div', { class: 'obsrow' },
    h('input', { type: 'checkbox', checked: o.use, 'aria-label': 'use ' + o.band, onchange: (e) => { o.use = e.target.checked; } }),
    h('select', { 'aria-label': 'band', onchange: (e) => { o.band = e.target.value; } }, bandOptions(o.band)),
    h('input', { type: 'number', step: 'any', value: o.mag === '' ? '' : +Number(o.mag).toFixed(3), 'aria-label': 'magnitude', onchange: (e) => { o.mag = e.target.value; } }),
    h('input', { type: 'number', step: 'any', min: 0, value: +Number(o.err).toFixed(3), 'aria-label': 'error', onchange: (e) => { o.err = e.target.value; } }),
    h('button', { class: 'btn sm', title: 'Remove', 'aria-label': 'remove ' + o.band, onclick: () => { S.obs.splice(i, 1); buildObs(); } }, '×'))));
}
function buildAll() { $('example').value = EXAMPLES[S.name] ? S.name : $('example').value; $('name').value = S.name; for (const id of ['samplerTable', 'runsTable']) if ($(id)) $(id).innerHTML = ''; if ($('latex')) $('latex').value = ''; setStatus('stEx', (EXAMPLES[S.name] && EXAMPLES[S.name].about) || ''); buildPriors(); buildObs(); draw(); showResult(); }

// ------------------------------------------------------------------------------------------------- result
function sedData() {
  const r = S.result, fitted = r ? Object.fromEntries(r.bands.map((b) => [b.band, b])) : {};
  const points = S.obs.filter((o) => PASSBANDS[o.band] && Number.isFinite(Number(o.mag)) && o.mag !== '').map((o) => {
    const mag = Number(o.mag), err = Math.max(Number(o.err) || 0, 0.01), f = magnitudeToFlux(o.band, mag), lf = f.pivot * f.flam, b = fitted[o.band];
    return { band: o.band, survey: PASSBANDS[o.band].survey, wl: f.pivot, obs: lf, lo: lf * 10 ** (-0.4 * err), hi: lf * 10 ** (0.4 * err), model: b ? lf * 10 ** (0.4 * (mag - b.model)) : NaN, residual: b ? b.residual : 0, err, used: !!b };
  });
  return { wl: r ? r.spectrum.wl : null, flux: r ? r.spectrum.flux : null, points, title: S.name };
}
function draw() { const { ctx, W, H } = fitCanvas($('cvSed'), 420); renderSed(ctx, W, H, sedData(), SPEC_THEME); }
const ROWS = [['teff', 'Effective temperature', 'K', 0], ['theta_mas', 'Angular diameter', 'mas', 4], ['rstar', 'Radius', 'R☉', 3], ['lum', 'Luminosity', 'L☉', 3], ['fbol', 'Bolometric flux at Earth', 'W/m²', -3], ['av', 'Extinction A_V', 'mag', 3], ['logg', 'log g', '', 2], ['feh', '[Fe/H]', '', 2], ['dist_pc', 'Distance', 'pc', 2], ['scatter_mag', 'Extra scatter', 'mag', 3]];
const fmt = (v, d) => (d < 0 ? v.toExponential(-d) : v.toFixed(d));
function showResult() {
  const host = $('resTable'), w = $('warnings'); host.innerHTML = ''; w.innerHTML = ''; draw();
  const r = S.result; if (!r) return;
  const p = r.parameters, known = S.known || {};
  host.append(h('table', { class: 'src' }, h('tbody', {}, h('tr', {}, h('th', {}, 'Quantity'), h('th', {}, 'Median'), h('th', {}, '+'), h('th', {}, '−'), h('th', {}, 'Unit'), h('th', {}, Object.keys(known).length ? 'Measured otherwise' : '')),
    ROWS.filter(([k]) => p[k]).map(([k, label, unit, d]) => h('tr', {}, h('td', {}, label), h('td', {}, fmt(p[k].median, d)), h('td', {}, fmt(p[k].hi - p[k].median, d)), h('td', {}, fmt(p[k].median - p[k].lo, d)), h('td', {}, unit), h('td', {}, known[k] ? `${known[k][0]} ± ${known[k][1]} (${known.source || ''})` : ''))))));
  const prior = ['logg', 'feh'].filter((k) => !priorsForFit()[k]);
  setStatus('stRun', `${r.bands.length} magnitudes, ${r.ncalls} model evaluations in ${(r.ms / 1000).toFixed(1)} s; χ² = ${r.chi2.toFixed(1)} with the fitted scatter.${r.converged ? '' : ' The sampler stopped before it converged.'}${p.rstar ? '' : ' Without a parallax there is no radius or luminosity.'}${prior.length ? ` No prior was given for ${prior.join(' and ').replace('logg', 'log g').replace('feh', '[Fe/H]')}: read ${prior.length > 1 ? 'their values' : 'its value'} as "anywhere in the grid".` : ''}`, r.converged ? 'ok' : 'warn');
  // the sampler's own remarks about priors are worded for light-curve fits; what they say here is in the line above
  // posterior, sampler, comparison, LaTeX
  try { drawCorner($('cvCorner'), { ...r.posterior, logl: null }, r.posterior.labels, null, {}); } catch (err) { w.append(h('p', { class: 'note warn' }, 'The corner plot could not be drawn: ' + String((err && err.message) || err))); }
  const sp = r.sampler, tr = (a, b) => h('tr', {}, h('td', {}, a), h('td', {}, b));
  $('samplerTable').innerHTML = ''; $('samplerTable').append(h('table', { class: 'src' }, h('tbody', {},
    tr('Evidence ln Z', `${sp.logZ.toFixed(2)} ± ${sp.logZerr.toFixed(2)}`), tr('Ended because', sp.stopReason + (sp.converged ? '' : ' (not converged)')), tr('Live points', String(sp.nlive)), tr('Iterations', String(sp.niter)),
    tr('Model evaluations', `${sp.ncalls} (${(100 * sp.efficiency).toFixed(1)}% accepted)`), tr('Effective samples', sp.ess.toFixed(0)), tr('Insertion-order test, p', `${sp.insertionP.toFixed(3)}${sp.insertionP < 0.01 ? ' (the sampler may have missed part of the posterior)' : ' (no sign of trouble)'}`), tr('Proposals', sp.method === 'slice' ? 'slice sampling' : 'from the region of the live points'))));
  const mine = S.runs.filter((x) => x.star === S.name), cur = mine[mine.length - 1], same = cur ? mine.filter((x) => x.bands === cur.bands) : [], best = same.length ? Math.max(...same.map((x) => x.logZ)) : 0;
  $('runsTable').innerHTML = ''; $('runsTable').append(h('table', { class: 'src' }, h('tbody', {}, h('tr', {}, ...['Fit', 'Set-up', 'Bands', 'Teff (K)', 'ln Z', 'Δ ln Z'].map((t) => h('th', {}, t))),
    mine.map((x) => h('tr', {}, h('td', {}, String(x.n)), h('td', {}, x.what), h('td', {}, String(x.nb)), h('td', {}, `${x.teff.median.toFixed(0)} +${(x.teff.hi - x.teff.median).toFixed(0)} −${(x.teff.median - x.teff.lo).toFixed(0)}`), h('td', {}, `${x.logZ.toFixed(2)} ± ${x.logZerr.toFixed(2)}`), h('td', {}, cur && x.bands === cur.bands ? (x.logZ - best).toFixed(2) : 'other bands'))))),
    h('p', { class: 'note' }, 'Change a prior or the extinction limit and fit again: the fits line up here. Δ ln Z compares fits of the same magnitudes only (it is the log of the Bayes factor; a difference above about 2.5 favours the higher one, above 5 strongly). Fits with different bands ticked answer different questions and are not compared.'));
  $('latex').value = sedLatex(r, S.name, r.priors || priorsForFit());
  for (const t of r.warnings.filter((x) => !/not constrained by the data|edge of its prior/.test(x))) w.append(h('p', { class: 'note warn' }, t));
  if (p.av && priorsForFit().avMax > 0 && p.av.hi - p.av.lo > 0.6 * priorsForFit().avMax) w.append(h('p', { class: 'note' }, 'The extinction is not pinned down by these magnitudes: its range is the range allowed. The temperature moves with it (more dust, hotter star), which is part of its error bar.'));
}
const stem = () => S.name.replace(/[^\w.-]+/g, '_');
async function saveCsv() {
  const r = S.result; if (!r) return;
  const head = `# ${S.name}: SED fit, Exoplanet Science Lab (Star page), ${new Date(now()).toISOString()}\n# ${Object.entries(r.parameters).map(([k, v]) => `${k} = ${v.median.toPrecision(6)} +${(v.hi - v.median).toPrecision(3)} -${(v.median - v.lo).toPrecision(3)}`).join('; ')}\n`;
  await saveFile(`${stem()}_sed.csv`, head + 'band,pivot_micron,magnitude,error,model_magnitude,residual\n' + r.bands.map((b) => [b.band, b.pivot.toFixed(5), b.mag, b.err, b.model.toFixed(4), b.residual.toFixed(4)].join(',')).join('\n') + '\n# model spectrum at the observer\nwavelength_micron,flux_W_m2_micron\n' + r.spectrum.wl.map((w, i) => `${w.toPrecision(6)},${r.spectrum.flux[i].toExponential(5)}`).join('\n') + '\n');
}
async function savePng() { const cv = document.createElement('canvas'); cv.width = 1800; cv.height = 1000; const ctx = cv.getContext('2d'); ctx.scale(2, 2); renderSed(ctx, 900, 500, sedData(), PRINT_THEME); await saveFile(`${stem()}_sed.png`, await canvasToPNG(cv)); }
async function saveLatex() { if (S.result) await saveFile(`${stem()}_sed.tex`, $('latex').value); }
async function saveCorner() {
  if (!S.result) return; const r = S.result, cv = document.createElement('canvas');
  drawCorner(cv, { ...r.posterior, logl: null }, r.posterior.labels, null, { theme: 'light', width: Math.max(700, 170 * r.posterior.labels.length), scale: 2, title: `${S.name}: spectral energy distribution fit` });
  await saveFile(`${stem()}_sed_corner.png`, await canvasToPNG(cv));
}
async function saveSamples() {
  const r = S.result; if (!r) return; const p = r.posterior, rows = [];
  for (let i = 0; i < p.n; i++) if (p.weights[i] > 0) rows.push([p.weights[i].toExponential(5), ...Array.from(p.samples.subarray(i * p.ndim, (i + 1) * p.ndim), (v) => v.toPrecision(7))].join(','));
  await saveFile(`${stem()}_sed_samples.csv`, `# ${S.name}: posterior samples of the SED fit (nested sampling; use the weights)\nweight,${p.names.join(',')}\n` + rows.join('\n') + '\n');
}
async function saveJson() { const r = S.result; if (!r) return; await saveFile(`${stem()}_sed.json`, JSON.stringify({ format: 'esl-sed-fit', version: 1, name: S.name, saved: new Date(now()).toISOString(), magnitudes: S.obs, priors: priorsForFit(), parameters: r.parameters, bands: r.bands, chi2: r.chi2, logZ: r.logZ, sampler: r.sampler, converged: r.converged, warnings: r.warnings, models: S.grid }, null, 1) + '\n'); }

buildAll();
addEventListener('resize', () => draw());
fetchOr(String(new URL('stellar/phoenix.esls', siteRoot())), { what: 'The stellar spectra', as: 'arrayBuffer', timeout: 60000 })
  .then((b) => worker.postMessage({ type: 'grid', buffer: b }, [b])).catch((err) => setStatus('stRun', 'The model stars could not be loaded: ' + String((err && err.message) || err), 'err'));

// ------------------------------------------------------------------------------------------------- window.__esl.star
// What the site's assistant drives (the contract is at the top of src/assistant/pages.js): the page's own lookup, table
// and fit, so the page shows what was done. Results are numbers with their errors, never the samples.
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra });
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const pm = (v, d) => ({ value: +v.median.toPrecision(d), plus: +(v.hi - v.median).toPrecision(2), minus: +(v.median - v.lo).toPrecision(2) });
  const out = () => {
    const r = S.result, mags = S.obs.map((o) => ({ band: o.band, mag: Number(o.mag), err: Number(o.err), used: !!o.use, ...(o.why ? { why_not: o.why } : {}) }));
    if (!r) return { star: S.name, magnitudes: mags, priors: priorsForFit(), fitted: false, ...(S.lastError ? { error: S.lastError } : {}) };
    const p = r.parameters;
    return { star: S.name, fitted: true, teff_K: pm(p.teff, 4), angular_diameter_mas: pm(p.theta_mas, 4), ...(p.rstar ? { radius_Rsun: pm(p.rstar, 4), luminosity_Lsun: pm(p.lum, 4), distance_pc: pm(p.dist_pc, 5) } : {}), bolometric_flux_W_m2: pm(p.fbol, 4), extinction_Av_mag: priorsForFit().avMax > 0 ? pm(p.av, 2) : 'fixed at 0', logg: pm(p.logg, 3), feh: pm(p.feh, 2), extra_scatter_mag: pm(p.scatter_mag, 2),
      sampler: { ln_Z: +r.sampler.logZ.toFixed(2), ln_Z_err: +r.sampler.logZerr.toFixed(2), converged: r.sampler.converged, model_evaluations: r.sampler.ncalls, effective_samples: Math.round(r.sampler.ess) }, chi2: +r.chi2.toFixed(1),
      bands: r.bands.map((b) => ({ band: b.band, observed: b.mag, model: +b.model.toFixed(3), residual_mag: +b.residual.toFixed(3) })), not_used: mags.filter((m) => !m.used), priors: r.priors || priorsForFit(), measured_otherwise: S.known || undefined,
      fits_compared: S.runs.filter((x) => x.star === S.name).map((x) => ({ fit: x.n, set_up: x.what, bands: x.nb, teff_K: +x.teff.median.toFixed(0), ln_Z: +x.logZ.toFixed(2) })), warnings: r.warnings.filter((x) => !/edge of its prior|not constrained by the data/.test(x)),
      note: 'Magnitudes hardly constrain log g and [Fe/H]: without priors their values are not measurements. One model grid (PHOENIX), main-sequence stars from 2300 to 8000 K.' };
  };
  const refit = async () => { fit(); await new Promise((res) => setTimeout(res, 30)); await whenFitted(); return out(); };
  const tools = [
    { name: 'star_get', readOnly: true, core: true, description: 'The star now on the page: its magnitudes (used and set aside), the priors, and the result of the fit if there is one (temperature, angular diameter, radius, luminosity with their errors; the evidence; the residual of every band).', parameters: obj({}), run: async () => { await whenFitted(); return out(); } },
    { name: 'star_lookup', core: true, description: 'Look a star up by name and fit it: magnitudes and parallax from Gaia DR3, 2MASS, AllWISE and Tycho-2 (VizieR), position, log g and [Fe/H] from the site\'s catalogue when it hosts a known planet. Saturated or flagged bands are set aside. Returns the fit.', parameters: obj({ name: T('Star name, e.g. "HD 209458" or "WASP-39".') }, ['name']),
      run: async ({ name }) => { $('name').value = name; S.name = name; await lookup(); await new Promise((res) => setTimeout(res, 30)); await whenFitted(); return { lookup: $('stEx').textContent, ...out() }; } },
    { name: 'star_set', core: true, description: 'Set the star\'s magnitudes and what is known already, then fit. magnitudes replaces the table: {band: [magnitude, error]} with bands such as "Gaia G", "Gaia BP", "Gaia RP", "2MASS J", "2MASS H", "2MASS Ks", "WISE W1".."W4", "Tycho BT", "Tycho VT", "Johnson B", "Johnson V", "SDSS g" (each catalogue\'s own magnitude system). use / leave_out switch bands of the present table on or off. parallax, logg, feh are [value, error]; av_max bounds the extinction (0 fixes it at zero; right for stars within about 70 pc).',
      parameters: obj({ name: T('Name of the star (labels the result).'), magnitudes: { type: 'object', description: 'Band name -> [magnitude, error]; replaces the table.', additionalProperties: { type: 'array', items: N('magnitude, then its error') } }, use: { type: 'array', items: T('A band name.'), description: 'Bands to switch on.' }, leave_out: { type: 'array', items: T('A band name.'), description: 'Bands to switch off.' },
        parallax: { type: 'array', items: N('mas, then its error'), description: '[parallax in mas, error].' }, logg: { type: 'array', items: N('value, then sigma'), description: '[log g, sigma] prior.' }, feh: { type: 'array', items: N('value, then sigma'), description: '[[Fe/H], sigma] prior.' }, av_max: N('Largest extinction A_V considered [mag].') }),
      run: async (c) => {
        if (c.name) { S.name = c.name; $('name').value = c.name; }
        if (c.magnitudes) { const bad = Object.keys(c.magnitudes).filter((b) => !PASSBANDS[b]); if (bad.length) throw new Error(`unknown band${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}. Bands: ${Object.keys(PASSBANDS).join(', ')}`); S.obs = Object.entries(c.magnitudes).map(([band, v]) => ({ band, mag: Number(v[0]), err: Number(v[1] ?? 0.02), use: true })); S.known = null; }
        for (const b of c.use || []) { const o = S.obs.find((x) => x.band === b); if (!o) throw new Error(`${b} is not in the table`); o.use = true; } for (const b of c.leave_out || []) { const o = S.obs.find((x) => x.band === b); if (!o) throw new Error(`${b} is not in the table`); o.use = false; }
        if (c.parallax) { S.priors.plx = c.parallax[0]; S.priors.plxErr = c.parallax[1]; } if (c.logg) { S.priors.logg = c.logg[0]; S.priors.loggErr = c.logg[1]; } if (c.feh) { S.priors.feh = c.feh[0]; S.priors.fehErr = c.feh[1]; } if (c.av_max != null) S.priors.avMax = Math.max(0, c.av_max);
        buildPriors(); buildObs(); return refit();
      } },
    { name: 'star_export', description: 'Give the user the result of the fit as files: "latex" (two tables: parameters with priors, photometry with the model), "csv" (magnitudes, model magnitudes and the model spectrum), "json" (every number and the inputs), "samples" (the weighted posterior samples). Needs a fit.', parameters: obj({ what: T('Which file.', { enum: ['latex', 'csv', 'json', 'samples'] }) }, ['what']),
      run: async ({ what }, { files }) => { await whenFitted(); const r = S.result; if (!r) throw new Error('there is no fit yet: star_lookup or star_set first'); const stemName = stem();
        if (what === 'latex') return { written: await files.write(`${stemName}_sed.tex`, sedLatex(r, S.name, r.priors || priorsForFit())) };
        if (what === 'json') return { written: await files.write(`${stemName}_sed.json`, JSON.stringify({ format: 'esl-sed-fit', version: 1, name: S.name, magnitudes: S.obs, priors: r.priors || priorsForFit(), parameters: r.parameters, bands: r.bands, chi2: r.chi2, sampler: r.sampler, warnings: r.warnings }, null, 1) + '\n') };
        if (what === 'samples') { const po = r.posterior, rows = []; for (let i = 0; i < po.n; i++) if (po.weights[i] > 0) rows.push([po.weights[i].toExponential(5), ...Array.from(po.samples.subarray(i * po.ndim, (i + 1) * po.ndim), (v) => v.toPrecision(7))].join(',')); return { written: await files.write(`${stemName}_sed_samples.csv`, `weight,${po.names.join(',')}\n` + rows.join('\n') + '\n'), samples: rows.length }; }
        return { written: await files.write(`${stemName}_sed.csv`, 'band,pivot_micron,magnitude,error,model_magnitude,residual\n' + r.bands.map((b) => [b.band, b.pivot.toFixed(5), b.mag, b.err, b.model.toFixed(4), b.residual.toFixed(4)].join(',')).join('\n') + '\n') };
      } },
  ];
  (window.__esl = window.__esl || {}).star = { tools, ready: () => S.ready === true,
    state: () => { const r = S.result; return [`Star: ${S.name}; ${S.obs.filter((o) => o.use).length} magnitudes in use${S.busy ? '; a fit is running' : ''}.`, r ? `Fit: Teff ${r.parameters.teff.median.toFixed(0)} K, angular diameter ${r.parameters.theta_mas.median.toFixed(4)} mas${r.parameters.rstar ? `, radius ${r.parameters.rstar.median.toFixed(3)} Rsun` : ''}; ln Z ${r.sampler.logZ.toFixed(2)}. Tools: star_get, star_lookup, star_set, star_export.` : 'No fit yet: star_lookup (by name) or star_set (magnitudes).']; } };
}

