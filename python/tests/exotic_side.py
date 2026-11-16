"""Run by the EXOTIC interpreter (not by pytest): EXOTIC's own transit and radial-velocity models for the
parameter sets and times given as JSON on stdin; JSON on the last line of stdout. Imports nothing of ESL."""
import json
import sys
import warnings

warnings.filterwarnings("ignore")
import numpy as np  # noqa: E402
import exotic  # noqa: E402
from exotic.api import multi_fitter as m  # noqa: E402

req = json.load(sys.stdin)
out = {"version": exotic.__version__, "cases": []}
for c in req["cases"]:
    v = dict(c["params"])
    mu, ars, _ = m.orbit_derived(v, v["mstar"], v["rstar"])
    v["mu"], v["ars"] = mu, ars
    tt, tr = np.array(c["t_transit"]), np.array(c["t_rv"])
    out["cases"].append({"ars": ars, "mu": mu, "transit": m.transit(tt, v).tolist(), "rv": m.radial_velocity(tr, v).tolist(),
                         "rv_fine": ((m.radial_velocity(tr + 5e-6, v, dt=1e-5) + m.radial_velocity(tr - 5e-6 - 1e-5, v, dt=1e-5)) / 2).tolist()})
print("\n" + json.dumps(out))
