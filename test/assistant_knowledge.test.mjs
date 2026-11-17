// The assistant's reading of the Methods and the code (src/assistant/knowledge.js), its residual periodogram
// (src/assistant/ops.js residualPeriodogramOf) and the chat's math rendering (src/assistant/mathtext.js).
import { readFileSync } from 'node:fs';
import * as C from '../src/methods/content.js';
import { explainMethod, extractSymbol, SOURCE_FILE } from '../src/assistant/knowledge.js';
import { residualPeriodogramOf } from '../src/assistant/ops.js';
import { buildProblem } from '../src/core/model.js';
import { specFromSession } from '../src/core/session.js';
import { mathSegments } from '../src/assistant/mathtext.js';
import { texToMathML } from '../src/methods/tex.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// ---- Methods lookup: questions a user asks land on the section that implements the answer
const cases = [
  ['how is the equilibrium temperature calculated', 'derived'],
  ['how is the radial velocity semi-amplitude computed', 'rv'],
  ['how does the transit model integrate the limb-darkened flux', 'transit'],
  ['what sampler is used and how is the evidence estimated', 'sampler'],
  ['how are mid-transit times and the ephemeris fitted', 'timing'],
  ['how are comparison stars ranked in the photometry', 'imexam'],
  ['how is the photometry aperture and annulus search done', 'photometry'],
];
for (const [q, want] of cases) { const r = explainMethod(C, { query: q }); check(`methods lookup: "${q}"`, r.section === want || (r.more || []).slice(0, 1).some((m) => m.id === want), `got ${r.section}`); }
const rv = explainMethod(C, { topic: 'rv' });
check('methods section by id keeps the LaTeX of its equations', rv.found && /\$\$/.test(rv.text) && /K =|K=/.test(rv.text.replace(/\s+/g, ' ')) && rv.code.length > 0, `${rv.text.length} chars, code ${rv.code.join(', ')}`);
check('methods lookup without a topic lists every section', explainMethod(C, {}).sections.length === C.SECTIONS.length);
check('every code file a Methods section names may be read by read_source', C.SECTIONS.flatMap((s) => s.code || []).filter((f) => /\.(m?js|py)$/.test(f)).every((f) => SOURCE_FILE.test(f)));

// ---- reading a function from the source
const rvSrc = readFileSync(new URL('../src/core/rv.js', import.meta.url), 'utf8');
const k = extractSymbol(rvSrc, 'semiAmplitude');
check('extractSymbol: one whole function with its comment', /^\/\*\* Semi-amplitude/.test(k.text) && /\n}$/.test(k.text) && !/function massFromK/.test(k.text), `line ${k.line}, ${k.text.split('\n').length} lines`);
const m = extractSymbol(readFileSync(new URL('../src/core/model.js', import.meta.url), 'utf8'), 'buildProblem');
let depth = 0; for (const c of m.text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*/g, '')) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
check('extractSymbol: a long function ends at its own closing brace (or is cut)', /…\(cut\)$/.test(m.text) || depth === 0, `${m.text.length} chars`);
check('extractSymbol: an unknown name lists what the file defines', extractSymbol(rvSrc, 'nope').symbols.includes('makeRV'));
check('read_source refuses files outside the site code', ['../.env', 'src/../../x.js', '/etc/passwd', 'src/core/x.json', '.env'].every((f) => !SOURCE_FILE.test(f)) && SOURCE_FILE.test('src/core/transit.js') && SOURCE_FILE.test('python/esl/functions.py'));

// ---- residual periodogram: a second planet hidden in the velocities of a one-planet model
{
  const doc = JSON.parse(readFileSync(new URL('../public/examples/results/hd80606-rv.json', import.meta.url), 'utf8'));
  doc.result = null;
  const det = buildProblem({ ...specFromSession(doc), free: [] }).detail([]);
  let u = 11; const rnd = () => { u = (u * 16807) % 2147483647; return u / 2147483647; }, gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const P2 = 17.3, K2 = 25;
  doc.data.radial_velocity = doc.data.radial_velocity.map((d, j) => {
    const tr = doc.time_reference || 0, X = det.rv[j];
    const vel = d.time.map((t, i) => X.gamma + X.model[i] + K2 * Math.sin(2 * Math.PI * (t - tr) / P2) + d.velocity_err[i] * gauss());
    return { ...d, velocity: vel };
  });
  const r = residualPeriodogramOf(doc, {});
  const top = r.peaks[0];
  check('residual periodogram finds an injected 17.3-day signal', Math.abs(top.period_days - P2) < 0.05 && top.false_alarm_probability < 1e-6 && /candidate signal/.test(r.verdict), `${top.period_days} d, FAP ${top.false_alarm_probability}, chi2/N ${r.chi2_per_point}`);
  // the same data without the injected planet: no significant peak
  doc.data.radial_velocity = doc.data.radial_velocity.map((d, j) => ({ ...d, velocity: d.time.map((t, i) => det.rv[j].gamma + det.rv[j].model[i] + d.velocity_err[i] * gauss()) }));
  const r0 = residualPeriodogramOf(doc, {});
  check('residual periodogram: white noise alone gives no signal', r0.peaks[0].false_alarm_probability > 0.01 && /No significant/.test(r0.verdict), `best ${r0.peaks[0].period_days} d, FAP ${r0.peaks[0].false_alarm_probability}`);
  // the known planet itself is recognised, not reported as new: velocities fitted with a model that lacks it
  const flat = JSON.parse(JSON.stringify(doc)); flat.planets[0].parameters.mplanet = 1e-6; flat.fit.free = []; flat.fit.fixed = flat.fit.fixed || {};
  try { const rk = residualPeriodogramOf(flat, {}); check('residual periodogram names a peak at a known planet\'s period', rk.peaks.some((p) => /planet b/.test(p.note || '')), rk.peaks.slice(0, 3).map((p) => `${p.period_days} ${p.note || ''}`).join('; ')); }
  catch (err) { check('residual periodogram names a peak at a known planet\'s period', false, err.message); }
}
{
  const doc = JSON.parse(readFileSync(new URL('../public/examples/results/hd80606-rv.json', import.meta.url), 'utf8'));
  const r = residualPeriodogramOf(doc, {});
  check('residual periodogram warns when the residuals exceed their errors (missing jitter)', r.chi2_per_point > 2 && /cannot be called a signal|Caution/.test(r.verdict) && /jit@rv1/.test(r.verdict), `chi2/N ${r.chi2_per_point}`);
}

// ---- math in chat messages: the segments the panel renders
const seg = mathSegments('Kepler: $P^2 = a^3$ and $$T_{eq} = T_\\star \\sqrt{R_\\star / 2a}$$ costs $5, not $10.');
check('math: inline and display TeX found', seg.filter((s) => s.math).length === 2 && seg.find((s) => s.display).tex.startsWith('T_{eq}'), JSON.stringify(seg.map((s) => s.math ? (s.display ? 'D' : 'I') : 'T')));
check('math: dollar amounts are not math', mathSegments('It costs $5 and $10 dollars.').every((s) => !s.math));
check('math: \\( \\) and \\[ \\] delimiters', mathSegments('a \\(x^2\\) b \\[y = 1\\] c').filter((s) => s.math).length === 2);
check('math: code spans are left alone', mathSegments('use `$x$` here').every((s) => !s.math));
// \left( ... \right)^{1/3}: one group, so both fences stretch to the fraction and the exponent applies to the whole bracket
const lr = texToMathML('K = \\left(\\frac{2\\pi G}{P}\\right)^{1/3}');
check('math: \\left ... \\right is one group and a script after it applies to all of it', /<msup><mrow><mo fence="true" stretchy="true">\(<\/mo><mfrac>.*<\/mfrac><mo fence="true" stretchy="true">\)<\/mo><\/mrow><mrow><mn>1<\/mn>/.test(lr) &&
  /<mrow><mo fence="true" stretchy="true">\|<\/mo><mi>x<\/mi><\/mrow>/.test(texToMathML('\\left| x \\right.')), lr.length + ' chars');

process.exit(ok ? 0 : 1);
