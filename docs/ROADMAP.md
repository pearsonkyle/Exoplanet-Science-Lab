# Roadmap

Order follows the owner's plan. Each stage ends with a validation against published work before the next begins.
Status as of 2026-11-15 (README has the numbers).

| Stage | State | Still to do |
| --- | --- | --- |
| Single transit, limb darkening | done | JWST instrument throughputs for the limb-darkening table; per-dataset limb darkening |
| Several transits, ephemerides, timing periodogram | done | per-epoch mid-times feeding the Timing tab from a joint fit; BLS / TLS on long light curves |
| Several planets, velocities, joint fits (EXOTIC's examples) | done | stellar priors on by default; the real TOI-1873 data |
| Eclipses, phase curves, eclipse maps | done (model, fits, views, three examples) | instrument systematics (pixel-level decorrelation) fitted with the map; map priors that forbid negative brightness; multi-band |
| Exomoons | done (model, search, example) | the moon in the 3D view; detection limits as a product; eccentric moon orbits |
| N-body | done for times and velocities | photodynamics (light curves from the integration); mid-eclipse times; MEGNO; a sampler move that crosses period aliases |
| Photometry | done on EXOTIC's sample data | real frames from more telescopes; calibration frames against a reference; HCOMPRESS; plate solving |
| Plan, Observe, Search | done | merge `astro.js` and `observability.js`; archive-data counts per target; a `tz` parameter shared by Plan and Observe; real-device AR and WebXR |
| Sessions, saved analyses, exports, Python package | done | publish the package; a release build of the bundle in CI; TypeScript types for the session format |
| Assistant and MCP | done against one local model | fill the gaps in `window.__esl.api` (HANDOFF); try other servers; a JSON-in-text fallback checked on a real server |

Next, in the owner's order:

1. A person runs the "Not verified" list of HANDOFF.md on real devices.
2. Split `src/main.js` into per-tab modules (docs/ARCHITECTURE.md) before more analyzer features.
3. Photodynamics and instrument systematics, the two models whose absence limits what real data can be fitted.
4. Hosting at exoplanet.science: scheduled rebuild of the catalogue snapshots, licence file.
5. **Later, by the owner's decision:** community features (accounts through a git host, shared results and
   plug-ins, review of contributed analyses). The session format, the saved-analysis store and the export
   bundle were standardised first so that these have something stable to exchange.
