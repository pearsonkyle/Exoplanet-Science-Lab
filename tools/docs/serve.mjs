// A tiny static server for dist/ (app + docs on one origin, as on GitHub Pages): node tools/docs/serve.mjs dist 4173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
const [root = 'dist', port = '4173'] = process.argv.slice(2);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.fits': 'application/fits' };
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(root, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { if (!extname(f)) f += '.html'; }
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }).end(b); }
  catch { res.writeHead(404).end('not found'); }
}).listen(Number(port), () => console.log(`http://localhost:${port}/  (docs at /docs/)`));
