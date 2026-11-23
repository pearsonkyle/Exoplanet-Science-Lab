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
| Atmosphere forward model | done: transmission and emission from T-P profile and composition, twelve gases (H2O, CO2, CO, CH4, NH3, HCN, SO2, H2S, Na, K, TiO, VO); clouds and hazes (deck, power law, Rayleigh factor, particle layer, patchy cover); 2D plots; ray-marched 3D planet in true or mapped colour; profiles from the gases with inversions; condensation with rain-out; tholin haze, nitrogen atmospheres, Titan and Jupiter presets; Python and MCP access | retrieval (the model now runs in 26 ms over a JWST range); a climate-code comparison; clouds with physics; see below |
| Plan, Observe, Search | done, with TOIs, eclipses/phase windows, terrain, WebXR | real-device AR and WebXR; merge `astro.js` and `observability.js`; a shared `tz` parameter |
| Methods and validation | done (one page, 149 references) | wire the remaining hand-typed numbers in `src/methods/content.js` to the stored test output |
| Sessions, exports, Python package | done | publish the package; release build in CI |
| Assistant and MCP | done against one local model | a larger model; Safari/Firefox; a real https deployment of the presets |

Atmosphere, done on 2026-11-20 (the forward model is `src/core/rtmodel.js`; numbers in docs/guide/validation.md):

- **Inversions**: the self-consistent profile's energy closure is now a level factor on T⁴, so inverted profiles
  settle (WASP-121 b's day side with TiO and VO: +255 K between 22 and 1.8 mbar). Clouds enter the profile.
- **Condensation with rain-out** (`condensation.js`): water, ammonia, methane by vapour pressure; TiO, VO, Na, K by
  the condensation curves of perovskite, Na2S, KCl; cloud bases for ten solids; the cold trap.
- **Titan and other bulk gases**: N2-N2, N2-CH4 and N2-H2 collision-induced absorption (HITRAN); a Mie code and
  Khare's tholin constants (`mie.js`, `optical.js`); a particle layer with a material and a vertical power law;
  preset worlds (`worlds.js`: WASP-39 b, WASP-121 b's day side, Jupiter, Titan).
- **Speed**: WebAssembly mixing kernel (`tools/wasm/mix.rs`), tables cut and coarsened (`prepareTables`), mixed
  results cached: 274 ms to 26 ms for a model over 0.6 to 5.3 µm.
- **Reading the plots, and taking the model away** (2026-11-20): legends list only what is present and wrap; hover
  or tap picks a curve out; ions are dashed in their atom's colour; the colour-matching functions are drawn over the
  spectra the colour is made from; "Download everything" gives a zip with the model, every plotted quantity as CSV
  (opacity by absorber at one level per decade of pressure) and a script that redraws the figures.
- **Access**: `esl.atmosphere()` in Python, `atmosphere_spectrum` in the MCP server, both through `atmoapi.js`.
- **A second independent audit**: nine defects fixed (listed in the validation notes).

Stars from their light (started 2026-11-20; `src/core/stellarspec.js`, `public/stellar/phoenix.esls`):

- **Done**: a grid of surface fluxes (519 models, Teff 2300-8000 K, log g 4-5.5, [Fe/H] -0.5 to +0.5, 0.1-5.5 µm at
  R about 105, 0.5 MB) made from the same PHOENIX-ACES intensity files as the limb darkening table, by integrating
  them over the disc; interpolation, resampling with an infrared tail, photon-counting synthetic photometry, the
  bolometric flux and the dilution (R/d)². The atmosphere model uses it for eclipse depths in place of a blackbody.
- **SED fitting, done 2026-11-20** (`src/core/sed.js`, the Star page, `esl.star_fit` in Python): Teff, log g,
  [Fe/H], angular diameter, extinction and a scatter term from catalogue magnitudes in 31 passbands (SVO), with
  Fitzpatrick's extinction law and the nested sampler; radius and luminosity with a parallax. Against
  interferometry: three of four stars within 2% in diameter and 40 K; HD 189733 off by 7% and 152 K, as
  AstroARIADNE's published fit is. MCP tools `star_fit` and `star_match_spectrum`. Next, in order: fetch the magnitudes from VizieR by name (needs the
  CDS services' cross-origin access checked; they were down); AstroARIADNE run on the same photometry, not only
  its published table; more model grids and its Bayesian averaging (BT-Settl, Castelli-Kurucz: several GB and their
  licences); a dust-map prior on A_V; giants and hot stars (the limb-darkening files stop at log g 4 and 8000 K
  here: more of the same PHOENIX files would extend it); MIST isochrones for mass and age; the result feeding the
  star's radius, temperature and limb darkening on the other pages; an MCP tool.
- **Spectrum matching, done for low resolution 2026-11-20** (`src/core/specmatch.js`, the MCP tool
  `star_match_spectrum`): the grid times a smooth factor against a spectrum of R up to about 100. Tested on synthetic
  spectra only. Next: an observed spectrum (Gaia XP or SpeX of a benchmark star) as a real test; a place for it on
  the Star page, fitted jointly with the magnitudes; then the high-resolution route that SpecMatch-Emp and
  NEIDSpecMatch take, which needs PHOENIX's high-resolution files cut to chosen orders, or an empirical library,
  with rotational broadening, continuum normalisation and the instrument's line spread.
- **One star for every fit** (the owner's point, 2026-11-20: what made HD 80606 work was one orbit and one star
  under the transit and the radial velocities). Done: one PHOENIX grid under limb darkening, eclipse depths, SED and
  spectrum fits. To do: a star fitted on the Star page written into the session (`S`, through `pushUndo()`), so that
  `buildProblem` takes its radius, temperature, gravity and metallicity, with their errors as priors, and the limb
  darkening follows from the same values; the 3D star colour and the ionizing flux from the grid too; and the
  atmosphere retrieval, when built, as a block of `buildProblem` beside the transit and radial-velocity terms, on the
  same orbit.
- **AstroARIADNE run on the same photometry**: held to the end, at the owner's request.

Assistant and MCP on the new pages (2026-11-20): the Atmosphere and Star pages declare their tools (get, set, load a
world, look up, spectrum; get, look up, set, export). Next: scripted dialogues for them in `test/assistant.test.mjs`
and the fine-tuning set. Done 2026-11-23: retrieval as one call (`retrieveAtmosphere` in `src/core/atmoapi.js`)
behind the MCP tool `atmosphere_retrieve`, Python's `esl.retrieve_atmosphere` and the assistant's
`atmosphere_fit_spectrum` on the Atmosphere page (data drawn on the spectrum, model set to the fit). Still to
come: a Retrieval page with the corner plot, and a scripted dialogue for the new tool.

Retrieval and simulated observations (started 2026-11-20):

- **Done**: `src/core/retrieval.js` (free parameters with the priors of `priors.js`, MiniNest, ln Z comparison,
  transit + eclipse + night-side spectra together); Ariel's noise from ArielRad's published recipe, within 8% of its
  photon noise for HD 209458; an end-to-end example on simulated Ariel data (`tools/examples/ariel_retrieval.mjs`).
- **Joint fits finished** (2026-11-20): transit + three eclipses + night side converge with a budget of 400,000
  models (96,000 and 227,000 used; 38 and 85 min on one core; rerun 2026-11-23) and return every parameter within 3σ, the night-side
  contrast to 14 to 28 K. Twelve more noise draws (2026-11-21) show no bias in any parameter (the 2.5σ in κ_IR was
  chance). Looked open, was chance (below): over those draws [M/H] and C/O scatter 1.4 to 1.5 times their quoted errors and their 68% ranges
  hold the truth 5 times of 12. 400 live points and slice sampling alone at four times the steps change nothing: it is not
  the sampler. Found on the way: the chemistry table's linear interpolation made the model's sensitivity to C/O
  jump at every node; [M/H] and C/O are now interpolated by a monotone cubic (nearer FastChem: 0.018 against 0.028
  dex rms off the nodes). The twelve draws repeated with it (2026-11-22) are unchanged; 28 more draws then showed
  the excess to be chance: over forty, [M/H] scatters 1.05 ± 0.12 and C/O 1.13 ± 0.13 times the quoted error and
  both ranges hold the truth 27 times (27.2 expected). **Closed.** Seen instead with forty: medians of Teq, κ_IR,
  γ, [M/H], C/O sit 0.3 to 0.5σ to one side (log γ 3.1σ of the mean); tested 2026-11-23 with the best-fit points and a noise-free fit: the fit itself
  has no offset (noise-free medians within 0.1σ, log γ −0.23 from its skew); Teq, κ_IR, γ are partly the median's
  shape; [M/H] and C/O's −0.4σ is not shape or prior, so chance (2.5σ) or second order in the noise. Telling those
  apart needs a hundred or more further draws: only worth it if fits are to be stacked;
  models in parallel workers, since an hour a fit is too slow for a page.
- **Next, in order**: (1) the retrieval as a block of `buildProblem`, so that spectra are fitted with the light
  curves they came from, on the one orbit and star (the HD 80606 pattern); (2) a Retrieval page, with the corner
  plot and tables the Star page now has; (3) the example carried through the light-curve stage: simulate the Ariel
  cube with `simulateSpectroscopy`, reduce it on the Spectroscopy page's code, retrieve from that spectrum, and
  simulate a full phase curve fitted with the phase-curve model for the night side; (4) models in parallel workers.
- **Simulator fidelity**: detector read noise, dark current, jitter and the efficiency's fall at band edges for
  Ariel (ArielRad fig. 4 has each term; the red edge of AIRS-Ch1 is 29% too quiet without them); JWST modes tested
  against the measured WASP-39 b precisions (G395H 221 ppm per 10-pixel bin, PRISM median 99 ppm); correlated noise
  and stellar activity as options; ExoSim-like time-domain systematics. ArielRad itself is not public; PandExo
  needs STScI's reference files (several GB): running either is a decision for the owner.
- **Retrieval physics to add**: free temperature-pressure points; the self-consistent profile inside a retrieval
  (costly: 6 to 10 models per profile); patchy clouds and the particle layer as parameters with sensible priors;
  error inflation and offsets between instruments (offsets exist); a retrieval on real JWST spectra as the test
  that the model's assumptions hold.

Atmosphere, next steps:

- **Opacities, after the sodium finding** (2026-11-20: Na and K line cores in the source tables were up to 1e5 times
  too strong at low pressure; repaired at build time): (1) tell ExoMol; (2) our own Na and K from a line list and
  Allard's published profiles, instead of a repaired table; (3) the same sum-rule audit for every new gas before it
  ships (it is a test now for Na and K); (4) water loses up to 40% of its strength at 1e-5 bar and 500 K in the
  source: quantify what that does to a cool planet's spectrum; (5) a high-fidelity mode beside the fast one:
  R = 1000 tables with 16 g-points (the source resolution; about 10 MB per gas) or line-by-line for chosen bands,
  selectable per run, so that papers can quote the difference between the two.

- **The upper atmosphere** (above 1e-5 bar the profile is now only held): a thermosphere heated by the star's extreme
  ultraviolet, with hydrogen dissociated and ionized by it and the escaping wind above (the pieces are in
  `ionization.js` and `escape.js`, unconnected to the temperature); resonance-line scattering for Na and K with a
  measured quenching rate, in the heating and in the emission spectrum; opacity tables that reach below 1e-5 bar.
  This is what the cores of the strongest transit lines see, so it bears on Na, K and He 1083 nm measurements.

- **Retrieval, the next piece of work**: everything it needs is now in place. A model worker pool (several models
  at once: the remaining speed factor), then the `spec.spectra` block below. Parameters that already exist and are
  few: Teq or a level offset, Tint, f, [M/H], C/O, quench pressure, saturation allowed, deck pressure, particle
  optical depth, grain size and spread, cover fraction, night-side contrast.
- **Solar system, next**: Titan against a Cassini VIMS occultation spectrum and a CIRS thermal spectrum rather than
  three published numbers; fractal-aggregate haze optics (Tomasko et al. 2008) in place of spheres; nitrogen
  dissolved in methane condensate; C2H2, C2H6 and HCN emission in the stratosphere; the 3D view against a Cassini
  image. Jupiter and Saturn with NH4SH; Venus and Mars (CO2-CO2 collision-induced absorption is on HITRAN; a
  sulfuric-acid cloud needs its optical constants); Earth (O2, O3, N2-O2).
- **Clouds with physics**: optical constants for MgSiO3, Mg2SiO4, Fe, KCl, Na2S, H2O and NH3 ice from the same
  compilation as the tholin, so that a cloud at a condensate's base has that condensate's colour; then a
  sedimentation efficiency (Ackerman & Marley 2001) so that its thickness and grain size follow too.
- **Chemistry after condensation**: solve the equilibrium again without the condensed elements (the oxygen that
  silicates take from water), which needs the chemistry solved live or a condensed-phase FastChem grid.
- **Cold opacities**: the tables stop at 100 K and the far infrared at 50 µm; Titan and the ice giants want methane
  below that and the N2-N2 band peak beyond.
- **More speed, in order of gain**: a pool of workers; the cross-section interpolation in WebAssembly (now a
  third of a fast run); float32 caches (half the memory); a GPU path only for transmission and emission of many
  models at once (the mixing is a sort and does not suit it).
- **Retrieval**: a `spec.spectra = [{ wl, lo, hi, depth, err, kind }]` block in `buildProblem` (`src/core/model.js`),
  an `ATM_PARAMS` registry, log-uniform abundance priors, run by `runFit` / `MiniNest`. One model takes about
  220 ms with the shipped tables and four gases, 870 ms with all twelve; a table at R = 91 with 8 g-points takes
  about 40 ms (`tools/opacity/study.py`, `e91g8`), and 8 g-points with the log-mean reduction cost 4 to 8 ppm.
- **Chemistry, done 2026-11-19**: equilibrium from a FastChem grid (`src/core/chemistry.js`), with a quench level;
  H- opacity is now live when the chemistry supplies H, e- and H-. Next: the star's measured abundances (C/O, not
  only [Fe/H]) as the starting composition.
- **Temperature profile from the gas, done as an energy-balanced grey closure** (`src/core/climate.js`). Next:
  the picket-fence correction of Parmentier & Guillot (2014) for the upper layers; a comparison with a
  radiative-convective code (PICASO or HELIOS) on three planets; then, if the patience is found, the full thing:
  two-stream fluxes at every level and a temperature correction until each layer's net flux is constant.
- **Retrieval, then learned priors (the owner's direction, 2026-11-20)**: first the best physical forward model
  with few parameters (equilibrium temperature, internal temperature, metallicity, C/O, cloud parameters, night-side
  contrast), then retrievals on it through `buildProblem` and `MiniNest`. After that, speed: a grid of simulations
  (and, where users agree, their fitted results) to train an estimator that proposes priors or initial posteriors for
  a new data set, and stochastic variational inference in the manner of Pyro as a fast alternative to nested
  sampling, each checked against the full sampler before it is trusted. Starting compositions from the host star's
  measured abundances (the Hypatia Catalog), which needs the chemistry solved live rather than read from a
  two-axis table.
- **Day and night, done as an interpolation**: three columns (`dayNightModel`); next a phase curve from them, and
  separate morning and evening limbs.
- **Ionization, done for H, Na and K** (Verner's `phfit2.f` is in `data-src/verner/` and holds every atom to zinc,
  should the chemistry gain more free atoms): next published recombination and electron-impact rates for potassium,
  photodissociation of the molecules (Leiden cross-sections), and a measured stellar ultraviolet spectrum.
- **Escape, in the code but off the page**: energy-limited loss, crossover mass, Rayleigh enrichment over the
  star's age, sodium ionization (`escape.js`, `ionization.js`). Next, in order of what data can test: the helium
  1083 nm and Lyman-alpha transit depths implied by the outflow (what JWST NIRSpec and HST measure); a measured
  XUV spectrum (MUSCLES) in place of the solar law and the blackbody; potassium; a radius that evolves with the
  envelope. Not planned without a hydrodynamic code to compare with: haze production from photolysis, and a
  temperature profile that responds to escape.
- **Radiative-convective profiles**, scattering in emission, Mie clouds, a stellar spectrum grid instead of a blackbody
  (its licence first), the model's limb ring in the analyzer's own 3D view (`haloFrag` in `src/viz/shaders.js`).
- **A planet that is not the same all round**: the 3D view lights a one-dimensional atmosphere, so the night side
  glows like the day side. Two columns (day and night profiles, as `guillot` with f = 1/2 and an internal-heat
  night) would give the view a thermal terminator and the spectra a limb asymmetry.
- **Data on the model**: overlay an observed spectrum (the Spectroscopy page's result, or a file) on the model
  spectrum with the instrument's range marked, and colour the 3D view from that range by default.
- **Multiple scattering and refraction** in the 3D view (the limb ring brightens and widens with refraction).

Next, in the owner's order:

1. A person runs the "Not verified" list of HANDOFF.md on real devices (Quest and phone checklists there).
2. Hosting at exoplanet.science: choose the host, an https front end for the assistant's model server, a
   scheduled rebuild of the catalogue snapshots, and a licence file.
3. Split `src/main.js` into per-tab modules (docs/ARCHITECTURE.md) before more analyzer features.
4. **Later, by the owner's decision:** community features (accounts through a git host, shared results and
   plug-ins, review of contributed analyses). The session format, the saved-analysis store and the export
   bundle were standardised first so that these have something stable to exchange.
