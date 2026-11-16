"""Command line: ``python -m esl run session.json`` (or ``esl run ...`` once installed).

    esl info                               which engine and which build of the core
    esl run session.json [-o out.json]     run a session exported from the browser; writes the session with its result
                 [--report out.md] [--script out.py] [--figures PREFIX] [--nlive N] [--seed N] [--max-calls N] [--quiet]
    esl script session.json [-o out.py]    write the Python script that reproduces a session
    esl report session.json [-o out.md]    write the Markdown report of a session
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import Session, __version__, available_runtimes, runtime_info, set_runtime


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="esl", description="Exoplanet Science Lab from the command line")
    ap.add_argument("--runtime", default=None, help="auto, v8, node or quickjs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    r = sub.add_parser("run"); r.add_argument("session"); r.add_argument("-o", "--output"); r.add_argument("--report"); r.add_argument("--script")
    r.add_argument("--figures", metavar="PREFIX"); r.add_argument("--nlive", type=int); r.add_argument("--seed", type=int); r.add_argument("--max-calls", type=float); r.add_argument("--quiet", action="store_true")
    for name in ("script", "report"):
        p = sub.add_parser(name); p.add_argument("session"); p.add_argument("-o", "--output")
    a = ap.parse_args(argv)
    if a.runtime:
        set_runtime(a.runtime)
    if a.cmd == "info":
        print(f"exoplanet-science-lab {__version__}\n{runtime_info()}\navailable runtimes: {', '.join(available_runtimes())}")
        return 0
    s = Session.load(a.session)
    stem = Path(a.session).with_suffix("")
    if a.cmd == "script":
        Path(a.output or f"{stem}.py").write_text(s.to_script(), encoding="utf-8"); return 0
    if a.cmd == "report":
        Path(a.output or f"{stem}.md").write_text(s.to_markdown(session_file=Path(a.session).name), encoding="utf-8"); return 0
    over = {k: v for k, v in (("nlive", a.nlive), ("seed", a.seed), ("maxCalls", a.max_calls)) if v is not None}
    if not a.quiet:
        print(s.summary()); print(runtime_info())
    fit = s.run(progress=not a.quiet, **over)
    out = fit.save(a.output or f"{stem}_result.json")
    if not a.quiet:
        print(fit.result.table()); print(f"wrote {out}")
    if a.report:
        Path(a.report).write_text(fit.to_markdown(session_file=out.name), encoding="utf-8")
    if a.script:
        Path(a.script).write_text(fit.to_script(), encoding="utf-8")
    if a.figures:
        import matplotlib
        matplotlib.use("Agg")
        from . import plot
        d = fit.data
        if d.light_curve is not None and fit.fit.use.lc:
            plot.light_curve(fit).savefig(f"{a.figures}_light_curve.png", dpi=150)
        if d.radial_velocity and fit.fit.use.rv:
            plot.radial_velocity(fit).savefig(f"{a.figures}_rv.png", dpi=150)
        if d.timing:
            plot.oc(fit).savefig(f"{a.figures}_oc.png", dpi=150)
        plot.corner(fit).savefig(f"{a.figures}_posterior.png", dpi=150)
    return 0 if fit.result.converged else 2


if __name__ == "__main__":
    sys.exit(main())
