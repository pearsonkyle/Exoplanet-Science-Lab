// Text exports of a session (docs/FORMAT.md): a Python script that reproduces the analysis with the
// `exoplanet-science-lab` package (python/, import name `esl`), a Markdown report, and LaTeX tables.
// Pure functions of the session: no DOM, no I/O. The application offers the strings as downloads.
//
// The Python package runs this same JavaScript core (bundled by tools/build_core_bundle.mjs), so a script
// written here gives the numbers the browser gave. Measured between Node 22 (V8 12.4) and the package's default
// runtime (V8 14.4): the same number of likelihood calls and posterior medians equal to 1e-15 relative; the last
// digits differ because the engines' Math functions do. Another engine family may round differently enough to
// change the sampler's path, and then the agreement is within sampling noise.

import { PARAM_BY_KEY, STAR_PARAMS } from './model.js';

const REG = { ...PARAM_BY_KEY, ...Object.fromEntries(STAR_PARAMS.map((p) => [p.key, p])), K: { label: 'K', unit: 'm/s' } };
const SOFTWARE = 'Exoplanet Science Lab', SITE = 'https://exoplanet.science', PACKAGE = 'exoplanet-science-lab';

// ---- names and numbers -------------------------------------------------------------------------------------------

/** Label and unit of a parameter key ("per@c" -> "P (c)", "jit@rv2" -> "jitter (rv2)"), from the registry of model.js. */
export function describeKey(key, session) {
  const [base, sfx] = String(key).split('@'), p = REG[base];
  const ld = /^ld([0-3])$/.exec(base);
  let label = p ? p.label : base, unit = p ? p.unit || '' : '';
  if (ld) label = `LD ${Number(ld[1]) + 1}`;
  if (sfx) {
    const rv = /^rv(\d+)$/.exec(sfx), sets = (session && session.data && session.data.radial_velocity) || [];
    label += rv && sets[rv[1] - 1] ? ` (${sets[rv[1] - 1].name})` : base === 'a2' ? ` (epoch ${sfx})` : ` (${sfx})`;
  } else if (session && session.planets && session.planets.length > 1 && p && ['rprs', 'ars', 'inc', 'per', 'tmid', 'ecc', 'omega', 'mplanet', 'K'].includes(base)) label += ` (${session.planets[0].letter})`;
  return { label, unit };
}
const DERIVED = {
  K: ['K', 'm/s'], ars: ['a/R★', ''], aAU: ['a', 'au'], b: ['b', ''], t14: ['T14', 'd'], t23: ['T23', 'd'], emid: ['T eclipse', 'd'], e14: ['E14', 'd'], tperi: ['T periastron', 'd'],
  rpJup: ['Rp', 'R Jup'], rpEarth: ['Rp', 'R Earth'], depth: ['depth', ''], rhoStar: ['ρ★', 'g/cm³'], rhoPlanet: ['ρp', 'g/cm³'], teq: ['T eq', 'K'], insol: ['insolation', 'Earth = 1'], mplanet: ['Mp', 'M Jup'],
};
const DERIVED_SHOWN = ['K', 'mplanet', 'ars', 'aAU', 'b', 't14', 'emid', 'rpJup', 'teq', 'rhoStar'];
const describeDerived = (key) => { const [base, sfx] = key.split('@'), d = DERIVED[base] || [base, '']; return { label: d[0] + (sfx ? ` (${sfx})` : ''), unit: d[1] }; };

/** Decimals that show two significant digits of an uncertainty (0 to 10). */
const decimalsFor = (err) => (err > 0 && Number.isFinite(err) ? Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(err)))) : 6);
/** "111.436807 +0.000071 −0.000070" pieces for a value with asymmetric errors. */
export function formatValue(median, plus, minus) {
  if (!Number.isFinite(median)) return { value: '', plus: '', minus: '', decimals: 0 };
  const errs = [plus, minus].filter((x) => x > 0 && Number.isFinite(x)), d = errs.length ? decimalsFor(Math.min(...errs)) : 6;
  const f = (x) => (Number.isFinite(x) ? x.toFixed(d) : '');
  return { value: errs.length ? median.toFixed(d) : String(Number(median.toPrecision(8))), plus: f(plus), minus: f(minus), decimals: d };
}
const num = (x) => (Number.isFinite(x) ? String(Number(Number(x).toPrecision(10))) : '');
const priorText = (p) => (!p ? '' : p.type === 'normal' ? `Normal(${num(p.a)}, ${num(p.b)})` : p.type === 'uniform' ? `Uniform(${num(p.a)}, ${num(p.b)})` : `${p.type}(${num(p.a)}, ${num(p.b)})`);
const span = (a) => { let lo = Infinity, hi = -Infinity; for (const x of a || []) { if (x < lo) lo = x; if (x > hi) hi = x; } return [lo, hi]; };
const median = (a) => { const s = Array.from(a || []).filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

/** Rows describing the data of a session: [{ kind, name, n, from, to, medianErr, unit }]. */
export function dataSummary(session) {
  const d = session.data || {}, rows = [], L = d.light_curve;
  if (L && L.time && L.time.length) {
    const [t0, t1] = span(L.time), ne = L.epochs && L.epochs.length > 1 ? L.epochs.length : 1;
    rows.push({ kind: 'light curve', name: L.name || 'light curve', n: L.time.length, from: t0, to: t1, medianErr: median(L.flux_err), unit: 'relative flux', epochs: ne, exposure_min: L.exposure_min ?? null, airmass: !!L.airmass });
  }
  for (const r of d.radial_velocity || []) { const [t0, t1] = span(r.time); rows.push({ kind: 'radial velocity', name: r.name, n: r.time.length, from: t0, to: t1, medianErr: median(r.velocity_err), unit: 'm/s' }); }
  const tim = d.timing || [];
  for (const kind of ['transit', 'eclipse']) for (const pl of session.planets || []) {
    const rs = tim.filter((x) => (x.kind || 'transit') === kind && (x.planet || session.planets[0].letter) === pl.letter); if (!rs.length) continue;
    const [t0, t1] = span(rs.map((x) => x.time)); rows.push({ kind: `mid-${kind} times`, name: `planet ${pl.letter}`, n: rs.length, from: t0, to: t1, medianErr: median(rs.map((x) => x.err)), unit: 'd' });
  }
  return rows;
}

const softwareLine = (s) => { const w = s.software || {}; return `${SOFTWARE}${w.version ? ' ' + w.version : ''}${w.commit ? ' (' + String(w.commit).slice(0, 10) + ')' : ''}`; };
const used = (s) => { const u = { lc: true, rv: true, timing: true, ...((s.fit && s.fit.use) || {}) }, d = s.data || {}; return { lc: !!(u.lc && d.light_curve), rv: !!(u.rv && (d.radial_velocity || []).length), timing: !!(u.timing && (d.timing || []).length) }; };

// ---- Python ------------------------------------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/, PY_KEYWORDS = new Set(['from', 'import', 'class', 'def', 'lambda', 'global', 'pass', 'in', 'is', 'not', 'and', 'or', 'if', 'else', 'for', 'while', 'return', 'yield', 'del', 'try', 'with', 'as', 'None', 'True', 'False', 'async', 'await', 'raise', 'assert', 'break', 'continue', 'elif', 'except', 'finally', 'nonlocal']);
/** A Python literal for JSON-like data. */
export function pyLiteral(x, indent = '', width = 100) {
  if (x === null || x === undefined) return 'None';
  if (x === true) return 'True'; if (x === false) return 'False';
  if (typeof x === 'number') return Number.isFinite(x) ? (Number.isInteger(x) && Math.abs(x) < 1e15 ? String(x) : String(x).includes('e') || String(x).includes('.') ? String(x) : String(x) + '.0') : x !== x ? 'float("nan")' : x > 0 ? 'float("inf")' : 'float("-inf")';
  if (typeof x === 'string') return JSON.stringify(x);
  const inner = indent + '    ';
  if (Array.isArray(x) || ArrayBuffer.isView(x)) {
    const parts = Array.from(x, (v) => pyLiteral(v, inner, width)), one = '[' + parts.join(', ') + ']';
    return one.length + indent.length <= width || parts.every((p) => p.length < 26) ? one : '[\n' + parts.map((p) => inner + p).join(',\n') + ',\n' + indent + ']';
  }
  const parts = Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => JSON.stringify(k) + ': ' + pyLiteral(v, inner, width)), one = '{' + parts.join(', ') + '}';
  return one.length + indent.length <= width ? one : '{\n' + parts.map((p) => inner + p).join(',\n') + ',\n' + indent + '}';
}
/** `esl.Star(teff=5565, ...)`: a constructor call with keyword arguments; keys that are not identifiers go through **{...}. */
function pyCall(name, obj, indent = '', { raw = {}, multiline = false } = {}) {
  const kw = [], rest = {};
  for (const [k, v] of Object.entries(obj)) { if (v === undefined) continue; if (raw[k] !== undefined) kw.push(`${k}=${raw[k]}`); else if (IDENT.test(k) && !PY_KEYWORDS.has(k)) kw.push(`${k}=${pyLiteral(v, indent + '    ')}`); else rest[k] = v; }
  if (Object.keys(rest).length) kw.push('**' + pyLiteral(rest, indent + '    '));
  const one = `${name}(${kw.join(', ')})`;
  return !multiline && one.length + indent.length <= 110 ? one : `${name}(\n${kw.map((k) => indent + '    ' + k).join(',\n')},\n${indent})`;
}
const pyComment = (text, indent = '') => String(text).split('\n').map((l) => (indent + '# ' + l).trimEnd()).join('\n');
const wrap = (text, n = 96) => { const out = []; let line = ''; for (const w of String(text).split(/\s+/)) { if (line && (line + ' ' + w).length > n) { out.push(line); line = w; } else line = line ? line + ' ' + w : w; } if (line) out.push(line); return out.join('\n'); };

/**
 * A standalone, commented Python script that rebuilds the session with the package's classes (so every value,
 * prior and setting is a line that can be edited), runs it, compares with the result stored in the session
 * when there is one, and draws the figures.
 * opts: { embedData = true: the data arrays are written into the script; false: they are read from `sessionFile`,
 *         sessionFile = 'session.json', figures = true, prefix = file-name prefix of the figures }
 */
export function pythonScriptFor(session, opts = {}) {
  const s = session, embed = opts.embedData !== false, file = opts.sessionFile || 'session.json', figs = opts.figures !== false;
  const slug = opts.prefix || String(s.name || 'esl').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'esl';
  const d = s.data || {}, fit = s.fit || { free: [] }, u = used(s), res = s.result, many = (s.planets || []).length > 1;
  const L = [];
  const title = s.title || s.name || 'analysis';
  L.push('#!/usr/bin/env python3');
  L.push('"""');
  L.push(`${title}`);
  L.push('');
  L.push(wrap(`Written by ${softwareLine(s)} (${SITE})${s.created ? ' on ' + s.created : ''}. This script reproduces that analysis outside the browser. ` +
    'The Python package runs the same model, likelihood and nested sampler as the web page (the page\'s own JavaScript, bundled), so with the same seed it gives the same numbers, to rounding.'));
  L.push('');
  L.push(`    pip install ${PACKAGE}`);
  L.push(`    python ${slug}.py`);
  L.push('');
  L.push(wrap('Everything below is ordinary Python: change a value, a prior or the list of free parameters and run it again.'));
  if (s.notes) { L.push(''); L.push(wrap('Notes: ' + s.notes)); }
  L.push('"""');
  L.push('import json');
  L.push('import sys');
  if (!embed) L.push('from pathlib import Path');
  L.push('');
  L.push('import esl');
  L.push('');
  L.push(`MAKE_FIGURES = ${figs ? 'True' : 'False'}        # needs matplotlib`);
  L.push(`PREFIX = ${pyLiteral(slug)}`);
  L.push('');

  // -- data
  L.push('# ---- data ' + '-'.repeat(88));
  const rows = dataSummary(s);
  for (const r of rows) L.push(pyComment(`${r.kind} "${r.name}": ${r.n} points, ${num(r.from)} to ${num(r.to)}, median uncertainty ${Number(r.medianErr).toPrecision(3)} ${r.unit}`));
  if (!rows.length) L.push('# (no data in this session)');
  if (embed) L.push('# The numbers are at the bottom of this file (function _data), so the analysis reads first.');
  else L.push(`DATA = json.loads(Path(__file__).with_name(${pyLiteral(file)}).read_text())["data"]   # the session exported next to this script`);
  L.push('');

  // -- system
  L.push('# ---- the system ' + '-'.repeat(82));
  const lines = [];
  for (const k of ['name', 'title', 'notes', 'created']) if (s[k] !== undefined && s[k] !== null && s[k] !== '') lines.push(`${k}=${pyLiteral(s[k])}`);
  if (s.star) lines.push('star=' + pyCall('esl.Star', s.star, '    '));
  if (s.limb_darkening) lines.push('limb_darkening=' + pyCall('esl.LimbDarkening', s.limb_darkening, '    '));
  lines.push('planets=[\n' + (s.planets || []).map((p) => {
    const { letter, parameters, ...rest } = p;
    return '        ' + pyCall('esl.Planet', { letter, parameters, ...rest }, '        ', { raw: { parameters: 'dict(' + Object.entries(parameters || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${pyLiteral(v)}`).join(', ') + ')' } });
  }).join(',\n') + ',\n    ]');
  lines.push(`kepler=${pyLiteral(!!s.kepler)}`);
  lines.push(`time_reference=${pyLiteral(s.time_reference ?? 0)}`);
  lines.push('data=esl.Data.model_validate(DATA)');
  // -- fit
  const free = (fit.free || []).map((f) => {
    const { key, prior, label, unit, ...rest } = f, dk = describeKey(key, s);
    const pr = prior && (prior.type === 'uniform' || prior.type === 'normal') && Object.keys(prior).every((k) => ['type', 'a', 'b'].includes(k)) ? `esl.Prior.${prior.type}(${pyLiteral(prior.a)}, ${pyLiteral(prior.b)})` : pyCall('esl.Prior', prior || {}, '            ');
    const extra = Object.entries({ label, unit, ...rest }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `, ${k}=${pyLiteral(v)}`).join('');
    return `            esl.FreeParameter(key=${pyLiteral(key)}, prior=${pr}${extra}),` + `   # ${dk.label}${dk.unit ? ' [' + dk.unit + ']' : ''}`;
  });
  const { use, free: _f, fixed, timing_noise, sampler, ...fitRest } = fit;
  const fitKw = [];
  fitKw.push(`use=${pyCall('esl.Use', { lc: true, rv: true, timing: true, ...(use || {}) }, '        ')}`);
  fitKw.push('free=[\n' + free.join('\n') + (free.length ? '\n' : '') + '        ]');
  fitKw.push(`fixed=${pyLiteral(fixed || {}, '        ')}`);
  fitKw.push(`timing_noise=${pyLiteral(timing_noise || 0)}`);
  fitKw.push(`sampler=${pyCall('esl.Sampler', { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6, ...(sampler || {}) }, '        ')}`);
  if (Object.keys(fitRest).length) fitKw.push('**' + pyLiteral(fitRest, '        '));
  lines.push('fit=esl.FitSettings(\n' + fitKw.map((k) => '        ' + k).join(',\n') + ',\n    )');
  const known = new Set(['format', 'version', 'software', 'created', 'name', 'title', 'notes', 'star', 'limb_darkening', 'planets', 'kepler', 'time_reference', 'data', 'fit', 'result']);
  const extraTop = Object.fromEntries(Object.entries(s).filter(([k]) => !known.has(k)));
  if (Object.keys(extraTop).length) lines.push('**' + pyLiteral(extraTop, '    '));
  L.push('def build_session(DATA):');
  L.push('    """The analysis as the browser had it: system, data, what is free with which prior, sampler settings."""');
  L.push('    return esl.Session(');
  for (const l of lines) L.push('        ' + l.split('\n').join('\n    ') + ',');
  L.push('    )');
  L.push('');

  // -- stored result
  if (res && Array.isArray(res.parameters)) {
    L.push('# ---- the result the browser stored, to compare with ' + '-'.repeat(46));
    L.push('BROWSER = {');
    L.push(`    "logZ": ${pyLiteral(res.logZ)}, "logZerr": ${pyLiteral(res.logZerr)}, "chi2": ${pyLiteral(res.chi2)}, "ncalls": ${pyLiteral(res.ncalls)},`);
    L.push('    "parameters": {');
    for (const p of res.parameters) L.push(`        ${pyLiteral(p.key)}: (${pyLiteral(p.median)}, ${pyLiteral(p.plus)}, ${pyLiteral(p.minus)}),`);
    L.push('    },');
    L.push('}');
  } else L.push('BROWSER = None   # the session was exported before a fit was run');
  L.push('');
  L.push('');
  L.push('def main():');
  L.push('    session = build_session(_data())');
  L.push('    print(session.summary())');
  L.push('    print(f"running on {esl.runtime_info()}")');
  L.push('');
  if (!(fit.free || []).length) {
    L.push('    # Nothing is free in this session: evaluate the model as it stands.');
    L.push('    model = session.evaluate()');
    L.push('    print(f"chi2 = {model.chi2:.2f} for {model.n_data} measurements")');
    L.push('    fit = session');
  } else {
    L.push('    # The nested sampler runs inside the bundled JavaScript core; progress is printed as it goes.');
    L.push('    fit = session.run(progress=True)');
    L.push('    result = fit.result');
    L.push('    print()');
    L.push('    print(result.table())');
    L.push('    for w in result.warnings:');
    L.push('        print("warning:", w)');
    L.push('');
    L.push('    if BROWSER:');
    L.push('        # Same code, same seed: the two agree to rounding (about 1e-15) between V8 engines (Chrome, Node, this');
    L.push('        # package by default), and within the sampling noise otherwise. A difference above 1 sigma deserves a look.');
    L.push('        print()');
    L.push('        print(f"{\'parameter\':<14}{\'browser\':>20}{\'python\':>20}{\'difference / sigma\':>22}")');
    L.push('        worst = 0.0');
    L.push('        for p in result.parameters:');
    L.push('            if p.key not in BROWSER["parameters"]:');
    L.push('                continue');
    L.push('            med, plus, minus = BROWSER["parameters"][p.key]');
    L.push('            sigma = max(0.5 * (plus + minus), 0.5 * (p.plus + p.minus), 1e-300)');
    L.push('            pull = (p.median - med) / sigma');
    L.push('            worst = max(worst, abs(pull))');
    L.push('            print(f"{p.key:<14}{med:>20.10g}{p.median:>20.10g}{pull:>22.3f}")');
    L.push('        print(f"ln Z: browser {BROWSER[\'logZ\']:.3f}, python {result.logZ:.3f} +- {result.logZerr:.3f}")');
    L.push('        if worst > 1.0:');
    L.push('            print("NOTE: python and the browser differ by more than 1 sigma in at least one parameter")');
  }
  L.push('');
  L.push('    fit.save(PREFIX + "_result.json")          # the session with its result: opens in the browser again');
  L.push('    with open(PREFIX + "_report.md", "w") as f:');
  L.push('        f.write(fit.to_markdown())');
  L.push('');
  L.push('    if MAKE_FIGURES:');
  L.push('        import matplotlib');
  L.push('        matplotlib.use("Agg")');
  L.push('        from esl import plot');
  if (u.lc) L.push(`        plot.light_curve(fit${many ? ', fold=True' : ''}).savefig(PREFIX + "_light_curve.png", dpi=150)`);
  if (u.rv) { L.push('        plot.radial_velocity(fit).savefig(PREFIX + "_rv.png", dpi=150)'); L.push('        plot.radial_velocity(fit, fold=True).savefig(PREFIX + "_rv_phase.png", dpi=150)'); }
  if ((d.timing || []).length) L.push('        plot.oc(fit).savefig(PREFIX + "_oc.png", dpi=150)');
  if ((fit.free || []).length) L.push('        plot.corner(fit).savefig(PREFIX + "_posterior.png", dpi=150)');
  L.push('    return fit');
  L.push('');
  L.push('');
  L.push('def _data():');
  if (embed) {
    L.push('    """The measurements, exactly as the browser exported them (absolute times)."""');
    L.push('    return json.loads(r"""');
    L.push(JSON.stringify(d).replace(/"""/g, '\\"\\"\\"'));
    L.push('""")');
  } else {
    L.push('    return DATA');
  }
  L.push('');
  L.push('');
  L.push('if __name__ == "__main__":');
  L.push('    main()');
  L.push('    sys.exit(0)');
  L.push('');
  return L.join('\n');
}

// ---- Markdown ----------------------------------------------------------------------------------------------------

const mdTable = (head, rows) => ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |')].join('\n');
const pm = (q) => { const f = formatValue(q.median, q.plus, q.minus); return f.plus === f.minus ? `${f.value} ± ${f.plus}` : `${f.value} +${f.plus} −${f.minus}`; };

/**
 * A Markdown report: system, data, priors, sampler, results (fitted and derived parameters), warnings,
 * software version and how to reproduce the analysis with the Python package.
 * opts: { sessionFile = 'session.json' } named in the reproduction recipe.
 */
export function markdownReportFor(session, opts = {}) {
  const s = session, d = s.data || {}, fit = s.fit || { free: [] }, res = s.result, file = opts.sessionFile || 'session.json', out = [];
  out.push(`# ${s.title || s.name || 'Analysis'}`, '');
  out.push(`${softwareLine(s)}${s.created ? ' · ' + s.created : ''} · session format ${s.format || 'esl-session'} v${s.version ?? 1}`, '');
  if (s.notes) out.push(s.notes, '');

  out.push('## System', '');
  const st = s.star || {}, starRows = [['T eff', 'teff', 'K'], ['log g', 'logg', 'cgs'], ['[Fe/H]', 'feh', 'dex'], ['R★', 'rstar', 'R☉'], ['M★', 'mstar', 'M☉']].filter(([, k]) => Number.isFinite(st[k])).map(([lab, k, unit]) => [lab, num(st[k]) + (Number.isFinite(st[k + 'Err']) ? ' ± ' + num(st[k + 'Err']) : ''), unit]);
  if (starRows.length) out.push(`**${s.name || 'Star'}**`, '', mdTable(['Star', 'Value', 'Unit'], starRows), '');
  const ld = s.limb_darkening;
  if (ld) out.push(`Limb darkening: ${ld.law} law, ${ld.mode === 'star' ? 'following the star (T eff' + (Number.isFinite(st.feh) ? ', [Fe/H]' : '') + ')' : 'coefficients ' + (ld.coefficients || []).map(num).join(', ')}${ld.band ? `, band ${ld.band === 'Custom range' && ld.band_custom ? ld.band_custom.join('–') + ' nm' : ld.band}` : ''}.`, '');
  const fields = [...new Set((s.planets || []).flatMap((p) => Object.keys(p.parameters || {}).filter((k) => p.parameters[k] !== null)))].filter((f) => !(s.kepler && f === 'ars'));
  if (fields.length) out.push(mdTable(['Planet', ...fields.map((f) => { const k = describeKey(f); return k.label.replace(/ \(.*\)$/, '') + (k.unit ? ` [${k.unit}]` : ''); })], (s.planets || []).map((p) => [p.letter, ...fields.map((f) => num((p.parameters || {})[f]))])), '');
  if (s.kepler) out.push('a/R★ follows from Kepler\'s third law (M★, R★, P and the planet mass), so photometry, velocities and timing describe one orbit.', '');

  out.push('## Data', '');
  const rows = dataSummary(s), u = used(s), inFit = (kind) => (kind === 'light curve' ? u.lc : kind === 'radial velocity' ? u.rv : u.timing);
  if (rows.length) out.push(mdTable(['Kind', 'Name', 'Points', 'From', 'To', 'Median uncertainty', 'In the fit'], rows.map((r) => [r.kind + (r.epochs > 1 ? ` (${r.epochs} epochs)` : ''), r.name, r.n, num(r.from), num(r.to), `${Number(r.medianErr).toPrecision(3)} ${r.unit}`, inFit(r.kind) ? 'yes' : 'no'])), '');
  else out.push('No data.', '');
  if (d.light_curve && d.light_curve.exposure_min > 0) out.push(`Light-curve exposure ${num(d.light_curve.exposure_min)} min; the model is averaged over it where ingress needs it.`, '');
  out.push(`Times are as given in the data (no conversion between time systems); inside the fit they are measured from ${num(s.time_reference ?? 0)}.`, '');

  out.push('## Fit set-up', '');
  if ((fit.free || []).length) out.push(mdTable(['Free parameter', 'Key', 'Unit', 'Prior'], fit.free.map((f) => { const k = describeKey(f.key, s); return [f.label || k.label, '`' + f.key + '`', f.unit || k.unit, priorText(f.prior)]; })), '');
  else out.push('Nothing is free.', '');
  const fixed = Object.entries(fit.fixed || {});
  if (fixed.length) out.push('Held fixed besides the system values above: ' + fixed.map(([k, v]) => `\`${k}\` = ${num(v)}`).join(', ') + '.', '');
  if (fit.timing_noise > 0) out.push(`Timing noise added in quadrature: ${num(fit.timing_noise)} d.`, '');
  const sm = { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1e6, ...(fit.sampler || {}) };
  out.push(`Sampler: nested sampling (MLFriends regions with a slice-sampling fallback), ${sm.nlive} live points, stop when the live points hold less than ${num(sm.fracRemain)} of the evidence, seed ${sm.seed}, budget ${num(sm.maxCalls)} likelihood calls${sm.maxSeconds ? ` or ${num(sm.maxSeconds)} s` : ''}.`,
    'The light-curve normalisation of each epoch and the zero point of each velocity dataset are integrated out analytically; the likelihood includes the ln σ terms, so ln Z is a normalised evidence.', '');

  out.push('## Result', '');
  if (!res) out.push('The session holds no result: it was exported before a fit was run.', '');
  else {
    out.push(`${res.converged ? 'Converged' : `**Not converged** (${res.stop_reason})`} after ${res.ncalls} likelihood calls${Number.isFinite(res.seconds) ? ` in ${res.seconds.toFixed(1)} s` : ''}. ` +
      `ln Z = ${Number(res.logZ).toFixed(2)} ± ${Number(res.logZerr).toFixed(2)}, information ${Number(res.information).toFixed(1)} nat, effective sample size ${Math.round(res.ess)}.`, '');
    if (Number.isFinite(res.chi2)) { const c = res.chi2_parts || {}; out.push(`χ² = ${res.chi2.toFixed(2)} for ${res.n_data} measurements` + (c ? ` (light curve ${Number(c.light_curve || 0).toFixed(2)}, velocities ${Number(c.radial_velocity || 0).toFixed(2)}, timing ${Number(c.timing || 0).toFixed(2)})` : '') + (Number.isFinite(res.bic) ? `; BIC ${res.bic.toFixed(1)}` : '') + '.', ''); }
    out.push(mdTable(['Parameter', 'Key', 'Median and 68% interval', 'Best fit', 'Unit'], (res.parameters || []).map((p) => { const k = describeKey(p.key, s); return [p.label || k.label, '`' + p.key + '`', pm(p), formatValue(p.best, p.plus, p.minus).value, p.unit || k.unit]; })), '');
    const der = Object.entries(res.derived || {}).filter(([k, q]) => q && DERIVED_SHOWN.includes(k.split('@')[0]) && !(res.parameters || []).some((p) => p.key === k));
    if (der.length) out.push('Derived (from 600 posterior draws; M★ and R★ as given unless fitted):', '', mdTable(['Quantity', 'Key', 'Median and 68% interval', 'Unit'], der.map(([k, q]) => { const dd = describeDerived(k); return [dd.label, '`' + k + '`', q.plus > 0 || q.minus > 0 ? pm(q) : String(Number(Number(q.median).toPrecision(7))), dd.unit]; })), '');
    if ((res.rv_zero_points || []).length) out.push(mdTable(['Velocity dataset', 'Zero point [m/s]', 'Jitter [m/s]'], res.rv_zero_points.map((z) => [z.name, Number(z.gamma).toFixed(2), Number(z.jitter || 0).toFixed(2)])), '');
    if ((res.warnings || []).length) out.push('Warnings from the sampler:', '', ...res.warnings.map((w) => '- ' + w), '');
  }

  out.push('## How to reproduce', '');
  out.push(`In the browser: open ${SITE}/analyze/ and load the exported session (\`${file}\`). In Python, with the same model, likelihood and sampler:`, '');
  out.push('```', `pip install ${PACKAGE}`, '```', '', '```python', 'import esl', '', `session = esl.Session.load(${JSON.stringify(file)})`, 'fit = session.run(progress=True)', 'print(fit.result.table())', '```', '');
  out.push('The Python package executes the JavaScript core of the web application (bundled, unmodified), so the numbers are those of the browser. With the same seed the sampler takes the same path: results agree to rounding (parts in 1e15, from the engines\' own math functions) between V8 builds such as Chrome, Node and the package\'s default runtime, and within sampling noise in the rare case that a rounding difference changes the path.', '');
  return out.join('\n');
}

// ---- LaTeX -------------------------------------------------------------------------------------------------------

const TEX = { rprs: '$R_p/R_\\star$', ars: '$a/R_\\star$', inc: '$i$', per: '$P$', tmid: '$T_{\\rm mid}$', ecc: '$e$', omega: '$\\omega$', mplanet: '$M_p$', K: '$K$', a2: 'airmass $k$', rvlin: '$\\dot{\\gamma}$', rvquad: '$\\ddot{\\gamma}$', jit: '$\\sigma_{\\rm jit}$',
  mstar: '$M_\\star$', rstar: '$R_\\star$', teff: '$T_{\\rm eff}$', feh: '[Fe/H]', aAU: '$a$', b: '$b$', t14: '$T_{14}$', emid: '$T_{\\rm ecl}$', rpJup: '$R_p$', teq: '$T_{\\rm eq}$', rhoStar: '$\\rho_\\star$' };
const TEX_UNIT = { '°': 'deg', 'M Jup': '$M_{\\rm Jup}$', 'R Jup': '$R_{\\rm Jup}$', 'M☉': '$M_\\odot$', 'R☉': '$R_\\odot$', 'm/s/d': 'm\\,s$^{-1}$\\,d$^{-1}$', 'm/s/d²': 'm\\,s$^{-1}$\\,d$^{-2}$', 'm/s': 'm\\,s$^{-1}$', 'g/cm³': 'g\\,cm$^{-3}$' };
const texEsc = (t) => String(t).replace(/([%&_#])/g, '\\$1');
const texKey = (key, s) => { const [base, sfx] = key.split('@'), ld = /^ld([0-3])$/.exec(base), t = ld ? `$u_${Number(ld[1]) + 1}$` : TEX[base] || texEsc(base); const rv = sfx && /^rv(\d+)$/.exec(sfx), sets = (s.data && s.data.radial_velocity) || []; return sfx ? `${t} (${texEsc(rv && sets[rv[1] - 1] ? sets[rv[1] - 1].name : sfx)})` : t; };
const texPM = (q) => { const f = formatValue(q.median, q.plus, q.minus); return !f.plus ? `$${f.value}$` : f.plus === f.minus ? `$${f.value} \\pm ${f.plus}$` : `$${f.value}^{+${f.plus}}_{-${f.minus}}$`; };

/** Two LaTeX tables (plain `table` / `tabular`): fitted and derived parameters, and the priors. Returns one string. */
export function latexTablesFor(session) {
  const s = session, res = s.result, fit = s.fit || { free: [] }, out = [];
  const unit = (u) => TEX_UNIT[u] || texEsc(u || '');
  out.push(`% ${softwareLine(s)}${s.created ? ', ' + s.created : ''}`);
  if (res) {
    out.push('\\begin{table}', '\\centering', `\\caption{Fitted and derived parameters of ${texEsc(s.name || 'the system')}: posterior medians and 68\\% intervals.}`, '\\begin{tabular}{llc}', '\\hline', 'Parameter & Unit & Value \\\\', '\\hline');
    for (const p of res.parameters || []) out.push(`${texKey(p.key, s)} & ${unit(p.unit || describeKey(p.key, s).unit)} & ${texPM(p)} \\\\`);
    const der = Object.entries(res.derived || {}).filter(([k, q]) => q && DERIVED_SHOWN.includes(k.split('@')[0]) && !(res.parameters || []).some((p) => p.key === k));
    if (der.length) out.push('\\hline', '\\multicolumn{3}{l}{Derived} \\\\');
    for (const [k, q] of der) out.push(`${texKey(k, s)} & ${unit(describeDerived(k).unit)} & ${texPM(q)} \\\\`);
    out.push('\\hline', `\\multicolumn{3}{l}{$\\ln Z = ${Number(res.logZ).toFixed(2)} \\pm ${Number(res.logZerr).toFixed(2)}$` + (Number.isFinite(res.chi2) ? `, $\\chi^2 = ${res.chi2.toFixed(1)}$ for ${res.n_data} measurements` : '') + '} \\\\', '\\hline', '\\end{tabular}', '\\end{table}', '');
  }
  out.push('\\begin{table}', '\\centering', '\\caption{Priors. $\\mathcal{U}(a, b)$ is uniform between $a$ and $b$; $\\mathcal{N}(\\mu, \\sigma)$ is normal.}', '\\begin{tabular}{llc}', '\\hline', 'Parameter & Unit & Prior \\\\', '\\hline');
  for (const f of fit.free || []) out.push(`${texKey(f.key, s)} & ${unit(f.unit || describeKey(f.key, s).unit)} & $\\mathcal{${f.prior.type === 'normal' ? 'N' : 'U'}}(${num(f.prior.a)}, ${num(f.prior.b)})$ \\\\`);
  out.push('\\hline', '\\end{tabular}', '\\end{table}', '');
  return out.join('\n');
}
