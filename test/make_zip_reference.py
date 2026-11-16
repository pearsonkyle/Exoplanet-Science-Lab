"""Zip archives for test/zip.test.mjs, written by Python's zipfile (an independent writer of the format).

  .venv/bin/python test/make_zip_reference.py

Writes test/data/zip_cases.zip (small FITS frames from test/data in folders lights/, darks/, flats/, bias/ and
calibration/darks/, stored and deflated entries, a .fits.gz both stored and deflated, a entry with ZIP64 local sizes, and test/data/zip64_cases.zip with real ZIP64 records, a zip
inside the zip (stored) and another (deflated), an empty folder entry, macOS junk, a text file), and
test/zip_reference.json with every entry's size, CRC-32 and MD5 as zipfile reads them back. Also lists EXOTIC's
sample-data zip (read only; not copied) when it is present at ../EXOTIC_sampledata-1.0.0.zip.
"""
import gzip, hashlib, io, json, os, zipfile, zlib

D = os.path.join(os.path.dirname(__file__), 'data')
OUT = os.path.join(D, 'zip_cases.zip')
EXOTIC_ZIP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'EXOTIC_sampledata-1.0.0.zip'))

def raw(name):
    with open(os.path.join(D, name), 'rb') as f:
        return f.read()

f32, i16, f64, i32, u8 = raw('syn_small_f32.fits'), raw('syn_small_i16.fits'), raw('syn_small_f64.fits'), raw('syn_small_i32.fits'), raw('syn_small_u8.fits')
gz = gzip.compress(f64, mtime=0)

def inner_zip(method):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w', compression=method) as z:
        z.writestr('inner/a.fits', f32)
        z.writestr('inner/b.fits', i16)
    return b.getvalue()

entries = [
    ('night1/', None, zipfile.ZIP_STORED),
    ('night1/lights/frame_0001.fits', f32, zipfile.ZIP_DEFLATED),
    ('night1/lights/frame_0002.fits', i16, zipfile.ZIP_STORED),
    ('night1/lights/frame_0003.fits.gz', gz, zipfile.ZIP_STORED),
    ('night1/lights/frame_0004.fits.gz', gz, zipfile.ZIP_DEFLATED),
    ('night1/darks/dark_001.fits', i32, zipfile.ZIP_DEFLATED),
    ('night1/flats/flat_001.fits', u8, zipfile.ZIP_DEFLATED),
    ('night1/bias/bias_001.fits', i16, zipfile.ZIP_DEFLATED),
    ('night1/calibration/darks/master.fits', f32, zipfile.ZIP_DEFLATED),
    ('night1/empty/', None, zipfile.ZIP_STORED),
    ('night1/notes.txt', 'Frames for the zip test. Ünïcode name check.\n'.encode(), zipfile.ZIP_DEFLATED),
    ('night1/ünïcode_name.fits', f64, zipfile.ZIP_DEFLATED),
    ('__MACOSX/night1/._frame_0001.fits', b'\0\5\26\7junk', zipfile.ZIP_DEFLATED),
    ('nested_stored.zip', inner_zip(zipfile.ZIP_DEFLATED), zipfile.ZIP_STORED),
    ('nested_deflated.zip', inner_zip(zipfile.ZIP_DEFLATED), zipfile.ZIP_DEFLATED),
]
with zipfile.ZipFile(OUT, 'w') as z:
    for name, data, method in entries:
        if data is None:
            z.writestr(zipfile.ZipInfo(name), b'')
            continue
        info = zipfile.ZipInfo(name, date_time=(2026, 11, 16, 12, 0, 0))
        info.compress_type = method
        z.writestr(info, data)
    # an entry streamed with force_zip64: ZIP64 sizes in its local header (not in the directory)
    info = zipfile.ZipInfo('night1/lights/frame_0005_zip64.fits', date_time=(2026, 11, 16, 12, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    with z.open(info, 'w', force_zip64=True) as w:
        w.write(f32)

ref = {'file': 'zip_cases.zip', 'entries': []}
with zipfile.ZipFile(OUT) as z:
    for i in z.infolist():
        b = z.read(i) if not i.is_dir() else b''
        ref['entries'].append({'path': i.filename, 'dir': i.is_dir(), 'method': i.compress_type, 'size': i.file_size, 'csize': i.compress_size,
                               'crc': i.CRC, 'md5': hashlib.md5(b).hexdigest()})
    for name in ('nested_stored.zip', 'nested_deflated.zip'):
        with zipfile.ZipFile(io.BytesIO(z.read(name))) as zz:
            for i in zz.infolist():
                ref['entries'].append({'path': name + '/' + i.filename, 'dir': i.is_dir(), 'method': i.compress_type, 'size': i.file_size, 'crc': i.CRC,
                                       'md5': hashlib.md5(zz.read(i)).hexdigest(), 'nested': True})
ref['md5_of'] = {k: hashlib.md5(v).hexdigest() for k, v in [('f32', f32), ('i16', i16), ('f64', f64), ('i32', i32), ('u8', u8)]}

# ZIP64: zipfile writes the ZIP64 extra fields and end records only past 4 GB / 65,535 entries; lowering its limits
# makes it write them for a small archive (the records are then real ZIP64, as a reader sees them)
OUT64 = os.path.join(D, 'zip64_cases.zip')
_lim, _cnt = zipfile.ZIP64_LIMIT, zipfile.ZIP_FILECOUNT_LIMIT
zipfile.ZIP64_LIMIT, zipfile.ZIP_FILECOUNT_LIMIT = 1000, 2
try:
    with zipfile.ZipFile(OUT64, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        z.writestr('big/a.fits', f32)
        z.writestr('big/b.fits', i16)
        z.writestr('big/c.fits', f64, compress_type=zipfile.ZIP_STORED)
finally:
    zipfile.ZIP64_LIMIT, zipfile.ZIP_FILECOUNT_LIMIT = _lim, _cnt
with zipfile.ZipFile(OUT64) as z:
    ref['zip64'] = {'file': 'zip64_cases.zip', 'entries': [{'path': i.filename, 'size': i.file_size, 'crc': i.CRC, 'md5': hashlib.md5(z.read(i)).hexdigest()} for i in z.infolist()]}
with open(OUT64, 'rb') as f:
    b = f.read()
ref['zip64']['has_eocd64'] = b.find(b'PK\x06\x06') >= 0

if os.path.exists(EXOTIC_ZIP):
    with zipfile.ZipFile(EXOTIC_ZIP) as z:
        il = z.infolist()
        files = [i for i in il if not i.is_dir()]
        pick = [files[0], files[len(files) // 2], files[-2], files[-1]]
        ref['exotic'] = {'path': EXOTIC_ZIP, 'size': os.path.getsize(EXOTIC_ZIP), 'entries': len(il), 'files': len(files),
                         'fits': sum(1 for i in files if i.filename.lower().endswith(('.fits', '.fit', '.fts'))),
                         'methods': sorted({i.compress_type for i in il}), 'total_unpacked': sum(i.file_size for i in files),
                         'sample': [{'path': i.filename, 'size': i.file_size, 'crc': i.CRC, 'md5': hashlib.md5(z.read(i)).hexdigest()} for i in pick],
                         'names': [i.filename for i in files]}

with open(os.path.join(os.path.dirname(__file__), 'zip_reference.json'), 'w') as f:
    json.dump(ref, f, indent=1, ensure_ascii=False)
print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes, {len(ref['entries'])} entries incl. nested)" + (f"; EXOTIC zip: {ref['exotic']['files']} files" if 'exotic' in ref else ''))
