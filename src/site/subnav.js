// The second row under the site bar on the Analyze pages: the analyzer ("Processed Data": light curves, velocities, times), photometry
// (images to a light curve), spectroscopy (spectra over time to a spectrum) and atmosphere (a forward model of the spectrum). A page has
//   <nav id="subnav" class="subnav" data-active="fits|photometry|spectroscopy|atmosphere|star"></nav>
// right after its site bar, and loads this module. The row's height is part of --sitebar-h on those pages
// (src/site/site.css), so the analyzer's fixed-viewport grid, which sizes its first row from that variable, keeps fitting.

import { siteRoot } from './nav.js';

export const ANALYZE_PAGES = [
  { id: 'fits', label: 'Processed Data', href: 'analyze/', title: 'Needs processed data: light curves (time, flux), radial velocities or mid-transit times. Model and fit transits, velocities and timing.' },
  { id: 'photometry', label: 'Photometry', href: 'analyze/photometry/', title: 'Needs images (FITS frames) or TESS/Kepler target pixel files. Turns them into a light curve.' },
  { id: 'spectroscopy', label: 'Spectroscopy', href: 'analyze/spectroscopy/', title: 'Needs extracted 1-D spectra over time (e.g. JWST x1dints). Turns them into a transmission or emission spectrum.' },
  { id: 'atmosphere', label: 'Atmosphere', href: 'analyze/atmosphere/', title: 'Needs nothing: a forward model of the atmosphere. Temperature profile and composition to a transmission and an emission spectrum.' },
  { id: 'star', label: 'Star', href: 'analyze/star/', title: 'Needs magnitudes from catalogues: the star\'s temperature, angular diameter, radius and luminosity from its spectral energy distribution.' },
];

/** Fill the subnav element. `active` defaults to its data-active. */
export function mountSubnav(el, active) {
  if (!el) return;
  const root = siteRoot(), cur = active || el.dataset.active || '';
  el.classList.add('subnav');
  el.setAttribute('aria-label', 'Analyze');
  el.innerHTML = '';
  for (const p of ANALYZE_PAGES) {
    const a = document.createElement('a');
    a.href = new URL(p.href, root).href;
    a.className = 'subnavlink' + (p.id === cur ? ' on' : '');
    a.title = p.title;
    a.textContent = p.label;
    if (p.id === cur) a.setAttribute('aria-current', 'page');
    el.append(a);
  }
  document.documentElement.classList.add('has-subnav');
}

if (typeof document !== 'undefined') {
  const boot = () => mountSubnav(document.getElementById('subnav'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
