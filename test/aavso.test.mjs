// The AAVSO Exoplanet Watch report (src/core/aavso.js) against EXOTIC's own writer (exotic/output_files.py
// OutputFiles.aavso and exotic/utils.py round_to_2), run read-only in the owner's conda environment by
// test/make_aavso_reference.py. The reports must be identical character for character, apart from the SOFTWARE line.
import { readFileSync } from 'node:fs';
import { aavsoReport, roundTo2, pyRound, pyFloat, pyDumps } from '../src/core/aavso.js';
import { parseLightCurve } from '../src/core/data.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./aavso_reference.json', import.meta.url)));
console.log('reference: ' + ref.generator);

check("Python's repr of floats", [[1e-7, '1e-07'], [1.3e-7, '1.3e-07'], [0.0001, '0.0001'], [2, '2.0'], [-0.5, '-0.5'], [1e16, '1e+16'], [2458107.71354, '2458107.71354']].every(([x, s]) => pyFloat(x) === s), '1e-07, 2.0, 1e+16, ...');
check("Python's round(): ties to even on the exact binary value", pyRound(2.675, 2) === 2.67 && pyRound(0.125, 2) === 0.12 && pyRound(0.375, 2) === 0.38 && pyRound(2.5, 0) === 2 && pyRound(-0.125, 2) === -0.12, `round(2.675, 2) = ${pyRound(2.675, 2)}, round(0.125, 2) = ${pyRound(0.125, 2)}, round(0.375, 2) = ${pyRound(0.375, 2)}`);
{ const bad = ref.round_to_2.filter(([x, y, want]) => roundTo2(x, y) !== want); check("round_to_2 equals EXOTIC's on 8 cases", !bad.length, ref.round_to_2.map(([x, y, w]) => `${x} → ${pyFloat(w)}`).join(', ') + (bad.length ? '; wrong: ' + JSON.stringify(bad) : '')); }
check('json.dumps formatting', pyDumps({ a: '1.0', b: null, c: [{ v: 'x' }] }) === '{"a": "1.0", "b": null, "c": [{"v": "x"}]}');

ref.cases.forEach((c, k) => {
  const r = {
    software: `EXOTIC v${ref.version}`, obscode: c.i.aavso_num, secondaryObscodes: c.i.second_obs, camera: c.i.camera, star: c.p.sName, planet: c.p.pName, binning: c.i.pixel_bin, exposure: c.i.exposure, notes: c.i.notes,
    compStar: c.comp, filter: c.i.filter, filterDesc: c.i.filter_desc, wlMin: c.i.wl_min, wlMax: c.i.wl_max,
    prior: { per: c.p.pPer, perUnc: c.p.pPerUnc, rprs: c.p.rprs, rprsUnc: c.p.rprsUnc, ars: c.p.aRs, arsUnc: c.p.aRsUnc, inc: c.p.inc, incUnc: c.p.incUnc, ecc: c.p.ecc },
    ld: c.ld, fit: c.fit, errors: c.errors, durations: c.durations, epwMd5: c.md5,
    rows: { time: c.time, flux: c.flux, err: c.err, airmass: c.airmass, airmassModel: c.airmassModel },
  };
  const mine = aavsoReport(r), a = mine.split('\n'), b = c.text.split('\n'), diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
  check(`report ${k + 1}: identical to EXOTIC's, line for line`, mine === c.text, `${b.length} lines, ${c.text.length} characters` + (diff.length ? `; first difference at line ${diff[0] + 1}:\n   mine:   ${a[diff[0]]}\n   EXOTIC: ${b[diff[0]]}` : ''));
  if (k === 0) {
    const L = parseLightCurve(mine, 'report');
    check("the report reads back in the analyzer's reader (priors, Tc, airmass column)", L.t.length === c.time.length && L.meta.priors && Math.abs(L.meta.priors.per - c.p.pPer) < 1e-12 && L.airmass && Math.abs(L.airmass[0] - c.airmass[0]) < 1e-6, `${L.t.length} points; period prior ${L.meta.priors.per}; notes: ${L.notes.join('; ')}`);
  }
});
process.exit(ok ? 0 : 1);
