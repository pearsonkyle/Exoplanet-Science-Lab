# Exoplanet Science Lab for Python

The transit, radial-velocity and timing models, the joint likelihood and the nested sampler of
[exoplanet.science](https://exoplanet.science), from Python: for running many systems in a loop, on a cluster,
or simply to hold in a script what was done in the browser.

Nothing was translated. The package contains the web application's JavaScript core (`src/core`, bundled into one
file by a build script) and runs it in a JavaScript engine embedded in the Python process. In front of it sit
typed [pydantic](https://docs.pydantic.dev) models of the session format and a layer with the classes of EXOTIC's
multi-planet fitter. A fit made here is the fit made there.

```
pip install exoplanet-science-lab            # numpy, pydantic and mini-racer (V8) come with it
pip install "exoplanet-science-lab[plot]"    # + matplotlib for the figures
```

From a checkout of the repository: `pip install -e "python[test]"` (after `node tools/build_core_bundle.mjs`
if `python/esl/_core/esl_core.js` is not there). Import name: `esl`.

## Three ways to use it

### 1. Run an analysis exported from the browser

The analyzer saves an analysis as one JSON document, the *session* (`docs/FORMAT.md`): system, data, what is
free with which prior, sampler settings and, once run, the result.

```python
import esl

session = esl.Session.load("hd80606.json")      # or esl.Session.model_validate_json(open("hd80606.json").read())
print(session.summary())

fit = session.run(progress=True)                # the sampler runs in the core; a status line follows it
print(fit.result.table())
fit.result["per"].median, fit.result["per"].plus, fit.result.derived["K"].median, fit.result.logZ

fit.save("hd80606_python.json")                 # the same document, with the Python result: opens in the browser
open("report.md", "w").write(fit.to_markdown()) # system, data, priors, sampler, results, how to reproduce
open("tables.tex", "w").write(fit.to_latex())
open("reproduce.py", "w").write(fit.to_script())# a standalone script that rebuilds the session line by line
```

`fit.result` is the object the browser writes (`logZ`, `parameters` with median / plus / minus / best, `derived`,
`best`, `chi2`, `chi2_parts`, `rv_zero_points`, `warnings`, `samples`). `session.evaluate(at=...)` returns the
model at any point (per-point light-curve model, baseline, each planet's transit, velocity model per instrument,
timing residuals); `session.likelihood()` opens the likelihood for your own sampler. From a shell:
`esl run session.json --report out.md --figures out` (or `python -m esl ...`).

The export goes both ways. `src/core/exportScript.js` has `pythonScriptFor(session)`, `markdownReportFor(session)`
and `latexTablesFor(session)`, pure functions the web application can offer as downloads; `Session.to_script()`
and friends call the same functions. The script it writes spells the analysis out with this package's classes:

```python
def build_session(DATA):
    return esl.Session(
        name="toy-1873",
        star=esl.Star(rstar=0.974, mstar=1.02),
        planets=[esl.Planet(letter="b", parameters=dict(rprs=0.0273, inc=88, per=7.0057, tmid=2459000.1662, mplanet=0.0283)), ...],
        kepler=True,
        data=esl.Data.model_validate(DATA),
        fit=esl.FitSettings(
            free=[esl.FreeParameter(key="mplanet", prior=esl.Prior.uniform(0, 0.1415)),      # Mp (b) [M Jup]
                  esl.FreeParameter(key="jit@rv1", prior=esl.Prior.uniform(0, 15)), ...],    # jitter (NEID) [m/s]
            sampler=esl.Sampler(nlive=300, seed=4)))
```

so a value, a prior or the list of free parameters is one edit away, and it prints the browser's numbers next
to its own.

### 2. Build a system the way EXOTIC's multi-planet fitter does

`esl.multi_fitter` has the classes of `exotic/api/multi_fitter.py` with the same fields: `SystemParameters`,
`ParameterSet`, `Bounds`, `Timeseries`, `LightCurveData`, `RadialVelocityData`, `EphemerisData`, `PlanetDataset`,
`MultiPlanetSystem`, `MultiPlanetFit`. `examples/05_three_planets.py` is EXOTIC's
`examples/multi_planet/multi_fit.py`; one line differs.

```python
from esl import multi_fitter as m                       # EXOTIC:  from exotic.api import multi_fitter as m

planets = {pkey: m.SystemParameters(**p) for pkey, p in truth["planets"].items()}
free    = {pkey: m.ParameterSet(mplanet=1) for pkey in planets}                 # not None = free
bounds  = {pkey: m.Bounds(upper=m.ParameterSet(mplanet=hi[pkey]), lower=m.ParameterSet(mplanet=0)) for pkey in planets}

lcs = [m.LightCurveData(time=t, name="tess_b", flux=f, ferr=e, airmass=a, exp_time=120.0 / (60 * 24)), ...]
rv  = m.RadialVelocityData(time=t, name="rv_neid", vel=v, velerr=ve)
rv.local = m.ParameterSet(rv_jitter=1)
rv.local_bounds = m.Bounds(upper=m.ParameterSet(rv_jitter=15.0), lower=m.ParameterSet(rv_jitter=0.0))

system = m.MultiPlanetSystem(planets=planets, free=free, bounds=bounds, transit=lcs, radial_velocity=[rv])
fit = m.MultiPlanetFit(system, live=300, seed=42)       # runs, as in EXOTIC

fit.parameters["c_mplanet"], fit.errors["c_mplanet"]    # EXOTIC's keys; best fit and posterior standard deviation
fit.derived["b"]["K"], rv.model, rv.offset, lcs[0].scale, lcs[0].residuals
fit.plot_lightcurves(fold=True); fit.plot_rv(fold=True); fit.plot_posterior(truths={...})
fit.session.save("toy1873.json")                        # the ESL session it ran: opens in the browser
```

What differs from EXOTIC, because the likelihood is ESL's (`buildProblem`):

| | EXOTIC | here |
| --- | --- | --- |
| light-curve scale, RV zero point | profiled (mean of data / model) | integrated out analytically; `a1` is never free (asking for it warns) |
| reflex motion | scaled by Mp / M★ | two-body Mp / (M★ + Mp): for the same velocities the mass is higher by Mp / M★ |
| likelihood | χ² without the ln σ terms | χ² over every measurement with the Gaussian normalisation: ln Z is a normalised evidence |
| priors | uniform bounds | uniform bounds, or `MultiPlanetSystem.priors = {"b": {"per": esl.Prior.normal(3.1, 0.001)}}` |
| timing data | separate fitters | `MultiPlanetSystem.ephemeris_transit` / `ephemeris_eclipse` per planet, in the same likelihood |
| `n_sub` | sub-samples per exposure | 1 = instantaneous as in EXOTIC; above 1 the exposure is passed on and the core picks the count |
| sampler | UltraNest | MiniNest: `live`, `max_ncalls`, `seed`, `stepsampler`, `nsteps` are mapped; `improvement_loops` is ignored |
| `fit.results` | UltraNest's dictionary | a dictionary with the same keys the examples read (`samples`, `weighted_samples`, `maximum_likelihood`, `posterior`, `logz`, `ncall`) on equal-weight draws |

Also on the system: `kepler=False` to use each planet's `ars` instead of Kepler's law, `star=esl.Star(...)`,
`limb_darkening=esl.LimbDarkening(mode="star", ...)`.

### 3. Call the models

```python
import numpy as np, esl

t = np.linspace(-0.2, 0.2, 500)
flux = esl.transit(t, dict(rprs=0.1, ars=8.8, inc=87, per=3.5, tmid=0, ld=[0.4, 0.26], law="quadratic"))
flux = esl.transit(t, [planet_b, planet_c], exptime=30 / 1440)         # product of planets, exposure-averaged
rv   = esl.radial_velocity(t, dict(per=3.5, tmid=0, ecc=0.1, omega=40, mplanet=1.0, mstar=1.0, inc=87))

u1, u2 = esl.limb_darkening(teff=5565, logg=4.4, feh=0.35, band="TESS", law="quadratic")   # PHOENIX, 37 bands
esl.limb_darkening(4400, 4.5, 0.0, band=(4000, 5000), law="nonlinear")                     # any range, 200-5500 nm

eph = esl.fit_ephemeris(times, errors, period=2.7962868)               # or epochs=...; order=2 for dP/dt
pg  = esl.periodogram(times, errors, epochs=eph.epochs)                # Lomb-Scargle of O - C, BIC, verdict
esl.derive(params, star)        # the system table: Rp, a, b, T14, T eclipse, K, T eq, densities
hit = esl.lookup("HD 80606 b")  # NASA archive snapshot: chosen reference, checks, suggested priors, a session
esl.read_light_curve("night.csv"); esl.read_rv("velocities.csv")       # the analyzer's own readers

esl.core.invoke("kepler.eventTimes", params)          # any export of any module of src/core, by name
esl.core.modules()                                    # what is there
```

`esl.lookup` reads the snapshot from `$ESL_CATALOG`, else from `public/catalog` of the checkout the package sits
in, else from `https://exoplanet.science/catalog/`; pass `catalog=` (a folder or URL) to say otherwise.

Figures (`esl.plot`, matplotlib): `light_curve(session, fold=...)` (one row per observation, or folded per planet
with the other planets divided out), `radial_velocity(session, fold=...)`, `corner(session, truths=...)` coloured
by likelihood, `oc(session)`, `ephemeris(fit, times, errors)`, `periodogram(pg)`. Each returns a Figure.

## The models

One class per block of `docs/FORMAT.md`: `Session`, `Software`, `Star`, `LimbDarkening`, `Planet`,
`PlanetParameters`, `Data`, `LightCurve`, `LightCurveEpoch`, `RadialVelocity`, `TimingPoint`, `FitSettings`,
`Use`, `FreeParameter`, `Prior`, `Sampler`, `Result`, `ParameterSummary`, `Quantity`, `Chi2Parts`, `RVZeroPoint`,
`Samples`; and for what the functions return: `ModelEvaluation` (`LightCurveModel`, `RVModel`, `TimingModel`),
`EphemerisFit`, `TimingPeriodogram`, `LimbDarkeningCoefficients`, `CatalogSystem`, `Progress`.

- Arrays are numpy arrays in Python and JSON lists on disk; `model_json_schema()` works on every class, so they
  can be request and response bodies of a web API.
- Unknown keys are kept everywhere (`extra="allow"`): the `ui` block the application stores, planet parameters of
  models added later, options this version has not heard of. They are sent to the core untouched and written
  back out. Keys that are `null` are dropped on output.
- Times in a session are absolute; `time_reference` is where the fit measures them from. `Samples.values` are as
  sampled (`tmid` relative to `time_reference`).
- Limb darkening in `"star"` mode (coefficients follow Teff and [Fe/H] through the PHOENIX tables, with `teff`
  and `feh` optionally free) works here: `specFromSession` leaves that set-up to the application, and
  `src/core/pyentry.js` holds the pure equivalent of the application's `tieSpec`.
- A free parameter that the session likelihood of the bundled core has no registry entry for is still sampled,
  and the result's first warning says so.

## Why the numbers are the browser's

`tools/build_core_bundle.mjs` bundles every `src/core/*.js` file with esbuild (the copy Vite brings: nothing is
added to `package.json`), unminified, into `esl/_core/esl_core.js`; the 37-band limb darkening table is inside,
the wavelength-resolved table is a second file loaded on first use. The same file runs in the three runtimes.
Checked by the tests (numbers from this machine, an Apple M4 Max; see "Not verified"):

| Check | Result |
| --- | --- |
| Bundle against the modules, same engine (Node) | transit and radial-velocity values bit for bit; a complete fit through the job interface equal in every digit (`test/python_bundle.test.mjs`) |
| Transit model, Python (V8 14.4) against Node 22 (V8 12.4), 41 light curves of `public/validation/transit.json` | at most 3.5 units in the last place of the flux; 3.1e-11 from the quadrature reference, as in the JavaScript tests. With `esl.set_runtime("node")`: bit for bit |
| Radial velocity, the five orbits of `public/validation/rv.json` | 8e-16 K from Node |
| Three-planet session of `test/session.test.mjs` | χ² 362.0685222626134 in both; fit: 4,921 calls in both, posterior medians equal to 3e-15 σ, ln Z equal to 13 digits |
| Six sessions the web application stored with their results (`public/examples/results`) | five reproduced exactly (same number of calls, medians and ln Z identical); `hd80606-tess.json` took 12,813 calls against 12,837 and agrees to 0.004 σ |
| Exported script (`pythonScriptFor`) run under the package | reproduces the JavaScript result to 4e-14 relative (`test/exportScript.test.mjs`) |
| EXOTIC 4.3.1 run on the same inputs, six planets up to e = 0.93 | transit 1.0e-7 (pylightcurve's Claret model), RV 1.1e-5 K after its Mp/M★ factor, a/R★ 8e-11 |
| EXOTIC's three-planet fit | best fit within 0.5 σ, widths within 7%; 0.8 s and 14,000 calls against 148,000 |

The engines' own `sin`, `cos`, `acos` and `exp` differ in the last digit between V8 versions, which is where the
3.5 ulp comes from. The sampler is deterministic for a seed, so such differences normally leave its path
unchanged; when one flips an accept/reject decision the run differs within sampling noise (one case above).
χ² itself is a difference of sums of order 1e8 and is reproducible to about 1e-7.

## Runtimes and speed

| Runtime | Needs | Use |
| --- | --- | --- |
| `v8` (default) | `mini-racer`, installed with the package | V8 inside the Python process |
| `node` | Node.js on the PATH | a subprocess speaking JSON lines; chosen automatically when mini-racer is missing |
| `quickjs` | `pip install quickjs` | no JIT; last resort |

`esl.set_runtime("node")` or `ESL_RUNTIME=node`; `esl.runtime_info()` says what is running. The sampler loop is
always inside the engine (one job per fit). The embedded engines have no event loop: the core yields about eight
times a second and Python polls it, which is how progress streams and how Ctrl-C stops a run cleanly (the first
Ctrl-C returns what the sampler has, flagged `converged = False`; the second raises).

`python python/benchmarks/runtime_bench.py --quickjs`, a ground-based night of a hot Jupiter (400 points,
circular orbit, quadratic law, airmass trend, four free parameters, 400 live points, the same seed everywhere):

| Runtime | per likelihood | whole fit, 19,352 calls | calls / s |
| --- | --- | --- | --- |
| Node 22 on `src/core` directly (no Python) | 32 µs | 1.23 s | 15,800 |
| V8 14.4 embedded (PyMiniRacer) | 25 µs | 1.17 s | 16,600 |
| Node 22 subprocess | 30 µs | 1.22 s | 15,900 |
| QuickJS | 684 µs | 22.5 s | 860 |

Against the browser, on the sessions it stored (calls identical): the single-transit example (HAT-P-32 b preset,
e = 0.16, exposure-averaged, 17,998 calls) 3.5 s in the browser, 4.0 s here, 4.4 s in Node; HD 80606 joint fit
(56,192 calls) 12.3 s and 12.0 s; three planets (16,942 calls) 0.8 s and 1.0 s; five nights with nine parameters
(155,309 calls) 130 s and 133 s. Starting the engine takes 0.06 s.

Data cross as JSON text. For a 20,000-point light curve that is 17 ms to write and 29 ms for a complete model
evaluation there and back; for 100,000 points 0.08 s and 0.11 s, against 5.8 ms per likelihood call and so
minutes per fit. It is under 0.1% of a run, so no binary path was built.

## Keeping Python and the web application together

```
node tools/build_core_bundle.mjs            # rebuild python/esl/_core and python/esl/_version.py
node tools/build_core_bundle.mjs --check    # exit 1 if they are behind the sources
node tools/build_core_bundle.mjs --release  # also stamp the git commit and the date
```

- The build is a pure function of the sources (no date, no commit unless `--release`), stamped with the version
  from `package.json` and a hash of every bundled file: `esl.core.info()["sourceHash"]`.
- Every `src/core/*.js` file is a module of the bundle under its own name; nothing lists them. While this
  package was written, `phasecurve.js`, `exomoon.js`, `nbody.js`, `psd.js` and `horizon.js` appeared in the core
  and were callable from Python (`esl.core.invoke("phasecurve.phaseCurveModel", t, p)`) after a rebuild with no
  edit; when `buildProblem` began to read phase-curve parameters, sessions carrying them changed here at the
  same moment.
- `python/bundle.manifest.json` lists what Python relies on. `test/python_bundle.test.mjs` asserts it, rebuilds
  the bundle when it is behind, and runs a fit through it; add it and `test/exportScript.test.mjs` to
  `test/run.mjs` and `npm test` catches a core change that would break Python.
- `pytest` inside the repository rebuilds a stale bundle before it starts (`ESL_NO_REBUILD=1` to test the files
  as they are).

Release: `node tools/build_core_bundle.mjs --release`, then `python -m build python` (hatchling; the version comes
from `package.json` through `esl/_version.py`), then upload `python/dist/*`. The wheel is pure Python
(`py3-none-any`, 0.6 MB); the platform-specific part is mini-racer's own wheel.

## Tests and examples

```
python -m venv .venv-py && .venv-py/bin/pip install -e "python[test]" quickjs
.venv-py/bin/python -m pytest python/tests          # 67 tests, about two minutes
node test/python_bundle.test.mjs && node test/exportScript.test.mjs
```

`python/examples`, each stating the numbers it should print (from the main README's "EXOTIC's examples,
reproduced") and checking them; run from a checkout (the data are under `public/examples` and `test/`):

| Script | EXOTIC example | Checks |
| --- | --- | --- |
| `01_single_transit.py` | `single_transit` | posterior against EXOTIC's `lc_fitter` on the same data: means within 0.02 σ, widths within 1% |
| `02_multiple_transits.py` | `multiple_transit` | five nights, nine parameters against `glc_fitter`: 0.11 σ, 3%; 5 s against 57 s |
| `03_hd80606_rv.py` | `radial_velocity` | K 469.63 m/s, e 0.93157, ω −58.835°; zero points match EXOTIC's |
| `04_hd80606_joint.py` | `joint_rv_transit` | K 469.85, a/R★ 94.453, P 111.436865, i 89.241, e 0.93160 against Table 7; 13 s |
| `05_three_planets.py` | `multi_planet` | χ² 45.11, 88.80, 190.58, 37.58 at the truth; fit against EXOTIC's; planet d below 3.5 m/s at 95% |
| `06_ephemeris_periodogram.py` | `ephemeris` | statsmodels WLS to 1e-6, 26 of 40 after the clip; 57.3 d, 2.78 ± 0.16 min |
| `07_browser_export.py` | | a session the application stored, run again and compared; writes report, tables, script, figures |

## Not verified

- Only macOS on Apple silicon was run: Python 3.12 with mini-racer 0.14.1 (V8 14.4) and Python 3.9 with
  mini-racer 0.12.4 (V8 12.6), Node 22, quickjs 1.19.4. Linux and Windows, and Python 3.10, 3.11 and 3.13, were
  not; mini-racer publishes wheels for them, and the Node runtime is the fallback where it does not.
- Nothing was run in a real browser from here. "The browser" above means the results stored in
  `public/examples/results`; which browser wrote them is not recorded. Firefox and Safari use other engines and
  may round differently (expected: agreement within sampling noise, as in the one case above).
- `esl.lookup` was tested against `public/catalog` in the checkout. The default URL
  (`https://exoplanet.science/catalog/`) was not fetched.
- The packaging was tried as a wheel installed in a clean environment outside the repository; nothing was
  uploaded to PyPI and the name `exoplanet-science-lab` was not checked for availability.
- Phase curves, moons and N-body are in the core and reachable through `esl.core.invoke`; they have no pydantic
  classes or EXOTIC-style front end here yet, and the example sessions under `public/examples/phasecurve`,
  `exomoon` and `nbody` are only checked to load, keep their keys and run.
- The figures were looked at for the three-planet example only; their content is not asserted by tests.
- Thread safety: one engine per process behind a lock. For parallel fits use processes.
