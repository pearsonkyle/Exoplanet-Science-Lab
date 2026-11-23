"""Independent references for src/core/atmosphere.js, transmission.js, emission.js, continuum.js and colour.js.

Run:  .venv-rt/bin/python test/make_atmosphere_reference.py     (writes test/atmosphere_reference.json)
Environment (.venv-rt, Python 3.12): numpy, scipy, colour-science 0.4.7, petitRADTRANS 3.4.0
    uv venv --python 3.12 .venv-rt
    uv pip install --python .venv-rt/bin/python numpy scipy h5py meson-python ninja exo_k pyfastchem colour-science
    SDKROOT=$(xcrun --show-sdk-path) uv pip install --python .venv-rt/bin/python --no-build-isolation petitRADTRANS
  (on macOS, Homebrew's gfortran cannot link without SDKROOT: "ld: library 'System' not found")

Sections
  hydro      radii of a Guillot (2010) profile under g = GM/r^2, by adaptive quadrature of d(1/r) = kT/(mu m_u GM) dlnP
  transit    effective radius of an isothermal atmosphere with constant mass opacity, by nested adaptive quadrature
             of the chord optical depth and of the absorbing area; constant and inverse-square gravity
  emission   emergent flux of a grey plane-parallel atmosphere with a Guillot profile:
             F = 2 pi [ int B(T(tau)) E2(tau) dtau + B(T_bottom) E3(tau_max) ]
  hminus     petitRADTRANS's own H- bound-free and free-free functions (the same Gray 2005 fits, a transcription check)
  colour     chromaticities of blackbodies and of the equal-energy spectrum with the tabulated CIE 1931 2-degree
             colour-matching functions (colour-science), 360-830 nm at 1 nm
"""
import json, os
os.environ.setdefault('pRT_emcee_mode', 'True')   # petitRADTRANS's own switch: do not load mpi4py (no MPI library here)
import numpy as np
from scipy.integrate import quad
from scipy.special import expn

K_B, M_U, BAR = 1.380649e-23, 1.66053906660e-27, 1e5
GM_JUP = 1.32712440018e20 * 9.5459426398e-4
R_JUP = 7.1492e7
out = {}

def guillot(p_bar, teq, tint, kappa, gamma, g, f=0.25):
    tau = kappa * p_bar * BAR / g
    s3 = np.sqrt(3.0)
    irr = 2 / 3 + 1 / (gamma * s3) + (gamma / s3 - 1 / (gamma * s3)) * np.exp(-gamma * tau * s3)
    return (0.75 * tint**4 * (2 / 3 + tau) + 0.75 * 4 * teq**4 * f * irr) ** 0.25

# ---- hydro ------------------------------------------------------------------------------------------------------
case = dict(mplanet=0.8, rplanet=1.3, pRef=0.01, mu=2.01588, teq=1400.0, tint=200.0, kappaIR=1e-3, gamma=0.5)
gm, r0 = GM_JUP * case['mplanet'], R_JUP * case['rplanet']
g0 = gm / r0**2
T = lambda lnp: guillot(np.exp(lnp) / BAR, case['teq'], case['tint'], case['kappaIR'], case['gamma'], g0)
levels = np.logspace(-6, 2, 9)
radii = []
for p in levels:
    val, _ = quad(lambda x: K_B * T(x) / (case['mu'] * M_U * gm), np.log(case['pRef'] * BAR), np.log(p * BAR), epsabs=0, epsrel=1e-12, limit=400)
    radii.append(1 / (1 / r0 + val))
out['hydro'] = dict(case=case, levels=list(levels), radius=radii, t=[float(T(np.log(p * BAR))) for p in levels])

# ---- transit ----------------------------------------------------------------------------------------------------
def transit(mplanet, rplanet, temp, mu, kappa, p_ref, p_top, p_bottom, constant_g):
    gm, r0 = GM_JUP * mplanet, R_JUP * rplanet
    g0 = gm / r0**2
    H = K_B * temp / (mu * M_U * g0)
    if constant_g:
        rho = lambda r: p_ref * BAR * mu * M_U / (K_B * temp) * np.exp(-(r - r0) / H)
        r_of = lambda p: r0 - H * np.log(p / p_ref)
    else:
        a = gm * mu * M_U / (K_B * temp)
        rho = lambda r: p_ref * BAR * mu * M_U / (K_B * temp) * np.exp(a * (1 / r - 1 / r0))
        r_of = lambda p: 1 / (1 / r0 + np.log(p / p_ref) / a)
    r_top, r_bot = r_of(p_top), r_of(p_bottom)
    def tau(b):
        smax = np.sqrt(max(r_top**2 - b**2, 0.0))
        v, _ = quad(lambda s: rho(np.sqrt(b * b + s * s)), 0, smax, epsabs=0, epsrel=1e-11, limit=400, points=[min(smax, 5 * np.sqrt(2 * b * H))] if smax > 5 * np.sqrt(2 * b * H) else None)
        return 2 * kappa * v
    # in units of H the integrand 1 - exp(-tau) is a smooth step: split the range for the adaptive rule
    edges = np.linspace(r_bot, r_top, 60)
    area = np.pi * r_bot**2
    for lo, hi in zip(edges[:-1], edges[1:]):
        v, _ = quad(lambda b: 2 * np.pi * b * -np.expm1(-tau(b)), lo, hi, epsabs=0, epsrel=1e-10, limit=200)
        area += v
    return dict(radius=float(np.sqrt(area / np.pi)), H=float(H), r0=float(r0), g=float(g0), r_top=float(r_top), r_bottom=float(r_bot))

out['transit'] = []
for constant_g in (True, False):
    for kappa in (1e-4, 1e-2, 1.0):
        c = dict(mplanet=1.0, rplanet=1.2, temp=1500.0, mu=2.01588, kappa=kappa, p_ref=10.0, p_top=1e-10, p_bottom=1e3, constant_g=constant_g)
        out['transit'].append(dict(case=c, **transit(**c)))
# a puffy planet where H / R is ten times larger
c = dict(mplanet=0.1, rplanet=1.0, temp=2000.0, mu=2.01588, kappa=1e-4, p_ref=10.0, p_top=1e-5, p_bottom=1e3, constant_g=False)   # unbound above about 1e-8 bar; the opacity is low enough that the top level is transparent (chord optical depth 0.004)
out['transit'].append(dict(case=c, **transit(**c)))

# ---- emission ---------------------------------------------------------------------------------------------------
def planck(wl, t):   # W m^-2 sr^-1 micron^-1, wl in micron
    return 1.1910429723971884e8 / (wl**5 * np.expm1(14387.768775 / (wl * t)))
em = dict(g=25.0, teq=1500.0, tint=300.0, kappaIR=1e-3, gamma=0.4, kappa=2e-3, pTop=1e-8, pBottom=1e3, wl=[1.0, 3.0, 10.0])
tau_of_p = lambda p_bar: em['kappa'] * p_bar * BAR / em['g']
Tt = lambda tau: guillot(tau * em['g'] / em['kappa'] / BAR, em['teq'], em['tint'], em['kappaIR'], em['gamma'], em['g'])
tau_max = tau_of_p(em['pBottom'])
flux = []
for wl in em['wl']:
    v = 0.0
    for lo, hi in zip(np.logspace(-9, np.log10(min(tau_max, 60.0)), 40)[:-1], np.logspace(-9, np.log10(min(tau_max, 60.0)), 40)[1:]):
        vv, _ = quad(lambda t: planck(wl, Tt(t)) * expn(2, t), lo, hi, epsabs=0, epsrel=1e-12)
        v += vv
    flux.append(float(2 * np.pi * v))
out['emission'] = dict(case=em, flux=flux, tau_max=float(tau_max))

# ---- H- ---------------------------------------------------------------------------------------------------------
from petitRADTRANS.radtrans import Radtrans
import petitRADTRANS
wl_bf = np.array([0.4, 0.85, 1.2, 1.6, 1.7])
bf = [float(Radtrans._compute_h_minus_bound_free_xsec(np.array([w * 1e4 * (1 - 1e-7), w * 1e4 * (1 + 1e-7)]))[0]) for w in wl_bf]
wl_ff = np.array([0.5, 1.6, 5.0, 10.0])
ff = {str(t): [float(x) for x in Radtrans._compute_h_minus_free_free_xsec(wl_ff * 1e4, float(t), 1.0)] for t in (2400, 3000, 6000)}
out['hminus'] = dict(version=petitRADTRANS.__version__, wl_bf=list(wl_bf), bf=bf, wl_ff=list(wl_ff), ff=ff)

# ---- Rayleigh scattering of other gases: petitRADTRANS's cross-sections (from refractive indices) ----------------------
from petitRADTRANS import fortran_radtrans_core as _frc
_core = getattr(_frc, 'fortran_radtrans_core', _frc)
MOLAR = {'H2O': 18.01528, 'CO2': 44.0095, 'CO': 28.0101, 'CH4': 16.0425, 'N2': 28.0134, 'O2': 31.9988}
wl_r = np.array([0.4, 0.6, 1.0, 2.0])
ray = {}
for sp, mm in MOLAR.items():
    k = _core.compute_rayleigh_scattering_opacities(sp, np.array([1.0]), wl_r * 1e4, np.array([mm]), np.array([300.0]), np.array([1.0]))   # cm^2/g of the pure gas
    ray[sp] = [float(v) * mm * 1.66053906660e-24 for v in np.asarray(k)[:, 0]]
out['rayleigh'] = dict(wl=list(wl_r), sigma=ray)

# ---- Mie extinction of a size distribution, for the fit of Kitzmann & Heng (2018) ---------------------------------
# Bohren & Huffman's series with scipy's spherical Bessel functions; a log-normal distribution of radii (sigma = 0.5
# in ln r), the efficiency averaged by cross-section. x is 2 pi r_eff / wavelength with r_eff the area-weighted mean radius.
from scipy.special import spherical_jn, spherical_yn
def mie_qext(x, m):
    nmax = int(x + 4 * x ** (1 / 3) + 2) + 1
    n = np.arange(1, nmax + 1)
    psi = lambda z: z * spherical_jn(n, z); dpsi = lambda z: spherical_jn(n, z) + z * spherical_jn(n, z, derivative=True)
    xi = x * (spherical_jn(n, x) + 1j * spherical_yn(n, x)); dxi = (spherical_jn(n, x) + 1j * spherical_yn(n, x)) + x * (spherical_jn(n, x, derivative=True) + 1j * spherical_yn(n, x, derivative=True))
    mx = m * x
    a = (m * psi(mx) * dpsi(x) - psi(x) * dpsi(mx)) / (m * psi(mx) * dxi - xi * dpsi(mx))
    b = (psi(mx) * dpsi(x) - m * psi(x) * dpsi(mx)) / (psi(mx) * dxi - m * xi * dpsi(mx))
    return float(2 / x**2 * ((2 * n + 1) * (a + b).real).sum())
def mie_dist(xeff, m, s=0.5, nr=120):
    u = np.linspace(-3 * s, 3 * s, nr); w = np.exp(-0.5 * (u / s) ** 2) * np.exp(2 * u)   # dN/dlnr x r^2
    reff_over_rm = np.exp(2.5 * s * s)                                                     # <r^3>/<r^2> of a log-normal
    q = np.array([mie_qext(xeff / reff_over_rm * np.exp(v), m) for v in u])
    return float((q * w).sum() / w.sum())
xs = [0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0]
out['mie'] = dict(x=xs, sigma_ln=0.5, cases={name: dict(m=[m.real, m.imag], q=[mie_dist(x, m) for x in xs]) for name, m in (('silicate-like, m = 1.6 + 0.01i', 1.6 + 0.01j), ('ice-like, m = 1.3 + 0.001i', 1.3 + 0.001j))})

# ---- the Guillot profile as petitRADTRANS writes it, for the self-consistent profile's closure (test/climate.test.mjs) --
from petitRADTRANS import physics as _phys
pg = np.logspace(-6, 2, 9); gcase = dict(kappa=0.01, gamma=0.4, g=900.0, tint=150.0, teq=1450.0)   # cgs: cm^2/g, cm/s^2
tg = _phys.temperature_profile_function_guillot_global(pg, gcase['kappa'], gcase['gamma'], gcase['g'], gcase['tint'], gcase['teq'])
out['guillot_prt'] = dict(case=gcase, p=[float(v) for v in pg], t=[float(v) for v in np.asarray(tg)])

# ---- colour -----------------------------------------------------------------------------------------------------
import colour
cmfs = colour.MSDS_CMFS['CIE 1931 2 Degree Standard Observer']
nm = np.arange(360, 831)
xyz_bar = np.array([cmfs[w] for w in nm])
def xy(spec):
    X, Y, Z = (spec[:, None] * xyz_bar).sum(axis=0)
    return [float(X / (X + Y + Z)), float(Y / (X + Y + Z))]
temps = [2500, 3500, 4500, 5772, 6500, 8000, 10000, 20000]
out['colour'] = dict(version=colour.__version__, temps=temps,
                     blackbody=[xy(1 / (nm.astype(float)**5 * np.expm1(1.438776877e7 / (nm * t)))) for t in temps],
                     equal_energy=xy(np.ones(len(nm))),
                     cmf_nm=[450, 500, 550, 600, 650], cmf=[[float(v) for v in cmfs[w]] for w in (450, 500, 550, 600, 650)])

# ---- limb colours of a grey star -----------------------------------------------------------------------------------
# I(mu, lambda) = int_0^inf B_lambda(T(tau)) exp(-tau / mu) dtau / mu with T^4 = 3/4 Teff^4 (tau + q(tau)), by adaptive
# quadrature at every nanometre, then XYZ with the tabulated observer and linear sRGB with colour-science's matrix.
from scipy.integrate import quad
M_SRGB = np.array(colour.RGB_COLOURSPACES['sRGB'].matrix_XYZ_to_RGB)
def limb_rgb(teff, mu):
    def inten(w):
        f = lambda x: np.exp(-x) / (w**5 * np.expm1(1.438776877e7 / (w * teff * (0.75 * (mu * x + 0.7104 - 0.1331 * np.exp(-3.4488 * mu * x)))**0.25)))
        return quad(f, 0, 60, epsabs=0, epsrel=1e-10, limit=200)[0]
    spec = np.array([inten(float(w)) for w in nm])
    return np.clip(M_SRGB @ (spec[:, None] * xyz_bar).sum(axis=0), 0, None)
limb = {}
for teff in (4000, 5772, 9000):
    centre = limb_rgb(teff, 1.0)
    limb[str(teff)] = [[float(v) for v in limb_rgb(teff, m) / centre.max()] for m in (0.2, 0.5, 1.0)]
out['limb'] = dict(mu=[0.2, 0.5, 1.0], n=50, k=[9, 24, 49], rgb=limb)

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'atmosphere_reference.json')
json.dump(out, open(path, 'w'), indent=1)
print('wrote', path)
for t in out['transit']: print(t['case']['constant_g'], t['case']['kappa'], (t['radius'] - t['r0']) / t['H'], t['H'] / t['r0'])
print('emission', flux, 'tau_max', tau_max)
