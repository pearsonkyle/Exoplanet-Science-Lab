// The assistant's tools, declared once: name, a description written for a language model, JSON-schema
// parameters and a few flags. The in-page assistant (tools.js + the analyzer's window.__esl.api) and the
// MCP server (mcp/server.mjs + a session document) both take their tool list from this table, so the two
// stay in step. No DOM, no handlers here.
//
// Flags: readOnly  changes nothing (safe to call any time)
//        long      may take seconds to minutes (a fit)
//        confirm   a short sentence saying what would be lost: the harness asks the user before running it
//        where     'browser' | 'mcp' when the tool exists on one side only (default: both)
// The order is fixed on purpose: a stable tool block stays in the server's prompt cache.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const KEY = 'Parameter key: rprs, inc, per, tmid, ecc, omega, mplanet, ars (never free), ld0..ld3, a2, rvlin, rvquad, jit@rv1, mstar, rstar, teff, feh. A second planet\'s keys carry its letter: per@c.';
const SOURCE = { file: str('Name of an attached file (see list_files). Preferred: the data never enters the conversation.'), text: str('The rows themselves as text, only for a few short lines typed by the user.') };

export const TOOL_SPECS = [
  // ---- system -------------------------------------------------------------------------------------------------
  { name: 'get_state', group: 'system', readOnly: true,
    description: 'The current analysis in full: system, every parameter with its value, whether it is free and its prior, loaded data, sampler settings, whether a fit exists. The CURRENT STATE card you are given each step is the short form of this; call it only when you need a detail the card leaves out.',
    parameters: obj({}) },
  { name: 'list_examples', group: 'system', readOnly: true,
    description: 'List the worked examples that can be opened with load_example (id, title, kinds of data).',
    parameters: obj({}) },
  { name: 'load_example', group: 'system', confirm: 'Opening an example replaces the system and the data that are loaded now.',
    description: 'Open a worked example by id (ids: single, hd80606-tess, multi, hd80606-rv, hd80606-joint, toy1873). It opens with its stored posterior; pass fresh=true to open it without a result. Replaces what is loaded.',
    parameters: obj({ id: str('Example id, e.g. "single" for the single-transit example.'), fresh: bool('true: open without the stored result.') }, ['id']) },
  { name: 'search_catalog', group: 'system', readOnly: true,
    description: 'Find planet and host names in the bundled NASA Exoplanet Archive snapshot that match a partial name. Use before lookup_planet when unsure of the spelling.',
    parameters: obj({ query: str('Part of a planet or star name, e.g. "wasp-12".'), limit: int('How many names to return (default 8).', { minimum: 1, maximum: 30 }) }, ['query']) },
  { name: 'lookup_planet', group: 'system', confirm: 'Looking up a planet replaces the system parameters and clears the fit result (observations you loaded are kept).',
    description: 'Load a known planet or host from the catalogue snapshot: star, orbit and wide priors centred on the published values. Replaces the system parameters. Observations already loaded from files are kept, and T mid is moved by whole periods onto them; a simulated light curve is replaced. It does not fetch observations.',
    parameters: obj({ name: str('Planet or host name, e.g. "WASP-12 b".'), kinds: { type: 'array', items: { type: 'string', enum: ['transit', 'rv', 'ephemeris'] }, description: 'Kinds of data the analysis will use (default ["transit"]).' } }, ['name']) },
  { name: 'new_session', group: 'system', where: 'mcp',
    description: 'Start an empty analysis: one planet with placeholder values around a Sun-like star, no data. Then set the real values (set_parameters), or use lookup_planet instead to start from the catalogue. Replaces the current session.',
    parameters: obj({ name: str('Name of the system, e.g. "My target".') }, ['name']) },
  { name: 'set_parameters', group: 'system',
    description: 'Set parameter values (the starting point of a fit, and the value a fixed parameter keeps). Give several at once. tmid may be an absolute date (BJD) or days from the time reference.',
    parameters: obj({ values: { type: 'object', description: `Map of key to number, e.g. {"rprs": 0.12, "ecc": 0}. ${KEY}`, additionalProperties: { type: 'number' } } }, ['values']) },
  { name: 'add_planet', group: 'system',
    description: 'Add another planet to the system. Its keys carry its letter (per@c, rprs@c). Any existing fit result is cleared.',
    parameters: obj({ letter: str('Letter of the new planet (default: the next free one).'), parameters: { type: 'object', description: 'Its values: rprs, inc, per, tmid, ecc, omega, mplanet (and ars when Kepler mode is off). Missing ones are copied from the first planet, with twice its period.', additionalProperties: { type: 'number' } } }) },
  { name: 'remove_planet', group: 'system',
    description: 'Remove a planet (not the last one) from the system by its letter. Any existing fit result is cleared.',
    parameters: obj({ letter: str('Letter of the planet to remove.') }, ['letter']) },
  { name: 'set_kepler', group: 'system',
    description: 'Turn Kepler mode on or off. On: a/R* follows from the stellar mass and radius, the period and the planet mass (needed for radial velocities and several planets). Off: a/R* is a fixed number you set.',
    parameters: obj({ on: bool('true to derive a/R* from Kepler\'s law.') }, ['on']) },
  { name: 'set_limb_darkening', group: 'system',
    description: 'Choose the limb-darkening law and, optionally, its coefficients. Laws: uniform, linear (1 coefficient), quadratic (2), kipping (2), sqrt (2), nonlinear (Claret, 4). Coefficients are the parameters ld0..ld3 and can be freed with set_free. Any existing fit result is cleared.',
    parameters: obj({ law: str('The law.', { enum: ['uniform', 'linear', 'quadratic', 'kipping', 'sqrt', 'nonlinear'] }), coefficients: { type: 'array', items: { type: 'number' }, description: 'Coefficients in the law\'s order. Omit to keep or default them.' } }, ['law']) },

  // ---- data ---------------------------------------------------------------------------------------------------
  { name: 'describe_data', group: 'data', readOnly: true,
    description: 'What data are loaded, by handle: the light curve (points, time span, cadence, median error, epochs, airmass column), each radial-velocity set, the timing list. Numbers only, never the arrays.',
    parameters: obj({}) },
  { name: 'load_light_curve', group: 'data', confirm: 'Loading a light curve replaces the light curve that is loaded now and clears the fit.',
    description: 'Load a light curve (time, flux, error, optional airmass; CSV or whitespace columns, AAVSO and EXOTIC files, magnitudes, JD/BJD/MJD/BTJD) from an attached file. It replaces the loaded light curve, or with add_epoch=true is added as another night of the same planet. Give "planet" when the user names the target, so the system matches the data. Mid-transit time moves by whole periods onto the data.',
    parameters: obj({ ...SOURCE, planet: str('The planet the user says this file is of, copied from the user\'s own words (never from the state of the app). Its parameters are then taken from the catalogue so the system matches the data.'), name: str('Label for the data set.'), add_epoch: bool('true: keep the loaded light curve and add this one as another epoch.'), exposure_min: num('Exposure time in minutes, when known (default: the cadence).') }) },
  { name: 'load_radial_velocities', group: 'data',
    description: 'Add radial velocities (time, velocity m/s, error, optional instrument column) from an attached file. Each instrument becomes its own set with its own zero point and jitter (jit@rv1, ...). Turns velocities on in the fit and frees the planet mass.',
    parameters: obj({ ...SOURCE, name: str('Label, used when the file has no instrument column.') }) },
  { name: 'set_timings', group: 'data',
    description: 'Set the list of mid-transit times of the planet on show (rows of "time, uncertainty" or "epoch, time, uncertainty", days). They feed fit_ephemeris and timing_periodogram, and the fit when choose_data turns timing on. Replaces that planet\'s list.',
    parameters: obj({ ...SOURCE }) },
  { name: 'simulate_light_curve', group: 'data', confirm: 'Simulating replaces the light curve that is loaded now and clears the fit.',
    description: 'Replace the light curve with a simulated observation of the first planet from the current parameters: white noise, optional airmass trend, one or several transits. For teaching, planning and testing a fit set-up.',
    parameters: obj({ noise_ppm: num('Scatter per point in parts per million (default 500).'), exposure_min: num('Exposure and cadence in minutes (default 2).'), baseline_hr: num('Out-of-transit time on each side, hours (default 2).'), airmass: bool('Add an airmass trend (ground-based night).'), n_epochs: int('Number of transits (default 1).', { minimum: 1, maximum: 50 }), epoch_step: int('Orbits between simulated transits (default 1).', { minimum: 1 }), seed: int('Random seed (default 1).') }) },
  { name: 'edit_data', group: 'data', confirm: 'Removing data cannot be brought back except by undo.',
    description: 'Small changes to the loaded data: set the exposure time, remove one epoch of the light curve, remove a radial-velocity set, or clear the timing list.',
    parameters: obj({ exposure_min: num('Exposure time of the light curve in minutes.'), remove_epoch: int('Number (1-based) of the light-curve epoch to remove.', { minimum: 1 }), remove_velocities: str('Name of the radial-velocity set to remove.'), clear_timings: bool('true: empty the timing list.') }) },

  // ---- fit ----------------------------------------------------------------------------------------------------
  { name: 'choose_data', group: 'fit',
    description: 'Choose which kinds of data enter the likelihood: the light curve, the radial velocities, the timing list. Give only the ones to change.',
    parameters: obj({ light_curve: bool('Use the light curve.'), radial_velocity: bool('Use the radial velocities.'), timing: bool('Use the mid-transit times.') }) },
  { name: 'set_free', group: 'fit',
    description: 'Choose which parameters the fit samples. Keys in "free" become free (with a default prior if they had none); keys in "fixed" are held at their current value. Others are left as they are. ars (a/R*) can never be free.',
    parameters: obj({ free: { type: 'array', items: { type: 'string' }, description: `Keys to free, e.g. ["ecc", "omega"]. ${KEY}` }, fixed: { type: 'array', items: { type: 'string' }, description: 'Keys to hold fixed.' } }) },
  { name: 'set_prior', group: 'fit',
    description: 'Set the prior of one parameter. uniform: a = minimum, b = maximum. normal: a = mean, b = standard deviation. For tmid, a (and b when uniform) may be absolute dates. Changing a prior changes the evidence: compare only runs with the same priors on shared parameters.',
    parameters: obj({ key: str(KEY), type: str('Prior family.', { enum: ['uniform', 'normal'] }), a: num('uniform: minimum. normal: mean.'), b: num('uniform: maximum. normal: standard deviation.') }, ['key', 'type', 'a', 'b']) },
  { name: 'set_sampler', group: 'fit',
    description: 'Nested-sampling budget. nlive: live points (default 400; 100 to 200 for a quick look, more for a final run). max_calls: stop after this many likelihood calls. max_seconds: wall-clock limit. A run that stops on a budget is not converged and its evidence is only a lower bound.',
    parameters: obj({ nlive: int('Live points.', { minimum: 30, maximum: 4000 }), frac_remain: num('Stop when this fraction of the evidence remains (default 0.01).'), max_calls: int('Budget of likelihood calls.'), max_seconds: num('Wall-clock budget in seconds.'), seed: int('Random seed.') }) },
  { name: 'run_fit', group: 'fit', long: true,
    description: 'Run nested sampling with the current free parameters, priors and data, wait for it to finish, and return the result: evidence ln Z, convergence, each free parameter as median +/- interval, key derived quantities, warnings. Takes seconds to minutes. At least one parameter must be free.',
    parameters: obj({ label: str('Short name for this run in the comparison table, e.g. "circular".') }) },
  { name: 'stop_fit', group: 'fit',
    description: 'Stop a fit that is running. The partial posterior is kept but is not converged.',
    parameters: obj({}) },

  // ---- results ------------------------------------------------------------------------------------------------
  { name: 'get_results', group: 'results', readOnly: true,
    description: 'The current fit result: evidence, convergence, chi-squared, fitted parameters (median, +, -), warnings; with derived=true also every derived quantity (impact parameter b, duration t14, planet radius, K, a/R*, density, equilibrium temperature). Quote these numbers; never compute your own.',
    parameters: obj({ derived: bool('Include all derived quantities.'), keys: { type: 'array', items: { type: 'string' }, description: 'Only these parameter or derived keys.' } }) },
  { name: 'explain_results', group: 'results', readOnly: true,
    description: 'The current fit explained in plain words by the software: what each main number means (radius ratio, depth in percent, planet radius, inclination and impact parameter, duration in hours, eccentricity, fit quality, evidence), with unit conversions already done, plus the warnings. Use this when the user asks what the results mean, and relay its sentences.',
    parameters: obj({}) },
  { name: 'compare_runs', group: 'results', readOnly: true,
    description: 'Compare the runs made on the current data: ln Z of each, its difference from the best run, and the reading in words (indistinguishable, weakly / moderately / strongly disfavoured) with the cautions that apply. Report the reading and cautions as returned; do not reinterpret the numbers.',
    parameters: obj({}) },
  { name: 'run_experiment', group: 'results', long: true,
    description: 'Run a small set of fits one after another on the current data and compare them: "eccentricity" (circular orbit against free e and omega), "limb_darkening" (coefficients fixed against free), "airmass" (with and without the airmass slope), or "custom" with your own variants. Waits for every run, then returns the comparison table, the reading and cautions, and writes a Markdown report file for the user. Use this instead of calling run_fit several times.',
    parameters: obj({ kind: str('Which experiment.', { enum: ['eccentricity', 'limb_darkening', 'airmass', 'custom'] }),
      variants: { type: 'array', description: 'For kind "custom": the models to compare, each applied on top of the current set-up.', items: obj({ name: str('Short name, e.g. "free period".'), free: { type: 'array', items: { type: 'string' }, description: 'Keys to free.' }, fixed: { type: 'object', description: 'Keys to hold fixed, with the value to hold each at, e.g. {"ecc": 0}.', additionalProperties: { type: 'number' } } }, ['name']) },
      report: str('File name of the report (default "experiment_report.md").') }, ['kind']) },

  // ---- timing -------------------------------------------------------------------------------------------------
  { name: 'fit_ephemeris', group: 'timing', readOnly: true,
    description: 'Fit a linear and a quadratic ephemeris to the mid-transit times of a planet: T0, period with uncertainties, chi-squared, BIC of each, the period change dP/dt, and the next predicted transits. Needs at least 2 times (4 for the quadratic).',
    parameters: obj({ planet: str('Planet letter (default: the first).'), upcoming: int('How many future transits to predict (default 3).', { minimum: 0, maximum: 20 }) }) },
  { name: 'timing_periodogram', group: 'timing', readOnly: true,
    description: 'Search the timing residuals (O - C) for a periodic variation: highest periodogram peaks with false-alarm probabilities, the comparison of linear and sinusoidal models, and a verdict in words with its caveats. Needs at least 6 times. Report the verdict as returned.',
    parameters: obj({ planet: str('Planet letter (default: the first).'), bootstrap: int('Bootstrap resamplings for the false-alarm level (0 = analytic only, default 0).', { minimum: 0, maximum: 2000 }) }) },
  { name: 'compute_model', group: 'timing', readOnly: true,
    description: 'Evaluate the model at the current parameter values: transit depth, duration, impact parameter, chi-squared against the loaded data and the scatter of the residuals. With file set, also writes the model curve (time, model flux, data, residual) as CSV for the user.',
    parameters: obj({ file: str('File name for the curve, e.g. "model.csv". Omit for the summary only.') }) },

  // ---- views and exports --------------------------------------------------------------------------------------
  { name: 'set_view', group: 'view', where: 'browser',
    description: 'Change what the page shows: the side tab (system, data, fit, results, timing), the plot (light curve or radial velocities), folding on the period, all planets together, or which planet is on show.',
    parameters: obj({ tab: str('Side tab to open.', { enum: ['system', 'data', 'fit', 'results', 'timing'] }), plot: str('Lower plot.', { enum: ['lc', 'rv'] }), fold: bool('Fold the plot on the period.'), all_planets: bool('Show every planet\'s model.'), planet: str('Letter of the planet to show.') }) },
  { name: 'export_file', group: 'export',
    description: 'Write one or several result files and give them to the user: session (the whole analysis as JSON, reloadable), report (Markdown: system, data, priors, results), python (a script that reproduces the fit), latex (tables), results_csv (fitted and derived values), samples_csv (posterior draws), light_curve_csv, velocities_csv, timing_csv.',
    parameters: obj({ kinds: { type: 'array', description: 'Every file to write in this call, e.g. ["report", "session"].', items: { type: 'string', enum: ['session', 'report', 'python', 'latex', 'results_csv', 'samples_csv', 'light_curve_csv', 'velocities_csv', 'timing_csv'] } }, name: str('File name, only when a single file is written (a sensible default is used when omitted).') }, ['kinds']) },
  { name: 'get_figure', group: 'export', where: 'browser',
    description: 'Save a figure of the page as a PNG for the user: light_curve, corner (posterior), oc (timing O - C), periodogram, limb_darkening. The figure must be on screen: open its tab first (corner needs a fit result).',
    parameters: obj({ which: str('Which figure.', { enum: ['light_curve', 'corner', 'oc', 'periodogram', 'limb_darkening'] }), name: str('File name (default: <which>.png).') }, ['which']) },
  { name: 'import_session', group: 'export', confirm: 'Opening a session file replaces everything that is loaded now.',
    description: 'Open an ESL session file (JSON written by export_file kind "session" or by the analyzer\'s Save) from the attached files. Replaces everything loaded, and restores the stored result if the file has one.',
    parameters: obj({ file: str('Name of the attached session file.') }, ['file']) },

  // ---- local saves --------------------------------------------------------------------------------------------
  { name: 'save_analysis', group: 'saves',
    description: 'Save the current analysis (system, data, set-up, result) under a name so it can be reopened later with open_saved.',
    parameters: obj({ name: str('Name of the saved analysis.') }, ['name']) },
  { name: 'list_saved', group: 'saves', readOnly: true,
    description: 'List the saved analyses (id, name, date).',
    parameters: obj({}) },
  { name: 'open_saved', group: 'saves', confirm: 'Opening a saved analysis replaces everything that is loaded now.',
    description: 'Reopen a saved analysis by its id from list_saved. Replaces what is loaded.',
    parameters: obj({ id: { description: 'Id from list_saved.', type: ['string', 'number'] } }, ['id']) },
  { name: 'delete_saved', group: 'saves', confirm: 'Deleting a saved analysis is permanent.',
    description: 'Delete a saved analysis by its id. Permanent.',
    parameters: obj({ id: { description: 'Id from list_saved.', type: ['string', 'number'] } }, ['id']) },
  { name: 'undo', group: 'saves',
    description: 'Undo the last change to the analysis (or redo with redo=true).',
    parameters: obj({ redo: bool('true: redo instead.') }) },

  // ---- files --------------------------------------------------------------------------------------------------
  { name: 'list_files', group: 'files', readOnly: true,
    description: 'List the files available to this conversation: those the user attached and those you wrote (name, size, a one-line guess of what each holds).',
    parameters: obj({}) },
  { name: 'read_file', group: 'files', readOnly: true,
    description: 'Look inside a file as text. Small files come back whole; large ones as a summary (lines, columns, numeric range of each column) plus the first lines. To use a data file, do not copy its rows: pass its name to load_light_curve, load_radial_velocities or set_timings.',
    parameters: obj({ name: str('File name from list_files.'), max_chars: int('Most characters of content to return (default 2000).', { minimum: 200, maximum: 20000 }), offset: int('Start at this character (to read on).', { minimum: 0 }) }, ['name']) },
  { name: 'write_file', group: 'files',
    description: 'Write a text file (CSV, JSON, Markdown, a Python script) and give it to the user as a download. For standard outputs prefer export_file, which writes them from the analysis itself.',
    parameters: obj({ name: str('File name with extension, e.g. "notes.md".'), content: str('The whole text of the file.') }, ['name', 'content']) },
];

export const TOOL_BY_NAME = Object.fromEntries(TOOL_SPECS.map((t) => [t.name, t]));
export const toolsFor = (where) => TOOL_SPECS.filter((t) => !t.where || t.where === where);

/** The OpenAI "tools" array for a list of specs. */
export const openAITools = (specs) => specs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

// ---- checking a call against its schema ------------------------------------------------------------------------
// Small models misspell and invent arguments. A refusal names every problem and what the tool does take, so the
// next attempt can be right (the wording follows what worked in the owner's other harness).

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v, type) => { const t = typeOf(v); return [].concat(type).some((x) => x === t || (x === 'number' && t === 'integer')); };
function near(word, options) {
  const w = String(word).toLowerCase().replace(/[^a-z0-9]/g, '');
  return options.find((o) => { const x = o.toLowerCase().replace(/[^a-z0-9]/g, ''); return x === w || x.startsWith(w) || w.startsWith(x) || x.includes(w) || w.includes(x); });
}
/** Coerce the easy mistakes in place ("0.1" for a number, "true" for a boolean, a single string for a list) and list the rest. */
function checkValue(v, schema, path, errors, set) {
  if (!schema || !schema.type) return;
  if (!fits(v, schema.type)) {
    const want = [].concat(schema.type);
    if (typeof v === 'string' && (want.includes('number') || want.includes('integer')) && v.trim() !== '' && Number.isFinite(Number(v))) { v = Number(v); set(v); }
    else if (typeof v === 'string' && want.includes('boolean') && /^(true|false)$/i.test(v)) { v = /^true$/i.test(v); set(v); }
    else if (want.includes('array') && typeof v === 'string') { v = [v]; set(v); }
    else if (want.includes('integer') && typeof v === 'number' && Number.isFinite(v)) { v = Math.round(v); set(v); }
    else if (want.includes('string') && typeof v === 'number') { v = String(v); set(v); }
    else { errors.push(`${path} should be ${want.join(' or ')}, not ${typeOf(v)}`); return; }
  }
  if (schema.enum && !schema.enum.includes(v)) { const n = typeof v === 'string' && near(v, schema.enum); if (n) set(n); else errors.push(`${path} must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(v)})`); return; }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) errors.push(`${path} must be a finite number`);
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => checkValue(x, schema.items, `${path}[${i}]`, errors, (y) => (v[i] = y)));
  if (typeOf(v) === 'object' && schema.properties) checkObject(v, schema, path, errors);
  else if (typeOf(v) === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object') for (const k of Object.keys(v)) checkValue(v[k], schema.additionalProperties, `${path}.${k}`, errors, (y) => (v[k] = y));
}
function checkObject(args, schema, path, errors) {
  const props = schema.properties || {}, names = Object.keys(props);
  for (const k of Object.keys(args)) {
    if (k in props) continue;
    if (schema.additionalProperties !== false) continue;
    const n = near(k, names.filter((x) => !(x in args)));
    if (n) { args[n] = args[k]; delete args[k]; continue; }
    errors.push(`${path}.${k} is not a known argument`);
  }
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === null) errors.push(`${path}.${k} is required`);
  for (const k of Object.keys(args)) if (k in props) { if (args[k] === null) { delete args[k]; continue; } checkValue(args[k], props[k], `${path}.${k}`, errors, (y) => (args[k] = y)); }
}
/**
 * Check (and gently repair) the arguments of a call. Returns { args, error }: error is null when the call can
 * run, otherwise one sentence listing every problem and the arguments the tool takes.
 */
export function checkArgs(spec, input) {
  let args = input;
  if (typeof args === 'string') { try { args = args.trim() ? JSON.parse(args) : {}; } catch { return { args: {}, error: `the arguments of ${spec.name} were not valid JSON. ${takes(spec)}` }; } }
  if (args === undefined || args === null) args = {};
  if (typeOf(args) !== 'object') return { args: {}, error: `the arguments of ${spec.name} must be a JSON object. ${takes(spec)}` };
  args = JSON.parse(JSON.stringify(args));
  const errors = [];
  checkObject(args, spec.parameters, 'args', errors);
  return { args, error: errors.length ? `${errors.join('; ')}. ${takes(spec)} Send the call again, corrected.` : null };
}
const takes = (spec) => { const p = Object.keys(spec.parameters.properties || {}), r = spec.parameters.required || []; return p.length ? `${spec.name} takes ${p.map((k) => (r.includes(k) ? k + ' (required)' : k)).join(', ')}.` : `${spec.name} takes no arguments.`; };

/** Problems with the table itself (used by the tests): returns a list of sentences, empty when it is well formed. */
export function lintSpecs(specs = TOOL_SPECS) {
  const out = [], seen = new Set();
  const walk = (s, where) => {
    if (!s || typeof s !== 'object') { out.push(`${where}: schema is not an object`); return; }
    if (!s.type && !s.enum) out.push(`${where}: no type`);
    if (s.type === 'object') { if (s.properties) for (const [k, v] of Object.entries(s.properties)) { walk(v, `${where}.${k}`); if (!v.description && v.type !== 'object') out.push(`${where}.${k}: no description`); } for (const r of s.required || []) if (!s.properties || !(r in s.properties)) out.push(`${where}: required "${r}" is not a property`); if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${where}.*`); }
    if (s.type === 'array') { if (!s.items) out.push(`${where}: array without items`); else walk(s.items, `${where}[]`); }
  };
  for (const t of specs) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) out.push(`${t.name}: bad name`);
    if (seen.has(t.name)) out.push(`${t.name}: declared twice`); seen.add(t.name);
    if (!t.description || t.description.length < 30) out.push(`${t.name}: description too short`);
    if (t.description && t.description.length > 700) out.push(`${t.name}: description over 700 characters`);
    if (!t.parameters || t.parameters.type !== 'object') out.push(`${t.name}: parameters must be an object schema`); else walk(t.parameters, t.name);
    if (t.where && !['browser', 'mcp'].includes(t.where)) out.push(`${t.name}: where must be browser or mcp`);
    if (t.confirm && t.readOnly) out.push(`${t.name}: a read-only tool cannot need confirmation`);
  }
  return out;
}
