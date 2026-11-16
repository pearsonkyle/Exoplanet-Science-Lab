# Transit light curves: every installed code against a quadrature truth, on a grid of geometries and limb darkening laws.
#   .venv-validation/bin/python tools/validation/make_transit.py      (from the project root; about 2 minutes)
# Writes public/validation/transit.json. Stores the truth at full precision and each code's (flux - truth).
# ESL is not run here: the page and test/validation.test.mjs compute its side from the same inputs.
import json, math, os, subprocess, sys, tempfile, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE)
from common import *
import codes
from make_transit_util import run_ext, PYANETI, EXOTIC
N = 121
Q, C4, COOL = [0.40, 0.26], [0.4939, -0.0729, 0.4578, -0.2158], [0.6, -0.4, 0.9, -0.3]

def inc_from_b(b, ars, e=0.0, w=0.0):
    return math.degrees(math.acos(min(1.0, b / ars * (1 + e * math.sin(math.radians(w))) / (1 - e * e))))
def case(group, label, law, ld, rprs=0.1, b=0.3, ars=10.0, per=3.5, ecc=0.0, omega=0.0, inc=None, tmid=0.1):
    inc = inc_from_b(b, ars, ecc, omega) if inc is None else inc
    return dict(group=group, label=label, law=law, ld=ld, rprs=rprs, per=per, tmid=tmid, ars=ars, inc=inc, ecc=ecc, omega=omega)
cases = []
for law, ld, nm in (('quadratic', Q, 'quadratic'), ('nonlinear', C4, 'Claret')):
    for k in (0.01, 0.03, 0.1, 0.2, 0.3): cases.append(case('radius ratio', f'Rp/R* = {k}, {nm}', law, ld, rprs=k))
    for b in (0.0, 0.5, 0.85, 0.95, 1.0, 1.05, 1.2): cases.append(case('impact parameter', f'b = {b}, {nm}', law, ld, b=b))
    cases.append(case('eccentric', f'e = 0.3, omega = 30, {nm}', law, ld, ecc=0.3, omega=30, per=5.3, ars=12))
    cases.append(case('eccentric', f'e = 0.6, omega = 110, {nm}', law, ld, ecc=0.6, omega=110, per=9.0, ars=18))
    cases.append(case('eccentric', f'e = 0.6, omega = 250, {nm}', law, ld, ecc=0.6, omega=250, per=9.0, ars=18))
    cases.append(case('eccentric', f'e = 0.93, omega = -58.7 (HD 80606 b), {nm}', law, ld, ecc=0.93132, omega=-58.699, per=111.4367, ars=94.45, inc=89.269))
    cases.append(case('eccentric', f'e = 0.93, omega = 120, {nm}', law, ld, ecc=0.93, omega=120, per=40.0, ars=40.0))
for a in (2.5, 30.0, 200.0): cases.append(case('a/R*', f'a/R* = {a:g}, quadratic', 'quadratic', Q, ars=a, per={2.5: 0.8, 30.0: 18.0, 200.0: 300.0}[a]))
cases.append(case('law', 'uniform disc', 'uniform', []))
cases.append(case('law', 'linear, u = 0.6', 'linear', [0.6]))
cases.append(case('law', 'Claret, cool star', 'nonlinear', COOL))
cases.append(case('law', 'uniform disc, e = 0.6, omega = 110', 'uniform', [], ecc=0.6, omega=110, per=9.0, ars=18))

def window(c):
    """Half-width of the time grid: a little more than half the transit (or what it would be at b = 0)."""
    e, w = c['ecc'], math.radians(c['omega'])
    fac = math.sqrt(1 - e * e) / (1 + e * math.sin(w))
    return 0.62 * c['per'] / math.pi * math.asin(min(1.0, (1 + c['rprs']) / c['ars'])) * fac

def isolated(name, c, t):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'ext_isolated.py'), name], input=json.dumps(dict({k: v for k, v in c.items() if not k.startswith('_')}, t=list(map(float, t)))), capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError(f'process died with exit code {r.returncode} ({"signal " + str(-r.returncode) if r.returncode < 0 else (r.stderr.strip().splitlines() or ["?"])[-1][:120]})')
    return np.asarray(json.loads(r.stdout.split('RESULT ')[-1]))

# ---- truth and the in-process codes
t0 = time.time(); worst_mp = 0.0
names = list(codes.LC) + ['exoplanet-core (kernel)', 'pyaneti', 'EXOTIC']
for c in cases:
    h = window(c); c['t0'] = c['tmid'] - h; c['t1'] = c['tmid'] + h; c['n'] = N; c['dtMinSep'] = dt_min_sep(c)
    t = np.linspace(c['t0'], c['t1'], N); c['_t'] = t
    z, fr = truth_sep(t, c); c['_z'], c['_fr'] = z, fr
    tr = truth_flux(t, c, z, fr); c['_truth'] = tr
    a = to_claret(c['law'], c['ld'])
    for i in range(3, N, 9):                    # independent check of the truth kernel in 30-digit arithmetic
        worst_mp = max(worst_mp, abs((1 - blocked_mp(z[i], c['rprs'], a) if fr[i] and z[i] < 1 + c['rprs'] else 1.0) - tr[i]))
    c['_res'] = {}
    for name, f in codes.LC.items():
        try:
            if os.environ.get('VAL_TRACE'): print(c['label'], '|', name, flush=True)
            y = isolated(name, c, t) if (name == 'PyAstronomy' and c['law'] == 'nonlinear') else f(c, t)
            if y is not None: c['_res'][name] = np.asarray(y, float) - tr
        except Exception as ex:
            c['_res'][name] = None; c.setdefault('errors', {})[name] = f'{type(ex).__name__}: {str(ex)[:160]}'
    y = codes.lc_exoplanet_core(c, t, z, fr)
    if y is not None: c['_res']['exoplanet-core (kernel)'] = y - tr
print(f'truth and in-process codes: {time.time() - t0:.0f} s; scipy vs mpmath kernel max {worst_mp:.1e}')

# ---- timing set: 1000 points across a transit, parameters changed on every call
tim_cases = [dict(case('timing', 'circular, quadratic, 1000 points', 'quadratic', Q), key='circular quadratic'),
             dict(case('timing', 'e = 0.3, Claret, 1000 points', 'nonlinear', C4, ecc=0.3, omega=30, per=5.3, ars=12), key='eccentric Claret')]
for c in tim_cases: c['dtMinSep'] = dt_min_sep(c); h = window(c); c['t'] = np.linspace(c['tmid'] - h, c['tmid'] + h, 1000).tolist()

# ---- exposure-time integration: circular orbit, quadratic law; truth = 4001-point average of the exact kernel
import exoplanet_core as ec
def circ_z(t, c):
    ph = 2 * math.pi * (t - c['tmid']) / c['per']; ci = math.cos(math.radians(c['inc']))
    return np.where(np.cos(ph) > 0, c['ars'] * np.sqrt(np.sin(ph) ** 2 + (ci * np.cos(ph)) ** 2), 10.0)
def exact_quad(t, c): return 1 + np.asarray(ec.quad_limbdark_light_curve(c['ld'][0], c['ld'][1], circ_z(np.asarray(t), c), c['rprs']))
def exp_truth(t, c, texp, m=4001):
    off = (np.arange(m) - (m - 1) / 2) / m * texp
    return np.array([exact_quad(ti + off, c).mean() for ti in t])
exposure = []
for label, texp, kw in (('30 min exposures, hot Jupiter (ingress 21 min)', 30 / 1440, {}), ('2 min exposures, same planet', 2 / 1440, {}),
                        ('30 min exposures, small planet on a 1 d orbit (ingress 1.6 min)', 30 / 1440, dict(rprs=0.02, ars=4.0, per=1.0))):
    c = case('exposure', label, 'quadratic', Q, **kw); h = window(c) + texp
    t = np.linspace(c['tmid'] - h, c['tmid'] + h, 81); tr = exp_truth(t, c, texp)
    conv = float(np.max(np.abs(tr - exp_truth(t, c, texp, 2001))))
    e = dict(label=label, p={k: c[k] for k in ('rprs', 'per', 'tmid', 'ars', 'inc', 'ecc', 'omega', 'law', 'ld')}, exptime=texp, t0=float(t[0]), t1=float(t[-1]), n=len(t),
             truth=tr.tolist(), truthConvergence=sig(conv, 2), instantaneous=[sig(x, 4) for x in (exact_quad(t, c) - tr)], codes={}, _c=c, _t=t)
    import batman, pytransit
    for ns in (3, 7, 15, 31):
        e['codes'].setdefault('batman', {})[str(ns)] = [sig(x, 3) for x in (codes.lc_batman(c, t, supersample_factor=ns, exp_time=texp) - tr)]
        m = pytransit.QuadraticModel(); m.set_data(t, nsamples=ns, exptimes=texp)
        e['codes'].setdefault('PyTransit', {})[str(ns)] = [sig(x, 3) for x in (m.evaluate(c['rprs'], c['ld'], c['tmid'], c['per'], c['ars'], math.radians(c['inc']), 0.0, 0.0) - tr)]
    exposure.append(e)

# ---- special points of the kernel: where closed-form solutions change branch (z = p, the limb, the centre)
from batman import _quadratic_ld
special = []
for p in (0.05, 0.1, 0.3):
    zs = [('z = 0', 0.0), ('z = 1e-12', 1e-12)]
    for d in (-1e-10, -1e-12, -1e-14, 0.0, 1e-14, 1e-12, 1e-10): zs.append((f'z = p {d:+.0e}' if d else 'z = p', p + d))
    for d in (-1e-10, -1e-13, 0.0, 1e-13, 1e-10): zs.append((f'z = 1 - p {d:+.0e}' if d else 'z = 1 - p', 1 - p + d))
    for d in (-1e-10, -1e-13, 0.0): zs.append((f'z = 1 + p {d:+.0e}' if d else 'z = 1 + p', 1 + p + d))
    zs.append(('z = 1', 1.0))
    for lab, z in zs:
        tr = 1 - blocked_mp(z, p, to_claret('quadratic', Q))
        special.append({'p': p, 'label': lab, 'z': z, 'truth': tr, 'u': Q,
                        'batman': sig(_quadratic_ld._quadratic_ld(np.array([z]), p, Q[0], Q[1], 1)[0] - tr, 3),
                        'exoplanet-core': sig(1 + ec.quad_limbdark_light_curve(Q[0], Q[1], np.array([z]), p)[0] - tr, 3)})

# ---- codes that live in other interpreters
strip = lambda c: {k: v for k, v in c.items() if not k.startswith('_')}
payload = {'lc': [dict(strip(c), t=c['_t'].tolist()) for c in cases] + [dict(strip(e['_c']), t=e['_t'].tolist(), n_cad=ns, t_cad=e['exptime']) for e in exposure for ns in (3, 7, 15, 31)],
           'timing': tim_cases}
ext_versions = {}
for name, py, script in (('pyaneti', PYANETI, 'ext_pyaneti.py'), ('EXOTIC', EXOTIC, 'ext_exotic.py')):
    out = run_ext(py, script, payload)
    if out is None: ext_versions[name] = 'failed to run'; continue
    ext_versions[name] = out['version']
    for c, y in zip(cases, out['lc'][:len(cases)]):
        if y is not None: c['_res'][name] = np.asarray(y) - c['_truth']
    if name == 'pyaneti':
        ys = out['lc'][len(cases):]
        for i, e in enumerate(exposure):
            for j, ns in enumerate((3, 7, 15, 31)): e['codes'].setdefault('pyaneti', {})[str(ns)] = [sig(x, 3) for x in (np.asarray(ys[4 * i + j]) - np.asarray(e['truth']))]
    for c, r in zip(tim_cases, out['timing']): c.setdefault('rate', {})[name] = r

# ---- timing of the in-process codes (model object reused, parameters reassigned each call, as a fit would)
def rate(fn, tmin=1.0):
    fn(); n = 0; s = time.perf_counter()
    while time.perf_counter() - s < tmin:
        for _ in range(10): fn()
        n += 10
    return n / (time.perf_counter() - s)
import batman, pytransit, ellc, pylightcurve as plc
from PyAstronomy.modelSuite import forTrans as ft
for c in tim_cases:
    t = np.asarray(c['t']); r = c.setdefault('rate', {}); DEG = math.pi / 180
    bp = codes._batman_params(c); bm = batman.TransitModel(bp, t)
    def f_b(): bp.rp = c['rprs'] * (1 + 1e-6 * np.random.rand()); return bm.light_curve(bp)
    r['batman'] = rate(f_b)
    if c['law'] == 'nonlinear':
        bm2 = batman.TransitModel(bp, t, max_err=1e-3)
        def f_b2(): bp.rp = c['rprs'] * (1 + 1e-6 * np.random.rand()); return bm2.light_curve(bp)
        r['batman (max_err 0.001 ppm)'] = rate(f_b2)
    pm = pytransit.QuadraticModel() if c['law'] == 'quadratic' else pytransit.RoadRunnerModel('nonlinear'); pm.set_data(t)
    r['PyTransit'] = rate(lambda: pm.evaluate(c['rprs'] * (1 + 1e-6 * np.random.rand()), list(c['ld']), c['tmid'], c['per'], c['ars'], c['inc'] * DEG, c['ecc'], c['omega'] * DEG))
    if c['law'] != 'nonlinear': r['PyAstronomy'] = rate(lambda: codes.lc_pyastronomy(c, t), 0.6)   # occultnl is not timed: it crashes on some inputs
    r['ellc'] = rate(lambda: codes.lc_ellc(c, t), 0.6)
    r['pylightcurve'] = rate(lambda: codes.lc_pylightcurve(c, t), 0.6)
    if c['law'] != 'nonlinear':
        z = circ_z(t, c)
        r['exoplanet-core (kernel)'] = rate(lambda: ec.quad_limbdark_light_curve(c['ld'][0], c['ld'][1], z, c['rprs']))

# ---- write
def stats(d): return {'max': sig(np.max(np.abs(d)), 3), 'rms': sig(np.sqrt(np.mean(d * d)), 3)}
out_cases = []
for i, c in enumerate(cases):
    oc = strip(c); oc['id'] = i; oc['truth'] = c['_truth'].tolist()
    oc['codes'] = {k: [sig(x, 3) for x in v] for k, v in c['_res'].items() if v is not None}
    oc['stats'] = {k: stats(v) for k, v in c['_res'].items() if v is not None}
    oc['depth'] = sig(1 - c['_truth'].min(), 6)
    out_cases.append(oc)
for e in exposure: del e['_c'], e['_t']
import platform
vers = codes.versions(); vers.update(ext_versions)
dump(os.path.join(ROOT, 'public/validation/transit.json'), {
    'date': today(), 'machine': platform.platform() + ', ' + platform.processor(), 'python': platform.python_version(), 'versions': vers,
    'truth': {'method': 'orbit: Kepler solved in 30-digit arithmetic (mpmath); flux: scipy adaptive quadrature of the radial integral with the endpoint singularities substituted away, epsrel 1e-13',
              'kernelVsMpmath': sig(worst_mp, 2), 'note': 'the mpmath tanh-sinh evaluation of the same integral agrees with the scipy value to this level on every 9th point of every case'},
    'codeNames': names, 'cases': out_cases, 'exposure': exposure, 'special': special,
    'timing': [{'key': c['key'], 'label': c['label'], 'p': {k: c[k] for k in ('rprs', 'per', 'tmid', 'ars', 'inc', 'ecc', 'omega', 'law', 'ld')}, 't0': c['t'][0], 't1': c['t'][-1], 'n': 1000,
                'rate': {k: sig(v, 3) for k, v in c['rate'].items() if v}} for c in tim_cases],
})
# console summary
for c in out_cases:
    print('%-52s' % c['label'], ' '.join('%s %.0e' % (k.split(' ')[0][:6] + ('*' if '(' in k else ''), v['max']) for k, v in c['stats'].items()))
for c in tim_cases: print(c['key'], {k: round(v) for k, v in c['rate'].items() if v})
