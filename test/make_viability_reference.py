# Independent reference for src/core/physical.js (physical-viability priors), written to test/viability_reference.json.
#
#   .venv/bin/python test/make_viability_reference.py
#
# 1. Gladman (1993) eq. 21, Hill stability of two planets on coplanar eccentric orbits, written out in numpy:
#        mu^-3 (mu1 + mu2 / l^2) (mu1 g1 + mu2 g2 l)^2  >  1 + 3^(4/3) mu1 mu2 / mu^(4/3),
#    mu = mu1 + mu2, l = sqrt(a2 / a1), g = sqrt(1 - e^2); the margin is LHS / RHS - 1. Also the critical circular
#    separation found with scipy's brentq, to compare with 2 sqrt(3) mutual Hill radii.
# 2. Laskar & Petit (2017) critical AMD: e_in is the root of
#        alpha e + gamma e / sqrt(alpha (1 - e^2) + gamma^2 e^2) - 1 + alpha = 0     (their eq. 35, brentq here)
#    e_out = 1 - alpha - alpha e_in, and C_c = gamma sqrt(alpha) (1 - sqrt(1 - e_in^2)) + 1 - sqrt(1 - e_out^2) (eq. 39).
#    beta of a pair = AMD / (Lambda_out C_c), Lambda = m sqrt(a) (G M* = 1), AMD = sum Lambda (1 - sqrt(1 - e^2)).
# Shares no code with the JavaScript (bisection there, brentq here).
import json, math, os
import numpy as np
from scipy.optimize import brentq

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20261116)


def gladman_margin(mu1, mu2, a1, a2, e1, e2):
    mu = mu1 + mu2
    l = math.sqrt(a2 / a1)
    g1, g2 = math.sqrt(1 - e1 * e1), math.sqrt(1 - e2 * e2)
    lhs = mu ** -3 * (mu1 + mu2 / l ** 2) * (mu1 * g1 + mu2 * g2 * l) ** 2
    rhs = 1 + 3 ** (4 / 3) * mu1 * mu2 / mu ** (4 / 3)
    return lhs / rhs - 1


def critical_circular(mu1, mu2):
    # a1 = 1: the a2 at which the circular margin crosses zero
    return brentq(lambda a2: gladman_margin(mu1, mu2, 1.0, a2, 0, 0), 1 + 1e-9, 3.0, xtol=1e-15, rtol=1e-15)


def amd_critical(alpha, gamma):
    F = lambda e: alpha * e + gamma * e / math.sqrt(alpha * (1 - e * e) + gamma * gamma * e * e) - 1 + alpha
    e = brentq(F, 0.0, min(1.0, 1 / alpha - 1), xtol=1e-15, rtol=1e-15)
    ep = 1 - alpha - alpha * e
    return gamma * math.sqrt(alpha) * (1 - math.sqrt(1 - e * e)) + 1 - math.sqrt(1 - ep * ep)


gl = []
for _ in range(200):
    mu1, mu2 = 10 ** rng.uniform(-6, -2.5), 10 ** rng.uniform(-6, -2.5)
    a1 = 1.0
    a2 = a1 * 10 ** rng.uniform(0.01, 0.4)
    e1, e2 = rng.uniform(0, 0.5), rng.uniform(0, 0.5)
    gl.append(dict(mu1=mu1, mu2=mu2, a1=a1, a2=a2, e1=e1, e2=e2, margin=gladman_margin(mu1, mu2, a1, a2, e1, e2)))

circ = []
for mu in [1e-7, 1e-6, 1e-5, 1e-4, 1e-3]:
    a2 = critical_circular(mu, mu)
    rh = 0.5 * (1 + a2) * ((2 * mu) / 3) ** (1 / 3)
    circ.append(dict(mu1=mu, mu2=mu, a2_crit=a2, delta_hill=(a2 - 1) / rh))

amd = []
for _ in range(100):
    n = int(rng.integers(2, 5))
    m = 10 ** rng.uniform(-6, -3, n)
    a = np.sort(10 ** rng.uniform(-1.5, 0.5, n))
    e = rng.uniform(0, 0.4, n)
    lam = m * np.sqrt(a)
    C = float(np.sum(lam * (1 - np.sqrt(1 - e * e))))
    pairs = []
    for k in range(n - 1):
        cc = amd_critical(a[k] / a[k + 1], m[k] / m[k + 1])
        pairs.append(dict(Cc=cc, beta=C / lam[k + 1] / cc))
    amd.append(dict(m=m.tolist(), a=a.tolist(), e=e.tolist(), amd=C, beta_star=C / lam[0], pairs=pairs,
                    stable=bool(all(p['beta'] < 1 for p in pairs) and C / lam[0] < 1)))

json.dump(dict(gladman=gl, circular=circ, amd=amd), open(os.path.join(HERE, 'viability_reference.json'), 'w'), indent=1)
print('wrote', len(gl), 'Gladman cases,', len(circ), 'circular limits,', len(amd), 'AMD systems;',
      sum(1 for x in amd if x['stable']), 'AMD-stable; circular delta_hill:', [round(c['delta_hill'], 4) for c in circ])
