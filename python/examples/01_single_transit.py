"""A single transit: EXOTIC's examples/single_transit/transit_fit_example.py.

The data are the seeded light curve EXOTIC's `lc_fitter` was run on (test/exotic_fits.json, written by
test/make_exotic_fits.py), so the posterior can be compared with EXOTIC's own.

Should print (README, "EXOTIC's examples, reproduced"):
    single_transit   posterior against EXOTIC's lc_fitter on the same data
                     means within 0.25 sigma, widths within 15%; about 1 to 2 s against 8 s
"""
import json
import time

import numpy as np

import esl
from _common import Checks, figures_wanted, repo

check = Checks()
X = json.loads((repo() / "test" / "exotic_fits.json").read_text())["single"]
truth = {**X["prior"], "rprs": 0.02, "tmid": 0.75, "inc": 88.5}          # EXOTIC's fitter overwrites its prior with the best fit
norm = float(np.median(X["flux"]))                                       # the example's flux is in counts (a1 = 50)

session = esl.Session(
    name="single transit",
    limb_darkening=esl.LimbDarkening(law="nonlinear", coefficients=[truth["u0"], truth["u1"], truth["u2"], truth["u3"]]),
    planets=[esl.Planet(letter="b", parameters={k: truth[k] for k in ("rprs", "ars", "inc", "per", "tmid", "ecc", "omega")})],
    data=esl.Data(light_curve=esl.LightCurve(name="simulated", time=X["t"], flux=np.array(X["flux"]) / norm, flux_err=np.array(X["err"]) / norm)),
    fit=esl.FitSettings(
        free=[esl.FreeParameter(key=k, prior=esl.Prior.uniform(max(lo, 1e-4), hi)) for k, (lo, hi) in X["bounds"].items()],
        sampler=esl.Sampler(nlive=400, seed=5)),
)
print(session.summary())
t0 = time.time()
fit = session.run(progress=True)
seconds = time.time() - t0
r = fit.result
print(r.table())

worst_mean = worst_width = 0.0
for key in session.free_keys:
    col = r.samples.column(key)
    mean, sd, em, es = col.mean(), col.std(), X["posterior_mean"][key], X["errors"][key]
    print(f"  {key}: ESL {mean:.6g} +- {sd:.3g} | EXOTIC {em:.6g} +- {es:.3g} | truth {truth[key]}")
    worst_mean, worst_width = max(worst_mean, abs(mean - em) / es), max(worst_width, abs(sd / es - 1))
    check(f"{key} within 3 sigma of the injected value", abs(mean - truth[key]) < 3 * sd)
check("posterior means within 0.25 sigma of EXOTIC's", worst_mean < 0.25, f"largest {worst_mean:.2f} sigma")
check("posterior widths within 15% of EXOTIC's", worst_width < 0.15, f"largest {100 * worst_width:.0f}%")
check("converged, faster than EXOTIC", r.converged and seconds < X["seconds"], f"{r.ncalls} calls in {seconds:.1f} s; EXOTIC {X['ncall']} calls in {X['seconds']:.0f} s")

out = figures_wanted()
if out:
    import esl.plot
    esl.plot.light_curve(fit).savefig(out / "single_transit_light_curve.png", dpi=150)
    esl.plot.corner(fit, truths={k: truth[k] for k in session.free_keys}).savefig(out / "single_transit_posterior.png", dpi=150)
check.finish()
