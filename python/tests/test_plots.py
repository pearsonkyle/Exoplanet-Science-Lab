"""The figures are produced (their content is checked by eye, not here)."""
import matplotlib

matplotlib.use("Agg")
import numpy as np  # noqa: E402
import pytest  # noqa: E402

import esl  # noqa: E402
import esl.plot  # noqa: E402
from esl import multi_fitter as m  # noqa: E402

from conftest import EXAMPLES, csv  # noqa: E402


@pytest.fixture(scope="module")
def fit(toy_system):
    system, truth = toy_system()
    return m.MultiPlanetFit(system, live=100, seed=1, verbose=False), truth


def _ok(fig, tmp_path, name, axes):
    assert len(fig.axes) == axes, f"{name}: {len(fig.axes)} axes"
    p = tmp_path / f"{name}.png"
    fig.savefig(p, dpi=60)
    assert p.stat().st_size > 5000
    import matplotlib.pyplot as plt
    plt.close(fig)


def test_fit_figures(fit, tmp_path):
    f, truth = fit
    _ok(f.plot_lightcurves(), tmp_path, "lc", 6)                    # three observations: data + model, residuals
    _ok(f.plot_lightcurves(fold=True), tmp_path, "lc_fold", 6)      # three planets, folded
    _ok(f.plot_rv(), tmp_path, "rv", 2)
    _ok(f.plot_rv(fold=True), tmp_path, "rv_fold", 6)
    _ok(f.plot_posterior(truths={"b_mplanet": truth["planets"]["b"]["mplanet"]}), tmp_path, "corner", 25)
    _ok(esl.plot.light_curve(f.session.model_copy(update={"result": None})), tmp_path, "lc_before_fit", 6)
    with pytest.raises(ValueError, match="timing"):
        f.plot_oc()
    with pytest.raises(ValueError, match="run the session"):
        esl.plot.corner(f.session.model_copy(update={"result": None}))


def test_timing_figures(repo, tmp_path):
    a = csv(EXAMPLES / "ephemeris" / "transit_times.csv")
    e = esl.fit_ephemeris(a["tmid"], a["err"], period=2.7962868)
    _ok(esl.plot.ephemeris(e, a["tmid"], a["err"]), tmp_path, "oc", 1)
    _ok(esl.plot.periodogram(esl.periodogram(a["tmid"], a["err"], period=2.7962868)), tmp_path, "pg", 2)
    s = esl.Session(planets=[esl.Planet(letter="b", parameters=dict(rprs=0.1, ars=8.5, inc=87.5, per=float(e.per), tmid=float(e.t0)))],
                    data=esl.Data(timing=[esl.TimingPoint(planet="b", time=float(t), err=float(s)) for t, s in zip(a["tmid"], a["err"])]))
    fig = esl.plot.oc(s)
    assert np.isfinite(fig.axes[0].get_ylim()).all()
    _ok(fig, tmp_path, "oc_session", 1)
