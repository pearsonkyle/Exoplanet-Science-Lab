# Reference values from EXOTIC and pylightcurve themselves, for test/exotic.test.mjs.
# Run with the EXOTIC environment from this project's root:
#   /Users/kpearson/miniconda3/envs/exotic/bin/python test/make_exotic_reference.py /path/to/EXOTIC
# Writes test/exotic_reference.json. Nothing here imports ESL code.
import json, os, pickle, sys, warnings
import numpy as np
warnings.filterwarnings('ignore')
EX = sys.argv[1] if len(sys.argv) > 1 else '/Users/kpearson/Programs/science/exoplanet/EXOTIC'
sys.path.insert(0, EX)
import exotic
from exotic.api import multi_fitter as m
import pylightcurve as plc
from pylightcurve.models.exoplanet_lc import eclipse_mid_time, eclipse_duration, transit_duration
import statsmodels.api as sm
import pandas as pd

out = {'generator': f'EXOTIC {exotic.__version__}, pylightcurve {plc.__version__}, numpy {np.__version__}'}
LD = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333]

def planet(rprs, per, inc, tmid, ecc, omega, mplanet, mstar, rstar):
    v = dict(rprs=rprs, per=per, inc=inc, tmid=tmid, ecc=ecc, omega=omega, mplanet=mplanet, mstar=mstar, rstar=rstar,
             u0=LD[0], u1=LD[1], u2=LD[2], u3=LD[3])
    mu, ars, a = m.orbit_derived(v, mstar, rstar)
    v['mu'] = mu; v['ars'] = ars
    return v

# ---- 1. models: transit (pylightcurve, Claret law) and radial velocity (EXOTIC) ------------------
toy = json.load(open(os.path.join(EX, 'examples/multi_planet/data/multi_system.json')))
cases = {}
for k, p in toy['planets'].items():
    cases['toy ' + k] = planet(p['rprs'], p['per'], p['inc'], p['tmid'], p['ecc'], p['omega'], p['mplanet'], p['mstar'], p['rstar'])
cases['HD 80606 b'] = planet(0.1, 111.4367, 89.269, 2458888.0757, 0.93132, -58.699, 4.20, 1.05, 1.05)
cases['eccentric'] = planet(0.12, 5.3, 86.5, 2459000.2, 0.35, 110.0, 1.3, 0.9, 0.85)
out['models'] = {}
for name, v in cases.items():
    rng = np.random.default_rng(1)
    t14 = v['per'] / np.pi * np.arcsin(min(1.0, (1 + v['rprs']) / v['ars'])) * 3
    tt = np.linspace(v['tmid'] - t14, v['tmid'] + t14, 301)                       # around the transit
    tr = np.sort(v['tmid'] + v['per'] * rng.uniform(-1.5, 1.5, 200))              # around the orbit
    out['models'][name] = {
        'params': {k: v[k] for k in ['rprs', 'per', 'inc', 'tmid', 'ecc', 'omega', 'mplanet', 'mstar', 'rstar', 'mu', 'ars']},
        't_transit': tt.tolist(), 'transit': m.transit(tt, v).tolist(),
        't_rv': tr.tolist(), 'rv': m.radial_velocity(tr, v).tolist(),
        # a tighter numerical derivative than EXOTIC's default dt = 1e-4 d, to separate its truncation error from real differences
        'rv_fine': ((m.radial_velocity(tr + 5e-6, v, dt=1e-5) + m.radial_velocity(tr - 5e-6 - 1e-5, v, dt=1e-5)) / 2).tolist(),
        'emid': float(eclipse_mid_time(v['per'], v['ars'], v['ecc'], v['inc'], v['omega'], v['tmid'])),
    }

# ---- 2. pylightcurve durations for HD 80606 b at the Table 7 values (Pearson et al. 2022) ---------
hd = dict(rprs=np.sqrt(0.01019), per=111.436765, ars=94.452, ecc=0.93183, inc=89.24, omega=-58.887)
out['hd80606_durations'] = {
    'params': hd,
    'transit_duration': float(transit_duration(hd['rprs'], hd['per'], hd['ars'], hd['ecc'], hd['inc'], hd['omega'])),
    'eclipse_duration': float(eclipse_duration(hd['rprs'], hd['per'], hd['ars'], hd['ecc'], hd['inc'], hd['omega'])),
    'published': {'t14': 0.4990, 'e14': 0.07169},
}

# ---- 3. the three-planet toy: EXOTIC's own chi2 at the injected truth, and its stored fit ----------
D = os.path.join(EX, 'examples/multi_planet/data')
tp = {k: cases['toy ' + k] for k in 'bcd'}
lc = {}
for k in 'bcd':
    df = pd.read_csv(os.path.join(D, f'tess_{k}.csv'))
    model = m.lc_total_model(tp, df.BJD.values)
    scale = np.mean(df.flux.values / model)                       # EXOTIC profiles the flux scale with a plain mean
    lc[f'tess_{k}'] = {'n': len(df), 'scale': float(scale), 'chi2': float(np.sum(((df.flux.values - model * scale) / df.ferr.values) ** 2)),
                       'model_min': float(model.min())}
rv = pd.read_csv(os.path.join(D, 'rv_neid.csv'))
tref = float(rv.BJD.min()); jit = toy['noise']['rv_jitter']
model = m.rv_total_model(tp, rv.BJD.values, {'rv_linear': toy['trend']['rv_linear'], 'rv_quad': None}, tref)
s2 = rv.velerr.values ** 2 + jit ** 2; w = 1 / s2
off = np.sum((rv.vel.values - model) * w) / np.sum(w)
out['toy'] = {
    'lc': lc, 'rv': {'n': len(rv), 'tref': tref, 'jitter': jit, 'rv_linear': toy['trend']['rv_linear'], 'offset': float(off),
                     'chi2': float(np.sum((rv.vel.values - model - off) ** 2 / s2)), 'model': model.tolist()},
    'K': {k: float((lambda r: (r.max() - r.min()) / 2)(m.radial_velocity(np.linspace(0, tp[k]['per'], 4000), tp[k]))) for k in 'bcd'},
}
fit = pickle.load(open(os.path.join(EX, 'examples/multi_planet/multi_fit.pkl'), 'rb'))
out['toy']['exotic_fit'] = {'parameters': {k: float(v) for k, v in fit.parameters.items()}, 'errors': {k: float(v) for k, v in fit.errors.items()},
                            'logz': float(fit.results['logz']), 'logzerr': float(fit.results['logzerr']), 'ncall': int(fit.results['ncall'])}

# ---- 4. HD 80606 joint fit stored with the example (transit + RV + timing) -------------------------
g = pickle.load(open(os.path.join(EX, 'examples/joint_rv_transit/grv_fit.pkl'), 'rb'))
keep = ['rprs', 'per', 'inc', 'ecc', 'omega', 'tmid', 'mplanet', 'ars', 'K', 'T14', 'emid', 'a', 'mstar', 'rstar']
out['hd80606_joint'] = {'parameters': {k: float(g.parameters[k]) for k in keep if k in g.parameters},
                        'errors': {k: float(g.errors[k]) for k in keep if k in g.errors},
                        'offsets': {k: [float(g.parameters[k]), float(g.errors[k])] for k in g.parameters if k.endswith('_offset')},
                        'rv_datasets': [{'name': d['name'], 'n': len(d['time'])} for d in g.rv_data]}

# ---- 5. the ephemeris example: weighted least squares exactly as examples/ephemeris/fit_ephemeris.py --
src = open(os.path.join(EX, 'examples/ephemeris/fit_ephemeris.py')).read()
ns = {'np': np}
import textwrap
exec(textwrap.dedent(src[src.index('    Tc = np.array('):src.index('    P = 2.7962868')]), ns)
Tc, Te, labels, P = ns['Tc'], ns['Tc_error'], ns['labels'], 2.7962868
orbit = np.rint((Tc - Tc.min()) / P)
res = sm.WLS(Tc, np.vstack([np.ones(len(Tc)), orbit]).T, weights=1.0 / Te ** 2).fit()
sd = np.sqrt(np.diagonal(res.normalized_cov_params))
resid = (Tc - (orbit * res.params[1] + res.params[0])) / Te
mask = np.abs(resid) < 3
res2 = sm.WLS(Tc[mask], np.vstack([np.ones(mask.sum()), orbit[mask]]).T, weights=1.0 / Te[mask] ** 2).fit()
sd2 = np.sqrt(np.diagonal(res2.normalized_cov_params))
out['ephemeris'] = {'P_guess': P, 'tmid': Tc.tolist(), 'err': Te.tolist(), 'labels': labels.tolist(), 'orbit': orbit.tolist(),
                    'wls': {'T0': float(res.params[0]), 'T0_err': float(sd[0]), 'P': float(res.params[1]), 'P_err': float(sd[1])},
                    'kept': int(mask.sum()),
                    'wls_clipped': {'T0': float(res2.params[0]), 'T0_err': float(sd2[0]), 'P': float(res2.params[1]), 'P_err': float(sd2[1])}}
json.dump(out, open('test/exotic_reference.json', 'w'))
pd.DataFrame({'tmid': Tc, 'err': Te, 'source': labels}).sort_values('tmid').to_csv('public/examples/ephemeris/transit_times.csv', index=False)
print('wrote test/exotic_reference.json', os.path.getsize('test/exotic_reference.json'), 'bytes')
print('HD 80606 durations (pylightcurve):', out['hd80606_durations'])
print('toy chi2:', {k: (v['n'], round(v['chi2'], 2)) for k, v in lc.items()}, 'rv', round(out['toy']['rv']['chi2'], 2), 'K', out['toy']['K'])
print('ephemeris WLS:', out['ephemeris']['wls'], 'kept', out['ephemeris']['kept'])
