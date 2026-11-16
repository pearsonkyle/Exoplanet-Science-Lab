# Exoplanet Science Lab

Browser app for modelling and fitting exoplanet light curves. Vite + three.js, plain ES modules, no framework.
Read `HANDOFF.md` first: it has the current state, what has never been run, and the roadmap.

## Commands
- `npm install` then `npm run dev` (Vite) · `npm run build` · `npm test` (73 Node suites, about 13 min) · `npm run test:stress` (sampler, all problems)
- Reference scripts (`test/make_*.py`) run with `.venv/bin/python` (numpy, scipy); other references have their own `.venv-*` (HANDOFF.md, Environments)
- Docs (VitePress, `docs/`): `npm run docs:dev`; `npm run pages:build` builds app + docs into `dist/` as GitHub Pages serves them (`.github/workflows/pages.yml`). Reference pages are generated from the code (`tools/docs/`), not edited.
- `npm run build:python` rebuilds the Python package's bundle (committed: pip installs from git); `cd python && ../.venv-py/bin/pytest` · `cd mcp && node test.mjs`
- Browser checks need Python + Playwright + Chrome and a static server on :8765:
  `python3 -m http.server 8765` then `python3 test/features_check.py /tmp/esl` and `python3 test/export_check.py /tmp/esl`

## Site
- Pages are folders with their own `index.html`: `plan/`, `observe/`, `analyze/`, `analyze/photometry/`,
  `analyze/spectroscopy/`, `search/`, `methods/` (tabs: Methods, Validation, Reproducibility, References, How to cite).
  Each has `<meta name="esl-root">` and mounts `src/site/nav.js`; the three Analyze pages also mount `src/site/subnav.js`.
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
- Optional models: a planet has its own light when `fpfs` is set, a moon when `rmoon` is; `S.nbody` switches times, RVs and light curves to N-body; `data.regressors` / `data.kernel` carry detrending. All go through `buildProblem`.
- Plot views go through `plotFor(view)`; never draw a view only for the screen.
- Long headless runs use a built copy on :8899 (`ESL_BASE`), not the dev server: it reloads when files change.
- After changing a test's printed numbers: `node tools/validation/project_reference.mjs <topic>` (the Validation tab of Methods quotes them).
- Never write into the EXOTIC repository or the `exotic` conda environment. No API key ships in the repo. The assistant's only built-in endpoint is the LM Studio preset (localhost:1234) in `src/assistant/presets.js`; the owner removed the VPN preset before going public, so other servers are entered as Custom.
- Conventions: sky plane X, Y in stellar radii, +Z toward the observer; mid-transit = inferior conjunction;
  Claret law `I = 1 - sum a_n (1 - mu^(n/2))`; times stored relative to `data.tRef`.
