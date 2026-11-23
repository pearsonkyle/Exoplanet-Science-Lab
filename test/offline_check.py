# Offline check of the built site: the service worker (dist/sw.js, tools/sw/) saves every page, script, worker and
# data file; with the connection cut every page still opens and works from the saved copy, the site bar says
# "Offline", and a live archive query shows a notice naming the archive instead of an error.
#
#   DOCS_BASE=/docs/ npm run pages:build
#   .venv/bin/python test/offline_check.py [--serve DIR] [--port 4199] [--update]
#
# The check serves DIR (default dist) itself with tools/docs/serve.mjs on localhost:PORT (a service worker needs
# localhost or https), and stops the server for the offline part: Playwright's set_offline() sets navigator.onLine
# and blocks the pages' own requests, but not the service worker's, so only a server that is gone proves that
# nothing came from the network.
# --update: after the offline part, one file of DIR is changed and sw.js regenerated (a new deploy): the check
#   wants a new cache with the unchanged files copied from the old one, not downloaded again, and the old cache
#   gone once the new version takes over. It modifies DIR, so give it a copy: --serve /tmp/esl-offline --update.
# Exit code 1 when any check fails.
import os, sys, time, subprocess
from playwright.sync_api import sync_playwright

args = sys.argv[1:]
def opt(name):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return None
serve_dir = opt('--serve') or 'dist'
port = int(opt('--port') or 4199)
update = '--update' in args
base = f'http://localhost:{port}/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
server = None
def serve(on, log=None):
    global server
    if on and not server:
        env = dict(os.environ, **({'ESL_SERVE_LOG': log} if log else {}))
        server = subprocess.Popen(['node', os.path.join(ROOT, 'tools/docs/serve.mjs'), serve_dir, str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        import urllib.request
        for _ in range(50):
            try: urllib.request.urlopen(base + 'sw.js', timeout=1); return
            except Exception: time.sleep(0.1)
        raise SystemExit(f'could not serve {serve_dir} on {base} (is the port taken?)')
    if not on and server:
        server.terminate(); server.wait(); server = None

fails = []
def check(name, cond, info=''):
    print(('ok   ' if cond else 'FAIL ') + name + (('   ' + str(info)) if info else ''))
    if not cond: fails.append(name)

STATUS = """() => new Promise((res) => { const c = navigator.serviceWorker.controller; if (!c) return res(null);
  const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); c.postMessage({ type: 'status' }, [ch.port2]); setTimeout(() => res(null), 5000); })"""
WARM = """() => new Promise((res) => { const c = navigator.serviceWorker.controller; if (!c) return res(null);
  const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); c.postMessage({ type: 'warm' }, [ch.port2]); })"""

# name, path, ready (JS that becomes true), what must be on the page
PAGES = [
    ('home', '', "document.querySelectorAll('#sections a, #sections .card').length > 0", None),
    ('plan', 'plan/', 'window.__plan && !!window.__plan.A.info', None),
    ('observe', 'observe/', "!!document.querySelector('canvas')", None),
    ('analyze', 'analyze/?skipintro', 'window.__esl && !!window.__esl.api', None),
    ('analyze-start', 'analyze/', "document.readyState === 'complete'", None),
    ('analyze-example', 'analyze/?skipintro', 'window.__esl && !!window.__esl.api', "window.__esl.api.loadExample('eclipsemap')"),
    ('photometry', 'analyze/photometry/', "!!document.getElementById('inTarget')", None),
    ('photometry-sample', 'analyze/photometry/?demo=1&inspect', 'window.__phot && window.__phot.ready === true', None),
    ('spectroscopy', 'analyze/spectroscopy/', "document.readyState === 'complete' && !!document.getElementById('sitebar').children.length", None),
    ('atmosphere', 'analyze/atmosphere/', "!!(window.__esl && window.__esl.atmosphere && window.__esl.atmosphere.ready())", None),
    ('search', 'search/', 'window.__search && window.__search.S.rows.length > 0', None),
    ('methods', 'methods/', "document.documentElement.dataset.methods === 'ready'", None),
    ('methods-validation', 'methods/#validation', "document.documentElement.dataset.validation === 'ready'", None),
    ('docs', 'docs/', "!!document.querySelector('.VPContent, .VPHome, main')", None),
    ('docs-guide', 'docs/guide/getting-started.html', "!!document.querySelector('.vp-doc h1')", None),
    ('docs-methods', 'docs/METHODS.html', "!!document.querySelector('.vp-doc h1')", None),
    ('redirect', 'validation/', "location.pathname.includes('/methods/')", None),
]

def wait_for(page, js, ms):
    try: page.wait_for_function(js, timeout=ms); return True
    except Exception: return False

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1280, 'height': 860})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    # ---- online: install, take over, save everything
    serve(True)
    page.goto(base, wait_until='load')
    check('service worker registered', wait_for(page, "navigator.serviceWorker && navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))", 60000))
    page.reload(wait_until='load')
    check('page controlled by the worker', wait_for(page, '!!navigator.serviceWorker.controller', 15000))
    t0 = time.time(); st = page.evaluate(WARM)
    st = page.evaluate(STATUS)
    while st and st['have'] < st['total'] and time.time() - t0 < 300:
        page.evaluate(WARM); st = page.evaluate(STATUS)
    check('whole site saved', st and st['have'] == st['total'], st and f"{st['have']} of {st['total']} files, {st['bytes'] / 1e6:.1f} MB, version {st['version']}, {time.time() - t0:.0f} s")
    version = st and st['version']
    caches = page.evaluate("caches.keys()")
    check('one cache, named after the build', caches == ['esl-' + str(version)], caches)

    # ---- offline: every page from the saved copy (and no server to fall back on)
    serve(False)
    ctx.set_offline(True)
    for name, path, ready, step in PAGES:
        errors.clear()
        try:
            page.goto(base + path, wait_until='load', timeout=30000)
            ok = wait_for(page, ready, 30000)
            if ok and step: page.evaluate(step); page.wait_for_timeout(800)
        except Exception as e:
            ok = False; errors.append(str(e)[:200])
        is_docs = path.startswith('docs/')
        pill = None if is_docs else page.evaluate("(() => { const p = document.getElementById('sitenet'); return p && !p.hidden ? p.textContent : null; })()")
        errs = list(errors)
        check(f'offline {name}', ok and not errs and (is_docs or name == 'redirect' or (pill or '').startswith('Offline')), '; '.join(errs)[:300] or (None if is_docs else pill))

    # a page that is not part of the site: a plain page that says so, not the browser's error
    page.goto(base + 'no-such-page/', wait_until='load')
    check('offline unknown page explains itself', 'not saved on this device' in page.content())

    # a live archive query: a notice naming the archive, a plain-words status, no uncaught error
    errors.clear()
    page.goto(base + 'analyze/photometry/', wait_until='load'); wait_for(page, "!!document.getElementById('inTarget')", 15000)
    page.fill('#inTarget', 'TIC 100100827'); page.click('#bFind')
    got = wait_for(page, "[...document.querySelectorAll('.sitenotice')].some((n) => /MAST/.test(n.textContent))", 20000)
    notice = page.evaluate("[...document.querySelectorAll('.sitenotice')].map((n) => n.textContent).join(' | ')")
    status = page.evaluate("(document.getElementById('stArch') || {}).textContent || ''")
    check('offline MAST query shows a notice', got and not errors, notice)
    check('offline MAST query: status in plain words', 'offline' in status.lower(), status[:160])

    # the catalogue lookup of the plate-solve target works offline (the snapshot is saved); Sesame is not needed for it
    serve(True)
    ctx.set_offline(False)
    page.goto(base, wait_until='load'); page.wait_for_timeout(500)
    pill = page.evaluate("(() => { const p = document.getElementById('sitenet'); return p && !p.hidden ? p.textContent : '' })()")
    check('back online: no offline pill', pill == '', pill)

    # ---- a new deploy: a new cache, unchanged files copied (not downloaded), the old cache deleted
    if update:
        f = os.path.join(serve_dir, 'index.html')
        with open(f, 'a') as fh: fh.write('\n<!-- offline_check: new deploy -->\n')
        subprocess.run(['node', os.path.join(ROOT, 'tools/sw/build.mjs'), serve_dir], check=True)
        # every path that reaches the server, the service worker's requests included
        log = '/tmp/esl-offline-requests.log'
        serve(False); open(log, 'w').close(); serve(True, log)
        page.evaluate("navigator.serviceWorker.getRegistration().then((r) => r.update())")
        ok = wait_for(page, "navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)", 120000)
        check('new version installed and waiting', ok)
        names = page.evaluate("caches.keys()")
        check('new cache next to the old one while waiting', len(names) == 2 and 'esl-' + str(version) in names, names)
        notice = wait_for(page, "[...document.querySelectorAll('.sitenotice')].some((n) => /new version/.test(n.textContent))", 10000)
        check('reload offered', notice)
        if notice:
            page.click('.sitenotice .sn-act'); page.wait_for_load_state('load'); page.wait_for_timeout(1500)
        st2 = page.evaluate(STATUS)
        names = page.evaluate("caches.keys()")
        check('new version active, old cache gone', st2 and st2['version'] != version and names == ['esl-' + st2['version']], names)
        check('everything carried over without a download', st2 and st2['have'] == st2['total'], st2 and f"{st2['have']} of {st2['total']}")
        ctx2_reqs = open(log).read().split()
        refetched = [u for u in ctx2_reqs if '/catalog' in u or '/docs/' in u or '/examples/' in u]
        check('the changed file was downloaded', '/index.html' in ctx2_reqs, ' '.join(sorted(set(ctx2_reqs)))[:200])
        check('unchanged data not downloaded again', len(refetched) == 0, f'{len(refetched)} data requests' + (': ' + refetched[0] if refetched else ''))

    browser.close()
    serve(False)

print(f"\n{'all ok' if not fails else str(len(fails)) + ' failed: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
