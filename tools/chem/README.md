# Equilibrium chemistry table

`build_chem.py` runs FastChem (Stock et al. 2018, 2022; Kitzmann et al. 2024; `pyfastchem` 4.0.4 in `.venv-rt`) on a
grid of temperature, pressure, metallicity and C/O and writes `public/chem/equilibrium.eslc` (4.9 MB), which
`src/core/chemistry.js` reads. FastChem is GPL-3 and is only run; the table is data.

## Source files (untracked, in `data-src/fastchem/`)

From `https://raw.githubusercontent.com/NewStrangeWorlds/FastChem/master/input/`:

| File | What |
| --- | --- |
| `logK/logK.dat` (115 kB) | equilibrium constants, fits to JANAF and other tables |
| `element_abundances/asplund_2021.dat` (0.4 kB) | solar abundances, Asplund et al. (2021) |

## Build and check

```bash
.venv-rt/bin/python tools/chem/build_chem.py      # about 15 minutes
.venv-rt/bin/python test/make_chem_reference.py   # FastChem off the nodes, and our own solver
node test/chemistry.test.mjs
```

Grid: 40 temperatures (300-4000 K, log), 21 pressures (1e-8 to 100 bar), 11 metallicities ([M/H] -1 to 2.5, closer
above 1), 14 values of C/O (0.1-1.5, closest around 1). Species: H2, He, H, e-, H-, the twelve gases with opacity
tables, N2, and the mean molecular weight. Gas phase only: adding condensation needs FastChem's condensate data
(`logK_condensates.dat`) and a decision on rain-out.
