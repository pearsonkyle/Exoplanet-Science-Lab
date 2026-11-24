# Retrieval: an atmosphere from its spectrum

The [Atmosphere page](./atmosphere) goes from a model to a spectrum. The Retrieval page (`analyze/retrieval/`) goes
the other way: a measured spectrum in, and the values of the model that fit it out, each with its uncertainty. It
uses the same forward model and the nested sampler of the light-curve fits, in a worker of its own, so the page
stays usable while it runs and **Stop** ends a fit at once.

## A first run

The page opens on its quickest example: a hot Jupiter with one temperature, water and carbon dioxide, and a
spectrum simulated from those values (48 points from 1 to 5 µm, 60 ppm of noise). Press **Fit**. The status line
counts the models computed; in a minute or two the result appears:

- **Result**: each free parameter with its median and its 16 to 84% range, the best-fitting value, the limits
  that were searched, and, because the spectrum was simulated, what was put in and how many σ the median is from it.
- **Spectrum**: the points, the best fit on the data's bins, the range the posterior allows at every bin (shaded),
  and the residuals in units of the errors underneath.
- **Posterior**: the corner plot. Every pair of parameters, with contours holding 39%, 86% and 99% of the
  probability. A tilted, narrow pair is a trade-off: here water against the radius (a higher abundance or a larger
  planet raise the spectrum alike), which the page also says in words under the table.
- **Fits compared**: every fit of these spectra with its ln Z.

## Your own spectrum

**Load a spectrum** takes text files with rows of `wavelength, value, error` or
`wavelength, bin low, bin high, value, error`, wavelengths in micron; choose first what the file holds (transit
depths, eclipse depths, or the night side's planet-to-star ratio) and its unit. Lines that do not start with a number
are skipped. Without bin edges the bins are taken to meet halfway between the wavelengths. Several files are fitted
together: a transit and an eclipse of the same planet constrain more than either.

Then set the planet's mass, the star, the kind of temperature profile and how the gases are given, and in the
table choose for every parameter whether it is **free** (searched between two limits, every value equally likely
beforehand), **fixed** at a value, or **off** (left out of the model). The limits start wide; narrow them only for
a reason you could defend, because a posterior that leans on a limit is the limit's doing, and the page says so.

| Group | Parameters |
| --- | --- |
| Temperature | one temperature, or the Guillot profile's equilibrium temperature, infrared opacity, visible-to-infrared ratio and internal temperature |
| Composition | each gas's mixing ratio (twelve gases), or [M/H] and C/O with the gases in chemical equilibrium |
| Planet | the radius at the reference pressure |
| Clouds and haze | cloud-top pressure, cloud cover, haze strength and slope |
| Day and night | how much cooler the night side is (needs an eclipse or night-side spectrum) |

## Is the gas there? Comparing two models

A detection is a comparison. Fit with the gas free, then set it to **off** and fit again: the table of fits gives
Δ ln Z between the two. Above 5 the data ask for the gas strongly, above 2.5 they favour it, within 1 they cannot
tell. The same goes for a cloud or a haze. χ² alone does not answer this, since a model with more freedom always fits
at least as well.

## Reading the result with care

- **Converged or not.** The sampler stops by itself when 1% of the evidence is left. If the limit on models or
  seconds is reached first, the page says NOT converged, draws no corner plot, and the numbers are where the search
  had got to, not a posterior. Raise the limits or free fewer parameters.
- **Speed against accuracy.** A fit runs on 30 layers with the opacity bins joined as far as leaves three model
  bins to one data bin. Against the full model that costs about 8 ppm for the layers and 4 to 20 ppm for the bins
  on a hot Jupiter at R = 30 ([validation](./validation), "Retrieval"). For data much better than that, use Python
  or the MCP server with `merge=1` and more layers.
- **What a simulated spectrum shows.** It is the model's own spectrum, from the full tables and 60 layers, with
  white noise. Getting the values back shows that the method works and how tight such data would make the answer.
  It does not show that the model is right for a real planet.
- **What is left out.** The profile from radiative balance (too slow to sample), the light curves behind the
  spectrum (the points and their errors are taken as given and independent), spots and faculae on the star, and
  everything that is not one-dimensional.

## Taking it with you

**Save figure** and **Save corner plot** write PNGs on white for a paper; **Save CSV** the spectra with the best fit
and the posterior's band; **Save samples** the weighted posterior samples; **Save result** every number, the limits,
the data and the best fit as JSON.

## With the assistant, Python or the MCP server

On this page the assistant has `retrieval_get`, `retrieval_set`, `retrieval_load_spectrum`, `retrieval_simulate`,
`retrieval_run`, `retrieval_stop` and `retrieval_export`: give it a spectrum file and ask what it shows, or ask it
whether a gas is needed and it will run both fits and compare them. On the Atmosphere page,
`atmosphere_fit_spectrum` fits the model shown there and sets it to the fit. The same fit is one call from Python
(`esl.retrieve_atmosphere`) and one tool of the MCP server (`atmosphere_retrieve`); see
[Atmospheres](./atmosphere#fitting-a-spectrum-retrieval).
