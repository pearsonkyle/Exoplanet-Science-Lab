# Independent reference values for the blocked-flux kernel (scipy adaptive quadrature).
import json, numpy as np
from scipy import integrate
def I(r, a):
    mu = np.sqrt(np.clip(1 - r*r, 0, 1))
    return 1 - sum(a[n]*(1 - mu**((n+1)/2)) for n in range(4))
def radial(z, p, a):
    # pylightcurve-style formulation: annuli of the star, arc inside the planet
    lo, hi = max(0.0, z - p), min(1.0, z + p)
    if hi <= lo: return 0.0
    def f(r):
        if r <= p - z: al = np.pi
        elif r <= 0: al = 0.0
        else: al = np.arccos(np.clip((r*r + z*z - p*p)/(2*z*r), -1, 1)) if z > 0 else np.pi
        return I(r, a)*r*2*al
    pts = [x for x in (p - z,) if lo < x < hi]
    v = 0.0
    edges = [lo] + pts + [hi]
    for s, e in zip(edges[:-1], edges[1:]):
        # endpoint sqrt singularities: substitute r = m + h sin(t)
        m, h = (s+e)/2, (e-s)/2
        v += integrate.quad(lambda t: f(m + h*np.sin(t))*h*np.cos(t), -np.pi/2, np.pi/2, epsabs=1e-14, epsrel=1e-13, limit=400)[0]
    tot = 2*np.pi*integrate.quad(lambda t: I(np.sin(t), a)*np.sin(t)*np.cos(t), 0, np.pi/2, epsabs=1e-15, epsrel=1e-14)[0]
    return v/tot
def area2d(z, p, a):
    # second, different formulation: polar coordinates about the planet centre
    def g(rho, phi):
        r2 = z*z + rho*rho + 2*z*rho*np.cos(phi)
        return I(np.sqrt(r2), a)*rho if r2 < 1 else 0.0
    v = integrate.dblquad(g, 0, np.pi, 0, p, epsabs=1e-10, epsrel=1e-10)[0]*2
    tot = 2*np.pi*integrate.quad(lambda t: I(np.sin(t), a)*np.sin(t)*np.cos(t), 0, np.pi/2)[0]
    return v/tot
laws = {'claret_exotic': [0.4939, -0.0729, 0.4578, -0.2158], 'quad_sun': [0, 0.4+2*0.26, 0, -0.26],
        'linear': [0, 0.6, 0, 0], 'claret_cool': [0.6, -0.4, 0.9, -0.3], 'uniform': [0,0,0,0]}
rng = np.random.default_rng(1)
cases = []
for name, a in laws.items():
    for p in [0.01, 0.05, 0.1, 0.15, 0.3, 0.7, 1.2]:
        zs = [0, 1e-6, 0.3*p, p, 0.5, 1 - p - 1e-3, 1 - p - 1e-8, 1 - p, 1 - p + 1e-4, 1 - 0.5*p, 1.0, 1 + 0.5*p, 1 + p - 1e-5, 1 + p]
        zs += list(rng.uniform(0, 1 + p, 6))
        for z in zs:
            if z < 0: continue
            cases.append(dict(law=name, a=a, p=p, z=float(z), ref=float(radial(z, p, a))))
chk = []
for c in cases[::17]:
    if c['law'] != 'uniform' and c['p'] <= 0.3:
        chk.append(abs(area2d(c['z'], c['p'], c['a']) - c['ref']))
print('cases', len(cases), 'max |radial - 2D|', max(chk), 'n', len(chk))
json.dump(cases, open('test/reference.json', 'w'))
