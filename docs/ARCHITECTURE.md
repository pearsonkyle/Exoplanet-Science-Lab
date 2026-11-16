# Architecture

```
index.html            landing page; plan/ observe/ analyze/ search/ validation/ each hold a page
src/site/             shared navigation bar and tokens
src/sky/ src/plan/ src/search/ src/photometry/ src/validation/   page code (DOM), one folder per page
src/main.js           the analyzer: state (S), panels, fit orchestration, undo, exports
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
  session.js          the session document (docs/FORMAT.md): validate, spec for buildProblem, headless runSession
  exportScript.js     a session as a Python script, a Markdown report, LaTeX tables
  phasecurve.js       the planet's own light: eclipse, phase curve, spherical-harmonic maps, temperatures
  exomoon.js          planet + moon transit, moon search
  nbody.js            Wisdom-Holman and IAS15 integrators, dynamical transit times and RVs, stability, perturber grid
  periodogram.js      generalised Lomb-Scargle for timing residuals; psd.js: power spectra and noise diagnostics
  astro.js observability.js horizon.js     sky positions, transit observability, terrain horizon
  fits.js photometry.js gp.js              images to light curves
  sources/ relations.js                    catalogue plug-ins, merging, gap-filling relations
  pyentry.js pyshim.js                     entry points of the Python bundle (tools/build_core_bundle.mjs)
src/assistant/        in-page assistant: tool table, handlers over window.__esl.api, the loop, the panel
mcp/                  MCP server: the same handlers on session documents
python/               the esl package: this core run from Python
src/worker/           Web Worker entries: fits, photometry frames, the N-body perturber grid
src/ui/               canvas plots, export (PNG/PDF/LaTeX/JSON), movie recorder, timingTab.js (first per-tab module)
src/viz/              three.js scene, GLSL, 2D fallback
src/data/             bundled datasets and tables
test/                 Node tests + headless-browser drivers
tools/                offline builders (limb darkening, catalogues, observatories, example results, Python bundle); tools/README.md
validation/           redirect to methods/#validation; the validation recipe is validation/README.md
methods/              Methods page: methods, validation, reproducibility, references, how to cite (src/methods/, src/validation/)
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

Optional models hang off the same keys. A planet has its own light when `fpfs` (or `fpfs@c`) is defined, a moon
when `rmoon` is; `S.phase` and `spec.phase` hold the options shared by the planets (`mode`, `lmax`, `ltt`, band).
`S.nbody` / `spec.nbody` (`{ epoch, linear, ... }`) switches mid-transit times and velocities to an N-body
integration. `activeParams(..., { moons, phase })` lists their parameters in groups `moon` and `phase`.

Plot views other than the light curve go through `plotFor(view)` in `main.js`, which returns
`{ data, render(ctx, W, H, data, theme, opts) }`; the screen, the exported figure and the movie all draw that, and
`data.setTime(t)` moves a figure's time cursor. Per-tab modules receive an `app` object: `buildTimingTab` and
`buildDynamics` (`src/ui/dynamics.js`) are the pattern.

`window.__esl.api` (`createAPI(app)` in `src/ui/api.js`, wrapped by `makeAPI()` in `main.js`; `describe()` lists every call) is the scripted surface of the analyzer, used by the headless
checks, the stored-results builder and the assistant.

`src/main.js` is about 2,100 lines. The split still to do: state and undo; session import/export; one module per
tab (System, Data, Fit, Results) on the pattern above; plot views.
