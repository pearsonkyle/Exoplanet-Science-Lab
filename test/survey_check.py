"""Browser check of the Observe page's survey image (src/sky/survey.js): are the resampled HiPS tiles where the sky is?

Run with .venv/bin/python (Playwright) against the dev server (or ESL_BASE), with the network:
    .venv/bin/python test/survey_check.py [field ...]      fields: hatp32 (default), wasp12, pole, south

For each field the page opens the survey image of the target (DSS2 red, 15 arcmin, 512 px) and two independent
checks are made on the image it resampled from the HiPS tiles:
  1. NASA SkyView's DSS2 Red image of the same field (TAN, 512 px, 0.25 deg; SkyView's own resampling of the DSS
     plates, not HiPS) is fetched here and handed to the page; the Pearson correlation of the two images is printed,
     with that of the image moved by 1 and 3 pixels for scale.
  2. The Gaia DR3 stars (12 < G < 16) on the image: the centroid of the light within 4 px of each predicted position,
     the offset from the Gaia position in arcsec (median and 90th percentile).
"""
import sys, os, json, base64, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('ESL_BASE', 'http://localhost:5173').rstrip('/')
FIELDS = {'hatp32': ('HAT-P-32', 31.04273, 46.68784), 'wasp12': ('WASP-12', 97.63664, 29.67229),
          'pole': ('Polaris', 37.95456, 89.26411), 'south': ('WASP-46', 318.7370, -55.8718)}

JS = r"""async ([ra, dec, name, sky]) => {
  const S = await import('/src/sky/survey.js'), G = await import('/src/core/skyfield.js');
  const c = S.openSurvey(document.getElementById('sky'), { name, ra, dec, mag: null }, { year: 2026.9 });
  c.setSurvey('dssred'); c.set('size', 15);
  const rep = await c.settled(60000), cell = c.V.cells.get('0,0');
  if (!cell || !cell.canvas) return { error: 'no image', rep };
  const N = 512, gray = (data) => { const g = new Float64Array(N * N); for (let k = 0; k < N * N; k++) g[k] = (data[4 * k] + data[4 * k + 1] + data[4 * k + 2]) / 3; return g; };
  const mine = gray(cell.canvas.getContext('2d').getImageData(0, 0, N, N).data);
  const img = new Image(); img.src = sky; await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const x = cv.getContext('2d'); x.drawImage(img, 0, 0, N, N); const ref = gray(x.getImageData(0, 0, N, N).data);
  const corr = (a, b, dx, dy) => { let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let r = 8; r < N - 8; r++) for (let q = 8; q < N - 8; q++) { const A = a[r * N + q], B = b[(r + dy) * N + q + dx]; n++; sa += A; sb += B; saa += A * A; sbb += B * B; sab += A * B; }
    return (sab / n - sa / n * sb / n) / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)); };
  const off = [];
  for (const s of c.V.nb) {
    if (!(s.g > 12 && s.g < 16)) continue;
    const [q0, r0] = G.planeToCell(s.u, s.v, 0, 0, N); if (q0 < 8 || r0 < 8 || q0 > N - 9 || r0 > N - 9) continue;
    let bg = []; for (let r = Math.round(r0) - 7; r <= Math.round(r0) + 7; r++) for (let q = Math.round(q0) - 7; q <= Math.round(q0) + 7; q++) if (Math.hypot(q - q0, r - r0) > 5.5) bg.push(mine[r * N + q]);
    bg.sort((a, b) => a - b); const b0 = bg[bg.length >> 1];
    let w = 0, sq = 0, sr = 0;
    for (let r = Math.round(r0) - 4; r <= Math.round(r0) + 4; r++) for (let q = Math.round(q0) - 4; q <= Math.round(q0) + 4; q++) { if (Math.hypot(q - q0, r - r0) > 4) continue; const v = Math.max(0, mine[r * N + q] - b0); w += v; sq += v * q; sr += v * r; }
    if (w > 0) off.push(Math.hypot(sq / w - q0, sr / w - r0) * c.V.plane.scale);
  }
  off.sort((a, b) => a - b);
  const out = { name, source: cell.source, scale: c.V.plane.scale, corr: corr(mine, ref, 0, 0), corr1: corr(mine, ref, 1, 0), corr3: corr(mine, ref, 3, 0), stars: off.length, median: off[off.length >> 1], p90: off[Math.floor(off.length * 0.9)] };
  c.close(); return out;
}"""

fields = sys.argv[1:] or ['hatp32']
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1200, 'height': 900})
    pg.goto(BASE + '/observe/?skipintro&noassistant'); pg.wait_for_timeout(3000)
    for f in fields:
        name, ra, dec = FIELDS[f]
        url = f'https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl?Position={ra},{dec}&Survey=DSS2+Red&Pixels=512&Size=0.25&Projection=Tan&Coordinates=J2000&Return=JPG'
        sky = 'data:image/jpeg;base64,' + base64.b64encode(urllib.request.urlopen(url, timeout=120).read()).decode()
        r = pg.evaluate(JS, [ra, dec, name, sky])
        if 'error' in r: print('FAIL', name, r); bad += 1; continue
        good = r['corr'] > 0.8 and r['median'] < 0.75 * r['scale']   # Polaris' halo makes the correlation insensitive to a shift; the Gaia centroids are not
        bad += not good
        print(('ok   ' if good else 'FAIL ') + f"{name}: correlation with SkyView DSS2 Red {r['corr']:.3f} (moved 1 px {r['corr1']:.3f}, 3 px {r['corr3']:.3f}); "
              f"{r['stars']} Gaia stars 12 < G < 16, centroid offset median {r['median']:.2f}\", 90% {r['p90']:.2f}\" (pixel {r['scale']:.2f}\"); {r['source']}")
    b.close()
sys.exit(1 if bad else 0)
