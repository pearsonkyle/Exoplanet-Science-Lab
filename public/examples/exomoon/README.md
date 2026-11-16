# Exomoon example (simulated)

A simulated light curve of a Jupiter-size planet with a moon large enough to find, made with
`src/core/exomoon.js`. Nothing here is real data.

| file | what it is |
|---|---|
| `lightcurve.csv` | `BJD_TDB, flux, flux_err`: 12 consecutive transits, 4152 points |
| `session.json` | the same data as an ESL session (`docs/FORMAT.md`), with the moon in planet b's parameters and the injected values under `truth` |
| `make_example.mjs` | makes both files and prints the numbers below: `node public/examples/exomoon/make_example.mjs` |

## What was injected

| | |
|---|---|
| Star | 1 M☉, 1 R☉, quadratic limb darkening u1 = 0.40, u2 = 0.26 |
| Planet b | Rp/R★ = 0.1, P = 45 d, T mid = 2459010.0, circular, 1 M Jup; a/R★ = 53.258 from Kepler's law, i = 89.6773° (impact parameter 0.3); T14 = 6.83 h, depth 11900 ppm |
| Moon | Rm/R★ = 0.02 (2.2 R⊕), P moon = 3.7 d, phase 0.13 at T mid, Mm/Mp = 0.02 (6.4 M⊕), coplanar and prograde (`imoon` = 0) |
| Moon's orbit | separation 0.998 R★ = 9.98 planet radii from Kepler's law; 0.273 Hill radii (a prograde moon is stable below 0.4895, so up to P moon = 8.90 d); fluid Roche limit 1.80 planet radii |
| Sampling | 12 transits, ±0.6 d around each, one 5 min exposure after another (the model is averaged over each exposure, 7 sub-samples) |
| Noise | white, Gaussian, 250 ppm per point, seed 20261115; no baseline trend, no airmass term |

## How detectable it is

- The moon's own transit is 477 ppm deep (1.9 σ per point). 922 of the 4152 points fall in it, 7 fall in a planet-moon eclipse.
- The moon moves the planet: transit timing variation 3.79 min peak (2.68 rms), duration variation 1.65 min peak (1.17 rms).
- χ² of the data is 4133 against the injected model and 6884 against the moonless planet at its true parameters
  (Δχ² = 2751, for 4152 points). That difference counts the moon's dips and the planet's shifted transits together.
- `moonSearch` on these data with the true planet model finds P moon = 3.6988 d, phase 0.104, Rm/R★ = 0.0200 at
  S/N 33.6. The largest S/N in 200 noise-only searches of the same sampling is 5.65 (false-alarm probability below 0.005).
  The search takes about 0.1 s without the noise-only runs.
- The period is not unique from the dips alone. Transits sample the moon once every 45 d, so the periods with
  `1/P' = 1/P ± k/45 d` put the moon at the same place in every transit: 3.419 d (S/N 33.5) and 4.032 d (33.3) are
  almost as good as 3.699 d (33.6). They differ only through the separation that Kepler's law gives each period and
  through the moon's motion during a transit. A fit should start from each of the top peaks (`peaks` in the search result).
- Scaling the signal with Rm² (not run as a separate simulation), a moon of Rm/R★ ≈ 0.0085 (0.9 R⊕) would reach
  S/N 6 with this sampling and noise.
- The phase found (0.104) is 0.026 from the injected 0.13: the search has no wobble in its templates and only
  refits each transit's mid-time, so it is the starting point for a fit, not the answer.

## The session file

Planet parameters accept extra keys, so the moon is there: `rmoon`, `permoon`, `phmoon`, `mmoon`, `imoon`
(`src/core/exomoon.js`, `MOON_PARAMS`). `kepler: true`, so a/R★ follows from the masses, and so does the
planet-moon separation.

The likelihood in `src/core/model.js` does not read the moon yet. Until it does, the session loads and runs as a
planet-only fit (`fit.free` holds planet parameters only; a moon key there would be sampled without any effect).
`test/exomoon.test.mjs` checks that it loads and evaluates the moon model on its data.

What format version 1 lacks for a moon, and where this file puts it meanwhile (readers keep and ignore unknown keys):

- **Which moon parameters are free, and their priors**: `fit.moon.free`, same shape as `fit.free`. Once the
  likelihood has the moon these belong in `fit.free` itself (`rmoon`, or `rmoon@c` for planet c).
- **Switches** for the wobble, the moon's own transit and planet-moon eclipses: `fit.moon.switches`.
- **How the separation is set** (Kepler's law, or `amoon` / `amoonrp` given directly): `fit.moon.separation`.
- **Injected values of a simulation**: top-level `truth`.
- `mmoon` is a mass ratio (Mm/Mp) while `mplanet` is in Jupiter masses; the format has no place to state a unit per key.
- With `kepler: true` a/R★ is computed from M★ + Mp. The moon's mass is not added (a 6e-6 relative change in a/R★ here).
