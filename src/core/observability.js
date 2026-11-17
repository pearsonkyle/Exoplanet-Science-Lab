// Where a target, the Sun and the Moon are in the sky of an observing site, when it is dark, and when a planet
// transits. No DOM, no dependencies; everything the observation planner computes is here.
//
// Conventions
//   times     Julian dates in UTC (jdFromDate / dateFromJd convert to and from JS Dates) unless a name says BJD.
//             UT1 - UTC (below 0.9 s) is ignored.
//   angles    degrees. Right ascension and declination of a target are ICRS / J2000 on input.
//   site      { lat, lon, elev }: geodetic latitude (north positive), longitude (EAST positive), elevation in m.
//   azimuth   from north through east (N = 0, E = 90). Altitudes are geometric: no refraction (refraction() gives it).
//
// Methods and accuracy (measured against astropy in test/observability.test.mjs; the numbers are in the README):
//   stars     IAU 1976 precession of the J2000 position to the date, mean sidereal time (Meeus 1998, chs. 12, 21).
//             Nutation and annual aberration (each up to 20") and proper motion are left out.
//   Sun       Meeus ch. 25 low-accuracy theory (0.01 deg), apparent place.
//   Moon      the largest terms of Meeus ch. 47 (ELP-2000/82 truncated), apparent place, with topocentric parallax.
//   BJD       BJD_TDB <-> JD_UTC with the light-travel time to the Sun instead of the barycentre (the Sun is within
//             0.01 au of it: a few seconds) and TT - UTC from the leap-second table; TDB - TT (below 2 ms) is ignored.
//
// There is an overlap with src/core/astro.js (written at the same time for the sky view); this module does not
// depend on it so that the planner's numbers have one tested source.

const DEG = Math.PI / 180, TWO_PI = 2 * Math.PI, fin = Number.isFinite;
const sind = (x) => Math.sin(x * DEG), cosd = (x) => Math.cos(x * DEG);
const mod = (x, m) => ((x % m) + m) % m;
const J2000 = 2451545.0;
export const AU_KM = 149597870.7, C_KM_S = 299792.458, EARTH_RADIUS_KM = 6378.137;
/** Light-travel time over one astronomical unit, in days. */
export const AU_LIGHT_DAYS = AU_KM / C_KM_S / 86400;
/** Sidereal rate: degrees of Earth rotation per UT day. */
export const SIDEREAL_DEG_PER_DAY = 360.98564736629;

// ------------------------------------------------------------------------------------------------ time

/** Julian date (UTC) of a JS Date or of milliseconds since the Unix epoch. */
export const jdFromDate = (d) => (d instanceof Date ? d.getTime() : d) / 86400000 + 2440587.5;
/** JS Date of a Julian date (UTC). */
export const dateFromJd = (jd) => new Date((jd - 2440587.5) * 86400000);

// TAI - UTC: [JD at which it took effect, seconds]
const LEAP = [[2441317.5, 10], [2441499.5, 11], [2441683.5, 12], [2442048.5, 13], [2442413.5, 14], [2442778.5, 15], [2443144.5, 16], [2443509.5, 17], [2443874.5, 18],
  [2444239.5, 19], [2444786.5, 20], [2445151.5, 21], [2445516.5, 22], [2446247.5, 23], [2447161.5, 24], [2447892.5, 25], [2448257.5, 26], [2448804.5, 27],
  [2449169.5, 28], [2449534.5, 29], [2450083.5, 30], [2450630.5, 31], [2451179.5, 32], [2453736.5, 33], [2454832.5, 34], [2456109.5, 35], [2457204.5, 36], [2457754.5, 37]];
/** TT - UTC in seconds at a Julian date (UTC): 32.184 s + the leap seconds. Dates after the last entry (2017) use 37 leap seconds. */
export function ttMinusUtc(jd) {
  let n = 10;
  for (const [t, s] of LEAP) { if (jd >= t) n = s; else break; }
  return 32.184 + n;
}

/** Greenwich mean sidereal time in degrees (Meeus eq. 12.4) for a Julian date in UT. */
export function gmst(jd) {
  const d = jd - J2000, T = d / 36525;
  return mod(280.46061837 + SIDEREAL_DEG_PER_DAY * d + 0.000387933 * T * T - T * T * T / 38710000, 360);
}
// nutation in longitude and obliquity [deg], the four largest terms (Meeus ch. 22, 0.5" accuracy), and the mean obliquity
function nutation(T) {
  const O = 125.04452 - 1934.136261 * T, L = 280.4665 + 36000.7698 * T, Lm = 218.3165 + 481267.8813 * T;
  const dpsi = (-17.20 * sind(O) - 1.32 * sind(2 * L) - 0.23 * sind(2 * Lm) + 0.21 * sind(2 * O)) / 3600;
  const deps = (9.20 * cosd(O) + 0.57 * cosd(2 * L) + 0.10 * cosd(2 * Lm) - 0.09 * cosd(2 * O)) / 3600;
  const eps0 = 23.4392911 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
  return { dpsi, deps, eps0, eps: eps0 + deps };
}
/** Greenwich apparent sidereal time in degrees: mean sidereal time plus the equation of the equinoxes. */
export function gast(jd) {
  const n = nutation((jd - J2000) / 36525);
  return mod(gmst(jd) + n.dpsi * cosd(n.eps), 360);
}
/** Local mean sidereal time in degrees at east longitude lon. */
export const lmst = (jd, lon) => mod(gmst(jd) + lon, 360);

// ------------------------------------------------------------------------------------------------ coordinates

/** Precess a J2000 position to the mean equator and equinox of the date (IAU 1976; Meeus eq. 21.2-21.4). Returns { ra, dec }. */
export function precess(ra, dec, jd) {
  const T = (jd - J2000) / 36525, as = 1 / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as, z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
  const A = cosd(dec) * sind(ra + zeta), B = cosd(theta) * cosd(dec) * cosd(ra + zeta) - sind(theta) * sind(dec), Cc = sind(theta) * cosd(dec) * cosd(ra + zeta) + cosd(theta) * sind(dec);
  return { ra: mod(Math.atan2(A, B) / DEG + z, 360), dec: Math.asin(Math.max(-1, Math.min(1, Cc))) / DEG };
}

/** Altitude and azimuth of a position OF DATE at local sidereal time lst [deg] and latitude lat. Returns { alt, az, ha } (hour angle in degrees, west positive). */
export function horizontal(raDate, decDate, lst, lat) {
  const ha = mod(lst - raDate + 180, 360) - 180;
  const sa = sind(lat) * sind(decDate) + cosd(lat) * cosd(decDate) * cosd(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sa))) / DEG;
  const az = mod(Math.atan2(-cosd(decDate) * sind(ha), sind(decDate) * cosd(lat) - cosd(decDate) * cosd(ha) * sind(lat)) / DEG, 360);
  return { alt, az, ha };
}

/** Altitude and azimuth of a J2000 target at a Julian date (UTC) from a site. Returns { alt, az, ha }. */
export function altAz(ra, dec, jd, site) {
  const p = precess(ra, dec, jd);
  return horizontal(p.ra, p.dec, lmst(jd, site.lon), site.lat);
}

/** Angle between two directions on the sky, in degrees (Vincenty formula: good at all separations). */
export function angularSeparation(ra1, dec1, ra2, dec2) {
  const dl = (ra2 - ra1) * DEG, s1 = sind(dec1), c1 = cosd(dec1), s2 = sind(dec2), c2 = cosd(dec2);
  const y = Math.hypot(c2 * Math.sin(dl), c1 * s2 - s1 * c2 * Math.cos(dl)), x = s1 * s2 + c1 * c2 * Math.cos(dl);
  return Math.atan2(y, x) / DEG;
}

/** Secant of the zenith distance. Infinity at or below the horizon. */
export const secz = (alt) => (alt > 0 ? 1 / sind(alt) : Infinity);
/** Relative optical air mass of Kasten & Young (1989, Appl. Opt. 28, 4735): 1 at the zenith, 38 at the horizon. NaN below the horizon. */
export const airmass = (alt) => (alt >= 0 ? 1 / (sind(alt) + 0.50572 * Math.pow(alt + 6.07995, -1.6364)) : NaN);
/** Atmospheric refraction in degrees to ADD to a geometric altitude (Saemundsson 1986, sea level, 10 C; Meeus eq. 16.4). */
export const refraction = (alt) => (alt > -1 ? 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * DEG) / 60 : 0);

// ------------------------------------------------------------------------------------------------ Sun

/** Geocentric apparent position of the Sun: { ra, dec, dist [au], lon (apparent ecliptic longitude of date) }. Meeus ch. 25. */
export function sunPosition(jd) {
  const T = (jd + ttMinusUtc(jd) / 86400 - J2000) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T, M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const Cc = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sind(M) + (0.019993 - 0.000101 * T) * sind(2 * M) + 0.000289 * sind(3 * M);
  const trueLon = L0 + Cc, nu = M + Cc, dist = 1.000001018 * (1 - e * e) / (1 + e * cosd(nu));
  const n = nutation(T), lon = trueLon - 0.00569 / dist + n.dpsi;          // aberration and nutation
  return { ra: mod(Math.atan2(cosd(n.eps) * sind(lon), cosd(lon)) / DEG, 360), dec: Math.asin(sind(n.eps) * sind(lon)) / DEG, dist, lon: mod(lon, 360) };
}
/** Altitude and azimuth of the Sun from a site: { alt, az }. */
export function sunAltAz(jd, site) {
  const s = sunPosition(jd);
  return horizontal(s.ra, s.dec, mod(gast(jd) + site.lon, 360), site.lat);
}

// ------------------------------------------------------------------------------------------------ Moon

// Meeus table 47.A, largest terms: [D, M, M', F, sine coefficient of longitude (1e-6 deg), cosine coefficient of distance (1e-3 km)]
const MOON_LR = [[0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743], [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950]];
// Meeus table 47.B, largest terms: [D, M, M', F, sine coefficient of latitude (1e-6 deg)]
const MOON_B = [[0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324], [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475], [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335]];

/** Geocentric apparent position of the Moon: { ra, dec, dist [km], lon, lat (ecliptic of date) }. */
export function moonPosition(jd) {
  const T = (jd + ttMinusUtc(jd) / 86400 - J2000) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T, D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T, Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T;
  const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T * T;
  const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.290 * T, A3 = 313.45 + 481266.484 * T;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T, ef = (m) => (m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E);
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) { const a = (d * D + m * M + mp * Mp + f * F) * DEG, k = ef(m); sl += l * k * Math.sin(a); sr += r * k * Math.cos(a); }
  for (const [d, m, mp, f, b] of MOON_B) sb += b * ef(m) * Math.sin((d * D + m * M + mp * Mp + f * F) * DEG);
  sl += 3958 * sind(A1) + 1962 * sind(Lp - F) + 318 * sind(A2);
  sb += -2235 * sind(Lp) + 382 * sind(A3) + 175 * sind(A1 - F) + 175 * sind(A1 + F) + 127 * sind(Lp - Mp) - 115 * sind(Lp + Mp);
  const n = nutation(T), lon = Lp + sl / 1e6 + n.dpsi, lat = sb / 1e6, dist = 385000.56 + sr / 1000;
  const ra = Math.atan2(sind(lon) * cosd(n.eps) - Math.tan(lat * DEG) * sind(n.eps), cosd(lon)) / DEG;
  const dec = Math.asin(sind(lat) * cosd(n.eps) + cosd(lat) * sind(n.eps) * sind(lon)) / DEG;
  return { ra: mod(ra, 360), dec, dist, lon: mod(lon, 360), lat };
}

/**
 * The Moon as seen from a site (topocentric: its parallax is up to a degree): { alt, az, ra, dec, dist [km] }.
 * ra and dec are of date.
 */
export function moonAltAz(jd, site) {
  const m = moonPosition(jd), lst = mod(gast(jd) + site.lon, 360);
  // observer's geocentric position on the WGS84 ellipsoid, in km, in the equatorial frame of date
  const f = 1 / 298.257223563, u = Math.atan((1 - f) * Math.tan(site.lat * DEG)), h = (site.elev || 0) / 1000;
  const rc = EARTH_RADIUS_KM * Math.cos(u) + h * cosd(site.lat), rs = EARTH_RADIUS_KM * (1 - f) * Math.sin(u) + h * sind(site.lat);
  const x = m.dist * cosd(m.dec) * cosd(m.ra) - rc * cosd(lst), y = m.dist * cosd(m.dec) * sind(m.ra) - rc * sind(lst), z = m.dist * sind(m.dec) - rs;
  const dist = Math.hypot(x, y, z), ra = mod(Math.atan2(y, x) / DEG, 360), dec = Math.asin(z / dist) / DEG;
  const hz = horizontal(ra, dec, lst, site.lat);
  return { alt: hz.alt, az: hz.az, ra, dec, dist };
}

/** Illuminated fraction of the Moon's disc, 0 (new) to 1 (full), and whether it is waxing. Meeus eq. 48.1-48.3. */
export function moonIllumination(jd) {
  const s = sunPosition(jd), m = moonPosition(jd);
  const psi = angularSeparation(s.ra, s.dec, m.ra, m.dec) * DEG, rs = s.dist * AU_KM;
  const i = Math.atan2(rs * Math.sin(psi), m.dist - rs * Math.cos(psi));
  return { fraction: (1 + Math.cos(i)) / 2, waxing: mod(m.lon - s.lon, 360) < 180, elongation: psi / DEG };
}

// ------------------------------------------------------------------------------------------------ barycentric time

// Light-travel time [days] from the Earth to the Sun's centre projected on the direction of a J2000 target: BJD - JD (both in the same time scale).
function roemer(jdUtc, ra, dec) {
  const s = sunPosition(jdUtc), p = precess(ra, dec, jdUtc);
  // the Earth as seen from the Sun is opposite the Sun as seen from the Earth; aberration in s.lon (20") does not matter here
  const ex = -s.dist * cosd(s.dec) * cosd(s.ra), ey = -s.dist * cosd(s.dec) * sind(s.ra), ez = -s.dist * sind(s.dec);
  return (ex * cosd(p.dec) * cosd(p.ra) + ey * cosd(p.dec) * sind(p.ra) + ez * sind(p.dec)) * AU_LIGHT_DAYS;
}
/** BJD_TDB of an event seen at JD (UTC) on Earth, for a target at J2000 ra, dec. Good to a few seconds (heliocentric light time). */
export const jdUtcToBjdTdb = (jdUtc, ra, dec) => jdUtc + ttMinusUtc(jdUtc) / 86400 + roemer(jdUtc, ra, dec);
/** JD (UTC) at which an event with a given BJD_TDB is seen from the Earth. The inverse of jdUtcToBjdTdb. */
export function bjdTdbToJdUtc(bjd, ra, dec) {
  let jd = bjd - 69.184 / 86400;
  for (let i = 0; i < 3; i++) jd = bjd - ttMinusUtc(jd) / 86400 - roemer(jd, ra, dec);
  return jd;
}

// ------------------------------------------------------------------------------------------------ intervals

/** Intersection of two sorted lists of [start, end] intervals. */
export function intersectIntervals(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

/**
 * Times in [jd0, jd1] at which the Sun's altitude crosses `alt` degrees: [{ jd, rising }]. Sampled every 10
 * minutes and refined by bisection to better than a second.
 */
export function sunCrossings(jd0, jd1, site, alt) {
  const step = 10 / 1440, f = (t) => sunAltAz(t, site).alt - alt, out = [];
  let t0 = jd0, f0 = f(t0);
  while (t0 < jd1) {
    const t1 = Math.min(t0 + step, jd1), f1 = f(t1);
    if ((f0 < 0) !== (f1 < 0)) {
      let a = t0, b = t1, fa = f0;
      for (let i = 0; i < 22; i++) { const m = (a + b) / 2, fm = f(m); if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m; }
      out.push({ jd: (a + b) / 2, rising: f1 > f0 });
    }
    t0 = t1; f0 = f1;
  }
  return out;
}

/** Intervals within [jd0, jd1] during which the Sun is below `sunLimit` degrees (-18 astronomical night, the default; -12 nautical; -6 civil). */
export function darkIntervals(jd0, jd1, site, sunLimit = -18) {
  const cr = sunCrossings(jd0, jd1, site, sunLimit), out = [];
  let start = sunAltAz(jd0, site).alt < sunLimit ? jd0 : null;
  for (const c of cr) { if (c.rising) { if (start != null) out.push([start, c.jd]); start = null; } else start = c.jd; }
  if (start != null) out.push([start, jd1]);
  return out;
}

/**
 * Twilight for the night that contains or follows `jd`: the Sun's set and rise (-0.833 deg: refraction and
 * semi-diameter) and the evening and morning ends of civil (-6), nautical (-12) and astronomical (-18) twilight,
 * as Julian dates; null where the Sun does not cross that altitude within 36 hours of local noon.
 * `jdNoon` is the local noon before the night (noonBefore(jd, lon) gives it).
 */
export function twilight(jdNoon, site) {
  const out = {}, names = [['sun', -0.833], ['civil', -6], ['nautical', -12], ['astronomical', -18]];
  for (const [name, alt] of names) {
    const cr = sunCrossings(jdNoon, jdNoon + 1, site, alt), set = cr.find((c) => !c.rising), rise = cr.find((c) => c.rising && (!set || c.jd > set.jd));
    out[name] = { evening: set ? set.jd : null, morning: rise ? rise.jd : null };
  }
  return out;
}
/** The last local mean noon at or before jd for east longitude lon (the start of the "observing day"). */
export const noonBefore = (jd, lon) => Math.floor(jd + lon / 360) - lon / 360;

/**
 * Intervals within [jd0, jd1] during which a J2000 target is above minAlt degrees at a site. Analytic: the
 * altitude depends on the hour angle only, and the hour angle advances at the sidereal rate.
 */
export function upIntervals(ra, dec, jd0, jd1, site, minAlt) {
  const p = precess(ra, dec, (jd0 + jd1) / 2);
  const c = (sind(minAlt) - sind(site.lat) * sind(p.dec)) / (cosd(site.lat) * cosd(p.dec));
  if (c >= 1) return [];                                       // never that high
  if (c <= -1) return [[jd0, jd1]];                            // always
  const H0 = Math.acos(c) / DEG, sidDay = 360 / SIDEREAL_DEG_PER_DAY;
  const ha0 = mod(lmst(jd0, site.lon) - p.ra + 180, 360) - 180;                // hour angle at jd0
  let tc = jd0 - ha0 / SIDEREAL_DEG_PER_DAY;                                   // a culmination near jd0
  while (tc - H0 / SIDEREAL_DEG_PER_DAY > jd0) tc -= sidDay;
  const out = [];
  for (; tc - H0 / SIDEREAL_DEG_PER_DAY < jd1; tc += sidDay) {
    const s = Math.max(jd0, tc - H0 / SIDEREAL_DEG_PER_DAY), e = Math.min(jd1, tc + H0 / SIDEREAL_DEG_PER_DAY);
    if (e > s) out.push([s, e]);
  }
  return out;
}

/**
 * upIntervals with a terrain horizon as well: the parts of [jd0, jd1] in which the target is above minAlt AND its
 * apparent altitude (geometric + refraction()) is above horizon(az) degrees. horizon: a function of the azimuth in
 * degrees (from north through east) giving the apparent altitude of the skyline, optionally with a `max` property
 * (its highest value: where that is below minAlt the terrain cannot matter and the analytic intervals are returned).
 * The crossings are found on a grid of `step` days (default 2 min) and refined by bisection to about 1 s; a skyline
 * feature narrower than the grid step in time can be missed (a 2 min step is 0.5 deg of hour angle).
 */
export function upIntervalsHorizon(ra, dec, jd0, jd1, site, minAlt, horizon, step = 2 / 1440) {
  const base = upIntervals(ra, dec, jd0, jd1, site, minAlt);
  if (!horizon || (fin(horizon.max) && horizon.max <= minAlt)) return base;
  const p = precess(ra, dec, (jd0 + jd1) / 2);
  const clear = (t) => { const h = horizontal(p.ra, p.dec, lmst(t, site.lon), site.lat); return h.alt + refraction(h.alt) - horizon(h.az); };
  const out = [];
  for (const [s, e] of base) {
    const n = Math.max(1, Math.ceil((e - s) / step)), dt = (e - s) / n;
    let a = s, fa = clear(a), start = fa > 0 ? a : null;
    for (let i = 1; i <= n; i++) {
      const b = i === n ? e : s + i * dt, fb = clear(b);
      if ((fa > 0) !== (fb > 0)) {
        let lo = a, hi = b, flo = fa;
        while (hi - lo > 1e-5) { const m = (lo + hi) / 2, fm = clear(m); if ((fm > 0) === (flo > 0)) { lo = m; flo = fm; } else hi = m; }
        const t = (lo + hi) / 2;
        if (fb > 0) start = t; else { if (start != null && t > start) out.push([start, t]); start = null; }
      }
      a = b; fa = fb;
    }
    if (start != null && e > start) out.push([start, e]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ transits

/** 1-sigma uncertainty [days] of the mid-time n orbits after the reference epoch: sqrt(sigma_T0^2 + (n sigma_P)^2). Assumes T0 and P are uncorrelated. */
export const midTimeUncertainty = (n, tmidErr, perErr) => Math.hypot(tmidErr || 0, n * (perErr || 0));

/**
 * Mid-transit times of a linear ephemeris inside [t0, t1], in the time scale of the ephemeris (normally BJD_TDB).
 * eph: { per, tmid, perErr, tmidErr } in days. Returns [{ epoch, tmid, sigma }].
 */
export function transitsBetween(eph, t0, t1) {
  const out = [];
  if (!(eph.per > 0) || !fin(eph.tmid)) return out;
  for (let n = Math.ceil((t0 - eph.tmid) / eph.per); eph.tmid + n * eph.per <= t1; n++) out.push({ epoch: n, tmid: eph.tmid + n * eph.per, sigma: midTimeUncertainty(n, eph.tmidErr, eph.perErr) });
  return out;
}

// ------------------------------------------------------------------------------------------------ other events of the orbit
//
// Eclipses (superior conjunction), phase-curve windows and windows between two orbital phases, for the
// same planner. Convention as batman and Winn (2010): mid-transit at true anomaly f = 90 deg - omega, mid-eclipse
// at f = 270 deg - omega, omega in degrees as catalogued. Orbital phase is measured in time (mean anomaly) from
// mid-transit: phase 0 = transit; the eclipse is at phase 0.5 only for a circular orbit.

/** Mean anomaly [rad] at true anomaly f [rad]. */
function meanAnomalyAt(f, e) {
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(f / 2), Math.sqrt(1 + e) * Math.cos(f / 2));
  return E - e * Math.sin(E);
}
/** Time from mid-transit to the next mid-eclipse as a fraction of the period, in (0, 1). 0.5 for e = 0. */
export function eclipsePhase(ecc, omega) {
  const e = Math.min(Math.max(ecc || 0, 0), 0.999), w = (omega || 0) * DEG;
  if (e === 0) return 0.5;
  const d = (meanAnomalyAt(1.5 * Math.PI - w, e) - meanAnomalyAt(0.5 * Math.PI - w, e)) / TWO_PI;
  return mod(d, 1);
}
/**
 * Extra light-travel time of the eclipse relative to the transit [days]: the planet is on the far side of the star
 * at eclipse, so its light crosses the orbit (r at transit + r at eclipse, times sin i). aAU: semi-major axis in au.
 * 2a/c for a circular edge-on orbit (about 40 s for a = 0.04 au).
 */
export function eclipseLightDelay(aAU, ecc = 0, omega = 90, inc = 90) {
  if (!(aAU > 0)) return 0;
  const e = Math.min(Math.max(ecc || 0, 0), 0.999), w = (omega ?? 90) * DEG, p = aAU * (1 - e * e);
  const r = (f) => p / (1 + e * Math.cos(f));
  return (r(0.5 * Math.PI - w) + r(1.5 * Math.PI - w)) * Math.abs(sind(fin(inc) ? inc : 90)) * AU_LIGHT_DAYS;
}
/**
 * Eclipse duration (first to fourth contact) over transit duration. With the geometry (ars, inc, rprs) known: the
 * ratio of Winn (2010) eq. 14 with eq. 16 for the eclipse (the impact parameter of the eclipse is that of the
 * transit times (1 + e sin w) / (1 - e sin w)); 0 when the planet misses the star at eclipse. Without it: the speed
 * ratio (1 + e sin w) / (1 - e sin w). 1 for a circular orbit.
 */
export function eclipseDurationRatio({ ecc = 0, omega = 90, ars, inc, rprs } = {}) {
  const e = Math.min(Math.max(ecc || 0, 0), 0.95), es = e * sind(fin(omega) ? omega : 90);
  if (e === 0) return 1;
  if (!(ars > 1 && fin(inc) && rprs > 0)) return (1 + es) / (1 - es);
  const k = rprs, si = sind(inc), ci = cosd(inc), q = Math.sqrt(1 - e * e);
  const T = (sgn) => {                                   // sgn +1 transit, -1 eclipse; in units of P / pi
    const fac = 1 + sgn * es, b = ars * ci * (1 - e * e) / fac, s = (1 + k) ** 2 - b * b;
    return s > 0 ? Math.asin(Math.min(1, Math.sqrt(s) / (ars * si))) * q / fac : 0;
  };
  const tt = T(1);
  return tt > 0 ? T(-1) / tt : (1 + es) / (1 - es);
}

/** The event kinds the planner knows, in the order they are listed. */
export const EVENT_KINDS = ['transit', 'eclipse', 'phase', 'custom'];

/**
 * Where one kind of event of a planet falls, relative to its linear transit ephemeris: { phase (of the centre,
 * fraction of the orbit after mid-transit), offset (extra days, light time), before, after (days from the centre to
 * the start and the end of the window), sigma(n) (1-sigma of the centre time n orbits after T0, days), baseline
 * (whether the out-of-event baseline applies), assumed (text: what had to be assumed, '' when nothing) } or null
 * when that event does not exist for this planet (no eclipse, period longer than the phase-curve limit).
 *
 * tg  { per, tmid, perErr, tmidErr, t14, ecc, eccErr, omega, omegaErr, ars, inc, rprs, a (au) }
 * kind 'transit' | 'eclipse' | 'phase' | 'custom'
 * o   phase: { span (fraction of the orbit, default 0.5), center ('eclipse' | 'transit'), maxPer (days, default 3) }
 *     custom: { from, to } (orbital phases; to < from wraps through the transit)
 *
 * Eclipse timing: t = T0 + (n + phase) P + light delay. sigma^2 = sigma_T0^2 + ((n + phase) sigma_P)^2 +
 * (P dphase/de sigma_e)^2 + (P dphase/domega sigma_omega)^2, all taken as uncorrelated (e and omega are usually
 * correlated, so this overstates it when e is small). An eccentricity that is not catalogued is taken as 0; one
 * catalogued without omega is placed at phase 0.5 with sigma from e cos(omega) spread over all omega.
 */
export function eventGeometry(tg, kind, o = {}) {
  const P = tg.per, base = (n, ph) => midTimeUncertainty(n + ph, tg.tmidErr, tg.perErr);
  if (kind === 'transit') return { phase: 0, offset: 0, before: tg.t14 / 2, after: tg.t14 / 2, sigma: (n) => base(n, 0), baseline: true, assumed: '' };
  const hasE = fin(tg.ecc), hasW = fin(tg.omega), e = hasE ? Math.max(0, tg.ecc) : 0;
  let phase = 0.5, sPh = 0, assumed = '';
  if (!hasE) assumed = 'e not catalogued: circular orbit assumed';
  else if (e > 0 && !hasW) { assumed = 'ω not catalogued: eclipse placed at phase 0.5'; sPh = (2 / Math.PI) * e * Math.SQRT1_2; }   // rms of (2/pi) e cos(w) over w
  else if (e > 0) {
    phase = eclipsePhase(e, tg.omega);
    const h = 1e-6, de = tg.eccErr > 0 ? (eclipsePhase(Math.min(0.999, e + h), tg.omega) - eclipsePhase(Math.max(0, e - h), tg.omega)) / (Math.min(0.999, e + h) - Math.max(0, e - h)) * tg.eccErr : 0;
    const dw = tg.omegaErr > 0 ? (mod(eclipsePhase(e, tg.omega + 1e-4) - eclipsePhase(e, tg.omega - 1e-4) + 0.5, 1) - 0.5) / 2e-4 * tg.omegaErr : 0;
    sPh = Math.hypot(de, dw);
  } else if (tg.eccErr > 0) sPh = (2 / Math.PI) * tg.eccErr * Math.SQRT1_2;      // e = 0 +- sigma_e, omega free
  const offset = eclipseLightDelay(tg.a, e, hasW ? tg.omega : 90, tg.inc);
  const eclSigma = (n) => Math.hypot(base(n, phase), P * sPh);
  if (kind === 'eclipse') {
    const ratio = hasE && hasW ? eclipseDurationRatio({ ecc: e, omega: tg.omega, ars: tg.ars, inc: tg.inc, rprs: tg.rprs }) : 1;
    if (!(ratio > 0)) return null;                                               // the planet passes clear of the star
    const d = tg.t14 * ratio;
    return { phase, offset, before: d / 2, after: d / 2, sigma: eclSigma, baseline: true, assumed };
  }
  if (kind === 'phase') {
    const span = Math.min(1, Math.max(0.05, o.span ?? 0.5)), maxPer = o.maxPer ?? 3;
    if (!(P <= maxPer)) return null;
    const atEcl = (o.center || 'eclipse') === 'eclipse';
    return { phase: atEcl ? phase : 0, offset: atEcl ? offset : 0, before: span * P / 2, after: span * P / 2, sigma: atEcl ? eclSigma : (n) => base(n, 0), baseline: false, assumed: atEcl ? assumed : '' };
  }
  if (kind === 'custom') {
    const a = mod(o.from ?? 0.4, 1); let b = mod(o.to ?? 0.6, 1); if (b <= a) b += 1;
    const mid = (a + b) / 2;
    return { phase: mid, offset: 0, before: (b - a) * P / 2, after: (b - a) * P / 2, sigma: (n) => base(n, mid), baseline: false, assumed: '' };
  }
  return null;
}

/**
 * How much of a transit, and of the baseline around it, falls inside a list of observable intervals
 * (dark AND above the altitude limit; sorted). Times in days.
 *   coverage         fraction of [ingress, egress] that is observable
 *   ingress, egress  whether each contact is observable
 *   before, after    observable time adjoining ingress / egress on the outside (0 if that contact is not observable)
 *   start, end       first and last observable moment of the run(s) touching the transit (null when none)
 */
export function assessTransit(ingress, egress, intervals) {
  let cov = 0, before = 0, after = 0, inI = false, inE = false, start = null, end = null;
  for (const [s, e] of intervals) {
    const o = Math.min(e, egress) - Math.max(s, ingress);
    if (o > 0) { cov += o; if (start == null || s < start) start = s; if (end == null || e > end) end = e; }
    if (s <= ingress && ingress <= e) { inI = true; before = ingress - s; }
    if (s <= egress && egress <= e) { inE = true; after = e - egress; }
  }
  return { coverage: egress > ingress ? cov / (egress - ingress) : 0, ingress: inI, egress: inE, before, after, start, end };
}

/** The parts of the sorted interval list `a` that are not in the sorted list `b`. */
export function subtractIntervals(a, b) {
  const out = [];
  let j = 0;
  for (const [s0, e] of a) {
    let s = s0;
    while (j < b.length && b[j][1] <= s) j++;
    for (let k = j; k < b.length && b[k][0] < e; k++) {
      if (b[k][0] > s) out.push([s, b[k][0]]);
      s = Math.max(s, b[k][1]);
    }
    if (e > s) out.push([s, e]);
  }
  return out;
}

/**
 * How much of a region of interest [start, end] can be observed, and what takes the rest away.
 * dark, up: sorted interval lists (the Sun below its limit; the target above its altitude limit).
 * Returns { fraction (0 to 1), observable: [[s, e]], lost: [{ start, end, why }], lostTwilight, lostAltitude (days) }.
 * `why` is 'twilight' where the Sun is above its limit (whatever the altitude of the target then) and 'altitude'
 * where it is dark but the target is below the limit; the lost pieces are in time order.
 */
export function assessRegion(start, end, dark, up) {
  const roi = [[start, end]], darkIn = intersectIntervals(roi, dark), observable = intersectIntervals(darkIn, up);
  const lost = [...subtractIntervals(roi, dark).map(([s, e]) => ({ start: s, end: e, why: 'twilight' })), ...subtractIntervals(darkIn, up).map(([s, e]) => ({ start: s, end: e, why: 'altitude' }))].sort((x, y) => x.start - y.start);
  const sum = (why) => lost.reduce((t, l) => t + (l.why === why ? l.end - l.start : 0), 0);
  const got = observable.reduce((t, [s, e]) => t + e - s, 0);
  return { fraction: end > start ? got / (end - start) : 0, observable, lost, lostTwilight: sum('twilight'), lostAltitude: sum('altitude') };
}

/**
 * Transits of a list of targets that can be observed from a site between two dates.
 *
 * "Observable" is judged on the REGION OF INTEREST of a transit: from `baseline` before ingress to `baseline`
 * after egress (the out-of-transit flux on both sides is what a light-curve fit normalises against). A transit
 * is observable (`full`) when the whole region is dark and above the altitude limit.
 *
 * targets  [{ ra, dec (J2000 deg), per, tmid (BJD_TDB, days), perErr, tmidErr, t14 (duration, days), ... }]
 * site     { lat, lon, elev }
 * opts     jd0, jd1     window (JD UTC) in which the mid-transit must fall
 *          minAlt       lowest useful altitude of the target [deg] (default 30)
 *          sunLimit     the Sun must be below this altitude [deg] (default -18, the end of astronomical twilight)
 *          baseline     out-of-transit time wanted before ingress and after egress [days] (default 1 h)
 *          include      which transits to return:
 *                         'roi'      (default) only those whose whole region of interest is observable
 *                         'transit'  also those observable from ingress to egress with part of the baseline lost
 *                         'partial'  also those of which only a part can be observed: the ingress or the egress
 *                                    must be observable and at least minCoverage (default 0.25) of the duration
 *                       (partial: true is accepted for 'partial')
 *          dark         intervals of darkness covering the window, to reuse between calls (else computed here)
 *          horizon      optional terrain: azimuth (deg) -> apparent altitude of the skyline (deg), see
 *                       upIntervalsHorizon; the target must then be above both minAlt and the skyline
 *
 * Returns events sorted by time: { target, epoch, mid, ingress, egress (JD UTC, corrected from BJD_TDB for the
 * light-travel time), bjd, sigma (1-sigma of the mid-time, days),
 *   roiStart, roiEnd, roiCoverage (fraction of the region of interest that is observable), full (roiCoverage = 1),
 *   lost: [{ start, end, why: 'twilight' | 'altitude' }], lostTwilight, lostAltitude (days),
 *   coverage (fraction of ingress to egress that is observable), transitFull, ingressObs, egressObs,
 *   before, after (observable time adjoining ingress and egress on the outside, days; can exceed the baseline),
 *   obsStart, obsEnd, alt/az at ingress, mid and egress, airmass at mid, moon: { sep, illum, alt },
 *   score (0-100, see scoreTransit) }.
 */
export function findObservableTransits(targets, site, opts) {
  return findObservableEvents(targets, site, { ...opts, kinds: ['transit'] });
}

/**
 * Transits, eclipses, phase-curve windows and custom phase windows, with the rules of
 * findObservableTransits (the same opts, plus):
 *   kinds      which events, any of EVENT_KINDS (default ['transit'])
 *   phase      { span, center, maxPer } and custom { from, to }: see eventGeometry
 *   padSigma   true: the region of interest also covers 1 sigma of the predicted time on each side (default false)
 * For a transit or an eclipse the region of interest is baseline + event + baseline; a phase window is its own region
 * of interest (no baseline). "ingress" and "egress" are the start and end of the window for every kind.
 * Each event also has kind, phase and assumed (see eventGeometry), baselineWanted (days) and pad (days added on each
 * side for the timing).
 */
export function findObservableEvents(targets, site, opts) {
  const { jd0, jd1, minAlt = 30, sunLimit = -18, baseline = 1 / 24, minCoverage = 0.25, padSigma = false } = opts;
  const include = opts.include || (opts.partial ? 'partial' : 'roi'), kinds = opts.kinds || ['transit'];
  const dark = opts.dark || darkIntervals(jd0 - 1.5, jd1 + 1.5, site, sunLimit), out = [];
  for (const tg of targets) {
    if (!(tg.per > 0) || !fin(tg.tmid) || !(tg.t14 > 0) || !fin(tg.ra) || !fin(tg.dec)) continue;
    if (90 - Math.abs(site.lat - tg.dec) < minAlt) continue;                      // never gets that high from here
    for (const kind of kinds) {
      const g = eventGeometry(tg, kind, kind === 'custom' ? opts.custom : opts.phase);
      if (!g) continue;
      const B = g.baseline ? baseline : 0, shift = g.phase * tg.per + g.offset;
      // centres inside the window; +-0.01 d: the BJD to UTC shift is below 9 min
      for (let n = Math.ceil((jd0 - 0.01 - tg.tmid - shift) / tg.per); tg.tmid + shift + n * tg.per <= jd1 + 0.01; n++) {
        const bjd = tg.tmid + shift + n * tg.per, mid = bjdTdbToJdUtc(bjd, tg.ra, tg.dec);
        if (mid < jd0 || mid > jd1) continue;
        const ingress = mid - g.before, egress = mid + g.after, sigma = g.sigma(n), pad = padSigma && fin(sigma) ? sigma : 0;
        const roiStart = ingress - B - pad, roiEnd = egress + B + pad, w0 = roiStart - 0.5, w1 = roiEnd + 0.5;
        // cheap rejection before the interval arithmetic: some part of the event must be in the dark
        let anyDark = false;
        for (const [s, e] of dark) { if (e > ingress && s < egress) { anyDark = true; break; } if (s > egress) break; }
        if (!anyDark) continue;
        const up = opts.horizon ? upIntervalsHorizon(tg.ra, tg.dec, w0, w1, site, minAlt, opts.horizon) : upIntervals(tg.ra, tg.dec, w0, w1, site, minAlt), obs = intersectIntervals(dark, up);
        const a = assessTransit(ingress, egress, obs), transitFull = a.ingress && a.egress && a.coverage > 0.999;
        const R = assessRegion(roiStart, roiEnd, dark, up);
        const full = transitFull && R.fraction > 0.9995;
        if (!full && include === 'roi') continue;
        if (!transitFull && !(include === 'partial' && (a.ingress || a.egress) && a.coverage >= minCoverage)) continue;
        const p = precess(tg.ra, tg.dec, mid), at = (t) => horizontal(p.ra, p.dec, lmst(t, site.lon), site.lat);
        const hi = at(ingress), hm = at(mid), he = at(egress), moon = moonAltAz(mid, site), ill = moonIllumination(mid);
        const ev = { target: tg, kind, phase: g.phase, epoch: n, bjd, mid, ingress, egress, sigma, pad, assumed: g.assumed, baselineWanted: B,
          roiStart, roiEnd, roiCoverage: full ? 1 : R.fraction, full, lost: full ? [] : R.lost, lostTwilight: full ? 0 : R.lostTwilight, lostAltitude: full ? 0 : R.lostAltitude,
          coverage: a.coverage, transitFull, ingressObs: a.ingress, egressObs: a.egress,
          before: a.before, after: a.after, obsStart: a.start, obsEnd: a.end,
          altIngress: hi.alt, azIngress: hi.az, altMid: hm.alt, azMid: hm.az, altEgress: he.alt, azEgress: he.az, airmassMid: airmass(hm.alt),
          moon: { sep: angularSeparation(p.ra, p.dec, moon.ra, moon.dec), illum: ill.fraction, alt: moon.alt, waxing: ill.waxing } };
        ev.score = scoreTransit(ev, { minAlt, baseline: B });
        out.push(ev);
      }
    }
  }
  return out.sort((x, y) => x.mid - y.mid);
}

/**
 * A 0 to 100 figure of merit for how well an event can be observed and measured, for ranking (not a prediction of a
 * particular telescope's precision):
 *   40  x fraction of the event that is observable
 *   15  x fraction of the wanted baseline available, averaged over the two sides (full marks if none is wanted)
 *   20  x altitude, continuous: the mean airmass X over the observable ingress, mid and egress, from the airmass at
 *         the altitude limit (0) to the zenith (1), so a transit overhead outranks one that only clears 60 degrees
 *   20  x signal: the expected signal-to-noise of the transit, S/N = depth / sigma(m) x sqrt(T14 in minutes), with a
 *         noise per minute sigma(m) = hypot(2000 ppm x 10^(0.2 (m - 12)), 400 ppm): photon noise of a small (0.3-0.4 m)
 *         telescope and a floor for scintillation and systematics. Scored on a log scale, 0 at S/N 5 and full at
 *         S/N 200. Without a depth or a magnitude (an eclipse, a phase window, a missing value) it gets half marks.
 *    5  x Moon: 1 if it is down or farther than 40 deg, falling with proximity in proportion to its illuminated fraction
 * Returns { total, coverage, baseline, altitude, signal, moon, snr } with the parts in points (snr null when unknown).
 */
export const SCORE_WEIGHTS = { coverage: 40, baseline: 15, altitude: 20, signal: 20, moon: 5 };
/** Expected S/N of a transit from its depth (fraction), the host's magnitude and the duration (days); null when unknown. */
export function transitSnr(depth, mag, t14) {
  if (!(depth > 0) || !fin(mag) || !(t14 > 0)) return null;
  const sigma = Math.hypot(2000 * Math.pow(10, 0.2 * (mag - 12)), 400) * 1e-6;
  return (depth / sigma) * Math.sqrt(t14 * 1440);
}
export function scoreTransit(ev, { minAlt = 30, baseline = 1 / 24 } = {}) {
  const W = SCORE_WEIGHTS, clamp = (x) => Math.max(0, Math.min(1, x));
  const alts = [ev.ingressObs ? ev.altIngress : NaN, ev.altMid, ev.egressObs ? ev.altEgress : NaN].filter((x) => fin(x) && x >= minAlt - 1e-9);
  const X = (h) => 1 / Math.sin(Math.max(1, h) * Math.PI / 180), xLim = X(minAlt);
  const xMean = alts.length ? alts.reduce((a, h) => a + X(h), 0) / alts.length : xLim;
  const tg = ev.target || {}, snr = ev.kind && ev.kind !== 'transit' ? null : transitSnr(tg.depth, tg.mag, tg.t14);
  const parts = {
    coverage: W.coverage * clamp(ev.coverage),
    baseline: W.baseline * (baseline > 0 ? (clamp(ev.before / baseline) + clamp(ev.after / baseline)) / 2 : 1),
    altitude: W.altitude * clamp((xLim - xMean) / Math.max(1e-9, xLim - 1)),
    signal: W.signal * (snr === null ? 0.5 : clamp(Math.log10(snr / 5) / Math.log10(200 / 5))),
    moon: W.moon * (ev.moon.alt <= 0 ? 1 : 1 - ev.moon.illum * clamp((40 - ev.moon.sep) / 40)),
  };
  return { total: parts.coverage + parts.baseline + parts.altitude + parts.signal + parts.moon, ...parts, snr };
}

export const _internals = { nutation, roemer, mod };
