// window.__esl.api: the scripted surface of the analyzer, used by the headless checks, the stored-results builder
// and the assistant. The same actions the panels perform, as functions that take and return plain data.
//
// createAPI(app) -> api.  `app` is what main.js lends this module (the pattern of timingTab.js and dynamics.js):
// the state object S, the undo stack, and the panel actions by name. Rules kept here:
//   * every call that changes something the user can change goes through pushUndo(), once per call;
//   * data and fit results are replaced, never edited in place;
//   * a call that cannot do what was asked throws an Error whose message says why in plain words;
//   * describe() lists every function with its arguments, so a tool list can be generated from it.
// Times: values, priors and data times are days relative to state().lightCurve.timeReference. Where a call takes a
// time, a value above 100000 is read as a Julian date and converted.

import { validatePrior } from '../core/priors.js';
import { parseTimings } from '../core/ephemeris.js';
import { derived as orbitDerived } from '../core/kepler.js';
import { deriveSystem } from '../core/derive.js';
import { LD_LAWS } from '../core/limbdark.js';
import { FILTERS } from '../core/ldest.js';
import { PLANET_FIELDS, planetKey } from '../core/model.js';
import { MOON_FIELDS } from '../core/exomoon.js';
import { keepPoints, clipData, binData } from './dataedit.js';
import { companionSearch as searchCompanion, dynamicsEpoch } from './dynamics.js';

// ---- argument schemas (JSON Schema fragments) for describe() -------------------------------------------------
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const obj = (description, properties, extra = {}) => ({ type: 'object', description, properties, ...extra });
const arr = (description, items, extra = {}) => ({ type: 'array', description, items, ...extra });
const PRIOR = obj('A prior: uniform between a and b, or normal with mean a and standard deviation b.', { type: str('Kind of prior.', { enum: ['uniform', 'normal'] }), a: num('Lower bound, or mean.'), b: num('Upper bound, or standard deviation.') }, { required: ['type', 'a', 'b'] });
const VIEWS = ['lc', 'residuals', 'corner', 'rv', 'timing', 'phase', 'map', 'moon', 'system'];
const KEY = 'Parameter key as listed by state().parameters: "rprs", "inc", "tmid", "per", "ecc", "omega", "mplanet", "ld0".."ld3", "a2"; a further planet is scoped by its letter ("per@c"), an epoch or velocity set by its number ("a2@2", "jit@rv1"); star: "teff", "feh", "logg", "mstar", "rstar", and the host’s "ra", "dec" (J2000 degrees: archive searches, time conversion) and 2MASS "jmag", "kmag" (TSM, ESM).';

// name -> [one-line description, [[argument name, schema, required]], what it returns]; exported for the docs generator
export const API_DOC = {
  state: ['What is loaded and how the fit is set up: planets, data, every parameter with its value, free flag and prior, limb darkening, optional models, sampler, whether a fit is running or finished.', [], 'object'],
  describe: ['This list: every function of the API with a one-line description and the schema of its arguments.', [], 'array of { name, description, args: [{ name, required, schema }], parameters (JSON Schema of the arguments by name), returns }'],
  examples: ['The worked examples that can be opened.', [], 'array of { id, title, about, kinds, python }'],
  loadExample: ['Open a worked example. It opens with a stored posterior unless fresh is true, which builds it from its data instead.', [['id', str('Example id from examples().'), true], ['options', obj('Options.', { fresh: bool('Build the example from its data instead of opening the stored run.') }), false]], 'true'],
  lookup: ['Load a planet or host star from the bundled NASA Exoplanet Archive snapshot, with a simulated light curve as a stand-in for data.', [['name', str('Planet or host name, for example "WASP-12 b".'), true], ['kinds', arr('Kinds of data the analysis is for.', { type: 'string', enum: ['transit', 'rv', 'ephemeris'] }), false]], 'true'],
  setValue: ['Set the value of a model or stellar parameter.', [['key', str(KEY), true], ['value', num('New value. Mid-transit times are days relative to the time reference or, above 100000, a Julian date (BJD), converted; this holds for every planet (tmid, tmid@c)'), true]], 'nothing'],
  setFree: ['Make a parameter free (sampled in the fit) or hold it fixed. a/R★ can never be free.', [['key', str(KEY), true], ['free', bool('true to fit it, false to hold it.'), true]], 'nothing'],
  setPrior: ['Set the prior of a parameter. For a mid-transit time (tmid, tmid@c) bounds or a mean above 100000 are read as Julian dates (BJD) and converted.', [['key', str(KEY), true], ['prior', PRIOR, true]], 'nothing'],
  setUse: ['Choose which kinds of data enter the fit.', [['use', obj('Any of the three flags.', { lc: bool('Light curve.'), rv: bool('Radial velocities.'), timing: bool('Mid-transit and mid-eclipse times of the Timing tab.') }), true]], 'nothing'],
  setKepler: ['Tie a/R★ of every planet to Kepler’s law (M★, R★, period, planet mass) instead of holding a free value. Needed for joint transit and velocity fits.', [['on', bool('true to use Kepler’s law.'), true]], 'nothing'],
  setSampler: ['Change nested-sampling settings.', [['settings', obj('Any of the settings.', { nlive: num('Live points (50 to 4000).'), fracRemain: num('Stop when this fraction of the evidence remains.'), seed: num('Random seed.'), maxCalls: num('Budget of likelihood calls.') }), true]], 'nothing'],
  setLimbDarkening: ['Change how the star’s limb darkening is described: the law, whether the coefficients are sampled directly or follow the star (T eff, [Fe/H]), the bandpass, and the coefficients themselves.', [['options', obj('Any of the four; at least one.', {
    law: str('Limb darkening law.', { enum: Object.keys(LD_LAWS) }), mode: str('"coeffs": the coefficients are parameters; "star": they follow T eff and [Fe/H] through the model-atmosphere table.', { enum: ['coeffs', 'star'] }),
    band: { description: 'Bandpass: a name from state().limbDarkening.bands, or [min, max] in nm for a custom range (200 to 5500).', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] },
    coeffs: { description: 'The coefficients of the law, in order (as many as the law has), or "star" to set them from the stellar parameters and the band (a new band alone leaves the coefficients as they are).', anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'string', enum: ['star'] }] } }), true]], '{ law, mode, band, coeffs }'],
  addPlanet: ['Add a planet to the system. Without values it is a copy of the planet on show at 2.3 times its period, to be edited.', [['options', obj('Optional letter and starting values.', { letter: str('One lowercase letter not in use; the next free one by default.'), values: obj('Planet parameters by name: rprs, ars, inc, per, tmid, ecc, omega, mplanet (Jupiter masses).', {}, { additionalProperties: { type: 'number' } }) }), false]], 'the new planet’s letter'],
  removePlanet: ['Remove a planet (not the first one) with its parameters, moon, own-light model and listed times.', [['letter', str('Letter of the planet to remove.'), true]], 'nothing'],
  showPlanet: ['Choose the planet the sliders, the system view and the folded plots show.', [['letter', str('Planet letter.'), true]], 'nothing'],
  loadLightCurve: ['Replace the light curve with one read from text (CSV or whitespace columns: time, flux, error, optional airmass; AAVSO and EXOTIC final light-curve files are recognised).', [['text', str('File contents.'), true], ['name', str('Name to show for it.'), false]], '{ points, notes }'],
  addLightCurveEpoch: ['Add another light curve of the same planet as a further epoch, fitted together with what is loaded.', [['text', str('File contents.'), true], ['name', str('Name of the epoch.'), false]], '{ epochs }'],
  addRadialVelocities: ['Add radial velocities from text (time, velocity, uncertainty, optional instrument name). Each instrument becomes its own dataset.', [['text', str('File contents.'), true], ['name', str('Name of the set.'), false]], 'array of { name, points }'],
  findRadialVelocities: ['Search the public radial-velocity archives (Keck/HIRES: Butler et al. 2017 and its correction by Tal-Or et al. 2019; ESO/HARPS RVBank, Trifonov et al. 2020; Lick, Fischer et al. 2014; all through VizieR) at the host star’s position. Takes a few seconds. Lists every set found, one per instrument era (each has its own zero point); nothing is loaded until addRadialVelocitySet.', [['name', str('Planet or host to search for; default the system on show. A different system is looked up in the catalogue for its position, but its sets can only be added once that system is loaded.'), false]], '{ star, ra, dec, sets: [{ id, source, catalog, label, instrument, set, points, first, last (BJD), span_days, median_error (m/s), star (the catalogue’s name), separation_arcsec, reference, bibcode, doi, same_as (a source holding the same observations), added }], sources: [{ source, label, status: found|none|error, star, message, mirror, notes }] }'],
  addRadialVelocitySet: ['Add one or more sets found by findRadialVelocities as velocity datasets, each with its own zero point and jitter; where they came from (catalogue, reference, bibcode, star name, retrieval time) is kept with the data and saved in the session. Refuses two sources that hold the same observations.', [['id', { description: 'A set id from findRadialVelocities().sets, or an array of them.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, true]], 'array of { name, points, source } for the sets added'],
  setEccentricityParameters: ['Sample the eccentricity of the planet on show as e and ω, or as √e cos ω and √e sin ω (keys "secosw", "sesinw"; uniform priors on them are uniform in e and ω, without the edge at e = 0 or the wrap of ω). The orbit and what is free carry over.', [['sqrtE', bool('true for √e cos ω, √e sin ω; false for e, ω.'), true]], '{ sqrtE, keys }'],
  setupJointFit: ['Set up a joint fit of the light curve, the radial velocities and any listed times: a/R★ from Kepler’s law, all loaded data in the fit, the planet masses, jitters, period, T mid, Rp/R★ and i free (e and ω too for eccentric orbits). Needs velocities and a dated light curve. One undo step.', [], 'array of the free parameter keys'],
  setDetrend: ['Choose the systematics model of the light curve from the detector columns it carries (from the photometry page, or extra columns of a file: xc, yc, sky, fwhm, comp, pld1…): linear terms (each with its own coefficient per epoch, integrated out like the normalisation), a Legendre polynomial in time, PLD components, and a nearest-neighbour kernel on the detector position (built night by night; its ln Z is not comparable with a fit without it). null removes the model.', [['spec', { description: 'null, or the model.', anyOf: [{ type: 'null' }, obj('', { columns: arr('Column names as linear terms; also "xy", "xc2", "yc2" (products and squares of the centroids).', { type: 'string' }), poly: num('Order of the time polynomial, 0 to 3.'), pld: arr('Names of the PLD columns to use, e.g. ["pld1", "pld2"].', { type: 'string' }), kernel: { description: 'null, or the kernel.', anyOf: [{ type: 'null' }, obj('', { features: arr('Columns the neighbours are found in, e.g. ["xc", "yc"].', { type: 'string' }), neighbors: num('Neighbours per point (default 50).') })] } })] }, true]], '{ names (linear terms in the model), dropped: [{ name, why }], kernel (its features or null) }'],
  setTimings: ['Replace the mid-transit times of the planet on show (Timing tab).', [['text', str('Rows "time, uncertainty" or "epoch, time, uncertainty", times in days (BJD).'), true]], '{ times }'],
  simulate: ['Replace the light curve with a simulated observation of the current system; the current values become the hidden truth marked on the posterior plot.', [['options', obj('Any of the settings; the rest keep their last values.', { noise_ppm: num('White noise per exposure, ppm.'), cadence_min: num('Cadence, which is also the exposure time, minutes.'), span: num('Length of each simulated observation in hours, centred on mid-transit. It must exceed the transit duration.'), baseline_hr: num('Alternative to span: out-of-transit time on each side of the transit, hours.'), seed: num('Random seed.'), epochs: num('Number of transits to observe (1 to 200); more than one makes a multi-epoch dataset.'), epoch_step: num('Orbits between one simulated transit and the next.'), airmass: bool('Add an airmass trend, as on a ground-based night.') }), false]], '{ points, epochs, cadence_min, noise_ppm, span_hr }'],
  editData: ['Edit the loaded light curve: remove an epoch, trim to a time window, clip outliers against the current model, bin. Applied in that order. The earlier runs’ evidences stop being comparable.', [['options', obj('At least one edit.', { remove_epoch: num('Number of the epoch to remove, counted from 1 as on the Data tab.'), trim: arr('Keep only points between two times [t0, t1], days relative to the time reference (or Julian dates).', { type: 'number' }, { minItems: 2, maxItems: 2 }), clip_sigma: num('Remove points further than this many robust standard deviations (1.4826 × MAD, per epoch) from the current model.'), bin_min: num('Bin into inverse-variance weighted means over this many minutes.') }), true]], '{ points, removed, epochs, steps }'],
  setView: ['Choose what the plot under the system view shows.', [['options', obj('Any of the three.', { view: str('Plot view.', { enum: ['lc', 'rv', 'phase', 'map', 'moon'] }), fold: bool('Fold on the period.'), allPlanets: bool('Every planet’s folded panel side by side.') }), true]], 'nothing'],
  showTab: ['Bring a tab of the side panel to the front.', [['name', str('Tab.', { enum: ['system', 'data', 'fit', 'results', 'timing'] }), true]], 'nothing'],
  setPhase: ['Model the planet’s own light (secondary eclipse, phase curve, map) for the planet on show, or take it out with null.', [['options', { description: 'null removes the model. Otherwise the description of the brightness.', anyOf: [{ type: 'null' }, obj('', { mode: str('"harmonic": a sinusoidal phase curve; "map": spherical harmonics on the planet.', { enum: ['harmonic', 'map'] }), lmax: num('Degree of the map, 1 to 3 (maps only).') })] }, true]], '{ mode, lmax } or null'],
  setMoon: ['Give the planet on show a moon, or take it away.', [['on', { description: 'true adds a moon with starting values, false removes it; an object sets the moon’s parameters.', anyOf: [{ type: 'boolean' }, obj('', { rmoon: num('Moon radius over stellar radius.'), permoon: num('Moon period, days.'), phmoon: num('Moon phase at mid-transit, 0 to 1.'), mmoon: num('Moon mass over planet mass.'), imoon: num('Tilt of the moon’s orbit, degrees.') })] }, true]], '{ rmoon, permoon, phmoon, mmoon, imoon } or null'],
  setNbody: ['Switch fits of mid-transit times and velocities to an N-body integration of the planets, or back to independent Keplerian orbits with null. Needs two planets with masses and the stellar mass.', [['options', { description: 'null switches it off.', anyOf: [{ type: 'null' }, obj('', { epoch: num('Reference epoch of the orbital elements (days relative to the time reference, or a Julian date). Default: half an orbit before the first datum.'), linear: bool('Fit a straight line in epoch to each planet’s simulated times inside the likelihood.'), stepsPerOrbit: num('Integrator steps per shortest orbit.') })] }, true]], 'the N-body settings or null'],
  companionSearch: ['Search the mid-transit times of the planet on show for an unseen companion: N-body simulations on a grid of companion mass and period. Takes seconds to a minute. Needs at least eight times and the planet’s mass.', [['options', obj('Optional grid settings.', { phases: num('Starting phases tried per cell (default 8).'), masses: arr('Companion masses to try, Jupiter masses.', { type: 'number' }), ratios: arr('Companion period over the planet’s period to try.', { type: 'number' }), refine: bool('Polish the best cells (default true).') }), false]], '{ mass, period, tmid, inc, epoch, host: { per, tmid }, chi2, chi2_no_companion, delta_chi2, n_times, significant, period_ratio, simulations, seconds }: the best cell, in the form addCompanion takes'],
  addCompanion: ['Add the companion found by companionSearch as a planet, switch the N-body model on and free its mass, period and phase, ready for a fit of the times.', [['cell', obj('The object companionSearch returned.', { mass: num('M Jup.'), period: num('days.'), tmid: num('days relative to the time reference.'), inc: num('degrees.'), epoch: num('reference epoch.'), host: obj('Period and T mid of the transiting planet at the epoch.', { per: num(''), tmid: num('') }) }, { required: ['mass', 'period', 'tmid', 'epoch', 'host'] }), true]], 'the new planet’s letter'],
  run: ['Run the nested-sampling fit and wait for it. Resolves with the result summary; rejects with the reason it could not start or failed.', [], 'the object results() returns'],
  stop: ['Stop a running fit; it returns the posterior collected so far, marked as not converged.', [], 'nothing'],
  progress: ['How far a running fit has come.', [], '{ running, calls, logZ, eta_s (seconds left, a rough extrapolation; null early on), fraction (0 to 1), iterations, efficiency, elapsed_s }'],
  results: ['The current fit: medians and 68% intervals of the fitted parameters, derived quantities, evidence, chi-square, warnings. null when there is none.', [], 'object or null'],
  derived: ['The rows of the system table. After a fit: every row with its uncertainty and whether it was fitted, derived, input or fixed. Before a fit: the quantities that follow from the current values, without uncertainties.', [], 'array of { section, label, value, minus, plus, unit, kind }'],
  runs: ['The fits made in this session.', [], 'array of { id, free (parameter keys), labels, model, n_free, logZ, logZerr, converged, chi2, n_data, bic, information, ncalls, same_data (as the data now loaded), showing, cautions }'],
  compare: ['Compare two runs of this session by their evidence, in the words the Results tab uses, with the cautions that apply.', [['idA', num('Run id from runs().'), true], ['idB', num('Run id from runs().'), true]], '{ a, b, delta_lnZ (ln Z of a minus ln Z of b), delta_lnZ_err, comparable, preferred (run id or null), reading, words, cautions }'],
  restoreRun: ['Bring an earlier run back: its posterior, tables, priors and best-fit model.', [['id', num('Run id from runs().'), true]], 'the object results() returns'],
  figure: ['A plot as a PNG image, drawn by the same code as the exported figures.', [['view', str('Which plot. "lc": light curve with model and residual strip; "residuals": residuals and their histogram; "corner": posterior (needs a fit; its height follows its width); "rv": radial velocities; "timing": O − C diagram; "phase": full-orbit phase curve; "map": brightness map; "moon": the moon’s effects; "system": the 3D system view as it is on screen.', { enum: VIEWS }), true], ['options', obj('Optional size and theme.', { width: num('Width in CSS pixels (default 900).'), height: num('Height in CSS pixels (default 540).'), theme: str('White or dark background (default light).', { enum: ['light', 'dark'] }), scale: num('Pixels per CSS pixel (default 2).') }), false]], 'a "data:image/png;base64,…" URL'],
  exportSession: ['The whole analysis as a session document (docs/FORMAT.md): system, data, priors, sampler and, with a fit, the result.', [['withResult', bool('Include the fit result (default true).'), false]], 'session document'],
  importSession: ['Load a session document. This replaces the system, the data and the set-up.', [['session', obj('A session document.', {}), true]], 'the document'],
  save: ['Save the analysis in this browser.', [['name', str('Name to save it under.'), false]], '{ id, name, … }'],
  listSaved: ['The analyses saved in this browser.', [], 'array of { id, name, summary, updated }'],
  openSaved: ['Open a saved analysis.', [['id', { description: 'Id from listSaved().' }, true]], 'nothing'],
  deleteSaved: ['Delete a saved analysis from this browser.', [['id', { description: 'Id from listSaved().' }, true]], 'nothing'],
  undo: ['Undo the last change.', [], 'nothing'],
  redo: ['Redo the change that was undone.', [], 'nothing'],
};

export function createAPI(app) {
  const { S, UNDO } = app;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tRef = () => S.data.tRef || 0, rel = (t) => (t > 1e5 ? t - tRef() : t);
  const idle = (what) => { if (S.running) throw new Error(`a fit is running: stop it or wait for it to finish before ${what}`); };
  /** A change made of several panel actions is one step for undo. */
  const once = (fn) => { const n = UNDO.length, out = fn(); if (UNDO.length > n + 1) UNDO.length = n + 1; return out; };
  const finite = (v, name) => { const x = Number(v); if (!Number.isFinite(x)) throw new Error(`${name} must be a number`); return x; };
  const positive = (v, name) => { const x = finite(v, name); if (!(x > 0)) throw new Error(`${name} must be greater than zero`); return x; };
  const letterOf = (sfx = S.pl) => (S.planets.find((p) => p.sfx === sfx) || S.planets[0]).letter;
  const planetBy = (letter) => { const p = S.planets.find((x) => x.letter === letter); if (!p) throw new Error(`there is no planet ${letter}; the planets are ${S.planets.map((x) => x.letter).join(', ')}`); return p; };
  const runBy = (id) => { const r = S.runs.find((x) => x.id === Number(id)); if (!r) throw new Error(S.runs.length ? `there is no run #${id}; this session has runs ${S.runs.map((x) => '#' + x.id).join(', ')}` : `there is no run #${id}: no fit has been run in this session`); return r; };
  const STAR_KEYS = ['teff', 'feh', 'logg', 'mstar', 'rstar', 'ra', 'dec', 'jmag', 'kmag'];
  const known = (key) => { if (STAR_KEYS.includes(key)) return; const b = app.baseKey(key); if (!(key in S.values) && !app.fitParams().some((p) => p.key === key) && !app.allParams().some((p) => p.key === key) && !PLANET_FIELDS.includes(b)) throw new Error(`“${key}” is not a parameter of this model; state().parameters lists them`); };
  const setIn = (o, key, v) => { app.pushUndo(); o[key] = v; S.fit = null; S.range = 'full'; app.buildPanels(); app.refresh(); };
  const moonValues = () => (app.hasMoon() ? Object.fromEntries(MOON_FIELDS.filter((f) => S.values[planetKey(f, S.pl)] !== undefined).map((f) => [f, S.values[planetKey(f, S.pl)]])) : null);
  const bandNames = () => [...Object.keys(FILTERS), 'Custom range'];

  const api = {
    state() {
      const act = app.fitParams(), model = app.model();
      return { name: S.name, planets: S.planets.map((p) => p.letter), showing: letterOf(), kepler: S.kepler,
        detrend: S.data.columns ? { columns: Object.keys(S.data.columns), model: S.data.detrend || null, inModel: S.data.detrendInfo ? S.data.detrendInfo.names : [], kernel: S.data.detrendInfo ? S.data.detrendInfo.kernel : null, dropped: S.data.detrendInfo ? S.data.detrendInfo.dropped : [] } : null,
        lightCurve: { name: S.data.name, points: S.data.t.length, epochs: app.nEpochs(), airmass: !!S.data.airmass, inFit: S.use.lc, timeReference: tRef(), start: S.data.t[0], end: S.data.t[S.data.t.length - 1], exposure_min: S.exptimeMin, synthetic: !!S.data.synthetic },
        radialVelocity: S.rv.map((r) => ({ name: r.name, points: r.t.length, source: r.source ? { reference: r.source.reference, bibcode: r.source.bibcode, catalog: r.source.catalog, star: r.source.star } : null })), eccentricity: app.usesSqrtE() ? 'secosw, sesinw' : 'ecc, omega', rvInFit: app.rvOn(), timing: { points: S.timing.rows.length, inFit: S.use.timing },
        parameters: act.map((p) => ({ key: p.key, label: p.label, unit: p.unit || '', value: app.paramValue(p.key), free: !!S.free[p.key], prior: S.priors[p.key] || null, group: p.group })),
        star: { ...S.star }, limbDarkening: { law: S.ldLaw, mode: S.ldMode, band: S.band, bandCustom: [...S.bandCustom], coeffs: LD_LAWS[S.ldLaw].names.map((_, i) => S.values['ld' + i]), bands: bandNames() },
        models: { moon: moonValues(), planetLight: app.hasPhase() ? { mode: app.phaseSpec().mode, lmax: app.phaseSpec().lmax } : null, nbody: S.nbody ? { ...S.nbody } : null },
        view: { view: S.view, fold: S.fold, allPlanets: S.allPlanets },
        sampler: { ...S.sampler }, running: S.running, hasResult: !!S.fit, runs: S.runs.length, chi2: model ? model.chi2 : null };
    },
    describe() {
      return Object.keys(api).map((name) => {
        const [description, args, returns] = API_DOC[name] || ['', [], ''];
        return { name, description, args: args.map(([n, schema, required]) => ({ name: n, required: !!required, schema })),
          parameters: { type: 'object', properties: Object.fromEntries(args.map(([n, schema]) => [n, schema])), required: args.filter((a) => a[2]).map((a) => a[0]) }, returns };
      });
    },
    examples: () => app.EXAMPLES.map((e) => ({ id: e.id, title: e.title, about: e.sub, kinds: e.kinds, python: e.python || null })),
    async loadExample(id, { fresh = false } = {}) { const ex = app.EXAMPLES.find((e) => e.id === id); if (!ex) throw new Error(`there is no example “${id}”; examples() lists them`); await app.loadExample(ex, fresh); return true; },
    async lookup(name, kinds = ['transit']) { app.applySession(await app.catalogSession(name, kinds)); return true; },

    // ---- parameters, priors, what is fitted -----------------------------------------------------------------
    setValue(key, v) { idle('changing a value'); known(key); let x = finite(v, `the value of ${key}`); if (app.baseKey(key) === 'tmid') x = rel(x); if (key === 'ra' && !(x >= 0 && x < 360)) throw new Error('ra is in degrees, 0 to 360'); if (key === 'dec' && !(x >= -90 && x <= 90)) throw new Error('dec is in degrees, −90 to 90'); if (STAR_KEYS.includes(key)) setIn(S.star, key, x); else setIn(S.values, key, x); },
    setFree(key, on) { idle('changing what is fitted'); known(key); if (app.baseKey(key) === 'ars') throw new Error('a/R★ cannot be fitted (it is degenerate with the inclination): switch on Kepler’s law with setKepler(true) and fit M★ instead'); app.pushUndo(); S.free[key] = !!on; if (!S.priors[key]) S.priors[key] = app.defaultPrior(key); S.fit = null; app.buildPanels(); },
    setPrior(key, prior) { idle('changing a prior'); known(key); const bad = !prior || typeof prior !== 'object' ? 'give { type: "uniform" | "normal", a, b }' : validatePrior(prior); if (bad) throw new Error(`prior for ${key}: ${bad}`); const isT = app.baseKey(key) === 'tmid'; app.pushUndo(); S.priors[key] = { type: prior.type, a: isT ? rel(Number(prior.a)) : Number(prior.a), b: isT && prior.type === 'uniform' ? rel(Number(prior.b)) : Number(prior.b) }; app.buildPanels(); },
    setUse(use) { idle('changing which data are fitted'); app.pushUndo(); S.use = { ...S.use, ...use }; if (S.use.rv) app.ensureRVParams(); S.fit = null; app.buildPanels(); app.refresh(); },
    setKepler(on) { idle('changing the orbit model'); app.pushUndo(); app.setKepler(!!on); },
    setSampler(o) { idle('changing the sampler'); app.pushUndo(); S.sampler = { ...S.sampler, ...o }; app.buildFitTab(); },
    setLimbDarkening(o = {}) {
      idle('changing the limb darkening');
      const has = (k) => o[k] !== undefined && o[k] !== null;
      if (!['law', 'mode', 'band', 'coeffs'].some(has)) throw new Error('give at least one of law, mode, band, coeffs');
      if (has('law') && !LD_LAWS[o.law]) throw new Error(`“${o.law}” is not a limb darkening law; choose one of ${Object.keys(LD_LAWS).join(', ')}`);
      if (has('mode') && o.mode !== 'coeffs' && o.mode !== 'star') throw new Error('mode is "coeffs" (sample the coefficients) or "star" (they follow T eff and [Fe/H])');
      const law = has('law') ? o.law : S.ldLaw, mode = has('mode') ? o.mode : S.ldMode, n = LD_LAWS[law].names.length;
      let band = null, custom = null;
      if (has('band')) {
        if (Array.isArray(o.band)) { custom = [finite(o.band[0], 'band minimum'), finite(o.band[1], 'band maximum')]; if (!(custom[1] > custom[0])) throw new Error('a custom band is [minimum, maximum] in nm, minimum first'); band = 'Custom range'; }
        else { const want = String(o.band).toLowerCase(), names = bandNames(); band = names.find((b) => b.toLowerCase() === want) || names.find((b) => b.replace(' (approx.)', '').toLowerCase() === want); if (!band) throw new Error(`“${o.band}” is not a known band; choose one of ${Object.keys(FILTERS).map((b) => b.replace(' (approx.)', '')).join(', ')}, or give [min, max] in nm`); }
      }
      let coeffs = null;
      if (has('coeffs') && o.coeffs !== 'star') {
        if (mode === 'star') throw new Error('in "star" mode the coefficients follow T eff and [Fe/H]: set mode to "coeffs" to give them yourself');
        if (!Array.isArray(o.coeffs) || o.coeffs.length !== n) throw new Error(`the ${LD_LAWS[law].label} law takes ${n} coefficient${n === 1 ? '' : 's'} (${LD_LAWS[law].names.join(', ') || 'none'})`);
        coeffs = o.coeffs.map((c, i) => finite(c, `coefficient ${i + 1}`));
      }
      once(() => {
        app.pushUndo();
        if (law !== S.ldLaw) app.changeLaw(law);
        if (band) { S.band = band; if (custom) S.bandCustom = custom; }
        if (mode !== S.ldMode) app.setLDMode(mode);
        if (coeffs) { coeffs.forEach((c, i) => (S.values['ld' + i] = c)); S.ldProfile = null; }
        else if (o.coeffs === 'star' && mode === 'coeffs') app.estimateLD();   // set them from the star, the band and the model-atmosphere table
        S.fit = null; S.range = 'full'; app.resyncLD(); app.buildPanels(); app.refresh();
      });
      return { law: S.ldLaw, mode: S.ldMode, band: S.band === 'Custom range' ? [...S.bandCustom] : S.band, coeffs: LD_LAWS[S.ldLaw].names.map((_, i) => S.values['ld' + i]) };
    },

    // ---- planets -------------------------------------------------------------------------------------------
    addPlanet(o = {}) {
      idle('adding a planet');
      const used = new Set(S.planets.map((p) => p.letter));
      if (o.letter !== undefined) { if (!/^[a-z]$/.test(o.letter)) throw new Error('a planet letter is one lowercase letter, b to z'); if (used.has(o.letter)) throw new Error(`there is already a planet ${o.letter}`); }
      const values = {};
      for (const [f, v] of Object.entries(o.values || {})) { if (!PLANET_FIELDS.includes(f) || f === 'K') throw new Error(`“${f}” is not a planet parameter; use ${PLANET_FIELDS.filter((x) => x !== 'K').join(', ')}`); values[f] = f === 'tmid' ? rel(finite(v, f)) : finite(v, f); }
      const letter = app.addPlanetWith({ letter: o.letter, values });
      if (!letter) throw new Error('no letter is left for another planet');
      return letter;
    },
    removePlanet(letter) { idle('removing a planet'); const p = planetBy(letter); if (S.planets.length < 2) throw new Error('the system has one planet: it cannot be removed'); if (!p.sfx) throw new Error(`planet ${letter} is the first planet of the system, whose parameters carry no letter; remove another planet, or load the system without it`); app.removePlanet(p.sfx); },
    showPlanet(letter) { const p = planetBy(letter); app.pushUndo(); S.pl = p.sfx; app.buildPanels(); app.refresh(true); },

    // ---- data ------------------------------------------------------------------------------------------------
    loadLightCurve(text, name = 'Light curve') { idle('loading data'); S.parseOpts = { time: 'auto', flux: 'auto' }; app.loadText(text, name, null); return { points: S.data.t.length, notes: S.data.notes || [] }; },
    addLightCurveEpoch(text, name = 'epoch') { idle('loading data'); app.addEpochText(text, name, null); return { epochs: app.nEpochs() }; },
    addRadialVelocities(text, name = 'RV') { idle('loading data'); app.addRVText(text, name, null); return S.rv.map((r) => ({ name: r.name, points: r.t.length })); },
    async findRadialVelocities(name) { idle('searching the archives'); return app.findArchiveRV(name ? String(name) : undefined); },
    addRadialVelocitySet(id) {
      idle('loading data');
      if (id === undefined || id === null || (Array.isArray(id) && !id.length)) throw new Error('give a set id from findRadialVelocities().sets');
      const sets = app.addArchiveRV(Array.isArray(id) ? id.map(String) : String(id));
      return sets.map((x) => ({ name: x.name, points: x.t.length, source: x.source ? { ...x.source } : null }));
    },
    setEccentricityParameters(on) {
      idle('changing the model');
      if (typeof on !== 'boolean') throw new Error('give true (√e cos ω, √e sin ω) or false (e and ω)');
      app.setSqrtE(on);
      const k = (f) => planetKey(f, S.pl);
      return { sqrtE: app.usesSqrtE(), keys: app.usesSqrtE() ? [k('secosw'), k('sesinw')] : [k('ecc'), k('omega')] };
    },
    setupJointFit() { idle('changing the set-up'); return app.setupJointFit(); },
    setDetrend(spec) {
      idle('changing the systematics model');
      if (spec !== null && (typeof spec !== 'object' || Array.isArray(spec))) throw new Error('give null or { columns, poly, pld, kernel }');
      if (spec && spec.poly !== undefined && !(Number.isInteger(spec.poly) && spec.poly >= 0 && spec.poly <= 3)) throw new Error('poly is the order of the time polynomial, 0 to 3');
      const info = app.setDetrend(spec ? { columns: spec.columns || [], poly: spec.poly || 0, pld: spec.pld || [], kernel: spec.kernel || null } : null);
      return { names: [...info.names], dropped: info.dropped.map((x) => ({ ...x })), kernel: info.kernel };
    },
    setTimings(text) { idle('changing the timing list'); const p = parseTimings(text); app.pushUndo(); S.timing = { ...S.timing, rows: [...S.timing.rows.filter((r) => (r.planet || '') !== S.pl || r.kind === 'eclipse'), ...p.rows.map((r) => ({ ...r, kind: 'transit', planet: S.pl, src: 'provided' }))] }; app.buildPanels(); return { times: p.rows.length }; },
    simulate(o = {}) {
      idle('simulating data');
      const s = { ...S.synth }, v = app.cur(S.values);
      if (o.noise_ppm !== undefined) s.noisePpm = positive(o.noise_ppm, 'noise_ppm');
      if (o.cadence_min !== undefined) s.exptimeMin = positive(o.cadence_min, 'cadence_min');
      const t14 = (orbitDerived(v).t14 || 0.08) * 24;
      if (o.span !== undefined) { const sp = positive(o.span, 'span'); if (sp <= t14) throw new Error(`span is the length of each observation: ${sp} h is not longer than the transit (${t14.toFixed(2)} h), which would leave no baseline`); s.baselineHr = (sp - t14) / 2; }
      else if (o.baseline_hr !== undefined) { s.baselineHr = finite(o.baseline_hr, 'baseline_hr'); if (s.baselineHr < 0) throw new Error('baseline_hr cannot be negative'); }
      if (o.seed !== undefined) s.seed = Math.round(positive(o.seed, 'seed'));
      if (o.epochs !== undefined) { s.nEpochs = Math.round(positive(o.epochs, 'epochs')); if (s.nEpochs > 200) throw new Error('at most 200 transits can be simulated'); }
      if (o.epoch_step !== undefined) s.epochStep = Math.round(positive(o.epoch_step, 'epoch_step'));
      if (o.airmass !== undefined) s.airmass = !!o.airmass;
      app.pushUndo(); S.synth = s; app.makeSynthetic(true); S.t = app.cur(S.values).tmid; app.buildPanels(); app.refresh(true);
      return { points: S.data.t.length, epochs: app.nEpochs(), cadence_min: s.exptimeMin, noise_ppm: s.noisePpm, span_hr: t14 + 2 * (s.baselineHr ?? 1) };
    },
    editData(o = {}) {
      idle('editing the data');
      const has = (k) => o[k] !== undefined && o[k] !== null;
      if (!['remove_epoch', 'trim', 'clip_sigma', 'bin_min'].some(has)) throw new Error('give at least one edit: remove_epoch, trim: [t0, t1], clip_sigma or bin_min');
      const model = app.model(), n0 = S.data.t.length, steps = [];
      // residuals of the current model travel with the points through the edits that come before the clip
      let d = S.data, resid = null;
      if (has('clip_sigma')) {
        if (!model || !model.valid) throw new Error('clipping needs a valid model to measure the residuals from: make sure the planet transits and the limb darkening profile is physical');
        resid = Float64Array.from(d.t, (_, i) => d.f[i] / model.base[i] - model.tr[i]);
      }
      const keep = (test, what) => { const before = d.t.length, idx = []; for (let i = 0; i < before; i++) if (test(i)) idx.push(i); const src = d; d = keepPoints(src, test); if (resid) resid = Float64Array.from(idx, (i) => resid[i]); steps.push(`${what}: ${before - d.t.length} point${before - d.t.length === 1 ? '' : 's'} removed`); };
      if (has('remove_epoch')) {
        if (!d.epoch) throw new Error('the light curve is a single epoch: there is none to remove');
        const k = Math.round(finite(o.remove_epoch, 'remove_epoch')) - 1;
        if (!(k >= 0 && k < d.segments.length)) throw new Error(`there is no epoch ${o.remove_epoch}; the epochs are numbered 1 to ${d.segments.length}`);
        const src = d; keep((i) => src.epoch[i] !== k, `epoch ${k + 1} (${src.segments[k].name}) removed`);
      }
      if (has('trim')) {
        if (!Array.isArray(o.trim) || o.trim.length !== 2) throw new Error('trim is [t0, t1]: the two times to keep the data between');
        const a = rel(finite(o.trim[0], 'trim start')), b = rel(finite(o.trim[1], 'trim end'));
        if (!(b > a)) throw new Error('trim is [t0, t1] with t0 earlier than t1');
        const src = d; keep((i) => src.t[i] >= a && src.t[i] <= b, `trimmed to ${a.toFixed(4)} … ${b.toFixed(4)}`);
      }
      if (has('clip_sigma')) {
        const c = clipData(d, resid, positive(o.clip_sigma, 'clip_sigma')); d = c.data;
        steps.push(`clipped at ${o.clip_sigma}σ (robust scatter ${c.scatter.map((x) => (x * 1e6).toFixed(0)).join(', ')} ppm): ${c.removed} point${c.removed === 1 ? '' : 's'} removed`);
      }
      let exptimeMin;
      if (has('bin_min')) {
        const w = positive(o.bin_min, 'bin_min'), before = d.t.length; d = binData(d, w / 1440);
        steps.push(`binned to ${w} min: ${before} points became ${d.t.length}`); exptimeMin = Math.max(S.exptimeMin || 0, w);
      }
      if (d.t.length < 5) throw new Error(`these edits would leave ${d.t.length} point${d.t.length === 1 ? '' : 's'}: too few to fit`);
      d = { ...d, notes: [...(d.notes || []), ...steps] };
      if (d.epoch) d.name = /· \d+ epochs$/.test(d.name || '') ? `${S.name} · ${d.segments.length} epochs` : d.name;
      app.installData(d, exptimeMin);
      return { points: d.t.length, removed: n0 - d.t.length, epochs: app.nEpochs(), steps };
    },

    // ---- views -------------------------------------------------------------------------------------------------
    setView(o = {}) {
      if (o.view !== undefined) {
        if (!['lc', 'rv', 'phase', 'map', 'moon'].includes(o.view)) throw new Error(`“${o.view}” is not a plot view; choose lc, rv, phase, map or moon`);
        if (o.view === 'rv' && !S.rv.length) throw new Error('no radial velocities are loaded');
        if ((o.view === 'phase' || o.view === 'map') && !app.hasPhase()) throw new Error('the planet’s own light is not in the model: add it with setPhase({ mode: "harmonic" })');
        if (o.view === 'moon' && !app.hasMoon()) throw new Error('the planet on show has no moon in the model: add one with setMoon(true)');
      }
      app.pushUndo(); if (o.view) S.view = o.view; if (o.fold !== undefined) S.fold = !!o.fold; if (o.allPlanets !== undefined) S.allPlanets = !!o.allPlanets; app.refresh(true);
    },
    showTab(name) { if (!['system', 'data', 'fit', 'results', 'timing'].includes(name)) throw new Error(`“${name}” is not a tab; the tabs are system, data, fit, results, timing`); app.showTab(name); },
    figure(view, o = {}) { if (!VIEWS.includes(view)) throw new Error(`“${view}” is not a figure; choose one of ${VIEWS.join(', ')}`); if (o.theme !== undefined && o.theme !== 'light' && o.theme !== 'dark') throw new Error('theme is "light" or "dark"'); return app.figure(view, o); },

    // ---- optional models ---------------------------------------------------------------------------------------
    setPhase(o) {
      idle('changing the model');
      if (o === null || o === false) { if (app.hasPhase()) app.removePhase(); return null; }
      const mode = o && o.mode !== undefined ? o.mode : app.hasPhase() ? app.phaseSpec().mode : 'harmonic';
      if (mode !== 'harmonic' && mode !== 'map') throw new Error('mode is "harmonic" (a sinusoidal phase curve) or "map" (spherical harmonics on the planet)');
      const lmax = mode === 'map' ? Math.round(o && o.lmax !== undefined ? finite(o.lmax, 'lmax') : app.phaseSpec().lmax || 1) : 1;
      if (mode === 'map' && !(lmax >= 1 && lmax <= 3)) throw new Error('lmax, the degree of the map, is 1, 2 or 3');
      once(() => { if (!app.hasPhase()) app.addPhase(); const ph = app.phaseSpec(); if (ph.mode !== mode || (mode === 'map' && ph.lmax !== lmax)) app.setPhaseMode(mode, lmax); });
      return { mode: app.phaseSpec().mode, lmax: app.phaseSpec().lmax };
    },
    setMoon(on) {
      idle('changing the model');
      if (on === false || on === null) { if (app.hasMoon()) app.removeMoon(); return null; }
      const vals = {};
      if (on && typeof on === 'object') for (const [f, v] of Object.entries(on)) { if (!MOON_FIELDS.includes(f)) throw new Error(`“${f}” is not a moon parameter; use ${MOON_FIELDS.join(', ')}`); vals[f] = finite(v, f); }
      if (vals.rmoon !== undefined && !(vals.rmoon >= 0)) throw new Error('rmoon, the moon’s radius over the star’s, cannot be negative');
      if (vals.permoon !== undefined && !(vals.permoon > 0)) throw new Error('permoon, the moon’s period in days, must be greater than zero');
      once(() => { if (!app.hasMoon()) app.addMoon(); if (Object.keys(vals).length) { app.pushUndo(); app.setMoonValues(vals); app.buildPanels(); app.refresh(); } });
      return moonValues();
    },
    setNbody(o) {
      idle('changing the model');
      if (o === null || o === false) { app.pushUndo(); app.setNbody(null); return null; }
      const pls = app.dyn().planets(), st = app.dyn().star();
      if (pls.length < 2) throw new Error('with one planet there is nothing to pull on it: add a second planet first (addPlanet), or search the timing list for a companion (companionSearch)');
      const noMass = pls.filter((p) => !(p.mplanet > 0)).map((p) => p.letter);
      if (noMass.length) throw new Error(`planet${noMass.length > 1 ? 's' : ''} ${noMass.join(', ')} need${noMass.length > 1 ? '' : 's'} a mass before the system can be integrated: setValue("mplanet${noMass[0] === S.planets[0].letter ? '' : '@' + noMass[0]}", …)`);
      if (!(st.mstar > 0)) throw new Error('the star needs a mass before the system can be integrated: setValue("mstar", …)');
      const nb = { ...(S.nbody || {}), ...(o && typeof o === 'object' ? o : {}) };
      nb.epoch = nb.epoch !== undefined ? rel(finite(nb.epoch, 'epoch')) : dynamicsEpoch(S, pls);
      app.pushUndo(); app.setNbody(nb);
      return { ...S.nbody };
    },
    async companionSearch(o = {}) {
      idle('searching');
      const r = await searchCompanion(app.dyn(), o);
      app.buildPanels();
      if (!r.cell) throw new Error('no companion on the grid could be simulated against these times (every cell was unstable or lost the transits)');
      const chi2 = r.refined ? r.refined.chi2 : r.grid.best.chi2, P = app.cur(S.values).per;
      return { ...r.cell, chi2, chi2_no_companion: r.chi2Linear, delta_chi2: r.chi2Linear - chi2, n_times: r.ndata, significant: r.chi2Linear - chi2 >= 12, period_ratio: (r.refined ? r.refined.periodMean : r.grid.best.period) / P, refined: !!r.refined, simulations: r.grid.nSim, seconds: r.grid.seconds };
    },
    addCompanion(cell) {
      idle('changing the model');
      if (!cell || typeof cell !== 'object') throw new Error('give the object companionSearch() returned');
      for (const k of ['mass', 'period', 'tmid', 'epoch']) finite(cell[k], k);
      if (!(cell.mass > 0) || !(cell.period > 0)) throw new Error('the companion needs a mass and a period greater than zero');
      if (!cell.host || !Number.isFinite(cell.host.per) || !Number.isFinite(cell.host.tmid)) throw new Error('host: { per, tmid } is missing: the period and mid-transit time of the transiting planet at the reference epoch');
      const n = S.planets.length;
      app.addCompanion({ ...cell, inc: Number.isFinite(cell.inc) ? cell.inc : app.cur(S.values).inc });
      if (S.planets.length === n) throw new Error('no letter is left for another planet');
      return S.planets[S.planets.length - 1].letter;
    },

    // ---- fitting -----------------------------------------------------------------------------------------------
    async run() {
      if (S.running) throw new Error('a fit is already running');
      S.fit = null; app.startFit();
      if (!S.running) throw new Error(app.status() || 'the fit did not start');
      while (S.running) await wait(200);
      if (!S.fit) throw new Error(app.status() || 'the fit failed');
      return api.results();
    },
    stop() { if (S.running) app.stopFit(); },
    progress: () => app.progress(),
    results() { if (!S.fit) return null; const r = app.exportSession(true).result; delete r.samples; return r; },
    derived() {
      if (S.fit) { let section = ''; const out = []; for (const x of app.systemRows()) { if (x.section) { section = x.section; continue; } out.push({ section, label: x.label, value: x.s.med, minus: x.s.minus ?? null, plus: x.s.plus ?? null, unit: x.unit || '', kind: x.kind }); } return out; }
      // no posterior yet: what follows from the values on the sliders
      const st = app.starNow(), out = [], many = S.planets.length > 1, row = (section, label, value, unit) => { if (Number.isFinite(value)) out.push({ section, label, value, minus: null, plus: null, unit, kind: 'current values' }); };
      for (const p of S.planets) {
        const v = app.planetValues(S.values, p.sfx), d = deriveSystem(v, { ...st, mplanet: v.mplanet }), sec = many ? 'Planet ' + p.letter : 'Planet';
        row(sec, 'Radius ratio Rp/R★', v.rprs, ''); row(sec, 'Transit depth (Rp/R★)²', d.depth, ''); row(sec, 'Planet radius Rp', d.rpJup, 'R Jup'); row(sec, 'Planet mass Mp', v.mplanet, 'M Jup'); row(sec, 'RV semi-amplitude K', d.K, 'm/s');
        row(sec, 'Orbital period P', v.per, 'd'); row(sec, 'Transit midpoint T mid', v.tmid + tRef(), tRef() ? 'BJD' : 'd'); row(sec, 'Transit duration T₁₄', d.t14, 'd'); row(sec, 'Inclination i', v.inc, '°'); row(sec, 'Scaled semi-major axis a/R★', v.ars, '');
        row(sec, 'Semi-major axis a', d.aAU, 'au'); row(sec, 'Eccentricity e', v.ecc, ''); row(sec, 'Argument of periastron ω', v.omega, '°'); row(sec, 'Impact parameter b', d.b, ''); row(sec, 'Equilibrium temp. T eq', d.teq, 'K'); row(sec, 'Insolation S', d.insol, 'S⊕');
        row(sec, 'Planet density ρp', d.rhoPlanet, 'g/cm³'); row(sec, 'Stellar density ρ★ (from a/R★)', d.rhoStar, 'g/cm³');
        if (v.ecc > 0.01) { row(sec, 'Orbit-averaged insolation ⟨S⟩', d.insolAvg, 'S⊕'); row(sec, 'T eq at periastron', d.teqPeri, 'K'); row(sec, 'T eq at apastron', d.teqApo, 'K'); }
        row(sec, 'Eclipse light-travel delay', d.lttEclipse, 's'); row(sec, 'Surface gravity gp', d.gp, 'm/s²'); row(sec, 'Surface gravity log gp', d.loggp, 'cgs'); row(sec, 'Hill radius (at periastron)', d.hillRp, 'Rp');
        row(sec, 'Periastron over Roche limit', d.rocheRatio, ''); row(sec, 'Transmission metric TSM', d.tsm, ''); row(sec, 'Emission metric ESM', d.esm, '');
      }
      return out;
    },
    runs() {
      return S.runs.map((x) => ({ id: x.id, free: x.fit.free.map((f) => f.key), labels: x.name, model: x.law, n_free: x.k, logZ: x.logZ, logZerr: x.err, converged: x.converged, chi2: x.chi2, n_data: x.fit.N, bic: x.bic, information: x.H, ncalls: x.fit.res.ncalls,
        same_data: x.dataId === S.dataId, showing: S.fit === x.fit, cautions: app.runAlarms(x, null) }));
    },
    compare(idA, idB) {
      const A = runBy(idA), B = runBy(idB);
      if (A === B) throw new Error('give two different runs to compare');
      const same = A.dataId === B.dataId, dz = A.logZ - B.logZ, e = Math.hypot(A.err, B.err), both = A.converged && B.converged;
      // as in the Results tab: the reference is the run with the higher evidence, and a run that did not converge cannot be it
      const top = both ? (dz >= 0 ? A : B) : A.converged ? A : B.converged ? B : dz >= 0 ? A : B, other = top === A ? B : A;
      const reading = same ? app.readBayes(other, top).text : 'not comparable';
      let words;
      if (!same) words = `Runs #${A.id} and #${B.id} used different data or error bars, so their evidences cannot be compared.`;
      else if (!both) words = `${[A, B].filter((x) => !x.converged).map((x) => 'Run #' + x.id).join(' and ')} stopped before converging: its ln Z is a lower bound, not a measurement, so the two cannot be compared by evidence.`;
      else if (reading === 'indistinguishable') words = `Runs #${A.id} and #${B.id} are indistinguishable within the errors (Δ ln Z = ${dz.toFixed(2)} ± ${e.toFixed(2)}): the data do not choose between them, so prefer the simpler model.`;
      else words = `Run #${other.id} is ${reading} against run #${top.id} (Δ ln Z = ${(other.logZ - top.logZ).toFixed(2)} ± ${e.toFixed(2)}, odds about 1 in ${Math.exp(Math.min(50, top.logZ - other.logZ)).toPrecision(2)}).`;
      const cautions = [...app.runAlarms(A, same ? top : null).map((t) => `#${A.id} ${t}`), ...app.runAlarms(B, same ? top : null).map((t) => `#${B.id} ${t}`)];
      if (!same) cautions.unshift('The two runs were fitted to different data or error bars.');
      return { a: A.id, b: B.id, delta_lnZ: dz, delta_lnZ_err: e, comparable: same && both, preferred: same && both && reading !== 'indistinguishable' ? top.id : null, reading, words, cautions };
    },
    restoreRun(id) {
      idle('bringing a run back');
      const r = runBy(id);
      if (r.dataId !== S.dataId) throw new Error(`run #${r.id} was fitted to different data or error bars than are loaded now; undo back to that data to see it`);
      app.restoreRun(r);
      return api.results();
    },

    // ---- documents ---------------------------------------------------------------------------------------------
    exportSession: (withResult = true) => app.exportSession(withResult),
    importSession(doc, opts) { idle('loading a session'); return app.importSession(doc, opts); },
    save: (name) => app.saveCurrent(name), listSaved: () => app.listSaved(), openSaved: (id) => app.openSaved(id), deleteSaved: (id) => app.deleteSaved(id),
    undo: () => app.undo(), redo: () => app.redo(),
  };
  return api;
}
