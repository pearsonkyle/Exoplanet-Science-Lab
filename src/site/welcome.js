// A gentle first visit. The first time anyone opens the site a small card offers a one-minute tour of the site bar
// (the five sections, the Project checklist, the assistant). The first time each page is opened, a two-line card says
// what the page is for and what to do first. Both are dismissed for good with one click, can be brought back from
// window.__esl.welcome, and never appear in automation (?skipintro, ?noassistant, navigator.webdriver) unless ?tour.
import { startTour } from '../ui/tour.js';

const KEY = 'esl.welcome.v1';
const seen = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const mark = (k) => { try { localStorage.setItem(KEY, JSON.stringify({ ...seen(), [k]: Date.now() })); } catch { /* storage unavailable */ } };

/** What each page is for, in two sentences, and the first thing to try. Keys are the site bar's data-active (photometry and spectroscopy apart). */
export const PAGE_INTROS = {
  home: { title: 'Exoplanet Science Lab', text: 'Plan an observation, look at your sky, reduce your images, fit light curves and velocities, and write it up — all in this browser; nothing is uploaded.', first: 'Pick a section in the bar above, or open Analyze for a worked example.' },
  plan: { title: 'Plan', text: 'The transits, eclipses and phase-curve windows you can observe from your site in the coming nights, scored by altitude, darkness and how well the time is known.', first: 'Choose your observatory under Site, then click a transit in the list.' },
  observe: { title: 'Observe', text: 'Your sky from any place at any time: stars with planets coloured by how they were found, the Moon and planets, and the terrain horizon.', first: 'Tap a star to see its planets; the legend filters by discovery method.' },
  analyze: { title: 'Analyze · Processed Data', text: 'Model and fit transits, radial velocities and timing with nested sampling; the 3D view, the data window and the side panel all follow the same parameters.', first: 'Press Start for a worked example, or drop a light curve on the Data tab.' },
  photometry: { title: 'Analyze · Photometry', text: 'Images (or TESS, Kepler and K2 pixels) in, light curve out: inspect stars and focus, choose comparison stars, and let every aperture be tried.', first: 'Open a folder or a zip of FITS frames, or try the HAT-P-32 b frames.' },
  spectroscopy: { title: 'Analyze · Spectroscopy', text: 'Extracted JWST and Ariel time-series spectra in, a transmission or emission spectrum out, with a simulator for planning.', first: 'Load x1dints files, or simulate a planet.' },
  search: { title: 'Search', text: 'Every known planet and TESS candidate, with where each number comes from and how the archives disagree.', first: 'Type a name or filter by period, radius or brightness; click a row for the comparison.' },
  methods: { title: 'Methods', text: 'How every technique is done, how well it agrees with other codes and published results, and what to cite.', first: 'Start with the section for the analysis you plan to publish.' },
};

const TOUR = [
  { target: '#sitebar a[href$="plan/"]', title: 'Plan', text: 'Which transits you can observe from your site, and when.' },
  { target: '#sitebar a[href$="observe/"]', title: 'Observe', text: 'Your sky at any time, with the planet hosts marked.' },
  { target: '#sitebar a[href$="analyze/"]', title: 'Analyze', text: 'Three parts, in the bar under this one: <b>Processed Data</b> (fit light curves, velocities, times), <b>Photometry</b> (images to light curves) and <b>Spectroscopy</b>.' },
  { target: '#sitebar a[href$="search/"]', title: 'Search', text: 'The catalogue of known planets and candidates, with sources.' },
  { target: '#sitebar a[href$="methods/"]', title: 'Methods', text: 'The equations, their checks and the references, written to be cited.' },
  { target: '.siteproject', title: 'Project', text: 'An optional checklist that follows you from choosing a target to the report, and tells you what to do on each page.' },
  { target: '#esl-ai-launch', title: 'Assistant', text: 'Ask it to set a page up, run a fit or write the report. It needs a language model (your own server); what it changes is listed and can be undone.' },
];

const CSS = `
.tour-veil { position: fixed; inset: 0; z-index: 80; pointer-events: none; }
.tour-ring { position: fixed; z-index: 81; border: 2px solid var(--star, #ffc56b); border-radius: 8px; box-shadow: 0 0 0 9999px #05070c80, 0 0 18px #ffc56b66; pointer-events: none; transition: left .18s, top .18s, width .18s, height .18s; }
.tour-card { position: fixed; z-index: 82; background: #0e1424; border: 1px solid var(--line2, #2b3550); border-radius: 10px; padding: 12px 14px 10px; box-shadow: 0 10px 40px #000a; transition: left .18s, top .18s; color: var(--text, #dfe6f3); font: 13px/1.5 var(--sans, system-ui); }
.tour-card h4 { margin: 2px 0 6px; font-size: 15px; }
.tour-step { color: var(--star, #ffc56b); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; }
.tour-text { font-size: 13px; line-height: 1.5; } .tour-text b { color: #fff; }
.tour-btns { display: flex; gap: 8px; align-items: center; margin-top: 10px; } .tour-btns span { flex: 1; }
.tour-btns button { font: inherit; color: inherit; background: none; border: 1px solid var(--line2, #2b3550); border-radius: 6px; padding: 5px 12px; cursor: pointer; min-height: 32px; }
.tour-next { border-color: #5fd4ff88 !important; background: #5fd4ff22 !important; color: #e9f8ff !important; }
.esl-hello { position: fixed; z-index: 70; left: max(12px, env(safe-area-inset-left)); bottom: max(12px, env(safe-area-inset-bottom)); width: min(340px, calc(100vw - 96px)); background: #0b0f18f2; border: 1px solid var(--line2, #2b3550); border-radius: 12px; box-shadow: 0 12px 34px #000b; padding: 12px 14px; color: var(--text, #dfe6f3); font: 13px/1.45 var(--sans, system-ui); }
.esl-hello b.t { display: block; font-size: 14px; margin-bottom: 3px; }
.esl-hello p { margin: 0 0 4px; color: #c6d0e4; } .esl-hello p.f { color: var(--dim, #8491ad); font-size: 12.5px; }
.esl-hello .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.esl-hello button { font: inherit; cursor: pointer; border-radius: 7px; padding: 6px 12px; min-height: 34px; border: 1px solid var(--line2, #2b3550); background: none; color: var(--dim, #8491ad); }
.esl-hello button.go { border-color: #5fd4ff88; background: #5fd4ff22; color: #e9f8ff; }
.esl-hello .x { position: absolute; top: 4px; right: 4px; border: 0; padding: 4px 8px; min-height: 0; font-size: 15px; }
@media (pointer: coarse) { .esl-hello button { min-height: 40px; } .esl-hello .x { min-width: 40px; min-height: 40px; } .tour-btns button { min-height: 40px; } }
@media print { .esl-hello { display: none; } }
`;

function pageId() {
  const bar = document.getElementById('sitebar'), a = (bar && bar.dataset.active) || '';
  if (a === 'analyze' && /\/photometry\//.test(location.pathname)) return 'photometry';
  if (a === 'analyze' && /\/spectroscopy\//.test(location.pathname)) return 'spectroscopy';
  return a || 'home';
}
const quiet = () => { const q = new URLSearchParams(location.search); return !q.has('tour') && (q.has('skipintro') || q.has('noassistant') || q.has('noproject') || (typeof navigator !== 'undefined' && navigator.webdriver)); };

let card = null;
function close(k) { if (card) { card.remove(); card = null; } if (k) mark(k); }
function show({ title, text, first, buttons, key }) {
  close();
  card = document.createElement('aside'); card.className = 'esl-hello'; card.setAttribute('role', 'note'); card.setAttribute('aria-label', title);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  card.innerHTML = `<button class="x" aria-label="Dismiss">✕</button><b class="t">${esc(title)}</b><p>${esc(text)}</p>${first ? `<p class="f">${esc(first)}</p>` : ''}<div class="row"></div>`;
  for (const b of buttons) { const el = document.createElement('button'); el.textContent = b.label; if (b.primary) el.className = 'go'; el.onclick = () => { close(key); b.run && b.run(); }; card.querySelector('.row').append(el); }
  card.querySelector('.x').onclick = () => close(key);
  document.body.append(card);
}

/** The tour of the site bar; on the analyzer it hands over to the analyzer's own tour at the end when asked. */
export function startSiteTour() {
  close();
  const steps = TOUR.filter((s) => document.querySelector(s.target));
  // the folded phone menu hides the section links: point at the menu button instead
  const menu = document.querySelector('#sitebar .sitemenu, #sitebar [aria-label*="menu" i]');
  const visible = (sel) => { const e = document.querySelector(sel); return !!(e && e.getBoundingClientRect().width > 0); };
  let list = steps.map((s) => (visible(s.target) || !menu ? s : { ...s, folded: true, target: () => menu }));
  // a phone: the sections are folded into the menu, so one step names them all instead of five on the same button
  const folded = list.filter((s) => s.folded);
  if (folded.length > 1) list = [{ target: () => menu, title: 'The sections', text: folded.map((s) => `<b>${s.title}</b>: ${s.text.replace(/<[^>]+>/g, '')}`).join('<br>') }, ...list.filter((s) => !s.folded)];
  return startTour(list, { label: 'Welcome', onEnd: () => mark('tour') });
}

export function mountWelcome() {
  if (typeof document === 'undefined' || window.__esl?.welcome) return;
  if (!document.getElementById('esl-welcome-css')) { const st = document.createElement('style'); st.id = 'esl-welcome-css'; st.textContent = CSS; document.head.append(st); }
  const api = { start: startSiteTour, reset: () => { try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ } }, intro: (id = pageId()) => showIntro(id, true), PAGE_INTROS };
  window.__esl = window.__esl || {}; window.__esl.welcome = api;
  if (quiet() && !new URLSearchParams(location.search).has('tour')) return;
  const s = seen(), id = pageId();
  if (new URLSearchParams(location.search).has('tour')) { setTimeout(startSiteTour, 600); return; }
  // first visit to the site: offer the tour; later, the first visit to each page gets its two lines
  setTimeout(() => {
    if (!s.site) { mark('site'); show({ key: 'site', title: 'New here?', text: 'This site plans, observes, reduces and fits exoplanet observations in your browser. A one-minute tour shows where everything is.', first: '', buttons: [{ label: 'Take the tour', primary: true, run: startSiteTour }, { label: 'Not now' }] }); mark('page:' + id); return; }
    showIntro(id, false);
  }, 900);
}
function showIntro(id, force) {
  const P = PAGE_INTROS[id]; if (!P) return;
  if (!force && seen()['page:' + id]) return;
  show({ key: 'page:' + id, title: P.title, text: P.text, first: P.first, buttons: [{ label: 'Got it', primary: true }, { label: 'Tour of the site', run: startSiteTour }] });
  mark('page:' + id);   // shown once: it does not come back on the next visit even if left open
}
