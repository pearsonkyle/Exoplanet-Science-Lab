// Runs every numerical test. `npm test`
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let fail = 0;
for (const f of ['kernel.test.mjs', 'data.test.mjs', 'physics.test.mjs', 'limbdark.test.mjs', 'ephemeris.test.mjs', 'multiepoch.test.mjs', 'catalog.test.mjs', 'exotic.test.mjs', 'evidence.test.mjs', 'nested.test.mjs']) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./' + f, import.meta.url))], { stdio: 'inherit' });
  if (r.status !== 0) fail++;
}
process.exit(fail ? 1 : 0);
