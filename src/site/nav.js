// Site-wide navigation bar, shared by every page.
//
// A page declares where the site root is, relative to itself, with
//   <meta name="esl-root" content="../">
// and has <header id="sitebar" data-active="plan"></header>; mountNav() fills it in.
// Paths are real folders (plan/, observe/, analyze/, analyze/photometry/, search/, methods/), each with its own
// index.html, so the site works from any static host with no rewrite rules.

import { mountTips } from './tips.js';

export const TAGLINE = 'scientific modeling and uncertainty quantification in your browser';

export const SECTIONS = [
  { id: 'plan', label: 'Plan', href: 'plan/', blurb: 'Which transits can you see tonight, from where you are, and for how long.', hint: 'Transits you can see from your site' },
  { id: 'observe', label: 'Observe', href: 'observe/', blurb: 'A view of your sky from where you are, at any time.', hint: 'Your sky, now or at any time' },
  { id: 'analyze', label: 'Analyze', href: 'analyze/', blurb: 'Light curves from images, spectra over time, and fits of transits, radial velocities and timing.', hint: 'Fit light curves, RVs and timing' },
  { id: 'search', label: 'Search', href: 'search/', blurb: 'Browse known planets and candidates, with where every number comes from.', hint: 'Known planets and candidates' },
  { id: 'methods', label: 'Methods', href: 'methods/', blurb: 'Methods, validation and references: the equations and limits, how the models compare with other codes and published results, and what to cite.', hint: 'Equations, validation, how to cite' },
  { id: 'docs', label: 'Docs', href: 'docs/', blurb: 'Guides, Python labs, and the API references for the browser, the Python package and the MCP server.', hint: 'Guides, labs and APIs' },
];

/** The site root as a URL, from the page's esl-root meta tag (the page's own folder when absent). */
export function siteRoot() {
  const m = document.querySelector('meta[name=esl-root]');
  return new URL((m && m.content) || './', document.baseURI);
}

/** Fill a header element with the brand, the tagline and the section links. `active` defaults to data-active. */
export function mountNav(el, active) {
  if (!el) return;
  const root = siteRoot(), cur = active || el.dataset.active || '';
  el.classList.add('sitebar');
  el.innerHTML = '';
  const a = (href, cls, html, title) => { const x = document.createElement('a'); x.href = new URL(href, root).href; x.className = cls; x.innerHTML = html; if (title) x.title = title; return x; };
  el.append(a('./', 'sitebrand', '<span class="brand-mark"></span><b><span class="full">Exoplanet Science Lab</span><span class="short" aria-hidden="true">ESL</span></b>', 'Exoplanet Science Lab: home'));
  const tag = document.createElement('span'); tag.className = 'sitetag'; tag.textContent = TAGLINE; el.append(tag);
  const nav = document.createElement('nav'); nav.setAttribute('aria-label', 'Sections');
  // the one-line hint shows only in the folded menu (a phone), where there is no hover to read the title
  for (const s of SECTIONS) { const x = a(s.href, 'sitelink' + (s.id === cur ? ' on' : ''), `<span class="sl-name">${s.label}</span><small class="sl-hint">${s.hint}</small>`, s.blurb); if (s.id === cur) x.setAttribute('aria-current', 'page'); nav.append(x); }
  // the menu button stands in for the row of links when they do not fit (see fitNav)
  const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'sitemenu'; menu.innerHTML = '<i aria-hidden="true"></i>';
  nav.id = 'sitenav'; menu.setAttribute('aria-label', 'Sections menu'); menu.setAttribute('aria-controls', 'sitenav'); menu.setAttribute('aria-expanded', 'false');
  el.append(menu, nav);
  compactNav(el, menu, nav);
}

/**
 * Keep the bar on one row whatever the width and the number of sections: when the links do not fit beside the brand
 * (or the window is phone-sized) the bar gets the class `compact`, which turns the links into a menu under a button.
 */
function compactNav(el, menu, nav) {
  const phone = typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : { matches: false };
  const open = (on) => { el.classList.toggle('open', on); menu.setAttribute('aria-expanded', String(on)); };
  const fit = () => {
    const was = el.classList.contains('open');
    el.classList.remove('compact', 'open');                                  // measure the row as it would be
    const compact = phone.matches || nav.scrollWidth > nav.clientWidth + 1;
    el.classList.toggle('compact', compact);
    open(compact && was);
  };
  menu.addEventListener('click', () => open(!el.classList.contains('open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.classList.contains('open')) { open(false); menu.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (el.classList.contains('open') && !menu.contains(e.target) && !nav.contains(e.target)) open(false); });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) open(false); });
  let raf = 0; window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  fit();
}

/**
 * The assistant's bubble, bottom right of every page. Only this button is part of the page: the assistant itself
 * (src/assistant/main.js) is fetched the first time the bubble is pressed, or at once when a conversation is
 * waiting to continue on this page (the assistant changed page mid-request) or its panel was left open.
 */
export function mountAssistant() {
  if (document.getElementById('esl-ai-launch') || new URLSearchParams(location.search).has('noassistant')) return;
  const b = document.createElement('button');
  b.id = 'esl-ai-launch'; b.type = 'button'; b.title = 'Assistant: ask it to set this page up or run an experiment';
  b.setAttribute('aria-label', 'Open the assistant'); b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false');
  const small = matchMedia('(max-width: 560px)').matches;   // on a phone: smaller and nearer the corner, so it covers less of the page
  b.style.cssText = `position:fixed;right:${small ? 8 : 16}px;bottom:${small ? 8 : 16}px;z-index:70;width:${small ? 40 : 44}px;height:${small ? 40 : 44}px;border-radius:50%;border:1px solid #5fd4ff88;background:#0b1422e6;color:#e9f8ff;cursor:pointer;display:grid;place-items:center;box-shadow:0 4px 18px #000a;padding:0`;
  b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M8 10h8M8 13h5"/></svg>';
  let mod = null;
  const open = async (auto) => {
    try { mod = mod || await import('../assistant/main.js'); mod.mountPanel({ root: siteRoot(), launcher: b, auto }); }
    catch (err) { b.title = 'The assistant could not be loaded: ' + ((err && err.message) || err); console.error(err); }
  };
  b.addEventListener('click', () => open(false));
  document.body.append(b);
  try { const c = JSON.parse(localStorage.getItem('esl.assistant.chat.v1') || 'null'); if (c && ((c.pending && Date.now() - c.pending.at < 180000) || c.open)) open(true); } catch { /* storage unavailable: the bubble still works */ }
}

// pages that only need the bar can load this module directly
if (typeof document !== 'undefined') {
  const boot = () => { const el = document.getElementById('sitebar'); if (el && !el.classList.contains('sitebar')) mountNav(el); mountTips(); mountAssistant(); import('./project.js').then((m) => m.mountProject()).catch((err) => console.warn('project checklist unavailable:', err)); import('./welcome.js').then((m) => m.mountWelcome()).catch((err) => console.warn('welcome card unavailable:', err)); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
