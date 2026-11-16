# TOI-1873 (TIC 328933398): real TESS and NEID data

Two worked examples on the owner's analysis of TOI-1873 in the EXOTIC repository
(`EXOTIC/examples/toi-3planet/`, read only; nothing was written there). Regenerate the files with

    .venv/bin/python public/examples/toi1873/make_example.py [path to EXOTIC/examples/toi-3planet]

| file | what it is | example |
|---|---|---|
| `session.json` | TESS windows around every transit of b, c and d, binned to 10 min (2876 points in 53 epochs, each with its own normalisation), 37 NEID velocities, the star and three planets; 19 free parameters | `toi1873` |
| `transit_times.csv` | the 50 mid-transit times of EXOTIC's per-transit fits (39 of b, 8 of c, 3 of d): `planet, tmid, err, source` (source = TESS sector) | — |
| `oc_session.json` | the 50 times, a straight-line ephemeris free for each planet | `toi1873-oc` |
| `make_example.py` | builds the three files above from the EXOTIC folder | |

## Where the data come from

- **Light curves**: TESS SPOC 2-minute light curves of 13 sectors (20, 21, 40, 41, 47, 52, 53, 59, 60, 73, 74, 79, 86;
  20-s products binned to 120 s), extracted and detrended by the owner's `toi1873_extract.py` in EXOTIC (biweight
  trend with the transits masked; `output/toi_1873/toi1873_timeseries.npz`, 209,066 cadences). Here: the cadences
  within 1.25 transit durations of every predicted transit of b, c or d (14,367), cut where the data have gaps of more
  than 30 minutes, and binned to 10 minutes (inverse-variance weights, at least 3 cadences per bin). The model averages
  over the 10-minute exposure. TESS data are public (MAST); the detrending is EXOTIC's, not this project's.
- **Velocities**: `TOI1873_2D.dat` of the owner's collaborators' pyaneti analysis (`ForKyle_Sept1_26.zip`): 37 NEID
  velocities, median-centred, converted here from km/s to m/s and from BJD − 2460000 to BJD. The FWHM column of that
  file is not used (the published fit models it with a multi-dimensional Gaussian process, which this code does not).
- **Mid-transit times**: `output/toi_1873/toi1873_transit_fits.json` (EXOTIC per-transit fits, Rp/R★ and T mid free
  in each window).
- **Star**: the ARIADNE SED fit adopted by the pyaneti analysis (M★ = 1.020 ± 0.044 M☉, R★ = 0.974 ± 0.019 R☉,
  Teff = 5605 ± 45 K; `2p_circ_prod_params.dat`), held fixed. The archive's TOI table (snapshot 2026-11-15) lists
  Teff 5699 ± 141 K, R★ 0.97 ± 0.05 R☉, log g 4.47, and all three TOIs as planet candidates (1873.02 at 900.19 d).
- **Planet d** (TOI-1873.02) has three transits 900.19 d apart; 128.598 d (900.1885 / 7) is the shortest period for
  which no further transit falls in the TESS coverage (EXOTIC README, "Why 128.598 d"); the coverage allows
  N = 1, 2, 3, 4, 7 in P = 900.1885 d / N (EXOTIC's alias scan; `src/core/aliases.js` `aliasScan` uses the same rule).
  The main fit samples N with a categorical prior (uniform over the five) and the span P × N; the timing examples
  hold d at 128.598 d.

**Licence**: none stated. The NEID velocities and the pyaneti results were shared with the owner by collaborators and
are, as far as this repository knows, unpublished: decide before the repository or the site goes public whether they
may be redistributed. The TESS light curves are public mission data.

## The fit (`toi1873`)

Free: Rp/R★, i, T mid and the mass of each of b, c, d, the periods of b and c, d's alias N and span P × N (16), the
quadratic limb darkening as Kipping's q1, q2, and a NEID jitter (19 in all). a/R★ follows from Kepler's law with the
star held; orbits circular; no stellar velocity trend; the session's `physical` block gives crossing and Hill-unstable
orbits no prior mass (`src/core/physical.js`; the result records the prior volume that passes). Stored with
`node tools/build_example_results_node.mjs toi1873` (runSession), because the analyzer page does not yet carry the
`physical` block or the alias parameters. Priors:
P and T mid within ±6σ of the linear ephemeris through EXOTIC's per-transit mid-times (as EXOTIC's own joint fit seeds
them), Rp/R★ U(0.015, 0.05), masses U(0, 0.2) M Jup, q1, q2 U(0, 1), jitter U(0, 15) m/s.

Compared with the published two-planet fit (pyaneti, `2p_circ_prod_params.dat`), this fit differs in three ways that
matter: the published fit has no planet d, models the velocities with a Gaussian process trained on the FWHM (its
white jitter is 0.97 m/s), and samples the stellar density with a prior rather than holding M★ and R★. The comparison
and its numbers are in the Methods page (Reproducibility) and printed by `node test/examples_real.test.mjs`.

## The timing example (`toi1873-oc`)

The O − C of b (39 times) and c (8 times) against straight lines, and the periodogram of the residuals on the Timing
tab: no peak passes the 1% false-alarm level (b: 2.88 epochs, false-alarm probability 25%; c: 12.7 epochs, 80%;
`test/examples_real.test.mjs`). EXOTIC's own analysis of these times agrees (b: 3.25 epochs, power 0.31 against a 99%
level of 0.45; c: 12.5 epochs, 0.80 against 0.98). The planets are far from any resonance, so no measurable TTV is
expected; an N-body fit of these times gave only an upper limit of about 4 M Jup on d (an earlier example, removed:
the system is too spread out to show timing variations). The Kepler-88 example (`public/examples/kepler88/`) shows
a hidden planet weighed by its timing signal.
