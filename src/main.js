import { activeParams, STAR_PARAMS, toTransitParams, buildProblem, infoCriteria, autoSupersample, A1_PRIOR_WIDTH, PLANET_FIELDS, planetKey, jitterKey } from './core/model.js';
import { arsFromKepler, semiAmplitude, makeRV } from './core/rv.js';
import { LD_LAWS, toClaret, checkProfile, intensity, kippingToQuadratic, quadraticToKipping } from './core/limbdark.js';
import { orbitElements } from './core/kepler.js';
import { makeTransit } from './core/transit.js';
import { PRIOR_TYPES, validatePrior } from './core/priors.js';
import { synthesize, parseLightCurve, nearestEpoch, TIME_SYSTEMS, FLUX_UNITS, combineEpochs, removeEpoch, splitByOrbit, foldTimes, epochList, parseRV } from './core/data.js';
import { weightedQuantiles, resampleIndices, makeRng } from './core/stats.js';
import { runFit } from './core/fitRunner.js';
import { deriveSystem, planetClass, C as CONST } from './core/derive.js';
import { hzProfile } from './core/hz.js';
import { FILTERS, greyProfile, fitLaw, interpLDGrid, gridFromTable, readLDTable, makeLDTie } from './core/ldest.js';
import { estimateMassRadius } from './core/stellar.js';
import { configToObject, toYAML, parseConfig } from './core/config.js';
import { HD80606_TESS } from './data/hd80606_tess.js';
import { LD_TABLE } from './data/ld_table.js';
import { LightCurvePlot, renderLightCurve, LC_THEMES, GROUP_COLORS } from './ui/lightcurve.js';
import { drawCorner } from './ui/corner.js';
import { renderRV } from './ui/rvplot.js';
import { saveFile, canvasToPNG, canvasToPDF, latexTable } from './ui/export.js';
import { recordMovie, movieSupport } from './ui/movie.js';
import { buildTimingTab } from './ui/timingTab.js';
import { EXAMPLES } from './ui/examples.js';
import { initIntro, provenanceTable, checkList } from './ui/intro.js';
import { createFallbackViz } from './viz/fallback2d.js';
import { teffToRGB } from './viz/color.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};
const num = (v, d = 4) => (Number.isFinite(v) ? Number(v).toFixed(d) : '—');
const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- presets ------------------------------------------------------------------
// Stellar values: HD 80606 from Pearson et al. (2022) Table 7; toy-1873 from the EXOTIC
// multi-planet example; HAT-P-32 are approximate literature values for illustration.
const PRESETS = {
  hatp32: {
    label: 'HAT-P-32 b · simulated ground-based night', name: 'HAT-P-32 b', ldLaw: 'quadratic', band: 'MObs CV (clear)',
    star: { teff: 6001, teffErr: 88, logg: 4.22, loggErr: 0.04, feh: -0.16, fehErr: 0.08, rstar: 1.22, rstarErr: 0.02, mstar: 1.16, mstarErr: 0.04, mplanet: null, mplanetErr: 0 },
    values: { rprs: 0.1489, ars: 5.344, inc: 88.98, per: 2.1500082, tmid: 0, ecc: 0.159, omega: 50, ld0: 0.33, ld1: 0.29, ld2: 0, ld3: 0, a2: -0.03 },
    data: { kind: 'synthetic', exptimeMin: 1, noisePpm: 1800, baselineHr: 0.6, airmass: true, seed: 1 },
    free: ['rprs', 'inc', 'tmid', 'a2'],
  },
  hd80606: {
    label: 'HD 80606 b · TESS light curve from your EXOTIC archive', name: 'HD 80606 b', ldLaw: 'nonlinear', band: 'TESS (approx.)',
    star: { teff: 5565, teffErr: 92, logg: 4.4, loggErr: 0.1, feh: 0.35, fehErr: 0.06, rstar: 1.05, rstarErr: 0.01, mstar: 1.05, mstarErr: 0.047, mplanet: 4.1641, mplanetErr: 0.0047 },
    values: { rprs: 0.072, ars: 97, inc: 89.269, per: 111.4367, tmid: 1.0757, ecc: 0.93132, omega: -58.699, ld0: 0.49387, ld1: -0.07295, ld2: 0.45785, ld3: -0.21582, a2: 0 },
    data: { kind: 'builtin' },
    free: ['rprs', 'inc', 'tmid'],
  },
  toy: {
    label: 'toy-1873 b · simulated space photometry (small planet)', name: 'toy-1873 b', ldLaw: 'kipping', band: 'TESS (approx.)',
    star: { teff: 5605, teffErr: 100, logg: 4.47, loggErr: 0.1, feh: 0, fehErr: 0.1, rstar: 0.974, rstarErr: 0.02, mstar: 1.02, mstarErr: 0.04, mplanet: 0.0283, mplanetErr: 0 },
    values: { rprs: 0.0273, ars: 15.9, inc: 88.0, per: 7.0057, tmid: 0, ecc: 0, omega: 0, ld0: 0.42, ld1: 0.31, ld2: 0, ld3: 0, a2: 0 },
    data: { kind: 'synthetic', exptimeMin: 2, noisePpm: 260, baselineHr: 2.9, airmass: false, seed: 5 },
    free: ['rprs', 'inc', 'tmid'],
  },
};

const S = {
  preset: 'hatp32', name: '', star: {}, ldLaw: 'quadratic', values: {}, truth: null,
  band: 'TESS (approx.)', bandCustom: [500, 900], table: LD_TABLE ? { kind: 'json', table: LD_TABLE, name: 'bundled PHOENIX table' } : null, ldProfile: null, ldMsg: '', keepPhysical: true,
  ldMode: 'coeffs',        // 'coeffs': sample the coefficients; 'star': sample Teff (and [Fe/H]) and derive them
  data: null, dataId: 0, raw: null, parseOpts: { time: 'auto', flux: 'auto' }, synth: {}, exptimeMin: 0,
  free: {}, priors: {}, sampler: { nlive: 400, fracRemain: 0.01, seed: 42 },
  fit: null, range: 'full', runs: [], running: false, live: null,
  planets: [{ sfx: '', letter: 'b' }], pl: '',   // planets of the system (key suffixes) and the one the sliders, 3D view and folds show
  kepler: false,           // a/R★ of every planet from Kepler's law with M★, R★ and the planet's mass, instead of a free a/R★
  rv: [],                  // radial-velocity datasets [{ name, t, v, e }], times on the light curve's reference
  use: { lc: true, rv: false, timing: false },   // which kinds of data enter the fit
  view: 'lc',              // what the data panel shows: 'lc' or 'rv'
  plot: { ptAlpha: 0.45, modelAlpha: 1, bins: true, color: true },
  sources: null,           // where the system parameters came from (catalog look-up), for the System tab
  note: '',                // one line about the loaded example or catalog system, shown on the Fit and Data tabs
  fold: false,             // light curve drawn against time from the nearest transit (several epochs on top of each other)
  hz: false, albedo: [0.2, 0.4],
  timing: { rows: [], order: 1, text: '' },   // mid-transit times (absolute days) for the Timing tab
  t: 0, playing: true, loop: 'transit', speed: 0,
};
let viz = null, lcPlot = null, model = null, refreshQueued = false, runner = null;

// ---- undo / redo ----------------------------------------------------------------
// Everything the user can change is captured before each action; data and fit results
// are held by reference (they are replaced, never edited in place).
const UNDO = [], REDO = [];
const SNAP_COPY = ['preset', 'name', 'ldLaw', 'band', 'ldMsg', 'keepPhysical', 'ldMode', 'dataId', 'exptimeMin', 'range', 'hz', 'fold', 'pl', 'kepler', 'view', 'note'];
const SNAP_DEEP = ['star', 'values', 'bandCustom', 'parseOpts', 'synth', 'free', 'priors', 'sampler', 'albedo', 'timing', 'planets', 'use', 'plot'];
const SNAP_REF = ['data', 'raw', 'truth', 'fit', 'table', 'ldProfile', 'rv', 'sources'];
function snapshot() { const o = {}; SNAP_COPY.forEach((k) => (o[k] = S[k])); SNAP_DEEP.forEach((k) => (o[k] = clone(S[k]))); SNAP_REF.forEach((k) => (o[k] = S[k])); return o; }
function applySnapshot(o) { SNAP_COPY.forEach((k) => (S[k] = o[k])); SNAP_DEEP.forEach((k) => (S[k] = clone(o[k]))); SNAP_REF.forEach((k) => (S[k] = o[k])); S.live = null; buildPanels(); refresh(true); }
function pushUndo() { UNDO.push(snapshot()); if (UNDO.length > 120) UNDO.shift(); REDO.length = 0; undoButtons(); }
function undo() { if (S.running || !UNDO.length) return; REDO.push(snapshot()); applySnapshot(UNDO.pop()); undoButtons(); flash('Undone'); }
function redo() { if (S.running || !REDO.length) return; UNDO.push(snapshot()); applySnapshot(REDO.pop()); undoButtons(); flash('Redone'); }
function undoButtons() { const u = $('#undo'), r = $('#redo'); if (u) { u.disabled = !UNDO.length; r.disabled = !REDO.length; } }
function flash(t) { const e = $('#flash'); if (!e) return; e.textContent = t; clearTimeout(flash.t); flash.t = setTimeout(() => (e.textContent = ''), 1600); }

// ---- star ---------------------------------------------------------------------

/** Star with mass and radius filled from Teff, log g, [Fe/H] when the user has not supplied them. */
function starNow(st = S.star) {
  if (st.rstar > 0 && st.mstar > 0) return st;
  const est = estimateMassRadius(st);
  return { ...st, rstar: st.rstar > 0 ? st.rstar : est.rstar, rstarErr: st.rstar > 0 ? st.rstarErr : est.rstarErr, mstar: st.mstar > 0 ? st.mstar : est.mstar, mstarErr: st.mstar > 0 ? st.mstarErr : est.mstarErr, estimated: true };
}

// ---- limb darkening sources -----------------------------------------------------

function bandRange() { return S.band === 'Custom range' ? [Math.min(...S.bandCustom), Math.max(...S.bandCustom)] : FILTERS[S.band]; }
/** Coefficient grid for a law from the loaded or bundled table, or null. */
function gridFor(law) {
  if (!S.table || S.band === 'Custom range') return null;   // a custom wavelength range has no tabulated band: the grey estimate covers it
  const g = S.table.kind === 'json' ? gridFromTable(S.table.table, law) : S.table.grid.law === law ? S.table.grid : null;
  // a table with several bands must hold the selected one; a single-band table is taken to be the user's band
  if (g && g.filters.length > 1 && !g.filters.some((f) => f.toLowerCase() === S.band.toLowerCase())) return null;
  return g;
}
function gridFilter(g) { return g.filters.length > 1 ? (g.filters.find((f) => f.toLowerCase() === S.band.toLowerCase()) || g.filters[0]) : g.filters[0]; }
/** Coefficients of the current law for a star, from the table when there is one, else the grey atmosphere. */
function ldFromStar(teff, feh) {
  const g = gridFor(S.ldLaw);
  if (g) { const r = interpLDGrid(g, teff, S.star.logg, feh, gridFilter(g)); return { coeffs: r.coeffs, source: 'table', info: r }; }
  const [w0, w1] = bandRange(), prof = greyProfile(teff, w0, w1), fit = fitLaw(S.ldLaw, prof);
  return { coeffs: fit.coeffs, source: 'grey', prof, rms: fit.rms };
}
function tieSpec(free) {
  if (S.ldMode !== 'star' || S.ldLaw === 'uniform') return null;
  const g = gridFor(S.ldLaw), rng = (key, fallback) => {
    const f = free.find((x) => x.key === key); if (!f) return [fallback - 1e-3, fallback + 1e-3];
    return f.prior.type === 'normal' ? [f.prior.a - 6 * f.prior.b, f.prior.a + 6 * f.prior.b] : [f.prior.a, f.prior.b];
  };
  const tr = rng('teff', S.star.teff); tr[0] = Math.max(2300, tr[0]); tr[1] = Math.min(12000, tr[1]);
  return { law: S.ldLaw, source: g ? 'grid' : 'grey', band: bandRange(), grid: g, filter: g ? gridFilter(g) : '', logg: S.star.logg, teffRange: tr, fehRange: rng('feh', S.star.feh) };
}
/** In star mode the coefficients are not free: keep them equal to what the star implies. */
function syncStarLD() {
  if (S.ldMode !== 'star' || S.ldLaw === 'uniform') return;
  const key = [S.star.teff, S.star.feh, S.star.logg, S.ldLaw, S.band, S.bandCustom, S.table && S.table.name].join('|');
  if (syncStarLD.key === key) return;
  syncStarLD.key = key;
  const r = ldFromStar(S.star.teff, S.star.feh);
  r.coeffs.forEach((c, i) => (S.values['ld' + i] = c)); S.ldProfile = r.prof || null;
}

// ---- priors -------------------------------------------------------------------

/** Airmass flag of the light curve, or one flag per epoch when there are several. */
const airSpec = () => (S.data.epoch ? S.data.segments.map((sg) => sg.airmass) : !!S.data.airmass);
/** Parameters of the current model: orbit, limb darkening, and one airmass coefficient per epoch that has airmass. */
const rvOn = () => S.use.rv && S.rv.length > 0;
const actParams = () => activeParams(S.ldLaw, airSpec(), { planets: S.planets, kepler: S.kepler, mass: rvOn(), rv: rvOn() ? S.rv.map((d) => d.name) : [] });
/** Key of a planet-level parameter of the planet on show. */
const PK = (field) => planetKey(field, S.pl);
const baseKey = (key) => key.split('@')[0];
/**
 * One planet's parameters as a plain { rprs, ars, inc, per, tmid, ecc, omega, mplanet, ld0..3, a2 } object,
 * with a/R★ from Kepler's law when that mode is on. Everything that draws or derives works on this.
 */
function planetValues(values, sfx = S.pl, star) {
  const o = { ...values };
  for (const f of PLANET_FIELDS) { const k = planetKey(f, sfx); o[f] = values[k] !== undefined ? values[k] : values[f]; }
  if (S.kepler) { const st = star || starNow(); o.ars = arsFromKepler(o.per, values.mstar ?? st.mstar, o.mplanet || 0, values.rstar ?? st.rstar); }
  return o;
}
const cur = (values = S.live || S.values) => planetValues(values, S.pl);
const planetLabel = (sfx = S.pl) => { const p = S.planets.find((x) => x.sfx === sfx) || S.planets[0]; return S.planets.length > 1 ? `${S.name} ${p.letter}` : S.name; };
const nEpochs = () => (S.data.epoch ? S.data.segments.length : 1);
/** Per-epoch airmass coefficients ("a2@1", ...) get a value, a prior and a tick the first time they appear. */
function ensureEpochParams() {
  for (const p of actParams()) {
    if (!p.key.startsWith('a2@')) continue;
    if (!Number.isFinite(S.values[p.key])) S.values[p.key] = Number.isFinite(S.values.a2) ? S.values.a2 : 0;
    if (!S.priors[p.key]) S.priors[p.key] = defaultPrior(p.key);
    if (S.free[p.key] === undefined) S.free[p.key] = true;
  }
}

function fitParams() {
  let act = actParams();
  // without the light curve in the fit, nothing constrains the radius ratio, the limb darkening or the airmass slope
  if (!S.use.lc) return act.filter((p) => p.base !== 'rprs' && p.group !== 'ld' && p.group !== 'baseline');
  if (S.ldMode !== 'star' || S.ldLaw === 'uniform') return act;
  return [...act.filter((p) => p.ld === undefined), ...STAR_PARAMS.filter((p) => p.key === 'teff' || gridFor(S.ldLaw))];
}
const paramValue = (key) => (key === 'teff' || key === 'feh' ? S.star[key] : key === 'mstar' || key === 'rstar' ? starNow()[key] : S.values[key]);

function defaultPrior(key) {
  const r = (x) => Number(x.toPrecision(6)), base = baseKey(key), sfx = PLANET_FIELDS.includes(base) ? key.split('@')[1] || '' : S.pl;
  const v = paramValue(key) ?? 0, d = deriveSystem(planetValues(S.values, sfx), starNow());
  if (base === 'a2') return { type: 'uniform', a: -0.2, b: 0.2 };
  if (base === 'mplanet') return { type: 'uniform', a: 0, b: r(Math.max(5 * v, 0.02)) };
  if (base === 'rvlin') return { type: 'uniform', a: -0.1, b: 0.1 };
  if (base === 'rvquad') return { type: 'uniform', a: -1e-3, b: 1e-3 };
  if (base === 'jit') { const ds = S.rv[Number(key.slice(6)) - 1], e = ds ? Float64Array.from(ds.e).sort()[ds.e.length >> 1] : 5; return { type: 'uniform', a: 0, b: r(Math.max(15, 5 * e)) }; }
  if (base === 'mstar' || base === 'rstar') { const e = S.star[base + 'Err']; return { type: 'normal', a: r(v), b: r(e > 0 ? e : 0.05 * v) }; }
  switch (base) {
    case 'rprs': return { type: 'uniform', a: r(Math.max(0.001, v * 0.5)), b: r(Math.min(0.6, v * 1.6)) };
    case 'ars': return { type: 'uniform', a: r(Math.max(1.2, v * 0.75)), b: r(v * 1.3) };
    case 'inc': return { type: 'uniform', a: r(Math.max(60, v - 5)), b: 90 };
    case 'per': {
      // several epochs measure the period: allow it to move the last transit by a quarter of its duration
      // relative to the first, which is wide for the data yet too narrow to miscount orbits
      if (nEpochs() > 1 && S.use.lc) { const sg = S.data.segments, orbits = Math.max(1, (sg[sg.length - 1].t1 - sg[0].t0) / v), w = (0.25 * (d.t14 || 0.1)) / orbits; return { type: 'uniform', a: Number((v - w).toPrecision(10)), b: Number((v + w).toPrecision(10)) }; }
      return { type: 'normal', a: v, b: r(Math.max(1e-6, v * 1e-5)) };
    }
    case 'tmid': { const w = Math.max(0.01, 0.2 * (d.t14 || 0.1)); return { type: 'uniform', a: r(v - w), b: r(v + w) }; }
    case 'ecc': return { type: 'uniform', a: 0, b: r(Math.min(0.95, Math.max(0.3, v + 0.2))) };
    case 'omega': return { type: 'uniform', a: r(v - 30), b: r(v + 30) };
    case 'teff': return { type: 'normal', a: v, b: S.star.teffErr > 0 ? S.star.teffErr : 100 };
    case 'feh': return { type: 'normal', a: v, b: S.star.fehErr > 0 ? S.star.fehErr : 0.1 };
    default:
      if (S.ldLaw === 'kipping') return { type: 'uniform', a: 0, b: 1 };
      return { type: 'uniform', a: r(v - 0.3), b: r(v + 0.3) };
  }
}
function resetPriors(keys) { for (const k of keys) S.priors[k] = defaultPrior(k); }

// ---- data ---------------------------------------------------------------------

function makeSynthetic() {
  const o = S.synth;
  const wasMulti = !!(S.data && S.data.epoch);
  S.data = synthesize(cur(S.values), S.ldLaw, { ...o, k: S.values.a2 });
  S.dataId++; S.fit = null; S.raw = null; S.range = 'full'; S.fold = !!S.data.epoch;
  S.exptimeMin = S.data.exptimeMin;
  if (!S.data.airmass) S.free.a2 = false;
  // every simulated night has the same extinction slope, so that is the truth for each epoch's coefficient
  for (const p of actParams()) if (p.key.startsWith('a2@')) S.values[p.key] = S.values.a2;
  ensureEpochParams(); if (wasMulti !== !!S.data.epoch) resetPriors(['per']);
  S.truth = { ...S.values, teff: S.star.teff, feh: S.star.feh };
}
function setData(d, keepEpoch) {
  S.data = d; S.dataId++; S.truth = null; S.fit = null; S.range = 'full'; S.fold = !!d.epoch;
  if (!keepEpoch) S.values[PK('tmid')] = nearestEpoch(cur(S.values).tmid, cur(S.values).per, d.t);
  if (!d.airmass) S.free.a2 = false;
  ensureEpochParams();
}
/**
 * Install a dataset made of several epochs (or what is left after removing one). T mid stays where
 * it is when it falls in an epoch; otherwise it moves by whole periods into the middle epoch.
 */
function setEpochData(d) {
  setData(d, true); S.raw = null;
  const segs = epochList(d), c = cur(S.values), tm = c.tmid, pad = 0.25 * c.per;
  const sg = segs.find((x) => tm >= x.t0 - pad && tm <= x.t1 + pad) || segs[segs.length >> 1];
  S.values[PK('tmid')] = nearestEpoch(tm, c.per, [sg.t0, sg.t1]);
  resetPriors([PK('tmid'), PK('per')]); S.t = S.values[PK('tmid')];
  buildPanels(); refresh(true);
}
function addEpochText(text, name, msgEl) {
  try {
    const p = parseLightCurve(text, name, { time: 'auto', flux: 'auto' });
    const d = combineEpochs([S.data, p]);
    pushUndo(); setEpochData({ ...d, name: `${S.name} · ${d.segments.length} epochs` });
    flash(`Epoch added: ${d.segments.length} in total`);
  } catch (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--bad)'; } }
}

/** Parameters that appear with velocities (planet masses, trend, jitters) get a value, a prior and a sensible tick. */
function ensureRVParams() {
  for (const p of actParams()) {
    if (p.base === 'mplanet') { if (!(S.values[p.key] >= 0)) S.values[p.key] = 1; if (S.free[p.key] === undefined) S.free[p.key] = true; }
    else if (p.group === 'rv') { if (!Number.isFinite(S.values[p.key])) S.values[p.key] = 0; if (S.free[p.key] === undefined) S.free[p.key] = false; }
    else continue;
    if (!S.priors[p.key]) S.priors[p.key] = defaultPrior(p.key);
  }
}
/** Add radial velocities from text. Each instrument in the file becomes its own dataset. */
function addRVText(text, name, msgEl) {
  try {
    const r = parseRV(text, name.replace(/\.[a-z0-9]+$/i, ''));
    pushUndo();
    let tRef = S.data.tRef || 0;
    const first = Math.min(...r.sets.map((x) => x.t[0]));
    if (!tRef && first > 1e5) {
      // dated velocities next to an undated (simulated) light curve: the light curve is only a stand-in, so put it on the velocities' calendar and leave it out of the fit
      tRef = Math.floor(first); S.data = { ...S.data, tRef }; S.dataId++; S.use = { ...S.use, lc: false };
    }
    const taken = new Set(S.rv.map((x) => x.name));
    const sets = r.sets.map((x) => { let nm = x.name, k = 2; while (taken.has(nm)) nm = `${x.name} ${k++}`; taken.add(nm); return { name: nm, t: Float64Array.from(x.t, (v) => v - (v > 1e5 ? tRef : 0)), v: x.v, e: x.e }; });
    const firstRV = !S.rv.length;
    S.rv = [...S.rv, ...sets]; S.use = { ...S.use, rv: true }; S.view = 'rv'; S.fit = null; S.range = 'full';
    ensureRVParams();
    if (firstRV) for (const p of actParams()) if (p.base === 'mplanet') S.free[p.key] = true;   // velocities are what measure the masses
    buildPanels(); refresh(true); flash(`${sets.length} velocity set${sets.length > 1 ? 's' : ''} added` + (r.notes.length ? ' · ' + r.notes.join('; ') : ''));
  } catch (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--bad)'; } }
}
function removeRV(k) {
  pushUndo();
  // jitters are keyed by position: move the later ones down
  for (let d = k; d < S.rv.length; d++) for (const o of [S.values, S.free, S.priors]) { const a = jitterKey(d), b = jitterKey(d + 1); if (o[b] !== undefined) o[a] = o[b]; else delete o[a]; }
  S.rv = S.rv.filter((_, i) => i !== k); S.fit = null;
  if (!S.rv.length) { S.use = { ...S.use, rv: false, lc: true }; S.view = 'lc'; }
  buildPanels(); refresh(true);
}

/**
 * Load a session (ui/examples.js describes the shape): a system, its data, what is free and with
 * which priors. Used by the worked examples and by the catalog look-up.
 */
function applySession(sess) {
  if (S.running) stopFit();
  pushUndo();
  const first = sess.planets[0].letter, sfxOf = (letter) => (letter === first ? '' : letter);
  const scoped = (key) => key;   // session keys already use "name@letter", with the first planet unscoped
  S.preset = 'session'; S.name = sess.name; S.star = { ...sess.star }; S.ldLaw = sess.ldLaw; S.band = sess.band || S.band;
  S.planets = sess.planets.map((p) => ({ sfx: sfxOf(p.letter), letter: p.letter })); S.pl = ''; S.kepler = !!sess.kepler;
  // one time reference for everything: the light curve's, or the day of the earliest date in the session
  const dates = [...sess.rv.map((d) => d.t[0]), ...sess.timing.map((r) => r.t), ...sess.planets.map((p) => p.values.tmid)].filter((x) => x > 1e5);
  const tRef = sess.lc ? sess.lc.tRef || 0 : dates.length ? Math.floor(sess.rv.length ? Math.min(...sess.rv.map((d) => d.t[0])) : sess.planets[0].values.tmid) : 0;
  const rel = (t) => (t > 1e5 ? t - tRef : t);
  const values = { ld0: 0, ld1: 0, ld2: 0, ld3: 0, a2: 0, ...(sess.extra || {}) };
  for (const p of sess.planets) for (const [f, v] of Object.entries(p.values)) values[planetKey(f, sfxOf(p.letter))] = f === 'tmid' ? rel(v) : v;
  S.values = values; S.ldProfile = null; S.ldMsg = ''; S.ldMode = 'coeffs'; S.starMsg = '';
  if (sess.ld) sess.ld.forEach((c, i) => (values['ld' + i] = c));
  else { const r = ldFromStar(S.star.teff, S.star.feh); r.coeffs.forEach((c, i) => (values['ld' + i] = Number(c.toFixed(5)))); S.ldProfile = r.prof || null; }
  // data: the session's light curve, or one simulated from the first planet as a stand-in
  S.synth = { kind: 'synthetic', exptimeMin: 2, noisePpm: 500, baselineHr: 2, airmass: false, seed: 1 };
  if (sess.lc) { S.data = sess.lc; S.exptimeMin = sess.exptimeMin ?? 0; }
  else {
    const d = synthesize(planetValues(values, ''), S.ldLaw, S.synth);
    // the stand-in follows the whole model: where another planet transits during this window, it shows
    const others = S.planets.slice(1).map((p) => { try { return makeTransit(toTransitParams(planetValues(values, p.sfx), S.ldLaw)); } catch { return () => 1; } });
    const f = others.length ? Float64Array.from(d.f, (x, i) => others.reduce((m, g) => m * g(d.t[i]), x)) : d.f;
    S.data = { ...d, f, tRef, name: 'Simulated light curve (stand-in)' }; S.exptimeMin = d.exptimeMin;
  }
  S.dataId++; S.raw = null; S.fit = null; S.live = null; S.range = 'full';
  S.rv = sess.rv.map((d) => ({ name: d.name, t: Float64Array.from(d.t, rel), v: d.v, e: d.e }));
  S.timing = { rows: sess.timing.map((r) => ({ t: r.t, e: r.e, epoch: null, kind: r.kind || 'transit', planet: sfxOf(r.planet || first), src: r.src || '' })), order: 1, text: '' };
  S.use = { lc: true, rv: false, timing: false, ...sess.use }; S.view = sess.view || 'lc'; S.fold = sess.fold ?? !!S.data.epoch;
  S.free = {}; S.priors = {};
  ensureEpochParams(); ensureRVParams();
  const act = fitParams(), want = new Set(sess.free.map(scoped));
  for (const prm of act) S.free[prm.key] = want.has(prm.key);
  resetPriors([...act.map((x) => x.key), 'teff', 'feh', 'mstar', 'rstar']);
  for (const [k, pr] of Object.entries(sess.priors || {})) S.priors[k] = k.split('@')[0] === 'tmid' ? { ...pr, a: rel(pr.a), ...(pr.type === 'uniform' ? { b: rel(pr.b) } : {}) } : { ...pr };
  S.truth = sess.truth ? { ...values, teff: S.star.teff, feh: S.star.feh, ...sess.truth } : null;
  S.sources = sess.sources || null; S.note = sess.note || '';
  S.t = values.tmid;
  const ps = $('#preset'); let opt = ps.querySelector('option[value=session]'); if (!opt) { opt = h('option', { value: 'session' }); ps.append(opt); } opt.textContent = sess.title || sess.name; ps.value = 'session';
  buildPanels(); refresh(true); showTab(sess.tab || 'system');
}
/** A worked example: a built-in preset with adjustments, or a session read from public/examples. */
async function loadExample(ex) {
  if (ex.load) { const sess = await ex.load(fetchText); applySession({ ...sess, title: `${ex.title} · EXOTIC example` }); return; }
  if (S.running) stopFit();
  pushUndo(); $('#preset').value = ex.preset; loadPreset(ex.preset);
  if (ex.synth) { Object.assign(S.synth, ex.synth); makeSynthetic(); S.t = cur(S.values).tmid; }
  if (ex.free) { for (const prm of fitParams()) if (prm.group === 'planet') S.free[prm.key] = ex.free.includes(prm.key); }
  S.note = `EXOTIC example ${ex.exotic}: ${ex.sub}.`;
  buildPanels(); refresh(true); showTab('fit');
}
const fetchText = async (path) => { const r = await fetch(new URL(path, document.baseURI)); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.text(); };
const fetchCatalog = async (name) => { const r = await fetch(new URL('catalog/' + name, document.baseURI)); if (!r.ok) throw new Error(`The parameter catalog could not be read (${name}: HTTP ${r.status}).`); return r.json(); };

function loadPreset(key) {
  const p = PRESETS[key];
  S.preset = key; S.name = p.name; S.star = { ...p.star }; S.ldLaw = p.ldLaw; S.band = p.band; S.values = { ...p.values }; S.fit = null; S.live = null; S.ldProfile = null; S.ldMsg = ''; S.ldMode = 'coeffs'; S.range = 'full';
  S.planets = [{ sfx: '', letter: 'b' }]; S.pl = ''; S.kepler = false; S.rv = []; S.use = { lc: true, rv: false, timing: false }; S.view = 'lc'; S.sources = null; S.note = '';
  if (p.star.mplanet > 0) S.values.mplanet = p.star.mplanet;   // the planet's mass is a planet parameter
  S.timing = { rows: [], order: 1, text: '' };   // the times belong to the previous planet
  S.free = {}; p.free.forEach((k) => (S.free[k] = true));
  if (p.data.kind === 'synthetic') { S.synth = { ...p.data }; makeSynthetic(); }
  else {
    const D = HD80606_TESS;
    setData({ name: D.name, tRef: D.tRef, t: Float64Array.from(D.t), f: Float64Array.from(D.f), e: Float64Array.from(D.e), airmass: null, notes: ['times shown as JD − ' + D.tRef, 'the TESS aperture also contains HD 80607, which dilutes the transit: the fitted Rp/R★ and planet radius are about 30% too small'] }, true);
    S.raw = null; S.exptimeMin = 2; S.synth = { kind: 'synthetic', exptimeMin: 2, noisePpm: 600, baselineHr: 3, airmass: false, seed: 1 };
  }
  S.priors = {};
  resetPriors([...activeParams(S.ldLaw, true).map((x) => x.key), 'teff', 'feh']);
  S.t = S.values.tmid;
  buildPanels(); refresh(true);
}

// ---- model evaluation -----------------------------------------------------------

/** Sub-samples per exposure: enough for the planet with the shortest ingress. */
function supersampleFor(values) { const exptime = S.exptimeMin / 1440; let ns = 1; for (const p of S.planets) { try { ns = Math.max(ns, autoSupersample(exptime, planetValues(values, p.sfx))); } catch { /* invalid geometry: the likelihood rejects it */ } } return ns; }
/** Mid-transit and mid-eclipse times of the Timing tab, grouped per planet and kind, on the light curve's time reference. */
function timingSets() {
  const tRef = S.data.tRef || 0, groups = new Map();
  for (const r of S.timing.rows) { const k = (r.planet || '') + '|' + (r.kind || 'transit'); if (!groups.has(k)) groups.set(k, { planet: r.planet || '', kind: r.kind || 'transit', t: [], e: [] }); const g = groups.get(k); g.t.push(r.t - tRef); g.e.push(r.e); }
  return [...groups.values()].filter((g) => S.planets.some((p) => p.sfx === g.planet));
}
/**
 * The specification handed to buildProblem. `use` says which kinds of data enter: the fit takes S.use,
 * the plots take everything that is loaded so every panel has its model.
 */
function fitSpec(values = S.values, free = [], use = { lc: true, rv: S.rv.length > 0, timing: false }) {
  const exptime = S.exptimeMin / 1440, st = starNow();
  return {
    data: use.lc ? S.data : null, rv: use.rv ? S.rv : [], timing: use.timing ? timingSets() : [],
    planets: S.planets.map((p) => p.sfx), kepler: S.kepler,
    values: { ...values, a2: S.data.airmass ? values.a2 : undefined, teff: values.teff ?? S.star.teff, feh: values.feh ?? S.star.feh, mstar: values.mstar ?? st.mstar, rstar: values.rstar ?? st.rstar },
    ldLaw: S.ldLaw, free, exptime, supersample: supersampleFor(values),
  };
}
/**
 * Model flux as a function of time, including exposure averaging: every planet's transit
 * multiplied together, or one planet alone (`only` = its suffix) for a plot folded on it.
 */
function fluxFunction(values, only) {
  const fs = [];
  for (const p of S.planets) { if (only !== undefined && p.sfx !== only) continue; try { fs.push(makeTransit(toTransitParams(planetValues(values, p.sfx), S.ldLaw))); } catch { /* skip a planet with impossible geometry */ } }
  if (!fs.length) return () => 1;
  const f = fs.length === 1 ? fs[0] : (t) => { let m = 1; for (const g of fs) m *= g(t); return m; };
  const exp = S.exptimeMin / 1440, ns = supersampleFor(values), dt = exp / ns;
  if (ns === 1) return f;
  return (t) => { let s = 0; for (let j = 0; j < ns; j++) s += f(t + (j - (ns - 1) / 2) * dt); return s / ns; };
}
function computeModel(values) {
  const d = S.data, n = d.t.length;
  const prob = buildProblem(fitSpec(values)), det = prob.detail([]);
  const base = new Float64Array(n).fill(1), tr = new Float64Array(n).fill(1);
  let chi2 = NaN, rms = NaN, a1 = 1;
  if (det) {
    a1 = det.a1; chi2 = det.chi2; base.set(det.base); tr.set(det.transit);   // each epoch has its own baseline
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (d.f[i] / base[i] - tr[i]) ** 2;
    rms = Math.sqrt(ss / n);
  }
  return { base, tr, a1, chi2, rms, valid: !!det, det, rvTref: prob.rvTref };
}
const claretNow = (values = S.values) => toClaret(S.ldLaw, LD_LAWS[S.ldLaw].names.map((_, i) => values['ld' + i]));

function refresh(resetView) { if (resetView) refresh.reset = true; if (!refreshQueued) { refreshQueued = true; requestAnimationFrame(doRefresh); } }
function doRefresh() {
  refreshQueued = false;
  if (!S.live) syncStarLD();
  const all = S.live || S.values, values = cur(all), claret = claretNow(all), st = starNow(), many = S.planets.length > 1;
  const el = orbitElements(values), der = deriveSystem(values, { ...st, mplanet: values.mplanet }), cls = planetClass(der.rpEarth, der.teq);
  model = computeModel(all);
  // folded on one planet of several: that planet's model alone (the others are divided out of the data)
  const flux = fluxFunction(all, S.fold && many ? S.pl : undefined), depth = 1 - fluxFunction(all, S.pl)(values.tmid);
  const hz = S.hz ? hzProfile({ teff: st.teff, teffErr: st.teffErr || 0, albedo: S.albedo }) : null;
  if (viz) viz.setSystem({ el, rprs: values.rprs, claret, teff: all.teff ?? st.teff, name: planetLabel(), look: cls.key, hz });
  // the annotation EXOTIC puts on its light curves: fitted radius ratio and mid-transit time
  const fs = (k) => S.fit && !S.live && S.fit.summary.find((x) => x.key === PK(k)), tRef = S.data.tRef || 0;
  const pmTxt = (label, v, s, dg) => (s ? `${label} = ${s.med.toFixed(dg)} ± ${(0.5 * (s.plus + s.minus)).toFixed(dg)}` : `${label} = ${v.toFixed(dg)}`);
  const sr = fs('rprs'), stm = fs('tmid');
  const pts = S.fold ? foldedPoints(values) : { t: S.data.t, f: S.data.f, e: S.data.e, base: model.base, model: model.tr, group: S.data.epoch || null };
  $('#lcfold').classList.toggle('on', S.fold);
  document.querySelectorAll('#viewsel button').forEach((b) => { b.classList.toggle('on', b.dataset.v === S.view); if (b.dataset.v === 'rv') b.disabled = !S.rv.length; });
  if (S.view === 'rv' && !S.rv.length) S.view = 'lc';
  lcPlot.alt = S.view === 'rv' ? { data: rvPlotData(all), render: renderRV } : null;
  lcPlot.opts = { ...S.plot, groups: S.data.epoch ? S.data.segments.map((sg) => sg.name) : null };
  const win = S.fold && many && der.t14 > 0 ? { x0: values.tmid - 2.5 * der.t14, x1: values.tmid + 2.5 * der.t14 } : {};
  lcPlot.set({
    ...pts, ...win, tmid: values.tmid, fluxFn: flux,
    band: S.fit && S.fit.band && !S.live && !!S.fit.band.folded === S.fold && (S.fit.band.pl ?? '') === S.pl ? S.fit.band : null, cursor: cursorTime(S.t),
    stats: { rms: model.rms },
    info: [pmTxt('Rp/R★', values.rprs, sr, sr ? Math.max(4, digitsFor(sr)) : 4), stm ? `T mid = ${(stm.med + tRef).toFixed(Math.max(4, digitsFor(stm)))} ± ${(0.5 * (stm.plus + stm.minus)).toFixed(Math.max(4, digitsFor(stm)))}` : `T mid = ${(values.tmid + tRef).toFixed(5)}`],
    label: (many && S.fold ? planetLabel() + ' · ' : '') + S.data.name + (S.use.lc ? '' : ' · not in the fit') + (S.data.airmass ? ' · detrended by a₁·exp(k·airmass)' : '') + (S.live ? ' · sampling…' : S.fit ? ' · best fit' : ''),
  }, refresh.reset);
  refresh.reset = false;
  const prof = checkProfile(claret);
  let hzLine = '';
  if (hz) { const n = hz.nominal, au = (x) => ((x * st.rstar * CONST.Rsun) / CONST.AU).toFixed(2); hzLine = `<span style="color:#6fe3a5">HZ ${au(n.runaway)}–${au(n.maxGreen)} au · planet ${values.ars < n.recentVenus ? 'interior to it' : values.ars > n.earlyMars ? 'beyond it' : 'inside it'}</span>`; }
  $('#readout').innerHTML = `<b>${planetLabel()}</b><span>${cls.label} · ${num(der.rpEarth, der.rpEarth < 10 ? 2 : 1)} R⊕</span><span>b ${num(der.b, 3)} · T₁₄ ${num(der.t14 * 24, 2)} h · depth ${(depth * 100).toFixed(3)} %</span>` + hzLine + (der.t14 > 0 ? '' : '<span style="color:#ffb454">no transit at this geometry</span>');
  const dv = $('#derived');
  if (dv) dv.innerHTML = [
    ['Impact parameter b', num(der.b, 4) + (der.b > 1 - values.rprs && der.t14 > 0 ? ' · grazing' : '')], ['Duration T₁₄', num(der.t14 * 24, 3) + ' h'],
    ['Mid-transit depth', (depth * 1e6).toFixed(0) + ' ppm'], ['Planet radius', `${num(der.rpJup, 3)} R Jup · ${num(der.rpEarth, 2)} R⊕`],
    ['Semi-major axis', num(der.aAU, 4) + ' au'], ['Equilibrium temp.', num(der.teq, 0) + ' K'],
    ['Stellar density', num(der.rhoStar, 3) + ' g/cm³'], ['Insolation', num(der.insol, der.insol > 100 ? 0 : 2) + ' S⊕'],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  const bd = $('#ldbadge');
  if (bd) { bd.className = 'badge ' + (prof.negative ? 'bad' : prof.nonMonotonic ? 'warn' : 'ok'); bd.textContent = prof.negative ? 'negative intensity' : prof.nonMonotonic ? 'brightens toward limb' : 'physical profile'; }
  drawLD(claret);
}

/** The light curve with every point moved by whole periods to the transit at T mid, in time order. */
function foldedPoints(values) {
  const ft = foldTimes(S.data.t, values.per, values.tmid), idx = Array.from(ft.keys()).sort((a, b) => ft[a] - ft[b]);
  const take = (a) => Float64Array.from(idx, (i) => a[i]);
  // several planets: show this planet's transit, with the other planets' model divided out of the data
  const trs = model.det && model.det.transits, me = S.planets.findIndex((p) => p.sfx === S.pl);
  let f = S.data.f, tr = model.tr;
  if (trs && me >= 0) { tr = trs[me]; f = Float64Array.from(S.data.f, (x, i) => (tr[i] > 0 ? (x * tr[i]) / model.tr[i] : x)); }
  return { t: take(ft), f: take(f), e: take(S.data.e), base: take(model.base), model: take(tr), group: S.data.epoch ? Int32Array.from(idx, (i) => S.data.epoch[i]) : null };
}
/**
 * What the radial-velocity panel draws. Zero points are removed from every instrument. In time the
 * model is every planet plus the trend; folded, it is the planet on show, with the other planets
 * and the trend taken out of the data.
 */
function rvPlotData(all) {
  const det = model && model.det, label = `${planetLabel()} · radial velocities` + (rvOn() ? '' : ' · not in the fit');
  if (!det || !det.rv) return { sets: [], label: S.rv.length ? 'No valid model for the velocities at these parameters' : 'No radial velocities loaded' };
  const st = starNow(), me = Math.max(0, S.planets.findIndex((p) => p.sfx === S.pl)), c = planetValues(all), tRef = S.data.tRef || 0;
  const fns = S.planets.map((p) => { const q = planetValues(all, p.sfx), K = Number.isFinite(q.K) ? q.K : semiAmplitude(q.per, q.ecc || 0, q.inc, q.mplanet || 0, all.mstar ?? st.mstar); return { f: makeRV({ per: q.per, tmid: q.tmid, ecc: q.ecc || 0, omega: q.omega || 0, K }), K, per: q.per }; });
  const lin = all.rvlin || 0, quad = all.rvquad || 0, t0 = model.rvTref || 0;
  let tmin = Infinity, tmax = -Infinity;
  const sets = S.rv.map((D, d) => {
    const R = det.rv[d], n = D.t.length, x = new Float64Array(n), y = new Float64Array(n), e = new Float64Array(n), res = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      res[i] = D.v[i] - R.gamma - R.model[i]; e[i] = Math.hypot(D.e[i], R.jitter);
      if (S.fold) { const ph = (D.t[i] - c.tmid) / c.per; x[i] = ph - Math.round(ph); y[i] = res[i] + R.planets[me][i]; }
      else { x[i] = D.t[i]; y[i] = D.v[i] - R.gamma; tmin = Math.min(tmin, D.t[i]); tmax = Math.max(tmax, D.t[i]); }
    }
    return { name: D.name, x, y, e, res };
  });
  const curve = { x: [], y: [] };
  if (S.fold) { const N = 2400; for (let i = 0; i <= N; i++) { const ph = -0.5 + i / N; curve.x.push(ph); curve.y.push(fns[me].f(c.tmid + ph * c.per)); } }
  else {
    // enough samples to follow the shortest period (an eccentric orbit's periastron swing is brief)
    const span = tmax - tmin || 1, pmin = Math.min(...fns.map((q) => q.per)), N = Math.round(Math.min(12000, Math.max(800, (60 * span) / pmin)));
    for (let i = 0; i <= N; i++) { const t = tmin - 0.03 * span + (1.06 * span * i) / N, dt = t - t0; let m = lin * dt + quad * dt * dt; for (const q of fns) m += q.f(t); curve.x.push(t); curve.y.push(m); }
  }
  const ss = sets.reduce((a, s2) => a + s2.res.reduce((b, r) => b + r * r, 0), 0), nn = sets.reduce((a, s2) => a + s2.x.length, 0);
  return { sets, curve, fold: S.fold, label, xlabel: S.fold ? `Orbital phase of ${planetLabel()} (0 = mid-transit)` : tRef ? `BJD − ${tRef}` : 'Time (days)', info: [`K = ${fns[me].K.toFixed(fns[me].K < 20 ? 2 : 1)} m/s`, `rms ${Math.sqrt(ss / Math.max(1, nn)).toFixed(2)} m/s`] };
}

/** Where the time cursor sits on the light curve plot (folded like the data when the plot is). */
function cursorTime(t) { if (!S.fold) return t; const v = cur(), p = (t - v.tmid) / v.per; return v.tmid + (p - Math.round(p)) * v.per; }

function drawLD(a) {
  const cv = $('#ldcanvas'), disc = $('#lddisc'); if (!cv) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return; // tab not visible
  cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const X = (r) => 30 + r * (W - 40), Y = (I) => H - 18 - Math.min(1.15, Math.max(-0.1, I)) / 1.15 * (H - 28);
  c.strokeStyle = '#1e2638'; c.lineWidth = 1; c.font = '9.5px ui-monospace, monospace'; c.fillStyle = '#8491ad'; c.textAlign = 'right'; c.textBaseline = 'middle';
  for (const v of [0, 0.5, 1]) { c.beginPath(); c.moveTo(X(0), Y(v)); c.lineTo(X(1), Y(v)); c.stroke(); c.fillText(v.toFixed(1), 26, Y(v)); }
  c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText('centre', X(0) + 14, H - 13); c.fillText('r / R★', X(0.5), H - 13); c.fillText('limb', X(1) - 10, H - 13);
  if (S.ldProfile) { // the stellar-atmosphere estimate the coefficients were fitted to
    c.strokeStyle = '#5fd4ff'; c.setLineDash([3, 3]); c.lineWidth = 1.2; c.beginPath();
    S.ldProfile.mu.forEach((m, i) => { const r = Math.sqrt(1 - m * m); i ? c.lineTo(X(r), Y(S.ldProfile.I[i])) : c.moveTo(X(r), Y(S.ldProfile.I[i])); });
    c.stroke(); c.setLineDash([]);
  }
  c.strokeStyle = '#ffc56b'; c.lineWidth = 1.8; c.beginPath();
  for (let i = 0; i <= 200; i++) { const r = i / 200, I = intensity(Math.sqrt(1 - r * r), a); i ? c.lineTo(X(r), Y(I)) : c.moveTo(X(r), Y(I)); }
  c.stroke();
  const s = disc.clientWidth; disc.width = s * dpr; disc.height = s * dpr; const g = disc.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [r0, g0, b0] = teffToRGB(S.star.teff).map((v) => v * 255), gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2 - 2);
  for (let i = 0; i <= 48; i++) { const x = i / 48, I = Math.min(1, Math.max(0, intensity(Math.sqrt(1 - x * x), a))); gr.addColorStop(x, `rgb(${r0 * I | 0},${g0 * I | 0},${b0 * I | 0})`); }
  g.clearRect(0, 0, s, s); g.fillStyle = gr; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 2, 0, 7); g.fill();
}

// ---- System tab ---------------------------------------------------------------

const SLIDER = { rprs: [0.005, 0.3, 'log'], ars: [1.5, 150, 'log'], inc: [75, 90], per: [0.3, 200, 'log'], ecc: [0, 0.95], omega: [-180, 180], a2: [-0.2, 0.2], mplanet: [0.001, 30, 'log'], rvlin: [-1, 1], rvquad: [-0.01, 0.01], jit: [0, 50] };
function fullRange(key) {
  const base = baseKey(key);
  if (base === 'tmid') { const v = S.values[key] ?? 0, per = S.values[planetKey('per', key.split('@')[1] || '')] || 1; return [Math.min(S.data.t[0], v - per / 2), Math.max(S.data.t[S.data.t.length - 1], v + per / 2)]; }
  if (base.startsWith('ld')) return S.ldLaw === 'kipping' ? [0, 1] : [-1, 1.5];
  return SLIDER[base];
}
/** Slider span for the chosen range mode: the whole physical range, the prior, or the posterior ± 5σ. */
function rangeFor(key, mode = S.range) {
  if (mode === 'fit' && S.fit) {
    const s = S.fit.summary.find((x) => x.key === key);
    if (s && s.plus + s.minus > 0) return [Math.min(s.med - 5 * s.minus, s.best), Math.max(s.med + 5 * s.plus, s.best), 'lin', 'fit ± 5σ'];
  }
  if (mode === 'prior' && S.free[key] && S.priors[key] && !validatePrior(S.priors[key])) {
    const p = S.priors[key];
    return p.type === 'normal' ? [p.a - 5 * p.b, p.a + 5 * p.b, 'lin', 'prior'] : [p.a, p.b, 'lin', 'prior'];
  }
  return fullRange(key);
}
function setRange(mode) {
  pushUndo(); S.range = mode;
  for (const prm of actParams()) {
    const k = prm.key, r = rangeFor(k);
    if (!r[3]) continue;
    if (mode === 'fit') S.values[k] = S.fit.summary.find((x) => x.key === k).best;            // jump to the best fit
    else if (S.values[k] < r[0] || S.values[k] > r[1]) S.values[k] = 0.5 * (r[0] + r[1]);     // bring the value inside the prior
  }
  buildSystemTab(); refresh();
}
function paramRow(prm) {
  const key = prm.key, [lo, hi, scale, limited] = rangeFor(key), locked = prm.ld !== undefined && S.ldMode === 'star';
  const toS = (v) => (scale === 'log' ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo)) * 1000;
  const fromS = (s) => (scale === 'log' ? lo * Math.pow(hi / lo, s / 1000) : lo + ((hi - lo) * s) / 1000);
  const range = h('input', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': prm.label, class: limited ? 'limited' : '', disabled: locked });
  const box = h('input', { type: 'number', step: prm.step, 'aria-label': prm.label + ' value', disabled: locked });
  if (!Number.isFinite(S.values[key])) S.values[key] = 0;
  const sync = () => { range.value = Math.min(1000, Math.max(0, toS(S.values[key]))); box.value = Number(S.values[key].toFixed(prm.digits)); };
  const set = (v) => {
    if (!Number.isFinite(v)) return;
    const old = S.values[key];
    S.values[key] = limited ? Math.min(hi, Math.max(lo, v)) : Math.min(prm.max, Math.max(prm.min, v));
    // refuse limb darkening settings that describe an impossible star
    if (prm.ld !== undefined && S.keepPhysical && !checkProfile(claretNow()).ok && checkProfile(claretNow({ ...S.values, [key]: old })).ok) S.values[key] = old;
    if (prm.ld !== undefined) { S.ldProfile = null; }
    refresh();
  };
  // one undo step per drag, not per pixel
  let dragging = false;
  range.addEventListener('pointerdown', () => { dragging = false; });
  range.addEventListener('input', () => { if (!dragging) { pushUndo(); dragging = true; } set(Number(fromS(Number(range.value)).toPrecision(7))); box.value = Number(S.values[key].toFixed(prm.digits)); });
  range.addEventListener('change', () => { dragging = false; range.value = toS(S.values[key]); });
  box.addEventListener('change', () => { pushUndo(); set(Number(box.value)); sync(); });
  sync();
  const row = h('div', { class: 'row', title: (prm.help || '') + (limited ? ` · slider spans the ${limited}: ${Number(lo.toPrecision(5))} … ${Number(hi.toPrecision(5))}` : '') }, h('label', {}, prm.label, prm.unit ? h('small', {}, prm.unit) : null), range, box);
  row._sync = sync;
  return row;
}

function numField(label, obj, key, attrs = {}, after) {
  const i = h('input', { type: 'number', step: 'any', value: obj[key] ?? '', 'aria-label': label, ...attrs });
  i.addEventListener('change', () => { pushUndo(); const v = i.value === '' ? null : Number(i.value); obj[key] = Number.isFinite(v) ? v : null; if (after) after(); refresh(); });
  return i;
}
function pairField(label, obj, key, errKey, attrs = {}, hint, errAttrs = {}) {
  return h('div', { class: 'field3', title: hint || '' }, h('span', {}, label), numField(label, obj, key, attrs), errKey ? h('span', { class: 'pm' }, '±') : h('span'), errKey ? numField(label + ' uncertainty', obj, errKey, { min: 0, ...errAttrs }) : h('span'));
}

function buildSystemTab() {
  const el = $('#tab-system'); el.innerHTML = '';
  const act = actParams();
  const many = S.planets.length > 1;
  // which planet the sliders, the 3D view and the folded plots show; adding and removing planets
  const chip = (p) => h('button', { class: p.sfx === S.pl ? 'on' : '', title: `Show planet ${p.letter}`, onclick: () => { if (p.sfx === S.pl) return; pushUndo(); S.pl = p.sfx; S.t = cur(S.values).tmid; buildPanels(); refresh(true); } }, p.letter);
  el.append(h('div', { class: 'rangebar planets' }, h('span', {}, many ? 'Planet' : 'Planets'), h('div', { class: 'seg small', id: 'planetsel' }, S.planets.map(chip)),
    h('button', { class: 'chip small', title: 'Add another planet around this star', onclick: addPlanet }, '+ planet'),
    many && S.pl ? h('button', { class: 'chip small', title: `Remove planet ${S.planets.find((p) => p.sfx === S.pl).letter}`, onclick: () => removePlanet(S.pl) }, '✕ remove') : null));
  const rb = (mode, label, title, dis) => h('button', { class: S.range === mode ? 'on' : '', title, disabled: dis, onclick: () => setRange(mode) }, label);
  el.append(h('h3', {}, many ? `Planet ${S.planets.find((p) => p.sfx === S.pl).letter} & orbit` : 'Planet & orbit', h('button', { class: 'chip small', title: 'Put every slider back to the values this system loaded with', onclick: resetDefaults }, '↺ Reset')));
  el.append(h('div', { class: 'rangebar' }, h('span', {}, 'Slider range'), h('div', { class: 'seg small' },
    rb('full', 'Full', 'Sliders span the whole physical range'),
    rb('prior', 'Prior', 'Sliders of the parameters ticked on the Fit tab span their priors'),
    rb('fit', 'Best fit ± 5σ', 'Jump to the best fit; sliders of fitted parameters span median ± 5σ', !S.fit))));
  el.append(...act.filter((p) => p.group === 'planet' && p.planet === S.pl).map((p) => paramRow({ ...p, label: p.label.split(' · ')[0] })));
  if (!act.some((p) => p.base === 'mplanet')) {
    const mk = PK('mplanet'), mi = h('input', { type: 'number', step: 'any', min: 0, value: S.values[mk] ?? '', placeholder: 'optional', 'aria-label': 'Planet mass in Jupiter masses' });
    mi.addEventListener('change', () => { pushUndo(); const v = Number(mi.value); if (mi.value !== '' && v > 0) S.values[mk] = v; else delete S.values[mk]; refresh(); });
    el.append(h('div', { class: 'field', title: 'Optional planet mass from radial velocities. Only used to report K and the planet density, until velocities are loaded.' }, h('span', {}, 'Mp (M Jup)'), mi));
  }
  const kp0 = h('input', { type: 'checkbox', checked: S.kepler });
  kp0.addEventListener('change', () => { pushUndo(); setKepler(kp0.checked); });
  el.append(h('label', { class: 'tog', title: 'One orbit for photometry, velocities and timing: the semi-major axis follows from the period and the masses, and a/R★ from R★. Needed for a joint transit + radial-velocity fit.' }, kp0, 'a/R★ from Kepler’s law (M★, R★, planet mass)'));
  el.append(h('div', { class: 'kv', id: 'derived' }));

  const st = S.star, res = starNow();
  el.append(h('h3', {}, 'Star'));
  const refreshStar = () => { buildSystemTab(); };
  el.append(
    pairField('T eff (K)', st, 'teff', 'teffErr', { min: 2300, max: 12000, step: 10 }),
    pairField('log g (cgs)', st, 'logg', 'loggErr', { step: 0.01 }),
    pairField('[Fe/H]', st, 'feh', 'fehErr', { step: 0.01 }),
    pairField('R★ (R☉)', st, 'rstar', 'rstarErr', { min: 0.05, step: 0.01, placeholder: res.estimated && !(st.rstar > 0) ? res.rstar.toFixed(3) + ' est.' : '' }, 'Leave empty to estimate from T eff, log g and [Fe/H]', { placeholder: res.estimated && !(st.rstar > 0) ? res.rstarErr.toFixed(3) : '' }),
    pairField('M★ (M☉)', st, 'mstar', 'mstarErr', { min: 0.05, step: 0.01, placeholder: res.estimated && !(st.mstar > 0) ? res.mstar.toFixed(3) + ' est.' : '' }, 'Leave empty to estimate from T eff, log g and [Fe/H]', { placeholder: res.estimated && !(st.mstar > 0) ? res.mstarErr.toFixed(3) : '' }),
  );
  el.querySelectorAll('.field3 input').forEach((i) => i.addEventListener('change', refreshStar));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => { pushUndo(); const e = estimateMassRadius(S.star); Object.assign(S.star, { rstar: Number(e.rstar.toFixed(3)), rstarErr: Number(e.rstarErr.toFixed(3)), mstar: Number(e.mstar.toFixed(3)), mstarErr: Number(e.mstarErr.toFixed(3)) }); S.starMsg = `Torres et al. (2010) relation: R★ = ${e.rstar.toFixed(3)} ± ${e.rstarErr.toFixed(3)} R☉, M★ = ${e.mstar.toFixed(3)} ± ${e.mstarErr.toFixed(3)} M☉.` + (e.extrapolated ? ' <span style="color:var(--warn)">Outside the calibrated range (stars above 0.6 M☉): treat as rough.</span>' : ''); buildSystemTab(); refresh(); } }, 'Estimate R★ and M★ from T eff, log g, [Fe/H]')));
  el.append(h('p', { class: 'note', html: S.starMsg || 'If you only have spectroscopic parameters, leave R★ and M★ empty (or press the button): they are estimated from the Torres et al. (2010) eclipsing-binary calibration, good to about 3% in radius and 6% in mass for F, G and K dwarfs.' }));

  // where the starting values came from (catalog look-up)
  if (S.sources) {
    const src = S.sources, pl = src.planets.find((x) => x.letter === (S.planets.find((q) => q.sfx === S.pl) || {}).letter) || src.planets[0];
    const bad = pl.checks.filter((c) => c.status !== 'ok').length;
    el.append(h('details', { class: 'sources' }, h('summary', {}, `Parameter sources · ${pl.reference.label}` + (bad ? ` · ${bad} check${bad > 1 ? 's' : ''} to look at` : ' · checks pass')),
      h('p', { class: 'note' }, `NASA Exoplanet Archive snapshot of ${src.snapshot}. These were the starting values; the sliders and fits have moved on from them.`),
      provenanceTable(h, pl.values, ['per', 'tmid', 'rprs', 'ars', 'inc', 'ecc', 'omega', 'mplanet', 'K', 't14', 'b']), checkList(h, pl.checks),
      provenanceTable(h, src.star.values, ['teff', 'logg', 'feh', 'rstar', 'mstar'])));
  }

  const lawSel = h('select', { 'aria-label': 'Limb darkening law', onchange: (e) => changeLaw(e.target.value) }, Object.entries(LD_LAWS).map(([k, v]) => h('option', { value: k, selected: k === S.ldLaw }, v.label)));
  el.append(h('h3', {}, 'Limb darkening', h('span', { class: 'badge ok', id: 'ldbadge' }, '')));
  el.append(h('div', { class: 'field' }, h('span', {}, 'Law'), lawSel));
  el.append(...act.filter((p) => p.ld !== undefined).map(paramRow));
  if (S.ldMode === 'star') el.append(h('p', { class: 'note' }, 'Coefficients follow the star (set on the Fit tab), so these sliders are locked. Change T eff or [Fe/H] above to move them.'));
  el.append(h('div', { class: 'ldwrap' }, h('canvas', { id: 'ldcanvas' }), h('canvas', { id: 'lddisc', style: 'height:96px;background:#000' })));
  const kp = h('input', { type: 'checkbox', checked: S.keepPhysical }); kp.addEventListener('change', () => (S.keepPhysical = kp.checked));
  if (S.ldLaw !== 'kipping' && S.ldLaw !== 'uniform' && S.ldMode !== 'star') el.append(h('label', { class: 'tog' }, kp, 'Keep the profile physical (no negative or limb-brightened discs)'));

  // estimate coefficients from stellar parameters
  const bandSel = h('select', { 'aria-label': 'Bandpass' }, [...Object.keys(FILTERS), 'Custom range'].map((k) => h('option', { value: k, selected: k === S.band }, S.table && S.table.kind === 'json' ? k.replace(' (approx.)', '') : k)));
  const c0 = h('input', { type: 'number', value: S.bandCustom[0], min: 200, max: 5000, step: 10, 'aria-label': 'Band minimum (nm)' }), c1 = h('input', { type: 'number', value: S.bandCustom[1], min: 200, max: 5000, step: 10, 'aria-label': 'Band maximum (nm)' });
  const custom = h('div', { class: 'field3', hidden: S.band !== 'Custom range' }, h('span', {}, 'Range (nm)'), c0, h('span', { class: 'pm' }, '–'), c1);
  bandSel.addEventListener('change', () => { pushUndo(); S.band = bandSel.value; syncStarLD.key = null; buildPanels(); refresh(); });   // the source of the coefficients (table or grey estimate) depends on the band
  [c0, c1].forEach((i, j) => i.addEventListener('change', () => { pushUndo(); S.bandCustom[j] = Number(i.value); refresh(); }));
  const gridIn = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.json', 'aria-label': 'Limb darkening coefficient table' });
  gridIn.addEventListener('change', async () => {
    if (!gridIn.files[0]) return;
    pushUndo();
    try { const r = readLDTable(await gridIn.files[0].text()); S.table = { ...r, name: gridIn.files[0].name }; S.ldMsg = `Loaded <b>${S.table.name}</b>: ${(r.kind === 'json' ? r.table.rows : r.grid.rows).length} rows${r.kind === 'csv' ? `, ${LD_LAWS[r.grid.law].label} coefficients` : ', all laws'}.`; }
    catch (err) { S.ldMsg = `<span style="color:var(--bad)">${err.message}</span>`; }
    syncStarLD.key = null; buildPanels(); refresh();
  });
  const haveTable = !!gridFor(S.ldLaw);
  el.append(h('h3', {}, 'Coefficients from the star'));
  el.append(h('div', { class: 'field' }, h('span', {}, 'Bandpass'), bandSel), custom);
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: estimateLD, disabled: S.ldLaw === 'uniform' }, haveTable ? 'Set from model-atmosphere table' : 'Estimate from T eff'),
    h('span', { class: 'note' }, haveTable ? `using ${S.table.name}` : 'grey-atmosphere model')));
  el.append(h('p', { class: 'note', id: 'ldmsg', html: S.ldMsg }));
  el.append(h('details', {}, h('summary', {}, 'Where these numbers come from, and loading a PHOENIX table'),
    h('p', { class: 'note', html: 'The bundled table holds PHOENIX model-atmosphere limb darkening (Husser et al. 2013) for 37 bands on T eff 2300–8000 K, log g 4.0–5.5 and [Fe/H] −0.5 to +0.5, built by <b>tools/build_ld_table.py</b>. It is interpolated to the star, and values outside the grid are clamped to its edge and flagged. Against ExoTETHyS for the same models the intensity profile agrees to about 0.001 rms; different atmosphere models (ATLAS) differ from it by about 0.01, which is the real uncertainty of any tabulated coefficient.' }),
    h('p', { class: 'note', html: 'A <b>Custom range</b>, or a band the table lacks, uses the emergent intensity of a grey atmosphere averaged over the wavelength range instead: it follows T eff and wavelength only, and <b>log g and [Fe/H] have no effect</b>. You can also load your own table: ld_table.json from the builder, or a CSV with columns teff, logg, feh, optional filter, and 1, 2 or 4 coefficients.' }),
    h('div', { class: 'drop' }, 'Coefficient table: ', gridIn)));

  if (rvOn()) {
    el.append(h('h3', {}, 'Radial velocity'), ...act.filter((p) => p.group === 'rv').map(paramRow));
    el.append(h('p', { class: 'note', html: 'Each instrument has its own zero point, integrated out analytically like the light-curve normalisation, and its own jitter added in quadrature to its error bars. The trend terms are shared: the star drifts on one path.' }));
  }
  const extra = act.filter((p) => p.key.startsWith('a2'));
  el.append(h('h3', {}, 'Baseline'), ...extra.map(paramRow));
  el.append(h('p', { class: 'note', html: nEpochs() > 1 ? `Each of the ${nEpochs()} epochs has its own baseline <b>a₁·exp(k·airmass)</b>: its own normalisation a₁, integrated out analytically and never sampled, and its own k when it has an airmass column. The planet and orbit are shared.` : S.data.airmass ? 'Baseline is <b>a₁·exp(k·airmass)</b>. The normalisation a₁ is integrated out analytically, so it is never sampled.' : 'No airmass column in this dataset: the baseline is a single normalisation a₁, integrated out analytically.' }));
}

/** Switch between a free a/R★ and a/R★ computed from Kepler's law. Keeps the orbit where it is when switching. */
function setKepler(on) {
  const st = starNow();
  if (!on) for (const p of S.planets) { const o = planetValues(S.values, p.sfx); S.values[planetKey('ars', p.sfx)] = Number(o.ars.toPrecision(8)); }   // freeze the Kepler value as the new free a/R★
  S.kepler = on; S.fit = null; S.range = 'full';
  for (const p of S.planets) { const k = planetKey('mplanet', p.sfx); if (on && !(S.values[k] >= 0)) S.values[k] = 0; S.free[planetKey('ars', p.sfx)] = false; if (!S.priors[k]) S.priors[k] = defaultPrior(k); }
  if (on) { if (!(S.star.rstar > 0)) { S.star.rstar = Number(st.rstar.toFixed(3)); S.star.rstarErr = Number(st.rstarErr.toFixed(3)); } if (!(S.star.mstar > 0)) { S.star.mstar = Number(st.mstar.toFixed(3)); S.star.mstarErr = Number(st.mstarErr.toFixed(3)); } resetPriors(['mstar', 'rstar']); }
  buildPanels(); refresh();
}
/** Add a planet: a copy of the one on show at about twice its period, to be edited. */
function addPlanet() {
  pushUndo();
  const used = new Set(S.planets.map((p) => p.letter)), letter = 'bcdefghijklmnop'.split('').find((c) => !used.has(c));
  if (!letter) return;
  const from = planetValues(S.values), sfx = letter;
  for (const f of PLANET_FIELDS) { if (f === 'K') continue; const v = f === 'per' ? Number((from.per * 2.3).toPrecision(6)) : f === 'ars' ? Number((from.ars * Math.pow(2.3, 2 / 3)).toPrecision(6)) : f === 'tmid' ? from.tmid + 0.37 * from.per : f === 'inc' ? Math.max(from.inc, 89.5) : from[f]; if (v !== undefined) S.values[planetKey(f, sfx)] = v; }
  if (!(S.values[planetKey('mplanet', sfx)] >= 0)) S.values[planetKey('mplanet', sfx)] = from.mplanet || 0;
  S.planets = [...S.planets, { sfx, letter }]; S.pl = sfx; S.fit = null; S.range = 'full';
  resetPriors(PLANET_FIELDS.filter((f) => f !== 'K').map((f) => planetKey(f, sfx)));
  S.t = S.values[planetKey('tmid', sfx)]; buildPanels(); refresh(true); flash(`Planet ${letter} added`);
}
function removePlanet(sfx) {
  if (!sfx || S.planets.length < 2) return;
  pushUndo();
  for (const f of PLANET_FIELDS) { const k = planetKey(f, sfx); delete S.values[k]; delete S.free[k]; delete S.priors[k]; }
  S.planets = S.planets.filter((p) => p.sfx !== sfx); S.pl = ''; S.fit = null; S.range = 'full';
  S.timing = { ...S.timing, rows: S.timing.rows.filter((r) => (r.planet || '') !== sfx) };
  S.t = cur(S.values).tmid; buildPanels(); refresh(true);
}

function resetDefaults() {
  pushUndo();
  const p = PRESETS[S.preset], tm = S.values.tmid;
  if (!p || S.planets.length > 1 || S.rv.length || S.sources) { flash('Reset applies to the built-in single-planet systems'); UNDO.pop(); undoButtons(); return; }
  S.values = { ...p.values }; S.star = { ...p.star }; S.ldLaw = p.ldLaw; S.band = p.band; S.ldProfile = null; S.ldMsg = ''; S.starMsg = ''; S.range = 'full';
  if (S.raw) S.values.tmid = nearestEpoch(p.values.tmid, p.values.per, S.data.t); else if (S.data.synthetic) S.values.tmid = S.truth ? S.truth.tmid : tm; else if (S.data.epoch) S.values.tmid = tm;
  ensureEpochParams();
  syncStarLD.key = null; buildPanels(); refresh(); flash('Defaults restored');
}

function estimateLD() {
  pushUndo();
  const r = ldFromStar(S.star.teff, S.star.feh);
  r.coeffs.forEach((c, i) => (S.values['ld' + i] = Number(c.toFixed(5))));
  S.ldProfile = r.prof || null; S.fit = null; S.range = 'full';
  const list = LD_LAWS[S.ldLaw].names.map((n, i) => `${n} = ${r.coeffs[i].toFixed(3)}`).join(', ');
  if (r.source === 'table') S.ldMsg = `Sliders set from <b>${S.table.name}</b> at T eff ${S.star.teff}, log g ${S.star.logg}, [Fe/H] ${S.star.feh}: ${list} (${r.info.method}${r.info.clamped ? ', <span style="color:var(--warn)">outside the table, clamped to its edge</span>' : ''}).`;
  else { const [w0, w1] = bandRange(); S.ldMsg = `Sliders set from the grey-atmosphere estimate for ${S.star.teff} K, ${w0}–${w1} nm: ${list}. The law fits the computed profile (dashed blue) to ${(r.rms * 100).toFixed(1)}% rms. log g and [Fe/H] were not used.`; }
  resetPriors(['ld0', 'ld1', 'ld2', 'ld3']);
  buildPanels(); refresh(); flash('Limb darkening updated');
}

function changeLaw(law) {
  pushUndo();
  const old = S.ldLaw, v = S.values;
  if (old === 'quadratic' && law === 'kipping') [v.ld0, v.ld1] = quadraticToKipping(v.ld0, v.ld1);
  else if (old === 'kipping' && law === 'quadratic') [v.ld0, v.ld1] = kippingToQuadratic(v.ld0, v.ld1);
  else if (law === 'nonlinear') { const a = toClaret(old, LD_LAWS[old].names.map((_, i) => v['ld' + i])); [v.ld0, v.ld1, v.ld2, v.ld3] = a; } // exact re-expression
  else if (S.ldProfile) fitLaw(law, S.ldProfile).coeffs.forEach((c, i) => (v['ld' + i] = Number(c.toFixed(4))));  // refit the same stellar profile
  else LD_LAWS[law].defaults.forEach((d, i) => (v['ld' + i] = d));
  S.ldLaw = law; S.fit = null; S.range = 'full'; syncStarLD.key = null;
  for (let i = 0; i < 4; i++) { S.free['ld' + i] = false; S.priors['ld' + i] = defaultPrior('ld' + i); }
  buildPanels(); refresh();
}

// ---- Data tab -----------------------------------------------------------------

function loadText(text, name, msgEl) {
  try {
    const p = parseLightCurve(text, name, S.parseOpts);
    pushUndo();
    S.raw = { text, name };
    if (p.meta.planet) S.name = p.meta.planet;
    if (p.meta.priors) Object.assign(S.values, p.meta.priors);        // AAVSO reports carry the ephemeris they were reduced with
    if (p.meta.tmid !== undefined) S.values.tmid = p.meta.tmid;
    if (p.meta.priors) p.notes.push('system parameters taken from the file’s #PRIORS line');
    setData(p);
    S.exptimeMin = p.meta.exptimeMin || 0;
    if (p.meta.priors && Object.keys(p.meta.priors).some((k) => k.startsWith('ld'))) S.ldLaw = 'nonlinear';
    resetPriors(activeParams(S.ldLaw, true).map((x) => x.key));
    S.t = S.values.tmid; S.planets = [{ sfx: '', letter: 'b' }]; S.pl = ''; S.use = { ...S.use, lc: true }; S.view = 'lc'; buildPanels(); refresh(true);
  } catch (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--bad)'; } }
}

function buildDataTab() {
  const el = $('#tab-data'); el.innerHTML = '';
  const d = S.data, n = d.t.length;
  const med = (a) => Float64Array.from(a).sort()[a.length >> 1];
  const cad = med(Float64Array.from({ length: n - 1 }, (_, i) => d.t[i + 1] - d.t[i])) * 1440;
  if (S.note) el.append(h('p', { class: 'note callout' }, S.note));
  el.append(h('h3', {}, 'Current light curve'));
  el.append(h('div', { class: 'kv', html: [['Source', d.name], ['Points', n], ['Span', ((d.t[n - 1] - d.t[0]) * 24).toFixed(2) + ' h'], ['Cadence', cad.toFixed(2) + ' min'], ['Median error', (med(d.e) * 1e6).toFixed(0) + ' ppm'], ['Airmass column', d.airmass ? (d.epoch ? `${d.segments.filter((x) => x.airmass).length} of ${d.segments.length} epochs` : 'yes') : 'no']].map(([k, v]) => `<div><span>${k}</span><b style="font-family:inherit;font-size:12px">${v}</b></div>`).join('') }));
  if (d.notes && d.notes.length) el.append(h('p', { class: 'note' }, 'Notes: ' + d.notes.join('; ') + '.'));
  if (d.epoch) {
    // the epochs fitted together: one row each, removable
    const tb = h('tbody');
    d.segments.forEach((sg, k) => tb.append(h('tr', {}, h('td', {}, h('span', { class: 'swatch', style: `background:${GROUP_COLORS.dark[k % GROUP_COLORS.dark.length]}` }), `${k + 1} · ${sg.name}`), h('td', {}, String(sg.n)), h('td', {}, (sg.t0 + (d.tRef || 0)).toFixed(3)), h('td', {}, ((sg.t1 - sg.t0) * 24).toFixed(1)), h('td', {}, sg.airmass ? 'yes' : '—'),
      h('td', {}, h('button', { class: 'chip small', title: 'Take this epoch out of the fit', 'aria-label': `Remove epoch ${k + 1}`, onclick: () => { pushUndo(); const r = removeEpoch(S.data, k); setEpochData(r.epoch ? { ...r, name: `${S.name} · ${r.segments.length} epochs` } : r); } }, '✕')))));
    el.append(h('h3', {}, `Epochs · ${d.segments.length}`), h('div', { class: 'tablewrap' }, h('table', { class: 'res timing' }, h('thead', { html: '<tr><th>Epoch</th><th>Points</th><th>Start</th><th>Hours</th><th>Airmass</th><th></th></tr>' }), tb)));
    el.append(h('p', { class: 'note' }, 'The epochs are fitted together: one planet and orbit, and a separate baseline for each epoch. With more than one transit the period can be fitted (tick P on the Fit tab). The light curve plot is folded on the period; the Fold button above it switches back to time.'));
  } else if (d.t[n - 1] - d.t[0] > 1.05 * cur(S.values).per) {
    el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', title: 'Give each orbit its own epoch, and so its own baseline normalisation, using the System period and T mid', onclick: () => { const sp = splitByOrbit(S.data, cur(S.values).per, cur(S.values).tmid); if (sp === S.data) return flash('Only one orbit has enough points'); pushUndo(); setEpochData({ ...sp, name: `${d.name} · ${sp.segments.length} orbits` }); } }, 'Split into one epoch per orbit')));
    el.append(h('p', { class: 'note' }, `This light curve covers ${((d.t[n - 1] - d.t[0]) / cur(S.values).per).toFixed(1)} orbital periods with a single baseline. Splitting gives each orbit its own normalisation and folds the plot on the period.`));
  }
  if (S.raw) {
    // how the file was read, with the option to overrule the guess
    const sel = (key, opts, cur) => { const s = h('select', { 'aria-label': key }, [['auto', `Auto (${opts[cur].label || opts[cur]})`], ...Object.entries(opts).map(([k, v]) => [k, v.label || v])].map(([k, t]) => h('option', { value: k, selected: S.parseOpts[key] === k }, t))); s.addEventListener('change', () => { S.parseOpts[key] = s.value; loadText(S.raw.text, S.raw.name, $('#datamsg')); }); return s; };
    el.append(h('div', { class: 'field' }, h('span', {}, 'Time system'), sel('time', TIME_SYSTEMS, d.timeSystem)), h('div', { class: 'field' }, h('span', {}, 'Flux units'), sel('flux', FLUX_UNITS, d.fluxUnits)));
  }
  const ex = h('input', { type: 'number', min: 0, step: 0.5, value: Number(S.exptimeMin.toFixed(4)), 'aria-label': 'Exposure time in minutes' });
  ex.addEventListener('change', () => { pushUndo(); S.exptimeMin = Math.max(0, Number(ex.value) || 0); refresh(); });
  el.append(h('div', { class: 'field', title: 'The model is averaged over each exposure when the exposure is long enough to blur ingress' }, h('span', {}, 'Exposure (min)'), ex));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', title: 'Set every error bar to the white-noise level measured from the residuals of the current model', onclick: rescaleErrors }, 'Rescale errors to residual scatter')));
  el.append(h('p', { class: 'note' }, 'The evidence depends on the error bars, so runs are only compared when they used the same data and errors.'));

  el.append(h('h3', {}, 'Use your own data'));
  const msg = h('p', { class: 'note', id: 'datamsg' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.tbl', 'aria-label': 'Light curve file' });
  const fresh = (text, name) => { S.parseOpts = { time: 'auto', flux: 'auto' }; loadText(text, name, msg); };
  file.addEventListener('change', async () => { if (file.files[0]) fresh(await file.files[0].text(), file.files[0].name); });
  const drop = h('div', { class: 'drop' }, 'Drop a light curve file here, or ', file);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); const fl = e.dataTransfer.files[0]; if (fl) fresh(await fl.text(), fl.name); });
  const ta = h('textarea', { placeholder: 'or paste rows: time, flux, error, airmass', 'aria-label': 'Paste light curve' });
  // a further light curve of the same planet, fitted together with what is loaded
  const more = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.tbl', hidden: true, multiple: true, 'aria-label': 'Light curve files to add as epochs' });
  more.addEventListener('change', async () => { for (const fl of more.files) addEpochText(await fl.text(), fl.name, $('#datamsg')); more.value = ''; });
  el.append(drop, ta, h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => fresh(ta.value, 'Pasted light curve') }, 'Load pasted rows'),
    h('button', { class: 'btn', title: 'Keep the current light curve and fit this one together with it, as another epoch of the same planet', onclick: () => more.click() }, 'Add file as another epoch…'), more,
    h('button', { class: 'btn', title: 'Keep the current light curve and add the pasted rows as another epoch', onclick: () => addEpochText(ta.value, 'pasted epoch', msg) }, 'Add pasted as epoch')), msg);
  el.append(h('p', { class: 'note', html: 'Reads comma, tab, semicolon or space separated columns with or without a header; <b>AAVSO exoplanet reports</b> and <b>EXOTIC FinalLightCurve</b> files (their metadata fills in the planet, exposure and ephemeris); times in JD/BJD, MJD, BTJD or BKJD; flux, magnitudes or millimagnitudes. Rows are sorted, duplicates and unreadable rows dropped, and flux normalised. The file never leaves your computer.' }));

  // ---- radial velocities
  el.append(h('h3', {}, 'Radial velocities' + (S.rv.length ? ` · ${S.rv.reduce((a, x) => a + x.t.length, 0)} points` : '')));
  if (S.rv.length) {
    const tb = h('tbody');
    S.rv.forEach((x, k) => tb.append(h('tr', {}, h('td', {}, h('span', { class: 'swatch', style: `background:${GROUP_COLORS.dark[k % GROUP_COLORS.dark.length]}` }), x.name), h('td', {}, String(x.t.length)), h('td', {}, (x.t[x.t.length - 1] - x.t[0]).toFixed(0)), h('td', {}, Float64Array.from(x.e).sort()[x.e.length >> 1].toFixed(1)),
      h('td', {}, h('button', { class: 'chip small', title: 'Remove this velocity set', 'aria-label': `Remove velocities ${x.name}`, onclick: () => removeRV(k) }, '✕')))));
    el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res timing' }, h('thead', { html: '<tr><th>Instrument</th><th>Points</th><th>Span d</th><th>± m/s</th><th></th></tr>' }), tb)));
  }
  const rvMsg = h('p', { class: 'note', id: 'rvmsg' });
  const rvFile = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.vels', hidden: true, multiple: true, 'aria-label': 'Radial velocity files' });
  rvFile.addEventListener('change', async () => { for (const fl of rvFile.files) addRVText(await fl.text(), fl.name, rvMsg); rvFile.value = ''; });
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => rvFile.click() }, 'Add velocities file…'), rvFile,
    h('button', { class: 'btn', title: 'Read the rows in the paste box above as velocities', onclick: () => addRVText(ta.value, 'RV', rvMsg) }, 'Add pasted as velocities')), rvMsg);
  el.append(h('p', { class: 'note', html: 'Columns: time, velocity, uncertainty, and optionally an instrument name (a header such as <b>BJD, Vel(m/s), ErrVel(m/s), Telescope</b> lets them come in any order). Each instrument is its own dataset with its own zero point and jitter. Velocities in m/s; a header saying km/s is converted.' }));

  el.append(h('h3', {}, 'Simulate an observation'));
  const o = S.synth, f = (label, key, attrs, title) => { const i = h('input', { type: 'number', value: o[key] ?? 1, ...attrs }); i.addEventListener('change', () => (o[key] = Number(i.value))); return h('div', { class: 'field', title: title || '' }, h('span', {}, label), i); };
  const am = h('input', { type: 'checkbox', checked: !!o.airmass }); am.addEventListener('change', () => (o.airmass = am.checked));
  el.append(f('Exposure (min)', 'exptimeMin', { min: 0.05, step: 0.5 }), f('Noise (ppm)', 'noisePpm', { min: 1, step: 10 }, 'White noise per exposure'), f('Baseline (h)', 'baselineHr', { min: 0, step: 0.25 }, 'Out-of-transit time observed before and after the transit'), f('Seed', 'seed', { min: 1, step: 1 }),
    f('Transits', 'nEpochs', { min: 1, max: 200, step: 1 }, 'How many transits to observe. More than one makes a multi-epoch dataset: each night has its own baseline, and the period can be fitted'), f('Every n-th orbit', 'epochStep', { min: 1, step: 1 }, 'Orbits between one simulated transit and the next'));
  el.append(h('label', { class: 'tog' }, am, 'Add an airmass trend (ground-based night)'));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: () => { pushUndo(); makeSynthetic(); S.t = cur(S.values).tmid; buildPanels(); refresh(true); } }, 'Generate from current system')));
  el.append(h('p', { class: 'note' }, 'Each transit is covered with the baseline on each side; the number of points per transit is that length divided by the exposure. The current slider values become the hidden truth, marked on the posterior plot after a fit.'));
}

function rescaleErrors() {
  if (!model || !model.valid) return;
  pushUndo();
  const d = S.data, n = d.t.length, ne = nEpochs(), e = new Float64Array(n), sig = [];
  for (let k = 0; k < ne; k++) {   // each epoch has its own noise level
    const r = []; for (let i = 0; i < n; i++) if (!d.epoch || d.epoch[i] === k) r.push(Math.abs(d.f[i] - model.base[i] * model.tr[i]));
    r.sort((a, b) => a - b); sig.push(1.4826 * r[r.length >> 1]);
  }
  for (let i = 0; i < n; i++) e[i] = sig[d.epoch ? d.epoch[i] : 0];
  S.data = { ...d, e, notes: [...(d.notes || []).filter((x) => !x.startsWith('errors rescaled')), `errors rescaled to ${sig.map((v) => (v * 1e6).toFixed(0)).join(', ')} ppm (robust scatter of residuals${ne > 1 ? ', epoch by epoch' : ''})`] };
  S.fit = null; S.dataId++; S.range = 'full'; buildPanels(); refresh();
}

// ---- Fit tab ------------------------------------------------------------------

function buildFitTab() {
  const el = $('#tab-fit'); el.innerHTML = '';
  // how limb darkening enters the fit
  const mode = (val, label) => { const r = h('input', { type: 'radio', name: 'ldmode', value: val, checked: S.ldMode === val }); r.addEventListener('change', () => { pushUndo(); S.ldMode = val; S.fit = null; S.range = 'full'; syncStarLD.key = null; ['ld0', 'ld1', 'ld2', 'ld3'].forEach((k) => (S.free[k] = false)); if (val === 'coeffs') { S.free.teff = false; S.free.feh = false; } buildPanels(); refresh(); }); return h('label', { class: 'tog' }, r, label); };
  // which kinds of data the likelihood uses
  const nrv = S.rv.reduce((a, x) => a + x.t.length, 0), ntim = S.timing.rows.length;
  const inc = (key, label, dis, title) => { const c = h('input', { type: 'checkbox', checked: !!S.use[key] && !dis, disabled: dis }); c.addEventListener('change', () => { pushUndo(); S.use = { ...S.use, [key]: c.checked }; S.fit = null; S.range = 'full'; if (key === 'rv') ensureRVParams(); buildPanels(); refresh(); }); return h('label', { class: 'tog', title }, c, label); };
  if (S.note) el.append(h('p', { class: 'note callout' }, S.note));
  el.append(h('h3', {}, 'Data in the fit'));
  el.append(inc('lc', `Light curve · ${S.data.t.length} points` + (nEpochs() > 1 ? ` in ${nEpochs()} epochs` : ''), false, 'Transit photometry'),
    inc('rv', nrv ? `Radial velocities · ${nrv} points from ${S.rv.length} instrument${S.rv.length > 1 ? 's' : ''}` : 'Radial velocities · none loaded (Data tab)', !nrv, 'The star’s reflex motion: planet masses, eccentricity, periastron'),
    inc('timing', ntim ? `Mid-transit and mid-eclipse times · ${ntim} from the Timing tab` : 'Mid-transit times · none listed (Timing tab)', !ntim, 'Earlier mid-times constrain the period, and an eclipse time the eccentricity'));
  if ((rvOn() || (S.use.timing && ntim)) && S.use.lc && !S.kepler) el.append(h('p', { class: 'note', html: 'Photometry and velocities are being fitted with a free a/R★. Tick <b>a/R★ from Kepler’s law</b> on the System tab to tie the orbit size to the period and the masses, as EXOTIC’s joint fit does.' }));

  el.append(h('h3', {}, 'Limb darkening in the fit'));
  el.append(mode('coeffs', 'Sample the coefficients directly'), mode('star', 'Follow the star: sample T eff' + (gridFor(S.ldLaw) ? ' and [Fe/H]' : '')));
  el.append(h('p', { class: 'note', html: S.ldMode === 'star'
    ? `Each sample of T eff${gridFor(S.ldLaw) ? ' and [Fe/H]' : ''} is turned into ${LD_LAWS[S.ldLaw].label} coefficients through ${gridFor(S.ldLaw) ? `<b>${S.table.name}</b>` : 'the grey-atmosphere estimate'}, so the coefficients stay correlated the way a real star’s are. Give T eff a Normal prior at its measured uncertainty.` + (gridFor(S.ldLaw) ? '' : ' Without a model-atmosphere table [Fe/H] has no effect, so it is not offered; the spread this produces reflects the T eff uncertainty only, not the uncertainty of the atmosphere model.')
    : 'Free coefficients explore every combination the prior allows, whether or not a star could produce it. “Follow the star” samples the stellar parameters instead.' }));

  el.append(h('h3', {}, 'Parameters & priors'));
  const tb = h('tbody');
  for (const prm of fitParams()) {
    const key = prm.key; if (!S.priors[key] || !PRIOR_TYPES[S.priors[key].type]) S.priors[key] = defaultPrior(key);
    const tr = h('tr', { class: S.free[key] ? '' : 'off' });
    const cb = h('input', { type: 'checkbox', checked: !!S.free[key], 'aria-label': 'Fit ' + prm.label });
    const sel = h('select', { 'aria-label': 'Prior for ' + prm.label }, Object.entries(PRIOR_TYPES).map(([k, v]) => h('option', { value: k, selected: S.priors[key].type === k }, v.label)));
    const args = h('div', { class: 'args' }), err = h('div', { class: 'err' });
    const renderArgs = () => {
      args.innerHTML = '';
      const pr = S.priors[key];
      for (const [f, name] of PRIOR_TYPES[pr.type].args) {
        const i = h('input', { type: 'number', step: 'any', value: pr[f] ?? '', disabled: !S.free[key], 'aria-label': `${prm.label} prior ${name}` });
        i.addEventListener('change', () => { pushUndo(); pr[f] = Number(i.value); err.textContent = S.free[key] ? validatePrior(pr) || '' : ''; if (S.range === 'prior') { buildSystemTab(); refresh(); } });
        args.append(h('label', { class: 'arg' }, h('span', {}, name), i));   // says whether the box is a min/max or a mean/std
      }
      err.textContent = S.free[key] ? validatePrior(pr) || '' : '';
    };
    cb.addEventListener('change', () => { pushUndo(); S.free[key] = cb.checked; tr.className = cb.checked ? '' : 'off'; renderArgs(); countFree(); });
    sel.addEventListener('change', () => {
      pushUndo();
      const v = paramValue(key), old = S.priors[key];
      if (sel.value === 'normal') S.priors[key] = { type: 'normal', a: Number(((old.a + old.b) / 2).toPrecision(7)), b: Number(((old.b - old.a) / 4).toPrecision(3)) };
      else if (old.type === 'normal') S.priors[key] = { type: 'uniform', a: Number((old.a - 3 * old.b).toPrecision(7)), b: Number((old.a + 3 * old.b).toPrecision(7)) };
      else S.priors[key] = defaultPrior(key).type === 'uniform' ? defaultPrior(key) : { type: 'uniform', a: Number((v * 0.99).toPrecision(7)), b: Number((v * 1.01).toPrecision(7)) };
      renderArgs();
    });
    renderArgs();
    tr.append(h('td', {}, cb), h('td', { class: 'nm', title: prm.help || '' }, prm.label + (prm.unit ? ' (' + prm.unit + ')' : '')), h('td', {}, sel), h('td', {}, args, err));
    tb.append(tr);
  }
  el.append(h('table', { class: 'pri' }, h('thead', {}, h('tr', {}, h('th', {}, 'Fit'), h('th', {}, 'Param'), h('th', {}, 'Prior'), h('th', {}, 'Arguments'))), tb));
  el.append(h('p', { class: 'note', id: 'freecount' }));
  if (nEpochs() > 1) el.append(h('p', { class: 'note' }, `${nEpochs()} epochs are fitted together, each with its own baseline. T mid is the transit nearest its current value; with P ticked the other epochs measure the period. Its default prior lets the last transit shift by a quarter of its duration relative to the first.`));
  // save / load the set-up
  const cfgMsg = h('span', { class: 'toast' }), imp = h('input', { type: 'file', accept: '.json,.yaml,.yml,.txt', hidden: true, 'aria-label': 'Import priors file' });
  const cfg = () => configToObject(S, [...actParams(), ...STAR_PARAMS]);
  const sv = async (name, text) => { try { const r = await saveFile(name, text); cfgMsg.textContent = r === 'saved' ? 'Saved ' + name : 'Save cancelled.'; } catch (e) { cfgMsg.textContent = 'Could not save: ' + e.message; } };
  imp.addEventListener('change', async () => { if (!imp.files[0]) return; try { applyConfig(parseConfig(await imp.files[0].text())); flash('Priors imported'); } catch (e) { cfgMsg.textContent = e.message; cfgMsg.style.color = 'var(--bad)'; } imp.value = ''; });
  el.append(h('div', { class: 'btnrow' }, h('span', { class: 'note' }, 'Priors file:'),
    h('button', { class: 'btn', onclick: () => sv(slug(S.name) + '_priors.json', JSON.stringify(cfg(), null, 2)) }, 'Export JSON'),
    h('button', { class: 'btn', onclick: () => sv(slug(S.name) + '_priors.yaml', toYAML(cfg())) }, 'Export YAML'),
    h('button', { class: 'btn', onclick: () => imp.click() }, 'Import…'), imp, cfgMsg));

  el.append(h('h3', {}, 'Sampler'));
  const fld = (label, key, attrs) => { const i = h('input', { type: 'number', value: S.sampler[key], ...attrs }); i.addEventListener('change', () => { pushUndo(); S.sampler[key] = Number(i.value); evNote(); }); return h('div', { class: 'field' }, h('span', {}, label), i); };
  el.append(fld('Live points', 'nlive', { min: 50, max: 4000, step: 50 }), fld('Stop at remainder', 'fracRemain', { min: 0.0001, max: 0.5, step: 0.005 }), fld('Seed', 'seed', { min: 1, step: 1 }));
  el.append(h('p', { class: 'note', id: 'evnote' }));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', id: 'runbtn', onclick: startFit }, 'Run nested sampling'), h('button', { class: 'btn danger', id: 'stopbtn', onclick: stopFit, disabled: true }, 'Stop'), h('span', { class: 'note', id: 'runmode' })));
  el.append(h('div', { class: 'progress' }, h('i', { id: 'pbar' })), h('p', { class: 'note mono', id: 'pstat' }, 'Idle.'));
  el.append(h('p', { class: 'note' }, 'MLFriends region sampling with bootstrapped radii, as in UltraNest. Sampling runs in a Web Worker on your machine; stopping early still returns a usable posterior, but not a converged evidence.'));
  countFree(); evNote();
}
function applyConfig(c) {
  pushUndo();
  if (c.ldLaw && LD_LAWS[c.ldLaw]) S.ldLaw = c.ldLaw;
  if (c.ldMode === 'star' || c.ldMode === 'coeffs') S.ldMode = c.ldMode;
  const known = new Set([...activeParams(S.ldLaw, true).map((p) => p.key), ...actParams().map((p) => p.key), 'teff', 'feh']);
  for (const [k, e] of Object.entries(c.params)) {
    if (!known.has(k)) continue;
    if (Number.isFinite(e.value)) { if (k === 'teff' || k === 'feh') S.star[k] = e.value; else S.values[k] = e.value; }
    S.free[k] = e.fit && (k !== 'a2' || (!!S.data.airmass && !S.data.epoch));
    if (e.prior) S.priors[k] = e.prior;
  }
  if (c.sampler.live_points > 0) S.sampler.nlive = c.sampler.live_points;
  if (c.sampler.stop_at_remainder > 0) S.sampler.fracRemain = c.sampler.stop_at_remainder;
  if (c.sampler.seed > 0) S.sampler.seed = c.sampler.seed;
  S.fit = null; S.range = 'full'; syncStarLD.key = null; buildPanels(); refresh();
}
function evNote() {
  const e = $('#evnote'); if (!e) return;
  const last = S.runs[S.runs.length - 1], H = last ? last.H : 12;
  e.innerHTML = `Evidence precision: σ(ln Z) ≈ √(H / live points), where H is the information gained from the data${last ? ` (${H.toFixed(1)} nats in your last run)` : ' (typically 8–20 nats for a transit fit)'}. With ${S.sampler.nlive} live points expect about <b>±${Math.sqrt(H / S.sampler.nlive).toFixed(2)}</b>. Quadruple the live points to halve it.`;
}
function freeList() { return fitParams().filter((p) => S.free[p.key]); }
function countFree() { const n = freeList().length, e = $('#freecount'); if (e) e.textContent = n ? `${n} free parameter${n > 1 ? 's' : ''}. Everything else is held at its System value.` : 'Tick at least one parameter to fit.'; }

// ---- Timing tab (src/ui/timingTab.js) -------------------------------------------
let timingRedraw = null;
function buildTiming() { timingRedraw = buildTimingTab($('#tab-timing'), { S, h, pushUndo, flash, slug, rebuild: buildTiming, applyEphemeris, per: () => cur(S.values).per, tmidKey: () => PK('tmid'), label: planetLabel }); undoButtons(); }
/** Take the period from a fitted ephemeris, and put T mid on its predicted transit nearest the loaded light curve. */
function applyEphemeris(f) {
  pushUndo();
  const tRef = S.data.tRef || 0, n = S.data.t.length, mid = 0.5 * (S.data.t[0] + S.data.t[n - 1]) + tRef;
  S.values[PK('per')] = Number(f.per.toPrecision(12));
  S.values[PK('tmid')] = f.predict(Math.round((mid - f.t0) / f.per)).t - tRef;
  resetPriors([PK('per'), PK('tmid')]); S.t = S.values[PK('tmid')];
  buildPanels(); refresh(true); flash('Ephemeris applied');
}

function buildPanels() { buildSystemTab(); buildDataTab(); buildFitTab(); buildResultsTab(); buildTiming(); undoButtons(); }

// ---- fitting ------------------------------------------------------------------

function startFit() {
  if (S.running) return;
  const free = freeList().map((p) => ({ key: p.key, label: p.label, unit: p.unit, prior: { ...S.priors[p.key] } }));
  const stat = $('#pstat');
  if (!free.length) { stat.textContent = 'Tick at least one parameter to fit.'; return; }
  const bad = free.find((f) => validatePrior(f.prior));
  if (bad) { stat.textContent = `Prior for ${bad.label}: ${validatePrior(bad.prior)}.`; return; }
  const use = { lc: S.use.lc, rv: rvOn(), timing: S.use.timing && S.timing.rows.length > 0 };
  if (!use.lc && !use.rv && !use.timing) { stat.textContent = 'Nothing to fit: include the light curve, the radial velocities or the timing list above.'; return; }
  if (use.rv && !S.kepler && S.planets.some((p) => !(planetValues(S.values, p.sfx).mplanet >= 0))) { stat.textContent = 'Give every planet a mass (System tab) before fitting velocities.'; return; }
  pushUndo();
  const tie = use.lc ? tieSpec(free) : null;
  const spec = { ...fitSpec(S.values, free, use), ldTie: tie, sampler: { ...S.sampler } };
  S.running = true; S.fit = null; $('#runbtn').disabled = true; $('#stopbtn').disabled = false; stat.textContent = 'Drawing live points…';
  const tieFn = tie ? makeLDTie(tie) : null;
  const withLD = (v) => { if (tieFn) { const o = [0, 0, 0, 0]; tieFn(v.teff ?? S.star.teff, v.feh ?? S.star.feh, o); for (let i = 0; i < 4; i++) v['ld' + i] = o[i] || 0; } return v; };
  const onProgress = (p) => {
    const fr = S.sampler.fracRemain, prem = Math.min(1, Math.max(0, 1 - Math.log(p.remFrac / fr) / Math.log(1 / fr)));
    $('#pbar').style.width = (100 * (0.55 * (1 - Math.exp(-p.it / (6 * S.sampler.nlive))) + 0.45 * prem)).toFixed(1) + '%';
    stat.textContent = `iter ${p.it}  ·  calls ${p.ncalls}  ·  eff ${(p.eff * 100).toFixed(1)}%  ·  lnZ ${p.logZ.toFixed(2)}  ·  remainder ${(p.remFrac * 100).toFixed(p.remFrac < 0.1 ? 2 : 0)}%  ·  ${p.elapsed.toFixed(1)} s` + (p.mode === 'slice' ? '  ·  slice sampling' : '');
    S.live = { ...S.values }; p.keys.forEach((k, i) => (S.live[k] = p.best[i])); withLD(S.live);
    refresh();
  };
  const onDone = (res) => { finishFit(res, free, withLD, tie); };
  const onError = (m) => { S.running = false; S.live = null; $('#runbtn').disabled = false; $('#stopbtn').disabled = true; stat.textContent = 'Fit failed: ' + m; refresh(); };

  let worker = null, gotMessage = false, stopFlag = false;
  const runOnMain = () => { $('#runmode').textContent = 'running on the main thread'; runner = { stop: () => (stopFlag = true) }; runFit(spec, onProgress, () => stopFlag).then(onDone, (e) => onError(e.message)); };
  try { worker = new Worker(new URL('./worker/fit.worker.js', import.meta.url), { type: 'module' }); } catch { worker = null; }
  if (!worker) return runOnMain();
  $('#runmode').textContent = 'running in a Web Worker';
  runner = { stop: () => worker.postMessage({ type: 'stop' }) };
  worker.onmessage = (ev) => {
    gotMessage = true;
    if (ev.data.type === 'progress') onProgress(ev.data.p);
    else if (ev.data.type === 'done') { worker.terminate(); onDone(ev.data.res); }
    else if (ev.data.type === 'error') { worker.terminate(); onError(ev.data.message); }
  };
  worker.onerror = (e) => { e.preventDefault && e.preventDefault(); worker.terminate(); if (!gotMessage) runOnMain(); else onError(e.message || 'worker error'); };
  worker.postMessage({ type: 'run', spec });
}
function stopFit() { if (runner) runner.stop(); $('#pstat').textContent += '  ·  stopping…'; }

const quant = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s[s.length >> 1]; return { med: m, plus: s[Math.floor(0.8413 * (s.length - 1))] - m, minus: m - s[Math.floor(0.1587 * (s.length - 1))] }; };

function finishFit(res, free, withLD, tie) {
  S.running = false; S.live = null;
  $('#runbtn').disabled = false; $('#stopbtn').disabled = true; $('#pbar').style.width = '100%';
  const d = res.ndim, n = res.n, rng = makeRng(7);
  const cols = free.map((_, k) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = res.samples[i * d + k]; return a; });
  const summary = free.map((f, k) => { const [lo, med, hi] = weightedQuantiles(cols[k], res.weights, [0.1587, 0.5, 0.8413]); return { key: f.key, label: f.label, unit: f.unit, med, plus: hi - med, minus: med - lo, best: res.maxPoint[k] }; });
  // equal-weight draws: derived quantities (with the stellar uncertainties folded in) and the model band
  const idx = resampleIndices(res.weights, 600, rng), st = starNow(), draws = {}, curves = [];
  // grid for the model band: the observed span, or the folded window around the best-fit transit
  const bestAll = { ...S.values }; free.forEach((f, k) => (bestAll[f.key] = res.maxPoint[k]));
  const bestV = planetValues(bestAll), many = S.planets.length > 1;
  let g0 = S.data.t[0], g1 = S.data.t[S.data.t.length - 1];
  if (S.fold) { g0 = Infinity; g1 = -Infinity; for (const x of foldTimes(S.data.t, bestV.per, bestV.tmid)) { g0 = Math.min(g0, x); g1 = Math.max(g1, x); } }
  const span = g1 - g0, NG = 500, G = Float64Array.from({ length: NG }, (_, i) => g0 - 0.05 * span + (1.1 * span * i) / (NG - 1));
  const gauss = (m, s) => (s > 0 ? Math.max(1e-6, m + s * rng.normal()) : m);
  const fitsTeff = free.some((f) => f.key === 'teff'), fitsFeh = free.some((f) => f.key === 'feh'), fitsM = free.some((f) => f.key === 'mstar'), fitsR = free.some((f) => f.key === 'rstar');
  for (const i of idx) {
    const v = { ...S.values }; free.forEach((f, k) => (v[f.key] = res.samples[i * d + k])); withLD(v);
    const tied = S.kepler || rvOn();   // M★ and R★ enter the likelihood: keep the values the fit used
    const star = { ...st, rstar: fitsR ? v.rstar : tied ? st.rstar : gauss(st.rstar, st.rstarErr), mstar: fitsM ? v.mstar : tied ? st.mstar : gauss(st.mstar, st.mstarErr), teff: fitsTeff ? v.teff : gauss(st.teff, st.teffErr), feh: fitsFeh ? v.feh : st.feh };
    const q = { mstar: star.mstar, rstar: star.rstar, teff: star.teff, feh: star.feh };
    // every planet's derived quantities, keyed like its parameters ("per" for the first planet, "per@c" for planet c)
    for (const pl of S.planets) {
      const pvv = planetValues(v, pl.sfx, star), dq = deriveSystem(pvv, { ...star, mplanet: pvv.mplanet > 0 ? pvv.mplanet : null });
      for (const k in dq) q[planetKey(k, pl.sfx)] = dq[k];
      if (pvv.mplanet >= 0) q[planetKey('mplanet', pl.sfx)] = pvv.mplanet;
    }
    for (const prm of actParams()) if (prm.group === 'rv' || prm.group === 'baseline') q[prm.key] = v[prm.key] || 0;
    for (let j = 0; j < LD_LAWS[S.ldLaw].names.length; j++) q['ld' + j] = v['ld' + j];
    for (const k in q) (draws[k] = draws[k] || []).push(q[k]);
    if (curves.length < 200) { const f = fluxFunction(v, S.fold && many ? S.pl : undefined), c = new Float64Array(NG); for (let j = 0; j < NG; j++) c[j] = f(G[j]); curves.push(c); }
  }
  const lo = new Float64Array(NG), hi = new Float64Array(NG), tmp = new Float64Array(curves.length);
  for (let j = 0; j < NG; j++) { for (let c = 0; c < curves.length; c++) tmp[c] = curves[c][j]; const s = Float64Array.from(tmp).sort(); lo[j] = s[Math.floor(0.16 * (s.length - 1))]; hi[j] = s[Math.ceil(0.84 * (s.length - 1))]; }
  const derived = {}; for (const k in draws) derived[k] = quant(draws[k]);
  const best = { ...S.values }; free.forEach((f, k) => (best[f.key] = res.maxPoint[k])); withLD(best);
  const starBest = { ...S.star }; if (fitsTeff) starBest.teff = Number(best.teff.toFixed(1)); if (fitsFeh) starBest.feh = Number(best.feh.toFixed(3));
  if (fitsM) starBest.mstar = Number(best.mstar.toFixed(4)); if (fitsR) starBest.rstar = Number(best.rstar.toFixed(4));
  delete best.teff; delete best.feh; delete best.mstar; delete best.rstar;
  S.values = best; S.star = starBest; syncStarLD.key = null;
  const use = { lc: S.use.lc, rv: rvOn(), timing: S.use.timing && S.timing.rows.length > 0 };
  const prob = buildProblem(fitSpec(best, [], use)), det = prob.detail([]);
  const N = prob.ntotal, ic = infoCriteria(det ? det.chi2 : NaN, free.length + prob.nlinear, N);   // one normalisation per epoch, one zero point per RV set
  S.fit = { id: S.runs.length + 1, res, free, summary, band: use.lc ? { t: G, lo, hi, folded: S.fold, pl: S.pl } : null, derived, starTied: (S.kepler || rvOn()) && !(fitsM && fitsR), nepochs: nEpochs(), use, planets: clone(S.planets), kepler: S.kepler, parts: det ? { lc: det.chi2lc, rv: det.chi2rv, timing: det.chi2tim, nlc: use.lc ? S.data.t.length : 0, nrv: use.rv ? S.rv.reduce((a, x) => a + x.t.length, 0) : 0, ntim: use.timing ? S.timing.rows.length : 0 } : null, rvFit: det && det.rv ? det.rv.map((x, k) => ({ name: S.rv[k].name, gamma: x.gamma, jitter: x.jitter, chi2: x.chi2, n: S.rv[k].t.length })) : null, chi2: det ? det.chi2 : NaN, a1: det ? det.a1 : NaN, ic, N, truth: S.truth, star: { ...st, teff: starBest.teff, feh: starBest.feh, mstar: fitsM ? starBest.mstar : st.mstar, rstar: fitsR ? starBest.rstar : st.rstar }, starEstimated: !!st.estimated, values: { ...best }, ldLaw: S.ldLaw, ldMode: S.ldMode, ldSource: tie ? (tie.source === 'grid' ? S.table.name : 'grey atmosphere') : null };
  S.runs.push({ id: S.fit.id, dataId: S.dataId, name: free.map((f) => f.label).join(', '), law: LD_LAWS[S.ldLaw].label + (S.ldMode === 'star' ? ' · follows star' : ''), k: free.length, logZ: res.logZ, err: res.logZerr, H: res.H, chi2: S.fit.chi2, bic: ic.bic, converged: res.stopReason === 'converged', fit: S.fit, state: { free: clone(S.free), priors: clone(S.priors), starInput: clone(S.star), planets: clone(S.planets), kepler: S.kepler, use: clone(S.use) } });
  S.range = 'fit';
  $('#pstat').textContent = `Finished: ${res.stopReason}. ${res.ncalls} likelihood calls in ${res.elapsed.toFixed(1)} s.`;
  buildSystemTab(); buildResultsTab(); buildTiming(); evNote(); showTab('results'); refresh();
}

/** Bring back an earlier run from the comparison table: its posterior, tables and best-fit model. */
function restoreRun(run) {
  if (S.running || S.fit === run.fit) return;
  pushUndo();
  const F = run.fit;
  S.fit = F; S.values = { ...F.values }; S.ldLaw = F.ldLaw; S.ldMode = F.ldMode; S.free = clone(run.state.free); S.priors = clone(run.state.priors); S.star = clone(run.state.starInput); S.planets = clone(run.state.planets); S.kepler = run.state.kepler; S.use = clone(run.state.use); if (!S.planets.some((p) => p.sfx === S.pl)) S.pl = ''; S.range = 'fit'; syncStarLD.key = null;
  buildPanels(); showTab('results'); refresh(); flash(`Showing run #${run.id}`);
}

// ---- Results tab --------------------------------------------------------------

const digitsFor = (s) => Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(Math.max(1e-12, Math.min(s.plus || 1, s.minus || 1))))));
const pmHTML = (s, dg) => (s.plus === undefined ? s.med.toFixed(dg) : `${s.med.toFixed(dg)}<sup>+${s.plus.toFixed(dg)}</sup><sub>−${s.minus.toFixed(dg)}</sub>`);
const TEX = { mplanet: '$M_p$', rvlin: 'RV linear trend', rvquad: 'RV quadratic trend', mstar: '$M_\\star$', rstar: '$R_\\star$', rprs: '$R_p/R_\\star$', ars: '$a/R_\\star$', inc: '$i$', per: '$P$', tmid: '$T_{\\rm mid}$', ecc: '$e$', omega: '$\\omega$', a2: 'Airmass coefficient, $k$', teff: '$T_{\\rm eff}$', feh: '[Fe/H]' };
const TEXUNIT = { mplanet: '$M_{\\rm Jup}$', rvlin: 'm\\,s$^{-1}$\\,d$^{-1}$', jit: 'm\\,s$^{-1}$', mstar: '$M_\\odot$', rstar: '$R_\\odot$', inc: 'deg', per: 'days', tmid: 'days', omega: 'deg', teff: 'K', feh: 'dex' };

/** Rows of the system table, in the order of Table 7 of Pearson et al. (2022), then a few extras. */
function systemRows() {
  const F = S.fit, D = F.derived, st = F.star, tRef = S.data.tRef || 0, fitted = new Set(F.free.map((f) => f.key));
  const fixed = (v, dg) => ({ s: { med: v }, dg, kind: 'fixed' });
  const given = (v, e, dg) => (e > 0 ? { s: { med: v, plus: e, minus: e }, dg, kind: F.starEstimated ? 'estimated' : 'input' } : fixed(v, dg));
  // a quantity that moves with the posterior gets its spread; one that does not is reported as held fixed
  const post = (k, dgFixed, off = 0) => { const q = D[k]; if (!q) return null; const varies = q.plus + q.minus > 1e-12 * Math.max(1, Math.abs(q.med)); const s = varies ? { med: q.med + off, plus: q.plus, minus: q.minus } : { med: q.med + off }; return { s, dg: varies ? digitsFor(q) : dgFixed, kind: varies ? (fitted.has(k) ? 'fit' : 'derived') : 'fixed' }; };
  const ldNames = LD_LAWS[F.ldLaw].names, planets = F.planets || [{ sfx: '', letter: 'b' }], many = planets.length > 1, lc = !F.use || F.use.lc;
  const starRow = (k, e, dg) => (fitted.has(k) ? post(k, dg) : given(st[k], e, dg));
  const rows = [
    { section: 'Star' },
    { label: 'Stellar mass M★', tex: 'Stellar mass, $M_\\star$', unit: 'M☉', texUnit: '$M_\\odot$', ...starRow('mstar', st.mstarErr, 3) },
    { label: 'Stellar radius R★', tex: 'Stellar radius, $R_\\star$', unit: 'R☉', texUnit: '$R_\\odot$', ...starRow('rstar', st.rstarErr, 3) },
    { label: 'Stellar temperature T★', tex: 'Stellar temperature, $T_\\star$', unit: 'K', texUnit: 'K', ...(fitted.has('teff') ? post('teff', 0) : { ...given(st.teff, st.teffErr, 0), kind: st.teffErr > 0 ? 'input' : 'fixed' }) },
    { label: 'Metallicity [Fe/H]', tex: 'Stellar metallicity, [Fe/H]', unit: 'dex', texUnit: 'dex', ...(fitted.has('feh') ? post('feh', 2) : { ...given(st.feh, st.fehErr, 2), kind: st.fehErr > 0 ? 'input' : 'fixed' }) },
  ];
  // one block per planet, in the order of Table 7
  for (const pl of planets) {
    const P = (k, dg, off) => post(planetKey(k, pl.sfx), dg, off), tag = many ? ' ' + pl.letter : '', sub = many ? `_{${pl.letter}}` : '', cs = many ? ',' + pl.letter : '';
    rows.push(
      { section: 'Planet' + tag },
      lc ? { label: 'Radius ratio Rp/R★', tex: `Radius ratio, $(R_p/R_\\star)${sub}$`, ...P('rprs', 4) } : null,
      lc ? { label: 'Transit depth (Rp/R★)²', tex: `Transit depth, $(R_p/R_\\star)^2${sub}$`, ...P('depth', 5) } : null,
      lc ? { label: 'Planet radius Rp', tex: `Planet radius, $R_{p${cs}}$`, unit: 'R Jup', texUnit: '$R_{\\rm Jup}$', ...P('rpJup', 3) } : null,
      { label: 'Planet mass Mp', tex: `Planet mass, $M_{p${cs}}$`, unit: 'M Jup', texUnit: '$M_{\\rm Jup}$', ...P('mplanet', 4) },
      { label: 'RV semi-amplitude K', tex: `RV semi-amplitude, $K${sub}$`, unit: 'm/s', texUnit: 'm\\,s$^{-1}$', ...P('K', 2) },
      { section: 'Orbit' + tag },
      { label: 'Orbital period P', tex: `Orbital period, $P${sub}$`, unit: 'd', texUnit: 'days', ...P('per', 6) },
      { label: 'Eclipse midpoint E mid', tex: `Eclipse midpoint, $E_{\\rm mid${cs}}$`, unit: tRef ? 'BJD' : 'd', texUnit: tRef ? 'BJD' : 'days', ...P('emid', 4, tRef) },
      lc ? { label: 'Eclipse duration E₁₄', tex: `Eclipse duration, $E_{14${cs}}$`, unit: 'd', texUnit: 'days', ...P('e14', 4) } : null,
      { label: 'Epoch of periastron T peri', tex: `Epoch of periastron, $T_{\\rm peri${cs}}$`, unit: tRef ? 'BJD' : 'd', texUnit: tRef ? 'BJD' : 'days', ...P('tperi', 4, tRef) },
      { label: 'Transit midpoint T mid', tex: `Transit midpoint, $T_{\\rm mid${cs}}$`, unit: tRef ? 'BJD' : 'd', texUnit: tRef ? 'BJD' : 'days', ...P('tmid', 5, tRef) },
      lc ? { label: 'Transit duration T₁₄', tex: `Transit duration, $T_{14${cs}}$`, unit: 'd', texUnit: 'days', ...P('t14', 4) } : null,
      { label: 'Inclination i', tex: `Inclination, $i${sub}$`, unit: '°', texUnit: 'deg', ...P('inc', 3) },
      { label: 'Scaled semi-major axis a/R★', tex: `Scaled semi-major axis, $(a/R_\\star)${sub}$`, ...P('ars', 3) },
      { label: 'Semi-major axis a', tex: `Semi-major axis, $a${sub}$`, unit: 'au', texUnit: 'au', ...P('aAU', 4) },
      { label: 'Eccentricity e', tex: `Eccentricity, $e${sub}$`, ...P('ecc', 5) },
      { label: 'Argument of periastron ω', tex: `Argument of periastron, $\\omega${sub}$`, unit: '°', texUnit: 'deg', ...P('omega', 3) },
      { label: 'Impact parameter b', tex: `Impact parameter, $b${sub}$`, ...P('b', 3) },
      { label: 'Equilibrium temp. T eq', tex: `Equilibrium temperature, $T_{\\rm eq${cs}}$`, unit: 'K', texUnit: 'K', ...P('teq', 0) },
      { label: 'Insolation S', tex: `Insolation, $S${sub}$`, unit: 'S⊕', texUnit: '$S_\\oplus$', ...P('insol', 1) },
      lc ? { label: 'Planet density ρp', tex: `Planet density, $\\rho_{p${cs}}$`, unit: 'g/cm³', texUnit: 'g\\,cm$^{-3}$', ...P('rhoPlanet', 3) } : null,
      lc && !F.kepler ? { label: 'Stellar density ρ★ (from a/R★)', tex: `Stellar density from $a/R_\\star$, $\\rho_{\\star${cs}}$`, unit: 'g/cm³', texUnit: 'g\\,cm$^{-3}$', ...P('rhoStar', 3) } : null,
      !F.kepler ? { label: 'a from Kepler’s law', tex: `Semi-major axis from $M_\\star$ and $P$, $a_{\\rm K${cs}}$`, unit: 'au', texUnit: 'au', ...P('aKeplerAU', 4) } : null,
    );
  }
  if (lc) rows.push({ section: `Limb darkening · ${LD_LAWS[F.ldLaw].label}${F.ldSource ? ' · from ' + F.ldSource : ''}` },
    ...ldNames.map((nm, i) => ({ label: `Coefficient ${nm}`, tex: `Limb darkening, $${nm.replace(/(\d)/, '_$1')}$`, ...post('ld' + i, 4) })));
  if (F.rvFit) {
    rows.push({ section: 'Radial velocity' },
      { label: 'Linear trend', tex: 'RV linear trend', unit: 'm/s/d', texUnit: 'm\\,s$^{-1}$\\,d$^{-1}$', ...post('rvlin', 5) },
      D.rvquad && (D.rvquad.med !== 0 || fitted.has('rvquad')) ? { label: 'Quadratic trend', tex: 'RV quadratic trend', unit: 'm/s/d²', texUnit: 'm\\,s$^{-1}$\\,d$^{-2}$', ...post('rvquad', 7) } : null);
    F.rvFit.forEach((x, k) => rows.push(
      { label: `Zero point · ${x.name}`, tex: `Zero point, ${x.name.replace(/_/g, '\\_')}`, unit: 'm/s', texUnit: 'm\\,s$^{-1}$', s: { med: x.gamma }, dg: 2, kind: 'derived' },
      { label: `Jitter · ${x.name}`, tex: `Jitter, ${x.name.replace(/_/g, '\\_')}`, unit: 'm/s', texUnit: 'm\\,s$^{-1}$', ...post(jitterKey(k), 2) }));
  }
  return rows.filter((r) => r && (r.section || r.s));
}

// ---- table exports (each table on its own, and everything together) -----------
function fittedJSON() { const F = S.fit; return Object.fromEntries(F.summary.map((s) => [s.key, { median: s.med, plus: s.plus, minus: s.minus, best: s.best, unit: s.unit || '', prior: F.free.find((f) => f.key === s.key).prior }])); }
function systemJSON() { return systemRows().filter((x) => !x.section).map((x) => ({ parameter: x.label, unit: x.unit || '', value: x.s.med, plus: x.s.plus ?? null, minus: x.s.minus ?? null, kind: x.kind })); }
function fittedLatex() {
  const F = S.fit, r = F.res, tRef = S.data.tRef || 0;
  const texOf = (x) => { const [b, sc] = x.key.split('@'); if (b === 'a2' && sc) return `Airmass coefficient, $k_{${sc}}$`; if (b === 'jit') return `Jitter, ${(x.label.split(' · ')[1] || '').replace(/_/g, '\\_')}`; const t = TEX[b]; return t ? (sc ? `${t} (${sc})` : t) : x.label; };
  const rows = F.summary.map((s) => ({ tex: texOf(s), unit: baseKey(s.key) === 'tmid' && tRef ? 'BJD' : TEXUNIT[baseKey(s.key)] || '', s: { med: s.med + (baseKey(s.key) === 'tmid' ? tRef : 0), plus: s.plus, minus: s.minus }, dg: digitsFor(s) }));
  return latexTable(rows, `Fitted parameters for ${S.name}.`, `Posterior medians with 68\\% credible intervals from nested sampling (${r.nlive} live points); $\\ln Z = ${r.logZ.toFixed(2)} \\pm ${r.logZerr.toFixed(2)}$.`);
}
function systemLatex() {
  const F = S.fit, r = F.res, rows = systemRows().map((x) => (x.section ? { section: x.section.replace(/·/g, '--') } : { tex: x.tex, unit: x.texUnit || '', s: x.s, dg: x.dg }));
  return latexTable(rows, `System parameters for ${S.name}.`, `Nested sampling with ${r.nlive} live points: $\\ln Z = ${r.logZ.toFixed(2)} \\pm ${r.logZerr.toFixed(2)}$, $\\chi^2 = ${F.chi2.toFixed(1)}$ for ${F.N} points. Values without uncertainties were held fixed.` + (F.starEstimated ? ' Stellar mass and radius estimated from $T_{\\rm eff}$, $\\log g$ and [Fe/H] (Torres et al. 2010).' : ''));
}
function allJSON() {
  const F = S.fit, r = F.res;
  return JSON.stringify({
    system: S.name, data: S.data.name, timeReference: S.data.tRef || 0, ldLaw: F.ldLaw, ldMode: F.ldMode,
    evidence: { lnZ: r.logZ, lnZerr: r.logZerr, information: r.H, ess: r.ess, ncalls: r.ncalls, nlive: r.nlive, stop: r.stopReason, insertionOrderP: r.insertionP, baselinePrior: `a1 ~ U(0, ${A1_PRIOR_WIDTH}), marginalised` + (F.nepochs > 1 ? `, one per epoch (${F.nepochs})` : '') },
    fit: { chi2: F.chi2, npoints: F.N, bic: F.ic.bic, a1: F.a1 }, fitted: fittedJSON(), table: systemJSON(), star: F.star, fixed: F.values,
  }, null, 2);
}

function buildResultsTab() {
  const el = $('#tab-results'); el.innerHTML = '';
  const tabBtn = $('.tabs [data-tab=results]'); tabBtn.innerHTML = 'Results' + (S.fit ? '<span class="dot"></span>' : '');
  if (!S.fit) { el.append(h('div', { class: 'empty' }, 'No posterior yet. Choose free parameters and priors on the Fit tab, then run the sampler.')); if (S.runs.length) comparisonTable(el); return; }
  const F = S.fit, r = F.res, toast = h('span', { class: 'toast' }), clipOut = h('textarea', { readonly: true, hidden: true, 'aria-label': 'Copied text' });
  const say = (t) => { toast.textContent = t; setTimeout(() => { if (toast.textContent === t) toast.textContent = ''; }, 5000); };
  const save = async (name, make) => { try { say('Preparing…'); const st = await saveFile(name, await make()); say(st === 'saved' ? 'Saved ' + name : 'Save cancelled.'); } catch (err) { say('Could not save: ' + err.message); } };
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); say(what + ' copied.'); } catch { clipOut.hidden = false; clipOut.value = text; clipOut.select(); say('Clipboard is blocked here: select the text below and copy it.'); } };
  const copyBtns = (lx, js) => h('span', { class: 'copyset' }, h('button', { class: 'chip small', onclick: () => copy(lx(), 'LaTeX') }, 'Copy LaTeX'), h('button', { class: 'chip small', onclick: () => copy(JSON.stringify(js(), null, 2), 'JSON') }, 'Copy JSON'));
  const base = slug(S.name);
  el.append(h('p', { class: 'note runtag' }, `Run #${F.id} · ${F.free.map((f) => f.label).join(', ')}`, toast));

  el.append(h('h3', {}, 'Fitted parameters', copyBtns(fittedLatex, fittedJSON)));
  const rows = F.summary.map((s) => { const dg = digitsFor(s); return `<tr><td>${s.label}${s.unit ? ` <small>${s.unit}</small>` : ''}</td><td>${pmHTML(s, dg)}</td><td>${s.best.toFixed(dg)}</td>${F.truth ? `<td>${Number(F.truth[s.key]).toFixed(dg)}</td>` : ''}</tr>`; }).join('');
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res', html: `<thead><tr><th>Parameter</th><th>median ±1σ</th><th>best fit</th>${F.truth ? '<th>truth</th>' : ''}</tr></thead><tbody>${rows}</tbody>` })));

  el.append(h('h3', {}, 'System parameters', copyBtns(systemLatex, systemJSON)));
  const tag = { fit: '', derived: '', input: '<small>input</small>', fixed: '<small>fixed</small>', estimated: '<small>estimated</small>' };
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res sys', html: '<tbody>' + systemRows().map((x) => (x.section ? `<tr class="sec"><td colspan="3">${x.section}</td></tr>` : `<tr class="${x.kind}"><td>${x.label}</td><td>${pmHTML(x.s, x.dg)} ${tag[x.kind]}</td><td>${x.unit || ''}</td></tr>`)).join('') + '</tbody>' })));
  if (F.starTied) el.append(h('p', { class: 'note callout' }, 'M★ and R★ were held at their values in this fit, so masses, K, a/R★ and the quantities that follow from them do not include the stellar uncertainties. To fold those in, tick M★ and R★ on the Fit tab (their priors default to the catalogue errors) and run again.'));
  el.append(h('p', { class: 'note' }, 'Rows follow Table 7 of Pearson et al. (2022). Derived rows are evaluated on posterior draws with the stellar uncertainties folded in; durations and event times come from the orbit numerically.' + (F.starEstimated ? ' Stellar mass and radius were estimated from T eff, log g and [Fe/H].' : '')));
  el.append(h('div', { class: 'btnrow' }, h('span', { class: 'note' }, 'Save everything:'),
    h('button', { class: 'btn', onclick: () => save(base + '_parameters.tex', () => fittedLatex() + '\n' + systemLatex()) }, 'LaTeX file'),
    h('button', { class: 'btn', onclick: () => save(base + '_posterior.json', () => allJSON()) }, 'JSON file')), clipOut);

  el.append(h('h3', {}, 'Posterior', F.truth ? h('span', { class: 'badge warn' }, 'cross = simulated truth') : null));
  const cv = h('canvas', { id: 'corner' }); el.append(cv);
  const labels = F.free.map((f) => f.label), marks = F.truth ? F.free.map((f) => F.truth[f.key]) : null;
  const draw = () => drawCorner(cv, r, labels, marks);
  requestAnimationFrame(draw); F.redraw = draw;
  const cornerCanvas = (theme) => { const c = document.createElement('canvas'); drawCorner(c, r, labels, marks, { theme, width: Math.max(560, 170 * r.ndim), scale: 3, title: `${S.name} — posterior` }); return c; };
  el.append(h('div', { class: 'btnrow' },
    h('span', { class: 'note' }, 'Save figure:'),
    h('button', { class: 'btn', onclick: () => save(base + '_posterior.png', () => canvasToPNG(cornerCanvas('light'))) }, 'PNG'),
    h('button', { class: 'btn', onclick: () => save(base + '_posterior.pdf', () => canvasToPDF(cornerCanvas('light'))) }, 'PDF'),
    h('button', { class: 'btn', onclick: () => save(base + '_posterior_dark.png', () => canvasToPNG(cornerCanvas('dark'))) }, 'PNG dark'),
    h('button', { class: 'btn', onclick: () => save(base + '_posterior_dark.pdf', () => canvasToPDF(cornerCanvas('dark'))) }, 'PDF dark')));
  el.append(h('p', { class: 'note' }, 'Each point is a posterior draw, coloured by the credible region it falls in, with contours at the 1σ, 2σ and 3σ boundaries (39.3 / 86.5 / 98.9% of the probability in two dimensions). Histogram shading marks the 68.3 / 95.4 / 99.7% intervals.'));

  el.append(h('h3', {}, 'Evidence & diagnostics'));
  const insOk = r.insertionP > 0.01;
  el.append(h('div', { class: 'kv', html: [
    ['ln Z (marginal likelihood)', `${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}`], ['Information H', r.H.toFixed(1) + ' nats'],
    ['Effective samples', r.ess.toFixed(0)], ['Likelihood calls', `${r.ncalls} (${(100 * r.n / r.ncalls).toFixed(1)}% eff.)`],
    ['χ² / N', `${F.chi2.toFixed(1)} / ${F.N}`], ['BIC', F.ic.bic.toFixed(1)],
    ['Run time', r.elapsed.toFixed(1) + ' s'], ['Insertion-order p', `<span style="color:${insOk ? 'var(--ok)' : 'var(--warn)'}">${r.insertionP.toFixed(3)}</span>`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') }));
  const notes = [];
  if (F.parts && (F.parts.nrv || F.parts.ntim)) notes.push('χ² by kind of data: ' + [F.parts.nlc ? `light curve ${F.parts.lc.toFixed(1)} / ${F.parts.nlc}` : null, F.parts.nrv ? `velocities ${F.parts.rv.toFixed(1)} / ${F.parts.nrv}` : null, F.parts.ntim ? `timing ${F.parts.timing.toFixed(1)} / ${F.parts.ntim}` : null].filter(Boolean).join(' · ') + '.' + (F.parts.nrv && F.parts.rv / F.parts.nrv > 2 && F.rvFit.every((x) => !(x.jitter > 0)) ? ' The velocities scatter more than their error bars: free the instrument jitters (Fit tab) for realistic uncertainties.' : ''));
  if (r.stopReason !== 'converged') notes.push(`Run ended early (${r.stopReason}): the posterior is usable but ln Z is not converged and should not be used to compare models.`);
  if (!insOk) notes.push('The insertion-order test is low, which can mean the region missed part of the posterior. Re-run with more live points before trusting ln Z.');
  if (r.mode === 'slice') notes.push('Region sampling became inefficient, so the run finished with slice sampling.');
  if (r.nplateau > 0) notes.push(`${r.nplateau} live points sat on a likelihood plateau (models with no transit in the data) and were retired as a block.`);
  if (F.chi2 / F.N < 0.5) notes.push('χ²/N is well below 1: the error bars are larger than the scatter, which inflates the parameter uncertainties and distorts ln Z. See “Rescale errors” on the Data tab.');
  if (F.chi2 / F.N > 1.6) notes.push('χ²/N is well above 1: errors are underestimated or the model is missing something. Parameter uncertainties will be too small.');
  el.append(...notes.map((t) => h('p', { class: 'note' }, t)));
  comparisonTable(el);
}

function comparisonTable(el) {
  if (!S.runs.length) return;
  const here = S.runs.filter((x) => x.dataId === S.dataId);
  el.append(h('h3', {}, 'Runs & model comparison', h('button', { class: 'chip small', title: 'Forget every stored run', onclick: () => { S.runs = []; buildResultsTab(); } }, 'clear')));
  if (!here.length) { el.append(h('p', { class: 'note' }, `${S.runs.length} earlier run${S.runs.length > 1 ? 's' : ''} used different data or error bars, so their evidences cannot be compared with fits to the current light curve. Undo (Ctrl/⌘+Z) returns to that data.`)); return; }
  const bestZ = Math.max(...here.map((x) => x.logZ)), top = here.find((y) => y.logZ === bestZ), tb = h('tbody');
  for (const x of here) {
    const dz = x.logZ - bestZ, e = Math.hypot(x.err, top.err);
    const tr = h('tr', { class: 'runrow' + (S.fit === x.fit ? ' active' : ''), tabindex: 0, title: 'Show this run’s posterior, tables and best-fit model', html: `<td>#${x.id} ${x.name}<br><small>${x.law}${x.converged ? '' : ' · not converged'}</small></td><td>${x.logZ.toFixed(2)} ± ${x.err.toFixed(2)}</td><td>${dz === 0 ? 'best' : `${dz.toFixed(2)} ± ${e.toFixed(2)}`}</td><td>${x.bic.toFixed(1)}</td>` });
    tr.addEventListener('click', () => restoreRun(x));
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); restoreRun(x); } });
    tb.append(tr);
  }
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res cmp' }, h('thead', { html: '<tr><th>Run · free parameters</th><th>ln Z</th><th>Δ ln Z</th><th>BIC</th></tr>' }), tb)));
  el.append(h('p', { class: 'note' }, 'Click a row to bring that run back: its posterior, tables and best-fit model. Δ ln Z is the log Bayes factor against the best run on this dataset; differences smaller than their error, or below about 1, are not decisive, and beyond about 5 is strong.' + (S.runs.length > here.length ? ` ${S.runs.length - here.length} run(s) on other data are hidden.` : '')));
}

// ---- stage controls & animation -----------------------------------------------

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + name));
  if (name === 'results' && S.fit && S.fit.redraw) requestAnimationFrame(S.fit.redraw);
  if (name === 'system') refresh();
  if (name === 'timing' && timingRedraw) requestAnimationFrame(timingRedraw);
}
function syncViewButtons() { const v = viz.getView ? viz.getView() : 'free'; document.querySelectorAll('#viewseg button').forEach((x) => x.classList.toggle('on', x.dataset.view === v)); }

function buildLookPanel() {
  const p = $('#lookpanel'); p.innerHTML = '';
  const o = viz.getOptions();
  if (viz.kind !== 'three') { p.append(h('p', { class: 'note' }, 'Style controls apply to the 3D view, which is not available here.')); return; }
  const sel = (label, key, opts) => { const s = h('select', { 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, selected: o[key] === v }, t))); s.addEventListener('change', () => viz.setOptions({ [key]: s.value })); return h('div', { class: 'field', style: 'grid-template-columns:70px 1fr' }, h('span', {}, label), s); };
  p.append(h('h4', {}, 'Style'), sel('Render', 'style', [['eyes', 'Realistic'], ['blueprint', 'Blueprint']]), sel('Planet', 'look', [['auto', 'Auto (by radius)'], ['jupiter', 'Jupiter-size'], ['neptune', 'Neptune-size'], ['subneptune', 'Sub-Neptune'], ['earth', 'Earth-size'], ['lava', 'Lava world']]));
  const tg = (label, key) => { const c = h('input', { type: 'checkbox', checked: !!o[key] }); c.addEventListener('change', () => viz.setOptions({ [key]: c.checked })); return h('label', { class: 'tog' }, c, label); };
  p.append(h('h4', {}, 'Show'), h('div', { class: 'grid2' }, tg('Orbit path', 'orbit'), tg('Orbital grid', 'grid'), tg('Transit corridor', 'corridor'), tg('Labels', 'labels'), tg('Earth-view inset', 'inset'), tg('Background stars', 'stars'), tg('Corona glow', 'glow'), tg('Granulation', 'granulation'), tg('Enlarge planet', 'enlarge')));
  const hzc = h('input', { type: 'checkbox', checked: S.hz });
  hzc.addEventListener('change', () => { S.hz = hzc.checked; doRefresh(); viz.setOptions({ hz: S.hz }); syncViewButtons(); });
  const a0 = h('input', { type: 'number', min: 0, max: 0.95, step: 0.05, value: S.albedo[0], 'aria-label': 'Minimum albedo' }), a1 = h('input', { type: 'number', min: 0, max: 0.95, step: 0.05, value: S.albedo[1], 'aria-label': 'Maximum albedo' });
  [a0, a1].forEach((i, j) => i.addEventListener('change', () => { S.albedo[j] = Math.min(0.95, Math.max(0, Number(i.value) || 0)); S.albedo.sort((x, y) => x - y); refresh(); }));
  p.append(h('h4', {}, 'Habitable zone'), h('label', { class: 'tog' }, hzc, 'Show the habitable zone'), h('div', { class: 'field3', style: 'margin-top:4px' }, h('span', {}, 'Albedo'), a0, h('span', { class: 'pm' }, '–'), a1));
  p.append(h('p', { class: 'note', style: 'margin-bottom:0' }, 'Brightest where every case agrees: Kopparapu et al. conservative limits, fading to the optimistic ones, blurred by the T eff uncertainty and the albedo range. “Enlarge planet” is for visibility only; the From Earth view and the inset are always true scale.'));
}

function animRange() {
  const v = cur(S.values);
  if (S.loop === 'orbit') return [v.tmid - v.per / 2, v.tmid + v.per / 2, 24];
  const vw = lcPlot.view; return [vw.x0, vw.x1, 14];   // follow whatever part of the light curve is on screen
}
let lastT = performance.now(), recording = false;
function clockText(t) { const v = cur(), dth = (t - v.tmid) * 24, ph = (((t - v.tmid) / v.per) % 1 + 1.5) % 1 - 0.5; return `${dth >= 0 ? '+' : '−'}${Math.abs(dth) < 100 ? Math.abs(dth).toFixed(2) + ' h' : (Math.abs(dth) / 24).toFixed(2) + ' d'}  ·  phase ${ph.toFixed(4)}`; }
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (!model || !lcPlot.view) return;
  const [a, b, dur] = animRange();
  if (S.playing && !recording) { S.t += ((b - a) / dur) * dt * Math.pow(10, S.speed); if (S.t > b || S.t < a) S.t = a; }
  if (viz) viz.setTime(S.t);
  lcPlot.setCursor(cursorTime(S.t));
  $('#clock').textContent = clockText(S.t);
}

async function recordClip() {
  const btn = $('#rec'), msg = $('#lcmsg');
  if (recording) return;
  if (!movieSupport()) { msg.textContent = 'This browser cannot record video from the page.'; return; }
  const [a, b, dur] = animRange(), seconds = Math.min(40, Math.max(5, dur / Math.pow(10, S.speed)));
  recording = true; btn.classList.add('recording'); btn.textContent = '● 0%';
  try {
    const { blob, ext } = await recordMovie({
      stage: () => $('#viz canvas'), t0: a, t1: b, seconds, title: S.name, subtitle: clockText,
      drawLC: (ctx, w, hh, t) => renderLightCurve(ctx, w, hh, { ...lcPlot.d, cursor: t }, lcPlot.view, LC_THEMES.dark, { fontScale: 1.3 }),
      setTime: (t) => { S.t = t; },
      onProgress: (f) => { btn.textContent = `● ${Math.round(f * 100)}%`; },
    });
    const name = `${slug(S.name)}_transit.${ext}`, st = await saveFile(name, blob);
    msg.textContent = st === 'saved' ? `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB)` : 'Save cancelled.';
  } catch (err) { msg.textContent = 'Could not record: ' + err.message; }
  recording = false; btn.classList.remove('recording'); btn.textContent = '● Rec';
  setTimeout(() => (msg.textContent = ''), 6000);
}

function setupLCToolbar() {
  const reset = $('#lcreset'), menu = $('#lcmenu'), msg = $('#lcmsg');
  lcPlot.onViewChange = (_, zoomed) => { reset.hidden = !zoomed; };
  reset.addEventListener('click', () => lcPlot.resetView());
  $('#lcfold').addEventListener('click', () => { pushUndo(); S.fold = !S.fold; refresh(true); });
  document.querySelectorAll('#viewsel button').forEach((b) => b.addEventListener('click', () => { if (S.view === b.dataset.v) return; pushUndo(); S.view = b.dataset.v; refresh(true); }));
  // how the data and the model are drawn: opacity of the points and of the model, bins, colour by observation
  const pop = $('#viewpop');
  const buildView = () => {
    pop.innerHTML = '';
    const sl = (label, key, title) => { const i = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: S.plot[key], 'aria-label': label }); i.addEventListener('input', () => { S.plot = { ...S.plot, [key]: Number(i.value) }; refresh(); }); return h('label', { class: 'sl', title }, label, i); };
    const tg = (label, key, title) => { const c = h('input', { type: 'checkbox', checked: !!S.plot[key] }); c.addEventListener('change', () => { S.plot = { ...S.plot, [key]: c.checked }; refresh(); }); return h('label', { class: 'tog', title }, c, label); };
    pop.append(sl('Points', 'ptAlpha', 'Opacity of the individual measurements'), sl('Model', 'modelAlpha', 'Opacity of the model curve: turn it down to judge the data on their own'),
      tg('Binned points', 'bins', 'Weighted means in bins across the window on screen'), tg('Colour by observation', 'color', 'Each epoch or instrument in its own colour, with its own bins'));
  };
  $('#viewbtn').addEventListener('click', () => { pop.hidden = !pop.hidden; if (!pop.hidden) { menu.hidden = true; buildView(); } });
  $('#lcexport').addEventListener('click', () => { menu.hidden = !menu.hidden; pop.hidden = true; });
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    menu.hidden = true;
    const [fmt, theme] = b.dataset.fmt.split('-'), name = `${slug(planetLabel())}_${S.view === 'rv' ? 'rv' : 'lightcurve'}${S.fold ? '_folded' : ''}${theme === 'dark' ? '_dark' : ''}.${fmt}`;
    try {
      msg.textContent = 'Preparing…';
      const c = lcPlot.exportCanvas(theme, S.view === 'rv' ? `${planetLabel()} — radial velocities` : `${planetLabel()} — ${S.data.name}`, S.data.tRef || 0);
      const st = await saveFile(name, fmt === 'png' ? await canvasToPNG(c) : await canvasToPDF(c));
      msg.textContent = st === 'saved' ? 'Saved ' + name : 'Save cancelled.';
    } catch (err) { msg.textContent = 'Could not save: ' + err.message; }
    setTimeout(() => (msg.textContent = ''), 5000);
  }));
}

/** Drag the divider to give the side panel more room; the width is remembered on this device. */
function setupResizer() {
  const app = $('#app'), grip = $('#grip');
  const setW = (w) => { const v = Math.round(Math.min(Math.max(w, 340), Math.max(360, window.innerWidth - 360))); app.style.setProperty('--panelw', v + 'px'); return v; };
  try { const w = Number(localStorage.getItem('exoplanetsciencelab.panelw')); if (w > 0) setW(w); } catch { /* storage unavailable */ }
  let drag = false;
  grip.addEventListener('pointerdown', (e) => { drag = true; grip.setPointerCapture(e.pointerId); document.body.classList.add('resizing'); });
  grip.addEventListener('pointermove', (e) => { if (drag) setW(window.innerWidth - e.clientX); });
  const end = () => { if (!drag) return; drag = false; document.body.classList.remove('resizing'); try { localStorage.setItem('exoplanetsciencelab.panelw', parseInt(getComputedStyle(app).getPropertyValue('--panelw'), 10)); } catch { /* ignore */ } if (S.fit && S.fit.redraw) S.fit.redraw(); if (timingRedraw) timingRedraw(); refresh(); };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => { app.style.removeProperty('--panelw'); try { localStorage.removeItem('exoplanetsciencelab.panelw'); } catch { /* ignore */ } });
  grip.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const cur = parseInt(getComputedStyle(app).getPropertyValue('--panelw'), 10) || 410; setW(cur + (e.key === 'ArrowLeft' ? 24 : -24)); } });
}

async function init() {
  lcPlot = new LightCurvePlot($('#lccanvas'));
  window.__esl = { S, lcPlot, undo, redo };   // handle for tests and console poking
  lcPlot.onScrub = (t) => { S.t = t; S.playing = false; $('#play').textContent = '▶'; };
  setupLCToolbar(); setupResizer();
  const intro = initIntro({ h, examples: EXAMPLES, loadExample, applySession, fetchCatalog });
  $('.brand').addEventListener('click', () => intro.open());
  $('#startbtn').addEventListener('click', () => intro.open());
  window.__esl.intro = intro; window.__esl.loadExample = loadExample; window.__esl.examples = EXAMPLES;
  // the opening page is shown on arrival unless the address asks to skip it (tests, deep links)
  if (!/[?&]skipintro\b/.test(location.search)) intro.open();
  const ps = $('#preset');
  for (const [k, p] of Object.entries(PRESETS)) ps.append(h('option', { value: k }, p.label));
  ps.addEventListener('change', () => { if (ps.value === 'session') return; if (S.running) stopFit(); pushUndo(); loadPreset(ps.value); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#play').addEventListener('click', () => { S.playing = !S.playing; $('#play').textContent = S.playing ? '❚❚' : '▶'; });
  $('#speed').addEventListener('input', (e) => (S.speed = Number(e.target.value)));
  $('#rec').addEventListener('click', recordClip);
  if (!movieSupport()) $('#rec').hidden = true;
  $('#undo').addEventListener('click', undo); $('#redo').addEventListener('click', redo);
  // undo / redo anywhere on the page; text areas keep their own typing undo
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase(), tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || (tag === 'input' && e.target.type === 'text')) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
  document.querySelectorAll('#loopseg button').forEach((b) => b.addEventListener('click', () => { S.loop = b.dataset.loop; document.querySelectorAll('#loopseg button').forEach((x) => x.classList.toggle('on', x === b)); S.t = cur(S.values).tmid; S.playing = true; $('#play').textContent = '❚❚'; }));
  document.querySelectorAll('#viewseg button').forEach((b) => b.addEventListener('click', () => { viz.setView(b.dataset.view); syncViewButtons(); }));
  $('#lookbtn').addEventListener('click', () => { const p = $('#lookpanel'); p.hidden = !p.hidden; $('#lookbtn').setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) buildLookPanel(); });

  // The science UI does not depend on the 3D layer: load it separately and fall back if it cannot start.
  const box = $('#viz'), labels = $('#labels'), inset = $('#insetframe');
  loadPreset('hatp32');
  const useFallback = (err) => {
    console.warn('3D view unavailable:', err);
    box.innerHTML = '';
    const why = /import|fetch|module|resolve/i.test(String(err)) ? 'three.js could not be loaded' : /webgl|context/i.test(String(err)) ? 'WebGL is not available' : 'render error: ' + (err && err.message ? err.message : err);
    viz = createFallbackViz(box, labels, inset, why);
    refresh();
  };
  try {
    const mod = await import('./viz/scene.js');
    viz = await mod.createViz(box, labels, inset, useFallback);
  } catch (err) { useFallback(err); }
  refresh();
  requestAnimationFrame(tick);
}
init();
