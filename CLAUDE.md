# Exoplanet Science Lab

Browser app for modelling and fitting exoplanet light curves. Vite + three.js, plain ES modules, no framework.
Read `HANDOFF.md` first: it has the current state, what has never been run, and the roadmap.

## Commands
- `npm install` then `npm run dev` (Vite) · `npm run build` · `npm test` (98 Node suites, about 27 min) · `npm run test:stress` (sampler, all problems)
- Reference scripts (`test/make_*.py`) run with `.venv/bin/python` (numpy, scipy); other references have their own `.venv-*` (HANDOFF.md, Environments)
- Docs (VitePress, `docs/`): `npm run docs:dev`; `npm run pages:build` builds app + docs into `dist/` as GitHub Pages serves them (`.github/workflows/pages.yml`). Reference pages are generated from the code (`tools/docs/`), not edited.
- `npm run build:python` rebuilds the Python package's bundle (committed: pip installs from git); `cd python && ../.venv-py/bin/pytest` · `cd mcp && node test.mjs`
- Browser checks need Python + Playwright + Chrome and the dev server (they import source modules, so a built copy will not do):
  `npm run dev`, then `ESL_BASE=http://localhost:5173 .venv/bin/python test/features_check.py /tmp/esl` and the same with `test/export_check.py`
- Opacity tables (`public/opacity/*.eslo`, twelve gases and five CIA pairs, 25 MB): `.venv-rt/bin/python tools/opacity/build_opacity.py` (`--cia N2-N2 N2-CH4 N2-H2` adds CIA pairs without rebuilding the gases) from the ExoMolOP and HITRAN files in `data-src/` (ignored; URLs, the `.venv-rt` set-up and the petitRADTRANS reference in `tools/opacity/README.md`). The molecular tables are CC BY-SA 4.0 (ExoMol); the code stays MIT.
- Mixing kernel (`public/wasm/mix.wasm`, committed): `sh tools/wasm/build.sh` (rustc with the wasm32-unknown-unknown target); the JavaScript loop in `src/core/opacity.js` is the reference and must stay equal to it (`test/opacity.test.mjs`). Aerosol optical constants (`src/core/optical.js`): `.venv/bin/python -I tools/opacity/build_optical.py data-src/tholin/Titan_tholin.dat`.
- Stellar flux grid (`public/stellar/phoenix.esls`, 0.5 MB): `.venv-rt/bin/python tools/stellar/build_spectra.py` from the PHOENIX files in LDTK's cache (`~/.ldtk`, fetched by `tools/build_ld_table.py`); read by `src/core/stellarspec.js`.
- Passbands (`src/core/passbands.js`): `.venv/bin/python -I tools/stellar/build_passbands.py data-src/svo` from the SVO Filter Profile Service's VOTables (URLs in the script). SED references: `.venv-sed/bin/python test/make_sed_reference.py` (dust_extinction); `test/sed_benchmarks.json` and `src/star/examples.js` hold catalogue photometry of six stars.
- Chemistry table (`public/chem/equilibrium.eslc`, 4.9 MB): `.venv-rt/bin/python tools/chem/build_chem.py` (FastChem; about 15 min; `tools/chem/README.md`), then `test/make_chem_reference.py`.
- Offline: the build writes `dist/sw.js` (`tools/sw/`, a service worker caching the whole site, versioned by content); `.venv/bin/python test/offline_check.py --serve dist` checks every page with the server stopped. `?nosw` removes the worker. External services go through `fetchOr` / `siteJson` in `src/site/net.js`, which show a notice instead of failing.

## Site
- Pages are folders with their own `index.html`: `plan/`, `observe/`, `analyze/`, `analyze/photometry/`,
  `analyze/spectroscopy/`, `analyze/atmosphere/` (forward model of a spectrum, docs/guide/validation.md "Atmosphere"), `analyze/star/` (SED fit of the host star, `src/star/`, `src/core/sed.js`), `search/`, `observe/run/` (observing sequences, docs/guide/observing.md), `methods/` (tabs: Methods, Validation, Reproducibility, References, How to cite).
  Each has `<meta name="esl-root">` and mounts `src/site/nav.js`; the five Analyze pages also mount `src/site/subnav.js`.
  New pages go in `vite.config.js` inputs. `observe/photometry/`, `observe/spectroscopy/` and `validation/` are redirect
  stubs; validation anchors on `methods/` are prefixed `val-` (`src/validation/anchors.js`).
- Page code lives in `src/<page>/`; the analyzer is `src/main.js` + `src/ui/` + `src/viz/`.
- Check pages headlessly: `.venv/bin/python tools/shot.py 'analyze/?skipintro' /tmp/x.png --eval "<js>"`, then read the PNG.

## Rules for this repo
- `src/core/` is science code: no DOM, no three.js, runnable in Node. Every new model gets a test in `test/`
  against an independent reference (analytic limit, scipy quadrature, a published value) before any UI is built on it.
- Report numbers with their check. If something could not be run or compared, say so in its section of `docs/guide/validation.md` (the detailed notes; README.md stays short).
- a/R★ is never a sampled parameter (degenerate with inclination): it is fixed or follows from Kepler's law.
- The likelihood is assembled in one place, `buildProblem` in `src/core/model.js`. Extend it; do not fork it.
- State lives in the single `S` object in `src/main.js`; anything a user can change must go through `pushUndo()` first.
- Data and fit results are replaced, never mutated in place (undo holds them by reference).
- Plots are pure render functions taking a theme (`renderLightCurve`, `drawCorner`) so screen, export and movie share code.
- Several planets: key suffix `@c`, first planet unscoped; RV datasets `jit@rv2`. Use `planetValues()` in main.js, never `S.values.per` directly.
- EXOTIC references: `test/make_exotic_reference.py` and `test/make_exotic_fits.py` run with `/Users/kpearson/miniconda3/envs/exotic/bin/python`.
- The page opens on the start page; append `?skipintro` to the URL for tests and automation.
- Several epochs: `data.epoch` (index per point) and `data.segments`; per-epoch parameters use keys `name@n` (`a2@2`).
- Retrieval: `runRetrieval` in `src/core/retrieval.js` (priors of `priors.js`, MiniNest); the end-to-end example `node tools/examples/ariel_retrieval.mjs clear|hazy` (1 to 2 hours each; all six fits converge) writes `tools/examples/ariel_retrieval_*.json`, which `test/retrieval.test.mjs` checks. Ariel's instrument numbers (`TELESCOPES.Ariel`) are ArielRad's published ones; change them only with the source.
- Retrieval outside a script: `retrieveAtmosphere` in `src/core/atmoapi.js` (checks the data, default priors, cuts the tables to the data; `retrievalSetup` is the shared part) is what the MCP tool `atmosphere_retrieve`, Python's `esl.retrieve_atmosphere` and the Atmosphere page's worker (`atmosphere_fit_spectrum` for the assistant) all call. Joined opacity bins (`merge`) cost accuracy: keep three model bins to one data bin.
- Star lookup: `src/core/starcat.js` builds the VizieR queries; test fixtures in `test/fixtures/vizier/`.
- Atmosphere model outside the page (Python, MCP, scripts): `runAtmosphere` in `src/core/atmoapi.js`; preset worlds in `src/core/worlds.js`. A new model option goes into `atmosphereOf` / `forwardModel`, then the page, then is reachable there without more work.
- Atmosphere model: one entry point, `forwardModel` in `src/core/rtmodel.js`; opacity only through `gasExtinction` (`src/core/opacity.js`). Scattering enters transmission, never emission. petitRADTRANS and other GPL codes are references to run, not code to port.
- Optional models: a planet has its own light when `fpfs` is set, a moon when `rmoon` is; `S.nbody` switches times, RVs and light curves to N-body; `data.regressors` / `data.kernel` carry detrending. All go through `buildProblem`.
- Plot views go through `plotFor(view)`; never draw a view only for the screen.
- Long headless runs use a built copy on :8899 (`ESL_BASE`), not the dev server: it reloads when files change.
- After changing a test's printed numbers: `node tools/validation/project_reference.mjs <topic>` (the Validation tab of Methods quotes them).
- Never write into the EXOTIC repository or the `exotic` conda environment. No API key ships in the repo. The assistant's only built-in endpoint is the LM Studio preset (localhost:1234) in `src/assistant/presets.js`; the owner removed the VPN preset before going public, so other servers are entered as Custom.
- "Now" is `clock.now()` (`src/site/clock.js`), never `Date.now()`, wherever the present is shown or stamped; time scales and leap seconds only from `src/core/timescale.js`. Frames we write get `frameHeader` (`src/core/fitsheader.js`).
- Conventions: sky plane X, Y in stellar radii, +Z toward the observer; mid-transit = inferior conjunction;
  Claret law `I = 1 - sum a_n (1 - mu^(n/2))`; times stored relative to `data.tRef`.
