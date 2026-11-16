// The tabs of the Methods page: Methods, Validation, Reproducibility, References, How to cite. Each tab is a
// <div class="mpanel" data-tab="..."> holding sections; one is shown at a time. The address's anchor chooses the tab:
// any id on the page opens the tab that contains it (so #transit, #val-sampler, #ref-agol2020, #cite all work), and
// an anchor that is not on the page is tried with and without the "val-" prefix of the validation part
// (src/validation/anchors.js), which keeps old addresses of the Validation page working.

const panels = () => [...document.querySelectorAll('.mpanel')];
const tabLinks = () => [...document.querySelectorAll('.mtabs a')];

/** The element an anchor names, with the fallbacks described above, or null. */
export function target(id) {
  id = String(id || '').replace(/^#/, '');
  if (!id) return null;
  const t = document.getElementById(id) || document.getElementById('val-' + id);
  if (t || !id.startsWith('val-')) return t;
  // #val-x with no such element: the validation part may still be loading (its topic cards and collapsed blocks are
  // built after the stored references arrive), so fall back to #x only once it is complete; src/validation/main.js
  // calls reveal() again then
  return document.documentElement.dataset.validation === 'ready' ? document.getElementById(id.slice(4)) : null;
}

/** Show one tab (by its data-tab name). */
export function showTab(name) {
  const ps = panels(); if (!ps.some((p) => p.dataset.tab === name)) name = ps[0] && ps[0].dataset.tab;
  for (const p of ps) p.hidden = p.dataset.tab !== name;
  for (const a of tabLinks()) { const on = a.dataset.tab === name; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
  document.documentElement.dataset.tab = name;
  return name;
}

/**
 * Go to an anchor: its tab shown, the collapsed blocks around it opened, scrolled into view. An anchor that names a
 * tab itself (#methods, #validation) shows the tab from its top. Returns the tab shown.
 */
export function reveal(id, { scroll = true } = {}) {
  const raw = String(id || '').replace(/^#/, ''), t = target(raw);
  const panel = t && (t.classList.contains('mpanel') ? t : t.closest('.mpanel'));
  // an anchor of the validation part that is not built yet (its collapsed blocks are made on first opening) still opens that tab
  const name = showTab(panel ? panel.dataset.tab : raw.startsWith('val-') ? 'validation' : '');
  if (!t) return name;
  if (t.id !== raw && history.replaceState) history.replaceState(null, '', '#' + t.id);
  for (let d = t.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
  if (t.tagName === 'DETAILS') t.open = true;
  if (!scroll) return name;
  requestAnimationFrame(() => {
    if (!t.classList.contains('mpanel')) { t.scrollIntoView({ block: 'start' }); return; }
    // a whole tab: from its top, but the page header stays in view when the visitor has not scrolled past it
    const row = document.getElementById('mtabs');
    if (row && row.getBoundingClientRect().top < 0) row.scrollIntoView({ block: 'start' }); else window.scrollTo({ top: 0 });
  });
  return name;
}

/** Wire the tab row and the address. Call once the panels exist. */
export function initTabs() {
  const go = () => reveal(decodeURIComponent(location.hash.slice(1)));
  window.addEventListener('hashchange', go);
  const row = document.getElementById('mtabs');
  // a click on a tab changes the address without the browser's jump to the panel, so the page header stays in view
  // while the visitor has not scrolled past the tab row
  row.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    const above = row.getBoundingClientRect().top >= 0;
    if (location.hash !== a.hash) history.pushState(null, '', a.hash);
    showTab(a.dataset.tab);
    if (!above) row.scrollIntoView({ block: 'start' });
  });
  // arrow keys move between tabs, as in any tab row
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ls = tabLinks(), i = ls.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); ls[(i + (e.key === 'ArrowRight' ? 1 : ls.length - 1)) % ls.length].focus();
  });
  if (location.hash) go(); else showTab('methods');
}
