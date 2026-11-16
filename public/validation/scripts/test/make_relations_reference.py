#!/usr/bin/env python
"""Independent numbers for test/relations.test.mjs, written to test/relations_reference.json.

  .venv-plan/bin/python test/make_relations_reference.py [--table EEM_dwarf_UBVIJHK_colors_Teff.txt]

Needs numpy, astropy, h5py and the `astro-forecaster` package (pip install astro-forecaster), whose
fitting_parameters.h5 is the posterior of Chen & Kipping (2017); the dwarf table is downloaded from
https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt unless a copy is given.

What each block is independent of:
  ck17    medians of the forecaster hyper-posterior (not the rounded Table 2 values that relations.js uses)
  dwarfs  the table as published, parsed here, and numpy interpolation between its rows
  physics astropy constants and units (G, M_sun, R_sun, L_sun, M_jup, R_jup, M_earth, R_earth, au, sigma_sb)
"""
import argparse, json, os, sys, urllib.request
import numpy as np
import astropy, astropy.constants as c, astropy.units as u

ap = argparse.ArgumentParser()
ap.add_argument('--table')
a = ap.parse_args()
out = {'made_with': {'astropy': astropy.__version__, 'numpy': np.__version__}}

# ---- Chen & Kipping 2017 from the forecaster posterior
import h5py, forecaster
h = h5py.File(os.path.join(os.path.dirname(forecaster.__file__), 'fitting_parameters.h5'), 'r')['hyper_posterior'][:]
m = np.median(h, axis=0)
C0, S, sig, T = m[0], m[1:5], m[5:9], m[9:12]
C = [C0]
for k in range(1, 4):
    C.append(C[k - 1] + T[k - 1] * (S[k - 1] - S[k]))
def r_of_m(M):
    x = np.log10(M); k = int(np.searchsorted(T, x))
    return float(10 ** (C[k] + S[k] * x))
masses = [0.1, 0.5, 1, 2, 3, 5, 10, 17.15, 30, 60, 95.16, 150, 317.83, 1000, 3000, 10000, 50000, 100000]
out['ck17'] = {'hyper_median': {'C': float(C0), 'S': S.tolist(), 'sigma_log10R': sig.tolist(), 'transitions_log10_Mearth': T.tolist()},
               'mass_earth': masses, 'radius_earth': [r_of_m(M) for M in masses]}

# ---- mean dwarf sequence
txt = open(a.table).read() if a.table else urllib.request.urlopen('https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt', timeout=60).read().decode()
version = [l for l in txt.splitlines() if 'Version' in l][0].strip('# ').strip()
rows = []
for l in txt.splitlines():
    p = l.split()
    if l.startswith('#') or len(p) < 30 or not p[0].endswith('V'):
        continue
    try:
        rows.append((p[0], float(p[1]), float(p[4]), float(p[6]), float(p[-2])))
    except ValueError:
        pass
rows = [r for r in rows if 2350 <= r[1] <= 10700]
teff = np.array([r[1] for r in rows]); order = np.argsort(teff)
lt = np.log10(teff[order])
q = [3000, 3300, 3500, 3850, 4200, 4700, 5000, 5300, 5772, 6000, 6300, 6800, 7500, 9000, 10500]
out['dwarfs'] = {'version': version, 'rows': rows, 'teff': q,
                 'rstar': (10 ** np.interp(np.log10(q), lt, np.log10([rows[i][3] for i in order]))).tolist(),
                 'mstar': (10 ** np.interp(np.log10(q), lt, np.log10([rows[i][4] for i in order]))).tolist(),
                 'logL': np.interp(np.log10(q), lt, [rows[i][2] for i in order]).tolist()}

# ---- physics with astropy
def a_kepler(M, P):       # Msun, days -> au
    return float(((c.G * M * u.Msun * (P * u.day) ** 2 / (4 * np.pi ** 2)) ** (1 / 3)).to(u.au).value)
def K(mp, ms, P, e=0, inc=90):   # Mjup, Msun, days -> m/s
    mp = mp * u.Mjup; ms = ms * u.Msun
    return float(((2 * np.pi * c.G / (P * u.day)) ** (1 / 3) * mp * np.sin(np.radians(inc)) / (ms + mp) ** (2 / 3) / np.sqrt(1 - e ** 2)).to(u.m / u.s).value)
def lum(R, T):
    return float((4 * np.pi * (R * u.Rsun) ** 2 * c.sigma_sb * (T * u.K) ** 4).to(u.Lsun).value)
def t14(P, ars, k, b, e=0, w=0):
    fac = (1 - e ** 2) / (1 + e * np.sin(np.radians(w)))
    cosi = b / (ars * fac); sini = np.sqrt(1 - cosi ** 2)
    return float(P / np.pi * np.arcsin(np.sqrt((1 + k) ** 2 - b ** 2) / (ars * sini)) * np.sqrt(1 - e ** 2) / (1 + e * np.sin(np.radians(w))))
aE = a_kepler(1 + (1 * u.Mearth).to(u.Msun).value, 365.256363)
out['physics'] = {
    'rjup_rearth': float((1 * u.Rjup).to(u.Rearth).value), 'mjup_mearth': float((1 * u.Mjup).to(u.Mearth).value),
    'a_earth_au': aE, 'a_hj_au': a_kepler(1.2, 3.0), 'ars_hj': float((a_kepler(1.2, 3.0) * u.au / (1.3 * u.Rsun)).decompose().value),
    'K_jupiter': K(1, 1, 4332.59, 0.0489), 'K_earth': K((1 * u.Mearth).to(u.Mjup).value, 1, 365.256363, 0.0167), 'K_hj_inclined': K(0.7, 1.2, 3.0, 0.1, 85),
    'lum_sun': lum(1, 5772), 'lum_k': lum(0.7, 4500), 'insol_hj': lum(1.3, 6200) / a_kepler(1.2, 3.0) ** 2,
    # Teq = Teff sqrt(R*/2a) for A = 0; the Earth with A = 0.3 (the textbook 255 K)
    'teq_earth_A0': float(5772 * np.sqrt((1 * u.Rsun / (2 * u.au)).decompose().value)),
    'teq_earth_A03': float(5772 * np.sqrt((1 * u.Rsun / (2 * u.au)).decompose().value) * 0.7 ** 0.25),
    'rprs_jup_sun': float((1 * u.Rjup / u.Rsun).decompose().value),
    'mass_logg': float((10 ** 4.3 * u.cm / u.s ** 2 * (1.2 * u.Rsun) ** 2 / c.G).to(u.Msun).value),
    'logg_sun': float(np.log10((c.G * u.Msun / u.Rsun ** 2).to(u.cm / u.s ** 2).value)),
    't14_circ': t14(3.0, 8.753571710059788, 0.1, 0.45812654598716124), 't14_ecc': t14(10.0, 20.0, 0.08, 0.3, 0.3, 60.0),
    'density_jupiter': float((1 * u.Mjup / (4 / 3 * np.pi * (1 * u.Rjup) ** 3)).to(u.g / u.cm ** 3).value),
}
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'relations_reference.json'), 'w'), indent=1)
print('wrote relations_reference.json:', version, len(rows), 'dwarf rows;', 'CK17 medians', np.round(m, 4).tolist())
