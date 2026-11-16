# Runs inside the pyaneti environment (.venv-validation/pyaneti-env, numpy 1.26, built from github.com/oscaribv/pyaneti):
#   python ext_pyaneti.py in.json out.json
# in.json: {"lc": [{case..., "t": [...], "n_cad": 1, "t_cad": 0}], "rv": [{per, tmid, ecc, omega, K, t: [...]}], "tp": [...], "anom": [{e, M: [...]}]}
import json, sys, math, time
import numpy as np
import pyaneti
DEG = math.pi / 180
inp = json.load(open(sys.argv[1])); out = {'lc': [], 'rv': [], 'tp': [], 'anom': [], 'timing': []}
def lc(c, t, n_cad=1, t_cad=0.0):
    if c['law'] == 'nonlinear': return None            # pyaneti has the quadratic law only
    u = {'uniform': [0.0, 0.0], 'linear': [c['ld'][0] if c['ld'] else 0.0, 0.0], 'quadratic': list(c['ld'])}[c['law']]
    pars = np.array([[c['tmid']], [c['per']], [c.get('ecc', 0)], [c.get('omega', 0) * DEG], [c['inc'] * DEG], [c['ars']]], dtype=float, order='F')
    return pyaneti.flux_tr(np.asarray(t, float), np.zeros(len(t), dtype=np.int32), pars, np.array([c['rprs']]), np.array(u, float), np.array([n_cad], dtype=np.int32), np.array([t_cad], float), 1)
for c in inp.get('lc', []):
    y = lc(c, c['t'], c.get('n_cad', 1), c.get('t_cad', 0.0)); out['lc'].append(None if y is None else y.tolist())
for c in inp.get('rv', []):
    t = np.asarray(c['t'], float)
    # rv_curve_mp measures its trend terms from t[0]; with alpha = beta = 0 that does not matter
    out['rv'].append(pyaneti.rv_curve_mp(t, 0.0, np.array([c['tmid']]), np.array([c['per']]), np.array([c['ecc']]), np.array([c['omega'] * DEG]), np.array([c['K']]), 0.0, 0.0).tolist())
for c in inp.get('tp', []):
    out['tp'].append(float(pyaneti.find_tp(c['tmid'], c['ecc'], c['omega'] * DEG, c['per'])))
for c in inp.get('anom', []):
    # true anomaly for mean anomalies M (period 2 pi, periastron at t = 0)
    out['anom'].append(pyaneti.find_anomaly_tp(np.asarray(c['M'], float), 0.0, c['e'], 2 * math.pi).tolist())
for c in inp.get('timing', []):
    t = np.asarray(c['t'], float); n = 0; t0 = time.perf_counter()
    if c['law'] == 'nonlinear': out['timing'].append(None); continue
    while time.perf_counter() - t0 < 1.0:
        for _ in range(20): lc(c, t)
        n += 20
    out['timing'].append(n / (time.perf_counter() - t0))
out['version'] = 'pyaneti 2.5.2 (GitHub, built with gfortran), numpy ' + np.__version__
json.dump(out, open(sys.argv[2], 'w'))
