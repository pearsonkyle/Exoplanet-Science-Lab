# Builds the TOI-1873 worked examples from the owner's EXOTIC analysis of the real TESS and NEID data (read only):
#   .venv/bin/python public/examples/toi1873/make_example.py [path to EXOTIC/examples/toi-3planet]
# Writes, in this folder:
#   session.json       three planets (b, c and the candidate d at its 128.598 d alias), TESS windows binned to 10 min,
#                      37 NEID velocities; masses, radii, inclinations and ephemerides free (example "toi1873")
#   transit_times.csv  the per-transit mid-times of EXOTIC's fits (50 transits: 39 b, 8 c, 3 d)
#   oc_session.json    timing only: linear ephemerides of b and c from their mid-times (example "toi1873-oc")
# Nothing is written into the EXOTIC folder. Deterministic.
import json, sys, os
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else '/Users/kpearson/Programs/science/exoplanet/EXOTIC/examples/toi-3planet'
OUT = os.path.dirname(os.path.abspath(__file__))
TS = os.path.join(SRC, 'output/toi_1873/toi1873_timeseries.npz')
FITS = os.path.join(SRC, 'output/toi_1873/toi1873_transit_fits.json')
RV = os.path.join(SRC, 'TOI1873_2D.dat')
BIN_MIN = float(os.environ.get('BIN_MIN', 10))          # bin width of the light curve [min]
HALF = 1.25             # half window around each mid-transit, in transit durations (2.5 T14 in all)
TREF = 2459500.0        # time reference of the sessions (all times in the files are absolute BJD_TDB)
MJUP_MEARTH = 317.828

fits = json.load(open(FITS))
z = np.load(TS)
t, f, e = z['time'], z['flux'], z['flux_err']
ok = np.isfinite(t) & np.isfinite(f) & np.isfinite(e) & (e > 0)
t, f, e, sec = t[ok], f[ok], e[ok], z['sector'][ok]

# ---- windows around every predicted transit of b, c and d (the per-transit linear ephemerides of EXOTIC's run)
eph = {p: fits['planets'][p]['ephemeris'] for p in 'bcd'}
geo = {p: fits['planets'][p]['geometry'] for p in 'bcd'}
mask = np.zeros(t.size, bool)
for p in 'bcd':
    P, T0, w = eph[p]['per'], eph[p]['tmid'], HALF * geo[p]['t14']
    n = np.round((t - T0) / P)
    mask |= np.abs(t - (T0 + n * P)) < w
t, f, e, sec = t[mask], f[mask], e[mask], sec[mask]
order = np.argsort(t); t, f, e, sec = t[order], f[order], e[order], sec[order]

# ---- contiguous stretches (gap > 30 min starts a new one) binned to BIN_MIN; each stretch is one epoch with its own normalisation
cuts = np.where(np.diff(t) > 30 / 1440)[0] + 1
bt, bf, be, bep, names = [], [], [], [], []
for k, idx in enumerate(np.split(np.arange(t.size), cuts)):
    if idx.size < 30: continue                       # under an hour of 2-min data
    tt, ff, ee = t[idx], f[idx], e[idx]
    edges = np.arange(tt[0], tt[-1] + BIN_MIN / 1440, BIN_MIN / 1440)
    j = np.clip(np.digitize(tt, edges) - 1, 0, len(edges) - 1)
    rows = []
    for b in np.unique(j):
        s = j == b
        if s.sum() < 3: continue                     # a bin needs at least 3 of its 5 cadences
        w = 1 / ee[s] ** 2
        rows.append((np.sum(w * tt[s]) / w.sum(), np.sum(w * ff[s]) / w.sum(), 1 / np.sqrt(w.sum())))
    if len(rows) < 8: continue
    # which planets transit in this stretch (for the epoch's name)
    lab = [p for p in 'bcd' if np.any(np.abs(tt - (eph[p]['tmid'] + np.round((tt - eph[p]['tmid']) / eph[p]['per']) * eph[p]['per'])) < 0.5 * geo[p]['t14'])]
    ep = len(names)
    names.append(f"S{int(sec[idx[0]])} {'+'.join(lab) or 'baseline'} {tt[0]:.2f}")
    for r in rows: bt.append(r[0]); bf.append(r[1]); be.append(r[2]); bep.append(ep)
bt, bf, be = np.array(bt), np.array(bf), np.array(be)
print(f'light curve: {mask.sum()} cadences in windows -> {bt.size} points of {BIN_MIN:g} min in {len(names)} epochs')

# ---- NEID velocities (km/s, median-centred, BJD - 2460000) -> m/s, absolute BJD
rv = [l.split() for l in open(RV) if l.strip() and l.split()[-1] == 'rv']
rvt = [float(r[0]) + 2460000 for r in rv]; rvv = [float(r[1]) * 1000 for r in rv]; rve = [float(r[2]) * 1000 for r in rv]
print(f'NEID: {len(rv)} velocities, {min(rvt):.2f} to {max(rvt):.2f}')

# ---- mid-transit times of EXOTIC's per-transit fits
times = []
for p in 'bcd':
    for x in fits['planets'][p]['transits']:
        times.append((p, x['tmid'], x['tmid_err'], int(x['sector'])))
times.sort(key=lambda r: r[1])
with open(os.path.join(OUT, 'transit_times.csv'), 'w') as fh:
    fh.write('planet,tmid,err,source\n')
    for p, tm, er, s in times: fh.write(f'{p},{tm:.6f},{er:.6f},TESS S{s}\n')

# ---- the system. Star: ARIADNE SED fit of the published pyaneti analysis (2p_circ_prod_params.dat); planets b and c:
# that fit's medians as starting values; d: EXOTIC's three transits at the shortest allowed alias (128.598 d)
STAR = {'teff': 5605, 'teffErr': 45, 'logg': 4.471, 'loggErr': 0.05, 'feh': 0.0, 'fehErr': 0.1, 'rstar': 0.974, 'rstarErr': 0.019, 'mstar': 1.02, 'mstarErr': 0.044}
# reference epochs near the middle of the TESS baseline (as pyaneti quotes them), so T0 and P are nearly uncorrelated
def mid(p, tref):
    P, T0 = eph[p]['per'], eph[p]['tmid']; return T0 + round((tref - T0) / P) * P
PL = {
    'b': {'rprs': 0.0268254, 'inc': 88.91, 'per': eph['b']['per'], 'tmid': mid('b', 2459583.7146), 'ecc': 0, 'omega': 0, 'mplanet': 9.07 / MJUP_MEARTH},
    'c': {'rprs': 0.0397857, 'inc': 89.72, 'per': eph['c']['per'], 'tmid': mid('c', 2459753.6775), 'ecc': 0, 'omega': 0, 'mplanet': 27.69 / MJUP_MEARTH},
    'd': {'rprs': 0.0401378, 'inc': 89.654, 'per': 900.1885 / 7, 'tmid': mid('d', 2459748.83), 'ecc': 0, 'omega': 0, 'mplanet': 10 / MJUP_MEARTH},
}
# d: three transits 900.1885 d apart; the aliases P = 900.1885 / N that the TESS coverage allows (src/core/aliases.js aliasScan,
# EXOTIC's stage_alias_scan): N = 1, 2, 3, 4, 7. The main fit samples N with a categorical prior and the span itself.
SPAN_D, ALLOWED_D = 900.1885, [1, 2, 3, 4, 7]
PL_ALIAS_D = {**PL['d'], 'palias': SPAN_D, 'nalias': 7}
r6 = lambda x: round(x, 6) if abs(x) > 1e4 else float(f'{x:.8g}')   # Julian dates to 1e-6 d, other numbers to 8 digits
U = lambda a, b: {'type': 'uniform', 'a': r6(a), 'b': r6(b)}
def planet_free(p):
    s = '' if p == 'b' else '@' + p
    v, P = PL[p], PL[p]['per']
    if p == 'd':   # the alias: N categorical, the span within +- 6 sigma of EXOTIC's three-transit value (+- 0.004 d)
        return [
            {'key': 'rprs@d', 'label': 'Rp/R★ · d', 'unit': '', 'prior': U(0.015, 0.05)},
            {'key': 'inc@d', 'label': 'i · d', 'unit': '°', 'prior': U(89.2, 90)},
            {'key': 'palias@d', 'label': 'P × N · d', 'unit': 'd', 'prior': U(SPAN_D - 0.025, SPAN_D + 0.025)},
            {'key': 'nalias@d', 'label': 'N alias · d', 'unit': '', 'prior': {'type': 'categorical', 'values': ALLOWED_D}},
            {'key': 'tmid@d', 'label': 'T mid · d', 'unit': 'd', 'prior': U(v['tmid'] - 0.02, v['tmid'] + 0.02)},
            {'key': 'mplanet@d', 'label': 'Mp · d', 'unit': 'M Jup', 'prior': U(0, 0.2)},
        ]
    # P and T mid: +- 6 sigma of the linear ephemeris through EXOTIC's per-transit mid-times (as EXOTIC's own joint fit seeds them)
    dP, dT = {'b': 1.1e-4, 'c': 3.2e-4, 'd': 3.1e-3}[p], {'b': 0.010, 'c': 0.008, 'd': 0.020}[p]
    return [
        {'key': 'rprs' + s, 'label': 'Rp/R★' + (' · ' + p if s else ''), 'unit': '', 'prior': U(0.015, 0.05)},
        {'key': 'inc' + s, 'label': 'i' + (' · ' + p if s else ''), 'unit': '°', 'prior': U({'b': 86, 'c': 88, 'd': 89.2}[p], 90)},
        {'key': 'per' + s, 'label': 'P' + (' · ' + p if s else ''), 'unit': 'd', 'prior': U(P - dP, P + dP)},
        {'key': 'tmid' + s, 'label': 'T mid' + (' · ' + p if s else ''), 'unit': 'd', 'prior': U(v['tmid'] - dT, v['tmid'] + dT)},
        {'key': 'mplanet' + s, 'label': 'Mp' + (' · ' + p if s else ''), 'unit': 'M Jup', 'prior': U(0, 0.2)},
    ]

def session(title, notes, data, fit, planets=('b', 'c', 'd'), nbody=None, ld=None, alias=False, physical=None):
    s = {
        'format': 'esl-session', 'version': 1, 'software': {'name': 'exoplanet-science-lab', 'version': '0.2.0', 'commit': None},
        'created': '2026-11-16T00:00:00Z', 'name': 'TOI-1873', 'title': title, 'notes': notes,
        'star': STAR,
        'limb_darkening': ld or {'law': 'kipping', 'mode': 'coeffs', 'band': 'TESS (approx.)', 'coefficients': [0.4994, 0.1140]},
        'planets': [{'letter': p, 'parameters': {k: (r6(x) if k != 'tmid' else round(x, 6)) for k, x in (PL_ALIAS_D if alias and p == 'd' else PL[p]).items()}} for p in planets],
        'kepler': True, 'time_reference': TREF, 'data': data, 'fit': fit, 'result': None,
    }
    if nbody: s['nbody'] = nbody
    if physical: s['physical'] = physical
    return s

SRC_NOTE = 'Real data: TESS SPOC light curves (13 sectors) as extracted and detrended in EXOTIC examples/toi-3planet, and 37 NEID velocities of the published pyaneti analysis. See public/examples/toi1873/README.md.'
lc = {'name': 'TESS (SPOC, detrended, 10-min bins)', 'time': [round(x, 6) for x in bt], 'flux': [round(x, 7) for x in bf], 'flux_err': [round(x, 7) for x in be],
      'airmass': None, 'exposure_min': BIN_MIN, 'epoch': [int(x) for x in bep], 'epochs': [{'name': n, 'airmass': False} for n in names]}
rvset = [{'name': 'NEID', 'time': [round(x, 6) for x in rvt], 'velocity': [round(x, 3) for x in rvv], 'velocity_err': [round(x, 3) for x in rve]}]
main = session(
    'TOI-1873: two planets and a candidate, TESS + NEID',
    SRC_NOTE + ' Free: Rp/R★, i, P, T mid and the mass of each planet, the limb darkening (q1, q2) and the NEID jitter; a/R★ follows from Kepler’s law, orbits circular. Planet d’s period is 900.1885 d / N with N one of the aliases the TESS coverage allows (1, 2, 3, 4, 7), sampled; orbits that cross or are not Hill stable have no prior mass.',
    {'light_curve': lc, 'radial_velocity': rvset, 'timing': []},
    {'use': {'lc': True, 'rv': True, 'timing': False},
     'free': sum([planet_free(p) for p in 'bcd'], []) + [
         {'key': 'ld0', 'label': 'q1', 'unit': '', 'prior': U(0, 1)}, {'key': 'ld1', 'label': 'q2', 'unit': '', 'prior': U(0, 1)},
         {'key': 'jit@rv1', 'label': 'jitter · NEID', 'unit': 'm/s', 'prior': U(0, 15)}],
     'fixed': {'jit@rv1': 2.0, 'rvlin': 0}, 'timing_noise': 0, 'sampler': {'nlive': 400, 'fracRemain': 0.01, 'seed': 42, 'maxCalls': 1500000}},
    alias=True, physical={'crossing': True, 'hill': True})
main['ui'] = {'view': 'lc', 'fold': True, 'tab': 'fit'}
json.dump(main, open(os.path.join(OUT, 'session.json'), 'w'), separators=(',', ':'))

# ---- timing-only sessions
timing = [{'planet': p, 'kind': 'transit', 'time': round(tm, 6), 'err': round(er, 6), 'source': f'TESS S{s}'} for p, tm, er, s in times]
def lin_free(p):
    s = '' if p == 'b' else '@' + p; v, P = PL[p], PL[p]['per']; dP = {'b': 4e-4, 'c': 1e-3, 'd': 0.01}[p]
    return [{'key': 'per' + s, 'label': 'P' + (' · ' + p if s else ''), 'unit': 'd', 'prior': U(P - dP, P + dP)},
            {'key': 'tmid' + s, 'label': 'T mid' + (' · ' + p if s else ''), 'unit': 'd', 'prior': U(v['tmid'] - 0.02, v['tmid'] + 0.02)}]
oc = session('TOI-1873: linear ephemerides and O − C from 50 TESS mid-transit times',
             'Real data: the mid-transit times of EXOTIC’s per-transit fits of the TESS light curves (examples/toi-3planet): 39 of b, 8 of c, 3 of the candidate d (at its 128.598 d alias; three points leave one degree of freedom).',
             {'light_curve': None, 'radial_velocity': [], 'timing': [x for x in timing]},
             {'use': {'lc': False, 'rv': False, 'timing': True}, 'free': lin_free('b') + lin_free('c') + lin_free('d'), 'fixed': {}, 'timing_noise': 0,
              'sampler': {'nlive': 400, 'fracRemain': 0.01, 'seed': 42, 'maxCalls': 1000000}}, planets=('b', 'c', 'd'))
oc['ui'] = {'tab': 'timing', 'timing_order': 1}
json.dump(oc, open(os.path.join(OUT, 'oc_session.json'), 'w'), indent=0)

print('wrote session.json, oc_session.json, transit_times.csv')
