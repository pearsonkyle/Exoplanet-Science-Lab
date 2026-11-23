# A star from its light

The **Star** page (Analyze → Star) finds a star's effective temperature and angular diameter from catalogue
magnitudes, and with a parallax its radius and luminosity. A planet's radius and temperature are known only as well
as its star's, so this is where they begin.

## 1. Try an example

The page opens on HD 209458 with magnitudes from Gaia, Tycho, 2MASS and WISE and fits them in two or three seconds.
The figure shows the fitted spectrum as a line, each measured magnitude as a dot and what the model predicts for that
band as a square; the panel underneath is the difference in magnitudes. The table gives each quantity with its 16th to
84th percentile range and, for the examples, what was measured by other means (interferometry where there is any).

The other examples are HD 189733, GJ 436, HD 97658, GJ 1214 and WASP-39. HD 189733 is worth a look: the fit gives a
star 7% smaller and 150 K hotter than interferometry does, which is also what a published fit with AstroARIADNE
gives. SED fits and interferometry disagree on this star.

## 2. Look a star up

Type a name in **Star** (planet hosts are suggested as you type) and press **Look up**. The page asks Gaia DR3,
2MASS, AllWISE and Tycho-2 (through VizieR) for the magnitudes and the parallax, takes log g and [Fe/H] from the
site's catalogue when the star hosts a known planet, sets the extinction limit from the distance, switches off bands
that are saturated or flagged, and fits. The line under the name says what was found, what was set aside and why. If
a catalogue does not answer, press Look up again or type its magnitudes in.

## 2b. Your own magnitudes

1. Type a name (it labels the files you save).
2. Enter magnitudes: choose the band, type the magnitude and its error, add rows as needed. Use each catalogue's own
   system, which is what the catalogue lists: Vega magnitudes for Gaia, Tycho, Johnson, 2MASS, WISE and APASS B, V;
   AB magnitudes for SDSS, Pan-STARRS, APASS g, r, i and GALEX.
3. Untick bands that cannot be trusted: 2MASS with a quality flag other than A, WISE W1 brighter than about 8 and W2
   brighter than about 7 (saturated), anything blended with a neighbour.
4. Under *What is known already* give the Gaia parallax and its error. Give log g and [Fe/H] with errors if a
   spectrum has measured them; magnitudes say almost nothing about either. Set the largest extinction worth
   considering: zero for a star within about 70 pc (the Sun sits in a cavity with almost no dust), about 0.1 mag per
   100 pc beyond that. A limit set too high makes the star come out hotter: the allowed range is itself information.
5. Press **Fit**.

Three magnitudes are the minimum; a useful fit has the optical (Gaia or Tycho) and the near infrared (2MASS), and is
better with WISE W3.

## 3. Reading the result

- **Temperature and angular diameter** are what the magnitudes fix: the shape of the curve and its height.
- **Radius, luminosity, distance** appear with a parallax.
- **Extra scatter** is fitted and added to every error bar. A few hundredths of a magnitude is normal (zero points
  and models are no better); above 0.1 the page warns: a band is bad, or the star is not one plain photosphere.
- **Extinction** is often not pinned down; then its range is the range you allowed, and the temperature's error bar
  includes the trade between dust and temperature.

*Save CSV* writes the magnitudes, the model's and the spectrum; *Save result* a JSON file with every number and the
inputs; *Save figure* the plot on white.

## 3b. The posterior, the sampler, and tables for a paper

- **Posterior**: a corner plot of temperature, angular diameter, radius, luminosity, extinction, gravity,
  metallicity and scatter as the nested sampler found them; *Save samples* gives the weighted samples as CSV.
- **How the sampler ran**: the evidence ln Z with its error, live points, iterations, model evaluations, effective
  samples and the insertion-order test.
- **Fits compared**: change a prior or the extinction limit and fit again; each fit is listed with its ln Z, and
  fits of the same magnitudes are compared by Δ ln Z, as transit models are elsewhere on the site.
- **For a paper**: two LaTeX tables (parameters with their priors; the photometry with the model's magnitudes) to
  copy or save.

## 4. What it cannot do

Main-sequence stars between 2300 and 8000 K with metallicity within 0.5 dex of the Sun's: no giants, no hot stars.
One grid of models (PHOENIX), where AstroARIADNE averages several. M dwarfs fit less well in the optical (about
0.1 mag of scatter). No binaries, discs or activity. Magnitudes are typed in: the page does not look them up yet.
The checks are in the [validation notes](./validation.md) under "SED fitting".

## From Python

```python
import esl
r = esl.star_fit({"Gaia BP": (7.793, 0.003), "Gaia G": (7.521, 0.003), "Gaia RP": (7.080, 0.004),
                  "2MASS J": (6.591, 0.020), "2MASS H": (6.366, 0.038), "2MASS Ks": (6.308, 0.026)},
                 parallax=(20.7694, 0.0266), logg=(4.28, 0.1), feh=(0.0, 0.1))
r["parameters"]["teff"], r["parameters"]["rstar"]            # each: median, lo, hi, best
```

## A spectrum instead of magnitudes

`matchSpectrum` in `src/core/specmatch.js` (and the MCP tool `star_match_spectrum`, which reads a CSV file of
wavelength in micron, flux and optionally error) fits the same models to a low-resolution spectrum. With a
flux-calibrated spectrum and one scale factor it returns the temperature, gravity, metallicity and the angular
diameter; with `degree` above zero a smooth polynomial absorbs an uncalibrated slope and the temperature rests on
the spectrum's bands and breaks. The models are sampled every 5 nm, so this suits spectrophotometry (Gaia XP, SpeX
prism, a JWST prism spectrum of the star) and not echelle spectra. It is not on the page yet, and has been tested on
synthetic spectra only.
