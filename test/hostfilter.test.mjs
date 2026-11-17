// The host-star filter of the Observe page (src/sky/hostFilter.js):
//   - spectral classes against stars of known type (the archive's own spectral types, and Teff on the scale of
//     Pecaut & Mamajek 2013, table 5, for stars that have none);
//   - the star values of every host of public/sky/hosts.json from the planet table (src/core/sources, as the page
//     builds it) against the raw columns of the snapshot read here (st_teff, sy_dist, tran_flag), and from the TOI
//     table for the stars with candidates only; how many stay unknown (the panel says so);
//   - the filter: each limit against a brute-force pass written out here, unknown values in and out, the URL form.
import { readFileSync } from 'node:fs';
import * as F from '../src/sky/hostFilter.js';
import { hostMag } from '../src/sky/visible.js';
import { loadSources, buildTable } from '../src/core/sources/index.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const root = new URL('../public/', import.meta.url), json = (p) => JSON.parse(readFileSync(new URL(p, root)));

// --- spectral classes
{
  const cases = [['G2 V', NaN, 'G'], ['K1.5 V', NaN, 'K'], ['sdM4', NaN, 'M'], ['esdK7', NaN, 'K'], ['T8', NaN, 'L'], ['L1', NaN, 'L'], ['M8V', NaN, 'M'], ['A5', NaN, 'A'], ['DA', NaN, ''], ['', NaN, ''],
    // Teff alone: the Sun 5772 K (G2), HD 189733 5050 K (K1), TRAPPIST-1 2566 K (M8), WASP-33 7430 K (A5), KELT-9 10170 K (B9), a 2000 K L dwarf, boundaries
    ['', 5772, 'G'], ['', 5050, 'K'], ['', 2566, 'M'], ['', 7430, 'A'], ['', 10170, 'B'], ['', 2000, 'L'], ['', 5930, 'F'], ['', 5929, 'G'], ['', 31400, 'O'], ['', 3850, 'K'], ['', 3849, 'M'],
    ['G0 V', 4500, 'G']];       // the archive's type wins over Teff
  const bad = cases.filter(([s, t, c]) => F.spectralClass(s, t) !== c);
  check('spectral class from the type, else from Teff (Pecaut & Mamajek 2013 dwarf scale)', !bad.length, `${cases.length} cases${bad.length ? '; wrong: ' + bad.map((b) => b.join(' ')).join('; ') : ''}`);
}
// --- the URL form and normalisation
{
  const f = F.normalizeFilter({ magMin: 4, magMax: 9.5, teffMin: 3800, teffMax: null, spec: 'kgx', distMax: 100, minPlanets: 2, transiting: true, transitTonight: true, unknown: false });
  const s = F.encodeFilter(f), back = F.decodeFilter(s);
  check('URL form round trip', JSON.stringify(back) === JSON.stringify(f) && s === 'v4..9.5,t3800..,cGK,d..100,p2,tr,tt,u0', s);
  check('the default filter is empty in the URL and inactive', F.encodeFilter(F.DEFAULT_FILTER) === '' && !F.activeParts(F.DEFAULT_FILTER).any && F.normalizeFilter({ spec: 'OBAFGKML' }).spec === '');
  check('describe', F.describeFilter(f).join('; ') === 'mag 4–9.5; Teff ≥ 3800 K; type G, K; ≤ 100 pc; ≥ 2 planets; transiting; transit tonight; unknown values out', F.describeFilter(f).join('; '));
}
// --- the star values of the hosts, as the page builds them
const hosts = json('sky/hosts.json').hosts;
const L = await loadSources(async (f) => JSON.parse(readFileSync(new URL(f, root))), ['nea']);
const by = new Map(); for (const r of buildTable(L).rows) { if (!by.has(r.host)) by.set(r.host, []); by.get(r.host).push(r); }
const toiJ = json('catalog-table/toi.json'), toi = F.toiStarValues(toiJ);
const attrs = F.hostAttributes(hosts, (h) => by.get(h) || null, toi), noToi = F.hostAttributes(hosts, (h) => by.get(h) || null, null);
{
  // the raw columns, read here without src/core/sources: the first finite value of the host's rows
  const nea = json('catalog-table/nea.json'), c = Object.fromEntries(nea.columns.map((x, i) => [x[0], i])), v = (r, k) => (Array.isArray(r[c[k]]) ? r[c[k]][0] : r[c[k]]);
  const raw = new Map();
  for (const r of nea.rows) { const h = r[c.hostname], o = raw.get(h) || { teff: NaN, dist: NaN, tr: 0 }; if (!(o.teff > 0) && v(r, 'st_teff') > 0) o.teff = v(r, 'st_teff'); if (!(o.dist > 0) && v(r, 'sy_dist') > 0) o.dist = v(r, 'sy_dist'); if (v(r, 'tran_flag') === 1) o.tr = 1; raw.set(h, o); }
  let nT = 0, badT = 0, nD = 0, badD = 0, badTr = 0, estT = 0;
  hosts.forEach((h, i) => {
    const o = raw.get(h[0]); if (!o) return;
    if (o.teff > 0) { nT++; if (Math.abs(noToi.teff[i] - o.teff) > 0.5) badT++; } else if (Number.isFinite(noToi.teff[i])) estT++;
    if (o.dist > 0) { nD++; if (Math.abs(noToi.dist[i] / o.dist - 1) > 1e-6) badD++; }
    if (!h[6] && !!o.tr !== !!noToi.transit[i]) badTr++;
  });
  check('Teff of the hosts = st_teff of the snapshot', badT === 0, `${nT} hosts with st_teff, ${badT} differ; ${estT} more filled by src/core/relations (estimates, as the card shows them)`);
  check('distance = sy_dist', badD === 0, `${nD} hosts, ${badD} differ`);
  check('transit flag = any planet with tran_flag 1', badTr === 0, `${badTr} differ`);
  const cand = hosts.filter((h) => h[6] && !h[4]).length, ownTeff = hosts.reduce((n, h, i) => n + (h[6] && !h[4] && Number.isFinite(attrs.teff[i]) ? 1 : 0), 0);
  check('stars with candidates only take Teff and distance from the TOI table', ownTeff > 0.8 * cand, `${ownTeff} of ${cand} with Teff; ${attrs.fromToi} values from the TOI table`);
  const n = hosts.length;
  console.log(`     known for the ${n} stars: Teff ${attrs.known.teff} (${(100 * attrs.known.teff / n).toFixed(1)}%), distance ${attrs.known.dist} (${(100 * attrs.known.dist / n).toFixed(1)}%), class ${attrs.known.spec} (${(100 * attrs.known.spec / n).toFixed(1)}%); without the TOI table: Teff ${noToi.known.teff}, distance ${noToi.known.dist}`);
  check('every candidate host counts as transiting', hosts.every((h, i) => !h[6] || attrs.transit[i] === 1));

  // the values baked into hosts.json by tools/build_sky_data.py (Python), against the raw snapshot columns read here
  const baked = F.bakedAttributes(hosts);
  check('hosts.json carries the star values (eighth column)', !!baked, baked ? `Teff ${baked.known.teff}, distance ${baked.known.dist}, class ${baked.known.spec} of ${hosts.length}` : 'missing: rebuild with tools/build_sky_data.py --only hosts');
  if (baked) {
    const tc = Object.fromEntries(toiJ.columns.map((x, i) => [x[0], i])), tv = (r, k) => (Array.isArray(r[tc[k]]) ? r[tc[k]][0] : r[tc[k]]), traw = new Map();
    for (const r of toiJ.rows) { const t = r[tc.tid]; if (t == null) continue; const o = traw.get(+t) || { teff: NaN, dist: NaN }; if (!(o.teff > 0) && tv(r, 'st_teff') > 0) o.teff = tv(r, 'st_teff'); if (!(o.dist > 0) && tv(r, 'st_dist') > 0) o.dist = tv(r, 'st_dist'); traw.set(+t, o); }
    const sp = new Map(); for (const r of nea.rows) { const s = typeof r[c.st_spectype] === 'number' ? nea.strs[r[c.st_spectype]] : r[c.st_spectype] || ''; if (s && !sp.has(r[c.hostname])) sp.set(r[c.hostname], s); }
    let badT = 0, badD = 0, badC = 0, badTr = 0, fromToi = 0;
    hosts.forEach((h, i) => {
      const o = raw.get(h[0]) || { teff: NaN, dist: NaN, tr: 0 }, t2 = h[6] ? traw.get(+h[6][1]) || {} : {};
      const teff = o.teff > 0 ? o.teff : t2.teff > 0 ? t2.teff : NaN, dist = o.dist > 0 ? o.dist : t2.dist > 0 ? t2.dist : NaN;
      if (!(o.teff > 0) && t2.teff > 0) fromToi++;
      if (Number.isFinite(teff) ? Math.abs(baked.teff[i] - teff) > 0.5 : Number.isFinite(baked.teff[i])) badT++;
      if (Number.isFinite(dist) ? Math.abs(baked.dist[i] - dist) > 0.005 + 1e-6 * dist : Number.isFinite(baked.dist[i])) badD++;
      const cls = F.spectralClass(sp.get(h[0]) || '', teff); if ((baked.spec[i] ? F.SPEC_CLASSES[baked.spec[i] - 1] : '') !== cls) badC++;
      if (!!baked.transit[i] !== !!(o.tr || h[6])) badTr++;
    });
    check('baked Teff = st_teff (nea.json, else toi.json), to 0.5 K', badT === 0, `${badT} differ; ${fromToi} from the TOI table`);
    check('baked distance = sy_dist (else toi st_dist), to 0.005 pc', badD === 0, `${badD} differ`);
    check('baked class = spectralClass of st_spectype, else of Teff (Python rule = JS rule)', badC === 0, `${badC} differ`);
    check('baked transit flag = tran_flag or a TESS candidate', badTr === 0, `${badTr} differ`);
    let dt = 0; hosts.forEach((h, i) => { if (Number.isFinite(attrs.teff[i]) !== Number.isFinite(baked.teff[i]) || (Number.isFinite(attrs.teff[i]) && Math.abs(attrs.teff[i] - baked.teff[i]) > 0.5)) dt++; });
    console.log(`     baked against the fallback (planet table through src/core/sources + TOI table): Teff differs for ${dt} star(s)`);
  }
}
// --- the filter against a brute-force pass written out here
{
  const fs = [{ magMax: 8 }, { magMin: 6, magMax: 10, unknown: false }, { teffMin: 4000, teffMax: 6500 }, { teffMin: 4000, teffMax: 6500, unknown: false }, { spec: 'M' }, { spec: 'GK', unknown: false },
    { distMax: 50 }, { distMax: 50, unknown: false }, { minPlanets: 3 }, { transiting: true }, { transitTonight: true }, { magMax: 12, teffMax: 4000, distMax: 100, transiting: true, unknown: false }].map(F.normalizeFilter);
  const tonight = new Set([0, 5, 17, 400]);
  let bad = 0; const counts = [];
  for (const f of fs) {
    const t = F.hostTest(hosts, f, attrs, tonight); let n = 0;
    hosts.forEach((h, i) => {
      const m = hostMag(h), u = f.unknown, rg = (x, lo, hi) => (Number.isFinite(x) ? !(lo != null && x < lo) && !(hi != null && x > hi) : u);
      const cls = attrs.spec[i] ? F.SPEC_CLASSES[attrs.spec[i] - 1] : '';
      const want = (f.magMin == null && f.magMax == null || rg(m ?? NaN, f.magMin, f.magMax)) && (f.teffMin == null && f.teffMax == null || rg(attrs.teff[i], f.teffMin, f.teffMax))
        && (f.distMin == null && f.distMax == null || rg(attrs.dist[i], f.distMin, f.distMax)) && (!f.spec || (cls ? f.spec.includes(cls) : u))
        && h[4] + (h[6] ? h[6][2].length : 0) >= f.minPlanets && (!f.transiting || !!attrs.transit[i]) && (!f.transitTonight || tonight.has(i));
      if (want !== t(i)) bad++; if (want) n++;
    });
    counts.push(`${F.describeFilter(f).join(' ')}: ${n}`);
  }
  check('each limit, unknown values in and out, = brute force', bad === 0, `${fs.length} filters; ${bad} disagreements`);
  console.log('     ' + counts.join(' · '));
  const c = F.filterCounts(hosts, F.normalizeFilter({ teffMax: 4000 }), attrs, null);
  check('filterCounts: hosts passing with an unknown Teff are counted', c.unknownIn.teff === hosts.length - attrs.known.teff && c.pass >= c.unknownIn.teff, `${c.pass} pass, ${c.unknownIn.teff} of them with Teff unknown`);
  const pre = F.hostTest(hosts, F.normalizeFilter({ transiting: true }), null, null);
  check('before the tables: "transiting" = discovery group t or c', hosts.every((h, i) => pre(i) === /[tc]/.test(h[5] || '')));
}
process.exit(ok ? 0 : 1);
