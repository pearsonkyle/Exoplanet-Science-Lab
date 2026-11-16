// The site theme: Dark (the default), Light, Dusk (blue-grey) and Night (red and amber, for the telescope).
//
// The theme is the data-theme attribute on <html> (no attribute = Dark). Each page's <head> carries a one-line
// classic script that reads localStorage before the stylesheets apply, so a page never paints in the wrong theme:
//   <script>try{var t=localStorage.getItem('esl.theme');if(t&&t!=='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
// The colours themselves are CSS custom properties in src/site/site.css. setTheme() changes the attribute, stores
// the choice, and tells the page with an 'esl-theme' event on window (detail: { theme }) followed by a 'resize'
// event, so pages that already redraw their canvases on resize follow without code of their own.
// The operating system's light/dark preference is not followed: Dark stays the default on a first visit.
//
// Canvas plots read their screen colours through tokens(): the CSS variables of the current theme as '#rrggbb'.

export const THEMES = [
  { id: 'dark', label: 'Dark', hint: 'The default: light text on near-black' },
  { id: 'light', label: 'Light', hint: 'Dark text on white, for daylight and print' },
  { id: 'dusk', label: 'Dusk', hint: 'Softer blue-grey, lower contrast' },
  { id: 'night', label: 'Night (red)', hint: 'Red and amber with almost no blue: keeps your eyes dark-adapted at the telescope' },
];
export const KEY = 'esl.theme';
const IDS = new Set(THEMES.map((t) => t.id));
const hasDoc = typeof document !== 'undefined';

/** The current theme id ('dark' outside a browser). */
export function getTheme() {
  if (!hasDoc) return 'dark';
  const t = document.documentElement.dataset.theme;
  return IDS.has(t) ? t : 'dark';
}

/** Switch theme, remember it, and announce it ('esl-theme', then 'resize'). */
export function setTheme(id) {
  if (!IDS.has(id) || !hasDoc) return;
  const root = document.documentElement;
  if (id === 'dark') delete root.dataset.theme; else root.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* private mode: the choice lasts this page only */ }
  cache = null;
  window.dispatchEvent(new CustomEvent('esl-theme', { detail: { theme: id } }));
  window.dispatchEvent(new Event('resize'));
}

/** Apply the stored theme (the inline head script does this first; this covers a page without it). */
export function applyStoredTheme() {
  if (!hasDoc) return;
  let t = null; try { t = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
  if (t && IDS.has(t) && t !== getTheme()) { if (t === 'dark') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }
}

// other tabs: follow a theme chosen in another window of the site
if (hasDoc) window.addEventListener('storage', (e) => { if (e.key === KEY && e.newValue && IDS.has(e.newValue) && e.newValue !== getTheme()) setTheme(e.newValue); });

const DARK_TOKENS = { bg: '#05070c', panel: '#0b0f18', panel2: '#111726', line: '#1e2638', line2: '#2b3550', text: '#dfe6f3', dim: '#8491ad', faint: '#55607a', star: '#ffc56b', model: '#5fd4ff', data: '#c9d3e6', ok: '#6fe3a5', warn: '#ffb454', bad: '#ff6b7a', post: '#b48cff', strong: '#ffffff', pink: '#f39bd6', moon: '#ffd27a' };
let cache = null;
/** The colour tokens of the current theme ({ theme, bg, panel, ..., light }), read from the CSS variables. */
export function tokens() {
  const theme = getTheme();
  if (cache && cache.theme === theme) return cache;
  const out = { ...DARK_TOKENS };
  if (hasDoc && theme !== 'dark') {
    const cs = getComputedStyle(document.documentElement);
    for (const k of Object.keys(out)) { const v = cs.getPropertyValue('--' + k).trim(); if (/^#[0-9a-f]{3,8}$/i.test(v)) out[k] = v.length === 4 ? '#' + [...v.slice(1)].map((c) => c + c).join('') : v.slice(0, 7); }
  }
  out.theme = theme; out.light = theme === 'light';
  cache = out; return out;
}
/** '#rrggbb' at opacity a, as rgba(). */
export const alpha = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')},${a})`;
/** Mix two '#rrggbb' colours (f = share of b). */
export const mix = (a, b, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - f) + parseInt(b.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('');

/** Series colours for groups (epochs, instruments) in the current theme. */
export function groupPalette(t = tokens()) {
  if (t.theme === 'night') return ['#ff7a52', '#ffb347', '#e0927a', '#ff5a5a', '#d9a03f', '#f0c090', '#c05a3a', '#ffd0a0', '#a04030'];
  if (t.theme === 'dusk') return ['#86c8e6', '#ecc285', '#93d6b0', '#f2a0b0', '#bfaaf0', '#efe9c0', '#8fd9d0', '#f0aa78', '#a9bcf2', '#d0d6e2'];
  return null;   // dark and light: the plotting module's own cycles
}
