// The header of a frame we take: everything a reduction needs later, computed here from the clock, the site, the
// target, the camera and the telescope, so that the browser (Run page), Python (esl.observe) and the tests write
// the same cards. No DOM. Pass the result to encodeFits (fits.js).
//
// Time: the exposure's start is the corrected clock (src/site/clock.js, esl.time) at the moment the camera
// started; DATE-OBS / DATE-END / DATE-AVG (UTC, ISO with milliseconds; TIMESYS = 'UTC'), MJD-OBS / MJD-AVG /
// MJD-END, JD_UTC and BJD_TDB at mid-exposure (BJD_TDB from utcToBjdTdb: 0.2 s; it is what frameTime reads
// first), LST and HA at mid-exposure, and how good the clock was: CLKSRC, CLKOFFS (the correction applied, s) and
// CLKUNC (s; left out when nothing checked the clock, with a COMMENT saying so).
// Site: SITELAT / SITELONG (deg, east positive) / SITEELEV (m) and OBSGEO-B/L/H (FITS WCS paper VII).
// Target: OBJECT, RA / DEC (deg, ICRS), OBJCTRA / OBJCTDEC (sexagesimal), RADESYS, EQUINOX, OBJCTALT / OBJCTAZ
// (geometric, deg), AIRMASS (sec z at mid-exposure, the definition EXOTIC uses), MOONSEP (deg).
// Camera and telescope: TELESCOP, INSTRUME, FILTER, IMAGETYP (Light Frame / Bias Frame / Dark Frame / Flat Field,
// what frameKind reads), GAIN, OFFSET, EGAIN, XBINNING / YBINNING, XPIXSZ / YPIXSZ (binned pixel, um), FOCALLEN,
// APTDIA (mm), CCD-TEMP, SET-TEMP, BAYERPAT / XBAYROFF / YBAYROFF / ROWORDER, READOUTM, PIERSIDE.
// WCS: a solved WCS (makeWcs(...).header()) when given; otherwise a TAN WCS from the pointing, the pixel scale and
// the camera angle (north up, east left at angle 0), marked WCSAPPRX = T and PLTSOLVD = F.
// Provenance: SWCREATE, DATE (file written), SEQID, SEQNAME, FRAMENO, OBSERVER, HISTORY.
// test/fitsheader.test.mjs reads the cards back with fits.js and compares the numbers with astropy.

import { jdFromMs, mjdFromJd } from './timescale.js';
import { utcToBjdTdb, airmassAt } from './fits.js';
import { lstHours, hourAngle, hms } from './timeformat.js';
import { altAz, moonAltAz } from './observability.js';

export const IMAGETYP = { light: 'Light Frame', bias: 'Bias Frame', dark: 'Dark Frame', flat: 'Flat Field' };
const D2R = Math.PI / 180;
const isoMs = (ms) => new Date(Math.round(ms)).toISOString().replace('Z', '');
const fin = Number.isFinite;

/** Right ascension [deg] as 'HH MM SS.ss'; declination [deg] as '+DD MM SS.s'. */
export const raText = (ra) => hms(((ra % 360) + 360) % 360 / 15, { decimals: 2 }).replace(/:/g, ' ');
export function decText(dec) {
  const s = dec < 0 ? '-' : '+', a = Math.abs(dec), tot = Math.round(a * 36000) / 10;
  const D = Math.floor(tot / 3600), M = Math.floor((tot - D * 3600) / 60), S = tot - D * 3600 - M * 60;
  return `${s}${String(D).padStart(2, '0')} ${String(M).padStart(2, '0')} ${S.toFixed(1).padStart(4, '0')}`;
}
/** Pixel scale [arcsec/px] of a binned pixel of `pixelUm` micrometres at focal length `focalMm`. */
export const pixelScaleArcsec = (pixelUm, focalMm) => 206.264806 * pixelUm / focalMm;

/**
 * A TAN WCS centred on (ra, dec) [deg] for a camera of width x height binned pixels of `scale` arcsec, turned by
 * `angle` degrees (position angle of the image's +y axis, east of north; 0 = north up, east left). FITS keywords.
 */
export function approximateWcs({ ra, dec, width, height, scale, angle = 0, flip = false }) {
  const s = scale / 3600, c = Math.cos(angle * D2R), n = Math.sin(angle * D2R), f = flip ? -1 : 1;
  return {
    WCSAXES: 2, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CUNIT1: 'deg', CUNIT2: 'deg', CRVAL1: ra, CRVAL2: dec,
    CRPIX1: (width + 1) / 2, CRPIX2: (height + 1) / 2,
    CD1_1: -s * c * f, CD1_2: s * n, CD2_1: s * n * f, CD2_2: s * c,
  };
}

/**
 * The cards of a frame, in order, for encodeFits.
 * @param o {
 *   exposure: { start (Unix ms, corrected clock), duration [s], kind: 'light'|'bias'|'dark'|'flat', filter },
 *   clock:    { source, label, offset [ms, applied], unc [ms] or null }   (clock.info() / esl.time Clock.info() in ms)
 *   site:     { name, lat, lon [deg east], elev [m] },
 *   target:   { name, ra, dec [deg ICRS] },
 *   camera:   { name, width, height, gain, offset, egain, binx, biny, pixelSize [um, unbinned], ccdTemp, setTemp, bayer: { pattern, xoff, yoff }, readoutMode },
 *   telescope:{ name, focalLength [mm], aperture [mm], angle [deg], flip },
 *   mount:    { ra, dec, pierSide: 'east'|'west' } (where the mount points; the target when absent),
 *   wcs:      FITS keywords of a solved WCS (makeWcs(...).header()), or null,
 *   sequence: { id, name, frame }, observer, software, written (Unix ms; default: start), history: [text]
 * }
 */
export function frameHeader(o) {
  const ex = o.exposure || {}, site = o.site || null, tg = o.target || null, cam = o.camera || {}, tel = o.telescope || {}, mount = o.mount || null, clk = o.clock || null;
  const kind = ex.kind || 'light', dur = kind === 'bias' ? (ex.duration || 0) : ex.duration;
  if (!fin(ex.start)) throw new Error('frameHeader: exposure.start (Unix ms) is required');
  if (!fin(dur) || dur < 0) throw new Error('frameHeader: exposure.duration [s] is required');
  const t0 = ex.start, tMid = t0 + dur * 500, t1 = t0 + dur * 1000, jdMid = jdFromMs(tMid);
  const C = [];
  const add = (k, v, c) => C.push([k, v, c]);

  // ---- time
  add('DATE-OBS', isoMs(t0), 'UTC start of exposure');
  add('DATE-AVG', isoMs(tMid), 'UTC mid-exposure');
  add('DATE-END', isoMs(t1), 'UTC end of exposure');
  add('TIMESYS', 'UTC', 'time scale of DATE-xxx, MJD-xxx and JD_UTC');
  add('TIMEUNIT', 's', 'unit of EXPTIME');
  add('EXPTIME', dur, '[s] exposure time');
  add('EXPOSURE', dur, '[s] exposure time');
  add('MJD-OBS', mjdFromJd(jdFromMs(t0)), '[d] MJD (UTC) at start of exposure');
  add('MJD-AVG', mjdFromJd(jdMid), '[d] MJD (UTC) at mid-exposure');
  add('MJD-END', mjdFromJd(jdFromMs(t1)), '[d] MJD (UTC) at end of exposure');
  add('JD_UTC', jdMid, '[d] Julian date (UTC) at mid-exposure');
  const ra = tg && fin(tg.ra) ? tg.ra : mount && fin(mount.ra) ? mount.ra : NaN, dec = tg && fin(tg.dec) ? tg.dec : mount && fin(mount.dec) ? mount.dec : NaN;
  if (fin(ra) && fin(dec)) add('BJD_TDB', utcToBjdTdb(jdMid, ra, dec), '[d] BJD_TDB at mid-exposure (geocentric, 0.2 s)');
  if (site && fin(site.lon)) {
    add('LST', hms(lstHours(tMid, site.lon), { decimals: 1 }), 'local apparent sidereal time at mid-exposure');
    if (fin(ra)) add('HA', hms(hourAngle(tMid, site.lon, ra), { sign: true, decimals: 1 }).replace('−', '-'), 'hour angle of RA at mid-exposure');
  }
  if (clk && clk.source && clk.source !== 'system' && fin(clk.unc)) {
    add('CLKSRC', clk.label || clk.source, 'reference clock of the exposure times');
    add('CLKOFFS', Math.round((clk.offset || 0)) / 1000, '[s] correction applied to the computer clock');
    add('CLKUNC', Math.round(Math.max(clk.unc, 0.001) * 1000) / 1e6, '[s] bound on the clock error');
  } else {
    add('CLKSRC', 'system', 'computer clock, not checked against a reference');
    add('COMMENT', 'The exposure times come from the computer clock without a check; their error is unknown.');
  }

  // ---- site
  if (site) {
    if (site.name) add('OBSERVAT', site.name, 'observatory');
    if (fin(site.lat) && fin(site.lon)) {
      add('SITELAT', site.lat, '[deg] geodetic latitude');
      add('SITELONG', site.lon, '[deg] longitude, east positive');
      add('SITEELEV', fin(site.elev) ? site.elev : 0, '[m] elevation');
      add('OBSGEO-B', site.lat, '[deg] geodetic latitude (WGS84)');
      add('OBSGEO-L', site.lon, '[deg] geodetic longitude, east positive');
      add('OBSGEO-H', fin(site.elev) ? site.elev : 0, '[m] height above the ellipsoid (taken as the elevation)');
    }
  }

  // ---- target and pointing
  if (tg && tg.name) add('OBJECT', tg.name, 'target');
  if (fin(ra) && fin(dec)) {
    add('RA', ra, '[deg] right ascension of the target (ICRS)');
    add('DEC', dec, '[deg] declination of the target (ICRS)');
    add('OBJCTRA', raText(ra), '[h m s] right ascension (ICRS)');
    add('OBJCTDEC', decText(dec), '[d m s] declination (ICRS)');
    add('RADESYS', 'ICRS', 'reference frame of RA, DEC and the WCS');
    add('EQUINOX', 2000.0, 'equinox of the coordinates');
    if (site && fin(site.lat) && fin(site.lon)) {
      const s = { lat: site.lat, lon: site.lon, elev: site.elev || 0 }, h = altAz(ra, dec, jdMid, s);
      add('OBJCTALT', Math.round(h.alt * 1e4) / 1e4, '[deg] geometric altitude at mid-exposure');
      add('OBJCTAZ', Math.round(h.az * 1e4) / 1e4, '[deg] azimuth (N=0, E=90) at mid-exposure');
      const am = airmassAt(jdMid, ra, dec, site.lat, site.lon);
      if (fin(am)) add('AIRMASS', Math.round(am * 1e5) / 1e5, 'sec(z) at mid-exposure');
      const m = moonAltAz(jdMid, s);
      if (m && fin(m.alt)) {
        const sep = Math.acos(Math.max(-1, Math.min(1, Math.sin(h.alt * D2R) * Math.sin(m.alt * D2R) + Math.cos(h.alt * D2R) * Math.cos(m.alt * D2R) * Math.cos((h.az - m.az) * D2R)))) / D2R;
        add('MOONSEP', Math.round(sep * 100) / 100, '[deg] angle to the Moon');
      }
    }
  }
  if (mount && mount.pierSide) add('PIERSIDE', String(mount.pierSide).toUpperCase(), 'side of the pier the telescope is on');

  // ---- telescope, camera
  if (tel.name) add('TELESCOP', tel.name, 'telescope');
  if (cam.name) add('INSTRUME', cam.name, 'camera');
  add('IMAGETYP', IMAGETYP[kind] || kind, 'type of frame');
  if (ex.filter) add('FILTER', ex.filter, 'filter');
  const bx = cam.binx || 1, by = cam.biny || bx;
  add('XBINNING', bx, 'binning in x'); add('YBINNING', by, 'binning in y');
  if (fin(cam.pixelSize)) { add('XPIXSZ', cam.pixelSize * bx, '[um] binned pixel size in x'); add('YPIXSZ', (cam.pixelSizeY || cam.pixelSize) * by, '[um] binned pixel size in y'); }
  if (fin(tel.focalLength)) add('FOCALLEN', tel.focalLength, '[mm] focal length');
  if (fin(tel.aperture)) add('APTDIA', tel.aperture, '[mm] aperture diameter');
  if (fin(cam.gain)) add('GAIN', cam.gain, 'camera gain setting');
  if (fin(cam.offset)) add('OFFSET', cam.offset, 'camera offset (pedestal) setting');
  if (fin(cam.egain)) add('EGAIN', cam.egain, '[e-/ADU] electrons per ADU at this gain');
  if (fin(cam.ccdTemp)) add('CCD-TEMP', Math.round(cam.ccdTemp * 100) / 100, '[C] sensor temperature at start');
  if (fin(cam.setTemp)) add('SET-TEMP', cam.setTemp, '[C] cooler set point');
  if (cam.readoutMode != null) add('READOUTM', String(cam.readoutMode), 'readout mode');
  if (cam.bayer && cam.bayer.pattern) {
    add('BAYERPAT', cam.bayer.pattern, 'colour filter array at (0,0),(1,0),(0,1),(1,1)');
    add('XBAYROFF', cam.bayer.xoff || 0, 'Bayer offset in x'); add('YBAYROFF', cam.bayer.yoff || 0, 'Bayer offset in y');
    add('ROWORDER', 'TOP-DOWN', 'first row of data is the top of the image');
  }

  // ---- WCS
  const W = cam.width || o.width, H = cam.height || o.height;
  if (o.wcs) {
    for (const [k, v] of Object.entries(o.wcs)) if (k !== 'RADESYS' && k !== 'EQUINOX') add(k, v);
    add('PLTSOLVD', true, 'the WCS comes from a plate solution');
  } else if (fin(ra) && fin(dec) && fin(cam.pixelSize) && fin(tel.focalLength) && W > 0 && H > 0) {
    const w = approximateWcs({ ra: mount && fin(mount.ra) ? mount.ra : ra, dec: mount && fin(mount.dec) ? mount.dec : dec, width: W, height: H, scale: pixelScaleArcsec(cam.pixelSize * bx, tel.focalLength), angle: tel.angle || 0, flip: !!tel.flip });
    for (const [k, v] of Object.entries(w)) add(k, v);
    add('WCSAPPRX', true, 'WCS from pointing, pixel scale and camera angle only');
    add('PLTSOLVD', false, 'not plate-solved');
  }

  // ---- provenance
  if (o.observer) add('OBSERVER', o.observer, 'observer');
  add('SWCREATE', o.software || 'Exoplanet Science Lab', 'software that wrote this file');
  add('DATE', isoMs(fin(o.written) ? o.written : t1), 'UTC date the file was written');
  if (o.sequence) {
    if (o.sequence.id) add('SEQID', String(o.sequence.id), 'observing sequence');
    if (o.sequence.name) add('SEQNAME', o.sequence.name, 'observing sequence name');
    if (fin(o.sequence.frame)) add('FRAMENO', o.sequence.frame, 'frame number in the sequence');
  }
  for (const h of o.history || []) add('HISTORY', h);
  return C;
}

/** The cards as an object { KEY: value } (COMMENT / HISTORY joined), e.g. to compare with a parsed header. */
export function cardsToObject(cards) {
  const o = {};
  for (const [k, v] of cards) { if (k === 'COMMENT' || k === 'HISTORY') o[k] = (o[k] ? o[k] + '\n' : '') + v; else o[k] = v; }
  return o;
}
