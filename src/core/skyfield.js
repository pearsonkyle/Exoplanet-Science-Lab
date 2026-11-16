// The geometry of a survey image of a target's field (the Observe page's "Survey image"): a gnomonic (TAN) plane
// about the target, north up and east to the left, the cells of a mosaic laid on it, separations and position angles,
// a scale bar, a detector outline, and the neighbours of the target in Gaia with their magnitude difference.
// Pure: no DOM, no network (src/sky/survey.js fetches and draws). The projection is platesolve.js's.
//
// Plane pixels (u, v): u to the right (west), v down (south), in image pixels of `scale` arcsec, origin on the target:
//   u = -xi / scale, v = -eta / scale, with (xi, eta) the standard coordinates of tanProject (xi east, eta north).
// A cell of N x N pixels centred on plane pixel (cu, cv) is the FITS image with CRVAL = the target,
// CRPIX1 = (N + 1) / 2 - cu, CRPIX2 = (N + 1) / 2 + cv, CDELT1 = -scale, CDELT2 = +scale (rows stored top-down).

import { tanProject, tanDeproject, separation } from './platesolve.js';
import { hipsLocate, hipsOrderFor } from './healpix.js';

const D2R = Math.PI / 180;
export { separation };

/** A plane about (ra0, dec0) with a pixel scale in arcsec: { ra0, dec0, scale, toPlane(ra, dec) -> [u, v], toSky(u, v) -> [ra, dec] }. */
export function makePlane(ra0, dec0, scale) {
  const s = scale / 3600;
  return {
    ra0, dec0, scale,
    toPlane(ra, dec) { const [xi, eta] = tanProject(ra, dec, ra0, dec0); return [-xi / s, -eta / s]; },
    toSky(u, v) { return tanDeproject(-u * s, -v * s, ra0, dec0); },
  };
}
/** The plane pixel at the centre of cell (i, j) of N pixels: i > 0 a cell to the east (left), j > 0 to the north (up). */
export const cellCentre = (i, j, N) => [-i * N, -j * N];
/** Pixel (col, row) of cell (i, j) (0-based, row 0 at the top) for a plane pixel, and back. */
export const planeToCell = (u, v, i, j, N) => { const [cu, cv] = cellCentre(i, j, N); return [u - cu + (N - 1) / 2, v - cv + (N - 1) / 2]; };
export const cellToPlane = (col, row, i, j, N) => { const [cu, cv] = cellCentre(i, j, N); return [col + cu - (N - 1) / 2, row + cv - (N - 1) / 2]; };
/** The FITS WCS of cell (i, j) (for hips2fits' wcs parameter and for a FITS header). */
export function cellWcs(plane, i, j, N) {
  const [cu, cv] = cellCentre(i, j, N), s = plane.scale / 3600;
  return { NAXIS1: N, NAXIS2: N, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: plane.ra0, CRVAL2: plane.dec0, CRPIX1: (N + 1) / 2 - cu, CRPIX2: (N + 1) / 2 + cv, CDELT1: -s, CDELT2: s, CUNIT1: 'deg', CUNIT2: 'deg', RADESYS: 'ICRS' };
}
/** The sky position of a cell's centre. */
export const cellCentreSky = (plane, i, j, N) => { const [cu, cv] = cellCentre(i, j, N); return plane.toSky(cu, cv); };

/** Position angle of (ra2, dec2) seen from (ra1, dec1), degrees east of north, 0..360. */
export function positionAngle(ra1, dec1, ra2, dec2) {
  const a = (ra2 - ra1) * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
  const pa = Math.atan2(Math.sin(a) * Math.cos(d2), Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(a)) / D2R;
  return (pa + 360) % 360;
}
/** An angle in arcsec as text: 12.3″, 4′ 05.0″, 1° 02′. */
export function angleText(arcsec) {
  const a = Math.abs(arcsec);
  if (a < 59.95) return `${a.toFixed(a < 10 ? 2 : 1)}″`;
  if (a < 3599.95) { const t = Math.round(a * 10), m = Math.floor(t / 600); return `${m}′ ${((t - 600 * m) / 10).toFixed(1).padStart(4, '0')}″`; }
  const t = Math.round(a / 6), d = Math.floor(t / 600); return `${d}° ${((t - 600 * d) / 10).toFixed(1).padStart(4, '0')}′`;
}
/** A measurement between two plane pixels: { sep (arcsec), pa (deg E of N), text }. */
export function measure(plane, p, q) {
  const [r1, d1] = plane.toSky(p[0], p[1]), [r2, d2] = plane.toSky(q[0], q[1]), sep = separation(r1, d1, r2, d2), pa = positionAngle(r1, d1, r2, d2);
  return { sep, pa, text: `${angleText(sep)} · PA ${pa.toFixed(1)}°` };
}

const BAR = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200];
/** The scale bar: the longest round angle no longer than maxPx screen pixels at `arcsecPerPx` on screen: { arcsec, px, label }. */
export function scaleBar(arcsecPerPx, maxPx) {
  let a = BAR[0]; for (const b of BAR) if (b / arcsecPerPx <= maxPx) a = b;
  return { arcsec: a, px: a / arcsecPerPx, label: a < 60 ? `${a}″` : a < 3600 ? `${a / 60}′` : `${a / 3600}°` };
}
/** A detector's field from its pixel scale (arcsec/px) and size in pixels: { w, h } in arcmin. */
export const cameraField = (pixScale, nx, ny) => ({ w: pixScale * nx / 60, h: pixScale * ny / 60 });
/** The four corners (plane pixels) of a w x h arcmin outline centred on the target, turned by rot degrees (east of north). */
export function outlineCorners(plane, w, h, rot = 0) {
  const hw = w * 30 / plane.scale, hh = h * 30 / plane.scale, c = Math.cos(rot * D2R), s = Math.sin(rot * D2R);
  // in (east, north) pixel units, rotated from north toward east, then to (u, v) = (-east, -north)
  return [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([e, n]) => { const E = e * c + n * s, N = -e * s + n * c; return [-E, -N]; });
}
/** Is a plane pixel inside a convex polygon of plane pixels? */
export function insidePolygon(p, poly) {
  let sign = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length], cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cr !== 0) { if (sign && Math.sign(cr) !== sign) return false; sign = Math.sign(cr); }
  }
  return true;
}

/**
 * The target among Gaia stars: the star nearest to the catalogue position within `radius` arcsec, the brighter of
 * two at similar distance (the catalogue position may be of another epoch). mag: a magnitude to prefer (V) or null.
 */
export function findTarget(stars, ra, dec, { radius = 6, mag = null } = {}) {
  let best = null, bestScore = Infinity;
  for (const s of stars) {
    const d = separation(ra, dec, s.ra, s.dec); if (d > radius) continue;
    const score = d / radius + (Number.isFinite(mag) && Number.isFinite(s.g) ? Math.abs(s.g - mag) / 2 : Number.isFinite(s.g) ? s.g / 40 : 1);
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}
/**
 * The neighbours of the target: each Gaia star with { sep (arcsec), pa, dG = G - G_target, comp }. comp: a possible
 * comparison star, its G within [dgMin, dgMax] of the target's, not flagged variable, farther than minSep arcsec, and
 * inside the outline when one is given (plane pixels).
 */
export function neighbours(stars, target, { dgMin = -1, dgMax = 1, minSep = 10, plane = null, outline = null } = {}) {
  const g0 = target && Number.isFinite(target.g) ? target.g : NaN, t = target || stars[0];
  return stars.map((s) => {
    const sep = separation(t.ra, t.dec, s.ra, s.dec), pa = positionAngle(t.ra, t.dec, s.ra, s.dec), dG = s.g - g0;
    const isTarget = s === target, inside = !outline || !plane || insidePolygon(plane.toPlane(s.ra, s.dec), outline);
    return { ...s, sep, pa, dG, isTarget, inside, comp: !isTarget && Number.isFinite(dG) && dG >= dgMin && dG <= dgMax && !s.variable && sep > minSep && inside };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Reprojection of HiPS tiles onto a cell

/**
 * What cell (i, j) of N pixels needs from a HiPS survey: the tile order, the tiles, and for each output pixel the
 * tile (index into `tiles`, -1 off the sky) and the offset row * W + col inside it. Nearest-pixel sampling.
 */
export function hipsCellMap(plane, i, j, N, { tileWidth = 512, maxOrder = 9 } = {}) {
  const order = hipsOrderFor(plane.scale, tileWidth, maxOrder), tiles = [], index = new Map();
  const which = new Int16Array(N * N), off = new Int32Array(N * N);
  for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
    const [u, v] = cellToPlane(col, row, i, j, N), [ra, dec] = plane.toSky(u, v), k = row * N + col;
    if (!Number.isFinite(ra)) { which[k] = -1; continue; }
    const h = hipsLocate(order, tileWidth, ra, dec);
    let t = index.get(h.tile); if (t == null) { t = tiles.length; tiles.push(h.tile); index.set(h.tile, t); }
    which[k] = t; off[k] = h.row * tileWidth + h.col;
  }
  return { order, tiles, which, off, tileWidth, N };
}

/**
 * A CDS hips2fits request for cell (i, j): the survey resampled by the service onto exactly the cell's WCS
 * (the `wcs` parameter, a JSON FITS header). format: jpg or png (fits for the pixel values).
 */
export function hips2fitsUrl(base, hipsId, wcs, format = 'jpg') {
  return `${base}?hips=${encodeURIComponent(hipsId)}&wcs=${encodeURIComponent(JSON.stringify(wcs))}&format=${format}`;
}
