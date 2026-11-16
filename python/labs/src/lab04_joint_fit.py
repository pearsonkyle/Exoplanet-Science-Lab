# %% [markdown]
# # Lab 4 · One orbit for everything: transit, velocities and timing
#
# Each kind of data constrains something different. The transit gives the planet's size and the inclination; the
# velocities give the mass and the shape of the orbit; transit and eclipse times spread over fifteen years pin the
# period. A **joint fit** asks one orbit to explain all of them at once, which is how published parameters are made.
# This is the analysis of Pearson et al. (2022) for HD 80606 b, as the website's worked example stores it.

# %%
import os
import urllib.request
import esl
import esl.plot

DATA = os.environ.get("ESL_DATA", "https://pearsonkyle.github.io/Exoplanet-Science-Lab/examples/")
fetch = lambda path: urllib.request.urlopen(DATA + path).read().decode()

# %% [markdown]
# ## 1. Open the worked example
#
# The session holds the TESS light curve, 264 velocities from seven instruments, four transit times and one eclipse
# time, and the priors. **Kepler's law ties a/R★** to the period and the star's mass and radius, so the light curve
# and the velocities share one orbit (a/R★ is never sampled on its own: it is degenerate with the inclination).

# %%
session = esl.Session.model_validate_json(fetch("results/hd80606-joint.json"))
print(session.summary())

# %% [markdown]
# ## 2. Fit it again
#
# The stored file already has a result (from the website). Running it here samples everything again, in about a
# minute: twelve free parameters.

# %%
fit = session.run()
print(fit.result.table())

# %% [markdown]
# ## 3. Each dataset against the one model

# %%
esl.plot.light_curve(fit);

# %%
esl.plot.radial_velocity(fit, fold=True);

# %%
esl.plot.oc(fit);

# %% [markdown]
# ## 4. Compare with the paper
#
# Pearson et al. (2022) report P = 111.4367 d, e = 0.93183 and ω = −58.887°. Differences of a couple of σ are
# expected: the paper's fit had more data and treated the stellar parameters and jitters slightly differently. The
# planet's mass also scales with the star's mass assumed (as M★^(2/3)), so compare it with care.

# %%
paper = dict(per=111.4367, ecc=0.93183, omega=-58.887)
for key, ref in paper.items():
    q = fit.result[key] if key in fit.result else fit.result.derived[key]
    print(f"{key:8s} {q.median:.6g} +{q.plus:.2g} -{q.minus:.2g}   paper {ref}   ({(q.median - ref) / max(q.plus, q.minus, 1e-12):+.1f} sigma)")

# %% [markdown]
# **Next:** [Lab 5](./lab05_ephemeris) works with transit times alone.
