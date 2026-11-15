# Validation

One folder per published result the code is checked against: the inputs, the script that runs the comparison,
and a short note with the numbers and any disagreement. Checks that already exist live in `test/` and are
summarised in the top-level README; move them here as they grow.

| Result | Status |
| --- | --- |
| Flux kernel vs scipy adaptive quadrature | passes, max error 6e-13 (`test/kernel.test.mjs`) |
| Evidence vs brute-force quadrature | passes within reported error (`test/evidence.test.mjs`) |
| Pearson et al. 2022, Table 7 (HD 80606 b) | Rp, a, K, T14, T_peri, E_mid reproduced; **E14 differs** (0.0834 d here, 0.0717 d published) |
| Limb darkening vs ExoTETHyS | one profile compared (HD 80606, TESS), grey model only; PHOENIX table not built |
| pylightcurve / EXOTIC models and fits | compared directly (`test/exotic.test.mjs`): transit model 1e-7, RV 1e-5 of K, posteriors of the single, multiple, multi-planet examples match EXOTIC's; HD 80606 joint fit matches Table 7 |
| Catalog reference selection and physical checks | passes on fixtures and real systems (`test/catalog.test.mjs`); scoring weights are not calibrated |
| Ephemeris fits vs exact rational arithmetic and numpy.polyfit | passes (`test/ephemeris.test.mjs`); dP/dt conversion matches TASTE V for WASP-12 b; no published timing list fitted end to end yet |
| Multi-epoch likelihood vs quadrature; joint-fit period vs per-epoch mid-times + ephemeris | passes (`test/multiepoch.test.mjs`); simulated data only |
| Exoplanet-Mapping phase curves | not started |
