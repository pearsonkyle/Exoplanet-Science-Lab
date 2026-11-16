# References for test/phasecurve.test.mjs, written to test/phasecurve_reference.json.
#
# Each part needs its own interpreter (the packages do not share an environment); a part replaces its own
# section of the JSON and leaves the others alone. From the repository root:
#
#   /Users/kpearson/miniconda3/bin/python -m venv .venv-phase                       # Python 3.11
#   .venv-phase/bin/pip install numpy scipy mpmath batman-package
#   .venv-phase/bin/python test/make_phasecurve_reference.py truth batman planck
#
#   # starry 1.2.0 (what Exoplanet-Mapping uses). It needs Theano, which needs old everything:
#   python -m venv .venv-phase/starry-env
#   .venv-phase/starry-env/bin/pip install "numpy<1.24" "scipy<1.11" "setuptools==59.8.0" "theano-pymc==1.1.2" tqdm astropy ipython \
#       "arviz==0.15.1" "xarray<2023.7" "pandas<2" cachetools dill fastprogress patsy semver deprecat filelock
#   .venv-phase/starry-env/bin/pip install --no-deps "pymc3==3.11.5" "exoplanet==0.5.1" "exoplanet-core==0.2.0" "starry==1.2.0"
#   ln -s pymc3 .venv-phase/starry-env/lib/python3.11/site-packages/exoplanet_core/pymc    # exoplanet 0.5 imports the newer name
#   sed -i '' 's/, "-mmacosx-version-min=10.7"//' $(grep -rl 'mmacosx-version-min=10.7' .venv-phase/starry-env/lib/python3.11/site-packages/starry)
#   printf '#!/bin/sh\nexec /usr/bin/clang++ "$@" -fexceptions -fcxx-exceptions -Wno-everything\n' > .venv-phase/starry-env/bin/clangxx
#   chmod +x .venv-phase/starry-env/bin/clangxx       # Theano compiles with -fno-exceptions, which Apple clang 17 refuses for starry's throws
#   SDKROOT=$(xcrun --show-sdk-path) THEANO_FLAGS="blas__ldflags=,cxx=$PWD/.venv-phase/starry-env/bin/clangxx" \
#       .venv-phase/starry-env/bin/python test/make_phasecurve_reference.py starry
#
#   python -m venv .venv-phase/jax-env && .venv-phase/jax-env/bin/pip install jaxoplanet            # jaxoplanet 0.2.0, jax 0.10.2
#   .venv-phase/jax-env/bin/python test/make_phasecurve_reference.py jaxoplanet
#
#   /Users/kpearson/miniconda3/envs/exotic/bin/python test/make_phasecurve_reference.py exotic     # EXOTIC + pylightcurve (read only)
#
# truth: the visible, unocculted part of the planet's disc integrated directly, for every basis function up to degree 3.
#        Polar coordinates about the planet's centre, exact angular limits from the star's limb, Gauss-Legendre after
#        substitutions that remove the square-root end points; checked here against scipy's adaptive nested quadrature
#        and by doubling the nodes. The harmonics come from scipy.special, the planet's frame from cross products of the
#        orbit's position and velocity: nothing is shared with src/core/phasecurve.js except the orbit convention.
import sys, json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'phasecurve_reference.json')

SYSTEMS = {
    'wasp43':  dict(rprs=0.1594, per=0.813475, tmid=0.0, ars=4.872, inc=82.6, ecc=0.0, omega=0.0, ldLaw='quadratic', ld=[0.05, 0.10]),
    'edgeon':  dict(rprs=0.03, per=1.5, tmid=0.0, ars=6.0, inc=90.0, ecc=0.0, omega=0.0, ldLaw='quadratic', ld=[0.3, 0.2]),
    'grazing': dict(rprs=0.12, per=2.2, tmid=0.0, ars=7.0, inc=81.6, ecc=0.0, omega=0.0, ldLaw='quadratic', ld=[0.3, 0.2]),
    'ecc':     dict(rprs=0.1, per=3.5, tmid=0.0, ars=9.0, inc=87.5, ecc=0.3, omega=70.0, ldLaw='quadratic', ld=[0.3, 0.2]),
    'hd80606': dict(rprs=0.1, per=111.4367, tmid=0.0, ars=94.45, inc=89.269, ecc=0.93132, omega=-58.699, ldLaw='quadratic', ld=[0.3, 0.2]),
}
LM = [(l, m) for l in range(0, 4) for m in range(-l, l + 1)]
KEY = lambda l, m: 'y%d%s%d' % (l, 'm' if m < 0 else '', abs(m))


# ---------------------------------------------------------------- orbit (own Kepler solve, ESL's sky convention)
def kepler(M, e):
    M = np.atleast_1d(np.asarray(M, float)); E = M + e * np.sin(M)
    for _ in range(200):
        dE = (E - e * np.sin(E) - M) / (1 - e * np.cos(E)); E = E - dE
        if np.max(np.abs(dE)) < 1e-15: break
    return E

def orbit(s, t):
    """position [X, Y, Z] (stellar radii), unit vectors east/north/substellar of the planet's frame, on the sky"""
    e, w, inc = s['ecc'], np.radians(s['omega']), np.radians(s['inc'])
    nu0 = np.pi / 2 - w
    E0 = 2 * np.arctan2(np.sqrt(1 - e) * np.sin(nu0 / 2), np.sqrt(1 + e) * np.cos(nu0 / 2)); M0 = E0 - e * np.sin(E0)
    E = kepler(M0 + 2 * np.pi * (np.atleast_1d(t) - s['tmid']) / s['per'], e)
    nu = 2 * np.arctan2(np.sqrt(1 + e) * np.sin(E / 2), np.sqrt(1 - e) * np.cos(E / 2)); r = s['ars'] * (1 - e * np.cos(E)); u = w + nu
    pos = np.array([-r * np.cos(u), -r * np.sin(u) * np.cos(inc), r * np.sin(u) * np.sin(inc)]).T
    # direction of motion: d(pos)/du at fixed r is enough to define the orbital plane
    tang = np.array([np.sin(u), -np.cos(u) * np.cos(inc), np.cos(u) * np.sin(inc)]).T
    rhat = pos / np.linalg.norm(pos, axis=1)[:, None]
    north = np.cross(rhat, tang); north /= np.linalg.norm(north, axis=1)[:, None]
    sub = -rhat
    east = np.cross(north, sub)                 # right-handed (east, north, substellar): longitude grows in the direction of rotation
    return pos, east, north, sub

def eclipse_time(s):
    e, w = s['ecc'], np.radians(s['omega'])
    f = lambda nu: (lambda E: E - e * np.sin(E))(2 * np.arctan2(np.sqrt(1 - e) * np.sin(nu / 2), np.sqrt(1 + e) * np.cos(nu / 2)))
    dM = f(-np.pi / 2 - w) - f(np.pi / 2 - w)
    t = s['tmid'] + dM / (2 * np.pi) * s['per']
    return t - s['per'] * np.round((t - s['tmid']) / s['per'])

def case_times(s, n_in=9, n_out=10):
    """times through ingress and egress of the eclipse (found by scanning) plus phases around the orbit"""
    te = eclipse_time(s); p = s['rprs']
    tt = te + np.linspace(-0.5, 0.5, 400001) * min(s['per'] * 0.2, 2.0)
    pos = orbit(s, tt)[0]; z = np.hypot(pos[:, 0], pos[:, 1]); part = (z > 1 - p) & (z < 1 + p) & (pos[:, 2] < 0)
    idx = np.where(part)[0]
    if len(idx) == 0: ing = np.array([])
    else:
        brk = np.where(np.diff(idx) > 1)[0]
        segs = [idx] if len(brk) == 0 else [idx[:brk[0] + 1], idx[brk[0] + 1:]]
        ing = np.concatenate([tt[sg[np.round(np.linspace(0.02, 0.98, n_in) * (len(sg) - 1)).astype(int)]] for sg in segs])
    out = s['tmid'] + s['per'] * (np.arange(n_out) + 0.37) / n_out
    return np.concatenate([ing, out, [te, s['tmid']]])


# ---------------------------------------------------------------- harmonics from scipy (starry normalisation: Y / Y00)
def ylm_real(l, m, bx, by, bz):
    from scipy.special import sph_harm_y
    pol = np.arccos(np.clip(bz, -1, 1)); az = np.arctan2(by, bx)
    Y = sph_harm_y(l, abs(m), pol, az)          # scipy >= 1.15: sph_harm_y(n, m, polar, azimuth), with the Condon-Shortley phase
    if m == 0: v = Y.real
    elif m > 0: v = np.sqrt(2) * (-1) ** m * Y.real
    else: v = np.sqrt(2) * (-1) ** m * Y.imag
    return v * 2 * np.sqrt(np.pi)

def gl(n, a, b):
    x, w = np.polynomial.legendre.leggauss(n); return 0.5 * (b - a) * x + 0.5 * (b + a), 0.5 * (b - a) * w

def visible_flux(pos, east, north, sub, p, n=160):
    """(1/pi) int Y_lm over the planet's disc outside the star, for every (l, m): dict key -> value. Planet behind the star or clear of it."""
    X, Y, Z = pos; d = np.hypot(X, Y) / p; R = 1 / p
    a_s = np.arctan2(-Y, -X)                    # direction of the star's centre from the planet's
    hidden = Z < 0 and d < R + 1
    out = {KEY(l, m): 0.0 for l, m in LM}
    if hidden and d <= R - 1: return out
    def ring(rho, wr):                          # integrate over the visible arc at each radius
        zeta = np.sqrt(np.clip(1 - rho ** 2, 0, None))
        if hidden:
            c = (rho ** 2 + d ** 2 - R ** 2) / (2 * rho * d); half = np.arccos(np.clip(c, -1, 1))   # covered half-width about a_s
        else: half = np.zeros_like(rho)
        xa, wa = gl(n, 0.0, 1.0)
        alpha = a_s + half[:, None] + (2 * np.pi - 2 * half[:, None]) * xa[None, :]
        wgt = wr[:, None] * rho[:, None] * (2 * np.pi - 2 * half[:, None]) * wa[None, :]
        nx = rho[:, None] * np.cos(alpha); ny = rho[:, None] * np.sin(alpha); nz = zeta[:, None] * np.ones_like(alpha)
        bx = nx * east[0] + ny * east[1] + nz * east[2]; by = nx * north[0] + ny * north[1] + nz * north[2]; bz = nx * sub[0] + ny * sub[1] + nz * sub[2]
        for l, m in LM: out[KEY(l, m)] += float(np.sum(wgt * ylm_real(l, m, bx, by, bz))) / np.pi
    rho0 = abs(R - d) if hidden else 0.0
    if rho0 > 0:                                # inner disc: fully visible (d > R) or fully covered (d < R)
        if d > R:
            psi, w = gl(n, 0, np.pi / 2); rho = rho0 * np.sin(psi)
            save = hidden; hidden = False; ring(rho, w * rho0 * np.cos(psi)); hidden = save
    psi, w = gl(n, 0, np.pi / 2)               # rho = rho0 + (1 - rho0) sin^2 psi: smooth at both ends
    rho = rho0 + (1 - rho0) * np.sin(psi) ** 2
    ring(rho, w * (1 - rho0) * 2 * np.sin(psi) * np.cos(psi))
    return out

def visible_flux_adaptive(pos, east, north, sub, p, l, m):
    """the same integral by scipy's adaptive nested quadrature (slow; used to check visible_flux)"""
    from scipy.integrate import quad
    X, Y, Z = pos; d = np.hypot(X, Y) / p; R = 1 / p; a_s = np.arctan2(-Y, -X); hidden = Z < 0 and d < R + 1
    def inner(rho):
        half = 0.0
        if hidden:
            c = (rho ** 2 + d ** 2 - R ** 2) / (2 * rho * d) if rho > 0 else (1.0 if d > R else -1.0)
            half = np.arccos(np.clip(c, -1, 1))
        if half >= np.pi: return 0.0
        zeta = np.sqrt(max(0.0, 1 - rho ** 2))
        def f(al):
            nx, ny, nz = rho * np.cos(al), rho * np.sin(al), zeta
            return float(ylm_real(l, m, np.array(nx * east[0] + ny * east[1] + nz * east[2]), np.array(nx * north[0] + ny * north[1] + nz * north[2]), np.array(nx * sub[0] + ny * sub[1] + nz * sub[2])))
        return quad(f, a_s + half, a_s + 2 * np.pi - half, epsabs=1e-13, epsrel=1e-13, limit=200)[0] * rho
    pts = [abs(R - d)] if hidden and 0 < abs(R - d) < 1 else None
    return quad(inner, 0, 1, points=pts, epsabs=1e-12, epsrel=1e-12, limit=400)[0] / np.pi


def part_truth():
    cases = []; worst_adapt = 0.0; worst_conv = 0.0
    for name, s in SYSTEMS.items():
        t = case_times(s); pos, east, north, sub = orbit(s, t)
        vals = {KEY(l, m): [] for l, m in LM}; kind = []
        for i in range(len(t)):
            v = visible_flux(pos[i], east[i], north[i], sub[i], s['rprs'])
            v2 = visible_flux(pos[i], east[i], north[i], sub[i], s['rprs'], n=80)
            worst_conv = max(worst_conv, max(abs(v[k] - v2[k]) for k in v))
            for k in v: vals[k].append(v[k])
            z = np.hypot(pos[i, 0], pos[i, 1]); kind.append('partial' if (pos[i, 2] < 0 and 1 - s['rprs'] < z < 1 + s['rprs']) else 'total' if (pos[i, 2] < 0 and z <= 1 - s['rprs']) else 'out')
        # adaptive cross-check on three partial phases and one out of eclipse, four harmonics
        part = [i for i, k in enumerate(kind) if k == 'partial']
        for i in (part[1:len(part):max(1, len(part) // 3)][:3] + [len(t) - 3]) if part else [len(t) - 3]:
            for l, m in [(0, 0), (1, -1), (2, 1), (3, 2)]:
                a = visible_flux_adaptive(pos[i], east[i], north[i], sub[i], s['rprs'], l, m)
                worst_adapt = max(worst_adapt, abs(a - vals[KEY(l, m)][i]))
        cases.append(dict(system=name, params=s, t=t.tolist(), kind=kind, basis=vals, tecl=float(eclipse_time(s))))
        print('truth', name, len(t), 'times,', kind.count('partial'), 'partial; node doubling', worst_conv, 'adaptive', worst_adapt)
    return dict(cases=cases, check=dict(node_doubling=worst_conv, adaptive_quadrature=worst_adapt),
                note='visible flux of each real spherical harmonic (starry normalisation) over the unocculted disc, divided by pi')


def part_batman():
    import batman
    out = []
    for name, s in SYSTEMS.items():
        pm = batman.TransitParams(); pm.t0 = s['tmid']; pm.per = s['per']; pm.rp = s['rprs']; pm.a = s['ars']; pm.inc = s['inc']; pm.ecc = s['ecc']; pm.w = s['omega']
        pm.u = s['ld']; pm.limb_dark = 'quadratic'; pm.fp = 0.0025;
        m0 = batman.TransitModel(pm, np.array([0.0])); pm.t_secondary = m0.get_t_secondary(pm)
        te = pm.t_secondary - s['per'] * np.round((pm.t_secondary - s['tmid']) / s['per'])
        t = te + np.linspace(-1, 1, 241) * 0.12 * min(s['per'], 3.0)
        m = batman.TransitModel(pm, t, transittype='secondary')
        out.append(dict(system=name, params=s, depth=pm.fp, t=t.tolist(), flux=m.light_curve(pm).tolist(), t_secondary=float(te)))
        print('batman', name, 't_sec', te, 'min', m.light_curve(pm).min())
    return dict(version=batman.__version__, cases=out, note='batman secondary eclipse, uniform planet disc: 1 + fp outside, 1 in totality')


def part_planck():
    """band-integrated blackbody ratios and brightness temperatures by scipy quadrature and root finding; energy integrals of the no-redistribution map"""
    from scipy.integrate import quad, dblquad
    from scipy.optimize import brentq
    c2 = 14387.768775
    B = lambda lam, T: 1.0 / (lam ** 5 * np.expm1(c2 / (lam * T)))
    band = lambda T, lo, hi: quad(B, lo, hi, args=(T,), epsabs=0, epsrel=1e-13)[0]
    rows = []
    for (lo, hi) in [(3.15, 3.95), (4.0, 5.0), (6.5, 9.1), (0.6, 1.0)]:
        for ts in (4400.0, 5800.0, 7400.0):
            for ratio in (0.002, 0.03, 0.15, 0.5):
                tb = brentq(lambda T: band(T, lo, hi) / band(ts, lo, hi) - ratio, 20, 50000, xtol=1e-10)
                rows.append(dict(band=[lo, hi], tstar=ts, ratio=ratio, tb=tb))
    mono = [dict(lam=4.5, tstar=4400.0, ratio=0.146, tb=c2 / (4.5 * np.log1p(np.expm1(c2 / (4.5 * 4400.0)) / 0.146)))]
    # no redistribution, zero albedo: T^4 = T0^4 cos(angle from the substellar point) on the dayside.
    # apparent dayside flux at full phase / (pi) and the power radiated by the sphere / (pi R^2 sigma T0^4)
    day = dblquad(lambda th, ph: np.cos(th) * np.cos(th) * np.sin(th), 0, 2 * np.pi, 0, np.pi / 2)[0] / np.pi
    power = dblquad(lambda th, ph: np.cos(th) * np.sin(th), 0, 2 * np.pi, 0, np.pi / 2)[0] / np.pi
    return dict(rows=rows, mono=mono, no_redistribution=dict(dayside_T4_over_T04=day, power_over_absorbed=power))


def part_starry():
    import starry
    starry.config.lazy = False; starry.config.quiet = True
    G = 6.6743e-11; Msun = 1.98841e30; Rsun = 6.957e8; day = 86400.0
    out = []
    for name in ('wasp43', 'edgeon', 'grazing'):
        s = SYSTEMS[name]
        M = 4 * np.pi ** 2 * (s['ars'] * Rsun) ** 3 / (G * (s['per'] * day) ** 2) / Msun      # stellar mass giving this a/R* for R* = 1 R_sun
        star = starry.Primary(starry.Map(ydeg=0, udeg=2, amp=1.0), m=M, r=1.0, prot=1.0)
        star.map[1] = s['ld'][0]; star.map[2] = s['ld'][1]
        def planet(lm=None, mapinc=None):
            pm = starry.Map(ydeg=3, amp=1.0, inc=s['inc'] if mapinc is None else mapinc)
            if lm: pm[lm[0], lm[1]] = 1.0
            # Exoplanet-Mapping's construction: synchronous, theta0 = 180 so the map's z axis faces the star
            return starry.kepler.Secondary(pm, m=0, r=s['rprs'], inc=s['inc'], porb=s['per'], prot=s['per'], ecc=0, w=s['omega'], t0=s['tmid'], theta0=180)
        te = s['tmid'] + s['per'] / 2
        t = np.concatenate([s['tmid'] + s['per'] * np.linspace(-0.25, 0.75, 61), te + np.linspace(-1, 1, 161) * 0.08 * s['per']])
        tran = starry.System(star, planet()).flux(t)
        pm0 = starry.Map(ydeg=3, amp=0.0, inc=s['inc'])
        f_star = starry.System(star, starry.kepler.Secondary(pm0, m=0, r=s['rprs'], inc=s['inc'], porb=s['per'], prot=s['per'], ecc=0, w=s['omega'], t0=s['tmid'], theta0=180)).flux(t)
        curves = {'y00': (tran - f_star).tolist()}; em = {}
        for l, m in LM[1:]:
            curves[KEY(l, m)] = (starry.System(star, planet((l, m))).flux(t) - tran).tolist()
        for l, m in LM[1:4]:                    # as fit_map.py leaves it: the map's axis in the plane of the sky (map.inc = 90)
            em[KEY(l, m)] = (starry.System(star, planet((l, m), 90.0)).flux(t) - starry.System(star, planet(None, 90.0)).flux(t)).tolist()
        out.append(dict(system=name, params=s, t=t.tolist(), star=f_star.tolist(), curves=curves, exoplanet_mapping=em))
        print('starry', name, 'done')
    # light-travel delay: mid-eclipse shift of a uniform planet
    s = SYSTEMS['wasp43']; rstar = 0.6
    M = 4 * np.pi ** 2 * (s['ars'] * rstar * Rsun) ** 3 / (G * (s['per'] * day) ** 2) / Msun
    te = s['per'] / 2; t = te + np.linspace(-1, 1, 601) * 0.05 * s['per']; fl = {}
    for delay in (False, True):
        star = starry.Primary(starry.Map(ydeg=0, udeg=2, amp=1.0), m=M, r=rstar, prot=1.0)
        pl = starry.kepler.Secondary(starry.Map(ydeg=1, amp=0.003), m=0, r=s['rprs'] * rstar, inc=s['inc'], porb=s['per'], prot=s['per'], t0=0.0, theta0=180)
        fl[delay] = starry.System(star, pl, light_delay=delay).flux(t)
    ltt = dict(params=s, rstar=rstar, t=t.tolist(), flux=fl[True].tolist(), flux_nodelay=fl[False].tolist())
    return dict(version=starry.__version__, cases=out, ltt=ltt, note='starry.System flux: star + planet with a single unit Ylm (minus the uniform planet), map.inc = orbital inclination')


def part_jaxoplanet():
    import jax; jax.config.update('jax_enable_x64', True)
    import jaxoplanet
    from jaxoplanet.orbits.keplerian import Central, Body
    from jaxoplanet.starry.surface import Surface
    from jaxoplanet.starry.ylm import Ylm
    from jaxoplanet.starry.orbit import SurfaceSystem
    from jaxoplanet.starry.light_curves import light_curve
    out = []
    for name in ('wasp43', 'edgeon'):
        s = SYSTEMS[name]
        G = 6.6743e-11; Msun = 1.98841e30; Rsun = 6.957e8; day = 86400.0
        M = 4 * np.pi ** 2 * (s['ars'] * Rsun) ** 3 / (G * (s['per'] * day) ** 2) / Msun
        central = Central(radius=1.0, mass=M)
        te = s['tmid'] + s['per'] / 2
        t = np.concatenate([s['tmid'] + s['per'] * np.linspace(-0.25, 0.75, 41), te + np.linspace(-1, 1, 101) * 0.08 * s['per']])
        def run(coeffs):
            d = {(0, 0): 1.0}; d.update(coeffs); y = Ylm(d)
            # phase = pi at t0: the map's z axis faces the star, as theta0 = 180 in starry
            psurf = Surface(y=y, inc=np.radians(s['inc']), obl=0.0, period=s['per'], amplitude=1.0, phase=np.pi, normalize=False)
            system = SurfaceSystem(central, Surface(u=tuple(s['ld']))).add_body(surface=psurf, mass=0.0, radius=s['rprs'], period=s['per'], time_transit=s['tmid'], inclination=np.radians(s['inc']))
            f = light_curve(system)(t)
            return np.asarray(f)
        base = run({})
        curves = {'y00': base[:, 1].tolist(), 'star': base[:, 0].tolist()}
        for l, m in LM[1:9]:
            curves[KEY(l, m)] = (run({(l, m): 1.0})[:, 1] - base[:, 1]).tolist()
        out.append(dict(system=name, params=s, t=t.tolist(), curves=curves))
        print('jaxoplanet', name, 'done')
    return dict(version=jaxoplanet.__version__, jax=jax.__version__, cases=out)


def part_exotic():
    from exotic.api import multi_fitter as mf
    import exotic
    s = SYSTEMS['wasp43']; fpfs = 0.146; D = fpfs * s['rprs'] ** 2
    v = dict(rprs=s['rprs'], per=s['per'], ars=s['ars'], ecc=0.0, inc=s['inc'], omega=0.0, tmid=s['tmid'], fpfs=fpfs,
             u0=0.2, u1=0.1, u2=0.05, u3=0.02, u4=0.0, c1=0.3 * D, c2=-0.08 * D, c3=0.04 * D, c4=-0.03 * D)
    t = s['tmid'] + s['per'] * np.linspace(-0.25, 0.75, 501)
    te = s['per'] / 2; t2 = te + np.linspace(-1, 1, 401) * 0.08 * s['per']
    return dict(version=getattr(exotic, '__version__', '?'), values=v, t=t.tolist(), phasecurve=np.asarray(mf.phasecurve(t, v)).tolist(),
                t_eclipse=t2.tolist(), eclipse=np.asarray(mf.eclipse(t2, v)).tolist(), phasecurve_eclipse=np.asarray(mf.phasecurve(t2, v)).tolist(),
                note='exotic.api.multi_fitter.phasecurve and .eclipse, called as shipped')


if __name__ == '__main__':
    ref = json.load(open(OUT)) if os.path.exists(OUT) else {}
    for part in sys.argv[1:]:
        ref[part] = globals()['part_' + part]()
    def trim(o):                                # 13 significant digits keep the file small and lose nothing the tests use
        if isinstance(o, float): return float('%.13g' % o)
        if isinstance(o, dict): return {k: (v if k in ('t', 't_eclipse') else trim(v)) for k, v in o.items()}   # times stay exact
        if isinstance(o, (list, tuple)): return [trim(v) for v in o]
        return o
    json.dump(trim(ref), open(OUT, 'w'), separators=(',', ':'))
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'kB; parts:', sorted(ref.keys()))
