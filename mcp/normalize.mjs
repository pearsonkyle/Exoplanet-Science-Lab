// Input checks for the server's own tools (atmosphere_spectrum, atmosphere_retrieve, star_fit), applied at the MCP
// boundary before src/core sees the arguments. Tool-calling models, and the parsers between them and this server,
// send the right values in slightly wrong shapes: numbers as strings ("1.19"), null for "not given", band names
// with quotes or a string delimiter left on (<|"|>Gaia G<|"|>, `2MASS J`), underscores for spaces (2MASS_J),
// { value, error } where [value, error] is asked for. Each is repaired here only where the meaning is unambiguous;
// anything else fails with a message that says what was received, what is expected, and a call that works.
// The science code is untouched and every call shape that worked before works the same.
import { PASSBANDS } from '../src/core/passbands.js';

const DELIMS = ['<|"|>', '`', '"', "'"];
const NUM = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
const show = (v) => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 160 ? s.slice(0, 157) + '...' : s; } catch { return String(v); } };

/** A key without quotes or delimiters wrapped around it. */
export function cleanKey(k) {
  let s = String(k).trim(), again = true;
  while (again) {
    again = false;
    for (const d of DELIMS) {  // both ends, or one end alone (a delimiter a parser left on one side)
      if (s.length > d.length && s.startsWith(d)) { s = s.slice(d.length).trim(); again = true; }
      if (s.length > d.length && s.endsWith(d)) { s = s.slice(0, -d.length).trim(); again = true; }
    }
  }
  return s;
}

/** A number from a number or a numeric string; otherwise the value unchanged. */
export const num = (v) => (typeof v === 'string' && NUM.test(v) ? Number(v) : v);

/**
 * The arguments with the repairs above applied, guided by the tool's JSON schema: keys cleaned, numeric strings
 * turned into numbers wherever the schema does not ask for a string, null optional fields left out (null means
 * "not given"; core code would read it as the string "null" or a missing number).
 */
export function normalizeArgs(value, schema = {}) {
  if (Array.isArray(value)) return value.map((x) => normalizeArgs(x, (schema && schema.items) || {}));
  if (value && typeof value === 'object') {
    const props = (schema && schema.properties) || {}, extra = schema && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {}, req = new Set((schema && schema.required) || []), out = {};
    for (const [k0, v] of Object.entries(value)) {
      const k = cleanKey(k0);
      if (v === null && !req.has(k)) continue;
      const ps = props[k] || extra, pt = ps && ps.type;
      // an empty object, array or string where a number is asked for is "not given" (a model's placeholder for "the default")
      if (!req.has(k) && (pt === 'number' || pt === 'integer') && (v === '' || (typeof v === 'object' && Object.keys(v).length === 0))) continue;
      out[k] = normalizeArgs(v, props[k] || extra);
    }
    return out;
  }
  const t = schema && schema.type, types = Array.isArray(t) ? t : t ? [t] : [];
  return types.includes('string') ? value : num(value);
}

// ---- star_fit: magnitudes and parallax ------------------------------------------------------------------------
const BANDS = Object.keys(PASSBANDS), canon = (s) => String(s).replace(/[\s_\-]+/g, ' ').trim().toLowerCase();
const BY_CANON = new Map(BANDS.map((b) => [canon(b), b]));
// B and V alone are Johnson's: APASS B and V are calibrated onto the Johnson system (Landolt standards)
const SHORT = { B: 'Johnson B', V: 'Johnson V' };

/** The passband a key names: exact, then ignoring case, quotes, _ and -, then a unique suffix (Ks -> 2MASS Ks). */
export function bandOf(key) {
  const k = cleanKey(key);
  if (PASSBANDS[k]) return { band: k };
  if (SHORT[k] && PASSBANDS[SHORT[k]]) return { band: SHORT[k] };
  const c = canon(k), hit = BY_CANON.get(c);
  if (hit) return { band: hit };
  // a unique suffix, with case first (G is Gaia's band, g the SDSS / PS1 / APASS one), then without
  const exact = BANDS.filter((b) => b.endsWith(' ' + k.replace(/[_\-]+/g, ' ')));
  if (exact.length === 1) return { band: exact[0] };
  if (exact.length > 1) return { error: `"${k}" could be ${exact.join(', ')}: use the full band name` };
  const cands = BANDS.filter((b) => canon(b).endsWith(' ' + c));
  if (cands.length === 1) return { band: cands[0] };
  if (cands.length > 1) return { error: `"${k}" could be ${cands.join(', ')}: use the full band name` };
  return { error: `no passband "${k}"` };
}

/** [magnitude, error] from [m, e], { value|mag|magnitude, error|err|sigma|uncertainty }, or "m ± e". */
function pair(v) {
  if (Array.isArray(v)) return v.length >= 2 ? [num(v[0]), num(v[1])] : null;
  if (v && typeof v === 'object') {
    const pick = (...ks) => { for (const k of ks) if (v[k] !== undefined) return num(v[k]); return undefined; };
    let m = pick('value', 'mag', 'magnitude', 'm');
    const e = pick('error', 'err', 'sigma', 'uncertainty', 'e');
    if (m === undefined && e !== undefined) {  // { "G": 14.51, "error": 0.005 }: the one other number is the value
      const rest = Object.entries(v).filter(([k]) => !['error', 'err', 'sigma', 'uncertainty', 'e'].includes(k)).map(([, x]) => num(x));
      if (rest.length === 1 && Number.isFinite(rest[0])) m = rest[0];
    }
    return m === undefined || e === undefined ? null : [m, e];
  }
  if (typeof v === 'string') { const m = v.split(/\s*(?:±|\+\/-|\+-)\s*/); return m.length === 2 && NUM.test(m[0]) && NUM.test(m[1]) ? [Number(m[0]), Number(m[1])] : null; }
  return null;
}

const MAG_EXAMPLE = '{"magnitudes": {"Gaia G": [11.19, 0.003], "2MASS J": [10.12, 0.02], "2MASS Ks": [9.80, 0.018]}, "parallax": [4.73, 0.11]}';

/**
 * The observations of star_fit as core wants them ([{ band, mag, err }]) from the documented band -> [mag, err]
 * object, or the same with { value, error } values, or an array of { band, mag, err }. Throws with what was wrong.
 */
export function magnitudesOf(m) {
  let entries;
  if (Array.isArray(m)) entries = m.map((x) => [x && (x.band ?? x.name ?? x.passband), x && (Array.isArray(x.value) ? x.value : x)]);
  else if (m && typeof m === 'object') entries = Object.entries(m);
  else throw new Error(`magnitudes must be an object of band name -> [magnitude, error]; got ${show(m)}. Example call: ${MAG_EXAMPLE}`);
  const obs = [], bad = [];
  for (const [key, v] of entries) {
    const b = bandOf(key ?? ''), p = pair(v);
    if (b.error) { bad.push(b.error); continue; }
    if (!p || !Number.isFinite(p[0]) || !(p[1] >= 0)) { bad.push(`${b.band}: give [magnitude, error] as two numbers; got ${show(v)}`); continue; }
    if (obs.some((o) => o.band === b.band)) { bad.push(`${b.band} is given twice`); continue; }
    obs.push({ band: b.band, mag: p[0], err: p[1] });
  }
  if (bad.length) throw new Error(`${bad.join('; ')}. Bands: ${BANDS.join(', ')}. Example call: ${MAG_EXAMPLE}`);
  if (obs.length < 3) throw new Error(`an SED fit needs at least three magnitudes; got ${obs.length} (${obs.map((o) => o.band).join(', ') || 'none'}). Example call: ${MAG_EXAMPLE}`);
  return obs;
}

/** [value, sigma] from [value, sigma] or { value, error }; warns when the error exceeds the value (a swapped pair?). */
export function pairArg(name, v, unit, warnings) {
  if (v === undefined) return undefined;
  const p = pair(v);
  if (!p || !Number.isFinite(p[0]) || !(p[1] >= 0)) throw new Error(`${name} must be [value, error]${unit ? ` in ${unit}` : ''} (or { "value": ..., "error": ... }); got ${show(v)}`);
  if (name === 'parallax' && p[1] > p[0] && p[0] > 0) warnings.push(`parallax [${p[0]}, ${p[1]}]: the error is larger than the parallax. The order is [value, error]; if they were swapped, call again with { "value": ${p[1]}, "error": ${p[0]} }.`);
  return p;
}

// ---- the atmosphere tools: world, planet, priors ---------------------------------------------------------------
/** The request's world and model after the unit aliases (pRef_mbar) and the checks a model has to pass. */
export function atmosphereRequest(args, worldNames, { name = 'atmosphere_spectrum' } = {}) {
  const warnings = [], out = { ...args };
  if (out.world !== undefined && !worldNames.includes(out.world)) {
    const w = String(out.world), hit = worldNames.find((n) => canon(n) === canon(w));
    if (hit) out.world = hit;
    else throw new Error(`no world "${w}": world only takes a preset (${worldNames.join('; ')}). To model another planet, leave world out and give its values in model: {"model": {"planet": {"mplanet": 1.19, "rplanet": 1.23, "pRef": 0.01}, "star": {"rstar": 1.02, "teff": 5659, "ars": 7.83}, "tp": {"kind": "guillot", "teq": 1429}}}${out.planet_name ? '' : ', and its name in planet_name'}.`);
  }
  const m = out.model && typeof out.model === 'object' && !Array.isArray(out.model) ? { ...out.model } : out.model;
  if (m !== undefined && (typeof m !== 'object' || Array.isArray(m))) throw new Error(`model must be an object (a model, or changes to the world's); got ${show(m)}`);
  if (m && m.planet && typeof m.planet === 'object') {
    const p = { ...m.planet };
    if (p.pRef_mbar !== undefined) {
      const mb = num(p.pRef_mbar);
      if (!(mb > 0)) throw new Error(`model.planet.pRef_mbar must be a positive number of millibar; got ${show(p.pRef_mbar)}`);
      if (p.pRef !== undefined && Math.abs(p.pRef - mb / 1000) > 1e-9 * (mb / 1000)) throw new Error(`model.planet gives both pRef ${p.pRef} bar and pRef_mbar ${mb} (= ${mb / 1000} bar): give one`);
      p.pRef = mb / 1000; delete p.pRef_mbar;
    }
    if (p.pRef > 1) warnings.push(`pRef = ${p.pRef} bar: the radius is taken at ${p.pRef} bar. Transit radii are usually quoted at 1 to 100 mbar; if this one was given at ${p.pRef} mbar, use pRef ${p.pRef / 1000} (bar) or pRef_mbar ${p.pRef}.`);
    m.planet = p;
  }
  if (m) out.model = m;
  if (!out.world) {
    const p = (m && m.planet) || {}, need = [['mplanet', 'M_Jup'], ['rplanet', 'R_Jup'], ['pRef', 'bar']], wrong = need.filter(([k]) => p[k] !== undefined && !(typeof p[k] === 'number' && p[k] > 0));
    if (wrong.length) throw new Error(`model.planet: ${wrong.map(([k, u]) => `${k} must be a positive number in ${u}; got ${show(p[k])}`).join('; ')}. Example: {"model": {"planet": {"mplanet": 1.19, "rplanet": 1.23, "pRef": 0.01}}}`);
  }
  if (name === 'atmosphere_retrieve' && out.priors && typeof out.priors === 'object') {
    const pr = {};
    for (const [k, v] of Object.entries(out.priors)) {
      let r = v;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const lo = num(v.low ?? v.min ?? v.a), hi = num(v.high ?? v.max ?? v.b);
        if (v.type && v.type !== 'uniform') { pr[k] = v; continue; }
        r = [lo, hi];
      }
      if (!Array.isArray(r) || r.length !== 2 || !r.every((x) => Number.isFinite(num(x)))) throw new Error(`the prior of ${k} must be [low, high] (two numbers, low < high); got ${show(v)}. Example: {"priors": {"teq": [800, 1600]}}`);
      r = r.map(num);
      if (!(r[1] > r[0])) throw new Error(`the prior of ${k} must be [low, high] with low < high; got [${r[0]}, ${r[1]}]${r[1] < r[0] ? `: did you mean [${r[1]}, ${r[0]}]?` : `: to hold ${k} at ${r[0]}, leave it out of free and set it in model`}`);
      pr[k] = r;
    }
    out.priors = pr;
  }
  return { args: out, warnings };
}
