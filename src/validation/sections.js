// The four live comparisons of the Validation tab (section 4). Each block fills `#val-<id> .vbody` with: the number to
// remember, one chart, and collapsed blocks (built on first opening) holding every case, the inputs and how it was run.
// Each also records its checks (ctx.check), a row of the summary table (ctx.glance) and the facts the two honesty
// lists quote (ctx.found), so no number is typed twice.

import * as C from './compute.js';
import { chart, rangesHeight } from './plot.js';
import { $, esc, e1, se1, fx, sig, int, signed, ppm, median, pill, heat, table, details, keyNumber, cite, code, L, N, vdata } from './ui.js';
import { vid } from './anchors.js';
import { CODES } from './refs.js';

const TOL = C.TOL;
const body = (id) => document.querySelector(`#${vid(id)} .vbody`);
const FAMILY = { batman: 0, PyTransit: 1, ellc: 2, radvel: 2, PyAstronomy: 3, pylightcurve: 4, Winn: 4, 'exoplanet-core': 5, pyaneti: 6, EXOTIC: 7, dynesty: 0, emcee: 1, UltraNest: 6, analytic: 3 };
const family = (name) => Object.keys(FAMILY).find((k) => name.startsWith(k));
const colors = (TH) => ({ of: (name) => (name === 'ESL' || name === 'this code' ? TH.esl : name === 'truth' ? TH.truth : TH.s[FAMILY[family(name)] ?? 7]), dash: (name) => (/\(/.test(name) && !/kernel|\(C\)|Markley|Newton/.test(name) ? [5, 4] : null) });
const ME = 'this code';

/** "How this was run": script, stored file, command, environment, and the code versions with links. */
function howRun(ctx, parent, { script, json, codes, extra = '', mine }) {
  const { T } = ctx.data;
  details(parent, 'How it was run', (b) => {
    b.append($('ul', 'vlist', [
      `Reference generator: ${ctx.path(script)} (Python ${esc(T.python)}, ${esc(T.machine)}, ${esc(T.date)}). It hands every code the same inputs through ${ctx.path('tools/validation/codes.py')} and stores each code’s output minus the reference.`,
      `Stored inputs and outputs: <a href="${vdata(json)}" download>${json}</a>${ctx.data.P.sizes?.[json] ? ` (${Math.round(ctx.data.P.sizes[json] / 1024)} kB)` : ''}.`,
      `This code’s side: ${mine} in ${ctx.path('src/validation/compute.js')}, run in your browser on page load and by ${ctx.path('test/validation.test.mjs')}.`,
      `Versions: ${codes.map((k) => `${code(k)} ${esc(ctx.version(k))}`).join(', ')}.`,
      extra,
    ].filter(Boolean).map((x) => `<li>${x}</li>`).join('')));
    b.append($('pre', 'vcmd', `.venv-validation/bin/python ${script}     # regenerate the reference (environment: validation/README.md)\nnode test/validation.test.mjs                         # recompute this code's side and assert the tolerances`));
  });
}
const inputs = (parent, title, head, rows, json) => details(parent, title, (b) => { b.append(table(head, rows)); b.append($('p', 'vnote', `Exactly these numbers are handed to every code. Download: <a href="${vdata(json)}" download>${json}</a>.`)); });

// =====================================================================================================================
// 4.1 transit light curves
// =====================================================================================================================
export function transitBlock(ctx) {
  const s = body('transit'), { T, E } = ctx.data, col = colors(ctx.TH);
  const all = C.transitAll(T), names = T.codeNames.filter((n) => T.cases.some((c) => c.stats[n]));
  const worst = all.reduce((a, b) => (b.esl.max > a.esl.max ? b : a)), med = median(all.map((a) => a.esl.max));
  const okT = ctx.check('transit', `Transit light curves match the reference in all ${all.length} cases`, worst.esl.max < TOL.transit, `worst ${e1(worst.esl.max)} (${worst.c.label}); tolerance ${e1(TOL.transit)} in relative flux`);
  const sp = C.specialPoints(T), spW = sp.reduce((a, b) => (Math.abs(b.esl) > Math.abs(a.esl) ? b : a));
  ctx.check('transit', 'Flux at the kernel’s branch points (contacts, centre, planet centre on its own limb radius)', Math.abs(spW.esl) < TOL.special, `worst ${e1(spW.esl)} at ${spW.label}, Rp/R★ = ${spW.p}; tolerance ${e1(TOL.special)}`);
  const ex = T.exposure.map((e) => ({ e, r: C.exposureCase(e) })), n101 = (x) => x.r.byN.find((q) => q.ns === 101).max;
  for (const x of ex) ctx.check('transit', `Exposure averaging: ${x.e.label}`, n101(x) < TOL.exposure101 && x.r.autoRun.max < TOL.exposureAuto, `automatic choice (${x.r.auto} sub-samples): ${e1(x.r.autoRun.max)}, tolerance ${e1(TOL.exposureAuto)}; 101 sub-samples: ${e1(n101(x))}, tolerance ${e1(TOL.exposure101)}`);
  const autoMax = Math.max(...ex.map((x) => x.r.autoRun.max));
  const stat = (n) => { const cs = T.cases.filter((c) => c.stats[n] && c.depth > 0); return { n: cs.length, max: Math.max(...cs.map((c) => c.stats[n].max)), med: median(cs.map((c) => c.stats[n].max)), at: cs.reduce((a, b) => (b.stats[n].max > a.stats[n].max ? b : a)).label }; };
  const st = Object.fromEntries(names.map((n) => [n, stat(n)])), own = ['batman', 'PyTransit', 'pylightcurve', 'EXOTIC', 'pyaneti', 'ellc', 'PyAstronomy'].filter((n) => st[n]);
  const lab = (l) => T.cases.find((c) => c.label === l), zp = (p) => Math.abs(T.special.find((q) => q.p === p && q.label === 'z = p').batman);
  const hd = T.cases.find((c) => c.label.startsWith('e = 0.93, omega = -58.7') && c.law === 'quadratic'), k001 = lab('Rp/R* = 0.01, Claret');
  const nlB = T.cases.filter((c) => c.law === 'nonlinear' && c.depth > 0).map((c) => c.stats.batman.max);

  ctx.found.transit = { worst: worst.esl.max, branch: Math.abs(spW.esl), ecWorst: st['exoplanet-core (kernel)']?.max, autoMax, autoN: ex.map((x) => x.r.auto) };
  Object.assign((ctx.found.out ||= {}), { zp: [zp(0.05), zp(0.1), zp(0.3)], zpNear: Math.max(...T.special.filter((q) => /^z = p [-+]1e-10$/.test(q.label)).map((q) => Math.abs(q.batman))), ellcMin: Math.abs(hd.dtMinSep) * 1440, batmanNL: Math.max(...nlB),
    batmanExp: (() => { const r = ex.map((x) => C.maxAbs(x.e.codes.batman['7']) / x.r.byN.find((q) => q.ns === 7).max); return `${Math.round(Math.min(...r))} to ${Math.round(Math.max(...r))}`; })(),
    pyaNL: Math.max(...T.cases.filter((c) => c.law === 'nonlinear' && c.stats.PyAstronomy).map((c) => c.stats.PyAstronomy.max)), pyaQuad: Math.max(...T.cases.filter((c) => c.law === 'quadratic' && c.stats.PyAstronomy && c.depth > 0).map((c) => c.stats.PyAstronomy.max)),
    pyaCrash: (k001.errors?.PyAstronomy || 'no failure in this run').replace(/^RuntimeError: /, ''), pytA: lab('a/R* = 2.5, quadratic').stats.PyTransit.max, pytE: lab('e = 0.93, omega = 120, quadratic').stats.PyTransit.max });
  ctx.glance.push({ href: 'transit', q: 'How accurately is the dimming of the star computed?', value: e1(worst.esl.max), small: `of the star’s light`, ok: okT && autoMax < TOL.exposureAuto,
    practice: `${ppm(worst.esl.max)}. For scale, an Earth-size planet crossing a Sun-like star dims it by 84 ppm.`, others: `${e1(Math.min(...own.map((n) => st[n].max)))} to ${e1(Math.max(...own.map((n) => st[n].max)))} (each code’s worst case)` });

  // ---- the number, and one chart
  const keys = $('div', 'vkeys'); s.append(keys);
  keys.innerHTML = keyNumber(e1(worst.esl.max), 'of the star’s light', `Largest error in ${all.length} light curves: ${ppm(worst.esl.max)}. For scale, an Earth-size planet crossing a Sun-like star dims it by 84 ppm.`)
    + keyNumber(ppm(autoMax), 'for long exposures', `Largest error when each point is a 2- or 30-minute exposure, averaged automatically.`);
  const rows = [{ label: ME, lo: med, hi: worst.esl.max, color: ctx.TH.esl, strong: true }, ...names.map((n) => ({ label: n, lo: st[n].med, hi: st[n].max, color: col.of(n) })).sort((a, b) => a.hi - b.hi)];
  chart(s, 'ranges', { rows, xMin: 1e-16, xMax: 1e-3, floor: true, marks: [{ x: 1e-6, label: '1 ppm' }, { x: TOL.transit, label: 'tolerance' }], loName: 'typical case (median)', hiName: 'worst case' },
    { title: 'Error of the transit flux: each code against the 30-digit reference', sub: `Bar: from a code’s typical case to its worst. Further left is more accurate.`, height: rangesHeight(rows.length),
      label: `Range plot. This code: typical ${e1(med)}, worst ${e1(worst.esl.max)}. Other codes’ worst cases: ${names.map((n) => `${n} ${e1(st[n].max)}`).join('; ')}.` });
  const n0 = E.timing?.[T.timing[0].key], n1 = E.timing?.[T.timing[1].key];

  // ---- every case
  details(s, `All ${all.length} cases, tabulated and drawn`, (b) => {
    const row = $('div', 'vrow'); row.innerHTML = '<label for="tcase">Case</label>';
    const sel = $('select'); sel.id = 'tcase'; let g = null, og = null;
    all.forEach((a, i) => { if (a.c.group !== g) { g = a.c.group; og = document.createElement('optgroup'); og.label = g; sel.append(og); } const o = document.createElement('option'); o.value = i; o.textContent = a.c.label; og.append(o); });
    row.append(sel); b.append(row);
    const grid = $('div', 'vgrid2'); b.append(grid);
    const specFor = (i) => {
      const a = all[i], c = a.c, tm = Array.from(a.esl.t, (t) => (t - c.tmid) * 24);
      return { model: { series: [{ x: tm, y: c.truth, color: col.of('truth'), width: 5, label: 'reference' }, { x: tm, y: Array.from(a.esl.flux), color: col.of('ESL'), width: 1.5, label: ME }], xLabel: 'hours from mid-transit', xLabelShort: 't [h]' },
        diff: { yLog: true, yFloor: 1e-17, yMin: 1e-17, yMax: 1e-3, xLabel: 'hours from mid-transit', xLabelShort: 't [h]', series: [{ x: tm, y: Array.from(a.esl.res), color: col.of('ESL'), width: 2.5, label: ME }, ...names.filter((n) => c.codes[n]).map((n) => ({ x: tm, y: c.codes[n], color: col.of(n), dash: col.dash(n), width: 1.5, label: n }))] } };
    };
    const first = Math.max(0, all.findIndex((a) => a.c.label.startsWith('e = 0.93, omega = -58.7') && a.c.law === 'nonlinear'));
    sel.value = first; const q0 = specFor(first);
    const c1 = chart(grid, 'lines', q0.model, { title: 'Model flux', sub: 'this code drawn over the reference', height: 250, label: 'Transit light curve of the selected case: this code over the reference' });
    const c2 = chart(grid, 'lines', q0.diff, { title: '|flux − reference|, logarithmic', sub: 'Lower is closer to the reference. Select a name to hide it.', height: 250, label: 'Absolute flux difference from the reference for each code, selected case' });
    const short = (n) => n.replace(' (max_err 0.001 ppm)', '<br>0.001 ppm').replace(' (very_fine grid)', '<br>very fine').replace(' (precision 6)', '<br>precision 6').replace(' (kernel)', '<br>kernel');
    const mrows = []; let grp = null;
    all.forEach((a, i) => {
      if (a.c.group !== grp) { grp = a.c.group; mrows.push({ raw: `<tr class="grp"><td colspan="${names.length + 3}">${esc(grp)}</td></tr>` }); }
      mrows.push({ cls: 'pick' + (i === first ? ' sel' : ''), attr: ` data-i="${i}"`, cells: [L(esc(a.c.label)), N(e1(a.esl.max), 'esl'), `<td>${pill(a.esl.max < TOL.transit)}</td>`, ...names.map((n) => heat(a.c.stats[n] ? a.c.stats[n].max : null))] });
    });
    const mt = table(['Case', 'This code', `< ${e1(TOL.transit)}`, ...names.map(short)], mrows, '', 'Largest |flux − reference| in each case, per code. Darker cells are larger differences.'); b.append(mt);
    const pick = (i) => { const q = specFor(i); c1.update(q.model); c2.update(q.diff); sel.value = i; mt.querySelectorAll('tr.pick').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.i) === Number(i))); };
    sel.onchange = () => pick(Number(sel.value));
    mt.addEventListener('click', (ev) => { const tr = ev.target.closest('tr.pick'); if (tr) { pick(Number(tr.dataset.i)); grid.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
    b.append($('p', 'vnote', `exoplanet-core provides the flux formula only and was handed the reference’s planet positions; every other code computed its own orbit. batman’s worst case is the single point described in section 3; ${e1(median(T.cases.filter((c) => c.law === 'quadratic' && c.depth > 0).map((c) => c.stats.batman.max)))} is typical for its quadratic law.`));
    b.append($('p', 'vnote', 'Select a row to draw it above. A dot means the code has no such model (pyaneti and exoplanet-core: quadratic law only) or failed. For the planet that misses the star (b = 1.2) every code returns exactly 1. ellc was given the time of closest approach from the 30-digit orbit (see section 3).'));
  }, { id: 'transit-cases' });

  details(s, 'The flux formula at its branch points', (b) => {
    b.append($('p', '', `The flux formula changes form where the planet touches the star’s limb, covers its centre, or has its own centre one planet radius from the star’s (z = p). Evaluated exactly there and 1e-13 either side, quadratic law with u = (0.40, 0.26), against 30-digit arithmetic:`));
    b.append(table(['Rp/R★', 'Separation z', 'Reference flux', 'This code − ref', 'batman − ref', 'exoplanet-core − ref'], sp.map((q) => [L(String(q.p)), L(esc(q.label)), q.truth.toFixed(15), N(se1(q.esl), 'esl'), heat(Math.abs(q.batman)).replace('>', '>' + (q.batman < 0 ? '−' : '')), se1(q['exoplanet-core'])])));
    b.append($('p', 'vnote', `In a light curve: with Rp/R★ = 0.3 and b = 0.3 the mid-transit sample has z = p to within 1e-15, and batman ${esc(ctx.version('batman'))} is ${e1(lab('Rp/R* = 0.3, quadratic').stats.batman.max)} too high there.`));
  }, { id: 'transit-branch' });

  details(s, 'Exposure averaging', (b) => {
    b.append($('p', '', 'A camera averages the flux over each exposure; codes approximate that with a few evaluations per exposure. The reference is the average of 4001 evaluations of the exact quadratic-law flux on a circular orbit.'));
    const eg = $('div', 'vgrid2'); b.append(eg); const ns = [3, 7, 15, 31];
    for (const { e, r } of ex) chart(eg, 'lines', { xLog: true, yLog: true, yFloor: 1e-10, xLabel: 'sub-samples per exposure', xLabelShort: 'n =', xPad: 0.04,
      series: [{ x: r.byN.map((q) => q.ns), y: r.byN.map((q) => q.max), color: col.of('ESL'), width: 2.5, points: true, label: ME }, ...Object.keys(e.codes).map((n) => ({ x: ns, y: ns.map((k) => C.maxAbs(e.codes[n][k])), color: col.of(n), points: true, r: 3, width: 1.5, label: n }))] },
    { title: e.label, sub: 'largest error of the exposure-averaged flux; PyTransit and pyaneti lie under this code', height: 220, label: 'Error of exposure averaging against number of sub-samples, per code' });
    b.append(table(['Case', 'No averaging', 'Automatic: sub-samples', 'Automatic: error', 'n = 7', 'batman, n = 7', 'PyTransit, n = 7', 'pyaneti, n = 7', 'n = 101'], ex.map(({ e, r }) => [L(esc(e.label)), e1(Math.max(...e.instantaneous.map(Math.abs))), r.auto, N(e1(r.autoRun.max), 'esl'), N(e1(r.byN.find((q) => q.ns === 7).max), 'esl'), e1(C.maxAbs(e.codes.batman['7'])), e1(C.maxAbs(e.codes.PyTransit['7'])), e.codes.pyaneti ? e1(C.maxAbs(e.codes.pyaneti['7'])) : 'n/a', N(e1(r.byN.find((q) => q.ns === 101).max), 'esl')])));
    b.append($('p', 'vnote', 'This code, PyTransit and pyaneti place sub-samples at the centres of equal slices of the exposure and agree at every n. batman’s samples run from edge to edge of the exposure with equal weights, which over-weights the ends.'));
  }, { id: 'transit-exposure' });

  details(s, 'Speed', (b) => {
    const rate = (i, n) => T.timing[i].rate[n];
    const live = [0, 1].map((i) => C.timeTransit(T.timing[i], 0.3));
    b.append(table(['Code', 'Light curves/s: circular, quadratic', 'Light curves/s: e = 0.3, four-coefficient'], [[L(`${ME} (Node ${esc(E.node || '')})`), N(int(n0), 'esl'), N(int(n1), 'esl')], [L(`${ME} (this browser)`), N(int(live[0]), 'esl'), N(int(live[1]), 'esl')],
      ...names.filter((n) => rate(0, n) || rate(1, n)).map((n) => [L(esc(n)), int(rate(0, n)), int(rate(1, n))])]));
    b.append($('p', 'vnote', `Whole light curves of ${T.timing[0].n} points per second on one core, parameters changed on every call. The others are C, Fortran, Rust or numba called through Python on the same machine (${esc(T.machine)}) while other jobs were running: good to a factor of about 1.5. This code integrates every law numerically, so the closed-form codes win on the quadratic law.`));
  }, { id: 'transit-speed' });

  inputs(s, 'Inputs', ['Case', 'Law', 'Coefficients', 'Rp/R★', 'P [d]', 'a/R★', 'i [°]', 'e', 'ω [°]', 'Points'], T.cases.map((c) => [L(esc(c.label)), L(c.law === 'nonlinear' ? 'four-coefficient' : c.law), L(c.ld.join(', ') || '—'), c.rprs, c.per, c.ars, sig(c.inc, 8), c.ecc, c.omega, c.n]), 'transit.json');
  howRun(ctx, s, { script: 'tools/validation/make_transit.py', json: 'transit.json', mine: '<code>transitAll</code>, <code>specialPoints</code>, <code>exposureCase</code>', codes: ['batman', 'PyTransit', 'exoplanet-core', 'PyAstronomy', 'ellc', 'pylightcurve', 'EXOTIC', 'pyaneti', 'scipy', 'mpmath'],
    extra: `The reference: ${esc(T.truth.method)}. A second evaluation by tanh-sinh quadrature in 30 digits agrees with it to ${e1(T.truth.kernelVsMpmath)}, and exoplanet-core’s closed form to ${e1(ctx.found.transit.ecWorst)}. Limb-darkening laws: quadratic, the four-coefficient law of ${cite('claret2000')}, uniform and linear; the (q1, q2) form of ${cite('kipping2013')} maps onto the quadratic law exactly.` });
}

// =====================================================================================================================
// 4.2 orbit and timing
// =====================================================================================================================
export function orbitBlock(ctx) {
  const s = body('orbit'), { O } = ctx.data, col = colors(ctx.TH);
  const K = O.kepler, mine = C.keplerErrors(O), xs = K.ecc.map((_, i) => i), ticks = K.ecc.map((e, i) => ({ v: i, label: String(e) })), names = Object.keys(K.codes);
  const wNu = Math.max(...mine.map((m) => m.dNu)), wRes = Math.max(...mine.map((m) => m.resid)), i93 = K.ecc.indexOf(0.93), i99 = K.ecc.indexOf(0.99), last = K.ecc.length - 1;
  const okK = ctx.check('orbit', `Kepler’s equation, e = ${K.ecc[0]} to ${K.ecc[last]}`, wNu < TOL.keplerNu && wRes < TOL.keplerE, `largest error of the orbital angle ${e1(wNu)} rad (tolerance ${e1(TOL.keplerNu)}); residual of the equation ${e1(wRes)} (tolerance ${e1(TOL.keplerE)})`);
  const ev = C.eventErrors(O), wP = Math.max(...ev.map((x) => Math.abs(x.dPeri))), wE = Math.max(...ev.map((x) => Math.abs(x.dEcl)));
  const okE = ctx.check('orbit', `Times of periastron and secondary eclipse, ${ev.length} orbits`, wP < TOL.eventSeconds && wE < TOL.eventSeconds, `largest error ${e1(wP)} s and ${e1(wE)} s; tolerance ${e1(TOL.eventSeconds)} s`);
  const D = C.durationRows(O); let wD = 0; for (const d of D) for (const k of ['t14', 't23', 'e14', 'e23']) wD = Math.max(wD, Math.abs(d.exact[k] - d.c.truth[k]) * 86400);
  const okD = ctx.check('orbit', `Transit and eclipse durations, ${D.length} orbits`, wD < TOL.durationSeconds, `largest error ${e1(wD)} s; tolerance ${e1(TOL.durationSeconds)} s`);
  const W = 'Winn (2010) eqs. 14-16', winnShort = Math.max(...D.map((d) => Math.abs(d.c.codes[W].t14 - d.c.truth.t14) * 86400)), hdr = D.find((d) => d.c.label.startsWith('HD 80606')), pub = O.published;
  const worstOf = (cd, q) => { const d = O.events.filter((c) => c.codes[cd] && c.codes[cd][q] !== undefined).map((c) => Math.abs(c.codes[cd][q] - c.truth[q]) * 86400); return d.length ? Math.max(...d) : null; };
  ctx.found.orbit = { e14: hdr.exact.e14, e14ref: hdr.c.truth.e14, e14pub: pub.e14 };
  Object.assign((ctx.found.out ||= {}), { radvelFail: K.codes['radvel (C)'].failures?.['0.999'] || 'no failure in this run', radvelPy: K.codes['radvel (Python)'].max[last], pytransit999: K.codes['PyTransit (Newton)'].max[last], pytransit99: Math.max(...K.codes['PyTransit (Newton)'].max.slice(0, i99 + 1)),
    batman93: K.codes.batman.max[i93], pyaneti93: K.codes.pyaneti?.max[i93], pyanetiPeri: worstOf('pyaneti', 'tperi'), plcE14: Number(hdr.c.codes.pylightcurve.e14).toExponential(1), winnShort });
  const wT = Math.max(wP, wE, wD);
  ctx.glance.push({ href: 'orbit', q: 'Where is the planet on its orbit at a given time?', value: e1(wNu), small: 'radians', ok: okK, practice: 'Rounding error, even for extreme orbits.', others: `${e1(K.codes.batman.max[i93])} (batman, pyaneti) at e = 0.93; two fail at e = 0.999` });
  ctx.glance.push({ href: 'orbit', q: 'When do transits and eclipses happen, and for how long?', value: e1(wT), small: 'seconds', ok: okE && okD, practice: 'For scale, the Spitzer mid-transit time in this site’s WASP-43 b example has an uncertainty of 6 s.', others: `closed-form durations: up to ${winnShort.toFixed(0)} s short` });

  const keys = $('div', 'vkeys'); s.append(keys);
  keys.innerHTML = keyNumber(e1(wNu), 'radians', `Largest error of the planet’s position angle, for eccentricities up to ${K.ecc[last]}.`)
    + keyNumber(e1(wT), 'seconds', `Largest error of any event time or duration. The textbook duration formula is up to ${winnShort.toFixed(0)} s short at e = 0.93.`);
  chart(s, 'lines', { yLog: true, yFloor: 1e-17, yMin: 1e-17, yMax: 1, xTicks: ticks, xLabel: 'orbital eccentricity', xLabelShort: 'e =', xPad: 0.03,
    series: [{ x: xs, y: mine.map((m) => m.dNu), color: col.of('ESL'), width: 2.5, points: true, label: ME }, ...names.map((n) => ({ x: xs, y: K.codes[n].max.map((v) => (v === null ? NaN : v)), color: col.of(n), dash: col.dash(n), width: 1.5, points: true, r: 3, label: n }))] },
  { title: 'Error in solving Kepler’s equation [radians], by eccentricity', sub: 'Lower is better. A missing point is a failure.', height: 270,
    label: `Line chart of Kepler solver error against eccentricity. This code stays below ${e1(wNu)} rad. batman and pyaneti rise from 1e-7 to 4e-3; PyTransit jumps to ${e1(K.codes['PyTransit (Newton)'].max[last])} at e = 0.999; radvel’s compiled solver has no value at 0.999.` });

  details(s, 'Kepler’s equation, every code', (b) => {
    b.append(table(['Code', 'Compared', ...K.ecc.map((e) => 'e = ' + e)], [[L(ME), L('true anomaly'), ...mine.map((m) => N(e1(m.dNu), 'esl'))], ...names.map((n) => [L(esc(n)), L(K.codes[n].kind === 'nu' ? 'true anomaly' : 'eccentric anomaly'), ...K.codes[n].max.map((v) => (v === null ? '<td class="num"><span class="pill bad">✗ failed</span></td>' : heat(v)))])], '', 'Largest error in radians over the mean anomalies tested'));
    b.append($('p', 'vnote', `${K.M.length} mean anomalies around the whole orbit, clustered near periastron, against 30-digit arithmetic. radvel’s compiled solver at e = 0.999: ${esc(K.codes['radvel (C)'].failures?.['0.999'] || 'no failure in this run')}. pyaneti’s stopping tolerance is 1e-6 (<code>fmin</code> in its <code>constants.f90</code>).`));
  }, { id: 'orbit-kepler' });

  details(s, 'Periastron and eclipse times', (b) => {
    const cs = ['radvel', 'batman', 'pyaneti', 'pylightcurve', 'PyTransit'];
    b.append(table(['Code', 'Periastron time: worst error [s]', 'Mid-eclipse time: worst error [s]'], [[L(ME), N(e1(wP), 'esl'), N(e1(wE), 'esl')], ...cs.map((c) => [L(c), e1(worstOf(c, 'tperi')), e1(worstOf(c, 'tecl'))])]));
    b.append($('p', 'vnote', `${ev.length} orbits, e = 0.1 to 0.93 in five orientations, compared modulo the period; mid-eclipse is superior conjunction. radvel’s <code>timeperi_to_timetrans(..., secondary=True)</code> sometimes returns the eclipse one orbit later, which is harmless once folded.`));
  }, { id: 'orbit-events' });

  details(s, 'Durations, and HD 80606 b’s eclipse', (b) => {
    const sec = (a, t) => (a === null || a === undefined || t === undefined ? null : (a - t) * 86400);
    const f2 = (x) => (x === null ? '<td class="na">n/a</td>' : x === 0 ? N('0') : N((x < 0 ? '−' : '+') + (Math.abs(x) < 0.005 ? Math.abs(x).toExponential(0) : Math.abs(x).toFixed(2))));
    b.append(table(['Orbit', 'T14 [d], reference', 'This code', 'Its closed form', 'Winn (2010)', 'pylightcurve', 'PyTransit', 'T23 [d], reference', 'This code', 'Its closed form'],
      D.map((d) => { const c = d.c, w = c.codes[W], pl = c.codes.pylightcurve, pt = c.codes.PyTransit; return [L(esc(c.label)), c.truth.t14.toFixed(6), f2(sec(d.exact.t14, c.truth.t14)).replace('num', 'num esl'), f2(sec(d.closed.t14, c.truth.t14)), f2(sec(w.t14, c.truth.t14)), f2(sec(pl.t14, c.truth.t14)), f2(sec(pt.t14, c.truth.t14)), c.truth.t23.toFixed(6), f2(sec(d.exact.t23, c.truth.t23)).replace('num', 'num esl'), f2(sec(d.closed.t23, c.truth.t23))]; }), '', 'Differences from the reference in seconds'));
    b.append($('p', 'vnote', `“This code” is what the analyzer’s system table shows (bisection on the projected separation). “Its closed form” is the expression of ${cite('winn2010')} that it uses internally only to choose exposure sub-sampling: exact for circular orbits, up to ${winnShort.toFixed(0)} s (${(100 * Math.max(...D.map((d) => Math.abs(d.closed.t14 - d.c.truth.t14) / d.c.truth.t14))).toFixed(1)}%) short at e = 0.93. PyTransit’s duration function is the same expression; pylightcurve finds roots.`));
    b.append(table(['Eclipse duration E14 [d]', 'Reference', 'This code', 'Winn (2010)', 'PyTransit', 'pylightcurve', 'Published'], D.filter((d) => d.c.truth.e14 > 0).map((d) => { const c = d.c; return [L(esc(c.label)), c.truth.e14.toFixed(6), N(d.exact.e14.toFixed(6), 'esl'), c.codes[W].e14.toFixed(6), fx(c.codes.PyTransit.e14, 6), fx(c.codes.pylightcurve.e14, 6), c === hdr.c ? pub.e14.toFixed(5) : '']; })));
    b.append($('p', '', `<b>HD 80606 b.</b> ${esc(pub.label)} gives E14 = ${pub.e14} d. This code gives ${hdr.exact.e14.toFixed(4)} d from the same parameters, root finding on the 30-digit orbit ${hdr.c.truth.e14.toFixed(6)} d, and Winn’s formula ${hdr.c.codes[W].e14.toFixed(4)} d. The transit duration agrees with the paper (${hdr.c.truth.t14.toFixed(4)} against ${pub.t14} d). No method tried reproduces the published eclipse duration (${cite('pearson2022')}).`));
  }, { id: 'orbit-durations' });

  details(s, 'Three meanings of “mid-transit”', (b) => {
    b.append($('p', '', `On an inclined eccentric orbit the conjunction, the closest approach and the midpoint between first and last contact are different instants. For HD 80606 b the closest approach is ${(hdr.c.truth.dtMinSep * 1440).toFixed(2)} min from conjunction and the contact midpoint ${(hdr.c.truth.contactMid * 1440).toFixed(2)} min (this code’s own orbit gives ${(hdr.dtMinSep * 1440).toFixed(2)} min for the first). This code, batman, pylightcurve, pyaneti, PyTransit and radvel take conjunction as the reference time; ellc takes the closest approach. A mid-time measured from a light curve’s symmetry is nearer the contact midpoint, so for this planet the three should not be mixed.`));
  }, { id: 'orbit-midtransit' });

  inputs(s, 'Inputs', ['Orbit', 'Rp/R★', 'P [d]', 'a/R★', 'i [°]', 'e', 'ω [°]', 'b'], O.durations.map((c) => [L(esc(c.label)), c.rprs, c.per, c.ars, sig(c.inc, 8), c.ecc, c.omega, sig(c.b, 4)]), 'orbit.json');
  howRun(ctx, s, { script: 'tools/validation/make_orbit.py', json: 'orbit.json', mine: '<code>keplerErrors</code>, <code>eventErrors</code>, <code>durationRows</code>', codes: ['radvel', 'batman', 'PyTransit', 'PyAstronomy', 'exoplanet-core', 'pylightcurve', 'pyaneti', 'mpmath'], extra: 'The reference is 30-digit arithmetic throughout; durations are found by root finding on that orbit, not from a formula.' });
}

// =====================================================================================================================
// 4.3 radial velocities
// =====================================================================================================================
export function rvBlock(ctx) {
  const s = body('rv'), { V } = ctx.data, col = colors(ctx.TH);
  const R = V.cases.map((c) => ({ c, r: C.rvCase(c) })), w = Math.max(...R.map((x) => x.r.max)), names = Object.keys(V.cases[0].codes), hd = V.cases[V.cases.length - 1];
  const okV = ctx.check('rv', `Velocity curves match the reference in all ${R.length} orbits`, w < TOL.rv, `worst ${e1(w)} of K; tolerance ${e1(TOL.rv)}`);
  const qb = Math.max(...R.map((x) => Math.abs(x.r.quarter - x.c.quarterBefore.truth)));
  ctx.check('rv', 'Sign and ω convention agree with the geometric reference', qb < 1e-6 && Math.abs(R[0].r.quarter - 1) < 1e-12, `circular orbit a quarter period before transit: v/K = ${sig(R[0].r.quarter, 6)} (the star is receding)`);
  const A = C.amplitudeRows(V), wa = Math.max(...A.map((a) => Math.abs(a.rel)));
  ctx.check('rv', 'Velocity amplitude K from the masses', wa < TOL.amplitude, `largest relative difference ${e1(wa)}; tolerance ${e1(TOL.amplitude)}`);
  const mx = (n) => Math.max(...V.cases.map((c) => (c.codes[n] ? C.maxAbs(c.codes[n]) / c.K : 0))), mn = (n) => Math.min(...V.cases.map((c) => (c.codes[n] ? C.maxAbs(c.codes[n]) / c.K : Infinity)));
  Object.assign((ctx.found.out ||= {}), { exotic: mx('EXOTIC'), exoticFine: mx('EXOTIC (finer step)'), exoticFactor: hd.exoticFactor - 1 });
  ctx.glance.push({ href: 'rv', q: 'How accurately is the star’s velocity computed?', value: e1(w), small: 'of the amplitude K', ok: okV, practice: `${e1(w * hd.K)} m/s for HD 80606 b; the most precise instrument in its bundled velocities has a median uncertainty of 1.1 m/s.`, others: `radvel ${e1(mx('radvel'))}, pyaneti ${e1(mx('pyaneti'))}, EXOTIC ${e1(mx('EXOTIC'))}` });

  const keys = $('div', 'vkeys'); s.append(keys);
  keys.innerHTML = keyNumber(e1(w), 'of the amplitude K', `Largest error over ${R.length} orbits: ${e1(w * hd.K)} m/s for HD 80606 b, whose star moves by ±${hd.K} m/s.`)
    + keyNumber('Same sign, same ω', '', `as ${code('radvel')} and ${code('pyaneti')}: positive means receding; ω needs no conversion.`);
  const wrong = (k) => Math.max(...V.cases.filter((c) => c.ecc).map((c) => c.wrong[k]));
  const rows = [{ label: ME, lo: Math.min(...R.map((x) => x.r.max)), hi: w, color: ctx.TH.esl, strong: true }, ...names.map((n) => ({ label: n, lo: mn(n), hi: mx(n), color: col.of(n) })),
    { label: 'if ω were off by 180°', hi: wrong('radvel, omega + 180 deg'), color: ctx.TH.s[7] }, { label: 'if the sign were flipped', hi: wrong('sign flipped'), color: ctx.TH.s[7] }];
  chart(s, 'ranges', { rows, xMin: 1e-16, xMax: 100, floor: true, marks: [{ x: TOL.rv, label: 'tolerance' }], loName: 'best case', hiName: 'worst case' },
    { title: 'Error of the velocity curve in units of its amplitude K', sub: `Bar: best to worst orbit. Last two rows: the two classic convention mistakes.`, height: rangesHeight(rows.length),
      label: `Range plot of velocity error over K. This code ${e1(w)}; ${names.map((n) => `${n} ${e1(mx(n))}`).join('; ')}; a 180 degree error in omega ${sig(wrong('radvel, omega + 180 deg'), 2)}; a flipped sign ${sig(wrong('sign flipped'), 2)}.` });

  details(s, 'Every orbit, tabulated and drawn', (b) => {
    const row = $('div', 'vrow'); row.innerHTML = '<label for="rvcase">Orbit</label>'; const sel = $('select'); sel.id = 'rvcase';
    R.forEach((x, i) => { const o = document.createElement('option'); o.value = i; o.textContent = x.c.label; sel.append(o); }); row.append(sel); b.append(row);
    const grid = $('div', 'vgrid2'); b.append(grid);
    const spec = (i) => { const { c, r } = R[i], ph = Array.from(r.t, (t) => (t - c.tmid) / c.per);
      return { model: { series: [{ x: ph, y: c.truth, color: col.of('truth'), width: 5, label: 'reference' }, { x: ph, y: Array.from(r.v), color: col.of('ESL'), width: 1.5, label: ME }], xLabel: 'orbits from mid-transit', xLabelShort: 'phase' },
        diff: { yLog: true, yFloor: 1e-17, yMin: 1e-17, yMax: 1e-2, xLabel: 'orbits from mid-transit', xLabelShort: 'phase', series: [{ x: ph, y: Array.from(r.res, (d) => d / c.K), color: col.of('ESL'), width: 2.5, label: ME }, ...Object.keys(c.codes).map((n) => ({ x: ph, y: c.codes[n].map((d) => d / c.K), color: col.of(n), dash: col.dash(n), width: 1.5, label: n }))] } }; };
    sel.value = 2; const q0 = spec(2);
    const c1 = chart(grid, 'lines', q0.model, { title: 'Velocity of the star [m/s], positive = receding', sub: 'this code drawn over the reference; mid-transit at 0', height: 240, label: 'Radial velocity curve of the selected orbit' });
    const c2 = chart(grid, 'lines', q0.diff, { title: '|velocity − reference| / K, logarithmic', sub: 'in units of the amplitude', height: 240, label: 'Velocity difference from the reference for each code, selected orbit' });
    sel.onchange = () => { const q = spec(Number(sel.value)); c1.update(q.model); c2.update(q.diff); };
    b.append(table(['Orbit', 'This code', `< ${e1(TOL.rv)}`, ...names, 'if ω were off by 180°', 'if the sign were flipped'], R.map(({ c, r }) => [L(esc(c.label)), N(e1(r.max), 'esl'), `<td>${pill(r.max < TOL.rv)}</td>`, ...names.map((n) => heat(C.maxAbs(c.codes[n]) / c.K)), sig(c.wrong['radvel, omega + 180 deg'], 3), sig(c.wrong['sign flipped'], 3)]), '', 'Largest difference from the reference over 1.2 orbits, in units of K'));
    b.append($('p', 'vnote', `EXOTIC’s columns are after dividing out its mass factor 1 + M<sub>p</sub>/M★. pyaneti’s 1e-7 to 1e-6 is the early stop of its Kepler iteration; for K = 470 m/s that is half a millimetre per second. For a circular orbit a 180° shift of ω changes nothing, because the transit time fixes the phase.`));
  }, { id: 'rv-cases' });

  details(s, 'Sign and angle conventions', (b) => {
    b.append(table(['Code', 'Positive velocity', 'ω', 'Reference time', 'v/K a quarter period before transit (circular)', 'Conversion from this code'], [
      [L(ME), L('star receding'), L('transit at true anomaly 90° − ω: the star’s ω of the velocity literature'), L('mid-transit (inferior conjunction)'), N(sig(R[0].r.quarter, 6), 'esl'), L('—')],
      [L('radvel'), L('star receding'), L('“of the star”: v = K[cos(ν + ω) + e cos ω]'), L('periastron, or conjunction via <code>timetrans_to_timeperi</code>'), sig(V.cases[0].quarterBefore.radvel, 6), L('none')],
      [L('pyaneti'), L('star receding'), L('same as radvel'), L('mid-transit'), sig(V.cases[0].quarterBefore.pyaneti, 6), L('none')],
      [L('batman, pylightcurve, PyTransit'), L('n/a (transit codes)'), L('same number'), L('mid-transit'), 'n/a', L('none')],
      [L('EXOTIC'), L('star receding'), L('pylightcurve’s (same number)'), L('mid-transit'), sig(V.cases[0].quarterBefore.EXOTIC, 6), L('amplitude from masses is larger by 1 + M<sub>p</sub>/M★')],
      [L('PyAstronomy (transit model)'), L('n/a'), L('measured from the opposite node: this code’s ω + 180°'), L('periastron'), 'n/a', L('add 180° to ω; convert the time')],
      [L('ellc'), L('n/a'), L('same number'), L('closest approach'), 'n/a', L('shift the time')],
    ], 'left'));
    b.append($('p', 'vnote', `This code describes the planet’s orbit with +Z toward the observer; the velocity literature describes the star’s orbit with +Z away. The two flips cancel, so ω is the same number. The reference is computed twice, from ${esc(V.truth.split(';')[0])} and by differentiating the orbit’s geometry in 30-digit arithmetic, which fixes sign and ω without quoting a formula; the two agree to ${e1(Math.max(...V.cases.map((c) => c.geometryVsFormula)))} K.`));
  }, { id: 'rv-conventions' });

  details(s, 'Amplitude from the masses', (b) => {
    b.append(table(['System', 'K [m/s], two-body formula, IAU nominal constants', 'This code', 'Relative', 'radvel, relative', 'astropy constants, relative'], A.map((a) => [L(esc(a.r.label)), sig(a.r.truth, 8), N(sig(a.K, 8), 'esl'), N(se1(a.rel), 'esl'), se1(a.r.codes['radvel.utils.semi_amplitude'] / a.r.truth - 1), se1(a.r.codes['astropy constants'] / a.r.truth - 1)])));
    b.append($('p', 'vnote', `This code’s ${e1(wa)} is its Jupiter-to-Sun mass ratio; radvel’s ${e1(Math.max(...V.amplitude.map((r) => Math.abs(r.codes['radvel.utils.semi_amplitude'] / r.truth - 1))))} is its rounded constant 28.4329 m/s.`));
  }, { id: 'rv-amplitude' });

  inputs(s, 'Inputs', ['Orbit', 'P [d]', 'e', 'ω [°]', 'K [m/s]', 'Points'], V.cases.map((c) => [L(esc(c.label)), c.per, c.ecc, c.omega, c.K, c.n]), 'rv.json');
  howRun(ctx, s, { script: 'tools/validation/make_rv.py', json: 'rv.json', mine: '<code>rvCase</code>, <code>amplitudeRows</code>', codes: ['radvel', 'pyaneti', 'EXOTIC', 'astropy', 'mpmath'] });
}

// =====================================================================================================================
// 4.4 fits: posteriors, evidence, coverage
// =====================================================================================================================
const LABEL = { rprs: 'Rp/R★', tmid: 'T mid [d]', inc: 'i [°]', ars: 'a/R★', a2: 'airmass k', K: 'K [m/s]', rvlin: 'trend [m/s/d]', ecc: 'e', omega: 'ω [°]', 'jit@rv1': 'jitter [m/s]' };
export function fitsBlock(ctx, onChange) {
  const s = body('fits'), { F, E } = ctx.data, col = colors(ctx.TH), TH = ctx.TH;
  const lnl = F.problems.map((P) => C.lnLCheck(P)), wl = Math.max(...lnl.flat().map(Math.abs));
  ctx.check('fits', 'The likelihood equals an independent Python implementation at the same parameters', wl < TOL.lnL, `largest difference in ln L ${e1(wl)} over ${lnl.flat().length} points in ${F.problems.length} problems; tolerance ${e1(TOL.lnL)}`);
  const fitDetail = (cmp) => `largest shift of a mean ${Math.max(...cmp.rows.map((r) => Math.abs(r.dMean))).toFixed(3)}σ (tolerance ${TOL.fitMean}), of a width ${(100 * Math.max(...cmp.rows.map((r) => Math.abs(r.dWidth)))).toFixed(1)}% (${100 * TOL.fitWidth}%), ln Z within ${Math.max(...cmp.lnZ.map((z) => Math.abs(z.sigma))).toFixed(2)}σ (${TOL.lnZsigma})`;
  const cmps = {}, src = {};
  for (const P of F.problems) if (E.fits?.[P.id]) { cmps[P.id] = C.compareFit(P, E.fits[P.id]); src[P.id] = { S: E.fits[P.id], text: `stored run in Node ${E.node} (${E.fits[P.id].sampler})` }; ctx.check('fits', `Fit ${P.id}: posterior and evidence agree with dynesty and UltraNest`, cmps[P.id].ok, fitDetail(cmps[P.id]), false); ctx.checks[ctx.checks.length - 1].key = 'fit' + P.id; }
  const cov = {}; let cLo = 1, cHi = 0;
  for (const kind of Object.keys(C.COVERAGE)) {
    const cv = E.coverage?.[kind]; if (!cv) continue; const sum = C.coverageSummary(kind, cv.ranks); cov[kind] = { cv, sum };
    for (const q of sum) { cLo = Math.min(cLo, q.c68); cHi = Math.max(cHi, q.c68); }
    ctx.check('fits', `68% intervals contain the truth 68% of the time (${C.COVERAGE[kind].label})`, sum.every((q) => q.c68 > TOL.coverage68[0] && q.c68 < TOL.coverage68[1]), sum.map((q) => `${q.key} ${(100 * q.c68).toFixed(1)}%`).join(', ') + `; accepted ${100 * TOL.coverage68[0]} to ${100 * TOL.coverage68[1]}% (${cv.ranks.length} trials)`, false);
  }
  const agg = () => { const cs = Object.values(cmps); return { mean: Math.max(...cs.flatMap((c) => c.rows.map((r) => Math.abs(r.dMean)))), width: Math.max(...cs.flatMap((c) => c.rows.map((r) => Math.abs(r.dWidth)))), z: Math.max(...cs.flatMap((c) => c.lnZ.map((x) => Math.abs(x.sigma)))), zabs: Math.max(...cs.flatMap((c) => c.lnZ.map((x) => Math.abs(x.diff)))), ok: cs.every((c) => c.ok) }; };
  const a0 = agg(), nT = cov.transit ? cov.transit.cv.ranks.length : 300;
  const zd = F.problems.map((P) => Math.abs(P.samplers.UltraNest.logZ - P.samplers.dynesty.logZ)), wd = Math.max(...F.problems.flatMap((P) => P.keys.map((_, i) => Math.abs(P.samplers.UltraNest.std[i] / P.samplers.dynesty.std[i] - 1))));
  ctx.glance.push({ href: 'fits', q: 'Does a fit agree with other samplers?', value: `${a0.mean.toFixed(2)} σ`, small: `means; widths within ${(100 * a0.width).toFixed(0)}%, ln Z within ${a0.zabs.toFixed(2)}`, ok: a0.ok, practice: 'Far smaller than the error bars.', others: `dynesty vs UltraNest: ${(100 * wd).toFixed(0)}% in width, ${Math.max(...zd).toFixed(2)} in ln Z` });
  ctx.glance.push({ href: 'fits-coverage', q: 'Are the error bars the right size?', value: `${(100 * cLo).toFixed(0)} to ${(100 * cHi).toFixed(0)}%`, small: 'stored run', ok: cLo > TOL.coverage68[0] && cHi < TOL.coverage68[1], practice: `Truth inside the 68% interval; 68 ± ${(100 * Math.sqrt(0.68 * 0.32 / nT)).toFixed(1)}% expected.`, others: 'not measured' });

  const keys = $('div', 'vkeys'); s.append(keys);
  const drawKeys = (a, live) => { keys.innerHTML = keyNumber(`${a.mean.toFixed(2)} σ`, 'and ' + (100 * a.width).toFixed(0) + '% in width', `Largest difference of a fitted value, and of its error bar, from dynesty or the exact answer.`, live)
    + keyNumber(`${(100 * cLo).toFixed(0)} to ${(100 * cHi).toFixed(0)}%`, 'coverage', `How often the truth is inside the 68% interval, ${nT} simulated data sets. Expected: 68 ± ${(100 * Math.sqrt(0.68 * 0.32 / nT)).toFixed(1)}%.`, false); };
  drawKeys(a0, false);

  // one chart: the hardest of the four problems
  const samplers = ['emcee', 'dynesty', 'UltraNest'];
  const intervals = (P, S) => { const ref = P.analytic || P.samplers.dynesty;
    const items = (i) => [{ label: ME, color: col.of('ESL'), m: S.mean[i], sd: S.std[i] }, ...(P.analytic ? [{ label: 'analytic', color: col.of('analytic'), m: P.analytic.mean[i], sd: P.analytic.std[i] }] : []), ...samplers.map((nm) => ({ label: nm, color: col.of(nm), m: P.samplers[nm].mean[i], sd: P.samplers[nm].std[i] }))].map((it) => ({ label: it.label, color: it.color, mean: (it.m - ref.mean[i]) / ref.std[i], std: it.sd / ref.std[i], text: `${sig(it.m, 6)} ± ${sig(it.sd, 3)}` }));
    return { rows: P.keys.map((k, i) => ({ label: LABEL[k] || k, items: items(i), truth: (P.truth[i] - ref.mean[i]) / ref.std[i] })) }; };
  const PD = F.problems[F.problems.length - 1];
  const lead = src[PD.id] ? chart(s, 'intervals', intervals(PD, src[PD.id].S), { title: `Problem ${PD.id}: ${PD.title.split(':')[0].toLowerCase()}, ${PD.keys.length} free parameters`, sub: 'Fitted value ± 1σ from each sampler, in units of dynesty’s error bar', height: 50 + 66 * PD.keys.length,
    label: `Posterior intervals for problem ${PD.id} from this code, emcee, dynesty and UltraNest: all overlap, and all contain the injected value within about one sigma.` }) : null;
  const row = $('div', 'vrow'); const btn = $('button', 'btn primary', 'Run the four fits in this browser'); btn.type = 'button'; const status = $('span', 'vnote', 'repeats the stored run shown above, in about 10 s'); status.setAttribute('role', 'status'); row.append(btn, status); s.append(row);

  const boxes = {}; let fill = null;
  const render = (P) => {
    const box = boxes[P.id]; if (!box || !src[P.id]) return; const { S, text } = src[P.id], cmp = cmps[P.id]; box.innerHTML = '';
    box.append($('h4', '', `${P.id} · ${esc(P.title)}`));
    box.append($('p', 'vnote', `${P.data.t.length} points. This code: ${esc(text)}; ${int(S.ncalls)} likelihood calls${S.elapsed ? ', ' + S.elapsed.toFixed(1) + ' s' : ''}. Compared with ${cmp.refName === 'analytic' ? 'the exact posterior (linear model, Gaussian noise)' : 'dynesty with 3000 live points'}. ${pill(cmp.okPost, cmp.okPost ? `means within ${TOL.fitMean}σ, widths within ${100 * TOL.fitWidth}%` : 'posterior outside tolerance')} ${pill(cmp.okZ, cmp.okZ ? 'ln Z consistent' : 'ln Z outside tolerance')}`));
    const g = $('div', 'vgrid2'); box.append(g);
    chart(g, 'intervals', intervals(P, S), { title: 'Posterior mean ± 1σ, per sampler', sub: 'in units of the reference width, centred on the reference mean', height: 50 + 66 * P.keys.length, label: `Posterior intervals from each sampler, problem ${P.id}` });
    const right = $('div'); g.append(right);
    right.append(table(['Parameter', 'Injected', 'This code', 'Reference', 'Δ mean [σ]', 'Δ width'], cmp.rows.map((r) => [L(LABEL[r.key] || r.key), sig(r.truth, 6), N(`${sig(r.mean, 6)} ± ${sig(r.std, 3)}`, 'esl'), `${sig(r.refMean, 6)} ± ${sig(r.refStd, 3)}`, signed(r.dMean, 3), signed(100 * r.dWidth, 1) + '%'])));
    const sd = E.seeds?.[P.id];
    right.append(table(['ln Z', 'Value', 'This code − it', 'In combined σ'], [[L(ME), N(`${S.logZ.toFixed(3)} ± ${S.logZerr.toFixed(3)}`, 'esl'), '', ''], ...cmp.lnZ.map((z) => [L(esc(z.name)), `${z.logZ.toFixed(3)}${z.logZerr ? ' ± ' + z.logZerr.toFixed(3) : ''}`, signed(z.diff, 3), signed(z.sigma, 2)]),
      ...(sd ? [[L(`${ME}, mean of 8 seeds (stored)`), `${sd.mean.toFixed(3)}, scatter ${sd.sd.toFixed(3)}`, '', L(`reported error ${(sd.logZerr.reduce((x, y) => x + y) / sd.logZerr.length).toFixed(3)}`)]] : [])]));
  };
  details(s, 'The four problems in full, with ln Z', (b) => {
    b.append($('p', '', `The other samplers (${code('emcee')}, ${code('dynesty')}, ${code('UltraNest')}) run on a Python re-implementation of this code’s likelihood whose model comes from different software (${code('exoplanet-core')}’s exact flux for the transits, ${code('radvel')} for the velocities), so agreement tests model, likelihood and sampler together. At the injected values and five other points per problem the two likelihoods differ by at most ${e1(wl)}.`));
    for (const P of F.problems) { boxes[P.id] = $('div'); b.append(boxes[P.id]); render(P); }
    const sm = E.seeds ? Math.max(...F.problems.map((P) => Math.abs(E.seeds[P.id].mean - (P.analytic ? P.analytic.logZ : P.samplers.dynesty.logZ)))) : null;
    b.append($('p', 'vnote', `The independent samplers do not agree with each other perfectly either: UltraNest’s and dynesty’s ln Z differ by ${Math.min(...zd).toFixed(2)} to ${Math.max(...zd).toFixed(2)} on these problems, and their widths by up to ${(100 * wd).toFixed(0)}%.` + (sm === null ? '' : ` Over eight seeds this code’s ln Z scatters by about its reported error and its mean is within ${sm.toFixed(2)} of the reference in all four problems.`)));
    fill = true;
  }, { id: 'fits-problems' });

  btn.onclick = async () => {
    btn.disabled = true;
    for (const P of F.problems) {
      status.textContent = `Fitting ${P.id} in this browser…`;
      const S = await C.runProblem(P, { nlive: 400, seed: 42 }, (pr) => { status.textContent = `Fitting ${P.id} in this browser… ${int(pr.ncalls || 0)} likelihood calls`; });
      src[P.id] = { S, text: 'run in this browser just now (400 live points, seed 42)' }; cmps[P.id] = C.compareFit(P, S); if (fill) render(P);
      const c = ctx.checks.find((q) => q.key === 'fit' + P.id); if (c) { c.ok = cmps[P.id].ok; c.detail = fitDetail(cmps[P.id]); c.live = true; }
    }
    const a = agg(); drawKeys(a, true); if (lead) lead.update(intervals(PD, src[PD.id].S));
    status.innerHTML = `Done in this browser: means within ${a.mean.toFixed(2)}σ, widths within ${(100 * a.width).toFixed(0)}%, ln Z within ${a.z.toFixed(1)}σ. ${pill(a.ok, a.ok ? 'all within tolerance' : 'see the details')}`; btn.disabled = false; btn.textContent = 'Run again'; onChange();
  };

  details(s, 'Coverage of the error bars', (b) => {
    b.append($('p', '', `For each of ${nT} trials, parameters are drawn from the prior, data are simulated with noise, this code fits them, and the position of the true value within the posterior is recorded. If the posteriors are right the histogram of positions is flat, and the truth lies inside the 68% interval in 68% of trials (±${(100 * Math.sqrt(0.68 * 0.32 / nT)).toFixed(1)}%) and inside the 95% interval in 95% (±1.3%). The data are simulated with this code’s own model, so this tests the sampler and the likelihood, not the model.`));
    const cg = $('div', 'vgrid2'); b.append(cg); const crow = [];
    for (const kind of Object.keys(cov)) {
      const { cv, sum } = cov[kind], CC = C.COVERAGE[kind];
      chart(cg, 'bars', { groups: ['0', '.1', '.2', '.3', '.4', '.5', '.6', '.7', '.8', '.9'], series: sum.map((q, i) => ({ label: LABEL[q.key] || q.key, color: TH.s[i], values: q.hist })), ref: { y: cv.ranks.length / 10, label: '' } },
        { title: CC.label, sub: `position of the truth in the posterior, ${cv.ranks.length} trials in 10 bins; flat would be ${cv.ranks.length / 10} each (dotted), ±5 by chance`, height: 200, label: 'Histogram of the posterior rank of the true value: roughly flat' });
      for (const q of sum) { const ok = q.c68 > TOL.coverage68[0] && q.c68 < TOL.coverage68[1]; crow.push([L(esc(CC.label)), L(LABEL[q.key] || q.key), N((100 * q.c68).toFixed(1) + '%', 'esl'), `<td>${pill(ok, ok ? 'consistent with 68%' : 'off')}</td>`, N((100 * q.c95).toFixed(1) + '%', 'esl'), q.n]); }
    }
    b.append(table(['Problem', 'Parameter', 'Truth inside the 68% interval', 'Check', 'Inside the 95% interval', 'Trials'], crow));
    const row2 = $('div', 'vrow'), b2 = $('button', 'btn', 'Repeat 20 trials of each in this browser'), st2 = $('span', 'vnote', `Stored: ${esc(E.coverage?.transit?.sampler || '')}; about ${int(E.coverage?.transit?.meanCalls)} and ${int(E.coverage?.rv?.meanCalls)} likelihood calls per fit.`); b2.type = 'button'; st2.setAttribute('role', 'status'); row2.append(b2, st2); b.append(row2);
    b2.onclick = async () => {
      b2.disabled = true; const out = [];
      for (const kind of Object.keys(C.COVERAGE)) { let dmax = 0; for (let i = 0; i < 20; i++) { st2.textContent = `${kind}: trial ${i + 1} of 20…`; const r = await C.coverageRun(kind, i); const st = E.coverage?.[kind]?.ranks[i]; if (st) r.rank.forEach((v, k) => (dmax = Math.max(dmax, Math.abs(v - st[k])))); await new Promise((q) => setTimeout(q, 0)); } out.push(`${kind}: largest difference in rank from the stored run ${dmax.toFixed(3)}`); }
      st2.textContent = 'Same 20 trials, this browser against the stored Node run. ' + out.join('; ') + '. (Identical seeds; small differences come from the last digit of the math library.)'; b2.disabled = false;
    };
  }, { id: 'fits-coverage' });

  inputs(s, 'Inputs', ['Problem', 'Data', 'Free parameters and uniform prior ranges', 'Fixed'], F.problems.map((P) => [L(`${P.id} · ${esc(P.title)}`), L(`${P.data.t.length} ${P.kind === 'lc' ? 'fluxes' : 'velocities'}`), L(P.keys.map((k, i) => `${LABEL[k] || k}: ${P.lo[i]} to ${P.hi[i]} (injected ${sig(P.truth[i], 5)})`).join('; ')), L(Object.entries(P.values).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(', ') : v}`).join(', '))]), 'fits.json');
  howRun(ctx, s, { script: 'tools/validation/make_fits.py', json: 'fits.json', mine: '<code>lnLCheck</code>, <code>runProblem</code>, <code>compareFit</code>, <code>coverageRun</code>', codes: ['emcee', 'dynesty', 'UltraNest', 'exoplanet-core', 'radvel'],
    extra: `This code’s stored fits, the eight-seed evidence runs and the ${2 * nT} coverage trials come from ${ctx.path('tools/validation/esl_reference.mjs')} (<a href="${vdata('esl.json')}" download>esl.json</a>; Node ${esc(E.node)}, ${esc(E.machine)}). The sampler follows UltraNest’s MLFriends region (${cite('buchner2016', 'buchner2019', 'buchner2021')}); the comparison samplers are described in ${cite('foremanmackey2013')} and ${cite('speagle2020')}. Settings: dynesty static with 3000 live points, ${esc(F.problems[0].samplers.dynesty.settings)}.` });
  void CODES;
}
