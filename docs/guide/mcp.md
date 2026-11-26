# MCP server

Gives an MCP client (Claude Desktop, Claude Code, Cursor, VS Code, your own agent) the same tools as the in-page
assistant: look up a planet, load data, set priors, run fits and experiments, compare models, write the report.
It works on a [session document](../FORMAT) with the site's science code, no browser needed. The tools are listed
in the [tool reference](../reference/mcp-tools).

## Install

```sh
git clone https://github.com/pearsonkyle/Exoplanet-Science-Lab.git
cd Exoplanet-Science-Lab/mcp && npm install      # Node 20 or later
```

`--workspace` is the one folder the server reads and writes: put your light curves and velocities there; reports,
sessions and figures are written there.

## Connect a client

**Claude Code**

```sh
claude mcp add exoplanet-science-lab -- node /path/to/Exoplanet-Science-Lab/mcp/server.mjs --workspace /path/to/esl-work
```

**Claude Desktop, Cursor, Windsurf, Cline** (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "exoplanet-science-lab": {
      "command": "node",
      "args": ["/path/to/Exoplanet-Science-Lab/mcp/server.mjs", "--workspace", "/path/to/esl-work"]
    }
  }
}
```

**Over HTTP**: `node mcp/server.mjs --workspace ~/esl-work --http 8765` serves `http://127.0.0.1:8765/mcp`
(streamable HTTP, this machine only).

## On another machine

Run it where the data are and let the client start it over SSH:

```json
{ "mcpServers": { "exoplanet-science-lab": { "command": "ssh",
    "args": ["me@workstation", "node", "/home/me/Exoplanet-Science-Lab/mcp/server.mjs", "--workspace", "/home/me/esl-work"] } } }
```

## Try it

Ask your client something like: *"Look up WASP-12 b, load night1.csv from the workspace, fit Rp/R★, the inclination
and the mid-transit time, and write the report."*

## Stars and atmospheres

Four tools are the server's own, apart from the session (they read the tables in the checkout's `public/` folder and
are not in the shared tool reference; `mcp/README.md` describes them):

- `star_fit`: a star's temperature, angular diameter, radius and luminosity from catalogue magnitudes.
- `star_match_spectrum`: the same from a low-resolution spectrum file in the workspace.
- `atmosphere_spectrum`: the transmission and emission spectrum of a model atmosphere (a preset world or your own),
  written to a CSV file.
- `atmosphere_retrieve`: that model fitted to measured spectra in workspace files (a retrieval with nested sampling):
  posteriors, ln Z, and the best-fit spectrum. Try: *"Fit transit.csv (ppm) with an isothermal atmosphere: the
  temperature, the water abundance and the radius. Then fit it again without water and tell me whether water is
  needed."* It can take minutes; the answer says whether the fit converged.

The server takes the argument shapes tool-calling models send to these tools when the meaning is unambiguous
(`mcp/normalize.mjs`):
- numbers sent as strings ("1.19") become numbers; `null`, or an empty `{}` in a number field, means "not given";
- band names lose quotes, backticks and a model's string delimiter (`<|"|>Gaia G<|"|>`), match without case and
  with `_` or `-` for a space, and a short name is taken when only one band ends in it, case first (`Ks` is
  2MASS Ks, `G` is Gaia G); `B` and `V` alone are Johnson's (APASS B and V are calibrated onto that system);
  `g` could be SDSS, PS1 or APASS and is refused, naming them;
- a magnitude, parallax, log g or [Fe/H] can be `{ "value": ..., "error": ... }` as well as `[value, error]`;
- the planet's reference pressure can be given in millibar (`pRef_mbar`), and a `pRef` above 1 bar is used as
  given with a warning (a radius "at 10 mbar" is `pRef: 0.01`); a parallax smaller than its error is used as
  given with a warning that the order is [value, error];
- a retrieval prior can be `{ "low": ..., "high": ... }`; a reversed or empty one is refused with the likely fix;
- `planet_name` labels an atmosphere result; `world` takes only the presets, and naming another planet there is
  refused with the way to model it.

Anything else fails with what was received, what is expected and a call that works, so a model can correct
itself instead of repeating the call. Every call shape that worked before gives the same result.

`tools/list` shows these tools' 0.1.0 argument schemas by default: a model fine-tuned on that list did better with
it than with fully typed ones. `ESL_MCP_SCHEMA=typed` lists the typed schemas instead (every field with its type
and unit, the presets as an enum, `planet_name` and `pRef_mbar` declared); the arguments are repaired the same
way under both.
