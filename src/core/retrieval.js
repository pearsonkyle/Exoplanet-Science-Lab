// Atmospheric retrieval: the forward model of src/core/rtmodel.js fitted to spectra with the site's nested sampler.
//
// A retrieval is described the way the light-curve fits are: free parameters, each with a prior of src/core/priors.js
// ({ type: 'uniform' | 'normal' | 'loguniform' | 'truncnormal', a, b }), a Gaussian likelihood, MiniNest
// (src/core/nested.js) for the posterior and the evidence ln Z, so that two descriptions of the same data (with and
// without a cloud, a gas, a night-side contrast) are compared by their Bayes factor. It returns what runFit returns
// (the sampler's result with `keys`), plus the best spectra and summaries.
//
// Data sets: any number of spectra, each { kind, wl, lo, hi (bin edges, micron), y, err }:
//   'transit'  transit depth (the terminator column)
//   'eclipse'  eclipse depth Fp/Fs (Rp/Rs)^2 (the day side)
//   'night'    the same ratio for the night side: what a phase curve's minimum gives, wavelength by wavelength
// The model is binned to each set's bins (mean of the model's own bins, weighted by their overlap with the bin;
// interpolated at the centre when a set has no bin edges).
// With a 'night' set, or the parameter nightDT, the three-column model (dayNightModel) is used.
//
// Not here yet: this likelihood stands beside buildProblem (src/core/model.js), not inside it, so a retrieval is
// not yet fitted jointly with the light curves it came from; the spectra and their errors are taken as given.
import { MiniNest } from './nested.js';
import { makeTransform } from './priors.js';
import { makeRng, resampleIndices } from './stats.js';
import { DEFAULT_MODEL, forwardModel, dayNightModel } from './rtmodel.js';

const setIn = (obj, key, sub, v) => { obj[key] = { ...(obj[key] || {}), [sub]: v }; };
/**
 * The parameters a retrieval can free: key -> { label, apply(model, value) }. A key `logX_<gas>` (log10 of a constant
 * mixing ratio) exists for every gas; `offset_<n>` shifts data set n (1-based) by a constant in its own units.
 */
export const ATM_PARAMS = {
  teq: { label: 'Equilibrium temperature (K)', apply: (m, v) => setIn(m, 'tp', 'teq', v) },
  tint: { label: 'Internal temperature (K)', apply: (m, v) => setIn(m, 'tp', 'tint', v) },
  t: { label: 'Temperature (K)', apply: (m, v) => setIn(m, 'tp', 't', v) },
  logKappaIR: { label: 'log10 infrared opacity (m²/kg)', apply: (m, v) => setIn(m, 'tp', 'kappaIR', 10 ** v) },
  logGamma: { label: 'log10 visible / infrared opacity', apply: (m, v) => setIn(m, 'tp', 'gamma', 10 ** v) },
  mh: { label: '[M/H]', apply: (m, v) => setIn(m, 'chemistry', 'mh', v) },
  co: { label: 'C/O', apply: (m, v) => setIn(m, 'chemistry', 'co', v) },
  logQuench: { label: 'log10 quench pressure (bar)', apply: (m, v) => setIn(m, 'chemistry', 'quench', 10 ** v) },
  rplanet: { label: 'Radius at the reference pressure (R Jup)', apply: (m, v) => setIn(m, 'planet', 'rplanet', v) },
  logCloudTop: { label: 'log10 cloud-top pressure (bar)', apply: (m, v) => { m.cloudTop = 10 ** v; } },
  cloudFraction: { label: 'Cloud cover', apply: (m, v) => { m.cloudFraction = v; } },
  logHaze: { label: 'log10 haze strength (× H2 Rayleigh)', apply: (m, v) => setIn(m, 'haze', 'factor', 10 ** v) },
  hazeSlope: { label: 'Haze slope', apply: (m, v) => setIn(m, 'haze', 'slope', v) },
  logRayleigh: { label: 'log10 Rayleigh strength', apply: (m, v) => { m.rayleighFactor = 10 ** v; } },
  logCloudTau: { label: 'log10 particle optical depth', apply: (m, v) => setIn(m, 'cloud', 'tau', 10 ** v) },
  logGrain: { label: 'log10 grain radius (µm)', apply: (m, v) => setIn(m, 'cloud', 'radius', 10 ** v) },
  nightDT: { label: 'Night side cooler by (K)', apply: (m, v) => { m.night = { dT: v }; } },
};
const paramOf = (key) => {
  if (ATM_PARAMS[key]) return ATM_PARAMS[key];
  if (key.startsWith('logX_')) { const g = key.slice(5); return { label: `log10 ${g}`, apply: (m, v) => { m.vmr = { ...(m.vmr || {}), [g]: 10 ** v }; } }; }
  if (key.startsWith('offset_')) return { label: `Offset of data set ${key.slice(7)}`, apply: () => {} };
  throw new Error(`no retrieval parameter "${key}" (known: ${Object.keys(ATM_PARAMS).join(', ')}, logX_<gas>, offset_<n>)`);
};

/**
 * The prior a host uses when the caller gives none: wide, uniform, and stated in the result. `model` is the base model
 * (the radius prior is ±20% of its radius). An offset has no default: its size is the data's business.
 */
export function defaultPrior(key, model = DEFAULT_MODEL) {
  const U = (a, b) => ({ type: 'uniform', a, b }), r = (model.planet && model.planet.rplanet) || 1;
  const table = { teq: U(300, 3000), tint: U(0, 600), t: U(300, 3000), logKappaIR: U(-4, -1), logGamma: U(-1.5, 0.5), mh: U(-1, 2), co: U(0.2, 1.2), logQuench: U(-6, 2), rplanet: U(0.8 * r, 1.2 * r),
    logCloudTop: U(-5, 1.5), cloudFraction: U(0, 1), logHaze: U(0, 5), hazeSlope: U(-8, 0), logRayleigh: U(-1, 3), logCloudTau: U(-3, 2), logGrain: U(-2, 1.5), nightDT: U(0, 1200) };
  if (table[key]) return table[key];
  if (key.startsWith('logX_')) return U(-10, -1);
  if (key.startsWith('offset_')) throw new Error(`${key} needs a prior: give priors.${key} = [low, high] in the data's units`);
  paramOf(key); return null;
}

/**
 * The model's values on a data set's bins. With the model's own bin edges (correlated-k tables) each data bin is the
 * mean of the model bins it overlaps, weighted by the overlap: a model bin that straddles a data bin's edge counts
 * for the part inside. (Counting whole model bins by their centres, as the first version did, is wrong by up to half
 * a model bin at each edge: 23 ppm rms on a hot Jupiter at R = 30 with model bins of R = 100, against 5 ppm so.)
 * Without edges: the mean of the model's points inside the bin. A bin that holds nothing, or a data set without
 * bin edges, takes the model interpolated at the bin's centre.
 */
function binner(wlModel, set, edges = null) {
  const n = set.wl.length, lists = [], nm = wlModel.length;
  const at = (i) => { let k = 0; while (k < nm - 2 && wlModel[k + 1] < set.wl[i]) k++; return { k, f: Math.min(1, Math.max(0, (set.wl[i] - wlModel[k]) / (wlModel[k + 1] - wlModel[k]))) }; };
  for (let i = 0; i < n; i++) {
    if (!set.lo || !set.hi) { lists.push(at(i)); continue; }
    const lo = set.lo[i], hi = set.hi[i], idx = [], w = [];
    if (edges && edges.length === nm + 1) { for (let k = 0; k < nm; k++) { const o = Math.min(edges[k + 1], hi) - Math.max(edges[k], lo); if (o > 0) { idx.push(k); w.push(o); } } }
    else for (let k = 0; k < nm; k++) if (wlModel[k] >= lo && wlModel[k] < hi) { idx.push(k); w.push(1); }
    if (!idx.length) { lists.push(at(i)); continue; }
    const tot = w.reduce((x, y) => x + y, 0); lists.push({ idx, w: w.map((x) => x / tot) });
  }
  return (y, out) => { for (let i = 0; i < n; i++) { const L = lists[i]; if (L.idx) { let s = 0; for (let q = 0; q < L.idx.length; q++) s += L.w[q] * y[L.idx[q]]; out[i] = s; } else out[i] = y[L.k] + L.f * (y[L.k + 1] - y[L.k]); } return out; };
}

/**
 * The problem as the sampler takes it.
 *   spec: { model: base model description (rtmodel.js), tables: { lines, cia, chem?, star? } (cut to the data's range
 *           with prepareTables for speed), free: [key], priors: { key: { type, a, b } }, data: [{ name?, kind, wl, lo, hi, y, err }] }
 *   opts: { kernel, cache }
 * Returns { ndim, keys, labels, transform(u, theta), loglike(theta), predict(theta) -> [Float64Array per data set],
 *           modelAt(theta) -> the model description, n: number of data points }.
 */
export function buildRetrieval(spec, { kernel = null, cache = {} } = {}) {
  const keys = spec.free.slice(), defs = keys.map(paramOf), tf = keys.map((k) => { const pr = spec.priors[k]; if (!pr) throw new Error(`no prior for ${k}`); return makeTransform(pr); });
  const data = spec.data, kinds = new Set(data.map((d) => d.kind)), needNight = kinds.has('night') || keys.includes('nightDT') || !!(spec.model.night && spec.model.night.dT > 0);
  const want = { transmission: kinds.has('transit'), emission: kinds.has('eclipse') || kinds.has('night') };
  const offs = data.map((_, j) => keys.indexOf(`offset_${j + 1}`)), base = { ...DEFAULT_MODEL, ...spec.model };
  let bins = null; const pred = data.map((d) => new Float64Array(d.wl.length));
  const modelAt = (theta) => { const m = { ...base }; defs.forEach((d, i) => d.apply(m, theta[i])); return m; };
  const predict = (theta) => {
    const m = modelAt(theta), r = needNight ? dayNightModel(m, spec.tables, { want, kernel, cache, night: kinds.has('night') }) : forwardModel(m, spec.tables, { want, kernel, cache });
    bins ??= data.map((d) => binner(r.wl, d, r.grid && r.grid.edges));
    data.forEach((d, j) => { const y = d.kind === 'transit' ? r.depth : d.kind === 'eclipse' ? r.fpfs : r.nightSide ? r.nightSide.fpfs : r.fpfs; bins[j](y, pred[j]); if (offs[j] >= 0) for (let i = 0; i < pred[j].length; i++) pred[j][i] += theta[offs[j]]; });
    return pred;
  };
  const norm = data.reduce((s, d) => s + d.err.reduce((a, e) => a + Math.log(2 * Math.PI * e * e), 0), 0);
  const loglike = (theta) => {
    let p; try { p = predict(theta); } catch { return -1e300; }   // a model that cannot be built (unbound, sums above 1) is excluded
    let c = 0; for (let j = 0; j < data.length; j++) { const d = data[j]; for (let i = 0; i < d.y.length; i++) { const z = (d.y[i] - p[j][i]) / d.err[i]; c += z * z; } }
    return Number.isFinite(c) ? -0.5 * (c + norm) : -1e300;
  };
  return { ndim: keys.length, keys, labels: defs.map((d) => d.label), transform: (u, t) => { for (let i = 0; i < keys.length; i++) t[i] = tf[i](u[i]); }, loglike, predict, modelAt, n: data.reduce((s, d) => s + d.y.length, 0) };
}

/**
 * Run a retrieval. spec as buildRetrieval, plus sampler: { nlive = 200, fracRemain, seed, maxCalls, maxSeconds, method, sliceSteps }
 * (the last two as MiniNest takes them: 'auto' | 'region' | 'slice', and slice steps per new point).
 * opts: { kernel, cache, onProgress(progress) }
 * Returns the sampler's result (ndim, n, samples, weights, logZ, logZerr, ess, converged, warnings, ...) with
 *   keys, labels, summary: { key: { median, lo, hi, best } }, best: { theta, chi2, spectra: [Float64Array per data set] },
 *   ndata, elapsed [s], msPerModel.
 */
export function runRetrieval(spec, { kernel = null, cache = {}, onProgress = null } = {}) {
  const prob = buildRetrieval(spec, { kernel, cache }), sm = spec.sampler || {}, t0 = Date.now();
  const ns = new MiniNest({ ndim: prob.ndim, loglike: prob.loglike, transform: prob.transform, nlive: sm.nlive ?? 200, fracRemain: sm.fracRemain ?? 0.01, seed: sm.seed ?? 42, maxCalls: sm.maxCalls ?? 2e5, maxSeconds: sm.maxSeconds, method: sm.method, sliceSteps: sm.sliceSteps, names: prob.keys, labels: prob.labels });
  let last = Date.now();
  while (!ns.step(20)) { if (onProgress && Date.now() - last > 2000) { last = Date.now(); onProgress({ ...ns.progress(), elapsed: (last - t0) / 1000 }); } }
  const res = ns.result(), d = prob.ndim, n = res.n, summary = {};
  prob.keys.forEach((k, c) => { const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => res.samples[a * d + c] - res.samples[b * d + c]), q = []; let cum = 0, j = 0; for (const i of idx) { cum += res.weights[i]; while (j < 3 && cum >= [0.16, 0.5, 0.84][j]) { q.push(res.samples[i * d + c]); j++; } } while (q.length < 3) q.push(res.samples[idx[n - 1] * d + c]); summary[k] = { lo: q[0], median: q[1], hi: q[2], best: res.maxPoint[c] }; });
  const spectra = prob.predict(res.maxPoint).map((a) => Float64Array.from(a)), chi2 = spec.data.reduce((s, dset, j) => s + dset.y.reduce((a, y, i) => a + ((y - spectra[j][i]) / dset.err[i]) ** 2, 0), 0), elapsed = (Date.now() - t0) / 1000;
  return { ...res, keys: prob.keys, labels: prob.labels, summary, best: { theta: res.maxPoint, chi2, spectra }, ndata: prob.n, elapsed, msPerModel: (1000 * elapsed) / Math.max(1, res.ncalls) };
}

/**
 * What the posterior says the spectrum is, on each data set's bins: for `draws` equal-weight draws of the posterior the
 * model is computed, and at every bin the 16, 50 and 84% points of those models are kept.
 *   prob: buildRetrieval's problem; res: { ndim, n, samples, weights }
 * Returns [{ lo, median, hi } per data set] (Float64Arrays). With n draws the band's edges are known to about
 * 1/sqrt(n) of its width: 60 draws, 13%.
 */
export function posteriorBand(prob, res, { draws = 60, seed = 7 } = {}) {
  const d = res.ndim, idx = resampleIndices(res.weights, draws, makeRng(seed)), runs = [];
  for (const i of idx) { let p; try { p = prob.predict(Array.from(res.samples.subarray(i * d, i * d + d))); } catch { continue; } runs.push(p.map((a) => Float64Array.from(a))); }
  if (!runs.length) throw new Error('no model of the posterior could be computed');
  const at = (v, q) => { const x = q * (v.length - 1), k = Math.floor(x), f = x - k; return k + 1 < v.length ? v[k] + f * (v[k + 1] - v[k]) : v[k]; };
  return runs[0].map((first, j) => {
    const n = first.length, lo = new Float64Array(n), median = new Float64Array(n), hi = new Float64Array(n), col = new Float64Array(runs.length);
    for (let i = 0; i < n; i++) { for (let r = 0; r < runs.length; r++) col[r] = runs[r][j][i]; const v = Float64Array.from(col).sort(); lo[i] = at(v, 0.16); median[i] = at(v, 0.5); hi[i] = at(v, 0.84); }
    return { lo, median, hi };
  });
}

/**
 * A spectrum as an instrument of resolving power R would give it, from a model: the model on the tables as given,
 * averaged over bins of equal width in log wavelength, with Gaussian noise of `noise` (in the spectrum's own units;
 * a number, or one per bin) added from the seed. For trying a retrieval where the answer is known: not a simulation
 * of an instrument (no systematics, no wavelength-dependent noise unless given).
 *   spec: { model, tables, kind: 'transit' | 'eclipse' | 'night', wlMin, wlMax, R, noise, seed }
 * Returns { kind, wl, lo, hi, y, err, truth (the spectrum before the noise) } as arrays.
 */
export function simulateSpectrum({ model, tables, kind = 'transit', wlMin, wlMax, R = 50, noise = 50e-6, seed = 1 }, { kernel = null, cache = {} } = {}) {
  if (!(wlMin > 0) || !(wlMax > wlMin)) throw new Error('a simulated spectrum needs wlMin < wlMax (micron)');
  if (!(R >= 3)) throw new Error('the resolving power must be at least 3');
  const n = Math.max(3, Math.round(Math.log(wlMax / wlMin) * R)), lo = [], hi = [], wl = [];
  for (let i = 0; i < n; i++) { lo.push(wlMin * (wlMax / wlMin) ** (i / n)); hi.push(wlMin * (wlMax / wlMin) ** ((i + 1) / n)); wl.push(Math.sqrt(lo[i] * hi[i])); }
  const err = wl.map((_, i) => (Array.isArray(noise) ? noise[i] : noise)); if (err.some((e) => !(e > 0))) throw new Error('the noise must be positive');
  const prob = buildRetrieval({ model, tables, free: [], priors: {}, data: [{ kind, wl, lo, hi, y: wl.map(() => 0), err }] }, { kernel, cache });
  const truth = Array.from(prob.predict([])[0]); if (truth.some((v) => !Number.isFinite(v))) throw new Error('the model gave no spectrum over this range');
  const rng = makeRng(seed), y = truth.map((v, i) => v + err[i] * rng.normal());
  return { kind, wl, lo, hi, y, err, truth };
}

/**
 * Two retrievals of the same data compared: Δ ln Z = a − b with its error, and the words the site uses for the
 * light-curve fits (above 2.5: favoured; above 5: strongly; within ±1: the data do not tell them apart).
 */
export function compareRetrievals(a, b) {
  const d = a.logZ - b.logZ, e = Math.hypot(a.logZerr || 0, b.logZerr || 0), x = Math.abs(d);
  return { dLogZ: d, err: e, verdict: x < 1 ? 'the data do not tell the two apart' : `${x >= 5 ? 'strongly favours' : x >= 2.5 ? 'favours' : 'leans toward'} the ${d > 0 ? 'first' : 'second'}` };
}
