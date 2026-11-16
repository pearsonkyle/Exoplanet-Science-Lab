# HD 80606 b: the files of EXOTIC's sample data

Used by the examples `hd80606-tess`, `hd80606-rv`, `hd80606-joint` and `hd80606-rm` (src/ui/examples.js).

| file | what it is | copied from |
|---|---|---|
| `2458888_08_lightcurve.csv` | TESS 2-minute light curve of the transit of 2020 February 8, as reduced for Pearson et al. 2022 | `EXOTIC/examples/joint_rv_transit/` |
| `HD80606_RV.csv` | 264 radial velocities (ELODIE 74, HIRES pre-upgrade `HIRES_k` 39, post-upgrade `HIRES_j` 75, HRS 23, SOPHIE 48, APF 5), the compilation of Pearson et al. 2022 | `EXOTIC/examples/joint_rv_transit/` (the longer list in `examples/radial_velocity/`, most of its rows twice, is not used) |

Licence: none stated in the EXOTIC repository. TESS data are public (MAST); the velocities are from the publications
compiled by Pearson et al. 2022 (AJ 164, 178).

## Velocities in transit (`hd80606-rm`, `rm_session.json`)

`rm_session.json` is written by `node public/examples/hd80606/make_rm_session.mjs` (it reads the stored joint fit for
the inclination and the starting orbit). The compilation holds two partial transits:

- SOPHIE, 2009 February 14 (Moutou et al. 2009): the 48 SOPHIE velocities all lie in BJD 2454871 to 2454881, around the
  transit at about 2454876.3; they become one dataset with its own zero point and jitter.
- HIRES, 2009 June 5 (Winn et al. 2009; mid-time 2454987.7842 ± 0.0049, Winn et al. 2010): eight `HIRES_j` velocities
  in transit (BJD 2454987.742 to .848, from 1.0 hour before to 1.5 hours after mid-transit) and four outside it on the nights around; these twelve
  (BJD 2454985 to 2454989) are a dataset of their own.

The full-transit SOPHIE night of 2010 January 14, on which Hébrard et al. (2010) base λ = 42 ± 8°, is not in the file.
Rp/R★ is held at 0.1001 (Winn et al. 2009) because the TESS light curve is diluted by HD 80607 (its fitted 0.0725 would
inflate v sin i★ by about (0.1001/0.0725)² ≈ 1.9). The anomaly (`src/core/rm.js`, first moment of the uncovered light,
not exposure-averaged) uses quadratic limb darkening of the 390–690 nm band from this project's PHOENIX table
(0.6477, 0.0768), the session's `rm` block. The light curve is not in this fit; the orbit comes from all 264 velocities
and the five mid-times.
