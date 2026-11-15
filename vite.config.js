import { defineConfig } from 'vite';

// Relative base so the built site can be dropped into any sub-path.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  // Dev only: the NASA Exoplanet Archive sends no CORS headers, so a live query from the page goes through
  // /nea/TAP/sync?query=...&format=json. The deployed site uses the static snapshot in public/catalog instead
  // (tools/build_catalog.py).
  server: { proxy: { '/nea': { target: 'https://exoplanetarchive.ipac.caltech.edu', changeOrigin: true, rewrite: (p) => p.replace(/^\/nea/, '') } } },
});
