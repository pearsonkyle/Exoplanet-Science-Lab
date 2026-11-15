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
contact configuration, five profiles): maximum absolute error **6e-13**. A 30-node Gauss-Legendre
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
radius ratio set to the square root of its corrected depth, it returns Rp = 1.034 R_Jup (paper
1.032), a = 0.4606 au (0.4603), K = 467.9 m/s (469.2), T_peri and E_mid within 0.001 d, and
T14 = 0.4987 d (0.4990). The eclipse duration does not match: 0.0834 d here against 0.0717 d in
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

**Limb darkening in a fit.** Either sample the coefficients, or "follow the star": sample Teff
(and [Fe/H] when a table is loaded) with priors at their measured uncertainties and compute the
coefficients from each sample (`makeLDTie`, tabulated on a 17 x 7 grid and interpolated inside the
likelihood). The coefficients then stay on the one-dimensional (or two-dimensional) family a star
can produce. With the grey model the spread reflects the Teff uncertainty only; with the table it follows Teff and [Fe/H].

## Habitable zone

Kopparapu et al. (2013, 2014) effective-flux limits; in units of the stellar radius the distance
depends only on Teff. The displayed band is 1 inside the conservative limits (runaway and maximum
greenhouse), 0.4 between those and the optimistic ones (recent Venus, early Mars), averaged over
the Teff uncertainty and an albedo range. The albedo scaling, sqrt((1-A)/0.7), is a heuristic of
this app, not part of the published limits.

## The sampler

`MiniNest` follows UltraNest's default strategy: live points are whitened by their covariance, the
constrained prior is bounded by the union of balls around all live points (MLFriends) intersected
with a wrapping ellipsoid, and both radii come from bootstrapping. New points are drawn uniformly
from that region inside the unit cube. The run stops when the live points can hold less than a set
fraction of the evidence. Also included: an insertion-order test, block handling of likelihood
plateaus (all the models whose transit misses the data), and a slice-sampling fallback.

Not included: UltraNest's reactive tree (variable live points), cluster-aware transforms, warm
start, resume from disk.

### Evidence

The evidence is a normalised marginal likelihood: the Gaussian `ln(sigma)` terms are included, the
priors are proper, and the baseline normalisation a1 is integrated out analytically over a
U(0, 2) prior rather than fixed at its best value. Its error is the spread obtained by re-drawing
every volume-shrinkage factor from Beta(n, 1) 200 times.

`test/evidence.test.mjs` compares ln Z with midpoint quadrature of likelihood x prior on transit
likelihoods with 1, 2 and 3 free parameters, six seeds each:

| free | quadrature | sampler mean | run scatter | reported error |
| --- | --- | --- | --- | --- |
| rprs | 848.969 | 848.960 | 0.13 | 0.10 |
| rprs, tmid | 845.129 | 845.036 | 0.13 | 0.14 |
| rprs, tmid, inc | 843.740 | 843.716 | 0.12 | 0.14 |

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
| Period from a joint fit of five nights (orbits 0, 3, 10, 40, 41; T mid and P free) vs a second route: each night's mid-time from its own likelihood, then `fitEphemeris` | 2.1500200 ± 0.0000070 vs 2.1500198 ± 0.0000069 (0.02σ apart, error ratio 1.017); truth 2.1500082, 1.7σ away |
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
| `multiple_transit` | five nights with airmass, nine parameters, against `glc_fitter` | means within 0.11σ, widths within 5%; 4.2 s against 57 s |
| `ephemeris` | 40 mid-times against statsmodels WLS, before and after the example's 3σ clip | T0, P and errors agree to 1e-6; 26 of 40 survive the clip |
| `multi_planet` | χ² of the three light-curve files and of the velocities at the injected truth | 45.11, 88.80, 190.58, 37.58: identical to two decimals |
| `multi_planet` | joint fit of three masses, trend and jitter against EXOTIC's stored fit | widths within 15%, best fit within 0.5σ; 0.7 s; planet d is an upper limit (95%: 3.6 m/s) |
| `radial_velocity` | HD 80606 b, seven instruments, four free parameters | K 469.6 m/s (paper 469.2), e 0.93156 (0.93183), ω −58.83° (−58.887°); zero points match EXOTIC's |
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

## Sample data

`src/data/hd80606_tess.js` is the TESS light curve of HD 80606 b from EXOTIC's
`examples/joint_rv_transit` (Pearson et al. 2022). The TESS aperture includes HD 80607, so the
fitted Rp/R* is diluted.
