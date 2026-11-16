// Observability calculations (src/core/observability.js) against astropy.
// Reference: test/observability_reference.json from test/make_observability_reference.py: 400 random combinations of
// six sites, dates from 2024 to 2031 and targets (ICRS -> AltAz with the full astropy chain, no refraction), the Sun
// and the topocentric Moon from astropy's built-in ephemeris, 36 nights of twilight times found by root finding on
// astropy's solar altitude, and 120 BJD_TDB conversions between 2005 and 2031.
// The tolerances below are the stated accuracy of the module; the measured worst cases are printed.
import { readFileSync } from 'node:fs';
import * as O from '../src/core/observability.js';
import { parseCsv, compareCalculation } from '../tools/compare_swarthmore.mjs';
import { subSolar } from '../src/plan/globe.js';
import { contrast, THEME } from '../src/plan/chart.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./observability_reference.json', import.meta.url)));
const st = (a) => ({ max: Math.max(...a.map(Math.abs)), rms: Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) });
const wrap = (d) => ((d + 540) % 360) - 180, cosd = (x) => Math.cos(x * Math.PI / 180);
const show = (s, unit, digits = 4) => `worst ${s.max.toFixed(digits)} ${unit}, rms ${s.rms.toFixed(digits)} ${unit}`;

const D = { alt: [], az: [], salt: [], saz: [], malt: [], maz: [], msep: [], mill: [], lmst: [], sra: [], sdec: [], mra: [], mdec: [], mdist: [] };
for (const p of ref.points) {
  const site = ref.sites[p.site];
  const a = O.altAz(p.ra, p.dec, p.jd, site); D.alt.push(a.alt - p.alt); D.az.push(wrap(a.az - p.az) * cosd(p.alt));
  const s = O.sunAltAz(p.jd, site); D.salt.push(s.alt - p.sun_alt); D.saz.push(wrap(s.az - p.sun_az) * cosd(p.sun_alt));
  const m = O.moonAltAz(p.jd, site); D.malt.push(m.alt - p.moon_alt); D.maz.push(wrap(m.az - p.moon_az) * cosd(p.moon_alt));
  const pd = O.precess(p.ra, p.dec, p.jd); D.msep.push(O.angularSeparation(pd.ra, pd.dec, m.ra, m.dec) - p.moon_sep);
  D.mill.push(O.moonIllumination(p.jd).fraction - p.moon_illum);
  D.lmst.push(wrap(O.lmst(p.jd, site.lon) - p.lmst) * 3600);
  const sp = O.sunPosition(p.jd), mp = O.moonPosition(p.jd);
  D.sra.push(wrap(sp.ra - p.sun_ra) * cosd(p.sun_dec) * 3600); D.sdec.push((sp.dec - p.sun_dec) * 3600);
  D.mra.push(wrap(mp.ra - p.moon_ra) * cosd(p.moon_dec) * 3600); D.mdec.push((mp.dec - p.moon_dec) * 3600); D.mdist.push(mp.dist - p.moon_dist);
}
const S = Object.fromEntries(Object.entries(D).map(([k, v]) => [k, st(v)]));
console.log(`info ${ref.points.length} positions, astropy ${ref.made_with.astropy}`);
check('target altitude within 0.015 deg', S.alt.max < 0.015, show(S.alt, 'deg'));
check('target azimuth (on the sky) within 0.015 deg', S.az.max < 0.015, show(S.az, 'deg'));
check('local mean sidereal time within 15 arcsec (1 s: UT1 - UTC is ignored)', S.lmst.max < 15, show(S.lmst, 'arcsec', 2));
check('Sun: apparent RA, Dec within 60 arcsec', S.sra.max < 60 && S.sdec.max < 60, `RA ${show(S.sra, 'arcsec', 1)}; Dec ${show(S.sdec, 'arcsec', 1)}`);
check('Sun: altitude and azimuth within 0.02 deg', S.salt.max < 0.02 && S.saz.max < 0.02, `alt ${show(S.salt, 'deg')}; az ${show(S.saz, 'deg')}`);
check('Moon: geocentric RA, Dec within 90 arcsec, distance within 150 km', S.mra.max < 90 && S.mdec.max < 90 && S.mdist.max < 150, `RA ${show(S.mra, 'arcsec', 1)}; Dec ${show(S.mdec, 'arcsec', 1)}; distance ${show(S.mdist, 'km', 0)}`);
check('Moon: topocentric altitude and azimuth within 0.03 deg', S.malt.max < 0.03 && S.maz.max < 0.03, `alt ${show(S.malt, 'deg')}; az ${show(S.maz, 'deg')}`);
check('Moon to target separation within 0.04 deg', S.msep.max < 0.04, show(S.msep, 'deg'));
check('Moon illuminated fraction within 0.001', S.mill.max < 0.001, show(S.mill, '', 5));

// --- twilight
{
  const d = []; let mismatch = 0, n = 0, polar = 0;
  for (const night of ref.twilight) {
    const t = O.twilight(night.noon, ref.sites[night.site]);
    for (const k of ['sun', 'civil', 'nautical', 'astronomical']) [t[k].evening, t[k].morning].forEach((x, i) => { const r = night[k][i]; n++; if ((x == null) !== (r == null)) mismatch++; else if (x == null) polar++; else d.push((x - r) * 86400); });
  }
  const s = st(d);
  check('sunset, sunrise and the three twilights within 20 s of astropy', s.max < 20 && mismatch === 0, `${d.length} crossings on ${ref.twilight.length} nights: ${show(s, 's', 1)}; ${polar} absent in both (polar day or night), ${mismatch} disagreements about whether a crossing exists`);
  // darkIntervals is the same crossings arranged as intervals
  const night = ref.twilight.find((x) => x.nautical[0] && x.nautical[1]), site = ref.sites[night.site], iv = O.darkIntervals(night.noon, night.noon + 1, site, -12);
  check('darkIntervals returns the night between nautical dusk and dawn', iv.length === 1 && Math.abs(iv[0][0] - night.nautical[0]) * 86400 < 20 && Math.abs(iv[0][1] - night.nautical[1]) * 86400 < 20, `${((iv[0][1] - iv[0][0]) * 24).toFixed(2)} h at ${site.name}`);
  check('noonBefore', Math.abs(O.noonBefore(night.noon + 0.3, site.lon) - night.noon) < 1e-9 && Math.abs(O.noonBefore(night.noon, site.lon) - night.noon) < 1e-9);
}

// --- barycentric time
{
  const d = ref.bjd.map((b) => (O.jdUtcToBjdTdb(b.jd, b.ra, b.dec) - b.jd) * 86400 - b.bjd_minus_jd_s), tt = ref.bjd.map((b) => O.ttMinusUtc(b.jd) - b.tt_minus_utc);
  const rt = ref.bjd.map((b) => (O.bjdTdbToJdUtc(O.jdUtcToBjdTdb(b.jd, b.ra, b.dec), b.ra, b.dec) - b.jd) * 86400);
  const span = st(ref.bjd.map((b) => b.bjd_minus_jd_s - b.tt_minus_utc));
  check('TT - UTC from the leap-second table, 2005 to 2031', st(tt).max < 1e-6, `values ${[...new Set(ref.bjd.map((b) => b.tt_minus_utc.toFixed(3)))].sort().join(', ')} s`);
  check('BJD_TDB - JD_UTC within 6 s of astropy', st(d).max < 6, `${show(st(d), 's', 2)} (the correction itself reaches ${span.max.toFixed(0)} s; the residual is the Sun's offset from the barycentre)`);
  check('BJD -> UTC inverts UTC -> BJD', st(rt).max < 1e-3, `${st(rt).max.toExponential(1)} s`);
}

// --- the globe of the Plan page: the sub-solar point and the day/night shading it draws from it
{
  // the shading takes the Sun's altitude at a place as asin(place . sub-solar point); compare with astropy's solar altitude at the reference sites
  const DEG = Math.PI / 180, unit = (lat, lon) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];
  const d = ref.points.map((p) => { const s = subSolar(p.jd), a = unit(ref.sites[p.site].lat, ref.sites[p.site].lon), b = unit(s.lat, s.lon); return Math.asin(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / DEG - p.sun_alt; });
  const over = ref.points.slice(0, 40).map((p) => { const s = subSolar(p.jd); return 90 - O.sunAltAz(p.jd, { lat: s.lat, lon: s.lon }).alt; });
  check('globe: Sun altitude from the sub-solar point within 0.2 deg of astropy (geocentric against geodetic latitude)', st(d).max < 0.2, `${d.length} places and times: ${show(st(d), 'deg', 3)}; the Sun is within ${Math.max(...over).toFixed(3)} deg of the zenith at the sub-solar point`);
  const pairs = [['text', THEME.text, THEME.panel], ['dim', THEME.dim, THEME.panel], ['target', THEME.target, THEME.sky[4]], ['warn', THEME.warn, THEME.sky[4]], ['moon', THEME.moon, THEME.sky[4]], ['twilight', THEME.twi, THEME.panel], ['ok', THEME.ok, THEME.panel]];
  check('chart text colours reach WCAG AA (4.5:1) on the background they are drawn on', pairs.every(([, a, b]) => contrast(a, b) >= 4.5) && Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-9 && Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.01,
    pairs.map(([n, a, b]) => `${n} ${contrast(a, b).toFixed(1)}`).join(', ') + '; the old label colour #55607a was ' + contrast('#55607a', '#0b0f18').toFixed(1));
}

// --- air mass
check('air mass', Math.abs(O.secz(30) - 2) < 1e-12 && Math.abs(O.airmass(90) - 1) < 1e-3 && Math.abs(O.airmass(30) - 1.995) < 2e-3 && Math.abs(O.airmass(0) - 38) < 0.5 && Number.isNaN(O.airmass(-1)) && O.secz(-1) === Infinity,
  `Kasten & Young: ${O.airmass(90).toFixed(4)} at the zenith, ${O.airmass(30).toFixed(4)} at 30 deg, ${O.airmass(0).toFixed(1)} at the horizon`);
check('refraction', Math.abs(O.refraction(0) * 60 - 28.7) < 1 && O.refraction(90) < 0.001 && Math.abs(O.refraction(45) * 60 - 1.0) < 0.05, `${(O.refraction(0) * 60).toFixed(1)}' at the horizon, ${(O.refraction(45) * 60).toFixed(2)}' at 45 deg`);

// --- geometry helpers
check('angular separation', Math.abs(O.angularSeparation(10, 0, 100, 0) - 90) < 1e-12 && Math.abs(O.angularSeparation(0, 89, 180, 89) - 2) < 1e-9 && O.angularSeparation(33, -20, 33, -20) === 0 && Math.abs(O.angularSeparation(0, 0, 180, 0) - 180) < 1e-9);
check('intersectIntervals', JSON.stringify(O.intersectIntervals([[0, 2], [3, 6]], [[1, 4], [5, 9]])) === '[[1,2],[3,4],[5,6]]' && O.intersectIntervals([[0, 1]], [[1, 2]]).length === 0 && O.intersectIntervals([], [[0, 1]]).length === 0);

// --- upIntervals (analytic) against sampling altAz
{
  const site = ref.sites[1], jd0 = 2461000.5; let worst = 0, n = 0;
  for (const [ra, dec, minAlt] of [[83, -5, 30], [250, -60, 20], [10, 41, 25], [180, -24.6, 80], [300, 10, 0]]) {
    const iv = O.upIntervals(ra, dec, jd0, jd0 + 3, site, minAlt), step = 0.5 / 1440;
    const edges = []; let prev = O.altAz(ra, dec, jd0, site).alt > minAlt;
    for (let t = jd0 + step; t <= jd0 + 3; t += step) { const up = O.altAz(ra, dec, t, site).alt > minAlt; if (up !== prev) edges.push(t - step / 2); prev = up; }
    const mine = iv.flat().filter((t) => t > jd0 + 1e-9 && t < jd0 + 3 - 1e-9);
    if (mine.length !== edges.length) { worst = Infinity; break; }
    mine.forEach((t, i) => { worst = Math.max(worst, Math.abs(t - edges[i]) * 86400); n++; });
  }
  check('upIntervals edges match sampled altitudes', worst < 40, `${n} rise/set times over 3 days, worst ${worst.toFixed(0)} s (sampling step 30 s)`);
  check('upIntervals: never and always', O.upIntervals(0, 80, jd0, jd0 + 1, site, 10).length === 0 && JSON.stringify(O.upIntervals(0, -85, jd0, jd0 + 1, site, 10)) === JSON.stringify([[jd0, jd0 + 1]]));
}

// --- transits
{
  const eph = { per: 2.5, tmid: 2455000.25, perErr: 2e-6, tmidErr: 3e-4 };
  const tr = O.transitsBetween(eph, 2461000, 2461006);
  check('transitsBetween lists every mid-time in the window', tr.length === 3 && tr[0].epoch === 2400 && tr[0].tmid === 2455000.25 + 2400 * 2.5 && tr[2].tmid === 2461005.25, tr.map((t) => t.tmid).join(', '));
  check('mid-time uncertainty = sqrt(sigma_T0^2 + (n sigma_P)^2)', Math.abs(tr[0].sigma - Math.hypot(3e-4, 2400 * 2e-6)) < 1e-15 && O.midTimeUncertainty(0, 3e-4, 2e-6) === 3e-4 && O.midTimeUncertainty(-100, 0, 1e-5) === 1e-3,
    `${(tr[0].sigma * 1440).toFixed(1)} min after ${tr[0].epoch} orbits`);
  check('transitsBetween: bad ephemeris gives nothing', O.transitsBetween({ per: 0, tmid: 1 }, 0, 10).length === 0 && O.transitsBetween({ per: 1, tmid: NaN }, 0, 10).length === 0);
  // observable from 10 to 20; transit 12 to 14: full, 2 before, 6 after
  let a = O.assessTransit(12, 14, [[0, 5], [10, 20]]);
  check('assessTransit: full transit with baseline', a.coverage === 1 && a.ingress && a.egress && a.before === 2 && a.after === 6 && a.start === 10 && a.end === 20);
  a = O.assessTransit(8, 12, [[0, 5], [10, 20]]);
  check('assessTransit: egress only', a.coverage === 0.5 && !a.ingress && a.egress && a.before === 0 && a.after === 8);
  a = O.assessTransit(18, 23, [[10, 20], [22, 30]]);
  check('assessTransit: interrupted', Math.abs(a.coverage - 0.6) < 1e-12 && a.ingress && a.egress && a.before === 8 && a.after === 7);
  a = O.assessTransit(6, 8, [[0, 5], [10, 20]]);
  check('assessTransit: not observable', a.coverage === 0 && !a.ingress && !a.egress && a.start === null);
}

// --- interval helpers of the region of interest
{
  check('subtractIntervals', JSON.stringify(O.subtractIntervals([[0, 10]], [[2, 3], [5, 7]])) === '[[0,2],[3,5],[7,10]]' && JSON.stringify(O.subtractIntervals([[0, 4], [6, 9]], [[3, 7]])) === '[[0,3],[7,9]]' &&
    O.subtractIntervals([[1, 2]], [[0, 5]]).length === 0 && JSON.stringify(O.subtractIntervals([[1, 2]], [])) === '[[1,2]]');
  // region 10 to 20; dark 12 to 30; up 0 to 18: twilight takes 10-12, altitude takes 18-20, 6 of 10 observable
  const r = O.assessRegion(10, 20, [[12, 30]], [[0, 18]]);
  check('assessRegion: fraction and what is lost to twilight and to altitude', Math.abs(r.fraction - 0.6) < 1e-12 && r.lost.length === 2 && r.lost[0].why === 'twilight' && r.lost[0].start === 10 && r.lost[0].end === 12 &&
    r.lost[1].why === 'altitude' && r.lost[1].start === 18 && r.lost[1].end === 20 && r.lostTwilight === 2 && r.lostAltitude === 2, JSON.stringify(r.lost));
  const q = O.assessRegion(10, 20, [[0, 30]], [[0, 30]]), z = O.assessRegion(10, 20, [[0, 5]], [[0, 30]]);
  check('assessRegion: all and nothing', q.fraction === 1 && q.lost.length === 0 && z.fraction === 0 && z.lostTwilight === 10 && z.lostAltitude === 0);
  // not dark AND too low counts as twilight (the Sun decides first)
  const w = O.assessRegion(0, 10, [[4, 10]], [[6, 10]]);
  check('assessRegion: daylight is reported as twilight whatever the altitude', w.lostTwilight === 4 && w.lostAltitude === 2 && Math.abs(w.fraction - 0.4) < 1e-12);
}

// --- the planner. "Observable" is judged on the region of interest: baseline before ingress to baseline after egress.
// Every returned transit is checked by brute force with altAz / sunAltAz.
{
  const site = ref.sites[0], jd0 = 2461360.5, jd1 = jd0 + 5, rnd = (() => { let x = 12345; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const targets = Array.from({ length: 300 }, (_, i) => ({ name: 'T' + i, ra: 360 * rnd(), dec: -60 + 140 * rnd(), per: 0.8 + 6 * rnd(), tmid: 2459000 + 10 * rnd(), perErr: 1e-6, tmidErr: 2e-4, t14: (1 + 3 * rnd()) / 24 }));
  const B = 1 / 24, opts = { jd0, jd1, minAlt: 30, sunLimit: -18, baseline: B };
  const full = O.findObservableTransits(targets, site, opts), tran = O.findObservableTransits(targets, site, { ...opts, include: 'transit' }), part = O.findObservableTransits(targets, site, { ...opts, include: 'partial' });
  const altOk = (ev, t, tol = 0.02) => O.altAz(ev.target.ra, ev.target.dec, t, site).alt >= 30 - tol, sunOk = (t, tol = 0.02) => O.sunAltAz(t, site).alt <= -18 + tol;
  const okAt = (ev, t) => altOk(ev, t) && sunOk(t);
  let bad = 0, badBase = 0;
  for (const ev of full) {
    for (let k = 0; k <= 30; k++) if (!okAt(ev, ev.roiStart + (ev.roiEnd - ev.roiStart) * k / 30)) bad++;
    // the reported baseline is observable, and one minute beyond it is not (unless it runs to the edge of the search window)
    if (ev.before > 2 / 1440 && !okAt(ev, ev.ingress - ev.before + 1 / 1440)) badBase++;
    if (ev.after > 2 / 1440 && !okAt(ev, ev.egress + ev.after - 1 / 1440)) badBase++;
    if (ev.before < 0.45 && okAt(ev, ev.ingress - ev.before - 1.5 / 1440)) badBase++;
  }
  check('planner: an "observable" transit is dark and above the limit over its whole region of interest (1 h before ingress to 1 h after egress)', full.length > 10 && bad === 0 &&
    full.every((e) => e.full && e.roiCoverage === 1 && e.lost.length === 0 && Math.abs(e.roiStart - (e.ingress - B)) < 1e-12 && Math.abs(e.roiEnd - (e.egress + B)) < 1e-12 && e.before >= B - 1e-6 && e.after >= B - 1e-6),
    `${full.length} observable transits of 300 targets in 5 nights at ${site.name}; ${bad} violations in ${full.length * 31} samples`);
  check('planner: the reported baseline is what is observable', badBase === 0, `${badBase} mismatches`);
  // brute force count: all transits in the window whose region of interest satisfies the limits at 121 points
  let brute = 0, bruteTransit = 0;
  for (const tg of targets) for (const tr of O.transitsBetween(tg, jd0 - 0.01, jd1 + 0.01)) {
    const mid = O.bjdTdbToJdUtc(tr.tmid, tg.ra, tg.dec); if (mid < jd0 || mid > jd1) continue;
    const all = (t0, t1) => { for (let k = 0; k <= 120; k++) { const t = t0 + (t1 - t0) * k / 120; if (!(O.altAz(tg.ra, tg.dec, t, site).alt >= 30 && O.sunAltAz(t, site).alt <= -18)) return false; } return true; };
    if (all(mid - tg.t14 / 2 - B, mid + tg.t14 / 2 + B)) brute++;
    if (all(mid - tg.t14 / 2, mid + tg.t14 / 2)) bruteTransit++;
  }
  check('planner: finds the same observable transits as a brute-force search of the region of interest', Math.abs(brute - full.length) <= 1, `${full.length} vs ${brute} (a region ending within seconds of a limit can fall either side)`);
  check('planner: include "transit" adds the transits that are complete but lack baseline', Math.abs(bruteTransit - tran.length) <= 1 && tran.length > full.length && tran.filter((e) => e.full).length === full.length &&
    tran.every((e) => e.transitFull && e.coverage > 0.999) && tran.filter((e) => !e.full).every((e) => e.roiCoverage < 1 && e.lost.length > 0 && (e.before < B || e.after < B)),
    `${tran.length} complete transits (brute force ${bruteTransit}), ${tran.length - full.length} of them with part of the region of interest lost`);
  // what is lost and why, by brute force: the Sun is up in every 'twilight' piece, the target is low (and it is dark) in every 'altitude' piece,
  // the pieces lie inside the region, and observable + lost = the region
  let badWhy = 0, badSum = 0, nl = 0, nTw = 0, nAlt = 0;
  for (const ev of part) {
    let lost = 0;
    for (const l of ev.lost) {
      nl++; lost += l.end - l.start; l.why === 'twilight' ? nTw++ : nAlt++;
      if (l.start < ev.roiStart - 1e-9 || l.end > ev.roiEnd + 1e-9 || !(l.end > l.start)) badWhy++;
      for (const f of [0.1, 0.5, 0.9]) {
        const t = l.start + (l.end - l.start) * f;
        if (l.why === 'twilight' ? sunOk(t, -0.02) : !(sunOk(t) && !altOk(ev, t, -0.02))) badWhy++;
      }
    }
    if (Math.abs(lost - (ev.lostTwilight + ev.lostAltitude)) > 1e-9 || Math.abs(ev.roiCoverage - (1 - lost / (ev.roiEnd - ev.roiStart))) > 1e-6) badSum++;
    // the fraction itself against sampling every 30 s
    let n = 0, okn = 0; for (let t = ev.roiStart; t <= ev.roiEnd; t += 0.5 / 1440) { n++; if (okAt(ev, t)) okn++; }
    if (Math.abs(okn / n - ev.roiCoverage) > 0.012) badSum++;
  }
  check('planner: the lost parts of the region of interest carry the right reason and add up', nl > 20 && nTw > 0 && nAlt > 0 && badWhy === 0 && badSum === 0, `${nl} lost pieces in ${part.length} transits: ${nTw} to twilight, ${nAlt} to altitude; ${badWhy} wrong reasons, ${badSum} wrong sums`);
  const onlyPart = part.filter((e) => !e.transitFull);
  check('planner: partial transits are extra, have a contact observable and at least 25% coverage', part.length > tran.length && part.filter((e) => e.transitFull).length === tran.length && onlyPart.every((e) => !e.full && (e.ingressObs || e.egressObs) && e.coverage >= 0.25 && e.coverage < 1) &&
    O.findObservableTransits(targets, site, { ...opts, partial: true }).length === part.length, `${onlyPart.length} partial`);
  check('planner: sorted by time, uncertainty propagated, UTC differs from BJD by the light time', full.every((e, i) => i === 0 || e.mid >= full[i - 1].mid) && full.every((e) => Math.abs(e.sigma - Math.hypot(2e-4, e.epoch * 1e-6)) < 1e-12 && Math.abs(e.mid - e.bjd) < 0.0065 && Math.abs((e.bjd - e.mid) * 86400 - 69.184) < 500));
  const sc = tran.map((e) => e.score), best = full.reduce((a, b) => (b.score.total > a.score.total ? b : a));
  check('score: parts add up, stay in range, and a full transit with baseline high in a moonless sky gets top marks', sc.every((s) => Math.abs(s.total - (s.coverage + s.baseline + s.altitude + s.moon)) < 1e-9 && s.total >= 50 && s.total <= 100) && full.every((e) => e.score.baseline === 20) &&
    Math.abs(O.scoreTransit({ coverage: 1, before: 0.1, after: 0.1, ingressObs: true, egressObs: true, altIngress: 70, altMid: 80, altEgress: 65, moon: { alt: -5, sep: 10, illum: 1 } }).total - 100) < 1e-9 &&
    Math.abs(O.scoreTransit({ coverage: 0.5, before: 0, after: 1, ingressObs: false, egressObs: true, altIngress: 10, altMid: 30, altEgress: 45, moon: { alt: 20, sep: 20, illum: 0.5 } }).total - (25 + 10 + 0 + 7.5)) < 1e-9,
    `best of the run: ${best.target.name} ${best.score.total.toFixed(0)}`);
  check('planner: a target that never rises high enough is skipped', O.findObservableTransits([{ ra: 10, dec: -85, per: 1, tmid: 2459000, t14: 0.1 }], site, opts).length === 0);
  check('planner: with no baseline wanted the region of interest is the transit', O.findObservableTransits(targets, site, { ...opts, baseline: 0 }).length === O.findObservableTransits(targets, site, { ...opts, baseline: 0, include: 'transit' }).length);
}

// --- secondary eclipses and phase windows. Reference: test/eclipse_reference.json from test/make_eclipse_reference.py:
// 240 random orbits (e up to 0.9), mid-eclipse from batman's get_t_secondary, transit and eclipse durations from a
// brute-force contact search on a scipy Kepler solve.
{
  const E = JSON.parse(readFileSync(new URL('./eclipse_reference.json', import.meta.url)));
  const dOff = E.cases.map((c) => (O.eclipsePhase(c.ecc, c.omega) * c.per - c.offset) * 86400);
  const s = st(dOff), ecc = E.cases.filter((c) => c.ecc > 0).length;
  check('eclipse: time from transit to eclipse matches batman get_t_secondary', s.max < 0.01, `${E.cases.length} orbits (${ecc} eccentric, e up to ${Math.max(...E.cases.map((c) => c.ecc)).toFixed(2)}): ${show(s, 's', 5)}; batman ${E.made_with.batman}`);
  const rat = E.cases.map((c) => O.eclipseDurationRatio(c) * c.t14 / c.e14 - 1), lowE = E.cases.filter((c) => c.ecc <= 0.3).map((c) => O.eclipseDurationRatio(c) * c.t14 / c.e14 - 1);
  const rs = st(rat), rl = st(lowE);
  check('eclipse: duration from the transit duration (Winn 2010 eqs. 14, 16) against brute-force contacts: 0.5% for e <= 0.3, 10% up to e = 0.9', rl.max < 0.005 && rs.max < 0.10, `e <= 0.3 (${lowE.length}): worst ${(100 * rl.max).toFixed(2)}%, rms ${(100 * rl.rms).toFixed(3)}%; all: worst ${(100 * rs.max).toFixed(2)}%, rms ${(100 * rs.rms).toFixed(2)}%`);
  const circ = E.cases.filter((c) => c.ecc === 0);
  check('eclipse: circular orbits at phase 0.5 with the transit duration', circ.length > 20 && circ.every((c) => O.eclipsePhase(0, c.omega) === 0.5 && Math.abs(c.offset - c.per / 2) < 1e-6 && Math.abs(c.e14 / c.t14 - 1) < 1e-6 && O.eclipseDurationRatio(c) === 1), `${circ.length} circular orbits`);
  // light time across the orbit: 2a/c for a circular edge-on orbit (a = 0.0225 au: 22.4 s)
  const lt = O.eclipseLightDelay(0.0225) * 86400;
  check('eclipse: light-travel delay 2a/c', Math.abs(lt - 2 * 0.0225 * 149597870.7 / 299792.458) < 1e-6, `${lt.toFixed(2)} s for a = 0.0225 au`);
  // timing uncertainty against a Monte Carlo draw of T0, P, e, omega (uncorrelated normal errors)
  const tg = { per: 5.6334729, tmid: 2455288.84923, perErr: 6.1e-6, tmidErr: 3.8e-4, t14: 0.1787, ecc: 0.5172, eccErr: 0.0019, omega: 188.01, omegaErr: 0.2 };
  const g = O.eventGeometry(tg, 'eclipse'), n = 800, gauss = (() => { let x = 7; const u = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); })();
  const draws = Array.from({ length: 20000 }, () => { const P = tg.per + gauss() * tg.perErr; return tg.tmid + gauss() * tg.tmidErr + (n + O.eclipsePhase(tg.ecc + gauss() * tg.eccErr, tg.omega + gauss() * tg.omegaErr)) * P; });
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length, sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / (draws.length - 1));
  check('eclipse: timing uncertainty from T0, P, e and omega matches a Monte Carlo draw', Math.abs(g.sigma(n) / sd - 1) < 0.03, `HAT-P-2 b-like orbit, ${n} orbits on: ${(g.sigma(n) * 1440).toFixed(2)} min vs ${(sd * 1440).toFixed(2)} min (20000 draws); eclipse at phase ${g.phase.toFixed(4)}`);
  const noE = O.eventGeometry({ ...tg, ecc: NaN, omega: NaN }, 'eclipse');
  check('eclipse: no catalogued eccentricity means circular, and says so', noE.phase === 0.5 && /circular/.test(noE.assumed) && noE.before === tg.t14 / 2);
  check('phase windows: span around the eclipse, a period limit, custom phases wrap through the transit',
    O.eventGeometry({ ...tg, per: 1.2 }, 'phase', { span: 0.5, maxPer: 2 }).before === 0.3 && O.eventGeometry(tg, 'phase', { maxPer: 2 }) === null &&
    Math.abs(O.eventGeometry({ per: 2, tmid: 0, t14: 0.1 }, 'custom', { from: 0.9, to: 0.1 }).phase - 1) < 1e-12 && Math.abs(O.eventGeometry({ per: 2, tmid: 0, t14: 0.1 }, 'custom', { from: 0.9, to: 0.1 }).before - 0.2) < 1e-12);
  // the planner with eclipses: every eclipse it calls observable is, by brute force, and its centre is T0 + (n + phase) P
  const site = ref.sites[0], jd0 = 2461360.5, jd1 = jd0 + 5, rnd = (() => { let x = 999; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const targets = Array.from({ length: 300 }, (_, i) => ({ name: 'E' + i, ra: 360 * rnd(), dec: -60 + 140 * rnd(), per: 0.8 + 6 * rnd(), tmid: 2459000 + 10 * rnd(), perErr: 1e-6, tmidErr: 2e-4, t14: (1 + 3 * rnd()) / 24, ecc: i % 3 ? 0 : 0.4 * rnd(), omega: 360 * rnd() }));
  const opts = { jd0, jd1, minAlt: 30, sunLimit: -18, baseline: 1 / 24, kinds: ['transit', 'eclipse'] };
  const evs = O.findObservableEvents(targets, site, opts), ecl = evs.filter((e) => e.kind === 'eclipse');
  let bad = 0;
  for (const ev of ecl) for (let k = 0; k <= 30; k++) { const t = ev.roiStart + (ev.roiEnd - ev.roiStart) * k / 30; if (!(O.altAz(ev.target.ra, ev.target.dec, t, site).alt >= 29.98 && O.sunAltAz(t, site).alt <= -17.98)) bad++; }
  const badT = ecl.filter((e) => Math.abs(e.bjd - (e.target.tmid + (e.epoch + O.eclipsePhase(e.target.ecc, e.target.omega)) * e.target.per)) > 1e-9).length;
  const tr = O.findObservableTransits(targets, site, opts);
  check('planner: eclipses and transits together; observable eclipses are dark and high over their region of interest', ecl.length > 5 && bad === 0 && badT === 0 && evs.filter((e) => e.kind === 'transit').length === tr.length && evs.every((e, i) => i === 0 || e.mid >= evs[i - 1].mid),
    `${ecl.length} observable eclipses and ${tr.length} transits of 300 targets in 5 nights; ${bad} violations, ${badT} wrong centres`);
  const pad = O.findObservableEvents(targets, site, { ...opts, padSigma: true });
  check('planner: padding by the timing uncertainty widens the region of interest by 1 sigma each side', pad.length <= evs.length && pad.every((e) => Math.abs(e.roiStart - (e.ingress - 1 / 24 - e.sigma)) < 1e-12 && e.pad === e.sigma));
  const ph = O.findObservableEvents(targets, site, { ...opts, kinds: ['phase'], phase: { span: 0.25, maxPer: 1.5 }, include: 'partial' });
  check('planner: phase windows have no baseline and are as long as asked', ph.length > 0 && ph.every((e) => e.roiStart === e.ingress && Math.abs(e.egress - e.ingress - 0.25 * e.target.per) < 1e-9 && e.target.per <= 1.5), `${ph.length} quarter-orbit windows (partial included)`);
}

// --- the Swarthmore transit finder: its own output for Kitt Peak, 2026-11-16 + 7 nights (tools/compare_swarthmore.mjs
// says how it was fetched), recomputed here from the ephemerides it lists. It prints JD to 0.001 d and angles to 1 deg.
{
  const C = compareCalculation(parseCsv(readFileSync(new URL('./swarthmore_reference.csv', import.meta.url), 'utf8'))), mx = (a) => Math.max(...a.map(Math.abs));
  const dm = mx(C.map((c) => c.dMid)), de = mx(C.flatMap((c) => c.dEl)), da = mx(C.flatMap((c) => c.dAz.map((d, i) => d * cosd(c.el[i])))), dp = mx(C.map((c) => c.dMoonPct)), dd = mx(C.map((c) => c.dMoonDist));
  check('Swarthmore finder, same ephemerides: mid-times within its 0.001 d rounding', C.length >= 30 && dm < 0.75, `${C.length} events, worst ${dm.toFixed(2)} min`);
  check('... elevations and azimuths within its 1 deg rounding', de < 0.55 && da < 0.55, `elevation worst ${de.toFixed(2)} deg, azimuth worst ${da.toFixed(2)} deg on the sky`);
  check('... Moon illumination within 2 points and distance within 1 deg', dp < 2 && dd < 1, `illumination worst ${dp.toFixed(1)} points, distance worst ${dd.toFixed(1)} deg`);
}

// --- a terrain horizon: the up intervals against brute force every 5 s (altAz + refraction against the skyline)
{
  const site = { lat: 31.96333, lon: -111.6, elev: 2120 }, jd0 = 2461360.5, jd1 = jd0 + 1.2;
  // a skyline with a 25-degree wall from azimuth 60 to 120 and a 12-degree hill around 250, flat elsewhere at 2 degrees
  const hz = (az) => (az >= 60 && az <= 120 ? 25 : 2 + 10 * Math.max(0, 1 - Math.abs(az - 250) / 15)); hz.max = 25;
  let worst = 0, nEdges = 0, nStars = 0, same = true;
  for (const [ra, dec] of [[10, 5], [80, 20], [150, -10], [220, 40], [300, 0], [30, 60], [120, -30]]) {
    for (const minAlt of [0, 10, 30]) {
      const got = O.upIntervalsHorizon(ra, dec, jd0, jd1, site, minAlt, hz); nStars++;
      // brute force
      const want = []; let st = null;
      for (let t = jd0; t <= jd1 + 1e-9; t += 5 / 86400) { const h = O.altAz(ra, dec, t, site), up = h.alt >= minAlt && h.alt + O.refraction(h.alt) > hz(h.az); if (up && st == null) st = t; if (!up && st != null) { want.push([st, t]); st = null; } }
      if (st != null) want.push([st, jd1]);
      if (got.length !== want.length) { same = false; continue; }
      for (let i = 0; i < got.length; i++) { worst = Math.max(worst, Math.abs(got[i][0] - want[i][0]), Math.abs(got[i][1] - want[i][1])); nEdges += 2; }
    }
  }
  check('terrain horizon: up intervals = brute force every 5 s', same && worst * 86400 < 6, `${nStars} star and limit pairs, ${nEdges} edges, worst ${(worst * 86400).toFixed(1)} s`);
  const flat = (az) => -1; flat.max = -1;
  check('a skyline below the altitude limit changes nothing', JSON.stringify(O.upIntervalsHorizon(80, 20, jd0, jd1, site, 30, flat)) === JSON.stringify(O.upIntervals(80, 20, jd0, jd1, site, 30)));
  // in the planner: a transit hidden by the wall is lost to "altitude"
  const tg = { name: 'test', ra: 80, dec: 20, per: 1.3, tmid: 2461360.9, t14: 0.1, perErr: 0, tmidErr: 0 };
  const a = O.findObservableEvents([tg], site, { jd0, jd1: jd0 + 8, minAlt: 10, sunLimit: 90, baseline: 0, include: 'partial', minCoverage: 0 }), b = O.findObservableEvents([tg], site, { jd0, jd1: jd0 + 8, minAlt: 10, sunLimit: 90, baseline: 0, include: 'partial', minCoverage: 0, horizon: hz });
  check('findObservableEvents with a horizon: never more observable than without', a.length >= b.length && b.every((e) => { const f = a.find((x) => x.epoch === e.epoch); return f && e.coverage <= f.coverage + 1e-9; }), `${a.length} transits without the terrain, ${b.length} with it`);
}
process.exit(ok ? 0 : 1);
