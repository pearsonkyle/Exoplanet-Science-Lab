"""HD 80606 b, everything together: EXOTIC's examples/joint_rv_transit/joint_fit.py (Pearson et al. 2022).

The TESS transit, 264 velocities, four mid-transit times and one mid-eclipse time share one orbit: a/R* follows
from Kepler's law. As in joint_fit.py the bounds on P, e, omega and the mass are the velocity-only posterior
(03_hd80606_rv.py) widened to +- 5 sigma. This is the worked example "HD 80606 b: transit + velocities + timing"
of the web application, written as an ESL session.

Should print (README, "EXOTIC's examples, reproduced"; about 15 to 25 s):
    joint_rv_transit   K 469.9, a/R* 94.453, P 111.43681, i 89.242, e 0.93163
                       against Table 7's 469.22, 94.452, 111.436765, 89.24, 0.93183
"""
import importlib
import json

import esl
from _common import Checks, figures_wanted, repo

check = Checks()
ROOT = repo()
J = json.loads((ROOT / "test" / "exotic_reference.json").read_text())["hd80606_joint"]
velocities = importlib.import_module("03_hd80606_rv").hd80606_velocities()
U = esl.Prior.uniform

session = esl.Session(
    name="HD 80606", title="HD 80606 b: transit + velocities + timing",
    star=esl.Star(teff=5565, teffErr=92, logg=4.4, loggErr=0.1, feh=0.35, fehErr=0.06, rstar=1.05, rstarErr=0.01, mstar=1.05, mstarErr=0.047),
    limb_darkening=esl.LimbDarkening(law="nonlinear", band="TESS (approx.)",            # ExoTETHyS, as in EXOTIC's examples
                                     coefficients=[0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333]),
    planets=[esl.Planet(letter="b", parameters=dict(rprs=0.1, ars=94.45, inc=89.269, per=111.4367, tmid=2458888.0757, ecc=0.93132, omega=-58.699, mplanet=4.2))],
    kepler=True, time_reference=2458887,
    data=esl.Data(
        light_curve=esl.read_light_curve(ROOT / "public/examples/hd80606/2458888_08_lightcurve.csv", name="TESS", exposure_min=2),
        radial_velocity=[esl.RadialVelocity(name=d.name, time=d.time, velocity=d.vel, velocity_err=d.velerr) for d in velocities],
        timing=[esl.TimingPoint(planet="b", kind=kind, time=t, err=e, source=src) for t, e, kind, src in [
            (2454987.7842, 0.0049, "transit", "Winn et al. 2010"), (2455210.6420, 0.004, "transit", "Hebrard et al. 2010"),
            (2455210.6502, 0.0064, "transit", "Shporer et al. 2010"), (2459556.6942, 0.0035, "transit", "Exoplanet Watch, Dec 2021"),
            (2454424.736, 0.00025, "eclipse", "Laughlin et al. 2009 (Spitzer)")]]),
    fit=esl.FitSettings(
        use=esl.Use(lc=True, rv=True, timing=True),
        free=[esl.FreeParameter(key="per", prior=U(111.43633, 111.43717)), esl.FreeParameter(key="tmid", prior=U(2458887.8757, 2458888.2757)),
              esl.FreeParameter(key="inc", prior=U(87, 90)), esl.FreeParameter(key="omega", prior=U(-59.04, -58.62)),
              esl.FreeParameter(key="ecc", prior=U(0.93096, 0.93216)), esl.FreeParameter(key="mplanet", prior=U(4.172, 4.202)),
              esl.FreeParameter(key="rprs", prior=U(0.01, 0.2))],
        sampler=esl.Sampler(nlive=400, seed=9)),
)
print(session.summary())
fit = session.run(progress=True)
r = fit.result
print(r.table())

K, ars, P, inc, ecc = r.derived["K"].median, r.derived["ars"].median, r["per"].median, r["inc"].median, r["ecc"].median
print(f"K {K:.2f}, a/R* {ars:.3f}, P {P:.6f}, i {inc:.3f}, e {ecc:.5f}   (README: 469.9, 94.453, 111.43681, 89.242, 0.93163; Table 7: 469.22, 94.452, 111.436765, 89.24, 0.93183)")
check("converged", r.converged, f"{r.ncalls} calls in {r.seconds:.0f} s; chi2 light curve {r.chi2_parts.light_curve:.0f}, velocities {r.chi2_parts.radial_velocity:.0f}, timing {r.chi2_parts.timing:.1f}")
check("K = 469.9 m/s", abs(K - 469.9) < 0.6, f"{K:.2f}")
check("a/R* = 94.453", abs(ars - 94.453) < 0.005, f"{ars:.4f}")
check("P = 111.43681 d", abs(P - 111.43681) < 1.5e-4, f"{P:.6f}")
check("i = 89.242 deg", abs(inc - 89.242) < 0.01, f"{inc:.4f}")
check("e = 0.93163", abs(ecc - 0.93163) < 2e-4, f"{ecc:.5f}")
check("against Pearson et al. (2022) Table 7: P within 5e-4 d, i within 0.03 deg, e within 0.001, omega within 0.25 deg, K within 3 m/s, a/R* within 0.15",
      abs(P - 111.436765) < 5e-4 and abs(inc - 89.24) < 0.03 and abs(ecc - 0.93183) < 0.001 and abs(r["omega"].median + 58.887) < 0.25 and abs(K - 469.22) < 3 and abs(ars - 94.452) < 0.15)
# EXOTIC's joint_fitter counts the light curve twice and adds its timing noise to sigma linearly (README), so its weights
# differ from these on purpose: central values are comparable, error bars are not.
dt = r["tmid"].median - J["parameters"]["tmid"]
check("against EXOTIC's stored joint fit: Rp/R* within 0.002, T mid within 3 of its sigma (0.006 d)",
      abs(r["rprs"].median - J["parameters"]["rprs"]) < 0.002 and abs(dt) < 3 * J["errors"]["tmid"], f"Rp/R* {r['rprs'].median:.4f} vs {J['parameters']['rprs']:.4f}; T mid differs by {dt:+.4f} d")
check("the sampler says what it sees: e and omega are strongly correlated", any("correlated" in w for w in r.warnings))

out = figures_wanted()
if out:
    import esl.plot
    esl.plot.light_curve(fit).savefig(out / "hd80606_joint_light_curve.png", dpi=150)
    esl.plot.radial_velocity(fit, fold=True).savefig(out / "hd80606_joint_rv_phase.png", dpi=150)
    esl.plot.oc(fit).savefig(out / "hd80606_joint_oc.png", dpi=150)
    esl.plot.corner(fit).savefig(out / "hd80606_joint_posterior.png", dpi=150)
    fit.save(out / "hd80606_joint_session.json")                 # opens in the web application
    (out / "hd80606_joint_report.md").write_text(fit.to_markdown())
    (out / "hd80606_joint_tables.tex").write_text(fit.to_latex())
check.finish()
