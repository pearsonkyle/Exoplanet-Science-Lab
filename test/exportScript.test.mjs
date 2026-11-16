// The text exports of a session (src/core/exportScript.js): the Python script, the Markdown report, the LaTeX tables.
// The script is run under the Python package (python/, import name esl) and must reproduce the JavaScript result.
// Python is looked for in $ESL_PYTHON, then .venv-py/bin/python; without it the run is skipped and said so.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSession } from '../src/core/session.js';
import { pythonScriptFor, markdownReportFor, latexTablesFor, pyLiteral, formatValue, describeKey, dataSummary } from '../src/core/exportScript.js';
import { toySession } from '../python/tests/js/toy_session.mjs';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

check('Python literals', pyLiteral({ a: [1, 2.5, null, true], 'b c': 'x"y\n', n: 1e-7, big: 1e21 }) === '{"a": [1, 2.5, None, True], "b c": "x\\"y\\n", "n": 1e-7, "big": 1e+21}' && pyLiteral(NaN) === 'float("nan")');
check('values are written with two significant digits of their uncertainty', formatValue(111.4368071, 7.1e-5, 7.0e-5).value === '111.436807' && formatValue(111.4368071, 7.1e-5, 7.0e-5).plus === '0.000071' && formatValue(469.86, 0.4, 0.44).value === '469.86');
const { session, sys } = toySession('exotic');
session.title = 'toy-1873: three planets, TESS + NEID'; session.created = '2026-11-15T20:00:00Z'; session.software = { name: 'exoplanet-science-lab', version: '0.2.0', commit: null };
check('parameter keys are described from the registry', describeKey('per@c', session).label === 'P (c)' && describeKey('jit@rv1', session).label === 'jitter (NEID)' && describeKey('mplanet', session).unit === 'M Jup');
check('the data are summarised', dataSummary(session).length === 2 && dataSummary(session)[0].n === 368 && dataSummary(session)[0].epochs === 3 && dataSummary(session)[1].n === 40);

const before = pythonScriptFor(session);
check('a session without a result gives a script that says so', before.includes('BROWSER = None') && before.includes('session.run(progress=True)'));
const out = await runSession(session, { keepSamples: false }), done = { ...out.session, title: session.title }, r = done.result;
const script = pythonScriptFor(done), md = markdownReportFor(done), tex = latexTablesFor(done);
const dataLine = script.split('\n').find((l) => l.startsWith('{"light_curve"'));
check('the script rebuilds the session with the package\'s classes and embeds the data unchanged',
  ['import esl', 'esl.Session(', 'esl.Star(', 'esl.LimbDarkening(', 'esl.Planet(', 'esl.FitSettings(', 'esl.Sampler(nlive=300', 'esl.FreeParameter(key="mplanet@c", prior=esl.Prior.uniform(0, ', 'esl.FreeParameter(key="jit@rv1"', 'kepler=True', 'plot.corner(fit)', 'plot.radial_velocity(fit, fold=True)', 'fold=True'].every((x) => script.includes(x))
  && dataLine && JSON.stringify(JSON.parse(dataLine)) === JSON.stringify(done.data), `${script.split('\n').length} lines, ${(script.length / 1024).toFixed(0)} kB`);
check('the script carries the stored result to compare with', r.parameters.every((p) => script.includes(`"${p.key}": (${pyLiteral(p.median)}, `)) && script.includes(`"logZ": ${pyLiteral(r.logZ)}`));
const noData = pythonScriptFor(done, { embedData: false, sessionFile: 'toy.json', figures: false });
check('with embedData false the data are read from the session file', noData.includes('with_name("toy.json")') && !noData.includes('{"light_curve"') && noData.includes('MAKE_FIGURES = False'));
check('Markdown report: system, data, priors, sampler, result, reproduction', ['# toy-1873: three planets, TESS + NEID', '## System', '## Data', '## Fit set-up', '## Result', '## How to reproduce', '| light curve (3 epochs) | TESS | 368 |', '| radial velocity | NEID | 40 |',
  'Uniform(0, 15)', '300 live points', 'seed 4', 'Converged after', 'pip install exoplanet-science-lab', 'esl.Session.load("session.json")', 'Exoplanet Science Lab 0.2.0', '`K@c`'].every((x) => md.includes(x)) && md.includes(`ln Z = ${r.logZ.toFixed(2)}`), `${md.split('\n').length} lines`);
check('Markdown report of a session that was not run', markdownReportFor(session).includes('exported before a fit was run'));
check('LaTeX tables: parameters with asymmetric errors, and priors', tex.includes('\\begin{tabular}') && tex.includes('$M_p$ (c)') && tex.includes('\\mathcal{U}(0, 15)') && tex.includes('$\\sigma_{\\rm jit}$ (NEID)') && (tex.match(/\\begin\{table\}/g) || []).length === 2 && /\$[-0-9.]+(\^\{\+[0-9.]+\}_\{-[0-9.]+\}| \\pm [0-9.]+)\$/.test(tex));

// ---- run the script under the Python package
const root = fileURLToPath(new URL('..', import.meta.url));
const py = [process.env.ESL_PYTHON, join(root, '.venv-py/bin/python'), join(root, '.venv-py/Scripts/python.exe')].find((p) => p && existsSync(p));
const has = py && spawnSync(py, ['-c', 'import esl, matplotlib'], { encoding: 'utf8' }).status === 0;
if (!has) console.log('info  no Python with the esl package (set ESL_PYTHON, or create .venv-py and `pip install -e "python[test]"`): running the exported script was skipped');
else {
  const dir = mkdtempSync(join(tmpdir(), 'esl-export-'));
  try {
    writeFileSync(join(dir, 'toy_1873.py'), script);
    const t0 = performance.now(), run = spawnSync(py, ['toy_1873.py'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MPLBACKEND: 'Agg' } });
    check('the exported script runs under the Python package', run.status === 0, run.status === 0 ? `${((performance.now() - t0) / 1000).toFixed(1)} s including figures` : run.stderr.slice(-600));
    if (run.status === 0) {
      const back = JSON.parse(readFileSync(join(dir, 'toy_1873_result.json'), 'utf8')).result, by = Object.fromEntries(back.parameters.map((p) => [p.key, p]));
      const pull = r.parameters.map((p) => Math.abs(by[p.key].median - p.median) / (0.5 * (p.plus + p.minus))), rel = r.parameters.map((p) => Math.abs(by[p.key].median - p.median) / Math.abs(p.median));
      check('and reproduces the JavaScript result within sampling noise', Math.max(...pull) < 0.3 && Math.abs(back.logZ - r.logZ) < 3 * r.logZerr && Math.abs(back.chi2 - r.chi2) < 1,
        `largest difference of a median ${Math.max(...pull).toExponential(1)} sigma (${Math.max(...rel).toExponential(1)} relative); ln Z ${back.logZ.toFixed(4)} vs ${r.logZ.toFixed(4)}; ${back.ncalls} vs ${r.ncalls} calls`);
      check('it prints the comparison with the stored result and writes report and figures', run.stdout.includes('difference / sigma') && !run.stdout.includes('NOTE: python and the browser differ') && ['toy_1873_report.md', 'toy_1873_light_curve.png', 'toy_1873_rv.png', 'toy_1873_rv_phase.png', 'toy_1873_posterior.png'].every((f) => existsSync(join(dir, f))));
      const truth = { mplanet: sys.planets.b.mplanet, 'mplanet@c': sys.planets.c.mplanet, 'jit@rv1': sys.noise.rv_jitter };
      check('the Python result recovers the injected values', Object.entries(truth).every(([k, v]) => Math.abs(by[k].median - v) < 3 * Math.max(by[k].plus, by[k].minus)));
    }
    writeFileSync(join(dir, 'toy.json'), JSON.stringify(done)); writeFileSync(join(dir, 'nodata.py'), noData);
    const run2 = spawnSync(py, ['nodata.py'], { cwd: dir, encoding: 'utf8' });
    check('the variant that reads the session file runs too', run2.status === 0 && existsSync(join(dir, 'toy_1873_result.json')), run2.status === 0 ? '' : run2.stderr.slice(-400));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
process.exit(ok ? 0 : 1);
