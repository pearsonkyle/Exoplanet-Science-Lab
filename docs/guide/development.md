# Development and tests

```sh
npm install
npm run dev              # the app at http://localhost:5173 (reloads on save)
npm run docs:dev         # these docs at http://localhost:5174 (regenerates the reference first)
npm run pages:preview    # app + docs built together, as on GitHub Pages (the API playground needs this)
```

## Tests

Every model is tested against an independent reference (an analytic limit, scipy/numpy, batman, photutils, lightkurve, REBOUND, a published value) before any interface is built on it. The numbers each test prints are quoted on the Methods page.

```sh
npm test                 # every Node suite (about 15 min)
node test/transit.test.mjs        # one suite
cd python && pytest      # the Python package
cd mcp && npm test       # the MCP server
```

Browser checks need Python with Playwright and a built copy served locally:

```sh
npx vite build --outDir /tmp/esl && python3 -m http.server 8765 -d /tmp/esl &
.venv/bin/python test/layout_check.py http://localhost:8765/    # every page at phone, tablet and desktop widths
ESL_BASE=http://localhost:8765 .venv/bin/python test/api_check.py
```

## Layout

| Path | What |
| --- | --- |
| `src/core/` | The science: no DOM, runs in Node, the browser, the Python package and the MCP server |
| `src/main.js`, `src/ui/`, `src/viz/` | The analyzer page |
| `src/plan/`, `src/sky/`, `src/photometry/`, `src/spectra/`, `src/search/`, `src/methods/` | The other pages |
| `src/assistant/` | The chat assistant and the tool table shared with MCP |
| `python/` | The `esl` package · `mcp/` the MCP server · `docs/` these docs · `test/` the tests |

Read `docs/ARCHITECTURE.md` and `CLAUDE.md` before changing the core.

## Publishing the Python package

Installing from git works today. For PyPI: create the project on pypi.org, add a *trusted publisher* (owner `pearsonkyle`, repository `Exoplanet-Science-Lab`, workflow `python-release.yml`, environment `pypi`), then push a tag:

```sh
git tag py-v0.2.0 && git push origin py-v0.2.0
```

The workflow rebuilds the bundled core, runs the Python tests and publishes the wheel and sdist.
