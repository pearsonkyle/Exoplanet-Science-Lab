// Puts the built docs (docs/.vitepress/dist) under dist/docs/ next to the built app, as GitHub Pages serves them,
// and adds .nojekyll (no Jekyll processing of folders that start with an underscore).
import { cpSync, rmSync, writeFileSync, existsSync } from 'node:fs';
const from = 'docs/.vitepress/dist', to = 'dist/docs';
if (!existsSync(from)) { console.error('build the docs first (npm run docs:build)'); process.exit(1); }
rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true });
writeFileSync('dist/.nojekyll', '');
console.log('dist/: the app at /, the docs at /docs/');
