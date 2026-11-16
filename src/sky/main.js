// The Observe page: a view of the sky from a place at a time. State lives in S; compute() turns it into what the
// renderer and the labels need for one frame. The astronomy is in src/core/astro.js (tested against astropy).
import * as A from '../core/astro.js';
import { siteRoot } from '../site/nav.js';
import { createSkyRenderer, bvToRgb } from './renderer.js';
import { createAR, viewCentre } from './ar.js';
import { createXR } from './xr.js';
import * as X from './xrInput.js';
import { nightWindow, sampleNight, drawNightBar, hhmm, hhmmUtc } from './night.js';
import { horizonAt } from '../core/horizon.js';
import * as O from '../core/observability.js';
import * as DM from './discovery.js';
import * as VIS from './visible.js';
import { eventKind, eventInfo } from './events.js';

const { RAD, DEG } = A;
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

const ICON = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const LAYERS = [
  ['constellations', 'Constellations', 'Constellation lines and names', '<path d="M4 17l5-9 6 5 5-8"/><circle cx="4" cy="17" r="1.3" fill="currentColor"/><circle cx="9" cy="8" r="1.3" fill="currentColor"/><circle cx="15" cy="13" r="1.3" fill="currentColor"/><circle cx="20" cy="5" r="1.3" fill="currentColor"/>'],
  ['planets', 'Solar system', 'Sun, Moon and planets', '<circle cx="12" cy="12" r="4.6"/><ellipse cx="12" cy="12" rx="10" ry="3" transform="rotate(-20 12 12)"/>'],
  ['atmosphere', 'Atmosphere', 'Daylight, twilight, refraction and extinction', '<path d="M3 18h18"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 9V6M5.8 12.2L3.7 10.1M18.2 12.2l2.1-2.1"/>'],
  ['ground', 'Ground', 'Ground below the horizon', '<path d="M2 18h20"/><path d="M5 21h14"/>'],
  ['terrain', 'Terrain', 'Hills and mountains on the horizon, from elevation data downloaded for your location (about 40 tiles, once per place). Buildings and trees are not in the data.', '<path d="M2 18l6-8 4 5 3-3 7 6z"/>'],
  ['azgrid', 'Azimuthal', 'Altitude and azimuth grid', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v18M3 12h18"/>'],
  ['eqgrid', 'Equatorial', 'Right ascension and declination grid', '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="3.6" ry="9"/>'],
  ['satellites', 'Satellites', 'Bright satellites, from CelesTrak elements', '<rect x="9.6" y="9.6" width="4.8" height="4.8" transform="rotate(45 12 12)"/><path d="M8.2 8.2L4 4M15.8 15.8L20 20M3 7l4-4M17 21l4-4"/>'],
  ['hosts', 'Exoplanets', 'Stars with known planets', '<circle cx="9.5" cy="13" r="5"/><circle cx="19" cy="7" r="2"/>'],
  ['labels', 'Names', 'Names of stars, planets, constellations and satellites', '<path d="M5 18L10 6l5 12M7 14h6"/><path d="M18 9v9M16 11.5h4"/>'],
  ['altlimit', '30° limit', 'A ring at 30 degrees altitude: below it most telescopes look through too much air', '<path d="M3 19h18"/><path d="M5 19a7 7 0 0 1 14 0" stroke-dasharray="2.5 2.5"/><path d="M12 19l6-3.5"/>'],
];
const DEFAULT_LAYERS = { constellations: true, planets: true, atmosphere: true, ground: true, terrain: false, azgrid: false, eqgrid: false, satellites: false, hosts: false, labels: true, altlimit: false };
const PLANET_COLOR = { mercury: [0.86, 0.82, 0.76], venus: [1, 0.98, 0.9], mars: [1, 0.62, 0.42], jupiter: [1, 0.93, 0.8], saturn: [0.98, 0.88, 0.66], uranus: [0.7, 0.93, 0.95], neptune: [0.62, 0.74, 1] };
const CALIB_STARS = { Polaris: [37.95456067, 89.26410897], "Orion's belt": [84.05338894, -1.20191914] };
const ENU_TO_WORLD = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const dirOf = (alt, az) => [Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)];
const altAzOf = (w) => ({ alt: Math.asin(clamp(w[1], -1, 1)), az: A.wrap2pi(Math.atan2(w[0], -w[2])) });

// ---------------------------------------------------------------- state
const q = new URLSearchParams(location.search);
const num = (k) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : null);
const savedLoc = store.get('esl.sky.location', null);
const S = {
  lat: num('lat') ?? savedLoc?.lat ?? 51.4769, lon: num('lon') ?? savedLoc?.lon ?? 0, elev: num('elev') ?? 0, hasLocation: num('lat') != null || !!savedLoc,
  time: Date.now(), playing: true, rate: 1, live: true, step: 3600e3,
  az: num('az') ?? 180, alt: num('alt') ?? 24, fov: num('fov') ?? 100,
  layers: { ...DEFAULT_LAYERS, ...store.get('esl.sky.layers', {}) },
  selection: null, ar: false,
  hover: null,          // the host under the mouse: its card is shown in place of the selection's
  target: null,         // the object that stays marked: { kind, i | id, name, planet }
  transit: null,        // a window of the target: { ingress, mid, egress (Unix ms), err (minutes, 1 sigma), kind: transit | eclipse | phase | custom (events.js) }
  nightPlay: false,     // "Play the night" is running (or paused inside its span)
  follow: false,        // while it runs: the view follows the target (when its whole track does not fit the screen)
  magOffset: 0,         // added to the limiting magnitude: the thumbstick of a controller, [ and ], the slider of the Tonight panel
  xrdebug: +q.get('xrdebug') || 0,
  disc: DM.parseFilter(DM.migrateFilter(store.get('esl.sky.disc', DM.GROUP_IDS))),     // the discovery groups whose host stars are shown (src/sky/discovery.js)
  eye: clamp(num('eye') ?? store.get('esl.sky.eye', 2), 0, 500),     // the observer's eye above the ground, metres (the terrain horizon)
  vis: { when: 'either', sort: 'alt', magMax: null, minPlanets: 0, minAlt: 0, ...store.get('esl.sky.vis', {}) },     // the Visible panel's settings
  legendOpen: store.get('esl.sky.legend', null),     // the legend unfolded (null: unfolded on a wide screen, folded on a phone)
};
// URL contract with the planner: planet, t, lat, lon, elev, transit=<ingress>,<mid>,<egress> (ISO UTC), err=<minutes>,
// event=eclipse|phase|custom (the kind of window; a transit when absent)
{
  const tr = (q.get('transit') || '').split(',').map((x) => Date.parse(x.trim()));
  if (tr.length === 3 && tr.every(Number.isFinite) && tr[0] <= tr[1] && tr[1] <= tr[2]) S.transit = { ingress: tr[0], mid: tr[1], egress: tr[2], err: num('err') != null && num('err') >= 0 ? num('err') : null, kind: eventKind(q.get('event')) };
}
if (q.has('t') && Number.isFinite(Date.parse(q.get('t')))) { S.time = Date.parse(q.get('t')); S.live = false; S.playing = false; }
else if (S.transit && q.has('planet')) { S.time = S.transit.mid; S.live = false; S.playing = false; }
if (q.has('layers')) { for (const k of Object.keys(S.layers)) S.layers[k] = false; for (const k of q.get('layers').split(',')) if (k in S.layers) S.layers[k] = true; }
if (S.lat < 0 && num('az') == null) S.az = 0;       // face the equator-side sky by default

const gl = $('gl'), labels = $('labels'), ctx = labels.getContext('2d'), wrap = $('sky');
let R;
try { R = createSkyRenderer(gl); } catch (e) { $('status').textContent = 'WebGL is not available in this browser, so the sky cannot be drawn.'; $('status').hidden = false; throw e; }
const data = { stars: null, names: {}, con: null, hosts: null, hostGeom: null, hostLimit: null, hostIndex: null, sats: null, satApi: null, satNote: '',
  T: null, cat: null,                       // targets.js and its catalogue, loaded on demand
  horizon: null, horizonKey: '', horizonLoading: '',      // the terrain profile of the place
  night: null };                            // the span "Play the night" runs through, with the target's track
if (S.xrdebug) { R.setMode('perspective'); if (S.xrdebug === 1) labels.style.display = 'none'; }
let F = null;     // the last computed frame

// ---------------------------------------------------------------- data
const dataUrl = (name) => new URL('sky/' + name, siteRoot()).href;
async function loadStars() {
  const buf = await (await fetch(dataUrl('stars.bin'))).arrayBuffer(), dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x45534c53) throw new Error('stars.bin: not a star file');
  const hlen = dv.getUint32(4, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen))), n = head.count, off = 8 + hlen;
  const s = { n, head, pos: new Float32Array(n * 3), mag: new Float32Array(n), color: new Float32Array(n * 3), bv: new Float32Array(n), hip: new Uint32Array(n), ra: new Float32Array(n), dec: new Float32Array(n) };
  for (let i = 0, o = off; i < n; i++, o += 16) {
    const ra = dv.getFloat32(o, true), dec = dv.getFloat32(o + 4, true), bv = dv.getInt16(o + 10, true);
    s.ra[i] = ra; s.dec[i] = dec; s.mag[i] = dv.getInt16(o + 8, true) / 100; s.bv[i] = bv === 32767 ? NaN : bv / 1000; s.hip[i] = dv.getUint32(o + 12, true);
    s.pos.set(A.sphToVec(ra * RAD, dec * RAD), i * 3); s.color.set(bvToRgb(s.bv[i]), i * 3);
  }
  data.stars = s; R.setStars(s);
}
async function loadNames() {
  const j = await (await fetch(dataUrl('starnames.json'))).json(); data.names = j.names;
  // stars that can be labelled: proper names first, then Bayer/Flamsteed designations, among the brightest 3000
  const s = data.stars; s.labelled = [];
  for (let i = 0; i < Math.min(s.n, 3000); i++) { const nm = j.names[s.hip[i]]; if (nm) { const [proper, des] = nm.split('|'); s.labelled.push({ i, proper, des }); } }
}
async function loadConstellations() { const j = await (await fetch(dataUrl('constellations.json'))).json(); data.con = j; R.setConstellations(j.lines); data.con.labelVec = j.labels.map((l) => A.sphToVec(l[2] * RAD, l[3] * RAD)); }
let hostsPromise = null;
function loadHosts() {
  return hostsPromise ||= (async () => {
    setStatus('Loading host stars…');
    try {
      const j = await (await fetch(dataUrl('hosts.json'))).json(), n = j.hosts.length, pos = new Float32Array(n * 3), mag = new Float32Array(n);
      j.hosts.forEach((h, i) => { pos.set(A.sphToVec(h[1] * RAD, h[2] * RAD), i * 3); mag[i] = VIS.hostMag(h) ?? 15; });
      data.hostIndex = new Map(j.hosts.map((h, i) => [h[0], i]));
      // the TESS candidates by name (TOI-1234.01), for the search box and links from the planner
      data.candIndex = new Map(); j.hosts.forEach((h, i) => { if (h[6]) for (const c of h[6][2]) data.candIndex.set(c[0], i); });
      data.hosts = { list: j.hosts, pos, n, mag, meta: j }; data.hostGeom = R.setHosts(pos, n); data.hostLimit = null; setStatus('');
    } catch (e) { hostsPromise = null; setStatus('Host stars could not be loaded: ' + e.message, true); S.layers.hosts = false; syncLayers(); throw e; }
  })();
}
// Discovery methods: the groups of a host are hosts.json's sixth column ('tr': most planets by transit, some by RV)
const GROUP_RGB = Object.fromEntries(DM.GROUPS.map((g) => [g.id, DM.rgb01(g.color)]));
/** The group a host is drawn in under the filter, or null when the filter hides it. */
const hostGroup = (i) => DM.shownGroup(data.hosts.list[i][5], S.disc);
/** The magnitude a host is drawn by: V, else T (TESS candidates), else 15. */
const hostMagOf = (i) => data.hosts.mag[i];
// The catalogue beyond positions (names for the search box, the planets' values for the card): src/sky/targets.js,
// imported on first use so that neither its code nor its tables are part of the page load.
const fetchJson = async (file) => { const r = await fetch(new URL(file, siteRoot()).href); if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`); return r.json(); };
let targetsPromise = null;
const loadTargets = () => (targetsPromise ||= import('./targets.js').then((T) => { data.T = T; data.cat = T.createCatalog(fetchJson); return T; }).catch((e) => { targetsPromise = null; throw e; }));
/** The planet table, for the cards: fetched when the Exoplanets layer is switched on or a host card is opened. */
function ensureTable() {
  data.tableError = '';
  return loadTargets().then(() => data.cat.table()).then(() => { cardKey = ''; }).catch((e) => { data.tableError = String(e && e.message || e); cardKey = ''; console.warn('planet table:', e); });
}
async function loadSats() {
  if (data.sats || data.satLoading) return;
  data.satLoading = true; setStatus('Fetching satellite elements from CelesTrak…');
  try {
    data.satApi = await import('./satellites.js');
    const r = await data.satApi.loadSatellites(); data.sats = r.sats;
    data.satNote = `${r.sats.length} satellites, elements ${r.fromCache ? 'cached ' : 'fetched '}${new Date(r.fetched).toISOString().slice(0, 16).replace('T', ' ')} UTC`; setStatus('');
  } catch (e) { setStatus('Satellite elements could not be fetched (' + e.message + ').', true); S.layers.satellites = false; syncLayers(); }
  data.satLoading = false;
}
let statusTimer = 0;
function setStatus(msg, sticky) { const el = $('status'); el.textContent = msg; el.hidden = !msg; clearTimeout(statusTimer); if (msg && sticky) statusTimer = setTimeout(() => { el.hidden = true; }, 6000); }

// ---------------------------------------------------------------- one frame
const interp = (x, pts) => { if (x <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return pts[pts.length - 1][1]; };
function manualView() {
  const az = S.az * RAD, alt = S.alt * RAD, f = dirOf(alt, az), r = [Math.cos(az), 0, Math.sin(az)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return [...r, ...u, -f[0], -f[1], -f[2]];
}
function compute() {
  const lat = S.lat * RAD, lon = S.lon * RAD, sys = A.solarSystem(S.time, lat, lon, S.elev), atm = S.layers.atmosphere, immersive = xr.presenting;
  const dateToWorld = A.matMul(ENU_TO_WORLD, A.equatorialToHorizontalMatrix(lat, sys.lst)), j2000ToWorld = A.matMul(dateToWorld, A.j2000ToDateMatrix(sys.T));
  const rows = S.ar && ar.state.rows ? ar.state.rows : manualView(), centre = viewCentre(rows);
  if (S.ar && ar.state.rows) { S.az = centre.az * DEG; S.alt = centre.alt * DEG; }
  if (!immersive) R.setView(rows, S.fov * RAD);
  const apparent = (alt) => (atm ? alt + A.refraction(alt) : alt), place = (b) => ({ ...b, altApp: apparent(b.alt), dir: dirOf(apparent(b.alt), b.az) });
  const sun = place(sys.sun), moon = place(sys.moon), hs = sys.sun.alt * DEG;
  // limiting magnitude: deeper as the field narrows; shallower as the sky brightens
  // (a headset has one field of view: there the limit is that of the widest flat view, moved by the thumbstick)
  const fovEff = immersive ? 100 : S.fov, zoomLimit = clamp(Math.min(8.4, 5.8 + 2.0 * Math.log10(100 / fovEff)) + S.magOffset, 1, 8.4);
  const skyLimit = atm ? interp(hs, [[-18, 9], [-12, 5.6], [-6, 2.6], [-2, 0.2], [0, -2.4], [5, -4.6]]) : 99;
  const magLimit = Math.min(zoomLimit, skyLimit);
  const planets = sys.planets.map((p) => { const o = place(p); o.color = PLANET_COLOR[p.id]; o.drawMag = p.id === 'uranus' || p.id === 'neptune' ? p.mag : Math.min(p.mag, magLimit - 1.4); return o; });
  // Moon: the direction of the Sun on the screen and the phase angle give the lit side
  let light = [0, 0, 1];
  { const d = sun.dir[0] * moon.dir[0] + sun.dir[1] * moon.dir[1] + sun.dir[2] * moon.dir[2], t = sun.dir.map((v, i) => v - d * moon.dir[i]), tl = Math.hypot(...t) || 1;
    const p0 = R.project(moon.dir), p1 = R.project(moon.dir.map((v, i) => v + 0.01 * t[i] / tl).map((v, _, a) => v / Math.hypot(...a)));
    if (p0 && p1) { const dx = p1[0] - p0[0], dy = -(p1[1] - p0[1]), l = Math.hypot(dx, dy) || 1, s = Math.sin(moon.phase); light = [s * dx / l, s * dy / l, Math.cos(moon.phase)]; } }
  const pa = R.pixelAngle, sunDisc = Math.max(sun.radius / pa, 5), moonDisc = Math.max(moon.radius / pa, 6.5);
  let sats = null;
  if (S.layers.satellites && data.sats) sats = data.satApi.satellitePositions(data.sats, S.time, lat, lon, S.elev).map((s) => ({ ...s, dir: dirOf(apparent(s.alt), s.az) }));
  const lookDown = immersive ? 0 : clamp((5 - centre.alt * DEG) / 30, 0, 1);
  F = {
    sys, lat, lon, rows, centre, dateToWorld, j2000ToWorld, worldToJ2000: A.transpose(j2000ToWorld), layers: S.layers, hostsReady: !!data.hosts,
    sunDir: sun.dir, sunAlt: hs, day: hs >= 6 ? 1 : Math.exp((hs - 6) / 4.4), glow: Math.exp(-(((hs + 2.5) / 6.5) ** 2)), dusk: Math.exp(-(((hs + 7) / 6) ** 2)),
    groundAlpha: 1 - 0.5 * lookDown * lookDown * (3 - 2 * lookDown), magLimit, zoomLimit, starSize: 1, starFade: atm ? 0.3 + 0.7 * clamp((skyLimit - 1) / 4.5, 0, 1) : 1,
    planets, sats, apparent, xr: immersive ? { passthrough: xr.state.kind === 'ar' } : null,
    sun: { ...sun, sprite: sunDisc * 4, disc: sunDisc, color: atm && hs < 8 ? [1, 0.82 + 0.14 * clamp(hs / 8, 0, 1), 0.55 + 0.27 * clamp(hs / 8, 0, 1), 1] : [1, 0.96, 0.82, 1] },
    moon: { ...moon, sprite: moonDisc * 1.5, disc: moonDisc, color: [0.96, 0.94, 0.88, 1], light },
  };
  if (data.hosts && S.layers.hosts) {     // which host stars are shown follows the zoom
    const lim = 6.5 + 5 * Math.log10(100 / fovEff) + S.magOffset;
    if (data.hostLimit == null || Math.abs(lim - data.hostLimit) > 0.05 || data.hostDisc !== S.disc) {
      // a ring per host bright enough for the zoom, in the colour of its discovery group; none when the filter hides it
      data.hostLimit = lim; data.hostDisc = S.disc; const g = data.hostGeom, list = data.hosts.list, drawn = {};
      for (let i = 0; i < list.length; i++) {
        const gr = hostGroup(i), on = !!gr && data.hosts.mag[i] <= lim, c = GROUP_RGB[gr] || GROUP_RGB.o;
        // alpha 0.9: the dashed ring of a candidate (renderer.js)
        g.attributes.aSize.setX(i, on ? 5.5 : 0); g.attributes.aColor.setXYZW(i, c[0], c[1], c[2], gr === 'c' ? 0.9 : 0.95); if (on) drawn[gr] = (drawn[gr] || 0) + 1;
      }
      g.attributes.aSize.needsUpdate = g.attributes.aColor.needsUpdate = true; data.hostDrawn = drawn;
    }
  }
  updateNight();
  return F;
}
const toWorld = (m, v) => A.matVec(m, v);
/** The horizon's apparent altitude (radians) at an azimuth (radians): the terrain profile when it is on, else 0. */
const horizonRad = (az) => (data.horizon && S.layers.terrain && S.layers.ground ? horizonAt(data.horizon, az * DEG) * RAD : 0);
/** Is a world direction hidden by an opaque ground? */
const hidden = (w) => {
  if (!S.layers.ground || F.groundAlpha <= 0.93) return false;
  if (!data.horizon || !S.layers.terrain) return w[1] < -0.004;
  return w[1] < 0.6 && Math.asin(clamp(w[1], -1, 1)) < horizonRad(Math.atan2(w[0], -w[2])) - 0.002;
};

// ---------------------------------------------------------------- the target through the night
const selKey = (s) => (s ? `${s.kind}:${s.i ?? s.id ?? s.name}` : '');
/** Airless altitude and azimuth of a selection at any time (stars and hosts are fixed J2000 positions). */
function altAzAt(sel, ms) {
  const lat = S.lat * RAD, lon = S.lon * RAD;
  if (sel.kind === 'body') { const b = A.solarSystem(ms, lat, lon, S.elev).bodies.find((x) => x.id === sel.id); return { alt: b.alt, az: b.az }; }
  const eq = sel.kind === 'host' ? data.hosts.list[sel.i].slice(1, 3) : sel.kind === 'pos' ? [sel.ra, sel.dec] : [data.stars.ra[sel.i], data.stars.dec[sel.i]];
  return A.fixedAltAz(eq[0] * RAD, eq[1] * RAD, ms, lat, lon);
}
const targetReady = (t) => !!t && (t.kind === 'body' || t.kind === 'pos' || (t.kind === 'host' ? !!data.hosts : t.kind === 'star' && !!data.stars));
/** Keep data.night (the span, its samples and the track drawn on the sky) in step with the target, place and date. */
function updateNight() {
  const tg = targetReady(S.target) ? S.target : null;
  if (!tg && !S.nightPlay) { if (data.night) { data.night = null; R.setTrack(null); R.setLine('transit', null); } return; }
  const lat = S.lat * RAD, lon = S.lon * RAD, tr = tg ? S.transit : null;
  // while it plays the span is frozen: the clock crossing the next noon must not move its end
  const ref = tr ? tr.mid : S.playing && $('rate').value === 'night' && data.night ? data.night.ref : S.time;
  const key = [selKey(tg), S.lat, S.lon, S.elev, tr ? tr.mid + (tr.kind || '') : A.noonBefore(ref, lon), S.layers.atmosphere, !!data.horizon].join('|');
  if (data.night && data.night.key === key) return;
  const w = nightWindow(ref, lat, lon, S.elev, tr), at = tg ? (t) => altAzAt(tg, t) : () => ({ alt: NaN, az: 0 });
  const samples = sampleNight(w, lat, lon, S.elev, at), n = { ...w, key, ref, samples, transit: tr, marks: [], hours: [] };
  if (tg) {
    const dir = (h) => dirOf(F.apparent(h.alt), h.az), up = (h) => F.apparent(h.alt) > horizonRad(h.az);
    R.setTrack(samples.map(dir), samples.slice(1).map((p, i) => (up(p) && up(samples[i]) ? 1 : 0.4)));
    if (tr) {
      const E = eventInfo(tr.kind); n.color = E.color;
      n.marks = [tr.ingress, tr.mid, tr.egress].map((t, k) => { const h = at(t); return { name: E.marks[k], t, mid: k === 1, dir: dir(h), up: up(h) }; });
      n.during = Array.from({ length: 25 }, (_, i) => dir(at(tr.ingress + (tr.egress - tr.ingress) * i / 24)));
    }
    R.setLine('transit', tr ? n.during : null, { color: parseInt(eventInfo(tr && tr.kind).color.slice(1), 16), alpha: 1 });
    const d = new Date(w.t0); d.setMinutes(0, 0, 0);
    for (let t = d.getTime() + 3600000; t < w.t1; t += 3600000) { const h = at(t); n.hours.push({ t, dir: dir(h), up: up(h) }); }
  } else { R.setTrack(null); R.setLine('transit', null); }
  data.night = n; nightKey = '';
}
/** Start, pause or resume the run through the night. */
function playNight(restart) {
  const was = S.nightPlay && $('rate').value === 'night'; S.nightPlay = true; compute(); const n = data.night; if (!n) return;
  if (was && S.playing && restart !== true) { S.playing = false; cardKey = ''; return; }
  // a new run starts at the beginning; one that was paused inside the span goes on from where it is
  if (!(was && restart !== true && S.time >= n.t0 && S.time < n.t1 - 1000)) S.time = n.t0;
  S.rate = (n.t1 - n.t0) / 40000; S.playing = true; S.live = false; $('rate').value = 'night'; cardKey = '';
  frameTrack();
}
/**
 * Turn the view for the run through the night (not in AR, where the phone decides): so that the part of the track
 * above the horizon is in what the card and the bars leave free, when it fits; else the view follows the target.
 */
function frameTrack() {
  const n = data.night; if (!n || S.ar || !targetReady(S.target)) return;
  if (narrow.matches) $('info').classList.add('folded');          // on a phone the sheet gives the sky back
  let pts = n.samples.filter((p) => p.alt > horizonRad(p.az)); if (pts.length < 2) pts = n.samples;
  // azimuths unwrapped along the track, so that a path through north does not jump
  let prev = pts[0].az, lo = prev, hi = prev, aMax = -9, aMin = 9;
  for (const p of pts) { prev += A.wrapPi(p.az - prev); lo = Math.min(lo, prev); hi = Math.max(hi, prev); aMax = Math.max(aMax, p.alt); aMin = Math.min(aMin, p.alt); }
  const altC = clamp((aMax + Math.max(aMin, 0)) / 2, 8 * RAD, 80 * RAD), card = $('info'), left = !narrow.matches && !card.hidden ? card.offsetWidth + 14 : 0;
  const dy = R.height / 2 - (TOP_CLEAR + (R.height - sheetHeight() - TOP_CLEAR) / 2), keep = { az: S.az, alt: S.alt, fov: S.fov };
  // the narrowest field, centred on the middle of the track and moved clear of the card, that holds all of it
  const fits = (fov) => {
    S.fov = fov; S.az = A.wrap2pi((lo + hi) / 2) * DEG; S.alt = altC * DEG; R.setView(manualView(), fov * RAD);
    if (left) S.az = (S.az - (left / 2) * R.pixelAngle * DEG / Math.max(0.3, Math.cos(S.alt * RAD)) + 360) % 360;
    if (dy > 20) S.alt = clamp(S.alt - dy * R.pixelAngle * DEG, -30, 89);
    R.setView(manualView(), fov * RAD);
    return pts.every((p) => { const q = R.project(dirOf(F.apparent(p.alt), p.az)); return q && q[0] > left + 30 && q[0] < R.width - 30 && q[1] > TOP_CLEAR - 30 && q[1] < R.height - sheetHeight() - 20; });
  };
  S.follow = false;
  for (let fov = 50; fov <= 140; fov += 10) if (fits(fov)) return;
  Object.assign(S, keep); S.follow = true; S.fov = clamp(S.fov, 50, 90); centreOn(S.target);
}
/** While the night plays in follow mode: keep the target where centreOn() puts it, without recomputing the frame. */
function followTarget() {
  const s = infoOf(S.target); if (!s || !s.dir) return;
  const dy = R.height / 2 - (TOP_CLEAR + (R.height - sheetHeight() - TOP_CLEAR) / 2);
  S.az = s.az * DEG; S.alt = clamp(s.alt * DEG - (dy > 20 ? dy * R.pixelAngle * DEG : 0), -89, 89);
}

// ---------------------------------------------------------------- labels (2D canvas over the GL canvas)
function text(str, x, y, color, opts = {}) {
  ctx.font = opts.font || '11px Inter, system-ui, sans-serif'; ctx.textAlign = opts.align || 'left'; ctx.textBaseline = opts.base || 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(2,4,10,0.55)'; ctx.strokeText(str, x, y); ctx.fillStyle = color; ctx.fillText(str, x, y);
}
function drawLabels() {
  const W = R.width, H = R.height, px = Math.min(window.devicePixelRatio || 1, 2);
  if (labels.width !== Math.round(W * px) || labels.height !== Math.round(H * px)) { labels.width = Math.round(W * px); labels.height = Math.round(H * px); }
  ctx.setTransform(px, 0, 0, px, 0, 0); ctx.clearRect(0, 0, W, H); ctx.lineJoin = 'round';
  const inView = (p) => p && p[0] > -40 && p[0] < W + 40 && p[1] > -20 && p[1] < H + 20, L = S.layers, fade = F.starFade;
  const refr = (w) => { if (!L.atmosphere) return w; const h = altAzOf(w); return dirOf(F.apparent(h.alt), h.az); };

  if (L.constellations && L.labels && data.con) {
    ctx.globalAlpha = 0.75 * fade;
    data.con.labels.forEach((l, i) => { const w = toWorld(F.j2000ToWorld, data.con.labelVec[i]); if (hidden(w)) return; const p = R.project(w); if (inView(p)) text(l[1].toUpperCase(), p[0], p[1], '#86a8e6', { align: 'center', font: '600 10px Inter, system-ui, sans-serif' }); });
    ctx.globalAlpha = 1;
  }
  if (L.labels && data.stars?.labelled) {
    const s = data.stars, lim = F.magLimit - (S.fov > 60 ? 4.4 : 3.8), desLim = S.fov < 45 ? F.magLimit - 2.6 : -99, placed = [];
    for (const st of s.labelled) {
      const m = s.mag[st.i]; if (m > Math.max(lim, desLim)) break;
      const name = st.proper && m <= lim ? st.proper : m <= desLim ? (st.proper || st.des) : ''; if (!name) continue;
      const w = refr(toWorld(F.j2000ToWorld, [s.pos[st.i * 3], s.pos[st.i * 3 + 1], s.pos[st.i * 3 + 2]])); if (hidden(w)) continue;
      const p = R.project(w); if (!inView(p) || placed.some((o) => Math.abs(o[0] - p[0]) < 46 && Math.abs(o[1] - p[1]) < 11)) continue;      // brightest first, so the fainter of two close names is dropped
      placed.push(p); text(name, p[0] + 7 + 0.5 * (F.magLimit - m), p[1] + 1, 'rgba(214,224,243,0.82)');
    }
  }
  if (L.hosts && L.labels && data.hosts && S.fov < 30) {
    let n = 0; const list = data.hosts.list, lim = data.hostLimit - 1.5;
    for (let i = 0; i < list.length && n < 80; i++) {
      if (data.hosts.mag[i] > lim) break;
      const gr = hostGroup(i); if (!gr) continue;
      const w = toWorld(F.j2000ToWorld, [data.hosts.pos[i * 3], data.hosts.pos[i * 3 + 1], data.hosts.pos[i * 3 + 2]]); if (hidden(w)) continue;
      // the name and the letter of the discovery group, in its colour (the letter: so that colour is not the only cue)
      const p = R.project(w); if (inView(p)) { const G = DM.groupInfo(gr); text(`${list[i][0]} · ${G.short}`, p[0] + 9, p[1] - 8, G.color); n++; }
    }
  }
  if (L.planets && L.labels) for (const b of [F.sun, F.moon, ...F.planets]) {
    if (hidden(b.dir)) continue; const p = R.project(b.dir); if (!inView(p)) continue;
    if ((b.id === 'uranus' || b.id === 'neptune') && b.mag > F.magLimit) continue;
    const off = b.id === 'sun' ? F.sun.disc + 6 : b.id === 'moon' ? F.moon.disc + 6 : 12;
    text(b.name, p[0] + off, p[1] + 1, b.id === 'sun' || b.id === 'moon' ? '#ffe2a8' : '#ffd08a', { font: '600 11px Inter, system-ui, sans-serif' });
  }
  if (L.satellites && L.labels && F.sats) {
    const many = S.fov > 70;
    for (const s of F.sats) { if (hidden(s.dir) || (many && !/^(ISS|CSS|HST)\b/.test(s.name))) continue; const p = R.project(s.dir); if (inView(p)) text(s.name, p[0] + 6, p[1] - 6, s.sunlit ? 'rgba(255,236,180,0.85)' : 'rgba(150,160,185,0.6)', { font: '10px Inter, system-ui, sans-serif' }); }
  }
  // cardinal points on the horizon
  const card = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
  for (const [name, az] of card) {
    const p = R.project(dirOf(Math.max(0, horizonRad(az * RAD)), az * RAD)); if (!inView(p)) continue; const main = name.length === 1;
    text(name, p[0], p[1] + (main ? 13 : 11), main ? '#ffb454' : 'rgba(255,180,84,0.6)', { align: 'center', font: (main ? '700 15px' : '600 10px') + ' Inter, system-ui, sans-serif' });
  }
  if (L.altlimit) for (let az = 0; az < 360; az += 45) { const p = R.project(dirOf(30 * RAD, az * RAD)); if (inView(p)) text('30°', p[0], p[1] - 8, 'rgba(120,220,170,0.85)', { align: 'center', font: '10px Inter, system-ui, sans-serif' }); }
  drawTrackMarks(inView);
  const sel = selectionInfo();
  if (sel && sel.dir && selKey(cardSel()) !== selKey(S.target)) { const p = R.project(sel.dir); if (p) { ctx.strokeStyle = '#5fd4ff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p[0], p[1], sel.ring || 13, 0, 7); ctx.stroke(); } }
  drawReticle(W, H);
  if (S.ar) { ctx.strokeStyle = 'rgba(95,212,255,0.9)'; ctx.lineWidth = 1.2; ctx.beginPath(); const cx = W / 2, cy = H / 2; ctx.arc(cx, cy, 16, 0, 7); ctx.moveTo(cx - 28, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 28, cy); ctx.moveTo(cx, cy - 28); ctx.lineTo(cx, cy - 8); ctx.moveTo(cx, cy + 8); ctx.lineTo(cx, cy + 28); ctx.stroke(); }
}

// The track of the target is a GL line (renderer.setTrack); here: the hours along it, and the transit on it.
function drawTrackMarks(inView) {
  const n = data.night; if (!n || !targetReady(S.target)) return;
  const font = '10px Inter, system-ui, sans-serif';
  for (const h of n.hours) { const p = R.project(h.dir); if (!inView(p)) continue; ctx.globalAlpha = h.up ? 1 : 0.45; ctx.fillStyle = '#ffb454'; ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, 7); ctx.fill(); text(hhmm(h.t), p[0], p[1] - 9, 'rgba(255,200,130,0.9)', { align: 'center', font }); }
  ctx.globalAlpha = 1;
  if (!n.transit) return;
  // the part of the track during the transit, drawn wide
  const col = n.color || '#5fd4ff'; ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); let pen = null;
  for (const d of n.during) { const p = R.project(d); if (p && pen && Math.hypot(p[0] - pen[0], p[1] - pen[1]) < 400) { ctx.moveTo(pen[0], pen[1]); ctx.lineTo(p[0], p[1]); } pen = p; }
  ctx.stroke();
  for (const m of n.marks) {
    const p = R.project(m.dir); if (!inView(p)) continue;
    ctx.fillStyle = '#05070c'; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p[0], p[1], m.mid ? 6 : 4.5, 0, 7); ctx.fill(); ctx.stroke();
    if (m.mid) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fill(); }
    text(`${m.name} ${hhmm(m.t)}${m.up ? '' : ' (below the horizon)'}`, p[0] + 11, p[1] + 14, '#bfeaff', { font: '600 11.5px Inter, system-ui, sans-serif' });
  }
}
/** The target's reticle and name; when it is outside the view, an arrow at the edge that points to it. */
let offArrow = null;
function drawReticle(W, H) {
  offArrow = null;
  const tg = targetReady(S.target) ? S.target : null, s = tg && infoOf(tg); if (!s || !s.dir) return;
  const p = R.project(s.dir), card = $('info'), bar = document.querySelector('.sky-bar').offsetHeight + ($('nightBar').hidden ? 0 : $('nightBar').offsetHeight) + (narrow.matches && !card.hidden ? card.offsetHeight : 0), m = 34;
  const amber = '#ffb454', below = s.alt < horizonRad(s.az), sub = below ? 'below the horizon' : `altitude ${(s.alt * DEG).toFixed(0)}°`;
  if (p && p[0] > m && p[0] < W - m && p[1] > m + 30 && p[1] < H - bar - m) {
    const r = Math.max(24, (s.ring || 0) + 12), pulse = (performance.now() % 2400) / 2400;
    ctx.lineCap = 'butt';
    for (const [col, lw] of [['rgba(2,4,10,0.75)', 5.5], [amber, 2.5]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(p[0] + dx * (r + 5), p[1] + dy * (r + 5)); ctx.lineTo(p[0] + dx * (r + 19), p[1] + dy * (r + 19)); }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.7 * (1 - pulse); ctx.strokeStyle = amber; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p[0], p[1], r + 6 + 26 * pulse, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    if (tg.kind === 'host') { ctx.fillStyle = DM.colorOf(hostGroup(tg.i) || (data.hosts.list[tg.i][5] || 'o')[0]); ctx.beginPath(); ctx.arc(p[0], p[1], 2.6, 0, 7); ctx.fill(); }
    pill(tg.name, sub, p[0], p[1] + r + 30, W);
  } else {
    // direction on the screen: the camera-space x and y of the target (it may be behind the viewer)
    const v = [F.rows[0] * s.dir[0] + F.rows[1] * s.dir[1] + F.rows[2] * s.dir[2], F.rows[3] * s.dir[0] + F.rows[4] * s.dir[1] + F.rows[5] * s.dir[2]], l = Math.hypot(v[0], v[1]) || 1, ux = v[0] / l, uy = -v[1] / l;
    const left = !narrow.matches && !card.hidden ? card.offsetWidth + 14 : 0;       // on a desktop the card covers the left edge
    const cx = (W + left) / 2, cy = (H - bar + 40) / 2, hw = (W - left) / 2 - 46, hh = (H - bar - 40) / 2 - 46, k = Math.min(hw / Math.abs(ux || 1e-9), hh / Math.abs(uy || 1e-9)), x = cx + ux * k, y = cy + uy * k;
    const sep = Math.acos(clamp(-(F.rows[6] * s.dir[0] + F.rows[7] * s.dir[1] + F.rows[8] * s.dir[2]), -1, 1)) * DEG;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(uy, ux));
    ctx.fillStyle = amber; ctx.strokeStyle = 'rgba(2,4,10,0.8)'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(24, 0); ctx.lineTo(-4, -14); ctx.lineTo(3, 0); ctx.lineTo(-4, 14); ctx.closePath(); ctx.stroke(); ctx.fill(); ctx.restore();
    pill(tg.name, `${sep.toFixed(0)}° this way · tap to centre`, clamp(x - ux * 62, left + 90, W - 90), clamp(y - uy * 40, 70, H - bar - 30), W);
    offArrow = { x, y };
  }
}
/** A two-line label on a dark pill, centred on x. */
function pill(title, sub, x, y, W) {
  ctx.font = '700 13px Inter, system-ui, sans-serif'; const w1 = ctx.measureText(title).width; ctx.font = '11px Inter, system-ui, sans-serif'; const w2 = ctx.measureText(sub).width;
  const w = Math.max(w1, w2) + 18, cx = clamp(x, w / 2 + 4, W - w / 2 - 4);
  ctx.fillStyle = 'rgba(8,11,18,0.88)'; ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.roundRect(cx - w / 2, y - 17, w, 36, 8); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffd9a0'; ctx.font = '700 13px Inter, system-ui, sans-serif'; ctx.fillText(title, cx, y - 6);
  ctx.fillStyle = '#c6cfe0'; ctx.font = '11px Inter, system-ui, sans-serif'; ctx.fillText(sub, cx, y + 9);
}

// ---------------------------------------------------------------- selection
const hms = (rad) => { let s = Math.round(A.wrap2pi(rad) * DEG / 15 * 36000) / 10; if (s >= 86400) s -= 86400; const h = Math.floor(s / 3600), m = Math.floor((s - h * 3600) / 60); return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${(s - h * 3600 - m * 60).toFixed(1).padStart(4, '0')}s`; };
const dms = (rad) => { const sg = rad < 0 ? '−' : '+'; let s = Math.round(Math.abs(rad) * DEG * 3600); const d = Math.floor(s / 3600), m = Math.floor((s - d * 3600) / 60); return `${sg}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${String(s - d * 3600 - m * 60).padStart(2, '0')}″`; };
const compass = (azDeg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(azDeg / 22.5) % 16];
const starName = (i) => { const s = data.stars, nm = data.names[s.hip[i]], [proper, des] = nm ? nm.split('|') : ['', '']; return { title: proper || des || 'HIP ' + s.hip[i], sub: [proper && des, 'HIP ' + s.hip[i]].filter(Boolean).join(' · ') }; };

/** The selection whose card is shown: the host under the mouse, else what was tapped, searched for or linked to. */
const cardSel = () => S.hover || S.selection;
const selectionInfo = () => infoOf(cardSel());
/** Everything the info card shows for a selection, recomputed for the current frame. */
function infoOf(sel) {
  if (!sel || !F) return null;
  const hor = (w) => { const h = altAzOf(w); return { alt: F.apparent(h.alt), az: h.az, altTrue: h.alt }; };
  if (sel.kind === 'star' && data.stars) {
    const s = data.stars, i = sel.i, w = toWorld(F.j2000ToWorld, [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]]), h = hor(w), n = starName(i);
    return { ...n, type: 'Star', ...h, dir: dirOf(h.alt, h.az), ra: s.ra[i] * RAD, dec: s.dec[i] * RAD, frame: 'J2000', rows: [['Magnitude', `V ${s.mag[i].toFixed(2)}` + (Number.isFinite(s.bv[i]) ? ` · B−V ${s.bv[i].toFixed(2)}` : '')]] };
  }
  if (sel.kind === 'pos') {
    // a catalogue position (a link from the Search page for an object this page does not list: an exoplanet.eu-only planet, a KOI)
    const w = toWorld(F.j2000ToWorld, A.sphToVec(sel.ra * RAD, sel.dec * RAD)), h = hor(w);
    return { title: sel.name, sub: sel.from || 'catalogue position', type: 'Catalogue position', ...h, dir: dirOf(h.alt, h.az), ra: sel.ra * RAD, dec: sel.dec * RAD, frame: 'J2000', rows: [] };
  }
  if (sel.kind === 'body') {
    const b = [F.sun, F.moon, ...F.planets].find((x) => x.id === sel.id); if (!b) return null;
    const rows = [['Magnitude', b.mag.toFixed(1)], ['Distance', b.id === 'moon' ? `${Math.round(b.distKm).toLocaleString('en-US')} km` : `${b.dist.toFixed(b.dist < 2 ? 4 : 3)} au`]];
    if (b.id === 'moon') rows.push(['Illuminated', `${(b.fraction * 100).toFixed(0)}%`]);
    else if (b.id !== 'sun') rows.push(['Phase angle', `${(b.phase * DEG).toFixed(0)}°`]);
    return { title: b.name, sub: '', type: b.id === 'sun' ? 'Star' : b.id === 'moon' ? 'Moon' : 'Planet', alt: b.altApp, altTrue: b.alt, az: b.az, dir: b.dir, ra: b.ra, dec: b.dec, frame: 'of date, topocentric', rows, ring: b.id === 'sun' ? F.sun.disc + 6 : b.id === 'moon' ? F.moon.disc + 6 : 13 };
  }
  if (sel.kind === 'sat') {
    const s = F.sats && F.sats.find((x) => x.name === sel.name); if (!s) return { title: sel.name, sub: 'not available at this time', type: 'Satellite', rows: [] };
    const eq = A.horizontalToEquatorial(s.alt, s.az, F.lat, F.sys.lst);
    return { title: s.name, sub: s.sunlit ? 'in sunlight' : 'in the Earth’s shadow', type: 'Satellite', alt: F.apparent(s.alt), altTrue: s.alt, az: s.az, dir: s.dir, ra: eq.ra, dec: eq.dec, frame: 'of date, topocentric', rows: [['Range', `${Math.round(s.range).toLocaleString('en-US')} km`], ['Height', `${Math.round(s.height).toLocaleString('en-US')} km`]] };
  }
  if (sel.kind === 'host' && data.hosts) {
    const h0 = data.hosts.list[sel.i], w = toWorld(F.j2000ToWorld, [data.hosts.pos[sel.i * 3], data.hosts.pos[sel.i * 3 + 1], data.hosts.pos[sel.i * 3 + 2]]), h = hor(w);
    const np = h0[4], cands = VIS.candidatesOf(h0), plural = (n, w2) => `${n} ${w2}${n === 1 ? '' : 's'}`;
    const sub = [np ? plural(np, 'known planet') : '', cands.length ? plural(cands.length, 'TESS candidate') : ''].filter(Boolean).join(' · ');
    return { title: h0[0], sub, type: np ? 'Exoplanet host' : 'TESS candidate (not confirmed)', ...h, dir: dirOf(h.alt, h.az), ra: h0[1] * RAD, dec: h0[2] * RAD, frame: 'ICRS', rows: [], host: h0[0], vmag: h0[3],
      tmag: h0[6] ? h0[6][0] : null, tic: VIS.hostTic(h0), cands, planets: np, groups: h0[5] || '' };
  }
  return null;
}
let infoKey = '', cardKey = '', nightKey = '', transitKey = '';
const bodyFor = { sel: '', focus: '' };      // the selection (and its planet) the card body was last built for
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tzLabel = (ms) => { const off = -new Date(ms).getTimezoneOffset(), a = Math.abs(off); return 'UTC' + (off >= 0 ? '+' : '−') + (a % 60 ? `${Math.floor(a / 60)}:${pad(a % 60)}` : Math.floor(a / 60)); };
/** The transit that came with the link: ingress, mid and egress in local time and UTC, where the target is at each, and whether it can be seen. */
function transitHtml(sel) {
  const tr = S.transit, lat = S.lat * RAD, lon = S.lon * RAD, terrain = !!data.horizon && S.layers.terrain;
  const E = eventInfo(tr.kind), rows = [[E.rows[0], tr.ingress], [E.rows[1], tr.mid], [E.rows[2], tr.egress]].map(([name, t]) => {
    const h = altAzAt(sel, t), alt = S.layers.atmosphere ? h.alt + A.refraction(h.alt) : h.alt, sun = A.sunAltitude(t, lat, lon, S.elev) * DEG;
    return { name, t, alt, az: h.az, up: alt > horizonRad(h.az), sun, tw: A.twilight(sun) };
  });
  const TW = { day: 'Sun up', civil: 'civil twilight', nautical: 'nautical twilight', astronomical: 'astronomical twilight', night: 'night' };
  const day = (ms, utc) => DAYS[utc ? new Date(ms).getUTCDay() : new Date(ms).getDay()];
  const line = (r) => `<tr class="${r.up && r.tw !== 'day' ? '' : 'off'}" title="Sun at ${r.sun.toFixed(1)}°"><td>${r.name}</td><td><b>${hhmm(r.t)}</b> <small>${day(r.t)}</small></td><td>${hhmmUtc(r.t)} <small>${day(r.t, true)}</small></td><td>${(r.alt * DEG).toFixed(0)}°</td><td>${(r.az * DEG).toFixed(0)}° ${compass(r.az * DEG)}</td><td>${r.up ? 'up' : 'below'} · ${r.tw === 'day' ? 'Sun up' : r.tw === 'night' ? 'night' : 'twilight'}</td></tr>`;
  const names = (list) => list.map((r) => r.name.toLowerCase()).join(' and '), down = rows.filter((r) => !r.up), lit = rows.filter((r) => r.tw === 'day'), dusk = rows.filter((r) => r.tw !== 'day' && r.tw !== 'night');
  const s1 = !down.length ? `Above the ${terrain ? 'terrain ' : ''}horizon from ingress to egress` : down.length === 3 ? `Below the ${terrain ? 'terrain ' : ''}horizon throughout` : `Below the ${terrain ? 'terrain ' : ''}horizon at ${names(down)}`;
  const s2 = lit.length === 3 ? 'the Sun is up throughout' : lit.length ? `the Sun is up at ${names(lit)}` : dusk.length ? `the Sun is down, with ${dusk.map((r) => `${TW[r.tw]} at ${r.name.toLowerCase()}`).join(', ')}` : 'the Sun is down and the sky fully dark (night) throughout';
  const d = new Date(tr.mid);
  return `<h3><span class="evk" style="--c:${E.color}"></span>This ${E.word} · ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</h3>` +
    `<table class="tt"><tr><th></th><th title="The time zone of this browser">Local (${tzLabel(tr.mid)})</th><th>UTC</th><th>Alt</th><th>Az</th><th></th></tr>${rows.map(line).join('')}</table>` +
    `<p class="verdict ${!down.length && !lit.length ? 'ok' : 'warn'}">${s1}; ${s2}.</p>` +
    (tr.err != null ? `<p class="note">Predicted mid-time uncertain by ± ${tr.err < 10 ? tr.err.toFixed(1) : tr.err.toFixed(0)} min (1σ).</p>` : '') +
    `<p class="note">Altitudes ${S.layers.atmosphere ? 'with refraction' : 'without refraction'}; local times are in this browser's time zone.</p>`;
}
function drawInfo() {
  const el = $('info'), sel = cardSel(), s = infoOf(sel);
  if (!s) { if (!el.hidden) el.hidden = true; infoKey = cardKey = ''; return; }
  const row = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  // a host's card keeps to the summary (altitude and azimuth here); its fixed RA and Dec are under the planets
  const below = s.dir && s.alt < horizonRad(s.az);
  const pos = s.dir ? row(S.layers.atmosphere ? 'Altitude <span class="hint" title="Apparent altitude, with refraction (the atmosphere layer is on)">app.</span>' : 'Altitude', dms(s.alt)) + row('Azimuth', `${(s.az * DEG).toFixed(2).padStart(6, '0')}° ${compass(s.az * DEG)}`)
    + (s.host ? (below ? '<div class="frame">below the horizon</div>' : '') : row('RA', hms(s.ra)) + row('Dec', dms(s.dec)) + `<div class="frame">RA/Dec: ${s.frame}${below ? ' · below the horizon' : ''}</div>`) : '';
  const live = s.rows.map((r) => row(r[0], r[1])).join('') + pos;
  if (live !== infoKey) { $('cardLive').innerHTML = live; infoKey = live; }
  // everything that does not change with the clock is built once per selection (so that links and scrolling survive)
  const isTarget = selKey(sel) === selKey(S.target), cat = data.cat, table = s.host ? (!s.planets ? 'none' : data.tableError ? 'error' : cat ? cat.state.table : 'idle') : '';
  const key = [selKey(sel), isTarget, table, isTarget && S.target.planet, isTarget && S.transit ? [S.transit.mid, S.transit.kind, S.lat, S.lon, S.elev, S.layers.atmosphere, !!data.horizon && S.layers.terrain].join() : '', $('rate').value === 'night' && S.playing].join('|');
  if (key !== cardKey) {
    cardKey = key;
    const rows = s.host && table === 'ready' ? cat.rowsOfHost(s.host) : null, T = data.T;
    let head = `<div class="type">${s.type}</div><h2>${escHtml(s.title)}</h2>`, sub = s.sub, body = '';
    if (s.host) {
      if (rows && T) { const star = T.starLine(rows); if (star) sub += ' · ' + star; }
      const tm = s.tmag != null && !(rows && rows[0] && Number.isFinite(rows[0].v.tmag)) ? `<span class="mag" title="TESS magnitude (TOI table)"><i>T</i> ${s.tmag.toFixed(2)}</span>` : '';
      head += `<div class="sub">${sub}</div>` + (T && rows ? T.magnitudesHtml(rows, s.vmag).replace('</div>', tm + '</div>') : `<div class="mags">${s.vmag == null ? '' : `<span class="mag"><i>V</i> ${s.vmag.toFixed(2)}</span>`}${tm}</div>`) + methodsHtml(s.groups);
      const where = `<p class="note pos">RA ${hms(s.ra)} · Dec ${dms(s.dec)} (ICRS)${s.tic ? ` · TIC ${s.tic}` : ''}</p>`, cand = candidatesHtml(s, isTarget ? S.target.planet : null);
      // the planets: one disclosure for all of them, folded, and one inside it per planet (targets.js)
      const focusPl = isTarget && S.target.planet && !/^TOI-/.test(S.target.planet);
      if (table === 'none') body = cand + where;
      else if (table === 'ready') body = (rows.length ? `<details class="pls" data-k="pls"${focusPl ? ' open' : ''}><summary>Planets (${rows.length})</summary>${T.planetsHtml(rows, siteRoot(), isTarget ? S.target.planet : null)}`
        + `<p class="note src">Values: NASA Exoplanet Archive, composite parameters${cat.state.date ? ', snapshot ' + escHtml(cat.state.date) : ''}. <span class="est">~</span> marks a value estimated from a relation, named under the planet.</p></details>` : '<p class="note">The planet table has no entry for this star.</p>') + cand + T.archiveDataHtml(s.host, rows) + where;
      else if (table === 'error') body = `<p class="note">The planet table could not be loaded (${escHtml(data.tableError)}). <button class="linklike" data-act="retry">Try again</button></p>` + cand + where;
      else { body = '<p class="note">Loading the planets of this star…</p>' + cand + where; if (table === 'idle') ensureTable(); }
    } else if (sub) head += `<div class="sub">${sub}</div>`;
    $('cardHead').innerHTML = head;
    const canTarget = sel.kind !== 'sat' && !!s.dir, playing = $('rate').value === 'night' && S.playing;
    $('cardActions').innerHTML = (s.dir ? '<button class="btn" data-act="centre">Centre</button>' : '') + (isTarget ? `<button class="btn primary" data-act="night">${playing ? 'Pause' : 'Play the night'}</button><button class="btn" data-act="untarget">Unmark</button>` : canTarget ? '<button class="btn" data-act="target">Mark and follow</button>' : '')
      + (s.host ? `<a class="btn simbad" href="${escHtml(DM.simbadUrl(s.host))}" target="_blank" rel="noopener" title="This star in SIMBAD (CDS, the CfA mirror), in a new tab">SIMBAD ↗</a>` : '');
    // the same star again (the table arrived, the night started): the disclosures stay as the user left them
    const el2 = $('cardBody'), same = bodyFor.sel === selKey(sel), focus = isTarget ? S.target.planet || '' : '';
    const open = same ? new Set([...el2.querySelectorAll('details')].filter((d) => d.open).map((d) => d.dataset.k)) : null, had = same && !!el2.querySelector('details');
    el2.innerHTML = body;
    if (had) for (const d of el2.querySelectorAll('details')) d.open = open.has(d.dataset.k) || (focus !== bodyFor.focus && (d.classList.contains('focus') || (d.dataset.k === 'pls' && !!focus)));
    bodyFor.sel = selKey(sel); bodyFor.focus = focus;
  }
  // the transit block follows the clock (the next transit changes as time runs), in steps of five minutes
  const tk = key + '|' + Math.floor(S.time / 300000);
  if (tk !== transitKey) {
    transitKey = tk; const nx = nextTransits(sel);
    $('cardTransit').innerHTML = isTarget && S.transit ? transitHtml(sel) : nextTransitsHtml(nx);
    // each planet's own next transit, inside its disclosure
    for (const slot of $('cardBody').querySelectorAll('.nxslot')) { const i = nx.findIndex((x) => x.planet === slot.dataset.pl); slot.innerHTML = i < 0 ? '' : nxHtml(nx[i], i, 'Next transit'); }
  }
  el.hidden = false;
}
/** One transit (an item of nextTransits) with a button that marks it; i: its index in that list. */
const nxHtml = (t, i, label) => `<div class="nx"><div>${label ? `<span class="k">${label}</span> ` : `<b>${escHtml(t.planet)}</b> `}${transitWords(t)}<small>${skyWords(t)}${t.err != null ? ` · ± ${t.err.toFixed(t.err < 10 ? 1 : 0)} min` : ''}</small></div><button class="btn" data-act="transit" data-i="${i}">Show</button></div>`;
/** The summary of a host's card: its soonest transit (each planet's own is in its disclosure). nx: nextTransits(sel). */
function nextTransitsHtml(nx) {
  if (!nx.length) return '';
  return '<h3>Next transit</h3>' + nxHtml(nx[0], 0) + `<p class="note">Linear ephemeris of the archive${nx.some((t) => t.candidate) ? ' (of the TESS pipeline for candidates)' : ''}; local time.${nx.length > 1 ? ' Each planet’s next transit is under its name.' : ''}</p>`;
}
/**
 * The TESS candidates of a host card: one disclosure for all, one per candidate (TOI, period, depth, duration, epoch,
 * disposition, its next transit, links to the planner and ExoFOP). focus: the TOI asked for (open).
 */
function candidatesHtml(s, focus) {
  if (!s.cands || !s.cands.length) return '';
  const G = DM.groupInfo('c'), date = data.hosts.meta.toiDate || '', num = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
  const one = (c) => {
    const kv = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`, q = encodeURIComponent(c.name);
    return `<details class="pl${c.name === focus ? ' focus' : ''}" data-k="toi:${escHtml(c.name)}"${c.name === focus ? ' open' : ''}><summary class="pl-h"><b>${escHtml(c.name)}</b><span class="pl-tags"><span class="dm" style="--c:${G.color}" title="${escHtml(G.note)}"><i aria-hidden="true">${G.short}</i>${c.disposition === 'APC' ? 'ambiguous candidate' : 'candidate'}</span></span></summary>` +
      `<div class="grid">${kv('Period', Number.isFinite(c.per) ? `${num(c.per, c.per < 100 ? 5 : 2)} d` : 'single transit: no period')}${kv('Depth', Number.isFinite(c.depth) ? `${(c.depth * 1000).toFixed(2)} ppt` : '—')}${kv('Duration', Number.isFinite(c.t14) ? `${(c.t14 * 24).toFixed(2)} h` : '—')}${kv('Epoch', Number.isFinite(c.tmid) ? `BJD ${num(c.tmid, 4)}` : '—')}${kv('TFOPWG', c.disposition ? `${c.disposition} (${c.disposition === 'APC' ? 'ambiguous planet candidate' : 'planet candidate'})` : 'no disposition yet')}</div>` +
      `<div class="nxslot" data-pl="${escHtml(c.name)}"></div>` +
      `<div class="links"><a class="btn primary" href="${escHtml(new URL('plan/?planet=' + q, siteRoot()).href)}">Plan</a>${s.tic ? `<a class="btn" href="https://exofop.ipac.caltech.edu/tess/target.php?id=${s.tic}" target="_blank" rel="noopener" title="This star in ExoFOP-TESS, in a new tab">ExoFOP ↗</a>` : ''}</div></details>`;
  };
  return `<details class="pls" data-k="cands"${(focus && /^TOI-/.test(focus)) || !s.planets ? ' open' : ''}><summary>TESS candidates (${s.cands.length})</summary>${s.cands.map(one).join('')}` +
    `<p class="note src">Not confirmed planets: TESS pipeline values from the TOI table (ExoFOP-TESS, via the NASA Exoplanet Archive${date ? ', snapshot ' + escHtml(date) : ''}). Known planets (KP, CP) and false positives (FP, FA) are left out.</p></details>`;
}
/** The discovery groups of a host as labelled chips (colour, letter, name), the one it is drawn in first. */
function methodsHtml(groups) {
  if (!groups) return '';
  return `<div class="dmeths" title="${escHtml(DM.MIXED_NOTE)}">${[...groups].map((g) => { const G = DM.groupInfo(g); return `<span class="dm" style="--c:${G.color}"><i aria-hidden="true">${G.short}</i>${G.label}</span>`; }).join('')}</div>`;
}
function closeCard() { if (S.hover) S.hover = null; else S.selection = null; infoKey = cardKey = ''; drawInfo(); }
function bindCard() {
  $('infoClose').onclick = closeCard;
  $('cardHead').onclick = () => $('info').classList.toggle('folded');
  $('info').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act, sel = cardSel(); if (!act || !sel) return;
    if (act === 'centre') centreOn(sel);
    else if (act === 'target') setTarget({ ...sel, name: infoOf(sel).title });
    else if (act === 'untarget') clearTarget();
    else if (act === 'night') playNight();
    else if (act === 'retry') ensureTable();
    else if (act === 'transit') { const t = nextTransits(sel)[+e.target.closest('[data-i]').dataset.i]; if (t) showTransit(sel, t); }
    cardKey = transitKey = ''; drawInfo();
  });
}

// ---------------------------------------------------------------- the target: search box, links from the planner
const BODIES = [['sun', 'Sun', 'the Sun'], ['moon', 'Moon', 'the Moon'], ...A.PLANETS.map((id) => [id, id[0].toUpperCase() + id.slice(1), 'planet of the solar system'])];
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Turn the view to a selection (not in AR, where the phone decides). */
function centreOn(sel) {
  compute(); const s = infoOf(sel); if (!s || !s.dir || S.ar) return;
  S.az = s.az * DEG; S.alt = clamp(s.alt * DEG, -89, 89);
  // on a phone the card is a sheet over the lower part of the sky: aim lower, so that the object is in the middle of what is left
  const dy = R.height / 2 - (TOP_CLEAR + (R.height - sheetHeight() - TOP_CLEAR) / 2);
  if (dy > 20) { R.setView(manualView(), S.fov * RAD); S.alt = clamp(S.alt - dy * R.pixelAngle * DEG, -89, 89); }
}
const TOP_CLEAR = 92, narrow = matchMedia('(max-width: 760px)');
/** Height of everything laid over the bottom of the sky: the bars and, on a phone, the card (assumed open to its full height unless folded). */
function sheetHeight() {
  const bars = document.querySelector('.sky-bar').offsetHeight + ($('nightBar').hidden ? 0 : $('nightBar').offsetHeight), card = $('info');
  if (!narrow.matches || !cardSel()) return bars;
  return bars + (card.classList.contains('folded') && !card.hidden ? card.offsetHeight : Math.max(card.hidden ? 0 : card.offsetHeight, 0.42 * window.innerHeight));
}
/** Mark an object: the reticle, the name and the track stay on it while the view is panned and the time changes. */
function setTarget(sel, { centre = true, keepTransit = false } = {}) {
  const { d, ...t } = sel; S.target = t; S.selection = t; S.hover = null; if (!keepTransit) S.transit = null;
  S.nightPlay = false; infoKey = cardKey = ''; $('info').classList.remove('folded');
  compute(); syncNightBar(); drawInfo();
  if (centre) { if (S.fov > 80) S.fov = 70; centreOn(t); }
}
function clearTarget() { S.target = null; S.transit = null; S.nightPlay = false; if ($('rate').value === 'night') { $('rate').value = '1'; S.rate = 1; } cardKey = ''; compute(); syncNightBar(); }
/** What the search box offers for a typed string: solar-system bodies, named stars, then hosts and planets. */
function suggestions(text) {
  const k = norm(text), out = []; if (!k) return out;
  for (const [id, name, what] of BODIES) if (norm(name).startsWith(k)) out.push({ label: name, sub: what, sel: { kind: 'body', id, name } });
  if (data.stars?.labelled) { let n = 0; for (const st of data.stars.labelled) if (st.proper && norm(st.proper).startsWith(k)) { out.push({ label: st.proper, sub: 'star' + (st.des ? ' · ' + st.des : ''), sel: { kind: 'star', i: st.i, name: st.proper } }); if (++n >= 4) break; } }
  if (data.cat) for (const c of data.cat.suggest(text, 9)) out.push({ label: c.label, sub: c.type === 'planet' ? `planet of ${c.host}` : c.type === 'alias' ? `host star ${c.host}` : 'host star', host: c.host, planet: c.planet });
  // TESS candidates: from hosts.json (the name index has the confirmed planets only)
  if (/^toi/.test(k) && data.candIndex) {
    const hits = [];
    for (const [name, i] of data.candIndex) if (norm(name).startsWith(k) && !out.some((o) => o.planet === name)) hits.push([name, i]);
    hits.sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0], 'en', { numeric: true }));
    for (const [name, i] of hits.slice(0, 6)) out.push({ label: name, sub: `TESS candidate · ${data.hosts.list[i][0]}`, host: data.hosts.list[i][0], planet: name });
  }
  return out.slice(0, 12);
}
async function chooseSuggestion(item, opts) {
  if (item.sel) return setTarget(item.sel, opts);
  await loadHosts(); const i = data.hostIndex.get(item.host);
  if (i == null) throw new Error(`${item.host} has no position in the host list`);
  setTarget({ kind: 'host', i, name: item.planet || item.host, planet: item.planet || null }, opts);
}
/** A name as typed or linked (planet, host, alias, star, solar-system body) -> the marked target. Rejects when unknown. */
async function resolveTarget(name, opts) {
  const k = norm(name), b = BODIES.find((x) => norm(x[1]) === k);
  if (b) return setTarget({ kind: 'body', id: b[0], name: b[1] }, opts);
  // a TESS candidate (TOI-1234.01) or a candidate star (TOI-1234): hosts.json knows them
  const toi = VIS.parseToi(name);
  if (toi) {
    await loadHosts(); const i = toi.planet ? data.candIndex.get(toi.planet) : data.hostIndex.get(toi.host);
    if (i != null) return setTarget({ kind: 'host', i, name: toi.planet || toi.host, planet: toi.planet }, opts);
  }
  await loadTargets(); const r = await data.cat.resolve(name);
  if (r) return chooseSuggestion(r, opts);
  const st = data.stars?.labelled?.find((x) => x.proper && norm(x.proper) === k);
  if (st) return setTarget({ kind: 'star', i: st.i, name: st.proper }, opts);
  throw new Error(`"${name}" is not a planet, host or bright star this page knows`);
}
function bindSearch() {
  const box = $('find'), inp = $('findInput'), list = $('findList'); let items = [], cur = -1;
  const render = () => {
    items = suggestions(inp.value); cur = items.length ? 0 : -1;
    list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" class="${i === cur ? 'cur' : ''}"><b>${escHtml(it.label)}</b><span>${escHtml(it.sub)}</span></li>`).join('') || (norm(inp.value) ? `<li class="none">${data.cat?.state.index ? 'Nothing by that name' : 'Loading names…'}</li>` : '');
    list.hidden = !list.innerHTML; box.setAttribute('aria-expanded', String(!list.hidden));
  };
  const mark = () => list.querySelectorAll('li[data-i]').forEach((li, i) => li.classList.toggle('cur', i === cur));
  const go = async (it) => {
    list.hidden = true; inp.blur();
    try { if (it) await chooseSuggestion(it); else await resolveTarget(inp.value); inp.value = ''; }
    catch (e) { setStatus(e.message, true); }
  };
  inp.addEventListener('focus', () => { loadTargets().then(() => data.cat.index()).then(render).catch((e) => setStatus('The name index could not be loaded: ' + e.message, true)); render(); });
  inp.addEventListener('input', render);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (items.length) { cur = (cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; mark(); } e.preventDefault(); }
    else if (e.key === 'Enter') { if (norm(inp.value)) go(items[cur]); e.preventDefault(); }
    else if (e.key === 'Escape') { list.hidden = true; inp.blur(); }
    e.stopPropagation();
  });
  list.addEventListener('pointerdown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); go(items[+li.dataset.i]); } });
  inp.addEventListener('blur', () => setTimeout(() => { list.hidden = true; box.setAttribute('aria-expanded', 'false'); }, 150));
}

// ---------------------------------------------------------------- the night scrubber
function syncNightBar() {
  const bar = $('nightBar'), show = targetReady(S.target) || S.nightPlay;
  if (bar.hidden === show) { bar.hidden = !show; resize(); nightKey = ''; }
}
function drawNight() {
  const n = data.night; if (!n || $('nightBar').hidden) return;
  const playing = $('rate').value === 'night' && S.playing, key = n.key + '|' + Math.round(S.time / 5000) + playing + $('nightCanvas').clientWidth;
  if (key === nightKey) return; nightKey = key;
  drawNightBar($('nightCanvas'), n, S.time, horizonRad);
  $('nightPlay').textContent = playing ? 'Pause' : 'Play the night'; $('nightPlay').classList.toggle('on', playing);
  const tr = n.transit, tw = n.twilight;
  $('nightLabel').innerHTML = tr ? `<b style="color:${eventInfo(tr.kind).color}">${eventInfo(tr.kind).title}</b> ${hhmm(tr.ingress)}–${hhmm(tr.egress)}${tr.err != null ? ` <small>± ${tr.err < 10 ? tr.err.toFixed(1) : tr.err.toFixed(0)} min</small>` : ''}`
    : n.polar ? 'no sunset and sunrise here on this date' : `Sunset ${hhmm(tw.sun.evening)} · sunrise ${hhmm(tw.sun.morning)}`;
}
function bindNight() {
  $('nightPlay').onclick = playNight;
  const c = $('nightCanvas'); let drag = false;
  const at = (e) => { const n = data.night; if (!n) return; const r = c.getBoundingClientRect(); setTime(n.t0 + clamp((e.clientX - r.left) / r.width, 0, 1) * (n.t1 - n.t0)); };
  c.addEventListener('pointerdown', (e) => { drag = true; try { c.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } at(e); });
  c.addEventListener('pointermove', (e) => { if (drag) at(e); });
  c.addEventListener('pointerup', () => { drag = false; }); c.addEventListener('pointercancel', () => { drag = false; });
}

// ---------------------------------------------------------------- the terrain horizon
async function ensureTerrain(asked) {
  const placeKey = () => `${S.lat.toFixed(3)},${S.lon.toFixed(3)},${S.eye},${S.elev}`, key = placeKey();
  if (data.horizonKey === key || data.horizonLoading === key) return;
  data.horizonLoading = key;
  try {
    const TM = await import('./terrain.js');
    // tiles are only fetched when the layer was switched on (or the place changed) in this visit; a layer left on
    // from last time uses the stored profile of the place, or goes off
    const elev = S.elev > 0 ? S.elev : null;
    if (!asked && !TM.cachedHorizon(S.lat, S.lon, S.eye, elev)) { S.layers.terrain = false; syncLayers(); return; }
    const p = await TM.loadHorizon(S.lat, S.lon, { eye: S.eye, elev, onProgress: (d, n) => setStatus(`Terrain: elevation tile ${d} of ${n}…`) });
    if (key !== placeKey() || !S.layers.terrain) return;
    data.horizon = p; data.horizonKey = key; R.setHorizon(p.alt); cardKey = ''; nightKeyReset();
    const hi = Math.max(...p.alt), lo = Math.min(...p.alt);
    setStatus(p.cached ? '' : `Terrain horizon from ${p.tiles} elevation tiles (${p.fromCache || 0} from this browser's cache) in ${(p.ms / 1000).toFixed(1)} s, out to ${Math.round((p.maxDist || 150000) / 1000)} km: between ${lo.toFixed(1)}° and ${hi.toFixed(1)}°${p.tilesFailed ? ` (${p.tilesFailed} tiles could not be loaded; their part is missing)` : ''}.`, true);
    const box = $('terrainSources');
    box.innerHTML = `<h3>Terrain data</h3><p class="note">Horizon from the ground at ${Math.round(p.ground)} m${elev && elev > p.ground - 1 ? ' (the site\'s stated elevation)' : ''}, your eye ${p.eye ?? S.eye} m above it, out to ${Math.round((p.maxDist || 150000) / 1000)} km, with the Earth's curvature and standard refraction (k = 0.13). Elevation tiles of the Mapzen / Tilezen terrain tiles, hosted in the AWS Open Data registry, kept in this browser after the first visit. Buildings and trees are not in them. Required attribution (<a href="${TM.ATTRIBUTION.url}" target="_blank" rel="noopener">source</a>):</p><ul>${TM.ATTRIBUTION.lines.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>`;
    $('terrainNote').hidden = false;
  } catch (e) {
    setStatus(`The terrain could not be loaded (${e.message}). The horizon stays flat.`, true); S.layers.terrain = false; syncLayers();
  } finally { if (data.horizonLoading === key) data.horizonLoading = ''; }
}
function dropTerrain() { if (data.horizon) { data.horizon = null; data.horizonKey = ''; R.setHorizon(null); cardKey = ''; } $('terrainNote').hidden = true; $('terrainSources').hidden = true; }

function pick(x, y, tol = 16, hostsOnly = false) {
  if (!F) return null;
  let best = null; const consider = (kind, ref, p, bias) => { if (!p) return; const d = Math.hypot(p[0] - x, p[1] - y) - bias; if (d < tol && (!best || d < best.d)) best = { d, kind, ...ref }; };
  if (hostsOnly) {
    if (!S.layers.hosts || !data.hosts) return null;
    let w = R.unproject(x, y); if (hidden(w)) return null;
    if (S.layers.atmosphere) { const h = altAzOf(w); w = dirOf(h.alt - A.refractionFromApparent(h.alt), h.az); }
    const v = toWorld(F.worldToJ2000, w), cosTol = Math.cos(tol * R.pixelAngle), pos = data.hosts.pos; let bi = -1, bc = cosTol;
    for (let i = 0; i < data.hosts.n; i++) { const c = pos[i * 3] * v[0] + pos[i * 3 + 1] * v[1] + pos[i * 3 + 2] * v[2]; if (c > bc && hostMagOf(i) <= data.hostLimit && hostGroup(i)) { bc = c; bi = i; } }
    return bi < 0 ? null : { kind: 'host', i: bi };
  }
  // the marked target can always be picked again, whatever layers are on
  if (targetReady(S.target)) { const ti = infoOf(S.target); if (ti && ti.dir) consider(S.target.kind, S.target, R.project(ti.dir), 16); if (best) { const { d, ...t } = best; return t; } }
  if (S.layers.planets) for (const b of [F.sun, F.moon, ...F.planets]) { if (hidden(b.dir)) continue; if ((b.id === 'uranus' || b.id === 'neptune') && b.mag > F.magLimit) continue; consider('body', { id: b.id }, R.project(b.dir), b.id === 'sun' ? F.sun.disc + 6 : b.id === 'moon' ? F.moon.disc + 6 : 8); }
  if (S.layers.satellites && F.sats) for (const s of F.sats) if (!hidden(s.dir)) consider('sat', { name: s.name }, R.project(s.dir), 3);
  if (best) return best;
  // stars and hosts: work in J2000, undoing refraction for the direction under the pointer
  let w = R.unproject(x, y); if (hidden(w)) return null;
  if (S.layers.atmosphere) { const h = altAzOf(w); w = dirOf(h.alt - A.refractionFromApparent(h.alt), h.az); }
  const v = toWorld(F.worldToJ2000, w), cosTol = Math.cos(tol * R.pixelAngle * 2 / (1 + (R.project(w)?.[2] ?? 1)));
  const scan = (pos, n, ok, weight) => { let bi = -1, bs = Infinity; for (let i = 0; i < n; i++) { const c = pos[i * 3] * v[0] + pos[i * 3 + 1] * v[1] + pos[i * 3 + 2] * v[2]; if (c < cosTol || !ok(i)) continue; const s = Math.acos(Math.min(1, c)) / Math.acos(cosTol) + weight(i); if (s < bs) { bs = s; bi = i; } } return bi < 0 ? null : { i: bi, s: bs }; };
  const st = data.stars && scan(data.stars.pos, data.stars.n, (i) => data.stars.mag[i] <= F.magLimit, (i) => 0.12 * data.stars.mag[i]);
  const ho = S.layers.hosts && data.hosts && scan(data.hosts.pos, data.hosts.n, (i) => hostMagOf(i) <= data.hostLimit && !!hostGroup(i), () => 0.3);
  if (ho && (!st || ho.s < 0.75)) return { kind: 'host', i: ho.i };
  return st ? { kind: 'star', i: st.i } : null;
}

// ---------------------------------------------------------------- time
const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localInput = (ms) => { const d = new Date(ms); return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
let lastReadout = '';
function drawReadout() {
  const d = new Date(S.time), off = -d.getTimezoneOffset(), tz = 'UTC' + (off >= 0 ? '+' : '−') + (Math.abs(off) % 60 ? `${Math.floor(Math.abs(off) / 60)}:${pad(Math.abs(off) % 60)}` : Math.floor(Math.abs(off) / 60));
  const key = Math.floor(S.time / 1000) + '|' + S.playing + S.live + S.rate + (F ? A.twilight(F.sunAlt) : '');
  if (key === lastReadout) return; lastReadout = key;
  $('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('date').textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${tz}`;
  const tw = F ? { day: 'day', civil: 'civil twilight', nautical: 'nautical twilight', astronomical: 'astronomical twilight', night: 'night' }[A.twilight(F.sunAlt)] : '';
  $('utc').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC${tw ? ' · ' + tw : ''}`;
  $('play').innerHTML = S.playing ? ICON('<path d="M8 5v14M16 5v14"/>') : ICON('<path d="M7 4l13 8-13 8z" fill="currentColor"/>');
  $('play').title = S.playing ? 'Pause' : 'Play'; $('now').classList.toggle('on', S.live);
  if (document.activeElement !== $('dt')) $('dt').value = localInput(S.time);
  if (document.activeElement !== $('tod')) $('tod').value = d.getHours() * 60 + d.getMinutes();
}
function setTime(ms, keepLive) { S.time = ms; if (!keepLive) S.live = false; }

// ---------------------------------------------------------------- UI wiring
function syncLayers() {
  for (const b of document.querySelectorAll('.layer')) { const on = !!S.layers[b.dataset.layer]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  store.set('esl.sky.layers', S.layers);
  if ($('discBtn').hidden === S.layers.hosts) { $('discBtn').hidden = !S.layers.hosts; if (!S.layers.hosts) togglePanel('discPanel', false); requestAnimationFrame(resize); }
  if (S.layers.hosts) { loadHosts().catch(() => {}); if (layersAsked) ensureTable(); }
  if (S.layers.satellites) loadSats();
  if (S.layers.terrain) ensureTerrain(layersAsked); else dropTerrain();
}
let layersAsked = false;      // false while the stored layers are applied at start, true for the user's own switches
function buildUI() {
  const bar = $('layers');
  for (const [id, label, title, icon] of LAYERS) {
    const b = document.createElement('button'); b.className = 'layer'; b.dataset.layer = id; b.title = title; b.innerHTML = ICON(icon) + `<span>${label}</span>`;
    b.onclick = () => toggleLayer(id);
    bar.append(b);
  }
  syncLayers(); layersAsked = true;
  bindCard(); bindSearch(); bindNight(); bindTonight(); bindDisc(); bindLegend(); bindVisible();
  $('terrainMore').onclick = () => { const b = $('terrainSources'); b.hidden = !b.hidden; $('terrainMore').setAttribute('aria-expanded', String(!b.hidden)); };
  $('back').innerHTML = ICON('<path d="M15 5l-7 7 7 7"/>'); $('fwd').innerHTML = ICON('<path d="M9 5l7 7-7 7"/>');
  $('back').onclick = () => setTime(S.time - S.step); $('fwd').onclick = () => setTime(S.time + S.step);
  $('play').onclick = () => { S.playing = !S.playing; if (!S.playing) S.live = false; };
  $('now').onclick = () => { S.time = Date.now(); S.rate = 1; $('rate').value = '1'; S.playing = true; S.live = true; S.nightPlay = false; };
  $('rate').onchange = (e) => { if (e.target.value === 'night') { playNight(true); return; } S.rate = +e.target.value; S.playing = true; S.nightPlay = false; if (S.rate !== 1) S.live = false; };
  $('step').onchange = (e) => { S.step = +e.target.value; };
  $('dt').onchange = (e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) setTime(t); };
  $('tod').oninput = (e) => { const d = new Date(S.time); d.setHours(0, +e.target.value, d.getSeconds(), 0); setTime(d.getTime()); };
  // the readout: drag sideways to scrub (one minute per pixel), tap to open the time panel
  const ro = $('readout'); let drag = null;
  ro.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, t: S.time, moved: false }; try { ro.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } });
  ro.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true; if (drag.moved) { setTime(drag.t + dx * 60000); ro.classList.add('scrub'); } });
  const end = () => { if (drag && !drag.moved) togglePanel('timePanel'); drag = null; ro.classList.remove('scrub'); };
  ro.addEventListener('pointerup', end); ro.addEventListener('pointercancel', () => { drag = null; ro.classList.remove('scrub'); });
  ro.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel('timePanel'); } });

  // location
  $('locBtn').onclick = () => togglePanel('locPanel');
  $('locSave').onclick = () => { const la = parseFloat($('lat').value), lo = parseFloat($('lon').value), ey = parseFloat($('eye').value); if (!(Math.abs(la) <= 90) || !(Math.abs(lo) <= 180)) { $('locMsg').textContent = 'Latitude must be within ±90 and longitude within ±180 degrees.'; return; } if (Number.isFinite(ey) && ey !== S.eye) { S.eye = clamp(ey, 0, 500); store.set('esl.sky.eye', S.eye); } setLocation(la, lo); togglePanel('locPanel', false); };
  $('eye').onchange = (e) => setEye(parseFloat(e.target.value));
  $('locGeo').onclick = () => {
    if (!navigator.geolocation) { $('locMsg').textContent = 'This browser has no geolocation.'; return; }
    $('locMsg').textContent = 'Asking the browser for your position…';
    navigator.geolocation.getCurrentPosition((p) => { setLocation(+p.coords.latitude.toFixed(4), +p.coords.longitude.toFixed(4)); $('locMsg').textContent = `Set from the browser (accuracy about ${Math.round(p.coords.accuracy)} m).`; },
      (err) => { $('locMsg').textContent = 'The browser did not give a position (' + err.message + '). Type the coordinates instead.'; }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  };
  showLocation();

  // AR
  const canAR = ar.supported && (matchMedia('(pointer: coarse)').matches || q.has('ar'));
  $('arBtn').hidden = !canAR;
  $('arBtn').onclick = async () => {
    if (S.ar) { stopAR(); return; }
    try { await ar.start(); S.ar = true; S.fov = Math.min(S.fov, 75); $('arBtn').classList.add('on'); $('arBar').hidden = false; updateCalib();
      setTimeout(() => { if (S.ar && !ar.state.events) setStatus('No orientation data is arriving from this device.', true); }, 2500);
    } catch (e) { setStatus(e.message, true); }
  };
  $('arExit').onclick = stopAR;

  // WebXR: the buttons exist only where the browser offers that kind of session
  // WebXR: the VR button is always there and says why when it cannot work; passthrough only where the device has it
  let xrSupport = null;
  xr.supported().then((sup) => { xrSupport = sup; $('ptBtn').hidden = !sup.ar; $('vrBtn').classList.toggle('off', !sup.vr); $('vrBtn').title = sup.vr ? 'Stand inside the sky in a VR headset: point, pull the trigger, use the thumbstick for time' : sup.message.vr; resize(); });
  const immersive = (kind) => async () => {
    if (xrSupport && !xrSupport[kind]) { setStatus(xrSupport.message[kind] + (kind === 'vr' && ar.supported && matchMedia('(pointer: coarse)').matches ? ' On this phone, try AR: the sky follows where it points.' : ''), true); return; }
    if (S.ar) stopAR();       // the phone's own AR view and a WebXR session do not run together
    try { await xr.start(kind, S.az * RAD); }
    catch (e) { setStatus(`The ${kind === 'ar' ? 'passthrough' : 'VR'} session could not start (${e.message}).`, true); }
  };
  $('vrBtn').onclick = immersive('vr'); $('ptBtn').onclick = immersive('ar'); $('xrExit').onclick = () => xr.stop();
  $('arReset').onclick = () => { ar.resetCalibration(); setStatus('Compass calibration cleared.', true); };
}
function stopAR() { ar.stop(); S.ar = false; S.alt = clamp(S.alt, -89, 89); $('arBtn').classList.remove('on'); $('arBar').hidden = true; }
function calibTargets() {
  if (!F) return [];
  const out = [{ name: 'Sun', az: F.sun.az, alt: F.sun.alt }, { name: 'Moon', az: F.moon.az, alt: F.moon.alt }];
  for (const [name, [ra, dec]] of Object.entries(CALIB_STARS)) out.push({ name, ...altAzOf(toWorld(F.j2000ToWorld, A.sphToVec(ra * RAD, dec * RAD))) });
  const s = selectionInfo(); if (s && s.dir && !out.some((o) => o.name === s.title)) out.push({ name: s.title, az: s.az, alt: s.altTrue });
  return out;
}
let calibKey = '';
function updateCalib() {
  const t = calibTargets(), key = t.map((o) => o.name + (o.alt > 0)).join('|'); if (key === calibKey) return; calibKey = key;
  const box = $('arTargets'); box.innerHTML = '';
  for (const o of t) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = o.name; b.disabled = o.alt <= 0; b.title = o.alt <= 0 ? 'Below the horizon now' : `Point the cross at ${o.name}, then tap`;
    b.onclick = () => { const cur = calibTargets().find((x) => x.name === o.name); if (cur && ar.calibrate(cur.az)) setStatus(`Compass set on ${o.name}: offset ${(ar.state.userOffset * DEG).toFixed(1)}°.`, true); }; box.append(b); }
}
function togglePanel(id, on) {
  for (const p of ['locPanel', 'timePanel', 'tonightPanel', 'discPanel', 'visPanel']) { const el = $(p); el.hidden = p === id ? (on === undefined ? !el.hidden : !on) : true; }
  $('discBtn').setAttribute('aria-expanded', String(!$('discPanel').hidden)); $('visBtn').setAttribute('aria-expanded', String(!$('visPanel').hidden)); $('visBtn').classList.toggle('on', !$('visPanel').hidden);
}
function setLocation(lat, lon) { S.lat = lat; S.lon = lon; S.elev = 0; S.hasLocation = true; store.set('esl.sky.location', { lat, lon }); showLocation(); if (S.layers.terrain) { dropTerrain(); ensureTerrain(true); } }
function setEye(m) { S.eye = clamp(Number.isFinite(m) ? m : 2, 0, 500); store.set('esl.sky.eye', S.eye); if (S.layers.terrain) { dropTerrain(); ensureTerrain(true); } }
/** The track of the target is drawn against the horizon: redo it when the horizon changes. */
function nightKeyReset() { if (data.night) data.night.key = ''; }
function showLocation() {
  const f = (v, p, n) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? p : n}`;
  $('locBtn').querySelector('span').textContent = S.hasLocation ? `${f(S.lat, 'N', 'S')} ${f(S.lon, 'E', 'W')}` : 'Greenwich (set your location)';
  $('lat').value = S.lat; $('lon').value = S.lon; $('eye').value = S.eye;
}

// pointer control of the view: drag to pan, wheel or pinch to zoom, tap to select
function bindView() {
  const pts = new Map(); let pinch = null, tap = null;
  const zoom = (k) => { S.fov = clamp(S.fov * k, 1.5, 140); };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target !== gl && e.target !== labels) return;
    togglePanel(null); try { wrap.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: S.fov }; tap = null; }
  });
  // desktop: the card of the host under the mouse (after a short dwell, so that crossing the field does not flicker)
  let hoverTimer = 0;
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons || pts.size || !S.layers.hosts || !data.hosts || (e.target !== gl && e.target !== labels)) return;
    const r = gl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { const h = pick(x, y, 12, true); if (h && selKey(h) !== selKey(cardSel())) { S.hover = h; infoKey = cardKey = ''; drawInfo(); } }, 90);
  });
  wrap.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
    if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; S.fov = clamp(pinch.fov * pinch.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), 1.5, 140); return; }
    if (S.ar || tap) return;
    S.follow = false;       // the user's hand on the sky ends the following
    const k = R.pixelAngle * DEG; S.az = (S.az - dx * k / Math.max(0.25, Math.cos(S.alt * RAD)) + 360) % 360; S.alt = clamp(S.alt + dy * k, -89.9, 89.9);
  });
  const up = (e) => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (tap && performance.now() - tap.t < 600) {
      const r = gl.getBoundingClientRect(), x = tap.x - r.left, y = tap.y - r.top;
      if (offArrow && Math.hypot(x - offArrow.x, y - offArrow.y) < 60) { centreOn(S.target); S.selection = S.target; }
      else S.selection = pick(x, y, tap.type === 'touch' ? 26 : 16);
      S.hover = null; clearTimeout(hoverTimer); infoKey = cardKey = ''; drawInfo();
    }
    tap = null;
  };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = null; tap = null; });
  wrap.addEventListener('wheel', (e) => { if (e.target !== gl && e.target !== labels) return; e.preventDefault(); zoom(Math.exp(clamp(e.deltaY, -120, 120) * 0.0016)); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'INPUT') { S.selection = null; S.hover = null; togglePanel(null); infoKey = cardKey = ''; drawInfo(); return; }
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName || '')) return;
    const k = S.fov / 12;
    if (e.key === 'ArrowLeft') S.az = (S.az - k + 360) % 360; else if (e.key === 'ArrowRight') S.az = (S.az + k) % 360;
    else if (e.key === 'ArrowUp') S.alt = clamp(S.alt + k, -89.9, 89.9); else if (e.key === 'ArrowDown') S.alt = clamp(S.alt - k, -89.9, 89.9);
    else if (e.key === '+' || e.key === '=') zoom(0.85); else if (e.key === '-') zoom(1 / 0.85);
    else if (e.key === ']') adjustMag(0.5); else if (e.key === '[') adjustMag(-0.5);
    else if (e.key === 'n') cycleTarget(1); else if (e.key === 'p') cycleTarget(-1);
    else if (e.key === ' ') $('play').click(); else if (e.key === 'Escape') { S.selection = null; S.hover = null; togglePanel(null); } else return;
    e.preventDefault();
  });
}

// ---------------------------------------------------------------- what a controller can do, and the page too
// Everything the immersive mode does goes through these functions, and so do the page's own controls (the Tonight
// panel, the card, the keys), so that a mouse, a finger and a controller reach the same actions.

/** The object under a world direction (a controller's ray, the gaze): { sel, dir, name } or null. tol in radians. */
function pickDir(w, tol = 1.6 * RAD) {
  if (!F) return null;
  const found = (sel) => { const s = infoOf(sel); return s && s.dir ? { sel, dir: s.dir, name: s.title } : null; };
  const cands = [];
  if (targetReady(S.target)) { const ti = infoOf(S.target); if (ti && ti.dir) cands.push({ dir: ti.dir, bias: 0.4 * tol, sel: S.target }); }
  if (S.layers.planets) for (const b of [F.sun, F.moon, ...F.planets]) { if (hidden(b.dir) || ((b.id === 'uranus' || b.id === 'neptune') && b.mag > F.magLimit)) continue; cands.push({ dir: b.dir, bias: b.radius > 0 ? b.radius : 0.25 * tol, sel: { kind: 'body', id: b.id } }); }
  if (S.layers.satellites && F.sats) for (const s of F.sats) if (!hidden(s.dir)) cands.push({ dir: s.dir, bias: 0, sel: { kind: 'sat', name: s.name } });
  const c = X.pickCandidates(w, cands, tol); if (c) return found(c.sel);
  if (hidden(w)) return null;
  // stars and hosts: in J2000, undoing refraction for the direction pointed at
  let u = w; if (S.layers.atmosphere) { const h = altAzOf(w); u = dirOf(h.alt - A.refractionFromApparent(h.alt), h.az); }
  const v = toWorld(F.worldToJ2000, u);
  const st = data.stars && X.scanCatalog(v, data.stars.pos, data.stars.n, tol, (i) => data.stars.mag[i] <= F.magLimit, (i) => 0.12 * data.stars.mag[i]);
  const ho = S.layers.hosts && data.hosts && X.scanCatalog(v, data.hosts.pos, data.hosts.n, tol, (i) => hostMagOf(i) <= data.hostLimit && !!hostGroup(i), () => 0.3);
  if (ho && (!st || ho.s < 0.75)) return found({ kind: 'host', i: ho.i });
  return st ? found({ kind: 'star', i: st.i }) : null;
}
const sig = (e) => (e ? (e[0] + e[1]) / 2 : 0), jdToMs = (jd) => (jd - 2440587.5) * 86400000;
/**
 * The next transit of each transiting planet of a host star after the time shown (one in progress counts), from
 * the linear ephemeris of the planet table: [{ planet, ingress, mid, egress (Unix ms), err (minutes, 1 sigma, or
 * null), alt, az (radians at mid, airless), up, sun (degrees at mid) }], soonest first. Empty until the table is loaded.
 */
function nextTransits(sel) {
  if (!sel || sel.kind !== 'host' || !data.hosts) return [];
  const h0 = data.hosts.list[sel.i], jd = O.jdFromDate(S.time), lat = S.lat * RAD, lon = S.lon * RAD, out = [];
  // the confirmed planets (from the planet table, when it is loaded) and the TESS candidates (from hosts.json)
  const rows = (data.cat && data.cat.state.table === 'ready' ? data.cat.rowsOfHost(h0[0]) || [] : []).map((r) => ({ name: r.name, v: r.v, e: r.e }))
    .concat(VIS.candidatesOf(h0).map((c) => ({ name: c.name, candidate: true, v: { transit: true, per: c.per, tmid: c.tmid, t14: c.t14 }, e: { per: c.perErr ? [c.perErr, c.perErr] : null, tmid: c.tmidErr ? [c.tmidErr, c.tmidErr] : null } })));
  for (const r of rows) {
    const v = r.v; if (!v.transit || !(v.per > 0) || !Number.isFinite(v.tmid)) continue;
    const half = (v.t14 > 0 ? v.t14 : 0) / 2, hasErr = !!(r.e.per && r.e.tmid);
    for (const tr of O.transitsBetween({ per: v.per, tmid: v.tmid, perErr: sig(r.e.per), tmidErr: sig(r.e.tmid) }, jd - half - 0.02, jd + v.per + half + 0.02)) {
      const mid = O.bjdTdbToJdUtc(tr.tmid, h0[1], h0[2]); if (mid + half < jd) continue;
      const ms = jdToMs(mid), h = altAzAt(sel, ms);
      out.push({ planet: r.name, candidate: !!r.candidate, ingress: jdToMs(mid - half), mid: ms, egress: jdToMs(mid + half), err: hasErr ? tr.sigma * 1440 : null, alt: h.alt, az: h.az, up: h.alt > horizonRad(h.az), sun: A.sunAltitude(ms, lat, lon, S.elev) * DEG });
      break;
    }
  }
  return out.sort((a, b) => a.mid - b.mid);
}
const dayOf = (ms) => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const transitWords = (t) => `${dayOf(t.ingress)} ${hhmm(t.ingress)}–${hhmm(t.egress)}`;
const skyWords = (t) => (t.up ? `${(t.alt * DEG).toFixed(0)}° up` : 'below the horizon') + ' · ' + (t.sun > -0.833 ? 'Sun up' : t.sun > -12 ? 'twilight' : 'dark');
/** Mark a planet's host and show one of its transits: the track, the window on it, the clock at mid-transit. */
function showTransit(sel, t) {
  setTarget({ kind: 'host', i: sel.i, name: t.planet, planet: t.planet }, { keepTransit: true, centre: !xr.presenting });
  S.transit = { ingress: t.ingress, mid: t.mid, egress: t.egress, err: t.err, kind: 'transit' }; S.time = t.mid; S.live = false; S.playing = false; S.nightPlay = false;
  if ($('rate').value === 'night') { $('rate').value = '1'; S.rate = 1; }
  cardKey = infoKey = ''; compute(); if (!xr.presenting) centreOn(S.target);
}

// Tonight: the transits that can be watched from here in the night the clock is in. The planner (/plan/) is the
// place for a real search; this is its short list, by the same function (findObservableTransits).
const TONIGHT = { minAlt: 30, sunLimit: -12, magMax: 13, show: 6 };
const tonight = { key: '', status: 'idle', events: [], error: '', n: 0 };
async function loadTonight() {
  const lat = S.lat * RAD, lon = S.lon * RAD, w = nightWindow(S.time, lat, lon, S.elev, null), key = [S.lat.toFixed(2), S.lon.toFixed(2), Math.round(w.t0 / 600000), S.disc].join('|'), disc = S.disc;
  if (tonight.key === key && tonight.status !== 'error') return;
  Object.assign(tonight, { key, status: 'loading', events: [], error: '' }); tonightKey = '';
  try {
    await Promise.all([loadHosts(), loadTargets().then(() => data.cat.table())]);
    if (tonight.key !== key) return;
    const targets = [];
    for (const [host, rows] of data.cat.state.byHost) {
      const hi = data.hostIndex.get(host); if (hi == null) continue;
      for (const r of rows) {
        const v = r.v, mag = Number.isFinite(v.vmag) ? v.vmag : v.gmag;
        if (!DM.planetShown(v, disc)) continue;       // the discovery filter, planet by planet
        if (!v.transit || !(v.per > 0) || !Number.isFinite(v.tmid) || !(v.t14 > 0) || !Number.isFinite(v.ra) || !Number.isFinite(v.dec) || !(mag <= TONIGHT.magMax)) continue;
        targets.push({ name: r.name, hi, ra: v.ra, dec: v.dec, per: v.per, tmid: v.tmid, perErr: sig(r.e.per), tmidErr: sig(r.e.tmid), hasErr: !!(r.e.per && r.e.tmid), t14: v.t14, mag, band: Number.isFinite(v.vmag) ? 'V' : 'G', depth: v.depth });
      }
    }
    // the TESS candidates (hosts.json), by their TESS magnitude
    if (disc.includes('c')) data.hosts.list.forEach((h, hi) => {
      const mag = VIS.hostMag(h); if (!h[6] || !(mag <= TONIGHT.magMax)) return;
      for (const c of VIS.candidatesOf(h)) if (c.per > 0 && Number.isFinite(c.tmid) && c.t14 > 0) targets.push({ ...c, hi, ra: h[1], dec: h[2], mag, band: VIS.hostBand(h) });
    });
    const ev = O.findObservableTransits(targets, { lat: S.lat, lon: S.lon, elev: S.elev }, { jd0: O.jdFromDate(w.t0), jd1: O.jdFromDate(w.t1), minAlt: TONIGHT.minAlt, sunLimit: TONIGHT.sunLimit, include: 'transit' });
    tonight.n = ev.length;
    tonight.events = ev.sort((a, b) => b.score.total - a.score.total).slice(0, TONIGHT.show).sort((a, b) => a.mid - b.mid)
      .map((e) => ({ planet: e.target.name, candidate: !!e.target.candidate, i: e.target.hi, ingress: jdToMs(e.ingress), mid: jdToMs(e.mid), egress: jdToMs(e.egress), err: e.target.hasErr ? e.sigma * 1440 : null, alt: e.altMid * RAD, mag: e.target.mag, band: e.target.band, depth: e.target.depth, score: e.score.total }));
    tonight.status = 'ready';
  } catch (e) { if (tonight.key === key) { tonight.status = 'error'; tonight.error = String(e && e.message || e); } }
  tonightKey = '';
}
const tonightNote = () => (tonight.status === 'loading' ? 'Looking through the planet table for tonight’s transits…' : tonight.status === 'error' ? `The planet table could not be loaded (${tonight.error}).`
  : tonight.status === 'ready' && !tonight.events.length ? `No transit of a star brighter than magnitude ${TONIGHT.magMax} can be watched whole from here tonight.` : '');
/** What "next" and "previous" step through: tonight's transits, then the Moon and the planets that are up. */
function targetList() {
  const out = tonight.events.map((e) => ({ key: 'tn:' + e.planet, name: e.planet, go: () => showTransit({ kind: 'host', i: e.i }, e) }));
  if (F) for (const b of [F.moon, ...F.planets]) if (b.alt > 0 && !((b.id === 'uranus' || b.id === 'neptune'))) out.push({ key: 'body:' + b.id, name: b.name, go: () => setTarget({ kind: 'body', id: b.id, name: b.name }, { centre: !xr.presenting }) });
  return out;
}
const targetKey = () => (!S.target ? null : S.target.kind === 'body' ? 'body:' + S.target.id : S.target.planet ? 'tn:' + S.target.planet : null);
function cycleTarget(step) { const l = targetList(), i = X.cycle(l.map((x) => x.key), targetKey(), step); if (i >= 0) l[i].go(); }
function adjustMag(d) { S.magOffset = clamp(S.magOffset + d, -4, 3); const el = $('magOffset'); if (el && document.activeElement !== el) el.value = S.magOffset; }
function toggleLayer(id) {
  S.layers[id] = !S.layers[id]; if (id === 'terrain' && S.layers.terrain) S.layers.ground = true; if (id === 'ground' && !S.layers.ground) S.layers.terrain = false;
  syncLayers(); if (id === 'satellites' && S.layers.satellites && data.sats) setStatus(data.satNote, true);
}
const STEPS = { 't-1h': -3600e3, 't-10m': -600e3, 't+10m': 600e3, 't+1h': 3600e3 };
/** One action by name: the buttons of the immersive menu and card, and of the Tonight panel. */
function act(id) {
  const sel = S.selection;
  if (id === 'night') playNight(); else if (id === 'play') $('play').click(); else if (id === 'now') $('now').click();
  else if (id in STEPS) setTime(S.time + STEPS[id]);
  else if (id === 'prev' || id === 'next') cycleTarget(id === 'next' ? 1 : -1);
  else if (id === 'showTarget') { if (S.target) { S.selection = S.target; S.hover = null; if (!xr.presenting) centreOn(S.target); } }
  else if (id.startsWith('tn:')) { const e = tonight.events[+id.slice(3)]; if (e) showTransit({ kind: 'host', i: e.i }, e); }
  else if (id.startsWith('layer:')) toggleLayer(id.slice(6));
  else if (id === 'mag+' || id === 'mag-') adjustMag(id === 'mag+' ? 0.5 : -0.5);
  else if (id === 'mark') { if (sel && infoOf(sel)) setTarget({ ...sel, name: infoOf(sel).title }, { centre: !xr.presenting }); }
  else if (id === 'unmark') clearTarget();
  else if (id === 'close') { S.selection = null; S.hover = null; }
  else if (id === 'nextTransit') { const t = nextTransits(sel)[0]; if (t) showTransit(sel, t); }
  else if (id.startsWith('disc:')) { const g = id.slice(5); setDiscoveryFilter(S.disc.includes(g) ? S.disc.replace(g, '') : S.disc + g); }
  else if (id.startsWith('vis:')) showHost(+id.slice(4));
  else if (id === 'simbad') { const s = infoOf(sel); if (s && s.host) window.open(DM.simbadUrl(s.host), '_blank', 'noopener'); }
  cardKey = infoKey = tonightKey = '';
}
/** Objects to set the compass on, in a headset: those that are well up and easy to find in the real sky. */
function alignTargets() {
  if (!F) return [];
  const out = [], add = (name, h) => { if (h.alt > 5 * RAD && h.alt < 80 * RAD && !out.some((o) => o.name === name)) out.push({ name, az: h.az, alt: h.alt }); };
  const s = infoOf(S.selection); if (s && s.dir) add(s.title, { az: s.az, alt: s.alt });
  add('Moon', { az: F.moon.az, alt: F.moon.altApp });
  for (const id of ['venus', 'jupiter', 'saturn', 'mars']) { const b = F.planets.find((p) => p.id === id); if (b) add(b.name, { az: b.az, alt: b.altApp }); }
  for (const name of ['Sirius', 'Vega', 'Arcturus', 'Capella', 'Rigel', 'Canopus', 'Polaris']) { const st = data.stars?.labelled?.find((x) => x.proper === name); if (st) add(name, altAzOf(toWorld(F.j2000ToWorld, [data.stars.pos[st.i * 3], data.stars.pos[st.i * 3 + 1], data.stars.pos[st.i * 3 + 2]]))); }
  add('Sun', { az: F.sun.az, alt: F.sun.altApp });
  return out;
}
const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
/** The card of the selection for the immersive view: the content of the page's card as text, and its buttons. */
function xrCard() {
  const sel = S.selection, s = infoOf(sel); if (!s) return null;
  const isTarget = selKey(sel) === selKey(S.target), kv = s.rows.map(([k, v]) => [plain(k), plain(v)]), notes = [], rows = [];
  let sub = s.sub;
  if (s.host) {
    const cat = data.cat, table = !s.planets ? 'none' : data.tableError ? 'error' : cat ? cat.state.table : 'idle', pl = table === 'ready' ? cat.rowsOfHost(s.host) : null;
    if (table === 'idle') ensureTable();
    const r0 = pl && pl[0], mags = r0 ? [['vmag', 'V'], ['gmag', 'G'], ['tmag', 'T'], ['jmag', 'J'], ['kmag', 'K']].filter(([k]) => Number.isFinite(r0.v[k])).map(([k, n]) => `${n} ${r0.v[k].toFixed(2)}`) : [];
    if (!mags.length && s.vmag != null) mags.push(`V ${s.vmag.toFixed(2)}`);
    if (s.tmag != null && !mags.some((m) => m.startsWith('T '))) mags.push(`T ${s.tmag.toFixed(2)}`);
    if (mags.length) kv.push(['Magnitudes', mags.join(' · ')]);
    if (s.groups) kv.push(['Discovered by', [...s.groups].map((g) => DM.groupInfo(g).label).join(', ')]);
    if (pl && data.T) { const line = plain(data.T.starLine(pl) || ''); if (line) sub += ' · ' + line; }
    if (table === 'loading' || table === 'idle') notes.push('Loading the planets of this star…');
    else if (table === 'error') notes.push({ text: `The planet table could not be loaded (${data.tableError}).`, color: '#ffb454' });
    else if (pl) for (const r of pl.slice(0, 4)) { const G = DM.groupInfo(r.v.method); notes.push({ text: `${r.name} [${G.short}, ${G.label.toLowerCase()}]: period ${r.v.per > 0 ? r.v.per.toFixed(r.v.per < 100 ? 4 : 1) + ' d' : 'unknown'}${r.v.t14 > 0 ? `, transit ${(r.v.t14 * 24).toFixed(1)} h` : ''}${r.v.depth > 0 ? `, depth ${(r.v.depth * 100).toFixed(2)}%` : ''}`, color: G.color }); }
    if (pl && pl.length > 4) notes.push(`and ${pl.length - 4} more: the page's card lists them all.`);
    for (const c of s.cands.slice(0, pl && pl.length ? 2 : 4)) notes.push({ text: `${c.name} [TOI, TESS candidate${c.disposition ? ' ' + c.disposition : ''}, not confirmed]: period ${c.per > 0 ? c.per.toFixed(4) + ' d' : 'unknown'}${c.t14 > 0 ? `, transit ${(c.t14 * 24).toFixed(1)} h` : ''}${c.depth > 0 ? `, depth ${(c.depth * 1000).toFixed(1)} ppt` : ''}`, color: '#ffffff' });
  }
  if (s.dir) kv.push([S.layers.atmosphere ? 'Altitude (apparent)' : 'Altitude', dms(s.alt)], ['Azimuth', `${(s.az * DEG).toFixed(2)}° ${compass(s.az * DEG)}`], ['RA', hms(s.ra)], ['Dec', dms(s.dec)]);
  if (s.dir && s.alt < horizonRad(s.az)) notes.push({ text: 'Below the horizon now.', color: '#ffb454' });
  const nx = nextTransits(sel);
  if (isTarget && S.transit) {
    const tr = S.transit, at = (t) => { const h = altAzAt(sel, t); return `${(h.alt * DEG).toFixed(0)}°`; };
    const E = eventInfo(tr.kind), w = E.rows.map((x) => x.toLowerCase());
    notes.push({ text: `This ${E.word}, ${dayOf(tr.mid)}: ${w[0]} ${hhmm(tr.ingress)} (${at(tr.ingress)}), ${w[1]} ${hhmm(tr.mid)} (${at(tr.mid)}), ${w[2]} ${hhmm(tr.egress)} (${at(tr.egress)})${tr.err != null ? `, ± ${tr.err.toFixed(tr.err < 10 ? 1 : 0)} min` : ''}. Local time, ${tzLabel(tr.mid)}.`, color: tr.kind && tr.kind !== 'transit' ? E.color : '#bfeaff' });
  } else for (const t of nx.slice(0, 3)) notes.push({ text: `Next transit of ${t.planet}: ${transitWords(t)}, ${skyWords(t)}${t.err != null ? `, ± ${t.err.toFixed(t.err < 10 ? 1 : 0)} min` : ''}.`, color: '#bfeaff' });
  const night = $('rate').value === 'night' && S.playing;
  if (isTarget) rows.push([{ id: 'night', label: night ? 'Pause' : 'Play the night', on: night }, { id: 'unmark', label: 'Unmark' }]);
  else if (sel.kind !== 'sat' && s.dir) rows.push([{ id: 'mark', label: 'Mark and follow' }, ...(nx.length ? [{ id: 'nextTransit', label: 'Show next transit' }] : [])]);
  rows.push([...(s.host ? [{ id: 'simbad', label: 'SIMBAD (new tab)' }] : []), { id: 'close', label: 'Close' }]);
  return { key: selKey(sel), type: s.type, title: s.title, sub, kv, notes, rows };
}
const LAYER_SHORT = { constellations: 'Lines', labels: 'Names', azgrid: 'Alt-az grid', eqgrid: 'Equatorial', ground: 'Ground', terrain: 'Terrain', satellites: 'Satellites', hosts: 'Exoplanets', planets: 'Solar system', altlimit: '30° limit', atmosphere: 'Atmosphere' };
/** The menu of the immersive view. x: the state of the session (xr.js): grip mode, alignment, whether the menu is folded. */
function xrMenu(x) {
  if (!x.menuOpen) return { rows: [[{ id: 'xr:show', label: 'Menu' }]] };
  if (tonight.status === 'idle') loadTonight();
  const d = new Date(S.time), night = $('rate').value === 'night' && S.playing, tw = F ? { day: 'day', civil: 'civil twilight', nautical: 'nautical twilight', astronomical: 'astronomical twilight', night: 'night' }[A.twilight(F.sunAlt)] : '';
  const cap = (label) => Object.assign([{ label }], { h: 30 }), layer = (id) => ({ id: 'layer:' + id, label: LAYER_SHORT[id], on: !!S.layers[id] });
  const rows = [
    [{ id: 'night', label: night ? 'Pause the night' : 'Play the night', on: night, span: 2 }, { id: 'play', label: S.playing ? 'Pause' : 'Play', on: !S.playing }, { id: 'now', label: 'Now', on: S.live }, { id: 't-1h', label: '− 1 h' }, { id: 't+1h', label: '+ 1 h' }],
    [{ id: 'prev', label: '◀ Previous' }, { id: 'showTarget', label: S.target ? S.target.name : 'No target', span: 2, disabled: !S.target, on: !!S.target }, { id: 'next', label: 'Next ▶' }, { id: 'mag-', label: 'Fewer stars' }, { id: 'mag+', label: 'More stars' }],
    cap(`Transits tonight (above ${TONIGHT.minAlt}°, Sun below ${TONIGHT.sunLimit}°, magnitude < ${TONIGHT.magMax}; TOI: candidate)`),
  ];
  const ev = tonight.events;
  for (let i = 0; i < ev.length; i += 2) rows.push(ev.slice(i, i + 2).map((e, k) => ({ id: 'tn:' + (i + k), label: e.planet + (e.candidate ? ' (TOI)' : ''), sub: `${hhmm(e.ingress)}–${hhmm(e.egress)} · ${(e.alt * DEG).toFixed(0)}°`, span: 3, on: !!S.target && S.target.planet === e.planet })).concat(ev.length - i === 1 ? [{ label: '', span: 3 }] : []));
  // the Visible panel's list, its first four (the same filter and sort)
  const vl = visibleNow().rows.slice(0, 4);
  if (vl.length) { rows.push(cap(`Visible: ${VIS.WHEN[S.vis.when]}, ${VIS.SORTS[S.vis.sort]} first`)); for (let i = 0; i < vl.length; i += 2) rows.push(vl.slice(i, i + 2).map((r) => ({ id: 'vis:' + r.i, label: r.name, sub: `${DM.groupInfo(r.group).short} · ${visSub(r)}`, span: 3 })).concat(vl.length - i === 1 ? [{ label: '', span: 3 }] : [])); }
  rows.push(cap('Show'), ['constellations', 'labels', 'azgrid', 'eqgrid', 'ground', 'terrain'].map(layer), [...['satellites', 'hosts', 'planets', 'altlimit', 'atmosphere'].map(layer), { label: F ? `stars to V ${F.magLimit.toFixed(1)}` : '' }]);
  rows.push(cap(`Stars with planets, by discovery method${S.layers.hosts ? '' : ' (the Exoplanets layer is off)'}`), DM.GROUPS.map((g) => ({ id: 'disc:' + g.id, label: g.label, on: S.disc.includes(g.id), color: g.color })));
  rows.push(cap(`Compass: you started facing ${(A.wrap2pi(x.heading) * DEG).toFixed(0)}° ${compass(A.wrap2pi(x.heading) * DEG)}`),
    [{ id: 'xr:turnL', label: '⟲ 5°' }, { id: 'xr:alignNext', label: x.alignTarget ? 'On: ' + x.alignTarget.name : 'Nothing up', disabled: !x.alignTarget }, { id: 'xr:align', label: x.aligning ? 'Cancel' : 'Point & set', on: x.aligning, disabled: !x.alignTarget }, { id: 'xr:turnR', label: '5° ⟳' }, { id: 'xr:grip', label: x.grip === 'turn' ? 'Grip turns sky' : 'Grip scrubs time', span: 2, on: x.grip === 'time' }],
    [{ id: 'xr:hide', label: 'Hide menu', span: 3 }, { id: 'xr:exit', label: x.kind === 'ar' ? 'Exit passthrough' : 'Exit VR', span: 3 }]);
  const notes = []; const tn = tonightNote();
  if (x.aligning && x.alignTarget) notes.push({ text: `Point at the real ${x.alignTarget.name} and pull the trigger (or pinch, or tap).`, color: '#ffb454' });
  if (tn) notes.push(tn);
  return { title: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, sub: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${tzLabel(S.time)}${tw ? ' · ' + tw : ''}${S.playing ? '' : ' · paused'}`, notes, rows };
}

// The discovery filter: which kinds of planet hosts are on the sky (and in Tonight's list). Kept in localStorage.
/** Set the shown groups: 'tr', ['transit', 'rv'], ... (see discovery.js parseFilter). Returns discoveryCounts(). */
function setDiscoveryFilter(v) {
  const f = DM.parseFilter(v); if (f === S.disc) return discoveryCounts();
  S.disc = f; store.set('esl.sky.disc', f); data.hostLimit = null; cardKey = tonightKey = discKey = '';
  if (S.hover && data.hosts && !hostGroup(S.hover.i)) S.hover = null;
  if (tonight.status !== 'idle') loadTonight();
  if (F) compute();
  drawDisc(); return discoveryCounts();
}
/** Per group: how many hosts have it, how many are coloured by it, how many rings are drawn now; and the filter. */
function discoveryCounts() {
  const list = data.hosts ? data.hosts.list : null, drawn = S.layers.hosts && data.hostDrawn && data.hostDisc === S.disc ? data.hostDrawn : null, up = list ? countsUp() : null;
  return {
    shown: DM.GROUPS.filter((g) => S.disc.includes(g.id)).map((g) => g.label), exoplanet_layer_on: !!S.layers.hosts, hosts_loaded: !!list,
    groups: DM.GROUPS.map((g) => ({ method: g.label, key: g.key, letter: g.short, color: g.color, shown: S.disc.includes(g.id),
      hosts_with_method: list ? list.filter((h) => (h[5] || 'o').includes(g.id)).length : null,
      hosts_coloured: list ? list.filter((h) => (h[5] || 'o')[0] === g.id).length : null,
      above_horizon_now: up ? up[g.id] || 0 : null,
      rings_drawn_now: drawn ? drawn[g.id] || 0 : null })),
    above_horizon_now: up ? up.all : null,
    rings_drawn_now: drawn ? Object.values(drawn).reduce((a, b) => a + b, 0) : null,
    how_mixed_systems_are_coloured: DM.MIXED_NOTE,
  };
}
let discKey = '';
function drawDisc() {
  const c = discoveryCounts(), key = S.disc + '|' + c.hosts_loaded; if (key === discKey) return; discKey = key;
  $('discList').innerHTML = DM.GROUPS.map((g, k) => { const on = S.disc.includes(g.id), n = c.groups[k].hosts_with_method;
    return `<button class="dmt" data-g="${g.id}" aria-pressed="${on}" style="--c:${g.color}"><i class="sw" aria-hidden="true">${g.short}</i><span class="l">${g.label}<small>${escHtml(g.note)}</small></span><span class="n" title="Stars with at least one planet found this way">${n == null ? '' : n.toLocaleString('en-US')}</span><span class="ck" aria-hidden="true">${on ? '✓' : ''}</span></button>`; }).join('');
  $('discNote').textContent = DM.MIXED_NOTE + (c.hosts_loaded ? ` Methods from the NASA Exoplanet Archive (discoverymethod), snapshot ${data.hosts.meta.catalogDate || ''}; TESS candidates from its TOI table (TFOPWG PC and APC; known planets and false positives left out)${data.hosts.meta.toiDate ? ', snapshot ' + data.hosts.meta.toiDate : ''}. The legend, the Visible list and Tonight's transits follow this filter, planet by planet.` : '');
  $('discBtn').classList.toggle('on', S.disc !== DM.GROUP_IDS);
  $('discBtn').title = S.disc === DM.GROUP_IDS ? 'Colours of the stars with planets, by how their planets were found; show or hide each kind' : 'Showing ' + (c.shown.join(', ') || 'no kind') + ' only';
}
function bindDisc() {
  $('discBtn').querySelector('.dots').innerHTML = DM.GROUPS.map((g) => `<i style="background:${g.color}"></i>`).join('');
  $('discBtn').onclick = () => { togglePanel('discPanel'); if (!$('discPanel').hidden) loadHosts().then(() => { discKey = ''; drawDisc(); }).catch(() => {}); discKey = ''; drawDisc(); };
  $('discPanel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]'), all = e.target.closest('[data-disc]');
    if (b) act('disc:' + b.dataset.g); else if (all) setDiscoveryFilter(all.dataset.disc === 'all' ? DM.GROUP_IDS : '');
    drawTonight();
  });
}

// The legend: always on the sky (top right, folded to the swatches on a phone), the colour, letter and name of each
// discovery group with how many of its stars are above the horizon now; a tap shows or hides the group (the same
// state as the Discovery panel and the filter of the Tonight and Visible lists).
let legendKey = '', upCounts = null, upKey = '';
/** Stars with planets above the horizon now (the terrain when it is on), per group: { t: n, ... }, or null before hosts.json. */
function countsUp() {
  if (!data.hosts || !F) return null;
  const key = [Math.floor(S.time / 30000), S.lat, S.lon, !!data.horizon && S.layers.terrain].join('|');
  if (key !== upKey) { upKey = key; const r = VIS.visibleHosts(data.hosts.list, data.hosts.pos, { lat: S.lat * RAD, lon: S.lon * RAD, now: S.time, when: 'now', filter: '', j2000ToWorld: F.j2000ToWorld, apparent: F.apparent, horizon: horizonRad }); upCounts = { ...r.counts, all: r.up }; }
  return upCounts;
}
const legendOpen = () => (S.legendOpen == null ? !narrow.matches : S.legendOpen);
function drawLegend() {
  const el = $('legend'); el.hidden = S.ar;
  if (S.ar) return;
  const c = S.layers.hosts ? countsUp() : null, open = legendOpen(), key = [S.disc, open, S.layers.hosts, c && JSON.stringify(c), !!data.hosts].join('|');
  if (key === legendKey) return; legendKey = key;
  el.classList.toggle('folded', !open); el.classList.toggle('off', !S.layers.hosts);
  $('legendHead').setAttribute('aria-expanded', String(open));
  $('legendSum').textContent = !S.layers.hosts ? 'layer off' : c ? `${c.all.toLocaleString('en-US')} up` : 'loading…';
  $('legendSum').title = !S.layers.hosts ? 'The Exoplanets layer is off: tap a kind to show the stars' : 'Stars with planets (or candidates) above the horizon now; the numbers count each star under every kind it has';
  $('legendItems').innerHTML = DM.GROUPS.map((g) => {
    const on = S.disc.includes(g.id), n = c ? c[g.id] || 0 : null;
    return `<button class="lg" data-g="${g.id}" aria-pressed="${on}" style="--c:${g.color}" title="${escHtml(`${g.label}: ${g.note}. ${n == null ? '' : n.toLocaleString('en-US') + ' of these stars above the horizon now. '}Tap to ${on ? 'hide' : 'show'} them.`)}"><i class="sw${g.candidate ? ' dash' : ''}" aria-hidden="true">${g.short}</i><span class="l">${g.label}</span><span class="n">${n == null ? '' : n.toLocaleString('en-US')}</span></button>`;
  }).join('');
}
function bindLegend() {
  $('legendHead').onclick = () => { S.legendOpen = !legendOpen(); store.set('esl.sky.legend', S.legendOpen); legendKey = ''; drawLegend(); };
  $('legend').addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]'), v = e.target.closest('[data-act=vislist]');
    if (v) { togglePanel('visPanel', true); visKey = ''; drawVisible(); return; }
    if (!b) return;
    if (!S.layers.hosts) { toggleLayer('hosts'); return; }       // with the layer off, a tap first shows the stars
    act('disc:' + b.dataset.g); legendKey = ''; drawLegend(); drawTonight();
  });
}

// The Visible panel: the stars with planets above the limit now or in tonight's dark hours (src/sky/visible.js),
// filtered by discovery group (the legend's state), magnitude and number of planets, sorted; a tap centres and opens the card.
let visKey = '', visCache = { key: '', res: null }, visTr = { key: '', map: null };
/** Tonight's dark hours (the Sun below -12 deg, as the Tonight list): { t0, t1 } or null in a polar day. */
function darkHours() { const tw = A.nightOf(S.time, S.lat * RAD, S.lon * RAD, S.elev).nautical; return tw.evening != null && tw.morning != null ? { t0: tw.evening, t1: tw.morning } : null; }
/** The soonest transit of each host tonight (confirmed planets once the planet table is loaded, and the candidates). */
function visTransits(dark) {
  const ready = data.cat && data.cat.state.table === 'ready', key = [dark && dark.t0, ready].join('|');
  if (visTr.key === key) return visTr.map;
  const map = new Map(); visTr = { key, map };
  if (!dark) return map;
  data.hosts.list.forEach((h, i) => {
    const pl = VIS.candidatesOf(h).filter((p) => DM.planetShown(p, S.disc));
    if (ready && h[4]) for (const r of data.cat.rowsOfHost(h[0]) || []) if (r.v.transit && DM.planetShown(r.v, S.disc)) pl.push({ name: r.name, per: r.v.per, tmid: r.v.tmid, t14: r.v.t14, perErr: sig(r.e.per), tmidErr: sig(r.e.tmid), hasErr: !!(r.e.per && r.e.tmid), depth: r.v.depth });
    const t = pl.length ? VIS.transitsIn(pl, h[1], h[2], dark.t0, dark.t1)[0] : null; if (t) map.set(i, t);
  });
  return map;
}
/** The list as the panel shows it (also the immersive menu's and the assistant's). */
function visibleNow() {
  if (!data.hosts || !F) return { rows: [], total: 0, counts: {} };
  const v = S.vis, dark = darkHours(), terrain = !!data.horizon && S.layers.terrain;
  const key = [Math.floor(S.time / 60000), S.lat, S.lon, terrain, S.disc, v.when, v.sort, v.magMax, v.minPlanets, v.minAlt, dark && dark.t0, data.cat && data.cat.state.table].join('|');
  if (visCache.key === key) return visCache.res;
  if (v.sort === 'transit' && S.layers.hosts && (!data.cat || data.cat.state.table === 'idle')) ensureTable();
  const tr = visTransits(dark);
  const res = VIS.visibleHosts(data.hosts.list, data.hosts.pos, { lat: S.lat * RAD, lon: S.lon * RAD, now: S.time, dark, minAlt: (v.minAlt || 0) * RAD, filter: S.disc, magMax: v.magMax, minPlanets: v.minPlanets, when: v.when, sort: v.sort,
    transits: (i) => tr.get(i) || null, limit: 150, apparent: F.apparent, horizon: horizonRad,
    j2000ToWorld: F.j2000ToWorld });
  visCache = { key, res }; return res;
}
/** Two lines about a row of the Visible list: where it is (now, highest tonight), then magnitude and transit tonight. */
const visWhere = (r) => [r.up ? `${(r.alt * DEG).toFixed(0)}° ${compass(r.az * DEG)}` : 'down now', Number.isFinite(r.maxAlt) ? `max ${(r.maxAlt * DEG).toFixed(0)}° ${hhmm(r.tMax)}` : ''].filter(Boolean).join(' · ');
const visWhat = (r) => [r.mag != null ? `${r.band} ${r.mag.toFixed(1)}` : '', r.transit ? `transit ${hhmm(r.transit.mid)}${r.transit.candidate ? ' (TOI)' : ''}` : ''].filter(Boolean).join(' · ');
const visSub = (r) => [visWhere(r), visWhat(r)].filter(Boolean).join(' · ');
function drawVisible() {
  if ($('visPanel').hidden) return;
  if (!data.hosts) { $('visList').innerHTML = '<p class="note">Loading the stars with planets…</p>'; loadHosts().catch(() => {}); return; }
  const res = visibleNow(), key = [visCache.key, selKey(S.selection)].join('|'); if (key === visKey) return; visKey = key;
  const pl = (r) => [r.planets ? `${r.planets} planet${r.planets === 1 ? '' : 's'}` : '', r.candidates ? `${r.candidates} TOI` : ''].filter(Boolean).join(' + ');
  $('visList').innerHTML = res.rows.map((r) => { const G = DM.groupInfo(r.group), on = S.selection && S.selection.kind === 'host' && S.selection.i === r.i;
    return `<button class="vrow${on ? ' on' : ''}${r.up ? '' : ' down'}" data-act="vis:${r.i}" style="--c:${G.color}"><i class="sw${G.candidate ? ' dash' : ''}" aria-hidden="true">${G.short}</i><span class="vn"><b>${escHtml(r.name)}</b><small>${escHtml(pl(r))}</small></span><span class="vd">${escHtml(visWhere(r))}<br>${escHtml(visWhat(r))}</span></button>`; }).join('')
    || `<p class="note">No star with planets meets these limits${S.disc === DM.GROUP_IDS ? '' : ' and the discovery filter'}.</p>`;
  const dark = darkHours();
  $('visNote').textContent = `${res.total.toLocaleString('en-US')} star${res.total === 1 ? '' : 's'}${res.total > res.rows.length ? `, the first ${res.rows.length} shown` : ''}. ${dark ? `Dark hours (Sun below −12°) ${hhmm(dark.t0)}–${hhmm(dark.t1)}, local time of this browser.` : 'The Sun does not get 12° below the horizon tonight.'} Altitudes ${S.layers.atmosphere ? 'with refraction' : 'airless'}${data.horizon && S.layers.terrain ? ', above the terrain horizon' : ''}. Magnitudes are V, or T (TESS) for candidates.${S.vis.sort === 'transit' && !(data.cat && data.cat.state.table === 'ready') ? ' Loading the planet table for the transits of confirmed planets…' : ''}`;
  for (const [id, k] of [['visWhen', 'when'], ['visSort', 'sort'], ['visMinPl', 'minPlanets'], ['visMinAlt', 'minAlt']]) if (document.activeElement !== $(id)) $(id).value = String(S.vis[k]);
  if (document.activeElement !== $('visMag')) $('visMag').value = S.vis.magMax ?? '';
  $('visDisc').innerHTML = DM.GROUPS.map((g) => `<button class="lgc" data-g="${g.id}" aria-pressed="${S.disc.includes(g.id)}" style="--c:${g.color}" title="${escHtml(g.label)}"><i class="sw${g.candidate ? ' dash' : ''}" aria-hidden="true">${g.short}</i></button>`).join('');
}
/** Centre a host and open its card (the Visible list, the immersive menu, the assistant). */
function showHost(i) {
  if (!data.hosts || !data.hosts.list[i]) return;
  if (!S.layers.hosts) toggleLayer('hosts');
  const sel = { kind: 'host', i }; S.selection = sel; S.hover = null; infoKey = cardKey = ''; $('info').classList.remove('folded');
  if (!xr.presenting) { if (S.fov > 90) S.fov = 70; centreOn(sel); }
  drawInfo(); visKey = '';
}
function bindVisible() {
  $('visBtn').onclick = () => { togglePanel('visPanel'); visKey = ''; drawVisible(); };
  const set = (k, v) => { S.vis[k] = v; store.set('esl.sky.vis', S.vis); visKey = ''; drawVisible(); };
  $('visWhen').onchange = (e) => set('when', e.target.value); $('visSort').onchange = (e) => set('sort', e.target.value);
  $('visMinPl').onchange = (e) => set('minPlanets', +e.target.value); $('visMinAlt').onchange = (e) => set('minAlt', +e.target.value);
  $('visMag').oninput = (e) => set('magMax', e.target.value === '' || !Number.isFinite(+e.target.value) ? null : +e.target.value);
  $('visPanel').addEventListener('click', (e) => {
    const g = e.target.closest('[data-g]'), a = e.target.closest('[data-act]')?.dataset.act;
    if (g) { act('disc:' + g.dataset.g); visKey = legendKey = ''; drawVisible(); drawLegend(); return; }
    if (a && a.startsWith('vis:')) { act(a); if (narrow.matches) togglePanel('visPanel', false); }
  });
}

// The Tonight panel of the flat page: the same list and the same actions as the immersive menu.
let tonightKey = '';
function drawTonight() {
  if ($('tonightPanel').hidden) return;
  if (tonight.status === 'idle') loadTonight();
  const key = [tonight.key, tonight.status, tonight.events.length, selKey(S.target), S.target?.planet, S.magOffset, S.disc].join('|'); if (key === tonightKey) return; tonightKey = key;
  $('tgName').textContent = S.target ? S.target.name : 'No target'; $('tgName').disabled = !S.target;
  $('tonightList').innerHTML = tonight.events.map((e, i) => `<button class="tn${S.target && S.target.planet === e.planet ? ' on' : ''}" data-act="tn:${i}"><b>${escHtml(e.planet)}${e.candidate ? ' <i class="cand" title="A TESS candidate, not a confirmed planet">TOI</i>' : ''}</b><span>${hhmm(e.ingress)}–${hhmm(e.egress)} · ${(e.alt * DEG).toFixed(0)}° · ${e.band || 'V'} ${e.mag.toFixed(1)}</span></button>`).join('') + (tonightNote() ? `<p class="note">${escHtml(tonightNote())}</p>` : '');
  $('tonightNote').textContent = tonight.status === 'ready' && tonight.n > tonight.events.length ? `The best ${tonight.events.length} of ${tonight.n}; the planner lists them all.` : '';
  $('magLabel').textContent = F ? `to V ${F.magLimit.toFixed(1)}` : '';
}
function bindTonight() {
  $('tonightBtn').onclick = () => { togglePanel('tonightPanel'); tonightKey = ''; if (!$('tonightPanel').hidden) { tonight.key = tonight.status === 'error' ? '' : tonight.key; loadTonight(); } drawTonight(); };
  $('tonightPanel').addEventListener('click', (e) => { const a = e.target.closest('[data-act]')?.dataset.act; if (!a) return; act(a); if (a.startsWith('tn:') && matchMedia('(max-width: 1024px)').matches) togglePanel('tonightPanel', false); drawInfo(); drawTonight(); });
  $('magOffset').oninput = (e) => { S.magOffset = +e.target.value; tonightKey = ''; };
}

// ---------------------------------------------------------------- run
const ar = createAR();
const xr = createXR(R, {
  overlayRoot: $('xrOverlay'),
  onStart: () => { $('xrOverlay').hidden = false; setStatus(''); S.hover = null; },
  onEnd: () => { $('xrOverlay').hidden = true; R.setMode(S.xrdebug ? 'perspective' : 'stereo'); R.setHeading(0); R.setPointScale(Math.min(window.devicePixelRatio || 1, 2)); infoKey = cardKey = tonightKey = '';
    if (wrap.firstElementChild !== gl) { wrap.prepend(gl); gl.after(labels); }       // a WebXR emulator hands the canvas back at the end of its parent, over the controls
    requestAnimationFrame(resize); },
  pick: pickDir,
  select: (sel) => { S.selection = sel; S.hover = null; cardKey = infoKey = ''; },
  card: xrCard, menu: xrMenu, act, alignTargets, adjustMag,
  time: () => S.time, setTime: (ms) => setTime(ms),
  togglePlay: () => $('play').click(),
  status: (msg) => setStatus(msg, true),
});
if (S.xrdebug) xr.group.visible = true;
/** Names for the immersive view, where there is no 2D canvas: the same objects as drawLabels(), as sprites. */
function xrLabels() {
  const out = [], L = S.layers;
  const refr = (w) => { if (!L.atmosphere) return w; const h = altAzOf(w); return dirOf(F.apparent(h.alt), h.az); };
  // the cardinal points with their azimuths, on the horizon; altitudes on the 30 degree ring
  for (const [name, az] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]) {
    out.push({ key: 'card' + name, text: `${name} ${az}°`, dir: dirOf(1.4 * RAD + horizonRad(az * RAD), az * RAD), color: '#ffb454', deg: name.length === 1 ? 2.4 : 1.4, centre: true });
    if (L.altlimit) out.push({ key: 'alt30' + name, text: '30°', dir: dirOf(31.2 * RAD, az * RAD), color: '#78dcaa', deg: 1.1, centre: true });
  }
  const names = L.labels;
  if (L.planets && names) for (const b of [F.sun, F.moon, ...F.planets]) { if (hidden(b.dir) || ((b.id === 'uranus' || b.id === 'neptune') && b.mag > F.magLimit)) continue; out.push({ key: 'body' + b.id, text: b.name, dir: b.dir, color: '#ffd08a', deg: 1.5 }); }
  if (names && data.stars?.labelled) { let n = 0; const s = data.stars; for (const st of s.labelled) { if (n >= 40 || s.mag[st.i] > Math.min(3, F.magLimit - 2)) break; if (!st.proper) continue; const w = refr(toWorld(F.j2000ToWorld, [s.pos[st.i * 3], s.pos[st.i * 3 + 1], s.pos[st.i * 3 + 2]])); if (hidden(w)) continue; out.push({ key: 'star' + st.i, text: st.proper, dir: w, color: '#d6e0f3', deg: 1.1 }); n++; } }
  if (L.constellations && names && data.con) data.con.labels.forEach((l, i) => { const w = toWorld(F.j2000ToWorld, data.con.labelVec[i]); if (!hidden(w)) out.push({ key: 'con' + i, text: l[1].toUpperCase(), dir: w, color: '#86a8e6', deg: 1.0, centre: true }); });
  const tg = targetReady(S.target) ? S.target : null, ti = tg && infoOf(tg);
  if (ti && ti.dir) {
    out.push({ key: 'target-ring', ring: true, dir: ti.dir, color: '#ffb454', deg: 6 });
    const d = altAzOf(ti.dir); out.push({ key: 'target', text: tg.name, dir: dirOf(d.alt - 4.2 * RAD, d.az), color: '#ffd9a0', deg: 1.9, centre: true });
    if (data.night) {
      for (const m of data.night.marks) out.push({ key: 'markring' + m.name, ring: 'mark', dir: m.dir, color: data.night.color || '#5fd4ff', deg: m.mid ? 1.1 : 0.8 }, { key: 'mark' + m.name, text: `${m.name} ${hhmm(m.t)}${m.up ? '' : ' (below the horizon)'}`, dir: m.dir, color: '#bfeaff', deg: 1.3 });
      data.night.hours.forEach((h, i) => { if (h.up) out.push({ key: 'hour' + i, text: hhmm(h.t), dir: h.dir, color: '#ffc882', deg: 0.9 }); });
    }
  }
  const sel = S.selection && selKey(S.selection) !== selKey(S.target) ? infoOf(S.selection) : null;
  if (sel && sel.dir) out.push({ key: 'sel-ring', ring: 'reticle', dir: sel.dir, color: '#5fd4ff', deg: 2.2 });
  return out;
}
function resize() {
  if (xr.presenting) return;       // the headset owns the size of the drawing buffer
  const r = wrap.getBoundingClientRect(); R.resize(Math.round(r.width), Math.round(r.height));
  wrap.style.setProperty('--top-h', document.querySelector('.sky-top').offsetHeight + 'px');
  wrap.style.setProperty('--bar-h', document.querySelector('.sky-bar').offsetHeight + 'px'); wrap.style.setProperty('--night-h', ($('nightBar').hidden ? 0 : $('nightBar').offsetHeight) + 'px');
}
let lastT = performance.now(), slow = 0, ringOn = false;
function frame(t) {
  const dt = Math.min(1000, t - lastT); lastT = t;
  if (S.live && S.playing) S.time = Date.now(); else if (S.playing) S.time += dt * S.rate;
  // the run through the night stops at its end
  if (S.playing && $('rate').value === 'night' && data.night && S.time >= data.night.t1) { S.time = data.night.t1; S.playing = false; cardKey = ''; }
  if (S.follow && S.playing && $('rate').value === 'night' && !S.ar && F && targetReady(S.target)) followTarget();
  xr.update(dt, t);       // controllers, hands and the gaze: they may move the clock and turn the sky
  if (S.layers.altlimit !== ringOn) { ringOn = S.layers.altlimit; R.setLine('altlimit', ringOn ? X.altitudeRing(30 * RAD) : null, { color: 0x78dcaa, alpha: 0.7, order: 12 }); }
  compute();
  if (xr.presenting || S.xrdebug) xr.setLabels(xrLabels(), R.camera);
  R.draw(F);
  if (xr.presenting) return;       // nothing of the page is visible from inside the headset
  drawLabels(); drawReadout(); drawNight();
  if (t - slow > 250) { slow = t; syncNightBar(); drawInfo(); drawTonight(); if (!$('discPanel').hidden) drawDisc(); drawLegend(); drawVisible(); if (S.ar) updateCalib(); }
}
buildUI(); bindView(); resize();
new ResizeObserver(resize).observe(wrap);
const starsReady = loadStars().then(loadNames);
starsReady.catch((e) => { console.error(e); setStatus('The star catalogue could not be loaded: ' + e.message); });
loadConstellations().catch((e) => setStatus('Constellations could not be loaded: ' + e.message));
if (!S.hasLocation) setStatus('Showing the sky from Greenwich. Set your location at the top left.', true);
// a link from the planner or the Search page (or anywhere): ?planet=<planet, host, star or body> marks it, centres on
// it and opens its card. &host=<host> and &ra=&dec= (degrees, J2000) are the fallbacks for a name this page does
// not list (an exoplanet.eu-only planet, a KOI, a TOI that is a known planet): the host by name, else the nearest
// host star within 1 arcmin of the position, else the position itself.
async function resolveLink(name) {
  const keep = { keepTransit: true };
  const tryName = async (n) => { try { await resolveTarget(n, keep); return true; } catch { try { await starsReady; await resolveTarget(n, keep); return true; } catch { return false; } } };
  if (await tryName(name)) return '';
  const host = q.get('host');
  if (host && norm(host) !== norm(name) && await tryName(host)) { S.target.planet = S.target.planet || name; return `${name} is not in this page's list: its host star ${S.target.name} is marked.`; }
  const ra = num('ra'), dec = num('dec');
  if (ra == null || dec == null) throw new Error(`"${name}" is not a planet, host or bright star this page knows`);
  try {
    await loadHosts();
    const v = A.sphToVec(ra * RAD, dec * RAD); let best = -1, cmax = Math.cos(60 / 3600 * RAD);
    for (let i = 0; i < data.hosts.n; i++) { const c = v[0] * data.hosts.pos[i * 3] + v[1] * data.hosts.pos[i * 3 + 1] + v[2] * data.hosts.pos[i * 3 + 2]; if (c > cmax) { cmax = c; best = i; } }
    if (best >= 0) { setTarget({ kind: 'host', i: best, name, planet: name }, keep); return `${name} is not in this page's list by name: the host star at its position, ${data.hosts.list[best][0]}, is marked.`; }
  } catch { /* no host list: the position alone */ }
  setTarget({ kind: 'pos', ra, dec, name: host || name, from: `${name}: position from the catalogue (not in this page's host list)` }, keep);
  return `${name} is not in this page's host list: its catalogue position is marked.`;
}
/** On arrival from a link: say so when the target is below the horizon, and when it rises (airless, within a day). */
function arrivalNote(lead) {
  compute(); const i = S.target && infoOf(S.target); let msg = lead || '';
  if (i && i.dir && i.alt < horizonRad(i.az)) {
    let rise = null; for (let t = S.time; t < S.time + 86400e3; t += 300e3) if (altAzAt(S.target, t).alt > 0) { rise = t; break; }
    const site = S.hasLocation ? `${S.lat.toFixed(2)}°, ${S.lon.toFixed(2)}°` : 'Greenwich (no location set: choose yours at the top left)';
    msg += `${msg ? ' ' : ''}${S.target.name} is below the horizon from ${site} at this time (altitude ${(i.alt * DEG).toFixed(1)}°, azimuth ${(i.az * DEG).toFixed(0)}° ${compass(i.az * DEG)})` +
      (rise ? `; it rises at about ${hhmm(rise)} local time.` : '; it does not rise from here in the next 24 hours.');
  }
  if (msg) { setStatus(msg, true); clearTimeout(statusTimer); statusTimer = setTimeout(() => { $('status').hidden = true; }, 15000); }
  S.arrival = msg;
}
if (q.get('planet')) {
  const tr = S.transit, name = q.get('planet');
  resolveLink(name)
    .then((lead) => { S.transit = tr; cardKey = ''; if (num('fov') == null) S.fov = 70; drawInfo(); if (num('az') == null && num('alt') == null) centreOn(S.target); arrivalNote(lead); })
    .catch((e) => { S.transit = null; setStatus(e.message, true); });
} else S.transit = null;
// three.js calls this once per display frame, and once per headset frame while an immersive session runs
R.renderer.setAnimationLoop(frame);

// for the headless checks and the console
window.__sky = { S, A, R, data, ar, xr, frame: () => F, compute, pick, select: (sel) => { S.selection = sel; infoKey = cardKey = ''; drawInfo(); }, info: selectionInfo, infoOf, setTime, setLocation, setTarget, clearTarget, resolveTarget, playNight, suggestions, ensureTable, ensureTerrain, xrLabels, horizonRad, X, pickDir, act, xrCard, xrMenu, alignTargets, nextTransits, tonight, loadTonight, cycleTarget, adjustMag, setDiscoveryFilter, discoveryCounts, DM };

// ---- window.__esl.observe: what the site's assistant drives (the contract is at the top of src/assistant/pages.js)
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra }), obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const isoMin = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
  const where = () => { const i = S.target && infoOf(S.target); return i && Number.isFinite(i.alt) ? { altitude_deg: (i.alt * DEG).toFixed(1), azimuth_deg: (i.az * DEG).toFixed(1), direction: compass(i.az * DEG), above_horizon: i.alt > 0 } : null; };
  const night = () => { const n = data.night; return n ? { from_utc: isoMin(n.t0), to_utc: isoMin(n.t1), transit: n.transit ? { kind: eventInfo(n.transit.kind).title, ingress_utc: isoMin(n.transit.ingress), mid_utc: isoMin(n.transit.mid), egress_utc: isoMin(n.transit.egress), timing_1sigma_min: n.transit.err } : undefined } : null; };
  const tools = [
    { name: 'observe_set_site', core: true, description: 'Set the place the sky is seen from (latitude and longitude in degrees). It is remembered in this browser.',
      parameters: obj({ lat: N('Latitude, north positive.', { minimum: -90, maximum: 90 }), lon: N('Longitude, east positive.', { minimum: -180, maximum: 360 }) }, ['lat', 'lon']),
      run({ lat, lon }) { setLocation(lat, lon > 180 ? lon - 360 : lon); compute(); return { site: `${S.lat.toFixed(4)}°, ${S.lon.toFixed(4)}° (north and east positive)`, target_now: where() || undefined }; } },
    { name: 'observe_set_time', core: true, description: 'Set the moment shown: a UTC time, or "now" to follow the clock again.',
      parameters: obj({ time: T('ISO time in UTC, e.g. "2026-11-16T03:20:00Z", or "now".') }, ['time']),
      run({ time }) {
        if (/^now$/i.test(time)) { S.time = Date.now(); S.live = true; S.playing = true; S.rate = 1; if ($('rate').value === 'night') $('rate').value = '1'; }
        else { const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : time + 'Z'); if (!Number.isFinite(ms)) throw new Error('time is an ISO date and time in UTC, or "now"'); setTime(ms); S.playing = false; }
        compute(); return { showing_utc: isoMin(S.time), following_the_clock: S.live, target_now: where() || undefined };
      } },
    { name: 'observe_set_target', core: true, description: 'Mark a target and centre the view on it: a planet or host star of the catalogue, a bright star by name, the Moon, the Sun or a solar-system planet. An empty name clears it.',
      parameters: obj({ name: T('Name, e.g. "WASP-43 b", "Vega", "Jupiter"; "" to clear.') }, ['name']),
      async run({ name }) {
        if (!String(name).trim()) { clearTarget(); return { target: 'none' }; }
        try { await resolveTarget(name); } catch (err) { await starsReady; await resolveTarget(name); }
        compute(); return { target: S.target.name, kind: S.target.kind === 'host' ? 'exoplanet host' : S.target.kind === 'body' ? 'solar-system body' : 'star', at_utc: isoMin(S.time), now: where(), night: night() || undefined };
      } },
    { name: 'observe_play_night', core: true, description: 'Run the clock through the night of the marked target (sunset to sunrise in about 40 seconds), or pause it. Needs a target (observe_set_target).',
      parameters: obj({ pause: { type: 'boolean', description: 'true: pause instead of play.' } }),
      run({ pause }) {
        if (!S.target) throw new Error('mark a target first (observe_set_target)');
        const running = S.nightPlay && $('rate').value === 'night' && S.playing;
        if (pause ? running : !running) playNight(pause ? undefined : !S.nightPlay);
        return { playing: !!(S.nightPlay && S.playing), night: night() || undefined };
      } },
    { name: 'observe_discovery_filter', description: 'Show only the stars whose planets were found by some methods (the colours of the Exoplanets layer and its legend, and the Tonight and Visible lists). Methods: transit, rv (radial velocity), imaging, microlensing, other (timing, astrometry, ...), toi (TESS candidates, not confirmed). All six shows everything. Switches the Exoplanets layer on.',
      parameters: obj({ methods: { type: 'array', description: 'The methods to show.', items: T('A method.', { enum: DM.GROUPS.map((g) => g.key) }) } }, ['methods']),
      async run({ methods }) { if (!S.layers.hosts) toggleLayer('hosts'); await loadHosts(); setDiscoveryFilter(methods); compute(); return discoveryCounts(); } },
    { name: 'observe_discovery_counts', readOnly: true, description: 'How many stars with planets there are per discovery method, which methods are shown, and how many of their rings are drawn at the present zoom.', parameters: obj({}),
      async run() { await loadHosts(); compute(); return discoveryCounts(); } },
    { name: 'observe_list_visible', readOnly: true, description: 'The stars with planets (and TESS candidates) that can be seen from the site now or in tonight\'s dark hours (Sun below -12 deg), as the Visible panel lists them: under the discovery filter, with altitude now, highest altitude tonight, magnitude, planets and the next transit tonight. Changes the panel\'s settings when given.',
      parameters: obj({ when: T('now, tonight (dark hours) or either.', { enum: Object.keys(VIS.WHEN) }), sort: T('Sort key.', { enum: Object.keys(VIS.SORTS) }), min_altitude: N('Lowest altitude in degrees (0, 20, 30 or 45).', { minimum: 0, maximum: 80 }), mag_max: N('Faintest magnitude (V, T for candidates); 0 for any.'), min_planets: { type: 'integer', description: 'At least this many planets and candidates.', minimum: 0, maximum: 9 }, limit: { type: 'integer', description: 'How many to return (default 15).', minimum: 1, maximum: 60 } }),
      async run(a) {
        await loadHosts(); if (!S.layers.hosts) toggleLayer('hosts');
        if (a.when) S.vis.when = a.when; if (a.sort) S.vis.sort = a.sort; if (a.min_altitude !== undefined) S.vis.minAlt = a.min_altitude; if (a.mag_max !== undefined) S.vis.magMax = a.mag_max > 0 ? a.mag_max : null; if (a.min_planets !== undefined) S.vis.minPlanets = a.min_planets;
        store.set('esl.sky.vis', S.vis); compute(); const r = visibleNow(), d = darkHours();
        return { site: `${S.lat.toFixed(3)}, ${S.lon.toFixed(3)}`, at_utc: isoMin(S.time), dark_hours_utc: d ? `${isoMin(d.t0)} to ${isoMin(d.t1)}` : 'none tonight', filter: DM.GROUPS.filter((g) => S.disc.includes(g.id)).map((g) => g.label), settings: { ...S.vis }, total: r.total,
          stars: r.rows.slice(0, a.limit || 15).map((x) => ({ name: x.name, kind: DM.groupInfo(x.group).label, up_now: x.up, altitude_now_deg: +(x.alt * DEG).toFixed(1), direction: compass(x.az * DEG), highest_tonight_deg: Number.isFinite(x.maxAlt) ? +(x.maxAlt * DEG).toFixed(1) : undefined, highest_at_utc: Number.isFinite(x.tMax) ? isoMin(x.tMax) : undefined, magnitude: x.mag != null ? `${x.band} ${x.mag.toFixed(1)}` : null, planets: x.planets, tess_candidates: x.candidates, transit_tonight: x.transit ? { planet: x.transit.planet, mid_utc: isoMin(x.transit.mid) } : undefined })),
          note: 'observe_set_target marks one; TESS candidates are not confirmed planets.' };
      } },
    { name: 'observe_where', readOnly: true, description: 'Where the marked target is in the sky at the time shown (altitude, azimuth), the span of its night and its transit when one was passed from the planner.', parameters: obj({}),
      run() { if (!S.target) throw new Error('no target is marked (observe_set_target)'); compute(); return { target: S.target.name, at_utc: isoMin(S.time), now: where(), night: night() || undefined }; } },
  ];
  (window.__esl = window.__esl || {}).observe = { tools, ready: () => !!F, setDiscoveryFilter, discoveryCounts,
    state: () => [`Seen from ${S.lat.toFixed(3)}°, ${S.lon.toFixed(3)}° (north, east positive)${S.hasLocation ? '' : ' (the default: no location was set)'}; showing ${isoMin(S.time)} UTC${S.live ? ' (following the clock)' : ''}.`, S.target ? `Target marked: ${S.target.name}${S.transit ? `, with a ${eventInfo(S.transit.kind).word} ${isoMin(S.transit.ingress)} to ${isoMin(S.transit.egress)} UTC` : ''}${S.nightPlay && S.playing ? '; the night is playing' : ''}.` : 'No target is marked.',
      S.disc === DM.GROUP_IDS ? 'Stars with planets: all discovery methods shown.' : `Stars with planets: only ${DM.GROUPS.filter((g) => S.disc.includes(g.id)).map((g) => g.label).join(', ') || 'none'} shown (discovery filter).`] };
}
