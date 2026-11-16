// Site-wide navigation bar, shared by every page.
//
// A page declares where the site root is, relative to itself, with
//   <meta name="esl-root" content="../">
// and has <header id="sitebar" data-active="plan"></header>; mountNav() fills it in.
// Paths are real folders (plan/, observe/, analyze/, search/, validation/), each with its own
// index.html, so the site works from any static host with no rewrite rules.

export const TAGLINE = 'scientific modeling and uncertainty quantification in your browser';

export const SECTIONS = [
  { id: 'plan', label: 'Plan', href: 'plan/', blurb: 'Which transits can you see tonight, from where you are, and for how long.' },
  { id: 'observe', label: 'Observe', href: 'observe/', blurb: 'A view of your sky, and photometry from images.' },
  { id: 'analyze', label: 'Analyze', href: 'analyze/', blurb: 'Model and fit transits, radial velocities and timing.' },
  { id: 'search', label: 'Search', href: 'search/', blurb: 'Browse known planets and candidates, with where every number comes from.' },
  { id: 'validation', label: 'Validation', href: 'validation/', blurb: 'How these models compare with other codes and published results.' },
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
  for (const s of SECTIONS) { const x = a(s.href, 'sitelink' + (s.id === cur ? ' on' : ''), s.label, s.blurb); if (s.id === cur) x.setAttribute('aria-current', 'page'); nav.append(x); }
  el.append(nav);
}

// pages that only need the bar can load this module directly
if (typeof document !== 'undefined') {
  const boot = () => { const el = document.getElementById('sitebar'); if (el && !el.classList.contains('sitebar')) mountNav(el); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
