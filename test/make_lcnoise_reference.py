# Independent reference for the light-curve jitter and dilution terms of buildProblem (src/core/model.js), written to
# test/lcnoise_reference.json.
#
#   .venv/bin/python test/make_lcnoise_reference.py
#
# A two-epoch light curve of a transit across a uniform star (blocked flux = overlap area / pi, in closed form), with
# white noise of the quoted error bars plus an extra jitter per epoch, diluted by other light in the aperture:
#     f_i = a1_s * (T(t_i) + d) / (1 + d) + N(0, e_i^2 + j_s^2)
# The reference is the likelihood of buildProblem's definition evaluated directly:
#     L = prod_s (1/W) int_0^W prod_{i in s} N(f_i | a1 m_i, e_i^2 + j_s^2) da1,     W = 2 (A1_PRIOR_WIDTH),
# with the integral over a1 done numerically (scipy.integrate.quad), not by the closed form the JavaScript uses; the
# chi-square at the best a1 is found by scipy.optimize.minimize_scalar; and the jitter that maximises L at fixed
# transit and dilution by scipy.optimize.minimize.
import json, math, os
import numpy as np
from scipy.integrate import quad
from scipy.optimize import minimize, minimize_scalar

HERE = os.path.dirname(os.path.abspath(__file__))
P = dict(rprs=0.1, ars=10.0, inc=88.5, per=3.0, tmid=0.0)
TRUTH = dict(jit=[1500.0, 600.0], dil=0.4, a1=[1.001, 0.999])


def overlap(z, p):
    z = np.asarray(z, float)
    out = np.zeros_like(z)
    full = z <= 1 - p
    out[full] = math.pi * p * p
    part = (z > 1 - p) & (z < 1 + p)
    zz = z[part]
    k0 = np.arccos(np.clip((p * p + zz * zz - 1) / (2 * p * zz), -1, 1))
    k1 = np.arccos(np.clip((1 - p * p + zz * zz) / (2 * zz), -1, 1))
    out[part] = p * p * k0 + k1 - 0.5 * np.sqrt(np.maximum(0, 4 * zz * zz - (1 + zz * zz - p * p) ** 2))
    return out


def transit(t):
    u = math.pi / 2 + 2 * math.pi * (t - P['tmid']) / P['per']
    ci = math.cos(math.radians(P['inc']))
    X, Y, Z = -P['ars'] * np.cos(u), -P['ars'] * np.sin(u) * ci, np.sin(u)
    z = np.hypot(X, Y)
    f = 1 - overlap(z, P['rprs']) / math.pi
    return np.where(Z > 0, f, 1.0)


rng = np.random.default_rng(20261116)
t = np.concatenate([np.linspace(-0.15, 0.15, 300), P['per'] + np.linspace(-0.15, 0.15, 300)])
epoch = np.repeat([0, 1], 300)
e = 1e-3 * (1 + 0.3 * rng.random(t.size))
jt = np.array(TRUTH['jit'])[epoch] * 1e-6
m_true = (transit(t) + TRUTH['dil']) / (1 + TRUTH['dil'])
f = np.array(TRUTH['a1'])[epoch] * m_true + rng.normal(0, np.sqrt(e * e + jt * jt))
W = 2.0


def epoch_lnl(s, j, d):
    k = epoch == s
    m = (transit(t[k]) + d) / (1 + d)
    s2 = e[k] ** 2 + (j * 1e-6) ** 2

    def ll(a1):
        r = f[k] - a1 * m
        return -0.5 * np.sum(r * r / s2) - 0.5 * np.sum(np.log(2 * math.pi * s2))
    best = minimize_scalar(lambda a: -ll(a), bracket=(0.9, 1.0, 1.1), method='brent', tol=1e-15)
    a1b, llb = best.x, -best.fun
    sd = 1 / math.sqrt(np.sum(m * m / s2))
    I = quad(lambda a: math.exp(ll(a) - llb), 0, W, points=[a1b - 5 * sd, a1b, a1b + 5 * sd], epsabs=0, epsrel=1e-12, limit=400)[0]
    chi2 = float(np.sum((f[k] - a1b * m) ** 2 / s2))
    return llb + math.log(I) - math.log(W), chi2, a1b


def total(j1, j2, d):
    a, b = epoch_lnl(0, j1, d), epoch_lnl(1, j2, d)
    return {'jit': [j1, j2], 'dil': d, 'lnL': a[0] + b[0], 'chi2': a[1] + b[1], 'a1': [a[2], b[2]]}


points = [total(*x) for x in [(0, 0, 0), (1500, 600, 0.4), (800, 1200, 0.1), (3000, 0, 1.0)]]
for x in points: print(f"jit {x['jit']} ppm, d {x['dil']}: lnL {x['lnL']:.6f}, chi2 {x['chi2']:.4f}")
opt = minimize(lambda q: -(epoch_lnl(0, abs(q[0]), TRUTH['dil'])[0] + epoch_lnl(1, abs(q[1]), TRUTH['dil'])[0]), x0=[1000, 1000], method='Nelder-Mead', options={'xatol': 1e-3, 'fatol': 1e-10, 'maxiter': 4000})
ml = [abs(float(opt.x[0])), abs(float(opt.x[1]))]
print('maximum-likelihood jitter at the true transit and dilution:', ml)
out = {'generator': 'test/make_lcnoise_reference.py', 'params': P, 'truth': TRUTH, 'a1_prior_width': W,
       'data': {'t': t.tolist(), 'f': f.tolist(), 'e': e.tolist(), 'epoch': epoch.tolist()}, 'points': points, 'ml_jitter': ml, 'ml_lnL': -float(opt.fun)}
with open(os.path.join(HERE, 'lcnoise_reference.json'), 'w') as fh:
    json.dump(out, fh)
print('written test/lcnoise_reference.json')
