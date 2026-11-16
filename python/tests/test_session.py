"""Sessions: the document round-trips, gives the JavaScript chi-square, and runs to the JavaScript posterior."""
import json
import subprocess
import sys

import numpy as np
import pytest

import esl


@pytest.fixture(scope="module")
def toy(js):
    return esl.Session.model_validate(js["toy"]["session"])


@pytest.fixture(scope="module")
def toy_fit(toy):
    return toy.run()


def test_reads_what_javascript_writes_and_writes_it_back(js, toy, tmp_path):
    doc = js["toy"]["session"]
    assert toy.letters == ["b", "c", "d"] and toy.kepler and toy.free_keys == ["mplanet", "mplanet@c", "mplanet@d"]
    assert isinstance(toy.data.light_curve.time, np.ndarray) and len(toy.data.light_curve.time) == 368
    back = json.loads(toy.model_dump_json(exclude_none=True))
    # every number survives: the floats are the same doubles
    assert back["data"]["light_curve"]["time"] == doc["data"]["light_curve"]["time"]
    assert back["data"]["radial_velocity"][0]["velocity"] == doc["data"]["radial_velocity"][0]["velocity"]
    assert back["planets"][0]["parameters"]["tmid"] == doc["planets"][0]["parameters"]["tmid"]
    assert back["fit"]["free"][1]["prior"] == doc["fit"]["free"][1]["prior"]
    p = toy.save(tmp_path / "toy.json")
    assert esl.Session.load(p).model_dump_json() == toy.model_dump_json()
    assert esl.Session.model_validate_json(p.read_text()).data.light_curve.epochs[1].name == "tess_c"


def test_unknown_keys_pass_through(js):
    doc = json.loads(json.dumps(js["toy"]["session"]))
    doc["planets"][1]["parameters"]["zz_future"] = 1e-4       # a parameter of a model neither this package nor the core knows
    doc["planets"][1]["moon"] = {"mass": 0.01}
    doc["fit"]["sampler"]["future_option"] = 3
    doc["view"] = {"fold": True}
    s = esl.Session.model_validate(doc)
    out = s.to_dict()
    assert out["planets"][1]["parameters"]["zz_future"] == 1e-4 and out["planets"][1]["moon"] == {"mass": 0.01}
    assert out["fit"]["sampler"]["future_option"] == 3 and out["view"] == {"fold": True}
    assert s.planets[1].parameters.zz_future == 1e-4
    assert s.evaluate().chi2 == pytest.approx(js["toy"]["chi2"], abs=1e-6)


def test_unusable_documents_are_refused(js):
    doc = js["toy"]["session"]
    for bad in ({"format": "x", "planets": doc["planets"]}, {**doc, "version": 99}, {**doc, "planets": []}):
        with pytest.raises(ValueError):
            esl.Session.model_validate(bad)
    with pytest.raises(ValueError, match="light curve"):
        esl.LightCurve(time=[1, 2, 3], flux=[1, 1], flux_err=[0.1, 0.1, 0.1])
    with pytest.raises(ValueError, match="unknown limb darkening law"):
        esl.LimbDarkening(law="cubic", coefficients=[0.1])
    assert esl.LimbDarkening(law="squareroot", coefficients=[0.1, 0.6]).law == "sqrt"      # docs/FORMAT.md's name for it


def test_chi_square_equals_javascript_and_exotic(js, toy, exotic_ref):
    ev = toy.evaluate()
    print(f"\nchi2: python {ev.chi2!r}, javascript {js['toy']['chi2']!r}; ln L {ev.lnL!r} vs {js['toy']['lnL']!r}")
    # "to rounding": chi2 is a difference of sums of order 1e8 (README, multi-epoch section), so one unit in the last
    # place of a model value moves it by up to about 1e-7. Node 22 and PyMiniRacer's V8 14 agree exactly here.
    assert ev.chi2 == pytest.approx(js["toy"]["chi2"], abs=1e-6, rel=0)
    assert ev.chi2_parts.light_curve == pytest.approx(js["toy"]["chi2lc"], abs=1e-6, rel=0)
    assert ev.chi2_parts.radial_velocity == pytest.approx(js["toy"]["chi2rv"], abs=1e-9, rel=0)
    assert ev.lnL == pytest.approx(js["toy"]["lnL"], abs=1e-6, rel=0)
    assert ev.n_data == 408
    # EXOTIC's own chi-square of the same data at the injected truth (README: 45.11, 88.80, 190.58, 37.58)
    R = exotic_ref["toy"]
    lc = sum(R["lc"][k]["chi2"] for k in ("tess_b", "tess_c", "tess_d"))
    assert abs(ev.chi2_parts.light_curve - lc) < 0.03
    assert abs(ev.chi2_parts.radial_velocity - R["rv"]["chi2"]) < 0.02
    # per epoch, to two decimals
    L = ev.light_curve
    for k, name in enumerate(("tess_b", "tess_c", "tess_d")):
        sel = L.epoch == k
        assert round(float(np.sum((L.residuals[sel] / L.flux_err[sel]) ** 2)), 2) == round(R["lc"][name]["chi2"], 2)
        assert abs(L.a1[k] - R["lc"][name]["scale"]) < 2e-5


def test_posterior_equals_javascript(js, toy_fit):
    a, b = toy_fit.result, js["toy"]["result"]
    assert a.converged and a.ncalls == b["ncalls"]              # same seed, same path through the sampler
    worst = 0.0
    for p, q in zip(a.parameters, b["parameters"]):
        assert p.key == q["key"]
        sigma = 0.5 * (q["plus"] + q["minus"])
        worst = max(worst, abs(p.median - q["median"]) / sigma)
        assert abs(p.plus - q["plus"]) < 1e-6 * sigma and abs(p.minus - q["minus"]) < 1e-6 * sigma
    print(f"\n{a.ncalls} calls in both; largest difference of a posterior median: {worst:.1e} sigma; ln Z {a.logZ!r} vs {b['logZ']!r}")
    assert worst < 1e-6                                          # far inside sampling noise: rounding only
    assert a.logZ == pytest.approx(b["logZ"], abs=1e-6)
    assert a.chi2 == pytest.approx(b["chi2"], abs=1e-6)
    assert a.derived["K@c"].median == pytest.approx(b["derived"]["K@c"]["median"], rel=1e-9)
    assert a.best["tmid"] == pytest.approx(b["best"]["tmid"], abs=1e-9)


def test_result_object(js, toy, toy_fit):
    r = toy_fit.result
    truth = {p["letter"]: p["parameters"]["mplanet"] for p in js["toy"]["session"]["planets"]}
    assert abs(r["mplanet"].median - truth["b"]) < 3 * max(r["mplanet"].plus, r["mplanet"].minus)
    assert abs(r["mplanet@c"].median - truth["c"]) < 3 * r["mplanet@c"].err
    assert r.samples is not None and r.samples.values.shape[1] == 3 and len(r.samples.logl) == len(r.samples.values) >= 200
    assert set(r.medians) == set(toy.free_keys) and "K" in r.derived and r.n_data == 408
    assert toy_fit.software.version == esl.__version__
    assert toy.result is None                                    # run() returns a new session; the input is untouched
    assert "ln Z" in r.table() and "mplanet@d" in r.table()
    best = toy_fit.best_fit()
    assert best.chi2 == pytest.approx(r.chi2, abs=1e-6) and best.chi2 <= toy.evaluate().chi2 + 0.5
    again = esl.Session.model_validate_json(toy_fit.model_dump_json(exclude_none=True))
    assert again.result.logZ == r.logZ and np.array_equal(again.result.samples.values, r.samples.values)


def test_sampler_overrides_and_progress(toy):
    seen = []
    fit = toy.run(progress=seen.append, nlive=60, seed=11, keep_samples=False)
    assert fit.result.samples is None and fit.result.converged
    assert fit.fit.sampler.nlive == 60 and toy.fit.sampler.nlive == 300
    assert seen and isinstance(seen[0], esl.Progress) and seen[-1].ncalls > 0 and seen[-1].keys == toy.free_keys
    capped = toy.run(maxCalls=500)
    assert not capped.result.converged and "max calls" in capped.result.stop_reason


def test_likelihood_object(js, toy):
    with toy.likelihood() as like:
        assert like.keys == toy.free_keys and like.n_data == 408
        truth = np.array([p["parameters"]["mplanet"] for p in js["toy"]["session"]["planets"]])
        assert like(truth) == pytest.approx(js["toy"]["lnL"], abs=1e-6)
        many = like(np.vstack([truth, truth * 1.5, [-1, 0, 0]]))
        assert many.shape == (3,) and many[0] > many[1] and many[2] == -1e100
        u = like.transform(np.array([[0.5, 0.5, 0.5], [0.0, 1.0, 0.25]]))
        hi = [f.prior.b for f in toy.fit.free]
        assert np.allclose(u[0], 0.5 * np.array(hi)) and np.allclose(u[1], [0, hi[1], 0.25 * hi[2]])
    with pytest.raises(esl.CoreError):
        like(truth)


def test_limb_darkening_follows_the_star(js):
    doc = json.loads(json.dumps(js["toy"]["session"]))
    doc["star"].update(teff=5605, logg=4.47, feh=0.1)
    doc["limb_darkening"] = {"law": "quadratic", "mode": "star", "band": "TESS (approx.)", "coefficients": [0.4, 0.25]}
    s = esl.Session.model_validate(doc)
    ev = s.evaluate()
    want = esl.limb_darkening(5605, 4.47, 0.1, "TESS", "quadratic")
    assert ev.limb_darkening == pytest.approx(want.coeffs, abs=1e-12) and want.source == "table"
    cooler = s.evaluate(at={"teff": 5000})
    assert cooler.limb_darkening[0] > ev.limb_darkening[0] and cooler.chi2 != ev.chi2
    s.free("teff", esl.Prior.normal(5605, 100))
    fit = s.run(nlive=100, seed=2)
    assert fit.result.converged and abs(fit.result["teff"].median - 5605) < 60          # the data say nothing: the prior comes back
    assert fit.result.best["ld0"] == pytest.approx(esl.limb_darkening(fit.result.best["teff"], 4.47, 0.1, "TESS", "quadratic").coeffs[0], abs=2e-4)
    # a custom band needs the wavelength-resolved table, loaded on demand
    doc["limb_darkening"].update(band="Custom range", band_custom=[600, 1000])
    c = esl.Session.model_validate(doc).evaluate()
    assert c.limb_darkening == pytest.approx(esl.limb_darkening(5605, 4.47, 0.1, (600, 1000), "quadratic").coeffs, abs=1e-12)
    assert np.allclose(c.limb_darkening, ev.limb_darkening, atol=0.03)


def test_exported_script_reproduces_the_fit(toy_fit, tmp_path):
    script = toy_fit.to_script()
    (tmp_path / "toy.py").write_text(script)
    out = subprocess.run([sys.executable, "toy.py"], cwd=tmp_path, capture_output=True, text=True, env={**__import__("os").environ, "MPLBACKEND": "Agg"})
    assert out.returncode == 0, out.stderr[-1500:]
    back = esl.Session.load(tmp_path / "toy_1873_result.json")
    for p in toy_fit.result.parameters:
        assert back.result[p.key].median == pytest.approx(p.median, abs=1e-6 * p.err)
    assert "difference / sigma" in out.stdout and "NOTE" not in out.stdout
    for f in ("toy_1873_report.md", "toy_1873_light_curve.png", "toy_1873_rv.png", "toy_1873_rv_phase.png", "toy_1873_posterior.png"):
        assert (tmp_path / f).stat().st_size > 1000
    md = toy_fit.to_markdown()
    assert "## Result" in md and "`mplanet@c`" in md and "How to reproduce" in md
    assert "\\begin{tabular}" in toy_fit.to_latex()


def test_command_line(toy, tmp_path):
    from esl.__main__ import main
    p = toy.save(tmp_path / "s.json")
    assert main(["run", str(p), "--quiet", "--nlive", "60", "--report", str(tmp_path / "r.md"), "--script", str(tmp_path / "r.py")]) == 0
    assert esl.Session.load(tmp_path / "s_result.json").result.converged
    assert "## Result" in (tmp_path / "r.md").read_text() and "esl.Session(" in (tmp_path / "r.py").read_text()
    assert main(["info"]) == 0


def _example_sessions():
    from conftest import ROOT
    out = []
    for path in sorted((ROOT / "public" / "examples").rglob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except ValueError:
            continue
        if isinstance(doc, dict) and doc.get("format") == esl.FORMAT:
            out.append(path)
    return out


@pytest.mark.parametrize("path", _example_sessions(), ids=lambda p: f"{p.parent.name}/{p.name}")
def test_worked_example_session(path):
    """Every session stored with the worked examples (public/examples/**/*.json) loads, keeps its unknown keys and runs.
    Those the web application wrote with a result (public/examples/results) are run as stored and must give the
    browser's posterior; a fit above 60,000 calls is cut short unless ESL_SLOW=1."""
    doc = json.loads(path.read_text())
    s = esl.Session.model_validate(doc)
    kept = s.to_dict()
    assert set(doc) - {k for k, v in doc.items() if v is None} <= set(kept), "top-level keys were lost"
    assert [set(p["parameters"]) - {k for k, v in p["parameters"].items() if v is None} for p in doc["planets"]] == [set(p["parameters"]) for p in kept["planets"]]
    if not s.fit.free:
        assert np.isfinite(s.evaluate().chi2)
        return
    stored = s.result
    full = stored is not None and (stored.ncalls <= 60000 or __import__("os").environ.get("ESL_SLOW"))
    fit = s.run() if full else s.run(nlive=min(s.fit.sampler.nlive, 100), maxCalls=20000)
    r = fit.result
    assert r.ncalls > 0 and np.isfinite(r.logZ) and len(r.parameters) == len(s.fit.free)
    odd = esl.core.call("unregisteredFree", s.to_dict())
    assert bool(odd) == any("not in the parameter registry" in w for w in r.warnings)
    if full:
        worst = max(abs(r[p.key].median - p.median) / p.err for p in stored.parameters)
        print(f"\n{path.name}: browser {stored.ncalls} calls, python {r.ncalls}; largest difference of a median {worst:.1e} sigma; ln Z {stored.logZ:.4f} vs {r.logZ:.4f}")
        assert r.converged == stored.converged
        assert worst < 0.3 and abs(r.logZ - stored.logZ) < 3 * max(stored.logZerr, 0.05) and abs(r.chi2 - stored.chi2) < 1.0
    elif odd:
        print(f"\n{path.name}: free keys the session likelihood of this build does not read: {odd}")


def test_models_added_to_the_core_are_callable_without_changes_here():
    """Phase curves, moons and N-body were added to src/core while this package was written; none is wired into
    sessions yet, and each is reachable by name after a rebuild."""
    mods = esl.core.modules()
    if "phasecurve" in mods:
        t = np.linspace(-0.5, 0.5, 9)
        p = dict(rprs=0.15752, ars=4.872, inc=82.15, per=0.813474, tmid=0.0, ecc=0, omega=0, ldLaw="quadratic", ld=[0.1157, 0.108], fpfs=0.1552, contrast=0.868, hotspot=1.15)
        f = np.array(esl.core.invoke("phasecurve.phaseCurveModel", t, p))
        assert f.shape == (9,) and np.isfinite(f).all() and np.ptp(f) > 0
    if "exomoon" in mods:
        assert "makePlanetMoonTransit" in mods["exomoon"]
    if "nbody" in mods:
        assert "ttvSummary" in mods["nbody"]


def test_free_key_outside_the_registry_is_flagged(toy):
    s = toy.model_copy(deep=True)
    s.planets[1].parameters.zz_future = 0.5
    s.free("zz_future", esl.Prior.uniform(0, 1), planet="c")
    assert esl.core.call("unregisteredFree", s.to_dict()) == ["zz_future@c"]
    r = s.run(nlive=60, seed=3, keep_samples=False).result
    assert "zz_future@c" in r.warnings[0] and "not in the parameter registry" in r.warnings[0]
    assert abs(r["zz_future@c"].median - 0.5) < 0.1 and r["zz_future@c"].err > 0.25      # its posterior is its prior
    assert not any("registry" in w for w in toy.run(nlive=60, seed=3, keep_samples=False).result.warnings)


@pytest.mark.parametrize("runtime", ["v8", "node"])
def test_ctrl_c_returns_what_the_sampler_has(runtime, repo, tmp_path):
    import os
    import signal
    import time
    if os.name == "nt" or runtime not in esl.available_runtimes():
        pytest.skip("needs POSIX signals and the runtime")
    long_fit = repo / "public" / "examples" / "results" / "multi.json"          # nine parameters, two minutes if left alone
    if not long_fit.exists():
        pytest.skip("no long example session")
    code = ("import sys, esl\n"
            f"esl.set_runtime({runtime!r})\n"
            f"fit = esl.Session.load({str(long_fit)!r}).run(progress=lambda p: print('progress', p.ncalls, flush=True))\n"
            "r = fit.result\n"
            "print('RESULT', r.converged, r.stop_reason, r.ncalls, len(r.parameters), flush=True)\n")
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert p.stdout.readline().startswith("progress")                            # the fit is under way
    time.sleep(1.0)
    p.send_signal(signal.SIGINT)
    out, err = p.communicate(timeout=60)
    last = out.strip().splitlines()[-1].split()
    assert p.returncode == 0, err[-800:]
    assert last[0] == "RESULT" and last[1] == "False" and "stopped by user" in out and int(last[-2]) > 0 and last[-1] == "9"
