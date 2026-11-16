"""References for test/spectroscopy.test.mjs (time-series spectroscopy, src/core/spectroscopy.js).

    .venv-validation/bin/python test/make_spectroscopy_reference.py            # astropy, batman, scipy, numpy
    .venv-plan/bin/python       test/make_spectroscopy_reference.py --published <file.nc>   # h5py only

Writes
    test/data/spec_x1dints_rows.fits   synthetic x1dints, layout "one row per integration" (pipeline >= 1.17)
    test/data/spec_x1dints_exts.fits   synthetic x1dints, layout "one extension per integration", two orders, a segment
    test/data/spec_long.ecsv           a long-format cube written by astropy (time, wavelength, flux, flux_err)
    test/data/spec_batman_cube.csv     injection test: channel light curves made with batman (Kreidberg 2015)
    test/spectroscopy_reference.json   every number the test compares with
    test/spectroscopy_jwst_reference.json   what astropy reads from the real JWST files, when they are present
and, with --published,
    test/spectroscopy_wasp39_published.json   the published G395H spectrum of WASP-39 b

Real data (not in the repository: 207 MB). Public, no credentials:
    JWST ERS program 1366, observation 3: WASP-39 b, NIRSpec G395H/F290LP, BOTS, 465 integrations, 2022-07-30
    https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:JWST/product/<name>
    <name> = jw01366003001_04101_00001-seg00{1,2,3}_nrs{1,2}_x1dints.fits     -> test/data/jwst/
    (as served in November 2026: CAL_VER 3.0.0, 27.8 MB per NRS1 segment, 44.7 MB per NRS2 segment)
Published spectrum:
    Alderson et al. 2023, Nature 614, 664, doi:10.1038/s41586-022-05591-3; data products doi:10.5281/zenodo.7185300
    https://zenodo.org/api/records/7185300/files/G395H_paper_data.zip/content   (29.7 MB), inside it
    G395H_paper_data/3_TRANSMISSION_SPECTRA/transit-spectrum-W39b-G395H-10pix_weighted-average.nc
"""
import json, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def published(path):
    import h5py
    f = h5py.File(path, "r")
    out = {
        "source": "Alderson et al. 2023, Nature 614, 664 (doi:10.1038/s41586-022-05591-3); Zenodo doi:10.5281/zenodo.7185300, "
                  "3_TRANSMISSION_SPECTRA/transit-spectrum-W39b-G395H-10pix_weighted-average.nc "
                  "(weighted mean of the reductions, 10-pixel bins)",
        "wavelength_um": [float(x) for x in f["central_wavelength"][()]],
        "half_width_um": [float(x) for x in f["bin_half_width"][()]],
        "depth": [float(x) for x in f["transit_depth"][()]],
        "depth_err": [float(x) for x in f["transit_depth_error"][()]],
    }
    json.dump(out, open(os.path.join(HERE, "spectroscopy_wasp39_published.json"), "w"))
    print("wrote spectroscopy_wasp39_published.json", len(out["depth"]), "bins")


if "--published" in sys.argv:
    published(sys.argv[sys.argv.index("--published") + 1])
    sys.exit(0)

import batman
from astropy.io import fits
from astropy.table import Table
from astropy import constants as const, units as u
from scipy import integrate

rng = np.random.default_rng(20261115)
ref = {}

# ---------------------------------------------------------------------------------------------
# 1. synthetic x1dints, both layouts
def int_times(nums, t_mid_mjd, dt):
    c = [fits.Column("integration_number", "J", array=np.array(nums, dtype=np.int32))]
    for nm, arr in [("int_start_MJD_UTC", t_mid_mjd - dt / 2 - 0.0007), ("int_mid_MJD_UTC", t_mid_mjd - 0.0007), ("int_end_MJD_UTC", t_mid_mjd + dt / 2 - 0.0007),
                    ("int_start_BJD_TDB", t_mid_mjd - dt / 2), ("int_mid_BJD_TDB", t_mid_mjd), ("int_end_BJD_TDB", t_mid_mjd + dt / 2)]:
        c.append(fits.Column(nm, "D", array=arr))
    return fits.BinTableHDU.from_columns(c, name="INT_TIMES")


def primary(**kw):
    h = fits.PrimaryHDU()
    for k, v in {**dict(TELESCOP="JWST", INSTRUME="NIRSPEC", DETECTOR="NRS1", GRATING="G395H", FILTER="F290LP", EXP_TYPE="NRS_BRIGHTOBJ", TARGPROP="SYNTHETIC-1",
                        EFFINTTM=63.14, NINTS=24, TARG_RA=217.3266, TARG_DEC=-3.4445, CAL_VER="3.0.0"), **kw}.items():
        h.header[k] = v
    return h


# layout A: one row per integration, vector columns; wavelengths padded with NaN at the end; two NaN fluxes; DQ bits
nT, nW = 24, 40
wave = np.full(nW, np.nan); wave[:37] = np.linspace(2.9, 3.7, 37)
tA = 59790.92 + np.arange(nT) * (63.14 + 0.9) / 86400
fluxA = 0.03 * (1 + 0.2 * np.sin(np.arange(nW) / 5.0))[None, :] * (1 + 1e-3 * rng.standard_normal((nT, nW)))
errA = np.abs(fluxA) * 1e-3 * (1 + 0.1 * rng.random((nT, nW)))
fluxA[:, 37:] = np.nan; errA[:, 37:] = np.nan
fluxA[3, 5] = np.nan; fluxA[17, 30] = np.nan
dqA = np.zeros((nT, nW), dtype=np.uint32); dqA[5, 7] = 1; dqA[6, 8] = 4; dqA[9, 12] = 1 + 16
cols = [fits.Column("INT_NUM", "J", array=np.arange(1, nT + 1, dtype=np.int32)),
        fits.Column("WAVELENGTH", f"{nW}D", unit="um", array=np.tile(wave, (nT, 1))),
        fits.Column("FLUX", f"{nW}D", unit="Jy", array=fluxA), fits.Column("FLUX_ERROR", f"{nW}D", unit="Jy", array=errA),
        fits.Column("SURF_BRIGHT", f"{nW}D", unit="MJy/sr", array=fluxA * 1e3), fits.Column("SB_ERROR", f"{nW}D", unit="MJy/sr", array=errA * 1e3),
        fits.Column("DQ", f"{nW}J", bzero=2147483648, array=dqA),
        fits.Column("N_ALONGDISP", "J", array=np.full(nT, 37, dtype=np.int32)),
        fits.Column("TDB-MID", "D", unit="d", array=tA)]
ex = fits.BinTableHDU.from_columns(cols, name="EXTRACT1D"); ex.header["SPORDER"] = -1
fits.HDUList([primary(INTSTART=1, INTEND=nT, EXSEGNUM=1, EXSEGTOT=1), int_times(range(1, nT + 1), tA, 63.14 / 86400), ex]).writeto(os.path.join(DATA, "spec_x1dints_rows.fits"), overwrite=True)
good = np.isfinite(fluxA[:, :37]) & (dqA[:, :37] % 2 == 0)
ref["rows"] = {"nT": nT, "nW": 37, "time": (tA + 2400000.5).tolist(), "wave": wave[:37].tolist(), "flux_row2": fluxA[2, :37].tolist(), "err_row2": errA[2, :37].tolist(),
               "n_bad": int((~good).sum()), "bad": [[int(i), int(j)] for i, j in zip(*np.where(~good))], "sum_good": float(fluxA[:, :37][good].sum())}

# layout B: one extension per integration, two spectral orders, wavelengths DESCENDING, a segment starting at integration 5
nTB, nWB = 6, 30
tB = 59800.10 + np.arange(4, 4 + nTB) * 80.0 / 86400
hdus = [primary(INSTRUME="NIRISS", DETECTOR="NIS", GRATING="GR700XD", FILTER="CLEAR", EXP_TYPE="NIS_SOSS", INTSTART=5, INTEND=10, EXSEGNUM=2, EXSEGTOT=3, EFFINTTM=76.9),
        int_times(range(5, 11), tB, 76.9 / 86400)]
refB = {}
for i in range(nTB):
    for order, (w0, w1) in ((1, (2.8, 0.9)), (2, (1.4, 0.6))):
        w = np.linspace(w0, w1, nWB)
        fl = 5e4 * order * (1 + 0.1 * np.cos(w * 3)) * (1 + 2e-3 * rng.standard_normal(nWB)); er = np.abs(fl) * 2e-3
        dq = np.zeros(nWB, dtype=np.uint32)
        if i == 2 and order == 1: dq[4] = 1
        h = fits.BinTableHDU.from_columns([fits.Column("WAVELENGTH", "D", unit="um", array=w), fits.Column("FLUX", "D", unit="Jy", array=fl), fits.Column("FLUX_ERROR", "D", unit="Jy", array=er),
                                           fits.Column("DQ", "J", bzero=2147483648, array=dq), fits.Column("NPIXELS", "D", array=np.full(nWB, 30.0))], name="EXTRACT1D")
        h.header["SPORDER"] = order; h.header["EXTVER"] = i + 1
        hdus.append(h)
        refB.setdefault(str(order), {"wave": w[::-1].tolist(), "flux": []})["flux"].append(fl[::-1].tolist())
fits.HDUList(hdus).writeto(os.path.join(DATA, "spec_x1dints_exts.fits"), overwrite=True)
ref["exts"] = {"nT": nTB, "nW": nWB, "time": (tB + 2400000.5).tolist(), "orders": refB, "bad_order1": [[2, nWB - 1 - 4]]}

# a long-format ECSV written by astropy
tt, ww = np.meshgrid(2459800.5 + np.arange(5) * 0.001, np.array([1.1, 1.5, 2.0]), indexing="ij")
fl = 1000 * ww * (1 + 0.01 * np.arange(15).reshape(5, 3)); er = np.sqrt(fl)
Table({"time": tt.ravel(), "wavelength": ww.ravel(), "flux": fl.ravel(), "flux_err": er.ravel()}).write(os.path.join(DATA, "spec_long.ecsv"), format="ascii.ecsv", overwrite=True)
ref["long"] = {"time": tt[:, 0].tolist(), "wave": ww[0].tolist(), "flux": fl.tolist(), "err": er.tolist()}

# ---------------------------------------------------------------------------------------------
# 2. linear regressors integrated out: analytic (numpy) and brute-force numerical integration (scipy)
def bat(t, rprs, ars, inc, per, t0, u, exp=0.0, n=1):
    p = batman.TransitParams(); p.t0 = t0; p.per = per; p.rp = rprs; p.a = ars; p.inc = inc; p.ecc = 0.0; p.w = 90.0; p.limb_dark = "quadratic"; p.u = list(u)
    m = batman.TransitModel(p, t, supersample_factor=n, exp_time=exp) if n > 1 else batman.TransitModel(p, t)
    return m.light_curve(p)


sysv = dict(rprs=0.12, ars=9.5, inc=87.2, per=3.3, t0=0.013, u=[0.35, 0.2])
t = np.linspace(-0.13, 0.13, 160)
x1 = (t - 0.5 * (t[0] + t[-1])) / (0.5 * (t[-1] - t[0])); x2 = np.where(t < 0.031, -0.5, 0.5)
sig = 4e-4
m0 = bat(t, **sysv)
f = m0 * (1.0007 + 0.002 * x1 - 0.003 * x2) + sig * rng.standard_normal(t.size); e = np.full(t.size, sig)
cases = []
for rp in (0.12, 0.1185, 0.123):
    m = bat(t, **{**sysv, "rprs": rp})
    G = np.stack([m, m * x1, m * x2], axis=1); W = 1 / e**2
    A = (G * W[:, None]).T @ G; b = (G * W[:, None]).T @ f
    beta = np.linalg.solve(A, b); chi2 = float(np.sum(W * (f - G @ beta) ** 2))
    lnnorm = -0.5 * np.sum(np.log(2 * np.pi * e**2))
    analytic = lnnorm - 0.5 * chi2 + 0.5 * (3 * np.log(2 * np.pi) - np.linalg.slogdet(A)[1]) - np.log(2.0) - 2 * np.log(2.0)
    # brute force: integrate exp(-(chi2(beta) - chi2_min)/2) over a box of +-9 sigma around the optimum
    sd = np.sqrt(np.diag(np.linalg.inv(A)))
    integrand = lambda c2, c1, a1: np.exp(-0.5 * (np.sum(W * (f - G @ np.array([a1, c1, c2])) ** 2) - chi2))
    val, err = integrate.tplquad(integrand, beta[0] - 9 * sd[0], beta[0] + 9 * sd[0], beta[1] - 9 * sd[1], beta[1] + 9 * sd[1], beta[2] - 9 * sd[2], beta[2] + 9 * sd[2], epsabs=0, epsrel=1e-7)
    brute = lnnorm - 0.5 * chi2 + np.log(val) - 3 * np.log(2.0)
    cases.append({"rprs": rp, "lnL_analytic": float(analytic), "lnL_brute": float(brute), "beta": beta.tolist(), "chi2": chi2, "model": m.tolist()})
    print("regressors rprs", rp, "analytic", analytic, "brute", brute, "diff", analytic - brute)
ref["regressors"] = {"system": {**sysv, "tmid": sysv["t0"]}, "t": t.tolist(), "f": f.tolist(), "e": e.tolist(), "x1": x1.tolist(), "x2": x2.tolist(), "cases": cases,
                     "prior_widths": {"a1": 2.0, "c": 2.0}}

# ---------------------------------------------------------------------------------------------
# 3. photon rate of a black-body star (scipy quad), scale height (astropy constants)
def photon_rate(teff, rstar, dist_pc, lo, hi):
    h, c, k = const.h.value, const.c.value, const.k_B.value
    fn = lambda l: 2 * c / l**4 / np.expm1(h * c / (l * k * teff))
    val, _ = integrate.quad(fn, lo * 1e-6, hi * 1e-6, epsrel=1e-12)
    return np.pi * (rstar * const.R_sun.value / (dist_pc * const.pc.value)) ** 2 * val


ref["photon"] = [{"teff": T, "rstar": R, "distance": d, "lo": lo, "hi": hi, "rate": float(photon_rate(T, R, d, lo, hi))}
                 for T, R, d, lo, hi in [(5400, 0.9, 215, 0.5, 0.6), (5400, 0.9, 215, 1.95, 3.9), (3300, 0.3, 12.0, 3.9, 7.8), (6100, 1.2, 50.0, 0.6, 5.3)]]
g = (const.G * 0.281 * const.M_jup / (1.279 * const.R_jup) ** 2).to(u.m / u.s**2).value
H = (const.k_B * 1100 * u.K / (2.3 * const.u * g * u.m / u.s**2)).to(u.m).value
ref["scale_height"] = {"teq": 1100, "mu": 2.3, "mplanet": 0.281, "rplanet": 1.279, "rstar": 0.939, "g": float(g), "H": float(H),
                       "depth_per_H": float(2 * H * 1.279 * const.R_jup.value / (0.939 * const.R_sun.value) ** 2)}

# ---------------------------------------------------------------------------------------------
# 4. injection: channel light curves from batman
geo = dict(ars=11.4, inc=87.8, per=4.0552941, t0=2459791.612)
wl_edges = np.geomspace(0.6, 5.0, 37); lo, hi = wl_edges[:-1], wl_edges[1:]; wl = 0.5 * (lo + hi)
depth = 0.021 - 3e-4 * np.log(wl) + 8e-4 * np.exp(-0.5 * ((wl - 4.3) / 0.2) ** 2) + 5e-4 * np.exp(-0.5 * ((wl - 1.4) / 0.1) ** 2)
u1 = 0.5 - 0.08 * wl; u2 = 0.2 - 0.02 * wl
cad = 60.0 / 86400; tI = geo["t0"] - 0.16 + (np.arange(460) + 0.5) * cad
level = 2.0e6 / wl; sigma = (250 + 120 * wl) * 1e-6
tau = (tI - 0.5 * (tI[0] + tI[-1])) / (0.5 * (tI[-1] - tI[0]))
F = np.zeros((tI.size, wl.size)); E = np.zeros_like(F); clean = []
for j in range(wl.size):
    m = bat(tI, np.sqrt(depth[j]), geo["ars"], geo["inc"], geo["per"], geo["t0"], [u1[j], u2[j]], exp=cad, n=7)
    clean.append(m)
    F[:, j] = level[j] * (m * (1 + 2e-4 * (wl[j] - 2.0) * tau) + sigma[j] * rng.standard_normal(tI.size)); E[:, j] = level[j] * sigma[j]
with open(os.path.join(DATA, "spec_batman_cube.csv"), "w") as fh:
    fh.write("time," + ",".join(f"f_{w:.8f}" for w in wl) + "," + ",".join(f"e_{w:.8f}" for w in wl) + "\n")
    for i in range(tI.size):
        fh.write(f"{tI[i]:.7f}," + ",".join(f"{x:.9g}" for x in F[i]) + "," + ",".join(f"{x:.6g}" for x in E[i]) + "\n")
ref["injection"] = {"geometry": {**geo, "tmid": geo["t0"]}, "lo": lo.tolist(), "hi": hi.tolist(), "wl": wl.tolist(), "depth": depth.tolist(), "u1": u1.tolist(), "u2": u2.tolist(),
                    "sigma": sigma.tolist(), "level": level.tolist(), "cadence_s": 60.0, "supersample": 7, "clean_channel": 20, "clean": clean[20].tolist(), "clean_instant": bat(tI, np.sqrt(depth[20]), geo["ars"], geo["inc"], geo["per"], geo["t0"], [u1[20], u2[20]]).tolist(),
                    "white_u": [float(np.sum(level * u1) / np.sum(level)), float(np.sum(level * u2) / np.sum(level))]}

# ---------------------------------------------------------------------------------------------
# 5. the ECSV this code writes, read back by astropy
js = ("import { spectrumToECSV } from './src/core/spectroscopy.js';"
      "const rows = [0, 1, 2, 3].map((k) => ({ wl: 1 + 0.5 * k, lo: 0.75 + 0.5 * k, hi: 1.25 + 0.5 * k, depth: 0.021 + 1e-4 * k, plus: 5.1e-5 + 1e-6 * k, minus: 4.9e-5, rms: 3e-4, expected: 2.9e-4, beta: k === 2 ? NaN : 1.1 + 0.1 * k }));"
      "process.stdout.write(spectrumToECSV(rows, { target: \"WASP-39 b\", kind: 'transit', channels: 4, note: \"it's a test\" }));")
text = subprocess.run(["node", "--input-type=module", "-e", js], cwd=os.path.dirname(HERE), capture_output=True, text=True, check=True).stdout
tmp = os.path.join(DATA, "_spec_tmp.ecsv"); open(tmp, "w").write(text)
tab = Table.read(tmp, format="ascii.ecsv"); os.remove(tmp)
ref["ecsv"] = {"text": text, "columns": tab.colnames, "units": {c: str(tab[c].unit) for c in tab.colnames if tab[c].unit is not None},
               "depth": [float(x) for x in tab["depth"]], "wavelength": [float(x) for x in tab["wavelength"]], "beta_nan_row": int(np.where(np.isnan(tab["beta"]))[0][0]),
               "meta": {k: (v if isinstance(v, (int, float, str, bool)) else str(v)) for k, v in tab.meta.items()}}
print("ecsv read by astropy:", tab.colnames, dict(tab.meta))

json.dump(ref, open(os.path.join(HERE, "spectroscopy_reference.json"), "w"))
print("wrote spectroscopy_reference.json")

# ---------------------------------------------------------------------------------------------
# 6. the real JWST files, when present
jw = os.path.join(DATA, "jwst")
names = [f"jw01366003001_04101_00001-seg00{s}_{d}_x1dints.fits" for d in ("nrs1", "nrs2") for s in (1, 2, 3)]
if all(os.path.exists(os.path.join(jw, n)) for n in names):
    out = {}
    for n in names:
        hd = fits.open(os.path.join(jw, n)); d = hd["EXTRACT1D"].data; fl = np.asarray(d["FLUX"], dtype=float); dq = np.asarray(d["DQ"]).astype(np.int64); w = np.asarray(d["WAVELENGTH"][0], dtype=float)
        bad = ~np.isfinite(fl) | (dq % 2 == 1) | ~(np.asarray(d["FLUX_ERROR"], dtype=float) > 0)
        out[n] = {"nrows": int(len(d)), "nwave": int(fl.shape[1]), "time_first": float(d["TDB-MID"][0] + 2400000.5), "time_last": float(d["TDB-MID"][-1] + 2400000.5),
                  "int_mid_first": float(hd["INT_TIMES"].data["int_mid_BJD_TDB"][0] + 2400000.5), "wave_first": float(w[0]), "wave_last": float(w[-1]),
                  "flux_100_600": float(fl[100, 600]), "err_100_600": float(d["FLUX_ERROR"][100, 600]), "n_bad": int(bad.sum()), "sum_good_row100": float(fl[100][~bad[100]].sum()),
                  "cal_ver": hd[0].header["CAL_VER"], "effinttm": float(hd[0].header["EFFINTTM"]), "int_num": [int(d["INT_NUM"][0]), int(d["INT_NUM"][-1])]}
    json.dump(out, open(os.path.join(HERE, "spectroscopy_jwst_reference.json"), "w"), indent=1)
    print("wrote spectroscopy_jwst_reference.json")
else:
    print("real JWST files not in test/data/jwst: skipped (see the URLs at the top of this file)")
