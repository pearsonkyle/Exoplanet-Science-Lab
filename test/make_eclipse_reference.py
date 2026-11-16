# Reference for the planner's secondary-eclipse windows (eclipseOffset, eclipseDurationRatio in src/core/observability.js).
#   .venv-validation/bin/python test/make_eclipse_reference.py   ->  test/eclipse_reference.json
# For random orbits (e up to 0.9, any omega, inclination near edge-on):
#   offset   time from mid-transit to mid-eclipse, from batman's TransitModel.get_t_secondary (batman's own
#            Kepler solve), taken modulo the period
#   t14, e14 first-to-fourth contact durations of the transit and of the eclipse, found here by brute force:
#            the sky-projected separation from a Kepler solve (scipy brentq on E - e sin E = M) and its crossings
#            of 1 + k located with brentq. Independent of both batman's and ESL's duration code.
# Convention (batman, Winn 2010): mid-transit at true anomaly f = pi/2 - omega, mid-eclipse at f = 3 pi/2 - omega.
import json, numpy as np, batman
from scipy.optimize import brentq

rng = np.random.default_rng(20261115)

def kepler_E(M, e):
    M = np.mod(M, 2 * np.pi)
    return brentq(lambda E: E - e * np.sin(E) - M, 0, 2 * np.pi, xtol=1e-14)

def sep(t, P, t0, e, w, a, inc, tp):
    M = 2 * np.pi * (t - tp) / P
    E = kepler_E(M, e)
    f = 2 * np.arctan2(np.sqrt(1 + e) * np.sin(E / 2), np.sqrt(1 - e) * np.cos(E / 2))
    r = a * (1 - e * np.cos(E))
    X = -r * np.cos(w + f); Y = -r * np.sin(w + f) * np.cos(inc)
    return np.hypot(X, Y)

def t_of_f(f, P, e, tp):
    E = 2 * np.arctan2(np.sqrt(1 - e) * np.sin(f / 2), np.sqrt(1 + e) * np.cos(f / 2))
    return tp + P * (E - e * np.sin(E)) / (2 * np.pi)

def duration(tc, P, e, w, a, inc, tp, lim):
    g = lambda t: sep(t, P, 0, e, w, a, inc, tp) - lim
    if g(tc) >= 0: return 0.0
    h = P * 1e-4
    lo = tc - h
    while g(lo) < 0: lo -= h
    hi = tc + h
    while g(hi) < 0: hi += h
    return brentq(g, tc, hi, xtol=1e-12) - brentq(g, lo, tc, xtol=1e-12)

cases = []
while len(cases) < 240:
    P = float(rng.uniform(0.5, 30)); e = float(rng.choice([0.0, rng.uniform(0, 0.3), rng.uniform(0, 0.9)])); w = float(rng.uniform(0, 360))
    a = float(rng.uniform(4, 40)); k = float(rng.uniform(0.03, 0.15)); t0 = float(rng.uniform(2455000, 2460000))
    # inclination: transit impact parameter below 0.7
    rho_t = a * (1 - e * e) / (1 + e * np.sin(np.radians(w)))
    b = float(rng.uniform(0, 0.7)); inc = float(np.degrees(np.arccos(b / rho_t)))
    pm = batman.TransitParams(); pm.t0, pm.per, pm.rp, pm.a, pm.inc, pm.ecc, pm.w, pm.limb_dark, pm.u, pm.fp = t0, P, k, a, inc, e, w, 'quadratic', [0.3, 0.2], 1e-3
    m = batman.TransitModel(pm, np.array([t0]))
    off = float(np.mod(m.get_t_secondary(pm) - t0, P))
    # brute-force durations about our own Kepler solve, with the periastron time set so that f = pi/2 - w at t0
    W = np.radians(w); tp = t0 - (t_of_f(np.pi / 2 - W, P, e, 0.0) - 0.0)
    tecl = t0 + off
    t14 = duration(t0, P, e, W, a, np.radians(inc), tp, 1 + k)
    e14 = duration(tecl, P, e, W, a, np.radians(inc), tp, 1 + k)
    if not (t14 > 0 and e14 > 0): continue
    cases.append(dict(per=P, tmid=t0, ecc=e, omega=w, ars=a, inc=inc, rprs=k, offset=off, t14=t14, e14=e14))

json.dump({'made_with': {'batman': batman.__version__, 'numpy': np.__version__}, 'cases': cases}, open('test/eclipse_reference.json', 'w'), indent=0)
print(len(cases), 'cases; e up to', max(c['ecc'] for c in cases))
