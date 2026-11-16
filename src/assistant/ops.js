// What the assistant's tools compute from an ESL session document (docs/FORMAT.md), through src/core only.
// Shared by the in-page assistant (which gets the document from api.exportSession()) and the MCP server
// (which holds the document itself). No DOM. Everything returned here is small: counts, key numbers and
// sentences, never the data arrays.

import { fitEphemeris, assignEpochs, parseTimings, MS_PER_YEAR } from '../core/ephemeris.js';
import { timingPeriodogram } from '../core/periodogram.js';
import { synthesize, parseLightCurve, parseRV, combineEpochs, removeEpoch, nearestEpoch } from '../core/data.js';
import { buildProblem, PLANET_FIELDS, planetKey } from '../core/model.js';
import { LD_LAWS } from '../core/limbdark.js';
import { specFromSession, valuesFromSession, planetValuesOf, planetSuffixes, validateSession } from '../core/session.js';
import { deriveSystem } from '../core/derive.js';
import { dataSummary, formatValue, describeKey, pythonScriptFor, markdownReportFor, latexTablesFor } from '../core/exportScript.js';

// ---- small helpers ---------------------------------------------------------------------------------------------
export const sig = (x, n = 6) => (Number.isFinite(x) ? Number(Number(x).toPrecision(n)) : null);
const median = (a) => { const s = Array.from(a || []).filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const clone = (o) => JSON.parse(JSON.stringify(o));
export const isTimeKey = (key) => String(key).split('@')[0] === 'tmid';
/** "0.1487 +0.0021 -0.0020" for a median with its interval. */
export function pmText(q) {
  if (!q || !Number.isFinite(q.median)) return 'n/a';
  if (!(q.plus > 1e-12 * Math.abs(q.median) || q.minus > 1e-12 * Math.abs(q.median))) return String(sig(q.median, 8));   // no spread: a fixed input
  const f = formatValue(q.median, q.plus, q.minus); return f.plus ? `${f.value} +${f.plus} -${f.minus}` : f.value;
}
const slug = (s) => String(s || 'esl').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'esl';
const csv = (header, rows) => [header.join(','), ...rows.map((r) => r.map((x) => (typeof x === 'number' ? (Number.isFinite(x) ? String(x) : '') : `"${String(x ?? '').replace(/"/g, '""')}"`)).join(','))].join('\n') + '\n';
const letterIndex = (doc, letter) => { if (!letter) return 0; const i = doc.planets.findIndex((p) => p.letter === String(letter).trim().replace(/^.*\s/, '')); if (i < 0) throw new Error(`there is no planet "${letter}": the planets are ${doc.planets.map((p) => p.letter).join(', ')}`); return i; };

// ---- the data, by handle ---------------------------------------------------------------------------------------
/** One line per data set: what a model needs to know that it exists and how big it is. */
export function describeData(doc) {
  const rows = dataSummary(doc), L = (doc.data || {}).light_curve, out = [];
  for (const r of rows) {
    if (r.kind === 'light curve') {
      const dt = []; for (let i = 1; i < L.time.length; i++) if (!L.epoch || L.epoch[i] === L.epoch[i - 1]) dt.push(L.time[i] - L.time[i - 1]);
      out.push({ handle: 'light_curve', name: r.name, points: r.n, span_days: sig(r.to - r.from, 4), from: sig(r.from, 12), to: sig(r.to, 12), cadence_min: sig(median(dt) * 1440, 3), median_error_ppm: Math.round(r.medianErr * 1e6),
        epochs: r.epochs, epoch_names: r.epochs > 1 ? L.epochs.map((e) => e.name).slice(0, 12) : undefined, airmass_column: r.airmass, exposure_min: sig(r.exposure_min, 4), simulated: !!L.synthetic,
        flux_range: [sig(Math.min(...L.flux), 5), sig(Math.max(...L.flux), 5)], notes: (L.notes || []).slice(0, 4) });
    } else if (r.kind === 'radial velocity') {
      const set = doc.data.radial_velocity.find((x) => x.name === r.name);
      out.push({ handle: `velocities:${r.name}`, name: r.name, points: r.n, span_days: sig(r.to - r.from, 5), from: sig(r.from, 11), to: sig(r.to, 11), median_error_ms: sig(r.medianErr, 3), velocity_range_ms: [sig(Math.min(...set.velocity), 4), sig(Math.max(...set.velocity), 4)] });
    } else out.push({ handle: `timing:${r.name.replace('planet ', '')}:${r.kind.includes('eclipse') ? 'eclipse' : 'transit'}`, kind: r.kind, planet: r.name.replace('planet ', ''), times: r.n, from: sig(r.from, 12), to: sig(r.to, 12), median_error_min: sig(r.medianErr * 1440, 3) });
  }
  return out;
}
/** "the loaded light curve: 685 points, 0.97 d span, median error 540 ppm" */
export function dataLine(d) {
  if (d.handle === 'light_curve') return `light curve "${d.name}": ${d.points} points, ${d.span_days} d span, cadence ${d.cadence_min} min, median error ${d.median_error_ppm} ppm${d.epochs > 1 ? `, ${d.epochs} epochs` : ''}${d.airmass_column ? ', airmass column' : ''}${d.simulated ? ' (simulated)' : ''}`;
  if (d.handle.startsWith('velocities')) return `velocities "${d.name}": ${d.points} points over ${d.span_days} d, median error ${d.median_error_ms} m/s`;
  return `${d.times} mid-${d.handle.endsWith('eclipse') ? 'eclipse' : 'transit'} times of planet ${d.planet}, median error ${d.median_error_min} min`;
}
/** A fingerprint of the data a likelihood would use: evidences are comparable only between runs that share it. */
export function dataKey(doc) {
  const u = { lc: true, rv: true, timing: true, ...((doc.fit || {}).use || {}) }, d = doc.data || {}, sum = (a) => { let s = 0; for (const x of a || []) s += x; return s.toPrecision(12); };
  const parts = [];
  if (u.lc && d.light_curve) parts.push('lc', d.light_curve.time.length, sum(d.light_curve.flux), sum(d.light_curve.flux_err), (d.light_curve.epochs || []).length, d.light_curve.exposure_min ?? '');
  if (u.rv) for (const r of d.radial_velocity || []) parts.push('rv', r.time.length, sum(r.velocity), sum(r.velocity_err));
  if (u.timing) parts.push('tim', (d.timing || []).length, sum((d.timing || []).map((x) => x.time)));
  return parts.join('|');
}

// ---- results ---------------------------------------------------------------------------------------------------
/** Plain names for the keys a result is reported under, so a small model does not have to guess what "a2" or "b" is. */
const MEANING = { rprs: 'Rp/R*, planet-to-star radius ratio', ars: 'a/R*, orbit size in stellar radii', inc: 'orbital inclination', per: 'orbital period', tmid: 'mid-transit time', ecc: 'eccentricity', omega: 'argument of periastron', mplanet: 'planet mass', K: 'radial-velocity semi-amplitude',
  a2: 'airmass (extinction) slope of the baseline', rvlin: 'linear velocity trend', rvquad: 'velocity curvature', jit: 'velocity jitter', mstar: 'stellar mass', rstar: 'stellar radius', teff: 'stellar temperature', feh: 'stellar metallicity',
  b: 'impact parameter: 0 = across the centre of the star, 1 = grazing the limb', t14: 'transit duration, first to last contact', t23: 'duration of the flat part', rpJup: 'planet radius', rpEarth: 'planet radius', depth: 'transit depth as a fraction of the flux', aAU: 'semi-major axis',
  rhoStar: 'mean stellar density', rhoPlanet: 'planet density', teq: 'equilibrium temperature', emid: 'mid-eclipse time', insol: 'insolation' };
const named = (key, ldNames) => { const [b, sfx] = key.split('@'), ld = /^ld([0-3])$/.exec(b); const m = ld ? `limb-darkening coefficient ${(ldNames && ldNames[ld[1]]) || Number(ld[1]) + 1}` : MEANING[b]; return m ? `${key} (${m}${sfx && !/^rv\d|^\d/.test(sfx) ? ', planet ' + sfx : ''})` : key; };
const HEADLINE_DERIVED = ['b', 't14', 'rpJup', 'depth', 'K', 'mplanet', 'ars', 'teq', 'rhoStar'];
/**
 * A fit result (the "result" block of a session) as a model should read it. opts.derived: every derived quantity
 * instead of the headline ones; opts.keys: only those parameter / derived keys.
 */
export function summarizeResult(result, opts = {}) {
  if (!result) return { has_result: false, message: 'There is no fit result. Free at least one parameter (set_free) and call run_fit.' };
  const want = opts.keys && opts.keys.length ? new Set(opts.keys) : null, pick = (k) => !want || want.has(k) || want.has(k.split('@')[0]);
  const parameters = {}; for (const p of result.parameters || []) if (pick(p.key)) parameters[named(p.key, opts.ldNames)] = pmText(p) + (p.unit ? ' ' + p.unit : '') + (opts.best ? ` (best fit ${sig(p.best, 10)})` : '');
  const derived = {}; for (const [k, q] of Object.entries(result.derived || {})) { if (!q || !Number.isFinite(q.median)) continue; if (want ? !pick(k) : !(opts.derived || HEADLINE_DERIVED.includes(k.split('@')[0]))) continue; derived[named(k)] = pmText(q) + (DERIVED_UNIT[k.split('@')[0]] ? ' ' + DERIVED_UNIT[k.split('@')[0]] : ''); }
  const red = result.chi2 / Math.max(1, result.n_data);
  return {
    has_result: true, converged: !!result.converged, stop_reason: result.stop_reason,
    evidence: { lnZ: sig(result.logZ, 7), error: sig(result.logZerr, 2) }, effective_samples: Math.round(result.ess || 0), likelihood_calls: result.ncalls, seconds: sig(result.seconds, 3),
    chi2: sig(result.chi2, 5), n_data: result.n_data, chi2_per_point: sig(red, 3), bic: sig(result.bic, 6),
    chi2_parts: result.chi2_parts ? Object.fromEntries(Object.entries(result.chi2_parts).filter(([, v]) => Number.isFinite(v) && v !== 0).map(([k, v]) => [k, sig(v, 5)])) : undefined,
    parameters, derived, derived_note: opts.derived || want ? undefined : 'headline quantities only; get_results with derived=true lists all',
    rv_zero_points: (result.rv_zero_points || []).length ? result.rv_zero_points.map((z) => ({ name: z.name, gamma_ms: sig(z.gamma, 5), jitter_ms: sig(z.jitter, 3) })) : undefined,
    warnings: [...(result.warnings || []), ...(!result.converged ? [`The run stopped before converging (${result.stop_reason}): intervals are approximate and ln Z is a lower bound.`] : [])],
  };
}
/**
 * The result in plain words, written by the software: what each main number is, with the unit conversions done
 * here (hours, percent, Earth radii) so that a language model has nothing to compute. Returns { sentences, warnings }.
 */
export function explainResult(doc) {
  const R = doc.result; if (!R) return { has_result: false, message: 'There is no fit result to explain. Free at least one parameter (set_free) and call run_fit.' };
  const out = [], P = Object.fromEntries((R.parameters || []).map((p) => [p.key, p])), D = R.derived || {}, tRef = doc.time_reference || 0, many = doc.planets.length > 1;
  const q = (k) => (P[k] ? { ...P[k], fitted: true } : D[k] && Number.isFinite(D[k].median) ? D[k] : null), t = (x) => (x ? pmText(x) : null);
  const scaled = (x, f, n = 3) => (x ? `${sig(x.median * f, n)}${x.plus > 0 ? ` (+${sig(x.plus * f, 2)} -${sig(x.minus * f, 2)})` : ''}` : null);
  out.push(`This is a fit of ${doc.name} to ${describeData(doc).filter((d) => d.handle === 'light_curve' ? (doc.fit.use || {}).lc !== false : d.handle.startsWith('velocities') ? (doc.fit.use || {}).rv : (doc.fit.use || {}).timing).map(dataLine).join(' and ') || 'the loaded data'}, with ${(R.parameters || []).length} free parameter(s): ${(R.parameters || []).map((p) => p.key).join(', ')}. Each value is the median of the posterior with its 68% interval (+ and -).`);
  doc.planets.forEach((pl, i) => {
    const k = (f) => (i ? `${f}@${pl.letter}` : f), who = many ? `Planet ${pl.letter}: ` : '';
    const rprs = q(k('rprs')), depth = q(k('depth')), rj = q(k('rpJup')), re = q(k('rpEarth')), inc = q(k('inc')), b = q(k('b')), t14 = q(k('t14')), tm = q(k('tmid')), e = q(k('ecc')), w = q(k('omega')), K = q(k('K')), m = q(k('mplanet')), per = q(k('per')), teq = q(k('teq')), ars = q(k('ars'));
    if (rprs) out.push(`${who}Rp/R* = ${t(rprs)}${rprs.fitted ? '' : ' (not fitted here)'}: the planet's radius as a fraction of the star's.` + (depth ? ` The transit therefore dims the star by about ${scaled(depth, 100)} percent.` : ''));
    if (rj) out.push(`${who}Planet radius = ${t(rj)} Jupiter radii${re ? `, which is ${t(re)} Earth radii` : ''}. It scales with the stellar radius used (${sig((doc.star || {}).rstar, 4)} solar radii), whose own uncertainty is ${P.rstar ? 'included because R* was fitted' : 'not included'}.`);
    if (inc || b) out.push(`${who}${inc ? `Inclination = ${t(inc)} degrees (90 is exactly edge-on). ` : ''}${b ? `Impact parameter b = ${t(b)}: how far from the centre of the stellar disc the planet crosses, 0 being through the centre and 1 at the limb. ${b.median < 0.3 ? 'This is a nearly central crossing.' : b.median < 0.8 ? 'This is a crossing well away from the centre but not near the limb.' : 'This is a crossing close to the limb, where inclination, a/R* and limb darkening are strongly correlated.'}` : ''}`);
    if (t14) out.push(`${who}Transit duration (first to last contact) = ${t(t14)} days, which is ${scaled(t14, 24)} hours.`);
    if (tm) out.push(`${who}Mid-transit time = ${t(tm)}${tRef && tm.median < 1e5 ? ` days after the time reference ${tRef}` : ' (in the time system of the data)'}${tm.fitted ? '' : ' (not fitted here)'}.`);
    if (per && per.fitted) out.push(`${who}Orbital period = ${t(per)} days.`);
    if (ars) out.push(`${who}a/R* = ${t(ars)}: the orbit's semi-major axis in stellar radii. It is ${doc.kepler ? 'derived from Kepler\'s law (stellar mass and radius, period, planet mass)' : 'a fixed input, not measured by this fit'}.`);
    if (e && (e.fitted || e.median > 0)) out.push(`${who}Eccentricity = ${t(e)}${e.fitted ? '' : ' (held fixed)'} (0 is a circular orbit)${w ? `; argument of periastron = ${t(w)} degrees${w.fitted ? '' : ' (held fixed)'}` : ''}.` + (e.fitted && !rvUsed(doc) ? ' A single transit light curve constrains eccentricity only weakly, through the transit duration: treat this value with caution unless velocities or an eclipse support it.' : ''));
    if (K && rvUsed(doc)) out.push(`${who}Radial-velocity semi-amplitude K = ${t(K)} m/s${m ? `, from a planet mass of ${t(m)} Jupiter masses` : ''}.`);
    if (teq) out.push(`${who}Equilibrium temperature = ${t(teq)} K (zero albedo, full redistribution; from the stellar temperature and a/R*).`);
  });
  for (const p of R.parameters || []) { const bkey = p.key.split('@')[0]; if (bkey === 'a2') out.push(`Airmass slope ${p.key} = ${pmText(p)}: the baseline brightness changes as exp(k x airmass) through the night; it is a nuisance parameter of ground-based data, not a property of the planet.`); if (/^ld[0-3]$/.test(bkey)) out.push(`Limb-darkening coefficient ${p.key} = ${pmText(p)} (${(doc.limb_darkening || {}).law} law): how the stellar disc darkens toward its edge.`); if (bkey === 'jit') out.push(`Jitter ${p.key} = ${pmText(p)} m/s: extra scatter added to that instrument's velocity errors.`); }
  const red = R.chi2 / Math.max(1, R.n_data);
  out.push(`Fit quality: chi-squared = ${sig(R.chi2, 5)} for ${R.n_data} data points, ${red.toFixed(2)} per point. ${red > 1.6 ? 'That is high: the error bars are too small or the model is incomplete, so the quoted uncertainties are too small.' : red < 0.5 ? 'That is low: the error bars are larger than the scatter, so the quoted uncertainties are too large.' : 'A value near 1 means the scatter around the model matches the error bars.'}`);
  out.push(`Evidence ln Z = ${Number(R.logZ).toFixed(2)} ± ${Number(R.logZerr).toFixed(2)}. On its own this number says nothing about whether the model is good; it is used only to compare models fitted to the same data (compare_runs or run_experiment).`);
  out.push(R.converged ? `The sampler converged (${R.ncalls} likelihood calls, ${Math.round(R.ess || 0)} effective samples).` : `The sampler did NOT converge (${R.stop_reason}): the intervals are approximate and ln Z is only a lower bound.`);
  return { has_result: true, sentences: out, warnings: R.warnings || [], note: 'Relay these sentences. They are computed by the software; do not add conversions or interpretations of your own.' };
}
const rvUsed = (doc) => !!((doc.fit.use || {}).rv && (doc.data.radial_velocity || []).length);
const DERIVED_UNIT = { K: 'm/s', aAU: 'au', t14: 'd', t23: 'd', emid: 'd', e14: 'd', tperi: 'd', rpJup: 'R_Jup', rpEarth: 'R_Earth', rhoStar: 'g/cm3', rhoPlanet: 'g/cm3', teq: 'K', mplanet: 'M_Jup', tmid: 'd' };
/** One line for the state card. */
export function resultLine(result) {
  if (!result) return 'no fit yet';
  const ps = (result.parameters || []).slice(0, 8).map((p) => `${p.key} = ${pmText(p)}`).join('; ');
  return `ln Z = ${Number(result.logZ).toFixed(2)} ± ${Number(result.logZerr).toFixed(2)}, ${result.converged ? 'converged' : 'NOT converged (' + result.stop_reason + ')'}, chi2/N = ${(result.chi2 / Math.max(1, result.n_data)).toFixed(2)}; ${ps}${(result.parameters || []).length > 8 ? '; …' : ''}${(result.warnings || []).length ? `; ${result.warnings.length} warning(s)` : ''}`;
}

// ---- comparing runs --------------------------------------------------------------------------------------------
// The rules of the analyzer's "Runs & model comparison" table (readBayes and runAlarms in src/main.js), restated
// here because the page does not expose them: a difference is read as a preference only when it exceeds twice
// its uncertainty and 1; "moderately" starts at 2.5 and "strongly" at 5. The wording is the page's.

/** What a run log entry holds; made by tools.js after each fit. */
export function runRecord(doc, { id, label } = {}) {
  const r = doc.result, fit = doc.fit || {}, st = r.sampler_state || {};
  // what makes two runs the same model: the free parameters with their priors, and the value of everything held fixed
  const freeKeys = (fit.free || []).map((f) => f.key), vals = valuesFromSession(doc), fixedVals = Object.keys(vals).filter((k) => !freeKeys.includes(k) && Number.isFinite(vals[k])).sort().map((k) => `${k}=${Number(vals[k]).toPrecision(9)}`);
  const model = JSON.stringify([[...(fit.free || [])].sort((a, b) => (a.key < b.key ? -1 : 1)).map((f) => [f.key, f.prior]), fixedVals, (doc.limb_darkening || {}).law, !!doc.kepler]);
  return { id, label: label || '', model, name: (fit.free || []).map((f) => f.label || f.key).join(', '), free: (fit.free || []).map((f) => f.key), priors: Object.fromEntries((fit.free || []).map((f) => [f.key, f.prior])),
    law: (doc.limb_darkening || {}).law || 'quadratic', use: { lc: true, rv: true, timing: true, ...(fit.use || {}) }, dataKey: dataKey(doc),
    logZ: r.logZ, err: r.logZerr, converged: !!r.converged, stopReason: r.stop_reason, ess: r.ess, insertionP: st.insertion_p ?? 1, chi2: r.chi2, n: r.n_data, k: (fit.free || []).length, nWarnings: (r.warnings || []).length,
    headline: (r.parameters || []).slice(0, 6).map((p) => `${p.key} = ${pmText(p)}`).join('; ') };
}
export function readBayes(x, top) {
  if (x === top) return 'reference';
  if (!x.converged || !top.converged) return 'not comparable';
  const a = Math.abs(x.logZ - top.logZ), e = Math.hypot(x.err, top.err);
  if (a < Math.max(1, 2 * e)) return 'indistinguishable';
  if (a < 2.5) return 'weakly disfavoured';
  if (a < 5) return 'moderately disfavoured';
  return 'strongly disfavoured';
}
export function runAlarms(x, top) {
  const out = [];
  if (!x.converged) out.push(`It stopped before converging (${x.stopReason}): its ln Z is a lower bound, not a measurement.`);
  if (x.ess < 200) out.push(`Only ${Number(x.ess).toFixed(0)} effective samples: intervals and ln Z are noisy.`);
  if (x.insertionP < 0.01) out.push(`The insertion-order test fails (p = ${x.insertionP.toFixed(3)}): the sampler may have missed part of the posterior.`);
  const red = x.chi2 / Math.max(1, x.n);
  if (red > 1.6) out.push(`chi2/N = ${red.toFixed(1)}: the error bars are too small or the model is incomplete, which exaggerates every Δ ln Z.`);
  if (red < 0.5) out.push(`chi2/N = ${red.toFixed(2)}: the error bars are too large, which flattens every Δ ln Z.`);
  if (x.nWarnings) out.push(`${x.nWarnings} sampler warning${x.nWarnings > 1 ? 's' : ''} (see its diagnostics).`);
  if (top && x !== top) {
    const diff = x.free.filter((k) => top.free.includes(k) && JSON.stringify(x.priors[k]) !== JSON.stringify(top.priors[k]));
    if (diff.length) out.push(`Different priors than the reference run on ${diff.slice(0, 4).join(', ')}${diff.length > 4 ? '…' : ''}: part of Δ ln Z is the change of prior volume, not the data.`);
    if (JSON.stringify(x.use) !== JSON.stringify(top.use)) out.push('It used different kinds of data than the reference run: the evidences are not comparable.');
  }
  return out;
}
/** Runs that are one and the same model (free parameters, priors, fixed values): a difference between them is sampling noise, whatever they were called. */
export function sameModel(runs) {
  const out = [], seen = new Map();
  for (const x of runs) { if (!x.model) continue; if (seen.has(x.model)) out.push(`#${x.id}${x.label ? ` (${x.label})` : ''} and #${seen.get(x.model).id}${seen.get(x.model).label ? ` (${seen.get(x.model).label})` : ''} are the same model: the same free parameters, priors and fixed values. They differ only by sampling noise, so comparing them says nothing about the physics, whatever they were named.`); else seen.set(x.model, x); }
  return out;
}
/**
 * Compare the runs that share `key` (the current data). Returns { runs: [{ run, model, lnZ, delta, reading, cautions }],
 * verdict, cautions, rule, hidden }. With no run on the current data, says so.
 */
export function compareRuns(runs, key) {
  const here = key === undefined ? runs : runs.filter((x) => x.dataKey === key), hidden = runs.length - here.length;
  const rule = 'Δ ln Z is the log Bayes factor against the reference (best converged) run on the same data. It is read as a preference only when it exceeds twice its uncertainty and 1; "moderately" starts at 2.5 and "strongly" at 5 (odds of about 12 and 150 to 1). The evidence depends on the priors and on the error bars: compare runs that share both.';
  if (!here.length) return { runs: [], verdict: runs.length ? `${runs.length} earlier run(s) used different data or error bars, so their evidences cannot be compared with fits to the current data.` : 'No runs yet: run a fit first.', cautions: [], rule, hidden };
  const conv = here.filter((x) => x.converged), pool = conv.length ? conv : here, bestZ = Math.max(...pool.map((x) => x.logZ)), top = pool.find((y) => y.logZ === bestZ);
  const rows = here.map((x) => ({ run: '#' + x.id + (x.label ? ' ' + x.label : ''), free: x.name, limb_darkening: x.law, lnZ: x.converged ? `${x.logZ.toFixed(2)} ± ${x.err.toFixed(2)}` : `> ${x.logZ.toFixed(1)} (not converged)`,
    delta_lnZ: x === top || !x.converged ? null : `${(x.logZ - bestZ).toFixed(2)} ± ${Math.hypot(x.err, top.err).toFixed(2)}`, reading: readBayes(x, top), cautions: runAlarms(x, top) }));
  const same = here.filter((x) => x !== top && readBayes(x, top) === 'indistinguishable'), worse = here.filter((x) => /disfavoured/.test(readBayes(x, top)));
  const tag = (x) => '#' + x.id + (x.label ? ` (${x.label})` : '');
  let verdict = here.length === 1 ? 'One run so far: an evidence means something only next to another model fitted to the same data.' : `Run ${tag(top)} has the highest evidence.`;
  if (same.length) verdict += ` ${same.map(tag).join(', ')} ${same.length > 1 ? 'are' : 'is'} indistinguishable from it within the errors: the data do not choose between them, so prefer the simpler model.`;
  if (worse.length) verdict += ` ${worse.map((x) => `${tag(x)} is ${readBayes(x, top)} (odds about 1 in ${Math.exp(Math.min(50, top.logZ - x.logZ)).toPrecision(2)})`).join('; ')}.`;
  return { runs: rows, verdict, cautions: [...here.flatMap((x) => runAlarms(x, top).map((t) => `${tag(x)}: ${t}`)), ...sameModel(here)], rule, hidden };
}

// ---- timing ----------------------------------------------------------------------------------------------------
function timingOf(doc, letter) {
  const i = letterIndex(doc, letter), pl = doc.planets[i], first = doc.planets[0].letter;
  const rows = ((doc.data || {}).timing || []).filter((r) => (r.kind || 'transit') === 'transit' && (r.planet || first) === pl.letter).sort((a, b) => a.time - b.time);
  const t = rows.map((r) => r.time), e = rows.map((r) => r.err), per = pl.parameters.per;
  if (t.length < 2) throw new Error(`planet ${pl.letter} has ${t.length} mid-transit time(s): at least 2 are needed. Load them with set_timings.`);
  const { epochs, maxFrac } = assignEpochs(t, per, t[0]);
  return { letter: pl.letter, t, e, per, epochs, maxFrac };
}
const dgFor = (e) => Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(Math.max(1e-12, e)))));
const pm2 = (v, e) => { const d = dgFor(e); return `${v.toFixed(d)} ± ${e.toFixed(d)}`; };
const jdToUTC = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString().slice(0, 16).replace('T', ' ');
/** Linear and quadratic ephemeris of a planet's mid-transit times, as the Timing tab reports them. */
export function ephemerisOf(doc, { planet, upcoming = 3, now = Date.now() } = {}) {
  const T = timingOf(doc, planet), lin = fitEphemeris(T.epochs, T.t, T.e, 1);
  let quad = null; if (T.t.length >= 4) { try { quad = fitEphemeris(T.epochs, T.t, T.e, 2); } catch { /* not enough distinct epochs */ } }
  const row = (m) => ({ t0: pm2(m.t0, m.err.t0), period_d: pm2(m.per, m.err.per), chi2: sig(m.chi2, 4), dof: m.dof, bic: sig(m.bic, 5) });
  const out = { planet: T.letter, times: T.t.length, span_days: sig(T.t[T.t.length - 1] - T.t[0], 6), epochs_spanned: T.epochs[T.epochs.length - 1] - T.epochs[0],
    epoch_note: `Epochs are counted from the first time using the system period, P = ${T.per} d.` + (T.maxFrac > 0.2 ? ` One time sits ${T.maxFrac.toFixed(2)} of a period away from a whole number of orbits, so the orbit count may be wrong: improve the period or give the epochs explicitly.` : ''),
    linear: row(lin), residual_rms_min: sig(Math.sqrt(T.t.reduce((s, _, i) => s + lin.residual(i) ** 2, 0) / T.t.length) * 1440, 3) };
  if (lin.chi2 / Math.max(1, lin.dof) > 2) out.caution = `chi2/dof = ${(lin.chi2 / Math.max(1, lin.dof)).toFixed(1)} for the linear ephemeris: the timing errors are too small or the times vary; the quoted uncertainties are then too small.`;
  if (quad) {
    const d = lin.bic - quad.bic, z = Math.abs(quad.dPdt / quad.dPdtErr);
    out.quadratic = { ...row(quad), dPdt_ms_per_year: pm2(quad.dPdt * MS_PER_YEAR, quad.dPdtErr * MS_PER_YEAR) };
    out.reading = `ΔBIC (linear − quadratic) = ${d.toFixed(1)}: ${d > 10 ? 'the changing period is strongly preferred' : d > 2 ? 'some preference for a changing period' : d > -2 ? 'the two models are not distinguished' : 'the constant period is preferred'}. The period change is ${z.toFixed(1)}σ from zero.`;
  } else out.reading = 'A quadratic ephemeris needs at least 4 times at distinct epochs; only the linear one was fitted.';
  if (upcoming > 0 && T.t[0] > 2e6) {
    const jdNow = now / 86400000 + 2440587.5, E0 = Math.max(T.epochs[T.epochs.length - 1] + 1, Math.ceil((jdNow - lin.t0) / lin.per));
    out.next_transits = Array.from({ length: upcoming }, (_, i) => { const p = lin.predict(E0 + i); return { epoch: E0 + i, time: Number(p.t.toFixed(dgFor(p.sigma))), sigma_min: sig(p.sigma * 1440, 3), utc: jdToUTC(p.t) }; });
    out.next_note = 'Predicted with the linear ephemeris; UTC is the calendar reading of the listed date and is not corrected between time systems (BJD_TDB is about a minute from UTC).';
  }
  return out;
}
/** The periodogram of the timing residuals and the model comparison, with the page's own verdict and notes. */
export function periodogramOf(doc, { planet, bootstrap = 0 } = {}) {
  const T = timingOf(doc, planet);
  const pg = timingPeriodogram(T.epochs, T.t, T.e, { order: 1, bootstrap, seed: 1 });
  const p1 = pg.periodograms ? pg.periodograms[0] : null;
  return { planet: T.letter, times: T.t.length,
    peaks: p1 ? p1.peaks.slice(0, 3).map((p) => ({ period_epochs: sig(p.period, 5), period_days: sig(p.periodDays, 6), power: sig(p.power, 4), false_alarm_probability: sig(p.fap, 3), ...(p.fapBootstrap !== undefined ? { false_alarm_bootstrap: sig(p.fapBootstrap, 3) } : {}) })) : [],
    models: (pg.models || []).filter(Boolean).map((m) => ({ model: m.name, k: m.k, chi2: sig(m.chi2, 5), bic: sig(m.bic, 6), ...(m.terms && m.terms.length ? { period_days: sig(m.terms[0].periodDays, 6), amplitude_min: sig(m.terms[0].amp * 1440, 3), amplitude_err_min: sig(m.terms[0].ampErr * 1440, 2) } : {}) })),
    significant: !!pg.significant, recommended: pg.models && pg.models[pg.recommended] ? pg.models[pg.recommended].name : 'linear', verdict: pg.verdict, notes: pg.notes || [] };
}

// ---- the model at the current values ---------------------------------------------------------------------------
/** Depth, duration, chi2 and residual scatter at the session's parameter values; with wantCurve, the curve as CSV. */
export function modelOf(doc, { wantCurve = false } = {}) {
  validateSession(doc);
  const spec = specFromSession(doc), prob = buildProblem({ ...spec, free: [] }), det = prob.detail([]);
  const values = valuesFromSession(doc), tRef = doc.time_reference || 0, out = { planets: {} };
  planetSuffixes(doc).forEach((sx, i) => {
    const q = planetValuesOf(values, sx, doc.kepler); let d = null;
    try { d = deriveSystem(q, { ...(doc.star || {}), mplanet: q.mplanet > 0 ? q.mplanet : null }); } catch { /* impossible geometry */ }
    out.planets[doc.planets[i].letter] = d ? { depth_ppm: Math.round((d.depth ?? q.rprs ** 2) * 1e6), t14_hours: sig(d.t14 * 24, 4), impact_parameter: sig(d.b, 4), a_over_rstar: sig(q.ars ?? d.ars, 5), rp_jup: sig(d.rpJup, 4), K_ms: sig(d.K, 4), mid_transit: sig(q.tmid + tRef, 12) } : { error: 'these values do not describe a transiting orbit' };
  });
  if (!det) { out.error = 'The model cannot be evaluated at these values (an impossible geometry or limb darkening).'; return out; }
  out.chi2 = sig(det.chi2, 6); out.n_data = prob.ntotal; out.chi2_per_point = sig(det.chi2 / Math.max(1, prob.ntotal), 3);
  const L = spec.data;
  if (L) {
    let s = 0; const res = new Float64Array(L.t.length);
    // det.model is transit x airmass term and det.base the fitted baseline (a1 x airmass term): the full model is base x transit
    for (let i = 0; i < L.t.length; i++) { const full = det.base && det.transit ? det.base[i] * det.transit[i] : det.model[i]; res[i] = L.f[i] - full; s += res[i] * res[i]; }
    out.light_curve = { points: L.t.length, residual_rms_ppm: Math.round(Math.sqrt(s / L.t.length) * 1e6), median_error_ppm: Math.round(median(L.e) * 1e6), baseline_flux: sig(det.a1, 6) };
    if (wantCurve) out.csv = csv(['time', 'flux', 'flux_err', 'model', 'transit_only', 'residual'], Array.from(L.t, (t, i) => [t + tRef, L.f[i], L.e[i], L.f[i] - res[i], det.transit ? det.transit[i] : NaN, res[i]]));
  }
  if (det.rv && det.rv.length) out.radial_velocity = det.rv.map((x, k) => ({ name: spec.rv[k].name, zero_point_ms: sig(x.gamma, 5), chi2: sig(x.chi2, 5), points: spec.rv[k].t.length }));
  return out;
}

// ---- changing a session document -------------------------------------------------------------------------------
// The analyzer's scripting surface has no call for these (see the assistant's report), so the in-page assistant
// makes them by exporting the session, changing the document and importing it again. Each returns a new document
// without a result.

const bare = (doc) => { const d = clone(doc); d.result = null; return d; };
export function addPlanet(doc, { letter, parameters = {} } = {}) {
  const d = bare(doc), used = d.planets.map((p) => p.letter), next = 'bcdefghijklmnop'.split('').find((c) => !used.includes(c));
  const L = (letter || next || '').trim().slice(-1);
  if (!/^[a-z]$/i.test(L)) throw new Error('a planet letter is one letter, such as "c"');
  if (used.includes(L)) throw new Error(`planet ${L} already exists (planets: ${used.join(', ')})`);
  const bad = Object.keys(parameters).filter((k) => !PLANET_FIELDS.includes(k));
  if (bad.length) throw new Error(`not planet parameters: ${bad.join(', ')}. A planet takes ${PLANET_FIELDS.join(', ')} (plain names, without the @letter).`);
  const b = d.planets[0].parameters, p = { ...b, per: Number((b.per * 2).toPrecision(8)), ...parameters };
  if (parameters.per && !parameters.ars && Number.isFinite(b.ars)) p.ars = Number((b.ars * (p.per / b.per) ** (2 / 3)).toPrecision(6));
  else if (!parameters.per && Number.isFinite(b.ars)) p.ars = Number((b.ars * 2 ** (2 / 3)).toPrecision(6));
  if (p.tmid < 1e5 && (d.time_reference || 0) > 0) p.tmid += d.time_reference;
  d.planets.push({ letter: L, parameters: p });
  return { doc: d, letter: L, keys: Object.keys(p).map((f) => `${f}@${L}`) };
}
export function removePlanet(doc, letter) {
  const d = bare(doc), i = letterIndex(d, letter);
  if (d.planets.length < 2) throw new Error('the system has one planet: it cannot be removed');
  const sfx = i ? d.planets[i].letter : null, L = d.planets[i].letter;
  d.planets.splice(i, 1);
  const mine = (k) => (sfx ? k.endsWith('@' + sfx) : !k.includes('@') && PLANET_FIELDS.includes(k));
  // removing the first planet promotes the next: its keys lose their letter
  const promote = sfx ? null : d.planets[0].letter, ren = (k) => (promote && k.endsWith('@' + promote) ? k.split('@')[0] : k);
  d.fit.free = d.fit.free.filter((f) => !mine(f.key)).map((f) => ({ ...f, key: ren(f.key) }));
  if (d.fit.priors) d.fit.priors = Object.fromEntries(Object.entries(d.fit.priors).filter(([k]) => !mine(k)).map(([k, v]) => [ren(k), v]));
  d.data.timing = (d.data.timing || []).filter((r) => (r.planet || L) !== L);
  if (d.ui) d.ui.planet = '';
  return { doc: d, removed: L };
}
export function setLimbDarkening(doc, { law, coefficients } = {}) {
  const d = bare(doc), spec = LD_LAWS[law];
  if (!spec) throw new Error(`unknown law "${law}": choose one of ${Object.keys(LD_LAWS).join(', ')}`);
  const n = spec.names.length, old = d.limb_darkening || {};
  if (coefficients && coefficients.length !== n) throw new Error(`the ${law} law takes ${n} coefficient(s) (${spec.names.join(', ') || 'none'}), not ${coefficients.length}`);
  const c = coefficients || (old.law === law ? (old.coefficients || []).slice(0, n) : spec.defaults);
  d.limb_darkening = { ...old, law, mode: 'coeffs', coefficients: [...c] };
  const gone = (k) => /^ld[0-3]$/.test(k) && Number(k[2]) >= n;
  d.fit.free = d.fit.free.filter((f) => !gone(f.key));
  // the coefficients mean something else under another law: their old priors do not carry over
  if (old.law !== law && d.fit.priors) for (const k of Object.keys(d.fit.priors)) if (/^ld[0-3]$/.test(k)) delete d.fit.priors[k];
  if (old.law !== law) d.fit.free = d.fit.free.filter((f) => !/^ld[0-3]$/.test(f.key));
  return { doc: d, law, names: spec.names, coefficients: [...c], defaulted: !coefficients && old.law !== law };
}
/** Replace the light curve by a simulated observation of the first planet (core synthesize: white noise, optional airmass trend). */
export function simulateInto(doc, o = {}) {
  const d = bare(doc), values = valuesFromSession(d), q = planetValuesOf(values, '', d.kepler), law = (d.limb_darkening || {}).law || 'quadratic';
  const opt = { exptimeMin: o.exposure_min ?? 2, noisePpm: o.noise_ppm ?? 500, baselineHr: o.baseline_hr ?? 2, airmass: !!o.airmass, k: o.airmass ? (Number.isFinite(values.a2) && values.a2 !== 0 ? values.a2 : -0.03) : 0, seed: o.seed ?? 1, nEpochs: o.n_epochs ?? 1, epochStep: o.epoch_step ?? 1 };
  const ld = { ...q }; for (let i = 0; i < 4; i++) ld['ld' + i] = values['ld' + i] ?? 0;
  const s = synthesize(ld, law, opt), tRef = d.time_reference || 0;
  d.data.light_curve = { name: s.name, time: Array.from(s.t, (x) => x + tRef), flux: Array.from(s.f), flux_err: Array.from(s.e), airmass: s.airmass ? Array.from(s.airmass) : null, exposure_min: s.exptimeMin,
    epoch: s.epoch ? Array.from(s.epoch) : null, epochs: s.epoch ? s.segments.map((g) => ({ name: g.name, airmass: !!g.airmass })) : [], synthetic: true, notes: [`simulated: ${opt.noisePpm} ppm white noise, ${opt.exptimeMin} min exposures${opt.airmass ? ', airmass trend' : ''}`] };
  d.fit.use = { ...(d.fit.use || {}), lc: true };
  if (opt.airmass && !(Number.isFinite(d.fit.fixed.a2) && d.fit.fixed.a2 !== 0)) d.fit.fixed = { ...d.fit.fixed, a2: opt.k };
  if (!opt.airmass) d.fit.free = d.fit.free.filter((f) => f.key.split('@')[0] !== 'a2');
  return { doc: d, options: opt };
}
/** Light-curve data of a session as the object core/data.js works with (relative times). */
function lcObject(doc) {
  const L = doc.data.light_curve, tRef = doc.time_reference || 0;
  const o = { name: L.name, tRef, t: Float64Array.from(L.time, (x) => x - tRef), f: Float64Array.from(L.flux), e: Float64Array.from(L.flux_err), airmass: L.airmass ? Float64Array.from(L.airmass) : null, notes: L.notes || [] };
  if (L.epoch && L.epochs && L.epochs.length > 1) { o.epoch = Int32Array.from(L.epoch); o.segments = L.epochs.map((ep, k) => { let t0 = Infinity, t1 = -Infinity, c = 0; for (let i = 0; i < o.t.length; i++) if (o.epoch[i] === k) { c++; t0 = Math.min(t0, o.t[i]); t1 = Math.max(t1, o.t[i]); } return { name: ep.name, n: c, t0, t1, airmass: !!ep.airmass }; }); }
  return o;
}
/** Write a core data object back into a session's light_curve block. */
export function lcBlock(o, extra = {}) {
  return { name: o.name, time: Array.from(o.t, (x) => x + (o.tRef || 0)), flux: Array.from(o.f), flux_err: Array.from(o.e), airmass: o.airmass ? Array.from(o.airmass) : null,
    epoch: o.epoch ? Array.from(o.epoch) : null, epochs: o.epoch ? o.segments.map((g) => ({ name: g.name, airmass: !!g.airmass })) : [], notes: o.notes || [], ...extra };
}
export function editData(doc, { exposure_min, remove_epoch, remove_velocities, clear_timings } = {}) {
  const d = bare(doc), done = [];
  if (exposure_min !== undefined) { if (!d.data.light_curve) throw new Error('there is no light curve'); if (!(exposure_min >= 0)) throw new Error('exposure_min must be zero or more'); d.data.light_curve.exposure_min = exposure_min; done.push(`exposure set to ${exposure_min} min`); }
  if (remove_epoch !== undefined) {
    const L = d.data.light_curve; if (!L || !L.epochs || L.epochs.length < 2) throw new Error('the light curve has a single epoch: load another one instead of removing it');
    if (remove_epoch > L.epochs.length) throw new Error(`there are ${L.epochs.length} epochs`);
    const o = removeEpoch(lcObject(d), remove_epoch - 1); d.data.light_curve = lcBlock({ ...o, tRef: d.time_reference || 0 }, { exposure_min: L.exposure_min, synthetic: L.synthetic });
    d.fit.free = d.fit.free.filter((f) => f.key.split('@')[0] !== 'a2'); done.push(`epoch ${remove_epoch} removed (${o.segments ? o.segments.length : 1} left)`);
  }
  if (remove_velocities !== undefined) {
    const sets = d.data.radial_velocity || [], i = sets.findIndex((r) => r.name === remove_velocities);
    if (i < 0) throw new Error(`no velocity set "${remove_velocities}": the sets are ${sets.map((r) => r.name).join(', ') || 'none'}`);
    sets.splice(i, 1); d.fit.free = d.fit.free.filter((f) => !f.key.startsWith('jit@')); if (!sets.length) d.fit.use = { ...d.fit.use, rv: false }; done.push(`velocities "${remove_velocities}" removed`);
  }
  if (clear_timings) { d.data.timing = []; d.fit.use = { ...d.fit.use, timing: false }; done.push('timing list cleared'); }
  if (!done.length) throw new Error('nothing to do: give exposure_min, remove_epoch, remove_velocities or clear_timings');
  return { doc: d, done };
}

// ---- reading data text before it is loaded ---------------------------------------------------------------------
/** Parse a light curve the way the analyzer will, to report what it holds (throws the reader's own message when it cannot). */
export function previewLightCurve(text, name) {
  const p = parseLightCurve(text, name || 'Light curve', { time: 'auto', flux: 'auto' });
  return { points: p.t.length, time_system: p.timeSystem, flux_units: p.fluxUnits, time_reference: p.tRef, span_days: sig(p.t[p.t.length - 1] - p.t[0], 4), median_error_ppm: Math.round(median(p.e) * 1e6), airmass_column: !!p.airmass, notes: (p.notes || []).slice(0, 5), parsed: p };
}
export function previewRV(text, name) { const r = parseRV(text, name || 'RV'); return { sets: r.sets.map((s) => ({ name: s.name, points: s.t.length, median_error_ms: sig(median(s.e), 3) })), notes: r.notes || [], parsed: r }; }
export function previewTimings(raw) {
  // a list may carry words (a "source" column, a header): keep the numbers of each row, which is what the reader takes
  const text = String(raw).split(/\r?\n/).map((l) => { const tok = l.trim().split(/[,;\s]+/).filter(Boolean); const nums = tok.filter((x) => Number.isFinite(Number(x))); return tok.length > nums.length && nums.length >= 2 && nums.length <= 3 ? nums.join(', ') : l; }).join('\n');
  const p = parseTimings(text); return { times: p.rows.length, skipped_lines: p.skipped, from: sig(p.rows[0].t, 12), to: sig(p.rows[p.rows.length - 1].t, 12), median_error_min: sig(median(p.rows.map((r) => r.e)) * 1440, 3), parsed: p, text };
}
export { combineEpochs, nearestEpoch };

/** What a text file holds, for read_file and list_files: lines, columns, the numeric range of each column, a guess. */
export function describeText(text, name = '') {
  const lines = text.split(/\r?\n/), nonEmpty = lines.filter((l) => l.trim()), out = { chars: text.length, lines: nonEmpty.length };
  if (/\.json$/i.test(name) || /^\s*[{[]/.test(text)) {
    try { const j = JSON.parse(text); out.kind = j && j.format === 'esl-session' ? `ESL session "${j.title || j.name}"${j.result ? ' with a fit result' : ''} (open with import_session)` : `JSON (${Array.isArray(j) ? j.length + ' items' : 'keys: ' + Object.keys(j).slice(0, 12).join(', ')})`; return out; } catch { /* not JSON after all */ }
  }
  const rows = nonEmpty.filter((l) => !/^[#%!]/.test(l.trim()));
  const sample = rows[Math.min(1, rows.length - 1)] || '', delim = [',', ';', '\t', '|'].map((d) => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0];
  const split = (l) => (delim[1] > 1 ? l.split(delim[0]) : l.trim().split(/\s+/)).map((c) => c.trim());
  const cells = rows.map(split), ncol = cells.length ? cells[Math.min(1, cells.length - 1)].length : 0;
  const numeric = cells.filter((r) => r.length === ncol && r.every((c) => c !== '' && Number.isFinite(Number(c))));
  if (ncol >= 2 && numeric.length >= Math.max(2, 0.6 * cells.length)) {
    const header = cells[0].some((c) => !Number.isFinite(Number(c))) ? cells[0] : null;
    out.columns = Array.from({ length: ncol }, (_, j) => { let lo = Infinity, hi = -Infinity; for (const r of numeric) { const x = Number(r[j]); if (x < lo) lo = x; if (x > hi) hi = x; } return { name: header ? header[j] : `column ${j + 1}`, min: sig(lo, 9), max: sig(hi, 9) }; });
    out.rows = numeric.length;
    const hasNames = cells.some((r) => r.length === ncol && r.some((c) => /[a-z]{2,}/i.test(c)) && r.filter((c) => Number.isFinite(Number(c))).length >= 3);
    out.kind = `table of numbers: ${numeric.length} rows x ${ncol} columns` + (ncol >= 3 ? ' (could be a light curve: time, flux, error; or velocities; or epoch, time, error)' : ' (could be mid-transit times: time, uncertainty)') + (hasNames ? '' : '');
  } else out.kind = /\.(md|txt)$/i.test(name) ? 'text' : /\.py$/i.test(name) ? 'Python script' : 'text';
  const comments = nonEmpty.filter((l) => /^[#%!]/.test(l.trim())).length; if (comments) out.comment_lines = comments;
  return out;
}

// ---- result files ----------------------------------------------------------------------------------------------
/** The text of a result file: { name, text, mime }. Throws a sentence when the analysis has nothing of that kind. */
export function exportText(doc, kind, name) {
  const base = slug(doc.name), R = doc.result, tRef = doc.time_reference || 0, d = doc.data || {};
  const need = (what) => { if (!R) throw new Error(`${what} needs a fit result: run_fit first`); };
  switch (kind) {
    case 'session': return { name: name || `${base}_session.json`, text: JSON.stringify(doc), mime: 'application/json' };
    case 'report': return { name: name || `${base}_report.md`, text: markdownReportFor(doc, { sessionFile: `${base}_session.json` }), mime: 'text/markdown' };
    case 'python': return { name: name || `${base}_fit.py`, text: pythonScriptFor(doc, { embedData: true }), mime: 'text/x-python' };
    case 'latex': need('The LaTeX tables'); return { name: name || `${base}_tables.tex`, text: latexTablesFor(doc), mime: 'text/x-tex' };
    case 'results_csv': { need('The results table');
      const rows = [...R.parameters.map((p) => ['fitted', p.key, describeKey(p.key, doc).label, p.unit || '', p.median, p.plus, p.minus, p.best]), ...Object.entries(R.derived || {}).filter(([, q]) => q && Number.isFinite(q.median)).map(([k, q]) => ['derived', k, k, DERIVED_UNIT[k.split('@')[0]] || '', q.median, q.plus, q.minus, NaN])];
      return { name: name || `${base}_results.csv`, text: csv(['kind', 'key', 'label', 'unit', 'median', 'plus', 'minus', 'best'], rows), mime: 'text/csv' }; }
    case 'samples_csv': { need('The posterior draws'); if (!R.samples || !R.samples.values.length) throw new Error('this result was stored without its posterior draws');
      const tk = R.samples.keys.map((k) => isTimeKey(k));
      return { name: name || `${base}_samples.csv`, text: csv([...R.samples.keys, 'lnL'], R.samples.values.map((row, i) => [...row.map((x, k) => (tk[k] ? x + tRef : x)), (R.samples.logl || [])[i] ?? NaN])), mime: 'text/csv' }; }
    case 'light_curve_csv': { const L = d.light_curve; if (!L || !L.time.length) throw new Error('there is no light curve');
      const cols = ['time', 'flux', 'flux_err', ...(L.airmass ? ['airmass'] : []), ...(L.epoch ? ['epoch'] : [])];
      return { name: name || `${base}_lightcurve.csv`, text: csv(cols, L.time.map((t, i) => [t, L.flux[i], L.flux_err[i], ...(L.airmass ? [L.airmass[i]] : []), ...(L.epoch ? [L.epoch[i] + 1] : [])])), mime: 'text/csv' }; }
    case 'velocities_csv': { const sets = d.radial_velocity || []; if (!sets.length) throw new Error('there are no radial velocities');
      return { name: name || `${base}_velocities.csv`, text: csv(['time', 'velocity_ms', 'velocity_err_ms', 'instrument'], sets.flatMap((s) => s.time.map((t, i) => [t, s.velocity[i], s.velocity_err[i], s.name]))), mime: 'text/csv' }; }
    case 'timing_csv': { const rows = d.timing || []; if (!rows.length) throw new Error('the timing list is empty');
      return { name: name || `${base}_timing.csv`, text: csv(['time', 'err', 'planet', 'kind', 'source'], rows.map((r) => [r.time, r.err, r.planet || '', r.kind || 'transit', r.source || ''])), mime: 'text/csv' }; }
    default: throw new Error(`unknown kind of file "${kind}"`);
  }
}
/** The Markdown report of an experiment: what was compared, the table, the reading and the cautions, as computed. */
export function experimentReport({ title, system, data, variants, comparison, when = new Date().toISOString() }) {
  const out = [`# ${title}`, '', `${system} · ${when}`, '', '## Data', '', ...data.map((d) => `- ${d}`), '', '## Models compared', ''];
  out.push('| Run | Free parameters | ln Z | Δ ln Z | Reading |', '|---|---|---|---|---|');
  for (const r of comparison.runs) out.push(`| ${r.run} | ${r.free} | ${r.lnZ} | ${r.delta_lnZ ?? '—'} | ${r.reading} |`);
  out.push('', '## Reading', '', comparison.verdict, '');
  if (comparison.cautions.length) out.push('## Cautions', '', ...comparison.cautions.map((c) => `- ${c}`), '');
  out.push('## Fitted values', '');
  for (const v of variants) out.push(`### ${v.name}`, '', v.error ? `This run failed: ${v.error}` : v.lines.map((l) => `- ${l}`).join('\n'), '');
  out.push('## How to read this', '', comparison.rule, '', 'Produced by the Exoplanet Science Lab assistant. The table, the reading and the cautions are computed by the software, not written by the language model.', '');
  return out.join('\n');
}

// ---- optional models, on the session document ------------------------------------------------------------------
// The planet's own light, a moon and N-body dynamics as docs/FORMAT.md stores them. The analyzer has its own calls
// for these (setPhase, setMoon, setNbody); the MCP server, and a page that lacks them, change the document.
const PHASE_KEYS = ['fpfs', 'contrast', 'hotspot', 'h2c', 'h2s', 'ellip', 'beam'], MOON_KEYS = ['rmoon', 'permoon', 'phmoon', 'mmoon', 'imoon'];
export const isPlanetExtra = (base) => PHASE_KEYS.includes(base) || MOON_KEYS.includes(base) || /^y\d+m?\d+$/.test(base);
const dropKeys = (d, sfx, test) => { const mine = (k) => { const [b, s] = k.split('@'); return test(b) && (s || '') === sfx; }; d.fit.free = d.fit.free.filter((f) => !mine(f.key)); if (d.fit.priors) for (const k of Object.keys(d.fit.priors)) if (mine(k)) delete d.fit.priors[k]; };
export function setPhase(doc, { planet, on = true, mode, lmax, parameters = {} } = {}) {
  const d = bare(doc), i = letterIndex(d, planet), q = d.planets[i].parameters, sfx = i ? d.planets[i].letter : '';
  if (!on) { for (const k of Object.keys(q)) if (PHASE_KEYS.includes(k) || /^y\d+m?\d+$/.test(k)) delete q[k]; dropKeys(d, sfx, (b) => PHASE_KEYS.includes(b) || /^y\d+m?\d+$/.test(b)); if (!d.planets.some((p) => p.parameters.fpfs !== undefined)) delete d.phase; return { doc: d, planet: d.planets[i].letter, on: false }; }
  const m = mode || (d.phase || {}).mode || 'harmonic';
  if (!['harmonic', 'map'].includes(m)) throw new Error('mode is "harmonic" or "map"');
  d.phase = { ...(d.phase || {}), mode: m, ...(m === 'map' ? { lmax: Math.min(3, Math.max(1, lmax || (d.phase || {}).lmax || 1)) } : {}) };
  const defaults = m === 'map' ? { fpfs: 1e-3, y10: 0, y11: 0.5, y1m1: 0, ellip: 0, beam: 0 } : { fpfs: 1e-3, contrast: 0.5, hotspot: 0, h2c: 0, h2s: 0, ellip: 0, beam: 0 };
  for (const [k, v] of Object.entries({ ...defaults, ...Object.fromEntries(Object.keys(defaults).filter((k) => q[k] !== undefined).map((k) => [k, q[k]])), ...parameters })) q[k] = v;
  return { doc: d, planet: d.planets[i].letter, on: true, mode: m, keys: Object.keys(q).filter((k) => isPlanetExtra(k) && !MOON_KEYS.includes(k)).map((k) => (sfx ? `${k}@${sfx}` : k)) };
}
export function setMoon(doc, { planet, on = true, parameters = {} } = {}) {
  const d = bare(doc), i = letterIndex(d, planet), q = d.planets[i].parameters, sfx = i ? d.planets[i].letter : '';
  if (!on) { for (const k of MOON_KEYS) delete q[k]; dropKeys(d, sfx, (b) => MOON_KEYS.includes(b)); return { doc: d, planet: d.planets[i].letter, on: false }; }
  const bad = Object.keys(parameters).filter((k) => !MOON_KEYS.includes(k)); if (bad.length) throw new Error(`not moon parameters: ${bad.join(', ')}. A moon takes ${MOON_KEYS.join(', ')}.`);
  const defaults = { rmoon: Number((q.rprs * 0.3).toPrecision(3)), permoon: Number((q.per / 12).toPrecision(4)), phmoon: 0.25, mmoon: 0.01, imoon: 90 };
  for (const [k, v] of Object.entries({ ...defaults, ...Object.fromEntries(MOON_KEYS.filter((k) => q[k] !== undefined).map((k) => [k, q[k]])), ...parameters })) q[k] = v;
  return { doc: d, planet: d.planets[i].letter, on: true, keys: MOON_KEYS.map((k) => (sfx ? `${k}@${sfx}` : k)) };
}
export function setNbody(doc, { on = true, epoch, linear } = {}) {
  const d = bare(doc);
  if (!on) { delete d.nbody; return { doc: d, on: false }; }
  if (d.planets.length < 2) throw new Error('N-body dynamics need at least two planets: add one first (add_planet)');
  if (!d.kepler) throw new Error('N-body dynamics need the masses: turn Kepler mode on first (set_kepler)');
  d.nbody = { ...(d.nbody || {}), epoch: Number.isFinite(epoch) ? epoch : (d.nbody || {}).epoch ?? d.planets[0].parameters.tmid, ...(linear !== undefined ? { linear: !!linear } : {}) };
  return { doc: d, on: true, nbody: d.nbody };
}

// ---- tables for the reader -------------------------------------------------------------------------------------
// The result of a tool as a Markdown table, written by the software. The harness puts it under an answer whose
// numbers do not match the tool results (numcheck.js), so the reader always has the values as computed.
const mdRow = (cells) => '| ' + cells.map((c) => String(c ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ') + ' |';
const mdTable = (head, rows) => [mdRow(head), '|' + head.map(() => '---').join('|') + '|', ...rows.map(mdRow)].join('\n');
export function tableFor(name, data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.table === 'string') return data.table;
  const cmp = data.comparison && data.comparison.runs ? data.comparison : data.runs && data.verdict !== undefined ? data : null;
  if (cmp && cmp.runs.length) return mdTable(['Run', 'Free parameters', 'ln Z', 'Δ ln Z', 'Reading'], cmp.runs.map((r) => [r.run, r.free, r.lnZ, r.delta_lnZ ?? '—', r.reading])) + (cmp.verdict ? `\n\n${cmp.verdict}` : '') + ((cmp.cautions || []).length ? '\n\n' + cmp.cautions.map((c) => `- ${c}`).join('\n') : '');
  if (data.has_result && data.parameters) {
    const rows = [...Object.entries(data.parameters), ...Object.entries(data.derived || {})];
    if (data.evidence) rows.push(['ln Z (evidence)', `${data.evidence.lnZ} ± ${data.evidence.error}${data.converged ? '' : ' (not converged: a lower bound)'}`]);
    if (data.chi2 !== undefined) rows.push(['chi-squared', `${data.chi2} for ${data.n_data} points`]);
    return mdTable(['Quantity', 'Value (median, +, −)'], rows) + ((data.warnings || []).length ? '\n\n' + data.warnings.map((w) => `- Warning: ${w}`).join('\n') : '');
  }
  if (data.has_result && data.sentences) return data.sentences.map((s) => `- ${s}`).join('\n');
  if (data.linear && data.linear.period_d) return mdTable(['Ephemeris', 'T0', 'Period (d)', 'chi2', 'BIC'], [['linear', data.linear.t0, data.linear.period_d, data.linear.chi2, data.linear.bic], ...(data.quadratic ? [['quadratic', data.quadratic.t0, data.quadratic.period_d, data.quadratic.chi2, data.quadratic.bic]] : [])]) + (data.quadratic ? `\n\ndP/dt = ${data.quadratic.dPdt_ms_per_year} ms/yr. ` : '\n\n') + (data.reading || '');
  // a list of flat records (a page tool: transits, catalogue rows, validation rows)
  const key = Object.keys(data).find((k) => Array.isArray(data[k]) && data[k].length && data[k].every((r) => r && typeof r === 'object' && !Array.isArray(r)));
  if (key) { const rows = data[key].slice(0, 15), cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((c) => r[c] === null || typeof r[c] !== 'object')))].slice(0, 8); if (cols.length) return mdTable(cols, rows.map((r) => cols.map((c) => r[c] ?? ''))) + (data[key].length > 15 ? `\n\n(${data[key].length - 15} more rows)` : ''); }
  return '';
}

// ---- FITS headers ----------------------------------------------------------------------------------------------
/** The header cards of a FITS file as text (primary header, and the first extension's when the primary holds no image). */
export function fitsHeaderText(buf) {
  const bytes = new Uint8Array(buf), dec = new TextDecoder('ascii');
  if (dec.decode(bytes.subarray(0, 9)) !== 'SIMPLE  =') return null;
  const out = []; let off = 0, naxis = 0;
  for (let hdu = 0; hdu < 2 && off + 2880 <= bytes.length; hdu++) {
    let end = false; naxis = 0; if (hdu) out.push('', `--- extension ${hdu} ---`);
    while (!end && off + 2880 <= bytes.length) {
      for (let i = 0; i < 36; i++) { const card = dec.decode(bytes.subarray(off + i * 80, off + (i + 1) * 80)).replace(/\s+$/, ''); if (card === 'END') { end = true; break; } if (card) out.push(card); if (/^NAXIS   =/.test(card)) naxis = parseInt(card.slice(10), 10) || 0; }
      off += 2880;
    }
    if (naxis > 0) break;
  }
  return out.join('\n');
}
