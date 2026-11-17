# Live check of the assistant's chat window in a real (headless) browser against a real OpenAI-compatible
# endpoint, across the pages of the site. Not part of `npm test`. Needs a served copy of the site and Playwright
# in the project virtualenv. Without ESL_LLM the page uses the set-up card's default preset (src/assistant/presets.js);
# an address given in ESL_LLM is never printed.
#
#   [ESL_LLM=<base URL of your server>] ESL_BASE=<where the site is served> \
#       .venv/bin/python test/assistant_live.py /tmp/esl-assistant [--only 1,3] [--attach path.csv] [--width 1440 --height 900]
#   (ESL_LLM_MODEL and ESL_LLM_KEY are optional; ESL_BASE defaults to the Vite dev server)
#
# For each task it opens the task's page, opens the bubble, sends the request in a fresh conversation, clicks
# "Allow" on confirmations, follows the assistant when it changes page, and prints the transcript, the verdict of
# the number check, the number of model steps and the seconds. A screenshot per task goes to the output folder.
import sys, json, os, time
from playwright.sync_api import sync_playwright
args = sys.argv[1:]
def opt(name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
only = opt('--only'); attach = opt('--attach'); width = int(opt('--width', '1440')); height = int(opt('--height', '900'))
out = args[0] if args else '/tmp/esl-assistant'
endpoint = os.environ.get('ESL_LLM'); base = os.environ.get('ESL_BASE', 'http://localhost:5173').rstrip('/')
os.makedirs(out, exist_ok=True)
TASKS = [
    dict(id=1, page='plan/', ask='Plan the transits of WASP-43 b from Kitt Peak over the next 30 nights and tell me when the first one is. Then open that transit in the analyzer and set up a fit with Rp/R*, the inclination and the mid-transit time free (do not run it).'),
    dict(id=2, page='analyze/?skipintro', ask='Load the single-transit example without its stored result and set 100 live points. Then try a circular against an eccentric orbit and tell me which the data prefer, with the numbers.'),
    dict(id=3, page='analyze/?skipintro', keep=True, ask='What do these results mean? Explain the main numbers in plain words, then give me the light-curve figure and a Markdown report.'),
    dict(id=4, page='search/', ask='Find the transiting planets with periods under 1 day that are brighter than magnitude 10, and give me the period of the brightest one with its uncertainty and reference.'),
    dict(id=5, page='methods/#validation', ask='How well does the transit model agree with other codes? Quote the numbers and what they were compared with.'),
    dict(id=6, page='', ask='Show me where WASP-43 b is in the sky right now from Kitt Peak (latitude 31.96, longitude -111.60).'),
    dict(id=7, page='analyze/?skipintro', attach=attach, ask='Fit the transit in the file I attached. The planet is HD 80606 b. Then give me the light-curve figure.'),
    dict(id=8, page='analyze/?skipintro', ask='Load the single-transit example, save the analysis under the name "old", then delete the saved analysis "old".'),
    dict(id=9, page='analyze/?skipintro', attach=attach, ask='I attached a TESS light curve of HD 80606 b. Set up the project: get the system parameters and priors from the catalogue, fit the transit, explain the results, then search the residuals for another periodic signal. Finish with the standard report.'),
    dict(id=11, page='plan/', ask='Which transits of WASP-12 b can I observe from Kitt Peak between January and July? Give me the first three.'),
    dict(id=12, page='plan/', ask='Plan transits from La Silla for the first week of March, transits deeper than 10 ppt only.'),
    dict(id=13, page='analyze/photometry/?demo=3', ask='Check the focus of these frames, solve the sky coordinates for HAT-P-32, rank the comparison stars with Gaia and set the apertures from the stars. Then run the reduction and send the light curve to Analyze.'),
    dict(id=14, page='analyze/spectroscopy/', ask='Simulate a JWST observation of a hot Jupiter, fit the white light curve, then fit the channels and give me the transmission spectrum.'),
    dict(id=15, page='observe/', ask='Show me HAT-P-32 from Kitt Peak tonight, then load a DSS image of its field and tell me how many comparison stars within one magnitude are in a 15 arcminute field.'),
    dict(id=16, page='search/', ask='Find transiting planets with periods under 3 days and depths over 15 ppt brighter than V = 11, sorted by brightness, and show me the first one with its references.'),
    dict(id=17, page='plan/', ask='Plan the transits of WASP-43 b from La Silla between February and April.'),
    dict(id=18, page='analyze/?skipintro', ask='Open the orbital decay of WASP-12 b example, fit a linear and a quadratic ephemeris, and tell me the period change dP/dt and which model the data prefer.'),
    dict(id=19, page='analyze/?skipintro', ask='Open the example with 40 simulated mid-transit times, fit the ephemeris, and search the timing residuals for a periodic signal.'),
    dict(id=10, page='methods/', ask='How does this site compute the equilibrium temperature? Give the exact equation and the assumptions behind it.'),
]
if only: TASKS = [t for t in TASKS if str(t['id']) in only.split(',')]
TASKS = [t for t in TASKS if not ('attach' in t and not t['attach'])]
errs = []
_print = print
def print(*a, **k):
    """the endpoint's address never reaches the output, even inside an error message of the page"""
    if not endpoint: return _print(*a, **k)
    host = endpoint.split('//')[-1].split('/')[0]
    _print(*[str(x).replace(endpoint, '<endpoint>').replace(host, '<host>') for x in a], **k)
def js(pg, expr, arg=None, default=None):
    """evaluate, tolerating a page that is in the middle of changing"""
    for _ in range(40):
        try: return pg.evaluate(expr, arg)
        except Exception:
            pg.wait_for_timeout(250)
    return default
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': width, 'height': height})
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: errs.append('console.error ' + m.text) if m.type == 'error' and (not endpoint or endpoint not in m.text) else None)
    # other work on the source tree makes the dev server reload the page; a check must not be interrupted by that
    ctx.add_init_script("const WS = window.WebSocket; window.WebSocket = function (url, protocols) { if (String(protocols).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new WS(url, protocols); };")
    tally = []
    for t in TASKS:
        pg.goto(base + '/' + t['page']); pg.wait_for_selector('#esl-ai-launch')
        if not js(pg, '() => !!window.__eslAssistant'): pg.click('#esl-ai-launch')
        pg.wait_for_function('() => window.__eslAssistant'); js(pg, '() => window.__eslAssistant.ready')
        if not js(pg, '() => !document.querySelector("#assistant").hidden'): pg.click('#esl-ai-launch')
        # the address goes straight into the page's memory: it is typed nowhere and shown nowhere in this script's output
        js(pg, '(o) => window.__eslAssistant.configure(o)', dict(base=endpoint, model=os.environ.get('ESL_LLM_MODEL', ''), apiKey=os.environ.get('ESL_LLM_KEY', '')) if endpoint else {})
        if t['id'] == TASKS[0]['id']: print('model:', js(pg, '() => window.__eslAssistant.settings.model'), '· context', js(pg, '() => window.__eslAssistant.settings.context'))
        if not t.get('keep'): js(pg, '() => window.__eslAssistant.newChat()')
        if t.get('attach'): pg.set_input_files('#assistant input.ai-file', t['attach']); pg.wait_for_timeout(400)
        n0 = js(pg, '() => window.__eslAssistant.log.length', default=0)
        print('\n' + '=' * 100 + f"\nTASK {t['id']} on /{t['page']}  USER: {t['ask']}" + (f"   [attached {os.path.basename(t['attach'])}]" if t.get('attach') else ''))
        pg.fill('.ai-input', t['ask']); pg.click('.ai-send'); t0 = time.time(); pages = [js(pg, '() => window.__eslAssistant.page')]; quiet = 0
        while True:
            pg.wait_for_timeout(400)
            st = js(pg, '() => (window.__eslAssistant ? { working: window.__eslAssistant.working, page: window.__eslAssistant.page, allow: !!document.querySelector(".ai-allow"), pending: !!(JSON.parse(localStorage.getItem("esl.assistant.chat.v1") || "{}").pending) } : null)')
            if st is None: continue                      # the next page is loading
            if st['page'] != pages[-1]: pages.append(st['page']); print(f"   [the assistant moved to the {st['page']} page]")
            if st['allow']:
                if t['id'] == 8 and 'delet' in (js(pg, '() => document.querySelector(".ai-confirm p").textContent') or '').lower(): pg.click('.ai-deny'); print('   [the user clicked Decline]')
                else: pg.click('.ai-allow'); print('   [the user clicked Allow]')
            quiet = quiet + 1 if not st['working'] and not st['pending'] else 0
            if quiet >= 4: break
            if time.time() - t0 > 900: print('   TIMEOUT'); js(pg, '() => document.querySelector(".ai-stop").click()'); break
        log = js(pg, '(n) => window.__eslAssistant.log.slice(n)', n0, default=[])
        steps = 0; secs = 0.0
        for ev in log:
            k = ev['type']
            if k == 'tool_start': print(f"  -> [{ev.get('page')}] {ev['name']} {json.dumps(ev.get('args'))}")
            elif k == 'tool_end': print(f"     {'declined' if ev.get('denied') else 'ok' if ev['ok'] else 'FAILED'} ({ev['ms']} ms) {ev['text'][:600]}{'…' if len(ev['text']) > 600 else ''}")
            elif k == 'assistant': print(('\nANSWER: ' if ev.get('final') else '  .. ') + ev['text'])
            elif k in ('note', 'error'): print(f"  [{k}] {ev.get('text') or ev.get('message')}")
            elif k == 'figure': print(f"  [figure shown in the chat: {ev['name']}]")
            elif k == 'context' and ev.get('trimmed'): print(f"  [context] {ev['tokens']} of {ev['limit']}: {ev['trimmed']}")
            elif k == 'cap': print(f"  [cap after {ev['steps']} steps]")
            elif k == 'done': steps += ev['steps']; secs += ev['seconds']; print(f"\n== {ev['reason']}: {ev['steps']} model steps, {ev['seconds']:.1f} s; prompt tokens {(ev.get('usage') or {}).get('prompt_tokens')} ==")
        info = js(pg, '() => { const A = window.__eslAssistant, t = A.agent && A.agent.turns.at(-1); return { page: A.page, check: t && t.check, answered: !!(t && t.final), files: A.files.list().map((f) => f.name + " (" + f.origin + ")"), actions: A.acts.map((a) => a.page + ":" + a.name), figures: document.querySelectorAll("#assistant .ai-fig img").length, canUndo: !!(A.tools && A.tools.canUndo()) }; }', default={})
        print('afterwards:', json.dumps(info))
        tally.append(dict(task=t['id'], pages=' -> '.join(pages), answered=info.get('answered'), steps=steps, seconds=round(secs, 1), number_check=(info.get('check') or {}).get('ok'), files=len(info.get('files') or []), failed_calls=sum(1 for e in log if e['type'] == 'tool_end' and not e['ok'] and not e.get('denied'))))
        pg.screenshot(path=os.path.join(out, f"task{t['id']}.png"))
        # the conversation as training data (src/assistant/sft.js), one JSON line per task
        rec = js(pg, '() => window.__eslAssistant.trainingRecord()', default=None)
        if rec: open(os.path.join(out, 'conversations.jsonl'), 'a').write(json.dumps(rec).replace(endpoint or '\0', '<endpoint>') + '\n')
    open(os.path.join(out, 'transcript.md'), 'w').write((js(pg, '() => window.__eslAssistant.transcript()', default='') or '').replace(endpoint or '\0', '<endpoint>'))
    b.close()
print('\nTALLY')
for r in tally: print(' ', json.dumps(r))
for e in errs: print(e)
print('errors:', len(errs))
