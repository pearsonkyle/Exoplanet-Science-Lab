# Independent reference for src/core/ephemeris.js: the weighted normal equations solved in exact
# rational arithmetic (fractions.Fraction), so the reference has no rounding at all. numpy.polyfit
# (SVD, weights 1/sigma, unscaled covariance) is run alongside and its distance from the exact
# answer is printed: it loses digits when the epochs are far from zero. Run with the project venv:
#   .venv/bin/python test/make_ephemeris_reference.py
import json, numpy as np
from fractions import Fraction as Fr

def exact(E, y, err, deg):
    k = deg + 1; E = [Fr(int(e)) for e in E]; y = [Fr(float(v)) for v in y]; w = [1 / Fr(float(s))**2 for s in err]
    A = [[sum(wi * e**(r + c) for wi, e in zip(w, E)) for c in range(k)] for r in range(k)]
    M = [A[r] + [Fr(int(r == c)) for c in range(k)] for r in range(k)]
    for c in range(k):
        p = next(r for r in range(c, k) if M[r][c] != 0); M[c], M[p] = M[p], M[c]
        d = M[c][c]; M[c] = [v / d for v in M[c]]
        for r in range(k):
            if r != c and M[r][c] != 0: f = M[r][c]; M[r] = [a - f * b for a, b in zip(M[r], M[c])]
    C = [row[k:] for row in M]
    b = [sum(wi * e**r * yi for wi, e, yi in zip(w, E, y)) for r in range(k)]
    c = [sum(C[r][j] * b[j] for j in range(k)) for r in range(k)]
    chi2 = sum(wi * (yi - sum(c[j] * e**j for j in range(k)))**2 for wi, e, yi in zip(w, E, y))
    return c, C, chi2
rng = np.random.default_rng(20261115)
cases = []
def case(name, E, t0, per, dpde, sig):
    E = np.asarray(E, dtype=float)
    err = sig * (0.5 + rng.random(E.size))
    T = t0 + per * E + 0.5 * dpde * E**2 + err * rng.standard_normal(E.size)
    tref = T[0]
    out = {'name': name, 'epochs': E.tolist(), 'times': T.tolist(), 'errs': err.tolist(), 'tref': tref, 'fits': {}}
    for deg in (1, 2):
        cx, Cx, chi2 = exact(E, T - tref, err, deg)           # ascending powers: t0 - tref, P, dPdE/2
        Ep = int(E.max() + 500)
        pt = sum(cx[j] * Ep**j for j in range(deg + 1)); pv = sum(Cx[a][b] * Ep**(a + b) for a in range(deg + 1) for b in range(deg + 1))
        out['fits'][str(deg)] = {'coef': [float(v) for v in cx], 'cov': [[float(v) for v in row] for row in Cx], 'chi2': float(chi2),
                                 'predictEpoch': Ep, 'predictT': float(pt), 'predictSigma': float(pv)**0.5}
        if E.size > deg + 1:
            c, cov = np.polyfit(E, T - tref, deg, w=1 / err, cov='unscaled'); c, cov = c[::-1], cov[::-1, ::-1]
            sd = np.sqrt(np.diag(cov)); ref = np.array(out['fits'][str(deg)]['cov'])
            print(f"  {name}, degree {deg}: numpy vs exact  coef {np.max(np.abs(c - np.array(out['fits'][str(deg)]['coef'])) / sd):.1e} sigma, cov {np.max(np.abs(cov - ref) / np.outer(sd, sd)):.1e} relative")
    cases.append(out)
case('hot Jupiter, JD times, sparse epochs', sorted(rng.choice(2500, 40, replace=False)), 2456305.455, 1.0914203, -1.0e-9, 4e-4)
case('long period, few transits', [-3, -1, 0, 2, 5, 9], 2458888.0757, 111.4367, 0.0, 6e-4)
case('epochs far from zero', np.arange(4000, 4060, 3), 2454508.977, 2.1500082, 3e-9, 2e-4)
case('minimum points', [0, 7, 19], 100.25, 7.0057, 0.0, 1e-3)
json.dump({'generator': 'exact rational normal equations (fractions.Fraction); cross-checked with numpy ' + np.__version__ + ' polyfit', 'cases': cases}, open('test/ephemeris_reference.json', 'w'))
print('wrote', len(cases), 'cases')
