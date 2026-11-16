// The ESL session: one JSON document that describes an analysis completely (the system, the data,
// what is free with which priors, the sampler settings) and, once run, its result. It is what the
// analyzer saves and exports, what the worked examples are stored as, and what the Python package and
// the assistant read and write. docs/FORMAT.md is the reference; this module turns a session into the
// specification buildProblem takes, runs it, and summarises the posterior. No DOM.
//
// Times in a session are absolute (BJD or whatever the data use). Inside a fit they are measured from
// session.time_reference, so Julian dates keep their precision. Parameter keys are those of the
// analyzer: the first planet's are plain ("per"), later planets' carry their letter ("per@c"),
// epochs and velocity datasets their number ("a2@3", "jit@rv2").

import { buildProblem, autoSupersample, planetKey, PLANET_FIELDS, infoCriteria } from './model.js';
import { runFit } from './fitRunner.js';
import { deriveSystem, summarizeDraws, summarizeEpoch } from './derive.js';
import { arsFromKepler } from './rv.js';
import { LD_LAWS } from './limbdark.js';
import { weightedQuantiles, resampleIndices, makeRng } from './stats.js';
import { applyDetrend } from './data.js';
import { physicalPriorVolume } from './physical.js';

export const FORMAT = 'esl-session', FORMAT_VERSION = 1;

const isTime = (key) => key.split('@')[0] === 'tmid';
const f64 = (a) => Float64Array.from(a || []);

/** Key suffix of each planet: '' for the first, its letter for the others. */
export const planetSuffixes = (session) => session.planets.map((p, i) => (i ? p.letter : ''));

/** Throws a readable error when a document is not a usable session. */
export function validateSession(s) {
  if (!s || s.format !== FORMAT) throw new Error(`not an ESL session (format should be "${FORMAT}")`);
  if (!(s.version >= 1) || s.version > FORMAT_VERSION) throw new Error(`session version ${s.version} is not supported by this build (it reads up to ${FORMAT_VERSION})`);
  if (!Array.isArray(s.planets) || !s.planets.length) throw new Error('a session needs at least one planet');
  if (!s.fit || !Array.isArray(s.fit.free)) throw new Error('a session needs fit.free (it may be empty)');
  const d = s.data || {}, lc = d.light_curve;
  if (lc && !(lc.time.length === lc.flux.length && lc.time.length === lc.flux_err.length)) throw new Error('light curve: time, flux and flux_err must have the same length');
  for (const r of d.radial_velocity || []) if (!(r.time.length === r.velocity.length && r.time.length === r.velocity_err.length)) throw new Error(`velocities "${r.name}": time, velocity and velocity_err must have the same length`);
  return s;
}

/** The flat table of parameter values (keys as in the analyzer, times relative to the reference). */
export function valuesFromSession(s) {
  const tRef = s.time_reference || 0, sfx = planetSuffixes(s), v = {};
  s.planets.forEach((p, i) => { for (const [f, x] of Object.entries(p.parameters)) if (x !== null && x !== undefined) v[planetKey(f, sfx[i])] = f === 'tmid' ? x - tRef : x; });
  const ld = s.limb_darkening || { law: 'quadratic', coefficients: [0.4, 0.25] };
  for (let i = 0; i < 4; i++) v['ld' + i] = ld.coefficients[i] ?? 0;
  for (const [k, x] of Object.entries((s.fit && s.fit.fixed) || {})) v[k] = isTime(k) ? x - tRef : x;
  const st = s.star || {};
  for (const k of ['mstar', 'rstar', 'teff', 'feh']) if (Number.isFinite(st[k])) v[k] = st[k];
  return v;
}

/**
 * The specification for buildProblem / runFit. `use` overrides session.fit.use, e.g. { lc: true, rv: true, timing: false }.
 * Limb darkening that follows the star (mode "star") needs a table and is set up by the caller through spec.ldTie.
 */
export function specFromSession(s, use) {
  validateSession(s);
  const tRef = s.time_reference || 0, d = s.data || {}, u = { lc: true, rv: true, timing: true, ...(s.fit.use || {}), ...(use || {}) };
  const values = valuesFromSession(s), sfx = planetSuffixes(s);
  let data = null;
  if (u.lc && d.light_curve) {
    const L = d.light_curve, n = L.time.length;
    data = { name: L.name || 'light curve', tRef, t: Float64Array.from(L.time, (x) => x - tRef), f: f64(L.flux), e: f64(L.flux_err), airmass: L.airmass ? f64(L.airmass) : null };
    if (L.epoch && L.epochs && L.epochs.length > 1) {
      data.epoch = Int32Array.from(L.epoch);
      data.segments = L.epochs.map((ep, k) => { let t0 = Infinity, t1 = -Infinity, c = 0; for (let i = 0; i < n; i++) if (data.epoch[i] === k) { c++; t0 = Math.min(t0, data.t[i]); t1 = Math.max(t1, data.t[i]); } const sg = { name: ep.name, n: c, t0, t1, airmass: !!ep.airmass }; if (ep.exposure_min !== undefined && ep.exposure_min !== null) sg.exptime = ep.exposure_min / 1440; return sg; });
    }
    if (!data.airmass) values.a2 = undefined;
    // detector columns and the systematics model built on them (regressors, kernel), rebuilt as the analyzer does
    if (L.columns) {
      data.columns = Object.fromEntries(Object.entries(L.columns).map(([nm, a]) => [nm, Float64Array.from(a, (x) => (x === null || x === undefined ? NaN : x))]));
      data = applyDetrend(data, L.detrend && (L.detrend.columns?.length || L.detrend.poly > 0 || L.detrend.pld?.length || L.detrend.kernel) ? L.detrend : null);
    }
  }
  const rv = u.rv ? (d.radial_velocity || []).map((r) => ({ name: r.name, t: Float64Array.from(r.time, (x) => x - tRef), v: f64(r.velocity), e: f64(r.velocity_err), ...(r.exposure_min > 0 ? { exptime: r.exposure_min / 1440 } : {}) })) : [];
  const groups = new Map();
  if (u.timing) for (const r of d.timing || []) {
    const i = Math.max(0, s.planets.findIndex((p) => p.letter === r.planet)), key = i + '|' + (r.kind || 'transit');
    if (!groups.has(key)) groups.set(key, { planet: sfx[i], kind: r.kind || 'transit', t: [], e: [] });
    groups.get(key).t.push(r.time - tRef); groups.get(key).e.push(r.err);
  }
  const exptime = data ? ((d.light_curve.exposure_min || 0) / 1440) : 0;
  let supersample = 1;
  if (exptime > 0) for (const sx of sfx) { try { supersample = Math.max(supersample, autoSupersample(exptime, planetValuesOf(values, sx, s.kepler))); } catch { /* invalid geometry is rejected by the likelihood */ } }
  // an epoch with its own exposure gets its own sub-sampling, whatever the light curve's overall setting
  if (data && data.segments) for (const sg of data.segments) if (sg.exptime > 0) { let n = 1; for (const sx of sfx) { try { n = Math.max(n, autoSupersample(sg.exptime, planetValuesOf(values, sx, s.kepler))); } catch { /* as above */ } } sg.supersample = n; }
  return {
    data, rv, timing: [...groups.values()], planets: sfx, kepler: !!s.kepler, values,
    ldLaw: ((l) => (l === 'squareroot' ? 'sqrt' : l))((s.limb_darkening && s.limb_darkening.law) || 'quadratic'),
    free: s.fit.free.map((f) => ({ key: f.key, label: f.label || f.key, unit: f.unit || '', prior: isTime(f.key) ? shiftPrior(f.prior, -tRef) : { ...f.prior } })),
    phase: s.phase || null,
    // optional blocks (docs/FORMAT.md): physical-viability priors (physical.js) and Rossiter–McLaughlin options (rm.js)
    physical: s.physical || null,
    rm: s.rm ? rmFromSession(s.rm) : null,
    nbody: s.nbody ? { ...s.nbody, epoch: Number.isFinite(s.nbody.epoch) ? s.nbody.epoch - tRef : undefined } : null,
    exptime, supersample, timingNoise: s.fit.timing_noise || 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6, ...(s.fit.sampler || {}) },
  };
}
/** The session's "rm" block in buildProblem's terms (exposure in minutes there, days here). */
function rmFromSession(r) {
  const o = { ...r };
  if (r.ld_law) o.ldLaw = r.ld_law === 'squareroot' ? 'sqrt' : r.ld_law;
  if (r.exposure_min > 0) o.exptime = r.exposure_min / 1440;
  delete o.ld_law; delete o.exposure_min;
  return o;
}
const shiftPrior = (p, dt) => (p.type === 'uniform' ? { ...p, a: p.a + dt, b: p.b + dt } : { ...p, a: p.a + dt });

/** One planet's plain { rprs, ars, inc, per, tmid, ecc, omega, mplanet } out of the flat table. */
export function planetValuesOf(values, sfx, kepler) {
  const o = {};
  for (const f of PLANET_FIELDS) { const k = planetKey(f, sfx); o[f] = values[k] !== undefined ? values[k] : values[f]; }
  // a period alias (aliases.js): P = palias / nalias
  { const n = values[planetKey('nalias', sfx)], sp = values[planetKey('palias', sfx)]; if (n >= 1 && sp > 0) o.per = sp / n; }
  if (kepler) o.ars = arsFromKepler(o.per, values.mstar, o.mplanet || 0, values.rstar);
  return o;
}

const quantiles = (a) => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); if (!x.length) return null; const m = x[x.length >> 1]; return { median: m, plus: x[Math.floor(0.8413 * (x.length - 1))] - m, minus: m - x[Math.floor(0.1587 * (x.length - 1))] }; };

/**
 * Posterior summary of a finished run, in the session's own terms (times absolute again):
 * { logZ, logZerr, information, ess, ncalls, converged, stop_reason, warnings,
 *   parameters: [{ key, label, unit, median, plus, minus, best }], derived: { key: { median, plus, minus } },
 *   best: { key: value }, chi2, chi2_parts, n_data, bic }
 * Derived quantities are those of the analyzer's system table, per planet ("K", "K@c", ...), from 600 posterior draws.
 * The stellar mass and radius are used as given (as fitted when they were free).
 */
export function summarizeFit(s, spec, res, { draws = 600, seed = 7 } = {}) {
  const tRef = s.time_reference || 0, d = res.ndim, n = res.n, keys = spec.free.map((f) => f.key), sfx = planetSuffixes(s);
  const col = (k) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = res.samples[i * d + k]; return a; };
  // omega is an angle: its summary is taken about the circular mean, so a posterior across the edge of the prior is one peak
  const angle = (key) => key.split('@')[0] === 'omega';
  const parameters = spec.free.map((f, k) => { let [lo, med, hi] = weightedQuantiles(col(k), res.weights, [0.1587, 0.5, 0.8413]); const off = isTime(f.key) ? tRef : 0; if (angle(f.key)) { const c = summarizeDraws(col(k), { period: 360, weights: res.weights, lo: f.prior && f.prior.type === 'uniform' && f.prior.b - f.prior.a <= 360 ? f.prior.a : -180 }); if (c) { med = c.med; lo = med - c.minus; hi = med + c.plus; } } return { key: f.key, label: f.label, unit: f.unit, median: med + off, plus: hi - med, minus: med - lo, best: res.maxPoint[k] + off }; });
  const acc = {}, push = (k, x) => { if (Number.isFinite(x)) (acc[k] = acc[k] || []).push(x); };
  for (const i of resampleIndices(res.weights, draws, makeRng(seed))) {
    const v = { ...spec.values }; keys.forEach((k, j) => (v[k] = res.samples[i * d + j]));
    const star = { ...(s.star || {}), mstar: v.mstar, rstar: v.rstar, teff: v.teff ?? (s.star || {}).teff };
    for (const sx of sfx) {
      const q = planetValuesOf(v, sx, s.kepler); let dq;
      try { dq = deriveSystem(q, { ...star, mplanet: q.mplanet > 0 ? q.mplanet : null }); } catch { continue; }
      for (const [k, x] of Object.entries(dq)) push(planetKey(k, sx), ['tmid', 'emid', 'tperi'].includes(k) ? x + tRef : x);
      if (q.mplanet >= 0) push(planetKey('mplanet', sx), q.mplanet);
    }
  }
  const sfxOf = (k) => (k.includes('@') ? '@' + k.split('@')[1] : ''), epoch = (k) => ['emid', 'tperi'].includes(k.split('@')[0]);
  const derived = {}; for (const k in acc) { derived[k] = quantiles(acc[k]); if (angle(k)) { const c = summarizeDraws(acc[k], { period: 360, lo: derived[k].median - 180 }); if (c) derived[k] = { median: c.med, plus: c.plus, minus: c.minus }; } }
  for (const k in acc) if (epoch(k)) { const tm = derived['tmid' + sfxOf(k)], pe = derived['per' + sfxOf(k)], c = summarizeEpoch(acc[k], k.split('@')[0], tm && tm.median, pe && pe.median); if (c) derived[k] = { median: c.med, plus: c.plus, minus: c.minus }; }
  const best = { ...spec.values }; keys.forEach((k, j) => (best[k] = res.maxPoint[j]));
  const prob = buildProblem({ ...spec, values: best, free: [] }), det = prob.detail([]);
  const bestOut = {}; for (const [k, x] of Object.entries(best)) if (Number.isFinite(x)) bestOut[k] = isTime(k) ? x + tRef : x;
  return {
    logZ: res.logZ, logZerr: res.logZerr, information: res.H, ess: res.ess, ncalls: res.ncalls, seconds: res.elapsed,
    converged: res.stopReason === 'converged', stop_reason: res.stopReason, warnings: res.warnings || [],
    parameters, derived, best: bestOut,
    chi2: det ? det.chi2 : null, chi2_parts: det ? { light_curve: det.chi2lc, radial_velocity: det.chi2rv, timing: det.chi2tim } : null,
    n_data: prob.ntotal, bic: det ? infoCriteria(det.chi2ic ?? det.chi2, keys.length + prob.nlinear, prob.ntotal).bic : null,
    rv_zero_points: det && det.rv ? det.rv.map((x, k) => ({ name: spec.rv[k].name, gamma: x.gamma, jitter: x.jitter })) : [],
  };
}

/**
 * Run a session's fit. Returns a copy of the session with `result` filled in (see summarizeFit), plus,
 * when keepSamples is true, result.samples = { keys, values: [[...], ...], weights: [...], logl: [...] }
 * with at most maxSamples equal-weight draws (times relative to time_reference, as sampled).
 */
export async function runSession(session, { onProgress = () => {}, shouldStop = () => false, keepSamples = false, maxSamples = 2000, use } = {}) {
  const spec = specFromSession(session, use);
  if (!spec.free.length) throw new Error('nothing is free: tick at least one parameter (fit.free)');
  const res = await runFit(spec, onProgress, shouldStop);
  const result = summarizeFit(session, spec, res);
  // a truncated prior (physical tests, positive maps) removes prior mass: record it so ln Z can be renormalised (ln Z - ln V)
  if (spec.physical || (spec.phase && spec.phase.positive_map)) {
    const vol = physicalPriorVolume(buildProblem(spec), { n: 20000 });
    result.prior_volume = { V: vol.V, lnV: vol.lnV, lnVerr: vol.lnVerr, draws: vol.n, rejected: vol.reasons, logZ_renormalised: res.logZ - vol.lnV };
  }
  if (keepSamples) {
    const idx = resampleIndices(res.weights, Math.min(maxSamples, Math.max(200, Math.round(res.ess || 1000))), makeRng(3));
    result.samples = { keys: spec.free.map((f) => f.key), values: Array.from(idx, (i) => Array.from({ length: res.ndim }, (_, k) => res.samples[i * res.ndim + k])), logl: Array.from(idx, (i) => res.logl[i]) };   // idx is a typed array: its own map() would coerce the rows to numbers
  }
  return { session: { ...session, result }, spec, res };
}

/** Names of the limb darkening coefficients of a session's law. */
export const ldNames = (s) => LD_LAWS[(s.limb_darkening && s.limb_darkening.law) || 'quadratic'].names;
