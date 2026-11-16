# MCP server

The MCP server gives any MCP client (Claude Desktop, Claude Code, Cursor, VS Code, your own agent) the same tools as the in-page assistant: look up a planet, load data, set priors, run fits and experiments, compare models and write the report. It works on a session document ([format](../FORMAT)) with the site's science code, without a browser. Every tool is listed, with a **Try it** box, in the [tool reference](../reference/mcp-tools).

## Install

```sh
git clone https://github.com/pearsonkyle/Exoplanet-Science-Lab.git
cd Exoplanet-Science-Lab/mcp
npm install                          # the MCP SDK, nothing else; Node 20 or later
npm test                             # starts the server and drives it (about 10 s)
```

`--workspace` is the only folder the server reads and writes: put your light curves and velocities there, and it writes reports, sessions and figures there.

## Connect a client (stdio)

**Claude Code**

```sh
claude mcp add exoplanet-science-lab -- node /path/to/Exoplanet-Science-Lab/mcp/server.mjs --workspace /path/to/esl-work
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`; Cursor, Windsurf and Cline read the same shape):

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

**VS Code** (`.vscode/mcp.json`):

```json
{ "servers": { "exoplanet-science-lab": { "type": "stdio", "command": "node",
    "args": ["/path/to/Exoplanet-Science-Lab/mcp/server.mjs", "--workspace", "${workspaceFolder}/data"] } } }
```

## Over HTTP

```sh
node mcp/server.mjs --workspace ~/esl-work --http 8765
# streamable HTTP at http://127.0.0.1:8765/mcp
```

```json
{ "mcpServers": { "exoplanet-science-lab": { "type": "streamable-http", "url": "http://127.0.0.1:8765/mcp" } } }
```

The server listens on 127.0.0.1 only and refuses a foreign `Host` header (a DNS-rebinding guard), so nothing on your network can reach it. Web pages may call it only from this machine (`http://localhost…`) or from origins you name:

```sh
node mcp/server.mjs --workspace ~/esl-work --http 8765 --allow-origin https://pearsonkyle.github.io
```

That is what the **Try it** boxes of the [tool reference](../reference/mcp-tools) need. Chrome may ask to let the site "access devices on your local network": allow it. Safari blocks `http://localhost` from https pages; use Chrome, Edge or Firefox.

## On another machine you own

Run the server where your data are (a workstation, a lab server) and keep it bound to 127.0.0.1 there; reach it through SSH.

**stdio over SSH**: the client starts the server remotely.

```json
{ "mcpServers": { "exoplanet-science-lab": { "command": "ssh",
    "args": ["me@workstation", "node", "/home/me/Exoplanet-Science-Lab/mcp/server.mjs", "--workspace", "/home/me/esl-work"] } } }
```

**HTTP through a tunnel**: start it on the workstation with `--http 8765`, then on your laptop

```sh
ssh -N -L 8765:127.0.0.1:8765 me@workstation
```

and point the client (or the docs' **Try it**) at `http://127.0.0.1:8765/mcp`.

## From your own code

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'my-harness', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs', '--workspace', './work'] }));
await client.callTool({ name: 'lookup_planet', arguments: { name: 'WASP-12 b' } });
await client.callTool({ name: 'load_light_curve', arguments: { file: 'night1.csv' } });
await client.callTool({ name: 'set_free', arguments: { free: ['rprs', 'inc', 'tmid'] } });
await client.callTool({ name: 'run_fit', arguments: {} });
await client.callTool({ name: 'export_file', arguments: { kinds: ['report', 'session'] } });
```

In Python, the official `mcp` package's stdio client does the same.
