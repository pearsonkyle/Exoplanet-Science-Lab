#!/usr/bin/env node
// MCP server for Exoplanet Science Lab. It exposes the assistant's tools (src/assistant/toolspec.js, the same
// table the in-page assistant uses) on an ESL session document held in memory, through src/core: no browser.
//
//   node mcp/server.mjs --workspace /path/to/folder            stdio (Claude Desktop, IDE agents)
//   node mcp/server.mjs --workspace /path/to/folder --http 8765  streamable HTTP on 127.0.0.1:8765/mcp
//     --allow-origin https://exoplanet.science   also let that site's pages call it (the docs' Try it panels)
//   options: --session file.json  open this session at start (a path inside the workspace)
//
// Files: every path a tool reads or writes is resolved inside the workspace folder given at start-up and
// refused when it leaves it (also through a symbolic link). Nothing else on disk is touched, and the server
// makes no network requests. All logging goes to stderr (stdout is the protocol).

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, sep, relative, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTools } from '../src/assistant/tools.js';
import { createDocApi, blankSession } from '../src/assistant/docApi.js';
import { describeText } from '../src/assistant/ops.js';
import { runAtmosphere, tablesNeeded, tablesFrom, worlds, retrieveAtmosphere, retrievalNeeds } from '../src/core/atmoapi.js';
import { loadMixKernel } from '../src/core/opacity.js';
import { parseStellar } from '../src/core/stellarspec.js';
import { fitSed } from '../src/core/sed.js';
import { matchSpectrum } from '../src/core/specmatch.js';
import { PASSBANDS } from '../src/core/passbands.js';
import { normalizeArgs, atmosphereRequest, magnitudesOf, pairArg } from './normalize.mjs';

export const SCHEMA_VERSION = '0.2.0';  // 0.2.0: arguments of the atmosphere and star tools repaired (mcp/normalize.mjs); typed schemas with ESL_MCP_SCHEMA=typed

const HERE = dirname(fileURLToPath(import.meta.url)), PUBLIC = resolve(HERE, '../public'), REPO = resolve(HERE, '..');
const log = (...a) => process.stderr.write('[esl-mcp] ' + a.join(' ') + '\n');
const MAX_FILE = 30e6;

// ---- the workspace: the only folder this server reads and writes ----------------------------------------------
/** A file store confined to `root`. Exported for the tests. */
export function workspaceFiles(root) {
  const base = realpathSync(resolve(root)), written = new Set();
  /** The absolute path of `name` inside the workspace, or an error. Checks the real location of the nearest existing ancestor, so a link cannot lead out. */
  function inside(name) {
    if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new Error('a file name is needed');
    if (isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('~')) throw new Error(`"${name}" is an absolute path: give a path relative to the workspace folder`);
    const p = resolve(base, name);
    if (p !== base && !p.startsWith(base + sep)) throw new Error(`"${name}" is outside the workspace folder`);
    let probe = p; while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== base && !real.startsWith(base + sep)) throw new Error(`"${name}" leads outside the workspace folder (through a link)`);
    return p;
  }
  function walk(dir, depth, out) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 300) return; if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1, out); } else if (e.isFile()) out.push(p);
    }
  }
  return {
    root: base, inside,
    list() {
      const out = []; walk(base, 0, out);
      return out.map((p) => { const rel = relative(base, p).split(sep).join('/'), st = statSync(p); let about = ''; if (st.size < 2e6 && /\.(csv|txt|dat|tsv|json|md|py|tex|yaml)$/i.test(rel)) { try { about = describeText(readFileSync(p, 'utf8'), rel).kind; } catch { about = ''; } } return { name: rel, size: st.size, origin: written.has(rel) ? 'written' : 'workspace', about }; });
    },
    async readText(name) {
      const p = inside(name);
      if (!existsSync(p) || !statSync(p).isFile()) { const all = this.list().map((f) => f.name); throw new Error(`there is no file "${name}" in the workspace. ${all.length ? 'Files: ' + all.slice(0, 40).join(', ') + '.' : 'The workspace is empty.'}`); }
      if (statSync(p).size > MAX_FILE) throw new Error(`${name} is larger than 30 MB`);
      const text = readFileSync(p, 'utf8');
      if (text.slice(0, 4000).includes('\0')) throw new Error(`${name} is not a text file`);
      return text;
    },
    async write(name, data) {
      const p = inside(name), rel = relative(base, p).split(sep).join('/');
      if (existsSync(p) && !written.has(rel)) throw new Error(`"${rel}" already exists in the workspace and was not written by this server: choose another name`);
      mkdirSync(dirname(p), { recursive: true });
      const buf = typeof data === 'string' ? data : Buffer.from(await data.arrayBuffer());
      writeFileSync(p, buf); written.add(rel);
      return { name: rel, size: typeof buf === 'string' ? Buffer.byteLength(buf) : buf.length };
    },
  };
}
/** Saved analyses: session files in <workspace>/saved/. */
function workspaceStore(files) {
  const dir = () => { const d = files.inside('saved'); mkdirSync(d, { recursive: true }); return d; };
  const slug = (s) => String(s || 'analysis').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'analysis';
  return {
    async save(doc, name) { const id = slug(name), p = join(dir(), id + '.json'); writeFileSync(p, JSON.stringify(doc)); return { id, name, system: doc.name, updated: new Date().toISOString(), summary: `${doc.planets.length} planet(s), ${doc.result ? 'with a result' : 'not run'}` }; },
    async list() { return readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => { const p = join(dir(), f); let d = {}; try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { /* unreadable */ } return { id: f.replace(/\.json$/, ''), name: d.title || d.name || f, system: d.name, updated: statSync(p).mtime.toISOString(), summary: d.result ? 'with a result' : 'not run' }; }); },
    async get(id) { const p = join(dir(), slug(id) + '.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
    async delete(id) { const p = join(dir(), slug(id) + '.json'); if (existsSync(p)) unlinkSync(p); },
  };
}

// The model description both atmosphere tools take, spelled out field by field (types and units) so clients and
// tool-calling models send numbers as numbers. Other keys of src/core/rtmodel.js DEFAULT_MODEL are still accepted.
const N = (description) => ({ type: 'number', description }), PAIR = (description) => ({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description });
const MODEL_SCHEMA = { type: 'object', description: 'A model description, or changes to the world\'s (merged one level deep). Every value is a number unless said otherwise.', properties: {
  planet: { type: 'object', description: 'The planet. Without a world, give all three.', properties: { mplanet: N('Mass [M Jup].'), rplanet: N('Radius at the reference pressure [R Jup].'), pRef: N('Reference pressure of that radius [bar]: 10 mbar = 0.01 (default 0.01).'), pRef_mbar: N('The reference pressure in millibar instead of pRef (10 = 10 mbar).'), pRef_bar: N('The reference pressure in bar, said explicitly: needed above 1.5 bar.') } },
  star: { type: 'object', properties: { rstar: N('Radius [R Sun].'), teff: N('Effective temperature [K].'), ars: N('a/R*, the orbit\'s semi-major axis over the stellar radius.') } },
  tp: { type: 'object', description: 'Temperature profile.', properties: { kind: { type: 'string', enum: ['isothermal', 'guillot', 'consistent', 'ms09', 'table'] }, t: N('Temperature of an isothermal profile [K].'), teq: N('Equilibrium temperature [K] (guillot, consistent).'), tint: N('Internal temperature [K] (default 100).'), kappaIR: N('Infrared opacity [m^2/kg] (guillot; default 0.001).'), gamma: N('Visible over infrared opacity (guillot; default 0.4).'), f: N('Redistribution factor (consistent).') } },
  vmr: { type: 'object', description: 'Constant volume mixing ratios, gas -> number, e.g. {"H2O": 1e-3, "CO2": 1e-5}.', additionalProperties: { type: 'number' } },
  chemistry: { type: 'object', description: 'Chemical equilibrium in place of vmr.', properties: { mh: N('Metallicity [M/H] in dex (0 = solar).'), co: N('C/O ratio.'), quench: N('Quench pressure [bar] (optional).') } },
  condensation: { type: 'object', properties: { rainout: { type: 'boolean' } } },
  cloudTop: N('Top of an opaque grey cloud deck [bar].'),
  haze: { type: 'object', description: 'A power-law haze.', properties: { factor: N('Strength.'), slope: N('Spectral slope.') } },
  cloud: { type: 'object', description: 'A particle layer.', properties: { top: N('Top [bar].'), base: N('Base [bar].'), tau: N('Vertical optical depth of the layer at 1 micron (default 1).'), radius: N('Particle radius [micron].'), material: { type: 'string', description: 'e.g. "tholin" (optional).' } } },
  bulk: { type: 'string', description: 'The gas that takes the rest, e.g. "N2" or "CO2" (default H2 and He).' } } };

// ---- the atmosphere model: a tool of this server alone (it needs the opacity tables on disk, which the page's assistant fetches differently)
const ATMOSPHERE_TOOL = {
  name: 'atmosphere_spectrum', readOnly: false,
  description: `Compute the transmission and emission spectrum of a model atmosphere (the forward model of the Atmosphere page; independent of the session). Start from a preset world (${worlds().map((w) => w.name).join('; ')}) and/or give a model or changes to it: planet {mplanet [M Jup], rplanet [R Jup], pRef [bar]}, star {rstar, teff, ars}, tp {kind: "isothermal"|"guillot"|"consistent" (temperatures from the gases; teq, tint, f)}, vmr {H2O: 1e-3, ...}, chemistry {mh, co} (chemical equilibrium), condensation {rainout: true}, cloudTop [bar], haze {factor, slope}, cloud {top, base, tau, radius, material: "tholin"}, bulk "N2"|"CO2". The spectrum is written to a CSV file in the workspace (save_as); the result describes it: range, the largest and smallest transit depth, clouds, temperatures at a few pressures, and whether a self-consistent profile settled. Report those numbers as returned.`,
  parameters: { type: 'object', properties: {
    world: { type: 'string', enum: worlds().map((w) => w.name), description: 'A preset world to start from (optional). Only these presets; any other planet goes in model.' },
    planet_name: { type: 'string', description: 'The name of the planet being modelled (a label for the result; optional).' },
    model: MODEL_SCHEMA,
    wl_min: { type: 'number', description: 'Shortest wavelength [micron] (default 0.3).' }, wl_max: { type: 'number', description: 'Longest wavelength [micron] (default 50).' },
    R: { type: 'number', description: 'Resolving power to bin the spectrum to (default 100).' },
    save_as: { type: 'string', description: 'CSV file name in the workspace (default atmosphere.csv).' } } },
};
const atmo = { tables: { lines: [], cia: [] }, kernel: undefined };
async function atmosphereSpectrum(args, files) {
  const req = { world: args.world, model: args.model, wlMin: args.wl_min, wlMax: args.wl_max, R: args.R ?? 100 }, need = tablesNeeded(req), have = new Set([...atmo.tables.lines, ...atmo.tables.cia].map((t) => t.species));
  const buf = (f) => { const b = readFileSync(resolve(PUBLIC, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const add = tablesFrom(Object.fromEntries([...need.lines, ...need.cia].filter((n) => !have.has(n)).map((n) => [n, buf(`opacity/${n}.eslo`)])), need.chem && !atmo.tables.chem ? buf('chem/equilibrium.eslc') : null);
  atmo.tables.lines.push(...add.lines); atmo.tables.cia.push(...add.cia); if (add.chem) atmo.tables.chem = add.chem;
  if (atmo.kernel === undefined) { try { atmo.kernel = await loadMixKernel(readFileSync(resolve(PUBLIC, 'wasm/mix.wasm'))); } catch { atmo.kernel = null; } }
  const r = runAtmosphere(req, atmo.tables, { kernel: atmo.kernel }), n = r.wl.length, col = (x, i) => (x ? x[i].toExponential(6) : '');
  const csv = ['wavelength_micron,lo,hi,transit_depth,eclipse_depth_fpfs,brightness_temperature_K', ...r.wl.map((w, i) => [w.toFixed(6), r.lo[i].toFixed(6), r.hi[i].toFixed(6), col(r.depth, i), col(r.fpfs, i), r.brightness ? r.brightness[i].toFixed(2) : ''].join(','))].join('\n') + '\n';
  const saved = await files.write(args.save_as || 'atmosphere.csv', csv), arg = (x, f) => x.reduce((b, v, i) => (f(v, x[b]) ? i : b), 0), at = (P) => { let j = 0; while (j < r.profile.p.length - 1 && r.profile.p[j] < P) j++; return j; };
  const hi = arg(r.depth, (a, b) => a > b), lo = arg(r.depth, (a, b) => a < b), top = r.profile.p.length - 1;
  return { written: saved, bins: n, range_micron: [+r.wl[0].toFixed(4), +r.wl[n - 1].toFixed(3)], resolving_power: req.R,
    transit_depth_ppm: { largest: { value: +(1e6 * r.depth[hi]).toFixed(2), at_micron: +r.wl[hi].toFixed(3) }, smallest: { value: +(1e6 * r.depth[lo]).toFixed(2), at_micron: +r.wl[lo].toFixed(3) } },
    temperatures_K: Object.fromEntries([1e-6, 1e-4, 1e-2, 1].filter((P) => P >= r.profile.p[0] && P <= r.profile.p[top]).map((P) => [`${P} bar`, +r.profile.t[at(P)].toFixed(1)])),
    mean_molecular_weight: +r.profile.mu[top].toFixed(3), clouds: r.clouds.map((c) => ({ condensate: c.name, base_bar: c.deep ? 'below the model' : +c.base.toPrecision(3) })),
    self_consistent_profile: r.climate ? { settled: r.climate.converged, passes: r.climate.iterations, emitted_over_absorbed: +r.climate.balance.toFixed(3) } : null,
    gases_used: need.lines, collision_induced: need.cia, note: 'A one-dimensional model; the limits are in docs/guide/validation.md, "Atmosphere".' };
}

// ---- a retrieval: the same model fitted to spectra in workspace files (src/core/retrieval.js through atmoapi.js)
const RETRIEVE_TOOL = {
  name: 'atmosphere_retrieve', readOnly: false,
  description: 'Fit a model atmosphere to measured spectra with nested sampling (an atmospheric retrieval; independent of the session). Data are CSV files in the workspace, one per spectrum, rows of numbers with header lines allowed: either "wavelength, value, error" or "wavelength, bin_low, bin_high, value, error" (wavelengths in micron); kind says what the value is: "transit" (transit depth), "eclipse" (eclipse depth Fp/Fs), "night" (the same for the night side). The model starts from a preset world and/or a model as in atmosphere_spectrum; the temperature profile must be "guillot" or "isothermal". free lists what is fitted: teq, tint, logKappaIR, logGamma (Guillot profile); t (isothermal); mh, co ([M/H] and C/O of chemical equilibrium, switched on when freed); logX_<gas> (log10 of a constant mixing ratio, e.g. logX_H2O); rplanet; logCloudTop, cloudFraction, logHaze, hazeSlope; nightDT; offset_<n> (a constant added to data set n; needs a prior). Priors are uniform, [low, high]; those not given are wide defaults, returned in the result. Takes from half a minute (four parameters, 50 points) to many minutes: each model costs 3 to 30 ms and a fit needs 2000 to 30000 models per free parameter. It stops at max_models or max_seconds; "converged": false then means the numbers are NOT a posterior: raise the budget or free fewer parameters. To compare two descriptions of the same data (with and without a gas or a cloud), run both and subtract ln Z: above 5 is strong, within 1 the data do not tell them apart. Writes the result (JSON) and the best-fit spectrum (CSV) to the workspace. Report the values exactly as returned, with their errors.',
  parameters: { type: 'object', required: ['data', 'free'], properties: {
    world: { type: 'string', enum: worlds().map((w) => w.name), description: 'A preset world to start from (optional). Only these presets; any other planet goes in model.' },
    planet_name: { type: 'string', description: 'The name of the planet being fitted (a label for the result; optional).' },
    model: { ...MODEL_SCHEMA, description: 'A model description, or changes to the world\'s (merged one level deep), as in atmosphere_spectrum.' },
    data: { type: 'array', minItems: 1, items: { type: 'object', required: ['file', 'kind'], properties: { file: { type: 'string', description: 'CSV file in the workspace.' }, kind: { type: 'string', enum: ['transit', 'eclipse', 'night'] }, unit: { type: 'string', enum: ['fraction', 'percent', 'ppm'], description: 'Unit of the value and error columns (default fraction).' } } }, description: 'The spectra to fit.' },
    free: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Parameter keys to fit.' },
    priors: { type: 'object', description: 'Key -> [low, high] (uniform, low < high), e.g. {"teq": [800, 1600]}. Optional except for offsets.', additionalProperties: PAIR('[low, high]') },
    gases: { type: 'array', items: { type: 'string' }, description: 'Gases whose opacity to include (default: the model\'s; a freed gas is always included).' },
    merge: { type: 'integer', description: 'Join this many opacity bins (1 to 8) for speed; default: chosen from the data\'s resolving power so that three model bins fall in one data bin. Larger is faster and less accurate.' },
    live_points: { type: 'integer', description: 'Live points of the sampler (default 100).' },
    max_models: { type: 'integer', description: 'Budget of forward models (default 20000).' }, max_seconds: { type: 'number', description: 'Time limit [s] (default 600).' },
    save_as: { type: 'string', description: 'Base name of the files written (default "retrieval": retrieval.json and retrieval_best.csv).' } } },
};
async function atmosphereRetrieve(args, files) {
  const scale = { fraction: 1, percent: 1e-2, ppm: 1e-6 }, data = [];
  if (!Array.isArray(args.data) || !args.data.length) throw new Error('data: give at least one { file, kind }');
  for (const d of args.data) {
    const text = await files.readText(d.file), rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && /^[-+.\d]/.test(l)).map((l) => l.split(/[,;\s]+/).filter((x) => x !== '').map(Number));
    if (!(d.unit === undefined || d.unit in scale)) throw new Error(`${d.file}: unit must be fraction, percent or ppm`);
    const ok = rows.filter((x) => (x.length === 3 || x.length >= 5) && x.slice(0, 5).every(Number.isFinite)), wide = ok.length > 0 && ok.every((x) => x.length >= 5), k = scale[d.unit || 'fraction'];
    if (ok.length < 3 || (!wide && !ok.every((x) => x.length === 3))) throw new Error(`${d.file}: needs at least 3 rows of "wavelength, value, error" or "wavelength, bin_low, bin_high, value, error" (${rows.length} rows of numbers read, ${ok.length} usable)`);
    ok.sort((x, y) => x[0] - y[0]);
    data.push({ name: d.file, kind: d.kind, wl: ok.map((x) => x[0]), ...(wide ? { lo: ok.map((x) => x[1]), hi: ok.map((x) => x[2]) } : {}), y: ok.map((x) => k * x[wide ? 3 : 1]), err: ok.map((x) => k * x[wide ? 4 : 2]) });
  }
  const req = { world: args.world, model: args.model, species: args.gases, data, free: args.free, priors: args.priors, ...(args.merge ? { merge: Math.max(1, Math.min(8, Math.round(args.merge))) } : {}), sampler: { nlive: args.live_points ?? 100, maxCalls: args.max_models ?? 20000, maxSeconds: args.max_seconds ?? 600 } };
  const need = retrievalNeeds(req), have = new Set([...atmo.tables.lines, ...atmo.tables.cia].map((t) => t.species));
  const buf = (f) => { const b = readFileSync(resolve(PUBLIC, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const wantChem = (need.chem || ['mh', 'co', 'logQuench'].some((x) => (args.free || []).includes(x))) && !atmo.tables.chem;
  const add = tablesFrom(Object.fromEntries([...need.lines, ...need.cia].filter((n) => !have.has(n)).map((n) => [n, buf(`opacity/${n}.eslo`)])), wantChem ? buf('chem/equilibrium.eslc') : null);
  atmo.tables.lines.push(...add.lines); atmo.tables.cia.push(...add.cia); if (add.chem) atmo.tables.chem = add.chem;
  if (atmo.kernel === undefined) { try { atmo.kernel = await loadMixKernel(readFileSync(resolve(PUBLIC, 'wasm/mix.wasm'))); } catch { atmo.kernel = null; } }
  const r = retrieveAtmosphere(req, atmo.tables, { kernel: atmo.kernel }), base = String(args.save_as || 'retrieval').replace(/\.(json|csv)$/i, '');
  const csv = ['data_set,kind,wavelength_micron,observed,error,best_fit_model', ...data.flatMap((d, j) => d.wl.map((w, i) => [j + 1, d.kind, w.toFixed(6), d.y[i].toExponential(6), d.err[i].toExponential(3), r.best.spectra[j][i].toExponential(6)].join(',')))].join('\n') + '\n';
  const w1 = await files.write(base + '.json', JSON.stringify({ request: { world: args.world, model: args.model, free: args.free, data: args.data }, result: r }, null, 1)), w2 = await files.write(base + '_best.csv', csv);
  const sig = (v) => +v.toPrecision(5), par = Object.fromEntries(r.keys.map((key) => { const q = r.summary[key]; return [key, { label: r.labels[r.keys.indexOf(key)], value: sig(q.median), plus: +(q.hi - q.median).toPrecision(2), minus: +(q.median - q.lo).toPrecision(2), best_fit: sig(q.best), prior: r.priors[key].type === 'uniform' ? [r.priors[key].a, r.priors[key].b] : r.priors[key], prior_given: !!(args.priors && args.priors[key]) }]; }));
  return { converged: r.converged, ...(r.converged ? {} : { warning: 'NOT converged: the budget ran out before the sampler\'s stopping rule; the values below are not a posterior. Raise max_models / max_seconds or free fewer parameters.' }),
    parameters: par, ln_Z: r.converged ? { value: +r.logZ.toFixed(2), error: +r.logZerr.toFixed(2) } : null, chi2: +r.chi2.toFixed(1), data_points: r.ndata, models_computed: r.ncalls, seconds: +r.seconds.toFixed(1), ms_per_model: +r.msPerModel.toFixed(1),
    opacity_bins_joined: r.merge, gases_used: r.gases, collision_induced: r.cia, warnings: r.warnings, written: [w1, w2],
    note: 'Values are the median with the 16 to 84% range. The spectra and their errors are taken as given; the limits of the model and of the retrieval are in docs/guide/validation.md, "Atmosphere" and "Retrieval".' };
}

// ---- the star: an SED fit and a spectrum match (src/core/sed.js, specmatch.js), on the stellar grid in public/stellar
const pm = (v, d) => ({ value: +v.median.toPrecision(d), plus: +(v.hi - v.median).toPrecision(2), minus: +(v.median - v.lo).toPrecision(2) });
const STAR_TOOLS = [{
  name: 'star_fit', readOnly: true,
  description: `Fit a star's spectral energy distribution: catalogue magnitudes in, effective temperature and angular diameter out, and with a parallax the radius and luminosity (independent of the session). Bands: ${Object.keys(PASSBANDS).join(', ')}. Use each catalogue's own system (Vega for Gaia, Tycho, Johnson, 2MASS, WISE, APASS B/V; AB for SDSS, PS1, APASS g/r/i, GALEX). Leave out saturated or blended bands. Magnitudes hardly constrain log g and [Fe/H]: give them when a spectrum has measured them. av_max bounds the extinction searched; use 0 for stars within about 70 pc. Models: PHOENIX, main-sequence stars from 2300 to 8000 K. Report the numbers with the errors returned.`,
  parameters: { type: 'object', required: ['magnitudes'], properties: {
    magnitudes: { type: 'object', description: 'Full band name (as listed above) -> [magnitude, error], e.g. {"Gaia G": [7.521, 0.003], "2MASS J": [6.591, 0.02], "2MASS Ks": [6.308, 0.026]}. At least three bands.', propertyNames: { enum: Object.keys(PASSBANDS) }, additionalProperties: PAIR('[magnitude, error]') },
    parallax: PAIR('[parallax in mas, its error], value first'), logg: PAIR('[value, sigma] (optional prior)'), feh: PAIR('[value, sigma] (optional prior)'),
    av_max: { type: 'number', description: 'Largest extinction A_V considered [mag] (default 0.1; 0 fixes it at zero).' } } },
}, {
  name: 'star_match_spectrum', readOnly: true,
  description: 'Match a low-resolution spectrum of a star (a CSV file in the workspace: wavelength in micron, flux, and optionally its error, one row per point, header lines allowed) against the PHOENIX grid: effective temperature, log g and [Fe/H], and the angular diameter when the flux is calibrated in W m^-2 micron^-1 and degree is 0. degree > 0 fits a smooth polynomial factor with the star, for spectra whose overall slope is not calibrated. The models are sampled every 5 nm: this matches spectrophotometry (Gaia XP, SpeX prism, JWST prism), not echelle spectra line by line; a finer spectrum is binned down and the result says so.',
  parameters: { type: 'object', required: ['file'], properties: { file: { type: 'string', description: 'CSV file in the workspace.' }, degree: { type: 'integer', description: 'Degree of the smooth factor (0 to 4; default 0: one scale factor).' },
    logg: { type: 'array', items: { type: 'number' }, description: '[value, sigma] (optional prior)' }, feh: { type: 'array', items: { type: 'number' }, description: '[value, sigma] (optional prior)' } } },
}];

// The argument schemas tools/list shows by default are those of 0.1.0: a fine-tuned model trained on that list did better
// with it than with the typed schemas above (ESL v2 evaluation, 2026-11-26: clean 0.675 against 0.575; the main set
// 0.899 against 0.873). ESL_MCP_SCHEMA=typed lists the typed ones (other clients; new training data). The arguments
// are repaired (mcp/normalize.mjs) the same way under both, against the typed schemas.
const SCHEMA_V1 = {
  atmosphere_spectrum: { type: 'object', properties: {
    world: { type: 'string', description: 'A preset world to start from (optional).' },
    model: { type: 'object', description: 'A model description, or changes to the world\'s (merged one level deep).' },
    wl_min: { type: 'number', description: 'Shortest wavelength [micron] (default 0.3).' }, wl_max: { type: 'number', description: 'Longest wavelength [micron] (default 50).' },
    R: { type: 'number', description: 'Resolving power to bin the spectrum to (default 100).' },
    save_as: { type: 'string', description: 'CSV file name in the workspace (default atmosphere.csv).' } } },
  atmosphere_retrieve: { type: 'object', required: ['data', 'free'], properties: {
    world: { type: 'string', description: 'A preset world to start from (optional).' },
    model: { type: 'object', description: 'A model description, or changes to the world\'s (merged one level deep), as in atmosphere_spectrum.' },
    data: { type: 'array', minItems: 1, items: { type: 'object', required: ['file', 'kind'], properties: { file: { type: 'string', description: 'CSV file in the workspace.' }, kind: { type: 'string', enum: ['transit', 'eclipse', 'night'] }, unit: { type: 'string', enum: ['fraction', 'percent', 'ppm'], description: 'Unit of the value and error columns (default fraction).' } } }, description: 'The spectra to fit.' },
    free: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Parameter keys to fit.' },
    priors: { type: 'object', description: 'Key -> [low, high] (uniform). Optional except for offsets.' },
    gases: { type: 'array', items: { type: 'string' }, description: 'Gases whose opacity to include (default: the model\'s; a freed gas is always included).' },
    merge: { type: 'integer', description: 'Join this many opacity bins (1 to 8) for speed; default: chosen from the data\'s resolving power so that three model bins fall in one data bin. Larger is faster and less accurate.' },
    live_points: { type: 'integer', description: 'Live points of the sampler (default 100).' },
    max_models: { type: 'integer', description: 'Budget of forward models (default 20000).' }, max_seconds: { type: 'number', description: 'Time limit [s] (default 600).' },
    save_as: { type: 'string', description: 'Base name of the files written (default "retrieval": retrieval.json and retrieval_best.csv).' } } },
  star_fit: { type: 'object', required: ['magnitudes'], properties: {
    magnitudes: { type: 'object', description: 'Band name -> [magnitude, error], e.g. {"Gaia G": [7.521, 0.003], "2MASS J": [6.591, 0.02]}. At least three bands.' },
    parallax: { type: 'array', items: { type: 'number' }, description: '[mas, error]' }, logg: { type: 'array', items: { type: 'number' }, description: '[value, sigma] (optional prior)' }, feh: { type: 'array', items: { type: 'number' }, description: '[value, sigma] (optional prior)' },
    av_max: { type: 'number', description: 'Largest extinction A_V considered [mag] (default 0.1; 0 fixes it at zero).' } } },
};
const LIST_V1 = process.env.ESL_MCP_SCHEMA !== 'typed';
let starGrid = null;
async function starTool(name, args, files) {
  starGrid ??= (() => { const b = readFileSync(resolve(PUBLIC, 'stellar/phoenix.esls')); return parseStellar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); })();
  const logg = pairArg('logg', args.logg, '', [], { prior: true }), feh = pairArg('feh', args.feh, 'dex', [], { prior: true });
  const priors = { ...(logg ? { logg } : {}), ...(feh ? { feh } : {}) };
  if (name === 'star_fit') {
    const obs = magnitudesOf(args.magnitudes), notes = [], plx = pairArg('parallax', args.parallax, 'mas', notes);
    const r = fitSed(starGrid, obs, { priors: { ...priors, ...(plx ? { plx } : {}), avMax: args.av_max ?? 0.1 } }), p = r.parameters;
    r.warnings.push(...notes);
    return { teff_K: pm(p.teff, 4), angular_diameter_mas: pm(p.theta_mas, 4), ...(p.rstar ? { radius_Rsun: pm(p.rstar, 4), luminosity_Lsun: pm(p.lum, 4), distance_pc: pm(p.dist_pc, 5) } : {}), bolometric_flux_W_m2: pm(p.fbol, 4), extinction_Av_mag: pm(p.av, 2), logg: pm(p.logg, 3), feh: pm(p.feh, 2), extra_scatter_mag: pm(p.scatter_mag, 2),
      bands: r.bands.map((b) => ({ band: b.band, observed: b.mag, model: +b.model.toFixed(3), residual_mag: +b.residual.toFixed(3) })), chi2: +r.chi2.toFixed(1), converged: r.converged, warnings: r.warnings.filter((x) => !/edge of its prior|not constrained by the data/.test(x)),
      note: `${args.logg ? '' : 'No prior on log g: its value is not a measurement. '}${args.feh ? '' : 'No prior on [Fe/H]: its value is not a measurement. '}${p.rstar ? '' : 'No parallax: no radius or luminosity. '}One model grid (PHOENIX-ACES); limits in docs/guide/validation.md, "SED fitting".` };
  }
  const text = await files.readText(args.file), rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && /^[-+.\d]/.test(l)).map((l) => l.split(/[,;\s]+/).map(Number)).filter((x) => x.length >= 2 && x.every(Number.isFinite));
  if (rows.length < 8) throw new Error(`${args.file}: fewer than 8 rows of numbers (wavelength in micron, flux[, error])`);
  rows.sort((a, b) => a[0] - b[0]); const hasErr = rows.every((x) => x.length >= 3 && x[2] > 0);
  const r = matchSpectrum(starGrid, { wl: rows.map((x) => x[0]), flux: rows.map((x) => x[1]), err: hasErr ? rows.map((x) => x[2]) : null }, { degree: Math.max(0, Math.min(4, args.degree ?? 0)), priors }), p = r.parameters;
  return { points_read: rows.length, points_fitted: r.n, range_micron: [+r.wl[0].toFixed(4), +r.wl[r.n - 1].toFixed(4)], errors: hasErr ? 'from the file' : 'none in the file: a fractional scatter was fitted', teff_K: pm(p.teff, 4), logg: pm(p.logg, 3), feh: pm(p.feh, 2), ...(p.theta_mas ? { angular_diameter_mas: pm(p.theta_mas, 4) } : {}), scatter_fraction: pm(p.scatter, 2), chi2: +r.chi2.toFixed(1), converged: r.converged, warnings: r.warnings };
}

const INSTRUCTIONS = `Exoplanet Science Lab: model and fit exoplanet transits, radial velocities and transit timing with nested sampling.
The server holds ONE analysis (an ESL session) in memory; every tool acts on it. Typical flow:
1. Start: lookup_planet (catalogue values and wide priors), load_example, import_session (a session file in the workspace) or new_session.
2. Data: list_files, then load_light_curve / load_radial_velocities / set_timings with a file name from the workspace. Data are never returned as arrays, only described.
3. Set up: set_free, set_prior, choose_data, set_sampler. a/R* (ars) is never fitted; with Kepler mode on it follows from M*, R*, P and the planet mass.
4. run_fit (seconds to minutes; progress notifications are sent), then get_results, get_derived, list_runs, compare_runs. run_experiment runs a queue of variants one after another (circular against eccentric, with and without a planet, or your own variants with set-up steps) and returns the comparison table with a written report.
   Optional models: set_phase_curve (the planet's own light), set_moon, set_nbody (two planets or more).
5. Timing: fit_ephemeris and timing_periodogram. Files: export_file (session JSON, Markdown report, Python script, CSV), write_file.
Keys: rprs, ars, inc, per, tmid, ecc, omega, mplanet, ld0..ld3, a2, rvlin, rvquad, jit@rv1, mstar, rstar, teff, feh; later planets carry their letter (per@c). Times are days (BJD when dated).
Report numbers exactly as returned, each with the uncertainty it came with; never convert or compute one. For model comparison relay the "reading", "verdict" and "cautions" fields rather than interpreting ln Z yourself.
Results that hold a table also carry it as a second text block (Markdown), ready to show as it is.
Apart from the session: star_fit gives a star's temperature, angular diameter and radius from catalogue magnitudes, star_match_spectrum the same from a low-resolution spectrum file; atmosphere_spectrum computes the transmission and emission spectrum of a model atmosphere (preset worlds or your own) and writes it to the workspace; atmosphere_retrieve fits such a model to measured spectra in workspace files (a retrieval: minutes; check "converged").`;

/** Build the server on a workspace folder. Returns { server, tools, api, files }. */
export function createEslServer({ workspace, session } = {}) {
  const files = workspaceFiles(workspace);
  const fetchText = async (p) => { const f = resolve(PUBLIC, p); if (!f.startsWith(PUBLIC + sep)) throw new Error('bad path'); return readFileSync(f, 'utf8'); };
  const fetchJson = async (name) => JSON.parse(await fetchText('catalog/' + name));
  const api = createDocApi({ fetchText, fetchJson, store: workspaceStore(files), session });
  // read_source: the files of this checkout (the browser reads the published copy on GitHub)
  const readSource = async (f) => { const p = resolve(REPO, f); if (!p.startsWith(REPO + sep)) throw new Error('bad path'); return readFileSync(p, 'utf8'); };
  const tools = createTools({ api, files, fetchJson, where: 'mcp', blankSession, readSource });
  const server = new Server({ name: 'exoplanet-science-lab', version: SCHEMA_VERSION + (LIST_V1 ? '' : '+typed') }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.specs, ATMOSPHERE_TOOL, RETRIEVE_TOOL, ...STAR_TOOLS].map((t) => ({ name: t.name, description: t.description, inputSchema: (LIST_V1 && SCHEMA_V1[t.name]) || t.parameters, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.confirm, openWorldHint: false, title: t.name.replace(/_/g, ' ') } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params, token = req.params._meta && req.params._meta.progressToken;
    let last = 0;
    const onProgress = token === undefined ? undefined : (p) => {
      const now = Date.now(); if (now - last < 700) return; last = now;
      const fr = (api.state().sampler.fracRemain) || 0.01, done = Math.min(0.99, Math.max(0, 1 - Math.log(Math.max(p.remFrac, fr) / fr) / Math.log(1 / fr)));
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(done * 100), total: 100, message: `${p.variant ? p.variant + ': ' : ''}iteration ${p.it}, ${p.ncalls} likelihood calls, ln Z ${Number(p.logZ).toFixed(2)}, ${(p.elapsed || 0).toFixed(0)} s` } }).catch(() => {});
    };
    const own = [...STAR_TOOLS, RETRIEVE_TOOL, ATMOSPHERE_TOOL].find((t) => t.name === name);
    const fix = async (fn) => {  // repaired arguments (mcp/normalize.mjs), then the tool; warnings and the planet's name go with the result
      let a = normalizeArgs(args || {}, own.parameters), warn = [];
      if (name !== 'star_fit' && name !== 'star_match_spectrum') ({ args: a, warnings: warn } = atmosphereRequest(a, worlds().map((w) => w.name), { name }));
      const r = await fn(a);
      return { ...(a.planet_name ? { planet_name: a.planet_name } : {}), ...r, ...(warn.length ? { warnings: [...(r.warnings || []), ...warn] } : {}) };
    };
    if (STAR_TOOLS.some((t) => t.name === name)) {
      try { return { content: [{ type: 'text', text: JSON.stringify(await fix((a) => starTool(name, a, files))) }] }; }
      catch (err) { return { content: [{ type: 'text', text: JSON.stringify({ error: String((err && err.message) || err) }) }], isError: true }; }
    }
    if (name === RETRIEVE_TOOL.name) {
      try { return { content: [{ type: 'text', text: JSON.stringify(await fix((a) => atmosphereRetrieve(a, files))) }] }; }
      catch (err) { return { content: [{ type: 'text', text: JSON.stringify({ error: String((err && err.message) || err) }) }], isError: true }; }
    }
    if (name === ATMOSPHERE_TOOL.name) {
      try { return { content: [{ type: 'text', text: JSON.stringify(await fix((a) => atmosphereSpectrum(a, files))) }] }; }
      catch (err) { return { content: [{ type: 'text', text: JSON.stringify({ error: String((err && err.message) || err) }) }], isError: true }; }
    }
    const r = await tools.call(name, args || {}, { signal: extra.signal, onProgress });
    // the result as JSON for the model, and its table (when it has one) as Markdown the client can show verbatim
    return { content: [{ type: 'text', text: r.text }, ...(r.ok && r.table ? [{ type: 'text', text: r.table }] : [])], isError: !r.ok };
  });
  return { server, tools, api, files };
}

// ---- command line ----------------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: node mcp/server.mjs --workspace <folder> [--session file.json] [--http <port> [--allow-origin <https://site>]...]\n'); return; }
  const workspace = resolve(opt('--workspace', process.env.ESL_WORKSPACE || process.cwd()));
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) { log(`workspace folder not found: ${workspace}`); process.exit(2); }
  let session; const sf = opt('--session');
  if (sf) session = JSON.parse(readFileSync(workspaceFiles(workspace).inside(sf), 'utf8'));
  const port = opt('--http');
  if (!port) {
    const { server } = createEslServer({ workspace, session });
    await server.connect(new StdioServerTransport());
    log(`ready on stdio · workspace ${workspace}`);
    return;
  }
  // Streamable HTTP, one session document per MCP session, bound to this machine only
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createServer } = await import('node:http'), { randomUUID } = await import('node:crypto');
  const sessions = new Map(), host = '127.0.0.1', allowed = new Set([`${host}:${port}`, `localhost:${port}`]);
  // Web pages may call this server only from this machine's own pages, or from an origin named with --allow-origin
  // (repeatable; e.g. the documentation site, whose "Try it" panels talk to your server). The server still listens on
  // 127.0.0.1 only and still refuses a foreign Host header, so nothing on the network can reach it.
  const extra = argv.flatMap((a, i) => (a === '--allow-origin' && argv[i + 1] ? [argv[i + 1].replace(/\/+$/, '')] : []));
  const originOk = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || extra.includes(o);
  createServer(async (req, res) => {
    try {
      if (!allowed.has(req.headers.host || '')) { res.writeHead(403).end('forbidden host'); return; }   // DNS-rebinding guard
      const origin = req.headers.origin;
      if (origin && !originOk(origin)) { res.writeHead(403).end('forbidden origin: start the server with --allow-origin ' + origin); return; }
      if (origin) {
        // CORS for the allowed page, and Chrome's local-network preflight (a public page calling 127.0.0.1)
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
        if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      }
      if (!(req.url || '').startsWith('/mcp')) { res.writeHead(404).end('use /mcp'); return; }
      const sid = req.headers['mcp-session-id'];
      let t = sid && sessions.get(sid);
      if (!t) {
        if (sid || req.method !== 'POST') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'unknown or missing session: initialize first' }, id: null })); return; }
        t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
        t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
        await createEslServer({ workspace, session }).server.connect(t);
      }
      await t.handleRequest(req, res);
    } catch (err) { log('http error', err.message); if (!res.headersSent) res.writeHead(500).end('error'); }
  }).listen(Number(port), host, () => log(`ready on http://${host}:${port}/mcp · workspace ${workspace}${extra.length ? ` · pages allowed: ${extra.join(', ')}` : ''}`));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { log(err.stack || err.message); process.exit(1); });
