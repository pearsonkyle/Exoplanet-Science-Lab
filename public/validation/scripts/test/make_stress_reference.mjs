// Brute-force references for the transit problems of the stress suite (test/stress_reference.json).
//
//   node test/make_stress_reference.mjs                 every problem that asks for a reference, one after another
//   node test/make_stress_reference.mjs <id> [<id>...]  only these (run several processes side by side), then
//   node test/make_stress_reference.mjs --merge         collect the parts into test/stress_reference.json
//   node test/make_stress_reference.mjs --from-ultranest results.json <id>...   reference from an UltraNest run (see below)
//
// Method: midpoint-rule quadrature of likelihood x prior on a regular grid. The posteriors are thin, tilted
// ridges (that is the point of the problems), so the grid is laid out in coordinates z = A^-1 (theta - mu),
// A the Cholesky factor of a pilot run's posterior covariance. The pilot run only chooses the linear map
// and the box; any map gives the same integral. The first coordinate (inclination) is kept as its own axis,
// so the prior edge at 90 degrees is a face of the grid and not a diagonal cut. Each case is integrated at
// two resolutions; the difference and the mass in the outermost grid layer are stored with the result.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { problems } from './stress_problems.mjs';
import { MiniNest } from '../src/core/nested.js';

const url = (p) => new URL(p, import.meta.url), PARTS = url('./stress_reference.parts/');
const args = process.argv.slice(2);
if (args[0] === '--merge') {
  const out = existsSync(url('./stress_reference.json')) ? JSON.parse(readFileSync(url('./stress_reference.json'))) : {};
  for (const f of readdirSync(PARTS)) if (f.endsWith('.json')) Object.assign(out, JSON.parse(readFileSync(new URL(f, PARTS))));
  writeFileSync(url('./stress_reference.json'), JSON.stringify(out, null, 1));
  console.log('merged ' + Object.keys(out).length + ' references: ' + Object.keys(out).join(', '));
  process.exit(0);
}

function quadrature(P, n, map) {
  const { d, mu, A, zlo, zhi, lo, hi, Lmax } = map, th = new Float64Array(d), z = new Float64Array(d), idx = new Array(d).fill(0);
  const h = zlo.map((a, k) => (zhi[k] - a) / n);
  let S = 0, edge = 0; const m1 = new Float64Array(d), m2 = new Float64Array(d * d);
  for (;;) {
    let inside = true, onEdge = false;
    for (let k = 0; k < d; k++) { z[k] = zlo[k] + (idx[k] + 0.5) * h[k]; if (idx[k] === 0 || idx[k] === n - 1) onEdge = true; }
    for (let a = 0; a < d && inside; a++) { let s = mu[a]; for (let k = 0; k <= a; k++) s += A[a * d + k] * z[k]; th[a] = s; if (s < lo[a] || s > hi[a]) inside = false; }
    if (inside) {
      const p = Math.exp(P.loglike(th) - Lmax);
      if (p > 0) { S += p; if (onEdge) edge += p; for (let a = 0; a < d; a++) { m1[a] += p * th[a]; for (let b = 0; b <= a; b++) m2[a * d + b] += p * th[a] * th[b]; } }
    }
    let k = 0; while (k < d && ++idx[k] === n) idx[k++] = 0;
    if (k === d) break;
  }
  let lnJ = 0, lnV = 0; for (let k = 0; k < d; k++) { lnJ += Math.log(A[k * d + k] * h[k]); lnV += Math.log(hi[k] - lo[k]); }
  const mean = Array.from(m1, (x) => x / S), cov = []; for (let a = 0; a < d; a++) { cov.push([]); for (let b = 0; b < d; b++) cov[a].push(m2[Math.max(a, b) * d + Math.min(a, b)] / S - mean[a] * mean[b]); }
  return { lnZ: Math.log(S) + Lmax + lnJ - lnV, mean, cov, edgeMass: edge / S };
}

/** Plain midpoint grid over a box given by the problem (uniform priors): P.grid = { lo, hi, n, priorLo, priorHi }. */
function gridReference(p, P) {
  const g = P.grid, d = P.ndim, th = new Float64Array(d), idx = new Array(d).fill(0), t0 = performance.now();
  const run = (scale) => {
    const n = g.n.map((x) => Math.round(x * scale)); idx.fill(0);
    let Lmax = -Infinity, S = 0; const m1 = new Float64Array(d), m2 = new Float64Array(d), vals = [];
    for (;;) { for (let k = 0; k < d; k++) th[k] = g.lo[k] + ((idx[k] + 0.5) / n[k]) * (g.hi[k] - g.lo[k]); const l = P.loglike(th); vals.push(l); if (l > Lmax) Lmax = l; let k = 0; while (k < d && ++idx[k] === n[k]) idx[k++] = 0; if (k === d) break; }
    idx.fill(0); let q = 0;
    for (;;) { for (let k = 0; k < d; k++) th[k] = g.lo[k] + ((idx[k] + 0.5) / n[k]) * (g.hi[k] - g.lo[k]); const w = Math.exp(vals[q++] - Lmax); S += w; for (let k = 0; k < d; k++) { m1[k] += w * th[k]; m2[k] += w * th[k] * th[k]; } let k = 0; while (k < d && ++idx[k] === n[k]) idx[k++] = 0; if (k === d) break; }
    let lnCell = 0; for (let k = 0; k < d; k++) lnCell += Math.log((g.hi[k] - g.lo[k]) / n[k]) - Math.log(g.priorHi[k] - g.priorLo[k]);
    const mean = Array.from(m1, (x) => x / S);
    return { lnZ: Math.log(S) + Lmax + lnCell, mean, sd: Array.from(m2, (x, k) => Math.sqrt(x / S - mean[k] ** 2)) };
  };
  const fine = run(1), coarse = run(0.7);
  const out = { lnZ: fine.lnZ, mean: fine.mean, sd: fine.sd, names: P.names, gridCheck: fine.lnZ - coarse.lnZ, sdCheck: Math.max(...fine.sd.map((x, k) => Math.abs(coarse.sd[k] / x - 1))), method: `midpoint quadrature on a ${g.n.join(' x ')} grid over [${g.lo}] to [${g.hi}]; checked against 0.7 of the resolution` };
  console.log(`${p.id}: lnZ ${fine.lnZ.toFixed(4)} (coarser grid ${out.gridCheck.toExponential(1)}, widths ${out.sdCheck.toExponential(1)}); ${P.names.map((nm, k) => `${nm} ${fine.mean[k].toPrecision(5)} ± ${fine.sd[k].toPrecision(3)}`).join(', ')}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  return out;
}

function reference(p) {
  const P = p.make(), d = P.ndim, t0 = performance.now();
  if (P.grid) return gridReference(p, P);
  // pilot run: posterior mean and covariance for the linear map, and the box that holds the posterior
  const ns = new MiniNest({ ndim: d, loglike: P.loglike, transform: P.transform, nlive: 1000, seed: 5 }); while (!ns.step(500));
  const r = ns.result(), mu = new Float64Array(d), C = new Float64Array(d * d);
  for (let i = 0; i < r.n; i++) for (let k = 0; k < d; k++) mu[k] += r.weights[i] * r.samples[i * d + k];
  for (let i = 0; i < r.n; i++) for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) C[a * d + b] += r.weights[i] * (r.samples[i * d + a] - mu[a]) * (r.samples[i * d + b] - mu[b]);
  const A = new Float64Array(d * d);
  for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) { let s = C[a * d + b]; for (let k = 0; k < b; k++) s -= A[a * d + k] * A[b * d + k]; A[a * d + b] = a === b ? Math.sqrt(s) : s / A[b * d + b]; }
  const zlo = new Array(d).fill(Infinity), zhi = new Array(d).fill(-Infinity), z = new Float64Array(d);
  for (let i = 0; i < r.n; i++) {
    if (r.logl[i] < r.maxLogL - 30) continue;                        // below e^-30 of the peak: no weight
    for (let a = 0; a < d; a++) { let s = r.samples[i * d + a] - mu[a]; for (let k = 0; k < a; k++) s -= A[a * d + k] * z[k]; z[a] = s / A[a * d + a]; if (z[a] < zlo[a]) zlo[a] = z[a]; if (z[a] > zhi[a]) zhi[a] = z[a]; }
  }
  for (let k = 0; k < d; k++) { const w = zhi[k] - zlo[k]; zlo[k] -= 0.15 * w + 0.5; zhi[k] += 0.15 * w + 0.5; }
  // first coordinate: theta_0 = mu_0 + A_00 z_0, so its prior edges are grid faces
  zlo[0] = Math.max(zlo[0], (P.lo[0] - mu[0]) / A[0]); zhi[0] = Math.min(zhi[0], (P.hi[0] - mu[0]) / A[0]);
  const map = { d, mu, A, zlo, zhi, lo: P.lo, hi: P.hi, Lmax: r.maxLogL };
  const n = d >= 4 ? 60 : 150, fine = quadrature(P, n, map), coarse = quadrature(P, Math.round(0.75 * n), map);
  const sd = fine.cov.map((row, k) => Math.sqrt(row[k])), corr = [];
  for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) corr.push([b, a, fine.cov[a][b] / (sd[a] * sd[b])]);
  const out = { lnZ: fine.lnZ, mean: fine.mean, sd, corr, names: P.names, grid: n, lnZcoarse: coarse.lnZ, gridCheck: fine.lnZ - coarse.lnZ, sdCheck: Math.max(...sd.map((s, k) => Math.abs(Math.sqrt(coarse.cov[k][k]) / s - 1))), edgeMass: fine.edgeMass,
    pilot: { lnZ: r.logZ, lnZerr: r.logZerr }, method: `midpoint quadrature, ${n}^${d} points in the whitened box of a pilot run; checked against ${Math.round(0.75 * n)}^${d}` };
  console.log(`${p.id}: lnZ ${fine.lnZ.toFixed(4)} (coarser grid ${out.gridCheck >= 0 ? '+' : ''}${out.gridCheck.toExponential(1)}, edge mass ${fine.edgeMass.toExponential(1)}, widths ${out.sdCheck.toExponential(1)}); pilot run ${r.logZ.toFixed(3)} ± ${r.logZerr.toFixed(3)}; ${P.names.map((nm, k) => `${nm} ${fine.mean[k].toPrecision(6)} ± ${sd[k].toPrecision(3)}`).join(', ')}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  return out;
}

mkdirSync(PARTS, { recursive: true });
// node test/make_stress_reference.mjs --from-ultranest <results.json> <id> [<id>...]
// Problems too large for quadrature (HD 80606 b, 7 parameters): the reference is UltraNest's run of the same
// likelihood (test/stress_ultranest.py --out results.json), an independent sampler. Uniform priors only.
if (args[0] === '--from-ultranest') {
  const un = JSON.parse(readFileSync(args[1]));
  for (const id of args.slice(2)) {
    const P = problems.find((p) => p.id === id).make(), d = P.ndim, r = un[id], x0 = new Float64Array(d), x1 = new Float64Array(d), xm = new Float64Array(d);
    P.transform(new Float64Array(d).fill(1e-9), x0); P.transform(new Float64Array(d).fill(1 - 1e-9), x1); P.transform(new Float64Array(d).fill(0.5), xm);
    for (let k = 0; k < d; k++) if (Math.abs(xm[k] - (x0[k] + x1[k]) / 2) > 1e-6 * Math.abs(x1[k] - x0[k])) throw new Error(id + ': prior of ' + P.names[k] + ' is not uniform');
    const out = { lnZ: r.logz, lnZerr: r.logzerr, mean: r.mean_u.map((m, k) => x0[k] + m * (x1[k] - x0[k])), sd: r.sd_u.map((sd, k) => sd * (x1[k] - x0[k])), names: P.names,
      method: `UltraNest ${r.mode} sampling, 400 live points, ${r.ncall} calls, ln Z ${r.logz.toFixed(3)} +- ${r.logzerr.toFixed(3)}` };
    writeFileSync(new URL(id + '.json', PARTS), JSON.stringify({ [id]: out }));
    console.log(`${id}: lnZ ${out.lnZ.toFixed(3)} ± ${out.lnZerr.toFixed(3)}; ${P.names.map((nm, k) => `${nm} ${out.mean[k].toPrecision(8)} ± ${out.sd[k].toPrecision(3)}`).join(', ')}`);
  }
  process.exit(0);
}
const want = problems.filter((p) => p.reference && (args.length ? args.includes(p.id) : true));
for (const p of want) writeFileSync(new URL(p.id + '.json', PARTS), JSON.stringify({ [p.id]: reference(p) }));
