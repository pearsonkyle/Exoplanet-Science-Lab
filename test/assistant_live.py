# Live check of the assistant panel in a real (headless) browser against a real OpenAI-compatible endpoint.
# Not part of `npm test`. Needs the dev server on :5173 and Playwright in the project virtualenv:
#   .venv/bin/python test/assistant_live.py http://host:1234/v1 /tmp/esl-assistant [--only 1,3] [--attach path.csv]
# It opens analyze/?skipintro, opens the assistant, sets the endpoint, runs each task in a fresh conversation
# (clicking "Allow" on confirmations), and prints the transcript, the number of model steps and the seconds.
import sys, json, os, time
from playwright.sync_api import sync_playwright
args = sys.argv[1:]
def opt(name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
only = opt('--only'); attach = opt('--attach'); url = opt('--url', 'http://localhost:5173/analyze/?skipintro'); width = int(opt('--width', '1440')); height = int(opt('--height', '900'))
endpoint, out = args[0], (args[1] if len(args) > 1 else '/tmp/esl-assistant')
os.makedirs(out, exist_ok=True)
TASKS = [
    dict(id=1, ask='Load the single-transit example, free the eccentricity, run the fit and report Rp/R*.'),
    dict(id=2, ask='Fit the transit in the file I attached. The planet is HD 80606 b.', attach=attach),
    dict(id=3, ask='Load the single-transit example without its stored result. Then compare a circular and an eccentric orbit and tell me which the data prefer.'),
    dict(id=4, ask='What do these results mean? Explain the main numbers in plain words.'),
    dict(id=5, ask='Look up WASP-12 b, simulate a light curve with 400 ppm noise, fit Rp/R*, the inclination and the mid-transit time, then save a Markdown report and the session file for me.'),
]
if only: TASKS = [t for t in TASKS if str(t['id']) in only.split(',')]
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': width, 'height': height})
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: errs.append('console.error ' + m.text) if m.type == 'error' else None)
    # other work on the source tree makes the dev server reload the page; a check must not be interrupted by that
    pg.add_init_script("const WS = window.WebSocket; window.WebSocket = function (url, protocols) { if (String(protocols).includes('vite')) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 0 }; return new WS(url, protocols); };")
    pg.goto(url); pg.wait_for_timeout(2500)
    pg.click('#aibtn'); pg.wait_for_selector('#assistant')
    pg.fill('.ai-base', endpoint); pg.click('.ai-testbtn')
    pg.wait_for_selector('.ai-test.ok, .ai-test.bad', timeout=20000)
    print('connection:', pg.inner_text('.ai-test'))
    pg.screenshot(path=os.path.join(out, 'settings.png'))
    pg.click('.ai-settings .btn.primary')
    for t in TASKS:
        if t['id'] != 4: pg.evaluate('() => { const b = [...document.querySelectorAll("#assistant .ai-head .chip")].find((x) => x.textContent === "New"); b.click(); }')
        if t.get('attach'): pg.set_input_files('#assistant input[type=file]', t['attach'])
        n0 = pg.evaluate('() => window.__eslAssistant.log.length')
        print('\n' + '=' * 100 + f"\nTASK {t['id']}  USER: {t['ask']}" + (f"   [attached {os.path.basename(t['attach'])}]" if t.get('attach') else ''))
        pg.fill('.ai-input', t['ask']); pg.click('.ai-send'); t0 = time.time()
        while True:
            pg.wait_for_timeout(400)
            if pg.query_selector('.ai-allow'): pg.click('.ai-allow'); print('   [the user clicked Allow]')
            if not pg.evaluate('() => window.__eslAssistant.working'): break
            if time.time() - t0 > 900: print('   TIMEOUT'); pg.click('.ai-stop'); break
        log = pg.evaluate('(n) => window.__eslAssistant.log.slice(n)', n0)
        for ev in log:
            k = ev['type']
            if k == 'tool_start': print(f"  -> {ev['name']} {json.dumps(ev.get('args'))}")
            elif k == 'tool_end': print(f"     {'declined' if ev.get('denied') else 'ok' if ev['ok'] else 'FAILED'} ({ev['ms']} ms) {ev['text'][:700]}{'…' if len(ev['text']) > 700 else ''}")
            elif k == 'assistant': print(('\nANSWER: ' if ev.get('final') else '  .. ') + ev['text'])
            elif k in ('note', 'error'): print(f"  [{k}] {ev.get('text') or ev.get('message')}")
            elif k == 'context' and ev.get('trimmed'): print(f"  [context] {ev['tokens']} of {ev['limit']}: {ev['trimmed']}")
            elif k == 'cap': print(f"  [cap after {ev['steps']} steps]")
            elif k == 'done': print(f"\n== {ev['reason']}: {ev['steps']} model steps, {ev['seconds']:.1f} s; prompt tokens {(ev.get('usage') or {}).get('prompt_tokens')} ==")
        st = pg.evaluate('() => { const s = window.__esl.api.state(), r = window.__esl.api.results(); return { name: s.name, free: s.parameters.filter((p) => p.free).map((p) => p.key), hasResult: s.hasResult, rprs: r ? r.parameters.find((p) => p.key === "rprs") : null, files: window.__eslAssistant.files.list().map((f) => f.name + " (" + f.origin + ")") }; }')
        print('page afterwards:', json.dumps(st))
        pg.screenshot(path=os.path.join(out, f"task{t['id']}.png"))
    open(os.path.join(out, 'transcript.md'), 'w').write(pg.evaluate('() => window.__eslAssistant.transcript()'))
    b.close()
for e in errs: print(e)
print('errors:', len(errs))
