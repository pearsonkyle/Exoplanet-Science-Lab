# Exoplanet Science Lab: MCP server

Lets an MCP client (Claude Desktop, Claude Code, an IDE agent, your own harness) build, fit and summarise
exoplanet analyses without a browser. The server holds one ESL session document (`docs/FORMAT.md`) in memory
and exposes tools that act on it through `src/core`, the same numerical code the web app runs.

The tools are the ones the in-page assistant uses: both take their names, descriptions and argument schemas
from `src/assistant/toolspec.js`, and both run the handlers of `src/assistant/tools.js`. In the page the
handlers drive `window.__esl.api`; here they drive `src/assistant/docApi.js`, the same surface on a session
document. A few tools exist only in the page, because they need the page itself: `set_view`, `get_figure`,
`restore_run`, `fit_progress`, `companion_search`, `add_companion`, and the tools of the other pages of the site
(`navigate`, `plan_*`, `observe_*`, `photometry_*`, `search_*`, `validation_*`). One exists only here (`new_session`).

This server is also the way to use the assistant's tools when the in-page chat cannot reach your model: a page
served over https may not call a model server on plain http on another machine (browsers block it as mixed
content). A desktop client that speaks MCP has no such limit.

## Install and run

```sh
cd mcp
npm install                       # @modelcontextprotocol/sdk, nothing else
node server.mjs --workspace ~/esl-work            # stdio
node server.mjs --workspace ~/esl-work --http 8765   # streamable HTTP at http://127.0.0.1:8765/mcp
npm test                          # starts the server and drives it through the SDK client (about 10 s)
```

Needs Node 20 or later. `--workspace` is the only folder the server reads and writes (default: the current
directory, or `ESL_WORKSPACE`). `--session file.json` opens a session file from the workspace at start-up.

## Client configuration

Replace the two paths with yours.

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`), and any client that
reads the same `mcpServers` shape (Cursor `.cursor/mcp.json`, Windsurf, Cline):

```json
{
  "mcpServers": {
    "exoplanet-science-lab": {
      "command": "node",
      "args": ["/path/to/exoplanet-science-lab/mcp/server.mjs", "--workspace", "/path/to/esl-work"]
    }
  }
}
```

**Claude Code**

```sh
claude mcp add exoplanet-science-lab -- node /path/to/exoplanet-science-lab/mcp/server.mjs --workspace /path/to/esl-work
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "exoplanet-science-lab": { "type": "stdio", "command": "node",
    "args": ["/path/to/exoplanet-science-lab/mcp/server.mjs", "--workspace", "${workspaceFolder}/data"] } } }
```

**Over HTTP** (a harness that speaks streamable HTTP; start the server with `--http 8765`)

```json
{ "mcpServers": { "exoplanet-science-lab": { "type": "streamable-http", "url": "http://127.0.0.1:8765/mcp" } } }
```

**From your own code**, with the SDK client:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'my-harness', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs', '--workspace', './work'] }));
await client.callTool({ name: 'lookup_planet', arguments: { name: 'WASP-12 b' } });
await client.callTool({ name: 'load_light_curve', arguments: { file: 'night1.csv' } });
await client.callTool({ name: 'set_free', arguments: { free: ['rprs', 'inc', 'tmid'] } });
const fit = await client.callTool({ name: 'run_fit', arguments: {} }, undefined, { onprogress: (p) => console.log(p.message) });
await client.callTool({ name: 'export_file', arguments: { kind: 'report' } });
```

## Tools

| Group | Tools |
|---|---|
| System | `get_state`, `list_examples`, `load_example`, `search_catalog`, `lookup_planet`, `new_session`, `set_parameters`, `add_planet`, `remove_planet`, `set_kepler`, `set_limb_darkening`, `set_phase_curve`, `set_moon`, `set_nbody` |
| Data | `describe_data`, `load_light_curve`, `load_radial_velocities`, `set_timings`, `simulate_light_curve`, `edit_data` |
| Fit | `choose_data`, `set_free`, `set_prior`, `set_sampler`, `run_fit`, `stop_fit` |
| Results | `get_results`, `explain_results`, `get_derived`, `list_runs`, `compare_runs`, `run_experiment` |
| Timing and model | `fit_ephemeris`, `timing_periodogram`, `compute_model` |
| Files | `list_files`, `read_file`, `write_file`, `export_file`, `import_session` |
| Saved analyses | `save_analysis`, `list_saved`, `open_saved`, `delete_saved`, `undo` |

Every result is a compact JSON summary: counts, key numbers with their intervals, sentences. Data arrays are
never returned; a light curve is "685 points, 0.97 d span, median error 540 ppm" and is used by naming its
file. `run_fit` and `run_experiment` send progress notifications when the client passes a progress token.
A refused call comes back as an error result whose text says what was wrong and what the tool takes.

`run_experiment` runs a queue of fits one after another and compares them: `eccentricity`, `limb_darkening`,
`airmass`, `companion` (without and with one planet of the system), or `custom` variants, each a list of keys
to free and fix plus optional set-up steps (`set_limb_darkening`, `add_planet`, `set_moon`, ...). Every variant
starts from the set-up the experiment was called with. It writes a Markdown report into the workspace.

A result that holds a table (fitted values, a comparison, an ephemeris) is returned twice: as JSON, and as a
second text block with the same numbers as a Markdown table, so a client can show the software's own table
instead of a model's retelling of it.

`compare_runs` and `run_experiment` return the reading of the evidence in words (indistinguishable, weakly /
moderately / strongly disfavoured) with the cautions that apply, by the rules of the analyzer's "Runs & model
comparison" table. A client model should relay that reading instead of interpreting ln Z itself.

### The star

`star_fit` takes catalogue magnitudes (and a parallax, and priors on log g and [Fe/H] if known) and returns the star's
temperature, angular diameter, radius and luminosity with their errors and the residual of every band.
`star_match_spectrum` does the same from a low-resolution spectrum in a CSV file of the workspace. Both use the
PHOENIX grid in `public/stellar/` and are apart from the session.

### The atmosphere model

One tool is the server's own, apart from the session: `atmosphere_spectrum` computes the transmission and emission
spectrum of a model atmosphere (a preset world such as Titan or Jupiter, or a model you describe), writes it to a
CSV file in the workspace and returns a description: range, largest and smallest transit depth, temperatures at a
few pressures, clouds, and whether a self-consistent profile settled. It reads the opacity tables from this
checkout's `public/` folder.

`atmosphere_retrieve` fits such a model to measured spectra (an atmospheric retrieval with the site's nested
sampler). The spectra are CSV files in the workspace, one per data set: rows of `wavelength, value, error` or
`wavelength, bin_low, bin_high, value, error` (micron), each with a `kind` (`transit`, `eclipse`, `night`) and a
`unit` (`fraction`, `percent`, `ppm`). `free` lists the parameters (`teq`, `logKappaIR`, `logGamma` or `t`; `mh`,
`co`; `logX_<gas>`; `rplanet`; `logCloudTop`, `logHaze`, ...; `nightDT`; `offset_<n>`); priors are uniform
`[low, high]`, with wide defaults that the result states. It returns the median and 16 to 84% range of each
parameter, ln Z, χ² and the sampler's warnings, and writes the full result (JSON) and the best-fit spectrum (CSV).
A fit takes from seconds (three parameters, 60 points) to many minutes; it stops at `max_models` or `max_seconds`
and then says `"converged": false`, in which case the numbers are not a posterior. For speed the model runs on 30
layers and, for data of low resolving power, on joined opacity bins (`merge`): what that costs (about 10 ppm on a
hot Jupiter) is measured in `docs/guide/validation.md`, "Retrieval". A file without bin edges is taken to have
bins that meet halfway between its wavelengths. Two descriptions of the same data are compared by running both and
subtracting ln Z.

## What differs from the web app

- Limb darkening that follows the star (mode "star") is not available: the coefficients are used as given.
- `edit_data` removes an epoch, a velocity set or the timing list and sets the exposure; trimming, clipping
  and binning are in the page only. Figures are in the page only.
- `set_nbody` writes the N-body block of the session; the fit then integrates the system as the page does.
- Default priors for a newly freed parameter are simple rules around the current value. The page's use the
  transit duration and the epochs; set priors explicitly with `set_prior` when they matter.
- `lookup_planet` loads catalogue values and priors but no stand-in light curve; use `simulate_light_curve`.
- Examples open from their stored sessions (`public/examples/results/`).
- Saved analyses are session files in `<workspace>/saved/`.

## Files and safety

- Every path is resolved inside the workspace folder and refused when it leaves it: relative paths with `..`,
  absolute paths, and symbolic links that point outside (the real location of the nearest existing ancestor is
  checked). `write_file` takes plain file names; `export_file` and reads accept sub-folders of the workspace.
- A file that was in the workspace before and was not written by the server in this run is never overwritten.
- Files over 30 MB and binary files are refused. Folders starting with a dot and `node_modules` are not listed.
- The server makes no network requests: the catalogue and the examples are read from `public/` of this
  repository. The HTTP mode listens on 127.0.0.1 only and refuses requests whose Host or Origin header is not
  local. It has no authentication: do not expose it beyond your machine.
- Logging goes to stderr.

## Test

`node mcp/test.mjs` lists the tools, opens EXOTIC's three-planet example as a session (built as in
`test/session.test.mjs`), runs the fit with progress notifications, writes the fitted session, a report, a
results table and a model curve, reads them back, fits the WASP-12 b timing example, runs a queue of variants
with a set-up step and a fit with and without a second planet, switches a moon and a phase curve on and off,
and checks the path confinement and the HTTP mode.
