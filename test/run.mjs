// Runs every numerical test. `npm test`
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let fail = 0;
for (const f of ['kernel.test.mjs', 'data.test.mjs', 'physics.test.mjs', 'limbdark.test.mjs', 'ldspec.test.mjs', 'ephemeris.test.mjs', 'scene.test.mjs', 'astro.test.mjs', 'fits.test.mjs', 'photometry.test.mjs', 'gp.test.mjs', 'psd.test.mjs', 'exotic_photometry.test.mjs', 'periodogram.test.mjs', 'multiepoch.test.mjs', 'session.test.mjs', 'exportScript.test.mjs', 'python_bundle.test.mjs', 'assistant.test.mjs', 'exomoon.test.mjs', 'phasecurve.test.mjs', 'phasemodel.test.mjs', 'nbody.test.mjs', 'nbodymodel.test.mjs', 'horizon.test.mjs', 'catalog.test.mjs', 'relations.test.mjs', 'observability.test.mjs', 'sources.test.mjs', 'eslcatalog.test.mjs', 'exotic.test.mjs', 'validation.test.mjs', 'evidence.test.mjs', 'nested.test.mjs', 'stress.test.mjs']) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./' + f, import.meta.url))], { stdio: 'inherit' });
  if (r.status !== 0) fail++;
}
process.exit(fail ? 1 : 0);
