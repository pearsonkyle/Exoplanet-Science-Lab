"""References for test/detrend.test.mjs (src/core/detrend.js and the kernel / regressor terms of buildProblem).

    .venv/bin/python test/make_detrend_reference.py          # numpy, scipy: synthetic data, PLD, ensemble weights
    /Users/kpearson/miniconda3/envs/exotic/bin/python -B test/make_detrend_reference.py --exotic
                                                             # EXOTIC's own gaussian_weights, weightedflux, transit and
                                                             # lc_fitter(features=..., mode='lm') on the same data
Writes test/detrend_reference.json (the --exotic run adds its block to what is there).

The synthetic data imitate a Spitzer/IRAC staring observation: a Gaussian PSF (sigma 0.9 px) wanders over a 5 x 5 px
box (a slow drift plus a 40-minute pointing oscillation plus jitter), each pixel has its own sensitivity and the
sensitivity varies across a pixel (intrapixel, 1.5% peak to peak), so the summed flux follows the centroid. The transit is
a uniform disc (no limb darkening: the closed-form overlap area of two circles, independent of this code's line
integral), circular orbit.
"""
import json, os, sys
import numpy as np

path = os.path.join(os.path.dirname(__file__), 'detrend_reference.json')
out = json.load(open(path)) if os.path.exists(path) else {}


def uniform_transit(t, rprs, ars, inc, per, tmid):
    ph = 2 * np.pi * (t - tmid) / per
    z = ars * np.sqrt(np.sin(ph) ** 2 + (np.cos(np.radians(inc)) * np.cos(ph)) ** 2)
    p = rprs; lam = np.zeros_like(z)
    full = z <= 1 - p; lam[full] = p * p
    part = (z > 1 - p) & (z < 1 + p)
    zz = z[part]
    k0 = np.arccos(np.clip((p * p + zz * zz - 1) / (2 * p * zz), -1, 1)); k1 = np.arccos(np.clip((1 - p * p + zz * zz) / (2 * zz), -1, 1))
    lam[part] = (p * p * k0 + k1 - 0.5 * np.sqrt(np.maximum(0, 4 * zz * zz - (1 + zz * zz - p * p) ** 2))) / np.pi
    lam[np.cos(ph) < 0] = 0          # far side
    return 1 - lam


SYS = {'rprs': 0.1, 'ars': 8.0, 'inc': 87.5, 'per': 2.2, 'tmid': 0.25}

if '--exotic' not in sys.argv:
    rng = np.random.default_rng(20261115)
    n = 1200
    t = np.linspace(0, 0.5, n)
    xc = 2.0 + 0.25 * (t / 0.5) + 0.12 * np.sin(2 * np.pi * t / (40 / 1440)) + rng.normal(0, 0.03, n)
    yc = 2.0 - 0.15 * (t / 0.5) + 0.08 * np.cos(2 * np.pi * t / (40 / 1440) + 0.7) + rng.normal(0, 0.03, n)
    gain = 1 + 0.02 * rng.normal(size=(5, 5))
    sig = 0.9
    pix = np.zeros((25, n))
    yy, xx = np.mgrid[0:5, 0:5]
    for i in range(n):
        # integrate the PSF over 6 x 6 sub-pixels, sensitivity varies across each pixel as 1 + 0.0075 cos(2 pi u) cos(2 pi v)
        s = np.linspace(-0.5 + 1 / 12, 0.5 - 1 / 12, 6)
        U, V = np.meshgrid(s, s)
        for k in range(25):
            px, py = xx.flat[k] + U, yy.flat[k] + V
            psf = np.exp(-((px - xc[i]) ** 2 + (py - yc[i]) ** 2) / (2 * sig * sig)) / (2 * np.pi * sig * sig)
            pix[k, i] = gain.flat[k] * np.mean(psf * (1 + 0.0075 * np.cos(2 * np.pi * U) * np.cos(2 * np.pi * V)))
    tr = uniform_transit(t, **SYS)
    star = 1e5
    pix *= star * tr[None, :]
    noise = 2.5e-4
    pix += rng.normal(0, noise * star / 5, pix.shape)          # white noise on each pixel, ~2.5e-4 of the total per point
    pix = np.round(pix, 3)                                      # what is stored is what is used
    flux = pix.sum(0)
    med = np.median(flux); f = flux / med; e = np.full(n, noise)
    out['synthetic'] = {'system': SYS, 't': t.tolist(), 'f': f.tolist(), 'e': e.tolist(), 'xc': xc.tolist(), 'yc': yc.tolist(), 'pix': pix.tolist(), 'transit': tr.tolist(), 'noise': noise}

    # ---- PLD at the true transit (Deming et al. 2015): f = m * sum_k c_k Phat_k (the nine/twenty-five fractions span the constant)
    Phat = pix / pix.sum(0)
    G = (tr[None, :] * Phat).T / e[:, None]
    c, *_ = np.linalg.lstsq(G, f / e, rcond=None)
    chi_all = float(np.sum((f / e - G @ c) ** 2))
    # truncated: principal components of the centred fractions (numpy SVD), leading k, plus the constant
    Pc = Phat - Phat.mean(1, keepdims=True)
    U_, S_, Vt = np.linalg.svd(Pc.T, full_matrices=False)
    trunc = {}
    for k in (1, 2, 3, 5, 8):
        Z = U_[:, :k] * S_[:k]
        G2 = np.column_stack([tr, tr[:, None] * Z]) / e[:, None]
        c2, *_ = np.linalg.lstsq(G2, f / e, rcond=None)
        trunc[str(k)] = float(np.sum((f / e - G2 @ c2) ** 2))
    chi_none = float(np.sum((f / e - tr * (np.sum(f * tr / e ** 2) / np.sum(tr * tr / e ** 2)) / e) ** 2))
    ev = S_ ** 2 / np.sum(S_ ** 2)
    rank = int(np.sum(S_ > 1e-10 * S_[0]))
    out['pld'] = {'chi2_all_fractions': chi_all, 'chi2_pcs': trunc, 'chi2_no_detrend': chi_none, 'explained': ev[:10].tolist(), 'rank': rank}
    # linear regressors x, y, x^2, y^2, xy at the true transit, against numpy (the same standardisation as detrend.js)
    zs = lambda v: (v - v.mean()) / v.std()
    X = [zs(xc), zs(yc)]; X += [zs(X[0] ** 2), zs(X[1] ** 2), zs(X[0] * X[1])]     # products of the standardised columns, standardised again (as detrend.js)
    G3 = np.column_stack([tr] + [tr * x for x in X]) / e[:, None]
    c3, *_ = np.linalg.lstsq(G3, f / e, rcond=None)
    out['poly_xy'] = {'chi2': float(np.sum((f / e - G3 @ c3) ** 2)), 'coef': c3.tolist()}

    # ---- comparison ensemble: three-cornered hat on synthetic stars
    rng = np.random.default_rng(7)
    m, nn = 6, 400
    tt = np.linspace(0, 0.2, nn)
    atm = 1 - 0.08 * (tt / 0.2) ** 2 + 0.01 * np.sin(40 * tt)          # extinction and thin cloud, common to all stars
    sig_c = np.array([1.0, 2.0, 3.0, 1.5, 6.0, 1.2]) * 1e-3
    bright = np.array([3e4, 5e4, 2e4, 8e4, 1.2e5, 4e4])
    comps = [bright[j] * atm * (1 + rng.normal(0, sig_c[j], nn)) for j in range(m)]
    tr2 = uniform_transit(tt, 0.12, 6.0, 88.0, 3.0, 0.1)
    sig_t = 1.3e-3
    target = 4e4 * atm * tr2 * (1 + rng.normal(0, sig_t, nn))
    S = [target] + comps; L = [np.log(s) for s in S]
    rows, v = [], []
    for i in range(m + 1):
        for j in range(i + 1, m + 1):
            d = np.diff(L[i] - L[j]); r = np.zeros(m + 1); r[i] = r[j] = 1; rows.append(r); v.append(0.5 * np.var(d))
    s2, *_ = np.linalg.lstsq(np.array(rows), np.array(v), rcond=None)
    w = (1 / s2[1:]) / np.sum(1 / s2[1:])
    ens = sum(w[j] * comps[j] / np.median(comps[j]) for j in range(m))
    def scatter(r):
        q = r / tr2; return float(np.std(q / np.median(q)))
    out['ensemble'] = {'t': tt.tolist(), 'target': target.tolist(), 'comps': [c.tolist() for c in comps], 'transit': tr2.tolist(), 'sigma_true': sig_c.tolist(), 'sigma_target_true': sig_t,
                       'sigma2': s2.tolist(), 'weights': w.tolist(),
                       'scatter_weighted': scatter(target / ens), 'scatter_sum': scatter(target / sum(comps)), 'scatter_best_single': min(scatter(target / c) for c in comps)}
    json.dump(out, open(path, 'w'))
    print('pld chi2: none %.1f all %.1f pcs %s; ensemble weights %s; scatter weighted %.3e sum %.3e best single %.3e' % (
        chi_none, chi_all, {k: round(v, 1) for k, v in trunc.items()}, np.round(w, 4), out['ensemble']['scatter_weighted'], out['ensemble']['scatter_sum'], out['ensemble']['scatter_best_single']))
else:
    # EXOTIC's own code on the same synthetic data (read only; nothing is written into the repository or its environment)
    import warnings; warnings.filterwarnings('ignore')
    import exotic
    from exotic.api.elca import gaussian_weights, weightedflux, transit, lc_fitter
    syn = out['synthetic']
    t, f, e, xc, yc = (np.array(syn[k]) for k in ('t', 'f', 'e', 'xc', 'yc'))
    gw, nearest = gaussian_weights(np.column_stack([xc, yc]), w=1, neighbors=50)
    gw3, nearest3 = gaussian_weights(np.column_stack([xc, yc, (xc - 2) * (yc - 2)]), w=[1, 1, 0.5], neighbors=30)
    prior = {'rprs': SYS['rprs'], 'ars': SYS['ars'], 'per': SYS['per'], 'inc': SYS['inc'], 'u0': 0, 'u1': 0, 'u2': 0, 'u3': 0, 'ecc': 0, 'omega': 0, 'tmid': SYS['tmid'], 'a1': 1, 'a2': 0}
    chis = []
    for (rp, tm, inc) in [(0.1, 0.25, 87.5), (0.095, 0.2495, 87.0), (0.105, 0.2508, 88.2)]:
        p = dict(prior, rprs=rp, tmid=tm, inc=inc)
        lc = transit(t, p); wf = weightedflux(f / lc, gw, nearest); model = lc * wf
        chis.append({'rprs': rp, 'tmid': tm, 'inc': inc, 'chi2': float(np.sum(((f - model) / e) ** 2)), 'transit': lc.tolist()})
    bounds = {'rprs': [0.05, 0.15], 'tmid': [0.24, 0.26], 'inc': [84, 90]}
    fit = lc_fitter(t, f, e, np.zeros(len(t)), dict(prior), bounds, neighbors=50, mode='lm', verbose=False, features=np.column_stack([xc, yc]))
    out['exotic'] = {'generator': f'EXOTIC {exotic.__version__} (elca.gaussian_weights, weightedflux, transit, lc_fitter mode lm)',
                     'gw': gw[:300].tolist(), 'nearest': nearest[:300].tolist(), 'gw3': gw3[:300].tolist(), 'nearest3': nearest3[:300].tolist(), 'chi2_at': chis,
                     'lm_fit': {k: float(fit.parameters[k]) for k in bounds}, 'lm_res_std': float(fit.res_stdev)}
    json.dump(out, open(path, 'w'))
    print('EXOTIC lm fit with features:', out['exotic']['lm_fit'], 'res std', fit.res_stdev, '; chi2 at three points', [round(c['chi2'], 3) for c in chis])
