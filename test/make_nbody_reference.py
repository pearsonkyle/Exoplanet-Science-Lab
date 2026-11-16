# Independent references for src/core/nbody.js, written to test/nbody_reference.json.
#
#   REBOUND (IAS15, epsilon 1e-9, and WHFast) : positions, energy, transit times, radial velocities
#   TTVFast (Deck et al. 2014)                : transit times of the same systems
#   EXOTIC exotic/api/nbody.py                : its own generate() / transit_times() / TTV() on its example
#   scipy                                     : critical AMD of Laskar & Petit (2017) by direct minimisation
#
# Run with the project's own environment (never EXOTIC's):
#   python3 -m venv .venv-nbody && .venv-nbody/bin/pip install rebound numpy scipy ttvfast
#   .venv-nbody/bin/python test/make_nbody_reference.py
# The EXOTIC part is run in a subprocess with EXOTIC's interpreter (default
# /Users/kpearson/miniconda3/envs/exotic/bin/python, override with EXOTIC_PYTHON); nothing is installed there
# (it already has rebound). Without it the "exotic" entry is null and the test skips that block.
#
# Conventions. Systems are written in the app's parameters (per, tmid, ecc, omega, inc, Omega in degrees, mplanet
# in Jupiter masses; osculating Jacobi elements at `epoch`). They are converted here, independently of the
# JavaScript, to REBOUND's: planets sorted by period and added with their Jacobi elements (REBOUND's default
# primary is the centre of mass of what is already there), Omega_REBOUND = Omega + 180 deg, mean anomaly from
# tmid. With that node REBOUND's x, y, z are the app's X, Y, Z (sky plane, +Z toward the observer).
import json, math, os, subprocess, sys, time
import numpy as np
import rebound

# the constants of src/core/derive.js
GMSUN, AU, DAY, MJUP = 1.32712440018e20, 1.495978707e11, 86400.0, 9.5459426398e-4
G = GMSUN * DAY ** 2 / AU ** 3
MEARTH_MJUP = 1.0 / 317.82838

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

def gfun(sim, body, event, node):
    s, p = sim.particles[0], sim.particles[body]
    x, y, vx, vy = p.x - s.x, p.y - s.y, p.vx - s.vx, p.vy - s.vy
    if event == 'conjunction':
        return x * math.cos(node) + y * math.sin(node)
    return x * vx + y * vy

def transit_times(system, t_end, event):
    """Mid-transit times of every planet by bisection on the event function with IAS15."""
    sim, order = build(system)
    n = len(order)
    nodes = [math.radians(system['planets'][i].get('Omega', 0.0)) for i in order]
    # sampling: a twelfth of the shortest periastron passage, so that no sign change of the event function is missed
    step = min(p['per'] * (1 - p.get('ecc', 0.0)) ** 1.5 for p in system['planets']) / 12.0
    out = [[] for _ in range(n)]
    extra = [[] for _ in range(n)]
    gp = [gfun(sim, b + 1, event, nodes[b]) for b in range(n)]
    t = sim.t
    while t < t_end:
        t1 = min(t + step, t_end)
        sim.integrate(t1)
        gn = [gfun(sim, b + 1, event, nodes[b]) for b in range(n)]
        for b in range(n):
            if gp[b] < 0 <= gn[b]:
                lo, hi = t, t1
                for _ in range(60):
                    mid = 0.5 * (lo + hi)
                    sim.integrate(mid)
                    if gfun(sim, b + 1, event, nodes[b]) < 0: lo = mid
                    else: hi = mid
                    if hi - lo < 2e-12: break
                tm = 0.5 * (lo + hi)
                sim.integrate(tm)
                s, p = sim.particles[0], sim.particles[b + 1]
                if p.z - s.z > 0:
                    out[b].append(tm)
                    extra[b].append([math.hypot(p.x - s.x, p.y - s.y), math.hypot(p.vx - s.vx, p.vy - s.vy)])
                sim.integrate(t1)
        gp, t = gn, t1
    # back to the caller's planet order
    res = [None] * n; ex = [None] * n
    for b, i in enumerate(order): res[i] = out[b]; ex[i] = extra[b]
    return res, ex

def snapshot(sim):
    return [[p.x, p.y, p.z, p.vx, p.vy, p.vz] for p in sim.particles]

def reference(name, system, span, n_rv=30, t_start=None, steps_per_orbit=20, corrector=5):
    print('...', name, flush=True)
    t_end = system['epoch'] + span
    out = {'system': system, 'tEnd': t_end}
    sim, order = build(system)
    out['order'] = order
    out['initial'] = snapshot(sim)
    out['energy0'] = sim.energy()
    L = sim.angular_momentum(); out['angmom0'] = [L[0], L[1], L[2]]
    # transit times, both definitions
    tt, ex = transit_times(system, t_end, 'minsep'); out['minsep'] = tt; out['minsep_bv'] = ex
    out['conjunction'], _ = transit_times(system, t_end, 'conjunction')
    # radial velocity of the star and a mid-run snapshot
    rv_t = list(np.linspace(system['epoch'] + 0.013 * span, t_end - 0.017 * span, n_rv))
    rv = []
    for t in rv_t:
        sim.integrate(t); rv.append(-sim.particles[0].vz * AU / DAY)
    out['rv_t'], out['rv'] = rv_t, rv
    t0 = time.perf_counter(); sim.integrate(t_end);
    out['final'] = snapshot(sim); out['energy1'] = sim.energy()
    # backward leg
    if t_start is not None:
        simb, _ = build(system)
        # reverse time: REBOUND integrates backward when tmax < t
        simb.integrate(t_start)
        out['tStart'] = t_start; out['backward'] = snapshot(simb)
        # transits before the epoch: integrate a mirrored copy forward from t_start
        sim2, _ = build(system); sim2.integrate(t_start)
        nodes = [math.radians(system['planets'][i].get('Omega', 0.0)) for i in order]
        back = [[] for _ in order]
        step = min(p['per'] * (1 - p.get('ecc', 0.0)) ** 1.5 for p in system['planets']) / 12.0
        t = t_start; gp = [gfun(sim2, b + 1, 'minsep', nodes[b]) for b in range(len(order))]
        while t < system['epoch']:
            t1 = min(t + step, system['epoch']); sim2.integrate(t1)
            gn = [gfun(sim2, b + 1, 'minsep', nodes[b]) for b in range(len(order))]
            for b in range(len(order)):
                if gp[b] < 0 <= gn[b]:
                    lo, hi = t, t1
                    for _ in range(60):
                        mid = 0.5 * (lo + hi); sim2.integrate(mid)
                        if gfun(sim2, b + 1, 'minsep', nodes[b]) < 0: lo = mid
                        else: hi = mid
                        if hi - lo < 2e-12: break
                    sim2.integrate(0.5 * (lo + hi))
                    if sim2.particles[b + 1].z - sim2.particles[0].z > 0: back[b].append(0.5 * (lo + hi))
                    sim2.integrate(t1)
            gp, t = gn, t1
        res = [None] * len(order)
        for b, i in enumerate(order): res[i] = back[b]
        out['minsep_before'] = res
    # WHFast with the step and corrector the JavaScript is run with: the same map, so the states should agree
    # to rounding amplified by the dynamics. Also the speed of the C code.
    pmin = min(p['per'] for p in system['planets'])
    dt = pmin / steps_per_orbit
    simw, _ = build(system, 'whfast')
    simw.dt = dt; simw.integrator.corrector = corrector; simw.integrator.safe_mode = 0
    nsteps = int(math.ceil(span / dt - 1e-9))
    t0 = time.perf_counter(); simw.steps(nsteps); wall = time.perf_counter() - t0
    simw.synchronize()
    out['whfast'] = {'dt': dt, 'corrector': corrector, 'steps': nsteps, 't': simw.t, 'state': snapshot(simw), 'energy': simw.energy(), 'seconds': wall}
    # IAS15 speed over the same span, no outputs
    simi, _ = build(system); t0 = time.perf_counter(); simi.integrate(t_end); out['ias15_seconds'] = time.perf_counter() - t0
    out['ias15_steps'] = simi.steps_done
    return out

def ttvfast_reference(system, span, dt_frac=1.0 / 100):
    """
    TTVFast transit times (minimum projected separation, observer along +z like here).

    'times': from astrocentric Cartesian initial conditions (input_flag 2) taken from the REBOUND system above, so
    the two codes integrate the same physical system. The Python wrapper fixes G = 0.000295994511 AU^3/d^2/M_sun,
    2.8e-4 above the IAU value; lengths are rescaled by (G_ttvfast/G)^(1/3), which leaves every time unchanged.

    'times_elements': from the same Jacobi elements (input_flag 0). TTVFast turns a Jacobi period into a
    semi-major axis with GM = G M* eta_k / eta_(k-1) (Wisdom & Holman 1991), REBOUND and this app with G eta_k
    (eta_k = M* + m_1 + ... + m_k). For every planet but the innermost the same numbers therefore describe a
    slightly different orbit; kept to document the size of that difference of convention.
    """
    try:
        import ttvfast
    except Exception as exc:
        print('TTVFast not available:', exc); return None
    order = sorted(range(len(system['planets'])), key=lambda i: system['planets'][i]['per'])
    dt = dt_frac * min(p['per'] for p in system['planets'])
    def collect(r):
        idx, _, tt, rsky, vsky = r['positions']
        out = [None] * len(order)
        for b, i in enumerate(order):
            out[i] = [t for k, t in zip(idx, tt) if k == b and t > -1.0]
        return out
    sim, _ = build(system)
    lam = (0.000295994511 / G) ** (1.0 / 3.0)
    s = sim.particles[0]
    cart = [ttvfast.models.Planet(sim.particles[b + 1].m, lam * (sim.particles[b + 1].x - s.x), lam * (sim.particles[b + 1].y - s.y), lam * (sim.particles[b + 1].z - s.z),
                                  lam * (sim.particles[b + 1].vx - s.vx), lam * (sim.particles[b + 1].vy - s.vy), lam * (sim.particles[b + 1].vz - s.vz)) for b in range(len(order))]
    times = collect(ttvfast.ttvfast(cart, system['mstar'], system['epoch'], dt, system['epoch'] + span, input_flag=2))
    planets = []
    for i in order:
        p = system['planets'][i]
        e, w = p.get('ecc', 0.0), math.radians(p.get('omega', 0.0))
        M = mean_anomaly_at_transit(e, w) + 2 * math.pi * (system['epoch'] - p['tmid']) / p['per']
        planets.append(ttvfast.models.Planet(mass=p['mplanet'] * MJUP, period=p['per'], eccentricity=e, inclination=p.get('inc', 90.0),
                                             longnode=p.get('Omega', 0.0) + 180.0, argument=p.get('omega', 0.0), mean_anomaly=math.degrees(M) % 360.0))
    elements = collect(ttvfast.ttvfast(planets, system['mstar'], system['epoch'], dt, system['epoch'] + span, input_flag=0))
    return {'dt_frac': dt_frac, 'times': times, 'times_elements': elements}

EXOTIC_SNIPPET = r'''
import json, sys, time
import numpy as np
from exotic.api import nbody as nb
objects = [
    {'m': 0.95},
    {'m': 1.169 * nb.mjup / nb.msun, 'P': 2.797436, 'inc': 3.14159 / 2, 'e': 0, 'omega': 0},
    {'m': 0.1 * nb.mjup / nb.msun, 'P': 2.797436 * 1.9, 'inc': 3.14159 / 2, 'e': 0.0, 'omega': 0},
]   # examples/nbody/example.py (HAT-P-37)
n_orbits = int(sys.argv[1])
ndays, nout = objects[1]['P'] * n_orbits, int(n_orbits * objects[1]['P'] * 24)
t0 = time.time(); sim_data = nb.generate(objects, ndays, nout); wall = time.time() - t0
out = {'objects': objects, 'n_orbits': n_orbits, 'ndays': ndays, 'noutputs': nout, 'seconds': wall, 'planets': []}
for j in (0, 1):
    tt = nb.transit_times(sim_data['pdata'][j]['x'], sim_data['star']['x'], sim_data['times'])
    ttv, per, t0fit = nb.TTV(np.arange(len(tt)), tt)
    out['planets'].append({'tt': tt.tolist(), 'ttv': np.asarray(ttv).tolist(), 'P': float(per), 't0': float(t0fit), 'max': float(nb.maxavg(ttv))})
# radial velocity as analyze() computes it in this working copy (line of sight), at a few samples
rv = -np.diff(sim_data['star']['z']) * 1.496e11 * sim_data['dt']
idx = list(range(5, 400, 23))
out['rv'] = {'t_mid': [float(0.5 * (sim_data['times'][i] + sim_data['times'][i + 1])) for i in idx], 'v': [float(rv[i]) for i in idx], 'max': float(nb.maxavg(rv))}
out['rv_sky_axis'] = [float(v) for v in (np.diff(sim_data['star']['x']) * 1.496e11 * sim_data['dt'])[idx]]
import rebound
out['rebound_version'] = rebound.__version__
try:
    a = nb.analyze(sim_data)
    out['peak_periods_epochs'] = [float(v) for v in a['planets'][0]['peak_periods'][:3]]
except Exception as exc:
    out['analyze_error'] = repr(exc)
print('JSON' + json.dumps(out))
'''

def exotic_reference(n_orbits=400):
    py = os.environ.get('EXOTIC_PYTHON', '/Users/kpearson/miniconda3/envs/exotic/bin/python')
    if not os.path.exists(py):
        print('EXOTIC interpreter not found:', py); return None
    r = subprocess.run([py, '-c', EXOTIC_SNIPPET, str(n_orbits)], capture_output=True, text=True)
    lines = [l for l in r.stdout.splitlines() if l.startswith('JSON')]
    if not lines:
        print('EXOTIC run failed:\n', r.stderr[-2000:]); return None
    return json.loads(lines[-1][4:])

def amd_reference():
    """Critical relative AMD (Laskar & Petit 2017) by brute-force minimisation over the collision line."""
    from scipy.optimize import minimize_scalar
    out = []
    for alpha in (0.3, 0.5, 0.63, 0.75, 0.9):
        for gamma in (0.01, 0.3, 1.0, 5.0, 100.0):
            def amd(e):
                ep = 1 - alpha - alpha * e
                return gamma * math.sqrt(alpha) * (1 - math.sqrt(1 - e * e)) + 1 - math.sqrt(1 - ep * ep)
            r = minimize_scalar(amd, bounds=(0.0, min(1.0, 1 / alpha - 1)), method='bounded', options={'xatol': 1e-14})
            out.append({'alpha': alpha, 'gamma': gamma, 'Cc': r.fun, 'e': r.x})
    return out

if __name__ == '__main__':
    P1 = 2.797436
    tr1 = {  # TRAPPIST-1 (Agol et al. 2021, Table 2; masses in Earth masses)
        'per': [1.510826, 2.421937, 4.049219, 6.101013, 9.207540, 12.352446, 18.772866],
        'me': [1.374, 1.308, 0.388, 0.692, 1.039, 1.321, 0.326],
        'ecc': [0.00622, 0.00654, 0.00837, 0.00510, 0.01007, 0.00208, 0.00567],
        'omega': [336.86, 282.45, -8.73, 108.37, 368.81, 191.34, 338.92],
        'inc': [89.728, 89.778, 89.896, 89.793, 89.740, 89.742, 89.805],
        'tmid': [0.21, 1.07, 2.95, 0.66, 5.43, 3.31, 9.92],
    }
    systems = {
        # EXOTIC's examples/nbody/example.py: both planets start at true anomaly 0 with omega = 0, a quarter orbit before transit
        'exotic_example': ({'mstar': 0.95, 'rstar': 0.877, 'epoch': 0.0, 'planets': [
            {'per': P1, 'tmid': P1 / 4, 'ecc': 0.0, 'omega': 0.0, 'inc': math.degrees(3.14159 / 2), 'mplanet': 1.169, 'rprs': 0.138},
            {'per': P1 * 1.9, 'tmid': P1 * 1.9 / 4, 'ecc': 0.0, 'omega': 0.0, 'inc': math.degrees(3.14159 / 2), 'mplanet': 0.1, 'rprs': 0.04}]}, 400 * P1, {}),
        'near_2to1': ({'mstar': 0.95, 'rstar': 0.877, 'epoch': 2459150.0, 'planets': [
            {'per': P1, 'tmid': 2459150.9, 'ecc': 0.02, 'omega': 75.0, 'inc': 87.4, 'Omega': 0.0, 'mplanet': 1.169, 'rprs': 0.138},
            {'per': P1 * 1.9, 'tmid': 2459152.3, 'ecc': 0.04, 'omega': 210.0, 'inc': 88.6, 'Omega': 4.0, 'mplanet': 0.1, 'rprs': 0.04}]}, 300 * P1, {}),
        'near_3to2': ({'mstar': 1.0, 'rstar': 1.0, 'epoch': 700.0, 'planets': [
            {'per': 15.21, 'tmid': 707.2, 'ecc': 0.03, 'omega': 200.0, 'inc': 89.7, 'Omega': 1.5, 'mplanet': 0.05, 'rprs': 0.03},
            {'per': 10.0, 'tmid': 703.1, 'ecc': 0.02, 'omega': 30.0, 'inc': 89.5, 'Omega': 0.0, 'mplanet': 0.03, 'rprs': 0.025}]}, 800.0, {'t_start': 0.0}),
        'trappist1': ({'mstar': 0.0898, 'rstar': 0.1192, 'epoch': 0.0, 'planets': [
            {'per': tr1['per'][i], 'tmid': tr1['tmid'][i], 'ecc': tr1['ecc'][i], 'omega': tr1['omega'][i], 'inc': tr1['inc'][i], 'Omega': 0.0,
             'mplanet': tr1['me'][i] * MEARTH_MJUP, 'rprs': 0.07} for i in range(7)]}, 150.0, {}),
        'hd80606_massless': ({'mstar': 1.05, 'rstar': 1.05, 'epoch': 2458880.0, 'planets': [
            {'per': 111.4367, 'tmid': 2458888.0757, 'ecc': 0.93132, 'omega': -58.699, 'inc': 89.269, 'mplanet': 0.0, 'rprs': 0.1}]}, 20 * 111.4367, {}),
        'hd80606': ({'mstar': 1.05, 'rstar': 1.05, 'epoch': 2458880.0, 'planets': [
            {'per': 111.4367, 'tmid': 2458888.0757, 'ecc': 0.93132, 'omega': -58.699, 'inc': 89.269, 'mplanet': 4.2, 'rprs': 0.1}]}, 20 * 111.4367, {'steps_per_orbit': 2000}),
        'hj_companion': ({'mstar': 1.1, 'rstar': 1.2, 'epoch': 100.0, 'planets': [
            {'per': 3.5, 'tmid': 101.3, 'ecc': 0.0, 'omega': 0.0, 'inc': 87.0, 'Omega': 0.0, 'mplanet': 1.0, 'rprs': 0.1},
            {'per': 120.0, 'tmid': 161.0, 'ecc': 0.4, 'omega': 70.0, 'inc': 85.0, 'Omega': 10.0, 'mplanet': 8.0, 'rprs': 0.1}]}, 1050.0, {}),
    }
    ref = {'constants': {'G': G, 'AU': AU, 'DAY': DAY, 'MJUP': MJUP}, 'rebound_version': rebound.__version__, 'systems': {}}
    for name, (system, span, kw) in systems.items():
        r = reference(name, system, span, **kw)
        r['span'] = span
        if name in ('near_2to1', 'near_3to2', 'trappist1', 'hj_companion', 'exotic_example'):
            r['ttvfast'] = ttvfast_reference(system, span)
        ref['systems'][name] = r
    ref['exotic'] = exotic_reference(400)
    ref['amd'] = amd_reference()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nbody_reference.json')
    with open(path, 'w') as f:
        json.dump(ref, f)
    print('wrote', path, os.path.getsize(path), 'bytes')
