"""How should a k-table be interpolated in temperature? Each temperature node of ExoMolOP's R = 1000 k-tables is
predicted from its two neighbours (which is the spacing the shipped tables have, keeping every second node) by four
rules, and compared with the node's own values:
    log k linear in T, in ln T, in 1/T; k itself linear in T (what petitRADTRANS's spectra correspond to).
Prints the rms and mean of log10(predicted / actual) per species, over 0.6-12 micron, k > 1e-26 cm^2, nodes from 400
to 2600 K, at four pressures.

Run:  .venv-rt/bin/python tools/opacity/interp_study.py [species ...]      (the tables in data-src/exomol/)
"""
import sys
import numpy as np
import build_opacity as B

print('species   log k in T        log k in ln T     log k in 1/T      k in T            99th percentile of |.|: log k in 1/T, k in T')
for sp in sys.argv[1:] or list(B.EXOMOL):
    wl, p, t, k, nodes, w, doi = B.read_exomol_k(sp)
    sel = (wl[:-1] > 0.6) & (wl[1:] < 12)
    res = {r: [] for r in 'T lnT invT kT'.split()}
    for ip in (4, 9, 14, 18):
        for it in range(1, len(t) - 1):
            if not (400 <= t[it] <= 2600): continue
            ka, kb, kc = (k[ip, j][sel] for j in (it - 1, it, it + 1))
            ok = (kb > 1e-26) & (ka > 0) & (kc > 0)
            a, b, c = (np.log10(np.maximum(x, 1e-99)) for x in (ka, kb, kc))
            f_t = (t[it] - t[it - 1]) / (t[it + 1] - t[it - 1])
            for r, f in (('T', f_t), ('lnT', np.log(t[it] / t[it - 1]) / np.log(t[it + 1] / t[it - 1])), ('invT', (1 / t[it - 1] - 1 / t[it]) / (1 / t[it - 1] - 1 / t[it + 1]))):
                res[r].append(((1 - f) * a + f * c - b)[ok])
            res['kT'].append((np.log10(np.maximum((1 - f_t) * ka + f_t * kc, 1e-99)) - b)[ok])
    e = {r: np.concatenate(res[r]) for r in res}
    print(f'{sp:5s}   ' + '    '.join(f'{np.sqrt((e[r] ** 2).mean()):.4f} {e[r].mean():+.4f}' for r in res) + f'    {np.percentile(np.abs(e["invT"]), 99):.3f}, {np.percentile(np.abs(e["kT"]), 99):.3f}', flush=True)
