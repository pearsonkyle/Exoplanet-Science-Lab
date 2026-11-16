# Layout check of every page at a phone, a tablet and a desktop size, in headless Chromium:
#   no horizontal overflow (document.documentElement.scrollWidth <= the viewport width), and
#   no page error and no console error from the site itself; and at 390 px, every control of the site bar, its folded
#   menu, the Analyze sub-bar, the project panel and the assistant's sheet at least 40 x 40 px with no text under 11 px.
#   And the Plan page at 13 widths from 360 to 1920 px (plan-fields): no settings field under 70 px, no value cut off,
#   no text over text and no text one word per line in the settings, the list and the transit's panel.
#
#   .venv/bin/python test/layout_check.py [BASE_URL] [--shots DIR] [--only TEXT]
#
# BASE_URL defaults to $ESL_BASE, then http://127.0.0.1:8765 (a static server on a built copy: see CLAUDE.md).
# --shots DIR writes one PNG per page and size; --only keeps the checks whose name contains TEXT.
# Pages marked optional may answer 404 (they belong to work in progress) and are then skipped.
# Exit code 1 when any check fails.
#
# What it cannot see: real touch, iOS Safari (100vh, safe-area insets, zoom on focus), and anything that needs
# a person to look at it. It measures in a phone-like context (touch, mobile viewport) at 390 px, where Chromium
# widens the layout viewport to fit an overflowing page, so the width is compared with the nominal one.
import os, sys
from playwright.sync_api import sync_playwright

args = sys.argv[1:]
def opt(name):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return None
shots, only = opt('--shots'), opt('--only')
base = (args[0] if args else os.environ.get('ESL_BASE', 'http://127.0.0.1:8765')).rstrip('/')
if shots: os.makedirs(shots, exist_ok=True)

SIZES = [(390, 844), (768, 1024), (1440, 900)]
# name, path, optional, ready (a JS expression that becomes true, or None), steps (JS run in order, 400 ms apart)
PAGES = [
    ('home', '', False, None, []),
    ('plan', 'plan/', False, 'window.__plan && !!window.__plan.A.info', []),
    ('plan-charts', 'plan/', False, 'window.__plan && !!window.__plan.A.info', ["document.querySelector('.p-views [data-view=grid]').click()"]),
    ('plan-ephemerides', 'plan/', False, 'window.__plan && !!window.__plan.A.info', ["document.querySelector('.p-views [data-view=eph]').click()"]),
    ('plan-transit', 'plan/', False, 'window.__plan && !!window.__plan.A.info',
     ["document.querySelector('.p-views [data-view=list]').click()", "(document.querySelector('#p-list .ev') || document.body).click()"]),
    ('plan-all-open', 'plan/', False, 'window.__plan && !!window.__plan.A.info',
     ["document.querySelectorAll('#p-form details, #p-sitebox').forEach((d) => { d.open = true; }); window.dispatchEvent(new Event('resize'))"]),
    ('search', 'search/', False, 'window.__search && window.__search.S.rows.length > 0', []),
    ('search-panels', 'search/', False, 'window.__search && window.__search.S.rows.length > 0',
     ["document.getElementById('s-filters').hidden = false; document.getElementById('s-cols').hidden = false"]),
    ('search-detail', 'search/?planet=WASP-12%20b', False, "window.__search && window.__search.S.rows.length > 0 && !document.getElementById('s-detail').hidden", []),
    ('photometry', 'analyze/photometry/', False, None, []),
    ('photometry-demo', 'analyze/photometry/?demo=2', False, 'window.__phot && window.__phot.ready === true', []),
    # the image tools: a star's radial profile, then the focus map, on the synthetic night (not measured)
    ('photometry-profile', 'analyze/photometry/?demo=2&inspect', False, 'window.__phot && window.__phot.ready === true && window.__phot.stars.length > 0',
     ["window.__phot.inspector.setTool('profile'); window.__phot.inspector.examine(window.__phot.stars[0].x, window.__phot.stars[0].y)", "void 0"]),
    ('photometry-focus', 'analyze/photometry/?demo=2&inspect', False, 'window.__phot && window.__phot.ready === true && window.__phot.stars.length > 0',
     ["window.__phot.inspector.setTool('focus')", "void 0", "void 0"]),
    ('spectroscopy', 'analyze/spectroscopy/', False, None, []),
    ('analyze', 'analyze/?skipintro', False, None, []),
    ('analyze-start', 'analyze/', False, None, []),
    # the plot made taller and shorter by its grips (sizes remembered in localStorage), with the eclipse-map example's views
    ('analyze-plot-tall', 'analyze/?skipintro', False, 'window.__esl && !!window.__esl.setLayoutSizes',
     ["window.__esl.setLayoutSizes({ lchSide: 640, lchStack: 460, stageStack: 130 })", "window.__esl.api.loadExample('eclipsemap')", "window.__esl.api.setView({ view: 'map' })"]),
    ('analyze-plot-short', 'analyze/?skipintro', False, 'window.__esl && !!window.__esl.setLayoutSizes',
     ["window.__esl.setLayoutSizes({ lchSide: 120, lchStack: 150, stageStack: 320 })", "window.__esl.api.loadExample('exomoon')", "window.__esl.api.setView({ view: 'moon' })"]),
    ('observe', 'observe/', False, None, []),
    ('methods', 'methods/', False, "document.documentElement.dataset.methods === 'ready'", []),
    ('methods-validation', 'methods/#validation', False, "document.documentElement.dataset.validation === 'ready' || !!document.querySelector('#status.ok, #status.bad')", []),
    ('methods-reproducibility', 'methods/#reproducibility', False, "document.documentElement.dataset.validation === 'ready'", []),
    ('methods-references', 'methods/#references', False, "document.documentElement.dataset.methods === 'ready'", []),
    ('methods-cite', 'methods/#cite', False, "!!document.querySelector('#citeTool[data-ready]')", []),
    # the site-wide overlays a phone user meets: the project checklist and the assistant's sheet (TAPS checks them at 390 px)
    ('project-panel', 'plan/', False, "!!document.querySelector('.siteproject')",
     ["document.querySelector('.siteproject').click()", "(document.getElementById('pj-start') || document.body).click()"]),
    ('assistant-open', 'analyze/?skipintro', False, "!!document.getElementById('esl-ai-launch')",
     ["document.getElementById('esl-ai-launch').click()", "void 0", "void 0"]),
]
# At 390 px only: every control of the site bar, the folded section menu, the Analyze sub-bar, the project panel and
# the assistant's sheet is at least 40 x 40 px (a fingertip; a checkbox counts by its label), and no text there is under
# 11 px. The section menu is opened for the measurement and closed again.
TAPS = """(() => {
  const bar = document.getElementById('sitebar'), out = [], small = [];
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden]'); };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '') + ' "' + (e.textContent || e.value || '').trim().slice(0, 18) + '"';
  const wasOpen = bar && bar.classList.contains('open');
  if (bar && bar.classList.contains('compact')) bar.classList.add('open');
  const scope = '.sitebar, .subnav, .projpanel, .ai-panel';
  for (const e of document.querySelectorAll(['a[href]', 'button', 'select', 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file])', 'summary', 'textarea'].map((s) => `:is(${scope}) ${s}`).join(','))) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 39.5 || r.height < 39.5) out.push(name(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  for (const e of document.querySelectorAll(`:is(${scope}) *`)) {
    if (!vis(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 11) small.push(name(e) + ' ' + fs + ' px');
  }
  if (bar && !wasOpen) bar.classList.remove('open');
  return { taps: out.slice(0, 5), ntaps: out.length, small: small.slice(0, 5), nsmall: small.length };
})()"""
MEASURE = """(() => {
  const de = document.documentElement, w = %d;
  const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true; return false; };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  const wide = de.scrollWidth > w ? [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && !clipped(e); }).slice(0, 4).map((e) => name(e) + ' to ' + Math.round(e.getBoundingClientRect().right) + ' px') : [];
  return { scrollWidth: de.scrollWidth, wide };
})()"""

# The Plan page between the three sizes above, where its grids change shape: with every settings section open and a
# transit's chart open, at each of these widths no field of the settings under 70 px wide, no value cut off by its
# field (the observatory menu excepted: its names are as long as they are), no two pieces of text in the settings, the
# list or the transit's panel drawn over each other, and no text there broken one word per line.
PLAN_WIDTHS = [360, 480, 600, 700, 820, 900, 1000, 1100, 1180, 1280, 1366, 1600, 1920]
PLAN_OPEN = ["document.querySelectorAll('#p-form details, #p-sitebox').forEach((d) => { d.open = true; }); document.querySelectorAll('#p-phase-opts, #p-custom-opts').forEach((d) => { d.hidden = false; }); window.dispatchEvent(new Event('resize'))",
             "(document.querySelector('#p-list .ev') || document.body).click()"]
PLAN_FIELDS = """(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden]'); };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '');
  const out = { narrow: [], cut: [], overlap: [], oneword: [] }, cv = document.createElement('canvas').getContext('2d');
  for (const e of document.querySelectorAll('#p-form input:not([type=checkbox]), #p-form select')) {
    if (!vis(e)) continue; const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (r.width < 70) out.narrow.push(name(e) + ' ' + Math.round(r.width) + ' px');
    if (e.id === 'p-obs') continue;
    cv.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const txt = e.tagName === 'SELECT' ? (e.selectedOptions[0] || {}).text || '' : e.type === 'date' ? '00/00/0000' : (e.value || e.placeholder || '');
    const room = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (e.tagName === 'SELECT' ? 22 : e.type === 'date' ? 26 : 0);
    if (cv.measureText(txt).width > room + 1) out.cut.push(name(e) + ' "' + txt.slice(0, 20) + '"');
  }
  const items = [], rng = document.createRange();
  for (const root of document.querySelectorAll('#p-form, #p-list, #p-detail')) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
    while ((n = tw.nextNode())) {
      const el = n.parentElement, t = n.textContent.trim(); if (!t || !el || !vis(el) || el.closest('math')) continue;
      let clip = null;
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = p.getBoundingClientRect(); clip = clip ? { l: Math.max(clip.l, q.left), t: Math.max(clip.t, q.top), r: Math.min(clip.r, q.right), b: Math.min(clip.b, q.bottom) } : { l: q.left, t: q.top, r: q.right, b: q.bottom }; } }
      rng.selectNodeContents(n); const rects = [...rng.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      for (const r of rects) { const c = clip || { l: -1e9, t: -1e9, r: 1e9, b: 1e9 }; const x = { l: Math.max(r.left, c.l), t: Math.max(r.top, c.t), r: Math.min(r.right, c.r), b: Math.min(r.bottom, c.b) }; if (x.r - x.l > 1 && x.b - x.t > 1) items.push({ el, x, t: t.slice(0, 16) }); }
      const words = t.split(/\\s+/).length, lines = new Set(rects.map((r) => Math.round(r.top))).size;
      if (words >= 3 && lines >= words) out.oneword.push(name(el) + ' "' + t.slice(0, 20) + '" ' + lines + ' lines');
    }
  }
  items.sort((a, b) => a.x.t - b.x.t);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length && items[j].x.t < items[i].x.b - 3; j++) {
    const a = items[i], b = items[j]; if (a.el === b.el) continue;
    const ix = Math.min(a.x.r, b.x.r) - Math.max(a.x.l, b.x.l), iy = Math.min(a.x.b, b.x.b) - Math.max(a.x.t, b.x.t);
    if (ix > 2 && iy > 3) out.overlap.push('"' + a.t + '" over "' + b.t + '"');
  }
  return out;
})()"""

fails, rows = [], []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    for name, path, optional, ready, steps in PAGES:
        if only and only not in name: continue
        for (w, h) in SIZES:
            ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=w < 1000, is_mobile=w < 500)
            pg = ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append('page error: ' + str(e).split('\n')[0][:200]))
            # a console error counts when it comes from the site: a camera image or an archive that does not answer is not a layout fault
            pg.on('console', lambda m: errs.append('console error: ' + m.text[:200]) if m.type == 'error' and not ('Failed to load resource' in m.text and not (m.location or {}).get('url', '').startswith(base)) else None)
            tag = f'{name} @ {w}'
            try:
                resp = pg.goto(base + '/' + path, wait_until='load', timeout=30000)
                if resp is not None and resp.status == 404 and optional:
                    rows.append((tag, 'skipped (404, optional)')); ctx.close(); continue
                if resp is not None and resp.status >= 400: raise RuntimeError(f'HTTP {resp.status}')
                if ready:
                    try: pg.wait_for_function(ready, timeout=45000)
                    except Exception: errs.append('not ready after 45 s: ' + ready[:80])
                pg.wait_for_timeout(1200)
                for js in steps: pg.evaluate(js); pg.wait_for_timeout(400)
                pg.wait_for_timeout(400)
                m = pg.evaluate(MEASURE % w)
                if w == 390:
                    if name == 'assistant-open':
                        try: pg.wait_for_selector('.ai-panel', state='visible', timeout=10000)
                        except Exception: errs.append('the assistant panel did not open')
                    t = pg.evaluate(TAPS)
                    if t['ntaps']: errs.append(f"{t['ntaps']} control(s) under 40 px: " + '; '.join(t['taps']))
                    if t['nsmall']: errs.append(f"{t['nsmall']} text(s) under 11 px: " + '; '.join(t['small']))
                if shots: pg.screenshot(path=os.path.join(shots, f'{name}-{w}.png'))
            except Exception as e:
                m = {'scrollWidth': -1, 'wide': []}; errs.append('could not be checked: ' + str(e).split('\n')[0][:200])
            bad = []
            if m['scrollWidth'] > w: bad.append(f"overflows sideways: {m['scrollWidth']} px wide in a {w} px window" + (' (' + '; '.join(m['wide']) + ')' if m['wide'] else ''))
            bad += errs
            rows.append((tag, 'ok' if not bad else 'FAIL  ' + ' | '.join(bad)))
            if bad: fails.append(tag)
            ctx.close()
    if not only or only in 'plan-fields':
        for w in PLAN_WIDTHS:
            ctx = b.new_context(viewport={'width': w, 'height': 900}, has_touch=w < 1000, is_mobile=w < 500)
            pg = ctx.new_page(); tag = f'plan-fields @ {w}'; bad = []
            try:
                pg.goto(base + '/plan/', wait_until='load', timeout=30000)
                pg.wait_for_function('window.__plan && !!window.__plan.A.info', timeout=45000); pg.wait_for_timeout(1200)
                for js in PLAN_OPEN: pg.evaluate(js); pg.wait_for_timeout(500)
                m = pg.evaluate(PLAN_FIELDS)
                for k, what in (('narrow', 'field(s) under 70 px'), ('cut', 'value(s) cut off by the field'), ('overlap', 'text drawn over text'), ('oneword', 'text one word per line')):
                    if m[k]: bad.append(f'{len(m[k])} {what}: ' + '; '.join(m[k][:3]))
                if shots: pg.screenshot(path=os.path.join(shots, f'plan-fields-{w}.png'))
            except Exception as e: bad.append('could not be checked: ' + str(e).split('\n')[0][:200])
            rows.append((tag, 'ok' if not bad else 'FAIL  ' + ' | '.join(bad)))
            if bad: fails.append(tag)
            ctx.close()
    b.close()

for tag, res in rows: print(f'{tag:26s} {res}')
skipped = sum(1 for _, r in rows if r.startswith('skipped')); ran = len(rows) - skipped
print(f'\n{ran - len(fails)} of {ran} passed' + (f', {skipped} skipped' if skipped else '') + (f'; failed: {", ".join(fails)}' if fails else '') + f'   ({base})')
sys.exit(1 if fails else 0)
