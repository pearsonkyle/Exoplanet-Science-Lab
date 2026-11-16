# N-body example: a hot Jupiter with a companion near the 2:1 resonance

A synthetic data set for trying N-body analysis of transit timing, in the spirit of EXOTIC's
`examples/nbody/example.py` and built on the same configuration: a HAT-P-37-like star (0.95 M☉) with a
1.169 M_Jup planet on a 2.797436 d orbit and a 0.1 M_Jup companion started at 1.9 times that period, both a
quarter of an orbit before conjunction at BJD 2459150. The companion does not transit (i = 85°).

| file | what it is |
|---|---|
| `transit_times.csv` | 72 mid-transit times of planet b over 1110 d (three observing seasons): columns `tmid, err, source`. Two TESS sectors of consecutive transits (30 to 45 s errors) and ground-based transits labelled ExoClock, Exoplanet Watch and Unistellar (45 to 90 s). Gaussian noise equal to the quoted errors. |
| `truth.json` | the system (osculating Jacobi elements at the epoch), the integration, the noiseless times of the 72 observed transits, and what the timing signal should look like |
| `session.json` | an ESL session (docs/FORMAT.md) with planet b, the timing list and a linear ephemeris free: load it and open the Timing tab |
| `make_example.mjs` | regenerates the three files: `node public/examples/nbody/make_example.mjs` (IAS15 in `src/core/nbody.js`, seeded) |

The times are the centres of the transits (minimum projected separation); for circular orbits that is the
instant of conjunction.

## What the Timing tab should find

Run on `transit_times.csv` (`timingPeriodogram` in `src/core/periodogram.js`; checked in `test/nbody.test.mjs`):

- Linear ephemeris: P = 2.7962904 d, χ² = 348 for 70 degrees of freedom. A straight line does not fit.
- Periodogram of the O − C: one peak at **20.48 ± 0.03 orbits = 57.28 d**, false-alarm probability
  **5 × 10⁻¹⁶** (Baluev; none of 1000 bootstrap shuffles reaches it).
- A sinusoid there has amplitude **150 ± 9 s** (2.51 ± 0.16 min) and lowers the BIC by 253. The verdict is one
  significant sinusoid. A second peak near 4.9 orbits has a false-alarm probability of 2% and is not adopted.

The truth: the noiseless O − C of b has a sinusoid of 146 s at 20.48 orbits (peak to peak 325 s, because the
signal is not a pure sinusoid); the companion's conjunctions move by ±23 minutes.

## Why 57 d and not 53 d

The companion starts with an osculating period of 1.9 × 2.797436 = 5.3151 d, which would put the pair 5.0%
inside the 2:1 resonance with a TTV "super-period" of 1 / |2/P_c − 1/P_b| = 53.15 d. But the periods an
ephemeris measures are the mean ones, and the Jupiter-mass inner planet changes the companion's: its
conjunctions repeat every 5.3322 d on average (b: 2.796293 d). With those the pair is 4.66% inside the
resonance and the super-period is 57.27 d, which is what the periodogram finds. The first-order formula of
Lithwick, Xie & Wu (2012) then gives 136 s for b, against 146 s in the simulation.

## Interpreting it: which companion?

`ttvGrid` in `src/core/nbody.js` simulates the system for a grid of companion masses and periods (eight
starting phases each) and scores each against the 72 times after refitting b's own T0 and period. On a 12 × 21
grid from 0.02 to 0.5 M_Jup and period ratios 1.61 to 2.21 (2016 simulations, 6 s on one thread; 1 s for a
finer 16 × 30 grid on a pool of 16 Web Workers):

- best cell 0.086 M_Jup at 5.341 d, χ² = 108 against 348 for the straight line;
- polished with `ttvGridRefine` (136 more simulations): **0.104 M_Jup, mean period 5.3336 d, χ² = 75.7 for 72
  times**. Truth: 0.1 M_Jup, 5.3322 d.
- a nested-sampling retrieval around that solution (`nbodyTimingProblem` with MiniNest, three free parameters,
  4049 simulations, 13 s): **0.104 ± 0.007 M_Jup**.

The amplitude and period of the periodogram peak alone (what EXOTIC's `estimate_prior` uses) allow two
families, one on each side of the resonance: 0.07 to 0.09 M_Jup near period ratio 1.91, and 0.11 to 0.21 M_Jup
near 2.09 to 2.12. Comparing the times themselves removes the second. The map is narrow in period: the
simulated TTV has to stay in step with the data over 19 super-periods, so a coarse grid finds the neighbourhood
and the polishing step finds the solution. The likelihood has alias modes every 0.013 d in the companion's
period (one super-period cycle more or less over the 1110 d), so a sampler started with a wide period prior
lands on one of them: in a test with ±0.03 d it had not converged after 60000 simulations and reported
0.066 M_Jup. Locate the mode with the grid first.

`test/nbody_harness.html` (dev server) draws the O − C of both planets with the data, the map and the orbits.

## Stability

Separation 5.7 mutual Hill radii (the two-planet limit of Gladman 1993 is 3.46), AMD under 0.1% of the
critical value (Laskar & Petit 2017), and no close encounter in 1000 orbits of the companion.
