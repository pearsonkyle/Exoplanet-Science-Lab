// "How to cite and report": a methods paragraph for a paper, written from a session document (docs/FORMAT.md), and
// the BibTeX of exactly the references that session's model components need. Pure functions: no DOM, no I/O.
//
//   import { methodsParagraph } from './core/methodsText.js';
//   const { text, bibtex, keys, notes } = methodsParagraph(session, { ldSource, sliceUsed });
//
// Every sentence states something the session records (which data entered the fit, the limb-darkening law and where
// its coefficients came from, what was free with which prior, the sampler settings and its outcome) or something the
// code always does (how the baseline and the zero points are treated, which interval is quoted). Nothing is claimed
// about the user's data that the session does not say; `notes` lists what the author must add or check by hand.
// The text is a draft to adapt, in the past tense, with citation keys in square brackets ([claret2000]) that match
// the BibTeX entries.
//
// The bibliography is the one of the Methods page, methods and validation alike (src/validation/refs.js, pure data).

import { REFS } from '../validation/refs.js';
import { describeKey, dataSummary } from './exportScript.js';
import { specFromSession } from './session.js';
import { A1_PRIOR_WIDTH, GAMMA_PRIOR_WIDTH } from './model.js';

export const SOFTWARE_KEY = 'esl';
const SOFTWARE = { name: 'Exoplanet Science Lab', author: 'Pearson, Kyle A.', url: 'https://exoplanet.science' };

// ---- BibTeX ------------------------------------------------------------------------------------------------------

const JOURNALS = {
  AJ: 'The Astronomical Journal', ApJ: 'The Astrophysical Journal', ApJS: 'The Astrophysical Journal Supplement Series', MNRAS: 'Monthly Notices of the Royal Astronomical Society',
  PASP: 'Publications of the Astronomical Society of the Pacific', 'A&A': 'Astronomy \\& Astrophysics', 'A&ARv': 'The Astronomy and Astrophysics Review', JOSS: 'Journal of Open Source Software',
};
const tex = (s) => String(s).replace(/&/g, '\\&').replace(/%/g, '\\%').replace(/_/g, '\\_');
const INITIALS = /^(?:[A-Z][a-z]?\.[- ]?)+$/;

/** "Agol, E., Luger, R. & Foreman-Mackey, D." -> "Agol, E. and Luger, R. and Foreman-Mackey, D." (collaborations in braces, "et al." -> "and others"). */
export function bibtexAuthors(authors) {
  const others = /,?\s*et al\.?\s*$/.test(authors), tok = authors.replace(/,?\s*et al\.?\s*$/, '').replace(/\s+&\s+/g, ', ').split(/,\s+/).map((x) => x.trim()).filter(Boolean), out = [];
  for (let i = 0; i < tok.length; i++) {
    if (i + 1 < tok.length && INITIALS.test(tok[i + 1])) { out.push(`${tok[i]}, ${tok[i + 1]}`); i++; } else out.push(`{${tok[i]}}`);
  }
  if (others) out.push('others');
  return out.join(' and ');
}

/** One BibTeX entry for a key of REFS, or for the software itself (SOFTWARE_KEY; opts.version, opts.year). */
export function bibtexEntry(key, opts = {}) {
  const field = (k, v) => (v === undefined || v === null || v === '' ? null : `  ${k} = {${v}}`);
  if (key === SOFTWARE_KEY) {
    return `@software{${SOFTWARE_KEY},\n${[field('author', SOFTWARE.author), field('title', `{${SOFTWARE.name}}: transit, radial-velocity and timing analysis in the browser`), field('version', opts.version), field('year', opts.year), field('url', SOFTWARE.url)].filter(Boolean).join(',\n')}\n}`;
  }
  const r = REFS[key]; if (!r) throw new Error('unknown reference: ' + key);
  const m = /^(.+?), (\d+), ([A-Z]?\d+)\b/.exec(r.where), article = !!m && !/^in /.test(r.where);
  const f = [field('author', tex(bibtexAuthors(r.authors))), field('title', r.title ? `{${tex(r.title)}}` : null), field('year', r.year)];
  if (article) f.push(field('journal', JOURNALS[m[1]] || tex(m[1])), field('volume', m[2]), field('pages', m[3]));
  else f.push(field('howpublished', tex(r.where)));
  f.push(field('doi', r.doi), r.arxiv ? field('eprint', r.arxiv) : null, r.arxiv ? field('archivePrefix', 'arXiv') : null, !r.doi && !r.arxiv ? field('url', r.url) : null);
  return `@${article ? 'article' : 'misc'}{${key},\n${f.filter(Boolean).join(',\n')}\n}`;
}

/** BibTeX for a list of keys (in the order given, duplicates dropped). */
export function bibtexFor(keys, opts = {}) { return [...new Set(keys)].map((k) => bibtexEntry(k, opts)).join('\n\n') + '\n'; }

/** Every reference of the project, the software first (docs/references.bib). */
export function allBibtex(opts = {}) { return bibtexFor([SOFTWARE_KEY, ...Object.keys(REFS).sort()], opts); }

// ---- the paragraph -----------------------------------------------------------------------------------------------

const num = (x, p = 8) => (Number.isFinite(x) ? String(Number(Number(x).toPrecision(p))) : '?');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const list = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const LAW = { uniform: 'a uniform stellar disc', linear: 'the linear limb-darkening law', quadratic: 'the quadratic limb-darkening law', kipping: 'the quadratic limb-darkening law in the (q1, q2) parametrisation', sqrt: 'the square-root limb-darkening law', nonlinear: 'the four-coefficient limb-darkening law' };
const priorText = (p, time) => (p.type === 'categorical' ? `one of {${p.values.map((v) => num(v)).join(', ')}}${p.weights ? ` with weights {${p.weights.map((w) => num(w, 4)).join(', ')}}` : ' with equal weights'}` : p.type === 'normal' ? `N(${num(p.a, time ? 13 : 8)}, ${num(p.b)})` : p.type === 'uniform' ? `U(${num(p.a, time ? 13 : 8)}, ${num(p.b, time ? 13 : 8)})` : `${p.type}(${num(p.a)}, ${num(p.b)})`);

/**
 * A methods paragraph for the analysis a session describes.
 *
 * session   an esl-session document; with `result` the outcome of the run is reported as well.
 * opts.ldSource   where star-tied limb darkening came from, as the analyzer records it for a run (S.fit.ldSource):
 *                 'grey atmosphere' or the name of the model-atmosphere table. Only used when limb_darkening.mode is "star".
 * opts.sliceUsed  true when the run drew points by slice sampling (res.sampling.sliceIter > 0).
 * opts.year       year printed in the software's BibTeX entry (default: the year of session.created).
 *
 * Returns { text, bibtex, keys, notes }: the paragraph (plain text, citation keys in square brackets), the BibTeX of
 * exactly those keys (the software first), the keys, and a list of things the author still has to state or check.
 */
export function methodsParagraph(session, opts = {}) {
  const s = session, d = s.data || {}, fit = s.fit || { free: [] }, free = fit.free || [], res = s.result || null, notes = [];
  const use = { lc: true, rv: true, timing: true, ...(fit.use || {}) }, L = use.lc && d.light_curve && d.light_curve.time && d.light_curve.time.length ? d.light_curve : null;
  const rvs = use.rv ? d.radial_velocity || [] : [], tim = use.timing ? d.timing || [] : [];
  const keys = [SOFTWARE_KEY], cite = (...k) => { for (const x of k) if (!keys.includes(x)) keys.push(x); return '[' + k.join(', ') + ']'; };
  const isFree = (k) => free.some((f) => f.key === k || f.key.split('@')[0] === k), planets = s.planets || [], np = planets.length;
  const pvals = planets.map((p) => p.parameters || {}), anyP = (f) => pvals.some((v) => v[f] !== undefined && v[f] !== null);
  const version = (s.software && s.software.version) || '', year = opts.year || (s.created ? Number(String(s.created).slice(0, 4)) : undefined);
  const out = [];

  // ---- what was fitted, with what
  const kinds = [];
  if (L) { const ne = L.epochs && L.epochs.length > 1 ? L.epochs.length : 1; kinds.push(`${ne > 1 ? `${ne} light curves` : 'the light curve'} (${plural(L.time.length, 'point')}${L.name ? `; ${L.name}` : ''})`); }
  if (rvs.length) kinds.push(`${plural(rvs.reduce((a, r) => a + r.time.length, 0), 'radial velocity', 'radial velocities')} from ${plural(rvs.length, 'instrument')} (${rvs.map((r) => r.name).join(', ')})`);
  const nTr = tim.filter((x) => (x.kind || 'transit') === 'transit').length, nEc = tim.length - nTr;
  if (nTr) kinds.push(plural(nTr, 'mid-transit time'));
  if (nEc) kinds.push(plural(nEc, 'mid-eclipse time'));
  out.push(`We fitted ${list(kinds) || 'no data'} of ${s.name || 'the system'}${kinds.length > 1 ? ' jointly' : ''} with ${SOFTWARE.name}${version ? ' ' + version : ''} ${cite(SOFTWARE_KEY)}${np > 1 ? `, with ${np} planets (${planets.map((p) => p.letter).join(', ')}) in one model` : ''}.`);

  // ---- light curve
  if (L) {
    const ld = s.limb_darkening || { law: 'quadratic', coefficients: [0.4, 0.25] }, law = ld.law === 'squareroot' ? 'sqrt' : ld.law || 'quadratic';
    const phase = anyP('fpfs'), moon = anyP('rmoon');
    let t = `The transit model is the fraction of stellar flux behind the planet's disc for ${LAW[law] || law}`;
    if (law === 'nonlinear') t += ` of ${cite('claret2000')}, evaluated`;
    else if (law !== 'uniform') t += `${law === 'kipping' ? ` ${cite('kipping2013')}` : ''}, evaluated as a special case of the four-coefficient law of ${cite('claret2000')}`;
    else t += ', evaluated';
    t += ' as a line integral around the boundary of the occulted region (Green\'s theorem), with mid-transit defined as inferior conjunction; the software\'s test suite holds this flux within 1e-10 of a quadrature reference.';
    out.push(t);
    if (law !== 'uniform') {
      const ldFree = free.filter((f) => /^ld[0-3]$/.test(f.key)).length;
      if (ld.mode === 'star') {
        const src = opts.ldSource ? (/grey/i.test(opts.ldSource) ? 'a grey-atmosphere estimate' : `a table computed from PHOENIX-ACES specific intensities ${cite('husser2013')} (${opts.ldSource})`) : 'the software\'s limb-darkening estimate for the star';
        out.push(`The limb-darkening coefficients were not sampled: at every likelihood evaluation they were computed from the sampled stellar ${isFree('feh') ? 'effective temperature and metallicity' : 'effective temperature'} with ${src}${ld.band ? ` in the band "${ld.band}"` : ''}.`);
        if (!opts.ldSource) notes.push('Limb darkening follows the star, but the session does not record whether the model-atmosphere table or the grey atmosphere was used: pass opts.ldSource (the analyzer keeps it as S.fit.ldSource) or state it by hand.');
      } else if (ldFree) out.push(`The ${plural(ldFree, 'limb-darkening coefficient')} ${ldFree === 1 ? 'was' : 'were'} free parameters; profiles that are negative or brighten toward the limb were excluded.`);
      else { out.push(`The limb-darkening coefficients were held fixed at (${(ld.coefficients || []).slice(0, { linear: 1, quadratic: 2, kipping: 2, sqrt: 2, nonlinear: 4 }[law] || 4).map((x) => num(x, 5)).join(', ')})${ld.band ? ` for the band recorded as "${ld.band}"` : ''}.`); notes.push('State where the fixed limb-darkening coefficients came from (the session records the band and the values, not their source).'); }
    }
    if (phase) {
      const ph = s.phase || {}, map = ph.mode === 'map';
      out.push(`The planet's own light was modelled together with the transit: the secondary eclipse of a disc of surface brightness F_p/F_star relative to the star (eclipse depth F_p/F_star times (R_p/R_star)^2) and ${map ? `a brightness map in real spherical harmonics up to degree ${Math.min(3, Math.max(1, ph.lmax || 1))} with the normalisation of ${cite('luger2019')}, whose partial occultation during eclipse ingress and egress is integrated exactly` : 'a phase curve phased to mid-eclipse, described by a day-night contrast and a hot-spot offset'}${ph.ltt ? ', delayed by the light-travel time across the orbit' : ''}.`);
    }
    if (moon) out.push('The planet has a moon in the model: the two bodies orbit their barycentre (the moon on a circular orbit), and the blocked flux is that of the union of the two discs on the limb-darkened star.');
    // baseline and exposure
    const ne = L.epochs && L.epochs.length > 1 ? L.epochs.length : 1, air = !!L.airmass;
    out.push(`${ne > 1 ? 'Each light curve has its own flux normalisation, which was' : 'The flux normalisation was'} marginalised analytically over a uniform prior U(0, ${A1_PRIOR_WIDTH}) instead of being sampled${air ? `; the baseline is that normalisation times exp(k x airmass)${ne > 1 ? ' with one coefficient k per light curve' : ''}, the airmass model of EXOTIC ${cite('zellem2020')}` : ''}.`);
    if (L.exposure_min > 0) {
      let n = null; try { n = specFromSession(s).supersample; } catch { /* reported below */ }
      out.push(n > 1 ? `The model was averaged over each ${num(L.exposure_min, 4)} min exposure with ${n} evenly spaced evaluations.` : `The ${num(L.exposure_min, 4)} min exposures are short compared with ingress, so the model was evaluated at the mid-exposure times${n === null ? ' (the sub-sampling could not be recomputed from the session)' : ''}.`);
    }
  }

  // ---- orbit
  const ecc = isFree('ecc') || pvals.some((v) => v.ecc > 0);
  let orb = ecc ? `Orbits are Keplerian and eccentric; Kepler's equation is solved to machine precision from the starting value of ${cite('danby1987')}.` : 'Orbits are Keplerian and circular.';
  if (s.kepler) orb += ' The scaled semi-major axis a/R_star was not a free parameter: for each planet it follows from Kepler\'s third law with the stellar mass and radius, the period and the planet mass, so that all data constrain one orbit.';
  else if (L) orb += ` The scaled semi-major axis was held fixed (a/R_star = ${list(pvals.map((v) => num(v.ars, 6)))}); it is not sampled because it is degenerate with the inclination.`;
  out.push(orb);

  // ---- velocities and timing
  if (rvs.length) {
    const jf = free.filter((f) => /^jit@/.test(f.key)).length, trend = isFree('rvlin') || isFree('rvquad') || (fit.fixed && (fit.fixed.rvlin || fit.fixed.rvquad));
    out.push(`The stellar radial velocity is the sum over planets of K [cos(omega + nu) + e cos(omega)], with K from the planet mass, the stellar mass, the period, the eccentricity and the inclination by the two-body relation${trend ? ', plus a polynomial trend in time' : ''}. Each instrument has its own zero point, marginalised analytically over a uniform prior of width ${num(GAMMA_PRIOR_WIDTH)} m/s, and a jitter term added in quadrature to its uncertainties (${jf ? `free for ${plural(jf, 'instrument')}` : Object.entries(fit.fixed || {}).some(([k, x]) => /^jit@/.test(k) && x > 0) ? 'held fixed' : 'held at zero'}); the likelihood includes the ln(sigma) normalisation.`);
  }
  if (tim.length) out.push(`Mid-${nTr && nEc ? 'transit and mid-eclipse' : nEc ? 'eclipse' : 'transit'} times were compared with ${s.nbody ? 'the times of an N-body integration' : 'the linear ephemeris of the same orbit'}${fit.timing_noise > 0 ? `, with ${num(fit.timing_noise)} d added in quadrature to their uncertainties` : ''}${s.nbody ? '' : `, ${L || rvs.length ? 'fitted together with the other data to refine the ephemeris' : 'to refine the ephemeris'} as in ${cite('pearson2022')}`}.`);
  if (s.nbody) {
    const ias = s.nbody.integrator === 'ias15';
    out.push(`Mutual perturbations were included in a Bayesian N-body retrieval ${cite('pearson2019')}: mid-transit times and velocities come from an integration of the planets' osculating elements at BJD ${num(s.nbody.epoch, 13)} with ${ias ? `the IAS15 integrator ${cite('rein2015ias15')}` : `a Wisdom-Holman map in Jacobi coordinates ${cite('wisdom1991', 'rein2015whfast')}`}${s.nbody.linear ? '; a straight line in epoch was fitted to each planet\'s timing residuals inside the likelihood (profiled, not marginalised), so the evidence of this fit is not comparable with that of a Keplerian fit' : ''}. Light curves and mid-eclipse times remain Keplerian.`);
  }

  // ---- priors and sampler
  const sm = { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6, ...(fit.sampler || {}) };
  if (free.length) out.push(`The ${plural(free.length, 'free parameter')} and ${free.length === 1 ? 'its prior' : 'their priors'} were: ${free.map((f) => { const k = describeKey(f.key, s), time = f.key.split('@')[0] === 'tmid'; return `${f.label || k.label}${(f.unit || k.unit) ? ` [${f.unit || k.unit}]` : ''} ~ ${priorText(f.prior, time)}`; }).join('; ')}.`);
  else notes.push('Nothing is free in this session: there is no fit to describe.');
  let sp = `Posterior samples and the Bayesian evidence were obtained by nested sampling ${cite('skilling2006')} with the software's sampler, which follows UltraNest ${cite('buchner2021')}: ${sm.nlive} live points, new points drawn from an MLFriends region ${cite('buchner2016', 'buchner2019')} in whitened coordinates`;
  if (opts.sliceUsed) sp += `, with slice sampling ${cite('neal2003')} where the region became inefficient`;
  sp += `, stopping when the live points hold less than ${num(sm.fracRemain)} of the evidence (seed ${sm.seed}; budget ${num(sm.maxCalls)} likelihood evaluations).`;
  out.push(sp);
  if (res) {
    if (res.converged) out.push(`The run converged after ${num(res.ncalls)} likelihood evaluations with ${Math.round(res.ess)} effective posterior samples and ln Z = ${Number(res.logZ).toFixed(2)} +/- ${Number(res.logZerr).toFixed(2)}${Number.isFinite(res.chi2) ? ` (chi-square ${Number(res.chi2).toFixed(1)} for ${res.n_data} measurements at the best fit)` : ''}.`);
    else { out.push(`The run did not converge (${res.stop_reason || 'stopped'} after ${num(res.ncalls)} likelihood evaluations): its intervals are not a result, and ln Z = ${Number(res.logZ).toFixed(2)} +/- ${Number(res.logZerr).toFixed(2)} is only a lower bound.`); notes.push('The run did not converge; do not publish its intervals or evidence.'); }
    if ((res.warnings || []).length) notes.push(`The sampler raised ${plural(res.warnings.length, 'warning')}; report or resolve ${res.warnings.length === 1 ? 'it' : 'them'}: ${res.warnings.map((w) => String(w).replace(/<[^>]+>/g, '')).join(' | ')}`);
  } else notes.push('The session holds no result: run it, then regenerate this paragraph to include the outcome.');
  out.push(`We report posterior medians with the 15.87 and 84.13 per cent quantiles as uncertainties${res && res.derived ? '; derived quantities were computed on posterior draws' : ''}.`);
  out.push('Times were used as given in the data; the software does not convert between time standards.');
  notes.push('State the time standard of your data (for example BJD_TDB): the session does not record it.');
  const sum = dataSummary(s);
  if (sum.length) notes.push('Data in the session: ' + sum.map((r) => `${r.kind} "${r.name}", ${r.n} points, median uncertainty ${num(r.medianErr, 3)} ${r.unit}`).join('; ') + '.');

  return { text: out.join(' '), bibtex: bibtexFor(keys, { version, year }), keys, notes };
}
