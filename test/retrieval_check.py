# The Retrieval page and the assistant's retrieval tools in a real (headless) Chromium. Not part of `npm test`: it needs
# Python, Playwright, Chrome and the dev server (it runs real fits: about five minutes).
#
#   npm run dev, then  ESL_BASE=http://localhost:5173 .venv/bin/python test/retrieval_check.py /tmp/esl-retrieval
#   (ESL_ONLY=dialogue runs part 2 alone)
#
# 1. The page by its own controls: a simulated spectrum, a fit, the table, the corner plot and the figure; Stop; a
#    spectrum from a file; a second model compared by ln Z; the files to take away.
# 2. Two scripted dialogues through the chat. The model server is played by this script (Playwright answers the LM
#    Studio preset's address with a fixed sequence of tool calls), so what is checked is everything else: the chat,
#    the harness, the page's tools, what goes back to the model, and what the page then shows.
#    a. Retrieval page: retrieval_load_spectrum, retrieval_set, retrieval_run, a final answer.
#    b. Atmosphere page: atmosphere_set, atmosphere_fit_spectrum (the fit in the page's own worker, the data drawn on
#       the spectrum and the model set to the fit).
# Prints one line per check and exits 1 if any failed; screenshots go to the folder given.
import sys, os, json, time
from playwright.sync_api import sync_playwright

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/esl-retrieval'; os.makedirs(out, exist_ok=True)
base = os.environ.get('ESL_BASE', 'http://localhost:5173').rstrip('/')
LLM = 'http://localhost:1234/v1'
ok_all = True
def check(name, cond, info=''):
    global ok_all
    print(('ok   ' if cond else 'FAIL ') + name + ('   ' + info if info else ''), flush=True)
    if not cond: ok_all = False

def sse(chunks): return ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
def tool_call(name, args, n): return sse([{'choices': [{'delta': {'role': 'assistant', 'content': ''}}]}, {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': f'c{n}', 'type': 'function', 'function': {'name': name, 'arguments': ''}}]}}]}, {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': json.dumps(args)}}]}, 'finish_reason': 'tool_calls'}]}])
def say(text): return sse([{'choices': [{'delta': {'content': text[:5]}}]}, {'choices': [{'delta': {'content': text[5:]}, 'finish_reason': 'stop'}]}])

def play(ctx, script, seen):
    """The model server: each chat request takes the next reply of the script (a string, or a function of the request)."""
    def models(route): route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps({'data': [{'id': 'scripted-model'}]}))
    def chat(route):
        if route.request.method == 'OPTIONS': return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        body = json.loads(route.request.post_data or '{}')
        # the set-up card's connection test is a request without tools: it gets a word and takes nothing from the script
        if not body.get('tools'): return route.fulfill(status=200, headers={'content-type': 'text/event-stream', 'access-control-allow-origin': '*'}, body=say('ready, yes'))
        seen.append(body); nxt = script.pop(0) if len(script) > 1 else script[0]
        route.fulfill(status=200, headers={'content-type': 'text/event-stream', 'access-control-allow-origin': '*'}, body=nxt(body) if callable(nxt) else nxt)
    ctx.route(LLM + '/chat/completions', chat); ctx.route(LLM + '/models', models)
    ctx.route('http://localhost:1234/api/**', lambda r: r.fulfill(status=404, headers={'access-control-allow-origin': '*'}, body='{}'))

def open_chat(pg):
    pg.wait_for_selector('#esl-ai-launch'); pg.evaluate('() => { localStorage.removeItem("esl.assistant.chat.v1"); localStorage.removeItem("esl.assistant.project.v1"); }')
    pg.click('#esl-ai-launch'); pg.wait_for_function('() => window.__eslAssistant'); pg.evaluate('() => window.__eslAssistant.ready')
    pg.evaluate('(o) => window.__eslAssistant.configure(o)', dict(base=LLM, model='scripted-model'))
def talk(pg, text, limit=600):
    pg.fill('.ai-input', text); pg.click('.ai-send'); t0 = time.time()
    while time.time() - t0 < limit:
        pg.wait_for_timeout(500)
        st = pg.evaluate('() => ({ working: window.__eslAssistant.working, allow: !!document.querySelector(".ai-allow") })')
        if st['allow']: pg.click('.ai-allow')
        elif not st['working']: break
    return time.time() - t0
def tool_results(seen):
    """What the page's tools sent back to the model: the role "tool" messages of every request (older ones are
    shortened in later requests, so each is taken where it first appears), parsed where JSON."""
    res = []; had = set()
    for m in [m for q in seen for m in q['messages']]:
        if m.get('role') == 'tool' and m.get('tool_call_id') not in had:
            had.add(m.get('tool_call_id')); c = m.get('content') if isinstance(m.get('content'), str) else json.dumps(m.get('content'))
            c = c.split('\n\nCURRENT STATE')[0]
            try: res.append(json.JSONDecoder().raw_decode(c.lstrip())[0])   # a note may follow the JSON
            except Exception: res.append(c)
    return res
def painted(pg, sel):
    """How much of a canvas is not its background colour (0 to 1): a drawn figure against an empty one."""
    return pg.evaluate('''(sel) => { const c = document.querySelector(sel); if (!c || c.width < 10) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, tot = 0; for (let i = 0; i < d.length; i += 4 * 7) { tot++; if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24) n++; } return n / tot; }''', sel)

with sync_playwright() as p:
    b = p.chromium.launch(); errs = []
    def page(ctx):
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)[:300])); pg.on('console', lambda m: errs.append('console.error ' + m.text[:300]) if m.type == 'error' and 'localhost:1234' not in m.text + str(m.location.get('url', '')) else None); return pg

    # ------------------------------------------------------------------------------------------------ 1. the page
    if os.environ.get('ESL_ONLY', 'page') == 'page' or os.environ.get('ESL_ONLY') is None:   # ESL_ONLY=dialogue skips to part 2
        ctx = b.new_context(viewport={'width': 1400, 'height': 1000}, accept_downloads=True); pg = page(ctx)
        pg.goto(base + '/analyze/retrieval/'); pg.wait_for_function('() => window.__esl && window.__esl.retrieval && window.__esl.retrieval.ready()', timeout=120000)
        R = lambda expr: pg.evaluate('() => { const R = window.__esl.retrieval.R; return ' + expr + '; }')
        check('the page opens on a simulated spectrum of the first preset', R('R.data.length') == 1 and R('R.data[0].simulated') and R('R.data[0].wl.length') > 30 and 'Simulated' in pg.inner_text('#stData') and painted(pg, '#cvFit') > 0.01,
              pg.inner_text('#stData')[:110])
        check('the sub-navigation has the page between Atmosphere and Star', pg.evaluate('() => [...document.querySelectorAll("#subnav a")].map((a) => a.textContent.trim()).join("|")').find('Atmosphere|Retrieval|Star') >= 0)

        # Stop: a fit that would take minutes ends at once and leaves the page ready for another
        pg.click('#bFit'); pg.wait_for_function('() => /Fitting: \\d+ models/.test(document.getElementById("stRun").textContent)', timeout=120000)
        t0 = time.time(); pg.click('#bStop'); pg.wait_for_function('() => !window.__esl.retrieval.R.busy', timeout=5000); dt = time.time() - t0
        check('Stop ends a running fit at once and keeps nothing from it', dt < 3 and 'Stopped' in pg.inner_text('#stRun') and R('R.result') is None and R('R.runs.length') == 0 and pg.is_enabled('#bFit') and not pg.is_enabled('#bStop'), f'{dt:.1f} s; "{pg.inner_text("#stRun")}"')

        # the fit, by the button
        pg.click('#bFit'); t0 = time.time(); pg.wait_for_function('() => !window.__esl.retrieval.R.busy && !!window.__esl.retrieval.R.result', timeout=900000); dt = time.time() - t0
        r = pg.evaluate('() => { const r = window.__esl.retrieval.R.result; return { converged: r.converged, keys: r.keys, summary: r.summary, truth: r.sent.truth, chi2: r.chi2, ndata: r.ndata, ncalls: r.ncalls, logZ: r.logZ, band: !!r.band, n: r.post.n, merge: r.merge }; }')
        z = {k: (r['summary'][k]['median'] - r['truth'][k]) / (0.5 * (r['summary'][k]['hi'] - r['summary'][k]['lo'])) for k in r['keys']}
        check('a fit started with the button converges and returns what the spectrum was made from', r['converged'] and all(abs(v) < 3 for v in z.values()) and r['chi2'] < 1.6 * r['ndata'] and r['band'],
              f"{r['ncalls']} models in {dt:.0f} s, chi2 {r['chi2']:.1f} for {r['ndata']} points, ln Z {r['logZ']:.2f}; (median - put in)/sigma: " + ', '.join(f'{k} {v:+.1f}' for k, v in z.items()) + ' (tolerance 3)')
        rows = pg.evaluate('() => [...document.querySelectorAll("#resTable tr")].map((tr) => [...tr.children].map((c) => c.textContent))')
        check('the result table has a row for each free parameter, with what was put in and how far off the median is', len(rows) == 1 + len(r['keys']) and rows[0][-2:] == ['Put in', 'Off by'] and all('σ' in x[-1] for x in rows[1:]) and 'Converged' in pg.inner_text('#stResult'), pg.inner_text('#stResult')[:120])
        cw = pg.evaluate('() => { const c = document.getElementById("cvCorner"); return [c.width, c.height]; }')
        check('the corner plot is drawn, with a panel for every pair', cw[0] >= 500 and cw[1] >= 500 and painted(pg, '#cvCorner') > 0.05, f'canvas {cw[0]} x {cw[1]}, {100 * painted(pg, "#cvCorner"):.0f}% of it drawn on')
        pg.locator('#cvFit').scroll_into_view_if_needed(); pg.screenshot(path=os.path.join(out, 'page_spectrum.png')); pg.locator('#cvCorner').scroll_into_view_if_needed(); pg.screenshot(path=os.path.join(out, 'page_corner.png'))
        ex = pg.evaluate('() => { const E = window.__esl.retrieval, f = E.figureCanvas(), c = E.cornerCanvas(); const white = (cv) => { const d = cv.getContext("2d").getImageData(2, 2, 1, 1).data; return d[0] > 250 && d[1] > 250 && d[2] > 250; }; return { fig: [f.width, f.height, white(f)], corner: [c.width, c.height, white(c)] }; }')
        check('the figures for export are drawn on white at print size', ex['fig'][0] == 1800 and ex['fig'][2] and ex['corner'][0] >= 1400 and ex['corner'][2], json.dumps(ex))
        with pg.expect_download() as dl: pg.click('text=Save samples (CSV)')
        f = os.path.join(out, 'samples.csv'); dl.value.save_as(f); lines = open(f).read().strip().split('\n')
        check('the posterior samples are saved with their weights', lines[1].split(',')[:2] == ['weight', 'ln_likelihood'] and lines[1].split(',')[2:] == r['keys'] and len(lines) > 500 and abs(sum(float(l.split(',')[0]) for l in lines[2:]) - 1) < 1e-3, f'{len(lines) - 2} rows; the weights sum to {sum(float(l.split(",")[0]) for l in lines[2:]):.5f}')
        with pg.expect_download() as dl: pg.click('text=Save result (JSON)')
        f = os.path.join(out, 'result.json'); dl.value.save_as(f); J = json.load(open(f))
        check('the result is saved with its limits, its data and the best fit', J['format'] == 'esl-retrieval' and J['converged'] and set(J['summary']) == set(r['keys']) and len(J['data'][0]['best_fit']) == r['ndata'] and J['model']['opacity_bins_joined'] == r['merge'] and J['put_in'] is not None)

        # a second model of the same data: without CO2, compared by the evidence
        pg.select_option('select[data-key="logX_CO2"]', 'off'); pg.click('#bFit'); pg.wait_for_function('() => !window.__esl.retrieval.R.busy && window.__esl.retrieval.R.runs.length === 2', timeout=900000)
        runs = R('R.runs.map((x) => ({ logZ: x.logZ, converged: x.converged, free: x.free }))'); txt = pg.inner_text('#runsTable')
        check('a second model of the same spectrum is compared with the first by ln Z', len(runs) == 2 and all(x['converged'] for x in runs) and 'logX_CO2' not in runs[1]['free'] and 'highest ln Z' in txt and 'Δ ln Z' in txt, f"ln Z {runs[0]['logZ']:.2f} with CO2 free, {runs[1]['logZ']:.2f} without: " + txt.split('\n')[-1][-90:])

        # a spectrum from a file (three columns, ppm): replaces nothing, is listed, and the truth marks go
        sim = R('({ wl: R.data[0].wl, y: R.data[0].y, err: R.data[0].err })'); f = os.path.join(out, 'observed.csv')
        open(f, 'w').write('# wavelength_micron, depth_ppm, error_ppm\n' + '\n'.join(f'{w:.6f}, {1e6 * y:.2f}, {1e6 * e:.2f}' for w, y, e in zip(sim['wl'], sim['y'], sim['err'])) + '\n')
        pg.select_option('#fileUnit', 'ppm'); pg.set_input_files('#file', f); pg.wait_for_function('() => window.__esl.retrieval.R.data.length === 2')
        d = R('({ name: R.data[1].name, n: R.data[1].wl.length, y0: R.data[1].y[0], lo: !!R.data[1].lo, truth: R.truth })')
        check('a spectrum is read from a file in ppm, and a fit of real data shows no "put in" column', d['name'] == 'observed.csv' and d['n'] == len(sim['wl']) and abs(d['y0'] - sim['y'][0]) < 1e-8 and not d['lo'] and d['truth'] is None and 'no bin edges' in pg.inner_text('#stData'), pg.inner_text('#stData')[:150])
        bad = os.path.join(out, 'bad.csv'); open(bad, 'w').write('time,flux\n1,2\n3,4\n'); pg.set_input_files('#file', bad); pg.wait_for_timeout(400)
        check('a file that is not a spectrum is refused in words', 'needs at least 3 rows' in pg.inner_text('#stData') and R('R.data.length') == 2, pg.inner_text('#stData')[:120])
        ctx.close()

    # ------------------------------------------------------------------------------- 2a. dialogue, Retrieval page
    ctx = b.new_context(viewport={'width': 1400, 'height': 1000}); seen = []
    script = [tool_call('retrieval_load_spectrum', {'file': 'w39_like.csv', 'kind': 'transit', 'unit': 'ppm', 'replace': True}, 1),
              tool_call('retrieval_set', {'off': ['logX_CO2'], 'limits': {'t': [800, 2000], 'logX_H2O': [-7, -1]}, 'max_models': 40000}, 2),
              tool_call('retrieval_run', {}, 3), say('The fit converged. Water is measured; the temperature and radius are in the table on the page.')]
    play(ctx, script, seen); pg = page(ctx)
    pg.goto(base + '/analyze/retrieval/'); pg.wait_for_function('() => window.__esl && window.__esl.retrieval && window.__esl.retrieval.ready()', timeout=120000)
    open_chat(pg)
    sim = pg.evaluate('() => { const d = window.__esl.retrieval.R.data[0]; return { wl: d.wl, lo: d.lo, hi: d.hi, y: d.y, err: d.err }; }')
    text = 'wavelength,bin_low,bin_high,depth_ppm,error_ppm\n' + '\n'.join(f'{w:.6f},{a:.6f},{c:.6f},{1e6 * y:.3f},{1e6 * e:.3f}' for w, a, c, y, e in zip(sim['wl'], sim['lo'], sim['hi'], sim['y'], sim['err'])) + '\n'
    pg.evaluate('(t) => window.__eslAssistant.files.write("w39_like.csv", t, "text/csv")', text)
    dt = talk(pg, 'Fit the transit spectrum in w39_like.csv: temperature, water and radius.')
    res = tool_results(seen); names = [t['function']['name'] for t in seen[0].get('tools', [])]; fit = next((x for x in res if isinstance(x, dict) and 'models_computed' in x), None)
    st = pg.evaluate('() => { const R = window.__esl.retrieval.R, r = R.result; return { data: R.data.map((d) => d.name), free: r && r.keys, converged: r && r.converged, prior: r && r.priors.t, text: [...document.querySelectorAll("#assistant .ai-msg")].map((m) => m.textContent).join(" | ") }; }')
    check('the Retrieval page offers its tools to the model', all(n in names for n in ('retrieval_get', 'retrieval_set', 'retrieval_load_spectrum', 'retrieval_run')), ', '.join(n for n in names if n.startswith('retrieval_')))
    check('dialogue on the Retrieval page: the file is loaded, the set-up changed, the fit run, and the result returned to the model', len(seen) == 4 and fit is not None and fit.get('converged') is True and set(fit['parameters']) == {'t', 'logX_H2O', 'rplanet'} and fit['parameters']['t']['searched_between'] == [800, 2000] and 'ln_Z' in fit,
          f'{len(seen)} requests in {dt:.0f} s; the model was told: ' + (', '.join(f"{k} {v['value']} +{v['plus']} -{v['minus']}" for k, v in fit['parameters'].items()) + f"; ln Z {fit['ln_Z']['value']}, chi2 {fit['chi2']}, {fit['models_computed']} models" if fit else str(res)[:300]))
    check('the page shows what the dialogue did, and the chat the final answer', st['data'] == ['w39_like.csv'] and st['free'] == ['t', 'logX_H2O', 'rplanet'] and st['converged'] and st['prior'] == {'type': 'uniform', 'a': 800, 'b': 2000} and 'The fit converged' in st['text'] and painted(pg, '#cvCorner') > 0.05)
    pg.screenshot(path=os.path.join(out, 'dialogue_retrieval.png')); ctx.close()

    # ------------------------------------------------------------------------------ 2b. dialogue, Atmosphere page
    ctx = b.new_context(viewport={'width': 1400, 'height': 1000}); seen = []
    script = [tool_call('atmosphere_set', {'profile': 'guillot'}, 1), tool_call('atmosphere_fit_spectrum', {'file': 'obs.csv', 'kind': 'transit', 'unit': 'ppm', 'free': ['teq', 'rplanet'], 'max_models': 30000, 'max_seconds': 500}, 2), say('Done: the model on the page is now the fit.')]
    play(ctx, script, seen); pg = page(ctx)
    pg.goto(base + '/analyze/atmosphere/'); pg.wait_for_function('() => window.__esl && window.__esl.atmosphere && window.__esl.atmosphere.ready()', timeout=180000)
    open_chat(pg)
    # the spectrum to fit: the page's own Guillot model at R = 20 with 60 ppm of noise added here (a seeded generator)
    tools = lambda name, args: pg.evaluate('([n, a]) => window.__esl.atmosphere.tools.find((t) => t.name === n).run(a, { files: window.__eslAssistant.files })', [name, args])
    tools('atmosphere_set', {'profile': 'guillot'}); before = tools('atmosphere_get', {}); tab = tools('atmosphere_spectrum', {'wl_min': 0.6, 'wl_max': 5.2, 'R': 20})
    seed = 12345; noisy = []
    for wv, dep, *_ in tab['rows']:
        u = []
        for _ in range(12): seed = (1103515245 * seed + 12345) % 2 ** 31; u.append(seed / 2 ** 31)
        noisy.append((wv, dep + 60 * (sum(u) - 6), 60))
    pg.evaluate('(t) => window.__eslAssistant.files.write("obs.csv", t, "text/csv")', 'wavelength_um,depth_ppm,error_ppm\n' + '\n'.join(f'{a},{c:.2f},{e}' for a, c, e in noisy) + '\n')
    tools('atmosphere_set', {'profile': 'consistent'})   # back to the page's default: the dialogue has to change it itself
    dt = talk(pg, 'Fit the model to obs.csv (transit depths in ppm): the temperature and the radius.')
    res = tool_results(seen); fit = next((x for x in res if isinstance(x, dict) and 'models_computed' in x), None); after = tools('atmosphere_get', {})
    t_in, r_in = before['temperature_profile'].get('teq_K', None), before['radius_Rjup']
    ok = fit is not None and fit.get('converged') is True and set(fit['parameters']) == {'teq', 'rplanet'}
    zr = abs(fit['parameters']['rplanet']['value'] - r_in) / (0.5 * (fit['parameters']['rplanet']['plus'] + fit['parameters']['rplanet']['minus'])) if ok else 99
    check('dialogue on the Atmosphere page: the profile is changed, the spectrum fitted in the page, and the result returned to the model', ok and len(seen) == 3 and zr < 3 and fit['chi2'] < 1.8 * fit['data_points'],
          (f"{len(seen)} requests in {dt:.0f} s; teq {fit['parameters']['teq']['value']} +{fit['parameters']['teq']['plus']} -{fit['parameters']['teq']['minus']}, radius {fit['parameters']['rplanet']['value']} +{fit['parameters']['rplanet']['plus']} -{fit['parameters']['rplanet']['minus']} ({r_in} put in, {zr:.1f} sigma); chi2 {fit['chi2']} for {fit['data_points']} points, {fit['models_computed']} models" if fit else ' | '.join(str(x)[:300] for x in res[1:])))
    check('the Atmosphere page then shows the fit: its model is the median and the Stop button is gone', ok and abs(after['radius_Rjup'] - fit['parameters']['rplanet']['value']) < 1e-3 and after['temperature_profile']['kind'] == 'guillot' and pg.query_selector('#bStopFit') is None and 'Done: the model' in pg.inner_text('#assistant'), f"radius on the page {after['radius_Rjup']}")
    pg.screenshot(path=os.path.join(out, 'dialogue_atmosphere.png')); ctx.close()

    check('no page error or console error in any of it', not errs, '; '.join(errs[:4]))
    b.close()
print('\nall ok' if ok_all else '\nFAILED'); sys.exit(0 if ok_all else 1)
