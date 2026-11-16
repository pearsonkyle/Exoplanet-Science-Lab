# Reference values for test/fits.test.mjs, test/photometry.test.mjs and test/gp.test.mjs.
#
#   python3 -m venv .venv-phot && .venv-phot/bin/pip install astropy photutils numpy scipy scikit-learn
#   .venv-phot/bin/python test/make_photometry_reference.py [path to a full TESS TPF] [path to a Kepler TPF .fits.gz]
#
# Writes into test/data/:
#   syn_i16.fits            200 x 160 unsigned 16-bit frame (BZERO 32768) with known stars
#   syn_f32.fits.gz         the same scene as float32 in an IMAGE extension, gzipped, different time keywords
#   syn_small_*.fits        tiny frames in every BITPIX, for the decoder
#   tess_wasp18_s02_sub_tp.fits   700 cadences cut from the real WASP-18 sector 2 target pixel file (only when the
#                                 full file is given: https://stpubdata.s3.us-east-1.amazonaws.com/tess/public/tid/
#                                 s0002/0000/0001/0010/0827/tess2018234235059-s0002-0000000100100827-0121-s_tp.fits)
#   kplr011446443-2009131105131_lpd-targ.fits.gz   a real Kepler long-cadence TPF (TrES-2), copied as is
# and test/photometry_reference.json with what astropy, photutils, scipy and scikit-learn make of them.
import sys, json, gzip, shutil, os, warnings
import numpy as np
from scipy.special import erf
from scipy.optimize import least_squares
from scipy.signal import savgol_filter
from scipy.ndimage import binary_dilation
from astropy.io import fits
from astropy.time import Time
from astropy.stats import sigma_clipped_stats
from astropy.coordinates import SkyCoord, EarthLocation, AltAz, solar_system_ephemeris
import astropy.units as u
import astropy, photutils, scipy, sklearn
from photutils.aperture import CircularAperture, CircularAnnulus, aperture_photometry
from photutils.centroids import centroid_com
from photutils.detection import DAOStarFinder

warnings.simplefilter('ignore')
here = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(here, 'data'); os.makedirs(D, exist_ok=True)
rng = np.random.default_rng(20261115)
ref = {'versions': {'astropy': astropy.__version__, 'photutils': photutils.__version__, 'scipy': scipy.__version__, 'numpy': np.__version__, 'sklearn': sklearn.__version__}}

# ------------------------------------------------------------------ synthetic frame with known stars
W, H = 200, 160
SKY, READ, GAIN = 310.0, 6.0, 1.0
stars = [  # x, y, flux [e-], sigma [px]
    dict(x=100.37, y=80.81, flux=180000.0, sigma=2.1),     # target
    dict(x=41.62, y=52.18, flux=240000.0, sigma=2.1),
    dict(x=160.05, y=119.5, flux=90000.0, sigma=2.1),
    dict(x=61.9, y=124.33, flux=52000.0, sigma=2.1),
    dict(x=150.44, y=37.27, flux=21000.0, sigma=2.1),
    dict(x=24.5, y=100.5, flux=9000.0, sigma=2.1),
]
def scene(stars, w=W, h=H, sky=SKY):
    img = np.full((h, w), sky)
    x = np.arange(w); y = np.arange(h)
    for s in stars:
        k = 1 / (np.sqrt(2) * s['sigma'])
        ex = 0.5 * (erf((x + 0.5 - s['x']) * k) - erf((x - 0.5 - s['x']) * k))
        ey = 0.5 * (erf((y + 0.5 - s['y']) * k) - erf((y - 0.5 - s['y']) * k))
        img += s['flux'] * np.outer(ey, ex)
    return img
clean = scene(stars)
noisy = rng.poisson(clean / GAIN) * GAIN + rng.normal(0, READ, clean.shape)
i16 = np.clip(np.round(noisy), 0, 65535).astype(np.uint16)
hdr = fits.Header()
hdr['DATE-OBS'] = ('2021-03-14T05:21:07.250', 'UTC at start of exposure')
hdr['EXPTIME'] = (45.0, 'seconds')
hdr['AIRMASS'] = 1.2345
hdr['OBJECT'] = 'synthetic'
hdr['OBJCTRA'] = '06 30 32.79'
hdr['OBJCTDEC'] = '+29 40 20.3'
hdr['SITELAT'] = 32.4165
hdr['SITELONG'] = -110.7345
hdr['GAIN'] = GAIN
hdr['LONGSTR'] = "it's a string with a quote / and a slash"
hdr['HIERARCH ESO TEL AIRM START'] = 1.25
hdr['COMMENT'] = 'made by test/make_photometry_reference.py'
fits.PrimaryHDU(i16, header=hdr).writeto(os.path.join(D, 'syn_i16.fits'), overwrite=True)

h2 = fits.Header()
h2['JD'] = (2459287.722999, 'Julian date, mid exposure')
h2['EXPOSURE'] = 30.0
h2['TELALT'] = 53.2
f32 = noisy.astype(np.float32)
f32[5, 7] = np.nan
tmp = os.path.join(D, 'syn_f32.fits')
fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(f32, header=h2, name='SCI')]).writeto(tmp, overwrite=True)
with open(tmp, 'rb') as fi, gzip.GzipFile(os.path.join(D, 'syn_f32.fits.gz'), 'wb', mtime=0) as fo: shutil.copyfileobj(fi, fo)
os.remove(tmp)

# tiny frames in every BITPIX, with scaling and BLANK
small = {}
base = (rng.normal(0, 1, (12, 16)) * 50 + 100)
cases = {
    'u8': base.clip(0, 255).astype(np.uint8), 'i16': (base * 20).astype(np.int16), 'i32': (base * 70000).astype(np.int32),
    'i64': (base * 3e9).astype(np.int64), 'f32': base.astype(np.float32), 'f64': base.astype(np.float64),
}
for k, a in cases.items():
    hh = fits.Header()
    fits.PrimaryHDU(a, header=hh).writeto(os.path.join(D, f'syn_small_{k}.fits'), overwrite=True)
    small[k] = {'sum': float(a.astype(np.float64).sum()), 'first': float(a[0, 0]), 'last': float(a[-1, -1]), 'p_3_5': float(a[3, 5]), 'shape': list(a.shape)}
# scaled integers with BLANK: physical = 0.25 * stored + 1000, one blank pixel
st = (base * 20).astype(np.int16); st[2, 3] = -32768
hh = fits.Header(); hdu = fits.PrimaryHDU(st, header=hh); hdu.header['BSCALE'] = 0.25; hdu.header['BZERO'] = 1000.0; hdu.header['BLANK'] = -32768
hdu.writeto(os.path.join(D, 'syn_small_scaled.fits'), overwrite=True, output_verify='ignore')
with fits.open(os.path.join(D, 'syn_small_scaled.fits')) as hl:
    a = hl[0].data.astype(np.float64)
    small['scaled'] = {'sum': float(np.nansum(a)), 'nan': int(np.isnan(a).sum()), 'first': float(a[0, 0]), 'p_3_5': float(a[3, 5]), 'shape': list(a.shape)}
# a cube: 3 planes
cube = np.stack([base, base * 2, base * 3]).astype(np.float32)
fits.PrimaryHDU(cube).writeto(os.path.join(D, 'syn_small_cube.fits'), overwrite=True)
small['cube'] = {'plane_sums': [float(p.astype(np.float64).sum()) for p in cube], 'shape': list(cube.shape)}
ref['small'] = small

# what astropy reads back
with fits.open(os.path.join(D, 'syn_i16.fits')) as hl:
    img = hl[0].data.astype(np.float64); hd = hl[0].header
    t = Time(hd['DATE-OBS'], format='isot', scale='utc')
    ref['syn_i16'] = {'shape': list(img.shape), 'sum': float(img.sum()), 'min': float(img.min()), 'max': float(img.max()), 'p_80_100': float(img[80, 100]),
                      'jd_start': float(t.jd), 'jd_mid': float(t.jd + hd['EXPTIME'] / 2 / 86400), 'exptime': hd['EXPTIME'], 'airmass': hd['AIRMASS'], 'longstr': hd['LONGSTR'],
                      'hierarch': hd['ESO TEL AIRM START'], 'bzero': hd['BZERO']}
with fits.open(os.path.join(D, 'syn_f32.fits.gz')) as hl:
    a = hl[1].data.astype(np.float64)
    ref['syn_f32'] = {'shape': list(a.shape), 'nansum': float(np.nansum(a)), 'nan': int(np.isnan(a).sum()), 'jd': hl[1].header['JD'], 'airmass_from_alt': float(1 / np.cos(np.radians(90 - 53.2))), 'extname': hl[1].header['EXTNAME']}

# ------------------------------------------------------------------ photutils on the 16-bit frame
P = {'truth': {'stars': stars, 'sky': SKY, 'read': READ, 'gain': GAIN}, 'apertures': [], 'annuli': [], 'centroids': [], 'gauss': []}
pos = [(s['x'], s['y']) for s in stars]
for r in [2.5, 4.0, 7.3, 12.0]:
    ap = CircularAperture(pos, r=r)
    row = {'r': r, 'area': float(ap.area)}
    for meth, kw in [('exact', {}), ('subpixel', {'subpixels': 5}), ('center', {})]:
        row[meth] = [float(v) for v in aperture_photometry(img, ap, method=meth, **kw)['aperture_sum']]
    P['apertures'].append(row)
# a clean (noise-free) scene makes the aperture sum checkable against the analytic integral of a Gaussian in a circle
P['clean_exact'] = []
for r in [3.0, 6.0, 15.0]:
    ap = CircularAperture(pos[:3], r=r)
    P['clean_exact'].append({'r': r, 'photutils': [float(v) for v in aperture_photometry(clean - SKY, ap, method='exact')['aperture_sum']],
                             'analytic_point_sampled': [float(s['flux'] * (1 - np.exp(-r * r / (2 * s['sigma'] ** 2)))) for s in stars[:3]]})
for (rin, rout) in [(9.0, 14.0), (6.0, 11.5), (14.0, 20.0)]:
    an = CircularAnnulus(pos, r_in=rin, r_out=rout)
    out = []
    for m in an.to_mask(method='center'):
        vals = m.get_values(img)
        mean, med, std = sigma_clipped_stats(vals, sigma=3.0, maxiters=5)
        out.append({'median': float(med), 'mean': float(mean), 'std': float(std), 'n_all': int(vals.size), 'raw_median': float(np.median(vals))})
    P['annuli'].append({'rin': rin, 'rout': rout, 'stats': out})
for half in [5, 9]:
    out = []
    for (x, y) in pos:
        cx, cy = int(round(x)), int(round(y))
        cut = img[cy - half:cy + half + 1, cx - half:cx + half + 1] - SKY
        c = centroid_com(cut)
        out.append([float(c[0] + cx - half), float(c[1] + cy - half)])
    P['centroids'].append({'half': half, 'bkg': SKY, 'com': out})

def gauss(p, xx, yy): return p[5] + p[2] * np.exp(-((xx - p[0]) ** 2 / (2 * p[3] ** 2) + (yy - p[1]) ** 2 / (2 * p[4] ** 2)))
def moffat(p, xx, yy): return p[5] + p[2] * (1 + ((xx - p[0]) ** 2 + (yy - p[1]) ** 2) / p[3] ** 2) ** (-p[4])
half = 8
for (x, y) in pos:
    cx, cy = int(round(x)), int(round(y))
    yy, xx = np.mgrid[cy - half:cy + half + 1, cx - half:cx + half + 1]
    cut = img[cy - half:cy + half + 1, cx - half:cx + half + 1]
    p0 = [x, y, cut.max() - cut.min(), 1.5, 1.5, cut.min()]
    r = least_squares(lambda p: (gauss(p, xx, yy) - cut).ravel(), p0, method='lm', xtol=1e-14, ftol=1e-14, gtol=1e-14)
    P['gauss'].append({'half': half, 'p': [float(v) for v in r.x[:2]] + [float(r.x[2]), float(abs(r.x[3])), float(abs(r.x[4])), float(r.x[5])], 'flux': float(2 * np.pi * r.x[2] * abs(r.x[3]) * abs(r.x[4])), 'chi2': float(2 * r.cost)})
# a Moffat star (point-sampled profile, beta = 3) with noise: 41 x 41 cutout kept in the JSON
mt = dict(x=20.31, y=19.62, amp=4000.0, gamma=3.2, beta=3.0, bg=250.0)
yy, xx = np.mgrid[0:41, 0:41]
mclean = moffat([mt['x'], mt['y'], mt['amp'], mt['gamma'], mt['beta'], mt['bg']], xx, yy)
mcut = np.round(rng.poisson(mclean) + rng.normal(0, 5, mclean.shape))
mh = 12
ys, xs = np.mgrid[20 - mh:20 + mh + 1, 20 - mh:20 + mh + 1]
r = least_squares(lambda p: (moffat(p, xs, ys) - mcut[20 - mh:20 + mh + 1, 20 - mh:20 + mh + 1]).ravel(), [20, 20, mcut.max() - mcut.min(), 3.0, 2.5, mcut.min()], method='lm', xtol=1e-14, ftol=1e-14, gtol=1e-14)
P['moffat_scene'] = {'cut': mcut.tolist(), 'x0': 20, 'y0': 20, 'half': mh, 'fit': [float(r.x[0]), float(r.x[1]), float(r.x[2]), float(abs(r.x[3])), float(r.x[4]), float(r.x[5])], 'chi2': float(2 * r.cost),
                     'truth': {**mt, 'flux': float(np.pi * mt['amp'] * mt['gamma'] ** 2 / (mt['beta'] - 1))}}
mean, med, std = sigma_clipped_stats(img, sigma=3.0)
src = DAOStarFinder(fwhm=2.355 * 2.1, threshold=5 * std)(img - med)
src.sort('flux'); src.reverse()
P['dao'] = {'median': float(med), 'std': float(std), 'x': [float(v) for v in src['xcentroid']], 'y': [float(v) for v in src['ycentroid']]}
ref['photometry'] = P

# ------------------------------------------------------------------ times, barycentric correction, airmass
T = {'dates': [], 'bjd': [], 'airmass': [], 'leap': []}
for s in ['2021-03-14T05:21:07.250', '1999-12-31T23:59:59', '2016-12-30T12:00:00.5', '2024-02-29T00:00:00', '2030-07-04T18:30:00']:
    T['dates'].append({'iso': s, 'jd': float(Time(s, format='isot', scale='utc').jd)})
for jd in [2441317.5, 2445000.5, 2451179.5, 2453736.6, 2457754.5, 2460000.5]:
    t = Time(jd, format='jd', scale='utc'); T['leap'].append({'jd': jd, 'tai_utc': float(round((t.tai.jd - t.utc.jd) * 86400, 3))})
solar_system_ephemeris.set('builtin')
geo = EarthLocation.from_geocentric(0, 0, 0, unit=u.m)
for (name, ra, dec) in [('WASP-18', 24.354311, -45.677887), ('HAT-P-7', 292.24730, 47.96950), ('ecliptic', 90.0, 23.4), ('pole', 10.0, 89.0), ('TrES-2', 286.80852, 49.31643)]:
    c = SkyCoord(ra * u.deg, dec * u.deg, frame='icrs')
    for jd in [2451545.0, 2455197.75, 2458375.169883, 2459287.722999, 2460310.5, 2461000.123, 2463000.4]:
        t = Time(jd, format='jd', scale='utc', location=geo)
        ltt = t.light_travel_time(c, kind='barycentric', ephemeris='builtin')
        T['bjd'].append({'name': name, 'ra': ra, 'dec': dec, 'jd_utc': jd, 'bjd_tdb_minus_jd_utc_s': float(((t.tdb.jd1 - t.utc.jd1) + (t.tdb.jd2 - t.utc.jd2)) * 86400 + ltt.to(u.s).value), 'tdb_minus_utc_s': float(((t.tdb.jd1 - t.utc.jd1) + (t.tdb.jd2 - t.utc.jd2)) * 86400)})
for (lat, lon) in [(32.4165, -110.7345), (-29.2563, -70.738), (51.4769, 0.0)]:
    loc = EarthLocation.from_geodetic(lon * u.deg, lat * u.deg, 0 * u.m)
    for (ra, dec) in [(97.63662, 29.67231), (24.354311, -45.677887), (292.2473, 47.9695)]:
        c = SkyCoord(ra * u.deg, dec * u.deg, frame='icrs')
        for jd in [2459287.60, 2459287.72, 2459287.85, 2460310.70, 2455197.75]:
            aa = c.transform_to(AltAz(obstime=Time(jd, format='jd', scale='utc'), location=loc))
            if aa.alt.deg > 10: T['airmass'].append({'lat': lat, 'lon': lon, 'ra': ra, 'dec': dec, 'jd': jd, 'secz': float(aa.secz), 'alt': float(aa.alt.deg)})
ref['time'] = T

# ------------------------------------------------------------------ target pixel files
def tpf_reference(path):
    with fits.open(path) as hl:
        tab, ph, th = hl[1].data, hl[0].header, hl[1].header
        flux = tab['FLUX'].astype(np.float64); ferr = tab['FLUX_ERR'].astype(np.float64); bkg = tab['FLUX_BKG'].astype(np.float64)
        ap = hl[2].data
        pm = (ap & 2) > 0
        out = {'ncad': int(len(tab)), 'shape': list(flux.shape[1:]), 'bjdrefi': int(th['BJDREFI']), 'bjdreff': float(th['BJDREFF']), 'object': ph['OBJECT'], 'telescop': ph['TELESCOP'],
               'ra_obj': float(ph['RA_OBJ']), 'dec_obj': float(ph['DEC_OBJ']), 'timedel': float(th['TIMEDEL']), 'exposure': float(th['EXPOSURE']), 'frametim': float(th['FRAMETIM']), 'num_frm': int(th['NUM_FRM']),
               'id': int(ph.get('TICID', ph.get('KEPLERID'))), 'time': [None if not np.isfinite(v) else float(v) for v in tab['TIME']], 'quality': [int(v) for v in tab['QUALITY']],
               'cadenceno_first': int(tab['CADENCENO'][0]), 'cadenceno_last': int(tab['CADENCENO'][-1]),
               'aperture': [int(v) for v in ap.ravel()], 'pipeline_npix': int(pm.sum()), 'crv_col': float(th['1CRV5P']), 'crv_row': float(th['2CRV5P'])}
        good = (tab['QUALITY'] == 0) & np.isfinite(tab['TIME']) & np.isfinite(flux[:, pm]).all(axis=1)
        out['n_good'] = int(good.sum())
        masks = {'pipeline': pm, 'pipeline1': binary_dilation(pm, iterations=1), 'pipeline2': binary_dilation(pm, iterations=2)}
        out['masks'] = {}
        yy, xx = np.mgrid[0:flux.shape[1], 0:flux.shape[2]]
        for name, m in masks.items():
            sap = flux[:, m].sum(axis=1); err = np.sqrt((ferr[:, m] ** 2).sum(axis=1))
            cx = (flux[:, m] * xx[m]).sum(axis=1) / sap; cy = (flux[:, m] * yy[m]).sum(axis=1) / sap
            g = good & np.isfinite(sap)
            t = tab['TIME'][g].astype(np.float64); f = sap[g]
            tdt = np.diff(np.sort(t)).mean()
            win = 1 + 2 * int(max(15, 0.5 / 24 / tdt))
            # EXOTIC examples/tess/tess.py check_std
            sflux = savgol_filter(f, win, 2); check_std = float(np.nanstd(f - sflux))
            idx = np.flatnonzero(g)[[0, 1, len(t) // 2, -1]]
            out['masks'][name] = {'npix': int(m.sum()), 'mask': [int(v) for v in m.ravel()], 'sap_sum_good': float(f.sum()), 'sap_median': float(np.median(f)), 'check_std': check_std, 'window': win,
                                  'sample_rows': [int(i) for i in idx], 'sample_sap': [float(sap[i]) for i in idx], 'sample_err': [float(err[i]) for i in idx], 'sample_cx': [float(cx[i]) for i in idx], 'sample_cy': [float(cy[i]) for i in idx],
                                  'sample_bkg': [float(bkg[i][m].mean()) for i in idx], 'savgol_sample': [float(sflux[j]) for j in (0, 3, len(f) // 2, len(f) - 2)]}
        return out

if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
    with fits.open(sys.argv[1]) as hl:
        t = hl[1].data['TIME']
        # one orbit of WASP-18 b centred on a transit: T0 = BJD 2458375.169883, P = 0.9414526 d (Shporer et al. 2019)
        tc = 2458375.169883 - 2457000 - 0.9414526 * 14
        i0 = int(np.nanargmin(np.abs(t - (tc - 0.486))))
        sub = fits.BinTableHDU(hl[1].data[i0:i0 + 700], header=hl[1].header)
        fits.HDUList([hl[0], sub, hl[2]]).writeto(os.path.join(D, 'tess_wasp18_s02_sub_tp.fits'), overwrite=True, checksum=False)
        ref['tess_transit_btjd'] = float(tc)
if os.path.exists(os.path.join(D, 'tess_wasp18_s02_sub_tp.fits')): ref['tess'] = tpf_reference(os.path.join(D, 'tess_wasp18_s02_sub_tp.fits'))
kname = 'kplr011446443-2009131105131_lpd-targ.fits.gz'
if len(sys.argv) > 2 and os.path.exists(sys.argv[2]): shutil.copyfile(sys.argv[2], os.path.join(D, kname))
if os.path.exists(os.path.join(D, kname)): ref['kepler'] = tpf_reference(os.path.join(D, kname))

# ------------------------------------------------------------------ Savitzky-Golay on a plain series
y = np.cumsum(rng.normal(0, 1, 300)) + 50
ref['savgol'] = {'y': [float(v) for v in y], 'win31': [float(v) for v in savgol_filter(y, 31, 2)], 'win7': [float(v) for v in savgol_filter(y, 7, 2)]}

# ------------------------------------------------------------------ Gaussian process against scikit-learn
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, ConstantKernel, WhiteKernel
n = 80
X = rng.uniform(-1, 1, (n, 2)) * [0.3, 0.2] + [5.1, 7.4]              # centroids wandering by a few tenths of a pixel
yv = 0.004 * np.sin(6 * (X[:, 0] - 5.1)) - 0.003 * (X[:, 1] - 7.4) ** 2 * 20 + rng.normal(0, 0.0008, n)
yv -= yv.mean()
Xs = rng.uniform(-1, 1, (25, 2)) * [0.3, 0.2] + [5.1, 7.4]
amp, scales, noise = 0.0035, [0.21, 0.13], 0.0009
kern = ConstantKernel(amp ** 2) * RBF(length_scale=scales) + WhiteKernel(noise ** 2)
gp = GaussianProcessRegressor(kernel=kern, optimizer=None, alpha=0.0).fit(X, yv)
mu, sd = gp.predict(Xs, return_std=True)
G = {'X': X.tolist(), 'y': yv.tolist(), 'Xs': Xs.tolist(), 'fixed': {'amp': amp, 'scales': scales, 'noise': noise, 'lnL': float(gp.log_marginal_likelihood_value_), 'mean': mu.tolist(), 'std_with_noise': sd.tolist()}}
best = None
for seed in range(6):
    k2 = ConstantKernel(yv.std() ** 2, (1e-10, 1e2)) * RBF(length_scale=[0.2, 0.2], length_scale_bounds=(1e-3, 1e2)) + WhiteKernel((0.5 * yv.std()) ** 2, (1e-12, 1e0))
    g2 = GaussianProcessRegressor(kernel=k2, n_restarts_optimizer=8, random_state=seed).fit(X, yv)
    if best is None or g2.log_marginal_likelihood_value_ > best.log_marginal_likelihood_value_: best = g2
kk = best.kernel_
G['optimised'] = {'lnL': float(best.log_marginal_likelihood_value_), 'amp': float(np.sqrt(kk.k1.k1.constant_value)), 'scales': [float(v) for v in kk.k1.k2.length_scale], 'noise': float(np.sqrt(kk.k2.noise_level)), 'mean': best.predict(Xs).tolist()}
ref['gp'] = G

with open(os.path.join(here, 'photometry_reference.json'), 'w') as f: json.dump(ref, f)
print('wrote', os.path.join(here, 'photometry_reference.json'), {k: (len(json.dumps(v)) // 1024, 'kB') for k, v in ref.items()})
for fn in sorted(os.listdir(D)): print(f'  {fn:50s} {os.path.getsize(os.path.join(D, fn)) / 1024:8.1f} kB')
