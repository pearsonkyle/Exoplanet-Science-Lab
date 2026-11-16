// The Validation page. The narrative skeleton (headings, table of contents, the sentences without numbers) is in
// validation/index.html; this module loads the stored reference values (public/validation/*.json, written by
// tools/validation/), recomputes this code's side with src/validation/compute.js (the functions test/validation.test.mjs
// asserts on) and fills in every number, chart and table. Layout of a comparison: one sentence, the number to remember,
// one chart; everything else is in collapsed blocks that are built when first opened.
//
//   sections.js  the four live comparisons            topics.js  the declarative list behind section 5
//   refs.js      bibliography and software table      plot.js    canvas charts          ui.js  helpers

import * as C from './compute.js';
import { themeFrom } from './plot.js';
import { $, esc, e1, int, pill, table, details, cite, code, ext, refEntry, L, ppm } from './ui.js';
import { REFS, CODES, issuesUrl } from './refs.js';
import { TOPICS } from './topics.js';
import { transitBlock, orbitBlock, rvBlock, fitsBlock } from './sections.js';
import { projectBlock } from './project.js';

const TOL = C.TOL;
const body = (id) => document.querySelector(`#${id} .vbody`);

/** Shared state of one page load: the stored JSON, the checks made, and what each section found. */
const ctx = {
  TH: null, data: {}, checks: [], glance: [], found: {},
  check(sec, name, ok, detail, live = true) { this.checks.push({ sec, name, ok: !!ok, detail, live }); return !!ok; },
  /** A repository path: a link to its mirrored copy under public/validation/scripts/ when there is one. */
  path(p) { return (this.data.P?.scripts || []).includes(p) ? `<a class="path" href="scripts/${p}">${esc(p)}</a>` : `<code>${esc(p)}</code>`; },
  /** Version of a code as recorded when the references were generated. */
  version(k) { const c = CODES[k], v = c.fixed || this.versions[c.v]; return v ? String(v).replace(new RegExp('^' + c.name + ' ', 'i'), '') : ''; },
  versions: {},
};

// =====================================================================================================================
// 1. the short version
// =====================================================================================================================
function summaryBlock() {
  const s = body('summary');
  const rows = ctx.glance.map((g) => [L(`<a href="#${g.href}">${g.q}</a>`), `<td class="l esl"><span class="gv">${g.value}</span> <span class="tick ${g.ok ? 'ok' : 'bad'}" title="${g.ok ? 'within' : 'outside'} its tolerance">${g.ok ? '✓' : '✗'}</span>${g.small ? `<small>${g.small}</small>` : ''}</td>`, L(g.practice), L(g.others)]);
  s.append(table(['Question', 'This code', 'What that means', 'Other codes, same test'], rows, 'left stack', '✓ = within its tolerance. Recomputed in your browser, except the last row.'));
}

function statusLine(t0) {
  const el = document.getElementById('status'), n = ctx.checks.length, okN = ctx.checks.filter((c) => c.ok).length, bad = ctx.checks.filter((c) => !c.ok);
  const live = ctx.checks.filter((c) => c.live).length;
  el.className = 'vstatus ' + (bad.length ? 'bad' : 'ok');
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><b>${okN} of ${n} checks within tolerance</b> · ${live} recomputed in your browser just now, ${n - live} from stored runs · <a href="#all-checks">list</a>`; el.title = `Recomputed in ${Math.round(performance.now() - t0)} ms`;
  const host = body('summary'); let d = document.getElementById('all-checks'); if (d) d.remove();
  d = details(host, `All ${n} checks and tolerances`, (b) => {
    b.append(table(['Check', 'Result', 'Numbers and tolerance', 'Source'], ctx.checks.map((c) => [L(`<a href="#${c.sec}">${esc(c.name)}</a>`), `<td>${pill(c.ok)}</td>`, L(esc(c.detail)), L(c.live ? 'this browser' : 'stored run')]), 'left stack'));
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
    [['stress suite', '#sampler']]));
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
  s.append($('p', 'vnote', `None of these has been reported upstream by this project; a search of each tracker on 15 November 2026 found no existing report (related: PyTransit ${ext(CODES.PyTransit.repo + '/issues/162', 'issue 162')}, closed). In ordinary use all these codes are good to a part per million.`));
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
// 6 to 8. reproducing it, limits, references
// =====================================================================================================================
function reproduceBlock() {
  const s = body('reproduce'), { T, E, P } = ctx.data, p = (x) => ctx.path(x);
  s.append($('pre', 'vcmd', `npm install
node test/validation.test.mjs      # every tolerance and claim on this page, about 20 s
npm test                           # all numerical tests of the project, about 6 min`));
  s.append($('p', '', `That needs only Node. Regenerating the other codes’ answers needs them installed (recipe: ${p('validation/README.md')}). Each script writes the exact inputs and every code’s output to one file:`));
  const size = (n) => (P?.sizes?.[n] ? `${Math.round(P.sizes[n] / 1024)} kB` : '');
  const gen = [
    ['Transit light curves', 'tools/validation/make_transit.py', 'transit.json', '#transit'],
    ['Orbit and timing', 'tools/validation/make_orbit.py', 'orbit.json', '#orbit'],
    ['Radial velocities', 'tools/validation/make_rv.py', 'rv.json', '#rv'],
    ['Other samplers’ fits', 'tools/validation/make_fits.py', 'fits.json', '#fits'],
    ['This code’s stored fits and coverage trials', 'tools/validation/esl_reference.mjs', 'esl.json', '#fits'],
    ['The project’s other tests', 'tools/validation/project_reference.mjs', 'project.json', '#project'],
  ];
  s.append(table(['Comparison', 'Generator script', 'Inputs and outputs'], gen.map((g) => [L(`<a href="${g[3]}">${g[0]}</a>`), L(p(g[1])), L(`<a href="${g[2]}" download>${g[2]}</a> <span class="vnote">${size(g[2])}</span>`)]), 'left stack'));
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
    '<b>Real data.</b> Sampler comparisons use simulated data; agreement with published analyses rests on EXOTIC’s examples and HD 80606 b.',
    '<b>Physics not modelled:</b> light-travel time, stellar oblateness, spots.',
    `<b>Codes not run:</b> ${ext('https://starry.readthedocs.io/', 'starry')} would not import (its algorithm is the one in exoplanet-core, which is compared); juliet wraps batman, radvel and dynesty.`,
    '<b>Other settings and machines.</b> The other codes ran at their defaults, on one computer; timings are good to a factor of 1.5.',
  ];
  s.append($('ul', 'vlist', li.map((x) => `<li>${x}</li>`).join('')));
}

function referencesBlock() {
  const s = body('references'), keys = Object.keys(REFS).sort((a, b) => REFS[a].authors.localeCompare(REFS[b].authors) || REFS[a].year - REFS[b].year);
  s.append($('ol', 'vrefs', keys.map(refEntry).join('')));
}

// =====================================================================================================================
function readingTime() {
  // words a reader meets without expanding anything, references excluded (nobody reads a bibliography in order)
  const main = document.getElementById('val'), skip = document.getElementById('references');
  const words = (el) => (el.innerText || '').split(/\s+/).filter(Boolean).length;
  const n = words(main) - words(skip) - words(document.getElementById('toc')) - [...main.querySelectorAll('.vlegend')].reduce((a, e) => a + words(e), 0), figs = [...main.querySelectorAll('.vchart')].filter((f) => f.offsetParent !== null).length;
  const min = n / 230 + (figs * 12) / 60;
  const el = document.getElementById('readtime'); el.textContent = `About ${Math.round(min)} minutes to read; details open on request.`; el.title = `${int(n)} words at 230 a minute plus ${figs} figures at 12 s each, with nothing expanded and the reference list left out`;
  return { words: n, figs, min };
}

/** Links into a collapsed block open it first. */
function openTarget() {
  const id = decodeURIComponent(location.hash.slice(1)); if (!id) return;
  const t = document.getElementById(id); if (!t) return;
  for (let d = t.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
  if (t.tagName === 'DETAILS') t.open = true;
  requestAnimationFrame(() => t.scrollIntoView({ block: 'start' }));
}

async function main() {
  const t0 = performance.now(); ctx.TH = themeFrom(document.getElementById('val'));
  const get = async (n, optional) => { const r = await fetch(new URL(n + '.json', document.baseURI)); if (!r.ok) { if (optional) return null; throw new Error(`${n}.json: HTTP ${r.status}`); } const txt = await r.text(); const j = JSON.parse(txt); (ctx.sizes ||= {})[n + '.json'] = txt.length; return j; };
  let T, O, V, F, E, P;
  try { [T, O, V, F, E, P] = await Promise.all([get('transit'), get('orbit'), get('rv'), get('fits'), get('esl'), get('project', true)]); }
  catch (err) { document.getElementById('status').innerHTML = `Could not load the stored reference values (${esc(err.message)}). They are generated by <code>tools/validation/</code> into <code>public/validation/</code>.`; return; }
  ctx.data = { T, O, V, F, E, P: P ? { ...P, sizes: ctx.sizes } : { tests: {}, plots: {}, scripts: [], sizes: ctx.sizes } };
  ctx.versions = { ...T.versions, ...O.versions, ...V.versions, ...F.versions };
  transitBlock(ctx); orbitBlock(ctx); rvBlock(ctx); const fits = fitsBlock(ctx, () => statusLine(t0));
  await projectBlock(ctx);
  summaryBlock(); weakerBlock(); outlierBlock(); reproduceBlock(); limitsBlock(); referencesBlock();
  statusLine(t0); void fits; void TOL; void TOPICS;
  document.documentElement.dataset.validation = 'ready';
  window.__validation = { checks: ctx.checks, reading: readingTime() };
  window.addEventListener('hashchange', openTarget); openTarget();
}
main().catch((err) => { console.error(err); const el = document.getElementById('status'); if (el) { el.className = 'vstatus bad'; el.innerHTML = `This page failed while computing: ${esc(err.message)}`; } });
