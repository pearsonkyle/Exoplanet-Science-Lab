// Rehearsing an observation: a real planet's real transit, simulated. The Run page's simulated camera renders a
// planned night of a known planet (its ephemeris, Rp/R*, a/R*, inclination, quadratic limb darkening) at the time
// of an observable transit from the site, on a virtual clock running faster than real time, so a whole transit
// takes minutes and everything downstream (headers, BJD_TDB, airmass, the live reduction, the predicted transit
// drawn over the data) is what that night would give. No DOM.

import { makeTransit } from './transit.js';
import { findObservableEvents } from './observability.js';
import { jdFromMs } from './timescale.js';
import { utcToBjdTdb } from './fits.js';

/**
 * Planets for rehearsals: the parameter sets of the NASA Exoplanet Archive in this site's catalogue snapshot
 * (public/catalog, the first set with Rp/R*, a/R*, i and T0; read 2026-11-18), host coordinates (deg, J2000) and V.
 * Limb darkening is a generic quadratic law for a Sun-like star in a red band ([0.40, 0.25]); a rehearsal does not
 * need better.
 */
export const REHEARSAL_PLANETS = [
  { name: 'HAT-P-32 b', ra: 31.0427614, dec: 46.6878512, vmag: 11.439, per: 2.150008197, tmid: 2456265.154123, rprs: 0.1489, ars: 5.34, inc: 89 },
  { name: 'WASP-12 b', ra: 97.636645, dec: 29.6722662, vmag: 11.569, per: 1.091419179, tmid: 2457036.706177, rprs: 0.1178, ars: 3.04, inc: 83.4 },
  { name: 'HD 189733 b', ra: 300.1821223, dec: 22.7097759, vmag: 7.67, per: 2.218574944, tmid: 2456194.067619, rprs: 0.15534, ars: 8.92, inc: 85.78 },
  { name: 'WASP-52 b', ra: 348.4947931, dec: 8.7610793, vmag: 12.192, per: 1.74978117, tmid: 2456784.057988, rprs: 0.1646, ars: 7.38, inc: 85.35 },
  { name: 'Qatar-1 b', ra: 303.3818697, dec: 65.1623313, vmag: 12.692, per: 1.420024443, tmid: 2457475.204489, rprs: 0.1463, ars: 6.25, inc: 84.08 },
  { name: 'WASP-43 b', ra: 154.9081869, dec: -9.8064431, vmag: 12.305, per: 0.813474056, tmid: 2457202.184881, rprs: 0.1594, ars: 4.867, inc: 82.11 },
  { name: 'TrES-3 b', ra: 268.0291106, dec: 37.5463268, vmag: 12.362, per: 1.306186348, tmid: 2457585.914587, rprs: 0.17, ars: 6, inc: 82 },
  { name: 'HAT-P-37 b', ra: 284.2960393, dec: 51.2691212, vmag: 13.427, per: 2.79744256, tmid: 2457938.84392, rprs: 0.1394, ars: 9.19, inc: 86.7 },
];
export const DEFAULT_LD = [0.40, 0.25];

/** Total transit duration T14 [days] of a circular orbit (Winn 2010, eq. 14). NaN when it does not transit. */
export function t14(p) {
  const b = p.ars * Math.cos(p.inc * Math.PI / 180), s = Math.sqrt((1 + p.rprs) ** 2 - b * b) / (p.ars * Math.sin(p.inc * Math.PI / 180));
  return b < 1 + p.rprs ? p.per / Math.PI * Math.asin(Math.min(1, s)) : NaN;
}

/** flux(bjdTdb) of a planet (circular orbit unless ecc and omega are given): the core's transit model. */
export function planetFlux(p, ld = p.ld || DEFAULT_LD) {
  return makeTransit({ rprs: p.rprs, per: p.per, tmid: p.tmid, ars: p.ars, inc: p.inc, ecc: p.ecc || 0, omega: p.omega || 0, ldLaw: 'quadratic', ld });
}

/**
 * The relative flux of the target at a Unix time (ms, UTC; mid-exposure) seen from the Earth: the time is turned into
 * BJD_TDB for the star's position first, as the frames' BJD_TDB cards and the reduction do.
 */
export function fluxAtUtc(p, ld) {
  const f = planetFlux(p, ld);
  return (ms) => f(utcToBjdTdb(jdFromMs(ms), p.ra, p.dec));
}

/**
 * The next transit of `planet` that can be observed whole (region of interest above `minAlt`, Sun below
 * `sunLimit`) from `site`, from `fromMs` on, within `nights`. Returns the event of findObservableEvents, or null.
 */
export function nextObservableTransit(planet, site, fromMs, { nights = 60, minAlt = 30, sunLimit = -12, baseline = 1 / 24 } = {}) {
  const tg = { ...planet, t14: planet.t14 || t14(planet) };
  const jd0 = jdFromMs(fromMs);
  for (let k = 0; k < nights; k += 15) {
    const ev = findObservableEvents([tg], site, { jd0: jd0 + k, jd1: jd0 + Math.min(nights, k + 15), minAlt, sunLimit, baseline });
    if (ev.length) return ev[0];
  }
  return null;
}

/**
 * A clock that runs `speed` times faster than real time from `startMs` (virtual) at the real moment `realStart`.
 * now() gives the virtual Unix ms; sleepMs(v) is the real wait for v virtual ms; pause() stops it (an observer's
 * pause, the meridian) and resume() starts it again where it stopped.
 */
export function virtualClock(startMs, speed = 30, realStart = Date.now(), realNow = () => Date.now()) {
  let base = startMs, from = realStart, stopped = null;
  const now = () => (stopped != null ? stopped : base + (realNow() - from) * speed);
  return {
    speed, startMs, now, sleepMs: (v) => v / speed,
    pause() { if (stopped == null) stopped = now(); },
    resume() { if (stopped != null) { base = stopped; from = realNow(); stopped = null; } },
    get paused() { return stopped != null; },
  };
}
