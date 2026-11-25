// UI audit: screenshots of every page and state at phone, tablet and desktop sizes, with measurements of what
// usually goes wrong on a phone (sideways scroll, clipped text, text broken one word per line, small tap targets,
// small text, controls off the screen).
//   node tools/uiaudit.mjs OUT_DIR [--base http://127.0.0.1:5173] [--only TEXT] [--sizes iphone,ipad] [--full]
// Needs the dev server (npm run dev) or a built copy, and Playwright with Chromium (`npm i -D playwright` or a global
// one on NODE_PATH). Writes OUT_DIR/<page>@<size>.png and OUT_DIR/report.json; prints one line per finding.
// What it cannot see: iOS Safari itself (100vh, safe-area insets, zoom on focus). Phones are emulated in Chromium
// with touch, a mobile viewport and the device's pixel ratio.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = createRequire('/opt/node-tools/')('playwright')); }

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const base = opt('--base', process.env.ESL_BASE || 'http://127.0.0.1:5173').replace(/\/$/, '');
const only = opt('--only'), sizesArg = opt('--sizes'), full = flag('--full'), scale = +opt('--scale', '1');
const out = args[0] || 'uiaudit'; mkdirSync(out, { recursive: true });

export const SIZES = {
  'iphone-se': { w: 375, h: 667, mobile: true }, // the narrowest phone still in use
  iphone: { w: 393, h: 852, mobile: true }, // iPhone 15 / 16
  'iphone-max': { w: 430, h: 932, mobile: true },
  'iphone-land': { w: 852, h: 393, mobile: true },
  'ipad': { w: 820, h: 1180, mobile: true },
  'ipad-land': { w: 1180, h: 820, mobile: true },
  laptop: { w: 1366, h: 768 },
  desktop: { w: 1920, h: 1080 },
};
const planReady = 'window.__plan && !!window.__plan.A.info';
const searchReady = 'window.__search && window.__search.S.rows.length > 0';
const photReady = 'window.__phot && window.__phot.ready === true';
// name, path, ready (JS that becomes true), steps (JS run in order, 500 ms apart)
export const PAGES = [
  ['home', '', null, []],
  ['plan', 'plan/', planReady, []],
  ['plan-charts', 'plan/', planReady, ["document.querySelector('.p-views [data-view=grid]').click()"]],
  ['plan-eph', 'plan/', planReady, ["document.querySelector('.p-views [data-view=eph]').click()"]],
  ['plan-transit', 'plan/', planReady, ["document.querySelector('.p-views [data-view=list]').click()", "(document.querySelector('#p-list .ev') || document.body).click()"]],
  ['plan-open', 'plan/', planReady, ["document.querySelectorAll('#p-form details, #p-sitebox').forEach((d) => { d.open = true; }); window.dispatchEvent(new Event('resize'))"]],
  ['search', 'search/', searchReady, []],
  ['search-panels', 'search/', searchReady, ["document.getElementById('s-filters').hidden = false; document.getElementById('s-cols').hidden = false"]],
  ['search-detail', 'search/?planet=WASP-12%20b', searchReady + " && !document.getElementById('s-detail').hidden", []],
  ['photometry', 'analyze/photometry/', null, []],
  ['photometry-demo', 'analyze/photometry/?demo=2', photReady, []],
  ['photometry-inspect', 'analyze/photometry/?demo=2&inspect', photReady + ' && window.__phot.stars.length > 0',
    ["window.__phot.inspector.setTool('profile'); window.__phot.inspector.examine(window.__phot.stars[0].x, window.__phot.stars[0].y)"]],
  ['spectroscopy', 'analyze/spectroscopy/', null, []],
  ['atmosphere', 'analyze/atmosphere/', null, []],
  ['retrieval', 'analyze/retrieval/', null, []],
  ['star', 'analyze/star/', null, []],
  ['analyze-start', 'analyze/', null, []],
  ['analyze', 'analyze/?skipintro', null, []],
  ['observe', 'observe/', null, []],
  ['observe-run', 'observe/run/', null, []],
  ['methods', 'methods/', "document.documentElement.dataset.methods === 'ready'", []],
  ['methods-validation', 'methods/#validation', "document.documentElement.dataset.validation === 'ready' || !!document.querySelector('#status.ok, #status.bad')", []],
  ['methods-repro', 'methods/#reproducibility', "document.documentElement.dataset.validation === 'ready'", []],
  ['methods-refs', 'methods/#references', "document.documentElement.dataset.methods === 'ready'", []],
  ['methods-cite', 'methods/#cite', "!!document.querySelector('#citeTool[data-ready]')", []],
  ['menu-open', 'plan/', planReady, ["(document.querySelector('#sitebar .sitemenu, #sitebar .menu, #sitebar button') || document.body).click()"]],
  ['project-panel', 'plan/', "!!document.querySelector('.siteproject')", ["document.querySelector('.siteproject').click()", "(document.getElementById('pj-start') || document.body).click()"]],
  ['assistant', 'analyze/?skipintro', "!!document.getElementById('esl-ai-launch')", ["document.getElementById('esl-ai-launch').click()", 'void 0']],
];

// Run in the page. Everything is measured on what is visible; an element inside a scroller counts by its clipped box.
const MEASURE = `((W, H, mobile) => {
  const de = document.documentElement, res = { scrollWidth: de.scrollWidth, pageHeight: de.scrollHeight };
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !e.closest('[hidden]'); };
  const name = (e) => { let s = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''); const p = e.parentElement; if (!e.id && p && p !== document.body) s = (p.id ? '#' + p.id : p.tagName.toLowerCase() + (typeof p.className === 'string' && p.className.trim() ? '.' + p.className.trim().split(/\\s+/)[0] : '')) + ' > ' + s; return s + ' "' + (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 24) + '"'; };
  const scroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return p; return null; };
  const clipParent = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return p; return null; };
  const all = [...document.querySelectorAll('body *')].filter(vis);
  const top = (list, n = 8) => ({ n: list.length, list: list.slice(0, n) });
  // 1 sideways scroll of the page
  res.overflow = de.scrollWidth > W + 1 ? top(all.filter((e) => e.getBoundingClientRect().right > W + 1 && !clipParent(e)).map((e) => name(e) + ' to ' + Math.round(e.getBoundingClientRect().right)), 5) : { n: 0, list: [] };
  // 2 text cut off by its own box (ellipsis or hidden) and boxes that scroll sideways
  const cut = [], hscroll = [];
  for (const e of all) {
    const cs = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0) {
      if (/(hidden|clip)/.test(cs.overflowX) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) cut.push(name(e) + ' ' + e.clientWidth + '/' + e.scrollWidth);
      else if (/(auto|scroll)/.test(cs.overflowX) && !/^(pre|code|textarea)$/i.test(e.tagName)) hscroll.push(name(e) + ' ' + e.clientWidth + '/' + e.scrollWidth);
    }
    if (/^(input|select)$/i.test(e.tagName) && e.type !== 'range' && e.type !== 'checkbox' && e.type !== 'radio' && e.type !== 'file' && e.type !== 'color') {
      if (e.tagName === 'INPUT' && e.scrollWidth > e.clientWidth + 2 && e.value) cut.push(name(e) + ' value ' + e.clientWidth + '/' + e.scrollWidth);
    }
  }
  res.cut = top(cut); res.hscroll = top(hscroll);
  // 3 text broken into a narrow column: three or more lines averaging under 9 characters, or a single word broken
  const narrow = [];
  for (const e of all) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    const t = (e.innerText || '').trim(); if (t.length < 12 || e.children.length > 3) continue;
    const cs = getComputedStyle(e), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3, r = e.getBoundingClientRect();
    const lines = Math.round(r.height / lh);
    if (lines >= 3 && t.length / lines < 9 && cs.display !== 'inline') narrow.push(name(e) + ' ' + lines + ' lines in ' + Math.round(r.width) + ' px');
  }
  res.narrow = top(narrow);
  // 4 tap targets under 40 px (phones only) and 5 text under 11 px
  const taps = [], small = [];
  if (mobile) for (const e of document.querySelectorAll('a[href], button, select, input:not([type=hidden]):not([type=file]), summary, textarea, [role=button], [role=tab]')) {
    if (!vis(e)) continue;
    let r = e.getBoundingClientRect();
    if ((e.type === 'checkbox' || e.type === 'radio') && e.closest('label')) r = e.closest('label').getBoundingClientRect();
    if (e.tagName === 'A' && getComputedStyle(e).display === 'inline' && e.closest('p, li, td, .note, small')) continue; // a link inside running text
    if (r.width < 39.5 || r.height < 39.5) taps.push(name(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  for (const e of all) { if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue; const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 11) small.push(name(e) + ' ' + fs); }
  res.taps = top(taps, 12); res.small = top(small);
  // 6 controls outside the screen that no scroller reaches
  const off = [];
  for (const e of document.querySelectorAll('button, a[href], select, input, summary')) { if (!vis(e)) continue; const r = e.getBoundingClientRect(); if ((r.right > W + 2 || r.left < -2) && !scroller(e)) off.push(name(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  res.off = top(off);
  // 7 empty space: big visible boxes (a quarter of the screen or more) whose content covers under a third of them
  const empty = [];
  for (const e of all) {
    const r = e.getBoundingClientRect(); if (r.width * r.height < W * H * 0.2 || !e.children.length || /^(canvas|svg|img|video|table|tbody)$/i.test(e.tagName) || e.querySelector('canvas, svg, img, video')) continue;
    let a = 0; for (const c of e.children) { if (!vis(c)) continue; const q = c.getBoundingClientRect(); a += Math.max(0, Math.min(q.right, r.right) - Math.max(q.left, r.left)) * Math.max(0, Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top)); }
    if (a / (r.width * r.height) < 0.33 && r.top < H) empty.push(name(e).slice(0, 60) + ' ' + Math.round(100 * a / (r.width * r.height)) + '% of ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  res.empty = top(empty, 5);
  // 8 inputs under 16 px: iOS Safari zooms the page when one takes focus
  const zoom = [];
  if (mobile) for (const e of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]):not([type=color]):not([type=button]), select, textarea')) { if (vis(e) && parseFloat(getComputedStyle(e).fontSize) < 16) zoom.push(name(e) + ' ' + parseFloat(getComputedStyle(e).fontSize)); }
  res.zoom = top(zoom, 4);
  return res;
})`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const sizes = Object.entries(SIZES).filter(([k]) => !sizesArg || sizesArg.split(',').includes(k));
  const pages = PAGES.filter(([n]) => !only || only.split(',').some((t) => n.includes(t)));
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = {};
  for (const [sname, s] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: scale, isMobile: !!s.mobile, hasTouch: !!s.mobile,
      userAgent: s.mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined });
    for (const [name, path, ready, steps] of pages) {
      const pg = await ctx.newPage(), errs = [];
      pg.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
      pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::|CORS|WebGL|GPU/.test(m.text())) errs.push('console ' + m.text().slice(0, 160)); });
      try {
        await pg.goto(base + '/' + path, { waitUntil: 'load', timeout: 60000 });
        if (ready) await pg.waitForFunction(ready, null, { timeout: 30000 }).catch(() => errs.push('NOT READY: ' + ready));
        await pg.waitForTimeout(1200);
        for (const st of steps) { await pg.evaluate(st).catch((e) => errs.push('STEP ' + e.message.slice(0, 120))); await pg.waitForTimeout(500); }
        const m = await pg.evaluate(`${MEASURE}(${s.w}, ${s.h}, ${!!s.mobile})`);
        m.errors = errs; report[`${name}@${sname}`] = m;
        await pg.screenshot({ path: join(out, `${name}@${sname}.png`), fullPage: full });
        const bad = ['overflow', 'off', 'narrow', 'cut', 'hscroll', 'taps', 'small', 'zoom', 'empty'].filter((k) => m[k].n).map((k) => `${k} ${m[k].n}`);
        console.log(`${name}@${sname}  h=${m.pageHeight}  ${bad.join(', ') || 'clean'}${errs.length ? '  ERRORS ' + errs.length : ''}`);
      } catch (e) { console.log(`${name}@${sname}  FAILED ${e.message.slice(0, 200)}`); report[`${name}@${sname}`] = { failed: e.message }; }
      await pg.close();
    }
    await ctx.close();
  }
  await browser.close();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1));
}
