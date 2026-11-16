# End-to-end session with the site's assistant, driven only through the chat, in a headless browser against a real
# model server. Not part of `npm test`. Needs a served copy of the site and Playwright in the project virtualenv.
#
#   ESL_BASE=http://localhost:8942 .venv/bin/python test/assistant_e2e.py /tmp/esl-e2e [--width 390 --height 844] [--sessions 1,2]
#   ESL_LLM=<base URL> to use another server than the set-up card's default preset; ESL_LLM_MODEL, ESL_LLM_KEY optional.
#
# Session 1 starts on the landing page with the owner's planning-and-analysis request; session 2 continues the same
# conversation (archival velocities and a joint fit). For every model request it records the prompt tokens the server
# reports (`usage`, read from the streamed response) and the size of the request; for every tool call its page, name,
# arguments, result and time. It clicks "Allow" on confirmations and "Continue" at the step cap (at most three times),
# which is what a user would do in the chat. It writes e2e.json, transcript.md and a screenshot per session.
import sys, json, os, time
from playwright.sync_api import sync_playwright
args = sys.argv[1:]
def opt(name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
width = int(opt('--width', '1440')); height = int(opt('--height', '900')); sessions = opt('--sessions', '1,2').split(',')
out = args[0] if args else '/tmp/esl-e2e'
base = os.environ.get('ESL_BASE', 'http://localhost:8942').rstrip('/'); endpoint = os.environ.get('ESL_LLM', '')
os.makedirs(out, exist_ok=True)
ASKS = {
    '1': "I'm at Kitt Peak. Find a good transit to observe in the next week, pick the best one, tell me when and why; then set up the analysis for that planet in Analyze with a simulated light curve for that night, fit it, and give me Rp/R★ and the mid-transit time with uncertainties and a figure.",
    '2': 'Now add the archival radial velocities for that planet if you can find them and do a joint fit',
}
requests = []   # one per model request: { at, page, request_chars, prompt_tokens, completion_tokens }
errs = []
def js(pg, expr, arg=None, default=None):
    for _ in range(60):
        try: return pg.evaluate(expr, arg)
        except Exception: pg.wait_for_timeout(250)
    return default
def on_done(req):
    if not req.url.endswith('/chat/completions') or req.method != 'POST': return
    rec = dict(at=time.time(), page=req.frame.url.split('/')[3] if req.frame else '', request_chars=len(req.post_data or ''), prompt_tokens=None, completion_tokens=None)
    try:
        body = json.loads(req.post_data or '{}'); rec['messages'] = len(body.get('messages', [])); rec['tools'] = len(body.get('tools', []) or [])
        rec['tools_chars'] = len(json.dumps(body.get('tools', []) or [])); rec['system_chars'] = len((body.get('messages') or [{}])[0].get('content') or '')
    except Exception: pass
    try:
        txt = req.response().text()
        for line in txt.splitlines()[::-1]:
            if '"usage"' in line:
                j = json.loads(line[5:].strip() if line.startswith('data:') else line); u = j.get('usage') or {}
                if u.get('prompt_tokens'): rec['prompt_tokens'] = u['prompt_tokens']; rec['completion_tokens'] = u.get('completion_tokens'); break
    except Exception as e: rec['read_error'] = str(e)[:120]
    requests.append(rec)
report = dict(width=width, sessions=[])
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': width, 'height': height})
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)[:300]))
    pg.on('console', lambda m: errs.append('console.error ' + m.text[:300]) if m.type == 'error' else None)
    pg.on('requestfinished', on_done)
    pg.goto(base + '/'); pg.wait_for_selector('#esl-ai-launch')
    js(pg, '() => { localStorage.removeItem("esl.assistant.chat.v1"); localStorage.removeItem("esl.assistant.project.v1"); }')
    pg.click('#esl-ai-launch'); pg.wait_for_function('() => window.__eslAssistant'); js(pg, '() => window.__eslAssistant.ready')
    conf = dict(base=endpoint, model=os.environ.get('ESL_LLM_MODEL', ''), apiKey=os.environ.get('ESL_LLM_KEY', '')) if endpoint else {}
    js(pg, '(o) => window.__eslAssistant.configure(o)', conf)
    model = js(pg, '() => window.__eslAssistant.settings.model'); print('model:', model, '· context', js(pg, '() => window.__eslAssistant.settings.context'))
    report['model'] = model
    for sid in sessions:
        ask = ASKS[sid]; n0 = js(pg, '() => window.__eslAssistant.log.length', default=0); r0 = len(requests)
        print('\n' + '=' * 100 + f'\nSESSION {sid}  USER: {ask}')
        pg.fill('.ai-input', ask); pg.click('.ai-send'); t0 = time.time(); pages = [js(pg, '() => window.__eslAssistant.page')]; quiet = 0; conts = 0; page_times = [(pages[0], 0.0)]
        while True:
            pg.wait_for_timeout(500)
            st = js(pg, '() => (window.__eslAssistant ? { working: window.__eslAssistant.working, page: window.__eslAssistant.page, allow: !!document.querySelector(".ai-allow"), cap: !!document.querySelector(".ai-msg.cap button"), pending: !!(JSON.parse(localStorage.getItem("esl.assistant.chat.v1") || "{}").pending) } : null)')
            if st is None: continue
            if st['page'] != pages[-1]: pages.append(st['page']); page_times.append((st['page'], round(time.time() - t0, 1))); print(f"   [{time.time() - t0:.0f} s: the assistant moved to the {st['page']} page]")
            if st['allow']: pg.click('.ai-allow'); print('   [the user clicked Allow]')
            if st['cap'] and not st['working'] and conts < 3: conts += 1; pg.click('.ai-msg.cap button'); print('   [the user clicked Continue]'); continue
            quiet = quiet + 1 if not st['working'] and not st['pending'] else 0
            if quiet >= 4: break
            if time.time() - t0 > 1800: print('   TIMEOUT'); js(pg, '() => document.querySelector(".ai-stop").click()'); break
        wall = time.time() - t0
        log = js(pg, '(n) => window.__eslAssistant.log.slice(n)', n0, default=[])
        calls = []; final = None; notes = []
        for ev in log:
            k = ev['type']
            if k == 'tool_start': print(f"  -> [{ev.get('page')}] {ev['name']} {json.dumps(ev.get('args'))[:300]}"); calls.append(dict(page=ev.get('page'), name=ev['name'], args=ev.get('args')))
            elif k == 'tool_end':
                print(f"     {'declined' if ev.get('denied') else 'ok' if ev['ok'] else 'FAILED'} ({ev['ms']} ms) {ev['text'][:500]}{'…' if len(ev['text']) > 500 else ''}")
                if calls: calls[-1].update(ok=ev['ok'], ms=ev['ms'], result=ev['text'][:2500])
            elif k == 'assistant': print(('\nANSWER: ' if ev.get('final') else '  .. ') + ev['text']); final = ev['text'] if ev.get('final') else final
            elif k in ('note', 'error'): print(f"  [{k}] {ev.get('text') or ev.get('message')}"); notes.append(ev.get('text') or ev.get('message'))
            elif k == 'figure': print(f"  [figure shown in the chat: {ev['name']}]")
            elif k == 'context' and ev.get('trimmed'): print(f"  [context] {ev['tokens']} of {ev['limit']}: {ev['trimmed']}")
            elif k == 'done': print(f"\n== {ev['reason']}: {ev['steps']} model steps, {ev['seconds']:.1f} s ==")
        reqs = requests[r0:]
        info = js(pg, '() => { const A = window.__eslAssistant, t = A.agent && A.agent.turns.at(-1); return { page: A.page, check: t && t.check, answered: !!(t && t.final), files: A.files.list().map((f) => f.name + " (" + f.origin + ")"), figures: document.querySelectorAll("#assistant .ai-fig img").length, project: A.project || null }; }', default={})
        pt = [r['prompt_tokens'] for r in reqs if r.get('prompt_tokens')]
        print(f"\nrequests: {len(reqs)} · prompt tokens per request: {pt} · mean {round(sum(pt) / len(pt)) if pt else None} · max {max(pt) if pt else None} · total {sum(pt)}")
        print(f"request sizes (chars): {[r['request_chars'] for r in reqs]}; tool schema chars: {[r.get('tools_chars') for r in reqs]}")
        print('afterwards:', json.dumps(info)[:1500])
        pg.screenshot(path=os.path.join(out, f'session{sid}_{width}.png'))
        report['sessions'].append(dict(id=sid, ask=ask, seconds=round(wall, 1), pages=page_times, continues=conts, calls=calls, final=final, notes=notes, requests=reqs, info=info,
                                       prompt_tokens=dict(per_request=pt, mean=round(sum(pt) / len(pt)) if pt else None, max=max(pt) if pt else None, total=sum(pt))))
    open(os.path.join(out, f'transcript_{width}.md'), 'w').write(js(pg, '() => window.__eslAssistant.transcript()', default='') or '')
    b.close()
report['errors'] = errs
json.dump(report, open(os.path.join(out, f'e2e_{width}.json'), 'w'), indent=1, default=str)
for e in errs[:30]: print(e)
print('errors:', len(errs))
