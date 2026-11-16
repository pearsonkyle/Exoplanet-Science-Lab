// FITS reader against astropy (test/make_photometry_reference.py): pixel values in every BITPIX, scaling and BLANK,
// gzip, image extensions, header parsing, binary tables of real TESS and Kepler target pixel files, and the time
// and airmass functions against astropy.time / astropy.coordinates.
// Then the variants (test/make_fits_variants.py): tile-compressed images in every algorithm and quantisation astropy
// writes, the .fz layout, damaged files, cubes, Bayer frames, every spelling of the time, exposure, airmass and
// pixel scale keywords, a TAN WCS against astropy.wcs, and the pipeline's loadFrame / readHeaderOnly on them.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { openFits, parseFits, readImage, readImageAsync, gunzip, readBinTable, readTargetPixelFile, frameTime, exposureTime, frameAirmass, framePointing, parseFitsDate, taiMinusUtc, tdbMinusUtc, utcToBjdTdb, airmassAt, encodeFitsImage, firstImageHdu, pixelScale, readWcs, pierSide, bayerPattern, demosaicBilinear, mixChannels } from '../src/core/fits.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./photometry_reference.json', import.meta.url)));
const load = (n) => { const b = readFileSync(new URL('./data/' + n, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) if (a[i] === a[i]) s += a[i]; return s; };
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));

// --- every BITPIX: sums and single pixels as astropy reads them
{
  let worst = 0, shapes = true;
  for (const k of ['u8', 'i16', 'i32', 'i64', 'f32', 'f64']) {
    const f = await openFits(load(`syn_small_${k}.fits`)), im = readImage(f), r = ref.small[k];
    // float32 output holds float32 and small integers exactly; the comparison is in double precision otherwise
    const tol = k === 'i64' ? 1e-15 : 0;
    const d = Math.max(rel(sum(im.data), r.sum), Math.abs(im.data[0] - r.first), Math.abs(im.data[im.data.length - 1] - r.last), Math.abs(im.data[3 * im.width + 5] - r.p_3_5));
    worst = Math.max(worst, k === 'i64' ? rel(sum(im.data), r.sum) : d);
    shapes &&= im.height === r.shape[0] && im.width === r.shape[1];
    if (k === 'i64') check('BITPIX 64 pixel values', rel(im.data[0], r.first) < 1e-15 && rel(im.data[3 * im.width + 5], r.p_3_5) < 1e-15, `tolerance ${tol || 1e-15} relative (exact below 2^53)`);
  }
  check('BITPIX 8, 16, 32, 64, -32, -64 decode to astropy\'s values', worst < 1e-12 && shapes, `largest difference ${worst.toExponential(1)} (sums relative, pixels absolute); tolerance 1e-12`);
  const s = readImage(await openFits(load('syn_small_scaled.fits')), -1, { float64: true }), r = ref.small.scaled;
  let nan = 0; for (const v of s.data) if (v !== v) nan++;
  check('BSCALE, BZERO and BLANK', rel(sum(s.data), r.sum) < 1e-13 && nan === r.nan && s.data[0] === r.first && s.data[3 * s.width + 5] === r.p_3_5, `sum differs by ${rel(sum(s.data), r.sum).toExponential(1)}, ${nan} blank pixel -> NaN`);
  const cf = await openFits(load('syn_small_cube.fits'));
  const ps = [0, 1, 2].map((p) => sum(readImage(cf, -1, { plane: p }).data));
  check('planes of a cube', ps.every((v, i) => rel(v, ref.small.cube.plane_sums[i]) < 1e-12) && readImage(cf).planes === 3);
}

// --- the 16-bit unsigned frame and its header
{
  const f = await openFits(load('syn_i16.fits')), im = readImage(f), r = ref.syn_i16, H = f.hdus[0].header;
  let mn = Infinity, mx = -Infinity; for (const v of im.data) { if (v < mn) mn = v; if (v > mx) mx = v; }
  check('unsigned 16-bit frame (BZERO 32768)', sum(im.data) === r.sum && mn === r.min && mx === r.max && im.data[80 * im.width + 100] === r.p_80_100 && im.width === r.shape[1] && im.height === r.shape[0] && im.data instanceof Float32Array, `sum ${sum(im.data)} = astropy's, exact`);
  check('header: strings with quotes and slashes, HIERARCH, numbers', H.LONGSTR === r.longstr && H['ESO TEL AIRM START'] === r.hierarch && H.BZERO === r.bzero && H.EXPTIME === r.exptime && H.COMMENT.length >= 1, JSON.stringify(H.LONGSTR));
  const t = frameTime(H, f.hdus[0].comments);
  check('DATE-OBS at exposure start -> mid-exposure JD', Math.abs(t.jd - r.jd_mid) < 2e-9 && t.scale === 'UTC' && t.keyword === 'DATE-OBS' && t.exptime === 45, `|dJD| = ${(Math.abs(t.jd - r.jd_mid) * 86400e3).toFixed(3)} ms; tolerance 0.2 ms (float64 JD resolution is 0.04 ms)`);
  const te = frameTime({ ...H }, { 'DATE-OBS': 'time of observation' }, 'exotic');
  check('EXOTIC\'s rule: no shift unless the comment says start', Math.abs(te.jd - r.jd_start) < 2e-9 && Math.abs(frameTime(H, f.hdus[0].comments, 'exotic').jd - r.jd_mid) < 2e-9);
  const a = frameAirmass(H), p = framePointing(H);
  check('AIRMASS keyword, pointing and site', a.airmass === r.airmass && a.source === 'AIRMASS' && Math.abs(p.ra - 97.636625) < 1e-6 && Math.abs(p.dec - 29.672306) < 1e-5 && p.lat === 32.4165 && p.lon === -110.7345, `RA ${p.ra.toFixed(5)} Dec ${p.dec.toFixed(5)}`);
}

// --- gzip + image extension
{
  const f = await openFits(load('syn_f32.fits.gz')), i = firstImageHdu(f), im = readImage(f), r = ref.syn_f32;
  let nan = 0; for (const v of im.data) if (v !== v) nan++;
  check('gzip, primary without data, IMAGE extension, NaN pixel', i === 1 && f.hdus[1].name === r.extname && rel(sum(im.data), r.nansum) < 1e-12 && nan === r.nan && im.height === r.shape[0], `sum differs by ${rel(sum(im.data), r.nansum).toExponential(1)}`);
  const t = frameTime(f.hdus[1].header, f.hdus[1].comments), a = frameAirmass(f.hdus[1].header);
  check('JD keyword marked mid exposure, airmass from TELALT', t.jd === r.jd && t.shifted === 0 && t.exptime === 30 && Math.abs(a.airmass - r.airmass_from_alt) < 1e-12 && a.source === 'TELALT');
}

// --- round trip of the writer
{
  const w = 7, h = 5, d = Float32Array.from({ length: w * h }, (_, i) => Math.sin(i) * 1000);
  const f = parseFits(encodeFitsImage(d, w, h, { 'DATE-OBS': ['2020-01-02T03:04:05', 'start'], EXPTIME: 10, AIRMASS: 1.5, OBJECT: "it's" }).buffer), im = readImage(f);
  check('encodeFitsImage -> parseFits round trip', im.data.every((v, i) => v === d[i]) && f.hdus[0].header.OBJECT === "it's" && f.hdus[0].header.AIRMASS === 1.5 && f.hdus[0].comments['DATE-OBS'] === 'start');
  const d16 = Float32Array.from({ length: w * h }, (_, i) => i * 1800);
  check('16-bit writer round trip', readImage(parseFits(encodeFitsImage(d16, w, h, {}, 16).buffer)).data.every((v, i) => v === d16[i]));
  let threw = false; try { parseFits(new Uint8Array(5000).buffer); } catch { threw = true; }
  check('a file that is not FITS is refused', threw);
}

// --- dates, leap seconds, barycentric time, airmass
{
  const T = ref.time;
  let w = 0; for (const d of T.dates) w = Math.max(w, Math.abs(parseFitsDate(d.iso) - d.jd));
  check('calendar date -> JD', w < 2e-9, `largest difference ${(w * 86400e3).toFixed(3)} ms over ${T.dates.length} dates; tolerance 0.2 ms`);
  check('split DATE-OBS + TIME-OBS, old dd/mm/yy form', Math.abs(parseFitsDate('2021-03-14', '05:21:07.250') - T.dates[0].jd) < 2e-9 && Math.abs(parseFitsDate('31/12/99') - (T.dates[1].jd - (23 * 3600 + 59 * 60 + 59) / 86400)) < 2e-9);
  check('leap seconds (TAI - UTC)', T.leap.every((l) => taiMinusUtc(l.jd) === l.tai_utc), T.leap.map((l) => taiMinusUtc(l.jd)).join(' '));
  let wc = 0, wb = 0;
  for (const b of T.bjd) { wc = Math.max(wc, Math.abs(tdbMinusUtc(b.jd_utc) * 86400 - b.tdb_minus_utc_s)); wb = Math.max(wb, Math.abs((utcToBjdTdb(b.jd_utc, b.ra, b.dec) - b.jd_utc) * 86400 - b.bjd_tdb_minus_jd_utc_s)); }
  check('TDB - UTC against astropy', wc < 2e-4, `largest difference ${(wc * 1e3).toFixed(3)} ms; tolerance 0.2 ms (float64 JD resolution near 2.46e6 is 0.04 ms)`);
  check('UTC -> BJD_TDB against astropy (builtin ephemeris, geocentre)', wb < 0.5, `largest difference ${wb.toFixed(3)} s over ${T.bjd.length} target/date pairs from 2000 to 2031; tolerance 0.5 s`);
  let wa = 0; for (const a of T.airmass) wa = Math.max(wa, Math.abs(airmassAt(a.jd, a.ra, a.dec, a.lat, a.lon) / a.secz - 1));
  check('computed airmass sec(z) against astropy AltAz', wa < 5e-3, `largest relative difference ${wa.toExponential(1)} over ${T.airmass.length} cases above 10 deg altitude; tolerance 5e-3 (no nutation, aberration or refraction here)`);
}

// --- real target pixel files
for (const [key, file] of [['tess', 'tess_wasp18_s02_sub_tp.fits'], ['kepler', 'kplr011446443-2009131105131_lpd-targ.fits.gz']]) {
  if (!ref[key] || !existsSync(new URL('./data/' + file, import.meta.url))) { check(`${key} target pixel file present`, false, 'missing: run test/make_photometry_reference.py with the files'); continue; }
  const r = ref[key], f = await openFits(load(file)), tpf = readTargetPixelFile(f);
  check(`${key}: table layout and headers`, tpf.ncad === r.ncad && tpf.ny === r.shape[0] && tpf.nx === r.shape[1] && tpf.bjdRef === r.bjdrefi + r.bjdreff && tpf.object === r.object && tpf.id === r.id && tpf.ra === r.ra_obj && tpf.dec === r.dec_obj && tpf.col0 === r.crv_col && tpf.row0 === r.crv_row,
    `${tpf.mission} ${tpf.object}, ${tpf.ncad} cadences of ${tpf.nx} x ${tpf.ny}, BJD ref ${tpf.bjdRef}`);
  let wt = 0, nanOK = true; for (let i = 0; i < r.ncad; i++) { if (r.time[i] == null) nanOK &&= Number.isNaN(tpf.time[i]); else wt = Math.max(wt, Math.abs(tpf.time[i] - r.time[i])); }
  check(`${key}: TIME column, QUALITY, CADENCENO, exposure`, wt === 0 && nanOK && r.quality.every((q, i) => q === tpf.quality[i]) && tpf.cadenceno[0] === r.cadenceno_first && tpf.cadenceno[r.ncad - 1] === r.cadenceno_last && Math.abs(tpf.exptime - r.frametim * r.num_frm) < 1e-9 && tpf.cadence === r.timedel, `exact; exposure ${tpf.exptime.toFixed(2)} s per ${(tpf.cadence * 1440).toFixed(2)} min cadence`);
  check(`${key}: APERTURE image`, r.aperture.every((v, i) => v === tpf.aperture[i]));
  const tab = readBinTable(f, 1);
  check(`${key}: column descriptors`, tab.columns.find((c) => c.name === 'FLUX').dim.join('x') === `${tpf.nx}x${tpf.ny}` && tab.columns.find((c) => c.name === 'TIME').type === 'D' && tab.columns.find((c) => c.name === 'QUALITY').type === 'J', tab.columns.map((c) => c.name).join(' '));
}
if (ref.tess) {
  const tpf = readTargetPixelFile(await openFits(load('tess_wasp18_s02_sub_tp.fits')));
  const mid = tpf.time[350] + tpf.bjdRef;
  check('TESS times are BJD_TDB near the chosen transit', Math.abs(mid - 2457000 - ref.tess_transit_btjd) < 0.05, `cadence 350 at BJD ${mid.toFixed(5)}`);
}

// =========================================================================================================
// FITS variants: everything astropy.io.fits opens for EXOTIC. References by test/make_fits_variants.py.
const V = JSON.parse(readFileSync(new URL('./data/fits_variants.json', import.meta.url)));
const same = (a, b) => { let bad = 0; if (a.length !== b.length) return -1; for (let k = 0; k < a.length; k++) if (a[k] !== b[k] && !(a[k] !== a[k] && b[k] !== b[k])) bad++; return bad; };
// a minimal FITS writer for the cases astropy does not write: cards = [[key, value, comment]], data = Uint8Array
const fitsCards = (cards) => {
  const fmt = (v) => (typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : typeof v === 'number' ? String(v).padStart(20) : ("'" + String(v).padEnd(8) + "'").padEnd(20));
  const lines = cards.map(([k, v, c]) => (k.padEnd(8) + '= ' + fmt(v) + (c ? ' / ' + c : '')).padEnd(80)).concat(['END'.padEnd(80)]);
  const u = new Uint8Array(Math.ceil(lines.length / 36) * 2880).fill(32); lines.join('').split('').forEach((ch, i) => { u[i] = ch.charCodeAt(0); }); return u;
};
const pad2880 = (u) => { const o = new Uint8Array(Math.ceil(u.length / 2880) * 2880); o.set(u); return o; };
const cat = (...parts) => { const o = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const hdrOf = (cards) => [Object.fromEntries(cards.map(([k, v]) => [k, v])), Object.fromEntries(cards.map(([k, , c]) => [k, c || '']))];

// --- tile-compressed images, one extension per case, against astropy's decoded pixels
{
  const t0 = performance.now();
  const C = await openFits(load('tilecomp_cases.fits.gz')), R = await openFits(load('tilecomp_reference.fits.gz'));
  let npx = 0;
  for (const c of V.tilecomp) {
    const i = C.hdus.findIndex((h) => h.name === c.name), j = R.hdus.findIndex((h) => h.name === c.ref), planes = c.shape.length === 3 ? c.shape[0] : 1;
    let bad = 0, nan = 0, err = '';
    try {
      for (let p = 0; p < planes; p++) { const a = readImage(C, i, { plane: p, float64: true }), b = readImage(R, j, { plane: p, float64: true }); bad += same(a.data, b.data); npx += a.data.length; for (const v of a.data) if (v !== v) nan++; if (a.planes !== planes || a.width !== c.shape[c.shape.length - 1] || a.compression !== c.zcmptype) bad = -1; }
    } catch (e) { bad = -1; err = e.message; }
    const what = `${c.zcmptype}${c.bytepix ? ' BYTEPIX ' + c.bytepix : ''}, ${c.dtype}${c.zquantiz && !c.lossless ? ' ' + c.zquantiz + (c.zdither0 != null ? ' seed ' + c.zdither0 : '') : ''}, tiles ${c.ztile.join('x')}${c.fallback_rows ? ', ' + c.fallback_rows + ' tiles in GZIP_COMPRESSED_DATA' : ''}${c.nan ? ', ' + c.nan + ' NaN' : ''}`;
    check(`tile-compressed ${c.name.toLowerCase()}`, bad === 0 && nan === c.nan, err || `${what}: ${c.shape.join('x')} pixels identical to astropy's (exact${c.lossless ? '' : '; lossy by ' + c.max_abs_error.toPrecision(2) + ' from the original'})`);
  }
  const ms = performance.now() - t0;
  const h = C.hdus.find((x) => x.name === 'RICE_U16'), im = readImage(C, h.index);
  check('compressed HDU looks like an image', h.type === 'compressed' && h.header.BITPIX === 16 && h.header.NAXIS === 2 && h.header.NAXIS1 === 50 && h.header.NAXIS2 === 38 && h.header.BZERO === 32768 && h.header.XTENSION === 'IMAGE' && !('ZTILE1' in h.header) && !('TFORM1' in h.header) && !('ZCMPTYPE' in h.header) && h.tableHeader.ZCMPTYPE === 'RICE_1' && h.shape.join() === '38,50' && im.data instanceof Float32Array,
    `${V.tilecomp.length} cases, ${npx} pixels decoded and compared in ${ms.toFixed(0)} ms`);
  // variable-length array access on the underlying table
  const tab = readBinTable(C, C.hdus.find((x) => x.name === 'PLIO_I16').index), d = tab.descriptor('COMPRESSED_DATA', 0), arr = tab.array('COMPRESSED_DATA', 0);
  check('variable-length array column (1PI) through the heap', d.elem === 'I' && d.bytes === 2 * d.count && arr.length === d.count && arr[2] === -100 && arr[3] === d.count && tab.heap('COMPRESSED_DATA', 0).length === d.bytes, `row 0: ${d.count} 16-bit words (a PLIO list stores its own length in word 4)`);
  // without openFits: Rice needs nothing asynchronous, gzip tiles say what to do, readImageAsync does it
  const raw = await gunzip(load('tilecomp_cases.fits.gz')), P = parseFits(raw);
  const gi = P.hdus.findIndex((x) => x.name === 'GZIP2_I16'), ri = P.hdus.findIndex((x) => x.name === 'RICE_I16'), ref16 = readImage(R, R.hdus.findIndex((x) => x.name === 'REF_I16')).data;
  let msg = ''; try { readImage(P, gi); } catch (e) { msg = e.message; }
  check('synchronous parseFits + readImage: Rice decodes, gzip tiles ask for inflateTiles', same(readImage(P, ri).data, ref16) === 0 && /inflate/.test(msg) && same((await readImageAsync(P, gi)).data, ref16) === 0, msg.slice(0, 60) + '…');
  const hi = (await openFits(load('tilecomp_cases.fits.gz'))).hdus.length;
  check('HCOMPRESS_1 is refused by name', (() => { const f = parseFits(raw.slice(0)), x = f.hdus[ri]; x.compression = 'HCOMPRESS_1'; try { readImage(f, ri); } catch (e) { return /HCOMPRESS_1/.test(e.message); } return false; })() && hi === V.tilecomp.length + 1);
}

// --- the fpack layout (.fz): empty primary, compressed extension
{
  const f = await openFits(load('var_rice_u16.fits.fz')), i = firstImageHdu(f), im = readImage(f), r = V.fz, H = f.hdus[i].header;
  check('.fz layout: first HDU with data is the compressed extension', i === r.ext && f.hdus[0].type === 'empty' && sum(im.data) === r.sum && im.data[7 * im.width + 3] === r.p_7_3 && im.height === r.shape[0] && im.width === r.shape[1] && H.BITPIX === r.bitpix && H.NAXIS1 === r.naxis1 && H.NAXIS2 === r.naxis2 && H.BZERO === r.bzero && ('ZTILE1' in H) === r.has_ztile && ('TFORM1' in H) === r.has_tform, `sum ${sum(im.data)} = astropy's, exact; header keywords as astropy presents them`);
  const t = frameTime(H, f.hdus[i].comments, 'mid');
  check('.fz: time keywords of the compressed header', Math.abs(t.jd - r.jd_start) < 2e-9 && t.keyword === 'DATE-OBS' && frameAirmass(H).airmass === 1.234 && H.OBJECT === r.object);
}

// --- files written by CFITSIO itself (shipped with astropy as test data): only when the virtualenv is there
{
  const base = new URL('../.venv-phot/lib/', import.meta.url);
  let dir = null;
  if (existsSync(base)) for (const py of readdirSync(base)) { const d = new URL(`${py}/site-packages/astropy/io/fits/hdu/compressed/tests/data/`, base); if (existsSync(new URL('m13.fits', d))) dir = d; }
  if (!dir) console.log('skip CFITSIO-written files (astropy test data not found under .venv-phot)');
  else {
    const rd = (n) => { const b = readFileSync(new URL(n, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    const m13 = readImage(await openFits(rd('m13.fits'))).data, res = [];
    for (const n of ['m13_rice.fits', 'm13_gzip.fits', 'm13_plio.fits']) { const f = await openFits(rd(n)); res.push(same(readImage(f).data, m13) + ' (' + f.hdus[1].compression + ')'); }
    let hc = ''; try { readImage(await openFits(rd('m13_hcomp.fits'))); } catch (e) { hc = e.message; }
    check('CFITSIO-written RICE_1, GZIP_1, PLIO_1 files of M13 (300x300 int16) equal the uncompressed original', res.every((s) => s.startsWith('0 ')) && /HCOMPRESS_1/.test(hc), `differing pixels: ${res.join(', ')}; m13_hcomp.fits refused by name`);
  }
}

// --- parts of the convention astropy does not write: synthetic table, expected values by arithmetic
{
  // 6x4 float32 image, one tile per row. Rows 0-1: NOCOMPRESS quantised 32-bit integers through 64-bit (1QB) descriptors,
  // ZSCALE / ZZERO / ZBLANK as keywords. Rows 2-3: nothing in COMPRESSED_DATA, the pixels in UNCOMPRESSED_DATA (1PE).
  const q = [[1, 2, 3, -99, 5, 6], [-7, 8, 9, 10, 11, 12]], un = [[1.5, -2.25, 3, 4, 5, 6.125], [7, 8, 9, 10, 11, 0.1]];
  const heap = new Uint8Array(2 * 24 + 2 * 24), hv = new DataView(heap.buffer), table = new Uint8Array(4 * 24), tv = new DataView(table.buffer);
  q.forEach((r, i) => { r.forEach((v, k) => hv.setInt32(i * 24 + 4 * k, v)); tv.setUint32(i * 24 + 4, 24); tv.setUint32(i * 24 + 12, i * 24); });               // Q: count, offset as 64-bit
  un.forEach((r, i) => { r.forEach((v, k) => hv.setFloat32(48 + i * 24 + 4 * k, v)); tv.setUint32((2 + i) * 24 + 16, 6); tv.setUint32((2 + i) * 24 + 20, 48 + i * 24); });
  const head = fitsCards([['XTENSION', 'BINTABLE'], ['BITPIX', 8], ['NAXIS', 2], ['NAXIS1', 24], ['NAXIS2', 4], ['PCOUNT', heap.length], ['GCOUNT', 1], ['TFIELDS', 2], ['TTYPE1', 'COMPRESSED_DATA'], ['TFORM1', '1QB'], ['TTYPE2', 'UNCOMPRESSED_DATA'], ['TFORM2', '1PE'],
    ['ZIMAGE', true], ['ZCMPTYPE', 'NOCOMPRESS'], ['ZBITPIX', -32], ['ZNAXIS', 2], ['ZNAXIS1', 6], ['ZNAXIS2', 4], ['ZSCALE', 0.5], ['ZZERO', 10], ['ZBLANK', -99], ['ZQUANTIZ', 'NO_DITHER'], ['EXPTIME', 3]]);
  const file = cat(fitsCards([['SIMPLE', true], ['BITPIX', 8], ['NAXIS', 0], ['EXTEND', true]]), head, pad2880(cat(table, heap)));
  const im = readImage(parseFits(file.buffer)), want = [...q.flat().map((v) => (v === -99 ? NaN : v * 0.5 + 10)), ...un.flat().map(Math.fround)];
  check('UNCOMPRESSED_DATA tiles, 64-bit (1QB) descriptors, ZSCALE / ZZERO / ZBLANK as keywords', same(im.data, Float32Array.from(want)) === 0 && im.header.EXPTIME === 3 && !('ZSCALE' in im.header), 'synthetic table; exact against v * ZSCALE + ZZERO (not checked against astropy, which does not read these)');
}

// --- integer flavours, damaged files, cubes
{
  const im = readImage(await openFits(load('var_u32.fits'))), r = V.u32;
  let mn = Infinity, mx = -Infinity; for (const v of im.data) { if (v < mn) mn = v; if (v > mx) mx = v; }
  check('unsigned 32-bit (BITPIX 32, BZERO 2147483648)', sum(im.data) === r.sum && mn === r.min && mx === r.max && im.data[7 * im.width + 3] === r.p_7_3 && im.header.BZERO === r.bzero && im.data instanceof Float64Array, `sum ${sum(im.data)}, min ${mn}, max ${mx} = astropy's, exact`);
  const s8 = readImage(parseFits(cat(fitsCards([['SIMPLE', true], ['BITPIX', 8], ['NAXIS', 2], ['NAXIS1', 4], ['NAXIS2', 1], ['BZERO', -128], ['BLANK', 7]]), pad2880(Uint8Array.from([0, 128, 255, 7]))).buffer));
  check('signed 8-bit (BZERO -128) with BLANK', s8.data[0] === -128 && s8.data[1] === 0 && s8.data[2] === 127 && Number.isNaN(s8.data[3]), 'synthetic; exact by arithmetic');

  const whole = new Uint8Array(load('syn_small_i16.fits')), ok16 = readImage(parseFits(whole.buffer)).data;
  const noEnd = whole.slice(), txt = new TextDecoder('latin1').decode(noEnd.subarray(0, 2880)), e = txt.indexOf('END' + ' '.repeat(77));
  noEnd.fill(32, e, e + 3);
  const f1 = parseFits(noEnd.buffer);
  check('header without an END card', e > 0 && f1.hdus[0].missingEnd === true && same(readImage(f1).data, ok16) === 0, `pixels identical to the intact file; astropy: "${V.astropy_behaviour.missing_end}", with ignore_missing_end: "${V.astropy_behaviour.missing_end_ignore}"`);
  const H0 = parseFits(whole.buffer).hdus[0], cut = whole.slice(0, H0.dataOffset + H0.dataBytes);
  let thrown = ''; try { readImage(parseFits(whole.slice(0, H0.dataOffset + H0.dataBytes - 2).buffer)); } catch (err) { thrown = err.message; }
  check('last block cut short: complete data are read, incomplete data refused', cut.length % 2880 !== 0 && same(readImage(parseFits(cut.buffer)).data, ok16) === 0 && /truncated/.test(thrown), `file of ${cut.length} bytes (not a multiple of 2880); astropy: ${V.astropy_behaviour.short_last_block}`);
  const noEndShort = noEnd.slice(0, H0.dataOffset + H0.dataBytes);
  check('no END card and a short last block together', same(readImage(parseFits(noEndShort.buffer)).data, ok16) === 0);

  const cf = await openFits(load('var_rgb_cube.fits')), r3 = V.rgb_cube, g = readImage(cf, -1, { weights: [0.299, 0.587, 0.114], float64: true });
  let w = 0; for (let k = 0; k < g.data.length; k++) w = Math.max(w, Math.abs(g.data[k] - r3.gray[k]) / r3.gray[k]);
  check('(3, H, W) colour cube: planes and a weighted mix', readImage(cf).planes === 3 && [0, 1, 2].every((p) => sum(readImage(cf, -1, { plane: p }).data) === r3.plane_sums[p]) && g.plane === -1 && w < 1e-14, `plane sums exact; 0.299 R + 0.587 G + 0.114 B differs from numpy by ${w.toExponential(1)} relative (tolerance 1e-14: order of the additions)`);
}

// --- Bayer frames: bilinear demosaic and EXOTIC's output mixes
{
  const B = V.demosaic, cfa = Float32Array.from(B.cfa); let bad = 0;
  for (const p of Object.keys(B.planes)) { const d = demosaicBilinear(cfa, B.width, B.height, p); bad += same(d.r, Float32Array.from(B.planes[p].r)) + same(d.g, Float32Array.from(B.planes[p].g)) + same(d.b, Float32Array.from(B.planes[p].b)); }
  check('bilinear demosaic, patterns RGGB BGGR GRBG GBRG', bad === 0, `${B.width}x${B.height} uint16 frame, R G B planes identical (exact) to ${B.source}`);
  const rgb = demosaicBilinear(cfa, B.width, B.height, 'RGGB'); let wf = 0, nt = 0, over = 0, np = 0;
  for (const m of B.mixes) {
    const a = mixChannels(rgb, m.out), t = mixChannels(rgb, m.out, { truncate: true });
    for (let k = 0; k < a.length; k++) {
      wf = Math.max(wf, Math.abs(a[k] - m.float[k]) / Math.max(1, m.float[k]));
      // at the image edge the 'reflect' rule can double a sample: above 65535 EXOTIC's cast to uint16 wraps around, which is not imitated
      if (m.float[k] >= 65536) { over++; if (t[k] !== Math.trunc(m.float[k])) nt++; } else { np++; if (t[k] !== m.exotic_uint16[k]) nt++; }
    }
  }
  check('output mixes red, green, blue, gray, blueblock, [1,2,3], unknown name', wf < 1.2e-7 && nt === 0, `float mix within ${wf.toExponential(1)} relative of numpy (tolerance 1.2e-7: stored as float32); EXOTIC's cast to uint16 reproduced exactly on ${np} pixels; ${over} edge pixels exceed 65535, where EXOTIC wraps around and this does not`);
  const bp = bayerPattern({ BAYERPAT: 'RGGB', XBAYROFF: 1, YBAYROFF: 0 });
  check('Bayer pattern from the header', bayerPattern({ BAYERPAT: 'GBRG ' }).pattern === 'GBRG' && bayerPattern({ COLORTYP: 'bggr' }).pattern === 'BGGR' && bp.pattern === 'GRBG' && bayerPattern({ COLORTYP: 'MONO' }) === null && bayerPattern({}) === null, 'BAYERPAT, COLORTYP, XBAYROFF (synthetic headers)');
}

// --- time keywords
{
  let w = 0, scales = true; const got = [];
  for (const c of V.exotic_time.cases) { const [H, cm] = hdrOf(c.cards), t = frameTime(H, cm, 'exotic'); w = Math.max(w, Math.abs(t.jd - c.jd)); scales &&= t.scale === c.scale; got.push(t.keyword); }
  check('EXOTIC mode equals EXOTIC\'s img_time_jd / img_time_bjd_tdb rule', w < 2e-9 && scales, `${V.exotic_time.cases.length} headers (${[...new Set(got)].join(', ')}), largest difference ${(w * 86400e3).toFixed(3)} ms; tolerance 0.2 ms (float64 JD resolution 0.04 ms). Reference: exotic.py lines 190-298 re-implemented with ${V.exotic_time.parser}`);

  const I = V.instant, half = 60 / 172800, near = (a, b) => Math.abs(a - b) < 2e-9;
  const spell = [   // header, comments, at, expected JD, expected keyword
    [{ 'BJD_TDB': I.jd }, {}, 'start', I.jd, 'BJD_TDB'], [{ 'BJD_TBD': I.jd }, {}, 'start', I.jd, 'BJD_TBD'], [{ BJD: I.jd, 'DATE-OBS': '2001-01-01T00:00:00' }, {}, 'start', I.jd, 'BJD'],
    [{ HJD: I.jd }, {}, 'start', I.jd, 'HJD'],
    [{ 'UT-OBS': I.iso }, {}, 'start', I.jd + half, 'UT-OBS'], [{ JULIAN: I.jd }, {}, 'start', I.jd + half, 'JULIAN'], [{ JD: I.jd }, {}, 'start', I.jd + half, 'JD'], [{ JD_UTC: I.jd }, {}, 'mid', I.jd, 'JD_UTC'], [{ 'JD-OBS': I.jd }, {}, 'end', I.jd - half, 'JD-OBS'],
    [{ 'MJD-OBS': I.mjd }, {}, 'start', I.jd + half, 'MJD-OBS'], [{ MJD: I.mjd }, {}, 'start', I.jd + half, 'MJD'], [{ MJD_OBS: I.mjd }, {}, 'start', I.jd + half, 'MJD_OBS'],
    [{ 'DATE-OBS': I.iso }, {}, 'start', I.jd + half, 'DATE-OBS'], [{ 'DATE-OBS': I.iso.replace('T', ' ') }, {}, 'mid', I.jd, 'DATE-OBS'],
    [{ 'DATE-OBS': I.date, 'TIME-OBS': I.time }, {}, 'mid', I.jd, 'DATE-OBS'], [{ 'DATE-OBS': I.date, UT: I.time }, {}, 'mid', I.jd, 'DATE-OBS'], [{ 'DATE-OBS': I.date, UTC: I.time }, {}, 'mid', I.jd, 'DATE-OBS'],
    [{ 'DATE-OBS': I.date, UTSTART: I.time }, {}, 'start', I.jd + half, 'DATE-OBS'], [{ 'DATE-OBS': I.date, TIME: I.time }, {}, 'mid', I.jd, 'DATE-OBS'], [{ 'DATE-OBS': I.date, 'UT-OBS': I.time }, {}, 'mid', I.jd, 'DATE-OBS'],
    [{ 'DATE-BEG': I.iso }, {}, 'start', I.jd + half, 'DATE-BEG'], [{ 'DATE-END': I.iso }, {}, 'start', I.jd - half, 'DATE-END'], [{ 'DATE-AVG': I.iso, 'DATE-OBS': '2001-01-01T00:00:00' }, {}, 'start', I.jd, 'DATE-AVG'],
    [{ 'MJD-BEG': I.mjd }, {}, 'start', I.jd + half, 'MJD-BEG'], [{ 'MJD-END': I.mjd }, {}, 'start', I.jd - half, 'MJD-END'], [{ 'MJD-AVG': I.mjd, 'MJD-OBS': 51544 }, {}, 'start', I.jd, 'MJD-AVG'],
    [{ 'DATE-OBS': I.iso }, { 'DATE-OBS': 'UTC at mid exposure' }, 'start', I.jd, 'DATE-OBS'], [{ 'DATE-OBS': I.iso }, { 'DATE-OBS': 'end of exposure' }, 'start', I.jd - half, 'DATE-OBS'], [{ 'DATE-OBS': I.iso }, { 'DATE-OBS': 'shutter open' }, 'end', I.jd + half, 'DATE-OBS'],
    [{ 'DATE-OBS': I.iso, TIMESYS: 'TAI' }, {}, 'mid', I.jd_if_tai, 'DATE-OBS'], [{ 'DATE-OBS': I.iso, TIMESYS: 'TT' }, {}, 'mid', I.jd_if_tt, 'DATE-OBS'], [{ 'MJD-OBS': I.mjd, TIMESYS: 'TDB' }, {}, 'mid', I.jd_if_tdb, 'MJD-OBS'], [{ 'DATE-OBS': I.iso, TIMESYS: 'UTC' }, {}, 'mid', I.jd, 'DATE-OBS'],
  ];
  const failed = spell.filter(([H, cm, at, jd, key]) => { const t = frameTime({ EXPTIME: 60, ...H }, cm, at); return !(near(t.jd, jd) && t.keyword === key); }).map(([H]) => Object.keys(H).join('+'));
  check('every spelling of the time keywords gives the same instant', failed.length === 0, failed.length ? 'wrong: ' + failed.join(', ') : `${spell.length} headers (BJD_TDB BJD_TBD BJD HJD UT-OBS JULIAN JD JD_UTC JD-OBS MJD-OBS MJD MJD_OBS DATE-OBS +TIME-OBS/UT/UTC/UTSTART/TIME DATE-BEG/END/AVG MJD-BEG/END/AVG, start/mid/end by option and by comment, TIMESYS TAI/TT/TDB against astropy) within 0.2 ms`);
  const tt = frameTime({ 'DATE-OBS': I.iso, TIMESYS: 'TT' }, {}, 'mid'), dOnly = frameTime({ 'DATE-OBS': I.date }, {}, 'mid'), none = frameTime({ OBJECT: 'x' });
  check('time scale and gaps are reported', tt.scale === 'UTC' && tt.timesys === 'TT' && Math.abs(tt.clock * 86400 - 69.184) < 1e-6 && frameTime({ HJD: I.jd }).scale === 'HJD' && frameTime({ BJD: I.jd }).scale === 'BJD_TDB' && dOnly.dateOnly === true && Number.isNaN(none.jd) && none.scale === 'none', `TIMESYS TT: ${(tt.clock * 86400).toFixed(3)} s taken off to reach UTC`);
  const ex = (H, c = {}) => exposureTime(H, c);
  check('exposure keywords', ex({ EXPTIME: 12 }) === 12 && ex({ EXPOSURE: 13 }) === 13 && ex({ EXP: 14 }) === 14 && ex({ EXP_TIME: 15 }) === 15 && ex({ ITIME: 16 }) === 16 && ex({ TELAPSE: 17 }) === 17 && ex({ EXPTIME: 2500 }, { EXPTIME: '[ms] exposure time' }) === 2.5 && ex({ EXPTIME: 2500 }, { EXPTIME: 'exposure in milliseconds' }) === 2.5 && ex({ EXPTIME: 2500 }, { EXPTIME: 'exposure time in s (ms resolution)' }) === 2500 && ex({ EXPOINUS: 2500000 }) === 2.5 && ex({ EXPTIME: '30.0' }) === 30 && Number.isNaN(ex({})), 'EXPTIME EXPOSURE EXP EXP_TIME ITIME TELAPSE, milliseconds only when the comment says so alone, EXPOINUS (synthetic headers)');
}

// --- airmass, pixel scale, WCS, pier side
{
  const sec = (alt) => 1 / Math.cos((90 - alt) * Math.PI / 180), am = (H) => frameAirmass(H);
  check('airmass keywords', am({ AIRMASS: 1.5 }).airmass === 1.5 && am({ SECZ: 1.6 }).source === 'SECZ' && Math.abs(am({ AMSTART: 1.2, AMEND: 1.4 }).airmass - 1.3) < 1e-15 && am({ AMSTART: 1.2, AMEND: 1.4 }).source === 'AMSTART+AMEND' && am({ AMSTART: 1.2 }).airmass === 1.2
    && ['TELALT', 'ALTITUDE', 'OBJCTALT', 'CENTALT'].every((k) => Math.abs(am({ [k]: 50 }).airmass - sec(50)) < 1e-15 && am({ [k]: 50 }).source === k) && Math.abs(am({ ZD: 40 }).airmass - sec(50)) < 1e-14 && am({ OBJCTALT: '50 30 00' }).source === 'OBJCTALT' && Number.isNaN(am({}).airmass), 'AIRMASS SECZ AMSTART+AMEND TELALT ALTITUDE OBJCTALT CENTALT ZD (synthetic; sec z by arithmetic)');
  let ws = 0, wp = 0, wsc = 0, n = 0;
  for (const c of V.wcs) {
    const w = readWcs(c.cards), ps = pixelScale(c.cards);
    wsc = Math.max(wsc, Math.abs(ps.scale / c.exotic_scale - 1), Math.abs(ps.x / c.scales_arcsec[0] - 1), Math.abs(ps.y / c.scales_arcsec[1] - 1), Math.abs(w.scale / c.exotic_scale - 1));
    c.pix.forEach((p, k) => {
      const s = w.pixToSky(p[0], p[1]), q = w.skyToPix(c.sky[k][0], c.sky[k][1]), cd = Math.cos(c.sky[k][1] * Math.PI / 180);
      let dra = Math.abs(s[0] - c.sky[k][0]); if (dra > 180) dra = 360 - dra;
      ws = Math.max(ws, Math.hypot(dra * cd, s[1] - c.sky[k][1]) * 3600); wp = Math.max(wp, Math.hypot(q[0] - p[0], q[1] - p[1])); n++;
    });
  }
  check('TAN WCS against astropy.wcs (CD, PC + CDELT, CDELT + CROTA2, near the pole, RA near 0)', ws < 1e-6 && wp < 1e-6, `${n} points in ${V.wcs.length} headers: pixel -> sky within ${ws.toExponential(1)} arcsec, sky -> pixel within ${wp.toExponential(1)} px; tolerance 1e-6 of each`);
  check('pixel scale from the WCS equals astropy proj_plane_pixel_scales', wsc < 1e-12, `largest relative difference ${wsc.toExponential(1)}; tolerance 1e-12`);
  const sip = readWcs({ ...V.wcs[0].cards, CTYPE1: 'RA---TAN-SIP', CTYPE2: 'DEC--TAN-SIP', A_ORDER: 2 }), sin = readWcs({ ...V.wcs[0].cards, CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN' });
  const px = (H, o) => pixelScale(H, o);
  check('pixel scale keywords, SIP and non-TAN flagged', px({ IM_SCALE: 1.5, PIXSCALE: 9 }).source === 'IM_SCALE' && px({ PIXSCALE: 0.7 }).scale === 0.7 && px({ SCALE: 0.8 }).scale === 0.8 && px({ SECPIX1: -0.5, SECPIX2: 0.7 }).scale === 0.6 && Math.abs(px({ CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CDELT1: -0.0002, CDELT2: 0.0002 }).scale - 0.72) < 1e-12
    && Math.abs(px({ XPIXSZ: 9, FOCALLEN: 2000, XBINNING: 2 }).scale - 206.264806 * 9 / 2000) < 1e-12 && Math.abs(px({ XPIXSZ: 4.5, FOCALLEN: 2000, XBINNING: 2 }, { unbinnedPixelSize: true }).scale - 206.264806 * 9 / 2000) < 1e-12 && Number.isNaN(px({ CDELT1: 1, CDELT2: 1 }).scale) && px({}).source === null
    && sip.sip === true && sip.distortion === 'SIP' && sin.approximate === true && readWcs(V.wcs[0].cards).approximate === false && readWcs({}) === null, 'IM_SCALE PIXSCALE SCALE SECPIX1/2 CDELT XPIXSZ+FOCALLEN (synthetic headers, by arithmetic)');
  check('pier side', pierSide({ PIERSIDE: 'WEST' }).side === 'west' && pierSide({ PIERSIDE: 'East' }).side === 'east' && pierSide({ 'PIER SIDE': 'pierWest' }).side === 'west' && pierSide({ PIER_SID: 'E' }).side === 'east' && pierSide({ PIERSIDE: 1 }).side === 'west' && pierSide({ PIERSIDE: 'unknown' }).side === null && pierSide({}).side === null, 'PIERSIDE, PIER SIDE, text and ASCOM numbers (synthetic headers)');
}

// --- the pipeline's file entry points on these variants
{
  const { FITS_NAME, loadFrame, readHeaderOnly } = await import('../src/photometry/pipeline.js');
  const yes = ['a.fits', 'a.FITS', 'a.fit', 'a.fts', 'a.fz', 'a.fits.gz', 'a.fit.gz', 'a.fits.fz', 'a.fit.fz', 'A.FTS.GZ'], no = ['a.txt', 'a.fitsx', 'a.gz', 'fz'];
  check('file names EXOTIC accepts', yes.every((n) => FITS_NAME.test(n)) && !no.some((n) => FITS_NAME.test(n)) && 'x.fits.fz'.replace(FITS_NAME, '') === 'x', yes.join(' '));
  const fz = load('var_rice_u16.fits.fz'), r = V.fz, buf = new Float32Array(50 * 38);
  const fr = await loadFrame({ buffer: fz, name: 'x.fits.fz' }, buf);
  check('loadFrame on a .fz file, into a reused buffer, primary keywords inherited', fr.data === buf && sum(fr.data) === r.sum && fr.width === 50 && fr.compression === 'RICE_1' && fr.header.OBSERVER === 'primary only' && fr.header.OBJECT === r.object && fr.header.NAXIS1 === 50);
  const blob = new Blob([fz]); blob.name = 'x.fz';
  const h1 = await readHeaderOnly({ buffer: fz }), h2 = await readHeaderOnly(blob), h3 = await readHeaderOnly(new Blob([load('syn_f32.fits.gz')])), h4 = await readHeaderOnly(new Blob([load('tess_wasp18_s02_sub_tp.fits')])), h5 = await readHeaderOnly(new Blob([load('syn_i16.fits')]));
  check('readHeaderOnly: .fz gives an image header merged with the primary; other layouts as before', [h1, h2].every((h) => h.primaryEmpty && h.compressed && h.header.NAXIS === 2 && h.header.NAXIS1 === 50 && h.header.BITPIX === 16 && h.header.OBJECT === r.object && h.header.OBSERVER === 'primary only' && h.ext.XTENSION === 'IMAGE' && !('TFORM1' in h.header) && Math.abs(frameTime(h.header, h.comments, 'mid').jd - r.jd_start) < 2e-9)
    && h3.primaryEmpty && h3.header.NAXIS === 2 && h3.header.NAXIS1 === 200 && exposureTime(h3.header) === 30 && h4.primaryEmpty && String(h4.ext.XTENSION).trim() === 'BINTABLE' && !h5.primaryEmpty && h5.header.EXPTIME === 45, 'buffer and Blob sources; gzip with an IMAGE extension; target pixel file still seen as a table');
  const cube = await loadFrame({ buffer: load('var_rgb_cube.fits') }, null, { plane: 2 }), mix = await loadFrame({ buffer: load('var_rgb_cube.fits') }, { weights: [0.299, 0.587, 0.114] });
  let wm = 0; for (let k = 0; k < mix.data.length; k++) wm = Math.max(wm, Math.abs(mix.data[k] / V.rgb_cube.gray[k] - 1));
  const B = V.demosaic, enc = encodeFitsImage(Float32Array.from(B.cfa), B.width, B.height, { BAYERPAT: 'RGGB' }, 16), gm = B.mixes.find((m) => m.out === 'gray');
  const bay = await loadFrame({ buffer: enc.buffer }, null, { bayer: { pattern: 'RGGB', weights: 'gray', truncate: true } });
  check('loadFrame: plane of a cube, weighted mix, Bayer demosaic', sum(cube.data) === V.rgb_cube.plane_sums[2] && cube.planes === 3 && cube.plane === 2 && wm < 1.2e-7 && same(bay.data, Float32Array.from(gm.exotic_uint16)) === 0, `Bayer RGGB -> gray equals EXOTIC's uint16 output exactly; cube mix within ${wm.toExponential(1)} (float32)`);
}
process.exit(ok ? 0 : 1);
