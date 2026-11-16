# Roadmap

Order follows the owner's plan. Each stage ends with a validation against published work before the next begins.
Status as of 2026-11-16 (README and the Methods page have the numbers).

| Stage | State | Still to do |
| --- | --- | --- |
| Single transit, limb darkening | done | measured JWST/Ariel throughputs (bands are top-hats); per-dataset limb darkening |
| Several transits, ephemerides, timing periodogram | done | per-epoch mid-times feeding the Timing tab from a joint fit; BLS / TLS on long light curves |
| Several planets, velocities, joint fits | done, with archive RVs (VizieR) | DACE and more archives (CORS); RM per-dataset options and a full line-profile model (the CCF Gaussian-fit form is done); UI for the physical priors and alias scan; the real TOI-1873 data |
| Eclipses, phase curves, eclipse maps | done | multi-band; systematics fitted with the map (positive-map prior done: `phase.positive_map`) |
| Exomoons | done (model, search, example, 3D view) | detection limits as a product; eccentric moon orbits |
| N-body | done: times, velocities, light curves, eclipses, MEGNO, mean elements | mutual events; companion-search mask from the simulated O − C (period aliases: categorical `nalias` done) |
| Photometry and detrending | done: regressors, PLD, kernel, weighted ensemble, AAVSO report | plate solving (needs a key); calibration frames against a reference; HCOMPRESS |
| Time-series spectroscopy (JWST, Ariel) | done for extracted 1-D spectra | the 202 ppm offset on WASP-39 b; PRISM; HST/WFC3; spectral extraction from images |
| Plan, Observe, Search | done, with TOIs, eclipses/phase windows, terrain, WebXR | real-device AR and WebXR; merge `astro.js` and `observability.js`; a shared `tz` parameter |
| Methods and validation | done (one page, 98 references) | wire the remaining hand-typed numbers in `src/methods/content.js` to the stored test output |
| Sessions, exports, Python package | done | publish the package; release build in CI |
| Assistant and MCP | done against one local model | a larger model; Safari/Firefox; a real https deployment of the presets |

Next, in the owner's order:

1. A person runs the "Not verified" list of HANDOFF.md on real devices (Quest and phone checklists there).
2. Hosting at exoplanet.science: choose the host, an https front end for the assistant's model server, a
   scheduled rebuild of the catalogue snapshots, and a licence file.
3. Split `src/main.js` into per-tab modules (docs/ARCHITECTURE.md) before more analyzer features.
4. **Later, by the owner's decision:** community features (accounts through a git host, shared results and
   plug-ins, review of contributed analyses). The session format, the saved-analysis store and the export
   bundle were standardised first so that these have something stable to exchange.
