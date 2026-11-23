"""Reference values for test/sed.test.mjs.

    .venv-sed/bin/python test/make_sed_reference.py        (dust_extinction, astropy, numpy)

The Fitzpatrick (1999) extinction curve from the dust_extinction package (Gordon 2024, JOSS 9, 7023) at 40 wavelengths
and three values of R_V; the passbands' pivot wavelengths and Vega zero points as the SVO service gives them. Writes test/sed_reference.json.
"""
import json, os
import numpy as np, astropy.units as u, dust_extinction
from dust_extinction.parameter_averages import F99

wl = np.exp(np.linspace(np.log(0.12), np.log(3.3), 40))
out = dict(extinction=dict(source='dust_extinction ' + dust_extinction.__version__ + ', F99', wl=[float(v) for v in wl], a_over_av={str(rv): [float(v) for v in F99(Rv=rv)(wl * u.micron)] for rv in (2.5, 3.1, 4.5)}))
# pivot wavelengths as the SVO Filter Profile Service states them, from the files in data-src/svo (the shipped curves are
# thinned to 90 points: this checks them)
import glob, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out['pivots'] = {}
for f in sorted(glob.glob(os.path.join(root, 'data-src', 'svo', '*.xml'))):
    t = open(f).read(); par = lambda n: re.search(r'<PARAM name="%s"[^>]*value="([^"]*)"' % n, t)
    if par('WavelengthPivot'): out['pivots'][os.path.basename(f)[:-4].replace('_', '/', 1)] = dict(pivot=float(par('WavelengthPivot').group(1)) * 1e-4, zp_vega=float(par('ZeroPoint').group(1)))
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sed_reference.json')
json.dump(out, open(path, 'w'), indent=1); print('wrote', path)

_trapz = getattr(np, 'trapezoid', None) or np.trapz

# ---- synthetic magnitudes straight from the PHOENIX intensity files and the full passband curves ---------------------
# (no binning to 420 points, no thinning of the passbands, numpy only: an independent path to the same numbers)
try:
    from astropy.io import fits
    C_UM = 2.99792458e14
    def band(path):
        t = open(path).read(); par = lambda n: re.search(r'<PARAM name="%s"[^>]*value="([^"]*)"' % n, t).group(1)
        rows = np.array([[float(v) for v in re.findall(r'<TD>([^<]*)</TD>', r)] for r in re.findall(r'<TR>(.*?)</TR>', t, re.S)])
        return rows[:, 0] * 1e-4, np.maximum(rows[:, 1], 0), par('DetectorType') == '1', float(par('ZeroPoint'))
    mags = []
    for teff, logg in ((5800, 4.5), (4900, 4.5), (3400, 5.0), (6200, 4.5)):
        f = os.path.expanduser('~/.ldtk/cache_visir-lowres/Z-0.0/lte%05d-%.2f-0.0.PHOENIX-ACES-AGSS-COND-2011-SpecInt.fits' % (teff, logg))
        with fits.open(f) as h:
            hd = h[0].header; wl = (hd['CRVAL1'] + np.arange(hd['NAXIS1']) * hd['CDELT1']) * 1e-4; I = np.array(h[0].data, float); mu = np.array(h[1].data, float)
        mu0 = np.concatenate([[0.0], mu]); F = 2 * np.pi * _trapz(np.vstack([np.zeros(I.shape[1]), I]) * mu0[:, None], mu0, axis=0) * 1e-7   # W m^-2 micron^-1
        row = dict(teff=teff, logg=logg, mag={})
        for name, key in (('Gaia BP', 'GAIA_GAIA3.Gbp'), ('Gaia G', 'GAIA_GAIA3.G'), ('Gaia RP', 'GAIA_GAIA3.Grp'), ('Tycho BT', 'TYCHO_TYCHO.B'), ('Tycho VT', 'TYCHO_TYCHO.V'), ('2MASS J', '2MASS_2MASS.J'), ('2MASS H', '2MASS_2MASS.H'), ('2MASS Ks', '2MASS_2MASS.Ks'), ('WISE W1', 'WISE_WISE.W1')):
            bw, R, photon, zp = band(os.path.join(root, 'data-src', 'svo', key + '.xml'))
            x = np.linspace(bw[0], bw[-1], 4000); Rx = np.interp(x, bw, R); Fx = np.interp(x, wl, F); p = 1 if photon else 0
            flam = _trapz(Fx * Rx * x ** p, x) / _trapz(Rx * x ** p, x); piv2 = _trapz(Rx * x ** p, x) / _trapz(Rx * x ** (p - 2), x)
            row['mag'][name] = float(-2.5 * np.log10(flam * piv2 / C_UM * 1e26 / zp))    # at the stellar surface (theta = 2 rad)
        mags.append(row)
    out['surface_magnitudes'] = mags
    json.dump(out, open(path, 'w'), indent=1); print('surface magnitudes of', len(mags), 'models added')
except Exception as e:
    print('surface magnitudes skipped:', e)
