"""Reproduce an analysis exported from the web application.

public/examples/results/*.json are sessions the application wrote, each with the result the browser obtained.
This script loads one, runs it with the Python package and compares: same model, same likelihood, same sampler,
same seed. It then writes what the application's export menu writes: the session with the Python result, the
Markdown report, the LaTeX tables and a standalone Python script that rebuilds the analysis line by line.

    python 07_browser_export.py [session.json]

Should print, for the bundled single-transit session (HAT-P-32 b preset, four free parameters): about 18,000
likelihood calls, the browser's posterior reproduced to rounding (the difference column reads 0.000), and the
time it took (the README records about 1.5 s for such a fit in the browser).
"""
import sys
import time
from pathlib import Path

import esl
from _common import Checks, figures_wanted, repo

check = Checks()
path = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else repo() / "public/examples/results/single.json"
session = esl.Session.load(path)                       # equivalently: esl.Session.model_validate_json(open(path).read())
print(session.summary())
print("running on", esl.runtime_info())
browser = session.result

t0 = time.time()
fit = session.run(progress=True)
seconds = time.time() - t0
r = fit.result
print(r.table())

if browser is None:
    print("the session holds no browser result to compare with")
else:
    print(f"\n{'parameter':<12}{'browser':>18}{'python':>18}{'difference / sigma':>22}")
    worst = 0.0
    for p in browser.parameters:
        pull = (r[p.key].median - p.median) / p.err
        worst = max(worst, abs(pull))
        print(f"{p.key:<12}{p.median:>18.10g}{r[p.key].median:>18.10g}{pull:>22.3f}")
    print(f"ln Z: browser {browser.logZ:.4f}, python {r.logZ:.4f} +- {r.logZerr:.2f};  calls: browser {browser.ncalls}, python {r.ncalls};  "
          f"seconds: browser {browser.seconds:.1f}, python {seconds:.1f}")
    check("the browser's posterior is reproduced within sampling noise", worst < 0.3 and abs(r.logZ - browser.logZ) < 3 * browser.logZerr, f"largest difference {worst:.1e} sigma")
    check("chi-square of the best fit agrees", abs(r.chi2 - browser.chi2) < 0.5, f"{r.chi2:.3f} against {browser.chi2:.3f}")
check("converged", r.converged, f"{r.ncalls} calls in {seconds:.1f} s: {r.ncalls / seconds:.0f} likelihood calls per second")

out = figures_wanted()
if out:
    import esl.plot
    stem = path.stem
    fit.save(out / f"{stem}_python.json")
    (out / f"{stem}_report.md").write_text(fit.to_markdown(session_file=f"{stem}_python.json"))
    (out / f"{stem}_tables.tex").write_text(fit.to_latex())
    (out / f"{stem}_reproduce.py").write_text(fit.to_script())
    if fit.data.light_curve is not None and fit.fit.use.lc:
        esl.plot.light_curve(fit).savefig(out / f"{stem}_light_curve.png", dpi=150)
    if fit.data.radial_velocity and fit.fit.use.rv:
        esl.plot.radial_velocity(fit, fold=True).savefig(out / f"{stem}_rv_phase.png", dpi=150)
    esl.plot.corner(fit).savefig(out / f"{stem}_posterior.png", dpi=150)
    print(f"wrote {out}/{stem}_*")
check.finish()
