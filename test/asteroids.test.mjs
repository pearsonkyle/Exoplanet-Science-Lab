// The asteroid ephemeris of the Observe page (src/core/asteroids.js): bundled SBDB elements propagated as two-body
// orbits, against JPL Horizons (full n-body integration) geocentric astrometric RA, Dec and visual magnitude at five
// dates from 200 days before the epoch of the elements to a year after (test/asteroid_reference.json, written by
// test/make_asteroid_reference.py). Also: the bundled elements are the reference's, Kepler's third law holds for
// them, and the H, G magnitude at zero phase is H + 5 log10(r delta).
import { readFileSync } from 'node:fs';
import * as AST from '../src/core/asteroids.js';
import * as A from '../src/core/astro.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./asteroid_reference.json', import.meta.url)));
const { RAD, DEG } = A;

{
  const same = ref.objects.every((r) => { const o = AST.asteroidById(r.name); return o && ['a', 'e', 'i', 'node', 'peri', 'M', 'n', 'H', 'G'].every((k) => o[k] === r[k]) && o.epoch === r.epoch_tdb; });
  check('bundled elements are the SBDB values of the reference', same, `${ref.objects.length} asteroids, reference made ${ref.made}`);
  const dn = Math.max(...AST.ASTEROIDS.map((o) => Math.abs(AST.keplerMeanMotion(o.a) / o.n - 1)));
  check('mean motion follows from a (Kepler III, GM of the Sun)', dn < 1e-6, `largest relative difference ${dn.toExponential(1)}`);
  const m0 = AST.hgMagnitude(3.34, 0.12, 2.5, 1.6, 0), want = 3.34 + 5 * Math.log10(2.5 * 1.6);
  check('H, G magnitude at zero phase', Math.abs(m0 - want) < 1e-12, `${m0.toFixed(4)}`);
}
// against Horizons: separation in arcsec, by time from the epoch
let worstNear = 0, worstFar = 0, worstMag = 0, worstDelta = 0; const lines = [];
for (const r of ref.objects) {
  const o = AST.asteroidById(r.name), seps = [];
  for (const e of r.ephem) {
    const ms = A.fromJulianDate(e.jd_ut), g = AST.asteroidGeocentric(o, ms);
    const sep = A.separation(g.ra, g.dec, e.ra * RAD, e.dec * RAD) * DEG * 3600, days = Math.abs(e.jd_ut - o.epoch);
    if (days <= 200) worstNear = Math.max(worstNear, sep); else worstFar = Math.max(worstFar, sep);
    worstMag = Math.max(worstMag, Math.abs(g.mag - e.vmag)); worstDelta = Math.max(worstDelta, Math.abs(g.delta - e.delta) / e.delta);
    seps.push(sep.toFixed(0));
  }
  lines.push(`${r.name} ${seps.join('/')}"`);
}
console.log('     separations from Horizons at ' + ref.objects[0].ephem.map((e) => (e.jd_ut - ref.objects[0].epoch_tdb).toFixed(0) + ' d').join(', ') + ' from the epoch:');
console.log('     ' + lines.join(' · '));
check('RA, Dec within 200 days of the epoch', worstNear < 90, `largest ${worstNear.toFixed(1)}" (limit 90": Hygiea, nearest Jupiter's perturbations, is the worst)`);
check('RA, Dec 220 to 365 days from the epoch', worstFar < 240, `largest ${worstFar.toFixed(1)}" (limit 240")`);
check('geocentric distance', worstDelta < 2e-3, `largest relative difference ${worstDelta.toExponential(1)}`);
check('visual magnitude (H, G) against Horizons APmag', worstMag < 0.05, `largest ${worstMag.toFixed(3)} mag`);
// the sky view's place: topocentric of date, altitude from the same RA and Dec as fixedAltAz would give (far body)
{
  const o = AST.asteroidById('vesta'), ms = Date.UTC(2026, 10, 17, 4), lat = 40 * RAD, lon = -105 * RAD;
  const p = AST.asteroidPlace(o, ms, lat, lon), f = A.fixedAltAz(p.raJ2000, p.decJ2000, ms, lat, lon);
  const d = A.separation(p.az, p.alt, f.az, f.alt) * DEG * 3600;
  check('topocentric altitude and azimuth agree with the J2000 place precessed (parallax under 10")', d < 12, `${d.toFixed(1)}"`);
}
process.exit(ok ? 0 : 1);
