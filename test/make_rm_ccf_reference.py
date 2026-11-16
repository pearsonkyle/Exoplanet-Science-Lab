# Independent reference for the CCF form of the Rossiter-McLaughlin anomaly (src/core/rm.js, method 'ccf'), written to
# test/rm_ccf_reference.json.
#
#   .venv/bin/python test/make_rm_ccf_reference.py
#
# Brute force, sharing nothing with rm.js: the stellar disc is cut into 3000 x 3000 pixels and the planet's disc into
# 700 x 700; each pixel inside the star carries the limb-darkened intensity (quadratic law) and the solid-body rotation
# velocity v = vsini (x cos lambda - y sin lambda). Each pixel contributes a Gaussian line of dispersion beta_p (instrumental
# + thermal, with macroturbulence zeta added as zeta^2 / 2) at its velocity; the pixels are first binned in velocity
# (8000 bins) and the binned weights convolved with the Gaussian. Out of transit the summed profile is fitted with a
# Gaussian (scipy curve_fit: amplitude, centre, dispersion) on 301 velocities over +- (vsini + 6 beta_p); in transit the
# planet's pixels are removed and the fit repeated. The anomaly is the change of the fitted centre. Also stored: the
# first moment of the in-transit profile (what rm.js computes without 'ccf') and the out-of-transit fitted dispersion.
import json, math, os
import numpy as np
from scipy.optimize import curve_fit

HERE = os.path.dirname(os.path.abspath(__file__))
U = (0.45, 0.25)


def intensity(r2):
    mu = np.sqrt(np.clip(1 - r2, 0, None))
    return 1 - U[0] * (1 - mu) - U[1] * (1 - mu) ** 2


NS = 3000
g = (np.arange(NS) + 0.5) / NS * 2 - 1
XS, YS = np.meshgrid(g, g, indexing='ij'); R2 = XS ** 2 + YS ** 2; IN = R2 < 1
XS, YS, IS = XS[IN], YS[IN], intensity(R2[IN]) * (2 / NS) ** 2


def planet_pixels(X, Y, p, n=700):
    q = (np.arange(n) + 0.5) / n * 2 - 1
    a, b = np.meshgrid(q, q, indexing='ij'); m = a ** 2 + b ** 2 < 1
    x, y = X + p * a[m], Y + p * b[m]; r2 = x ** 2 + y ** 2; s = r2 < 1
    return x[s], y[s], intensity(r2[s]) * (2 * p / n) ** 2


def gauss(v, A, m, s):
    return A * np.exp(-0.5 * ((v - m) / s) ** 2)


def profile(vpix, w, vgrid, beta, nb=8000):
    lo, hi = vpix.min() - 1e-9, vpix.max() + 1e-9
    h, e = np.histogram(vpix, bins=nb, range=(lo, hi), weights=w); c = 0.5 * (e[1:] + e[:-1])
    k = np.exp(-0.5 * ((vgrid[:, None] - c[None, :]) / beta) ** 2)
    return np.einsum('ij,j->i', k, h)


cases = []
for vsini, beta, zeta in [(1.7, 3.0, 0.0), (3.0, 3.0, 0.0), (6.0, 3.0, 0.0), (12.0, 3.0, 0.0), (5.0, 2.5, 4.0)]:
    bp = math.sqrt(beta ** 2 + 0.5 * zeta ** 2)
    vg = np.linspace(-(vsini + 6 * bp), vsini + 6 * bp, 301)
    for lam in (0.0, 40.0):
        l = math.radians(lam)
        vstar = vsini * (XS * math.cos(l) - YS * math.sin(l))
        P0 = profile(vstar, IS, vg, bp)
        TOL = dict(ftol=1e-15, xtol=1e-15, gtol=1e-15, maxfev=20000)
        (A0, m0, s0), _ = curve_fit(gauss, vg, P0, p0=[P0.max(), 0.1, math.hypot(bp, vsini / 2)], **TOL)
        F0, M0 = IS.sum(), (IS * vstar).sum()
        for p in (0.1, 0.05):
            for X, Y in [(-0.7, -0.3), (-0.3, -0.3), (0.1, -0.3), (0.5, -0.3), (0.85, -0.3), (0.95, -0.3)]:
                x, y, w = planet_pixels(X, Y, p)
                vp = vsini * (x * math.cos(l) - y * math.sin(l))
                # in transit: the whole star minus the planet's pixels (each set binned on the same velocity range)
                vall = np.concatenate([vstar, vp]); wall = np.concatenate([IS, -w])
                P1 = profile(vall, wall, vg, bp)
                (A1, m1, s1), _ = curve_fit(gauss, vg, P1, p0=[A0, m0 + 0.1, s0], **TOL)
                moment = (M0 - (w * vp).sum()) / (F0 - w.sum())
                cases.append(dict(vsini=vsini, beta=beta, zeta=zeta, lam=lam, p=p, X=X, Y=Y, u=U, dv_ccf=float(m1 - m0), dv_moment=float(moment - M0 / F0),
                                  beta0=float(abs(s0)), f=float(w.sum() / F0)))
        print(f'vsini {vsini} beta {beta} zeta {zeta} lam {lam}: beta0 fitted {abs(s0):.4f} km/s')
json.dump(dict(cases=cases), open(os.path.join(HERE, 'rm_ccf_reference.json'), 'w'), indent=1)
print('wrote', len(cases), 'cases')
