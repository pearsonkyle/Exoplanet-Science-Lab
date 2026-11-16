# Python labs

Six short notebooks that take you from a first fit to a hidden planet, in the order a course would. Each one
downloads its real data from this site, so it runs anywhere once the package is installed:

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python" matplotlib
```

| Lab | What you do | Data |
| --- | --- | --- |
| [1 · Your first transit fit](./lab01_first_transit) | simulate a transit, describe it as a session, fit it, read the posterior | simulated |
| [2 · A real TESS transit](./lab02_tess_transit) | start from the catalogue, fit HD 80606 b's TESS transit, meet dilution | TESS |
| [3 · Radial velocities](./lab03_radial_velocities) | fit an eccentric orbit and the planet's mass from seven instruments, with jitter | ELODIE, HIRES, HRS, SOPHIE, APF |
| [4 · One orbit for everything](./lab04_joint_fit) | a joint fit of transit, velocities and timing, Kepler-tied | all of the above |
| [5 · Ephemerides and orbital decay](./lab05_ephemeris) | linear and quadratic ephemerides, O − C, a periodogram of the residuals | WASP-12 b, 457 times |
| [6 · A hidden planet weighed by its pull](./lab06_ttv) | timing variations, the super-period, an N-body mass | Kepler-88, 119 times |

Every page shows the code with its real output and figures. Each lab is also a notebook in
[`python/labs`](https://github.com/pearsonkyle/Exoplanet-Science-Lab/tree/main/python/labs) (open it in Jupyter or Colab);
the sources are plain Python in `python/labs/src`, and `tools/docs/build_labs.py` runs them and rebuilds these pages.
