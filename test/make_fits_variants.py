# Reference files and values for the FITS variants in test/fits.test.mjs: everything astropy.io.fits opens for
# EXOTIC (tile-compressed images in every algorithm astropy writes, quantised floats with each dither method,
# cubes, unsigned 32-bit), EXOTIC's time rule, WCS, pixel scale and Bayer demosaicing.
#
#   .venv-phot/bin/python test/make_fits_variants.py
#
# Writes into test/data/:
#   tilecomp_cases.fits.gz      one tile-compressed image per extension (EXTNAME = case name), all made by
#                               astropy's CompImageHDU
#   tilecomp_reference.fits.gz  what astropy decodes from each of them, as plain IMAGE extensions
#   var_rice_u16.fits.fz        the fpack layout: empty primary + one compressed extension, unsigned 16-bit
#   var_u32.fits                unsigned 32-bit (BZERO 2147483648)
#   var_rgb_cube.fits           a (3, H, W) colour cube
#   fits_variants.json          the list of cases and the reference numbers (times, WCS, demosaic)
#
# Two references need packages that are not in .venv-phot: dateutil (EXOTIC parses DATE-OBS with it) and
# colour_demosaicing (EXOTIC's demosaic). When this interpreter lacks them the script runs that part with the
# interpreter in $EXOTIC_PYTHON (default: the 'exotic' conda environment, python -B, nothing is written there)
# and says in the JSON which was used; without it, it falls back to datetime.fromisoformat and to an
# independent scipy.ndimage.convolve implementation (which is always computed and compared as well).
import sys, os, json, gzip, io, subprocess, warnings, datetime
import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(here, 'data')

# ---------------------------------------------------------------------------------------------- EXOTIC's rules
# exotic/exotic.py lines 190-196 (exp_offset), 199-215 (ut_date), 218-229 (julian_date), 231-234 (get_exp_time),
# 236-262 (img_time_jd), 265-298 (img_time_bjd_tdb, the part before the BJD conversion), copied verbatim except
# that `dup.parse` is the parser passed in. EXOTIC itself is not imported (its import has side effects).
def exotic_times(headers, parse, Time, fits):
    def exp_offset(hdr, time_unit, exp):
        if 'start' in hdr.comments[time_unit]:
            return exp / (2.0 * 60.0 * 60.0 * 24.0)
        return 0.0

    def ut_date(hdr, time_unit, exp):
        if time_unit == 'DATE-OBS':
            greg_date = hdr[time_unit] if 'T' in hdr[time_unit] else f"{hdr[time_unit]}T{hdr['TIME-OBS']}"
        else:
            greg_date = hdr[time_unit]
        dt = parse(greg_date)
        atime = Time(dt)
        julian_time = atime.jd
        offset = exp_offset(hdr, time_unit, exp)
        return julian_time + offset

    def julian_date(hdr, time_unit, exp):
        time_offset = 2400000.5 if time_unit == 'MJD-OBS' else 0.0
        julian_time = float(hdr[time_unit]) + time_offset
        offset = exp_offset(hdr, time_unit, exp)
        return julian_time + offset

    def get_exp_time(hdr):
        exp_list = ["EXPTIME", "EXPOSURE", "EXP"]
        exp_time = next((exptime for exptime in exp_list if exptime in hdr), None)
        return hdr[exp_time] if exp_time is not None else 0.0

    def img_time_jd(hdr):
        time_list = ['UT-OBS', 'JULIAN', 'MJD-OBS', 'DATE-OBS']
        exp = get_exp_time(hdr)
        hdr_time = next((time_unit for time_unit in time_list if time_unit in hdr), None)
        if hdr_time == 'MJD_OBS':
            hdr_time = hdr_time if "epoch" not in hdr.comments[hdr_time] else 'DATE-OBS'
        if hdr_time in ['UT-OBS', 'DATE-OBS']:
            return ut_date(hdr, hdr_time, exp)
        return julian_date(hdr, hdr_time, exp)

    def img_time_before_bjd(hdr):   # img_time_bjd_tdb up to (not including) convert_jd_to_bjd
        time_list = ['BJD_TDB', 'BJD_TBD', 'BJD']
        exp = get_exp_time(hdr)
        hdr_time = next((time for time in time_list if time in hdr), None)
        if hdr_time is None:
            return img_time_jd(hdr), 'UTC'
        return julian_date(hdr, hdr_time, exp), 'BJD_TDB'

    out = []
    for cards in headers:
        hdr = fits.Header()
        for k, v, c in cards:
            hdr[k] = (v, c)
        jd, scale = img_time_before_bjd(hdr)
        out.append({'jd': jd, 'scale': scale})
    return out


def exotic_part(payload):
    """The two references that need dateutil / colour_demosaicing. Returns what could be computed."""
    res = {}
    try:
        import dateutil.parser as dup
        from astropy.time import Time
        from astropy.io import fits
        import dateutil, astropy
        res['times'] = exotic_times(payload['headers'], dup.parse, Time, fits)
        res['time_parser'] = f'dateutil {dateutil.__version__} + astropy {astropy.__version__} Time'
    except ImportError:
        pass
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            import colour_demosaicing
            from colour_demosaicing import demosaicing_CFA_Bayer_bilinear
        cfa = np.array(payload['cfa'], dtype=np.uint16)
        res['demosaic'] = {p: demosaicing_CFA_Bayer_bilinear(cfa, p).tolist() for p in payload['patterns']}
        res['demosaic_source'] = f'colour_demosaicing {colour_demosaicing.__version__} demosaicing_CFA_Bayer_bilinear'
    except ImportError:
        pass
    return res


if len(sys.argv) > 1 and sys.argv[1] == '--exotic-part':
    json.dump(exotic_part(json.load(open(sys.argv[2]))), open(sys.argv[3], 'w'))
    sys.exit(0)

# -------------------------------------------------------------------------------------------------- main run
from scipy.special import erf
from scipy.ndimage import convolve
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
import astropy, scipy

warnings.simplefilter('ignore')
os.makedirs(D, exist_ok=True)
rng = np.random.default_rng(20261116)
ref = {'versions': {'astropy': astropy.__version__, 'numpy': np.__version__, 'scipy': scipy.__version__}}

W, H = 50, 38
def scene(w=W, h=H, sky=300.0, stars=((12.3, 9.6, 30000, 1.8), (36.8, 25.2, 90000, 2.2), (25.1, 30.7, 6000, 1.6), (44.2, 6.3, 15000, 1.8))):
    img = np.full((h, w), sky); x = np.arange(w); y = np.arange(h)
    for sx, sy, f, s in stars:
        k = 1 / (np.sqrt(2) * s)
        img += f * np.outer(0.5 * (erf((y + 0.5 - sy) * k) - erf((y - 0.5 - sy) * k)), 0.5 * (erf((x + 0.5 - sx) * k) - erf((x - 0.5 - sx) * k)))
    return img
clean = scene()
noisy = rng.poisson(clean) + rng.normal(0, 6, clean.shape)

i16 = np.round(noisy - 500).astype(np.int16)                     # bias-subtracted: negative values too
i16[7, :] = rng.integers(-32768, 32767, W)                       # a row of white noise: Rice's high-entropy blocks
i16[9, :] = 1234                                                 # a constant row: Rice's zero-difference blocks
u16 = np.clip(np.round(noisy), 0, 65535).astype(np.uint16); u16[7, :] = rng.integers(0, 65535, W); u16[0, 0] = 0; u16[0, 1] = 65535
i32 = np.round(noisy * 3000).astype(np.int32); i32[7, :] = rng.integers(-2**31, 2**31 - 1, W); i32[9, :] = -77
u32 = np.round(noisy * 3000).astype(np.uint32); u32[7, :] = rng.integers(0, 2**32 - 1, W); u32[0, 0] = 0; u32[0, 1] = 2**32 - 1
u8 = np.clip(np.round(noisy / 40), 0, 255).astype(np.uint8); u8[7, :] = rng.integers(0, 255, W); u8[9, :] = 200
mask = (clean > 400).astype(np.int16) * 3 + (clean > 2000).astype(np.int16) * 500; mask[20, :] = np.arange(W) * 37 % 4000   # PLIO: small non-negative integers
cube = np.stack([np.round(noisy - 500), np.round(0.5 * noisy), np.round(noisy[::-1] - 100)]).astype(np.int16)
f32 = noisy.astype(np.float32)
f32[5, :] = 7.0                      # a constant row
f32[3, :] = (1e30 * rng.normal(1, 1, W)).astype(np.float32)   # a row that cannot be quantised to 32-bit integers
f32[10, 4] = np.nan; f32[30, 40:44] = np.nan
f32[20:25, 10:20] = 0.0              # exact zeros (kept exact by SUBTRACTIVE_DITHER_2)
f64 = noisy / 7.0 + 1e6
f64[12, 7] = np.nan
big = (scene(101, 100) + rng.normal(0, 6, (100, 101))).astype(np.float32)   # one tile of 10100 pixels: the dither sequence wraps

cases = [  # name, data, CompImageHDU options, reference to share (lossless integer cases decode to their input)
    ('rice_i16', i16, {}, 'i16'), ('rice_u16', u16, {}, 'u16'), ('rice_i32', i32, {}, 'i32'), ('rice_u32', u32, {}, 'u32'), ('rice_u8', u8, {}, 'u8'),
    ('rice_i16_tiles', i16, dict(tile_shape=(12, 16)), 'i16'), ('rice_i16_onetile', i16, dict(tile_shape=(H, W)), 'i16'), ('rice_i16_cols', i16, dict(tile_shape=(H, 1)), 'i16'),
    ('rice_cube', cube, {}, 'cube'), ('rice_cube_tiles3d', cube, dict(tile_shape=(2, 10, 20)), 'cube'),
    ('gzip1_i16', i16, dict(compression_type='GZIP_1'), 'i16'), ('gzip2_i16', i16, dict(compression_type='GZIP_2'), 'i16'), ('gzip2_i32', i32, dict(compression_type='GZIP_2', tile_shape=(10, 20)), 'i32'),
    ('gzip1_u8', u8, dict(compression_type='GZIP_1'), 'u8'), ('plio_i16', mask, dict(compression_type='PLIO_1'), 'mask'), ('plio_i16_tiles', mask, dict(compression_type='PLIO_1', tile_shape=(12, 16)), 'mask'),
    ('nocompress_i16', i16, dict(compression_type='NOCOMPRESS'), 'i16'),
    ('f32_nodither', f32, dict(quantize_method=-1), None), ('f32_dither1', f32, dict(quantize_method=1, dither_seed=9990), None), ('f32_dither2', f32, dict(quantize_method=2, dither_seed=77), None),
    ('f32_dither1_tiles', f32, dict(quantize_method=1, dither_seed=3, tile_shape=(12, 16), quantize_level=4), None), ('f32_dither2_onetile', f32[11:], dict(quantize_method=2, dither_seed=10000, tile_shape=(H - 11, W)), None),
    ('f32_dither1_wrap', big, dict(quantize_method=1, dither_seed=1, tile_shape=big.shape), None),
    ('f64_nodither', f64, dict(quantize_method=-1), None), ('f64_dither1', f64, dict(quantize_method=1, dither_seed=4321), None),
    ('f32_gzip1_quantised', f32, dict(compression_type='GZIP_1', quantize_method=1, dither_seed=55), None), ('f32_gzip2_quantised', f32, dict(compression_type='GZIP_2', quantize_method=2, dither_seed=56), None),
    ('f32_gzip2_lossless', f32, dict(compression_type='GZIP_2', quantize_level=0), 'f32'), ('f64_gzip1_lossless', f64, dict(compression_type='GZIP_1', quantize_level=0), 'f64'),
    ('f32_nocompress_quantised', f32, dict(compression_type='NOCOMPRESS', quantize_method=1, dither_seed=8), None),
]
sources = {'i16': i16, 'u16': u16, 'i32': i32, 'u32': u32, 'u8': u8, 'mask': mask, 'cube': cube, 'f32': f32, 'f64': f64}

hl = fits.HDUList([fits.PrimaryHDU()])
for name, data, kw, share in cases:
    hl.append(fits.CompImageHDU(data, name=name, **kw))
buf = io.BytesIO(); hl.writeto(buf); raw = buf.getvalue()
with gzip.GzipFile(os.path.join(D, 'tilecomp_cases.fits.gz'), 'wb', mtime=0) as fo: fo.write(raw)

refs = fits.HDUList([fits.PrimaryHDU()]); done = set(); ref['tilecomp'] = []
with fits.open(io.BytesIO(raw)) as dec, fits.open(io.BytesIO(raw), disable_image_compression=True) as tab:
    for k, (name, data, kw, share) in enumerate(cases):
        got = np.array(dec[k + 1].data); T = tab[k + 1].header
        assert got.dtype == data.dtype and got.shape == data.shape, name
        if share:
            assert np.array_equal(got, sources[share], equal_nan=True), name      # lossless: astropy returns the input
            rname = 'REF_' + share.upper()
            if share not in done: refs.append(fits.ImageHDU(sources[share], name=rname)); done.add(share)
        else:
            rname = 'REF_' + name.upper(); refs.append(fits.ImageHDU(got, name=rname))
        cols = [T['TTYPE%d' % i] for i in range(1, T['TFIELDS'] + 1)]
        nfb = int(sum(1 for r in tab[k + 1].data['COMPRESSED_DATA'] if len(r) == 0))
        ref['tilecomp'].append({'name': name.upper(), 'ref': rname, 'dtype': str(data.dtype), 'shape': list(data.shape), 'zcmptype': T['ZCMPTYPE'], 'zquantiz': T.get('ZQUANTIZ'), 'zdither0': T.get('ZDITHER0'),
                                'ztile': [T.get('ZTILE%d' % i) for i in range(1, data.ndim + 1)], 'bytepix': next((T['ZVAL%d' % i] for i in (1, 2, 3) if T.get('ZNAME%d' % i) == 'BYTEPIX'), None),
                                'columns': cols, 'rows': int(T['NAXIS2']), 'fallback_rows': nfb, 'lossless': share is not None, 'nan': int(np.isnan(got).sum()) if got.dtype.kind == 'f' else 0,
                                'max_abs_error': None if share else float(np.nanmax(np.abs(np.where(np.abs(data) < 1e20, got.astype('f8') - data, 0))))})
buf = io.BytesIO(); refs.writeto(buf)
with gzip.GzipFile(os.path.join(D, 'tilecomp_reference.fits.gz'), 'wb', mtime=0) as fo: fo.write(buf.getvalue())

# the layout fpack writes: nothing in the primary, the image in the first extension; keywords on both
ph = fits.Header(); ph['OBSERVER'] = 'primary only'; ph['TELESCOP'] = 'from primary'; ph['OBJECT'] = 'primary object'
ch = fits.Header(); ch['DATE-OBS'] = ('2023-02-11T04:05:06.50', 'UTC start of exposure'); ch['EXPTIME'] = (60.0, '[s]'); ch['AIRMASS'] = 1.234; ch['OBJECT'] = 'HAT-P-32 b'; ch['IMAGETYP'] = 'Light Frame'
fits.HDUList([fits.PrimaryHDU(header=ph), fits.CompImageHDU(u16, header=ch)]).writeto(os.path.join(D, 'var_rice_u16.fits.fz'), overwrite=True)
with fits.open(os.path.join(D, 'var_rice_u16.fits.fz')) as f:
    e = 0
    while f[e].header['NAXIS'] == 0: e += 1          # EXOTIC's loop
    h = f[e].header; keys = {'bitpix': h['BITPIX'], 'naxis1': h['NAXIS1'], 'naxis2': h['NAXIS2'], 'bzero': h['BZERO']}     # before astropy scales the data and drops BZERO
    ref['fz'] = {'ext': e, 'sum': float(f[e].data.astype('f8').sum()), 'p_7_3': float(f[e].data[7, 3]), 'shape': list(f[e].data.shape), **keys,
                 'jd_start': Time(h['DATE-OBS'], scale='utc').jd, 'object': h['OBJECT'], 'has_ztile': 'ZTILE1' in h, 'has_tform': 'TFORM1' in h}

fits.PrimaryHDU(u32).writeto(os.path.join(D, 'var_u32.fits'), overwrite=True)
with fits.open(os.path.join(D, 'var_u32.fits')) as f:
    d = f[0].data; ref['u32'] = {'dtype': str(d.dtype), 'bzero': f[0].header['BZERO'], 'sum': float(d.astype('f8').sum()), 'min': float(d.min()), 'max': float(d.max()), 'p_7_3': float(d[7, 3])}

rgb = rng.integers(0, 4000, (3, 10, 12)).astype(np.uint16)
fits.PrimaryHDU(rgb).writeto(os.path.join(D, 'var_rgb_cube.fits'), overwrite=True)
gray = np.array([0.299, 0.587, 0.114])
ref['rgb_cube'] = {'shape': list(rgb.shape), 'plane_sums': [float(p.sum()) for p in rgb], 'gray': (np.moveaxis(rgb.astype('f8'), 0, -1) @ gray).ravel().tolist()}

# what astropy does with a header that has lost its END card, and with a file whose last block is cut short
a = np.arange(120, dtype=np.int16).reshape(10, 12); b = io.BytesIO(); fits.PrimaryHDU(a).writeto(b); b = bytearray(b.getvalue())
i = b.find(b'END' + b' ' * 77); noend = bytes(b[:i] + b'   ' + b[i + 3:])
def attempt(raw, **kw):
    try:
        with fits.open(io.BytesIO(raw), **kw) as f: return 'read' if np.array_equal(f[0].data, a) else 'wrong data'
    except Exception as err: return type(err).__name__ + ': ' + str(err)[:80]
ref['astropy_behaviour'] = {'missing_end': attempt(noend), 'missing_end_ignore': attempt(noend, ignore_missing_end=True), 'short_last_block': attempt(bytes(b[:2880 + 240]), ignore_missing_end=True)}

# ----------------------------------------------------------------------------------------------------- times
inst = Time('2022-03-04T05:06:07.250', scale='utc')
ref['instant'] = {'iso': '2022-03-04T05:06:07.250', 'date': '2022-03-04', 'time': '05:06:07.250', 'jd': inst.jd, 'mjd': inst.mjd,
                  'jd_if_tai': Time(inst.jd, format='jd', scale='tai').utc.jd, 'jd_if_tt': Time(inst.jd, format='jd', scale='tt').utc.jd, 'jd_if_tdb': Time(inst.jd, format='jd', scale='tdb').utc.jd}
JD, MJD = float(inst.jd), float(inst.mjd)
headers = [  # (keyword, value, comment) cards; EXOTIC's result for each is computed below
    [('DATE-OBS', '2022-03-04T05:06:07.250', 'UTC start of exposure'), ('EXPTIME', 120.0, '')],
    [('DATE-OBS', '2022-03-04T05:06:07.250', 'Start of exposure'), ('EXPTIME', 120.0, '')],            # capital S: EXOTIC does not shift
    [('DATE-OBS', '2022-03-04T05:06:07.250', 'UTC of observation'), ('EXPTIME', 120.0, '')],
    [('DATE-OBS', '2022-03-04', 'date at start'), ('TIME-OBS', '05:06:07.250', ''), ('EXPOSURE', 30.0, '')],
    [('DATE-OBS', '2022-03-04', ''), ('TIME-OBS', '05:06:07', 'start'), ('EXP', 30.0, '')],
    [('UT-OBS', '2022-03-04T05:06:07.250', 'exposure start'), ('DATE-OBS', '2001-01-01T00:00:00', ''), ('EXPTIME', 45.5, '')],
    [('JULIAN', JD, 'start of exposure'), ('DATE-OBS', '2001-01-01T00:00:00', ''), ('EXPTIME', 60.0, '')],
    [('JULIAN', JD, 'JD'), ('MJD-OBS', 51544.0, ''), ('EXPTIME', 60.0, '')],
    [('MJD-OBS', MJD, 'MJD at start of exposure'), ('DATE-OBS', '2001-01-01T00:00:00', 'start'), ('EXPTIME', 60.0, '')],
    [('MJD-OBS', MJD, ''), ('EXPTIME', 60.0, '')],
    [('BJD_TDB', JD + 0.003, 'mid exposure'), ('DATE-OBS', '2001-01-01T00:00:00', 'start'), ('EXPTIME', 60.0, '')],
    [('BJD_TBD', JD + 0.003, 'start of exposure'), ('JULIAN', JD, ''), ('EXPTIME', 60.0, '')],
    [('BJD', JD + 0.003, ''), ('BJD_TBD', 1.0, ''), ('EXPOSURE', 10.0, '')],
    [('BJD', JD + 0.003, 'start'), ('UT-OBS', '2001-01-01T00:00:00', ''), ('EXP', 10.0, '')],
    [('DATE-OBS', '2022-03-04T05:06:07', 'start'), ('EXPOSURE', 15.0, ''), ('EXP', 99.0, '')],
    [('DATE-OBS', '2019-12-31T23:59:59.999', 'start')],                                                 # no exposure keyword: no offset
    [('DATE-OBS', '2016-12-31T23:59:30', 'start of exposure'), ('EXPTIME', 20.0, '')],                  # just before a leap second
]

# --------------------------------------------------------------------------------------------------- demosaic
cfa = rng.integers(0, 60000, (11, 14)).astype(np.uint16)        # odd height: both parities at the edges
patterns = ['RGGB', 'BGGR', 'GRBG', 'GBRG']
def bilinear_scipy(cfa, pattern):
    """Independent implementation: masks of the pattern, scipy.ndimage.convolve with the standard bilinear kernels."""
    cfa = cfa.astype('f8'); m = {c: np.zeros(cfa.shape) for c in 'RGB'}
    for c, (y, x) in zip(pattern, [(0, 0), (0, 1), (1, 0), (1, 1)]): m[c][y::2, x::2] = 1
    kg = np.array([[0, 1, 0], [1, 4, 1], [0, 1, 0]]) / 4; krb = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]]) / 4
    return np.stack([convolve(cfa * m['R'], krb, mode='reflect'), convolve(cfa * m['G'], kg, mode='reflect'), convolve(cfa * m['B'], krb, mode='reflect')], axis=-1)

payload = {'headers': headers, 'cfa': cfa.tolist(), 'patterns': patterns}
part = exotic_part(payload)
if 'times' not in part or 'demosaic' not in part:
    py = os.environ.get('EXOTIC_PYTHON', '/Users/kpearson/miniconda3/envs/exotic/bin/python')
    if os.path.exists(py):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            json.dump(payload, open(os.path.join(td, 'in.json'), 'w'))
            r = subprocess.run([py, '-B', os.path.abspath(__file__), '--exotic-part', os.path.join(td, 'in.json'), os.path.join(td, 'out.json')], capture_output=True, text=True)
            if r.returncode == 0:
                other = json.load(open(os.path.join(td, 'out.json')))
                for k, v in other.items(): part.setdefault(k, v)
            else: print('the EXOTIC environment could not run the dateutil / colour_demosaicing part:', r.stderr[-300:])
if 'times' not in part:
    part['times'] = exotic_times(headers, datetime.datetime.fromisoformat, Time, fits)
    part['time_parser'] = f'datetime.fromisoformat (dateutil not available) + astropy {astropy.__version__} Time'
ref['exotic_time'] = {'parser': part['time_parser'], 'cases': [{'cards': h, **t} for h, t in zip(headers, part['times'])]}

own = {p: bilinear_scipy(cfa, p) for p in patterns}
if 'demosaic' in part:
    worst = max(float(np.abs(np.array(part['demosaic'][p]) - own[p]).max()) for p in patterns)
    assert worst == 0, worst          # the scipy implementation and colour_demosaicing agree exactly
    planes = {p: np.array(part['demosaic'][p]) for p in patterns}; src = part['demosaic_source'] + ' (and scipy.ndimage.convolve, identical)'
else:
    planes = own; src = 'scipy.ndimage.convolve with the bilinear kernels (colour_demosaicing not available)'
def mult(out):   # exotic.py calculate_demosaic_mult, lines 923-943
    m = np.array(out) if isinstance(out, list) else np.array({'red': [1.0, 0, 0], 'green': [0, 1.0, 0], 'blue': [0, 0, 1.0], 'gray': [0.299, 0.587, 0.114], 'blueblock': [0.299, 0.587, 0.0]}.get(out, [0, 1.0, 0]))
    return m / (m[0] + m[1] + m[2])
ref['demosaic'] = {'source': src, 'cfa': cfa.ravel().tolist(), 'width': cfa.shape[1], 'height': cfa.shape[0],
                   'planes': {p: {'r': planes[p][..., 0].ravel().tolist(), 'g': planes[p][..., 1].ravel().tolist(), 'b': planes[p][..., 2].ravel().tolist()} for p in patterns},
                   # exotic.py demosaic_img, lines 946-953: (rgb @ mult).astype(dtype of the frame)
                   'mixes': [{'out': o, 'float': (planes['RGGB'] @ mult(o)).ravel().tolist(), 'exotic_uint16': (planes['RGGB'] @ mult(o)).astype(cfa.dtype).ravel().tolist()} for o in ['red', 'green', 'blue', 'gray', 'blueblock', [1.0, 2.0, 3.0], 'nonsense']]}

# -------------------------------------------------------------------------------------------- WCS, pixel scale
def wcs_case(name, cards, npts=8):
    h = fits.Header()
    for k, v in cards.items(): h[k] = v
    w = WCS(h); xy = np.column_stack([rng.uniform(0, 2000, npts), rng.uniform(0, 1500, npts)]); xy[0] = [h['CRPIX1'] - 1, h['CRPIX2'] - 1]
    sky = w.all_pix2world(xy, 0); back = w.all_world2pix(sky, 0)
    assert np.abs(back - xy).max() < 1e-6
    sc = w.proj_plane_pixel_scales()
    return {'name': name, 'cards': cards, 'pix': xy.tolist(), 'sky': sky.tolist(), 'scales_arcsec': [float(sc[0].value * 3600), float(sc[1].value * 3600)], 'exotic_scale': float((sc[0].value + sc[1].value) / 2 * 3600)}
s = 0.62 / 3600; th = np.radians(33.0)
base = {'CTYPE1': 'RA---TAN', 'CTYPE2': 'DEC--TAN', 'CRPIX1': 1024.5, 'CRPIX2': 700.25, 'NAXIS': 2, 'NAXIS1': 2048, 'NAXIS2': 1500}
ref['wcs'] = [
    wcs_case('CD matrix, rotated', {**base, 'CRVAL1': 97.6366, 'CRVAL2': 29.6723, 'CD1_1': -s * np.cos(th), 'CD1_2': s * np.sin(th), 'CD2_1': s * np.sin(th), 'CD2_2': s * np.cos(th)}),
    wcs_case('CD matrix, mirrored, unequal scales, RA near 0', {**base, 'CRVAL1': 0.05, 'CRVAL2': -41.3, 'CD1_1': 1.1 * s * np.cos(th), 'CD1_2': -s * np.sin(th), 'CD2_1': 1.1 * s * np.sin(th), 'CD2_2': s * np.cos(th)}),
    wcs_case('PC + CDELT', {**base, 'CRVAL1': 201.2, 'CRVAL2': 12.5, 'CDELT1': -s, 'CDELT2': 1.3 * s, 'PC1_1': np.cos(th), 'PC1_2': -np.sin(th), 'PC2_1': np.sin(th), 'PC2_2': np.cos(th)}),
    wcs_case('CDELT + CROTA2', {**base, 'CRVAL1': 311.0, 'CRVAL2': 60.0, 'CDELT1': -s, 'CDELT2': 1.2 * s, 'CROTA2': 21.5}),
    wcs_case('CDELT only, close to the pole', {**base, 'CRVAL1': 150.0, 'CRVAL2': 88.9, 'CDELT1': -s, 'CDELT2': s}),
]

json.dump(ref, open(os.path.join(D, 'fits_variants.json'), 'w'), separators=(',', ':'))
tot = 0
for n in ['tilecomp_cases.fits.gz', 'tilecomp_reference.fits.gz', 'var_rice_u16.fits.fz', 'var_u32.fits', 'var_rgb_cube.fits', 'fits_variants.json']:
    sz = os.path.getsize(os.path.join(D, n)); tot += sz; print(f'{n:32s} {sz:8d} bytes')
print(f'{"total":32s} {tot:8d} bytes;  {len(cases)} tile-compressed cases; times by {part["time_parser"]}; demosaic by {src}')
print('astropy on damaged files:', ref['astropy_behaviour'])
