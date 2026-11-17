import { fetchOr, siteJson } from './site/net.js';
import { activeParams, STAR_PARAMS, toTransitParams, buildProblem, infoCriteria, autoSupersample, A1_PRIOR_WIDTH, PLANET_FIELDS, planetKey, jitterKey, lcJitterKey, ECC_PARAMS } from './core/model.js';
import { RV_SOURCES, sourceById, findRadialVelocities as searchRVArchives } from './core/rvsources.js';
import { projectHandle, fitRecord } from './site/project.js';
import { arsFromKepler, semiAmplitude, makeRV } from './core/rv.js';
import { makeRM } from './core/rm.js';
import { makePlanetMoonTransit, moonParamsFrom, moonComponents, moonGeometry, moonSearch, MOON_PARAMS, MOON_FIELDS, moonKey } from './core/exomoon.js';
import { renderMoonLightCurve, renderMoonSearch } from './ui/moonplot.js';
import { makePhaseCurve, PHASE_FIELDS, PHASE_BY_KEY, BANDS, phaseSummary } from './core/phasecurve.js';
import { renderPhaseCurve, renderPlanetMap, renderTemperaturePhase, phasePlotData, mapPlotData, temperaturePlotData, mapRGBA } from './ui/phaseplot.js';
import { LD_LAWS, toClaret, checkProfile, intensity, kippingToQuadratic, quadraticToKipping } from './core/limbdark.js';
import { orbitElements, eventTimes } from './core/kepler.js';
import { makeTransit } from './core/transit.js';
import { PRIOR_TYPES, validatePrior } from './core/priors.js';
import { applyDetrend, errorScaleFactors } from './core/data.js';
import { alignColumns, DETREND_COLUMNS } from './core/detrend.js';
import { synthesize, parseLightCurve, nearestEpoch, TIME_SYSTEMS, FLUX_UNITS, TIME_STANDARDS, combineEpochs, removeEpoch, splitByOrbit, foldTimes, epochList, parseRV } from './core/data.js';
import { weightedQuantiles, resampleIndices, makeRng } from './core/stats.js';
import { runFit } from './core/fitRunner.js';
import { deriveSystem, planetClass, summarizeDraws, summarizeEpoch, C as CONST } from './core/derive.js';
import { lightCurveFromFits, looksLikeFits } from './core/lcfits.js';
import { hzProfile } from './core/hz.js';
import { MISSION_BANDS } from './core/missionbands.js';
import { FILTERS, greyProfile, fitLaw, interpLDGrid, gridFromTable, readLDTable, makeLDTie } from './core/ldest.js';
import { estimateMassRadius } from './core/stellar.js';
import { configToObject, toYAML, parseConfig } from './core/config.js';
import { HD80606_TESS } from './data/hd80606_tess.js';
import { LD_TABLE } from './data/ld_table.js';
import { LightCurvePlot, renderLightCurve, renderResiduals, autoView, LC_THEMES, GROUP_COLORS } from './ui/lightcurve.js';
import { drawCorner } from './ui/corner.js';
import { renderRV, rvExtent } from './ui/rvplot.js';
import { saveFile, canvasToPNG, canvasToPDF, latexTable } from './ui/export.js';
import { recordMovie, movieSupport, MOVIE_FORMATS } from './ui/movie.js';
import { RATE_STEPS, rateLabel, defaultStep } from './ui/rate.js';
import { buildTimingTab, timingFigure } from './ui/timingTab.js';
import { renderOC } from './ui/ocplot.js';
import { buildDynamics } from './ui/dynamics.js';
import { createAPI } from './ui/api.js';
import { mountNav } from './site/nav.js';
import { startJob } from './site/jobs.js';
import { startTour } from './ui/tour.js';
import { FORMAT, FORMAT_VERSION, validateSession } from './core/session.js';
import { saveExperiment, listExperiments, getExperiment, deleteExperiment } from './ui/store.js';
import { EXAMPLES } from './ui/examples.js';
import { parseTimings } from './core/ephemeris.js';
import { expandSpectral, bandTable } from './core/ldspec.js';
import { initIntro, provenanceTable, checkList, sessionFromCatalog, sessionFromTOI, parseTOIName } from './ui/intro.js';
import TOI_SOURCE from './core/sources/toi.js';
import { loadIndex, lookupHost, systemFromRows } from './core/catalog.js';
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
/** A dataset name without the tag older bundled files and stored sessions carry. */
const plainName = (name) => String(name).replace(/\s*\(EXOTIC example\)/, '');

// ---- presets ------------------------------------------------------------------
// Stellar values: HD 80606 from Pearson et al. (2022) Table 7; toy-1873 from the simulated
// multi-planet system in EXOTIC's sample data; HAT-P-32 are approximate literature values for illustration.
const PRESETS = {
  hatp32: {
    label: 'HAT-P-32 b · simulated ground-based night', name: 'HAT-P-32 b', ldLaw: 'quadratic', band: 'MObs CV (clear)',
    star: { teff: 6001, teffErr: 88, logg: 4.22, loggErr: 0.04, feh: -0.16, fehErr: 0.08, rstar: 1.22, rstarErr: 0.02, mstar: 1.16, mstarErr: 0.04, mplanet: null, mplanetErr: 0 },
    values: { rprs: 0.1489, ars: 5.344, inc: 88.98, per: 2.1500082, tmid: 0, ecc: 0.159, omega: 50, ld0: 0.33, ld1: 0.29, ld2: 0, ld3: 0, a2: -0.03 },
    data: { kind: 'synthetic', exptimeMin: 1, noisePpm: 1800, baselineHr: 0.6, airmass: true, seed: 1 },
    free: ['rprs', 'inc', 'tmid', 'a2'],
  },
  hd80606: {
    label: 'HD 80606 b · TESS light curve', name: 'HD 80606 b', ldLaw: 'nonlinear', band: 'TESS (approx.)',
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
  free: {}, priors: {}, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6 },
  fit: null, range: 'full', runs: [], running: false, live: null,
  planets: [{ sfx: '', letter: 'b' }], pl: '',   // planets of the system (key suffixes) and the one the sliders, 3D view and folds show
  kepler: false,           // a/R★ of every planet from Kepler's law with M★, R★ and the planet's mass, instead of a free a/R★
  rv: [],                  // radial-velocity datasets [{ name, t, v, e }], times on the light curve's reference
  use: { lc: true, rv: false, timing: false },   // which kinds of data enter the fit
  view: 'lc',              // what the data panel shows: 'lc' or 'rv'
  nbody: null,             // { epoch }: the planets pull on each other in fits of times and velocities (N-body); epoch relative to data.tRef
  phase: null,             // the planet's own light: { mode: 'harmonic' | 'map', lmax, ltt, band_micron: [lo, hi] }; a planet has it when its "fpfs" is set
  allPlanets: false,       // several planets: every planet's folded panel side by side on one vertical scale, instead of the one on show
  plot: { ptAlpha: 0.45, modelAlpha: 1, bins: true, color: true },
  sources: null,           // where the system parameters came from (catalog look-up), for the System tab
  note: '',                // one line about the loaded example or catalog system, shown on the Fit and Data tabs
  fold: false,             // light curve drawn against time from the nearest transit (several epochs on top of each other)
  hz: false, albedo: [0.2, 0.4],
  timing: { rows: [], order: 1, text: '' },   // mid-transit times (absolute days) for the Timing tab
  t: 0, playing: false, loop: 'transit',   // still on arrival: the user presses play (or Rec)
  rateStep: 7,   // rateStep: index into RATE_STEPS (simulated days per real second), set from the system unless the slider moved
};
let viz = null, lcPlot = null, model = null, refreshQueued = false, runner = null;
let lastProgress = null;  // the latest progress report of the running fit (see fitProgress)
let displayNorm = null;   // { dataId, a1s }: per-epoch normalisation the plotted data are divided by (see computeModel)

// ---- undo / redo ----------------------------------------------------------------
// Everything the user can change is captured before each action; data and fit results
// are held by reference (they are replaced, never edited in place).
const UNDO = [], REDO = [];
const SNAP_COPY = ['preset', 'name', 'ldLaw', 'band', 'ldMsg', 'keepPhysical', 'ldMode', 'dataId', 'exptimeMin', 'range', 'hz', 'fold', 'pl', 'kepler', 'view', 'note', 'allPlanets'];
const SNAP_DEEP = ['phase', 'nbody', 'star', 'values', 'bandCustom', 'parseOpts', 'synth', 'free', 'priors', 'sampler', 'albedo', 'timing', 'planets', 'use', 'plot'];
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
// Wavelength-resolved limb darkening (PHOENIX, 200-5500 nm in 357 bins), for a custom range. It is a separate
// chunk fetched the first time a custom range is used; until it arrives the grey estimate stands in.
let spectral = null, spectralState = 'idle';
const bandGridCache = new Map();
function loadSpectral() {
  if (spectralState !== 'idle') return;
  spectralState = 'loading';
  import('./data/ld_spectral.js').then((m) => { spectral = expandSpectral(m.LD_SPECTRAL_COMPACT); spectralState = 'ready'; syncStarLD.key = null; buildPanels(); refresh(); })
    .catch((err) => { spectralState = 'failed'; console.warn('spectral limb darkening table unavailable:', err); });
}
/** The table of coefficients for the current custom range, at every stellar model, or null while it cannot be made. */
function customBandTable() {
  if (!spectral) { loadSpectral(); return null; }
  let [w0, w1] = bandRange();
  if (w1 > 5500 && w0 < 5400) w1 = 5500;   // a band that runs past the table's red end (Ariel AIRS-Ch1) uses the part inside it, as the spectroscopy page does
  const key = w0 + '-' + w1;
  if (!bandGridCache.has(key)) { let t = null; try { t = bandTable(spectral, [w0, w1]); } catch { t = null; } /* outside 200-5500 nm */ if (bandGridCache.size > 20) bandGridCache.clear(); bandGridCache.set(key, t); }
  return bandGridCache.get(key);
}
const ldTableName = () => (S.band === 'Custom range' ? 'the PHOENIX spectral table (200–5500 nm)' : S.table.name);
function gridFor(law) {
  if (!S.table) return null;
  if (S.band === 'Custom range') { const t = S.table.kind === 'json' ? customBandTable() : null; return t ? gridFromTable(t, law) : null; }   // no spectral table yet, or out of range: the grey estimate
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
/**
 * A range for limb-darkening coefficient i from the star: T eff and [Fe/H] drawn from their uncertainties (100 K and 0.1 dex
 * when none are given), the coefficients of the current law recomputed from the same table or grey atmosphere as the
 * sliders, and the range set to the nominal value ± max(3 × their spread, 0.1). The 0.1 stands for the models' own
 * systematic error, larger than the stellar one for most stars. The current value is always inside. null when the
 * coefficients cannot be computed for this star.
 */
function ldPriorRange(i, v) {
  try {
    const st = S.star, nom = ldFromStar(st.teff, st.feh).coeffs[i]; if (!Number.isFinite(nom)) return null;
    const rng = makeRng(17), te = st.teffErr > 0 ? st.teffErr : 100, fe = st.fehErr > 0 ? st.fehErr : 0.1, xs = [];
    for (let k = 0; k < 40; k++) { const c = ldFromStar(st.teff + te * rng.normal(), st.feh + fe * rng.normal()).coeffs[i]; if (Number.isFinite(c)) xs.push(c); }
    const m = xs.reduce((a, x) => a + x, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)), half = Math.max(0.1, 3 * sd);
    return { lo: Math.min(nom - half, v - 0.02), hi: Math.max(nom + half, v + 0.02), note: `from the star: ${nom.toFixed(3)} ± ${half.toFixed(3)} (T eff ± ${te} K, [Fe/H] ± ${fe}; at least ± 0.1 for the models' own error)` };
  } catch { return null; }
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
/** Does this planet have a moon in the model? (It does when its moon radius is defined.) */
const hasMoon = (sfx = S.pl, values = S.values) => values[moonKey('rmoon', sfx)] !== undefined && values[moonKey('rmoon', sfx)] !== null;
/** Is this planet's own light in the model (eclipse, phase curve, map)? It is when its "fpfs" is defined. */
const hasPhase = (sfx = S.pl, values = S.values) => values[planetKey('fpfs', sfx)] !== undefined && values[planetKey('fpfs', sfx)] !== null;
const phaseSpec = () => ({ mode: 'harmonic', lmax: 1, ltt: true, band_micron: [4, 5], ...(S.phase || {}) });
const phaseOpts = (values = S.values) => { const ph = phaseSpec(); return { ltt: !!ph.ltt && (values.rstar ?? starNow().rstar) > 0, map: ph.mode === 'map' }; };
/** Transit parameters of a planet with its phase-curve parameters added (for phasecurve.js). */
function phaseParamsOf(values, sfx = S.pl) {
  const pp = { ...toTransitParams(planetValues(values, sfx), S.ldLaw), rstar: values.rstar ?? starNow().rstar };
  for (const k of PHASE_FIELDS) { const x = values[planetKey(k, sfx)]; if (x !== undefined && x !== null) pp[k] = x; }
  return pp;
}
const actParams = () => withSqrtE(activeParams(S.ldLaw, airSpec(), { planets: S.planets, kepler: S.kepler, mass: rvOn() || !!S.nbody, rv: rvOn() ? S.rv.map((d) => d.name) : [], moons: S.planets.filter((p) => hasMoon(p.sfx)).map((p) => p.sfx),
  phase: Object.fromEntries(S.planets.filter((p) => hasPhase(p.sfx)).map((p) => [p.sfx, phaseSpec()])), lcJitter: hasOpt('jitlc'), dilution: hasOpt('dil'), rm: rvOn() && hasOpt('vsini') }));
/** Is an optional term in the model (light-curve jitter "jitlc", dilution "dil", Rossiter–McLaughlin "vsini")? It is when a key of that name has a value. */
const hasOpt = (base, values = S.values) => Object.keys(values).some((k) => baseKey(k) === base && Number.isFinite(values[k]));
/** Does this planet's eccentricity come as √e cos ω, √e sin ω (keys "secosw", "sesinw")? */
const usesSqrtE = (sfx = S.pl, values = S.values) => Number.isFinite(values[planetKey('secosw', sfx)]) && Number.isFinite(values[planetKey('sesinw', sfx)]);
/** The parameter list with e and ω of such planets replaced by √e cos ω and √e sin ω. */
function withSqrtE(list) {
  const out = [];
  for (const p of list) {
    if (p.group === 'planet' && (p.base === 'ecc' || p.base === 'omega') && usesSqrtE(p.planet)) {
      if (p.base === 'ecc') { const many = S.planets.length > 1, L = (S.planets.find((q) => q.sfx === p.planet) || {}).letter; for (const e of ECC_PARAMS) out.push({ ...e, key: planetKey(e.key, p.planet), base: e.key, planet: p.planet, label: many ? `${e.label} · ${L}` : e.label, group: 'planet' }); }
      continue;
    }
    out.push(p);
  }
  return out;
}
/** Switch a planet between e, ω and √e cos ω, √e sin ω, keeping the orbit and what is free. */
function setSqrtE(on, sfx = S.pl) {
  if (on === usesSqrtE(sfx)) return;
  pushUndo();
  const kc = planetKey('secosw', sfx), ks = planetKey('sesinw', sfx), ke = planetKey('ecc', sfx), kw = planetKey('omega', sfx), pv = planetValues(S.values, sfx);
  const r6 = (x) => Number(x.toFixed(6)), box = (v) => ({ type: 'uniform', a: r6(Math.max(-1, v - 0.3)), b: r6(Math.min(1, v + 0.3)) });
  if (on) {
    const e = pv.ecc || 0, w = ((pv.omega || 0) * Math.PI) / 180, fr = !!(S.free[ke] || S.free[kw]);
    S.values[kc] = r6(Math.sqrt(e) * Math.cos(w)); S.values[ks] = r6(Math.sqrt(e) * Math.sin(w));
    S.priors[kc] = box(S.values[kc]); S.priors[ks] = box(S.values[ks]); S.free[kc] = fr; S.free[ks] = fr; S.free[ke] = false; S.free[kw] = false;
  } else {
    S.values[ke] = r6(pv.ecc); S.values[kw] = r6(pv.omega); S.free[ke] = !!S.free[kc]; S.free[kw] = !!S.free[ks];
    for (const k of [kc, ks]) { delete S.values[k]; delete S.free[k]; delete S.priors[k]; }
    resetPriors([ke, kw]);
  }
  S.fit = null; S.range = 'full'; buildPanels(); refresh();
  flash(on ? 'Eccentricity sampled as √e cos ω, √e sin ω' : 'Eccentricity sampled as e and ω');
}
/** The transit of one planet as a function of time: with its moon when it has one. */
function transitOf(values, sfx) {
  const pv = planetValues(values, sfx), tp = toTransitParams(pv, S.ldLaw), moon = moonParamsFrom(values, sfx, { mplanet: pv.mplanet, mstar: values.mstar ?? starNow().mstar });
  if (hasPhase(sfx, values)) { const pc = makePhaseCurve(phaseParamsOf(values, sfx), phaseOpts(values)); if (pc.ok) return pc; return makeTransit(tp); }
  if (!moon) return makeTransit(tp);
  const f = makePlanetMoonTransit({ ...tp, ...moon }); return f.ok ? f : makeTransit(tp);
}
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
  // √e cos ω, √e sin ω in place of e and ω (as buildProblem reads them)
  { const hc = values[planetKey('secosw', sfx)], hs = values[planetKey('sesinw', sfx)]; if (Number.isFinite(hc) && Number.isFinite(hs)) { o.ecc = hc * hc + hs * hs; o.omega = (Math.atan2(hs, hc) * 180) / Math.PI; } }
  if (S.kepler) { const st = star || starNow(); o.ars = arsFromKepler(o.per, values.mstar ?? st.mstar, o.mplanet || 0, values.rstar ?? st.rstar); }
  return o;
}
const cur = (values = S.live || S.values) => planetValues(values, S.pl);
/** The colour of a planet, the same in the selector, the folded panels and the 3D view. */
const planetColor = (sfx) => { const i = Math.max(0, S.planets.findIndex((p) => p.sfx === sfx)); return GROUP_COLORS.dark[i % GROUP_COLORS.dark.length]; };
const planetLabel = (sfx = S.pl) => { const p = S.planets.find((x) => x.sfx === sfx) || S.planets[0]; return S.planets.length > 1 ? `${S.name} ${p.letter}` : S.name; };
const nEpochs = () => (S.data.epoch ? S.data.segments.length : 1);
/** Per-epoch airmass coefficients ("a2@1", ...) get a value, a prior and a tick the first time they appear. */
function ensureEpochParams() {
  // a light-curve jitter follows the epochs: one per epoch with several, a single "jitlc" otherwise
  if (hasOpt('jitlc')) { const n = nEpochs(), want = Array.from({ length: n }, (_, s) => lcJitterKey(s, n)), j0 = Object.keys(S.values).filter((k) => baseKey(k) === 'jitlc').map((k) => S.values[k]).find(Number.isFinite) ?? 0;
    for (const o of [S.values, S.free, S.priors]) for (const k of Object.keys(o)) if (baseKey(k) === 'jitlc' && !want.includes(k)) delete o[k];
    for (const k of want) { if (!Number.isFinite(S.values[k])) S.values[k] = j0; if (!S.priors[k]) S.priors[k] = defaultPrior(k); if (S.free[k] === undefined) S.free[k] = true; } }
  for (const p of actParams()) {
    if (!p.key.startsWith('a2@')) continue;
    if (!Number.isFinite(S.values[p.key])) S.values[p.key] = Number.isFinite(S.values.a2) ? S.values.a2 : 0;
    if (!S.priors[p.key]) S.priors[p.key] = defaultPrior(p.key);
    if (S.free[p.key] === undefined) S.free[p.key] = true;
  }
}

function fitParams() {
  // a/R★ is never sampled: it trades off against the inclination through the impact parameter and stalls the
  // sampler. It stays at its System value, or follows from M★, R★ and the period with the Kepler switch.
  let act = actParams().filter((p) => p.base !== 'ars');
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
  if (base === 'permoon') return { type: 'uniform', a: r(0.97 * v), b: r(1.03 * v) };   // narrow: neighbouring aliases (1/P ± k/P planet) fit almost as well
  if (base === 'rmoon') return { type: 'uniform', a: 0, b: r(Math.max(0.05, 2.5 * v)) };
  if (MOON_FIELDS.includes(base)) return { ...(MOON_PARAMS.find((p) => p.key === base) || {}).prior };
  if (base === 'fpfs') return { type: 'uniform', a: 0, b: r(Math.max(0.05, 3 * v)) };
  if (PHASE_BY_KEY[base]) return { ...PHASE_BY_KEY[base].prior };
  if (base === 'rvlin') return { type: 'uniform', a: -0.1, b: 0.1 };
  if (base === 'secosw' || base === 'sesinw') return { type: 'uniform', a: r(Math.max(-1, v - 0.3)), b: r(Math.min(1, v + 0.3)) };
  if (base === 'rvquad') return { type: 'uniform', a: -1e-3, b: 1e-3 };
  if (base === 'jit') { const ds = S.rv[Number(key.slice(6)) - 1], e = ds ? Float64Array.from(ds.e).sort()[ds.e.length >> 1] : 5; return { type: 'uniform', a: 0, b: r(Math.max(15, 5 * e)) }; }
  if (base === 'jitlc') { const e = S.data && S.data.e && S.data.e.length ? Float64Array.from(S.data.e).sort()[S.data.e.length >> 1] * 1e6 : 1000; return { type: 'uniform', a: 0, b: r(Math.max(500, 3 * e)) }; }
  if (base === 'dil') return { type: 'uniform', a: 0, b: r(Math.max(1, 3 * v)) };
  if (base === 'vsini') return { type: 'uniform', a: 0, b: r(Math.max(20, 3 * v)) };
  if (base === 'lambda') return { type: 'uniform', a: -180, b: 180 };
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
    default: {
      if (S.ldLaw === 'kipping') return { type: 'uniform', a: 0, b: 1 };
      const est = /^ld[0-3]$/.test(base) ? ldPriorRange(Number(base[2]), v) : null;
      if (est) return { type: 'uniform', a: r(est.lo), b: r(est.hi), from: est.note };
      return { type: 'uniform', a: r(v - 0.3), b: r(v + 0.3) };
    }
  }
}
function resetPriors(keys) { for (const k of keys) S.priors[k] = defaultPrior(k); }

// ---- data ---------------------------------------------------------------------

/** Median spacing of the points, in minutes, taken inside each epoch (gaps between nights do not count). */
function cadenceMin(d) {
  const dt = []; for (let i = 1; i < d.t.length; i++) if (!d.epoch || d.epoch[i] === d.epoch[i - 1]) { const x = d.t[i] - d.t[i - 1]; if (x > 0) dt.push(x); }
  if (!dt.length) return 0;
  dt.sort((a, b) => a - b); return dt[dt.length >> 1] * 1440;
}
/**
 * Replace the light curve with a simulated one. keepRef: stay on the calendar of what was loaded (times relative to its
 * BJD reference, so T mid stays a BJD), as the Data tab's button and the API do; the built-in presets start undated.
 */
function makeSynthetic(keepRef = false) {
  const o = S.synth;
  const wasMulti = !!(S.data && S.data.epoch), ref = keepRef && S.data && S.data.tRef > 0 ? S.data.tRef : 0;
  S.data = synthesize(cur(S.values), S.ldLaw, { ...o, k: S.values.a2 });
  if (ref) S.data = { ...S.data, tRef: ref, notes: [...(S.data.notes || []), `times shown as BJD − ${ref}`] };
  S.dataId++; S.fit = null; S.raw = null; S.range = 'full'; S.fold = !!S.data.epoch;
  S.exptimeMin = S.data.exptimeMin;
  if (!S.data.airmass) S.free.a2 = false;
  // every simulated night has the same extinction slope, so that is the truth for each epoch's coefficient
  for (const p of actParams()) if (p.key.startsWith('a2@')) S.values[p.key] = S.values.a2;
  ensureEpochParams(); if (wasMulti !== !!S.data.epoch) resetPriors(['per']);
  S.truth = { ...S.values, teff: S.star.teff, feh: S.star.feh };
}
/** A dataset with its systematics model (regressors, kernel) rebuilt for its own points, when it carries detrending columns. */
const detrended = (d) => (d && d.columns ? applyDetrend(d, d.detrend || null) : d);
function setData(d, keepEpoch) {
  d = detrended(d);
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
  setData(d, true); S.raw = null; S.exptimeMin = cadenceMin(d);
  const segs = epochList(d), c = cur(S.values), tm = c.tmid, pad = 0.25 * c.per;
  const sg = segs.find((x) => tm >= x.t0 - pad && tm <= x.t1 + pad) || segs[segs.length >> 1];
  S.values[PK('tmid')] = nearestEpoch(tm, c.per, [sg.t0, sg.t1]);
  resetPriors([PK('tmid'), PK('per')]); S.t = S.values[PK('tmid')];
  buildPanels(); refresh(true);
}
function addEpochText(text, name, msgEl) {
  try {
    const p = readLightCurve(text, name, { time: 'auto', flux: 'auto' });
    const d = combineEpochs([S.data, p]);
    pushUndo(); setEpochData({ ...d, name: `${S.name} · ${d.segments.length} epochs` });
    flash(`Epoch added: ${d.segments.length} in total`);
  } catch (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--bad)'; } else throw err; }
}

/**
 * Install an edited copy of the loaded light curve (points removed, trimmed, clipped or binned; src/ui/dataedit.js).
 * The system, the priors and T mid stay as they are. When the number of epochs changed, the per-epoch airmass
 * coefficients, which are keyed by position, start again from the shared value.
 */
function installData(d, exptimeMin) {
  pushUndo();
  const was = nEpochs();
  d = detrended(d);
  S.data = d; S.dataId++; S.fit = null; S.live = null; S.range = 'full'; S.raw = null;
  if (exptimeMin > 0) S.exptimeMin = exptimeMin;
  if (nEpochs() !== was) { for (const o of [S.values, S.free, S.priors]) for (const k of Object.keys(o)) if (k.startsWith('a2@')) delete o[k]; S.fold = !!d.epoch; }
  if (!d.airmass) S.free.a2 = false;
  ensureEpochParams();
  buildPanels(); refresh(true); flash('Light curve edited');
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
    pushUndo(); installRVSets(r.sets, r.notes);
  } catch (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--bad)'; } else throw err; }
}
/**
 * Put velocity sets ({ name, t (absolute days), v, e, source? }) next to the ones loaded, each its own dataset with its own
 * zero point and jitter. The caller has pushed the undo step. Returns the new sets as installed.
 */
function installRVSets(list, notes = []) {
  const hadLC = S.use.lc;
  let tRef = S.data.tRef || 0;
  const first = Math.min(...list.map((x) => x.t[0]));
  if (!tRef && first > 1e5) {
    // dated velocities next to an undated light curve (a built-in simulation): nothing ties its times to theirs, so it
    // is put on the velocities' calendar but cannot share their orbit; it stays out of the fit, and the user is told
    tRef = Math.floor(first); S.data = { ...S.data, tRef }; S.dataId++; S.use = { ...S.use, lc: false };
    notes = [...notes, 'the light curve has no dates, so it was left out of the fit: load a dated light curve, or look the planet up, for a joint fit'];
  }
  const taken = new Set(S.rv.map((x) => x.name));
  const sets = list.map((x) => { let nm = x.name, k = 2; while (taken.has(nm)) nm = `${x.name} ${k++}`; taken.add(nm); return { name: nm, t: Float64Array.from(x.t, (v) => v - (v > 1e5 ? tRef : 0)), v: x.v, e: x.e, ...(x.source ? { source: x.source } : {}) }; });
  const firstRV = !S.rv.length;
  S.rv = [...S.rv, ...sets]; S.use = { ...S.use, rv: true, lc: S.data.tRef > 0 ? hadLC : S.use.lc }; S.view = 'rv'; S.fit = null; S.range = 'full';
  ensureRVParams();
  if (firstRV) for (const p of actParams()) if (p.base === 'mplanet') S.free[p.key] = true;   // velocities are what measure the masses
  buildPanels(); refresh(true); flash(`${sets.length} velocity set${sets.length > 1 ? 's' : ''} added` + (notes.length ? ' · ' + notes.join('; ') : ''));
  try { for (const x of sets) projectHandle().addFile({ kind: 'rv', name: x.name, page: 'analyze', n: x.t.length, note: x.source ? x.source.reference : 'from a file' }); } catch { /* no project storage */ }
  return sets;
}

// ---- systematics: detrending columns, linear regressors, kernel (src/core/detrend.js, data.js applyDetrend) ------------
/**
 * The photometry page's hand-off carries, besides the light curve, its detector columns (centroids, sky, FWHM, PLD
 * fractions) by row time, and the detrending chosen there. They are put on the points the reader kept (alignColumns)
 * and the systematics model is built on them. Part of the light-curve load (no undo step of its own).
 */
function handoffDetrend(hnd) {
  if (!hnd.columns || !hnd.time || !S.data) return;
  const d = S.data, A = alignColumns(hnd.time, hnd.columns, Float64Array.from(d.t, (x) => x + (d.tRef || 0)));
  const notes = [...(d.notes || []), `${Object.keys(A.columns).length} detector columns from the photometry page on ${A.matched} of ${d.t.length} points`];
  if (hnd.comparison && hnd.comparison.choice) notes.push(`comparison stars: ${hnd.comparison.choice}${Array.isArray(hnd.comparison.weights) ? ` (weights ${hnd.comparison.weights.map((w) => Number(w).toFixed(2)).join(', ')})` : ''}`);
  S.data = applyDetrend({ ...d, columns: A.columns, notes }, hnd.detrend || null);
  S.dataId++; buildPanels(); refresh(true);
}
/** Change the systematics model of the light curve: { columns, poly, pld, kernel } or null. One undo step. */
function setDetrend(spec) {
  if (!S.data.columns) throw new Error('the light curve carries no detrending columns (centroids, sky, FWHM...): load a file with such columns, or send the light curve from the photometry page');
  pushUndo();
  S.data = applyDetrend(S.data, spec && (spec.columns?.length || spec.poly > 0 || spec.pld?.length || spec.kernel) ? spec : null);
  S.fit = null; S.range = 'full'; displayNorm = null; buildPanels(); refresh(true);
  return S.data.detrendInfo || { names: [], dropped: [], kernel: null };
}
/** The Data tab's Systematics block: which columns the light curve carries, which are in the baseline, which were dropped. */
function detrendBlock(el) {
  const d = S.data; if (!d.columns) return;
  const names = Object.keys(d.columns), spec = d.detrend || { columns: [], poly: 0, pld: [], kernel: null }, info = d.detrendInfo;
  const lin = names.filter((nm) => !/^pld\d+$/.test(nm)), pld = names.filter((nm) => /^pld\d+$/.test(nm));
  const extra = ['xc', 'yc'].every((nm) => names.includes(nm)) ? ['xy', 'xc2', 'yc2'] : [];
  const ck = (nm, on) => { const c = h('input', { type: 'checkbox', checked: on, 'data-col': nm }); return h('label', { class: 'tog', title: DETREND_COLUMNS[nm] || nm }, c, nm); };
  const polySel = h('select', { 'aria-label': 'Time polynomial' }, [0, 1, 2, 3].map((k) => h('option', { value: k, selected: (spec.poly || 0) === k }, k ? `order ${k}` : 'none')));
  const pldBox = h('input', { type: 'checkbox', checked: !!(spec.pld && spec.pld.length) }), kBox = h('input', { type: 'checkbox', checked: !!spec.kernel });
  const feats = ['xc', 'yc', 'fwhm'].filter((nm) => names.includes(nm)), nb = h('input', { type: 'number', min: 5, max: 500, step: 5, value: (spec.kernel && spec.kernel.neighbors) || 50, 'aria-label': 'Kernel neighbours' });
  const box = h('div', { class: 'grid2' }, ...[...lin, ...extra].map((nm) => ck(nm, (spec.columns || []).includes(nm))));
  const msg = h('p', { class: 'note' });
  const apply = () => {
    const cols = [...box.querySelectorAll('input[data-col]')].filter((c) => c.checked).map((c) => c.dataset.col);
    try { setDetrend({ columns: cols, poly: Number(polySel.value), pld: pldBox.checked ? pld : [], kernel: kBox.checked && feats.length ? { features: feats, neighbors: Number(nb.value) || 50 } : null }); flash('Systematics model changed'); }
    catch (err) { msg.textContent = err.message; msg.style.color = 'var(--bad)'; }
  };
  el.append(...[h('h3', {}, 'Systematics'), h('p', { class: 'note' }, `Columns with the light curve: ${names.join(', ')}. Ticked ones join the baseline as linear terms, each with its own coefficient per epoch, integrated out like a₁ (flat priors).`), box,
    h('div', { class: 'field' }, h('span', {}, 'Time polynomial'), polySel),
    pld.length ? h('label', { class: 'tog', title: 'Pixel-level decorrelation (Deming et al. 2015): the principal components of the pixel fractions' }, pldBox, `PLD components (${pld.length})`) : null,
    feats.length ? h('div', { class: 'btnrow' }, h('label', { class: 'tog', title: 'Nearest-neighbour kernel regression on the detector position (EXOTIC; Knutson et al. 2012): the systematic of each point is a Gaussian-weighted mean of data / model over its neighbours, built night by night' }, kBox, `Kernel on ${feats.join(', ')}`), h('span', { class: 'note' }, 'neighbours'), nb) : null,
    h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: apply }, 'Apply'), h('button', { class: 'chip small', onclick: () => { try { setDetrend(null); } catch (err) { msg.textContent = err.message; } } }, 'none')), msg].filter(Boolean));
  if (info) {
    const coeffs = model && model.det && model.det.regCoeffs ? model.det.regCoeffs : null;
    el.append(h('p', { class: 'note' + (info.dropped.length ? ' callout warn' : ''), html: `In the baseline: <b>${info.names.length ? info.names.join(', ') : 'no linear terms'}</b>${info.kernel ? `; kernel on <b>${info.kernel.join(', ')}</b>` : ''}.` + (info.dropped.length ? ` Left out: ${info.dropped.map((x) => `${x.name} (${x.why})`).join('; ')}.` : '')
      + (coeffs && info.names.length ? ` Coefficients at the model on screen${coeffs.length > 1 ? ' (epoch 1)' : ''}: ${info.names.map((nm, k) => `${nm} ${(coeffs[0][k] * 1e6).toFixed(0)} ppm`).join(', ')} per standard deviation of the column.` : '')
      + (info.kernel ? ' A fit with the kernel conditions on the data themselves: its ln Z cannot be compared with a fit without it.' : '') }));
  }
}

// ---- radial velocities from the archives (src/core/rvsources.js) -------------------------------------------------
/** Text of a URL, with a time limit; the archives answer within seconds or not at all. */
/** A velocity archive's answer as text; an outage is reported by the site's network notice (src/site/net.js) and thrown, so the mirror loop tries the next. */
const fetchArchive = (url) => fetchOr(url, { what: 'VizieR (radial velocities)', as: 'text', timeout: 30000 });
const rvSetId = (src, set) => `${src.id}:${set.name}`;
/** The sets a search found, one row each, in the form the API returns them. */
function rvSearchRows(R = S.rvSearch) {
  if (!R || !R.results) return [];
  const have = new Set(S.rv.filter((x) => x.source).map((x) => `${x.source.source}:${x.source.set}`));
  return R.results.flatMap((r) => r.sets.map((x) => ({ id: rvSetId(r.source, x), source: r.source.id, catalog: r.source.catalog, label: r.source.label, instrument: x.instrument, set: x.name, points: x.n, first: x.t0, last: x.t1, span_days: x.span, median_error: x.medErr,
    star: r.star, separation_arcsec: r.sep, reference: r.source.reference, bibcode: r.source.bibcode, doi: r.source.doi, same_as: r.source.sameAs || null, added: have.has(rvSetId(r.source, x)) })));
}
/**
 * Search the archives for the system on show (or for `name`, looked up in the catalogue without loading it).
 * Keeps the result in S.rvSearch for the Data tab and returns { star, ra, dec, sets, sources }.
 */
async function findArchiveRV(name) {
  let pos, label = name || S.name;
  if (name && hostKey(name) !== hostKey(S.name)) {
    if (!catalogIndex) catalogIndex = await loadIndex(fetchCatalog);
    const L = await lookupHost(catalogIndex, name, fetchCatalog);
    if (!L || !Number.isFinite(L.system.ra)) throw new Error(`${name} is not in the catalogue snapshot, so its position is not known`);
    pos = { ra: L.system.ra, dec: L.system.dec }; label = L.host;
  } else {
    pos = await hostPosition();
    if (!pos) throw new Error(`the position of ${S.name} is not known: type its RA and Dec on the System tab (Position and magnitudes), or look the planet up from the Start page`);
  }
  S.rvSearch = { name: label, busy: true, ...pos }; if ($('#tab-data')) buildDataTab();
  const results = await searchRVArchives({ ra: pos.ra, dec: pos.dec, fetchText: fetchArchive });
  S.rvSearch = { name: label, ...pos, at: new Date().toISOString(), results, forSystem: hostKey(label) === hostKey(S.name) };
  if ($('#tab-data')) buildDataTab();
  return { star: label, ra: pos.ra, dec: pos.dec, sets: rvSearchRows(), sources: results.map((r) => ({ source: r.source.id, label: r.source.label, status: r.status, star: r.star || null, message: r.message || '', mirror: r.mirror || null, notes: r.notes })) };
}
/** Add archive sets by id (rvSearchRows ids) as velocity datasets, with their provenance. One undo step. */
function addArchiveRV(ids) {
  const R = S.rvSearch;
  if (!R || !R.results) throw new Error('search the archives first (findRadialVelocities)');
  if (!R.forSystem || hostKey(R.name) !== hostKey(S.name)) throw new Error(`the last search was for ${R.name}, not ${S.name}: load that system first, or search again`);
  const want = [].concat(ids), found = [], rows = rvSearchRows();
  for (const id of want) {
    const r = R.results.find((x) => x.sets.some((y) => rvSetId(x.source, y) === id)); if (!r) throw new Error(`there is no set “${id}” in the last search; the sets are ${rows.map((x) => x.id).join(', ') || 'none'}`);
    const row = rows.find((x) => x.id === id); if (row.added) throw new Error(`${id} is already loaded`);
    found.push({ r, set: r.sets.find((y) => rvSetId(r.source, y) === id) });
  }
  // the same observations published twice (HIRES in Butler 2017 and Tal-Or 2019) must not enter a fit together
  const loaded = new Set(S.rv.filter((x) => x.source).map((x) => x.source.source)), picked = new Set(found.map((f) => f.r.source.id));
  for (const f of found) { const twin = f.r.source.sameAs; if (twin && (loaded.has(twin) || picked.has(twin))) throw new Error(`${f.r.source.label} and ${sourceById(twin).label} hold the same observations: add only one of them`); }
  pushUndo();
  return installRVSets(found.map(({ r, set }) => ({ name: set.name, t: set.t, v: set.v, e: set.e, source: set.provenance })), [...new Set(found.flatMap((f) => f.r.notes))]);
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
  S.planets = sess.planets.map((p) => ({ sfx: sfxOf(p.letter), letter: p.letter })); S.pl = ''; S.kepler = !!sess.kepler; S.phase = sess.phase ? { ...sess.phase } : null;
  // one time reference for everything: the light curve's, or the day of the earliest date in the session
  const dates = [...sess.rv.map((d) => d.t[0]), ...sess.timing.map((r) => r.t), ...sess.planets.map((p) => p.values.tmid)].filter((x) => x > 1e5);
  const tRef = sess.lc ? sess.lc.tRef || 0 : Number.isFinite(sess.tRefHint) && sess.tRefHint > 0 ? sess.tRefHint : dates.length ? Math.floor(sess.rv.length ? Math.min(...sess.rv.map((d) => d.t[0])) : sess.planets[0].values.tmid) : 0;
  const rel = (t) => (t > 1e5 ? t - tRef : t);
  const values = { ld0: 0, ld1: 0, ld2: 0, ld3: 0, a2: 0, ...(sess.extra || {}) };
  for (const p of sess.planets) for (const [f, v] of Object.entries(p.values)) values[planetKey(f, sfxOf(p.letter))] = f === 'tmid' ? rel(v) : v;
  S.values = values; S.ldProfile = null; S.ldMsg = ''; S.ldMode = 'coeffs'; S.starMsg = '';
  if (sess.ld) sess.ld.forEach((c, i) => (values['ld' + i] = c));
  else { const r = ldFromStar(S.star.teff, S.star.feh); r.coeffs.forEach((c, i) => (values['ld' + i] = Number(c.toFixed(5)))); S.ldProfile = r.prof || null; }
  // data: the session's light curve, or one simulated from the first planet as a stand-in
  S.synth = { kind: 'synthetic', exptimeMin: 2, noisePpm: 500, baselineHr: 2, airmass: false, seed: 1 };
  if (sess.lc) { S.data = detrended(sess.lc); S.exptimeMin = sess.exptimeMin ?? cadenceMin(sess.lc); }
  else {
    const d = synthesize(planetValues(values, ''), S.ldLaw, S.synth);
    // the stand-in follows the whole model: where another planet transits during this window, it shows
    const others = S.planets.slice(1).map((p) => { try { return makeTransit(toTransitParams(planetValues(values, p.sfx), S.ldLaw)); } catch { return () => 1; } });
    const f = others.length ? Float64Array.from(d.f, (x, i) => others.reduce((m, g) => m * g(d.t[i]), x)) : d.f;
    S.data = { ...d, f, tRef, name: 'Simulated light curve (stand-in)' }; S.exptimeMin = d.exptimeMin;
  }
  S.dataId++; S.raw = null; S.fit = null; S.live = null; S.range = 'full';
  S.rv = sess.rv.map((d) => ({ name: d.name, t: Float64Array.from(d.t, rel), v: d.v, e: d.e, ...(d.source ? { source: { ...d.source } } : {}) }));
  S.nbody = sess.nbody && Number.isFinite(sess.nbody.epoch) ? { ...sess.nbody, epoch: rel(sess.nbody.epoch) } : null;
  S.timing = { rows: sess.timing.map((r) => ({ t: r.t, e: r.e, epoch: null, kind: r.kind || 'transit', planet: sfxOf(r.planet || first), src: r.src || '' })), order: sess.timingOrder || 1, text: '' };
  S.use = { lc: true, rv: false, timing: false, ...sess.use }; S.view = sess.view || 'lc'; S.fold = sess.fold ?? !!S.data.epoch;
  S.free = {}; S.priors = {};
  ensureEpochParams(); ensureRVParams();
  const act = fitParams(), want = new Set(sess.free.map(scoped));
  for (const prm of act) S.free[prm.key] = want.has(prm.key);
  resetPriors([...act.map((x) => x.key), 'teff', 'feh', 'mstar', 'rstar']);
  for (const [k, pr] of Object.entries(sess.priors || {})) S.priors[k] = k.split('@')[0] === 'tmid' ? { ...pr, a: rel(pr.a), ...(pr.type === 'uniform' ? { b: rel(pr.b) } : {}) } : { ...pr };
  S.truth = sess.truth ? { ...values, teff: S.star.teff, feh: S.star.feh, ...sess.truth } : null;
  S.sources = sess.sources || null; S.note = sess.note || ''; if (sess.candidate) S.title = sess.title;
  S.t = values.tmid;
  const ps = $('#preset'); let opt = ps.querySelector('option[value=session]'); if (!opt) { opt = h('option', { value: 'session' }); ps.append(opt); } opt.textContent = sess.title || sess.name; ps.value = 'session';
  buildPanels(); refresh(true); showTab(sess.tab || 'system');
}
/** A worked example: a built-in preset with adjustments, or a session read from public/examples. */
const exTitle = (ex) => ex.title;
/**
 * The photometry page's light curve. Prepared transit windows (hnd.epochs, a CSV column "epoch" indexing
 * hnd.epochs.names) arrive as one epoch each, so every window gets its own baseline; otherwise one light curve.
 */
function loadHandoffText(hnd) {
  const name = hnd.name || 'Light curve from photometry', lines = String(hnd.text).split(/\r?\n/);
  const hi = hnd.epochs && Array.isArray(hnd.epochs.names) ? lines.findIndex((l) => l.trim() && !/^[#%!]/.test(l.trim()) && /[a-z]/i.test(l)) : -1;
  const head = hi >= 0 ? lines[hi].split(',').map((c) => c.trim().toLowerCase()) : [], ce = head.indexOf('epoch');
  if (ce < 0) { loadText(hnd.text, name, null); return; }
  const pre = lines.slice(0, hi + 1).join('\n'), groups = new Map();
  for (const l of lines.slice(hi + 1)) { if (!l.trim() || /^[#%!]/.test(l.trim())) continue; const k = l.split(',')[ce]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const keys = [...groups.keys()].sort((a, b) => Number(a) - Number(b));
  if (keys.length < 2) { loadText(hnd.text, name, null); return; }
  keys.forEach((k, i) => { const txt = pre + '\n' + groups.get(k).join('\n'), nm = hnd.epochs.names[Number(k)] || `${name} ${i + 1}`; if (i === 0) loadText(txt, nm, null); else addEpochText(txt, nm, null); });
}

/** Load a worked example, then show what it teaches (src/learn/explain.js) over the 3D view. */
async function loadExample(ex, fresh = false) { await loadExampleData(ex, fresh); showExplain(ex.id); }
let explainEl = null;
function showExplain(id) {
  if (explainEl) { explainEl.remove(); explainEl = null; }
  try { if (localStorage.getItem('esl.explain.off') === '1') return; } catch { /* storage unavailable */ }
  import('./learn/explain.js').then(({ explainCard }) => {
    const card = explainCard(id, { api: window.__esl && window.__esl.api, h, onClose: () => { card.remove(); explainEl = null; } });
    if (!card) return;
    const host = document.getElementById('stage') || document.body; card.classList.add('ex-float'); host.append(card); explainEl = card;
  }).catch(() => { /* the card is optional */ });
}
async function loadExampleData(ex, fresh = false) {
  // a stored session with its posterior (tools/build_example_results.py) opens instantly and shows the whole workflow
  if (!fresh) { try { const doc = JSON.parse(await fetchText(`examples/results/${ex.id}.json`)); importSession(doc, { title: exTitle(ex) }); const note = ex.note || (ex.preset ? `${ex.title}: ${ex.sub}.` : doc.notes || ''); S.note = (note ? note + ' ' : '') + 'This example opens with the posterior from a stored run; press Run on the Fit tab to sample it again here.'; buildPanels(); return; } catch { /* no stored result: build the example from its data */ } }
  if (ex.sessionFile) { let doc = JSON.parse(await fetchText(ex.sessionFile)); if (ex.adjust) doc = ex.adjust(doc); importSession(doc, { title: ex.title }); showTab((doc.ui && doc.ui.tab) || 'fit'); return; }
  if (ex.load) { const sess = await ex.load(fetchText, { catalogSession }); applySession({ ...sess, title: exTitle(ex) }); return; }
  if (S.running) stopFit();
  pushUndo(); $('#preset').value = ex.preset; loadPreset(ex.preset);
  if (ex.synth) { Object.assign(S.synth, ex.synth); makeSynthetic(); S.t = cur(S.values).tmid; }
  if (ex.free) { for (const prm of fitParams()) if (prm.group === 'planet') S.free[prm.key] = ex.free.includes(prm.key); }
  S.note = `${ex.title}: ${ex.sub}.`;
  buildPanels(); refresh(true); showTab('fit');
}
// the site root, from the page's <meta name="esl-root">: data folders (catalog/, examples/) hang off it
const ROOT = new URL((document.querySelector('meta[name=esl-root]') || {}).content || './', document.baseURI);
/** A session for a named planet or host from the catalog snapshot (the same thing the start page builds). */
let catalogIndex = null;
async function catalogSession(name, kinds) {
  if (!catalogIndex) catalogIndex = await loadIndex(fetchCatalog);
  const L = await lookupHost(catalogIndex, name, fetchCatalog);
  if (!L || !L.rows || !L.rows.length) {
    // not a known planet: a TESS candidate (TOI-1234.01) from the TOI snapshot, clearly labelled as one
    if (parseTOIName(name)) { const sess = await toiSession(name); if (sess) return sess; throw new Error(`${name} is not in the TOI snapshot`); }
    throw new Error(`${name} is not in the catalog snapshot`);
  }
  // keep only the named planet when one was asked for
  const rows = L.planet ? L.rows.filter((r) => r.pl_name === L.planet) : L.rows;
  return sessionFromCatalog(systemFromRows(rows, { use: kinds.length === 1 ? kinds[0] : 'all' }), kinds, L.snapshot || catalogIndex.date, L.system);
}
/** Position and 2MASS magnitudes of a host from the catalogue's system record (for archive searches, time conversion, TSM, ESM). */
function hostExtras(sy = {}) {
  const o = {}, put = (k, v, d) => { if (Number.isFinite(v)) o[k] = Number(v.toFixed(d)); };
  put('ra', sy.ra, 7); put('dec', sy.dec, 7); put('jmag', sy.sy_jmag, 3); put('kmag', sy.sy_kmag, 3);
  return o;
}
/**
 * The host's J2000 position: from the star (catalogue look-up or typed on the System tab), else looked up by the
 * system's name in the catalogue snapshot (and kept on the star). Resolves { ra, dec } or null.
 */
async function hostPosition() {
  if (Number.isFinite(S.star.ra) && Number.isFinite(S.star.dec)) return { ra: S.star.ra, dec: S.star.dec };
  try {
    if (!catalogIndex) catalogIndex = await loadIndex(fetchCatalog);
    const L = await lookupHost(catalogIndex, S.name, fetchCatalog);
    if (!L || !Number.isFinite(L.system.ra)) return null;
    const x = hostExtras(L.system); for (const k of ['ra', 'dec', 'jmag', 'kmag']) if (x[k] !== undefined && !Number.isFinite(S.star[k])) S.star[k] = x[k];   // facts about the star, not a user change
    return { ra: S.star.ra, dec: S.star.dec };
  } catch { return null; }
}
/** A TOI as a candidate system (src/ui/intro.js sessionFromTOI), from the TOI snapshot that Plan and Observe read. */
let toiRecords = null;
async function toiSession(name) {
  if (!toiRecords) { const j = await siteJson(new URL(TOI_SOURCE.file, ROOT), 'The TOI snapshot'); toiRecords = { ...TOI_SOURCE.records(j), date: j.date }; }
  return sessionFromTOI(toiRecords.records, name, toiRecords.date);
}
const fetchText = (path) => fetchOr(new URL(path, ROOT).href, { what: path, as: 'text' });
const fetchCatalog = (name) => siteJson(new URL('catalog/' + name, ROOT), "The site's catalogue");

// ---- sessions as documents: export, import, local saves (docs/FORMAT.md) -----------------------------------
const SOFTWARE = { name: 'exoplanet-science-lab', version: '0.2.0', commit: null };

/** The whole analysis as an ESL session document: system, data, priors, sampler and, when there is one, the fit. */
function exportSession(withResult = true) {
  const tRef = S.data.tRef || 0, d = S.data, isT = (k) => baseKey(k) === 'tmid';
  const absPrior = (k, p) => (isT(k) ? (p.type === 'uniform' ? { ...p, a: p.a + tRef, b: p.b + tRef } : { ...p, a: p.a + tRef }) : { ...p });
  const planetKeys = new Set(S.planets.flatMap((p) => [...PLANET_FIELDS.map((f) => planetKey(f, p.sfx)), ...MOON_FIELDS.map((f) => moonKey(f, p.sfx)), ...PHASE_FIELDS.map((f) => planetKey(f, p.sfx))]));
  const fixed = {}; for (const [k, v] of Object.entries(S.values)) if (!planetKeys.has(k) && !/^ld\d$/.test(k) && Number.isFinite(v)) fixed[k] = v;
  const act = fitParams(), free = act.filter((p) => S.free[p.key]).map((p) => ({ key: p.key, label: p.label, unit: p.unit || '', prior: absPrior(p.key, S.priors[p.key]) }));
  const priors = {}; for (const [k, p] of Object.entries(S.priors)) if (p && Number.isFinite(p.a)) priors[k] = absPrior(k, p);
  const doc = {
    format: FORMAT, version: FORMAT_VERSION, software: SOFTWARE, created: new Date().toISOString(),
    name: S.name, title: S.title || planetLabel(), notes: S.note || '',
    star: { ...S.star },
    limb_darkening: { law: S.ldLaw, mode: S.ldMode, band: S.band, band_custom: [...S.bandCustom], coefficients: LD_LAWS[S.ldLaw].names.map((_, i) => S.values['ld' + i]) },
    planets: S.planets.map((p) => { const prm = {}, pq = usesSqrtE(p.sfx) ? planetValues(S.values, p.sfx) : null; for (const f of PLANET_FIELDS) { const v = pq && (f === 'ecc' || f === 'omega') ? pq[f] : S.values[planetKey(f, p.sfx)]; if (Number.isFinite(v)) prm[f] = f === 'tmid' ? v + tRef : v; } for (const f of MOON_FIELDS) { const v = S.values[moonKey(f, p.sfx)]; if (Number.isFinite(v)) prm[f] = v; } if (hasPhase(p.sfx)) for (const f of PHASE_FIELDS) { const v = S.values[planetKey(f, p.sfx)]; if (Number.isFinite(v)) prm[f] = v; } return { letter: p.letter, parameters: prm }; }),
    ...(S.phase ? { phase: phaseSpec() } : {}), ...(S.nbody ? { nbody: { ...S.nbody, epoch: S.nbody.epoch + tRef } } : {}),
    kepler: S.kepler, time_reference: tRef,
    data: {
      light_curve: { name: d.name, time: Array.from(d.t, (x) => x + tRef), flux: Array.from(d.f), flux_err: Array.from(d.e), airmass: d.airmass ? Array.from(d.airmass) : null, exposure_min: S.exptimeMin,
        epoch: d.epoch ? Array.from(d.epoch) : null, epochs: d.epoch ? d.segments.map((sg) => ({ name: sg.name, airmass: !!sg.airmass, ...(sg.exptime > 0 ? { exposure_min: sg.exptime * 1440 } : {}) })) : [], synthetic: !!d.synthetic, notes: d.notes || [],
        ...(d.columns ? { columns: Object.fromEntries(Object.entries(d.columns).map(([nm, a]) => [nm, Array.from(a, (x) => (Number.isFinite(x) ? x : null))])), detrend: d.detrend ? clone(d.detrend) : null } : {}) },
      radial_velocity: S.rv.map((r) => ({ name: r.name, time: Array.from(r.t, (x) => x + tRef), velocity: Array.from(r.v), velocity_err: Array.from(r.e), ...(r.source ? { source: { ...r.source } } : {}) })),
      timing: S.timing.rows.map((r) => ({ planet: (S.planets.find((p) => p.sfx === (r.planet || '')) || S.planets[0]).letter, kind: r.kind || 'transit', time: r.t, err: r.e, source: r.src || '' })),
    },
    fit: { use: { lc: S.use.lc, rv: rvOn(), timing: S.use.timing && S.timing.rows.length > 0 }, free, fixed, priors, timing_noise: 0, sampler: { ...S.sampler } },
    ui: { planet: S.pl, view: S.view, fold: S.fold, all_planets: S.allPlanets, plot: { ...S.plot }, timing_order: S.timing.order, truth: S.truth ? { ...S.truth } : null, preset: S.preset },
    result: null,
  };
  if (withResult && S.fit) {
    const F = S.fit, r = F.res, n = Math.min(1500, Math.max(300, Math.round(r.ess || 1000))), idx = resampleIndices(r.weights, n, makeRng(3));
    doc.result = {
      logZ: r.logZ, logZerr: r.logZerr, information: r.H, ess: r.ess, ncalls: r.ncalls, seconds: r.elapsed, converged: r.stopReason === 'converged', stop_reason: r.stopReason, warnings: r.warnings || [],
      parameters: F.summary.map((x) => ({ key: x.key, label: x.label, unit: x.unit || '', median: x.med + (isT(x.key) ? tRef : 0), plus: x.plus, minus: x.minus, best: x.best + (isT(x.key) ? tRef : 0) })),
      derived: Object.fromEntries(Object.entries(F.derived).filter(([, q]) => q).map(([k, q]) => [k, { median: q.med + (['tmid', 'emid', 'tperi'].includes(baseKey(k)) ? tRef : 0), plus: q.plus, minus: q.minus }])),
      chi2: F.chi2, chi2_parts: F.parts ? { light_curve: F.parts.lc, radial_velocity: F.parts.rv, timing: F.parts.timing } : null, n_data: F.N, bic: F.ic.bic,
      rv_zero_points: (F.rvFit || []).map((x) => ({ name: x.name, gamma: x.gamma, jitter: x.jitter })),
      // enough to redraw the posterior: equal-weight draws in the sampler's own coordinates (times relative to time_reference)
      samples: { keys: F.free.map((f) => f.key), values: Array.from(idx, (i) => Array.from({ length: r.ndim }, (_, k) => r.samples[i * r.ndim + k])), logl: Array.from(idx, (i) => r.logl[i]) },
      sampler_state: { nlive: r.nlive, insertion_p: r.insertionP, max_point: Array.from(r.maxPoint), mode: r.mode || null },
    };
  }
  return doc;
}

/** Load a session document: the system and data through applySession, then the stored posterior if it has one. */
function importSession(doc, { title } = {}) {
  validateSession(doc);
  const L = doc.data.light_curve, tRef = doc.time_reference || 0, ld = doc.limb_darkening || {};
  let lc = null;
  if (L && L.time.length) {
    lc = { name: plainName(L.name || 'Light curve'), tRef, t: Float64Array.from(L.time, (x) => x - tRef), f: Float64Array.from(L.flux), e: Float64Array.from(L.flux_err), airmass: L.airmass ? Float64Array.from(L.airmass) : null, notes: L.notes || [], synthetic: !!L.synthetic,
      ...(L.columns ? { columns: Object.fromEntries(Object.entries(L.columns).map(([nm, a]) => [nm, Float64Array.from(a, (x) => (x === null ? NaN : x))])), detrend: L.detrend || null } : {}) };
    if (L.epoch && L.epochs && L.epochs.length > 1) {
      lc.epoch = Int32Array.from(L.epoch);
      lc.segments = L.epochs.map((ep, k) => { let t0 = Infinity, t1 = -Infinity, c = 0; for (let i = 0; i < lc.t.length; i++) if (lc.epoch[i] === k) { c++; t0 = Math.min(t0, lc.t[i]); t1 = Math.max(t1, lc.t[i]); } return { name: ep.name, n: c, t0, t1, airmass: !!ep.airmass, ...(ep.exposure_min > 0 ? { exptime: ep.exposure_min / 1440 } : {}) }; });
    }
  }
  const ui = doc.ui || {}, fit = doc.fit, first = doc.planets[0].letter;
  applySession({
    name: doc.name, title: title || doc.title || doc.name, star: { ...doc.star }, ldLaw: ld.law === 'squareroot' ? 'sqrt' : ld.law || 'quadratic', ld: ld.coefficients || null, band: ld.band,
    planets: doc.planets.map((p) => ({ letter: p.letter, values: { ...p.parameters } })), kepler: !!doc.kepler, phase: doc.phase || null, nbody: doc.nbody || null, lc, exptimeMin: L ? L.exposure_min : undefined,
    rv: (doc.data.radial_velocity || []).map((r) => ({ name: r.name, t: Float64Array.from(r.time), v: Float64Array.from(r.velocity), e: Float64Array.from(r.velocity_err), ...(r.source ? { source: { ...r.source } } : {}) })),
    timing: (doc.data.timing || []).map((r) => ({ t: r.time, e: r.err, kind: r.kind, planet: r.planet || first, src: r.source })), timingOrder: ui.timing_order,
    extra: { ...(fit.fixed || {}) }, use: fit.use, free: fit.free.map((f) => f.key), priors: { ...(fit.priors || {}), ...Object.fromEntries(fit.free.map((f) => [f.key, f.prior])) },
    truth: ui.truth || null, view: ui.view, fold: ui.fold, tab: doc.result ? 'results' : 'fit', note: doc.notes || '', sources: doc.sources || null, tRefHint: tRef,
  });
  if (ld.mode === 'star') S.ldMode = 'star';
  if (ld.band_custom) S.bandCustom = [...ld.band_custom];
  if (fit.sampler) S.sampler = { ...S.sampler, ...fit.sampler };
  if (ui.plot) S.plot = { ...S.plot, ...ui.plot };
  S.allPlanets = !!ui.all_planets; if (ui.planet && S.planets.some((p) => p.sfx === ui.planet)) S.pl = ui.planet;
  S.title = doc.title || '';
  const R = doc.result;
  if (R && R.samples && R.samples.values.length) {
    // rebuild the run from its stored draws (equal weights), then let the ordinary end-of-fit path make the tables and plots
    const keys = R.samples.keys, nd = keys.length, n = R.samples.values.length, samples = new Float64Array(n * nd);
    R.samples.values.forEach((row, i) => row.forEach((x, k) => (samples[i * nd + k] = x)));
    const st = R.sampler_state || {}, act = fitParams(), isT = (k) => baseKey(k) === 'tmid';
    const free = keys.map((k) => { const p = act.find((x) => x.key === k) || { key: k, label: k, unit: '' }; return { key: k, label: p.label, unit: p.unit, prior: { ...S.priors[k] } }; });
    const res = { ndim: nd, n, samples, weights: new Float64Array(n).fill(1 / n), logl: Float64Array.from(R.samples.logl || new Array(n).fill(0)), logZ: R.logZ, logZerr: R.logZerr, H: R.information, ess: R.ess, ncalls: R.ncalls, elapsed: R.seconds || 0,
      stopReason: R.stop_reason || (R.converged ? 'converged' : 'stopped'), warnings: R.warnings || [], nlive: st.nlive || S.sampler.nlive, insertionP: st.insertion_p ?? 1, mode: st.mode, nplateau: 0,
      maxPoint: st.max_point ? Float64Array.from(st.max_point) : Float64Array.from(keys.map((k) => { const p = R.parameters.find((x) => x.key === k); return p.best - (isT(k) ? tRef : 0); })), keys, restored: true };
    UNDO.pop();   // loading is one step for undo, not two
    finishFit(res, free, (v) => v, null);
    $('#pstat').textContent = `Loaded with its posterior: ${R.ncalls} likelihood calls when it was run (${R.stop_reason || 'converged'}).`;
  }
  buildPanels(); refresh(true);
  return doc;
}
async function saveCurrent(name) {
  const doc = exportSession(true); if (name) doc.title = name;
  const meta = await saveExperiment(doc, { name: name || doc.title }); flash('Saved in this browser'); return meta;
}
async function openSaved(id) { const rec = await getExperiment(id); if (!rec) throw new Error('that saved analysis no longer exists'); importSession(rec.session, { title: rec.name }); flash('Opened ' + rec.name); }
const downloadSession = async () => saveFile(slug(S.name) + '_session.json', JSON.stringify(exportSession(true)));

/**
 * What scripts, the guided tour and the assistant drive the analyzer through (src/ui/api.js): the same actions the
 * panels perform, as functions that return plain data. This is what main.js lends that module.
 */
function makeAPI() {
  return createAPI({
    S, UNDO, EXAMPLES, pushUndo, undo, redo, buildPanels, buildFitTab, refresh, showTab,
    fitParams, allParams: actParams, paramValue, defaultPrior, baseKey, nEpochs, rvOn, hasMoon, hasPhase, phaseSpec, starNow, cur, planetValues,
    model: () => model, status: () => $('#pstat').textContent, progress: fitProgress,
    loadExample, applySession, catalogSession, ensureRVParams, setKepler, loadText, addEpochText, addRVText, makeSynthetic, installData, findArchiveRV, addArchiveRV, setDetrend, setSqrtE, usesSqrtE: () => usesSqrtE(),
    changeLaw, setLDMode, estimateLD, resyncLD: () => { syncStarLD.key = null; },
    addPlanetWith, removePlanet, addPhase, removePhase, setPhaseMode, addMoon, removeMoon, setMoonValues, setNbody, addCompanion, dyn: dynamicsApp,
    startFit, stopFit, restoreRun, setupJointFit, readBayes, runAlarms, systemRows, figure,
    exportSession, importSession, saveCurrent, listSaved: listExperiments, openSaved, deleteSaved: deleteExperiment,
  });
}

// ---- layout: the light curve and the side panel can be folded away (the tour starts with only the orbit) -----
function setLayout({ lc, panel, stage }) {
  const app = $('#app'), has = (c) => app.classList.contains(c);
  if (lc !== undefined) app.classList.toggle('no-lc', !lc);
  if (panel !== undefined) app.classList.toggle('no-panel', !panel);
  if (stage !== undefined) app.classList.toggle('no-stage', !stage);
  if (has('no-stage') && has('no-lc') && has('no-panel')) app.classList.remove(panel === false ? 'no-stage' : 'no-panel');   // never an empty page
  for (const [id, cls] of [['#tgstage', 'no-stage'], ['#tglc', 'no-lc'], ['#tgpanel', 'no-panel']]) { $(id).classList.toggle('on', !has(cls)); $(id).setAttribute('aria-pressed', String(!has(cls))); }
  const full = has('no-stage') && has('no-lc');   // the panel has the whole screen
  $('#panelmax').setAttribute('aria-pressed', String(full)); $('#panelmax').textContent = full ? '⤡' : '⤢';
  window.dispatchEvent(new Event('resize')); refresh();
  if (S.fit && S.fit.redraw) requestAnimationFrame(S.fit.redraw);
}

/** The first-visit walk through the analyzer: the orbit first, then the light curve, then the panel tab by tab. */
function runTour() {
  const tab = (name) => () => { setLayout({ lc: true, panel: true, stage: true }); showTab(name); };
  const steps = [
    { target: '#stage', place: 'auto', before: () => setLayout({ lc: false, panel: false, stage: true }), title: 'The system', text: 'This is the star and its planet, drawn to scale from the current parameters. Drag to look around, scroll to zoom. Everything else in this page is a different view of the same model.' },
    { target: '#viewseg', before: () => setLayout({ lc: false, panel: false, stage: true }), title: 'Three ways to look', text: '<b>Orbit</b> is a free camera. <b>From Earth</b> is what a telescope sees: the planet crossing the disc. <b>Top down</b> looks along the orbit’s axis. The <b>Look</b> menu changes the style and shows the habitable zone.' },
    { target: '#transport', title: 'Time', text: 'Play and pause, loop over the transit or the whole orbit, and set the rate: simulated time per second, from 30 s/s to 100 d/s. The clock shows the time from mid-transit and the orbital phase.' },
    { target: '#rec', title: 'Make a video', text: 'Rec records one pass of the animation with the plot below it. Pick the shape first: landscape for slides and video sites, portrait or square for social media.' },
    { target: '#lc', place: 'top', before: () => setLayout({ lc: true, panel: false, stage: true }), title: 'The data and the model', text: 'Points are the measurements, the line is the model, and the lower strip is their difference. Scroll to zoom, drag to pan, click to move the time. <b>Fold</b> stacks every transit; <b>View</b> changes point and model opacity, bins and colours; <b>Save figure</b> exports it.' },
    { target: () => $('#tab-system .row'), place: 'left', before: tab('system'), title: 'Change a parameter, watch the fit', text: 'Drag <b>Rp/R★</b>. The model moves against the data and the residuals update as you go; the data stay where they are. This is the fastest way to see what each parameter does to a light curve.' },
    { target: '#derived', place: 'left', before: tab('system'), title: 'What follows from the parameters', text: 'Impact parameter, duration, planet radius and the rest are recomputed live. Hover any of them for how it is calculated; some mark their point of the orbit in the view.' },
    { target: '.tabs [data-tab=data]', place: 'bottom', before: tab('data'), title: 'Data', text: 'Load your own light curve (drop a file or paste rows), add more nights as extra epochs, add radial velocities, or simulate an observation. Nothing leaves your computer.' },
    { target: '.tabs [data-tab=fit]', place: 'bottom', before: tab('fit'), title: 'Fit', text: 'Choose which data enter the fit, tick the parameters to fit and give each a prior. <b>Run nested sampling</b> explores them all at once and also measures the evidence for the model.' },
    { target: '#runbtn', place: 'left', before: tab('fit'), title: 'Run it', text: 'A single transit takes a second or two. The model on the plots follows the best point while it runs. You can stop early; the page will say what a stopped run can and cannot be used for.' },
    { target: '.tabs [data-tab=results]', place: 'bottom', before: tab('results'), title: 'Results', text: 'Fitted values with uncertainties, the full system table (click a row for how it was obtained), the posterior plot, diagnostics, and a comparison of your runs that says in words what the evidence supports.' },
    { target: '.tabs [data-tab=timing]', place: 'bottom', before: tab('timing'), title: 'Timing', text: 'A list of mid-transit times gives the ephemeris, the O − C diagram, a search for periodic timing variations, and the next transits with their uncertainty.' },
    { target: '#startbtn', place: 'bottom', before: tab('system'), title: 'Where to go next', text: '<b>Start</b> opens the worked examples and looks up any known planet. <b>Save</b> keeps an analysis in this browser. The bar at the very top leads to planning, the sky view, the catalogue and the validation page. The <b>?</b> button replays this tour.' },
  ];
  return startTour(steps, { label: 'Tour', onEnd: () => { setLayout({ lc: true, panel: true, stage: true }); try { localStorage.setItem('esl.tour.done', '1'); } catch { /* storage unavailable */ } } });
}

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
    setData({ name: plainName(D.name), tRef: D.tRef, t: Float64Array.from(D.t), f: Float64Array.from(D.f), e: Float64Array.from(D.e), airmass: null, notes: ['times shown as JD − ' + D.tRef, 'light curve from the sample data distributed with EXOTIC', 'the TESS aperture also contains HD 80607, which dilutes the transit: the fitted Rp/R★ and planet radius are about 30% too small'] }, true);
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
    ldLaw: S.ldLaw, free, exptime, supersample: supersampleFor(values), phase: S.phase ? phaseSpec() : null, nbody: S.nbody && S.planets.length > 1 ? { ...S.nbody } : null,
  };
}
/**
 * Model flux as a function of time, including exposure averaging: every planet's transit
 * multiplied together, or one planet alone (`only` = its suffix) for a plot folded on it.
 */
function fluxFunction(values, only) {
  const fs = [];
  for (const p of S.planets) { if (only !== undefined && p.sfx !== only) continue; try { fs.push(transitOf(values, p.sfx)); } catch { /* skip a planet with impossible geometry */ } }
  if (!fs.length) return () => 1;
  const f1 = fs.length === 1 ? fs[0] : (t) => { let m = 1; for (const g of fs) m *= g(t); return m; };
  // dilution by other light in the aperture, as buildProblem applies it: (model + d) / (1 + d)
  const dl = Number.isFinite(values.dil) ? values.dil : 0, f = dl ? (t) => (f1(t) + dl) / (1 + dl) : f1;
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
  // The data are drawn divided by a baseline that does NOT follow the sliders: the normalisation of each epoch
  // is frozen at the value it had when the data were loaded or the last fit finished (displayNorm), so moving
  // the depth or the inclination moves the model and the residuals, not the points. The likelihood itself
  // still integrates the normalisation out for every model.
  if (det) {
    if (!displayNorm || displayNorm.dataId !== S.dataId || displayNorm.a1s.length !== det.a1s.length) displayNorm = { dataId: S.dataId, a1s: det.a1s.slice() };
    let ss = 0;
    for (let i = 0; i < n; i++) { const k = d.epoch ? d.epoch[i] : 0; base[i] *= displayNorm.a1s[k] / det.a1s[k]; ss += (d.f[i] / base[i] - tr[i]) ** 2; }
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
  syncDefaultRate(values);
  // folded on one planet of several: that planet's model alone (the others are divided out of the data)
  const flux = fluxFunction(all, S.fold && many ? S.pl : undefined), depth = 1 - fluxFunction(all, S.pl)(values.tmid);
  const hz = S.hz ? hzProfile({ teff: st.teff, teffErr: st.teffErr || 0, albedo: S.albedo }) : null;
  // a planet's brightness map from its phase-curve or eclipse-map parameters (the values on show: the best fit after a fit,
  // the live draw while sampling), drawn on the planet in the 3D view so that the animation and a recorded movie show it
  const mapOf = (sfx) => planetTexture(all, sfx);
  // a planet's moon as the system view takes it (the model's own parameters), or null
  const moonOf = (sfx, q) => { if (!hasMoon(sfx, all)) return null; const m = moonParamsFrom(all, sfx, { mplanet: q.mplanet, mstar: all.mstar ?? st.mstar }); return m ? { ...m, rprs: q.rprs } : null; };
  if (viz) viz.setSystem({ el, rprs: values.rprs, claret, teff: all.teff ?? st.teff, rm: hasOpt('vsini', all) && all.vsini > 0 ? { vsini: all.vsini, lambda: all[planetKey('lambda', S.pl)] ?? all.lambda ?? 0 } : null, name: planetLabel(), look: cls.key, hz, moon: moonOf(S.pl, values), map: mapOf(S.pl), planets: many ? S.planets.map((p) => {
    // every planet of the system, for the view that draws them all (the one on show is flagged)
    const q = planetValues(all, p.sfx); let e2 = null, look = 'jupiter';
    try { e2 = orbitElements(q); const d2 = deriveSystem(q, st); look = planetClass(d2.rpEarth, d2.teq).key; } catch { /* impossible geometry: leave it out */ }
    return { el: e2, rprs: q.rprs, name: p.letter, look, active: p.sfx === S.pl, color: planetColor(p.sfx), moon: moonOf(p.sfx, q), map: mapOf(p.sfx) };
  }).filter((p) => p.el) : undefined });
  // annotation on the light curve: fitted radius ratio and mid-transit time
  const fs = (k) => S.fit && !S.live && S.fit.summary.find((x) => x.key === PK(k)), tRef = S.data.tRef || 0;
  const pmTxt = (label, v, s, dg) => (s ? `${label} = ${s.med.toFixed(dg)} ± ${(0.5 * (s.plus + s.minus)).toFixed(dg)}` : `${label} = ${v.toFixed(dg)}`);
  const sr = fs('rprs'), stm = fs('tmid');
  const pts = S.fold ? foldedPoints(values) : { t: S.data.t, f: S.data.f, e: S.data.e, base: model.base, model: model.tr, group: S.data.epoch || null };
  $('#lcfold').classList.toggle('on', S.fold); $('#lcfold').setAttribute('aria-pressed', String(S.fold));
  document.querySelectorAll('#viewsel button').forEach((b) => { b.classList.toggle('on', b.dataset.v === S.view); b.setAttribute('aria-pressed', String(b.dataset.v === S.view)); if (b.dataset.v === 'rv') b.disabled = !S.rv.length; });
  if (S.view === 'rv' && !S.rv.length) S.view = 'lc';
  syncRecFig();
  if (S.view === 'moon' && !hasMoon()) S.view = 'lc';
  if ((S.view === 'phase' || S.view === 'map') && !hasPhase()) S.view = 'lc';
  { const mb = $('#viewsel [data-v=moon]'); if (mb) mb.hidden = !hasMoon(); for (const v of ['phase', 'map']) { const b = $(`#viewsel [data-v=${v}]`); if (b) b.hidden = !hasPhase(); } }
  const grid = S.allPlanets && many;
  $('#lcall').hidden = !many; $('#lcall').classList.toggle('on', grid); $('#lcall').setAttribute('aria-pressed', String(grid));
  lcPlot.alt = grid ? { data: allPlanetsPanels(all), render: renderAllPlanets } : plotFor(S.view, all);
  lcPlot.opts = { ...S.plot, groups: S.data.epoch ? S.data.segments.map((sg) => sg.name) : null, toolsW: toolPad() ? ($('.lctools').offsetWidth || 0) + 16 : 0 };
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
  if (dv) {
    const items = [
      ['Impact parameter b', num(der.b, 4) + (der.b > 1 - values.rprs && der.t14 > 0 ? ' · grazing' : ''), 'Impact parameter'], ['Duration T₁₄', num(der.t14 * 24, 3) + ' h', 'Transit duration'],
      ['Mid-transit depth', (depth * 1e6).toFixed(0) + ' ppm', null, 'How much the model dims at mid-transit, limb darkening included. It differs from (Rp/R★)² because the planet covers a brighter or darker part of the disc depending on the impact parameter.', 'transit'],
      ['Planet radius', `${num(der.rpJup, 3)} R Jup · ${num(der.rpEarth, 2)} R⊕`, 'Planet radius'],
      ['Semi-major axis', num(der.aAU, 4) + ' au', 'Semi-major axis'], ['Equilibrium temp.', num(der.teq, 0) + ' K', 'Equilibrium temp'],
      ['Stellar density', num(der.rhoStar, 3) + ' g/cm³', 'Stellar density ρ★ (from'], ['Insolation', num(der.insol, der.insol > 100 ? 0 : 2) + ' S⊕', 'Insolation'],
      ...(der.K > 0 ? [['RV semi-amplitude K', num(der.K, der.K < 20 ? 2 : 1) + ' m/s', 'RV semi-amplitude']] : []),
    ];
    dv.innerHTML = '';
    for (const [k, v, key, how, ev] of items) {
      const info = key ? rowInfo(key) : { how, ev }, cell = h('div', { title: info ? info.how : '', html: `<span>${k}</span><b>${v}</b>` });
      if (info && info.ev && viz && viz.highlight) { cell.addEventListener('mouseenter', () => { try { viz.highlight(info.ev); } catch { /* optional */ } }); cell.addEventListener('mouseleave', () => { try { viz.highlight(null); } catch { /* optional */ } }); }
      dv.append(cell);
    }
  }
  const bd = $('#ldbadge');
  if (bd) { bd.className = 'badge ' + (prof.negative ? 'bad' : prof.nonMonotonic ? 'warn' : 'ok'); bd.textContent = prof.negative ? 'negative intensity' : prof.nonMonotonic ? 'brightens toward limb' : 'physical profile'; }
  drawLD(claret);
}

/**
 * The texture of a planet's brightness map for the 3D view ({ width, height, rgba }, see mapRGBA), or null when its own light
 * is not in the model. Same map and colour scale as the Map view (kelvin with a stellar temperature and a band). Kept while
 * the parameters it depends on are unchanged, so the 3D view keeps its texture.
 */
function planetTexture(all, sfx) {
  if (!hasPhase(sfx, all)) return null;
  const pp = phaseParamsOf(all, sfx), ph = phaseSpec(), key = JSON.stringify([pp, S.star.teff, ph.band_micron, ph.mode, ph.lmax]);
  const memo = planetTexture.memo || (planetTexture.memo = new Map()), hit = memo.get(sfx);
  if (hit && hit.key === key) return hit.tex;
  let tex = null;
  try { tex = mapRGBA(mapPlotData(pp, { tstar: S.star.teff, band: ph.band_micron, nlat: 48, nlon: 96 })); } catch { tex = null; }
  memo.set(sfx, { key, tex }); return tex;
}

/** The light curve with every point moved by whole periods to the transit at T mid, in time order. */
function foldedPoints(values, pl = S.pl) {
  const ft = foldTimes(S.data.t, values.per, values.tmid), idx = Array.from(ft.keys()).sort((a, b) => ft[a] - ft[b]);
  const take = (a) => Float64Array.from(idx, (i) => a[i]);
  // several planets: show this planet's transit, with the other planets' model divided out of the data
  const trs = model.det && model.det.transits, me = S.planets.findIndex((p) => p.sfx === pl);
  let f = S.data.f, tr = model.tr;
  if (trs && me >= 0) { tr = trs[me]; f = Float64Array.from(S.data.f, (x, i) => (tr[i] > 0 ? (x * tr[i]) / model.tr[i] : x)); }
  return { t: take(ft), f: take(f), e: take(S.data.e), base: take(model.base), model: take(tr), group: S.data.epoch ? Int32Array.from(idx, (i) => S.data.epoch[i]) : null };
}
/**
 * What the radial-velocity panel draws. Zero points are removed from every instrument. In time the
 * model is every planet plus the trend; folded, it is the planet on show, with the other planets
 * and the trend taken out of the data.
 */
function rvPlotData(all, pl = S.pl, fold = S.fold) {
  const det = model && model.det, label = `${planetLabel(pl)} · radial velocities` + (rvOn() ? '' : ' · not in the fit');
  if (!det || !det.rv) return { sets: [], label: S.rv.length ? 'No valid model for the velocities at these parameters' : 'No radial velocities loaded' };
  const st = starNow(), me = Math.max(0, S.planets.findIndex((p) => p.sfx === pl)), c = planetValues(all, pl), tRef = S.data.tRef || 0;
  const fns = S.planets.map((p) => { const q = planetValues(all, p.sfx), K = Number.isFinite(q.K) ? q.K : semiAmplitude(q.per, q.ecc || 0, q.inc, q.mplanet || 0, all.mstar ?? st.mstar); return { f: makeRV({ per: q.per, tmid: q.tmid, ecc: q.ecc || 0, omega: q.omega || 0, K }), K, per: q.per }; });
  const lin = all.rvlin || 0, quad = all.rvquad || 0, t0 = model.rvTref || 0;
  let tmin = Infinity, tmax = -Infinity;
  const sets = S.rv.map((D, d) => {
    const R = det.rv[d], n = D.t.length, x = new Float64Array(n), y = new Float64Array(n), e = new Float64Array(n), res = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      res[i] = D.v[i] - R.gamma - R.model[i]; e[i] = Math.hypot(D.e[i], R.jitter);
      if (fold) { const ph = (D.t[i] - c.tmid) / c.per; x[i] = ph - Math.round(ph); y[i] = res[i] + R.planets[me][i] + (R.rm ? R.rm[i] : 0); }
      else { x[i] = D.t[i]; y[i] = D.v[i] - R.gamma; tmin = Math.min(tmin, D.t[i]); tmax = Math.max(tmax, D.t[i]); }
    }
    return { name: D.name, x, y, e, res };
  });
  const curve = { x: [], y: [] };
  // the Rossiter–McLaughlin anomaly, when it is in the model (rm.js, as buildProblem adds it)
  const rmF = hasOpt('vsini', all) ? (() => { try { return makeRM({ ...c, vsini: all.vsini, lambda: all[planetKey('lambda', pl)] ?? all.lambda ?? 0, claret: toClaret(S.ldLaw, [all.ld0, all.ld1, all.ld2, all.ld3]) }); } catch { return null; } })() : null;
  if (fold) { const N = 2400, dur = rmF ? Math.min(0.5, (deriveSystem(c, st).t14 || 0.1) / c.per) : 0; for (let i = 0; i <= N; i++) { const ph = -0.5 + i / N; curve.x.push(ph); curve.y.push(fns[me].f(c.tmid + ph * c.per)); }
    // the anomaly lasts a few per cent of the orbit: sample the transit finely and put it in phase order
    if (rmF) { const M = 600, pts = curve.x.map((x, i) => [x, curve.y[i]]).filter(([x]) => Math.abs(x) > dur); for (let i = 0; i <= M; i++) { const ph = -dur + (2 * dur * i) / M; pts.push([ph, fns[me].f(c.tmid + ph * c.per) + rmF(c.tmid + ph * c.per)]); } pts.sort((a, b) => a[0] - b[0]); curve.x = pts.map((q) => q[0]); curve.y = pts.map((q) => q[1]); } }
  else {
    // enough samples to follow the shortest period (an eccentric orbit's periastron swing is brief)
    const span = tmax - tmin || 1, pmin = Math.min(...fns.map((q) => q.per)), N = Math.round(Math.min(12000, Math.max(800, (60 * span) / pmin)));
    for (let i = 0; i <= N; i++) { const t = tmin - 0.03 * span + (1.06 * span * i) / N, dt = t - t0; let m = lin * dt + quad * dt * dt; for (const q of fns) m += q.f(t); if (rmF) m += rmF(t); curve.x.push(t); curve.y.push(m); }
  }
  const ss = sets.reduce((a, s2) => a + s2.res.reduce((b, r) => b + r * r, 0), 0), nn = sets.reduce((a, s2) => a + s2.x.length, 0);
  return { sets, curve, fold, label, xlabel: fold ? `Orbital phase of ${planetLabel(pl)} (0 = mid-transit)` : tRef ? `BJD − ${tRef}` : 'Time (days)', info: [`K = ${fns[me].K.toFixed(fns[me].K < 20 ? 2 : 1)} m/s`, `rms ${Math.sqrt(ss / Math.max(1, nn)).toFixed(2)} m/s`] };
}

/**
 * Every planet's folded panel side by side, on one vertical scale so depths (or velocity amplitudes) can be
 * compared by eye. Each panel is the ordinary renderer drawn into its own
 * column; the planet's colour marks its title.
 */
function allPlanetsPanels(all) {
  const st = starNow();
  if (S.view === 'rv') {
    const ds = S.planets.map((p) => rvPlotData(all, p.sfx, true)), ex = ds.map(rvExtent);
    const yRange = [Math.min(...ex.map((e) => e.y0)), Math.max(...ex.map((e) => e.y1))], rmax = Math.max(...ex.map((e) => e.rmax));
    return { kind: 'rv', panels: ds.map((d, i) => ({ d: { ...d, label: `${S.planets[i].letter} · P = ${Number(planetValues(all, S.planets[i].sfx).per.toPrecision(6))} d`, xlabel: 'Orbital phase' }, color: planetColor(S.planets[i].sfx), opt: { yRange, rmax } })) };
  }
  const panels = S.planets.map((p) => {
    const v = planetValues(all, p.sfx), der = deriveSystem(v, { ...st, mplanet: v.mplanet }), pts = foldedPoints(v, p.sfx);
    const d = { ...pts, tmid: v.tmid, fluxFn: fluxFunction(all, p.sfx), band: null, cursor: null, stats: null, info: [`Rp/R★ = ${v.rprs.toFixed(4)}`], label: `${p.letter} · P = ${Number(v.per.toPrecision(6))} d` };
    const half = der.t14 > 0 ? 2.5 * der.t14 : 0.1 * v.per;
    return { d, color: planetColor(p.sfx), view: autoView(d, v.tmid - half, v.tmid + half) };
  });
  const y0 = Math.min(...panels.map((p) => p.view.y0)), y1 = Math.max(...panels.map((p) => p.view.y1));
  for (const p of panels) p.view = { ...p.view, y0, y1 };
  return { kind: 'lc', panels };
}
function renderAllPlanets(ctx, W, H, g, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const n = g.panels.length, top = opt.fontScale === undefined ? toolPad() : 0;   // room for the toolbar that sits over the panel on screen
  // the grid whose panels come closest to the shape of a light curve (about 1.7 : 1): side by side in a wide window,
  // one above the other in a tall one, two by two in a square one
  let cols = n, best = Infinity;
  for (let c = 1; c <= n; c++) { const r = Math.ceil(n / c), cw = W / c, ch = (H - top) / r, a = cw / ch, sc = Math.abs(Math.log(a / 1.7)) + 0.15 * (c * r - n) + (ch < 170 ? 3 : 0) + (cw < 220 ? 1 : 0); if (sc < best) { best = sc; cols = c; } }
  const rows = Math.ceil(n / cols), w = W / cols, hh = (H - top) / rows;
  g.panels.forEach((p, i) => {
    const x = (i % cols) * w, y = top + Math.floor(i / cols) * hh;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip(); ctx.translate(x, y);
    const o = { ...opt, ...(p.opt || {}), title: undefined, fontScale: (opt.fontScale || (w < 520 ? 0.95 : 1.12)) * (cols > 3 ? 0.9 : 1) };
    if (g.kind === 'rv') renderRV(ctx, w, hh, p.d, th, o); else renderLightCurve(ctx, w, hh, p.d, p.view, th, o);
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(w - 14, 12, 5, 0, 6.3); ctx.fill();   // the planet's colour
    ctx.restore();
  });
  return null;
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

const SLIDER = { secosw: [-1, 1], sesinw: [-1, 1], rprs: [0.005, 0.3, 'log'], ars: [1.5, 150, 'log'], inc: [75, 90], per: [0.3, 200, 'log'], ecc: [0, 0.95], omega: [-180, 180], a2: [-0.2, 0.2], mplanet: [0.001, 30, 'log'], rvlin: [-1, 1], rvquad: [-0.01, 0.01], jit: [0, 50], rmoon: [0.001, 0.1, 'log'], permoon: [0.1, 40, 'log'], phmoon: [0, 1], mmoon: [0, 0.2], imoon: [0, 180], jitlc: [0, 5000], dil: [0, 2], vsini: [0, 50], lambda: [-180, 180] };
function fullRange(key) {
  const base = baseKey(key);
  if (base === 'tmid') { const v = S.values[key] ?? 0, per = S.values[planetKey('per', key.split('@')[1] || '')] || 1; return [Math.min(S.data.t[0], v - per / 2), Math.max(S.data.t[S.data.t.length - 1], v + per / 2)]; }
  if (base.startsWith('ld')) return S.ldLaw === 'kipping' ? [0, 1] : [-1, 1.5];
  if (base === 'fpfs') return [0, Math.max(0.5, 2 * (S.values[key] || 0))];
  if (PHASE_BY_KEY[base]) return [PHASE_BY_KEY[base].min, PHASE_BY_KEY[base].max];
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
  const chip = (p) => h('button', { class: p.sfx === S.pl ? 'on' : '', style: many ? `--pc:${planetColor(p.sfx)}` : '', title: `Show planet ${p.letter}`, onclick: () => { if (p.sfx === S.pl) return; pushUndo(); S.pl = p.sfx; S.t = cur(S.values).tmid; buildPanels(); refresh(true); } }, p.letter);
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
  // ---- the planet's own light
  if (hasPhase()) {
    const ph = phaseSpec(), sel = h('select', { class: 'chip small', 'aria-label': 'Phase-curve model', title: 'Phase curve: a sinusoid peaking near mid-eclipse (plus an optional second harmonic). Map: spherical harmonics on the planet, which also shape the eclipse ingress and egress' },
      ...[['harmonic|1', 'Phase curve (harmonics)'], ['map|1', 'Map, degree 1'], ['map|2', 'Map, degree 2'], ['map|3', 'Map, degree 3']].map(([v, t]) => h('option', { value: v, selected: v === `${ph.mode}|${ph.mode === 'map' ? ph.lmax : 1}` }, t)));
    sel.addEventListener('change', () => { const [m, l] = sel.value.split('|'); setPhaseMode(m, Number(l)); });
    const bands = Object.entries(BANDS), bsel = h('select', { class: 'chip small', 'aria-label': 'Band of the observation', title: 'Band of the observation: used to turn the brightness into a brightness temperature (the star is taken as a blackbody at its effective temperature)' },
      ...bands.map(([n, b]) => h('option', { value: n, selected: b[0] === ph.band_micron[0] && b[1] === ph.band_micron[1] }, `${n} (${b[0]}–${b[1]} µm)`)));
    if (!bands.some(([, b]) => b[0] === ph.band_micron[0] && b[1] === ph.band_micron[1])) bsel.append(h('option', { value: '', selected: true }, `${ph.band_micron[0]}–${ph.band_micron[1]} µm`));
    bsel.addEventListener('change', () => { if (!BANDS[bsel.value]) return; pushUndo(); setPhase({ band_micron: [...BANDS[bsel.value]] }); buildSystemTab(); refresh(); });
    const ltt = h('input', { type: 'checkbox', checked: !!ph.ltt }); ltt.addEventListener('change', () => { pushUndo(); setPhase({ ltt: ltt.checked }); refresh(); });
    el.append(h('h3', {}, 'Planet light', h('button', { class: 'chip small', title: 'Take the eclipse and phase curve out of the model', onclick: removePhase }, '✕ remove')));
    el.append(h('div', { class: 'btnrow' }, sel, bsel, h('label', { class: 'chk', title: 'Delay the planet’s light by its travel time across the orbit (the eclipse arrives 2a/c late; needs the stellar radius)' }, ltt, ' light-travel delay')));
    el.append(...act.filter((p) => p.group === 'phase' && p.planet === S.pl).map((p) => paramRow({ ...p, label: p.label.split(' · ')[0] })));
    let sm = null; try { sm = phaseSummary(phaseParamsOf({ ...S.values, ...(S.live || {}) }), { tstar: S.star.teff, band: ph.band_micron }); } catch { /* shown as soon as the parameters are valid */ }
    if (sm) el.append(h('p', { class: 'note' + (sm.negative || sm.negativeMap ? ' callout warn' : ''), html: `Eclipse depth <b>${(sm.depth * 1e6).toFixed(0)} ppm</b>, phase-curve amplitude ${(sm.amplitude * 1e6).toFixed(0)} ppm, brightest ${Math.abs(sm.hotspotOffset).toFixed(1)}° ${sm.hotspotOffset >= 0 ? 'before' : 'after'} mid-eclipse.`
      + (Number.isFinite(sm.tday) ? ` Brightness temperature: day <b>${sm.tday.toFixed(0)} K</b>, night ${Number.isFinite(sm.tnight) ? sm.tnight.toFixed(0) + ' K' : 'not detected'}${Number.isFinite(sm.bondAlbedo) ? `; Bond albedo ${sm.bondAlbedo.toFixed(2)}, redistribution ε ${sm.epsilon.toFixed(2)} (Cowan & Agol 2011)` : ''}.` : '')
      + (sm.negative ? ' <b>The planet’s flux goes negative at some phases</b>: such a point is outside the prior in a fit.' : sm.negativeMap ? ' Part of the map has negative brightness, which the disc-integrated curve cannot rule out on its own.' : '') }));
    el.append(h('p', { class: 'note' }, 'Fp/F★ is the dayside surface brightness over the star’s, so the eclipse depth is Fp/F★ × (Rp/R★)². The plot’s Phase view folds the data on the orbit; the Map view shows the temperature map and what the observer sees at each phase.'));
  } else {
    el.append(h('div', { class: 'btnrow' }, h('button', { class: 'chip small', title: 'Model this planet’s own light: the secondary eclipse, the phase curve over the orbit and, with enough precision, a map', onclick: addPhase }, '+ eclipse & phase curve')));
  }
  // ---- a moon of the planet on show
  if (hasMoon()) {
    const geo = moonState();
    el.append(h('h3', {}, 'Moon', h('button', { class: 'chip small', title: 'Take the moon out of the model', onclick: removeMoon }, '✕ remove')));
    el.append(...act.filter((p) => p.group === 'moon' && p.planet === S.pl).map((p) => paramRow({ ...p, label: p.label.split(' · ')[0] })));
    if (geo) el.append(h('p', { class: 'note' + (geo.ok ? '' : ' callout warn'), html: `Separation ${geo.aMoon.toFixed(3)} R★ (${(geo.aMoon / cur(S.values).rprs).toFixed(1)} planet radii), ${(100 * geo.hillFrac).toFixed(0)}% of the planet’s Hill radius; a prograde moon is stable below ${(100 * geo.stableFrac).toFixed(0)}%, that is for periods under ${geo.maxPeriod.toFixed(2)} d.` + (geo.ok ? '' : ' <b>' + geo.reasons.join(' ') + '</b> The fit treats such a moon as outside the prior.') }));
    el.append(h('p', { class: 'note' }, 'The moon orbits the planet on a circular orbit, in the planet’s orbital plane unless tilted; its distance follows from its period and the planet’s mass. Switch the plot below to “Moon” to see its own dip, the planet-moon eclipses and the planet’s wobble separately.'));
  } else {
    el.append(h('div', { class: 'btnrow' }, h('button', { class: 'chip small', title: 'Add a moon to this planet: its radius, period and phase at mid-transit', onclick: addMoon }, '+ moon'),
      h('button', { class: 'chip small', title: 'Search the light curve for a moon of this planet: a grid over the moon’s period and phase, with the radius fitted at each', onclick: searchMoon }, 'Search for a moon'), h('span', { class: 'note', id: 'moonmsg' })));
  }
  const ms = S.moonSearch && S.moonSearch.pl === S.pl && S.moonSearch.dataId === S.dataId ? S.moonSearch : null;
  if (ms) {
    const b = ms.res.best, cvm = h('canvas', { id: 'mooncanvas' });
    el.append(h('p', { class: 'note callout' + (ms.res.fap > 0.05 ? ' warn' : ''), html: `Moon search: the strongest candidate has period <b>${b.permoon.toFixed(4)} d</b>, phase ${b.phmoon.toFixed(3)}, Rm/R★ ${b.rmoon.toFixed(4)}, signal-to-noise <b>${b.snr.toFixed(1)}</b>. In ${ms.res.nullMax.length} searches of noise alone the largest reached ${Math.max(...ms.res.nullMax).toFixed(1)} (false-alarm probability ${ms.res.fap < 0.02 ? 'below ' + (1 / (1 + ms.res.nullMax.length)).toFixed(2) : ms.res.fap.toFixed(2)}). ${ms.res.fap > 0.05 ? 'That is not a detection.' : 'Periods that differ from it by one orbit of the planet per transit fit almost as well: ' + ms.res.peaks.slice(0, 3).map((p) => `${p.permoon.toFixed(3)} d (${p.snr.toFixed(1)})`).join(', ') + '.'}` }), cvm,
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', disabled: ms.res.fap > 0.2, onclick: () => { pushUndo(); setMoonValues({ rmoon: Number(b.rmoon.toFixed(5)), permoon: Number(b.permoon.toFixed(5)), phmoon: Number(b.phmoon.toFixed(4)), mmoon: 0, imoon: 0 }); buildPanels(); refresh(); flash('Moon added from the search'); } }, 'Use this moon in the model'), h('button', { class: 'chip small', onclick: () => { S.moonSearch = null; buildSystemTab(); } }, 'dismiss')));
    requestAnimationFrame(() => { const W = cvm.clientWidth, H = cvm.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2); if (!W) return; cvm.width = W * dpr; cvm.height = H * dpr; const c = cvm.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); renderMoonSearch(c, W, H, { ...ms.res, label: `${planetLabel()} · moon search` }, LC_THEMES.screen, {}); });
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
  el.append(h('details', { class: 'group', open: false }, h('summary', {}, 'Position and magnitudes', h('small', {}, Number.isFinite(st.ra) ? `RA ${st.ra.toFixed(3)}° Dec ${st.dec.toFixed(3)}°` : 'not set')),
    pairField('RA (deg, J2000)', st, 'ra', null, { min: 0, max: 360, step: 0.0001 }, 'Right ascension of the host: used to search the RV archives and to convert JD/HJD times to BJD_TDB. Filled from the catalogue for a known planet.'),
    pairField('Dec (deg, J2000)', st, 'dec', null, { min: -90, max: 90, step: 0.0001 }, 'Declination of the host'),
    pairField('J (2MASS mag)', st, 'jmag', null, { step: 0.01 }, 'J magnitude: gives the transmission spectroscopy metric (TSM, Kempton et al. 2018)'),
    pairField('Ks (2MASS mag)', st, 'kmag', null, { step: 0.01 }, 'Ks magnitude: gives the emission spectroscopy metric (ESM, Kempton et al. 2018)')));
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
  const bandSel = h('select', { 'aria-label': 'Bandpass' }, [...Object.keys(FILTERS), 'Custom range'].map((k) => h('option', { value: k, selected: k === S.band }, S.table && S.table.kind === 'json' ? k.replace(' (approx.)', '') : k)),
    h('optgroup', { label: 'JWST and Ariel modes (set the custom range)' }, Object.entries(MISSION_BANDS).map(([k, b]) => h('option', { value: 'mission:' + k }, `${k} (${b.micron[0]}–${b.micron[1]} µm)${b.beyondTable ? ' · partly beyond the table' : ''}`))));
  const c0 = h('input', { type: 'number', value: S.bandCustom[0], min: 200, max: 12000, step: 10, 'aria-label': 'Band minimum (nm)' }), c1 = h('input', { type: 'number', value: S.bandCustom[1], min: 200, max: 12000, step: 10, 'aria-label': 'Band maximum (nm)' });
  const custom = h('div', { class: 'field3', hidden: S.band !== 'Custom range' }, h('span', {}, 'Range (nm)'), c0, h('span', { class: 'pm' }, '–'), c1);
  bandSel.addEventListener('change', () => { pushUndo(); const mb = bandSel.value.startsWith('mission:') && MISSION_BANDS[bandSel.value.slice(8)]; if (mb) { S.band = 'Custom range'; S.bandCustom = [...mb.range]; flash(`Range set to ${bandSel.value.slice(8)}: ${mb.range[0]}–${mb.range[1]} nm, a top-hat${mb.beyondTable ? '; the spectral table ends at 5500 nm, see the note below for what is used' : ''}`); } else S.band = bandSel.value; syncStarLD.key = null; buildPanels(); refresh(); });   // the source of the coefficients (table or grey estimate) depends on the band
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
    h('span', { class: 'note' }, haveTable ? `using ${ldTableName()}` : S.band === 'Custom range' && spectralState === 'loading' ? 'loading the spectral table…' : 'grey-atmosphere model')));
  el.append(h('p', { class: 'note', id: 'ldmsg', html: S.ldMsg }));
  el.append(h('details', {}, h('summary', {}, 'Where these numbers come from, and loading a PHOENIX table'),
    h('p', { class: 'note', html: 'The bundled table holds PHOENIX model-atmosphere limb darkening (Husser et al. 2013) for 37 bands on T eff 2300–8000 K, log g 4.0–5.5 and [Fe/H] −0.5 to +0.5, built by <b>tools/build_ld_table.py</b>. It is interpolated to the star, and values outside the grid are clamped to its edge and flagged. Against ExoTETHyS for the same models the intensity profile agrees to about 0.001 rms; different atmosphere models (ATLAS) differ from it by about 0.01, which is the real uncertainty of any tabulated coefficient.' }),
    h('p', { class: 'note', html: 'A <b>Custom range</b> is served by a second, wavelength-resolved PHOENIX table: 200–5500 nm in bins of 5 to 45 nm, combined over your range with photon weighting, so it responds to T eff, log g and [Fe/H] like the listed bands. It agrees with direct integration of the models to about 0.001 in intensity (0.01 at worst, for the coolest M dwarfs and channels a few nm wide), under 0.5% of a transit depth. A range outside 200–5500 nm falls back to a grey-atmosphere estimate that follows T eff and wavelength only. You can also load your own table: ld_table.json from the builder, or a CSV with columns teff, logg, feh, optional filter, and 1, 2 or 4 coefficients.' }),
    h('div', { class: 'drop' }, 'Coefficient table: ', gridIn)));

  if (rvOn()) {
    el.append(h('h3', {}, 'Radial velocity'), ...act.filter((p) => p.group === 'rv').map(paramRow));
    el.append(h('div', { class: 'btnrow' }, optChip('vsini', 'Rossiter–McLaughlin', 'The velocity anomaly while a planet covers part of the rotating star: v sin i★ and each planet’s projected obliquity λ, with the light curve’s limb darkening')));
    el.append(h('p', { class: 'note', html: 'Each instrument has its own zero point, integrated out analytically like the light-curve normalisation, and its own jitter added in quadrature to its error bars. The trend terms are shared: the star drifts on one path.' }));
  }
  const extra = act.filter((p) => p.group === 'baseline');
  el.append(h('h3', {}, 'Baseline'), ...extra.map(paramRow));
  el.append(h('div', { class: 'btnrow' }, optChip('jitlc', 'jitter', 'Extra white noise added in quadrature to the light curve’s error bars, one per epoch; fitted, its normalisation keeps it honest'),
    optChip('dil', 'dilution', 'Light of other stars in the aperture, as a ratio d to the target’s flux: the model becomes (model + d)/(1 + d), so depths shrink by 1 + d. TESS CROWDSAP = 1/(1 + d)')));
  el.append(h('p', { class: 'note', html: nEpochs() > 1 ? `Each of the ${nEpochs()} epochs has its own baseline <b>a₁·exp(k·airmass)</b>: its own normalisation a₁, integrated out analytically and never sampled, and its own k when it has an airmass column. The planet and orbit are shared.` : S.data.airmass ? 'Baseline is <b>a₁·exp(k·airmass)</b>. The normalisation a₁ is integrated out analytically, so it is never sampled.' : 'No airmass column in this dataset: the baseline is a single normalisation a₁, integrated out analytically.' }));
}

// ---- optional terms: light-curve jitter, dilution, Rossiter–McLaughlin (buildProblem reads them when their keys are set) ----
const OPT_START = { jitlc: 0, dil: 0, vsini: 2, lambda: 0 };
/** Put an optional term in the model or take it out: 'jitlc' (one per epoch), 'dil', or 'vsini' (with each planet's lambda). One undo step. */
function setOpt(base, on) {
  if (on === hasOpt(base)) return;
  pushUndo();
  const bases = base === 'vsini' ? ['vsini', 'lambda'] : [base];
  for (const o of [S.values, S.free, S.priors]) for (const k of Object.keys(o)) if (bases.includes(baseKey(k))) delete o[k];
  if (on) {
    const n = nEpochs(), keys = base === 'jitlc' ? Array.from({ length: n }, (_, s) => lcJitterKey(s, n)) : base === 'vsini' ? ['vsini', ...S.planets.map((p) => planetKey('lambda', p.sfx))] : [base];
    for (const k of keys) { S.values[k] = OPT_START[baseKey(k)]; S.priors[k] = defaultPrior(k); S.free[k] = base !== 'dil'; }
  }
  S.fit = null; S.range = 'full'; buildPanels(); refresh();
}
const OPT_NAME = { jitlc: 'light-curve jitter', dil: 'dilution', vsini: 'Rossiter–McLaughlin effect' };
/** "+ name" / "✕ name" chip that switches an optional term. */
const optChip = (base, label, title) => { const on = hasOpt(base); return h('button', { class: 'chip small', title, onclick: () => { setOpt(base, !on); flash(`${OPT_NAME[base]} ${on ? 'removed from' : 'added to'} the model`); } }, (on ? '✕ ' : '+ ') + label); };

// ---- moons ---------------------------------------------------------------------------------------------------
function setMoonValues(o, sfx = S.pl) {
  for (const [f, v] of Object.entries(o)) { const k = moonKey(f, sfx); S.values[k] = v; if (!S.priors[k]) S.priors[k] = defaultPrior(k); if (S.free[k] === undefined) S.free[k] = f === 'rmoon' || f === 'permoon' || f === 'phmoon'; }
  if (!(S.values[PK('mplanet')] > 0)) S.values[PK('mplanet')] = 1;   // the moon's distance follows from the planet's mass
  S.fit = null; S.range = 'full';
}
/** The moon's orbit in numbers (separation, Hill fraction, stability) for the planet on show, or null. */
function moonState(values = S.values) {
  const pv = planetValues(values), moon = moonParamsFrom(values, S.pl, { mplanet: pv.mplanet, mstar: values.mstar ?? starNow().mstar });
  if (!moon) return null;
  try { return moonGeometry({ ...toTransitParams(pv, S.ldLaw), ...moon }); } catch { return null; }
}
function addMoon() {
  pushUndo(); const c = cur(S.values);
  setMoonValues({ rmoon: Number((0.25 * c.rprs).toPrecision(3)), permoon: Number(Math.min(0.1 * c.per, 5).toPrecision(3)), phmoon: 0.15, mmoon: 0, imoon: 0 });
  buildPanels(); refresh(); flash('Moon added');
}
function removeMoon() {
  pushUndo();
  for (const f of MOON_FIELDS) { const k = moonKey(f, S.pl); delete S.values[k]; delete S.free[k]; delete S.priors[k]; }
  if (S.view === 'moon') S.view = 'lc';
  S.fit = null; buildPanels(); refresh();
}
/** Grid search for a moon of the planet on show in the loaded light curve, with noise-only searches for the false-alarm rate. */
function searchMoon() {
  const msg = $('#moonmsg'); if (msg) msg.textContent = 'Searching…';
  setTimeout(() => {
    try {
      const pv = planetValues(S.values), n = S.data.t.length, f = new Float64Array(n);
      for (let i = 0; i < n; i++) f[i] = S.data.f[i] / model.base[i];   // the data with their baseline removed
      const res = moonSearch({ t: S.data.t, f, e: Float64Array.from(S.data.e, (x, i) => x / model.base[i]) }, { ...toTransitParams(pv, S.ldLaw), mplanet: pv.mplanet > 0 ? pv.mplanet : 1, mstar: starNow().mstar }, { nNull: 40 });
      S.moonSearch = { pl: S.pl, dataId: S.dataId, res }; buildSystemTab();
    } catch (err) { if (msg) { msg.textContent = 'The search could not run: ' + err.message; msg.style.color = 'var(--bad)'; } }
  }, 30);
}
/**
 * The figure of a plot view other than the light curve: { data, render(ctx, W, H, data, theme, opts) }, or null for the
 * light curve itself. The screen, the exported figure and the movie all draw through this; data.setTime(t), when
 * present, moves the figure's time cursor.
 */
/** The movie's figure menu lists only the figures this model has. */
function syncRecFig() {
  const sel = $('#recfig'); if (!sel) return;
  const have = [['current', 'Plot on show'], ['lc', 'Light curve']]; if (S.rv.length) have.push(['rv', 'Radial velocity']); if (hasPhase()) have.push(['phase', 'Phase curve'], ['map', 'Temperature map']); if (hasMoon()) have.push(['moon', 'Moon']);
  const sig = have.map((x) => x[0]).join(); if (sel.dataset.sig === sig) return;
  const keep = sel.value; sel.dataset.sig = sig; sel.replaceChildren(...have.map(([v, t]) => h('option', { value: v }, t))); sel.value = have.some((x) => x[0] === keep) ? keep : 'current';
}
/** On screen the plot's tool row lies over the top of the canvas: figures that write there are drawn below it. Exports and the movie get the whole area. */
// (a narrow plot has its tools in a strip of their own above the canvas: nothing to leave room for then)
const toolPad = () => { const cv = $('#lccanvas'); return cv && cv.offsetTop > 0 ? 0 : 26; };
const belowTools = (render) => (c, W, H, d, th, o = {}) => {
  const pad = o.fontScale === undefined ? toolPad() : 0;
  if (pad) { c.fillStyle = th.bg; c.fillRect(0, 0, W, pad); c.save(); c.translate(0, pad); }
  render(c, W, H - pad, d, th, o);
  if (pad) c.restore();
  return null;
};
function plotFor(view, all = { ...S.values, ...(S.live || {}) }) {
  if (view === 'rv' && S.rv.length) return { data: rvPlotData(all), render: renderRV };
  if (view === 'moon' && hasMoon()) return { data: moonPlotData(all), render: belowTools(renderMoonLightCurve) };
  if (view === 'phase' && hasPhase()) return { data: phaseCurveData(all), render: belowTools(renderPhaseCurve) };
  if (view === 'map' && hasPhase()) return { data: phaseMapData(all), render: belowTools(renderPhaseMap) };
  return null;
}
/**
 * A figure of any view for export: { data, render(ctx, W, H, data, theme, opts), title }. The light curve and the
 * residuals are drawn from what the plot panel holds; the O − C from the Timing tab's list; the rest come from plotFor.
 * Throws, saying what is missing, when the model or the data have no such view.
 */
function figureFor(view) {
  const all = { ...S.values, ...(S.live || {}) };
  if (view === 'lc' || view === 'residuals') {
    if (!model || !model.valid || !lcPlot.d) throw new Error('there is no valid model at the current parameters (the planet does not transit, or the limb darkening profile is not physical), so there is nothing to draw the data against');
    const d = { ...lcPlot.d, cursor: null }, vw = S.view === 'lc' && lcPlot.zoomed && !lcPlot.alt ? lcPlot.view : autoView(d, d.x0, d.x1), tRef = S.data.tRef || 0;
    if (view === 'lc') return { data: d, title: S.data.name && S.data.name.startsWith(planetLabel()) ? S.data.name : `${planetLabel()} — ${S.data.name}`, render: (c, W, H, dd, th, o) => renderLightCurve(c, W, H, dd, vw, th, { ...o, tRef }) };
    return { data: d, title: `${planetLabel()} — residuals`, render: (c, W, H, dd, th, o) => renderResiduals(c, W, H, dd, th, { ...o, x0: vw.x0, x1: vw.x1 }) };
  }
  if (view === 'timing') {
    const rows = S.timing.rows.filter((r) => (r.planet || '') === S.pl && (r.kind || 'transit') === 'transit');
    const d = timingFigure(rows, cur(S.values).per, S.timing.order, `${planetLabel()} · O − C against the linear ephemeris`);
    if (!d) throw new Error(`an O − C diagram needs at least two mid-transit times of ${planetLabel()}; ${rows.length} ${rows.length === 1 ? 'is' : 'are'} listed on the Timing tab`);
    return { data: d, title: `${planetLabel()} — transit timing`, render: renderOC };
  }
  if (view === 'rv' && !S.rv.length) throw new Error('no radial velocities are loaded');
  if (view === 'moon' && !hasMoon()) throw new Error('the planet on show has no moon in the model');
  if ((view === 'phase' || view === 'map') && !hasPhase()) throw new Error('the planet’s own light (eclipse and phase curve) is not in the model');
  const f = plotFor(view, all);
  if (!f) throw new Error(`there is no “${view}” figure`);
  return { ...f, title: view === 'rv' ? `${planetLabel()} — radial velocities` : view === 'moon' ? `${planetLabel()} — moon` : `${planetLabel()} — ${phaseLabel()}` };
}
/**
 * A plot view as a PNG data URL, drawn by the render functions the screen and the exports use.
 * view: 'lc' | 'residuals' | 'corner' | 'rv' | 'timing' | 'phase' | 'map' | 'moon' | 'system'. The posterior plot is as
 * tall as it is wide (plus its header); the system view is a copy of what is on screen, fitted into the size asked for.
 */
function figure(view, { width, height, theme = 'light', scale = 2 } = {}) {
  if (refreshQueued) doRefresh();   // a change made a moment ago is drawn on the next frame: bring the plots up to date first
  const lim = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.round(Math.min(hi, Math.max(lo, Number(v)))) : d);
  const W = lim(width, 240, 4000, 900), k = Math.min(4, Math.max(1, Number(scale) || 2));
  const c = document.createElement('canvas');
  if (view === 'corner') {
    if (!S.fit) throw new Error('there is no posterior to draw: run a fit first');
    const F = S.fit; drawCorner(c, F.res, F.free.map((f) => f.label), F.truth ? F.free.map((f) => F.truth[f.key]) : null, { theme, width: W, scale: k, title: `${S.name} — posterior` });
    return c.toDataURL('image/png');
  }
  if (view === 'system') {
    const src = $('#viz canvas');
    if (!src || !src.width || !src.height) throw new Error('the system view is not on screen');
    const H = lim(height, 160, 4000, Math.round((W * src.height) / src.width)), g = c.getContext('2d');
    c.width = Math.round(W * k); c.height = Math.round(H * k);
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    const z = Math.min(c.width / src.width, c.height / src.height), w = src.width * z, hh = src.height * z;
    g.drawImage(src, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
    return c.toDataURL('image/png');
  }
  const f = figureFor(view), H = lim(height, 160, 4000, 540), g = c.getContext('2d');
  c.width = Math.round(W * k); c.height = Math.round(H * k); g.setTransform(k, 0, 0, k, 0, 0);
  const groups = S.data.epoch ? S.data.segments.map((sg) => sg.name) : null;
  f.render(g, W, H, f.data, LC_THEMES[theme] || LC_THEMES.light, { ...S.plot, groups, title: f.title, fontScale: Math.min(2, Math.max(0.85, (1.35 * W) / 900)) });
  return c.toDataURL('image/png');
}
const phaseLabel = () => (phaseSpec().mode === 'map' ? `eclipse map, degree ${phaseSpec().lmax}` : 'phase curve');
/** Full-orbit view: every point folded on the orbit with the eclipse and the transit enlarged. */
function phaseCurveData(all) {
  const pp = phaseParamsOf(all), ph = phaseSpec(), s = phaseSummary(pp, { tstar: S.star.teff, band: ph.band_micron, ltt: phaseOpts(all).ltt });
  const info = [`eclipse ${(s.depth * 1e6).toFixed(0)} ppm`];
  if (Number.isFinite(s.tday)) info.push(`day ${s.tday.toFixed(0)} K · night ${Number.isFinite(s.tnight) ? s.tnight.toFixed(0) + ' K' : 'undetected'}`);
  return phasePlotData(S.data, pp, phaseOpts(all), { label: `${planetLabel()} · ${phaseLabel()}`, info });
}
/** Map view: the brightness-temperature map with the hemisphere facing the observer, and temperature against phase. */
function phaseMapData(all) {
  const pp = phaseParamsOf(all), ph = phaseSpec(), o = { tstar: S.star.teff, band: ph.band_micron };
  const frac = (t) => (((t - pp.tmid) / pp.per) % 1 + 1) % 1;
  const map = mapPlotData(pp, { ...o, phase: (frac(S.t) - 0.5) * 360, label: `${planetLabel()} · ${ph.band_micron[0]}–${ph.band_micron[1]} µm` });
  const temp = temperaturePlotData(pp, { ...o, map, cursor: frac(S.t), label: '' });
  const d = { map, temp, setTime(t) { map.phase = (frac(t) - 0.5) * 360; temp.cursor = frac(t); } };
  return d;
}
/** The map on the left, temperature against phase on the right; one above the other unless the panel is well over twice as wide as tall. */
function renderPhaseMap(ctx, W, H, d, th, opt = {}) {
  // too small for two figures (a phone's plot): the map alone
  if ((W < 2.3 * H && H < 340) || (W >= 2.3 * H && W < 640)) return renderPlanetMap(ctx, W, H, d.map, th, opt);
  // stacked: the map's share is what its side-by-side layout (map, globe, colour bar) can use at this width
  const tall = W < 2.3 * H, need = ((W - 90) * 0.66 - 108) / 2 + 110;
  const wl = tall ? W : Math.round(W * 0.44), hl = tall ? Math.round(Math.max(0.3 * H, Math.min(0.5 * H, need))) : H;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, wl, hl); ctx.clip(); renderPlanetMap(ctx, wl, hl, d.map, th, opt); ctx.restore();
  ctx.save(); ctx.translate(tall ? 0 : wl, tall ? hl : 0); ctx.beginPath(); ctx.rect(0, 0, tall ? W : W - wl, tall ? H - hl : H); ctx.clip();
  renderTemperaturePhase(ctx, tall ? W : W - wl, tall ? H - hl : H, d.temp, th, { ...opt, title: undefined }); ctx.restore();
  return null;
}

// ---- the planet's own light: eclipse, phase curve, map -------------------------------------------------------
function setPhase(o) { S.phase = { ...phaseSpec(), ...o }; }
function addPhase() {
  pushUndo();
  if (!S.phase) S.phase = phaseSpec();
  const set = (f, v, free) => { const k = PK(f); S.values[k] = v; S.priors[k] = defaultPrior(k); S.free[k] = free; };
  // a starting point: a planet in equilibrium with no redistribution would have Fp/F* near (Teq/Teff)-ish; 0.1 is typical of hot Jupiters in the infrared
  set('fpfs', 0.1, true); set('contrast', 0.5, true); set('hotspot', 0, true);
  buildPanels(); refresh(); flash('Planet light added');
}
function removePhase() {
  pushUndo();
  for (const f of PHASE_FIELDS) { const k = PK(f); delete S.values[k]; delete S.free[k]; delete S.priors[k]; }
  if (!S.planets.some((p) => hasPhase(p.sfx))) S.phase = null;
  if (S.view === 'phase' || S.view === 'map') S.view = 'lc';
  buildPanels(); refresh(); flash('Planet light removed');
}
/** Switch between the harmonic description and a map of a given degree, carrying the first-order terms across. */
function setPhaseMode(mode, lmax) {
  pushUndo();
  const was = phaseSpec(), drop = (f) => { const k = PK(f); delete S.values[k]; delete S.free[k]; delete S.priors[k]; };
  const put = (f, v, free) => { const k = PK(f); S.values[k] = Number(v.toFixed(5)); S.priors[k] = defaultPrior(k); S.free[k] = free; };
  if (mode === 'map' && was.mode !== 'map') {
    const y = makePhaseCurve(phaseParamsOf(S.values), { map: true }).y;   // contrast and hot spot as y10, y11
    for (const f of ['contrast', 'hotspot', 'h2c', 'h2s']) drop(f);
    put('y10', y.y10 || 0, true); put('y11', y.y11 || 0, true); put('y1m1', 0, true);
  } else if (mode !== 'map' && was.mode === 'map') {
    const sm = phaseSummary(phaseParamsOf(S.values), {});
    for (const f of PHASE_FIELDS) if (/^y\d/.test(f)) drop(f);
    put('contrast', Math.min(1, Math.max(0, sm.contrast || 0)), true); put('hotspot', sm.hotspotOffset || 0, true);
  }
  setPhase({ mode, lmax: lmax || 1 });
  if (mode === 'map') for (const f of PHASE_FIELDS) if (/^y\d/.test(f)) { const l = PHASE_BY_KEY[f].l; if (l > (lmax || 1)) drop(f); else if (S.values[PK(f)] === undefined) put(f, 0, l <= 2); }
  buildPanels(); refresh();
}

/** What the Moon view draws: the model and the moon's effects in isolation, around the transit on show. */
function moonPlotData(all) {
  const pv = planetValues(all), tp = toTransitParams(pv, S.ldLaw), moon = moonParamsFrom(all, S.pl, { mplanet: pv.mplanet, mstar: all.mstar ?? starNow().mstar });
  const der = deriveSystem(pv, starNow()), half = Math.max(der.t14 || 0.1, 0.02) * 2.2 + (moon ? 0.5 * Math.min(moon.permoon, 4 * (der.t14 || 0.1)) : 0);
  // the transit nearest the time cursor, so stepping through time walks through the transits
  const E = Math.round((S.t - pv.tmid) / pv.per), tc = pv.tmid + E * pv.per, N = 900, t = Float64Array.from({ length: N }, (_, i) => tc - half + (2 * half * i) / (N - 1));
  const comp = moonComponents(t, { ...tp, ...moon }), idx = []; for (let i = 0; i < S.data.t.length; i++) if (Math.abs(S.data.t[i] - tc) <= half) idx.push(i);
  const pick = (a) => Float64Array.from(idx, (i) => a[i]);
  return { curve: { t, ...comp }, t: pick(S.data.t), f: Float64Array.from(idx, (i) => S.data.f[i] / model.base[i]), e: Float64Array.from(idx, (i) => S.data.e[i] / model.base[i]), model: pick(model.tr), tmid: tc, x0: tc - half, x1: tc + half, cursor: S.t,
    label: `${planetLabel()} · transit ${E} · the moon’s effects in isolation`, info: [`Rm/R★ = ${moon.rmoon.toFixed(4)}`, `P moon = ${moon.permoon.toFixed(3)} d`] };
}

/**
 * One step to a joint fit of the light curve, velocities and listed times: a/R★ from Kepler's law (one orbit for all),
 * every kind of data that is loaded in the fit, and free the masses, the jitters, the period, T mid, Rp/R★ and i of
 * every planet (with e and ω, or √e cos ω and √e sin ω, when the orbit is eccentric). Returns what is free.
 */
function setupJointFit() {
  if (!S.rv.length) throw new Error('a joint fit needs radial velocities: add them on the Data tab (Find radial velocities)');
  if (!(S.data.tRef > 0) && S.rv.some((r) => r.t.length)) throw new Error('the light curve has no dates, so it cannot share an orbit with the velocities: load a dated light curve or look the planet up');
  pushUndo();
  const n = UNDO.length;
  if (!S.kepler) setKepler(true);
  S.use = { lc: true, rv: true, timing: S.timing.rows.length > 0 }; ensureRVParams();
  for (const prm of fitParams()) {
    const b = prm.base;
    if (['mplanet', 'per', 'tmid', 'rprs', 'inc', 'jit'].includes(b)) S.free[prm.key] = true;
    if (['ecc', 'omega', 'secosw', 'sesinw'].includes(b)) S.free[prm.key] = (planetValues(S.values, prm.planet || '').ecc || 0) > 0.01;
    if (!S.priors[prm.key]) S.priors[prm.key] = defaultPrior(prm.key);
  }
  resetPriors(fitParams().filter((p) => p.base === 'per' || p.base === 'tmid').map((p) => p.key));
  UNDO.length = n;   // one step for undo
  S.fit = null; S.range = 'full'; buildPanels(); refresh(); showTab('fit'); flash('Joint fit set up: Kepler’s law on, masses and jitters free');
  return freeList().map((p) => p.key);
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
/**
 * Add a planet: a copy of the one on show at about twice its period, to be edited, with any `values` given
 * (planet fields by name, T mid relative to the time reference) in place of the copied ones. Returns its letter.
 */
function addPlanetWith({ letter, values = {} } = {}) {
  const used = new Set(S.planets.map((p) => p.letter));
  if (!letter) letter = 'bcdefghijklmnop'.split('').find((c) => !used.has(c));
  if (!letter || used.has(letter)) return null;
  pushUndo();
  const from = planetValues(S.values), sfx = letter;
  for (const f of PLANET_FIELDS) { if (f === 'K') continue; const v = values[f] !== undefined ? values[f] : f === 'per' ? Number((from.per * 2.3).toPrecision(6)) : f === 'ars' ? Number((from.ars * Math.pow((values.per || from.per * 2.3) / from.per, 2 / 3)).toPrecision(6)) : f === 'tmid' ? from.tmid + 0.37 * from.per : f === 'inc' ? Math.max(from.inc, 89.5) : from[f]; if (v !== undefined) S.values[planetKey(f, sfx)] = v; }
  if (!(S.values[planetKey('mplanet', sfx)] >= 0)) S.values[planetKey('mplanet', sfx)] = from.mplanet || 0;
  S.planets = [...S.planets, { sfx, letter }]; S.pl = sfx; S.fit = null; S.range = 'full';
  resetPriors(PLANET_FIELDS.filter((f) => f !== 'K').map((f) => planetKey(f, sfx)));
  S.t = S.values[planetKey('tmid', sfx)]; buildPanels(); refresh(true); flash(`Planet ${letter} added`);
  return letter;
}
const addPlanet = () => { addPlanetWith(); };
function removePlanet(sfx) {
  if (!sfx || S.planets.length < 2) return;
  pushUndo();
  for (const f of [...PLANET_FIELDS, ...MOON_FIELDS, ...PHASE_FIELDS]) { const k = planetKey(f, sfx); delete S.values[k]; delete S.free[k]; delete S.priors[k]; }   // the planet with its moon and its own light
  S.planets = S.planets.filter((p) => p.sfx !== sfx);
  if (!S.planets.some((p) => hasPhase(p.sfx))) S.phase = null;
  if (S.nbody && S.planets.length < 2) S.nbody = null; S.pl = ''; S.fit = null; S.range = 'full';
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
  if (r.source === 'table') S.ldMsg = `Sliders set from <b>${ldTableName()}</b> at T eff ${S.star.teff}, log g ${S.star.logg}, [Fe/H] ${S.star.feh}: ${list} (${r.info.method}${r.info.clamped ? ', <span style="color:var(--warn)">outside the table, clamped to its edge</span>' : ''}).`;
  else { const [w0, w1] = bandRange(); S.ldMsg = `Sliders set from the grey-atmosphere estimate for ${S.star.teff} K, ${w0}–${w1} nm: ${list}. The law fits the computed profile (dashed blue) to ${(r.rms * 100).toFixed(1)}% rms. log g and [Fe/H] were not used.`; }
  resetPriors(['ld0', 'ld1', 'ld2', 'ld3']);
  buildPanels(); refresh(); flash('Limb darkening updated');
}

/** How limb darkening enters the fit: 'coeffs' (the coefficients are parameters) or 'star' (they follow T eff and [Fe/H]). */
function setLDMode(val) {
  S.ldMode = val; S.fit = null; S.range = 'full'; syncStarLD.key = null;
  ['ld0', 'ld1', 'ld2', 'ld3'].forEach((k) => (S.free[k] = false));
  if (val === 'coeffs') { S.free.teff = false; S.free.feh = false; }
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

/** Options for the light-curve reader: the user's choices on the Data tab and the host's position (for the conversion to BJD_TDB). */
function readOpts(o = S.parseOpts) { const c = Number.isFinite(S.star.ra) && Number.isFinite(S.star.dec) ? { ra: S.star.ra, dec: S.star.dec } : null; return { time: o.time, flux: o.flux, timeStandard: o.tstd || 'auto', coords: c }; }
const hostKey = (s) => String(s || '').toLowerCase().replace(/\s+[a-z]$/, '').replace(/[^a-z0-9]/g, '');
/** Read a light curve; when the file names another planet than the system on show, its times are not converted with this host's position. */
function readLightCurve(text, name, o = S.parseOpts) {
  const opts = readOpts(o), p = parseLightCurve(text, name, opts);
  if (opts.coords && p.timeConverted && p.meta.planet && hostKey(p.meta.planet) !== hostKey(S.name)) return parseLightCurve(text, name, { ...opts, coords: null });
  return p;
}
function loadText(text, name, msgEl) {
  try {
    const p = readLightCurve(text, name, S.parseOpts);
    pushUndo();
    S.raw = { text, name };
    if (p.meta.planet) S.name = p.meta.planet;
    if (p.meta.priors) Object.assign(S.values, p.meta.priors);        // AAVSO reports carry the ephemeris they were reduced with
    if (p.meta.tmid !== undefined) S.values.tmid = p.meta.tmid;
    if (p.meta.priors) p.notes.push('system parameters taken from the file’s #PRIORS line');
    setData(p);
    S.exptimeMin = p.meta.exptimeMin || cadenceMin(p);   // no exposure in the file: assume the cadence
    if (p.meta.priors && Object.keys(p.meta.priors).some((k) => k.startsWith('ld'))) S.ldLaw = 'nonlinear';
    resetPriors(activeParams(S.ldLaw, true).map((x) => x.key));
    S.t = S.values.tmid; S.planets = [{ sfx: '', letter: 'b' }]; S.pl = ''; S.use = { ...S.use, lc: true }; S.view = 'lc'; buildPanels(); refresh(true);
  } catch (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--bad)'; } else throw err; }
}

function buildDataTab() {
  const el = $('#tab-data'); el.innerHTML = '';
  const d = S.data, n = d.t.length;
  const med = (a) => Float64Array.from(a).sort()[a.length >> 1];
  const cad = med(Float64Array.from({ length: n - 1 }, (_, i) => d.t[i + 1] - d.t[i])) * 1440;
  if (S.note) el.append(h('p', { class: 'note callout' }, S.note));
  projectTargetOffer(el);
  el.append(h('h3', {}, 'Current light curve'));
  el.append(h('div', { class: 'kv', html: [['Source', d.name], ['Points', n], ['Span', ((d.t[n - 1] - d.t[0]) * 24).toFixed(2) + ' h'], ['Cadence', cad.toFixed(2) + ' min'], ['Median error', (med(d.e) * 1e6).toFixed(0) + ' ppm'], ['Airmass column', d.airmass ? (d.epoch ? `${d.segments.filter((x) => x.airmass).length} of ${d.segments.length} epochs` : 'yes') : 'no'], ...(d.timeStandard ? [['Times', d.timeConverted ? `BJD_TDB (from ${TIME_STANDARDS[d.timeStandard].label.split(' (')[0]})` : TIME_STANDARDS[d.timeStandard].label.split(' (')[0]]] : [])].map(([k, v]) => `<div><span>${k}</span><b style="font-family:inherit;font-size:12px">${v}</b></div>`).join('') }));
  if (d.notes && d.notes.length) el.append(h('p', { class: 'note' }, 'Notes: ' + d.notes.join('; ') + '.'));
  detrendBlock(el);
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
    const sel = (key, opts, cur) => { const s = h('select', { 'aria-label': key }, [['auto', `Auto (${(opts[cur] || {}).label || opts[cur] || 'none'})`], ...Object.entries(opts).map(([k, v]) => [k, v.label || v])].map(([k, t]) => h('option', { value: k, selected: (S.parseOpts[key] || 'auto') === k }, t))); s.addEventListener('change', () => { S.parseOpts = { ...S.parseOpts, [key]: s.value }; loadText(S.raw.text, S.raw.name, $('#datamsg')); }); return s; };
    el.append(h('div', { class: 'field' }, h('span', {}, 'Time system'), sel('time', TIME_SYSTEMS, d.timeSystem)), h('div', { class: 'field', title: 'What the times are: where the clock is (Earth, Sun, solar-system barycentre) and which scale it keeps. JD and HJD in UTC are converted to BJD_TDB with the host’s position (System tab, or the catalogue).' }, h('span', {}, 'Time standard'), sel('tstd', TIME_STANDARDS, d.timeStandard || 'unknown')), h('div', { class: 'field' }, h('span', {}, 'Flux units'), sel('flux', FLUX_UNITS, d.fluxUnits)));
  }
  el.append(h('p', { class: 'note' }, S.exptimeMin > 0 ? `Exposure taken as ${Number(S.exptimeMin.toFixed(2))} min (${Math.abs(S.exptimeMin - cad) < 0.02 * cad ? 'the cadence' : 'from the file or example'}): the model is averaged over it when that is long enough to blur ingress and egress.` : 'The model is evaluated at each time stamp, with no averaging over the exposure.'));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', title: 'Multiply the error bars by one factor (per epoch) so that the reduced χ² of the current model is 1; their relative sizes are kept', onclick: rescaleErrors }, 'Rescale errors so χ²/dof = 1')), h('p', { class: 'note', id: 'rescalemsg' }));
  el.append(h('p', { class: 'note' }, 'The evidence depends on the error bars, so runs are only compared when they used the same data and errors.'));

  el.append(h('h3', {}, 'Use your own data'));
  const msg = h('p', { class: 'note', id: 'datamsg' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.tbl,.fits,.fit,.fts,.gz', 'aria-label': 'Light curve file' });
  // a FITS light-curve table (TESS, Kepler, K2, or any table with time and flux columns) becomes text first
  const textOf = async (fl) => { const b = await fl.arrayBuffer(); if (!looksLikeFits(b)) return new TextDecoder().decode(b); const { csv, meta } = await lightCurveFromFits(b); msg.textContent = `${fl.name}: ${meta.fluxColumn}, ${meta.kept} cadences (${meta.dropped.quality} flagged, ${meta.dropped.nonfinite} blank left out).`; return csv; };
  const safely = (fn) => async (...a) => { try { await fn(...a); } catch (err) { msg.textContent = String(err.message || err); msg.style.color = 'var(--bad)'; } };
  const fresh = (text, name) => { S.parseOpts = { time: 'auto', flux: 'auto' }; loadText(text, name, msg); };
  file.addEventListener('change', safely(async () => { if (file.files[0]) fresh(await textOf(file.files[0]), file.files[0].name); }));
  const drop = h('div', { class: 'drop', title: 'Text tables (CSV, AAVSO and EXOTIC files) or FITS light-curve tables (TESS, Kepler, K2: the corrected flux, quality-flagged cadences left out)' }, 'Drop a light curve here (text or a TESS / Kepler FITS table), or ', file);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', safely(async (e) => { e.preventDefault(); drop.classList.remove('over'); const fl = e.dataTransfer.files[0]; if (fl) fresh(await textOf(fl), fl.name); }));
  const ta = h('textarea', { placeholder: 'or paste rows: time, flux, error, airmass', 'aria-label': 'Paste light curve' });
  // a further light curve of the same planet, fitted together with what is loaded
  const more = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.tbl,.fits,.fit,.fts,.gz', hidden: true, multiple: true, 'aria-label': 'Light curve files to add as epochs' });
  more.addEventListener('change', safely(async () => { for (const fl of more.files) addEpochText(await textOf(fl), fl.name, $('#datamsg')); more.value = ''; }));
  el.append(drop, ta, h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => fresh(ta.value, 'Pasted light curve') }, 'Load pasted rows'),
    h('button', { class: 'btn', title: 'Keep the current light curve and fit this one together with it, as another epoch of the same planet', onclick: () => more.click() }, 'Add file as another epoch…'), more,
    h('button', { class: 'btn', title: 'Keep the current light curve and add the pasted rows as another epoch', onclick: () => addEpochText(ta.value, 'pasted epoch', msg) }, 'Add pasted as epoch')), msg);
  el.append(h('p', { class: 'note', html: 'Reads comma, tab, semicolon or space separated columns with or without a header; FITS light-curve tables from TESS, Kepler and K2 (the corrected flux, flagged cadences left out); <b>AAVSO exoplanet reports</b> and <b>EXOTIC FinalLightCurve</b> files (their metadata fills in the planet, exposure and ephemeris); times in JD/BJD, MJD, BTJD or BKJD; flux, magnitudes or millimagnitudes. Rows are sorted, duplicates and unreadable rows dropped, and flux normalised. The file never leaves your computer.' }));

  // ---- radial velocities
  el.append(h('h3', {}, 'Radial velocities' + (S.rv.length ? ` · ${S.rv.reduce((a, x) => a + x.t.length, 0)} points` : '')));
  if (S.rv.length) {
    const tb = h('tbody');
    S.rv.forEach((x, k) => tb.append(h('tr', {}, h('td', { title: x.source ? `${x.source.reference} · VizieR ${x.source.table}, column ${x.source.column} · star ${x.source.star} · retrieved ${x.source.retrieved}` : 'from a file' }, h('span', { class: 'swatch', style: `background:${GROUP_COLORS.dark[k % GROUP_COLORS.dark.length]}` }), x.name, x.source ? h('small', { class: 'rvsrc' }, ' ' + x.source.reference.replace(/,.*$/, '').replace(/ et al\./, ' et al.') + ' ' + (x.source.reference.match(/\d{4}/) || [''])[0]) : null), h('td', {}, String(x.t.length)), h('td', {}, (x.t[x.t.length - 1] - x.t[0]).toFixed(0)), h('td', {}, Float64Array.from(x.e).sort()[x.e.length >> 1].toFixed(1)),
      h('td', {}, h('button', { class: 'chip small', title: 'Remove this velocity set', 'aria-label': `Remove velocities ${x.name}`, onclick: () => removeRV(k) }, '✕')))));
    el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res timing' }, h('thead', { html: '<tr><th>Instrument</th><th>Points</th><th>Span d</th><th>± m/s</th><th></th></tr>' }), tb)));
  }
  el.append(rvArchiveBlock());
  const rvMsg = h('p', { class: 'note', id: 'rvmsg' });
  const rvFile = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv,.vels', hidden: true, multiple: true, 'aria-label': 'Radial velocity files' });
  rvFile.addEventListener('change', async () => { for (const fl of rvFile.files) addRVText(await fl.text(), fl.name, rvMsg); rvFile.value = ''; });
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => rvFile.click() }, 'Add velocities file…'), rvFile,
    h('button', { class: 'btn', title: 'Read the rows in the paste box above as velocities', onclick: () => addRVText(ta.value, 'RV', rvMsg) }, 'Add pasted as velocities')), rvMsg);
  el.append(h('p', { class: 'note', html: 'Columns: time, velocity, uncertainty, and optionally an instrument name (a header such as <b>BJD, Vel(m/s), ErrVel(m/s), Telescope</b> lets them come in any order). Each instrument is its own dataset with its own zero point and jitter. Velocities in m/s; a header saying km/s is converted.' }));

  el.append(h('h3', {}, 'Simulate an observation'));
  const o = S.synth, f = (label, key, attrs, title) => { const i = h('input', { type: 'number', value: o[key] ?? 1, ...attrs }); i.addEventListener('change', () => (o[key] = Number(i.value))); return h('div', { class: 'field', title: title || '' }, h('span', {}, label), i); };
  const am = h('input', { type: 'checkbox', checked: !!o.airmass }); am.addEventListener('change', () => (o.airmass = am.checked));
  el.append(f('Cadence (min)', 'exptimeMin', { min: 0.05, step: 0.5 }, 'One exposure after another: the cadence is also the exposure time'), f('Noise (ppm)', 'noisePpm', { min: 1, step: 10 }, 'White noise per exposure'), f('Baseline (h)', 'baselineHr', { min: 0, step: 0.25 }, 'Out-of-transit time observed before and after the transit'), f('Seed', 'seed', { min: 1, step: 1 }),
    f('Transits', 'nEpochs', { min: 1, max: 200, step: 1 }, 'How many transits to observe. More than one makes a multi-epoch dataset: each night has its own baseline, and the period can be fitted'), f('Every n-th orbit', 'epochStep', { min: 1, step: 1 }, 'Orbits between one simulated transit and the next'));
  el.append(h('label', { class: 'tog' }, am, 'Add an airmass trend (ground-based night)'));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', onclick: () => { pushUndo(); makeSynthetic(true); S.t = cur(S.values).tmid; buildPanels(); refresh(true); } }, 'Generate from current system')));
  el.append(h('p', { class: 'note' }, 'Each transit is covered with the baseline on each side; the number of points per transit is that length divided by the exposure. The current slider values become the hidden truth, marked on the posterior plot after a fit.'));
}

/** With an observing project open whose target is not this system: offer to make it the target (src/site/project.js). */
function projectTargetOffer(el) {
  let pj = null; try { pj = projectHandle().get(); } catch { return; }
  if (!pj || S.preset !== 'session' || (pj.target && hostKey(pj.target.name) === hostKey(S.name))) return;
  const letter = (S.planets.find((p) => p.sfx === S.pl) || S.planets[0]).letter, name = /\s[a-z]$/.test(S.name) ? S.name : `${S.name} ${letter}`;
  const set = () => { const v = cur(S.values), d = deriveSystem(v, starNow()), tRef = S.data.tRef || 0; projectHandle().set({ target: { name, host: S.name, ...(Number.isFinite(S.star.ra) ? { ra: S.star.ra, dec: S.star.dec } : {}), per: v.per, tmid: v.tmid + tRef, t14: d.t14, source: 'analyzer' } }); buildDataTab(); flash(`${name} is the project’s target`); };
  el.append(h('div', { class: 'btnrow' }, h('span', { class: 'note' }, pj.target ? `Your observing project is about ${pj.target.name}.` : 'Your observing project has no target yet.'), h('button', { class: 'chip small', onclick: set }, `Make ${name} the target`)));
}

/** "Find radial velocities for <system>": the archive search and what it found, set by set, with the buttons to add them. */
function rvArchiveBlock() {
  const R = S.rvSearch, box = h('div', { class: 'rvfind', id: 'rvfind' }), msg = h('p', { class: 'note', id: 'rvfindmsg' });
  const run = async () => { msg.textContent = 'Searching the archives…'; msg.style.color = ''; try { await findArchiveRV(); } catch (err) { S.rvSearch = null; buildDataTab(); const m = $('#rvfindmsg'); if (m) { m.textContent = err.message; m.style.color = 'var(--bad)'; } } };
  box.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', id: 'rvfindbtn', disabled: !!(R && R.busy), title: `Search ${RV_SOURCES.map((x) => x.label).join('; ')} at the host’s position (VizieR, CfA and IDIA mirrors)`, onclick: run }, R && R.busy ? 'Searching…' : `Find radial velocities for ${S.name}`)), msg);
  if (!R || R.busy || !R.results) { box.append(h('p', { class: 'note' }, 'Searches the public HIRES (Keck), HARPS (ESO, RVBank) and Lick velocity catalogues on VizieR at the star’s position. Each instrument era with its own zero point is listed separately; add the ones you want and each becomes its own dataset with its own zero point and jitter. Nothing but the star’s position is sent.')); return box; }
  if (hostKey(R.name) !== hostKey(S.name)) { box.append(h('p', { class: 'note' }, `The last search was for ${R.name}. Search again for ${S.name}.`)); return box; }
  const rows = rvSearchRows(), tb = h('tbody'), picks = new Set();
  for (const r of R.results) {
    const ref = h('a', { href: 'https://doi.org/' + r.source.doi, target: '_blank', rel: 'noopener', title: `${r.source.reference} · ${r.source.bibcode}` }, r.source.reference.replace(/^(\S+),.*(\d{4}).*$/, '$1 $2'));
    tb.append(h('tr', { class: 'sec' }, h('td', { colspan: 5 }, h('b', {}, r.source.label), ' · ', ref, r.status === 'found' ? ` · ${r.star}${Number.isFinite(r.sep) ? ` at ${r.sep.toFixed(1)}″` : ''}` : r.status === 'none' ? ' · not observed' + (/one mirror/.test(r.message || '') ? ' (only one mirror could be asked)' : '') : h('span', { style: 'color:var(--warn)' }, ' · ' + (r.message || 'no answer')))));
    for (const x of r.sets) {
      const row = rows.find((y) => y.id === rvSetId(r.source, x)), cb = h('input', { type: 'checkbox', disabled: row.added, 'aria-label': `Select ${x.name}` });
      cb.addEventListener('change', () => { if (cb.checked) picks.add(row.id); else picks.delete(row.id); addSel.disabled = !picks.size; });
      tb.append(h('tr', {}, h('td', {}, cb), h('td', {}, x.name, row.added ? h('small', {}, ' added') : null), h('td', {}, String(x.n)), h('td', {}, x.span > 730 ? (x.span / 365.25).toFixed(1) + ' yr' : x.span.toFixed(0) + ' d'), h('td', {}, x.medErr.toFixed(1))));
    }
  }
  const addSel = h('button', { class: 'btn', disabled: true, onclick: () => { try { addArchiveRV([...picks]); } catch (err) { const m = $('#rvfindmsg'); if (m) { m.textContent = err.message; m.style.color = 'var(--bad)'; } } } }, 'Add selected as velocity sets');
  box.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res timing rvarch' }, h('thead', { html: '<tr><th></th><th>Set</th><th>Points</th><th>Span</th><th>± m/s</th></tr>' }), tb)), h('div', { class: 'btnrow' }, addSel));
  const notes = [...new Set(R.results.flatMap((r) => r.notes))];
  box.append(h('p', { class: 'note', html: `Searched ${new Date(R.at).toLocaleString()} at RA ${R.ra.toFixed(4)}°, Dec ${R.dec.toFixed(4)}° (within 10″). ${notes.length ? notes.join('; ') + '. ' : ''}The two HIRES catalogues hold the same observations (Tal-Or et al. 2019 corrects Butler et al. 2017 for small nightly offsets): add one of them. Times are BJD as published (Lick: JD − 2400000). The source, star name and retrieval time are kept with each set and saved in the session.` }));
  return box;
}

function rescaleErrors() {
  const say = (t, bad) => { const e = $('#rescalemsg'); if (e) { e.innerHTML = t; e.style.color = bad ? 'var(--bad)' : ''; } flash(bad ? 'Errors not rescaled' : 'Errors rescaled'); };
  if (!model || !model.valid) return say('Nothing changed. Rescaling needs a valid model to take residuals from: on the System tab, make sure the planet transits and the limb darkening badge reads “physical profile”.', true);
  const d = S.data, n = d.t.length, ne = nEpochs();
  const pred = Float64Array.from(d.f, (_, i) => model.base[i] * model.tr[i]);
  // the fit's own free parameters (S.free also remembers keys of models that are switched off)
  const factors = errorScaleFactors(d.f, d.e, pred, d.epoch, ne, fitParams().filter((p) => S.free[p.key]).length);
  if (!factors) return say('Nothing changed: some error bars are zero or missing, so they cannot be scaled by a common factor.', true);
  pushUndo();
  // every error bar keeps its size relative to the others in its epoch: each is multiplied by its epoch's factor
  const e = Float64Array.from(d.e, (x, i) => x * factors.beta[d.epoch ? d.epoch[i] : 0]);
  const fmt = (b) => '×' + b.toFixed(3);
  S.data = { ...d, e, notes: [...(d.notes || []).filter((x) => !x.startsWith('errors rescaled')), `errors rescaled ${factors.beta.map(fmt).join(', ')} so that χ²/dof = 1${ne > 1 ? ', epoch by epoch' : ''}`] };
  S.fit = null; S.dataId++; S.range = 'full'; buildPanels(); refresh();
  const same = factors.beta.every((b) => Math.abs(b - 1) < 0.02);
  say((same ? `The error bars already matched the scatter (χ²/dof ${factors.before.toFixed(2)}): every factor is within 2% of 1.` : `Error bars multiplied by <b>${factors.beta.map(fmt).join(', ')}</b>${ne > 1 ? ' (one factor per epoch)' : ''}; their relative sizes are kept. χ²/dof was ${factors.before.toFixed(2)} (${factors.dof.toFixed(0)} degrees of freedom) and is now 1.00.`)
    + ' The residuals are measured about the model on screen, so a poor model inflates them: rescale after the model fits, then run the fit again. Undo (Ctrl/⌘+Z) brings the old error bars back.' + (same ? '' : ' Earlier runs used the old error bars, so their evidences are no longer comparable.'));
}

// ---- Fit tab ------------------------------------------------------------------

/**
 * A preset of wide bounds for a light-curve fit, as used for survey and citizen-science light curves (they are the
 * bounds of EXOTIC's light-curve fit, exotic.py): Rp/R★ uniform in [0, 1.25 × value], inclination ± 5° capped at 90°,
 * mid-transit within a quarter of an orbit (at most ± 0.1 d), airmass coefficient in [−3, 3]; everything else fixed.
 * Applied to every planet and epoch of the model.
 */
const WIDE_BOUNDS_HELP = 'Frees Rp/R★, the inclination, the mid-transit time and the airmass coefficients, each with a wide uniform prior around its current value, and holds everything else fixed: Rp/R★ in [0, 1.25 × value], inclination ± 5° (at most 90°), mid-transit ± a quarter of an orbit (at most ± 0.1 d), airmass coefficient in [−3, 3]. These are the bounds commonly used for survey and citizen-science light curves, so a fit made with them can be compared with results obtained that way. Undo brings your priors back.';
function widePriors() {
  pushUndo();
  const r = (x) => Number(x.toPrecision(7));
  for (const prm of fitParams()) {
    const k = prm.key, v = paramValue(k) ?? 0, pv = prm.planet !== undefined ? planetValues(S.values, prm.planet) : null;
    let pr = null;
    if (prm.base === 'rprs') pr = { type: 'uniform', a: 0, b: r(1.25 * v) };
    else if (prm.base === 'inc') pr = { type: 'uniform', a: r(v - 5), b: Math.min(90, r(v + 5)) };
    else if (prm.base === 'tmid') pr = { type: 'uniform', a: r(v - Math.min(0.25 * pv.per, 0.1)), b: r(v + Math.min(0.25 * pv.per, 0.1)) };
    else if (prm.base === 'a2') pr = { type: 'uniform', a: -3, b: 3 };
    S.free[k] = !!pr; if (pr) S.priors[k] = pr;
  }
  S.fit = null; S.range = 'full'; buildPanels(); refresh(); flash('Wide survey bounds applied');
}
function buildFitTab() {
  const el = $('#tab-fit'); el.innerHTML = '';
  // how limb darkening enters the fit
  const mode = (val, label) => { const r = h('input', { type: 'radio', name: 'ldmode', value: val, checked: S.ldMode === val }); r.addEventListener('change', () => { pushUndo(); setLDMode(val); buildPanels(); refresh(); }); return h('label', { class: 'tog' }, r, label); };
  // which kinds of data the likelihood uses
  const nrv = S.rv.reduce((a, x) => a + x.t.length, 0), ntim = S.timing.rows.length;
  const inc = (key, label, dis, title) => { const c = h('input', { type: 'checkbox', checked: !!S.use[key] && !dis, disabled: dis }); c.addEventListener('change', () => { pushUndo(); S.use = { ...S.use, [key]: c.checked }; S.fit = null; S.range = 'full'; if (key === 'rv') ensureRVParams(); buildPanels(); refresh(); }); return h('label', { class: 'tog', title }, c, label); };
  if (S.note) el.append(h('p', { class: 'note callout' }, S.note));
  el.append(h('h3', {}, 'Data in the fit'));
  el.append(inc('lc', `Light curve · ${S.data.t.length} points` + (nEpochs() > 1 ? ` in ${nEpochs()} epochs` : ''), false, 'Transit photometry'),
    inc('rv', nrv ? `Radial velocities · ${nrv} points from ${S.rv.length} instrument${S.rv.length > 1 ? 's' : ''}` : 'Radial velocities · none loaded (Data tab)', !nrv, 'The star’s reflex motion: planet masses, eccentricity, periastron'),
    inc('timing', ntim ? `Mid-transit and mid-eclipse times · ${ntim} from the Timing tab` : 'Mid-transit times · none listed (Timing tab)', !ntim, 'Earlier mid-times constrain the period, and an eclipse time the eccentricity'));
  if ((rvOn() || (S.use.timing && ntim)) && S.use.lc && !S.kepler) el.append(h('p', { class: 'note callout warn', html: 'Photometry and velocities are being fitted with a free a/R★, so they do not share one orbit. Tick <b>a/R★ from Kepler’s law</b> on the System tab, or press <b>Set up joint fit</b>.' }));
  if (S.rv.length && !(S.use.lc && rvOn() && S.kepler && S.planets.every((p) => S.free[planetKey('mplanet', p.sfx)]))) el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', title: 'Kepler’s law on, light curve and velocities (and listed times) in the fit, masses, jitters, period, T mid, Rp/R★ and i free', onclick: () => { try { setupJointFit(); } catch (err) { flash(err.message); } } }, 'Set up joint fit')));

  el.append(h('h3', {}, 'Limb darkening in the fit'));
  el.append(mode('coeffs', 'Sample the coefficients directly'), mode('star', 'Follow the star: sample T eff' + (gridFor(S.ldLaw) ? ' and [Fe/H]' : '')));
  el.append(h('p', { class: 'note', html: S.ldMode === 'star'
    ? `Each sample of T eff${gridFor(S.ldLaw) ? ' and [Fe/H]' : ''} is turned into ${LD_LAWS[S.ldLaw].label} coefficients through ${gridFor(S.ldLaw) ? `<b>${ldTableName()}</b>` : 'the grey-atmosphere estimate'}, so the coefficients stay correlated the way a real star’s are. Give T eff a Normal prior at its measured uncertainty.` + (gridFor(S.ldLaw) ? '' : ' Without a model-atmosphere table [Fe/H] has no effect, so it is not offered; the spread this produces reflects the T eff uncertainty only, not the uncertainty of the atmosphere model.')
    : 'Free coefficients explore every combination the prior allows, whether or not a star could produce it. “Follow the star” samples the stellar parameters instead.' }));

  el.append(h('h3', {}, 'Parameters & priors', h('button', { class: 'chip small', id: 'widebounds', title: WIDE_BOUNDS_HELP, onclick: widePriors }, 'Wide survey bounds')));
  // eccentric orbits: e and ω, or √e cos ω and √e sin ω (no edge at e = 0, no wrap in ω)
  { const pv = cur(S.values), sq = usesSqrtE(), show = sq || pv.ecc > 0 || S.free[PK('ecc')] || S.free[PK('omega')];
    if (show) { const c = h('input', { type: 'checkbox', checked: sq }); c.addEventListener('change', () => setSqrtE(c.checked)); el.append(h('label', { class: 'tog', title: 'Eastman et al. (2013): uniform priors on √e cos ω and √e sin ω are uniform in e and ω, and the sampler sees neither the boundary at e = 0 nor the wrap of ω at ±180°. Good for small or poorly known eccentricities. The orbit and the free flags carry over.' }, c, `Sample √e cos ω, √e sin ω instead of e, ω${S.planets.length > 1 ? ` (planet ${(S.planets.find((p) => p.sfx === S.pl) || {}).letter})` : ''}`)); } }
  // one collapsible group per planet, then limb darkening, baselines, velocities and the star
  const groups = new Map(), groupOf = (prm) => (prm.group === 'planet' ? 'Planet ' + (S.planets.find((p) => p.sfx === prm.planet) || {}).letter : prm.group === 'moon' ? 'Moon of ' + (S.planets.find((p) => p.sfx === prm.planet) || {}).letter : prm.group === 'phase' ? 'Light of planet ' + (S.planets.find((p) => p.sfx === prm.planet) || {}).letter : prm.group === 'ld' ? 'Limb darkening' : prm.group === 'baseline' ? 'Light-curve baseline' : prm.group === 'rv' ? 'Radial velocity' : 'Star');
  for (const prm of fitParams()) {
    const gk = groupOf(prm); if (!groups.has(gk)) groups.set(gk, h('tbody')); const tb = groups.get(gk);
    const key = prm.key; if (!S.priors[key] || !PRIOR_TYPES[S.priors[key].type]) S.priors[key] = defaultPrior(key);
    const tr = h('tr', { class: S.free[key] ? '' : 'off' });
    const cb = h('input', { type: 'checkbox', checked: !!S.free[key], 'aria-label': 'Fit ' + prm.label });
    const sel = h('select', { 'aria-label': 'Prior for ' + prm.label }, Object.entries(PRIOR_TYPES).map(([k, v]) => h('option', { value: k, selected: S.priors[key].type === k }, v.label)));
    const args = h('div', { class: 'args' }), err = h('div', { class: 'err' });
    const renderArgs = () => {
      args.innerHTML = '';
      const pr = S.priors[key];
      for (const [f, name] of PRIOR_TYPES[pr.type].args) {
        const i = h('input', { type: 'number', step: 'any', inputmode: 'decimal', value: pr[f] ?? '', disabled: !S.free[key], 'aria-label': `${prm.label} prior ${name}`, ...(name === 'std' ? { min: '0' } : {}) });
        // a value that would make the prior impossible (σ ≤ 0, max ≤ min, not a number) is refused while typing and on leaving
        const check = () => { const trial = { ...pr, [f]: Number(i.value) }, bad = i.value.trim() === '' || !Number.isFinite(Number(i.value)) ? 'a number is needed' : validatePrior(trial); i.classList.toggle('bad', !!bad); i.setAttribute('aria-invalid', bad ? 'true' : 'false'); return bad; };
        i.addEventListener('input', () => { const bad = check(); err.textContent = bad ? `${name}: ${bad}` : ''; });
        i.addEventListener('change', () => {
          const bad = check();
          if (bad) { i.value = pr[f] ?? ''; i.classList.remove('bad'); i.setAttribute('aria-invalid', 'false'); err.textContent = `${name} not changed: ${bad}.`; return; }
          pushUndo(); S.priors[key] = { ...pr, [f]: Number(i.value), user: true, from: undefined }; renderArgs(); if (S.range === 'prior') { buildSystemTab(); refresh(); }
        });
        args.append(h('label', { class: 'arg' }, h('span', {}, name), i));   // says whether the box is a min/max or a mean/std
      }
      err.textContent = S.free[key] ? validatePrior(pr) || '' : '';
      if (pr.from && S.free[key]) args.title = `Range ${pr.from}`;
    };
    cb.addEventListener('change', () => {
      pushUndo(); S.free[key] = cb.checked; tr.className = cb.checked ? '' : 'off';
      // freeing a limb-darkening coefficient: its range from the star, unless the user set one
      if (cb.checked && /^ld[0-3]$/.test(baseKey(key)) && !(S.priors[key] && S.priors[key].user)) S.priors[key] = defaultPrior(key);
      renderArgs(); countFree();
    });
    sel.addEventListener('change', () => {
      pushUndo();
      const v = paramValue(key), old = S.priors[key];
      if (sel.value === 'normal') S.priors[key] = { type: 'normal', a: Number(((old.a + old.b) / 2).toPrecision(7)), b: Number(((old.b - old.a) / 4).toPrecision(3)) };
      else if (old.type === 'normal') S.priors[key] = { type: 'uniform', a: Number((old.a - 3 * old.b).toPrecision(7)), b: Number((old.a + 3 * old.b).toPrecision(7)) };
      else S.priors[key] = defaultPrior(key).type === 'uniform' ? defaultPrior(key) : { type: 'uniform', a: Number((v * 0.99).toPrecision(7)), b: Number((v * 1.01).toPrecision(7)) };
      renderArgs();
    });
    renderArgs();
    tr.append(h('td', {}, cb), h('td', { class: 'nm', title: prm.help || '' }, (prm.group === 'planet' || prm.group === 'moon' || prm.group === 'phase' ? prm.label.split(' · ')[0] : prm.label) + (prm.unit ? ' (' + prm.unit + ')' : '')), h('td', {}, sel), h('td', {}, args, err));
    tb.append(tr);
  }
  const meG = 'Planet ' + (S.planets.find((p) => p.sfx === S.pl) || {}).letter, solo = S.planets.length === 1;
  for (const [gk, tb] of groups) {
    const nfree = [...tb.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).length, count = h('small', {}, nfree ? `${nfree} free` : 'all fixed');
    tb.addEventListener('change', () => { const k = [...tb.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).length; count.textContent = k ? `${k} free` : 'all fixed'; });
    // open: everything for a single planet; otherwise the planet on show and any group with something free
    el.append(h('details', { class: 'group', open: solo || gk === meG || nfree > 0 }, h('summary', {}, gk.startsWith('Planet ') && !solo ? h('span', { class: 'pdot', style: `--pc:${planetColor((S.planets.find((p) => 'Planet ' + p.letter === gk) || {}).sfx)}` }) : null, gk, count),
      h('table', { class: 'pri' }, h('thead', {}, h('tr', {}, h('th', {}, 'Fit'), h('th', {}, 'Param'), h('th', {}, 'Prior'), h('th', {}, 'Arguments'))), tb)));
  }
  el.append(h('p', { class: 'note', id: 'freecount' }));
  el.append(h('p', { class: 'note', html: S.kepler
    ? 'a/R★ is not a parameter here: it follows from M★, R★, the period and the planet mass (Kepler’s law). Tick <b>M★</b> or <b>R★</b>, whose priors default to their catalogue errors, to let it move.'
    : 'a/R★ cannot be fitted: with the inclination free it is degenerate (the two trade off through the impact parameter). It is held at its System value. To let the orbit size vary, switch on <b>a/R★ from Kepler’s law</b> on the System tab and fit M★ instead.' }));
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
  el.append(fld('Live points', 'nlive', { min: 50, max: 4000, step: 50 }), fld('Stop at remainder', 'fracRemain', { min: 0.0001, max: 0.5, step: 0.005 }), fld('Seed', 'seed', { min: 1, step: 1 }), fld('Stop after (calls)', 'maxCalls', { min: 10000, step: 100000, title: 'Budget of likelihood evaluations. A run that reaches it stops and returns the posterior collected so far, marked as not converged.' }));
  el.append(h('p', { class: 'note', id: 'evnote' }));
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', id: 'runbtn', onclick: startFit }, 'Run nested sampling'), h('button', { class: 'btn danger', id: 'stopbtn', onclick: stopFit, disabled: true }, 'Stop'), h('span', { class: 'note', id: 'runmode' })));
  el.append(h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progress of the fit', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, h('i', { id: 'pbar' })), h('p', { class: 'note mono', id: 'pstat' }, 'Idle.'));
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
    S.free[k] = e.fit && baseKey(k) !== 'ars' && (k !== 'a2' || (!!S.data.airmass && !S.data.epoch));
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
function buildTiming() { timingRedraw = buildTimingTab($('#tab-timing'), { S, h, pushUndo, flash, slug, rebuild: buildTiming, applyEphemeris, per: () => cur(S.values).per, tmidKey: () => PK('tmid'), label: planetLabel });
  buildDynamics($('#tab-timing'), dynamicsApp());
  undoButtons();
}
/** Switch the N-body model on ({ epoch, ... }) or off (null). */
function setNbody(o) { S.nbody = o; S.fit = null; S.range = 'full'; if (o) { S.use = { ...S.use, timing: true }; } buildPanels(); }
/** What the Dynamics block and the companion search (src/ui/dynamics.js) work with. */
function dynamicsApp() {
  return { S, h, pushUndo, flash, rebuild: buildTiming, label: planetLabel, get theme() { return LC_THEMES.screen; }, star: starNow,
    planets: () => S.planets.map((p) => ({ ...p, ...planetValues(S.values, p.sfx) })), setNbody, addCompanion,
    /** n equal-weight draws of the current fit's posterior as { mstar, planets } (each planet's values, e and ω included), or null with no fit. */
    posterior(n = 60) {
      const F = S.fit, r = F && F.res; if (!r || !r.samples || !r.weights || !F.free) return null;
      const d = r.ndim, idx = resampleIndices(r.weights, n, makeRng(11)), st = starNow();
      return Array.from(idx, (i) => { const v = { ...S.values }; F.free.forEach((f, k) => (v[f.key] = r.samples[i * d + k])); return { mstar: v.mstar > 0 ? v.mstar : st.mstar, rstar: v.rstar > 0 ? v.rstar : st.rstar, planets: S.planets.map((p) => ({ ...p, ...planetValues(v, p.sfx) })) }; });
    } };
}
/** Put the companion found by the perturber search into the model as a planet, with the N-body model on and its mass, period and phase free. */
function addCompanion({ mass, period, tmid, inc, epoch, host, chi2 }) {
  pushUndo();
  const used = new Set(S.planets.map((p) => p.letter)), letter = 'bcdefghijklmnop'.split('').find((c) => !used.has(c)); if (!letter) return;
  const me = planetValues(S.values), st = starNow(), r6 = (x) => Number(x.toPrecision(9)), hostSfx = S.pl;
  const set = (k, v, free, prior) => { S.values[k] = v; S.free[k] = free; S.priors[k] = prior || defaultPrior(k); };
  // the transiting planet: its T0 and period are not sampled; the likelihood fits a straight line in epoch to its simulated times (nbody.linear)
  set(PK('per'), r6(host.per), false, { type: 'uniform', a: r6(host.per - 2e-4), b: r6(host.per + 2e-4) });
  set(PK('tmid'), r6(host.tmid), false, { type: 'uniform', a: r6(host.tmid - 0.002), b: r6(host.tmid + 0.002) });
  const K = (f) => planetKey(f, letter);
  set(K('per'), r6(period), true, { type: 'uniform', a: r6(period * 0.999), b: r6(period * 1.001) });   // narrow: the neighbouring period aliases fit almost as well
  set(K('tmid'), r6(tmid), true, { type: 'uniform', a: r6(tmid - 0.04 * period), b: r6(tmid + 0.04 * period) });
  set(K('mplanet'), Number(mass.toPrecision(4)), true, { type: 'uniform', a: 0, b: Number((3 * mass).toPrecision(3)) });
  set(K('inc'), inc, false); set(K('ecc'), 0, false); set(K('omega'), 0, false); set(K('rprs'), 0.03, false);
  S.values[K('ars')] = Number((me.ars * Math.pow(period / me.per, 2 / 3)).toPrecision(6));
  for (const p of S.planets) for (const f of ['rprs', 'inc', 'ecc', 'omega', 'mplanet']) if (S.free[planetKey(f, p.sfx)]) S.free[planetKey(f, p.sfx)] = false;
  S.planets = [...S.planets, { sfx: letter, letter }]; S.pl = hostSfx;
  // the grid's integrator settings: transit times good to about 0.1 s, twice as fast as the defaults
  S.nbody = { epoch, stepsPerOrbit: 20, exactSync: false, linear: true }; S.use = { lc: false, rv: false, timing: true }; S.fit = null; S.range = 'full';
  if (!(st.mstar > 0)) flash('Set the stellar mass on the System tab');
  buildPanels(); refresh(true); showTab('fit'); flash(`Companion ${letter} added${Number.isFinite(chi2) ? ` (χ² ${chi2.toFixed(1)})` : ''}: run the fit to refine it`);
}
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
  if (use.lc && S.nbody && S.nbody.linear && S.planets.length > 1) { stat.textContent = 'The N-body straight-line profile corrects times only and cannot be used with the light curve in the fit. Untick the light curve, or switch the profile off on the Timing tab (Dynamics) so the light curve comes from the integration.'; return; }
  if (use.rv && !S.kepler && S.planets.some((p) => !(planetValues(S.values, p.sfx).mplanet >= 0))) { stat.textContent = 'Give every planet a mass (System tab) before fitting velocities.'; return; }
  pushUndo();
  const tie = use.lc ? tieSpec(free) : null;
  const spec = { ...fitSpec(S.values, free, use), ldTie: tie, sampler: { ...S.sampler, names: free.map((f) => f.key), labels: free.map((f) => f.label) } };
  S.running = true; S.fit = null; $('#runbtn').disabled = true; $('#stopbtn').disabled = false; stat.textContent = 'Drawing live points…';
  const tieFn = tie ? makeLDTie(tie) : null;
  const withLD = (v) => { if (tieFn) { const o = [0, 0, 0, 0]; tieFn(v.teff ?? S.star.teff, v.feh ?? S.star.feh, o); for (let i = 0; i < 4; i++) v['ld' + i] = o[i] || 0; } return v; };
  lastProgress = null;
  // the run on every page's progress pill: time left, Stop, and a guard against leaving the page while it runs
  const job = startJob({ label: `Fit · ${S.name || 'analysis'}`, stop: () => stopFit(), show: () => showTab('fit') });
  const onProgress = (p) => {
    const fr = S.sampler.fracRemain, prem = Math.min(1, Math.max(0, 1 - Math.log(p.remFrac / fr) / Math.log(1 / fr)));
    const frac = 0.55 * (1 - Math.exp(-p.it / (6 * S.sampler.nlive))) + 0.45 * prem;
    lastProgress = { calls: p.ncalls, logZ: p.logZ, fraction: frac, iterations: p.it, efficiency: p.eff, elapsed_s: p.elapsed };
    $('#pbar').style.width = (100 * frac).toFixed(1) + '%'; $('#pbar').parentElement.setAttribute('aria-valuenow', Math.round(100 * frac));
    job.update({ fraction: frac, detail: `${p.ncalls.toLocaleString('en')} calls · ln Z ${p.logZ.toFixed(1)}` });
    stat.textContent = `iter ${p.it}  ·  calls ${p.ncalls}${p.maxCalls ? ' of ' + Number(p.maxCalls).toExponential(0).replace('e+', 'e') : ''}  ·  eff ${(p.eff * 100).toFixed(1)}%  ·  lnZ ${p.logZ.toFixed(2)}  ·  remainder ${(p.remFrac * 100).toFixed(p.remFrac < 0.1 ? 2 : 0)}%  ·  ${p.elapsed.toFixed(1)} s` + (p.mode === 'slice' ? '  ·  slice sampling' : '');
    S.live = { ...S.values }; p.keys.forEach((k, i) => (S.live[k] = p.best[i])); withLD(S.live);
    refresh();
  };
  const onDone = (res) => { job.finish(res && res.stopReason && res.stopReason !== 'converged' ? 'Stopped (not converged)' : 'Fit finished'); finishFit(res, free, withLD, tie); };
  const onError = (m) => { job.fail('Fit failed'); S.running = false; S.live = null; $('#runbtn').disabled = false; $('#stopbtn').disabled = true; stat.textContent = 'Fit failed: ' + m; refresh(); };

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
function stopFit() { if (!S.running) return; if (runner) runner.stop(); $('#pstat').textContent += '  ·  stopping…'; }
/**
 * How far the fit has come: { running, calls, logZ, eta_s, fraction, iterations, efficiency, elapsed_s }. `fraction` is
 * what the progress bar shows (an estimate from the iteration count and the evidence still unaccounted for), and
 * eta_s extrapolates the elapsed time with it, so it is rough; null until a tenth of the run is done.
 */
function fitProgress() {
  if (S.running) { const p = lastProgress || { calls: 0, logZ: null, fraction: 0, iterations: 0, efficiency: null, elapsed_s: 0 }; return { running: true, ...p, eta_s: p.fraction > 0.1 ? (p.elapsed_s * (1 - p.fraction)) / p.fraction : null }; }
  const r = S.fit && S.fit.res;
  return { running: false, calls: r ? r.ncalls : 0, logZ: r ? r.logZ : null, eta_s: r ? 0 : null, fraction: r ? 1 : 0, iterations: null, efficiency: r ? r.n / r.ncalls : null, elapsed_s: r ? r.elapsed : 0 };
}

const quant = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s[s.length >> 1]; return { med: m, plus: s[Math.floor(0.8413 * (s.length - 1))] - m, minus: m - s[Math.floor(0.1587 * (s.length - 1))] }; };

function finishFit(res, free, withLD, tie) {
  S.running = false; S.live = null;
  $('#runbtn').disabled = false; $('#stopbtn').disabled = true; $('#pbar').style.width = '100%'; $('#pbar').parentElement.setAttribute('aria-valuenow', 100);
  const d = res.ndim, n = res.n, rng = makeRng(7);
  const cols = free.map((_, k) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = res.samples[i * d + k]; return a; });
  const summary = free.map((f, k) => {
    let [lo, med, hi] = weightedQuantiles(cols[k], res.weights, [0.1587, 0.5, 0.8413]);
    // ω is an angle: summarised about its circular mean, so a posterior across ±180° is one peak (as session.js does)
    if (baseKey(f.key) === 'omega') { const c = summarizeDraws(cols[k], { period: 360, weights: res.weights, lo: f.prior && f.prior.type === 'uniform' && f.prior.b - f.prior.a <= 360 ? f.prior.a : -180 }); if (c) { med = c.med; lo = med - c.minus; hi = med + c.plus; } }
    return { key: f.key, label: f.label, unit: f.unit, med, plus: hi - med, minus: med - lo, best: res.maxPoint[k] };
  });
  // equal-weight draws: derived quantities (with the stellar uncertainties folded in) and the model band
  const NDRAW = 4000, idx = resampleIndices(res.weights, NDRAW, rng), st = starNow(), draws = {}, curves = [];
  // grid for the model band: the observed span, or the folded window around the best-fit transit
  const bestAll = { ...S.values }; free.forEach((f, k) => (bestAll[f.key] = res.maxPoint[k]));
  const bestV = planetValues(bestAll), many = S.planets.length > 1;
  let g0 = S.data.t[0], g1 = S.data.t[S.data.t.length - 1];
  if (S.fold) { g0 = Infinity; g1 = -Infinity; for (const x of foldTimes(S.data.t, bestV.per, bestV.tmid)) { g0 = Math.min(g0, x); g1 = Math.max(g1, x); } }
  const span = g1 - g0, NG = 500, G = Float64Array.from({ length: NG }, (_, i) => g0 - 0.05 * span + (1.1 * span * i) / (NG - 1));
  const gauss = (m, s) => (s > 0 ? Math.max(1e-6, m + s * rng.normal()) : m);
  const fitsTeff = free.some((f) => f.key === 'teff'), fitsFeh = free.some((f) => f.key === 'feh'), fitsM = free.some((f) => f.key === 'mstar'), fitsR = free.some((f) => f.key === 'rstar');
  // With Kepler's law or velocities on and M★ or R★ held, the fit measured K, a/R★ (from the light curve) and Rp/R★ for the
  // star it was given. The stellar uncertainties are folded in by drawing M★, R★ from normal distributions with the
  // star's stated errors and re-expressing those observables: the mass that gives the same K, the radius from Rp/R★,
  // a/R★ as fitted (from Kepler's law with the drawn star when no light curve constrains it).
  const tied = S.kepler || rvOn(), lcIn = S.use.lc;
  const massFor = (K0, p, m) => { let mp = p.mplanet; for (let it = 0; it < 6; it++) mp = (K0 / semiAmplitude(p.per, p.ecc || 0, p.inc, 1, m)) * Math.pow((m + mp * CONST.Mjup_Msun) / (m + CONST.Mjup_Msun), 2 / 3); return mp; };
  for (const i of idx) {
    const v = { ...S.values }; free.forEach((f, k) => (v[f.key] = res.samples[i * d + k])); withLD(v);
    const star = { ...st, rstar: fitsR ? v.rstar : gauss(st.rstar, st.rstarErr), mstar: fitsM ? v.mstar : gauss(st.mstar, st.mstarErr), teff: fitsTeff ? v.teff : gauss(st.teff, st.teffErr), feh: fitsFeh ? v.feh : st.feh };
    const fitStar = { ...st, mstar: fitsM ? v.mstar : st.mstar, rstar: fitsR ? v.rstar : st.rstar };   // what the likelihood used
    const q = { mstar: star.mstar, rstar: star.rstar, teff: star.teff, feh: star.feh };
    // every planet's derived quantities, keyed like its parameters ("per" for the first planet, "per@c" for planet c)
    for (const pl of S.planets) {
      let pvv;
      if (tied && !(fitsM && fitsR)) {
        const p0 = planetValues(v, pl.sfx, fitStar);
        pvv = { ...p0 };
        if (!fitsM && p0.mplanet > 0 && rvOn()) pvv.mplanet = massFor(semiAmplitude(p0.per, p0.ecc || 0, p0.inc, p0.mplanet, fitStar.mstar), p0, star.mstar);
        if (S.kepler && !lcIn) pvv.ars = arsFromKepler(p0.per, star.mstar, pvv.mplanet || 0, star.rstar);
      } else pvv = planetValues(v, pl.sfx, star);
      const dq = deriveSystem(pvv, { ...star, mplanet: pvv.mplanet > 0 ? pvv.mplanet : null });
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
  const sfxOf = (k) => (k.includes('@') ? k.slice(k.indexOf('@') + 1) : ''), medOf = (k) => (draws[k] ? (quant(draws[k]) || {}).med : NaN);
  const derived = {}; for (const k in draws) derived[k] = baseKey(k) === 'omega' ? summarizeDraws(draws[k], { period: 360, lo: (quant(draws[k]) || { med: 0 }).med - 180 })
    : baseKey(k) === 'emid' || baseKey(k) === 'tperi' ? summarizeEpoch(draws[k], baseKey(k), medOf(planetKey('tmid', sfxOf(k))), medOf(planetKey('per', sfxOf(k)))) : quant(draws[k]);
  const best = { ...S.values }; free.forEach((f, k) => (best[f.key] = res.maxPoint[k])); withLD(best);
  const starBest = { ...S.star }; if (fitsTeff) starBest.teff = Number(best.teff.toFixed(1)); if (fitsFeh) starBest.feh = Number(best.feh.toFixed(3));
  if (fitsM) starBest.mstar = Number(best.mstar.toFixed(4)); if (fitsR) starBest.rstar = Number(best.rstar.toFixed(4));
  delete best.teff; delete best.feh; delete best.mstar; delete best.rstar;
  S.values = best; S.star = starBest; syncStarLD.key = null; displayNorm = null;   // re-centre the plotted data on the best fit
  const use = { lc: S.use.lc, rv: rvOn(), timing: S.use.timing && S.timing.rows.length > 0 };
  const prob = buildProblem(fitSpec(best, [], use)), det = prob.detail([]);
  // k counts the analytically fitted terms (one normalisation per epoch, one zero point per RV set); with free jitters the
  // BIC takes chi2 + sum ln(1 + jitter²/σ²) (det.chi2ic), else a model that inflates its error bars always wins
  const N = prob.ntotal, kTot = free.length + prob.nlinear, ic = { ...infoCriteria(det ? det.chi2ic ?? det.chi2 : NaN, kTot, N), redChi2: det ? det.chi2 / Math.max(1, N - kTot) : NaN };
  S.fit = { id: S.runs.length + 1, res, free, summary, band: use.lc ? { t: G, lo, hi, folded: S.fold, pl: S.pl } : null, derived, starTied: (S.kepler || rvOn()) && !(fitsM && fitsR), detrend: use.lc && S.data.detrendInfo ? { names: [...S.data.detrendInfo.names], kernel: S.data.detrendInfo.kernel } : null, starDrawn: { mstar: !fitsM && st.mstarErr > 0, rstar: !fitsR && st.rstarErr > 0, n: idx.length }, k: kTot, nepochs: nEpochs(), use, planets: clone(S.planets), kepler: S.kepler, parts: det ? { lc: det.chi2lc, rv: det.chi2rv, timing: det.chi2tim, nlc: use.lc ? S.data.t.length : 0, nrv: use.rv ? S.rv.reduce((a, x) => a + x.t.length, 0) : 0, ntim: use.timing ? S.timing.rows.length : 0 } : null, rvFit: det && det.rv ? det.rv.map((x, k) => ({ name: S.rv[k].name, gamma: x.gamma, jitter: x.jitter, chi2: x.chi2, n: S.rv[k].t.length })) : null, chi2: det ? det.chi2 : NaN, a1: det ? det.a1 : NaN, ic, N, truth: S.truth, star: { ...st, teff: starBest.teff, feh: starBest.feh, mstar: fitsM ? starBest.mstar : st.mstar, rstar: fitsR ? starBest.rstar : st.rstar }, starEstimated: !!st.estimated, values: { ...best }, ldLaw: S.ldLaw, ldMode: S.ldMode, ldSource: tie ? (tie.source === 'grid' ? ldTableName() : 'grey atmosphere') : null };
  S.runs.push({ id: S.fit.id, dataId: S.dataId, name: free.map((f) => f.label).join(', '), law: LD_LAWS[S.ldLaw].label + (S.ldMode === 'star' ? ' · follows star' : ''), k: free.length, logZ: res.logZ, err: res.logZerr, H: res.H, chi2: S.fit.chi2, bic: ic.bic, converged: res.stopReason === 'converged', fit: S.fit, state: { free: clone(S.free), priors: clone(S.priors), starInput: clone(S.star), planets: clone(S.planets), kepler: S.kepler, use: clone(S.use) } });
  S.range = 'fit';
  // the observing project (src/site/project.js) keeps the key numbers of every fit run here (not of runs opened from a file)
  if (!res.restored) { try { const ph = projectHandle(); if (ph.get()) { const r = exportSession(true).result; delete r.samples; ph.addFit(fitRecord(r, { page: 'analyze', run: S.fit.id, use })); } } catch (err) { console.warn('project: fit not recorded', err); } }
  $('#pstat').textContent = `Finished: ${res.stopReason}. ${res.ncalls} likelihood calls in ${res.elapsed.toFixed(1)} s.`;
  buildSystemTab(); buildResultsTab(); buildTiming(); evNote(); showTab('results'); refresh();
}

/** Bring back an earlier run from the comparison table: its posterior, tables and best-fit model. */
function restoreRun(run) {
  if (S.running || S.fit === run.fit) return;
  pushUndo();
  const F = run.fit;
  S.fit = F; S.values = { ...F.values }; S.ldLaw = F.ldLaw; S.ldMode = F.ldMode; S.free = clone(run.state.free); S.priors = clone(run.state.priors); S.star = clone(run.state.starInput); S.planets = clone(run.state.planets); S.kepler = run.state.kepler; S.use = clone(run.state.use); if (!S.planets.some((p) => p.sfx === S.pl)) S.pl = ''; S.range = 'fit'; syncStarLD.key = null;
  displayNorm = null; buildPanels(); showTab('results'); refresh(); flash(`Showing run #${run.id}`);
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
  const post = (k, dgFixed, off = 0) => { const q = D[k]; if (!q) return null; const varies = q.plus + q.minus > 1e-7 * Math.max(1e-3, Math.abs(q.med)); const s = varies ? { med: q.med + off, plus: q.plus, minus: q.minus } : { med: q.med + off }; return { s, dg: varies ? digitsFor(q) : dgFixed, kind: varies ? (fitted.has(k) ? 'fit' : 'derived') : 'fixed' }; };
  const ldNames = LD_LAWS[F.ldLaw].names, planets = F.planets || [{ sfx: '', letter: 'b' }], many = planets.length > 1, lc = !F.use || F.use.lc;
  const starRow = (k, e, dg) => (fitted.has(k) ? post(k, dg) : given(st[k], e, dg));
  const eccentric = (sfx) => { const q = D[planetKey('ecc', sfx)]; return !!q && q.med + q.plus > 0.01; };
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
      eccentric(pl.sfx) ? { label: 'Epoch of periastron T peri', tex: `Epoch of periastron, $T_{\\rm peri${cs}}$`, unit: tRef ? 'BJD' : 'd', texUnit: tRef ? 'BJD' : 'days', ...P('tperi', 4, tRef) } : null,   // undefined for a circular orbit
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
      eccentric(pl.sfx) ? { label: 'Orbit-averaged insolation ⟨S⟩', tex: `Orbit-averaged insolation, $\\langle S\\rangle${sub}$`, unit: 'S⊕', texUnit: '$S_\\oplus$', ...P('insolAvg', 1) } : null,
      eccentric(pl.sfx) ? { label: 'T eq at periastron', tex: `Equilibrium temperature at periastron, $T_{\\rm eq,peri${cs}}$`, unit: 'K', texUnit: 'K', ...P('teqPeri', 0) } : null,
      eccentric(pl.sfx) ? { label: 'T eq at apastron', tex: `Equilibrium temperature at apastron, $T_{\\rm eq,apo${cs}}$`, unit: 'K', texUnit: 'K', ...P('teqApo', 0) } : null,
      { label: 'Eclipse light-travel delay', tex: `Light-travel delay of the eclipse, $\\Delta t_{\\rm LTT${cs}}$`, unit: 's', texUnit: 's', ...P('lttEclipse', 1) },
      lc ? { label: 'Surface gravity gp', tex: `Planet surface gravity, $g_{p${cs}}$`, unit: 'm/s²', texUnit: 'm\\,s$^{-2}$', ...P('gp', 2) } : null,
      lc ? { label: 'Surface gravity log gp', tex: `Planet surface gravity, $\\log g_{p${cs}}$`, unit: 'cgs', texUnit: 'cgs', ...P('loggp', 3) } : null,
      lc ? { label: 'Hill radius (at periastron)', tex: `Hill radius at periastron, $R_{\\rm H${cs}}$`, unit: 'Rp', texUnit: '$R_p$', ...P('hillRp', 1) } : null,
      lc ? { label: 'Periastron over Roche limit', tex: `Periastron distance over Roche limit${many ? ', ' + pl.letter : ''}`, ...P('rocheRatio', 2) } : null,
      lc ? { label: (D[planetKey('rpEarth', pl.sfx)] || {}).med >= 10 ? 'Transmission metric TSM (Rp ≥ 10 R⊕: beyond Kempton et al.’s calibration)' : 'Transmission metric TSM', tex: `Transmission spectroscopy metric${many ? ', ' + pl.letter : ''}`, ...P('tsm', 1) } : null,
      lc ? { label: 'Emission metric ESM', tex: `Emission spectroscopy metric${many ? ', ' + pl.letter : ''}`, ...P('esm', 1) } : null,
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


// How each row of the system table is obtained, and the point of the orbit it refers to (shown in the 3D view on hover).
// Keyed by the start of the row label.
const ROW_INFO = [
  ['Stellar mass', { how: 'Input from the System tab (or estimated from T eff, log g and [Fe/H] with the Torres et al. 2010 relation), unless M★ was fitted. With Kepler’s law on, it sets the size of every orbit: a³ = G (M★ + Mp) P² / 4π².' }],
  ['Stellar radius', { how: 'Input from the System tab (or the Torres et al. 2010 estimate), unless R★ was fitted. Turns Rp/R★ into a planet radius and a into a/R★.' }],
  ['Stellar temperature', { how: 'Input, or sampled when limb darkening follows the star. Used for the equilibrium temperature, the insolation and the limb darkening estimate.' }],
  ['Metallicity', { how: 'Input, or sampled with a model-atmosphere table when limb darkening follows the star.' }],
  ['Radius ratio', { how: 'Fitted from the light curve: the square root of the fraction of the stellar disc the planet covers.', ev: 'transit' }],
  ['Transit depth', { how: '(Rp/R★)²: the flux blocked by a dark planet on a uniformly bright star. The observed dip is deeper or shallower than this because of limb darkening and the impact parameter.', ev: 'transit' }],
  ['Planet radius', { how: 'Rp = (Rp/R★) × R★, in Jupiter radii (71,492 km).', ev: 'transit' }],
  ['Planet mass', { how: 'Fitted from the radial velocities, or given. The velocities measure K; the mass follows as Mp sin i = K (P / 2πG)^⅓ (M★ + Mp)^⅔ √(1 − e²), so it scales with M★^⅔.', ev: 'ascending' }],
  ['RV semi-amplitude', { how: 'K = (2πG / P)^⅓ · Mp sin i / ((M★ + Mp)^⅔ √(1 − e²)): half the peak-to-peak velocity of the star.', ev: 'ascending' }],
  ['Orbital period', { how: 'Fitted, or held at its System value. One transit does not constrain it; several epochs, velocities or a list of mid-times do.' }],
  ['Eclipse midpoint', { how: 'Superior conjunction, when the planet passes behind the star: the time at which the true anomaly is −π/2 − ω, found from Kepler’s equation. Half a period after mid-transit only for a circular orbit; the offset measures e cos ω.', ev: 'eclipse' }],
  ['Eclipse duration', { how: 'Time between first and last contact of the planet’s disc with the star’s as it passes behind, found numerically from the orbit (bisection on the projected separation = 1 + Rp/R★).', ev: 'eclipse' }],
  ['Epoch of periastron', { how: 'Closest approach to the star before this transit: T peri = T mid − (M at transit) P / 2π, where M is the mean anomaly corresponding to true anomaly π/2 − ω.', ev: 'periastron' }],
  ['Transit midpoint', { how: 'Inferior conjunction, when the planet is closest to the line of sight in front of the star (ω + ν = π/2). Fitted from the light curve or the timing list.', ev: 'transit' }],
  ['Transit duration', { how: 'First to fourth contact, found numerically from the orbit (projected separation = 1 + Rp/R★), so it is exact for eccentric orbits.', ev: 'transit' }],
  ['Inclination', { how: 'Angle between the orbit’s axis and the line of sight; 90° is edge-on. Fitted from the shape of ingress and egress through the impact parameter.', ev: 'transit' }],
  ['Scaled semi-major axis', { how: 'With Kepler’s law on: a/R★ = (G (M★ + Mp) P² / 4π²)^⅓ / R★. Otherwise the value held on the System tab. It is never sampled, because it is degenerate with the inclination.' }],
  ['Semi-major axis', { how: 'a = (a/R★) × R★, in astronomical units.' }],
  ['Eccentricity', { how: 'Fitted from the shape of the velocity curve and from eclipse timing, or held. 0 is a circle.', ev: 'periastron' }],
  ['Argument of periastron', { how: 'Angle from the plane of the sky to periastron, measured in the orbit. Mid-transit is where ω + ν = π/2; ω = 90° puts periastron at transit.', ev: 'periastron' }],
  ['Impact parameter', { how: 'b = (a/R★) cos i · (1 − e²) / (1 + e sin ω): the sky-projected distance from the centre of the star at mid-transit, in stellar radii. Above 1 − Rp/R★ the transit is grazing.', ev: 'transit' }],
  ['Equilibrium temp', { how: 'T eq = T★ √(R★ / 2a): a planet at the semi-major axis with zero albedo and full redistribution of heat.' }],
  ['Insolation', { how: 'S = (R★/R☉)² (T★/5772 K)⁴ / (a/au)², in units of what the Earth receives.' }],
  ['Planet density', { how: 'ρp = Mp / (4/3 π Rp³).' }],
  ['Orbit-averaged insolation', { how: '⟨S⟩ = S / √(1 − e²): the time average of the flux over an eccentric orbit, larger than the flux at the semi-major axis.' }],
  ['T eq at periastron', { how: 'T eq / √(1 − e): the zero-albedo, full-redistribution temperature at the closest distance.', ev: 'periastron' }],
  ['T eq at apastron', { how: 'T eq / √(1 + e): the same at the farthest distance.', ev: 'apastron' }],
  ['Eclipse light-travel delay', { how: 'How much later the eclipse is seen than the conjunction time listed above: the light crosses the orbit, (r at transit + r at eclipse) sin i / c; 2a/c for a circular orbit.', ev: 'eclipse' }],
  ['Surface gravity', { how: 'gp = G Mp / Rp², from the mass and the radius (log gp in cgs).' }],
  ['Hill radius', { how: 'a (1 − e) (Mp / 3M★)^⅓ at periastron, in planet radii: moons are stable only well inside it (about half for prograde orbits).' }],
  ['Periastron over Roche', { how: 'Periastron distance over the fluid Roche limit 2.44 R★ (ρ★/ρp)^⅓; below 1 the planet would be losing mass.', ev: 'periastron' }],
  ['Transmission metric', { how: 'TSM of Kempton et al. (2018, eq. 1) from Rp, Mp, T eq, R★ and the J magnitude (System tab, Position and magnitudes); the scale factor of their Table 1. Above about 90 (giants) a planet is a good JWST transmission target.' }],
  ['Emission metric', { how: 'ESM of Kempton et al. (2018, eq. 4) at 7.5 µm from the depth, T day = 1.1 T eq, T eff and the Ks magnitude.' }],
  ['Stellar density ρ★ (from', { how: 'ρ★ = 3π (a/R★)³ / (G P²): what the transit shape alone says about the star, for a circular orbit. Compare it with M★ and R★.' }],
  ['a from Kepler', { how: 'a = (G M★ P² / 4π²)^⅓ from the stellar mass and the period, for comparison with the fitted a/R★ × R★.' }],
  ['Coefficient', { how: 'Limb darkening coefficient of the chosen law: fitted, held, or computed from the sampled T eff and [Fe/H].' }],
  ['Linear trend', { how: 'Constant acceleration of the star along the line of sight, shared by all instruments: a long-period companion or an activity cycle.' }],
  ['Quadratic trend', { how: 'Curvature of the drift in the star’s velocity.' }],
  ['Zero point', { how: 'Velocity offset of this instrument at the best fit. It is integrated out analytically in the likelihood, so it has no posterior of its own.' }],
  ['Jitter', { how: 'Extra scatter added in quadrature to this instrument’s error bars: stellar activity and unmodelled instrumental noise.' }],
];
const rowInfo = (label) => { const hit = ROW_INFO.find(([k]) => label.startsWith(k)); return hit ? hit[1] : null; };
const EV_NAME = { transit: 'mid-transit', eclipse: 'mid-eclipse', periastron: 'periastron', apastron: 'apastron', ascending: 'the quadrature where the star recedes fastest' };

/**
 * The system table as collapsible groups (star, each planet, limb darkening, velocities). A row opens to
 * say how its value was obtained; hovering or focusing it marks the matching point of the orbit in the 3D view.
 */
function systemTableBlocks() {
  const tag = { fit: '', derived: '', input: '<small>input</small>', fixed: '<small>fixed</small>', estimated: '<small>estimated</small>' };
  const groups = []; let curG = null;
  for (const x of systemRows()) {
    if (x.section) {
      // "Planet b" and "Orbit b" share one group; everything else is its own
      const m = x.section.match(/^(Planet|Orbit)( .+)?$/), title = m ? 'Planet' + (m[2] || '') : x.section;
      if (!curG || curG.title !== title) { curG = { title, rows: [] }; groups.push(curG); }
      if (m && m[1] === 'Orbit') curG.rows.push({ sub: 'Orbit' });
      continue;
    }
    curG.rows.push(x);
  }
  const me = (S.planets.find((p) => p.sfx === S.pl) || {}).letter, many = (S.fit.planets || []).length > 1;
  const mark = (ev) => { if (viz && viz.highlight) { try { viz.highlight(ev || null); } catch { /* the view is optional */ } } };
  return groups.map((g) => {
    const tb = h('tbody');
    for (const x of g.rows) {
      if (x.sub) { tb.append(h('tr', { class: 'sec', html: `<td colspan="3">${x.sub}</td>` })); continue; }
      const info = rowInfo(x.label);
      const tr = h('tr', { class: x.kind + (info ? ' hasinfo' : ''), tabindex: info ? 0 : null, html: `<td>${x.label}${info ? '<span class="infodot" aria-hidden="true">ⓘ</span>' : ''}</td><td>${pmHTML(x.s, x.dg)} ${tag[x.kind]}</td><td>${x.unit || ''}</td>` });
      tb.append(tr);
      if (!info) continue;
      const how = h('tr', { class: 'how', hidden: true, html: `<td colspan="3">${info.how}${info.ev ? ` <em>Marked in the system view: ${EV_NAME[info.ev]}.</em>` : ''}</td>` });
      tb.append(how);
      const toggle = () => { how.hidden = !how.hidden; tr.classList.toggle('open', !how.hidden); };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      if (info.ev) { tr.addEventListener('mouseenter', () => mark(info.ev)); tr.addEventListener('mouseleave', () => mark(null)); tr.addEventListener('focus', () => mark(info.ev)); tr.addEventListener('blur', () => mark(null)); }
    }
    // with several planets only the star and the planet on show start open
    const open = !many || !g.title.startsWith('Planet') || g.title === 'Planet ' + me;
    return h('details', { class: 'group', open }, h('summary', {}, g.title, h('small', {}, `${g.rows.filter((x) => !x.sub).length} values`)), h('div', { class: 'tablewrap' }, h('table', { class: 'res sys' }, tb)));
  });
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
  const tabBtn = $('.tabs [data-tab=results]'); tabBtn.innerHTML = 'Results' + (S.fit ? '<span class="dot" title="There is a posterior to look at"></span>' : '');
  if (!S.fit) { el.append(h('div', { class: 'empty' }, 'No posterior yet. Choose free parameters and priors on the Fit tab, then run the sampler.')); if (S.runs.length) comparisonTable(el); return; }
  const F = S.fit, r = F.res, toast = h('span', { class: 'toast' }), clipOut = h('textarea', { readonly: true, hidden: true, 'aria-label': 'Copied text' });
  const say = (t) => { toast.textContent = t; setTimeout(() => { if (toast.textContent === t) toast.textContent = ''; }, 5000); };
  const save = async (name, make) => {
    try { say('Preparing…'); const st = await saveFile(name, await make()); say(st === 'saved' ? 'Saved ' + name : 'Save cancelled.');
      if (st === 'saved' && /_(session\.json|methods\.txt|report\.md|parameters\.tex|fit\.py)$/.test(name)) { try { projectHandle().addFile({ kind: /_session\.json$/.test(name) ? 'session' : 'report', name, page: 'analyze' }); } catch { /* no project */ } }
    } catch (err) { say('Could not save: ' + err.message); }
  };
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); say(what + ' copied.'); } catch { clipOut.hidden = false; clipOut.value = text; clipOut.select(); say('Clipboard is blocked here: select the text below and copy it.'); } };
  const copyBtns = (lx, js) => h('span', { class: 'copyset' }, h('button', { class: 'chip small', onclick: () => copy(lx(), 'LaTeX') }, 'Copy LaTeX'), h('button', { class: 'chip small', onclick: () => copy(JSON.stringify(js(), null, 2), 'JSON') }, 'Copy JSON'));
  const base = slug(S.name);
  el.append(h('p', { class: 'note runtag' }, `Run #${F.id} · ${F.free.map((f) => f.label).join(', ')}`, toast));

  el.append(h('h3', {}, 'Fitted parameters', copyBtns(fittedLatex, fittedJSON)));
  let lastPl = null; const plOf = (k) => { const [b, sc] = k.split('@'); return PLANET_FIELDS.includes(b) ? (F.planets || []).find((p) => p.sfx === (sc || '')) : null; };
  const rows = F.summary.map((s) => { const dg = digitsFor(s), pl = plOf(s.key), head = (F.planets || []).length > 1 && (pl ? pl.letter : 'shared') !== lastPl ? `<tr class="sec"><td colspan="4">${pl ? 'Planet ' + pl.letter : 'Star, baselines and velocities'}</td></tr>` : ''; lastPl = pl ? pl.letter : 'shared'; return head + `<tr><td>${s.label}${s.unit ? ` <small>${s.unit}</small>` : ''}</td><td>${pmHTML(s, dg)}</td><td>${s.best.toFixed(dg)}</td>${F.truth ? `<td>${Number(F.truth[s.key]).toFixed(dg)}</td>` : ''}</tr>`; }).join('');
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res', html: `<thead><tr><th>Parameter</th><th>median ±1σ</th><th>best fit</th>${F.truth ? '<th>truth</th>' : ''}</tr></thead><tbody>${rows}</tbody>` })));

  el.append(h('h3', {}, 'System parameters', copyBtns(systemLatex, systemJSON)));
  el.append(...systemTableBlocks());
  el.append(h('p', { class: 'note' }, 'Click a row to see how its value was obtained. Rows that belong to a point of the orbit mark it in the system view while the pointer is on them.'));
  const sd = F.starDrawn || {}, drawn = [sd.mstar && 'M★', sd.rstar && 'R★'].filter(Boolean);
  if (F.starTied) el.append(h('p', { class: 'note callout' }, `M★ and R★ were held in the fit itself${drawn.length ? `; their uncertainties (${drawn.join(' and ')} drawn from normal distributions with the errors on the System tab) are folded into the derived rows: the planet mass is the one that gives each draw’s K for the drawn M★, radii scale with the drawn R★, and a/R★ stays as the light curve measured it` : ', and no uncertainties are given for them, so the derived rows do not include any'}. To let the data inform the star as well, tick M★ and R★ on the Fit tab and run again.`));
  el.append(h('p', { class: 'note' }, `Rows follow Table 7 of Pearson et al. (2022), with extras. Derived rows are evaluated on ${sd.n || 'the'} posterior draws with the stellar uncertainties folded in; durations and event times come from the orbit numerically. TSM and ESM need the J and Ks magnitudes (System tab, Position and magnitudes).` + (F.starEstimated ? ' Stellar mass and radius were estimated from T eff, log g and [Fe/H].' : '')));
  el.append(h('div', { class: 'btnrow' }, h('span', { class: 'note' }, 'Save everything:'),
    h('button', { class: 'btn', onclick: () => save(base + '_parameters.tex', () => fittedLatex() + '\n' + systemLatex()) }, 'LaTeX file'),
    h('button', { class: 'btn', onclick: () => save(base + '_posterior.json', () => allJSON()) }, 'JSON file'),
    h('button', { class: 'btn', title: 'The whole analysis in one file: system, data, priors, sampler settings and this posterior. It reopens here (Start page) and in the Python package.', onclick: () => save(base + '_session.json', () => JSON.stringify(exportSession(true))) }, 'Session file'),
    h('button', { class: 'btn', title: 'A Python script that rebuilds this analysis with the esl package (pip install exoplanet-science-lab): data, every prior and setting as an editable line, the fit, and a comparison with the numbers shown here', onclick: async () => { const { pythonScriptFor } = await import('./core/exportScript.js'); save(base + '_fit.py', () => pythonScriptFor(exportSession(true), { prefix: base })); } }, 'Python script'),
    h('button', { class: 'btn', title: 'A report in Markdown: system, data, priors, sampler, fitted and derived parameters, warnings, and how to reproduce it', onclick: async () => { const { markdownReportFor } = await import('./core/exportScript.js'); save(base + '_report.md', () => markdownReportFor(exportSession(true), { sessionFile: base + '_session.json' })); } }, 'Markdown report'),
    h('button', { class: 'btn', title: 'A methods paragraph for a paper, written from this fit (models, priors, sampler, limb-darkening source), with the BibTeX of exactly the references it cites and a list of what you still need to state', onclick: async () => {
      const { methodsParagraph } = await import('./core/methodsText.js');
      const m = methodsParagraph(exportSession(true), { ldSource: S.fit && S.fit.ldSource, sliceUsed: !!(S.fit && S.fit.res && S.fit.res.sampling && S.fit.res.sampling.sliceIter > 0) });
      await save(base + '_methods.txt', () => m.text + (m.notes && m.notes.length ? '\n\nStill to state in the paper:\n' + m.notes.map((n) => '- ' + n).join('\n') : '') + '\n');
      await save(base + '_references.bib', () => m.bibtex);
    } }, 'Methods paragraph')), clipOut);

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
  el.append(h('p', { class: 'note' }, 'Each point is a posterior draw coloured by its likelihood on the viridis scale: on screen the brightest points fit best; on the white figures you save the scale is reversed, darkest = best. The scale spans 6 in ln L. Contours mark the 1σ, 2σ and 3σ boundaries (39.3 / 86.5 / 98.9% of the probability in two dimensions), and the histogram shading the 68.3 / 95.4 / 99.7% intervals.'));

  el.append(h('h3', {}, 'Evidence & diagnostics'));
  const insOk = r.insertionP > 0.01;
  el.append(h('div', { class: 'kv', html: [
    ['ln Z (marginal likelihood)', r.stopReason === 'converged' ? `${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}` : `> ${r.logZ.toFixed(1)} <small>not converged</small>`], ['Information H', r.H.toFixed(1) + ' nats'],
    ['Effective samples', r.ess.toFixed(0)], ['Likelihood calls', `${r.ncalls} (${(100 * r.n / r.ncalls).toFixed(1)}% eff.)`],
    ['χ² / (N − k)', `${F.chi2.toFixed(1)} / ${F.N - (F.k ?? F.free.length)}`], ['BIC', F.ic.bic.toFixed(1)],
    ['Run time', r.elapsed.toFixed(1) + ' s'], ['Insertion-order p', `<span style="color:${insOk ? 'var(--ok)' : 'var(--warn)'}">${r.insertionP.toFixed(3)}</span>`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') }));
  const notes = [];
  if (F.parts && (F.parts.nrv || F.parts.ntim)) notes.push('χ² by kind of data: ' + [F.parts.nlc ? `light curve ${F.parts.lc.toFixed(1)} / ${F.parts.nlc}` : null, F.parts.nrv ? `velocities ${F.parts.rv.toFixed(1)} / ${F.parts.nrv}` : null, F.parts.ntim ? `timing ${F.parts.timing.toFixed(1)} / ${F.parts.ntim}` : null].filter(Boolean).join(' · ') + '.' + (F.parts.nrv && F.parts.rv / F.parts.nrv > 2 && F.rvFit.every((x) => !(x.jitter > 0)) ? ' The velocities scatter more than their error bars: free the instrument jitters (Fit tab) for realistic uncertainties.' : ''));
  if (r.stopReason !== 'converged') notes.push(r.ess < 100
    ? `<b>Run ended early (${r.stopReason}) long before convergence</b>: only ${r.ess.toFixed(0)} effective samples. The medians and intervals above are not a posterior and must not be quoted; the sampler had only narrowed each parameter to the ranges it was still exploring. Raise the call budget, narrow the priors, or free fewer parameters.`
    : `Run ended early (${r.stopReason}): the posterior is usable but ln Z is not converged and should not be used to compare models.`);
  for (const wmsg of r.warnings || []) if (!notes.some((x) => x.includes(wmsg.slice(0, 40)))) notes.push(wmsg);
  if (!insOk) notes.push('The insertion-order test is low, which can mean the region missed part of the posterior. Re-run with more live points before trusting ln Z.');
  if (r.mode === 'slice') notes.push('Region sampling became inefficient, so the run finished with slice sampling.');
  if (r.nplateau > 0) notes.push(`${r.nplateau} live points sat on a likelihood plateau (models with no transit in the data) and were retired as a block.`);
  const red = F.chi2 / Math.max(1, F.N - (F.k ?? F.free.length)), redTxt = `χ²/(N − k) = ${red.toFixed(2)}, with k = ${F.k ?? F.free.length} fitted terms (sampled parameters plus the normalisations and zero points integrated out),`;
  if (red < 0.5) notes.push(`${redTxt} is well below 1: the error bars are larger than the scatter, which inflates the parameter uncertainties and distorts ln Z. See “Rescale errors” on the Data tab.`);
  if (red > 1.6) notes.push(`${redTxt} is well above 1: errors are underestimated or the model is missing something. Parameter uncertainties will be too small.`);
  el.append(...notes.map((t) => h('p', { class: 'note' + (/not a posterior|not converged|correlated|separate peaks|edge of its prior/.test(t) ? ' callout warn' : ''), html: t })));
  comparisonTable(el);
}

/**
 * How a run compares with the best one, in words that cannot be over-read: the log Bayes factor is only quoted as a
 * preference when it is larger than its own uncertainty AND both runs are trustworthy. Returns { text, cls }.
 */
function readBayes(x, top) {
  if (x === top) return { text: 'reference', cls: '' };
  if (!x.converged || !top.converged) return { text: 'not comparable', cls: 'bad' };
  const dz = x.logZ - top.logZ, e = Math.hypot(x.err, top.err), a = Math.abs(dz);
  if (a < Math.max(1, 2 * e)) return { text: 'indistinguishable', cls: 'dim' };
  if (a < 2.5) return { text: 'weakly disfavoured', cls: 'dim' };
  if (a < 5) return { text: 'moderately disfavoured', cls: 'warn' };
  return { text: 'strongly disfavoured', cls: 'warn' };
}
/** Reasons not to trust a run's evidence, each a short sentence. */
function runAlarms(x, top) {
  const r = x.fit.res, out = [];
  if (!x.converged) out.push(`It stopped before converging (${r.stopReason}): its ln Z is a lower bound, not a measurement.`);
  if (r.ess < 200) out.push(`Only ${r.ess.toFixed(0)} effective samples: intervals and ln Z are noisy.`);
  if (r.insertionP < 0.01) out.push(`The insertion-order test fails (p = ${r.insertionP.toFixed(3)}): the sampler may have missed part of the posterior.`);
  const red = x.chi2 / Math.max(1, x.fit.N - (x.fit.k ?? x.k));
  if (red > 1.6) out.push(`χ²/(N − k) = ${red.toFixed(1)}: the error bars are too small or the model is incomplete, which exaggerates every Δ ln Z.`);
  if (red < 0.5) out.push(`χ²/(N − k) = ${red.toFixed(2)}: the error bars are too large, which flattens every Δ ln Z.`);
  if ((r.warnings || []).length) out.push(`${r.warnings.length} sampler warning${r.warnings.length > 1 ? 's' : ''} (see its diagnostics).`);
  if (top && x !== top) {
    // the evidence depends on the prior volume: a different prior on a shared parameter shifts ln Z by itself
    const diff = Object.keys(x.state.priors).filter((k) => x.state.free[k] && top.state.free[k] && JSON.stringify(x.state.priors[k]) !== JSON.stringify(top.state.priors[k]));
    if (diff.length) out.push(`Different priors than the reference run on ${diff.slice(0, 4).join(', ')}${diff.length > 4 ? '…' : ''}: part of Δ ln Z is the change of prior volume, not the data.`);
    if (JSON.stringify(x.state.use || {}) !== JSON.stringify(top.state.use || {})) out.push('It used different kinds of data than the reference run: the evidences are not comparable.');
    const kx = !!(x.fit.detrend && x.fit.detrend.kernel), kt = !!(top.fit.detrend && top.fit.detrend.kernel);
    if (kx || kt) out.push(kx && kt ? 'Both runs use the kernel systematics model, which conditions on the data: compare their ln Z with care.' : `${kx ? 'It' : 'The reference run'} models the systematics with the nearest-neighbour kernel, which conditions on the data themselves: its ln Z cannot be compared with a fit without the kernel.`);
  }
  return out;
}

function comparisonTable(el) {
  if (!S.runs.length) return;
  const here = S.runs.filter((x) => x.dataId === S.dataId);
  el.append(h('h3', {}, 'Runs & model comparison', h('button', { class: 'chip small', title: 'Forget every stored run', onclick: () => { S.runs = []; buildResultsTab(); } }, 'clear')));
  if (!here.length) { el.append(h('p', { class: 'note' }, `${S.runs.length} earlier run${S.runs.length > 1 ? 's' : ''} used different data or error bars, so their evidences cannot be compared with fits to the current light curve. Undo (Ctrl/⌘+Z) returns to that data.`)); return; }
  // the reference is the best converged run; a run that did not converge cannot be the reference
  const conv = here.filter((x) => x.converged), pool = conv.length ? conv : here, bestZ = Math.max(...pool.map((x) => x.logZ)), top = pool.find((y) => y.logZ === bestZ), tb = h('tbody');
  for (const x of here) {
    const dz = x.logZ - bestZ, e = Math.hypot(x.err, top.err), rd = readBayes(x, top), al = runAlarms(x, top);
    const tr = h('tr', { class: 'runrow' + (S.fit === x.fit ? ' active' : ''), tabindex: 0, title: al.length ? al.join('\n') : 'Show this run’s posterior, tables and best-fit model',
      html: `<td>#${x.id} ${x.name}<br><small>${x.law}${x.converged ? '' : ' · not converged'}</small></td><td>${x.converged ? `${x.logZ.toFixed(2)} ± ${x.err.toFixed(2)}` : `&gt; ${x.logZ.toFixed(1)}`}</td><td>${x === top ? '—' : x.converged ? `${dz.toFixed(2)} ± ${e.toFixed(2)}` : '—'}</td><td class="${rd.cls}">${rd.text}${al.length ? ` <span class="alarm" aria-label="${al.length} caution${al.length > 1 ? 's' : ''}">⚠ ${al.length}</span>` : ''}</td>` });
    tr.addEventListener('click', () => restoreRun(x));
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); restoreRun(x); } });
    tb.append(tr);
  }
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res cmp' }, h('thead', { html: '<tr><th>Run · free parameters</th><th>ln Z</th><th>Δ ln Z</th><th>Reading</th></tr>' }), tb)));
  // one sentence that says what the table supports, and no more
  const same = here.filter((x) => x !== top && readBayes(x, top).text === 'indistinguishable'), worse = here.filter((x) => /disfavoured/.test(readBayes(x, top).text));
  let verdict = here.length === 1 ? 'One run so far: an evidence means something only next to another model fitted to the same data.' : `Run #${top.id} has the highest evidence.`;
  if (same.length) verdict += ` ${same.map((x) => '#' + x.id).join(', ')} ${same.length > 1 ? 'are' : 'is'} indistinguishable from it within the errors: the data do not choose between them, so prefer the simpler model.`;
  if (worse.length) verdict += ` ${worse.map((x) => `#${x.id} is ${readBayes(x, top).text} (odds about 1 in ${Math.exp(Math.min(50, top.logZ - x.logZ)).toPrecision(2)})`).join('; ')}.`;
  el.append(h('p', { class: 'note callout' }, verdict));
  const cautions = here.flatMap((x) => runAlarms(x, top).map((t) => `<b>#${x.id}</b> ${t}`));
  if (cautions.length) el.append(h('details', { class: 'cautions', open: cautions.length <= 3 }, h('summary', {}, `${cautions.length} caution${cautions.length > 1 ? 's' : ''} before reading this table`), ...cautions.map((t) => h('p', { class: 'note', html: t }))));
  el.append(h('p', { class: 'note' }, 'Click a row to bring that run back. Δ ln Z is the log Bayes factor against the reference run on the same data, with its uncertainty. A difference is read as a preference only when it exceeds twice that uncertainty and 1; “moderately” starts at 2.5 and “strongly” at 5 (odds of about 12 and 150 to 1), the scale of Trotta (2008, Contemporary Physics 49, 71), an adaptation of Jeffreys’ scale. The evidence depends on the priors and on the error bars: compare runs that share both.' + (S.runs.length > here.length ? ` ${S.runs.length - here.length} run(s) on other data are hidden.` : '')));
}

// ---- stage controls & animation -----------------------------------------------

function showTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
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
  if (S.loop === 'orbit') return [v.tmid - v.per / 2, v.tmid + v.per / 2];
  const vw = lcPlot.view; return [vw.x0, vw.x1];   // follow whatever part of the light curve is on screen
}
/** The animation's rate as a step of RATE_STEPS: the slider, its label, and S. */
function setRate(i) {
  S.rateStep = Math.max(0, Math.min(RATE_STEPS.length - 1, Math.round(i)));
  const el = $('#speed'), lab = rateLabel(RATE_STEPS[S.rateStep]);
  if (el) { el.value = String(S.rateStep); el.setAttribute('aria-valuetext', lab); }
  if ($('#speedval')) $('#speedval').textContent = lab;
}
/** A new system, planet, loop or planet light: the rate goes back to the default for it (a transit in about 12 s, an eclipse ingress in about 5 s, an orbit in about 20 s). */
function syncDefaultRate(values) {
  const key = `${S.name}|${S.pl}|${S.loop}|${hasPhase()}`;
  if (syncDefaultRate.key === key) return;
  syncDefaultRate.key = key;
  try {
    const ev = eventTimes(values); setRate(defaultStep({ per: values.per, ...ev }, S.loop, hasPhase()));
    // the planet's own light: start a little before the eclipse, so its ingress is the first thing the animation shows
    if (hasPhase() && S.loop === 'transit' && ev.e14 > 0 && !recording) S.t = ev.tecl - 0.75 * ev.e14;
  } catch { /* impossible geometry: keep the rate */ }
}
let lastT = performance.now(), recording = false;
function clockText(t) { const v = cur(), dth = (t - v.tmid - v.per * Math.round((t - v.tmid) / v.per)) * 24,   // from the nearest mid-transit
   ph = (((t - v.tmid) / v.per) % 1 + 1.5) % 1 - 0.5; return `${dth >= 0 ? '+' : '−'}${Math.abs(dth) < 100 ? Math.abs(dth).toFixed(2) + ' h' : (Math.abs(dth) / 24).toFixed(2) + ' d'}  ·  phase ${ph.toFixed(4)}`; }
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (!model || !lcPlot.view) return;
  const [a, b] = animRange();
  if (S.playing && !recording) { S.t += RATE_STEPS[S.rateStep] * dt; if (S.t > b || S.t < a) S.t = a; }
  if (viz) viz.setTime(S.t);
  lcPlot.setCursor(cursorTime(S.t));
  if (S.view === 'moon' && lcPlot.alt && Math.abs(S.t - (lcPlot.alt.data.tmid || 0)) > 0.6 * cur().per) refresh();   // moved on to another transit
  if (lcPlot.alt && lcPlot.alt.data.setTime && S.t !== tick.last) { tick.last = S.t; lcPlot.alt.data.setTime(S.t); lcPlot.draw(); }
  $('#clock').textContent = clockText(S.t);
}

async function recordClip() {
  const btn = $('#rec'), msg = $('#lcmsg');
  if (recording) return;
  if (!movieSupport()) { msg.textContent = 'This browser cannot record video from the page.'; return; }
  // one pass at the chosen rate, kept between 5 s and a minute (a long window at a slow rate is played faster)
  const [a, b] = animRange(), seconds = Math.min(60, Math.max(5, (b - a) / RATE_STEPS[S.rateStep]));
  recording = true; btn.classList.add('recording'); btn.textContent = '● 0%';
  try {
    const format = $('#recfmt').value || 'landscape', figView = $('#recfig').value || 'current';
    // the figure under the system view: the plot on show, or another view of the same model
    const fig = figView === 'current' ? lcPlot.alt : plotFor(figView);
    const { blob, ext } = await recordMovie({
      stage: () => $('#viz canvas'), t0: a, t1: b, seconds, title: planetLabel(), subtitle: clockText, format,
      drawLC: (ctx, w, hh, t, k = 1) => {
        const o = { ...lcPlot.opts, toolsW: 0, fontScale: 1.3 * k };
        if (fig) { if (fig.data.setTime) fig.data.setTime(t); return fig.render(ctx, w, hh, fig.data, LC_THEMES.dark, o); }
        return renderLightCurve(ctx, w, hh, { ...lcPlot.d, cursor: cursorTime(t) }, lcPlot.view, LC_THEMES.dark, o);
      },
      setTime: (t) => { S.t = t; },
      onProgress: (f) => { btn.textContent = `● ${Math.round(f * 100)}%`; },
    });
    const name = `${slug(planetLabel())}_transit${format === 'landscape' ? '' : '_' + format}.${ext}`, st = await saveFile(name, blob);
    msg.textContent = st === 'saved' ? `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB)` : 'Save cancelled.';
  } catch (err) { msg.textContent = 'Could not record: ' + err.message; }
  recording = false; btn.classList.remove('recording'); btn.textContent = '● Rec';
  setTimeout(() => (msg.textContent = ''), 6000);
}

function setupLCToolbar() {
  const reset = $('#lcreset'), menu = $('#lcmenu'), msg = $('#lcmsg');
  lcPlot.onViewChange = (_, zoomed) => { reset.hidden = !zoomed; };
  reset.addEventListener('click', () => lcPlot.resetView());
  $('#lcnorm').addEventListener('click', () => { displayNorm = null; refresh(); flash('Data re-centred on the model'); });
  $('#lcfold').addEventListener('click', () => { pushUndo(); S.fold = !S.fold; refresh(true); });
  $('#lcall').addEventListener('click', () => { pushUndo(); S.allPlanets = !S.allPlanets; refresh(true); });
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
  const menus = () => { $('#viewbtn').setAttribute('aria-expanded', String(!pop.hidden)); $('#lcexport').setAttribute('aria-expanded', String(!menu.hidden)); };
  $('#viewbtn').addEventListener('click', () => { pop.hidden = !pop.hidden; if (!pop.hidden) { menu.hidden = true; buildView(); } menus(); });
  $('#lcexport').addEventListener('click', () => { menu.hidden = !menu.hidden; pop.hidden = true; menus(); });
  // a menu closes on Escape and on a press anywhere outside it
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (!pop.hidden || !menu.hidden)) { pop.hidden = true; menu.hidden = true; menus(); } });
  document.addEventListener('pointerdown', (e) => { if ((pop.hidden && menu.hidden) || e.target.closest('.lctools')) return; pop.hidden = true; menu.hidden = true; menus(); });
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    menu.hidden = true; menus();
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

/**
 * The edges between the 3D view, the plot and the side panel can be dragged (mouse, finger or pen), moved with the arrow
 * keys and reset with a double-click; sizes are remembered on this device. Side by side: #grip sets the panel's width and
 * #lcgrip the plot's height. Stacked (phone, portrait tablet): #lcgrip sets the 3D view's height (the plot's when the
 * panel is folded away) and #grip, a handle along the top of the panel, the plot's height. The canvases watch their own
 * size (ResizeObserver), so every figure is drawn again at the new size.
 */
const STACKED = '(max-width: 900px) and (orientation: portrait), (max-width: 639px)';
const SIZES_KEY = 'esl.layout.sizes';
// CSS variable of each remembered size, and the cap that keeps it sane when the window is made smaller later
const SIZE_VARS = { panelw: null, lchSide: ['--lch-side', 'calc(100dvh - 210px)'], stageStack: ['--stageh-stack', '62dvh'], lchStack: ['--lch-stack', '66dvh'] };
let layoutSizes = {};
function applyLayoutSizes() {
  const app = $('#app');
  for (const [k, spec] of Object.entries(SIZE_VARS)) {
    if (!spec) continue;
    if (layoutSizes[k] > 0) app.style.setProperty(spec[0], `min(${Math.round(layoutSizes[k])}px, ${spec[1]})`); else app.style.removeProperty(spec[0]);
  }
}
/** Set (or with null clear) remembered sizes in px: { lchSide, stageStack, lchStack }. For tests and the API. */
function setLayoutSizes(o = {}) {
  for (const k of Object.keys(SIZE_VARS)) if (k !== 'panelw' && k in o) { if (o[k] > 0) layoutSizes[k] = Number(o[k]); else delete layoutSizes[k]; }
  applyLayoutSizes();
  try { localStorage.setItem(SIZES_KEY, JSON.stringify(layoutSizes)); } catch { /* storage unavailable */ }
  afterLayoutChange();
}
function afterLayoutChange() { if (S.fit && S.fit.redraw) S.fit.redraw(); if (timingRedraw) timingRedraw(); refresh(); }
// a new site theme (src/site/theme.js): the posterior, the timing plots and the light curve take its colours
window.addEventListener('esl-theme', () => requestAnimationFrame(afterLayoutChange));
function setupResizer() {
  const app = $('#app'), grip = $('#grip'), lcg = $('#lcgrip'), mq = window.matchMedia(STACKED);
  const setW = (w) => { const v = Math.round(Math.min(Math.max(w, 340), Math.max(360, window.innerWidth - 360))); app.style.setProperty('--panelw', v + 'px'); return v; };
  try { const w = Number(localStorage.getItem('exoplanetsciencelab.panelw')); if (w > 0) setW(w); } catch { /* storage unavailable */ }
  try { layoutSizes = JSON.parse(localStorage.getItem(SIZES_KEY) || '{}') || {}; } catch { layoutSizes = {}; }
  applyLayoutSizes();
  const has = (c) => app.classList.contains(c), box = (sel) => $(sel).getBoundingClientRect();
  // what a grip changes in the current layout: { key, now, min, max, at(clientY) } in px, or 'width' for the panel's width
  const target = (g) => {
    const st = box('#stage'), lc = box('#lc'), pn = box('#panel');
    if (!mq.matches) {
      if (g === grip) return 'width';
      return { key: 'lchSide', now: lc.height, min: 110, max: Math.max(110, st.height + lc.height - 90), at: (y) => lc.bottom - y };
    }
    if (g === lcg) {
      if (has('no-panel')) return { key: 'lchStack', now: lc.height, min: 140, max: Math.max(140, st.height + lc.height - 90), at: (y) => lc.bottom - y };
      return { key: 'stageStack', now: st.height, min: 90, max: Math.max(90, st.height + pn.height - 140), at: (y) => y - st.top };
    }
    if (!has('no-lc')) return { key: 'lchStack', now: lc.height, min: 140, max: Math.max(140, lc.height + pn.height - 140), at: (y) => y - lc.top };
    if (!has('no-stage')) return { key: 'stageStack', now: st.height, min: 90, max: Math.max(90, st.height + pn.height - 140), at: (y) => y - st.top };
    return null;
  };
  const setH = (t, px) => { layoutSizes[t.key] = Math.round(Math.min(t.max, Math.max(t.min, px))); applyLayoutSizes(); };
  const store = () => { try { localStorage.setItem(SIZES_KEY, JSON.stringify(layoutSizes)); localStorage.setItem('exoplanetsciencelab.panelw', parseInt(getComputedStyle(app).getPropertyValue('--panelw'), 10) || ''); } catch { /* ignore */ } };
  const aria = () => {
    grip.setAttribute('aria-orientation', mq.matches ? 'horizontal' : 'vertical');
    grip.setAttribute('aria-label', mq.matches ? 'Resize the plot above the panel' : 'Resize side panel');
    for (const g of [grip, lcg]) { const t = target(g); if (t && t !== 'width') { g.setAttribute('aria-valuenow', String(Math.round(t.now))); g.setAttribute('aria-valuemin', String(t.min)); g.setAttribute('aria-valuemax', String(Math.round(t.max))); } else if (t === 'width') g.setAttribute('aria-valuenow', String(Math.round(box('#panel').width))); }
  };
  for (const g of [grip, lcg]) {
    let drag = null;
    g.addEventListener('pointerdown', (e) => { const t = target(g); if (!t) return; e.preventDefault(); drag = t; g.setPointerCapture(e.pointerId); document.body.classList.add(t === 'width' ? 'resizing' : 'resizing-v'); });
    g.addEventListener('pointermove', (e) => { if (!drag) return; if (drag === 'width') setW(window.innerWidth - e.clientX); else setH(drag, drag.at(e.clientY)); });
    const end = () => { if (!drag) return; drag = null; document.body.classList.remove('resizing', 'resizing-v'); store(); aria(); afterLayoutChange(); };
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', () => {
      const t = target(g);
      if (t === 'width') { app.style.removeProperty('--panelw'); try { localStorage.removeItem('exoplanetsciencelab.panelw'); } catch { /* ignore */ } }
      else if (t) { delete layoutSizes[t.key]; applyLayoutSizes(); store(); }
      aria(); afterLayoutChange();
    });
    g.addEventListener('keydown', (e) => {
      const t = target(g); if (!t) return;
      const step = e.shiftKey ? 72 : 24;
      if (t === 'width') { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const w = parseInt(getComputedStyle(app).getPropertyValue('--panelw'), 10) || box('#panel').width; setW(w + (e.key === 'ArrowLeft' ? step : -step)); store(); aria(); afterLayoutChange(); } return; }
      // the edge moves with the arrow: up makes whatever lies above it shorter
      const up = t.key === 'lchSide' || (t.key === 'lchStack' && g === lcg) ? 1 : -1;
      let px = null;
      if (e.key === 'ArrowUp') px = t.now + up * step; else if (e.key === 'ArrowDown') px = t.now - up * step;
      else if (e.key === 'Home') px = up > 0 ? t.max : t.min; else if (e.key === 'End') px = up > 0 ? t.min : t.max;
      if (px === null) return;
      e.preventDefault(); setH(t, px); store(); requestAnimationFrame(() => { aria(); afterLayoutChange(); });
    });
  }
  mq.addEventListener('change', () => { aria(); afterLayoutChange(); });
  requestAnimationFrame(aria);
}

async function init() {
  lcPlot = new LightCurvePlot($('#lccanvas'));
  window.__esl = { ...(window.__esl || {}), S, lcPlot, undo, redo, api: makeAPI(), tour: runTour, setLayout, setLayoutSizes, layoutSizes: () => ({ ...layoutSizes }) };   // handle for tests, the guided tour, the assistant and console poking (keeps window.__esl.project, src/site/project.js)
  if (!window.__esl.project) window.__esl.project = projectHandle();
  lcPlot.onScrub = (t) => { S.t = t; S.playing = false; $('#play').textContent = '▶'; };
  setupLCToolbar(); setupResizer();
  const intro = initIntro({ h, examples: EXAMPLES, loadExample, applySession, fetchCatalog,
    // the first time the start page is left, offer the walk through the page
    onClose: () => { let done = true; try { done = !!localStorage.getItem('esl.tour.done'); } catch { /* storage unavailable */ } if (!done && !new URLSearchParams(location.search).has('skipintro')) setTimeout(runTour, 400); }, listSaved: listExperiments, openSaved, deleteSaved: deleteExperiment,
    importFile: async (file) => { importSession(JSON.parse(await file.text())); flash('Session loaded'); } });
  // the assistant is a separate chunk, fetched the first time it is opened
  $('#aibtn').addEventListener('click', async () => { try { const m = await import('./assistant/main.js'); m.openAssistant({ api: window.__esl.api, h, root: ROOT, saveFile }); } catch (err) { flash('The assistant could not be loaded: ' + err.message); } });
  $('#tourbtn').addEventListener('click', () => { if (!$('#intro').hidden) $('.iclose') && $('.iclose').click(); runTour(); });
  $('#tglc').addEventListener('click', () => setLayout({ lc: $('#app').classList.contains('no-lc') }));
  $('#tgpanel').addEventListener('click', () => setLayout({ panel: $('#app').classList.contains('no-panel') }));
  $('#savebtn').addEventListener('click', async () => { const name = prompt('Name this analysis (it is saved in this browser only):', S.title || planetLabel()); if (name === null) return; try { await saveCurrent(name.trim() || planetLabel()); } catch (err) { flash('Could not save: ' + err.message); } });
  mountNav($('#sitebar'));
  $('#startbtn').addEventListener('click', () => intro.open());
  window.__esl.intro = intro; window.__esl.loadExample = loadExample; window.__esl.examples = EXAMPLES;
  // the opening page is shown on arrival unless the address asks to skip it (tests, deep links)

  const ps = $('#preset');
  for (const [k, p] of Object.entries(PRESETS)) ps.append(h('option', { value: k }, p.label));
  ps.addEventListener('change', () => { if (ps.value === 'session') return; if (S.running) stopFit(); pushUndo(); loadPreset(ps.value); });
  const tabBtns = [...document.querySelectorAll('.tabs [data-tab]')];
  tabBtns.forEach((b, k) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
    // arrow keys move between tabs, as in any tab list
    b.addEventListener('keydown', (e) => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -k : e.key === 'End' ? tabBtns.length - 1 - k : 0; if (!d) return; e.preventDefault(); const nb = tabBtns[(k + d + tabBtns.length) % tabBtns.length]; showTab(nb.dataset.tab); nb.focus(); });
  });
  // one press gives the panel the whole screen (the 3D view and the plot fold away), the next brings them back
  $('#panelmax').addEventListener('click', () => { const a = $('#app'), full = a.classList.contains('no-stage') && a.classList.contains('no-lc'); setLayout(full ? { stage: true, lc: true } : { stage: false, lc: false, panel: true }); });
  $('#tgstage').addEventListener('click', () => setLayout({ stage: $('#app').classList.contains('no-stage') }));
  // plots inside the panel are drawn at the size they have: draw them again when the panel changes width (rotation, window resize, folding)
  { let pw = 0, pt = 0; new ResizeObserver((en) => { const w = Math.round(en[0].contentRect.width); if (!w || w === pw) return; pw = w; clearTimeout(pt); pt = setTimeout(() => { if (S.fit && S.fit.redraw) S.fit.redraw(); if (timingRedraw) timingRedraw(); refresh(); }, 120); }).observe($('#panel')); }
  $('#play').addEventListener('click', () => { S.playing = !S.playing; $('#play').textContent = S.playing ? '❚❚' : '▶'; });
  $('#speed').addEventListener('input', (e) => setRate(Number(e.target.value)));
  $('#rec').addEventListener('click', recordClip);
  const rf = $('#recfmt');
  for (const [k, f] of Object.entries(MOVIE_FORMATS)) rf.append(h('option', { value: k }, f.label));
  try { const k = localStorage.getItem('esl.recfmt'); if (k && MOVIE_FORMATS[k]) rf.value = k; } catch { /* storage unavailable */ }
  rf.addEventListener('change', () => { try { localStorage.setItem('esl.recfmt', rf.value); } catch { /* ignore */ } });
  if (!movieSupport()) { $('#rec').hidden = true; rf.hidden = true; }
  $('#undo').addEventListener('click', undo); $('#redo').addEventListener('click', redo);
  // undo / redo anywhere on the page; text areas keep their own typing undo
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase(), tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || (tag === 'input' && e.target.type === 'text')) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
  document.querySelectorAll('#loopseg button').forEach((b) => b.addEventListener('click', () => { S.loop = b.dataset.loop; document.querySelectorAll('#loopseg button').forEach((x) => x.classList.toggle('on', x === b)); S.t = cur(S.values).tmid; syncDefaultRate(cur(S.values)); S.playing = true; $('#play').textContent = '❚❚'; }));
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
  // how the visitor arrived: with a light curve from the photometry page, with a planet to look up, or plainly
  const query = new URLSearchParams(location.search);
  if (query.get('handoff')) {
    // a light curve produced on another page of the site (photometry), passed through local storage
    try { const hnd = JSON.parse(localStorage.getItem('esl.handoff') || 'null'); if (hnd && hnd.kind === 'lightcurve' && hnd.text) { S.parseOpts = { time: 'auto', flux: 'auto' }; loadHandoffText(hnd); handoffDetrend(hnd); if (hnd.exptimeDays > 0) { S.exptimeMin = Number((hnd.exptimeDays * 1440).toFixed(4)); refresh(); } showTab('data'); flash('Light curve received'); localStorage.removeItem('esl.handoff'); try { projectHandle().addFile({ kind: 'lightcurve', name: hnd.name || 'light curve', page: 'photometry', n: S.data.t.length }); } catch { /* no project */ } } } catch (err) { console.warn('hand-off failed', err); }
  } else if (query.get('planet')) {
    // ?rv=find: load the system straight from the catalogue and search the velocity archives for it (the project's
    // "Add archival velocities" step); otherwise the start page shows the system and its sources first
    if (query.get('rv') === 'find') catalogSession(query.get('planet'), ['transit', 'rv']).then((sess) => { applySession(sess); showTab('data'); return findArchiveRV(); }).catch((err) => { flash('Velocity search: ' + err.message); console.warn(err); });
    else if (parseTOIName(query.get('planet'))) catalogSession(query.get('planet'), ['transit']).then(applySession).catch((err) => { flash(err.message); intro.lookup(query.get('planet')); });
    else intro.lookup(query.get('planet'));
  } else if (!query.has('skipintro')) intro.open();
  if (['system', 'data', 'fit', 'results', 'timing'].includes(query.get('tab'))) showTab(query.get('tab'));
  // the project checklist's button for a step on this page brings the right tab forward
  window.addEventListener('esl-project-step', (e) => { const tab = { fit: 'data', rv: 'data', joint: 'fit', compare: 'results', report: 'results' }[e.detail]; if (tab) { if (!$('#intro').hidden && $('.iclose')) $('.iclose').click(); showTab(tab); if (e.detail === 'rv') { const b = $('#rvfind'); if (b) b.scrollIntoView({ block: 'center' }); } } });
}
init();
