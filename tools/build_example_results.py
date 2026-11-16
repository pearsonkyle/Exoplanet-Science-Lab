# Run every worked example of the analyzer in a headless browser and store the finished session (data, priors,
# posterior draws) under public/examples/results/<id>.json, so the example opens with its results in place.
# Needs the dev server (npm run dev, port 5173) or, to be safe from hot reloads while files are being edited, a built
# copy served statically (npm run build; python3 -m http.server 8899 -d dist; ESL_BASE=http://localhost:8899), and the virtualenv:
#   .venv/bin/python tools/build_example_results.py [id ...]
# Examples whose point is the Timing tab (no parameters to sample) are skipped.
import json, os, sys, time
from playwright.sync_api import sync_playwright
OUT = 'public/examples/results'; os.makedirs(OUT, exist_ok=True)
SKIP = {'ephemeris', 'decay'}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1440, 'height': 900}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(os.environ.get('ESL_BASE', 'http://localhost:5173') + '/analyze/?skipintro'); pg.wait_for_timeout(2500)
    ids = sys.argv[1:] or [e['id'] for e in pg.evaluate('window.__esl.api.examples()')]
    for ex in ids:
        if ex in SKIP: print(f'{ex}: skipped (timing only)'); continue
        t0 = time.time()
        # the N-body example's result is the companion fit: search the times for a perturber, add it, then sample
        pre = """const find = (re) => [...document.querySelectorAll('#tab-timing button')].find((x) => re.test(x.textContent));
            A.showTab('timing'); await new Promise((r) => setTimeout(r, 400)); find(/unseen companion/).click();
            for (let k = 0; k < 600 && !find(/Add it as a planet/); k++) await new Promise((r) => setTimeout(r, 500));
            find(/Add it as a planet/).click(); await new Promise((r) => setTimeout(r, 800));""" if ex == 'nbody' else ''
        doc = pg.evaluate("""async (id) => { const A = window.__esl.api; await A.loadExample(id, { fresh: true }); await new Promise((r) => setTimeout(r, 600)); """ + pre + """
            const r = await A.run(); const d = A.exportSession(true); d.notes = d.notes || ''; return d; }""", ex)
        r = doc['result']
        json.dump(doc, open(f'{OUT}/{ex}.json', 'w'), separators=(',', ':'))
        print(f"{ex}: {len(r['parameters'])} free, {r['ncalls']} calls, converged {r['converged']}, lnZ {r['logZ']:.2f} ± {r['logZerr']:.2f}, "
              f"{os.path.getsize(f'{OUT}/{ex}.json') // 1024} kB, {time.time() - t0:.0f} s" + (f"  warnings: {r['warnings']}" if r['warnings'] else ''))
    b.close()
print('page errors:', errs)
