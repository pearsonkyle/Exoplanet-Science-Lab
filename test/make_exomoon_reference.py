# Independent references for src/core/exomoon.js, written to test/exomoon_reference.json.
#
#   python3.12 -m venv .venv-moon
#   .venv-moon/bin/pip install numpy scipy astropy matplotlib numba pandas requests ultranest pandoramoon
#   .venv-moon/bin/python test/make_exomoon_reference.py [--elca DIR]
#
# Three references:
#  1. "union": the flux blocked by the union of two discs on a limb-darkened star by direct numerical
#     integration (scipy.integrate.quad). The star is cut into rings; on the ring of radius r the two
#     discs cover an angle L(r) that is known in closed form (two arcs and their overlap), so
#         blocked = int_0^1 I(r) r L(r) dr / (2 pi int_0^1 I r dr)
#     is a one-dimensional integral with kinks only at known radii (where a ring first touches a disc
#     and at the two corners of the lens), which are given to quad as break points. This shares nothing
#     with the line integral in exomoon.js. The ring formula itself is checked here against a brute-force
#     pixel sum.
#  2. "exomoon2": the owner's own calculation, examples/exomoon2.py of
#     https://github.com/pearsonkyle/Exoplanet-Light-Curve-Analysis, imported and called unchanged
#     (moon_transit and elca.tools.transit) on the configuration in its __main__ block. --elca points to
#     a checkout; without it the three files needed are downloaded to a temporary directory and the C
#     kernel is compiled with the command in its header (cc -O3 -shared -fPIC).
#  3. "pandora": Hippke & Heller's planet-moon code (PyPI: pandoramoon), light curve and sky positions.
import sys, os, json, math, copy, tempfile, subprocess, urllib.request
import numpy as np
from scipy.integrate import quad

HERE = os.path.dirname(os.path.abspath(__file__))
PI = math.pi

# ---------------------------------------------------------------- 1. union of two discs, by rings
def intensity(r, a):
    mu = math.sqrt(max(0.0, 1.0 - r * r))
    return 1.0 - sum(a[n] * (1.0 - mu ** ((n + 1) / 2.0)) for n in range(4))

def F1(a):
    return (1 - sum(a)) / 2 + a[0] / 2.5 + a[1] / 3 + a[2] / 3.5 + a[3] / 4

def half_angle(r, d, p):
    """half of the angle of the ring of radius r that lies inside a disc of radius p centred at distance d"""
    if r <= p - d: return PI
    if r <= d - p or r >= d + p or d == 0: return 0.0
    c = (r * r + d * d - p * p) / (2 * r * d)
    return math.acos(max(-1.0, min(1.0, c)))

def covered(r, d1, psi1, p1, d2, psi2, p2):
    b1, b2 = half_angle(r, d1, p1), half_angle(r, d2, p2)
    D = abs((psi2 - psi1 + PI) % (2 * PI) - PI)
    ov = max(0.0, min(2 * b1, 2 * b2, b1 + b2 - D)) + max(0.0, min(2 * b1, 2 * b2, b1 + b2 - (2 * PI - D)))
    return min(2 * PI, 2 * b1 + 2 * b2 - ov)

def union_truth(x1, y1, r1, x2, y2, r2, a):
    d1, d2 = math.hypot(x1, y1), math.hypot(x2, y2)
    psi1, psi2 = math.atan2(y1, x1), math.atan2(y2, x2)
    brk = {0.0, 1.0}
    for d, p in ((d1, r1), (d2, r2)):
        for v in (abs(d - p), d + p):
            if 0 < v < 1: brk.add(v)
    s = math.hypot(x2 - x1, y2 - y1)
    if abs(r1 - r2) < s < r1 + r2:      # corners of the lens
        al = (s * s + r1 * r1 - r2 * r2) / (2 * s); h = math.sqrt(max(0.0, r1 * r1 - al * al))
        ux, uy = (x2 - x1) / s, (y2 - y1) / s
        for sg in (1, -1):
            v = math.hypot(x1 + al * ux - sg * h * uy, y1 + al * uy + sg * h * ux)
            if 0 < v < 1: brk.add(v)
    brk = sorted(brk)
    def parts(d_1, p_1, d_2, p_2):
        tot = err = 0.0
        for lo, hi in zip(brk[:-1], brk[1:]):
            if hi - lo < 1e-15: continue
            v, e = quad(lambda r: intensity(r, a) * r * covered(r, d_1, psi1, p_1, d_2, psi2, p_2), lo, hi, epsabs=1e-15, epsrel=1e-13, limit=400)
            tot += v; err += e
        return tot / (2 * PI * F1(a)), err / (2 * PI * F1(a))
    u, eu = parts(d1, r1, d2, r2)
    f, _ = parts(d1, r1, d2, 0.0)
    g, _ = parts(d1, 0.0, d2, r2)
    return u, f, g, eu

def brute(x1, y1, r1, x2, y2, r2, a, n=3000):
    g = (np.arange(n) + 0.5) / n * 2 - 1
    X, Y = np.meshgrid(g, g); R2 = X * X + Y * Y
    mu = np.sqrt(np.clip(1 - R2, 0, None)); I = 1 - sum(a[k] * (1 - mu ** ((k + 1) / 2)) for k in range(4))
    star = R2 < 1; occ = star & (((X - x1) ** 2 + (Y - y1) ** 2 < r1 * r1) | ((X - x2) ** 2 + (Y - y2) ** 2 < r2 * r2))
    return float((I * occ).sum() / (I * star).sum())

LAWS = {
    'uniform': [0, 0, 0, 0],
    'linear': [0, 0.6, 0, 0],
    'quadratic': [0, 0.40 + 2 * 0.26, 0, -0.26],
    'nonlinear': [0.4939, -0.0729, 0.4578, -0.2158],
    'steep': [0.75, -0.35, 0.55, -0.15],
}

def geometries():
    rng = np.random.default_rng(20261115); out = []
    def add(kind, x1, y1, r1, x2, y2, r2): out.append(dict(kind=kind, x1=float(x1), y1=float(y1), r1=float(r1), x2=float(x2), y2=float(y2), r2=float(r2)))
    def pair(kind, cdist, r1, r2, sfrac):
        ang = rng.uniform(0, 2 * PI); x1, y1 = cdist * math.cos(ang), cdist * math.sin(ang)
        s = abs(r1 - r2) + sfrac * (r1 + r2 - abs(r1 - r2)); th = rng.uniform(0, 2 * PI)
        add(kind, x1, y1, r1, x1 + s * math.cos(th), y1 + s * math.sin(th), r2)
    for _ in range(8):   # lens well inside the star
        r1 = rng.uniform(0.05, 0.2); pair('lens on the disc', rng.uniform(0, 0.6), r1, r1 * rng.uniform(0.15, 1.2), rng.uniform(0.05, 0.95))
    for _ in range(10):  # lens across the stellar limb
        r1 = rng.uniform(0.05, 0.2); pair('lens across the limb', 1 + r1 * rng.uniform(-0.9, 0.9), r1, r1 * rng.uniform(0.2, 1.2), rng.uniform(0.05, 0.95))
    for _ in range(4):   # moon wholly inside the planet's disc
        r1 = rng.uniform(0.08, 0.2); r2 = r1 * rng.uniform(0.1, 0.6); ang = rng.uniform(0, 2 * PI); c = rng.uniform(0, 1.1); th = rng.uniform(0, 2 * PI); s = (r1 - r2) * rng.uniform(0, 0.99)
        add('moon inside the planet', c * math.cos(ang), c * math.sin(ang), r1, c * math.cos(ang) + s * math.cos(th), c * math.sin(ang) + s * math.sin(th), r2)
    for _ in range(5):   # separate discs
        r1 = rng.uniform(0.05, 0.2); r2 = r1 * rng.uniform(0.1, 1); a1, a2 = rng.uniform(0, 2 * PI, 2); c1, c2 = rng.uniform(0, 1.15, 2)
        x1, y1, x2, y2 = c1 * math.cos(a1), c1 * math.sin(a1), c2 * math.cos(a2), c2 * math.sin(a2)
        if math.hypot(x2 - x1, y2 - y1) > r1 + r2: add('separate', x1, y1, r1, x2, y2, r2)
    for _ in range(6):   # large bodies over the centre of the star
        r1 = rng.uniform(0.25, 0.6); pair('large, over the centre', rng.uniform(0, 0.3), r1, r1 * rng.uniform(0.4, 1.0), rng.uniform(0.1, 0.9))
    # chosen by hand: tangencies, a corner of the lens on the limb, concentric discs, a centre on the limb
    add('externally tangent', 0.2, 0.1, 0.1, 0.35, 0.1, 0.05)
    add('internally tangent', 0.2, 0.1, 0.1, 0.25, 0.1, 0.05)
    add('concentric', 0.3, -0.2, 0.12, 0.3, -0.2, 0.04)
    add('lens corner on the limb', 0.94, 0.0, 0.1, 0.94 + 0.12, 0.08, 0.1)
    add('moon centre on the limb', 0.93, 0.0, 0.12, 1.0, 0.0, 0.04)
    add('both graze the limb from inside', 0.88, 0.0, 0.12, 0.93, 0.05, 0.05)
    add('planet over the centre exactly', 0.0, 0.0, 0.15, 0.17, 0.0, 0.06)
    add('lens of two equal discs at the centre', -0.05, 0.0, 0.1, 0.05, 0.0, 0.1)
    return out

def make_union():
    cases = []; worst_est = 0.0
    for g in geometries():
        for law, a in LAWS.items():
            u, f, s, err = union_truth(g['x1'], g['y1'], g['r1'], g['x2'], g['y2'], g['r2'], a)
            worst_est = max(worst_est, err)
            cases.append(dict(g, law=law, a=a, union=u, first=f, second=s, overlap=f + s - u, quad_err=err))
    # the ring formula against pixels (3000 x 3000), three geometries
    chk = 0.0
    for c in (cases[1], cases[45], cases[62], cases[len(cases) - 12]):
        chk = max(chk, abs(brute(c['x1'], c['y1'], c['r1'], c['x2'], c['y2'], c['r2'], c['a']) - c['union']))
    print(f'union: {len(cases)} cases, largest quad error estimate {worst_est:.1e}, ring formula vs pixel sum {chk:.1e}')
    return dict(cases=cases, quad_err_max=worst_est, pixel_check=chk)

# ---------------------------------------------------------------- 2. the owner's exomoon2.py
RAW = 'https://raw.githubusercontent.com/pearsonkyle/Exoplanet-Light-Curve-Analysis/master/'
def fetch_elca():
    d = tempfile.mkdtemp(prefix='elca_'); os.makedirs(os.path.join(d, 'elca', 'C'))
    for src, dst in (('examples/exomoon2.py', 'exomoon2.py'), ('elca/tools.py', 'elca/tools.py'), ('elca/C/MandelTransit.c', 'elca/C/MandelTransit.c')):
        urllib.request.urlretrieve(RAW + src, os.path.join(d, dst))
    for f in ('elca/__init__.py', 'elca/C/__init__.py'): open(os.path.join(d, f), 'w').close()
    return d

def make_exomoon2(elca):
    cdir = os.path.join(elca, 'elca', 'C')
    if not any(f.endswith('.so') for f in os.listdir(cdir)):
        subprocess.check_call(['cc', '-O3', '-shared', '-fPIC', '-o', 'lib_transit.so', 'MandelTransit.c'], cwd=cdir)
    import matplotlib; matplotlib.use('Agg')
    sys.path.insert(0, elca)
    import exomoon2 as ex                      # the __main__ block (the fit and the plots) does not run on import
    from elca.tools import transit
    from astropy import units as u, constants as const
    # ---- the configuration of its __main__ block, copied
    prior = {'rprs': 0.05, 'ars': 14.25, 'per': 3.333, 'inc': 86.5, 'u1': 0.3, 'u2': 0.1, 'ecc': 0, 'omega': 0, 'tmid': 0.5}
    moon_prior = copy.deepcopy(prior)
    moon_prior['rprs'] = 0.0075; moon_prior['radius_star'] = 0.75; moon_prior['mass_star'] = 1; moon_prior['mass_planet'] = 0.5
    moon_prior['moon_per'] = 7; moon_prior['moon_tmid'] = 1.5; moon_prior['planet_rprs'] = prior['rprs']
    time = np.linspace(0, 100, 100000)
    phase = (time - prior['tmid'] - 0.5 * prior['per']) / prior['per'] % 1 - 0.5
    time = time[(phase > -0.15) & (phase < 0.15)]
    planetdata = transit(time, prior)
    moondata, toffset, occulted = ex.moon_transit(time, moon_prior)
    alldata = planetdata - np.abs(1 - moondata)
    # ---- the lengths its formulas use (same expressions as moon_transit), for the write-up
    a_planet = (((prior['per'] * u.day) ** 2 * const.G * (moon_prior['mass_star'] * u.M_sun) / (4 * np.pi)) ** (1. / 3)).to(u.AU).value
    a_moon = (((moon_prior['moon_per'] * u.day) ** 2 * const.G * (moon_prior['mass_planet'] * u.M_jup) / (4 * np.pi)) ** (1. / 3)).to(u.AU).value
    r_planet = (moon_prior['planet_rprs'] * moon_prior['radius_star'] * u.R_sun).to(u.AU).value
    kepler = lambda P, M: ((((P * u.day) ** 2 * const.G * M / (4 * np.pi ** 2)) ** (1. / 3)).to(u.AU)).value
    # to keep the file small: every second point where anything happens, every 25th elsewhere
    busy = (moondata < 1) | (planetdata < 1) | occulted
    keep = np.sort(np.concatenate([np.where(busy)[0][::2], np.where(~busy)[0][::25]]))
    print(f'exomoon2: {len(time)} points, {len(keep)} kept; moon depth {1 - moondata.min():.3e}, toffset amplitude {np.abs(toffset.value).max():.6f} d, occulted {occulted.sum()} points')
    return dict(prior=prior, moon_prior=moon_prior, n_total=int(len(time)),
                time=time[keep].tolist(), planet=planetdata[keep].tolist(), moon=moondata[keep].tolist(), all=alldata[keep].tolist(),
                toffset=toffset.value[keep].tolist(), occulted=[int(x) for x in occulted[keep]],
                a_planet_au=float(a_planet), a_moon_au=float(a_moon), r_planet_au=float(r_planet),
                a_planet_kepler_au=float(kepler(prior['per'], moon_prior['mass_star'] * u.M_sun)),
                a_moon_kepler_au=float(kepler(moon_prior['moon_per'], moon_prior['mass_planet'] * u.M_jup)),
                a_planet_from_ars_au=float((prior['ars'] * moon_prior['radius_star'] * u.R_sun).to(u.AU).value))

# ---------------------------------------------------------------- 3. Pandora
def make_pandora():
    import pandoramoon as pandora
    from pandoramoon.version import PANDORA_VERSIONING
    from pandoramoon.kernel import _moon_setup
    MJUP, RSUN = 1.898130e27, 6.957e8
    out = []
    for name, kw in (
        ('coplanar edge-on moon', dict(i_moon=90.0, b_bary=0.3, tau_moon=0.07)),
        ('inclined moon', dict(i_moon=78.0, b_bary=0.3, tau_moon=0.31)),
        ('grazing planet', dict(i_moon=84.0, b_bary=0.95, tau_moon=0.52)),
    ):
        p = pandora.model_params()
        p.R_star = 1.0 * RSUN; p.u1 = 0.40; p.u2 = 0.26
        p.per_bary = 45.0; p.a_bary = 53.4; p.r_planet = 0.1; p.b_bary = kw['b_bary']; p.t0_bary = 100.0; p.t0_bary_offset = 0.0
        p.M_planet = 1.0 * MJUP; p.w_bary = 0.0; p.ecc_bary = 0.0
        p.r_moon = 0.03; p.per_moon = 3.7; p.tau_moon = kw['tau_moon']; p.Omega_moon = 0.0; p.i_moon = kw['i_moon']
        p.ecc_moon = 0.0; p.w_moon = 0.0; p.M_moon = 0.02 * MJUP
        p.epochs = 12; p.epoch_duration = 1.2; p.cadences_per_day = 240; p.epoch_distance = 45.0; p.supersampling_factor = 1
        p.occult_small_threshold = 0.0
        t = pandora.time(p).grid(); m = pandora.moon_model(p)
        total, planet, moon = m.light_curve(t); px, py, mx, my = m.coordinates(t)
        a_moon, unphys = _moon_setup(p.R_star, p.per_bary, p.a_bary, p.M_planet, p.M_moon, p.per_moon, p.ecc_moon, p.r_planet, p.r_moon, p.hill_sphere_threshold)
        sep = np.hypot(mx - px, my - py); mutual = ((sep < p.r_planet + p.r_moon) & (np.hypot(px, py) < 1 + p.r_planet) & (np.hypot(mx, my) < 1 + p.r_moon)).sum()
        print(f'pandora {PANDORA_VERSIONING}, {name}: {len(t)} points, a_moon {a_moon:.5f} R*, unphysical {unphys}, depth {1 - total.min():.5f}, points in a mutual event {mutual}')
        # the same quadrature as in part 1 at some of Pandora's own mutual-event positions, to say which code is right there
        mi = np.where((sep < p.r_planet + p.r_moon) & (sep > p.r_planet - p.r_moon) & (np.hypot(px, py) < 1 + p.r_planet) & (np.hypot(mx, my) < 1 + p.r_moon))[0]
        a_cl = [0, p.u1 + 2 * p.u2, 0, -p.u2]
        truth = [dict(i=int(i), px=float(px[i]), py=float(py[i]), mx=float(mx[i]), my=float(my[i]), pandora=float(total[i]),
                      truth=1 - union_truth(px[i], py[i], p.r_planet, mx[i], my[i], p.r_moon, a_cl)[0]) for i in mi]
        k = np.abs(px) < 2.4                    # the transit window: outside it both codes return exactly 1
        t, total, planet, moon, px, py, mx, my = (np.asarray(v)[k] for v in (t, total, planet, moon, px, py, mx, my))
        out.append(dict(name=name, version=PANDORA_VERSIONING, u1=p.u1, u2=p.u2, per_bary=p.per_bary, a_bary=p.a_bary, r_planet=p.r_planet, b_bary=p.b_bary,
                        t0_bary=p.t0_bary, r_moon=p.r_moon, per_moon=p.per_moon, tau_moon=p.tau_moon, Omega_moon=p.Omega_moon, i_moon=p.i_moon,
                        mass_ratio=p.M_moon / p.M_planet, a_moon=float(a_moon), mutual_truth=truth,
                        time=t.tolist(), total=np.asarray(total).tolist(), planet=np.asarray(planet).tolist(), moon=np.asarray(moon).tolist(),
                        px=np.asarray(px).tolist(), py=np.asarray(py).tolist(), mx=np.asarray(mx).tolist(), my=np.asarray(my).tolist()))
    return out

if __name__ == '__main__':
    elca = sys.argv[sys.argv.index('--elca') + 1] if '--elca' in sys.argv else None
    ref = dict(union=make_union())
    try:
        ref['exomoon2'] = make_exomoon2(elca or fetch_elca())
    except Exception as ex:                      # keep the other references if the owner's code cannot be built here
        print('exomoon2.py could not be run:', repr(ex)); ref['exomoon2'] = None
    try:
        ref['pandora'] = make_pandora()
    except Exception as ex:
        print('pandoramoon could not be run:', repr(ex)); ref['pandora'] = None
    with open(os.path.join(HERE, 'exomoon_reference.json'), 'w') as fh: json.dump(ref, fh, separators=(',', ':'))
    print('wrote test/exomoon_reference.json', os.path.getsize(os.path.join(HERE, 'exomoon_reference.json')) // 1024, 'kB')
