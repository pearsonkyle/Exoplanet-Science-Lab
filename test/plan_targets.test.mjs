// The planner's targets and filters (src/plan/targets.js) on the catalogue snapshots: what each filter leaves, from
// Kitt Peak, with the earlier defaults (3 nights, depth >= 5 ppt, V <= 13, no TESS candidates) and the present ones
// (7 nights, 2 ppt, V <= 13, candidates on); that the candidates are the same as the Observe page's (hosts.json,
// written by tools/build_sky_data.py in Python with the same rule); the discovery-method filter (planets seen to
// transit, whatever found them; candidates as their own group).
import { readFileSync } from 'node:fs';
import { loadSources, buildTable } from '../src/core/sources/index.js';
import * as O from '../src/core/observability.js';
import * as T from '../src/plan/targets.js';
import * as D from '../src/sky/discovery.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const pub = (f) => JSON.parse(readFileSync(new URL('../public/' + f, import.meta.url)));

const loaded = await loadSources(async (f) => pub(f), ['nea', 'toi']);
const NOW = 2461360.0;                                                  // 2026-11-15 12:00 UTC: the snapshots' date
const rows = buildTable(loaded, { now: NOW }).rows, stats = {}, targets = T.makeTargets(rows, 'best', stats);
const site = { lat: 31.96333, lon: -111.6, elev: 2120 }, jd0 = O.noonBefore(NOW + 0.4, site.lon);
const EARLIER = { nights: 3, depth: 5, magMax: 13, magMin: null, src: { nea: true, toi: false, eu: false }, disc: D.GROUP_IDS, name: '' };
const NOWDEF = { nights: 7, depth: 2, magMax: 13, magMin: null, src: { nea: true, toi: true, eu: false }, disc: D.GROUP_IDS, name: '' };

// --- the candidates against hosts.json (Observe)
{
  const sky = new Set(); for (const h of pub('sky/hosts.json').hosts) if (h[6]) for (const c of h[6][2]) if (c[1] > 0 && c[3] > 0) sky.add(c[0]);
  const plan = new Set(targets.filter((t) => t.candidate).map((t) => t.name)), miss = [...sky].filter((x) => !plan.has(x)), extra = [...plan].filter((x) => !sky.has(x));
  check('TESS candidates of the planner = those of the Observe page (with a period and an epoch)', !miss.length && !extra.length, `${plan.size} candidates; left out: ${stats.tessKnown} known planets (KP, CP), ${stats.tessNotCandidate} false positives (FP, FA), ${stats.tessSamePeriod} with a confirmed planet's period on the same star`);
  check('no known planet or false positive among them', targets.filter((t) => t.candidate).every((t) => ['PC', 'APC', ''].includes(t.row.recs.toi.info.disposition)));
}
// --- discovery methods: planets seen to transit, whatever found them
{
  const c = T.discoveryCounts(rows, targets), rv = targets.filter((t) => t.group === 'r').map((t) => t.name);
  check('targets per discovery method (and archive planets with nothing to plan)', c.t.targets > 4000 && c.c.targets > 4000, D.GROUPS.map((g) => `${g.short} ${c[g.id].targets}${g.id === 'c' ? '' : ` (+${c[g.id].none})`}`).join(', '));
  check('planets found by radial velocity that transit are targets', ['HD 209458 b', 'HD 80606 b', '55 Cnc e'].every((n) => rv.includes(n)), `${rv.length}: ${rv.slice(0, 6).join(', ')}, …`);
  check('no imaging or microlensing planet has a transit ephemeris', c.i.targets === 0 && c.m.targets === 0, `imaging ${c.i.targets}, microlensing ${c.m.targets}`);
  const f = T.filterTargets(targets, { ...NOWDEF, disc: 'r' }).targets;
  check('the method filter keeps exactly that group', f.length && f.every((t) => t.group === 'r'), `${f.length} RV-found transiting planets with V <= 13 and depth >= 2 ppt`);
}
// --- what each filter leaves, Kitt Peak, earlier and present defaults
const table = [];
for (const [name, P] of [['earlier (3 nights, 5 ppt, no TOI)', EARLIER], ['earlier, 7 nights', { ...EARLIER, nights: 7 }], ['present (7 nights, 2 ppt, TOI on)', NOWDEF], ['present, NEA only', { ...NOWDEF, src: { nea: true, toi: false, eu: false } }]]) {
  const f = T.filterTargets(targets, P), reach = f.targets.filter((t) => 90 - Math.abs(site.lat - t.dec) >= 30);
  const ev = O.findObservableEvents(reach, site, { jd0, jd1: jd0 + P.nights, minAlt: 30, sunLimit: -18, baseline: 1 / 24, include: 'transit', kinds: ['transit'], padSigma: true });
  const full = ev.filter((e) => e.full);
  table.push({ name, steps: f.steps, reach: reach.length, full: full.length, fullToi: full.filter((e) => e.target.candidate).length, short: ev.length - full.length, planets: new Set(full.map((e) => e.target.name)).size });
}
console.log('     Kitt Peak, nights from ' + O.dateFromJd(jd0).toISOString().slice(0, 10) + ': targets left after each filter, then observable transits (whole region of interest; Sun < -18, alt > 30, 1 h baseline)');
console.log('     ' + ['settings'.padEnd(36), ...table[0].steps.map((s) => s[0].slice(0, 9).padStart(10)), 'reach 30°'.padStart(10), 'observable'.padStart(11), 'of them TOI'.padStart(12), '+short'.padStart(7)].join(''));
for (const r of table) console.log('     ' + [r.name.padEnd(36), ...r.steps.map((s) => String(s[1]).padStart(10)), String(r.reach).padStart(10), String(r.full).padStart(11), String(r.fullToi).padStart(12), String(r.short).padStart(7)].join(''));
check('present defaults: several times the observable transits of the earlier ones', table[2].full >= 5 * table[0].full && table[2].fullToi > 0 && table[3].full > table[1].full, `${table[0].full} -> ${table[2].full} (${table[2].fullToi} of them TESS candidates); confirmed only, 7 nights: ${table[1].full} -> ${table[3].full}`);

console.log(ok ? '\nplan_targets: all passed' : '\nplan_targets: FAILED'); process.exit(ok ? 0 : 1);
