"""Reference values for test/haze.test.mjs: Mie efficiencies from scipy's spherical Bessel functions.

    .venv/bin/python test/make_haze_reference.py

a_n and b_n are written with the Riccati-Bessel functions psi_n(z) = z j_n(z) and xi_n(z) = z h_n(z) themselves
(Bohren & Huffman 1983, eq. 4.53), evaluated by scipy for real and complex arguments: no recurrence is shared with
src/core/mie.js. Also bin means of the nitrogen collision-induced absorption read straight from the HITRAN files
(data-src/hitran-cia), for the shipped tables to be compared with. Writes test/haze_reference.json.
"""
import json, os
import numpy as np
from scipy.special import spherical_jn, spherical_yn


def mie(x, m):
    nmax = int(x + 4 * x ** (1 / 3) + 2) + 5
    n = np.arange(1, nmax + 1)
    psi = lambda z: z * spherical_jn(n, z)
    dpsi = lambda z: spherical_jn(n, z) + z * spherical_jn(n, z, derivative=True)
    xi = lambda z: z * (spherical_jn(n, z) + 1j * spherical_yn(n, z))
    dxi = lambda z: (spherical_jn(n, z) + 1j * spherical_yn(n, z)) + z * (spherical_jn(n, z, derivative=True) + 1j * spherical_yn(n, z, derivative=True))
    mx = m * x
    a = (m * psi(mx) * dpsi(x) - psi(x) * dpsi(mx)) / (m * psi(mx) * dxi(x) - xi(x) * dpsi(mx))
    b = (psi(mx) * dpsi(x) - m * psi(x) * dpsi(mx)) / (psi(mx) * dxi(x) - m * xi(x) * dpsi(mx))
    qext = 2 / x ** 2 * np.sum((2 * n + 1) * (a + b).real)
    qsca = 2 / x ** 2 * np.sum((2 * n + 1) * (abs(a) ** 2 + abs(b) ** 2))
    g = 4 / (x ** 2 * qsca) * (np.sum(n[:-1] * (n[:-1] + 2) / (n[:-1] + 1) * (a[:-1] * np.conj(a[1:]) + b[:-1] * np.conj(b[1:])).real) + np.sum((2 * n + 1) / (n * (n + 1)) * (a * np.conj(b)).real))
    return float(qext), float(qsca), float(g)


cases = []
for x in (0.05, 0.3, 1.0, 3.0, 10.0, 30.0):
    for m in (1.33 + 0j, 1.5 + 0.01j, 1.7 + 0.1j, 1.65 + 0.004j, 2.0 + 1.0j):
        q = mie(x, m)
        cases.append(dict(x=x, n=m.real, k=m.imag, qext=q[0], qsca=q[1], g=q[2]))


# ---- collision-induced absorption of nitrogen: bin means straight from the HITRAN files --------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cia_blocks(name):
    blocks = []
    with open(os.path.join(ROOT, 'data-src', 'hitran-cia', name)) as f:
        while True:
            head = f.readline()
            if not head: break
            n, T = int(head[40:47]), float(head[47:54])
            blocks.append((T, np.loadtxt([f.readline() for _ in range(n)])))
    return blocks


def cia_mean(blocks, T, lo, hi):
    """Mean over a wavelength bin [lo, hi] micron (uniform in log wavelength, 400 points) at temperature T, from the
    blocks that cover the bin: linear in T between the two nearest that do."""
    wn = 1e4 / np.exp(np.linspace(np.log(lo), np.log(hi), 400))
    cover = sorted([(t, b) for t, b in blocks if b[0, 0] <= wn.min() and b[-1, 0] >= wn.max()], key=lambda x: x[0])
    ts = np.array([t for t, _ in cover]); vals = np.array([np.interp(wn, b[:, 0], np.maximum(b[:, 1], 0)).mean() for _, b in cover])
    return float(np.interp(T, ts, vals))


head = json.load(open(os.path.join(ROOT, 'public', 'opacity', 'index.json')))
with open(os.path.join(ROOT, 'public', 'opacity', 'N2-N2.eslo'), 'rb') as f:
    f.seek(8); g = json.loads(f.read(int.from_bytes(f.read(4), 'little')))['wl']
edges = g['min'] * np.exp(np.log(g['max'] / g['min']) * np.arange(g['n'] + 1) / g['n'])
cia = []
for pair, fname, spots in (('N2-N2', 'N2-N2_2021.cia', [(100, 45.0), (100, 30.0), (200, 30.0), (300, 25.0), (300, 4.3), (250, 4.15), (300, 2.15)]),
                           ('N2-CH4', 'N2-CH4_2024.cia', [(90, 45.0), (150, 30.0), (150, 15.0), (300, 20.0)]),
                           ('N2-H2', 'N2-H2_2024.cia', [(111.3, 30.0), (239.8, 17.0), (239.8, 8.0)])):
    blocks = cia_blocks(fname)
    for T, wl in spots:
        i = int(np.searchsorted(edges, wl) - 1)
        cia.append(dict(pair=pair, file=fname, t=T, bin=i, lo=float(edges[i]), hi=float(edges[i + 1]), k=cia_mean(blocks, T, edges[i], edges[i + 1])))
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'haze_reference.json')
import scipy
json.dump(dict(mie=dict(source='scipy ' + scipy.__version__ + ' spherical_jn, spherical_yn', cases=cases), cia=cia), open(out, 'w'), indent=1)
print(len(cases), 'Mie cases,', len(cia), 'CIA bin means ->', out)
