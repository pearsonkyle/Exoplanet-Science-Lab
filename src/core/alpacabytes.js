// ASCOM Alpaca ImageBytes (the binary form of ICamera.ImageArray): a 44-byte header of little-endian int32
//   MetadataVersion (1), ErrorNumber, ClientTransactionID, ServerTransactionID, DataStart, ImageElementType,
//   TransmissionElementType, Rank, Dimension1, Dimension2, Dimension3
// then the pixels in ImageArray order [x][y] (x = column, y fastest). Element types: 1 Int16, 2 Int32, 3 Double,
// 4 Single, 6 Byte, 7 Int64, 8 UInt16, 9 UInt32. Decoded here to a row-major image (data[y * width + x]), the
// convention of every image in this code. No DOM; the Python helper's encoder is esl.cameras.encode_imagebytes.

const TYPES = { 1: [Int16Array, 2, 'getInt16'], 2: [Int32Array, 4, 'getInt32'], 3: [Float64Array, 8, 'getFloat64'], 4: [Float32Array, 4, 'getFloat32'], 6: [Uint8Array, 1, 'getUint8'], 8: [Uint16Array, 2, 'getUint16'], 9: [Uint32Array, 4, 'getUint32'] };

/** @returns { data (typed array, row-major), width, height, elementType, transmissionType, clientTx, serverTx } */
export function decodeImageBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), h = (i) => dv.getInt32(i * 4, true);
  if (u8.byteLength < 44) throw new Error('ImageBytes: shorter than its 44-byte header');
  if (h(0) !== 1) throw new Error(`ImageBytes: metadata version ${h(0)}, expected 1`);
  const start = h(4);
  if (h(1)) throw Object.assign(new Error(new TextDecoder().decode(u8.subarray(start)) || `camera error ${h(1)}`), { code: h(1) });
  const rank = h(7), W = h(8), Hh = h(9), t = TYPES[h(6)];
  if (rank !== 2) throw new Error(`ImageBytes: rank ${rank} (colour planes) is not read; use a mono or raw Bayer mode`);
  if (!t) throw new Error(`ImageBytes: element type ${h(6)} is not read`);
  const [Ctor, size, get] = t, n = W * Hh;
  if (u8.byteLength < start + n * size) throw new Error('ImageBytes: fewer pixels than the header says');
  const out = new Ctor(n);
  // [x][y] on the wire, y fastest -> row-major
  for (let x = 0, k = start; x < W; x++) for (let y = 0; y < Hh; y++, k += size) out[y * W + x] = dv[get](k, true);
  return { data: out, width: W, height: Hh, elementType: h(5), transmissionType: h(6), clientTx: h(2), serverTx: h(3) };
}

/** A row-major image as ImageBytes (for tests and simulators). */
export function encodeImageBytes(data, width, height, { type = 8, clientTx = 0, serverTx = 0 } = {}) {
  const [, size, get] = TYPES[type], set = 'set' + get.slice(3), n = width * height;
  const u8 = new Uint8Array(44 + n * size), dv = new DataView(u8.buffer);
  [1, 0, clientTx, serverTx, 44, 2, type, 2, width, height, 0].forEach((v, i) => dv.setInt32(i * 4, v, true));
  for (let x = 0, k = 44; x < width; x++) for (let y = 0; y < height; y++, k += size) dv[set](k, data[y * width + x], true);
  return u8;
}
