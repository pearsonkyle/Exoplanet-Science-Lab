"""Speed of each JavaScript runtime on a typical single-transit fit, against Node running src/core directly.

    python python/benchmarks/runtime_bench.py [--quickjs]

Prints, per runtime: microseconds per likelihood call (the bare model), and the wall time, number of calls and
calls per second of a complete nested-sampling run (the same session, the same seed, so the same number of calls).
"""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

import esl

ROOT = Path(__file__).resolve().parents[2]


def single_transit_session(n=400, seed=1):
    """A ground-based night of a hot Jupiter with an airmass trend: four free parameters."""
    rng = np.random.default_rng(seed)
    truth = dict(rprs=0.1504, ars=6.05, inc=88.9, per=2.150008, tmid=2455867.402743, ecc=0.0, omega=0.0)
    t = truth["tmid"] + np.linspace(-0.13, 0.13, n)
    airmass = 1.0 / np.cos(np.radians(20 + 35 * np.abs(np.linspace(-1, 1, n))))
    flux = esl.transit(t, {**truth, "ld": [0.4, 0.26], "law": "quadratic"}) * 1.002 * np.exp(-0.01 * airmass)
    err = np.full(n, 0.0015)
    flux = flux + rng.normal(0, err)
    return esl.Session(
        name="benchmark", star=esl.Star(teff=6200, rstar=1.2, mstar=1.16),
        limb_darkening=esl.LimbDarkening(law="quadratic", coefficients=[0.4, 0.26]),
        planets=[esl.Planet(letter="b", parameters=truth)], time_reference=float(np.floor(t[0])),
        data=esl.Data(light_curve=esl.LightCurve(name="night 1", time=t, flux=flux, flux_err=err, airmass=airmass, exposure_min=0)),
        fit=esl.FitSettings(free=[
            esl.FreeParameter(key="rprs", prior=esl.Prior.uniform(0.1, 0.2)),
            esl.FreeParameter(key="tmid", prior=esl.Prior.uniform(truth["tmid"] - 0.02, truth["tmid"] + 0.02)),
            esl.FreeParameter(key="inc", prior=esl.Prior.uniform(85, 90)),
            esl.FreeParameter(key="a2", prior=esl.Prior.uniform(-0.1, 0.1)),
        ], sampler=esl.Sampler(nlive=400, seed=42)),
    )


def bench(runtime, session):
    esl.set_runtime(runtime)
    t0 = time.perf_counter(); esl.runtime_info(); boot = time.perf_counter() - t0
    with session.likelihood() as like:
        theta = like.transform(np.full((1, like.ndim), 0.5))
        like(theta, repeat=200 if runtime == "quickjs" else 2000)
        nrep = 500 if runtime == "quickjs" else 20000
        t0 = time.perf_counter(); like(theta, repeat=nrep); per = (time.perf_counter() - t0) / nrep
    t0 = time.perf_counter(); fit = session.run(); sec = time.perf_counter() - t0
    r = fit.result
    return dict(runtime=esl.runtime_info().split(";")[0], boot_s=boot, likelihood_us=per * 1e6, ncalls=r.ncalls, seconds=sec, calls_per_s=r.ncalls / sec, logZ=r.logZ, medians=[p.median for p in r.parameters])


def main():
    session = single_transit_session()
    rows = []
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "bench.json"
        session.save(path)
        out = subprocess.run(["node", str(ROOT / "python/benchmarks/native.mjs"), str(path)], capture_output=True, text=True)
        if out.returncode == 0:
            rows.append(json.loads(out.stdout))
        else:
            print("node native failed:", out.stderr[-400:], file=sys.stderr)
    for rt in ["v8", "node"] + (["quickjs"] if "--quickjs" in sys.argv else []):
        if rt in esl.available_runtimes():
            rows.append(bench(rt, session))
    print(f"{'runtime':<44}{'us / likelihood':>16}{'calls':>9}{'seconds':>9}{'calls / s':>11}{'ln Z':>12}")
    for r in rows:
        print(f"{r['runtime']:<44}{r['likelihood_us']:>16.1f}{r['ncalls']:>9d}{r['seconds']:>9.2f}{r['calls_per_s']:>11.0f}{r['logZ']:>12.4f}")
    worst = max(abs(a - b) / abs(b) for r in rows for a, b in zip(r["medians"], rows[0]["medians"]))
    same = all(r["ncalls"] == rows[0]["ncalls"] for r in rows)
    print(f"same number of calls in every runtime: {same}; largest relative difference of a posterior median: {worst:.1e}")
    return rows


if __name__ == "__main__":
    main()
