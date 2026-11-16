// Reading .zip archives in the browser (and Node 18+) without a library and without inflating them whole.
//
// The central directory at the end of the archive lists every entry with its compression method, CRC-32, sizes and
// the offset of its local header (APPNOTE.TXT 6.3.10, with the ZIP64 records for archives over 4 GB or 65,535
// entries). An entry becomes a File that is a *slice of the archive's Blob* and costs no memory until it is read:
//   stored (method 0)     the slice itself;
//   deflated (method 8)   the slice of raw DEFLATE data between a 10-byte gzip header and an 8-byte trailer made from the
//                         directory's CRC-32 and size, i.e. a valid .gz member, which the FITS reader (and
//                         DecompressionStream('gzip'), which checks the CRC) already decode. Nothing is re-compressed.
// So a zip of 2,000 frames costs one read of its directory, and each frame is inflated only when the pipeline reads
// it, one at a time (in the worker). Such Files survive postMessage to a worker. A zip inside a zip is opened the same
// way (inflated first when it is itself deflated). Not supported: encryption, methods other than 0 and 8 (deflate64,
// bzip2, LZMA, zstd), archives split over several disks; those entries are listed with the reason.
// Checked in test/zip.test.mjs against archives written by Python's zipfile (test/make_zip_reference.py) and EXOTIC's
// sample-data zip.

const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

/** True when the bytes start like a zip (a local header "PK\3\4", or the end record of an empty archive). */
export function isZip(buf) { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf, 0, Math.min(4, buf.byteLength)); return u.length >= 4 && u[0] === 0x50 && u[1] === 0x4b && ((u[2] === 3 && u[3] === 4) || (u[2] === 5 && u[3] === 6)); }
/** True when a file name ends in .zip. */
export const ZIP_NAME = /\.zip$/i;

const asBlob = (src) => (src instanceof Blob ? src : new Blob([src]));
const readAt = async (blob, a, b) => new DataView(await blob.slice(a, b).arrayBuffer());
const decodeName = (u8, utf8) => { try { return new TextDecoder(utf8 ? 'utf-8' : 'utf-8', { fatal: false }).decode(u8); } catch { return String.fromCharCode(...u8); } };

/**
 * Read the central directory of a zip (a Blob / File, or bytes).
 * @returns { entries: [{ path, name, dir, method, encrypted, crc, csize, size, localOffset, supported, why }], comment, zip64 }
 */
export async function readZip(src) {
  const blob = asBlob(src), len = blob.size;
  if (len < 22) throw new Error('Not a zip archive (too short).');
  // the end-of-central-directory record sits in the last 22 + 65,535 bytes (after an optional comment)
  const tailLen = Math.min(len, 22 + 65535 + 20), tail = new Uint8Array(await blob.slice(len - tailLen, len).arrayBuffer());
  let e = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
  if (e < 0) throw new Error('Not a zip archive (no end-of-central-directory record).');
  const dv = new DataView(tail.buffer, tail.byteOffset);
  let disk = dv.getUint16(e + 4, true), cdDisk = dv.getUint16(e + 6, true), count = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
  const clen = dv.getUint16(e + 20, true), comment = decodeName(tail.subarray(e + 22, e + 22 + clen), true);
  let zip64 = false;
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const l = e - 20;
    if (l >= 0 && dv.getUint32(l, true) === SIG_LOC64) {
      const off64 = Number(dv.getBigUint64(l + 8, true)), r = await readAt(blob, off64, off64 + 56);
      if (r.getUint32(0, true) !== SIG_EOCD64) throw new Error('Damaged ZIP64 archive (no ZIP64 end record).');
      disk = r.getUint32(16, true); cdDisk = r.getUint32(20, true); count = Number(r.getBigUint64(32, true)); cdSize = Number(r.getBigUint64(40, true)); cdOff = Number(r.getBigUint64(48, true)); zip64 = true;
    }
  }
  if (disk !== 0 || cdDisk !== 0) throw new Error('This zip is split over several files (a multi-disk archive): join it first.');
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), cv = new DataView(cd.buffer, cd.byteOffset), entries = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (cv.getUint32(p, true) !== SIG_CEN) throw new Error(`Damaged zip directory at entry ${k + 1}.`);
    const flags = cv.getUint16(p + 8, true), method = cv.getUint16(p + 10, true), crc = cv.getUint32(p + 16, true);
    let csize = cv.getUint32(p + 20, true), size = cv.getUint32(p + 24, true);
    const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    let localOffset = cv.getUint32(p + 42, true);
    const path = decodeName(cd.subarray(p + 46, p + 46 + nl), flags & 0x800);
    // ZIP64 extra field (0x0001): the 64-bit values, in order, of those that are 0xffffffff
    for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) {
      const id = cv.getUint16(x, true), sz = cv.getUint16(x + 2, true);
      if (id === 1) { let q = x + 4; if (size === 0xffffffff) { size = Number(cv.getBigUint64(q, true)); q += 8; } if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(q, true)); q += 8; } if (localOffset === 0xffffffff) { localOffset = Number(cv.getBigUint64(q, true)); q += 8; } zip64 = true; }
      x += 4 + sz;
    }
    const dir = /\/$/.test(path), encrypted = !!(flags & 1), supported = !dir && !encrypted && (method === 0 || method === 8);
    const parts = path.split('/').filter(Boolean);
    entries.push({ path, name: parts[parts.length - 1] || path, dir, method, encrypted, crc, csize, size, localOffset, flags, supported,
      why: dir ? 'folder' : encrypted ? 'encrypted' : supported ? '' : `compression method ${method} (${({ 9: 'deflate64', 12: 'bzip2', 14: 'LZMA', 93: 'zstd', 95: 'xz', 98: 'PPMd' })[method] || 'unknown'}) is not supported: re-zip with ordinary deflate` });
    p += 46 + nl + xl + cl;
  }
  return { entries, comment, zip64, blob };
}

/** Where an entry's data start: after its local header, whose name and extra lengths can differ from the directory's. */
async function dataStart(blob, en) {
  if (en._start != null) return en._start;
  const h = await readAt(blob, en.localOffset, en.localOffset + 30);
  if (h.getUint32(0, true) !== SIG_LOC) throw new Error(`${en.path}: damaged zip (no local header where the directory points)`);
  en._start = en.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  return en._start;
}

const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const GZ_HEAD = Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);

/**
 * The entry as a File (lazy: a slice of the archive). Stored entries are the bytes themselves; deflated ones are the
 * raw DEFLATE data wrapped as a gzip member (header + data + CRC-32 + size), so anything that reads .gz reads them.
 * The File carries `relPath` (the path inside the zip, prefixed by `prefix`), `zipMethod` and `unpackedSize`.
 */
export async function entryFile(zip, en, prefix = '') {
  if (!en.supported) throw new Error(`${en.path}: ${en.why}`);
  const blob = zip.blob, a = await dataStart(blob, en), data = blob.slice(a, a + en.csize);
  const parts = en.method === 0 ? [data] : [GZ_HEAD, data, u32(en.crc), u32(en.size % 4294967296)];
  const f = new File(parts, en.name, { type: en.method === 0 ? 'application/octet-stream' : 'application/gzip' });
  f.relPath = prefix + en.path; f.zipMethod = en.method; f.unpackedSize = en.size;
  return f;
}

/** The decompressed bytes of an entry (Uint8Array): for small entries and nested archives. */
export async function inflateEntry(zip, en) {
  const f = await entryFile(zip, en);
  if (en.method === 0) return new Uint8Array(await f.arrayBuffer());
  return new Uint8Array(await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/**
 * Every file of a zip, as lazy Files (see entryFile), folders flattened into `relPath`; zips inside it are opened in
 * turn (to `depth` levels). `filter(path)` chooses entries (default: all); hidden macOS entries (__MACOSX/, ._name,
 * .DS_Store) are skipped.
 * @returns { files: [File], skipped: [{ path, why }], entries: number of entries read, nested: number of inner zips }
 */
export async function zipFiles(src, opts = {}) {
  const { filter = () => true, depth = 2, prefix = '' } = opts, out = { files: [], skipped: [], entries: 0, nested: 0 };
  const zip = await readZip(src);
  for (const en of zip.entries) {
    if (en.dir) continue;
    out.entries++;
    if (/(^|\/)__MACOSX\//.test(en.path) || /(^|\/)\._/.test(en.path) || /(^|\/)\.DS_Store$/.test(en.path)) continue;
    if (ZIP_NAME.test(en.name) && depth > 0) {
      if (!en.supported) { out.skipped.push({ path: prefix + en.path, why: en.why }); continue; }
      const inner = en.method === 0 ? await entryFile(zip, en) : new Blob([await inflateEntry(zip, en)]);
      const r = await zipFiles(inner, { ...opts, depth: depth - 1, prefix: prefix + en.path + '/' });
      out.files.push(...r.files); out.skipped.push(...r.skipped); out.entries += r.entries; out.nested += 1 + r.nested;
      continue;
    }
    if (!filter(prefix + en.path)) continue;
    if (!en.supported) { out.skipped.push({ path: prefix + en.path, why: en.why }); continue; }
    out.files.push(await entryFile(zip, en, prefix));
  }
  return out;
}

/** Expand any .zip among `files` (Files or Blobs with a name) into their contents; other files pass through. */
export async function expandZips(files, opts = {}) {
  const out = [], skipped = []; let zips = 0;
  for (const f of files) {
    let z = ZIP_NAME.test(f.name || '');
    if (!z && f.size >= 4 && !/\.(fits?|fts|gz|fz)$/i.test(f.name || '')) z = isZip(new Uint8Array(await f.slice(0, 4).arrayBuffer()));
    if (!z) { out.push(f); continue; }
    zips++;
    const r = await zipFiles(f, { ...opts, prefix: (f.relPath || f.webkitRelativePath || f.name) + '/' });
    out.push(...r.files); skipped.push(...r.skipped);
  }
  return { files: out, skipped, zips };
}

// ------------------------------------------------------------------------------------------------ writing

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
/** CRC-32 (IEEE 802.3, as zip and gzip use). */
export function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/**
 * A zip of small files, stored without compression (for the page's per-transit CSVs): files [{ name, data: string |
 * Uint8Array }]. Returns a Blob (application/zip). UTF-8 names (flag bit 11).
 */
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const le = (n, b) => { const a = new Uint8Array(b); for (let i = 0; i < b; i++) a[i] = (n >>> (8 * i)) & 0xff; return a; };
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const head = [le(0x04034b50, 4), le(20, 2), le(0x800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), name];
    const hl = head.reduce((s, a) => s + a.length, 0);
    cen.push([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), name]);
    parts.push(...head, data); off += hl + data.length;
  }
  const cd = cen.flat(), cdl = cd.reduce((s, a) => s + a.length, 0);
  parts.push(...cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(cdl, 4), le(off, 4), le(0, 2));
  return new Blob(parts, { type: 'application/zip' });
}
