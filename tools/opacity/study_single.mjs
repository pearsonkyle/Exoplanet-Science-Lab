// One absorber at a time: the R = 15000 reference against (a) k-tables made here from those points and (b) ExoMolOP's
// own R = 1000 k-tables, made from the full line lists. Tells which of the two limits the comparison in study.mjs.
//   node tools/opacity/study_single.mjs
import { readFileSync } from 'node:fs';
import { parseTable, binSpectrum } from '../../src/core/opacity.js';
import { forwardModel } from '../../src/core/rtmodel.js';
import { CASES } from './study.mjs';
const DIR = new URL('../../data-src/study/', import.meta.url);
const one = (name, sp) => { const b = readFileSync(new URL(`${name}/${sp}.eslo`, DIR)); return { lines: [parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))], cia: [] }; };
const EDGES = []; for (let b = Math.ceil(Math.log(0.6 / 0.3) * 100); 0.3 * Math.exp(b / 100) <= 12.0001; b++) EDGES.push(0.3 * Math.exp(b / 100));
const binned = (grid, v) => {
  if (grid.kind !== 'ktable') return binSpectrum(grid.wl, v, { edges: EDGES }).value;
  const out = new Float64Array(EDGES.length - 1);
  for (let b = 0; b < out.length; b++) { let s = 0, w = 0; for (let i = 0; i < grid.nWl; i++) { const lo = Math.max(EDGES[b], grid.edges[i]), hi = Math.min(EDGES[b + 1], grid.edges[i + 1]); if (hi > lo * (1 + 1e-9)) { const f = Math.log(hi / lo); s += f * v[i]; w += f; } } out[b] = s / w; }
  return out;
};
const stats = (a, b) => { let s = 0, m = 0, n = 0, mean = 0; for (let i = 0; i < a.length; i++) { const d = (a[i] - b[i]) * 1e6; s += d * d; mean += d; m = Math.max(m, Math.abs(d)); n++; } return `rms ${Math.sqrt(s / n).toFixed(1)} max ${m.toFixed(1)} mean ${(mean / n).toFixed(1)} ppm`; };
for (const sp of ['H2O', 'CO2']) for (const c of ['warm', 'hot']) {
  const model = { ...CASES[c], vmr: { [sp]: CASES[c].vmr[sp] }, nLayers: 60 }, out = {};
  for (const name of ['truth', 'k1000g16', 'k300g8', 'kexo']) { const r = forwardModel(model, one(name, sp)); out[name] = { depth: binned(r.grid, r.depth), fpfs: binned(r.grid, r.fpfs) }; }
  console.log(`${sp} ${c}  transit:  made here R1000 g16 vs reference ${stats(out.k1000g16.depth, out.truth.depth)} | R300 g8 vs reference ${stats(out.k300g8.depth, out.truth.depth)} | ExoMolOP k vs reference ${stats(out.kexo.depth, out.truth.depth)} | made here R1000 g16 vs ExoMolOP k ${stats(out.k1000g16.depth, out.kexo.depth)}`);
  console.log(`${sp} ${c}  eclipse:  made here R1000 g16 vs reference ${stats(out.k1000g16.fpfs, out.truth.fpfs)} | R300 g8 vs reference ${stats(out.k300g8.fpfs, out.truth.fpfs)} | ExoMolOP k vs reference ${stats(out.kexo.fpfs, out.truth.fpfs)} | made here R1000 g16 vs ExoMolOP k ${stats(out.k1000g16.fpfs, out.kexo.fpfs)}`);
}
