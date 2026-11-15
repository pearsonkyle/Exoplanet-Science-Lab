// System parameters from a static snapshot of the NASA Exoplanet Archive `ps` table (every published reference
// per planet), built by tools/build_catalog.py into public/catalog/. The archive's TAP service has no CORS
// headers, so the browser reads the snapshot instead.
//
// No DOM here: the caller passes `fetchJson(name)` which resolves 'index.json' or 'shard-012.json' to parsed JSON.
//
// A "row" is one archive row as a plain object keyed by the archive's column names (pl_orbper, pl_orbpererr1, ...)
// plus pl_ref / pl_refurl / st_ref / st_refurl (short labels and ADS links) and `lim` ({column: true} where the
// archive flags the value as a limit). Archive units: pl_trandur hours, pl_trandep percent, pl_orbsmax au,
// st_dens g/cm^3, pl_rvamp m/s, masses and radii in Jupiter / solar units, angles in degrees.
//
// Selection: the archive's default row is not always the most useful one, and the newest paper is not always
// the most self-consistent. Each reference is scored by completeness for the intended use, then by how well its
// own numbers obey Kepler's third law and transit geometry, and only then by date.
//
// Conventions follow the rest of ESL: mid-transit = inferior conjunction, omega [deg] as pylightcurve / EXOTIC
// use the archive's pl_orblper (transit where omega + nu = 90 deg), b = a/R* cos i (1 - e^2) / (1 + e sin omega).

import { C } from './derive.js';
import { eventTimes, meanAnomalyAtTransit } from './kepler.js';

const DEG = Math.PI / 180, TWO_PI = 2 * Math.PI;
const fin = Number.isFinite;

// ------------------------------------------------------------------------------------------------ names

/** Lowercase and strip everything but letters and digits, so "hat-p-32b" matches "HAT-P-32 b". */
export function normalizeName(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Load the catalogue index and build its lookup tables.
 * fetchJson(name) -> Promise of parsed JSON for a file in the catalogue folder.
 * Returns { date, rows, nplanets, nhosts, nshards, hosts: [{name, shard, aliases, planets}], planets: [{name, host, transit, rv}], ... }.
 */
export async function loadIndex(fetchJson) {
  const raw = await fetchJson('index.json');
  if (!raw || raw.v !== 1) throw new Error('catalog index: unknown format');
  const hosts = raw.hosts.map(([name, shard, ...aliases]) => ({ name, shard, aliases, planets: [] }));
  const planets = raw.planets.map(([name, h, flags]) => {
    const p = { name, host: hosts[h].name, hostIndex: h, transit: !!(flags & 1), rv: !!(flags & 2) };
    hosts[h].planets.push(name);
    return p;
  });
  // `exact` is consulted first: a few names differ only by case ("55 Cnc B" is a star, "55 Cnc b" a planet)
  const byName = new Map(), exact = new Map(), names = [];
  const add = (label, entry) => { const k = normalizeName(label); if (!k || exact.has(label)) return; exact.set(label, entry); names.push({ key: k, label, ...entry }); if (!byName.has(k)) byName.set(k, entry); };
  // planets first so that an exact planet name wins over a host alias that normalises the same way
  for (const p of planets) add(p.name, { type: 'planet', planet: p.name, host: p.host, hostIndex: p.hostIndex, transit: p.transit, rv: p.rv });
  for (let h = 0; h < hosts.length; h++) add(hosts[h].name, { type: 'host', planet: null, host: hosts[h].name, hostIndex: h });
  for (let h = 0; h < hosts.length; h++) for (const a of hosts[h].aliases) add(a, { type: 'alias', planet: null, host: hosts[h].name, hostIndex: h });
  return { date: raw.date, source: raw.source, rows: raw.rows, nplanets: planets.length, nhosts: hosts.length, nshards: raw.nshards,
    shardPattern: raw.shard || 'shard-{id}.json', hosts, planets, byName, exact, names, cache: new Map() };
}

/**
 * Autocomplete: names whose normalised form starts with the query, then names that contain it.
 * Returns [{ label, type: 'planet'|'host'|'alias', planet, host, transit, rv }].
 */
export function searchNames(index, query, limit = 12) {
  const q = normalizeName(query);
  if (!q) return [];
  const starts = [], inside = [];
  for (const n of index.names) {
    const i = n.key.indexOf(q);
    if (i === 0) starts.push(n); else if (i > 0 && inside.length < limit) inside.push(n);
  }
  // shortest first: "WASP-1 b" before "WASP-10 b" for the query "wasp1"
  starts.sort((a, b) => a.key.length - b.key.length || (a.key < b.key ? -1 : 1));
  return starts.concat(inside).slice(0, limit).map(({ key, hostIndex, ...rest }) => rest);
}

/** Resolve a typed name to { host, hostIndex, planet|null }, or null. Accepts planet names, host names and HD / HIP / TIC aliases (with or without a planet letter). */
export function resolveName(index, name) {
  const k = normalizeName(name), hit = index.exact.get(String(name).trim()) || index.byName.get(k);
  if (hit) return { host: hit.host, hostIndex: hit.hostIndex, planet: hit.planet };
  // "HD 209458b" typed against an alias: split off the letter and look for that planet of the aliased host
  const m = /^(.*\d)([b-z])$/.exec(k), h = m && index.byName.get(m[1]);
  if (h && !h.planet) {
    const pl = index.hosts[h.hostIndex].planets.find((p) => p.endsWith(' ' + m[2]));
    if (pl) return { host: h.host, hostIndex: h.hostIndex, planet: pl };
  }
  return null;
}

function expandHost(shard, rec) {
  const { columns, lim, refs, strs } = shard, at = {};
  columns.forEach((c, i) => (at[c] = i));
  const rows = rec.r.map((r) => {
    const o = { pl_name: rec.pl[r[at.pl]], hostname: rec.n };
    o.pl_letter = / ([a-z])$/.test(o.pl_name) ? o.pl_name.slice(-1) : '';
    const pr = refs[r[at.pl_ref]] || ['', ''], sr = refs[r[at.st_ref]] || ['', ''];
    o.pl_ref = pr[0]; o.pl_refurl = pr[1]; o.st_ref = sr[0]; o.st_refurl = sr[1];
    o.lim = {};
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i], v = r[i];
      if (v == null || c === 'pl' || c === 'pl_ref' || c === 'st_ref') continue;
      if (c === 'lim') { lim.forEach((n, k) => { if (v & (1 << k)) o.lim[n] = true; }); continue; }
      o[c] = c === 'soltype' || c === 'pl_bmassprov' || c === 'pl_tsystemref' ? strs[v] : v;
    }
    return o;
  });
  return { host: rec.n, system: rec.sy || {}, planets: rec.pl.slice(), rows };
}

/**
 * Every archive row for every planet of the host that `name` (a planet, host or alias) belongs to.
 * Returns { host, planet (the planet that was named, or null), planets: [names], system: {ra, dec, sy_dist, ...},
 * rows: [row objects], snapshot: date } or null when the name is not in the catalogue.
 */
export async function lookupHost(index, name, fetchJson) {
  const r = resolveName(index, name);
  if (!r) return null;
  const id = index.hosts[r.hostIndex].shard;
  if (!index.cache.has(id)) index.cache.set(id, Promise.resolve(fetchJson(index.shardPattern.replace('{id}', String(id).padStart(3, '0')))));
  const shard = await index.cache.get(id);
  const rec = shard.hosts.find((h) => h.n === r.host);
  if (!rec) throw new Error(`catalog: ${r.host} missing from shard ${id} (index and shards from different snapshots?)`);
  return { ...expandHost(shard, rec), planet: r.planet, snapshot: index.date };
}

// ------------------------------------------------------------------------------------------------ physics

const KEPLER_K = C.GMsun * C.day * C.day / (4 * Math.PI * Math.PI);          // a^3 = KEPLER_K * M[Msun] * P[d]^2, in m^3
/** a/R* from Kepler's third law. M in Msun (star + planet), R in Rsun, P in days. */
export const arsKepler = (M, R, P) => Math.cbrt(KEPLER_K * M * P * P) / (R * C.Rsun);
/** Mean stellar density [g/cm^3] implied by a/R* and P: rho = 3 pi (a/R*)^3 / (G P^2), neglecting the planet's mass. */
export const rhoFromArs = (ars, P) => (3 * Math.PI * ars ** 3) / (C.G * (P * C.day) ** 2) / 1000;
/** Mean density [g/cm^3] of a star of M [Msun], R [Rsun]. */
export const rhoFromMR = (M, R) => (M * C.GMsun / C.G) / ((4 / 3) * Math.PI * (R * C.Rsun) ** 3) / 1000;
/** log10 of surface gravity in cgs from M [Msun], R [Rsun]. */
export const loggFromMR = (M, R) => Math.log10((C.GMsun * M) / (R * C.Rsun) ** 2 * 100);
/** Impact parameter of the transit. inc, omega in degrees. */
export const impactParameter = (ars, inc, e = 0, w = 0) => ars * Math.cos(inc * DEG) * (1 - e * e) / (1 + e * Math.sin(w * DEG));
/** RV semi-amplitude [m/s]. m [Mjup] is the true mass when sinI is given, or M sin i with sinI = 1. */
export function rvAmplitude(m, P, e, sinI, mstar) {
  const mp = m * C.Mjup_Msun;
  return Math.cbrt((TWO_PI * C.GMsun) / (P * C.day)) * (mp * sinI) / Math.pow(mstar + mp, 2 / 3) / Math.sqrt(1 - e * e);
}
/** Full (first to fourth contact) transit duration [days], numerically exact for any eccentricity; 0 if there is no transit. */
export function transitDuration(per, ars, inc, rprs, e = 0, w = 0) {
  return eventTimes({ per, tmid: 0, ars, inc, rprs, ecc: e, omega: w }).t14;
}

// Error of f at the point x (array of numbers) from independent 1-sigma errors, by central differences.
function propagate(f, x, errs, clamp) {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const h = errs[i];
    if (!(h > 0)) continue;
    const up = x.slice(), dn = x.slice();
    up[i] += h; dn[i] -= h;
    if (clamp) { clamp(up); clamp(dn); }
    const d = (f(...up) - f(...dn)) / 2;
    if (fin(d)) s += d * d;
  }
  return Math.sqrt(s);
}

// ------------------------------------------------------------------------------------------------ one reference

// archive column -> internal name; scale converts to ESL units
const QUANT = {
  per: ['pl_orbper'], tmid: ['pl_tranmid'], tperi: ['pl_orbtper'], aAU: ['pl_orbsmax'], ars: ['pl_ratdor'], rprs: ['pl_ratror'],
  depth: ['pl_trandep', 0.01], t14: ['pl_trandur', 1 / 24], b: ['pl_imppar'], inc: ['pl_orbincl'], ecc: ['pl_orbeccen'], omega: ['pl_orblper'],
  K: ['pl_rvamp'], mass: ['pl_bmassj'], msini: ['pl_msinij'], rp: ['pl_radj'], teq: ['pl_eqt'],
  teff: ['st_teff'], logg: ['st_logg'], feh: ['st_met'], mstar: ['st_mass'], rstar: ['st_rad'], rho: ['st_dens'],
};
const STAR_KEYS = ['teff', 'logg', 'feh', 'rstar', 'mstar'];
const STAR_COLS = ['rho', ...STAR_KEYS];
const PLANET_KEYS = ['per', 'tmid', 'rprs', 'ars', 'inc', 'ecc', 'omega', 'mplanet', 't14', 'b', 'K'];

const pubYear = (s) => { const m = /^(\d{4})(?:-(\d{2}))?/.exec(s || ''); return m ? +m[1] + ((m[2] ? +m[2] : 6.5) - 0.5) / 12 : NaN; };

// One quantity from a row: { value, err, errUp, errDown } in ESL units, or null. Values flagged as limits are
// kept apart (`limit: true`): an upper limit on e is not a measurement of e.
function quantity(row, key) {
  const [col, scale = 1] = QUANT[key], v = row[col];
  if (!fin(v)) return null;
  const up = Math.abs(row[col + 'err1']), dn = Math.abs(row[col + 'err2']);
  const err = fin(up) && fin(dn) ? (up + dn) / 2 : fin(up) ? up : fin(dn) ? dn : null;
  const q = { value: v * scale, err: err == null ? null : err * scale };
  if (fin(up) && fin(dn) && up !== dn) { q.errUp = up * scale; q.errDown = dn * scale; }
  if (row.lim && row.lim[col]) q.limit = true;
  return q;
}

// Merge the rows that share a planet reference into one bag of quantities (first row wins; the caller sorts).
function bagFromRows(rows) {
  const r0 = rows.find((r) => r.default_flag === 1) || rows[0];
  const bag = { ref: r0.pl_ref || '(no reference)', url: r0.pl_refurl || '', stRef: r0.st_ref || '', stUrl: r0.st_refurl || '', pubdate: r0.pl_pubdate || '', year: pubYear(r0.pl_pubdate),
    isDefault: rows.some((r) => r.default_flag === 1), transit: rows.some((r) => r.tran_flag === 1), rvFlag: rows.some((r) => r.rv_flag === 1),
    soltype: r0.soltype || '', controversial: rows.some((r) => r.pl_controv_flag === 1), tsys: '', massProv: '', q: {}, limits: {} };
  for (const r of [r0, ...rows.filter((x) => x !== r0)]) {
    for (const key of Object.keys(QUANT)) {
      if (STAR_COLS.includes(key) && (r.st_ref || '') !== bag.stRef) continue;         // never blend two stellar references
      const q = quantity(r, key);
      if (!q) continue;
      if (q.limit) { bag.limits[key] ??= q; continue; }
      if (!bag.q[key]) {
        bag.q[key] = q;
        if (key === 'tmid') bag.tsys = r.pl_tsystemref || '';
        if (key === 'mass') bag.massProv = r.pl_bmassprov || '';
      }
    }
  }
  // unphysical placeholders some tables carry
  for (const k of ['per', 'ars', 'rprs', 'depth', 't14', 'K', 'mass', 'rp', 'mstar', 'rstar', 'teff', 'aAU', 'rho']) if (bag.q[k] && !(bag.q[k].value > 0)) delete bag.q[k];
  bag.sameStar = !!bag.stRef && bag.stRef === bag.ref;
  return bag;
}

// ---- consistency checks ---------------------------------------------------------------------------------------

const SIG_OK = 3, SIG_WARN = 5;
const f4 = (x) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : String(+x.toPrecision(5)));

// Agreement of a reported value with a computed one, in sigma. Each side's uncertainty is at least `floor`
// (fractional) or `abs`, so that two values quoted without errors, or with optimistic ones, are not failed for
// differing in the third digit.
function compare(name, label, rep, comp, { floor = 0.02, abs = 0, unit = '', extra = '' } = {}) {
  const s1 = Math.max(rep.err || 0, floor * Math.abs(rep.value), abs), s2 = Math.max(comp.err || 0, floor * Math.abs(comp.value), abs);
  const sigma = Math.hypot(s1, s2), n = Math.abs(rep.value - comp.value) / sigma;
  const frac = comp.value !== 0 ? (rep.value - comp.value) / Math.abs(comp.value) : NaN;
  const status = n <= SIG_OK ? 'ok' : n <= SIG_WARN ? 'warn' : 'fail';
  const u = unit ? ' ' + unit : '';
  return { name, status, nsigma: n, reported: rep.value, computed: comp.value,
    detail: `${label}: reported ${f4(rep.value)}${rep.err ? ' ± ' + f4(rep.err) : ''}${u}, computed ${f4(comp.value)}${comp.err ? ' ± ' + f4(comp.err) : ''}${u}` +
      ` (${fin(frac) ? (frac >= 0 ? '+' : '') + (100 * frac).toFixed(1) + '%, ' : ''}${n.toFixed(1)} sigma with a ${abs ? abs + u + ' / ' : ''}${(100 * floor).toFixed(0)}% floor)${extra ? '; ' + extra : ''}` };
}

/**
 * Physical consistency of one set of quantities. `q` maps internal names (per, ars, aAU, rprs, depth, t14, b, inc,
 * ecc, omega, K, mass, rp, logg, mstar, rstar, rho) to { value, err, derived? }. A quantity marked `derived` is used
 * as an input but never as the "reported" side of a comparison (it would agree with itself).
 * meta: { transit: bool, massProv: 'Mass'|'Msini'|..., starNote / orbitNote: text appended to the checks that use stellar values / e and omega }.
 * Returns [{ name, status: 'ok'|'warn'|'fail', detail, nsigma?, reported?, computed? }]; checks whose inputs are missing are not listed.
 */
export function runChecks(q, meta = {}) {
  const out = [], v = (k) => (q[k] ? q[k].value : NaN), s = (k) => (q[k] && q[k].err) || 0, rep = (k) => q[k] && !q[k].derived && fin(q[k].value);
  const e = fin(v('ecc')) ? v('ecc') : 0, w = fin(v('omega')) ? v('omega') : 0, P = v('per'), M = v('mstar'), R = v('rstar');
  const star = meta.starNote || '';
  const mTot = M + (fin(v('mass')) ? v('mass') * C.Mjup_Msun : 0);

  // eccentricity range first: everything below assumes a bound orbit
  if (q.ecc && fin(q.ecc.value)) {
    const bad = !(e >= 0 && e < 1);
    out.push({ name: 'eccentricity', status: bad ? 'fail' : 'ok', fatal: bad, detail: bad ? `e = ${f4(e)} is outside [0, 1)` : `e = ${f4(e)} is in [0, 1)` + (e > 0 && !q.omega ? ', but no argument of periastron is given' : '') });
    if (!bad && e > 0.05 && !q.omega) out[out.length - 1].status = 'warn';
    if (bad) return out;
  }

  if (rep('ars') && fin(P) && fin(M) && fin(R)) {
    const comp = { value: arsKepler(mTot, R, P), err: 0 };
    comp.err = comp.value * Math.hypot(s('mstar') / (3 * M), s('rstar') / R);
    out.push(compare('kepler', "a/R* vs Kepler's third law (P, M*, R*)", q.ars, comp, { floor: 0.02, extra: star }));
    const r1 = { value: rhoFromArs(v('ars'), P), err: 0 }, r2 = { value: rhoFromMR(M, R), err: 0 };
    r1.err = r1.value * 3 * s('ars') / v('ars'); r2.err = r2.value * Math.hypot(s('mstar') / M, 3 * s('rstar') / R);
    out.push(compare('density', 'stellar density from a/R* and P vs from M*, R*', r1, r2, { floor: 0.06, unit: 'g/cm^3', extra: star }));
  }
  if (rep('rho') && fin(M) && fin(R)) {
    const r2 = { value: rhoFromMR(M, R), err: 0 }; r2.err = r2.value * Math.hypot(s('mstar') / M, 3 * s('rstar') / R);
    out.push(compare('density-reported', 'reported stellar density vs M*, R*', q.rho, r2, { floor: 0.06, unit: 'g/cm^3' }));
  }
  if (rep('logg') && fin(M) && fin(R)) {
    const comp = { value: loggFromMR(M, R), err: Math.hypot(s('mstar') / M, 2 * s('rstar') / R) / Math.LN10 };
    out.push(compare('logg', 'log g vs M*, R*', q.logg, comp, { floor: 0, abs: 0.05, unit: 'dex' }));
  }
  if (rep('aAU') && rep('ars') && fin(R)) {
    const comp = { value: v('ars') * R * C.Rsun / C.AU, err: 0 }; comp.err = comp.value * Math.hypot(s('ars') / v('ars'), s('rstar') / R);
    out.push(compare('semi-major-axis', 'a vs (a/R*) R*', q.aAU, comp, { floor: 0.02, unit: 'au', extra: star }));
  }

  const k = fin(v('rprs')) ? v('rprs') : fin(v('depth')) ? Math.sqrt(v('depth')) : fin(v('rp')) && fin(R) ? v('rp') * C.Rjup / (R * C.Rsun) : NaN;
  const haveGeom = fin(v('ars')) && fin(v('inc'));
  let bComp = NaN;
  if (haveGeom) {
    const args = [v('ars'), v('inc'), e, w], errs = [s('ars'), s('inc'), s('ecc'), s('omega')];
    const clamp = (x) => { if (args[1] <= 90 && x[1] > 90) x[1] = 90; x[2] = Math.min(Math.max(x[2], 0), 0.999); };
    bComp = Math.abs(impactParameter(...args));
    if (rep('b')) out.push(compare('impact', 'impact parameter vs a/R*, i, e, omega', q.b, { value: bComp, err: propagate((...x) => Math.abs(impactParameter(...x)), args, errs, clamp) }, { floor: 0.02, abs: 0.03, extra: meta.orbitNote || '' }));
  }
  if (rep('t14') && haveGeom && fin(P) && fin(k)) {
    const args = [P, v('ars'), v('inc'), k, e, w], errs = [0, s('ars'), s('inc'), s('rprs'), s('ecc'), s('omega')];
    const clamp = (x) => { if (x[2] > 90) x[2] = 90; x[4] = Math.min(Math.max(x[4], 0), 0.999); };
    const comp = { value: transitDuration(...args), err: propagate(transitDuration, args, errs, clamp) };
    out.push(compare('duration', 'transit duration T14 vs P, a/R*, i, Rp/R*, e, omega', q.t14, comp, { floor: 0.05, unit: 'd', extra: meta.orbitNote || '' }));
  }
  if (rep('depth') && rep('rprs')) {
    // a quoted depth may be the limb-darkened mid-transit depth, deeper than (Rp/R*)^2, so the floor is generous
    const comp = { value: v('rprs') ** 2, err: 2 * v('rprs') * s('rprs') };
    out.push(compare('depth', 'transit depth vs (Rp/R*)^2', q.depth, comp, { floor: 0.1 }));
  }
  if (rep('rprs') && fin(v('rp')) && fin(R)) {
    const comp = { value: v('rp') * C.Rjup / (R * C.Rsun), err: 0 }; comp.err = comp.value * Math.hypot(s('rp') / v('rp'), s('rstar') / R);
    out.push(compare('radius-ratio', 'Rp/R* vs Rp and R*', q.rprs, comp, { floor: 0.03, extra: star }));
  }
  if (rep('K') && fin(v('mass')) && !q.mass.derived && fin(P) && fin(M) && /^(Mass|Msini|Msin\(i\)\/sin\(i\))$/.test(meta.massProv || '')) {
    const isMsini = meta.massProv === 'Msini', sinI = isMsini ? 1 : fin(v('inc')) ? Math.sin(v('inc') * DEG) : meta.transit ? 1 : NaN;
    if (fin(sinI)) {
      const f = (m, ms, ee) => rvAmplitude(m, P, Math.min(Math.max(ee, 0), 0.999), sinI, ms);
      const comp = { value: f(v('mass'), M, e), err: propagate(f, [v('mass'), M, e], [s('mass'), s('mstar'), s('ecc')]) };
      out.push(compare('rv-amplitude', `K vs ${isMsini ? 'M sin i' : 'mass and i'}, P, e, M*`, q.K, comp, { floor: 0.03, unit: 'm/s', extra: star }));
    }
  }

  // geometry
  if (fin(v('ars'))) {
    if (v('ars') * (1 - e) < 1) out.push({ name: 'periastron', status: 'fail', fatal: true, detail: `periastron distance a/R* (1 - e) = ${f4(v('ars') * (1 - e))} is inside the star` });
    else if (v('ars') * (1 - e) < 1.5) out.push({ name: 'periastron', status: 'warn', detail: `periastron distance a/R* (1 - e) = ${f4(v('ars') * (1 - e))} is very close to the stellar surface` });
  }
  if (meta.transit) {
    const b = fin(bComp) ? bComp : rep('b') ? Math.abs(v('b')) : NaN, kk = fin(k) ? k : 0;
    if (fin(b)) {
      const how = fin(bComp) ? 'from a/R* and i' : 'reported';
      if (b > 1 + kk) out.push({ name: 'geometry', status: 'fail', fatal: true, detail: `b = ${f4(b)} (${how}) is larger than 1 + Rp/R* = ${f4(1 + kk)}: with these values the planet does not transit, yet the archive lists it as transiting` });
      else if (b > 1 - kk) out.push({ name: 'geometry', status: 'warn', detail: `grazing transit: b = ${f4(b)} (${how}) is between 1 - Rp/R* = ${f4(1 - kk)} and 1 + Rp/R* = ${f4(1 + kk)}; depth and Rp/R* are then degenerate` });
      else out.push({ name: 'geometry', status: 'ok', detail: `b = ${f4(b)} (${how}) < 1 - Rp/R* = ${f4(1 - kk)}: full transit` });
    }
    if (fin(v('inc')) && v('inc') > 90.0001) out.push({ name: 'inclination', status: 'warn', detail: `i = ${f4(v('inc'))} deg is above 90; ESL uses the mirror solution 180 - i` });
  }
  return out;
}

// ---- completeness and score -----------------------------------------------------------------------------------

// weight of each ESL key for each use; the stellar ones matter to a transit fit through limb darkening and derived quantities
const WEIGHTS = {
  // (e counts little for a transit: most transit papers fix e = 0 and the archive then leaves the column empty)
  transit: { per: 3, tmid: 3, rprs: 3, ars: 3, inc: 2, ecc: 0.5, omega: 0.5, teff: 1, logg: 0.5, feh: 0.5, rstar: 0.5, mstar: 0.5 },
  rv: { per: 3, K: 3, ecc: 2, omega: 1, tmid: 1.5, mstar: 1.5, mplanet: 1 },
  ephemeris: { per: 3, tmid: 3 },
  all: { per: 3, tmid: 3, rprs: 3, ars: 3, inc: 2, ecc: 1.5, omega: 1, K: 2, mplanet: 1, teff: 1, logg: 0.5, feh: 0.5, rstar: 1, mstar: 1 },
};

// How well a reference supplies an ESL key: 1 reported, less when it can only be derived from its other numbers, 0 not at all.
function supplies(bag, key) {
  const q = bag.q, has = (k) => !!q[k];
  switch (key) {
    case 'rprs': return has('rprs') ? 1 : has('depth') ? 0.8 : has('rp') && has('rstar') ? 0.7 : 0;
    case 'ars': return has('ars') ? 1 : has('aAU') && has('rstar') ? 0.85 : has('per') && ((has('mstar') && has('rstar')) || has('rho')) ? 0.7 : 0;
    case 'inc': return has('inc') ? 1 : has('b') && supplies(bag, 'ars') ? 0.8 : 0;
    case 'omega': return has('omega') ? 1 : !has('ecc') || q.ecc.value === 0 ? 0.5 : 0;         // not needed for a circular orbit
    case 'tmid': return has('tmid') ? 1 : has('tperi') && has('ecc') && has('omega') ? 0.7 : 0;
    case 'mplanet': return has('mass') || has('msini') ? 1 : 0;
    case 'K': return has('K') ? 1 : (has('mass') || has('msini')) && has('mstar') ? 0.6 : 0;
    case 'logg': return has('logg') ? 1 : has('mstar') && has('rstar') ? 0.8 : 0;
    // a period known to worse than 1% (a single transit, a placeholder) is hardly a period
    case 'per': return !has('per') ? 0 : q.per.err / q.per.value > 0.01 ? 0.3 : 1;
    default: return has(key) ? 1 : 0;
  }
}
const ERR_OF = { mplanet: 'mass' };
function completeness(bag, use) {
  const w = WEIGHTS[use] || WEIGHTS.transit, missing = [];
  // a value without an uncertainty is worth less: no prior width can be based on it. For an ephemeris the errors are half the point.
  const errShare = use === 'ephemeris' ? 0.5 : 0.15;
  let got = 0, tot = 0;
  for (const [key, wt] of Object.entries(w)) {
    const c = supplies(bag, key), qq = bag.q[ERR_OF[key] || key], hasErr = qq && qq.err > 0;
    tot += wt; got += wt * c * (c === 1 && !hasErr ? 1 - errShare : 1);
    if (c === 0) missing.push(key);
  }
  return { value: got / tot, missing };
}

function scoreBag(bag, use, yearRange, orbit) {
  // A reference that quotes no eccentricity (a homogeneous re-analysis, say) must not be failed for a geometry
  // that is only wrong at e = 0: the checks then borrow e and omega from the reference that does give them.
  let q = bag.q, borrowed = '';
  if (!q.ecc && orbit && orbit.ecc.value > 0.02) {
    q = { ...q, ecc: { ...orbit.ecc, derived: true }, omega: q.omega || { ...orbit.omega, derived: true } };
    borrowed = `e = ${f4(orbit.ecc.value)}, omega = ${f4(orbit.omega.value)} deg taken from ${orbit.ref}`;
  }
  const star = bag.sameStar || !bag.stRef ? '' : `stellar values on this row are from ${bag.stRef}`;
  const checks = runChecks(q, { transit: bag.transit, massProv: bag.massProv, starNote: [star, borrowed].filter(Boolean).join('; '), orbitNote: borrowed });
  const comp = completeness(bag, use);
  const nOk = checks.filter((c) => c.status === 'ok').length, warned = checks.filter((c) => c.status === 'warn'), failed = checks.filter((c) => c.status === 'fail');
  // consistency: a failure outweighs a couple of missing secondary values; passing checks earn a little, because
  // a reference that can be verified is better than one that merely cannot be faulted
  // (an ephemeris hardly depends on the transit geometry, so there it counts for less)
  const consistency = (use === 'ephemeris' ? 0.3 : 1) * (-25 * failed.filter((c) => !c.fatal).length - 60 * failed.filter((c) => c.fatal).length - 8 * warned.length + 1.5 * Math.min(nOk, 6));
  const [y0, y1] = yearRange, recency = fin(bag.year) && y1 > y0 ? 3 * (bag.year - y0) / (y1 - y0) : 0;
  // small preferences: the archive's default, a star analysed in the same paper; against pipeline candidate tables and disputed planets
  let extra = (bag.isDefault ? 0.5 : 0) + (bag.sameStar ? 2 : 0) - (/Candidate/.test(bag.soltype) ? 12 : 0) - (bag.controversial ? 5 : 0);
  // for an ephemeris what matters after completeness is how well the period is pinned down
  if (use === 'ephemeris' && bag.q.per && bag.q.per.err > 0) extra += 3 * Math.min(6, Math.max(0, -Math.log10(bag.q.per.err / bag.q.per.value) - 4));
  return { bag, checks, completeness: comp.value, missing: comp.missing, consistency, recency, extra,
    score: 100 * comp.value + consistency + recency + extra, nOk, warned, failed };
}

// ------------------------------------------------------------------------------------------------ assembling values

const planetRows = (rows, planetName) => { const k = normalizeName(planetName); return rows.filter((r) => normalizeName(r.pl_name) === k); };

function groupByRef(rows) {
  const m = new Map();
  for (const r of rows) { const k = r.pl_ref || '(no reference)'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.values()].map(bagFromRows);
}

/**
 * Parameters for ONE planet from all the archive rows of its host.
 *
 * opts.use        'transit' (default) | 'rv' | 'ephemeris' | 'all': what the values are for; sets what "complete" means.
 * opts.reference  label of a reference to use instead of the best-scoring one (the UI's "pick another").
 * opts.star       { reference, url, values: {teff, logg, feh, rstar, mstar: {value, err}} } to share one star between
 *                 planets (see systemFromRows); overrides the stellar values of the chosen row.
 *
 * Returns { planet, host, reference: {label, url, pubdate, stellar, isDefault, score, why}, values, checks, alternatives, missing }.
 * values[key] = { value, err, source, kind, note } with kind 'reference' (the chosen reference), 'other' (another
 * reference, named in source), 'derived' (computed; note says from what) or 'default' (assumed).
 * checks are run on the assembled values; alternatives lists every reference with score, completeness and failed checks.
 */
export function chooseParameters(rows, planetName, opts = {}) {
  const use = WEIGHTS[opts.use] ? opts.use : 'transit';
  const mine = planetRows(rows, planetName);
  if (!mine.length) return null;
  const bags = groupByRef(mine), years = bags.map((b) => b.year).filter(fin);
  const range = [Math.min(...years), Math.max(...years)];
  // the best-determined eccentric orbit among the references, for those that do not quote one
  const ecc = bags.filter((b) => b.q.ecc && b.q.omega).sort((a, b) => (a.q.ecc.err || 1) - (b.q.ecc.err || 1) || b.year - a.year)[0];
  const orbit = ecc && { ecc: ecc.q.ecc, omega: ecc.q.omega, ref: ecc.ref };
  const scored = bags.map((b) => scoreBag(b, use, range, orbit)).sort((a, b) => b.score - a.score || b.bag.year - a.bag.year);
  const pick = (opts.reference && scored.find((s) => s.bag.ref === opts.reference)) || scored[0];
  const B = pick.bag, others = scored.filter((s) => s !== pick).map((s) => s.bag);

  const values = {}, V = (k) => (values[k] ? values[k].value : NaN), E = (k) => (values[k] && values[k].err) || 0;
  const put = (key, value, err, source, kind, note = '') => { values[key] = { value, err: err > 0 ? err : null, source, kind, note }; return true; };
  const own = (k) => values[k] && (values[k].kind === 'reference' || (values[k].kind === 'derived' && values[k].own));
  const src = (keys) => keys.map((k) => `${k}${values[k] && values[k].kind !== 'reference' ? ' (' + values[k].kind + (values[k].kind === 'other' ? ': ' + values[k].source : '') + ')' : ''}`).join(', ');
  const derive = (key, value, err, inputs, how) => { put(key, value, err, 'computed', 'derived', inputs.length ? `${how} from ${src(inputs)}` : how); values[key].own = inputs.every(own); return true; };
  const direct = (key, qk = key, note = '') => { const q = B.q[qk]; if (!q) return false; put(key, q.value, q.err, B.ref, 'reference', note); if (q.errUp) { values[key].errUp = q.errUp; values[key].errDown = q.errDown; } return true; };
  const fromOther = (key, qk = key, star = false) => {
    for (const o of others) { const q = o.q[qk]; if (q) return put(key, q.value, q.err, star ? o.stRef || o.ref : o.ref, 'other', `${B.ref} does not give it`); }
    return false;
  };

  // --- star: the shared one if given, else the chosen row's (which may itself be from another paper), else another row's
  for (const k of STAR_KEYS) {
    const sv = opts.star && opts.star.values && opts.star.values[k];
    if (sv && fin(sv.value)) put(k, sv.value, sv.err, opts.star.reference, opts.star.reference === B.ref ? 'reference' : 'other', opts.star.reference === B.ref ? '' : 'stellar set shared by all planets of this host');
    else if (B.q[k]) put(k, B.q[k].value, B.q[k].err, B.sameStar ? B.ref : B.stRef || B.ref, B.sameStar || !B.stRef ? 'reference' : 'other', B.sameStar || !B.stRef ? '' : `stellar values the archive attaches to the ${B.ref} row`);
  }
  // a missing one of M*, R*, log g follows from the other two (g = G M / R^2) before another paper is consulted
  const g2m = () => fin(V('logg')) && fin(V('rstar')) && derive('mstar', 10 ** V('logg') / 100 * (V('rstar') * C.Rsun) ** 2 / C.GMsun, 10 ** V('logg') / 100 * (V('rstar') * C.Rsun) ** 2 / C.GMsun * Math.hypot(Math.LN10 * E('logg'), 2 * E('rstar') / V('rstar')), ['logg', 'rstar'], 'M* = g R*^2 / G');
  const g2r = () => fin(V('logg')) && fin(V('mstar')) && derive('rstar', Math.sqrt(C.GMsun * V('mstar') / (10 ** V('logg') / 100)) / C.Rsun, Math.sqrt(C.GMsun * V('mstar') / (10 ** V('logg') / 100)) / C.Rsun * Math.hypot(Math.LN10 * E('logg') / 2, E('mstar') / (2 * V('mstar'))), ['logg', 'mstar'], 'R* = sqrt(G M* / g)');
  const mr2g = () => fin(V('mstar')) && fin(V('rstar')) && derive('logg', loggFromMR(V('mstar'), V('rstar')), Math.hypot(E('mstar') / V('mstar'), 2 * E('rstar') / V('rstar')) / Math.LN10, ['mstar', 'rstar'], 'log g = log10(G M* / R*^2)');
  if (!values.rstar) fromOther('rstar', 'rstar', true) || g2r();
  if (!values.mstar) g2m() || fromOther('mstar', 'mstar', true);
  if (!values.logg) mr2g() || fromOther('logg', 'logg', true);
  if (!values.teff) fromOther('teff', 'teff', true);
  if (!values.feh) fromOther('feh', 'feh', true) || put('feh', 0, null, 'assumed', 'default', 'no metallicity in any reference; solar assumed');

  // --- orbit shape
  if (!direct('ecc')) {
    const lim = B.limits.ecc;
    if (lim) put('ecc', 0, null, 'assumed', 'default', `${B.ref} gives only a limit, e < ${f4(lim.value)}; circular orbit assumed`);
    else if (!fromOther('ecc')) put('ecc', 0, null, 'assumed', 'default', 'no eccentricity in any reference; circular orbit assumed');
    else if (values.ecc.value < 0.02 || !(values.ecc.value > 2 * (values.ecc.err || 0))) values.ecc.note += '; consistent with a circular orbit';
  }
  if (!direct('omega')) {
    if (V('ecc') === 0) put('omega', 0, null, 'assumed', 'default', 'circular orbit: the argument of periastron has no effect');
    else if (!fromOther('omega')) put('omega', 0, null, 'assumed', 'default', `e = ${f4(V('ecc'))} but no reference gives the argument of periastron; 0 assumed, transit timing and duration may be off`);
  }
  const e = Math.min(Math.max(V('ecc'), 0), 0.999), w = V('omega');

  // --- ephemeris
  direct('per') || fromOther('per');
  const tsysNote = (b) => (b.tsys && !/^BJD(-TDB)?$/.test(b.tsys) ? `time system ${b.tsys}, not BJD-TDB` : '');
  if (!direct('tmid', 'tmid', tsysNote(B))) {
    // an RV-only solution gives the time of periastron; the conjunction follows from e and omega
    const tp = B.q.tperi;
    if (tp && fin(V('per'))) {
      const t = tp.value + (meanAnomalyAtTransit(e, w * DEG) / TWO_PI) * V('per');
      derive('tmid', t, Math.hypot(tp.err || 0, 0), ['per', 'ecc', 'omega'], `time of inferior conjunction from the time of periastron ${f4(tp.value)} (${B.ref})`);
    } else if (fromOther('tmid')) { const o = others.find((x) => x.ref === values.tmid.source); if (o && tsysNote(o)) values.tmid.note += '; ' + tsysNote(o); }
  }

  // --- transit shape
  if (!direct('rprs')) {
    const d = B.q.depth, rp = B.q.rp;
    if (d) derive('rprs', Math.sqrt(d.value), d.err ? d.err / (2 * Math.sqrt(d.value)) : null, [], `sqrt of the transit depth ${f4(d.value * 100)}% (${B.ref}; a limb-darkened depth overestimates it)`), (values.rprs.own = true);
    else if (rp && fin(V('rstar'))) { const k = rp.value * C.Rjup / (V('rstar') * C.Rsun); derive('rprs', k, k * Math.hypot((rp.err || 0) / rp.value, E('rstar') / V('rstar')), ['rstar'], `Rp / R* with Rp = ${f4(rp.value)} Rjup (${B.ref})`); }
    else if (!fromOther('rprs')) {
      const o = others.find((x) => x.q.depth) ; const o2 = others.find((x) => x.q.rp);
      if (o) put('rprs', Math.sqrt(o.q.depth.value), o.q.depth.err ? o.q.depth.err / (2 * Math.sqrt(o.q.depth.value)) : null, o.ref, 'other', `sqrt of the transit depth ${f4(o.q.depth.value * 100)}%; ${B.ref} gives no radius`);
      else if (o2 && fin(V('rstar'))) { const k = o2.q.rp.value * C.Rjup / (V('rstar') * C.Rsun); derive('rprs', k, k * Math.hypot((o2.q.rp.err || 0) / o2.q.rp.value, E('rstar') / V('rstar')), ['rstar'], `Rp / R* with Rp = ${f4(o2.q.rp.value)} Rjup (${o2.ref})`); values.rprs.own = false; }
    }
  }
  const P = V('per'), mpForKepler = B.q.mass && !B.limits.mass ? B.q.mass.value * C.Mjup_Msun : 0;
  const arsFromA = () => { const a = B.q.aAU; if (!a || !fin(V('rstar'))) return false; const x = a.value * C.AU / (V('rstar') * C.Rsun); return derive('ars', x, x * Math.hypot((a.err || 0) / a.value, E('rstar') / V('rstar')), ['rstar'], `a / R* with a = ${f4(a.value)} au (${B.ref})`); };
  const arsFromKepler = () => { if (!(fin(P) && fin(V('mstar')) && fin(V('rstar')))) return false; const x = arsKepler(V('mstar') + mpForKepler, V('rstar'), P); return derive('ars', x, x * Math.hypot(E('mstar') / (3 * V('mstar')), E('rstar') / V('rstar')), ['per', 'mstar', 'rstar'], "Kepler's third law"); };
  const arsFromRho = () => { const r = B.q.rho; if (!r || !fin(P)) return false; const x = Math.cbrt(r.value * 1000 * C.G * (P * C.day) ** 2 / (3 * Math.PI)); return derive('ars', x, x * (r.err || 0) / (3 * r.value), ['per'], `stellar density ${f4(r.value)} g/cm^3 (${B.stRef || B.ref}) and`); };
  if (!direct('ars')) {
    // from the chosen reference's own numbers if possible, then another paper's reported value, then a mixed derivation
    const ownStar = own('rstar') && own('mstar');
    (own('rstar') && arsFromA()) || (ownStar && own('per') && arsFromKepler()) || (B.sameStar && arsFromRho()) || fromOther('ars') || arsFromA() || arsFromKepler() || arsFromRho();
  }
  const ars = V('ars');
  if (!direct('inc')) {
    const bq = B.q.b;
    const incFromB = (b, label) => { const c = Math.abs(b.value) / ars * (1 + e * Math.sin(w * DEG)) / (1 - e * e); if (!(c <= 1)) return false; const f = (bb, aa) => Math.acos(Math.min(1, Math.abs(bb) / aa * (1 + e * Math.sin(w * DEG)) / (1 - e * e))) / DEG; return derive('inc', f(b.value, ars), propagate(f, [b.value, ars], [b.err || 0, E('ars')]), ['ars', 'ecc', 'omega'], `impact parameter b = ${f4(b.value)} (${label}) and`); };
    if (!(bq && fin(ars) && incFromB(bq, B.ref)) && !fromOther('inc')) {
      const o = others.find((x) => x.q.b);
      if (!(o && fin(ars) && incFromB(o.q.b, o.ref) && ((values.inc.own = false), true)))
        put('inc', 90, null, 'assumed', 'default', B.transit ? 'no inclination or impact parameter in any reference; central transit assumed' : 'not a transiting planet: inclination unknown, 90 deg assumed (masses are then M sin i)');
    }
  }
  if (V('inc') > 90) { values.inc.note = (values.inc.note ? values.inc.note + '; ' : '') + `reported as ${f4(V('inc'))} deg, mirrored to below 90`; values.inc.value = 180 - V('inc'); }
  const inc = V('inc'), k = V('rprs');
  if (!direct('b') && fin(ars) && fin(inc)) {
    const args = [ars, inc, e, w];
    derive('b', Math.abs(impactParameter(...args)), propagate((...x) => Math.abs(impactParameter(...x)), args, [E('ars'), E('inc'), 0, 0], (x) => { if (x[1] > 90) x[1] = 90; }), ['ars', 'inc', 'ecc', 'omega'], 'a/R* cos i (1 - e^2) / (1 + e sin omega)');
  }
  if (!direct('t14') && fin(P) && fin(ars) && fin(inc) && fin(k)) {
    const args = [P, ars, inc, k, e, w], t = transitDuration(...args);
    if (t > 0) derive('t14', t, propagate(transitDuration, args, [0, E('ars'), E('inc'), E('rprs'), 0, 0], (x) => { if (x[2] > 90) x[2] = 90; }), ['per', 'ars', 'inc', 'rprs', 'ecc', 'omega'], 'first to fourth contact, computed from the orbit');
    else if (!fromOther('t14') && B.transit) put('t14', 0, null, 'computed', 'derived', 'the assembled a/R*, i and Rp/R* give no transit');
  }

  // --- mass and radial velocity
  const sinI = fin(inc) ? Math.sin(inc * DEG) : 1;
  const massNote = (b) => (b.massProv === 'Msini' ? 'M sin i, a lower limit on the mass' : b.massProv === 'Msin(i)/sin(i)' ? 'M sin i divided by sin i' : '');
  if (!direct('mplanet', 'mass', massNote(B)) && !direct('mplanet', 'msini', 'M sin i, a lower limit on the mass')) {
    const Kq = B.q.K;
    if (Kq && fin(P) && fin(V('mstar'))) {
      // invert K for the mass (two fixed-point steps take care of the planet's share of the total mass)
      const f = (K, ms) => { let m = 0; for (let i = 0; i < 4; i++) m = K * Math.sqrt(1 - e * e) * Math.pow(ms + m * C.Mjup_Msun, 2 / 3) / Math.cbrt(TWO_PI * C.GMsun / (P * C.day)) / C.Mjup_Msun / sinI; return m; };
      derive('mplanet', f(Kq.value, V('mstar')), propagate(f, [Kq.value, V('mstar')], [Kq.err || 0, E('mstar')]), ['per', 'ecc', 'inc', 'mstar'], `RV semi-amplitude K = ${f4(Kq.value)} m/s (${B.ref}) and`);
    } else if (fromOther('mplanet', 'mass')) { const o = others.find((x) => x.ref === values.mplanet.source); if (o && massNote(o)) values.mplanet.note += '; ' + massNote(o); }
    else if (B.limits.mass) put('mplanet', B.limits.mass.value, null, B.ref, 'reference', 'upper limit, not a measurement');
  }
  if (!direct('K')) {
    const mv = values.mplanet, isMsini = mv && /M sin i, a lower/.test(mv.note || '');
    if (mv && !/upper limit/.test(mv.note || '') && fin(P) && fin(V('mstar'))) {
      const f = (m, ms) => rvAmplitude(m, P, e, isMsini ? 1 : sinI, ms);
      derive('K', f(mv.value, V('mstar')), propagate(f, [mv.value, V('mstar')], [E('mplanet'), E('mstar')]), ['mplanet', 'per', 'ecc', 'inc', 'mstar'], 'RV semi-amplitude');
    } else fromOther('K');
  }

  // --- checks on what was assembled: reported quantities of the chosen reference against the assembled inputs
  const q = {};
  for (const key of ['aAU', 'depth', 'rp', 'rho']) if (B.q[key]) q[key] = B.q[key];
  const map = { mplanet: 'mass' };
  for (const [key, val] of Object.entries(values)) q[map[key] || key] = { value: val.value, err: val.err, derived: val.kind === 'derived' || val.kind === 'default' };
  if (values.ecc.kind === 'default') q.ecc.derived = false;
  const mixed = STAR_KEYS.filter((s) => values[s] && values[s].kind === 'other').map((s) => values[s].source).filter((x, i, a) => a.indexOf(x) === i);
  const checks = runChecks(q, { transit: B.transit, massProv: values.mplanet && values.mplanet.kind !== 'derived' ? (/M sin i, a lower/.test(values.mplanet.note) ? 'Msini' : B.massProv || 'Mass') : '', starNote: mixed.length ? `stellar values from ${mixed.join(', ')}` : '' });
  for (const v of Object.values(values)) delete v.own;

  const need = Object.keys(WEIGHTS[use]);
  const filled = need.filter((key) => values[key] && values[key].kind !== 'reference').map((key) => ({ key, kind: values[key].kind, source: values[key].source, note: values[key].note }));
  const absent = [...PLANET_KEYS, ...STAR_KEYS].filter((key) => !values[key]);
  const best = scored[0], runner = scored.find((s) => s !== pick);
  const why = (opts.reference && pick.bag.ref === opts.reference && pick !== best ? 'chosen by the user. ' : '') +
    `${use} completeness ${(100 * pick.completeness).toFixed(0)}%` + (pick.missing.length ? ` (lacks ${pick.missing.join(', ')})` : '') +
    `; ${pick.nOk} consistency checks pass` + (pick.warned.length ? `, ${pick.warned.length} warn (${pick.warned.map((c) => c.name).join(', ')})` : '') + (pick.failed.length ? `, ${pick.failed.length} fail (${pick.failed.map((c) => c.name).join(', ')})` : '') +
    `; published ${B.pubdate || 'date unknown'}` + (B.isDefault ? '; the archive default' : '') +
    (runner ? `. Next: ${runner.bag.ref} (score ${runner.score.toFixed(1)} vs ${pick.score.toFixed(1)})` : '. The only reference');

  return {
    planet: mine[0].pl_name, host: mine[0].hostname, use,
    reference: { label: B.ref, url: B.url, pubdate: B.pubdate, stellar: opts.star ? opts.star.reference : B.stRef, stellarUrl: opts.star ? opts.star.url || '' : B.stUrl, isDefault: B.isDefault, soltype: B.soltype, transit: B.transit, score: pick.score, why },
    values, checks, filled, absent,
    alternatives: scored.map((s) => ({ reference: s.bag.ref, url: s.bag.url, pubdate: s.bag.pubdate, stellar: s.bag.stRef, isDefault: s.bag.isDefault, chosen: s === pick,
      score: s.score, completeness: s.completeness, consistency: s.consistency, recency: s.recency, missing: s.missing,
      nOk: s.nOk, warned: s.warned.map((c) => c.name), failed: s.failed.map((c) => c.name), checks: s.checks })),
  };
}

// ------------------------------------------------------------------------------------------------ priors

/**
 * Wide default priors for the assembled values, in the app's format: { type: 'uniform', a: min, b: max } or
 * { type: 'normal', a: mean, b: std }, each with a `why`. They lean wide on purpose: the catalogue value centres
 * the prior, the data should decide. Rp/R*, a/R*, i, T_mid, e, omega and K are uniform; the period and the stellar
 * parameters (which a light curve cannot constrain) are normal with inflated widths.
 * opts.epochs: number of orbits between the catalogue T_mid and the data, to widen the T_mid prior by the propagated period error.
 */
export function suggestPriors(values, opts = {}) {
  const out = {}, has = (k) => values[k] && fin(values[k].value), V = (k) => values[k].value, S = (k) => (values[k] && values[k].err) || 0;
  const weak = (k) => (values[k].kind === 'reference' ? '' : ` (value is ${values[k].kind})`);
  const uni = (k, lo, hi, why) => (out[k] = { type: 'uniform', a: lo, b: hi, why: why + weak(k) });
  const nor = (k, sd, why) => (out[k] = { type: 'normal', a: V(k), b: sd, why: why + weak(k) });
  const pick = (cands) => cands.reduce((m, c) => (c[0] > m[0] ? c : m));                 // widest of [width, description]

  const kR = has('rprs') ? V('rprs') : 0.1;
  if (has('rprs')) { const [h, d] = pick([[10 * S('rprs'), '10 sigma'], [0.5 * kR, '50% of the value']]); uni('rprs', Math.max(0, kR - h), kR + h, `± ${d}: the depth is what a light curve measures best, so the catalogue only centres it`); }
  let arsLo = NaN;
  if (has('ars')) { const [h, d] = pick([[5 * S('ars'), '5 sigma'], [0.2 * V('ars'), '20% of the value']]); arsLo = Math.max(1 + kR, V('ars') - h); if (!(arsLo < V('ars'))) arsLo = Math.max(0, V('ars') - h); uni('ars', arsLo, V('ars') + h, `± ${d}, not below the stellar surface`); }
  if (has('inc')) {
    // the lowest inclination that still gives a (grazing) transit at the small end of the a/R* prior: lower than that the data would show nothing
    const e = has('ecc') ? V('ecc') : 0, w = has('omega') ? V('omega') : 0, a = fin(arsLo) ? arsLo : NaN;
    const graze = fin(a) ? Math.acos(Math.min(1, (1 + kR) / a * (1 + e * Math.sin(w * DEG)) / (1 - e * e))) / DEG : NaN;
    const [h, d] = pick([[5 * S('inc'), '5 sigma'], [2, '2 deg']]), lo = Math.max(0, Math.min(V('inc') - h, fin(graze) ? graze : 90));
    uni('inc', lo, 90, `from ${lo === graze ? 'the grazing limit b = 1 + Rp/R* at the smallest a/R*' : 'the value minus ' + d} up to 90 deg (edge-on)`);
  }
  if (has('tmid')) {
    const drift = opts.epochs && has('per') ? Math.abs(opts.epochs) * S('per') : 0;
    const [h, d] = pick([[10 * Math.hypot(S('tmid'), drift), drift ? `10 sigma including the period error over ${opts.epochs} orbits` : '10 sigma'], [has('t14') ? 0.5 * V('t14') : 0, 'half a transit duration'], [0.02, '0.02 d']]);
    uni('tmid', V('tmid') - h, V('tmid') + h, `± ${d}` + (drift ? '' : '; shift to the epoch of the data and add N x sigma_P before use'));
  }
  if (has('per')) { const [h, d] = pick([[5 * S('per'), '5 sigma'], [1e-5 * V('per'), '1e-5 of the period']]); nor('per', h, `std = ${d}: one light curve cannot measure the period, so this stays informative but loose`); }
  if (has('ecc')) {
    const [h, d] = pick([[5 * S('ecc'), '5 sigma'], [0.05, '0.05']]);
    uni('ecc', Math.max(0, V('ecc') - h), Math.min(0.99, V('ecc') + h), `± ${d}, kept inside [0, 0.99]`);
  }
  if (has('omega')) {
    if (has('ecc') && V('ecc') === 0) uni('omega', -180, 180, 'unconstrained for a circular orbit; fix it unless e is fitted');
    else { const [h, d] = pick([[5 * S('omega'), '5 sigma'], [20, '20 deg']]); uni('omega', V('omega') - h, V('omega') + h, `± ${d}`); }
  }
  if (has('K')) { const [h, d] = pick([[5 * S('K'), '5 sigma'], [0.5 * V('K'), '50% of the value']]); uni('K', Math.max(0, V('K') - h), V('K') + h, `± ${d}, non-negative`); }
  if (has('mplanet')) { const [h, d] = pick([[3 * S('mplanet'), '3 sigma'], [0.2 * V('mplanet'), '20% of the value']]); nor('mplanet', h, `std = ${d}`); }
  if (has('b')) uni('b', 0, 1 + kR, 'any transiting geometry, 0 to 1 + Rp/R*');
  if (has('t14') && V('t14') > 0) { const [h, d] = pick([[5 * S('t14'), '5 sigma'], [0.5 * V('t14'), '50% of the value']]); uni('t14', Math.max(0, V('t14') - h), V('t14') + h, `± ${d}`); }
  const star = { teff: [150, '150 K'], logg: [0.15, '0.15 dex'], feh: [0.15, '0.15 dex'] };
  for (const [k, [fl, d0]] of Object.entries(star)) if (has(k)) { const [h, d] = pick([[3 * S(k), '3 sigma'], [fl, d0]]); nor(k, h, `std = ${d}: spectroscopic errors are often optimistic and differ between papers`); }
  for (const k of ['rstar', 'mstar']) if (has(k)) { const [h, d] = pick([[3 * S(k), '3 sigma'], [0.1 * V(k), '10% of the value']]); nor(k, h, `std = ${d}`); }
  return out;
}

// ------------------------------------------------------------------------------------------------ whole system

/**
 * Parameters for every planet of a host, sharing one star.
 *
 * The stellar set is chosen once: all rows of the host are grouped by stellar reference and scored by
 * completeness (Teff, log g, [Fe/H], R*, M* with errors), by their own consistency (log g and density against
 * M*, R*), by how many of the planets' independently chosen references use that star, then by date. Every
 * planet is then assembled with that star, so derived quantities (a/R* from Kepler, K, Rp/R* from radii) and
 * the consistency checks all refer to the same M* and R*.
 *
 * opts: as chooseParameters (use, and `references: { planetName: label }` to override per planet), plus
 * opts.stellarReference to force the star.
 * Returns { host, star: { reference, url, values, checks, how, alternatives }, planets: [chooseParameters result with .priors] }.
 */
export function systemFromRows(rows, opts = {}) {
  if (!rows || !rows.length) return null;
  const names = [...new Set(rows.map((r) => r.pl_name))];
  const refFor = (n) => (opts.references && opts.references[n]) || undefined;
  const solo = names.map((n) => chooseParameters(rows, n, { use: opts.use, reference: refFor(n) }));

  const groups = new Map();
  for (const r of rows) { if (!r.st_ref) continue; if (!groups.has(r.st_ref)) groups.set(r.st_ref, []); groups.get(r.st_ref).push(r); }
  const wts = { teff: 1, logg: 1, feh: 1, rstar: 2, mstar: 2 }, tot = 7;
  const cands = [...groups.entries()].map(([label, rs]) => {
    const q = {};
    for (const r of rs) for (const k of STAR_COLS) { if (q[k]) continue; const x = quantity(r, k); if (x && !x.limit && (k === 'feh' || x.value > 0)) q[k] = x; }
    let c = 0;
    for (const [k, wt] of Object.entries(wts)) if (q[k]) c += wt * (q[k].err > 0 ? 1 : 0.85);
    const checks = runChecks(q, {}), fails = checks.filter((x) => x.status === 'fail').length, warns = checks.filter((x) => x.status === 'warn').length, oks = checks.length - fails - warns;
    const usedBy = solo.filter((s) => s && s.reference.stellar === label).length;
    const year = Math.max(...rs.map((r) => pubYear(r.pl_pubdate)).filter(fin), -Infinity);
    return { label, url: rs[0].st_refurl || '', q, completeness: c / tot, checks, fails, warns, oks, usedBy, year };
  });
  if (!cands.length) return { host: rows[0].hostname, star: null, planets: solo.map((s) => ({ ...s, priors: suggestPriors(s.values) })) };
  const ys = cands.map((c) => c.year).filter(fin), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (const c of cands) c.score = 100 * c.completeness - 25 * c.fails - 8 * c.warns + 1.5 * c.oks + 10 * c.usedBy / names.length + (y1 > y0 && fin(c.year) ? 3 * (c.year - y0) / (y1 - y0) : 0);
  cands.sort((a, b) => b.score - a.score);
  const S = (opts.stellarReference && cands.find((c) => c.label === opts.stellarReference)) || cands[0];
  const values = {};
  for (const k of STAR_KEYS) if (S.q[k]) values[k] = { value: S.q[k].value, err: S.q[k].err, source: S.label, kind: 'reference', note: '' };
  const star = { reference: S.label, url: S.url, values, checks: S.checks,
    how: `stellar set from ${S.label}: ${(100 * S.completeness).toFixed(0)}% complete, ${S.oks} self-consistency checks pass` + (S.warns + S.fails ? `, ${S.warns} warn, ${S.fails} fail` : '') +
      `, used by the chosen solution of ${S.usedBy} of ${names.length} planet${names.length > 1 ? 's' : ''}` + (cands.length > 1 ? `; ${cands.length - 1} other stellar reference${cands.length > 2 ? 's' : ''} considered` : ''),
    alternatives: cands.map((c) => ({ reference: c.label, url: c.url, score: c.score, completeness: c.completeness, usedBy: c.usedBy, failed: c.checks.filter((x) => x.status === 'fail').map((x) => x.name) })) };
  const planets = names.map((n) => { const p = chooseParameters(rows, n, { use: opts.use, reference: refFor(n), star }); return { ...p, priors: suggestPriors(p.values) }; });
  // inner planet first, as the UI lists them
  planets.sort((a, b) => (a.values.per ? a.values.per.value : Infinity) - (b.values.per ? b.values.per.value : Infinity));
  return { host: rows[0].hostname, star, planets };
}
