// The core as a service: what the Python package (python/esl) calls. No DOM, no Node API.
//
// tools/build_core_bundle.mjs bundles every module of src/core with this file into one script,
// python/esl/_core/esl_core.js, which defines globalThis.ESL = createApi(...). Python (an embedded V8, QuickJS or
// a Node subprocess) then talks to it in JSON:
//
//   ESL.call(name, argsJson)      -> '{"ok": value}' | '{"error": message}'       synchronous functions (`api` below)
//   ESL.start(name, argsJson)     -> job id                                       asynchronous ones (`jobs` below)
//   ESL.poll(id)                  -> '{"done", "progress": [...], "requests": [...], "result" | "error"}'
//   ESL.stop(id), ESL.resolve(requestId, json), ESL.reject(requestId, message)
//   ESL.invoke via call('invoke', [path, args]) reaches ANY export of ANY core module ("kepler.eventTimes"),
//   so a function added to the core is callable from Python after a rebuild, with no change here.
//
// The sampler loop runs here, inside one job (runSession -> runFit -> MiniNest); Python only polls. A job that
// needs a file (the catalogue) asks for it through `requests`, and the host answers with resolve().
//
// Numbers cross as JSON text. JSON.stringify writes the shortest decimal that reads back to the same double and
// Python's json does the same, so values are bit-identical on both sides; NaN and infinities arrive as null.
//
// Also here, because specFromSession leaves them to the application: limb darkening that follows the star
// (the equivalent of tieSpec / syncStarLD / gridFor in src/main.js), as pure functions of a session.

import { manualTimers, pumpTimers, timersPending } from './pyshim.js';
import { buildProblem, autoSupersample, infoCriteria, PARAM_BY_KEY, STAR_PARAMS, PLANET_FIELDS } from './model.js';
import { runFit } from './fitRunner.js';
import { validateSession, specFromSession, summarizeFit, runSession, planetSuffixes, FORMAT, FORMAT_VERSION } from './session.js';
import { makeTransit, transitModel } from './transit.js';
import { makeRV, semiAmplitude, arsFromKepler, massFromK } from './rv.js';
import { LD_LAWS, toClaret, checkProfile } from './limbdark.js';
import { FILTERS, greyProfile, fitLaw, interpLDGrid, gridFromTable, makeLDTie } from './ldest.js';
import { expandSpectral, bandTable } from './ldspec.js';
import { fitEphemeris, assignEpochs } from './ephemeris.js';
import { timingPeriodogram } from './periodogram.js';
import { deriveSystem } from './derive.js';
import { eventTimes } from './kepler.js';
import { loadIndex, lookupHost, searchNames, systemFromRows } from './catalog.js';
import { resampleIndices, makeRng } from './stats.js';
import { pythonScriptFor, markdownReportFor, latexTablesFor } from './exportScript.js';

const isTime = (key) => key.split('@')[0] === 'tmid';
const isTyped = (x) => ArrayBuffer.isView(x) && !(x instanceof DataView);

/** Anything -> plain JSON-able data: typed arrays become arrays, Maps objects, functions and cycles are dropped. */
export function plain(x, depth = 0, seen = new Set()) {
  if (x === null || x === undefined) return x ?? null;
  const t = typeof x;
  if (t === 'number' || t === 'string' || t === 'boolean') return x;
  if (t === 'function' || t === 'symbol') return undefined;
  if (t === 'bigint') return Number(x);
  if (isTyped(x)) return Array.from(x);
  if (depth > 40 || seen.has(x)) return undefined;
  if (x instanceof Promise) return undefined;
  seen.add(x);
  let out;
  if (Array.isArray(x)) out = x.map((v) => { const p = plain(v, depth + 1, seen); return p === undefined ? null : p; });
  else if (x instanceof Map) { out = {}; for (const [k, v] of x) { const p = plain(v, depth + 1, seen); if (p !== undefined) out[String(k)] = p; } }
  else if (x instanceof Set) out = [...x].map((v) => plain(v, depth + 1, seen));
  else if (x instanceof Date) out = x.toISOString();
  else if (x instanceof Error) out = { error: x.message };
  else { out = {}; for (const k of Object.keys(x)) { const p = plain(x[k], depth + 1, seen); if (p !== undefined) out[k] = p; } }
  seen.delete(x);
  return out;
}

// ---- limb darkening that follows the star (pure equivalents of main.js: bandRange, gridFor, gridFilter, ldFromStar, tieSpec)

const lawOf = (name) => (name === 'squareroot' ? 'sqrt' : name || 'quadratic');   // docs/FORMAT.md writes "squareroot", LD_LAWS has "sqrt"
const bandKey = (name) => { if (FILTERS[name]) return name; const n = String(name || '').toLowerCase(), hit = Object.keys(FILTERS).find((k) => k.toLowerCase() === n || k.toLowerCase().replace(' (approx.)', '') === n); return hit || null; };

/**
 * Where a session's limb darkening coefficients come from when they follow the star.
 * tables = { ld: the expanded 37-band table or null, spectral: the expanded wavelength-resolved table or null }
 * Returns { law, band (name), range: [nm, nm], custom: bool, grid (or null: grey atmosphere), filter, source: 'table' | 'spectral' | 'grey' }.
 */
export function ldSourceFor(session, tables, law = lawOf((session.limb_darkening || {}).law)) {
  const ld = session.limb_darkening || {}, name = ld.band || 'TESS (approx.)', custom = name === 'Custom range';
  const key = custom ? null : bandKey(name);
  if (!custom && !key) throw new Error(`limb darkening band "${name}" is not one of the bundled bands; use "Custom range" with band_custom: [nm, nm]`);
  const range = custom ? [Math.min(...ld.band_custom), Math.max(...ld.band_custom)] : FILTERS[key];
  if (custom && !(range[1] > range[0])) throw new Error('limb darkening: band_custom needs two wavelengths in nm');
  let grid = null, source = 'grey';
  if (law !== 'uniform') {
    if (custom) {
      if (tables.spectral) { let t = null; try { t = bandTable(tables.spectral, range); } catch { t = null; } if (t) { grid = gridFromTable(t, law); source = 'spectral'; } }
    } else if (tables.ld) {
      const g = gridFromTable(tables.ld, law);
      if (g.filters.length < 2 || g.filters.some((f) => f.toLowerCase() === key.toLowerCase())) { grid = g; source = 'table'; }
    }
  }
  const filter = grid ? (grid.filters.length > 1 ? (grid.filters.find((f) => f.toLowerCase() === String(key).toLowerCase()) || grid.filters[0]) : grid.filters[0]) : '';
  return { law, band: custom ? 'Custom range' : key, range, custom, grid, filter, source };
}

/** Coefficients a star implies: { coeffs, source, clamped, rms? }. star = { teff, logg, feh }. */
export function ldFromStar(src, star) {
  if (src.law === 'uniform') return { coeffs: [], source: 'uniform', clamped: false };
  if (src.grid) { const r = interpLDGrid(src.grid, star.teff, star.logg ?? 4.44, star.feh ?? 0, src.filter); return { coeffs: r.coeffs, source: src.source, clamped: !!r.clamped, method: r.method }; }
  const fit = fitLaw(src.law, greyProfile(star.teff, src.range[0], src.range[1]));
  return { coeffs: fit.coeffs, source: 'grey', clamped: false, rms: fit.rms };
}

/** True when a session's coefficients follow the star. */
export const followsStar = (session) => { const ld = session.limb_darkening; return !!ld && ld.mode === 'star' && lawOf(ld.law) !== 'uniform'; };

/**
 * A session ready for specFromSession: the law name normalised and, in "star" mode, the coefficients set to
 * what the star implies (they are not parameters there). Returns the same object when nothing changes.
 */
export function prepareSession(session, tables) {
  validateSession(session);
  const ld = session.limb_darkening;
  if (!ld) return session;
  const law = lawOf(ld.law);
  if (!LD_LAWS[law]) throw new Error(`unknown limb darkening law "${ld.law}" (one of ${Object.keys(LD_LAWS).join(', ')})`);
  if (!followsStar(session)) return law === ld.law ? session : { ...session, limb_darkening: { ...ld, law } };
  const st = session.star || {};
  if (!Number.isFinite(st.teff)) throw new Error('limb darkening follows the star: the session needs star.teff');
  const r = ldFromStar(ldSourceFor(session, tables, law), st);
  return { ...session, limb_darkening: { ...ld, law, coefficients: r.coeffs.slice() } };
}

/**
 * The `ldTie` entry of a fit specification for a session in "star" mode, or null. `free` is session.fit.free
 * (the range tabulated is the prior of teff and feh when they are free, a point otherwise), as tieSpec in main.js.
 */
export function ldTieForSession(session, tables, free = session.fit.free) {
  if (!followsStar(session)) return null;
  const st = session.star || {}, src = ldSourceFor(session, tables);
  const rng = (key, fallback) => {
    const f = free.find((x) => x.key === key); if (!f) return [fallback - 1e-3, fallback + 1e-3];
    return f.prior.type === 'normal' ? [f.prior.a - 6 * f.prior.b, f.prior.a + 6 * f.prior.b] : [f.prior.a, f.prior.b];
  };
  const tr = rng('teff', st.teff); tr[0] = Math.max(2300, tr[0]); tr[1] = Math.min(12000, tr[1]);
  return { law: src.law, source: src.grid ? 'grid' : 'grey', band: src.range, grid: src.grid, filter: src.filter, logg: st.logg ?? 4.44, teffRange: tr, fehRange: rng('feh', st.feh ?? 0) };
}

/**
 * Free parameters of a session that the parameter registry of model.js does not know. A model that is in the core
 * but not yet read by specFromSession / buildProblem (phase curves, moons, ...) shows up here: such a parameter is
 * sampled, but if the likelihood does not read it its posterior is just its prior.
 */
export function unregisteredFree(session) {
  const known = new Set([...Object.keys(PARAM_BY_KEY), ...STAR_PARAMS.map((p) => p.key), ...PLANET_FIELDS, 'ld0', 'ld1', 'ld2', 'ld3']);
  return ((session.fit && session.fit.free) || []).map((f) => f.key).filter((k) => !known.has(String(k).split('@')[0]));
}
const unregisteredWarning = (keys) => `${keys.join(', ')}: free, but not in the parameter registry of this build's session likelihood (src/core/model.js). If the likelihood does not read ${keys.length > 1 ? 'them' : 'it'}, the posterior of ${keys.length > 1 ? 'each is its' : 'it is the'} prior; the model that uses ${keys.length > 1 ? 'them' : 'it'} may be callable directly (esl.core.modules()).`;

// ---- the API ---------------------------------------------------------------------------------------------------

const SLIM = ['it', 'ncalls', 'logZ', 'remFrac', 'eff', 'mode', 'bestL', 'best', 'maxCalls', 'callsFrac', 'maxSeconds', 'nclusters', 'elapsed', 'keys'];
const slim = (p) => { const o = {}; for (const k of SLIM) if (p[k] !== undefined) o[k] = isTyped(p[k]) ? Array.from(p[k]) : p[k]; return o; };

/**
 * modules: { name: module namespace } for every file of src/core; tables: { ld }; stamp: { version, commit, sourceHash, ... }.
 */
export function createApi({ modules, tables = {}, stamp = {} }) {
  const T = { ld: tables.ld || null, spectral: null };
  const usesLC = (s, use) => { const u = { lc: true, ...((s.fit && s.fit.use) || {}), ...(use || {}) }; return !!(u.lc && s.data && s.data.light_curve); };
  const problems = new Map(); let nextProblem = 1;

  /** specification + limb darkening tie for a session; `at` overrides parameter values (session terms: tmid absolute). */
  function specOf(session, { use, at, free } = {}) {
    const s = prepareSession(session, T), spec = specFromSession(s, use), tRef = s.time_reference || 0;
    spec.ldTie = usesLC(s, use) ? ldTieForSession(s, T) : null;
    if (at) for (const [k, x] of Object.entries(at)) if (Number.isFinite(x)) spec.values[k] = isTime(k) ? x - tRef : x;
    if (free) spec.free = free;
    return { s, spec, tRef };
  }
  const resolvePath = (path) => {
    const [mod, ...rest] = String(path).split('.'); let f = modules[mod];
    if (!f) throw new Error(`no core module "${mod}" (modules: ${Object.keys(modules).join(', ')})`);
    for (const k of rest) { f = f == null ? undefined : f[k]; }
    if (f === undefined) throw new Error(`"${path}" is not exported by the core`);
    return f;
  };
  const transitArgs = (p) => {
    const ldLaw = lawOf(p.ldLaw || p.law || (p.ld ? { 0: 'uniform', 1: 'linear', 2: 'quadratic', 4: 'nonlinear' }[p.ld.length] : 'uniform'));
    if (!LD_LAWS[ldLaw]) throw new Error(`unknown limb darkening law "${ldLaw}"`);
    const q = { rprs: p.rprs, ars: p.ars, inc: p.inc, per: p.per, tmid: p.tmid, ecc: p.ecc || 0, omega: p.omega || 0, ldLaw, ld: p.ld || [] };
    if (!Number.isFinite(q.ars) && p.mstar > 0 && p.rstar > 0) q.ars = arsFromKepler(p.per, p.mstar, p.mplanet || 0, p.rstar);
    for (const k of ['rprs', 'ars', 'inc', 'per', 'tmid']) if (!Number.isFinite(q[k])) throw new Error(`transit: parameter "${k}" is missing` + (k === 'ars' ? ' (give ars, or mstar and rstar for Kepler\'s law)' : ''));
    if (q.ld.length !== LD_LAWS[ldLaw].names.length) throw new Error(`transit: the ${ldLaw} law takes ${LD_LAWS[ldLaw].names.length} coefficients, got ${q.ld.length}`);
    return q;
  };

  const api = {
    /** What this bundle is: version, commit, source hash, session format, modules and their exports, bands, laws. */
    info: () => ({ ...stamp, format: FORMAT, formatVersion: FORMAT_VERSION, modules: Object.fromEntries(Object.entries(modules).map(([k, m]) => [k, Object.keys(m).sort()])),
      api: Object.keys(api).sort(), jobs: Object.keys(jobs).sort(), bands: Object.keys(FILTERS), laws: Object.fromEntries(Object.entries(LD_LAWS).map(([k, v]) => [k, v.names])),
      tables: { ld: !!T.ld, spectral: !!T.spectral } }),

    /** Throws a readable error unless the document is a usable session. */
    validate: (session) => { prepareSession(session, T); return true; },

    /** Free parameters the session likelihood of this build has no registry entry for (see unregisteredFree). */
    unregisteredFree: (session) => unregisteredFree(session),

    /** True when the session needs the wavelength-resolved table (a custom band following the star) and it is not loaded. */
    needsSpectral: (session) => !T.spectral && !!session.limb_darkening && session.limb_darkening.band === 'Custom range' && followsStar(session),

    /**
     * The model and chi-square of a session at given parameter values (default: the session's own values).
     * at: { key: value } in session terms (tmid absolute), e.g. result.best. Returns
     * { lnL, chi2, chi2_parts, n_data, n_linear, bic (for the session's free list), keys, values (absolute times),
     *   light_curve: { time, flux, flux_err, epoch, model (a1 x airmass x transit), baseline, transit, transits: [per planet], a1: [per epoch] },
     *   radial_velocity: [{ name, time, velocity, velocity_err, gamma, jitter, chi2, model (planets + trend, without gamma), planets: [per planet] }],
     *   timing: [{ planet, kind, time, err, model, epoch }], planets: [resolved values, a/R* included, tmid absolute], limb_darkening: [...] }
     */
    evaluate(session, at, use) {
      const { s, spec, tRef } = specOf(session, { use, at }), nfree = spec.free.length;
      const prob = buildProblem({ ...spec, free: [] }), det = prob.detail([]);
      if (!det) throw new Error('the model is not valid at these values (an orbit inside the star, a negative radius or mass, or an unphysical limb darkening profile)');
      const abs = (a) => Array.from(a, (x) => x + tRef), d = s.data || {}, L = spec.data, sfx = planetSuffixes(s);
      const values = {}; for (const [k, x] of Object.entries(spec.values)) if (Number.isFinite(x)) values[k] = isTime(k) ? x + tRef : x;
      if (det.ld) det.ld.forEach((c, i) => (values['ld' + i] = c));
      const out = {
        lnL: det.lnL, chi2: det.chi2, chi2_parts: { light_curve: det.chi2lc, radial_velocity: det.chi2rv, timing: det.chi2tim },
        n_data: prob.ntotal, n_linear: prob.nlinear, bic: infoCriteria(det.chi2, nfree + prob.nlinear, prob.ntotal).bic, keys: spec.free.map((f) => f.key), values,
        light_curve: null, radial_velocity: [], timing: [],
        planets: det.planets.map((q, i) => ({ letter: s.planets[i].letter, ...q, tmid: q.tmid + tRef })),
        limb_darkening: Array.from({ length: LD_LAWS[spec.ldLaw].names.length }, (_, i) => values['ld' + i] ?? 0),
      };
      if (L) out.light_curve = { name: L.name, time: abs(L.t), flux: Array.from(L.f), flux_err: Array.from(L.e), airmass: L.airmass ? Array.from(L.airmass) : null, epoch: L.epoch ? Array.from(L.epoch) : null,
        epochs: (d.light_curve.epochs || []).map((e) => e.name), model: Array.from(det.base, (b, i) => b * det.transit[i]), baseline: Array.from(det.base), transit: Array.from(det.transit),
        transits: det.transits ? det.transits.map((a) => Array.from(a)) : [Array.from(det.transit)], a1: Array.from(det.a1s) };
      if (det.rv) out.radial_velocity = det.rv.map((r, k) => ({ name: spec.rv[k].name, time: abs(spec.rv[k].t), velocity: Array.from(spec.rv[k].v), velocity_err: Array.from(spec.rv[k].e),
        gamma: r.gamma, jitter: r.jitter, chi2: r.chi2, model: Array.from(r.model), planets: r.planets.map((a) => Array.from(a)) }));
      if (det.timing) out.timing = det.timing.map((x, k) => ({ planet: s.planets[Math.max(0, sfx.indexOf(x.planet))].letter, kind: x.kind, time: abs(spec.timing[k].t), err: Array.from(spec.timing[k].e), model: abs(x.model), epoch: Array.from(x.epoch) }));
      out.rv_tref = prob.rvTref === undefined ? null : prob.rvTref + tRef;
      return out;
    },

    /** Open a session's likelihood for repeated evaluation (your own sampler or optimiser). Returns { id, keys, ndim, n_data }. */
    problemOpen(session, use) {
      const { spec, tRef } = specOf(session, { use }), prob = buildProblem(spec), id = nextProblem++;
      problems.set(id, { prob, tRef, shift: spec.free.map((f) => (isTime(f.key) ? tRef : 0)) });
      return { id, keys: prob.keys, ndim: prob.ndim, n_data: prob.ntotal, n_linear: prob.nlinear };
    },
    /** ln L at n points: thetas is a flat array of n x ndim values in the order of `keys`, tmid absolute. Invalid points give -1e100. */
    problemLogLike(id, thetas, repeat = 1) {
      const P = problems.get(id); if (!P) throw new Error('no such problem (closed?)');
      const d = P.prob.ndim, n = d ? thetas.length / d : 1, out = new Array(n), th = new Float64Array(d);
      for (let r = 0; r < repeat; r++) for (let i = 0; i < n; i++) { for (let k = 0; k < d; k++) th[k] = thetas[i * d + k] - P.shift[k]; out[i] = P.prob.loglike(th); }
      return out;
    },
    /** Prior transform: unit-cube points (flat n x ndim) -> parameter values (tmid absolute). */
    problemTransform(id, cubes) {
      const P = problems.get(id); if (!P) throw new Error('no such problem (closed?)');
      const d = P.prob.ndim, n = cubes.length / d, out = new Array(n * d), u = new Float64Array(d), th = new Float64Array(d);
      for (let i = 0; i < n; i++) { for (let k = 0; k < d; k++) u[k] = cubes[i * d + k]; P.prob.transform(u, th); for (let k = 0; k < d; k++) out[i * d + k] = th[k] + P.shift[k]; }
      return out;
    },
    problemClose: (id) => problems.delete(id),

    /**
     * Transit light curve. params: { rprs, ars, inc, per, tmid, ecc, omega, ldLaw, ld: [...] } or a list of them (the product).
     * opts: { exptime (days), supersample (n or 'auto') }. Without ars, mstar and rstar give it by Kepler's law.
     */
    transit(times, params, opts = {}) {
      const list = (Array.isArray(params) ? params : [params]).map(transitArgs), ex = opts.exptime > 0 ? opts.exptime : 0;
      let ns = 1;
      if (ex > 0) ns = opts.supersample === 'auto' || opts.supersample === undefined ? Math.max(...list.map((q) => { try { return autoSupersample(ex, q); } catch { return 1; } })) : Math.max(1, opts.supersample | 0);
      if (list.length === 1) return Array.from(transitModel(times, list[0], null, { exptime: ex, supersample: ns }));
      const fs = list.map(makeTransit), dt = ex / ns;
      return Array.from(times, (t) => { let m = 0; for (let j = 0; j < ns; j++) { const tj = ns > 1 ? t + (j - (ns - 1) / 2) * dt : t; let pr = 1; for (const f of fs) pr *= f(tj); m += pr; } return m / ns; });
    },

    /**
     * Radial velocity of the star, m/s. params: { per, tmid, ecc, omega, K } or with mplanet, mstar, inc instead of K
     * (K from the two-body formula), or a list (the sum). opts: { rvlin, rvquad, tref }.
     */
    radialVelocity(times, params, opts = {}) {
      const fs = (Array.isArray(params) ? params : [params]).map((p) => {
        const K = Number.isFinite(p.K) ? p.K : semiAmplitude(p.per, p.ecc || 0, p.inc ?? 90, p.mplanet, p.mstar);
        if (!Number.isFinite(K)) throw new Error('radial velocity: give K, or mplanet, mstar and inc');
        return makeRV({ per: p.per, tmid: p.tmid, ecc: p.ecc || 0, omega: p.omega || 0, K });
      });
      const lin = opts.rvlin || 0, quad = opts.rvquad || 0, tref = opts.tref ?? (times.length ? Math.min(...times) : 0);
      return Array.from(times, (t) => { let v = lin * (t - tref) + quad * (t - tref) ** 2; for (const f of fs) v += f(t); return v; });
    },
    semiAmplitude: (p) => semiAmplitude(p.per, p.ecc || 0, p.inc ?? 90, p.mplanet, p.mstar),
    massFromK: (p) => massFromK(p.K, p.per, p.ecc || 0, p.inc ?? 90, p.mstar),

    /**
     * Limb darkening coefficients of a star in a band. star: { teff, logg, feh }; band: a name of `bands` or [nm, nm];
     * law: uniform | linear | quadratic | kipping | sqrt | nonlinear. Returns { coeffs, names, law, band, range, source
     * ('table' | 'spectral' | 'grey'), clamped, claret (the four Claret coefficients), physical }.
     */
    limbDarkening(star, band = 'TESS (approx.)', law = 'nonlinear') {
      const ld = Array.isArray(band) ? { band: 'Custom range', band_custom: band } : { band };
      const src = ldSourceFor({ limb_darkening: ld }, T, lawOf(law)), r = ldFromStar(src, star), claret = toClaret(src.law, r.coeffs);
      return { ...r, names: LD_LAWS[src.law].names, law: src.law, band: src.band, range: src.range, claret, physical: checkProfile(claret, 200).ok };
    },

    /**
     * Ephemeris from mid-transit times. opts: { epochs (else counted with `per` from tRef or the first time), per, tRef,
     * order: 1 | 2, predict: [epochs] }. Returns fitEphemeris's numbers plus epochs, residuals, maxFrac and predictions.
     */
    fitEphemeris(times, errs, opts = {}) {
      let epochs = opts.epochs, maxFrac = null;
      if (!epochs) { if (!(opts.per > 0)) throw new Error('fit_ephemeris: give the epochs, or a period to count orbits with'); const a = assignEpochs(times, opts.per, opts.tRef ?? times[0]); epochs = a.epochs; maxFrac = a.maxFrac; }
      const r = fitEphemeris(epochs, times, errs, opts.order || 1);
      return { ...plain(r), epochs: Array.from(epochs), maxFrac, residuals: Array.from(times, (_, i) => r.residual(i)), model: Array.from(epochs, (E) => r.model(E)),
        predictions: (opts.predict || []).map((E) => ({ epoch: E, ...r.predict(E) })) };
    },

    /** Lomb-Scargle search of timing residuals (timingPeriodogram), with the O - C curves of each model. Same options, plus epochs / per / tRef as fitEphemeris. */
    periodogram(times, errs, opts = {}) {
      let epochs = opts.epochs;
      if (!epochs) { if (!(opts.per > 0)) throw new Error('periodogram: give the epochs, or a period to count orbits with'); epochs = assignEpochs(times, opts.per, opts.tRef ?? times[0]).epochs; }
      const r = timingPeriodogram(epochs, times, errs, opts), out = plain(r);
      out.curves = r.models.map((m, i) => (m ? plain(r.curve(i)) : null));
      for (const m of out.models) if (m) delete m.fit;
      return out;
    },

    /** The system table (deriveSystem) and event times for one planet. params as transit; star: { rstar, mstar, teff, mplanet }. */
    derive: (params, star = {}) => plain(deriveSystem(params, { rstar: 1, mstar: 0, teff: NaN, ...star })),
    events: (params) => plain(eventTimes(params)),

    /** The same readers the analyzer uses. Times come back absolute. */
    parseLightCurve(text, name, opts) { const d = modules.data.parseLightCurve(text, name, opts || {}); return { ...plain(d), time: Array.from(d.t, (x) => x + (d.tRef || 0)) }; },
    parseRV: (text, name) => plain(modules.data.parseRV(text, name)),

    /** Text exports of a session (src/core/exportScript.js). */
    pythonScript: (session, opts) => pythonScriptFor(session, opts),
    markdownReport: (session, opts) => markdownReportFor(session, opts),
    latexTables: (session, opts) => latexTablesFor(session, opts),

    /** Call any export of any core module: invoke('kepler.eventTimes', [params]). Typed arrays come back as lists. */
    invoke(path, args = []) { const f = resolvePath(path); return typeof f === 'function' ? f(...args) : f; },
  };

  const jobs = {
    /**
     * Run a session's fit: runSession, with limb darkening tied to the star when the session asks for it.
     * opts: { keepSamples = true, maxSamples = 2000, use }. Resolves to the session with `result` filled in.
     */
    async run(ctx, session, opts = {}) {
      const s = prepareSession(session, T), tie = usesLC(s, opts.use) ? ldTieForSession(s, T) : null;
      const keepSamples = opts.keepSamples !== false, maxSamples = opts.maxSamples ?? 2000, onProgress = (p) => ctx.onProgress(slim(p));
      const software = { name: 'exoplanet-science-lab', version: stamp.version ?? null, commit: stamp.commit ?? null };
      const odd = unregisteredFree(s), flag = (result) => { if (odd.length) result.warnings = [unregisteredWarning(odd), ...(result.warnings || [])]; return result; };
      if (!tie) { const out = await runSession(s, { onProgress, shouldStop: ctx.shouldStop, keepSamples, maxSamples, use: opts.use }); return { ...out.session, software, result: flag(out.session.result) }; }
      // The same steps as runSession, with the tie that specFromSession leaves to the application.
      const spec = specFromSession(s, opts.use); spec.ldTie = tie;
      if (!spec.free.length) throw new Error('nothing is free: tick at least one parameter (fit.free)');
      const res = await runFit(spec, onProgress, ctx.shouldStop), result = summarizeFit(s, spec, res);
      const fn = makeLDTie(tie), o = [0, 0, 0, 0]; fn(result.best.teff ?? s.star.teff, result.best.feh ?? s.star.feh ?? 0, o);
      for (let i = 0; i < LD_LAWS[spec.ldLaw].names.length; i++) result.best['ld' + i] = o[i] || 0;
      if (keepSamples) {
        const idx = resampleIndices(res.weights, Math.min(maxSamples, Math.max(200, Math.round(res.ess || 1000))), makeRng(3));
        result.samples = { keys: spec.free.map((f) => f.key), values: idx.map((i) => Array.from({ length: res.ndim }, (_, k) => res.samples[i * res.ndim + k])), logl: idx.map((i) => res.logl[i]) };
      }
      return { ...s, software, result: flag(result) };
    },

    /**
     * Parameters of a planet or host from the catalogue snapshot. The host supplies the files: ctx.fetchJson(name)
     * for 'index.json' and the shards. opts: { use: 'transit' | 'rv' | 'ephemeris' | 'all', key: cache key of the snapshot }.
     * Returns { host, planet, snapshot, system: systemFromRows(...), session: a session with the values and suggested priors } or null.
     */
    async lookup(ctx, name, opts = {}) {
      const key = opts.key || 'default';
      if (!jobs.lookup.index.has(key)) jobs.lookup.index.set(key, await loadIndex(ctx.fetchJson));
      const index = jobs.lookup.index.get(key), L = await lookupHost(index, name, ctx.fetchJson);
      if (!L || !L.rows || !L.rows.length) return null;
      const rows = L.planet ? L.rows.filter((r) => r.pl_name === L.planet) : L.rows, use = opts.use || 'all';
      const system = systemFromRows(rows, { use });
      return { host: L.host, planet: L.planet, planets: L.planets, snapshot: L.snapshot || index.date, system: plain(system), session: sessionFromCatalog(system, L.snapshot || index.date) };
    },
    /** Names in the catalogue that match a query (autocomplete). */
    async search(ctx, query, opts = {}) {
      const key = opts.key || 'default';
      if (!jobs.lookup.index.has(key)) jobs.lookup.index.set(key, await loadIndex(ctx.fetchJson));
      return searchNames(jobs.lookup.index.get(key), query, opts.limit || 12);
    },
    /** Any export of any core module that returns a promise or takes a fetch function: the string "$fetchJson" in args is replaced by one. */
    async invoke(ctx, path, args = []) { const f = resolvePath(path); return f(...args.map((a) => (a === '$fetchJson' ? ctx.fetchJson : a))); },
  };
  jobs.lookup.index = new Map();

  /** A session (docs/FORMAT.md) from systemFromRows: values, their uncertainties as notes, suggested priors listed but nothing free. */
  function sessionFromCatalog(system, snapshot) {
    const val = (o, k) => (o && o[k] && Number.isFinite(o[k].value) ? o[k].value : undefined), err = (o, k) => (o && o[k] && Number.isFinite(o[k].err) ? o[k].err : undefined);
    const sv = (system.star && system.star.values) || (system.planets[0] && system.planets[0].values) || {}, star = {};
    for (const k of ['teff', 'logg', 'feh', 'rstar', 'mstar']) { if (val(sv, k) !== undefined) star[k] = val(sv, k); if (err(sv, k) !== undefined) star[k + 'Err'] = err(sv, k); }
    const planets = system.planets.filter(Boolean).map((p) => {
      const parameters = {}; for (const k of ['rprs', 'ars', 'inc', 'per', 'tmid', 'ecc', 'omega', 'mplanet', 'K']) if (val(p.values, k) !== undefined) parameters[k] = val(p.values, k);
      if (parameters.ecc === undefined) parameters.ecc = 0; if (parameters.omega === undefined) parameters.omega = 0;
      return { letter: / ([a-z])$/.test(p.planet) ? p.planet.slice(-1) : p.planet, name: p.planet, parameters, reference: p.reference ? p.reference.label : null,
        sources: Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, { err: v.err ?? null, source: v.source, kind: v.kind }])),
        suggested_priors: Object.fromEntries(Object.entries(p.priors || {}).map(([k, pr]) => [k, { type: pr.type, a: pr.a, b: pr.b }])) };
    });
    return { format: FORMAT, version: FORMAT_VERSION, software: { name: 'exoplanet-science-lab', version: stamp.version ?? null, commit: stamp.commit ?? null },
      name: system.host, title: `${system.host} from the NASA Exoplanet Archive snapshot of ${snapshot}`, notes: system.star ? system.star.how : '',
      star, limb_darkening: { law: 'quadratic', mode: 'star', band: 'TESS (approx.)', coefficients: [0.4, 0.25] }, planets, kepler: false,
      time_reference: planets.length && Number.isFinite(planets[0].parameters.tmid) ? Math.floor(planets[0].parameters.tmid) : 0,
      data: { light_curve: null, radial_velocity: [], timing: [] }, fit: { use: { lc: true, rv: true, timing: true }, free: [], fixed: {}, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6 } }, result: null };
  }

  // ---- transport ---------------------------------------------------------------------------------------------
  const running = new Map(), pending = new Map(); let nextJob = 1, nextReq = 1;
  const fail = (e) => JSON.stringify({ error: String((e && e.message) || e) });

  /** Run a job to completion on a host with an event loop. hooks: { onProgress(p), shouldStop(), fetchJson(name) }. */
  function runJob(name, args, hooks = {}) {
    if (!jobs[name]) return Promise.reject(new Error(`no such job "${name}" (jobs: ${Object.keys(jobs).join(', ')})`));
    const ctx = { onProgress: hooks.onProgress || (() => {}), shouldStop: hooks.shouldStop || (() => false), fetchJson: hooks.fetchJson || (() => Promise.reject(new Error('this host cannot fetch files'))) };
    return Promise.resolve().then(() => jobs[name](ctx, ...args)).then(plain);
  }

  return {
    stamp, api, jobs, runJob, plain,
    /** Synchronous call: name of an `api` function and its arguments as a JSON array. */
    call(name, argsJson) {
      try { if (!api[name]) throw new Error(`no such function "${name}" (see ESL.call("info", "[]"))`); const r = plain(api[name](...JSON.parse(argsJson || '[]'))); return JSON.stringify({ ok: r === undefined ? null : r }); } catch (e) { return fail(e); }
    },
    /** Start a job; poll it until done. For hosts without an event loop (timers are pumped inside poll). */
    start(name, argsJson) {
      const id = nextJob++, job = { progress: [], requests: [], done: false, stop: false, result: null, error: null };
      running.set(id, job);
      const fetchJson = (file) => new Promise((res, rej) => { const rid = nextReq++; pending.set(rid, { res, rej }); job.requests.push({ id: rid, name: file }); });
      let args; try { args = JSON.parse(argsJson || '[]'); } catch (e) { job.error = 'arguments are not JSON: ' + e.message; job.done = true; return id; }
      runJob(name, args, { onProgress: (p) => job.progress.push(p), shouldStop: () => job.stop, fetchJson }).then((r) => { job.result = r; job.done = true; }, (e) => { job.error = String((e && e.message) || e); job.done = true; });
      return id;
    },
    poll(id) {
      const job = running.get(id); if (!job) return fail('no such job');
      pumpTimers();
      const out = { done: job.done, progress: job.progress.splice(0), requests: job.requests.splice(0), waiting: timersPending() };
      if (job.done) { running.delete(id); if (job.error !== null) out.error = job.error; else out.result = job.result === undefined ? null : job.result; }
      return JSON.stringify(out);
    },
    stop(id) { const job = running.get(id); if (job) job.stop = true; return !!job; },
    resolve(rid, json) { const p = pending.get(rid); if (!p) return false; pending.delete(rid); try { p.res(JSON.parse(json)); } catch (e) { p.rej(e); } return true; },
    reject(rid, message) { const p = pending.get(rid); if (!p) return false; pending.delete(rid); p.rej(new Error(message)); return true; },
    manualTimers,
    /** Give the bundle the wavelength-resolved limb darkening table (python/esl/_core/esl_ld_spectral.js calls this). */
    registerSpectral(compact) { T.spectral = expandSpectral(compact); return true; },
  };
}
