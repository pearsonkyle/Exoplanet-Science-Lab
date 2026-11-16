"""Shared by the example scripts: where the example data are, and a checker that prints and counts.

The data are those of EXOTIC's examples, stored in the repository under public/examples (and, for the two
simulated-transit examples, in test/exotic_fits.json together with EXOTIC's own fits of them). Run the scripts
from a checkout of the repository, or point ESL_REPO at one.
"""
import os
import sys
from pathlib import Path

import numpy as np


def repo() -> Path:
    for cand in [os.environ.get("ESL_REPO"), *Path(__file__).resolve().parents]:
        if cand and (Path(cand) / "public" / "examples" / "toy1873").exists():
            return Path(cand)
    sys.exit("the example data are in the repository (public/examples): run from a checkout, or set ESL_REPO")


def csv(path):
    return np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8")


class Checks:
    """`check(name, condition, detail)` prints ok / FAIL; `finish()` exits non-zero when anything failed."""

    def __init__(self):
        self.failed = 0

    def __call__(self, name, cond, detail=""):
        print(("ok    " if cond else "FAIL  ") + name + (f"   {detail}" if detail else ""))
        self.failed += 0 if cond else 1

    def finish(self):
        if self.failed:
            sys.exit(f"{self.failed} check(s) failed")
        print("all checks passed")


def figures_wanted():
    """Figures are written next to the script unless --no-figures is given."""
    if "--no-figures" in sys.argv:
        return None
    import matplotlib
    matplotlib.use("Agg")
    out = Path(__file__).parent / "output"
    out.mkdir(exist_ok=True)
    return out
