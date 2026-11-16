// The planner's targets: which rows of the catalogue table (src/core/sources, buildTable) have transits that can be
// predicted, with the ephemeris chosen, and the filters of the page (catalogue, discovery method, name, depth,
// magnitude, duration). No DOM: test/plan_targets.test.mjs counts what each filter leaves from Kitt Peak.
//
// Only planets SEEN TO TRANSIT have transit windows: the archive's tran_flag (sources/nea.js `transit`), whatever
// method found them. A planet found by radial velocity transits only if a transit was observed later (HD 209458 b,
// HD 80606 b, 55 Cnc e); an orbit inclination near 90 degrees is not enough to predict one, and planets found by
// imaging or microlensing have no transit ephemeris at all. discoveryCounts() says how many of each method there are.
import { groupOf, isCandidateStatus, GROUP_IDS } from '../sky/discovery.js';
import { rowEphemerides, chooseEphemeris } from '../core/sources/index.js';

const fin = Number.isFinite;
const sig = (e) => (e ? (e[0] + e[1]) / 2 : 0);

/**
 * The ephemeris a row's transits are predicted from. Archive planets carry two (sources/nea.js): the pair with the
 * smallest predicted uncertainty today and the archive's default parameter set; `which` ('best' | 'default') says
 * which is used. Returns { per, tmid, perErr, tmidErr, hasErr, ref, tsys, cat, how, other: the ephemeris not chosen or null }.
 */
export function ephemerisOf(r, which = 'best') {
  // exoplanet.eu's period and epoch (the same 1% and epoch rules as Search); without one, the archive's best-timed
  // pair, said so in `how` and `fallback`
  if (which === 'eu' && r.recs) {
    const c = chooseEphemeris(rowEphemerides(r.recs), 'eu');
    if (c.eph && c.which === 'eu') return { ...c.eph, cat: r.src.per, source: 'eu', how: 'exoplanet.eu\'s period and epoch', other: null, fallback: '' };   // cat stays the row's own catalogue: the source filters use it
    const base = ephemerisOf(r, 'best'); return { ...base, how: base.how + (c.fallback ? ` (${c.fallback})` : ''), fallback: c.fallback || 'not in exoplanet.eu' };
  }
  const v = r.v, cat = r.src.per, rec = r.recs[cat], E = cat === 'nea' && rec.info.ephemerides;
  if (E && E.best) {
    // a best-timed pair whose period is more than 1% from the default set's is another planet's (seen in the
    // 2026-11-15 snapshot: HD 106315 c with the ExoFOP period 1221 d against 21.06 d): it is not used
    const wrong = E.best.kind === 'best' && E.default && E.default.per > 0 && Math.abs(E.best.per - E.default.per) / E.default.per > 0.01;
    const use = wrong ? E.default : E[which] || E.best, other = use === E.best ? E.default : E.best, same = !other || (other.per === use.per && other.tmid === use.tmid);
    let how = use.kind === 'best' ? `smallest predicted uncertainty today among the ${rec.info.nEphemerisRefs || 'published'} references that give a period and an epoch with errors`
      : use.kind === 'default' ? 'the archive\'s default parameter set' : 'the archive\'s composite values' + (use.mixed ? ': the period and the epoch come from two papers' : '');
    if (wrong) how += ` (the best-timed pair, ${E.best.ref || 'unnamed'}, gives P = ${E.best.per} d, ${(100 * Math.abs(E.best.per - E.default.per) / E.default.per).toFixed(0)}% off: another planet's, not used)`;
    return { ...use, cat, how, other: same ? null : other, sameAsOther: same && !!other, rejectedBest: wrong };
  }
  return { kind: 'catalogue', per: v.per, tmid: v.tmid, perErr: sig(r.e.per), tmidErr: sig(r.e.tmid), hasErr: !!(r.e.per && r.e.tmid), ref: r.ref.per || '', tsys: (rec && rec.info.tsys) || '', cat,
    how: cat === 'toi' ? 'the TESS project\'s pipeline ephemeris' : 'the only ephemeris this catalogue gives', other: null };
}

/**
 * The rows with a transit ephemeris and a position, as targets of observability.js: { row, name, cat ('nea' | 'toi' |
 * 'eu'), candidate (a TESS candidate: TFOPWG PC, APC or none), group (discovery.js: t r i m o, c for candidates),
 * method, ra, dec, per, tmid, perErr, tmidErr, hasErr, eph, t14, depth, mag, band, key, ecc, ... }. TOIs that are known
 * planets (KP, CP: they are in the archive's list) or false positives (FP, FA) are left out, and so is a candidate
 * whose period is within 1% of a period the archive gives a confirmed planet of the same star (same TIC; the chosen
 * pair, the default set or the composite value): that planet under its TOI name, its
 * disposition not yet updated (the rule of tools/build_sky_data.py for the Observe page). stats, if given, gets
 * { tessKnown, tessNotCandidate, tessSamePeriod }.
 */
export function makeTargets(rows, which = 'best', stats = {}) {
  const out = [], ticPer = new Map();
  Object.assign(stats, { tessKnown: 0, tessNotCandidate: 0, tessSamePeriod: 0 });
  for (const r of rows) {
    if (!r.recs.nea) continue;
    const a = (r.recs.nea.hostAliases || []).find((x) => /^TIC\s*\d+$/.test(String(x).trim())); if (!a) continue;
    // every period the archive gives the planet (the chosen pair, the default set, the composite): one may be wrong
    const E = r.recs.nea.info.ephemerides || {}, ps = [r.v.per, E.best && E.best.per, E.default && E.default.per].filter((p) => p > 0);
    const tic = +String(a).replace(/\D/g, ''); if (!ticPer.has(tic)) ticPer.set(tic, []); ticPer.get(tic).push(...ps);
  }
  for (const r of rows) {
    const v = r.v;
    if (!v.transit || !(v.per > 0) || !fin(v.tmid) || !fin(v.ra) || !fin(v.dec)) continue;
    const cat = r.recs.nea ? 'nea' : r.recs.toi ? 'toi' : 'eu';
    if (cat === 'toi') {
      if (!isCandidateStatus(v.status)) { if (/^Known/.test(v.status)) stats.tessKnown++; else stats.tessNotCandidate++; continue; }
      const ps = ticPer.get(+r.recs.toi.info.tic); if (ps && ps.some((p) => Math.abs(v.per - p) / p < 0.01)) { stats.tessSamePeriod++; continue; }
    }
    const mf = fin(v.vmag) ? 'vmag' : fin(v.gmag) ? 'gmag' : fin(v.tmag) ? 'tmag' : null, e = ephemerisOf(r, which);
    // the orbit, for eclipses: only catalogued values (an estimate of e or omega would be a guess presented as data)
    const cat1 = (k) => (fin(v[k]) && !r.est[k] ? v[k] : NaN);
    const candidate = cat === 'toi', group = candidate ? 'c' : groupOf(v.method) || 'o';
    out.push({ row: r, name: r.name, cat, candidate, group, method: v.method, ra: v.ra, dec: v.dec, per: e.per, tmid: e.tmid, perErr: e.perErr, tmidErr: e.tmidErr, hasErr: e.hasErr, eph: e,
      t14: v.t14 > 0 ? v.t14 : NaN, depth: v.depth, mag: mf ? v[mf] : NaN, band: mf ? { vmag: 'V', gmag: 'G', tmag: 'T' }[mf] : '', key: r.name.toLowerCase(),
      ecc: cat1('ecc'), eccErr: sig(r.e.ecc), omega: cat1('omega'), omegaErr: sig(r.e.omega), ars: v.ars, inc: v.inc, rprs: v.rprs, a: v.a, teq: v.teq });
  }
  return out;
}

/**
 * Per discovery group: { targets: planets with a transit ephemeris (makeTargets), none: archive planets of that
 * method that are not seen to transit or lack a period or an epoch: nothing to plan }.
 */
export function discoveryCounts(rows, targets) {
  const c = {}; for (const g of GROUP_IDS) c[g] = { targets: 0, none: 0 };
  for (const t of targets) c[t.group].targets++;
  for (const r of rows) if (r.recs.nea && !(r.v.transit && r.v.per > 0 && fin(r.v.tmid))) c[groupOf(r.v.method) || 'o'].none++;
  return c;
}

/** The filters in the order the page applies them; each is (target, P) -> kept. */
export const FILTERS = [
  ['catalogue', (t, P) => !!P.src[t.cat]],
  ['discovery method', (t, P) => (P.disc ?? GROUP_IDS).includes(t.group)],
  ['name', (t, P) => { const q = String(P.name || '').trim().toLowerCase(); return !q || t.key.includes(q); }],
  ['depth', (t, P) => !(P.depth > 0) || t.depth * 1000 >= P.depth],
  ['magnitude', (t, P) => ((P.magMax == null && P.magMin == null) || fin(t.mag)) && !(P.magMax != null && t.mag > P.magMax) && !(P.magMin != null && t.mag < P.magMin)],
  ['duration', (t) => t.t14 > 0],
];
/**
 * The targets that pass the page's settings P ({ src, disc, name, depth (ppt), magMin, magMax }). Returns
 * { targets, skipped: { noMag, noDuration }, steps: [[filter name, how many are left after it]] }.
 */
export function filterTargets(targets, P) {
  const skipped = { noMag: 0, noDuration: 0 }, steps = [];
  let list = targets;
  for (const [name, f] of FILTERS) {
    const next = [];
    for (const t of list) { if (f(t, P)) next.push(t); else if (name === 'magnitude' && !fin(t.mag)) skipped.noMag++; else if (name === 'duration') skipped.noDuration++; }
    list = next; steps.push([name, list.length]);
  }
  return { targets: list, skipped, steps };
}
