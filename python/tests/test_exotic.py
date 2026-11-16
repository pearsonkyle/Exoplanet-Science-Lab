"""The EXOTIC-style layer (esl.multi_fitter) and the comparison with EXOTIC itself.

References: test/exotic_reference.json and test/exotic_fits.json (EXOTIC 4.3.1 and pylightcurve 4.0.4, written by
test/make_exotic_reference.py and test/make_exotic_fits.py), and EXOTIC run now by subprocess when its
interpreter exists ($EXOTIC_PYTHON, default the owner's conda environment).
"""
import json
import subprocess

import numpy as np
import pytest

import esl
from esl import multi_fitter as m

from conftest import EXOTIC_PYTHON, ROOT

MJUP_MSUN = 9.5459426398e-4


def test_models_against_exotic_reference(exotic_ref):
    worst_t = worst_rv = 0.0
    for name, c in exotic_ref["models"].items():
        p = {**c["params"], "u0": 0.49387060813646527, "u1": -0.07294561715247563, "u2": 0.4578497817617948, "u3": -0.21582471000247333}
        worst_t = max(worst_t, float(np.max(np.abs(m.transit(c["t_transit"], p) - np.array(c["transit"])))))
        # EXOTIC scales the reflex motion by Mp/M*; the two-body factor is Mp/(M* + Mp)
        K = esl.semi_amplitude(p["per"], p["mplanet"], p["mstar"], p["ecc"], p["inc"])
        scale = 1 + p["mplanet"] * MJUP_MSUN / p["mstar"]
        mine = m.radial_velocity(c["t_rv"], p) * scale
        worst_rv = max(worst_rv, float(np.max(np.abs(mine - np.array(c["rv_fine"])))) / K)
        assert float(np.max(np.abs(mine - np.array(c["rv"])))) / K < 3e-4, name      # its default forward difference
    print(f"\ntransit vs pylightcurve (Claret law): {worst_t:.1e}; RV vs EXOTIC with a fine centred difference: {worst_rv:.1e} K")
    assert worst_t < 2e-7        # README: 1.0e-7
    assert worst_rv < 2e-5       # README: 1.1e-5 K


@pytest.mark.exotic
def test_models_against_exotic_run_now(exotic_ref):
    if not EXOTIC_PYTHON.exists():
        pytest.skip(f"no EXOTIC interpreter at {EXOTIC_PYTHON} (set EXOTIC_PYTHON)")
    cases = [{"params": {**c["params"], "u0": 0.49387060813646527, "u1": -0.07294561715247563, "u2": 0.4578497817617948, "u3": -0.21582471000247333},
              "t_transit": c["t_transit"][::3], "t_rv": c["t_rv"][::4]} for c in exotic_ref["models"].values()]
    # a planet the stored reference does not have
    extra = dict(rprs=0.085, per=2.2185, inc=85.7, tmid=2459100.3, ecc=0.12, omega=40.0, mplanet=0.9, mstar=0.8, rstar=0.78,
                 u0=0.49387060813646527, u1=-0.07294561715247563, u2=0.4578497817617948, u3=-0.21582471000247333)
    cases.append({"params": extra, "t_transit": list(2459100.3 + np.linspace(-0.12, 0.12, 97)), "t_rv": list(2459100.3 + np.linspace(-3, 3, 61))})
    out = subprocess.run([str(EXOTIC_PYTHON), str(ROOT / "python/tests/exotic_side.py")], input=json.dumps({"cases": cases}), capture_output=True, text=True, cwd="/tmp", timeout=300)
    if out.returncode != 0:
        pytest.skip("EXOTIC could not be run: " + out.stderr[-300:])
    ref = json.loads(out.stdout.strip().splitlines()[-1])
    worst_t = worst_rv = worst_ars = 0.0
    for c, r in zip(cases, ref["cases"]):
        p = c["params"]
        ars = esl.core.invoke("rv.arsFromKepler", p["per"], p["mstar"], p["mplanet"], p["rstar"])
        worst_ars = max(worst_ars, abs(ars / r["ars"] - 1))
        worst_t = max(worst_t, float(np.max(np.abs(m.transit(c["t_transit"], {**p, "ars": r["ars"]}) - np.array(r["transit"])))))
        K = esl.semi_amplitude(p["per"], p["mplanet"], p["mstar"], p["ecc"], p["inc"])
        mine = m.radial_velocity(c["t_rv"], p) * (1 + p["mplanet"] * MJUP_MSUN / p["mstar"])
        worst_rv = max(worst_rv, float(np.max(np.abs(mine - np.array(r["rv_fine"])))) / K)
    print(f"\nEXOTIC {ref['version']} run now, {len(cases)} planets: transit {worst_t:.1e}, RV {worst_rv:.1e} K, a/R* from Kepler {worst_ars:.1e} relative")
    assert worst_t < 2e-7 and worst_rv < 3e-5 and worst_ars < 2e-4


def test_classes_have_exotics_fields():
    sp = m.SystemParameters()
    assert sp.rprs == 0.1 and sp.per == 111.4367 and sp.u0 == 0.49387060813646527 and sp.mplanet == 4.20
    ps = m.ParameterSet(rprs=0.2, inc=90, tmid=2451000, per=1.2)
    assert [k for k, _ in ps.items()] == ["rprs", "per", "inc", "tmid"] and ps.numpy.tolist() == [0.2, 1.2, 90, 2451000]
    b = m.Bounds(upper=ps, lower=m.ParameterSet(rprs=0, inc=80, tmid=2450000, per=1.1))
    r = b.random()
    assert set(r) == {"rprs", "per", "inc", "tmid"} and 1.1 <= r["per"] <= 1.2
    with pytest.raises(ValueError, match="mismatched"):
        m.Bounds(upper=m.ParameterSet(rprs=1), lower=m.ParameterSet(per=1)).random()
    lc = m.LightCurveData(time=np.arange(3.0), name="x", flux=np.ones(3), ferr=np.full(3, 0.01), airmass=np.zeros(3))
    assert lc.exp_time == 0.0 and lc.scale == 1.0 and len(lc.model) == 0
    ds = m.PlanetDataset(transit=[lc])
    assert ds["transit"][0].name == "x"
    assert np.allclose(sp.evaluate("transit", [sp.tmid]), m.transit([sp.tmid], sp.model_dump()))


def test_system_becomes_the_session_of_the_javascript_test(toy_system, js, exotic_ref):
    system, truth = toy_system()
    session, keymap = system.to_session()
    assert keymap == {"b_mplanet": "mplanet", "b_rv_linear": "rvlin", "c_mplanet": "mplanet@c", "d_mplanet": "mplanet@d", "rv_neid_rv_jitter": "jit@rv1"}
    assert session.kepler and session.letters == ["b", "c", "d"] and session.data.light_curve.airmass is None
    ev = session.evaluate(at={"rvlin": truth["trend"]["rv_linear"], "jit@rv1": truth["noise"]["rv_jitter"]})
    # the same chi-square as the session written by hand in JavaScript, and as EXOTIC
    assert ev.chi2 == pytest.approx(js["toy"]["chi2"], abs=1e-6)
    assert abs(ev.chi2_parts.radial_velocity - exotic_ref["toy"]["rv"]["chi2"]) < 0.02
    assert abs(ev.radial_velocity[0].gamma - exotic_ref["toy"]["rv"]["offset"]) < 0.01
    K = exotic_ref["toy"]["K"]
    for letter, q in zip("bcd", ev.planets):
        mine = esl.semi_amplitude(q["per"], q["mplanet"], 1.02, 0, q["inc"])
        assert abs(mine * (1 + q["mplanet"] * MJUP_MSUN / 1.02) / K[letter] - 1) < 2e-3


@pytest.fixture(scope="module")
def toy_fit(toy_system):
    system, truth = toy_system()
    return m.MultiPlanetFit(system, live=300, seed=42, verbose=False), system, truth


def test_fit_against_exotics_stored_fit(toy_fit, exotic_ref):
    fit, system, truth = toy_fit
    X = exotic_ref["toy"]["exotic_fit"]
    assert fit.result.converged and fit.freekeys == list(X["parameters"])
    lines = []
    for k in fit.freekeys:
        mine, sd, theirs, tsd = fit.parameters[k], fit.errors[k], X["parameters"][k], X["errors"][k]
        lines.append(f"{k}: ESL {mine:.5f} +- {sd:.5f} | EXOTIC {theirs:.5f} +- {tsd:.5f}")
        assert abs(mine - theirs) < 0.5 * tsd, k                  # README: best fit within 0.5 sigma
        assert abs(sd / tsd - 1) < 0.2, k                          # README: widths within 15%
    print("\n" + "\n".join(lines) + f"\nESL {fit.result.ncalls} calls in {fit.result.seconds:.1f} s; EXOTIC {X['ncall']} calls")
    # planet d: an upper limit, not a detection (README: 95% below 3.6 m/s)
    col = fit.results["samples"][:, fit.freekeys.index("d_mplanet")]
    K95 = esl.semi_amplitude(128.0, float(np.percentile(col, 95)), 1.02, 0, 89.55)
    assert 2.5 < K95 < 4.5
    t = {"b_mplanet": truth["planets"]["b"]["mplanet"], "c_mplanet": truth["planets"]["c"]["mplanet"], "b_rv_linear": truth["trend"]["rv_linear"], "rv_neid_rv_jitter": truth["noise"]["rv_jitter"]}
    for k, v in t.items():
        assert abs(fit.results["posterior"]["median"][fit.freekeys.index(k)] - v) < 3 * fit.errors[k], k


def test_fit_bookkeeping_follows_exotic(toy_fit):
    fit, system, truth = toy_fit
    assert set(fit.parameters) == set(fit.errors) == set(fit.quantiles) == set(fit.freekeys)
    assert fit.quantiles["c_mplanet"][0] == pytest.approx(fit.parameters["c_mplanet"] - 3 * fit.errors["c_mplanet"])
    assert fit.boundarray.shape == (5, 2) and fit.fmap[0] == ("b", "mplanet", None) and fit.fmap[-1] == (None, "rv_jitter", "rv_neid")
    r = fit.results
    assert r["samples"].shape[1] == 5 and len(r["weighted_samples"]["logl"]) == len(r["samples"]) and r["ncall"] == fit.result.ncalls
    for letter in "bcd":
        d = fit.derived[letter]
        assert {"K", "a", "mu", "ars", "T14"} <= set(d) and d["K"] > 0 and 0 < d["T14"] < 0.5
    assert abs(fit.derived["b"]["ars"] - 15.9239) < 0.01           # EXOTIC's reference: 15.92394
    rv = system.radial_velocity[0]
    assert len(rv.model) == len(rv.vel) and rv.resid_std < 5 and rv.offset_err > 0.1 and abs(rv.offset) < 3
    assert np.allclose(rv.residuals, rv.vel - rv.model)
    for ds in system.transit:
        assert len(ds.model) == len(ds.flux) and abs(ds.scale - 1) < 1e-3 and 1e-3 < ds.resid_std < 2e-3
    bf = fit.best_fit_planets()
    assert bf["c"]["mplanet"] == fit.parameters["c_mplanet"] and bf["b"]["rv_linear"] == fit.parameters["b_rv_linear"]
    assert fit.fit_nested() is fit.results                          # asking again does not run again
    assert fit.session.result is fit.result and fit.session.fit.sampler.nlive == 300


def test_layer_extras_normal_priors_timing_and_airmass():
    rng = np.random.default_rng(3)
    truth = m.SystemParameters(rprs=0.12, per=3.1, inc=88.0, ecc=0.0, omega=0.0, tmid=2459000.5, mplanet=1.0, rstar=1.0, mstar=1.0, a2=-0.08)
    ars = esl.core.invoke("rv.arsFromKepler", 3.1, 1.0, 1.0, 1.0)
    nights = []
    for k, E in enumerate((0, 3)):
        t = truth.tmid + E * truth.per + np.linspace(-0.12, 0.12, 150)
        air = 1.0 + 0.4 * np.linspace(-1, 1, 150) ** 2 + 0.1 * k
        f = esl.transit(t, {**truth.model_dump(), "ars": ars}) * (1.0 + 0.01 * k) * np.exp(truth.a2 * air) + rng.normal(0, 0.001, 150)
        ds = m.LightCurveData(time=t, name=f"night{k}", flux=f, ferr=np.full(150, 0.001), airmass=air)
        ds.local = m.ParameterSet(a2=1)
        ds.local_bounds = m.Bounds(upper=m.ParameterSet(a2=0.2), lower=m.ParameterSet(a2=-0.3))
        nights.append(ds)
    times = truth.tmid + truth.per * np.array([-40, -20, 30]) + rng.normal(0, 0.0005, 3)
    system = m.MultiPlanetSystem(
        planets={"b": truth}, free={"b": m.ParameterSet(rprs=1, tmid=1, per=1)},
        bounds={"b": m.Bounds(upper=m.ParameterSet(rprs=0.2, tmid=truth.tmid + 0.01), lower=m.ParameterSet(rprs=0.05, tmid=truth.tmid - 0.01))},
        priors={"b": {"per": esl.Prior.normal(3.1, 0.001)}}, transit=nights,
        ephemeris_transit={"b": [m.EphemerisData(time=times, name="literature", uncertainty=np.full(3, 0.0005))]})
    session, keymap = system.to_session()
    assert keymap == {"b_rprs": "rprs", "b_per": "per", "b_tmid": "tmid", "night0_a2": "a2@1", "night1_a2": "a2@2"}
    assert session.fit.free[1].prior.type == "normal" and len(session.data.timing) == 3 and session.fit.use.timing
    with pytest.warns(UserWarning, match="a1"):
        m.MultiPlanetSystem(planets={"b": truth}, free={"b": m.ParameterSet(a1=1, rprs=1)}, bounds={"b": m.Bounds(upper=m.ParameterSet(a1=2, rprs=0.2), lower=m.ParameterSet(a1=0, rprs=0.05))}, transit=nights[:1]).to_session()
    fit = m.MultiPlanetFit(system, live=150, seed=1, verbose=False)
    assert fit.result.converged
    for k, v in {"b_rprs": 0.12, "b_per": 3.1, "b_tmid": truth.tmid, "night0_a2": -0.08, "night1_a2": -0.08}.items():
        assert abs(fit.results["posterior"]["median"][fit.freekeys.index(k)] - v) < 3.5 * fit.errors[k], k
    assert fit.errors["b_per"] < 5e-5                               # the timing points pin the period far below its prior
    assert abs(nights[1].scale - 1.01) < 0.03 and abs(fit.results["samples"][:, fit.freekeys.index("b_tmid")].mean() - truth.tmid) < 1e-3
