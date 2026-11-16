# One adapter per external code: the same inputs (see common.py) converted to each code's own parameters.
# Every adapter computes its own orbit unless it says otherwise. Returns None where a code has no such model.
import math, warnings, importlib.metadata as md
import numpy as np
warnings.filterwarnings('ignore')
DEG = math.pi / 180

def _v(pkg):
    try: return md.version(pkg)
    except Exception: return '?'

# ---- batman (Kreidberg 2015): C; analytic for uniform/linear/quadratic, numerical for the four-coefficient law
def _batman_params(c):
    import batman
    p = batman.TransitParams()
    p.t0 = c['tmid']; p.per = c['per']; p.rp = c['rprs']; p.a = c['ars']; p.inc = c['inc']; p.ecc = c.get('ecc', 0); p.w = c.get('omega', 0)
    p.limb_dark = c['law']; p.u = list(c['ld'])
    return p
def lc_batman(c, t, **kw):
    import batman
    return batman.TransitModel(_batman_params(c), np.asarray(t, float), **kw).light_curve(_batman_params(c))
def lc_batman_tight(c, t):
    """The four-coefficient law with batman's error target lowered from its default 1 ppm to 0.001 ppm."""
    if c['law'] != 'nonlinear': return None
    return lc_batman(c, t, max_err=1e-3)

# ---- PyTransit (Parviainen 2015): numba
_pt = {}
def lc_pytransit(c, t):
    from pytransit import QuadraticModel, UniformModel, RoadRunnerModel
    k, law = c['rprs'], c['law']
    args = (c['tmid'], c['per'], c['ars'], c['inc'] * DEG, c.get('ecc', 0), c.get('omega', 0) * DEG)
    if law == 'uniform':
        m = _pt.setdefault('u', UniformModel()); m.set_data(np.asarray(t, float)); return m.evaluate(k, *args)
    if law in ('linear', 'quadratic'):
        m = _pt.setdefault('q', QuadraticModel()); m.set_data(np.asarray(t, float))
        return m.evaluate(k, [c['ld'][0], c['ld'][1] if law == 'quadratic' else 0.0], *args)
    m = _pt.setdefault('nl', RoadRunnerModel('nonlinear')); m.set_data(np.asarray(t, float))
    return m.evaluate(k, list(c['ld']), *args)

# ---- PyAstronomy (Czesla et al. 2019): Mandel & Agol's Fortran occultquad / occultnl
def _pya_tau(c):
    # PyAstronomy takes the time of periastron; converted with the 30-digit orbit so its own model is what is tested
    import mpmath as mp
    from common import m0_transit_mp
    e, w = mp.mpf(c.get('ecc', 0)), mp.radians(mp.mpf(c.get('omega', 0)))
    return float(mp.mpf(c['tmid']) - m0_transit_mp(e, w) / (2 * mp.pi) * mp.mpf(c['per']))
def lc_pyastronomy(c, t):
    from PyAstronomy.modelSuite import forTrans as ft
    law = c['law']
    m = ft.MandelAgolLC(orbit='keplerian', ld='nl' if law == 'nonlinear' else 'quad')
    m['p'] = c['rprs']; m['a'] = c['ars']; m['i'] = c['inc']; m['per'] = c['per']; m['e'] = c.get('ecc', 0); m['tau'] = _pya_tau(c)
    m['Omega'] = 0.0; m['w'] = c.get('omega', 0) + 180.0   # its w is measured to the opposite node (see rv notes): default -90 means transit at periapsis
    if law == 'nonlinear':
        for i in range(4): m['a%d' % (i + 1)] = c['ld'][i]
    else:
        m['linLimb'] = c['ld'][0] if law != 'uniform' else 0.0; m['quadLimb'] = c['ld'][1] if law == 'quadratic' else 0.0
    return m.evaluate(np.asarray(t, float))

# ---- ellc (Maxted 2016): Fortran; numerical integration over a grid on the stellar disc.
# Its t_zero is the time of minimum projected separation, which on an inclined eccentric orbit is not the conjunction
# every other code here calls mid-transit (11.4 min apart for HD 80606 b). The case carries that offset, dtMinSep,
# from the 30-digit orbit, so ellc is compared on its model and not on the definition.
def lc_ellc(c, t, grid='default'):
    import ellc
    law, e, w = c['law'], c.get('ecc', 0), c.get('omega', 0) * DEG
    kw = dict(ld_1={'uniform': None, 'linear': 'lin', 'quadratic': 'quad', 'nonlinear': 'claret'}[law])
    if law == 'linear': kw['ldc_1'] = c['ld'][0]
    elif law != 'uniform': kw['ldc_1'] = list(c['ld'])
    return ellc.lc(np.asarray(t, float), radius_1=1 / c['ars'], radius_2=c['rprs'] / c['ars'], sbratio=0.0, incl=c['inc'], t_zero=c['tmid'] + c.get('dtMinSep', 0.0), period=c['per'],
                   f_c=math.sqrt(e) * math.cos(w), f_s=math.sqrt(e) * math.sin(w), shape_1='sphere', shape_2='sphere', grid_1=grid, grid_2=grid, **kw)
def lc_ellc_fine(c, t):
    return lc_ellc(c, t, grid='very_fine')

# ---- exoplanet-core (Agol, Luger & Foreman-Mackey 2020): kernel only, so it is given the truth separation
def lc_exoplanet_core(c, t, z=None, front=None):
    if c['law'] == 'nonlinear': return None
    import exoplanet_core as ec
    u = (0.0, 0.0) if c['law'] == 'uniform' else (c['ld'][0], 0.0) if c['law'] == 'linear' else tuple(c['ld'])
    f = 1 + np.asarray(ec.quad_limbdark_light_curve(u[0], u[1], np.where(front, z, 10.0), c['rprs']))
    return f

# ---- pylightcurve (Tsiaras et al. 2016): what EXOTIC calls. Gauss quadrature of the radial integral
def lc_pylightcurve(c, t, precision=3):
    import pylightcurve as plc
    law = c['law']
    method = {'uniform': 'linear', 'linear': 'linear', 'quadratic': 'quad', 'nonlinear': 'claret'}[law]
    ld = [0.0] if law == 'uniform' else list(c['ld'])
    return plc.transit(ld, c['rprs'], c['per'], c['ars'], c.get('ecc', 0), c['inc'], c.get('omega', 0), c['tmid'], np.asarray(t, float), method=method, precision=precision)
def lc_pylightcurve_p6(c, t):
    return lc_pylightcurve(c, t, precision=6)

LC = {
    'batman': lc_batman, 'batman (max_err 0.001 ppm)': lc_batman_tight, 'PyTransit': lc_pytransit, 'PyAstronomy': lc_pyastronomy,
    'ellc': lc_ellc, 'ellc (very_fine grid)': lc_ellc_fine, 'pylightcurve': lc_pylightcurve, 'pylightcurve (precision 6)': lc_pylightcurve_p6,
}

def versions():
    import numpy, scipy, mpmath
    return {'batman': _v('batman-package'), 'PyTransit': _v('pytransit'), 'PyAstronomy': _v('PyAstronomy'), 'ellc': _v('ellc'), 'exoplanet-core': _v('exoplanet-core'),
            'pylightcurve': _v('pylightcurve'), 'radvel': _v('radvel'), 'emcee': _v('emcee'), 'dynesty': _v('dynesty'), 'ultranest': _v('ultranest'),
            'astropy': _v('astropy'), 'numpy': numpy.__version__, 'scipy': scipy.__version__, 'mpmath': mpmath.__version__}
