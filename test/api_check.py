# Drives every function of window.__esl.api (src/ui/api.js) in headless Chromium: each call's return value, that a
# changing call is exactly one undo step, that a call which cannot do what was asked throws an Error with a reason,
# and that figure() returns a PNG of the size asked for, for every view.
#   .venv/bin/python test/api_check.py /tmp/esl-api          (figures are written to /tmp/esl-api_<view>.png)
# The site is read from $ESL_BASE (default http://localhost:8765): a built copy served statically, as for the
# other browser checks (CLAUDE.md, "Browser checks"). Exit code 1 when a check fails.
import sys, os, json, base64, struct
from playwright.sync_api import sync_playwright

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/esl-api'
base = os.environ.get('ESL_BASE', 'http://localhost:8765').rstrip('/')
fails = []
def check(name, cond, info=''):
    print(('ok   ' if cond else 'FAIL ') + name + (('   ' + str(info)) if info != '' else ''))
    if not cond: fails.append(name)

# helpers that live in the page for the whole run
HELPERS = """
window.T = {
  api: window.__esl.api, S: window.__esl.S,
  frame: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  // run fn, then undo once: true when fn changed what probe() sees and one undo brought it back
  async oneStep(fn, probe) { const a = JSON.stringify(probe()); const ret = await fn(); const b = JSON.stringify(probe()); T.api.undo(); const c = JSON.stringify(probe()); T.api.redo(); const d = JSON.stringify(probe()); return { changed: a !== b, undone: a === c, redone: b === d, ret }; },
  // the message of the Error fn throws, or null when it does not throw
  async reason(fn) { try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : 'not an Error: ' + String(e); } },
  probe: () => { const s = T.api.state(); return { planets: s.planets, pars: s.parameters.map((p) => [p.key, p.value, p.free, p.prior]), ld: s.limbDarkening, lc: s.lightCurve, models: s.models, use: [s.rvInFit, s.timing, s.kepler], view: s.view, sampler: s.sampler, has: s.hasResult }; },
};
"""

def png_size(url):
    raw = base64.b64decode(url.split(',')[1]); assert raw[:8] == b'\x89PNG\r\n\x1a\n'
    return struct.unpack('>II', raw[16:24]), raw

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); logs = []
    pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: logs.append('console.error ' + m.text) if m.type == 'error' else None)
    pg.goto(base + '/analyze/?skipintro'); pg.wait_for_timeout(2500)
    pg.evaluate(HELPERS)
    ev = lambda js: pg.evaluate('(async () => { ' + js + ' })()')
    def step(name, call, expect='true', probe='T.probe'):
        r = ev(f"const r = await T.oneStep(async () => {call}, {probe}); return {{ ...r, ok: (() => {{ const ret = r.ret; return !!({expect}); }})() }};")
        check(name, r['changed'] and r['undone'] and r['redone'] and r['ok'], '' if (r['changed'] and r['undone'] and r['redone'] and r['ok']) else json.dumps(r, default=str)[:300])
        return r['ret']
    def throws(name, call, word=''):
        m = ev(f"return T.reason(async () => {call});")
        check(name, m is not None and not m.startswith('not an Error') and len(m) > 12 and (word in m), repr(m)[:160])

    # ---- describe ---------------------------------------------------------------------------------------------
    d = ev("return { fns: Object.keys(T.api).filter((k) => typeof T.api[k] === 'function'), doc: T.api.describe() };")
    names = [x['name'] for x in d['doc']]
    check('describe() lists every function of the API', sorted(names) == sorted(d['fns']), f"{len(names)} functions")
    check('describe(): every entry has a description, an argument list and a JSON schema', all(len(x['description']) > 20 and isinstance(x['args'], list) and x['parameters']['type'] == 'object' and all(a['name'] in x['parameters']['properties'] for a in x['args']) for x in d['doc']),
          [x['name'] for x in d['doc'] if len(x['description']) <= 20])
    need = ['addPlanet', 'removePlanet', 'setLimbDarkening', 'simulate', 'editData', 'progress', 'runs', 'compare', 'restoreRun', 'figure', 'setPhase', 'setMoon', 'setNbody', 'companionSearch', 'addCompanion', 'derived', 'describe']
    check('the functions the assistant is built against are there', all(n in names for n in need), [n for n in need if n not in names])
    print('     API:', ', '.join(names))

    # ---- state, derived before a fit ----------------------------------------------------------------------------
    s = ev("return T.api.state();")
    check('state(): planets, parameters, limb darkening, models', s['planets'] == ['b'] and len(s['parameters']) > 6 and s['limbDarkening']['law'] == 'quadratic' and s['models'] == {'moon': None, 'planetLight': None, 'nbody': None}, s['name'])
    dv = ev("return T.api.derived();")
    lab = {r['label']: r for r in dv}
    check('derived() before a fit: current values, no uncertainties', len(dv) >= 12 and all(r['kind'] == 'current values' and r['plus'] is None for r in dv), f"{len(dv)} rows; b = {lab['Impact parameter b']['value']:.4f}, T14 = {lab['Transit duration T₁₄']['value'] * 24:.3f} h")

    # ---- simulate ---------------------------------------------------------------------------------------------
    r = step('simulate({noise_ppm, cadence_min, span, seed, epochs}): one undo step', "T.api.simulate({ noise_ppm: 800, cadence_min: 2, span: 6, seed: 3, epochs: 3, epoch_step: 2 })", "ret.epochs === 3 && Math.abs(ret.points - 3 * 180) <= 3 && ret.noise_ppm === 800 && Math.abs(ret.span_hr - 6) < 1e-9")
    print('     simulate ->', r)
    throws('simulate: a span shorter than the transit is refused', "T.api.simulate({ span: 0.5 })", 'transit')
    throws('simulate: noise must be positive', "T.api.simulate({ noise_ppm: -5 })", 'greater than zero')

    # ---- editData ---------------------------------------------------------------------------------------------
    n0 = ev("return T.S.data.t.length;")
    r = step('editData({remove_epoch}): one undo step', "T.api.editData({ remove_epoch: 2 })", "ret.epochs === 2 && ret.removed > 100"); print('     ', r)
    t0, t1 = ev("return [T.S.data.t[20], T.S.data.t[T.S.data.t.length - 21]];")
    r = step('editData({trim}): one undo step', f"T.api.editData({{ trim: [{t0}, {t1}] }})", "ret.removed === 40"); print('     ', r)
    # plant three outliers, then clip them
    ev("const d = T.S.data, f = Float64Array.from(d.f); f[10] += 0.02; f[50] -= 0.03; f[200] += 0.015; T.S.data = { ...d, f }; T.S.dataId++; window.__esl.api.setView({ fold: T.S.fold }); await T.frame();")
    r = step('editData({clip_sigma}) removes the three planted outliers and nothing else', "T.api.editData({ clip_sigma: 6 })", "ret.removed === 3"); print('     ', r)
    r = step('editData({bin_min}): one undo step', "T.api.editData({ bin_min: 6 })", "ret.points < 130 && ret.points > 100"); print('     ', r)
    check('editData: bin widens the exposure the model averages over', ev("return T.S.exptimeMin;") == 6)
    throws('editData: nothing asked', "T.api.editData({})", 'at least one')
    throws('editData: an epoch that is not there', "T.api.editData({ remove_epoch: 9 })", 'numbered 1 to')
    throws('editData: a window with no data', "T.api.editData({ trim: [1000, 2000] })", 'every point')

    # ---- limb darkening -----------------------------------------------------------------------------------------
    step('setLimbDarkening({law}): one undo step', "T.api.setLimbDarkening({ law: 'nonlinear' })", "ret.law === 'nonlinear' && ret.coeffs.length === 4")
    step('setLimbDarkening({band, coeffs: "star"}): one undo step', "T.api.setLimbDarkening({ band: 'TESS', coeffs: 'star' })", "/TESS/.test(ret.band)")
    step('setLimbDarkening({law, coeffs}): one undo step', "T.api.setLimbDarkening({ law: 'quadratic', coeffs: [0.31, 0.27] })", "ret.law === 'quadratic' && ret.coeffs[0] === 0.31 && ret.coeffs[1] === 0.27")
    step('setLimbDarkening({band: [min, max]}): one undo step', "T.api.setLimbDarkening({ band: [600, 800] })", "Array.isArray(ret.band) && ret.band[0] === 600")
    r = step('setLimbDarkening({mode: "star"}): one undo step', "T.api.setLimbDarkening({ mode: 'star' })", "ret.mode === 'star'")
    check('in star mode T eff is offered as a parameter and the coefficients are not', ev("const k = T.api.state().parameters.map((p) => p.key); return k.includes('teff') && !k.includes('ld0');"))
    throws('setLimbDarkening: coefficients cannot be given in star mode', "T.api.setLimbDarkening({ coeffs: [0.3, 0.2] })", 'star')
    ev("T.api.setLimbDarkening({ mode: 'coeffs' });")
    throws('setLimbDarkening: unknown law', "T.api.setLimbDarkening({ law: 'cubic' })", 'not a limb darkening law')
    throws('setLimbDarkening: wrong number of coefficients', "T.api.setLimbDarkening({ coeffs: [0.3] })", 'takes 2')
    throws('setLimbDarkening: unknown band', "T.api.setLimbDarkening({ band: 'Q' })", 'not a known band')

    # ---- planets -----------------------------------------------------------------------------------------------
    r = step('addPlanet({letter, values}): one undo step', "T.api.addPlanet({ letter: 'd', values: { per: 7.5, rprs: 0.06, mplanet: 0.3 } })", "ret === 'd' && T.S.values['per@d'] === 7.5 && T.S.values['rprs@d'] === 0.06 && T.S.planets.length === 2")
    check('addPlanet() picks the next free letter', ev("return T.api.addPlanet();") == 'c')
    throws('addPlanet: a letter in use', "T.api.addPlanet({ letter: 'd' })", 'already')
    throws('addPlanet: an unknown parameter', "T.api.addPlanet({ values: { radius: 1 } })", 'not a planet parameter')
    step('removePlanet(letter): one undo step', "T.api.removePlanet('c')", "T.S.planets.length === 2 && T.S.values['per@c'] === undefined")
    throws('removePlanet: the first planet', "T.api.removePlanet('b')", 'first planet')
    throws('removePlanet: no such planet', "T.api.removePlanet('z')", 'no planet z')

    # ---- N-body switch -----------------------------------------------------------------------------------------
    throws('setNbody: a planet without a mass', "T.api.setNbody({})", 'mass')
    ev("T.api.setValue('mplanet', 0.9); T.api.showPlanet('b');")
    step('setNbody({}): one undo step', "T.api.setNbody({ linear: true })", "Number.isFinite(ret.epoch) && ret.linear === true && T.api.state().models.nbody !== null")
    step('setNbody(null): one undo step', "T.api.setNbody(null)", "ret === null && T.S.nbody === null")
    ev("T.api.removePlanet('d');")
    throws('setNbody: one planet', "T.api.setNbody({})", 'one planet')

    # ---- moon and planet light ---------------------------------------------------------------------------------
    step('setMoon(true): one undo step', "T.api.setMoon(true)", "ret.rmoon > 0 && ret.permoon > 0")
    step('setMoon({rmoon, permoon}): one undo step', "T.api.setMoon({ rmoon: 0.021, permoon: 0.4 })", "ret.rmoon === 0.021 && ret.permoon === 0.4")
    u = ev("return T.api.figure('moon', { width: 700, height: 420 });"); sz, raw = png_size(u); open(out + '_moon.png', 'wb').write(raw)
    check("figure('moon') is a 1400 x 840 PNG", sz == (1400, 840), sz)
    ev("T.api.setView({ view: 'moon' }); await T.frame();")
    step('setMoon(false): one undo step', "T.api.setMoon(false)", "ret === null && T.api.state().models.moon === null")
    throws('setMoon: unknown field', "T.api.setMoon({ radius: 1 })", 'not a moon parameter')
    throws("figure('moon') without a moon", "T.api.figure('moon')", 'no moon')
    step('setPhase({mode: "harmonic"}): one undo step', "T.api.setPhase({ mode: 'harmonic' })", "ret.mode === 'harmonic' && T.S.values.fpfs > 0")
    step('setPhase({mode: "map", lmax: 2}): one undo step', "T.api.setPhase({ mode: 'map', lmax: 2 })", "ret.mode === 'map' && ret.lmax === 2 && T.S.values.y10 !== undefined")
    for v in ('phase', 'map'):
        u = ev(f"return T.api.figure('{v}', {{ width: 800, height: 450, theme: 'dark', scale: 1 }});"); sz, raw = png_size(u); open(f'{out}_{v}.png', 'wb').write(raw)
        check(f"figure('{v}') is an 800 x 450 PNG", sz == (800, 450), sz)
    throws('setPhase: degree out of range', "T.api.setPhase({ mode: 'map', lmax: 7 })", '1, 2 or 3')
    step('setPhase(null): one undo step', "T.api.setPhase(null)", "ret === null && T.S.values.fpfs === undefined && T.S.phase === null")

    # ---- fits: progress, runs, compare, restore, results, derived, corner ---------------------------------------
    ev("await T.api.loadExample('single', { fresh: true }); await T.frame();")
    pr0 = ev("return T.api.progress();")
    check('progress() before any fit', pr0['running'] is False and pr0['fraction'] == 0 and pr0['calls'] == 0, pr0)
    seen = ev("""const seen = []; const done = T.api.run(); while (T.S.running) { const p = T.api.progress(); if (p.running && p.calls > 0) seen.push(p); await new Promise((r) => setTimeout(r, 50)); }
               const res = await done; return { n: seen.length, first: seen[0], last: seen[seen.length - 1], logZ: res.logZ, after: T.api.progress() };""")
    ok = seen['n'] > 0 and seen['last']['fraction'] > seen['first']['fraction'] - 1e-9 and 0 < seen['last']['fraction'] <= 1 and seen['last']['calls'] >= seen['first']['calls'] and all(k in seen['last'] for k in ('running', 'calls', 'logZ', 'eta_s', 'fraction'))
    check('progress() while a fit runs: calls and fraction rise', ok, f"{seen['n']} reports; last: calls {seen['last']['calls'] if seen['n'] else '-'}, fraction {seen['last']['fraction']:.2f}, eta {seen['last']['eta_s']}" if seen['n'] else 'no report seen')
    check('progress() after the fit: finished, with the calls and ln Z of the result', seen['after']['running'] is False and seen['after']['fraction'] == 1 and abs(seen['after']['logZ'] - seen['logZ']) < 1e-9, seen['after'])
    throws('a change while a fit runs is refused', "{ const d = T.api.run(); await new Promise((r) => setTimeout(r, 30)); try { T.api.setValue('rprs', 0.1); } finally { T.api.stop(); await d.catch(() => {}); } }", 'fit is running')
    ev("T.api.undo(); T.api.undo(); T.S.runs.length = 1; T.api.restoreRun(1);")
    dv = ev("return T.api.derived();"); lab = {r['label']: r for r in dv}
    check('derived() after a fit: the system table with uncertainties', len(dv) >= 20 and lab['Radius ratio Rp/R★']['kind'] == 'fit' and lab['Radius ratio Rp/R★']['plus'] > 0 and lab['Planet radius Rp']['kind'] == 'derived' and lab['Planet radius Rp']['unit'] == 'R Jup',
          f"{len(dv)} rows; Rp/R* = {lab['Radius ratio Rp/R★']['value']:.4f} +{lab['Radius ratio Rp/R★']['plus']:.4f} -{lab['Radius ratio Rp/R★']['minus']:.4f}")
    ev("T.api.setFree('a2', false); T.api.setValue('a2', 0);")
    r2 = ev("const r = await T.api.run(); return r.logZ;")
    runs = ev("return T.api.runs();")
    check('runs(): two runs with their free parameters and evidence', len(runs) == 2 and runs[0]['free'] == ['rprs', 'inc', 'tmid', 'a2'] and runs[1]['free'] == ['rprs', 'inc', 'tmid'] and runs[1]['showing'] and not runs[0]['showing'] and all(r['same_data'] and r['converged'] for r in runs),
          [(r['id'], r['free'], round(r['logZ'], 2)) for r in runs])
    cmp = ev("return T.api.compare(1, 2);")
    check('compare(1, 2): Δ ln Z, a reading in words, cautions', abs(cmp['delta_lnZ'] - (runs[0]['logZ'] - runs[1]['logZ'])) < 1e-9 and cmp['delta_lnZ_err'] > 0 and len(cmp['words']) > 30 and isinstance(cmp['cautions'], list) and cmp['comparable'] is True, cmp['words'])
    print('     cautions:', cmp['cautions'])
    shown = ev("T.api.showTab('results'); await T.frame(); return [...document.querySelectorAll('tr.runrow')].map((r) => r.textContent);")
    check('compare() says what the Results tab says', any(cmp['reading'] in t for t in shown) if cmp['reading'] != 'reference' else True, cmp['reading'])
    step('restoreRun(1): one undo step', "T.api.restoreRun(1)", "T.S.fit.id === 1 && T.S.free.a2 === true && ret.logZ === T.S.runs[0].logZ", "() => [T.S.fit && T.S.fit.id, T.S.free.a2, T.S.values.a2]")
    throws('restoreRun: no such run', "T.api.restoreRun(9)", 'no run #9')
    throws('compare: a run with itself', "T.api.compare(1, 1)", 'two different')
    for v, (w, hh) in {'lc': (900, 540), 'residuals': (900, 400)}.items():
        u = ev(f"return T.api.figure('{v}', {{ width: {w}, height: {hh} }});"); sz, raw = png_size(u); open(f'{out}_{v}.png', 'wb').write(raw)
        check(f"figure('{v}') is a {2 * w} x {2 * hh} PNG", sz == (2 * w, 2 * hh), sz)
    u = ev("return T.api.figure('corner', { width: 700 });"); sz, raw = png_size(u); open(out + '_corner.png', 'wb').write(raw)
    check("figure('corner') is 1400 px wide and about square", sz[0] == 1400 and 0.9 < sz[1] / sz[0] < 1.25, sz)
    u = ev("return T.api.figure('system', { width: 640 });"); sz, raw = png_size(u); open(out + '_system.png', 'wb').write(raw)
    lit = ev("const im = new Image(); im.src = T.api.figure('system', { width: 320, scale: 1 }); await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const px = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60) n++; return n / (px.length / 4);")
    check("figure('system') is a 1280 px wide copy of the system view with something in it", sz[0] == 1280 and lit > 0.002, f"{sz}, {100 * lit:.1f}% of pixels lit")
    throws("figure: unknown view", "T.api.figure('spectrum')", 'not a figure')
    throws("figure('rv') without velocities", "T.api.figure('rv')", 'no radial velocities')
    throws("figure('timing') without times", "T.api.figure('timing')", 'at least two')
    ev("T.api.simulate({ seed: 9 });")
    throws('restoreRun: a run on other data', "T.api.restoreRun(1)", 'different data')
    c2 = ev("return T.api.runs().map((r) => r.same_data);"); check('runs(): earlier runs are marked as fitted to other data', c2 == [False, False], c2)
    throws("figure('corner') without a fit", "T.api.figure('corner')", 'run a fit')

    # ---- velocities and timing figures ---------------------------------------------------------------------------
    ev("await T.api.loadExample('hd80606-rv'); await T.frame();")
    for v in ('rv', 'timing'):
        u = ev(f"return T.api.figure('{v}');"); sz, raw = png_size(u); open(f'{out}_{v}.png', 'wb').write(raw)
        check(f"figure('{v}') is an 1800 x 1080 PNG", sz == (1800, 1080), sz)

    # ---- companion search --------------------------------------------------------------------------------------
    ev("await T.api.loadExample('nbody', { fresh: true }); await T.frame();")
    cell = ev("return T.api.companionSearch({ masses: [0.05, 0.1, 0.2], ratios: [1.9, 1.95, 2.0, 2.05, 2.1, 2.15], phases: 8 });")
    check('companionSearch(opts): the best cell, with what addCompanion needs', all(k in cell for k in ('mass', 'period', 'tmid', 'inc', 'epoch', 'host', 'chi2')) and cell['delta_chi2'] > 0 and cell['n_times'] == 72 and 1.8 < cell['period_ratio'] < 2.3,
          f"mass {cell['mass']:.3f} M Jup, period ratio {cell['period_ratio']:.3f}, chi2 {cell['chi2']:.1f} against {cell['chi2_no_companion']:.1f} with no companion, {cell['simulations']} simulations in {cell['seconds']:.1f} s")
    check('the search result is on the Timing tab', ev("T.api.showTab('timing'); await T.frame(); return !!document.querySelector('.dyncanvas') && /Best companion|Best grid cell/.test(document.querySelector('#tab-timing').textContent);"))
    cell_js = json.dumps(cell)
    step('addCompanion(cell): one undo step', f"T.api.addCompanion({cell_js})", "ret === 'c' && T.S.planets.length === 2 && T.S.nbody && T.S.nbody.linear === true && T.S.free['mplanet@c'] === true")
    throws('addCompanion: not a cell', "T.api.addCompanion({ mass: 1 })", 'period')
    ev("await T.api.loadExample('single', { fresh: true });")
    throws('companionSearch: too few times', "T.api.companionSearch({})", 'at least eight')

    # ---- the older calls say why they fail ----------------------------------------------------------------------
    throws('loadLightCurve: text that is not a light curve', "T.api.loadLightCurve('hello world')")
    throws('setPrior: an impossible prior', "T.api.setPrior('rprs', { type: 'uniform', a: 1, b: 0 })", 'prior for rprs')
    throws('setValue: an unknown key', "T.api.setValue('albedo', 1)", 'not a parameter')
    throws('setFree: a/R★', "T.api.setFree('ars', true)", 'Kepler')
    throws('loadExample: unknown id', "T.api.loadExample('nope')", 'no example')
    throws('setView: a view the model does not have', "T.api.setView({ view: 'rv' })", 'no radial velocities')

    errs = [l for l in logs if 'assistant' not in l]
    check('no page errors', not any(l.startswith('PAGEERROR') for l in errs), errs[:4])
    b.close()
print(f"\n{'ALL OK' if not fails else str(len(fails)) + ' FAILED: ' + '; '.join(fails)}")
sys.exit(1 if fails else 0)
