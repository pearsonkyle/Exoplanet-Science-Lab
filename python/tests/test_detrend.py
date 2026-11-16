"""Detrending: a session's detector columns and detrending model (light_curve.columns / detrend, docs/FORMAT.md)
reach the core's likelihood from Python, giving the chi-square and posterior Node gets (python/tests/js/reference.mjs)."""
import json

import numpy as np
import pytest

import esl


@pytest.fixture(scope="module")
def dsession(js):
    return esl.Session.model_validate(js["detrend"]["session"])


def test_columns_and_model_are_read_and_written_back(js, dsession):
    lc = dsession.data.light_curve
    assert isinstance(lc.detrend, esl.Detrend) and lc.detrend.columns == ["xc", "yc"] and lc.detrend.poly == 1
    assert isinstance(lc.columns["sky"], np.ndarray) and np.isnan(lc.columns["sky"][207]) and np.isfinite(lc.columns["sky"]).sum() == len(lc.time) - 1
    back = json.loads(dsession.model_dump_json(exclude_none=True))["data"]["light_curve"]
    assert back["columns"]["sky"][207] is None and back["columns"]["xc"] == js["detrend"]["session"]["data"]["light_curve"]["columns"]["xc"]
    assert back["detrend"]["columns"] == ["xc", "yc"]


def test_evaluate_uses_the_regressors(js, dsession):
    ev = dsession.evaluate()
    ref = js["detrend"]
    assert ev.chi2 == pytest.approx(ref["chi2"], rel=1e-12) and ev.lnL == pytest.approx(ref["lnL"], rel=1e-12)
    assert ref["chi2_without"] > 10 * ref["chi2"]          # the systematics are large: without the model the fit is poor
    without = dsession.model_copy(deep=True)
    without.data.light_curve.detrend = None
    assert without.evaluate().chi2 == pytest.approx(ref["chi2_without"], rel=1e-12)


def test_built_in_python_with_numpy_columns(js, dsession):
    src = dsession.data.light_curve
    lc = esl.LightCurve(name="built here", time=np.asarray(src.time), flux=np.asarray(src.flux), flux_err=np.asarray(src.flux_err), epoch=src.epoch, epochs=src.epochs,
                        columns={k: np.asarray(v) for k, v in src.columns.items()}, detrend=esl.Detrend(columns=["xc", "yc"], poly=1))
    s = dsession.model_copy(deep=True)
    s.data.light_curve = lc
    assert s.evaluate().chi2 == pytest.approx(js["detrend"]["chi2"], rel=1e-12)
    with pytest.raises(ValueError):
        esl.LightCurve(time=np.arange(5.0), flux=np.ones(5), flux_err=np.ones(5), columns={"xc": np.ones(4)})


def test_run_matches_node(js, dsession):
    fit = dsession.run(keep_samples=False)
    ref = {p["key"]: p for p in js["detrend"]["result"]["parameters"]}
    for p in fit.result.parameters:
        assert p.median == pytest.approx(ref[p.key]["median"], abs=0.05 * ref[p.key]["plus"])
    assert abs(fit.result["rprs"].median - 0.1) < 3 * fit.result["rprs"].err
