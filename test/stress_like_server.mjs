// Likelihood server for the UltraNest comparison (test/stress_ultranest.py): evaluates one stress problem's
// likelihood on unit-cube points sent over stdin, so UltraNest runs on exactly the function MiniNest sees.
// Protocol (little-endian): request = int32 n, then n * d float64 (unit-cube points);
//                           reply   = n float64 (ln L). On start the server writes int32 d.
import { problems } from './stress_problems.mjs';
const p = problems.find((x) => x.id === process.argv[2]);
if (!p) { console.error('unknown problem ' + process.argv[2]); process.exit(2); }
const P = p.make(), d = P.ndim, u = new Float64Array(d), th = new Float64Array(d);
const head = Buffer.alloc(4); head.writeInt32LE(d); process.stdout.write(head);
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  for (;;) {
    if (buf.length < 4) return;
    const n = buf.readInt32LE(0), need = 4 + n * d * 8;
    if (buf.length < need) return;
    const out = Buffer.alloc(n * 8);
    for (let i = 0; i < n; i++) { for (let k = 0; k < d; k++) u[k] = buf.readDoubleLE(4 + (i * d + k) * 8); P.transform(u, th); out.writeDoubleLE(P.loglike(th), i * 8); }
    process.stdout.write(out); buf = buf.subarray(need);
  }
});
process.stdin.on('end', () => process.exit(0));
