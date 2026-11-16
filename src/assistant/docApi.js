// The analyzer's scripting surface (window.__esl.api, makeAPI() in src/main.js) implemented on a session
// document instead of the page, through src/core only. The MCP server drives this, so the same tool handlers
// (tools.js) work with and without a browser, and the Node tests exercise them against real fits.
//
// It follows the page where that matters for an analysis (parameter keys, relative times in state(), what
// loading data does to T mid and to the tick boxes) and is simpler elsewhere: default priors are plain
// rules rather than the page's (which use the transit duration), limb darkening that follows the star is
// not available (the document says mode "star"; the coefficients are used as given), and a catalogue
// look-up does not invent a stand-in light curve.

import { activeParams, PLANET_FIELDS, planetKey } from '../core/model.js';
import { LD_LAWS } from '../core/limbdark.js';
import { validatePrior } from '../core/priors.js';
import { parseLightCurve, parseRV, combineEpochs, nearestEpoch } from '../core/data.js';
import { parseTimings } from '../core/ephemeris.js';
import { arsFromKepler } from '../core/rv.js';
import { deriveSystem } from '../core/derive.js';
import { FORMAT, FORMAT_VERSION, validateSession, valuesFromSession, planetValuesOf, runSession, specFromSession } from '../core/session.js';
import { buildProblem } from '../core/model.js';
import { loadIndex, lookupHost, systemFromRows } from '../core/catalog.js';
import { lcBlock, isPlanetExtra } from './ops.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const base = (k) => String(k).split('@')[0];
const r6 = (x) => Number(Number(x).toPrecision(6));
const STAR_KEYS = ['teff', 'feh', 'mstar', 'rstar', 'logg'];

export const EXAMPLE_LIST = [
  { id: 'single', title: 'Single transit', about: 'HAT-P-32 b · simulated ground-based night with an airmass trend', kinds: ['transit'] },
  { id: 'hd80606-tess', title: 'TESS transit of HD 80606 b', about: 'the 12-hour transit of a planet on an e = 0.93 orbit', kinds: ['transit'] },
  { id: 'multi', title: 'Several transits, one fit', about: 'five simulated nights, each with its own airmass trend; the period is free', kinds: ['transit'] },
  { id: 'hd80606-rv', title: 'Radial velocities of HD 80606 b', about: '264 velocities from seven instruments over 20 years', kinds: ['rv'] },
  { id: 'hd80606-joint', title: 'HD 80606 b: transit, velocities and timing together', about: 'a joint fit of the three kinds of data', kinds: ['transit', 'rv', 'ephemeris'] },
  { id: 'toy1873', title: 'Three planets', about: 'three transiting planets and velocities, masses free', kinds: ['transit', 'rv'] },
];

/** An empty session to start from. */
export function blankSession(name = 'New system') {
  return { format: FORMAT, version: FORMAT_VERSION, software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null }, created: new Date().toISOString(), name, title: name, notes: '',
    star: { teff: 5700, teffErr: 100, logg: 4.4, loggErr: 0.1, feh: 0, fehErr: 0.1, rstar: 1, rstarErr: 0.05, mstar: 1, mstarErr: 0.05 },
    limb_darkening: { law: 'quadratic', mode: 'coeffs', band: '', coefficients: [0.4, 0.26] },
    planets: [{ letter: 'b', parameters: { rprs: 0.1, ars: 8.8, inc: 88, per: 3, tmid: 0, ecc: 0, omega: 0 } }], kepler: false, time_reference: 0,
    data: { light_curve: null, radial_velocity: [], timing: [] },
    fit: { use: { lc: true, rv: false, timing: false }, free: [], fixed: { a2: 0 }, priors: {}, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6 } }, ui: { planet: '' }, result: null };
}

/**
 * createDocApi({ session, fetchText, fetchJson, store }) -> the api.
 *   fetchText(path)   text of a file under the site's public folder ("examples/results/single.json")
 *   fetchJson(name)   parsed JSON of a file of the catalogue folder ("index.json")
 *   store             { save(doc, name) -> meta, list() -> [meta], get(id) -> doc|null, delete(id) } for save/open
 */
export function createDocApi({ session, fetchText, fetchJson, store } = {}) {
  let doc = session ? clone(validateSession(session)) : blankSession(), running = false, stopFlag = false, catalog = null;
  const UNDO = [], REDO = [];
  const push = () => { UNDO.push(JSON.stringify(doc)); if (UNDO.length > 30) UNDO.shift(); REDO.length = 0; };
  const tRef = () => doc.time_reference || 0;
  const sfxOf = (i) => (i ? doc.planets[i].letter : '');
  const shown = () => { const i = doc.planets.findIndex((p, k) => sfxOf(k) === ((doc.ui || {}).planet || '')); return Math.max(0, i); };
  const lc = () => (doc.data || {}).light_curve;
  const nEpochs = () => { const L = lc(); return L ? (L.epochs && L.epochs.length > 1 ? L.epochs.length : 1) : 0; };
  const rvOn = () => !!(doc.fit.use || {}).rv && (doc.data.radial_velocity || []).length > 0;
  const actParams = () => {
    const L = lc(), air = !L || !L.airmass ? false : nEpochs() > 1 ? L.epochs.map((e) => !!e.airmass) : true;
    return activeParams((doc.limb_darkening || {}).law || 'quadratic', air, { planets: doc.planets.map((p, i) => ({ sfx: sfxOf(i), letter: p.letter })), kepler: !!doc.kepler, mass: !!doc.kepler || (doc.data.radial_velocity || []).length > 0, rv: (doc.data.radial_velocity || []).map((r) => r.name),
      moons: doc.planets.map((p, i) => (p.parameters.rmoon !== undefined ? sfxOf(i) : null)).filter((x) => x !== null), phase: Object.fromEntries(doc.planets.map((p, i) => (p.parameters.fpfs !== undefined ? [sfxOf(i), doc.phase || { mode: 'harmonic' }] : null)).filter(Boolean)) });
  };
  const values = () => { const v = valuesFromSession(doc); for (const k of STAR_KEYS) if (Number.isFinite((doc.star || {})[k])) v[k] = doc.star[k]; return v; };
  const priors = () => (doc.fit.priors = doc.fit.priors || {});
  const freeEntry = (key) => doc.fit.free.find((f) => f.key === key);
  const rel = (key, p) => (base(key) === 'tmid' && p ? (p.type === 'uniform' ? { ...p, a: p.a - tRef(), b: p.b - tRef() } : { ...p, a: p.a - tRef() }) : p);
  const abs = (key, p) => (base(key) === 'tmid' && p ? (p.type === 'uniform' ? { ...p, a: p.a + tRef(), b: p.b + tRef() } : { ...p, a: p.a + tRef() }) : p);

  /** A plain default prior around the current value (stored in the document's terms: tmid absolute). */
  function defaultPrior(key) {
    const b = base(key), v = values()[key] ?? 0, sfx = PLANET_FIELDS.includes(b) ? key.split('@')[1] || '' : '';
    let t14 = 0.1; try { t14 = deriveSystem(planetValuesOf(values(), sfx, doc.kepler), doc.star || {}).t14 || 0.1; } catch { /* keep the guess */ }
    const U = (a, c) => ({ type: 'uniform', a: r6(a), b: r6(c) }), N = (a, c) => ({ type: 'normal', a, b: r6(c) });
    switch (b) {
      case 'rprs': return U(Math.max(0.001, v * 0.5), Math.min(0.6, v * 1.6));
      case 'ars': return U(Math.max(1.2, v * 0.75), v * 1.3);
      case 'inc': return U(Math.max(60, v - 5), 90);
      case 'per': return N(v, Math.max(1e-6, v * 1e-5));
      case 'tmid': { const w = Math.max(0.01, 0.2 * t14), a = v + tRef(); return { type: 'uniform', a: Number((a - w).toFixed(6)), b: Number((a + w).toFixed(6)) }; }
      case 'ecc': return U(0, Math.min(0.95, Math.max(0.2, v + 0.2)));
      case 'omega': return U(v - 180, v + 180);
      case 'mplanet': return U(0, Math.max(5 * v, 0.02));
      case 'K': return U(0, Math.max(5 * v, 10));
      case 'a2': return U(-0.2, 0.2);
      case 'rvlin': return U(-0.1, 0.1);
      case 'rvquad': return U(-1e-3, 1e-3);
      case 'jit': return U(0, 30);
      case 'rmoon': case 'fpfs': return U(0, Math.max(5 * v, 0.01));
      case 'permoon': return U(Math.max(1e-3, v * 0.3), v * 3);
      case 'phmoon': return U(0, 1);
      case 'mmoon': return U(0, Math.max(5 * v, 0.1));
      case 'imoon': return U(0, 180);
      case 'hotspot': return U(-90, 90);
      case 'contrast': return U(0, 1);
      case 'mstar': case 'rstar': { const e = (doc.star || {})[b + 'Err']; return N(r6(v), e > 0 ? e : 0.05 * v); }
      case 'teff': return N(v, (doc.star || {}).teffErr || 100);
      case 'feh': return N(v, (doc.star || {}).fehErr || 0.1);
      default: return /^ld[0-3]$/.test(b) ? U(Math.max(-1.5, v - 0.3), Math.min(1.5, v + 0.3)) : U(v - 1, v + 1);
    }
  }
  function setValue(key, v) {
    v = Number(v); if (!Number.isFinite(v)) throw new Error(`${key}: not a number`);
    const b = base(key), sfx = key.split('@')[1] || '';
    if (STAR_KEYS.includes(key)) doc.star = { ...doc.star, [key]: v };
    else if (PLANET_FIELDS.includes(b) || isPlanetExtra(b)) { const i = sfx ? doc.planets.findIndex((p, k) => k > 0 && p.letter === sfx) : 0; if (i < 0) throw new Error(`no planet ${sfx}`); doc.planets[i].parameters[b] = b === 'tmid' ? v + tRef() : v; }
    else if (/^ld[0-3]$/.test(key)) { const n = LD_LAWS[doc.limb_darkening.law].names.length, j = Number(key[2]); if (j >= n) throw new Error(`${key} is not a coefficient of the ${doc.limb_darkening.law} law`); doc.limb_darkening.coefficients[j] = v; }
    else doc.fit.fixed = { ...doc.fit.fixed, [key]: v };
  }
  function known(key) { const p = actParams().find((x) => x.key === key); if (!p && !STAR_KEYS.includes(key)) throw new Error(`"${key}" is not a parameter of this set-up (parameters: ${actParams().map((x) => x.key).join(', ')})`); return p; }
  function ensureRV() {
    for (const p of actParams()) {
      if (p.base === 'mplanet') { const i = p.planet ? doc.planets.findIndex((x) => x.letter === p.planet) : 0; if (!(doc.planets[i].parameters.mplanet >= 0)) doc.planets[i].parameters.mplanet = 1; }
      else if (p.group === 'rv' && !Number.isFinite(doc.fit.fixed[p.key])) doc.fit.fixed[p.key] = 0;
    }
  }
  function fromCatalogSystem(sys, kinds, snapshot) {
    const val = (v, k, d) => (v[k] && Number.isFinite(v[k].value) ? v[k].value : d), err = (v, k) => (v[k] && v[k].err > 0 ? v[k].err : 0);
    const sv = sys.star.values, wantRV = kinds.includes('rv'), wantLC = kinds.includes('transit') || !kinds.length;
    const d = blankSession(sys.host);
    d.star = { teff: Math.round(val(sv, 'teff', 5700)), teffErr: Math.round(err(sv, 'teff')) || 100, logg: Number(val(sv, 'logg', 4.4).toFixed(3)), loggErr: err(sv, 'logg') || 0.1, feh: Number(val(sv, 'feh', 0).toFixed(3)), fehErr: err(sv, 'feh') || 0.1,
      rstar: Number(val(sv, 'rstar', 1).toFixed(4)), rstarErr: Number((err(sv, 'rstar') || 0.05 * val(sv, 'rstar', 1)).toFixed(4)), mstar: Number(val(sv, 'mstar', 1).toFixed(4)), mstarErr: Number((err(sv, 'mstar') || 0.05 * val(sv, 'mstar', 1)).toFixed(4)) };
    const letters = sys.planets.map((p, i) => (p.planet.match(/\s([a-z])$/) || [])[1] || 'bcdefghij'[i]);
    d.planets = sys.planets.map((p, i) => { const v = p.values; return { letter: letters[i], parameters: { rprs: val(v, 'rprs', 0.1), ars: val(v, 'ars', 10), inc: val(v, 'inc', 89), per: val(v, 'per', 3), tmid: val(v, 'tmid', 0), ecc: val(v, 'ecc', 0), omega: val(v, 'omega', 0), ...(Number.isFinite(val(v, 'mplanet', NaN)) ? { mplanet: val(v, 'mplanet') } : wantRV ? { mplanet: 0.1 } : {}) } }; });
    d.kepler = wantRV; d.time_reference = Math.floor(d.planets[0].parameters.tmid) || 0;
    sys.planets.forEach((p, i) => {
      const key = (f) => (i ? `${f}@${letters[i]}` : f);
      for (const [f, pr] of Object.entries(p.priors || {})) if (['rprs', 'ars', 'inc', 'per', 'tmid', 'ecc', 'omega', 'mplanet'].includes(f) && Number.isFinite(pr.a) && Number.isFinite(pr.b)) d.fit.priors[key(f)] = { type: pr.type, a: pr.a, b: pr.b };
      if (wantLC) for (const f of ['rprs', 'inc', 'tmid']) d.fit.free.push({ key: key(f), prior: d.fit.priors[key(f)] });
    });
    d.notes = `Parameters for ${sys.host} from the NASA Exoplanet Archive snapshot of ${snapshot}. No observations are loaded.`;
    d.sources = { host: sys.host, snapshot, planets: sys.planets.map((p, i) => ({ letter: letters[i], planet: p.planet, reference: p.reference })) };
    return d;
  }

  const api = {
    state() {
      const v = values(), L = lc(), act = actParams(), P = priors();
      return { name: doc.name, planets: doc.planets.map((p) => p.letter), showing: doc.planets[shown()].letter, kepler: !!doc.kepler,
        lightCurve: { name: L ? L.name : '', points: L ? L.time.length : 0, epochs: nEpochs(), airmass: !!(L && L.airmass), inFit: !!(doc.fit.use || {}).lc && !!L, timeReference: tRef() },
        radialVelocity: (doc.data.radial_velocity || []).map((r) => ({ name: r.name, points: r.time.length })), rvInFit: rvOn(), timing: { points: (doc.data.timing || []).length, inFit: !!(doc.fit.use || {}).timing },
        parameters: act.map((p) => { const f = freeEntry(p.key); return { key: p.key, label: p.label, unit: p.unit || '', value: v[p.key], free: !!f, prior: rel(p.key, (f && f.prior) || P[p.key] || null), group: p.group }; }),
        star: { ...doc.star }, limbDarkening: { law: doc.limb_darkening.law, mode: doc.limb_darkening.mode || 'coeffs', band: doc.limb_darkening.band || '' }, sampler: { ...doc.fit.sampler }, running, hasResult: !!doc.result, chi2: api._chi2() };
    },
    _chi2() { try { const det = buildProblem({ ...specFromSession(doc), free: [] }).detail([]); return det ? det.chi2 : null; } catch { return null; } },
    examples: () => EXAMPLE_LIST.map((e) => ({ ...e })),
    async loadExample(id, { fresh = false } = {}) {
      if (!EXAMPLE_LIST.some((e) => e.id === id)) throw new Error(`no example "${id}"`);
      if (!fetchText) throw new Error('examples are not available here');
      const d = JSON.parse(await fetchText(`examples/results/${id}.json`)); if (fresh) d.result = null;
      api.importSession(d); return true;
    },
    async lookup(name, kinds = ['transit']) {
      if (!fetchJson) throw new Error('the catalogue is not available here');
      if (!catalog) catalog = await loadIndex(fetchJson);
      const L = await lookupHost(catalog, name, fetchJson);
      if (!L || !L.rows || !L.rows.length) throw new Error(`${name} is not in the catalog snapshot`);
      const rows = L.planet ? L.rows.filter((r) => r.pl_name === L.planet) : L.rows;
      push(); doc = fromCatalogSystem(systemFromRows(rows, { use: kinds.length === 1 ? kinds[0] : 'all' }), kinds, L.snapshot || catalog.date); return true;
    },
    setValue(key, v) { if (!STAR_KEYS.includes(key)) known(key); push(); setValue(key, v); doc.result = null; },
    setFree(key, on) {
      if (base(key) === 'ars') throw new Error('a/R★ cannot be fitted: use Kepler\'s law and fit M★');
      known(key); push(); doc.result = null;
      const f = freeEntry(key);
      if (on && !f) { const p = known(key) || {}, pr = priors()[key] || (priors()[key] = defaultPrior(key)); doc.fit.free.push({ key, label: p.label || key, unit: p.unit || '', prior: { ...pr } }); }
      if (!on && f) { priors()[key] = f.prior; doc.fit.free = doc.fit.free.filter((x) => x !== f); }
    },
    setPrior(key, prior) {
      const bad = validatePrior(prior); if (bad) throw new Error(`prior for ${key}: ${bad}`);
      push(); const p = abs(key, { type: prior.type, a: Number(prior.a), b: Number(prior.b) }); priors()[key] = p; const f = freeEntry(key); if (f) f.prior = { ...p };
    },
    setUse(use) { push(); doc.fit.use = { ...doc.fit.use, ...use }; if (doc.fit.use.rv) ensureRV(); doc.result = null; },
    setKepler(on) {
      push(); on = !!on; doc.result = null;
      if (!on) { const v = values(); doc.planets.forEach((p, i) => { const o = planetValuesOf(v, sfxOf(i), true); if (Number.isFinite(o.ars)) p.parameters.ars = Number(o.ars.toPrecision(8)); }); }
      doc.kepler = on; doc.fit.free = doc.fit.free.filter((f) => base(f.key) !== 'ars' && (on || !['mstar', 'rstar'].includes(f.key)));
      if (on) for (const p of doc.planets) if (!(p.parameters.mplanet >= 0)) p.parameters.mplanet = 0;
    },
    setSampler(o) { push(); doc.fit.sampler = { ...doc.fit.sampler, ...o }; },
    loadLightCurve(text, name = 'Light curve') {
      const p = parseLightCurve(text, name, { time: 'auto', flux: 'auto' });
      push(); const b = doc.planets[0].parameters, tmidOld = b.tmid;
      doc.time_reference = p.tRef || 0;
      doc.data.light_curve = lcBlock({ ...p, name }, { exposure_min: p.meta.exptimeMin || cadenceMin(p), synthetic: false });
      if (p.meta.planet) doc.name = p.meta.planet;
      // as the page: T mid moves by whole periods onto the data, the first planet alone remains, priors are rebuilt
      const tAbs = Array.from(p.t, (x) => x + (p.tRef || 0));
      b.tmid = p.meta.tmid !== undefined ? p.meta.tmid + (p.tRef || 0) : nearestEpoch(tmidOld, b.per, tAbs);
      doc.planets = [doc.planets[0]]; doc.fit.use = { ...doc.fit.use, lc: true }; doc.result = null;
      const keep = new Set(actParams().map((x) => x.key)); doc.fit.priors = {};
      doc.fit.free = doc.fit.free.filter((f) => keep.has(f.key)).map((f) => ({ ...f, prior: (doc.fit.priors[f.key] = defaultPrior(f.key)) }));
      return { points: p.t.length, notes: p.notes || [] };
    },
    addLightCurveEpoch(text, name = 'epoch') {
      const L = lc(); if (!L) return (api.loadLightCurve(text, name), { epochs: 1 });
      const p = parseLightCurve(text, name, { time: 'auto', flux: 'auto' });
      const cur = { name: L.name, tRef: tRef(), t: Float64Array.from(L.time, (x) => x - tRef()), f: Float64Array.from(L.flux), e: Float64Array.from(L.flux_err), airmass: L.airmass ? Float64Array.from(L.airmass) : null, notes: L.notes || [] };
      if (L.epoch && L.epochs.length > 1) { cur.epoch = Int32Array.from(L.epoch); cur.segments = L.epochs.map((e) => ({ name: e.name, airmass: !!e.airmass })); }
      const d = combineEpochs([cur, { ...p, name }]);
      push(); doc.time_reference = d.tRef;
      doc.data.light_curve = lcBlock({ ...d, name: `${doc.name} · ${d.segments.length} epochs` }, { exposure_min: L.exposure_min, synthetic: false }); doc.result = null;
      return { epochs: d.segments.length };
    },
    addRadialVelocities(text, name = 'RV') {
      const r = parseRV(text, name.replace(/\.[a-z0-9]+$/i, ''));
      push(); const taken = new Set(doc.data.radial_velocity.map((x) => x.name)), first = !doc.data.radial_velocity.length;
      if (!tRef()) { const t0 = Math.min(...r.sets.map((x) => x.t[0])); if (t0 > 1e5) { doc.time_reference = Math.floor(t0); if (lc() && lc().time[0] < 1e5) doc.fit.use = { ...doc.fit.use, lc: false }; } }
      for (const s of r.sets) { let nm = s.name, k = 2; while (taken.has(nm)) nm = `${s.name} ${k++}`; taken.add(nm); doc.data.radial_velocity.push({ name: nm, time: Array.from(s.t), velocity: Array.from(s.v), velocity_err: Array.from(s.e) }); }
      doc.fit.use = { ...doc.fit.use, rv: true }; doc.result = null; ensureRV();
      if (first) for (const p of actParams()) if (p.base === 'mplanet' && !freeEntry(p.key)) { const pr = priors()[p.key] || (priors()[p.key] = defaultPrior(p.key)); doc.fit.free.push({ key: p.key, label: p.label, unit: p.unit || '', prior: { ...pr } }); }
      return doc.data.radial_velocity.map((x) => ({ name: x.name, points: x.time.length }));
    },
    setTimings(text) {
      const p = parseTimings(text), L = doc.planets[shown()].letter, first = doc.planets[0].letter;
      push(); doc.data.timing = [...(doc.data.timing || []).filter((r) => (r.planet || first) !== L || r.kind === 'eclipse'), ...p.rows.map((r) => ({ planet: L, kind: 'transit', time: r.t, err: r.e, source: 'provided' }))];
      return { times: p.rows.length };
    },
    showPlanet(letter) { const i = doc.planets.findIndex((x) => x.letter === letter); if (i < 0) throw new Error(`no planet ${letter}`); doc.ui = { ...(doc.ui || {}), planet: sfxOf(i) }; },
    setView(o) { doc.ui = { ...(doc.ui || {}), ...(o.view ? { view: o.view } : {}), ...(o.fold !== undefined ? { fold: !!o.fold } : {}), ...(o.allPlanets !== undefined ? { all_planets: !!o.allPlanets } : {}) }; },
    showTab() {},
    /** Run the fit. opts.onProgress receives the sampler's progress ({ it, ncalls, logZ, remFrac, elapsed }). */
    async run(opts = {}) {
      if (running) throw new Error('a fit is already running');
      if (!doc.fit.free.length) throw new Error('Tick at least one parameter to fit.');
      const bad = doc.fit.free.find((f) => validatePrior(f.prior)); if (bad) throw new Error(`Prior for ${bad.key}: ${validatePrior(bad.prior)}.`);
      const u = doc.fit.use || {}, has = { lc: u.lc !== false && !!lc(), rv: rvOn(), timing: !!u.timing && (doc.data.timing || []).length > 0 };
      if (!has.lc && !has.rv && !has.timing) throw new Error('Nothing to fit: include the light curve, the radial velocities or the timing list.');
      running = true; stopFlag = false;
      try {
        const out = await runSession({ ...doc, fit: { ...doc.fit, use: has } }, { keepSamples: true, maxSamples: 1500, onProgress: opts.onProgress || (() => {}), shouldStop: () => stopFlag });
        push(); doc = { ...doc, result: { ...out.session.result, sampler_state: { nlive: out.res.nlive, insertion_p: out.res.insertionP ?? 1, mode: out.res.mode || null } } };
        // the best-fit point becomes the current values, as on the page
        for (const p of doc.result.parameters) { try { setValue(p.key, base(p.key) === 'tmid' ? p.best - tRef() : p.best); } catch { /* a key this document cannot hold */ } }
      } finally { running = false; }
      return api.results();
    },
    stop() { stopFlag = true; },
    results() { if (!doc.result) return null; const r = clone(doc.result); delete r.samples; return r; },
    exportSession(withResult = true) { const d = clone(doc); d.created = new Date().toISOString(); if (!withResult) d.result = null; d.fit.use = { lc: !!(d.fit.use || {}).lc && !!lc(), rv: rvOn(), timing: !!(d.fit.use || {}).timing && (d.data.timing || []).length > 0 }; return d; },
    importSession(d) { validateSession(d); push(); doc = clone(d); doc.data = { light_curve: null, radial_velocity: [], timing: [], ...(doc.data || {}) }; doc.fit = { use: {}, fixed: {}, priors: {}, sampler: {}, ...doc.fit }; return doc; },
    async save(name) { if (!store) throw new Error('saving is not available here'); const d = api.exportSession(true); if (name) d.title = name; return store.save(d, name || d.title || d.name); },
    async listSaved() { return store ? store.list() : []; },
    async openSaved(id) { const d = store && (await store.get(id)); if (!d) throw new Error('that saved analysis no longer exists'); api.importSession(d.session || d); },
    async deleteSaved(id) { if (!store) throw new Error('saving is not available here'); return store.delete(id); },
    undo() { if (!UNDO.length) return false; REDO.push(JSON.stringify(doc)); doc = JSON.parse(UNDO.pop()); return true; },
    redo() { if (!REDO.length) return false; UNDO.push(JSON.stringify(doc)); doc = JSON.parse(REDO.pop()); return true; },
  };
  return api;
}
function cadenceMin(d) { const dt = []; for (let i = 1; i < d.t.length; i++) { const x = d.t[i] - d.t[i - 1]; if (x > 0) dt.push(x); } dt.sort((a, b) => a - b); return dt.length ? Number((dt[dt.length >> 1] * 1440).toPrecision(4)) : 0; }
export { arsFromKepler };
