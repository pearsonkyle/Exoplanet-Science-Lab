# Parameter recovery: independent samplers on the same likelihood, with independent model code.
#   .venv-validation/bin/python tools/validation/make_fits.py        (about 10 minutes)
# Writes public/validation/fits.json: the synthetic data, and for each problem the posterior means and widths from
# emcee, dynesty and UltraNest, ln Z from the two nested samplers, ln L at a few points (to show the likelihoods are
# the same function), and for the linear-Gaussian problem the analytic posterior and evidence.
#
# The likelihood is ESL's (src/core/model.js, buildProblem) written out again here from its description:
#   light curve   f = a1 exp(a2 X) T(t), a1 integrated out with a flat prior of width 2, ln sigma terms kept
#   velocities    v = gamma + K [cos(omega + nu) + e cos omega] + rvlin (t - t_ref), gamma integrated out with a flat
#                 prior of width 2e5 m/s, jitter added in quadrature, ln sigma terms kept
# The transit model here is exoplanet-core's exact quadratic kernel on a circular orbit; the velocity model is radvel's.
import json, math, os, sys, time, warnings
import numpy as np
warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE)
from common import sig, today, dump
import codes
import exoplanet_core as ec, radvel, emcee, dynesty, ultranest
LN2PI = math.log(2 * math.pi); DEG = math.pi / 180; A1_WIDTH = 2.0; GAMMA_WIDTH = 2e5

def transit_circ(t, v):
    ph = 2 * math.pi * (t - v['tmid']) / v['per']; ci = math.cos(v['inc'] * DEG)
    z = np.where(np.cos(ph) > 0, v['ars'] * np.sqrt(np.sin(ph) ** 2 + (ci * np.cos(ph)) ** 2), 10.0)
    return 1 + np.asarray(ec.quad_limbdark_light_curve(v['ld0'], v['ld1'], z, v['rprs']))
def lnl_lc(v, d):
    if not (v['rprs'] > 0) or not (v['ars'] > 1): return -1e100
    m = transit_circ(d['t'], v)
    if d.get('airmass') is not None: m = m * np.exp(v['a2'] * d['airmass'])
    w = 1 / d['e'] ** 2; sdm = np.sum(w * d['f'] * m); smm = np.sum(w * m * m); sdd = np.sum(w * d['f'] ** 2)
    return -0.5 * (np.sum(np.log(d['e'] ** 2)) + len(d['t']) * LN2PI) - math.log(A1_WIDTH) - 0.5 * max(0.0, sdd - sdm * sdm / smm) + 0.5 * math.log(2 * math.pi / smm)
def rv_model(t, v, tref):
    if v['ecc'] == 0: m = v['K'] * np.cos(math.pi / 2 + 2 * math.pi * (t - v['tmid']) / v['per'])
    else:
        w = v['omega'] * DEG; tp = radvel.orbit.timetrans_to_timeperi(v['tmid'], v['per'], v['ecc'], w)
        m = radvel.kepler.rv_drive(t, np.array([v['per'], tp, v['ecc'], w, v['K']]))
    return m + v.get('rvlin', 0.0) * (t - tref)
def lnl_rv(v, d):
    if not (0 <= v['ecc'] < 0.999) or v.get('jit@rv1', 0) < 0: return -1e100
    r = d['v'] - rv_model(d['t'], v, d['t'].min()); s2 = d['e'] ** 2 + v.get('jit@rv1', 0.0) ** 2; w = 1 / s2
    sw = w.sum(); swr = (w * r).sum(); swrr = (w * r * r).sum()
    return -0.5 * max(0.0, swrr - swr * swr / sw) - 0.5 * (np.log(s2).sum() + len(r) * LN2PI) + 0.5 * math.log(2 * math.pi / sw) - math.log(GAMMA_WIDTH)

rng = np.random.default_rng(20261115)
problems = []
# A: hot Jupiter, four free parameters
vA = dict(rprs=0.1, per=3.5, tmid=0.1, ars=10.0, inc=88.2, ld0=0.40, ld1=0.26)
t = np.linspace(-0.12, 0.12, 300) + 0.1; e = np.full(len(t), 5e-4)
dA = dict(t=t, f=1.0007 * transit_circ(t, vA) + rng.normal(0, 5e-4, len(t)), e=e)
problems.append(dict(id='A', kind='lc', title='Transit of a hot Jupiter: Rp/R*, T mid, inclination and a/R* free', truth=vA, data=dA, ldLaw='quadratic',
                     free=[('rprs', 0.06, 0.14), ('tmid', 0.09, 0.11), ('inc', 84.0, 90.0), ('ars', 7.0, 13.0)]))
# B: small planet through changing airmass
vB = dict(rprs=0.05, per=2.2, tmid=0.3, ars=7.0, inc=85.0, ld0=0.45, ld1=0.20, a2=-0.06)
t = np.linspace(-0.11, 0.13, 400) + 0.3; X = 1.05 + 2.2 * ((t - t.mean()) / 0.2 + 0.25) ** 2; e = np.full(len(t), 3e-4)
dB = dict(t=t, f=0.83 * np.exp(vB['a2'] * X) * transit_circ(t, vB) + rng.normal(0, 3e-4, len(t)), e=e, airmass=X)
problems.append(dict(id='B', kind='lc', title='Small planet with an airmass trend: Rp/R*, T mid, inclination and the airmass coefficient free', truth=vB, data=dB, ldLaw='quadratic',
                     free=[('rprs', 0.03, 0.07), ('tmid', 0.29, 0.31), ('inc', 82.0, 90.0), ('a2', -0.2, 0.1)]))
# C: velocities, circular orbit, linear in both free parameters -> analytic posterior and evidence
vC = dict(per=3.5, tmid=0.4, ecc=0.0, omega=0.0, K=50.0, rvlin=0.15)
t = np.sort(rng.uniform(0, 30, 40)); e = np.full(len(t), 3.0)
dC = dict(t=t, v=1234.5 + rv_model(t, vC, t.min()) + rng.normal(0, 3.0, len(t)), e=e)
problems.append(dict(id='C', kind='rv', title='Velocities, circular orbit: K and a linear trend free (linear-Gaussian, so the answer is known exactly)', truth=vC, data=dC,
                     free=[('K', 0.0, 100.0), ('rvlin', -1.0, 1.0)]))
# D: velocities, eccentric orbit with jitter
vD = {'per': 9.0, 'tmid': 0.4, 'ecc': 0.4, 'omega': 60.0, 'K': 80.0, 'jit@rv1': 3.0}
t = np.sort(rng.uniform(0, 60, 60)); e = np.full(len(t), 4.0)
dD = dict(t=t, v=-321.0 + rv_model(t, vD, t.min()) + rng.normal(0, 5.0, len(t)), e=e)
problems.append(dict(id='D', kind='rv', title='Velocities, eccentric orbit: K, e, omega, T mid and jitter free', truth=vD, data=dD,
                     free=[('K', 40.0, 120.0), ('ecc', 0.0, 0.8), ('omega', 0.0, 120.0), ('tmid', -0.6, 1.4), ('jit@rv1', 0.0, 12.0)]))

out = []
for P in problems:
    keys = [k for k, _, _ in P['free']]; lo = np.array([a for _, a, _ in P['free']]); hi = np.array([b for _, _, b in P['free']]); nd = len(keys)
    base = dict(P['truth']); d = P['data']; f = lnl_lc if P['kind'] == 'lc' else lnl_rv
    def loglike(th):
        v = dict(base); v.update(zip(keys, th)); return float(f(v, d))
    ptform = lambda u: lo + (hi - lo) * np.asarray(u)
    truth = np.array([P['truth'][k] for k in keys])
    res = {}
    # ---- emcee
    t0 = time.time()
    def logp(th): return loglike(th) if np.all(th > lo) and np.all(th < hi) else -np.inf
    nw = 32; p0 = np.clip(truth + 1e-3 * (hi - lo) * np.random.default_rng(1).normal(size=(nw, nd)), lo + 1e-9, hi - 1e-9)
    em = emcee.EnsembleSampler(nw, nd, logp); np.random.seed(11); em.run_mcmc(p0, 12000, progress=False)
    ch = em.get_chain(discard=2000, flat=True); tau = em.get_autocorr_time(tol=0)
    res['emcee'] = {'mean': ch.mean(0).tolist(), 'std': ch.std(0).tolist(), 'q': np.percentile(ch, [15.865, 50, 84.135], axis=0).T.tolist(), 'neff': sig(len(ch) / tau.max(), 3), 'seconds': sig(time.time() - t0, 3),
                    'settings': '32 walkers x 12000 steps, 2000 discarded'}
    # ---- dynesty
    t0 = time.time()
    ds = dynesty.NestedSampler(loglike, ptform, nd, nlive=3000, rstate=np.random.default_rng(5)); ds.run_nested(dlogz=0.01, print_progress=False); r = ds.results
    w = np.exp(r.logwt - r.logz[-1]); w /= w.sum(); mean = (w[:, None] * r.samples).sum(0); std = np.sqrt((w[:, None] * (r.samples - mean) ** 2).sum(0))
    def wq(x, q):
        i = np.argsort(x); c = np.cumsum(w[i]); return [float(x[i][np.searchsorted(c, qq)]) for qq in q]
    res['dynesty'] = {'mean': mean.tolist(), 'std': std.tolist(), 'q': [wq(r.samples[:, j], [0.15865, 0.5, 0.84135]) for j in range(nd)], 'logZ': float(r.logz[-1]), 'logZerr': float(r.logzerr[-1]),
                      'ncall': int(np.sum(r.ncall)), 'neff': sig(1 / np.sum(w ** 2), 3), 'seconds': sig(time.time() - t0, 3), 'settings': 'static, 3000 live points, dlogz 0.01'}
    # ---- UltraNest
    t0 = time.time()
    un = ultranest.ReactiveNestedSampler(keys, loglike, ptform, log_dir=None); np.random.seed(7)
    ur = un.run(min_num_live_points=400, show_status=False, viz_callback=False)
    res['UltraNest'] = {'mean': list(map(float, ur['posterior']['mean'])), 'std': list(map(float, ur['posterior']['stdev'])), 'logZ': float(ur['logz']), 'logZerr': float(ur['logzerr']),
                        'ncall': int(ur['ncall']), 'seconds': sig(time.time() - t0, 3), 'settings': 'reactive, 400 live points, defaults'}
    # ---- the same likelihood? ln L at the truth and at a few prior draws
    pts = [truth.tolist()] + ptform(np.random.default_rng(2).uniform(0.2, 0.8, (5, nd))).tolist()
    lnl = [loglike(p) for p in pts]
    entry = dict(id=P['id'], kind=P['kind'], title=P['title'], keys=keys, lo=lo.tolist(), hi=hi.tolist(), truth=truth.tolist(), values=P['truth'], ldLaw=P.get('ldLaw'),
                 data={k: (None if v is None else np.asarray(v).tolist()) for k, v in d.items()}, samplers=res, lnLpoints=pts, lnL=lnl)
    # ---- analytic answer for the linear-Gaussian problem
    if P['id'] == 'C':
        tt = d['t']; A = np.column_stack([np.ones(len(tt)), np.cos(math.pi / 2 + 2 * math.pi * (tt - base['tmid']) / base['per']), tt - tt.min()])
        W = np.diag(1 / d['e'] ** 2); Cov = np.linalg.inv(A.T @ W @ A); beta = Cov @ A.T @ W @ d['v']
        chi2 = float(np.sum(((d['v'] - A @ beta) / d['e']) ** 2))
        lnZ = -0.5 * chi2 - 0.5 * (np.sum(np.log(d['e'] ** 2)) + len(tt) * LN2PI) + 0.5 * np.linalg.slogdet(2 * math.pi * Cov)[1] - math.log(GAMMA_WIDTH) - np.sum(np.log(hi - lo))
        entry['analytic'] = {'mean': beta[1:].tolist(), 'std': np.sqrt(np.diag(Cov))[1:].tolist(), 'corr': float(Cov[1, 2] / math.sqrt(Cov[1, 1] * Cov[2, 2])), 'logZ': float(lnZ), 'gamma': float(beta[0]), 'chi2': chi2,
                             'note': 'weighted least squares on [1, -sin(2 pi (t - T mid)/P), t - t_ref]; ln Z = ln L_max + 1/2 ln det(2 pi Cov) - ln(prior volume), valid because the priors are flat and contain the posterior'}
    out.append(entry)
    print(P['id'], keys)
    for k, v in res.items(): print('   %-10s' % k, 'mean', np.round(v['mean'], 5), 'std', np.round(v['std'], 5), 'lnZ %.3f +- %.3f' % (v['logZ'], v['logZerr']) if 'logZ' in v else '', '%.0f s' % v['seconds'])
    if 'analytic' in entry: print('   analytic  ', entry['analytic'])

dump(os.path.join(ROOT, 'public/validation/fits.json'), {'date': today(), 'versions': codes.versions(), 'problems': out})
