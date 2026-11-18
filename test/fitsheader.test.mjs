// Frames we write (src/core/fitsheader.js + encodeFits in src/core/fits.js) against astropy, and read back with
// our own readers. test/fitsheader_reference.json (test/make_fitsheader_reference.py, .venv-phot: astropy 6.0.1)
// holds astropy's verify() of each file, the cards as astropy parsed them, and astropy's own MJD, BJD_TDB, LST,
// hour angle, altitude, azimuth, sec z, Moon separation and WCS pixel -> sky for the same instants and pixels.
import { readFileSync } from 'node:fs';
import { frameHeader, cardsToObject, approximateWcs, pixelScaleArcsec, raText, decText } from '../src/core/fitsheader.js';
import { encodeFits, headerLines, fitsAscii, parseFits, readImage, frameTime, framePointing, frameAirmass, pixelScale, readWcs, pierSide, bayerPattern, exposureTime } from '../src/core/fits.js';
import { CASES } from './fitsheader_sample.mjs';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const REF = JSON.parse(readFileSync(new URL('./fitsheader_reference.json', import.meta.url), 'utf8'));
const hours = (s) => { const neg = /^-/.test(s), [h, m, x] = s.replace(/^[-+]/, '').split(':').map(Number); return (neg ? -1 : 1) * (h + m / 60 + x / 3600); };
const wrap24 = (d) => Math.min(Math.abs(d), 24 - Math.abs(d));

let wMjd = 0, wJd = 0, wBjd = 0, wLst = 0, wHa = 0, wAlt = 0, wAz = 0, wAm = 0, wMoon = 0, wWcs = 0, wCards = [];
CASES.forEach((c, i) => {
  const R = REF.frames[i], cards = frameHeader(c), O = cardsToObject(cards);
  check(`${c.name}: astropy verify('exception') passes`, R.verify === 'ok', R.verify);
  // every card as astropy read it is the value we wrote (strings with quotes, long strings, logicals, reals to the last bit)
  const diff = Object.entries(O).filter(([k]) => k !== 'COMMENT' && k !== 'HISTORY').filter(([k, v]) => R.cards[k] !== (typeof v === 'string' ? fitsAscii(v) : v));
  if (diff.length) wCards.push(c.name + ': ' + diff.map(([k, v]) => `${k} ${JSON.stringify(v)} vs ${JSON.stringify(R.cards[k])}`).join('; '));
  check(`${c.name}: HISTORY and COMMENT wrapped at spaces, read back whole`, (O.HISTORY || '').replace(/\n/g, ' ') === (R.history || []).join(' ') && (O.COMMENT || '').replace(/\n/g, ' ') === R.comment.join(' '));
  // the pixels
  const f = parseFits(encodeFits(Float64Array.from({ length: c.camera.width * c.camera.height }, (_, k) => (c.bitpix === -32 ? k * 0.25 - 3 : (k * 37) % 60000 + (c.bitpix === 32 ? -1000 : 0))), c.camera.width, c.camera.height, cards, { bitpix: c.bitpix }));
  const img = readImage(f), H = f.hdus[0].header;
  check(`${c.name}: BITPIX ${c.bitpix} pixels read back by fits.js and astropy (${R.dtype})`, [...img.data.slice(0, 6)].every((v, k) => v === R.first[k]) && R.shape[0] === c.camera.height && R.shape[1] === c.camera.width && (c.bitpix !== 16 || R.dtype === 'uint16'));
  // derived numbers against astropy
  wMjd = Math.max(wMjd, Math.abs(O['MJD-OBS'] - R.mjd_obs) * 86400, Math.abs(O['MJD-AVG'] - R.mjd_avg) * 86400);
  wJd = Math.max(wJd, Math.abs(O.JD_UTC - R.jd_avg) * 86400);
  wLst = Math.max(wLst, wrap24(hours(O.LST) - R.lst_hours) * 3600);
  if (c.target) {
    wBjd = Math.max(wBjd, Math.abs(O.BJD_TDB - R.bjd_tdb) * 86400);
    wHa = Math.max(wHa, wrap24(hours(O.HA) - R.ha_hours) * 3600);
    wAlt = Math.max(wAlt, Math.abs(O.OBJCTALT - R.alt)); wAz = Math.max(wAz, Math.abs(O.OBJCTAZ - R.az) * Math.cos(R.alt * Math.PI / 180));
    wAm = Math.max(wAm, Math.abs(O.AIRMASS / R.secz - 1)); wMoon = Math.max(wMoon, Math.abs(O.MOONSEP - R.moonsep));
  }
  if (R.wcs) { const W = readWcs(H); for (const p of R.wcs) { const [ra, dec] = W.pixToSky(p.x, p.y); wWcs = Math.max(wWcs, Math.hypot((ra - p.sky[0]) * Math.cos(dec * Math.PI / 180), dec - p.sky[1]) * 3600); } }
  // our readers find what we wrote
  const ft = frameTime(H, f.hdus[0].comments), fp = framePointing(H), fa = frameAirmass(H);
  if (c.target) check(`${c.name}: frameTime takes BJD_TDB at mid-exposure`, ft.scale === 'BJD_TDB' && ft.jd === O.BJD_TDB && ft.position === 'mid');
  else check(`${c.name}: frameTime takes the mid-exposure UTC time when there is no target`, ft.scale === 'UTC' && ft.position === 'mid' && Math.abs(ft.jd - O.JD_UTC) * 86400 < 1e-4, `${ft.keyword} (${ft.position}), ${(Math.abs(ft.jd - O.JD_UTC) * 86400e6).toFixed(1)} us from JD_UTC`);
  check(`${c.name}: framePointing (OBJCTRA/OBJCTDEC, rounded to 0.01 s / 0.1"), exposureTime, airmass read back`, fp.lat === c.site.lat && fp.lon === c.site.lon && (!c.target || (Math.abs(fp.ra - c.target.ra) * 3600 < 0.08 && Math.abs(fp.dec - c.target.dec) * 3600 < 0.06)) && exposureTime(H) === c.exposure.duration && (!c.target || fa.source === 'AIRMASS'));
  const ps = pixelScale(H);
  const expScale = pixelScaleArcsec(c.camera.pixelSize * (c.camera.binx || 1), c.telescope.focalLength);
  if (!c.wcs && c.target) check(`${c.name}: pixel scale from the approximate WCS = 206.265 XPIXSZ / FOCALLEN, and as astropy sees it`, Math.abs(ps.scale - expScale) < 1e-9 && R.wcs_scale_arcsec.every((v) => Math.abs(v - expScale) < 1e-9) && O.WCSAPPRX === true && O.PLTSOLVD === false, `${ps.scale.toFixed(4)}"/px (${ps.source})`);
});
check('every card astropy read equals the value written (strings, long strings with CONTINUE, quotes, logicals, reals)', wCards.length === 0, wCards.join(' | '));
check('MJD-OBS, MJD-AVG against astropy', wMjd < 1e-4, `largest ${(wMjd * 1e6).toFixed(1)} us`);
check('JD_UTC (mid-exposure) against astropy', wJd < 1e-4, `largest ${(wJd * 1e6).toFixed(1)} us`);
check('BJD_TDB against astropy (builtin ephemeris, geocentre)', wBjd < 0.25, `largest ${wBjd.toFixed(3)} s; utcToBjdTdb claims 0.2 s`);
check('LST card against astropy apparent sidereal time', wLst < 0.1, `largest ${wLst.toFixed(3)} s (card rounded to 0.1 s)`);
check('HA card against astropy', wHa < 0.1, `largest ${wHa.toFixed(3)} s`);
check('OBJCTALT / OBJCTAZ against astropy AltAz (no refraction)', wAlt < 0.02 && wAz < 0.02, `largest ${(wAlt * 3600).toFixed(1)}" in altitude, ${(wAz * 3600).toFixed(1)}" in azimuth; geometric, without aberration and nutation (20" each)`);
check('AIRMASS (sec z) against astropy', wAm < 5e-4, `largest relative difference ${wAm.toExponential(2)}`);
check('MOONSEP against astropy get_body("moon")', wMoon < 0.3, `largest ${wMoon.toFixed(3)} deg; low-precision Moon`);
check('WCS pixel -> sky: fits.js readWcs against astropy.wcs', wWcs < 1e-3, `largest ${(wWcs * 1000).toFixed(3)} mas over ${REF.frames.filter((r) => r.wcs).length} frames`);

// pieces
check('FITS text: symbols spelled out, accents dropped', fitsAscii('helper · gpsd ±1 ms, 5°, Ångström') === 'helper - gpsd +/-1 ms, 5deg, Angstrom', fitsAscii('helper · gpsd ±1 ms, 5°, Ångström'));
check('sexagesimal RA / Dec', raText(31.0428) === '02 04 10.27' && decText(46.6878) === '+46 41 16.1' && decText(-0.5) === '-00 30 00.0' && raText(359.99999) === '00 00 00.00');
check('approximate WCS: north up, east left at angle 0', (() => { const w = approximateWcs({ ra: 10, dec: 20, width: 100, height: 80, scale: 1.8 }); return w.CD1_1 === -0.0005 && w.CD2_2 === 0.0005 && w.CD1_2 === 0 && w.CRPIX1 === 50.5 && w.CRPIX2 === 40.5; })());
check('a key that is not a FITS keyword is refused', (() => { try { headerLines([['TOOLONGKEY', 1]]); return false; } catch (e) { return /not a FITS keyword/.test(e.message); } })());
check('a keyword twice is refused; NaN and null are left out', (() => { try { headerLines([['A', 1], ['A', 2]]); return false; } catch { return headerLines([['B', NaN], ['C', null]]).length === 0; } })());
check('the clock without a check: CLKSRC system and a COMMENT, no CLKUNC', (() => { const o = cardsToObject(frameHeader(CASES[2])); return o.CLKSRC === 'system' && !('CLKUNC' in o) && /error is unknown/.test(o.COMMENT); })());
check('a checked clock: CLKOFFS and CLKUNC in seconds', (() => { const o = cardsToObject(frameHeader(CASES[0])); return o.CLKOFFS === -4.998 && o.CLKUNC === 0.023 && /Date header/.test(o.CLKSRC); })());
check('pier side and Bayer pattern read back', (() => {
  const H0 = parseFits(encodeFits(new Float64Array(64 * 48), 64, 48, frameHeader(CASES[0]))).hdus[0].header, H1 = parseFits(encodeFits(new Float64Array(50 * 40), 50, 40, frameHeader(CASES[1]))).hdus[0].header;
  return pierSide(H0).side === 'west' && bayerPattern(H1).pattern === 'RGGB';
})());

process.exit(ok ? 0 : 1);
