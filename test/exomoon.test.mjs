// Planet + moon model (src/core/exomoon.js) against independent references (test/make_exomoon_reference.py):
// scipy quadrature of the union of two discs, the owner's exomoon2.py, Pandora (Hippke & Heller); then exact
// identities, the direction of the moon's orbit, timing variations against Kipping (2009), a search and a
// nested-sampling fit that recover an injected moon, and false alarms on moonless data.   node test/exomoon.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { makePlanetMoonTransit, moonComponents, moonGeometry, moonPeriodFor, unionBlocked, overlapBlocked, moonPosition, planetPosition, moonOrbitPath,
  ttvTdvAmplitudes, moonTimings, moonSearch, oseStack, oseModel, moonParamsFrom, MOON_PARAMS, MOON_FIELDS, moonKey } from '../src/core/exomoon.js';
import { makeTransit, blockedFraction } from '../src/core/transit.js';
import { prepareLD, toClaret } from '../src/core/limbdark.js';
import { orbitElements, orbitPosition, derived } from '../src/core/kepler.js';
import { arsFromKepler } from '../src/core/rv.js';
import { C } from '../src/core/derive.js';
import { MiniNest } from '../src/core/nested.js';
import { makeTransform } from '../src/core/priors.js';
import { makeRng, weightedQuantiles } from '../src/core/stats.js';
import { validateSession, valuesFromSession, specFromSession } from '../src/core/session.js';
import { buildProblem } from '../src/core/model.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./exomoon_reference.json', import.meta.url)));
const ex = (x) => x.toExponential(1), wrap = (x) => ((x % 1) + 1) % 1;

// the system used for the identities, the timing test and the recovery: a Jupiter at 45 d around the Sun
const ARS = arsFromKepler(45, 1, 1, 1), INC = (Math.acos(0.3 / ARS) * 180) / Math.PI;
const PLANET = { rprs: 0.1, ars: ARS, inc: INC, per: 45, tmid: 10, ecc: 0, omega: 0, ldLaw: 'quadratic', ld: [0.4, 0.26], mplanet: 1, mstar: 1 };
const MOON = { rmoon: 0.015, permoon: 3.7, phmoon: 0.13, mmoon: 0 };

// ---- 1. the union of two discs against scipy quadrature --------------------------------------------------------
{
  let worst = 0, worstOv = 0, where = '';
  for (const c of ref.union.cases) {
    const o = {}, u = unionBlocked(c.x1, c.y1, c.r1, c.x2, c.y2, c.r2, prepareLD(c.a), o), err = Math.abs(u - c.union);
    worstOv = Math.max(worstOv, Math.abs(o.overlap - c.overlap));
    if (err > worst) { worst = err; where = `${c.kind}, ${c.law}`; }
  }
  check('union of two discs on a limb-darkened star = scipy quadrature', worst < 1e-11 && worstOv < 1e-11,
    `${ref.union.cases.length} cases, 5 profiles: max |error| ${ex(worst)} (${where}); overlap term ${ex(worstOv)}; tolerance 1e-11; quad's own error estimate ${ex(ref.union.quad_err_max)}`);
}

// ---- 2. the owner's exomoon2.py --------------------------------------------------------------------------------
if (ref.exomoon2) {
  const x = ref.exomoon2, pr = x.prior, mp = x.moon_prior, n = x.time.length;
  const tp = { rprs: pr.rprs, ars: pr.ars, per: pr.per, inc: pr.inc, ecc: 0, omega: 0, tmid: pr.tmid, ldLaw: 'quadratic', ld: [pr.u1, pr.u2] };
  // (a) its algorithm, re-expressed with this kernel: the moon's dip is the planet's transit model with the moon's radius,
  //     evaluated at t - toffset(t), toffset = (a_moon / v_planet) cos(2 pi (t - moon_tmid) / moon_per), and set to 1 where
  //     |a_moon cos| < r_planet. Its lengths are taken from the reference file (they carry its 4 pi for 4 pi^2).
  const fp = makeTransit(tp), fm = makeTransit({ ...tp, rprs: mp.rprs }), A = x.a_moon_au / ((2 * Math.PI * x.a_planet_au) / pr.per);
  let dP = 0, dM = 0, dT = 0, dA = 0;
  for (let i = 0; i < n; i++) {
    const t = x.time[i], c = Math.cos(2 * Math.PI * (((t - mp.moon_tmid) / mp.moon_per) % 1)), toff = A * c;
    const m = Math.abs(x.a_moon_au * c) < x.r_planet_au ? 1 : fm(t - toff), p = fp(t);
    dP = Math.max(dP, Math.abs(p - x.planet[i])); dM = Math.max(dM, Math.abs(m - x.moon[i])); dT = Math.max(dT, Math.abs(toff - x.toffset[i]));
    dA = Math.max(dA, Math.abs(p - Math.abs(1 - m) - x.all[i]));
  }
  check('exomoon2.py reproduced step by step with this kernel', dP < 2e-8 && dM < 2e-8 && dA < 2e-8 && dT < 1e-12,
    `${n} of its ${x.n_total} points: planet ${ex(dP)}, moon ${ex(dM)}, planet + moon ${ex(dA)} (tolerance 2e-8, the accuracy of its Mandel-Agol routine), time offset ${ex(dT)} d`);
  // (b) the same system in the geometric model: separation a_moon / a_planet of its formulas (the 4 pi cancels in the ratio)
  //     times a/R*, the moon kept on the planet's chord (imoon = 90 - i), no wobble.
  const amoon = (x.a_moon_au / x.a_planet_au) * pr.ars;
  const par = { ...tp, rmoon: mp.rprs, permoon: mp.moon_per, phmoon: wrap((pr.tmid - mp.moon_tmid) / mp.moon_per - 0.25), amoon, imoon: 90 - pr.inc, mmoon: 0 };
  const f = makePlanetMoonTransit(par), c = {}, depth = 1 - Math.min(...x.moon);
  let dmax = 0, s2 = 0, dflat = 0, nflat = 0, nMut = 0;
  for (let i = 0; i < n; i++) {
    f.components(x.time[i], c);
    const d = Math.abs(c.total - x.all[i]); dmax = Math.max(dmax, d); s2 += d * d;
    if (c.overlap > 0 && c.planet < 1) nMut++;
    // both moons fully on the disc and away from its limb: only the limb darkening at slightly different places differs
    if (1 - c.moon > 0.8 * depth && 1 - x.moon[i] > 0.8 * depth) { dflat = Math.max(dflat, d); nflat++; }
  }
  check('exomoon2.py configuration in the geometric model', dmax < 0.8 * depth && Math.sqrt(s2 / n) < 3e-6 && dflat < 5e-6,
    `moon depth ${(depth * 1e6).toFixed(1)} ppm; difference rms ${(Math.sqrt(s2 / n) * 1e6).toFixed(2)} ppm (tolerance 3), in the flat part of the moon's dip max ${(dflat * 1e6).toFixed(2)} ppm over ${nflat} points (tolerance 5: the chord is at b = 0.87, where the star's brightness changes quickly), ` +
    `at the moon's ingress and egress up to ${(dmax * 1e6).toFixed(1)} ppm: its moon is the planet's path shifted in time, here it is displaced ${amoon.toFixed(2)} R* in space, and the two differ by up to 0.007 R* where a 0.0075 R* moon crosses the limb`);
  check('exomoon2.py: no planet-moon eclipse falls inside a transit in its 100 d', nMut === 0, `${x.occulted.reduce((a, b) => a + b, 0)} of the kept points are masked by its rule, all out of transit`);
  const g = f.geometry;
  check('exomoon2.py configuration is flagged as unbound', !g.bound && !g.ok && g.hillFrac > 2,
    `moon period ${mp.moon_per} d > planet period ${pr.per} d: ${g.hillFrac.toFixed(2)} Hill radii; with the planet's mass ${mp.mass_planet} M Jup the longest stable prograde period is ${moonGeometry({ ...tp, rmoon: mp.rprs, permoon: 1, mplanet: mp.mass_planet, mstar: mp.mass_star }).maxPeriod.toFixed(2)} d`);
} else check('exomoon2.py reference present', false, 'the owner\'s code could not be run when the reference was made');

// ---- 3. Pandora (pandoramoon on PyPI) --------------------------------------------------------------------------
if (ref.pandora) {
  let dPhot = 0, dMutP = 0, dMutMine = 0, dOff = 0, dPos = 0, dLc = 0, nMut = 0, n = 0;
  for (const p of ref.pandora) {
    const ld = prepareLD(toClaret('quadratic', [p.u1, p.u2])), inc = (Math.acos(p.b_bary / p.a_bary) * 180) / Math.PI;
    // Pandora: moon - barycentre = a (cos Q, sin Q cos i_moon), Q = 2 pi (t / per - tau), the planet at y = +b. Here y is
    // mirrored (the planet at y = -b): i + imoon = 180 - i_moon, phmoon = 1/4 - tau + t0 / per.
    const par = { rprs: p.r_planet, ars: p.a_bary, per: p.per_bary, inc, ecc: 0, omega: 0, tmid: p.t0_bary, ldLaw: 'quadratic', ld: [p.u1, p.u2],
      rmoon: p.r_moon, permoon: p.per_moon, amoon: p.a_moon, mmoon: p.mass_ratio, imoon: 180 - p.i_moon - inc, phmoon: wrap(0.25 - p.tau_moon + p.t0_bary / p.per_moon) };
    const f = makePlanetMoonTransit(par), P = [0, 0, 0], M = [0, 0, 0];
    for (let i = 0; i < p.time.length; i++) {
      const sep = Math.hypot(p.mx[i] - p.px[i], p.my[i] - p.py[i]), u = 1 - unionBlocked(p.px[i], p.py[i], p.r_planet, p.mx[i], p.my[i], p.r_moon, ld);
      if (sep >= p.r_planet + p.r_moon) dPhot = Math.max(dPhot, Math.abs(u - p.total[i]));
      f.positions(p.time[i], P, M);
      dOff = Math.max(dOff, Math.abs(M[0] - P[0] - (p.mx[i] - p.px[i])), Math.abs(-(M[1] - P[1]) - (p.my[i] - p.py[i])));
      dPos = Math.max(dPos, Math.abs(P[0] - p.px[i]), Math.abs(-P[1] - p.py[i]));
      dLc = Math.max(dLc, Math.abs(f(p.time[i]) - p.total[i])); n++;
    }
    for (const m of p.mutual_truth) {
      dMutP = Math.max(dMutP, Math.abs(m.pandora - m.truth)); nMut++;
      dMutMine = Math.max(dMutMine, Math.abs(1 - unionBlocked(m.px, m.py, p.r_planet, m.mx, m.my, p.r_moon, ld) - m.truth));
    }
  }
  check('Pandora: photometry at its own sky positions, discs apart', dPhot < 5e-9, `${n} points, 3 systems: max difference ${ex(dPhot)} (tolerance 5e-9)`);
  check('Pandora: planet-moon eclipses, both codes against quadrature', dMutMine < 1e-11 && dMutP < 2e-5,
    `${nMut} partial eclipses: this code ${ex(dMutMine)} from the quadrature (tolerance 1e-11), Pandora ${ex(dMutP)} (its lens term is approximate on a limb-darkened star; bound 2e-5)`);
  check('Pandora: the moon\'s orbit about the planet, same conventions after mapping', dOff < 1e-10, `moon - planet offsets agree to ${ex(dOff)} R* (tolerance 1e-10), wobble included (Mm/Mp = 0.02)`);
  check('Pandora: whole light curves', dLc < 1e-5 && dPos < 2e-3,
    `max flux difference ${ex(dLc)} (tolerance 1e-5): Pandora moves the barycentre on a straight line at constant speed, here it is the Keplerian arc, ${ex(dPos)} R* apart at most`);
} else check('Pandora reference present', false, 'pandoramoon could not be run when the reference was made');

// ---- 4. exact identities ---------------------------------------------------------------------------------------
{
  const f0 = makeTransit(PLANET), ts = Float64Array.from({ length: 4001 }, (_, i) => PLANET.tmid - 1 + (2 * i) / 4000);
  const maxDiff = (f, g = f0) => { let d = 0; for (const t of ts) d = Math.max(d, Math.abs(f(t) - g(t))); return d; };
  check('no moon: identical to makeTransit', maxDiff(makePlanetMoonTransit({ ...PLANET, rmoon: 0, permoon: 3.7, phmoon: 0.2, mmoon: 0 })) === 0 &&
    maxDiff(makePlanetMoonTransit({ ...PLANET, ecc: 0.3, omega: 40, rmoon: 0, permoon: 3.7 }), makeTransit({ ...PLANET, ecc: 0.3, omega: 40 })) === 0, 'difference exactly 0, circular and eccentric');
  // a moon that leads the planet by 5 stellar radii and hardly moves: it is off the star whenever the planet is on it
  const far = makePlanetMoonTransit({ ...PLANET, rmoon: 0.03, permoon: 1e7, phmoon: 0.25, amoon: 5, mmoon: 0 });
  const t14 = derived(PLANET).t14; let dFar = 0, c = {};
  for (const t of ts) if (Math.abs(t - PLANET.tmid) < 0.6 * t14) dFar = Math.max(dFar, Math.abs(far(t) - f0(t)));
  check('a moon far from the star during the planet\'s transit adds nothing', dFar === 0 && far(PLANET.tmid - 5 / ((2 * Math.PI * ARS) / 45)) < 1, 'difference exactly 0 (and its own dip is there, 5 R* earlier)');
  // a moon exactly in front of (phase 0) or behind (phase 0.5) the planet, inside the planet's disc all transit long
  let dHid = 0;
  for (const ph of [0, 0.5]) for (const im of [0, 90 - INC]) dHid = Math.max(dHid, maxDiff(makePlanetMoonTransit({ ...PLANET, rmoon: 0.03, permoon: 1e7, phmoon: ph, imoon: im, mmoon: 0 })));
  check('a moon wholly in front of or behind the planet changes nothing', dHid === 0, 'difference exactly 0 for phase 0 and 0.5, coplanar and on the chord');
  // discs that do not overlap: the blocked flux is the sum
  const ld = prepareLD(toClaret('quadratic', [0.4, 0.26]));
  const sum = unionBlocked(0.3, 0.2, 0.1, -0.4, 0.5, 0.03, ld), parts = blockedFraction(Math.sqrt(0.3 * 0.3 + 0.2 * 0.2), 0.1, ld) + blockedFraction(Math.sqrt(0.4 * 0.4 + 0.5 * 0.5), 0.03, ld);
  const f = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03 }); let dSum = 0, dPl = 0, nSep = 0;
  for (const t of ts) { f.components(t, c); if (c.overlap === 0) { dSum = Math.max(dSum, Math.abs(c.total - (c.planet + c.moon - 1))); dPl = Math.max(dPl, Math.abs(c.planet - f0(t))); nSep++; } }
  check('separate discs: blocked flux is the sum of the two', sum === parts && dSum < 3e-16 && dPl === 0, `kernel exactly; light curve ${ex(dSum)} over ${nSep} points (tolerance 3e-16, one rounding)`);
  // switches
  const full = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0.02, phmoon: 0.02 });
  const noMut = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0.02, phmoon: 0.02, mutual: false });
  const noWob = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0.02, phmoon: 0.02, wobble: false });
  const noMoon = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0.02, phmoon: 0.02, moonTransit: false });
  // without the wobble the planet is where a massless moon would leave it; the separation still follows the total mass
  const noWobRef = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0, phmoon: 0.02, amoon: full.geometry.aMoon });
  let dA = 0, dB = 0, dC = 0, dD = 0, sawMut = 0, c2 = {};
  for (const t of ts) {
    full.components(t, c); noMut.components(t, c2);
    if (c.overlap > 0) sawMut++;
    dA = Math.max(dA, Math.abs(c2.total - (c.planet + c.moon - 1)), Math.abs(c.total - (c.planet + c.moon - 1 + c.overlap)));
    dB = Math.max(dB, Math.abs(noWob(t) - noWobRef(t)));
    dC = Math.max(dC, Math.abs(noMoon(t) - c.planet)); dD = Math.max(dD, Math.abs(c.diff - (c.total - f0(t))), Math.abs(c.wobble - (c.planet - f0(t))));
  }
  check('switches isolate the effects', dA < 1e-15 && dB === 0 && dC === 0 && dD === 0 && sawMut > 5,
    `mutual off = plain sum (to ${ex(dA)}, tolerance 1e-15), wobble off = mass ratio 0 at the same separation, moon transit off = planet alone (both exactly); ${sawMut} points of this light curve are in a planet-moon eclipse`);
  const arr = moonComponents(ts, { ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0.02 }); let dArr = 0;
  const fa = makePlanetMoonTransit({ ...PLANET, ...MOON, rmoon: 0.03, mmoon: 0.02 });
  ts.forEach((t, i) => (dArr = Math.max(dArr, Math.abs(arr.total[i] - fa(t)), Math.abs(arr.diff[i] - (arr.total[i] - arr.moonless[i])))));
  check('moonComponents arrays equal the point function', dArr === 0);
}

// ---- 5. the orbit: around the planet, prograde, closed, barycentre on the Keplerian orbit -------------------------
{
  // a/R* from Kepler's law with the moon's mass included, so that both orbits obey it exactly
  const q = 0.05, ARSQ = arsFromKepler(45, 1, 1 + q, 1), p = { ...PLANET, ...MOON, mmoon: q, ars: ARSQ }, el = orbitElements(p), g = moonGeometry(p);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], norm = (a) => Math.sqrt(dot(a, a));
  const rel = (pp, t) => { const M = moonPosition(el, pp, t), P = planetPosition(el, pp, t); return [M[0] - P[0], M[1] - P[1], M[2] - P[2]]; };
  let dClose = 0, dRad = 0, dBary = 0, starMin = Infinity, starMax = 0;
  for (let k = 0; k < 400; k++) {
    const t = p.tmid + 0.37 * k, r1 = rel(p, t), r2 = rel(p, t + p.permoon), M = moonPosition(el, p, t), P = planetPosition(el, p, t), B = orbitPosition(el, t, [0, 0, 0]);
    dClose = Math.max(dClose, norm([r2[0] - r1[0], r2[1] - r1[1], r2[2] - r1[2]])); dRad = Math.max(dRad, Math.abs(norm(r1) - g.aMoon));
    dBary = Math.max(dBary, norm([(P[0] + q * M[0]) / (1 + q) - B[0], (P[1] + q * M[1]) / (1 + q) - B[1], (P[2] + q * M[2]) / (1 + q) - B[2]]));
    starMin = Math.min(starMin, norm(M)); starMax = Math.max(starMax, norm(M));
  }
  check('the moon returns to the same place relative to the planet after one moon period', dClose < 1e-9, `max ${ex(dClose)} R* (tolerance 1e-9)`);
  check('the moon circles the planet, not the star', dRad < 1e-12 && starMax - starMin > 1.8 * g.aMoon * (1 / 1.05) && starMin > ARSQ - 1.01 * g.aMoon,
    `distance to the planet constant at ${g.aMoon.toFixed(4)} R* to ${ex(dRad)}; distance to the star ranges ${starMin.toFixed(3)} to ${starMax.toFixed(3)} R*`);
  check('the barycentre stays on the Keplerian orbit', dBary < 1e-12, `(Mp planet + Mm moon) / (Mp + Mm) = orbitPosition to ${ex(dBary)} R*`);
  // sense of rotation: angular momentum of the moon about the planet against that of the planet about the star
  const h = 1e-4, spin = (pp, t) => { const a = rel(pp, t - h), b = rel(pp, t + h); return cross(rel(pp, t), [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)]); };
  const B0 = orbitPosition(el, p.tmid - h, [0, 0, 0]), B1 = orbitPosition(el, p.tmid + h, [0, 0, 0]), Bc = orbitPosition(el, p.tmid, [0, 0, 0]);
  const Lp = cross(Bc, [(B1[0] - B0[0]) / (2 * h), (B1[1] - B0[1]) / (2 * h), (B1[2] - B0[2]) / (2 * h)]);
  const cosAng = (pp) => { const L = spin(pp, p.tmid + 0.4); return dot(L, Lp) / (norm(L) * norm(Lp)); };
  const cPro = cosAng(p), cRet = cosAng({ ...p, imoon: 180 }), c30 = cosAng({ ...p, imoon: 30 });
  check('prograde by default, in the sense of the planet\'s orbit', Math.abs(cPro - 1) < 1e-9 && Math.abs(cRet + 1) < 1e-9 && Math.abs(c30 - Math.cos(Math.PI / 6)) < 1e-9 && B1[0] > B0[0],
    `cos(angle between the two angular momenta): ${cPro.toFixed(9)} (imoon 0), ${c30.toFixed(6)} (imoon 30), ${cRet.toFixed(9)} (imoon 180); the planet moves toward +X at mid-transit`);
  // phase convention at the planet's mid-transit
  const at = (ph) => rel({ ...p, phmoon: ph }, p.tmid);
  check('phase convention', at(0)[2] > 0.99 * g.aMoon && Math.abs(at(0)[0]) < 1e-12 && at(0.25)[0] > 0.999 * g.aMoon && at(0.5)[2] < -0.99 * g.aMoon && at(0.75)[0] < -0.999 * g.aMoon,
    'phmoon 0: in front of the planet; 0.25: ahead of it (+X, transits first); 0.5: behind; 0.75: trailing');
  // separation from Kepler's third law, in SI, and the validity limits
  const aSI = Math.cbrt((C.GMsun * C.Mjup_Msun * (1 + q) * (p.permoon * C.day) ** 2) / (4 * Math.PI ** 2)) / C.Rsun;
  check('separation from the moon\'s period and the planet\'s mass', Math.abs(g.aMoon / aSI - 1) < 1e-12 && Math.abs(moonPeriodFor(g.aMoon, p) / p.permoon - 1) < 1e-12 && g.mode === 'kepler',
    `${g.aMoon.toFixed(5)} R* = (G (Mp + Mm) P²/4π²)^(1/3) / R* to ${ex(Math.abs(g.aMoon / aSI - 1))}; with amoonrp = 8: ${moonGeometry({ ...p, amoonrp: 8 }).aMoon.toFixed(3)} R*, amoon = 0.7: ${moonGeometry({ ...p, amoon: 0.7 }).aMoon} R*`);
  const hillSI = ARSQ * Math.cbrt((C.Mjup_Msun * (1 + q)) / 3), lim = moonGeometry({ ...p, permoon: g.maxPeriod });
  check('Hill sphere, stability and Roche limits', Math.abs(g.hill / hillSI - 1) < 1e-12 && g.ok && Math.abs(lim.hillFrac - 0.4895) < 1e-9 && Math.abs(g.maxPeriod / 45 - 0.1977) < 2e-4 &&
    !moonGeometry({ ...p, permoon: 9.5 }).stable && moonGeometry({ ...p, permoon: 9.5 }).bound && moonGeometry({ ...p, permoon: 9.5, imoon: 180 }).stable && !moonGeometry({ ...p, permoon: 30 }).bound &&
    !moonGeometry({ ...p, mmoon: 0, permoon: 0.3 }).outsideRoche && moonGeometry({ ...p, mmoon: 0, permoon: 0.3 }).clear && !moonGeometry({ ...p, permoon: 0.05 }).clear && !makePlanetMoonTransit({ ...p, permoon: 0.05 }).ok && !makePlanetMoonTransit({ ...PLANET, ...MOON, mplanet: undefined }).ok,
    `Hill radius ${g.hill.toFixed(3)} R*, moon at ${g.hillFrac.toFixed(3)} of it; longest stable prograde period ${g.maxPeriod.toFixed(2)} d = ${(g.maxPeriod / 45).toFixed(4)} P (Domingos et al. 2006: 0.4895 Hill radii); fluid Roche limit ${moonGeometry({ ...p, mmoon: 0 }).rocheRp.toFixed(2)} planet radii for equal densities, ${g.rocheRp.toFixed(2)} for this moon (Mm/Mp 0.05 in a radius of 0.15 Rp)`);
  const ring = moonOrbitPath(el, p, p.tmid + 3, 64), Mn = moonPosition(el, p, p.tmid + 3), Pn = planetPosition(el, p, p.tmid + 3); let dRing = Infinity, rRing = 0;
  for (let i = 0; i < 64; i++) { dRing = Math.min(dRing, Math.hypot(ring[3 * i] - Mn[0], ring[3 * i + 1] - Mn[1], ring[3 * i + 2] - Mn[2])); rRing = Math.max(rRing, Math.abs(Math.hypot(ring[3 * i] - Pn[0], ring[3 * i + 1] - Pn[1], ring[3 * i + 2] - Pn[2]) - g.aMoon)); }
  check('moonOrbitPath is the ring around the planet that the moon is on', rRing < 1e-5 && dRing < g.aMoon * 0.05, `radius error ${ex(rRing)} R* (float32), moon ${dRing.toFixed(4)} R* from the nearest of 64 ring points`);
  const v = { rmoon: 0.02, permoon: 2, 'rmoon@c': 0.01, 'permoon@c': 1.5, 'phmoon@c': 0.3 };
  check('parameter keys carry the planet scope', moonKey('rmoon', '') === 'rmoon' && moonKey('rmoon', 'c') === 'rmoon@c' && moonParamsFrom(v, 'c').rmoon === 0.01 && moonParamsFrom(v, 'c').phmoon === 0.3 && moonParamsFrom(v, 'd') === null && moonParamsFrom(v).permoon === 2 &&
    MOON_FIELDS.join() === 'rmoon,permoon,phmoon,mmoon,imoon,amoon' && MOON_PARAMS.every((m) => m.label && m.help && m.max > m.min && m.prior && Number.isFinite(m.step)));
}

// ---- 6. transit timing and duration variations against Kipping (2009) -------------------------------------------
{
  const p = { ...PLANET, ...MOON, mmoon: 0.02, phmoon: 0.31 }, A = ttvTdvAmplitudes(p), E = Array.from({ length: 60 }, (_, i) => i), tm = moonTimings(p, E);
  // Kipping's closed forms for circular orbits, written out independently of ttvTdvAmplitudes
  const g = moonGeometry(p), aw = (g.aMoon * 0.02) / 1.02, ttvK = (aw * 45) / (2 * Math.PI * ARS), tbar = (45 / Math.PI) * Math.asin(Math.sqrt(1 - 0.09) / (ARS * Math.sin((INC * Math.PI) / 180))), tdvK = (tbar * aw * 45) / (ARS * p.permoon);
  check('analytic amplitudes are Kipping\'s formulas', Math.abs(A.ttv / ttvK - 1) < 1e-12 && Math.abs(A.tdv / tdvK - 1) < 1e-9 && Math.abs(A.ratio - (2 * Math.PI * tbar) / p.permoon) < 1e-9,
    `TTV peak a_w P / (2π a) = ${(A.ttv * 1440).toFixed(3)} min (rms ${(A.ttvRms * 1440).toFixed(3)}), TDV peak T̄ a_w P / (a P_m) = ${(A.tdv * 1440).toFixed(3)} min (rms ${(A.tdvRms * 1440).toFixed(3)}), T̄ = ${(tbar * 24).toFixed(3)} h`);
  let dT = 0, dD = 0, pkT = 0, pkD = 0, sTT = 0, sTD = 0;
  E.forEach((_, i) => {
    const th = tm.theta[i];
    dT = Math.max(dT, Math.abs(tm.ttv[i] + A.ttv * Math.cos(th))); dD = Math.max(dD, Math.abs(tm.tdv[i] - A.tdv * Math.sin(th)));
    pkT = Math.max(pkT, Math.abs(tm.ttv[i])); pkD = Math.max(pkD, Math.abs(tm.tdv[i])); sTT += tm.ttv[i] ** 2; sTD += tm.tdv[i] ** 2;
  });
  check('measured transit times follow -TTV cos(theta)', dT < 0.03 * A.ttv, `60 transits: largest deviation ${(dT / A.ttv * 100).toFixed(2)}% of the amplitude (tolerance 3%: the moon moves during the transit); peak ${(pkT * 1440).toFixed(3)} min, rms ${(Math.sqrt(sTT / 60) * 1440).toFixed(3)} min`);
  check('measured durations follow +TDV sin(theta)', dD < 0.06 * A.tdv, `largest deviation ${(dD / A.tdv * 100).toFixed(2)}% of the amplitude (tolerance 6%: second order in the velocity ratio, and the planet's path is displaced in Y); peak ${(pkD * 1440).toFixed(3)} min, rms ${(Math.sqrt(sTD / 60) * 1440).toFixed(3)} min`);
  const off = moonTimings({ ...p, wobble: false }, [0, 1, 2]);
  check('no wobble, no variations', Math.max(...off.ttv.map(Math.abs), ...off.tdv.map(Math.abs)) < 1e-12 && ttvTdvAmplitudes({ ...p, mmoon: 0 }).ttv === 0);
}

// ---- 7. search, fit and false alarms ------------------------------------------------------------------------------
const NT = 20, NPER = 300, HALF = 0.75, SIG = 200e-6;
const times = new Float64Array(NT * NPER);
for (let j = 0; j < NT; j++) for (let i = 0; i < NPER; i++) times[j * NPER + i] = PLANET.tmid + j * PLANET.per - HALF + (2 * HALF * (i + 0.5)) / NPER;
const errs = new Float64Array(times.length).fill(SIG);
const simulate = (params, seed) => { const f = makePlanetMoonTransit(params), rng = makeRng(seed); return Float64Array.from(times, (t) => f(t) + SIG * rng.normal()); };
// the planet-only fit a user would have before looking for a moon: radius ratio and mid-time by golden section, twice over
function fitPlanet(flux) {
  const chi = (q) => { const f = makeTransit(q); let s = 0; for (let i = 0; i < times.length; i++) { const r = (flux[i] - f(times[i])) / SIG; s += r * r; } return s; };
  const golden = (fn, a, b) => { const g = 0.6180339887; let c = b - g * (b - a), d = a + g * (b - a), fc = fn(c), fd = fn(d); for (let k = 0; k < 40; k++) { if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = fn(c); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = fn(d); } } return 0.5 * (a + b); };
  let q = { ...PLANET };
  for (let it = 0; it < 2; it++) { q.rprs = golden((x) => chi({ ...q, rprs: x }), 0.09, 0.11); q.tmid = golden((x) => chi({ ...q, tmid: x }), PLANET.tmid - 0.01, PLANET.tmid + 0.01); }
  return q;
}
{
  // speed of one light-curve evaluation
  const f = makePlanetMoonTransit({ ...PLANET, ...MOON }), f0 = makeTransit(PLANET), fw = makePlanetMoonTransit({ ...PLANET, ...MOON, mmoon: 0.02, ecc: 0.2, omega: 30 });
  const time = (fn) => { let s = 0; const t0 = performance.now(); for (let k = 0; k < 40; k++) for (let i = 0; i < times.length; i++) s += fn(times[i]); return ((performance.now() - t0) * 1000) / (40 * times.length); };
  time(f); const us = time(f), us0 = time(f0), usE = time(fw);
  check('speed', us < 2, `${us.toFixed(3)} µs per point for planet + moon on this light curve (${(us * times.length / 1000).toFixed(2)} ms for ${times.length} points); the moonless planet ${us0.toFixed(3)}; eccentric with wobble ${usE.toFixed(3)} (one core; bound 2)`);
}
let detected = null;
{
  const flux = simulate({ ...PLANET, ...MOON }, 5), pl = fitPlanet(flux);
  const r = moonSearch({ t: times, f: flux, e: errs }, pl, { nNull: 100, seed: 9 }), b = r.best;
  const q95 = Float64Array.from(r.nullMax).sort()[Math.floor(0.95 * r.nullMax.length)], nullTop = Math.max(...r.nullMax);
  check('search finds the injected moon', Math.abs(b.permoon / MOON.permoon - 1) < 2e-3 && Math.abs(wrap(b.phmoon - MOON.phmoon + 0.5) - 0.5) < 0.03 && Math.abs(b.rmoon / MOON.rmoon - 1) < 0.1 && b.snr > 2 * nullTop && r.fap === 1 / 101,
    `injected Rm/R* ${MOON.rmoon}, P ${MOON.permoon} d, phase ${MOON.phmoon}; found ${b.rmoon.toFixed(4)}, ${b.permoon.toFixed(4)} d, ${b.phmoon.toFixed(3)} at S/N ${b.snr.toFixed(1)} (Δχ² ${b.dchi2.toFixed(0)}); ` +
    `100 noise-only searches reach at most ${nullTop.toFixed(2)} (95% below ${q95.toFixed(2)}), false-alarm probability < ${r.fap.toFixed(4)}; tolerances 0.2% in period, 0.03 in phase, 10% in radius; planet refitted first: Rp/R* ${pl.rprs.toFixed(5)}; strongest peaks ${r.peaks.slice(0, 4).map((q) => `${q.permoon.toFixed(3)} d (${q.snr.toFixed(1)})`).join(', ')}`);
  check('search is fast enough for the browser', r.ms < 20000, `${NT} transits of ${NPER} points, ${r.periods.length} periods × ${r.phases.length} phases: ${moonSearch({ t: times, f: flux, e: errs }, pl).ms.toFixed(0)} ms, and ${r.ms.toFixed(0)} ms with 100 noise realisations searched alongside`);
  detected = { flux, pl, best: b, q95, nullMax: r.nullMax };
  // orbital sampling effect: the stacked residuals from the planet-only model follow the phase-averaged moon
  const st = oseStack({ t: times, f: flux, e: errs }, PLANET, { nbins: 30 }), mod = oseModel({ ...PLANET, ...MOON }, st.x, 96);
  let chi = 0, chi0 = 0; st.x.forEach((_, i) => { chi += ((st.y[i] - mod[i]) / st.e[i]) ** 2; chi0 += (st.y[i] / st.e[i]) ** 2; });
  check('orbital sampling effect stack shows the moon\'s average dimming', chi0 - chi > 100 && chi / st.x.length < 3,
    `residuals from the true planet model in 30 bins: χ² ${chi0.toFixed(0)} against no moon, ${chi.toFixed(0)} against the phase-averaged moon model (bound 3 per bin: 20 transits sample the moon's phases unevenly)`);
}
{
  // nested-sampling fit of the moon and the planet's size, priors around the search result.
  // fitRunner.runFit() builds its likelihood with buildProblem (model.js) and takes no other, so the same sampler
  // (MiniNest) is driven here the way runFit drives it, on a likelihood local to this test.
  const { flux, best } = detected, keys = ['rmoon', 'permoon', 'phmoon', 'rprs'];
  const priors = [{ type: 'uniform', a: 0, b: 0.05 }, { type: 'uniform', a: best.permoon * 0.995, b: best.permoon * 1.005 }, { type: 'uniform', a: best.phmoon - 0.1, b: best.phmoon + 0.1 }, { type: 'uniform', a: 0.09, b: 0.11 }];
  const tf = priors.map(makeTransform), base = { ...PLANET };
  const loglike = (th) => {
    const f = makePlanetMoonTransit({ ...base, rmoon: th[0], permoon: th[1], phmoon: th[2], rprs: th[3], mmoon: 0 });
    if (!f.ok) return -1e100;
    let s = 0; for (let i = 0; i < times.length; i++) { const r = (flux[i] - f(times[i])) / SIG; s += r * r; }
    return -0.5 * s;
  };
  const t0 = performance.now(), ns = new MiniNest({ ndim: 4, loglike, transform: (u, x) => { for (let i = 0; i < 4; i++) x[i] = tf[i](u[i]); }, nlive: 200, seed: 42, names: keys });
  while (!ns.done) ns.step(25);
  const res = ns.result(), sec = (performance.now() - t0) / 1000, truth = [MOON.rmoon, MOON.permoon, MOON.phmoon, PLANET.rprs];
  const qs = keys.map((_, k) => weightedQuantiles(Float64Array.from({ length: res.n }, (_, i) => res.samples[i * 4 + k]), res.weights, [0.1587, 0.5, 0.8413]));
  const pulls = qs.map((q, k) => (q[1] - truth[k]) / (0.5 * (q[2] - q[0])));
  const lnL0 = loglike([0, best.permoon, best.phmoon, detected.pl.rprs]);
  check('nested-sampling fit recovers the injected radius and period', res.converged && pulls.every((z) => Math.abs(z) < 3) && Math.abs(qs[0][1] / MOON.rmoon - 1) < 0.05 && Math.abs(qs[1][1] / MOON.permoon - 1) < 2e-4 && res.maxLogL - lnL0 > 300,
    `Rm/R* ${qs[0][1].toFixed(5)} +${(qs[0][2] - qs[0][1]).toFixed(5)} -${(qs[0][1] - qs[0][0]).toFixed(5)} (injected ${MOON.rmoon}), P moon ${qs[1][1].toFixed(5)} ± ${(0.5 * (qs[1][2] - qs[1][0])).toFixed(5)} d (${MOON.permoon}), ` +
    `phase ${qs[2][1].toFixed(4)} ± ${(0.5 * (qs[2][2] - qs[2][0])).toFixed(4)} (${MOON.phmoon}), Rp/R* ${qs[3][1].toFixed(5)} ± ${(0.5 * (qs[3][2] - qs[3][0])).toFixed(5)} (${PLANET.rprs}); pulls ${pulls.map((z) => z.toFixed(2)).join(', ')} (tolerance 3σ each, 5% in radius, 0.02% in period); ` +
    `Δ ln L over no moon ${(res.maxLogL - lnL0).toFixed(0)}; ${res.ncalls} likelihood calls, ${sec.toFixed(1)} s`);
}
{
  // false alarms: moonless light curves, the planet refitted, searched the same way
  const N = 40; let over = 0, top = 0; const snrs = [];
  for (let k = 0; k < N; k++) {
    const flux = simulate(PLANET, 1000 + k), r = moonSearch({ t: times, f: flux, e: errs }, fitPlanet(flux));
    snrs.push(r.best.snr); if (r.best.snr > detected.q95) over++; top = Math.max(top, r.best.snr);
  }
  snrs.sort((a, b) => a - b);
  const nullMed = Float64Array.from(detected.nullMax).sort()[50];
  check('moonless data: no false alarm', over <= 6 && top < 6 && Math.abs(snrs[20] - nullMed) < 0.35,
    `${N} moonless light curves: best S/N median ${snrs[20].toFixed(2)}, largest ${top.toFixed(2)} (the injected moon: ${detected.best.snr.toFixed(1)}); ${over} of ${N} exceed the 95% level of the noise-only searches (${detected.q95.toFixed(2)}; expected 2, tolerance 6); ` +
    `median of the noise-only searches ${nullMed.toFixed(2)} (tolerance 0.35 between the two); none reaches S/N 6`);
}

// ---- 8. the worked example ----------------------------------------------------------------------------------------
{
  const dir = new URL('../public/examples/exomoon/', import.meta.url);
  if (existsSync(new URL('session.json', dir))) {
    const s = JSON.parse(readFileSync(new URL('session.json', dir))); let loads = true, why = '';
    try { validateSession(s); } catch (e) { loads = false; why = e.message; }
    const v = valuesFromSession(s), spec = specFromSession(s), prob = buildProblem(spec), mp = moonParamsFrom(v, '', { mplanet: v.mplanet, mstar: v.mstar });
    const lnPlanet = prob.loglike(Float64Array.from(spec.free.map((p) => v[p.key])));
    // the moon model on the session's data, with the truth stored in the session
    const tp = { rprs: v.rprs, ars: prob.detail(Float64Array.from(spec.free.map((p) => v[p.key]))).planets[0].ars, inc: v.inc, per: v.per, tmid: v.tmid, ecc: v.ecc || 0, omega: v.omega || 0, ldLaw: spec.ldLaw, ld: [v.ld0, v.ld1] };
    const f = makePlanetMoonTransit({ ...tp, ...mp }), cmp = moonComponents(spec.data.t, { ...tp, ...mp }, { exptime: spec.exptime, supersample: 7 }); let c1 = 0, c0 = 0;
    for (let i = 0; i < spec.data.t.length; i++) { c1 += ((spec.data.f[i] - cmp.total[i]) / spec.data.e[i]) ** 2; c0 += ((spec.data.f[i] - cmp.moonless[i]) / spec.data.e[i]) ** 2; }
    const sr = moonSearch(spec.data, { ...tp, mplanet: v.mplanet, mstar: v.mstar }), tr = s.truth.moon, al = sr.peaks.slice(0, 3).map((q) => `${q.permoon.toFixed(3)} d (${q.snr.toFixed(1)})`).join(', ');
    const csv = readFileSync(new URL('lightcurve.csv', dir), 'utf8').trim().split('\n');
    check('worked example: session loads, the moon is in the planet\'s parameters', loads && mp && mp.rmoon > 0 && f.ok && f.geometry.ok && Number.isFinite(lnPlanet) && csv.length - 1 === spec.data.t.length, why ||
      `${spec.data.t.length} points; χ² ${c1.toFixed(0)} with the injected moon, ${c0.toFixed(0)} without (Δχ² ${(c0 - c1).toFixed(0)}); buildProblem evaluates the session as a moonless fit today`);
    check('worked example: the injected moon fits its data', Math.abs(c1 / spec.data.t.length - 1) < 0.1 && c0 - c1 > 200);
    // the wobble is in these data (Mm/Mp 0.02) and not in the search's templates, so the phase tolerance is wider than in the test above
    check('worked example: the search finds its moon', Math.abs(sr.best.permoon / tr.permoon - 1) < 2e-3 && Math.abs(sr.best.rmoon / tr.rmoon - 1) < 0.1 && Math.abs(wrap(sr.best.phmoon - tr.phmoon + 0.5) - 0.5) < 0.05 && sr.best.snr > 15,
      `P ${sr.best.permoon.toFixed(4)} d (injected ${tr.permoon}), Rm/R* ${sr.best.rmoon.toFixed(4)} (${tr.rmoon}), phase ${sr.best.phmoon.toFixed(3)} (${tr.phmoon}), S/N ${sr.best.snr.toFixed(1)}; strongest peaks ${al}: the aliases 1/P ± k/${v.per} d are nearly as high`);
  } else check('worked example present', false, 'public/examples/exomoon/session.json is missing');
}
process.exit(ok ? 0 : 1);
