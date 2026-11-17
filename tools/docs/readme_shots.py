"""Screenshots for README.md (docs/screens/*.webp), taken from the running site.

    npm run dev                                         # or a built copy: ESL_BASE=http://localhost:4199
    .venv/bin/python tools/docs/readme_shots.py         # all, or name some: analyze plan observe photometry companion assistant

Each view is put in a state by the site's own scripting surfaces (window.__esl.api, URL parameters), captured at
1440 x 900 and written as WebP (cwebp, Homebrew: webp). The assistant's view is a stored conversation, not a live model.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/screens"
BASE = os.environ.get("ESL_BASE", "http://localhost:5173").rstrip("/") + "/"
TMP = pathlib.Path(tempfile.mkdtemp(prefix="esl-readme-"))
GL = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


def save(pg, name, **clip):
    png = TMP / f"{name}.png"
    pg.screenshot(path=str(png), **clip)
    subprocess.run(["cwebp", "-quiet", "-q", "78", "-resize", "1280", "0", str(png), "-o", str(OUT / f"{name}.webp")], check=True)
    print(name, (OUT / f"{name}.webp").stat().st_size // 1024, "KB")


def open_page(b, url, wait=4000):
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + url + ("&" if "?" in url else "?") + "skipintro&noassistant")
    pg.wait_for_timeout(wait)
    return pg


def analyze(b):
    pg = open_page(b, "analyze/")
    pg.evaluate("window.__esl.api.loadExample('hd80606-joint')"); pg.wait_for_timeout(6000)
    pg.evaluate("document.querySelector('.tabs [data-tab=results]').click()"); pg.wait_for_timeout(1500)
    save(pg, "analyze"); pg.close()


def plan(b):
    pg = open_page(b, "plan/", 6000)
    pg.evaluate("(() => { const e = document.getElementById('p-count'); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 70); })()"); pg.wait_for_timeout(800)
    save(pg, "plan"); pg.close()


def observe(b):
    pg = open_page(b, "observe/?lat=31.9633&lon=-111.6&elev=2120&t=2026-07-15T04:30:00Z&az=170&alt=30&fov=95&layers=constellations,planets,atmosphere,ground,hosts,labels", 7000)
    pg.evaluate("document.getElementById('filterBtn') && document.getElementById('filterBtn').click()"); pg.wait_for_timeout(1200)
    save(pg, "observe"); pg.close()


def photometry(b):
    pg = open_page(b, "analyze/photometry/?demo=3", 10000)
    pg.evaluate("window.scrollTo(0, 170)"); pg.wait_for_timeout(800)
    save(pg, "photometry"); pg.close()


def companion(b):
    pg = open_page(b, "analyze/")
    pg.evaluate("window.__esl.api.loadExample('kepler88')"); pg.wait_for_timeout(6000)
    pg.evaluate("document.querySelector('.tabs [data-tab=timing]').click()"); pg.wait_for_timeout(5000)
    pg.locator(".cx").scroll_into_view_if_needed(); pg.wait_for_timeout(2500)
    save(pg, "companion"); pg.close()


def assistant(b):
    final = ("The site computes $K$ from the planet's mass, the period and the eccentricity:\n"
             "$$K = \\left(\\frac{2\\pi G}{P}\\right)^{1/3} \\frac{M_p \\sin i}{(M_\\star + M_p)^{2/3}\\sqrt{1-e^2}}$$\n"
             "For HD 80606 b the fit of 264 velocities from seven instruments gives:\n\n"
             "| Quantity | Value |\n|---|---|\n| K | 467.6 +2.6 -2.1 m/s |\n| Planet mass | 4.174 +0.011 -0.010 M Jup |\n| e | 0.93114 +0.00062 -0.00055 |\n\n"
             "A search of the residuals finds no other periodic signal (best peak at 2.435 d, false-alarm probability 0.025).")
    turns = [{"user": "Fit the velocities of HD 80606 b and tell me how K is computed.", "steps": [], "final": final, "notes": []}]
    log = [{"t": 0, "page": "analyze", "type": "user", "text": turns[0]["user"]},
           {"t": 0, "page": "analyze", "type": "tool_start", "id": "call_1", "name": "load_radial_velocities", "args": {"file": "HD80606_RV.csv"}},
           {"t": 0, "page": "analyze", "type": "tool_end", "id": "call_1", "name": "load_radial_velocities", "ok": True, "text": "{}", "ms": 9},
           {"t": 0, "page": "analyze", "type": "tool_start", "id": "call_2", "name": "run_fit", "args": {}},
           {"t": 0, "page": "analyze", "type": "tool_end", "id": "call_2", "name": "run_fit", "ok": True, "text": "{}", "ms": 1470},
           {"t": 0, "page": "analyze", "type": "tool_start", "id": "call_3", "name": "explain_method", "args": {"query": "radial-velocity semi-amplitude"}},
           {"t": 0, "page": "analyze", "type": "tool_end", "id": "call_3", "name": "explain_method", "ok": True, "text": "{}", "ms": 7},
           {"t": 0, "page": "analyze", "type": "assistant", "text": final, "final": True}]
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "analyze/?skipintro"); pg.wait_for_timeout(2500)
    pg.evaluate("window.__esl.api.loadExample('hd80606-rv')"); pg.wait_for_timeout(4000)
    pg.evaluate("(c) => localStorage.setItem('esl.assistant.chat.v1', JSON.stringify(c))", {"turns": turns, "log": log, "actions": [], "open": False, "pending": None, "allowAll": False})
    pg.evaluate("window.__esl.api.loadExample('hd80606-rv')")
    pg.reload(); pg.wait_for_timeout(3000)
    pg.evaluate("window.__esl.api.loadExample('hd80606-rv')"); pg.wait_for_timeout(3500)
    pg.click("#esl-ai-launch"); pg.wait_for_timeout(2000)
    if pg.evaluate("!document.querySelector('.ai-settings').hidden"): pg.click(".ai-setbtn"); pg.wait_for_timeout(400)
    save(pg, "assistant"); pg.close()


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    pick = sys.argv[1:] or ["analyze", "plan", "observe", "photometry", "companion", "assistant"]
    with sync_playwright() as p:
        b = p.chromium.launch(args=GL)
        for name in pick: globals()[name](b)
        b.close()
