"""The bundle and the runtimes."""
import json
import shutil

import numpy as np
import pytest

import esl
from esl import _runtime


def test_bundle_is_the_one_the_manifest_describes():
    import hashlib
    man = json.loads((_runtime.CORE_DIR / "manifest.json").read_text())
    info = esl.core.info()
    assert info["version"] == man["version"] == esl.__version__
    assert info["sourceHash"] == man["sourceHash"]
    for name, f in man["files"].items():
        assert hashlib.sha256((_runtime.CORE_DIR / name).read_bytes()).hexdigest() == f["sha256"], f"{name} was edited after the build"


def test_bundle_is_current_with_the_sources(repo):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    import subprocess
    out = subprocess.run([node, "tools/build_core_bundle.mjs", "--check"], cwd=repo, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr + "\n(run `node tools/build_core_bundle.mjs`)"


def test_every_core_module_is_reachable():
    mods = esl.core.modules()
    for name in ("session", "model", "nested", "transit", "rv", "kepler", "limbdark", "ldest", "ephemeris", "periodogram", "catalog", "derive"):
        assert name in mods
    assert "runSession" in mods["session"] and "buildProblem" in mods["model"]
    # anything exported by the core can be called by name, with no wrapper in this package
    ev = esl.core.invoke("kepler.eventTimes", dict(rprs=0.1, ars=10, inc=88, per=3.5, tmid=0.0, ecc=0.0, omega=0.0))
    assert 0.1 < ev["t14"] < 0.2
    assert esl.core.invoke("derive.C")["Rsun"] == 6.957e8
    assert esl.core.invoke("limbdark.toClaret", "quadratic", [0.4, 0.26]) == [0, 0.4 + 2 * 0.26, 0, -0.26]
    with pytest.raises(esl.CoreError, match="not exported"):
        esl.core.invoke("kepler.nope")


def test_errors_carry_the_core_message():
    with pytest.raises(esl.CoreError, match="unknown limb darkening law"):
        esl.transit([0.0], dict(rprs=0.1, ars=10, inc=88, per=3.5, tmid=0.0, ld=[0.1], law="cubic"))
    with pytest.raises(esl.CoreError, match="coefficients"):
        esl.transit([0.0], dict(rprs=0.1, ars=10, inc=88, per=3.5, tmid=0.0, ld=[0.1, 0.2, 0.3], law="quadratic"))


P = dict(rprs=0.1, ars=94.45, inc=89.269, per=111.4367, tmid=2458888.0757, ecc=0.93132, omega=-58.699, ld=[0.4939, -0.0729, 0.4578, -0.2158])
T = 2458887.6 + 0.0025 * np.arange(400)


@pytest.mark.parametrize("runtime", ["node", "quickjs"])
def test_other_runtimes_give_the_same_model(runtime):
    if runtime not in esl.available_runtimes():
        pytest.skip(f"{runtime} is not available")
    ref = esl.transit(T, P)
    esl.set_runtime(runtime)
    assert runtime in esl.runtime_info().lower()
    other = esl.transit(T, P)
    # the engines' own sin/cos/acos differ in the last digit; the model does not amplify it
    assert np.max(np.abs(other - ref)) < 5e-15
    assert ref.min() < 0.995


def test_nan_and_numpy_scalars_cross_the_boundary():
    f = esl.transit(np.array([np.float32(0.0), 0.01]), dict(rprs=np.float64(0.1), ars=10, inc=np.int64(88), per=3.5, tmid=0.0, ld=np.array([0.4, 0.26])))
    assert f.shape == (2,) and f[0] < 1
    assert _runtime.to_json([float("nan"), {"a": np.array([1.0, np.inf])}]) == '[null,{"a":[1.0,null]}]'


def test_models_have_json_schemas():
    # "pydantic classes ... so we can make apis with it": FastAPI and friends need the schema
    for cls in (esl.Session, esl.Result, esl.ModelEvaluation, esl.EphemerisFit):
        schema = cls.model_json_schema()
        assert schema["type"] == "object" and schema["properties"]
    from esl import multi_fitter as m
    assert "planets" in m.MultiPlanetSystem.model_json_schema()["properties"]


@pytest.mark.parametrize("runtime", ["node", "quickjs"])
def test_other_runtimes_run_a_fit_and_the_catalogue(runtime, js, repo):
    if runtime not in esl.available_runtimes():
        pytest.skip(f"{runtime} is not available")
    s = esl.Session.model_validate(js["toy"]["session"])
    ref = s.run(nlive=50, seed=1, keep_samples=False).result
    esl.set_runtime(runtime)
    seen = []
    other = s.run(nlive=50, seed=1, keep_samples=False, progress=seen.append).result
    worst = max(abs(other[p.key].median - p.median) / p.err for p in ref.parameters)
    print(f"\n{runtime}: {other.ncalls} calls ({ref.ncalls} under V8), largest difference of a median {worst:.1e} sigma, {len(seen)} progress reports")
    assert other.converged and worst < (1e-6 if runtime == "node" else 0.5)
    if runtime == "node":
        assert other.ncalls == ref.ncalls
        s.run(progress=seen.append)                                # a fit long enough to report (0.3 s)
        assert seen and seen[-1].ncalls > 0                        # progress streams over the pipe
    hit = esl.lookup("WASP-12 b")                                   # files are read by Python on the core's request, in every runtime
    assert hit.host == "WASP-12" and abs(hit.session.planets[0].parameters.per - 1.0914) < 1e-3
