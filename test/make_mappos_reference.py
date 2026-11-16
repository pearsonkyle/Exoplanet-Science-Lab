# Independent reference for the positivity test of eclipse maps (src/core/phasecurve.js mapMinimum), written to
# test/mappos_reference.json.
#
#   .venv/bin/python test/make_mappos_reference.py
#
# Random maps of degree 1, 2 and 3, I / I0 = 1 + sum y_lm Y_lm with the real harmonics of MAP_BASIS written out from their
# formulas (x east, y north, z toward the star), are evaluated on a 0.25 degree latitude-longitude grid of the whole
# sphere; the lowest grid point is polished with scipy's Nelder-Mead in (lat, lon). Shares nothing with the JavaScript
# (no tensors, no eigenvectors, no secular equation).
import json, math, os
import numpy as np
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(42)
S3, S5, S7, S15, S105 = map(math.sqrt, (3, 5, 7, 15, 105)); S21_8, S35_8 = math.sqrt(21 / 8), math.sqrt(35 / 8)
BASIS = {
    'y1m1': lambda x, y, z: S3 * y, 'y10': lambda x, y, z: S3 * z, 'y11': lambda x, y, z: S3 * x,
    'y2m2': lambda x, y, z: S15 * x * y, 'y2m1': lambda x, y, z: S15 * y * z, 'y20': lambda x, y, z: 0.5 * S5 * (2 * z * z - x * x - y * y),
    'y21': lambda x, y, z: S15 * x * z, 'y22': lambda x, y, z: 0.5 * S15 * (x * x - y * y),
    'y3m3': lambda x, y, z: S35_8 * (3 * x * x - y * y) * y, 'y3m2': lambda x, y, z: S105 * x * y * z,
    'y3m1': lambda x, y, z: S21_8 * y * (4 * z * z - x * x - y * y), 'y30': lambda x, y, z: 0.5 * S7 * z * (2 * z * z - 3 * x * x - 3 * y * y),
    'y31': lambda x, y, z: S21_8 * x * (4 * z * z - x * x - y * y), 'y32': lambda x, y, z: 0.5 * S105 * (x * x - y * y) * z,
    'y33': lambda x, y, z: S35_8 * (x * x - 3 * y * y) * x,
}
DEG = {k: int(k[1]) for k in BASIS}


def intensity(c, la, lo):
    x, y, z = np.cos(la) * np.sin(lo), np.sin(la), np.cos(la) * np.cos(lo)
    return 1 + sum(v * BASIS[k](x, y, z) for k, v in c.items())


la = np.radians(np.linspace(-90, 90, 721)); lo = np.radians(np.linspace(-180, 180, 1441))
LA, LO = np.meshgrid(la, lo, indexing='ij')
cases = []
for lmax in (1, 2, 3):
    for i in range(40):
        sc = rng.uniform(0.1, 0.8)
        c = {k: float(rng.normal(0, sc / (1 + DEG[k]))) for k in BASIS if DEG[k] <= lmax}
        g = intensity(c, LA, LO); j = np.unravel_index(np.argmin(g), g.shape)
        r = minimize(lambda p: intensity(c, p[0], p[1]), [la[j[0]], lo[j[1]]], method='Nelder-Mead', options=dict(xatol=1e-12, fatol=1e-14, maxiter=4000))
        cases.append(dict(lmax=lmax, y=c, min=float(min(r.fun, g.min())), grid_min=float(g.min())))
json.dump(dict(cases=cases), open(os.path.join(HERE, 'mappos_reference.json'), 'w'), indent=1)
print('wrote', len(cases), 'maps;', sum(1 for c in cases if c['min'] < 0), 'negative somewhere')
