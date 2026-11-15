# Handoff: Exoplanet Science Lab

Paste the block below into a new Claude Code session opened in this folder. The rest of this file is the
detail it refers to.

---

## Prompt to start with

> You are continuing work on **Exoplanet Science Lab**, a browser app (Vite + three.js, plain ES modules) that
> models exoplanet transits and fits them with an in-browser nested sampler. It will be hosted at
> exoplanet.science. Read `HANDOFF.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` before
> changing anything.
>
> The project was written in a sandbox with no network, so some things have **never been executed**. Do these
> first, in order, and report what you find before moving on:
>
> 1. `npm install`, `npm test` (all suites should pass), then `npm run dev` and open the app.
> 2. **The three.js scene has never rendered.** Only its GLSL was compiled, in a bare WebGL harness
>    (`test/shaders.html`). Open the app, check the console, and fix `src/viz/scene.js` until the Orbit,
>    From Earth and Top down views, the Earth-view inset, the habitable zone ring, the Look panel toggles and
>    the planet size classes all work. If the scene throws, the app falls back to a 2D schematic, so look for
>    the amber notice.
> 3. Check in a real browser: figure export (PNG/PDF), the Rec button (movie of system view + light curve,
>    only tested against the 2D fallback), clipboard copy, priors import/export, and the layout on a phone.
> 4. Run `tools/build_ld_table.py` (needs `pip install ldtk numpy`; it downloads PHOENIX spectra). It is
>    untested. Fix it if needed, then bundle the result in `src/data/ld_table.js` and compare its coefficients
>    with ExoTETHyS for HD 80606 in the TESS band (`[0.4939, -0.0729, 0.4578, -0.2158]`, four-parameter law).
> 5. `npm run build` and confirm the production bundle works, including the Web Worker.
>
> Then follow `docs/ROADMAP.md`. Before adding multi-planet or multi-dataset fitting, namespace the parameter
> registry and split `src/main.js` as described in `docs/ARCHITECTURE.md`. Every new model needs a Node test
> against an independent reference before UI is built on it, and results should be validated against the
> owner's published work (start with `validation/README.md`). The owner's EXOTIC repository
> (https://github.com/rzellem/EXOTIC) is the reference implementation for fitting conventions.

---

## What exists

- **Transit model** (`src/core/transit.js`): Claret four-coefficient limb darkening, with linear, quadratic,
  Kipping and square-root laws mapped onto it. Flux by a line integral around the planet's limb. Checked
  against scipy quadrature to 6e-13. Exposure averaging is automatic.
- **Orbit** (`src/core/kepler.js`): robust Kepler solver, event times, numerically exact contact durations.
- **Sampler** (`src/core/nested.js`): MLFriends region sampling in the style of UltraNest, plateau handling,
  slice fallback, insertion-order test, lnZ error from simulated volume shrinkage. lnZ matches quadrature on
  1 to 3 parameter transit likelihoods within its reported error.
- **Likelihood** (`src/core/model.js`): `flux = a1 * exp(k * airmass) * transit`, with a1 integrated out
  analytically. Priors are Uniform or Normal.
- **Limb darkening from the star** (`src/core/ldest.js`): grey-atmosphere estimate now; PHOENIX table when
  built; "follow the star" mode samples Teff (and [Fe/H] with a table) instead of the coefficients.
- **Stellar mass and radius** from Teff, log g, [Fe/H] (Torres et al. 2010).
- **System table** following Table 7 of Pearson et al. (2022), habitable zone, planet size classes.
- **Data**: reader for delimited text, AAVSO exoplanet reports, EXOTIC FinalLightCurve files, magnitudes,
  MJD/BTJD/BKJD; simulator; bundled HD 80606 b TESS light curve from EXOTIC's examples.
- **Timing** (`src/core/ephemeris.js`, `src/ui/timingTab.js`, `src/ui/ocplot.js`): linear and quadratic ephemeris
  fits to a list of mid-transit times, O − C plot, BIC comparison, upcoming transits. Added 2026-11-15.
- **Multi-epoch fits**: `data.epoch` + `data.segments`, per-epoch marginalised baseline and airmass keys `a2@n` in
  `buildProblem`, epoch tools in `src/core/data.js`, folded light curve. Added 2026-11-15. No per-epoch mid-times,
  one exposure and one band for all epochs.
- **Several planets, velocities, joint fits** (2026-11-15): `buildProblem` takes `planets`, `kepler`, `rv`, `timing`;
  `src/core/rv.js`; planet-scoped keys (`per@c`), per-instrument jitter (`jit@rv2`). EXOTIC's examples are
  reproduced in `test/exotic.test.mjs` against EXOTIC and pylightcurve run from `/Users/kpearson/miniconda3/envs/exotic`.
- **Start page, examples, catalog** (2026-11-15): `src/ui/intro.js`, `src/ui/examples.js`, `src/core/catalog.js`,
  snapshot in `public/catalog/` (15 MB, rebuilt by `tools/build_catalog.py`), example data in `public/examples/`.
- **Limb darkening table** (2026-11-15): bundled PHOENIX table, 37 bands, tested against ExoTETHyS (README). Handoff
  step 4 is done; the old grey model remains only as the fallback for custom ranges.
- **UI**: sliders with Full / Prior / Best fit ±5σ ranges, zoomable light curve, corner plot with sample
  scatter and 1/2/3σ contours, run history with Δ lnZ, undo/redo, exports (PNG, PDF, LaTeX, JSON, YAML, MP4/WebM).

## First run outside the sandbox (2026-11-15, Node 22, Chrome)

- `npm install`, `npm test` (now nine suites or more: see test/run.mjs) and `npm run build` all pass; the worker chunk is emitted and a fit
  runs in the Web Worker under `npm run dev`.
- The three.js scene rendered on the first try with no console errors: Orbit, From Earth and Top down views, the
  Earth-view inset, every Look panel toggle and style, the habitable zone ring, and all three presets.
- Still open from the list above: step 3 (Rec with the WebGL canvas, clipboard, priors import/export were not
  exercised), step 4 (`tools/build_ld_table.py`), and loading the built `dist/` in a browser (only built, not served).
- The Playwright drivers in `test/` hard-code `/usr/bin/google-chrome` and were not run (no Playwright here).
- `.venv/` (numpy, scipy) exists for the reference scripts; it is ignored by git.

## Not verified

- Movie recording with the WebGL canvas.
- `tools/build_ld_table.py`.
- Anything inside the hosted artifact frame (save dialog, clipboard, recording).
- A direct comparison with pylightcurve or EXOTIC output. The "30-node radial rule reaches 1e-5" figure in the
  README comes from a re-implementation of pylightcurve's method, not the package.
- The Results tab and exports on a phone.

## Known issues and open questions

- **Eclipse duration** for HD 80606 b: 0.0834 d here, 0.0717 d in the paper. Durations here come from bisection
  on the projected separation. Find how the paper computed E14.
- The bundled TESS light curve is diluted by HD 80607 and there is no dilution correction any more, so the
  fitted radius is about 30% small. The published error bars in that file are about three times the scatter.
- The grey-atmosphere limb darkening ignores log g and [Fe/H]. One comparison exists (0.012 rms against
  ExoTETHyS for HD 80606 / TESS).
- A likelihood plateau covering most of the prior biases lnZ low by about 0.2.
- The habitable-zone albedo scaling is a heuristic of this app, not from Kopparapu et al.
- No licence file yet. EXOTIC's own licence text is in the copy of `elca.py` this was ported from.

## Things found in EXOTIC while porting (not fixed there)

1. `exotic/api/gael_ld.py`, `ldx`: `gamma4` is tied to `1 - gamma1 - gamma2 - gamma3`, forcing zero intensity
   at the limb; in `quadratic` mode that leaves one free coefficient and in `linear` mode the only coefficient
   the model reads is fixed at zero. Read from the code, not run.
2. `exotic/api/multi_fitter.py`, `phasecurve`: uses keys `u1..u4` (everything else uses `u0..u3`) and passes
   four Claret coefficients with `method='quad'`.
3. `exotic/api/elca.py`: `bic = k ln(n) - 2 ln(chi2)`; should be `chi2 + k ln(n)`.

## References used

- Pearson et al. 2022, arXiv:2208.14520 (HD 80606 b; Table 7 is the model for the system table)
- EXOTIC: https://github.com/rzellem/EXOTIC · pylightcurve: https://github.com/ucl-exoplanets/pylightcurve
- UltraNest: https://github.com/JohannesBuchner/UltraNest
- Torres, Andersen & Giménez 2010 (mass-radius calibration) · Kopparapu et al. 2013, 2014 (habitable zone)
- Next validation set: https://github.com/pearsonkyle/Exoplanet-Mapping
