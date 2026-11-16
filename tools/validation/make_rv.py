# Radial velocities: the curve, its sign and omega conventions, and the semi-amplitude from masses.
#   .venv-validation/bin/python tools/validation/make_rv.py
# Writes public/validation/rv.json.
#
# Truth, two ways that share nothing but the orbit:
#   (a) K [cos(omega + nu) + e cos omega] with nu from the 30-digit Kepler solution
#   (b) geometry: the planet's coordinate toward the observer, Z = r sin(omega + nu) sin i, differentiated numerically in
#       30-digit arithmetic. The star moves the other way, so its velocity AWAY from the observer is +mu dZ/dt, and
#       K = mu n a sin i / sqrt(1 - e^2). (b) fixes the sign and the meaning of omega without quoting a formula.
import json, math, os, sys, warnings
import numpy as np, mpmath as mp
warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE)
from common import *
import codes
from make_transit_util import run_ext, PYANETI, EXOTIC
import radvel
DEG = math.pi / 180

def rv_formula(t, c):
    w = mp.radians(mp.mpf(c['omega'])); e = mp.mpf(c['ecc']); out = np.empty(len(t))
    for i, ti in enumerate(t):
        r, u = orbit_mp(ti, dict(c, ars=1, inc=90)); out[i] = float(c['K'] * (mp.cos(u) + e * mp.cos(w)))
    return out
def rv_geometry(t, c):
    e = mp.mpf(c['ecc']); n = 2 * mp.pi / mp.mpf(c['per'])
    Z = lambda x: (lambda ru: ru[0] * mp.sin(ru[1]))(orbit_mp(x, dict(c, ars=1, inc=90)))       # in units of a sin i
    return np.array([float(c['K'] * mp.sqrt(1 - e * e) / n * mp.diff(Z, mp.mpf(ti), h=mp.mpf('1e-8'))) for ti in t])

cases = [dict(label='circular', per=3.5, tmid=0.4, ecc=0.0, omega=0.0, K=50.0),
         dict(label='e = 0.3, omega = 30', per=5.3, tmid=0.4, ecc=0.3, omega=30.0, K=80.0),
         dict(label='e = 0.6, omega = 110', per=9.0, tmid=0.4, ecc=0.6, omega=110.0, K=120.0),
         dict(label='e = 0.6, omega = 250', per=9.0, tmid=0.4, ecc=0.6, omega=250.0, K=120.0),
         dict(label='e = 0.93, omega = -58.7 (HD 80606 b)', per=111.4367, tmid=0.4, ecc=0.93132, omega=-58.699, K=470.0)]
for c in cases:
    t = np.linspace(c['tmid'] - 0.6 * c['per'], c['tmid'] + 0.6 * c['per'], 241); c['t0'], c['t1'], c['n'] = float(t[0]), float(t[-1]), len(t)
    tr = rv_formula(t, c); c['truth'] = tr.tolist()
    c['geometryVsFormula'] = sig(np.max(np.abs(rv_geometry(t[::6], c) - tr[::6])) / c['K'], 2)
    c['codes'] = {}; c['wrong'] = {}
    w = c['omega'] * DEG
    tp = radvel.orbit.timetrans_to_timeperi(c['tmid'], c['per'], c['ecc'], w)
    c['codes']['radvel'] = [sig(x, 3) for x in (radvel.kepler.rv_drive(t, np.array([c['per'], tp, c['ecc'], w, c['K']])) - tr)]
    # the same call with omega shifted by 180 deg (what one would pass if ESL's omega were "of the planet" in radvel's sense)
    tp2 = radvel.orbit.timetrans_to_timeperi(c['tmid'], c['per'], c['ecc'], w + math.pi)
    c['wrong']['radvel, omega + 180 deg'] = sig(np.max(np.abs(radvel.kepler.rv_drive(t, np.array([c['per'], tp2, c['ecc'], w + math.pi, c['K']])) - tr)) / c['K'], 3)
    c['wrong']['sign flipped'] = sig(np.max(np.abs(-tr - tr)) / c['K'], 3)
    # sign: velocity a quarter period before mid-transit, in units of K (circular: +1 means the star is receding there)
    c['quarterBefore'] = {'truth': sig(rv_formula([c['tmid'] - c['per'] / 4], c)[0] / c['K'], 6),
                          'radvel': sig(radvel.kepler.rv_drive(np.array([c['tmid'] - c['per'] / 4]), np.array([c['per'], tp, c['ecc'], w, c['K']]))[0] / c['K'], 6)}
    c['_t'] = t
out = run_ext(PYANETI, 'ext_pyaneti.py', {'rv': [dict({k: v for k, v in c.items() if k in ('per', 'tmid', 'ecc', 'omega', 'K')}, t=c['_t'].tolist() + [c['tmid'] - c['per'] / 4]) for c in cases]})
ext = {}
if out:
    ext['pyaneti'] = out['version']
    for c, y in zip(cases, out['rv']):
        c['codes']['pyaneti'] = [sig(x, 3) for x in (np.asarray(y[:-1]) - np.asarray(c['truth']))]; c['quarterBefore']['pyaneti'] = sig(y[-1] / c['K'], 6)

# EXOTIC takes masses; its amplitude uses m_p/M* where the two-body value has m_p/(M* + m_p), so each case gets masses
# that give K by the two-body formula and EXOTIC's curve is compared after dividing by (1 + m_p/M*).
GMsun, GMjup = 1.3271244e20, 1.2668653e17          # IAU 2015 nominal values, m^3 s^-2
def K_two_body(per, ecc, inc, mp_jup, mstar):
    m = mp_jup * GMjup / GMsun
    return (2 * math.pi * GMsun / (per * 86400)) ** (1 / 3) * m * math.sin(inc * DEG) / (mstar + m) ** (2 / 3) / math.sqrt(1 - ecc ** 2)
ex_in = []
for c in cases:
    mstar, inc = 1.0, 89.0; m = 1.0
    for _ in range(60): m = m * c['K'] / K_two_body(c['per'], c['ecc'], inc, m, mstar)
    c['masses'] = {'mplanet': m, 'mstar': mstar, 'rstar': 1.0, 'inc': inc}
    ex_in.append(dict(per=c['per'], tmid=c['tmid'], ecc=c['ecc'], omega=c['omega'], t=c['_t'].tolist() + [c['tmid'] - c['per'] / 4], **c['masses']))
out = run_ext(EXOTIC, 'ext_exotic.py', {'rv': ex_in})
if out:
    ext['EXOTIC'] = out['version']
    for c, r in zip(cases, out['rv']):
        fac = 1 + r['mu']; tr = np.asarray(c['truth'])
        c['codes']['EXOTIC'] = [sig(x, 3) for x in (np.asarray(r['rv'][:-1]) / fac - tr)]
        c['codes']['EXOTIC (finer step)'] = [sig(x, 3) for x in (np.asarray(r['rv_fine'][:-1]) / fac - tr)]
        c['quarterBefore']['EXOTIC'] = sig(r['rv'][-1] / fac / c['K'], 6); c['exoticFactor'] = fac
for c in cases: del c['_t']

# ---- semi-amplitude from masses
from astropy import constants as ac, units as u
amp = []
for label, per, ecc, inc, mpj, ms in (('51 Peg b', 4.230785, 0.013, 90.0, 0.46, 1.11), ('HD 80606 b', 111.4367, 0.93132, 89.269, 4.20, 1.05),
                                       ('Jupiter and the Sun', 4332.59, 0.0489, 90.0, 1.0, 1.0), ('Earth and the Sun', 365.256, 0.0167, 90.0, 0.0031463520, 1.0),
                                       ('brown dwarf, 60 M Jup', 20.0, 0.4, 75.0, 60.0, 0.8)):
    mp_e = mpj * GMjup / 3.986004e14
    row = dict(label=label, per=per, ecc=ecc, inc=inc, mplanet=mpj, mstar=ms, truth=K_two_body(per, ecc, inc, mpj, ms))
    row['codes'] = {'radvel.utils.semi_amplitude': float(radvel.utils.semi_amplitude(mpj * math.sin(inc * DEG), per, ms + mpj * GMjup / GMsun, ecc, Msini_units='jupiter')),
                    'astropy constants': float((((2 * math.pi * ac.G / (per * u.day)) ** (1 / 3) * (mpj * ac.M_jup) * math.sin(inc * DEG) / (ms * ac.M_sun + mpj * ac.M_jup) ** (2 / 3)) / math.sqrt(1 - ecc ** 2)).to(u.m / u.s).value)}
    amp.append(row)

vers = codes.versions(); vers.update(ext)
dump(os.path.join(ROOT, 'public/validation/rv.json'), {'date': today(), 'versions': vers, 'cases': cases, 'amplitude': amp,
     'truth': 'K [cos(omega + nu) + e cos omega] with nu from a 30-digit Kepler solution; checked against the numerical derivative of the orbit geometry (geometryVsFormula, in units of K)'})
for c in cases:
    print(c['label'], '| geometry vs formula %.1e K' % c['geometryVsFormula'], '|', {k: '%.1e' % (max(map(abs, v)) / c['K']) for k, v in c['codes'].items()}, '| wrong', c['wrong'], '| quarter before', c['quarterBefore'])
for r in amp: print(r['label'], 'K = %.6f' % r['truth'], {k: '%.2e' % (v / r['truth'] - 1) for k, v in r['codes'].items()})
