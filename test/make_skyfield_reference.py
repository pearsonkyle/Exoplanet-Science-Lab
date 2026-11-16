"""Reference for test/skyfield.test.mjs (src/core/skyfield.js, the geometry of the Observe page's survey image).

Run with .venv-sky/bin/python (astropy 6). For each field (tangent point, pixel scale, cell size, cell offset) the
cell's FITS WCS is built here the way the module documents it (CRVAL = the target, CRPIX1 = (N + 1) / 2 - cu,
CRPIX2 = (N + 1) / 2 + cv, CDELT1 = -scale, CDELT2 = +scale, RA---TAN / DEC--TAN) and astropy.wcs maps random sky
positions to pixels and pixels to the sky. The image rows run top-down, so the JavaScript row is NAXIS2 - 1 - y.
Separations and position angles of random pairs come from astropy.coordinates.SkyCoord (Vincenty formula).
Writes test/skyfield_reference.json.
"""
import json
from pathlib import Path
import numpy as np
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
import astropy.units as u

HERE = Path(__file__).parent
rng = np.random.default_rng(20261116)

FIELDS = [  # name, ra0, dec0, scale arcsec/px, N, cell (i, j)
    ('HAT-P-32', 31.04273, 46.68784, 1.8, 512, (0, 0)),
    ('HAT-P-32 east cell', 31.04273, 46.68784, 1.8, 512, (1, 0)),
    ('WASP-12 north-west cell', 97.63664, 29.67229, 0.9, 400, (-1, 1)),
    ('RA wrap', 359.9, -12.5, 2.5, 512, (1, -1)),
    ('near the pole', 37.95, 89.26, 1.2, 512, (2, 1)),
    ('far south', 266.4, -80.1, 3.6, 300, (0, -2)),
]


def cell_wcs(ra0, dec0, scale, N, i, j):
    cu, cv = -i * N, -j * N
    w = WCS(naxis=2)
    w.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [(N + 1) / 2 - cu, (N + 1) / 2 + cv]
    w.wcs.cdelt = [-scale / 3600, scale / 3600]
    w.wcs.radesys = 'ICRS'
    return w


out = {'fields': [], 'pairs': []}
for name, ra0, dec0, scale, N, (i, j) in FIELDS:
    w = cell_wcs(ra0, dec0, scale, N, i, j)
    # pixels over the cell (and a little outside) -> sky
    pix = rng.uniform(-0.2 * N, 1.2 * N, size=(40, 2))
    x, y = pix[:, 0], N - 1 - pix[:, 1]           # column, and FITS y (0-based) of a top-down row
    ra, dec = w.wcs_pix2world(x, y, 0)
    # sky -> pixels: positions scattered over the cell
    sra, sdec = ra + rng.normal(0, 1e-4, ra.size), dec + rng.normal(0, 1e-4, dec.size)
    px, py = w.wcs_world2pix(sra, sdec, 0)
    out['fields'].append({
        'name': name, 'ra0': ra0, 'dec0': dec0, 'scale': scale, 'N': N, 'i': i, 'j': j,
        'pix_to_sky': [[float(c), float(r), float(a % 360), float(d)] for (c, r), a, d in zip(pix, ra, dec)],
        'sky_to_pix': [[float(a % 360), float(d), float(c), float(N - 1 - yy)] for a, d, c, yy in zip(sra, sdec, px, py)],
    })

for k in range(60):
    ra1, dec1 = rng.uniform(0, 360), np.degrees(np.arcsin(rng.uniform(-1, 1)))
    if k < 20: sep = rng.uniform(0.5, 60) / 3600          # arcsec scales
    elif k < 45: sep = rng.uniform(1, 60) / 60            # arcmin scales
    else: sep = rng.uniform(1, 170)                       # degrees
    pa = rng.uniform(0, 360)
    c1 = SkyCoord(ra1 * u.deg, dec1 * u.deg)
    c2 = c1.directional_offset_by(pa * u.deg, sep * u.deg)
    out['pairs'].append({'ra1': ra1, 'dec1': dec1, 'ra2': float(c2.ra.deg), 'dec2': float(c2.dec.deg),
                         'sep_arcsec': float(c1.separation(c2).arcsec), 'pa_deg': float(c1.position_angle(c2).deg % 360)})

(HERE / 'skyfield_reference.json').write_text(json.dumps(out, indent=1))
print('wrote', HERE / 'skyfield_reference.json', len(out['fields']), 'fields,', len(out['pairs']), 'pairs')
