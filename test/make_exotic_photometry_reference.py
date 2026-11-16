# Reference for test/exotic_photometry.test.mjs: what EXOTIC did on its sample data (from test/exotic_record.py),
# cut-outs of every third frame around the three stars, and photutils values for elliptical apertures.
#   .venv-phot/bin/python test/make_exotic_photometry_reference.py
# Needs /tmp/esl_exotic_run/{rec.npz, rec.json, out/} and the unzipped sample data in /tmp/esl_exotic_sample.
# Writes test/exotic_photometry_reference.json and test/data/hatp32_exotic_sample.fits (tile-compressed cut-outs).
import json, glob, os, sys, numpy as np
from astropy.io import fits
import astropy, photutils
from photutils.aperture import EllipticalAperture, CircularAperture
HERE = os.path.dirname(os.path.abspath(__file__)); RUN = '/tmp/esl_exotic_run'
SAMPLE = '/tmp/esl_exotic_sample/EXOTIC_sampledata-1.0.0/HatP32Dec202017'
rec = np.load(f'{RUN}/rec.npz'); J = json.load(open(f'{RUN}/rec.json'))
cen = rec['centroid'][1:].reshape(142, 3, -1)      # [star, guess x, guess y, x, y, amp, sx, sy, rot, bg, gauss x, gauss y]
ap = rec['aper'].reshape(142, 20, 19, 3, 7)        # [star, xc, yc, r, dr, flux, bg]
apers = ap[0, :, 0, 0, 3]; annuli = ap[0, 0, :, 0, 4]
# EXOTIC's frame order: sorted by its BJD times
def exotic_jd(h):
    from astropy.time import Time; import dateutil.parser as dup
    return Time(dup.parse(h['UT-OBS'])).jd + (h['EXPTIME'] / 172800 if 'start' in h.comments['UT-OBS'] else 0)
files = sorted(glob.glob(f'{SAMPLE}/*.FITS')); jds = [exotic_jd(fits.getheader(f)) for f in files]
order = np.argsort(jds); files = [files[i] for i in order]
assert np.allclose(np.array(jds)[order], J['inputs']['jd'], atol=1e-7), 'frame order differs from EXOTIC'
r6 = lambda a: np.round(np.asarray(a, float), 6).tolist()
# ---- cut-outs: every third frame, a window that follows the target in steps of 8 px (so drift and jumps remain)
W, H, TX, TY = 152, 166, 31, 134
sel = list(range(0, 142, 3)); hdus = [fits.PrimaryHDU()]; offs = []
hdus[0].header['COMMENT'] = 'Cut-outs of EXOTIC sample data (HAT-P-32 b, MicroObservatory, 2017-12-20): every third frame,'
hdus[0].header['COMMENT'] = f'{W}x{H} px window following the target in steps of 8 px. CROPX0/CROPY0: window origin in the full frame.'
for i in sel:
    d, h = fits.getdata(files[i], header=True)
    ox = int(8 * round((cen[i, 0, 10] - TX) / 8)); oy = int(8 * round((cen[i, 0, 11] - TY) / 8))
    assert ox >= 0 and oy >= 0 and ox + W <= d.shape[1] and oy + H <= d.shape[0], (i, ox, oy)
    for s in range(3):       # every pixel EXOTIC and this code touch must be inside the window
        x, y = cen[i, s, 10] - ox, cen[i, s, 11] - oy
        assert 26 < x < W - 27 and 26 < y < H - 27, (i, s, x, y)
    h['CROPX0'] = (ox, 'x of the window origin in the full frame'); h['CROPY0'] = (oy, 'y of the window origin in the full frame')
    h['EXTNAME'] = os.path.basename(files[i])[:60]
    c = fits.CompImageHDU(np.ascontiguousarray(d[oy:oy + H, ox:ox + W]), header=h, compression_type='RICE_1')
    hdus.append(c); offs.append([ox, oy])
out = f'{HERE}/data/hatp32_exotic_sample.fits'; fits.HDUList(hdus).writeto(out, overwrite=True)
# ---- elliptical apertures: photutils 'exact' on a deterministic image
yy, xx = np.mgrid[0:48, 0:64]; img = 100 + 30 * np.sin(0.37 * xx + 0.11 * yy * yy / 48) + 20 * np.cos(0.23 * yy - 0.05 * xx) + 500 * np.exp(-((xx - 30.3) ** 2 + (yy - 22.6) ** 2) / 8)
ell = []
for (x, y, a, b, th) in [(30.3, 22.6, 5.0, 3.0, 0.4), (30.3, 22.6, 3.0, 5.0, -1.1), (20.25, 30.75, 7.3, 1.2, 2.0), (41.5, 12.5, 2.0, 2.0, 0.7), (33.0, 24.0, 0.6, 0.4, 0.3), (10.1, 10.9, 9.5, 8.0, 3.0), (30.0, 22.0, 4.0, 2.5, 0.0), (30.5, 22.5, 4.0, 2.5, np.pi / 2)]:
    e = EllipticalAperture((x, y), a, b, theta=th); m = e.to_mask(method='exact')
    ell.append({'x': x, 'y': y, 'a': a, 'b': b, 'theta': th, 'sum': float((m.data * m.cutout(img)).sum()), 'area': float(m.data.sum())})
# ---- EXOTIC's table: residual scatter of every candidate, in EXOTIC's order
fitsl = J['fits']; std = np.array([f['std'] if f else np.nan for f in fitsl])
grid = std[2:].reshape(20, 19, 3)                    # [aperture, annulus, (no comparison, comp 1, comp 2)]
ib = int(np.nanargmin(std)); bi = np.unravel_index(ib - 2, (20, 19, 3))
keep_combos = [[int(bi[0]), int(bi[1])], [9, 9], [0, 0], [19, 18], [9, 7]]
final = np.loadtxt(f'{RUN}/out/temp/FinalLightCurve_HAT-P-32 b_17-December-2017.csv', delimiter=',', comments='#')
ref = {
    'generator': f'test/make_exotic_photometry_reference.py: EXOTIC (owner working copy) run by test/exotic_record.py on EXOTIC_sampledata-1.0.0; astropy {astropy.__version__}, photutils {photutils.__version__}, numpy {np.__version__}',
    'stars': [[424, 286], [465, 183], [512, 263]], 'site': {'lat': 32.41638889, 'lon': -110.73444444},
    'planet': {k: J['inputs']['pDict'][k] for k in ['ra', 'dec', 'pPer', 'pPerUnc', 'midT', 'midTUnc', 'rprs', 'aRs', 'inc', 'omega', 'ecc']}, 'ld': J['inputs']['ld'],
    'apers': apers.tolist(), 'annuli': annuli.tolist(), 'sigma': float(apers[0] / 1.5),
    'bjd': J['inputs']['times'], 'jd': J['inputs']['jd'], 'airmass': J['inputs']['airmass'],
    'sel': sel, 'offsets': offs, 'cutout': {'file': 'data/hatp32_exotic_sample.fits', 'width': W, 'height': H},
    # per frame and star, for all 142 frames: EXOTIC's centroid (the flux-weighted one it uses), the centre of its Gaussian fit, the fit [amp, sx, sy, rot, bg], its starting guess
    'centroid': r6(cen[:, :, 3:5]), 'gauss': r6(cen[:, :, 10:12]), 'psf': r6(cen[:, :, 5:10]), 'guess': r6(cen[:, :, 1:3]),
    # aperture photometry for a few (aperture, annulus) combinations, all frames and stars: flux (sky-subtracted sum) and sky per pixel
    'combos': keep_combos, 'flux': {f'{a},{n}': r6(ap[:, a, n, :, 5]) for a, n in keep_combos}, 'bg': {f'{a},{n}': r6(ap[:, a, n, :, 6]) for a, n in keep_combos},
    'scatterGrid': np.round(grid, 7).tolist(), 'scatterPsf': std[:2].tolist(),
    'best': {'index': ib, 'aperture': float(apers[bi[0]]), 'annulus': float(annuli[bi[1]]), 'ia': int(bi[0]), 'in': int(bi[1]), 'comp': int(bi[2]), 'std': float(std[ib]), 'lm': fitsl[ib]['pars'], 'n': fitsl[ib]['n']},
    'lmFits': {f'{a},{n}': [fitsl[2 + (a * 19 + n) * 3 + c] for c in range(3)] for a, n in keep_combos},
    'bounds': J['last']['bounds'], 'fitMs': float(np.mean([f['ms'] for f in fitsl if f])),
    'tform': [[t[1], t[2], t[3], t[4]] for t in J['tform']],
    'final': {'bjd': final[:, 0].tolist(), 'flux': final[:, 2].tolist(), 'err': final[:, 3].tolist(), 'model': final[:, 4].tolist(), 'airmass': final[:, 5].tolist(),
              'nested': {'tmid': [2458107.7136, 0.00093], 'rprs': [0.1569, 0.0034], 'inc': [88.2, 0.99], 'a1': [1.1654, 0.0067], 'a2': [-0.1204, 0.0024], 'scatter': 0.0057, 'duration': [0.1303, 0.0013]}},
    'ellipse': {'image': '100 + 30 sin(0.37 x + 0.11 y^2 / 48) + 20 cos(0.23 y - 0.05 x) + 500 exp(-((x - 30.3)^2 + (y - 22.6)^2) / 8), 64 x 48', 'cases': ell},
}
json.dump(ref, open(f'{HERE}/exotic_photometry_reference.json', 'w'), separators=(',', ':'))
print('cut-outs', os.path.getsize(out), 'bytes;', 'reference', os.path.getsize(f'{HERE}/exotic_photometry_reference.json'), 'bytes; EXOTIC best', ref['best'])
