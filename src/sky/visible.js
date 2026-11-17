// The stars with planets that can be seen from a place: now, or in tonight's dark hours. The list of the Observe
// page's "Visible" panel, its legend counts and the immersive menu's short list. No DOM: test/visible.test.mjs.
//
// Rows of public/sky/hosts.json: [name, ra, dec (J2000 deg), V or null, confirmed planets, groups(, candidates)],
// candidates = [TESS magnitude, TIC, [[TOI, period d, error, epoch BJD_TDB, error, duration h, depth ppm, disposition]]]
// (tools/build_sky_data.py). Altitudes here are airless (geometric) unless a horizon says otherwise.
import * as A from '../core/astro.js';
import * as O from '../core/observability.js';
import { shownGroup } from './discovery.js';

const { RAD } = A;
const fin = Number.isFinite;
const jdToMs = (jd) => (jd - 2440587.5) * 86400000, msToJd = (ms) => ms / 86400000 + 2440587.5;

/** The magnitude a host is drawn and sorted by: V, else the TESS magnitude of a candidate host, else null. */
export const hostMag = (h) => (h[3] != null ? h[3] : h[6] && h[6][0] != null ? h[6][0] : null);
/** Which band hostMag() is in: 'V', 'T' or ''. */
export const hostBand = (h) => (h[3] != null ? 'V' : h[6] && h[6][0] != null ? 'T' : '');
/** The TIC number of a host that has candidates, else null. */
export const hostTic = (h) => (h[6] ? h[6][1] : null);
/**
 * The TESS candidates of a host as transit targets: [{ name, per, perErr, tmid, tmidErr, t14 (days), depth
 * (fraction), disposition, candidate: true, method: 'Transit', transit: true }]. Entries without a period or an
 * epoch are kept (single transits) with per NaN: they cannot be predicted.
 */
export function candidatesOf(h) {
  if (!h || !h[6]) return [];
  return h[6][2].map((c) => ({ name: c[0], per: c[1] > 0 ? c[1] : NaN, perErr: c[2] || 0, tmid: fin(c[3]) ? c[3] : NaN, tmidErr: c[4] || 0, t14: c[5] > 0 ? c[5] / 24 : NaN,
    depth: c[6] > 0 ? c[6] * 1e-6 : NaN, disposition: c[7] || '', candidate: true, method: 'Transit', transit: true, hasErr: !!(c[2] && c[4]) }));
}
/** "TOI-1234.01" (or "TOI 1234.01", "toi1234.01", "TOI-1234") -> { host: 'TOI-1234', planet: 'TOI-1234.01' | null }, else null. */
export function parseToi(name) {
  const m = /^\s*toi[\s_-]*(\d+)(?:\.(\d{1,2}))?\s*$/i.exec(String(name ?? ''));
  return m ? { host: 'TOI-' + (+m[1]), planet: m[2] != null ? `TOI-${+m[1]}.${m[2].padStart(2, '0')}` : null } : null;
}

/**
 * The highest airless altitude (radians) of a fixed J2000 position between two Unix times, and when: the
 * culmination when it falls inside, else the higher end. lat, lon in radians. { alt, t }.
 */
export function maxAltitudeIn(ra, dec, ms0, ms1, lat, lon) {
  const mid = (ms0 + ms1) / 2, r = A.fixedRiseSet(ra, dec, mid, lat, lon, 0), day = 2 * Math.PI / A.SIDEREAL_RATE;
  let best = null;
  for (const c of [r.culmination - day, r.culmination, r.culmination + day]) if (c >= ms0 && c <= ms1) { const h = A.fixedAltAz(ra, dec, c, lat, lon); if (!best || h.alt > best.alt) best = { alt: h.alt, t: c }; }
  for (const t of [ms0, ms1]) { const h = A.fixedAltAz(ra, dec, t, lat, lon); if (!best || h.alt > best.alt) best = { alt: h.alt, t }; }
  return best;
}

/**
 * The transits of a list of planets (records with per, tmid in BJD_TDB, t14 in days, perErr, tmidErr) whose middle
 * falls between two Unix times, soonest first: [{ planet, ingress, mid, egress (Unix ms), err (minutes, 1 sigma, or
 * null) }]. ra, dec: the star (J2000 deg), for the light-time correction.
 */
export function transitsIn(planets, ra, dec, ms0, ms1) {
  const out = [], jd0 = msToJd(ms0), jd1 = msToJd(ms1);
  for (const p of planets) {
    if (!(p.per > 0) || !fin(p.tmid) || !(p.t14 > 0)) continue;
    for (const tr of O.transitsBetween({ per: p.per, tmid: p.tmid, perErr: p.perErr, tmidErr: p.tmidErr }, jd0 - 0.01, jd1 + 0.01)) {
      const mid = O.bjdTdbToJdUtc(tr.tmid, ra, dec); if (mid < jd0 || mid > jd1) continue;
      out.push({ planet: p.name, candidate: !!p.candidate, ingress: jdToMs(mid - p.t14 / 2), mid: jdToMs(mid), egress: jdToMs(mid + p.t14 / 2), err: p.hasErr ? tr.sigma * 1440 : null, depth: p.depth });
    }
  }
  return out.sort((a, b) => a.mid - b.mid);
}

export const SORTS = {
  alt: 'altitude now', maxalt: 'highest tonight', mag: 'brightest', name: 'name', transit: 'transit tonight', planets: 'most planets',
};
export const WHEN = { now: 'above the limit now', tonight: 'above the limit in tonight’s dark hours', either: 'now or tonight' };

/**
 * The hosts that can be seen, filtered and sorted.
 * hosts  rows of hosts.json; pos: Float32Array of their J2000 unit vectors (3 per host)
 * o      lat, lon (radians), now (Unix ms), dark: { t0, t1 } (Unix ms, tonight's dark hours) or null,
 *        minAlt (radians, default 0), horizon(azRad) -> radians (the terrain, apparent; default flat),
 *        apparent(altRad) -> apparent altitude (refraction; default none), filter (discovery groups shown),
 *        magMax (null: any), minPlanets (confirmed + candidates, default 0), when: 'now' | 'tonight' | 'either',
 *        sort: a key of SORTS, transits(i) -> the soonest transit of host i tonight or null (for 'transit'),
 *        limit (default 200), j2000ToWorld: the 3x3 matrix of the frame (else computed: slower),
 *        accept(i) -> false to leave host i out (the host filter of the Filter panel, src/sky/hostFilter.js)
 * Returns { rows: [{ i, name, group, alt, az, up, maxAlt, tMax, upTonight, mag, band, planets, candidates,
 *   transit }], total: how many meet the filters before the limit, counts: { group: hosts up now }, up: hosts up now }.
 */
export function visibleHosts(hosts, pos, o) {
  const lat = o.lat, lon = o.lon, minAlt = o.minAlt || 0, hor = o.horizon || (() => 0), app = o.apparent || ((a) => a), filter = o.filter ?? 'trimoc';
  const when = o.when || 'either', minPl = o.minPlanets || 0, magMax = o.magMax == null ? Infinity : o.magMax;
  const sys = A.localSiderealTime(o.now, lon), M = o.j2000ToWorld || A.matMul([1, 0, 0, 0, 0, 1, 0, -1, 0], A.matMul(A.equatorialToHorizontalMatrix(lat, sys), A.j2000ToDateMatrix(A.centuriesTT(o.now))));
  const rows = [], counts = {}; let nUp = 0;
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i], gs = h[5] || 'o';
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    const w0 = M[0] * x + M[1] * y + M[2] * z, w1 = M[3] * x + M[4] * y + M[5] * z, w2 = M[6] * x + M[7] * y + M[8] * z;
    const alt = Math.asin(Math.max(-1, Math.min(1, w1))), az = A.wrap2pi(Math.atan2(w0, -w2)), altA = app(alt);
    const up = altA > hor(az) && alt >= minAlt;
    if (up) { nUp++; for (const g of new Set(gs)) counts[g] = (counts[g] || 0) + 1; }
    const group = shownGroup(gs, filter); if (!group) continue;
    if (o.accept && !o.accept(i)) continue;
    const mag = hostMag(h), nc = h[6] ? h[6][2].length : 0;
    if (magMax < Infinity && !(mag != null && mag <= magMax)) continue;
    if (h[4] + nc < minPl) continue;
    let maxAlt = NaN, tMax = NaN, upTonight = false;
    if (o.dark && (when !== 'now' || o.sort === 'maxalt')) {
      const m = maxAltitudeIn(h[1] * RAD, h[2] * RAD, o.dark.t0, o.dark.t1, lat, lon); maxAlt = m.alt; tMax = m.t;
      upTonight = maxAlt >= minAlt && app(maxAlt) > hor(A.fixedAltAz(h[1] * RAD, h[2] * RAD, m.t, lat, lon).az);
    }
    if (when === 'now' ? !up : when === 'tonight' ? !upTonight : !(up || upTonight)) continue;
    rows.push({ i, name: h[0], group, alt: altA, az, up, maxAlt, tMax, upTonight, mag, band: hostBand(h), planets: h[4], candidates: nc, transit: o.transits ? o.transits(i) : null });
  }
  const by = {
    alt: (a, b) => b.alt - a.alt, maxalt: (a, b) => (b.maxAlt || -9) - (a.maxAlt || -9), name: (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }),
    mag: (a, b) => (a.mag ?? 99) - (b.mag ?? 99), planets: (a, b) => b.planets + b.candidates - a.planets - a.candidates || (a.mag ?? 99) - (b.mag ?? 99),
    transit: (a, b) => (a.transit ? a.transit.mid : Infinity) - (b.transit ? b.transit.mid : Infinity) || (a.mag ?? 99) - (b.mag ?? 99),
  }[o.sort || 'alt'] || ((a, b) => b.alt - a.alt);
  rows.sort(by);
  return { rows: rows.slice(0, o.limit || 200), total: rows.length, counts, up: nUp };
}
