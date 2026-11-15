# Drives the page in headless Chrome. usage: browser.py URL OUT_PREFIX [WxH] step...
# steps: fit | preset:<key> | tab:<name> | click:<selector> | js:<expr> | shot:<name>
import sys
from playwright.sync_api import sync_playwright
url, out, steps = sys.argv[1], sys.argv[2], sys.argv[3:]
vw, vh = 1440, 900
if steps and 'x' in steps[0] and steps[0].replace('x', '').isdigit(): vw, vh = map(int, steps.pop(0).split('x'))
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': vw, 'height': vh})
    logs = []
    pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
    pg.goto(url); pg.wait_for_timeout(2500)
    pg.screenshot(path=out + '_start.png')
    for i, s in enumerate(steps):
        if s == 'fit':
            pg.click('.tabs [data-tab=fit]'); pg.wait_for_timeout(300)
            pg.click('#runbtn'); pg.wait_for_timeout(1500); pg.screenshot(path=out + f'_{i}_running.png')
            pg.wait_for_function("/^(Finished|Fit failed)/.test(document.querySelector('#pstat').textContent)", timeout=400000)
            pg.wait_for_timeout(800); print(pg.inner_text('#pstat'), '|', pg.inner_text('#runmode'))
            print(pg.inner_text('#tab-results')[:700].replace('\n\n', '\n'))
        elif s.startswith('preset:'): pg.select_option('#preset', s[7:]); pg.wait_for_timeout(1200)
        elif s.startswith('tab:'): pg.click(f".tabs [data-tab={s[4:]}]"); pg.wait_for_timeout(500)
        elif s.startswith('js:'): print('js ->', pg.evaluate(s[3:]))
        elif s.startswith('click:'): pg.click(s[6:]); pg.wait_for_timeout(1000)
        elif s.startswith('shot:'): pg.screenshot(path=out + '_' + s[5:] + '.png', full_page=(vw < 900))
    print('\n'.join(l for l in logs if 'TUNNEL' not in l and '404' not in l and '3D view failed' not in l)[:1500])
    b.close()
