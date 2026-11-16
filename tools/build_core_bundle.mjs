// Bundle the science core (src/core, no DOM) into one self-contained script for the Python package:
//
//   node tools/build_core_bundle.mjs            write python/esl/_core/{esl_core.js, esl_ld_spectral.js, manifest.json} and python/esl/_version.py
//   node tools/build_core_bundle.mjs --check    exit 1 when those files are not what the current sources give (nothing is written)
//   node tools/build_core_bundle.mjs --release  also stamp the git commit and the build date (otherwise the output is a pure function of the sources)
//   node tools/build_core_bundle.mjs --out dir  write somewhere else
//
// The Python package executes this bundle (embedded V8, QuickJS or Node), so its numerics ARE the web
// application's: nothing is translated. What goes in is decided by python/bundle.manifest.json: every
// src/core/*.js file becomes a module under its own name, automatically, so a new model added to the core is
// reachable from Python (esl.core.invoke("newmodule.fn", ...)) after a rebuild with no edit here or there.
// esbuild comes with Vite (node_modules/esbuild); nothing is added to package.json.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const posix = (p) => p.split('\\').join('/');

function gitCommit() {
  try {
    const c = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return c ? c + (dirty ? '-dirty' : '') : null;
  } catch { return null; }
}

/** Evaluate a built bundle in a fresh context (no Node globals except what a bare engine has) and return its ESL object. */
export function loadBundle(code, extra = []) {
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx, { filename: 'esl_core.js' });
  for (const c of extra) vm.runInContext(c, ctx);
  return { ESL: ctx.ESL, context: ctx };
}

/**
 * Build. Returns { files: { name: text }, manifest, outDir, info }. opts: { release, outDir, write = true }.
 * Deterministic unless `release` is set: the same sources give the same bytes.
 */
export async function buildCoreBundle(opts = {}) {
  const esbuild = await import(pathToFileURL(join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
  const M = JSON.parse(readFileSync(join(ROOT, 'python/bundle.manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const outDir = resolve(ROOT, opts.outDir || M.out);

  // ---- which modules: every file of src/core, by name
  const names = readdirSync(join(ROOT, M.modulesDir)).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).filter((n) => !M.exclude.includes(n) && /^[A-Za-z_$][\w$]*$/.test(n)).sort();
  const mods = [...names.map((n) => [n, `${M.modulesDir}/${n}.js`]), ...Object.entries(M.extraModules || {})];
  const rel = (p) => './' + posix(p);
  const entry = [
    `import ${JSON.stringify(rel(M.shim))};`,
    ...mods.map(([n, p], i) => `import * as m${i} from ${JSON.stringify(rel(p))};   // ${n}`),
    ...Object.entries(M.tables || {}).map(([k, t]) => `import { ${t.export} as table_${k} } from ${JSON.stringify(rel(t.file))};`),
    `import { createApi } from ${JSON.stringify(rel(M.entry))};`,
    `globalThis.ESL = createApi({ modules: { ${mods.map(([n], i) => `${JSON.stringify(n)}: m${i}`).join(', ')} }, tables: { ${Object.keys(M.tables || {}).map((k) => `${k}: table_${k}`).join(', ')} }, stamp: __ESL_STAMP__ });`,
  ].join('\n');

  const bundle = async (stdin, define) => {
    const r = await esbuild.build({ stdin: { contents: stdin, resolveDir: ROOT, sourcefile: 'esl_entry.js', loader: 'js' }, bundle: true, format: 'iife', platform: 'neutral', target: 'es2020',
      write: false, metafile: true, legalComments: 'none', minify: false, treeShaking: false, define, logLevel: 'silent' });
    return { code: r.outputFiles[0].text, inputs: Object.keys(r.metafile.inputs).filter((p) => p !== 'esl_entry.js' && !p.startsWith('<')).sort() };
  };

  // first pass to learn the inputs, whose hash is the identity of the bundle
  const probe = await bundle(entry, { __ESL_STAMP__: '{}' });
  const sourceHash = sha(probe.inputs.map((p) => p + '\n' + sha(readFileSync(join(ROOT, p)))).join('\n')).slice(0, 16);
  const stamp = { name: pkg.name, version: pkg.version, commit: opts.release ? gitCommit() : null, built: opts.release ? new Date().toISOString() : null, sourceHash, esbuild: esbuild.version };
  const main = await bundle(entry, { __ESL_STAMP__: JSON.stringify(stamp) });
  const banner = `// Exoplanet Science Lab core ${pkg.version} (sources ${sourceHash}). Generated by tools/build_core_bundle.mjs from src/core; do not edit.\n`;
  const files = { 'esl_core.js': banner + main.code };

  for (const [k, t] of Object.entries(M.lazy || {})) {
    const lazy = await bundle(`import { ${t.export} as table } from ${JSON.stringify(rel(t.file))};\nglobalThis.ESL.${t.register}(table);`, {});
    files[t.out] = `// Exoplanet Science Lab: optional table "${k}" (${t.file}), loaded on first use. Generated; do not edit.\n` + lazy.code;
  }

  // ---- load it the way an embedded engine would and read back what it exposes
  const { ESL } = loadBundle(files['esl_core.js'], Object.values(M.lazy || {}).map((t) => files[t.out]));
  const info = JSON.parse(ESL.call('info', '[]'));
  if (!info.ok) throw new Error('the bundle does not load: ' + info.error);
  const manifest = { ...stamp, format: info.ok.format, formatVersion: info.ok.formatVersion, files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, { bytes: Buffer.byteLength(t), sha256: sha(t) }])),
    inputs: main.inputs, api: info.ok.api, jobs: info.ok.jobs, modules: info.ok.modules, bands: info.ok.bands, laws: info.ok.laws };
  files['manifest.json'] = JSON.stringify(manifest, null, 1) + '\n';
  const versionPy = `# Generated by tools/build_core_bundle.mjs from package.json; do not edit.\n__version__ = ${JSON.stringify(pkg.version)}\n`;

  if (opts.write !== false) {
    mkdirSync(outDir, { recursive: true });
    for (const [n, t] of Object.entries(files)) writeFileSync(join(outDir, n), t);
    if (!opts.outDir && M.versionFile) writeFileSync(join(ROOT, M.versionFile), versionPy);
  }
  return { files, manifest, outDir, info: info.ok, required: M.required, versionPy, versionFile: join(ROOT, M.versionFile) };
}

/** Names of the files that differ from what is on disk (empty: the committed bundle is current). */
export function staleFiles(built) {
  const out = [];
  for (const [n, t] of Object.entries(built.files)) { const p = join(built.outDir, n); if (!existsSync(p) || readFileSync(p, 'utf8') !== t) out.push(relative(ROOT, p)); }
  if (!existsSync(built.versionFile) || readFileSync(built.versionFile, 'utf8') !== built.versionPy) out.push(relative(ROOT, built.versionFile));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), flag = (f) => args.includes(f), outAt = args.indexOf('--out');
  const check = flag('--check');
  const built = await buildCoreBundle({ release: flag('--release'), outDir: outAt >= 0 ? args[outAt + 1] : undefined, write: !check });
  if (check) {
    const stale = staleFiles(built);
    if (stale.length) { console.error('stale (run `node tools/build_core_bundle.mjs`):\n  ' + stale.join('\n  ')); process.exit(1); }
    console.log(`python bundle is current (sources ${built.manifest.sourceHash})`);
  } else if (!flag('--quiet')) {
    const m = built.manifest;
    for (const [n, f] of Object.entries(m.files)) console.log(`${relative(ROOT, join(built.outDir, n)).padEnd(44)} ${(f.bytes / 1024).toFixed(0).padStart(6)} kB`);
    console.log(`version ${m.version}, sources ${m.sourceHash}${m.commit ? ', commit ' + m.commit : ''}: ${Object.keys(m.modules).length} modules, ${Object.values(m.modules).reduce((a, x) => a + x.length, 0)} exports, ${m.api.length} API functions, ${m.jobs.length} jobs`);
  }
}
