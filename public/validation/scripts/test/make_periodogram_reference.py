# Independent references for src/core/periodogram.js, written to test/periodogram_reference.json.
#
#   1. astropy.timeseries.LombScargle: power on its own autofrequency grid in all four normalisations,
#      false-alarm probabilities and levels (baluev, davies, naive, single) and the model at the peak, for
#      several synthetic datasets (even and uneven sampling, equal and unequal errors, whole-number epochs).
#   2. EXOTIC's own ephemeris_fitter.plot_periodogram run on the mid-transit times of its two examples
#      (examples/ephemeris/fit_ephemeris.py and fit_decay.py, read from those files, with the same
#      preprocessing those scripts do). The nested-sampling fit in the constructor is skipped (it is not used
#      by plot_periodogram, which refits by weighted least squares); the statsmodels fits and the LombScargle
#      objects made inside plot_periodogram are recorded as they happen.
#
# Needs EXOTIC, astropy and statsmodels:
#   /Users/kpearson/miniconda3/envs/exotic/bin/python test/make_periodogram_reference.py [path-to-EXOTIC]
import json, os, re, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import astropy, statsmodels
import statsmodels.api as sm
from astropy.timeseries import LombScargle

EXOTIC = sys.argv[1] if len(sys.argv) > 1 else '/Users/kpearson/Programs/science/exoplanet/EXOTIC'
HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20261115)
NORMS = ['standard', 'model', 'log', 'psd']

# ---------------------------------------------------------------------------------------------- astropy
def astropy_case(name, t, y, dy, spp, nyq, fmin=None, fmax=None):
    kw = dict(samples_per_peak=spp, nyquist_factor=nyq)
    if fmin is not None: kw['minimum_frequency'] = fmin
    if fmax is not None: kw['maximum_frequency'] = fmax
    out = {'name': name, 't': t.tolist(), 'y': y.tolist(), 'dy': None if dy is None else dy.tolist(),
           'samplesPerPeak': spp, 'nyquistFactor': nyq, 'minFrequency': fmin, 'maxFrequency': fmax, 'power': {}, 'fap': {}, 'level': {}}
    for norm in NORMS:
        ls = LombScargle(t, y, dy, normalization=norm)
        freq, power = ls.autopower(method='slow', **kw)   # the exact sums; astropy's default 'auto' switches to the
        out['power'][norm] = power.tolist()               # approximate 'fast' (FFT) method above 200 frequencies
        if norm == 'standard': out['fastMinusExact'] = float(np.abs(ls.power(freq, method='fast') - power).max())
        fmax = ls.autofrequency(maximum_frequency=freq.max(), return_freq_limits=True)[1]   # what the FAP calls below use
        out['fapFmax'] = float(fmax)
        z = np.quantile(power, [0.5, 0.9, 0.99, 1.0]) * np.array([1, 1, 1, 1])
        out['fap'][norm] = {'z': z.tolist()}
        for m in ['baluev', 'davies', 'naive', 'single']:
            out['fap'][norm][m] = np.atleast_1d(ls.false_alarm_probability(z, method=m, maximum_frequency=freq.max())).tolist()
        out['level'][norm] = {'p': [0.1, 0.01, 0.001]}
        for m in ['baluev', 'davies', 'naive']:
            out['level'][norm][m] = np.atleast_1d(ls.false_alarm_level([0.1, 0.01, 0.001], method=m, maximum_frequency=freq.max())).tolist()
    out['freq'] = freq.tolist()
    # classical (mean subtracted once, not fitted)
    out['powerNoFitMean'] = LombScargle(t, y, dy, fit_mean=False).power(freq, method='slow').tolist()
    ls = LombScargle(t, y, dy)
    p = ls.power(freq, method='slow'); fb = freq[np.argmax(p)]
    tq = np.linspace(t.min(), t.max(), 25)
    th = ls.model_parameters(fb)
    out['peak'] = {'freq': fb, 'power': p.max(), 'tq': tq.tolist(), 'model': ls.model(tq, fb).tolist(),
                   'offset': float(ls.offset() + th[0]), 'sin': float(th[1]), 'cos': float(th[2])}
    return out

cases = []
t = np.arange(60) * 1.0; dy = np.full(60, 0.3)
cases.append(astropy_case('even sampling, equal errors', t, 1.0 + 0.5 * np.sin(2 * np.pi * t / 7.3 + 0.4) + dy * rng.standard_normal(60), dy, 5, 1, fmax=0.45))
t = np.sort(rng.uniform(0, 120, 45)); dy = 0.1 + 0.5 * rng.random(45)
cases.append(astropy_case('uneven sampling, unequal errors', t, 3.0 + 0.4 * np.sin(2 * np.pi * t / 11.0) + 0.2 * np.cos(2 * np.pi * t / 3.1) + dy * rng.standard_normal(45), dy, 5, 3))
E = np.sort(rng.choice(900, 30, replace=False)).astype(float); dy = (30 + 60 * rng.random(30)) / 86400
cases.append(astropy_case('timing residuals at whole epochs (days)', E, 120 / 86400 * np.sin(2 * np.pi * E / 37.7 + 1.0) + dy * rng.standard_normal(30), dy, 10, 1, fmin=1 / 1800, fmax=0.49))
t = np.sort(rng.uniform(2459000, 2459400, 80))
cases.append(astropy_case('no error bars, Julian dates', t, 10 + np.sin(2 * np.pi * t / 23.0) + 0.8 * rng.standard_normal(80), None, 4, 2))
t = np.sort(rng.uniform(0, 50, 25)); dy = 0.2 + rng.random(25)
cases.append(astropy_case('pure noise, unequal errors', t, dy * rng.standard_normal(25), dy, 5, 2))

# ---------------------------------------------------------------------------------------------- EXOTIC
sys.path.insert(0, EXOTIC)
import exotic.api.ephemeris as eph
import exotic

def arrays_from_example(path):
    """The Tc and Tc_error arrays, and P, as written in the example script (comments removed)."""
    src = re.sub(r'#.*', '', open(path).read())
    grab = lambda nm: np.array(eval('[' + re.search(nm + r'\s*=\s*np\.array\(\[(.*?)\]\)', src, re.S).group(1) + ']'), dtype=float)
    return grab('Tc'), grab('Tc_error'), float(re.search(r'\n\s*P\s*=\s*([0-9.]+)', src).group(1))

class Recorder:
    """Stands in for statsmodels.api inside exotic.api.ephemeris and keeps every WLS result."""
    def __init__(self): self.fits = []
    def WLS(self, y, X, weights=1.0):
        rec = self
        class W:
            def fit(_):
                r = sm.WLS(y, X, weights=weights).fit(); rec.fits.append((r, np.array(y), np.array(X), np.array(weights))); return r
        return W()

class RecLS(LombScargle):
    made = []
    def __init__(self, *a, **k): super().__init__(*a, **k); RecLS.made.append(self)

class NoNested(eph.ephemeris_fitter):
    def fit_nested(self):   # only the epoch numbering of the original; plot_periodogram does its own least squares
        self.epochs = np.round((self.data - np.mean(self.bounds['T0'])) / np.mean(self.bounds['P']))

def exotic_case(name, script, thin, clip=True):
    Tc, Tce, P = arrays_from_example(os.path.join(EXOTIC, 'examples', 'ephemeris', script))
    n_all = len(Tc)
    # --- the preprocessing of the example script
    orbit = np.rint((Tc - Tc.min()) / P)
    A = np.vstack([np.ones(len(Tc)), orbit]).T
    res = sm.WLS(Tc, A, weights=1.0 / Tce ** 2).fit()
    intercept, slope = res.params; sd = np.sqrt(np.diagonal(res.normalized_cov_params))
    mask = np.abs((Tc - (orbit * slope + intercept)) / Tce) < (3 if clip else np.inf)   # the scripts clip at 3 sigma
    Tc, Tce = Tc[mask], Tce[mask]
    bounds = {'P': [P - 0.1, P + 0.1], 'T0': [intercept - 0.1, intercept + 0.1]}
    prior = {'P': [slope, sd[1]], 'T0': [intercept, sd[0]]}
    lf = NoNested(Tc, Tce, bounds, prior=prior, verbose=False)
    out = {'name': name, 'script': script, 'nBeforeClip': n_all, 'clipped': clip, 'times': Tc.tolist(), 'errs': Tce.tolist(), 'epochs': lf.epochs.tolist()}
    runs = []
    for seed in (1, 2):   # twice: anything that differs between the runs depends on EXOTIC's random draws
        np.random.seed(seed)
        rec = Recorder(); RecLS.made = []
        eph.sm, eph.LombScargle = rec, RecLS
        fig, ax = lf.plot_periodogram(); plt.close('all')
        eph.sm, eph.LombScargle = sm, LombScargle
        runs.append((rec, list(RecLS.made), lf.best_periods.copy(), lf.amplitudes.copy(), lf.coeffs.copy(), lf.periods.copy(), lf.power.copy()))
    rec, made, bestp, amps, coeffs, periods, power = runs[0]
    lin, f1, f2, last = [r[0] for r in rec.fits[:4]]
    chi2 = lambda r: float(np.sum(r.wresid ** 2))
    # the same three fits with the time of the first transit subtracted and the epochs centred: identical models,
    # but conditioned so that least squares on float64 keeps its digits (EXOTIC fits raw Julian dates)
    def centred(r, yy, XX, ww):
        Xc = XX.copy(); Xc[:, 1] = Xc[:, 1] - Xc[:, 1].mean()
        q = sm.WLS(yy - yy[0], Xc, weights=ww).fit(); return {'chi2': float(np.sum(q.wresid ** 2)), 'bic': float(q.bic)}
    out['fitsCentred'] = [centred(*f) for f in rec.fits[:3]]
    out['fits'] = [{'k': int(len(r.params)), 'params': r.params.tolist(), 'bse_unscaled': np.sqrt(np.diagonal(r.normalized_cov_params)).tolist(),
                    'chi2': chi2(r), 'bic': float(r.bic), 'llf': float(r.llf)} for r in (lin, f1, f2)]
    out['periods'] = [float(bestp[0]), float(bestp[1])]
    out['amplitudesRun1'] = amps.tolist(); out['amplitudesRun2'] = runs[1][3].tolist()
    out['coeffsLast'] = coeffs.tolist()    # WLS of (data - 1st-order fit) on [sin1, cos1, sin2, cos2, 1]
    # amplitudes as they should be read from EXOTIC's own least-squares fits (sin, cos of each term)
    out['amp1'] = float(np.hypot(f1.params[2], f1.params[3]))
    out['amp2'] = [float(np.hypot(f2.params[2], f2.params[3])), float(np.hypot(f2.params[4], f2.params[5]))]
    out['freq'] = (1.0 / periods)[::thin].tolist(); out['power'] = power[::thin].tolist(); out['thin'] = thin
    out['powerExact'] = made[0].power(1.0 / periods, method='slow')[::thin].tolist()
    out['fastMinusExact'] = float(np.abs(made[0].power(1.0 / periods, method='slow') - power).max())
    out['exactPeakPeriod'] = float(periods[np.argmax(made[0].power(1.0 / periods, method='slow'))])
    out['nFreq'] = int(len(power)); out['minPeriod'] = float(periods.min()); out['maxPeriod'] = float(periods.max())
    ls, ls2 = made[0], made[1]
    # what plot_periodogram draws: false_alarm_level with no maximum_frequency, so astropy assumes its own default grid
    out['fapLevelsDrawn'] = np.atleast_1d(ls.false_alarm_level([0.01, 0.05, 0.1], method='davies')).tolist()
    out['fmaxAssumed'] = float(ls.autofrequency(return_freq_limits=True)[1])
    out['fmaxSearched'] = float(1.0 / periods.min())
    out['fapLevelsSearchedDavies'] = np.atleast_1d(ls.false_alarm_level([0.01, 0.05, 0.1], method='davies', maximum_frequency=1.0 / periods.min())).tolist()
    out['fapLevelsSearchedBaluev'] = np.atleast_1d(ls.false_alarm_level([0.01, 0.05, 0.1], method='baluev', maximum_frequency=1.0 / periods.min())).tolist()
    out['peakPower'] = float(power.max())
    out['peakFapBaluev'] = float(ls.false_alarm_probability(power.max(), method='baluev', maximum_frequency=1.0 / periods.min()))
    # is the second LombScargle object (ls2) ever used? its data, against the residuals of the first-order fit
    resid_first = f1.resid
    out['ls2IsResidualOfFit1'] = bool(np.allclose(np.asarray(ls2.y), resid_first, atol=1e-9))
    out['ls2MinusLinearResidRms'] = float(np.std(np.asarray(ls2.y) - np.asarray(ls.y)))
    out['resid1Rms'] = float(np.std(resid_first)); out['residLinRms'] = float(np.std(lin.resid))
    # the periodogram EXOTIC labels "Data - Fourier Fit 1", done as labelled, over the same second range
    fr2 = np.atleast_1d(1.0 / bestp[1])
    maxper2 = (lf.epochs.max() - lf.epochs.min()) * 2.0; minper2 = bestp[0] * 2.1
    if minper2 > maxper2: minper2 = 3.1
    f2grid, p2 = LombScargle(lf.epochs, resid_first, dy=Tce).autopower(minimum_frequency=1.0 / maxper2, maximum_frequency=1.0 / (minper2 + 1), nyquist_factor=2)
    out['second'] = {'exoticPeriod': float(bestp[1]), 'asLabelledPeriod': float(1.0 / f2grid[np.argmax(p2)]), 'asLabelledPower': float(p2.max()),
                     'powerOfOriginalAtExoticPeriod': float(ls.power(fr2)[0])}
    print(f"{name}: n {len(Tc)} of {n_all}, peaks {bestp}, BIC {[round(f['bic'], 2) for f in out['fits']]}, amplitudes attribute {amps} then {runs[1][3]}")
    return out

ex = [exotic_case('fit_ephemeris.py as shipped (3-sigma clip)', 'fit_ephemeris.py', 1), exotic_case('fit_ephemeris.py, all 40 times', 'fit_ephemeris.py', 1, clip=False),
      exotic_case('fit_decay.py as shipped (3-sigma clip)', 'fit_decay.py', 7)]

json.dump({'made_with': {'astropy': astropy.__version__, 'statsmodels': statsmodels.__version__, 'numpy': np.__version__, 'exotic': getattr(exotic, '__version__', '?')},
           'astropy': cases, 'exotic': ex}, open(os.path.join(HERE, 'periodogram_reference.json'), 'w'))
print('wrote periodogram_reference.json', os.path.getsize(os.path.join(HERE, 'periodogram_reference.json')) // 1024, 'kB')
