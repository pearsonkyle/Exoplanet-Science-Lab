"""Figures with matplotlib, in the manner of EXOTIC's examples: best-fit light curves (per observation, or folded
per planet), radial velocities against time and phase, the posterior coloured by likelihood, and O - C.

Every function takes a session (after ``run`` the best fit is drawn, before it the session's own values) and
returns a matplotlib Figure; nothing is shown or saved for you::

    import esl.plot
    esl.plot.light_curve(fit, fold=True).savefig("lc.png", dpi=150)
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from . import functions as _f
from .models import ModelEvaluation, Session

#: the colour cycle of EXOTIC's combined figures, which the web application uses on exported figures too
COLORS = ["tab:blue", "tab:orange", "tab:red", "tab:green", "tab:purple", "tab:brown", "tab:pink", "tab:gray", "tab:olive", "tab:cyan"]


def _plt():
    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:  # pragma: no cover
        raise ImportError("plotting needs matplotlib (pip install 'exoplanet-science-lab[plot]')") from exc
    return plt


def _best(session: Session) -> ModelEvaluation:
    return session.best_fit()


def _planet_params(session: Session, ev: ModelEvaluation, i: int) -> Dict[str, Any]:
    q = dict(ev.planets[i])
    q.update(ld=list(ev.limb_darkening), law=session.limb_darkening.law, mstar=ev.values.get("mstar"), rstar=ev.values.get("rstar"))
    return {k: v for k, v in q.items() if v is not None and k != "letter"}


def _phase(t: np.ndarray, per: float, tmid: float) -> np.ndarray:
    return (t - tmid + 0.5 * per) % per - 0.5 * per


def _bin(x: np.ndarray, y: np.ndarray, n: int) -> Any:
    if len(x) < 2 * n:
        return None
    edges = np.linspace(x.min(), x.max(), n + 1)
    idx = np.clip(np.digitize(x, edges) - 1, 0, n - 1)
    cnt = np.bincount(idx, minlength=n)
    ok = cnt > 2
    mean = np.bincount(idx, weights=y, minlength=n)[ok] / cnt[ok]
    sq = np.bincount(idx, weights=y * y, minlength=n)[ok] / cnt[ok]
    return 0.5 * (edges[:-1] + edges[1:])[ok], mean, np.sqrt(np.maximum(sq - mean * mean, 0) / cnt[ok])


def light_curve(session: Session, fold: Optional[bool] = None, bins: int = 30, figsize: Optional[Sequence[float]] = None) -> Any:
    """The light curve with its best-fit model.

    ``fold=False``: one row per observation (epoch): data and model against time, and residuals in units of sigma.
    ``fold=True``: one panel per planet, phase-folded on its period with the baseline and the other planets'
    transits divided out, the model as a smooth curve, and binned points. Default: folded when there are more
    than six observations.
    """
    plt = _plt()
    ev = _best(session)
    L = ev.light_curve
    if L is None:
        raise ValueError("the session has no light curve in the fit")
    nep = int(L.epoch.max()) + 1 if L.epoch is not None else 1
    fold = nep > 6 if fold is None else fold
    exptime = (session.data.light_curve.exposure_min or 0.0) / 1440 if session.data.light_curve else 0.0
    if not fold:
        fig, axes = plt.subplots(nep, 2, figsize=figsize or (11, 3 * nep), squeeze=False)
        for k in range(nep):
            sel = np.ones(len(L.time), bool) if L.epoch is None else (L.epoch == k)
            c, t0 = COLORS[k % len(COLORS)], float(np.floor(L.time[sel].min()))
            a, b = axes[k]
            a.errorbar(L.time[sel] - t0, L.flux[sel], yerr=L.flux_err[sel], fmt=".", color=c, ms=3, alpha=0.5, elinewidth=0.5, label="data")
            o = np.argsort(L.time[sel])
            a.plot(L.time[sel][o] - t0, L.model[sel][o], color="k", lw=1.2, label="model")
            name = (L.epochs[k] if k < len(L.epochs) else L.name) or f"epoch {k + 1}"
            a.set_title(f"{name}: scale = {L.a1[k]:.4f} (resid std {np.std(L.residuals[sel]):.1e})", fontsize=10)
            a.set_ylabel("flux"); a.set_xlabel(f"time - {t0:.0f}"); a.legend(loc="lower right", fontsize=8)
            b.plot(L.time[sel] - t0, L.residuals[sel] / L.flux_err[sel], ".", color=c, ms=3)
            b.axhline(0, color=c, ls="--"); b.set_ylabel(r"residuals [$\sigma$]"); b.set_xlabel(f"time - {t0:.0f}")
        fig.suptitle(f"{session.name or ''} light curve" + (" (best fit)" if session.result else ""))
        fig.tight_layout()
        return fig
    npl = len(ev.planets)
    fig, axes = plt.subplots(2, npl, figsize=figsize or (5.2 * npl, 5.5), squeeze=False, sharex="col", gridspec_kw={"height_ratios": [3, 1]})
    for i, q in enumerate(ev.planets):
        others = np.ones(len(L.time))
        for j, tr in enumerate(L.transits):
            if j != i:
                others = others * tr
        y, res = L.flux / L.baseline / others, L.flux / L.baseline - L.transit
        ph = _phase(L.time, q["per"], q["tmid"])
        dur = _f.events(_planet_params(session, ev, i)).get("t14") or 0.1 * q["per"]
        win = min(0.5 * q["per"], max(1.5 * dur, 3 * np.median(np.diff(np.sort(L.time)))))
        near = np.abs(ph) < win
        a, b = axes[0, i], axes[1, i]
        for k in range(nep):
            sel = near & (np.ones(len(L.time), bool) if L.epoch is None else (L.epoch == k))
            if sel.any():
                a.plot(ph[sel] * 24, y[sel], ".", color=COLORS[k % len(COLORS)], ms=3, alpha=0.45)
                b.plot(ph[sel] * 24, res[sel] * 1e6, ".", color=COLORS[k % len(COLORS)], ms=3, alpha=0.45)
        grid = np.linspace(-win, win, 600)
        a.plot(grid * 24, _f.transit(q["tmid"] + grid, _planet_params(session, ev, i), exptime=exptime), color="k", lw=1.4, zorder=5)
        bn = _bin(ph[near], y[near], bins)
        if bn is not None:
            a.errorbar(bn[0] * 24, bn[1], yerr=bn[2], fmt="o", color="w", mec="k", ecolor="k", ms=4, zorder=6)
        a.set_title(f"planet {q.get('letter', i)}: Rp/R* = {q['rprs']:.4f}, P = {q['per']:.6f} d", fontsize=10)
        a.set_ylabel("relative flux"); b.set_ylabel("residuals [ppm]"); b.set_xlabel("time from mid-transit [h]"); b.axhline(0, color="k", ls="--", lw=0.8)
    fig.tight_layout()
    return fig


def radial_velocity(session: Session, fold: bool = False, figsize: Optional[Sequence[float]] = None) -> Any:
    """Radial velocities with the best-fit model.

    ``fold=False``: velocities minus each instrument's zero point against time, the model as a smooth curve, residuals below.
    ``fold=True``: one panel per planet against orbital phase, the other planets and the trend subtracted.
    """
    plt = _plt()
    ev = _best(session)
    if not ev.radial_velocity:
        raise ValueError("the session has no radial velocities in the fit")
    tref = ev.rv_tref if ev.rv_tref is not None else min(float(r.time.min()) for r in ev.radial_velocity)
    lin, quad = ev.values.get("rvlin", 0.0) or 0.0, ev.values.get("rvquad", 0.0) or 0.0
    pars = [_planet_params(session, ev, i) for i in range(len(ev.planets))]
    err = lambda r: np.hypot(r.velocity_err, r.jitter)      # noqa: E731
    if not fold:
        fig, (a, b) = plt.subplots(2, 1, figsize=figsize or (10, 6), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
        t0, t1 = min(float(r.time.min()) for r in ev.radial_velocity), max(float(r.time.max()) for r in ev.radial_velocity)
        pmin = min(q["per"] for q in ev.planets)
        n = int(min(20000, max(800, 40 * (t1 - t0) / pmin)))
        grid = np.linspace(t0, t1, n)
        a.plot(grid - tref, _f.radial_velocity(grid, pars, rvlin=lin, rvquad=quad, tref=tref), color="k", lw=0.8, alpha=0.7, label="model")
        for k, r in enumerate(ev.radial_velocity):
            c = COLORS[k % len(COLORS)]
            a.errorbar(r.time - tref, r.velocity - r.gamma, yerr=err(r), fmt="o", color=c, ms=4, label=f"{r.name} (offset {r.gamma:.1f} m/s)")
            b.errorbar(r.time - tref, r.residuals, yerr=err(r), fmt="o", color=c, ms=4)
        a.set_ylabel("RV [m/s]"); a.legend(fontsize=8); b.axhline(0, color="k", ls="--", lw=0.8)
        b.set_ylabel("residuals [m/s]"); b.set_xlabel(f"time - {tref:.2f} [d]")
        fig.tight_layout()
        return fig
    npl = len(ev.planets)
    fig, axes = plt.subplots(2, npl, figsize=figsize or (5.2 * npl, 5.5), squeeze=False, sharex="col", gridspec_kw={"height_ratios": [3, 1]})
    for i, q in enumerate(ev.planets):
        a, b = axes[0, i], axes[1, i]
        grid = np.linspace(-0.5, 0.5, 500)
        a.plot(grid, _f.radial_velocity(q["tmid"] + grid * q["per"], pars[i]), color="k", lw=1.2)
        for k, r in enumerate(ev.radial_velocity):
            c = COLORS[k % len(COLORS)]
            own = r.velocity - r.gamma - r.model + r.planets[i]
            ph = _phase(r.time, q["per"], q["tmid"]) / q["per"]
            a.errorbar(ph, own, yerr=err(r), fmt="o", color=c, ms=4, label=r.name if i == 0 else None)
            b.errorbar(ph, r.residuals, yerr=err(r), fmt="o", color=c, ms=4)
        K = 0.5 * np.ptp(_f.radial_velocity(q["tmid"] + grid * q["per"], pars[i]))
        a.set_title(f"planet {q.get('letter', i)}: K = {K:.2f} m/s, P = {q['per']:.5f} d", fontsize=10)
        a.set_ylabel("RV [m/s]"); b.set_ylabel("residuals [m/s]"); b.set_xlabel("orbital phase (0 = mid-transit)"); b.axhline(0, color="k", ls="--", lw=0.8)
        if i == 0:
            a.legend(fontsize=8)
    fig.tight_layout()
    return fig


def oc(session: Session, figsize: Optional[Sequence[float]] = None) -> Any:
    """Observed minus calculated mid-transit and mid-eclipse times, in minutes, against the best-fit orbit."""
    plt = _plt()
    ev = session.evaluate(at=session.result.best if session.result else None, use={"timing": True})
    if not ev.timing:
        raise ValueError("the session has no timing data")
    fig, axes = plt.subplots(len(ev.timing), 1, figsize=figsize or (8, 3.2 * len(ev.timing)), squeeze=False)
    for ax, x in zip(axes[:, 0], ev.timing):
        ax.errorbar(x.epoch, x.residuals * 1440, yerr=x.err * 1440, fmt="o", color="tab:blue" if x.kind == "transit" else "tab:red", ms=5)
        ax.axhline(0, color="k", ls="--", lw=0.8)
        ax.set_xlabel("epoch"); ax.set_ylabel("O - C [min]")
        ax.set_title(f"planet {x.planet}: mid-{x.kind} times (chi2 = {float(np.sum((x.residuals / x.err) ** 2)):.1f} for {len(x.time)})", fontsize=10)
    fig.tight_layout()
    return fig


def corner(session: Session, truths: Optional[Dict[str, float]] = None, keys: Optional[List[str]] = None, labels: Optional[Dict[str, str]] = None,
           figsize: Optional[Sequence[float]] = None, cmap: str = "viridis") -> Any:
    """The posterior: every pair of parameters as a scatter of the draws coloured by chi-square (-2 ln L, darker is
    better, as in EXOTIC's figures), histograms on the diagonal with the median and 68% interval, truths as lines."""
    plt = _plt()
    r = session.result
    if r is None or r.samples is None or not len(r.samples.values):
        raise ValueError("run the session first (and keep the samples)")
    keys = keys or list(r.samples.keys)
    X = np.column_stack([r.samples.column(k) + (session.time_reference if k.split("@")[0] == "tmid" else 0.0) for k in keys])
    chi2 = -2 * np.asarray(r.samples.logl)
    order = np.argsort(-chi2)                        # best points drawn last
    vmin, vmax = np.percentile(chi2, [1, 95])
    n = len(keys)
    fig, axes = plt.subplots(n, n, figsize=figsize or (2.4 * n + 1, 2.4 * n + 1), squeeze=False)
    name = lambda k: (labels or {}).get(k, k)       # noqa: E731
    off = [float(np.floor(np.median(X[:, j]))) if k.split("@")[0] == "tmid" else 0.0 for j, k in enumerate(keys)]
    for i in range(n):
        for j in range(n):
            ax = axes[i, j]
            if j > i:
                ax.axis("off"); continue
            if i == j:
                ax.hist(X[:, i] - off[i], bins=max(10, int(np.sqrt(len(X)))), color="black", histtype="step")
                lo, med, hi = np.percentile(X[:, i], [15.87, 50, 84.13])
                ax.set_title(f"{name(keys[i])}\n{med - off[i]:.5g} +{hi - med:.2g} -{med - lo:.2g}", fontsize=8)
                ax.set_yticks([])
                if truths and keys[i] in truths:
                    ax.axvline(truths[keys[i]] - off[i], color="tab:red", lw=1)
            else:
                ax.scatter(X[order, j] - off[j], X[order, i] - off[i], c=chi2[order], s=3, cmap=cmap, vmin=vmin, vmax=vmax, rasterized=True)
                if truths and keys[j] in truths:
                    ax.axvline(truths[keys[j]] - off[j], color="tab:red", lw=1)
                if truths and keys[i] in truths:
                    ax.axhline(truths[keys[i]] - off[i], color="tab:red", lw=1)
            if i == n - 1:
                ax.set_xlabel(name(keys[j]) + (f" - {off[j]:.0f}" if off[j] else ""), fontsize=8)
            else:
                ax.set_xticklabels([])
            if j == 0 and i > 0:
                ax.set_ylabel(name(keys[i]) + (f" - {off[i]:.0f}" if off[i] else ""), fontsize=8)
            elif i != j:
                ax.set_yticklabels([])
            ax.tick_params(labelsize=7)
            for lab in ax.get_xticklabels():
                lab.set_rotation(45)
    fig.tight_layout()
    return fig


def ephemeris(fit: "_f.EphemerisFit", times: Any, errors: Any, figsize: Sequence[float] = (8, 4)) -> Any:
    """O - C of mid-transit times against a fitted ephemeris (relative to its linear part), in minutes."""
    plt = _plt()
    t, e = np.asarray(times, float), np.asarray(errors, float)
    E = np.asarray(fit.epochs, float)
    lin = fit.t0 + fit.per * E
    fig, ax = plt.subplots(figsize=figsize)
    ax.errorbar(E, (t - lin) * 1440, yerr=e * 1440, fmt="o", ms=4, color="tab:blue")
    g = np.linspace(E.min(), E.max(), 300)
    ax.plot(g, 0.5 * fit.dPdE * g * g * 1440, color="k", lw=1)
    ax.set_xlabel("epoch"); ax.set_ylabel("O - C [min]")
    ax.set_title(f"T0 = {fit.t0:.6f} +- {fit.err['t0']:.6f}, P = {fit.per:.8f} +- {fit.err['per']:.8f} d, chi2/dof = {fit.reduced_chi2:.2f}", fontsize=9)
    fig.tight_layout()
    return fig


def periodogram(pg: "_f.TimingPeriodogram", figsize: Sequence[float] = (8, 6)) -> Any:
    """The periodograms of the timing residuals with their false-alarm levels and strongest peaks."""
    plt = _plt()
    stages = [p for p in pg.periodograms if p is not None]
    fig, axes = plt.subplots(len(stages), 1, figsize=figsize, squeeze=False)
    for ax, p in zip(axes[:, 0], stages):
        ax.semilogx(p.period * pg.period, p.power, color="k", lw=0.8)
        for lev in p.fapLevels:
            ax.axhline(lev["power"], color="tab:red", ls=":", lw=0.8)
            ax.text(ax.get_xlim()[1], lev["power"], f" FAP {lev['fap']:g}", va="center", fontsize=7, color="tab:red")
        if p.peaks:
            ax.axvline(p.peaks[0]["periodDays"], color="tab:blue", lw=0.8, ls="--")
            ax.set_title(f"{p.label}: strongest peak {p.peaks[0]['periodDays']:.2f} d, FAP {p.peaks[0]['fap']:.2g}", fontsize=9)
        ax.set_xlabel("period [d]"); ax.set_ylabel("power")
    fig.tight_layout()
    return fig
