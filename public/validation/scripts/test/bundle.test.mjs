// The Atmosphere page's "Download everything" (src/atmosphere/bundle.js): the files hold what the page plots, at the
// sampling promised, and the Python script in the bundle redraws the figures from them when Python is at hand.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundleFiles } from '../src/atmosphere/bundle.js';
import { parseTable } from '../src/core/opacity.js';
import { dayNightModel, opacityByAbsorber, geometricAlbedo } from '../src/core/rtmodel.js';
import { WORLDS } from '../src/core/worlds.js';
import { cmfX, cmfY, cmfZ } from '../src/core/colour.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const shipped = (name) => { const b = readFileSync(new URL(`../public/opacity/${name}.eslo`, import.meta.url)); return parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const W = WORLDS.Titan, tables = { lines: [shipped('CH4')], cia: ['N2-N2', 'N2-CH4', 'N2-H2'].map(shipped) };
const r = dayNightModel(W.model, tables, { want: { maps: true, albedo: true } }), a = r.atm, part = dayNightModel(W.model, tables, { only: ['CH4'] });
const layers = []; for (let d = -7; d <= 0; d++) { let j = 0; while (j < a.n - 1 && a.pLay[j] / 1e5 < 10 ** d) j++; layers.push(j); }
const nm = []; for (let v = 380; v <= 750; v += 10) nm.push(v);
const result = { wl: r.wl, edges: r.grid.edges, depth: r.depth, fpfs: r.fpfs, flux: r.flux, brightness: r.brightness, trans: r.trans, contribution: r.contribution, topTau: r.topTau, albedo: geometricAlbedo(r), climate: null, atm: a };
const files = bundleFiles({ name: 'Titan', model: W.model, result, parts: { CH4: { depth: part.depth, fpfs: part.fpfs } }, decades: layers.map((j) => opacityByAbsorber(W.model, tables, j)), index: { R: 200, ng: 12, tables: [{ species: 'CH4', source: 'ExoMolOP', doi: 'x', licence: 'CC BY-SA 4.0' }] },
  colour: { nm, cmf: { x: nm.map(cmfX), y: nm.map(cmfY), z: nm.map(cmfZ) }, curves: [{ name: 'starlight', y: nm.map(() => 1) }], swatches: [{ label: 'star', rgb: 'rgb(255,240,230)' }] }, stamp: '2026-11-20T00:00:00.000Z', page: 'https://example.org/analyze/atmosphere/' });
const F = Object.fromEntries(files.map((f) => [f.name, f.data])), rows = (name) => F[name].trim().split('\n').map((l) => l.split(','));
{
  const sp = rows('spectrum.csv'), pr = rows('profile.csv'), op = rows('opacity_by_absorber.csv'), tr = rows('limb_transmittance.csv'), m = JSON.parse(F['model.json']);
  const i = 300, col = (t, k) => t[0].indexOf(k), levels = [...new Set(op.slice(1).map((x) => x[0]))];
  const o3 = opacityByAbsorber(W.model, tables, layers[3]), H = (1.380649e-23 * o3.t) / (a.mu[o3.layer] * 1.66053906660e-27 * a.g[o3.layer]), line = op.find((x) => x[0] === levels[3] && Math.abs(+x[2] / o3.wl[i] - 1) < 1e-5);
  check('the bundle holds the model and every plotted quantity', ['model.json', 'spectrum.csv', 'profile.csv', 'opacity_by_absorber.csv', 'limb_transmittance.csv', 'emission_contribution.csv', 'colour.csv', 'colour.json', 'colours_of_gases.json', 'clouds.json', 'figures.py', 'README.txt'].every((k) => typeof F[k] === 'string' && F[k].length > 20)
    && sp.length === r.wl.length + 1 && Math.abs(+sp[i + 1][col(sp, 'transit_depth')] / r.depth[i] - 1) < 1e-5 && Math.abs(+sp[i + 1][col(sp, 'transit_depth_CH4_alone')] / part.depth[i] - 1) < 1e-5
    && pr.length === a.n + 1 && Math.abs(+pr[a.n][col(pr, 'vmr_CH4')] - 0.0565) < 1e-6 && Math.abs(+pr[a.n][col(pr, 'pressure_bar')] / (a.pLay[a.n - 1] / 1e5) - 1) < 1e-5
    && tr.length === r.wl.length + 1 && tr[0].length === a.n + 2 && m.model.bulk === 'N2' && m.format === 'esl-atmosphere-model',
    `${files.length} files, ${(files.reduce((s, f) => s + f.data.length, 0) / 1e6).toFixed(1)} MB; spectrum ${sp.length - 1} bins with the spectrum of CH4 alone; profile ${pr.length - 1} layers with ${pr[0].filter((k) => k.startsWith('vmr_')).length} gases; the maps at every level`);
  check('opacity by absorber: one level per decade of pressure, every wavelength, as optical depth per scale height', levels.length === layers.length && op.length === 1 + layers.length * r.wl.length && levels.every((p, k) => k === 0 || +p / +levels[k - 1] > 5 && +p / +levels[k - 1] < 20) && Math.abs(+line[3] / (o3.total[i] * H) - 1) < 1e-4,
    `${levels.length} levels (${levels.map((p) => (+p).toExponential(0)).join(', ')} bar) x ${r.wl.length} wavelengths, not the model's ${a.n} layers; at ${(+levels[3]).toExponential(1)} bar and ${o3.wl[i].toFixed(3)} µm the file says ${(+line[3]).toExponential(3)}, the model ${(o3.total[i] * H).toExponential(3)}`);
}
{
  const py = [new URL('../.venv/bin/python', import.meta.url).pathname, new URL('../.venv-py/bin/python', import.meta.url).pathname, new URL('../.venv-rt/bin/python', import.meta.url).pathname, 'python3'].find((p) => { try { return spawnSync(p, ['-c', 'import numpy, matplotlib'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
  if (!py) check('figures.py redraws the figures (skipped: no Python with numpy and matplotlib here)', true);
  else {
    const dir = mkdtempSync(join(tmpdir(), 'esl-bundle-')); for (const f of files) writeFileSync(join(dir, f.name), f.data);
    const run = spawnSync(py, ['figures.py'], { cwd: dir, encoding: 'utf8' }), made = ['spectrum.png', 'structure.png', 'opacity.png', 'maps.png', 'colour.png'].filter((f) => existsSync(join(dir, f)) && readFileSync(join(dir, f)).length > 5000);
    check('figures.py redraws the five figures from the files alone', run.status === 0 && made.length === 5, run.status === 0 ? `${made.join(', ')} in ${dir}` : (run.stderr || '').slice(-600));
  }
}
process.exit(ok ? 0 : 1);
