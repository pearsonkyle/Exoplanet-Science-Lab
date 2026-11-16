# Rossiter-McLaughlin curves from ellc (Maxted 2016), written to test/rm_ellc_reference.json: the check of the
# sign convention of lambda and of the orbit geometry in src/core/rm.js (the pixel reference, make_rm_reference.py,
# checks the integral at given sky positions).
#
#   .venv-validation/bin/python test/make_rm_ellc_reference.py
#
# ellc.rv with flux_weighted=True gives the flux-weighted velocity of the star including the anomaly; the same call
# with flux_weighted=False is the Keplerian reflex alone, so the difference is the anomaly. ellc integrates the
# visible disc on its own grid (grid_1 = 'very_fine'), so agreement is expected at the per-cent level, not better.
import json, os
import numpy as np
import ellc

HERE = os.path.dirname(os.path.abspath(__file__))
R_SUN_A = 10.0          # a = 10 R_sun with R* = 1 R_sun: a/R* = 10
BASE = dict(per=3.0, ars=10.0, inc=87.0, rprs=0.1, u=[0.40, 0.26], vsini=5.0)
cases = []
t = np.linspace(-0.09, 0.09, 61)
for lam in (0.0, 30.0, -45.0, 120.0):
    for inc in (87.0, 89.5):
        kw = dict(radius_1=1 / BASE['ars'], radius_2=BASE['rprs'] / BASE['ars'], sbratio=0.0, incl=inc, t_zero=0.0, period=BASE['per'], a=R_SUN_A,
                  q=1e-3, ld_1='quad', ldc_1=BASE['u'], vsini_1=BASE['vsini'], lambda_1=lam, shape_1='sphere', shape_2='sphere', grid_1='very_fine', grid_2='very_fine')
        fw = ellc.rv(t, flux_weighted=True, **kw)[0]
        kep = ellc.rv(t, flux_weighted=False, **kw)[0]
        dv = (fw - kep) * 1000.0      # km/s -> m/s
        cases.append({**BASE, 'inc': inc, 'lambda': lam, 't': t.tolist(), 'rm': dv.tolist()})
        print(f'lambda={lam:+6.1f} inc={inc}: min {dv.min():+.2f} max {dv.max():+.2f} m/s, first non-zero {dv[np.nonzero(np.abs(dv) > 1e-6)[0][0]]:+.2f}')
with open(os.path.join(HERE, 'rm_ellc_reference.json'), 'w') as fh:
    json.dump({'generator': 'test/make_rm_ellc_reference.py', 'ellc': ellc.__version__ if hasattr(ellc, '__version__') else 'unknown', 'cases': cases}, fh, indent=1)
print(len(cases), 'cases written')
