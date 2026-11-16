# Assistant and your own LLM

Every page has a chat bubble (bottom right). The assistant works the page through the same controls you have: it sets up the planner, reduces images, loads data, sets priors, runs fits and experiments, and writes the report. What it changes is listed under **Actions** and can be undone. Every number it quotes is checked against the tool results.

No model is built in: it talks to a server **you** run or choose, through the OpenAI chat API. Your messages, a summary of the page and tool results go only to that server.

## Choose a model

A model with **tool calling** and **16k tokens of context or more** works best (Qwen 3 / Qwen 2.5 Instruct, Llama 3.1+ Instruct, Mistral Small, Gemma 3/4 and similar; 7B and up is comfortable, 4B works for short tasks). In the panel: cog (**Settings**) → choose the server → **Test connection** → pick the model. **Tools on this page** lists what the assistant may do here, with a switch for each.

## Run a server on your computer

The simplest set-up: the model on the same machine as the browser.

| Server | Start it | Address in Settings |
| --- | --- | --- |
| **LM Studio** | Developer tab → Start server (port 1234); switch on **Enable CORS** in the server settings | preset *LM Studio on this computer* |
| **Ollama** | `OLLAMA_ORIGINS="*" ollama serve`, then `ollama pull qwen2.5:7b-instruct` | Custom: `http://localhost:11434/v1` |
| **llama.cpp** | `llama-server -m model.gguf --jinja -c 16384 --port 8080` | Custom: `http://localhost:8080/v1` |
| **vLLM** | `vllm serve Qwen/Qwen2.5-7B-Instruct --enable-auto-tool-choice --tool-call-parser hermes` | Custom: `http://localhost:8000/v1` |

From an https page, Chrome asks once whether the site may "access devices on your local network": allow it. Safari does not let https pages call `http://localhost`; use Chrome, Edge or Firefox, or run the site locally.

## A model on another machine (a GPU box, a lab server)

Browsers block an https page from calling plain `http://` on another machine (mixed content). Three ways round it:

1. **Give the server https.** With Tailscale on both machines: `tailscale serve --bg --https=443 http://localhost:8000` on the GPU box, then use `https://<box>.<tailnet>.ts.net/v1` as the Custom address. Or put Caddy/nginx with a certificate in front of it. The server must answer CORS (vLLM and llama.cpp do by default; Ollama needs `OLLAMA_ORIGINS`).
2. **Run the site locally** (`npm run dev`, [getting started](./getting-started)): an `http://localhost` page may call `http://` addresses on your network.
3. **Use MCP instead**: a desktop client (Claude Desktop, Claude Code, an IDE agent with your local model) drives the same tools through the [MCP server](./mcp), with no browser limits.

An API key, if your server needs one, is kept for the browser tab only unless you tick "remember".

## What it can do on each page

The full tool list, generated from the code, is in the [tool reference](../reference/mcp-tools). In short: Plan (site, dates, events, limits, list and open transits), Observe (site, time, target, filters, visible list), Photometry (frames, examine a star, focus map, stars, apertures and options, archive sectors, preparation, run, AAVSO report, hand-off), Spectroscopy (load, simulate, bins, fits, spectrum, export), Search (query, planet, open), Methods (find a method with its checks, BibTeX), and the analyzer (about 57 tools, ending with `write_report`, the standard project report with its BibTeX, session and figures).
