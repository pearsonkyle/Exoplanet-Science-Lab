"""Shared fixtures. The references are (a) Node running src/core directly, (b) the files in test/ and
public/validation that the JavaScript tests use (scipy quadrature, EXOTIC, pylightcurve), (c) EXOTIC itself when
its conda environment is present."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import esl

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "public" / "examples"
EXOTIC_PYTHON = Path(os.environ.get("EXOTIC_PYTHON", "/Users/kpearson/miniconda3/envs/exotic/bin/python"))
LD_TESS_HD80606 = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333]


def pytest_sessionstart(session):
    """Inside the repository the tests run the core as it is now: the bundle is rebuilt first when it is behind
    the sources (ESL_NO_REBUILD=1 tests the bundle as committed instead)."""
    node = shutil.which("node")
    if node and (ROOT / "tools" / "build_core_bundle.mjs").exists() and not os.environ.get("ESL_NO_REBUILD"):
        if subprocess.run([node, "tools/build_core_bundle.mjs", "--check"], cwd=ROOT, capture_output=True).returncode != 0:
            subprocess.run([node, "tools/build_core_bundle.mjs", "--quiet"], cwd=ROOT, check=True)
            print("conftest: python/esl/_core was behind src/core and has been rebuilt")


def pytest_report_header(config):
    return f"esl {esl.__version__}: {esl.runtime_info()}; runtimes available: {', '.join(esl.available_runtimes())}"


@pytest.fixture(autouse=True)
def _default_runtime():
    yield
    if esl._runtime._choice != os.environ.get("ESL_RUNTIME", "auto").lower():
        esl.set_runtime(os.environ.get("ESL_RUNTIME", "auto"))


@pytest.fixture(scope="session")
def repo():
    if not (ROOT / "src" / "core" / "session.js").exists():
        pytest.skip("not inside the repository: the JavaScript sources and reference files are not here")
    return ROOT


@pytest.fixture(scope="session")
def js(repo):
    """Numbers from Node running src/core directly (python/tests/js/reference.mjs)."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed: no JavaScript reference")
    out = subprocess.run([node, str(repo / "python/tests/js/reference.mjs")], capture_output=True, text=True, cwd=repo)
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout)


@pytest.fixture(scope="session")
def exotic_ref(repo):
    """EXOTIC 4.3.1 and pylightcurve 4.0.4 on the example data (test/make_exotic_reference.py)."""
    return json.loads((repo / "test" / "exotic_reference.json").read_text())


@pytest.fixture(scope="session")
def exotic_fits(repo):
    return json.loads((repo / "test" / "exotic_fits.json").read_text())


def csv(path):
    return np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8")


@pytest.fixture(scope="session")
def toy_system(repo):
    """EXOTIC's three-planet example as a MultiPlanetSystem, built as examples/multi_planet/multi_fit.py builds it."""
    from esl import multi_fitter as m

    def make():
        D = EXAMPLES / "toy1873"
        truth = json.loads((D / "multi_system.json").read_text())
        planets = {k: m.SystemParameters(**p) for k, p in truth["planets"].items()}
        free = {k: m.ParameterSet(mplanet=1, **({"rv_linear": 1} if k == "b" else {})) for k in planets}
        bounds = {k: m.Bounds(upper=m.ParameterSet(**{q: v[1] for q, v in b.items()}), lower=m.ParameterSet(**{q: v[0] for q, v in b.items()})) for k, b in truth["bounds"].items()}

        def lc(n):
            a = csv(D / f"tess_{n}.csv")
            return m.LightCurveData(time=a["BJD"], name=f"tess_{n}", flux=a["flux"], ferr=a["ferr"], airmass=a["airmass"], exp_time=120.0 / (60 * 24))
        a = csv(D / "rv_neid.csv")
        rv = m.RadialVelocityData(time=a["BJD"], name="rv_neid", vel=a["vel"], velerr=a["velerr"])
        rv.local = m.ParameterSet(rv_jitter=1)
        rv.local_bounds = m.Bounds(upper=m.ParameterSet(rv_jitter=15.0), lower=m.ParameterSet(rv_jitter=0.0))
        return m.MultiPlanetSystem(planets=planets, free=free, bounds=bounds, transit=[lc(p) for p in "bcd"], radial_velocity=[rv], name="toy-1873"), truth
    return make
