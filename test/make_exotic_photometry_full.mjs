// Runs this code on all 142 frames of EXOTIC's sample data and records the result next to EXOTIC's:
//   node test/make_exotic_photometry_full.mjs [sample directory]     -> test/exotic_photometry_full.json
// The committed test (exotic_photometry.test.mjs) runs on cut-outs of every third frame and checks that they
// reproduce the corresponding points recorded here; with the full data present (ESL_EXOTIC_SAMPLE) it reruns this.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { runStack } from '../src/photometry/pipeline.js';
import { seriesOf } from '../src/core/photometry.js';

export async function runFull(dir, R, score = 'transit') {
  const names = readdirSync(dir).filter((f) => /\.fits?$/i.test(f)).sort();
  const files = names.map((f) => { const b = readFileSync(dir + '/' + f); return { name: f, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; });
  const P = R.planet, planet = { rprs: P.rprs, ars: P.aRs, inc: P.inc, per: P.pPer, tmid: P.midT, ecc: P.ecc, omega: P.omega, ld: R.ld, tmidUnc: P.midTUnc, perUnc: P.pPerUnc };
  const cfg = { stars: R.stars.map(([x, y]) => ({ x, y })), timeAt: 'exotic', target: { ra: P.ra, dec: P.dec }, site: R.site, apertures: R.apers, annuli: R.annuli, score, planet };
  const t0 = performance.now(), res = await runStack(files, cfg);
  return { res, seconds: (performance.now() - t0) / 1000, planet };
}

export function summarise(res) {
  const { M, opt } = res, n = M.count, r6 = (a) => Array.from(a, (v) => +v.toPrecision(9));
  const bestBy = {}; for (const r of opt.tried) { const k = r.method + '/' + (r.comp < 0 ? 'none' : r.comp === 0 ? 'all' : 'C' + r.comp); if (!bestBy[k] || r.scatter < bestBy[k].scatter) bestBy[k] = { aperture: r.aperture, annulus: r.annulus, ia: r.ia, in: r.in, comp: r.comp, scatter: r.scatter, robust: r.robust, n: r.n, params: r.params }; }
  const b = opt.tried[opt.best], series = (row) => { const T = seriesOf(M, row.method, 0, row.ia, row.in), C = new Float64Array(n).fill(row.comp < 0 ? 1 : 0); if (row.comp > 0) seriesOf(M, row.method, row.comp, row.ia, row.in, C); else if (row.comp === 0) for (let j = 1; j < M.nS; j++) { const q = seriesOf(M, row.method, j, row.ia, row.in); for (let f = 0; f < n; f++) C[f] += q[f]; } return { targetFlux: r6(T), compFlux: r6(C) }; };
  const grid = (comp) => { const g = []; for (let a = 0; a < M.nA; a++) { const row = []; for (let k = 0; k < M.nN; k++) row.push(+opt.tried.find((r) => r.method === 'aperture' && r.ia === a && r.in === k && r.comp === comp).scatter.toPrecision(6)); g.push(row); } return g; };
  return { frames: n, relocated: res.relocated, sigma: res.sigma, x: r6(M.x.subarray(0, n * M.nS)), y: r6(M.y.subarray(0, n * M.nS)), time: Array.from(M.time.subarray(0, n)), airmass: Array.from(M.airmass.subarray(0, n)), rot: r6(M.rot.subarray(0, n)),
    best: { ...b, ...series(b) }, bestBy, candidates: opt.tried.length, grid: { none: grid(-1), C1: grid(1), C2: grid(2), all: grid(0) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || '/tmp/esl_exotic_sample/EXOTIC_sampledata-1.0.0/HatP32Dec202017';
  if (!existsSync(dir)) { console.error('sample data not found: ' + dir); process.exit(1); }
  const R = JSON.parse(readFileSync(new URL('./exotic_photometry_reference.json', import.meta.url)));
  const out = { generator: 'test/make_exotic_photometry_full.mjs on EXOTIC_sampledata-1.0.0 (142 full frames), ' + new Date().toISOString().slice(0, 10) };
  for (const score of ['transit', 'quick']) { const { res, seconds } = await runFull(dir, R, score); out[score] = { ...summarise(res), seconds, timing: res.timing }; if (score === 'quick') { delete out.quick.x; delete out.quick.y; delete out.quick.time; delete out.quick.airmass; delete out.quick.rot; delete out.quick.grid; }
    console.log(score, 'best', JSON.stringify({ ...out[score].best, targetFlux: undefined, compFlux: undefined }), seconds.toFixed(1) + ' s'); }
  writeFileSync(new URL('./exotic_photometry_full.json', import.meta.url), JSON.stringify(out));
}
