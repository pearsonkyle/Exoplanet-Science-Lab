// Reading and writing the terrain fixtures of test/horizon.test.mjs (Node only).
//   decodePng(buffer)   a minimal PNG reader (8-bit RGB or RGBA, not interlaced: what the Terrarium tiles are)
//   packTile / unpackTile   a fixture is the tile's elevations rounded to whole metres, as int16 differences along
//   each row, gzipped: a third of the size of the PNG. The rounding moves a ridge 10 km away by 0.003 deg at most.
import { inflateSync, gzipSync, gunzipSync } from 'node:zlib';
import { terrariumElevation, TILE_SIZE } from '../../../src/core/horizon.js';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0, type = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), name = buf.toString('latin1', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (name === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9]; if (body[8] !== 8 || (type !== 2 && type !== 6) || body[12] !== 0) throw new Error('PNG: only 8-bit RGB(A), not interlaced'); }
    else if (name === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const bpp = type === 2 ? 3 : 4, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst + x - stride] : 0, c = x >= bpp && y ? out[dst + x - stride - bpp] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = (raw[src + x] + p) & 255;
    }
  }
  return { width: w, height: h, channels: bpp, data: out };
}
/** Elevations [m] of a Terrarium PNG as a Float32Array of 256 * 256. */
export function elevationsFromPng(buf) {
  const p = decodePng(buf); if (p.width !== TILE_SIZE || p.height !== TILE_SIZE) throw new Error('tile is not 256 x 256');
  const e = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < e.length; i++) e[i] = terrariumElevation(p.data[i * p.channels], p.data[i * p.channels + 1], p.data[i * p.channels + 2]);
  return e;
}
export function packTile(elev) {
  const d = new Int16Array(elev.length);
  for (let i = 0; i < elev.length; i++) d[i] = Math.round(elev[i]) - (i % TILE_SIZE ? Math.round(elev[i - 1]) : 0);
  return gzipSync(Buffer.from(d.buffer), { level: 9 });
}
export function unpackTile(buf) {
  const raw = gunzipSync(buf), d = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2), e = new Int16Array(d.length);
  for (let i = 0; i < d.length; i++) e[i] = d[i] + (i % TILE_SIZE ? e[i - 1] : 0);
  return e;
}
