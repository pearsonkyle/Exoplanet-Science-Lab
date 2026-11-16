# Shared pieces of the validation reference generators. Nothing here imports ESL code.
#
#   truth orbit   Kepler's equation solved in 30-digit arithmetic (mpmath), sky separation from the definition
#   truth flux    the blocked flux by adaptive quadrature of the radial integral (scipy, as test/make_reference.py),
#                 for the Claret four-coefficient law; the simpler laws are mapped onto it exactly
#
# Conventions of the inputs (the same numbers are handed to every code, converted in codes.py):
#   per [d], tmid = time of inferior conjunction [d], ars = a/R*, inc [deg], ecc, omega [deg] with the transit at
#   true anomaly nu = 90 deg - omega (the number batman, pylightcurve, pyaneti and radvel also call omega / w).
import json, math, datetime
import numpy as np
import mpmath as mp
from scipy import integrate

mp.mp.dps = 30

def to_claret(law, c):
    """Any supported law as the four Claret coefficients, I = 1 - sum a_n (1 - mu^(n/2))."""
    if law == 'uniform': return [0.0, 0.0, 0.0, 0.0]
    if law == 'linear': return [0.0, c[0], 0.0, 0.0]
    if law == 'quadratic': return [0.0, c[0] + 2 * c[1], 0.0, -c[1]]
    if law == 'nonlinear': return list(c)
    raise ValueError(law)

def kepler_mp(M, e):
    """Eccentric anomaly to 30 digits. M may be any real."""
    M = mp.mpf(M); e = mp.mpf(e)
    twopi = 2 * mp.pi
    M = M - twopi * mp.floor((M + mp.pi) / twopi)
    if e == 0: return M
    E = M + e * mp.sin(M) if e < 0.8 else (mp.pi if M > 0 else -mp.pi)
    for _ in range(200):
        d = (E - e * mp.sin(E) - M) / (1 - e * mp.cos(E))
        E -= d
        if abs(d) < mp.mpf(10) ** (-27): break
    else:
        raise RuntimeError('kepler_mp did not converge')
    return E

def true_anomaly_mp(E, e):
    return 2 * mp.atan2(mp.sqrt(1 + e) * mp.sin(E / 2), mp.sqrt(1 - e) * mp.cos(E / 2))

def m0_transit_mp(e, w):
    """Mean anomaly at inferior conjunction (nu = pi/2 - omega)."""
    nu = mp.pi / 2 - w
    E = 2 * mp.atan2(mp.sqrt(1 - e) * mp.sin(nu / 2), mp.sqrt(1 + e) * mp.cos(nu / 2))
    return E - e * mp.sin(E)

def orbit_mp(t, p):
    """(r/R*, u = omega + nu) at time t in 30-digit arithmetic."""
    e = mp.mpf(p.get('ecc', 0)); w = mp.radians(mp.mpf(p.get('omega', 0)))
    n = 2 * mp.pi / mp.mpf(p['per'])
    M = m0_transit_mp(e, w) + n * (mp.mpf(t) - mp.mpf(p['tmid']))
    E = kepler_mp(M, e)
    return mp.mpf(p['ars']) * (1 - e * mp.cos(E)), w + true_anomaly_mp(E, e)

def truth_sep(times, p):
    """Sky-projected separation in stellar radii and whether the planet is on the near side."""
    inc = mp.radians(mp.mpf(p['inc']))
    z = np.empty(len(times)); front = np.empty(len(times), bool)
    for i, t in enumerate(times):
        r, u = orbit_mp(t, p)
        su = mp.sin(u)
        z[i] = float(r * mp.sqrt(1 - (su * mp.sin(inc)) ** 2)); front[i] = su * mp.sin(inc) > 0
    return z, front

def dt_min_sep(p):
    """Time of minimum sky-projected separation minus time of inferior conjunction (0 for a circular orbit)."""
    if not p.get('ecc'): return 0.0
    inc = mp.radians(mp.mpf(p['inc']))
    def sep2(t):
        r, u = orbit_mp(t, p); return r * r * (1 - (mp.sin(u) * mp.sin(inc)) ** 2)
    h = mp.mpf(p['per']) * mp.mpf('1e-9')
    return float(mp.findroot(lambda t: (sep2(t + h) - sep2(t - h)) / (2 * h), mp.mpf(p['tmid']), tol=1e-22) - mp.mpf(p['tmid']))

def _I(r, a):
    mu = math.sqrt(min(max(1 - r * r, 0.0), 1.0))
    return 1 - a[0] * (1 - mu ** 0.5) - a[1] * (1 - mu) - a[2] * (1 - mu ** 1.5) - a[3] * (1 - mu * mu)

def disk_flux(a):
    c0 = 1 - sum(a)
    return 2 * math.pi * (c0 / 2 + a[0] / 2.5 + a[1] / 3 + a[2] / 3.5 + a[3] / 4)

def blocked(z, p, a):
    """Fraction of the stellar flux behind a disc of radius p at separation z: annuli of the star, arc inside the planet."""
    if z >= 1 + p: return 0.0
    lo, hi = max(0.0, z - p), min(1.0, z + p)
    if hi <= lo: return 0.0
    def f(r):
        if r <= p - z: al = math.pi
        elif r <= 0: al = 0.0
        else: al = math.acos(min(1.0, max(-1.0, (r * r + z * z - p * p) / (2 * z * r)))) if z > 0 else math.pi
        return _I(r, a) * r * 2 * al
    edges = [lo] + [x for x in (p - z,) if lo < x < hi] + [hi]
    v = 0.0
    for s, e in zip(edges[:-1], edges[1:]):
        m, h = (s + e) / 2, (e - s) / 2          # r = m + h sin(x) removes the square-root endpoint singularities
        v += integrate.quad(lambda x: f(m + h * math.sin(x)) * h * math.cos(x), -math.pi / 2, math.pi / 2, epsabs=1e-15, epsrel=1e-13, limit=400)[0]
    return v / disk_flux(a)

def blocked_mp(z, p, a):
    """The same integral by tanh-sinh quadrature in 30-digit arithmetic: an independent check of blocked()."""
    z = mp.mpf(z); p = mp.mpf(p); a = [mp.mpf(x) for x in a]
    if z >= 1 + p: return 0.0
    lo, hi = max(mp.mpf(0), z - p), min(mp.mpf(1), z + p)
    def I(r):
        mu = mp.sqrt(max(1 - r * r, 0))
        return 1 - a[0] * (1 - mp.sqrt(mu)) - a[1] * (1 - mu) - a[2] * (1 - mu ** mp.mpf(1.5)) - a[3] * (1 - mu * mu)
    def f(r):
        if r <= p - z: al = mp.pi
        else:
            c = (r * r + z * z - p * p) / (2 * z * r) if z > 0 else mp.mpf(-1)
            al = mp.acos(min(mp.mpf(1), max(mp.mpf(-1), c)))
        return I(r) * r * 2 * al
    edges = [lo] + [x for x in (p - z,) if lo < x < hi] + [hi]
    v = mp.quad(f, edges)
    tot = 2 * mp.pi * mp.quad(lambda r: I(r) * r, [0, 1])
    return float(v / tot)

def truth_flux(times, case, z=None, front=None):
    if z is None: z, front = truth_sep(times, case)
    a = to_claret(case['law'], case['ld']); k = case['rprs']
    return np.array([1 - blocked(zi, k, a) if (fr and zi < 1 + k) else 1.0 for zi, fr in zip(z, front)])

def sig(x, n=4):
    """Round to n significant digits (keeps the JSON small where full precision is not needed)."""
    x = float(x)
    if x == 0 or not math.isfinite(x): return x
    return float(f'{x:.{n - 1}e}')

def today():
    return datetime.date.today().isoformat()

def _clean(o):
    """NaN and infinities are not JSON: store them as null."""
    if isinstance(o, dict): return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [_clean(v) for v in o]
    if isinstance(o, np.generic): o = o.item()
    if isinstance(o, float) and not math.isfinite(o): return None
    return o

def dump(path, obj):
    with open(path, 'w') as fh: json.dump(_clean(obj), fh, separators=(',', ':'), allow_nan=False)
    import os
    print(f'wrote {path}  {os.path.getsize(path) / 1024:.0f} kB')
