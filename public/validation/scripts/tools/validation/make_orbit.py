# Orbit and timing: Kepler's equation, periastron and eclipse times, transit durations.
#   .venv-validation/bin/python tools/validation/make_orbit.py
# Writes public/validation/orbit.json. Truth in 30-digit arithmetic (mpmath); durations by root finding on the orbit.
import json, math, os, subprocess, sys, tempfile, warnings
import numpy as np, mpmath as mp
warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE)
from common import *
import codes
from make_transit_util import run_ext, guarded, PYANETI, EXOTIC
DEG = math.pi / 180
import batman, radvel, exoplanet_core as ec, pylightcurve as plc
from radvel import _kepler as rk
from PyAstronomy import pyasl
from pytransit.orbits import orbits_py as po

# ---------------- 1. Kepler's equation: true anomaly for a grid of mean anomalies
ECC = [0.05, 0.3, 0.6, 0.8, 0.9, 0.93, 0.97, 0.99, 0.999]
rng = np.random.default_rng(3)
M = np.sort(np.concatenate([np.linspace(-math.pi, math.pi, 121)[1:-1], rng.uniform(-math.pi, math.pi, 60), [-1e-2, -1e-4, -1e-7, 1e-7, 1e-4, 1e-2], rng.uniform(-0.2, 0.2, 15)]))
wrap = lambda d: (np.asarray(d) + math.pi) % (2 * math.pi) - math.pi
kep = {'M': M.tolist(), 'ecc': ECC, 'nu': [], 'E': [], 'codes': {}}
an_in = []
for e in ECC:
    E = [kepler_mp(m, e) for m in M]; nu = np.array([float(true_anomaly_mp(x, mp.mpf(e))) for x in E]); Ef = np.array([float(x) for x in E])
    kep['nu'].append(nu.tolist()); kep['E'].append(Ef.tolist())
    def rec(name, kind, fn):
        ref = nu if kind == 'nu' else Ef
        val, err = guarded(lambda: np.asarray(fn(), float).tolist())
        ent = kep['codes'].setdefault(name, {'kind': kind, 'max': [], 'note': '', 'failures': {}})
        if err: ent['max'].append(None); ent['failures'][str(e)] = err
        else: ent['max'].append(sig(np.max(np.abs(wrap(np.asarray(val) - ref))), 2))
    rec('radvel (C)', 'E', lambda: rk.kepler_array(M % (2 * math.pi), e))
    rec('radvel (Python)', 'E', lambda: radvel.kepler.kepler(M % (2 * math.pi), np.full(len(M), e)))
    rec('exoplanet-core', 'nu', lambda: np.arctan2(*ec.kepler(M, np.full(len(M), e))))
    ks = pyasl.MarkleyKESolver(); rec('PyAstronomy (Markley)', 'E', lambda: [ks.getE(m % (2 * math.pi), e) for m in M])
    def bat():
        p = batman.TransitParams(); p.t0 = 0.0; p.per = 2 * math.pi; p.rp = 0.1; p.a = 1000.0; p.inc = 90.0; p.ecc = e; p.w = 90.0; p.u = [0.1, 0.3]; p.limb_dark = 'quadratic'
        return batman.TransitModel(p, M.copy()).get_true_anomaly()                 # w = 90 deg puts the transit at periastron, so t = M
    rec('batman', 'nu', bat)
    rec('PyTransit (Newton)', 'nu', lambda: po.ta_newton_v(M.copy(), 0.0, 2 * math.pi, e, math.pi / 2))
    an_in.append({'e': e, 'M': M.tolist()})
for a_in, nu_t in zip(an_in, kep['nu']):           # one eccentricity per process: pyaneti stops the interpreter if its Newton loop gives up
    out = run_ext(PYANETI, 'ext_pyaneti.py', {'anom': [a_in]})
    ent = kep['codes'].setdefault('pyaneti', {'kind': 'nu', 'max': [], 'note': '', 'failures': {}})
    if out: ent['max'].append(sig(np.max(np.abs(wrap(np.asarray(out['anom'][0]) - np.asarray(nu_t)))), 2))
    else: ent['max'].append(None); ent['failures'][str(a_in['e'])] = 'process ended without a result'
kep['codes']['batman']['note'] = 'true anomaly from TransitModel.get_true_anomaly()'
kep['codes']['PyTransit (Newton)']['note'] = 'orbits_py.ta_newton_v, the solver its eccentric models can use'

# ---------------- 2. event times: periastron and secondary eclipse relative to mid-transit
ev = []
for e in (0.1, 0.3, 0.6, 0.93):
    for w in (0.0, 60.0, 135.0, 200.0, 301.301):
        ev.append(dict(per=10.0, tmid=0.25, ecc=e, omega=w, ars=30.0, inc=89.0, rprs=0.1))
ev.append(dict(per=111.436765, tmid=0.25, ecc=0.93183, omega=-58.887, ars=94.452, inc=89.24, rprs=math.sqrt(0.01019), label='HD 80606 b (Pearson et al. 2022, Table 7)'))
def near(t, c): return float(t - c['per'] * mp.nint((t - c['tmid']) / c['per']))
for c in ev:
    e, w, P = mp.mpf(c['ecc']), mp.radians(mp.mpf(c['omega'])), mp.mpf(c['per'])
    M0 = m0_transit_mp(e, w)
    tp = mp.mpf(c['tmid']) - M0 / (2 * mp.pi) * P
    if tp > c['tmid']: tp -= P
    nuE = -mp.pi / 2 - w; Ee = 2 * mp.atan2(mp.sqrt(1 - e) * mp.sin(nuE / 2), mp.sqrt(1 + e) * mp.cos(nuE / 2))
    te = mp.mpf(c['tmid']) + (Ee - e * mp.sin(Ee) - M0) / (2 * mp.pi) * P
    c['truth'] = {'tperi': float(tp), 'tecl': near(te, c), 'dtMinSep': dt_min_sep(c)}
    # time of minimum separation near the eclipse, for the same remark as at transit
    c['label'] = c.get('label') or f"e = {c['ecc']}, omega = {c['omega']:g}"
    wr = c['omega'] * DEG; r = c['codes'] = {}
    modP = lambda t, ref: float(t - c['per'] * round((t - ref) / c['per']))
    rtp = radvel.orbit.timetrans_to_timeperi(c['tmid'], c['per'], c['ecc'], wr)
    rte = radvel.orbit.timeperi_to_timetrans(rtp, c['per'], c['ecc'], wr, secondary=True)
    r['radvel'] = {'tperi': modP(rtp, c['truth']['tperi']), 'tecl': modP(rte, c['truth']['tecl']), 'eclOrbitsAfterPeri': round((rte - rtp) / c['per'], 3)}
    p = batman.TransitParams(); p.t0 = c['tmid']; p.per = c['per']; p.rp = c['rprs']; p.a = c['ars']; p.inc = c['inc']; p.ecc = c['ecc']; p.w = c['omega']; p.u = [0.1, 0.3]; p.limb_dark = 'quadratic'
    bm = batman.TransitModel(p, np.array([c['tmid']]))
    r['batman'] = {'tperi': modP(bm.get_t_periastron(p), c['truth']['tperi']), 'tecl': modP(bm.get_t_secondary(p), c['truth']['tecl'])}
    r['pylightcurve'] = {'tecl': modP(float(plc.eclipse_mid_time(c['per'], c['ars'], c['ecc'], c['inc'], c['omega'], c['tmid'])), c['truth']['tecl'])}
    r['PyTransit'] = {'tecl': modP(c['tmid'] + float(po.eclipse_phase.py_func(c['per'], c['inc'] * DEG, c['ecc'], wr)), c['truth']['tecl'])}
out = run_ext(PYANETI, 'ext_pyaneti.py', {'tp': ev})
if out:
    for c, y in zip(ev, out['tp']): c['codes']['pyaneti'] = {'tperi': float(y - c['per'] * round((y - c['truth']['tperi']) / c['per']))}

# ---------------- 3. durations by root finding on the 30-digit orbit, against closed forms and other codes
def contact_times(c, limit, tc):
    """Times either side of tc where the projected separation equals `limit` (None if it never gets that close at tc)."""
    inc = mp.radians(mp.mpf(c['inc']))
    def sep(t):
        r, u = orbit_mp(t, c); return r * mp.sqrt(1 - (mp.sin(u) * mp.sin(inc)) ** 2)
    tc = mp.mpf(tc)
    if sep(tc) >= limit: return None
    res = []
    for d in (-1, 1):
        h = mp.mpf(c['per']) * mp.mpf('1e-5'); a = tc; b = tc + d * h
        while sep(b) < limit: a = b; h *= 2; b = tc + d * h
        for _ in range(90):
            m = (a + b) / 2
            if sep(m) < limit: a = m
            else: b = m
        res.append((a + b) / 2)
    return res
def winn(c, sign=1):
    """Winn (2010) eqs. 14-16: durations of the transit (sign = +1) or occultation (-1)."""
    e, w, inc, k, a = c['ecc'], c['omega'] * DEG, c['inc'] * DEG, c['rprs'], c['ars']
    rho = (1 - e * e) / (1 + sign * e * math.sin(w)); b = a * math.cos(inc) * rho
    fac = c['per'] / math.pi * math.sqrt(1 - e * e) / (1 + sign * e * math.sin(w))
    f = lambda x: fac * math.asin(min(1.0, math.sqrt(max((1 + x) ** 2 - b * b, 0.0)) / a / math.sin(inc))) if b < 1 + x else 0.0
    return f(k), f(-k), b
def dcase(label, rprs=0.1, b=0.3, ars=10.0, per=3.5, ecc=0.0, omega=0.0, inc=None):
    inc = math.degrees(math.acos(b / ars * (1 + ecc * math.sin(omega * DEG)) / (1 - ecc ** 2))) if inc is None else inc
    return dict(label=label, rprs=rprs, per=per, tmid=0.25, ars=ars, inc=inc, ecc=ecc, omega=omega)
dur = [dcase('circular, b = 0.3'), dcase('circular, b = 0.8', b=0.8), dcase('circular, grazing (b = 0.97)', b=0.97), dcase('circular, a/R* = 2.5', ars=2.5, per=0.8),
       dcase('e = 0.3, omega = 30', ecc=0.3, omega=30, per=5.3, ars=12), dcase('e = 0.6, omega = 110', ecc=0.6, omega=110, per=9.0, ars=18),
       dcase('e = 0.6, omega = 250', ecc=0.6, omega=250, per=9.0, ars=18), dcase('e = 0.6, omega = 0, b = 0.7', ecc=0.6, omega=0, per=9.0, ars=18, b=0.7),
       dcase('e = 0.93, omega = 120', ecc=0.93, omega=120, per=40.0, ars=40.0),
       dcase('HD 80606 b (Pearson et al. 2022, Table 7)', rprs=math.sqrt(0.01019), per=111.436765, ars=94.452, ecc=0.93183, omega=-58.887, inc=89.24)]
for c in dur:
    k = c['rprs']; tr = c['truth'] = {}
    e, w, P = mp.mpf(c['ecc']), mp.radians(mp.mpf(c['omega'])), mp.mpf(c['per'])
    M0 = m0_transit_mp(e, w); nuE = -mp.pi / 2 - w; Ee = 2 * mp.atan2(mp.sqrt(1 - e) * mp.sin(nuE / 2), mp.sqrt(1 + e) * mp.cos(nuE / 2))
    te = mp.mpf(c['tmid']) + (Ee - e * mp.sin(Ee) - M0) / (2 * mp.pi) * P; te = te - P * mp.nint((te - c['tmid']) / P)
    for name, lim, tc in (('t14', 1 + k, c['tmid']), ('t23', 1 - k, c['tmid']), ('e14', 1 + k, te), ('e23', 1 - k, te)):
        ct = contact_times(c, lim, tc)
        tr[name] = float(ct[1] - ct[0]) if ct else 0.0
        if name == 't14' and ct: tr['contactMid'] = float((ct[0] + ct[1]) / 2 - c['tmid'])     # midpoint of first and last contact minus conjunction
    tr['dtMinSep'] = dt_min_sep(c); tr['tecl'] = float(te)
    W = winn(c, 1); We = winn(c, -1)
    c['codes'] = {'Winn (2010) eqs. 14-16': {'t14': W[0], 't23': W[1], 'e14': We[0], 'e23': We[1]}}
    c['b'] = W[2]
    pl = {}
    for nm, f in (('t14', lambda: plc.transit_duration(k, c['per'], c['ars'], c['ecc'], c['inc'], c['omega'])), ('e14', lambda: plc.eclipse_duration(k, c['per'], c['ars'], c['ecc'], c['inc'], c['omega']))):
        try: pl[nm] = float(f())
        except Exception as ex: pl[nm] = None
    c['codes']['pylightcurve'] = pl
    c['codes']['PyTransit'] = {'t14': float(po.d_from_pkaiews.py_func(c['per'], k, c['ars'], c['inc'] * DEG, c['ecc'], c['omega'] * DEG, 1, 14)), 't23': float(po.d_from_pkaiews.py_func(c['per'], k, c['ars'], c['inc'] * DEG, c['ecc'], c['omega'] * DEG, 1, 23)),
                               'e14': float(po.d_from_pkaiews.py_func(c['per'], k, c['ars'], c['inc'] * DEG, c['ecc'], c['omega'] * DEG, -1, 14))}
out = run_ext(EXOTIC, 'ext_exotic.py', {'dur': dur})
if out:
    for c, r in zip(dur, out['dur']): c['codes']['pylightcurve (EXOTIC env)'] = {'t14': r['t14'], 'e14': r['e14']}

vers = codes.versions()
dump(os.path.join(ROOT, 'public/validation/orbit.json'), {'date': today(), 'versions': vers, 'kepler': kep, 'events': ev, 'durations': dur,
     'published': {'label': 'Pearson et al. (2022), Table 7, HD 80606 b', 't14': 0.4990, 'e14': 0.07169}})
print('Kepler max error per eccentricity', ECC)
for k, v in kep['codes'].items(): print('  %-24s %s' % (k, v['kind']), ' '.join('fail' if x is None else '%.0e' % x for x in v['max']), v.get('failures') or '')
print('events: worst |code - truth| [s]')
for code in ('radvel', 'batman', 'pylightcurve', 'PyTransit', 'pyaneti'):
    for q in ('tperi', 'tecl'):
        d = [abs(c['codes'][code][q] - c['truth'][q]) * 86400 for c in ev if code in c['codes'] and q in c['codes'][code]]
        if d: print('  %-14s %-6s %.2e s' % (code, q, max(d)))
print('radvel eclipse offsets (orbits after periastron):', sorted(set(c['codes']['radvel']['eclOrbitsAfterPeri'] > 1 for c in ev)))
for c in dur:
    print(c['label'], '| truth', {k: round(v, 6) for k, v in c['truth'].items()})
    for k, v in c['codes'].items(): print('      %-26s' % k, {q: (None if x is None else round(x, 6)) for q, x in v.items() if q != 'error'})
