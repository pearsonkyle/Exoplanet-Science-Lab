# Validation

The validation is the Validation tab of the Methods page (`methods/index.html`; `validation/index.html` only
redirects there, mapping old anchors to `#val-…`). It compares ESL's models with twelve other codes and a 30-digit
reference, recomputing ESL's side in the visitor's browser, and summarises the project's other numerical tests.
It is written to be read top to bottom in under ten minutes; everything else is in collapsed blocks.

This file is the single place for the rebuild recipe (the page links here) and for how to add a section.

## Where things are

| Piece | Where |
| --- | --- |
| Page skeleton: headings, table of contents, the sentences without numbers | `methods/index.html` (Validation tab) |
| Assembly, summary table, the two honesty lists, reproduce / limits / references | `src/validation/main.js` |
| The four live comparisons (transit, orbit, velocity, fits) | `src/validation/sections.js` |
| ESL's side of every comparison and the tolerances (`TOL`), shared by page and test | `src/validation/compute.js` |
| Section 5: one card per entry of a declarative list | `src/validation/topics.js` (data), `src/validation/project.js` (renderer) |
| Bibliography (`REFS`) and software table (`CODES`: version key, repository, docs, citations, tracker) | `src/validation/refs.js` |
| Charts (canvas; `lines`, `bars`, `intervals`, `ranges`) and helpers | `src/validation/plot.js`, `ui.js`, `validation.css` |
| Reference generators (Python: the other codes and the 30-digit truth) | `tools/validation/make_transit.py`, `make_orbit.py`, `make_rv.py`, `make_fits.py` (+ `common.py`, `codes.py`, `ext_*.py`) |
| ESL's slow results (stored fits, coverage, Node timing) | `tools/validation/esl_reference.mjs` |
| Printed output of the project's other tests, the charts of section 5, mirrored scripts | `tools/validation/project_reference.mjs` |
| Stored numbers | `public/validation/transit.json`, `orbit.json`, `rv.json`, `fits.json`, `esl.json`, `project.json` |
| Copies of the scripts the page links to (identical to the originals; asserted by the test) | `public/validation/scripts/` |
| Test asserting every tolerance and every statement the page makes | `test/validation.test.mjs` (about 20 s) |

There is no public repository URL yet, so the page links to the mirrored copies under `public/validation/scripts/`,
which are served on the deployed site. `ctx.path()` in `main.js` makes the link; a path that is not mirrored is shown
as plain text. Never edit the copies: rerun `node tools/validation/project_reference.mjs <any topic id>`.

## Results (2026-11-15; rerun the test for current numbers)

| Comparison | Reference | ESL | Tolerance | Others, for scale |
| --- | --- | --- | --- | --- |
| Transit flux, 41 cases (Rp/R★ 0.01 to 0.3, b 0 to 1.2, a/R★ 2.5 to 200, e to 0.93, four laws) | 30-digit Kepler + scipy quadrature (checked with mpmath to 1e-16, and by exoplanet-core's closed form to 3e-16) | worst 3.1e-11, median 1.4e-14 | 1e-10 | worst case of each: pylightcurve and EXOTIC 1.3e-6, pyaneti 4.3e-6, PyTransit 9.8e-6, PyAstronomy 4.5e-5, ellc 4.9e-5, batman 7.6e-5 (its z = p point; 1e-6 for the Claret law by design) |
| Flux formula at its branch points (z = p, contacts, centre) | mpmath | worst 1.4e-10 | 5e-10 | batman up to 8.7e-3 at z = p |
| Exposure averaging | 4001-point average of the exact kernel | n = 101: < 8e-8; automatic n (41, 5, 41): up to 6.9e-7 | 1e-7; 1e-6 | same as PyTransit and pyaneti at equal n; batman 4 to 18 times worse at n = 7 |
| Kepler's equation, e 0.05 to 0.999 | mpmath | 2.4e-15 rad | 1e-11 | batman and pyaneti 7e-6 at e = 0.93; radvel's C solver exits at 0.999; PyTransit 6e-2 at 0.999 |
| Periastron and eclipse times, 21 orbits | mpmath | 2.3e-10 s | 1e-4 s | radvel, batman the same |
| T14, T23, E14, E23, 10 orbits | root finding on the 30-digit orbit | 1.3e-10 s | 1e-3 s | Winn (2010) closed form and PyTransit: up to 54 s short at e = 0.93 |
| Radial velocity curves, 5 orbits | formula with 30-digit Kepler; checked by differentiating the geometry | 1.3e-14 K | 1e-12 K | radvel 4e-13; pyaneti 1e-6; EXOTIC 2e-4 (2e-9 with a finer step) |
| K from masses | two-body formula, IAU nominal constants | 3.1e-8 | 1e-7 | radvel 1.5e-5 |
| ln L at fixed parameters, 4 problems | Python re-implementation with exoplanet-core / radvel models | 3.8e-6 | 1e-5 | |
| Posterior means and widths, 4 problems | dynesty (3000 live), emcee, UltraNest; analytic for the linear one | means within 0.05 σ, widths within 4.2% | 0.2 σ, 12% | the other samplers differ among themselves by up to 4% in width |
| ln Z, 4 problems | dynesty, UltraNest, analytic | within 0.9 σ (0.24); 8-seed mean within 0.09 | 3.5 σ and 0.8 | dynesty vs UltraNest differ by 0.1 to 0.33 |
| Coverage of the 68% interval, 300 trials × 2 problems | 68% ± 2.7% | 67.0 to 73.3% | 60 to 76% | |

The automatic exposure averaging left up to 18 ppm when this page was first built; `autoSupersample` was changed
the same day and the tolerance `TOL.exposureAuto` was tightened from 2.5e-5 to 1e-6.

Section 5 of the page (the project's other tests) is listed in `src/validation/topics.js` with the numbers it
quotes; `test/validation.test.mjs` fails when a quoted number is no longer in the stored output.

## Known issues the page reports

In ESL: the flux formula is good to 1e-10, not to rounding error; the quadratic law is 2 to 3 times slower than
batman and PyTransit; funnel-shaped posteriors can give a low ln Z (0.28 low on the 4-parameter funnel of the stress
suite, after a restart with a warning); nothing is tested on correlated noise or a wrong model; HD 80606 b's eclipse
duration (0.0834 d) disagrees with Pearson et al. 2022 (0.0717 d) while the 30-digit orbit gives 0.08337 d;
`derived()`'s closed-form durations are up to 0.9% short on very eccentric orbits (the system table uses bisection).

In other codes (none reported upstream; trackers searched 2026-11-15, see the page): batman's quadratic law at
z = p; radvel's C Kepler solver exits at e = 0.999; ellc's reference time is closest approach (11.4 min from
conjunction for HD 80606 b); EXOTIC's velocity uses Mp/M★ and a forward difference; PyTransit's Newton solver is
wrong by 6e-2 rad at e = 0.999. Smaller: batman's exposure sampling (its issue 18, closed as intended behaviour);
PyAstronomy's `occultnl` ends the process for Rp/R★ = 0.01; pyaneti's π is single precision; pylightcurve's
`eclipse_duration` fails at e = 0.93.

## Rebuilding the references

To check ESL against the stored references, Node is enough:

```
npm install
node test/validation.test.mjs
```

To regenerate the other codes' outputs (macOS, Apple silicon; Python 3.11, a Fortran compiler, an existing EXOTIC
environment):

```
/Users/kpearson/miniconda3/bin/python -m venv .venv-validation            # Python 3.11
export SDKROOT=$(xcrun --show-sdk-path) LIBRARY_PATH=$(xcrun --show-sdk-path)/usr/lib   # Homebrew gfortran needs these to link
.venv-validation/bin/pip install numpy scipy mpmath batman-package pytransit exoplanet-core PyAstronomy PyAstronomy_ext \
    radvel emcee dynesty ultranest astropy ellc pylightcurve
# pyaneti: Fortran, needs numpy <= 1.26 and OpenMP, so it gets its own environment
python -m venv .venv-validation/pyaneti-env && .venv-validation/pyaneti-env/bin/pip install numpy==1.26.1 meson meson-python ninja wheel scipy
git clone --depth 1 https://github.com/oscaribv/pyaneti .venv-validation/src/pyaneti
(cd .venv-validation/src/pyaneti && PATH=$PWD/../../pyaneti-env/bin:$PATH CC=/opt/homebrew/bin/gcc-16 pip install --no-deps --no-build-isolation .)
# EXOTIC and its pylightcurve come from /Users/kpearson/miniconda3/envs/exotic (read only); paths are in tools/validation/make_transit_util.py
for s in transit orbit rv fits; do .venv-validation/bin/python tools/validation/make_$s.py; done    # about 15 min
node tools/validation/esl_reference.mjs          # ESL's stored fits, 600 coverage trials, Node timing: about 8 min
node tools/validation/project_reference.mjs      # the other tests' output, section 5 charts, mirrored scripts: about 4 min
node test/validation.test.mjs
```

Versions used on 2026-11-15 (also stored in each JSON file and shown on the page): Python 3.11.10, numpy 2.4.6,
scipy 1.17.1, mpmath 1.4.1, batman 2.5.3, PyTransit 2.10.1, exoplanet-core 0.3.1, PyAstronomy 0.25.0, ellc 1.9.1,
pylightcurve 4.0.4, EXOTIC 4.3.1, pyaneti 2.5.2, radvel 1.6.7, emcee 3.1.6, dynesty 3.2.0, UltraNest 4.6.3,
astropy 8.0.2; Node 22.19.

The references of the other tests (section 5) have their own generators, named on each card
(`test/make_*_reference.py`, `test/stress_ultranest.py`, `test/make_stress_reference.mjs`); their headers say what
they need.

Not installed or not compared: starry (imports fail: Theano will not compile under current setuptools), juliet
(installs; wraps batman, radvel and dynesty).

## Adding a section (a new model)

Section 5 is rendered from `TOPICS` in `src/validation/topics.js`. Three entries with `status: 'planned'` hold the
place for phase curves and eclipse mapping, exomoons, and N-body dynamics.

1. Write the test first, in `test/<name>.test.mjs`, against an independent reference. Print one line per check:
   `ok   <name>   <numbers>` or `FAIL <name>   <numbers>` (three spaces before the numbers; indented lines that
   follow belong to the check).
2. Fill in the entry and set `status: 'done'`:

   ```js
   {
     id: 'phasecurve', status: 'done', title: 'Phase curves and eclipse mapping',
     purpose: 'One sentence a non-specialist understands.',
     headline: { value: '2.1 ppm', label: 'what the number is, and what it means in practice' },
     rows: [   // every number shown; `quote` must occur in the printed line of the check whose name contains `check`
       { what: 'Thermal phase curve against <code>', result: 'within 2.1 ppm', check: 'phase curve matches', quote: 'max 2.1e-6' },
     ],
     against: ['starry'],            // keys of CODES in refs.js (add the code there: repository, docs, citation, version)
     refs: ['luger2019'],            // keys of REFS in refs.js (verify title, year and identifier before adding)
     tests: ['test/phasecurve.test.mjs'], generators: ['test/make_phasecurve_reference.py'], stored: ['test/phasecurve_reference.json'],
     plot: { type: 'lines', title: '...', sub: '...', alt: 'what the chart shows, in words' },
     caveat: 'What this check does not show.',
   }
   ```

3. Store the output: `node tools/validation/project_reference.mjs phasecurve`. For a chart, either add a builder
   named after the id in that script (it returns a spec for `src/validation/plot.js`; see the existing ones), or
   write `public/validation/phasecurve.json` yourself, `{ date, tests: { 'test/x.test.mjs': { exit, seconds, checks:
   [{ ok, name, info }] } }, plot }`, and set `json: 'phasecurve.json'` in the entry.
4. `node test/validation.test.mjs` checks that the output is stored, that every `quote` is in it, that no stored
   check fails unless a row says `failing: true`, and that every reference and code key exists.

Chart specs: `lines` `{ series: [{ x, y, color, label, pointsOnly, dash }], xLog, yLog, xLabel }`; `bars`
`{ groups, series: [{ label, color, values }], yMax }`; `intervals` `{ rows: [{ label, truth, items: [{ label, color,
mean, std, text }] }], lim, unit }`; `ranges` `{ rows: [{ label, lo, hi, color }], xMin, xMax, marks }`. Colours may
be `'var:esl'`, `'var:s1'` … `'var:s8'`, resolved against the page theme.

A model that should be recomputed live in the browser (like the four in section 4) needs a function in
`compute.js`, a tolerance in `TOL`, a block in `sections.js` and assertions in the test; follow `rvBlock`.

Keep the page readable in ten minutes: the reading time shown under the title is computed from the visible words
(230 a minute, 12 s a figure, references excluded). A new card costs about 50 words; put the rest in its details.

## Still to do

| Item | Status |
| --- | --- |
| Report the five findings upstream (batman, radvel, ellc, EXOTIC, PyTransit) | not done; trackers are linked on the page |
| Pearson et al. 2022, Table 7 (HD 80606 b) | Rp, a, K, T14, T_peri, E_mid reproduced; **E14 differs** (see above) |
| A published timing list fitted end to end | not started |
| Real light curves against published fits (beyond EXOTIC's examples) | not started |
| Correlated noise, model misspecification | not started |
| Phase curves, exomoons, N-body | placeholders in `topics.js` |
| A public repository URL, so paths can link to the source instead of the mirrored copies | not available |
