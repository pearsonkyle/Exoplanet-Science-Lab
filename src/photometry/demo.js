// A synthetic night for ?demo=2: frames built in memory as real FITS bytes, so they go through exactly the same
// path as a folder of files. A field with a target and comparison stars, guiding drift with a jump, seeing that
// changes, airmass extinction, thin cloud (2% transparency changes), and a 1.2% transit on the target.
import { encodeFitsImage } from '../core/fits.js';
import { addStars, addNoise, trapezoid } from '../core/photometry.js';
import { makeRng } from '../core/stats.js';

export const DEMO_TRUTH = { depth: 0.012, duration: 0.07, target: { x: 162.4, y: 118.7 }, comps: [{ x: 76.2, y: 171.3 }, { x: 236.8, y: 66.1 }, { x: 251.3, y: 182.6 }, { x: 58.4, y: 54.9 }] };

export function makeDemoFrames(n = 72, W = 320, H = 240) {
  const rng = makeRng(42), files = [], T = DEMO_TRUTH;
  const stars = [{ ...T.target, flux: 160000 }, { ...T.comps[0], flux: 210000 }, { ...T.comps[1], flux: 120000 }, { ...T.comps[2], flux: 70000 }, { ...T.comps[3], flux: 300000 }];
  for (let i = 0; i < 28; i++) stars.push({ x: 12 + rng.next() * (W - 24), y: 12 + rng.next() * (H - 24), flux: 1500 * Math.exp(2.2 * rng.next()) });
  const jd0 = 2460310.62, span = 0.19, tmid = jd0 + 0.105, frame = new Float32Array(W * H);
  T.tmidJd = tmid;
  for (let f = 0; f < n; f++) {
    const u = f / (n - 1), jd = jd0 + span * u, am = 1.08 + 0.55 * u * u, sig = 1.8 + 0.5 * u + 0.15 * Math.sin(f / 5);
    const tr = Math.exp(-0.22 * (am - 1.08)) * (1 + 0.02 * rng.normal());
    const dx = 3.5 * u + (f >= 40 ? 2.6 : 0) + 0.25 * Math.sin(f / 4), dy = -2.2 * u + (f >= 40 ? -1.9 : 0) + 0.2 * Math.cos(f / 6);
    const inT = 1 - T.depth * trapezoid(jd + 15 / 86400, tmid, T.duration);
    frame.fill(380 + 60 * u);
    addStars(frame, W, H, stars.map((s, k) => ({ x: s.x + dx, y: s.y + dy, flux: s.flux * tr * (k === 0 ? inT : 1), sigma: sig })));
    addNoise(frame, rng, 7, 1);
    const d = new Date((jd - 2440587.5) * 86400000).toISOString().replace('Z', '');
    const bytes = encodeFitsImage(frame, W, H, { 'DATE-OBS': [d, 'UTC at start of exposure'], EXPTIME: [30, 'seconds'], AIRMASS: +am.toFixed(4), OBJECT: 'ESL demo field', OBJCTRA: '06 30 32.79', OBJCTDEC: '+29 40 20.3', IMAGETYP: 'Light Frame', FILTER: 'R' }, 16);
    files.push(new File([bytes], `demo_${String(f + 1).padStart(3, '0')}.fits`));
  }
  return files;
}
