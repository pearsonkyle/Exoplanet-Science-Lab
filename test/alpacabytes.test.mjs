// Alpaca ImageBytes (src/core/alpacabytes.js): the header and the [x][y] pixel order of the ASCOM Alpaca API
// specification ("ImageBytes - Alpaca's Rapid Image Transfer Protocol"), and byte for byte against the Python
// helper's encoder (esl.cameras.encode_imagebytes), whose output alpyca, the ASCOM Initiative's own client, decodes
// to the camera's pixels in python/tests/test_bridge.py.
import { decodeImageBytes, encodeImageBytes } from '../src/core/alpacabytes.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// a 6 x 4 image, row-major, values = 1000 * (y * 6 + x)
const W = 6, H = 4, img = Uint16Array.from({ length: W * H }, (_, k) => k * 1000);
const b = encodeImageBytes(img, W, H, { clientTx: 7, serverTx: 9 });
const dv = new DataView(b.buffer);
check('header: version 1, transaction ids, data at 44, Int32 image sent as UInt16, rank 2, 6 x 4', [1, 0, 7, 9, 44, 2, 8, 2, 6, 4, 0].every((v, i) => dv.getInt32(i * 4, true) === v));
check('pixels on the wire run down the first column first ([x][y], y fastest)', [0, 1, 2, 3].every((y) => dv.getUint16(44 + y * 2, true) === img[y * W]));
const d = decodeImageBytes(b);
check('decode gives the row-major image back', d.width === W && d.height === H && d.data.every((v, k) => v === img[k]) && d.data instanceof Uint16Array);
const i32 = Int32Array.from({ length: W * H }, (_, k) => k - 10), d32 = decodeImageBytes(encodeImageBytes(i32, W, H, { type: 2 }));
check('Int32 transmission (negative values)', d32.data.every((v, k) => v === i32[k]) && d32.data instanceof Int32Array);
const err = new Uint8Array(44 + 5); new DataView(err.buffer).setInt32(0, 1, true); new DataView(err.buffer).setInt32(4, 0x40B, true); new DataView(err.buffer).setInt32(16, 44, true); err.set(new TextEncoder().encode('busy!'), 44);
check('an error in the header becomes an exception with the message', (() => { try { decodeImageBytes(err); return false; } catch (e) { return e.code === 0x40B && e.message === 'busy!'; } })());

// the same image encoded by the Python helper
const py = new URL('../.venv-py/bin/python', import.meta.url).pathname;
if (existsSync(py)) {
  const hex = execFileSync(py, ['-c', 'import numpy as np, sys; sys.path.insert(0, "python"); from esl.cameras import encode_imagebytes; print(encode_imagebytes((np.arange(24, dtype=np.uint16).reshape(4, 6) * 1000), 7, 9).hex())'], { cwd: new URL('..', import.meta.url).pathname }).toString().trim();
  const p = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  check('bytes from the Python helper (esl.cameras.encode_imagebytes) are identical', p.length === b.length && p.every((v, k) => v === b[k]));
} else console.log('skip Python cross-check: .venv-py missing');

process.exit(ok ? 0 : 1);
