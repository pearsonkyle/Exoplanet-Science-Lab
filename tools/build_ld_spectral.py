#!/usr/bin/env python
"""Build the wavelength-resolved limb darkening table (src/data/ld_spectral.js) from PHOENIX specific intensities.

    python tools/build_ld_spectral.py                 # writes src/data/ld_spectral.js (about 10 s)
    python tools/build_ld_spectral.py --explore       # also prints how the accuracy depends on the number of components

Needs numpy and astropy, and the PHOENIX-ACES specific-intensity files of Husser et al. (2013) in LDTK's cache
(~/.ldtk/cache_vis-lowres and ~/.ldtk/cache_visir-lowres, about 530 MB). tools/build_ld_table.py downloads both
sets; run it first on a machine that does not have them. This builder only reads the cache.

What is stored. For every (Teff, log g, [Fe/H]) node of the bundled 37-band table and every wavelength bin:
  1. the model intensities I(lambda, mu) are summed over the bin, photon weighted (sum I lambda);
  2. the limb is put where dI/dr of that bin's profile is steepest and r is rescaled to it (Claret 2018, ExoTETHyS);
  3. the Claret (2000) law I = 1 - sum a_n (1 - mu^(n/2)) is fitted by plain least squares on the model's own mu points
     with rescaled mu >= 0.1;
  4. the bin's photon-weighted centre intensity F = sum I(lambda, mu = 1) lambda is kept.
A band is then a set of weights w_b over the bins (overlap with a wavelength range, or a response curve averaged
over each bin), and its profile is sum_b w_b F_b I_b(mu) / sum_b w_b F_b. The Claret law is linear in its
coefficients and every I_b is normalised to 1 at the centre, so the band's coefficients are the same weighted mean
of the bins' coefficients (src/core/ldspec.js; checked numerically in test/ldspec.test.mjs).

How it is made small. The numbers per node, 5 per bin (four profile coordinates and ln F), are strongly
correlated from bin to bin and from star to star. They are stored as a mean spectrum plus K principal components:
K "spectra" of 5 numbers per bin and K scores per stellar node, all int16. The profile coordinates are the Claret
coefficients rotated to a basis that is orthonormal on mu in [0.1, 1] (sampled evenly in radius), so the Euclidean
error the truncation minimises is the rms error of I(mu), and the four nearly collinear coefficients are not
quantised directly.

Choices, with the measurements behind them (November 2026; test/ldspec.test.mjs prints the accuracy of the
table as built, `--res`, `--ncomp` and `--explore` let you repeat the comparison):
  - Bins are unions of the files' 5 nm bins, about lambda / 120 wide: 5 nm up to 900 nm, 10 nm at 1.2 micron,
    25 nm at 3 micron, 45 nm at 5.4 micron; 357 bins from 200 to 5500 nm. The resolution decides how well a narrow
    channel is served and costs little, because only the component spectra grow with it. Worst I(mu) rms over
    mu in [0.1, 1] against direct integration of the files (16 stars) and against ExoTETHyS (12 stars):
        lambda / res, components, size     20 nm, 0.4-1 um   late M dwarfs   HST WFC3 22 nm channels   3-23 nm filters
        40,  48   168 kB (115 gzipped)        0.013             0.037           0.053                     0.050
        80,  40   207 kB (141)                0.0028            0.0051          0.019                     0.078
        80,  48   247 kB (169)                0.0016            0.0046          0.019                     0.080
        120, 40   261 kB (178)   <- built     0.0025            0.0045          0.0092                    0.0093
    Broad bands are the same in all four (median 0.0003 to 0.0004).
  - 40 components. With 8 the broad bands are off by 0.01-0.02 in the worst model, with 16 by 0.005-0.01, with 32
    by 0.002-0.005, with 48 by 0.001-0.002, with 96 by 0.0003 (lambda / 40 bins; `--explore` prints this for the
    current bins).
  - The fits are NOT constrained to stay physical here (the 37-band builder does that with SLSQP, 0.1 s per fit;
    a seventh of the bin fits would need it, an hour of work, and a combination of bins needs it less often than its
    bins). ldspec.js applies the same constraints to the combined profile of each band instead.
  - Below 2600 nm the "vis-lowres" files are used and above it the "visir-lowres" files (the only ones that reach
    5.5 micron). The two sets are different PHOENIX runs: where they overlap their band profiles differ by about
    0.001 rms in I(mu) (0.005 for A stars, 0.025 in one near-UV case). The bundled 37-band table and ExoTETHyS use
    the "vis" set for everything below 2.6 micron, so this table agrees with both there.
  - Models missing on the server (5 in one set, 3 in the other) are filled linearly along Teff, like the 37-band table.

Limits. Wavelength: 200 to 5500 nm. The files start at 52.5 nm, but below 200 nm the photospheric flux of the
coolest models underflows single precision, and real cool stars emit their ultraviolet from a chromosphere that
these models do not have: treat everything below about 300 nm for M and K dwarfs as formal. Redward, 5.5 micron is
the end of the files (JWST MIRI needs other models: the full-resolution PHOENIX SpecInt cubes stop there too;
ATLAS/Kurucz or MPS-ATLAS grids go further). Stars: Teff 2300-8000 K, log g 4.0-5.0 (5.5 up to 4000 K),
[Fe/H] -0.5 to +0.5: dwarfs. No giants, nothing hotter than A5.
"""
import argparse, base64, json, os, sys, time

import numpy as np

# ---- grid: identical to tools/build_ld_table.py, so both tables interpolate alike -------------
TEFF = [t for t in range(2300, 7001, 100) if t != 5000] + list(range(7200, 8001, 200))
LOGG = [4.0, 4.5, 5.0, 5.5]
LOGG55_TEFF_MAX = 4000
FEH = [-0.5, 0.0, 0.5]
MISSING = -32768
MU_MIN = 0.1
WL_MIN, WL_MAX, SPLIT = 200.0, 5500.0, 2600.0     # nm; below SPLIT the "vis" files, above it the "visir" files
RES = 120                                          # bins about lambda / RES wide
NCOMP = 40                                         # principal components kept
LNF_SCALE = 0.05                                   # ln F enters the decomposition times this (0.02 in ln F ~ 0.001 in I)
DX = 5.0                                           # nm, bin width of the files

DATASETS = {
    "vis-lowres": "lte{teff:05d}-{logg:4.2f}{z:+3.1f}.PHOENIX-ACES-AGSS-COND-SPECINT-2011.fits",
    "visir-lowres": "lte{teff:05d}-{logg:4.2f}{z:+3.1f}.PHOENIX-ACES-AGSS-COND-2011-SpecInt.fits",
}


# ---- copied from tools/build_ld_table.py (file naming, reading, limb definition, Claret basis) ----
def zdir(z):
    return "Z" + ("-0.0" if z == 0 else "%+3.1f" % z)


def fname(dataset, teff, logg, z):
    return DATASETS[dataset].format(teff=int(teff), logg=logg, z=(-0.0 if z == 0 else z))


def cache_dir(dataset):
    root = os.getenv("LDTK_ROOT") or os.path.expanduser("~/.ldtk")
    return os.path.join(root, "cache_" + dataset)


def read_specint(path):
    import astropy.io.fits as pf
    with pf.open(path) as h:
        hd = h[0].header
        wl = (hd["crval1"] + np.arange(hd["naxis1"]) * hd["cdelt1"]) * 0.1    # nm, bin centres
        return wl, np.array(h[0].data, dtype=float), np.array(h[1].data, dtype=float)   # I[mu, wl], mu ascending


def claret_basis(mu):
    return np.stack([1 - mu ** 0.5, 1 - mu, 1 - mu ** 1.5, 1 - mu ** 2], 1)


def wanted(t, g):
    return g <= 5.0 or t <= LOGG55_TEFF_MAX


# ---- wavelength bins ----------------------------------------------------------------------------
def make_edges(res=RES, lo=WL_MIN, hi=WL_MAX):
    """Bin edges on the files' 5 nm grid, each bin about lambda / res wide, with an edge at SPLIT."""
    e = [lo]
    while e[-1] < hi - 1e-9:
        w = max(DX, DX * round(e[-1] / res / DX))
        nxt = e[-1] + w
        if e[-1] < SPLIT < nxt + 0.5 * w:
            nxt = SPLIT
        if hi - nxt < 0.5 * w:
            nxt = hi
        e.append(min(nxt, hi))
    return np.array(e)


def bin_weights(wl, edges):
    """W[b, i]: photon weight of file bin i in table bin b (fraction of the file bin inside it, times lambda)."""
    lo, hi = edges[:-1, None], edges[1:, None]
    return np.clip((np.minimum(wl + DX / 2, hi) - np.maximum(wl - DX / 2, lo)) / DX, 0.0, 1.0) * wl


def fit_bins(path, W):
    """Claret coefficients a[nb, 4] and centre intensity F[nb] of every table bin with weight in this file."""
    wl, data, mu = read_specint(path)
    P = data @ W.T                                   # [mu, bin]
    F = P[-1].copy()
    P = P / F
    r = np.sqrt(1.0 - mu ** 2)
    k = np.argmin(np.gradient(P, r, axis=0), axis=0)  # the limb of each bin: steepest dI/dr (as rescaled_profile)
    a = np.zeros((W.shape[0], 4))
    for kk in np.unique(k):
        r2 = r / r[kk]
        keep = r2 < 1.0
        m2 = np.sqrt(1.0 - r2[keep] ** 2)
        s = m2 >= MU_MIN
        cols = np.where(k == kk)[0]
        a[cols] = np.linalg.lstsq(claret_basis(m2[s]), 1.0 - P[keep][s][:, cols], rcond=None)[0].T
    return a, F


def build_bins(edges, log=sys.stderr):
    """A[iT, iG, iZ, bin, 4], lnF[iT, iG, iZ, bin] (NaN where the table holds no node), and the filled nodes."""
    nb = len(edges) - 1
    low = edges[1:] <= SPLIT
    A = np.full((len(TEFF), len(LOGG), len(FEH), nb, 4), np.nan)
    lnF = np.full((len(TEFF), len(LOGG), len(FEH), nb), np.nan)
    filled = {}
    for dataset, sel in (("vis-lowres", low), ("visir-lowres", ~low)):
        W, have = None, set()
        for i, t in enumerate(TEFF):
            for j, g in enumerate(LOGG):
                for k, z in enumerate(FEH):
                    p = os.path.join(cache_dir(dataset), zdir(z), fname(dataset, t, g, z))
                    if not wanted(t, g) or not os.path.exists(p):
                        continue
                    if W is None:
                        W = bin_weights(read_specint(p)[0], edges[np.r_[np.where(sel)[0], np.where(sel)[0][-1] + 1]])
                    a, F = fit_bins(p, W)
                    A[i, j, k, sel], lnF[i, j, k, sel] = a, np.log(F)
                    have.add((i, j, k))
        if len(have) < 400:
            raise SystemExit(f"{dataset}: only {len(have)} model files in {cache_dir(dataset)}; run tools/build_ld_table.py first, it downloads them")
        # models missing on the server: fill along Teff from the neighbouring nodes (linear)
        filled[dataset] = []
        for j, g in enumerate(LOGG):
            for k, z in enumerate(FEH):
                hv = [i for i in range(len(TEFF)) if (i, j, k) in have]
                for i, t in enumerate(TEFF):
                    if (i, j, k) in have or not hv or not wanted(t, g):
                        continue
                    filled[dataset].append([t, g, z])
                    x = [TEFF[q] for q in hv]
                    for b in np.where(sel)[0]:
                        lnF[i, j, k, b] = np.interp(t, x, lnF[hv, j, k, b])
                        for n in range(4):
                            A[i, j, k, b, n] = np.interp(t, x, A[hv, j, k, b, n])
        print(f"{dataset}: {len(have)} models, {int(sel.sum())} bins, {len(filled[dataset])} nodes filled", file=log)
    return A, lnF, filled


# ---- compression ----------------------------------------------------------------------------------
# Profile coordinates: c = ROT a with ROT from the QR factorisation of the Claret basis on NG points evenly spaced in
# radius between the centre and mu = MU_MIN, so that |c|^2 is the mean square of 1 - I(mu) on those points.
NG = 60
MU_G = np.sqrt(1.0 - (np.sqrt(1.0 - MU_MIN ** 2) * np.arange(NG) / (NG - 1)) ** 2)
ROT = np.linalg.qr(claret_basis(MU_G) / np.sqrt(NG))[1]
ROT_INV = np.linalg.inv(ROT)


def b64(a):
    return base64.b64encode(np.asarray(a, dtype="<i2").tobytes()).decode("ascii")


def compress(A, lnF, ncomp):
    """Returns the table's numeric part and the reconstruction (A2, lnF2) it decodes to."""
    held = np.isfinite(lnF[..., 0])
    nb = lnF.shape[-1]
    X = np.concatenate([A[held] @ ROT.T, LNF_SCALE * lnF[held][..., None]], -1).reshape(held.sum(), nb * 5)   # [node, bin * 5]
    mean = X.mean(0)
    U, S, Vt = np.linalg.svd(X - mean, full_matrices=False)
    sv = S / np.sqrt(len(X))                                                 # rms amplitude of each component
    scores, basis = U[:, :ncomp] * S[:ncomp], Vt[:ncomp]
    q = lambda v, top: (float(np.abs(v).max()) / top) or 1.0
    ms, bs, ss = q(mean, 32767), q(basis, 32767), [q(scores[:, c], 32000) for c in range(ncomp)]
    mi, bi, si = np.rint(mean / ms), np.rint(basis / bs), np.rint(scores / ss)
    Xq = mi * ms + (si * ss) @ (bi * bs)
    full = np.full(held.shape + (ncomp,), MISSING, dtype=float)
    full[held] = si
    A2, lnF2 = np.full(A.shape, np.nan), np.full(lnF.shape, np.nan)
    Xq = Xq.reshape(held.sum(), nb, 5)
    A2[held], lnF2[held] = Xq[..., :4] @ ROT_INV.T, Xq[..., 4] / LNF_SCALE
    part = {"ncomp": ncomp, "meanScale": ms, "mean16": b64(mi), "basisScale": bs, "basis16": b64(bi.ravel()), "scoreScale": ss, "scores16": b64(full.ravel())}
    return part, A2, lnF2, sv, X, mean, U, S, Vt


def profile_rms(A, A2):
    """rms over mu in [0.1, 1] (even in radius) of the difference of two sets of Claret profiles, per profile."""
    return np.sqrt((((A - A2) @ ROT.T) ** 2).sum(-1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "data", "ld_spectral.js"))
    ap.add_argument("--res", type=float, default=RES, help="bins are about lambda / res wide")
    ap.add_argument("--ncomp", type=int, default=NCOMP, help="principal components kept")
    ap.add_argument("--explore", action="store_true", help="print the truncation error for several numbers of components")
    args = ap.parse_args()

    t0 = time.time()
    edges = make_edges(args.res)
    A, lnF, filled = build_bins(edges)
    held = np.isfinite(lnF[..., 0])
    nb = len(edges) - 1
    part, A2, lnF2, sv, X, mean, U, S, Vt = compress(A, lnF, args.ncomp)

    # what the compression costs, per bin and for a few broad bands (weights: bin overlap times F), over all nodes
    def band(Ax, lnFx, lo, hi):
        w = np.clip((np.minimum(edges[1:], hi) - np.maximum(edges[:-1], lo)) / np.diff(edges), 0, 1) * np.exp(lnFx[held] - lnFx[held].max(-1, keepdims=True))
        return (w[..., None] * Ax[held]).sum(-2) / w.sum(-1)[..., None]
    bands = {"300-400": (300, 400), "400-550": (400, 550), "550-700": (550, 700), "600-1000": (600, 1000), "1100-1700": (1100, 1700), "2000-2400": (2000, 2400), "2900-5100": (2900, 5100), "600-5300": (600, 5300)}
    def report(tag, Ax, lnFx):
        e = profile_rms(A[held], Ax[held])
        cool = np.array([t < 3000 for t in TEFF])[np.where(held)[0]]
        red = edges[:-1] >= 300
        eb = {n: profile_rms(band(A, lnF, *r), band(Ax, lnFx, *r)) for n, r in bands.items()}
        print(f"{tag}: per bin I(mu) rms: median {np.median(e):.1e}, 99% {np.percentile(e, 99):.1e}, max {e.max():.1e}"
              f" (>= 300 nm and Teff >= 3000 K: 99% {np.percentile(e[~cool][:, red], 99):.1e}, max {e[~cool][:, red].max():.1e});"
              f" ln F rms {np.sqrt(np.mean((lnF[held] - lnFx[held]) ** 2)):.1e}; broad bands worst "
              + ", ".join(f"{n} {v.max():.1e}" for n, v in eb.items()), file=sys.stderr)
    if args.explore:
        for kc in (8, 16, 24, 32, 48, 64, 96):
            _, Ak, Lk = compress(A, lnF, kc)[:3]
            report(f"K = {kc:2d}", Ak, Lk)
    report(f"stored (K = {args.ncomp}, int16)", A2, lnF2)

    table = {
        "format": "esl-ld-spectral-1",
        "source": "PHOENIX-ACES specific intensities (Husser et al. 2013), limb at the steepest gradient per wavelength bin, photon weighted; tools/build_ld_spectral.py",
        "built": time.strftime("%Y-%m-%d"),
        "mu_min": MU_MIN, "teff": TEFF, "logg": LOGG, "feh": FEH,
        "edges": [float(x) for x in edges], "split": SPLIT, "datasets": ["vis-lowres", "visir-lowres"],
        "lnFScale": LNF_SCALE,
        "toClaret": [[float(f"{v:.10g}") for v in row] for row in ROT_INV],
        "order": "x[bin * 5 + j] = (mean16 * meanScale)[bin * 5 + j] + sum_c scores16[((iTeff * nLogg + iLogg) * nFeh + iFeh) * ncomp + c] * scoreScale[c] * (basis16 * basisScale)[c * nBins * 5 + bin * 5 + j]; "
                 "j < 4: profile coordinates c, Claret a = toClaret c; j = 4: lnFScale * ln F (F: photon-weighted centre intensity summed over the bin). "
                 "All arrays little-endian int16, base64; scores of -32768 mark a node the table does not hold",
        "note": f"log g {LOGG[-1]} only for Teff <= {LOGG55_TEFF_MAX} K",
        "filled": filled,
        **part,
    }
    body = json.dumps(table, separators=(",", ":"))
    js = ("// Generated by tools/build_ld_spectral.py; do not edit by hand.\n"
          "// Limb darkening per wavelength bin (200-5500 nm) and stellar model, as a mean plus principal components (int16).\n"
          "// Pure data: expandSpectral() in src/core/ldspec.js decodes it. Import it lazily (dynamic import).\n"
          "export const LD_SPECTRAL_COMPACT = " + body + ";\n")
    with open(args.out, "w") as fh:
        fh.write(js)
    import gzip
    print(f"wrote {args.out}: {len(js) / 1024:.0f} kB ({len(gzip.compress(js.encode(), 9)) / 1024:.0f} kB gzipped), {nb} bins {edges[0]:g}-{edges[-1]:g} nm, "
          f"{int(held.sum())} nodes, {args.ncomp} components, {time.time() - t0:.0f} s", file=sys.stderr)


if __name__ == "__main__":
    main()
