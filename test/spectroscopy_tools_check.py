# The assistant's tools on the spectroscopy page (window.__esl.spectroscopy, src/spectra/main.js), driven headlessly
# in a realistic order, each through its run() with a conversation file store like the assistant's. Not part of
# `npm test`. Needs a built copy of the site served somewhere and Playwright in the project virtualenv:
#
#   npx vite build --outDir /tmp/esl-spec --emptyOutDir && python3 -m http.server 8952 -d /tmp/esl-spec
#   ESL_BASE=http://localhost:8952 .venv/bin/python test/spectroscopy_tools_check.py /tmp/esl-spec-check [--jwst]
#
# 1. declarations: lintSpecs (src/assistant/toolspec.js) and createSiteTools (src/assistant/pages.js) accept them
# 2. Ariel simulation (WASP-39 b) -> options -> white-light fit -> step search -> channel fits -> spectrum against the
#    injected one -> one channel -> every export -> session reloaded through spectroscopy_load_files
# 3. the batman injection cube of test/spectroscopy.test.mjs (spec_batman_cube.csv) as an attached CSV: the white-light
#    mid-time and inclination against the injected geometry (test/spectroscopy_reference.json)
# 4. x1dints FITS and long ECSV fixtures as attachments; a JWST G395H simulation rebinned; a stopped channel run;
#    errors in words for misuse; the hand-off record for the analyzer
# --jwst: also the six real WASP-39 b G395H x1dints files of test/data/jwst (217 MB), when present.
import sys, os, json, base64, subprocess, time
from playwright.sync_api import sync_playwright

args = sys.argv[1:]
JWST = '--jwst' in args
args = [a for a in args if a != '--jwst']
out = args[0] if args else '/tmp/esl-spec-check'
os.makedirs(out, exist_ok=True)
base = os.environ.get('ESL_BASE', 'http://localhost:8952').rstrip('/')
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here); data = os.path.join(here, 'data')
ref = json.load(open(os.path.join(here, 'spectroscopy_reference.json')))['injection']

ok = True
def check(name, cond, info=''):
    global ok
    print(('ok   ' if cond else 'FAIL ') + name + (('   ' + info) if info else ''), flush=True)
    if not cond: ok = False

HARNESS = r"""
() => {
  const all = new Map();
  const files = {
    add(name, blob) { all.set(name, { name, text: null, blob, size: blob.size, origin: 'attached' }); },
    addText(name, text) { all.set(name, { name, text, blob: null, size: text.length, origin: 'attached' }); },
    list: () => [...all.values()].map((f) => ({ name: f.name, size: f.size, origin: f.origin })),
    get: (name) => all.get(name) || null,
    async write(name, data, mime) { const t = typeof data === 'string'; all.set(name, { name, text: t ? data : null, blob: t ? null : data, size: t ? data.length : data.size, origin: 'written', mime }); return { name, size: t ? data.length : data.size }; },
    remove(name) { all.delete(name); },
  };
  // the argument check the assistant applies: known keys only, types, enums, required
  const typeOk = (s, v) => { if (s.enum && !s.enum.includes(v)) return false; const t = [].concat(s.type || []); if (!t.length) return true;
    return t.some((x) => (x === 'integer' ? Number.isInteger(v) : x === 'number' ? typeof v === 'number' : x === 'array' ? Array.isArray(v) : x === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === x)); };
  const argsOk = (schema, a, where) => { const p = schema.properties || {}; for (const k of Object.keys(a)) { if (!(k in p)) return `${where}: unknown argument ${k}`; if (!typeOk(p[k], a[k])) return `${where}.${k}: bad value ${JSON.stringify(a[k])}`; if (p[k].type === 'array' && p[k].items) for (const x of a[k]) { if (!typeOk(p[k].items, x)) return `${where}.${k}[]: bad value`; if (p[k].items.type === 'object') { const e = argsOk(p[k].items, x, where + '.' + k); if (e) return e; } } } for (const r of schema.required || []) if (!(r in a)) return `${where}: ${r} is required`; return ''; };
  const progress = [];
  window.__T = { files, progress, all,
    specs: () => window.__esl.spectroscopy.tools.map(({ run, confirm, ...t }) => ({ ...t, confirm: typeof confirm === 'function' ? 'fn' : confirm })),
    confirmFor(name, a = {}) { const t = window.__esl.spectroscopy.tools.find((x) => x.name === name); return !t.confirm ? null : typeof t.confirm === 'function' ? t.confirm(a) || null : t.confirm; },
    async call(name, a = {}, abortAfterMs) {
      const t = window.__esl.spectroscopy.tools.find((x) => x.name === name); if (!t) return { ok: false, error: 'no tool ' + name };
      const bad = argsOk(t.parameters, a, name); if (bad) return { ok: false, error: 'ARGS ' + bad };
      const ac = new AbortController(); if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs);
      const t0 = performance.now();
      try { const data = await t.run(a, { files, signal: ac.signal, onProgress: (p) => progress.push(p) }); return { ok: true, data, ms: Math.round(performance.now() - t0), chars: JSON.stringify(data).length }; }
      catch (e) { return { ok: false, error: String(e && e.message || e), ms: Math.round(performance.now() - t0) }; }
    } };
  return true;
}
"""

FIX = {name: os.path.join(data, name) for name in ['spec_batman_cube.csv', 'spec_long.ecsv', 'spec_x1dints_rows.fits', 'spec_x1dints_exts.fits']}
JW = sorted(f for f in os.listdir(os.path.join(data, 'jwst')) if f.endswith('_x1dints.fits')) if os.path.isdir(os.path.join(data, 'jwst')) else []
for f in JW: FIX[f] = os.path.join(data, 'jwst', f)

errors = []
with sync_playwright() as p:
    br = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = br.new_page(viewport={'width': 1400, 'height': 1000})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    # attachments are served to the page from test/data at /__fx/<name>
    pg.route('**/__fx/*', lambda route: route.fulfill(path=FIX[route.request.url.rsplit('/', 1)[1]], content_type='application/octet-stream'))
    pg.goto(base + '/analyze/spectroscopy/')
    pg.wait_for_function('() => window.__esl && window.__esl.spectroscopy && window.__esl.spectroscopy.ready()', timeout=30000)
    pg.evaluate(HARNESS)
    call = lambda name, a=None, abort=None: pg.evaluate('([n, a, ab]) => window.__T.call(n, a, ab)', [name, a or {}, abort])
    attach = lambda name, text=False: pg.evaluate('async ([n, t]) => { const r = await fetch("/__fx/" + n); if (t) window.__T.files.addText(n, await r.text()); else window.__T.files.add(n, await r.blob()); return true; }', [name, text])
    state = lambda: pg.evaluate('() => window.__esl.spectroscopy.state()')
    def show(r, keys=None):
        d = r.get('data') if r.get('ok') else r.get('error')
        if isinstance(d, dict) and keys: d = {k: d.get(k) for k in keys}
        s = json.dumps(d); print('     ', (s[:900] + ' ...') if len(s) > 900 else s, flush=True)
    log = {}

    # ---- 1. declarations
    specs = pg.evaluate('() => window.__T.specs()')
    json.dump(specs, open(os.path.join(out, 'specs.json'), 'w'), indent=1)
    lint = subprocess.run(['node', '--input-type=module', '-e', f"""
import {{ lintSpecs }} from '{root}/src/assistant/toolspec.js';
import {{ createSiteTools }} from '{root}/src/assistant/pages.js';
import {{ memoryFiles }} from '{root}/src/assistant/tools.js';
import {{ readFileSync }} from 'node:fs';
const specs = JSON.parse(readFileSync('{out}/specs.json', 'utf8')).map((t) => ({{ ...t, confirm: t.confirm === 'fn' ? 'confirm' : t.confirm, run: () => ({{}}) }}));
const S = createSiteTools({{ page: 'spectroscopy', root: 'https://esl.test/', pageApi: {{ tools: specs, ready: () => true, state: () => ['x'] }}, files: memoryFiles() }});
console.log(JSON.stringify({{ lint: lintSpecs(specs.map(({{ run, ...t }}) => t)), problems: S.problems, n: S.specs.length, chars: JSON.stringify(specs).length, card: S.stateCard().split('\\n')[1] }}));
"""], capture_output=True, text=True)
    L = json.loads(lint.stdout.strip().splitlines()[-1]) if lint.returncode == 0 else {'lint': [lint.stderr[-400:]], 'problems': []}
    names = [s['name'] for s in specs]
    check('declarations: lintSpecs and createSiteTools find no problem', not L['lint'] and not L['problems'], f"{len(specs)} tools, {L.get('chars')} characters of declarations; {L['lint'] + L['problems']}")
    check('declarations: read-only tools are the ones that change nothing; the data-replacing ones ask first', {s['name'] for s in specs if s.get('readOnly')} == {'spectroscopy_describe', 'spectroscopy_modes', 'spectroscopy_spectrum', 'spectroscopy_channel'} and all(any(s['name'] == n and s.get('confirm') for s in specs) for n in ['spectroscopy_load_files', 'spectroscopy_simulate', 'spectroscopy_set_binning', 'spectroscopy_set_planet']), ', '.join(names))
    print('     state, empty page:', state())

    # ---- 2. the Ariel simulation, through every step
    r = call('spectroscopy_describe'); show(r, ['data', 'planet', 'settings'])
    check('describe on an empty page says how to load', r['ok'] and r['data']['data']['loaded'] is False)
    r = call('spectroscopy_modes', {'telescope': 'JWST'}); check('modes: JWST modes with ranges and R', r['ok'] and len(r['data']['JWST']['modes']) == 8 and r['data']['JWST']['area_m2'] == 25.4, f"{[m['mode'] for m in r['data']['JWST']['modes']]}")
    r = call('spectroscopy_fit_white'); check('fitting before anything is loaded is refused in words', not r['ok'] and 'nothing is loaded' in r['error'], r.get('error'))
    check('no confirmation is asked before the first load', pg.evaluate('() => window.__T.confirmFor("spectroscopy_simulate")') is None)
    r = call('spectroscopy_simulate', {'telescope': 'Ariel', 'seed': 3}); show(r)
    check('simulate: Ariel, six instruments, WASP-39 b', r['ok'] and r['data']['channels'] > 20 and r['data']['planet'] == 'WASP-39 b', f"{r.get('ms')} ms")
    check('after a load, replacing it asks first', 'replaces' in (pg.evaluate('() => window.__T.confirmFor("spectroscopy_simulate")') or ''))
    r = call('spectroscopy_set_fit_options', {'baseline': 'linear', 'ld_law': 'quadratic', 'error_bars': 'max'}); show(r)
    check('set options', r['ok'] and r['data']['set']['baseline'] == 'linear')
    r = call('spectroscopy_set_fit_options', {'baseline': 'cubic'}); check('an option outside the list is refused by the schema check', not r['ok'] and 'ARGS' in r['error'], r.get('error'))
    r = call('spectroscopy_fit_white'); show(r); log['ariel_white'] = r
    wf = r['data'] if r['ok'] else {}
    truth_r = 0.1457
    check('white-light fit: converged, Rp/R* near the injected 0.1457, rms near the error bars', r['ok'] and wf['converged'] and abs(wf['free']['rprs']['value'] - truth_r) < 5 * max(wf['free']['rprs']['plus'], 1e-4) and 0.7 < wf['rms_over_expected'] < 1.4,
          f"Rp/R* {wf.get('free', {}).get('rprs')}, depth {wf.get('depth_ppm')} ppm, rms/expected {wf.get('rms_over_expected')}, {wf.get('likelihood_calls')} calls in {r.get('ms')} ms")
    nprog = pg.evaluate('() => window.__T.progress.length')
    check('white-light fit reports progress (likelihood calls) to the assistant', nprog > 0 and pg.evaluate('() => Number.isFinite(window.__T.progress[0].ncalls)'), f'{nprog} progress messages')
    r = call('spectroscopy_find_step'); show(r); check('step search on simulated data finds no step', r['ok'] and r['data']['added'] is None)
    r = call('spectroscopy_fit_channels'); show(r, ['channels_fitted', 'method', 'spectrum', 'note']); log['ariel_channels'] = r
    check('channel fits: every channel, grid method, a spectrum', r['ok'] and r['data']['channels_fitted'] > 20 and not r['data'].get('failed') and r['data']['method'] == 'grid', f"{r.get('ms')} ms")
    r = call('spectroscopy_spectrum', {'max_rows': 8}); show(r); log['ariel_spectrum'] = r
    sp = r['data'] if r['ok'] else {}
    inj = sp.get('against_injected') if isinstance(sp.get('against_injected'), dict) else {}
    check('spectrum: rows with +/- errors in ppm, scale heights, and the pulls against the injected spectrum near 0 and 1', r['ok'] and sp['rows_shown'] == 8 and all(x['plus_ppm'] > 0 and x['minus_ppm'] > 0 for x in sp['rows']) and sp['scale_heights'] and abs(inj.get('mean_pull', 9)) < 0.6 and 0.6 < inj.get('sd_pull', 0) < 1.5,
          f"mean pull {inj.get('mean_pull')}, sd {inj.get('sd_pull')} over {sp.get('rows_total')} channels; {r.get('chars')} characters")
    page_rows = pg.evaluate('() => window.__esl.spectra.spectrum()')
    check('spectrum rows are the page\'s own numbers', r['ok'] and abs(sp['rows'][0]['depth_ppm'] - 1e6 * page_rows[0]['depth']) < 0.06 and abs(sp['rows'][0]['plus_ppm'] - 1e6 * page_rows[0]['plus']) < 0.06)
    r = call('spectroscopy_channel', {'wavelength_um': 2.8}); show(r); check('one channel near 2.8 um, selected on the page', r['ok'] and abs(r['data']['wl_um'] - 2.8) < 0.2 and pg.evaluate('() => window.__spec.sel') == r['data']['index'])
    r = call('spectroscopy_export', {'kinds': ['csv', 'ecsv', 'png', 'white', 'session']}); show(r)
    wr = {w['kind']: w for w in r['data']['written']} if r['ok'] else {}
    check('export: CSV, ECSV, PNG, white light and session written to the conversation', r['ok'] and set(wr) == {'csv', 'ecsv', 'png', 'white', 'session'} and not r['data'].get('failed'), ', '.join(f"{w['file']} {w['size_bytes']} B" for w in wr.values()))
    csv = pg.evaluate('(n) => window.__T.files.get(n).text', wr['csv']['file']) if 'csv' in wr else ''
    check('the CSV is the page\'s spectrum table with its header', csv.count('\n') > 20 and 'wavelength_um,' in csv and '# target: WASP-39 b' in csv)
    print('     state:', state())
    sess = wr.get('session', {}).get('file')
    check('loading the saved session asks first', 'replaces' in (pg.evaluate('() => window.__T.confirmFor("spectroscopy_load_files")') or ''))
    r = call('spectroscopy_load_files', {'files': [sess]}); show(r, ['loaded', 'data', 'note'])
    check('the saved session reloads through spectroscopy_load_files with its spectrum', r['ok'] and r['data']['data']['source'] == 'simulation' and pg.evaluate('() => window.__esl.spectra.state().spectrum') > 20)

    # ---- 3. the batman injection cube as an attached CSV
    attach('spec_batman_cube.csv', text=True)
    r = call('spectroscopy_load_files', {'files': ['spec_batman_cube.csv']}); show(r, ['data', 'note'])
    check('CSV cube attached as text: 460 integrations x 36 wavelengths', r['ok'] and r['data']['data']['integrations'] == 460 and r['data']['data']['wavelengths'] == 36)
    g = ref['geometry']
    r = call('spectroscopy_set_planet', {'per': g['per'], 'tmid': g['tmid'] + 0.002, 'rprs': 0.14, 'ars': g['ars'], 'inc': 87.0, 'teff': 5400, 'logg': 4.5, 'feh': 0, 'rstar': 0.9, 'mstar': 0.9}); show(r)
    check('planet and star set by hand', r['ok'] and r['data']['system']['ars'] == g['ars'])
    r = call('spectroscopy_set_binning', {'mode': 'native'}); check('native binning: 36 channels', r['ok'] and r['data']['channels'] == 36, json.dumps(r.get('data', r.get('error')))[:200])
    r = call('spectroscopy_set_fit_options', {'error_bars': 'pipeline'})
    r = call('spectroscopy_fit_white'); show(r); log['batman_white'] = r
    w = r['data'] if r['ok'] else {'free': {}}
    tm, inc = w['free'].get('tmid', {}), w['free'].get('inc', {})
    ztm = (tm.get('value', 0) - g['tmid']) / max(tm.get('plus', 1), tm.get('minus', 1)) if tm else 99
    zin = (inc.get('value', 0) - g['inc']) / max(inc.get('plus', 1), inc.get('minus', 1)) if inc else 99
    # the page takes limb darkening from the PHOENIX table for the star; the injection used u1 = 0.5 - 0.08 wl, u2 = 0.2 - 0.02 wl,
    # which no tool can set: the mid-time is robust to that, the inclination and depths are not (shown, not tested)
    check('batman injection: white-light mid-time against the injected one (started 2.9 min off)', r['ok'] and abs(ztm) < 3,
          f"T mid {tm.get('value')} +{tm.get('plus')} -{tm.get('minus')} vs {g['tmid']} ({ztm:+.2f} sigma); for information i {inc.get('value')} vs {g['inc']} ({zin:+.1f} sigma), rms {w.get('rms_over_expected')} x expected: the limb darkening is the PHOENIX table's, not the injected law")
    r = call('spectroscopy_set_planet', {'name': 'batman injection'}); check('a name for numbers typed in', r['ok'] and r['data']['planet'] == 'batman injection')
    r = call('spectroscopy_fit_channels'); show(r, ['channels_fitted', 'spectrum'])
    sp = call('spectroscopy_spectrum', {'max_rows': 400})
    if sp['ok']:
        rows = sp['data']['rows']; pulls = [(x['depth_ppm'] - 1e6 * ref['depth'][i]) / (0.5 * (x['plus_ppm'] + x['minus_ppm'])) for i, x in enumerate(rows)]
        m = sum(pulls) / len(pulls); s = (sum((q - m) ** 2 for q in pulls) / len(pulls)) ** 0.5
        check('batman injection: 36 channel depths (pulls against the injected depths for information: the limb darkening differs as above)', len(rows) == 36, f'pull mean {m:+.2f}, sd {s:.2f} over 36 channels')
    # custom white-light priors, fixed parameters
    r = call('spectroscopy_fit_white', {'free': ['rprs', 'tmid'], 'priors': [{'key': 'tmid', 'type': 'normal', 'a': g['tmid'], 'b': 0.001}]}); show(r, ['free', 'a_over_rstar'])
    check('white-light fit with inclination fixed and a normal prior on the mid-time', r['ok'] and set(r['data']['free']) == {'rprs', 'tmid'})
    r = call('spectroscopy_fit_white', {'free': ['rstar']}); check('rstar free without Kepler is refused in words', not r['ok'] and 'Kepler' in r['error'], r.get('error'))
    r = call('spectroscopy_set_fit_options', {'kepler': True}); r = call('spectroscopy_fit_white'); show(r, ['free', 'a_over_rstar'])
    check('Kepler\'s law: R* free with its prior, a/R* follows', r['ok'] and 'rstar' in r['data']['free'] and r['data']['a_over_rstar']['how'].startswith('Kepler'))
    call('spectroscopy_set_fit_options', {'kepler': False, 'common_mode': True})
    r = call('spectroscopy_fit_channels', {'ld_sigma': 0.1, 'workers': 4}); show(r, ['channels_fitted', 'method', 'spectrum'])
    check('channel fits with limb darkening free (normal prior) and common mode: nested sampling', r['ok'] and r['data']['method'] == 'nested' and r['data']['channels_fitted'] == 36, f"{r.get('ms')} ms")
    call('spectroscopy_set_fit_options', {'common_mode': False})
    r = call('spectroscopy_fit_channels', {'tmid_sigma_min': 1.0, 'workers': 4}); check('channel fits with the mid-time floating (normal prior, 1 min)', r['ok'] and r['data']['method'] == 'nested', f"{r.get('ms')} ms")

    # ---- 4. other inputs, the JWST simulator, stop, misuse, hand-off
    attach('spec_x1dints_rows.fits')
    r = call('spectroscopy_load_files', {'files': ['spec_x1dints_rows.fits']}); show(r, ['data'])
    check('x1dints FITS attached as binary', r['ok'] and r['data']['data']['integrations'] > 0)
    attach('spec_long.ecsv', text=True)
    r = call('spectroscopy_load_files', {'files': ['spec_long.ecsv']}); check('long-format ECSV attached', r['ok'] and r['data']['data']['wavelengths'] > 0, json.dumps(r.get('data', {}).get('data', r.get('error')))[:200])
    r = call('spectroscopy_load_files', {'files': ['nope.fits']}); check('a missing attachment is refused in words', not r['ok'] and 'no attached file' in r['error'], r.get('error'))
    r = call('spectroscopy_simulate', {'mode': 'JWST NIRSpec G395H', 'R': 200, 'noise_floor_ppm': 15, 'feature_ppm': 300}); show(r)
    check('JWST G395H simulation at R = 200 (beyond the limb-darkening table is not reached)', r['ok'] and r['data']['simulated'].startswith('JWST') and r['data']['inputs']['noise_floor_ppm'] == 15, f"{r.get('data', {}).get('channels')} channels")
    r = call('spectroscopy_simulate', {'telescope': 'Ariel', 'mode': 'JWST MIRI LRS'}); check('a mode of another telescope is refused', not r['ok'] and 'not a mode of Ariel' in r['error'], r.get('error'))
    r = call('spectroscopy_set_binning', {'mode': 'R', 'value': 30, 'wl_min': 3.0, 'wl_max': 5.0, 'clip_sigma': 4}); show(r)
    check('rebinning the simulation: R = 30 between 3 and 5 um, clip 4 sigma', r['ok'] and 2 < r['data']['channels'] < 20 and r['data']['data']['range_um'][0] > 2.8)
    call('spectroscopy_set_binning', {'mode': 'native', 'full_range': True})
    call('spectroscopy_fit_white')
    r = call('spectroscopy_fit_channels', {'workers': 2}, 400)
    busy = pg.evaluate('() => window.__spec.busy')
    check('a channel run stopped by the assistant (abort) ends, keeps what was done, and frees the page', r['ok'] and r['data'].get('stopped') and not busy, json.dumps({k: r.get('data', {}).get(k) for k in ['channels_fitted', 'stopped', 'note']}) if r['ok'] else r.get('error'))
    r = call('spectroscopy_channel', {'index': 999}); check('a channel index out of range is refused in words', not r['ok'] and 'there are' in r['error'], r.get('error'))
    r = call('spectroscopy_set_planet', {'lookup': 'HAT-P-1 b'}); show(r, ['planet', 'system', 'note'])
    check('catalogue look-up', r['ok'] and r['data']['planet'].startswith('HAT-P-1'))
    r = call('spectroscopy_set_planet', {'lookup': 'WASP-39 bb'}); check('an unknown planet is refused in words (with similar names when the catalogue has any)', not r['ok'] and 'catalogue' in r['error'], r.get('error'))
    r = call('spectroscopy_send_to_analyze'); show(r)
    hand = pg.evaluate('() => JSON.parse(localStorage.getItem("esl.handoff") || "null")')
    check('hand-off: the analyzer record is left and the request continues on the analyze page', r['ok'] and r['data']['navigate'] == {'page': 'analyze', 'params': {'handoff': 1}} and hand and hand['source'] == 'spectroscopy' and hand['text'].startswith('BJD_TDB,flux,flux_err'))
    r = call('spectroscopy_describe'); check('describe: compact', r['ok'] and r['chars'] < 4000, f"{r.get('chars')} characters")
    print('     state:', state())

    # ---- optional: the real JWST data
    if JWST and len(JW) == 6:
        for f in JW: attach(f)
        r = call('spectroscopy_set_planet', {'lookup': 'WASP-39 b'})
        r = call('spectroscopy_load_files', {'files': JW}); show(r, ['data', 'note'])
        check('real JWST G395H: six x1dints files joined', r['ok'] and r['data']['data']['integrations'] > 400, f"{r.get('ms')} ms")
        r = call('spectroscopy_set_binning', {'mode': 'R', 'value': 100}); show(r, ['channels'])
        r = call('spectroscopy_fit_white'); show(r); log['jwst_white'] = r
        r = call('spectroscopy_find_step'); show(r)
        check('real JWST: the mirror-tilt step is found in the white-light residuals', r['ok'] and r['data']['added'] and r['data']['added']['significance_sigma'] > 5)
        r = call('spectroscopy_fit_channels'); show(r, ['white_refitted', 'white_fit', 'channels_fitted', 'spectrum', 'note']); log['jwst_channels'] = r
        check('real JWST: the white light is refitted with the step before the channels', r['ok'] and r['data'].get('white_refitted') and r['data']['channels_fitted'] == 56)
        r = call('spectroscopy_describe'); print('      white fit after the step:', json.dumps({k: r['data']['white_fit'].get(k) for k in ['free', 'depth_ppm', 'rms_over_expected', 'beta', 'steps_bjd']}))
        r = call('spectroscopy_spectrum', {'max_rows': 12}); show(r)
    elif JWST: print('skip the real JWST data: the six files are not in test/data/jwst')

    pg.screenshot(path=os.path.join(out, 'spectroscopy.png'), full_page=False)
    json.dump(log, open(os.path.join(out, 'results.json'), 'w'), indent=1)
    br.close()

check('no page errors', not errors, '; '.join(errors[:5]))
print('ALL OK' if ok else 'SOME CHECKS FAILED')
sys.exit(0 if ok else 1)
