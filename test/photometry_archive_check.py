# The photometry page's archive, zip and "Prepare for transit fitting" paths, driven headlessly in Chromium against a
# built copy of the site (not part of `npm test`; it downloads from the public MAST bucket, about 30 MB):
#
#   npx vite build --outDir /tmp/esl-pix --emptyOutDir && python3 -m http.server 8962 -d /tmp/esl-pix
#   ESL_BASE=http://localhost:8962 .venv/bin/python test/photometry_archive_check.py /tmp/esl-pix-check [--no-net]
#
# 1. the assistant tools the page declares pass lintSpecs / createSiteTools
# 2. zips: test/data/zip_cases.zip through the file input and through a synthetic drop; EXOTIC's sample-data zip (24 MB,
#    read only, when present) through the file input: 142 light frames in time order
# 3. (network) TOI-1873: the product inventory, three sectors of light curves stitched, planets and TOIs looked up,
#    prepared (transit-masked biweight), windows handed to the analyzer, which loads them
# 4. (network) one TESS-SPOC FFI target pixel file from the single-file list, reduced, then "Prepare for transit fitting"
# 5. (network) the K2-3 campaign 1 target pixel file: reduced, then the K2 pixel-level decorrelation
import sys, os, json, subprocess, time
from playwright.sync_api import sync_playwright

args = sys.argv[1:]
NET = '--no-net' not in args
args = [a for a in args if not a.startswith('--')]
out = args[0] if args else '/tmp/esl-pix-check'
os.makedirs(out, exist_ok=True)
base = os.environ.get('ESL_BASE', 'http://localhost:8962').rstrip('/')
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here); data = os.path.join(here, 'data')
EXOTIC_ZIP = os.path.abspath(os.path.join(root, '..', 'EXOTIC_sampledata-1.0.0.zip'))
ok = True
def check(name, cond, info=''):
    global ok
    print(('ok   ' if cond else 'FAIL ') + name + (('   ' + info) if info else ''), flush=True)
    if not cond: ok = False

HARNESS = r"""
() => {
  window.__T = { async call(name, a = {}) { const t = window.__esl.photometry.tools.find((x) => x.name === name); if (!t) return { ok: false, error: 'no tool ' + name };
    const t0 = performance.now(); try { const data = await t.run(a, { files: { list: () => [], get: () => null, write: async (n, d) => ({ name: n, size: d.length }) } }); return { ok: true, data, ms: Math.round(performance.now() - t0) }; } catch (e) { return { ok: false, error: String(e && e.message || e), ms: Math.round(performance.now() - t0) }; } },
    specs: () => window.__esl.photometry.tools.map(({ run, confirm, ...t }) => ({ ...t, confirm: typeof confirm === 'function' ? 'fn' : confirm })) };
  return true;
}
"""
errors = []
with sync_playwright() as p:
    br = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = br.new_context(viewport={'width': 1400, 'height': 1000}, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    def fresh():
        pg.goto(base + '/analyze/photometry/')
        pg.wait_for_function('() => window.__esl && window.__esl.photometry && window.__esl.photometry.ready()', timeout=30000)
        pg.evaluate(HARNESS)
    call = lambda name, a=None: pg.evaluate('([n, a]) => window.__T.call(n, a)', [name, a or {}])
    fresh()

    # ---- 1. declarations
    specs = pg.evaluate('() => window.__T.specs()')
    json.dump(specs, open(os.path.join(out, 'specs.json'), 'w'), indent=1)
    lint = subprocess.run(['node', '--input-type=module', '-e', f"""
import {{ lintSpecs }} from '{root}/src/assistant/toolspec.js';
import {{ createSiteTools }} from '{root}/src/assistant/pages.js';
import {{ memoryFiles }} from '{root}/src/assistant/tools.js';
import {{ readFileSync }} from 'node:fs';
const specs = JSON.parse(readFileSync('{out}/specs.json', 'utf8')).map((t) => ({{ ...t, confirm: t.confirm === 'fn' ? 'confirm' : t.confirm, run: () => ({{}}) }}));
const S = createSiteTools({{ page: 'photometry', root: 'https://esl.test/', pageApi: {{ tools: specs, ready: () => true, state: () => ['x'] }}, files: memoryFiles() }});
console.log(JSON.stringify({{ lint: lintSpecs(specs.map(({{ run, ...t }}) => t)), problems: S.problems, n: S.specs.length }}));
"""], capture_output=True, text=True)
    L = json.loads(lint.stdout.strip().splitlines()[-1]) if lint.returncode == 0 else {'lint': [lint.stderr[-600:]], 'problems': []}
    check('declarations: lintSpecs and createSiteTools find no problem', not L['lint'] and not L['problems'], f"{len(specs)} tools: {', '.join(s['name'] for s in specs)}; {L['lint'] + L['problems']}")

    # ---- 2. zips
    pg.set_input_files('#inFiles', os.path.join(data, 'zip_cases.zip'))
    pg.wait_for_function('() => window.__phot.mode === "stack"', timeout=30000)
    z = pg.evaluate('() => ({ lights: window.__phot.lights.length, cal: Object.fromEntries(Object.entries(window.__phot.cal).map(([k, v]) => [k, v.length])), names: window.__phot.lights.map((l) => l.file.relPath || l.file.name), status: document.getElementById("stLocal").textContent })')
    check('a zip through the file input: frames and calibration frames from its folders', z['lights'] == 10 and z['cal'] == {'bias': 1, 'dark': 2, 'flat': 1}, f"{z['lights']} lights, {z['cal']}; \"{z['status'][:140]}\"")
    fresh()
    zb = open(os.path.join(data, 'zip_cases.zip'), 'rb').read()
    pg.evaluate("""(bytes) => { const f = new File([new Uint8Array(bytes)], 'dropped.zip', { type: 'application/zip' }); const dt = new DataTransfer(); dt.items.add(f); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }""", list(zb))
    pg.wait_for_function('() => window.__phot.mode === "stack"', timeout=30000)
    z2 = pg.evaluate('() => ({ lights: window.__phot.lights.length, first: window.__phot.lights[0].file.relPath })')
    check('a zip dropped on the page (synthetic DragEvent)', z2['lights'] == 10 and z2['first'].startswith('dropped.zip/'), json.dumps(z2))
    if os.path.exists(EXOTIC_ZIP):
        fresh(); t0 = time.time()
        pg.set_input_files('#inFiles', EXOTIC_ZIP)
        pg.wait_for_function('() => window.__phot.mode === "stack" && window.__phot.cur', timeout=120000)
        e = pg.evaluate('() => ({ lights: window.__phot.lights.length, t0: window.__phot.lights[0].jd, t1: window.__phot.lights.at(-1).jd, ordered: window.__phot.lights.every((l, i, a) => !i || a[i - 1].jd <= l.jd), w: window.__phot.cur && window.__phot.cur.width, h: window.__phot.cur && window.__phot.cur.height })')
        check("EXOTIC's sample-data zip (24 MB) through the file input: 142 frames in time order, the first shown", e['lights'] == 142 and e['ordered'] and e['w'] == 650, f"{e['lights']} frames, JD {e['t0']:.5f} to {e['t1']:.5f}, frame {e['w']} x {e['h']}, {time.time() - t0:.1f} s")
        pg.screenshot(path=os.path.join(out, 'zip_exotic.png'))

    if NET:
        # ---- 3. TOI-1873 light curves, sectors chosen, prepared, handed over
        fresh(); t0 = time.time()
        r = call('photometry_find_archive', {'target': 'TOI-1873'})
        prods = r['data']['products'] if r['ok'] else {}
        check('TOI-1873: products listed from the bucket in the browser (CORS)', r['ok'] and any('SPOC 20 s' in x for v in prods.values() for x in v) and any('QLP' in x for v in prods.values() for x in v), f"{len(prods)} sectors, {time.time() - t0:.1f} s: " + '; '.join(f"{k}: {', '.join(v[:3])}{'…' if len(v) > 3 else ''}" for k, v in list(prods.items())[:4]) if r['ok'] else r.get('error'))
        pg.screenshot(path=os.path.join(out, 'archive_picker.png'), full_page=False)
        r = call('photometry_load_archive', {'kind': 'lc', 'cadence': 'shortest', 'sectors': [20, 26, 40]})
        st = r['data']['loaded'] if r['ok'] else {}
        check('three sectors of light curves loaded and stitched (one product per sector, the shortest)', r['ok'] and len(st['parts']) == 3 and any(q['cadence_s'] == 20 for q in st['parts']), json.dumps([(q['segment'], q['cadence_s'], q['points'], q['flux']) for q in st.get('parts', [])]) if r['ok'] else r.get('error'))
        t1 = time.time(); r = call('photometry_prepare', {'window': '1'})
        pr = r['data']['prepared'] if r['ok'] and r['data'].get('prepared') else {}
        check('planets and TOIs looked up, sectors flattened with the transits masked, windows cut', r['ok'] and pr.get('windows', 0) >= 3 and len(r['data']['planets']) >= 2, (f"planets {[(q['name'], q['per'], q['t14_h']) for q in r['data']['planets']]}; {pr.get('points')} points, {pr.get('windows')} windows; per sector {pr.get('per_sector')}; overlaps {pr.get('overlaps')}; {time.time() - t1:.1f} s") if r['ok'] else r.get('error'))
        pg.wait_for_timeout(300); pg.screenshot(path=os.path.join(out, 'prepared.png'), full_page=True)
        r = call('photometry_send_to_analyze', {'which': 'windows'})
        check('the windows are handed to the analyzer', r['ok'], json.dumps(r.get('data') or r.get('error'))[:200])
        pg.goto(base + '/analyze/?handoff=1&skipintro')
        pg.wait_for_function('() => window.__esl && window.__esl.S && window.__esl.S.data && window.__esl.S.data.t.length > 50', timeout=60000)
        a = pg.evaluate('() => ({ n: window.__esl.S.data.t.length, tRef: window.__esl.S.data.tRef, name: window.__esl.S.name, std: window.__esl.S.data.timeStandard, cols: window.__esl.S.data.columns ? Object.keys(window.__esl.S.data.columns) : [] })')
        check('the analyzer loads the prepared windows (BJD_TDB)', a['n'] > 100 and a['tRef'] > 2458000, json.dumps(a))
        pg.screenshot(path=os.path.join(out, 'analyze_handoff.png'))

        # ---- 4. one TESS-SPOC FFI TPF from the single-file list, reduced, prepared
        fresh(); r = call('photometry_find_archive', {'target': 'TIC 328933398'})
        pg.click('#archPick details summary')      # the single-file list is folded under the picker
        btn = pg.locator('#archList button', has_text='pixels').filter(has_text='TESS-SPOC').first
        lab = btn.inner_text().replace('\n', ' '); btn.click()
        pg.wait_for_function('() => window.__phot.mode === "tpf"', timeout=120000)
        r = call('photometry_run')
        check('a TESS-SPOC FFI TPF from the single-file list, reduced', r['ok'] and r['data']['has_result'], f"{lab}: {json.dumps(r.get('data', {}).get('selected') if r['ok'] else r.get('error'))}")
        pg.click('#bPrepTpf'); pg.wait_for_function('() => window.__phot.mode === "series"', timeout=30000)
        r = call('photometry_prepare', {'window': 'auto'})
        pr = r['data']['prepared'] if r['ok'] and r['data'].get('prepared') else {}
        check('"Prepare for transit fitting" from the reduced TPF (window by injection)', r['ok'] and pr.get('points', 0) > 100, json.dumps(pr)[:400] if r['ok'] else r.get('error'))

        # ---- 5. K2-3: TPF, then PLD
        fresh(); r = call('photometry_find_archive', {'target': 'EPIC 201367065'})
        r = call('photometry_load_archive', {'kind': 'tpf'})
        check('K2-3 campaign 1 target pixel file fetched from the bucket', r['ok'] and pg.evaluate('() => window.__phot.mode') == 'tpf', json.dumps(r.get('data') or r.get('error'))[:200])
        r = call('photometry_run')
        pg.click('#bPld'); pg.wait_for_function('() => window.__phot.gp && window.__phot.gp.kind === "pld"', timeout=180000)
        g = pg.evaluate('() => ({ before: window.__phot.gp.cdppBefore, after: window.__phot.gp.cdppAfter, n: window.__phot.gp.ncols, thr: window.__phot.gp.thrusters, note: document.getElementById("gpNote").textContent })')
        check('K2 pixel-level decorrelation on the page', g['after'] < g['before'] / 3, f"CDPP {g['before']:.0f} → {g['after']:.1f} ppm, {g['n']} regressors, thrusters {g['thr']}")
        pg.screenshot(path=os.path.join(out, 'k2_pld.png'), full_page=True)
    br.close()
bad = [e for e in errors if 'favicon' not in e]
check('no page errors', not bad, '; '.join(bad[:5]))
print('ALL OK' if ok else 'SOME CHECKS FAILED')
sys.exit(0 if ok else 1)
