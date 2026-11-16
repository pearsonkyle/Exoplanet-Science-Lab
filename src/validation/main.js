// The validation part of the Methods page (methods/, tab "Validation"; the old page validation/ redirects there). The
// narrative skeleton (headings, table of contents, the sentences without numbers) is in methods/index.html; this module loads the stored reference values (public/validation/*.json, written by
// tools/validation/), recomputes this code's side with src/validation/compute.js (the functions test/validation.test.mjs
// asserts on) and fills in every number, chart and table. Layout of a comparison: one sentence, the number to remember,
// one chart; everything else is in collapsed blocks that are built when first opened.
//
//   sections.js  the four live comparisons            topics.js  the declarative list behind section 5
//   refs.js      bibliography and software table      plot.js    canvas charts          ui.js  helpers

import * as C from './compute.js';
import { themeFrom } from './plot.js';
import { $, esc, e1, int, pill, table, details, cite, code, ext, L, ppm, vdata } from './ui.js';
import { vid } from './anchors.js';
import { reveal } from '../methods/tabs.js';
import { REFS, CODES, issuesUrl } from './refs.js';
import { TOPICS } from './topics.js';
import { SECTIONS as METHOD_SECTIONS } from '../methods/content.js';
import { bibtexFor } from '../core/methodsText.js';
import { transitBlock, orbitBlock, rvBlock, fitsBlock } from './sections.js';
import { projectBlock } from './project.js';

const TOL = C.TOL;
const body = (id) => document.querySelector(`#${vid(id)} .vbody`);

/** Shared state of one page load: the stored JSON, the checks made, and what each section found. */
const ctx = {
  TH: null, data: {}, checks: [], glance: [], found: {},
  check(sec, name, ok, detail, live = true) { this.checks.push({ sec, name, ok: !!ok, detail, live }); return !!ok; },
  /** A repository path: a link to its mirrored copy under public/validation/scripts/ when there is one. */
  path(p) { return (this.data.P?.scripts || []).includes(p) ? `<a class="path" href="${vdata('scripts/' + p)}">${esc(p)}</a>` : `<code>${esc(p)}</code>`; },
  /** Version of a code as recorded when the references were generated. */
  version(k) { const c = CODES[k], v = c.fixed || this.versions[c.v]; return v ? String(v).replace(new RegExp('^' + c.name + ' ', 'i'), '') : ''; },
  versions: {},
};

// =====================================================================================================================
// 1. the short version
// =====================================================================================================================
function summaryBlock() {
  const s = body('summary');
  const rows = ctx.glance.map((g) => [L(`<a href="#${vid(g.href)}">${g.q}</a>`), `<td class="l esl"><span class="gv">${g.value}</span> <span class="tick ${g.ok ? 'ok' : 'bad'}" title="${g.ok ? 'within' : 'outside'} its tolerance">${g.ok ? '✓' : '✗'}</span>${g.small ? `<small>${g.small}</small>` : ''}</td>`, L(g.practice), L(g.others)]);
  s.append(table(['Question', 'This code', 'What that means', 'Other codes, same test'], rows, 'left stack', '✓ = within its tolerance. Recomputed in your browser, except the last row.'));
}

function statusLine(t0) {
  const el = document.getElementById('status'), n = ctx.checks.length, okN = ctx.checks.filter((c) => c.ok).length, bad = ctx.checks.filter((c) => !c.ok);
  const live = ctx.checks.filter((c) => c.live).length;
  el.className = 'vstatus ' + (bad.length ? 'bad' : 'ok');
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><b>${okN} of ${n} checks within tolerance</b> · ${live} recomputed in your browser just now, ${n - live} from stored runs · <a href="#all-checks">list</a>`; el.title = `Recomputed in ${Math.round(performance.now() - t0)} ms`;
  const host = body('summary'); let d = document.getElementById('all-checks'); if (d) d.remove();
  d = details(host, `All ${n} checks and tolerances`, (b) => {
    b.append(table(['Check', 'Result', 'Numbers and tolerance', 'Source'], ctx.checks.map((c) => [L(`<a href="#${vid(c.sec)}">${esc(c.name)}</a>`), `<td>${pill(c.ok)}</td>`, L(esc(c.detail)), L(c.live ? 'this browser' : 'stored run')]), 'left stack'));
  }, { id: 'all-checks', open: bad.length > 0 });
}

// =====================================================================================================================
// 2 and 3. where this code is weaker, and where another code is the outlier
// =====================================================================================================================
const item = (title, text, links) => `<li><b>${title}</b> ${text} <span class="ev">${links.map(([t, h]) => `<a href="${h}"${h.startsWith('http') ? ' rel="noopener"' : ''}>${t}</a>`).join(' · ')}</span></li>`;

function weakerBlock() {
  const s = body('weaker'), f = ctx.found, { T, E, P } = ctx.data, items = [];
  const r0 = T.timing[0].rate, r1 = T.timing[1].rate, n0 = E.timing?.[T.timing[0].key], n1 = E.timing?.[T.timing[1].key], x = (a, b) => (a / b).toFixed(1);
  items.push(item('The dimming is accurate to 1e-10, not to rounding error.',
    `Worst light curve ${e1(f.transit.worst)}; worst single point, at second contact, ${e1(f.transit.branch)}. ${code('exoplanet-core')}’s closed form (${cite('agol2020')}) reaches ${e1(f.transit.ecWorst)}.`,
    [['cases', '#transit-cases'], ['branch points', '#transit-branch']]));
  items.push(item('It is slower than compiled codes.',
    `Quadratic limb darkening: ${code('batman')} is ${x(r0.batman, n0)} times and ${code('PyTransit')} ${x(r0.PyTransit, n0)} times faster. Four-coefficient law: PyTransit is ${x(r1.PyTransit, n1)} times faster; this code is ${x(n1, r1.batman)} times faster than batman.`,
    [['timings', '#transit-speed']]));
  const auto = f.transit.autoMax, nAuto = f.transit.autoN;
  items.push(item(auto > 1.5e-6 ? `Automatic exposure averaging leaves up to ${ppm(auto)}.` : `Exposure averaging: fixed, at a cost.`,
    auto > 1.5e-6 ? `The analyzer’s own choice of sub-sampling (${nAuto.join(', ')} per exposure in the three test cases) is not converged; setting the count by hand removes the error.`
      : `First measured here at 18 ppm. The rule was changed on 15 November 2026 and now leaves ${ppm(auto)}, using up to ${Math.max(...nAuto)} model evaluations per data point.`,
    [['convergence', '#transit-exposure']]));
  const fn = P?.tests?.['test/stress.test.mjs']?.checks.find((c) => c.name === 'g-funnel-4d'), fm = fn && /\(([-+−\d.]+), ([-+−\d.]+)σ\)/.exec(fn.more.join(' '));
  items.push(item('Funnel-shaped posteriors can bias the evidence low.',
    `On a four-parameter funnel ln Z came out ${fm ? Math.abs(Number(fm[1])).toFixed(2) : '0.3'} low (${fm ? Math.abs(Number(fm[2])).toFixed(1) : '1.7'}σ) after a restart with a warning; the project’s notes record 0.5 to 0.9 low on other seeds with no warning. One 20-parameter problem hits its budget, and says so.`,
    [['stress suite', '#val-sampler']]));
  const g8 = (P?.tests?.['test/nested.test.mjs']?.tail || []).map((l) => /^gauss d=8: lnZ=([-\d.]+)±([\d.]+) \(true ([-\d.]+)\)/.exec(l)).find(Boolean);
  if (g8 && Math.abs(g8[1] - g8[3]) > 1.5 * g8[2]) items.push(item('One Gaussian test came out high.',
    `An 8-parameter correlated Gaussian gave ln Z = ${g8[1]} ± ${g8[2]} against the exact ${g8[3]}: ${(g8[1] - g8[3]).toFixed(2)} high, ${((g8[1] - g8[3]) / g8[2]).toFixed(1)} times the quoted error. The 2- and 5-parameter cases of the same test are within their errors.`,
    [['stored output of test/nested.test.mjs', '#val-basics']]));
  items.push(item('Correlated noise and wrong models are untested.',
    'Error-bar sizes are verified only on data simulated by this code’s own model with white noise.',
    [['coverage', '#fits-coverage']]));
  items.push(item('One published number is not reproduced.',
    `HD 80606 b’s eclipse lasts ${f.orbit.e14.toFixed(4)} d here, ${f.orbit.e14pub} d in ${cite('pearson2022')}. The 30-digit orbit agrees with this code; the origin of the published value is unknown.`,
    [['durations', '#orbit-durations']]));
  s.append($('ul', 'vhonest weak', items.join('')));
}

function outlierBlock() {
  const s = body('outliers'), f = ctx.found, v = (k) => esc(ctx.version(k)), tr = (k) => ['tracker', issuesUrl(k)], items = [];
  items.push(item(`${code('batman')} ${v('batman')}: one point of the quadratic law.`,
    `With the planet’s centre exactly one planet radius from the star’s centre, the flux is too high by ${e1(f.out.zp[0])} to ${e1(f.out.zp[2])}; 1e-10 away the error is under ${e1(f.out.zpNear)}. Data will not land there; a model grid can.`,
    [['evidence', '#transit-branch'], tr('batman')]));
  items.push(item(`${code('radvel')} ${v('radvel')}: compiled Kepler solver at e = 0.999.`,
    `Just before periastron it reports “kepler step not converging” and ends the Python process. Its pure-Python solver handles the same input.`,
    [['evidence', '#orbit-kepler'], tr('radvel')]));
  items.push(item(`${code('ellc')} ${v('ellc')}: time zero is closest approach, not conjunction.`,
    `These differ by ${f.out.ellcMin.toFixed(1)} minutes for HD 80606 b, so a conjunction time from another code must be shifted first. A definition, not an error.`,
    [['evidence', '#orbit-midtransit'], tr('ellc')]));
  items.push(item(`${code('EXOTIC')} ${v('EXOTIC').split(',')[0]}: velocity scaling and derivative.`,
    `Velocities are scaled by M<sub>p</sub>/M★ instead of M<sub>p</sub>/(M★ + M<sub>p</sub>): ${(100 * f.out.exoticFactor).toFixed(2)}% too large for HD 80606 b. A one-sided numerical derivative leaves ${e1(f.out.exotic)} of K; a centred, finer one ${e1(f.out.exoticFine)}.`,
    [['evidence', '#rv-cases'], tr('EXOTIC')]));
  items.push(item(`${code('PyTransit')} ${v('PyTransit')}: Newton solver at e = 0.999.`,
    `It returns an angle wrong by ${e1(f.out.pytransit999)} rad without warning; up to e = 0.99 it is good to ${e1(f.out.pytransit99)}.`,
    [['evidence', '#orbit-kepler'], tr('PyTransit')]));
  s.append($('ul', 'vhonest other', items.join('')));
  s.append($('p', 'vnote', `None of these has been reported upstream by this project; a search of each tracker on 15 November 2026 found no existing report (related: PyTransit ${ext(CODES.PyTransit.repo + '/issues/162', 'issue 162')}, closed). These are edge cases, definitions and default settings; each code’s typical and worst error over all cases is in the <a href="#val-transit">chart of section 4.1</a>.`));
  details(s, 'Smaller differences found along the way', (b) => {
    const li = [
      `<b>${code('batman')}: exposure averaging.</b> Its sub-samples run from one edge of the exposure to the other with equal weights, so at the same count it is ${f.out.batmanExp} times further from the converged average than this code, PyTransit and pyaneti. The author has described this as intended behaviour (${ext(CODES.batman.repo + '/issues/18', 'issue 18')}, closed 2017); use a larger <code>supersample_factor</code>. <a href="#transit-exposure">evidence</a>`,
      `<b>batman: four-coefficient law.</b> Integrated numerically to a target of 1 ppm by default, which it meets (${e1(f.out.batmanNL)}); this is a setting, not a fault. <a href="#transit-cases">evidence</a>`,
      `<b>batman and ${code('pyaneti')}: Kepler solvers stop early.</b> Orbital angle off by ${e1(f.out.batman93)} rad at e = 0.93 (pyaneti: ${e1(f.out.pyaneti93)}), which appears as 1e-8 in a light curve and 1e-6 of K in a velocity curve. Neither matters at today’s measurement precision. <a href="#orbit-kepler">evidence</a>`,
      `<b>pyaneti: periastron time.</b> Off by ${e1(f.out.pyanetiPeri)} s, consistent with a constant π written without a double-precision suffix. <a href="#orbit-events">evidence</a>`,
      `<b>${code('PyAstronomy')}: the four-coefficient routine.</b> ${e1(f.out.pyaNL)} at worst, and for a radius ratio of 0.01 it ended the Python process (${esc(f.out.pyaCrash)}). Its quadratic routine (${cite('mandel2002')}) is good to ${e1(f.out.pyaQuad)}. <a href="#transit-cases">evidence</a>`,
      `<b>PyTransit: very close-in or very eccentric orbits.</b> ${e1(f.out.pytA)} at a/R★ = 2.5 and ${e1(f.out.pytE)} at e = 0.93, ω = 120°, against 1e-8 to 1e-7 elsewhere. <a href="#transit-cases">evidence</a>`,
      `<b>${code('pylightcurve')}: eclipse duration at e = 0.93.</b> <code>eclipse_duration</code> returns ${f.out.plcE14} d for HD 80606 b (its root finder fails). <a href="#orbit-durations">evidence</a>`,
      `<b>Closed-form durations</b> (${cite('winn2010')}, eqs. 14 to 16; also PyTransit’s duration function and this code’s internal estimate) are up to ${f.out.winnShort.toFixed(0)} s short at e = 0.93; the analyzer reports root-found durations instead. <a href="#orbit-durations">evidence</a>`,
      `<b>radvel: a different, already fixed problem.</b> The convergence test of its pure-Python Kepler solver was repaired upstream in February 2026 (${ext(CODES.radvel.repo + '/pull/403', 'pull request 403')}); that is not the compiled-solver exit described above.`,
    ];
    b.append($('ul', 'vlist', li.map((x) => `<li>${x}</li>`).join('')));
  }, { id: 'outliers-more' });
}

// =====================================================================================================================
// 6 and 7. reproducing it (shown in the Reproducibility tab) and limits; the references are the page's one bibliography
// =====================================================================================================================
function reproduceBlock() {
  const s = body('reproduce'), { T, E, P } = ctx.data, p = (x) => ctx.path(x);
  s.append($('pre', 'vcmd', `npm install
node test/validation.test.mjs      # every tolerance and claim on this page, about 20 s
npm test                           # all numerical tests of the project, about 6 min`));
  s.append($('p', '', `That needs only Node. Regenerating the other codes’ answers needs them installed (recipe: ${p('validation/README.md')}). Each script writes the exact inputs and every code’s output to one file:`));
  const size = (n) => (P?.sizes?.[n] ? `${Math.round(P.sizes[n] / 1024)} kB` : '');
  const gen = [
    ['Transit light curves', 'tools/validation/make_transit.py', 'transit.json', '#val-transit'],
    ['Orbit and timing', 'tools/validation/make_orbit.py', 'orbit.json', '#val-orbit'],
    ['Radial velocities', 'tools/validation/make_rv.py', 'rv.json', '#val-rv'],
    ['Other samplers’ fits', 'tools/validation/make_fits.py', 'fits.json', '#val-fits'],
    ['This code’s stored fits and coverage trials', 'tools/validation/esl_reference.mjs', 'esl.json', '#val-fits'],
    ['The project’s other tests', 'tools/validation/project_reference.mjs', 'project.json', '#val-project'],
  ];
  s.append(table(['Comparison', 'Generator script', 'Inputs and outputs'], gen.map((g) => [L(`<a href="${g[3]}">${g[0]}</a>`), L(p(g[1])), L(`<a href="${vdata(g[2])}" download>${g[2]}</a> <span class="vnote">${size(g[2])}</span>`)]), 'left stack'));
  details(s, `The ${Object.keys(CODES).length} codes: versions, repositories, citations, trackers`, (b) => {
    const row = (k) => { const c = CODES[k], v = ctx.version(k); return [L(`<a class="ext" href="${c.repo}" rel="noopener">${esc(c.name)}</a>${c.docs ? ` · <a href="${c.docs}" rel="noopener">docs</a>` : ''}`), L(esc(v || '—') + (c.vnote ? ` <span class="vnote">${esc(c.vnote)}</span>` : '')), L(esc(c.used)), L(cite(...c.cite)), L(k === 'swarthmore' ? '—' : `<a href="${issuesUrl(k)}" rel="noopener">issues</a>`)]; };
    const keys = Object.keys(CODES);
    b.append(table(['Code', 'Version used', 'Used here for', 'Cite', 'Tracker'], [
      { raw: '<tr class="grp"><td colspan="5">Compared with this code</td></tr>' }, ...keys.filter((k) => !CODES[k].reference && !CODES[k].elsewhere).map(row),
      { raw: '<tr class="grp"><td colspan="5">The reference</td></tr>' }, ...keys.filter((k) => CODES[k].reference).map(row),
      { raw: '<tr class="grp"><td colspan="5">Used by the project’s other tests (section 5)</td></tr>' }, ...keys.filter((k) => CODES[k].elsewhere).map(row),
    ], 'left stack', `Python ${esc(T.python)}, numpy ${esc(T.versions.numpy)}, ${esc(T.machine)}; versions as recorded in the stored files when the references were generated (${esc(T.date)}). This code ran in Node ${esc(E.node)} on ${esc(E.machine)}.`));
  }, { id: 'codes', open: false });
  details(s, 'Regenerating the references', (b) => {
    b.append($('pre', 'vcmd', `for s in transit orbit rv fits; do .venv-validation/bin/python tools/validation/make_$s.py; done    # about 15 min
node tools/validation/esl_reference.mjs          # about 8 min
node tools/validation/project_reference.mjs      # about 4 min
node test/validation.test.mjs`));
    b.append($('p', '', `Shared pieces: ${p('tools/validation/common.py')} (the 30-digit orbit and the quadrature), ${p('tools/validation/codes.py')} (one adapter per code, so every code gets the same inputs), ${p('tools/validation/ext_pyaneti.py')} and ${p('tools/validation/ext_exotic.py')} (codes that need their own Python environment), ${p('tools/validation/ext_isolated.py')} (runs an adapter in its own process, because two compiled kernels can end the interpreter). This code’s side is ${p('src/validation/compute.js')}, whose <code>TOL</code> table holds every tolerance; the assertions are ${p('test/validation.test.mjs')}.`));
  }, { id: 'regenerate' });
}

function limitsBlock() {
  const s = body('limits');
  const li = [
    '<b>Real data.</b> Sampler comparisons use simulated data. Agreement with published analyses rests on EXOTIC’s examples and HD 80606 b, and for that planet two things are not reproduced: the published eclipse duration (section 2), and the radius ratio from the bundled TESS light curve, which is diluted by HD 80607 and is not corrected.',
    '<b>Noise.</b> The likelihood assumes independent Gaussian errors of the stated size. Error-bar sizes were verified only on data simulated that way.',
    '<b>Physics not modelled</b> in the transit, orbit and velocity models: light-travel time (applied only to a planet’s own light, as an option), stellar oblateness and gravity darkening, spots, light from other stars in the aperture.',
    `<b>Codes not run:</b> ${ext('https://starry.readthedocs.io/', 'starry')} would not import (its algorithm is the one in exoplanet-core, which is compared); juliet wraps batman, radvel and dynesty.`,
    '<b>Other settings and machines.</b> The other codes ran at their defaults, on one computer; timings are good to a factor of 1.5.',
  ];
  s.append($('ul', 'vlist', li.map((x) => `<li>${x}</li>`).join('')));
}

// =====================================================================================================================
function readingTime() {
  // words a reader meets without expanding anything, references excluded (nobody reads a bibliography in order)
  // the Validation tab only (innerText of a hidden tab is its textContent, close enough for a word count)
  const main = document.getElementById('validation');
  const words = (el) => ((el && (el.innerText || el.textContent)) || '').split(/\s+/).filter(Boolean).length;
  const n = words(main) - words(document.getElementById('vtoc')) - [...main.querySelectorAll('.vlegend')].reduce((a, e) => a + words(e), 0), figs = main.querySelectorAll('.vchart').length;
  const min = n / 230 + (figs * 12) / 60;
  const el = document.getElementById('readtime'); el.textContent = `About ${Math.round(min)} minutes to read; details open on request.`; el.title = `${int(n)} words at 230 a minute plus ${figs} figures at 12 s each, with nothing expanded and the reference list left out`;
  return { words: n, figs, min };
}

/** The anchor of the address, now that the collapsed blocks exist: its tab shown, the blocks around it opened. */
const openTarget = () => { if (location.hash) reveal(decodeURIComponent(location.hash.slice(1))); };

async function main() {
  const t0 = performance.now(); ctx.TH = themeFrom(document.getElementById('val'));
  const get = async (n, optional) => { const r = await fetch(vdata(n + '.json')); if (!r.ok) { if (optional) return null; throw new Error(`${n}.json: HTTP ${r.status}`); } const txt = await r.text(); const j = JSON.parse(txt); (ctx.sizes ||= {})[n + '.json'] = txt.length; return j; };
  let T, O, V, F, E, P;
  try { [T, O, V, F, E, P] = await Promise.all([get('transit'), get('orbit'), get('rv'), get('fits'), get('esl'), get('project', true)]); }
  catch (err) { document.getElementById('status').innerHTML = `Could not load the stored reference values (${esc(err.message)}). They are generated by <code>tools/validation/</code> into <code>public/validation/</code>.`; return; }
  ctx.data = { T, O, V, F, E, P: P ? { ...P, sizes: ctx.sizes } : { tests: {}, plots: {}, scripts: [], sizes: ctx.sizes } };
  ctx.versions = { ...T.versions, ...O.versions, ...V.versions, ...F.versions };
  transitBlock(ctx); orbitBlock(ctx); rvBlock(ctx); const fits = fitsBlock(ctx, () => statusLine(t0));
  await projectBlock(ctx);
  summaryBlock(); weakerBlock(); outlierBlock(); reproduceBlock(); limitsBlock();
  statusLine(t0); void fits; void TOL; void TOPICS;
  document.documentElement.dataset.validation = 'ready';
  window.__validation = { checks: ctx.checks, reading: readingTime() };
  openTarget();   // later changes of the anchor are handled by src/methods/tabs.js
}
main().catch((err) => { console.error(err); const el = document.getElementById('status'); if (el) { el.className = 'vstatus bad'; el.innerHTML = `This page failed while computing: ${esc(err.message)}`; } });

// ---- window.__esl.validation: what the site's assistant reads (the contract is at the top of src/assistant/pages.js)
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const STOP = new Set('the how well does do model models code codes other others agree agreement with and what say says page about against compare compared comparison is are of to in this it its numbers number quote validation validated check checks'.split(' '));
  const words = (q) => String(q || '').toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 1 && !STOP.has(w)), plain = (s) => String(s || '').replace(/<[^>]+>/g, '');
  const done = () => TOPICS.filter((t) => t.status === 'done'), SECTIONS = { transit: 'Transit light curves', orbit: 'Orbits and event times', rv: 'Radial velocities', fits: 'Fits against other samplers' };
  const refOf = (k) => { const r = REFS[k]; return r ? `${r.short}${r.where ? ', ' + r.where : ''}${r.doi ? ', doi:' + r.doi : r.arxiv ? ', arXiv:' + r.arxiv : ''}` : k; };
  const topicOut = (t) => ({ topic: t.id, title: t.title, purpose: t.purpose, headline: `${t.headline.value}: ${t.headline.label}`, checks: t.rows.map((r) => ({ what: r.what, result: r.result, as_the_test_printed: r.quote || '' })),
    compared_with: (t.against || []).map((k) => (CODES[k] ? `${CODES[k].name}${ctx.version(k) ? ' ' + ctx.version(k) : ''}` : k)), references: (t.refs || []).map(refOf), test: (t.tests || []).join(', '), caveat: t.caveat || undefined, on_the_page: '#' + vid(t.id) });
  const score = (text, ws) => ws.filter((w) => text.includes(w)).length;
  const tools = [
    { name: 'validation_find', core: true, readOnly: true, description: 'Find what the Validation page says about a subject (for example "limb darkening", "sampler", "HD 80606", "Kepler equation", "EXOTIC"): the matching comparisons with their numbers exactly as the tests printed them, the codes compared with and the references. Without a query, lists the topics. Quote the numbers as returned, with their reference.',
      parameters: obj({ query: T('Subject to look for; omit to list every topic.'), limit: { type: 'integer', description: 'How many topics to return in full (default 2).', minimum: 1, maximum: 5 } }),
      run({ query, limit = 2 }) {
        const ws = words(query), live = ctx.checks.filter((c) => c.live !== false);
        if (!ws.length) return { topics: done().map((t) => ({ topic: t.id, title: t.title, headline: `${t.headline.value}: ${t.headline.label}` })), live_sections: Object.entries(SECTIONS).map(([id, title]) => ({ section: id, title, checks: live.filter((c) => c.sec === id).length, all_pass: live.filter((c) => c.sec === id).every((c) => c.ok) })) };
        const ranked = done().map((t) => ({ t, ts: score(`${t.id} ${t.title}`.toLowerCase(), ws), s: 3 * score(`${t.id} ${t.title}`.toLowerCase(), ws) + score(`${t.purpose} ${t.rows.map((r) => r.what + ' ' + r.result).join(' ')} ${(t.against || []).join(' ')}`.toLowerCase(), ws) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
        // the four live comparisons: a word of the section's own title counts as much as a word of a topic's title
        const scored = live.map((c) => ({ c, ts: score(`${c.sec} ${SECTIONS[c.sec] || ''}`.toLowerCase(), ws), s: 3 * score(`${c.sec} ${SECTIONS[c.sec] || ''}`.toLowerCase(), ws) + score(`${c.name} ${plain(c.detail)}`.toLowerCase(), ws) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
        const versions = (sec) => { const D = { transit: ctx.data.T, orbit: ctx.data.O, rv: ctx.data.V, fits: ctx.data.F }[sec]; return D && D.versions ? Object.entries(D.versions).map(([k, v]) => `${k} ${String(v).replace(new RegExp('^' + k + ' ', 'i'), '')}`) : []; };
        const checks = scored.slice(0, 6).map(({ c }) => ({ section: SECTIONS[c.sec] || c.sec, check: plain(c.name), passed: c.ok, numbers: plain(c.detail), reference_environment: versions(c.sec), computed: 'this code\'s side, in this browser on this page load', on_the_page: '#' + vid(c.sec) }));
        if (checks.length && (!ranked.length || scored[0].ts >= Math.max(...ranked.map((x) => x.ts)))) return { found: ranked.length + checks.length, live_checks: checks, note: 'These are the page\'s live comparisons for this subject; the topics below only mention it.', topics: ranked.slice(0, 1).map((x) => topicOut(x.t)), other_topics: ranked.slice(1).map((x) => `${x.t.id}: ${x.t.title}`) };
        if (!ranked.length && !checks.length) return { found: 0, note: `Nothing on the Validation page matches "${query}".`, topics: done().map((t) => `${t.id}: ${t.title}`) };
        return { found: ranked.length + checks.length, topics: ranked.slice(0, limit).map((x) => topicOut(x.t)), other_topics: ranked.slice(limit).map((x) => `${x.t.id}: ${x.t.title}`), live_checks: checks.length ? checks : undefined };
      } },
    { name: 'validation_open', readOnly: true, description: 'Scroll the Validation page to a topic or section and open it, so the user sees the chart and the table behind the numbers.',
      parameters: obj({ topic: T('Topic id from validation_find, or a section: transit, orbit, rv, fits.') }, ['topic']),
      run({ topic }) { const id = vid(String(topic).replace(/^#?(val-)?/, '')); if (!document.getElementById(id)) throw new Error(`there is no "${id}" on this page: validation_find lists the topics`); if (decodeURIComponent(location.hash.slice(1)) === id) openTarget(); else location.hash = id; return { opened: id }; } },
    // the Methods tab: what each technique computes and how, in the page's own words, and the BibTeX to cite it
    { name: 'methods_find', core: true, readOnly: true, description: 'Find how a technique is done and justified on the Methods page (for example "limb darkening", "nested sampling", "jitter", "Rossiter-McLaughlin", "aperture photometry", "focus", "time standards"): the method in the page\'s words with its equations as text, the checks of its accuracy, its known limits, the source files and the references. Use it to explain or justify a choice, or to write a methods section.',
      parameters: obj({ query: T('Subject to look for; omit to list every section.'), limit: { type: 'integer', description: 'Sections returned in full (default 1).', minimum: 1, maximum: 3 } }),
      run({ query, limit = 1 }) {
        const flat = (x) => (typeof x === 'string' ? x : x && x.ul ? x.ul.map((u) => '- ' + flat(u)).join('\n') : x && x.h ? `${x.h}:` : x && x.eq ? `[equation] ${x.eq}` : x && x.topic ? '' : '');
        const clean = (t) => plain(String(t)).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\{\{([^}]+)\}\}/g, '($1)').replace(/\s+\n/g, '\n').trim();
        const secText = (m) => clean((m.body || []).map(flat).filter(Boolean).join('\n'));
        if (!words(query).length) return { sections: METHOD_SECTIONS.map((m) => ({ section: m.id, title: m.title })) };
        const ws = words(query), ranked = METHOD_SECTIONS.map((m) => ({ m, s: 4 * score(`${m.id} ${m.title}`.toLowerCase(), ws) + score(secText(m).toLowerCase(), ws) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
        if (!ranked.length) return { found: 0, note: `No Methods section matches "${query}".`, sections: METHOD_SECTIONS.map((m) => `${m.id}: ${m.title}`) };
        return { found: ranked.length, sections: ranked.slice(0, limit).map(({ m }) => ({ section: m.id, title: m.title, method: secText(m).slice(0, 3500), checks: (m.checks || []).filter((c) => typeof c === 'string').map(clean), limits: (m.limits || []).map(clean), code: m.code || [], references: (m.refs || []).map(refOf), cite_keys: m.refs || [], on_the_page: '#' + m.id })),
          other_sections: ranked.slice(limit, limit + 6).map((x) => `${x.m.id}: ${x.m.title}`), next: 'methods_cite gives the BibTeX of the references.' };
      } },
    { name: 'methods_cite', readOnly: true, description: 'BibTeX for references of the Methods page: by citation key, or every reference of one Methods section, with the software\'s own entry first. Writes a .bib file into the conversation\'s files when a name is given.',
      parameters: obj({ keys: { type: 'array', items: T('citation key'), description: 'Citation keys (from methods_find).' }, section: T('A Methods section id: all its references.'), file: T('File name to write, e.g. references.bib.') }),
      async run({ keys, section, file }, ctx2 = {}) {
        let ks = [...(keys || [])];
        if (section) { const m = METHOD_SECTIONS.find((x) => x.id === section); if (!m) throw new Error(`no Methods section "${section}"; methods_find lists them`); ks.push(...(m.refs || [])); }
        const bad = ks.filter((k) => !REFS[k]); if (bad.length) throw new Error(`unknown citation keys: ${bad.join(', ')}`);
        if (!ks.length) throw new Error('give keys or a section');
        const bib = bibtexFor(['esl', ...ks]);
        if (file && ctx2.files && ctx2.files.write) { const w = await ctx2.files.write(file, bib, 'application/x-bibtex'); return { written: w.name, entries: ks.length + 1 }; }
        return { entries: ks.length + 1, bibtex: bib.length > 5000 ? bib.slice(0, 5000) + '\n…' : bib };
      } },
  ];
  (window.__esl = window.__esl || {}).validation = { tools, ready: () => document.documentElement.dataset.validation === 'ready',
    state: () => [`Methods page: ${METHOD_SECTIONS.length} method sections (methods_find, methods_cite). Validation: ${done().length} topics (${done().map((t) => t.id).join(', ')}) and four live comparisons (transit, orbit, rv, fits); ${ctx.checks.filter((c) => c.ok).length} of ${ctx.checks.length} checks pass on this load.`] };
}
