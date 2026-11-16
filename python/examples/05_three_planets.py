"""Three planets, TESS + NEID: EXOTIC's examples/multi_planet/multi_fit.py, almost line for line.

toy-1873 is modelled on TOI-1873: three transiting planets, three TESS-style transit windows and 40 NEID-style
velocities. EXOTIC's default for this toy: the three masses, the stellar trend and the jitter are free, the
ephemerides are held. Only the import differs from EXOTIC's script.

Should print (README, "EXOTIC's examples, reproduced"):
    multi_planet   chi2 of the three light-curve files and of the velocities at the injected truth:
                   45.11, 88.80, 190.58, 37.58 (identical to EXOTIC's to two decimals)
    multi_planet   joint fit against EXOTIC's stored fit: widths within 15%, best fit within 0.5 sigma;
                   about a second; planet d is an upper limit (95%: 3.6 m/s)
"""
import json

import numpy as np

import esl
from esl import multi_fitter as m            # EXOTIC:  from exotic.api import multi_fitter as m
from _common import Checks, csv, figures_wanted, repo

check = Checks()
ROOT = repo()
datadir = ROOT / "public/examples/toy1873"
truth = json.loads((datadir / "multi_system.json").read_text())
X = json.loads((ROOT / "test" / "exotic_reference.json").read_text())["toy"]

planets = {pkey: m.SystemParameters(**p) for pkey, p in truth["planets"].items()}

fixed = ["per", "tmid", "rprs", "inc"]                    # only the RV-sensitive parameters are free
free = {pkey: m.ParameterSet(**{k: 1 for k in keys if k not in fixed}) for pkey, keys in truth["free"].items()}

bounds = {}                                                # the JSON stores prior bounds as [lo, hi] pairs
for pkey, b in truth["bounds"].items():
    bounds[pkey] = m.Bounds(upper=m.ParameterSet(**{k: v[1] for k, v in b.items()}), lower=m.ParameterSet(**{k: v[0] for k, v in b.items()}))


def load_lc(name):
    df = csv(datadir / f"tess_{name}.csv")
    return m.LightCurveData(time=df["BJD"], name=f"tess_{name}", flux=df["flux"], ferr=df["ferr"], airmass=df["airmass"], exp_time=120.0 / (60 * 24))


def load_rv(name):
    df = csv(datadir / f"rv_{name}.csv")
    return m.RadialVelocityData(time=df["BJD"], name=f"rv_{name}", vel=df["vel"], velerr=df["velerr"])


lcs = [load_lc(p) for p in ("b", "c", "d")]
rv = load_rv("neid")
rv.local = m.ParameterSet(rv_jitter=1)                     # the jitter is fitted on the RV dataset
rv.local_bounds = m.Bounds(upper=m.ParameterSet(rv_jitter=15.0), lower=m.ParameterSet(rv_jitter=0.0))

system = m.MultiPlanetSystem(planets=planets, free=free, bounds=bounds, transit=lcs, radial_velocity=[rv], name="toy-1873")

# ---- chi-square at the injected truth, before fitting
session, keymap = system.to_session()
at_truth = session.evaluate(at={"rvlin": truth["trend"]["rv_linear"], "jit@rv1": truth["noise"]["rv_jitter"]})
L = at_truth.light_curve
chi2 = [float(np.sum((L.residuals[L.epoch == k] / L.flux_err[L.epoch == k]) ** 2)) for k in range(3)] + [at_truth.chi2_parts.radial_velocity]
print("chi2 at the injected truth:", ", ".join(f"{c:.2f}" for c in chi2))
check("chi2 at the truth: 45.11, 88.80, 190.58, 37.58", [round(c, 2) for c in chi2] == [45.11, 88.80, 190.58, 37.58])
check("identical to EXOTIC's to two decimals", [round(c, 2) for c in chi2] == [round(X["lc"][k]["chi2"], 2) for k in ("tess_b", "tess_c", "tess_d")] + [round(X["rv"]["chi2"], 2)])

# ---- the joint fit
fit = m.MultiPlanetFit(system, live=300, seed=42)

E = X["exotic_fit"]
for key in fit.freekeys:
    print(f"  {key}: ESL {fit.parameters[key]:.5f} +- {fit.errors[key]:.5f} | EXOTIC {E['parameters'][key]:.5f} +- {E['errors'][key]:.5f}")
check("best fit within 0.5 sigma of EXOTIC's stored fit", all(abs(fit.parameters[k] - E["parameters"][k]) < 0.5 * E["errors"][k] for k in fit.freekeys))
check("widths within 15% of EXOTIC's", all(abs(fit.errors[k] / E["errors"][k] - 1) < 0.15 for k in fit.freekeys),
      f"largest {100 * max(abs(fit.errors[k] / E['errors'][k] - 1) for k in fit.freekeys):.0f}%")
check("about a second", fit.result.converged and fit.result.seconds < 10, f"{fit.result.ncalls} calls in {fit.result.seconds:.1f} s (EXOTIC: {E['ncall']} calls)")
masses_d = fit.results["samples"][:, fit.freekeys.index("d_mplanet")]
K95 = esl.semi_amplitude(per=planets["d"].per, mplanet=float(np.percentile(masses_d, 95)), mstar=planets["d"].mstar, inc=planets["d"].inc)
check("planet d is an upper limit: 95% of the posterior below 3.6 m/s", abs(K95 - 3.6) < 0.3, f"{K95:.2f} m/s; injected K = {X['K']['d']:.2f} m/s, jitter 2.4 m/s")
inj = {"b_mplanet": truth["planets"]["b"]["mplanet"], "c_mplanet": truth["planets"]["c"]["mplanet"], "d_mplanet": truth["planets"]["d"]["mplanet"],
       "b_rv_linear": truth["trend"]["rv_linear"], "rv_neid_rv_jitter": truth["noise"]["rv_jitter"]}
check("every injected value within 3 sigma", all(abs(fit.results["posterior"]["median"][i] - inj[k]) < 3 * fit.errors[k] for i, k in enumerate(fit.freekeys)))
print("derived:", {p: {k: round(v, 4) for k, v in d.items() if k in ("K", "a", "ars", "T14")} for p, d in fit.derived.items()})
print(f"NEID zero point {rv.offset:.2f} +- {rv.offset_err:.2f} m/s, residual scatter {rv.resid_std:.2f} m/s")

out = figures_wanted()
if out:
    fit.plot_lightcurves().savefig(out / "multi_lc_fit.png", dpi=150)
    fit.plot_lightcurves(fold=True).savefig(out / "multi_lc_folded.png", dpi=150)
    fit.plot_rv().savefig(out / "multi_rv_fit.png", dpi=150)
    fit.plot_rv(fold=True).savefig(out / "multi_rv_phase.png", dpi=150)
    fit.plot_posterior(truths=inj).savefig(out / "multi_posterior.png", dpi=150)
check.finish()
