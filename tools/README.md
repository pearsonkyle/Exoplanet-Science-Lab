# tools/

Scripts that build the data the site ships with, so that every page works offline from static files, plus a few
checks. Nothing here runs in the browser and nothing here is needed by `npm run dev` or `npm run build`: the outputs
are committed (`public/`, `src/data/`). Run everything from the project root.

| Script | Writes | Needs | Network |
|---|---|---|---|
| `build_catalog.py` | `public/catalog/` (index + 133 shards, 15 MB) | Python: requests, pandas, numpy | NASA Exoplanet Archive TAP |
| `build_catalog_table.py` | `public/catalog-table/nea.json`, `toi.json` | Python: requests, pandas, numpy | NASA Exoplanet Archive TAP |
| `build_catalog_eu.py` | `public/catalog-eu/planets.json` | Python: requests, pandas | exoplanet.eu |
| `build_esl_catalog.py` + `merge_esl_catalog.mjs` | `public/esl-catalog/catalog.json`, `manifest.json` | Python 3.10+ (standard library), Node 22; runs the three above unless `--no-download` | only through the three above |
| `build_sky_data.py` | `public/sky/` (stars, names, constellations, hosts) | Python standard library; `public/catalog/` | GitHub (d3-celestial data), cached |
| `build_ld_table.py` | `src/data/ld_table.js` (252 kB) | Python: ldtk, numpy, scipy, astropy; pylightcurve optional | PHOENIX files from Goettingen (about 530 MB, cached in `~/.ldtk`) |
| `build_ld_spectral.py` | `src/data/ld_spectral.js` (267 kB) | Python: numpy, astropy; the `~/.ldtk` cache filled by `build_ld_table.py` | none |
| `validation/make_*.py`, `validation/esl_reference.mjs` | `public/validation/*.json` | `.venv-validation` (batman, PyTransit, exoplanet-core, radvel, emcee, dynesty, UltraNest, ...), Node | none |
| `build_example_results.py` | `public/examples/results/<id>.json` | `.venv` with Playwright + Chromium; a running dev or static server | none |
| `build_core_bundle.mjs` | `python/esl/_core/`, `python/esl/_version.py` | Node (esbuild from `node_modules`) | none |
| `build_observatories.py` | `public/observatories/sites.json`, `land-110m.json` | Python: requests, timezonefinder | astropy-data, Minor Planet Center, Natural Earth (GitHub) |
| `crawl_observatories.py` | `public/observatories/resources.json` | Python: requests; `sites.json` | the observatories' own web sites (a polite crawl, about 5 minutes) |
| `compare_swarthmore.mjs` | nothing (prints a comparison) | Node; `public/catalog-table/nea.json` | none |
| `shot.py` | a screenshot | `.venv` with Playwright + Chromium; `npm run dev` | none |

`.venv-plan/bin/python` has requests, pandas and numpy and is the interpreter used for the catalogue builders below.

## Rebuilding everything the site needs offline

```sh
# 1  catalogues: download the three snapshots and merge them (the merge takes about 12 s; the downloads were
#    not timed through this script: on 2026-11-15 it was only run with --no-download)
.venv-plan/bin/python tools/build_esl_catalog.py
# 2  sky view: needs public/catalog from step 1
python3 tools/build_sky_data.py
# 3  limb darkening tables: only when the grid or the passbands change (the first run downloads 530 MB)
python tools/build_ld_table.py
python tools/build_ld_spectral.py
# 4  validation references: only when a model changes (see "Validation" for the environment)
# 5  observatories of the Plan page: the list (seconds), then the links (about 5 minutes; they go stale, so rerun it now and then)
python tools/build_observatories.py          # needs requests and timezonefinder
.venv-plan/bin/python tools/crawl_observatories.py
# 6  checks
npm test
node test/eslcatalog.test.mjs
```

Order matters in two places: `build_sky_data.py` and `build_esl_catalog.py --no-download` read `public/catalog/`,
and `build_ld_spectral.py` reads the cache `build_ld_table.py` fills. Steps 3 and 4 do not depend on the catalogues.

## Catalogues

The NASA Exoplanet Archive's TAP service and exoplanet.eu's CSV download send no CORS headers, so a page cannot
query them; the site reads snapshots instead. There are three snapshots and one merged catalogue built from them.

### `build_catalog.py`: every published reference

    .venv-plan/bin/python tools/build_catalog.py [--out public/catalog] [--target-kb 110] [--csv cached.csv]

Downloads the archive's `ps` table (Planetary Systems: one row per planet per published reference, not only the
default row) and writes `public/catalog/index.json` (names to shard, for autocomplete and lookup) and
`shard-NNN.json` (all rows of a group of hosts, about 110 kB each). Units are the archive's. `--csv` reads that
file instead of downloading when it exists, and writes it when it does not. Reader: `src/core/catalog.js`
(`loadIndex`, `lookupHost`, `chooseParameters`, `systemFromRows`, `suggestPriors`): the reference selection and the
priors of the analyzer work on these rows.

### `build_catalog_table.py`: one row per planet, and the TOIs

    .venv-plan/bin/python tools/build_catalog_table.py [--out public/catalog-table] [--cache DIR]

Writes `nea.json` (the archive's composite table `pscomppars`, each value with its own reference, plus the
best-timed ephemeris pair from `ps`: the reference whose P and T0 give the smallest predicted timing uncertainty
today, as `eph_per` / `eph_tmid`; and the period and epoch of the archive's default parameter set, the `ps` row
with `default_flag = 1`, as `def_per` / `def_tmid`, so that the Plan page can offer either) and `toi.json` (TESS Objects of Interest). `--cache DIR` keeps the downloaded CSVs and reuses them when
present. Reader: `src/core/sources/nea.js`, `toi.js` through `snapshot.js`. Used by the Search and Plan pages.

### `build_catalog_eu.py`: exoplanet.eu

    .venv-plan/bin/python tools/build_catalog_eu.py [--out public/catalog-eu] [--csv cached.csv]

Writes `planets.json` from the encyclopaedia's CSV download, in the same snapshot format, with its licence
(CC BY 4.0) and the acknowledgement it asks for stored in the file. There is no reference per value in that CSV.
Reader: `src/core/sources/eu.js`.

### `build_esl_catalog.py` and `merge_esl_catalog.mjs`: the ESL catalogue

    .venv-plan/bin/python tools/build_esl_catalog.py                 # the three builders above, then merge, then manifest
    .venv-plan/bin/python tools/build_esl_catalog.py --no-download   # merge the snapshots already under public/ (about 12 s)
    .venv-plan/bin/python tools/build_esl_catalog.py --check         # verify the files against manifest.json
    options: --cache DIR (handed to the builders; CSVs found there are REUSED, so use a fresh folder for fresh data),
             --public DIR, --out DIR, --node PATH, --with-toi

One versioned copy of both planet catalogues, merged, with estimates and priors for every planet, for use without
a network and without the other snapshot files:

- `public/esl-catalog/catalog.json` (6.8 MB, 2.0 MB gzipped): dictionaries and interned string tables at the top,
  then one compact record per planet. For each planet: name, host, which catalogues list it, the merged best values
  each with error, source catalogue and reference; limits; the gap-filled estimates each with the relation used,
  what it was built from and the note; the suggested priors (type, a, b, why), the reference they were centred on
  and the stellar reference.
- `public/esl-catalog/manifest.json`: format version, build time (UTC), software version, the date, row count and
  SHA-256 of each source snapshot, merged counts, the output files with byte sizes, gzip sizes and SHA-256, the
  licences and acknowledgements to reproduce, the schema, and the oddities met during the build.

The merge is JavaScript (`merge_esl_catalog.mjs`, Node 22) because it imports the site's own code instead of
repeating it:

| What | Code it calls |
|---|---|
| merged values, provenance, limits, estimates | `loadSources`, `buildTable` (`src/core/sources/index.js`) |
| priors of a planet in the NASA archive | `loadIndex`, `lookupHost`, `systemFromRows(rows, { use })` (`src/core/catalog.js`); `use` is `transit` for a transiting planet, `rv` for a non-transiting one with radial velocities, `all` otherwise |
| priors of a planet only in exoplanet.eu | `suggestPriors` on the merged row, each value marked `other` (catalogue value) or `derived` (estimate), so the `why` text says which |

Things to know when using it:

- The priors of a NASA-archive planet are centred on the reference `systemFromRows` chose (stored with the planet),
  which need not be the composite value in `values`. HAT-P-32 b: the period value is Kokori et al. 2023, the priors
  are from Wang et al. 2019.
- `catalog.json` depends only on the snapshots: no clock, no random numbers, rows sorted by name. Two runs on the
  same snapshots give the same bytes (checked: same SHA-256). `manifest.json` also carries the build time.
- Each snapshot file is read once (bytes, then hash, then JSON), so a snapshot rewritten during the merge cannot
  give a mixed state; `test/eslcatalog.test.mjs` fails with "stale" when a snapshot on disk is no longer the one in
  the manifest.
- Periods, mid-transit times and their errors are stored exactly; other values to 12 significant digits, errors to
  10, estimates and prior bounds to 9 (priors on P to 15, on T_mid to 16).
- Not stored: the time-dependent `drift` column, the disagreements between catalogues, the match stage and the
  text explaining why a reference won. Those need the snapshots and the site code.
- TESS Objects of Interest are left out by default: with them the file is 14.0 MB (4.2 MB gzipped), they are
  pipeline estimates without references, and `toi.json` already serves them offline. `--with-toi` includes them.
- Priors that `suggestPriors` returns but no sampler can use (a uniform prior with min >= max) are dropped and
  listed in the manifest under `oddities.unusablePriors`. In the 2026-11-15 snapshots there are 12, all for objects
  only in exoplanet.eu: an inclination above 92 deg (the prior runs "up to 90 deg"), an eccentricity above 1 (the
  interstellar objects 1I, 2I, 3I) and one negative K. Five objects have no priors at all: free-floating
  microlensing objects and the like, with no orbit or star to centre one on.

Reader: `src/core/sources/eslcatalog.js`, no imports and no DOM (the file layout is documented at its top):

```js
import { readEslCatalog } from './src/core/sources/eslcatalog.js';
const cat = readEslCatalog(JSON.parse(text));
const p = cat.get('hat-p-32b');      // also finds 'HAT-P-32 Ab', the exoplanet.eu name
p.values.per; p.errors.per; p.src.per; p.ref.per; p.refUrl.per;
p.est.K;            // { value, rel, relation, cite, from, note, chain } when K is an estimate
p.priors.rprs;      // { type: 'uniform', a, b, why }
p.priorsFrom;       // { basis: 'transit', reference, referenceUrl, star, starUrl }
```

Test: `node test/eslcatalog.test.mjs` (2 s). It compares every value, error, source, reference, limit and estimate
of every planet with the live `buildTable`, the priors of nine named planets and of every 21st planet with the
live `systemFromRows` / `suggestPriors`, and the manifest's checksums, sizes and counts with the files.

## Sky view

### `build_sky_data.py`

    python3 tools/build_sky_data.py [--cache DIR] [--maglim 8.0]

Writes `public/sky/stars.bin` (stars to V = 8, 16 bytes each), `starnames.json`, `constellations.json` and
`hosts.json` (position, V, number of planets, TESS candidates, and Teff, distance, spectral class and transit flag of every host star, from the local nea.json and toi.json snapshots). Stars, names and constellation lines come
from the data folder of d3-celestial (BSD 3-Clause, Olaf Frohn; stars from XHIP, Anderson & Francis 2012); the
hosts come from `public/catalog/`, so run it after `build_catalog.py`. Standard library only; downloads are cached
in `$TMPDIR/esl-sky-cache`.

## Limb darkening

### `build_ld_table.py`

    pip install ldtk numpy scipy astropy            # pylightcurve is optional: measured passband responses
    python tools/build_ld_table.py [--out src/data/ld_table.js] [--json ld_table.json] [--no-jwst] [--boxcar] [--plain]

Integrates the PHOENIX-ACES specific intensities of Husser et al. (2013) over 37 passbands for every
(Teff, log g, [Fe/H]) node and stores the four Claret coefficients. Downloads the "lowres" files (about 530 MB,
kept in `~/.ldtk`). The method and what was measured are in its docstring; the comparison with ExoTETHyS is
`test/limbdark.test.mjs`.

### `build_ld_spectral.py`

    python tools/build_ld_spectral.py [--out src/data/ld_spectral.js] [--res 120] [--ncomp 40] [--explore]

The same models in 357 wavelength bins from 200 to 5500 nm, compressed to 40 principal components, so the app can
make coefficients for any band. Reads the `~/.ldtk` cache only: run `build_ld_table.py` first on a machine that
does not have it. About 10 s. Needs numpy and astropy. Accuracy: `test/ldspec.test.mjs`.

## Validation

`tools/validation/` builds the references of the `/validation/` page under `public/validation/`. The generators
import no ESL code; they need `.venv-validation` (batman, PyTransit, exoplanet-core, PyAstronomy, ellc,
pylightcurve, radvel, mpmath, scipy, emcee, dynesty, UltraNest) and, for two codes, separate interpreters whose
paths are in `make_transit_util.py` (pyaneti in `.venv-validation/pyaneti-env`, EXOTIC in a conda environment).

| Script | Writes | Time |
|---|---|---|
| `validation/make_transit.py` | `transit.json`: light curves of every code against a quadrature truth | about 2 min |
| `validation/make_orbit.py` | `orbit.json`: Kepler's equation, periastron and eclipse times, durations (30-digit truth) | |
| `validation/make_rv.py` | `rv.json`: radial-velocity curves, sign and omega conventions | |
| `validation/make_fits.py` | `fits.json`: parameter recovery with emcee, dynesty and UltraNest on the same likelihood | about 10 min |
| `validation/esl_reference.mjs` | `esl.json`: ESL's own fits, coverage, timing and test outcomes (Node; run after the four above) | about 8 min |

    .venv-validation/bin/python tools/validation/make_transit.py     # likewise make_orbit, make_rv, make_fits
    node tools/validation/esl_reference.mjs

Helpers, not run directly: `common.py` (truth orbit and flux), `codes.py` (one adapter per external code),
`make_transit_util.py`, `ext_pyaneti.py`, `ext_exotic.py`, `ext_isolated.py` (run a code in its own interpreter or
process). Checked by `test/validation.test.mjs`.

## Other builders

### `build_example_results.py`

    .venv/bin/python tools/build_example_results.py [id ...]

Runs every worked example of the analyzer in a headless browser and stores the finished session under
`public/examples/results/<id>.json`, so an example opens with its results. Needs Playwright with Chromium and a
server: `npm run dev` (port 5173) or a built copy served statically with `ESL_BASE=http://localhost:8899`.

### `build_core_bundle.mjs`

    node tools/build_core_bundle.mjs [--check] [--release] [--out dir]

Bundles `src/core` into one script for the Python package (`python/esl/_core/`), which executes it, so its numerics
are the web application's. `--check` exits 1 when the committed bundle is not what the sources give. Not needed by
the site.

## Checks

### `compare_swarthmore.mjs`

    node tools/compare_swarthmore.mjs [test/swarthmore_reference.csv]

Compares the planner with the Swarthmore transit finder for one site and week: the calculation with the finder's
own ephemerides, and end to end with ESL's catalogue (`public/catalog-table/nea.json`), including how the finder's
events fall into ESL's classes (observable over the whole region of interest, complete with a short baseline,
partial) with the finder's limits and with ESL's defaults. Prints; writes nothing.

### `shot.py`

    .venv/bin/python tools/shot.py <path-or-url> <out.png> [width height] [--wait ms] [--eval "js"] [--click "css"]

Headless screenshot and console check of a page of the running dev server (`npm run dev`, port 5173). Exit code 1
when the page threw.

## Observatories

The Plan page's globe, observatory menu and site panel read three files in `public/observatories/`. Run the list
builder first: the crawler reads its output.

### `build_observatories.py`: the list and the coastlines

    python tools/build_observatories.py [--out public/observatories] [--cache DIR]

Needs `requests` and `timezonefinder` (not in `.venv-plan`: `pip install requests timezonefinder` in any
environment). Writes

- `sites.json`: 89 observatories (2026-11-15). Nothing is typed from memory: coordinates and elevations come from
  the astropy site registry (`astropy-data` `coordinates/sites.json`, the data behind
  `EarthLocation.get_site_names()`, mostly the IRAF observatory database; 43 sites) and from the Minor Planet
  Center's observatory codes (`ObsCodes.html`; 46 sites), whose parallax constants are converted to geodetic
  latitude and height on WGS84. What is curated in the script (`SELECT`) is which observatories to show, their
  display names, their kind (professional, network node, remote hosting) and their networks (LCO, MicroObservatory,
  iTelescope, ESO, NOIRLab, TRAPPIST, SPECULOOS ...). Time zones are looked up from the coordinates with
  `timezonefinder`, because astropy's labels are wrong for five Arizona sites ("US/Mountain", which has daylight
  saving time); the output notes each such correction.
- a self-check, printed and stored in `sites.json` (`check`): 18 observatories that are in both lists are converted
  from their MPC constants and compared with astropy. On 2026-11-15: 17 agree within 1.6 km horizontally (different
  telescopes on one mountain) and the elevations within 60 m except Las Campanas (+103 m), Cerro Tololo (+165 m) and
  Whipple (+308 m, ridge against summit). The 18th is astropy's `haleakala`, 9 km east of every MPC station on
  Haleakala: the MPC position is used for it. Elevations of MPC sites are rounded to 10 m and are good to a few
  tens of metres at best; the planner uses elevation only for the Moon's parallax.
- `land-110m.json` (46 kB): the Natural Earth 1:110m land polygons (public domain) as rings in tenths of a degree,
  for the globe.

`--cache DIR` keeps the three downloads and reuses them.

### `crawl_observatories.py`: archives, all-sky cameras, weather pages

    .venv-plan/bin/python tools/crawl_observatories.py [--only id,id] [--delay 2] [--log FILE]

For every observatory in `sites.json` it starts from a short seed list in the script (`SEEDS`, and `NET_SEEDS`
for pages shared by a network), fetches each seed once, and on that page only looks for links whose text says
archive, all-sky or weather; each such link is fetched once. Only what answers HTTP 200 on the day and mentions its
subject is written to `resources.json`, with the date, the status, the frame headers (`X-Frame-Options`, CSP
`frame-ancestors`) and, for an all-sky image, what decides whether it may be shown inline: https, the answer to a
request carrying another site's Referer, `Cross-Origin-Resource-Policy`, CORS, and the age from `Last-Modified`.

Manners: robots.txt obeyed per host, one request at a time per host with 2 s between them, GET only, no forms or
logins (a page with a password field is dropped), 400 kB of a page and 2 kB of an image at most, a User-Agent that
names the project and has no personal contact details. A full run is about 470 requests in 5 minutes.

The Plan page embeds an all-sky image only when the headers allow it, it is under 48 h old, robots.txt allows it
AND the host is in `TERMS` with an open licence found on its terms page that day (ESO and NOIRLab, CC BY 4.0).
Everything else is a link. The seeds are guesses until a request confirms them, and many do not (see `--log`):
add or correct seeds in the script, then `--only id,id` recrawls those sites and merges them into the file.
