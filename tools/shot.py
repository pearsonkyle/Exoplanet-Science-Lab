# Headless screenshot and console check of a page of the running dev server (npm run dev on :5173).
#   .venv/bin/python tools/shot.py <path-or-url> <out.png> [width height] [--wait ms] [--eval "js expression"] [--click "css selector"]
# Prints console errors, page errors and the value of --eval. Exit code 1 when the page threw.
import sys, json
from playwright.sync_api import sync_playwright
args = sys.argv[1:]
def opt(name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
wait = int(opt('--wait', '1500')); ev = opt('--eval'); click = opt('--click')
url, out = args[0], args[1]
w, h = (int(args[2]), int(args[3])) if len(args) >= 4 else (1440, 900)
if not url.startswith('http'): url = 'http://localhost:5173/' + url.lstrip('/')
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': w, 'height': h})
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: errs.append('console.error ' + m.text) if m.type == 'error' else None)
    pg.goto(url); pg.wait_for_timeout(wait)
    if click: pg.click(click); pg.wait_for_timeout(600)
    if ev: print('eval:', json.dumps(pg.evaluate(ev), default=str)[:4000])
    pg.screenshot(path=out)
    b.close()
for e in errs: print(e)
print('saved', out, 'errors:', len(errs))
sys.exit(1 if any(e.startswith('PAGEERROR') for e in errs) else 0)
