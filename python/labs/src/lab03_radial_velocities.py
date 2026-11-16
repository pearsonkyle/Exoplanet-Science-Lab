# %% [markdown]
# # Lab 3 · Radial velocities from seven instruments
#
# As the planet orbits, it pulls its star around their common centre of mass. Spectrographs measure the star's
# velocity towards and away from us to metres per second. The size of the swing gives the planet's mass; its
# shape gives the eccentricity and orientation of the orbit. Here: 264 velocities of HD 80606 from 2000 to 2021.

# %%
import os
import urllib.request
import esl
import esl.plot

DATA = os.environ.get("ESL_DATA", "https://pearsonkyle.github.io/Exoplanet-Science-Lab/examples/")
fetch = lambda path: urllib.request.urlopen(DATA + path).read().decode()

# %% [markdown]
# ## 1. The velocities
#
# Each instrument (and each era of an instrument) has its own zero point: velocities are relative, measured against
# its own reference. `esl.read_rv` makes one dataset per instrument; the fit gives each its own offset (integrated
# out analytically, so it costs nothing) and, if you wish, its own extra noise ("jitter").

# %%
rv = esl.read_rv(fetch("hd80606/HD80606_RV.csv"))
for d in rv:
    print(f"{d.name:8s} {len(d.time):3d} velocities  {d.time[0]:.1f} to {d.time[-1]:.1f}")

# %% [markdown]
# ## 2. Fit the orbit
#
# Free: the period, eccentricity, argument of periastron and the planet's mass, plus a **jitter** per instrument:
# extra scatter added in quadrature to the error bars (the star's own surface, or an instrument's systematics).
# Without it the fit would treat that scatter as signal (χ² ≈ 1800 for 264 points) and the uncertainties would be
# too small. The inclination comes from the transit, so the mass here is the true mass, not M sin i.

# %%
cat = esl.lookup("HD 80606 b")
free = [esl.FreeParameter(key=k, prior=esl.Prior.uniform(lo, hi)) for k, lo, hi in [
    ("per", 111.3, 111.6), ("ecc", 0.90, 0.96), ("omega", -70, -50), ("mplanet", 3.0, 5.5)]]
free += [esl.FreeParameter(key=f"jit@rv{i + 1}", prior=esl.Prior.uniform(0, 50)) for i in range(len(rv))]
session = cat.session.model_copy(update=dict(
    name="HD 80606 b · velocities",
    data=esl.Data(radial_velocity=rv),
    fit=esl.FitSettings(use=esl.Use(lc=False, rv=True, timing=False), free=free, sampler=esl.Sampler(nlive=250, seed=4)),
))
fit = session.run()
print(fit.result.table())

# %% [markdown]
# ## 3. See it
#
# Folded on the period, every instrument lands on one curve once its zero point is removed. The sharp swing is
# periastron, when the planet passes 0.03 au from the star (closer than Mercury is to the Sun).

# %%
esl.plot.radial_velocity(fit, fold=True);

# %%
K = fit.result.derived["K"]
print(f"velocity semi-amplitude K = {K.median:.1f} +{K.plus:.1f} -{K.minus:.1f} m/s (Pearson et al. 2022: 469.2 m/s)")
for z in fit.result.rv_zero_points:
    print(f"  {z.name:8s} zero point {z.gamma:8.1f} m/s, jitter {z.jitter:5.1f} m/s")

# %% [markdown]
# **Next:** [Lab 4](./lab04_joint_fit) puts the transit, the velocities and fifteen years of transit times into one model.
