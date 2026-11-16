// The project report (src/core/report.js) on a stored example with its result: every section present, in order,
// the numbers taken from the session's own result, citations in Pandoc form with the BibTeX of exactly those keys,
// and the observing project and reduction record carried into their sections.
import { readFileSync } from 'node:fs';
import { projectReport, REPORT_SECTIONS } from '../src/core/report.js';
import { formatValue } from '../src/core/exportScript.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const s = JSON.parse(readFileSync(new URL('../public/examples/results/hd80606-joint.json', import.meta.url)));
const project = { v: 1, title: 'HD 80606 b joint fit', target: { name: 'HD 80606 b', ra: 140.6569, dec: 50.6036, per: 111.4367, tmid: 2458888.07, source: 'catalogue' }, site: { name: 'Kitt Peak', lat: 31.958, lon: -111.6, elev: 2096 }, event: { kind: 'transit', night: '2020-02-07', mid: 2458888.07 }, done: { target: 'x', plan: 'x' }, files: [], fits: [] };
const reduction = { name: 'HD 80606 TESS', frames: 1234, method: 'aperture', aperture_px: 3.71, annulus_px: 10.7, comparison: 'C1 + C2', scatter: 0.00496, time_system: 'BJD_TDB', software: 'ESL photometry 1' };
const runs = [{ id: 1, label: 'circular', name: 'rprs, tmid', logZ: 100.2, err: 0.2, converged: true, chi2: 300, n: 320 }, { id: 2, label: 'eccentric', name: 'rprs, tmid, ecc, omega', logZ: 104.9, err: 0.25, converged: true, chi2: 290, n: 320 }];
const r = projectReport(s, { project, reduction, runs, figures: ['light_curve.png', 'corner.png'], files: ['session.json', 'report.bib'], date: '2026-11-16' });
const heads = r.markdown.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3));
check('every section, in the standard order', JSON.stringify(heads) === JSON.stringify(REPORT_SECTIONS), heads.join(' · '));
const rp = s.result.parameters.find((p) => p.key === 'rprs'), f = formatValue(rp.median, rp.plus, rp.minus);
check('summary numbers are the session result', r.markdown.includes(f.value) && /ln Z = /.test(r.markdown), `Rp/R★ ${f.value} +${f.plus} −${f.minus}`);
const cited = [...new Set([...r.markdown.matchAll(/\[(@[^\]]+)\]/g)].flatMap((m) => m[1].split(/;\s*/).map((k) => k.replace(/^@/, ''))))], bibKeys = [...r.bibtex.matchAll(/^@\w+\{([^,]+),/gm)].map((m) => m[1]);
check('citations are Pandoc keys with exactly that BibTeX', cited.length > 0 && cited.every((k) => bibKeys.includes(k)) && bibKeys.every((k) => cited.includes(k)), `${bibKeys.length} entries: ${bibKeys.join(', ')}`);
check('observing project and reduction carried in', /Kitt Peak/.test(r.markdown) && /night of 2020-02-07/.test(r.markdown) && /0\.496%/.test(r.markdown) && /C1 \+ C2/.test(r.markdown));
check('runs compared against the best', /\| #2 eccentric .*\| reference \|/.test(r.markdown) && /\| #1 circular .*\| -4\.7 \|/.test(r.markdown));
check('figures linked', /!\[Figure 1: light curve\]\(light_curve\.png\)/.test(r.markdown) && /!\[Figure 2: corner\]\(corner\.png\)/.test(r.markdown));
const bare = projectReport({ ...s, result: undefined });
check('a set-up without a fit or project still has every section and says what is missing', bare.markdown.split('\n').filter((l) => /^## /.test(l)).length === REPORT_SECTIONS.length && /No fit has been run yet/.test(bare.markdown) && /No observing project/.test(bare.markdown) && /not reduced on this site/.test(bare.markdown));
process.exit(ok ? 0 : 1);
