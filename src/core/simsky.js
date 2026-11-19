// A simulated camera's sky: a star field with a target that transits, seen through a changing atmosphere, with
// guiding drift, read noise, bias, dark current and flats. Frames are functions of the (corrected) time, so a
// simulated observing sequence behaves like a night: the Run page's simulated camera and the end-to-end test use
// it; the injected truth comes back in `truth` for the checks. No DOM.

import { addStars, addNoise, trapezoid } from './photometry.js';
import { airmassAt } from './fits.js';
import { jdFromMs } from './timescale.js';
import { makeRng } from './stats.js';

/**
 * @param o { width = 320, height = 240, seed = 7, tmid (Unix ms of mid-transit), depth = 0.01, duration [h] = 2,
 *            target: { ra, dec }, site: { lat, lon } (airmass; else 1.2 fixed), bias = 300, dark = 0.02 [ADU/s/px],
 *            read = 6 [ADU], gain = 1 [e-/ADU], sky = 8 [ADU/s/px], flux = 4000 [ADU/s of the target], seeing = 1.8 [px sigma],
 *            drift = [dx, dy] px per hour from t0 (default tmid - 3 h), maxAdu = 65535, comps = 4, field = 30,
 *            centre: false (true: the target at the centre of the frame at t0), clear = 0 (px around the target kept free of field stars),
 *            lightCurve: null | (ms) -> relative flux of the target at mid-exposure (e.g. rehearsal.js fluxAtUtc of a real
 *                        planet); replaces the trapezoid of depth / duration,
 *            tracking: null | 'good' | 'average' | 'poor' | { walk [px/sqrt(h)], pe [px, periodic error amplitude], period [s],
 *                      jitter [px rms within an exposure], jumps [per hour], jump [px] } }
 * The tracking error is a function of time (seeded): pointing(ms) gives the true offset of the field at a time,
 * frame() averages it over the exposure (the stars move by it) and blurs the stars by its spread in the exposure.
 * @returns { width, height, truth, frame(kind, startMs, exptime, index) -> Float32Array }
 */
export function createSimSky(o = {}) {
  const W = o.width || 320, H = o.height || 240, seed = o.seed ?? 7, rng0 = makeRng(seed);
  const depth = o.depth ?? 0.01, durH = o.duration ?? 2, tmid = o.tmid ?? Date.now() + 3600e3;
  const bias = o.bias ?? 300, dark = o.dark ?? 0.02, read = o.read ?? 6, gain = o.gain ?? 1, sky = o.sky ?? 8, flux = o.flux ?? 4000;
  const seeing = o.seeing ?? 1.8, drift = o.drift || [1.2, -0.8], maxAdu = o.maxAdu ?? 65535;
  const target = { x: o.centre ? (W - 1) / 2 : W * 0.52, y: o.centre ? (H - 1) / 2 : H * 0.48, flux, k: 0 };          // centre: where a pointed mount puts it
  const stars = [target];
  const nComp = o.comps ?? 4;
  for (let i = 0; i < nComp; i++) {                       // comparison stars of similar brightness, away from the edges and the target
    let x, y;
    do { x = 0.12 * W + rng0.next() * 0.76 * W; y = 0.12 * H + rng0.next() * 0.76 * H; } while (Math.hypot(x - target.x, y - target.y) < 0.15 * Math.min(W, H));
    stars.push({ x, y, flux: flux * (0.6 + 1.2 * rng0.next()), k: i + 1 });
  }
  // field stars; none within `clear` px of the target (default 0: anywhere). A rehearsal of a real planet keeps the
  // target clear: its real neighbours are not simulated, and an invented blend only dilutes the transit (2026-11-19)
  const clear = o.clear ?? 0;
  for (let i = 0; i < (o.field ?? 30); i++) {
    let x, y, tries = 0;
    do { x = 8 + rng0.next() * (W - 16); y = 8 + rng0.next() * (H - 16); } while (clear > 0 && Math.hypot(x - target.x, y - target.y) < clear && ++tries < 50);
    stars.push({ x, y, flux: flux * 0.02 * Math.exp(3 * rng0.next()), k: -1 });
  }
  const t0 = o.t0 ?? tmid - 3 * 3600e3;
  const track = trackingModel(o.tracking, t0, seed);
  const truth = { tmid, depth, duration: durH / 24, target: { x: target.x, y: target.y }, comps: stars.slice(1, 1 + nComp).map((s) => ({ x: s.x, y: s.y })), t0 };
  const airmass = (ms) => {
    if (o.site && o.target) { const a = airmassAt(jdFromMs(ms), o.target.ra, o.target.dec, o.site.lat, o.site.lon); return Number.isFinite(a) && a < 10 ? a : 10; }
    return 1.2;
  };
  const vignette = (x, y) => 1 - 0.12 * (((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2);

  function frame(kind, startMs, exptime, index = 0) {
    const rng = makeRng(seed * 7919 + index * 104729 + 13), img = new Float32Array(W * H);
    if (kind === 'bias') { img.fill(bias); addNoise(img, rng, read, 1e9); return clip(img); }
    if (kind === 'dark') { img.fill(bias + dark * exptime); addNoiseAbove(img, rng, read, gain, bias); return clip(img); }
    if (kind === 'flat') {
      const level = 25000;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y * W + x] = level * vignette(x, y);
      addNoiseAbove(img, rng, read, gain, 0);
      for (let i = 0; i < img.length; i++) img[i] += bias;
      return clip(img);
    }
    const mid = startMs + exptime * 500, hrs = (mid - t0) / 3600e3, am = airmass(mid);
    const ext = Math.exp(-0.25 * (am - 1)) * (1 + 0.01 * Math.sin(hrs * 7.3) + 0.004 * rng.normal());
    const tr = track.over(startMs, exptime);
    const sig = Math.sqrt((seeing * (1 + 0.15 * Math.sin(hrs * 2.1)) * am ** 0.6) ** 2 + tr.blur ** 2);
    const dx = drift[0] * hrs + 0.2 * Math.sin(hrs * 40) + tr.dx, dy = drift[1] * hrs + 0.2 * Math.cos(hrs * 37) + tr.dy;
    lastPointing = { dx, dy, sigma: sig, blur: tr.blur, airmass: am, transparency: ext, mid };
    const inT = o.lightCurve ? o.lightCurve(mid) : 1 - depth * trapezoid(mid, tmid, durH * 3600e3);
    img.fill(sky * am * exptime);
    addStars(img, W, H, stars.map((s) => ({ x: s.x + dx, y: s.y + dy, flux: s.flux * exptime * ext * (s.k === 0 ? inT : 1), sigma: sig })));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y * W + x] *= vignette(x, y);     // sky and stars through the same optics as the flats
    for (let i = 0; i < img.length; i++) img[i] += dark * exptime;
    addNoiseAbove(img, rng, read, gain, 0);
    for (let i = 0; i < img.length; i++) img[i] += bias;
    return clip(img);
  }
  const clip = (img) => { for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(maxAdu, Math.round(img[i]))); return img; };
  // shot noise on the signal (above `base`) and read noise
  function addNoiseAbove(img, rng, rd, g, base) { for (let i = 0; i < img.length; i++) { const s = Math.max(0, img[i] - base); img[i] += Math.sqrt(rd * rd + s / g) * rng.normal(); } }
  let lastPointing = null;
  return { width: W, height: H, truth, frame, airmass, stars, tracking: track, get last() { return lastPointing; } };
}

const TRACKING = {
  good: { walk: 0.3, pe: 0.4, period: 480, jitter: 0.15, jumps: 0, jump: 0 },
  average: { walk: 1.0, pe: 1.5, period: 480, jitter: 0.4, jumps: 0.5, jump: 5 },
  poor: { walk: 2.5, pe: 3.5, period: 300, jitter: 1.0, jumps: 2, jump: 9 },
};
export const TRACKING_PRESETS = Object.keys(TRACKING);

/**
 * A mount's tracking error as a function of time: a random walk (wind, cable drag, polar misalignment that the
 * guider leaves), the periodic error of the worm gear, fast jitter (wind shake, seeing-driven guiding), and jumps
 * (a guide star lost and found, a bump). Deterministic for a seed. at(ms) -> { dx, dy } [px];
 * over(start, exptime) -> the mean offset over an exposure and the rms spread inside it (which blurs the stars).
 */
export function trackingModel(spec, t0 = 0, seed = 1) {
  const p = typeof spec === 'string' ? TRACKING[spec] : spec;
  if (!p) return { at: () => ({ dx: 0, dy: 0 }), over: () => ({ dx: 0, dy: 0, blur: 0 }), spec: null };
  const rng = makeRng(seed * 31 + 17), STEP = 30e3, N = 24 * 3600e3 / STEP;      // a walk on a 30 s grid, a day long
  const wx = new Float64Array(N + 1), wy = new Float64Array(N + 1), jx = new Float64Array(N + 1), jy = new Float64Array(N + 1);
  const sd = p.walk * Math.sqrt(STEP / 3600e3), pj = (p.jumps || 0) * STEP / 3600e3;
  for (let i = 1; i <= N; i++) {
    wx[i] = 0.98 * wx[i - 1] + sd * rng.normal(); wy[i] = 0.98 * wy[i - 1] + sd * rng.normal();      // a guider pulls the walk back slowly
    jx[i] = jx[i - 1]; jy[i] = jy[i - 1];
    if (rng.next() < pj) { const a = rng.next() * 2 * Math.PI, r = p.jump * (0.6 + 0.8 * rng.next()); jx[i] += r * Math.cos(a); jy[i] += r * Math.sin(a); }
  }
  const phase = rng.next() * 2 * Math.PI;
  const at = (ms) => {
    const u = Math.max(0, Math.min(N - 1e-9, (ms - t0) / STEP)), i = Math.floor(u), f = u - i;
    const pe = p.pe * Math.sin(2 * Math.PI * (ms - t0) / 1000 / p.period + phase);                    // the worm turns in right ascension (x)
    return { dx: wx[i] + f * (wx[i + 1] - wx[i]) + jx[i] + pe, dy: wy[i] + f * (wy[i + 1] - wy[i]) + jy[i] };
  };
  const over = (start, exptime) => {
    const n = 9, pts = Array.from({ length: n }, (_, k) => at(start + (k + 0.5) / n * exptime * 1000));
    const mx = pts.reduce((s, q) => s + q.dx, 0) / n, my = pts.reduce((s, q) => s + q.dy, 0) / n;
    const spread = Math.sqrt(pts.reduce((s, q) => s + (q.dx - mx) ** 2 + (q.dy - my) ** 2, 0) / (2 * n));
    const r = makeRng(seed * 7 + Math.floor(start / 1000));                                         // the same exposure, the same shake
    return { dx: mx + p.jitter * 0.3 * r.normal(), dy: my + p.jitter * 0.3 * r.normal(), blur: Math.hypot(spread, p.jitter) };
  };
  return { at, over, spec: p };
}
