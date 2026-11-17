import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { buildServiceWorker } from './tools/sw/build.mjs';

// Relative base so the built site can be dropped into any sub-path.
// Dev only: the docs are a separate VitePress site (built into dist/docs for Pages). The dev server sends /docs/... to
// `npm run docs:dev` on :5174 when it runs, and otherwise says how to start it.
const DOCS_DEV = 'http://localhost:5174';
const docsInDev = {
  name: 'esl-docs-in-dev',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!/^\/docs(\/|$)/.test(req.url)) return next();
      const up = await fetch(DOCS_DEV + '/docs/', { signal: AbortSignal.timeout(400) }).then((r) => r.ok, () => false);
      if (up) { res.statusCode = 302; res.setHeader('Location', DOCS_DEV + req.url); return res.end(); }
      res.statusCode = 404; res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>Docs</title><body style="font:15px system-ui;background:#0b0f18;color:#dfe6f3;padding:40px;max-width:640px">
<h2>The docs are not served by this dev server</h2><p>Start them in another terminal with <code>npm run docs:dev</code> (port 5174) and reload,
or read the <a style="color:#5fd4ff" href="https://pearsonkyle.github.io/Exoplanet-Science-Lab/docs/">published docs</a>.</p>
<p><a style="color:#5fd4ff" href="/">Back to the app</a></p>`);
    });
  },
};

// Build only: dist/sw.js, the offline copy of the site (tools/sw/). Written after the bundle; tools/docs/assemble.mjs
// writes it again once the docs are in dist/docs, so the manifest always lists exactly what was built.
let outDir = 'dist';
const serviceWorker = {
  name: 'esl-service-worker',
  apply: 'build',
  configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
  closeBundle() { buildServiceWorker(outDir); },
};

export default defineConfig({
  base: './',
  // real folders, no single-page fallback: an unknown address is a 404, not the home page at the wrong depth
  // (its relative links would then nest: /docs/plan/plan/...)
  appType: 'mpa',
  plugins: [docsInDev, serviceWorker],
  worker: { format: 'es' },
  // one HTML entry per section: real folders, so the site needs no rewrite rules on a static host
  build: { target: 'es2022', rollupOptions: { input: Object.fromEntries(['index', 'plan/index', 'observe/index', 'analyze/index', 'analyze/photometry/index', 'analyze/spectroscopy/index', 'search/index', 'methods/index',
    // redirects from the old addresses: photometry and spectroscopy moved under analyze/, validation into methods/
    'observe/photometry/index', 'observe/spectroscopy/index', 'validation/index'].map((p) => [p.replace('/index', '').replace('/', '-') || 'index', p + '.html'])) } },
  // Dev only: the NASA Exoplanet Archive sends no CORS headers, so a live query from the page goes through
  // /nea/TAP/sync?query=...&format=json. The deployed site uses the static snapshot in public/catalog instead
  // (tools/build_catalog.py).
  server: { proxy: { '/nea': { target: 'https://exoplanetarchive.ipac.caltech.edu', changeOrigin: true, rewrite: (p) => p.replace(/^\/nea/, '') } } },
});
