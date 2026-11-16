"""Reference for test/imexam.test.mjs: radial profiles, curves of growth, Gaussian FWHM (photutils.profiles),
Moffat fits to the same profiles (scipy curve_fit) and region statistics (astropy sigma_clipped_stats) on the
first frame of the EXOTIC HAT-P-32 b sample (test/data/hatp32_exotic_sample.fits).

Run with .venv-phot/bin/python test/make_imexam_reference.py
"""
import json
import pathlib

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from photutils.centroids import centroid_2dg
from photutils.detection import DAOStarFinder
from photutils.profiles import CurveOfGrowth, RadialProfile
from scipy.optimize import curve_fit

here = pathlib.Path(__file__).parent
with fits.open(here / 'data' / 'hatp32_exotic_sample.fits') as hdul:
    img = hdul[1].data.astype(float)
ny, nx = img.shape

mean, med, std = sigma_clipped_stats(img, sigma=3.0)
found = DAOStarFinder(fwhm=4.0, threshold=10 * std)(img - med)
found.sort('flux', reverse=True)

RMAX, BIN = 12, 1.0
stars, seen = [], []
for row in found[:8]:
    x0, y0 = float(row['xcentroid']), float(row['ycentroid'])
    if not (RMAX + 9 < x0 < nx - RMAX - 9 and RMAX + 9 < y0 < ny - RMAX - 9):
        continue
    cut = img[int(y0) - 6:int(y0) + 7, int(x0) - 6:int(x0) + 7]
    cx, cy = centroid_2dg(cut - np.median(cut))
    xc, yc = cx + int(x0) - 6, cy + int(y0) - 6
    if any(np.hypot(xc - a, yc - b) < 4 for a, b in seen):   # a second peak of the same star
        continue
    seen.append((xc, yc))
    # the same 3-sigma clipped median of the annulus pixels whose centres are inside, as photometry.js
    yy, xx = np.mgrid[0:ny, 0:nx]
    d2 = (xx - xc) ** 2 + (yy - yc) ** 2
    sel = img[(d2 >= (RMAX + 2) ** 2) & (d2 < (RMAX + 8) ** 2)]
    _, bg, _ = sigma_clipped_stats(sel, sigma=3.0, maxiters=5)
    edges = np.arange(0, RMAX + BIN / 2, BIN)
    rp = RadialProfile(img - bg, (xc, yc), edges, method='exact')
    cog = CurveOfGrowth(img - bg, (xc, yc), edges[1:], method='exact')
    moff = lambda r, a, g, b: a * (1 + r ** 2 / g ** 2) ** (-b)
    pm, _ = curve_fit(moff, rp.radius, rp.profile, p0=[rp.profile.max(), 3.0, 2.5], maxfev=20000)
    total = cog.profile[-1]
    r50 = float(np.interp(0.5 * total, cog.profile, cog.radius))
    stars.append({
        'x': float(xc), 'y': float(yc), 'background': float(bg),
        'radius': rp.radius.tolist(), 'profile': rp.profile.tolist(),
        'growthR': cog.radius.tolist(), 'growth': cog.profile.tolist(),
        'gaussianFwhm': float(rp.gaussian_fwhm), 'gaussianSigma': float(rp.gaussian_fit.stddev.value),
        'moffat': {'amp': float(pm[0]), 'gamma': float(abs(pm[1])), 'beta': float(pm[2]),
                   'fwhm': float(2 * abs(pm[1]) * np.sqrt(2 ** (1 / pm[2]) - 1))},
        'r50': r50,
    })

box = img[20:61, 30:91]                      # rows y 20..60, columns x 30..90
m, md, sd = sigma_clipped_stats(box, sigma=3.0, maxiters=5)
region = {'x0': 30, 'y0': 20, 'x1': 90, 'y1': 60, 'n': int(box.size), 'mean': float(box.mean()), 'median': float(np.median(box)),
          'std': float(box.std()), 'min': float(box.min()), 'max': float(box.max()), 'sum': float(box.sum()),
          'clipped': {'mean': float(m), 'median': float(md), 'std': float(sd)}}

out = {'source': 'photutils ' + __import__('photutils').__version__ + ', scipy curve_fit, astropy sigma_clipped_stats',
       'frame': 'hatp32_exotic_sample.fits HDU 1', 'rmax': RMAX, 'bin': BIN, 'stars': stars, 'region': region}
(here / 'imexam_reference.json').write_text(json.dumps(out, indent=1))
print(f'{len(stars)} stars; FWHM', [round(s["gaussianFwhm"], 3) for s in stars])
