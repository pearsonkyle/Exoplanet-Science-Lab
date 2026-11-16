// Parameter registry and likelihood construction shared by the UI, the
// worker and the tests.

import { makeTransit } from './transit.js';
import { LD_LAWS, toClaret, checkProfile, prepareLD } from './limbdark.js';
import { makeTransform } from './priors.js';
import { derived, orbitElements, eclipseTime } from './kepler.js';
import { makeRV, semiAmplitude, arsFromKepler } from './rv.js';
import { makePlanetMoonTransit, moonParamsFrom, moonSupersample, MOON_PARAMS, moonKey } from './exomoon.js';
import { makePhaseCurve, PHASE_PARAMS, PHASE_FIELDS, mapKeys, lightTravelDelay } from './phasecurve.js';
import { dynamicalModel } from './nbody.js';
import { makeLDTie } from './ldest.js';
import { makeRM, ccfWidthTable } from './rm.js';
import { makePhysicalCheck } from './physical.js';

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

// Optional parameterisation of the eccentricity: when both are defined for a planet they replace its ecc and omega.
export const ECC_PARAMS = [
  { key: 'secosw', label: '√e cos ω', unit: '', min: -1, max: 1, step: 0.001, digits: 4, help: 'With √e sin ω: eccentricity and argument of periastron without the edge at e = 0 or the wrap in ω. Uniform priors on both are uniform in e and ω' },
  { key: 'sesinw', label: '√e sin ω', unit: '', min: -1, max: 1, step: 0.001, digits: 4, help: 'See √e cos ω' },
];
// Optional terms of the light curve: extra white noise (per epoch, "jitlc@2") and light of other stars in the aperture.
export const LC_PARAMS = [
  { key: 'jitlc', label: 'LC jitter', unit: 'ppm', min: 0, max: 1e5, step: 1, digits: 1, help: 'Extra white noise of the light curve, added in quadrature to its error bars (one per epoch when there are several)' },
  { key: 'dil', label: 'dilution', unit: '', min: 0, max: 20, step: 0.001, digits: 4, help: 'Flux of other stars in the aperture over the target\'s: observed = (model + d) / (1 + d), so depths shrink by 1 + d. TESS CROWDSAP = 1 / (1 + d)' },
];
// Rossiter–McLaughlin effect (rm.js): on when "vsini" is set; lambda is planet-scoped ("lambda@c") and falls back to the plain key.
export const RM_PARAMS = [
  { key: 'vsini', label: 'v sin i★', unit: 'km/s', min: 0, max: 300, step: 0.01, digits: 2, help: 'Projected rotation speed of the star at its equator. With velocities in transit it gives the Rossiter–McLaughlin anomaly' },
  { key: 'lambda', label: 'λ', unit: '°', min: -180, max: 180, step: 0.1, digits: 2, help: 'Sky-projected obliquity: angle from the projected orbit normal to the projected stellar spin (ellc convention). 0 aligned, 180 retrograde' },
];
// Period alias of a planet seen in a few widely spaced transits (aliases.js): P = palias / nalias, nalias a whole number
// with a categorical prior over the aliases the data allow. Planet-scoped ("nalias@d"); on when nalias has a value or is free.
export const ALIAS_PARAMS = [
  { key: 'palias', label: 'P × N', unit: 'd', min: 0.3, max: 1e5, step: 0.0001, digits: 5, help: 'Time spanned by a whole number N of orbits (e.g. between the first and last transit seen). The period is this over N' },
  { key: 'nalias', label: 'N alias', unit: '', min: 1, max: 1000, step: 1, digits: 0, help: 'Number of orbits in P × N: which alias of the period. Give it a categorical prior over the allowed values (aliasScan)' },
];
export const PARAM_BY_KEY = Object.fromEntries([...PARAMS, ...ECC_PARAMS, ...RV_PARAMS, ...MASS_PARAMS, ...LC_PARAMS, ...RM_PARAMS, ...ALIAS_PARAMS, ...MOON_PARAMS, ...PHASE_PARAMS].map((p) => [p.key, p]));
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
/** Key of the light-curve jitter of epoch s (0-based) of nSeg epochs: "jitlc" for a single light curve, else "jitlc@<s+1>". */
export const lcJitterKey = (s, nSeg) => (nSeg > 1 ? 'jitlc@' + (s + 1) : 'jitlc');
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
 * opts.lcJitter: light-curve jitter, "jitlc" (or one per epoch, "jitlc@1", ...)   opts.dilution: one shared "dil"
 * opts.rm:      Rossiter–McLaughlin: "vsini" and each planet's "lambda" (group 'rv')
 * opts.alias:   suffixes of the planets whose period is an alias, palias / nalias: those two replace "per"
 */
export function activeParams(ldLaw, air, opts = {}) {
  const n = LD_LAWS[ldLaw].names.length, planets = opts.planets && opts.planets.length ? opts.planets : [{ sfx: '', letter: '' }], many = planets.length > 1;
  const out = [];
  for (const pl of planets) for (const p of PARAMS) {
    if (p.ld !== undefined || p.key === 'a2') continue;
    if (p.key === 'ars' && opts.kepler) continue;
    if (p.key === 'mplanet' && !(opts.mass || opts.kepler)) continue;
    if (p.key === 'per' && (opts.alias || []).includes(pl.sfx)) { for (const a of ALIAS_PARAMS) out.push({ ...a, key: planetKey(a.key, pl.sfx), base: a.key, planet: pl.sfx, label: many ? `${a.label} · ${pl.letter}` : a.label, group: 'planet' }); continue; }
    out.push({ ...p, key: planetKey(p.key, pl.sfx), base: p.key, planet: pl.sfx, label: many ? `${p.label} · ${pl.letter}` : p.label, group: 'planet' });
  }
  // a moon belongs to its planet: its keys carry the planet's scope ("rmoon", "rmoon@c")
  for (const pl of planets) if ((opts.moons || []).includes(pl.sfx)) for (const p of MOON_PARAMS) { if (p.optional) continue; out.push({ ...p, key: moonKey(p.key, pl.sfx), base: p.key, planet: pl.sfx, label: many ? `${p.label} · ${pl.letter}` : p.label, group: 'moon' }); }
  // the planet's own light: its keys carry the planet's scope as well ("fpfs", "fpfs@c")
  for (const pl of planets) if (opts.phase && opts.phase[pl.sfx]) for (const k of phaseKeysFor(opts.phase[pl.sfx])) { const p = PARAM_BY_KEY[k]; out.push({ ...p, key: planetKey(k, pl.sfx), base: k, planet: pl.sfx, label: many ? `${p.label} · ${pl.letter}` : p.label, group: 'phase' }); }
  for (const p of PARAMS) if (p.ld !== undefined && p.ld < n) out.push({ ...p, base: p.key, label: LD_LAWS[ldLaw].names[p.ld], group: 'ld' });
  if (Array.isArray(air) && air.length > 1) air.forEach((has, s) => { if (has) out.push({ ...PARAM_BY_KEY.a2, key: epochKey(s), base: 'a2', label: `airmass k · epoch ${s + 1}`, epoch: s, group: 'baseline' }); });
  else if (Array.isArray(air) ? air[0] : air) out.push({ ...PARAM_BY_KEY.a2, base: 'a2', group: 'baseline' });
  if (opts.lcJitter) {
    if (Array.isArray(air) && air.length > 1) air.forEach((_, s) => out.push({ ...PARAM_BY_KEY.jitlc, key: lcJitterKey(s, air.length), base: 'jitlc', label: `LC jitter · epoch ${s + 1}`, epoch: s, group: 'baseline' }));
    else out.push({ ...PARAM_BY_KEY.jitlc, base: 'jitlc', group: 'baseline' });
  }
  if (opts.dilution) out.push({ ...PARAM_BY_KEY.dil, base: 'dil', group: 'baseline' });
  if (opts.rv && opts.rv.length) {
    out.push({ ...PARAM_BY_KEY.rvlin, base: 'rvlin', group: 'rv' }, { ...PARAM_BY_KEY.rvquad, base: 'rvquad', group: 'rv' });
    opts.rv.forEach((name, d) => out.push({ ...PARAM_BY_KEY.jit, key: jitterKey(d), base: 'jit', label: `jitter · ${name}`, rv: d, group: 'rv' }));
  }
  if (opts.rm) {
    out.push({ ...PARAM_BY_KEY.vsini, base: 'vsini', group: 'rv' });
    for (const pl of planets) out.push({ ...PARAM_BY_KEY.lambda, key: planetKey('lambda', pl.sfx), base: 'lambda', planet: pl.sfx, label: many ? `${PARAM_BY_KEY.lambda.label} · ${pl.letter}` : PARAM_BY_KEY.lambda.label, group: 'rv' });
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

/** Width of the uniform prior on each coefficient of a linear regressor (data.regressors), c ~ U(-W/2, W/2). */
export const REG_PRIOR_WIDTH = 2;

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
 * Linear regressors (systematics): data.regressors = [x_1, x_2, ...], each one value per point (time for a visit-long
 * slope, time squared, a centroid, ...), centred and scaled to order one within each epoch by the caller. The baseline
 * of epoch s is then  exp(a2 airmass) * (a1_s + sum_k c_sk x_k):  every epoch has its own coefficients, and because they
 * enter linearly like a1 they are integrated out together with it,
 *     int exp(-chi2/2) d^p beta = exp(-chi2_min/2) * sqrt((2 pi)^p / det A),   A = G^T W G,  G = model x [1, x_1, ...],
 * each c with the flat prior U(-REG_PRIOR_WIDTH/2, REG_PRIOR_WIDTH/2). Regressors that are collinear within an epoch
 * (a constant column, two copies) make A singular and the point is rejected.
 *
 * Nearest-neighbour kernel regression (systematics as a function of detector state): data.kernel = gaussianWeights(...)
 * from detrend.js ({ idx, w, k, n }, the k neighbours of every point in a feature space and their Gaussian weights). At
 * every evaluation the model m_i (transits x airmass term) is multiplied by S_i = sum_q w_iq f_j / m_j over the
 * neighbours j of i (EXOTIC's lc_fitter with features, Knutson et al. 2012, Lewis et al. 2013); a1 (and any regressors)
 * are then integrated out as before, with a1 close to 1 because S carries the normalisation. S depends on the data, so
 * the "likelihood" is the usual Gaussian one of these papers, not a generative model; its evidence is not comparable
 * with a fit without the kernel.
 *
 * Light-curve jitter: values.jitlc [ppm] (several epochs: "jitlc@<s+1>", falling back to jitlc) is white noise added in
 * quadrature, sigma_i^2 = e_i^2 + jit_s^2. The weights and the normalisation -1/2 sum ln(2 pi sigma_i^2) then change with
 * it, which is what keeps it from growing freely; chi2ic adds sum ln(sigma_i^2 / e_i^2) as for the velocity jitter.
 *
 * Dilution (third light): values.dil = d, the flux of other stars in the aperture over the target's (several epochs:
 * "dil@<s+1>", falling back to dil). The astrophysical model m (transits, the planets' own light, a moon) is replaced by
 *     (m + d) / (1 + d)
 * before the airmass term, the regressors and the kernel: out of transit it is still 1 and every depth is divided by
 * 1 + d. In the other common convention, the fraction D of the light in the aperture that is not the target's
 * (1 - CROWDSAP for TESS), d = D / (1 - D).
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
 * Rossiter–McLaughlin: when values.vsini [km/s] is set, every planet in front of the star adds the anomaly of rm.js
 * (flux-weighted velocity of the uncovered disc, integrated over the occulted area) with its projected obliquity
 * "lambda" (planet-scoped, falling back to the plain key, default 0) and its Rp/R*. Limb darkening is the fit's
 * (ld0..ld3 with spec.ldLaw) unless spec.rm = { ldLaw, ld } gives the spectrograph's band. With spec.nbody the anomaly
 * uses the Keplerian sky positions. Options of spec.rm (all off by default):
 *   method: 'ccf' with beta (km/s, dispersion of the local line: instrumental + thermal), zeta (km/s, macroturbulence,
 *           Gaussian approximation), beta0 (km/s, the measured out-of-transit CCF width; modelled when absent): the anomaly
 *           a Gaussian fit to the cross-correlation function measures (Hirano et al. 2010, Boué et al. 2013) instead of
 *           the first moment of the light;
 *   exptime (days; or each dataset's rv[d].exptime) and supersample (default 5): the anomaly averaged over the exposure
 *           (the Keplerian part is not averaged: its curvature over minutes is negligible).
 * A catalogue v sin i enters as an ordinary prior on "vsini" (rm.js vsiniPrior: normal truncated at 0).
 *
 * spec.nbody = { epoch, event, dt, stepsPerOrbit, integrator, exactSync, corrector, photo, ltt, elements, linear }: the planets pull on
 * each other. Mid-transit and mid-eclipse times, radial velocities and the light curve then come from one N-body integration
 * (nbody.js) started from the planets' parameters, read as osculating elements at `epoch` (same time system as tmid). Every
 * planet needs a mass and the star its mass. With all planet masses zero this is the Keplerian model.
 *   Light curve (photodynamics; nbody.photo: false keeps Keplerian curves): each planet's sky position relative to the star is
 *   interpolated from the integration and passed to the transit kernel of transit.js, through the same exposure averaging.
 *   Needs R*: values.rstar, or without spec.kepler the first planet's orbit size divided by its a/R* (the other planets' a/R*
 *   are then not used). Planets are treated one at a time (the area two planets share on the disc is counted twice); a planet
 *   with its own light (fpfs) or a moon keeps its Keplerian curve.
 *   nbody.ltt: light-travel time across the system, referred to the plane through the barycentre: a transit is seen about
 *   a/c earlier than the geometric one and an eclipse a/c later (light curve and times alike).
 *   nbody.elements: 'mean' reads each planet's per and tmid as the straight line through its simulated mid-transit times over
 *   the span of the data (the observed ephemeris) and finds the osculating values by iteration (osculatingFromMean in nbody.js);
 *   these are nearly uncorrelated with the companions' parameters, so they can be sampled.
 *   nbody.linear: each planet's simulated times are shifted and stretched by a best-fitting straight line in epoch (profiled),
 *   so the T0 and period of a planet with times need not be sampled. Times only: leave it off when a light curve is in the fit.
 *
 * Timing: mid-transit or mid-eclipse times of a planet, compared with tmid + E P (or the
 * superior conjunction + E P), E the nearest whole orbit; spec.timingNoise [d] is added in quadrature.
 */
export function buildProblem(spec) {
  const data = spec.data || null;
  const t = data ? data.t : [], f = data ? data.f : [], e = data ? data.e : [];
  const am = (data && data.airmass) || null, seg = (data && data.epoch) || null;
  const reg = data && data.regressors && data.regressors.length ? data.regressors : null, nReg = reg ? reg.length : 0, nLin = nReg + 1;
  const N = t.length;
  // nearest-neighbour kernel regression (detrend.js gaussianWeights): neighbours and weights of every point
  const kern = data && data.kernel && data.kernel.n === N ? data.kernel : null, kRes = kern ? new Float64Array(N) : null, kS = kern ? new Float64Array(N).fill(1) : null;
  let nSeg = data ? 1 : 0; if (seg) for (let i = 0; i < N; i++) if (seg[i] >= nSeg) nSeg = seg[i] + 1;
  const kKeys = Array.from({ length: nSeg }, (_, s) => epochKey(s)), ks = new Float64Array(nSeg);
  const sdm = new Float64Array(nSeg), smm = new Float64Array(nSeg), sdd = new Float64Array(nSeg);
  // linear regressors: normal equations of every epoch (A, b), their solution (a1, c_1, ...) and a row of basis values
  const regA = reg ? new Float64Array(nSeg * nLin * nLin) : null, regB = reg ? new Float64Array(nSeg * nLin) : null, regC = reg ? new Float64Array(nSeg * nLin) : null, regG = reg ? new Float64Array(nLin) : null;
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
  lnNorm = -0.5 * (lnNorm + N * 1.8378770664093453) - nSeg * Math.log(A1_PRIOR_WIDTH) - nSeg * nReg * Math.log(REG_PRIOR_WIDTH);
  const BAD = -1e100;
  // optional light-curve terms, on when a key of that name (plain or per epoch) has a value or is free
  const named = (base) => keys.some((k) => k.split('@')[0] === base) || Object.keys(spec.values).some((k) => k.split('@')[0] === base && Number.isFinite(spec.values[k]));
  const lcJit = !!data && N > 0 && named('jitlc'), lcDil = !!data && N > 0 && named('dil');
  const jlKeys = Array.from({ length: nSeg }, (_, s) => lcJitterKey(s, nSeg)), dlKeys = Array.from({ length: nSeg }, (_, s) => (nSeg > 1 ? 'dil@' + (s + 1) : 'dil'));
  const js2 = new Float64Array(nSeg), dls = new Float64Array(nSeg), e2 = lcJit ? Float64Array.from(e, (x) => x * x) : null;
  // Rossiter–McLaughlin anomaly in the velocities
  const rmOn = (spec.rv || []).length > 0 && named('vsini');

  // ---- planets: which key each planet reads for each field
  const sfx = spec.planets && spec.planets.length ? spec.planets : [''], nPl = sfx.length;
  const has = (k) => spec.values[k] !== undefined || keys.includes(k);
  const names = sfx.map((s) => Object.fromEntries(PLANET_FIELDS.map((fld) => [fld, s && has(planetKey(fld, s)) ? planetKey(fld, s) : fld])));
  const pv = sfx.map(() => ({ rprs: 0, ars: 0, inc: 0, per: 0, tmid: 0, ecc: 0, omega: 0, mplanet: 0, K: undefined }));
  // period aliases: a planet whose "nalias" (planet-scoped) is set or free has P = palias / nalias
  const aliasKeys = sfx.map((s) => ({ n: planetKey('nalias', s), span: planetKey('palias', s) }));
  const aliasOn = aliasKeys.map((k) => has(k.n));
  aliasKeys.forEach((k, p) => { if (aliasOn[p] && !has(k.span)) throw new Error(`period alias of planet ${sfx[p] || 'b'}: "${k.n}" needs "${k.span}" (the time spanned by the transits)`); });
  // physical-viability priors (physical.js), all off unless spec.physical switches them on
  const physCheck = makePhysicalCheck(spec.physical), physOpt = physCheck ? physCheck.options : null;
  if (physOpt && (physOpt.hill || physOpt.hillSpacing || physOpt.megno) && nPl > 1 && !has('mstar')) throw new Error('physical.hill / hillSpacing / megno need the stellar mass (mstar)');
  if (physOpt && physOpt.roche && !spec.kepler && !(spec.values.rstar > 0 && has('mstar')) && !sfx.every((s, p) => has(names[p].ars))) throw new Error('physical.roche needs a/R* of every planet (ars, spec.kepler, or mstar and rstar)');
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
  const rvFns = new Array(nPl), rmFns = new Array(nPl).fill(null), rvRM = rmOn ? rvs.map((d) => new Float64Array(d.t.length)) : null;
  const rmLd = rmOn && spec.rm && spec.rm.ld ? toClaret(spec.rm.ldLaw || 'nonlinear', spec.rm.ld) : null;
  // what a Gaussian fit to the CCF measures (rm.js, method 'ccf'): beta0 tabulated against v sin i for the RM limb darkening
  // (the spectrograph's band when spec.rm.ld is given, else the fit's at the start values)
  const rmSpec = spec.rm || {}, rmCCF = rmOn && rmSpec.method === 'ccf';
  if (rmCCF && !(rmSpec.beta > 0)) throw new Error("spec.rm.method 'ccf' needs spec.rm.beta (km/s), the dispersion of the local line profile");
  const rmTable = rmCCF && !(rmSpec.beta0 > 0) ? ccfWidthTable(prepareLD(rmLd || toClaret(spec.ldLaw, [spec.values.ld0 || 0, spec.values.ld1 || 0, spec.values.ld2 || 0, spec.values.ld3 || 0]))) : null;
  // exposure averaging of the anomaly: each dataset's own exposure (rv[d].exptime, days) or spec.rm.exptime
  const rmExp = rvs.map((d) => (d.exptime > 0 ? d.exptime : rmSpec.exptime > 0 ? rmSpec.exptime : 0)), rmNs = Math.max(1, (rmSpec.supersample ?? 5) | 0);

  // ---- timing
  const tim = (spec.timing || []).map((x) => ({ ...x, p: Math.max(0, sfx.indexOf(x.planet || '')), model: new Float64Array(x.t.length), epoch: new Int32Array(x.t.length) }));
  const tNoise2 = (spec.timingNoise || 0) ** 2;
  const els = new Array(nPl);
  // ---- N-body: which timing sets and velocities the integration predicts
  const nb = spec.nbody || null, timDyn = nb ? tim : [];
  // photodynamics: with a light curve in the fit, the planets' sky positions come from the integration as well
  // (nbody.photo: false keeps the Keplerian curves). lcReq.pad is the half exposure reached by the sub-samples.
  const nbPhoto = !!(nb && data && N > 0 && nb.photo !== false), tps = new Array(nPl);
  let lcReq = null;
  if (nbPhoto) { let pad = 0; for (let s = 0; s < nSeg; s++) pad = Math.max(pad, 0.5 * segNs[s] * segDt[s]); lcReq = { t: Float64Array.from(t).sort(), sorted: true, pad }; }
  const dynReq = nb ? { timing: timDyn.map((x) => ({ planet: x.p, t: x.t, kind: x.kind })), rv: rvs.map((d) => ({ t: d.t })), lc: lcReq, ltt: !!nb.ltt, elements: nb.elements, warm: {}, photoStep: nb.photoStep, nodesPerOrbit: nb.nodesPerOrbit,
    event: nb.event || 'conjunction', dt: nb.dt, stepsPerOrbit: nb.stepsPerOrbit, integrator: nb.integrator, exactSync: nb.exactSync, corrector: nb.corrector } : null;
  let dyn = null;

  // each planet's resolved parameters (pv) from the current values v, with the checks every model shares; false outside the prior
  function resolvePlanets() {
    for (let p = 0; p < nPl; p++) {
      const nm = names[p], q = pv[p];
      q.rprs = v[nm.rprs]; q.inc = v[nm.inc]; q.per = v[nm.per]; q.tmid = v[nm.tmid]; q.ecc = v[nm.ecc] || 0; q.omega = v[nm.omega] || 0; q.mplanet = v[nm.mplanet]; q.K = v[nm.K];
      // period alias (aliases.js): P = palias / nalias, with nalias a whole number (a categorical prior over the allowed N)
      if (aliasOn[p]) {
        const N = v[aliasKeys[p].n], span = v[aliasKeys[p].span];
        if (!(N >= 1) || N !== Math.round(N) || !(span > 0)) return false;
        q.per = span / N;
      }
      // eccentricity sampled as sqrt(e) cos(omega), sqrt(e) sin(omega) ("secosw", "sesinw", planet-scoped): uniform priors on the
      // two are uniform in e and omega, without the boundary at e = 0 and the wrap in omega (Eastman et al. 2013)
      { const h = v[planetKey('secosw', sfx[p])], k = v[planetKey('sesinw', sfx[p])]; if (Number.isFinite(h) && Number.isFinite(k)) { q.ecc = h * h + k * k; q.omega = Math.atan2(k, h) * 57.29577951308232; } }
      q.ars = spec.kepler ? arsFromKepler(q.per, v.mstar, q.mplanet, v.rstar) : v[nm.ars];
      if (physOpt && physOpt.roche && !Number.isFinite(q.ars) && v.rstar > 0 && v.mstar > 0) q.ars = arsFromKepler(q.per, v.mstar, q.mplanet || 0, v.rstar);
      if (!(q.ecc >= 0 && q.ecc < 0.999) || !(q.per > 0)) return false;
      if ((data || spec.kepler) && !(q.ars * (1 - q.ecc) > 1)) return false;
      if (data && !(q.rprs > 0)) return false;
      if (q.mplanet < 0) return false;
    }
    return true;
  }

  function evaluate(theta) {
    for (let i = 0; i < keys.length; i++) v[keys[i]] = theta[i];
    if (tie) { tie(v.teff, v.feh || 0, tieOut); for (let i = 0; i < 4; i++) v['ld' + i] = tieOut[i] || 0; }
    if (!resolvePlanets()) return null;
    // physical viability (physical.js, spec.physical): zero prior mass for crossing, Hill- or AMD-unstable, Roche-violating or chaotic systems
    if (physCheck && physCheck(pv, v.mstar) !== null) return null;
    let ldArr = null, tp0 = null;
    for (let p = 0; p < nPl; p++) {
      const q = pv[p];
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
        else if (nbPhoto) { fluxes[p] = null; tps[p] = tp; }  // filled from the integration below
        else fluxes[p] = makeTransit(tp);
      }
      if (tim.length) els[p] = orbitElements(q);
      if (nRv) {
        const K = Number.isFinite(q.K) ? q.K : semiAmplitude(q.per, q.ecc, q.inc, q.mplanet || 0, v.mstar);
        if (!Number.isFinite(K)) return null;
        rvFns[p] = makeRV({ per: q.per, tmid: q.tmid, ecc: q.ecc, omega: q.omega, K });
        if (rmOn) {
          const vs = v.vsini || 0, lam = v[planetKey('lambda', sfx[p])] ?? v.lambda ?? 0;
          if (vs < 0 || !Number.isFinite(lam)) return null;
          rmFns[p] = vs > 0 && q.rprs > 0 && q.ars > 1 ? makeRM({ ...q, vsini: vs, lambda: lam, claret: rmLd || toClaret(spec.ldLaw, [v.ld0, v.ld1, v.ld2, v.ld3]),
            ...(rmCCF ? { method: 'ccf', beta: rmSpec.beta, zeta: rmSpec.zeta, beta0: rmSpec.beta0, widthTable: rmTable } : {}) }) : null;
        }
      }
    }
    if (data) ldArr = tie ? tp0.ld.slice() : null;
    if (nb && (timDyn.length || nRv || nbPhoto)) {
      // R* scales the positions: the given one, or (photodynamics without spec.kepler) the first planet's orbit size over its a/R*
      const rs = v.rstar > 0 || !nbPhoto ? v.rstar : arsFromKepler(pv[0].per, v.mstar, pv[0].mplanet, 1) / pv[0].ars;
      if (nbPhoto && !(rs > 0)) return null;
      dyn = dynamicalModel({ mstar: v.mstar, rstar: rs, epoch: nb.epoch, planets: pv.map((q) => ({ per: q.per, tmid: q.tmid, ecc: q.ecc, omega: q.omega, inc: q.inc, mplanet: q.mplanet || 0 })) }, dynReq);
      if (!dyn.ok) return null;                           // unbound, a close encounter, or a planet that stopped transiting
      // photodynamics: a plain transit is the kernel of transit.js at the simulated sky position (planets with their own light or a moon keep their Keplerian curve)
      if (nbPhoto) for (let p = 0; p < nPl; p++) if (!fluxes[p]) fluxes[p] = dyn.photo.transit(p, tps[p]);
    }

    let chi2 = 0, lnL = lnNorm, chi2lc = 0, chi2rv = 0, chi2tim = 0, penJit = 0;
    // ---- light curve
    if (data) {
      for (let s = 0; s < nSeg; s++) { ks[s] = am ? (nSeg > 1 ? v[kKeys[s]] ?? v.a2 : v.a2) ?? 0 : 0; sdm[s] = 0; smm[s] = 0; sdd[s] = 0; }
      if (lcJit) {
        // jitter in quadrature: new weights, and the change of the normalisation -1/2 sum ln(sigma^2 / e^2)
        for (let s = 0; s < nSeg; s++) { const j = v[jlKeys[s]] ?? v.jitlc ?? 0; if (!(j >= 0)) return null; js2[s] = (j * 1e-6) ** 2; }
        let pen = 0;
        for (let i = 0; i < N; i++) { const s2 = e2[i] + js2[seg ? seg[i] : 0]; w[i] = 1 / s2; pen += Math.log(s2 / e2[i]); }
        lnL -= 0.5 * pen; penJit += pen;
      }
      if (lcDil) for (let s = 0; s < nSeg; s++) { const d = v[dlKeys[s]] ?? v.dil ?? 0; if (!(d > -1)) return null; dls[s] = d; }
      const f0 = fluxes[0];
      if (reg) { regA.fill(0); regB.fill(0); }
      // sums of the normal equations of point i of epoch s with model value m
      const accumulate = (i, s, m) => {
        sdm[s] += w[i] * f[i] * m; smm[s] += w[i] * m * m; sdd[s] += w[i] * f[i] * f[i];
        if (reg) {
          regG[0] = m; for (let k = 0; k < nReg; k++) regG[k + 1] = m * reg[k][i];
          const oA = s * nLin * nLin, oB = s * nLin;
          for (let j = 0; j < nLin; j++) { const wg = w[i] * regG[j]; regB[oB + j] += wg * f[i]; for (let k = 0; k <= j; k++) regA[oA + j * nLin + k] += wg * regG[k]; }
        }
      };
      for (let i = 0; i < N; i++) {
        const s = seg ? seg[i] : 0, ns = anyNs ? segNs[s] : 1;
        let m;
        if (nPl === 1) {
          if (ns === 1) m = f0(t[i]);
          else { const dt = segDt[s]; m = 0; for (let j = 0; j < ns; j++) m += f0(t[i] + (j - (ns - 1) / 2) * dt); m /= ns; }
        } else if (ns === 1) {
          // the star is dimmed by every transit (product); a planet's own light (phase curve, eclipse) is added once,
          // not multiplied in: the product of two "star + planet" curves counted the star's light twice (Fp_b x Fp_c, ~1e-6)
          m = 1; let add = 0; const two = [0, 0];
          for (let p = 0; p < nPl; p++) { const fp = fluxes[p]; if (fp.two) { fp.two(t[i], two); lcPl[p][i] = two[0] + two[1]; m *= two[0]; add += two[1]; } else { const x = fp(t[i]); lcPl[p][i] = x; m *= x; } }
          m += add;
        } else {
          // average over the exposure (transits may overlap); keep each planet's own average for plots
          const dt = segDt[s], two = [0, 0]; m = 0; for (let p = 0; p < nPl; p++) lcPl[p][i] = 0;
          for (let j = 0; j < ns; j++) {
            const tj = t[i] + (j - (ns - 1) / 2) * dt; let prod = 1, add = 0;
            for (let p = 0; p < nPl; p++) { const fp = fluxes[p]; if (fp.two) { fp.two(tj, two); lcPl[p][i] += (two[0] + two[1]) / ns; prod *= two[0]; add += two[1]; } else { const x = fp(tj); lcPl[p][i] += x / ns; prod *= x; } }
            m += prod + add;
          }
          m /= ns;
        }
        if (lcDil && dls[s] !== 0) { const d = dls[s]; m = (m + d) / (1 + d); if (lcPl) for (let p = 0; p < nPl; p++) lcPl[p][i] = (lcPl[p][i] + d) / (1 + d); }
        if (am) m *= Math.exp(ks[s] * am[i]);
        model[i] = m;
        if (!kern) accumulate(i, s, m);
      }
      if (kern) {
        // the systematic of each point is the kernel-weighted mean of data / model over its neighbours (EXOTIC's
        // weightedflux of data / transit), so it is recomputed for every transit model; it multiplies the model
        for (let i = 0; i < N; i++) kRes[i] = f[i] / model[i];
        const { idx: kI, w: kW, k: kk } = kern;
        for (let i = 0; i < N; i++) { let sm = 0; const o = i * kk; for (let q = 0; q < kk; q++) sm += kW[o + q] * kRes[kI[o + q]]; kS[i] = sm; if (!(sm > 0)) return null; model[i] *= sm; accumulate(i, seg ? seg[i] : 0, model[i]); }
      }
      for (let s = 0; s < nSeg; s++) {
        if (!(smm[s] > 0)) return null;                                   // an epoch with no points
        if (reg) {
          // a1 and the regressor coefficients of this epoch together: Cholesky of A (in place, lower triangle), solve, integrate out
          const oA = s * nLin * nLin, oB = s * nLin; let lnDet = 0;
          for (let j = 0; j < nLin; j++) {
            for (let k = 0; k <= j; k++) {
              let x = regA[oA + j * nLin + k]; for (let q = 0; q < k; q++) x -= regA[oA + j * nLin + q] * regA[oA + k * nLin + q];
              if (j === k) { if (!(x > 1e-12 * regA[oA + j * nLin + j])) return null; regA[oA + j * nLin + j] = Math.sqrt(x); lnDet += Math.log(x); }
              else regA[oA + j * nLin + k] = x / regA[oA + k * nLin + k];
            }
          }
          for (let j = 0; j < nLin; j++) { let x = regB[oB + j]; for (let q = 0; q < j; q++) x -= regA[oA + j * nLin + q] * regC[oB + q]; regC[oB + j] = x / regA[oA + j * nLin + j]; }
          let bAb = 0; for (let j = 0; j < nLin; j++) bAb += regC[oB + j] * regC[oB + j];
          for (let j = nLin - 1; j >= 0; j--) { let x = regC[oB + j]; for (let q = j + 1; q < nLin; q++) x -= regA[oA + q * nLin + j] * regC[oB + q]; regC[oB + j] = x / regA[oA + j * nLin + j]; }
          const c = Math.max(0, sdd[s] - bAb);
          chi2lc += c; lnL += -0.5 * c + 0.5 * (nLin * 1.8378770664093453 - lnDet);
          continue;
        }
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
        if (rmOn) {
          let r = 0;
          if (rmExp[d] > 0) { const dt = rmExp[d] / rmNs; for (let j = 0; j < rmNs; j++) { const tj = D.t[i] + (j - (rmNs - 1) / 2) * dt; for (let p = 0; p < nPl; p++) if (rmFns[p]) r += rmFns[p](tj); } r /= rmNs; }
          else for (let p = 0; p < nPl; p++) if (rmFns[p]) r += rmFns[p](D.t[i]);
          rvRM[d][i] = r; m += r;
        }
        mod[i] = m;
        const s2 = D.e[i] * D.e[i] + jit * jit, wi = 1 / s2, r = D.v[i] - m;
        sw += wi; swr += wi * r; swrr += wi * r * r; lns += Math.log(s2); if (jit > 0) penJit += Math.log(s2 / (D.e[i] * D.e[i]));
      }
      const c = Math.max(0, swrr - swr * swr / sw);
      rvGamma[d] = swr / sw; rvChi[d] = c; chi2rv += c;
      lnL += -0.5 * c - 0.5 * (lns + n * 1.8378770664093453) + 0.5 * Math.log(6.283185307179586 / sw) - Math.log(GAMMA_PRIOR_WIDTH);
    }
    // ---- timing
    for (const x of tim) {
      // a mid-eclipse time is observed late by the light-travel time across the orbit (2a/c for a circular orbit: 50 s at 0.05 au);
      // applied with spec.phase.ltt, the same switch as for the eclipse in the light curve (needs values.rstar)
      const el = els[x.p], t0 = x.kind === 'eclipse' ? eclipseTime(el) + (phOpts.ltt && pv[x.p].ars > 0 ? lightTravelDelay({ ...pv[x.p], rstar: v.rstar }) : 0) : el.tmid, dk = dyn ? timDyn.indexOf(x) : -1, dt = dk >= 0 ? dyn.timing[dk] : null;
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
    return { a1: nSeg ? (reg ? regC[0] : sdm[0] / smm[0]) : NaN, chi2, chi2lc, chi2rv, chi2tim, chi2ic: chi2 + penJit, ld: ldArr, lnL };
  }
  /** Per-point pieces of the best-a1 model at the last evaluate(): baseline a1_s exp(k_s airmass) and the bare transit. */
  function pieces() {
    const a1s = Array.from(sdm, (x, s) => (reg ? regC[s * nLin] : x / smm[s])), base = new Float64Array(N), tr = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const s = seg ? seg[i] : 0, ex = (am ? Math.exp(ks[s] * am[i]) : 1) * (kern ? kS[i] : 1); let b = a1s[s];
      if (reg) for (let k = 0; k < nReg; k++) b += regC[s * nLin + k + 1] * reg[k][i];
      base[i] = b * ex; tr[i] = model[i] / ex;
    }
    const out = { a1s, base, transit: tr };
    if (kern) out.kernel = Float64Array.from(kS);                       // the kernel systematic of every point (multiplies the transit)
    if (reg) out.regCoeffs = Array.from({ length: nSeg }, (_, s) => Array.from(regC.subarray(s * nLin + 1, (s + 1) * nLin)));   // c_k of every epoch
    if (lcPl) out.transits = lcPl.map((a) => Float64Array.from(a));
    if (lcJit) out.lcJitter = Array.from(js2, (x) => Math.sqrt(x) * 1e6);  // ppm, per epoch
    if (lcDil) out.dilution = Array.from(dls);                             // per epoch
    if (nRv) out.rv = rvs.map((_, d) => ({ gamma: rvGamma[d], chi2: rvChi[d], jitter: v[jKeys[d]] || 0, model: Float64Array.from(rvModel[d]), planets: rvPl[d].map((a) => Float64Array.from(a)), ...(rvRM ? { rm: Float64Array.from(rvRM[d]) } : {}) }));
    if (tim.length) out.timing = tim.map((x) => ({ planet: x.planet || '', kind: x.kind || 'transit', model: Float64Array.from(x.model), epoch: Int32Array.from(x.epoch) }));
    if (nb && dyn) out.nbody = { status: dyn.status, warnings: dyn.warnings, osculating: dyn.osculating, iterations: dyn.iterations, photo: !!dyn.photo };   // osculating: [{ per, tmid }] when nbody.elements is 'mean'
    out.planets = pv.map((q) => ({ ...q }));
    return out;
  }

  return {
    ndim: keys.length, keys,
    transform(u, theta) { for (let i = 0; i < tf.length; i++) theta[i] = tf[i](u[i]); },
    loglike(theta) { const r = evaluate(theta); return r ? r.lnL : BAD; },
    /** Prior-only test at theta: 'invalid' (outside the model's own checks), null (allowed), or the physical test that failed. */
    priorCheck(theta) {
      for (let i = 0; i < keys.length; i++) v[keys[i]] = theta[i];
      if (!resolvePlanets()) return 'invalid';
      const r = physCheck ? physCheck(pv, v.mstar) : null;
      if (r) return r;
      // the planet's own light: flux below zero at some phase is always outside the prior, a negative map with positive_map
      if (data) for (let p = 0; p < nPl; p++) {
        if (v[phKeys[p].fpfs] === undefined || v[phKeys[p].fpfs] === null) continue;
        const pp = { ...toTransitParams({ ...pv[p], ld0: v.ld0, ld1: v.ld1, ld2: v.ld2, ld3: v.ld3 }, spec.ldLaw), rstar: v.rstar };
        for (const k of PHASE_FIELDS) { const x = v[phKeys[p][k]]; if (x !== undefined && x !== null) pp[k] = x; }
        if (pp.fpfs < 0) return 'invalid';
        const pc = makePhaseCurve(pp, phOpts);
        if (pc.negative) return 'invalid';
        if (!pc.ok) return 'positive_map';
      }
      return null;
    },
    physical: physOpt,
    ndata: N, nepochs: nSeg, nrv: nRv, rvTref,
    /** number of measurements of every kind, and of analytically integrated linear parameters (a1 per epoch, gamma per RV set) */
    ntotal: N + rvs.reduce((a, d) => a + d.t.length, 0) + tim.reduce((a, x) => a + x.t.length, 0), nlinear: nSeg * nLin + nRv,
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

/**
 * Information criteria: BIC = -2 ln L_max + k ln n, AIC = -2 ln L_max + 2k, with -2 ln L_max = chi2 + const. The constant is the
 * same for every model of the same data only while the error bars are fixed: with a free jitter pass detail().chi2ic
 * (chi2 + sum ln(1 + jitter^2 / sigma^2)) instead of chi2, or a model that inflates its errors always wins. redChi2 = chi2 / (n - k)
 * is meaningful with the plain chi2 only, and k must count the analytically fitted terms (prob.nlinear).
 */
export function infoCriteria(chi2, k, n) {
  return { bic: chi2 + k * Math.log(n), aic: chi2 + 2 * k, redChi2: chi2 / Math.max(1, n - k) };
}

export { derived };
