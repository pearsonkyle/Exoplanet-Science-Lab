"""Build the home page's card art (public/home/<section>.webp, 960 x 480) from the site itself.

    npm run dev                                   # the pages are captured from the dev server on :5173
    .venv/bin/python tools/docs/home_art.py       # all six, or name some: plan observe analyze search methods docs

Each card is composed as a small HTML page and screenshotted, so the layout is plain CSS:
  plan      the planner's transit list with its observatory globe (Kitt Peak)
  observe   the sky view from Kitt Peak on a summer night, exoplanet hosts shown
  analyze   the TESS transit of HD 80606 b with its fit, and the posterior (api.figure: the exported plots' own code)
  search    the catalogue table
  methods   the model's relations, typeset by MathJax (tools/docs/home_art_text.mjs)
  docs      Python from the labs, highlighted by Shiki (same script)
Needs Playwright (in .venv) and cwebp (Homebrew: webp). mathjax-full and shiki come with the docs' dependencies
(vitepress, markdown-it-mathjax3): run npm install first.
"""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "public/home"
BASE = os.environ.get("ESL_BASE", "http://localhost:5173").rstrip("/") + "/"   # a built copy (ESL_BASE) for long runs, else the dev server
W, H = 960, 480
TMP = pathlib.Path(tempfile.mkdtemp(prefix="esl-art-"))
GL = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

FRAME = f"""<!doctype html><meta charset="utf-8"><style>
html, body {{ margin: 0; width: {W}px; height: {H}px; overflow: hidden; background: #070a12; font-family: Inter, system-ui, sans-serif; }}
.fill {{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }}
</style><body>BODY</body>"""


def data_url(path):
    return "data:image/png;base64," + base64.b64encode(pathlib.Path(path).read_bytes()).decode()


def page(browser, url, w=1440, h=900, scale=2, wait=3500):
    pg = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
    sep = "&" if "?" in url else "?"
    pg.goto(BASE + url + sep + "skipintro&noassistant")
    pg.wait_for_timeout(wait)
    return pg


def compose(browser, name, body):
    pg = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    pg.set_content(FRAME.replace("BODY", body))
    pg.wait_for_timeout(300)
    png = TMP / f"{name}.png"
    pg.screenshot(path=str(png))
    pg.close()
    subprocess.run(["cwebp", "-quiet", "-q", "80", str(png), "-o", str(OUT / f"{name}.webp")], check=True)
    print(name, (OUT / f"{name}.webp").stat().st_size // 1024, "KB")


def plan(browser):
    pg = page(browser, "plan/", h=1300, scale=3, wait=5000)
    globe = TMP / "globe.png"
    pg.locator("#p-globe").screenshot(path=str(globe))
    rows = TMP / "rows.png"
    pg.screenshot(path=str(rows), clip={"x": 390, "y": 742, "width": 830, "height": 415})
    pg.close()
    compose(browser, "plan", f"""
<img class="fill" src="{data_url(rows)}" style="filter: brightness(.8)">
<div style="position:absolute; inset:0; background: linear-gradient(90deg, transparent 38%, #070a12dd 62%, #070a12 100%)"></div>
<div style="position:absolute; right:40px; top:40px; width:400px; height:400px; border-radius:50%;
  box-shadow: 0 0 60px 10px #5fd4ff40, 0 0 0 1px #5fd4ff55; overflow:hidden">
  <img src="{data_url(globe)}" style="width:104%; height:104%; margin:-2%; display:block"></div>""")


def observe(browser):
    pg = page(browser, "observe/?lat=31.9633&lon=-111.6&elev=2120&t=2026-07-15T03:40:00Z&az=165&alt=22&fov=115"
                       "&layers=constellations,planets,atmosphere,ground,hosts,labels", w=W, h=H + 120, scale=1, wait=6000)
    pg.add_style_tag(content=".sky-top, .sky-corner, #status, .sky-bar, .panel, #nightBar, #arBar, #sitebar { visibility: hidden !important; }")
    sky = TMP / "sky.png"
    pg.screenshot(path=str(sky), clip={"x": 0, "y": 40, "width": W, "height": H})   # 1:1: the thin lines survive
    pg.close()
    # and a frame of the photometry demo (EXOTIC's HAT-P-32 b sample) with the target and comparison apertures
    pg = page(browser, "analyze/photometry/?demo=3", w=1440, h=1000, scale=2, wait=9000)
    frame = TMP / "frame.png"
    pg.screenshot(path=str(frame), clip={"x": 236, "y": 356, "width": 560, "height": 590})
    pg.close()
    compose(browser, "observe", f"""
<img class="fill" src="{data_url(sky)}">
<div style="position:absolute; inset:0; background: linear-gradient(90deg, transparent 40%, #070a12aa 70%)"></div>
<div style="position:absolute; right:34px; top:30px; width:390px; height:412px; border-radius:10px; overflow:hidden;
  transform: rotate(2deg); box-shadow: 0 18px 50px #000c, 0 0 0 1px #5fd4ff66">
  <img src="{data_url(frame)}" style="width:100%; height:100%; object-fit:cover; display:block">
  <div style="position:absolute; left:0; right:0; bottom:0; padding:8px 12px; background:#070a12cc; color:#9fb3c8; font:13px ui-monospace, Menlo, monospace">
    HAT-P-32 b · target and comparison apertures</div></div>""")


def analyze(browser):
    pg = page(browser, "analyze/", wait=2500)
    pg.evaluate("window.__esl.api.loadExample('hd80606-tess')")
    pg.wait_for_timeout(5000)
    lc = pg.evaluate("window.__esl.api.figure('lc', { width: 760, height: 560, theme: 'dark', scale: 2 })")
    corner = pg.evaluate("window.__esl.api.figure('corner', { width: 560, theme: 'dark', scale: 2 })")
    pg.close()
    compose(browser, "analyze", f"""
<img src="{lc}" style="position:absolute; left:0; top:-4px; width:600px">
<div style="position:absolute; right:0; top:0; width:400px; height:480px; background: linear-gradient(90deg, transparent, #070a12 18%)"></div>
<img src="{corner}" style="position:absolute; right:6px; top:10px; width:440px; filter: drop-shadow(0 0 18px #070a12)">""")


def search(browser):
    pg = page(browser, "search/?q=WASP-1", wait=4000)
    table = TMP / "table.png"
    pg.screenshot(path=str(table), clip={"x": 16, "y": 218, "width": 890, "height": 445})
    pg.close()
    compose(browser, "search", f'<img class="fill" src="{data_url(table)}">')


def text_parts():
    out = subprocess.run(["node", str(ROOT / "tools/docs/home_art_text.mjs")], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def methods(browser, parts):
    eq = parts["equations"]
    spots = [  # left, top, font size, colour
        (40, 40, 30, "#5fd4ff"), (500, 54, 28, "#ffb454"), (60, 196, 34, "#c8a2ff"),
        (420, 188, 26, "#7ee0a6"), (90, 340, 28, "#ff8f8f"),
    ]
    items = "".join(f'<div style="position:absolute; left:{x}px; top:{y}px; font-size:{s}px; color:{c}; text-shadow:0 0 18px {c}55">{svg}</div>'
                    for svg, (x, y, s, c) in zip(eq, spots))
    compose(browser, "methods", f"""
<div class="fill" style="background: radial-gradient(ellipse at 70% 40%, #1a2440 0%, #0b1020 55%, #070a12 100%)"></div>
<svg class="fill" viewBox="0 0 960 480" style="opacity:.35">
  <ellipse cx="700" cy="330" rx="330" ry="90" fill="none" stroke="#5fd4ff" stroke-width="1.2" stroke-dasharray="4 6"/>
  <ellipse cx="700" cy="330" rx="200" ry="55" fill="none" stroke="#5fd4ff" stroke-width="1"/>
  <circle cx="700" cy="330" r="34" fill="#ffd27a"/><circle cx="700" cy="330" r="60" fill="#ffd27a" opacity=".12"/>
  <circle cx="512" cy="351" r="9" fill="#c8a2ff"/>
</svg>
<style>svg[role=img] {{ overflow: visible; }} mjx-container, svg {{ display:block; }}</style>
{items}""")


def docs(browser, parts):
    compose(browser, "docs", f"""
<div class="fill" style="background: radial-gradient(ellipse at 15% 0%, #3b2a6e 0%, transparent 55%),
  radial-gradient(ellipse at 100% 100%, #0f4a5e 0%, transparent 55%), #0b0f18"></div>
<div style="position:absolute; left:44px; top:34px; right:44px; bottom:34px; border-radius:14px; overflow:hidden;
  background:#1a1b26; box-shadow: 0 20px 60px #000a, 0 0 0 1px #ffffff18">
  <div style="height:34px; display:flex; align-items:center; gap:8px; padding:0 14px; background:#16161e; color:#7a83a8; font:13px ui-monospace, Menlo, monospace">
    <i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i>
    <i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i><span style="margin-left:10px">python/labs/lab02_tess_transit.ipynb</span></div>
  <div style="padding:14px 22px; font: 15.5px/1.55 ui-monospace, Menlo, monospace">{parts["code"]}</div>
</div>
<style>pre.shiki {{ margin:0; background:transparent !important; }}</style>""")


if __name__ == "__main__":
    pick = sys.argv[1:] or ["plan", "observe", "analyze", "search", "methods", "docs"]
    OUT.mkdir(parents=True, exist_ok=True)
    parts = text_parts() if {"methods", "docs"} & set(pick) else None
    with sync_playwright() as p:
        b = p.chromium.launch(args=GL)
        for name in pick:
            fn = globals()[name]
            fn(b, parts) if name in ("methods", "docs") else fn(b)
        b.close()
