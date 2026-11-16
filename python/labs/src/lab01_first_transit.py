# %% [markdown]
# # Lab 1 · Your first transit fit
#
# A planet crossing its star blocks a little of its light. In this lab you simulate one night of such a transit,
# describe the system as a **session**, fit it with nested sampling, and read the result: the planet's size, the
# orbit's tilt, the time of mid-transit, and how sure we are of each.
#
# Everything here runs on your computer. Install the package once with
# `pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python"` (add `matplotlib` for the figures).

# %%
import numpy as np
import esl
import esl.plot

print("Exoplanet Science Lab", esl.__version__)

# %% [markdown]
# ## 1. A transit to fit
#
# `esl.transit` is the same light-curve model the website draws. A hot Jupiter with Rp/R★ = 0.14 on a 2.15-day
# orbit, seen through a filter where the star's edge is darker than its centre (quadratic limb darkening), observed
# for 7 hours every 2 minutes with 1500 ppm of noise per point:

# %%
truth = dict(rprs=0.14, ars=8.8, inc=88.0, per=2.15, tmid=0.0)
t = np.arange(-0.15, 0.15, 2 / 1440)                       # days from mid-transit
model = esl.transit(t, dict(truth, ld=[0.40, 0.20], law="quadratic"))
rng = np.random.default_rng(42)
flux = model + rng.normal(0, 0.0015, t.size)
print(f"{t.size} points, transit depth {1e6 * (1 - model.min()):.0f} ppm")

# %% [markdown]
# ## 2. Describe the analysis as a session
#
# A **session** holds everything about an analysis: the star, the planet's parameters, the data, which parameters
# are free and their priors, and the sampler's settings. The same document opens on the website (Analyze → Save /
# Load), so you can move between Python and the browser.
#
# We let three parameters vary: the radius ratio, the inclination and the mid-transit time. The others stay at
# their known values.

# %%
session = esl.Session(
    name="Simulated hot Jupiter",
    limb_darkening=esl.LimbDarkening(law="quadratic", coefficients=[0.40, 0.20]),
    planets=[esl.Planet(letter="b", parameters=dict(truth, ecc=0.0, omega=0.0))],
    data=esl.Data(light_curve=esl.LightCurve(name="night 1", time=t, flux=flux, flux_err=np.full(t.size, 0.0015))),
    fit=esl.FitSettings(
        free=[
            esl.FreeParameter(key="rprs", prior=esl.Prior.uniform(0.05, 0.25)),
            esl.FreeParameter(key="inc", prior=esl.Prior.uniform(80, 90)),
            esl.FreeParameter(key="tmid", prior=esl.Prior.uniform(-0.02, 0.02)),
        ],
        sampler=esl.Sampler(nlive=300, seed=1),
    ),
)
print(session.summary())

# %% [markdown]
# ## 3. Fit
#
# Nested sampling explores the priors and returns the posterior (what the data allow) and the **evidence** ln Z
# (how well the model explains the data overall, used later to compare models).

# %%
fit = session.run()
print(fit.result.table())

# %% [markdown]
# Each value is the posterior median with the 68% interval. Compare them with the truth we simulated:

# %%
for key in ["rprs", "inc", "tmid"]:
    q = fit.result[key]
    print(f"{key:5s} = {q.median:.5f} +{q.plus:.5f} -{q.minus:.5f}   (truth {truth[key]}, {abs(q.median - truth[key]) / max(q.plus, q.minus):.1f} sigma away)")

# %% [markdown]
# ## 4. Look at it
#
# The data with the best-fitting model and the residuals; then the posterior: each parameter's distribution and
# how pairs of parameters trade off (the inclination and the radius ratio are correlated through the transit's shape).

# %%
esl.plot.light_curve(fit);

# %%
esl.plot.corner(fit, truths={k: truth[k] for k in ["rprs", "inc", "tmid"]});

# %% [markdown]
# ## 5. What follows from it
#
# Derived quantities come from the posterior draws, with the star's radius and mass (here the defaults of the session):

# %%
about = {"depth": "transit depth (fraction of the star's light)", "b": "impact parameter (0 = through the centre)", "t14": "transit duration, days", "rhoStar": "stellar density from a/R* and P, g/cm^3"}
for key, what in about.items():
    d = fit.result.derived.get(key)
    if d is not None:
        print(f"{key:8s} {d.median:.5g} +{d.plus:.2g} -{d.minus:.2g}   {what}")

# %% [markdown]
# ## 6. Keep it
#
# `fit.save(...)` writes the session with its result (it opens on the website); `fit.to_markdown()` is a report and
# `fit.to_script()` a Python script that rebuilds this analysis line by line.

# %%
print(fit.to_markdown()[:900], "…")

# %% [markdown]
# **Next:** [Lab 2](./lab02_tess_transit) fits a real TESS transit, starting from the catalogue's values.
