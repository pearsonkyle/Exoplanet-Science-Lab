// Compare the planner with the Swarthmore transit finder (https://astro.swarthmore.edu/transits/).
//
//   node tools/compare_swarthmore.mjs [test/swarthmore_reference.csv]
//
// The CSV is the finder's own output (print_html=2) for one site and week; the committed one was fetched on
// 2026-11-15 for latitude 31.9583, longitude -111.5967 (Kitt Peak), 7 days from 2026-11-16 UTC, elevation above 30
// deg at ingress AND egress, Sun below -12 deg, depth at least 8 ppt, V at most 12.5, baseline 1 h:
//   https://astro.swarthmore.edu/transits/print_transits.cgi?single_object=0&observatory_string=Specified_Lat_Long&use_utc=1
//     &observatory_latitude=31.9583&observatory_longitude=-111.5967&timezone=UTC&start_date=11-16-2026&days_to_print=7&days_in_past=0
//     &minimum_start_elevation=30&and_vs_or=and&minimum_end_elevation=30&baseline_hrs=1&show_unc=1&minimum_depth=8&maximum_V_mag=12.5
//     &print_html=2&twilight=-12&max_airmass=2.4
//
// Two comparisons:
//   1 calculation   the finder lists the ephemeris it used for every event; with the SAME period, epoch, duration and
//                   coordinates, how far apart are the times, elevations, azimuths and the Moon?
//   2 end to end    which of its events does ESL's own catalogue (public/catalog-table/nea.json) also predict, and how
//                   different are the mid-times when each tool uses its own ephemeris?
import { readFileSync } from 'node:fs';
import * as O from '../src/core/observability.js';
import { loadSources, buildTable } from '../src/core/sources/index.js';

export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
    out.push(cur); rows.push(out);
  }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const sex = (s) => { const neg = /^\s*-/.test(s), p = s.replace(/^[+-]/, '').split(':').map(Number); return (neg ? -1 : 1) * (p[0] + p[1] / 60 + p[2] / 3600); };
export const SITE = { lat: 31.9583, lon: -111.5967, elev: 2096 };

/** The finder's events with ESL's numbers for the same ephemeris. */
export function compareCalculation(events) {
  return events.map((e) => {
    const [ras, decs] = e['coords(J2000)'].split(' '), ra = sex(ras) * 15, dec = sex(decs);
    const per = +e['period(days)'], t0 = +e['T_0(BJD_TDB)'], dur = (() => { const [h, m] = e['duration(hours)'].split(':').map(Number); return (h + m / 60) / 24; })();
    const jdMid = +e.jd_mid + 2450000, n = Math.round((jdMid - t0) / per), mid = O.bjdTdbToJdUtc(t0 + n * per, ra, dec);
    const at = (t) => O.altAz(ra, dec, t, SITE), a = [at(mid - dur / 2), at(mid), at(mid + dur / 2)];
    const moon = O.moonAltAz(mid, SITE), p = O.precess(ra, dec, mid);
    const wrap = (d) => ((d + 540) % 360) - 180;
    return { name: e.Name, dMid: (mid - jdMid) * 1440, dStart: (mid - dur / 2 - (+e.jd_start + 2450000)) * 1440, dEnd: (mid + dur / 2 - (+e.jd_end + 2450000)) * 1440,
      dEl: [a[0].alt - +e.el_start, a[1].alt - +e.el_mid, a[2].alt - +e.el_end], dAz: [wrap(a[0].az - +e.az_start), wrap(a[1].az - +e.az_mid), wrap(a[2].az - +e.az_end)], el: [+e.el_start, +e.el_mid, +e.el_end],
      dMoonPct: 100 * O.moonIllumination(mid).fraction - +e.moon_percent, dMoonDist: O.angularSeparation(p.ra, p.dec, moon.ra, moon.dec) - +e.moon_dist_deg,
      sigma: O.midTimeUncertainty(n, +e['T_0_unc'], +e['period_unc(days)']) * 1440, ra, dec, per, t0, dur, jdMid, V: +e.V, depth: +e['depth(ppt)'] };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || new URL('../test/swarthmore_reference.csv', import.meta.url);
  const ev = parseCsv(readFileSync(file, 'utf8')), C = compareCalculation(ev), mx = (a) => Math.max(...a.map(Math.abs));
  console.log(`${ev.length} events from the Swarthmore finder\n`);
  console.log('1  same ephemeris, ESL calculation minus Swarthmore');
  console.log(`   mid-time: worst ${mx(C.map((c) => c.dMid)).toFixed(2)} min (its JDs are printed to 0.001 d = 1.4 min); start ${mx(C.map((c) => c.dStart)).toFixed(2)} min, end ${mx(C.map((c) => c.dEnd)).toFixed(2)} min (durations printed to the minute)`);
  console.log(`   elevation: worst ${mx(C.flatMap((c) => c.dEl)).toFixed(2)} deg (printed to 1 deg); azimuth x cos(el): worst ${mx(C.flatMap((c) => c.dAz.map((d, i) => d * Math.cos(c.el[i] * Math.PI / 180)))).toFixed(2)} deg`);
  console.log(`   Moon: illumination worst ${mx(C.map((c) => c.dMoonPct)).toFixed(1)} points, distance worst ${mx(C.map((c) => c.dMoonDist)).toFixed(1)} deg (both printed as integers)`);
  for (const c of C.slice(0, 6)) console.log(`     ${c.name.padEnd(14)} dmid ${c.dMid.toFixed(2).padStart(6)} min  del ${c.dEl.map((d) => d.toFixed(2)).join(' ')}  daz ${c.dAz.map((d) => d.toFixed(2)).join(' ')}  moon ${c.dMoonPct.toFixed(1)}% ${c.dMoonDist.toFixed(1)} deg`);

  const root = new URL('../public/', import.meta.url);
  const L = await loadSources(async (f) => JSON.parse(readFileSync(new URL(f, root))), ['nea']);
  const T = buildTable(L), norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targets = T.rows.filter((r) => r.v.transit && r.v.per > 0 && r.v.t14 > 0 && r.v.depth >= 0.00795 && r.v.vmag < 12.55).map((r) => ({ name: r.name, ra: r.v.ra, dec: r.v.dec, per: r.v.per, tmid: r.v.tmid, perErr: r.e.per ? r.e.per[1] : 0, tmidErr: r.e.tmid ? r.e.tmid[1] : 0, t14: r.v.t14, ref: r.ref.per, V: r.v.vmag, depthPpt: +(1000 * r.v.depth).toFixed(2) }));
  // the finder's "7 days from 2026-11-16" are seven local nights; compare over the span of the events it returned.
  // Its V and depth limits act on rounded values (V to 0.1, depth to 0.1 ppt), hence the 12.55 and 7.95 above.
  const jd0 = Math.min(...C.map((c) => c.jdMid)) - 0.02, jd1 = Math.max(...C.map((c) => c.jdMid)) + 0.02;
  // the finder shows a transit when part of it is at night and the elevation limit holds at ingress AND egress: ask ESL for everything
  // (include: 'partial', no minimum coverage) with the finder's own limits, then class each event by ESL's definition
  const mine = O.findObservableTransits(targets, SITE, { jd0, jd1, minAlt: 30, sunLimit: -12, baseline: 1 / 24, include: 'partial', minCoverage: 0 });
  const key = (name, jd) => norm(name) + '@' + Math.round(jd * 2);
  const byName = new Map(); for (const m of mine) (byName.get(norm(m.target.name)) || byName.set(norm(m.target.name), []).get(norm(m.target.name))).push(m);
  let both = 0; const d = [], missing = [], notInCat = [];
  for (const c of C) {
    const cands = byName.get(norm(c.name)) || [], m = cands.find((x) => Math.abs(x.mid - c.jdMid) < 0.3);
    if (m) { both++; d.push({ name: c.name, dt: (m.mid - c.jdMid) * 1440, ref: m.target.ref, sig: m.sigma * 1440, full: m.full, ev: m }); }
    else if (!T.rows.some((r) => norm(r.name) === norm(c.name))) notInCat.push(c.name); else missing.push(c.name);
  }
  console.log(`\n2  each tool with its own catalogue: ${both} of ${C.length} Swarthmore events are also in ESL's list` + (notInCat.length ? `; not in ESL's catalogue under that name: ${notInCat.join(', ')}` : '') + (missing.length ? `; in the catalogue but not listed: ${missing.join(', ')}` : ''));
  d.sort((a, b) => Math.abs(b.dt) - Math.abs(a.dt));
  console.log(`   mid-time difference (different ephemerides): median ${d.map((x) => Math.abs(x.dt)).sort((a, b) => a - b)[d.length >> 1].toFixed(1)} min, worst ${Math.abs(d[0].dt).toFixed(1)} min`);
  for (const x of d.slice(0, 6)) console.log(`     ${x.name.padEnd(14)} ${x.dt.toFixed(1).padStart(7)} min   ESL uses ${x.ref}, sigma ${x.sig.toFixed(1)} min`);
  // ESL's definition: observable = the whole region of interest (1 h before ingress to 1 h after egress) dark and above 30 deg
  const klass = (list) => ({ roi: list.filter((e) => e.full).length, short: list.filter((e) => !e.full && e.transitFull).length, partial: list.filter((e) => !e.transitFull).length });
  const k12 = klass(d.map((x) => x.ev));
  console.log(`   ESL's classes of those ${d.length} with the finder's limits (Sun below -12 deg): ${k12.roi} observable over the whole region of interest (1 h each side), ${k12.short} complete transits with part of the baseline lost, ${k12.partial} partial transits`);
  const why = (e) => `${e.target.name} ${(100 * e.roiCoverage).toFixed(0)}% (${e.lost.map((l) => `${((l.end - l.start) * 1440).toFixed(0)} min ${l.why}`).join(', ')})`;
  console.log(`     not observable over the region of interest: ${d.map((x) => x.ev).filter((e) => !e.full).map(why).join('; ')}`);
  // and with ESL's default limits (Sun below -18 deg)
  const mine18 = O.findObservableTransits(targets, SITE, { jd0, jd1, minAlt: 30, sunLimit: -18, baseline: 1 / 24, include: 'partial', minCoverage: 0 });
  const in18 = C.map((c) => mine18.find((m) => norm(m.target.name) === norm(c.name) && Math.abs(m.mid - c.jdMid) < 0.3)).filter(Boolean), k18 = klass(in18);
  console.log(`   with ESL's defaults (Sun below -18 deg, astronomical night): ${in18.length} of the ${C.length} still have part of the transit in the dark; ${k18.roi} observable over the whole region of interest, ${k18.short} complete with a short baseline, ${k18.partial} partial`);
  const all12 = klass(mine), all18 = klass(mine18);
  console.log(`   ESL's own list for the same targets and nights: Sun -12: ${all12.roi} observable, ${all12.short} short baseline; Sun -18: ${all18.roi} observable, ${all18.short} short baseline (the previous definition, complete transit at -12, gave ${all12.roi + all12.short})`);
  const swEv = C.map((c) => [norm(c.name), c.jdMid]);
  const extra = mine.filter((m) => m.transitFull && !swEv.some(([n, t]) => n === norm(m.target.name) && Math.abs(t - m.mid) < 0.3));
  console.log(`   outside the finder's page: ESL finds ${mine.filter((m) => m.transitFull).length} transits that are entirely in the dark (-12 deg) above 30 deg from ingress to egress, ${extra.length} of them not on the finder's page: ${extra.slice(0, 12).map((m) => `${m.target.name} ${O.dateFromJd(m.mid).toISOString().slice(5, 16)} (V ${m.target.V}, ${m.target.depthPpt} ppt, ${(100 * m.coverage).toFixed(0)}% in the dark)`).join('; ')}`);
}
