// Node host for the core bundle: one JSON message per line on stdin and stdout. Used by esl._runtime.NodeEngine
// when no embedded JavaScript engine is installed (or ESL_RUNTIME=node). Hand-written; the bundle next to it is generated.
//
//   -> {"id", "op": "call", "name", "args": "<JSON array>"}      <- {"id", "r": "<JSON {ok|error}>"}
//   -> {"id", "op": "start", "name", "args": "<JSON array>"}     <- {"id", "progress": {...}} ... {"id", "fetch": {"req", "name"}} ... {"id", "done": true, "result" | "error"}
//   -> {"op": "stop", "id"}    -> {"op": "resolve", "req", "json"}    -> {"op": "reject", "req", "message"}
//   -> {"id", "op": "load", "path"}                              <- {"id", "r": "{\"ok\":true}"}
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
(0, eval)(readFileSync(process.argv[2] || join(here, 'esl_core.js'), 'utf8'));
const ESL = globalThis.ESL;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const stops = new Set(), pending = new Map();
let nextReq = 1;

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch (e) { send({ fatal: 'bad message: ' + e.message }); return; }
  try {
    if (m.op === 'call') send({ id: m.id, r: ESL.call(m.name, m.args) });
    else if (m.op === 'load') { (0, eval)(readFileSync(m.path, 'utf8')); send({ id: m.id, r: '{"ok":true}' }); }
    else if (m.op === 'stop') stops.add(m.id);
    else if (m.op === 'resolve') { const p = pending.get(m.req); pending.delete(m.req); if (p) { try { p.res(JSON.parse(m.json)); } catch (e) { p.rej(e); } } }
    else if (m.op === 'reject') { const p = pending.get(m.req); pending.delete(m.req); if (p) p.rej(new Error(m.message)); }
    else if (m.op === 'start') {
      const id = m.id;
      ESL.runJob(m.name, JSON.parse(m.args || '[]'), {
        onProgress: (p) => send({ id, progress: p }),
        shouldStop: () => stops.has(id),
        fetchJson: (name) => new Promise((res, rej) => { const req = nextReq++; pending.set(req, { res, rej }); send({ id, fetch: { req, name } }); }),
      }).then((result) => send({ id, done: true, result: result === undefined ? null : result }), (e) => send({ id, done: true, error: String((e && e.message) || e) })).finally(() => stops.delete(id));
    } else send({ id: m.id, r: JSON.stringify({ error: 'unknown op ' + m.op }) });
  } catch (e) { send({ id: m.id, r: JSON.stringify({ error: String((e && e.message) || e) }) }); }
}).on('close', () => process.exit(0));
send({ ready: true, node: process.version, stamp: ESL.stamp });
