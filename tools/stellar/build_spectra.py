#!/usr/bin/env python
"""Stellar surface fluxes for src/core/stellarspec.js, from the PHOENIX-ACES specific intensities the limb darkening
table is built from (Husser et al. 2013; the 5 nm "visir-lowres" files in LDTK's cache, ~/.ldtk; tools/build_ld_table.py
fetches them).

    .venv-rt/bin/python tools/stellar/build_spectra.py          writes public/stellar/phoenix.esls

For every model the flux leaving the surface is the intensity integrated over the disc, F = 2 pi int I(mu) mu dmu
(trapezoid rule on the file's own 78 mu points, with I = 0 at mu = 0), and is put on 420 bins evenly spaced in log
wavelength from 0.1 to 5.5 micron, conserving the flux in each bin. Stored as log10 of W m^-2 micron^-1, 16 bits.
File: 'ESLS', uint32 version, uint32 header length, JSON header, uint16 values in the order feh, logg, teff, wl
(0 = no model at that node).
"""
import glob, json, os, re, struct, sys
import numpy as np
from astropy.io import fits

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.expanduser('~/.ldtk/cache_visir-lowres')
N, LO, HI = 420, 0.1, 5.5
edges = LO * (HI / LO) ** (np.arange(N + 1) / N)

nodes = {}
for f in glob.glob(os.path.join(SRC, 'Z*', '*.fits')):
    m = re.search(r'lte(\d{5})-(\d\.\d\d)([+-]\d\.\d)', os.path.basename(f))
    nodes[(float(m.group(3)), float(m.group(2)), int(m.group(1)))] = f
feh = sorted({k[0] for k in nodes}); logg = sorted({k[1] for k in nodes}); teff = sorted({k[2] for k in nodes})
out = np.full((len(feh), len(logg), len(teff), N), -np.inf)
check = []
for (z, g, t), f in sorted(nodes.items()):
    with fits.open(f) as h:
        hd = h[0].header
        wl = (hd['CRVAL1'] + np.arange(hd['NAXIS1']) * hd['CDELT1']) * 1e-4          # micron
        I = np.array(h[0].data, float); mu = np.array(h[1].data, float)             # erg s^-1 cm^-2 cm^-1 sr^-1
    mu0 = np.concatenate([[0.0], mu]); I0 = np.vstack([np.zeros(I.shape[1]), I])
    F = 2 * np.pi * np.trapezoid(I0 * mu0[:, None], mu0, axis=0) * 1e-7 * 1e4 * 1e-4   # W m^-2 micron^-1  (erg->J, cm^-2->m^-2, per cm -> per micron)
    cum = np.concatenate([[0.0], np.cumsum(0.5 * (F[1:] + F[:-1]) * np.diff(wl))])     # int F dwl from wl[0]
    binned = np.diff(np.interp(edges, wl, cum)) / np.diff(edges)
    out[feh.index(z), logg.index(g), teff.index(t)] = np.log10(np.maximum(binned, 1e-300))
    check.append(np.sum(binned * np.diff(edges)) / (5.670374419e-8 * t ** 4))
fin = np.isfinite(out); lo, hi = float(out[fin].min()), float(out[fin].max()); lo = max(lo, hi - 30)
code = np.zeros(out.shape, np.uint16); code[fin] = 1 + np.round((np.clip(out[fin], lo, hi) - lo) / (hi - lo) * 65534).astype(np.uint16)
header = dict(kind='stellar-flux', source='PHOENIX-ACES specific intensities (Husser et al. 2013, A&A 553, A6), integrated over the disc; tools/stellar/build_spectra.py', doi='10.1051/0004-6361/201219058',
              units='log10 W m^-2 micron^-1 at the stellar surface', teff=teff, logg=logg, feh=feh, wl=dict(min=LO, max=HI, n=N), encoding=dict(type='u16', lo=lo, hi=hi), order='feh,logg,teff,wl', models=len(nodes))
js = json.dumps(header)
while (12 + len(js)) % 2: js += ' '
path = os.path.join(ROOT, 'public', 'stellar', 'phoenix.esls')
with open(path, 'wb') as f:
    f.write(struct.pack('<III', 0x534c5345, 1, len(js))); f.write(js.encode()); f.write(code.tobytes())
print(f'{len(nodes)} models of {len(feh) * len(logg) * len(teff)} nodes; Teff {teff[0]}-{teff[-1]} ({len(teff)}), log g {logg}, [Fe/H] {feh}; {os.path.getsize(path) / 1e6:.2f} MB')
print(f'flux in 0.1-5.5 micron over sigma T^4: {min(check):.3f} to {max(check):.3f}')
