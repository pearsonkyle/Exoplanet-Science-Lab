# The photometry page's Field card driven headlessly in Chromium against a built copy of the site (not part of
# `npm test`; it asks VizieR for Gaia DR3 and VSX, about 300 kB):
#
#   npx vite build --outDir /tmp/esl-ps --emptyOutDir && mkdir -p /tmp/esl-ps/test/data && cp test/data/hatp32_exotic_sample.fits /tmp/esl-ps/test/data/
#   python3 -m http.server 8971 -d /tmp/esl-ps
#   ESL_BASE=http://localhost:8971 .venv/bin/python test/platesolve_check.py /tmp/esl-ps-check
#
# 1. the assistant tools the page declares pass lintSpecs / createSiteTools
# 2. ?demo=3&inspect (48 real frames of HAT-P-32 b): "Solve WCS" with the button, against live VizieR: matches, rms,
#    the target placed by name within 1 px of where EXOTIC's demo puts it; RA / Dec in the hover readout; Gaia drawn
# 3. "Use as target", "Rank with Gaia" (G, BP-RP, reasons, variables set aside), "Add the best", "Set apertures"
# 4. the same through the assistant tools; a frame other than the first gets its WCS through the tracking transform
# 5. a phone-sized viewport: the card's buttons are at least 40 px; screenshots; no page errors
import sys, os, json, subprocess, re
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith('--')]
out = args[0] if args else '/tmp/esl-ps-check'
os.makedirs(out, exist_ok=True)
base = os.environ.get('ESL_BASE', 'http://localhost:8971').rstrip('/')
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
ok = True
def check(name, cond, info=''):
    global ok
    print(('ok   ' if cond else 'FAIL ') + name + (('   ' + info) if info else ''), flush=True)
    if not cond: ok = False

HARNESS = r"""
() => {
  window.__T = { async call(name, a = {}) { const t = window.__esl.photometry.tools.find((x) => x.name === name); if (!t) return { ok: false, error: 'no tool ' + name };
    const t0 = performance.now(); try { const data = await t.run(a, { files: { list: () => [], get: () => null, write: async (n, d) => ({ name: n, size: d.length }) } }); return { ok: true, data, ms: Math.round(performance.now() - t0) }; } catch (e) { return { ok: false, error: String(e && e.message || e), ms: Math.round(performance.now() - t0) }; } },
    specs: () => window.__esl.photometry.tools.map(({ run, confirm, ...t }) => ({ ...t, confirm: typeof confirm === 'function' ? 'fn' : confirm })) };
  return true;
}
"""
errors = []
with sync_playwright() as p:
    br = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = br.new_context(viewport={'width': 1400, 'height': 1000})
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    def demo():
        pg.goto(base + '/analyze/photometry/?demo=3&inspect')
        pg.wait_for_function('() => window.__esl && window.__esl.photometry && window.__esl.photometry.ready() && window.__phot.stars.length === 3', timeout=60000)
        pg.evaluate(HARNESS)
    call = lambda name, a=None: pg.evaluate('([n, a]) => window.__T.call(n, a)', [name, a or {}])
    demo()
    EXOTIC_T = tuple(pg.evaluate('() => [window.__phot.stars[0].x, window.__phot.stars[0].y]'))   # the demo's target (src/photometry/main.js HATP32), centroided

    # ---- 1. declarations
    specs = pg.evaluate('() => window.__T.specs()')
    json.dump(specs, open(os.path.join(out, 'specs.json'), 'w'), indent=1)
    lint = subprocess.run(['node', '--input-type=module', '-e', f"""
import {{ lintSpecs }} from '{root}/src/assistant/toolspec.js';
import {{ createSiteTools }} from '{root}/src/assistant/pages.js';
import {{ memoryFiles }} from '{root}/src/assistant/tools.js';
import {{ readFileSync }} from 'node:fs';
const specs = JSON.parse(readFileSync('{out}/specs.json', 'utf8')).map((t) => ({{ ...t, confirm: t.confirm === 'fn' ? 'confirm' : t.confirm, run: () => ({{}}) }}));
const S = createSiteTools({{ page: 'photometry', root: 'https://esl.test/', pageApi: {{ tools: specs, ready: () => true, state: () => ['x'] }}, files: memoryFiles() }});
console.log(JSON.stringify({{ lint: lintSpecs(specs.map(({{ run, ...t }}) => t)), problems: S.problems, n: S.specs.length }}));
"""], capture_output=True, text=True)
    L = json.loads(lint.stdout.strip().splitlines()[-1]) if lint.returncode == 0 else {'lint': [lint.stderr[-600:]], 'problems': []}
    names = [s['name'] for s in specs]
    check('declarations: lintSpecs and createSiteTools find no problem', not L['lint'] and not L['problems'] and all(n in names for n in ['photometry_solve_wcs', 'photometry_choose_target', 'photometry_rank_comparisons', 'photometry_optimal_apertures']), f"{len(specs)} tools; {L['lint'] + L['problems']}")

    # ---- 2. Solve WCS with the button
    card = pg.evaluate('() => { const c = document.getElementById("cardWcs"); return { hidden: c.hidden, target: document.getElementById("fTarget").value, text: c.textContent.slice(0, 300) }; }')
    check('the Field card is shown with the OBJECT name', not card['hidden'] and card['target'].strip() == 'HATP-32', json.dumps(card)[:300])
    pg.click('#bSolve')
    pg.wait_for_function('() => !window.__phot.field.busy && (window.__phot.field.wcs || /err/.test(document.querySelector("#cardWcs .fstat").className))', timeout=180000)
    S = pg.evaluate('''() => { const F = window.__phot.field, s = F.sol; return { msg: document.querySelector("#cardWcs .fstat").textContent, ok: !!(s && s.ok), n: s && s.nMatch, rms: s && s.rms, rmsPx: s && s.rmsPx, scale: F.wcs && F.wcs.scale, rot: F.wcs && F.wcs.rotation, flipped: F.wcs && F.wcs.flipped, sip: s && s.sip, gaia: F.gaia && F.gaia.length,
      target: F.target && { name: F.target.name, from: F.target.from, px: F.target.px, star: F.target.star, g: F.target.gaia && F.target.gaia.g, bprp: F.target.gaia && F.target.gaia.bprp }, sRa: document.getElementById("sRa").value, sDec: document.getElementById("sDec").value }; }''')
    tp = (S.get('target') or {}).get('px') or [float('nan')] * 2
    dT = ((tp[0] - EXOTIC_T[0]) ** 2 + (tp[1] - EXOTIC_T[1]) ** 2) ** 0.5
    check('Solve WCS against live VizieR (Gaia DR3)', S['ok'] and S['n'] >= 40 and S['rms'] < 1.5, f"{S['msg']}  [{S['gaia']} Gaia stars fetched]")
    check('HAT-P-32 placed by name where the demo has it', dT < 0.5 and S['target']['g'] and abs(S['target']['g'] - 11.13) < 0.2, f"{S['target']['name']} from {S['target']['from']}: pixel ({tp[0]:.2f}, {tp[1]:.2f}), the demo's target star's centroid ({EXOTIC_T[0]:.2f}, {EXOTIC_T[1]:.2f}), {dT:.2f} px apart; Gaia G {S['target']['g']:.2f}, BP−RP {S['target']['bprp']:.2f}; RA/Dec settings {S['sRa']}, {S['sDec']}")
    # hover: RA / Dec in the readout
    box = pg.eval_on_selector('#img', 'e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }')
    pg.mouse.move(box[0] + box[2] / 2, box[1] + box[3] / 2); pg.wait_for_timeout(200)
    ro = pg.text_content('#readout')
    check('RA and Dec in the hover readout', re.search(r'\d\d:\d\d:\d\d\.\d [+−]\d\d:\d\d:\d\d', ro or '') is not None, ro)
    pg.screenshot(path=os.path.join(out, 'solved.png'))

    # ---- 3. buttons: use as target, rank, add, apertures
    pg.evaluate('() => { window.__phot.stars = []; window.__phot.fieldTools.render(); }')
    pg.click('#cardWcs button:has-text("Use as target")'); pg.wait_for_timeout(300)
    st = pg.evaluate('() => window.__phot.stars.map((s) => [s.x, s.y])')
    check('“Use as target” makes it T', len(st) == 1 and ((st[0][0] - EXOTIC_T[0]) ** 2 + (st[0][1] - EXOTIC_T[1]) ** 2) ** 0.5 < 1.0, json.dumps(st))
    pg.click('#bRankGaia')
    pg.wait_for_function('() => window.__phot.field.ranked && window.__phot.field.ranked.length > 0', timeout=120000)
    R = pg.evaluate('''() => { const F = window.__phot.field; return { msg: document.querySelector("#cardWcs .fstat").textContent, vsx: F.vsx ? F.vsx.length : null, rows: F.ranked.slice(0, 8).map((q) => ({ at: [Math.round(q.x), Math.round(q.y)], g: q.gaia && q.gaia.g, bprp: q.gaia && q.gaia.bprp, usable: q.usable, notes: q.notes })), variables: F.ranked.filter((q) => q.variable).map((q) => q.notes.filter((n) => /variable|VSX/.test(n)).join(', ')), shown: document.querySelectorAll("#cardWcs .granked li").length }; }''')
    check('ranked with Gaia: G, BP−RP and reasons, variables set aside', R['shown'] >= 5 and all(r['g'] for r in R['rows'][:5]) and len(R['variables']) >= 1 and all(not r['usable'] or not any('VSX' in n or 'variable' in n for n in r['notes']) for r in R['rows']),
          f"{R['msg']} VSX entries {R['vsx']}; top: " + ' | '.join(f"{r['at']} G {r['g']:.2f} BP−RP {r['bprp']:.2f}{' ' + '; '.join(r['notes']) if r['notes'] else ''}{'' if r['usable'] else ' (not recommended)'}" for r in R['rows'][:5]) + f"; variables: {R['variables']}")
    pg.select_option('#cardWcs select', '3'); pg.click('#bAddTop'); pg.wait_for_timeout(300)
    n = pg.evaluate('() => window.__phot.stars.length')
    check('“Add the best” 3', n == 4, f'{n} stars now (T + {n - 1})')
    pg.click('#bOptAp'); pg.wait_for_function('() => window.__phot.field.apertures', timeout=30000)
    A = pg.evaluate('() => { const A = window.__phot.field.apertures; return { rows: A.rows, lo: A.lo, hi: A.hi, sA0: document.getElementById("sA0").value, sA1: document.getElementById("sA1").value, sigma: A.sigma, text: [...document.querySelectorAll("#cardWcs .fsec")].pop().textContent.slice(0, 400) }; }')
    check('“Set apertures from the stars”: SNR-optimal radii centre the search', float(A['sA0']) == A['lo'] and float(A['sA1']) == A['hi'] and 0.5 < A['rows'][0]['sigmas'] < 5,
          f"PSF σ {A['sigma']:.2f} px; " + ', '.join(f"{r['name']} {r['radius']:.2f} px ({r['sigmas']:.2f} σ, SNR {r['snr']:.0f})" for r in A['rows']) + f"; search {A['sA0']}–{A['sA1']} σ")
    pg.screenshot(path=os.path.join(out, 'ranked.png'), full_page=True)

    # ---- 4. assistant tools on a fresh page, and another frame
    demo()
    r1 = call('photometry_solve_wcs', {'target': 'HAT-P-32'})
    check('photometry_solve_wcs', r1['ok'] and r1['data']['solved'], json.dumps(r1)[:400])
    r2 = call('photometry_choose_target', {'name': 'HAT-P-32'})
    check('photometry_choose_target', r2['ok'] and r2['data']['star'] and abs(r2['data']['star'][0] - EXOTIC_T[0]) < 1 and abs(r2['data']['star'][1] - EXOTIC_T[1]) < 1, json.dumps(r2)[:400])
    r3 = call('photometry_rank_comparisons', {'add': 2})
    check('photometry_rank_comparisons (add 2)', r3['ok'] and len(r3['data']['ranked']) >= 5 and len(r3['data']['comparisons_now']) >= 2, json.dumps(r3)[:500])
    r4 = call('photometry_optimal_apertures', {})
    check('photometry_optimal_apertures', r4['ok'] and r4['data']['aperture_range_sigma'], json.dumps(r4)[:400])
    pg.evaluate('async () => { const s = document.getElementById("frame"); s.value = 30; s.dispatchEvent(new Event("input")); }'); pg.wait_for_timeout(800)
    f30 = pg.evaluate('''() => { const W = window.__phot.fieldTools.wcsFor(30), F = window.__phot.field; if (!W) return null; const [x, y] = W.skyToPix(F.target.ra, F.target.dec), c = window.__phot.cur;
      // the star there: flux-weighted centroid above the median in a 9 x 9 box, twice
      const d = c.data, w = c.width, med = [...d].sort((a, b) => a - b)[d.length >> 1]; let cx = x, cy = y;
      for (let it = 0; it < 3; it++) { let s = 0, sx = 0, sy = 0; for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) { const X = Math.round(cx) + i, Y = Math.round(cy) + j, v = d[Y * w + X] - med; if (v > 0) { s += v; sx += v * X; sy += v * Y; } } cx = sx / s; cy = sy / s; }
      return { x, y, star: [cx, cy], frame: window.__phot.frame, crop: [c.header.CROPX0, c.header.CROPY0], crop0: [window.__phot.lights[0].header.CROPX0, window.__phot.lights[0].header.CROPY0] }; }''')
    if f30:
        check('frame 31: WCS through the tracking transform puts the target on the star', ((f30['x'] - f30['star'][0]) ** 2 + (f30['y'] - f30['star'][1]) ** 2) ** 0.5 < 1, f"HAT-P-32 predicted at ({f30['x']:.2f}, {f30['y']:.2f}), star centroid ({f30['star'][0]:.2f}, {f30['star'][1]:.2f}); window origin {f30['crop']} vs {f30['crop0']} on frame 1")
    else: check('frame 31: WCS through the tracking transform', False, 'no WCS for frame 31')
    pg.screenshot(path=os.path.join(out, 'frame31.png'))

    # ---- 5. phone
    m = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    mp = m.new_page(); mp.on('pageerror', lambda e: errors.append('phone: ' + str(e)))
    mp.goto(base + '/analyze/photometry/?demo=3&inspect')
    mp.wait_for_function('() => window.__esl && window.__esl.photometry && window.__esl.photometry.ready() && window.__phot.stars.length === 3', timeout=60000)
    mp.evaluate('() => window.__phot.fieldTools.solve({ target: "HAT-P-32" })')
    mp.evaluate('() => window.__phot.fieldTools.rank()')
    small = mp.evaluate('''() => [...document.querySelectorAll('#cardWcs button, #cardWcs select, #cardWcs input[type=text], #cardWcs a.btn, #cardWcs summary')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('details:not([open]) > :not(summary)') && (r.height < 39.5 || r.width < 39.5); }).map((e) => e.tagName + ' ' + (e.textContent || e.value || '').trim().slice(0, 16) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))''')
    sw = mp.evaluate('() => document.documentElement.scrollWidth')
    check('phone: Field card controls at least 40 px, no sideways scroll', not small and sw <= 391, f'{small[:6]}; scroll width {sw}')
    mp.evaluate('() => document.getElementById("cardWcs").scrollIntoView()'); mp.screenshot(path=os.path.join(out, 'phone.png'))

    check('no page errors', not errors, '; '.join(errors[:5]))
    br.close()
print('all ok' if ok else 'FAILED')
sys.exit(0 if ok else 1)
