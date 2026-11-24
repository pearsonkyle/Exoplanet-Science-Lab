---
outline: [2, 2]
---

# Validation notes

The detailed notes of each feature with the numbers of its checks: what was compared with what, and what is not verified. The [Methods](../METHODS) page is the citable version.

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
say how E14 was computed. The bundled TESS light curve is diluted by HD 80607 and the stored example is
fitted without a correction, so it returns a radius about 30% too small; the optional dilution `dil` (below,
"Light-curve jitter and dilution") corrects it once the two stars' flux ratio in the TESS band is set.

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

Other checks: correlated Gaussians in 2, 5 and 8 dimensions land 1.2, 0.4 and 0.8 reported sigma from the
analytic value (`test/nested.test.mjs`, one seed); a 3-D Gaussian over 60 seeds with 200 live points averages +0.07 +- 0.03. A target
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

### Rossiter–McLaughlin effect

With `vsini` (km/s) set, every planet in front of the star adds its anomaly to the velocities (`src/core/rm.js`,
switched on with "+ Rossiter–McLaughlin" in the System tab's velocity block): the shift of the flux-weighted mean
velocity of the uncovered light of a limb-darkened (Claret law, the fit's coefficients), solidly rotating star,
−∫occ I v dA / (F★ − ∫occ I dA), with v = v sin i★ (x cos λ − y sin λ) in the orbit's sky frame and λ (`lambda`,
per planet `lambda@c`) the projected obliquity in ellc's convention. The area integral is exact: the first moment
of the intensity over the occulted region is a line integral of the transit model's closed-form F(r) around it.
Checks (`test/rm.test.mjs`): 160 sky positions (three laws, Rp/R★ 0.01–0.2, inside, on the limb, ingress, egress,
four λ) against a 4000 × 4000 pixel sum (`test/make_rm_reference.py`): at most 1.0e-7 v sin i (8.9 ppm of the
anomaly), each within the pixel sum's own error; a uniform star against the exact −x_s k²/(1 − k²) to 3.5e-18; the
small-planet limit of Ohta et al. (2005) approached as k² (8.0e-4, 8.8e-5, 7.9e-6 at k = 0.03, 0.01, 0.003); whole
curves against ellc's flux-weighted velocities (`test/make_rm_ellc_reference.py`, `.venv-validation`) within 0.026 m/s
of 23–39 m/s for λ = 0°, 30°, −45°, 120°, where the opposite sign of λ misses by ≥ 5.3 m/s; a fit to 70 simulated
in-transit velocities returns v sin i = 4.97 ± 0.09 km/s (5) and λ = 30.0 ± 1.0° (30).

Options (`spec.rm`, the session's `"rm"` block, docs/FORMAT.md; all off by default): the spectrograph's own limb
darkening (`ld_law`, `ld`); `method: "ccf"`, what a Gaussian fit to the cross-correlation function measures
(Hirano et al. 2010, Boué et al. 2013, linearised to first order in the occulted fraction, with the correction for a
rotation-broadened profile that is not Gaussian; `beta` the local line's dispersion, `zeta` macroturbulence as a
Gaussian, `beta0` the measured out-of-transit width or modelled); exposure averaging of the anomaly (`exposure_min` per
velocity set or in the block, `supersample`); a catalogue v sin i as a truncated-normal prior (`vsiniPrior`); the
true obliquity from λ, i and i★ (`trueObliquity`). Checks (`test/rmccf.test.mjs`): against a brute-force disc integration
with Gaussian fits in scipy (`test/make_rm_ccf_reference.py`, 120 cases) β0 within 1.7e-4 and the CCF anomaly within
0.14%, 0.38%, 0.93%, 1.48% of its largest value at v sin i / β = 0.57, 1, 2, 4, where the first moment misses by 2.6%,
7.4%, 21%, 35%; exposure averaging within 0.051 m/s of a 4001-point average (the exposure itself moves the anomaly by
4.05 m/s). Limits: CCF form for the whole fit, not per dataset; Gaussian local lines; no differential rotation or
convective blueshift; the Keplerian part is not exposure-averaged; the planet is dark.

HD 80606 b, check fit (`test/hd80606rm.test.mjs`): the bundled velocities hold two partial transits, SOPHIE 2009
February 14 (28 of 48 points in transit) and HIRES 2009 June 5 (8 of 12), each night its own zero point and jitter; orbit
of the stored joint fit, but Rp/R★ = 0.1001 (Winn et al. 2009) because the TESS curve of that fit is diluted by
HD 80607 (its 0.0725 would inflate v sin i by about (0.1/0.0725)² = 1.9); limb darkening of 390–690 nm. Orbit fixed:
v sin i = 1.47 +0.22 −0.17 km/s, λ = 58 +16 −12°; orbit free under the joint posterior: 1.49 +0.22 −0.17 km/s, 57 +17 −12°;
CCF form with 10-minute exposures: 1.47 km/s, 57°. Hébrard et al. 2010 (λ = 42 ± 8°, v sin i ≈ 1.7 km/s, from the full
transit of 2010 January, which is not in the file): 1.1σ and 0.6σ away; Winn et al. 2009 (50 +61 −36°): 0.2σ. Agrees.
The published values were taken from the task notes, not re-read from the papers. (The earlier informal number,
2.23 km/s and 49°, used Rp/R★ from the diluted TESS fit and the TESS limb darkening.)

### Physical priors: stable orbits and period aliases

`spec.physical` (session `"physical"`, docs/FORMAT.md) adds prior constraints, each off unless named, tested before
any model is computed (`src/core/physical.js`): `crossing` (radial ranges of adjacent orbits do not overlap), `hill`
(Gladman 1993, eccentric coplanar pairs), `hill_spacing` (minimum separation in mutual Hill radii, Chambers et al.
1996 style), `amd` (Laskar & Petit 2017, coplanar), `roche` (periastron outside the star and the Roche limit
2.16 Rp (M★/Mp)^(1/3), Rappaport et al. 2013) and `megno` (a short variational integration per candidate, expensive).
A truncated prior changes Z: the sampler's Z is that of "this prior and a viable system"; runSession stores the prior
mass V that passes (20,000 prior draws) as `result.prior_volume`, with ln Z − ln V, the evidence of the renormalised
prior. Checks (`test/viability.test.mjs`, references `test/make_viability_reference.py`): Gladman against numpy on 200
eccentric pairs 2.2e-16, its circular limit 3.4640 … 3.4283 mutual Hill radii at μ = 1e-7 … 1e-3 (→ 2√3 = 3.4641);
AMD, C_c and β against numpy/brentq on 100 systems 1.9e-15; with a flat likelihood the sampler's ln Z with `crossing`
is −2.197 against the analytic ln V = −2.282 (scatter 0.15). Two planets in 30 velocities: ln Z = −161.69 (none),
−161.45 (crossing, ln V −1.44), −162.00 (hill, −2.54), −161.99 (amd, −1.82), all within errors of each other because
the data sit in the allowed region; `hill_spacing` 8, which excludes the true pair (6.4 R_H), costs 49 in ln Z.

Period aliases (`src/core/aliases.js`): `aliasScan` takes the transits seen, the coverage and a duration model and
returns the N for which P = S/N predicts no covered-but-missed transit (EXOTIC's rule in the owner's TOI-1873 analysis);
the sampler takes them as a categorical `nalias` with `palias` = S (P = palias/nalias), or one run per N
(`aliasRuns`, `combineAliasEvidence`). Checks (`test/aliases.test.mjs`, coverage from `test/make_alias_reference.py`):
TOI-1873 d allows N = 1, 2, 3, 4, 7 and the covered/missed counts of all N ≤ 25 equal EXOTIC's stored scan (its
README's "2 and 1 missed" for N = 5, 6 predates the FFI sectors: the stored scan has 3 and 2); on a simulated planet
with three transits 900 d apart the categorical run's p(N) (0.105, 0.895 for N = 2, 3) matches one run per N (0.117,
0.882 ± 0.028), and its ln Z matches theirs (3295.99 ± 0.18 against 3295.76 ± 0.16).

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
- The HD 80606 velocities have χ² = 1555 for 264 points without jitter, so formal errors from this fit (as from
  EXOTIC's) are too small. Free the jitters to see honest ones.
- Stellar mass and radius are held at their values in these fits unless ticked, and the Results tab says so.

Not done: per-dataset limb darkening (all light curves share one band), the real TOI-1873 data in
`examples/toi-3planet` (32,000 points). Eclipses, phase curves, N-body and timing periodograms have their own
sections below.
The browser runs of these examples (0.6 s for the toy, 1.3 s for HD 80606 velocities, 15 s for the joint fit)
were driven by hand; the Playwright scripts do not cover them.

## The planet's own light: eclipses, phase curves and maps

`src/core/phasecurve.js` adds the planet's flux to the transit model: the eclipse, a phase curve
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

Positive planets (`test/phasepositive.test.mjs`): the planet's flux is always required to be ≥ 0 at every phase
(nightside included; minimum from 72 phases and a golden-section search, within 5.6e-11 of the depth of 100,000
phases). `phase.positive_map` (off by default) also requires the surface brightness to be ≥ 0 on the whole sphere:
exact for degree 1 and 2 (a trust-region solve), grid + pattern search for 3; against a numpy 0.25° grid polished by
Nelder-Mead on 120 random maps (`test/make_mappos_reference.py`) 2.2e-16, 1.6e-15 and 2.4e-12, none misclassified.
`phaseSummary(…, { requirePositive: true })` gives no temperatures or hot spot for an unphysical model. In harmonic
mode `positive_map` tests the degree-1 map of the curve, which forbids contrast > 0.8: stricter than physics.
WASP-43 b's stored map (y10 0.693) is negative on 8.4% of the sphere (smallest brightness −0.203 of the mean). Refitted
with `positive_map` (`PHASEPOS_FULL=1`, about 9 minutes; the stored example results were not regenerated): degree 1
holds y10 at the edge (0.568 +0.005 −0.008), bounds Y1,−1 to −0.03 ± 0.06 (unconstrained: 0.11 +0.22 −0.24) and loses
11.6 in ln Z (ln V = −0.63); degree 2 positive (y20, y21, y22 added) keeps y10 = 0.705 ± 0.034 with y20 = 0.17 ± 0.05,
Y1,−1 = 0.00 ± 0.06, and is 1.2 below the unconstrained degree-1 fit in ln Z (ln V = −1.22).

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
(2.4 Hill radii) and is flagged. The 3D view and the 2D fallback draw the moon on its orbit at the cursor time
(`src/viz/moonview.js`; separation equal to Kepler's third law to 7.5e-14 in `test/scene.test.mjs`). Example fit:
6 free, 62,950 calls since the sampler change (50,449 before).

## N-body dynamics

`src/core/nbody.js`: a Wisdom-Holman integrator in Jacobi coordinates (the same map as REBOUND's WHFast) and
IAS15, with transit and eclipse times by root finding, the star's radial velocity, sky positions for
photodynamical light curves, stability checks (Hill, AMD, a short integration, MEGNO), analytic TTV formulas,
and a grid search over a hypothetical perturber that scores each simulation against the mid-transit times
themselves. With `spec.nbody` set, `buildProblem` takes mid-transit times, mid-eclipse times, velocities and the
light curve from one integration; with all masses zero it is the Keplerian model. The Timing tab's Dynamics
block has the switch, the O − C against the integration, the stability findings, a "Chaos check (MEGNO)" button,
and "Search for an unseen companion" (a pool of Web Workers), which can add the companion as a planet and fit it.

Photodynamics: the integration outputs every body's position and velocity at evenly spaced nodes covering the
light curve (150 per orbit of the innermost planet, only where there are data); each planet's sky position is
interpolated (cubic Hermite) and passed to the transit kernel of `transit.js`, through the same exposure
averaging as Keplerian curves. `nbody.ltt` adds the light-travel time across the system (referred to the
barycentre: transits are seen a/c early, eclipses a/c late). `nbody.elements: "mean"` reads each planet's period
and T0 as the straight line through its simulated transits over the span of the data and finds the osculating
elements by iteration, so a planet's own ephemeris can be sampled together with a companion's mass.

Checks (`test/nbody.test.mjs`, 83; `test/nbodymodel.test.mjs`, 8; `test/nbodyphoto.test.mjs`, 24): transit
times against REBOUND 5.2.2 IAS15 1.3e-6 s (this IAS15) and 0.3 s (Wisdom-Holman at its defaults) on EXOTIC's
example system; positions equal to WHFast to 2e-12 AU; one planet equal to the Keplerian timing and RV models
to 3e-6 s and 2e-9 m/s. Photodynamical light curve of a strongly perturbed pair (1 and 2 M Jup at 10 and 20.3 d,
2819 points over 125 d, where the Keplerian curve is wrong by 12,049 ppm) against REBOUND IAS15 positions pushed
through batman's quadratic kernel: 0.008 ppm with IAS15, 57 ppm with Wisdom-Holman at its defaults and 14 ppm at
60 steps per orbit; with 30-minute exposures 0.004 ppm; with light-travel time 0.02 ppm against REBOUND at
retarded times. With zero masses the photodynamical curve equals the Keplerian one to 1.0e-9 of the flux.
Mid-eclipse times: 3.8e-8 s from REBOUND for 18 eclipses. MEGNO: 2.0004, 1.9955, 1.9987 on the example system
after 2000 outer orbits (REBOUND 2.0008, 2.0020); 1.997 in the browser on the bundled example. A likelihood call
with two planets and 2000 light-curve points takes 0.65 ms over 27 d (Keplerian 0.61 ms). The Wisdom-Holman map
dropped the transit at the epoch in 18 of 200 random systems; fixed (0 of 200, 0.112 s from IAS15).

Example: 72 simulated mid-transit times of a hot Jupiter with a 0.1 M Jup companion near 2:1. In the browser
the search ran 14,112 simulations in 7.6 s and the fit (companion's mass, period and phase free; the
transiting planet's T0 and period profiled out as a straight line) took 8,804 calls: 0.1035 ± 0.0068 M Jup
(injected 0.100). Sampling the transiting planet's own period and T0 as osculating elements did not converge in
150,000 calls; as mean-ephemeris elements it does (Node, `NBODY_FIT=1 node test/nbodyphoto.test.mjs`): 5 free,
19,032 calls, 367 s, 0.1004 ± 0.0063 M Jup, at about six integrations per call; not yet run in the browser.

Limits: planets are treated one at a time in the light curve (mutual events counted twice); a planet with its
own light or a moon keeps its Keplerian curve; the straight-line profile corrects times only and is refused with
a light curve in the fit; Wisdom-Holman timing error grows with time and mass (use IAS15 for giant pairs);
mean-ephemeris elements are not found inside a mean-motion resonance; MEGNO of a chaotic orbit is not
reproducible between codes; the χ² surface has period aliases every few thousandths of a day, and the
companion search's mask uses the analytic super-period rather than the simulated O − C periodicity (the χ² grid
is unaffected). Found in EXOTIC and Nbody-AI while porting (not fixed there): the committed `nbody.py` takes the
radial velocity along a sky axis; transit times are interpolated linearly between hourly outputs (0.5 s);
`ttv_grid.fits` is not in the repository; `stability()` applies the mutual Hill radius to star-planet pairs, so a
hot Jupiter with an outer giant stops at t = 0; RVs from the simulation are off by up to 38 m/s at HD 80606 b's
periastron; `nbody_fitter` uses its priors only as cuts; `exomoon2.py` uses 4π for 4π² in Kepler's law.

## Atmosphere: transmission and emission spectra

`/analyze/atmosphere/` turns a planet, a temperature-pressure profile and a composition into a transmission and
an emission spectrum (`src/core/rtmodel.js`). The parts:

- **Structure** (`atmosphere.js`): layers uniform in log pressure, isothermal each, hydrostatic under
  g = GM/r²; profiles: isothermal, Guillot (2010) eq. 29, Madhusudhan & Seager (2009); mixing ratios constant
  with height, H2 and He filling the rest.
- **Opacity** (`opacity.js`, `continuum.js`): k-tables of H2O, CO2, CO, CH4, NH3, HCN, SO2, H2S, TiO, VO, Na and K
  from ExoMolOP (Chubb et al. 2021; line lists in `tools/opacity/README.md`), interpolated in (log P, 1/T) and
  mixed by random overlap; H2-H2 and H2-He collision-induced absorption from HITRAN (Karman et al. 2019);
  Rayleigh scattering by H2 (Dalgarno & Williams 1962) and He (Chan & Dalgarno 1965); a grey cloud deck; a
  power-law haze. H- cross-sections (Gray 2005) are implemented and checked, and unused until the model carries
  H, e- and H- abundances.
- **Clouds and hazes** (`continuum.js`, `rtmodel.js`), each a parameter of the model: a grey opaque deck
  (`cloudTop`); a power-law haze (`haze`: a cross-section per molecule in units of H2's Rayleigh value at 0.35 µm,
  and a slope); the gas's own Rayleigh scattering scaled up (`rayleighFactor`, a haze of very small particles); a
  layer of particles of one grain size between two pressures (`cloud`: optical depth at 1 µm, radius, the Q0 of
  Kitzmann & Heng 2018, a scattering share); and a covered share of the planet (`cloudFraction`, Line & Parmentier
  2016: the spectrum is that share of the cloudy column plus the rest of the clear one). Rayleigh scattering of
  H2O, CO2, CO, CH4, N2, O2 and NH3 is included from their polarisabilities.
- **Transmission** (`transmission.js`): one ray per level through spherical shells, the pressure variation inside
  each shell integrated along the ray; no refraction.
- **Emission** (`emission.js`): the formal solution through isothermal layers at 8 Gauss angles, plane-parallel,
  absorption only (scattering is left out, as in petitRADTRANS without its scattering option), over a blackbody star.
- **Colour** (`colour.js`): spectrum to CIE XYZ with the analytic colour-matching functions of Wyman, Sloan &
  Shirley (2013), then sRGB.

### Checks (`test/atmosphere.test.mjs` 33, `test/opacity.test.mjs` 21, `test/rt_reference.test.mjs` 63, `test/chemistry.test.mjs` 5, `test/escape.test.mjs` 11, `test/climate.test.mjs` 8, `test/condensation.test.mjs` 6, `test/haze.test.mjs` 8, `test/stellarspec.test.mjs` 6, `test/sed.test.mjs` 11, `test/retrieval.test.mjs` 8, `test/bundle.test.mjs` 3)

References: adaptive quadrature in scipy, petitRADTRANS 3.4.0, colour-science 0.4.7, the ExoMolOP and HITRAN
files themselves (`test/make_atmosphere_reference.py`, `test/make_rt_reference.py`, run with `.venv-rt`).

| What | Result |
| --- | --- |
| Hydrostatic radii of a Guillot profile under g = GM/r², against quadrature | 4.9e-6 of the atmosphere's thickness with 80 layers, 3.1e-7 with 320 |
| Transit radius, isothermal, constant opacity, against nested quadrature (7 cases, H/R up to 0.047) | 0.018, 0.004, 0.001, 0.0002 scale heights at 5, 10, 20, 40 layers per decade of pressure |
| The closed form of Heng & Kitzmann (2017) eq. 8 against the same quadrature | within 0.036 scale heights at H/R = 0.004 (the formula is first order in H/R) |
| Emergent flux of a grey atmosphere with a Guillot profile, against quadrature | 0.69%, 0.17%, 0.043%, 0.011% at 5, 10, 20, 40 layers per decade; 4, 8 or 16 angles make no difference at that level |
| Eclipse depth of two blackbodies; brightness temperature | 2.3e-11 against (Rp/R★)² (e^x★ - 1)/(e^xp - 1) from the SI constants; the Planck function inverts to 2e-13 K |
| H- cross-sections against petitRADTRANS's functions | 1.4e-7 (bound-free), 3e-14 (free-free) |
| Blackbody chromaticities, 2500-20000 K, against the tabulated CIE 1931 observer | 0.0021 in (x, y) at worst (a just-noticeable difference is about 0.003) |
| Limb colours of a grey star (4000, 5772, 9000 K; μ = 0.2, 0.5, 1) against quadrature with the tabulated observer | 0.0046 in a linear sRGB channel at worst |
| Collision-induced absorption table against the HITRAN files | 1.2% at worst over 18 values |
| The per-absorber opacity the page plots, against the extinction the spectrum uses | identical for one gas (4e-16); the mixed distribution's mean is within 0.49% rms of the sum of the parts |

Clouds and hazes:

| What | Result |
| --- | --- |
| Power-law haze (κ = 0.05 cm²/g at 0.35 µm, slope -2) against petitRADTRANS, same tables | transit 3.0 ppm rms, 6.6 at worst |
| Rayleigh scattering × 30 against petitRADTRANS's `haze_factor` | 3.6 ppm rms, 6.8 at worst |
| Opaque deck at 1 mbar, 120 layers / 480 layers | 22.3 ppm rms (mean +21.1) / 5.4 ppm (mean +4.7); flux 0.02% |
| Half the planet under that deck against `cloud_fraction` | 16.1 ppm rms (half the deck's difference); 0.3 cloudy + 0.7 clear reproduced to 0.6 ppm |
| Deck top swept from 1 to 3.2 mbar in 20 steps, 60 layers | each step lowers the depth by 22.4-23.3 ppm; never below the opaque disc at the deck (lowest: +1.9 ppm) |
| A particle layer whose edges fall inside layers | carries the optical depth asked for to 1e-12, split by the scattering share |
| Particle extinction, Kitzmann & Heng (2018): limits | 5x⁴/Q0 and 5x^-0.2 to 1e-7 |
| The same against Mie theory over a log-normal size distribution (σ = 0.5), silicate-like and ice-like | within 0.66-1.48 for x ≥ 1; for x < 1 the fit is 0.03-0.55 of Mie |
| Rayleigh cross-sections of H2O, CO2, CH4, N2, O2 against petitRADTRANS's | 0.71-1.17 of them; CO 1.82 (unresolved) |

The deck is where the two codes differ in kind. Rays tangent below the deck's top are blocked. petitRADTRANS (and
this model before an independent audit of it, below) gets that from layers made opaque, so the ring between the
deck's level and the next one down counts as half blocked: the depth is low by half a layer's ring, and the deck
snaps to the layer grid as its top is varied. Here a level is moved onto the deck and every ring below it counts
in full. The difference from petitRADTRANS falls from 21 to 5 ppm when both use four times the layers, which is
its discretisation closing on ours. The emission of a deck still depends a little on the grid (the first cloudy
layer radiates at its own mean temperature): about 0.5% steps in eclipse depth as the top is swept.

An independent audit of this code (a second reader given the files and no conclusions) found, and these were then
fixed: the deck quantised to layers (114 ppm steps, up to 96 ppm under the bare disc); an opacity table that
could be loaded and counted twice when a gas was ticked during a run; table errors that never reached the page;
a silent loss of collision-induced absorption on a failed download; a crash with no table loaded; H2 or He given
alone switching the fill gas off without a check on the sum; a particle radius of zero giving NaN; a writer that
accepted an encoding it could not write; a placeholder DOI ("qqq") copied from ExoMol's CO2 file; and four
comments that said what the code did not do. Found correct on reading: the hydrostatic structure, the H- and
Rayleigh coefficients, the units of collision-induced absorption, clamping outside the tables, the sort in the
species mixing, the table format on both sides, and the page's latest-wins sequencing.

A temperature profile that follows from the gas (`src/core/climate.js`):

| What | Result |
| --- | --- |
| The closure with constant opacities against petitRADTRANS's own Guillot function, 1e-6 to 100 bar | 2e-13 K |
| Mean opacities and grey-equivalent depths on a grey gas, and on two opacities 100 times apart | exact (1e-15); Rosseland harmonic, Planck arithmetic; visible depth 0.47 where the arithmetic mean says 6.3 |
| HD 209458 b, solar composition in equilibrium, H2O, CO2, CO, CH4, Na, K | settles in 6 passes; emits 1.005 of what it must; level factor c = 1.04; at 1 bar γ = 0.31 and an equivalent thermal opacity of 2.0e-3 cm²/g |
| The same against the opacities Guillot (2010) calibrated on detailed models of that planet | γ 0.4 and 1e-2 cm²/g there: ours within a factor 1.3 and a factor 5 |
| Its temperatures | 1262 K at 0.1 mbar, 1345 K at 10 mbar, 1636 K at 1 bar, 1907 K at 50 bar; no step back below 0.1 bar |
| A fixed Guillot profile with those calibrated numbers typed in, same planet | emits 1.08 of what it must |
| 30 × the metals; a 3500 K star with the same irradiation | thermal depth at 1 bar 2.5 → 6.2, 10 mbar 1345 → 1504 K; γ at 10 mbar 0.17 → 0.34 |
| An inversion: WASP-121 b's day side (Teq 2358 K, f = 1/2) with gas-phase TiO and VO | settles in 9 passes, emits 0.998; coolest 2729 K at 22 mbar, rising to 2984 K at 1.8 mbar (255 K); γ = 1.91 at 1 mbar |
| The same without the lines of TiO and VO | 10 passes, 1.000; a rise of 91 K, γ = 0.17 |
| A grey deck at 1 mbar, the deck over half the planet, a particle layer | each settles; the solver's balance equals `forwardModel`'s on the returned profile to 0.002 |

How the energy budget is met changed on 2026-11-20. The first version multiplied the thermal optical depth by a
number s. That has no hold on an atmosphere with an inversion, whose hot upper layers do the emitting: on the
ultra-hot case s wandered between 0.84 and 1.22 while the emitted flux stayed 8% too high, and the profile never
settled. Now T⁴ of the grey solution is multiplied by one factor c, found so that the emitted flux equals the
required one. Emission rises with c whatever the profile's shape, so inverted and ordinary profiles settle alike
(c = 0.96 for WASP-121 b's day side, 1.03 for HD 209458 b). For WASP-121 b a retrieval of its eclipse spectrum
gives about 2500 K rising to 2800 K between 30 and 5 mbar (Mikal-Evans et al. 2019); ours rises from 2729 to
2984 K between 22 and 1.8 mbar: the same sense and size, from another kind of analysis, not a layer-by-layer
comparison. Whether such inversions are real on a given planet is debated; the model produces one when the gas it
is given absorbs starlight better than it holds heat, and removes it when TiO and VO rain out (below).

What was tried and dropped on the way. Mean opacities in the grey solution: a Rosseland mean of these tables is set
by the floor of the windows between bands (the source line wings are cut) and gave an isothermal atmosphere emitting
half its budget; a Planck mean for the heat and a stellar mean for the light are set by saturated line cores and
gave γ of several hundred and 6000 K at 50 bar. Not compared: a radiative-convective profile from another code
(PICASO, HELIOS, petitCODE). The comparison with Guillot's numbers is of order, and our thermal depth at 1 bar is
5 times smaller than his. The emitted flux is integrated over the tables' 0.3 to 50 µm only.

The second audit (2026-11-20, again a reader given the files and no conclusions) found no error of units or physics
and nine defects, fixed: the self-consistent profile ignored the grey deck and the cloud cover (a deck at 1 mbar
left the profile unchanged while the forward model then emitted 0.61 of the budget and the page said 99%); the
balance it reported belonged to the profile before the last update; the night side and the limb were photoionized
like the day side (the night side now has none); the cross-section cache was keyed on the first and last pressure
only, so a deck moving a level under an isothermal profile reused stale values (0.4 to 0.7 ppm); ionization
asked for without the star's distance did nothing and said nothing (now an error); a temperature that is not a
number returned a cross-section of 1e-4 m² (now refused); with patchy cloud the contribution map was mixed without
weighting by flux; unticking "each gas alone" did not stop the curves arriving; the layer slider re-ran the whole
model. Left as they are and stated: H- is not recomputed after photoionization changes H and e-; temperatures
outside the tables (100 to 3400 K, 300 to 4000 K for the chemistry) are held at the edge.

Condensation with rain-out (`src/core/condensation.js`, `test/condensation.test.mjs`):

| What | Result |
| --- | --- |
| Vapour pressure of water at the triple point, the boiling point, and ice at 200 K (Murphy & Koop 2005) | 0.00%, -0.02%, +0.07% |
| Ammonia at its triple point (NIST) | +0.6% |
| Methane at the boiling point, the triple point (NIST), and the solid at 77 and 70 K (Armstrong et al. 1955) | -0.2%, +1.3%, +1.0%, -0.3% |
| Condensation temperatures at 1e-4 bar against Lodders (2003, table 7): corundum, perovskite, iron, forsterite, enstatite | +0.7%, +0.7%, +0.1%, +0.2%, -0.8% |
| A cold trap whose answer is known (100 K minimum under warmer air) | the gas above equals the smallest saturation ratio below, to 1e-12; without rain-out it returns |
| Jupiter (166.1 K at 1 bar, dry adiabat 0.306), solar N/H and O/H | ammonia ice from 0.58 bar and water from 5.1 bar; Atreya & Wong (2005): 0.72 and 5.7 bar |
| The same at three times solar | 0.68 and 6.4 bar; theirs 0.84 bar and "5 to 8 bar" |
| In the model, profile from the gases: 2358 K day side, 1450 K, 900 K | TiO stays (inversion +231 K); TiO × 5e-4, no inversion; Na × 0.18 above an Na2S cloud from 0.46 bar |

The coefficients (Morley et al. 2012; Visscher, Lodders & Fegley 2010; Wakeford et al. 2017; Ackerman & Marley
2001; Buck; the NIST Antoine fit and Fray & Schmitt 2009 for methane) were each read again in the source before
use; Fray & Schmitt's only as quoted by Marboeuf et al. (2014). Ackerman & Marley print their ammonia expression
with the unit dyne cm⁻²; it evaluates to bar. The Jupiter cloud bases are 10 to 20% above Atreya & Wong's
(lower pressure): their profile follows a moist adiabat and their ammonia is also taken up by NH4SH; neither is
modelled. Not done: the chemistry is not solved again without the condensed elements (silicates would take about a
fifth of the water's oxygen), nothing lifts condensed material back up, and no particle size or cloud thickness
follows from it: the model says where a cloud begins, the particle layer placed there is still set by hand.

Hazes of a real material, nitrogen atmospheres, Titan and Jupiter (`src/core/mie.js`, `optical.js`, `worlds.js`,
`test/haze.test.mjs`):

| What | Result |
| --- | --- |
| Mie efficiencies against scipy's spherical Bessel functions, 30 cases, x = 0.05 to 30, m from 1.33 to 2 + 1i | Qext, Qsca within 3.9e-8; g within 1.8e-8 |
| Limits: Rayleigh at x = 0.01; Qext at x = 2000; no absorption without k | exact; 2.012; 0 |
| Tholin optical constants against Khare et al. (1984) as tabulated in NASA's Optical Constants Database, 8 wavelengths | n within 0.1%, k within 17% (their stated accuracy: 3% and 30%) |
| A particle layer of tholin: optical depth at the reference wavelength, albedo split, spread with height | exact (1e-12); 9.1% above 1 mbar for τ ∝ P^0.5, as the formula gives |
| N2-N2, N2-CH4, N2-H2 collision-induced absorption: 14 bin means read straight from the HITRAN files | within 1.6e-4 |
| Titan: altitude of 115 mbar and of 0.3 mbar (Huygens: 44 km and 250 km) | 46.2 km and 250 km |
| Titan: surface gravity; methane at the surface and above the cold trap | 1.354 m/s²; 5.65% and 2.55% (measured: 1.48 ± 0.09%, Niemann et al. 2010) |
| Titan in transit at 0.88 µm (Robinson et al. 2014: about 300 km); haze slope 0.88 to 2 µm (theirs −1.9 ± 0.2, −2.2 ± 0.2) | 302 km; −2.16 |
| Titan's colour and brightness (visual geometric albedo 0.22) | sRGB 1.00 : 0.67 : 0.40; estimated albedo 0.31 at 0.5 to 0.6 µm |
| Jupiter at three times solar: cloud bases; brightness temperature at 5 µm, 7.8 µm, 45 µm | 0.56 and 6.0 bar; 237 K, 138 K, 137 K |

What these do and do not show. The haze on Titan has three numbers (grain radius 0.2 µm, optical depth 6 at 1 µm,
spread τ ∝ P^0.55) and they were tuned to the first two occultation numbers in the table; the hydrostatic
altitudes, the methane cold trap, the colour and the albedo were not tuned. The methane left above the cold trap is
1.7 times the measured value: nitrogen dissolves in the condensate and lowers its vapour pressure, which the
pure-methane curve does not know ("Saturation allowed" on the page, about 0.6, reproduces it). Titan's real haze is made
of fractal aggregates of 0.05 µm monomers (Tomasko et al. 2008); spheres of 0.05 µm give a slope near −3.8, so the
0.2 µm is an effective size. The albedo is a two-stream estimate, 40% above the measured visual value. The profile
between Huygens's published points was read off, not taken from the data file. Jupiter's 45 µm brightness (137 K)
is above its effective temperature (124 K) and the albedo contrast in the 0.89 µm methane band is weaker than the
real one (0.50 to 0.30 against about 0.5 to 0.1). The opacity tables stop at 100 K (methane) and the nitrogen
collision-induced absorption at 70 K and 400 K; outside, the edge value is used. Not compared: a Cassini image, a
VIMS or CIRS spectrum, or any radiative-transfer code on Titan.

Stellar spectra (`src/core/stellarspec.js`, `tools/stellar/build_spectra.py`, `test/stellarspec.test.mjs`):

| What | Result |
| --- | --- |
| The Sun from the grid (5772 K, log g 4.44) at 1 au: total irradiance | 1346 W/m² (measured 1361) |
| Its mean over 0.5 to 0.6 µm and over 1.5 to 1.7 µm | 1.808 and 0.245 W/m²/nm (ASTM E490: about 1.84 and 0.245) |
| Flux of each of the 519 models, with its infrared tail, over σT⁴ | 0.964 to 1.047 |
| A model left out and interpolated from its neighbours 100 K either side, 0.4 to 2.5 µm | within 4.1% in every bin (worst at 4000 K) |
| Synthetic photometry of a flat band | the photon-weighted mean, exactly |
| Eclipse depth over a 5400 K model star against the same over a blackbody | 0.80 at 1.6 µm, 1.12 at 4.5 µm, 1.34 at 30 µm |

The fluxes are the PHOENIX-ACES specific intensities of the limb darkening table (Husser et al. 2013, 5 nm sampling,
78 angles) integrated over the disc. The two ASTM values are quoted from memory of the standard's table, not read
from it for this test. Beyond 5.5 µm a blackbody of the star's temperature is joined on, scaled to the model in the
3.6 to 4.2 µm window and lowered as (λ / 4 µm)^−0.08 (see SED fitting below). The atmosphere page now divides the planet's flux by this model star
unless "blackbody" is chosen, which changes eclipse depths by the factors in the last row; transit depths are not
affected. The fit built on this grid is the next part.

SED fitting (`src/core/sed.js`, `extinction.js`, `passbands.js`; the Star page; `test/sed.test.mjs` 7 checks):

| What | Result |
| --- | --- |
| Fitzpatrick (1999) extinction against the dust_extinction package, 40 wavelengths, R_V 2.5, 3.1, 4.5 | within 1.07% below 2.5 µm; 0.004 in A/A_V everywhere |
| 31 passbands (thinned to 90 points): pivot wavelengths against the SVO service's own | within 0.05% |
| A synthetic 5350 K star, θ = 0.25 mas, 11 magnitudes scattered by 0.02 mag | Teff 5349 +68 −66 K; θ 0.2515 ± 0.0022 mas; R 1.352 ± 0.012 (1.344 put in) |
| The Sun through the passbands: V, B−V, V−Ks, J−Ks | −26.747 (−26.76); 0.707 (0.653); 1.523 (1.49); 0.380 (0.37) |
| The shipped grid and thinned passbands against magnitudes computed in Python from the raw PHOENIX files and full passband curves, 4 models × 9 bands | within 0.6 mmag |
| The Sun in Gaia's bands: BP−RP, G | 0.818 (0.82); −26.891 (−26.90) |
| HD 209458 against interferometry (Boyajian et al. 2015: 0.2254 ± 0.0072 mas, 6092 ± 103 K) | 0.2245 ± 0.0022 mas (−0.4%); 6087 ± 31 K (−5 K) |
| GJ 436 (von Braun et al. 2012: 0.417 ± 0.013 mas, 3416 ± 54 K) | 0.4095 ± 0.0133 mas (−1.8%); 3422 ± 41 K (+6 K) |
| HD 97658 (Ellis et al. 2021: 0.314 ± 0.004 mas, 5212 ± 43 K) | 0.3202 ± 0.0044 mas (+2.0%); 5174 ± 32 K (−38 K) |
| HD 189733 (Boyajian et al. 2015: 0.3848 ± 0.0055 mas, 4875 ± 43 K) | 0.3588 ± 0.0032 mas (−6.7%); 5027 ± 19 K (+152 K) |
| The two Boyajian stars against AstroARIADNE's published fits (Vines & Jenkins 2022, table 5) | HD 209458: 6087 K against 5994 K, 0.2245 against 0.2328 mas; HD 189733: 5027 against 5049 K, 0.3588 against 0.3593 mas |
| WASP-39 (Mancini et al. 2018: 0.939 ± 0.022 R☉, 5485 ± 50 K) and GJ 1214 (Cloutier et al. 2021: 0.215 ± 0.008 R☉, 3250 ± 100 K) | 0.919 ± 0.010 R☉, 5507 ± 95 K; 0.222 ± 0.005 R☉, 2998 ± 20 K |
| Spectrum matching: a synthetic R ≈ 90 spectrum of a 5230 K star, flux-calibrated; and with a slope, matched with a quadratic factor | 5227 ± 2 K, θ 0.3004 mas (0.3); 5200 ± 30 K |

Are the differences from interferometry our approximations? They were looked for and three things were found
(2026-11-20, second pass). (1) Not the data handling: binning the models to 420 points and thinning the passbands to
90 changes no magnitude by more than 0.6 mmag against a calculation from the raw 5 nm files with the full curves, and
the model Sun has the right Gaia colour. Broad bands average over hundreds of nanometres; the 5 nm sampling is not a
limit for them. (2) The extinction prior was: the first runs let A_V range from 0 to 0.1 mag for stars 20 to 50 pc
away, inside the Local Bubble, and the prior's mean of 0.05 mag made every star 45 to 70 K hotter. With A_V fixed at
zero for the stars within 50 pc, HD 209458, GJ 436 and HD 97658 land within 40 K and 2% of interferometry. (3) HD 189733
does not move: its magnitudes fix a colour temperature of 5027 ± 19 K, its bolometric flux then needs 0.359 mas, and
AstroARIADNE's published fit agrees with ours to 22 K and 0.1%. This is a disagreement between SED fits and that
interferometric measurement, not something our approximations produce. GJ 1214's published 3250 K is itself from
an SED fit with other models; ours is 250 K cooler, the grid being poor in the optical for the coolest stars
(scatter 0.09 mag): that one is a limit of the models. AstroARIADNE itself was still not run.

What was adjusted on the way, and why. The first fits left WISE W3 and W4 0.1 to 0.2 mag fainter than the model in
every star: the blackbody tail joined on beyond 5.5 µm was too bright. It now falls as (λ / 4 µm)^−0.08, the size of
the fall of the Sun's brightness temperature between 4 and 20 µm (5600, 5000 and 4800 K at 4, 10 and 20 µm are
quoted from memory, not from a table read for this). After it W3 and W4 fit to 0.02 to 0.09 mag in FGK stars and
the fitted scatter falls from 0.06 to 0.08 mag to 0.01 to 0.04; M dwarfs keep +0.18 mag at W3. WISE W1 and W2 of
the four bright stars are saturated and are listed in the examples but not fitted; GALEX NUV likewise. The model
Sun is 0.05 mag too red in Johnson B−V (not in Gaia's or Tycho's colours, which the fits use).

Spectrum matching (`src/core/specmatch.js`) fits the grid, times a smooth polynomial factor, to a low-resolution
spectrum. It was tested on spectra made from the grid itself, so the test shows the method works and nothing about
how well the models match a real star: no observed spectrum was matched. It is not a substitute for SpecMatch-type
codes on echelle spectra: the models are sampled every 5 nm and a finer spectrum is binned down to that.

One set of stars. The limb darkening table, the atmosphere model's star (eclipse depths, the colour figure), the SED
fit and the spectrum match all use the same PHOENIX-ACES files through one module, with one solar radius
(`test/stellarspec.test.mjs`). Not yet on it: the 3D view's star colour and the ionizing ultraviolet (blackbodies),
and a star fitted on the Star page is not passed to the light-curve and radial-velocity fits, which still take the
star's parameters from the catalogue or by hand. The orbit model is not involved in any of this page's calculations.

Limits. One model grid (PHOENIX-ACES at 5 nm), main-sequence gravities, 2300 to 8000 K, [Fe/H] ±0.5: no giants, no
hot stars, no metal-poor stars. M dwarfs fit with 0.09 to 0.10 mag of scatter and GJ 1214 comes out 240 K cooler than
the published value. Magnitudes do not constrain log g or [Fe/H]; without priors their posteriors are the grid's
range. Extinction is one R_V = 3.1 curve bounded by a number the user gives; no dust map is consulted. Magnitudes are
typed or pasted: the page does not query catalogues (the CDS services were down when this was written and their
cross-origin access could not be checked). No fit to a spectrum, and no isochrone step for mass and age.

Which method each fit uses, and why (surveyed 2026-11-20). The rule: where the answer is a physical quantity whose
uncertainty matters, the posterior comes from the nested sampler (`src/core/nested.js`) with explicit priors, and
alternatives are compared by ln Z. A faster method is used only where speed matters more than the error bar, or
where the problem is linear and the exact answer is cheaper than sampling.

| Fit | Method | Why |
| --- | --- | --- |
| Transits, eclipses, radial velocities, timing, phase curves, moons, N-body (`buildProblem`, `runFit`) | nested sampling | the site's main results; evidence for model comparison |
| White-light and per-channel spectroscopic light curves (`fitWhiteLight`, `fitChannel`) | nested sampling through `buildProblem`; a channel with only its depth free is integrated exactly on a grid | same likelihood; the one-dimensional case is exact and deterministic |
| Star from magnitudes (`fitSed`), from a spectrum (`matchSpectrum`) | nested sampling | physical parameters with uncertainties; fits compared by ln Z |
| Atmosphere from spectra (`runRetrieval`) | nested sampling, priors of `priors.js` | as above; with and without a gas or a cloud compared by ln Z |
| Linear and quadratic ephemerides (`fitEphemeris`) | weighted linear least squares, models compared by BIC | linear in its parameters: the least-squares answer and covariance are the exact Gaussian posterior |
| Baselines and regressors inside a light-curve fit | solved analytically at every sample | linear nuisance parameters, marginalised exactly |
| Limb-darkening laws from model intensities (`fitLaw`) | linear least squares | fitting a formula to a computed curve: no noise, no posterior |
| Self-consistent temperature profile (`consistentProfile`) | fixed-point iteration | solving equations, not fitting data |
| Star profiles for photometry (`fitPsf`, `lmFit`) and focus | Levenberg-Marquardt | thousands of stars per frame, in real time; only the centroid and width are used, their errors come from the scatter between frames |
| Plate solution and frame alignment (`fitWcs`, `fitSimilarity`) | least squares on matched stars | linear; checked by the residual of the matches |
| Quick-look transit on a live light curve (`quickFit`) | grid in mid-time and duration, linear least squares for the rest, BIC to accept a dip | a preview while observing; the published numbers come from the nested-sampling fit afterwards |
| Periodograms (timing, Lomb-Scargle) | least squares per trial period | a search, followed by a sampled fit of what it finds |

Not yet inside the one likelihood: the SED fit, the spectrum match and the retrieval each build their own (same
sampler, same prior definitions, same result format), beside `buildProblem` rather than in it. A star's fitted
radius is therefore not yet a prior in the transit fit, nor a retrieval fitted jointly with the light curves.

Ariel's noise in the simulator (`TELESCOPES.Ariel` in `src/core/missionbands.js`; `hourlyNoise`, `depthNoise`,
`simulateSpectroscopy` in `src/core/spectroscopy.js`; `test/retrieval.test.mjs`). ArielRad is not public and PandExo
needs STScI's reference data, so neither was run; the numbers ArielRad's paper publishes were used instead (Mugnai
et al. 2020, Exp. Astron. 50, 303): collecting area 0.63 m², photon conversion efficiency per channel (in-band means
of its fig. 2: 0.29, 0.29, 0.40, 0.42, 0.29, 0.30 for VISPhot, FGS1, FGS2, NIRSpec, AIRS-Ch0, AIRS-Ch1), a 40% margin
on the photon variance, 40 ppm √hr of gain noise, a 20 ppm floor, an observation of 2.5 transit durations; Tier 2
resolving powers 10, 50, 15 from the Definition Study Report. The star is its PHOENIX model, not a blackbody.

| HD 209458, relative noise in one hour (ppm), Tier 3 bins | Photon: ours / ArielRad | Total: ours / ArielRad |
| --- | --- | --- |
| VISPhot, FGS1, FGS2 | 12.9 / 13.4, 9.5 / 9.9, 7.7 / 7.9 | 43 / 43.1, 42 / 43.2, 41 / 41.3 |
| NIRSpec 1.51 µm (R = 20) | 20.6 / 19.1 | 47 / 46.1 |
| AIRS-Ch0 3.01 µm (R = 100) | 93.3 / 87.4 | 117 / 112 |
| AIRS-Ch1 4.99 µm (R = 30) | 80.5 / 77.4 | 103 / 102 |
| AIRS-Ch1 7.64 µm (R = 30), the red edge | 118 / 133 | 146 / 206 |

Photon noise within 8% and totals within 5% over 0.5 to 5 µm; GJ 1214's totals within 12%. Not modelled: detector
read noise, dark current and pointing jitter, and the fall of the efficiency toward each band's edges, so the red
edge of AIRS-Ch1 is 29% too quiet and faint stars will be optimistic. ArielRad's values were read from the paper's
vector figure by a helper, not from a table. For JWST nothing was changed: PandExo's paper gives no per-transit
numbers to test against (its benchmarks are figures); the measured WASP-39 b precisions (NIRSpec G395H: 221 ppm per
10-pixel bin at 1.46 times photon noise; PRISM: median 99 ppm over 207 channels) are recorded on the roadmap as the
test to build.

Atmospheric retrieval (`src/core/retrieval.js`, `test/retrieval.test.mjs`):

| What | Result |
| --- | --- |
| Isothermal atmosphere with H2O and CO2, one Ariel transit of HD 209458 b (54 channels, 36 to 96 ppm) | T 1257 +39 −37 K (1300), log H2O −3.27 +0.20 −0.18 (−3.3), log CO2 −6.34 +0.34 −0.36 (−6), radius 1.3808 ± 0.0017 (1.38) |
| The same data fitted without water | Δ ln Z = 404: water detected |
| Cost | 7413 models at 3.5 ms each (tables cut to Ariel's range and joined to R = 50, 30 layers, WebAssembly kernel) |

The end-to-end example (`tools/examples/ariel_retrieval.mjs`, results stored beside it and checked by the test)
simulates one transit, three eclipses and the night side from three orbits of a hot Jupiter around HD 209458, once
clear and once with a haze and a cloud deck, and retrieves temperature, [M/H], C/O, radius, aerosols and the
night-side contrast. Run again on 2026-11-23, after model bins came to be weighted by their overlap with each data
bin ("Reached from" below; 54 channels; 36 to 96 ppm on a depth from one observation; two fits sharing the machine):

| Fit | Result |
| --- | --- |
| Clear planet, the transit alone, clear model (44,272 models, 5 min) | limb Teq 1166 +74 −100 K (1200), [M/H] 0.55 +0.30 −0.29 (0.3; 0.8σ, the furthest), C/O 0.55 ± 0.16 (0.55), radius 1.379 ± 0.002 (1.38) |
| The same data with haze and cloud free (80,948 models) | Δ ln Z = −4.7 ± 0.5: no aerosols called for |
| Hazy planet, the transit alone, haze and cloud free (92,795 models, 10 min) | haze strength 10^3.06 (+0.42 −0.30; 10^3 put in), [M/H] 0.27 +0.37 −0.35, C/O 0.54 ± 0.16, limb Teq 1227 ± 120 K; cloud top 10^−1.2 bar (+1.7 −0.9) |
| The same data fitted as clear (75,056 models) | χ² 330 for 54 points, C/O 0.95, [M/H] −0.9: wrong; Δ ln Z = 153.8 ± 0.6 for the aerosols |
| Clear planet, transit + three eclipses + night side (96,045 models at 23 ms, 38 min) | night side cooler by 486 +13 −15 K (500), day-side Teq 1372 +34 −41 K (1450; 2.1σ), [M/H] 0.26 ± 0.15, C/O 0.49 +0.07 −0.08, log κ_IR −1.90 +0.21 −0.20 (−2.5; 2.9σ, the furthest), log γ −0.46 +0.05 −0.06 (−0.4), radius 1.380 ± 0.001; χ² 156 for 162 points |
| Hazy planet, the same (227,380 models at 22 ms, 85 min) | night side cooler by 501 +32 −24 K, Teq 1463 +74 −65 K, [M/H] 0.15 +0.16 −0.21 (0.8σ, the furthest), C/O 0.49 ± 0.09, haze 10^2.98 (+0.19 −0.15), cloud top 10^−1.29 bar (+1.3 −0.24; 10^−1.5), log γ −0.46 +0.12 −0.55, radius 1.381 ± 0.002; χ² 132 for 162 points |

All six fits reached the sampler's own stopping rule (1% of the evidence left) with a budget of
400,000 models a fit; an earlier run with 60,000 had stopped four of them short, the joint fits without usable
posteriors. This is the third converged run of the same noise draw: 2026-11-20 with the chemistry table
interpolated linearly, 2026-11-22 with it smooth, and this one with the new binning. The clear planet's numbers
moved by a fifth of their errors or less between the last two. The hazy planet's joint fit is less steady: its cloud
top came out 10^−1.35 bar (+1.1 −0.24), then 10^−0.44 (+1.2 −0.9), now 10^−1.29 (+1.3 −0.24), and with it the
night-side contrast's error went from 17 K to 28 K and Teq's from 40 K to 70 K. The deck's pressure has a posterior
with two parts, and which one holds the median changes with small changes of the data: it is not a robust result,
and the errors of what trades with it are known only to a factor of 1.7.

Reading these. From one transit Ariel's noise gives C/O to about 0.15, [M/H] to 0.3 to 0.4 dex and a haze to a
third of a dex, and tells a hazy atmosphere from a clear one decisively; fitting a hazy planet as clear returns
confident, wrong chemistry. The transit's temperature is the limb's, 250 K under the day side's in this planet,
which is what the one-column fit returns (1166 K; the simulated limb is 1200 K). Adding three eclipses and the
night side gives the day-side temperature (to 35 to 70 K), the night-side contrast to 14 to 28 K, halves the error
on [M/H] and C/O, and on the hazy planet halves the error on the haze. The cloud deck's pressure stays poorly
known either way (±1.3 dex from the transit, ±0.8 to 1.1 from all three). In the clear planet the infrared opacity of the profile came out 2.5 to 2.9σ high (over the three runs of this draw) and
Teq 1.8 to 2.1σ low together (the two trade against each other in the Guillot profile). To tell chance from bias the joint
fit was repeated on twelve other draws of the noise (2026-11-21; `tools/examples/ariel_retrieval_clear_seeds.json`,
all converged, 89,000 to 126,000 models each). Chance: over the twelve, the mean of (median − truth)/σ times √12 is
−0.8 for log κ_IR, 0.6 for Teq, −2.0 for log γ, −1.7 for [M/H], −1.4 for C/O, 0.1 for the radius and 0.2 for the
night-side contrast (±1 expected without bias; log γ's −2.0 is the largest of seven).

| Parameter | Scatter of (median − truth)/σ (1 expected, ±0.2) | 16 to 84% range holds the truth (8.2 of 12 expected) |
| --- | --- | --- |
| Teq, log κ_IR, log γ | 0.95, 1.09, 0.84 | 8, 7, 9 |
| radius, night-side contrast | 1.24, 0.75 | 7, 11 |
| **[M/H]** | **1.44** | **5** |
| **C/O** | **1.54** | **5** |

In these twelve the error bars on [M/H] and C/O look about a third too small, which forty draws (below) show to
be chance; the tests made on the way are kept here ([M/H] and C/O move together along one ridge, so this
is one effect, not two; taken alone C/O's scatter has a chance of about 0.5% under correct errors, a few per cent
after allowing for seven parameters looked at). It is not the number of live points: the first eight data sets
fitted again with 400 (335,000 to 454,000 models, 3.2 to 4.1 hours each) give medians within 0.2σ, error bars
within 5% and ln Z within its error of the 100-point runs (`test/retrieval.test.mjs`). Nor is it how new points are drawn: the default
runs take 85% of their points from the region and the rest by slice sampling with 14 steps (insertion-order test
p = 0.18); the same eight data sets with slice sampling alone at 56 steps a point (403,000 to 529,000 models, 3.3
to 4.3 hours) give medians within 0.15σ, error bars within 6% and ln Z within 1.4 of its error. Three sampler
set-ups agree, so the posterior is what the likelihood gives.

What was found in looking for the cause, and ruled out (2026-11-22). The chemistry table was interpolated
linearly between its nodes ([M/H] 0, 0.5; C/O 0.5, 0.6, 0.7, 0.8), so the model's sensitivity to [M/H] and C/O was
constant inside a cell and jumped at each node: in units of the joint data's errors, 41 per dex in [M/H] below 0.5
and 37 above; per unit C/O 79 between 0.5 and 0.6, 90 to 0.7, 120 to 0.8, 233 above. [M/H] and C/O are now
interpolated by a monotone cubic (`src/core/chemistry.js`; "Chemical equilibrium" below for its check), which
removes the steps (second difference of the spectra across a node 0.04 to 0.07σ, from 0.24 to 0.63σ). The twelve
draws were then repeated, data and fit both with the cubic (89,600 to 123,500 models, all converged):

| Parameter | Scatter, cubic (linear) | Range holds the truth, cubic (linear) |
| --- | --- | --- |
| Teq, log κ_IR, log γ | 0.90, 1.03, 0.83 (0.95, 1.09, 0.84) | 8, 8, 8 (8, 7, 9) |
| radius, night-side contrast | 1.13, 0.73 (1.24, 0.75) | 7, 11 (7, 11) |
| **[M/H]** | **1.42** (1.44) | **5** (5) |
| **C/O** | **1.47** (1.54) | **6** (5) |

Nothing moved: medians shift by a few hundredths. The kinks were real and the interpolation is better for being
smooth, but they are not the cause.

It was chance. Twenty-eight further draws (seeds 33 to 60, 2026-11-22, all converged, 85,000 to 118,000 models)
with the twelve make forty:

| Parameter | Scatter of (median − truth)/σ (1 expected) | Range holds the truth (27.2 ± 3.0 of 40 expected) | Mean of (median − truth)/σ (0 ± 0.16) |
| --- | --- | --- | --- |
| Teq | 0.80 ± 0.09 | 27 | +0.31 |
| log κ_IR | 0.85 ± 0.10 | 28 | −0.33 |
| log γ | 0.72 ± 0.08 | 28 | −0.49 |
| [M/H] | 1.05 ± 0.12 | 27 | −0.39 |
| C/O | 1.13 ± 0.13 | 27 | −0.41 |
| radius | 1.09 ± 0.12 | 24 | −0.05 |
| night-side contrast | 0.98 ± 0.11 | 29 | +0.16 |

The error bars on [M/H] and C/O are the right size; in the 28 new draws alone their scatter is 0.88 and 0.99 and
their ranges hold the truth 22 and 21 times. The first twelve were an unlucky dozen (and the 400-point, slice and
cubic repeats reused the same twelve, so they could not show it).

What forty draws show that twelve could not: the medians of the five parameters that trade against each other
(Teq, κ_IR, γ, [M/H], C/O) sit 0.3 to 0.5 of an error to one side of the truth, log γ by 3.1 times the error of
that mean, [M/H] and C/O by 2.5. Coverage is unaffected (the ranges are wide enough to hold it). It matters only where many fits are
averaged: the offset does not shrink with the number of fits.

Where the offsets come from (2026-11-23). Two tests: the best-fit points of the same forty fits, and one fit of the
same data with no noise added (`noise=0`; 92,426 models, best χ² 0.23; a median is known to about ±0.05σ).

| Parameter | Median, forty draws | Best-fit point, forty draws (±0.16) | Skewness of the posterior | Median, no noise |
| --- | --- | --- | --- | --- |
| Teq | +0.31 | +0.11 | −0.03 | +0.09 |
| log κ_IR | −0.33 | −0.16 | 0.00 | −0.04 |
| log γ | −0.49 | −0.29 | −0.10 | −0.23 |
| [M/H] | −0.39 | −0.41 | 0.00 | +0.01 |
| C/O | −0.41 | −0.42 | −0.02 | −0.10 |
| radius | −0.05 | +0.03 | −0.02 | −0.08 |
| night-side contrast | +0.16 | +0.08 | +0.01 | +0.09 |

(Offsets in units of each fit's error; skewness is (hi + lo − 2 median)/(hi − lo).) Without noise the fit returns
what was put in: it has no offset of its own beyond log γ's −0.23σ, which is the median of a skewed posterior and
about half of log γ's offset. For Teq and log κ_IR the best-fit point is nearer the truth than the median, as a
shape effect would have it. For [M/H] and C/O it is not that: their posteriors are symmetric, the noise-free
medians are on the truth, and the best-fit points are as far off as the medians. Their −0.4σ over forty draws is
either chance (2.5 times the error of the mean; one effect, the two move together) or a bias of second order in
the noise (the estimate of a non-linear model is not unbiased). Not told apart: that needs a hundred or more
further draws. Either way it is under half of one fit's error and the 68% ranges hold the truth as often as they
should. Also slightly narrow in scatter: log γ (0.72) and Teq (0.80), whose quoted errors are then a little generous.
Reached from (2026-11-23). One call, `retrieveAtmosphere` in `src/core/atmoapi.js`, checks the data, fills in wide
uniform priors where none are given (and returns them), cuts the tables to the data's range and runs the sampler.
The MCP server's `atmosphere_retrieve`, Python's `esl.retrieve_atmosphere` and the Atmosphere page's worker (the
assistant's `atmosphere_fit_spectrum`) all use it.

| Check | Result |
| --- | --- |
| The call against the direct run on the 54 Ariel points (`test/retrieval.test.mjs`) | medians within 0.05σ (the call does not join opacity bins for these data, the direct run joins 4), each within 2.5σ of what was put in; with 400 models it reports that it has not converged; six kinds of bad request refused |
| MCP: a model spectrum written by `atmosphere_spectrum`, 60 ppm noise added, fitted from the file (`mcp/test.mjs`) | T 1304 +42 −35 K (1300), log H2O −3.08 +0.45 −0.34 (−3.30), radius 1.3774 +0.0047 −0.0067 (1.38); 5908 models in 32 s |
| Python: the same kind of spectrum through `esl.retrieve_atmosphere` (`python/tests/test_atmosphere.py`) | each of three parameters within 3σ; an unconverged run says so |
| What the speed-ups cost, same model against 60 layers and the tables as shipped, R = 30 bins, hot Jupiter in equilibrium | 30 layers: 8 ppm rms; bins joined by 2: 4 ppm (9 with 30 layers); by 4: 20 ppm; by 7 (model bins as wide as the data's): 57 ppm |
| A spectrum file without bin edges | the bins are taken to meet halfway between neighbouring wavelengths, exact on a regular grid; a gap is not bridged |

Two faults were found by fitting, in the page, a spectrum made by the page's own full model (60 points at 50 ppm;
the answer came back 3σ off), and are mended:

1. A file with wavelengths and no bin edges was compared with the model at each wavelength, not with its average over
   the band. Bands are now worked out from the spacing.
2. The model was put on the data's bins by counting whole model bins whose centres fall inside, which is wrong by up
   to half a model bin at each edge: 23 ppm rms with bins joined by 2, 31 by 4, 102 by 7. Model bins are now weighted
   by their overlap with the data bin (`binner` in `src/core/retrieval.js`): 4, 20, 57 ppm. The default joins only as
   far as leaves three model bins in one data bin.

The stored runs made before this (the forty noise draws, the 400-point and slice-sampling repeats) used the first
binning for data and fit alike, so they are self-consistent and what they show about the sampler and the error bars
stands. The 400-point and slice-sampling repeats were not rerun (3 to 4 hours each). The two end-to-end examples
were (below), and so were the forty noise draws (2026-11-23, the same seeds, data and fit both binned the new way,
40 fits of 84,076 to 130,845 models, all converged; `runsOverlap` in `tools/examples/ariel_retrieval_clear_seeds.json`):

| Parameter | Scatter of (median − truth)/σ | 16 to 84% range holds the truth (27.2 ± 3.0 of 40) | Mean offset (σ, ±0.16) | Against the old binning: rms shift, largest shift (σ), ratio of error bars |
| --- | --- | --- | --- | --- |
| Teq | 0.81 ± 0.09 | 27 | 0.29 | 0.10, 0.17, 1.01 |
| log κ_IR | 0.89 ± 0.10 | 28 | −0.31 | 0.09, 0.17, 1.00 |
| log γ | 0.72 ± 0.08 | 28 | −0.50 | 0.09, 0.17, 1.02 |
| [M/H] | 1.03 ± 0.12 | 27 | −0.40 | 0.08, 0.16, 0.99 |
| C/O | 1.11 ± 0.13 | 27 | −0.40 | 0.07, 0.15, 1.00 |
| Radius | 1.09 ± 0.12 | 26 | −0.06 | 0.09, 0.23, 1.01 |
| Night-side contrast | 0.97 ± 0.11 | 29 | 0.16 | 0.08, 0.18, 1.00 |

The error bars are the right size with the new binning as with the old, and no fit moved by more than a quarter of
its error (worst run: C/O at 3.1σ from the truth, as before). The offsets of the medians are the same too, which is
no second measurement of them: the noise seeds are the same forty, so the two sets share their chance. The shifts
are not the binning's error alone, since the simulated spectra changed with the fit. After the two changes the same fit in the
page returned Teq 1090 +7 −6 K (1100), [M/H] 0.35 ± 0.09 (0.48), C/O 0.48 ± 0.04 (0.5) and radius 1.2806 ± 0.0007
(1.279; 2.4σ, the furthest), χ² 44 for 60 points, in 17,186 models and 6 minutes (30 layers, bins joined by 2,
against data from 80 layers and no joining). The page's tool was first run by hand in a browser (also isothermal, three
parameters: 8 s, T 1282 +13 −15 K for 1300).

The Retrieval page (2026-11-23, `analyze/retrieval/`). The page adds no science: it calls `retrievalSetup` and
`runRetrieval` in a worker of its own (`src/retrieval/retrieval.worker.js`), which the Atmosphere page's fit now uses
too, so a fit no longer blocks a page and Stop ends it by ending the worker. Two pieces of `src/core/retrieval.js`
are new and checked in `test/retrieval.test.mjs`:

| Check | Result |
| --- | --- |
| A simulated spectrum (`simulateSpectrum`) against the model's bins weighted by overlap, worked out again in the test | equal to 3e-18 on 64 bins at R = 40; (value − truth)/error has mean 0.11 and scatter 0.90 (0 ± 0.13 and 1 ± 0.09 expected); the same seed repeats, another differs; an upside-down range, zero noise and R = 1 are refused |
| The posterior's band on the spectrum (`posteriorBand`, 60 draws) against the percentiles of 400 other draws taken in the test | mean half-width 0.97 of theirs (tolerance ±0.25), median within 0.15 of a half-width; the band is 0.22 of the data's errors wide (four parameters from 54 points: about 0.27 expected) |

The page and the assistant's tools in a headless browser (`test/retrieval_check.py`, not part of `npm test`: it needs
the dev server and runs real fits, about five minutes):

| Check | Result |
| --- | --- |
| The page's first example fitted with the Fit button: 48 simulated points, 1 to 5 µm, 60 ppm; T, H2O, CO2 and radius free with the default limits | converged in 15,607 models (two minutes with eight other jobs on the machine), χ² 34.6 for 48 points; medians +1.5, +0.4, +0.7 and −0.6σ from what was put in (tolerance 3σ); table, corner plot and band drawn |
| Stop pressed during a fit | the fit ends within a second, nothing is kept, and the next fit starts normally |
| The same spectrum without CO2 in the model | Δ ln Z = −49.1 ± 0.5 (χ² 139 against 35): the table of fits says "strongly disfavoured" |
| A three-column file in ppm; a file that is not a spectrum | read, with the note that its bins are taken to meet halfway; refused in words |
| Samples and result saved | the weights sum to 1.00000 over 1718 rows; the JSON holds the limits, the data and the best fit |
| Scripted dialogue, Retrieval page: `retrieval_load_spectrum`, `retrieval_set` (CO2 off, two limits), `retrieval_run`, an answer | four requests; the model is sent T 1450 +45 −41, log H2O −3.35 +0.47 −0.32, radius 1.3782 +0.0056 −0.0081, ln Z 342.72, χ² 139.2 (the same no-CO2 fit as above, with narrower limits); the page shows the file, the three free parameters and the corner plot |
| Scripted dialogue, Atmosphere page: `atmosphere_set` (Guillot), `atmosphere_fit_spectrum` on 45 points at 60 ppm made from the page's own model | converged in 2822 models: Teq 1165.7 +6.4 −6.8 K (1166), radius 1.2793 ± 0.0003 (1.279; 1.1σ), χ² 54.6 for 45 points; the page's model is then the fit |

In the dialogues the language model is played by the test (a fixed sequence of tool calls answered at the LM Studio
preset's address), so they check the chat, the harness, the tools, what is sent back and what the page shows, and
not whether a real model chooses these tools: that was not run. The first dialogue run found a fault: the Atmosphere
tool's reply carried the whole model summary and the harness cut it in mid-JSON; the reply is now short. Not checked:
the eclipse and night-side kinds through the page (the core handles them, `test/retrieval.test.mjs`; the page's
controls for them were not driven), a fit of a published spectrum, and phones beyond one look at 375 px (nothing
overflows the page; the parameter table scrolls sideways in its card).

The cost is the limit: 38 and 85 minutes on one core, so models in parallel are the next step.
What it is not: the spectra are the model's own, binned
and given Gaussian noise of ArielRad's size. Data and fit both use opacity bins joined by 4 (see "Reached from"
above for what that costs against the full tables: about 20 ppm rms, a third of Ariel's errors, which a
retrieval of real data would feel and this one does not). No light curves were simulated and reduced in it, no systematics or
stellar activity were added, and the model that fits is the model that made the data (the same opacities, the same
assumptions): it shows that the pipeline recovers what it is given and how tight Ariel's noise makes the answer, not
that a real planet would be recovered. The night side is taken as measured with the precision of an eclipse per
orbit, an assumption standing in for a phase-curve fit.

The Star page's lookup (`src/core/starcat.js`). Magnitudes and the parallax come from Gaia DR3, 2MASS, AllWISE and
Tycho-2 through VizieR; the CfA mirror answered requests from a web page on 2026-11-20 and is asked first (the CDS
service was down). A planet host's position, log g and [Fe/H] come from the site's own catalogue; other names are
resolved by the server, which failed for some names while CDS was down. Gaia is asked first and the other
catalogues at the position the star had at their epochs: for GJ 1214 (0.95 arcsec a year) 2MASS is asked 15.6
arcsec from Gaia's position and the right star is found. Saturated WISE bands, 2MASS bands not of quality A and
upper limits are listed and switched off. The test uses stored answers; the live lookup was run once in a headless
browser (GJ 1214: 10 magnitudes found and fitted). One mirror failed to return AllWISE for WASP-39 on one try: the
page then says which catalogue did not answer. NASA's Exoplanet Archive does not allow requests from a web page and
is not used.

The Atmosphere page while it computes, and its colour figures (2026-11-20). While a model is running the figures
and status lines are dimmed and a "Calculating" tag is shown, because what is on the page then belongs to the
previous model. The colour figure has two axes: the eye's three responses on the left; on the right the planet's
reflected light, its thermal glow and their sum on one scale (reflected = estimated albedo × the star's flux at
the planet, (R★/a)² of its surface flux; thermal = the day side's emission; both per unit area and wavelength), and
the star's spectrum on its own scale. A second figure shows, across the same wavelengths, the extinction of every
constituent at the level where the atmosphere turns opaque to visible light from above (vertical optical depth 1 at
0.55 µm), with which of them leads at how many wavelengths and what share scatters. For the default planet: Rayleigh
scattering leads over 43% of the visible, sodium over 41%, potassium over 17%; at a typical wavelength 5.5% of the
extinction scatters, so the planet is dark, and what it does reflect is blue, shortward of 0.5 µm. That edge at
0.5 µm is where the sodium table's blue wing ends: far-wing profiles of the sodium D lines broadened by hydrogen do
fall steeply beyond a satellite feature in the blue, but the sharpness of the step in the shipped table was not
checked against the source profile, and the planet's colour hangs on it. Checked by headless screenshots.

The assistant on the Atmosphere and Star pages (2026-11-20). Both pages now declare tools to the site's assistant
by the contract the Photometry and Spectroscopy pages use (`window.__esl.<page>`, `src/assistant/pages.js`), and
`navigate` knows them. Atmosphere: `atmosphere_get`, `atmosphere_set` (profile, chemistry, gases, clouds, planet and
star), `atmosphere_load_world`, `atmosphere_lookup_planet`, `atmosphere_spectrum`. Star: `star_get`, `star_lookup`,
`star_set`, `star_export`. Each goes through the page's own state and functions, waits for the calculation, and
returns numbers with their errors, never whole spectra or samples. Checked by calling the tools in a headless
browser: on the Atmosphere page a cloud deck at 1 mbar with ten times the metals was set (the spectrum's range fell
from 2056 to 1502 ppm), Titan was loaded and its spectrum tabulated, and a negative temperature was refused; on the
Star page a band was left out and refitted (6087 to 6093 K), the fits were listed for comparison and the LaTeX was
written. Not checked: a conversation with a real language model using these tools (a scripted dialogue for the Atmosphere
page's fit and for the Retrieval page is in `test/retrieval_check.py`, see "Retrieval"; the Star page has none), and
the Plan, Observe and Search pages' existing tools were not revisited. The MCP server has `atmosphere_spectrum`,
`atmosphere_retrieve`, `star_fit` and `star_match_spectrum`.

Speed, profiled (2026-11-20). SED fit: 30 to 55 thousand models in 2 to 4 s (0.08 ms each: an interpolation of
eight spectra and 420 extinction factors); nothing to gain worth the complexity. Retrieval model: 4.8 ms
(isothermal, two gases) to about 20 ms (chemistry, four gases, three columns for day, night and limb); of that the
mixing kernel is already WebAssembly and the cross-section interpolation is the largest remaining part. A retrieval
of 7 to 9 parameters takes 10 to 40 thousand models. Not done: models in parallel workers.

The download (`src/atmosphere/bundle.js`, `test/bundle.test.mjs`): the zip's files hold the spectrum (1023 bins, with
each gas alone), the profile (every layer and gas), the opacity by absorber at one level per decade of pressure and
every wavelength (8 levels for Titan, not its 80 layers; the value in the file equals the model's to 1e-4), both maps
and the colour data; `figures.py` in the zip redrew all five figures from those files alone. In the browser the
download was run once headlessly (11 files, 2.3 MB); the figures it makes were not compared pixel by pixel with the
page's. The hover highlight was checked by a headless pointer and one screenshot, not on a touch screen.

Line strength in the source tables, and a repair (2026-11-20, after the owner asked for the sodium "line math" to be
checked). A line's cross-section integrated over frequency is (πe²/m_e c)·f whatever its width. Integrating each
ExoMolOP k-table over all its bins, at 1e-5, 1e-3, 0.1, 10 and 100 bar relative to 10 bar:

| Gas | 1e-5 bar | 1e-3 bar | 0.1 bar | 100 bar |
| --- | --- | --- | --- | --- |
| CO2, CH4, SO2, TiO, VO, HCN, NH3 (1000 K) | 0.98 to 1.02 | 0.99 to 1.02 | 1.00 to 1.01 | 0.86 to 0.93 |
| CO (1000 K) | 0.94 | 0.93 | 0.99 | 0.93 |
| H2O (1000 K; at 500 K) | 0.78; 0.59 | 1.00; 1.20 | 0.94; 1.00 | 0.96; 0.94 |
| H2S (1000 K) | 0.85 | 0.95 | 0.95 | 0.95 |
| **Na (1000 K)** | **1.7e5** | **1.7e3** | **17** | 1.1 |
| **K (1000 K)** | **1.0e5** | **1.0e3** | **10** | 1.1 |

The molecules conserve their strength to a few per cent (water loses up to 40% at the lowest pressure and
temperature; every gas loses 5 to 20% at 100 bar, where wings leave the tabulated range or are cut). Sodium and
potassium do not: against (πe²/m_e c)·f with the NIST oscillator strengths of the D lines (0.320 + 0.641 for Na,
0.333 + 0.670 for K) the tables are right at 10 bar (1.05) and too strong as 1/pressure below it. The far wings
scale with pressure as they should; the excess sits in the bins holding the line centres, with a top k-value
15,000 times the Doppler-core peak at 1e-5 bar, as if a core narrower than the calculation's grid step had been
given the width of the step. `repair_resonance` in `tools/opacity/build_opacity.py` now replaces, wherever the
doublet's strength exceeds 1.3 times the rule, the bins within 200 cm⁻¹ of it by the k-distribution of two Voigt
profiles: Doppler width from the temperature, strength from the oscillator strengths, and a Lorentz width chosen
so that the profile meets the table's own wings at the edge of the replaced region. After it the strength is 1.00
at every node, the wings join to 0.3% (Na) and 20% (K), and the fitted width is 0.33 cm⁻¹ per bar at 1000 K
(for comparison only: of the size of published Na-H2 broadening).

What it changed. Transit depths in the bins of the D lines by up to 106 ppm (Na) and 137 ppm (K) for the default
planet; the shipped tables against the repaired full-resolution ones are now within 2 ppm rms, 14 ppm at most.
The heating of the thin upper layers by those two lines, which made the hot, atomic-hydrogen top described below,
is gone without any hold: 1022 K at 1e-8 bar where the unrepaired tables gave 1884 K. The comparison with
petitRADTRANS is untouched: it uses the unrepaired tables in both codes, so it never could see this.
Not checked: the second resonance doublets (330 nm, 404 nm; below the repair's threshold), lines from excited
states, and whether Allard's far-wing shape itself survived ExoMolOP's processing (the step at 0.5 µm in sodium's
blue wing is in the source). The cause is inferred from the numbers, not from ExoMolOP's code, and has not been
reported to its authors: that is the owner's to do. `--no-repair` builds the tables as shipped.

The hot, hydrogen-rich top of the first self-consistent profiles was an artefact, found when the owner asked where
the atomic hydrogen came from (2026-11-20). With the model's top at 1e-8 bar the closure gave 1884 K there over
1010 K at 1e-5 bar, and the chemistry, read at 1884 K and 1e-8 bar, made 89% of the hydrogen atomic. The cause:
in the thinnest layers the ratio of starlight absorbed to heat lost (γ = 14) is set by the cores of the sodium and
potassium lines, which were counted as heating. With those two gases' lines left out the top is 978 K. In gas that
thin an excited atom re-emits its photon long before a collision can take the energy (at 1e-8 bar by a factor of
millions), so the lines scatter and heat nothing; and the opacity tables end at 1e-5 bar. The profile is now held
at its 1e-5 bar value above that pressure (`tp.pIso`; `null` removes the hold): 1008 K at the top, atomic
hydrogen 2e-5 (`test/climate.test.mjs`). (Written before the tables were repaired: the paragraph above gives the
root cause. The scattering argument holds for a real atmosphere, but what produced 1884 K here was the tables'
excess line strength; with it removed the unheld top is 1022 K.) An estimate of the
thermalisation probability of each line was tried first; it needed a quenching cross-section known to me only to a
factor of a few and changed nothing below 1e-6 bar, so the hold was preferred. What this leaves out is real: hot
Jupiters do have hot, atomic upper atmospheres, heated by the star's extreme ultraviolet and feeding the escaping
wind, and the model has none. Its temperatures above 1e-5 bar are a placeholder, and transit depths in the cores of
the strongest lines, which form up there, inherit that.

The sodium and potassium lines in emission. With the hot top they appeared in emission (brightness temperature
+349 K in the sodium bin); with the hold they are in absorption (−68 K). Either way they make no visible eclipse
depth, and not because of the bin width: at 0.59 µm a 1100 K planet is some 1e-10 of its star per unit area, and the
eclipse depth there is 1.5e-4 ppm (0.1 ppm with the hot top), against 870 ppm at 4.5 µm.

The 3D view and the page's defaults (2026-11-20). In the planet view the star now hides the planet when it lies in
front of it, so an "Eclipse" viewpoint (from beyond the star, the full day side beside the star's limb) shows the
planet going behind as the view is turned; the "Against the star" view no longer rotates, since it is a view along
the line of sight and its planet disc stayed in front from every side. The "two day sides" came from a night side
that glowed like the day side: the page now starts with a night side 300 K cooler. It also starts in chemical
equilibrium with nine gases ticked, condensation on and the profile from the gases ("Radiative balance"); the first
model takes several seconds and each later one about 1.1 s. The cutaway has a legend (the colour scale with its
ends, what the rings are, which half is day); the level where half the starlight passes the limb is a red ring. The
swatches under the view are the star, the planet (reflected light and its own glow together) and, with the
cutaway, that ring. The spectrum plot's curves can be picked out by pointer or tap like the other two plots'. Checked by headless screenshots; the eclipse view was not looked at
on a real GPU.

Speed (`tools/opacity/speed_study.mjs`; six gases, transmission only, Node 22 on this machine):

| Tables and layers | Bins | ms per model | Against the shipped tables at R = 100 |
| --- | --- | --- | --- |
| As shipped (0.3 to 50 µm, R = 200), 60 layers, JavaScript | 1023 | 274 | |
| The same with the WebAssembly kernel | 1023 | 189 | identical (1e-14) |
| Cut to 0.6 to 5.3 µm | 437 | 81 | identical |
| Bins joined in pairs (R = 100) | 218 | 41 | 2.1 ppm rms, 20.5 ppm at most |
| 40 layers | 218 | 26 | 3.5 ppm rms, 24.2 ppm at most |
| The same, temperatures unchanged and only abundances moved | | 18 | |

Three quarters of a run is the mixing of the gases' k-distributions (a sort of 144 sums per pair of gases, bin and
layer). That loop was compiled to WebAssembly from Rust (`tools/wasm/mix.rs`, 28 kB): 2.6 times faster than the
JavaScript loop on its own, with the same extinction to 1e-14; a straight port gave 1.4 times, the rest came from
sorting the bit patterns as integers and a series for ln k (7e-10 from `Math.log`), which the JavaScript loop now
uses too. SIMD made no difference. The GPU was not tried: the cost is a sort per bin, which a fragment shader does
badly, and transmission and emission, which it would do well, are a fifth of the time. With a cache the mixed
result is also kept, so a change of cloud, star or radius costs 48 ms where it cost 240. For a retrieval the
remaining factor is running several models at once in workers, which is not built.

Chemical equilibrium (`src/core/chemistry.js`; the table is made by `tools/chem/build_chem.py` with FastChem 4.0.4):

| What | Result |
| --- | --- |
| The table against FastChem at 165 points off its nodes (400-3400 K, 1e-7 to 30 bar, [M/H] -0.9 to 2.4, C/O 0.15 to 1.4), 18 species, mixing ratios above 1e-10 | 0.061 dex rms, 1.38 at worst (SO2); away from C/O 0.9-1.1 and up to 100 × solar 0.018 dex rms, 0.16 at worst; mean molecular weight within 1.1% (with straight lines in [M/H] and C/O, before 2026-11-22: 0.071, 1.49; 0.028, 0.29; 3.3%) |
| [M/H] and C/O interpolated by a monotone cubic (Fritsch & Butland 1984) against straight lines, FastChem at off-node points away from C/O 0.9 to 1.1 (1595 values) | 0.018 dex rms against 0.028; equal at the nodes; leaves the range of two neighbouring nodes by 7e-3 dex at most; jump of d log H2O / d(C/O) at the nodes 0.5 to 0.8 at most 0.001 where the lines gave 0.06 to 3.7. Temperature and pressure are still linear |
| FastChem against our own solution of the H-He-C-N-O gas (15 species, mass action and element conservation, Newton iteration; sharing only the equilibrium constants), 92 points | CO, CO2, H2, H, He identical to 4 decimals; H2O 0.009 dex rms, CH4 0.010, HCN 0.023 (0.10 at worst, C/O > 1 above 2200 K) |
| The same with FastChem's full set of elements | 0.079 dex rms for C/O up to 0.7, orders of magnitude at C/O = 0.95-1: oxygen held by Si, Mg and other metals shifts the balance, so the table uses the full set |
| The 1/T coefficient of ln K against dissociation energies | H2 4.473 eV (4.478), CO 11.116 (11.09), N2 9.756 (9.76), OH 4.391 (4.39) |

The first version of the grid (8 metallicities, 10 values of C/O) was off by up to 3.5 dex near C/O = 1 and above
100 × solar; nodes were added there. No second thermochemical database was compared, and the table is gas phase
only: TiO, VO, Na and K are overstated where they would condense.

Escape and ionization (`src/core/escape.js`, `src/core/ionization.js`). These are estimates; the checks are of the
arithmetic, not of the physics against a planet:

| What | Result |
| --- | --- |
| Energy-limited rate, Roche factor and absorption radius against Table 2 of the owner's mass-fractionation notes (GJ 1214 b, HD 97658 b) | within 0.32% (1.47e9 and 1.98e9 g/s) |
| Crossover mass against the formula by hand; limits of the fractionation factor | to 1e-12 |
| Diffusion coefficient scaled from the measured H-O value, against the measured H-He and H-D | 0.57 and 0.92 of them: C, N, S, Na carry about a factor of two |
| Time integral with a constant flux | rate × time to 1e-9; the Rayleigh enrichment to 1e-6; 200 log-time steps within 3e-5 of 2000 |
| The Sun's XUV flux today from 29.7 t^-1.23 | 4.58 erg cm⁻² s⁻¹ at 1 AU (Ribas et al. 2005 measure 4.64) |
| Sodium cross-section, electron-impact and recombination fits against a second evaluation of the published formulas | 3.2e-3 at worst over 12 values |
| The same fits for hydrogen against textbook values | 6.33e-18 cm² at threshold (6.30e-18), 4.19e-13 cm³ s⁻¹ at 10⁴ K (4.18e-13) |
| Sodium balance in a 1300 K atmosphere | the rate equation closes to 6e-11 in every layer; half ionized at 1.8e-4 bar (the notes' figure for XO-2 b reads about 1e-4 bar, with a solar spectrum) |

| Recombination to the ground state from the cross-section by detailed balance, on hydrogen | 1.59e-13 cm³ s⁻¹ at 10⁴ K (textbook 1.58e-13) |
| Potassium (Verner & Yakovlev 1995 4s shell; coefficients read from Verner's `phfit2.f`, whose H and Na entries equal the ones already in the code) | 9.1e-21 cm² at 285 nm; half ionized at 5.6e-4 bar where sodium is at 1.8e-4. Its recombination rate is sodium's and its electron-impact rate sodium's fit at 4.34 eV: estimates, not checked |
| Hydrogen and sodium ionized together | electrons equal the ions of both to 2e-16; hydrogen half ionized at 8e-9 bar, sodium at 1.8e-4 bar |
| Ionization in the model's plots (Na at 2e-6) | sodium's extinction falls to 0.2% at 3.7e-7 bar and is unchanged at 21 mbar; the D-line bin drops from 22368 to 22340 ppm at R = 200 |
| The sodium D lines | the depth Na adds peaks in the bin at 0.588 µm (2003 ppm, with the line cores recomputed) with wings on both sides (1098 at 0.58, 1054 at 0.60, 313 at 0.52, 167 at 0.80); table bin mean 5.8e-13 cm² there against 3.6e-20 at 0.58 µm |
| A night side 500 K cooler | limb layers at the mean of day and night to 1e-9 K; day and night fluxes those of the two profiles run alone; with no contrast identical to the one-column model (2e-9 ppm) |

A report that sodium showed only a slope, not a peak, was the plot and not the data: the spectrum's default range
began at 0.6 µm and showed the red wing alone. It now begins at 0.3 µm. The escape estimates are no longer on the
page (the spectra hardly respond to them); the code and its checks remain.

The crossover masses in those notes (24.5 and 30.8 amu) are not reproduced: their diffusion coefficient took
masses in grams where its table wanted amu, and was doubled. With the measured H-He coefficient the same rates give
14.1 and 16.6 amu.

Against petitRADTRANS 3.4.0, gases, 16 cases: each of the twelve gases alone and four mixtures, on a low-gravity
planet (1100 K, one scale height about 400 ppm of depth), a hot Jupiter (1600 K) and an ultra-hot Jupiter
(2300 K, for Na, K, TiO, VO; from 0.35 µm). Rayleigh scattering on, collision-induced absorption off, 120 layers.
"Same tables": ExoMolOP's R = 1000, 16 g-point k-tables in both codes, 2996 or 3535 bins. "Shipped": the tables
in `public/opacity/` with 60 layers, both spectra binned to R = 100.

| Case | Same tables, same interpolation: transit rms / max (ppm), flux rms | Same tables, our interpolation | Shipped tables |
| --- | --- | --- | --- |
| H2O + CO2 + CO + CH4, low gravity | 3.7 / 6.8, 0.32% | 5.8 / 56 | 10.4 / 57, 0.46% |
| H2O + CO2 + CO + CH4, hot Jupiter | 1.2 / 2.0, 0.20% | 2.6 / 21 | 3.6 / 16, 0.31% |
| Eight molecules, low gravity | 3.4 / 13.8, 0.36% | 5.4 / 50 | 13.5 / 50, 0.51% |
| H2O, CO, Na, K, TiO, VO, ultra-hot | 1.2 / 1.8, 0.41% | 3.2 / 41 | 7.2 / 29, 0.89% |
| H2O alone | 4.4 / 8.7, 0.31% | 5.1 / 54 | 8.7 / 51, 0.44% |
| CO2 alone | 4.5 / 11.4, 0.91% | 3.2 / 14 | 4.6 / 22, 1.69% |
| CO alone | 6.0 / 12.6, 0.97% | 9.2 / 85 | 12.9 / 81, 1.81% |
| CH4 alone | 2.9 / 5.2, 0.75% | 2.3 / 3.9 | 3.6 / 12, 1.28% |
| NH3 alone | 3.2 / 5.0, 0.47% | 2.6 / 4.1 | 3.5 / 13, 0.79% |
| HCN alone | 5.3 / 9.9, 0.76% | 3.5 / 12 | 5.6 / 17, 1.41% |
| SO2 alone | 3.4 / 8.5, 0.96% | 3.2 / 6.2 | 3.8 / 25, 1.80% |
| H2S alone | 4.5 / 8.0, 0.71% | 2.8 / 23 | 5.3 / 25, 1.30% |
| Na alone | 5.5 / 6.8, 0.16% | 4.4 / 35 | 10.4 / 54, 0.61% |
| K alone | 5.1 / 6.5, 0.08% | 5.3 / 27 | 13.9 / 65, 0.55% |
| TiO alone | 3.3 / 6.6, 0.22% | 1.6 / 4.0 | 5.6 / 28, 0.79% |
| VO alone | 2.7 / 6.7, 0.30% | 1.7 / 3.5 | 4.6 / 23, 0.66% |

With the same tables and the same interpolation the two codes agree to 1.2-6.0 ppm rms and 14 ppm at worst. The
reference has Rayleigh scattering by H2 and He only; this model also by the trace gases, which is worth up to
1 ppm of these differences (CO at 1e-3). Most
of that rms is a constant offset of +3 to +5 ppm in the single-gas cases (the scatter about it is near 1 ppm); its
origin was not found. The flux differences of the single trace gases (up to 1.8% with 60 layers) are at
wavelengths where such an atmosphere is transparent to the bottom of the model, so that the flux is the lowest
layer's temperature: for SO2 alone 1.80%, 0.94% and 0.49% with 60, 120 and 240 layers.

Three things this comparison found, each then settled against something other than petitRADTRANS:

1. **Putting a combined distribution back on the g-points** (`overlap` in `opacity.js`). Species are combined two
   at a time and the ng² sums reduced to ng values after each pair. The first version took the value interpolated
   at each node; that loses opacity at every step. `tools/opacity/mixing_study.mjs` carries random overlap out
   without intermediate steps (4096 joint samples per bin and layer, 64 intervals of g) on every tenth bin:

   | Reduction after each pair | Eight molecules: transit rms / mean (ppm), flux rms | Four molecules | Six absorbers, ultra-hot |
   | --- | --- | --- | --- |
   | value at the node (first version) | 36.6 / -26.3, 1.00% | 23.8 / -14.3, 0.50% | 8.1 / -4.6, 1.09% |
   | mean of k over the node's interval | 13.1 / +8.3, 0.34% | 7.5 / +0.7, 0.17% | 1.9 / +0.6, 0.67% |
   | exp of the mean of ln k (used) | 5.3 / -3.8, 0.09% | 6.2 / -5.0, 0.11% | 1.1 / -0.8, 0.18% |
   | petitRADTRANS, for comparison | 3.9 / -2.2, 0.37% | 6.0 / -2.9, 0.34% | 3.8 / +0.1, 0.33% |

   Reversing the order of the species changes the result by about 1 ppm rms; keeping the running sum on two or four
   times as many intervals gains 3-4 ppm at three to seven times the cost and was dropped. An earlier version of
   these notes blamed the 20.7 ppm of the four-molecule case on the top of the model; it was mostly this.
2. **Interpolating a table in temperature.** With identical tables, CO alone still differed by up to 95 ppm in the
   far wings of its bands, where σ rises tenfold per 100 K. petitRADTRANS's spectra are reproduced when σ itself
   is interpolated linearly in T (the "same interpolation" column); the model interpolates log σ in 1/T. Predicting
   each temperature node of the ExoMolOP tables from its two neighbours (400-2600 K, four pressures, 0.6-12 µm,
   σ > 1e-26 cm²; the spacing the shipped tables have), log10(predicted/actual):

   | | log σ in T | log σ in ln T | log σ in 1/T (used) | σ in T |
   | --- | --- | --- | --- | --- |
   | mean, twelve species [dex] | -0.021 to +0.004 | -0.010 to +0.005 | -0.001 to +0.006 | +0.010 to +0.068 |
   | rms, CO / CH4 / TiO [dex] | 0.065 / 0.034 / 0.049 | 0.054 / 0.019 / 0.030 | 0.050 / 0.017 / 0.026 | 0.141 / 0.071 / 0.146 |

   In spectra, a table with every second temperature node against the full one (R = 1000, one gas), transit rms
   in ppm for log σ in 1/T, log σ in T, σ in T: CO 0.7, 4.3, 15.0; CH4 3.0, 8.9, 4.7; CO2 4.0, 7.1, 15.5; TiO 0.5,
   2.0, 3.3; H2O 17.5, 20.3, 42.1 (means +3.0, -9.9, +31.1). So where the two codes differ by tens of ppm it is the
   interpolation, and the tables themselves favour log σ in 1/T. The other rules remain as `interpolation` in `gasExtinction` for these comparisons only
   (`tools/opacity/interp_study.py` for the nodes, `interp_study.mjs` for the spectra).
3. **Reducing the tables to fewer g-points** (`rebin_k` in `tools/opacity/build_opacity.py`). The mean of k over a
   node's interval keeps the bin's mean opacity but lets the top of each interval count for too much; with the
   interpolation fixed, the shipped H2O table was then 25.5 ppm rms (mean +20.7) from petitRADTRANS. The log mean
   gives 8.7 ppm (mean -1.6), and 10.3 against 23.3 for four molecules; it is the default.

The top of the model still matters in the strongest bands of a low-gravity planet: with a top at 1e-6 bar the
highest ray has an optical depth up to 0.20 at R = 1000, and moving the top to 1e-8 bar changes those bins by 100
to 250 ppm. The page reports this optical depth and warns above 0.05; its own default is a top at 1e-8 bar with
80 layers. Mixing two gases by random overlap is itself approximate: for two synthetic uncorrelated line spectra
whose joint distribution is known exactly, the transmittance after mixing two 16-point distributions is off by up
to 0.008, against 0.002 for the exact joint distribution on the same 16 points. petitRADTRANS drops a species
whose largest k is under 1% of the largest window opacity of the others; here such a species is added as a grey
term (under 1 ppm of difference from resorting everything).

### Resolution, size and speed (`tools/opacity/study.py`, `study.mjs`)

Two planets (a WASP-39 b-like Saturn-mass planet, where one scale height is about 400 ppm of depth, and an
HD 189733 b-like hot Jupiter), H2O + CO2 + CO + CH4 with CIA and Rayleigh scattering, 60 layers; spectra binned to
R = 100 over 0.6-12 µm and compared with a reference run with 240 layers. Times are for one forward model
(transmission and emission) in Node 22 on an Apple M-series laptop, with the layers' cross-sections cached
(only abundances changed). The k-table rows were rerun after the changes above (log-mean mixing, 1/T); the
sampled rows were not (no mixing is involved; their times are from before).

**Which source.** ExoMolOP's R = 15000 cross-sections give transit depths 63 ppm higher on average (94 ppm rms)
than its own R = 1000 k-tables for water on the low-gravity planet (`study_single.mjs`): the lines are narrower
than R = 15000, and unresolved cross-sections overestimate absorption (Garland & Irwin 2019). The k-tables,
made from the full line lists, are therefore the source of what ships and the reference of the second table.
No line-by-line calculation was run to settle it independently.

Made from the R = 15000 cross-sections, against those cross-sections as they are:

| Table | MB per molecule | Transit rms / max (ppm), low gravity | Hot Jupiter | Emission rms | ms |
| --- | --- | --- | --- | --- | --- |
| sampled, R = 1000 | 5.5 | 221 / 820 | 62 / 236 | 6.7% | 32 |
| sampled, R = 3000 | 16.4 | 121 / 473 | 34 / 127 | 3.1% | 96 |
| sampled, R = 10000 | 54.7 | 46 / 148 | 13 / 48 | 1.4% | 325 |
| k-table, R = 100, 8 g | 4.4 | 52 / 159 | 14 / 45 | 1.6% | 39 |
| k-table, R = 300, 8 g | 13.1 | 44 / 145 | 12 / 38 | 1.4% | 114 |
| k-table, R = 300, 16 g | 26.3 | 26 / 101 | 7 / 28 | 0.7% | 455 |

Sampling leaves noise that falls only as the square root of the number of points per bin; a k-table is better
per byte at every size.

Made from the R = 1000 k-tables (16 g-points), against those tables as they are:

| Table | MB per molecule | Transit rms / max (ppm), low gravity | Hot Jupiter | Emission rms | ms |
| --- | --- | --- | --- | --- | --- |
| R = 1000, 8 g | 48.6 | 31 / 87 | 8 / 19 | 0.95% | 418 |
| R = 333, 16 g | 32.4 | 14 / 78 | 4 / 20 | 0.35% | 559 |
| R = 333, 8 g | 16.2 | 39 / 127 | 11 / 31 | 1.2% | 137 |
| R = 333, 4 g | 8.1 | 147 / 370 | 36 / 85 | 4.0% | 49 |
| R = 200, 16 g | 19.5 | 15 / 48 | 4 / 14 | 0.43% | 338 |
| R = 200, 12 g | 14.6 | 22 / 61 | 6 / 17 | 0.64% | 181 |
| R = 200, 8 g | 9.7 | 39 / 98 | 11 / 27 | 1.2% | 83 |
| R = 91, 8 g | 4.4 | 45 / 163 | 13 / 48 | 1.5% | 39 |
| R = 333, 8 g, uint8 instead of uint16 | 8.1 | 40 / 127 | 11 / 32 | 1.2% | 139 |
| R = 333, 8 g, float16 | 16.2 | 39 / 126 | 11 / 31 | 1.2% | 138 |
| R = 333, 8 g, every 2nd T and P node | 4.6 | 43 / 123 | 11 / 33 | 1.4% | 137 |
| R = 333, 8 g, every 3rd T and P node, uint8 | 1.1 | 45 / 140 | 12 / 36 | 1.7% | 137 |
| **shipped: R = 200, 12 g, every 2nd node, uint8, log mean** | **2.06** | **14.0 / 85** | **4.1 / 15** | **0.41%** | **183** |

Every row but the last reduces the g-points by the mean of k over each node's interval. There, what decides the
accuracy is the number of g-points: 16 give about 14 ppm rms on the low-gravity planet, 8 about 39, 4 about 147,
whatever the resolution between R = 200 and 1000. Resolution above 200 buys nothing for data at R = 100. uint8
against uint16 changes the result by under 1 ppm; half the temperature and pressure nodes by about 4 ppm. The
shipped tables use the log mean instead (point 3 above), and at 12 g-points and 2 MB do as well as the 16-point
tables of 19 and 32 MB. With the log mean fewer points cost less than the table suggests: against petitRADTRANS at
R = 100, 8 and 10 g-points give 14.3 and 11.6 ppm rms for four molecules on the low-gravity planet (12: 10.3) and
21.6 and 16.3 for eight molecules (12: 13.4), at 1.4 and 1.7 MB per molecule; 12 is kept for the mixtures.
float16 is no better than uint16 at the same size (its steps near log10 σ = -25 are 1.8% in σ against 0.02%) and
`Float16Array` is absent in Node 22; it is decoded by hand and not used for storage. Time grows with the square
of the number of g-points (the species are resorted pairwise); the log mean costs about 40% more in that step than
the value at the node. With temperatures changing at every call (nothing cached), one model takes 220 ms for four
molecules and 60 layers, 300 ms with the page's 80 layers, and 870 ms with all twelve gases switched on.
Layers: 30, 60 and 120 layers differ from 240 by 11, 3.8 and 1.0 ppm rms in transit on the low-gravity planet and
by 0.44%, 0.11% and 0.02% in emission; an adaptive layer grid was not tried, because 60 uniform layers already
cost less than the tables.

### Not verified, not included

- HITRAN's site states no licence or redistribution terms for its data (searched 2026-11-20: the home page, the
  documentation, the citation policy, the CIA page and its readme); the five CIA tables shipped are derived from its
  files. The decision to ship them is the owner's. The tholin constants are Khare et al.'s published measurements,
  taken from the compilation distributed with LX-MIE (a GPL code; none of its code is used).
- No line-by-line reference; the comparison with petitRADTRANS shares its k-tables, so it says nothing about the
  line lists or about ExoMolOP's k-table generation.
- Collision-induced absorption was switched off in the petitRADTRANS comparison (the two codes' CIA files differ);
  ours is checked against the HITRAN file and as k n² in a slab. HITRAN's H2-H2 file stops at 1 µm and 3000 K:
  shortward and hotter the table is empty or clamped.
- The 3D "Planet" view (`atmoPlanetFrag` in `src/viz/shaders.js`) follows one ray per pixel through the model's
  layers: single scattering only, straight rays (no refraction), a point-like star for the shadow, the same
  atmosphere on the day and night sides (the model is one-dimensional). Its extinction per layer and colour
  channel is found from the model's limb transmittance by onion peeling (recovered to 5.5e-7 on a known profile),
  so the ring it draws in transit is the model's; its scattering coefficient is the model's; the interior's
  reflectance is the two-stream estimate below. Checked by eye, headlessly on a built copy: day side, terminator,
  transit, a silicate cloud, a Rayleigh haze. No reference image or second renderer was compared.
- Colours: true colour uses 0.38-0.75 µm of the model. For data that do not reach the visible a wavelength range
  (the plotted one, or an instrument's) is laid over 400-700 nm in log wavelength, shortest blue: false colour
  that keeps the order of the spectrum, not a claim about what an eye would see.
- The particle fit of Kitzmann & Heng (2018) is poor below x = 1 for absorbing grains (above); no Mie tables, no
  size distribution, no condensate species, no cloud microphysics.
- Escape: no hydrodynamic model, no measured stellar XUV spectrum, no comparison with an observed mass-loss rate
  (Lyman-alpha or helium 1083 nm transits); the planet's radius and orbit are fixed through the star's history. The
  temperature profile does not respond to escape, and no haze is produced from escaping or photolysed gas: the
  page says so beside the numbers.
- Ionization: hydrogen, sodium and potassium (potassium's recombination and electron-impact rates are estimates;
  molecules are not photodissociated; the chemistry carries no other free atoms); the star's ultraviolet is a blackbody for sodium and the Sun's history for hydrogen. The
  day-night option interpolates two given profiles and was compared with no circulation model or phase curve.
- Emission has no scattering and no reflected light. The day side's reflected colour in the 3D view is a
  two-stream estimate from the single-scattering albedo above optical depth 1; it was compared with nothing.
- The star is a blackbody in the eclipse depth and in the colours; its limb colours are those of a grey atmosphere.
- Mixing ratios are constant with height; there is no chemistry, no condensation, no thermal dissociation.
- The tables stop at 1e-5 bar and 3400 K (values are held constant beyond) and cover 0.30-49.99 µm.
- A constant +3 to +5 ppm against petitRADTRANS in the single-gas cases (same tables, same interpolation) is
  unexplained.
- Na and K are ExoMolOP's tables of the Kurucz lines with the Allard resonance-wing profiles; they were compared
  with petitRADTRANS reading the same files, not with its own Na and K opacities. TiO is 48Ti16O only.
- All twelve gases switched on take about 0.9 s per model; nothing was done about it (fewer g-points, or the
  GPU, are the options on the roadmap).
- HITRAN states no redistribution licence for the CIA files; the two derived tables (0.3 MB) are in
  `public/opacity/` uncommitted, for the owner to decide.
- The page was checked in the app's browser pane on the dev server (first load, every plot, both 3D modes, the
  cloud deck, emission, the hand-off to the Spectroscopy simulator) and headlessly on a built copy; the catalogue
  look-up, the CSV and PNG exports by clicking, touch, and narrow screens were not. With twelve gases the page
  fetches a gas's table when it is first switched on (6 files, 8.5 MB, at the start; 14 with everything on):
  checked headlessly on a built copy, where one model took 291 ms with the four default gases and 830-880 ms with
  all twelve. The offline check was not rerun after that change.

## Sessions, saved analyses, exports

An analysis is one JSON document (`docs/FORMAT.md`, `src/core/session.js`): system, data, priors, sampler and,
when there is one, the posterior. "Save" keeps it in the browser (IndexedDB), the Results tab writes it as a
file, and the same file runs headless (`runSession`), in the Python package and in the MCP server. Results
also export as LaTeX, JSON, a Markdown report and a Python script that rebuilds the fit with every prior as an
editable line (`src/core/exportScript.js`). Every worked example opens with a stored posterior
(`public/examples/results/`, sixteen of them: rebuilt by `tools/build_example_results.py` in the page, or by
`tools/build_example_results_node.mjs` for the four whose sessions use blocks the page does not carry yet). The Fit tab's "Wide survey bounds" frees Rp/R★ in [0, 1.25 × value], i ± 5°, T mid within a
quarter orbit and the airmass coefficient in [−3, 3]. "Methods paragraph" on the Results tab writes a methods
paragraph for a paper from the session (models, priors, sampler, limb-darkening source), the BibTeX of exactly
the references it cites, and a list of what the author must still state (`src/core/methodsText.js`).

**Radial velocities from archives.** On the Data tab, "Find radial velocities" asks VizieR, at the host's position,
for four public catalogues: Keck/HIRES (Butler et al. 2017, and its correction by Tal-Or et al. 2019), the
ESO/HARPS RVBank (Trifonov et al. 2020) and Lick (Fischer et al. 2014), through the CfA and IDIA mirrors, which
allow requests from a browser (`src/core/rvsources.js`). Each instrument era is added as its own dataset with its
own zero point and jitter, with its provenance saved in the session; "Set up joint fit" switches on Kepler's law,
the light curve and the velocities. Check: the 43 HIRES velocities of 51 Peg give K = 56.5 ± 0.6 m/s against
56.05 ± 0.60 published from them; the 97 HIRES velocities of HD 80606 give 466.2 ± 1.8 m/s, within the published
465.5–476.1. The NASA Exoplanet Archive (no CORS header, no RV table), DACE and the ESO TAP cannot be used from a
browser; WASP-12 and HAT-P-32 are in none of the four catalogues.

**Time standards.** Light-curve times labelled JD_UTC, HJD_UTC or BJD_UTC are converted to BJD_TDB with the host's
coordinates (`src/core/data.js`; against astropy within 0.05 s, `test/timestd.test.mjs`). A column labelled just
"JD" is taken as BJD_TDB (EXOTIC writes "Time (JD)" for BJD_TDB), with a note; without coordinates nothing is
converted and the Data tab says so.

**Detrending.** Light curves can carry centroid x and y (and their squares and product), PSF width, sky, airmass,
the comparison star's flux, a Legendre polynomial in time and pixel-level decorrelation components as linear
regressors, integrated out analytically with the transit (`data.regressors` in `buildProblem`,
`src/core/detrend.js`), and EXOTIC's nearest-neighbour Gaussian kernel regression on the centroids, recomputed at
every likelihood call (`data.kernel`). The photometry page hands them over; the Data tab shows which terms are in
and their coefficients. Checks (`test/detrend.test.mjs`, `test/lcdetrend.test.mjs`): centroid polynomial against
numpy to 2.8e-8 in χ²; PLD against Deming's regression on all pixel fractions 964.488 = 964.488; kernel weights
against EXOTIC's `gaussian_weights` to 2.2e-16 and a fit against EXOTIC's `lc_fitter` with the same Rp/R★
(0.10018) and T mid within 0.6 s; an injected 3000 ppm centroid systematic recovered as 2958 ppm; TESS WASP-18 with
6 PLD components: 1-hour scatter 186.6 → 150.7 ppm. The photometry page's Detrend choice, on the closed-form
transit times a quadratic in time with 250 ppm of noise: 'quadratic' recovers Rp/R★ 0.10011 ± 0.00012 (injected
0.1) at 247 ppm scatter, 'linear' leaves 834 ppm, and 'airmass' without an airmass is the linear fit. A fit with the kernel has an evidence that is not comparable
with one without it, and the comparison says so.

**Detrending in sessions and Python.** A session stores the detector columns (`light_curve.columns`, `null` where a
value is missing) and the detrending choice (`light_curve.detrend`); `specFromSession` now rebuilds the regressors
or the kernel from them with the analyzer's own `applyDetrend`, so `runSession`, the MCP server and the Python
package fit a session with its systematics model. In Python, `esl.LightCurve(columns=..., detrend=esl.Detrend(...))`
and `esl.read_light_curve(..., detrend=...)` carry them. Checks (`test/sessiondetrend.test.mjs`): on a two-night
curve with centroid and time systematics the session's regressors equal the columns standardised by hand plus a
Legendre P1(t) (2.9e-9, the rounding of times through JD 2460000), the likelihood equals the analyzer's import path
bit for bit, and `runSession` returns Rp/R★ = 0.1006 ± 0.0005 (injected 0.1), χ² 478 for 520 points, where the same
session without its model gives 0.1124 ± 0.0003 and χ² 10742; a column with a missing value is dropped as in the
analyzer; a kernel model reaches the likelihood. From Python (`python/tests/test_detrend.py`) the χ² equals Node's
to 1e-12 and the posterior medians agree within 0.05σ. Not checked: a session exported by a real browser with
photometry-page columns (the in-browser path was reproduced in Node, not run in a browser).

**Light-curve jitter and dilution.** Two optional terms of `buildProblem`, switched on in the System tab's Baseline
block (`+ jitter`, `+ dilution`). The jitter `jitlc` (ppm; one per epoch, `jitlc@2`, ...) is added in quadrature to
the light curve's error bars, in the weights and in the `ln σ²` normalisation, and enters BIC through χ² + Σ ln(σ²/e²)
like the velocity jitter. The dilution `dil` = d, the flux of other stars in the aperture over the target's, turns
the model m into (m + d)/(1 + d) before the baseline terms: depths shrink by 1 + d; a contamination fraction D (TESS
CROWDSAP = 1 − D) is d = D/(1 − D). Checks (`test/lcnoise.test.mjs` against `test/make_lcnoise_reference.py`, which
integrates over the normalisation numerically with scipy): ln L at four jitter/dilution points agrees to 1.2e-6
(the closed form subtracts sums of order 1e8, so 1e-5 is the test's tolerance); maximum-likelihood jitters 1470.71 and
617.61 ppm against scipy's 1470.70 and 617.57; an injected 1500 and 600 ppm is recovered as 1489 +107 −101 and
592 +110 −120 ppm; depth(d) = depth(0)/(1 + d) at every point of a limb-darkened, exposure-averaged transit to
1.6e-16; the same diluted data fitted without the term give Rp/R★ 0.0850 ± 0.0008 against the expected
0.1/√1.4 = 0.0845. Not done: the HD 80606/HD 80607 flux ratio in the TESS band is not in the repository, so the
HD 80606 example is still fitted without the correction; set `dil` to that ratio to apply it.

**Observing project.** A "Project" chip in the site bar follows one target from choice to report (target, plan,
observe, reduce, fit, archival velocities, joint fit, model comparison, report), with a note on what to do at each
step and a link to its page (`src/site/project.js`, `window.__esl.project`). It is kept in this browser only.

## Python package

`python/` is the same JavaScript core run from Python (embedded V8 through `mini-racer`, else a Node
subprocess, else QuickJS), bundled by `npm run build:python`; nothing is translated by hand. `esl.Session`
(pydantic) loads a browser export, runs it and saves a file the browser opens; `esl.multi_fitter` mirrors
EXOTIC's `multi_fitter` classes so its three-planet script runs with only the import changed. Of the six stored
example results checked from Python (before the sampler change), five reproduced exactly and the sixth to 0.004σ; 72 pytest tests pass on macOS
arm64 with Python 3.12 (not run on Linux, Windows or other Python versions; nothing is on PyPI). Speed equals
Node: about 16,000 likelihood calls per second on a 400-point transit. See `python/README.md`.

## Assistant and MCP server

Every page has a chat bubble at the bottom right (`src/assistant/`, loaded only when opened). The assistant
operates the site: it sets up the planner, moves the sky view, runs a photometric reduction, filters the
catalogue, quotes the validation, and in the analyzer loads data, sets up and runs fits and queues of model
variants. A request can cross pages ("plan the transits of WASP-43 b from Kitt Peak, then set up a fit"): the
assistant changes page and carries on, with a compact project record (site, planned event and its BJD, data,
fits with their numbers, files) in every request.

*Model server.* The set-up card offers *LM Studio on this computer* (`http://localhost:1234/v1`: start the server
in LM Studio's Developer tab and switch on "Enable CORS") and *Custom…* for any server that speaks the OpenAI chat
protocol (vLLM, Ollama, llama.cpp, a hosted API, your own machine over a VPN). **Test connection** lists the models,
sends one tiny request and says in plain words what is wrong. An https page cannot call a plain-http address on
another machine (mixed content): run the site locally over http, put the server behind https, or use the MCP
server. See [Assistant and your own LLM](./assistant).

*The panel.* The header has Actions (what the assistant changed, with undo and the transcript), a cog for
Settings and + for a new conversation; the bottom has Attach and Send. Settings holds the server, the model and
its budgets, and **Tools on this page**: every tool the assistant may use here, grouped (system, data, fitting,
results, reports, the page's own), with a one-line description, ✎ on those that change something, and a switch
each (kept for every page). A tool switched off is not offered to the model, and a call to it is refused with a
sentence saying so. Deleting the observing project (Project → Delete project) also clears the assistant's memory
of it and the conversation.

*Coverage.* Every page declares tools for its controls: Plan (events, site, dates, target, limits, list, open,
export), Observe, Photometry (frames, examine a star, focus map, stars, apertures, every other option including
scoring with the planet, decorrelation for the analyzer, the AAVSO report, run, save, hand-off), Spectroscopy,
Search, Methods (`methods_find` quotes how a technique is done with its checks, limits and references;
`methods_cite` gives the BibTeX; `validation_find` the comparisons), and the analyzer (about 57: catalogue
look-up, every parameter and prior, data, fits, experiments, results, exports). `write_report` writes the
standard project report (`src/core/report.js`, `test/report.test.mjs`): summary, target and observation (from
the Project checklist), data reduction (from the Photometry hand-off), system, data, fit set-up, result, model
comparison of the runs, a methods paragraph with Pandoc citations, figures, reproduction and references, with a
BibTeX file, the session and the figures.

*What keeps it honest.* Every number in an answer is compared with the tool results; when a number is missing
or quoted without its uncertainty the app appends its own table. Actions that replace data or delete a saved
analysis ask first; changes to the analysis can be undone from the Actions list; Stop interrupts it and any fit
it started; "do not run it" gets no fit.

*Context.* Each request carries the primer, the current page's core tools (the rest by `more_tools`), the state
card with the project record, and the conversation up to a history budget (default 6000 tokens, a setting);
older turns are summarised, long tool results are cut and retrievable with `read_result`. On the owner's model
(gemma4-e4b) the mean prompt per request fell from 24.5k to 11–14.5k tokens in a long session.

*Checked:* `node test/assistant.test.mjs` (126, scripted model, including a scan that fails on any address other
than the two presets or any key), `node mcp/test.mjs` (28, 45 tools on session documents). Live, headless
Chromium, gemma4-e4b: the eight-task suite answered 8 of 8; the end-to-end session "find a transit from Kitt
Peak, simulate that night, fit it, report Rp/R★ and T mid with a figure" succeeded in one of four runs at both
widths (Rp/R★ 0.11937 +0.00032 −0.00027 for WASP-12 b); in the others the model skipped a step or picked a TESS
candidate it could not load, and once reported another planet's fit under the candidate's name (guards were
added for each). A 4-billion-parameter model is not reliable on long multi-step sessions; the number check
catches dropped uncertainties, not wrong units or wrong conclusions. Not checked: Safari, Firefox, a real https
deployment, other model servers.

*Round of 2026-11-16 (equations, Methods and code tools, residual periodogram, history and export).* New checks:
`node test/assistant_knowledge.test.mjs` (22: Methods lookups land on the right section for seven questions;
`extractSymbol` returns whole functions; `read_source` refuses paths outside the code; the residual periodogram
finds a 17.3-day, 25 m/s signal injected into the HD 80606 velocities of a one-planet model at 17.299 d with a
false-alarm probability of 1e-148, finds nothing in white noise alone (best FAP 0.70), names a peak at the known
planet's period, and warns when the residuals are 2.4 times their errors; LaTeX found in text and dollar amounts
left alone) and `node test/assistant_sft.test.mjs` (15: a conversation driven through the harness against a scripted
model exported and read back; every tool call answered right after it, reasoning and state cards kept, the app's
table left out). Harness changes found by running the owner's gemma4-e4b (LM Studio on the owner's Mac, q4 and q8
quantisations; the VPN copy did not answer during this round): lists written as one escaped string are repaired;
a velocity-only project starts from the orbit and refuses to fit Rp/R★ or i; a fit of the simulated stand-in is
refused while the user's own file is attached; a call refused three times in a row first forces an answer
(`tool_choice: "none"`), then stops; six steps without progress bring a reminder to answer; a request with parts
left undone (explanation, residual search, report) is reminded of them, twice at most; a question cannot change the
analysis. Live, after these changes: the velocity project of HD 80606 b (seven instruments, fit with six jitters,
explanation, residual search, report) completed in 10 steps (K 467.6 +2.6 −2.1 m/s, e 0.93114, χ²/dof 0.96;
best residual peak 2.435 d, FAP 0.025, not a signal); the light-curve project in the browser completed in 11 steps
(Rp/R★ 0.0727 +0.0012 −0.0011, as Lab 2; report with BibTeX, session and figures); "how is K computed, derive it"
was answered with the code's equation and a correct derivation once the derivation was added to the Methods (before
that, the model's own algebra was wrong in two of two runs); "how is T_eq computed" on the Methods page was answered
in 7 steps. Numbers the model rounds or recalls are still common (two to four per long answer), and the number
check still has to append the app's table.

*Round of 2026-11-16, evening (the VPN copy of gemma4-e4b, vLLM, about 0.2 s per short request).* Planning dates:
`node test/nightdates.test.mjs` (16: a date without a year is its next occurrence, a past date moves to next year
with a note, a month alone is the whole month, "between January and July" asked in November is 2027-01-01 onward and
is cut at the planner's 90 nights with the rest named, ranges wrapping the year, ranges found in a sentence). The
state card now gives today's date and time zone, and the planner applies a month range the user wrote when the
model passes only one end (in the browser: "between February and April" from La Silla, planned 2027-02-01 to
2027-04-30; "between January and July", 2027-01-01 onward). Other changes found in these runs: a draft answer whose
numbers differ from the tool results is sent back once with the exact list, and the corrected answer goes to the user
(and to an export) without the table; its "Here's the corrected answer" opening is removed; "brightest first" sorts
magnitudes ascending whatever the model asks; the observatory name is used instead of remembered coordinates;
load_example lists every example and opens the one the user's words describe when the model picks another (scored on
title words and numbers: "the example with 40 mid-transit times" opens `ephemeris`); an ephemeris result says in
words that a negative dP/dt is a shrinking period; compare_runs says that runs of one model compare nothing; after
photometry_send_to_analyze the model is told the photometry part is done; changing the model server no longer keeps
the old server's model (a connection test that finished after the change used to overwrite it). The MCP and Node
examples list grew from 6 to 16 worked examples. Worked examples through `node test/assistant_examples.mjs` (open
fresh, fit, explain): single, hd80606-tess, multi, hd80606-rv, hd80606-joint, toy1873, hd80606-rm, phasecurve,
eclipsemap, eclipsemap-sim, exomoon and toi1873-oc all completed (4 to 10 steps, 13 s to 199 s each); the number check
passed for 9 of those 12 once the correction step was in. The fresh fits of TOI-1873 (32,000 points) and of the N-body
examples were still running after 30 minutes in Node and are not reported here. In the browser (`test/assistant_live.py`):
the planner date tasks, photometry (focus map, WCS, Gaia ranking, optimal apertures, reduction, hand-off),
spectroscopy (simulation, white light, channels, spectrum), the sky view's survey image, the catalogue query and the
two timing examples (decay: dP/dt −25.57 ± 0.84 ms/yr; the 40-time list) completed.

## Observing: time, FITS headers, the helper and live reduction

Added 2026-11-18. The numbers are from the tests named; rerun them for the current values.

**Time scales** (`test/timescale.test.mjs`, against astropy 6.0.1, `test/make_timescale_reference.py`, UT1 = UTC)

| Quantity | Largest difference | Notes |
|---|---|---|
| UTC→TAI | 17.6 µs | 16 instants 1975–2030, leap-second days included (float64 Julian dates resolve about 40 µs) |
| TT | 27.8 µs | |
| TDB | 44.3 µs | two periodic terms |
| GPS seconds | 28.8 µs | |
| MJD | 13.2 µs | |
| apparent LST | 0.016 s | three sites |
| BJD_TDB | 0.038 s | three targets |

A positive leap second (23:59:60) has no UTC Julian date: `toUtc` returns the next day's first instant. The three leap-second tables of `astro.js`, `observability.js` and `fits.js` are now one, and their tests are unchanged.

**Clock offsets** (`test/clocksync.test.mjs`, simulated servers with known offsets)

| Case | Truth inside the bound | Largest bound |
|---|---|---|
| HTTP `Date` header, 8 probes, 20–120 ms round trips | 400 of 400 runs | ±74 ms |
| Asymmetric 5–15 / 80–200 ms paths | 400 of 400 | ±135 ms |
| Millisecond API, 5 probes | 400 of 400 | ±36 ms |

Probing at second boundaries gives a bound 2.7× tighter than evenly spaced probes.

In the browser, a `?clockskew=5000` page measured −4.998 s ± 11 ms against the dev server's `Date` header. Live SNTP to pool.ntp.org from `python -m esl.time` gave +8.6 ± 14 ms, and macOS `sntp pool.ntp.org` at the same minute gave +9.3 ± 42 ms.

**NMEA** (`test/nmea.test.mjs`): the published RMC, GGA and ZDA example sentences and their checksums.

**FITS headers** (`test/fitsheader.test.mjs`, astropy via `test/make_fitsheader_reference.py`)

Three frames were written: BITPIX 16 unsigned, 32 and −32, with long strings, quotes, Bayer cards, a solved WCS and an approximate WCS.

- Every frame passes `fits.verify('exception')`, and every card reads back equal.
- Against astropy:

  | Quantity | Largest difference | Notes |
  |---|---|---|
  | BJD_TDB | 0.048 s | |
  | LST | 0.047 s | the card rounds to 0.1 s |
  | HA | 0.019 s | |
  | Altitude | 21″ | geometric: no aberration or nutation |
  | Azimuth | 15″ | |
  | sec z | 4.5 × 10⁻⁵ relative | |
  | Moon separation | 0.011° | |
  | WCS pixel→sky | 0.000 mas | |

- Our own readers recover the time (BJD_TDB at mid-exposure), pointing, site, airmass, pixel scale, pier side and Bayer pattern.

**ImageBytes** (`test/alpacabytes.test.mjs`): the JavaScript decoder and the Python encoder are byte-identical, and alpyca 3.1.3 (the ASCOM Initiative's client) decodes the helper's images to the camera's pixels (`python/tests/test_bridge.py`).

**The helper** (`python/tests/test_bridge.py`). alpyca drove the simulated camera: connection, size, binning, gain range, cooler, exposure, `ImageReady`, `ImageArray` and `LastExposureStartTime`. The tests also cover:

- CORS and Private Network Access headers;
- refusing other origins;
- Alpaca error numbers;
- `/esl/save`, which refuses unsafe names and never overwrites;
- the ZWO backend against a fake SDK;
- the simulated transit: exact with the noise off.

In the browser, Run drove `python -m esl.bridge --simulate` over Alpaca. The 55 frames it wrote pass astropy `verify()` and carry CLKSRC "helper - NTP 2.pool.ntp.org", CLKUNC 0.019 s.

**Sequences** (`test/sequence.test.mjs`). HAT-P-32 b transits from Kitt Peak in November 2026 ran on a simulated clock. No light frame started or ended outside the window, with the target below its limit or with the Sun above its limit. The tests also cover:

- one pause at the meridian;
- stopping when the target sets;
- waiting for the Sun;
- a cooler that never reaches its set point;
- calibration after the lights.

**Live reduction** (`test/reduce.test.mjs`, `test/rehearsal.test.mjs`)

- **Same numbers as before.** The per-frame work of `runStack` is now `src/core/reduce.js`. The photometry, EXOTIC-photometry, imexam and detrend tests print identical numbers.
- **Growing arrays.** Arrays grown frame by frame equal arrays sized up front.
- **Simulated night.** 256 frames of a 1.2 % injected transit, calibrated with bias, dark and flat, gave 1.01 ± 0.10 % (1.9σ).
- **Poor tracking.** A simulated mount with walk, periodic error and 9 px jumps was followed to 0.28 px median, 0.82 px worst.
- **Rehearsal.** A rehearsal of the 2026-12-01 HAT-P-32 b transit (60× speed, 62 s frames, "average" tracking, 279 light frames) gave a light curve whose depth, fitted with the predicted shape, is 1.007 × the model's 2.68 %, at 3.50 ppt per frame. Its measured track followed the simulated pointing to 0.02 px.
- **Rehearsal from Plan.** A WASP-121 b transit from Las Campanas (2026-01-19), handed over by Plan's "Observe this event" and rehearsed at 120×, paused once at the meridian with the rehearsal clock stopped. It gave 0.951 × the model's 1.81 % depth (2.15 ppt per frame).

**Why that rehearsal came out shallow (investigated 2026-11-19).** The night was reproduced in Node with the Run page's settings, and the simulated star field varied by seed (7 to 22). The depth relative to the model was fitted with a baseline (time, airmass, and FWHM where said), with its white-noise error. Four causes were found:

1. **Run chose bad comparison stars** (a bug, fixed).
   - **What went wrong.** It took any star at least 15 px from the target. That included pairs 2 FWHM apart, stars whose sky annulus ran off the frame (NaN fluxes), and stars at 6–17 % of the target's brightness. A neighbour's light moves in and out of the aperture and the annulus as the seeing changes, and the seeing follows the airmass, which is lowest near mid-transit.
   - **Worst cases.** Dropping one crowded pair took seed 8 from 0.30 to 1.05.
   - **The fix.** `chooseStars` in `src/core/reduce.js` takes stars that are isolated out to the largest sky annulus, have room for that annulus, are unsaturated and are at least a quarter as bright as the target. It warns when it has to relax a test and when the target itself has a neighbour. It is checked on a constructed field in `test/reduce.test.mjs`.
2. **The simulator put field stars on top of the target.** Most seeds had stars 6–14 px from it at 6–33 % of its flux, an invented blend that dilutes the transit. Rehearsals now keep 30 px around the target clear (`clear` in `src/core/simsky.js`): a real target's neighbours are not simulated anyway.
3. **No FWHM in the baseline.** Run handed Analyze the light curve without detrending columns. It now sends xc, yc, sky, FWHM and airmass, as Photometry does.
   - Seed 7: 0.74 → 0.98 with FWHM added.
   - Seed 11: 0.42 → 1.03.
4. **No flats.** The sequence from Plan takes no flats (they need a panel or the twilight sky). Stars carried across the uncorrected vignetting by drift and the tracking errors change brightness against each other.
   - With flats, the spread over nine seeds fell from ±0.14 to ±0.08.
   - Run's summary now says when a sequence has no flats.

**After the fixes**, with flats and FWHM in the baseline, the nine seeds give 0.82–1.06, mean 0.975 ± 0.026, against white-noise errors of about ±0.045. A few-percent residual remains and is **not explained**. The residuals are slightly red (the mount's 8-minute periodic error, the seeing cycle), so the white-noise errors are too small by a factor of about 1.7.

`test/rehearsal.test.mjs` runs that night with the fixed pipeline: seed 8 gives 1.109 ± 0.055 and seed 12 gives 1.020 ± 0.061, both within 3σ. The HAT-P-32 b rehearsal (1.007, flats taken) was not affected.

**Not run.** No real camera, mount, filter wheel or USB GPS has been connected. No transit fit in Analyze has been run on a Run light curve; the hand-off to Analyze was checked, not the fit. Plate solving inside Run is not done.

## The site

Pages are real folders with their own `index.html` (no rewrite rules needed on a static host), sharing the
navigation bar in `src/site/nav.js` and the tokens in `src/site/site.css`:

| Path | What it is | Code |
| --- | --- | --- |
| `/` | landing page | `index.html` |
| `/plan/` | transits, eclipses and phase windows observable from a site | `src/plan/`, `src/core/observability.js` |
| `/observe/` | the sky for a place and time, in VR and passthrough too | `src/sky/`, `src/core/astro.js`, `src/core/horizon.js` |
| `/analyze/` | transits, velocities, timing, phase curves, moons, dynamics, detrending | `src/main.js`, `src/ui/`, `src/viz/` |
| `/analyze/photometry/` | images to light curve: FITS frames, TESS, Kepler and K2 pixels | `src/photometry/`, `src/core/fits.js`, `photometry.js`, `detrend.js`, `aavso.js` |
| `/analyze/spectroscopy/` | spectra over time to a transmission or emission spectrum (JWST, Ariel) | `src/spectra/`, `src/core/spectroscopy.js`, `missionbands.js` |
| `/search/` | catalogue browser: NASA archive, exoplanet.eu, TOIs | `src/search/`, `src/core/sources/`, `src/core/relations.js` |
| `/methods/` | methods, validation, reproducibility, references, how to cite | `src/methods/`, `src/validation/` |

`/observe/photometry/`, `/observe/spectroscopy/` and `/validation/` redirect to the new places, keeping their
anchors. The three Analyze pages share a sub-bar (`src/site/subnav.js`).

Everything runs in the visitor's browser; nothing is uploaded. Pages hand work to each other by address:
`/analyze/?planet=<name>` (also `TOI-1234.01`) looks a planet up, `/plan/?planet=<name>` lists its observable
events, `/observe/?planet=…&t=…&lat=…&lon=…&elev=…&transit=<start>,<mid>,<end>&event=transit|eclipse|phase|custom`
points the sky at a target for a window, and the photometry and spectroscopy pages pass a light curve (with its
detrending columns) to the analyzer through `localStorage` (`esl.handoff`) and `/analyze/?handoff=1`.
`/analyze/?skipintro` skips the start page; `?noassistant` hides the chat bubble.

**Desktop and mobile.** Every page is laid out for a phone (390 px), a tablet (768 px) and a desktop. The site bar
folds its links into a menu when they do not fit, each link with a one-line description. On touch screens controls
are at least 40 px and text fields 16 px; a hover note appears on tap on every page, the analyzer's derived
quantities included (`src/site/tips.js`). On a phone Plan starts with the globe folded so the events are near the top. The analyzer fills the window at every size: upright
phones stack the 3D view, the plot and the panel, each foldable, and ⤢ gives the panel the whole screen; plots and
the From-Earth view take a pinch. `test/layout_check.py` opens every page state at 390, 768 and 1440 px and fails
on horizontal overflow or console errors; at 390 px it also fails on a control under 40 x 40 px or text under 11 px in
the site bar, its menu, the Analyze sub-bar, the project panel and the assistant's sheet (66 checks). Not checked: any real phone or tablet, iOS Safari (dynamic viewport,
safe-area insets), Firefox, screen readers.

**Resizing the analyzer.** The edge between the 3D view and the plot, and between them and the side panel, can be
dragged (mouse, finger or pen: a bar marks each grip), moved with the arrow keys (Shift for bigger steps) and reset
with a double-click; sizes are kept in `localStorage` (`esl.layout.sizes`, `exoplanetsciencelab.panelw`), separately
for the side-by-side and the stacked layout. On a phone the grip over the plot sets the 3D view's height and a handle
along the top of the panel sets the plot's. Every figure is drawn again at its new size and chooses its layout from
the shape it has: the phase curve puts its orbit, eclipse and transit panels in a row when the plot is wide and short
and one above the other when it is narrow; the Map view stacks the map over temperature against phase unless the plot
is more than 2.3 times as wide as tall, and shows the map alone when it is too small for both; "All planets" picks
the grid whose panels come closest to 1.7 : 1; the Moon view moves its legends to a column on the right in a wide,
short plot; axis titles shorten to what fits; legends that would cover the data are moved or left out. Checked by
headless screenshots of every worked example at four plot shapes (1260 × 210, 530 × 720, 680 × 640 and the 390 px
phone) and by two extra `test/layout_check.py` states (plot made tall, plot made short: 91 of 91 checks pass). Not
checked with a real finger or on a real phone.

**Themes.** The site bar's theme button (a row in the folded phone menu) picks Dark (the default), Light, Dusk
(blue-grey, lower contrast) or Night (red and amber with almost no blue, for the telescope). The choice is the
`data-theme` attribute on `<html>`, kept in `localStorage` (`esl.theme`) and set by a one-line script in each page's
`<head>` before the first paint; the operating system's light/dark setting is not followed, so a first visit is Dark.
Colours are CSS variables (`src/site/site.css`); canvas plots on screen follow through `src/site/theme.js`
(light curve, corner, O − C, periodogram and N-body plots, the photometry and spectroscopy panels, the Validation
charts, the planner's charts in Night), while exported figures keep their own Dark and Light styles. The 3D view
and the sky view stay dark; in Night the planner's globe, the all-sky camera, the FITS image and the home-page pictures
are tinted red. Text contrast (WCAG 2.1, the worst of page, panel, raised panel and pop-up backgrounds): body text
14.3, 14.0, 10.5 and 9.7 : 1 in Dark, Light, Dusk and Night; secondary text (`--dim`) 5.6, 6.3, 6.0, 5.5; the
dimmest text on the reading pages 5.1, 4.9, 5.0, 4.8; accent, status and tinted text at least 5.3 in every
theme. Checked by headless screenshots of the eight pages at 1440 and 390 px in each theme (no page errors), a
switch on a live analyzer page (the light curve redraws), and `test/layout_check.py` (Dark). Not checked: the
layout check in the other themes, every plot of the analyzer in every theme (some plots draw a few fixed colours, and
the posterior points stay viridis in Night), Firefox and Safari (`color-mix()` is needed), the docs site, which keeps
VitePress's own light/dark switch.

**Animation rate.** The slider under the 3D view sets simulated time per second of real time on a logarithmic scale
of round steps (30 s/s … 1 min/s, 5 min/s, 15 min/s, 1 h/s, 3 h/s, 6 h/s, 1 d/s … 100 d/s; `src/ui/rate.js`). Each
system starts at its own default: the transit in about 12 s, the whole orbit in about 20 s with "Full orbit", and, when
the planet's own light is in the model, the eclipse ingress in about 5 s, starting just before the eclipse (5 min/s for
the WASP-43 eclipse-map example, whose ingress lasts about 20 min). A recorded movie plays one pass at the chosen rate, kept between 5 and 60 s.

**The fitted map on the 3D planet.** With a phase curve or an eclipse map in the model, the planet in the 3D view (and
so in a recorded movie) wears its brightness-temperature map on the Map view's colour scale, fixed to the substellar
point, so it turns with the orbit and shows the hemisphere the light curve's cursor is at. It is the map of the values
on show (the best fit after a fit, the live draw while sampling), not a per-pixel posterior median. The frame
(`src/viz/planetmap.js`, mirrored by the planet shader) is checked in `test/scene.test.mjs` against the Map view's
convention: the hemisphere facing the observer has sub-observer longitude −(phase − 0.5) × 360° and latitude 90° − i
at eight phases for i = 90° and 83.5° (error below 10⁻⁶°), and the substellar point faces the star.

**Offline.** `tools/sw/build.mjs` writes `dist/sw.js` after every build (a Vite plugin, and again in
`tools/docs/assemble.mjs` once the docs are in): the template `tools/sw/template.js` with the list of every file
of `dist/` and the first 16 hex digits of its SHA-256. The version is the hash of that list, the cache is
`esl-<version>`. Install saves the shell (147 files, 8.0 MB: every page, script, style, worker, image, the sky data,
observatories, validation data and the catalogue index) and fails if any of it fails; the rest (500 files, 62.9 MB:
catalogue shards and snapshots, examples, sample FITS, the docs) is saved in the background when a page has been idle
4 s, three files at a time, unless the browser's Save-Data is on. Every download is checked against the manifest
hash, so a file from a newer deploy never enters an older version's cache; a file with the same hash is copied from
the previous version's cache instead of downloaded. Same-origin requests are answered cache first; revalidation is
per version (the browser re-checks `sw.js` on navigation, at most every 5 min from the worker), and a new version waits
until the page accepts the "Reload" notice or no tab is open, then deletes the old cache. Other origins are not
intercepted. `src/site/net.js` puts "Offline: using the saved copy" in the site bar when `navigator.onLine` is false or
a same-origin file fails, and `fetchOr(url, { what, fallback })` turns a failed request into a notice naming the
service. `src/site/offline.js` registers the worker only in a production build over https or localhost; `?nosw`
removes it. `test/offline_check.py` (Chromium, Playwright) serves a built copy itself, saves the site (647 of 647
files), then stops the server and cuts the connection, and opens home, Plan, Observe, Analyze (start page,
`?skipintro`, the eclipse-map example), Photometry (and the WASP-18 TESS sample), Spectroscopy, Search (rows loaded),
Methods (and Validation ready), the docs home, a guide, the 4.4 MB METHODS page and a redirect stub: all render, with
no page error, and show the offline pill; an unknown address gets a page that says it is not saved; a TESS search on
Photometry shows "You are offline: The MAST archive (its AWS bucket) needs the internet". With `--update` it changes
one file and regenerates `sw.js`: the new version installs next to the old one, Reload switches to it, the old cache
is deleted, and only `index.html` and `sw.js` are downloaded again (no catalogue, example or docs request). Not
checked: Firefox and Safari (Safari may evict the cache after weeks without a visit), a real flaky network (a server
that hangs rather than refuses), storage quota prompts, and the live services' notices other than MAST's (VizieR,
SIMBAD and the RV, sky and assistant calls in files not yet moved to `fetchOr`). `file://` does not work (Chromium
blocks module scripts and stylesheets with `crossorigin` from origin `null`, checked); each page then shows how to
start a local server.

Page checks without the interactive browser: `.venv/bin/python tools/shot.py '<path>' out.png [w h] --wait ms
--eval "<js>"` takes a headless screenshot and prints console errors.

### Long runs and the companion explorer

Long computations (an analyzer fit, the search for an unseen companion, a photometry reduction, the spectroscopy
channel fits) report to `src/site/jobs.js`: a pill on every page with the fraction, elapsed time and an estimate of the
time left from the last two minutes' rate, Stop, and an optional desktop notification; the tab title carries the
percentage; leaving or reloading the page asks first while a job runs (checked in Chromium: the browser's
`beforeunload` dialog appears during a fit), and the screen is kept awake where the browser allows it. The assistant's
`navigate` refuses to leave a page with a job running. For scale: the fresh N-body fit of the Kepler-88 example took
35 minutes in Node. `node test/companion.test.mjs` (9): the explorer's orbit positions (transit on the line of sight,
the conic radius at transit for e = 0.6, Kepler's second law to 7e-9), Kepler's third law in AU, the map's axes, and
the time-left estimate (a steady rate gives 60.0 s; after a speed-up it follows the recent rate, 118 s against 101 s,
where the whole-run average would say 881 s).

The companion explorer (Timing tab, Dynamics) draws what a companion search or an N-body fit found: Δχ² over period
ratio and mass with the posterior's companions on it, the system from above (animated; the posterior's orbits as a
cloud), and the O − C of the selected companion integrated with `src/core/nbody.js` together with curves from
posterior draws. On the Kepler-88 example it shows planet c at 0.672 +0.007 −0.006 M Jup and period ratio 2.0396; on
the simulated unseen-companion example, with planet c removed and the search run (7 s, 14 masses × 126 periods), the
best cell is 0.077 M Jup at 5.341 d against the injected 0.10 M Jup at 5.3436 d. It samples nothing itself.

### Observe: the sky

41,411 stars to V = 8 (XHIP through the d3-celestial data, BSD 3-Clause), constellation lines, Sun, Moon and
planets, an atmosphere that brightens through twilight, a ground that turns translucent when the view tips
below the horizon, azimuthal and equatorial grids, the 4,862 exoplanet host stars of the catalogue, and bright
satellites from CelesTrak propagated with SGP4 (`satellite.js`), and 5,137 TESS candidates (PC, APC) on 5,019
stars, drawn white with a dashed ring.
Time can be scrubbed, stepped and played; the place is typed or taken from the browser. On a phone an AR mode
follows the device orientation, with a calibration by pointing at a known object.

A host star's card gives its magnitudes, altitude and azimuth, how its planets were found, the soonest transit and
a link to SIMBAD (CfA mirror); the planets sit in a folded "Planets (n)" list, each planet its own fold (period,
radius, mass, discovery method, year and facility, its next transit, links to Analyze, Plan and Search).
Hosts are coloured by discovery method (Okabe–Ito: transit, radial velocity, imaging, microlensing, other, plus
TOI candidates), each with a letter on its label; a host found by several methods takes the colour of the method
that found most of its planets. The Filter panel (it replaced the legend, the Discovery panel and the Visible
button in 2026-11) counts the hosts of each kind above the horizon and toggles them; the Tonight panel lists what
is up now or during tonight's dark hours under the same filters, sorted by altitude, magnitude, transit tonight or
name. Per-method
counts equal a live archive query (planets: transit 4799, RV 1205, imaging 98, microlensing 294, other 74);
every one of the 64 filter combinations keeps a mixed system while any of its methods is on
(`test/discovery.test.mjs`, `test/visible.test.mjs`). A
search box finds planets, hosts, bright stars and solar-system bodies and marks the target; with a transit in
the address the card shows ingress, mid and egress with altitude and sky state, and "Play the night" runs
sunset to sunrise in 40 s with the target's track; eclipse and phase windows from the planner are named and
coloured as such. A Terrain layer draws the horizon from elevation tiles (Mapzen/Tilezen on AWS Open Data):
zoom 13 near the site down to zoom 7 at 300 km, Earth curvature, standard refraction (k = 0.13), the eye's
height above ground, and the site's stated elevation (Kitt Peak's rounded coordinates fall 60 m off the summit,
which made a 24° false horizon); tiles are cached in IndexedDB. Against an independent Python implementation
(WGS84 geodesics) on the same tiles: 0.021° rms at Kitt Peak, 0.020° at Mauna Kea; against tiles one zoom finer
0.036° and 0.028° rms. No published horizon profile was compared; buildings and trees are not in the data.

**Host markers, the Filter panel and paths (2026-11-16).** Each discovery method now has its own marker shape
as well as its colour (transit: a ring crossed by a bar; radial velocity: a ring; imaging: a square;
microlensing: a diamond; other: a triangle; TOI candidate: a dashed ring), drawn with a 1.7 px line and a dark rim
so that the Night theme's red-only filter keeps them apart. Before, hosts were drawn only down to V = 6.5 at a
100° field, which left 1 transit host against 159 radial-velocity hosts (transit hosts are faint Kepler and TESS
stars); the limit is now V = 10 at 100° (a magnitude deeper per factor 2.5 of zoom): 227 transit, 673 RV, 34
imaging, 2 other and 531 TOI-candidate markers in the same view (counted by `discoveryCounts()` on the page,
2026-11-17 04:00 UTC from 40° N 105° W, az 90°, alt 40°). Hosts without a magnitude (273 of the 284
microlensing hosts) count as V = 12, so they appear below a field of about 63°. Checked by eye in Dark and Night
at 1440 × 900 and 390 × 844 (headless Chromium, SwiftShader); not on a real phone or under a real red filter.
The Filter panel's host filter (`src/sky/hostFilter.js`, `test/hostfilter.test.mjs`, 17 checks) limits the stars
by magnitude, effective temperature, spectral class, distance, number of planets, transiting and transit
tonight, with stars lacking a value kept or left out. The values are baked into `public/sky/hosts.json` by
`tools/build_sky_data.py` (1.09 MB, was 0.88 MB) from the planet table snapshot (NASA Exoplanet Archive composite:
`st_teff`, `st_spectype`, `sy_dist`, `tran_flag`) and, for the 4,968 stars with TESS candidates only, from the TOI
table (`st_teff`, `st_dist`); the baked values equal those columns read independently in the test (0 differences
in Teff, distance, class or transit flag), and with a temperature filter set the page fetches no catalogue table
(network log, headless). An older hosts.json falls back on loading both tables (about 8 MB). Known
for 9,403 of 9,830 stars (Teff), 9,645 (distance), 9,436 (class); without the TOI table only 4,564 and 4,834. The
values the page builds equal the snapshot's raw columns for every host (4,565 Teff, 4,834 distances, 0
differences), and every limit, with unknowns in and out, equals a brute-force pass written out in the test (12
filters, 0 disagreements). Spectral class is the archive's spectral type, else Teff on the dwarf scale of Pecaut &
Mamajek (2013): 22 cases. A card's "Show path" draws the path of a satellite (its pass, ±10 or ±30 min, SGP4),
the Moon, a planet or one of eight bright asteroids: tonight across the sky with hourly ticks, or among the stars
over ±3 days to ±6 months with dated ticks. The asteroids are two-body orbits from bundled JPL SBDB elements
(`src/core/asteroids.js`); against JPL Horizons geocentric astrometric positions (`test/asteroids.test.mjs`,
reference from `test/make_asteroid_reference.py`, 8 asteroids × 5 dates): at most 56″ within 200 days of the
epoch (2026-06-09) and 138″ a year after (Hygiea; the others under 40″), distance within 0.11%, magnitude within
0.003 mag. The paths were checked by eye only (Vesta's retrograde loop, the Moon's ±15 days, Jupiter tonight, a
satellite pass); the planets' and Moon's positions are those of `astro.js`, checked above.

**Immersive mode (WebXR).** *VR* puts you inside the sky, *Passthrough* draws it over the camera image. Point a
controller at a star, planet or host and pull the trigger for its card; the thumbstick runs time (left/right, up
to 2 h/s) and the magnitude limit (up/down); grip and sweep turns the sky, or after B/Y scrubs time at 15° per
hour; A/X brings a menu (play the night, now, targets, tonight's transits, layers, discovery filter, compass,
exit). Hands work by pinch; without controllers a 1.3 s gaze presses. A headset has no compass: in passthrough
choose a bright object and "Point & set". The pointing, picking, menu and alignment maths are pure functions
(`src/sky/xrInput.js`, 39 checks in `test/xr.test.mjs`); `test/xr_check.py` drives the page against Meta's WebXR
emulator (iwer, emulated Quest 3): a controller aimed where `astro.js` puts Vega selects Vega, a 30° grip sweep
turns the sky 30.000°, a 15° scrub gives 60.000 min (49 checks). Not checked: any real headset or phone;
passthrough compositing, comfort, legibility, frame rate and haptics. Controller models load from jsdelivr; a
plain pointer is shown without them.

*Windows and exits in the headset.* The menu, the selection's card and a survey image (DSS2 colour from CDS
hips2fits, 5′ to 60′ across) are floating windows: hold the trigger, a pinch or a gaze-and-pinch on the title bar
to move one (the thumbstick then pushes it away or pulls it in), on the bottom-right corner to resize it, or grip
anywhere on it. The menu shows one tab at a time (Transits tonight, Visible, Show, Stars with planets, Compass),
0.49 m tall instead of about 1 m. The card adds "Turn to face it" (VR only) and "Survey image". Exits: "Exit VR" on
the menu's title bar and on the folded menu, B or Y held for 1 s (a countdown shows; a tap still switches the
grip), and the browser's own. A or X, or a hand's palm turned up and looked at for 0.5 s, brings the menu in front
of you (or folds it when it is already there). A pinch held and dragged on the sky turns it, as the grip does.
Vision Pro's gaze-and-pinch (`transient-pointer`) presses and drags; once one is seen the 1.3 s dwell is turned
off. Where a browser tracks hands but sends no select event, a pinch read from the joints (closes under 15 mm,
opens over 30 mm, and only if no select event comes within 250 ms) stands in. The geometry (a grabbed point stays
under the ray to 1e-14 in u, v and metres over a 48° sweep; a resize keeps the top-left corner and the aspect), the hit zones, the
tabs and the gesture state machines are pure functions in `src/sky/xrPanel.js` with 31 checks on synthetic poses
in `test/xrpanel.test.mjs`. The emulator run adds: title-bar drag (the grabbed point stays at u 0.3000), corner
resize (0.840 → 1.040 m for a 0.2 m drag, top-left fixed to 0.00 mm), grip-move of a window, tabs, the folded
menu, "Turn to face it" (to 0.001°) and Y held to leave passthrough. Not checked: the survey image against the
live CDS server (unreachable when this was run; a stand-in image is drawn instead), the joint pinch, palm up and
`transient-pointer` input on any device (iwer emulates Quest controllers and hands only), Cardboard-style gaze
selects, and how the windows feel to move and read in a real headset.

Accuracy of `src/core/astro.js` against astropy/ERFA with DE432s (`test/astro.test.mjs`, 65 instants 1975 to
2050, five sites): sidereal time 0.3″, star altitude and azimuth 25″ (annual aberration is not modelled), Sun
33″, Moon 12″, Mercury to Mars under 3′, Jupiter 8′ and Saturn 10′ (the limit of Standish's Keplerian elements),
refraction 6″ above 10°; twilight times 1.0 s, rise and set 5.4 s. The ISS from the page agreed with
python-sgp4 + astropy to 0.003°. The example planner link puts HAT-P-32 at altitude 64.086° (astropy 64.080°).

**Survey image of a field.** A star or host card's "Survey image" button (or the chip offered below 2° field of
view) opens a real image of the field: DSS2 colour or red, 2MASS, Pan-STARRS DR1, SDSS DR9, DESI Legacy DR10 or
AllWISE HiPS tiles, resampled by the page onto a TAN plane about the target (512 px images, 5′ to 60′ wide, N/S/E/W
add neighbouring images on the same plane, up to 4 × 4). Gaia DR3 stars from VizieR are overlaid with G, BP−RP,
distance, position angle and ΔG from the target; stars within a chosen ΔG range, not variable and beyond 10″ are
marked as possible comparison stars, optionally only inside a detector outline (arcmin, or pixel scale × pixels,
turned by an angle). Drag measures separation and position angle; a scale bar and N/E arrows follow the zoom.
`src/core/healpix.js` and `src/core/skyfield.js` (`test/skyfield.test.mjs`, 26 checks): HEALPix nested pixels
against the analytic properties of Górski et al. (2005) (base-pixel centres exact; centre → pixel round trip for
all 65,532 pixels of orders 0 to 6 and 20,000 random pixels at orders 12 to 25; ring latitudes and counts at orders
1, 3, 5; parent = pixel / 4; χ² = 197 for 191 degrees of freedom over the 192 pixels of order 2 with 768,000
uniform directions); cell pixel ↔ sky against astropy.wcs for six fields including RA wrap, 0.7° from the pole and
−80° (2.3e−10″ and 9e−11 px); separation and position angle against SkyCoord for 60 pairs from 0.5″ to 170°
(1.4e−11″, 3e−13°). The layout of pixels inside a HiPS tile (column = iy, row = ix in the face, south corner top
left) is not in the code's own tests: it was found and is checked by `test/survey_check.py` (browser, network),
which compares the page's resampled DSS2 red image with NASA SkyView's DSS2 Red image of the same field and
centroids the Gaia stars 12 < G < 16 on it. 2026-11-16, tiles from IRSA, 1.76″ pixels: HAT-P-32 correlation 0.888
(0.440 when shifted 3 px), Gaia offsets median 0.62″ (90%: 1.21″, 133 stars); WASP-12 0.940, 0.74″; Polaris
(0.7° from the pole) 0.805, 0.66″; WASP-46 (dec −56°) 0.852, 0.99″. The other seven of the eight possible layouts
correlate at 0.03 to 0.06. That day CDS (alasky, alaskybis) answered HTTP 404 or nothing for hips2fits, HiPS tiles
and its VizieR mirror, so Pan-STARRS and Legacy Surveys (CDS-only) could not be shown and the hips2fits fallback
(the same WCS passed as its `wcs` parameter) is unverified; IRSA and ESAC tiles and the CfA VizieR mirror send
`Access-Control-Allow-Origin: *`. Rubin/LSST: the only HiPS found in the CDS registry is "Rubin First Look"
(two press-release fields, 29 deg², 0.07% of the sky), not survey data, so it is not offered. Driven headlessly
at 1440 × 900 and 390 × 844 (touch: tap a star, measure, extend east); not on a real phone.

Not tested: AR on a real phone, pinch zoom, the geolocation prompt. Local times on the sky page are the browser's zone, the
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

The search also tries an inverse-variance weighted comparison ensemble (three-cornered hat on the pairwise flux
ratios), and the page offers detrending regressors, PLD and kernel regression for the analyzer ("Decorrelation
for the analyzer"), and writes the AAVSO Exoplanet Watch report in EXOTIC's format (three reports identical to
EXOTIC 4.3.1's, character for character, apart from the software line; `test/aavso.test.mjs`).

Checks (`fits` 89, `photometry` 53, `imexam` 37, `lcfits` 10, `gp` 9, `psd` 36, `exotic_photometry` 26, `detrend` 26, `aavso` 8): tile-compressed files
bit-identical to astropy; aperture sums 4e-16 and elliptical apertures 1e-15 against photutils; centroids
1.4e-14 px; UTC to BJD_TDB 0.05 s; GP 1e-13; periodogram and Welch PSD 1e-13 against scipy; rms-vs-bin 7e-15
against mc3.

EXOTIC's own sample data (HAT-P-32 b, 142 MicroObservatory frames), EXOTIC run through its `main()`:

| | EXOTIC 4.3.1 | This code |
| --- | --- | --- |
| Choice | aperture 4.44 px, annulus 7.15 px, no comparison star | aperture 3.71 px, annulus 10.73 px, both comparison stars summed |
| Residual scatter | 0.573% | 0.496% (0.540% with no comparison star; 0.487% with the weighted ensemble) |
| Rp/R★ (same χ² fit of each curve) | 0.1562 ± 0.0034 | 0.1452 ± 0.0032 (0.1525 with no comparison star) |
| T mid − 2458107 | 0.71359 ± 0.00108 | 0.71311 ± 0.00106 |
| Search | about 30 s for 1,142 fits | 9.1 s for 1,532 fits, 5 s to measure the frames |

BJD within 0.014 s and airmass identical; at EXOTIC's centroids, radii and sky 720 aperture sums agree to
7.9e-7. At EXOTIC's own aperture cell this code is worse (0.599% against 0.573%) and the reason was not found.
PSF photometry loses on these undersampled stars in both codes. The 2.3σ gap in Rp/R★ is mostly the choice of
comparison star. Behaviour in EXOTIC that looks wrong (not changed there): the centroid is a flux-weighted mean
of a 31 × 31 box with the sky left in (1.5 px from its own Gaussian fit); the least-squares mode minimises the
fourth power of the residuals; the sky is the mode of a box that includes the star. Not implemented here: plate
solving and VSX/VSP queries (EXOTIC uses nova.astrometry.net with a key), EXOTIC's rejection of darks above 1.7 ×
the median, scaling darks by exposure time. Calibration frames are combined by pixel median and applied as
(frame − bias − dark) / flat.

**Inspecting images** (`src/core/imexam.js`, `src/photometry/inspect.js`): a tool bar above the image switches between
picking stars and five tools in the manner of IRAF's imexam and DS9. *Profile* (click a star): radial profile with
Gaussian and Moffat fits to every pixel, half-flux diameter, curve of growth, elongation, peak as a fraction of
saturation (SATURATE/DATAMAX or the integer format), sky and its noise, signal to noise, a 5 × 5 pixel table, and
buttons to make the star the target or a comparison. *Cut* (drag a line) and *Region* (drag a box: mean, median,
standard deviation, 3σ-clipped values). *Focus*: every unsaturated, isolated star fitted with a rotated Gaussian;
ellipses coloured by FWHM and elongation bars on the image; a cell map with the median FWHM per cell; a verdict on
curvature (corners against centre), tilt (corners against each other) and tracking (all stars stretched the same
way), and the sharpest point of a quadratic FWHM surface. *Header*: the FITS cards with a filter. "Suggest
comparisons" now ranks every detected star (brightness match, saturation, neighbours, edge, a profile wider than
the others or elongated) and lists the runners-up with their reasons. Once frames are open, the loading cards fold
into one line. The assistant has `photometry_examine_star` and `photometry_focus_map`. The analyzer also opens FITS
light-curve tables (TESS, Kepler, K2: PDCSAP or the first corrected flux, quality-flagged cadences left out).

Checks (`imexam` 37, `lcfits` 10): binned profiles and curves of growth equal photutils `RadialProfile` /
`CurveOfGrowth` to 6e-15 on six stars of the HAT-P-32 b frame; the binned Gaussian FWHM equals photutils'
`gaussian_fwhm` (0.000%), the Moffat FWHM scipy `curve_fit` (0.33%); region statistics equal astropy
`sigma_clipped_stats` to 1e-14. On synthetic stars: the Gaussian FWHM of a pixel-integrated Gaussian 0.00% from
2.3548 √(σ² + 1/12), the half-flux diameter 0.94% from it, a Moffat star's FWHM 0.37% and β 2.75 against 2.70,
major-axis angles to 0.001° and ellipticity to 0.005. On synthetic fields of 70 to 80 stars: cell FWHMs within
1.2%, curvature 25.4% against 25.7% true, the sharpest point within 1 px of the centre, a tilt of 31% with the
right worst corner, trailed stars at 59.9° against 60°, and an evenly focused field called even.

The 2-D shape (`psfMoments`): the centroid, second moments and coma vector of Gaussian mixtures equal their analytic
values to 4e-14; with the Gaussian weight, an elongated star's moments equal (S⁻¹ + I/σ_w²)⁻¹ to 7e-7 and a round
star has no coma; a core with a tail toward 120° gives a coma toward 118.8°; the 180° asymmetry is 0.0018 for a
symmetric star (bilinear rotation gave 0.013, hence cubic convolution) and 0.0621 against 0.0620 from the analytic
rotated image. Focus map additions on synthetic fields: a tip/tilt plane of 45.4% toward 0.5° against 45.1% toward
0°; with S/N ≥ 150, 28 of 68 stars measured and the other 40 reported as faint; a clipped star in a float frame
without SATURATE rejected as saturated; tails toward 210° on every star found as a field-wide coma toward 209.7°
(coherence 1.00, median 0.40, round stars 0.043). On the first HAT-P-32 b frame of EXOTIC's sample (MicroObservatory,
cut to the field around the three stars) the map measures 13 of 68 detected stars at S/N ≥ 30 (54 fainter, 1
crowded): median FWHM 2.38 px, elongation 43.6%, 87% in one direction, which is the trailing the frames show by eye;
their coma (0.50) is far above the 0.04 of round stars, as uneven trailing gives. The noise floors (0.04 coma, 0.03
asymmetry) and the verdict thresholds come from synthetic fields only; no measured optical system has been compared.
Without a gain the signal to noise is the sky-limited F / sqrt(n σ²), labelled so, instead of assuming 1 e⁻/count;
with one the photon term is exactly F / g (1/S/N² − 1/S/N_sky² = 1/(F g) to 7e-16). FITS tables written by astropy
in the SPOC and Kepler layouts (one gzipped) are read to 1e-6 d and 1e-9 in relative error with the flagged and
blank rows left out.

**Sky coordinates, target by name, Gaia comparison stars, optimal apertures** (`src/core/platesolve.js`,
`src/core/fieldstars.js`, `optimalAperture` / `gainFromSky` in `src/core/imexam.js`, `src/photometry/wcs.js`). The
Field card solves the first frame against Gaia DR3 (VizieR, CORS) by triangle matching and a least-squares TAN /
TAN-SIP fit, places the target from its name (site catalogue, then CDS Sesame through the VizieR mirror, which answers
with CORS), ranks comparison stars with Gaia G, BP−RP, Gaia and VSX variability and faint neighbours, and centres the
aperture search on the target's SNR-optimal radius. nova.astrometry.net was checked on 2026-11-16 with an Origin
header: `api/login` (OPTIONS and POST) and `api/jobs` send no Access-Control-Allow-Origin, so the page links to it
and loads the wcs.fits it returns instead of calling it. Checks (`platesolve` 37, `test/make_platesolve_reference.py`
with astropy 6.0.1 and photutils 1.11): the WCS fit equals astropy's `fit_wcs_from_points` on the same lists to
1e-7 px (TAN), 3e-6 px (TAN, Dec 78°, 0.15 px noise) and 0.010 px (SIP order 2, 0.1 px noise); exact positions give
the true WCS to 1e-5″; header round trips through `readWcs` exact; 24 / 24 synthetic fields solved (random rotation
and mirror, 3% scale error, pointing off by up to 40% of the field, 25% of stars missing, 15% spurious, SIP in a
quarter) within 0.1 px of a fit to the true pairs, slowest 82 ms; random stars against an unrelated catalogue: no
solution claimed. EXOTIC's HAT-P-32 b frame (5.2″/px, 152 × 166 px, Gaia G < 17 saved offline): 57 of 71 stars
matched, rms 0.74″ (0.14 px), 5.163″/px, mirrored, north 179.6° from +y, from the catalogue position, from the header
pointing 15′ away and with no scale at all (1–20″/px, 0.5 s); the independent astropy solution (DAOStarFinder,
brute-force match, 69 stars, rms 1.63″) differs by at most 1.13″ (0.22 px) over the frame and puts HAT-P-32 0.06 px
from here. Frames 21 and 48 solved on their own agree with frame 1's WCS carried by the tracking transform to 1.0″.
The re-centring by a Gaussian fit matters: with the detection's box centroids the rms was 2.49″. The optimal radius
matches the analytic maximum to 2% (0.682 FWHM for a faint star, 1.45 FWHM for a bright one); the gain bound from the
sky is 2.484 e⁻/ADU against 2.489. Found on the way: one of the two comparison stars of the HAT-P-32 b demo
(full-frame pixel 465, 183) is HAT-125-0001606, a BY Draconis variable in VSX (0.02 mag in V) and 0.96 mag redder in
BP−RP than the target; the other ranks first here. HAT-P-32 itself carries Gaia's VARIABLE flag (its transits). Also
changed: the image-only ranking marked every star of these frames "elongated" (all have e ≈ 0.43 at 155°); a star
now counts as elongated only beyond the field's median by 0.15. Headless Chromium against live VizieR
(`test/platesolve_check.py`, built copy on :8971, `?demo=3&inspect`): "Solve WCS" matched 53 stars, rms 0.65″ (3000
Gaia stars to G 19.5 fetched); HAT-P-32 placed 0.08 px from the demo's centroid; RA / Dec in the hover readout; "Use
as target", "Rank with Gaia" (18 usable of 70; 3 variables set aside, 61 VSX entries), "Add the best" 3, "Set
apertures" (T 1.94 px = 1.89 σ with the gain bounded at 263 e⁻/ADU from the sky; search 0.9–3.9 σ); the four
assistant tools; frame 31's WCS through the tracking transform within 0.06 px of the star; at 390 px every control of
the card 40 px or more; no page errors. Not verified: a frame with a header SIP WCS or an astrometry.net wcs.fits
loaded through the button (`wcsFromHeader` is tested on headers written here), the six-step scale search against
live VizieR (offline only), fields with fewer than about 20 stars, and whether the narrower aperture range changes the
HAT-P-32 b reduction (not rerun).

**TESS, Kepler and K2 pixels and light curves** (`src/photometry/mast.js`, `src/core/lcprep.js`, `src/core/k2.js`,
`src/photometry/prep.js`, `src/photometry/series.js`). "Find files" lists every product the public bucket holds for a
star (TIC, KIC, EPIC, TOI or a catalogue name): SPOC 2-minute and 20-second light curves and TPFs, TESS-SPOC and QLP
products of the full-frame images (HLSP folders of the bucket, which also answer with CORS), Kepler and K2 long and
short cadence. A picker chooses the sectors, light curves or pixels, the cadence (shortest, longest, 20 s, 2 min,
FFI) and the pipelines; one product per sector is loaded (the owner's `cadence_policy`), each sector over its own
median, stitched. Several light-curve files or TPFs dropped on the page (or in a zip) are stitched the same way.
The quality mask is now lightkurve's 'default' (TESS 17087, Kepler/K2 1130799) for every mission; before, TESS and
Kepler pixels dropped any flagged cadence. "Prepare for transit fitting" ports the owner's TOI-1873 extraction
(EXOTIC `examples/toi-3planet/toi1873_extract.py`): known planets from the catalogue and TOIs from the TOI table (or
typed) are masked (±1.5 T14/2), each sector is flattened with wotan's time-windowed biweight (window typed, or chosen
by EXOTIC's injection test), outliers beyond 4σ of a 30-minute smooth are clipped (never in transit), 30 minutes after
gaps are trimmed, and ±2.5 T14 windows are cut around every transit, another planet's transit in a window flagged
and divided out. The windows (or the whole flattened curve) go to the analyzer as one BJD_TDB light curve; per-transit
CSVs save as a zip. For K2 pixels: pixel-level decorrelation in the EVEREST / lightkurve PLDCorrector form (third
order, 16 principal components per order, background components, a degree-5 spline, 5σ clipping) and thruster-firing
flags from QUALITY and from centroid jumps along the roll.

Checks against lightkurve 2.6 (`.venv-lk`, `test/make_lightkurve_reference.py`) on the WASP-18 TESS, TrES-2 Kepler
and K2-3 K2 pixel files (`tpf_lightkurve` 21): every quality preset keeps the same cadences (TESS 700/685/685/685,
Kepler 476/473/436/433, K2 1200/1042/1035/986 for none/default/hard/hardest); times as BJD_TDB identical (0 µs);
pipeline-aperture flux 3.1e-7, error 1.5e-7, background 3.6e-7 and centroids 3e-7 of the CCD coordinate (lightkurve
sums the float32 pixels in float32); the SPOC / Kepler SAP_FLUX of the light-curve files to 9.8e-8 (TESS), 8.9e-8
(Kepler), 1.2e-7 (K2); 3σ threshold masks identical; CDPP to 4e-5. Found on the way: the TIME column of a SPOC
light-curve file differs from its TPF's by 20 µs; lightkurve's CDPP of a float32 light curve is off by 0.14% for a
quiet star (11.610 against 11.626 ppm on TrES-2) because its running mean is a float32 cumulative sum.
`lcprep` 23 (`test/make_lcprep_reference.py`, wotan 2.1 and the EXOTIC functions copied verbatim): biweight trend
to 1.9e-9 with and without masks, edge cut-off and break tolerance; T14, transit mask, clip, post-gap trim and
binning exactly; window injection 7e-7; alias scan exactly; lightkurve flatten 5e-12 and CDPP 1e-8; on TrES-2's own
pixels the masked trend 2.4e-7 and the depth 13184 ppm in both. `k2` 11, K2-3 campaign 1 (CDPP at 6.5 h; a committed
10 × 10 px crop of 1,200 cadences, and the whole 17 MB file when present): raw SAP 5822 ppm, self-flat-field 326
(lightkurve SFFCorrector 158), PLD order 3 40.2 (lightkurve PLDCorrector 48.0, whose randomized PCA gives 32.8 or
33.3 on the crop where this gives 25.8), the pipeline's PDCSAP 186; the PLD light curve follows lightkurve's to 18
ppm per point against 62 ppm of scatter; centroid jumps find 154 of the 172 cadences QUALITY flags as thruster
firings (38 of 39 on the crop). `mast` 3 (+2 live with `ESL_NET=1`: TOI-1873 has 80 products in 16 sectors), `prep` 8.
Headless Chromium against the bucket (`test/photometry_archive_check.py`): TOI-1873 listed in 5 s, sectors 20
(2 min), 26 (TESS-SPOC 30 min) and 40 (20 s) stitched, b, .01 and .02 found, 11 windows (overlaps of b with
.01 and .02 flagged), handed to the analyzer, which loads 12,938 points in BJD_TDB; a TESS-SPOC FFI TPF reduced and prepared;
the K2-3 TPF fetched and decorrelated on the page (CDPP 273 → 45 ppm of the best aperture). Not verified: the
self-flat-field's shortfall against lightkurve on the whole campaign (reason not found); dropping the unflagged
thruster firings did not lower K2-3's CDPP; mixed cadences reach the analyzer with one exposure time; the analyzer
does not yet read the per-row window index of the hand-off (use "Split by orbit").

**Zips** (`src/core/zip.js`): `.zip` files through the file picker, drag-and-drop and the folder picker, with frames
or whole folder trees (calibration subfolders recognised by name), nested zips and `.fits.gz` inside, stored or
deflated, ZIP64. No library: the central directory is read and a deflated entry becomes a lazy slice of the archive
wrapped as a gzip member (header + raw DEFLATE + CRC-32 + size), so nothing is inflated until a frame is read.
Checks (`zip` 16): every entry of a zipfile-written archive (`test/make_zip_reference.py`) inflates to the same MD5,
ZIP64 records read, a wrong CRC caught, all 14 FITS files open through the page's own readers; EXOTIC's sample-data
zip (24 MB, read only) lists as zipfile does and its 142 headers are read lazily in 0.07 s; in Chromium the same zip
through the file input gives 142 frames in time order, and a zip dropped as a synthetic drop event loads.

Not verified: the live view mid-run, the export buttons and the hand-off by clicking, the folder picker and real
drag-and-drop (a synthetic drop event was), a file written by `fpack`. The cut-out demo of the sample
frames lives in `test/data/` (the sample data states no licence) and works on the dev server only.

### Spectroscopy

`/analyze/spectroscopy/` reads JWST `x1dints.fits` (both pipeline layouts; segments joined in time, detectors in
wavelength) and CSV/ECSV tables of flux against time and wavelength, or simulates an Ariel or JWST observation of
a catalogue planet. Outliers are clipped in time per wavelength, spectra are binned (constant R, constant width,
N bins, columns per bin), the white light curve is fitted for mid-time and inclination, and every channel for its
depth with that geometry and limb darkening for its wavelength range; the baseline (level, slope, curvature,
steps) is integrated out analytically. Outputs: the spectrum (PNG, CSV, ECSV), per-channel rms against the error
bars, the binned-rms test, a session file. JWST and Ariel modes are also in the analyzer's band menu.

Checks (`test/spectroscopy.test.mjs`, 44): readers against astropy, exact; the regressor marginal likelihood
against `scipy.integrate.tplquad` to 9.4e-5 in ln L; injected spectra recovered with pulls of mean 0.08 and
standard deviation 0.98 over 228 simulated Ariel channels (0.47 and 0.98 over 36 channels made with batman). Real
data, WASP-39 b with NIRSpec G395H (ERS 1366): the mirror-tilt step found automatically; white-light depth
21324 ± 13 ppm; 56 channels at R = 100 follow the published spectrum (Alderson et al. 2023) with correlation 0.974
and 91 ppm scatter, but lie **202 ppm lower on average, unexplained**. Not included: spectral extraction from
images, HST/WFC3, measured throughputs (all bands are top-hats, limits from the mission documents), limb
darkening beyond 5.5 µm (extrapolated and flagged), NIRSpec PRISM comparison. The simulator is a simple
radiometric estimate, not ArielRad or PandExo; since 2026-11-20 its Ariel numbers are ArielRad's published ones
(see "Ariel's noise in the simulator" under Atmosphere), while JWST keeps one editable throughput and floor. The
real-data test needs 207 MB of public files in `test/data/jwst/` and is skipped without them.

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
`tools/README.md`): 8,563 planets with provenance, gap-filling estimates with their relations, and suggested
priors for 8,556 of them; 2.0 MB gzipped, with checksums and licences in its manifest. TOIs are left out. Only
the `--no-download` path has been run.

The planner lists transits, eclipses, phase-curve windows and custom phase windows for a site and
date range, scored and sorted together: score with a miniature of the region of interest's coverage, planet with
an event badge, start–mid–end (the time zone named once), an altitude sparkline bold over the window, dark time
before and after with the verdict (observable, short baseline, partial), and a sky-view link; timing uncertainty, the Moon and the orbit are in the expanded row.
"Observable" means the whole region of interest (1 h of baseline, widened by 1σ of the predicted time) is above
30° with the Sun below −18° and, optionally, above the terrain horizon. Eclipse times use e and ω (against
batman's `get_t_secondary` for 240 orbits up to e = 0.9: 0.00002 s; durations within 0.28% for e ≤ 0.3); without
a catalogued e the orbit is taken as circular and the row says "e?". Defaults: 7 nights, depth ≥ 2 ppt, V ≤ 13,
TESS candidates on (labelled as candidates). With the old defaults (3 nights, ≥ 5 ppt, no TOIs) Kitt Peak had 11
observable transits in the week of 2026-11-15; now 139, 118 of them TOIs (`test/plan_targets.test.mjs`). A
discovery-method filter says which planets have transit windows at all (28 RV-found planets do). A globe shows
89 observatories (astropy's registry and MPC codes, `tools/build_observatories.py`) with the terminator; a
crawler (`tools/crawl_observatories.py`, robots.txt obeyed, 2 s per host) found archive, weather or all-sky
links for 43 of them, and two all-sky images are embedded (Kitt Peak, La Silla), the only ones whose
organisation's terms page states a Creative Commons licence; whether those general terms cover the camera
hosts is the owner's call. Tabs give the ephemeris behind every row (with a CSV) and a grid of altitude charts.

`src/core/observability.js` against astropy (`test/observability.test.mjs`): altitude and azimuth 0.01°,
twilight times 6 s, BJD conversion 4 s. Against the Swarthmore transit finder for Kitt Peak and one week: all
32 of its events are found, mid-times within 0.7 min, elevations within 0.5°; with the finder's limits 14 are
observable over the whole region of interest, 17 are complete with a short baseline and 1 is partial.

The score (`scoreTransit`): coverage 40, baseline 15, altitude 20 by mean airmass from the limit to the zenith,
signal 20 from the expected S/N (depth, host magnitude and duration, a small-telescope noise model, log scale from
S/N 5 to 200; half marks without a depth or magnitude and for eclipses and phase windows), Moon 5. Checked against
the weights worked by hand for two events, and for its ordering: a higher path, a deeper transit and a brighter host
each score higher (`test/observability.test.mjs`). A hot Jupiter of 15 ppt on a V 10 star lasting 3 h has S/N 226
(full signal marks); 2 ppt on V 12 for 2 h has S/N 10.7. The noise model has not been compared with any telescope's
measured precision.

In 61 planets the archive's best-timed ephemeris has another planet's period (rows from ExoFOP attached to a
sibling: HD 106315 c 1221 d instead of 21.06 d); a paired ephemeris more than 1% from the composite period is now
ignored in `src/core/sources/nea.js` and `tools/build_catalog_table.py`.

Search's "T unc. now" is σ(T_N) = sqrt(σ_T0² + (N σ_P)²) for the transit nearest today (N rounded), the errors
the mean of + and −, P and T0 from one solution (`timingSigma` in `src/core/sources/index.js`; recomputed by hand
on 5,037 best-timed archive pairs in `test/sources.test.mjs`, worst difference 4e-16). The huge KOI values were
exoplanet.eu's: 117 of its epoch errors carry the Kepler offset (2454833 ± 0.0283 for ± 0.0283 d; KOI-5372 b went
from 3.5 × 10⁹ min to 630 min, which the archive's KOI table also gives). That offset is now taken off; 16 eu
epochs that are not JD and 25 period errors larger than the period are not used. Some KOIs stay large because
exoplanet.eu's period error is (KOI-6256 b: ± 0.509 d against the KOI table's ± 0.00016 d, so 230 d instead of
about 104 min). Search has an Ephemeris choice (NASA best-timed, archive default, exoplanet.eu); exoplanet.eu's
must pass the 1% period rule against the archive, and the 834 planets without a usable one show the best-timed
pair marked †. Planet radius and mass are Jupiter units in every catalogue (median NEA/eu ratio 1.0000 over 4,897
and 3,153 pairs) and shown in R⊕/M⊕ or R_J/M_J by the Planet units switch; about 11 eu radii look like Earth radii
entered as Jupiter ones (Kepler-289 e 3.20 against 0.262). The Plan page's Ephemeris menu still offers only the
two archive choices.

Caveats: choosing the ephemeris by its quoted errors favours papers with optimistic errors (of 4,312 planets
with both, 3,044 use a different reference than the archive's default, which predicts 4.3 times less precisely
at the median); altitudes ignore refraction; exoplanet.eu has 27
positions more than 0.25° from the archive's; many crawler seeds were
typed from memory and failed, so 46 observatories have no links. `astro.js` and `observability.js` overlap
(Sun, Moon, alt-az) and should be merged. Pinch on the globe and every phone layout were checked only headlessly.

### Methods and validation

The Methods page (`methods/`; Markdown copy `docs/METHODS.md`, built by `tools/build_methods_md.mjs` from
`src/methods/content.js`) has five tabs: the methods (21 techniques, each with its equations, parametrisation and
priors, numerical method and measured accuracy, limits and references), the validation below, a reproducibility
table for every example and comparison (including what is *not* reproduced), one bibliography of 98 entries
checked against Crossref, and how to cite (`CITATION.cff`, `docs/references.bib`).


`tools/validation/*.py` run batman, PyTransit, exoplanet-core, PyAstronomy, ellc, pylightcurve, EXOTIC,
pyaneti, radvel, emcee, dynesty and UltraNest (recipe in `validation/README.md`) and store their outputs in
`public/validation/`. The page recomputes this code's side in the browser, and `test/validation.test.mjs`
asserts the same tolerances (`validation/README.md` has the recipe). The reference is Kepler's equation in 30-digit arithmetic plus scipy quadrature of
the flux integral. The page reads in about nine minutes: a short version, where this code is weaker, where
another code is the outlier, four comparisons with one chart each, the project's other tests (stored by
`tools/validation/project_reference.mjs` in `public/validation/project.json`, including phase curves, exomoons
and N-body), how to reproduce it, and what is untested. Stored test output now records failures the run did not
flag (`SILENT`): the full stress suite passes 44 of 47 problems on its seed; the 20-D ρ = 0.999 Gaussian stops at
its budget (flagged), the 5-D banana's widths are 23% off (flagged), and the 8-D narrow peak is 0.80 high (2.2σ,
not flagged; over 32 seeds 0.085 ± 0.076). The page lists all three.

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
times slower than batman and PyTransit; the sampler's evidence for a funnel-shaped posterior is −0.045 ± 0.026
over 48 seeds since the ellipsoid check (−0.24 ± 0.05 before). Automatic exposure averaging now leaves at most 0.7 ppm (it was 18 ppm
for a hot Jupiter at 2 and 30 minute cadence). The 30-digit orbit gives 0.08337 d for HD 80606 b's eclipse
duration, as here; the published 0.0717 d is reproduced by no method tried.

## Calculations changed after the second audit (2026-11-16)

- Mid-eclipse and periastron epochs (third review, same day): each posterior draw used to take the eclipse nearest
  the transit, so when e cos ω straddled 0 some draws gave tmid − P/2 and others tmid + P/2, and the periastron
  flipped between tmid and tmid − P near ω = 90°. On HD 189733 b-like draws (e = 0.01, ω 70–110°) the eclipse
  midpoint read 1.4045 +0.0033 −2.2122 d. An eclipse more than 0.4 P from the transit is now taken after it, and
  both epochs are summarised about their circular mean with period P (`summarizeEpoch` in `src/core/derive.js`):
  1.4093 +0.0033 −0.0034 d against tmid + P/2 + (2P/π) e cos ω = 1.4093 (`test/audit.test.mjs`). HD 80606 b keeps
  its published eclipse before the transit. The system table no longer lists a periastron epoch for circular orbits,
  and flags TSM for planets of 10 R⊕ or more (outside Kempton et al.'s scale factors).
- Sampler: the wrapping ellipsoid is now tested against the likelihood during the run. A fifth of the region
  proposals come from the MLFriends balls alone (2/ndim above ten dimensions); a point accepted outside the
  ellipsoid enlarges it for the rest of the run. Before, the ellipsoid cut the wide end off funnel-shaped
  contours and the insertion-order test could not see it: ln Z −0.24 ± 0.05 (4-D funnel, 32 seeds) and
  −0.34 ± 0.07 (10-D); now −0.045 ± 0.026 (48 seeds, 33,000 calls instead of 164,000) and −0.06 ± 0.07. Region
  sampling costs up to 25% more calls elsewhere; every stored example was regenerated.
- Several planets with their own light: flux = product of the transits + sum of the planets' fluxes (the product
  counted the star twice; up to 8 ppm in the test case).
- Mid-eclipse times are delayed by the light-travel time when `phase.ltt` is set (49.9 s at 0.05 au, 169 s for
  HD 80606 b); off by default.
- BIC with a free jitter uses −2 ln L (χ² + Σ ln(1 + jitter²/σ²)) instead of χ², which rewarded inflated errors.
- Eccentricity can be sampled as √e cos ω, √e sin ω (Fit tab toggle). ω is summarised about its circular mean
  (175 ± 6°, not 172 +5 −346, for a posterior across ±180°).
- Derived quantities use 4,000 posterior draws and, when Kepler's law or RVs are on with M★ and R★ held, draws of
  M★ and R★ from their stated errors. New rows: orbit-averaged insolation, T_eq at periastron and apastron,
  eclipse delay, surface gravity (9.19 m/s² for HD 209458 b from P, K, a/R★, k, i alone; 9.28 ± 0.15 in Southworth
  et al. 2007), Hill radius, Roche limit, TSM and ESM (Kempton et al. 2018; ESM of GJ 1132 b 7.49 against 7.5;
  TSM needs a J magnitude, which the catalogue snapshot lacks).
- Reduced χ² uses N − k with the integrated-out normalisations counted. The comparison cites Trotta (2008) for
  its 2.5/5 scale.
- Constants are one documented set: IAU 2015 B3 nominal values, IAU 2012 au, CODATA 2018 G, equatorial radii.
- Light-curve times in JD_UTC/HJD_UTC/BJD_UTC are converted to BJD_TDB (before: read as BJD_TDB, up to 73 s off).
- The archive's best-timed ephemeris is ignored when its period is another planet's (61 planets).
- Checked and unchanged: K uses Mp/(M★ + Mp); the marginalised baseline, regressor and zero-point terms carry
  their prior widths; Kipping's q1, q2 mapping. Still open: the HD 80606 b eclipse duration (0.0835 d contacts
  1–4, 0.0682 d 2–3, 0.0759 d centre on the limb, none the published 0.0717 d). All in `test/audit.test.mjs`
  (19 checks). (The light-curve jitter and the Rossiter–McLaughlin model listed here as open have since been added:
  "Light-curve jitter and dilution" and "Rossiter–McLaughlin effect".)

## Calculations changed after the first audit (2026-11-15)

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
