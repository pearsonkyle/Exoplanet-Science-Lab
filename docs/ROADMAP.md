# Roadmap

Order follows the owner's plan. Each stage ends with a validation against published work before the next begins.

0. **Finish single-transit** (in progress)
   - Run the app with three.js for the first time: **done**, it rendered without changes (see HANDOFF.md).
   - Build the PHOENIX limb darkening table (`tools/build_ld_table.py`) and bundle it.
1. **Limb darkening and the infrared**
   - Extend the table to JWST bands (NIRISS SOSS, NIRSpec PRISM/G395, NIRCam F322W2/F444W, MIRI LRS) and to
     spectroscopic channels (coefficients per wavelength bin).
   - Compare against ExoTETHyS and Claret tables; record the differences in `validation/`.
2. **Multiple transits and ephemerides**
   - Several epochs in one fit, phase-folded view, period as a free parameter: **done** (see README,
     "Several epochs in one fit"). Still to do: per-epoch mid-times in the joint fit (feeding the Timing tab),
     per-epoch exposure time, and a real multi-epoch dataset checked against a published result.
   - Linear and quadratic ephemeris fitting from mid-transit times, O-C plots: **done** (Timing tab,
     `src/core/ephemeris.js`). Still to do: compare with EXOTIC `ephemeris.py` on a published list of times.
3. **Periodic signal detection**
   - Box least squares / transit least squares on long light curves, periodograms of timing residuals.
4. **N-body**
   - Dynamical transit times and TTVs (EXOTIC `nbody.py` as the reference), stability checks.
5. **Eclipses and phase curves**
   - Secondary eclipse, full-orbit phase curves, harmonic and spherical-harmonic surface maps.
   - Validation set: https://github.com/pearsonkyle/Exoplanet-Mapping
6. **Exomoons**
   - Planet + moon photometric model, detection limits.
   Status 2026-11-15: superposed multi-planet transits, radial velocities with per-instrument zero points and
   jitter, timing constraints and the HD 80606 end-to-end test are in (README, "Several planets, radial velocities
   and joint fits"). Open: N-body, eclipses and phase curves, per-dataset limb darkening, stellar priors on by
   default, a convergence report for large joint fits, the real TOI-1873 data.
7. **Joint fits**
   - Multi-planet transits + radial velocities + ephemeris constraints (EXOTIC `multi_fitter.py`, `joint_fitter.py`,
     `rv_fitter.py`), with the HD 80606 analysis (Pearson et al. 2022) as the end-to-end test.

Cross-cutting: saved sessions, hosting at exoplanet.science (the catalog snapshot needs rebuilding on a schedule, or a small proxy for live queries), Plan and Acquire sections of the start page.
