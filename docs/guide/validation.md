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
6 PLD components: 1-hour scatter 186.6 → 150.7 ppm. A fit with the kernel has an evidence that is not comparable
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

Page checks without the interactive browser: `.venv/bin/python tools/shot.py '<path>' out.png [w h] --wait ms
--eval "<js>"` takes a headless screenshot and prints console errors.

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
that found most of its planets. An always-visible legend counts the hosts of each kind above the horizon and
toggles them; the "Visible" panel lists what is up now or during tonight's dark hours, filtered by kind,
altitude, magnitude and number of planets, sorted by altitude, magnitude, transit tonight or name. Per-method
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

**Immersive mode (WebXR).** *VR* puts you inside the sky, *Passthrough* draws it over the camera image. Point a
controller at a star, planet or host and pull the trigger for its card; the thumbstick runs time (left/right, up
to 2 h/s) and the magnitude limit (up/down); grip and sweep turns the sky, or after B/Y scrubs time at 15° per
hour; A/X brings a menu (play the night, now, targets, tonight's transits, layers, discovery filter, compass,
exit). Hands work by pinch; without controllers a 1.3 s gaze presses. A headset has no compass: in passthrough
choose a bright object and "Point & set". The pointing, picking, menu and alignment maths are pure functions
(`src/sky/xrInput.js`, 39 checks in `test/xr.test.mjs`); `test/xr_check.py` drives the page against Meta's WebXR
emulator (iwer, emulated Quest 3): a controller aimed where `astro.js` puts Vega selects Vega, a 30° grip sweep
turns the sky 30.000°, a 15° scrub gives 60.000 min (38 checks). Not checked: any real headset or phone;
passthrough compositing, comfort, legibility, frame rate and haptics. Controller models load from jsdelivr; a
plain pointer is shown without them.

Accuracy of `src/core/astro.js` against astropy/ERFA with DE432s (`test/astro.test.mjs`, 65 instants 1975 to
2050, five sites): sidereal time 0.3″, star altitude and azimuth 25″ (annual aberration is not modelled), Sun
33″, Moon 12″, Mercury to Mars under 3′, Jupiter 8′ and Saturn 10′ (the limit of Standish's Keplerian elements),
refraction 6″ above 10°; twilight times 1.0 s, rise and set 5.4 s. The ISS from the page agreed with
python-sgp4 + astropy to 0.003°. The example planner link puts HAT-P-32 at altitude 64.086° (astropy 64.080°).

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

Checks (`fits` 89, `photometry` 53, `imexam` 26, `lcfits` 10, `gp` 9, `psd` 36, `exotic_photometry` 26, `detrend` 25, `aavso` 8): tile-compressed files
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

Checks (`imexam` 26, `lcfits` 10): binned profiles and curves of growth equal photutils `RadialProfile` /
`CurveOfGrowth` to 6e-15 on six stars of the HAT-P-32 b frame; the binned Gaussian FWHM equals photutils'
`gaussian_fwhm` (0.000%), the Moffat FWHM scipy `curve_fit` (0.33%); region statistics equal astropy
`sigma_clipped_stats` to 1e-14. On synthetic stars: the Gaussian FWHM of a pixel-integrated Gaussian 0.00% from
2.3548 √(σ² + 1/12), the half-flux diameter 0.94% from it, a Moffat star's FWHM 0.37% and β 2.75 against 2.70,
major-axis angles to 0.001° and ellipticity to 0.005. On synthetic fields of 70 to 80 stars: cell FWHMs within
1.2%, curvature 25.4% against 25.7% true, the sharpest point within 1 px of the centre, a tilt of 31% with the
right worst corner, trailed stars at 59.9° against 60°, and an evenly focused field called even. On EXOTIC's
HAT-P-32 b frames (MicroObservatory) the focus map measures 35 stars at 2.37 px (12.3″) median FWHM and finds them
43% elongated, 82% in the same direction: trailing, which the frames show by eye. FITS tables written by astropy
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
radiometric estimate (throughput 0.3 and noise floors are editable assumptions), not ArielRad or PandExo. The
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

The planner lists transits, secondary eclipses, phase-curve windows and custom phase windows for a site and
date range, scored and sorted together: score with its breakdown, planet with an event badge, start–mid–end (the
time zone named once), coverage of the region of interest, an altitude sparkline with the window shaded, dark
time before and after, and a sky-view link; timing uncertainty, the Moon and the orbit are in the expanded row.
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
