#!/usr/bin/env node
// MCP server for Exoplanet Science Lab. It exposes the assistant's tools (src/assistant/toolspec.js, the same
// table the in-page assistant uses) on an ESL session document held in memory, through src/core: no browser.
//
//   node mcp/server.mjs --workspace /path/to/folder            stdio (Claude Desktop, IDE agents)
//   node mcp/server.mjs --workspace /path/to/folder --http 8765  streamable HTTP on 127.0.0.1:8765/mcp
//     --allow-origin https://exoplanet.science   also let that site's pages call it (the docs' Try it panels)
//   options: --session file.json  open this session at start (a path inside the workspace)
//
// Files: every path a tool reads or writes is resolved inside the workspace folder given at start-up and
// refused when it leaves it (also through a symbolic link). Nothing else on disk is touched, and the server
// makes no network requests. All logging goes to stderr (stdout is the protocol).

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, sep, relative, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTools } from '../src/assistant/tools.js';
import { createDocApi, blankSession } from '../src/assistant/docApi.js';
import { describeText } from '../src/assistant/ops.js';

const HERE = dirname(fileURLToPath(import.meta.url)), PUBLIC = resolve(HERE, '../public'), REPO = resolve(HERE, '..');
const log = (...a) => process.stderr.write('[esl-mcp] ' + a.join(' ') + '\n');
const MAX_FILE = 30e6;

// ---- the workspace: the only folder this server reads and writes ----------------------------------------------
/** A file store confined to `root`. Exported for the tests. */
export function workspaceFiles(root) {
  const base = realpathSync(resolve(root)), written = new Set();
  /** The absolute path of `name` inside the workspace, or an error. Checks the real location of the nearest existing ancestor, so a link cannot lead out. */
  function inside(name) {
    if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new Error('a file name is needed');
    if (isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('~')) throw new Error(`"${name}" is an absolute path: give a path relative to the workspace folder`);
    const p = resolve(base, name);
    if (p !== base && !p.startsWith(base + sep)) throw new Error(`"${name}" is outside the workspace folder`);
    let probe = p; while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== base && !real.startsWith(base + sep)) throw new Error(`"${name}" leads outside the workspace folder (through a link)`);
    return p;
  }
  function walk(dir, depth, out) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 300) return; if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1, out); } else if (e.isFile()) out.push(p);
    }
  }
  return {
    root: base, inside,
    list() {
      const out = []; walk(base, 0, out);
      return out.map((p) => { const rel = relative(base, p).split(sep).join('/'), st = statSync(p); let about = ''; if (st.size < 2e6 && /\.(csv|txt|dat|tsv|json|md|py|tex|yaml)$/i.test(rel)) { try { about = describeText(readFileSync(p, 'utf8'), rel).kind; } catch { about = ''; } } return { name: rel, size: st.size, origin: written.has(rel) ? 'written' : 'workspace', about }; });
    },
    async readText(name) {
      const p = inside(name);
      if (!existsSync(p) || !statSync(p).isFile()) { const all = this.list().map((f) => f.name); throw new Error(`there is no file "${name}" in the workspace. ${all.length ? 'Files: ' + all.slice(0, 40).join(', ') + '.' : 'The workspace is empty.'}`); }
      if (statSync(p).size > MAX_FILE) throw new Error(`${name} is larger than 30 MB`);
      const text = readFileSync(p, 'utf8');
      if (text.slice(0, 4000).includes('\0')) throw new Error(`${name} is not a text file`);
      return text;
    },
    async write(name, data) {
      const p = inside(name), rel = relative(base, p).split(sep).join('/');
      if (existsSync(p) && !written.has(rel)) throw new Error(`"${rel}" already exists in the workspace and was not written by this server: choose another name`);
      mkdirSync(dirname(p), { recursive: true });
      const buf = typeof data === 'string' ? data : Buffer.from(await data.arrayBuffer());
      writeFileSync(p, buf); written.add(rel);
      return { name: rel, size: typeof buf === 'string' ? Buffer.byteLength(buf) : buf.length };
    },
  };
}
/** Saved analyses: session files in <workspace>/saved/. */
function workspaceStore(files) {
  const dir = () => { const d = files.inside('saved'); mkdirSync(d, { recursive: true }); return d; };
  const slug = (s) => String(s || 'analysis').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'analysis';
  return {
    async save(doc, name) { const id = slug(name), p = join(dir(), id + '.json'); writeFileSync(p, JSON.stringify(doc)); return { id, name, system: doc.name, updated: new Date().toISOString(), summary: `${doc.planets.length} planet(s), ${doc.result ? 'with a result' : 'not run'}` }; },
    async list() { return readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => { const p = join(dir(), f); let d = {}; try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { /* unreadable */ } return { id: f.replace(/\.json$/, ''), name: d.title || d.name || f, system: d.name, updated: statSync(p).mtime.toISOString(), summary: d.result ? 'with a result' : 'not run' }; }); },
    async get(id) { const p = join(dir(), slug(id) + '.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
    async delete(id) { const p = join(dir(), slug(id) + '.json'); if (existsSync(p)) unlinkSync(p); },
  };
}

const INSTRUCTIONS = `Exoplanet Science Lab: model and fit exoplanet transits, radial velocities and transit timing with nested sampling.
The server holds ONE analysis (an ESL session) in memory; every tool acts on it. Typical flow:
1. Start: lookup_planet (catalogue values and wide priors), load_example, import_session (a session file in the workspace) or new_session.
2. Data: list_files, then load_light_curve / load_radial_velocities / set_timings with a file name from the workspace. Data are never returned as arrays, only described.
3. Set up: set_free, set_prior, choose_data, set_sampler. a/R* (ars) is never fitted; with Kepler mode on it follows from M*, R*, P and the planet mass.
4. run_fit (seconds to minutes; progress notifications are sent), then get_results, get_derived, list_runs, compare_runs. run_experiment runs a queue of variants one after another (circular against eccentric, with and without a planet, or your own variants with set-up steps) and returns the comparison table with a written report.
   Optional models: set_phase_curve (the planet's own light), set_moon, set_nbody (two planets or more).
5. Timing: fit_ephemeris and timing_periodogram. Files: export_file (session JSON, Markdown report, Python script, CSV), write_file.
Keys: rprs, ars, inc, per, tmid, ecc, omega, mplanet, ld0..ld3, a2, rvlin, rvquad, jit@rv1, mstar, rstar, teff, feh; later planets carry their letter (per@c). Times are days (BJD when dated).
Report numbers exactly as returned, each with the uncertainty it came with; never convert or compute one. For model comparison relay the "reading", "verdict" and "cautions" fields rather than interpreting ln Z yourself.
Results that hold a table also carry it as a second text block (Markdown), ready to show as it is.`;

/** Build the server on a workspace folder. Returns { server, tools, api, files }. */
export function createEslServer({ workspace, session } = {}) {
  const files = workspaceFiles(workspace);
  const fetchText = async (p) => { const f = resolve(PUBLIC, p); if (!f.startsWith(PUBLIC + sep)) throw new Error('bad path'); return readFileSync(f, 'utf8'); };
  const fetchJson = async (name) => JSON.parse(await fetchText('catalog/' + name));
  const api = createDocApi({ fetchText, fetchJson, store: workspaceStore(files), session });
  // read_source: the files of this checkout (the browser reads the published copy on GitHub)
  const readSource = async (f) => { const p = resolve(REPO, f); if (!p.startsWith(REPO + sep)) throw new Error('bad path'); return readFileSync(p, 'utf8'); };
  const tools = createTools({ api, files, fetchJson, where: 'mcp', blankSession, readSource });
  const server = new Server({ name: 'exoplanet-science-lab', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.confirm, openWorldHint: false, title: t.name.replace(/_/g, ' ') } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params, token = req.params._meta && req.params._meta.progressToken;
    let last = 0;
    const onProgress = token === undefined ? undefined : (p) => {
      const now = Date.now(); if (now - last < 700) return; last = now;
      const fr = (api.state().sampler.fracRemain) || 0.01, done = Math.min(0.99, Math.max(0, 1 - Math.log(Math.max(p.remFrac, fr) / fr) / Math.log(1 / fr)));
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(done * 100), total: 100, message: `${p.variant ? p.variant + ': ' : ''}iteration ${p.it}, ${p.ncalls} likelihood calls, ln Z ${Number(p.logZ).toFixed(2)}, ${(p.elapsed || 0).toFixed(0)} s` } }).catch(() => {});
    };
    const r = await tools.call(name, args || {}, { signal: extra.signal, onProgress });
    // the result as JSON for the model, and its table (when it has one) as Markdown the client can show verbatim
    return { content: [{ type: 'text', text: r.text }, ...(r.ok && r.table ? [{ type: 'text', text: r.table }] : [])], isError: !r.ok };
  });
  return { server, tools, api, files };
}

// ---- command line ----------------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: node mcp/server.mjs --workspace <folder> [--session file.json] [--http <port> [--allow-origin <https://site>]...]\n'); return; }
  const workspace = resolve(opt('--workspace', process.env.ESL_WORKSPACE || process.cwd()));
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) { log(`workspace folder not found: ${workspace}`); process.exit(2); }
  let session; const sf = opt('--session');
  if (sf) session = JSON.parse(readFileSync(workspaceFiles(workspace).inside(sf), 'utf8'));
  const port = opt('--http');
  if (!port) {
    const { server } = createEslServer({ workspace, session });
    await server.connect(new StdioServerTransport());
    log(`ready on stdio · workspace ${workspace}`);
    return;
  }
  // Streamable HTTP, one session document per MCP session, bound to this machine only
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createServer } = await import('node:http'), { randomUUID } = await import('node:crypto');
  const sessions = new Map(), host = '127.0.0.1', allowed = new Set([`${host}:${port}`, `localhost:${port}`]);
  // Web pages may call this server only from this machine's own pages, or from an origin named with --allow-origin
  // (repeatable; e.g. the documentation site, whose "Try it" panels talk to your server). The server still listens on
  // 127.0.0.1 only and still refuses a foreign Host header, so nothing on the network can reach it.
  const extra = argv.flatMap((a, i) => (a === '--allow-origin' && argv[i + 1] ? [argv[i + 1].replace(/\/+$/, '')] : []));
  const originOk = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || extra.includes(o);
  createServer(async (req, res) => {
    try {
      if (!allowed.has(req.headers.host || '')) { res.writeHead(403).end('forbidden host'); return; }   // DNS-rebinding guard
      const origin = req.headers.origin;
      if (origin && !originOk(origin)) { res.writeHead(403).end('forbidden origin: start the server with --allow-origin ' + origin); return; }
      if (origin) {
        // CORS for the allowed page, and Chrome's local-network preflight (a public page calling 127.0.0.1)
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
        if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      }
      if (!(req.url || '').startsWith('/mcp')) { res.writeHead(404).end('use /mcp'); return; }
      const sid = req.headers['mcp-session-id'];
      let t = sid && sessions.get(sid);
      if (!t) {
        if (sid || req.method !== 'POST') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'unknown or missing session: initialize first' }, id: null })); return; }
        t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
        t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
        await createEslServer({ workspace, session }).server.connect(t);
      }
      await t.handleRequest(req, res);
    } catch (err) { log('http error', err.message); if (!res.headersSent) res.writeHead(500).end('error'); }
  }).listen(Number(port), host, () => log(`ready on http://${host}:${port}/mcp · workspace ${workspace}${extra.length ? ` · pages allowed: ${extra.join(', ')}` : ''}`));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { log(err.stack || err.message); process.exit(1); });
