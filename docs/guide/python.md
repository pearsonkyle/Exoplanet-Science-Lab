# Python package

The `esl` package runs the website's own science code from Python, so a fit in a script gives the browser's numbers,
and a session saved on the site (Analyze → Save session) runs unchanged.

## Install

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python" matplotlib
```

Python 3.9 or later; Linux, macOS and Windows. No Node.js needed: the JavaScript core ships inside the package.

## Learn it

The **[labs](../labs/)** walk through the package with real data, one notebook each:

1. [Your first transit fit](../labs/lab01_first_transit): session, priors, fit, results
2. [A real TESS transit](../labs/lab02_tess_transit): start from the catalogue
3. [Radial velocities](../labs/lab03_radial_velocities): an eccentric orbit, jitter
4. [One orbit for everything](../labs/lab04_joint_fit): a joint fit
5. [Ephemerides and orbital decay](../labs/lab05_ephemeris): O − C, periodograms
6. [A hidden planet weighed by its pull](../labs/lab06_ttv): TTVs and N-body

The [Python reference](../reference/python) starts with a one-page cheat sheet.

## From a clone

```sh
cd python
pip install -e ".[test]"
pytest
```

The older example scripts in `python/examples` reproduce EXOTIC's examples and check the numbers against EXOTIC's own fits.

## Releases

Until there is a PyPI release, install from git as above (add `@<tag>` after `.git` for a fixed version). Publishing
later is one tag: see [Development](./development#publishing-the-python-package).
