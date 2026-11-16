// The Observe page's list of visible stars with planets and its TESS candidates (src/sky/visible.js):
//   - the highest altitude in a span of time against brute-force sampling with astro.js;
//   - the candidates of public/sky/hosts.json (tools/build_sky_data.py, Python) against the TOI snapshot read again
//     here with the rule written out (TFOPWG PC, APC or none; not CP, KP, FP, FA; not a period the archive gives a
//     confirmed planet of the same star);
//   - their transit times against the planner's findObservableEvents (src/core/observability.js);
//   - the visible list: altitudes against astro.js, the discovery filter (a host is listed exactly when one of its
//     groups is on), the counts per group, the sorts, the magnitude and planet-count limits.
import { readFileSync } from 'node:fs';
import * as A from '../src/core/astro.js';
import * as O from '../src/core/observability.js';
import * as V from '../src/sky/visible.js';
import * as D from '../src/sky/discovery.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const json = (p) => JSON.parse(readFileSync(new URL('../public/' + p, import.meta.url)));
const { RAD, DEG } = A;
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// --- highest altitude in a span
{
  let worst = 0, worstT = 0;
  for (let k = 0; k < 150; k++) {
    const ra = rnd() * 2 * Math.PI, dec = Math.asin(2 * rnd() - 1), lat = (rnd() * 140 - 70) * RAD, lon = (rnd() * 360 - 180) * RAD, t0 = Date.UTC(2026, 10, 15) + rnd() * 864e5 * 30, t1 = t0 + (2 + rnd() * 14) * 36e5;
    const m = V.maxAltitudeIn(ra, dec, t0, t1, lat, lon);
    let best = -9, bt = 0; for (let t = t0; t <= t1; t += 20000) { const a = A.fixedAltAz(ra, dec, t, lat, lon).alt; if (a > best) { best = a; bt = t; } }
    worst = Math.max(worst, best - m.alt); if (Math.abs(best - m.alt) > 1e-6) worstT = Math.max(worstT, Math.abs(bt - m.t) / 6e4);
  }
  check('highest altitude in a span (culmination or an end) = brute force every 20 s', worst < 2e-6, `150 random stars, sites, spans; brute force higher by at most ${(worst * DEG * 3600).toFixed(3)}″`);
}

// --- the candidates in hosts.json against the TOI snapshot, rule written out here
const hj = json('sky/hosts.json'), hosts = hj.hosts;
{
  const toi = json('catalog-table/toi.json'), tc = Object.fromEntries(toi.columns.map((c, i) => [c[0], i])), str = (v) => (typeof v === 'number' ? toi.strs[v] : v || '');
  const nea = json('catalog-table/nea.json'), nc = Object.fromEntries(nea.columns.map((c, i) => [c[0], i])), nstr = (v) => (typeof v === 'number' ? nea.strs[v] : v || '');
  const ticHost = new Map(), pers = new Map();
  // every period the archive gives a planet: the composite, the best-timed pair and the default set (they can disagree)
  for (const r of nea.rows) { const t = nstr(r[nc.tic_id]); if (t) ticHost.set(+String(t).replace('TIC', '').trim(), r[nc.hostname]); const v = (k) => (Array.isArray(r[nc[k]]) ? r[nc[k]][0] : r[nc[k]]), p0 = v('pl_orbper'); for (const k of ['pl_orbper', 'eph_per', 'def_per']) { const p = v(k); if (k !== 'pl_orbper' && p0 > 0 && Math.abs(p / p0 - 1) > 0.01) continue; /* another planet's period (nea.js ignores it too) */ if (p > 0) { if (!pers.has(r[nc.hostname])) pers.set(r[nc.hostname], []); pers.get(r[nc.hostname]).push(p); } } }
  const want = new Set(), disp = {};
  for (const r of toi.rows) {
    const d = str(r[tc.tfopwg_disp]); disp[d || 'none'] = (disp[d || 'none'] || 0) + 1;
    if (!['PC', 'APC', ''].includes(d)) continue;
    const p = Array.isArray(r[tc.pl_orbper]) ? r[tc.pl_orbper][0] : r[tc.pl_orbper], host = ticHost.get(r[tc.tid]);
    if (host && p > 0 && (pers.get(host) || []).some((q) => Math.abs(p - q) / q < 0.01)) continue;
    want.add('TOI-' + r[tc.toi].toFixed(2));
  }
  const got = new Set(), dispGot = new Set(); let onKnown = 0, own = 0, badGroups = 0;
  for (const h of hosts) { const cs = V.candidatesOf(h); for (const c of cs) { got.add(c.name); dispGot.add(c.disposition); } if (cs.length) { if (h[4] > 0) onKnown++; else own++; if (!h[5].endsWith('c')) badGroups++; } else if (h[5].includes('c')) badGroups++; }
  const miss = [...want].filter((x) => !got.has(x)), extra = [...got].filter((x) => !want.has(x));
  check('TOI snapshot: dispositions', true, Object.entries(disp).map(([k, v]) => `${k} ${v}`).join(', ') + ` (snapshot ${toi.date})`);
  check('hosts.json candidates = PC, APC and undisposed TOIs that are not a confirmed planet', !miss.length && !extra.length && want.size > 4000, `${got.size} candidates; missing ${miss.length}, extra ${extra.length}${miss.length ? ' e.g. ' + miss.slice(0, 3) : ''}`);
  check('no candidate is CP, KP, FP or FA', [...dispGot].every((d) => ['PC', 'APC', ''].includes(d)), [...dispGot].join(', '));
  check('candidate stars: their own (TOI-n) or a confirmed host; group c last', badGroups === 0 && own > 4000, `${own} stars of their own, ${onKnown} with confirmed planets too`);
  const t1 = hosts.find((h) => h[0] === 'TOI-1231' || (h[6] && h[6][2].some((c) => c[0] === 'TOI-1231.01')));
  check('a known planet under its TOI name is not a candidate (TOI-1231.01 = TOI-1231 b, KP or CP)', !got.has('TOI-1231.01'), t1 ? 'TOI-1231 is listed with ' + t1[5] : 'not in the list');
  const sorted = hosts.every((h, i) => i === 0 || (V.hostMag(hosts[i - 1]) ?? 99) <= (V.hostMag(h) ?? 99) + 1e-9);
  check('hosts.json sorted by V, else the TESS magnitude', sorted, `${hosts.length} stars, ${hosts.filter((h) => h[3] == null && V.hostBand(h) === 'T').length} sorted by T`);
}
check('TOI names: TOI-1234.01, TOI 1234.1, toi1234, not a TOI', JSON.stringify(V.parseToi('TOI-1234.01')) === '{"host":"TOI-1234","planet":"TOI-1234.01"}' && V.parseToi('TOI 1234.1').planet === 'TOI-1234.01' && V.parseToi('toi1234').planet === null && V.parseToi('toi1234').host === 'TOI-1234' && V.parseToi('WASP-12 b') === null);

// --- the candidates' transits against the planner's
{
  const site = { lat: 31.96333, lon: -111.6, elev: 2120 }, jd0 = O.noonBefore(2461360.0, site.lon), jd1 = jd0 + 3;
  let n = 0, worst = 0, cmp = 0;
  for (const h of hosts) {
    if (!h[6] || n >= 300) continue;
    const ps = V.candidatesOf(h).filter((p) => p.per > 0 && p.t14 > 0 && Number.isFinite(p.tmid)); if (!ps.length) continue; n++;
    const mine = V.transitsIn(ps, h[1], h[2], (jd0 - 2440587.5) * 864e5, (jd1 - 2440587.5) * 864e5);
    const plan = O.findObservableEvents(ps.map((p) => ({ ...p, ra: h[1], dec: h[2] })), { ...site, lat: h[2] > 0 ? 40 : -30 }, { jd0, jd1, minAlt: 0, sunLimit: 90, baseline: 0, include: 'partial', minCoverage: 0 });
    for (const e of plan) { const m = mine.find((x) => x.planet === e.target.name && Math.abs(x.mid - (e.mid - 2440587.5) * 864e5) < 6e4); cmp++; if (m) worst = Math.max(worst, Math.abs(m.mid - (e.mid - 2440587.5) * 864e5)); else worst = Infinity; }
  }
  check('candidate transit times = the planner\'s (same ephemeris, light time)', cmp > 50 && worst < 1, `${cmp} transits of ${n} candidate stars, largest difference ${worst.toFixed(3)} ms`);
}

// --- the visible list
{
  const pos = new Float32Array(hosts.length * 3); hosts.forEach((h, i) => pos.set(A.sphToVec(h[1] * RAD, h[2] * RAD), i * 3));
  const lat = 31.96333 * RAD, lon = -111.6 * RAD, now = Date.UTC(2026, 10, 16, 5, 0), tw = A.nightOf(now, lat, lon), dark = { t0: tw.nautical.evening, t1: tw.nautical.morning };
  const all = V.visibleHosts(hosts, pos, { lat, lon, now, when: 'now', limit: 1e6 });
  let worst = 0; for (const r of all.rows.slice(0, 400)) { const h = hosts[r.i], a = A.fixedAltAz(h[1] * RAD, h[2] * RAD, now, lat, lon); worst = Math.max(worst, Math.abs(a.alt - r.alt), Math.abs(A.wrapPi(a.az - r.az)) * Math.cos(a.alt)); }
  check('altitudes and azimuths of the list = astro.js fixedAltAz', worst < 1e-6, `${(worst * DEG * 3600).toFixed(4)}″ at most, 400 stars`);
  const upNow = hosts.map((h) => A.fixedAltAz(h[1] * RAD, h[2] * RAD, now, lat, lon).alt > 0);
  const brute = {}; hosts.forEach((h, i) => { if (upNow[i]) for (const g of new Set(h[5] || 'o')) brute[g] = (brute[g] || 0) + 1; });
  check('legend counts: stars up now per group', D.GROUP_IDS.split('').every((g) => (brute[g] || 0) === (all.counts[g] || 0)), D.GROUPS.map((g) => `${g.short} ${all.counts[g.id] || 0}`).join(', ') + ` of ${upNow.filter(Boolean).length} up, Kitt Peak 2026-11-16 05:00 UTC`);
  // every one of the 64 filters: listed exactly when one of the star's groups is on; a mixed system stays while any is on
  let bad = 0, mixedKept = 0;
  for (let k = 0; k < 64; k++) {
    const f = D.GROUP_IDS.split('').filter((_, j) => k & (1 << j)).join(''), r = V.visibleHosts(hosts, pos, { lat, lon, now, when: 'now', filter: f, limit: 1e6 });
    const set = new Set(r.rows.map((x) => x.i)), want = hosts.filter((h, i) => upNow[i] && [...(h[5] || 'o')].some((g) => f.includes(g))).length;
    if (set.size !== want || r.rows.some((x) => !f.includes(x.group) || !(hosts[x.i][5] || 'o').includes(x.group) || (hosts[x.i][5] || 'o')[[...(hosts[x.i][5] || 'o')].findIndex((g) => f.includes(g))] !== x.group)) bad++;
    if (f === 'r') mixedKept = r.rows.filter((x) => hosts[x.i][5].length > 1 && hosts[x.i][5][0] !== 'r').length;
  }
  check('the 64 discovery filters: a star is listed exactly when one of its groups is on, drawn in the first of those', bad === 0, `${bad} filters wrong; with RV alone, ${mixedKept} mixed systems coloured by another method stay (in orange)`);
  const tonight = V.visibleHosts(hosts, pos, { lat, lon, now, dark, when: 'tonight', minAlt: 30 * RAD, limit: 1e6, sort: 'maxalt' });
  let tb = 0; for (const r of tonight.rows.slice(0, 200)) { if (!(r.maxAlt >= 30 * RAD)) tb++; }
  const dec = tonight.rows.every((r, i) => i === 0 || tonight.rows[i - 1].maxAlt >= r.maxAlt);
  check('tonight above 30°: every star reaches 30° in the dark hours, sorted by its highest', tb === 0 && dec && tonight.total > all.total / 4, `${tonight.total} stars (now above the horizon: ${all.total}); dark ${new Date(dark.t0).toISOString().slice(11, 16)}–${new Date(dark.t1).toISOString().slice(11, 16)} UTC`);
  const bright = V.visibleHosts(hosts, pos, { lat, lon, now, when: 'now', magMax: 8, minPlanets: 2, sort: 'mag', limit: 1e6 });
  check('magnitude and planet-count limits, sorted by brightness', bright.rows.every((r, i) => r.mag <= 8 && r.planets + r.candidates >= 2 && (i === 0 || bright.rows[i - 1].mag <= r.mag)), `${bright.total} up now with V ≤ 8 and at least 2 planets; first ${bright.rows.slice(0, 3).map((r) => r.name).join(', ')}`);
  const names = V.visibleHosts(hosts, pos, { lat, lon, now, when: 'now', sort: 'name', limit: 1e6 }).rows;
  check('sorted by name (numbers in order: TOI-99 before TOI-100)', names.every((r, i) => i === 0 || names[i - 1].name.localeCompare(r.name, 'en', { numeric: true }) <= 0));
  const wall = V.visibleHosts(hosts, pos, { lat, lon, now, when: 'now', horizon: (az) => (az > Math.PI ? 89 * RAD : 0), limit: 1e6 });
  check('a terrain horizon hides what is behind it', wall.rows.every((r) => r.az <= Math.PI) && wall.total < all.total, `${wall.total} of ${all.total} with a wall over the western half`);
}

console.log(ok ? '\nvisible: all passed' : '\nvisible: FAILED'); process.exit(ok ? 0 : 1);
