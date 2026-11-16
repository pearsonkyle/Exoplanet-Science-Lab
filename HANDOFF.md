# Handoff: Exoplanet Science Lab

Paste the block below into a new Claude Code session opened in this folder. The rest of this file is the
detail it refers to. State as of 2026-11-15, end of the fifth working round; only the first commit (`b3f40f3`)
exists, everything since is uncommitted.

---

## Prompt to start with

> You are continuing work on **Exoplanet Science Lab**, a static site (Vite + three.js, plain ES modules) for
> planning, observing, reducing and fitting exoplanet observations entirely in the browser. It will be hosted at
> exoplanet.science. Read `HANDOFF.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` before
> changing anything; `README.md` has every number with its check.
>
> 1. `npm install`, `npm test` (35 Node suites, about 8 minutes), `npm run build`.
> 2. The site has been verified with headless Chromium only (`tools/shot.py`). The list under "Not verified"
>    is what a person with a real browser, phone and headset should try first.
> 3. Then follow `docs/ROADMAP.md`. Every new model needs a Node test against an independent reference before
>    UI is built on it. The owner's EXOTIC repository is the reference for fitting conventions; never write
>    into it. Community features (accounts, shared results) are deliberately postponed.

---

## What exists

**Science core** (`src/core/`, no DOM, runs in Node; every file has a test in `test/`)
- `transit.js`, `kepler.js`, `rv.js`: Claret limb-darkened transit by a line integral, robust Kepler solver, RVs.
- `model.js`: the one likelihood, `buildProblem`. Light curves (several epochs, per-epoch baseline integrated
  out, per-epoch exposure), velocities (zero points integrated out, jitter), mid-transit and mid-eclipse times,
  several planets (`per@c`), Kepler-tied a/R★ (never sampled), and three optional models: the planet's own
  light (`phasecurve.js`), a moon (`exomoon.js`), N-body dynamics for times and velocities (`nbody.js`).
- `nested.js`, `fitRunner.js`: MLFriends nested sampler with whitening, slice fallback, warnings, a call budget.
- `session.js`, `exportScript.js`, `docs/FORMAT.md`: the session document, headless `runSession`, exports as
  Python, Markdown and LaTeX.
- `ephemeris.js`, `periodogram.js`: timing fits and periodic signals. `ldest.js`, `ldspec.js`: limb darkening
  from the star in 37 bands or any wavelength range. `derive.js`: the system table. `catalog.js`, `sources/`,
  `relations.js`: catalogues, merging, gap-filling relations. `astro.js`, `observability.js`, `horizon.js`:
  sky positions, transit observability, terrain horizon. `fits.js`, `photometry.js`, `gp.js`, `psd.js`: images
  to light curves and their diagnostics. `pyentry.js`, `pyshim.js`: the entry points of the Python bundle.

**Pages**: `/analyze/` (`src/main.js`, `src/ui/`, `src/viz/`), `/plan/`, `/observe/`, `/observe/photometry/`,
`/search/`, `/validation/`, and the landing page. README "The site" describes each and what was checked.

**Analyzer features added in round five**: guided tour and foldable panels; data that stay put while sliders
move (frozen display normalisation, "Re-centre data"); planet and observation colours; all planets' folded
panels and RV signals on a shared scale; phase-curve and map views; moon view and search; Dynamics block on
the Timing tab; saved analyses in IndexedDB; stored posteriors for every example; model comparison in words
with cautions; choice of the figure in recorded movies; EXOTIC's bounds preset; `window.__esl.api`.

**Outside the site**: `python/` (the `esl` package: the same core run from Python), `mcp/` (MCP server over
session documents), `src/assistant/` (the in-page assistant that talks to a local OpenAI-compatible model).

## Not verified

- Any real device: phones (AR, pinch, layouts), a WebXR headset, Safari and Firefox. Everything was checked in
  headless Chromium at 1440 px and 390 px.
- The interactive file paths: folder picker and drag-and-drop on the photometry page, clipboard, save dialogs.
- Photometry: the live view mid-run, K2 fetching in a browser, a file from `fpack`. Real ground-based frames
  beyond EXOTIC's HAT-P-32 sample set.
- The N-body worker pool in browsers other than headless Chromium; perturbed-system transit durations.
- The Python package on Linux, Windows, or Python other than 3.12; nothing is on PyPI.
- The assistant against any server other than the owner's vLLM; the MCP server inside a desktop client.
- `tools/build_esl_catalog.py` with downloads (only `--no-download`); `tools/build_ld_table.py` was run once.
- The crawler's licence reading: two all-sky images are embedded on the strength of the organisations'
  general terms pages.

## Known issues and open questions

- **Moon in 3D**: the moon is in the model and the plots but not drawn in the system view.
- **N-body**: light curves and mid-eclipse times stay Keplerian; fits that also sample the transiting planet's
  own period and T0 do not converge (150,000 calls), so `nbody.linear` profiles a straight line instead; the
  evidence of such a fit is not comparable with a Keplerian one. The Dynamics block's χ² is without that line.
- **Phase curves**: with several planets the fluxes are multiplied, which double counts the star's light at the
  1e-6 level; Y1,−1 is unconstrained in both map examples; data are pre-detrended.
- **Analyzer API gaps** the assistant works around by export → edit → import (which resets the run history):
  runs and comparison, add/remove planet, limb-darkening mode, simulate, data edits, progress, figures. Listed
  in the assistant agent's report; add them to `makeAPI()` in `src/main.js`.
- `runSession` has no hook for "follow the star" limb darkening; `pyentry.js` repeats eight lines for it.
- `hd80606-tess.json` is the one stored result that does not re-run to the same call count (12,813 against
  12,837, 0.004σ): `specFromSession` derives the sub-sampling from post-fit values.
- The sampler's evidence is biased low by a few tenths for funnel-shaped posteriors, sometimes without a warning.
- `src/core/astro.js` and `src/core/observability.js` duplicate Sun, Moon and alt-az code.
- The sky page shows local time in the browser's zone, the planner in the site's.
- The analyzer overflows horizontally at 390 px.
- `src/main.js` is about 2,100 lines; `docs/ARCHITECTURE.md` says how to split it.
- **Eclipse duration** for HD 80606 b: 0.0834 d here and 0.08337 d from a 30-digit orbit; the paper's 0.0717 d
  is reproduced by no method tried.
- The bundled TESS light curve of HD 80606 is diluted by HD 80607; there is no dilution correction.
- No licence file yet. The EXOTIC sample frames used by a photometry test state no licence and are kept out of `public/`.
- Decide whether to commit the generated Python bundle (`python/esl/_core/*.js`, currently ignored).

## Environments (all ignored by git)

`.venv` (numpy, scipy, playwright), `.venv-sky`, `.venv-plan`, `.venv-phot` (photutils, mc3), `.venv-validation`
(batman, pyaneti, …), `.venv-nest` (UltraNest with numpy 1.26), `.venv-moon` (Pandora), `.venv-phase` (starry,
jaxoplanet, batman), `.venv-nbody` (REBOUND 5.2.2, TTVFast), `.venv-py` (the Python package and pytest), and the
owner's conda environment `/Users/kpearson/miniconda3/envs/exotic` (EXOTIC 4.3.1; nothing was installed into it).
Long headless runs should use a built copy (`npm run build; python3 -m http.server 8899 -d dist`,
`ESL_BASE=http://localhost:8899`) because the dev server reloads when files change.

## Things found in EXOTIC while porting (not fixed there)

1. `exotic/api/gael_ld.py`, `ldx`: `gamma4` is tied to `1 - gamma1 - gamma2 - gamma3`, forcing zero intensity
   at the limb. Read from the code, not run.
2. `exotic/api/multi_fitter.py`, `phasecurve`: uses keys `u1..u4` (everything else uses `u0..u3`) and passes
   four Claret coefficients with `method='quad'`; its eclipse ingress is that of a body of radius `rprs·√fpfs`.
3. `exotic/api/elca.py`: `bic = k ln(n) - 2 ln(chi2)`; should be `chi2 + k ln(n)`. In least-squares mode
   `lc_fitter` passes squared residuals to `least_squares`, so it minimises the fourth power.
4. `exotic.py` photometry: the centroid is a flux-weighted mean of a 31 × 31 box with the sky left in; the sky
   estimate is the mode of a box that includes the star; `hdr_time == 'MJD_OBS'` can never match; photon errors
   assume gain 1; the "Airmass" column of the final light curve holds the airmass model.
5. `nbody.py` (committed): radial velocity taken along a sky axis; transit times interpolated linearly between
   hourly outputs; `ttv_grid.fits` is not in the repository. The uncommitted working copy fixes the first.
6. K uses Mp/M★ instead of the two-body expression (0.38% in mass for HD 80606 b).

## References used

- Pearson et al. 2022, arXiv:2208.14520 (HD 80606 b; Table 7 is the model for the system table)
- EXOTIC: https://github.com/rzellem/EXOTIC · pylightcurve: https://github.com/ucl-exoplanets/pylightcurve
- UltraNest: https://github.com/JohannesBuchner/UltraNest · REBOUND: https://github.com/hannorein/rebound
- https://github.com/pearsonkyle/Exoplanet-Mapping · https://github.com/pearsonkyle/Nbody-AI
- The Validation page's reference list (`src/validation/refs.js`) has the rest with DOIs.
