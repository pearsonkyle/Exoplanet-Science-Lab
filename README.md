# Exoplanet Science Lab

Plan, observe, reduce and fit exoplanet observations: in the browser, from Python, or through an AI agent over MCP. One science core, tested against independent references.

**[Open the app](https://pearsonkyle.github.io/Exoplanet-Science-Lab/)** · **[Documentation](https://pearsonkyle.github.io/Exoplanet-Science-Lab/docs/)** · [Methods](docs/METHODS.md)

- **Plan** the transits, eclipses and phase-curve windows you can observe from your site.
- **Observe** your sky at any time, with every planet host marked (and a VR mode).
- **Photometry**: FITS frames (folders or zips) or TESS/Kepler/K2 pixels to a light curve, with DS9-style inspection.
- **Fit** transits, radial velocities, timing, phase curves, eclipse maps, moons, Rossiter–McLaughlin and N-body TTVs with nested sampling, and get a methods paragraph with BibTeX.
- **Python** package and **MCP** server on the same core; an **assistant** that drives the site with your own LLM.

Files you open never leave your browser: every science routine (transit and RV models, nested sampling, photometry, plate solving) runs in the page as plain JavaScript, written with Claude Fable 5.2 and checked against the reference codes it reimplements ([Validation](https://pearsonkyle.github.io/Exoplanet-Science-Lab/methods/#validation)).

## A tour

### Analyze

![Analyze: the joint fit of HD 80606 b (TESS transit, velocities and timing) with the 3D orbit, the light curve and the fitted parameters](docs/screens/analyze.webp)

- Fit light curves, radial velocities and transit times together, for one planet or several, with nested sampling (posteriors, evidence, corner plots).
- The 3D view is the model itself: **From Earth** shows the transit at true scale as the light curve sees it, and **Rec** records it as a movie.
- Results export as LaTeX or JSON, and the Results tab writes a methods paragraph with the BibTeX of exactly the methods used.
- Eighteen worked examples, real data (TESS, Kepler, NEID, HIRES and others) and simulations, each with a note on how to read it.

### Data along the orbit

![The orbit of the candidate TOI-1873 d with each TESS and NEID measurement placed where the planet was when it was taken](docs/screens/orbit.webp)

- **Look ▸ Data along the orbit** places every measurement where the planet was when it was taken: on the orbit itself, velocities in orange and photometry in green.
- The gaps are the phases nobody observed. A well-sampled RV planet (HD 80606 b) is ringed all the way round.
- A candidate like TOI-1873 d shows its TESS sectors as clumps and its few velocities scattered between them, so you can see why its period is one of several aliases.

### Plan

![Plan: observable transits from Kitt Peak, ranked by a score, with the night of WASP-33 b open: altitude chart, contact times and sky chart](docs/screens/plan.webp)

- Transits, secondary eclipses, phase-curve and custom windows for your site and nights, with timing uncertainty propagated from the ephemeris.
- Each event gets a 0–100 score from its coverage, dark baseline, altitude (airmass) and expected signal-to-noise (depth, host magnitude and duration for a small telescope).
- Pick a site on the globe (89 observatories with links to their weather and all-sky cameras), use a terrain horizon, filter by magnitude, depth and discovery method, and include TESS candidates.
- Click an event for its night (WASP-33 b here): altitude and airmass against twilight, the Moon and the ±1σ timing window, the contact times, and a sky chart of its path; from there it opens in the sky view or the analyzer. The ephemerides download as CSV.

### Observe

![Observe: the sky from Kitt Peak with planet hosts marked by discovery method and the Filter panel](docs/screens/observe.webp)

- Your sky at any time and place, with every planet host marked by how its planets were found, and filters by star type, distance and brightness.
- Satellites (SGP4), the Moon, the planets and bright asteroids, with their paths over a night or months.
- Survey images of any field (DSS2, 2MASS, Pan-STARRS, Legacy Surveys) with Gaia stars and suggested comparison stars, and a VR mode.

### Photometry

![Photometry: a FITS frame of HAT-P-32 with target and comparison apertures](docs/screens/photometry.webp)

- FITS frames (folders or zips) or TESS, Kepler and K2 pixels to a light curve, all in the browser.
- DS9-style inspection, plate solving and Gaia comparison stars.
- A search over aperture radii, annuli and comparison stars, scored with the transit model.

### Timing and hidden companions

![Timing: the companion explorer for Kepler-88 with the orbit view and the transit-timing curve](docs/screens/companion.webp)

- O − C diagrams against a linear ephemeris, periodograms of the timing residuals, and N-body fits of transit-timing variations.
- The companion explorer searches for a hidden planet that would explain the timing variations: Kepler-88 c, which never transits, is weighed from the transit times of b.

### Assistant

![The assistant: a fit run through the chat, with the equation it uses and the results](docs/screens/assistant.webp)

- Drives the site through the same controls you use (loading data, fitting, planning), with your own model: LM Studio locally or any OpenAI-compatible server.
- Explains the methods with their equations, taken from the Methods page and the code.
- Checks every number it quotes against the results and flags the ones it cannot find.

## Run it locally

Needs [Node.js](https://nodejs.org) 20+.

```sh
git clone https://github.com/pearsonkyle/Exoplanet-Science-Lab.git
cd Exoplanet-Science-Lab
npm install
npm run dev          # http://localhost:5173
```

`npm run build` writes the static site to `dist/`.

## Python

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python"
```

```python
import esl
fit = esl.Session.load("session.json").run(progress=True)   # a session saved from the Analyze page
print(fit.result.table())
```

## MCP server (Claude Desktop, Claude Code, Cursor, …)

```sh
cd mcp && npm install
claude mcp add exoplanet-science-lab -- node "$PWD/server.mjs" --workspace ~/esl-work
```

Other clients, HTTP, remote machines and setting up your own LLM for the in-page assistant: see the [docs](https://pearsonkyle.github.io/Exoplanet-Science-Lab/docs/guide/mcp.html).

## Tests

```sh
npm test                       # every Node suite (~15 min)
cd python && pytest            # the Python package
cd mcp && npm test             # the MCP server
```

## Cite

Please cite the software (`CITATION.cff`) and the papers of the methods you used: the app's Results tab writes a methods paragraph with exactly those references.

The methods behind the software come from these papers (BibTeX from [SciX](https://scixplorer.org); the journal macros are spelled out):

- Pearson 2019: Bayesian N-body retrieval of transit times with nested sampling ([2019AJ....158..243P](https://scixplorer.org/abs/2019AJ....158..243P/abstract))
- Zellem et al. 2020: EXOTIC, the photometry and light-curve fitting the Photometry page follows ([2020PASP..132e4401Z](https://scixplorer.org/abs/2020PASP..132e4401Z/abstract))
- Pearson et al. 2022: joint fits of transits, velocities and mid-transit times to refine an ephemeris, and the system table ([2022AJ....164..178P](https://scixplorer.org/abs/2022AJ....164..178P/abstract))

```bibtex
@ARTICLE{2019AJ....158..243P,
       author = {{Pearson}, Kyle A.},
        title = "{A Search for Multiplanet Systems with TESS Using a Bayesian N-body Retrieval and Machine Learning}",
      journal = {The Astronomical Journal},
         year = 2019,
        month = dec,
       volume = {158},
       number = {6},
          eid = {243},
        pages = {243},
          doi = {10.3847/1538-3881/ab4e1c},
archivePrefix = {arXiv},
       eprint = {1907.03377},
 primaryClass = {astro-ph.EP},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2019AJ....158..243P}
}

@ARTICLE{2020PASP..132e4401Z,
       author = {{Zellem}, Robert T. and {Pearson}, Kyle A. and {Blaser}, Ethan and {Fowler}, Martin and {Ciardi}, David R. and {Biferno}, Anya and {Massey}, Bob and {Marchis}, Franck and {Baer}, Robert and {Ball}, Conley and et al.},
        title = "{Utilizing Small Telescopes Operated by Citizen Scientists for Transiting Exoplanet Follow-up}",
      journal = {Publications of the Astronomical Society of the Pacific},
         year = 2020,
        month = may,
       volume = {132},
       number = {1011},
          eid = {054401},
        pages = {054401},
          doi = {10.1088/1538-3873/ab7ee7},
archivePrefix = {arXiv},
       eprint = {2003.09046},
 primaryClass = {astro-ph.EP},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2020PASP..132e4401Z}
}

@ARTICLE{2022AJ....164..178P,
       author = {{Pearson}, Kyle A. and {Beichman}, Charles and {Fulton}, B.~J. and {Esposito}, Thomas M. and {Zellem}, Robert T. and {Ciardi}, David R. and {Rolfness}, Jonah and {Engelke}, John and {Fatahi}, Tamim and {Zimmerman-Brachman}, Rachel and et al.},
        title = "{Utilizing a Global Network of Telescopes to Update the Ephemeris for the Highly Eccentric Planet HD 80606 b and to Ensure the Efficient Scheduling of JWST}",
      journal = {The Astronomical Journal},
         year = 2022,
        month = nov,
       volume = {164},
       number = {5},
          eid = {178},
        pages = {178},
          doi = {10.3847/1538-3881/ac8dee},
archivePrefix = {arXiv},
       eprint = {2208.14520},
 primaryClass = {astro-ph.EP},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2022AJ....164..178P}
}
```

## Licence

MIT, see [LICENSE](LICENSE). Bundled data keep their own terms (catalogues, EXOTIC sample frames, published velocities); each example's README and the Methods page list the sources.
