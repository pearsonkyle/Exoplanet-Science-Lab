"""The atmosphere forward model through Python: the same numbers as the JavaScript core gives in test/haze.test.mjs."""
from pathlib import Path

import numpy as np
import pytest

import esl

PUBLIC = Path(__file__).resolve().parents[2] / "public"
pytestmark = pytest.mark.skipif(not (PUBLIC / "opacity" / "index.json").exists(), reason="the opacity tables are not in this checkout")


def test_worlds_are_listed():
    names = [w["name"] for w in esl.atmosphere_worlds()]
    assert {"WASP-39 b", "WASP-121 b, day side", "Jupiter", "Titan"} <= set(names)


def test_titan_transit_altitude_and_cold_trap():
    r = esl.atmosphere("Titan", wl_min=0.6, wl_max=5.3, public=PUBLIC)
    assert r["depth"].shape == r["wl"].shape and r["wl"][0] < 0.62 and r["wl"][-1] > 5.2
    rsun, surface = 6.957e8, 2574.76e3
    z = np.sqrt(r["depth"]) * rsun - surface                     # effective transit altitude [m]
    i = int(np.argmin(abs(r["wl"] - 0.88)))
    assert 255e3 < z[i] < 345e3                                   # about 300 km at 0.88 micron (Robinson et al. 2014)
    ch4 = r["profile"]["gases"]["CH4"]
    assert abs(ch4[-1] - 0.0565) < 1e-9 and 0.0148 < ch4[0] < 0.0296
    assert [c["name"] for c in r["clouds"]] == ["CH4"] and r["climate"] is None


def test_changes_to_a_world_and_binning():
    a = esl.atmosphere(model=dict(vmr=dict(H2O=1e-3)), wl_min=1.0, wl_max=2.0, R=50, emission=False, public=PUBLIC)
    b = esl.atmosphere(model=dict(vmr=dict(H2O=1e-3), cloudTop=1e-3), wl_min=1.0, wl_max=2.0, R=50, emission=False, public=PUBLIC)
    assert a["fpfs"] is None and len(a["wl"]) == len(b["wl"]) < 40
    assert np.ptp(a["depth"]) > 3 * np.ptp(b["depth"])            # a grey deck at 1 mbar flattens the water bands
    with pytest.raises(esl.CoreError):
        esl.atmosphere("Pluto", public=PUBLIC)


def test_retrieval_recovers_what_was_put_in():
    """A noisy model spectrum fitted through the package: the same call the MCP server makes (test/retrieval.test.mjs
    checks the method; this checks the Python path, its table loading and its defaults)."""
    mdl = {"planet": {"mplanet": 0.69, "rplanet": 1.38, "pRef": 0.01}, "star": {"rstar": 1.19, "teff": 6091}, "tp": {"kind": "isothermal", "t": 1300},
           "vmr": {"H2O": 5e-4, "CO2": 1e-12, "CO": 1e-12, "CH4": 1e-12}}
    truth = esl.atmosphere(model=mdl, species=["H2O"], wl_min=1.0, wl_max=5.0, merge=8, R=20, emission=False)
    rng = np.random.default_rng(3)
    err = np.full(truth["wl"].size, 80e-6)
    obs = {"kind": "transit", "wl": truth["wl"], "lo": truth["lo"], "hi": truth["hi"], "y": truth["depth"] + err * rng.standard_normal(err.size), "err": err}
    r = esl.retrieve_atmosphere([obs], ["t", "logX_H2O", "rplanet"], model=mdl, species=["H2O"], priors={"t": (600, 2200), "rplanet": (1.25, 1.5)},
                                merge=8, layers=20, nlive=60, max_models=12000)
    assert r["converged"], r["warnings"]
    z = lambda k, v: abs(r["summary"][k]["median"] - v) / (0.5 * (r["summary"][k]["hi"] - r["summary"][k]["lo"]))
    assert z("t", 1300) < 3 and z("logX_H2O", np.log10(5e-4)) < 3 and z("rplanet", 1.38) < 3
    assert r["chi2"] < 1.8 * r["ndata"] and r["priors"]["logX_H2O"]["a"] == -10 and r["best"]["spectra"][0].shape == truth["wl"].shape
    short = esl.retrieve_atmosphere([obs], ["t", "logX_H2O", "rplanet"], model=mdl, species=["H2O"], merge=8, layers=20, nlive=40, max_models=200)
    assert short["converged"] is False
    with pytest.raises(Exception, match="no retrieval parameter"):
        esl.retrieve_atmosphere([obs], ["banana"], model=mdl, species=["H2O"])
