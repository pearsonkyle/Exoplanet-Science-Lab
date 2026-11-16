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
