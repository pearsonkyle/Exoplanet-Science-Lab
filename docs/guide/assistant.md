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

## Equations, the Methods and the code

The chat renders LaTeX: `$...$` inline and `$$...$$` (or `\( \)`, `\[ \]`) on their own line, as MathML in the browser; a dollar amount ("$5") stays text. Ask "how is X computed?" and the assistant reads the [Methods](../METHODS) section that implements it (`explain_method`: the equations as the code evaluates them, assumptions, limits and the checks against other codes) and, when you want the code itself, the exact function (`read_source`, from the published repository). A question only reads: while a request is a question, the tools that change the analysis are refused.

## Dates

The assistant is told today's date with every request. When you plan, a date without a year is its next occurrence ("transits between January and July", asked in November, are next year's), a past date is moved to next year unless you ask about the past on purpose, a month on its own means the whole month, and a range you write ("between February and April") is planned as one span even when the model passes only one end. The planner covers 90 nights at a time; a longer range is cut there and the result says where to continue.

## A whole project from your data

Attach a light curve or radial velocities and ask for the project in one go, for example *"Set up the project: get the system parameters and priors from the catalogue, fit the orbit with a jitter for each instrument, explain the results, search the residuals for another periodic signal, and finish with the standard report."* The assistant loads the file, looks the system up (with velocities only, the orbit is set up for them: mass, period, e, ω, T mid and one jitter per instrument), fits, explains, runs `residual_periodogram` (Lomb–Scargle of the residuals with false-alarm probabilities, known planets, harmonics and 1-day aliases named, and a warning when the residuals exceed their errors) and writes the report with its BibTeX, session and figures. The app checks every number of the answer against the tool results.

## History, export and training data

Every conversation is kept in this browser (the clock icon): open one again, delete it, or export it. **Export** writes JSON Lines, one conversation per line, in the OpenAI chat fine-tuning shape that SFT pipelines read (TRL `SFTTrainer` with tools, axolotl and LLaMA-Factory after a field map):

```json
{"messages": [
   {"role": "system", "content": "<the assistant's primer>"},
   {"role": "user", "content": "CURRENT STATE OF THE APP ...\n\nTHE USER'S REQUEST:\nFit the transit in the file I attached"},
   {"role": "assistant", "content": "", "reasoning_content": "<the model's thinking, when the server streams it>",
    "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "load_light_curve", "arguments": "{\"file\":\"tess.csv\"}"}}]},
   {"role": "tool", "tool_call_id": "call_1", "name": "load_light_curve", "content": "{\"loaded\": ...}"},
   {"role": "assistant", "content": "Rp/R* = 0.0727 +0.0012 -0.0011 ..."}],
 "tools": [{"type": "function", "function": {"name": "...", "description": "...", "parameters": {"type": "object", ...}}}],
 "metadata": {"format": "esl-assistant-sft-v1", "model": "...", "protocol": "native", "turns": 1, "steps": 10, "tool_calls": 9, "tool_errors": 0, "answers_with_app_table": 0, ...}}
```

The prompt in a record is the one the model saw at each step, without the harness's trimming: every tool result in full, the app's reminders as user messages, and the live state card where the harness put it. Tool arguments are recorded as they ran (after the harness repaired, for example, a list written as one escaped string). A final answer is the model's own words: the table the app appends when numbers do not match is left out and counted in `metadata.answers_with_app_table`, so a filter can drop or keep those examples. **Import** reads such a file back into the history. Scripts can get the open conversation as a record with `window.__eslAssistant.trainingRecord()`; the format is defined and tested in `src/assistant/sft.js` and `test/assistant_sft.test.mjs`.
