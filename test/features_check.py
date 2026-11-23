# Drives the newer features in headless Chrome: undo, slider ranges, stellar-tied limb darkening,
# run restore, priors export/import, movie recording, mobile layout.
import sys, base64, json, os
from playwright.sync_api import sync_playwright
out = sys.argv[1]
# the site: $ESL_BASE, else the static server of CLAUDE.md ("Browser checks"); Chrome when it is installed, else Playwright's Chromium
BASE = os.environ.get('ESL_BASE', 'http://127.0.0.1:8765').rstrip('/')
CHROME = {'executable_path': '/usr/bin/google-chrome'} if os.path.exists('/usr/bin/google-chrome') else {}
with sync_playwright() as p:
    b = p.chromium.launch(**CHROME, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); logs = []
    pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
    pg.goto(BASE + '/analyze/index.html?skipintro'); pg.wait_for_timeout(1800)
    S = lambda expr: pg.evaluate('(() => { const S = window.__esl.S; return ' + expr + '; })()')
    def fit():
        pg.click('.tabs [data-tab=fit]'); pg.click('#runbtn')
        pg.wait_for_function("/^(Finished|Fit failed)/.test(document.querySelector('#pstat').textContent)", timeout=300000); pg.wait_for_timeout(500)
        return pg.inner_text('#pstat')
    # --- undo: move a slider by typing a value, then Ctrl+Z
    pg.click('.tabs [data-tab=system]')
    v0 = S('S.values.rprs'); box = pg.locator('#tab-system .row input[type=number]').first
    box.fill('0.2'); box.press('Enter'); pg.wait_for_timeout(200); v1 = S('S.values.rprs')
    pg.locator('h1').click(); pg.keyboard.press('Control+z'); pg.wait_for_timeout(300); v2 = S('S.values.rprs')
    pg.keyboard.press('Control+Shift+z'); pg.wait_for_timeout(300); v3 = S('S.values.rprs'); pg.keyboard.press('Control+z'); pg.wait_for_timeout(200)
    print('undo/redo rprs:', v0, '->', v1, '-> undo', v2, '-> redo', v3, 'OK' if (v1 == 0.2 and v2 == v0 and v3 == 0.2) else 'FAIL')
    # --- estimate M, R from spectroscopy with the fields emptied
    pg.evaluate("(() => { const S = window.__esl.S; S.star.rstar = null; S.star.mstar = null; })()")
    pg.click('text=Estimate R★ and M★'); pg.wait_for_timeout(300); print('Torres estimate:', S('[S.star.rstar, S.star.rstarErr, S.star.mstar, S.star.mstarErr]'))
    # --- LD estimate button replaces the slider values
    before = S('[S.values.ld0, S.values.ld1]'); pg.click('#tab-system .btn.primary'); pg.wait_for_timeout(300); after = S('[S.values.ld0, S.values.ld1]')
    shown = pg.evaluate("[...document.querySelectorAll('#tab-system .row')].filter(r => /^u[12]/.test(r.textContent)).map(r => r.querySelector('input[type=number]').value)")
    print('LD estimate:', before, '->', after, 'slider boxes show', shown)
    # --- fit 1: coefficients fixed
    print(fit()); r1 = S('S.runs.length'); rng = S('S.range')
    pg.click('.tabs [data-tab=system]'); pg.wait_for_timeout(200)
    lim = pg.evaluate("[...document.querySelectorAll('#tab-system .row input[type=range]')].map(r => r.className)")
    print('after fit: range mode', rng, 'limited sliders', lim.count('limited'))
    pg.click('.rangebar button:has-text(\"Prior\")'); pg.wait_for_timeout(200); print('prior mode -> limited', pg.evaluate("document.querySelectorAll('#tab-system .row input.limited').length"), 'mode', S('S.range'))
    pg.click('.rangebar button:has-text(\"Full\")'); pg.wait_for_timeout(200); print('full mode  -> limited', pg.evaluate("document.querySelectorAll('#tab-system .row input.limited').length"))
    # --- fit 2: limb darkening follows the star
    pg.click('.tabs [data-tab=fit]'); pg.click('input[name=ldmode][value=star]'); pg.wait_for_timeout(300)
    pg.evaluate("(() => { const cb = [...document.querySelectorAll('#tab-fit table.pri tr')].find(r => /T eff/.test(r.textContent)).querySelector('input[type=checkbox]'); cb.click(); })()")
    print(fit()); txt = pg.inner_text('#tab-results'); i = txt.find('FITTED PARAMETERS'); print(txt[i:i+330].replace('\n', ' | '))
    j = txt.find('LIMB DARKENING'); print(txt[j:j+170].replace('\n', ' | '))
    pg.screenshot(path=out + '_starfit.png')
    pg.evaluate("document.querySelector('#corner').scrollIntoView()"); pg.wait_for_timeout(300); pg.screenshot(path=out + '_corner.png')
    # --- click the first run in the comparison table: its posterior comes back
    pg.evaluate("document.querySelector('tr.runrow').scrollIntoView()"); n_rows = pg.locator('tr.runrow').count()
    pg.locator('tr.runrow').first.click(); pg.wait_for_timeout(500)
    print('runs listed', n_rows, '| restored run id', S('S.fit.id'), 'free', S('S.fit.free.map(f => f.key)'), 'ldMode', S('S.ldMode'), '| tag:', pg.inner_text('.runtag')[:60])
    # --- priors export -> YAML text -> import round trip through the real parser
    y = pg.evaluate("""async () => { const c = await import('/src/core/config.js'), m = await import('/src/core/model.js'); const S = window.__esl.S;
        const txt = c.toYAML(c.configToObject(S, [...m.activeParams(S.ldLaw, true), ...m.STAR_PARAMS])); const back = c.parseConfig(txt);
        return { txt: txt.slice(0, 260), rprsPrior: back.params.rprs.prior, perPrior: back.params.per.prior, fit: Object.entries(back.params).filter(([k, v]) => v.fit).map(([k]) => k) }; }""")
    print(y['txt']); print('parsed back:', y['rprsPrior'], y['perPrior'], y['fit'])
    # --- movie
    mv = pg.evaluate("""async () => { const m = await import('/src/ui/movie.js'), lc = await import('/src/ui/lightcurve.js'); const T = window.__esl, sup = m.movieSupport(); if (!sup) return { sup: null };
        const v = T.lcPlot.view; const r = await m.recordMovie({ stage: () => document.querySelector('#viz canvas'), t0: v.x0, t1: v.x1, seconds: 3, title: T.S.name, subtitle: (t) => 't=' + t.toFixed(3),
          drawLC: (ctx, w, h, t) => lc.renderLightCurve(ctx, w, h, { ...T.lcPlot.d, cursor: t }, T.lcPlot.view, lc.LC_THEMES.dark, { fontScale: 1.3 }), setTime: (t) => { T.S.t = t; } });
        const u8 = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return { sup, size: r.blob.size, ext: r.ext, b64: btoa(s) }; }""")
    if mv.get('b64'): open(out + '_movie.' + mv['ext'], 'wb').write(base64.b64decode(mv['b64']))
    print('movie:', mv.get('sup'), mv.get('size'), 'bytes')
    print('errors:', logs[:6])
    # --- mobile
    pg2 = b.new_page(viewport={'width': 400, 'height': 860}); pg2.goto(BASE + '/analyze/index.html?skipintro'); pg2.wait_for_timeout(1800)
    pg2.screenshot(path=out + '_mobile.png'); pg2.click('.tabs [data-tab=fit]'); pg2.wait_for_timeout(300); pg2.screenshot(path=out + '_mobile_fit.png', full_page=True)
    b.close()
