// Earth satellites: two-line elements from CelesTrak (fetched by the browser, cached in localStorage), propagated
// with SGP4 (satellite.js). Loaded only when the layer is switched on.
//
// CelesTrak sends `Access-Control-Allow-Origin: *` (checked 2026-11-15) and asks that a group is not fetched more
// often than it is updated, hence the cache. Elements are only good near their epoch, so a satellite is hidden when
// the clock of the sky view is more than MAX_AGE_DAYS from the epoch of its elements.
import { twoline2satrec, propagate, gstime, eciToEcf, ecfToLookAngles } from 'satellite.js';
import { sunPosition, centuriesTT, sphToVec, julianDate } from '../core/astro.js';

export const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle';
export const MAX_AGE_DAYS = 14;
const KEY = 'esl.sky.tle', CACHE_MS = 6 * 3600 * 1000, EARTH_KM = 6378.137;

export function parseTLE(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean), sats = [];
  for (let i = 0; i + 2 < lines.length + 0; i++) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      try { const rec = twoline2satrec(lines[i + 1], lines[i + 2]); if (!rec.error) sats.push({ name: lines[i].trim(), rec, epochJd: rec.jdsatepoch }); } catch { /* skip a bad set */ }
      i += 2;
    }
  }
  return sats;
}

/** Elements from the cache when fresh, else from CelesTrak. Returns { sats, fetched (ms), fromCache }. */
export async function loadSatellites(fetchImpl = fetch) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY)); } catch { /* no cache */ }
  if (cached && Date.now() - cached.t < CACHE_MS) return { sats: parseTLE(cached.text), fetched: cached.t, fromCache: true };
  try {
    const r = await fetchImpl(TLE_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text(), sats = parseTLE(text);
    if (!sats.length) throw new Error('no elements in the reply');
    try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), text })); } catch { /* storage full or blocked */ }
    return { sats, fetched: Date.now(), fromCache: false };
  } catch (e) {
    if (cached) return { sats: parseTLE(cached.text), fetched: cached.t, fromCache: true, stale: true };
    throw e;
  }
}

/** Where each satellite is for an observer: [{ name, alt, az (rad), range (km), sunlit, index }], above or below the horizon. */
export function satellitePositions(sats, ms, lat, lon, heightM = 0) {
  const date = new Date(ms), g = gstime(date), jd = julianDate(ms), obs = { latitude: lat, longitude: lon, height: heightM / 1000 };
  const s = sunPosition(centuriesTT(ms)), sv = sphToVec(s.ra, s.dec), out = [];
  for (let i = 0; i < sats.length; i++) {
    const sat = sats[i];
    if (Math.abs(jd - sat.epochJd) > MAX_AGE_DAYS) continue;
    const pv = propagate(sat.rec, date), p = pv && pv.position;
    if (!p || !Number.isFinite(p.x)) continue;
    const look = ecfToLookAngles(obs, eciToEcf(p, g));
    // in the Earth's shadow (a cylinder): on the night side and closer to the Earth-Sun line than one Earth radius
    const along = p.x * sv[0] + p.y * sv[1] + p.z * sv[2], perp = Math.sqrt(Math.max(0, p.x * p.x + p.y * p.y + p.z * p.z - along * along));
    out.push({ name: sat.name, index: i, alt: look.elevation, az: look.azimuth, range: look.rangeSat, sunlit: !(along < 0 && perp < EARTH_KM), height: Math.hypot(p.x, p.y, p.z) - EARTH_KM });
  }
  return out;
}
