// Positional astronomy for the sky view: time scales, sidereal time, precession and nutation, coordinate
// changes, refraction, and low-precision positions of the Sun, Moon and planets. No DOM, no three.js.
//
// Conventions
//   angles in radians unless a name ends in Deg; time as Unix milliseconds (UTC) or Julian centuries T of TT from J2000
//   equatorial vectors: x to the equinox, z to the pole; "of date" = true equator and equinox of date
//   horizontal vectors: [east, north, up]; azimuth from north through east; longitude east positive
//   UT1 is taken equal to UTC (|UT1 - UTC| < 0.9 s, i.e. < 13.5" of sidereal time)
//
// What each series claims, and what test/astro.test.mjs measures against astropy/ERFA with the JPL DE432s
// ephemeris, 1975-2050 (run `node test/astro.test.mjs` for the current numbers):
//   sidereal time    IAU 1982 GMST + 4-term nutation (Meeus, Astronomical Algorithms, ch. 12, 22)
//   precession       IAU 1976 angles (Meeus ch. 21); no frame bias (17 mas)
//   Sun              Meeus ch. 25 "low accuracy" (claimed 0.01 deg)
//   Moon             the larger periodic terms of Meeus ch. 47 (ELP-2000/82 truncated; full table claims 10" in longitude)
//   planets          Keplerian elements of E. M. Standish, "Keplerian Elements for Approximate Positions of the
//                    Major Planets" (JPL Solar System Dynamics), table 1, valid 1800-2050. Claimed errors in
//                    heliocentric longitude: Mercury 15", Venus 20", Earth-Moon 20", Mars 40", Jupiter 400",
//                    Saturn 600", Uranus 50", Neptune 10".
//   refraction       Bennett (1982) / Saemundsson (1986), 1010 hPa and 10 C unless scaled
//   a night         twilight times by bisection on the Sun's altitude; rising, culmination and setting of a fixed
//                    J2000 position from its hour angle (nightOf, fixedRiseSet, trackFixed). Against astropy:
//                    see the "a target through a night" block of the test.
// Not modelled: stellar proper motion and parallax, annual aberration of stars (20"), polar motion, UT1-UTC.

import { ttMinusUtc as ttMinusUtcJd } from './timescale.js';

export const RAD = Math.PI / 180, DEG = 180 / Math.PI, TAU = 2 * Math.PI, ASEC = RAD / 3600;
export const AU_KM = 149597870.7, EARTH_RADIUS_KM = 6378.137, C_AU_PER_DAY = 173.1446327;
const { sin, cos, tan, atan2, asin, acos, sqrt, abs, floor, PI } = Math;
const mod = (x, m) => ((x % m) + m) % m;
export const wrap2pi = (x) => mod(x, TAU);
export const wrapPi = (x) => mod(x + PI, TAU) - PI;

// ---------------------------------------------------------------- time
/** Julian date (UTC) of a Unix time in milliseconds. */
export const julianDate = (ms) => ms / 86400000 + 2440587.5;
export const fromJulianDate = (jd) => (jd - 2440587.5) * 86400000;

/** TT - UTC in seconds for a Unix time in ms: 32.184 + leap seconds (the table is in timescale.js; 42.184 before 1972). */
export const ttMinusUtc = (ms) => ttMinusUtcJd(julianDate(ms));
/** Julian centuries of TT since J2000.0 for a Unix time in ms. */
export const centuriesTT = (ms) => (julianDate(ms) + ttMinusUtc(ms) / 86400 - 2451545.0) / 36525;

/** Greenwich mean sidereal time (IAU 1982) for a Julian date of UT1. */
export function gmst(jdUT) {
  const d = jdUT - 2451545.0, T = d / 36525;
  return wrap2pi((280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000) * RAD);
}

/** Nutation in longitude and obliquity (four largest terms, about 0.5") and the obliquity of the ecliptic. */
export function nutation(T) {
  const Om = (125.04452 - 1934.136261 * T) * RAD, L = (280.4665 + 36000.7698 * T) * RAD, Lm = (218.3165 + 481267.8813 * T) * RAD;
  const dpsi = (-17.20 * sin(Om) - 1.32 * sin(2 * L) - 0.23 * sin(2 * Lm) + 0.21 * sin(2 * Om)) * ASEC;
  const deps = (9.20 * cos(Om) + 0.57 * cos(2 * L) + 0.10 * cos(2 * Lm) - 0.09 * cos(2 * Om)) * ASEC;
  const eps0 = (84381.448 - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ASEC;
  return { dpsi, deps, eps0, eps: eps0 + deps };
}

/** Greenwich apparent sidereal time: GMST plus the equation of the equinoxes. T defaults to UT-based centuries. */
export function gast(jdUT, T = (jdUT - 2451545.0) / 36525) {
  const n = nutation(T);
  return wrap2pi(gmst(jdUT) + n.dpsi * cos(n.eps));
}
/** Local apparent sidereal time for a Unix time and an east longitude in radians. */
export const localSiderealTime = (ms, lon) => wrap2pi(gast(julianDate(ms), centuriesTT(ms)) + lon);

// ---------------------------------------------------------------- 3x3 matrices (row-major arrays of 9) and vectors
export const matMul = (a, b) => { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]; return o; };
export const matVec = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export const sphToVec = (lon, lat) => [cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)];
export const vecToSph = (v) => { const r = Math.hypot(v[0], v[1], v[2]); return { lon: wrap2pi(atan2(v[1], v[0])), lat: asin(Math.max(-1, Math.min(1, v[2] / r))), r }; };
/** Angle between two directions given as longitude, latitude pairs. */
export function separation(lon1, lat1, lon2, lat2) {
  const a = sphToVec(lon1, lat1), b = sphToVec(lon2, lat2);
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return atan2(Math.hypot(c[0], c[1], c[2]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

/** Precession matrix from the mean equator and equinox of J2000 to those of date (IAU 1976). */
export function precessionMatrix(T) {
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ASEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ASEC;
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ASEC;
  const cz = cos(zeta), sz = sin(zeta), cZ = cos(z), sZ = sin(z), ct = cos(th), st = sin(th);
  return [cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
    cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
    cz * st, -sz * st, ct];
}
/** Nutation matrix from the mean to the true equator and equinox of date. */
export function nutationMatrix(T) {
  const { dpsi, eps0, eps } = nutation(T);
  const cp = cos(dpsi), sp = sin(dpsi), ce = cos(eps0), se = sin(eps0), ct = cos(eps), st = sin(eps);
  return [cp, -sp * ce, -sp * se,
    sp * ct, cp * ct * ce + st * se, cp * ct * se - st * ce,
    sp * st, cp * st * ce - ct * se, cp * st * se + ct * ce];
}
/** J2000 (ICRS to 17 mas) to true equator and equinox of date. */
export const j2000ToDateMatrix = (T) => matMul(nutationMatrix(T), precessionMatrix(T));

/** Right ascension and declination of date for J2000 coordinates. */
export function precess(ra, dec, T) {
  const s = vecToSph(matVec(j2000ToDateMatrix(T), sphToVec(ra, dec)));
  return { ra: s.lon, dec: s.lat };
}

// ---------------------------------------------------------------- equatorial <-> horizontal
/** Matrix taking an equatorial-of-date unit vector to [east, north, up] for latitude and local sidereal time. */
export function equatorialToHorizontalMatrix(lat, lst) {
  const sl = sin(lat), cl = cos(lat), ss = sin(lst), cs = cos(lst);
  return [-ss, cs, 0, -sl * cs, -sl * ss, cl, cl * cs, cl * ss, sl];
}
export function equatorialToHorizontal(ra, dec, lat, lst) {
  const H = lst - ra, sd = sin(dec), cd = cos(dec), sl = sin(lat), cl = cos(lat);
  const e = -cd * sin(H), n = sd * cl - cd * cos(H) * sl, u = sd * sl + cd * cos(H) * cl;
  return { alt: asin(Math.max(-1, Math.min(1, u))), az: wrap2pi(atan2(e, n)) };
}
export function horizontalToEquatorial(alt, az, lat, lst) {
  const sa = sin(alt), ca = cos(alt), sl = sin(lat), cl = cos(lat);
  const dec = asin(Math.max(-1, Math.min(1, sa * sl + ca * cl * cos(az))));
  const H = atan2(-ca * sin(az), sa * cl - ca * sl * cos(az));
  return { ra: wrap2pi(lst - H), dec };
}

// ---------------------------------------------------------------- refraction
const refScale = (pressure, tempC) => (pressure / 1010) * (283 / (273 + tempC));
/** Refraction to add to a true (airless) altitude: Saemundsson's formula. Returns 0 well below the horizon. */
export function refraction(altTrue, pressure = 1010, tempC = 10) {
  const h = altTrue * DEG;
  if (h < -2) return 0;
  return refScale(pressure, tempC) * (1.02 / tan((h + 10.3 / (h + 5.11)) * RAD)) / 60 * RAD;
}
/** Refraction to subtract from an apparent (observed) altitude: Bennett's formula. */
export function refractionFromApparent(altApparent, pressure = 1010, tempC = 10) {
  const h = altApparent * DEG;
  if (h < -1) return 0;
  return refScale(pressure, tempC) * (1 / tan((h + 7.31 / (h + 4.4)) * RAD)) / 60 * RAD;
}

// ---------------------------------------------------------------- Sun
/** Geocentric apparent position of the Sun, true equator and equinox of date. dist in AU. */
export function sunPosition(T) {
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * RAD;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  const nu = M + C * RAD, dist = 1.000001018 * (1 - e * e) / (1 + e * cos(nu));
  const n = nutation(T);
  const lon = wrap2pi((L0 + C) * RAD - 20.4898 * ASEC / dist + n.dpsi);   // aberration, nutation
  const ra = wrap2pi(atan2(cos(n.eps) * sin(lon), cos(lon))), dec = asin(sin(n.eps) * sin(lon));
  return { ra, dec, dist, lon, lat: 0 };
}

// ---------------------------------------------------------------- Moon
// [D, M, M', F, coefficient of sin for longitude (1e-6 deg), coefficient of cos for distance (1e-3 km)]
const MOON_LR = [[0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743], [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130], [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897], [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117], [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0], [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0], [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165], [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0]];
// [D, M, M', F, coefficient of sin for latitude (1e-6 deg)]
const MOON_B = [[0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324], [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475], [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833]];

/** Geocentric apparent position of the Moon, true equator and equinox of date. dist in km. */
export function moonPosition(T) {
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000) * RAD;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * RAD;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * RAD;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * RAD;
  const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * RAD;
  const A1 = (119.75 + 131.849 * T) * RAD, A2 = (53.09 + 479264.290 * T) * RAD, A3 = (313.45 + 481266.484 * T) * RAD;
  const E = 1 - 0.002516 * T - 0.0000074 * T2, Ef = (m) => (m === 0 ? 1 : abs(m) === 1 ? E : E * E);
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, cl, cr] of MOON_LR) { const a = d * D + m * M + mp * Mp + f * F, k = Ef(m); sl += k * cl * sin(a); sr += k * cr * cos(a); }
  for (const [d, m, mp, f, cb] of MOON_B) sb += Ef(m) * cb * sin(d * D + m * M + mp * Mp + f * F);
  sl += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
  sb += -2235 * sin(Lp) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lp - Mp) - 115 * sin(Lp + Mp);
  const n = nutation(T);
  const lon = wrap2pi(Lp + sl * 1e-6 * RAD + n.dpsi), lat = sb * 1e-6 * RAD, dist = 385000.56 + sr / 1000;
  const ce = cos(n.eps), se = sin(n.eps);
  const ra = wrap2pi(atan2(sin(lon) * ce - tan(lat) * se, cos(lon))), dec = asin(sin(lat) * ce + cos(lat) * se * sin(lon));
  return { ra, dec, dist, lon, lat };
}

// ---------------------------------------------------------------- planets
// Standish, table 1 (1800-2050), J2000 ecliptic: a [AU], e, I, L, long. of perihelion, long. of node [deg], then rates per century
const ELEMENTS = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  emb: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
};
export const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const EPS_J2000 = 23.43928 * RAD, MOON_MASS_FRACTION = 1 / (1 + 81.30057);

/** Solve Kepler's equation E - e sin E = M. */
export function solveKepler(M, e) {
  M = wrapPi(M);
  let E = M + e * sin(M);
  for (let i = 0; i < 12; i++) { const d = (E - e * sin(E) - M) / (1 - e * cos(E)); E -= d; if (abs(d) < 1e-13) break; }
  return E;
}

/** Heliocentric position [AU] in the J2000 equatorial frame from the Keplerian elements. `name` may be 'emb'. */
export function heliocentric(name, T) {
  const k = ELEMENTS[name];
  const a = k[0] + k[6] * T, e = k[1] + k[7] * T, I = (k[2] + k[8] * T) * RAD, L = (k[3] + k[9] * T) * RAD, wb = (k[4] + k[10] * T) * RAD, Om = (k[5] + k[11] * T) * RAD;
  const w = wb - Om, E = solveKepler(L - wb, e);
  const xp = a * (cos(E) - e), yp = a * sqrt(1 - e * e) * sin(E);
  const cw = cos(w), sw = sin(w), cO = cos(Om), sO = sin(Om), cI = cos(I), sI = sin(I);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = sw * sI * xp + cw * sI * yp;
  const ce = cos(EPS_J2000), se = sin(EPS_J2000);
  return [x, y * ce - z * se, y * se + z * ce];
}

/** Heliocentric position of the Earth [AU], J2000 equatorial: the Earth-Moon barycentre minus the Moon's share. */
export function earthHeliocentric(T) {
  const b = heliocentric('emb', T), m = moonPosition(T);
  const v = matVec(transpose(j2000ToDateMatrix(T)), sphToVec(m.ra, m.dec)), s = (m.dist / AU_KM) * MOON_MASS_FRACTION;
  return [b[0] - v[0] * s, b[1] - v[1] * s, b[2] - v[2] * s];
}

/** Geocentric apparent position of a planet (light time and aberration to first order), true equator and equinox of
 *  date. dist and r (heliocentric) in AU; phase is the Sun-planet-Earth angle. */
export function planetPosition(name, T) {
  let tau = 0, g, p, e;
  for (let i = 0; i < 3; i++) {
    // to first order the apparent direction at t is the geometric direction at t - light time
    const Tr = T - tau / 36525;
    p = heliocentric(name, Tr); e = earthHeliocentric(Tr);
    g = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
    tau = Math.hypot(g[0], g[1], g[2]) / C_AU_PER_DAY;
  }
  const s = vecToSph(matVec(j2000ToDateMatrix(T), g)), r = Math.hypot(p[0], p[1], p[2]), R = Math.hypot(e[0], e[1], e[2]);
  const phase = acos(Math.max(-1, Math.min(1, (r * r + s.r * s.r - R * R) / (2 * r * s.r))));
  return { ra: s.lon, dec: s.lat, dist: s.r, r, phase };
}

/** Apparent visual magnitude of a planet (Astronomical Almanac expressions as in Meeus ch. 41; Saturn without its rings,
 *  which add up to about -1 mag). r, dist in AU, phase in radians. */
export function planetMagnitude(name, r, dist, phase) {
  const i = phase * DEG, d = 5 * Math.log10(r * dist);
  switch (name) {
    case 'mercury': return -0.42 + d + 0.0380 * i - 0.000273 * i * i + 0.000002 * i * i * i;
    case 'venus': return -4.40 + d + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i;
    case 'mars': return -1.52 + d + 0.016 * i;
    case 'jupiter': return -9.40 + d + 0.005 * i;
    case 'saturn': return -8.88 + d;
    case 'uranus': return -7.19 + d;
    case 'neptune': return -6.87 + d;
    default: return NaN;
  }
}

/** Phase of the Moon from the geocentric positions of the Sun and Moon: elongation, phase angle (Sun-Moon-Earth),
 *  illuminated fraction and an approximate visual magnitude. */
export function moonPhase(sun, moon) {
  const elong = separation(sun.ra, sun.dec, moon.ra, moon.dec), R = sun.dist * AU_KM;
  const phase = atan2(R * sin(elong), moon.dist - R * cos(elong)), i = abs(phase) * DEG;
  return { elongation: elong, phase, fraction: (1 + cos(phase)) / 2, mag: -12.73 + 0.026 * i + 4e-9 * i ** 4 + 5 * Math.log10(moon.dist / 384400) };
}

// ---------------------------------------------------------------- observer
/** Geocentric position of an observer [km] in the equatorial frame of date (WGS84). */
export function observerVector(lat, lst, heightM = 0) {
  const f = 1 / 298.257223563, C = 1 / sqrt(cos(lat) ** 2 + ((1 - f) * sin(lat)) ** 2), S = (1 - f) * (1 - f) * C, h = heightM / 1000;
  const rc = (EARTH_RADIUS_KM * C + h) * cos(lat), rs = (EARTH_RADIUS_KM * S + h) * sin(lat);
  return [rc * cos(lst), rc * sin(lst), rs];
}
/** Geocentric -> topocentric right ascension, declination and distance. distKm is the geocentric distance. */
export function topocentric(ra, dec, distKm, lat, lst, heightM = 0) {
  const v = sphToVec(ra, dec), o = observerVector(lat, lst, heightM);
  const s = vecToSph([v[0] * distKm - o[0], v[1] * distKm - o[1], v[2] * distKm - o[2]]);
  return { ra: s.lon, dec: s.lat, dist: s.r };
}

/** Day or twilight class from the true (unrefracted) altitude of the Sun's centre in degrees. */
export function twilight(sunAltDeg) {
  return sunAltDeg >= -0.833 ? 'day' : sunAltDeg >= -6 ? 'civil' : sunAltDeg >= -12 ? 'nautical' : sunAltDeg >= -18 ? 'astronomical' : 'night';
}

/** The Sun, Moon and planets as seen from a place: topocentric coordinates of date, airless altitude and azimuth,
 *  distance, magnitude. Returns { T, lst, sun, moon, planets[] , bodies[] }. */
export function solarSystem(ms, lat, lon, heightM = 0) {
  const T = centuriesTT(ms), lst = localSiderealTime(ms, lon);
  const place = (b, distKm) => { const t = topocentric(b.ra, b.dec, distKm, lat, lst, heightM), h = equatorialToHorizontal(t.ra, t.dec, lat, lst); return { ra: t.ra, dec: t.dec, alt: h.alt, az: h.az }; };
  const s = sunPosition(T), m = moonPosition(T), ph = moonPhase(s, m);
  const sun = { id: 'sun', name: 'Sun', ...place(s, s.dist * AU_KM), dist: s.dist, mag: -26.74, radius: asin(695700 / (s.dist * AU_KM)) };
  const moon = { id: 'moon', name: 'Moon', ...place(m, m.dist), dist: m.dist / AU_KM, distKm: m.dist, mag: ph.mag, fraction: ph.fraction, phase: ph.phase, elongation: ph.elongation, radius: asin(1737.4 / m.dist) };
  const planets = PLANETS.map((id) => {
    const p = planetPosition(id, T);
    return { id, name: id[0].toUpperCase() + id.slice(1), ...place(p, p.dist * AU_KM), dist: p.dist, r: p.r, phase: p.phase, mag: planetMagnitude(id, p.r, p.dist, p.phase) };
  });
  return { T, lst, sun, moon, planets, bodies: [sun, moon, ...planets] };
}

// ---------------------------------------------------------------- a target through a night
/** Rotation of the Earth in radians per millisecond of UT (sidereal rate). */
export const SIDEREAL_RATE = TAU * 1.00273790935 / 86400000;
/** Airless altitude and azimuth of a fixed J2000 position (radians) at a Unix time for a latitude and east longitude. */
export function fixedAltAz(ra, dec, ms, lat, lon) {
  const p = precess(ra, dec, centuriesTT(ms));
  return equatorialToHorizontal(p.ra, p.dec, lat, localSiderealTime(ms, lon));
}
/** Airless topocentric altitude of the Sun's centre (radians). */
export function sunAltitude(ms, lat, lon, heightM = 0) {
  const s = sunPosition(centuriesTT(ms)), lst = localSiderealTime(ms, lon), t = topocentric(s.ra, s.dec, s.dist * AU_KM, lat, lst, heightM);
  return equatorialToHorizontal(t.ra, t.dec, lat, lst).alt;
}
/** Times in [ms0, ms1] at which f(ms) changes sign: sampled every `step` ms, refined by bisection to 0.1 s. Returns [{ t, rising }]. */
export function crossings(f, ms0, ms1, step = 600000) {
  const out = [];
  let t0 = ms0, f0 = f(t0);
  while (t0 < ms1) {
    const t1 = Math.min(t0 + step, ms1), f1 = f(t1);
    if ((f0 < 0) !== (f1 < 0)) {
      let a = t0, b = t1, fa = f0;
      while (b - a > 100) { const m = (a + b) / 2, fm = f(m); if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m; }
      out.push({ t: (a + b) / 2, rising: f1 > f0 });
    }
    t0 = t1; f0 = f1;
  }
  return out;
}
/** Times at which the Sun's centre crosses the airless altitude `alt` (radians) between two Unix times. */
export const sunCrossings = (ms0, ms1, lat, lon, alt, heightM = 0) => crossings((t) => sunAltitude(t, lat, lon, heightM) - alt, ms0, ms1);
/** The last local mean noon at or before a Unix time, for an east longitude in radians. */
export const noonBefore = (ms, lon) => (floor(ms / 86400000 + lon / TAU - 0.5) + 0.5 - lon / TAU) * 86400000;
/** Altitudes of the Sun's centre (degrees) that bound day and the three twilights. */
export const SUN_LIMITS = { sun: -0.833, civil: -6, nautical: -12, astronomical: -18 };
/**
 * The night that contains a Unix time, or the one that follows it when the Sun is up: for each of `sun` (set and
 * rise, -0.833 deg), `civil`, `nautical` and `astronomical`, { evening, morning } in Unix ms, null where the Sun
 * does not reach that altitude between the local noon before and the one after (polar day or night).
 */
export function nightOf(ms, lat, lon, heightM = 0) {
  const noon = noonBefore(ms, lon), out = { noon };
  for (const [name, deg] of Object.entries(SUN_LIMITS)) {
    const cr = sunCrossings(noon, noon + 86400000, lat, lon, deg * RAD, heightM), set = cr.find((c) => !c.rising), rise = cr.find((c) => c.rising && (!set || c.t > set.t));
    out[name] = { evening: set ? set.t : null, morning: rise ? rise.t : null };
  }
  return out;
}
/**
 * Rising, culmination and setting (through the airless altitude alt0, radians) of a fixed J2000 position, for the
 * culmination nearest to a Unix time. Returns { culmination, rise, set, altMax, always, never }; rise and set are
 * null when it is always or never above alt0.
 */
export function fixedRiseSet(ra, dec, ms, lat, lon, alt0 = 0) {
  const p = precess(ra, dec, centuriesTT(ms)), H = wrapPi(localSiderealTime(ms, lon) - p.ra), culmination = ms - H / SIDEREAL_RATE;
  const c = (sin(alt0) - sin(lat) * sin(p.dec)) / (cos(lat) * cos(p.dec)), altMax = PI / 2 - abs(lat - p.dec);
  if (c >= 1) return { culmination, rise: null, set: null, altMax, always: false, never: true };
  if (c <= -1) return { culmination, rise: null, set: null, altMax, always: true, never: false };
  const dt = acos(c) / SIDEREAL_RATE;
  return { culmination, rise: culmination - dt, set: culmination + dt, altMax, always: false, never: false };
}
/** Airless altitude and azimuth of a fixed J2000 position at n + 1 equally spaced times: [{ t, alt, az }]. */
export function trackFixed(ra, dec, ms0, ms1, lat, lon, n = 96) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = ms0 + (ms1 - ms0) * i / n; out.push({ t, ...fixedAltAz(ra, dec, t, lat, lon) }); }
  return out;
}
