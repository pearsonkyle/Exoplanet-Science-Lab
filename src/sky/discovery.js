// How the planets of a host star were found, in five groups, and a sixth for the TESS candidates, with a colour and
// a label for each: the legend and the filter of the Observe page (and the method filter of the planner). No DOM:
// test/discovery.test.mjs runs it in Node.
//
// The archive's discoverymethod strings (NASA Exoplanet Archive, column discoverymethod) are put in five groups:
//   t  Transit                 'Transit'
//   r  Radial velocity         'Radial Velocity'
//   i  Imaging                 'Imaging'
//   m  Microlensing            'Microlensing'
//   o  Other                   everything else: Transit Timing Variations, Eclipse Timing Variations, Pulsar Timing,
//                              Pulsation Timing Variations, Astrometry, Orbital Brightness Modulation, Disk Kinematics
//   c  TOI candidate           a TESS Object of Interest that is not (yet) a planet: TFOPWG disposition PC or APC
//                              (CP and KP are confirmed planets, in the archive's list; FP and FA are not planets)
// A host's groups (in public/sky/hosts.json, written by tools/build_sky_data.py with the same rule) are its planets'
// groups, the one that found most of its planets first; on a tie, the one that found the earliest planet; the
// candidates (c) always come after the confirmed planets' groups.
//
// Colours: the Okabe & Ito (2008) palette for colour-vision deficiencies, the members that stand out on a dark sky
// (sky blue, orange, reddish purple, bluish green, yellow), and white for the candidates, whose ring is also dashed
// (src/sky/renderer.js) so that colour is not the only cue; contrast and simulated-CVD separations are in the test.
//
// Shapes: each group also has its own marker on the sky (renderer.js draws them, shapeSvg() the same for the page's
// controls), so that a red-only view (the Night theme) or a colour-blind eye still tells them apart: transit a ring
// crossed by a bar (a planet in front of its star), radial velocity a plain ring, imaging a square, microlensing a
// diamond, other a triangle, a TESS candidate a dashed ring.

export const GROUPS = [
  { id: 't', key: 'transit', shape: 'transit', label: 'Transit', short: 'T', color: '#56B4E9', note: 'the planet passes in front of its star' },
  { id: 'r', key: 'rv', shape: 'ring', label: 'Radial velocity', short: 'RV', color: '#E69F00', note: 'the star moves back and forth' },
  { id: 'i', key: 'imaging', shape: 'square', label: 'Imaging', short: 'I', color: '#CC79A7', note: 'the planet seen directly' },
  { id: 'm', key: 'microlensing', shape: 'diamond', label: 'Microlensing', short: 'M', color: '#009E73', note: 'the star bends the light of a star behind it' },
  { id: 'o', key: 'other', shape: 'triangle', label: 'Other', short: 'O', color: '#F0E442', note: 'transit or eclipse timing, pulsar timing, astrometry, brightness modulation, disk kinematics' },
  { id: 'c', key: 'toi', shape: 'dashed', label: 'TOI candidate', short: 'TOI', color: '#FFFFFF', note: 'a TESS candidate, not yet confirmed (TFOPWG PC or APC); dashed ring', candidate: true },
];
export const GROUP_IDS = GROUPS.map((g) => g.id).join('');
const BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
export const MIXED_NOTE = 'A star whose planets were found in several ways takes the colour of the way that found most of them (on a tie, the earliest). It stays on the sky while any of its ways is switched on, then in the colour of the first of those.';

/** An archive discoverymethod string (or a short name) -> 't' | 'r' | 'i' | 'm' | 'o', or '' when empty ('c' is never a method). */
export function groupOf(method) {
  const s = String(method ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!s) return '';
  if (s === 'transit' || s === 'transits' || s === 'primary transit') return 't';
  if (s === 'radial velocity' || s === 'radial velocities' || s === 'rv' || s === 'doppler') return 'r';
  if (s === 'imaging' || s === 'direct imaging') return 'i';
  if (s === 'microlensing' || s === 'gravitational microlensing') return 'm';
  return 'o';
}
/** The marker of each shape in the point shader of renderer.js (uStyle 1, aShape). */
export const SHAPE_CODE = { ring: 0, transit: 1, square: 2, diamond: 3, triangle: 4, dashed: 5 };
/** The shader code of a group id. */
export const shapeCode = (id) => SHAPE_CODE[(BY_ID[id] || BY_ID.o).shape];
/**
 * The marker of a group as inline SVG (the swatches of the Filter panel and the list rows): the same shape as on the
 * sky, in currentColor unless a colour is given, with the group's letter beside it only when `letter` is true.
 */
export function shapeSvg(id, { size = 18, color = 'currentColor', stroke = 2 } = {}) {
  const g = BY_ID[id] || BY_ID.o, c = 12, r = 7.2, a = `fill="none" stroke="${color}" stroke-width="${stroke * 24 / size}" stroke-linejoin="round"`;
  const body = {
    ring: `<circle cx="${c}" cy="${c}" r="${r}" ${a}/>`,
    transit: `<circle cx="${c}" cy="${c}" r="${r}" ${a}/><path d="M2.2 ${c}h19.6" ${a}/>`,
    square: `<rect x="${c - 6.4}" y="${c - 6.4}" width="12.8" height="12.8" ${a}/>`,
    diamond: `<path d="M${c} ${c - 8.6}L${c + 8.6} ${c}L${c} ${c + 8.6}L${c - 8.6} ${c}Z" ${a}/>`,
    triangle: `<path d="M${c} ${c - 8.2}L${c + 7.6} ${c + 5.6}H${c - 7.6}Z" ${a}/>`,
    dashed: `<circle cx="${c}" cy="${c}" r="${r}" ${a} stroke-dasharray="3.6 2.05"/>`,
  }[g.shape];
  return `<svg class="shape" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}
/** The group record ({ id, label, color, ... }) of a group id or an archive string. Unknown -> Other. */
export const groupInfo = (idOrMethod) => BY_ID[idOrMethod] || BY_ID[groupOf(idOrMethod)] || BY_ID.o;
/** The colour (#rrggbb) of a group id or an archive string. */
export const colorOf = (idOrMethod) => groupInfo(idOrMethod).color;
/** '#rrggbb' -> [r, g, b] in 0..1 (sRGB, as the point shader takes it). */
export const rgb01 = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);

/** The group of one planet: 'c' for a TESS candidate (candidate: true), else the group of its discovery method. */
export const planetGroup = (p) => (p && p.candidate ? 'c' : groupOf(p && p.method));
/** Is a TOI record a candidate (TFOPWG PC, APC or no disposition), not a known planet or a false positive? status: as sources/toi.js writes it. */
export const isCandidateStatus = (status) => /^Candidate/.test(String(status || ''));
/**
 * A host's groups from its planets: [{ method, year, candidate }] -> 'tr' (most planets first; a tie: the earliest
 * planet; then the order of GROUPS; candidates last). Planets without a method are left out.
 */
export function hostGroups(planets) {
  const n = {}, first = {};
  for (const p of planets || []) { const g = planetGroup(p); if (!g) continue; n[g] = (n[g] || 0) + 1; const y = Number.isFinite(p.year) ? p.year : 9999; first[g] = Math.min(first[g] ?? 9999, y); }
  return Object.keys(n).sort((a, b) => (a === 'c') - (b === 'c') || n[b] - n[a] || first[a] - first[b] || GROUP_IDS.indexOf(a) - GROUP_IDS.indexOf(b)).join('');
}

/** The filter: a string of the group ids that are shown ('trimoc' = all). Anything else -> all. */
export function parseFilter(v) {
  if (Array.isArray(v)) v = v.map((x) => (BY_ID[x] ? x : (GROUPS.find((g) => g.key === String(x).toLowerCase() || g.label.toLowerCase() === String(x).toLowerCase() || (g.id === 'c' && /^(tois?|candidates?|tess)$/i.test(String(x).trim()))) || {}).id || groupOf(x))).join('');
  if (typeof v !== 'string') return GROUP_IDS;
  return GROUP_IDS.split('').filter((g) => v.includes(g)).join('');
}
/** A filter as stored before the candidates existed: 'trimo' was everything, so it is everything now. */
export const migrateFilter = (v) => (v === 'trimo' ? GROUP_IDS : v);
/** Is a host (its groups string) shown under a filter? Any of its groups on; a host without groups counts as Other. */
export const hostShown = (groups, filter) => shownGroup(groups, filter) !== null;
/** Is one planet shown under a filter (the Tonight list, the planner)? p: { method, candidate }. */
export const planetShown = (p, filter) => filter.includes(planetGroup(p) || 'o');
/**
 * Which group a host is drawn in under a filter: the first of its groups that is shown, or null (hidden). A host
 * with no known group counts as Other.
 */
export function shownGroup(groups, filter) {
  const gs = groups || 'o';
  for (const g of gs) if (filter.includes(g)) return g;
  return null;
}

/** WCAG 2 contrast ratio of two '#rrggbb' colours. */
export function contrast(a, b) {
  const L = (hex) => { const [r, g, b2] = rgb01(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b2; };
  const la = L(a), lb = L(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** SIMBAD (the CfA mirror) page of an object, by identifier. */
export const simbadUrl = (name) => 'https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=' + encodeURIComponent(String(name).trim());
