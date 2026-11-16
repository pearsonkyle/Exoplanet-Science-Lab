# Reference for the wavelength-resolved limb darkening table (src/data/ld_spectral.js, src/core/ldspec.js).
# Run with an environment that has numpy, scipy, astropy and pylightcurve, and the PHOENIX files in ~/.ldtk:
#   /path/to/python test/make_ldspec_reference.py        -> test/ldspec_reference.json   (about 4 minutes)
#
# What it holds, and how independent each part is of the table under test:
#   'curves'    the response curves pylightcurve ships (~/.pylightcurve4/photometry/*.pass), thinned to 1 nm,
#               for the bands of the bundled 37-band table that were built with one and for the HST channels
#               below. The test feeds them to ldspec.js as { wl, response } bands.
#   'direct'    narrow channels integrated directly from the PHOENIX specific-intensity files at model nodes,
#               with the code of the 37-band builder (tools/build_ld_table.py: photon weighting on the files'
#               5 nm bins, limb at the steepest gradient of the channel's own profile, Claret fit kept
#               physical with SLSQP). Same model files as the table, none of its binning, compression or
#               combination. Below 2600 nm the "vis-lowres" files, above it the "visir-lowres" files, as the table.
#   'linearity' for a few nodes and broad bands: the Claret fit of the band-integrated profile, and the
#               F-weighted mean of the unconstrained fits of the table's bins (tools/build_ld_spectral.py,
#               before any compression). Tests the statement the design rests on: bins combine linearly.
#   'exotethys' ExoTETHyS coefficients (Morello et al. 2020) through pylightcurve's exotethys() for bands the
#               existing reference (limbdark_reference.json, used by the test as well) does not hold: HST WFC3
#               G141 and G102 spectroscopic channels about 22 nm wide, their white-light bands, and three clear
#               filters. 'phoenix': same model family, different processing (solar metallicity only);
#               'atlas': different atmosphere code, Teff >= 3500 K.
import contextlib, io, json, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import build_ld_table as T37          # noqa: E402  (the 37-band builder: reading, limb definition, constrained fit)
import build_ld_spectral as SP        # noqa: E402  (the builder under test, for 'linearity' only)
from pylightcurve import exotethys    # noqa: E402
import pylightcurve                   # noqa: E402

t_start = time.time()
SPLIT = SP.SPLIT
r6 = lambda v: [round(float(x), 6) for x in v]

# ---- response curves ----------------------------------------------------------------------------
PASS = {n: p for n, (lo, hi, p) in T37.FILTERS.items() if p}                      # table filter name -> .pass name
HST = [f"hst_wfc3_g141_h{i}" for i in range(25)] + [f"hst_wfc3_g102_h{i}" for i in range(14)] + ["hst_wfc3_g141_w", "hst_wfc3_g102_w", "clear", "luminance", "exoplanets_bb"]


def curve(passname):
    t = np.loadtxt(os.path.join(T37.PASS_DIR, passname + ".pass"))
    wl, r = t[:, 0] * 0.1, t[:, 1]
    keep = [0]
    for i in range(1, len(wl) - 1):
        if wl[i] - wl[keep[-1]] >= 1.0 - 1e-9:
            keep.append(i)
    keep.append(len(wl) - 1)
    return {"wl": [round(float(x), 3) for x in wl[keep]], "response": [round(float(x), 5) for x in r[keep]]}


curves = {n: curve(p) for n, p in PASS.items()}
curves.update({p: curve(p) for p in HST})

# ---- direct integration of narrow channels at model nodes -------------------------------------------
NODES = [(2500, 5.0, 0.0), (2800, 5.0, 0.0), (3100, 5.0, 0.0), (3500, 5.0, 0.0), (3900, 4.5, 0.0), (4400, 4.5, 0.0), (4900, 4.5, 0.0),
         (5400, 4.5, 0.0), (5800, 4.5, 0.0), (6200, 4.5, 0.0), (6600, 4.0, 0.0), (7400, 4.0, 0.0),
         (3300, 5.0, -0.5), (3300, 5.0, 0.5), (5600, 4.5, 0.5), (5600, 4.0, -0.5)]
CHANNELS = ([[lo, lo + 20] for lo in range(200, 1000, 20)]            # 20 nm, ultraviolet to 1 micron
            + [[lo, lo + 40] for lo in range(1000, 2600, 40)]         # 40 nm, 1 to 2.6 micron (NIRISS SOSS-like)
            + [[lo, lo + 20] for lo in range(2900, 5100, 100)]        # 20 nm, 2.9 to 5.1 micron (NIRSpec G395H-like)
            + [[lo, lo + 100] for lo in range(2600, 5500, 100)])      # 100 nm, 2.6 to 5.5 micron (NIRSpec PRISM-like)


def model_path(dataset, node):
    return os.path.join(T37.cache_dir(dataset), T37.zdir(node[2]), T37.fname(dataset, *node))


def direct_fit(wl, data, mu, lo, hi):
    w, _ = T37.band_weight(wl, lo, hi, None)
    m2, I2, limb = T37.rescaled_profile(mu, data @ w)
    a, rms, npts, constrained = T37.fit_claret(m2, I2)
    return a, constrained


direct = []
for node in NODES:
    files = {ds: T37.read_specint(model_path(ds, node)) for ds in ("vis-lowres", "visir-lowres")}
    coeffs, con = [], 0
    for lo, hi in CHANNELS:
        a, c = direct_fit(*files["vis-lowres" if hi <= SPLIT else "visir-lowres"], lo, hi)
        coeffs.append(r6(a)); con += c
    direct.append({"teff": node[0], "logg": node[1], "feh": node[2], "a": coeffs, "constrained": con})
    print(f"direct {node}: {len(CHANNELS)} channels, {con} constrained, {time.time() - t_start:.0f} s", file=sys.stderr)

# ---- do bins combine linearly? ----------------------------------------------------------------------
edges = SP.make_edges()
BROAD = [[600, 1000], [400, 550], [430, 890], [550, 700], [330, 400], [1100, 1700], [2000, 2400], [2900, 5100]]
linearity = []
for node in [(2800, 5.0, 0.0), (3500, 5.0, 0.0), (4400, 4.5, 0.0), (5800, 4.5, 0.0), (6600, 4.0, 0.0)]:
    for lo, hi in BROAD:
        ds = "vis-lowres" if hi <= SPLIT else "visir-lowres"
        wl, data, mu = T37.read_specint(model_path(ds, node))
        sel = (edges[1:] > lo) & (edges[:-1] < hi)
        sub = edges[np.r_[np.where(sel)[0], np.where(sel)[0][-1] + 1]]
        a_bins, F = SP.fit_bins(model_path(ds, node), SP.bin_weights(wl, sub))
        frac = np.clip((np.minimum(sub[1:], hi) - np.maximum(sub[:-1], lo)) / np.diff(sub), 0, 1)
        w = frac * F
        combined = (w[:, None] * a_bins).sum(0) / w.sum()
        wband, _ = T37.band_weight(wl, lo, hi, None)
        m2, I2, limb = T37.rescaled_profile(mu, data @ wband)
        s = m2 >= T37.MU_MIN
        plain = np.linalg.lstsq(T37.claret_basis(m2[s]), 1.0 - I2[s], rcond=None)[0]
        # the same combination done on the profiles themselves (each bin's Claret profile on a common mu grid)
        g = np.linspace(0.1, 1.0, 91)
        prof_mean = (w[:, None] * (1.0 - T37.claret_basis(g) @ a_bins.T).T).sum(0) / w.sum()
        linearity.append({"teff": node[0], "logg": node[1], "feh": node[2], "band": [lo, hi], "nbins": int(sel.sum()),
                          "direct": r6(plain), "combined": r6(combined),
                          "identity": float(np.abs(prof_mean - (1.0 - T37.claret_basis(g) @ combined)).max())})

# ---- ExoTETHyS for bands the existing reference lacks -----------------------------------------------
STARS = [("TRAPPIST-1 (M8)", 2566, 5.24, 0.04), ("LHS 1140 (M4.5)", 3096, 5.04, -0.15), ("GJ 1214-like (M4)", 3250, 4.95, 0.20), ("GJ 436 (M2.5)", 3586, 4.84, 0.02),
         ("WASP-43 (K7)", 4400, 4.65, -0.05), ("HD 189733 (K2)", 5052, 4.59, -0.03), ("HD 80606 (G5)", 5565, 4.40, 0.35), ("Sun (G2)", 5772, 4.44, 0.00),
         ("HD 209458 (F9)", 6091, 4.45, 0.00), ("WASP-12 (F9, low gravity)", 6360, 4.16, 0.30), ("WASP-121 (F6)", 6459, 4.24, 0.13), ("WASP-33 (A5)", 7430, 4.30, 0.10)]
cases = []
for name, teff, logg, feh in STARS:
    for p in HST:
        for model in ("phoenix", "atlas"):
            if model == "atlas" and not (3500 <= teff and logg <= 5.0):
                continue
            with contextlib.redirect_stdout(io.StringIO()):
                c = exotethys(logg, teff, 0.0, p, method="claret", stellar_model=model)
            cases.append({"star": name, "teff": teff, "logg": logg, "feh": 0.0, "filter": p, "model": model, "nonlinear": r6(c[:4])})

ref = {
    "source": f"see the header of test/make_ldspec_reference.py; pylightcurve {pylightcurve.__version__}",
    "split": SPLIT, "curves": curves, "channels": CHANNELS, "direct": direct, "linearity": linearity, "exotethys": cases,
}
out = os.path.join(HERE, "ldspec_reference.json")
with open(out, "w") as fh:
    json.dump(ref, fh, separators=(",", ":"))
print(f"wrote {out}: {len(direct)} nodes x {len(CHANNELS)} channels, {len(linearity)} linearity cases, {len(cases)} ExoTETHyS cases, "
      f"{len(curves)} curves, {os.path.getsize(out) / 1024:.0f} KB, {time.time() - t_start:.0f} s")
