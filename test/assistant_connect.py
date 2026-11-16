# The set-up card's presets and "Test connection" in a real (headless) Chromium, from a page served over plain http
# (a local copy) and from the same pages served as https://exoplanet.science (Playwright answers that address from the
# built folder, so the browser applies its https rules: mixed content, local network access). Not part of `npm test`.
#
#   .venv/bin/python test/assistant_connect.py /tmp/esl-as2 [http://localhost:8942]
#
# Prints, for each page origin and preset, the diagnosis the card shows. The presets' addresses are those of
# src/assistant/presets.js, read by the page itself.
import sys, os, mimetypes, json
from playwright.sync_api import sync_playwright
built = sys.argv[1] if len(sys.argv) > 1 else '/tmp/esl-as2'; local = (sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:8942').rstrip('/')
HTTPS = 'https://exoplanet.science'
def serve(route):
    path = route.request.url[len(HTTPS):].split('?')[0].split('#')[0]
    f = os.path.join(built, path.lstrip('/'))
    if os.path.isdir(f): f = os.path.join(f, 'index.html')
    if not os.path.exists(f): return route.fulfill(status=404, body='not found')
    route.fulfill(status=200, body=open(f, 'rb').read(), headers={'content-type': mimetypes.guess_type(f)[0] or 'application/octet-stream'})
rows = []
with sync_playwright() as p:
    b = p.chromium.launch()
    # the https site twice: as Chrome treats it by default (no local network access), and after the user allowed it
    for origin, lna in ((local, False), (HTTPS, False), (HTTPS, True)):
        ctx = b.new_context(viewport={'width': 1280, 'height': 860})
        if origin == HTTPS: ctx.route(HTTPS + '/**', serve)
        if lna: ctx.grant_permissions(['local-network-access'], origin=HTTPS)
        pg = ctx.new_page()
        pg.goto(origin + '/analyze/?skipintro'); pg.wait_for_selector('#esl-ai-launch'); pg.click('#esl-ai-launch')
        pg.wait_for_function('() => window.__eslAssistant'); pg.evaluate('() => window.__eslAssistant.ready')
        # first use: the card opens with the default preset and tests it at once
        pg.wait_for_function('() => { const t = document.querySelector(".ai-settings .ai-row .ai-test"); return t && /ok|bad/.test(t.className); }', timeout=60000)
        first = pg.evaluate('() => ({ preset: document.querySelector(".ai-preset").value, text: document.querySelector(".ai-settings .ai-row .ai-test").textContent, cls: document.querySelector(".ai-settings .ai-row .ai-test").className, pre: document.querySelector(".ai-mixed").hidden ? "" : document.querySelector(".ai-mixed").textContent, models: [...document.querySelectorAll(".ai-modelsel option")].map((o) => o.value) })')
        rows.append(dict(origin=origin + (' (local network access allowed)' if lna else ''), preset=first['preset'], how='auto on first opening', ok='ok' in first['cls'], text=first['text'], models=first['models'][:4], precheck=bool(first['pre'])))
        pg.screenshot(path=f"/tmp/esl-connect-{'https' if origin == HTTPS else 'http'}{'-lna' if lna else ''}.png")
        for preset in ('lmstudio',):
            pg.select_option('.ai-preset', preset)
            pg.wait_for_timeout(300)
            pg.wait_for_function('() => { const t = document.querySelector(".ai-settings .ai-row .ai-test"); return t && /ok|bad/.test(t.className); }', timeout=60000)
            r = pg.evaluate('() => ({ text: document.querySelector(".ai-settings .ai-row .ai-test").textContent, cls: document.querySelector(".ai-settings .ai-row .ai-test").className, models: [...document.querySelectorAll(".ai-modelsel option")].map((o) => o.value) })')
            rows.append(dict(origin=origin + (' (local network access allowed)' if lna else ''), preset=preset, how='chosen in the list', ok='ok' in r['cls'], text=r['text'], models=r['models'][:4]))
        ctx.close()
    b.close()
for r in rows: print(json.dumps(r, ensure_ascii=False))
