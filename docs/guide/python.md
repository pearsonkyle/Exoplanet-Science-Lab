# Python package

The `esl` package runs the website's own JavaScript core (bundled, unmodified) inside an embedded engine, so a fit in Python gives the same numbers as the browser, and a session saved on the site runs unchanged.

## Install

From GitHub, no release needed:

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python"
# a tag or branch: ...Exoplanet-Science-Lab.git@v0.2.0#subdirectory=python
```

Extras: `[plot]` for matplotlib figures, `[quickjs]` for the alternative engine. Python 3.9 or later; the default engine (`mini-racer`) ships wheels for Linux, macOS and Windows.

From a clone, for development:

```sh
cd python
pip install -e ".[test]"
pytest
```

## Use

```python
import esl

# a session saved from Analyze (Results → Save session), or one of the worked examples
session = esl.Session.load("my_session.json")
fit = session.run(progress=True)
print(fit.result.table())

# the models directly
import numpy as np
t = np.linspace(-0.1, 0.1, 500)
flux = esl.transit(t, dict(rprs=0.1, ars=8.8, inc=87, per=2.15, tmid=0, ld=[0.4, 0.2], law="quadratic"))
```

Everything public is listed in the [Python reference](../reference/python).

## Releases

Until there is a PyPI release, install from git as above. Releasing later is one step: tag `py-v0.2.0` and the `python-release` workflow builds the wheel (with the bundled core) and publishes it through PyPI's trusted publishing; see [Development](./development#publishing-the-python-package).
