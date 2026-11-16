"""The example scripts run and their own checks pass (each states the numbers it should print and asserts them)."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
SCRIPTS = sorted(p.name for p in EXAMPLES.glob("[0-9]*.py"))


@pytest.mark.parametrize("script", SCRIPTS)
def test_example(script, repo):
    out = subprocess.run([sys.executable, script, "--no-figures"], cwd=EXAMPLES, capture_output=True, text=True, env={**os.environ, "ESL_REPO": str(repo)}, timeout=900)
    tail = "\n".join(line for line in out.stdout.splitlines() if line.startswith(("ok", "FAIL", "all checks")))
    assert out.returncode == 0, tail + "\n" + out.stderr[-1500:]
    assert "all checks passed" in out.stdout and "FAIL" not in out.stdout
    print("\n" + tail)


def test_there_is_an_example_for_each_worked_example():
    assert len(SCRIPTS) >= 7
