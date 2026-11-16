// Parameter registry and likelihood construction shared by the UI, the
// worker and the tests.

import { makeTransit } from './transit.js';
import { LD_LAWS, toClaret, checkProfile } from './limbdark.js';
import { makeTransform } from './priors.js';
import { derived, orbitElements, eclipseTime } from './kepler.js';
import { makeRV, semiAmplitude, arsFromKepler } from './rv.js';
import { makePlanetMoonTransit, moonParamsFrom, moonSupersample, MOON_PARAMS, moonKey } from './exomoon.js';
import { makePhaseCurve, PHASE_PARAMS, PHASE_FIELDS, mapKeys } from './phasecurve.js';
import { dynamicalModel } from './nbody.js';
import { makeLDTie } from './ldest.js';

export const PARAMS = [
  { key: 'rprs',  label: 'Rp/R★',  unit: '',     min: 0.005, max: 0.3,  step: 0.0005, digits: 4, help: 'Planet-to-star radius ratio' },
  { key: 'ars',   label: 'a/R★',   unit: '',     min: 1.5,   max: 150,  step: 0.01,   digits: 3, help: 'Semi-major axis in stellar radii' },
  { key: 'inc',   label: 'i',      unit: '°',    min: 60,    max: 90,   step: 0.01,   digits: 3, help: 'Orbital inclination' },
  { key: 'per',   label: 'P',      unit: 'd',    min: 0.3,   max: 200,  step: 0.0001, digits: 6, help: 'Orbital period' },
  { key: 'tmid',  label: 'T mid',  unit: 'd',    min: -1e9,  max: 1e9,  step: 0.0001, digits: 5, help: 'Mid-transit time (same system as the data)' },
  { key: 'ecc',   label: 'e',      unit: '',     min: 0,     max: 0.95, step: 0.001,  digits: 4, help: 'Eccentricity' },
  { key: 'omega', label: 'ω',      unit: '°',    min: -180,  max: 360,  step: 0.1,    digits: 2, help: 'Argument of periastron' },
  { key: 'mplanet', label: 'Mp',   unit: 'M Jup', min: 0,    max: 80,   step: 0.0001, digits: 4, help: 'Planet mass. Sets the radial-velocity amplitude, and with Kepler\'s law the orbit size' },
  { key: 'ld0',   label: 'LD 1',   unit: '',     min: -1.5,  max: 1.5,  step: 0.001,  digits: 4, ld: 0 },
  { key: 'ld1',   label: 'LD 2',   unit: '',     min: -1.5,  max: 1.5,  step: 0.001,  digits: 4, ld: 1 },
  { key: 'ld2',   label: 'LD 3',   unit: '',     min: -1.5,  max: 1.5,  step: 0.001,  digits: 4, ld: 2 },
  { key: 'ld3',   label: 'LD 4',   unit: '',     min: -1.5,  max: 1.5,  step: 0.001,  digits: 4, ld: 3 },
  { key: 'a2',    label: 'airmass k', unit: '',  min: -0.5,  max: 0.5,  step: 0.0005, digits: 4, help: 'Extinction slope: baseline ∝ exp(k · airmass)' },
];
// Stellar parameters that can be sampled when limb darkening is tied to the star.
export const STAR_PARAMS = [
  { key: 'teff', label: 'T eff', unit: 'K', min: 2300, max: 12000, step: 1, digits: 0, star: true, help: 'Stellar effective temperature; limb darkening follows it' },
  { key: 'feh', label: '[Fe/H]', unit: 'dex', min: -3, max: 1, step: 0.01, digits: 2, star: true, help: 'Stellar metallicity; limb darkening follows it (needs a model-atmosphere table)' },
];

/**
 * Sub-samples per exposure needed to resolve ingress: none while the exposure is
 * short compared with ingress, otherwise an odd count giving steps under a third of it.
 */
export function autoSupersample(exptimeDays, values) {
  if (!(exptimeDays > 0)) return 1;
  const d = derived(values), tau = Math.max((d.t14 - d.t23) / 2, 1e-4);
  // Averaging n evenly spaced samples of a curve leaves an error of about (curvature) x (exposure / n)^2 / 24.
  // During ingress the flux changes by the depth over tau and its curvature is of order 4 depth / tau^2, so
  // n = (exposure / tau) sqrt(depth / (6 tol)) keeps the error near tol = 1 ppm. (The old rule of thumb left
  // up to 18 ppm for a hot Jupiter at 2 and 30 minute cadence.)
  const n = Math.ceil((exptimeDays / tau) * Math.sqrt(Math.max(d.depth, 1e-6) / 6e-6));
  if (n <= 1) return 1;
  return Math.min(41, n % 2 ? n : n + 1);
}

// Parameters of the star's motion and of each radial-velocity dataset, and the stellar mass and radius
// that turn periods and planet masses into orbit sizes when a/R* follows from Kepler's law.
export const RV_PARAMS = [
  { key: 'rvlin',  label: 'RV trend',     unit: 'm/s/d',  min: -10,   max: 10,   step: 0.0001, digits: 5, help: 'Linear drift of the star\'s velocity (an outer companion, activity cycle)' },
  { key: 'rvquad', label: 'RV curvature', unit: 'm/s/d²', min: -0.1,  max: 0.1,  step: 1e-6,   digits: 7, help: 'Quadratic term of the velocity drift' },
  { key: 'jit',    label: 'jitter',       unit: 'm/s',    min: 0,     max: 1000, step: 0.01,   digits: 2, help: 'Extra scatter added in quadrature to this instrument\'s error bars' },
];
export const MASS_PARAMS = [
  { key: 'mstar', label: 'M★', unit: 'M☉', min: 0.05, max: 5, step: 0.001, digits: 3, star: true, help: 'Stellar mass. With the period it fixes the semi-major axis' },
  { key: 'rstar', label: 'R★', unit: 'R☉', min: 0.05, max: 10, step: 0.001, digits: 3, star: true, help: 'Stellar radius. Turns the semi-major axis into a/R★' },
];

export const PARAM_BY_KEY = Object.fromEntries([...PARAMS, ...RV_PARAMS, ...MASS_PARAMS, ...MOON_PARAMS, ...PHASE_PARAMS].map((p) => [p.key, p]));
export { MOON_PARAMS, moonKey, PHASE_PARAMS, PHASE_FIELDS };
/** Which phase-curve parameters a planet has for a phase description { mode: 'harmonic' | 'map', lmax }. */
export function phaseKeysFor(ph = {}) {
  return ph.mode === 'map' ? ['fpfs', ...mapKeys(Math.min(3, Math.max(1, ph.lmax || 1))), 'ellip', 'beam'] : ['fpfs', 'contrast', 'hotspot', 'h2c', 'h2s', 'ellip', 'beam'];
}

/** Key of a planet-level parameter: the first planet (suffix '') is unscoped, others are "name@c". */
export const planetKey = (field, sfx) => (sfx ? field + '@' + sfx : field);
/** Key of the jitter of radial-velocity dataset d (0-based). */
export const jitterKey = (d) => 'jit@rv' + (d + 1);
/** Key of the airmass coefficient of epoch s (0-based) in a dataset with several epochs. */
export const epochKey = (s) => 'a2@' + (s + 1);
/** Registry entry for a key, including per-epoch keys such as "a2@3". */
export const paramFor = (key) => PARAM_BY_KEY[key.split('@')[0]];

/**
 * Which registry keys are active, and their display names. Every entry carries `group`
 * ('planet' | 'ld' | 'baseline' | 'rv' | 'star'), `base` (the unscoped registry key) and, for planets, `planet` (its suffix).
 * air: true/false for a single light curve, or one flag per epoch. With several epochs each
 *      epoch that has an airmass column gets its own coefficient, "a2@1", "a2@2", ...
 * opts.planets: [{ sfx, letter }], the first with sfx '' (plain keys); others get "per@c", ...
 * opts.kepler:  a/R* follows from Kepler's law, so `ars` is not a parameter and M*, R* are
 * opts.mass:    list the planet mass (needed with velocities or opts.kepler)
 * opts.rv:      names of the radial-velocity datasets; adds the trend terms and one jitter each
 * opts.moons:   suffixes of the planets that have a moon; adds that moon's radius, period, phase, mass ratio and tilt
 * opts.phase:   { [sfx]: { mode, lmax } } for the planets whose own light is modelled (eclipse, phase curve, map)
 */
export function activeParams(ldLaw, air, opts = {}) {
  const n = LD_LAWS[ldLaw].names.length, planets = opts.planets && opts.planets.length ? opts.planets : [{ sfx: '', letter: '' }], many = planets.length > 1;
  const out = [];
  for (const pl of planets) for (const p of PARAMS) {
    if (p.ld !== undefined || p.key === 'a2') continue;
    if (p.key === 'ars' && opts.kepler) continue;
    if (p.key === 'mplanet' && !(opts.mass || opts.kepler)) continue;
    out.push({ ...p, key: planetKey(p.key, pl.sfx), base: p.key, planet: pl.sfx, label: many ? `${p.label} · ${pl.letter}` : p.label, group: 'planet' });
  }
  // a moon belongs to its planet: its keys carry the planet's scope ("rmoon", "rmoon@c")
  for (const pl of planets) if ((opts.moons || []).includes(pl.sfx)) for (const p of MOON_PARAMS) { if (p.optional) continue; out.push({ ...p, key: moonKey(p.key, pl.sfx), base: p.key, planet: pl.sfx, label: many ? `${p.label} · ${pl.letter}` : p.label, group: 'moon' }); }
  // the planet's own light: its keys carry the planet's scope as well ("fpfs", "fpfs@c")
  for (const pl of planets) if (opts.phase && opts.phase[pl.sfx]) for (const k of phaseKeysFor(opts.phase[pl.sfx])) { const p = PARAM_BY_KEY[k]; out.push({ ...p, key: planetKey(k, pl.sfx), base: k, planet: pl.sfx, label: many ? `${p.label} · ${pl.letter}` : p.label, group: 'phase' }); }
  for (const p of PARAMS) if (p.ld !== undefined && p.ld < n) out.push({ ...p, base: p.key, label: LD_LAWS[ldLaw].names[p.ld], group: 'ld' });
  if (Array.isArray(air) && air.length > 1) air.forEach((has, s) => { if (has) out.push({ ...PARAM_BY_KEY.a2, key: epochKey(s), base: 'a2', label: `airmass k · epoch ${s + 1}`, epoch: s, group: 'baseline' }); });
  else if (Array.isArray(air) ? air[0] : air) out.push({ ...PARAM_BY_KEY.a2, base: 'a2', group: 'baseline' });
  if (opts.rv && opts.rv.length) {
    out.push({ ...PARAM_BY_KEY.rvlin, base: 'rvlin', group: 'rv' }, { ...PARAM_BY_KEY.rvquad, base: 'rvquad', group: 'rv' });
    opts.rv.forEach((name, d) => out.push({ ...PARAM_BY_KEY.jit, key: jitterKey(d), base: 'jit', label: `jitter · ${name}`, rv: d, group: 'rv' }));
  }
  if (opts.kepler) for (const p of MASS_PARAMS) out.push({ ...p, base: p.key, group: 'star' });
  return out;
}

/** values {rprs, ars, ..., ld0..ld3} -> params object for makeTransit */
export function toTransitParams(v, ldLaw) {
  const n = LD_LAWS[ldLaw].names.length;
  const ld = []; for (let i = 0; i < n; i++) ld.push(v['ld' + i]);
  return { rprs: v.rprs, ars: v.ars, inc: v.inc, per: v.per, tmid: v.tmid, ecc: v.ecc, omega: v.omega, ldLaw, ld };
}

/** Width of the uniform prior on the baseline normalisation a1 ~ U(0, A1_PRIOR_WIDTH). */
export const A1_PRIOR_WIDTH = 2;

/** Width of the uniform prior on each radial-velocity zero point, gamma ~ U(-W/2, W/2), in m/s. */
export const GAMMA_PRIOR_WIDTH = 2e5;
/** Planet-level fields that may carry a planet scope, e.g. "per@c". */
export const PLANET_FIELDS = ['rprs', 'ars', 'inc', 'per', 'tmid', 'ecc', 'omega', 'mplanet', 'K'];

/**
 * Build the likelihood for a fit specification.
 * spec = { data: {t, f, e, airmass?, epoch?, segments?} | null, values, ldLaw, free: [{key, prior}],
 *          exptime, supersample, ldTie,
 *          planets?: ['', 'c', ...], kepler?: bool, rv?: [{t, v, e}], rvTref?, timing?: [{planet, kind, t, e}], timingNoise? }
 *
 * Light curve:   flux = a1 * exp(a2 * airmass) * product over planets of transit_p(t)
 *
 * a1 enters linearly, so it is integrated out analytically instead of being
 * sampled (EXOTIC takes the median of data/model):
 *     int exp(-chi2(a1)/2) da1 = exp(-chi2_min/2) * sqrt(2 pi / sum(m^2/sigma^2))
 * divided by the prior width. lnL also carries the ln(sigma) normalisation, so
 * the evidence returned by the sampler is a properly normalised marginal
 * likelihood that can be compared between models fitted to the same data.
 *
 * Several epochs (nights, orbits, instruments observing the same star): data.epoch gives each
 * point's epoch index 0..n-1. The transits are shared; every epoch s has its own normalisation
 * a1_s and its own airmass coefficient, read from values["a2@" + (s+1)] and falling back to
 * values.a2 (a single light curve only ever reads values.a2). An epoch may carry its own
 * exposure (segments[s].exptime in days, segments[s].supersample). The likelihood is the
 * product over epochs, each with its a1 integrated out.
 *
 * Several planets: spec.planets lists key suffixes. The first planet is '' and reads the plain
 * keys (rprs, per, ...); planet 'c' reads "rprs@c", "per@c", ... and falls back to the plain key
 * for anything not given. Limb darkening belongs to the star and is shared.
 *
 * A planet's own light: when values has "fpfs" (or "fpfs@c"), that planet's curve is the transit, the eclipse and the
 * phase curve of phasecurve.js, with spec.phase = { mode: 'harmonic' | 'map', lmax, ltt, angle, positive_map }.
 * A planet with a moon: when values has "rmoon" (or "rmoon@c"), that planet's transit is the planet-moon model of
 * exomoon.js (the pair about its barycentre, the union of the two discs on the star). An unbound or overlapping
 * configuration is outside the prior.
 *
 * spec.kepler: a/R* of each planet is not a parameter but follows from Kepler's third law with
 * values.mstar [M Sun], values.rstar [R Sun] and the planet's mass, so photometry, velocities
 * and timing describe one orbit.
 *
 * Radial velocities: v = gamma_d + sum_p K_p [cos(omega + nu) + e cos omega] + rvlin (t - tref) + rvquad (t - tref)^2
 * with K_p from "K" when given, else from mplanet, mstar, P, e, i (rv.js). Each dataset d has its
 * own zero point gamma_d, integrated out analytically like a1, and its own jitter "jit@rv<d>"
 * added in quadrature to the errors (the normalisation term keeps it from growing freely).
 *
 * spec.nbody = { epoch, event, dt, stepsPerOrbit, integrator, exactSync, corrector }: the planets pull on each other. Mid-transit times and
 * radial velocities then come from an N-body integration (nbody.js) started from the planets' parameters, read as
 * osculating elements at `epoch` (same time system as tmid). Every planet needs a mass and the star its mass. With all
 * planet masses zero this is the Keplerian model. With nbody.linear each planet's simulated times are shifted and stretched
 * by a best-fitting straight line in epoch (profiled), so the T0 and period of a planet with times need not be sampled. Light curves and mid-eclipse times stay Keplerian (no photodynamics yet).
 *
 * Timing: mid-transit or mid-eclipse times of a planet, compared with tmid + E P (or the
 * superior conjunction + E P), E the nearest whole orbit; spec.timingNoise [d] is added in quadrature.
 */
export function buildProblem(spec) {
  const data = spec.data || null;
  const t = data ? data.t : [], f = data ? data.f : [], e = data ? data.e : [];
  const am = (data && data.airmass) || null, seg = (data && data.epoch) || null;
  const N = t.length;
  let nSeg = data ? 1 : 0; if (seg) for (let i = 0; i < N; i++) if (seg[i] >= nSeg) nSeg = seg[i] + 1;
  const kKeys = Array.from({ length: nSeg }, (_, s) => epochKey(s)), ks = new Float64Array(nSeg);
  const sdm = new Float64Array(nSeg), smm = new Float64Array(nSeg), sdd = new Float64Array(nSeg);
  const keys = spec.free.map((p) => p.key);
  const tf = spec.free.map((p) => makeTransform(p.prior));
  const v = { ...spec.values };
  // exposure averaging: one setting for the light curve, or one per epoch
  const segNs = new Int32Array(Math.max(nSeg, 1)), segDt = new Float64Array(Math.max(nSeg, 1));
  let anyNs = false;
  for (let s = 0; s < nSeg; s++) {
    const sg = data.segments && data.segments[s], ex = sg && sg.exptime !== undefined ? sg.exptime : spec.exptime, n = sg && sg.supersample !== undefined ? sg.supersample : spec.supersample;
    segNs[s] = ex > 0 ? Math.max(1, n | 0) : 1; segDt[s] = segNs[s] > 1 ? ex / segNs[s] : 0; if (segNs[s] > 1) anyNs = true;
  }
  const model = new Float64Array(N), w = new Float64Array(N);
  // limb darkening either sampled directly or computed from the sampled Teff / [Fe/H]
  const tie = spec.ldTie ? makeLDTie(spec.ldTie) : null, tieOut = [0, 0, 0, 0];
  let lnNorm = 0;
  for (let i = 0; i < N; i++) { w[i] = 1 / (e[i] * e[i]); lnNorm += Math.log(e[i] * e[i]); }
  lnNorm = -0.5 * (lnNorm + N * 1.8378770664093453) - nSeg * Math.log(A1_PRIOR_WIDTH);
  const BAD = -1e100;

  // ---- planets: which key each planet reads for each field
  const sfx = spec.planets && spec.planets.length ? spec.planets : [''], nPl = sfx.length;
  const has = (k) => spec.values[k] !== undefined || keys.includes(k);
  const names = sfx.map((s) => Object.fromEntries(PLANET_FIELDS.map((fld) => [fld, s && has(planetKey(fld, s)) ? planetKey(fld, s) : fld])));
  const pv = sfx.map(() => ({ rprs: 0, ars: 0, inc: 0, per: 0, tmid: 0, ecc: 0, omega: 0, mplanet: 0, K: undefined }));
  const fluxes = new Array(nPl), lcPl = nPl > 1 ? sfx.map(() => new Float64Array(N)) : null;
  // phase curves: a planet has one when its "fpfs" is defined; its keys are scoped like the moon's (never shared between planets)
  const phKeys = sfx.map((s) => Object.fromEntries(PHASE_FIELDS.map((k) => [k, planetKey(k, s)])));
  const sp = spec.phase || {}, phOpts = { ltt: !!sp.ltt && spec.values.rstar > 0, phase: sp.angle === 'time' ? 'time' : 'orbit', positiveMap: !!sp.positive_map };
  if (sp.mode) phOpts.map = sp.mode === 'map';

  // ---- radial velocities
  const rvs = spec.rv || [], nRv = rvs.length;
  let rvTref = spec.rvTref;
  if (rvTref === undefined && nRv) { rvTref = Infinity; for (const d of rvs) for (let i = 0; i < d.t.length; i++) if (d.t[i] < rvTref) rvTref = d.t[i]; }
  const jKeys = rvs.map((_, d) => jitterKey(d));
  const rvModel = rvs.map((d) => new Float64Array(d.t.length)), rvGamma = new Float64Array(nRv), rvChi = new Float64Array(nRv);
  const rvPl = rvs.map((d) => sfx.map(() => new Float64Array(d.t.length)));
  const rvFns = new Array(nPl);

  // ---- timing
  const tim = (spec.timing || []).map((x) => ({ ...x, p: Math.max(0, sfx.indexOf(x.planet || '')), model: new Float64Array(x.t.length), epoch: new Int32Array(x.t.length) }));
  const tNoise2 = (spec.timingNoise || 0) ** 2;
  const els = new Array(nPl);
  // ---- N-body: which timing sets and velocities the integration predicts
  const nb = spec.nbody || null, timDyn = nb ? tim.filter((x) => x.kind !== 'eclipse') : [];
  const dynReq = nb ? { timing: timDyn.map((x) => ({ planet: x.p, t: x.t })), rv: rvs.map((d) => ({ t: d.t })), event: nb.event || 'conjunction', dt: nb.dt, stepsPerOrbit: nb.stepsPerOrbit, integrator: nb.integrator, exactSync: nb.exactSync, corrector: nb.corrector } : null;
  let dyn = null;

  function evaluate(theta) {
    for (let i = 0; i < keys.length; i++) v[keys[i]] = theta[i];
    if (tie) { tie(v.teff, v.feh || 0, tieOut); for (let i = 0; i < 4; i++) v['ld' + i] = tieOut[i] || 0; }
    let ldArr = null, tp0 = null;
    for (let p = 0; p < nPl; p++) {
      const nm = names[p], q = pv[p];
      q.rprs = v[nm.rprs]; q.inc = v[nm.inc]; q.per = v[nm.per]; q.tmid = v[nm.tmid]; q.ecc = v[nm.ecc] || 0; q.omega = v[nm.omega] || 0; q.mplanet = v[nm.mplanet]; q.K = v[nm.K];
      q.ars = spec.kepler ? arsFromKepler(q.per, v.mstar, q.mplanet, v.rstar) : v[nm.ars];
      if (!(q.ecc >= 0 && q.ecc < 0.999) || !(q.per > 0)) return null;
      if ((data || spec.kepler) && !(q.ars * (1 - q.ecc) > 1)) return null;
      if (data && !(q.rprs > 0)) return null;
      if (q.mplanet < 0) return null;
      if (data) {
        const tp = toTransitParams({ ...q, ld0: v.ld0, ld1: v.ld1, ld2: v.ld2, ld3: v.ld3 }, spec.ldLaw);
        if (p === 0) {
          tp0 = tp;
          const prof = checkProfile(toClaret(tp.ldLaw, tp.ld), 24);
          if (!prof.ok) return null;                      // negative or limb-brightened profiles are outside the prior
        }
        const moon = moonParamsFrom(v, sfx[p], { mplanet: q.mplanet, mstar: v.mstar });
        if (v[phKeys[p].fpfs] !== undefined && v[phKeys[p].fpfs] !== null) {
          // the planet's own light: transit, eclipse and the phase curve between them (phasecurve.js)
          const pp = { ...tp, rstar: v.rstar }; for (const k of PHASE_FIELDS) { const x = v[phKeys[p][k]]; if (x !== undefined && x !== null) pp[k] = x; }
          if (pp.fpfs < 0) return null;
          const pc = makePhaseCurve(pp, phOpts); if (!pc.ok) return null; fluxes[p] = pc;
        } else if (moon) { const fm = makePlanetMoonTransit({ ...tp, ...moon }); if (!fm.ok) return null; fluxes[p] = fm; }
        else fluxes[p] = makeTransit(tp);
      }
      if (tim.length) els[p] = orbitElements(q);
      if (nRv) {
        const K = Number.isFinite(q.K) ? q.K : semiAmplitude(q.per, q.ecc, q.inc, q.mplanet || 0, v.mstar);
        if (!Number.isFinite(K)) return null;
        rvFns[p] = makeRV({ per: q.per, tmid: q.tmid, ecc: q.ecc, omega: q.omega, K });
      }
    }
    if (data) ldArr = tie ? tp0.ld.slice() : null;
    if (nb && (timDyn.length || nRv)) {
      dyn = dynamicalModel({ mstar: v.mstar, rstar: v.rstar, epoch: nb.epoch, planets: pv.map((q) => ({ per: q.per, tmid: q.tmid, ecc: q.ecc, omega: q.omega, inc: q.inc, mplanet: q.mplanet || 0 })) }, dynReq);
      if (!dyn.ok) return null;                           // unbound, a close encounter, or a planet that stopped transiting
    }

    let chi2 = 0, lnL = lnNorm, chi2lc = 0, chi2rv = 0, chi2tim = 0;
    // ---- light curve
    if (data) {
      for (let s = 0; s < nSeg; s++) { ks[s] = am ? (nSeg > 1 ? v[kKeys[s]] ?? v.a2 : v.a2) ?? 0 : 0; sdm[s] = 0; smm[s] = 0; sdd[s] = 0; }
      const f0 = fluxes[0];
      for (let i = 0; i < N; i++) {
        const s = seg ? seg[i] : 0, ns = anyNs ? segNs[s] : 1;
        let m;
        if (nPl === 1) {
          if (ns === 1) m = f0(t[i]);
          else { const dt = segDt[s]; m = 0; for (let j = 0; j < ns; j++) m += f0(t[i] + (j - (ns - 1) / 2) * dt); m /= ns; }
        } else if (ns === 1) {
          m = 1; for (let p = 0; p < nPl; p++) { const x = fluxes[p](t[i]); lcPl[p][i] = x; m *= x; }
        } else {
          // average the product over the exposure (transits may overlap); keep each planet's own average for plots
          const dt = segDt[s]; m = 0; for (let p = 0; p < nPl; p++) lcPl[p][i] = 0;
          for (let j = 0; j < ns; j++) { const tj = t[i] + (j - (ns - 1) / 2) * dt; let prod = 1; for (let p = 0; p < nPl; p++) { const x = fluxes[p](tj); lcPl[p][i] += x / ns; prod *= x; } m += prod; }
          m /= ns;
        }
        if (am) m *= Math.exp(ks[s] * am[i]);
        model[i] = m;
        sdm[s] += w[i] * f[i] * m; smm[s] += w[i] * m * m; sdd[s] += w[i] * f[i] * f[i];
      }
      for (let s = 0; s < nSeg; s++) {
        if (!(smm[s] > 0)) return null;                                   // an epoch with no points
        const c = Math.max(0, sdd[s] - sdm[s] * sdm[s] / smm[s]);         // chi2 of this epoch at its best a1
        chi2lc += c; lnL += -0.5 * c + 0.5 * Math.log(6.283185307179586 / smm[s]);
      }
    }
    // ---- radial velocities: zero point of each dataset integrated out, jitter in quadrature
    for (let d = 0; d < nRv; d++) {
      const D = rvs[d], n = D.t.length, mod = rvModel[d], lin = v.rvlin || 0, quad = v.rvquad || 0, jit = v[jKeys[d]] || 0;
      if (jit < 0) return null;
      let sw = 0, swr = 0, swrr = 0, lns = 0;
      for (let i = 0; i < n; i++) {
        const dt = D.t[i] - rvTref; let m = lin * dt + quad * dt * dt;
        for (let p = 0; p < nPl; p++) { const x = rvFns[p](D.t[i]); rvPl[d][p][i] = x; if (!dyn) m += x; }
        if (dyn) m += dyn.rv[d][i];                       // the star's reflex motion from the integration; rvPl keeps the Keplerian parts for plots
        mod[i] = m;
        const s2 = D.e[i] * D.e[i] + jit * jit, wi = 1 / s2, r = D.v[i] - m;
        sw += wi; swr += wi * r; swrr += wi * r * r; lns += Math.log(s2);
      }
      const c = Math.max(0, swrr - swr * swr / sw);
      rvGamma[d] = swr / sw; rvChi[d] = c; chi2rv += c;
      lnL += -0.5 * c - 0.5 * (lns + n * 1.8378770664093453) + 0.5 * Math.log(6.283185307179586 / sw) - Math.log(GAMMA_PRIOR_WIDTH);
    }
    // ---- timing
    for (const x of tim) {
      const el = els[x.p], t0 = x.kind === 'eclipse' ? eclipseTime(el) : el.tmid, dk = dyn ? timDyn.indexOf(x) : -1, dt = dk >= 0 ? dyn.timing[dk] : null;
      // nbody.linear: a straight line in epoch (a shift and a stretch of this planet's simulated times) is fitted to the
      // residuals by weighted least squares, so its own T0 and period need not be sampled. Profiled, not marginalised.
      let l0 = 0, l1 = 0, eM = 0;
      if (dt && nb.linear && x.t.length > 2) {
        let sw = 0, se = 0; for (let i = 0; i < x.t.length; i++) { const wi = 1 / (x.e[i] * x.e[i] + tNoise2); sw += wi; se += wi * dt.epoch[i]; }
        eM = se / sw; let a = 0, b = 0, c = 0, d = 0, g = 0;
        for (let i = 0; i < x.t.length; i++) { const wi = 1 / (x.e[i] * x.e[i] + tNoise2), Ei = dt.epoch[i] - eM, ri = x.t[i] - dt.model[i]; a += wi; b += wi * Ei; c += wi * Ei * Ei; d += wi * ri; g += wi * Ei * ri; }
        const det = a * c - b * b; if (det > 0) { l0 = (c * d - b * g) / det; l1 = (a * g - b * d) / det; }
      }
      for (let i = 0; i < x.t.length; i++) {
        const E = dt ? dt.epoch[i] : Math.round((x.t[i] - t0) / el.per), m = dt ? dt.model[i] + l0 + l1 * (E - eM) : t0 + E * el.per, s2 = x.e[i] * x.e[i] + tNoise2, r = x.t[i] - m;
        x.model[i] = m; x.epoch[i] = E;
        chi2tim += (r * r) / s2; lnL += -0.5 * (r * r) / s2 - 0.5 * (Math.log(s2) + 1.8378770664093453);
      }
    }
    chi2 = chi2lc + chi2rv + chi2tim;
    return { a1: nSeg ? sdm[0] / smm[0] : NaN, chi2, chi2lc, chi2rv, chi2tim, ld: ldArr, lnL };
  }
  /** Per-point pieces of the best-a1 model at the last evaluate(): baseline a1_s exp(k_s airmass) and the bare transit. */
  function pieces() {
    const a1s = Array.from(sdm, (x, s) => x / smm[s]), base = new Float64Array(N), tr = new Float64Array(N);
    for (let i = 0; i < N; i++) { const s = seg ? seg[i] : 0, ex = am ? Math.exp(ks[s] * am[i]) : 1; base[i] = a1s[s] * ex; tr[i] = model[i] / ex; }
    const out = { a1s, base, transit: tr };
    if (lcPl) out.transits = lcPl.map((a) => Float64Array.from(a));
    if (nRv) out.rv = rvs.map((_, d) => ({ gamma: rvGamma[d], chi2: rvChi[d], jitter: v[jKeys[d]] || 0, model: Float64Array.from(rvModel[d]), planets: rvPl[d].map((a) => Float64Array.from(a)) }));
    if (tim.length) out.timing = tim.map((x) => ({ planet: x.planet || '', kind: x.kind || 'transit', model: Float64Array.from(x.model), epoch: Int32Array.from(x.epoch) }));
    out.planets = pv.map((q) => ({ ...q }));
    return out;
  }

  return {
    ndim: keys.length, keys,
    transform(u, theta) { for (let i = 0; i < tf.length; i++) theta[i] = tf[i](u[i]); },
    loglike(theta) { const r = evaluate(theta); return r ? r.lnL : BAD; },
    ndata: N, nepochs: nSeg, nrv: nRv, rvTref,
    /** number of measurements of every kind, and of analytically integrated linear parameters (a1 per epoch, gamma per RV set) */
    ntotal: N + rvs.reduce((a, d) => a + d.t.length, 0) + tim.reduce((a, x) => a + x.t.length, 0), nlinear: nSeg + nRv,
    /**
     * model evaluated at theta (free params): { a1 (first epoch), a1s (every epoch), chi2 (+ chi2lc, chi2rv, chi2tim), lnL,
     * model (transit x airmass term), base (a1 x airmass term), transit, transits (per planet, when several),
     * rv: [{ gamma, chi2, jitter, model (without gamma), planets: [per-planet curves] }], timing: [{ model, epoch }],
     * planets: [resolved values incl. a/R*] } with per-point arrays copied
     */
    detail(theta) { const r = evaluate(theta); return r ? { ...r, model: Float64Array.from(model), ...pieces() } : null; },
    valuesAt(theta) { const o = { ...spec.values }; keys.forEach((k, i) => (o[k] = theta[i])); return o; },
  };
}

/** Information criteria with the correct sign conventions (chi2 = -2 lnL + const). */
export function infoCriteria(chi2, k, n) {
  return { bic: chi2 + k * Math.log(n), aic: chi2 + 2 * k, redChi2: chi2 / Math.max(1, n - k) };
}

export { derived };
