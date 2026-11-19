// Rehearsals (src/core/rehearsal.js): a real planet's transit simulated at the time it can be seen. References:
// the transit model itself (src/core/transit.js, validated against batman in test/physics.test.mjs) for the
// contact times, the ephemeris for the epoch, observability.js for the sky, and the injected light curve for the
// simulated frames.
import { REHEARSAL_PLANETS, t14, planetFlux, fluxAtUtc, nextObservableTransit, virtualClock } from '../src/core/rehearsal.js';
import { createSimSky } from '../src/core/simsky.js';
import { createReducer, chooseStars } from '../src/core/reduce.js';
import { optimise } from '../src/core/photometry.js';
import { frameHeader } from '../src/core/fitsheader.js';
import { encodeFits, parseFits } from '../src/core/fits.js';
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

// the whole rehearsal pipeline on the night that came out shallow on the Run page (WASP-121 b from Las Campanas,
// 2026-01-19, 'average' tracking), now with flats, chooseStars, the live reducer, optimise, and a depth fit with an
// airmass, time and FWHM baseline (the columns the Run page now hands to Analyze). With the comparison stars Run used
// to pick, no flats and no FWHM term, seeds 8 and 12 gave 0.30 and 0.79 times the model depth. The reference is the
// injected model; the check is 3 sigma of the white-noise error (the residuals are slightly red: see the
// validation notes).
{
  const site2 = { lat: -29.00333, lon: -70.70167, elev: 2282 }, tg = { name: 'WASP-121 b', ra: 107.6002312, dec: -39.0972705 };
  const pl = { per: 1.27492504, tmid: 2460245.02038, rprs: 0.122551, ars: 3.7844, inc: 88.49, ld: [0.40, 0.25], ra: tg.ra, dec: tg.dec };
  const w0 = Date.parse('2026-01-19T02:11:55.628Z'), w1 = Date.parse('2026-01-19T07:06:31.459Z'), mid = Date.parse('2026-01-19T04:39:13.544Z');
  const W = 240, H = 180, EXP = 60, CAD = 92e3, pf = planetFlux(pl), lcU = fluxAtUtc(pl);
  for (const seed of [8, 12]) {
    const sky = createSimSky({ width: W, height: H, site: site2, target: tg, lightCurve: lcU, tmid: mid, duration: 3, t0: w0, tracking: 'average', flux: 4000 * 10 ** (0.4 * 0.486), centre: true, clear: 30, seed });
    const bias = sky.frame('bias', w0, 0, 1), fl = sky.frame('flat', w0, 1, 2).map((v, i) => v - bias[i]);
    const fm = [...fl].sort((a, b) => a - b)[fl.length >> 1], flat = fl.map((v) => v / fm);
    let red = null; const cam = { name: 'sim', width: W, height: H, pixelSize: 3.76 };
    for (let t = w0, k = 0; t + EXP * 1000 <= w1; t += CAD, k++) {
      const img = sky.frame('light', t, EXP, k), f = parseFits(encodeFits(img, W, H, frameHeader({ exposure: { start: t, duration: EXP, kind: 'light' }, clock: { source: 'rehearsal', label: 'x', offset: 0, unc: 0 }, site: site2, target: tg, camera: cam, telescope: {} }))).hdus[0];
      const d = Float32Array.from(img, (v, i) => (v - bias[i] - 0.02 * EXP) / flat[i]);
      if (!red) red = createReducer({ stars: chooseStars(d, W, H).stars, target: tg, site: site2, timeAt: 'start', psf: 'gaussian', optimal: true });
      red.add({ data: d, width: W, height: H, header: f.header, comments: f.comments, name: 'f' + k });
    }
    const M = red.result().M, o = optimise(M, { fit: { gain: 1 }, psf: true, weighted: true, fitter: null }), L = o.lc;
    const idx = []; for (let i = 0; i < L.time.length; i++) if ((!L.keep || L.keep[i]) && Number.isFinite(L.norm[i]) && Number.isFinite(L.fwhm[i])) idx.push(i);
    const tb = idx.reduce((a, i) => a + L.time[i], 0) / idx.length, fw0 = idx.reduce((a, i) => a + L.fwhm[i], 0) / idx.length;
    const X = idx.map((i) => [1, L.time[i] - tb, L.airmass[i] - 1, L.fwhm[i] - fw0, -(1 - pf(L.time[i]))]), y = idx.map((i) => L.norm[i]), K = 5;
    const G = Array.from({ length: K }, () => new Float64Array(K)), r = new Float64Array(K);
    X.forEach((row, n) => { for (let a = 0; a < K; a++) { r[a] += row[a] * y[n]; for (let b = 0; b < K; b++) G[a][b] += row[a] * row[b]; } });
    const A = G.map((row, i) => [...row, ...Array.from({ length: K }, (_, j) => (i === j ? 1 : 0))]);
    for (let a = 0; a < K; a++) { const pv = A[a][a]; for (let q = 0; q < 2 * K; q++) A[a][q] /= pv; for (let b = 0; b < K; b++) if (b !== a) { const f2 = A[b][a]; for (let q = 0; q < 2 * K; q++) A[b][q] -= f2 * A[a][q]; } }
    const inv = A.map((row) => row.slice(K)), c = inv.map((row) => row.reduce((a, v, j) => a + v * r[j], 0));
    const res = X.map((row, n) => y[n] - row.reduce((a, v, j) => a + v * c[j], 0)), sd = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / (res.length - K));
    const scale = c[4] / c[0], err = sd * Math.sqrt(inv[4][4]) / c[0];
    check(`WASP-121 b rehearsal, seed ${seed}: the depth recovered (flats, chooseStars, FWHM in the baseline)`, Math.abs(scale - 1) < 3 * err, `${scale.toFixed(3)} ± ${err.toFixed(3)} × the model's ${(100 * (1 - pf(pl.tmid))).toFixed(2)} %, ${idx.length} frames`);
  }
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
