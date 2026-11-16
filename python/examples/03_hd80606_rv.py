"""Radial velocities of HD 80606 b: EXOTIC's examples/radial_velocity/rv_example.py.

264 velocities from seven instruments over 20 years; the four free parameters and bounds of rv_example.py.
Written with the EXOTIC-style classes: one RadialVelocityData per instrument (the zero point of each is
integrated out), one planet, uniform bounds.

Should print (README, "EXOTIC's examples, reproduced"):
    radial_velocity   HD 80606 b, seven instruments, four free parameters
                      K 469.6 m/s (paper 469.2), e 0.93156 (0.93183), omega -58.83 deg (-58.887 deg);
                      zero points match EXOTIC's
"""
import json

import numpy as np

import esl
from esl import multi_fitter as m
from _common import Checks, csv, figures_wanted, repo

check = Checks()
ROOT = repo()
J = json.loads((ROOT / "test" / "exotic_reference.json").read_text())["hd80606_joint"]      # EXOTIC's stored joint fit


def hd80606_velocities():
    """As joint_fit.py: drop duplicate dates; HRS has two populations of error bars, treated as two instruments."""
    rows, seen, sets = csv(ROOT / "public/examples/hd80606/HD80606_RV.csv"), set(), {}
    for tel, bjd, vel, err in rows:
        if bjd in seen:
            continue
        seen.add(bjd)
        sets.setdefault(("HRS_1" if err < 5 else "HRS_2") if tel == "HRS" else str(tel), []).append((bjd, vel, err))
    return [m.RadialVelocityData(name=k, time=[r[0] for r in v], vel=[r[1] for r in v], velerr=[r[2] for r in v]) for k, v in sets.items()]


if __name__ == "__main__":
    rv = hd80606_velocities()
    planet = m.SystemParameters(rprs=0.1, per=111.4367, inc=89.269, ecc=0.93132, omega=-58.699, tmid=2458888.0757, mplanet=4.20, rstar=1.05, mstar=1.05)
    system = m.MultiPlanetSystem(
        name="HD 80606", planets={"b": planet},
        free={"b": m.ParameterSet(per=1, omega=1, ecc=1, mplanet=1)},
        bounds={"b": m.Bounds(upper=m.ParameterSet(per=111.5, omega=-55, ecc=0.94, mplanet=4.5), lower=m.ParameterSet(per=111.3, omega=-65, ecc=0.92, mplanet=3))},
        radial_velocity=rv)
    fit = m.MultiPlanetFit(system, live=400, seed=8)
    r = fit.result
    K, P, e, w = r.derived["K"].median, r["per"].median, r["ecc"].median, r["omega"].median
    print(f"K = {K:.2f} m/s, e = {e:.5f}, omega = {w:.3f} deg, P = {P:.5f} d, Mp = {r['mplanet'].median:.4f} M_Jup; chi2 = {r.chi2:.0f} for {r.n_data} velocities")

    check("seven datasets, as EXOTIC", [(d.name, len(d.time)) for d in rv] == [(d["name"], d["n"]) for d in J["rv_datasets"]], ", ".join(f"{d.name} {len(d.time)}" for d in rv))
    check("K = 469.6 m/s (paper 469.22)", abs(K - 469.6) < 0.5 and abs(K - 469.22) < 5, f"{K:.2f}")
    check("e = 0.93156 (paper 0.93183)", abs(e - 0.93156) < 3e-4 and abs(e - 0.93183) < 0.002, f"{e:.5f}")
    check("omega = -58.83 deg (paper -58.887)", abs(w + 58.83) < 0.05 and abs(w + 58.887) < 0.5, f"{w:.3f}")
    check("P within 0.002 d of the paper's 111.436765", abs(P - 111.436765) < 0.002, f"{P:.5f}")
    ok = all(abs(d.offset - J["offsets"][d.name + "_offset"][0]) < max(3, 4 * J["offsets"][d.name + "_offset"][1]) for d in rv)
    check("instrument zero points match EXOTIC's", ok, ", ".join(f"{d.name} {d.offset:.1f} ({J['offsets'][d.name + '_offset'][0]:.1f})" for d in rv))
    check("the formal errors are too small, as the README says: chi2 far above the number of points", r.chi2 > 4 * r.n_data, f"chi2 {r.chi2:.0f} for {r.n_data}: free the jitters for honest errors")
    # EXOTIC scales the reflex motion by Mp/M*, so for the same velocities its mass is lower by Mp/M* (0.38%)
    ratio = r["mplanet"].median / J["parameters"]["mplanet"] - 1
    check("mass higher than EXOTIC's by Mp/M* (0.38%)", abs(ratio - 0.0038) < 0.003, f"{100 * ratio:.2f}%")

    out = figures_wanted()
    if out:
        fit.plot_rv().savefig(out / "hd80606_rv.png", dpi=150)
        fit.plot_rv(fold=True).savefig(out / "hd80606_rv_phase.png", dpi=150)
        fit.plot_posterior().savefig(out / "hd80606_rv_posterior.png", dpi=150)
    check.finish()
