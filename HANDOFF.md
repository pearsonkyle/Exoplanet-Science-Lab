# Handoff: Exoplanet Science Lab

Paste the block below into a new Claude Code session opened in this folder. The rest of this file is the detail it
refers to. State as of 2026-11-16, end of the seventh working round.

---

## Prompt to start with

> You are continuing work on **Exoplanet Science Lab**, a static site (Vite + three.js, plain ES modules) for
> planning, observing, reducing and fitting exoplanet observations entirely in the browser, with a Python package
> and an MCP server on the same core. It will be hosted at exoplanet.science. Read `HANDOFF.md`, `CLAUDE.md`,
> `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` before changing anything; `README.md` and `docs/METHODS.md` have
> every number with its check.
>
> 1. `npm install`, `npm test` (98 Node suites, about 27 minutes), `npm run build`.
> 2. The site has been verified with headless Chromium only (`tools/shot.py`, `test/layout_check.py`,
>    `test/xr_check.py` with an emulated headset). The list under "Not verified" is what a person with a real
>    browser, phone and headset should try first.
> 3. Then follow `docs/ROADMAP.md`. Every new model needs a Node test against an independent reference before UI
>    is built on it. The owner's EXOTIC repository is the reference for fitting conventions; never write into it.
>    Community features (accounts, shared results) are deliberately postponed.

---

## What exists

**Science core** (`src/core/`, no DOM, runs in Node; every file has a test in `test/`)
- `transit.js`, `kepler.js`, `rv.js`: Claret limb-darkened transit by a line integral, Kepler solver, RVs.
- `model.js`: the one likelihood, `buildProblem`. Light curves (several epochs, per-epoch baseline and linear
  regressors integrated out, nearest-neighbour kernel systematics, per-epoch exposure), velocities (zero points
  integrated out, jitter), mid-transit and mid-eclipse times, several planets (`per@c`), Kepler-tied a/R★ (never
  sampled), √e cos ω / √e sin ω, and three optional models: the planet's own light (`phasecurve.js`), a moon
  (`exomoon.js`), N-body dynamics for times, velocities and light curves (`nbody.js`, with MEGNO and
  mean-ephemeris elements).
- `nested.js`, `fitRunner.js`: MLFriends nested sampler with whitening, an ellipsoid check, slice fallback,
  warnings, a call budget.
- `session.js`, `exportScript.js`, `methodsText.js`, `docs/FORMAT.md`: the session document, headless `runSession`,
  exports (Python, Markdown, LaTeX) and the methods paragraph with BibTeX.
- `detrend.js` (regressors, PLD, kernel, comparison ensemble), `aavso.js` (Exoplanet Watch report), `fits.js`,
  `photometry.js`, `gp.js`, `psd.js`: images to light curves and their diagnostics.
- `imexam.js`: image inspection (radial profile, curve of growth, half-flux diameter, line cut, region statistics,
  pixel table, saturation level, focus map across the field, comparison-star ranking); `lcfits.js`: TESS / Kepler /
  K2 FITS light-curve tables to the analyzer.
- `spectroscopy.js`, `missionbands.js`: JWST/Ariel time-series spectroscopy and a simple simulator.
- `atmosphere.js`, `continuum.js`, `opacity.js`, `transmission.js`, `emission.js`, `rtmodel.js`, `colour.js`: the
  atmosphere forward model (layers, T-P profiles, k-tables of twelve gases interpolated in (log P, 1/T) and mixed
  by random overlap, CIA, Rayleigh, cloud deck, hazes, a particle layer, patchy cover; transmission and emission
  spectra; spectrum to sRGB, in true colour or with any wavelength range laid over the visible). `chemistry.js` reads a FastChem equilibrium grid
  (`public/chem/`, built by `tools/chem/`); `climate.js` solves a temperature profile from the gas (a grey closure on the model's own opacities, energy-balanced; not radiative-convective equilibrium); `escape.js` and `ionization.js` are estimates of mass loss, fractionation
  and sodium ionization (walk-through: `docs/guide/atmosphere.md`). The page's 3D
  "Planet" view is a ray-marched single-scattering render (`atmoPlanetFrag`, inputs from `src/viz/atmoview.js`). Tables in
  `public/opacity/` (25 MB, ESLO format, each gas fetched when first switched on, built by
  `tools/opacity/`); `climate.js` (profile from the gases, inversions), `condensation.js` (rain-out, cloud bases),
  `mie.js` + `optical.js` (tholin haze), `worlds.js` (WASP-39 b, WASP-121 b's day side, Jupiter, Titan), `atmoapi.js`
  (one JSON call: `esl.atmosphere()` in Python, `atmosphere_spectrum` in the MCP server), the WebAssembly mixing
  kernel (`tools/wasm/`, `public/wasm/mix.wasm`); page `/analyze/atmosphere/` (`src/atmosphere/`, 3D helpers in `src/viz/atmoview.js`).
- `rvsources.js`: radial velocities from VizieR (HIRES, HARPS RVBank, Lick).
- `ephemeris.js`, `periodogram.js`, `ldest.js`, `ldspec.js`, `derive.js`, `catalog.js`, `sources/`, `relations.js`,
  `astro.js`, `observability.js`, `horizon.js`, `data.js` (with time-standard conversion), `pyentry.js`, `pyshim.js`.

**Pages**: `/plan/`, `/observe/` (with WebXR), `/analyze/`, `/analyze/photometry/`, `/analyze/spectroscopy/`, `/analyze/atmosphere/`,
`/search/`, `/methods/` (methods, validation, reproducibility, references, how to cite), and the landing page.
Old `/observe/photometry/`, `/observe/spectroscopy/`, `/validation/` redirect. README "The site" describes each.

**Site-wide**: the navigation bar (`src/site/nav.js`, folds into a menu on phones), tap-for-tooltip
(`src/site/tips.js`), the Analyze sub-bar (`subnav.js`), the observing-project checklist (`project.js`,
`window.__esl.project`), and the assistant's chat bubble (`src/assistant/`, lazy-loaded). Each page exposes
`window.__esl.<page>` tools; the analyzer's scripted surface is `src/ui/api.js` (`describe()` lists it).

**Outside the site**: `python/` (the `esl` package: the same core run from Python), `mcp/` (MCP server over session
documents).

**Observing (2026-11-18)**: `observe/run/` runs a sequence (`src/core/sequence.js`) on a camera
(`src/observe/run/cameras.js`): the local helper `python -m esl.bridge` (ASCOM Alpaca; ZWO through zwoasi, Alpaca
pass-through, a simulator), any CORS-enabled Alpaca device, or a simulated sky in the page (`src/core/simsky.js`,
tracking errors, real planets' transits on a rehearsal clock: `src/core/rehearsal.js`). Frames get
`src/core/fitsheader.js` headers; lights are reduced live by `src/core/reduce.js` (runStack's per-frame body).
"Now" on Plan, Observe and Run is `src/site/clock.js` (the site's Date header, the helper's NTP/gpsd, Web Serial GPS;
`src/core/clocksync.js`), shown in the scales of `src/core/timeformat.js`; the one leap-second table is
`src/core/timescale.js`. Python: `esl.time`, `esl.bridge`, `esl.cameras`, `esl.observe`. Guide: docs/guide/observing.md.
Next: a real ZWO run, plate solving in Run, mount and filter-wheel control (Alpaca telescope/filterwheel), INDI.

## Not verified

- Observing: no real camera, mount, USB GPS or gpsd has been connected; the ZWO backend was tested against a fake
  SDK only. No Analyze fit of a Run light curve was run (the hand-off was).
- Any real device: phones (layouts, pinch, AR), a WebXR headset (Quest checklist below), Safari and Firefox.
  Everything was checked in headless Chromium at 390, 768 and 1440 px.
- A real https deployment: the assistant's VPN preset is plain http and is blocked from https pages (mixed
  content); LM Studio on localhost needs "Enable CORS" and Chrome's local-network permission. Only emulated.
- The interactive file paths: folder picker and drag-and-drop on the photometry, spectroscopy and assistant
  panels, clipboard, save dialogs; dropping a FITS light-curve table on the analyzer (the file input was tested).
- The image tools with real fingers: one-finger drag draws a cut or box, two fingers pan (only mouse drags were
  driven headlessly); the focus map on a full-size frame (tested on 320 × 240 and 152 × 166 px frames).
- Photometry: the live view mid-run, the folder picker and real drag-and-drop of zips (file input and a synthetic drop
  were driven), the analyzer reading the per-transit window index of a prepared hand-off (it loads the windows as one
  curve), an `fpack` file, real frames beyond EXOTIC's
  HAT-P-32 sample set. Spectroscopy: gzipped FITS, NIRSpec PRISM, the hand-off arrival in Analyze.
- The mean-ephemeris N-body fit in the browser (Node only, 367 s); photodynamics with a phase curve or moon planet.
- The Python package on Linux, Windows, or Python other than 3.12. Detrending in `runSession` and Python is checked
  in Node and pytest only, not with a session exported by a real browser from the photometry page.
- The assistant with any model other than the owner's gemma4-e4b (vLLM); the MCP server inside a desktop client.
- `tools/build_esl_catalog.py` with downloads (only `--no-download`).

**Quest checklist** (Observe → VR, https or localhost): menu readable below the horizon; point at a bright star, the
name appears, trigger opens its card; thumbstick left/right runs time, up/down changes the star limit, click pauses;
grip + sweep turns the sky, B then grip scrubs time; A twice brings the menu in front; pick a transit from the menu
and check the track, window and 30° ring; put the controllers down and pinch; Passthrough: "On: Moon" → "Point &
set" → point at the real Moon. **Phone**: 390 px portrait has no sideways scroll; Tonight → tap a transit; AR chip
follows the phone; Android Chrome Passthrough chip.

## Known issues and open questions

- **Spectroscopy**: on WASP-39 b G395H the spectrum's shape matches Alderson et al. 2023 (correlation 0.974) but
  lies 202 ppm low on average; not explained (geometry, fixed limb darkening, standard-pipeline extraction).
  Band limits are top-hats; the JWST/Ariel limits were entered from the mission documents and should be checked
  against the current instrument tables.
- **Sampler**: one seed of the full stress suite misses three of 47 problems (20-D ρ = 0.999 Gaussian at its
  budget, 5-D banana widths 23%, 8-D narrow peak +0.80 unflagged; over 32 seeds the last is 0.085 ± 0.076). The
  funnel keeps −0.045 ± 0.026. `f-ldwalls` (free quadratic limb darkening) is +0.14 ± 0.05 against its grid.
- **Assistant**: a 4B model completes the full plan → simulate → fit → report session in about one run in four;
  it skips steps, picks TESS candidates and has once reported another planet's numbers under a candidate's name.
  The number check catches dropped uncertainties, not wrong units or conclusions. Try a larger model.
- **N-body**: planets one at a time in the light curve (no mutual events); the companion search's mask uses the
  analytic super-period, not the simulated O − C periodicity; mean elements fail inside resonances.
- **Phase curves**: Y1,−1 is unconstrained in both map examples unless `phase.positive_map` is on (then ±0.06 for
  WASP-43 b; README "The planet's own light"); data are pre-detrended. The stored WASP-43 b eclipse map (y10 0.693) is a
  degree-1 map negative on 8.4% of the sphere; a positive one needs degree 2 (refit numbers in README).
  **For the examples agent**: the stored results in `public/examples/results/` were NOT regenerated with `positive_map`;
  if an example should use it, set `"positive_map": true` in its `phase` block (and `lmax` 2 with y20, y21, y22 free
  for WASP-43 b) and rerun it; a degree-1 positive refit loses 11.6 in ln Z.
- **Catalogue**: the archive's best-timed ephemeris is wrong for 61 planets (another planet's period) and is now
  ignored; `sy_jmag` is not in the snapshot, so TSM needs a J magnitude typed in. exoplanet.eu's epoch errors
  carried the Kepler offset for 117 planets (fixed in `sources/eu.js`); its own period errors are still poor for
  some KOIs. Plan's Ephemeris menu does not yet offer exoplanet.eu (`chooseEphemeris` in `sources/index.js` is ready).
- **Image tools**: comparison stars are ranked on the first frame only (no variability, colour or catalogue of
  variables); saturation is known only from SATURATE/DATAMAX or the integer format; the focus verdict thresholds
  were chosen on synthetic fields. Darks are not scaled by exposure.
- **Photometry**: no plate solving or VSX/VSP queries (EXOTIC uses nova.astrometry.net with a key), no dark
  rejection; at EXOTIC's own aperture cell this code is worse (0.599% against 0.573%), reason unknown.
- **Observe**: in headless SwiftShader the Ground and Atmosphere layers sometimes log four shader
  `VALIDATE_STATUS` errors (and fail `layout_check` at 390 px); the page renders. Not seen on a GPU (not tried).
- **Eclipse duration** for HD 80606 b: 0.0835 d (contacts 1–4), 0.0682 d (2–3), 0.0759 d (centre on the limb);
  the paper's 0.0717 d is reproduced by none.
- The bundled TESS light curve of HD 80606 is diluted by HD 80607; the dilution term `dil` exists but the HD 80607
  flux ratio in the TESS band is not in the repository, so the stored example is fitted without it.
- Rossiter–McLaughlin (`src/core/rm.js`): first moment by default; a CCF (Gaussian-fit) form, exposure averaging and the
  spectrograph's limb darkening are options (`"rm"` block, docs/FORMAT.md), for the whole fit, not per dataset. HD 80606 b
  check fit (`test/hd80606rm.test.mjs`): v sin i = 1.47 +0.22 −0.17 km/s, λ = 58 +16 −12° against Hébrard et al. 2010
  42 ± 8°; it needs Rp/R★ ≈ 0.10 (the joint example's 0.0725 is TESS diluted by HD 80607) and uses both partial
  transits in the file (SOPHIE 2009 Feb 14, 28 points in transit; HIRES 2009 Jun 5, 8). The hd80606-rm example row in
  `src/methods/content.js` mentions only the HIRES points and the TESS limb darkening (the examples agent's entry).
  Light-curve jitter is white (no correlated noise).
- Physical priors (`"physical"` block: crossing, Hill, Hill spacing, AMD, Roche, MEGNO) and period aliases (categorical
  `nalias`, `src/core/aliases.js`) exist in the core and sessions only; no UI. Hill/AMD assume coplanar orbits.
- `node tools/build_methods_md.mjs` stopped at "example toi1873: no stored result" while the examples agent was adding
  that example, so docs/METHODS.md was not regenerated after the Methods text for these options was added: rerun it
  (and `--check`) once `public/examples/results/toi1873.json` exists.
- `src/main.js` is about 2,500 lines; only the API has been split out (`docs/ARCHITECTURE.md` says how to go on).
- `src/core/astro.js` and `observability.js` duplicate Sun, Moon and alt-az code.
- No licence file yet (the owner's decision). Methods' References tab and the Methods agent's notes list the
  third-party data and their terms; the EXOTIC sample frames (`test/data/hatp32_exotic_sample.fits`) state no
  licence and are committed for a test: decide before the repository goes public.
- Decide whether to commit the generated Python bundle (`python/esl/_core/*.js`, currently ignored).

- Analyzer layout (round 8): the plot / 3D view / panel grips and the adaptive figure layouts were checked only in
  headless Chromium (screenshots of every example at four plot shapes); not with real touch. `test/export_check.py`
  imports `./src/ui/export.js` relative to `/analyze/`, which no longer resolves; it passes with `../src/` against a
  static server on the repository root. The 3D planet shows the map of the current values, not a posterior median map.

## Environments (all ignored by git)

`.venv` (numpy, scipy, playwright), `.venv-sky`, `.venv-plan`, `.venv-phot` (photutils, mc3, astropy),
`.venv-validation` (batman, pyaneti, …), `.venv-nest` (UltraNest with numpy 1.26), `.venv-moon` (Pandora),
`.venv-phase` (starry, jaxoplanet, batman), `.venv-nbody` (REBOUND 5.2.2, TTVFast), `.venv-lk` (lightkurve 2.6, wotan 2.1, patsy, fbpca: TPF and
light-curve references; downloads cached in ~/.cache/esl-lk), `.venv-terrain` (numpy,
pyproj, Pillow), `.venv-py` (the Python package and pytest), `.venv-rt` (petitRADTRANS 3.4.0, exo_k, pyfastchem, colour-science, h5py: the atmosphere references and
the opacity build; set-up in `tools/opacity/README.md`; source files, about 10 GB with the study's, in `data-src/`, ignored), and the owner's conda environment
`/Users/kpearson/miniconda3/envs/exotic` (EXOTIC 4.3.1; read only, nothing installed). The JWST test files
(207 MB) go in `test/data/jwst/` (ignored; URLs in `test/make_spectroscopy_reference.py`). Long headless runs
should use a built copy (`npx vite build --outDir /tmp/esl-dist`, `python3 -m http.server 8899 -d /tmp/esl-dist`,
`ESL_BASE=http://localhost:8899`) because the dev server reloads when files change.

## Things found in EXOTIC and the owner's codes (not fixed there)

1. `exotic/api/gael_ld.py`, `ldx`: `gamma4` tied to `1 - gamma1 - gamma2 - gamma3` (zero intensity at the limb).
2. `exotic/api/multi_fitter.py`, `phasecurve`: keys `u1..u4`, four Claret coefficients with `method='quad'`; its
   eclipse ingress is that of a body of radius `rprs·√fpfs`.
3. `exotic/api/elca.py`: `bic = k ln(n) - 2 ln(chi2)`; in least-squares mode it minimises the fourth power.
4. `exotic.py` photometry: centroid is a flux-weighted mean of a 31 × 31 box with the sky in; sky is the mode of a
   box including the star; `hdr_time == 'MJD_OBS'` can never match; gain assumed 1; "Airmass" column holds the model.
5. `nbody.py`: RV along a sky axis (committed copy); transit times interpolated linearly between hourly outputs;
   `ttv_grid.fits` missing; `stability()` applies the mutual Hill radius to star-planet pairs (a hot Jupiter with an
   outer giant stops at t = 0); RVs off by up to 38 m/s at HD 80606 b's periastron; `estimate_prior` axis spacing
   N/(N−1)·CDELT and a transposed RV grid; `nbody_fitter` uses priors only as cuts.
6. K uses Mp/M★ instead of the two-body expression (0.38% in mass for HD 80606 b).
7. `exomoon2.py`: 4π for 4π² in Kepler's law (separations 1.46× too large). Nbody-AI: RV along a sky axis.

## References used

- Pearson et al. 2022, arXiv:2208.14520 (HD 80606 b; Table 7 is the model for the system table)
- EXOTIC: https://github.com/rzellem/EXOTIC · pylightcurve: https://github.com/ucl-exoplanets/pylightcurve
- UltraNest, REBOUND, https://github.com/pearsonkyle/Exoplanet-Mapping, https://github.com/pearsonkyle/Nbody-AI
- The Methods page's References tab (`src/validation/refs.js`, `docs/references.bib`) has all 98 with DOIs.
