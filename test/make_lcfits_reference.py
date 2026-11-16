"""Small light-curve FITS files for test/lcfits.test.mjs, written with astropy in the layout of the TESS SPOC and
Kepler light-curve products (TIME in BTJD / BKJD with BJDREFI/BJDREFF, PDCSAP_FLUX, QUALITY), with flagged and blank
rows, and the expected light curve after the same cuts (numpy). Run with .venv-phot/bin/python.
"""
import gzip, json, pathlib
import numpy as np
from astropy.io import fits

here = pathlib.Path(__file__).parent
rng = np.random.default_rng(3)
out = {}
for name, ref, mission, extra in [('lc_tess_small.fits', 2457000, 'TESS', {'SECTOR': 14}), ('lc_kepler_small.fits.gz', 2454833, 'Kepler', {'QUARTER': 3})]:
    n = 120
    t = 1683.25 + np.arange(n) * 2 / 1440 if mission == 'TESS' else 260.1 + np.arange(n) * 0.0204
    pdc = 52345.6 * (1 + 2e-4 * rng.standard_normal(n)); err = np.full(n, 10.5); sap = pdc * 1.03
    q = np.zeros(n, dtype=np.int32); q[[5, 17, 64]] = [128, 1, 2048]
    pdc[[30, 31]] = np.nan; t[90] = np.nan
    cols = [fits.Column('TIME', 'D', array=t, unit='BJD - %d, days' % ref), fits.Column('SAP_FLUX', 'E', array=sap), fits.Column('PDCSAP_FLUX', 'E', array=pdc),
            fits.Column('PDCSAP_FLUX_ERR', 'E', array=err), fits.Column('QUALITY', 'J', array=q)]
    tb = fits.BinTableHDU.from_columns(cols, name='LIGHTCURVE')
    tb.header['BJDREFI'] = ref; tb.header['BJDREFF'] = 0.0; tb.header['TIMEREF'] = 'SOLARSYSTEM'; tb.header['TIMESYS'] = 'TDB'
    pr = fits.PrimaryHDU(); pr.header['OBJECT'] = 'TEST STAR'; pr.header['TELESCOP'] = mission; pr.header['RA_OBJ'] = 123.4; pr.header['DEC_OBJ'] = -12.3
    for k, v in extra.items(): pr.header[k] = v
    hl = fits.HDUList([pr, tb])
    path = here / 'data' / name
    if name.endswith('.gz'):
        import io; b = io.BytesIO(); hl.writeto(b); path.write_bytes(gzip.compress(b.getvalue()))
    else: hl.writeto(path, overwrite=True)
    keep = (q == 0) & np.isfinite(t) & np.isfinite(pdc)
    f = pdc[keep].astype(np.float32).astype(float); med = np.sort(f)[len(f) // 2]
    out[name] = {'n': int(keep.sum()), 't0': float(t[keep][0] + ref), 't_last': float(t[keep][-1] + ref), 'f0': float(f[0] / med), 'e0': float(np.float32(10.5) / med), 'median': float(med), 'flagged': 3, 'blank': 3}
(here / 'lcfits_reference.json').write_text(json.dumps(out, indent=1))
print(out)
