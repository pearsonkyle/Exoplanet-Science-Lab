import { defineConfig } from 'vite';

// Relative base so the built site can be dropped into any sub-path.
export default defineConfig({
  base: './',
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
