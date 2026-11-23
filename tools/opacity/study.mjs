// Resolution, size and speed of the opacity tables: every candidate set in data-src/study/ (tools/opacity/study.py)
// runs the same two planets through src/core/rtmodel.js; the spectra are binned to R = 100 (and R = 50) over
// 0.6-12 micron and compared with a reference set.
//   group "x" (names x..., k...): made from ExoMolOP's R = 15000 cross-sections; reference "truth", those points as they are
//   group "e" (names e...):       made from ExoMolOP's R = 1000 k-tables; reference "e1000g16", those tables as they are
// The reference runs with 240 layers and every species resorted; the candidates with 60 layers.
//   node --max-old-space-size=8192 tools/opacity/study.mjs e|x [candidate ...]     writes data-src/study/results.json
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { parseTable, binSpectrum } from '../../src/core/opacity.js';
import { forwardModel } from '../../src/core/rtmodel.js';

const DIR = new URL('../../data-src/study/', import.meta.url);
export const load = (name) => {
  const lines = [], cia = [];
  for (const f of readdirSync(new URL(name + '/', DIR)).filter((x) => x.endsWith('.eslo'))) {
    const b = readFileSync(new URL(`${name}/${f}`, DIR)), t = parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    (t.kind === 'cia' ? cia : lines).push(t);
  }
  return { lines, cia };
};
export const CASES = {
  // a warm Saturn-mass planet (WASP-39 b like) and a hot Jupiter (HD 189733 b like)
  warm: { planet: { mplanet: 0.28, rplanet: 1.27, pRef: 0.01 }, star: { rstar: 0.9, teff: 5400 }, tp: { kind: 'guillot', teq: 1100, tint: 100, kappaIR: 1e-3, gamma: 0.4 }, vmr: { H2O: 1e-3, CO2: 1e-5, CO: 1e-3, CH4: 1e-7 } },
  hot: { planet: { mplanet: 1.13, rplanet: 1.13, pRef: 0.01 }, star: { rstar: 0.75, teff: 5050 }, tp: { kind: 'guillot', teq: 1600, tint: 200, kappaIR: 2e-3, gamma: 0.3 }, vmr: { H2O: 5e-4, CO2: 1e-6, CO: 5e-4, CH4: 1e-6 } },
};
const edgesAt = (R) => { const e = []; for (let b = Math.ceil(Math.log(0.6 / 0.3) * R); 0.3 * Math.exp(b / R) <= 12.0001; b++) e.push(0.3 * Math.exp(b / R)); return e; };
export const binned = (grid, v, R = 100) => {
  const E = edgesAt(R);
  if (grid.kind !== 'ktable') return binSpectrum(grid.wl, v, { edges: E }).value;
  const out = new Float64Array(E.length - 1);   // average the k-table bins by their overlap in ln(wavelength)
  for (let b = 0; b < out.length; b++) { let s = 0, w = 0; for (let i = 0; i < grid.nWl; i++) { const lo = Math.max(E[b], grid.edges[i]), hi = Math.min(E[b + 1], grid.edges[i + 1]); if (hi > lo * (1 + 1e-9)) { const f = Math.log(hi / lo); s += f * v[i]; w += f; } } out[b] = s / w; }
  return out;
};
export const stats = (a, b, scale = 1e6) => { let s = 0, m = 0, n = 0; for (let i = 0; i < a.length; i++) { if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue; const d = (a[i] - b[i]) * scale; s += d * d; m = Math.max(m, Math.abs(d)); n++; } return { rms: Math.sqrt(s / n), max: m }; };
const rel = (a, b) => { let s = 0, m = 0, n = 0; for (let i = 0; i < a.length; i++) { if (!(b[i] > 0)) continue; const d = a[i] / b[i] - 1; s += d * d; m = Math.max(m, Math.abs(d)); n++; } return { rms: Math.sqrt(s / n), max: m }; };
const spectra = (r) => ({ d100: binned(r.grid, r.depth, 100), d50: binned(r.grid, r.depth, 50), e100: binned(r.grid, r.fpfs, 100), f100: binned(r.grid, r.flux, 100) });
const against = (r, t) => ({ tr: stats(r.d100, t.d100), tr50: stats(r.d50, t.d50), em: stats(r.e100, t.e100), emRel: rel(r.f100, t.f100) });

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const group = process.argv[2] || 'e', refName = group === 'e' ? 'e1000g16' : 'truth';
  const sizes = JSON.parse(readFileSync(new URL('sizes.json', DIR)));
  const names = process.argv.length > 3 ? process.argv.slice(3) : Object.keys(sizes).filter((n) => n !== refName && (group === 'e') === n.startsWith('e'));
  const results = existsSync(new URL('results.json', DIR)) ? JSON.parse(readFileSync(new URL('results.json', DIR))) : {};
  const refTables = load(refName), ref = {};
  for (const [k, model] of Object.entries(CASES)) ref[k] = spectra(forwardModel({ ...model, nLayers: 240 }, refTables, { greyBelow: 0 }));
  // layering alone, with the reference tables
  const layers = {};
  for (const nL of [30, 60, 120]) { layers[nL] = {}; for (const [k, model] of Object.entries(CASES)) layers[nL][k] = against(spectra(forwardModel({ ...model, nLayers: nL }, refTables, { greyBelow: 0 })), ref[k]); }
  results['layers-' + group] = layers;
  for (const nL of [30, 60, 120]) console.log(`layers ${nL}`.padEnd(18), ['warm', 'hot'].map((k) => `${k}: transit rms ${layers[nL][k].tr.rms.toFixed(1)} max ${layers[nL][k].tr.max.toFixed(1)} ppm, eclipse ${layers[nL][k].em.rms.toFixed(1)}/${layers[nL][k].em.max.toFixed(1)} ppm (${(100 * layers[nL][k].emRel.rms).toFixed(2)}%)`).join(' | '));
  refTables.lines.length = 0;
  for (const name of names) {
    const tables = load(name), row = { group, bytesPerSpecies: sizes[name].H2O, total: Object.values(sizes[name]).reduce((a, b) => a + b, 0), nWl: tables.lines[0].nWl, ng: tables.lines[0].ng, nT: tables.lines[0].t.length, nP: tables.lines[0].p.length, encoding: tables.lines[0].encoding.type };
    for (const [k, model] of Object.entries(CASES)) row[k] = against(spectra(forwardModel({ ...model, nLayers: 60 }, tables, { greyBelow: 0 })), ref[k]);
    // speed: a cold run (cross-sections interpolated), then warm runs that change an abundance only
    const cache = {}; let t0 = performance.now(); forwardModel({ ...CASES.warm, nLayers: 60 }, tables, { cache }); row.msCold = performance.now() - t0;
    const ts = []; for (let i = 0; i < 5; i++) { t0 = performance.now(); forwardModel({ ...CASES.warm, nLayers: 60, vmr: { ...CASES.warm.vmr, H2O: 1e-3 * (1 + 0.1 * i) } }, tables, { cache }); ts.push(performance.now() - t0); }
    row.msWarm = ts.sort((a, b) => a - b)[2];
    if (tables.lines[0].kind === 'ktable') {
      const r0 = spectra(forwardModel({ ...CASES.warm, nLayers: 60 }, tables, { greyBelow: 0 })), r1 = spectra(forwardModel({ ...CASES.warm, nLayers: 60 }, tables));
      row.greyShortcut = stats(r1.d100, r0.d100); t0 = performance.now(); forwardModel({ ...CASES.warm, nLayers: 60 }, tables, { cache, greyBelow: 0 }); row.msWarmFullOverlap = performance.now() - t0;
    }
    results[name] = row;
    console.log(name.padEnd(18), `${(row.bytesPerSpecies / 1e6).toFixed(2)} MB`.padStart(9), ['warm', 'hot'].map((k) => `${k}: transit rms ${row[k].tr.rms.toFixed(1)} max ${row[k].tr.max.toFixed(1)} (R50: ${row[k].tr50.rms.toFixed(1)}/${row[k].tr50.max.toFixed(1)}) ppm, eclipse ${row[k].em.rms.toFixed(1)}/${row[k].em.max.toFixed(1)} ppm (${(100 * row[k].emRel.rms).toFixed(2)}%)`).join(' | '), `| ${row.msCold.toFixed(0)} ms cold, ${row.msWarm.toFixed(0)} warm`, row.greyShortcut ? `(shortcut ${row.greyShortcut.max.toFixed(2)} ppm; ${row.msWarmFullOverlap.toFixed(0)} ms without)` : '');
  }
  writeFileSync(new URL('results.json', DIR), JSON.stringify(results, null, 1));
}
