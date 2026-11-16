// HEALPix in the NESTED scheme (Górski et al. 2005, ApJ 622, 759), as much of it as reading HiPS tiles needs: which
// pixel holds a direction, the centre of a pixel, and where a direction falls inside a HiPS tile (Fernique et al.
// 2017, IVOA HiPS 1.0). Pure: no DOM, no network. Angles in degrees (RA, Dec ICRS); orders up to 29 for ang2xyf, but a
// full nested index is only formed below order 26 (Number is exact to 2^53).
//
// Face coordinates (ix, iy) are those of the HEALPix C++ library (healpix_base.cc): in each of the 12 base faces
// (0, 0) is the southern corner, ix grows toward the north-east and iy toward the north-west; the nested index
// interleaves the bits of ix (even bits) and iy (odd bits).

const D2R = Math.PI / 180, TWO_THIRDS = 2 / 3, HALF_PI = Math.PI / 2;
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

/** Spread the low 26 bits of v to the even bits (exact in Number arithmetic). */
function spread(v) { let r = 0, b = 1; for (let i = 0; v > 0 && i < 27; i++, v = Math.floor(v / 2), b *= 4) if (v % 2) r += b; return r; }
/** Gather the even bits of v (the inverse of spread). */
function gather(v) { let r = 0, b = 1; for (let i = 0; v > 0 && i < 27; i++, v = Math.floor(v / 4), b *= 2) if (v % 2) r += b; return r; }

/** Face and face coordinates of a direction at an order: { face, ix, iy } (0 <= ix, iy < 2^order). */
export function ang2xyf(order, ra, dec) {
  const nside = 2 ** order, z = Math.sin(dec * D2R), za = Math.abs(z);
  let phi = (ra * D2R) % (2 * Math.PI); if (phi < 0) phi += 2 * Math.PI;
  let tt = phi / HALF_PI; if (tt >= 4) tt -= 4;
  if (za <= TWO_THIRDS) {
    // the equatorial belt: the two families of edge lines through the direction pick the face
    const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2), jm = Math.floor(t1 + t2), ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    const face = ifp === ifm ? (ifp % 4) + 4 : ifp < ifm ? ifp % 4 : (ifm % 4) + 8;
    return { face, ix: ((jm % nside) + nside) % nside, iy: nside - (((jp % nside) + nside) % nside) - 1 };
  }
  // the polar caps; sqrt(3(1 - |z|)) from cos(dec) so that it keeps its precision near the poles
  const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, cd = Math.cos(dec * D2R);
  const tmp = nside * (cd * Math.sqrt(3) / Math.sqrt(1 + za));     // = nside sqrt(3 (1 - za))
  const jp = Math.min(nside - 1, Math.floor(tp * tmp)), jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
  return z >= 0 ? { face: ntt, ix: nside - jm - 1, iy: nside - jp - 1 } : { face: ntt + 8, ix: jp, iy: jm };
}
/** Nested index from face coordinates (order <= 25). */
export const xyf2nest = (order, { face, ix, iy }) => face * 4 ** order + spread(ix) + 2 * spread(iy);
/** Face coordinates of a nested index. */
export function nest2xyf(order, pix) { const npf = 4 ** order, face = Math.floor(pix / npf), p = pix - face * npf; return { face, ix: gather(p), iy: gather(Math.floor(p / 2)) }; }
/** The nested pixel that holds a direction (order <= 25). */
export const ang2pixNest = (order, ra, dec) => xyf2nest(order, ang2xyf(order, ra, dec));
/** Centre of a nested pixel: [ra (0..360), dec] in degrees. */
export function pix2angNest(order, pix) {
  const nside = 2 ** order, { face, ix, iy } = nest2xyf(order, pix), jr = JRLL[face] * nside - ix - iy - 1;
  let nr, z, kshift;
  if (jr < nside) { nr = jr; z = 1 - nr * nr / (3 * nside * nside); kshift = 0; }
  else if (jr > 3 * nside) { nr = 4 * nside - jr; z = -(1 - nr * nr / (3 * nside * nside)); kshift = 0; }
  else { nr = nside; z = (2 * nside - jr) * 2 / (3 * nside); kshift = (jr - nside) & 1; }
  let jp = (JPLL[face] * nr + ix - iy + 1 + kshift) / 2;
  if (jp > 4 * nside) jp -= 4 * nside; if (jp < 1) jp += 4 * nside;
  const phi = (jp - (kshift + 1) * 0.5) * (HALF_PI / nr);
  return [phi / D2R, Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}
/** Number of pixels at an order. */
export const npixOf = (order) => 12 * 4 ** order;
/** Mean pixel size at an order, arcsec (the square root of the pixel area). */
export const pixelSizeArcsec = (order) => Math.sqrt(Math.PI / 3) / 2 ** order / D2R * 3600;

// ---------------------------------------------------------------------------------------------------------
// HiPS tiles

/**
 * Where a direction falls in the HiPS tiles of an order: { tile (nested index of the tile at that order), col, row }.
 * A tile of width W = 2^m pixels at order k holds the pixels of order k + m below it. In the JPEG or PNG (row 0 at
 * the top) the tile's southern corner is the top left, its northern corner the bottom right, east the bottom left
 * and west the top right: pixel (col, row) is face coordinate (ix, iy) = (row, col) inside the tile (as Aladin Lite
 * maps the corners of a tile). Checked against a SkyView DSS2 image of the same field (docs/guide/validation.md).
 */
export function hipsLocate(order, tileWidth, ra, dec) {
  const m = Math.round(Math.log2(tileWidth)), K = order + m, f = ang2xyf(K, ra, dec), W = tileWidth;
  const tx = Math.floor(f.ix / W), ty = Math.floor(f.iy / W);
  return { tile: f.face * 4 ** order + spread(tx) + 2 * spread(ty), col: f.iy - ty * W, row: f.ix - tx * W };
}
/** The URL of a HiPS tile: <base>/Norder<k>/Dir<D>/Npix<n>.<ext>, D = 10000 floor(n / 10000). */
export const hipsTileUrl = (base, order, tile, ext = 'jpg') => `${base.replace(/\/$/, '')}/Norder${order}/Dir${Math.floor(tile / 10000) * 10000}/Npix${tile}.${ext}`;
/**
 * The tile order to read for an image of a pixel scale (arcsec per pixel): the lowest order whose pixels are no
 * larger than the image's, within [minOrder, maxOrder] (the survey's hips_order).
 */
export function hipsOrderFor(scaleArcsec, tileWidth, maxOrder, minOrder = 3) {
  const m = Math.round(Math.log2(tileWidth));
  for (let k = minOrder; k <= maxOrder; k++) if (pixelSizeArcsec(k + m) <= scaleArcsec) return k;
  return maxOrder;
}
