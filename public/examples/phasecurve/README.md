# Phase-curve and eclipse-mapping examples

Built by `node test/make_phasecurve_examples.mjs <Exoplanet-Mapping checkout>`; the numbers below are what that
script prints. Each example is a CSV (`time` BJD, `flux`, `flux_err`, `epoch` numbered from 1) and an ESL session
(`docs/FORMAT.md`) holding the same data, the parameter values, what is free and the priors. The model is
`src/core/phasecurve.js`; it is not wired into `buildProblem` yet, so opening a session in the analyzer today fits the
transit and ignores the planet's light (see "What the session format lacks").

| File | What | Points |
| --- | --- | --- |
| `wasp43b_phasecurve.json`, `wasp43b_irac2_phasecurve.csv` | real: one full-orbit Spitzer visit of WASP-43 b at 4.5 µm | 760 |
| `wasp43b_eclipse_map.json`, `wasp43b_irac2_eclipses.csv` | real: that visit plus four more eclipses and two transits (7 observations) | 1746 |
| `wasp18b_sim_eclipse_map.json`, `wasp18b_sim_eclipses.csv` | simulated: three eclipses and a transit at JWST precision | 1182 |

## Where the real data come from

`DATA/WASP-43/IRAC 4.5um/<visit>_phasecurve_0/timeseries.csv` in https://github.com/pearsonkyle/Exoplanet-Mapping
(commit 3af871c, 2024-09-19), columns `time` and `flux`: Spitzer IRAC channel 2 photometry of three visits of
WASP-43 (BJD 2456896.6 to 2456897.7, 2458738.3 to 2458739.4, 2458753.0 to 2458754.1), each about 1.3 orbits at 2 s
cadence, already divided by that pipeline's Gaussian-kernel-regression estimate of the intrapixel response. The
2014 visit was first published by Stevenson et al. (2017, AJ 153, 68). The repository has no licence file; its
README asks users of the files to cite its white paper. It is the site owner's repository, so the files are
redistributed here on that basis: confirm before publishing the site.

Two things to know about these light curves:

- The detrending was done there jointly with that pipeline's own phase-curve fit (the systematics are estimated from
  data divided by its model). The light curves are therefore not independent of a degree-1 map model, and a fit here
  recovers that fit: for the 2458738 visit the repository's header gives mid-transit 2458738.834783 ± 0.000070, eclipse
  depth 3810 ± 100 ppm and hot-spot longitude 1.6 ± 1.4°; the fit below gives 2458738.834826 ± 0.000076, 3851 ppm and
  1.1 ± 1.3°.
- Binning here: means in 120 s bins (60 s in the eclipse and transit windows), error = scatter inside the bin / √n,
  then all errors multiplied by one factor (1.018 and 1.118) so that χ²/N = 1 at the stored parameters. The factor
  absorbs the red noise the detrending leaves.

Star and orbit start from the repository's `prior.json` (Hellier et al. 2011): T★ 4400 K, log g 4.49, [Fe/H] −0.05,
R★ 0.60 R☉, a/R★ 4.872 (held fixed). Limb darkening: quadratic, 0.1157, 0.1080, from ESL's spectral PHOENIX table over
4.0 to 5.0 µm; held fixed.

## (i) Full-orbit phase curve: `wasp43b_phasecurve.json`

First-order model phased to mid-eclipse, light-travel delay on (13.4 s). Free, with uniform priors:

| Key | Prior | Least-squares value (this script) |
| --- | --- | --- |
| `tmid` | ± 0.005 d about the value | 2458738.834826 ± 0.000076 |
| `rprs` | 0.14 to 0.18 | 0.15752 ± 0.00051 |
| `inc` | 80 to 86° | 82.150 ± 0.042 |
| `fpfs` | 0 to 0.4 | 0.1552 ± 0.0043 (eclipse depth 3851 ppm) |
| `contrast` | 0 to 1 | 0.868 ± 0.025 |
| `hotspot` | −60 to 60° | 1.1 ± 1.3 (east) |

Fixed: `per` 0.813474 d, `ars` 4.872, e = 0, limb darkening. χ² = 780.7 for 760 points before the error scaling; a flat
phase curve at the same orbit has χ² = 3248. Derived (4.0 to 5.0 µm, blackbody star at 4400 K): dayside 1560 K,
nightside 812 K, Bond albedo 0.37 and redistribution 0.17 by Cowan & Agol (2011); in EXOTIC's terms c1 = 1.671e-3,
c2 = −3.3e-5, c0 = 2.180e-3. The errors are from the curvature of χ², not from a sampler. A contrast above 0.8 means
the equivalent degree-1 map is negative near the antistellar point (7% of the surface): the plots show it in grey.

## (ii) Eclipse map from a few observations: `wasp43b_eclipse_map.json`

Seven observations of one planet in one band: the 2458738 visit whole (120 s bins; two eclipses and a transit), and
60 s windows around both eclipses and the transit of each of the 2456896 and 2458752 visits: four eclipse windows and
two transit windows. Each observation has its own
stellar level. Map of degree 1; `contrast` and `hotspot` are not used.

| Key | Prior | Value stored |
| --- | --- | --- |
| `tmid` | ± 0.003 d | 2458738.835451 ± 0.000059 |
| `per` | ± 3e-6 d | 0.81347329 ± 0.00000005 |
| `rprs` | 0.14 to 0.18 | 0.15785 ± 0.00036 |
| `inc` | 80 to 86° | 82.119 ± 0.028 |
| `fpfs` | 0 to 0.4 | 0.1514 (eclipse depth 3773 ± 71 ppm) |
| `y10` | 0 to 0.9 | 0.693 ± 0.033 (day-night) |
| `y11` | −0.3 to 0.3 | 0.047 ± 0.016 (hot spot 3.9° east) |
| `y1m1` | −0.5 to 0.5 | 0 stored; the linear solve gives 0.11 ± 0.25 |

The four orbit parameters were found by a simplex search with the map solved linearly at every step (`solveMap`).
What the data say: the phase curve fixes `y10` and `y11`; the six eclipses are the only handle on latitude, and adding
`y1m1` lowers χ² by 0.3. Spitzer does not resolve the ingress and egress signal of this planet's map: the honest
result is an upper limit, and a sampler will return the prior on `y1m1`. `y10` = 0.69 is above 1/√3 = 0.577, so the
degree-1 map is negative on part of the night side (flagged, not forbidden; set `positiveMap` to forbid it).

Not verified: the period these three visits give differs from published values (0.8134740 d) by 7e-7 d, which is
2.3 minutes over the five years between visits. The time stamps were taken from the repository as they are.

## (iii) A case where the eclipse does map the planet: `wasp18b_sim_eclipse_map.json` (simulated)

Exactly what was injected: the orbit of WASP-18 b (Coulombe et al. 2023, Nature 620, 292: P 0.94145223 d, a/R★ 3.483,
i 84.39°, Rp/R★ 0.09783, e 0), quadratic limb darkening 0.06, 0.11, R★ 1.24 R☉ with the light-travel delay on, and the
map `fpfs` 0.36 (depth 3445 ppm), `y10` 0.42, `y11` 0.07, `y1m1` 0.15, `y20` −0.06, `y22` 0.04 (hot spot 24.5° east,
24.3° north; minimum brightness 0.10 of the mean, so the map is positive). Three eclipses (± 0.11 d) and one transit
(± 0.08 d) at 60 s cadence, white Gaussian noise of 60 ppm per point, seed 20261115, stellar levels 1.0002, 0.9997,
1.0005, 1.0001. No systematics, no red noise: this shows what the method measures, not what an instrument delivers.

Free: `tmid`, `rprs`, `inc`, `fpfs` (0.2 to 0.5), `y10` (0 to 0.577), `y11`, `y1m1`, `y20`, `y22` (−0.3 to 0.3).
The linear solve at the true orbit returns `y10` 0.407 ± 0.029, `y11` 0.071 ± 0.004, `y1m1` 0.237 ± 0.066,
`y20` −0.066 ± 0.069, `y22` 0.027 ± 0.118, `fpfs` 0.3596, χ² = 1147.7 for 1172 degrees of freedom. Without latitude
and degree 2 χ² is 1252.2: the latitude of the hot spot is detected from ingress and egress alone.

## What the session format lacks

- A switch saying the planet's light is modelled. These files carry
  `"phase": { "mode": "harmonic" | "map", "lmax": 1, "ltt": true, "band_micron": [4.0, 5.0] }` at the top level;
  version 1 readers ignore it. The phase keys themselves (`fpfs`, `contrast`, `hotspot`, `y10`, ...) sit in
  `planets[].parameters`, which already accepts extra keys, and `specFromSession` passes them through as values.
- A band per light curve. The flux ratio and the limb darkening both belong to a band; brightness temperatures need its
  wavelength range.
- Until `buildProblem` calls `makePhaseCurve`, the free phase keys in these sessions are sampled without effect.
