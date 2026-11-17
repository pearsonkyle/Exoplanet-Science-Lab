// The brightest asteroids, offline: osculating elements from the JPL Small-Body Database (SBDB API, orbit solutions
// as of 2026-11-16, epoch JD 2461200.5 TDB = 2026-06-09.0, ecliptic and equinox J2000) propagated as two-body
// Keplerian orbits about the Sun. Positions are geocentric, astrometric (light time, no aberration) in J2000, or
// topocentric of date for the sky view. No DOM: test/asteroids.test.mjs compares them with JPL Horizons
// (test/asteroid_reference.json, made by test/make_asteroid_reference.py).
//
// Two-body orbits drift from the real ones (Jupiter's perturbations, mostly): against Horizons the error is at most
// 56" within 200 days of the epoch and 138" a year after it (Hygiea; the others under 40"), growing beyond. For a path on the sky
// over nights or months that is far below what the eye or the drawing can see; for pointing a telescope at a faint
// asteroid years from the epoch, refresh the elements (the reference script prints them).
// Magnitudes: the IAU H, G system (Bowell et al. 1989, in Asteroids II, p. 524), with H and G from SBDB.
import * as A from './astro.js';

const { RAD, DEG } = A;
/** GM of the Sun in au^3 / d^2 (the Gaussian constant squared); an asteroid's own mass is negligible. */
const K2 = 0.01720209895 ** 2;
export const ELEMENTS_SOURCE = 'JPL Small-Body Database (ssd-api.jpl.nasa.gov/sbdb.api), osculating elements at epoch JD 2461200.5 TDB (2026-06-09), ecliptic J2000; H and G from the same database';
export const ELEMENTS_EPOCH = 2461200.5;
// [name, epoch JD TDB, a au, e, i deg, node deg, arg. of perihelion deg, mean anomaly deg, mean motion deg/d, H, G]
const ROWS = [
  ['Ceres', 2461200.5, 2.765552595034094, 0.07969229514816586, 10.58802780183462, 80.24862682043221, 73.29421453021587, 274.4193463761342, 0.21430445064843, 3.34, 0.12],
  ['Pallas', 2461200.5, 2.769559010737709, 0.2307000995648547, 34.93279321851542, 172.8866193357694, 310.9699161652136, 254.2496521742734, 0.2138396029251949, 4.12, 0.11],
  ['Juno', 2461200.5, 2.670989527103278, 0.2556999836681878, 12.98659236598085, 169.8115953492418, 247.8950743075613, 262.7322944883855, 0.2257853690721904, 5.19, 0.32],
  ['Vesta', 2461200.5, 2.361365965127599, 0.09020374382834395, 7.143925545058711, 103.701293265032, 151.4686478221564, 81.19015607686903, 0.2716183613599909, 3.25, 0.32],
  ['Hebe', 2461200.5, 2.425661373187056, 0.2022549972879026, 14.73627701122621, 138.6133210652024, 239.7304536745098, 44.72118803216504, 0.2608908304711669, 5.62, 0.24],
  ['Iris', 2461200.5, 2.385746302646938, 0.2302746853668762, 5.518567726455019, 259.4851402183693, 145.4071283819921, 115.2916674478007, 0.2674654469109276, 5.7, 0.15],
  ['Hygiea', 2461200.5, 3.150974033963701, 0.1067092741240963, 3.829529946447122, 283.1198927508594, 312.4242387344704, 252.0344242359649, 0.1762125505792448, 5.65, 0.15],
  ['Eunomia', 2461200.5, 2.641958730730434, 0.1877707677912555, 11.76139314431215, 292.8807830122993, 98.46131825798194, 159.6891049210672, 0.2295170904959873, 5.42, 0.23],
];
const NUMBERS = { Ceres: 1, Pallas: 2, Juno: 3, Vesta: 4, Hebe: 6, Iris: 7, Hygiea: 10, Eunomia: 15 };
export const ASTEROIDS = ROWS.map(([name, epoch, a, e, i, node, peri, M, n, H, G]) => ({ id: name.toLowerCase(), name, number: NUMBERS[name], epoch, a, e, i, node, peri, M, n, H, G }));
const byId = Object.fromEntries(ASTEROIDS.map((o) => [o.id, o]));
export const asteroidById = (id) => byId[String(id).toLowerCase()] || null;

const EPS = 23.43928 * RAD;     // obliquity of J2000 (IAU 1976 value 84381.448"), as in astro.js
/** Heliocentric J2000 equatorial position (au) of an asteroid at a TDB Julian date: two-body Kepler orbit. */
export function heliocentricAt(o, jdTdb) {
  if (!(o.e < 1)) throw new Error('only elliptic orbits');
  const M = (o.M + o.n * (jdTdb - o.epoch)) * RAD, E = A.solveKepler(M, o.e);
  const xp = o.a * (Math.cos(E) - o.e), yp = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  const w = o.peri * RAD, Om = o.node * RAD, I = o.i * RAD, cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = sw * sI * xp + cw * sI * yp;
  return [x, y * Math.cos(EPS) - z * Math.sin(EPS), y * Math.sin(EPS) + z * Math.cos(EPS)];
}
/** The mean motion that Kepler's third law gives for the semi-major axis (deg/d): a check on the elements. */
export const keplerMeanMotion = (a) => Math.sqrt(K2 / (a * a * a)) * DEG;

/** H, G magnitude (Bowell et al. 1989): r, delta in au, phase angle in radians. */
export function hgMagnitude(H, G, r, delta, phase) {
  const t = Math.tan(phase / 2), p1 = Math.exp(-3.33 * t ** 0.63), p2 = Math.exp(-1.87 * t ** 1.22);
  return H + 5 * Math.log10(r * delta) - 2.5 * Math.log10((1 - G) * p1 + G * p2);
}

/**
 * Geocentric astrometric place at a Unix time (UTC ms): { ra, dec (radians, J2000), delta, r (au), phase (rad),
 * mag }. Light time is iterated; the Earth is astro.js's (Standish elements and the Moon's share of the barycentre).
 */
export function asteroidGeocentric(o, ms) {
  const T = A.centuriesTT(ms), jd = T * 36525 + 2451545.0, e = A.earthHeliocentric(T);
  let tau = 0, p, g;
  for (let k = 0; k < 3; k++) { p = heliocentricAt(o, jd - tau); g = [p[0] - e[0], p[1] - e[1], p[2] - e[2]]; tau = Math.hypot(...g) / A.C_AU_PER_DAY; }
  const s = A.vecToSph(g), r = Math.hypot(...p), R = Math.hypot(...e);
  const phase = Math.acos(Math.max(-1, Math.min(1, (r * r + s.r * s.r - R * R) / (2 * r * s.r))));
  return { ra: s.lon, dec: s.lat, delta: s.r, r, phase, mag: hgMagnitude(o.H, o.G, r, s.r, phase) };
}

/**
 * As the sky view needs it, like a planet of astro.solarSystem: topocentric RA and Dec of date, airless altitude
 * and azimuth, magnitude. lat, lon in radians.
 */
export function asteroidPlace(o, ms, lat, lon, heightM = 0) {
  const g = asteroidGeocentric(o, ms), T = A.centuriesTT(ms), lst = A.localSiderealTime(ms, lon);
  const d = A.vecToSph(A.matVec(A.j2000ToDateMatrix(T), A.sphToVec(g.ra, g.dec)));
  const t = A.topocentric(d.lon, d.lat, g.delta * A.AU_KM, lat, lst, heightM), h = A.equatorialToHorizontal(t.ra, t.dec, lat, lst);
  return { id: o.id, name: o.name, ra: t.ra, dec: t.dec, raJ2000: g.ra, decJ2000: g.dec, alt: h.alt, az: h.az, dist: g.delta, r: g.r, phase: g.phase, mag: g.mag };
}
