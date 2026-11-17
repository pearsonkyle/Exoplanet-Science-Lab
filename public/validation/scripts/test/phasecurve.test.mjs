// Eclipses, phase curves and eclipse maps (src/core/phasecurve.js) against independent references
// (test/make_phasecurve_reference.py -> phasecurve_reference.json): direct integration of the visible disc, batman,
// starry 1.2.0, jaxoplanet 0.2.0, EXOTIC's own functions, scipy for the Planck integrals; then analytic limits,
// the linear solve, the temperature formulas, the bundled examples and speed. Every tolerance is stated in its check.
import { readFileSync, existsSync } from 'node:fs';
import * as P from '../src/core/phasecurve.js';
import { makeTransit } from '../src/core/transit.js';
import { eventTimes, orbitElements, eclipseTime } from '../src/core/kepler.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./phasecurve_reference.json', import.meta.url)));
const ex = (x) => x.toExponential(1), DEG = Math.PI / 180;
const maxDiff = (a, b) => { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i])); return w; };

// ---- 1. every basis function against direct integration of the visible, unocculted disc ----------------------
{
  let worst = 0, worstPartial = 0, nPartial = 0, n = 0, where = '';
  for (const c of ref.truth.cases) {
    const B = P.basisCurves(c.t, c.params, 3);
    for (const k of B.keys) for (let i = 0; i < c.t.length; i++) {
      const d = Math.abs(B.curves[k][i] - c.basis[k][i]); n++;
      if (c.kind[i] === 'partial') { nPartial++; if (d > worstPartial) worstPartial = d; }
      if (d > worst) { worst = d; where = `${c.system} ${k} ${c.kind[i]}`; }
    }
  }
  check('basis light curves (uniform + 15 harmonics to degree 3) match direct integration', worst < 1e-11,
    `max ${ex(worst)} (${where}) over ${n} values in 5 systems, ${nPartial} in ingress or egress; tolerance 1e-11, in units of the planet's flux. The reference is converged to ${ex(ref.truth.check.node_doubling)} (node doubling) and agrees with scipy's adaptive quadrature to ${ex(ref.truth.check.adaptive_quadrature)}`);
}

// ---- 2. uniform-disc eclipse against batman -------------------------------------------------------------------
{
  const tol = { wasp43: 1e-12, edgeon: 1e-12, grazing: 1e-12, ecc: 1e-8, hd80606: 1e-6 }, got = [];
  let pass = true;
  for (const c of ref.batman.cases) {
    const f = P.makeEclipse({ ...c.params, fpfs: c.depth / c.params.rprs ** 2 }), d = maxDiff(c.t.map(f), c.flux);
    got.push(`${c.system} ${ex(d)}`); if (!(d < tol[c.system])) pass = false;
    if (Math.abs(f.tecl - c.t_secondary) > 1e-9 * c.params.per) pass = false;
  }
  check(`uniform-disc eclipse matches batman ${ref.batman.version}`, pass, got.join(', ') + '; tolerance 1e-12 for circular orbits, 1e-8 at e = 0.3, 1e-6 at e = 0.93 (batman stops its Kepler iteration early; mid-eclipse times agree to 1e-9 P)');
}

// ---- 3. maps against starry and jaxoplanet ----------------------------------------------------------------------
for (const src of ['starry', 'jaxoplanet']) {
  let worst = 0, where = '', wStar = 0, n = 0;
  for (const c of ref[src].cases) {
    const lmax = src === 'starry' ? 3 : 2, B = P.basisCurves(c.t, c.params, lmax);
    for (const k of B.keys) { const d = maxDiff(B.curves[k], c.curves[k]); n++; if (d > worst) { worst = d; where = `${c.system} ${k}`; } }
    wStar = Math.max(wStar, maxDiff(B.star, c.star || c.curves.star));
  }
  check(`basis light curves match ${src} ${ref[src].version}`, worst < 1e-6 && wStar < 1e-8,
    `max ${ex(worst)} (${where}) over ${n} curves through transit, phase curve and eclipse; transit ${ex(wStar)}; tolerance 1e-6 of the planet's flux, 1e-8 for the transit. The floor is the a/R★ those packages derive from a stellar mass (a 3e-8 relative difference moves ingress by this much); sign and normalisation conventions agree`);
}
{
  // what fit_map.py does: the map's axis is left in the plane of the sky (map.inc = 90) while the orbit is inclined
  const c = ref.starry.cases.find((x) => x.system === 'wasp43'), B = P.basisCurves(c.t, c.params, 1);
  const d = Object.fromEntries(Object.keys(c.exoplanet_mapping).map((k) => [k, maxDiff(B.curves[k], c.exoplanet_mapping[k])]));
  check('Exoplanet-Mapping\'s starry setup differs only through the map axis', d.y1m1 > 0.1 && d.y10 < 0.05 && d.y11 < 0.02,
    `at i = 82.6°: Y1,-1 ${d.y1m1.toFixed(3)}, Y1,0 ${d.y10.toFixed(3)}, Y1,1 ${d.y11.toFixed(4)} of the planet's flux (fit_map.py leaves map.inc = 90, so the planet's pole is 7.4° from the orbit normal; with map.inc = i the curves are the ones above)`);
  const e = ref.starry.cases.find((x) => x.system === 'edgeon'), Be = P.basisCurves(e.t, e.params, 1);
  check('... and is identical for an edge-on orbit', Object.keys(e.exoplanet_mapping).every((k) => maxDiff(Be.curves[k], e.exoplanet_mapping[k]) < 1e-6), 'tolerance 1e-6');
}

// ---- 4. EXOTIC's phasecurve and eclipse -------------------------------------------------------------------------
{
  const E = ref.exotic, v = E.values, D = v.fpfs * v.rprs ** 2;
  const mine = { rprs: v.rprs, per: v.per, tmid: v.tmid, ars: v.ars, inc: v.inc, ecc: 0, omega: 0, ldLaw: 'quadratic', ld: [v.u1, v.u2], ...P.fromHarmonicCoefficients(v) };
  const back = P.harmonicCoefficients(mine);
  check('c1..c4 <-> contrast, hotspot, h2c, h2s round trip', ['c1', 'c2', 'c3', 'c4'].every((k) => Math.abs(back[k] - v[k]) < 1e-15) && Math.abs(back.c0 - (D - v.c1 - v.c3)) < 1e-15, `c0 ${back.c0.toExponential(6)}; tolerance 1e-15`);
  const f = P.makePhaseCurve(mine), ev = eventTimes(mine);
  let wOut = 0, wTr = 0, wTot = 0, wIng = 0, step = 0;
  E.t.forEach((t, i) => {
    const ph = ((t - v.tmid) / v.per % 1 + 1) % 1, dt = Math.min(ph, 1 - ph) * v.per, de = Math.abs(ph - 0.5) * v.per, d = Math.abs(f(t) - E.phasecurve[i]);
    if (dt < ev.t14 / 2) wTr = Math.max(wTr, d); else if (de > ev.e14 / 2 + 1e-4) wOut = Math.max(wOut, d);
  });
  E.t_eclipse.forEach((t, i) => {
    const de = Math.abs(t - v.per / 2), d = Math.abs(f(t) - E.phasecurve_eclipse[i]);
    if (de < ev.e23 / 2 - 1e-4) wTot = Math.max(wTot, d); else if (de < ev.e14 / 2) wIng = Math.max(wIng, d);
    if (i > 1) step = Math.max(step, Math.abs(E.phasecurve_eclipse[i] - 2 * E.phasecurve_eclipse[i - 1] + E.phasecurve_eclipse[i - 2]));
  });
  let myStep = 0; E.t_eclipse.forEach((t, i) => { if (i > 1) myStep = Math.max(myStep, Math.abs(f(t) - 2 * f(E.t_eclipse[i - 1]) + f(E.t_eclipse[i - 2]))); });
  check('harmonic model reproduces EXOTIC\'s phasecurve outside transit and eclipse', wOut < 2e-8, `max ${ex(wOut)}; tolerance 2e-8 (EXOTIC's mid-eclipse time comes from pylightcurve)`);
  check('... and in totality', wTot < 1e-7, `max ${ex(wTot)}; tolerance 1e-7 (pylightcurve at precision 3, the setting EXOTIC passes)`);
  // deliberate differences, measured: ingress shape, the step at EXOTIC's contact, the planet's light being transited
  check('differences from EXOTIC are the documented ones', wIng > 0.05 * D && wIng < D && wTr < 1.5 * D * v.rprs ** 2 + 5e-5 && step > 4 * myStep,
    `ingress/egress up to ${(wIng / D * 100).toFixed(0)}% of the depth (EXOTIC's ingress is that of a body of radius rprs·√fpfs and starts late); largest second difference between samples ${ex(step)} in EXOTIC (the jump where it switches from the harmonic series to the eclipse) against ${ex(myStep)} here; in transit ${ex(wTr)} (EXOTIC transits the planet's own light and reads the four Claret keys as quadratic)`);
  const ecl = P.makeEclipse(mine), totE = E.t_eclipse.map((t, i) => [Math.abs(t - v.per / 2), ecl(t) - D - E.eclipse[i]]);
  const wE = Math.max(...totE.filter(([de]) => de < ev.e23 / 2 - 1e-4 || de > ev.e14 / 2 + 1e-4).map(([, d]) => Math.abs(d)));
  check('eclipse depth convention is EXOTIC\'s (fpfs · rprs²)', wE < 1e-7, `multi_fitter.eclipse + depth against makeEclipse outside ingress and egress: ${ex(wE)}; tolerance 1e-7`);
}

// ---- 5. analytic limits -------------------------------------------------------------------------------------------
const W43 = ref.truth.cases[0].params;
{
  const base = { ...W43, fpfs: 0.146, contrast: 0.55, hotspot: 14 }, D = base.fpfs * base.rprs ** 2;
  const f = P.makePhaseCurve(base), te = f.tecl, ev = eventTimes(base);
  check('eclipse depth equals the planet-to-star flux ratio at mid-eclipse phase', Math.abs(f.phaseFlux(0) - D) < 1e-17 && f(te) === 1 && Math.abs(f.depth - D) < 1e-18, `Fp(0) - fpfs rprs² = ${ex(f.phaseFlux(0) - D)}; flux in totality ${f(te)}; tolerance 1e-17`);
  // first order: contrast, phase of maximum, never negative
  let mx = -1, mn = 9, pm = 0; for (let i = 0; i < 36000; i++) { const ph = (i / 100 - 180) * DEG, x = f.phaseFlux(ph); if (x > mx) { mx = x; pm = ph / DEG; } mn = Math.min(mn, x); }
  check('first-order curve: (max - min)/max is the contrast and the peak leads eclipse by the hot-spot offset', Math.abs((mx - mn) / mx - 0.55) < 1e-7 && Math.abs(pm + 14) < 0.006, `contrast ${((mx - mn) / mx).toFixed(7)}, peak at ${pm.toFixed(2)}° (grid of 0.01°)`);
  let neg = 0; for (const C of [0, 0.3, 1]) for (const h of [-170, -60, 0, 45, 120]) { const g = P.makePhaseCurve({ ...base, contrast: C, hotspot: h }); if (g.minFlux < -1e-13 * D || !g.ok || Math.abs(g.phaseFlux(0) - D) > 1e-13 * D) neg++; }
  check('first-order curve is never negative for contrast in [0, 1] and any offset, and keeps its depth', neg === 0, '15 combinations up to an offset of 170°; tolerance 1e-13 of the depth');
  // the degree-1 map is the same cosine
  const g = P.makePhaseCurve(base, { map: true }); let w = 0, wEcl = 0;
  for (let i = 0; i < 2000; i++) { const t = (i / 2000) * base.per, d = Math.abs(g(t) - f(t)); if (Math.abs(t - te - base.per * Math.round((t - te) / base.per)) > ev.e14 / 2) w = Math.max(w, d); else wEcl = Math.max(wEcl, d); }
  check('degree-1 map reproduces the cosine with the right phase outside eclipse', w < 1e-15, `max ${ex(w)}; tolerance 1e-15 (in ingress and egress the map differs from the uniform disc by up to ${ex(wEcl)}: that is the mapping signal)`);
  const ym = P.firstOrderToMap(0.55, 14, base.inc), tm = P.temperatureMap(base);
  check('hot spot of the degree-1 map sits at the phase offset', Math.abs(tm.hotspot.lon - 14) < 0.01 && Math.abs(tm.hotspot.lat) < 0.01 && Math.abs(Math.atan2(ym.y11, ym.y10) / DEG - 14) < 1e-12, `lon ${tm.hotspot.lon.toFixed(3)}°, lat ${tm.hotspot.lat.toFixed(3)}°; tolerance 0.01°`);
  // uniform map: flat outside eclipse
  const u = P.makePhaseCurve({ ...base, contrast: 0, hotspot: 0 }, { map: true }); let wu = 0;
  for (let i = 0; i < 500; i++) { const t = (i / 500) * base.per; if (Math.abs(t - base.per / 2) > ev.e14 / 2 && Math.abs(t - base.per * Math.round(t / base.per)) > ev.t14 / 2) wu = Math.max(wu, Math.abs(u(t) - 1 - D)); }
  check('uniform map gives a flat phase curve outside eclipse and transit', wu < 1e-16, `max |F - 1 - depth| = ${ex(wu)}; tolerance 1e-16`);
  // continuity at the contacts and during the eclipse
  const many = { ...base, y1m1: 0.1, y20: 0.05, y2m1: -0.04, y31: 0.03, y3m2: 0.02 }, h = P.makePhaseCurve(many); let jump = 0, prev = h(te - 0.6 * ev.e14);
  for (let i = 1; i <= 6000; i++) { const x = h(te - 0.6 * ev.e14 + (1.2 * ev.e14 * i) / 6000); jump = Math.max(jump, Math.abs(x - prev)); prev = x; }
  check('degree-3 map is continuous through all four contacts', jump < 1.2 * D * (1.2 * ev.e14 / 6000) / ((ev.e14 - ev.e23) / 2) * 1.6, `largest step ${ex(jump)} over 6000 samples, bounded by 1.6 x depth x dt / ingress time`);
  // Funk-Hecke: degree 3 is invisible out of eclipse and visible in ingress; odd-in-latitude terms vanish edge-on
  const tt = Array.from({ length: 400 }, (_, i) => (i / 400) * base.per), B = P.basisCurves(tt, base, 3);
  let out3 = 0, in3 = 0; for (const k of P.mapKeys(3).slice(8)) tt.forEach((t, i) => { const a = Math.abs(B.curves[k][i]); if (Math.abs(t - base.per / 2) > ev.e14 / 2) out3 = Math.max(out3, a); else in3 = Math.max(in3, a); });
  check('degree 3 is in the null space of the phase curve and visible only in ingress and egress', out3 < 1e-15 && in3 > 0.01, `outside eclipse ${ex(out3)} (tolerance 1e-15); in ingress up to ${in3.toFixed(3)} of the planet's flux`);
  const eo = ref.truth.cases[1].params, Be = P.basisCurves(tt.map((t) => (t / base.per) * eo.per), eo, 2);
  check('edge-on: harmonics odd in latitude give no signal at all', ['y1m1', 'y2m2', 'y2m1'].every((k) => Math.max(...Be.curves[k].map(Math.abs)) < 1e-15), 'Y1,-1, Y2,-2, Y2,-1; tolerance 1e-15');
  // moments of the visible disc reduce to the lens area
  let wm = 0; const mom = new Float64Array(10); for (const [d, R] of [[6.5, 6.27], [5.4, 6.27], [6.27, 6.27], [33.0, 33.3], [34.2, 33.3], [1.2, 1.5], [7.2699, 6.27]]) { P.visibleMoments(d, R, mom); wm = Math.max(wm, Math.abs(1 - mom[0] - P.lensFraction(d, R))); }
  check('zeroth moment equals the closed-form lens area', wm < 1e-11, `max ${ex(wm)} over 7 geometries including a 1e-4 graze; tolerance 1e-11 (the closed form loses digits as (R★/Rp)² through its arccosine; the moment agrees with direct integration to 1e-13)`);
  // harmonics are orthonormal on the sphere (starry normalisation: mean of Ylm Yl'm' = delta)
  let wo = 0; const keys = P.mapKeys(3), n = 64; const acc = keys.map(() => new Float64Array(keys.length));
  for (let i = 0; i < n; i++) { const x = Math.cos(Math.PI * (i + 0.5) / n), wgt = Math.PI / n * Math.sin(Math.PI * (i + 0.5) / n) / 2; for (let j = 0; j < 2 * n; j++) { const lon = (j * 180) / n, lat = Math.asin(x) / DEG, vals = keys.map((k) => P.mapIntensity({ [k]: 1 }, lat, lon) - 1); for (let a = 0; a < keys.length; a++) for (let b = 0; b < keys.length; b++) acc[a][b] += wgt * vals[a] * vals[b] / (2 * n); } }
  keys.forEach((_, a) => keys.forEach((__, b) => (wo = Math.max(wo, Math.abs(acc[a][b] - (a === b ? 1 : 0))))));
  check('the 15 harmonics are orthonormal over the sphere', wo < 2e-3, `max deviation ${ex(wo)} with a 64 x 128 midpoint grid; tolerance 2e-3 (quadrature)`);
  // stellar terms
  const st = P.makePhaseCurve({ ...base, fpfs: 0, ellip: 100, beam: 10 });
  check('ellipsoidal and beaming terms have the right phase', Math.abs(st(0.25 * base.per) - (1 + 100e-6 + 10e-6)) < 1e-15 && Math.abs(st(0.75 * base.per) - (1 + 100e-6 - 10e-6)) < 1e-15 && Math.abs(st(0.5 * base.per) - (1 - 100e-6)) < 1e-15, 'brightest at quadrature; a quarter orbit after transit the star approaches; tolerance 1e-15');
  // negative maps and fluxes are flagged
  const bad = P.makePhaseCurve({ ...base, contrast: 0, y10: 0.7 }), worse = P.makePhaseCurve({ ...base, contrast: 0, y10: -1.2 });
  check('negative brightness is flagged, negative flux refused', bad.negativeMap && bad.ok && !P.makePhaseCurve({ ...base, contrast: 0, y10: 0.7 }, { positiveMap: true }).ok && worse.negative && !worse.ok && P.makePhaseCurve({ ...base, contrast: 0.8, hotspot: 0, inc: 90 }).minIntensity > -1e-12 && P.makePhaseCurve({ ...base, contrast: 0.81, hotspot: 0, inc: 90 }).negativeMap,
    `y10 = 0.7: minimum brightness ${bad.minIntensity.toFixed(2)} of the mean; a degree-1 map is non-negative up to contrast 0.8`);
}

// ---- 6. light-travel time -----------------------------------------------------------------------------------------
{
  const hj = { rprs: 0.1, per: 4.1, tmid: 0, ars: 0.05 * 215.032 / 1.0, inc: 90, ecc: 0, omega: 0, rstar: 1.0 };
  const d1 = P.lightTravelDelay(hj) * 86400, d2 = P.lightTravelDelay({ rprs: 0.1, per: 111.4367, ars: 94.45, inc: 89.269, ecc: 0.93132, omega: -58.699, rstar: 1.05 }) * 86400;
  check('light-travel delay of the eclipse is 2a/c for a circular orbit', Math.abs(d1 - 2 * 0.05 * 499.004784) < 0.01, `hot Jupiter at 0.05 au: ${d1.toFixed(2)} s (2a/c = ${(2 * 0.05 * 499.004784).toFixed(2)} s); HD 80606 b: ${d2.toFixed(1)} s, against ${(2 * 94.45 * 1.05 * P.RSUN_LIGHT_DAYS * 86400).toFixed(0)} s for 2a/c; tolerance 0.01 s`);
  // the modelled eclipse really moves by that much, and the transit does not move
  const L = ref.starry.ltt, pr = { ...L.params, rstar: L.rstar, fpfs: 0.003 / L.params.rprs ** 2 };
  const a = P.makeEclipse(pr), b = P.makeEclipse(pr, { ltt: true });
  const centre = (f, t0, w) => { let s0 = 0, s1 = 0; for (let i = 0; i <= 20000; i++) { const t = t0 - w + (2 * w * i) / 20000, x = 1 + f.depth - f(t); s0 += x; s1 += x * t; } return s1 / s0; };
  const shift = (centre(b, pr.per / 2, 0.05 * pr.per) - centre(a, pr.per / 2, 0.05 * pr.per)) * 86400, expect = b.lttDelay * 86400;
  const tr = (f) => { let s0 = 0, s1 = 0; for (let i = 0; i <= 20000; i++) { const t = -0.05 + (0.1 * i) / 20000, x = 1 + f.phaseFlux(Math.PI) - f(t); s0 += x; s1 += x * t; } return s1 / s0; };
  const dTr = (tr(b) - tr(a)) * 86400;
  check('modelled eclipse is late by the delay between conjunctions', Math.abs(shift + dTr - expect) < 0.01 && Math.abs(dTr) < 0.2 && Math.abs(b.tecl - a.tecl - b.lttDelay) < 1e-15, `eclipse centroid moves ${shift.toFixed(3)} s and the transit centroid ${dTr.toFixed(3)} s (the planet's distance changes during each event): together ${(shift + dTr).toFixed(3)} s, expected ${expect.toFixed(3)} s; tolerance 0.01 s`);
  // starry measures the delay from the plane of the sky through the star: its transit is a sin i / c early. Shift to ESL's clock.
  const off = b.lttDelay / 2, ds = maxDiff(L.t.map((t) => b(t + off)), L.flux), dn = maxDiff(L.t.map((t) => a(t)), L.flux_nodelay), dd = maxDiff(L.flux, L.flux_nodelay);
  check('... and matches starry with light_delay = True', ds < 1e-7 && dn < 1e-9, `uniform planet of depth 0.003 through eclipse: ${ex(ds)} with the delay, ${ex(dn)} without (the delay changes the curve by ${ex(dd)}); tolerance 1e-7 after moving starry's clock by a sin i / c = ${(off * 86400).toFixed(2)} s, since ESL keeps mid-transit at T mid`);
}

// ---- 7. linear solve ------------------------------------------------------------------------------------------------
{
  const truth = { ...W43, fpfs: 0.146, y10: 0.42, y11: 0.09, y1m1: 0.06, y20: -0.05, y22: 0.04, y21: 0.03 }, f = P.makePhaseCurve(truth), ev = eventTimes(truth);
  // a full orbit plus two more eclipses, 60 s cadence
  const t = []; for (let x = -0.3; x < 0.75; x += 60 / 86400 / truth.per) t.push(x * truth.per);
  for (const k of [1, 2]) for (let x = -1.3 * ev.e14; x < 1.3 * ev.e14; x += 20 / 86400) t.push((k + 0.5) * truth.per + x);
  const clean = t.map((x) => 1.0007 * f(x)), e = t.map(() => 1e-4);
  const s0 = P.solveMap({ t, f: clean, e }, truth, { lmax: 2 });
  const w0 = Math.max(Math.abs(s0.fpfs - truth.fpfs) / truth.fpfs, ...['y10', 'y11', 'y1m1', 'y20', 'y22', 'y21', 'y2m1', 'y2m2'].map((k) => Math.abs(s0.y[k] - (truth[k] || 0))));
  check('linear solve recovers the injected map exactly without noise', w0 < 1e-9 && Math.abs(s0.a1[0] - 1.0007) < 1e-12 && s0.chi2 < 1e-12, `8 coefficients + depth + stellar level: max error ${ex(w0)}; tolerance 1e-9`);
  // with noise: pulls of the well-constrained coefficients over many realisations
  const rng = makeRng(11), keys = ['y10', 'y11', 'y20', 'y22', 'y21'], sum = Object.fromEntries(keys.map((k) => [k, 0])); let sd = 0, chi = 0; const M = 300;
  for (let r = 0; r < M; r++) {
    const s = P.solveMap({ t, f: clean.map((x) => x + 1e-4 * rng.normal()), e }, truth, { lmax: 2 });
    for (const k of keys) sum[k] += ((s.y[k] - truth[k]) / s.yErr[k]) ** 2; sd += ((s.depth - f.depth) / s.depthErr) ** 2; chi += s.chi2 / s.dof;
  }
  const pulls = keys.map((k) => Math.sqrt(sum[k] / M)), pd = Math.sqrt(sd / M);
  check('reported uncertainties of the linear solve have unit pulls', pulls.every((x) => Math.abs(x - 1) < 0.15) && Math.abs(pd - 1) < 0.15 && Math.abs(chi / M - 1) < 0.02, `${M} noise realisations: ${keys.map((k, i) => `${k} ${pulls[i].toFixed(2)}`).join(', ')}, depth ${pd.toFixed(2)}; mean reduced chi2 ${(chi / M).toFixed(3)}; tolerance 0.15`);
  // a phase curve without eclipse points cannot see degree 3 or latitude: the solve says so
  const tp = t.filter((x) => Math.abs(x / truth.per - 0.5) > 0.1 && x < truth.per), sp = P.solveMap({ t: tp, f: tp.map((x) => f(x)), e: tp.map(() => 1e-4) }, truth, { lmax: 3 });
  check('rank deficiency is reported when the data cannot constrain the basis', sp.rankDeficient && !s0.rankDeficient, 'degree 3 without ingress or egress points');
}

// ---- 8. temperatures --------------------------------------------------------------------------------------------------
{
  let w = 0; for (const r of ref.planck.rows) w = Math.max(w, Math.abs(P.brightnessTemperature(r.ratio, r.tstar, r.band) / r.tb - 1));
  const m = ref.planck.mono[0];
  check('brightness temperature matches scipy quadrature and root finding', w < 1e-6 && Math.abs(P.brightnessTemperature(m.ratio, m.tstar, m.lam) / m.tb - 1) < 1e-9, `48 band, star and ratio combinations: max relative ${ex(w)} (tolerance 1e-6; 64-interval Simpson); monochromatic against the closed form ${ex(Math.abs(P.brightnessTemperature(m.ratio, m.tstar, m.lam) / m.tb - 1))} (tolerance 1e-9)`);
  check('a planet as bright as the star has the star\'s temperature', Math.abs(P.brightnessTemperature(1, 5000, 'IRAC 4.5') - 5000) < 1e-5 && P.brightnessTemperature(0, 5000, 4.5) === 0 && Number.isNaN(P.brightnessTemperature(-0.1, 5000, 4.5)), 'ratio 1 -> T*, 0 -> 0, negative -> NaN');
  // Cowan & Agol (2011): round trip, limits, energy
  let wr = 0; for (const A of [0, 0.3, 0.7]) for (const eps of [0, 0.2, 0.6, 1]) { const T = P.dayNightTemperatures({ bondAlbedo: A, epsilon: eps, tstar: 5500, ars: 6 }), h = P.heatRedistribution({ ...T, tstar: 5500, ars: 6 }); wr = Math.max(wr, Math.abs(h.bondAlbedo - A), Math.abs(h.epsilon - eps)); }
  const full = P.dayNightTemperatures({ bondAlbedo: 0, epsilon: 1, tstar: 5500, ars: 6 }), none = P.dayNightTemperatures({ bondAlbedo: 0, epsilon: 0, tstar: 5500, ars: 6 }), T0 = 5500 / Math.sqrt(6);
  check('Bond albedo and redistribution invert the Cowan & Agol relations', wr < 1e-12, `12 (A_B, eps) pairs; max error ${ex(wr)}; tolerance 1e-12`);
  check('energy conservation in the limits', Math.abs(full.tday - full.tnight) < 1e-9 && Math.abs(full.tday - T0 / Math.SQRT2) < 1e-9 && Math.abs((none.tday / T0) ** 4 - ref.planck.no_redistribution.dayside_T4_over_T04) < 1e-12 && none.tnight === 0 && Math.abs(ref.planck.no_redistribution.power_over_absorbed - 1) < 1e-12,
    `full redistribution: Td = Tn = T0/√2 = ${full.tday.toFixed(1)} K (4π R² σ T⁴ = absorbed π R² σ T0⁴); none: Td⁴/T0⁴ = ${((none.tday / T0) ** 4).toFixed(6)} against ${ref.planck.no_redistribution.dayside_T4_over_T04.toFixed(6)} from integrating T⁴ ∝ cos over the visible dayside, whose total emission is ${ref.planck.no_redistribution.power_over_absorbed.toFixed(6)} of the absorbed power; tolerance 1e-12`);
  // the summary is consistent with the model it summarises
  const pr = { ...W43, fpfs: 0.146, contrast: 0.7, hotspot: 12 }, s = P.phaseSummary(pr, { tstar: 4400, band: 'IRAC 4.5' });
  const tdCheck = P.brightnessTemperature(pr.fpfs, 4400, 'IRAC 4.5');
  check('summary: dayside temperature, offset and contrast follow from the parameters', Math.abs(s.tday - tdCheck) < 1e-6 && Math.abs(s.hotspotOffset - 12) < 1e-4 && Math.abs(s.contrast - 0.7) < 1e-9 && s.tnight < s.tday && Math.abs(s.temp[180] - s.tday) < 1e-6,
    `Tday ${s.tday.toFixed(0)} K, Tnight ${s.tnight.toFixed(0)} K, offset ${s.hotspotOffset.toFixed(3)}°, A_B ${s.bondAlbedo.toFixed(2)}, eps ${s.epsilon.toFixed(2)}`);
  // disc-integrated flux of the temperature map equals the phase curve (the map and the curve are the same object)
  const tm = P.temperatureMap(pr, { nlat: 180, nlon: 360 }); let fl = 0;
  for (let i = 0; i < tm.nlat; i++) for (let j = 0; j < tm.nlon; j++) { const la = tm.lat[i] * DEG, lo = tm.lon[j] * DEG, mu = Math.cos(la) * Math.cos(lo) * Math.sin(pr.inc * DEG) + Math.sin(la) * Math.cos(pr.inc * DEG); if (mu > 0) fl += tm.ratio[i * tm.nlon + j] * mu * Math.cos(la) * (Math.PI / tm.nlat) * (2 * Math.PI / tm.nlon); }
  check('integrating the map over the dayside gives back the eclipse depth', Math.abs(fl / Math.PI * pr.rprs ** 2 / (pr.fpfs * pr.rprs ** 2) - 1) < 2e-4, `ratio ${(fl / Math.PI / pr.fpfs).toFixed(6)} on a 1° grid; tolerance 2e-4 (midpoint rule across the terminator)`);
}

// ---- 9. the bundled examples ---------------------------------------------------------------------------------------------
for (const name of ['wasp43b_phasecurve', 'wasp43b_eclipse_map', 'wasp18b_sim_eclipse_map']) {
  const url = new URL(`../public/examples/phasecurve/${name}.json`, import.meta.url);
  if (!existsSync(url)) { check(`example ${name} present`, false); continue; }
  const s = JSON.parse(readFileSync(url)), lc = s.data.light_curve, pp = s.planets[0].parameters, tref = s.time_reference;
  const prm = { ...pp, tmid: pp.tmid - tref, ldLaw: s.limb_darkening.law, ld: s.limb_darkening.coefficients, rstar: s.star.rstar };
  const data = { t: lc.time.map((x) => x - tref), f: lc.flux, e: lc.flux_err, epoch: lc.epoch || null };
  const f = P.makePhaseCurve(prm, { ltt: !!(s.phase && s.phase.ltt) });
  // chi2 at the stored parameters with the stellar level of each epoch solved for
  let nE = 1; if (data.epoch) nE = Math.max(...data.epoch) + 1;
  const sm = new Float64Array(nE), smm = new Float64Array(nE), m = data.t.map((t) => f(t));
  data.t.forEach((_, i) => { const k = data.epoch ? data.epoch[i] : 0, w = 1 / data.e[i] ** 2; sm[k] += w * m[i] * data.f[i]; smm[k] += w * m[i] * m[i]; });
  let chi2 = 0; data.t.forEach((_, i) => { const k = data.epoch ? data.epoch[i] : 0; chi2 += ((data.f[i] - (sm[k] / smm[k]) * m[i]) / data.e[i]) ** 2; });
  const flat = P.makePhaseCurve({ ...prm, fpfs: 0 }), m0 = data.t.map((t) => flat(t)); const s0 = new Float64Array(nE), s00 = new Float64Array(nE);
  data.t.forEach((_, i) => { const k = data.epoch ? data.epoch[i] : 0, w = 1 / data.e[i] ** 2; s0[k] += w * m0[i] * data.f[i]; s00[k] += w * m0[i] * m0[i]; });
  let chi0 = 0; data.t.forEach((_, i) => { const k = data.epoch ? data.epoch[i] : 0; chi0 += ((data.f[i] - (s0[k] / s00[k]) * m0[i]) / data.e[i]) ** 2; });
  const free = s.fit.free.map((x) => x.key), known = new Set([...P.PHASE_FIELDS, 'rprs', 'inc', 'tmid', 'per', 'ars', 'ecc', 'omega']);
  check(`example ${name}: the stored model fits its data`, f.ok && chi2 / data.t.length < 1.25 && chi0 - chi2 > 100 && free.every((k) => known.has(k.split('@')[0])) && data.t.length === lc.flux.length,
    `${data.t.length} points, ${nE} observation${nE > 1 ? 's' : ''}; chi2/N = ${(chi2 / data.t.length).toFixed(3)} (limit 1.25); a planet with no light is worse by Δchi2 = ${(chi0 - chi2).toFixed(0)}; free: ${free.join(', ')}`);
}

// ---- 10. speed ----------------------------------------------------------------------------------------------------------------
{
  const N = 1000, t = Float64Array.from({ length: N }, (_, i) => (i / N) * W43.per), out = new Float64Array(N);
  const tEcl = Float64Array.from({ length: N }, (_, i) => W43.per * (0.5 + 0.06 * (i / N - 0.5)));
  const time = (pr, tt, o) => { const reps = 300; P.phaseCurveModel(tt, pr, out, o); const t0 = performance.now(); for (let r = 0; r < reps; r++) P.phaseCurveModel(tt, pr, out, o); return ((performance.now() - t0) / reps / N) * 1000; };
  const tr = makeTransit(W43), t0 = performance.now(); for (let r = 0; r < 300; r++) for (let i = 0; i < N; i++) out[i] = tr(t[i]); const usTr = ((performance.now() - t0) / 300 / N) * 1000;
  const first = { ...W43, fpfs: 0.146, contrast: 0.6, hotspot: 10 }, deg2 = { ...first, y1m1: 0.05, y20: 0.04, y21: 0.03, y22: 0.02, y2m1: 0.02 }, deg3 = { ...deg2, y31: 0.02, y3m2: 0.02 };
  const us = { first: time(first, t), d2: time(deg2, t), d3: time(deg3, t), firstE: time(first, tEcl), d2E: time(deg2, tEcl), d3E: time(deg3, tEcl), ecc: time({ ...first, ecc: 0.2, omega: 50 }, t), ltt: time({ ...first, rstar: 0.6 }, t, { ltt: true }) };
  const setup = (pr) => { const t1 = performance.now(); for (let i = 0; i < 5000; i++) P.makePhaseCurve(pr); return ((performance.now() - t1) / 5000) * 1000; };
  const su = [setup(first), setup(deg2), setup(deg3)];
  check('speed', us.d2E < 20, `microseconds per point over a full orbit: first order ${us.first.toFixed(3)}, degree-2 map ${us.d2.toFixed(3)}, degree-3 map ${us.d3.toFixed(3)}, eccentric ${us.ecc.toFixed(3)}, with light-travel time ${us.ltt.toFixed(3)} (transit alone ${usTr.toFixed(3)}); around the eclipse only (a third of the points in ingress or egress): first order ${us.firstE.toFixed(3)}, degree 2 ${us.d2E.toFixed(3)}, degree 3 ${us.d3E.toFixed(3)}; limit 20. These include compiling the parameter set once per 1000 points, which alone takes ${su[0].toFixed(1)} (first order), ${su[1].toFixed(1)} (degree 2) and ${su[2].toFixed(1)} (degree 3) microseconds per likelihood`);
}

console.log(ok ? '\nAll phase-curve tests passed.' : '\nSome phase-curve tests FAILED.');
process.exit(ok ? 0 : 1);
