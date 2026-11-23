# Opacity tables

`build_opacity.py` turns ExoMolOP k-tables and HITRAN collision-induced absorption into the ESLO files the
Atmosphere page loads from `public/opacity/` (format: the header of `src/core/opacity.js`). `study.py`,
`study.mjs` and `study_single.mjs` measure what resolution, g-points, encoding and grid cost in accuracy, size
and speed; `mixing_study.mjs` what combining species two at a time costs against random overlap done in one
step; `interp_study.py` and `interp_study.mjs` how a table should be interpolated in temperature (results in
`docs/guide/validation.md`, "Atmosphere").

## Environment

`.venv-rt` (Python 3.12): numpy, scipy, h5py, exo_k, pyfastchem, colour-science, petitRADTRANS 3.4.0.

```bash
uv venv --python 3.12 .venv-rt
uv pip install --python .venv-rt/bin/python numpy scipy h5py meson-python ninja exo_k pyfastchem colour-science
SDKROOT=$(xcrun --show-sdk-path) uv pip install --python .venv-rt/bin/python --no-build-isolation petitRADTRANS
```

On macOS Homebrew's gfortran cannot link without `SDKROOT` ("ld: library 'System' not found"). petitRADTRANS
tries to load MPI on import; the scripts set its own switch `pRT_emcee_mode=True` so none is needed. Importing it
creates `~/.petitradtrans/petitradtrans_config_file.ini`.

## Source files (untracked, in `data-src/`)

From `https://www.exomol.com/db/<path>` (ExoMolOP, Chubb et al. 2021; CC BY-SA 4.0), about 389 MB each:

| Species | Path under /db/ |
| --- | --- |
| H2O | `H2O/1H2-16O/POKAZATEL/1H2-16O__POKAZATEL__R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| CO2 | `CO2/12C-16O2/UCL-4000/12C-16O2__UCL-4000.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| CO | `CO/12C-16O/Li2015/12C-16O__Li2015.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| CH4 | `CH4/12C-1H4/YT34to10/12C-1H4__YT34to10.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| NH3 | `NH3/14N-1H3/CoYuTe/14N-1H3__CoYuTe.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| HCN | `HCN/1H-12C-14N/Harris/1H-12C-14N__Harris.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| SO2 | `SO2/32S-16O2/ExoAmes/32S-16O2__ExoAmes.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| H2S | `H2S/1H2-32S/AYT2/1H2-32S__AYT2.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| TiO | `TiO/48Ti-16O/Toto/48Ti-16O__Toto.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| VO | `VO/51V-16O/VOMYT/51V-16O__VOMYT.R1000_0.3-50mu.ktable.petitRADTRANS.h5` |
| Na | `Na/23Na/Kurucz-Na/23Na__Kurucz-Na.R1000_0.3-50mu.ktable.petitRADTRANS.h5.gz` (314 MB; gunzip) |
| K | `K/39K/Kurucz-K/39K__Kurucz-K.R1000_0.3-50mu.ktable.petitRADTRANS.h5.gz` (321 MB; gunzip) |

All twelve share one grid: 22 pressures (1e-5 to 100 bar), 27 temperatures (100 to 3400 K), 5115 bins, 16 g-points.
The server stalls on long transfers; `curl -C - --retry 30 --retry-all-errors --speed-limit 200000 --speed-time 20`
reconnects and resumes, and several files can be fetched at once.

They go in `data-src/exomol/`. The study also uses the R = 15000 cross-sections of the first four species
(`...R15000_0.3-50mu.xsec.TauREx.h5`, 365 MB each, same folders on the server); building the shipped tables does not.

From `https://hitran.org/data/CIA/main/`: `H2-H2_2011.cia` (25 MB) and `H2-He_2011.cia` (147 MB), into
`data-src/hitran-cia/`; for nitrogen atmospheres also `N2-N2_2021.cia` (5.7 MB), `N2-CH4_2024.cia` (6.5 MB) and
`N2-H2_2024.cia` (0.45 MB), built with `build_opacity.py --cia N2-N2 N2-CH4 N2-H2` (each band is interpolated within
its own temperatures). Tholin optical constants: `Titan_tholin.dat` (Khare et al. 1984, from the compilation of
Kitzmann & Heng 2018 at github.com/NewStrangeWorlds/LX-MIE) into `data-src/tholin/`, then `build_optical.py`.
Speed: `node tools/opacity/speed_study.mjs`; the WebAssembly kernel is built by `tools/wasm/build.sh`.
`data-src/hitran-cia/`. HITRAN states no redistribution licence on its site: decide before committing
`public/opacity/H2-H2.eslo` and `H2-He.eslo` (0.3 MB together), or build them at deploy time.

To add a molecule: find its page under `https://www.exomol.com/data/data-types/opacity/`, download the
`ktable.petitRADTRANS.h5` file, add a line to `EXOMOL` in `build_opacity.py` and its molar mass to `MASS` in
`src/core/atmosphere.js`, and add it to `SPECIES` in `src/atmosphere/main.js`.

## Build

```bash
.venv-rt/bin/python tools/opacity/build_opacity.py
```

Defaults: 5 ExoMolOP bins joined (R = 200), 12 g-points holding the log mean of k over their intervals
(`--method log`), every second temperature and pressure node, uint8: 2.06 MB per species, 25 MB for the twelve
and the two CIA tables. `--help` lists the options. It also writes `public/opacity/index.json`, which the page reads
for the file list and the attribution it shows.

## petitRADTRANS as a reference

`test/make_rt_reference.py` reads the same ExoMolOP files through links it makes itself under
`data-src/prt_input_data/` with petitRADTRANS's names (`<species>/<isotopologue>/<file>`; ExoMol's `__R1000` in
the H2O file becomes `.R1000`). Without the links petitRADTRANS downloads the files from its own server; the H2O
one is byte-identical to ExoMol's. A case whose file is absent or incomplete is skipped and said so.

## Study

```bash
.venv-rt/bin/python tools/opacity/study.py                     # candidate tables in data-src/study/ (about 4 GB;
                                                               # `study.py e1000g16` alone: all twelve at full resolution)
node --max-old-space-size=8192 tools/opacity/study.mjs x       # made from the R = 15000 cross-sections
node --max-old-space-size=8192 tools/opacity/study.mjs e       # made from the R = 1000 k-tables
node --max-old-space-size=8192 tools/opacity/study_single.mjs  # one absorber: which reference to trust
node tools/opacity/mixing_study.mjs "warm, eight molecules"    # a case of test/rt_reference.json; needs e1000g16
.venv-rt/bin/python tools/opacity/interp_study.py              # temperature interpolation against the tables' own nodes
node tools/opacity/interp_study.mjs                            # the same in spectra (its header says what to build first)
```

## Sodium and potassium: line cores recomputed

ExoMolOP's Na and K k-tables carry too much strength in the cores of the D lines below 10 bar: integrated over the
doublet the cross-section is (πe²/m_e c)·f at 10 bar and grows as 1/pressure below (17 times at 0.1 bar, 1.7e5 times
at 1e-5 bar for sodium at 1000 K). `repair_resonance` replaces those bins by Voigt profiles that conserve the
strength and meet the table's wings (see docs/guide/validation.md, "Line strength in the source tables").
`--no-repair` keeps the source as it is. `python tools/opacity/build_opacity.py --species Na K` rebuilds the two
tables and updates `index.json`. The ten molecules conserve their strength to a few per cent and are not touched.
