# Simulated: masses of two transiting planets from their timing variations alone

A synthetic data set (no real observations): two transiting warm Saturns just outside the 2:1 mean-motion
resonance, a configuration like Kepler-9 b and c in its periods only (19.24 d and 2.04 times that at the epoch;
the masses and everything else are chosen here). Every transit of both over 1460 days, the length of the Kepler
mission, with 1.5 to 3 minute (b) and 2 to 4 minute (c) errors and Gaussian noise of that size. No velocities.

| file | what it is |
|---|---|
| `transit_times.csv` | 113 mid-transit times (76 of b, 37 of c): `planet, tmid, err, source` |
| `truth.json` | the system (osculating Jacobi elements at BJD 2455000), the integration, the TTV amplitudes and super-period, the linear ephemerides an observer starts from, stability |
| `session.json` | an ESL session: both planets, their times, the N-body model with each planet's T0 and P profiled; free: both masses, the outer planet's osculating period and mid-time at the epoch |
| `make_example.mjs` | regenerates the three files: `node public/examples/ttvpair/make_example.mjs` (IAS15 in `src/core/nbody.js`, seed 20261116) |

Injected: M_b = 0.14 M_Jup, M_c = 0.09 M_Jup, circular coplanar orbits (i = 89.2° and 89.4°), star 1.0 M☉.
Straight lines do not fit (χ² 8868 for 74 degrees of freedom for b, 3077 for 35 for c); the TTVs have amplitudes of
35 and 40 minutes (half peak to peak) and a super-period of 991 days from the mean periods. The first-order formula
of Lithwick, Xie & Wu (2012) gives sinusoid amplitudes of 28 and 22 minutes for these masses (not checked further here).

The fit holds both orbits circular. With free eccentricities the near-resonant TTV alone has the mass–eccentricity
degeneracy of Lithwick et al. (2012); here the chopping and the four-year baseline would break it partly. That
variant is not stored. Stability: 11.2 mutual Hill radii apart.

The session's `physical` block (crossing, hill) gives orbits that cross or are not Hill stable no prior mass; all of
this prior passes (prior volume 1.000), so the evidence is unchanged. The stored result is made by
`node tools/build_example_results_node.mjs ttvpair`.
