# Reference for src/core/aliases.js (period aliases of a planet seen in a few transits), written to test/alias_reference.json.
#
#   .venv/bin/python test/make_alias_reference.py [path to EXOTIC/examples/toi-3planet/output/toi_1873]
#
# Reads (never writes) the owner's TOI-1873 TESS time series, 2-minute and FFI products, and stores
#   1. the coverage as runs of regularly spaced cadences (the cadence of a sector is the median spacing within it, as in
#      toi1873_extract.py stage_alias_scan);
#   2. EXOTIC's alias scan re-run here on the full cadences with its own rule (numpy transcription of stage_alias_scan):
#      P = 900.1885 / N, T14 at i = 90 from Kepler's law, a predicted transit is covered when the summed cadence inside
#      [x - T14/2, x + T14/2] exceeds half of T14, and missed when covered and more than 0.1 d from every observed transit;
#   3. the result stored by EXOTIC itself (output/toi_1873/toi1873_alias_scan.json), for comparison.
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else '/Users/kpearson/Programs/science/exoplanet/EXOTIC/examples/toi-3planet/output/toi_1873'
G, MSUN, RSUN = 6.6743e-11, 1.988409870698051e30, 6.957e8   # astropy values, as toi1873_extract.py uses

parts = []
for suf in ('', '_ffi'):
    z = np.load(os.path.join(SRC, f'toi1873_timeseries{suf}.npz'))
    parts.append((np.asarray(z['time'], float), np.asarray(z['sector'])))
t = np.concatenate([a for a, _ in parts]); sec = np.concatenate([b for _, b in parts])
o = np.argsort(t); t, sec = t[o], sec[o]
cad = np.zeros_like(t)
for sv in np.unique(sec):
    m = sec == sv
    cad[m] = np.median(np.diff(np.sort(t[m]))) if m.sum() > 1 else 0.0

# 1. runs of cadences: consecutive points of one sector at most 1.2 cadences apart, stored as [first, last, cadence]
#    (centres); a missing cadence starts a new run. aliases.js counts the centres of a run inside a window, EXOTIC's rule.
iv = []
for x, c, sv in zip(t, cad, sec):
    if iv and iv[-1][3] == sv and x - iv[-1][1] <= 1.2 * c: iv[-1][1] = x
    else: iv.append([x, x, c, sv])
iv = [[round(a, 6), round(b, 6), round(c, 8)] for a, b, c, _ in iv]

# 2. EXOTIC's rule on the cadences
star = dict(mstar=1.02, rstar=0.974); rprs = 0.0401378
epochs = np.array([2458848.6400, 2459748.8308, 2460649.0170]); base = (epochs[-1] - epochs[0]) / 2
rows = []
for N in range(1, 26):
    P = base / N
    ars = (G * star['mstar'] * MSUN * (P * 86400) ** 2 / (4 * math.pi ** 2)) ** (1 / 3) / (star['rstar'] * RSUN)
    dur = P / math.pi * math.asin(min(1.0, (1 + rprs) / ars))
    n0 = int(np.floor((t.min() - epochs[0]) / P)) - 1; n1 = int(np.ceil((t.max() - epochs[0]) / P)) + 1
    pred = epochs[0] + np.arange(n0, n1 + 1) * P; pred = pred[(pred > t.min()) & (pred < t.max())]
    covered = missed = 0
    for x in pred:
        inw = (t > x - dur / 2) & (t < x + dur / 2)
        if cad[inw].sum() / dur > 0.5:
            covered += 1
            if np.min(np.abs(epochs - x)) > 0.1: missed += 1
    rows.append(dict(N=N, per=P, t14=dur, covered=covered, missed=missed, allowed=missed == 0))

stored = json.load(open(os.path.join(SRC, 'toi1873_alias_scan.json')))
out = dict(epochs=epochs.tolist(), baseline=base, star=star, rprs=rprs, intervals=iv, tmin=float(t.min()), tmax=float(t.max()),
           n_cadences=int(len(t)), sectors=sorted(int(v) for v in np.unique(sec)), scan=rows,
           exotic_stored=[dict(N=r['N'], covered=r['covered'], missed=r['missed'], allowed=r['allowed']) for r in stored['scan']])
json.dump(out, open(os.path.join(HERE, 'alias_reference.json'), 'w'))
print(f'{len(t)} cadences in {len(out["sectors"])} sectors -> {len(iv)} intervals; allowed N:', [r['N'] for r in rows if r['allowed']],
      '; stored by EXOTIC:', [r['N'] for r in stored['scan'] if r['allowed']])
