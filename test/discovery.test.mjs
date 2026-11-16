// Discovery methods on the Observe page (src/sky/discovery.js): the archive's discoverymethod strings in five groups
// and the TESS candidates in a sixth, the host groups of public/sky/hosts.json (written by tools/build_sky_data.py in
// Python) against the same rule run here on the composite-table snapshot public/catalog-table/nea.json, and both
// against the archive's own counts (a TAP query of pscomppars, see ARCHIVE below), the filter, the colours (WCAG
// contrast on the night sky, and how far apart they stay for simulated protanopia, deuteranopia and tritanopia),
// the SIMBAD link.
import { readFileSync } from 'node:fs';
import * as D from '../src/sky/discovery.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const json = (p) => JSON.parse(readFileSync(new URL('../public/' + p, import.meta.url)));

// --- every string of the archive, and a few spellings of other catalogues
{
  const want = { 'Transit': 't', 'Radial Velocity': 'r', 'Imaging': 'i', 'Microlensing': 'm', 'Transit Timing Variations': 'o', 'Eclipse Timing Variations': 'o', 'Orbital Brightness Modulation': 'o',
    'Astrometry': 'o', 'Pulsar Timing': 'o', 'Pulsation Timing Variations': 'o', 'Disk Kinematics': 'o', 'radial velocity': 'r', ' RV ': 'r', 'Direct Imaging': 'i', 'primary transit': 't', '': '', 'ttv': 'o' };
  const bad = Object.entries(want).filter(([s, g]) => D.groupOf(s) !== g);
  check('archive strings to the five groups', !bad.length, `${Object.keys(want).length} strings${bad.length ? '; wrong: ' + bad.map(([s]) => s).join(', ') : ''}`);
  check('null and undefined have no group', D.groupOf(null) === '' && D.groupOf(undefined) === '');
}
// --- the snapshot: every planet's method has a group; counts per group
const nea = json('catalog-table/nea.json'), col = Object.fromEntries(nea.columns.map((c, i) => [c[0], i])), str = (v) => (typeof v === 'number' ? nea.strs[v] : v || '');
const planets = nea.rows.map((r) => ({ host: r[col.hostname], method: str(r[col.discoverymethod]), year: r[col.disc_year] }));
{
  const methods = new Map(); for (const p of planets) methods.set(p.method, (methods.get(p.method) || 0) + 1);
  const per = {}; for (const p of planets) { const g = D.groupOf(p.method); per[g] = (per[g] || 0) + 1; }
  check('every planet of the snapshot has a discovery method', !methods.has(''), `${planets.length} planets, ${methods.size} distinct strings`);
  check('planets per group (the archive has no candidates)', 'trimo'.split('').every((g) => per[g] > 0) && !per.c, D.GROUPS.filter((g) => g.id !== 'c').map((g) => `${g.label} ${per[g.id]}`).join(', ') + ` (snapshot ${nea.date})`);
}
// --- hosts.json (Python) against hostGroups (here)
{
  const by = new Map(); for (const p of planets) { if (!by.has(p.host)) by.set(p.host, []); by.get(p.host).push(p); }
  const all = json('sky/hosts.json').hosts, hosts = all.filter((h) => h[4] > 0);
  const diff = hosts.filter((h) => h[5] !== D.hostGroups([...(by.get(h[0]) || []), ...(h[6] ? h[6][2].map(() => ({ candidate: true })) : [])]));
  check('hosts.json groups = hostGroups() on the snapshot, every confirmed host', hosts.length > 4000 && !diff.length && hosts.length === by.size, `${hosts.length} hosts (the snapshot has ${by.size}), ${diff.length} differ${diff.length ? ': ' + diff.slice(0, 3).map((h) => h[0] + ' ' + h[5]).join(', ') : ''}`);
  const col1 = {}, any = {}; for (const h of all) { col1[h[5][0]] = (col1[h[5][0]] || 0) + 1; for (const g of h[5]) any[g] = (any[g] || 0) + 1; }
  check('hosts per colour (and with the group at all)', true, D.GROUPS.map((g) => `${g.label} ${col1[g.id] || 0} (${any[g.id] || 0})`).join(', ') + `; mixed ${all.filter((h) => h[5].length > 1).length}`);
  // the archive's own counts: TAP https://exoplanetarchive.ipac.caltech.edu/TAP/sync, run on 2026-11-15 (the date of the
  //   snapshot): select discoverymethod, count(*), count(distinct hostname) from pscomppars group by discoverymethod
  const ARCHIVE = { date: '2026-11-15', planets: { 'Transit': 4799, 'Radial Velocity': 1205, 'Microlensing': 294, 'Imaging': 98, 'Transit Timing Variations': 29, 'Eclipse Timing Variations': 17, 'Orbital Brightness Modulation': 9, 'Astrometry': 8, 'Pulsar Timing': 8, 'Pulsation Timing Variations': 2, 'Disk Kinematics': 1 },
    hosts: { 'Transit': 3686, 'Radial Velocity': 879, 'Microlensing': 284, 'Imaging': 88, 'Transit Timing Variations': 29, 'Eclipse Timing Variations': 11, 'Orbital Brightness Modulation': 6, 'Astrometry': 8, 'Pulsar Timing': 6, 'Pulsation Timing Variations': 2, 'Disk Kinematics': 1 }, allHosts: 4862 };
  const sum = (o, g) => Object.entries(o).filter(([m]) => D.groupOf(m) === g).reduce((a, [, n]) => a + n, 0);
  if (nea.date === ARCHIVE.date) {
    const pg = {}; for (const p of planets) { const g = D.groupOf(p.method); pg[g] = (pg[g] || 0) + 1; }
    const okP = 'trimo'.split('').every((g) => pg[g] === sum(ARCHIVE.planets, g)), okH = 'trimo'.split('').every((g) => any[g] === sum(ARCHIVE.hosts, g));
    check('planets per group = the archive\'s count (TAP, same day)', okP, 'trimo'.split('').map((g) => `${D.groupInfo(g).short} ${pg[g]}/${sum(ARCHIVE.planets, g)}`).join(', '));
    check('hosts with each group = the archive\'s distinct hosts per method (TAP, same day)', okH && hosts.length === ARCHIVE.allHosts, 'trimo'.split('').map((g) => `${D.groupInfo(g).short} ${any[g]}/${sum(ARCHIVE.hosts, g)}`).join(', ') + `; ${hosts.length}/${ARCHIVE.allHosts} hosts (the other-method hosts sum without overlap: each of them has one such method)`);
  } else console.log(`     (the archive counts are of ${ARCHIVE.date}, the snapshot of ${nea.date}: not compared; re-run the TAP query above)`);
  // hiding a group removes exactly the hosts that have no other group that is on
  let bad = 0; for (let k = 0; k < 64; k++) { const f = D.GROUP_IDS.split('').filter((_, j) => k & (1 << j)).join(''); for (const h of all) { const want = [...(h[5] || 'o')].some((g) => f.includes(g)); if (D.hostShown(h[5], f) !== want) bad++; } }
  check('hostShown under the 64 filters: shown exactly when one of its groups is on', bad === 0, `${all.length} stars x 64 filters`);
  const known = { 'HD 209458': 'r', 'HR 8799': 'i', 'TRAPPIST-1': 't', 'OGLE-2006-BLG-109L': 'm', 'PSR B1257+12': 'o' }, got = Object.keys(known).map((n) => [n, (hosts.find((h) => h[0] === n) || [])[5]]);
  check('known systems', got.every(([n, g]) => g && g[0] === known[n]), got.map(([n, g]) => `${n} ${g}`).join(', '));
}
// --- ordering of a host's groups
check('most planets first', D.hostGroups([{ method: 'Transit', year: 2015 }, { method: 'Radial Velocity', year: 2010 }, { method: 'Transit', year: 2016 }]) === 'tr');
check('a tie: the earliest planet first', D.hostGroups([{ method: 'Transit', year: 2015 }, { method: 'Radial Velocity', year: 2010 }]) === 'rt');
check('a tie in year too: the order of the legend', D.hostGroups([{ method: 'Imaging', year: 2010 }, { method: 'Transit', year: 2010 }]) === 'ti');
check('candidates after the confirmed planets, however many', D.hostGroups([{ candidate: true }, { candidate: true }, { method: 'Radial Velocity', year: 2010 }]) === 'rc' && D.hostGroups([{ candidate: true, method: 'Transit' }]) === 'c');
check('a planet under the filter: candidates by c, the rest by their method', D.planetShown({ method: 'Transit', candidate: true }, 'trimo') === false && D.planetShown({ method: 'Transit', candidate: true }, 'c') === true && D.planetShown({ method: 'Radial Velocity' }, 'r') && !D.planetShown({ method: 'Radial Velocity' }, 't') && D.planetShown({ method: '' }, 'o'));
check('TOI status words: PC, APC and none are candidates; known planets and false positives are not', ['Candidate', 'Candidate (ambiguous)', 'Candidate (no disposition)'].every(D.isCandidateStatus) && !['Known planet (TOI entry)', 'False positive', 'False alarm', ''].some(D.isCandidateStatus));

// --- the filter
check('parseFilter: strings, arrays of ids, keys or labels, anything else = all',
  D.parseFilter('rt') === 'tr' && D.parseFilter(['transit', 'Radial velocity']) === 'tr' && D.parseFilter(['m', 'Other']) === 'mo' && D.parseFilter(null) === 'trimoc' && D.parseFilter('') === '' && D.parseFilter('xyz') === '' && D.parseFilter(['toi', 'rv']) === 'rc' && D.parseFilter(['TOI candidate']) === 'c');
check('a filter stored before the candidates: everything then is everything now; anything else as it was', D.migrateFilter('trimo') === 'trimoc' && D.migrateFilter('tr') === 'tr' && D.migrateFilter('') === '');
check('shownGroup: the first group that is on, else hidden',
  D.shownGroup('tr', 'trimo') === 't' && D.shownGroup('tr', 'rimo') === 'r' && D.shownGroup('tr', 'imo') === null && D.shownGroup('', 'o') === 'o' && D.shownGroup('', 't') === null);

// --- colours
{
  const cs = D.GROUPS.map((g) => g.color), bgs = { 'night sky': '#010207', 'night horizon': '#0a0e1c', 'card': '#080b12', 'deep twilight': '#13224a' };
  const G = D.GROUPS.length;
  check('a colour, a label and a letter per group, all different', G === 6 && new Set(cs).size === G && new Set(D.GROUPS.map((g) => g.label)).size === G && new Set(D.GROUPS.map((g) => g.short)).size === G);
  for (const [name, bg] of Object.entries(bgs)) {
    const r = cs.map((c) => D.contrast(c, bg)), min = Math.min(...r);
    check(`contrast on the ${name} ${bg} >= ${name === 'deep twilight' ? 3 : 4.5}`, min >= (name === 'deep twilight' ? 3 : 4.5), D.GROUPS.map((g, i) => `${g.short} ${r[i].toFixed(1)}`).join(', '));
  }
  check('WCAG contrast of black on white is 21', Math.abs(D.contrast('#000000', '#ffffff') - 21) < 1e-9);
  // colour-vision deficiency: Machado, Oliveira & Fernandes (2009) matrices at severity 1, on linear RGB; distances CIE76 in L*a*b*
  const M = { normal: [1, 0, 0, 0, 1, 0, 0, 0, 1], protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
    deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881], tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900] };
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lab = (rgb) => {
    const [r, g, b] = rgb.map((v) => Math.max(0, Math.min(1, v))), X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116); return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  for (const [name, m] of Object.entries(M)) {
    const L = cs.map((c) => { const v = D.rgb01(c).map(lin); return lab([0, 1, 2].map((k) => m[3 * k] * v[0] + m[3 * k + 1] * v[1] + m[3 * k + 2] * v[2])); });
    let min = Infinity, pair = ''; for (let a = 0; a < G; a++) for (let b = a + 1; b < G; b++) { const d = Math.hypot(L[a][0] - L[b][0], L[a][1] - L[b][1], L[a][2] - L[b][2]); if (d < min) { min = d; pair = D.GROUPS[a].short + '/' + D.GROUPS[b].short; } }
    check(`${name}: the closest two colours are still apart (CIE76 dE >= 10)`, min >= 10, `dE ${min.toFixed(1)} (${pair})`);
  }
}
// --- the SIMBAD link (the CfA mirror; the query form was fetched once by hand: sim-id?Ident=HD%20209458 -> 200, its basic data)
check('SIMBAD link, identifier URL-encoded', D.simbadUrl('HD 209458') === 'https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=HD%20209458' && D.simbadUrl('PSR B1257+12').endsWith('PSR%20B1257%2B12'));

// --- the kind of window a planner link carries (src/sky/events.js): event=eclipse|phase|custom, a transit otherwise
{
  const E = await import('../src/sky/events.js'), { KIND_COLOUR } = await import('../src/plan/chart.js');
  check('event parameter -> kind', E.eventKind('eclipse') === 'eclipse' && E.eventKind(' Phase ') === 'phase' && E.eventKind('custom') === 'custom' && E.eventKind(null) === 'transit' && E.eventKind('transit') === 'transit' && E.eventKind('toString') === 'transit' && E.eventKind('bogus') === 'transit');
  const k = Object.keys(E.EVENT_KINDS), same = k.every((x) => (E.EVENT_KINDS[x].planColor || E.EVENT_KINDS[x].color).toLowerCase() === String(KIND_COLOUR[x]).toLowerCase());
  check('window colours are the planner\'s (KIND_COLOUR)', same && k.length === Object.keys(KIND_COLOUR).length, k.map((x) => `${x} ${E.EVENT_KINDS[x].color}`).join(', '));
  check('every kind names its window and its three times', k.every((x) => E.EVENT_KINDS[x].title && E.EVENT_KINDS[x].marks.length === 3 && E.EVENT_KINDS[x].rows.length === 3) && E.EVENT_KINDS.transit.marks.join() === 'Ingress,Mid-transit,Egress', k.map((x) => `${E.EVENT_KINDS[x].title}: ${E.EVENT_KINDS[x].marks.join(' / ')}`).join('; '));
}

console.log(ok ? '\ndiscovery: all passed' : '\ndiscovery: FAILED'); process.exit(ok ? 0 : 1);
