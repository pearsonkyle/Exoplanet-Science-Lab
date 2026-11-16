"""The model functions against Node running src/core directly, and against the references the JavaScript tests use."""
import json

import numpy as np
import pytest

import esl

ULP = 2.220446049250313e-16


def _exact_or_ulps(a, b):
    """Largest difference in units of the last place of 1 (the flux scale)."""
    return float(np.max(np.abs(np.asarray(a) - np.asarray(b)))) / ULP


def test_transit_equals_javascript_on_the_validation_grid(js, record_property):
    worst, worst_truth, n = 0.0, 0.0, 0
    for c in js["transit"]:
        f = esl.transit(c["times"], c["params"])
        worst = max(worst, _exact_or_ulps(f, c["flux"]))
        worst_truth = max(worst_truth, float(np.max(np.abs(f - np.array(c["truth"])))))
        n += len(f)
    record_property("transit_max_ulps_vs_node", worst)
    record_property("transit_max_error_vs_quadrature", worst_truth)
    print(f"\n{len(js['transit'])} light curves, {n} points: largest difference from Node {worst:.1f} ulp of 1; from the 30-digit / quadrature truth {worst_truth:.1e}")
    assert len(js["transit"]) >= 40
    assert worst <= 8          # Node 22 is V8 12.4, PyMiniRacer V8 14.4: their sin, cos and acos differ in the last digit
    assert worst_truth < 1e-10  # README, Validation table: 3.1e-11


def test_transit_is_bit_identical_under_the_same_engine(js):
    if "node" not in esl.available_runtimes():
        pytest.skip("node is not available")
    esl.set_runtime("node")
    for c in js["transit"]:
        assert np.array_equal(esl.transit(c["times"], c["params"]), np.array(c["flux"])), c["label"]
    for c in js["rv"]:
        assert np.array_equal(esl.radial_velocity(c["times"], c["params"]), np.array(c["rv"])), c["label"]


def test_exposure_averaging_equals_javascript(js):
    for c in js["exposure"]:
        f = esl.transit(c["times"], c["params"], exptime=c["exptime"])                 # supersample="auto"
        assert _exact_or_ulps(f, c["flux"]) <= 8, c["label"]
        g = esl.transit(c["times"], c["params"], exptime=c["exptime"], supersample=c["supersample"])
        assert np.array_equal(f, g)
        assert np.max(np.abs(f - np.array(c["truth"]))) < 2.5e-5                       # README: up to 18 ppm left by automatic averaging


def test_radial_velocity_equals_javascript(js):
    worst = 0.0
    for c in js["rv"]:
        v = esl.radial_velocity(c["times"], c["params"])
        worst = max(worst, float(np.max(np.abs(v - np.array(c["rv"])))) / c["params"]["K"])
        assert np.max(np.abs(v - np.array(c["truth"]))) / c["params"]["K"] < 1e-12     # README: 1.3e-14 K
    print(f"\nlargest difference from Node: {worst:.1e} K")
    assert worst < 1e-14


def test_kernel_against_scipy_quadrature(repo):
    # test/reference.json: 680 geometries, blocked fraction by scipy adaptive quadrature (README: 6e-13 on this grid)
    ref = json.loads((repo / "test" / "reference.json").read_text())
    worst = 0.0
    for r in ref[::7]:
        claret = r["a"]
        ld = esl.core.invoke("limbdark.prepareLD", claret)
        got = esl.core.invoke("transit.blockedFraction", r["z"], r["p"], ld)
        worst = max(worst, abs(got - r["ref"]))
    assert worst < 2e-12, worst


def test_several_planets_multiply_and_kepler_gives_ars():
    t = np.linspace(-0.3, 0.3, 200)
    b = dict(rprs=0.1, ars=8.8, inc=87.0, per=3.5, tmid=0.0, ld=[0.4, 0.26])
    c = dict(rprs=0.05, ars=20.0, inc=89.5, per=11.0, tmid=0.05, ld=[0.4, 0.26])
    assert np.allclose(esl.transit(t, [b, c]), esl.transit(t, b) * esl.transit(t, c), rtol=0, atol=1e-15)
    k = dict(rprs=0.1, inc=87.0, per=3.5, tmid=0.0, ld=[0.4, 0.26], mstar=1.0, rstar=1.0, mplanet=1.0)
    ars = esl.core.invoke("rv.arsFromKepler", 3.5, 1.0, 1.0, 1.0)
    assert np.array_equal(esl.transit(t, k), esl.transit(t, {**k, "ars": ars}))
    # EXOTIC's keys: u0..u3 are the four Claret coefficients
    e = dict(rprs=0.1, ars=8.8, inc=87.0, per=3.5, tmid=0.0, ecc=0.0, omega=0.0, u0=0.49, u1=-0.07, u2=0.46, u3=-0.22)
    assert np.array_equal(esl.transit(t, e), esl.transit(t, dict(rprs=0.1, ars=8.8, inc=87.0, per=3.5, tmid=0.0, ld=[0.49, -0.07, 0.46, -0.22], law="nonlinear")))


def test_semi_amplitude_and_inverse():
    K = esl.semi_amplitude(per=111.436765, mplanet=4.1641, mstar=1.05, ecc=0.93183, inc=89.24)
    assert abs(K - 469.22) < 1.5                                # Pearson et al. 2022, Table 7 (test/physics.test.mjs: 467.9 here)
    assert abs(esl.mass_from_k(K, per=111.436765, mstar=1.05, ecc=0.93183, inc=89.24) - 4.1641) < 1e-9
    v = esl.radial_velocity([0.0, 1.0], dict(per=4.0, tmid=1.0, K=10.0))
    assert abs(v[0] - 10.0) < 1e-12 and abs(v[1]) < 1e-12       # the star recedes fastest a quarter period before mid-transit
