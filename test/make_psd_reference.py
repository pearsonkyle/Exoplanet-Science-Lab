# Independent references for src/core/psd.js, written to test/psd_reference.json (read by test/psd.test.mjs).
#
#   .venv-phot/bin/python test/make_psd_reference.py
#
# Needs numpy, scipy, astropy and MC3 (pip install mc3; Cubillos et al. 2017). What is compared with what:
#   periodogram   scipy.signal.periodogram(scaling='density'), every detrend x window, lengths that are powers of
#                 two, composite, prime, and 20,000
#   welch         scipy.signal.welch (mean and median), and for the gap-aware variant the window-count-weighted
#                 mean of scipy.signal.welch run on each gap-free segment
#   lombscargle   astropy.timeseries.LombScargle(normalization='psd') and a direct least-squares sinusoid fit at
#                 every frequency (numpy.linalg.lstsq) turned into a density by hand
#   special       scipy.special.digamma and polygamma(1, .)
#   rednoise      a Gaussian series synthesised with the spectrum W + A f^-gamma (numpy seed below), fitted with
#                 scipy.optimize.least_squares on the same objective as fitRedNoise; plus the scatter of that
#                 fit over 300 realisations, which sets the tolerance for "recovers the truth"
#   timeavg       mc3.stats.time_avg itself (the compiled routine), and the numpy re-implementation below, which
#                 is asserted here to agree with MC3 and is then used for the variant with gaps
#   pixelmap      scipy.stats.binned_statistic_2d (mean, count, std) and numpy.percentile for the range
#   poly          numpy.linalg.lstsq on the columns (x - xc)^i (y - yc)^j, and its formal errors
#
# The inputs of most cases are not stored: both sides build them from the same 32-bit linear congruential
# generator (below and in the test) with exactly reproducible floating-point operations.
import json, os, sys
import numpy as np
import scipy, astropy
import scipy.signal as sg
import scipy.special as sp
from scipy.optimize import least_squares
from scipy.stats import binned_statistic_2d
from astropy.timeseries import LombScargle
import mc3

HERE = os.path.dirname(os.path.abspath(__file__))


class Lcg:
    def __init__(self, seed): self.s = seed & 0xFFFFFFFF
    def u(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0
    def g(self):   # sum of four uniforms minus 2: variance 1/3, exactly reproducible
        return ((self.u() + self.u()) + self.u()) + self.u() - 2.0


def series(n, seed, trend=0.001, amp=0.3, per=17.3):
    r = Lcg(seed)
    return np.array([r.g() + amp * np.sin(2 * np.pi * i / per) + trend * i for i in range(n)])


def lst(a): return [None if not np.isfinite(v) else float(v) for v in np.asarray(a, float).ravel()]


out = {'versions': {'python': sys.version.split()[0], 'numpy': np.__version__, 'scipy': scipy.__version__, 'astropy': astropy.__version__, 'mc3': mc3.__version__}}

# ------------------------------------------------------------------------------------------- periodogram
DT = 0.02
cases = []
for n, seed in [(64, 1), (75, 2), (97, 3), (1000, 4), (1001, 5), (4099, 6), (20000, 7)]:
    y = series(n, seed)
    for det in ['constant', 'linear', 'none']:
        for win in ['boxcar', 'hann']:
            if n > 100 and (det, win) not in [('constant', 'boxcar'), ('linear', 'hann')]: continue
            f, p = sg.periodogram(y, fs=1 / DT, window=win, detrend=False if det == 'none' else det, scaling='density')
            idx = np.arange(len(f)) if n <= 100 else np.unique(np.round(np.linspace(0, len(f) - 1, 60)).astype(int))
            cases.append({'n': n, 'seed': seed, 'detrend': det, 'window': win, 'idx': idx.tolist(), 'f': lst(f[idx]), 'p': lst(p[idx]), 'sum': float(p.sum()), 'max': float(p.max()), 'var': float(np.var(y))})
out['periodogram'] = {'dt': DT, 'cases': cases}

# ------------------------------------------------------------------------------------------------- welch
y = series(3000, 11)
wc = []
for kw in [dict(), dict(nperseg=200, noverlap=150, average='median'), dict(nperseg=128, detrend='linear', window='boxcar'), dict(nperseg=250, noverlap=0, average='median')]:
    f, p = sg.welch(y, fs=1 / DT, window=kw.get('window', 'hann'), nperseg=kw.get('nperseg', None), noverlap=kw.get('noverlap', None), detrend=kw.get('detrend', 'constant'), scaling='density', average=kw.get('average', 'mean'))
    wc.append({'n': 3000, 'seed': 11, 'opts': kw, 'f': lst(f), 'p': lst(p)})
ys = series(100, 12)
import warnings
with warnings.catch_warnings():
    warnings.simplefilter('ignore')
    f, p = sg.welch(ys, fs=1 / DT, nperseg=256)
wc.append({'n': 100, 'seed': 12, 'opts': {'nperseg': 256}, 'f': lst(f), 'p': lst(p)})
# gap-aware: windows inside each segment, all windows averaged
segs = [[0, 900], [900, 1100], [1100, 3000]]; nper = 256; tot = 0; acc = 0
for a, b in segs:
    if b - a < nper: continue
    f, p = sg.welch(y[a:b], fs=1 / DT, nperseg=nper)
    nw = (b - a - nper // 2) // (nper - nper // 2); acc = acc + nw * p; tot += nw
wc.append({'n': 3000, 'seed': 11, 'opts': {'nperseg': nper, 'segments': segs}, 'f': lst(f), 'p': lst(acc / tot), 'nWindows': int(tot)})
out['welch'] = {'dt': DT, 'cases': wc}

# ------------------------------------------------------------------------------------------ Lomb-Scargle
r = Lcg(21); n = 300
t = np.cumsum([(0.5 + r.u()) * 0.01 for _ in range(n)])
yl = np.array([r.g() + 0.4 * np.sin(2 * np.pi * 7.0 * t[i]) for i in range(n)])
dy = np.array([0.5 + r.u() for _ in range(n)])
fr = np.linspace(0.5, 60.0, 150)
p_un = LombScargle(t, yl).power(fr, normalization='psd')
p_w = LombScargle(t, yl, dy).power(fr, normalization='psd')
dtm = (t.max() - t.min()) / (n - 1)
# direct: drop in the sum of squares when a sinusoid + constant is fitted, as a one-sided density
direct = []
ss0 = np.sum((yl - yl.mean()) ** 2)
for f0 in fr:
    A = np.column_stack([np.ones(n), np.cos(2 * np.pi * f0 * t), np.sin(2 * np.pi * f0 * t)])
    c = np.linalg.lstsq(A, yl, rcond=None)[0]
    direct.append(dtm * (ss0 - np.sum((yl - A @ c) ** 2)))     # = 2 dt * (chi2_ref - chi2) / 2
out['lombscargle'] = {'seed': 21, 'n': n, 'freqs': lst(fr), 'astropy_psd': lst(p_un), 'astropy_psd_weighted': lst(p_w), 'direct_density': lst(direct), 'dt_mean': float(dtm), 'sum_w': float(np.sum(1 / dy ** 2))}

# ---------------------------------------------------------------------------------------------- special
xs = [0.3, 1, 1.5, 2, 3, 7, 12.5, 40, 300]
out['special'] = {'x': xs, 'digamma': lst(sp.digamma(xs)), 'trigamma': lst(sp.polygamma(1, xs))}

# -------------------------------------------------------------------------------------------- red noise
def logbin(f, p, nbins):
    m = (f > 0) & np.isfinite(p); f = f[m]; p = p[m]
    l0 = np.log(f.min()); dl = (np.log(f.max()) - l0) / nbins
    edges = np.exp(l0 + np.arange(nbins + 1) * dl)
    j = np.clip(np.searchsorted(edges, f, side='right') - 1, 0, nbins - 1)
    cnt = np.bincount(j, minlength=nbins); keep = cnt > 0
    return np.exp(np.bincount(j, np.log(f), nbins)[keep] / cnt[keep]), np.bincount(j, p, nbins)[keep] / cnt[keep], cnt[keep]


def fit_red(f, p, navg):
    m = (f > 0) & (p > 0); f = f[m]; p = p[m]; navg = np.broadcast_to(np.asarray(navg, float), m.shape)[m] if np.ndim(navg) else np.full(f.size, float(navg))
    lf0 = np.mean(np.log(f)); x = np.log(f) - lf0
    z = np.log(p) - (sp.digamma(navg) - np.log(navg)); sw = 1 / np.sqrt(sp.polygamma(1, navg))
    res = lambda th: sw * (z - np.logaddexp(th[0], th[1] - th[2] * x))
    best = None
    for g0 in [0.5, 1, 2, 3]:
        hi = np.mean(z[np.argsort(x)[-max(2, x.size // 3):]]); lo = np.mean(z[np.argsort(x)[:max(2, x.size // 10)]]); xl = np.mean(np.sort(x)[:max(2, x.size // 10)])
        r = least_squares(res, [hi, lo + g0 * xl, g0], xtol=1e-15, ftol=1e-15, gtol=1e-15, method='lm', max_nfev=20000)
        if best is None or r.cost < best.cost: best = r
    lw, la, g = best.x
    return {'W': float(np.exp(lw)), 'A': float(np.exp(la + g * lf0)), 'gamma': float(g), 'knee': float(np.exp(lf0 + (la - lw) / g)), 'cost': float(2 * best.cost)}


def synth(rng, n, dt, W, A, gam):
    f = np.fft.rfftfreq(n, dt); P = np.zeros(f.size); P[1:] = W + A * f[1:] ** -gam
    amp = np.sqrt(P * n / (2 * dt))                      # so that E[2 dt |X|^2 / n] = P
    X = amp * (rng.normal(size=f.size) + 1j * rng.normal(size=f.size)) / np.sqrt(2)
    X[-1] = amp[-1] * rng.normal() / np.sqrt(2) if n % 2 == 0 else X[-1]   # Nyquist ordinate is real and not doubled
    return np.fft.irfft(X, n)


rng = np.random.default_rng(20261115)
N, DTR, SIG, FK, GAM = 4096, 1 / 48, 3e-4, 2.0, 1.5
W = 2 * SIG ** 2 * DTR; A = W * FK ** GAM
yr = np.array([float('%.10e' % v) for v in synth(rng, N, DTR, W, A, GAM)])
f, p = sg.periodogram(yr, fs=1 / DTR, detrend='constant', scaling='density')
raw = fit_red(f, p, 1)
bf, bp, bn = logbin(f, p, 25)
binned = fit_red(bf, bp, bn)
mc = []
for _ in range(300):
    ff, pp = sg.periodogram(synth(rng, N, DTR, W, A, GAM), fs=1 / DTR, detrend='constant', scaling='density')
    q = fit_red(ff, pp, 1); mc.append([np.log(q['W'] / W), q['gamma'] - GAM, np.log(q['knee'] / FK)])
mc = np.array(mc)
out['rednoise'] = {'n': N, 'dt': DTR, 'y': [float(v) for v in yr], 'truth': {'W': W, 'A': A, 'gamma': GAM, 'knee': FK, 'sigma': SIG},
                   'fit_raw': raw, 'logbin': {'nbins': 25, 'f': lst(bf), 'p': lst(bp), 'n': lst(bn)}, 'fit_binned': binned,
                   'mc': {'realisations': 300, 'mean': lst(mc.mean(0)), 'std': lst(mc.std(0)), 'what': ['ln(W/W_true)', 'gamma - gamma_true', 'ln(knee/knee_true)']}}

# ---------------------------------------------------------------------------------------- time averaging
def time_avg_numpy(data, sizes, segments=None):
    """mc3.stats.time_avg (src_c/_time_averaging.c of MC3 3.2.1) written out with numpy, for a list of bin sizes;
    with `segments` the bins are formed inside each [i0, i1) separately."""
    data = np.asarray(data, float); segments = segments or [[0, data.size]]
    sigma1 = np.sqrt(np.mean((data - data.mean()) ** 2))
    rms, err, exp, Ms = [], [], [], []
    for N in sizes:
        means = np.concatenate([data[a:a + ((b - a) // N) * N].reshape(-1, N).mean(1) for a, b in segments])
        M = means.size
        rms.append(np.sqrt(np.mean(means ** 2))); err.append(rms[-1] / np.sqrt(2 * M)); exp.append(sigma1 * np.sqrt(M / (N * (M - 1.0))) if M > 1 else np.nan); Ms.append(M)
    return np.array(rms), np.array(err), np.array(exp), np.array(Ms)


def ar1(n, seed, rho, offset=0.0):
    r = Lcg(seed); v = [r.g()]
    for i in range(1, n): v.append(rho * v[-1] + r.g())
    return np.array(v) + offset


ta = []
for n, seed, rho, off, kw in [(600, 31, 0.6, 0.0, {}), (601, 32, 0.0, 0.05, {}), (2000, 33, 0.3, 0.0, {'maxbins': 100, 'binstep': 3})]:
    d = ar1(n, seed, rho, off)
    rms, lo, hi, exp, bins = mc3.stats.time_avg(d, **kw)
    r2, e2, x2, M2 = time_avg_numpy(d, bins.astype(int))
    assert np.allclose(r2, rms, rtol=1e-12) and np.allclose(x2, exp, rtol=1e-12), 'numpy re-implementation disagrees with MC3'
    big = M2 > 35
    assert np.allclose(e2[big], lo[big], rtol=1e-12) and np.allclose(e2[big], hi[big], rtol=1e-12)
    ta.append({'n': n, 'seed': seed, 'rho': rho, 'offset': off, 'opts': kw, 'bins': lst(bins), 'rms': lst(rms), 'expected': lst(exp), 'rmslo': lst(lo), 'rmshi': lst(hi), 'M': lst(M2), 'source': 'mc3.stats.time_avg'})
d = ar1(20000, 34, 0.5)
sizes = [1, 2, 3, 7, 30, 100, 333, 1000, 4000, 10000]
rms, lo, hi, exp, bins = mc3.stats.time_avg(d)
pick = [s - 1 for s in sizes]
ta.append({'n': 20000, 'seed': 34, 'rho': 0.5, 'offset': 0.0, 'opts': {'binSizes': sizes}, 'bins': lst(bins[pick]), 'rms': lst(rms[pick]), 'expected': lst(exp[pick]), 'rmslo': lst(lo[pick]), 'rmshi': lst(hi[pick]), 'M': [20000 // s for s in sizes], 'source': 'mc3.stats.time_avg'})
d = ar1(1000, 35, 0.5); segs = [[0, 310], [310, 333], [333, 1000]]; sizes = list(range(1, 151))
r2, e2, x2, M2 = time_avg_numpy(d, sizes, segs)
ta.append({'n': 1000, 'seed': 35, 'rho': 0.5, 'offset': 0.0, 'opts': {'binSizes': sizes, 'segments': segs}, 'bins': sizes, 'rms': lst(r2), 'expected': lst(x2), 'rmslo': lst(e2), 'rmshi': lst(e2), 'M': lst(M2), 'source': 'numpy re-implementation of MC3 (asserted equal to MC3 without gaps)'})
out['timeavg'] = ta

# ---------------------------------------------------------------------------------- pixel map and surfaces
r = Lcg(41); n = 1500
x = np.array([10.0 + 0.9 * r.u() + 0.2 * r.g() for _ in range(n)])
y = np.array([20.0 + 0.5 * r.u() + 0.1 * r.g() for _ in range(n)])
res = np.array([0.004 * (x[i] - 10.4) - 0.01 * (x[i] - 10.4) ** 2 + 0.006 * (x[i] - 10.4) * (y[i] - 20.2) - 0.02 * (y[i] - 20.3) ** 2 + 0.008 * (y[i] - 20.2) ** 3 + 0.0005 * r.g() for i in range(n)])
keep = np.array([1 if r.u() < 0.8 else 0 for _ in range(n)])
pm = []
for rng_, nx, ny, kp in [([9.9, 11.0, 19.9, 20.6], 12, 9, None), (None, 16, 16, None), (None, 7, 10, keep)]:
    m = np.ones(n, bool) if kp is None else kp.astype(bool)
    rr = rng_ or [float(np.percentile(x[m], 1)), float(np.percentile(x[m], 99)), float(np.percentile(y[m], 1)), float(np.percentile(y[m], 99))]
    rg = [[rr[0], rr[1]], [rr[2], rr[3]]]
    mean = binned_statistic_2d(x[m], y[m], res[m], 'mean', bins=[nx, ny], range=rg).statistic
    cnt = binned_statistic_2d(x[m], y[m], res[m], 'count', bins=[nx, ny], range=rg).statistic
    sd = binned_statistic_2d(x[m], y[m], res[m], 'std', bins=[nx, ny], range=rg).statistic
    with np.errstate(invalid='ignore', divide='ignore'):
        sd1 = np.where(cnt > 1, sd * np.sqrt(cnt / (cnt - 1)), np.nan)
    # scipy's arrays are [ix, iy]; stored [iy * nx + ix]
    pm.append({'explicit_range': rng_ is not None, 'range': rr, 'nx': nx, 'ny': ny, 'keep': kp is not None, 'mean': lst(mean.T), 'count': lst(cnt.T), 'std': lst(sd1.T)})
out['pixelmap'] = {'seed': 41, 'n': n, 'cases': pm}

po = []
for order, kp in [(1, None), (2, None), (3, None), (2, keep)]:
    m = np.ones(n, bool) if kp is None else kp.astype(bool)
    xc, yc = x[m].mean(), y[m].mean()
    terms = [(d - j, j) for d in range(order + 1) for j in range(d + 1)]
    Amat = np.column_stack([(x[m] - xc) ** i * (y[m] - yc) ** j for i, j in terms])
    c, *_ = np.linalg.lstsq(Amat, res[m], rcond=None)
    rs = res[m] - Amat @ c
    cov = np.linalg.inv(Amat.T @ Amat) * np.sum(rs ** 2) / (m.sum() - len(terms))
    probe = [[10.1, 20.05], [10.7, 20.4], [10.45, 20.2]]
    po.append({'order': order, 'keep': kp is not None, 'xc': float(xc), 'yc': float(yc), 'coef': lst(c), 'coefErr': lst(np.sqrt(np.diag(cov))), 'cond': float(np.linalg.cond(Amat)),
               'rmsAfter': float(np.sqrt(np.mean(rs ** 2))), 'rmsBefore': float(np.std(res[m])), 'probe': probe,
               'probe_value': [float(sum(ck * (px - xc) ** i * (py - yc) ** j for ck, (i, j) in zip(c, terms))) for px, py in probe]})
out['poly'] = po

path = os.path.join(HERE, 'psd_reference.json')
with open(path, 'w') as fh: json.dump(out, fh, separators=(',', ':'))
print('wrote', path, os.path.getsize(path), 'bytes;', out['versions'])
print('red-noise fit of the stored series:', raw, 'truth', {'W': W, 'A': A, 'gamma': GAM, 'knee': FK})
print('Monte Carlo scatter (ln W, gamma, ln knee):', mc.mean(0), mc.std(0))
