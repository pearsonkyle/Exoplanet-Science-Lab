#!/usr/bin/env python
"""Build the bundled limb darkening table for Exoplanet Science Lab from PHOENIX specific intensities.

    pip install ldtk numpy scipy astropy            (pylightcurve is optional, see below)
    python tools/build_ld_table.py                  # writes src/data/ld_table.js
    python tools/build_ld_table.py --json ld_table.json   # also the verbose row format the app can load

What it does, for every (Teff, log g, [Fe/H]) node and every passband:
  1. takes the PHOENIX-ACES specific-intensity spectrum I(lambda, mu) of Husser et al. (2013) from the
     Goettingen server (the 5 nm "lowres" files LDTK uses; LDTK's cache in ~/.ldtk is shared, and LDTK's
     server file list is used to know which nodes exist),
  2. integrates it over the passband, photon weighted: sum I(lambda, mu) R(lambda) lambda,
  3. puts the stellar limb where dI/dr is steepest and rescales r to it (PHOENIX models are spherical, so
     their mu = 0 lies outside the photosphere; this is the convention of Claret 2018 and ExoTETHyS,
     Morello et al. 2020),
  4. fits, by unconstrained linear least squares on the model's own mu points with rescaled mu >= MU_MIN,
     the Claret (2000) law  I = 1 - sum_n a_n (1 - mu^(n/2)), n = 1..4.
     The files have 15 points evenly spaced in mu from about 0.12 to 1 and 60 more packed into the limb
     drop-off below about 0.04 (rescaled). The fit uses the 15; nothing constrains the law between 0.04
     and 0.12, and below MU_MIN the model intensity falls away faster than the law does.
Only the four Claret coefficients are stored. The app derives the linear and quadratic coefficients when
it loads the table (expandLDTable in src/core/ldest.js) as the least-squares fit to the four-coefficient
profile on NMU points evenly spaced in radius r = sqrt(1 - mu^2) from the centre to mu = MU_MIN; --json
writes the same numbers out. Even spacing in r (not in mu) is what ExoTETHyS uses; a two-coefficient law
cannot follow the profile, so the sampling decides where it gives way, and sampling in r keeps the misfit
out of the part of the disc a transiting planet spends most of its time on.

Differences from LDTK's own LDPSetCreator route (what exotic/api/gael_ld.py does), found when this was
first run (November 2026):
  - LDTK places the limb at the inner end of a fitted edge profile (mu ~ 0.08 for a G dwarf) instead of
    the steepest gradient (mu ~ 0.06). That alone moves I(mu) by about 0.003 rms.
  - LDTK's grid has no [Fe/H] = -0.5 node (its Z_POINTS skips it although the server has the files), and
    it interpolates with an unscaled Delaunay triangulation. Here every node is a real model.
  - With the steepest-gradient limb and photon weighting, the band-integrated profiles agree with the
    ExoTETHyS PHOENIX coefficients shipped in pylightcurve to a few 1e-5 at common nodes; see
    test/make_ld_reference.py and test/limbdark.test.mjs for the comparison that is kept under test.

Passbands: a measured response curve is used where pylightcurve ships one (~/.pylightcurve4/photometry/*.pass:
TESS, Kepler, CHEOPS, Johnson UBV, Cousins RI, SDSS ugriz, 2MASS JHKs); everything else is a boxcar between
the half-power wavelengths EXOTIC lists (exotic/api/filters.py). Without pylightcurve every band is a boxcar.
The JWST bands are boxcars over the instrument mode's wavelength range and use the "visir" files (to 5.5
micron); MIRI LRS (5-12 micron) is beyond those files and is not included.
"""
import argparse, base64, json, os, sys, time
from ftplib import FTP

import numpy as np

# ---- grid ---------------------------------------------------------------------------------
# Every native PHOENIX node from 2300 to 8000 K (100 K steps to 7000 K, 200 K above; there is no 5000 K
# model). Thinning to 200 K steps was tried and rejected: a profile interpolated across a skipped node
# misses the model there by 0.002-0.005 rms in I(mu) (0.01 below 3000 K), ten times the other errors.
TEFF = [t for t in range(2300, 7001, 100) if t != 5000] + list(range(7200, 8001, 200))
# log g 5.5 is kept for Teff <= LOGG55_TEFF_MAX only: late M dwarfs reach log g 5.2-5.3 and their profiles
# depend on gravity (clamping TRAPPIST-1 to 5.0 costs up to 0.007 rms in I(mu)); hotter dwarfs never get there.
LOGG = [4.0, 4.5, 5.0, 5.5]
LOGG55_TEFF_MAX = 4000
FEH = [-0.5, 0.0, 0.5]
MISSING = -32768      # int16 marker for a node the table does not hold
MU_MIN = 0.1
NMU = 200             # points, evenly spaced in r, on which the app derives the linear and quadratic laws
SCALE = 1e-4          # finest unit the coefficients are stored in (int16; coarser per filter if one would overflow)

# ---- passbands ----------------------------------------------------------------------------
# name: (lo nm, hi nm, pylightcurve .pass name or None, dataset)
# The names are the keys of FILTERS in src/core/ldest.js; the app matches them case-insensitively.
FILTERS = {
    # exotic/api/filters.py
    "Johnson U": (333.8, 398.8, "JOHNSON_U"), "Johnson B": (391.6, 480.6, "JOHNSON_B"), "Johnson V": (502.8, 586.8, "JOHNSON_V"),
    "Johnson R": (590.0, 810.0, None), "Johnson I": (780.0, 1020.0, None),
    "Cousins R": (561.7, 719.7, "COUSINS_R"), "Cousins I": (721.0, 875.0, "COUSINS_I"),
    "Sloan u": (321.8, 386.8, "sdss_u"), "Sloan g": (402.5, 551.5, "sdss_g"), "Sloan r": (553.1, 693.1, "sdss_r"),
    "Sloan i": (697.5, 827.5, "sdss_i"), "Sloan z": (841.2, 978.2, "sdss_z"),
    "Near-Infrared J": (1040.0, 1360.0, "2mass_j"), "Near-Infrared H": (1420.0, 1780.0, "2mass_h"), "Near-Infrared K": (2015.0, 2385.0, "2mass_ks"),
    "PanSTARRS z-short": (826.0, 920.0, None), "PanSTARRS Y": (946.4, 1054.4, None), "PanSTARRS w": (404.2, 845.8, None),
    "MObs CV (clear)": (350.0, 850.0, None), "Astrodon ExoPlanet-BB": (500.0, 1000.0, None),
    "Stromgren u": (336.3, 367.7, None), "Stromgren v": (401.5, 418.5, None), "Stromgren b": (459.55, 478.05, None),
    "Stromgren y": (536.7, 559.3, None), "Stromgren Hbw": (481.5, 496.5, None), "Stromgren Hbn": (484.5, 487.5, None),
    "Optec Wing A": (706.5, 717.5, None), "Optec Wing B": (748.5, 759.5, None), "Optec Wing C": (1003.0, 1045.0, None),
    # space missions (band edges are the approximate half-power range, used by the grey fallback only)
    "TESS (approx.)": (600.0, 1000.0, "TESS"), "Kepler (approx.)": (430.0, 890.0, "Kepler"), "CHEOPS (approx.)": (400.0, 1000.0, "CHEOPS"),
}
JWST = {  # white-light boxcars over each mode's wavelength range
    "JWST NIRISS SOSS": (850.0, 2800.0, None), "JWST NIRSpec PRISM": (600.0, 5300.0, None), "JWST NIRSpec G395H": (2870.0, 5140.0, None),
    "JWST NIRCam F322W2": (2430.0, 4010.0, None), "JWST NIRCam F444W": (3880.0, 4990.0, None),
}

SERVER = "phoenix.astro.physik.uni-goettingen.de"
DATASETS = {
    "vis-lowres": ("SpecInt50FITS/PHOENIX-ACES-AGSS-COND-SPECINT-2011", "lte{teff:05d}-{logg:4.2f}{z:+3.1f}.PHOENIX-ACES-AGSS-COND-SPECINT-2011.fits"),
    "visir-lowres": ("v3.0/SpecInt50FITS/", "lte{teff:05d}-{logg:4.2f}{z:+3.1f}.PHOENIX-ACES-AGSS-COND-2011-SpecInt.fits"),
}
PASS_DIR = os.path.expanduser("~/.pylightcurve4/photometry")


def zdir(z):
    return "Z" + ("-0.0" if z == 0 else "%+3.1f" % z)


def fname(dataset, teff, logg, z):
    return DATASETS[dataset][1].format(teff=int(teff), logg=logg, z=(-0.0 if z == 0 else z))


def cache_dir(dataset):
    root = os.getenv("LDTK_ROOT") or os.path.expanduser("~/.ldtk")
    return os.path.join(root, "cache_" + dataset)


def fetch(dataset, nodes, log=sys.stderr):
    """Download the files for `nodes` that are not in LDTK's cache. Returns {node: path} for those that exist."""
    from ldtk.client import Client
    listing = Client(dataset=dataset).files_in_server        # cached by LDTK after the first call
    paths, todo = {}, []
    for (t, g, z) in nodes:
        fn = fname(dataset, t, g, z)
        if fn not in listing.get(zdir(z), ()):
            continue                                          # no such model on the server
        p = os.path.join(cache_dir(dataset), zdir(z), fn)
        paths[(t, g, z)] = p
        if not (os.path.exists(p) and os.path.getsize(p) > 0):
            todo.append((zdir(z), fn, p))
    if todo:
        print(f"{dataset}: downloading {len(todo)} files", file=log)
        t0, ftp = time.time(), None
        for i, (zd, fn, p) in enumerate(todo):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            for attempt in range(4):
                try:
                    if ftp is None:
                        ftp = FTP(SERVER, timeout=60); ftp.login(); ftp.cwd(DATASETS[dataset][0])
                    with open(p + ".part", "wb") as fh:
                        ftp.retrbinary(f"RETR {zd}/{fn}", fh.write)
                    os.replace(p + ".part", p)
                    break
                except Exception as err:                      # dropped connection: reconnect and retry
                    print(f"  retry {fn}: {err}", file=log)
                    try:
                        ftp.close()
                    except Exception:
                        pass
                    ftp = None; time.sleep(5)
            else:
                raise RuntimeError("could not download " + fn)
            if (i + 1) % 25 == 0:
                print(f"  {i + 1}/{len(todo)}  {time.time() - t0:.0f} s", file=log)
        if ftp is not None:
            ftp.close()
    return paths


def read_specint(path):
    import astropy.io.fits as pf
    with pf.open(path) as h:
        hd = h[0].header
        wl = (hd["crval1"] + np.arange(hd["naxis1"]) * hd["cdelt1"]) * 0.1    # nm, bin centres
        return wl, np.array(h[0].data, dtype=float), np.array(h[1].data, dtype=float)   # I[mu, wl], mu ascending


def band_weight(wl, lo, hi, passname, use_pass=True):
    """Photon weights R(lambda) * lambda on the file's wavelength bins, and a description of R."""
    dwl = wl[1] - wl[0]
    if use_pass and passname and os.path.exists(os.path.join(PASS_DIR, passname + ".pass")):
        t = np.loadtxt(os.path.join(PASS_DIR, passname + ".pass"))
        return np.interp(wl, t[:, 0] * 0.1, t[:, 1], left=0.0, right=0.0) * wl, f"response curve ({passname}.pass, pylightcurve)"
    # boxcar: fraction of each bin inside [lo, hi] (LDTK's BoxcarFilter takes whole bins whose centre is inside)
    frac = np.clip((np.minimum(wl + dwl / 2, hi) - np.maximum(wl - dwl / 2, lo)) / dwl, 0.0, 1.0)
    return frac * wl, f"boxcar {lo:g}-{hi:g} nm"


def rescaled_profile(mu, I):
    """Limb at the steepest dI/dr; returns (mu', I/I(centre)) inside it, mu' ascending, and the limb's original mu."""
    r = np.sqrt(1.0 - mu ** 2)
    I = I / I[-1]
    k = int(np.argmin(np.gradient(I, r)))
    r2 = r / r[k]
    keep = r2 < 1.0
    return np.sqrt(1.0 - r2[keep] ** 2), I[keep], float(mu[k])


MU_GRID = np.sqrt(1.0 - (np.sqrt(1.0 - MU_MIN ** 2) * np.arange(NMU) / (NMU - 1)) ** 2)


def claret_basis(mu):
    return np.stack([1 - mu ** 0.5, 1 - mu, 1 - mu ** 1.5, 1 - mu ** 2], 1)


# The app treats a profile that goes negative or brightens toward the limb anywhere on the disc as outside
# the prior (checkProfile in src/core/limbdark.js, sampled at mu = i/200 and i/24), so a tabulated profile
# must not do either, including below MU_MIN where the law is an extrapolation. An unconstrained fit does
# both for about one fit in seven (cool stars and blue or narrow bands above all; ExoTETHyS's coefficients do it too). Those nodes are
# refitted under linear inequality constraints on the same sampling. The constraints are linear in the
# coefficients, so anything interpolated between constrained nodes satisfies them as well.
_MUC = np.unique(np.concatenate([np.arange(201) / 200.0, np.arange(25) / 24.0]))
_BC = claret_basis(_MUC)
_STEP = _BC[:-1] - _BC[1:]                 # I(mu_j+1) - I(mu_j) = _STEP[j] @ a
MARGIN_STEP, MARGIN_LIMB = 3e-5, 2e-3      # room for the int16 rounding of the stored coefficients


def is_physical(a, margin=0.0):
    """checkProfile's test (margin 0), or the same with `margin` times the room kept for rounding."""
    return bool(np.all(_STEP @ a >= margin * MARGIN_STEP - 1e-9) and 1.0 - _BC[0] @ a >= margin * MARGIN_LIMB - 1e-12)


def fit_claret(mu, I):
    """Four Claret coefficients of a profile, least squares on its points with mu >= MU_MIN, kept physical on
    the whole disc. Returns (a, rms residual, number of points, True if the constraints were needed)."""
    s = mu >= MU_MIN
    B, y = claret_basis(mu[s]), 1.0 - I[s]
    a = np.linalg.lstsq(B, y, rcond=None)[0]
    constrained = not is_physical(a, 1.0)
    if constrained:
        from scipy.optimize import minimize
        A, b = B.T @ B, B.T @ y
        cons = [{"type": "ineq", "fun": lambda x: _STEP @ x - MARGIN_STEP, "jac": lambda x: _STEP},
                {"type": "ineq", "fun": lambda x: np.array([1.0 - MARGIN_LIMB - _BC[0] @ x]), "jac": lambda x: -_BC[:1]}]
        lin = np.linalg.lstsq(B[:, 1:2], y, rcond=None)[0][0]            # a linear law is always feasible: start there
        x0 = np.array([0.0, min(max(lin, 0.01), 0.99), 0.0, 0.0])
        res = minimize(lambda x: 0.5 * x @ A @ x - b @ x, x0, jac=lambda x: A @ x - b, constraints=cons, method="SLSQP", options={"maxiter": 500, "ftol": 1e-14})
        a = res.x
        if not is_physical(a, 0.5):
            raise RuntimeError(f"constrained fit failed: {res.message}")
    return a, float(np.sqrt(np.mean((B @ a - y) ** 2))), int(s.sum()), constrained


def lower_laws(a):
    """Linear and quadratic coefficients of the Claret profile `a` as the app derives them (physicalFromClaret in
    src/core/ldest.js): least squares on MU_GRID, restricted to profiles that stay non-negative and monotonic."""
    y = claret_basis(MU_GRID) @ np.asarray(a)
    m = MU_GRID
    lin = np.clip(np.linalg.lstsq(np.stack([1 - m], 1), y, rcond=None)[0], 0.0, 1.0)
    Q = np.stack([1 - m, (1 - m) ** 2], 1)
    quad = np.linalg.lstsq(Q, y, rcond=None)[0]
    cons = [(-1.0, 0.0, 0.0), (-1.0, -2.0, 0.0), (1.0, 1.0, 1.0)]         # c0 u1 + c1 u2 <= c2
    inside = lambda x, tol=0.0: all(c[0] * x[0] + c[1] * x[1] <= c[2] + tol for c in cons)
    if not inside(quad):
        H, g, cand = Q.T @ Q, Q.T @ y, []
        for i, c in enumerate(cons):
            n2 = c[0] ** 2 + c[1] ** 2
            p, d = np.array([c[0] * c[2] / n2, c[1] * c[2] / n2]), np.array([-c[1], c[0]])
            cand.append(p + (g @ d - p @ H @ d) / (d @ H @ d) * d)
            for e in cons[i + 1:]:
                det = c[0] * e[1] - c[1] * e[0]
                if abs(det) > 1e-12:
                    cand.append(np.array([(c[2] * e[1] - c[1] * e[2]) / det, (c[0] * e[2] - c[2] * e[0]) / det]))
        quad = min((x for x in cand if inside(x, 1e-12)), key=lambda x: 0.5 * x @ H @ x - g @ x)
    return lin, quad


def node_coeffs(path, filters, use_pass=True):
    """{filter: (a[4], fit rms, limb mu, passband description)} for one model file."""
    wl, data, mu = read_specint(path)
    out = {}
    for name, (lo, hi, passname) in filters.items():
        w, desc = band_weight(wl, lo, hi, passname, use_pass)
        if not np.any(w > 0):
            continue
        m2, I2, limb = rescaled_profile(mu, data @ w)
        try:
            a, r, npts, constrained = fit_claret(m2, I2)
        except RuntimeError as err:
            raise RuntimeError(f"{path}, {name}: {err}")
        if npts < 8:
            raise RuntimeError(f"{path}: only {npts} points above mu = {MU_MIN} in {name}")
        out[name] = (a, r, limb, desc, constrained)
    return out


def wanted(t, g):
    return g <= 5.0 or t <= LOGG55_TEFF_MAX


def build(dataset, filters, teff, logg, feh, use_pass=True, log=sys.stderr):
    nodes = [(t, g, z) for t in teff for g in logg for z in feh if wanted(t, g)]
    paths = fetch(dataset, nodes, log)
    names = list(filters)
    coef = {n: np.full((len(teff), len(logg), len(feh), 4), np.nan) for n in names}
    rms = {n: [] for n in names}
    desc, ncon = {}, {n: 0 for n in names}
    for (t, g, z), p in sorted(paths.items()):
        for n, (a, r, limb, d, constrained) in node_coeffs(p, filters, use_pass).items():
            coef[n][teff.index(t), logg.index(g), feh.index(z)] = a
            rms[n].append(r); desc[n] = d; ncon[n] += constrained
    # models missing on the server: fill along Teff from the neighbouring nodes (linear), so the table stays rectilinear
    filled = []
    for ig, g in enumerate(logg):
        for iz, z in enumerate(feh):
            have = [i for i in range(len(teff)) if (teff[i], g, z) in paths]
            for i in range(len(teff)):
                if i in have or not have or not wanted(teff[i], g):
                    continue
                filled.append([teff[i], g, z])
                for n in names:
                    for k in range(4):
                        coef[n][i, ig, iz, k] = np.interp(teff[i], [teff[j] for j in have], [coef[n][j, ig, iz, k] for j in have])
    return coef, rms, desc, filled, ncon


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "src", "data", "ld_table.js"))
    ap.add_argument("--json", default=None, help="also write the verbose row format (teff, logg, feh, filter, linear, quadratic, nonlinear)")
    ap.add_argument("--no-jwst", action="store_true", help="skip the JWST bands (saves the second download)")
    ap.add_argument("--boxcar", action="store_true", help="ignore pylightcurve response curves; every band is a boxcar")
    ap.add_argument("--plain", action="store_true", help="store the coefficients as readable integer arrays instead of base64 int16 (about twice the size)")
    args = ap.parse_args()

    t0 = time.time()
    coef, rms, desc, filled, ncon = build("vis-lowres", FILTERS, TEFF, LOGG, FEH, not args.boxcar)
    bands = {n: [FILTERS[n][0], FILTERS[n][1]] for n in FILTERS}
    filled_ir = []
    if not args.no_jwst:
        c2, r2, d2, filled_ir, n2 = build("visir-lowres", JWST, TEFF, LOGG, FEH, False)
        coef.update(c2); rms.update(r2); desc.update(d2); ncon.update(n2); bands.update({n: [JWST[n][0], JWST[n][1]] for n in JWST})

    table = {
        "format": "esl-ld-compact-1",
        "source": "PHOENIX-ACES specific intensities (Husser et al. 2013), limb at the steepest gradient, photon weighted; tools/build_ld_table.py",
        "built": time.strftime("%Y-%m-%d"),
        "mu_min": MU_MIN, "nmu": NMU, "sampling": "r",
        "teff": TEFF, "logg": LOGG, "feh": FEH,
        "order": "a[((iTeff * nLogg + iLogg) * nFeh + iFeh) * 4 + n] * scale = Claret coefficient a_(n+1); a16 is the same array as little-endian int16, base64; -32768 (null in a) marks a node the table does not hold",
        "note": f"log g {LOGG[-1]} only for Teff <= {LOGG55_TEFF_MAX} K",
        "filled": {"vis-lowres": filled, "visir-lowres": filled_ir},
        "filters": {},
    }
    worst, unphysical = 0.0, 0
    for n, c in coef.items():
        hole = ~np.isfinite(c)
        if any(wanted(t, g) and hole[i, j].any() for i, t in enumerate(TEFF) for j, g in enumerate(LOGG)):
            print(f"skip {n}: incomplete", file=sys.stderr); continue
        scale = round(max(SCALE, float(np.ceil(np.nanmax(np.abs(c)) / 32767 / 1e-5) * 1e-5)), 7)
        ints = np.where(hole, MISSING, np.rint(np.where(hole, 0.0, c) / scale)).ravel().astype("<i2")
        entry = {"band": bands[n], "passband": desc[n], "dataset": "visir-lowres" if n in JWST else "vis-lowres", "scale": scale}
        if args.plain:
            entry["a"] = [None if v == MISSING else int(v) for v in ints]
        else:
            entry["a16"] = base64.b64encode(ints.tobytes()).decode("ascii")
        table["filters"][n] = entry
        stored = ints.astype(float).reshape(-1, 4)[ints.reshape(-1, 4)[:, 0] != MISSING] * scale
        unphysical += sum(not is_physical(a) for a in stored)
        worst = max(worst, max(rms[n]))
        print(f"{n:24s} {desc[n]:46s} Claret fit rms median {np.median(rms[n]):.1e} max {max(rms[n]):.1e}   constrained {ncon[n]:3d} of {len(rms[n])}", file=sys.stderr)

    body = json.dumps(table, separators=(",", ":"))
    js = ("// Generated by tools/build_ld_table.py; do not edit by hand.\n"
          "// Four Claret coefficients per (Teff, log g, [Fe/H]) node and passband, as int16 in units of each filter's `scale`.\n"
          "// expandLDTable() turns this into the row format the rest of the app reads (and derives linear and quadratic).\n"
          "import { expandLDTable } from '../core/ldest.js';\n"
          "export const LD_TABLE_COMPACT = " + body + ";\n"
          "export const LD_TABLE = expandLDTable(LD_TABLE_COMPACT);\n")
    with open(args.out, "w") as fh:
        fh.write(js)
    print(f"wrote {args.out}: {len(js) / 1024:.0f} KB, {len(table['filters'])} filters x {sum(wanted(t, g) for t in TEFF for g in LOGG) * len(FEH)} nodes, "
          f"{len(filled) + len(filled_ir)} filled, {sum(ncon.values())} fits constrained to stay physical, worst Claret fit rms {worst:.1e}, "
          f"{unphysical} stored profiles fail the physical check, {time.time() - t0:.0f} s", file=sys.stderr)

    if args.json:
        rows = []
        r5 = lambda v: [round(float(x), 5) for x in v]
        for n, f in table["filters"].items():
            ints = [MISSING if v is None else v for v in f["a"]] if "a" in f else np.frombuffer(base64.b64decode(f["a16"]), dtype="<i2")
            a = np.array(ints, dtype=float).reshape(len(TEFF), len(LOGG), len(FEH), 4) * f["scale"]
            held = np.array(ints).reshape(len(TEFF), len(LOGG), len(FEH), 4)[..., 0] != MISSING
            for i, t in enumerate(TEFF):
                for j, g in enumerate(LOGG):
                    for k, z in enumerate(FEH):
                        if not held[i, j, k]:
                            continue
                        lin, quad = lower_laws(a[i, j, k])
                        rows.append({"teff": t, "logg": g, "feh": z, "filter": n, "linear": r5(lin), "quadratic": r5(quad), "nonlinear": r5(a[i, j, k])})
        with open(args.json, "w") as fh:
            json.dump({"source": table["source"], "mu_min": MU_MIN, "rows": rows}, fh, separators=(",", ":"))
        print(f"wrote {args.json}: {len(rows)} rows", file=sys.stderr)


if __name__ == "__main__":
    main()
