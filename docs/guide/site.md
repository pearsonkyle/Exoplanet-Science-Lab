# A tour of the site

| Page | What it does | What it needs |
| --- | --- | --- |
| **Plan** | Transits, secondary eclipses and phase-curve windows you can observe from a site over a range of nights, scored by altitude, darkness, Moon and timing uncertainty; a sky chart and altitude track for each; CSV export. | A site (89 observatories, or your coordinates). |
| **Observe** | Your sky at any time and place: planet hosts coloured by discovery method, TESS candidates, the Moon and planets, a terrain horizon, and a WebXR mode for headsets. | Nothing. |
| **Analyze → Processed Data** | Model and fit light curves, radial velocities and mid-transit times with nested sampling: several planets, eclipses and phase curves, eclipse maps, moons, Rossiter–McLaughlin, N-body dynamics, detrending, jitter and dilution. Results, model comparison, a methods paragraph with BibTeX, LaTeX tables, the session file. | Light curves (CSV, AAVSO, EXOTIC, TESS/Kepler FITS), velocities, or times; or a worked example. |
| **Analyze → Photometry** | Images to a light curve: calibration, star detection, a search over apertures, annuli and comparison stars; DS9-style tools (radial profile, focus map, line cut, region statistics, header); TESS/Kepler/K2 pixels with sector and cadence choice, transit-aware detrending and K2 PLD; the AAVSO Exoplanet Watch report. | FITS frames (a folder or a zip) or a target pixel file. |
| **Analyze → Spectroscopy** | JWST and Ariel time-series spectra to a transmission or emission spectrum, white-light and per-channel fits, and a simulator. | Extracted 1-D spectra (x1dints FITS, ECSV, CSV). |
| **Search** | The NASA Exoplanet Archive, exoplanet.eu and the TOI list merged, with units, sources, the disagreements between catalogues and three ephemeris choices. | Nothing. |
| **Methods** | How each technique is computed and checked, the validation against other codes and published results, references and how to cite. | Nothing. |

## Your data stays with you

Files are read in the browser and never uploaded. Saved analyses, the Project checklist and the assistant's conversation live in your browser's storage; the only network requests are the bundled catalogues of this site, the public data archives you ask for (MAST, VizieR), and the model server you choose for the assistant.

## On phones and headsets

Every page works from 360 px wide; Observe has an AR mode on phones and a WebXR mode with controllers on headsets.
