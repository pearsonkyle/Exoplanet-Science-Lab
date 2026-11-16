# %% [markdown]
# # Lab 6 · A hidden planet weighed by its pull: Kepler-88
#
# Kepler-88 b transits its star every 10.95 days, but not on time: its transits come up to half a day early or
# late. Nothing else transits. The culprit is a second planet, c, on an orbit just outside the 2:1 resonance; each
# time the two line up they tug on each other, and the tugs add up into a slow wave in the transit times. The size
# of the wave weighs the hidden planet. Here: 119 transit times of b measured from Kepler data by Holczer et al. (2016).

# %%
import io
import os
import urllib.request
import numpy as np
import esl
import esl.plot

DATA = os.environ.get("ESL_DATA", "https://pearsonkyle.github.io/Exoplanet-Science-Lab/examples/")
fetch = lambda path: urllib.request.urlopen(DATA + path).read().decode()

d = np.genfromtxt(io.StringIO(fetch("kepler88/transit_times.csv")), delimiter=",", names=True, dtype=None, encoding="utf-8")
n, t, e = d["epoch"], d["tmid"], d["err"]
print(f"{t.size} transit times over {(t.max() - t.min()) / 365.25:.1f} years; median error {1440 * np.median(e):.1f} min")

# %% [markdown]
# ## 1. A steady clock would give a flat O − C

# %%
lin = esl.fit_ephemeris(t, e, epochs=n)
print(lin)

# %%
esl.plot.ephemeris(lin, t, e);

# %% [markdown]
# Far from flat: the transits swing by about ±12 hours. χ² per point is enormous for a straight line.
#
# ## 2. How long is the wave?
#
# The periodogram of the residuals finds the period of the timing variation, the **super-period**. For two planets
# near a j : j−1 resonance it is 1 / |j/P_c − (j−1)/P_b|, which says roughly where planet c must be.

# %%
pg = esl.periodogram(t, e, epochs=n)
print(pg)

# %%
esl.plot.periodogram(pg);

# %% [markdown]
# ## 3. The N-body fit
#
# A model with two planets that pull on each other (an N-body integration, not two Kepler orbits) is fitted to the
# times: the mass, period and phase of c and both eccentricities. That takes many minutes; the website's worked
# example stores the result, which we open here. To run it yourself: `fit = session.run(progress=True)`.

# %%
session = esl.Session.model_validate_json(fetch("results/kepler88.json"))
r = session.result
print(r.table())

# %%
esl.plot.oc(session);

# %% [markdown]
# ## 4. Compare with the radial velocities measured years later
#
# Weiss et al. (2020) measured the star's velocity with Keck: Mc = 0.674 ± 0.016 M_Jup. Timing alone found it.

# %%
key = next(k for k in ["mplanet@c", "mplanet"] if k in r)
m = r[key]
print(f"timing alone: Mc = {m.median:.3f} +{m.plus:.3f} -{m.minus:.3f} M_Jup;  Weiss et al. 2020: 0.674 +- 0.016  ({(m.median - 0.674) / np.hypot(m.plus, 0.016):+.1f} sigma)")
