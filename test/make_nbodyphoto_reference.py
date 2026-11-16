# Independent references for the photodynamics, mid-eclipse times and MEGNO of src/core/nbody.js,
# written to test/nbodyphoto_reference.json.
#
#   REBOUND 5.2.2 IAS15 : positions of star and planets at the sample times of a light curve, mid-transit and
#                         mid-eclipse times by bisection, MEGNO and Lyapunov exponent (variational equations)
#   batman 2.5          : its C kernel for quadratic limb darkening (Mandel & Agol), called on the sky-projected
#                         separations from REBOUND. batman's own Keplerian orbit is not used.
#
# Run:  .venv-nbody/bin/python test/make_nbodyphoto_reference.py
# batman lives in another environment (.venv-phase; override with BATMAN_PYTHON) and is called in a subprocess
# that reads separations on stdin. Nothing is installed anywhere.
#
# Conventions are those of test/make_nbody_reference.py: systems in the app's parameters (osculating Jacobi
# elements at `epoch`, planets added in order of period), Omega_REBOUND = Omega + 180 deg so that REBOUND's
# x, y, z are the app's X, Y (sky) and Z (toward the observer).
import json, math, os, subprocess, sys
import numpy as np
import rebound

GMSUN, AU, DAY, MJUP, RSUN, CLIGHT = 1.32712440018e20, 1.495978707e11, 86400.0, 9.5459426398e-4, 6.957e8, 299792458.0
G = GMSUN * DAY ** 2 / AU ** 3
HERE = os.path.dirname(os.path.abspath(__file__))
BATMAN_PY = os.environ.get('BATMAN_PYTHON', os.path.join(HERE, '..', '.venv-phase', 'bin', 'python'))

def mean_anomaly_at_transit(e, w):
    f = math.pi / 2 - w
    E = 2 * math.atan2(math.sqrt(1 - e) * math.sin(f / 2), math.sqrt(1 + e) * math.cos(f / 2))
    return E - e * math.sin(E)

def build(system, integrator='ias15'):
    sim = rebound.Simulation()
    sim.G = G
    sim.add(m=system['mstar'])
    order = sorted(range(len(system['planets'])), key=lambda i: system['planets'][i]['per'])
    for i in order:
        p = system['planets'][i]
        e, w = p.get('ecc', 0.0), math.radians(p.get('omega', 0.0))
        M = mean_anomaly_at_transit(e, w) + 2 * math.pi * (system['epoch'] - p['tmid']) / p['per']
        sim.add(m=p['mplanet'] * MJUP, P=p['per'], e=e, inc=math.radians(p.get('inc', 90.0)), omega=w,
                Omega=math.radians(p.get('Omega', 0.0)) + math.pi, M=M)
    sim.move_to_com()
    sim.t = system['epoch']
    sim.integrator = integrator
    return sim, order

def events(system, t_end, kind, event='conjunction'):
    """Mid-transit ('transit', z > 0) or mid-eclipse ('eclipse', z < 0) times of every planet, by bisection.
    Returns per planet (in the order of system['planets']) a list of [t, z_planet - z_star (AU), z_planet (barycentric, AU)]."""
    sim, order = build(system)
    n = len(order)
    def g(b):
        s, p = sim.particles[0], sim.particles[b + 1]
        if event == 'conjunction':
            return p.x - s.x          # Omega = 0 in these systems
        return (p.x - s.x) * (p.vx - s.vx) + (p.y - s.y) * (p.vy - s.vy)
    step = min(p['per'] * (1 - p.get('ecc', 0.0)) ** 1.5 for p in system['planets']) / 12.0
    out = [[] for _ in range(n)]
    gp = [g(b) for b in range(n)]
    t = sim.t
    while t < t_end:
        t1 = min(t + step, t_end)
        sim.integrate(t1)
        gn = [g(b) for b in range(n)]
        for b in range(n):
            if gp[b] * gn[b] < 0:
                lo, hi, glo = t, t1, gp[b]
                for _ in range(70):
                    mid = 0.5 * (lo + hi)
                    sim.integrate(mid)
                    if g(b) * glo > 0: lo = mid
                    else: hi = mid
                    if hi - lo < 1e-12: break
                tm = 0.5 * (lo + hi)
                sim.integrate(tm)
                s, p = sim.particles[0], sim.particles[b + 1]
                z = p.z - s.z
                sky = math.hypot(p.x - s.x, p.y - s.y)
                # 'minsep' also has roots at the largest separation (quadrature): keep those near the line of sight
                if (kind == 'transit') == (z > 0) and sky < abs(z):
                    out[order[b]].append([tm, z, p.z])
                sim.integrate(t1)
        gp = gn
        t = t1
    return out

def positions(system, times, ltt=False, rstar=1.0):
    """Sky position of each planet relative to the star [stellar radii] at observer times `times`, and whether it
    is in front. With ltt, each body is taken at the time its light left it: t' = t + Z(t') / c (barycentric Z),
    solved by four fixed-point iterations with fresh integrations."""
    sim, order = build(system)
    n = len(order)
    ru = rstar * RSUN / AU
    kap = AU / CLIGHT / DAY                      # days per AU
    X = np.zeros((n, len(times))); Y = np.zeros((n, len(times))); Z = np.zeros((n, len(times)))
    for k, t in enumerate(times):
        sim.integrate(t)
        ps = sim.particles
        if not ltt:
            for b in range(n):
                X[order[b], k] = (ps[b + 1].x - ps[0].x) / ru; Y[order[b], k] = (ps[b + 1].y - ps[0].y) / ru; Z[order[b], k] = (ps[b + 1].z - ps[0].z) / ru
            continue
        def body_at(i):
            tb = t
            for _ in range(4):
                sim.integrate(tb)
                tb = t + kap * sim.particles[i].z
            sim.integrate(tb)
            q = sim.particles[i]
            return q.x, q.y, q.z
        sx, sy, sz = body_at(0)
        for b in range(n):
            px, py, pz = body_at(b + 1)
            X[order[b], k] = (px - sx) / ru; Y[order[b], k] = (py - sy) / ru; Z[order[b], k] = (pz - sz) / ru
    return X, Y, Z

def batman_flux(d, rp, u1, u2):
    code = ("import sys, json, numpy as np\n"
            "from batman import _quadratic_ld\n"
            "q = json.load(sys.stdin)\n"
            "f = _quadratic_ld._quadratic_ld(np.ascontiguousarray(q['d'], dtype=np.float64), q['rp'], q['u1'], q['u2'], 1)\n"
            "json.dump([float(x) for x in f], sys.stdout)\n")
    r = subprocess.run([BATMAN_PY, '-c', code], input=json.dumps({'d': list(map(float, d)), 'rp': rp, 'u1': u1, 'u2': u2}), capture_output=True, text=True, check=True)
    return np.array(json.loads(r.stdout))

def light_curve(system, times, rprs, ld, ltt=False, exptime=0.0, nsub=1):
    """Flux of the star with each planet in front (batman kernel on REBOUND separations), averaged over nsub
    evenly spaced sub-exposures. Returns per-planet flux, their product, and the separations at mid-exposure."""
    tt = np.asarray(times)
    offs = [(j - (nsub - 1) / 2) * exptime / nsub for j in range(nsub)] if nsub > 1 else [0.0]
    n = len(system['planets'])
    per = np.zeros((n, len(tt))); prod = np.zeros(len(tt)); dmid = None
    for o in offs:
        X, Y, Z = positions(system, tt + o, ltt=ltt, rstar=system['rstar'])
        d = np.hypot(X, Y)
        d[Z <= 0] = 10.0                         # behind the star: no transit
        if o == 0.0 or dmid is None: dmid = d.copy()
        fl = np.array([batman_flux(d[p], rprs[p], ld[0], ld[1]) for p in range(n)])
        per += fl / len(offs); prod += np.prod(fl, axis=0) / len(offs)
    return per, prod, dmid

def megno(system, orbits_outer, integrator='ias15', seed=1):
    sim, _ = build(system, integrator)
    pmin = min(p['per'] for p in system['planets']); pmax = max(p['per'] for p in system['planets'])
    if integrator == 'whfast': sim.dt = pmin / 30
    sim.init_megno(seed=seed)
    try:
        sim.integrate(system['epoch'] + orbits_outer * pmax, exact_finish_time=0)
        return {'megno': sim.megno(), 'lyapunov': sim.lyapunov(), 't': sim.t - system['epoch']}
    except Exception as err:   # an escape or collision
        return {'megno': None, 'lyapunov': None, 't': sim.t - system['epoch'], 'error': str(err)}

out = {'generator': 'test/make_nbodyphoto_reference.py', 'rebound': rebound.__version__, 'constants': {'G': G, 'AU_light_days': AU / CLIGHT / DAY}}

# ---- a strongly perturbed pair: two giant planets just wide of 2:1
strong = {'mstar': 1.0, 'rstar': 1.0, 'epoch': 0.0, 'planets': [
    {'per': 10.0, 'tmid': 1.3, 'ecc': 0.04, 'omega': 30.0, 'inc': 89.5, 'mplanet': 1.0},
    {'per': 20.3, 'tmid': 6.1, 'ecc': 0.06, 'omega': -70.0, 'inc': 89.7, 'mplanet': 2.0}]}
rprs, ld, span = [0.10, 0.08], [0.40, 0.25], 125.0
tr = events(strong, span, 'transit'); ec = events(strong, span, 'eclipse')
trm = events(strong, span, 'transit', 'minsep'); ecm = events(strong, span, 'eclipse', 'minsep')
# sample times: 8-minute cadence within 0.33 d of every transit of either planet, and one point every 0.21 d elsewhere
grid = set()
for p in range(2):
    for t, _, _ in tr[p]:
        k0 = int(round(t / (8 / 1440.0)))
        for k in range(k0 - 59, k0 + 60): grid.add(k * 2)
for k in range(1, int(span / 0.21)): grid.add(int(round(k * 0.21 / (4 / 1440.0))))
times = np.array(sorted(g * (4 / 1440.0) for g in grid if 0.2 < g * (4 / 1440.0) < span - 0.2))
per, prod, d = light_curve(strong, times, rprs, ld)
per_l, prod_l, d_l = light_curve(strong, times, rprs, ld, ltt=True)
texp = times[np.arange(0, len(times), 3)]
per_e, prod_e, _ = light_curve(strong, texp, rprs, ld, exptime=30 / 1440.0, nsub=15)
out['strong'] = {
    'system': strong, 'rprs': rprs, 'ld_quadratic': ld, 'span': span,
    't': times.tolist(), 'flux': prod.tolist(), 'flux_planet': per.tolist(), 'd': np.minimum(d, 10).tolist(),
    'flux_ltt': prod_l.tolist(), 'd_ltt': np.minimum(d_l, 10).tolist(),
    'exposure': {'exptime': 30 / 1440.0, 'nsub': 15, 't': texp.tolist(), 'flux': prod_e.tolist()},
    'transits': [[x[0] for x in q] for q in tr], 'eclipses': [[x[0] for x in q] for q in ec],
    'transits_minsep': [[x[0] for x in q] for q in trm], 'eclipses_minsep': [[x[0] for x in q] for q in ecm],
    # barycentric Z of the planet at the events [AU]: the light-travel correction is -Z / c
    'transit_zbary': [[x[2] for x in q] for q in tr], 'eclipse_zbary': [[x[2] for x in q] for q in ec],
}
print('strong: %d times, %d + %d transits, %d + %d eclipses, deepest %.0f ppm' % (len(times), len(tr[0]), len(tr[1]), len(ec[0]), len(ec[1]), 1e6 * (1 - prod.min())))

# ---- eccentric single planet (HD 80606 b like) and the example pair: eclipse times
hd = {'mstar': 1.05, 'rstar': 1.05, 'epoch': 0.0, 'planets': [{'per': 111.4367, 'tmid': 8.0757, 'ecc': 0.93132, 'omega': -58.699, 'inc': 89.269, 'mplanet': 4.1}]}
out['hd80606'] = {'system': hd, 'eclipses': [x[0] for x in events(hd, 600.0, 'eclipse')[0]], 'transits': [x[0] for x in events(hd, 600.0, 'transit')[0]]}

# ---- MEGNO
regular = {'mstar': 0.95, 'rstar': 0.877, 'epoch': 0.0, 'planets': [
    {'per': 2.797436, 'tmid': 0.699359, 'ecc': 0, 'omega': 0, 'inc': 86.9, 'mplanet': 1.169},
    {'per': 5.3151284, 'tmid': 1.3287821, 'ecc': 0, 'omega': 0, 'inc': 85.0, 'mplanet': 0.1}]}
chaotic = {'mstar': 1.0, 'epoch': 0.0, 'planets': [
    {'per': 10.0, 'tmid': 0.7, 'ecc': 0, 'omega': 0, 'inc': 90.0, 'mplanet': 1.0},
    {'per': 12.3, 'tmid': 5.3, 'ecc': 0, 'omega': 0, 'inc': 90.0, 'mplanet': 1.0}]}
out['megno'] = {
    'regular': {'system': regular, 'orbits': 2000, 'ias15': megno(regular, 2000), 'whfast': megno(regular, 2000, 'whfast'), 'seed2': megno(regular, 2000, seed=2)},
    'strong': {'system': strong, 'orbits': 1000, 'ias15': megno(strong, 1000), 'seed2': megno(strong, 1000, seed=2)},
    'chaotic': {'system': chaotic, 'orbits': 2000, 'ias15': megno(chaotic, 2000), 'seed2': megno(chaotic, 2000, seed=2), 'whfast': megno(chaotic, 2000, 'whfast')},
}
for k, v in out['megno'].items(): print('megno', k, {a: b for a, b in v.items() if a not in ('system',)})

with open(os.path.join(HERE, 'nbodyphoto_reference.json'), 'w') as fh:
    json.dump(out, fh)
print('wrote test/nbodyphoto_reference.json')
