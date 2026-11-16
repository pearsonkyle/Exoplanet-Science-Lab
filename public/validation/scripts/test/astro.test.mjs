// Positional astronomy (src/core/astro.js) against astropy/ERFA and the JPL DE432s ephemeris: 65 instants between
// 1975 and 2050 and five sites (see make_astro_reference.py). Every line prints the largest difference found.
import { readFileSync } from 'node:fs';
import * as A from '../src/core/astro.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./astro_reference.json', import.meta.url)));
const asec = (x) => x / A.ASEC, fmt = (x) => (x >= 120 ? (x / 60).toFixed(1) + "'" : x.toFixed(x < 10 ? 2 : 1) + '"');
const sep = (a, b) => asec(A.separation(a.ra, a.dec, b.ra, b.dec)), sepH = (a, b) => asec(A.separation(a.az, a.alt, b.az, b.alt));
const stat = () => ({ max: 0, sum2: 0, n: 0, add(x) { this.max = Math.max(this.max, Math.abs(x)); this.sum2 += x * x; this.n++; }, get rms() { return Math.sqrt(this.sum2 / this.n); }, get s() { return `max ${fmt(this.max)}, rms ${fmt(this.rms)}`; } });

// --- time scales and sidereal time
{
  let jd = 0, dt = 0; const g = stat(), ga = stat();
  for (const c of ref.cases) {
    jd = Math.max(jd, Math.abs(A.julianDate(c.ms) - c.jd_utc)); dt = Math.max(dt, Math.abs(A.ttMinusUtc(c.ms) - c.tt_minus_utc));
    g.add(asec(A.wrapPi(A.gmst(A.julianDate(c.ms)) - c.gmst))); ga.add(asec(A.wrapPi(A.gast(A.julianDate(c.ms), A.centuriesTT(c.ms)) - c.gast)));
  }
  check('Julian date', jd < 2e-9, `max difference ${jd.toExponential(1)} d (float64 limit)`);
  check('TT - UTC (leap second table)', dt < 1e-4, `max difference ${dt.toExponential(1)} s (ERFA dat)`);
  check('Greenwich mean sidereal time vs ERFA gmst06', g.max < 0.5, g.s + '  (IAU 1982 vs IAU 2006 expression)');
  check('Greenwich apparent sidereal time vs ERFA gst06a', ga.max < 1.0, ga.s + '  (4-term nutation)');
  check('J2000 epoch', Math.abs(A.julianDate(Date.UTC(2000, 0, 1, 12)) - 2451545) < 1e-9 && Math.abs(A.fromJulianDate(2451545) - Date.UTC(2000, 0, 1, 12)) < 1e-3);
}

// --- precession + nutation: the matrix against IAU 2006/2000A, as the largest displacement of a direction
{
  const s = stat();
  for (const c of ref.cases) {
    const m = A.j2000ToDateMatrix(A.centuriesTT(c.ms));
    for (const [ra, dec] of Object.values(ref.stars_icrs_deg)) {
      const v = A.sphToVec(ra * A.RAD, dec * A.RAD), a = A.vecToSph(A.matVec(m, v)), b = A.vecToSph(A.matVec(c.npb, v));
      s.add(asec(A.separation(a.lon, a.lat, b.lon, b.lat)));
      const p = A.precess(ra * A.RAD, dec * A.RAD, A.centuriesTT(c.ms)); if (Math.abs(A.wrapPi(p.ra - a.lon)) > 1e-12 || Math.abs(p.dec - a.lat) > 1e-12) ok = false;
    }
  }
  check('J2000 -> true equator and equinox of date vs ERFA pnm06a', s.max < 1.0, s.s);
  const P = A.precessionMatrix(0.3), I = A.matMul(P, A.transpose(P));
  check('precession matrix is orthonormal', Math.max(...I.map((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)))) < 1e-14);
}

// --- geocentric apparent places
const LIMIT = { sun: 40, moon: 20, mercury: 40, venus: 60, mars: 200, jupiter: 600, saturn: 720, uranus: 150, neptune: 75 };   // arcsec
const DIST = { sun: 1e-4, moon: 3e-4, mercury: 2e-4, venus: 2e-4, mars: 1e-3, jupiter: 2e-3, saturn: 3e-3, uranus: 3e-3, neptune: 2e-3 };  // relative
const geo = (b, T) => (b === 'sun' ? A.sunPosition(T) : b === 'moon' ? { ...A.moonPosition(T), dist: A.moonPosition(T).dist / A.AU_KM } : A.planetPosition(b, T));
for (const b of Object.keys(LIMIT)) {
  const s = stat(), d = stat();
  for (const c of ref.cases) { const T = A.centuriesTT(c.ms), p = geo(b, T), r = c.bodies[b]; s.add(sep(p, r)); d.add(p.dist / r.dist_au - 1); }
  check(`${b} geocentric apparent place vs DE432s`, s.max < LIMIT[b] && d.max < DIST[b], `${s.s}; distance max ${d.max.toExponential(1)} relative`);
}
{
  const s = stat();
  for (const c of ref.cases) { const T = A.centuriesTT(c.ms); s.add(A.moonPhase(A.sunPosition(T), A.moonPosition(T)).fraction - c.moon_fraction); }
  check('Moon illuminated fraction', s.max < 2e-4, `max difference ${s.max.toExponential(1)}`);
}

// --- topocentric altitude and azimuth (airless): the whole chain, including parallax
{
  const per = {}, st = stat(); let tw = 0, twNear = 0, n = 0;
  for (const c of ref.cases) for (const site of Object.values(c.sites)) {
    const lat = site.lat * A.RAD, lon = site.lon * A.RAD, sys = A.solarSystem(c.ms, lat, lon, site.height);
    for (const b of sys.bodies) (per[b.id] ||= stat()).add(sepH(b, site.bodies[b.id]));
    const m = A.matMul(A.equatorialToHorizontalMatrix(lat, sys.lst), A.j2000ToDateMatrix(sys.T));
    for (const [name, [ra, dec]] of Object.entries(ref.stars_icrs_deg)) {
      const p = A.precess(ra * A.RAD, dec * A.RAD, sys.T), h = A.equatorialToHorizontal(p.ra, p.dec, lat, sys.lst);
      st.add(sepH(h, site.stars[name]));
      // the matrix route used by the renderer must agree with the formula route
      const v = A.matVec(m, A.sphToVec(ra * A.RAD, dec * A.RAD)), hm = { alt: Math.asin(v[2]), az: Math.atan2(v[0], v[1]) };
      if (sepH(h, hm) > 1e-6) ok = false;
      const back = A.horizontalToEquatorial(h.alt, h.az, lat, sys.lst); if (sep(back, p) > 1e-6) { ok = false; console.log('FAIL round trip', name); }
    }
    // twilight class from the reference Sun altitude; disagreement is only allowed within 1' of a boundary
    const altRef = site.bodies.sun.alt * A.DEG, mine = A.twilight(sys.sun.alt * A.DEG), want = A.twilight(altRef); n++;
    if (mine !== want) { tw++; if ([-0.833, -6, -12, -18].some((b) => Math.abs(altRef - b) < 1 / 60)) twNear++; }
  }
  check('stars: altitude and azimuth vs astropy AltAz', st.max < 45, st.s + '  (includes 20" of annual aberration that is not modelled)');
  for (const [b, s] of Object.entries(per)) check(`${b} topocentric alt/az vs astropy AltAz`, s.max < LIMIT[b] + 5, s.s);
  check('twilight class from the computed Sun altitude', tw === twNear, `${n - tw} of ${n} agree; ${tw} differ, all within 1' of a boundary`);
  check('twilight boundaries', A.twilight(5) === 'day' && A.twilight(-3) === 'civil' && A.twilight(-9) === 'nautical' && A.twilight(-15) === 'astronomical' && A.twilight(-30) === 'night');
}

// --- refraction
{
  const s = stat();
  for (const r of ref.refraction.values) s.add(asec(A.refractionFromApparent(r.alt_apparent_deg * A.RAD)) - r.refraction_arcsec);
  check('refraction (Bennett) vs ERFA refco, apparent altitude 10-89 deg', s.max < 8, s.s);
  // near the horizon the reference is the textbook value of 34' to 35' at the apparent horizon (Pulkovo tables: 34.9' at 760 mmHg, 10 C)
  const r0 = asec(A.refractionFromApparent(0)) / 60, r5 = asec(A.refractionFromApparent(5 * A.RAD)) / 60;
  check('refraction at the horizon and at 5 deg', Math.abs(r0 - 34.7) < 1 && Math.abs(r5 - 9.8) < 0.3, `${r0.toFixed(1)}' and ${r5.toFixed(1)}' (tables: about 34.5-34.9' and 9.8')`);
  // the forward (true -> apparent) and inverse formulas must be consistent
  let w = 0; for (let h = -0.5; h <= 89; h += 0.5) { const t = h * A.RAD, app = t + A.refraction(t); w = Math.max(w, Math.abs(asec(app - A.refractionFromApparent(app) - t))); }
  check('true -> apparent -> true round trip', w < 6, `max ${fmt(w)}`);
  check('refraction scales with pressure and temperature', Math.abs(A.refraction(0.3, 505, 10) / A.refraction(0.3) - 0.5) < 1e-12 && A.refraction(0.3, 1010, -20) > A.refraction(0.3));
}

// --- parallax and magnitudes: analytic limits and published values
{
  const o = A.observerVector(0, 0), p = A.observerVector(Math.PI / 2, 0);
  check('observer vector: WGS84 equatorial and polar radii', Math.abs(o[0] - 6378.137) < 1e-9 && Math.abs(p[2] - 6356.7523) < 1e-3, `${o[0].toFixed(3)} km, ${p[2].toFixed(4)} km`);
  // Moon on the horizon of an equatorial observer: parallax = asin(R/d)
  const t = A.topocentric(Math.PI / 2, 0, 384400, 0, 0), want = Math.atan2(6378.137, 384400);
  check('horizontal parallax of the Moon', Math.abs(A.wrapPi(t.ra - Math.PI / 2) - want) < 1e-12, `${(want * A.DEG * 60).toFixed(2)}'`);
  // magnitudes: mean opposition values (Astronomical Almanac): Jupiter -2.7 at 5.2/4.2 AU, Mars -2.0 at 1.52/0.52 AU; full Moon -12.7
  const mj = A.planetMagnitude('jupiter', 5.2, 4.2, 0), mm = A.planetMagnitude('mars', 1.52, 0.52, 0), fm = A.moonPhase({ ra: 0, dec: 0, dist: 1 }, { ra: Math.PI, dec: 0, dist: 384400 }).mag;
  check('planet and Moon magnitudes at mean opposition', Math.abs(mj + 2.7) < 0.1 && Math.abs(mm + 2.0) < 0.1 && Math.abs(fm + 12.7) < 0.1, `Jupiter ${mj.toFixed(2)}, Mars ${mm.toFixed(2)}, full Moon ${fm.toFixed(2)}`);
  check('Kepler solver', Math.abs(A.solveKepler(1, 0.9) - 0.9 * Math.sin(A.solveKepler(1, 0.9)) - 1) < 1e-12);
}

// --- a target through a night: twilight times, rising, culmination and setting against astropy (bisection on AltAz)
{
  const night = JSON.parse(readFileSync(new URL('./astro_night_reference.json', import.meta.url)));
  const tw = stat(), rs = stat(), cu = stat(), aa = stat(); let nullsOk = true, nTw = 0, nRs = 0, graze = 0;
  for (const c of night.cases) {
    const lat = c.lat * A.RAD, lon = c.lon * A.RAD, n = A.nightOf(c.ms, lat, lon, c.height);
    if (Math.abs(n.noon - c.noon_ms) > 1) ok = false;
    for (const k of ['sun', 'civil', 'nautical', 'astronomical']) for (const e of ['evening', 'morning']) {
      const want = c.sun[k][e], got = n[k][e];
      if ((want == null) !== (got == null)) { nullsOk = false; console.log('FAIL', c.site, c.iso, k, e, want, got); continue; }
      if (want != null) { tw.add((got - want) / 1000); nTw++; }
    }
    for (const [name, st] of Object.entries(c.stars)) {
      const r = A.fixedRiseSet(st.ra * A.RAD, st.dec * A.RAD, c.ms, lat, lon);
      cu.add((r.culmination - st.culmination) / 1000);
      if ((st.rise == null) !== (r.rise == null) || (st.set == null) !== (r.set == null)) { nullsOk = false; console.log('FAIL', c.site, name, 'rise/set existence'); continue; }
      // a star that only just clears the horizon moves along it: seconds of time per arcsecond grow without bound
      const grazing = st.alt_max < 3 || Math.abs(c.lat) + Math.abs(st.dec) > 87;
      if (st.rise != null) { if (grazing) graze++; else { rs.add((r.rise - st.rise) / 1000); rs.add((r.set - st.set) / 1000); nRs += 2; } }
      if (Math.abs(r.altMax * A.DEG - st.alt_max) > 0.02) { ok = false; console.log('FAIL altMax', c.site, name, r.altMax * A.DEG, st.alt_max); }
      for (const q of st.at) { const h = A.fixedAltAz(st.ra * A.RAD, st.dec * A.RAD, q.ms, lat, lon); aa.add(asec(A.separation(h.az, h.alt, q.az * A.RAD, q.alt * A.RAD))); }
    }
  }
  check('sunset, sunrise and twilight times vs astropy', tw.max < 15 && nullsOk, `${nTw} times, max ${tw.max.toFixed(1)} s, rms ${tw.rms.toFixed(1)} s; polar day and night give null in both`);
  check('rising and setting of fixed targets vs astropy', rs.max < 20, `${nRs} times, max ${rs.max.toFixed(1)} s, rms ${rs.rms.toFixed(1)} s (${graze} grazing cases left out)`);
  check('culmination of fixed targets vs astropy', cu.max < 15, `max ${cu.max.toFixed(1)} s (the maximum of the altitude is flat: 1" of altitude is seconds of time)`);
  check('fixedAltAz vs astropy AltAz', aa.max < 45, aa.s);
  const tr = A.trackFixed(1, 0.5, 0, 3600000, 0.6, -1.9, 4); check('trackFixed: n + 1 points, ends on the ends', tr.length === 5 && tr[0].t === 0 && tr[4].t === 3600000 && Math.abs(tr[2].alt - A.fixedAltAz(1, 0.5, 1800000, 0.6, -1.9).alt) < 1e-15);
  const never = A.fixedRiseSet(0, -80 * A.RAD, 0, 60 * A.RAD, 0), always = A.fixedRiseSet(0, 80 * A.RAD, 0, 60 * A.RAD, 0);
  check('never rising and circumpolar targets', never.never && never.rise === null && always.always && always.set === null);
}

console.log(ok ? '\nAll astro tests passed.' : '\nFAILED');
process.exit(ok ? 0 : 1);
