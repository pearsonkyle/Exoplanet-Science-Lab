// Catalogue plug-ins, matching between catalogues, merged rows and gap filling (src/core/sources/).
// The hand-made cases test the rules; the snapshots under public/ (skipped with a FAIL if they have not been built)
// give the numbers quoted in the README: how many planets match, at which stage, and what is left over.
import { readFileSync, existsSync } from 'node:fs';
import { SOURCES, loadSources, buildTable, makeRow, findRow, disagreement, fillGaps, FIELDS } from '../src/core/sources/index.js';
import { matchCatalogues, planetLetter, hostOfName, nameKeys, hostKeys, separation } from '../src/core/sources/match.js';
import { readSnapshot, newRecord } from '../src/core/sources/snapshot.js';
import * as R from '../src/core/relations.js';
import { transitDuration as exactDuration } from '../src/core/catalog.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// --- the plug-in interface
check('every source is a complete plug-in', SOURCES.every((s) => s.id && s.short && s.label && s.file && s.url && s.about && s.acknowledgement && typeof s.records === 'function' && typeof s.planetUrl === 'function'), SOURCES.map((s) => s.id).join(', '));

// --- snapshot reader
{
  const S = readSnapshot({ v: 1, date: 'x', columns: [['a', 'n'], ['q', 'q'], ['s', 's']], refs: [['Ref 2020', 'http://r']], strs: ['hello'], rows: [['n1', [1.5, 0.2, -0.1, 0], 0], ['n2', 3], ['n3', [2, null, null, null, 1]]] });
  const q = S.q(S.rows[0], 'q'), q1 = S.q(S.rows[1], 'q'), q2 = S.q(S.rows[2], 'q');
  check('snapshot cells', q.v === 1.5 && q.hi === 0.2 && q.lo === 0.1 && q.ref === 'Ref 2020' && q.refUrl === 'http://r' && q1.v === 3 && q1.hi === null && q2.lim === 1 && S.s(S.rows[0], 's') === 'hello' && S.s(S.rows[1], 's') === null && S.n(S.rows[2], 'a') === 'n3' && S.q(S.rows[1], 'missing') === null);
  let threw = false; try { readSnapshot({ v: 2 }); } catch { threw = true; }
  check('unknown snapshot format is refused', threw);
}

// --- names
check('planetLetter', planetLetter('WASP-12 b') === 'b' && planetLetter('WASP-12 Ab') === 'b' && planetLetter('Kepler-16 (AB) b') === 'b' && planetLetter('55 Cnc Bb') === 'b' && planetLetter('PSR B1257+12 A') === '' && planetLetter('2M1510 B') === '' && planetLetter('TOI-1338 A b') === 'b' && planetLetter('HR 8799 e') === 'e');
check("hostOfName drops the planet letter and the primary's A, never a B", hostOfName('WASP-12 Ab') === 'WASP-12' && hostOfName('55 Cnc Ae') === '55 Cnc' && hostOfName('55 Cnc Bb') === '55 Cnc B' && hostOfName('Kepler-16 (AB) b') === 'Kepler-16' && hostOfName('GJ 229 A c') === 'GJ 229' && hostOfName('alf Cen B b') === 'alf Cen B' && hostOfName('XO-2N b') === 'XO-2N');
check('nameKeys', nameKeys('WASP-12 Ab').includes('wasp12b') && nameKeys('WASP-12 b').includes('wasp12b') && !nameKeys('55 Cnc Bb').includes('55cncb') && nameKeys('HAT-P-32 b').length === 1 && hostKeys('WASP-12 A').includes('wasp12') && !hostKeys('55 Cnc B').includes('55cnc'));

// --- matching rules on hand-made records
const rec = (src, name, host, ra, dec, per, extra = {}) => { const r = newRecord(src, name, host); Object.assign(r.v, { ra, dec }); if (per) r.v.per = per; Object.assign(r, extra); return r; };
{
  const A = [rec('nea', 'Star-1 b', 'Star-1', 10, 20, 3.0), rec('nea', 'Star-1 c', 'Star-1', 10, 20, 7.0), rec('nea', '55 Fake b', '55 Fake', 50, -10, 14.6), rec('nea', 'HD 1000 b', 'HD 1000', 80, 5, 100, { hostAliases: ['HIP 77'] }),
    rec('nea', 'Odd-9 b', 'Odd-9', 120, 40, 2.5), rec('nea', 'Lens-1L b', 'Lens-1L', 270, -30, 0), rec('nea', 'Twin-5 b', 'Twin-5', 200, 0, 4.0), rec('nea', 'Lonely-1 b', 'Lonely-1', 300, 60, 9)];
  const B = [rec('eu', 'Star-1 Ab', 'Star-1 A', 10.0002, 20.0001, 3.00001), rec('eu', 'Star-1 Ac', 'Star-1 A', 10.0002, 20.0001, 7.0),
    rec('eu', '55 Fake Bb', '55 Fake B', 50.01, -10, 6.8),                                            // a planet of the companion: must NOT match 55 Fake b
    rec('eu', 'Sigma Foo b', 'Sigma Foo', 80.0001, 5, 100.2, { hostAliases: ['HIP 77', 'HD 1000'] }), // host alias + letter
    rec('eu', 'Other-name b', 'Other-name', 120.0001, 40.0001, 2.5001),                               // position + period only
    rec('eu', 'Lens-1L b', 'Lens-1L', 270.9, -30.6, 0),                                               // same name, wrong coordinates
    rec('eu', 'Mirror b', 'Mirror', 200, 0.001, 9.9, { aliases: ['Twin-5 b'] }),                      // alias, but a different period: rejected
    rec('eu', 'Extra-1 b', 'Extra-1', 1, 1, 5)];
  const M = matchCatalogues(A, B), pair = (b) => M.pairs.find((p) => p.b.name === b);
  check('binary component A is dropped, B is not', pair('Star-1 Ab').a.name === 'Star-1 b' && pair('Star-1 Ac').a.name === 'Star-1 c' && pair('Star-1 Ab').stage === 'name' && !pair('55 Fake Bb'));
  check('host alias and letter', pair('Sigma Foo b') && pair('Sigma Foo b').a.name === 'HD 1000 b' && pair('Sigma Foo b').stage === 'host+letter');
  check('position and period when no name agrees', pair('Other-name b') && pair('Other-name b').a.name === 'Odd-9 b' && pair('Other-name b').stage === 'position');
  check('identical names survive a wrong position, with a flag', pair('Lens-1L b') && pair('Lens-1L b').stage === 'name' && /coordinates are wrong/.test(pair('Lens-1L b').flags.join()), pair('Lens-1L b') && pair('Lens-1L b').flags.join());
  check('an alias match with a different period is rejected', !pair('Mirror b') && M.stats.rejected.period >= 1 && M.rejectedPairs.some((p) => p.b.name === 'Mirror b' && p.why === 'period'));
  check('counts add up', M.stats.matched === 5 && M.stats.onlyA === 3 && M.stats.onlyB === 3 && M.onlyA.map((r) => r.name).sort().join() === '55 Fake b,Lonely-1 b,Twin-5 b', JSON.stringify(M.stats));
  check('one to one', new Set(M.pairs.map((p) => p.a)).size === M.pairs.length && new Set(M.pairs.map((p) => p.b)).size === M.pairs.length);
}

// --- disagreement rule
check('disagreement: needs both significance and size', disagreement('per', 3.0, 3.00001, [1e-7, 1e-7], [1e-7, 1e-7]) === null && disagreement('per', 3.0, 3.01, [1e-4, 1e-4], [1e-4, 1e-4]).nsigma > 50 &&
  disagreement('teff', 5000, 5200, [150, 150], [150, 150]) === null && disagreement('teff', 5000, 5400, [50, 50], [50, 50]) !== null && disagreement('rp', 1.0, 1.3, undefined, undefined).nsigma === null && disagreement('rp', 1, 1.05) === null && disagreement('name', 1, 2) === null);

// --- gap filling on a hand-made row
{
  const v = { transit: true, per: 3, teff: 5772, logg: 4.438, rstar: 1.0, depth: 0.01, mass: 1.0, massKind: 'Mass' };
  const est = fillGaps(v), g = (k) => est[k] && est[k].value;
  check('never overwrites a catalogue value', !('per' in est) && !('rstar' in est) && !('depth' in est) && !('mass' in est));
  check('M* from log g and R*', est.mstar.rel === 'gravity' && rel(g('mstar'), R.massFromLogg(4.438, 1)) < 1e-12 && Math.abs(g('mstar') - 1) < 0.01, `${g('mstar').toFixed(4)} Msun`);
  check('Rp/R* from depth, Rp from Rp/R*', rel(g('rprs'), 0.1) < 1e-12 && est.rprs.rel === 'depth' && rel(g('rp'), 0.1 / R.radiusRatio(1, 1)) < 1e-12 && est.rp.chain === true);
  check("a and a/R* from Kepler's law", est.a.rel === 'kepler3' && rel(g('a'), R.semiMajorAxis(g('mstar') + 9.5459426398e-4, 3)) < 1e-12 && rel(g('ars'), R.scaledAxis(g('a'), 1)) < 1e-12);
  check('duration: central transit assumed and said so', est.t14.rel === 't14' && /central transit assumed/.test(est.t14.note) && rel(g('t14'), exactDuration(3, g('ars'), 90, 0.1)) < 1e-6, `${(g('t14') * 24).toFixed(3)} h; ${est.t14.note}`);
  check('Teq, insolation, luminosity, K', rel(g('teq'), R.equilibriumTemperature(5772, g('ars'))) < 1e-12 && rel(g('lum'), 1) < 1e-3 && rel(g('insol'), 1 / g('a') ** 2) < 1e-3 && est.K.rel === 'rvk' && rel(g('K'), R.rvSemiAmplitude(1, g('mstar'), 3, 0, 90)) < 1e-12);
  check('every estimate names a relation and its inputs', Object.values(est).every((e) => R.RELATIONS[e.rel] && e.from.length && e.from.every((k) => k in v || k in est)), Object.entries(est).map(([k, e]) => `${k}:${e.rel}`).join(' '));
  const small = fillGaps({ transit: true, rp: 2.5 / R.RJUP_REARTH, per: 10, mstar: 0.8, rstar: 0.8, teff: 5000 });
  check('mass from radius (Chen & Kipping), then K marked as expected', small.mass.rel === 'ck17' && rel(small.mass.value * R.MJUP_MEARTH, R.massFromRadiusCK17(2.5).value) < 1e-9 && /Neptunian/.test(small.mass.note) && small.K.chain && /expected/.test(small.K.note), `${(small.mass.value * R.MJUP_MEARTH).toFixed(2)} Mearth, K = ${small.K.value.toFixed(2)} m/s`);
  check('no mass for a Jupiter-sized radius (not single-valued)', !fillGaps({ rp: 1.3 }).mass);
  const rv = fillGaps({ transit: false, mass: 0.05, massKind: 'Msini', per: 20, mstar: 1 });
  check('radius from M sin i says it is a lower limit; no depth or duration for a non-transiting planet', rv.rp.rel === 'ck17' && /lower limit/.test(rv.rp.note) && !rv.depth && !rv.t14);
  const dwarf = fillGaps({ teff: 3500 }), giant = fillGaps({ teff: 4800, logg: 2.5 }), tor = fillGaps({ teff: 6000, logg: 4.3, feh: 0.1 });
  check('star from Teff: dwarf sequence only without evidence of evolution', dwarf.rstar.rel === 'pm13' && /main-sequence star assumed/.test(dwarf.rstar.note) && rel(dwarf.rstar.value, R.dwarfFromTeff(3500).rstar) < 1e-12 && (!giant.rstar || giant.rstar.rel !== 'pm13') && (!giant.mstar || giant.mstar.rel !== 'pm13'), `giant: ${giant.mstar ? giant.mstar.rel : 'no estimate'}`);
  check('star from Teff, log g, [Fe/H]: Torres et al. 2010', tor.mstar.rel === 'torres10' && tor.rstar.rel === 'torres10' && tor.mstar.value > 1 && tor.mstar.value < 1.4, `${tor.mstar.value.toFixed(3)} Msun, ${tor.rstar.value.toFixed(3)} Rsun`);
  const mism = fillGaps({ teff: 5000, rstar: 3.5 });
  check('no dwarf mass for a star whose radius is not a dwarf\'s', !mism.mstar);
}

// --- merged rows
{
  const a = rec('nea', 'M-1 b', 'M-1', 10, 20, 3.0), b = rec('eu', 'M-1 Ab', 'M-1 A', 10, 20, 3.001);
  Object.assign(a.v, { tmid: 2455000, rp: 1.0, transit: true, status: 'Confirmed' }); a.e.per = [1e-6, 1e-6]; a.e.tmid = [1e-4, 1e-4]; a.e.rp = [0.02, 0.02]; a.ref.per = 'Paper 2020';
  Object.assign(b.v, { tmid: 2456000.5, rp: 1.3, teff: 5500, status: 'Confirmed' }); b.e.per = [1e-6, 1e-6]; b.e.rp = [0.03, 0.03];
  const now = 2461000, r = makeRow({ nea: a, eu: b }, 'nea', now), r2 = makeRow({ nea: a, eu: b }, 'eu', now);
  check('values carry their catalogue; gaps of one are filled from the other', r.src.per === 'nea' && r.v.per === 3.0 && r.ref.per === 'Paper 2020' && r.src.teff === 'eu' && r.v.teff === 5500 && r.cats.join() === 'nea,eu');
  check('preference switches the catalogue shown', r2.src.per === 'eu' && r2.v.per === 3.001 && r2.src.rp === 'eu' && r2.v.rp === 1.3 && r2.name === 'M-1 b');
  check('period and epoch are never mixed between catalogues', r.src.tmid === 'nea' && r2.src.tmid === 'eu');
  check('disagreements listed with both values', r.diff.per && r.diff.per.nea === 3.0 && r.diff.per.eu === 3.001 && r.diff.per.nsigma > 100 && r.diff.rp && r.diff.tmid && r.ndiff === 3, Object.keys(r.diff).join() + ' ' + JSON.stringify(r.diff.tmid));
  check('timing uncertainty today', Math.abs(r.v.drift - Math.hypot(1e-4, 2000 * 1e-6) * 1440) < 1e-9 && r2.v.drift === undefined, `${r.v.drift.toFixed(2)} min after 2000 orbits`);
  check('estimates are in the row and marked', r.est.mstar && r.v.mstar === r.est.mstar.value && r.src.mstar === undefined && r.nest > 3);
}

// --- the real snapshots
const root = new URL('../public/', import.meta.url);
if (!SOURCES.every((s) => existsSync(new URL(s.file, root)))) check('snapshots built (tools/build_catalog_table.py, tools/build_catalog_eu.py)', false);
else {
  const L = await loadSources(async (f) => JSON.parse(readFileSync(new URL(f, root))));
  for (const s of SOURCES) console.log(`info ${s.id}: ${L[s.id].records.length} rows, snapshot ${L[s.id].meta.date}, ${(readFileSync(new URL(s.file, root)).length / 1e6).toFixed(2)} MB`);
  check('all three load', SOURCES.every((s) => !L[s.id].error && L[s.id].records.length > 5000));
  const w = L.nea.records.find((r) => r.name === 'WASP-12 b');
  check('NEA units: hours -> days, per cent -> fraction; values carry references', w && Math.abs(w.v.t14 * 24 - 3.0) < 0.3 && w.v.depth > 0.01 && w.v.depth < 0.02 && /\d{4}/.test(w.ref.per) && w.ref.per === w.ref.tmid && w.info.ephemerisPaired && w.v.transit === true, w && `T14 ${(w.v.t14 * 24).toFixed(3)} h, depth ${(100 * w.v.depth).toFixed(3)}%, ephemeris from ${w.ref.per}`);
  const paired = L.nea.records.filter((r) => r.info.ephemerisPaired).length, tr = L.nea.records.filter((r) => r.v.transit).length;
  console.log(`info NEA: ${tr} transiting, ${paired} with P and T0 from one reference`);
  const t = L.toi.records.find((r) => r.name === 'TOI-700.01');
  check('TOI units: ppm -> fraction, Rearth -> Rjup', t && t.v.depth > 1e-4 && t.v.depth < 5e-3 && t.v.rp * R.RJUP_REARTH > 0.5 && t.v.rp * R.RJUP_REARTH < 4 && t.v.tmid > 2.45e6, t && `${t.name}: depth ${(1e6 * t.v.depth).toFixed(0)} ppm, ${(t.v.rp * R.RJUP_REARTH).toFixed(2)} Rearth, ${t.v.status}`);
  const st = {}; for (const r of L.toi.records) st[r.v.status] = (st[r.v.status] || 0) + 1; console.log('info TOI status: ' + JSON.stringify(st));

  const T = buildTable(L, { now: 2461360 }), M = T.match, s = M.stats;
  console.log('info match: ' + JSON.stringify(s));
  check('at least 97% of the archive\'s planets are found in exoplanet.eu', s.matched / s.nA > 0.97, `${s.matched} of ${s.nA} (${(100 * s.matched / s.nA).toFixed(1)}%): ${s.byStage.name} by name, ${s.byStage.alias} by alias, ${s.byStage['host+letter']} by host and letter, ${s.byStage.position} by position and period; ${s.onlyA} archive-only, ${s.onlyB} exoplanet.eu-only`);
  const known = [['WASP-12 b', 'WASP-12 Ab'], ['55 Cnc e', '55 Cnc Ae'], ['HAT-P-32 b', 'HAT-P-32 Ab'], ['TRAPPIST-1 b', 'TRAPPIST-1 b'], ['Kepler-11 g', 'Kepler-11 g'], ['HD 80606 b', 'HD 80606 b'], ['HD 10697 b', '109 Psc b'], ['Barnard b', "Barnard's star b"], ['HAT-P-1 b', 'HAT-P-1 Bb']];
  const got = known.map(([a, b]) => { const p = M.pairs.find((x) => x.a.name === a); return p && p.b.name === b ? p.stage : null; });
  check('known pairs', got.every(Boolean), known.map(([a, b], i) => `${a} = ${b} (${got[i]})`).join('; '));
  // independent evidence on the name-based pairs: positions and periods
  const named = M.pairs.filter((p) => p.stage !== 'position'), far = named.filter((p) => p.sep > 0.25), perOff = named.filter((p) => p.dper > 0.2), perBoth = named.filter((p) => Number.isFinite(p.dper));
  const close = named.filter((p) => p.sep <= 0.02).length, haveSep = named.filter((p) => Number.isFinite(p.sep)).length;
  console.log(`info name-based pairs: ${close} of ${haveSep} within 72 arcsec; ${far.length} more than 0.25 deg apart (${far.slice(0, 6).map((p) => `${p.a.name} ${p.sep.toFixed(1)} deg`).join(', ')} ...);`);
  console.log(`info   periods: ${perBoth.filter((p) => p.dper < 0.01).length} of ${perBoth.length} agree within 1%; ${perOff.length} differ by more than 20% (${perOff.slice(0, 6).map((p) => `${p.a.name} ${p.a.v.per} vs ${p.b.v.per}`).join(', ')} ...)`);
  check('name-based pairs agree on the sky and in period', close / haveSep > 0.98 && perBoth.filter((p) => p.dper < 0.01).length / perBoth.length > 0.95);
  const pos = M.pairs.filter((p) => p.stage === 'position'), letterDiff = pos.filter((p) => planetLetter(p.a.name) && planetLetter(p.b.name) && planetLetter(p.a.name) !== planetLetter(p.b.name));
  console.log(`info position pairs: ${pos.length}, of which ${letterDiff.length} carry different planet letters (${letterDiff.slice(0, 5).map((p) => `${p.a.name} = ${p.b.name}`).join(', ')})`);
  // what was missed: archive-only planets with an unmatched exoplanet.eu object within 1 arcmin
  const missed = M.onlyA.filter((a) => M.onlyB.some((b) => separation(a, b) < 1 / 60));
  console.log(`info possibly missed: ${missed.length} archive-only planets have an unmatched exoplanet.eu object within 1 arcmin (${missed.slice(0, 8).map((a) => a.name).join(', ')})`);
  console.log(`info rejected alias/host pairs: ${M.rejectedPairs.map((p) => `${p.a.name} | ${p.b.name} (${p.why})`).slice(0, 8).join('; ')}`);
  const om = {}; for (const r of M.onlyB) { const k = /Imaging/.test(r.v.method) ? 'imaging' : /Transit/.test(r.v.method) ? 'transit' : /Radial/.test(r.v.method) ? 'radial velocity' : /Micro/.test(r.v.method) ? 'microlensing' : /Timing/.test(r.v.method) ? 'timing' : 'other'; om[k] = (om[k] || 0) + 1; }
  console.log('info exoplanet.eu-only by method: ' + JSON.stringify(om));

  check('table has one row per object', T.rows.length === s.matched + s.onlyA + s.onlyB + L.toi.records.length && new Set(T.rows.map((r) => r.key)).size === T.rows.length, `${T.rows.length} rows`);
  check('every estimate in the table cites a relation', T.rows.every((r) => Object.values(r.est).every((e) => R.RELATIONS[e.rel] && Number.isFinite(e.value))));
  check('no estimate replaces a catalogue value', T.rows.every((r) => Object.keys(r.est).every((k) => !r.src[k])));
  const ec = {}; for (const r of T.rows) for (const k in r.est) { const kk = `${k} (${r.est[k].rel})`; ec[kk] = (ec[kk] || 0) + 1; }
  console.log('info estimates: ' + Object.entries(ec).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  const dc = {}; for (const r of T.rows) for (const k in r.diff) dc[k] = (dc[k] || 0) + 1;
  console.log(`info disagreements: ${T.rows.filter((r) => r.ndiff).length} of ${s.matched} matched planets differ in at least one quantity: ` + Object.entries(dc).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  const f = findRow(T.rows, 'wasp-12b'), f2 = findRow(T.rows, '109 Psc b'), f3 = findRow(T.rows, 'TOI-700.01');
  check('findRow by name, by another catalogue\'s name, and a TOI', f && f.name === 'WASP-12 b' && f2 && f2.name === 'HD 10697 b' && f3 && f3.cats.join() === 'toi' && findRow(T.rows, 'no such planet') === null);
  const tr2 = T.rows.filter((r) => r.v.transit && r.v.per > 0 && Number.isFinite(r.v.tmid)), withT = tr2.filter((r) => r.v.t14 > 0), estT = tr2.filter((r) => r.est.t14), drift = tr2.filter((r) => r.v.drift > 0).map((r) => r.v.drift).sort((a, b) => a - b);
  console.log(`info planner inputs: ${tr2.length} transiting objects with an ephemeris, ${withT.length} with a duration (${estT.length} estimated); timing uncertainty today: median ${drift[drift.length >> 1].toFixed(1)} min, ${drift.filter((d) => d > 30).length} above 30 min, ${drift.filter((d) => d > 120).length} above 2 h (${drift.length} with errors on P and T0)`);
  // --- the two ephemerides an archive planet carries (the planner offers both)
  {
    const now = Date.parse(L.nea.meta.date) / 86400000 + 2440587.5, sg = (e) => Math.hypot(e.tmidErr, (now - e.tmid) / e.per * e.perErr);
    const E = L.nea.records.filter((r) => r.info.ephemerides.best), both = E.filter((r) => r.info.ephemerides.best.kind === 'best' && r.info.ephemerides.default && r.info.ephemerides.default.kind === 'default' && r.info.ephemerides.default.hasErr);
    const differ = both.filter((r) => r.info.ephemerides.best.ref !== r.info.ephemerides.default.ref), worse = both.filter((r) => sg(r.info.ephemerides.best) > sg(r.info.ephemerides.default) * (1 + 1e-9));
    const gain = differ.map((r) => sg(r.info.ephemerides.default) / sg(r.info.ephemerides.best)).sort((a, b) => a - b);
    check('NEA ephemerides: "best" is what the row uses and never predicts worse today than the archive default', E.length > 4000 && E.every((r) => r.info.ephemerides.best.per === r.v.per && r.info.ephemerides.best.tmid === r.v.tmid) && worse.length === 0 && both.length > 3000,
      `${E.length} planets with an ephemeris; ${both.length} have both a best-timed pair and a default row with errors, ${differ.length} of them from different references (the default predicts ${gain[gain.length >> 1].toFixed(1)}x less precisely at the median); ${worse.length} where best is worse`);
    const hp = L.nea.records.find((r) => r.name === 'HAT-P-32 b').info.ephemerides, comp = E.filter((r) => r.info.ephemerides.best.kind === 'composite');
    check('NEA ephemerides: references, time systems and the composite fallback', hp.best.ref === 'Kokori et al. 2023' && hp.default.ref === 'Wang et al. 2019' && hp.best.tsys === 'BJD-TDB' && !hp.best.mixed && comp.every((r) => r.info.ephemerides.default.kind !== 'best'),
      `HAT-P-32 b: best ${hp.best.ref} (${(sg(hp.best) * 1440).toFixed(2)} min today), default ${hp.default.ref} (${(sg(hp.default) * 1440).toFixed(2)} min); ${comp.length} planets fall back to the composite values, ${comp.filter((r) => r.info.ephemerides.best.mixed).length} of them mixing two references`);
  }
  check('field registry covers the row values', T.rows.slice(0, 500).every((r) => Object.keys(r.v).every((k) => FIELDS[k])));
}
process.exit(ok ? 0 : 1);
