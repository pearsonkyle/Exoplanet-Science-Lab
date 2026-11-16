"""lightkurve's reading of the target pixel files the site's code is tested on (test/tpf_lightkurve.test.mjs, test/k2.test.mjs).

  python3.12 -m venv .venv-lk && .venv-lk/bin/pip install lightkurve wotan numba
  .venv-lk/bin/python test/make_lightkurve_reference.py [--cache DIR]

For each TPF (TESS WASP-18 sector 2 cut to 700 cadences, Kepler TrES-2 quarter 1, and a K2 campaign 1 crop of K2-3 =
EPIC 201367065, written here to test/data from the public bucket file): the cadences each quality preset keeps, the
times as BJD_TDB, the simple-aperture light curve of the pipeline aperture (flux, error, centroids, background),
lightkurve's threshold mask, the SPOC / Kepler SAP_FLUX and PDCSAP_FLUX of the same cadences (light-curve files from the
bucket, kept only in the cache) and lightkurve's CDPP; for K2, SFFCorrector and PLDCorrector with their defaults and the
CDPP before and after, on the crop and on the whole campaign and stamp. Writes test/lightkurve_reference.json.
Downloads (about 20 MB) go to --cache (default ~/.cache/esl-lk), never into the repository except the crop.
"""
import argparse, json, os, urllib.request, warnings
import numpy as np
from astropy.io import fits
warnings.filterwarnings('ignore')
import lightkurve as lk
from lightkurve.utils import KeplerQualityFlags, TessQualityFlags

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')
BUCKET = 'https://stpubdata.s3.us-east-1.amazonaws.com/'
URLS = {
    'tess_lc': 'tess/public/tid/s0002/0000/0001/0010/0827/tess2018234235059-s0002-0000000100100827-0121-s_lc.fits',
    'kepler_lc': 'kepler/public/lightcurves/0114/011446443/kplr011446443-2009131105131_llc.fits',
    'k2_tpf': 'k2/public/target_pixel_files/c1/201300000/67000/ktwo201367065-c01_lpd-targ.fits.gz',
    'k2_lc': 'k2/public/lightcurves/c1/201300000/67000/ktwo201367065-c01_llc.fits',
}
K2_CROP = 'ktwo201367065-c01_crop_lpd-targ.fits.gz'
K2_ROWS, K2_COLS, K2_NCAD = (3, 13), (4, 14), 1200      # 10 x 10 pixels around the aperture, the first 1200 cadences (24.5 d)

def fetch(key, cache):
    os.makedirs(cache, exist_ok=True)
    p = os.path.join(cache, URLS[key].split('/')[-1])
    if not os.path.exists(p):
        print('downloading', URLS[key])
        urllib.request.urlretrieve(BUCKET + URLS[key], p)
    return p

def make_k2_crop(src):
    """A small but real K2 TPF: the same table layout (RAW_CNTS kept as a scalar so that FLUX stays column 5 and the
    1CRV5P / 2CRV5P keywords keep their meaning), pixels cropped, cadences cut."""
    with fits.open(src) as h:
        P, T, A = h[0], h[1], h[2]
        r0, r1 = K2_ROWS; c0, c1 = K2_COLS; ny, nx = r1 - r0, c1 - c0
        d = T.data[:K2_NCAD]
        cols = []
        for c in T.columns:
            if c.name in ('FLUX_BKG_ERR', 'COSMIC_RAYS', 'RB_LEVEL'):
                continue
            if c.name == 'RAW_CNTS':
                cols.append(fits.Column(name='RAW_CNTS', format='J', array=np.full(len(d), -1, dtype=np.int32)))
                continue
            v = d[c.name]
            if v.ndim == 3:
                cols.append(fits.Column(name=c.name, format=f'{nx * ny}E', unit=c.unit, dim=f'({nx},{ny})', array=v[:, r0:r1, c0:c1]))
            else:
                cols.append(fits.Column(name=c.name, format=c.format, unit=c.unit, array=v))
        t = fits.BinTableHDU.from_columns(cols, name='TARGETTABLES')
        for k, v in T.header.items():
            if k.startswith(('TTYPE', 'TFORM', 'TUNIT', 'TDISP', 'TDIM', 'TNULL', 'NAXIS', 'TFIELDS', 'PCOUNT', 'GCOUNT', 'XTENSION', 'BITPIX')) or k in ('COMMENT', 'HISTORY', ''):
                continue
            if k[:1].isdigit() and k[1:4] in ('CRV', 'CRP', 'CUN', 'CTY', 'CDE', 'PC_', 'CRV'):
                continue
            try:
                t.header[k] = v
            except Exception:
                pass
        # pixel coordinates of the FLUX-like columns (5..8 in this layout): CCD column / row of pixel (0, 0) moved by the crop
        for j, c in enumerate(t.columns, start=1):
            if c.dim:
                for kk in ('1CTYP', '2CTYP', '1CUNI', '2CUNI'):
                    pass
                t.header[f'1CRV{j}P'] = T.header['1CRV5P'] + c0
                t.header[f'2CRV{j}P'] = T.header['2CRV5P'] + r0
                t.header[f'1CRPX{j}'] = T.header.get('1CRPX5', 0) - c0
                t.header[f'2CRPX{j}'] = T.header.get('2CRPX5', 0) - r0
                t.header[f'1CRVL{j}'] = T.header.get('1CRVL5', 0)
                t.header[f'2CRVL{j}'] = T.header.get('2CRVL5', 0)
        t.header['NAXIS2'] = len(d)
        a = fits.ImageHDU(A.data[r0:r1, c0:c1], header=A.header, name='APERTURE')
        a.header['CRVAL1P'] = A.header.get('CRVAL1P', 0) + c0
        a.header['CRVAL2P'] = A.header.get('CRVAL2P', 0) + r0
        a.header['HISTORY'] = f'Cropped for Exoplanet Science Lab tests: rows {r0}:{r1}, columns {c0}:{c1}, cadences 0:{K2_NCAD}'
        p = fits.PrimaryHDU(header=P.header)
        p.header['HISTORY'] = f'Cut from {URLS["k2_tpf"]}: rows {r0}:{r1}, columns {c0}:{c1} of the stamp, the first {K2_NCAD} cadences'
        out = os.path.join(D, K2_CROP)
        fits.HDUList([p, t, a]).writeto(out, overwrite=True, checksum=False)
    return out

def cdpp64(time, flux, **kw):
    """lightkurve's CDPP of a float64 copy: on float32 fluxes (as the files hold them) its running mean is a float32
    cumulative sum of ppm values, which moves the result by 0.1% for a quiet Kepler star (both are recorded)."""
    f = np.asarray(getattr(flux, 'value', flux), dtype=float)
    g = np.isfinite(f)
    return float(lk.LightCurve(time=time[g], flux=f[g]).estimate_cdpp(**kw).value)

def r9(a):
    return [None if not np.isfinite(x) else float(f'{x:.10g}') for x in np.asarray(a, dtype=float)]

def tpf_ref(path, lc_path=None, transit_duration=13):
    out = {'file': os.path.basename(path), 'quality': {}}
    tpf_all = lk.read(path, quality_bitmask='none')
    mission = 'TESS' if 'TESS' in str(tpf_all.meta.get('TELESCOP', '')) else ('K2' if tpf_all.meta.get('MISSION') == 'K2' else 'Kepler')
    flags = TessQualityFlags if mission == 'TESS' else KeplerQualityFlags
    out['mission'] = mission
    out['bitmasks'] = {k: int(flags.create_quality_mask(np.array([0]), k) is not None and getattr(flags, (k.upper() + '_BITMASK'))) for k in ('default', 'hard', 'hardest')}
    q = np.asarray(tpf_all.quality)
    for preset in ('none', 'default', 'hard', 'hardest'):
        t = lk.read(path, quality_bitmask=preset)
        out['quality'][preset] = {'n': int(len(t.time)), 'cadenceno_first': int(t.cadenceno[0]), 'cadenceno_last': int(t.cadenceno[-1])}
    tpf = lk.read(path, quality_bitmask='default')
    out['ncad_file'] = int(len(tpf_all.time))
    # times: lightkurve's astropy Time in TDB, as JD
    out['time_bjd'] = [float(x) for x in tpf.time.tdb.jd]
    out['cadenceno'] = [int(x) for x in tpf.cadenceno]
    pm = tpf.pipeline_mask
    out['pipeline_npix'] = int(pm.sum())
    lc = tpf.to_lightcurve(aperture_mask='pipeline')
    out['sap'] = {'flux': r9(lc.flux.value), 'flux_err': r9(lc.flux_err.value), 'centroid_col': r9(lc.centroid_col.value), 'centroid_row': r9(lc.centroid_row.value)}
    out['column0'], out['row0'] = int(tpf.column), int(tpf.row)
    out['sap']['bkg_sum'] = r9(np.nansum(tpf.flux_bkg.value[:, pm], axis=1))      # what get_bkg_lightcurve sums (it also needs FLUX_BKG_ERR)
    th = tpf.create_threshold_mask(threshold=3, reference_pixel='center')
    out['threshold3'] = {'mask': [int(x) for x in th.ravel()], 'npix': int(th.sum())}
    good = np.isfinite(lc.flux.value)
    out['cdpp_sap'] = cdpp64(lc.time, lc.flux, transit_duration=transit_duration)
    out['cdpp_sap_float32'] = float(lc[good].estimate_cdpp(transit_duration=transit_duration).value)
    out['cdpp_transit_duration'] = transit_duration
    if lc_path:
        L = fits.open(lc_path)[1].data
        idx = {int(c): i for i, c in enumerate(L['CADENCENO'])}
        rows = [idx.get(int(c), -1) for c in tpf.cadenceno]
        ok = np.array([r >= 0 for r in rows])
        sap = np.array([L['SAP_FLUX'][r] if r >= 0 else np.nan for r in rows])
        pdc = np.array([L['PDCSAP_FLUX'][r] if r >= 0 else np.nan for r in rows])
        tl = np.array([L['TIME'][r] if r >= 0 else np.nan for r in rows])
        bk = np.array([L['SAP_BKG'][r] if r >= 0 else np.nan for r in rows])
        out['lcfile'] = {'file': os.path.basename(lc_path), 'matched': int(ok.sum()), 'sap_flux': r9(sap), 'pdcsap_flux': r9(pdc), 'sap_bkg': r9(bk), 'time': [None if not np.isfinite(x) else float(x) for x in tl]}
        m = ok & np.isfinite(sap) & np.isfinite(lc.flux.value)
        rel = lc.flux.value[m] / sap[m] - 1
        out['lcfile']['lightkurve_vs_sap'] = {'n': int(m.sum()), 'median': float(np.median(rel)), 'max_abs': float(np.max(np.abs(rel)))}
        out['lcfile']['cdpp_pdcsap'] = cdpp64(tpf.time, pdc, transit_duration=transit_duration)
        out['lcfile']['cdpp_sapfile'] = cdpp64(tpf.time, sap, transit_duration=transit_duration)
    return out, tpf, lc

def k2_correctors(tpf, lc):
    """lightkurve's two K2 correctors with their defaults, and the CDPP before and after (6.5 h: 13 long cadences)."""
    out = {}
    good = np.isfinite(lc.flux.value)
    lc = lc[good]
    out['n'] = int(len(lc))
    out['cdpp_raw'] = cdpp64(lc.time, lc.flux)
    sff = lc.to_corrector('sff').correct()
    out['cdpp_sff'] = cdpp64(sff.time, sff.flux)
    try:
        pld = tpf[good].to_corrector('pld').correct()
        out['cdpp_pld'] = cdpp64(pld.time, pld.flux)
        pld2 = tpf[good].to_corrector('pld').correct(pld_order=2)
        out['cdpp_pld_order2'] = cdpp64(pld2.time, pld2.flux)
        out['pld_flux'] = r9(pld.flux.value)
    except Exception as err:     # PLDCorrector needs patsy and fbpca
        out['pld_error'] = repr(err)
    out['sff_flux'] = r9(sff.flux.value)
    out['time'] = [float(x) for x in lc.time.value]
    q = np.asarray(tpf[good].quality)
    out['thruster_quality'] = {'firing': int(((q & 1048576) > 0).sum()), 'possible': int(((q & 524288) > 0).sum())}
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.expanduser('~/.cache/esl-lk'))
    a = ap.parse_args()
    ref = {'lightkurve': lk.__version__}
    ref['tess'], _, _ = tpf_ref(os.path.join(D, 'tess_wasp18_s02_sub_tp.fits'), fetch('tess_lc', a.cache))
    ref['kepler'], _, _ = tpf_ref(os.path.join(D, 'kplr011446443-2009131105131_lpd-targ.fits.gz'), fetch('kepler_lc', a.cache))
    full = fetch('k2_tpf', a.cache)
    crop = make_k2_crop(full)
    ref['k2'], tpf, lc = tpf_ref(crop, fetch('k2_lc', a.cache))
    ref['k2']['correctors'] = k2_correctors(tpf, lc)
    # the whole campaign and stamp (numbers only; the file stays in the cache)
    fk, ftpf, flc = tpf_ref(full, fetch('k2_lc', a.cache))
    ref['k2_full'] = {k: fk[k] for k in ('file', 'quality', 'pipeline_npix', 'cdpp_sap', 'mission')}
    ref['k2_full']['lcfile'] = {k: fk['lcfile'][k] for k in ('matched', 'lightkurve_vs_sap', 'cdpp_pdcsap', 'cdpp_sapfile')}
    cf = k2_correctors(ftpf, flc)
    ref['k2_full']['correctors'] = {k: v for k, v in cf.items() if not isinstance(v, list)}
    ref['k2_full']['path'] = full
    with open(os.path.join(HERE, 'lightkurve_reference.json'), 'w') as f:
        json.dump(ref, f, separators=(',', ':'))
    for k in ('tess', 'kepler', 'k2'):
        r = ref[k]
        print(k, r['quality'], 'pipeline px', r['pipeline_npix'], 'cdpp sap', round(r['cdpp_sap'], 1), r.get('lcfile', {}).get('lightkurve_vs_sap'), 'cdpp pdcsap', r.get('lcfile', {}).get('cdpp_pdcsap'))
    print('k2 crop correctors', {k: v for k, v in ref['k2']['correctors'].items() if not isinstance(v, list)})
    print('k2 full', ref['k2_full'])

if __name__ == '__main__':
    main()
