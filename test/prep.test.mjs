// The photometry page's "Prepare for transit fitting" chain (src/photometry/prep.js) on real files: TrES-2 from the
// Kepler quarter 1 pixels (best aperture, lightkurve's default quality mask), split in two to stand for two sectors,
// prepared with the archive ephemeris; K2-3 from the K2 crop with PLD; a SPOC-layout light-curve table. The pieces are
// checked against wotan / EXOTIC / lightkurve in lcprep.test.mjs; here: that the chain keeps the transits, finds every
// window, and that stitching and per-sector numbers are consistent.
import { readFileSync } from 'node:fs';
import { partFromTpf, partFromLcFits, prepareParts, preparedCsv, windowCsvs, planetsForMask } from '../src/photometry/prep.js';
import { parseLightCurve } from '../src/core/data.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const load = (name) => { const b = readFileSync(new URL('./data/' + name, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const R = JSON.parse(readFileSync(new URL('./lcprep_reference.json', import.meta.url)));
const tres2 = { name: 'TrES-2 b', ...R.tres2.planet };

const P = await partFromTpf(load('kplr011446443-2009131105131_lpd-targ.fits.gz'), 'TrES-2 Q1');
check('a TPF becomes a part through the aperture search', P.t.length > 400 && P.aperture && P.mission === 'Kepler', `${P.t.length} cadences, aperture "${P.aperture}" (${P.npix} px)`);
// two halves as two "sectors" with different flux levels: per-sector flatten and the stitch must not care
const h = P.t.length >> 1, half = (a, b, s) => ({ ...P, name: `half ${s}`, sector: s, t: P.t.slice(a, b), f: Float64Array.from(P.f.slice(a, b), (v) => v * (s === 1 ? 1 : 1.37)), e: P.e.slice(a, b) });
const t0 = performance.now(), Rp = prepareParts([half(0, h, 1), half(h, P.t.length, 2)], [tres2], { window: 0.75, trimMinutes: 0 }), ms = performance.now() - t0;
const med = (a) => { const s = Float64Array.from(a).filter((v) => v === v).sort(); return s.length & 1 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };
const out = [], inn = []; for (let i = 0; i < Rp.n; i++) { if (Rp.masked[i]) { if (Math.abs(((Rp.t[i] - tres2.tmid) / tres2.per) - Math.round((Rp.t[i] - tres2.tmid) / tres2.per)) * tres2.per < Rp.planets[0].t14 / 4) inn.push(Rp.f[i]); } else out.push(Rp.f[i]); }
const depth = 1e6 * (med(out) - med(inn));
check('two parts with different levels flatten to one series around 1, transits kept', Math.abs(med(out) - 1) < 2e-4 && depth > 12500 && depth < 14000 && Rp.perPart.length === 2, `out-of-transit median ${med(out).toFixed(6)}, central depth ${depth.toFixed(0)} ppm (wotan on the whole quarter: ${R.tres2.depth_ppm.toFixed(0)} ppm); ${Rp.perPart.map((p) => `${p.name}: ${p.n} points, ${p.scatterPpm.toFixed(0)} ppm, CDPP ${p.cdppRaw.toFixed(0)} → ${p.cdppFlat.toFixed(1)} ppm`).join('; ')}; ${ms.toFixed(0)} ms`);
check('a window around every covered transit', Rp.windows.length === 4 && Rp.windows.every((w) => w.planet === 'TrES-2 b'), `${Rp.windows.length} windows, epochs ${Rp.windows.map((w) => w.epoch).join(', ')}`);
{
  const csv = preparedCsv(Rp, { windowsOnly: true }), d = parseLightCurve(csv, 'prep');
  const per = windowCsvs(Rp);
  check('the windows go to the analyzer as one CSV (BJD_TDB) and save as one CSV per transit', d.t.length === new Set(Rp.windows.flatMap((w) => w.idx)).size && d.timeStandard === 'bjd_tdb' && per.length === 4 && per.every((q) => q.text.split('\n').length > 10), `${d.t.length} points in ${Rp.windows.length} windows; files ${per.map((q) => q.name).join(', ')}`);
}
// the window chosen by injection on real data
{
  const A = prepareParts([P], [tres2], { window: 'auto', grid: [0.5, 0.75, 1, 1.5, 2], trimMinutes: 30 }), s = A.perPart[0];
  check('window chosen by injected transits on the TrES-2 quarter', [0.5, 0.75, 1, 1.5, 2].includes(s.window) && Object.keys(s.scan).length >= 3, `${s.window} d; ${Object.entries(s.scan).map(([k, v]) => `${k} d: ${(100 * v.depth_recovered).toFixed(0)}% at ${v.noise_ppm.toFixed(0)} ppm`).join(', ')}; ${s.trimmed} cadences trimmed after gaps, ${s.clipped} clipped`);
}
// K2 with PLD, then prepared
{
  const K = await partFromTpf(load('ktwo201367065-c01_crop_lpd-targ.fits.gz'), 'K2-3 C1', { k2: 'pld' });
  const k2b = { name: 'K2-3 b', per: 10.0546535, tmid: 2457165.32947, rprs: 0.0349, ars: 29.44, inc: 89.4 }, k2c = { name: 'K2-3 c', per: 24.646729, tmid: 2457329.85688, rprs: 0.02658, ars: 53.5, inc: 89.84 }, k2d = { name: 'K2-3 d', per: 44.55603, tmid: 2457271.78796, rprs: 0.02449, ars: 79.4, inc: 89.82 };
  const A = prepareParts([K], [k2b, k2c, k2d], { window: 1.0 });
  check('K2: PLD of the best aperture, then the transit-masked flatten; a window for every transit the crop covers', K.correction && K.correction.after < K.correction.before / 3 && A.windows.length >= 2, `CDPP ${K.correction.before.toFixed(0)} → ${K.correction.after.toFixed(1)} ppm by ${K.correction.method}; flattened ${A.perPart[0].cdppFlat.toFixed(1)} ppm; windows: ${A.windows.map((w) => `${w.planet} E${w.epoch} (${w.n} pts${w.overlaps.length ? ', overlaps ' + w.overlaps.join(' ') : ''})`).join(', ')}`);
}
// a light-curve table (SPOC layout)
{
  const L = await partFromLcFits(load('lc_tess_small.fits'), 'lc', { flux: 'pdcsap', quality: 'default' });
  check("light-curve tables use lightkurve's default quality mask (TESS: AttitudeTweak, ManualExclude dropped; Straylight kept)", L.t.length === 115 && L.dropped.quality === 2 && L.fluxColumn === 'PDCSAP_FLUX', `${L.t.length} kept, ${L.dropped.quality} flagged, ${L.dropped.nonfinite} blank`);
}
check('planets without a duration get one from the geometry, else 3 h (marked)', planetsForMask([{ per: 3, tmid: 0, rprs: 0.1, ars: 8, inc: 88 }, { per: 5, tmid: 1 }]).map((p) => p.t14Assumed).join() === 'false,true');
process.exit(ok ? 0 : 1);
