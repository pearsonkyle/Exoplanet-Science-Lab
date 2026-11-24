// The atmosphere model behind one plain-JSON call, for hosts that are not the Atmosphere page: the Python package
// (src/core/pyentry.js), the MCP server (mcp/server.mjs), scripts. A request names a world of src/core/worlds.js
// and/or gives a model (or changes to the world's), the host supplies the opacity tables it was told are needed, and
// the answer is spectra and profiles as plain arrays.
import { DEFAULT_MODEL, dayNightModel } from './rtmodel.js';
import { withConsistentProfile } from './climate.js';
import { prepareTables, binSpectrum, parseTable } from './opacity.js';
import { parseChem } from './chemistry.js';
import { WORLDS } from './worlds.js';
import { runRetrieval, defaultPrior } from './retrieval.js';

const LINES = ['H2O', 'CO2', 'CO', 'CH4', 'NH3', 'HCN', 'SO2', 'H2S', 'Na', 'K', 'TiO', 'VO'], CIA = ['H2-H2', 'H2-He', 'N2-N2', 'N2-CH4', 'N2-H2'];
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? { ...a[k], ...v } : v; return o; };

/** The model a request stands for: { world: name of WORLDS (optional), model: a model or changes to the world's (merged one level deep) }. */
export function modelOf(request = {}) {
  const w = request.world ? WORLDS[request.world] : null;
  if (request.world && !w) throw new Error(`no world "${request.world}" (worlds: ${Object.keys(WORLDS).join(', ')})`);
  return merge(w ? w.model : DEFAULT_MODEL, request.model);
}

/**
 * What a request needs loaded: { lines: [species], cia: [pairs], chem: bool }. With chemical equilibrium the gases are
 * those of `request.species` (default: the world's list, or H2O, CO2, CO, CH4, Na, K).
 */
export function tablesNeeded(request = {}) {
  const m = modelOf(request), w = request.world ? WORLDS[request.world] : null, off = m.opacityOff || [];
  const lines = (request.species || (m.chemistry ? (w ? w.tables.filter((t) => LINES.includes(t)) : ['H2O', 'CO2', 'CO', 'CH4', 'Na', 'K']) : Object.keys(m.vmr || {}))).filter((s) => LINES.includes(s) && !off.includes(s));
  const has = (g) => (g === 'H2' || g === 'He' ? !m.bulk || m.bulk === 'H2He' || (m.vmr && g in m.vmr) : m.bulk === g || (m.vmr && g in m.vmr) || (!!m.chemistry && g === 'CH4'));
  return { lines, cia: CIA.filter((p) => p.split('-').every(has)), chem: !!m.chemistry };
}

/** Tables from file contents: { name: ArrayBuffer } of .eslo files, and optionally the chemistry table's buffer. */
export function tablesFrom(buffers, chem = null) {
  const all = Object.values(buffers).map((b) => parseTable(b));
  return { lines: all.filter((t) => t.kind !== 'cia'), cia: all.filter((t) => t.kind === 'cia'), ...(chem ? { chem: parseChem(chem) } : {}) };
}

/**
 * Run a request.
 *   { world, model, species, wlMin, wlMax [micron] (cut the tables to this range first), merge (join this many bins),
 *     R (bin the answer to this resolving power), emission (true), transmission (true) }
 *   tables: { lines, cia, chem } holding at least tablesNeeded(request); opts: { kernel, cache }
 * Returns { wl, lo, hi [micron], depth, fpfs, flux [W m^-2 micron^-1], brightness [K],
 *           profile: { p [bar], t [K], mu, z [km above the bottom level], gases: { name: [vmr per layer] } },
 *           clouds: [{ name, label, base [bar], deep }], climate: { iterations, converged, balance, scale, ... } | null,
 *           model: the model as run }.
 */
export function runAtmosphere(request, tables, { kernel = null, cache = null } = {}) {
  const need = tablesNeeded(request), have = new Set([...(tables.lines || []), ...(tables.cia || [])].map((t) => t.species));
  const missing = [...need.lines, ...need.cia].filter((s) => !have.has(s)); if (missing.length) throw new Error('opacity tables not loaded: ' + missing.join(', '));
  if (need.chem && !tables.chem) throw new Error('chemical equilibrium needs the chemistry table (chem/equilibrium.eslc)');
  const use = { ...tables, lines: tables.lines.filter((t) => need.lines.includes(t.species)), cia: tables.cia.filter((t) => need.cia.includes(t.species)) };
  const tb = request.wlMin || request.wlMax || request.merge > 1 ? prepareTables(use, { wlMin: request.wlMin ?? 0, wlMax: request.wlMax ?? Infinity, merge: request.merge ?? 1 }) : use;
  const solved = withConsistentProfile(modelOf(request), tb, { kernel, cache: cache ? (cache.climate ??= {}) : null });
  const r = dayNightModel(solved.model, tb, { kernel, cache, want: { emission: request.emission !== false, transmission: request.transmission !== false } }), a = r.atm, edges = r.grid.edges;
  const cut = (x) => { if (!x) return null; if (!(request.R > 0)) return Array.from(x); return Array.from(binSpectrum(r.wl, x, { R: request.R, wlMin: edges ? edges[0] : r.wl[0], wlMax: edges ? edges[edges.length - 1] : r.wl[r.wl.length - 1] }).value); };
  const b = request.R > 0 ? binSpectrum(r.wl, r.wl, { R: request.R, wlMin: edges ? edges[0] : r.wl[0], wlMax: edges ? edges[edges.length - 1] : r.wl[r.wl.length - 1] }) : null;
  const keep = b ? Array.from(b.count, (c) => c > 0) : null, sel = (x) => (x && keep ? x.filter((_, i) => keep[i]) : x);
  return {
    wl: sel(b ? Array.from(b.wl) : Array.from(r.wl)), lo: sel(b ? Array.from(b.lo) : edges ? Array.from(edges.slice(0, -1)) : null), hi: sel(b ? Array.from(b.hi) : edges ? Array.from(edges.slice(1)) : null),
    depth: sel(cut(r.depth)), fpfs: sel(cut(r.fpfs)), flux: sel(cut(r.flux)), brightness: sel(cut(r.brightness)),
    profile: { p: Array.from(a.pLay, (p) => p / 1e5), t: Array.from(a.tLay), mu: Array.from(a.mu), z: Array.from(a.rLay, (x) => (x - a.rLev[a.n]) / 1e3), gases: Object.fromEntries(Object.entries(a.species).map(([k, v]) => [k, Array.from(v)])) },
    clouds: a.condensation ? a.condensation.clouds.map((c) => ({ name: c.name, label: c.label, base: c.base, deep: c.deep })) : [], climate: solved.climate, model: solved.model,
  };
}

const KINDS = ['transit', 'eclipse', 'night'];
/** The request with what a retrieval adds to it: a gas whose abundance is free must be in the model, so that its table is asked for. */
function retrievalRequest(request) {
  const base = modelOf(request), add = {}, gases = (request.free || []).filter((k) => k.startsWith('logX_')).map((k) => k.slice(5));
  for (const g of gases) if (!(base.vmr && g in base.vmr)) add[g] = 1e-6;
  // a freed gas is always among the opacities, whatever `species` says: without its table the fit would return its prior
  const species = request.species ? [...new Set([...request.species, ...gases])] : undefined;
  return { ...request, ...(species ? { species } : {}), ...(Object.keys(add).length ? { model: { ...(request.model || {}), vmr: { ...((request.model && request.model.vmr) || {}), ...add } } } : {}) };
}
/** What a retrieval request needs loaded (as tablesNeeded, with the gases it frees). */
export const retrievalNeeds = (request = {}) => tablesNeeded(retrievalRequest(request));

/** Data sets checked and copied: [{ name, kind, wl, y, err, lo, hi, edgesGiven }] (bin edges worked out from the spacing when not given). Throws with the set and row that is wrong. */
export function retrievalData(sets) {
  if (!Array.isArray(sets) || !sets.length) throw new Error('a retrieval needs data: [{ kind, wl, y, err }]');
  return sets.map((d, j) => {
    const what = `data set ${j + 1}`, n = d.wl && d.wl.length;
    if (!KINDS.includes(d.kind)) throw new Error(`${what}: kind must be one of ${KINDS.join(', ')}`);
    if (!(n > 0) || !d.y || !d.err || d.y.length !== n || d.err.length !== n || (d.lo && d.lo.length !== n) || (d.hi && d.hi.length !== n)) throw new Error(`${what}: wl, y, err (and lo, hi when given) must be arrays of one length`);
    for (let i = 0; i < n; i++) if (!(d.wl[i] > 0) || !Number.isFinite(d.y[i]) || !(d.err[i] > 0)) throw new Error(`${what}, row ${i + 1}: the wavelength and the error must be positive and the value a number`);
    const wl = Array.from(d.wl); let lo = d.lo && d.hi ? Array.from(d.lo) : null, hi = lo ? Array.from(d.hi) : null;
    // A measured point is an average over a band. Without bin edges the bands are taken to meet halfway (in log
    // wavelength) between neighbours, each as wide on both sides as its nearer neighbour allows, so that a gap
    // between instruments does not widen the bins beside it.
    if (!lo && n > 1) {
      const ord = wl.map((_, i) => i).sort((a, b) => wl[a] - wl[b]); lo = new Array(n); hi = new Array(n);
      ord.forEach((i, q) => { const left = q > 0 ? Math.log(wl[i] / wl[ord[q - 1]]) : Infinity, right = q < n - 1 ? Math.log(wl[ord[q + 1]] / wl[i]) : Infinity, h = 0.5 * Math.min(left, right); lo[i] = wl[i] * Math.exp(-h); hi[i] = wl[i] * Math.exp(h); });
      if (ord.some((i, q) => q > 0 && !(wl[i] > wl[ord[q - 1]]))) throw new Error(`${what}: two rows have the same wavelength`);
    }
    return { name: d.name || d.kind, kind: d.kind, wl, y: Array.from(d.y), err: Array.from(d.err), ...(lo ? { lo, hi } : {}), edgesGiven: !!(d.lo && d.hi) };
  });
}
/**
 * What a retrieval is run with, from what a host was given: the model made ready (30 layers unless `layers`; chemical
 * equilibrium switched on when [M/H] or C/O is free; a haze to scale when its strength is free), the priors (given as
 * [low, high] or { type, a, b }, else defaultPrior), and the tables cut to the data's range and joined to its
 * resolving power (`merge` bins; default 1 to 8: as many as leave three model bins in one of the data's).
 * Returns { model, priors, tables, merge }. Throws on what cannot be fitted.
 */
export function retrievalSetup(model, tables, data, free, { priors = null, merge = null, layers = 30 } = {}) {
  if (!Array.isArray(free) || !free.length) throw new Error('a retrieval needs free: [parameter keys]');
  const nData = data.reduce((s, d) => s + d.wl.length, 0);
  if (new Set(free).size !== free.length) throw new Error('a parameter is free twice');
  if (nData <= free.length) throw new Error(`${nData} data points cannot constrain ${free.length} free parameters`);
  const m = { ...model, nLayers: layers }, kind = m.tp && m.tp.kind;
  if (kind !== 'guillot' && kind !== 'isothermal') throw new Error(`a retrieval needs the temperature profile "guillot" or "isothermal" (this one is "${kind}"): radiative balance is too slow to sample`);
  const wrong = free.filter((k) => (kind === 'isothermal' ? ['teq', 'tint', 'logKappaIR', 'logGamma'] : ['t']).includes(k));
  if (wrong.length) throw new Error(`${wrong.join(', ')} ${wrong.length > 1 ? 'are' : 'is'} not a parameter of the ${kind} profile (${kind === 'isothermal' ? 'free t instead' : 'free teq, logKappaIR, logGamma instead'})`);
  if (free.some((k) => ['mh', 'co', 'logQuench'].includes(k)) && !m.chemistry) m.chemistry = { mh: 0, co: 0.59 };
  if (m.chemistry && free.some((k) => k.startsWith('logX_'))) throw new Error('with chemical equilibrium the gases follow from [M/H] and C/O: free mh and co, or give mixing ratios by hand to free logX_<gas>');
  if ((free.includes('logHaze') || free.includes('hazeSlope')) && !m.haze) m.haze = { factor: 1, slope: -4 };
  if ((free.includes('logCloudTau') || free.includes('logGrain')) && !m.cloud) throw new Error('logCloudTau and logGrain need a particle layer in the model (model.cloud)');
  const used = {};
  for (const k of free) { const pr = (priors || {})[k], use = Array.isArray(pr) ? { type: 'uniform', a: Number(pr[0]), b: Number(pr[1]) } : pr || defaultPrior(k, m); if (!use || (use.type === 'uniform' && !(use.b > use.a))) throw new Error(`the prior of ${k} must be [low, high] with low < high`); used[k] = use; }
  // the data's range and resolving power decide how much of the tables is kept
  let w0 = Infinity, w1 = 0; const res = [];
  for (const d of data) for (let i = 0; i < d.wl.length; i++) { const lo = d.lo ? d.lo[i] : d.wl[i], hi = d.hi ? d.hi[i] : d.wl[i]; w0 = Math.min(w0, lo); w1 = Math.max(w1, hi); const dw = d.lo ? hi - lo : i + 1 < d.wl.length ? Math.abs(d.wl[i + 1] - d.wl[i]) : 0; if (dw > 0) res.push(d.wl[i] / dw); }
  res.sort((x, y) => x - y);
  const any = (tables.lines || [])[0] || (tables.cia || [])[0], k = any && any.edges ? Math.floor(any.wl.length / 2) : -1, rTable = k >= 0 ? any.wl[k] / (any.edges[k + 1] - any.edges[k]) : 200, rData = res.length ? res[Math.floor(res.length / 2)] : rTable;
  // joined bins must stay well inside the data's: with model bins as wide as the data's the binned model is off by
  // far more than with a third of that (57 ppm against 4 to 9 on a hot Jupiter at R = 30; test/retrieval.test.mjs)
  const join = merge ?? Math.max(1, Math.min(8, Math.floor(rTable / (3 * rData))));
  if (any && any.edges && (w1 < any.edges[0] || w0 > any.edges[any.edges.length - 1])) throw new Error(`the data (${w0.toPrecision(3)} to ${w1.toPrecision(3)} micron) lie outside the opacity tables (${any.edges[0].toPrecision(3)} to ${any.edges[any.edges.length - 1].toPrecision(3)} micron): are the wavelengths in micron?`);
  return { model: m, priors: used, tables: prepareTables(tables, { wlMin: 0.97 * w0, wlMax: 1.03 * w1, merge: join }), merge: join };
}
/** A retrieval's result as plain data (what retrieveAtmosphere returns, without the tables' names). */
export function retrievalResult(r, priors, merge) {
  return { keys: r.keys, labels: r.labels, priors, summary: r.summary, logZ: r.logZ, logZerr: r.logZerr, converged: !!r.converged, ncalls: r.ncalls, seconds: r.elapsed, msPerModel: r.msPerModel, chi2: r.best.chi2, ndata: r.ndata,
    ess: r.ess, warnings: (r.warnings || []).map((w) => (typeof w === 'string' ? w : w.text || w.message || JSON.stringify(w))),
    best: { values: Object.fromEntries(r.keys.map((key, i) => [key, r.best.theta[i]])), spectra: r.best.spectra.map((x) => Array.from(x)) }, merge };
}

/**
 * A spectrum from the text of a file: rows of "wavelength, value, error" or "wavelength, bin_low, bin_high, value,
 * error" (micron; commas, semicolons or blanks; lines that do not start with a number are skipped), sorted by
 * wavelength. unit: 'fraction' | 'percent' | 'ppm' of the value and error columns.
 * Returns { name, kind, wl, y, err, lo?, hi? }. Throws when fewer than three rows can be read.
 */
export function parseSpectrumText(text, { kind = 'transit', unit = 'fraction', name = 'spectrum' } = {}) {
  const k = { fraction: 1, percent: 1e-2, ppm: 1e-6 }[unit]; if (!k) throw new Error('unit must be fraction, percent or ppm');
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const rows = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && /^[-+.\d]/.test(l)).map((l) => l.split(/[,;\s]+/).filter((x) => x !== '').map(Number));
  const ok = rows.filter((x) => (x.length === 3 || x.length >= 5) && x.slice(0, 5).every(Number.isFinite)), wide = ok.length > 0 && ok.every((x) => x.length >= 5);
  if (ok.length < 3 || (!wide && !ok.every((x) => x.length === 3))) throw new Error(`${name}: needs at least 3 rows of "wavelength, value, error" or "wavelength, bin_low, bin_high, value, error" (${rows.length} rows of numbers read, ${ok.length} usable)`);
  ok.sort((x, y) => x[0] - y[0]);
  return { name, kind, wl: ok.map((x) => x[0]), ...(wide ? { lo: ok.map((x) => x[1]), hi: ok.map((x) => x[2]) } : {}), y: ok.map((x) => k * x[wide ? 3 : 1]), err: ok.map((x) => k * x[wide ? 4 : 2]) };
}

/** A retrieval's posterior as the corner plot takes it: { ndim, n, samples, weights, logl, ess } (typed arrays). */
export const retrievalPosterior = (r) => ({ ndim: r.ndim, n: r.n, samples: r.samples, weights: r.weights, logl: r.logl, ess: r.ess });

/**
 * Fit a model atmosphere to spectra (src/core/retrieval.js behind one plain-JSON call).
 *   { world, model, species: as runAtmosphere (the model is the starting description; what is not free stays as given),
 *     data: [{ kind: 'transit' | 'eclipse' | 'night', wl [micron], y (depth, or Fp/Fs for eclipse and night), err,
 *              lo, hi (bin edges; without them the bins are taken to meet halfway between neighbouring wavelengths) }],
 *     free: [parameter keys of ATM_PARAMS, logX_<gas>, offset_<n>],
 *     priors: { key: [low, high] (uniform) | { type, a, b } } (default: defaultPrior of retrieval.js),
 *     merge (opacity bins joined, for speed; default: as many as leave three model bins in one of the data's, 1 to 8),
 *     layers (default 30), sampler: { nlive = 100, maxCalls = 20000, maxSeconds, seed } }
 *   tables: at least retrievalNeeds(request); opts: { kernel, cache, onProgress }
 * Returns { keys, labels, priors (as used), summary: { key: { median, lo, hi, best } } (16, 50, 84%), logZ, logZerr,
 *           converged (false when the budget ran out first: the summary is then not a posterior), ncalls, seconds,
 *           msPerModel, chi2, ndata, ess, warnings: [text], best: { values: { key: value }, spectra: [[model on each
 *           set's bins]] }, merge, gases, cia }.
 * The temperature profile must be 'guillot' or 'isothermal': radiative balance ('consistent') is too slow to sample.
 */
export function retrieveAtmosphere(request, tables, { kernel = null, cache = {}, onProgress = null } = {}) {
  const data = retrievalData(request && request.data), free = ((request && request.free) || []).slice();
  if (!free.length) throw new Error('a retrieval needs free: [parameter keys]');
  const rq = retrievalRequest(request), chemOn = free.some((k) => ['mh', 'co', 'logQuench'].includes(k)) && !modelOf(rq).chemistry;
  const need = tablesNeeded(chemOn ? { ...rq, model: { ...(rq.model || {}), chemistry: { mh: 0, co: 0.59 } } } : rq), have = new Set([...(tables.lines || []), ...(tables.cia || [])].map((t) => t.species));
  const missing = [...need.lines, ...need.cia].filter((s) => !have.has(s)); if (missing.length) throw new Error('opacity tables not loaded: ' + missing.join(', '));
  if (need.chem && !tables.chem) throw new Error('chemical equilibrium needs the chemistry table (chem/equilibrium.eslc)');
  const use = { ...tables, lines: tables.lines.filter((t) => need.lines.includes(t.species)), cia: tables.cia.filter((t) => need.cia.includes(t.species)) };
  const set = retrievalSetup(modelOf(rq), use, data, free, { priors: request.priors, merge: request.merge ?? null, layers: request.layers ?? 30 }), sm = request.sampler || {};
  const r = runRetrieval({ model: set.model, tables: set.tables, free, priors: set.priors, data, sampler: { nlive: sm.nlive ?? 100, maxCalls: sm.maxCalls ?? 20000, maxSeconds: sm.maxSeconds, seed: sm.seed ?? 42 } }, { kernel, cache, onProgress });
  return { ...retrievalResult(r, set.priors, set.merge), gases: need.lines, cia: need.cia };
}

/** The preset worlds: [{ name, about, tables }]. */
export const worlds = () => Object.entries(WORLDS).map(([name, w]) => ({ name, about: w.about, tables: w.tables }));
