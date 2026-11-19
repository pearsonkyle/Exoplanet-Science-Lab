// FITS reader for the cases photometry needs, with no dependency: primary image HDU, IMAGE extensions,
// BINTABLE extensions (TESS / Kepler target pixel files, TESScut cutouts), BITPIX 8/16/32/64/-32/-64,
// BSCALE/BZERO/BLANK, gzip through DecompressionStream, tile-compressed images (fpack, .fz: RICE_1, GZIP_1,
// GZIP_2, PLIO_1, NOCOMPRESS, quantised floats with every dither method), headers without END, cubes, Bayer
// frames. Also the time, exposure, airmass, pixel scale, WCS (TAN) and pier side keywords of a frame, and the
// UTC -> BJD_TDB conversion. The only import is the leap-second table (timescale.js). No DOM; runs in Node, in a page and in a worker.
// The aim is to open what astropy.io.fits opens for EXOTIC (fits.open(..., ignore_missing_end=True), first HDU
// with NAXIS != 0); test/fits.test.mjs compares each case with astropy (test/make_fits_variants.py).
//
// Not read: HCOMPRESS_1 tiles (a clear error), random groups, ASCII tables, WCS projections other than TAN
// and SIP distortion (its presence is reported), colour cubes stored as (H, W, 3) with the colour on NAXIS1.
//
// Pixel convention (same as astropy / photutils): data[y * width + x], x along NAXIS1, y along NAXIS2,
// both zero-based, the centre of the first pixel at (0, 0).

import { taiMinusUtc, tdbMinusUtc } from './timescale.js';

const BLOCK = 2880;
const ASCII = new TextDecoder('latin1');

/** True when the bytes start with the gzip magic number. */
export function isGzip(buf) { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf, 0, Math.min(2, buf.byteLength)); return u.length >= 2 && u[0] === 0x1f && u[1] === 0x8b; }

/** Decompress gzip bytes with the platform DecompressionStream (browsers, Node 18+). Returns an ArrayBuffer. */
export async function gunzip(buf) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress gzip (no DecompressionStream). Decompress the file first.');
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

/**
 * Parse FITS bytes (ArrayBuffer or Uint8Array), decompressing gzip first. Async because of gzip: both the
 * whole-file kind (.fits.gz) and the gzip tiles of a tile-compressed image, which are inflated here (unless
 * opts.inflate === false) so that the synchronous readImage can decode the image afterwards.
 */
export async function openFits(buf, opts = {}) {
  let ab = buf instanceof Uint8Array ? (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength ? buf.buffer : buf.slice().buffer) : buf;
  // a .fits.gz deflated inside a zip arrives gzip-wrapped twice (src/core/zip.js): unwrap up to three layers
  for (let k = 0; k < 3 && isGzip(ab); k++) ab = await gunzip(ab);
  const fits = parseFits(ab);
  if (opts.inflate !== false) await inflateTiles(fits);
  return fits;
}

function parseValue(s) {
  // s: columns 11-80 of a card with a value indicator
  const t = s.trimStart();
  if (t[0] === "'") {
    let out = '', i = 1;
    for (; i < t.length; i++) {
      if (t[i] === "'") { if (t[i + 1] === "'") { out += "'"; i++; } else break; } else out += t[i];
    }
    const rest = t.slice(i + 1), k = rest.indexOf('/');
    return { value: out.replace(/\s+$/, ''), comment: k >= 0 ? rest.slice(k + 1).trim() : '' };
  }
  const k = t.indexOf('/');
  const raw = (k >= 0 ? t.slice(0, k) : t).trim(), comment = k >= 0 ? t.slice(k + 1).trim() : '';
  if (raw === 'T') return { value: true, comment };
  if (raw === 'F') return { value: false, comment };
  if (raw === '') return { value: null, comment };
  const num = Number(raw.replace(/[dD]/, 'E'));
  return { value: Number.isFinite(num) ? num : raw, comment };
}

// header text or pixels? A few stray bytes (a tab, an accented letter in a HISTORY card) are let through.
const isText = (u8, a, b) => { let bad = 0; for (let i = a; i < b; i++) if ((u8[i] < 32 && u8[i] !== 9) || u8[i] > 126) bad++; return bad <= (b - a) / 180; };

/**
 * Parse one header starting at byte `offset`. Returns { header, comments, cards, end, missingEnd } where `end`
 * is the byte offset of the data unit. `header` maps keyword -> value (first occurrence wins, as in astropy),
 * COMMENT and HISTORY are joined arrays, and CONTINUE long strings are assembled.
 * A header with no END card (astropy: ignore_missing_end) is taken to stop at the first 2880-byte block that is
 * not printable ASCII, or at the end of the bytes; `missingEnd` is then true. (astropy itself reads on to the end
 * of the file in that case and finds no data, so this recovers more than it does.)
 */
export function parseHeader(u8, offset = 0) {
  const header = {}, comments = {}, cards = [];
  let pos = offset, done = false, lastStr = null, missingEnd = false;
  while (!done) {
    const stop = Math.min(u8.length, pos + BLOCK);
    if (pos >= u8.length || (pos > offset && !isText(u8, pos, stop))) { missingEnd = true; break; }
    const block = ASCII.decode(u8.subarray(pos, stop));
    for (let i = 0; i < 36 && i * 80 + 80 <= block.length; i++) {
      const card = block.slice(i * 80, i * 80 + 80), key = card.slice(0, 8).trimEnd();
      if (key === 'END') { done = true; break; }
      if (key === '' && card.trim() === '') continue;
      if (key === 'CONTINUE' && lastStr) {
        const { value, comment } = parseValue(card.slice(8));
        if (typeof value === 'string') { header[lastStr] = header[lastStr].replace(/&$/, '') + value; if (comment) comments[lastStr] = ((comments[lastStr] || '') + ' ' + comment).trim(); }
        continue;
      }
      if (key === 'COMMENT' || key === 'HISTORY' || key === '') { (header[key || 'COMMENT'] ||= []).push(card.slice(8).trimEnd()); cards.push({ key, text: card.slice(8).trimEnd() }); lastStr = null; continue; }
      if (card[8] === '=' && card[9] === ' ') {
        const { value, comment } = parseValue(card.slice(10));
        cards.push({ key, value, comment });
        if (!(key in header)) { header[key] = value; comments[key] = comment; lastStr = typeof value === 'string' ? key : null; } else lastStr = null;
      } else if (key.startsWith('HIERARCH')) {
        const m = card.match(/^HIERARCH\s+(.*?)\s*=\s*(.*)$/);
        if (m) { const { value, comment } = parseValue(m[2]); const k = m[1].trim(); cards.push({ key: k, value, comment }); if (!(k in header)) { header[k] = value; comments[k] = comment; } }
        lastStr = null;
      } else { cards.push({ key, text: card.slice(8).trimEnd() }); lastStr = null; }
    }
    pos += BLOCK;
  }
  return { header, comments, cards, end: pos, missingEnd };
}

// Keywords of the binary table that holds a tile-compressed image -> keywords of the image it stands for
const ZMAP = { ZEXTEND: 'EXTEND', ZBLOCKED: 'BLOCKED', ZHECKSUM: 'CHECKSUM', ZDATASUM: 'DATASUM' };
const ZDROP = /^(SIMPLE|XTENSION|BITPIX|NAXIS\d*|PCOUNT|GCOUNT|TFIELDS|THEAP|ZIMAGE|ZCMPTYPE|ZQUANTIZ|ZDITHER0|ZBLANK|ZSCALE|ZZERO|ZMASKCMP|ZSIMPLE|ZTENSION|ZBITPIX|ZNAXIS\d*|ZPCOUNT|ZGCOUNT|(TTYPE|TFORM|TUNIT|TDIM|TSCAL|TZERO|TNULL|TDISP|ZNAME|ZVAL|ZTILE|ZFORM|ZCTYP)\d+|CHECKSUM|DATASUM)$/;

/**
 * The header of the image inside a tile-compressed HDU (a BINTABLE with ZIMAGE = T), as astropy presents it:
 * ZBITPIX -> BITPIX, ZNAXISn -> NAXISn, ZSIMPLE / ZTENSION / ZEXTEND / ZPCOUNT / ZGCOUNT / ZHECKSUM / ZDATASUM
 * back to their names, and the table's own keywords (TFORMn, ZCMPTYPE, ZTILEn, ...) removed. Any other header is
 * returned unchanged. Returns { header, comments }.
 */
export function imageHeader(H, comments = {}) {
  if (H.ZIMAGE !== true) return { header: H, comments };
  const header = {}, c = {}, put = (k, v, from) => { header[k] = v; c[k] = comments[from] || ''; };
  if ('ZSIMPLE' in H) put('SIMPLE', H.ZSIMPLE, 'ZSIMPLE'); else put('XTENSION', typeof H.ZTENSION === 'string' ? H.ZTENSION : 'IMAGE', 'ZTENSION');
  put('BITPIX', H.ZBITPIX, 'ZBITPIX'); put('NAXIS', H.ZNAXIS, 'ZNAXIS');
  for (let i = 1; i <= (H.ZNAXIS | 0); i++) put('NAXIS' + i, H['ZNAXIS' + i], 'ZNAXIS' + i);
  if (!('ZSIMPLE' in H)) { put('PCOUNT', H.ZPCOUNT ?? 0, 'ZPCOUNT'); put('GCOUNT', H.ZGCOUNT ?? 1, 'ZGCOUNT'); }
  for (const k of Object.keys(H)) {
    if (ZDROP.test(k) || (k === 'EXTNAME' && String(H[k]).trim() === 'COMPRESSED_IMAGE')) continue;
    const to = ZMAP[k] || k;
    if (!(to in header)) put(to, H[k], k);
  }
  return { header, comments: c };
}

/**
 * Split FITS bytes into HDUs without decoding any data. Returns { buffer, hdus: [{ index, header, comments,
 * cards, type, name, dataOffset, dataBytes, shape }] } where type is 'image', 'bintable', 'table', 'compressed'
 * or 'empty', and shape is [NAXISn, ..., NAXIS1] (numpy order) for images.
 */
export function parseFits(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 160 || ASCII.decode(u8.subarray(0, 9)) !== 'SIMPLE  =') throw new Error('Not a FITS file (it does not start with SIMPLE =).');
  const hdus = [];
  let pos = 0;
  while (pos + 160 <= u8.length) {
    const head = ASCII.decode(u8.subarray(pos, pos + 8));
    if (hdus.length && head !== 'XTENSION') break;                     // trailing padding or junk
    const h = parseHeader(u8, pos), H = h.header;
    const naxis = H.NAXIS | 0, dims = [];
    for (let i = 1; i <= naxis; i++) dims.push(H['NAXIS' + i] | 0);
    const bitpix = H.BITPIX | 0, pcount = H.PCOUNT || 0, gcount = H.GCOUNT || 1;
    const npix = naxis ? dims.reduce((a, b) => a * b, 1) : 0;
    const dataBytes = (Math.abs(bitpix) / 8) * gcount * (pcount + npix);
    const xt = typeof H.XTENSION === 'string' ? H.XTENSION.trim() : '';
    let type = npix === 0 ? 'empty' : 'image';
    if (xt === 'BINTABLE') type = H.ZIMAGE === true ? 'compressed' : 'bintable'; else if (xt === 'TABLE') type = 'table';
    const hdu = { index: hdus.length, header: H, comments: h.comments, cards: h.cards, type, name: typeof H.EXTNAME === 'string' ? H.EXTNAME.trim() : (hdus.length ? '' : 'PRIMARY'), dataOffset: h.end, dataBytes, shape: dims.slice().reverse(), bitpix, missingEnd: h.missingEnd };
    if (type === 'compressed') {
      // present the HDU as the image it holds; the table's own header stays in tableHeader
      const m = imageHeader(H, h.comments), zs = [];
      for (let i = 1; i <= (H.ZNAXIS | 0); i++) zs.push(H['ZNAXIS' + i] | 0);
      Object.assign(hdu, { tableHeader: H, tableComments: h.comments, header: m.header, comments: m.comments, shape: zs.reverse(), bitpix: H.ZBITPIX | 0, compression: String(H.ZCMPTYPE ?? '').trim().toUpperCase() });
    }
    hdus.push(hdu);
    if (h.end + dataBytes > u8.length) { hdus[hdus.length - 1].truncated = true; break; }
    pos = h.end + Math.ceil(dataBytes / BLOCK) * BLOCK;
  }
  return { buffer: u8.buffer, byteOffset: u8.byteOffset, u8, hdus };
}

/** Index of the first HDU holding a 2D (or higher) image, plain or tile-compressed, or -1 (EXOTIC: the first HDU with NAXIS != 0). */
export function firstImageHdu(fits) {
  for (const h of fits.hdus) if ((h.type === 'image' || h.type === 'compressed') && h.shape.length >= 2) return h.index;
  return -1;
}

// Big-endian block -> typed array of physical values. `out` is Float32Array or Float64Array of length n.
function decodeInto(u8, off, n, bitpix, bscale, bzero, blank, out) {
  const plain = bscale === 1 && bzero === 0;
  if (bitpix === 8) { for (let i = 0; i < n; i++) out[i] = u8[off + i] * bscale + bzero; }
  else if (bitpix === 16) {
    for (let i = 0, p = off; i < n; i++, p += 2) { const v = ((u8[p] << 8) | u8[p + 1]) << 16 >> 16; out[i] = v * bscale + bzero; }
  } else if (bitpix === 32) {
    for (let i = 0, p = off; i < n; i++, p += 4) { const v = (u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]; out[i] = v * bscale + bzero; }
  } else if (bitpix === 64) {
    for (let i = 0, p = off; i < n; i++, p += 8) {
      const hi = (u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3], lo = ((u8[p + 4] << 24) | (u8[p + 5] << 16) | (u8[p + 6] << 8) | u8[p + 7]) >>> 0;
      out[i] = (hi * 4294967296 + lo) * bscale + bzero;               // exact up to 2^53
    }
  } else if (bitpix === -32) {
    if (out instanceof Float32Array) {
      const o8 = new Uint8Array(out.buffer, out.byteOffset, n * 4);
      for (let i = 0, p = off; i < n * 4; i += 4, p += 4) { o8[i] = u8[p + 3]; o8[i + 1] = u8[p + 2]; o8[i + 2] = u8[p + 1]; o8[i + 3] = u8[p]; }
      if (!plain) for (let i = 0; i < n; i++) out[i] = out[i] * bscale + bzero;
    } else {
      const tmp = new Float32Array(1), t8 = new Uint8Array(tmp.buffer);
      for (let i = 0, p = off; i < n; i++, p += 4) { t8[0] = u8[p + 3]; t8[1] = u8[p + 2]; t8[2] = u8[p + 1]; t8[3] = u8[p]; out[i] = tmp[0] * bscale + bzero; }
    }
  } else if (bitpix === -64) {
    const tmp = new Float64Array(1), t8 = new Uint8Array(tmp.buffer);
    for (let i = 0, p = off; i < n; i++, p += 8) { for (let k = 0; k < 8; k++) t8[k] = u8[p + 7 - k]; out[i] = tmp[0] * bscale + bzero; }
  } else throw new Error('Unsupported BITPIX ' + bitpix);
  if (blank != null && bitpix > 0) { const bv = blank * bscale + bzero; for (let i = 0; i < n; i++) if (out[i] === bv) out[i] = NaN; }
  return out;
}

/**
 * Decode an image HDU, plain or tile-compressed, to physical values.
 * @param fits  result of parseFits / openFits
 * @param index HDU index (default: the first HDU with a 2D image)
 * @param opts  { plane: index of the 2D plane for cubes (default 0), weights: [w0, w1, ...] to return the weighted
 *                sum of the planes instead (a colour cube: [0.299, 0.587, 0.114]; not normalised here),
 *                float64: force Float64Array, out: a typed array of the right length to reuse (no allocation per frame) }
 * @returns { data, width, height, planes, plane, bitpix, header, compression }   data is Float32Array (Float64Array
 *          for BITPIX 64/-64, or 32 with scaling); plane is -1 for a weighted sum; compression is null or ZCMPTYPE.
 * Gzip tiles need openFits (or `await inflateTiles(fits)`) first: decompression is asynchronous in a browser.
 */
export function readImage(fits, index = -1, opts = {}) {
  const i = index < 0 ? firstImageHdu(fits) : index;
  const hdu = fits.hdus[i];
  if (!hdu) throw new Error('No image found in this FITS file.');
  const zip = hdu.type === 'compressed';
  if ((hdu.type !== 'image' && !zip) || hdu.shape.length < 2) throw new Error('HDU ' + i + ' is not an image.');
  if (hdu.truncated) throw new Error('The image data are shorter than the header says (truncated file).');
  const H = hdu.header, width = H.NAXIS1, height = H.NAXIS2, n = width * height;
  const planes = hdu.shape.slice(0, -2).reduce((a, b) => a * b, 1);
  let plane = Math.min(planes - 1, Math.max(0, opts.plane | 0));
  const bscale = typeof H.BSCALE === 'number' ? H.BSCALE : 1, bzero = typeof H.BZERO === 'number' ? H.BZERO : 0, blank = typeof H.BLANK === 'number' ? H.BLANK : null;
  const bp = hdu.bitpix, wide = opts.float64 || bp === -64 || bp === 64 || bp === 32;
  const alloc = () => (wide ? new Float64Array(n) : new Float32Array(n));
  const out = opts.out && opts.out.length === n ? opts.out : alloc();
  const one = zip ? (p, o) => decodeTiles(fits, hdu, p, o, bscale, bzero, blank) : (p, o) => decodeInto(fits.u8, hdu.dataOffset + p * n * Math.abs(bp) / 8, n, bp, bscale, bzero, blank, o);
  if (Array.isArray(opts.weights) && planes > 1) {
    const tmp = alloc(); out.fill(0); plane = -1;
    for (let p = 0; p < planes; p++) { const w = +opts.weights[p] || 0; if (!w) continue; one(p, tmp); for (let k = 0; k < n; k++) out[k] += w * tmp[k]; }
  } else one(plane, out);
  return { data: out, width, height, planes, plane, bitpix: bp, header: H, compression: zip ? hdu.compression : null };
}

/** readImage for any file: inflates the gzip tiles of a tile-compressed HDU first if openFits has not. */
export async function readImageAsync(fits, index = -1, opts = {}) {
  await inflateTiles(fits, index);
  return readImage(fits, index, opts);
}

// ---------------------------------------------------------------------------------------------------------
// Tile-compressed images (the FITS tiled image convention, what fpack writes and astropy's CompImageHDU reads)

const GZ_TILE = /^GZIP_[12]$/;

/**
 * Inflate the gzip parts of the tile-compressed HDUs (all, or the one at `index`): the tiles of GZIP_1 / GZIP_2
 * images, and the GZIP_COMPRESSED_DATA fallback tiles of quantised images. The bytes are kept on the HDU
 * (hdu.inflated) for readImage. openFits calls this.
 */
export async function inflateTiles(fits, index = -1) {
  for (const hdu of fits.hdus) {
    if (hdu.type !== 'compressed' || hdu.inflated || (index >= 0 && hdu.index !== index)) continue;
    const tab = readBinTable(fits, hdu.index), cd = tab.col('COMPRESSED_DATA'), gz = tab.col('GZIP_COMPRESSED_DATA'), jobs = [], map = new Map();
    for (let r = 0; r < tab.nrows; r++) {
      const d = cd ? tab.descriptor(cd, r) : null;
      if (d && d.count > 0) { if (GZ_TILE.test(hdu.compression)) jobs.push([cd.index + ':' + r, d]); }
      else if (gz) { const g = tab.descriptor(gz, r); if (g.count > 0) jobs.push([gz.index + ':' + r, g]); }
    }
    for (let k = 0; k < jobs.length; k += 64) await Promise.all(jobs.slice(k, k + 64).map(async ([key, d]) => map.set(key, new Uint8Array(await gunzip(fits.u8.subarray(d.offset, d.offset + d.bytes))))));
    hdu.inflated = map;
  }
  return fits;
}

// The 10000 pseudo-random numbers CFITSIO dithers with (fits_init_randoms: Park-Miller minimal standard, seed 1)
let RAND = null;
function ditherRandoms() {
  if (RAND) return RAND;
  RAND = new Float32Array(10000);
  let seed = 1;
  for (let i = 0; i < 10000; i++) { const t = 16807 * seed; seed = t - 2147483647 * Math.trunc(t / 2147483647); RAND[i] = seed / 2147483647; }
  if (seed !== 1043618065) throw new Error('dither sequence check failed');
  return RAND;
}

// CFITSIO fits_rdecomp / fits_rdecomp_short / fits_rdecomp_byte: Rice decoding of nx integers of bytepix bytes
function riceDecode(c, p, nx, nblock, bytepix, out) {
  const fsbits = bytepix === 1 ? 3 : bytepix === 2 ? 4 : 5, fsmax = bytepix === 1 ? 6 : bytepix === 2 ? 14 : 25, bbits = bytepix * 8;
  const wrap = bytepix === 1 ? (v) => v & 255 : bytepix === 2 ? (v) => v << 16 >> 16 : (v) => v | 0;
  let last = 0; for (let k = 0; k < bytepix; k++) last = (last << 8) | c[p++];     // the first pixel, uncoded
  last = wrap(last);
  let b = c[p++], nbits = 8;                                                      // bit buffer and the bits left in it
  for (let i = 0; i < nx;) {
    nbits -= fsbits;
    while (nbits < 0) { b = (b << 8) | c[p++]; nbits += 8; }
    const fs = (b >>> nbits) - 1;
    b &= (1 << nbits) - 1;
    const imax = Math.min(nx, i + nblock);
    if (fs < 0) for (; i < imax; i++) out[i] = last;                               // all differences zero
    else if (fs === fsmax) {                                                      // high entropy: differences stored whole
      for (; i < imax; i++) {
        let k = bbits - nbits, diff = nbits ? b << k : 0;
        for (k -= 8; k >= 0; k -= 8) { b = c[p++]; diff |= b << k; }
        if (nbits > 0) { b = c[p++]; diff |= b >>> (-k); b &= (1 << nbits) - 1; } else b = 0;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        last = wrap(diff + last); out[i] = last;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = c[p++]; if (p > c.length + 8) throw new Error('Corrupt Rice-compressed tile.'); }
        const nzero = nbits - (32 - Math.clz32(b));                               // leading zeros = the high part of the code
        nbits -= nzero + 1;
        b ^= 1 << nbits;
        nbits -= fs;
        while (nbits < 0) { b = (b << 8) | c[p++]; nbits += 8; }
        let diff = (nzero << fs) | (b >>> nbits);
        b &= (1 << nbits) - 1;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        last = wrap(diff + last); out[i] = last;
      }
    }
  }
}

// IRAF PLIO line list -> pixels (CFITSIO pl_l2pi with xs = 1); ll is the list as big-endian 16-bit words at byte p
function plioDecode(u8, p, nwords, npix, out) {
  const ll = (k) => ((u8[p + 2 * k - 2] << 8) | u8[p + 2 * k - 1]) << 16 >> 16;      // 1-based, as in the original
  let lllen, first;
  if (ll(3) > 0) { lllen = ll(3); first = 4; } else { lllen = (ll(5) << 15) + ll(4); first = ll(2) + 1; }
  let op = 0, x1 = 1, pv = 1, skip = false;
  for (let ip = first; ip <= Math.min(lllen, nwords) && x1 <= npix; ip++) {
    if (skip) { skip = false; continue; }
    const w = ll(ip) & 0xffff, opcode = w >> 12, data = w & 4095;
    if (opcode === 0 || opcode === 4 || opcode === 5) {
      const x2 = x1 + data - 1, i2 = Math.min(x2, npix), np = i2 - x1 + 1;
      if (np > 0) { out.fill(opcode === 4 ? pv : 0, op, op + np); if (opcode === 5 && i2 === x2) out[op + np - 1] = pv; op += np; }
      x1 = x2 + 1;
    } else if (opcode === 1) { pv = ((ll(ip + 1) & 0xffff) << 12) + data; skip = true; }
    else if (opcode === 2) pv += data;
    else if (opcode === 3) pv -= data;
    else { pv += opcode === 6 ? data : -data; if (x1 <= npix) out[op++] = pv; x1++; }
  }
  out.fill(0, op, npix);
}

// a * b + c rounded once (a fused multiply-add, by Dekker's exact product). CFITSIO's unquantize line
// `(input - random + 0.5) * scale + zero` compiles to one on arm64 (clang contracts it), and ZZERO can be 1e9 for
// pixel values of a few hundred, where the two roundings of the plain expression show in the last float32 digit.
function fma(a, b, c) {
  const p = a * b, ta = 134217729 * a, ah = ta - (ta - a), al = a - ah, tb = 134217729 * b, bh = tb - (tb - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl, s = p + c, bb = s - p;
  return Number.isFinite(e) ? s + (((p - (s - bb)) + (c - bb)) + e) : s;
}

const zsetting = (T, name, dflt) => { for (let i = 1; ('ZNAME' + i) in T; i++) if (String(T['ZNAME' + i]).trim().toUpperCase() === name) return T['ZVAL' + i]; return dflt; };

// One 2D plane of a tile-compressed image into `out` (Float32Array or Float64Array of NAXIS1 * NAXIS2).
function decodeTiles(fits, hdu, plane, out, bscale, bzero, blank) {
  const T = hdu.tableHeader, u8 = fits.u8, tab = readBinTable(fits, hdu.index), cmp = hdu.compression, zbp = hdu.bitpix, zn = T.ZNAXIS | 0;
  if (cmp === 'HCOMPRESS_1') throw new Error('This image is tile-compressed with HCOMPRESS_1, which this reader does not decode (RICE_1, GZIP_1, GZIP_2, PLIO_1 and NOCOMPRESS are). Convert it with funpack or astropy first.');
  if (!['RICE_1', 'RICE_ONE', 'GZIP_1', 'GZIP_2', 'PLIO_1', 'NOCOMPRESS'].includes(cmp)) throw new Error('Unknown tile compression ZCMPTYPE = ' + cmp + '.');
  const dims = [], tile = [];
  for (let i = 1; i <= zn; i++) { dims.push(T['ZNAXIS' + i] | 0); tile.push(typeof T['ZTILE' + i] === 'number' && T['ZTILE' + i] > 0 ? T['ZTILE' + i] : (i === 1 ? dims[0] : 1)); }   // default: one tile per image row
  const W = dims[0], nt = dims.map((d, i) => Math.ceil(d / tile[i]));
  const cData = tab.col('COMPRESSED_DATA'), cGz = tab.col('GZIP_COMPRESSED_DATA'), cUn = tab.col('UNCOMPRESSED_DATA');
  const cScale = tab.col('ZSCALE'), cZero = tab.col('ZZERO'), cBlank = tab.col('ZBLANK');
  const zscale = cScale ? tab.column(cScale) : null, zzero = cZero ? tab.column(cZero) : null, zblank = cBlank ? tab.column(cBlank) : null;
  const quant = String(T.ZQUANTIZ ?? 'NO_DITHER').trim().toUpperCase();
  const quantised = zbp < 0 && quant !== 'NONE' && (!!cScale || typeof T.ZSCALE === 'number');
  const dither = quant === 'SUBTRACTIVE_DITHER_1' ? 1 : quant === 'SUBTRACTIVE_DITHER_2' ? 2 : 0, seed0 = (T.ZDITHER0 | 0), rnd = dither ? ditherRandoms() : null;
  const blocksize = zsetting(T, 'BLOCKSIZE', 32), bytepix = zsetting(T, 'BYTEPIX', 4);
  if (cmp.startsWith('RICE') && ![1, 2, 4].includes(bytepix)) throw new Error('Rice compression with BYTEPIX = ' + bytepix + ' is not supported.');
  // where the wanted plane sits on the axes beyond the second: which tile, and where inside it
  let rowBase = 0, mult = nt[0] * nt[1], q = plane; const hi = [];
  for (let i = 2; i < zn; i++) { const c = q % dims[i]; q = Math.floor(q / dims[i]); const t = Math.floor(c / tile[i]); rowBase += t * mult; mult *= nt[i]; hi.push([c - t * tile[i], Math.min(tile[i], dims[i] - t * tile[i])]); }
  let buf = null;
  const bytesToValues = (bytes, npix, shuffled, lossless) => {
    const item = bytes.length / npix;
    if (![1, 2, 4, 8].includes(item)) throw new Error(`A tile of ${npix} pixels decompressed to ${bytes.length} bytes.`);
    if (shuffled && item > 1) { const o = new Uint8Array(bytes.length); for (let k = 0; k < item; k++) for (let j = 0; j < npix; j++) o[j * item + k] = bytes[k * npix + j]; bytes = o; }   // GZIP_2: most significant bytes first
    decodeInto(bytes, 0, npix, zbp < 0 && lossless && item >= 4 ? -8 * item : 8 * item, 1, 0, null, buf);
  };
  for (let ty = 0; ty < nt[1]; ty++) for (let tx = 0; tx < nt[0]; tx++) {
    const row = rowBase + ty * nt[0] + tx, x0 = tx * tile[0], y0 = ty * tile[1], s1 = Math.min(tile[0], W - x0), s2 = Math.min(tile[1], dims[1] - y0);
    let npix = s1 * s2, base = 0;
    for (const [local, size] of hi) { base += local * npix; npix *= size; }
    if (!buf || buf.length < npix) buf = new Float64Array(npix);
    const d = cData ? tab.descriptor(cData, row) : null;
    let final = !quantised;                                                // true: the values are pixels, not quantised integers
    if (d && d.count > 0) {
      if (cmp === 'RICE_1' || cmp === 'RICE_ONE') riceDecode(u8, d.offset, npix, blocksize, bytepix, buf);
      else if (cmp === 'PLIO_1') plioDecode(u8, d.offset, d.count, npix, buf);
      else if (cmp === 'NOCOMPRESS') bytesToValues(u8.subarray(d.offset, d.offset + d.bytes), npix, false, !quantised);
      else {
        const b = hdu.inflated && hdu.inflated.get(cData.index + ':' + row);
        if (!b) throw new Error('The gzip tiles of this image have not been inflated: open the file with openFits, or await inflateTiles(fits) / readImageAsync.');
        bytesToValues(b, npix, cmp === 'GZIP_2', !quantised);
      }
    } else {
      // a tile that could not be quantised or compressed: stored whole, gzipped or plain
      const g = cGz ? tab.descriptor(cGz, row) : null, un = cUn ? tab.descriptor(cUn, row) : null;
      final = true;
      if (g && g.count > 0) {
        const b = hdu.inflated && hdu.inflated.get(cGz.index + ':' + row);
        if (!b) throw new Error('The gzip tiles of this image have not been inflated: open the file with openFits, or await inflateTiles(fits) / readImageAsync.');
        bytesToValues(b, npix, false, true);
      } else if (un && un.count > 0) {
        const ebp = { B: 8, I: 16, J: 32, K: 64, E: -32, D: -64 }[un.elem];
        if (!ebp || un.count < npix) throw new Error('Unreadable UNCOMPRESSED_DATA tile.');
        decodeInto(u8, un.offset, npix, ebp, 1, 0, null, buf);
      } else throw new Error('Tile ' + (row + 1) + ' of the compressed image has no data.');
    }
    if (!final) {
      // quantised floats: value = integer * ZSCALE + ZZERO, with the subtractive dither of CFITSIO (unquantize_i4r4)
      const sc = zscale ? zscale[row] : T.ZSCALE, ze = zzero ? zzero[row] : (typeof T.ZZERO === 'number' ? T.ZZERO : 0), nul = zblank ? zblank[row] : (typeof T.ZBLANK === 'number' ? T.ZBLANK : null);
      if (!dither) { for (let k = 0; k < npix; k++) buf[k] = buf[k] === nul ? NaN : buf[k] * sc + ze; }
      else {
        let iseed = (((row + seed0 - 1) % 10000) + 10000) % 10000, next = Math.trunc(Math.fround(rnd[iseed] * 500));
        for (let k = 0; k < npix; k++) {
          const v = buf[k];
          buf[k] = v === nul ? NaN : dither === 2 && v === -2147483646 ? 0 : fma(v - rnd[next] + 0.5, sc, ze);
          if (++next === 10000) { if (++iseed === 10000) iseed = 0; next = Math.trunc(Math.fround(rnd[iseed] * 500)); }
        }
      }
    }
    const single = zbp === -32, plain = bscale === 1 && bzero === 0, isInt = zbp > 0;
    for (let y = 0; y < s2; y++) {
      let o = (y0 + y) * W + x0, k = base + y * s1;
      for (let x = 0; x < s1; x++, o++, k++) {
        let v = buf[k];
        if (isInt && v === blank) v = NaN; else { if (single) v = Math.fround(v); if (!plain) v = v * bscale + bzero; }
        out[o] = v;
      }
    }
  }
  return out;
}

const TFORM = /^(\d*)([LXBIJKAEDCMPQ])(.*)$/;
const TSIZE = { L: 1, X: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };

/**
 * Describe a binary table HDU. Returns { nrows, rowBytes, columns: [{ name, type, repeat, dim, unit, offset,
 * width, scale, zero, nulls }], column(name) } where column(name) decodes one column for all rows into a flat
 * typed array of nrows * repeat values (Float32Array for E, Float64Array for D and K, Int32Array for J/I/B,
 * Uint8Array for L and X, an array of strings for A). TDIM gives `dim` in FITS order ([nx, ny] for an image cell).
 * Variable-length array columns (1PB, 1PI, 1PJ, 1PE, 1PD and the 64-bit 1Q forms): descriptor(name, row) gives
 * { count, offset (absolute, in fits.u8), bytes, elem }, heap(name, row) the raw big-endian bytes and
 * array(name, row) the values as a Float64Array. Works on a tile-compressed image HDU too (its underlying table).
 */
export function readBinTable(fits, index) {
  const hdu = fits.hdus[index];
  if (!hdu || (hdu.type !== 'bintable' && hdu.type !== 'compressed')) throw new Error('HDU ' + index + ' is not a binary table.');
  const H = hdu.tableHeader || hdu.header, nrows = H.NAXIS2, rowBytes = H.NAXIS1, nf = H.TFIELDS | 0, columns = [];
  let off = 0;
  for (let c = 1; c <= nf; c++) {
    const m = TFORM.exec(String(H['TFORM' + c]).trim());
    if (!m) throw new Error('Unreadable TFORM' + c + ': ' + H['TFORM' + c]);
    const type = m[2], repeat = m[1] === '' ? 1 : +m[1];
    const width = type === 'X' ? Math.ceil(repeat / 8) : repeat * TSIZE[type];
    const td = typeof H['TDIM' + c] === 'string' ? H['TDIM' + c].replace(/[()\s]/g, '').split(',').map(Number) : null;
    columns.push({ name: String(H['TTYPE' + c] ?? 'COL' + c).trim(), type, repeat, elem: type === 'P' || type === 'Q' ? (m[3][0] || 'B') : null, dim: td, unit: typeof H['TUNIT' + c] === 'string' ? H['TUNIT' + c].trim() : '', offset: off, width,
      scale: typeof H['TSCAL' + c] === 'number' ? H['TSCAL' + c] : 1, zero: typeof H['TZERO' + c] === 'number' ? H['TZERO' + c] : 0, nulls: typeof H['TNULL' + c] === 'number' ? H['TNULL' + c] : null, index: c });
    off += width;
  }
  if (off !== rowBytes) throw new Error(`Binary table row width ${rowBytes} does not match its columns (${off}).`);
  const u8 = fits.u8, base = hdu.dataOffset;
  const byName = new Map(columns.map((c) => [c.name.toUpperCase(), c]));
  function column(name, rows = null) {
    const col = typeof name === 'string' ? byName.get(name.toUpperCase()) : name;
    if (!col) return null;
    const r0 = rows ? rows[0] : 0, r1 = rows ? rows[1] : nrows, nr = r1 - r0, n = nr * col.repeat, t = col.type;
    if (t === 'A') { const out = new Array(nr); for (let r = 0; r < nr; r++) { const p = base + (r0 + r) * rowBytes + col.offset; out[r] = ASCII.decode(u8.subarray(p, p + col.repeat)).replace(/[\0\s]+$/, ''); } return out; }
    if (t === 'L' || t === 'X') { const out = new Uint8Array(nr * col.width); for (let r = 0; r < nr; r++) { const p = base + (r0 + r) * rowBytes + col.offset; for (let k = 0; k < col.width; k++) out[r * col.width + k] = t === 'L' ? (u8[p + k] === 84 ? 1 : 0) : u8[p + k]; } return out; }
    if (t === 'P' || t === 'Q' || t === 'C' || t === 'M') { const out = new Uint8Array(nr * col.width); for (let r = 0; r < nr; r++) { const p = base + (r0 + r) * rowBytes + col.offset; out.set(u8.subarray(p, p + col.width), r * col.width); } return out; }
    const plain = col.scale === 1 && col.zero === 0;
    const bitpix = { B: 8, I: 16, J: 32, K: 64, E: -32, D: -64 }[t];
    const out = t === 'E' ? new Float32Array(n) : (t === 'D' || t === 'K' || !plain) ? new Float64Array(n) : new Int32Array(n);
    const rowW = col.width;
    if (out instanceof Int32Array) {
      // integers without scaling keep their type (quality flags, cadence numbers, aperture masks)
      for (let r = 0, q = 0; r < nr; r++) {
        let p = base + (r0 + r) * rowBytes + col.offset;
        if (t === 'B') for (let k = 0; k < col.repeat; k++) out[q++] = u8[p++];
        else if (t === 'I') for (let k = 0; k < col.repeat; k++, p += 2) out[q++] = ((u8[p] << 8) | u8[p + 1]) << 16 >> 16;
        else for (let k = 0; k < col.repeat; k++, p += 4) out[q++] = (u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
      }
      return out;
    }
    if (rowW === rowBytes) decodeInto(u8, base + r0 * rowBytes, n, bitpix, col.scale, col.zero, col.nulls, out);
    else for (let r = 0; r < nr; r++) decodeInto(u8, base + (r0 + r) * rowBytes + col.offset, col.repeat, bitpix, col.scale, col.zero, col.nulls, out.subarray(r * col.repeat, (r + 1) * col.repeat));
    return out;
  }
  // variable-length arrays: the cell holds (count, offset) as two 32-bit (P) or 64-bit (Q) integers, the values are in the heap
  const heapBase = base + (typeof H.THEAP === 'number' ? H.THEAP : nrows * rowBytes);
  const be32 = (p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  const col = (name) => (typeof name === 'string' ? byName.get(name.toUpperCase()) : name) || null;
  function descriptor(name, row) {
    const c = col(name);
    if (!c || (c.type !== 'P' && c.type !== 'Q')) return null;
    const p = base + row * rowBytes + c.offset;
    const count = c.type === 'P' ? be32(p) : be32(p) * 4294967296 + be32(p + 4), off = c.type === 'P' ? be32(p + 4) : be32(p + 8) * 4294967296 + be32(p + 12);
    return { count, offset: heapBase + off, bytes: count * TSIZE[c.elem], elem: c.elem };
  }
  const heap = (name, row) => { const d = descriptor(name, row); return d ? u8.subarray(d.offset, d.offset + d.bytes) : null; };
  function array(name, row) {
    const d = descriptor(name, row), bp = d && { B: 8, I: 16, J: 32, K: 64, E: -32, D: -64 }[d.elem];
    if (!d) return null;
    if (!bp) return u8.subarray(d.offset, d.offset + d.bytes);
    return decodeInto(u8, d.offset, d.count, bp, 1, 0, null, new Float64Array(d.count));
  }
  return { nrows, rowBytes, columns, column, col, descriptor, heap, array, header: H };
}

// ---------------------------------------------------------------------------------------------------------
// Time

/** Julian date (UTC) of a calendar date; month 1-12, fractional day allowed. Gregorian calendar. */
export function calendarToJd(y, m, d, h = 0, mi = 0, s = 0) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 + (h + (mi + s / 60) / 60) / 24;
}

/** Parse an ISO-like FITS date string ('2020-01-12T03:14:15.5', '2020-01-12', '12/01/99') to JD, or NaN. */
export function parseFitsDate(date, timeOfDay = null) {
  if (typeof date !== 'string') return NaN;
  let s = date.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?/);
  let y, mo, d, h = 0, mi = 0, se = 0, hasTime = false;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4] != null) { h = +m[4]; mi = +m[5]; se = +(m[6] || 0); hasTime = true; } }
  else if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/))) { d = +m[1]; mo = +m[2]; y = 1900 + +m[3]; }       // pre-2000 FITS form dd/mm/yy
  else return NaN;
  if (!hasTime && typeof timeOfDay === 'string') { const t = timeOfDay.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?/); if (t) { h = +t[1]; mi = +t[2]; se = +(t[3] || 0); } }
  return calendarToJd(y, mo, d, h, mi, se);
}

// TAI - UTC and TDB - UTC: one table for the whole code, in timescale.js
export { taiMinusUtc, tdbMinusUtc };

// Keplerian elements of the giant planets at J2000 and their rates per century (Standish, JPL "Approximate
// positions of the planets", 1800-2050): a [au], e, I, L, long. of perihelion, long. of node [deg]; then Sun/planet mass.
const GIANTS = [
  [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106, 1047.3486],
  [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794, 3497.898],
  [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589, 22902.98],
  [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664, 19412.24],
];
const D2R = Math.PI / 180, EPS0 = 23.4392911 * D2R, C_AU_DAY = 173.144632674;

/**
 * Barycentric position of the Earth [au], equatorial J2000, from a low-precision solar theory (Meeus ch. 25,
 * 0.01 deg) plus the Sun's offset from the barycentre due to Jupiter, Saturn, Uranus and Neptune.
 * Good to about 2e-4 au, which is 0.1 s of light time. Checked against astropy in test/fits.test.mjs.
 */
export function earthBarycentric(jdTdb, out = [0, 0, 0]) {
  const T = (jdTdb - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const lon = (L0 + C - 1.397 * T) * D2R;                               // Sun's true longitude, referred to the J2000 equinox
  const R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(M + C * D2R));
  // heliocentric Earth = minus the geocentric Sun (ecliptic latitude of the Sun < 1.2 arcsec, ignored)
  let x = -R * Math.cos(lon), ye = -R * Math.sin(lon), ze = 0;
  // Sun relative to the barycentre: - sum m_p r_p / (1 + sum m_p)
  let sx = 0, sy = 0, sz = 0, mt = 1;
  for (const g of GIANTS) {
    const a = g[0] + g[6] * T, ec = g[1] + g[7] * T, I = (g[2] + g[8] * T) * D2R, L = g[3] + g[9] * T, wb = g[4] + g[10] * T, Om = (g[5] + g[11] * T) * D2R;
    const w = (wb * D2R) - Om, Ma = ((L - wb) % 360) * D2R;
    let E = Ma; for (let k = 0; k < 8; k++) E -= (E - ec * Math.sin(E) - Ma) / (1 - ec * Math.cos(E));
    const xp = a * (Math.cos(E) - ec), yp = a * Math.sqrt(1 - ec * ec) * Math.sin(E);
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
    const m = 1 / g[12]; mt += m;
    sx -= m * ((cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp);
    sy -= m * ((cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp);
    sz -= m * (sw * sI * xp + cw * sI * yp);
  }
  x += sx / mt; ye += sy / mt; ze += sz / mt;
  const ce = Math.cos(EPS0), se = Math.sin(EPS0);
  out[0] = x; out[1] = ye * ce - ze * se; out[2] = ye * se + ze * ce;
  return out;
}

/**
 * UTC Julian date -> BJD_TDB for a target at (raDeg, decDeg) ICRS: clock correction (leap seconds, TT, TDB)
 * plus the Roemer delay to the solar-system barycentre for a source at infinity. The observatory's position on
 * the Earth (up to 21 ms), the Shapiro delay (< 0.1 ms away from the Sun) and proper motion are left out.
 * Accuracy about 0.2 s (test/fits.test.mjs against astropy).
 */
export function utcToBjdTdb(jdUtc, raDeg, decDeg) {
  const dt = tdbMinusUtc(jdUtc), p = earthBarycentric(jdUtc + dt);
  const a = raDeg * D2R, d = decDeg * D2R;
  return jdUtc + dt + (p[0] * Math.cos(d) * Math.cos(a) + p[1] * Math.cos(d) * Math.sin(a) + p[2] * Math.sin(d)) / C_AU_DAY;
}

const num = (H, k) => { const v = H[k]; if (typeof v === 'number') return v; if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v); return NaN; };

const MSEC = /\b(ms|msec|millisec\w*)\b/i, SEC = /\b(s|sec|secs|seconds?)\b/i;
/**
 * Exposure time in seconds, or NaN: EXPTIME, EXPOSURE, EXP (EXOTIC's list), then EXP_TIME, EXPOSED, ITIME, INTTIME,
 * XPOSURE, TELAPSE. A value is taken as milliseconds only when the keyword's comment says ms / msec / milliseconds
 * and does not also mention seconds; EXPOINUS (SharpCap) is in microseconds.
 */
export function exposureTime(H, comments = {}) {
  for (const k of ['EXPTIME', 'EXPOSURE', 'EXP', 'EXP_TIME', 'EXPOSED', 'ITIME', 'INTTIME', 'XPOSURE', 'TELAPSE']) {
    const v = num(H, k); if (!Number.isFinite(v)) continue;
    const c = String(comments[k] || '');
    return MSEC.test(c) && !SEC.test(c) ? v / 1000 : v;
  }
  const us = num(H, 'EXPOINUS');
  return Number.isFinite(us) ? us / 1e6 : NaN;
}

const TOD = /^\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?/;
const timeOfDay = (H, keys) => keys.map((t) => H[t]).find((t) => typeof t === 'string' && TOD.test(t)) || null;
const NO_TIME = (exptime) => ({ jd: NaN, scale: 'none', keyword: null, exptime, shifted: 0, position: null, timesys: null, clock: 0 });

// EXOTIC's own rule, exotic.py img_time_bjd_tdb / img_time_jd / ut_date / julian_date / exp_offset (lines 190-298):
// the first keyword PRESENT of BJD_TDB, BJD_TBD, BJD, else of UT-OBS, JULIAN, MJD-OBS, DATE-OBS; DATE-OBS without
// a 'T' is joined with TIME-OBS; half the exposure (first present of EXPTIME, EXPOSURE, EXP, else 0) is added
// only when the keyword's comment contains 'start' (case-sensitive). Where EXOTIC would raise, jd is NaN.
function exoticTime(H, comments) {
  const ek = ['EXPTIME', 'EXPOSURE', 'EXP'].find((k) => k in H), exp = ek ? num(H, ek) : 0, exptime = ek ? exp : NaN;
  const off = (k) => (String(comments[k] ?? '').includes('start') ? exp / 172800 : 0);
  const done = (jd, scale, k) => { const s = off(k); return { jd: jd + s, scale, keyword: k, exptime, shifted: s, position: s ? 'start' : 'mid', timesys: null, clock: 0 }; };
  const b = ['BJD_TDB', 'BJD_TBD', 'BJD'].find((k) => k in H);
  if (b) return done(num(H, b), 'BJD_TDB', b);
  const k = ['UT-OBS', 'JULIAN', 'MJD-OBS', 'DATE-OBS'].find((k) => k in H);
  if (!k) return NO_TIME(exptime);
  // astropy's Time.jd, which EXOTIC returns, runs a UTC day that ends in a leap second 86401 s long
  const astropyJd = (jd) => { const d0 = Math.floor(jd - 0.5) + 0.5; return taiMinusUtc(d0 + 1) !== taiMinusUtc(d0) ? d0 + (jd - d0) * 86400 / 86401 : jd; };
  if (k === 'UT-OBS' || k === 'DATE-OBS') return done(astropyJd(parseFitsDate(k === 'DATE-OBS' && !String(H[k]).includes('T') ? `${H[k]}T${H['TIME-OBS']}` : String(H[k]))), 'UTC', k);
  return done(num(H, k) + (k === 'MJD-OBS' ? 2400000.5 : 0), 'UTC', k);
}

/**
 * Time of a frame from its header.
 * Order of preference: a barycentric keyword (BJD_TDB, BJD_TBD, BJD); an explicit mid-exposure keyword (JD-MID,
 * JD-AVG, MJD-MID, MJD-AVG, DATE-AVG, DATE-MID); a heliocentric one (HJD, JD-HELIO: scale 'HJD'); JD keywords (JD,
 * JD-OBS, JULIAN, JD_UTC, JD-BEG, JD-START); MJD keywords (MJD-OBS, MJD_OBS, MJD, MJD-BEG); calendar dates (DATE-OBS,
 * UT-OBS, DATE-BEG, with the time of day from TIME-OBS / UT / UTC / UTSTART / UTC-OBS / UT-TIME / TIME-BEG / TIME
 * when the date has none); end-of-exposure keywords (DATE-END, MJD-END, JD-END); and last DATE (file creation).
 *
 * `at` says where in the exposure a start-type keyword sits when its comment does not: 'start' (the FITS
 * standard's meaning of DATE-OBS, and the default here), 'mid' (never shift), 'end', or 'exotic', which reproduces
 * EXOTIC exactly (its keyword order BJD_TDB, BJD_TBD, BJD, UT-OBS, JULIAN, MJD-OBS, DATE-OBS and its rule: half an
 * exposure is added only when the keyword's comment contains "start"). Otherwise a comment containing "mid",
 * "cent" or "average" means mid-exposure, "end" the end, "start" / "begin" the start.
 *
 * TIMESYS = TT, TDT, ET, TDB, TAI or GPS on a JD / MJD / date keyword is converted to UTC (`clock` = the days
 * subtracted, `timesys` = what the header said), so scale 'UTC' always means UTC.
 *
 * @returns { jd, scale: 'BJD_TDB' | 'HJD' | 'UTC' | 'none', keyword, exptime [s], shifted: days added to reach
 *            mid-exposure, position: 'start' | 'mid' | 'end' as understood, timesys, clock, dateOnly }
 */
export function frameTime(H, comments = {}, at = 'start') {
  if (at === 'exotic') return exoticTime(H, comments || {});
  comments = comments || {};
  const exptime = exposureTime(H, comments), half = Number.isFinite(exptime) ? exptime / 172800 : 0;
  const where = (key, dflt) => {
    const c = String(comments[key] || '').toLowerCase();
    if (/mid|cent|average|\bavg\b/.test(c)) return 'mid';
    if (at === 'mid') return 'mid';
    if (/\bend\b|\bclose/.test(c)) return 'end';
    if (/start|begin|\bopen/.test(c)) return 'start';
    return dflt;
  };
  const ts = typeof H.TIMESYS === 'string' ? H.TIMESYS.trim().toUpperCase() : null;
  const utc = (jd) => {                                                   // days to subtract from a clock reading in TIMESYS to get UTC
    if (!ts || ts === 'UTC' || ts === 'UT' || ts === 'UT1' || ts === 'GMT') return 0;
    const tai = taiMinusUtc(jd);
    return ts === 'TAI' ? tai / 86400 : ts === 'GPS' ? (tai - 19) / 86400 : ts === 'TT' || ts === 'TDT' || ts === 'ET' ? (tai + 32.184) / 86400 : ts === 'TDB' || ts === 'TCB' ? tdbMinusUtc(jd - (tai + 32.184) / 86400) : 0;
  };
  const done = (jd, scale, keyword, position, extra = {}) => {
    const clock = scale === 'UTC' ? utc(jd) : 0, s = position === 'start' ? half : position === 'end' ? -half : 0;
    return { jd: jd - clock + s, scale, keyword, exptime, shifted: s, position, timesys: ts, clock, ...extra };
  };
  const jdKey = (keys, zero, min, max, scale, dflt, respect = true) => {
    for (const k of keys) { const v = num(H, k); if (Number.isFinite(v) && v > min && v < max) return done(v + zero, scale, k, respect ? where(k, dflt) : dflt); }
    return null;
  };
  const dateKey = (keys, tods, dflt) => {
    for (const k of keys) {
      if (typeof H[k] !== 'string') continue;
      const hasTime = /\d[T ]\d{1,2}:\d/.test(H[k]), tod = hasTime ? null : timeOfDay(H, tods), v = parseFitsDate(H[k], tod);
      if (Number.isFinite(v)) return done(v, 'UTC', k, where(k, dflt), { dateOnly: !hasTime && !tod });
    }
    return null;
  };
  // a barycentric or heliocentric time is shifted only when its comment says it is the start
  const bary = (keys, scale) => { for (const k of keys) { const v = num(H, k); if (Number.isFinite(v) && v > 2e6) return done(v, scale, k, /start/.test(String(comments[k] || '').toLowerCase()) ? 'start' : 'mid'); } return null; };
  return bary(['BJD_TDB', 'BJD_TBD', 'BJD'], 'BJD_TDB')
    || jdKey(['JD-MID', 'JD_MID', 'JD-AVG', 'MIDPOINT', 'JD_UTC-MID'], 0, 2e6, 4e6, 'UTC', 'mid', false)
    || jdKey(['MJD-MID', 'MJD-AVG', 'MJD_MID'], 2400000.5, 1e4, 2e6, 'UTC', 'mid', false)
    || dateKey(['DATE-AVG', 'DATE-MID'], [], 'mid')
    || bary(['HJD', 'JD-HELIO', 'HJD-OBS', 'HJD_UTC'], 'HJD')
    || jdKey(['JD', 'JD-OBS', 'JULIAN', 'JD_UTC', 'JD_OBS', 'JD-BEG', 'JD-START', 'JDSTART'], 0, 2e6, 4e6, 'UTC', at === 'end' ? 'end' : 'start')
    || jdKey(['MJD-OBS', 'MJD_OBS', 'MJD', 'MJD-BEG', 'MJDSTART'], 2400000.5, 1e4, 2e6, 'UTC', at === 'end' ? 'end' : 'start')
    || dateKey(['DATE-OBS', 'UT-OBS', 'DATE_OBS', 'DATE-BEG'], ['TIME-OBS', 'UT', 'UTC', 'UTSTART', 'UTC-OBS', 'UT-START', 'UT-TIME', 'TIME-BEG', 'UT-OBS', 'TIME'], at === 'end' ? 'end' : 'start')
    || dateKey(['DATE-END'], ['TIME-END', 'UTEND', 'UT-END'], 'end')
    || jdKey(['JD-END', 'JDEND'], 0, 2e6, 4e6, 'UTC', 'end')
    || jdKey(['MJD-END', 'MJDEND'], 2400000.5, 1e4, 2e6, 'UTC', 'end')
    || (typeof H.DATE === 'string' && Number.isFinite(parseFitsDate(H.DATE)) ? done(parseFitsDate(H.DATE), 'UTC', 'DATE', 'mid', { fileDate: true }) : null)
    || NO_TIME(exptime);
}

/** Greenwich mean sidereal time [deg] at a UT Julian date (IAU 1982 polynomial; UT1 = UTC to within 0.9 s). */
export function gmstDeg(jd) {
  const d = jd - 2451545.0, T = d / 36525;
  return (((280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000) % 360) + 360) % 360;
}

/**
 * Airmass as sec(z) (the definition EXOTIC uses) for a J2000 position seen from a site; longitude east positive.
 * The position is precessed to the date with the first-order formula (enough for an airmass).
 * Returns NaN below the horizon.
 */
export function airmassAt(jdUtc, raDeg, decDeg, latDeg, lonDeg) {
  const T = (jdUtc - 2451545.0) / 36525, a0 = raDeg * D2R, d0 = decDeg * D2R;
  const ra = raDeg + (1.2812323 + 0.5567530 * Math.sin(a0) * Math.tan(d0)) * T, dec = decDeg + 0.5567530 * Math.cos(a0) * T;
  const ha = (gmstDeg(jdUtc) + lonDeg - ra) * D2R, lat = latDeg * D2R, d = dec * D2R;
  const cz = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(ha);
  return cz > 0 ? 1 / cz : NaN;
}

const sexa = (v) => { if (typeof v === 'number') return v; if (typeof v !== 'string') return NaN; const p = v.trim().split(/[:\s]+/).map(Number); if (p.some((x) => !Number.isFinite(x))) return NaN; const sgn = /^\s*-/.test(v) ? -1 : 1; return sgn * (Math.abs(p[0]) + (p[1] || 0) / 60 + (p[2] || 0) / 3600); };

/** Pointing and site from common header keywords: { ra, dec [deg, NaN when absent], lat, lon [deg, east positive] }. */
export function framePointing(H) {
  let ra = NaN, dec = NaN;
  for (const k of ['RA_OBJ', 'OBJCTRA', 'RA', 'CRVAL1', 'TELRA']) {
    if (H[k] == null) continue;
    const v = sexa(H[k]); if (!Number.isFinite(v)) continue;
    ra = typeof H[k] === 'string' && /[:\s]/.test(H[k].trim()) ? v * 15 : v; break;       // sexagesimal RA is in hours
  }
  for (const k of ['DEC_OBJ', 'OBJCTDEC', 'DEC', 'CRVAL2', 'TELDEC']) { if (H[k] == null) continue; const v = sexa(H[k]); if (Number.isFinite(v)) { dec = v; break; } }
  let lat = NaN, lon = NaN;
  for (const k of ['SITELAT', 'LATITUDE', 'LAT-OBS', 'OBSLAT', 'GEOLAT']) { const v = sexa(H[k]); if (Number.isFinite(v)) { lat = v; break; } }
  for (const k of ['SITELONG', 'LONGITUD', 'LONG-OBS', 'OBSLONG', 'GEOLON', 'OBSGEO-L']) { const v = sexa(H[k]); if (Number.isFinite(v)) { lon = v; break; } }
  return { ra, dec, lat, lon };
}

/**
 * Airmass of a frame: the AIRMASS (or SECZ) keyword, else the mean of AMSTART and AMEND, else sec(z) from an altitude or zenith-distance keyword
 * (TELALT as in EXOTIC, ALTITUDE, ALT, OBJCTALT, CENTALT, ELEVATIO; ZD, ZENITH), else computed from the target
 * position, the site and the time when all are known (`fallback` = { jdUtc, ra, dec, lat, lon }), else NaN.
 * @returns { airmass, source }
 */
export function frameAirmass(H, fallback = null) {
  const am = (k) => { const v = num(H, k); return Number.isFinite(v) && v >= 0.99 && v < 40 ? v : NaN; };
  for (const k of ['AIRMASS', 'SECZ']) { const v = am(k); if (Number.isFinite(v)) return { airmass: v, source: k }; }
  for (const [k0, k1] of [['AMSTART', 'AMEND'], ['ESO TEL AIRM START', 'ESO TEL AIRM END']]) { const a = am(k0), b = am(k1); if (Number.isFinite(a) || Number.isFinite(b)) return Number.isFinite(a) && Number.isFinite(b) ? { airmass: 0.5 * (a + b), source: k0 + '+' + k1 } : { airmass: Number.isFinite(a) ? a : b, source: Number.isFinite(a) ? k0 : k1 }; }
  for (const k of ['TELALT', 'ALTITUDE', 'ALT', 'OBJCTALT', 'CENTALT', 'ELEVATIO', 'ALT-OBJ']) { const v = sexa(H[k]); if (Number.isFinite(v) && v > 0 && v <= 90) return { airmass: 1 / Math.cos((90 - v) * D2R), source: k }; }
  for (const k of ['ZD', 'ZENITH', 'ZENITHD']) { const v = sexa(H[k]); if (Number.isFinite(v) && v >= 0 && v < 90) return { airmass: 1 / Math.cos(v * D2R), source: k }; }
  if (fallback && [fallback.jdUtc, fallback.ra, fallback.dec, fallback.lat, fallback.lon].every(Number.isFinite)) { const v = airmassAt(fallback.jdUtc, fallback.ra, fallback.dec, fallback.lat, fallback.lon); if (Number.isFinite(v)) return { airmass: v, source: 'computed' }; }
  return { airmass: NaN, source: null };
}

// ---------------------------------------------------------------------------------------------------------
// Pixel scale, WCS, pier side

/**
 * Image scale in arcsec per pixel: IM_SCALE, PIXSCALE (EXOTIC's two), SCALE, PIXSCAL, SECPIX, SECPIX1/2, PIXSCAL1/2,
 * then the WCS (CD matrix, PC + CDELT, CDELT on celestial axes: the mean of the two axis scales, as EXOTIC does
 * with astropy's proj_plane_pixel_scales), then pixel size and focal length (206.265 * XPIXSZ [um] / FOCALLEN [mm]).
 * XPIXSZ is taken as the size of a binned pixel, which is what MaxIm DL, SBIG, N.I.N.A., SharpCap and ASCOM
 * drivers write; pass { unbinnedPixelSize: true } to multiply by XBINNING for software that does not.
 * @returns { scale, x, y (arcsec/px, NaN when unknown), source }
 */
export function pixelScale(H, opts = {}) {
  const pos = (v) => Number.isFinite(v) && v > 0, res = (x, y, source) => ({ scale: 0.5 * (x + y), x, y, source });
  for (const k of ['IM_SCALE', 'PIXSCALE', 'SCALE', 'PIXSCAL', 'SECPIX']) { const v = Math.abs(num(H, k)); if (pos(v)) return res(v, v, k); }
  for (const k of ['SECPIX', 'PIXSCAL']) { const a = Math.abs(num(H, k + '1')), b = Math.abs(num(H, k + '2')); if (pos(a)) return res(a, pos(b) ? b : a, k + '1'); }
  const cd = wcsMatrix(H);
  if (cd && cd.celestial) { const x = Math.hypot(cd.m[0], cd.m[2]) * 3600, y = Math.hypot(cd.m[1], cd.m[3]) * 3600; if (pos(x) && pos(y)) return res(x, y, cd.source); }
  const px = num(H, 'XPIXSZ'), py = num(H, 'YPIXSZ'), fl = num(H, 'FOCALLEN');
  if (pos(px) && pos(fl)) {
    const bx = opts.unbinnedPixelSize && pos(num(H, 'XBINNING')) ? num(H, 'XBINNING') : 1, by = opts.unbinnedPixelSize && pos(num(H, 'YBINNING')) ? num(H, 'YBINNING') : bx;
    return res(206.264806 * px * bx / fl, 206.264806 * (pos(py) ? py : px) * by / fl, 'XPIXSZ/FOCALLEN');
  }
  return { scale: NaN, x: NaN, y: NaN, source: null };
}

// The linear part of a WCS in degrees per pixel, [m11, m12, m21, m22]: the CD matrix, else PC * CDELT, else CROTA2 + CDELT
function wcsMatrix(H) {
  const g = (k) => num(H, k), celestial = /RA|LON|DEC|LAT/i.test(String(H.CTYPE1 ?? '')) && /RA|LON|DEC|LAT/i.test(String(H.CTYPE2 ?? ''));
  if (['CD1_1', 'CD1_2', 'CD2_1', 'CD2_2'].some((k) => Number.isFinite(g(k)))) return { m: [g('CD1_1') || 0, g('CD1_2') || 0, g('CD2_1') || 0, g('CD2_2') || 0], source: 'CD', celestial: celestial || !('CTYPE1' in H) };
  const d1 = g('CDELT1'), d2 = g('CDELT2');
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return null;
  if (['PC1_1', 'PC1_2', 'PC2_1', 'PC2_2'].some((k) => Number.isFinite(g(k)))) {
    const one = (k, dflt) => (Number.isFinite(g(k)) ? g(k) : dflt);
    return { m: [d1 * one('PC1_1', 1), d1 * one('PC1_2', 0), d2 * one('PC2_1', 0), d2 * one('PC2_2', 1)], source: 'PC+CDELT', celestial };
  }
  const rot = g('CROTA2');
  if (Number.isFinite(rot) && rot !== 0) { const c = Math.cos(rot * D2R), s = Math.sin(rot * D2R); return { m: [d1 * c, -d2 * s, d1 * s, d2 * c], source: 'CDELT+CROTA2', celestial }; }
  return { m: [d1, 0, 0, d2], source: 'CDELT', celestial };
}

/**
 * A minimal celestial WCS: the gnomonic (TAN) projection with CRVAL, CRPIX and CD, PC + CDELT or CDELT + CROTA2.
 * Pixel coordinates are this module's: zero-based, the centre of the first pixel at (0, 0) (FITS CRPIX is one-based).
 * SIP and other distortions are not applied (`sip` / `distortion` say they are there); a projection other than
 * TAN, or LONPOLE other than 180, sets `approximate` and the result is then only the tangent-plane approximation.
 * @returns null without CRVAL / CRPIX / a matrix, else { projection, approximate, sip, distortion, crval, crpix,
 *          cd: [m11, m12, m21, m22] deg/px, scale [arcsec/px], rotation (position angle of the +y axis, deg east of
 *          north), flipped (true when east is to the right with north up), pixToSky(x, y) -> [ra, dec] deg,
 *          skyToPix(ra, dec) -> [x, y] (NaN on the far hemisphere) }
 */
export function readWcs(H) {
  const mat = wcsMatrix(H), ra0 = num(H, 'CRVAL1'), de0 = num(H, 'CRVAL2'), px0 = num(H, 'CRPIX1'), py0 = num(H, 'CRPIX2');
  if (!mat || ![ra0, de0, px0, py0].every(Number.isFinite)) return null;
  const [a, b, c, d] = mat.m, det = a * d - b * c;
  if (!(Math.abs(det) > 0)) return null;
  const ct1 = String(H.CTYPE1 ?? '').trim().toUpperCase(), ct2 = String(H.CTYPE2 ?? '').trim().toUpperCase();
  const projection = (ct1.match(/^[A-Z]+-+([A-Z]{3})/) || [null, ''])[1], sip = /-SIP$/.test(ct1) || 'A_ORDER' in H || 'B_ORDER' in H;
  const distortion = sip ? 'SIP' : /-TPV|-TNX|-ZPX/.test(ct1 + ct2) || 'PV1_1' in H || 'PV2_1' in H ? 'PV' : 'A_0_2' in H ? 'SIP' : null;
  const lonpole = num(H, 'LONPOLE'), swapped = /^(DEC|[A-Z]LAT)/.test(ct1);          // (Dec, RA) axis order
  const r0 = (swapped ? de0 : ra0) * D2R, d0 = (swapped ? ra0 : de0) * D2R, s0 = Math.sin(d0), c0 = Math.cos(d0);
  const pixToSky = (x, y) => {
    const u = x + 1 - px0, v = y + 1 - py0;
    let xi = (a * u + b * v) * D2R, eta = (c * u + d * v) * D2R;
    if (swapped) [xi, eta] = [eta, xi];
    const den = c0 - eta * s0, ra = r0 + Math.atan2(xi, den), dec = Math.atan2(s0 + eta * c0, Math.hypot(xi, den));
    return [(((ra / D2R) % 360) + 360) % 360, dec / D2R];
  };
  const skyToPix = (ra, dec) => {
    const da = ra * D2R - r0, sd = Math.sin(dec * D2R), cd = Math.cos(dec * D2R), cosc = s0 * sd + c0 * cd * Math.cos(da);
    if (!(cosc > 0)) return [NaN, NaN];
    let xi = cd * Math.sin(da) / cosc / D2R, eta = (c0 * sd - s0 * cd * Math.cos(da)) / cosc / D2R;
    if (swapped) [xi, eta] = [eta, xi];
    return [(d * xi - b * eta) / det + px0 - 1, (-c * xi + a * eta) / det + py0 - 1];
  };
  return {
    projection: projection || 'TAN', approximate: (projection !== '' && projection !== 'TAN') || (Number.isFinite(lonpole) && lonpole !== 180), sip, distortion,
    crval: [ra0, de0], crpix: [px0, py0], cd: mat.m, source: mat.source, scale: 0.5 * (Math.hypot(a, c) + Math.hypot(b, d)) * 3600,
    rotation: Math.atan2(swapped ? d : b, swapped ? b : d) / D2R, flipped: (swapped ? -det : det) > 0, pixToSky, skyToPix,
  };
}

/**
 * Which side of the pier a German equatorial mount was on, to anticipate a meridian flip between frames:
 * any keyword with PIER in its name (PIERSIDE, PIER_SIDE, PIER-SID, HIERARCH ... PIER SIDE) holding EAST / WEST
 * (also E / W, pierEast / pierWest, or the ASCOM numbers 0 = east, 1 = west).
 * @returns { side: 'east' | 'west' | null, keyword }
 */
export function pierSide(H) {
  for (const k of Object.keys(H)) {
    if (!/PIER/i.test(k)) continue;
    const v = H[k], s = typeof v === 'string' ? v.trim().toLowerCase() : v;
    const side = typeof s === 'string' ? (/west|^w$/.test(s) ? 'west' : /east|^e$/.test(s) ? 'east' : null) : s === 0 ? 'east' : s === 1 ? 'west' : null;
    if (side) return { side, keyword: k };
  }
  return { side: null, keyword: null };
}

// ---------------------------------------------------------------------------------------------------------
// Bayer (one-shot colour) frames

/**
 * The colour filter array of a frame from its header: BAYERPAT, COLORTYP, CFA_PAT, CFAPAT or BAYER holding four
 * of R, G, B (first row left to right, then the second row). XBAYROFF / YBAYROFF (odd) shift the pattern.
 * ROWORDER is passed on, not applied: with 'BOTTOM-UP' files some software means the pattern to be read from
 * the top row of the displayed image; check on a known colour target.
 * @returns null for a monochrome frame, else { pattern: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG', keyword, xoff, yoff, rowOrder }
 */
export function bayerPattern(H) {
  for (const k of ['BAYERPAT', 'COLORTYP', 'CFA_PAT', 'CFAPAT', 'BAYER', 'BAYERPTN']) {
    const v = typeof H[k] === 'string' ? H[k].trim().toUpperCase() : '';
    if (!/^[RGB]{4}$/.test(v)) continue;
    const xoff = (num(H, 'XBAYROFF') | 0) & 1, yoff = (num(H, 'YBAYROFF') | 0) & 1;
    let p = v.split('');
    if (xoff) p = [p[1], p[0], p[3], p[2]];
    if (yoff) p = [p[2], p[3], p[0], p[1]];
    return { pattern: p.join(''), keyword: k, xoff, yoff, rowOrder: typeof H.ROWORDER === 'string' ? H.ROWORDER.trim().toUpperCase() : null };
  }
  return null;
}

/**
 * Bilinear demosaicing of a Bayer frame, the same as colour_demosaicing.demosaicing_CFA_Bayer_bilinear that EXOTIC
 * calls: each colour is its own samples convolved with [[1,2,1],[2,4,2],[1,2,1]]/4 (red, blue) or
 * [[0,1,0],[1,4,1],[0,1,0]]/4 (green), the image edge handled as scipy.ndimage's 'reflect' (the edge pixel repeated).
 * `pattern` gives the colours of pixels (x, y) = (0,0), (1,0), (0,1), (1,1), e.g. 'RGGB'.
 * @returns { r, g, b (Float32Array, same size as the frame), width, height }
 */
export function demosaicBilinear(data, width, height, pattern = 'RGGB') {
  const pat = String(pattern).trim().toUpperCase();
  if (!/^[RGB]{4}$/.test(pat)) throw new Error('Bayer pattern must be four of R, G, B (RGGB, BGGR, GRBG, GBRG), not ' + pattern);
  const n = width * height, planes = { R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n) };
  const ch = [0, 1, 2, 3].map((k) => 'RGB'.indexOf(pat[k]));
  const acc = new Float64Array(3), ys = [0, 0, 0], xs = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    ys[0] = y > 0 ? y - 1 : 0; ys[1] = y; ys[2] = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      xs[0] = x > 0 ? x - 1 : 0; xs[1] = x; xs[2] = x < width - 1 ? x + 1 : width - 1;
      acc[0] = acc[1] = acc[2] = 0;
      for (let j = 0; j < 3; j++) {
        const row = ys[j] * width, py = (ys[j] & 1) << 1;
        for (let i = 0; i < 3; i++) {
          const c = ch[py | (xs[i] & 1)], centre = (j === 1) + (i === 1);       // 2 at the centre, 1 on the cross, 0 at a corner
          acc[c] += (c === 1 ? (centre === 2 ? 4 : centre) : (1 << centre)) * data[row + xs[i]];
        }
      }
      const o = y * width + x;
      planes.R[o] = acc[0] / 4; planes.G[o] = acc[1] / 4; planes.B[o] = acc[2] / 4;
    }
  }
  return { r: planes.R, g: planes.G, b: planes.B, width, height };
}

const MIXES = { red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], gray: [0.299, 0.587, 0.114], grey: [0.299, 0.587, 0.114], blueblock: [0.299, 0.587, 0] };
/**
 * One image from the R, G, B planes, as EXOTIC's demosaic_out: 'red', 'green' (the default, also for an unknown
 * name), 'blue', 'gray' (0.299, 0.587, 0.114), 'blueblock' (0.299, 0.587, 0) or [wR, wG, wB]; the weights are
 * divided by their sum. opts: { truncate: true to cut towards zero as EXOTIC's cast back to an integer image
 * does, out: a typed array to fill }. Returns a Float32Array (or `out`).
 */
export function mixChannels(rgb, weights = 'green', opts = {}) {
  const w0 = Array.isArray(weights) || ArrayBuffer.isView(weights) ? Array.from(weights) : (MIXES[String(weights).toLowerCase()] || MIXES.green);
  const s = w0[0] + w0[1] + w0[2], w = [w0[0] / s, w0[1] / s, w0[2] / s], n = rgb.r.length, out = opts.out && opts.out.length === n ? opts.out : new Float32Array(n);
  const { r, g, b } = rgb;
  if (opts.truncate) for (let i = 0; i < n; i++) out[i] = Math.trunc(r[i] * w[0] + g[i] * w[1] + b[i] * w[2]);
  else for (let i = 0; i < n; i++) out[i] = r[i] * w[0] + g[i] * w[1] + b[i] * w[2];
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Target pixel files

/**
 * Read a TESS or Kepler/K2 target pixel file, or a TESScut cutout (same layout): the table of cadences with an
 * image in each cell, and the aperture image.
 * Times: the TIME column is BJD_TDB - (BJDREFI + BJDREFF) at mid-cadence (BTJD for TESS, BKJD for Kepler); `time`
 * here is that column and `bjdRef` the reference, so BJD_TDB = time + bjdRef.
 * @returns { mission, object, id, sector, quarter, camera, ccd, ra, dec, nx, ny, ncad, time, bjdRef, timeUnit,
 *            cadenceno, flux, fluxErr, fluxBkg, raw, quality, posCorr1, posCorr2, aperture (Int32Array ny*nx or null),
 *            exptime [s], cadence [d], col0, row0 (CCD coordinates of pixel 0,0), bkgSubtracted, header }
 *   flux etc. are Float32Array of ncad * ny * nx, cadence-major.
 */
export function readTargetPixelFile(fits) {
  const ti = fits.hdus.findIndex((h) => h.type === 'bintable' && (h.name === 'PIXELS' || h.name === 'TARGETTABLES' || Object.keys(h.header).some((k) => /^TTYPE/.test(k) && String(h.header[k]).trim() === 'FLUX')));
  if (ti < 0) throw new Error('No pixel table (a binary table with a FLUX column) in this file.');
  const P = fits.hdus[0].header, hdu = fits.hdus[ti], H = hdu.header, tab = readBinTable(fits, ti);
  const fcol = tab.columns.find((c) => c.name.toUpperCase() === 'FLUX');
  if (!fcol || !fcol.dim || fcol.dim.length !== 2) throw new Error('The FLUX column has no 2D TDIM; this is not a target pixel file.');
  const [nx, ny] = fcol.dim, ncad = tab.nrows;
  const tcol = tab.columns.find((c) => c.name.toUpperCase() === 'TIME');
  const refI = num(H, 'BJDREFI'), refF = num(H, 'BJDREFF');
  const bjdRef = (Number.isFinite(refI) ? refI : 0) + (Number.isFinite(refF) ? refF : 0);
  const tel = String(P.TELESCOP || H.TELESCOP || '').trim();
  const mission = /TESS/i.test(tel) ? 'TESS' : /Kepler/i.test(tel) ? (P.MISSION && /K2/.test(P.MISSION) ? 'K2' : 'Kepler') : tel || 'unknown';
  const ai = fits.hdus.findIndex((h) => h.type === 'image' && h.name === 'APERTURE' && h.shape.length === 2 && h.header.NAXIS1 === nx && h.header.NAXIS2 === ny);
  let aperture = null;
  if (ai >= 0) { const im = readImage(fits, ai, { float64: true }); aperture = Int32Array.from(im.data); }
  const cadence = num(H, 'TIMEDEL'), frametim = num(H, 'FRAMETIM'), numfrm = num(H, 'NUM_FRM');
  const exptime = Number.isFinite(frametim) && Number.isFinite(numfrm) ? frametim * numfrm : Number.isFinite(num(H, 'INT_TIME')) && Number.isFinite(numfrm) ? num(H, 'INT_TIME') * numfrm : Number.isFinite(cadence) ? cadence * 86400 : NaN;
  const ci = fcol.index;
  const col = (n) => tab.column(n);
  const isCut = !tab.columns.some((c) => c.name.toUpperCase() === 'CADENCENO') || tab.columns.some((c) => c.name.toUpperCase() === 'FFI_FILE');
  return {
    mission, object: String(P.OBJECT || H.OBJECT || '').trim(), id: P.TICID ?? P.KEPLERID ?? H.TICID ?? H.KEPLERID ?? null,
    sector: P.SECTOR ?? H.SECTOR ?? null, quarter: P.QUARTER ?? P.CAMPAIGN ?? null, camera: P.CAMERA ?? H.CAMERA ?? null, ccd: P.CCD ?? H.CCD ?? null,
    ra: num(P, 'RA_OBJ'), dec: num(P, 'DEC_OBJ'), tessmag: num(P, 'TESSMAG'), kepmag: num(P, 'KEPMAG'),
    nx, ny, ncad, time: tcol ? Float64Array.from(col('TIME')) : new Float64Array(ncad).fill(NaN), bjdRef, timeUnit: String(H.TIMEUNIT || 'd').trim(), timeSys: String(H.TIMESYS || 'TDB').trim(),
    cadenceno: col('CADENCENO'), flux: col('FLUX'), fluxErr: col('FLUX_ERR'), fluxBkg: col('FLUX_BKG'), raw: null,
    quality: col('QUALITY') || new Int32Array(ncad), posCorr1: col('POS_CORR1'), posCorr2: col('POS_CORR2'), aperture,
    exptime, cadence, col0: num(H, `1CRV${ci}P`), row0: num(H, `2CRV${ci}P`), bkgSubtracted: !isCut, isCutout: isCut, header: H, primary: P,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Writing (used by the page's synthetic demo and by tests of the round trip)

// ---------------------------------------------------------------------------------------------------------
// Writing

const KEY_RE = /^[A-Z0-9_-]{1,8}$/;
const ASCII_MAP = { '·': '-', '−': '-', '–': '-', '—': '-', '±': '+/-', '°': 'deg', '′': "'", '″': '"', '‘': "'", '’': "'", '“': '"', '”': '"', 'µ': 'u', '×': 'x', '…': '...', '★': '*', '⊙': 'sun' };
/** Text as FITS allows it (printable ASCII): common symbols spelled out, accents dropped, anything else '?'. */
export const fitsAscii = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => ASCII_MAP[c] ?? (c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '') || '?'));
/** A keyword value as FITS text: logical T/F, integer, real (shortest exact form, E exponent), or a quoted string. */
function fitsValue(v) {
  if (typeof v === 'boolean') return { text: (v ? 'T' : 'F').padStart(20), fixed: true };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('FITS cannot store NaN or infinity in a keyword');
    let t = Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : String(v).replace('e', 'E');
    if (!/[.E]/.test(t) && !Number.isInteger(v)) t += '.';
    if (/E/.test(t) && !/\./.test(t.split('E')[0])) t = t.replace('E', '.E');
    return { text: t.padStart(20), fixed: t.length <= 20 };
  }
  return null;
}
const quote = (s) => "'" + s.replace(/'/g, "''") + "'";
/**
 * Header cards as 80-character lines. `cards` is a list of [key, value, comment] (or { key, value, comment });
 * COMMENT and HISTORY take their text as the value; strings longer than a card continue on CONTINUE cards (the
 * OGIP long-string convention; LONGSTRN is added); undefined / null / NaN values are left out. Keys are checked
 * (1-8 of A-Z 0-9 _ -). Returns the lines without END.
 */
export function headerLines(cards) {
  const lines = [], seen = new Set(); let long = false;
  for (const c of cards) {
    const [key, value, comment = ''] = Array.isArray(c) ? c : [c.key, c.value, c.comment];
    if (!KEY_RE.test(key)) throw new Error(`"${key}" is not a FITS keyword (1-8 characters of A-Z, 0-9, _ and -)`);
    if (key === 'COMMENT' || key === 'HISTORY' || key === '') {
      const t = fitsAscii(value ?? '');
      // wrapped at spaces where possible, 72 characters a card
      let rest = t;
      do {
        let cut = rest.length <= 72 ? rest.length : rest.lastIndexOf(' ', 72);
        if (cut <= 0) cut = Math.min(72, rest.length);
        lines.push((key.padEnd(8) + rest.slice(0, cut)).padEnd(80));
        rest = rest.slice(cut).replace(/^ /, '');
      } while (rest.length);
      continue;
    }
    if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) continue;
    if (key !== 'CONTINUE' && seen.has(key)) throw new Error(`keyword ${key} given twice`);
    seen.add(key);
    const cm = fitsAscii(comment);
    const v = fitsValue(value);
    if (v) { lines.push((key.padEnd(8) + '= ' + v.text + (cm ? ' / ' + cm : '')).slice(0, 80).padEnd(80)); continue; }
    const str = fitsAscii(value);
    const q = quote(str.padEnd(8));
    if (q.length <= 70) { lines.push((key.padEnd(8) + '= ' + q.padEnd(20) + (cm ? ' / ' + cm : '')).slice(0, 80).padEnd(80)); continue; }
    // long string: pieces of at most 67 characters (quotes doubled inside, never split), '&' at the end of all but the last
    if (!long) lines.push(...headerLines([['LONGSTRN', 'OGIP 1.0', 'long strings continue on CONTINUE cards']]));   // before the first long string, never before SIMPLE
    long = true;
    const pieces = []; let cur = '';
    for (const ch of str) { const add = ch === "'" ? "''" : ch; if (cur.length + add.length > 66) { pieces.push(cur); cur = ''; } cur += add; }
    pieces.push(cur);
    pieces.forEach((p, i) => {
      const body = "'" + p + (i < pieces.length - 1 ? '&' : '') + "'";
      lines.push(((i === 0 ? key.padEnd(8) + '= ' : 'CONTINUE  ') + body + (i === pieces.length - 1 && cm ? ' / ' + cm : '')).slice(0, 80).padEnd(80));
    });
  }
  return lines;
}

/**
 * Encode a single-image FITS file. bitpix: 8 (unsigned bytes), 16 (unsigned 16-bit, BZERO 32768: what cameras give),
 * 32 (signed 32-bit) or -32 (float). `cards`: an ordered list as headerLines takes, written after the structural
 * keywords. Values are rounded and clipped to the type's range. Returns a Uint8Array.
 */
export function encodeFits(data, width, height, cards = [], { bitpix = 16 } = {}) {
  if (![8, 16, 32, -32].includes(bitpix)) throw new Error('encodeFits writes BITPIX 8, 16, 32 or -32');
  const head = [['SIMPLE', true, 'conforms to FITS standard'], ['BITPIX', bitpix, bitpix === -32 ? 'IEEE single precision' : bitpix + '-bit integers'], ['NAXIS', 2], ['NAXIS1', width, 'columns'], ['NAXIS2', height, 'rows']];
  if (bitpix === 16) head.push(['BZERO', 32768, 'unsigned 16-bit: physical = stored + 32768'], ['BSCALE', 1]);
  const structural = new Set(['SIMPLE', 'BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'BZERO', 'BSCALE', 'EXTEND', 'END']);
  const extra = cards.filter((c) => !structural.has(Array.isArray(c) ? c[0] : c.key));
  const lines = [...headerLines(head), ...headerLines(extra), 'END'.padEnd(80)];
  const hb = Math.ceil(lines.length / 36) * BLOCK, n = width * height, bytes = Math.abs(bitpix) / 8, db = Math.ceil(n * bytes / BLOCK) * BLOCK;
  const out = new Uint8Array(hb + db).fill(32, 0, hb), text = lines.join('');
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  const dv = new DataView(out.buffer, hb);
  if (bitpix === -32) for (let i = 0; i < n; i++) dv.setFloat32(i * 4, data[i]);
  else if (bitpix === 16) for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.max(0, Math.min(65535, Math.round(data[i]))) - 32768);
  else if (bitpix === 32) for (let i = 0; i < n; i++) dv.setInt32(i * 4, Math.max(-2147483648, Math.min(2147483647, Math.round(data[i]))));
  else for (let i = 0; i < n; i++) dv.setUint8(i, Math.max(0, Math.min(255, Math.round(data[i]))));
  return out;
}

/** Encode a single-image FITS file (BITPIX -32 or 16) from a typed array; `cards` is an object of extra keywords ({ KEY: value | [value, comment] }). Returns Uint8Array. */
export function encodeFitsImage(data, width, height, cards = {}, bitpix = -32) {
  if (bitpix !== -32 && bitpix !== 16) throw new Error('encodeFitsImage writes BITPIX -32 or 16');
  return encodeFits(data, width, height, Object.entries(cards).map(([k, v]) => (Array.isArray(v) ? [k, v[0], v[1]] : [k, v])), { bitpix });
}
