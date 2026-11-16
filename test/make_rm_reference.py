# Independent reference for src/core/rm.js (Rossiter-McLaughlin anomaly), written to test/rm_reference.json.
#
#   .venv/bin/python test/make_rm_reference.py
#
# Brute-force pixel integration: the planet's bounding box is cut into N x N pixels; a pixel counts when its centre
# is inside both the planet's disc and the star's. On those pixels the Claret-law intensity
#     I = 1 - sum_n a_n (1 - mu^(n/2)),   mu = sqrt(1 - x^2 - y^2)
# and the line-of-sight velocity of solid-body rotation v = vsini (x cos lambda - y sin lambda) are summed, and
#     dV = - sum I v dA / (F_star - sum I dA),
# with the star's total flux F_star = 2 pi int_0^1 I(r) r dr from scipy.integrate.quad. Shares nothing with the line
# integral of rm.js (no F(r), no Green's theorem, no Gauss-Legendre). The pixel sum is repeated at N/2 to give an
# estimate of its own error, stored with each case.
import json, math, os
import numpy as np
from scipy.integrate import quad

HERE = os.path.dirname(os.path.abspath(__file__))
N = 4000


def intensity(mu, a):
    s = np.sqrt(mu)
    return 1.0 - a[0] * (1 - s) - a[1] * (1 - mu) - a[2] * (1 - mu * s) - a[3] * (1 - mu * mu)


def star_flux(a):
    return 2 * math.pi * quad(lambda r: float(intensity(np.sqrt(max(0.0, 1 - r * r)), a)) * r, 0, 1, epsabs=1e-14, epsrel=1e-13, limit=200)[0]


def pixel_rm(X, Y, p, a, lam_deg, n=N, vsini=1.0):
    h = 2 * p / n
    xs = X - p + h * (np.arange(n) + 0.5)
    lam = math.radians(lam_deg)
    sI = 0.0
    sIv = 0.0
    for i0 in range(0, n, 500):
        ys = Y - p + h * (np.arange(i0, min(n, i0 + 500)) + 0.5)
        x, y = np.meshgrid(xs, ys)
        r2 = x * x + y * y
        m = ((x - X) ** 2 + (y - Y) ** 2 < p * p) & (r2 < 1)
        mu = np.sqrt(1 - r2[m])
        I = intensity(mu, a)
        sI += I.sum() * h * h
        sIv += (I * vsini * (x[m] * math.cos(lam) - y[m] * math.sin(lam))).sum() * h * h
    Fs = star_flux(a)
    return -sIv / (Fs - sI), sI / Fs


LAWS = {
    'uniform': [0, 0, 0, 0],
    'quadratic': [0, 0.40 + 2 * 0.26, 0, -0.26],          # u1 = 0.40, u2 = 0.26 as Claret coefficients
    'nonlinear': [0.4939, -0.0729, 0.4578, -0.2158],
}
POS = [(0.30, -0.20), (0.05, 0.02), (-0.62, -0.45), (0.86, -0.30), (-0.97, -0.15), (1.03, -0.10), (0.20, -0.95)]
cases = []
for law, a in LAWS.items():
    for p in (0.01, 0.1, 0.2):
        for (X, Y) in POS:
            z = math.hypot(X, Y)
            if z >= 1 + p or (p == 0.01 and z > 0.99):
                continue
            for lam in ((0.0, 35.0, -70.0, 150.0) if law == 'nonlinear' else (0.0, 35.0)):
                dv, fb = pixel_rm(X, Y, p, a, lam)
                dv2, _ = pixel_rm(X, Y, p, a, lam, n=N // 2)
                cases.append({'law': law, 'claret': a, 'X': X, 'Y': Y, 'p': p, 'lambda': lam, 'dv': dv, 'blocked': fb, 'pixel_err': abs(dv - dv2)})
                print(f'{law:9s} p={p:<5} X={X:+.2f} Y={Y:+.2f} lam={lam:+6.1f}  dV/vsini={dv:+.6e}  (N/2 differs by {abs(dv - dv2):.1e})')

out = {'generator': 'test/make_rm_reference.py', 'method': f'pixel sum over the planet bounding box, {N} x {N}; star flux by scipy quad', 'vsini': 1.0, 'cases': cases}
with open(os.path.join(HERE, 'rm_reference.json'), 'w') as fh:
    json.dump(out, fh, indent=1)
print(len(cases), 'cases written to test/rm_reference.json')
