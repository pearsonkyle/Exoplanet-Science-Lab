"""References for src/core/lcprep.js (test/lcprep.test.mjs): wotan's biweight, the owner's TOI extraction functions,
lightkurve's flatten and CDPP.

  .venv-lk/bin/python test/make_lcprep_reference.py

The EXOTIC functions are copied here verbatim from examples/toi-3planet/toi1873_extract.py (EXOTIC is read, never
imported or changed: its imports need the exotic environment). The one change: optimize_window takes the injection
epochs as an argument instead of drawing them with numpy's generator, so that both codes inject at the same times.
Data: a synthetic 2-minute light curve (13.6 d, a mid-sector gap, three planets, stellar variability, flares and
outliers; seed fixed, stored in the JSON) and the Kepler quarter 1 target pixel file of TrES-2 (lightkurve's
pipeline-aperture light curve, 'default' quality mask) with the archive's TrES-2 b ephemeris.
"""
import json, os, warnings
import numpy as np
from scipy.signal import savgol_filter
warnings.filterwarnings('ignore')
from wotan import flatten
import lightkurve as lk

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- copied from EXOTIC toi1873_extract.py (read only)
def duration_t14(per, rprs, ars, inc=90.0, ecc=0.0, omega=0.0):
    b = ars * np.cos(np.radians(inc))
    if ecc:
        f = np.sqrt(1 - ecc ** 2) / (1 + ecc * np.sin(np.radians(omega)))
        b *= (1 - ecc ** 2) / (1 + ecc * np.sin(np.radians(omega)))
    else:
        f = 1.0
    arg = (1 + rprs) ** 2 - b ** 2
    if arg <= 0:
        return np.nan
    sini = np.sin(np.radians(inc))
    return f * per / np.pi * np.arcsin(np.sqrt(arg) / (ars * sini))

def transit_mask(time, geom, pad=1.5, planets=None):
    mask = np.zeros(len(time), dtype=bool)
    for pkey, g in geom.items():
        if planets is not None and pkey not in planets:
            continue
        dt = np.abs((time - g['tmid'] + 0.5 * g['per']) % g['per'] - 0.5 * g['per'])
        mask |= dt < (pad * g['t14'] / 2.0)
    return mask

def clip_outliers(time, flux, tmask, sigma=4.0, dt_hr=0.5):
    keep = np.isfinite(flux)
    if keep.sum() < 25:
        return keep
    cadence = np.median(np.diff(np.sort(time)))
    win = 1 + 2 * int(max(7, dt_hr / 24.0 / cadence))
    si = np.argsort(time)
    inv = np.argsort(si)
    f = flux[si]
    good = np.isfinite(f)
    if win >= good.sum():
        return keep
    trend = np.interp(time[si], time[si][good], savgol_filter(f[good], win, 2))
    res = f - trend
    std = np.nanstd(res[good])
    ok = np.abs(res) < sigma * std
    ok = ok[inv] | tmask
    return keep & ok

def optimize_window(time, flux, tmask, t14_max, cfg, epochs):
    depth = 1500e-6
    span = time.max() - time.min()
    if span < 2 * t14_max or (~tmask).sum() < 100:
        return cfg['window_grid_days'][-1], {}
    results = {}
    for wl in cfg['window_grid_days']:
        if wl <= 2 * np.median(np.diff(np.sort(time))):
            continue
        try:
            base, _ = flatten(time, flux, window_length=wl, method=cfg['detrend_method'],
                              mask=tmask, break_tolerance=cfg['gap_tolerance_hours'] / 24.,
                              return_trend=True)
        except Exception:
            continue
        noise = np.nanstd(base[np.isfinite(base) & ~tmask])
        if not np.isfinite(noise) or noise <= 0:
            continue
        recovered = []
        for t0 in epochs:
            inj = flux.copy()
            box = np.abs(time - t0) < t14_max / 2.0
            if box.sum() < 5:
                continue
            inj[box] *= (1 - depth)
            try:
                fl = flatten(time, inj, window_length=wl, method=cfg['detrend_method'],
                             mask=tmask, break_tolerance=cfg['gap_tolerance_hours'] / 24.)
            except Exception:
                continue
            ok = np.isfinite(fl)
            if (box & ok).sum() < 5:
                continue
            oot = ok & ~box & ~tmask & (np.abs(time - t0) < 3 * t14_max)
            if oot.sum() < 10:
                continue
            recovered.append((np.nanmedian(fl[oot]) - np.nanmedian(fl[box & ok])) / depth)
        if not recovered:
            continue
        frac = float(np.median(recovered))
        npts = max(1, int(t14_max / np.median(np.diff(np.sort(time)))))
        results[wl] = {'depth_recovered': frac, 'noise_ppm': float(noise * 1e6), 'score': float(frac / (noise / np.sqrt(npts)))}
    if not results:
        return cfg['window_grid_days'][-1], {}
    best = max(results, key=lambda w: results[w]['score'])
    return best, results

def bin_series(t, f, m, chan, nb):
    si = np.argsort(t)
    t, f, m = t[si], f[si], m[si]
    chan = {k: v[si] for k, v in chan.items()}
    dt = np.median(np.diff(t)) * nb
    edges = np.arange(t.min(), t.max() + dt, dt)
    idx = np.clip(np.digitize(t, edges) - 1, 0, len(edges) - 1)
    cnt = np.bincount(idx, minlength=len(edges))
    keep = cnt > 0
    def avg(v):
        return np.bincount(idx, weights=v, minlength=len(edges))[keep] / cnt[keep]
    tb, fb = avg(t), avg(f)
    mb = np.bincount(idx, weights=m.astype(float), minlength=len(edges))[keep] > 0
    return tb, fb, mb, {k: avg(v) for k, v in chan.items()}

def trim_after_gaps(time, flux, post_gap_trim_minutes=30, gap_tolerance_hours=1.0):
    # the trim block of stage_extract
    good = np.isfinite(time) & np.isfinite(flux) & (flux > 0)
    si = np.argsort(time)
    cadence = np.median(np.diff(time[si]))
    ntrim = max(1, int(post_gap_trim_minutes / (24 * 60 * cadence)))
    trim = np.zeros(len(time), dtype=bool)
    order = si[good[si]]
    if len(order) > 2 * ntrim:
        trim[order[:2 * ntrim]] = True
        gaps = np.where(np.diff(time[order]) > gap_tolerance_hours / 24.)[0]
        for gap in gaps:
            trim[order[gap + 1:gap + 1 + ntrim]] = True
    return trim

def alias_scan(t, cad, epochs, rprs, ars_of, nmax=25):
    # the core of stage_alias_scan, with a/R* from the caller
    epochs = np.array(sorted(epochs))
    baseline = (epochs[-1] - epochs[0]) / (len(epochs) - 1)
    o = np.argsort(t)
    t, cad = t[o], cad[o]
    rows = []
    for N in range(1, nmax + 1):
        P = baseline / N
        dur = duration_t14(P, rprs, ars_of(P), 90.0)
        n0 = int(np.floor((t.min() - epochs[0]) / P)) - 1
        n1 = int(np.ceil((t.max() - epochs[0]) / P)) + 1
        pred = epochs[0] + np.arange(n0, n1 + 1) * P
        pred = pred[(pred > t.min()) & (pred < t.max())]
        covered = missed = 0
        for x in pred:
            inw = (t > x - dur / 2) & (t < x + dur / 2)
            frac = cad[inw].sum() / dur
            if frac > 0.5:
                covered += 1
                if np.min(np.abs(epochs - x)) > 0.1:
                    missed += 1
        rows.append({'N': N, 'per': P, 't14_hr': dur * 24, 'covered': covered, 'missed': missed, 'allowed': missed == 0})
    return baseline, rows

# ---------------------------------------------------------------- data
def box(t, tc, per, dur, depth):
    ph = np.abs((t - tc + 0.5 * per) % per - 0.5 * per)
    return 1 - depth * (ph < dur / 2)

def synthetic():
    rng = np.random.default_rng(20261116)
    t = 2459000.0 + np.arange(0, 13.6, 2 / 1440)
    t = t[(t < 2459006.6) | (t > 2459007.6)]                      # a one-day gap (downlink)
    t = t[rng.random(len(t)) > 0.02]                               # scattered missing cadences
    planets = {'b': dict(per=3.1, tmid=2459001.2, rprs=0.05, ars=10.0, inc=88.5), 'c': dict(per=5.7, tmid=2459003.9, rprs=0.035, ars=15.0, inc=89.2),
               'd': dict(per=40.0, tmid=2459011.0, rprs=0.04, ars=60.0, inc=89.9)}
    for p in planets.values():
        p['t14'] = duration_t14(p['per'], p['rprs'], p['ars'], p['inc'])
    f = 1 + 0.004 * np.sin(2 * np.pi * (t - t[0]) / 4.3) + 0.0015 * np.sin(2 * np.pi * (t - t[0]) / 1.1 + 0.7)
    for p in planets.values():
        f *= box(t, p['tmid'], p['per'], p['t14'], p['rprs'] ** 2)
    f += rng.normal(0, 600e-6, len(t))
    out = rng.choice(len(t), 25, replace=False)
    f[out] += rng.choice([-1, 1], 25) * rng.uniform(0.004, 0.01, 25)    # outliers
    f[3000:3004] += np.array([0.006, 0.004, 0.002, 0.001])              # a flare
    f[100] = np.nan
    # short decimal forms, used by both codes (the JSON then carries them exactly)
    t = 2459000.0 + np.round(t - 2459000.0, 9)
    f = np.array([float(f'{x:.9g}') for x in f])
    return t, f, planets

def main():
    ref = {'wotan': '2.1', 'lightkurve': lk.__version__}
    t, f, planets = synthetic()
    ref['synthetic'] = {'t0': 2459000.0, 'toff': [float(f'{x - 2459000.0:.9f}') for x in t], 'f': [None if not np.isfinite(x) else float(x) for x in f], 'planets': planets}
    # durations
    ref['t14'] = [{'args': a, 't14': (lambda v: None if not np.isfinite(v) else float(v))(duration_t14(*a))} for a in
                  [(3.1, 0.05, 10.0, 88.5), (7.0057048, 0.0268254, 16.3120888, 88.9098679), (24.9339464, 0.0397857, 38.0249606, 89.7156222, 0.0, 0.0),
                   (2.47061892, 0.1278, 8.06, 84.07, 0.018, 268.0), (10.0, 0.1, 10.0, 80.0), (10.0, 0.1, 10.0, 84.0, 0.3, 45.0), (100.0, 0.05, 80.0, 90.0, 0.5, 90.0)]]
    tm = transit_mask(t, planets, pad=1.5)
    ref['transit_mask_count'] = int(tm.sum())
    ref['transit_mask'] = [int(x) for x in np.flatnonzero(tm)]
    # wotan biweight: windows, with and without the transit mask, EXOTIC's break tolerance, an edge cut-off
    ref['biweight'] = {}
    for key, kw in {'w0.5': dict(window_length=0.5), 'w1.0': dict(window_length=1.0), 'w1.0_mask': dict(window_length=1.0, mask=tm),
                    'w2.0_mask_bt1h': dict(window_length=2.0, mask=tm, break_tolerance=1 / 24.), 'w0.75_edge': dict(window_length=0.75, edge_cutoff=0.2)}.items():
        fl, tr = flatten(t, f, method='biweight', return_trend=True, **kw)
        ref['biweight'][key] = {'every': 4, 'trend': [None if not np.isfinite(x) else round(float(x), 11) for x in tr[::4]], 'nan': int((~np.isfinite(tr)).sum())}
    # an isolated check of the mechanism (README of toi-3planet): a 2000 ppm, 7.2 h box under a 1 d window, masked or not
    tb = np.arange(0, 10, 2 / 1440); fb = box(tb, 5.0, 100.0, 0.3, 2000e-6) + np.random.default_rng(3).normal(0, 300e-6, len(tb))
    fb = np.array([float(f'{x:.9g}') for x in fb]); ref['box_series'] = [float(x) for x in fb]
    mb = np.abs(tb - 5.0) < 0.3
    for key, m in (('unmasked', None), ('masked', mb)):
        fl = flatten(tb, fb, method='biweight', window_length=1.0, mask=m)
        ref.setdefault('box_check', {})[key] = float(1 - np.nanmedian(fl[np.abs(tb - 5.0) < 0.15]))
    # clipping, trim, binning
    keep = clip_outliers(t, f, tm)
    ref['clip'] = {'dropped': [int(x) for x in np.flatnonzero(~keep)]}
    trim = trim_after_gaps(t, f)
    ref['trim'] = [int(x) for x in np.flatnonzero(trim)]
    chan = {'x': np.sin(t), 'y': np.cos(t)}
    good = keep & ~trim
    tb2, fb2, mb2, cb2 = bin_series(t[good], f[good], tm[good], {k: v[good] for k, v in chan.items()}, 3)
    ref['bin3'] = {'n': len(tb2), 'every': 4, 't': tb2[::4].tolist(), 'f': fb2[::4].tolist(), 'm': [int(x) for x in mb2], 'x': cb2['x'][::4].tolist()}
    # window choice by injection at fixed epochs
    epochs = [2459002.05, 2459004.62, 2459005.9, 2459008.7, 2459010.15, 2459012.6]
    cfg = {'window_grid_days': [0.5, 1.0, 2.0, 3.0], 'detrend_method': 'biweight', 'gap_tolerance_hours': 1.0}
    tt, ff, mm = t[good], f[good], tm[good]
    t14max = max(p['t14'] for p in planets.values())
    best, scan = optimize_window(tt, ff, mm, t14max, cfg, epochs)
    ref['optimize_window'] = {'epochs': epochs, 'grid': cfg['window_grid_days'], 'best': best, 'scan': {str(k): v for k, v in scan.items()}, 't14max': t14max}
    # alias scan: three "observed" transits 900.19 d apart in four sectors of 2-min and one of 30-min coverage
    rng = np.random.default_rng(7)
    segs = [(2458840.0, 2458866.0, 2 / 1440), (2459200.0, 2459226.0, 2 / 1440), (2459740.0, 2459766.0, 2 / 1440), (2460000.0, 2460026.0, 30 / 1440), (2460640.0, 2460666.0, 2 / 1440)]
    ts, cs = [], []
    for a, b, c in segs:
        x = np.arange(a, b, c); x = x[(x - a) % 13.7 < 12.5]; ts.append(x); cs.append(np.full(len(x), c))
    ta, ca = np.concatenate(ts), np.concatenate(cs)
    G, Msun, Rsun = 6.67430e-11, 1.98840987e30, 6.957e8
    ars_of = lambda P: (G * 1.02 * Msun * (P * 86400.0) ** 2 / (4 * np.pi ** 2)) ** (1 / 3.) / (0.974 * Rsun)
    baseline, rows = alias_scan(ta, ca, [2458848.6400, 2459748.8308, 2460649.0170], 0.0401378, ars_of)
    ref['alias'] = {'segments': segs, 'epochs': [2458848.6400, 2459748.8308, 2460649.0170], 'rprs': 0.0401378, 'mstar': 1.02, 'rstar': 0.974, 'G': G, 'Msun': Msun, 'Rsun': Rsun, 'baseline': baseline, 'rows': rows}
    # lightkurve flatten and CDPP on the synthetic series
    g = np.isfinite(f)
    lc = lk.LightCurve(time=t[g] - 2457000, flux=f[g])
    ref['lk_flatten_trend'] = [round(float(x), 11) for x in lc.flatten(window_length=101, return_trend=True)[1].flux.value[::4]]
    ref['lk_cdpp'] = {'13': float(lc.estimate_cdpp().value), '30': float(lc.estimate_cdpp(transit_duration=30, savgol_window=301).value)}
    # real data: TrES-2 (Kepler Q1, pipeline aperture, default quality), transit-masked biweight, EXOTIC clip
    tpf = lk.read(os.path.join(HERE, 'data', 'kplr011446443-2009131105131_lpd-targ.fits.gz'), quality_bitmask='default')
    klc = tpf.to_lightcurve(aperture_mask='pipeline')
    kt, kf = klc.time.tdb.jd, klc.flux.value
    pl = {'b': dict(per=2.47061892, tmid=2454849.52664, rprs=0.1278, ars=8.06, inc=84.07, ecc=0.018, omega=268.0)}
    pl['b']['t14'] = duration_t14(2.47061892, 0.1278, 8.06, 84.07, 0.018, 268.0)
    km = transit_mask(kt, pl, pad=1.5)
    kfl, ktr = flatten(kt, kf, method='biweight', window_length=0.75, mask=km, break_tolerance=0.5, return_trend=True)
    kk = clip_outliers(kt, kfl, km)
    ref['tres2'] = {'planet': pl['b'], 'n': int(len(kt)), 'in_transit': int(km.sum()), 'trend': [None if not np.isfinite(x) else float(x) for x in ktr],
                    'clip_dropped': [int(x) for x in np.flatnonzero(~kk)], 'depth_ppm': float(1e6 * (np.nanmedian(kfl[~km]) - np.nanmedian(kfl[transit_mask(kt, pl, pad=0.5)]))),
                    'cdpp_flat': float(lk.LightCurve(time=klc.time[~km & kk], flux=kfl[~km & kk]).estimate_cdpp().value)}
    with open(os.path.join(HERE, 'lcprep_reference.json'), 'w') as fh:
        json.dump(ref, fh, separators=(',', ':'))
    print('mask', ref['transit_mask_count'], 'clip', len(ref['clip']['dropped']), 'trim', len(ref['trim']), 'best window', best, {k: round(v['depth_recovered'], 3) for k, v in scan.items()})
    print('box check', ref['box_check'], 'cdpp', ref['lk_cdpp'], 'tres2 depth', round(ref['tres2']['depth_ppm']), 'cdpp', round(ref['tres2']['cdpp_flat'], 1))
    print('alias', [(r['N'], round(r['per'], 3), r['covered'], r['missed']) for r in rows[:10]])

if __name__ == '__main__':
    main()
