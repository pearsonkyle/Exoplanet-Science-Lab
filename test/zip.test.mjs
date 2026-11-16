// Zip archives (src/core/zip.js) against archives written by Python's zipfile (test/make_zip_reference.py): the
// directory read, stored and deflated entries, ZIP64 fields, nested folders and zips, .fits.gz inside a zip, macOS
// junk, and the photometry page's path for them (readHeaderOnly, frameKind, loadFrame on the lazy Files). EXOTIC's
// sample-data zip (24 MB, outside the repository) is read too when it is present.
import { readFileSync, existsSync, openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import { readZip, zipFiles, entryFile, inflateEntry, isZip, expandZips } from '../src/core/zip.js';
import { openFits, readImage, firstImageHdu } from '../src/core/fits.js';
import { readHeaderOnly, frameKind, loadFrame, FITS_NAME } from '../src/photometry/pipeline.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./zip_reference.json', import.meta.url)));
const md5 = (u8) => createHash('md5').update(u8).digest('hex');
const zbytes = readFileSync(new URL('./data/' + ref.file, import.meta.url)), blob = new Blob([zbytes]);

const z = await readZip(blob), top = ref.entries.filter((e) => !e.nested);
check('the directory lists every entry with its method, sizes and CRC-32', z.entries.length === top.length && top.every((r, i) => { const e = z.entries[i]; return e.path === r.path && e.dir === r.dir && e.size === r.size && e.crc === r.crc && (r.dir || e.method === r.method); }),
  `${z.entries.length} entries (${z.entries.filter((e) => e.method === 8).length} deflated, ${z.entries.filter((e) => !e.dir && e.method === 0).length} stored, ${z.entries.filter((e) => e.dir).length} folders), UTF-8 names ("${z.entries.find((e) => /ü/.test(e.path))?.path}")`);
{
  const b64 = new Blob([readFileSync(new URL('./data/' + ref.zip64.file, import.meta.url))]), z64 = await readZip(b64); let m = 0;
  for (const e of z64.entries) { const r = ref.zip64.entries.find((q) => q.path === e.path); if (r && e.size === r.size && e.crc === r.crc && md5(await inflateEntry(z64, e)) === r.md5) m++; }
  check('ZIP64 end records and extra fields', z64.zip64 === true && ref.zip64.has_eocd64 && m === ref.zip64.entries.length, `${m} of ${ref.zip64.entries.length} entries; a streamed entry with ZIP64 local sizes in the first archive also reads (${z.entries.find((e) => /zip64/.test(e.path)).size} B)`);
}
check('recognised by its first bytes', isZip(zbytes.subarray(0, 4)) && !isZip(readFileSync(new URL('./data/syn_small_f32.fits', import.meta.url)).subarray(0, 4)));
let same = 0, n = 0;
for (const e of z.entries) { if (e.dir) continue; n++; const r = top.find((q) => q.path === e.path); if (md5(await inflateEntry(z, e)) === r.md5) same++; }
check('every entry inflates to the bytes zipfile reads (MD5)', same === n, `${same} of ${n}`);
// the lazy Files: stored = the slice, deflated = a gzip member around the raw DEFLATE data (CRC checked by the decoder)
{
  const e8 = z.entries.find((e) => e.path === 'night1/lights/frame_0001.fits'), e0 = z.entries.find((e) => e.path === 'night1/lights/frame_0002.fits');
  const f8 = await entryFile(z, e8), f0 = await entryFile(z, e0);
  const a8 = new Uint8Array(await new Response(f8.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  check('a deflated entry is a valid .gz member of the archive slice; a stored one is the slice', md5(a8) === ref.md5_of.f32 && md5(new Uint8Array(await f0.arrayBuffer())) === ref.md5_of.i16 && f8.size === e8.csize + 18 && f0.size === e0.size,
    `deflated ${e8.csize} B + 18 B of gzip framing, inflated ${a8.length} B; stored ${f0.size} B`);
  let bad = ''; const fake = { ...e8, crc: (e8.crc ^ 1) >>> 0 }; try { await new Response((await entryFile(z, fake)).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); } catch (err) { bad = String(err.message || err); }
  check('a wrong CRC-32 is caught by the gzip decoder', !!bad, bad.slice(0, 60));
}
// whole tree, nested zips, junk skipped; then the photometry page's own readers on the Files
const all = await zipFiles(blob), paths = all.files.map((f) => f.relPath);
const wantPaths = ref.entries.filter((e) => !e.dir && !/__MACOSX/.test(e.path) && !/\.zip$/.test(e.path)).map((e) => e.path);
check('every file of the tree, inner zips opened, macOS junk left out', paths.length === wantPaths.length && wantPaths.every((p) => paths.includes(p)) && all.nested === 2,
  `${paths.length} files from ${all.entries} entries, ${all.nested} inner zips (one stored, one deflated): ${paths.filter((p) => /\.zip\//.test(p)).join(', ')}`);
{
  const fitsFiles = all.files.filter((f) => FITS_NAME.test(f.name)); let good = 0, kinds = {}; const bad = [];
  for (const f of fitsFiles) {
    const hd = await readHeaderOnly(f), fr = await loadFrame(f);
    kinds[frameKind(hd.header, f.relPath)] = (kinds[frameKind(hd.header, f.relPath)] || 0) + 1;
    if (fr.width > 0 && fr.height > 0 && hd.header.NAXIS === 2) good++; else bad.push(f.relPath);
  }
  check('every FITS file in the zip opens through readHeaderOnly and loadFrame (stored, deflated, .fits.gz stored and deflated, nested)', good === fitsFiles.length, `${good} of ${fitsFiles.length}${bad.length ? '; failed ' + bad.join(', ') : ''}`);
  check('calibration frames are recognised from the folder names inside the zip', kinds.dark === 2 && kinds.flat === 1 && kinds.bias === 1, JSON.stringify(kinds));
  const g = all.files.find((f) => f.relPath === 'night1/lights/frame_0004.fits.gz'), fr = await loadFrame(g), direct = readImage(await openFits(readFileSync(new URL('./data/syn_small_f64.fits', import.meta.url))), -1);
  check('a .fits.gz deflated inside the zip (gzip twice) gives the same pixels as the plain file', fr.data.length === direct.data.length && fr.data.every((v, i) => v === direct.data[i]), `${fr.width} x ${fr.height}`);
}
{
  const f = new File([zbytes], 'night.zip'), r = await expandZips([f, new File([readFileSync(new URL('./data/syn_small_f32.fits', import.meta.url))], 'loose.fits')]);
  check('expandZips replaces a .zip among dropped files by its contents and passes other files through', r.zips === 1 && r.files.length === paths.length + 1 && r.files.some((q) => q.name === 'loose.fits') && r.files.every((q) => q.name === 'loose.fits' || q.relPath.startsWith('night.zip/')));
}
// the page's own (stored) zip writer, read back here and its CRC-32 checked against zlib's
{
  const { makeZip, crc32 } = await import('../src/core/zip.js'), zlib = await import('node:zlib');
  const files = [{ name: 'planet b/E0_2459000.1234.csv', data: 'BJD_TDB,flux\n1,1\n' }, { name: 'ünï.csv', data: new Uint8Array([0, 1, 2, 255]) }];
  const zz = await readZip(makeZip(files)); let m = 0;
  for (const [i, e] of zz.entries.entries()) { const b = await inflateEntry(zz, e), want = typeof files[i].data === 'string' ? new TextEncoder().encode(files[i].data) : files[i].data; if (e.path === files[i].name && md5(b) === md5(want) && e.crc === zlib.crc32(want) && crc32(want) === e.crc) m++; }
  check('the stored-zip writer (per-transit CSVs) reads back, CRC-32 equal to zlib.crc32', m === files.length, `${m} of ${files.length}`);
}
// EXOTIC's sample data (read only)
if (ref.exotic && existsSync(ref.exotic.path)) {
  const t0 = performance.now(), eb = await openAsBlob(ref.exotic.path), ez = await readZip(eb), tDir = performance.now() - t0;
  const files = ez.entries.filter((e) => !e.dir);
  check("EXOTIC's sample zip: directory as zipfile lists it", ez.entries.length === ref.exotic.entries && files.length === ref.exotic.files && files.every((e, i) => e.path === ref.exotic.names[i]), `${ez.entries.length} entries, ${files.length} files, directory read in ${tDir.toFixed(0)} ms from a ${(ref.exotic.size / 1048576).toFixed(1)} MB file`);
  let m = 0; for (const s of ref.exotic.sample) { const e = files.find((q) => q.path === s.path); if (e && md5(await inflateEntry(ez, e)) === s.md5) m++; }
  check("EXOTIC's sample zip: sampled entries inflate to zipfile's bytes", m === ref.exotic.sample.length, ref.exotic.sample.map((s) => s.path.split('/').pop()).join(', '));
  const t1 = performance.now(), zf = await zipFiles(eb), tList = performance.now() - t1, fits = zf.files.filter((f) => FITS_NAME.test(f.name));
  let heads = 0, times = 0; const t2 = performance.now();
  for (const f of fits) { const hd = await readHeaderOnly(f); heads++; if (hd.header['DATE-OBS']) times++; }
  const tHead = performance.now() - t2;
  check("EXOTIC's sample zip: every frame's header read lazily (no frame inflated whole)", heads === ref.exotic.fits && times === heads, `${heads} FITS headers with DATE-OBS in ${(tHead / 1000).toFixed(2)} s (${(tHead / heads).toFixed(1)} ms each); Files made in ${tList.toFixed(0)} ms`);
  const fr = await loadFrame(fits[0]);
  check("EXOTIC's sample zip: a frame decodes", fr.width === 650 && fr.height === 500, `${fits[0].name} ${fr.width} x ${fr.height}`);
} else console.log('skip EXOTIC sample zip (not present at ' + (ref.exotic ? ref.exotic.path : '../EXOTIC_sampledata-1.0.0.zip') + ')');
process.exit(ok ? 0 : 1);
