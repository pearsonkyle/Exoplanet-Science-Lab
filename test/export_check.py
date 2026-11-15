# Exercises zoom, the white/dark figure exports and the PDF writer in headless Chrome.
import sys, base64
from playwright.sync_api import sync_playwright
out = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); logs = []
    pg.on('pageerror', lambda e: logs.append(str(e)))
    pg.goto('http://127.0.0.1:8765/index.html?skipintro'); pg.wait_for_timeout(2000)
    pg.select_option('#preset', 'hd80606'); pg.wait_for_timeout(800)
    pg.click('.tabs [data-tab=fit]'); pg.click('#runbtn')
    pg.wait_for_function("/^(Finished|Fit failed)/.test(document.querySelector('#pstat').textContent)", timeout=300000)
    pg.wait_for_timeout(600); print(pg.inner_text('#pstat'))
    txt = pg.inner_text('#tab-results'); i = txt.find('SYSTEM PARAMETERS'); print(txt[i:i+1500])
    # zoom into ingress with the wheel, then pan
    box = pg.locator('#lccanvas').bounding_box()
    pg.mouse.move(box['x'] + box['width'] * 0.38, box['y'] + 80)
    for _ in range(6): pg.mouse.wheel(0, -300); pg.wait_for_timeout(60)
    pg.mouse.down(); pg.mouse.move(box['x'] + box['width'] * 0.5, box['y'] + 80, steps=5); pg.mouse.up(); pg.wait_for_timeout(300)
    pg.screenshot(path=out + '_zoom.png')
    print('view after zoom:', pg.evaluate("JSON.stringify(Object.fromEntries(Object.entries(window.__esl.lcPlot.view).map(([k,v])=>[k,+v.toFixed(5)])))"), 'reset visible:', pg.evaluate("!document.querySelector('#lcreset').hidden"))
    pg.dblclick('#lccanvas'); pg.wait_for_timeout(300)
    for theme in ('light', 'dark'):
        url = pg.evaluate("(t) => window.__esl.lcPlot.exportCanvas(t, 'HD 80606 b — TESS', 2458887).toDataURL('image/png')", theme)
        open(f'{out}_lc_{theme}.png', 'wb').write(base64.b64decode(url.split(',')[1]))
    pdf = pg.evaluate("""async () => { const ex = await import('./src/ui/export.js'); const c = window.__esl.lcPlot.exportCanvas('light', 'HD 80606 b', 2458887);
        const blob = await ex.canvasToPDF(c); const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); }""")
    open(out + '_lc.pdf', 'wb').write(base64.b64decode(pdf))
    corner = pg.evaluate("""async () => { const m = await import('./src/ui/corner.js'); const F = window.__esl.S.fit; const c = document.createElement('canvas');
        m.drawCorner(c, F.res, F.free.map(f => f.label), null, { theme: 'light', width: 560, scale: 2, title: 'HD 80606 b — posterior' }); return c.toDataURL('image/png'); }""")
    open(out + '_corner_light.png', 'wb').write(base64.b64decode(corner.split(',')[1]))
    tex = pg.evaluate("async () => { const b = [...document.querySelectorAll('#tab-results .btn')].find(x => x.textContent === 'Copy LaTeX'); return 1; }")
    print('errors:', logs[:5])
    b.close()
