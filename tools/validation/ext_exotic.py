# Runs inside the EXOTIC environment (/Users/kpearson/miniconda3/envs/exotic):
#   python ext_exotic.py in.json out.json [path to the EXOTIC checkout]
# EXOTIC's transit is pylightcurve's with the Claret law; other laws are passed as their exact Claret equivalents.
import json, sys, time, warnings
import numpy as np
warnings.filterwarnings('ignore')
EX = sys.argv[3] if len(sys.argv) > 3 else '/Users/kpearson/Programs/science/exoplanet/EXOTIC'
sys.path.insert(0, EX)
import exotic
from exotic.api import multi_fitter as m
import pylightcurve as plc
from pylightcurve.models.exoplanet_lc import eclipse_mid_time, eclipse_duration, transit_duration
def claret(law, c):
    return {'uniform': [0, 0, 0, 0], 'linear': [0, (c or [0])[0], 0, 0], 'quadratic': [0, c[0] + 2 * c[1], 0, -c[1]] if law == 'quadratic' else None, 'nonlinear': list(c)}[law]
def pars(c):
    a = claret(c['law'], c['ld'])
    return dict(rprs=c['rprs'], per=c['per'], inc=c['inc'], tmid=c['tmid'], ecc=c.get('ecc', 0), omega=c.get('omega', 0), ars=c['ars'], u0=a[0], u1=a[1], u2=a[2], u3=a[3])
inp = json.load(open(sys.argv[1])); out = {'lc': [], 'rv': [], 'dur': [], 'timing': []}
for c in inp.get('lc', []):
    out['lc'].append(np.asarray(m.transit(np.asarray(c['t'], float), pars(c))).tolist())
for c in inp.get('rv', []):
    # EXOTIC derives the amplitude from masses: v = dict with mplanet [M Jup], mstar, rstar [Sun]; it returns m/s
    v = dict(rprs=0.1, per=c['per'], inc=c['inc'], tmid=c['tmid'], ecc=c['ecc'], omega=c['omega'], mplanet=c['mplanet'], mstar=c['mstar'], rstar=c['rstar'], u0=0, u1=0, u2=0, u3=0)
    mu, ars, a = m.orbit_derived(v, c['mstar'], c['rstar']); v['mu'] = mu; v['ars'] = ars
    t = np.asarray(c['t'], float)
    out['rv'].append({'rv': np.asarray(m.radial_velocity(t, v)).tolist(), 'mu': float(mu), 'ars': float(ars),
                      # centred difference with a 10x smaller step: separates EXOTIC's truncation error from real differences
                      'rv_fine': ((m.radial_velocity(t + 5e-6, v, dt=1e-5) + m.radial_velocity(t - 5e-6 - 1e-5, v, dt=1e-5)) / 2).tolist()})
for c in inp.get('dur', []):
    r = {}
    for name, f in (('t14', lambda: transit_duration(c['rprs'], c['per'], c['ars'], c['ecc'], c['inc'], c['omega'])),
                    ('e14', lambda: eclipse_duration(c['rprs'], c['per'], c['ars'], c['ecc'], c['inc'], c['omega'])),
                    ('tecl', lambda: eclipse_mid_time(c['per'], c['ars'], c['ecc'], c['inc'], c['omega'], c['tmid']))):
        try: r[name] = float(f())
        except Exception as e: r[name] = None
    out['dur'].append(r)
for c in inp.get('timing', []):
    t = np.asarray(c['t'], float); p = pars(c); n = 0; t0 = time.perf_counter()
    while time.perf_counter() - t0 < 1.0:
        for _ in range(5): m.transit(t, p)
        n += 5
    out['timing'].append(n / (time.perf_counter() - t0))
out['version'] = 'EXOTIC %s, pylightcurve %s, numpy %s' % (exotic.__version__, str(plc.__version__).strip(), np.__version__)
json.dump(out, open(sys.argv[2], 'w'))
