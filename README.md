# Exoplanet Science Lab

Interactive transit light-curve modelling and Bayesian fitting that runs entirely in the browser.
A JavaScript port of the model EXOTIC's `elca.py` gets from pylightcurve, a compact nested sampler
in the style of UltraNest, and a three.js view of the system.

Start with `HANDOFF.md` if you are picking this project up; `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` describe
how it is laid out and where it is going.

```
npm install
npm run dev        # Vite dev server
npm run build      # static site in dist/
npm test           # numerical tests (Node only, no browser needed)
```

`index.html` also carries an import map, so the folder runs from any static server with no build
step (`python3 -m http.server`), loading three.js from a CDN.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/kepler.js` | Kepler solver, orbit geometry, derived quantities (b, T14, stellar density) |
| `src/core/limbdark.js` | Limb darkening laws, conversions, physical-validity check |
| `src/core/transit.js` | Flux kernel and light curve, with exposure-time integration |
| `src/core/priors.js` | Uniform, normal, truncated normal, log-uniform as unit-cube transforms |
| `src/core/nested.js` | `MiniNest`, the nested sampler |
| `src/core/model.js` | Parameter registry and likelihood (`buildProblem`) |
| `src/core/periodogram.js` | Lomb-Scargle periodogram of timing residuals, false-alarm levels, sinusoid fits |
| `src/core/ldspec.js` | Limb darkening for any wavelength range from a wavelength-resolved table |
| `src/core/rv.js` | Radial velocity of the star, K from masses, a/R★ from Kepler's law |
| `src/core/catalog.js` | System parameters from the archive snapshot: reference selection, checks, provenance, priors |
| `src/core/ephemeris.js` | Linear and quadratic ephemerides from mid-transit times, epoch counting, timing-list reader |
| `src/core/derive.js` | System table: physical radius, a, K, event times and durations, T eq |
| `src/core/ldest.js` | Limb darkening from stellar parameters: grey atmosphere, law fitting, table interpolation |
| `src/core/hz.js` | Habitable zone limits and the uncertainty-blurred radial profile |
| `src/core/stellar.js` | Mass and radius from Teff, log g, [Fe/H] (Torres et al. 2010) |
| `src/core/config.js` | Priors and fit set-up to and from JSON or YAML |
| `tools/build_ld_table.py` | Builds the PHOENIX limb darkening table with LDTK (run it yourself; untested) |
| `src/core/fitRunner.js`, `src/worker/fit.worker.js` | Runs a fit in a Web Worker, with a main-thread fallback |
| `src/core/data.js` | Reads light curves (delimited text, AAVSO reports, EXOTIC outputs, magnitudes, MJD/BTJD) and simulates observations |
| `src/viz/scene.js`, `shaders.js` | three.js scene and GLSL |
| `src/viz/fallback2d.js` | Canvas schematic used when three.js or WebGL is unavailable |
| `src/ui/` | Light curve plot, corner plot, figure/table export (PNG, PDF, LaTeX, JSON), movie recording |
| `test/` | Kernel, parser and sampler tests; headless-browser driver; shader compile check |

`src/core` has no DOM or three.js dependency, so it can be reused from Node or another front end.

## The transit model

Conventions follow pylightcurve: sky plane X, Y in stellar radii, +Z toward the observer, and
mid-transit defined as inferior conjunction (omega + nu = 90 deg). Limb darkening is the Claret
four-coefficient law `I = 1 - sum a_n (1 - mu^(n/2))`; linear, quadratic, Kipping (q1, q2) and
square-root laws are mapped onto it exactly.

**Flux kernel.** pylightcurve integrates `I(r) r 2 acos(...)` radially with fixed-order
Gauss-Legendre. That integrand has square-root singularities at both ends. Here the area integral
is converted to a line integral around the occulted region (Green's theorem): with
`F(r) = int_0^r I r dr` in closed form, `blocked = oint F(r)/r^2 (x dy - y dx)`. Along the planet's
limb the integrand is smooth and periodic, so 12 midpoint nodes are enough when the planet is fully
on the disc; arcs that end on the stellar limb use 20 Gauss-Legendre nodes after a `phi -> u^2`
substitution that removes the remaining branch point. There is no `acos` in the inner loop.

Measured against scipy adaptive quadrature over 680 geometries (Rp/R* from 0.01 to 1.2, every
contact configuration, five profiles): maximum absolute error **2.2e-12** on that grid (the solar quadratic profile; the other four are under 6e-13). Over the wider grid of the Validation page (41 light curves and the kernel's branch points, against a 30-digit reference) the worst error is 3.1e-11 in a light curve and 1.4e-10 within 1e-13 of second contact. A 30-node Gauss-Legendre
rule on the radial form, written to mimic pylightcurve's approach, reaches **1e-5** on the same
set (worst at grazing geometries). pylightcurve itself was not installed where this was developed,
so that comparison is against a re-implementation of its method, not the package.

**Kepler solver.** Danby starter with a quartic update, iterated to machine precision
(residual 4e-16 for e up to 0.999). pylightcurve starts plain Newton at E = M and stops at 1e-7.

**Speed.** About 50 microseconds per likelihood for 400 points on a circular orbit, 150 for an
eccentric orbit with the four-coefficient law (one core, Node 22). The eccentric case is dominated
by trigonometric calls in the Kepler solve, which are already native code, so a WebAssembly kernel
would gain little; none is included. The kernel is isolated in `blockedFraction` if you want to try.

## Things found while reading EXOTIC

These are in the uploaded archive, not in this port.

1. `exotic/api/gael_ld.py`, `ldx`: `gamma4` is tied to `1 - gamma1 - gamma2 - gamma3`. That forces
   the intensity at the limb to exactly zero. In `quadratic` mode `gamma1` and `gamma3` are fixed at
   zero, so the tie leaves one free coefficient (`u2 = 1 - u1`). In `linear` mode the only
   coefficient the model reads (`gamma1`) is fixed at zero. Worth confirming against lmfit's
   handling of `expr`, but as written the quadratic and linear fits look over-constrained.
2. `exotic/api/multi_fitter.py`, `phasecurve`: reads `u1..u4` where every other function uses
   `u0..u3`, and passes four Claret coefficients with `method='quad'`.
3. `exotic/api/elca.py`: `bic = k ln(n) - 2 ln(chi2)`. For Gaussian errors it is `chi2 + k ln(n)`.
4. `loglike_airmass` sets the baseline to `median(data / model)`. The exact conditional maximum is
   the weighted least-squares amplitude, which is what `buildProblem` uses.
5. The likelihood omits the `ln(sigma)` term. Harmless with fixed errors, but it is needed for a
   correctly normalised evidence; it is included here.

A bug of my own, fixed in this version: `intensity()` in `limbdark.js` and the star shader used
exponents n/4 instead of n/2 for the Claret terms. The flux kernel was always correct (it is the
part checked against scipy), but the profile plot, the "physical profile" badge and the star's
shading were wrong. `test/kernel.test.mjs` now checks that `intensity()` integrates to the kernel's
normalisation.

Found later, while reproducing the examples (none fixed there):

4. `exotic/api/rv_fitter.py`: the likelihood is `-0.5 * sum over datasets of mean(chi2_i) / n_datasets`, a
   reduced χ² averaged over instruments, not χ². Posterior widths from it do not scale with the data.
5. `exotic/api/joint_fitter.py`: the light-curve χ² is multiplied by 2, and the timing term divides by
   `sigma + noise` rather than their quadrature sum.
6. `rv_fitter.py`, `joint_fitter.py`, `multi_fitter.py`: the stellar reflex velocity uses `mu = Mp / M*` with the
   semi-major axis from the total mass; the two-body factor is `Mp / (M* + Mp)`.
7. `examples/multi_planet/make_fake_data.py`: `cadence = 120.0 / (60 * 24)` is 120 minutes, described as 120 s.
8. `examples/single_transit/transit_fit_example.py`: the error bars (about 6e-4) are not scaled by `a1 = 50`, so
   they are 20 times smaller than the injected scatter. `examples/multiple_transit/multi_fit_example.py` passes
   `ferr = flux**0.5`, four times the injected scatter.
9. pylightcurve `eclipse_duration` returns 1.5e-12 d for HD 80606 b (its root finder fails at e = 0.93), so the
   published E14 = 0.0717 d did not come from that routine as it stands; the 0.0834 d here is still unexplained.

## Geometry and the Earth view

`test/physics.test.mjs` draws 400 random orbits (circular and eccentric, 85 grazing, 58
non-transiting) and checks at 160,000 times that the model flux drops below 1 exactly when the
planet's disc overlaps the star's with the planet in front. No mismatches. The "From Earth" view
used to be a perspective camera a few orbital radii away, which magnifies and displaces a planet
that sits nearer the camera than the star; it is now orthographic and at true scale, so it shows
the same projection the model integrates.

## System table (Table 7 of Pearson et al. 2022)

`deriveSystem` reproduces that table's rows from the fitted parameters and the stellar inputs
(the contaminated/corrected depth rows are left out). Fed the paper's own values, with the
radius ratio set to the square root of its corrected depth, it returns Rp = 1.031 R_Jup (paper
1.032), a = 0.4606 au (0.4603), K = 467.9 m/s (469.2), T_peri and E_mid within 0.001 d, and
T14 = 0.4985 d (0.4990). The eclipse duration does not match: 0.0834 d here against 0.0717 d in
the paper. Durations here are found by bisection on the projected separation; the paper does not
say how E14 was computed. The bundled TESS light curve is diluted by HD 80607 and the app no longer
corrects for that, so a fit to it returns a radius about 30% too small.

## Stellar mass and radius

If only Teff, log g and [Fe/H] are known, `estimateMassRadius` (`src/core/stellar.js`) uses the
Torres, Andersen & Gimenez (2010) eclipsing-binary calibration: scatter 6.4% in mass and 3.2% in
radius, calibrated above 0.6 Msun, flagged as extrapolated below. It returns 1.05 Msun, 1.02 Rsun
for solar inputs, the known offset of that relation.

## Limb darkening from stellar parameters

Two sources, picked automatically:

1. **Model-atmosphere table** (bundled, `src/data/ld_table.js`, 252 kB). `tools/build_ld_table.py` integrates the
   PHOENIX-ACES specific intensities (Husser et al. 2013, fetched through LDTK's file list and cache) over 37
   bands on every model from 2300 to 8000 K, log g 4.0/4.5/5.0 (5.5 below 4000 K) and [Fe/H] −0.5/0/+0.5, and fits
   the four-parameter law; the other laws are fitted to that profile. Measured response curves are used for TESS,
   Kepler, CHEOPS, Johnson UBV, Cousins RI, Sloan ugriz and JHK; EXOTIC's other filters and five JWST modes
   (NIRISS SOSS, NIRSpec PRISM and G395H, NIRCam F322W2 and F444W) are boxcars. Coefficients that would give a
   negative or limb-brightened disc are refitted under constraints, because the likelihood rejects such profiles.
   The app interpolates to the star and clamps, with a flag, outside the grid.
2. **Grey atmosphere** (fallback: a custom wavelength range, a band the table lacks, or no table). Emergent
   intensity of a grey atmosphere, band-averaged, with the law fitted by least squares. Depends on Teff and
   wavelength only; 0.012 rms from ExoTETHyS for HD 80606 in the TESS band.

Checks (`test/limbdark.test.mjs`, 509 reference profiles from `test/make_ld_reference.py`, which calls ExoTETHyS
through pylightcurve):

| Check | Result |
| --- | --- |
| HD 80606, TESS, against the coefficients EXOTIC's examples use | I(mu) rms 5.6e-5 over mu 0.05 to 1; transit depth 4.7e-5 relative; 0.56 ppm in flux |
| Four-parameter law against ExoTETHyS/PHOENIX, 16 bands, F to M dwarfs, [Fe/H] = 0 | worst I(mu) rms 0.0003 to 0.0009 by spectral type; depth within 9e-4; flux within 13 ppm for Rp/R★ = 0.1 |
| Quadratic law, same comparison | worst rms 0.0005 (F, G), 0.0013 (K), 0.0029 (M) |
| Against ExoTETHyS/ATLAS, Teff ≥ 3500 K (different atmosphere physics) | mean 0.0125 rms, worst 0.033: this model-to-model spread dominates everything above |

Caveats. The PHOENIX comparison tests the processing, grid and interpolation, not the physics: ExoTETHyS starts
from the same files. Those EXOTIC coefficients for HD 80606 are for solar metallicity (pylightcurve's PHOENIX set
is solar only); at the star's [Fe/H] = 0.35 the table differs from them by 0.0043 rms, 41 ppm in a transit. The
[Fe/H] response is only checked to order of magnitude, and the boxcar and JWST bands have no external reference.
Below mu = 0.1 the models have few points and both codes extrapolate. Stars off the grid are clamped: 0.0024 rms
at log g 3.7, 0.05 rms at 9600 K. The table makes the main bundle 508 kB, just over Vite's warning size.

A **custom wavelength range** is served by a second table (`src/data/ld_spectral.js`, 266 kB, fetched on first
use; built by `tools/build_ld_spectral.py`): the same PHOENIX models in 357 bins from 200 to 5500 nm, stored as
a mean plus 40 principal components, combined over the range with photon weighting (`src/core/ldspec.js`). It
agrees with direct integration of the models to about 0.001 in I(mu), 0.009 at worst (coolest M dwarfs, channels
a few nm wide), at most 0.72% of a transit depth (`test/ldspec.test.mjs`); the grey estimate it replaces was off by
0.036 in the median and 0.30 at worst on the same channels. Beyond 5.5 micron (MIRI) other model grids would be
needed, and below 300 nm real M and K dwarfs emit chromospherically, which the models do not.

**Limb darkening in a fit.** Either sample the coefficients, or "follow the star": sample Teff
(and [Fe/H] when a table is loaded) with priors at their measured uncertainties and compute the
coefficients from each sample (`makeLDTie`, tabulated once per fit on a grid that includes every model node inside the prior and
interpolated inside the likelihood: about 20 ns per call, no allocation). The coefficients then stay on the one-dimensional (or two-dimensional) family a star
can produce. With the grey model the spread reflects the Teff uncertainty only; with the table it follows Teff and [Fe/H].

## Habitable zone

Kopparapu et al. (2013, 2014) effective-flux limits; in units of the stellar radius the distance
depends only on Teff. The displayed band is 1 inside the conservative limits (runaway and maximum
greenhouse), 0.4 between those and the optimistic ones (recent Venus, early Mars), averaged over
the Teff uncertainty and an albedo range. The albedo scaling, sqrt((1-A)/0.7), is a heuristic of
this app, not part of the published limits.

## The sampler

`MiniNest` follows UltraNest's strategy: live points are whitened, the constrained prior is bounded by the
union of balls around the live points (MLFriends) intersected with a wrapping ellipsoid, and new points are
drawn uniformly from that region inside the unit cube. The run stops when the live points can hold less than a
set fraction of the evidence. Since the stress tests of November 2026 it also has:

- whitening about each cluster of live points, so separated islands (period aliases) do not inflate the region;
- an ellipsoid re-fitted in each bootstrap round, which removes an upward bias of ln Z that grew with dimension
  (+0.4 at 15 parameters with the fixed shape UltraNest also uses);
- a slice sampler with directions from the live points and exact detailed balance, entered when region sampling
  costs more than three slice points and left again when it is cheap;
- an insertion-order test after every rebuild, with a restart in slice mode when the region fails it;
- a budget: `maxCalls` (default one million, "Stop after" on the Fit tab) and `maxSeconds`. A stopped run
  returns what it has with `converged: false`. Stopped late it is a usable posterior; stopped early it has an
  effective sample size near 1 and its intervals mean nothing, which the Results tab then says instead of
  showing them as a result;
- warnings in plain words (`res.warnings`): parameters correlated above 0.95 with advice, a posterior against
  a prior edge, separate peaks with their weights, low efficiency, low effective sample size.

a/R★ is never sampled. With the inclination free the two trade off through the impact parameter (a fit with
both free needs 47,000 calls and gives σ(i) = 0.84°, against 11,600 calls and 0.076° with a/R★ fixed). It is
held at its System value, or follows from M★, R★ and P when "a/R★ from Kepler's law" is on.

Stress suite (`node test/stress.test.mjs`, about 30 s; `npm run test:stress` for all 47 problems, about 5 min),
400 live points, against truth from analysis or quadrature and against UltraNest 4.6.3 on the same likelihoods:

| Problem | Before | Now | UltraNest |
| --- | --- | --- | --- |
| HD 80606 b joint fit, period prior 111 to 112 d | 1M calls, 521 s, not converged | 183k calls, 72 s (34 s in the browser) | 190k calls |
| Three planets, 17 free parameters | 1M, not converged | 953k, converged | 1M, not converged |
| Period aliases | 343k, mode weights wrong, no warning | 58k, weights right | 1M, not converged |
| Correlated Gaussian, 15 parameters, ρ = 0.99 | ln Z +1.36 ± 0.37, no warning | −0.02 ± 0.37 | +0.40 ± 0.57 |
| Neal's funnel, 4 parameters | ln Z −1.16 ± 0.14, no warning | −0.28 ± 0.17, restarted with a warning | −0.30 ± 0.32 |

Still weak: 20 parameters at ρ = 0.999 stops at the budget (flagged); funnels are sometimes 0.5 to 0.9 low
without a warning; in slice mode the scatter of ln Z exceeds its quoted error (rms pull up to 1.9); a mode much
narrower than another can be lost. Calls rose 15 to 50% up to 10 parameters for the unbiased ellipsoid.
Reparameterisations measured but not built: √e cos ω and √e sin ω (20 to 25% fewer calls), a log-uniform
jitter prior (30% fewer). Sampling the impact parameter instead of the inclination does not save calls here.

Not included: UltraNest's reactive tree (variable live points), a metric per mode, warm start, resume from disk.

### Evidence

The evidence is a normalised marginal likelihood: the Gaussian `ln(sigma)` terms are included, the
priors are proper, and the baseline normalisation a1 is integrated out analytically over a
U(0, 2) prior rather than fixed at its best value. Its error is the spread obtained by re-drawing
every volume-shrinkage factor from Beta(n, 1) 200 times.

`test/evidence.test.mjs` compares ln Z with midpoint quadrature of likelihood x prior on transit
likelihoods with 1, 2 and 3 free parameters, six seeds each:

| free | quadrature | sampler mean | run scatter | reported error |
| --- | --- | --- | --- | --- |
| rprs | 1646.019 | 1645.960 | 0.07 | 0.11 |
| rprs, tmid | 1641.594 | 1641.640 | 0.12 | 0.14 |
| rprs, tmid, inc | 1640.001 | 1639.956 | 0.12 | 0.16 |

Other checks: correlated Gaussians in 2, 5 and 8 dimensions land within 1.5 reported sigma of the
analytic value; a 3-D Gaussian over 60 seeds with 200 live points averages +0.07 +- 0.03. A target
whose plateau covers 97% of the prior sits about 0.2 low. Over 16 simulated transits the parameter
pulls have mean within 0.3 of zero and scatter 0.8 to 1.1.

Comparing models: only on the same data with the same error bars (the Results tab enforces this),
only for converged runs, and remember ln Z depends on the prior widths you chose.

## Transit timing and ephemerides

The Timing tab keeps a list of mid-transit times (added from a fit, pasted, or read from a file), fits

```
linear      T(E) = T0 + P E
quadratic   T(E) = T0 + P E + (1/2)(dP/dE) E^2        dP/dt = (dP/dE) / P
```

by weighted least squares (`src/core/ephemeris.js`), draws the O − C diagram against the linear ephemeris with the
selected model's 1σ prediction band, compares the two models by BIC, lists the next five transits with propagated
uncertainty, and can push the fitted period and nearest mid-transit time back into the System tab. Uncertainties
come from the error bars as given; they are not rescaled by χ², and the tab says so when χ²/dof is above 2.
When the list has no epoch column, orbits are counted from the first time with the System period, and the tab
warns when a time falls more than 0.2 of a period from a whole orbit.

Checks (`test/ephemeris.test.mjs`, reference built by `test/make_ephemeris_reference.py`):

| Check | Result |
| --- | --- |
| Coefficients vs the normal equations solved in exact rational arithmetic, 4 cases, both models | within 1.8e-6 σ; the floor is T0 held as a float64 Julian date (5e-10 d) |
| Covariance, and predicted-time uncertainty 500 epochs past the data, vs the same | 5e-16 and 3e-16 relative |
| numpy.polyfit vs the exact answer (printed by the reference script) | agrees, except its covariance is off by 7.6e-6 for epochs 4000 to 4060 in the quadratic fit, so the exact solve is the reference |
| Noise-free recovery at Julian-date magnitudes | P to 5e-15 d, dP/dE to 1e-16 |
| Coverage over 4000 noise realisations | pull rms 0.985 (P), 0.984 (dP/dE); mean reduced χ² 1.004 |
| dP/dE to dP/dt on WASP-12 b (TASTE V, arXiv:2402.12120) | -30.74 ± 2.69 and -31.29 ± 1.21 ms/yr here vs -30.72 ± 2.67 and -31.27 ± 1.23 published; the published dP/dE has four digits |

Not done: a fit to a published list of mid-transit times end to end (only the unit conversion was compared with
a paper), a comparison with EXOTIC's `ephemeris.py`, and the browser tab in the Playwright drivers (checked by
hand in Chrome at desktop and phone widths, including the PNG, PDF, CSV and JSON exports). Times are taken as
given: there is no conversion between time systems, and the calendar column for upcoming transits is the listed
time read as UTC.

### Periodic signals in the timing residuals

Under the O − C plot the Timing tab runs `timingPeriodogram` (`src/core/periodogram.js`): a generalised
Lomb-Scargle periodogram of the times minus the ephemeris, a sinusoid at the strongest peak, the periodogram of
what is left, a second sinusoid, and a comparison by BIC. A sinusoid is recommended only when its peak is
significant (false-alarm probability under 1%, Baluev 2008) and it lowers the BIC, because the BIC alone
prefers a sinusoid in 58% of signal-free lists. Transit epochs are a lattice, so there is a true Nyquist limit
at two lattice steps; the search runs from there to twice the span.

Checks (`test/periodogram.test.mjs`): power against astropy to 4e-11 of the peak over 20,788 values and four
normalisations; false-alarm probabilities to 1e-14; fits at EXOTIC's periods agree in χ² to 6e-8; on
signal-free lists the false-alarm rate is 8.5% at the 10% level and 1.0% at 1%; an injected 2-minute signal in
30 of 500 epochs is recovered in 93% of trials. On EXOTIC's 40-time example it finds 57.3 d, 2.78 ± 0.16 min.
The analytic false-alarm level trusts the error bars: with that example's unequal errors it calls a second
peak significant (9e-5) where a bootstrap gives 22%. The tab has a bootstrap button; it is not the default
because it takes seconds.

EXOTIC's `plot_periodogram`, for comparison: its second periodogram is computed from data that still contain
the first sinusoid (`ls` where `ls2` was meant); its `amplitudes` attribute changes between runs on the same
data; its false-alarm line assumes a narrower frequency range than was searched; the example's 3σ clip removes
14 of 40 transits because the timing signal itself is counted as outliers.

## Several epochs in one fit

A dataset can hold several epochs of the same planet: nights from the ground, orbits of a long space light
curve, or files from different observers. They are fitted together with one planet and orbit, so the period
becomes measurable, and a separate baseline per epoch:

```
flux_i = a1_s * exp(k_s * airmass_i) * transit(t_i)        s = epoch of point i
ln L   = sum over epochs of [ -chi2_s/2 + (1/2) ln(2 pi / sum_s m^2/sigma^2) ] + normalisation
```

Each `a1_s` is integrated out analytically with its own `U(0, 2)` prior, exactly as for a single light curve, so
it is never sampled. Each epoch with an airmass column has its own coefficient, stored as `a2@1`, `a2@2`, ...
(`epochKey` in `src/core/model.js`); these are the first namespaced parameters. A single light curve still uses
`a2` and gives the same likelihood as before. The information criteria count one normalisation per epoch.

Where epochs come from (Data tab): **Add file as another epoch** / **Add pasted as epoch** (`combineEpochs`),
**Transits** and **Every n-th orbit** in the simulator, and **Split into one epoch per orbit** for a light curve
longer than one period (`splitByOrbit`, using the System period and T mid at the moment of splitting). Epochs
can be removed one by one. The light curve plot folds on the period (the Fold button), and the posterior band
is drawn in the folded frame. With several epochs the default prior on P is uniform and lets the last transit
move by a quarter of its duration relative to the first.

Checks (`test/multiepoch.test.mjs`):

| Check | Result |
| --- | --- |
| ln L of three nights (two airmass slopes, one without airmass) vs Simpson quadrature over each a1 | differs by 9.5e-8 at ln L = 2468.49; the closed form subtracts sums of order 1e8, which sets that floor |
| ln L vs the sum of three single-epoch problems | agrees to 1e-9 |
| One epoch with an epoch index vs none | identical |
| Per-epoch normalisations at the truth (1.003, 0.97, 1.02) | 1.1σ, 1.7σ, 0.0σ |
| Period from a joint fit of five nights (orbits 0, 3, 10, 40, 41; T mid and P free) vs a second route: each night's mid-time from its own likelihood, then `fitEphemeris` | 2.1500198 ± 0.0000068 vs 2.1500198 ± 0.0000069 (0.00σ apart, error ratio 0.982); truth 2.1500082, 1.7σ away |
| Combining (date references, order, mixed airmass), removing, splitting by orbit, folding, simulating | pass |

In the browser a simulated four-night set (HAT-P-32 b preset, 1036 points, eight free parameters including P and
four airmass slopes) converged in 25 s with every truth inside 1σ to 1.2σ; adding, removing and splitting epochs,
the fold toggle and undo were exercised by hand.

Limits: one exposure time and one limb darkening band for all epochs (no multi-instrument fits yet); every
epoch shares T mid and P (no per-epoch mid-times, so no transit timing variations from the joint fit; fit the
epochs one at a time and use the Timing tab for that); epochs with dated and relative times cannot be mixed;
no real multi-epoch dataset has been fitted and compared with a published result.

## Start page, examples and looking up a system

The app opens on a start page (`src/ui/intro.js`): **Plan** and **Acquire** are marked as coming soon,
**Analyze** leads to a choice of data kinds (Transit, Radial velocity, Ephemeris, or all together) and then to a
system: typed in and looked up, or one of the worked examples. `?skipintro` in the address goes straight to the
app; the title and the Start button reopen the page. Below 1180 px the title reads **ESL**.

Parameters come from a snapshot of the NASA Exoplanet Archive `ps` table (every reference of every planet),
because the archive sends no CORS headers and a page cannot query it directly. `tools/build_catalog.py` writes
the snapshot to `public/catalog/` (an index plus 133 shards of about 110 kB; 40,414 rows, 6,470 planets, dated
in the index), and `src/core/catalog.js` reads it. In development `/nea/...` proxies to the live archive
(`vite.config.js`); that route is untested.

For each planet the reference with the most complete and physically self-consistent set is preferred over the
newest (`chooseParameters`): each reference is scored on completeness for the chosen kind of analysis, then on
checks, then on recency. The checks are Kepler's third law (reported a/R★ against P, M★, R★), stellar density
from a/R★ against M★ and R★, log g against M★ and R★, the impact parameter, the transit duration, depth against
(Rp/R★)², Rp/R★ against the radii, K against the mass, and the geometry. Whatever the chosen reference lacks
is filled in this order and labelled: derived from its own numbers, taken from another reference, derived from a
mix, assumed. The page shows every value with its source and label, the checks with their numbers, and a menu
of the other references with their scores; the same table stays available on the System tab. Priors start wide
(`suggestPriors`). The light curve shown after a look-up is simulated from the catalog values as a stand-in.

The scoring weights and thresholds are judgement calls, not calibrated. `test/catalog.test.mjs` checks the
formulas against astropy constants, the selection on hand-made references with planted inconsistencies, and a
few real systems (for HD 80606 b it picks Pearson et al. 2022 and reproduces Table 7). Over the whole snapshot,
1.6% of references that give a/R★, M★, R★ and P fail Kepler's law by more than 5σ. Times are used as the
archive lists them; time systems are not converted. One of the two Colab notebooks the gap filling was modelled
on could not be read (it needs a Google sign-in).

## Several planets, radial velocities and joint fits

`buildProblem` (`src/core/model.js`) now takes, besides the light curve:

- **planets**: a list of key suffixes. The first planet uses the plain keys (`rprs`, `per`, ...), planet c uses
  `rprs@c`, `per@c`, ... The light curve is the product of the planets' transits; limb darkening is the star's.
- **kepler**: a/R★ of each planet is not a parameter but `(G (M★ + Mp) P² / 4π²)^(1/3) / R★`, so photometry,
  velocities and timing describe one orbit (EXOTIC's joint and multi-planet fitters do the same).
- **rv**: velocity datasets. `v = γ_d + Σ_p K_p [cos(ω + ν) + e cos ω] + rvlin (t − t0) + rvquad (t − t0)²`,
  with `K = (2πG/P)^(1/3) Mp sin i / ((M★ + Mp)^(2/3) √(1 − e²))` (`src/core/rv.js`). Each dataset has its own
  zero point γ_d, integrated out analytically with a `U(−10⁵, 10⁵)` m/s prior exactly like the light-curve
  normalisation, and its own jitter `jit@rv<n>` added in quadrature, with the `ln σ` term in the likelihood.
- **timing**: mid-transit and mid-eclipse times of any planet, compared with `T mid + E P` (or the superior
  conjunction `+ E P`), E the nearest whole orbit.

In the app: the System tab has a planet selector with add and remove, the mass of each planet, and the
"a/R★ from Kepler's law" switch; the Data tab reads velocity files (time, velocity, uncertainty, optional
instrument column: each instrument becomes a dataset); the Fit tab chooses which kinds of data enter the fit;
the Timing tab keeps times per planet and lists eclipse times. Results give a block per planet.

The data panel switches between the light curve and the velocities. Observations are colour-coordinated: each
light-curve epoch and each instrument has its colour in the plots, the legends and the Data tab lists (on
exported white figures the colours are the cycle EXOTIC's combined figures use). Each observation has its own
bins in its colour under the overall bins. **View** sets the opacity of the points and of the model, and turns
bins and colours on and off. **Fold** puts the planet on show at phase zero; with several planets the other
planets' model is divided out of the light curve, and subtracted (with the trend) from the velocities.

### EXOTIC's examples, reproduced

`test/exotic.test.mjs`. The references are EXOTIC 4.3.1 and pylightcurve 4.0.4 themselves, run by
`test/make_exotic_reference.py` (models, χ² on the example data, the fits EXOTIC stores with its examples) and
`test/make_exotic_fits.py` (EXOTIC's own fits of seeded single- and multiple-transit data). The example data are
in `public/examples/` and open from the start page.

| EXOTIC example | Check | Result |
| --- | --- | --- |
| models | transit model against pylightcurve's Claret-law model, five planets up to e = 0.93 | max flux difference 1.0e-7 |
| models | RV curve against EXOTIC's, after its Mp/M★ scaling | 1.1e-5 of K (1.7e-4 of K against its default forward difference) |
| models | mid-eclipse time against pylightcurve | under 1 s |
| `single_transit` | posterior against EXOTIC's `lc_fitter` on the same data | means within 0.25σ, widths within 15%; 1.8 s against 8 s |
| `multiple_transit` | five nights with airmass, nine parameters, against `glc_fitter` | means within 0.11σ, widths within 6%; 4.2 s against 57 s |
| `ephemeris` | 40 mid-times against statsmodels WLS, before and after the example's 3σ clip | T0, P and errors agree to 1e-6; 26 of 40 survive the clip |
| `multi_planet` | χ² of the three light-curve files and of the velocities at the injected truth | 45.11, 88.80, 190.58, 37.58: identical to two decimals |
| `multi_planet` | joint fit of three masses, trend and jitter against EXOTIC's stored fit | widths within 15%, best fit within 0.5σ; 0.7 s; planet d is an upper limit (95%: 3.6 m/s) |
| `radial_velocity` | HD 80606 b, seven instruments, four free parameters | K 469.6 m/s (paper 469.2), e 0.93157 (0.93183), ω −58.83° (−58.887°); zero points match EXOTIC's |
| `joint_rv_transit` | HD 80606 b: TESS + velocities + 4 transit times + 1 eclipse time | K 469.9, a/R★ 94.453, P 111.43681, i 89.242, e 0.93163 against Table 7's 469.22, 94.452, 111.436765, 89.24, 0.93183; 25 s |

Differences from EXOTIC that are deliberate:

- Mass ratio. EXOTIC scales the reflex motion by Mp/M★; the two-body value is Mp/(M★ + Mp). For the same
  velocities ESL's mass is higher by Mp/M★ (0.38% for HD 80606 b: 4.188 against 4.173 M Jup).
- Weights. ESL sums χ² over every measurement with the Gaussian normalisation. EXOTIC's `rv_fitter` averages
  reduced χ² over datasets, and its `joint_fitter` counts the light curve twice and adds the timing noise to σ
  linearly, so its error bars are not comparable with these; central values are.
- The HD 80606 velocities have χ² = 1564 for 264 points without jitter, so formal errors from this fit (as from
  EXOTIC's) are too small. Free the jitters to see honest ones.
- Stellar mass and radius are held at their values in these fits unless ticked, and the Results tab says so.

Not done: N-body (`examples/nbody`), the periodogram and decay fits of `examples/ephemeris` (the quadratic
ephemeris is on the Timing tab, see above), eclipse and phase-curve models, per-dataset limb darkening (all light curves share one
band), the real TOI-1873 data in `examples/toi-3planet` (32,000 points). The 3D view shows one planet at a time.
The browser runs of these examples (0.6 s for the toy, 1.3 s for HD 80606 velocities, 15 s for the joint fit)
were driven by hand; the Playwright scripts do not cover them.

## The planet's own light: eclipses, phase curves and maps

`src/core/phasecurve.js` adds the planet's flux to the transit model: the secondary eclipse, a phase curve
phased to mid-eclipse, and a brightness map in spherical harmonics to degree 3 whose odd terms show only in
eclipse ingress and egress (eclipse mapping, after github.com/pearsonkyle/Exoplanet-Mapping). A planet has it
when its `fpfs` is set (System tab, "+ eclipse & phase curve"); the likelihood is still `buildProblem`.
Parameters: `fpfs` (dayside surface brightness over the star's, so the eclipse depth is `fpfs × rprs²`, EXOTIC's
convention), `contrast`, `hotspot`, a second harmonic, or `y1m1 … y33` in map mode; optional ellipsoidal and
beaming terms; light-travel delay. The plot has a Phase view (the orbit folded, eclipse and transit enlarged)
and a Map view (brightness-temperature map, the hemisphere facing the observer, temperature against phase).

Checks (`test/phasecurve.test.mjs`, 40; `test/phasemodel.test.mjs`, 14): the 16 basis curves against direct
integration 4.6e-13; uniform eclipse against batman 4.9e-13 (circular), 2.5e-7 at e = 0.93; against starry
1.2.0 and jaxoplanet 0.2.0 5.6e-7 of the planet's flux; EXOTIC's phase-curve model outside transit and eclipse
5.0e-13; brightness temperature against scipy 1.6e-9; χ² through `buildProblem` identical to the model used
directly on all three example sessions. Differences from EXOTIC, on purpose: its eclipse ingress is that of a
body of radius `rprs·√fpfs` and starts late (up to 29% of the depth during ingress).

Examples (stored results open with them): WASP-43 b at 4.5 µm, one full orbit (6 free, 31,533 calls, 14 s in
the browser); WASP-43 b eclipse map of degree 1 from seven Spitzer visits (8 free, 55,708 calls, 49 s:
Fp/F★ 0.1513 ± 0.0029, day 1544 K, night 789 K); a simulated degree-2 map at JWST precision (9 free, 106,773
calls, 37 s). The Spitzer data are the already-detrended series of the Exoplanet-Mapping repository, binned;
instrument systematics are not modelled. Y1,−1 (north-south asymmetry) runs into its prior in both map fits,
and the page says so.

## Exomoons

`src/core/exomoon.js`: the union of the planet's and a moon's disc on a limb-darkened star, the pair orbiting
its barycentre, after the owner's `exomoon2.py`. Simplified parameters: `rmoon` (Rm/R★), `permoon`, `phmoon`,
optional `mmoon` and `imoon`; the separation follows from the moon's period and the planet's mass. The Moon
view of the plot isolates the moon's own dip, planet-moon eclipses and the planet's wobble; "Search for a
moon" runs a grid over period and phase with noise-only searches for the false-alarm rate.

Checks (`test/exomoon.test.mjs`, 37): two-disc kernel against scipy quadrature 6.5e-14; `exomoon2.py`
reproduced step by step to 1.3e-8; Pandora's whole light curves to 5.2e-6 (Pandora moves the barycentre on a
straight line); timing and duration variations within 2.4% and 0.5% of Kipping's amplitudes; an injected moon
found at S/N 26 while 100 noise-only searches reach 5.0. The `exomoon2.py` configuration itself is unbound
(2.4 Hill radii) and is flagged. The moon is not drawn in the 3D view. Example fit: 6 free, 50,449 calls, 95 s.

## N-body dynamics

`src/core/nbody.js`: a Wisdom-Holman integrator in Jacobi coordinates (the same map as REBOUND's WHFast) and
IAS15, with transit times by root finding, the star's radial velocity, stability checks (Hill, AMD, a short
integration), analytic TTV formulas, and a grid search over a hypothetical perturber that scores each
simulation against the mid-transit times themselves. With `spec.nbody` set, `buildProblem` takes mid-transit
times and velocities from the integration; with all masses zero it is the Keplerian model. The Timing tab's
Dynamics block has the switch, the O − C against the integration, the stability findings, and "Search for an
unseen companion" (a pool of Web Workers), which can add the companion as a planet and fit it.

Checks (`test/nbody.test.mjs`, 82; `test/nbodymodel.test.mjs`, 8): transit times against REBOUND 5.2.2 IAS15
1.3e-6 s (this IAS15) and 0.3 s (Wisdom-Holman at its defaults) on EXOTIC's example system; positions equal to
WHFast to 2e-12 AU; one planet equal to the Keplerian timing and RV models to 3e-6 s and 2e-9 m/s; χ² through
the likelihood 82.9 against 82.9 from the other integrator directly.

Example: 72 simulated mid-transit times of a hot Jupiter with a 0.1 M Jup companion near 2:1. In the browser
the search ran 14,112 simulations in 7.6 s and the fit (companion's mass, period and phase free; the
transiting planet's T0 and period profiled out as a straight line inside the likelihood) took 8,735 calls and
31 s: 0.1035 ± 0.0068 M Jup (injected 0.100). Sampling the transiting planet's own period and T0 as well did
not converge in 150,000 calls, which is why the line is profiled. Limits: light curves stay Keplerian (no
photodynamics), no light-travel time, no MEGNO, mid-eclipse times stay Keplerian, and the χ² surface has
period aliases every few thousandths of a day: the search returns one solution that fits. Found in EXOTIC and
Nbody-AI while porting: the committed `nbody.py` takes the radial velocity along a sky axis (a quarter cycle
off; the uncommitted working copy fixes it), transit times are interpolated linearly between hourly outputs
(0.5 s), and `ttv_grid.fits` needed by `estimate_prior` is not in the repository.

## Sessions, saved analyses, exports

An analysis is one JSON document (`docs/FORMAT.md`, `src/core/session.js`): system, data, priors, sampler and,
when there is one, the posterior. "Save" keeps it in the browser (IndexedDB), the Results tab writes it as a
file, and the same file runs headless (`runSession`), in the Python package and in the MCP server. Results
also export as LaTeX, JSON, a Markdown report and a Python script that rebuilds the fit with every prior as an
editable line (`src/core/exportScript.js`). Every worked example opens with a stored posterior
(`public/examples/results/`, rebuilt by `tools/build_example_results.py`). The Fit tab's "EXOTIC's bounds"
sets free parameters and uniform bounds the way `exotic.py` does (Rp/R★ in [0, 1.25 × value], i ± 5°, T mid
within a quarter orbit, airmass coefficient in [−3, 3]).

## Python package

`python/` is the same JavaScript core run from Python (embedded V8 through `mini-racer`, else a Node
subprocess, else QuickJS), bundled by `npm run build:python`; nothing is translated by hand. `esl.Session`
(pydantic) loads a browser export, runs it and saves a file the browser opens; `esl.multi_fitter` mirrors
EXOTIC's `multi_fitter` classes so its three-planet script runs with only the import changed. Five of the six
stored example results reproduce exactly from Python and the sixth to 0.004σ; 72 pytest tests pass on macOS
arm64 with Python 3.12 (not run on Linux, Windows or other Python versions; nothing is on PyPI). Speed equals
Node: about 16,000 likelihood calls per second on a 400-point transit. See `python/README.md`.

## Assistant and MCP server

The Assistant button opens a panel that talks to an OpenAI-compatible endpoint the user types in (a local
model; nothing is contacted otherwise, and no address ships as a default). It drives the page through 41
tools over `window.__esl.api`: loading data and examples, priors, fits, model comparison experiments, exports
and files. `mcp/server.mjs` exposes the same handlers on session documents to any MCP client (stdio or
local HTTP), confined to a workspace folder. Tests: `test/assistant.test.mjs` (60, no network), `mcp/test.mjs`
(23). Against the owner's local model, five tasks ran correctly in 20 of 20 final runs, but the small model's
prose still drops uncertainties and sometimes invents a conversion; `explain_results` exists so the numbers
come from the software. A public https site cannot call an http endpoint on another machine (mixed content);
it works from localhost. Not tried: other servers (LM Studio, Ollama), an MCP client other than the SDK's.

## The site

Seven pages, each a real folder with its own `index.html` (no rewrite rules needed on a static host), sharing the
navigation bar in `src/site/nav.js` and the tokens in `src/site/site.css`:

| Path | What it is | Code |
| --- | --- | --- |
| `/` | landing page | `index.html` |
| `/plan/` | which transits can be observed from a site, and how well their times are known | `src/plan/`, `src/core/observability.js` |
| `/observe/` | a view of the sky for a place and time | `src/sky/`, `src/core/astro.js`, `src/core/horizon.js` |
| `/observe/photometry/` | images to light curve: FITS frames, TESS, Kepler and K2 pixels | `src/photometry/`, `src/core/fits.js`, `photometry.js`, `gp.js`, `psd.js` |
| `/analyze/` | the transit, radial-velocity, timing, phase-curve, moon and dynamics analyzer | `src/main.js` |
| `/search/` | catalogue browser: NASA archive, exoplanet.eu, TOIs | `src/search/`, `src/core/sources/`, `src/core/relations.js` |
| `/validation/` | this code against other codes and a 30-digit reference | `src/validation/`, `tools/validation/` |

Everything runs in the visitor's browser; nothing is uploaded. Pages hand work to each other by address:
`/analyze/?planet=<name>` looks a planet up and offers its parameters, `/plan/?planet=<name>` lists its
observable transits, `/observe/?planet=…&t=…&lat=…&lon=…&elev=…&transit=<ingress>,<mid>,<egress>&err=<min>`
points the sky at a target for a transit, and the photometry page passes a light curve to the analyzer through
`localStorage` (`esl.handoff`) and `/analyze/?handoff=1`. `/analyze/?skipintro` skips the start page. The
analyzer's first visit offers a tour (the "?" button replays it) that starts with only the system view.

Page checks without the interactive browser: `.venv/bin/python tools/shot.py '<path>' out.png [w h] --wait ms
--eval "<js>"` takes a headless screenshot of the running dev server and prints console errors.

### Observe: the sky

41,411 stars to V = 8 (XHIP through the d3-celestial data, BSD 3-Clause), constellation lines, Sun, Moon and
planets, an atmosphere that brightens through twilight, a ground that turns translucent when the view tips
below the horizon, azimuthal and equatorial grids, the 4,862 exoplanet host stars of the catalogue, and bright
satellites from CelesTrak propagated with SGP4 (`satellite.js`, the site's only dependency besides three.js).
Time can be scrubbed, stepped and played; the place is typed or taken from the browser. On a phone an AR mode
follows the device orientation, with a calibration by pointing at a known object.

A host star's card lists its magnitudes (V, G, T, J, K), distance and type, and for each planet its size
class, radius, mass, period, temperature and whether it transits (depth, duration), with estimates marked. A
search box finds planets, hosts, bright stars and solar-system bodies and marks the target; with a transit in
the address the card shows ingress, mid and egress with altitude and sky state, and "Play the night" runs
sunset to sunrise in 40 s with the target's track. A Terrain layer draws the horizon from elevation tiles
(Mapzen/Tilezen on AWS Open Data, 28 to 48 tiles per place, cached): Mauna Kea from Hilo, Mount Wrightson from
Tucson and Mont Blanc from Geneva come out 0.08° to 0.14° low (200 to 300 m pixels flatten summits);
buildings and trees are not in the data. VR and passthrough buttons appear when the browser offers WebXR.

Accuracy of `src/core/astro.js` against astropy/ERFA with DE432s (`test/astro.test.mjs`, 65 instants 1975 to
2050, five sites): sidereal time 0.3″, star altitude and azimuth 25″ (annual aberration is not modelled), Sun
33″, Moon 12″, Mercury to Mars under 3′, Jupiter 8′ and Saturn 10′ (the limit of Standish's Keplerian elements),
refraction 6″ above 10°; twilight times 1.0 s, rise and set 5.4 s. The ISS from the page agreed with
python-sgp4 + astropy to 0.003°. The example planner link puts HAT-P-32 at altitude 64.086° (astropy 64.080°).

Not tested: any real WebXR session (the perspective path was checked on the normal canvas only: 21 stars
within 0.22 px; a headset has no compass, so the view starts facing the flat view's centre azimuth); AR on a
real phone, pinch zoom, the geolocation prompt. Local times on the sky page are the browser's zone, the
planner's are the site's. The star rendering was tuned by eye, not against Stellarium.

### Photometry

`src/core/fits.js` reads image and binary-table HDUs (all BITPIX, BSCALE/BZERO, gzip, tile compression RICE,
GZIP, PLIO with all dither modes, `.fz`, colour cubes and Bayer mosaics, 33 spellings of the time keywords; not
HCOMPRESS). `src/core/photometry.js` does sigma-clipped annulus backgrounds, centroids, exact circular and
elliptical apertures with partial pixels, Gaussian and Moffat PSF fits, optimal extraction (Naylor), source
detection, tracking through field rotation, meridian flips and jumps by triangle matching, and EXOTIC's search
over apertures, annuli and comparison stars, scored with the transit model through `buildProblem`.
`src/core/psd.js` and `src/photometry/diagnostics.js` give the power spectrum against the photon-noise level,
rms against bin size, and a pixel map of flux against centroid. `src/core/gp.js` and a self-flat-field
(Vanderburg & Johnson) detrend. Frames run in a Web Worker with a live view. Target pixel files (TESS, Kepler,
K2) come from the public `stpubdata` bucket; the MAST API and TESScut do not allow cross-origin requests.

Checks (`fits` 89, `photometry` 53, `gp` 9, `psd` 36, `exotic_photometry` 26): tile-compressed files
bit-identical to astropy; aperture sums 4e-16 and elliptical apertures 1e-15 against photutils; centroids
1.4e-14 px; UTC to BJD_TDB 0.05 s; GP 1e-13; periodogram and Welch PSD 1e-13 against scipy; rms-vs-bin 7e-15
against mc3.

EXOTIC's own sample data (HAT-P-32 b, 142 MicroObservatory frames), EXOTIC run through its `main()`:

| | EXOTIC 4.3.1 | This code |
| --- | --- | --- |
| Choice | aperture 4.44 px, annulus 7.15 px, no comparison star | aperture 3.71 px, annulus 10.73 px, both comparison stars summed |
| Residual scatter | 0.573% | 0.496% (0.540% with no comparison star) |
| Rp/R★ (same χ² fit of each curve) | 0.1562 ± 0.0034 | 0.1452 ± 0.0032 (0.1525 with no comparison star) |
| T mid − 2458107 | 0.71359 ± 0.00108 | 0.71311 ± 0.00106 |
| Search | about 30 s for 1,142 fits | 9.1 s for 1,532 fits, 5 s to measure the frames |

BJD within 0.014 s and airmass identical; at EXOTIC's centroids, radii and sky 720 aperture sums agree to
7.9e-7. At EXOTIC's own aperture cell this code is worse (0.599% against 0.573%) and the reason was not found.
PSF photometry loses on these undersampled stars in both codes. The 2.3σ gap in Rp/R★ is mostly the choice of
comparison star. Behaviour in EXOTIC that looks wrong (not changed there): the centroid is a flux-weighted mean
of a 31 × 31 box with the sky left in (1.5 px from its own Gaussian fit); the least-squares mode minimises the
fourth power of the residuals; the sky is the mode of a box that includes the star.

Not verified: the live view mid-run, the export buttons and the hand-off by clicking, K2 fetch in a browser
(Node only), the folder picker and drag-and-drop, a file written by `fpack`. The cut-out demo of the sample
frames lives in `test/data/` (the sample data states no licence) and works on the dev server only.

### Search and Plan

Catalogues are plug-ins (`src/core/sources/`): the NASA Exoplanet Archive (6,470 planets, one row each from
`pscomppars` with the period and epoch of the reference that predicts the smallest timing uncertainty today),
exoplanet.eu (8,479; CC BY 4.0, acknowledgement shown under the table) and the TOI list (8,175). Snapshots are
built by `tools/build_catalog_table.py` and `tools/build_catalog_eu.py`. The two planet catalogues are matched
by name, alias, host and letter, then position and period: 98.7% of archive planets find their exoplanet.eu
entry. The table marks where they disagree (2,138 planets in at least one quantity) and which values are
estimates. Estimates come from named relations in `src/core/relations.js`, each tested against its source
(`test/relations.test.mjs`): Chen & Kipping (2017) mass-radius (within 1.4% of the `forecaster` package),
Pecaut & Mamajek (2013) dwarf sequence, Torres et al. (2010), and exact geometry for depth, duration,
equilibrium temperature and K. No mass is estimated above 11.3 R⊕, where the relation is not single-valued.

`public/esl-catalog/` is the merged offline build (`tools/build_esl_catalog.py`, documented in
`tools/README.md`): 8,561 planets with provenance, gap-filling estimates with their relations, and suggested
priors for 8,556 of them; 2.0 MB gzipped, with checksums and licences in its manifest. TOIs are left out. Only
the `--no-download` path has been run.

The planner lists transits for a site and date range, one row each, with ingress, mid and egress, the
propagated uncertainty of the mid-time, altitudes, dark time before and after, and the Moon. "Observable" now
means the whole region of interest (1 h of baseline before ingress to 1 h after egress) is above 30° with the
Sun below −18°; complete transits with a short baseline are listed un-bolded with what is lost. A globe shows
89 observatories (astropy's registry and MPC codes, `tools/build_observatories.py`) with the terminator; a
crawler (`tools/crawl_observatories.py`, robots.txt obeyed, 2 s per host) found archive, weather or all-sky
links for 43 of them, and two all-sky images are embedded (Kitt Peak, La Silla), the only ones whose
organisation's terms page states a Creative Commons licence; whether those general terms cover the camera
hosts is the owner's call. Tabs give the ephemeris behind every row (with a CSV) and a grid of altitude charts.

`src/core/observability.js` against astropy (`test/observability.test.mjs`): altitude and azimuth 0.01°,
twilight times 6 s, BJD conversion 4 s. Against the Swarthmore transit finder for Kitt Peak and one week: all
32 of its events are found, mid-times within 0.7 min, elevations within 0.5°; with the finder's limits 14 are
observable over the whole region of interest, 17 are complete with a short baseline and 1 is partial.

Caveats: choosing the ephemeris by its quoted errors favours papers with optimistic errors (of 4,312 planets
with both, 3,044 use a different reference than the archive's default, which predicts 4.3 times less precisely
at the median); time systems are flagged but not converted; altitudes ignore refraction; exoplanet.eu has 27
positions more than 0.25° from the archive's; TOIs are not matched to known planets; many crawler seeds were
typed from memory and failed, so 46 observatories have no links. `astro.js` and `observability.js` overlap
(Sun, Moon, alt-az) and should be merged. Pinch on the globe and every phone layout were checked only headlessly.

### Validation

`tools/validation/*.py` run batman, PyTransit, exoplanet-core, PyAstronomy, ellc, pylightcurve, EXOTIC,
pyaneti, radvel, emcee, dynesty and UltraNest (recipe in `validation/README.md`) and store their outputs in
`public/validation/`. The page recomputes this code's side in the browser, and `test/validation.test.mjs`
asserts the same tolerances. The reference is Kepler's equation in 30-digit arithmetic plus scipy quadrature of
the flux integral. The page reads in about nine minutes: a short version, where this code is weaker, where
another code is the outlier, four comparisons with one chart each, the project's other tests (stored by
`tools/validation/project_reference.mjs` in `public/validation/project.json`, including phase curves, exomoons
and N-body), how to reproduce it, what is untested, and 35 references with DOI or arXiv links.

| Comparison | This code | Others |
| --- | --- | --- |
| Transit flux, 41 cases, worst error | 3.1e-11 | batman 1e-6 (Claret, by design; 7.6e-5 quadratic, see below), PyTransit 1e-5, pylightcurve and EXOTIC 1e-6, pyaneti 4e-6, ellc 5e-5 |
| Kepler's equation to e = 0.999 | 2.4e-15 rad | batman and pyaneti 1e-7 to 7e-6 at e = 0.93 |
| Contact durations to e = 0.93 | 1.3e-10 s | Winn (2010) closed form and PyTransit up to 54 s short |
| Radial velocity | 1.3e-14 K | radvel 4e-13, pyaneti 1e-6, EXOTIC 2e-4 as shipped |
| Posterior against dynesty | means 0.06σ, widths 5% | |
| Coverage of 68% intervals, 300 trials | 67 to 73% | expected 68 ± 2.7% |

Found in other codes (none reported upstream by this project): batman's quadratic kernel is wrong by up to
9e-3 when the planet's centre is exactly one planet radius from the star's centre; radvel's compiled Kepler
solver exits at e = 0.999; ellc's reference time is closest approach, not conjunction. Weaknesses here: the
flux kernel is good to 1e-10 over the wide grid (2.2e-12 on its own test grid); the quadratic law is 2 to 3
times slower than batman and PyTransit; the sampler's evidence for a funnel-shaped posterior was 0.28 low
(1.7σ) on the seed rerun this round. Automatic exposure averaging now leaves at most 0.7 ppm (it was 18 ppm
for a hot Jupiter at 2 and 30 minute cadence). The 30-digit orbit gives 0.08337 d for HD 80606 b's eclipse
duration, as here; the published 0.0717 d is reproduced by no method tried.

## Calculations changed after an audit (2026-11-15)

- Exposure averaging (`autoSupersample`): the number of sub-samples now scales with the transit depth as well
  as the exposure over the ingress time; residual 18 ppm → ≤ 0.7 ppm.
- An epoch with its own exposure time now gets its own sub-sampling in `specFromSession`; before, it was
  ignored unless the light curve also had an overall exposure.
- Stored posterior draws: resampled rows were coerced to numbers by `TypedArray.map`, so exported sessions and
  `runSession` held wrong draws; fixed, and the session test now checks the draws.
- The evidence test compared against a grid too coarse for its posterior (1639.835 against the true 1640.016);
  the reference grid is now restricted to the posterior box.
- `Mjup_Msun` is 9.5459426398e-4 (the IAU nominal GM ratio) in place of a constant with fewer digits.
- The plotted data no longer move with the sliders: a display normalisation is frozen until new data, a
  finished fit or "Re-centre data", so only the model and the residuals respond.
- A light curve handed over from the photometry page was overwritten by the default preset on arrival.
- `squareroot` in a session file is read as the `sqrt` law (the format document named a law that did not exist).

## Sample data

`src/data/hd80606_tess.js` is the TESS light curve of HD 80606 b from EXOTIC's
`examples/joint_rv_transit` (Pearson et al. 2022). The TESS aperture includes HD 80607, so the
fitted Rp/R* is diluted.
