# Architecture

```
index.html            page shell, import map for no-build use
src/main.js           state (S), panels, fit orchestration, undo, exports
src/core/             science, no DOM  ── importable from Node
  kepler.js           Kepler solver, orbit position, event times, contact durations
  limbdark.js         laws, conversions to Claret coefficients, validity
  transit.js          flux kernel (Green's theorem line integral) and light curve
  model.js            parameter registry, buildProblem() = the likelihood
  priors.js           unit-cube transforms
  nested.js           MiniNest sampler (MLFriends region, plateau handling, lnZ error)
  fitRunner.js        runs a fit in slices (worker or main thread)
  derive.js           system table quantities
  ldest.js            limb darkening from stellar parameters, tables, star-tied LD
  stellar.js          mass/radius from Teff, logg, [Fe/H]
  hz.js               habitable zone
  data.js             file reader, simulator, epochs (combine, remove, split by orbit, fold)
  config.js           priors to/from JSON and YAML
  rv.js               stellar reflex velocity, K, a/R* from Kepler's law
  catalog.js          archive snapshot reader: reference selection, physical checks, provenance, priors
  ephemeris.js        ephemeris fits to mid-transit times, epoch counting, timing-list reader
  stats.js            RNG, quantiles, special functions
src/worker/           Web Worker entry for fits
src/ui/               canvas plots, export (PNG/PDF/LaTeX/JSON), movie recorder, timingTab.js (first per-tab module)
src/viz/              three.js scene, GLSL, 2D fallback
src/data/             bundled datasets and tables
test/                 Node tests + headless-browser drivers
tools/                offline builders (limb darkening table)
validation/           comparisons against published results (to be filled)
```

## How a fit flows
`startFit()` builds a spec `{data, values, ldLaw, free[{key, prior}], exptime, supersample, ldTie, sampler}` →
posted to `fit.worker.js` → `runFit` → `buildProblem(spec)` gives `{transform, loglike}` → `MiniNest` →
weighted samples + lnZ back to `finishFit()`, which derives the system table on posterior draws.

## Where new capability plugs in
| Capability | Extension point |
| --- | --- |
| Another light-curve component (eclipse, phase curve, moon) | a module in `src/core/` returning `flux(t)`; multiply/add inside `evaluate()` in `buildProblem` |
| Several planets | loop `makeTransit` over a `planets[]` list in the spec; parameters become `key@planet` |
| Several datasets / instruments | `spec.datasets[]`, each with its own baseline, exposure, limb darkening band; sum lnL |
| Radial velocities, timing constraints | extra likelihood terms in `buildProblem`, sharing orbital parameters |
| New sampled parameter | add to `PARAMS` (or a new registry like `STAR_PARAMS`), give it a default prior in `main.js` |
| N-body | replace `orbitPosition` with an integrator behind the same `position(t)` interface |
| Heavy numerics | keep the JS reference implementation and its test; add WASM behind the same function signature |

The Timing tab is the pattern for per-tab modules: `buildTimingTab(el, app)` in `src/ui/timingTab.js` receives
what it needs from `main.js` (`S`, `h`, `pushUndo`, `rebuild`, ...) and returns a redraw function.

Namespacing has started with the baseline: a dataset with several epochs carries `epoch` (index per point) and
`segments`, and `activeParams(ldLaw, [flags])` returns one airmass coefficient per epoch with key `a2@n`
(`epochKey`, `paramFor`). Keys of the form `name@scope` are the convention to extend to planets and instruments.

State for several planets and datasets (src/main.js): `S.planets` lists `{ sfx, letter }` and `S.pl` is the planet
on show; all values, priors and free flags live in flat maps keyed `name@scope` (first planet unscoped, `per@c`,
`a2@3`, `jit@rv2`). `planetValues(values, sfx)` turns that into the plain single-planet object that drawing and
derived quantities use. Light-curve observations are the epochs of `S.data`; velocity datasets are `S.rv`; `S.use`
says which kinds of data enter the fit. A "session" (`src/ui/examples.js`) is the plain description of a system and
its data that `applySession` loads; examples and catalog look-ups both produce one.

The parameter registry is currently a flat list for one planet and one dataset. The first structural job before
multi-planet or multi-dataset work is to make parameters namespaced (planet, dataset, star) and to split
`src/main.js` (about 700 lines) into per-tab modules.
