# Exoplanet Science Lab

Browser app for modelling and fitting exoplanet light curves. Vite + three.js, plain ES modules, no framework.
Read `HANDOFF.md` first: it has the current state, what has never been run, and the roadmap.

## Commands
- `npm install` then `npm run dev` (Vite) · `npm run build` · `npm test` (Node numerical tests, about 2 min)
- Reference scripts (`test/make_*.py`) run with `.venv/bin/python` (numpy, scipy)
- Browser checks need Python + Playwright + Chrome and a static server on :8765:
  `python3 -m http.server 8765` then `python3 test/features_check.py /tmp/esl` and `python3 test/export_check.py /tmp/esl`

## Rules for this repo
- `src/core/` is science code: no DOM, no three.js, runnable in Node. Every new model gets a test in `test/`
  against an independent reference (analytic limit, scipy quadrature, a published value) before any UI is built on it.
- Report numbers with their check. If something could not be run or compared, say so in the README section for it.
- The likelihood is assembled in one place, `buildProblem` in `src/core/model.js`. Extend it; do not fork it.
- State lives in the single `S` object in `src/main.js`; anything a user can change must go through `pushUndo()` first.
- Data and fit results are replaced, never mutated in place (undo holds them by reference).
- Plots are pure render functions taking a theme (`renderLightCurve`, `drawCorner`) so screen, export and movie share code.
- Several planets: key suffix `@c`, first planet unscoped; RV datasets `jit@rv2`. Use `planetValues()` in main.js, never `S.values.per` directly.
- EXOTIC references: `test/make_exotic_reference.py` and `test/make_exotic_fits.py` run with `/Users/kpearson/miniconda3/envs/exotic/bin/python`.
- The page opens on the start page; append `?skipintro` to the URL for tests and automation.
- Several epochs: `data.epoch` (index per point) and `data.segments`; per-epoch parameters use keys `name@n` (`a2@2`).
- Conventions: sky plane X, Y in stellar radii, +Z toward the observer; mid-transit = inferior conjunction;
  Claret law `I = 1 - sum a_n (1 - mu^(n/2))`; times stored relative to `data.tRef`.
