# %% [markdown]
# # Lab 5 · Ephemerides, O − C and a shrinking orbit (WASP-12 b)
#
# A planet's transits repeat like a clock: T(n) = T₀ + n P. Fitting that line to measured mid-transit times gives
# the **ephemeris**, which predicts future transits. Subtract it from the measurements and you get the **O − C**
# diagram (observed minus calculated): flat if the clock is steady, curved if the period changes, wavy if something
# tugs on the planet. WASP-12 b's O − C curves: its orbit is decaying into its star.

# %%
import io
import os
import urllib.request
import numpy as np
import esl
import esl.plot

DATA = os.environ.get("ESL_DATA", "https://pearsonkyle.github.io/Exoplanet-Science-Lab/examples/")
fetch = lambda path: urllib.request.urlopen(DATA + path).read().decode()

times = np.genfromtxt(io.StringIO(fetch("ephemeris/wasp12_decay_times.csv")), delimiter=",", names=True, dtype=None, encoding="utf-8")
t, e = times["tmid"], times["err"]
print(f"{t.size} mid-transit times over {(t.max() - t.min()) / 365.25:.1f} years (Exoplanet Watch, ExoClock, ETD and the literature)")

# %% [markdown]
# ## 1. A straight line: the linear ephemeris

# %%
lin = esl.fit_ephemeris(t, e, period=1.0914)
print(lin)

# %% [markdown]
# ## 2. A curve: the period changes
#
# A quadratic ephemeris T(n) = T₀ + n P + ½ n² P dP/dn adds the rate of change of the period.

# %%
quad = esl.fit_ephemeris(t, e, period=1.0914, order=2)
print(quad)

# %%
esl.plot.ephemeris(quad, t, e);

# %% [markdown]
# Which model do the times prefer? Compare the χ² and the BIC (lower is better; a difference above ~10 is strong).
# The quadratic term is the orbital decay; χ²/dof well above 1 means the quoted timing errors are too small (or more
# is going on), so treat the formal uncertainty of dP/dt with care.

# %%
for name, f in [("linear", lin), ("quadratic", quad)]:
    print(f"{name:9s} chi2 = {f.chi2:8.1f} for {f.dof} degrees of freedom   BIC = {f.bic:8.1f}")

# %% [markdown]
# ## 3. Anything periodic left?
#
# A periodogram of the timing residuals searches for a sinusoid at every trial period. A peak above the false-alarm
# line would hint at another body perturbing the planet ([Lab 6](./lab06_ttv) has one).

# %%
pg = esl.periodogram(t, e, period=1.0914, order=2)
print(pg)

# %%
esl.plot.periodogram(pg);

# %% [markdown]
# **Next:** [Lab 6](./lab06_ttv) finds a hidden planet from its pull on a transiting one.
