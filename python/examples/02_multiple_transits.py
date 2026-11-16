"""Several transits in one fit: EXOTIC's examples/multiple_transit/multi_fit_example.py.

Five simulated nights, each with its own airmass trend; the planet's radius, inclination, mid-transit time and
period are shared. Written with the EXOTIC-style classes: each night is a LightCurveData whose local parameter
a2 (the airmass slope) is free. The data are those EXOTIC's `glc_fitter` was run on (test/exotic_fits.json).

Should print (README, "EXOTIC's examples, reproduced"):
    multiple_transit   five nights with airmass, nine parameters, against glc_fitter
                       means within 0.11 sigma, widths within 5%; about 3 to 4 s against 57 s
"""
import json
import time

import numpy as np

from esl import multi_fitter as m
from _common import Checks, figures_wanted, repo

check = Checks()
X = json.loads((repo() / "test" / "exotic_fits.json").read_text())["multiple"]
tr = X["truth"]

planet = m.SystemParameters(rprs=tr["rprs"], ars=tr["ars"], per=tr["per"], inc=tr["inc"], tmid=tr["tmid"], ecc=0, omega=0,
                            u0=tr["ld"][0], u1=tr["ld"][1], u2=tr["ld"][2], u3=tr["ld"][3])
lo, hi = {k: max(v[0], 1e-4) for k, v in X["bounds"].items()}, {k: v[1] for k, v in X["bounds"].items()}
nights = []
for d in X["sets"]:
    norm = float(np.median(d["flux"]))
    lc = m.LightCurveData(time=d["t"], name=f"epoch {d['epoch']}", flux=np.array(d["flux"]) / norm, ferr=np.array(d["err"]) / norm, airmass=d["airmass"])
    lc.local = m.ParameterSet(a2=1)                                                    # free for this night
    lc.local_bounds = m.Bounds(upper=m.ParameterSet(a2=X["local_bounds"]["a2"][1]), lower=m.ParameterSet(a2=X["local_bounds"]["a2"][0]))
    nights.append(lc)

system = m.MultiPlanetSystem(
    name="multiple transits", planets={"b": planet}, free={"b": m.ParameterSet(**{k: 1 for k in X["bounds"]})},
    bounds={"b": m.Bounds(upper=m.ParameterSet(**hi), lower=m.ParameterSet(**lo))}, transit=nights,
    kepler=False)                                                                      # the example holds a/R* at its value

t0 = time.time()
fit = m.MultiPlanetFit(system, live=400, seed=6)
seconds = time.time() - t0

exotic = dict(zip(X["paramnames"], zip(X["posterior_mean"], X["posterior_stdev"])))
truth = {f"b_{k}": tr[k] for k in X["bounds"]} | {f"epoch {d['epoch']}_a2": d["a2"] for d in X["sets"]}
theirs = {f"b_{k}": exotic[k] for k in X["bounds"]} | {f"epoch {d['epoch']}_a2": exotic[f"local_a2_{i}"] for i, d in enumerate(X["sets"])}
pts = fit.results["samples"]
worst_mean = worst_width = 0.0
for i, key in enumerate(fit.freekeys):
    mean, sd, (em, es) = pts[:, i].mean(), pts[:, i].std(), theirs[key]
    print(f"  {key}: ESL {mean:.7g} +- {sd:.3g} | EXOTIC {em:.7g} +- {es:.3g} | truth {truth[key]:.6g}")
    worst_mean, worst_width = max(worst_mean, abs(mean - em) / es), max(worst_width, abs(sd / es - 1))
    check(f"{key} within 3.5 sigma of the injected value", abs(mean - truth[key]) < 3.5 * sd)
check("nine free parameters", len(fit.freekeys) == 9)
check("posterior means within 0.3 sigma of EXOTIC's", worst_mean < 0.3, f"largest {worst_mean:.2f} sigma")
check("posterior widths within 20% of EXOTIC's", worst_width < 0.2, f"largest {100 * worst_width:.0f}%")
check("converged, faster than EXOTIC", fit.result.converged and seconds < X["seconds"], f"{fit.result.ncalls} calls in {seconds:.1f} s; EXOTIC {X['ncall']} calls in {X['seconds']:.0f} s")
check("each night has its model, residuals at the noise level, and its own normalisation",
      all(len(n.model) == len(n.flux) and 0.7 < n.resid_std / float(np.median(n.ferr)) < 1.3 for n in nights) and len({round(n.scale, 6) for n in nights}) == 5,
      ", ".join(f"{n.name}: scale {n.scale:.3f}" for n in nights))

out = figures_wanted()
if out:
    fit.plot_lightcurves().savefig(out / "multiple_transits_nights.png", dpi=150)
    fit.plot_lightcurves(fold=True).savefig(out / "multiple_transits_folded.png", dpi=150)
    fit.plot_posterior(truths=truth).savefig(out / "multiple_transits_posterior.png", dpi=150)
check.finish()
