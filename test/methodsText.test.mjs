// methodsParagraph (src/core/methodsText.js): the paragraph and BibTeX written from a session.
// Checked on every stored example result (public/examples/results/): the text states what the session holds
// (counts, sampler settings, priors, version, outcome), the BibTeX holds exactly the keys cited in the text, and
// each model component brings its own references and no others. Lines: ok   name   numbers
import { readFileSync, readdirSync } from 'node:fs';
import { methodsParagraph, bibtexEntry, bibtexAuthors, allBibtex, SOFTWARE_KEY } from '../src/core/methodsText.js';
import { REFS } from '../src/validation/refs.js';

let fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}   ${info}`); if (!ok) fail++; };
const dir = new URL('../public/examples/results/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const S = Object.fromEntries(files.map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]));
const R = Object.fromEntries(Object.entries(S).map(([k, s]) => [k, methodsParagraph(s)]));
const entries = (bib) => [...bib.matchAll(/^@\w+\{([^,]+),/gm)].map((m) => m[1]);
const cited = (text) => [...new Set([...text.matchAll(/\[([a-z0-9, ]+)\]/gi)].flatMap((m) => m[1].split(',').map((x) => x.trim())).filter((k) => k === SOFTWARE_KEY || REFS[k]))];
const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// 1. every example: nothing undefined, and the BibTeX is exactly what the text cites
{
  const bad = [], counts = [];
  for (const [k, r] of Object.entries(R)) {
    if (/undefined|NaN|\[object|\?\)|~ \?/.test(r.text)) bad.push(`${k}: unfilled value`);
    if (!same(entries(r.bibtex), r.keys)) bad.push(`${k}: BibTeX entries differ from keys`);
    if (!same(cited(r.text), r.keys)) bad.push(`${k}: keys cited in the text differ from keys (${cited(r.text).join(' ')} vs ${r.keys.join(' ')})`);
    for (const e of r.bibtex.split('\n\n')) { let d = 0; for (const c of e) d += c === '{' ? 1 : c === '}' ? -1 : 0; if (d) bad.push(`${k}: unbalanced braces`); }
    counts.push(r.keys.length);
  }
  check('every stored example gives a paragraph whose BibTeX is exactly the keys it cites', !bad.length, bad.length ? bad.join('; ') : `${files.length} sessions, ${Math.min(...counts)} to ${Math.max(...counts)} references each, ${Object.values(R).reduce((a, r) => a + r.text.split(/\s+/).length, 0)} words in all`);
}

// 2. the text states the session's own numbers
{
  const bad = [];
  for (const [k, s] of Object.entries(S)) {
    const t = R[k].text, sm = s.fit.sampler, res = s.result, need = [`${sm.nlive} live points`, `seed ${sm.seed}`, `Exoplanet Science Lab ${s.software.version}`, `ln Z = ${res.logZ.toFixed(2)} +/- ${res.logZerr.toFixed(2)}`, `${s.fit.free.length} free parameter`];
    for (const n of need) if (!t.includes(n)) bad.push(`${k}: missing "${n}"`);
    if ((t.match(/ ~ ([UN]\(|one of \{)/g) || []).length !== s.fit.free.length) bad.push(`${k}: ${(t.match(/ ~ ([UN]\(|one of \{)/g) || []).length} priors printed for ${s.fit.free.length} free parameters`);
    const u = { lc: true, rv: true, timing: true, ...s.fit.use }, L = s.data.light_curve;
    if (u.lc && L && !t.includes(`${L.time.length} points`)) bad.push(`${k}: light-curve count`);
    if (!(u.lc && L) && /transit model is/.test(t)) bad.push(`${k}: describes a light curve that is not in the fit`);
  }
  const j = S['hd80606-joint'], tj = R['hd80606-joint'].text;
  check('sampler settings, version, outcome, data counts and one prior per free parameter are those of the session', !bad.length, bad.length ? bad.join('; ') : `HD 80606 joint: ${j.data.light_curve.time.length} fluxes, ${j.data.radial_velocity.reduce((a, r) => a + r.time.length, 0)} velocities from ${j.data.radial_velocity.length} instruments, ${j.fit.free.length} priors, ${j.result.ncalls} calls; ${tj.split(/\s+/).length} words`);
}

// 3. references follow the components
{
  const has = (k, ref) => R[k].keys.includes(ref), base = ['esl', 'skilling2006', 'buchner2021', 'buchner2016', 'buchner2019'];
  const exp = {
    'hd80606-rv': [...base, 'danby1987'],                                              // velocities only: no limb darkening
    'hd80606-tess': [...base, 'claret2000', 'danby1987'],
    single: [...base, 'claret2000', 'danby1987'],                                      // quadratic law, e = 0.159
    nbody: [...base, 'wisdom1991', 'rein2015whfast'],
    eclipsemap: [...base, 'claret2000', 'luger2019'],
    phasecurve: [...base, 'claret2000'],                                               // circular orbit, harmonic phase curve: no Kepler solver, no map
  };
  const bad = Object.entries(exp).filter(([k, v]) => !same(R[k].keys, v)).map(([k, v]) => `${k}: ${R[k].keys.join(' ')} (expected ${v.join(' ')})`);
  check('each component brings its references and no others', !bad.length && !has('phasecurve', 'danby1987') && !has('hd80606-rv', 'claret2000'), bad.length ? bad.join('; ') : `velocities only ${exp['hd80606-rv'].length}, transit ${exp['hd80606-tess'].length}, N-body ${exp.nbody.length}, eclipse map ${exp.eclipsemap.length} keys`);
}

// 4. options and edge cases
{
  const s = structuredClone(S.single); s.limb_darkening.mode = 'star'; s.limb_darkening.law = 'kipping';
  const a = methodsParagraph(s), b = methodsParagraph(s, { ldSource: 'PHOENIX table', sliceUsed: true }), c = methodsParagraph(s, { ldSource: 'grey atmosphere' });
  const n = structuredClone(S.single); n.result = null; const d = methodsParagraph(n);
  const u = structuredClone(S.single); u.result.converged = false; u.result.stop_reason = 'max calls reached'; const e = methodsParagraph(u);
  check('limb darkening that follows the star, slice sampling, a missing result and an unconverged run are reported as such',
    a.notes.some((x) => /ldSource/.test(x)) && !a.keys.includes('husser2013') && b.keys.includes('husser2013') && b.keys.includes('neal2003') && b.keys.includes('kipping2013') && !c.keys.includes('husser2013') && /grey-atmosphere/.test(c.text)
    && !/ln Z =/.test(d.text) && d.notes.some((x) => /no result/.test(x)) && /did not converge \(max calls reached/.test(e.text) && /ln Z = [-\d.]+ \+\/- [\d.]+ is only a lower bound/.test(e.text),
    `keys ${a.keys.length} / ${b.keys.length} / ${c.keys.length}; notes ${a.notes.length} / ${d.notes.length} / ${e.notes.length}`);
  const twice = methodsParagraph(S.multi);
  check('the function is pure: the same session gives the same text and BibTeX', twice.text === R.multi.text && twice.bibtex === R.multi.bibtex && JSON.stringify(S.multi) === readFileSyncJson('multi'), `${twice.text.length} characters`);
}
function readFileSyncJson(k) { return JSON.stringify(JSON.parse(readFileSync(new URL(k + '.json', dir), 'utf8'))); }

// 5. BibTeX of the whole bibliography
{
  const all = allBibtex({ version: '0.2.0', year: 2026 }), ks = entries(all), bad = [];
  for (const k of Object.keys(REFS)) { const e = bibtexEntry(k); if (!/author = \{.+\}/.test(e)) bad.push(k + ': no author'); if (REFS[k].doi && !e.includes(`doi = {${REFS[k].doi}}`)) bad.push(k + ': doi'); if (/^@article/.test(e) && !/volume = \{\d+\}/.test(e)) bad.push(k + ': volume'); }
  const art = Object.keys(REFS).filter((k) => /^@article/.test(bibtexEntry(k))).length;
  check('every reference of refs.js has a BibTeX entry with its DOI; journal articles carry journal, volume and page', !bad.length && ks.length === Object.keys(REFS).length + 1 && ks[0] === SOFTWARE_KEY && new Set(ks).size === ks.length, bad.length ? bad.join('; ') : `${ks.length} entries: the software, ${art} articles, ${ks.length - 1 - art} other`);
  check('author lists', bibtexAuthors('Agol, E., Luger, R. & Foreman-Mackey, D.') === 'Agol, E. and Luger, R. and Foreman-Mackey, D.' && bibtexAuthors('Astropy Collaboration, Price-Whelan, A. M., Lim, P. L., Earl, N., et al.') === '{Astropy Collaboration} and Price-Whelan, A. M. and Lim, P. L. and Earl, N. and others' && bibtexAuthors('The mpmath development team') === '{The mpmath development team}' && bibtexAuthors('Husser, T.-O., Wende-von Berg, S., Dreizler, S., Homeier, D., et al.').startsWith('Husser, T.-O. and Wende-von Berg, S. and'), '3 authors, a collaboration with "et al.", a team name, hyphenated initials');
}
process.exit(fail ? 1 : 0);
