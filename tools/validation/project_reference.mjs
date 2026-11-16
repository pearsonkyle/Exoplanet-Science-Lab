// The project's other numerical tests, stored for section 5 of the Validation page:
//   node tools/validation/project_reference.mjs            every topic of src/validation/topics.js (about 4 minutes; the tests run in parallel)
//   node tools/validation/project_reference.mjs sky exotic only these topics (the rest of project.json is kept)
// Writes public/validation/project.json:
//   tests    { 'test/x.test.mjs': { exit, seconds, checks: [{ ok, name, info, more }], tail } }   the printed output, line by line
//   plots    { <topic id>: a chart spec for src/validation/plot.js }                                built from that output and the stored references
//   scripts  the generator scripts mirrored into public/validation/scripts/ so the deployed page can link to them
// and copies those scripts and validation/README.md. test/validation.test.mjs asserts the copies are identical to the
// originals and that every number quoted in topics.js is in the stored output.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { TOPICS, topicTests } from '../../src/validation/topics.js';

const root = new URL('../../', import.meta.url), P = (p) => fileURLToPath(new URL(p, root));
const outPath = P('public/validation/project.json');
let prev = { tests: {}, plots: {} }; try { prev = JSON.parse(readFileSync(outPath)); } catch { /* first run */ }
const only = process.argv.slice(2), topics = TOPICS.filter((t) => t.status === 'done' && (!only.length || only.includes(t.id)));
const files = only.length ? [...new Set(topics.flatMap((t) => t.tests))] : topicTests();
const envOf = (f) => Object.assign({}, ...TOPICS.filter((t) => t.env && t.tests.includes(f)).map((t) => t.env));

/** Run one test file and turn its output into checks. Indented lines after a check belong to it (`more`). */
function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now(), ch = spawn(process.execPath, [P(file)], { env: { ...process.env, ...envOf(file) } }); let out = '';
    ch.stdout.on('data', (d) => (out += d)); ch.stderr.on('data', () => {});
    ch.on('close', (code) => {
      const checks = [], lines = out.split('\n'); let cur = null;
      for (const line of lines) {
        const m = /^(ok\*?|FAIL|SILENT)\s+(.*?)(?:\s{3,}(.*))?$/.exec(line) || /^(PASS|FAIL):?\s+(.*?)(?:\s{3,}(.*))?$/.exec(line);
        if (m) { cur = { ok: m[1] === 'ok' || m[1] === 'ok*' || m[1] === 'PASS', silent: m[1] === 'SILENT' || undefined, name: m[2].trim(), info: (m[3] || '').trim().slice(0, 600), more: [] }; checks.push(cur); }
        else if (cur && /^\s{2,}\S/.test(line) && cur.more.length < 5) cur.more.push(line.trim().slice(0, 260));
        else if (!/^\s/.test(line)) cur = null;
      }
      const tail = checks.length ? [] : lines.map((l) => l.trim()).filter((l) => l && l.length < 200 && (/error|models\/s|max diff|max abs|residual|lnZ=/i.test(l))).slice(-8);
      console.log(`${file}  exit ${code}  ${checks.length} checks, ${checks.filter((c) => !c.ok).length} not ok  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      resolve([file, { exit: code, seconds: Math.round((Date.now() - t0) / 100) / 10, env: envOf(file), checks, tail, stdout: out }]);
    });
  });
}

const results = Object.fromEntries(await Promise.all(files.map(run)));
const J = (p) => JSON.parse(readFileSync(P(p)));
const num = (s) => Number(String(s).replace('−', '-'));
const find = (file, re) => (results[file] || prev.tests[file]).checks.filter((c) => re.test(c.name));

// ---- one chart per topic, from the printed numbers and the stored references ----------------------------------------
const C = { esl: 'var:esl', a: 'var:s1', b: 'var:s2', c: 'var:s3', d: 'var:s4', dim: 'var:truth' };   // resolved to theme colours by the page
const builders = {
  exotic() {
    // lines "   rprs: ESL 0.0203298 ± 0.000363 | EXOTIC 0.0203305 ± 0.000355 | truth 0.02": three of the single-transit fit, then four of the five-night fit
    const re = /^\s+([\w/★]+): ESL (\S+) ± (\S+) \| EXOTIC (\S+) ± (\S+) \| truth (\S+)/gm, rows = [], lab = { rprs: 'Rp/R★', tmid: 'T mid', inc: 'inclination', per: 'period' }; let m, i = 0;
    while ((m = re.exec(results['test/exotic.test.mjs'].stdout))) {
      const [, k, a, sa, b, sb, t] = m, me = num(b), se = num(sb);
      rows.push({ label: `${lab[k] || k}, ${i < 3 ? '1 night' : '5 nights'}`, truth: (num(t) - me) / se,
        items: [{ label: 'this code', color: C.esl, mean: (num(a) - me) / se, std: num(sa) / se, text: `${a} ± ${sa}` }, { label: 'EXOTIC', color: C.a, mean: 0, std: 1, text: `${b} ± ${sb}` }] });
      i++;
    }
    return rows.length ? { rows, lim: 2.6 } : null;
  },
  sampler() {
    // a readable selection of the suite: one row per kind of difficulty (d = number of parameters), where both an exact value and an UltraNest run exist
    const un = J('test/stress_ultranest.json'), pick = { 'a-gauss-d2-r0.99': 'Gaussian 2-d, ρ 0.99', 'a-gauss-d10-r0.99': 'Gaussian 10-d, ρ 0.99', 'a-gauss-d15-r0.99': 'Gaussian 15-d, ρ 0.99', 'a-gauss-d10-r0.999': 'Gaussian 10-d, ρ 0.999', 'b-banana-2d-thin': 'thin banana, 2-d', 'b-banana-5d': 'banana, 5-d', 'c-transit-b0.5-1000ppm-ars+inc': 'transit, a/R★ + i', 'd-aliases': 'period aliases', 'd-twomodes-8d': 'two peaks, 8-d', 'e-narrow-8d-H63': 'narrow peak, 8-d', 'f-plateau': 'plateau + peak', 'g-funnel-4d': 'funnel, 4-d', 'g-funnel-10d': 'funnel, 10-d', 'g-jitter-log': 'RV with jitter' };
    const rows = [];
    for (const c of results['test/stress.test.mjs'].checks) {
      const u = un[c.name], m = /lnZ (\S+) ± (\S+) vs (\S+)/.exec(c.more.join(' ')); if (!pick[c.name] || !m) continue;
      const z = num(m[1]), e = num(m[2]), t = num(m[3]);
      rows.push({ label: pick[c.name], truth: 0, items: [{ label: 'this code', color: C.esl, mean: z - t, std: e, text: `${m[1]} ± ${m[2]} (exact ${m[3]})` },
        ...(u ? [{ label: 'UltraNest', color: C.b, mean: u.logz - t, std: u.logzerr, text: `${u.logz.toFixed(3)} ± ${u.logzerr.toFixed(3)}${u.reached_max ? ' (stopped at 1e6 calls)' : ''}` }] : [])] });
    }
    return rows.length ? { rows, lim: 1.5, unit: '', truthLabel: 'exact value' } : null;
  },
  limbdark() {
    const laws = [['four-coefficient', 'four-coefficient'], ['quadratic', 'quadratic'], ['square-root', 'square-root'], ['linear', 'linear']], types = ['F', 'G', 'K', 'M'];
    const series = laws.map(([nm, key], j) => ({ label: nm, color: [C.a, C.b, C.c, C.d][j], values: types.map((T) => { const c = find('test/limbdark.test.mjs', new RegExp(`^${key} law, ${T} stars`))[0]; return c ? num(/rms (\S+?),/.exec(c.info)[1]) : 0; }) }));
    return { groups: types.map((T) => T + ' stars'), series };
  },
  periodogram() {
    const amps = [1, 2, 3, 5], v = amps.map((a) => { const c = find('test/periodogram.test.mjs', new RegExp(`^amplitude ${a} min`))[0]; return c ? num(/FAP < 1% in (\d+)%/.exec(c.info)[1]) : 0; });
    return { groups: amps.map((a) => a + ' min'), series: [{ label: 'detected (false-alarm probability under 1%), % of trials', color: C.a, values: v }], yMax: 100 };
  },
  sky() {
    const arcsec = (s) => { const m = /([\d.]+)(["'])/.exec(s); return num(m[1]) * (m[2] === "'" ? 60 : 1); };
    const rows = [], add = (label, re) => { const c = find('test/astro.test.mjs', re)[0]; if (!c) return; const mx = /max ([\d.]+["'])/.exec(c.info), r = /rms ([\d.]+["'])/.exec(c.info); if (mx && r) rows.push({ label, lo: arcsec(r[1]), hi: arcsec(mx[1]), color: C.a }); };
    add('sidereal time', /^Greenwich apparent sidereal time/); add('stars', /^stars: altitude and azimuth/);
    for (const b of ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) add(b[0].toUpperCase() + b.slice(1), new RegExp(`^${b} topocentric`));
    return { rows, xMin: 0.01, xMax: 1e4, marks: [{ x: 1800, label: 'Moon’s diameter' }], unit: '″' };
  },
  async relations() {
    const R = await import('../../src/core/relations.js'), ref = J('test/relations_reference.json').ck17;
    const val = (m) => { const r = R.radiusFromMassCK17(m); return typeof r === 'number' ? r : r.radius ?? r.value ?? r.r; };
    const x = Array.from({ length: 121 }, (_, i) => 10 ** (-1 + (6 * i) / 120));
    return { xLog: true, yLog: true, yFloor: 0.1, xLabel: 'mass [Earth masses]', xLabelShort: 'M =',
      series: [{ x, y: x.map(val), color: C.esl, width: 2, label: 'this code' }, { x: ref.mass_earth, y: ref.radius_earth, color: C.b, pointsOnly: true, r: 4, label: 'forecaster (posterior median)' }] };
  },
};

const plots = { ...prev.plots };
for (const t of topics) if (builders[t.id]) { try { const p = await builders[t.id](); if (p) plots[t.id] = p; else console.log('no plot data for', t.id); } catch (e) { console.log('plot', t.id, 'failed:', e.message); } }

// ---- mirror the generator scripts, so the links on the deployed page lead somewhere ----------------------------------
const mirrored = () => [...readdirSync(P('tools/validation')).filter((f) => /\.(py|mjs)$/.test(f)).map((f) => 'tools/validation/' + f),
  ...new Set(TOPICS.flatMap((t) => t.generators || [])), ...new Set(TOPICS.filter((t) => t.status === 'done').flatMap((t) => t.tests)), 'test/validation.test.mjs', 'validation/README.md'];
const dir = P('public/validation/scripts/'); rmSync(dir, { recursive: true, force: true });
const scripts = mirrored();
for (const f of scripts) { const to = dir + f; mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true }); copyFileSync(P(f), to); }

const tests = { ...prev.tests };
for (const [f, r] of Object.entries(results)) { const { stdout, ...keep } = r; tests[f] = keep; }
const out = { date: new Date().toISOString().slice(0, 10), node: process.version, machine: `${os.cpus()[0].model}, ${os.platform()} ${os.arch()}`, tests, plots, scripts };
writeFileSync(outPath, JSON.stringify(out));
console.log('wrote', outPath, Math.round(JSON.stringify(out).length / 1024), 'kB;', scripts.length, 'scripts mirrored to public/validation/scripts/');
