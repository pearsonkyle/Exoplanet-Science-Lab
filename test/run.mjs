// Runs every numerical test. `npm test`
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let fail = 0;
for (const f of ['kernel.test.mjs', 'nightdates.test.mjs', 'companion.test.mjs', 'data.test.mjs', 'timestd.test.mjs', 'physics.test.mjs', 'limbdark.test.mjs', 'ldspec.test.mjs', 'ephemeris.test.mjs', 'scene.test.mjs', 'dataedit.test.mjs', 'lcdetrend.test.mjs', 'astro.test.mjs', 'fits.test.mjs', 'photometry.test.mjs', 'imexam.test.mjs', 'platesolve.test.mjs', 'skyfield.test.mjs', 'lcfits.test.mjs', 'zip.test.mjs', 'tpf_lightkurve.test.mjs', 'lcprep.test.mjs', 'k2.test.mjs', 'mast.test.mjs', 'prep.test.mjs', 'report.test.mjs', 'detrend.test.mjs', 'aavso.test.mjs', 'gp.test.mjs', 'psd.test.mjs', 'spectroscopy.test.mjs', 'exotic_photometry.test.mjs', 'periodogram.test.mjs', 'multiepoch.test.mjs', 'session.test.mjs', 'examples_real.test.mjs', 'sessiondetrend.test.mjs', 'lcnoise.test.mjs', 'rm.test.mjs', 'rmccf.test.mjs', 'hd80606rm.test.mjs', 'project.test.mjs', 'toisession.test.mjs', 'exportScript.test.mjs', 'methodsText.test.mjs', 'python_bundle.test.mjs', 'assistant.test.mjs', 'assistant_knowledge.test.mjs', 'assistant_sft.test.mjs', 'exomoon.test.mjs', 'phasecurve.test.mjs', 'phasemodel.test.mjs', 'phasepositive.test.mjs', 'nbody.test.mjs', 'nbodymodel.test.mjs', 'nbodyphoto.test.mjs', 'viability.test.mjs', 'aliases.test.mjs', 'horizon.test.mjs', 'xr.test.mjs', 'discovery.test.mjs', 'visible.test.mjs', 'plan_targets.test.mjs', 'catalog.test.mjs', 'relations.test.mjs', 'observability.test.mjs', 'sources.test.mjs', 'rvsources.test.mjs', 'eslcatalog.test.mjs', 'exotic.test.mjs', 'validation.test.mjs', 'audit.test.mjs', 'evidence.test.mjs', 'nested.test.mjs', 'stress.test.mjs']) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./' + f, import.meta.url))], { stdio: 'inherit' });
  if (r.status !== 0) fail++;
}
process.exit(fail ? 1 : 0);
