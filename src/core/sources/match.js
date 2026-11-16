// Matching the planets of two catalogues. No DOM.
//
// Catalogues disagree on names more than on anything else: "WASP-12 b" is "WASP-12 Ab" in exoplanet.eu, "55 Cnc e"
// is "55 Cnc Ae", hosts go by HD, HIP, GJ, KOI, TOI or 2MASS designations, and a few planets carry different
// letters. A match is therefore made in stages, most trustworthy first, and every candidate pair made on names
// is then checked against two things that do not depend on names: the position on the sky and the period.
//
//   1 name          the names agree once case, spaces and punctuation are removed, also after dropping the
//                   component letter of the PRIMARY star ("WASP-12 Ab" -> "WASP-12 b"; a "B" is never dropped:
//                   "55 Cnc Bb" is not "55 Cnc b")
//   2 alias         one of the alternate planet names agrees
//   3 host+letter   a host name or host alias of one agrees with one of the other, and the planet letters agree
//   4 position      no name agrees, but the stars are within 1 arcmin and the periods within 3% (or, without
//                   periods, the letters agree and the star hosts one such planet)
//
// A pair made on an alias or a host name (stages 2 and 3) is rejected when the stars are more than SEP_REJECT apart
// (unless the periods agree to 0.1%), or when both give a period below 2000 d and they differ by more than 20%.
// Identical names (stage 1) are kept whatever the positions say, and flagged: see accept(). Pairs that are kept
// but look doubtful carry flags.

import { normalizeName } from '../catalog.js';

const DEG = Math.PI / 180;
export const SEP_REJECT = 0.25;        // degrees: beyond this two entries are not the same star, whatever the names say
export const SEP_WARN = 0.02;          // degrees (72"): catalogue positions of the same star normally agree far better

/** Planet letter of a name ("b" for "WASP-12 b", "WASP-12 Ab", "Kepler-16 (AB) b"), or '' when it has none. */
export function planetLetter(name) {
  const m = /(?:\s|\)|(?<=[0-9]\s?[AB])|(?<=[A-Za-z0-9]\s[AB]))([b-z])$/.exec(String(name ?? '').trim());
  return m ? m[1] : '';
}
/** The name without the planet letter, and without a trailing primary-star designation: "WASP-12 Ab" -> "WASP-12". */
export function hostOfName(name) {
  const s = String(name ?? '').trim(), l = planetLetter(s);
  const h = l ? s.slice(0, -1).trim() : s;
  return h.replace(/\s*\(AB\)$/, '').replace(/(?<=[\w)])\s*A$/, (x, o, all) => (/[0-9)]\s*A$/.test(all) || /\sA$/.test(all) ? '' : x)).trim();
}
/** Keys under which a planet name may be found: the normalised name, and the name with the primary's "A" removed. */
export function nameKeys(name) {
  const k = new Set(), n = normalizeName(name);
  if (n) k.add(n);
  const l = planetLetter(name);
  if (l) { const h = normalizeName(hostOfName(name)); if (h) k.add(h + l); }
  return [...k];
}
/** Keys of a host name: normalised, and without a trailing primary-star "A". */
export function hostKeys(host) {
  const k = new Set(), n = normalizeName(host);
  if (n) k.add(n);
  const s = String(host ?? '').trim();
  if (/[0-9)]\s*A$|\sA$/.test(s)) { const h = normalizeName(s.replace(/\s*A$/, '')); if (h) k.add(h); }
  return [...k];
}

/** Angular separation in degrees of two records with ra, dec (NaN when either lacks them). */
export function separation(a, b) {
  const r1 = a.v.ra, d1 = a.v.dec, r2 = b.v.ra, d2 = b.v.dec;
  if (![r1, d1, r2, d2].every(Number.isFinite)) return NaN;
  const s = Math.sin((d2 - d1) * DEG / 2) ** 2 + Math.cos(d1 * DEG) * Math.cos(d2 * DEG) * Math.sin((r2 - r1) * DEG / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / DEG;
}
const perRatio = (a, b) => (a.v.per > 0 && b.v.per > 0 ? Math.abs(a.v.per - b.v.per) / Math.max(a.v.per, b.v.per) : NaN);

/**
 * Match the records of catalogue B to those of catalogue A (one to one).
 * Returns { pairs: [{ a, b, stage, sep, dper, flags: [..] }], onlyA: [rec], onlyB: [rec], rejectedPairs, stats }.
 * stats: { nA, nB, matched, byStage: {name, alias, 'host+letter', position}, rejected: {position, period}, flagged, onlyA, onlyB }.
 */
export function matchCatalogues(A, B) {
  const byKey = new Map(), byHost = new Map();
  const put = (m, k, r) => { if (!m.has(k)) m.set(k, r); else if (m.get(k) !== r) m.set(k, null); };       // null: ambiguous key, never used
  for (const r of A) {
    for (const k of nameKeys(r.name)) put(byKey, k, r);
    const l = planetLetter(r.name);
    for (const h of [r.host, hostOfName(r.name), ...r.hostAliases]) for (const k of hostKeys(h)) { if (l) put(byHost, k + '|' + l, r); }
  }
  const usedA = new Set(), usedB = new Set(), pairs = [], rejected = { position: 0, period: 0 }, rejectedPairs = [];
  const accept = (a, b, stage) => {
    if (!a || usedA.has(a) || usedB.has(b)) return false;
    const sep = separation(a, b), dper = perRatio(a, b), flags = [];
    // Identical names are trusted over positions: every such pair found more than SEP_REJECT apart in the
    // 2026-11-15 snapshots was one catalogue's coordinate being wrong (a lost minus sign, a mistyped degree).
    // Other stages need the position, unless the periods agree to 0.1%.
    if (stage !== 'name' && sep > SEP_REJECT && !(dper < 1e-3)) { rejected.position++; rejectedPairs.push({ a, b, stage, sep, dper, why: 'position' }); return false; }
    // long periods are poorly known, so a mismatch there does not tell two planets apart
    if (stage !== 'name' && dper > 0.2 && Math.min(a.v.per, b.v.per) < 2000) { rejected.period++; rejectedPairs.push({ a, b, stage, sep, dper, why: 'period' }); return false; }
    if (sep > SEP_REJECT) flags.push(`positions differ by ${sep.toFixed(2)} deg: one catalogue's coordinates are wrong`);
    else if (sep > SEP_WARN) flags.push(`positions differ by ${(sep * 60).toFixed(1)} arcmin`);
    if (dper > 0.01) flags.push(`periods differ by ${(100 * dper).toFixed(1)}%`);
    usedA.add(a); usedB.add(b);
    pairs.push({ a, b, stage, sep, dper, flags });
    return true;
  };
  const first = (m, keys) => { for (const k of keys) { const r = m.get(k); if (r && !usedA.has(r)) return r; } return null; };
  for (const b of B) accept(first(byKey, nameKeys(b.name)), b, 'name');
  for (const b of B) if (!usedB.has(b)) accept(first(byKey, b.aliases.flatMap(nameKeys)), b, 'alias');
  for (const b of B) {
    if (usedB.has(b)) continue;
    const l = planetLetter(b.name) || b.aliases.map(planetLetter).find(Boolean);
    if (!l) continue;
    const hosts = [b.host, hostOfName(b.name), ...b.hostAliases, ...b.aliases.map(hostOfName)].flatMap(hostKeys);
    accept(first(byHost, hosts.map((h) => h + '|' + l)), b, 'host+letter');
  }
  // stage 4: by position. A grid of 0.05 deg cells in declination and RA*cos(dec) keeps this linear.
  const cell = (r) => [Math.floor(r.v.dec / 0.05), Math.floor(r.v.ra * Math.cos(r.v.dec * DEG) / 0.05)];
  const grid = new Map();
  for (const a of A) { if (usedA.has(a) || !Number.isFinite(a.v.ra) || !Number.isFinite(a.v.dec)) continue; const [i, j] = cell(a), k = i + ',' + j; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(a); }
  for (const b of B) {
    if (usedB.has(b) || !Number.isFinite(b.v.ra) || !Number.isFinite(b.v.dec)) continue;
    const [i, j] = cell(b); let best = null, bestScore = Infinity;
    const near = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const a of grid.get((i + di) + ',' + (j + dj)) || []) if (!usedA.has(a) && separation(a, b) < 1 / 60) near.push(a);
    for (const a of near) {
      const dp = perRatio(a, b), la = planetLetter(a.name), lb = planetLetter(b.name);
      if (dp < 0.03) { if (dp < bestScore) { best = a; bestScore = dp; } }
      else if (Number.isNaN(dp) && la && la === lb && near.filter((x) => planetLetter(x.name) === la).length === 1 && bestScore === Infinity) best = a;
    }
    if (best) accept(best, b, 'position');
  }
  const byStage = { name: 0, alias: 0, 'host+letter': 0, position: 0 };
  for (const p of pairs) byStage[p.stage]++;
  const onlyA = A.filter((r) => !usedA.has(r)), onlyB = B.filter((r) => !usedB.has(r));
  return { pairs, onlyA, onlyB, rejectedPairs, stats: { nA: A.length, nB: B.length, matched: pairs.length, byStage, rejected, flagged: pairs.filter((p) => p.flags.length).length, onlyA: onlyA.length, onlyB: onlyB.length } };
}
