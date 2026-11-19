// Rehearsals (src/core/rehearsal.js): a real planet's transit simulated at the time it can be seen. References:
// the transit model itself (src/core/transit.js, validated against batman in test/physics.test.mjs) for the
// contact times, the ephemeris for the epoch, observability.js for the sky, and the injected light curve for the
// simulated frames.
import { REHEARSAL_PLANETS, t14, planetFlux, fluxAtUtc, nextObservableTransit, virtualClock } from '../src/core/rehearsal.js';
import { createSimSky } from '../src/core/simsky.js';
import { altAz, sunAltAz } from '../src/core/observability.js';
import { utcToBjdTdb } from '../src/core/fits.js';
import { jdFromMs, msFromJd } from '../src/core/timescale.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const site = { lat: 31.9583, lon: -111.5967, elev: 2096 };

// T14 (Winn 2010) against the first and last contact of the model, for every planet
let worst = 0;
for (const p of REHEARSAL_PLANETS) {
  const f = planetFlux(p), step = 10 / 86400; let first = null, last = null;
  for (let t = p.tmid - 0.3; t <= p.tmid + 0.3; t += step) if (f(t) < 1) { if (first === null) first = t; last = t; }
  worst = Math.max(worst, Math.abs((last - first + step) - t14(p)) * 1440);
}
check('T14 formula = the model’s first-to-last contact, all planets', worst < 0.5, `largest difference ${worst.toFixed(2)} min (10 s grid)`);

const p = REHEARSAL_PLANETS[0], from = Date.UTC(2026, 10, 18), ev = nextObservableTransit(p, site, from, { nights: 60 });
check('the next observable HAT-P-32 b transit from Kitt Peak after 2026-11-18', !!ev && msFromJd(ev.mid) > from, ev && new Date(msFromJd(ev.mid)).toISOString());
const n = (ev.bjd - p.tmid) / p.per;
check('it is an epoch of the catalogue ephemeris', Math.abs(n - Math.round(n)) < 1e-9, `epoch ${Math.round(n)}`);
const ok1 = [ev.roiStart, ev.mid, ev.roiEnd].every((jd) => altAz(p.ra, p.dec, jd, site).alt >= 30 && sunAltAz(jd, site).alt <= -12);
check('the whole region of interest is above 30° in the dark', ok1);

// the flux seen at UTC: the minimum at mid-transit (UTC of the event = BJD minus the light time)
const g = fluxAtUtc(p); let tMin = 0, fMin = 2;
for (let ms = msFromJd(ev.ingress); ms <= msFromJd(ev.egress); ms += 5000) { const v = g(ms); if (v < fMin) { fMin = v; tMin = ms; } }
check('fluxAtUtc: deepest at the event’s mid-time (UTC)', Math.abs(tMin - msFromJd(ev.mid)) < 3 * 60e3, `${((tMin - msFromJd(ev.mid)) / 1000).toFixed(0)} s from mid; depth ${(100 * (1 - fMin)).toFixed(2)} % (Rp/R* squared ${(100 * p.rprs ** 2).toFixed(2)} % before limb darkening)`);
check('BJD_TDB of that mid-time matches the ephemeris', Math.abs(utcToBjdTdb(jdFromMs(msFromJd(ev.mid)), p.ra, p.dec) - ev.bjd) * 86400 < 10, `${((utcToBjdTdb(jdFromMs(msFromJd(ev.mid)), p.ra, p.dec) - ev.bjd) * 86400).toFixed(2)} s`);

// the simulated frames carry that light curve: the same frame with and without the planet differs by exactly the
// blocked starlight, (1 - model) x the target's flux through the atmosphere (the field centre: no vignetting)
{
  const opts = { width: 120, height: 90, site, target: p, centre: true, t0: msFromJd(ev.roiStart), tmid: msFromJd(ev.mid), flux: 4000 };
  const A = createSimSky({ ...opts, lightCurve: g }), B = createSimSky({ ...opts, lightCurve: () => 1 });
  const t = msFromJd(ev.mid) - 30e3, a = A.frame('light', t, 60, 1), b = B.frame('light', t, 60, 1);
  let d = 0; for (let i = 0; i < a.length; i++) d += b[i] - a[i];
  const want = (1 - g(t + 30e3)) * 4000 * 60 * A.last.transparency;
  check('the simulated sky follows the planet’s light curve', Math.abs(d / want - 1) < 0.02, `blocked ${d.toFixed(0)} ADU, model ${want.toFixed(0)} ADU (pixels rounded to whole ADU)`);
}

// the virtual clock
{
  let real = 1000; const vc = virtualClock(5e12, 60, 1000, () => real);
  real += 1000;
  check('virtual clock: 60 times faster, from its start', vc.now() === 5e12 + 60000 && vc.sleepMs(60000) === 1000);
  vc.pause(); real += 5000; const held = vc.now(); vc.resume(); real += 1000;
  check('virtual clock: stopped while paused, on again from there', held === 5e12 + 60000 && vc.now() === 5e12 + 120000);
}

process.exit(ok ? 0 : 1);
