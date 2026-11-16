# Kepler-88 (KOI-142): a hidden planet weighed by transit timing (real data)

Kepler-88 b (KOI-142.01, P ≈ 10.95 d, a sub-Neptune) shows some of the largest transit timing variations known:
its transits arrive up to about 10 hours early or late over a cycle of about 630 days. The cause is planet c
(P ≈ 22.3 d, just outside the 2:1 resonance), which does not transit. Nesvorný et al. (2013) inferred its mass from the
TTVs and radial velocities confirmed it (Weiss et al. 2020). This example fits the published times of b with this
project's N-body model and compares c's mass and period with both papers.

| file | what it is |
|---|---|
| `holczer2016_table3_koi142.01.tsv` | the 121 rows of KOI-142.01 in table 3 of Holczer et al. (2016), as returned by VizieR |
| `holczer2016_table2_koi142.01.tsv`, `holczer2016_table5_koi142.01.tsv` | the KOI's linear ephemeris (table 2) and the fitted TTV sinusoid (table 5: period 627.5 d, amplitude 650 min) |
| `transit_times.csv` | 119 mid-transit times (BJD_TDB) with errors: `epoch, tmid, err, source` |
| `session.json` | the ESL session: planets b and c, the times, N-body model, priors |
| `make_example.mjs` | writes the two files above from the catalogue rows: `node public/examples/kepler88/make_example.mjs` |

## Source and licence

Holczer et al. 2016, ApJS 225, 9 (bibcode 2016ApJS..225....9H; VizieR title "Kepler TTVs. IX. The full
long-cadence data set"; catalogue J/ApJS/225/9, doi:10.26093/cds/vizier.22250009, as recorded in the VizieR header of
the downloaded files). Downloaded on 2026-11-16 from the CfA VizieR mirror
(`https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J/ApJS/225/9/table3&KOI=142.01&-out.all&-out.max=500`; the CDS
site was unavailable), only KOI-142.01's rows. VizieR data are distributed under the CDS terms
(https://cds.unistra.fr/vizier-org/licences_vizier.html), which ask that the catalogue and article be cited. The times
come from the public Kepler long-cadence light curves (MAST).

Columns used: `tn` (expected mid-transit time, BJD − 2454900), `O-C` and `e_O-C` (minutes); the observed time is
`2454900 + tn + O-C / 1440`. Transits 38 and 84 carry a nonzero outlier flag (`Out`) and are left out. `e_O-C` is
given to one significant figure (2 minutes for most transits).

The star (M★ 0.99 ± 0.023 M☉, R★ 0.897 R☉, Teff 5466 K) and the published values compared below are the NASA
Exoplanet Archive rows in this repository's snapshot (`public/catalog`, host "KOI-142").

## The fit

- N-body model (`src/core/nbody.js` through `buildProblem`, Wisdom–Holman, 30 steps per orbit of b), started at
  BJD 2454954.5; b's own T0 and period are fitted as a straight line to its simulated times (`nbody.linear`).
- Free: c's mass, osculating period and mid-time (its conjunction) at that epoch, and √e cos ω, √e sin ω of both
  planets (7). b's mass is held at 0.03 M_Jup (it hardly changes b's own times). c is put at i = 87° (it does not transit;
  coplanar orbits seen nearly edge-on), so its mass is close to the true mass, not M sin i. Planet d (P ≈ 1400 d,
  Weiss et al. 2020) is left out.
- `physical`: crossing and Hill-unstable orbits have no prior mass.
- The starting point and the priors' centres come from this project's own search: `ttvGrid` on a grid of mass
  (0.1 to 1.2 M_Jup) and period (22.10 to 22.50 d) with 16 starting phases, `ttvGridRefine` (circular orbits: best
  χ² 2.2 million), then a Nelder–Mead polish with both eccentricity vectors free (χ² 2171 for 119 times).
- At that best fit χ² is 2171 for 119 times: the catalogue errors are far too small for this model (they are
  rounded, and the model leaves out planet d and anything else). 8.66 minutes of timing noise in quadrature (the
  session's `timing_noise`) bring χ² to the 110 degrees of freedom. The fitted uncertainties rest on that choice.
- Not done: re-measuring transits from the Kepler light curves with this project's own pipeline, to compare with the
  catalogue times.
- The stored result is made with `node tools/build_example_results_node.mjs kepler88`, because the page does not
  carry the `physical` block yet.
