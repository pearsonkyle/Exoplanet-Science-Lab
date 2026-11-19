// Plan page: which transits, eclipses and phase windows can be observed from a site in a range of nights.
// Settings live in P (kept in localStorage); everything on screen is recomputed from P, the catalogue and the
// observatory list.
//
// "Observable" is judged on the region of interest of an event (the baseline before the start to the same after
// the end, widened by 1 sigma of the predicted time): see findObservableEvents in src/core/observability.js.
import { siteJson } from '../site/net.js';
import * as ND from '../core/nightdates.js';
import { siteRoot } from '../site/nav.js';
import { fetchJsonProgress, progressText } from '../site/load.js';
import { SOURCES, loadSources, buildTable, findRow } from '../core/sources/index.js';
import { RELATIONS } from '../core/relations.js';
import * as O from '../core/observability.js';
import { esc, minutes, hms, dms } from '../search/format.js';
import { FALLBACK_SITE, KIND_LABEL, loadObservatories, groupSites } from './sites.js';
import { nightFrame, nightData, renderAltitude, renderSkyTrack, prepareCanvas, airmassText, THEME, KIND_COLOUR } from './chart.js';
import { createGlobe, GLOBE_COLOURS } from './globe.js';
import * as DM from '../sky/discovery.js';
import * as T from './targets.js';
import { horizonAt, ATTRIBUTION as TERRAIN_ATTRIBUTION } from '../core/horizon.js';
import clock, { mountClockBadge } from '../site/clock.js';
import { DISPLAY_SCALES, formatScale, isDisplayScale } from '../core/timeformat.js';
import { fromPlanEvent } from '../core/sequence.js';

const $ = (id) => document.getElementById(id);
const fetchJson = (file) => siteJson(new URL(file, siteRoot()), file);
const STORE = 'esl.plan.v3', OLD_STORE = 'esl.plan.v2', MAX_SHOWN = 300;
const fin = Number.isFinite;

// The defaults the owner asked for: altitude 30 deg, one hour of baseline each side, the Sun below -18 deg.
// For small telescopes (2026-11-15): a week of nights (3 nights listed 11 observable transits from Kitt Peak; a
// week 18 of confirmed planets alone), depth from 2 ppt (2.2 mmag: what a 20-40 cm telescope reaches on a V 12-13
// star in a transit's duration; 5 ppt left out 70% of the planets brighter than V 13) and the TESS candidates
// included, marked as candidates (most targets of small-telescope follow-up are TOIs). test/plan_targets.test.mjs
// counts what each filter leaves.
const DEFAULTS = { obs: FALLBACK_SITE.id, lat: FALLBACK_SITE.lat, lon: FALLBACK_SITE.lon, elev: FALLBACK_SITE.elev, tz: 'site', date: 'auto', nights: 7, minAlt: 30, sun: -18, base: 1, show: 'transit',
  magMin: null, magMax: 13, depth: 2, src: { nea: true, toi: true, eu: false }, eph: 'best', name: '', sort: 'time', view: 'list', chosen: false, disc: DM.GROUP_IDS, terrain: false,
  events: ['transit'], phSpan: 0.5, phCenter: 'eclipse', phMaxPer: 3, cFrom: 0.4, cTo: 0.6, scale: 'site' };
const LIMIT_KEYS = ['minAlt', 'sun', 'base', 'show', 'magMin', 'magMax', 'depth'];
/** Settings of the earlier version: what was left at its defaults (3 nights, 5 ppt, no candidates) takes the new ones. */
function migrate(old) {
  const o = { ...old };
  if (o.nights === 3) delete o.nights;
  if (o.depth === 5) delete o.depth;
  if (o.src && o.src.toi === false) o.src = { ...o.src, toi: true };
  return o;
}
const P = (() => {
  try {
    const now = JSON.parse(localStorage.getItem(STORE)), old = now ? null : JSON.parse(localStorage.getItem(OLD_STORE));
    const p = { ...DEFAULTS, ...(now || (old ? migrate(old) : {})) }; p.src = { ...DEFAULTS.src, ...p.src }; p.disc = DM.parseFilter(p.disc); return p;
  } catch { return { ...DEFAULTS }; }
})();
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(P)); } catch { /* private mode */ } };
const single = new URLSearchParams(location.search).get('planet');          // ?planet=<name>: one planet, a year ahead

const KINDS = O.EVENT_KINDS;
/** What each kind of event is called: badge, word in sentences, names of the contacts. */
const KIND = { transit: { badge: 'Transit', word: 'transit', start: 'Ingress', end: 'Egress' }, eclipse: { badge: 'Eclipse', word: 'eclipse', start: 'Ingress', end: 'Egress' },
  phase: { badge: 'Phase', word: 'phase-curve window', start: 'Start', end: 'End' }, custom: { badge: 'Custom', word: 'phase window', start: 'Start', end: 'End' } };
const kindsOn = () => KINDS.filter((k) => P.events.includes(k));
const A = { open: new Set(), loaded: {}, loading: {}, failed: {}, rows: [], targets: [], events: [], shown: [], selected: null, singleRow: null, dark: null, darkKey: '', obs: { sites: [FALLBACK_SITE], byId: new Map([[FALLBACK_SITE.id, FALLBACK_SITE]]), meta: {}, resources: null, land: [] } };
window.__plan = { P, A };                                                    // for the headless checks
let globe = null;

// ------------------------------------------------------------------------------------------------ site and time

const site = () => ({ lat: P.lat, lon: P.lon, elev: P.elev || 0 });
const curSite = () => (P.obs !== 'custom' ? A.obs.byId.get(P.obs) || null : null);
function timeZone() {
  if (P.tz === 'UTC') return 'UTC';
  if (P.tz === 'site' && curSite()) return curSite().tz;
  if (P.tz === 'browser') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  const off = Math.round((((P.lon + 180) % 360 + 360) % 360 - 180) / 15);   // mean solar time zone of the longitude
  return off === 0 ? 'UTC' : `Etc/GMT${off < 0 ? '+' + -off : '-' + off}`;   // the Etc names have the sign reversed
}
let F = null;
function formatters() {
  const tz = timeZone(), mk = (o, z) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: z, ...o }); } catch { return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...o }); } };
  const hm = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, l = mk(hm, tz), u = mk(hm, 'UTC'), day = mk({ weekday: 'short', day: 'numeric', month: 'short' }, tz), dayU = mk({ day: 'numeric', month: 'short', year: 'numeric' }, 'UTC');
  const off = mk({ timeZoneName: 'shortOffset' }, tz).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
  const rd = (jd) => new Date(Math.round((jd - 2440587.5) * 1440) * 60000);                  // to the nearest minute, not truncated
  F = { tz, local: (jd) => l.format(rd(jd)), utc: (jd) => u.format(rd(jd)), day: (jd) => day.format(O.dateFromJd(jd)), dayUtc: (jd) => dayU.format(O.dateFromJd(jd)),
    // the Etc zones have the sign reversed (Etc/GMT+7 is UTC-7): they are labelled as UTC offsets
    tzLabel: tz === 'UTC' ? 'UTC' : /^Etc\/GMT[+-]\d+$/.test(tz) ? 'UTC' + (tz[7] === '+' ? '−' : '+') + tz.slice(8) : `${tz.replace(/_/g, ' ')}${off ? ' (' + off.value.replace('GMT', 'UTC') + ')' : ''}`, span: (d) => minutes(d * 1440) };
  F.tzShort = F.tzLabel.split(' (')[0].split('/').pop();
  return F;
}
/** First local mean noon of the range: the noon of the chosen date at the site's longitude. */
function startNoon() {
  if (P.date === 'auto' || !/^\d{4}-\d\d-\d\d$/.test(P.date)) return O.noonBefore(O.jdFromDate(clock.now()), P.lon);
  const [y, m, d] = P.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5 - P.lon / 360;
}
const isoDate = (jd) => O.dateFromJd(jd + P.lon / 360).toISOString().slice(0, 10);     // calendar date of a local mean noon
const iso = (jd) => O.dateFromJd(Math.round(jd * 86400) / 86400).toISOString().replace(/\.\d+Z$/, 'Z');
const sunName = (s = P.sun) => (s <= -18 ? 'astronomical night' : s <= -12 ? 'nautical night' : s <= -6 ? 'civil night' : 'sunset to sunrise');

/** The present in the chosen time scale (clock.now(): corrected by the best time source; see src/site/clock.js). */
function drawNow() {
  const c = curSite(), t = A.selected && A.selected.target;
  const f = formatScale(clock.now(), isDisplayScale(P.scale) ? P.scale : 'utc', { site: { lon: P.lon, tz: c ? c.tz : timeZone() }, target: t ? { ra: t.ra, dec: t.dec } : null });
  const o = $('p-now'); if (!o) return;
  o.textContent = `${f.text} ${f.unit}${f.note ? ' · ' + f.note : ''}`;
  o.title = DISPLAY_SCALES.find((d) => d.id === P.scale)?.hint || '';
}
function initNow() {
  const sel = $('p-scale'); if (!sel) return;
  sel.innerHTML = DISPLAY_SCALES.map((d) => `<option value="${d.id}" title="${esc(d.hint)}">${esc(d.label)}</option>`).join('');
  sel.value = isDisplayScale(P.scale) ? P.scale : 'site';
  clock.start(); mountClockBadge($('p-clock'));
  drawNow(); setInterval(drawNow, 1000);
}

// ------------------------------------------------------------------------------------------------ targets and their ephemerides

const sig = (e) => (e ? (e[0] + e[1]) / 2 : 0);
/** The ephemeris of a row with the choice of P.eph (src/plan/targets.js). */
const ephemerisOf = (r) => T.ephemerisOf(r, P.eph);
function makeTargets() {
  A.targets = T.makeTargets(A.rows, P.eph);
  A.discCounts = T.discoveryCounts(A.rows, A.targets);
}
async function ensureSources() {
  const want = single ? ['nea', 'eu', 'toi'] : ['nea', ...(P.src.toi ? ['toi'] : []), ...(P.src.eu || P.eph === 'eu' ? ['eu'] : [])];   // exoplanet.eu's ephemerides need its snapshot even when its planets are not listed
  const need = want.filter((id) => !A.loaded[id] && !A.loading[id]);
  if (!need.length) return false;
  need.forEach((id) => (A.loading[id] = true));
  const names = need.map((id) => SOURCES.find((s) => s.id === id).label).join(', '), got = {};
  status(`Loading ${names}…`); $('p-list').setAttribute('aria-busy', 'true');
  if (!A.loaded.nea) $('p-list').innerHTML = `<p class="state">Loading ${esc(names)}: a few MB, once per visit.<span class="bar"><i id="p-loadbar"></i></span></p>`;
  // the snapshots are several MB: say how much has arrived
  const withProgress = (file) => fetchJsonProgress(new URL(file, siteRoot()), (p) => {
    got[file] = p; const all = Object.values(got), rec = all.reduce((a, x) => a + x.received, 0), tot = all.every((x) => x.total) ? all.reduce((a, x) => a + x.total, 0) : 0;
    status(`Loading ${names}… ${progressText({ received: rec, total: tot })}`);
    const bar = $('p-loadbar'); if (bar && tot) bar.style.width = (100 * rec / tot).toFixed(0) + '%';
  }).catch((err) => { throw new Error(`${file}: ${err.message}`); });
  const loaded = await loadSources(withProgress, need);
  need.forEach((id) => delete A.loading[id]);
  $('p-list').removeAttribute('aria-busy');
  // a snapshot that did not arrive is not kept, so that the next change of the settings asks for it again
  for (const id of need) { if (loaded[id].error) { A.failed[id] = loaded[id].error; delete loaded[id]; } else delete A.failed[id]; }
  Object.assign(A.loaded, loaded);
  if (!A.loaded.nea) { showLoadError(); return false; }
  A.rows = buildTable(A.loaded).rows;
  makeTargets(); fillDisc();
  if (single) A.singleRow = findRow(A.rows, single);
  return true;
}

// ------------------------------------------------------------------------------------------------ compute

function compute() {
  if (!A.loaded.nea) return;
  formatters();
  const s = site(), n = single ? 365 : Math.max(1, Math.min(90, Math.round(P.nights) || 1)), jd0 = startNoon(), jd1 = jd0 + n;
  const opts = { jd0, jd1, minAlt: P.minAlt, sunLimit: P.sun, baseline: (P.base || 0) / 24, include: P.show, kinds: kindsOn(), padSigma: true,
    phase: { span: P.phSpan, center: P.phCenter, maxPer: P.phMaxPer }, custom: { from: P.cFrom, to: P.cTo } };
  const key = [s.lat, s.lon, jd0, jd1, P.sun].join('|');
  if (A.darkKey !== key) { A.dark = O.darkIntervals(jd0 - 1.5, jd1 + 1.5, s, P.sun); A.darkKey = key; }
  opts.dark = A.dark;
  if (P.terrain && A.horizon && A.horizon.key === terrainKey()) opts.horizon = A.horizon.fn;
  else if (P.terrain) ensureHorizon();
  let targets, skipped = { noDuration: 0, noMag: 0 };
  if (single) targets = A.singleRow ? A.targets.filter((t) => t.row === A.singleRow) : [];
  else {
    const f = T.filterTargets(A.targets, P); targets = f.targets; skipped = f.skipped;
  }
  const t0 = performance.now();
  A.events = O.findObservableEvents(targets, s, opts);
  A.info = { n, jd0, jd1, ntargets: targets.length, skipped, ms: performance.now() - t0, opts };
  if (A.selected) A.selected = A.events.find((e) => e.target === A.selected.target && e.epoch === A.selected.epoch && e.kind === A.selected.kind) || null;
  draw();
}

// ------------------------------------------------------------------------------------------------ small pieces

const status = (t) => { $('p-count').textContent = t; };

// ---- the terrain horizon (src/sky/terrain.js, shared with the Observe page and its caches)
const terrainKey = () => [P.lat.toFixed(3), P.lon.toFixed(3), Math.round(P.elev || 0)].join(',');
let terrainBusy = '';
/** Load the skyline of the site when "use the terrain horizon" is ticked; recompute when it arrives. */
async function ensureHorizon() {
  if (!P.terrain) { drawTerrainNote(); return; }
  const k = terrainKey(); if ((A.horizon && A.horizon.key === k) || terrainBusy === k) { drawTerrainNote(); return; }
  terrainBusy = k; A.horizonError = ''; drawTerrainNote('Loading the terrain…');
  try {
    const TM = await import('../sky/terrain.js');
    const p = await TM.loadHorizon(P.lat, P.lon, { elev: P.elev > 0 ? P.elev : null, onProgress: (d, n) => drawTerrainNote(`Terrain: elevation tile ${d} of ${n}…`) });
    if (k !== terrainKey()) return;
    const fn = (az) => horizonAt(p, az); fn.max = Math.max(...p.alt);
    A.horizon = { key: k, p, fn, min: Math.min(...p.alt), max: fn.max };
    compute();
  } catch (err) { A.horizonError = String(err && err.message || err); }
  finally { if (terrainBusy === k) terrainBusy = ''; drawTerrainNote(); }
}
function drawTerrainNote(msg) {
  const el = $('p-terrain-note'); if (!el) return;
  const H = A.horizon && A.horizon.key === terrainKey() ? A.horizon : null;
  el.innerHTML = !P.terrain ? '' : msg ? esc(msg) : A.horizonError ? `<span class="warn">The terrain could not be loaded (${esc(A.horizonError)}): the horizon is flat.</span>`
    : H ? `Skyline ${H.min.toFixed(1)}° to ${H.max.toFixed(1)}° from ${Math.round(Math.max(H.p.ground, 0))} m, out to ${Math.round((H.p.maxDist || 150000) / 1000)} km${H.max <= P.minAlt ? `: below your ${P.minAlt}° limit everywhere, so it changes nothing` : ''}. <a href="${TERRAIN_ATTRIBUTION.url}" target="_blank" rel="noopener" title="${esc(TERRAIN_ATTRIBUTION.lines.join('; '))}">${esc(TERRAIN_ATTRIBUTION.short)}</a>` : '';
}
const failedText = () => Object.entries(A.failed).map(([id, why]) => `${SOURCES.find((s) => s.id === id).label} (${why})`).join('; ');
/** The archive snapshot is what everything is computed from: without it, say so and offer to try again. */
function showLoadError() {
  status('The catalogue could not be loaded.');
  $('p-list').innerHTML = `<p class="state err" role="alert">The catalogue snapshot did not arrive: ${esc(failedText())}. Check the connection, then <button type="button" class="btn" id="p-retry">Try again</button></p>`;
}
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
const sigClass = (m) => (!(m > 0) ? 'unk' : m < 5 ? 'good' : m < 30 ? 'warn' : 'bad');
const deg = (x) => Math.round(x) + '°';
const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
const hours = (d) => (d * 24 >= 9.95 ? (d * 24).toFixed(0) : (d * 24).toFixed(1)) + ' h';
const pct = (f) => (f >= 0.9995 ? '100' : Math.min(99, Math.round(100 * f)).toString());
const cls = (ev) => (ev.full ? 'full' : ev.transitFull ? 'short' : 'part');
const isLong = (ev) => ev.kind === 'phase' || ev.kind === 'custom';
/** Where a lost piece of the region of interest falls. */
function lostWhere(ev, l) {
  const K = KIND[ev.kind], s = K.start.toLowerCase(), e = K.end.toLowerCase();
  return l.end <= ev.ingress + 1e-6 ? `before ${s}` : l.start >= ev.egress - 1e-6 ? `after ${e}` : l.start >= ev.ingress - 1e-6 && l.end <= ev.egress + 1e-6 ? `in ${isLong(ev) ? 'the window' : K.word}` : l.start < ev.ingress ? `from before ${s}` : `through ${e}`;
}
const lostWhy = (l) => (l.why === 'twilight' ? 'twilight' : 'too low');
const lostText = (ev, long = false) => ev.lost.map((l) => `${minutes((l.end - l.start) * 1440)} ${lostWhy(l)} ${long ? lostWhere(ev, l) : lostWhere(ev, l).replace(/ (ingress|egress|start|end)$/, '')}${long ? ` (${F.local(l.start)}–${F.local(l.end)})` : ''}`).join(long ? '; ' : ' · ');
/** The region of interest as a bar: observable in green, lost pieces in the colour of their cause, the event outlined. */
function roiBar(ev) {
  const w = ev.roiEnd - ev.roiStart, p = (t) => (100 * (t - ev.roiStart) / w).toFixed(1);
  return `<span class="roi-bar" aria-hidden="true">${ev.lost.map((l) => `<i class="${l.why === 'twilight' ? 'tw' : 'lo'}" style="left:${p(l.start)}%;width:${(100 * (l.end - l.start) / w).toFixed(1)}%"></i>`).join('')}<i class="tr" style="left:${p(ev.ingress)}%;width:${(100 * (ev.egress - ev.ingress) / w).toFixed(1)}%"></i></span>`;
}
/** The link to the sky view at this event: the contract of observe/ (planet, t, lat, lon, elev, transit, err); event says which kind. */
function skyUrl(ev) {
  const sm = ev.target.hasErr ? `&err=${(ev.sigma * 1440).toFixed(2)}` : '';
  return `../observe/?planet=${encodeURIComponent(ev.target.name)}&t=${iso(ev.mid)}&lat=${+P.lat.toFixed(5)}&lon=${+P.lon.toFixed(5)}&elev=${Math.round(P.elev || 0)}&transit=${iso(ev.ingress)},${iso(ev.mid)},${iso(ev.egress)}${sm}${ev.kind !== 'transit' ? '&event=' + ev.kind : ''}`;
}
const sunText = () => (P.sun === -0.833 ? 'below the horizon' : `below ${P.sun}°`);
/** The rule, in one line of plain words (with <b> for the numbers). */
const criteria = () => `the whole region of interest, <b>${P.base ? P.base + ' h' : 'no baseline'}</b> before and after a transit or eclipse${kindsOn().some((k) => k === 'phase' || k === 'custom') ? ' (a phase window is its own region)' : ''}, widened by the 1σ timing uncertainty, with the star above <b>${P.minAlt}°</b>${P.terrain && A.horizon && A.horizon.key === terrainKey() ? ' <b>and above the terrain</b>' : ''} and the Sun <b>${sunText()}</b>${P.sun <= -6 ? ` (${sunName()})` : ''}`;
const kindBadge = (k) => `<span class="kb k-${k}">${KIND[k].badge}</span>`;
/** The catalogue of a target as a tag; a TESS candidate says so (it is not a confirmed planet). */
const srcTag = (t) => (t.candidate ? `<span class="tag toi" title="${esc(`TESS Object of Interest, TFOPWG ${t.row.recs.toi.info.disposition || 'no disposition'}: a candidate, not a confirmed planet`)}">TOI candidate</span>` : `<span class="tag ${t.cat}">${SOURCES.find((s) => s.id === t.cat).short}</span>`);
const scoreTip = (s) => `Score ${s.total.toFixed(0)} of 100 = coverage of the event ${s.coverage.toFixed(0)}/40 + dark baseline ${s.baseline.toFixed(0)}/15 + altitude ${s.altitude.toFixed(0)}/20 (by the mean airmass: 0 at your limit, full overhead) + signal ${s.signal.toFixed(0)}/20 (${s.snr === null ? 'half marks: no depth or magnitude to estimate it from' : `expected S/N ${s.snr < 100 ? s.snr.toFixed(0) : '100+'} for a small telescope, from the depth, the star's magnitude and the duration; 0 at S/N 5, full at 200`}) + Moon ${s.moon.toFixed(0)}/5 (full when it is down or more than 40° away). A ranking aid, not a prediction of your precision.`;
/** The score as a number on a badge coloured by tier, with the four parts as a stacked bar under it. */
function scoreHtml(s, ev) {
  const tier = s.total >= 85 ? 'hi' : s.total >= 65 ? 'mid' : 'lo';
  // under the score: a miniature of the coverage timeline (green observable, violet twilight, amber too low)
  return `<span class="ev-score s-${tier}" title="${esc(scoreTip(s))}"><b>${s.total.toFixed(0)}</b>${ev ? roiBar(ev).replace('class="roi-bar"', 'class="roi-bar mini"') : ''}<span class="sbar" aria-hidden="true"><i class="p-cov" style="width:${s.coverage.toFixed(1)}%"></i><i class="p-base" style="width:${s.baseline.toFixed(1)}%"></i><i class="p-alt" style="width:${s.altitude.toFixed(1)}%"></i><i class="p-sig" style="width:${s.signal.toFixed(1)}%"></i><i class="p-moon" style="width:${s.moon.toFixed(1)}%"></i></span></span>`;
}
/**
 * Altitude of the star over the region of interest (and half an hour each side) as a small SVG: twilight shaded,
 * the event window tinted in the colour of its kind, the altitude limit dashed; the track is thin, and bold only inside
 * the observing window (the region of interest).
 */
function sparkline(ev) {
  const s = site(), t0 = ev.roiStart - 0.5 / 24, t1 = ev.roiEnd + 0.5 / 24, n = 40, W = 120, H = 30, x = (t) => ((t - t0) / (t1 - t0) * W).toFixed(1), y = (a) => (H - 1 - Math.max(0, Math.min(90, a)) / 90 * (H - 2)).toFixed(1);
  const pts = [];
  const hz = A.info && A.info.opts.horizon;
  const ts = [...Array.from({ length: n + 1 }, (_, i) => t0 + (t1 - t0) * i / n), ev.roiStart, ev.roiEnd].sort((a, b) => a - b);
  for (const t of ts) { const h = O.altAz(ev.target.ra, ev.target.dec, t, s); pts.push({ t, alt: h.alt, clear: !hz || h.alt + O.refraction(h.alt) > hz(h.az), sun: O.sunAltAz(t, s).alt }); }
  let tw = '', obs = '', line = '', on = false;
  // twilight: one rectangle per run of samples with the Sun above the limit
  const m = pts.length - 1;
  for (let i = 0, a = -1; i <= m; i++) {
    const lit = i < m && (pts[i].sun > P.sun || pts[i + 1].sun > P.sun);
    if (lit && a < 0) a = i;
    if (!lit && a >= 0) { tw += `<rect x="${x(pts[a].t)}" y="0" width="${((pts[i].t - pts[a].t) / (t1 - t0) * W).toFixed(1)}" height="${H}" class="sp-tw"/>`; a = -1; }
  }
  for (const p of pts) { line += `${line ? 'L' : 'M'}${x(p.t)} ${y(p.alt)}`; const ok = p.t >= ev.roiStart - 1e-9 && p.t <= ev.roiEnd + 1e-9; /* the observing window (the region of interest); what is lost in it shows on the coverage bar */ obs += ok ? `${on ? 'L' : 'M'}${x(p.t)} ${y(p.alt)}` : ''; on = ok; }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${tw}<rect x="${x(ev.ingress)}" y="0" width="${(Math.max(0.8, (ev.egress - ev.ingress) / (t1 - t0) * W)).toFixed(1)}" height="${H}" fill="${KIND_COLOUR[ev.kind]}" class="sp-ev"/>` +
    `<line x1="0" x2="${W}" y1="${y(P.minAlt)}" y2="${y(P.minAlt)}" class="sp-lim"/><path d="${line}" class="sp-all"/><path d="${obs}" class="sp-ok"/></svg>`;
}

// ------------------------------------------------------------------------------------------------ the list

const rowKey = (ev) => `${ev.target.name}|${ev.kind}|${ev.epoch}`;
const HEAD = () => `<div class="ev-head" aria-hidden="true"><span title="${esc('0 to 100: coverage 40, baseline 15, altitude 20, signal (depth and brightness) 20, Moon 5. The bar under it is the coverage. Hover a score for its parts.')}">Score</span><span>Planet</span><span>Start – mid – end <b>${esc(F.tzShort)}</b></span><span title="Altitude over the region of interest; the event is tinted, the dashed line is your limit">Altitude</span><span title="Dark time adjoining the start and the end, above the altitude limit; ${P.base} h wanted for transits and eclipses">Dark before / after</span><span></span><span></span></div>`;
function row(ev, i) {
  const t = ev.target, r = t.row, c = cls(ev), B = ev.baselineWanted, open = A.open.has(rowKey(ev));
  const tm = (jd, ok) => `<span class="${ok ? '' : 'off'}">${F.local(jd)}</span>`;
  const estT = r.est.t14 && !isLong(ev), estD = r.est.depth;
  const word = c === 'full' ? 'observable' : c === 'short' ? (B > 0 ? 'short baseline' : 'timing margin cut') : `partial · ${pct(ev.coverage)}% of the ${isLong(ev) ? 'window' : KIND[ev.kind].word}`;
  const short = B > 0 && (ev.before < B - 1e-6 || ev.after < B - 1e-6);
  return `<div class="ev ${c} k-${ev.kind}${ev === A.selected ? ' sel' : ''}${open ? ' open' : ''}" data-i="${i}" role="button" tabindex="0" aria-pressed="${ev === A.selected}">` +
    scoreHtml(ev.score, ev) +
    `<span class="c c-name"><span class="nm">${esc(t.name)}</span> ${kindBadge(ev.kind)}${ev.assumed ? '<span class="as" title="' + esc(ev.assumed) + '">e?</span>' : ''}` +
    `<small>${fin(t.mag) ? `${t.band} ${t.mag.toFixed(1)}` : ''}${fin(t.depth) ? `${fin(t.mag) ? ' · ' : ''}<span class="${estD ? 'est' : ''}">${estD ? '~' : ''}${(t.depth * 1000).toFixed(1)} ppt</span>` : ''} ${srcTag(t)}</small></span>` +
    `<span class="c c-time" data-l="Start – mid – end (${esc(F.tzShort)})"><span class="v">${tm(ev.ingress, ev.ingressObs)}<i>–</i>${F.local(ev.mid)}<i>–</i>${tm(ev.egress, ev.egressObs)}</span><small><span class="${estT ? 'est' : ''}">${estT ? '~' : ''}${hours(ev.egress - ev.ingress)}</span>${ev.kind === 'eclipse' ? ` · phase ${ev.phase.toFixed(3)}` : ''}</small></span>` +
    `<span class="c c-alt" data-l="Altitude">${sparkline(ev)}<small>${deg(ev.altIngress)}→${deg(ev.altMid)}→${deg(ev.altEgress)} · ${compass(ev.azIngress)}→${compass(ev.azEgress)}</small></span>` +
    `<span class="c c-base${short ? ' shortb' : ''}" data-l="Dark before / after" title="${B > 0 ? `${P.base} h wanted each side` : 'no baseline wanted for a phase window'}"><span class="v">${hours(ev.before).replace(' h', '')} / ${hours(ev.after)}</span><small title="${esc(`Region of interest ${F.local(ev.roiStart)}–${F.local(ev.roiEnd)}: ${pct(ev.roiCoverage)}% observable` + (ev.lost.length ? '. Lost: ' + lostText(ev, true) : ''))}"><b>${word}</b></small></span>` +
    `<span class="c c-go"><a href="${esc(skyUrl(ev))}" title="Open the sky view at mid-${esc(KIND[ev.kind].word)} from this site">Sky view</a></span>` +
    `<button type="button" class="ev-tog" aria-expanded="${open}" aria-label="More about this ${esc(KIND[ev.kind].word)}" title="More"><i></i></button>` +
    (open ? rowMore(ev) : '') + '</div>';
}
/** The expanded part of a row: everything that is not a column. */
function rowMore(ev) {
  const t = ev.target, sm = ev.sigma * 1440, K = KIND[ev.kind];
  const orbit = ev.kind === 'transit' || ev.kind === 'custom' ? '' : `<dt>Orbit</dt><dd>${fin(t.ecc) ? `e = ${t.ecc}${t.eccErr ? ' ± ' + t.eccErr.toPrecision(2) : ''}` : 'e not catalogued'}${fin(t.omega) ? `, ω = ${t.omega}°${t.omegaErr ? ' ± ' + t.omegaErr.toPrecision(2) : ''}` : ''}${ev.assumed ? ` <span class="warn">(${esc(ev.assumed)})</span>` : ''}</dd>`;
  return `<dl class="ev-x">` +
    `<dt>UTC</dt><dd>${F.utc(ev.ingress)} – ${F.utc(ev.mid)} – ${F.utc(ev.egress)} · ${esc(F.dayUtc(ev.mid))}</dd>` +
    `<dt>Region</dt><dd>${F.local(ev.roiStart)} – ${F.local(ev.roiEnd)}${ev.lost.length ? ` · <span class="warn">lost ${esc(lostText(ev, true))}</span>` : ' · all observable'}</dd>` +
    `<dt>Timing</dt><dd>${t.hasErr ? `± ${minutes(sm)} (1σ) after ${Math.abs(ev.epoch)} orbits` : 'no errors quoted on P or T₀'}${ev.pad > 0 ? '; the region is widened by this much' : ''} · ${esc(t.eph.ref || SOURCES.find((x) => x.id === t.eph.cat).label)}</dd>` + orbit +
    `<dt>Moon</dt><dd>${Math.round(100 * ev.moon.illum)}% lit, ${deg(ev.moon.sep)} away, ${ev.moon.alt > 0 ? 'up ' + deg(ev.moon.alt) : 'below the horizon'} at mid-${esc(K.word)}</dd>` +
    `<dt>Score</dt><dd>${esc(scoreTip(ev.score).split('. A ranking')[0])}</dd></dl>`;
}

function nightHeader(noon) {
  const s = site(), tw = O.twilight(noon, s), d = A.dark.find(([a, b]) => b > noon && a < noon + 1), ill = O.moonIllumination(noon + 0.5);
  return `<h2 class="night"><b>${esc(F.day(noon))}</b><span>${d ? `dark ${F.local(Math.max(d[0], noon))}–${F.local(Math.min(d[1], noon + 1))} (${hours(Math.min(d[1], noon + 1) - Math.max(d[0], noon))})` : 'never dark enough'}` +
    `${tw.sun.evening ? ` · sunset ${F.local(tw.sun.evening)}` : ''}${tw.sun.morning ? ` · sunrise ${F.local(tw.sun.morning)}` : ''} · Moon ${Math.round(100 * ill.fraction)}%</span></h2>`;
}
/** html of the shown events, with a header per night when they are in time order. each(ev, i) -> html of one. */
function byNight(each, wrap = (h) => h) {
  const s = site();
  if (P.sort !== 'time') return wrap(A.shown.map(each).join(''));
  let html = '', last = null, buf = '';
  A.shown.forEach((e, i) => { const noon = O.noonBefore(e.mid, s.lon); if (noon !== last) { if (buf) html += wrap(buf); buf = ''; html += nightHeader(noon); last = noon; } buf += each(e, i); });
  return html + (buf ? wrap(buf) : '');
}

// ------------------------------------------------------------------------------------------------ the grid of charts

function tile(ev, i) {
  const t = ev.target, c = cls(ev);
  return `<div class="tile ${c}${ev === A.selected ? ' sel' : ''}" data-i="${i}" role="button" tabindex="0" aria-pressed="${ev === A.selected}">` +
    `<div class="t-head"><span class="nm">${esc(t.name)}</span>${kindBadge(ev.kind)}${t.candidate ? '<span class="tag toi" title="TESS candidate, not a confirmed planet">TOI</span>' : ''}<span class="t-roi ${c}" title="${esc(ev.lost.length ? 'Lost: ' + lostText(ev, true) : 'The whole region of interest is observable')}">${pct(ev.roiCoverage)}%</span></div>` +
    `<div class="t-sub">${F.local(ev.ingress)} – ${F.local(ev.mid)} – ${F.local(ev.egress)}${fin(t.mag) ? ` · ${t.band} ${t.mag.toFixed(1)}` : ''}${fin(t.depth) ? ` · ${(t.depth * 1000).toFixed(1)} ppt` : ''}</div>` +
    `<div class="t-charts"><canvas class="t-alt" aria-label="Altitude of ${esc(t.name)} through the night"></canvas><canvas class="t-sky" aria-label="Track of ${esc(t.name)} across the sky"></canvas></div>` +
    (ev.full ? '' : `<div class="t-lost">${esc(lostText(ev))}</div>`) + '</div>';
}
let tileObserver = null;
function paintTile(el) {
  const ev = A.shown[+el.dataset.i], ca = el.querySelector('.t-alt'), cs = el.querySelector('.t-sky');
  if (!ev || !ca || el.dataset.done) return;
  el.dataset.done = '1';
  const s = site(), D = nightData(ev, s, A.info.opts, nightFrame(O.noonBefore(ev.mid, s.lon), s));        // the frame is shared by the night: same axes on every tile
  const box = el.querySelector('.t-charts').clientWidth, sky = Math.min(132, Math.max(96, Math.round(box * 0.36))), w = Math.max(150, box - sky - 6), h = sky;
  renderAltitude(prepareCanvas(ca, w, h), w, h, D, F, THEME, { compact: true });
  renderSkyTrack(prepareCanvas(cs, sky, sky), sky, D, THEME, { compact: true });
}
function watchTiles() {
  if (tileObserver) tileObserver.disconnect();
  tileObserver = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) { paintTile(e.target); tileObserver.unobserve(e.target); } }, { rootMargin: '300px' });
  document.querySelectorAll('#p-list .tile').forEach((el) => tileObserver.observe(el));
}
const GRID_LEGEND = () => `<div class="d-legend g-legend">${legendHtml(true)}<span class="lg-note">Every chart of a night has the same axes: altitude 0–90°, half an hour before sunset to half an hour after sunrise (${esc(F.tzShort)}). Compass: zenith at the centre, north up, east left.</span></div>`;
const kindKey = () => kindsOn().map((k) => `<span><i class="k-ev" style="background:${KIND_COLOUR[k]}66;border-color:${KIND_COLOUR[k]}"></i>${KIND[k].word}</span>`).join('');
function legendHtml(short) {
  // the sky's shades in two words: day, and twilight (the three twilights shade from one to the other); night is the dark
  return `<span><i class="k-sky" style="background:${THEME.sky[0]}"></i>day</span><span><i class="k-sky" style="background:linear-gradient(90deg, ${THEME.sky[1]}, ${THEME.sky[3]})"></i>twilight</span>` +
    kindKey() + '<span><i class="k-roi"></i>region of interest</span><span><i class="k-in"></i>start, end</span><span><i class="k-mid"></i>mid</span><span><i class="k-lim"></i>altitude limit</span><span><i class="k-moon"></i>Moon</span>' +
    '<span><i class="k-ok"></i>observable</span><span><i class="k-tw"></i>lost to twilight</span><span><i class="k-lo"></i>lost to altitude</span>' + (A.info && A.info.opts.horizon ? '<span><i class="k-terrain"></i>terrain</span>' : '') + (short ? '' : '<span><i class="k-sig"></i>± 1σ timing</span>');
}

// ------------------------------------------------------------------------------------------------ the ephemerides in use

/** One record per listed event: the ephemeris it was predicted from and what that gives at its epoch. */
function ephemerisRows() {
  return A.shown.map((ev) => {
    const t = ev.target, e = t.eph, o = e.other, shift = ev.bjd - (t.tmid + ev.epoch * t.per), phase = ev.phase;   // shift: from the transit to the centre of the event (with the light time)
    let dOther = null, nO = 0;
    if (o) { nO = Math.round((ev.bjd - shift - o.tmid) / o.per); dOther = (o.tmid + shift + nO * o.per - ev.bjd) * 1440; }
    return { ev, event: ev.kind, phase, assumed: ev.assumed, planet: t.name, catalogue: SOURCES.find((s) => s.id === e.cat).label, reference: e.ref || '', t0: e.tmid, t0Err: e.tmidErr || null, tsys: e.tsys || '', per: e.per, perErr: e.perErr || null,
      epoch: ev.epoch, bjd: ev.bjd, utc: iso(ev.mid), sigmaMin: t.hasErr ? ev.sigma * 1440 : null, how: e.how, kind: e.kind, otherRef: o ? o.ref : '', dOther, otherSigma: o && o.hasErr ? O.midTimeUncertainty(nO + phase, o.tmidErr, o.perErr) * 1440 : null };
  });
}
const num = (x, d) => (x == null || !fin(x) ? '' : d == null ? String(x) : x.toFixed(d));
const errDays = (x) => (x ? (x < 1e-4 ? x.toExponential(1) : x.toPrecision(2)).replace(/e-0?/, 'e−') : '—');
function ephTable() {
  const R = ephemerisRows(), nBest = R.filter((r) => r.kind === 'best').length, nDef = R.filter((r) => r.kind === 'default').length, nComp = R.filter((r) => r.kind === 'composite').length, nCat = R.filter((r) => r.kind === 'catalogue').length;
  const big = R.filter((r) => r.dOther != null && r.sigmaMin != null && Math.abs(r.dOther) > 3 * Math.hypot(r.sigmaMin, r.otherSigma || 0) && Math.abs(r.dOther) > 2).length;
  const tsys = (s) => (!s ? '<span class="warn" title="The catalogue does not say; treated as BJD-TDB">not stated</span>' : /^BJD(-TDB)?$/.test(s) ? esc(s) + (s === 'BJD' ? '<span class="warn" title="BJD without a time scale: treated as BJD-TDB (UTC would be 69 s earlier)">*</span>' : '') : `<span class="warn" title="Not converted: treated as BJD-TDB">${esc(s)}</span>`);
  const otherName = P.eph === 'best' ? 'archive default' : 'best-timed pair';
  return '<div class="eph-intro"><p>The ephemerides behind the times on this page: <b>T(N) = T₀ + (N + φ)·P</b>, φ = 0 for a transit and the eclipse phase from e and ω for an eclipse, with <b>σ = √(σ<sub>T₀</sub>² + ((N + φ)·σ<sub>P</sub>)²)</b> (plus the e and ω terms for an eclipse; all taken as uncorrelated). ' +
    (P.eph === 'best' ? `For NASA archive planets the period and epoch are the pair, from <b>one</b> reference, that gives the <b>smallest predicted uncertainty today</b> (${nBest} of the ${R.length} listed events)` : `For NASA archive planets the period and epoch are those of <b>the archive's default parameter set</b> (${nDef} of the ${R.length} listed events)`) +
    (nComp ? `; ${nComp} use the archive's composite values because no single reference qualifies` : '') + (nCat ? `; ${nCat} come from a catalogue with one ephemeris only` : '') +
    `. Choosing by quoted errors favours papers with optimistic errors, so the other choice is shown for comparison in the last columns${big ? `: <span class="warn">${big} listed event${big === 1 ? '' : 's'} differ${big === 1 ? 's' : ''} from the ${otherName} by more than 3σ and 2 minutes</span>` : ''}. ` +
    'Time systems are shown as the catalogue labels them and are <b>not converted</b>: all are treated as BJD<sub>TDB</sub>. These are literature values, not yet validated by ESL\'s own fits.</p>' +
    `<div class="eph-ctl"><label>Ephemeris used <select id="p-eph2"><option value="best"${P.eph === 'best' ? ' selected' : ''}>best-timed pair (smallest predicted σ today)</option><option value="default"${P.eph === 'default' ? ' selected' : ''}>the archive's default parameter set</option><option value="eu"${P.eph === 'eu' ? ' selected' : ''}>exoplanet.eu (best-timed where it has none)</option></select></label><button type="button" class="btn" id="p-csv">Download CSV</button></div></div>` +
    '<div class="eph-scroll xscroll" tabindex="0" role="region" aria-label="Ephemerides in use (scrolls sideways)"><table class="eph"><thead><tr><th class="l">Planet</th><th class="l">Event</th><th title="Orbital phase of the centre of the event, after mid-transit">φ</th><th class="l">Reference</th><th>T₀</th><th>± d</th><th class="l">Time system</th><th>Period d</th><th>± d</th><th>N</th><th>Predicted mid BJD</th><th class="l">UTC</th><th>σ mid</th>' +
    `<th class="l sep">${otherName}: reference</th><th>Δ mid</th></tr></thead><tbody>` +
    R.map((r, i) => `<tr data-i="${i}" class="${r.ev === A.selected ? 'sel' : ''}"><td class="l nm">${esc(r.planet)} <span class="tag ${r.ev.target.cat}">${SOURCES.find((s) => s.id === r.ev.target.cat).short}</span></td><td class="l">${kindBadge(r.event)}</td><td${r.assumed ? ` class="warn" title="${esc(r.assumed)}"` : ''}>${r.phase.toFixed(4)}${r.assumed ? '*' : ''}</td><td class="l" title="${esc(r.how)}">${esc(r.reference || '—')}${r.kind === 'composite' ? ' <span class="warn" title="' + esc(r.how) + '">composite</span>' : ''}</td>` +
      `<td>${num(r.t0)}</td><td>${errDays(r.t0Err)}</td><td class="l">${tsys(r.tsys)}</td><td>${num(r.per)}</td><td>${errDays(r.perErr)}</td><td>${r.epoch}</td><td>${r.bjd.toFixed(5)}</td><td class="l">${r.utc.replace('T', ' ').slice(0, 16)}</td>` +
      `<td class="${sigClass(r.sigmaMin)}">${r.sigmaMin == null ? '?' : '± ' + minutes(r.sigmaMin)}</td><td class="l sep">${r.otherRef ? esc(r.otherRef) : r.ev.target.eph.sameAsOther ? '<span class="dim">the same</span>' : '<span class="dim">—</span>'}</td>` +
      `<td class="${r.dOther != null && r.sigmaMin != null && Math.abs(r.dOther) > 3 * Math.hypot(r.sigmaMin, r.otherSigma || 0) && Math.abs(r.dOther) > 2 ? 'warn' : ''}">${r.dOther == null ? '' : (r.dOther >= 0 ? '+' : '−') + minutes(Math.abs(r.dOther))}</td></tr>`).join('') + '</tbody></table></div>';
}
function ephCsv() {
  const q = (s) => (/[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s ?? ''));
  const head = ['planet', 'catalogue', 'reference', 'chosen_by', 'T0', 'T0_err_d', 'time_system_as_listed', 'treated_as', 'period_d', 'period_err_d', 'epoch_N', 'predicted_mid_BJD', 'predicted_mid_UTC', 'sigma_mid_min',
    'ingress_UTC', 'egress_UTC', 'other_choice_reference', 'other_minus_this_min', 'other_sigma_mid_min', 'roi_observable_fraction', 'event', 'phase_of_centre', 'assumed'];
  const lines = ephemerisRows().map((r) => [r.planet, r.catalogue, r.reference, r.how, r.t0, r.t0Err ?? '', r.tsys, 'BJD_TDB', r.per, r.perErr ?? '', r.epoch, r.bjd.toFixed(6), r.utc, r.sigmaMin == null ? '' : r.sigmaMin.toFixed(3),
    iso(r.ev.ingress), iso(r.ev.egress), r.otherRef, r.dOther == null ? '' : r.dOther.toFixed(3), r.otherSigma == null ? '' : r.otherSigma.toFixed(3), r.ev.roiCoverage.toFixed(4), r.event, r.phase.toFixed(6), r.assumed || ''].map(q).join(','));
  return head.join(',') + '\n' + lines.join('\n') + '\n';
}
window.__plan.ephCsv = ephCsv;
function downloadCsv() {
  const a = document.createElement('a'), name = (curSite() ? curSite().id : 'custom') + '-' + isoDate(A.info.jd0);
  a.href = URL.createObjectURL(new Blob([ephCsv()], { type: 'text/csv' })); a.download = `esl-ephemerides-${name}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------------------------------------ drawing

function draw() {
  if (A.cleared) { drawCleared(); return; }
  const I = A.info;
  const ev = A.events.slice();
  if (P.sort === 'score') ev.sort((a, b) => b.score.total - a.score.total || a.mid - b.mid);
  else if (P.sort === 'sigma') ev.sort((a, b) => (b.target.hasErr ? b.sigma : -1) - (a.target.hasErr ? a.sigma : -1) || a.mid - b.mid);
  else if (P.sort === 'depth') ev.sort((a, b) => (b.target.depth || 0) - (a.target.depth || 0) || a.mid - b.mid);
  else if (P.sort === 'mag') ev.sort((a, b) => (fin(a.target.mag) ? a.target.mag : 99) - (fin(b.target.mag) ? b.target.mag : 99) || a.mid - b.mid);
  A.shown = ev.slice(0, MAX_SHOWN);
  const nFull = ev.filter((e) => e.full).length, nShort = ev.filter((e) => !e.full && e.transitFull).length, nPart = ev.length - nFull - nShort;
  const ks = kindsOn(), byKind = ks.length > 1 ? ' <span class="more">(' + ks.map((k) => { const m = ev.filter((e) => e.full && e.kind === k).length; return `${m} ${{ transit: 'transit', eclipse: 'eclipse', phase: 'phase window', custom: 'custom window' }[k]}${m === 1 ? '' : 's'}`; }).join(', ') + ')</span>' : '';
  const noun = ks.length === 1 ? { transit: 'transit', eclipse: 'eclipse', phase: 'phase-curve window', custom: 'phase window' }[ks[0]] : 'event';
  $('p-count').innerHTML = `<b>${nFull} observable ${noun}${nFull === 1 ? '' : 's'}</b>${byKind}` + (nShort ? ` <span class="more">· ${nShort} short baseline</span>` : '') + (nPart ? ` <span class="more">· ${nPart} partial</span>` : '') +
    `<span class="of">${single ? ' · next 12 months' : ` · ${I.ntargets.toLocaleString('en')} targets · ${I.n} night${I.n > 1 ? 's' : ''}`}</span>`;
  let html;
  if (!ev.length) html = `<p class="p-empty">${single && !A.singleRow ? `No planet called “${esc(single)}” in the catalogues.` : single && A.singleRow && !(A.singleRow.v.t14 > 0 && A.singleRow.v.per > 0 && fin(A.singleRow.v.tmid)) ? `${esc(A.singleRow.name)} has no transit ephemeris (period, mid-transit time and duration) in the catalogues, so its transits cannot be predicted.` : `Nothing meets these limits. ${P.show === 'roi' ? 'Show “+ short baseline” too, l' : 'L'}oosen the magnitude or depth limit, lower the altitude limit or add nights.${ks.includes('phase') ? ` Phase windows are ${P.phSpan * 24 * P.phMaxPer > 10 ? 'long: try a shorter span, “+ partial” or a lower period limit' : 'listed only for periods up to ' + P.phMaxPer + ' d'}.` : ''}`}</p>`;
  else if (P.view === 'grid') html = GRID_LEGEND() + byNight(tile, (h) => `<div class="tiles">${h}</div>`);
  else if (P.view === 'eph') html = ephTable();
  else html = HEAD() + byNight(row);
  if (ev.length > MAX_SHOWN) html += `<p class="p-empty">Showing the first ${MAX_SHOWN} of ${ev.length}. Narrow the limits or sort differently to see the rest.</p>`;
  const list = $('p-list');
  list.className = 'p-list v-' + P.view; list.innerHTML = html;
  if (P.view === 'grid' && ev.length) watchTiles();
  document.querySelectorAll('.p-views button').forEach((b) => { const on = b.dataset.view === P.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });

  const notes = [];
  if (Object.keys(A.failed).length) notes.push(`<span class="hl" role="alert">Not loaded, so not listed: ${esc(failedText())}. Change a setting or reload to try again.</span>`);
  if (!P.chosen && !single) notes.push(`Showing <b>${esc(FALLBACK_SITE.name)}</b> until you pick a site.`);
  const asm = ev.filter((e) => e.assumed).length; if (asm) notes.push(`<span class="hl">${asm} eclipse${asm === 1 ? '' : 's'} assume${asm === 1 ? 's' : ''} a circular orbit</span> (marked e?).`);
  $('p-note').innerHTML = notes.join(' ');
  summaries();
  drawSite();
  drawDetail();
}

/** After Reset: settings back to their defaults, no list until asked for (or until a setting changes). */
function drawCleared() {
  A.shown = [];
  $('p-count').innerHTML = '<b>Cleared</b><span class="of"> · settings back to their defaults</span>';
  $('p-note').innerHTML = '';
  const list = $('p-list'); list.className = 'p-list v-' + P.view;
  list.innerHTML = `<div class="p-empty p-cleared"><p>The list and results are cleared. Choose a site, dates and limits, or show the transits for ${esc(curSite() ? curSite().name : 'the default site')} now.</p><button type="button" class="btn primary" id="p-show">Show transits</button></div>`;
  $('p-show').addEventListener('click', () => { A.cleared = false; draw(); });
  summaries(); drawSite(); drawDetail();
}
function resetAll() {
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, JSON.parse(JSON.stringify(DEFAULTS)), { disc: DM.parseFilter(DEFAULTS.disc) });
  A.open.clear(); A.selected = null; A.cleared = true;
  fillForm();
  const o = curSite(); if (o && globe) globe.lookAt(o.lat, o.lon);
  recompute(0, true);
}

function summaries() {
  const c = curSite();
  $('p-site-sum').textContent = `${c ? c.name : 'custom'} · ${Math.abs(P.lat).toFixed(2)}°${P.lat >= 0 ? 'N' : 'S'} ${Math.abs(P.lon).toFixed(2)}°${P.lon >= 0 ? 'E' : 'W'}`;
  $('p-dates-sum').textContent = single ? 'next 12 months' : `${F.day(startNoon())} + ${A.info ? A.info.n : P.nights} night${P.nights > 1 ? 's' : ''}`;
  $('p-limits-sum').textContent = `alt ≥ ${P.minAlt}° · Sun ≤ ${P.sun === -0.833 ? '0' : P.sun}° · ${P.base} h`;
  $('p-targets-sum').textContent = (['nea', 'toi', 'eu'].filter((k) => P.src[k]).map((k) => SOURCES.find((x) => x.id === k).short).join(' + ') || 'none') + (P.disc === DM.GROUP_IDS ? '' : ' · ' + DM.GROUPS.filter((g) => P.disc.includes(g.id)).map((g) => g.short).join(' '));
  $('p-crit-t').title = plain(`Observable = ${criteria()}.`);
}
const plain = (html) => html.replace(/<[^>]+>/g, '');
// ---- the site card: globe, where and what the site is, tonight, and the links the crawler found working
function resourcesHtml(c) {
  const R = A.obs.resources, r = R && c && R.sites[c.id];
  if (!c) return '<p class="s-res none">A site typed by hand has no observatory links. Pick an observatory on the globe to see its archive, all-sky camera and weather pages. Networks without fixed sites (Unistellar, Exoplanet Watch and AAVSO observers at home) plan from their own coordinates, as here.</p>';
  if (!R) return '';
  if (!r) return `<p class="s-res none">No public archive, all-sky camera or weather page of this site answered when they were looked for on ${esc(R.date)}.</p>`;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const group = (kind, label) => (r[kind] && r[kind].length ? `<div class="s-rg"><span class="s-rl">${label}</span><span class="s-links">${r[kind].map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="${esc(e.url)}">${esc(e.label || host(e.url))}<small>${esc(host(e.url))}</small></a>`).join('')}</span></div>` : '');
  return `<div class="s-res">${group('allsky', 'All-sky camera')}${group('weather', 'Weather')}${group('archive', 'Data archive')}<p class="s-chk">These links answered on ${esc(R.date)}; they open the observatory's own pages.</p></div>`;
}
/** The live all-sky image, only where the crawler found that the headers, the freshness and the published terms allow showing it here. */
function camHtml(c) {
  const R = A.obs.resources, r = R && c && R.sites[c.id], img = r && (r.allsky || []).map((e) => e.image).find((i) => i && i.embed);
  if (!img) return '';
  const host = new URL(img.url).hostname.replace(/^www\./, '');
  return `<figure class="s-cam"><a href="${esc(img.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(img.url)}" alt="Latest all-sky camera image of ${esc(c.name)}" loading="lazy" width="190" height="190" onerror="this.closest('figure').hidden=true"></a><figcaption>All-sky camera, live from ${esc(host)}${img.terms ? `<br>${esc(img.terms.licence)}` : ''}</figcaption></figure>`;
}
let siteKey = '';
function drawSite() {
  const c = curSite(), s = site(), I = A.info;
  const jd = A.selected ? A.selected.mid : I ? I.jd0 + 0.5 : O.jdFromDate(clock.now());
  if (globe) {
    globe.set({ jd, selected: c ? c.id : null, user: c ? null : { lat: P.lat, lon: P.lon } });
    $('p-gcap').innerHTML = `Night side at <b>${esc(F.local(jd))}</b> ${esc(F.tzShort)} (${iso(jd).slice(0, 16).replace('T', ' ')} UTC), ${A.selected ? `mid-${esc(KIND[A.selected.kind].word)} of ${esc(A.selected.target.name)}` : 'the middle of the first night'}.` +
      `<span class="g-key"><i style="background:${GLOBE_COLOURS.pro}"></i>professional<i style="background:${GLOBE_COLOURS.net}"></i>network node<i style="background:${GLOBE_COLOURS.remote}"></i>remote hosting<i class="dm"></i>your site</span>`;
  }
  const key = [P.obs, P.lat, P.lon, P.elev, P.tz, I && I.jd0, P.sun].join('|');
  if (key === siteKey) return;
  siteKey = key;
  const M = A.obs.meta, src = c && M.sources && M.sources[c.src];
  const tw = I ? O.twilight(I.jd0, s) : null, d = I && A.dark ? A.dark.find(([a, b]) => b > I.jd0 && a < I.jd0 + 1) : null;
  $('p-sinfo').innerHTML = `<h2>${esc(c ? c.name : 'Your site')}</h2>` +
    `<div class="s-sub">${c ? `${esc(KIND_LABEL[c.kind] || '')}${c.nets && c.nets.length ? ' · ' + c.nets.map(esc).join(', ') : ''}` : 'coordinates typed by hand or from this device'}</div>` +
    '<dl class="s-facts">' +
    `<dt>Position</dt><dd>latitude ${Math.abs(P.lat).toFixed(4)}° ${P.lat >= 0 ? 'N' : 'S'}<br>longitude ${Math.abs(P.lon).toFixed(4)}° ${P.lon >= 0 ? 'E' : 'W'}<br>altitude ${Math.round(P.elev || 0)} m</dd>` +
    `<dt>Time zone</dt><dd>${esc(F.tzLabel)}</dd>` +
    (tw ? `<dt>First night</dt><dd>${d ? `${sunName()} <b>${F.local(Math.max(d[0], I.jd0))} – ${F.local(Math.min(d[1], I.jd0 + 1))}</b> (${hours(Math.min(d[1], I.jd0 + 1) - Math.max(d[0], I.jd0))})` : 'the Sun does not get that low'}${tw.sun.evening ? `, sunset ${F.local(tw.sun.evening)}` : ''}${tw.sun.morning ? `, sunrise ${F.local(tw.sun.morning)}` : ''}</dd>` : '') +
    (c ? `<dt>Coordinates from</dt><dd>${c.src === 'mpc' ? `Minor Planet Center observatory code ${esc(c.key)} (“${esc(c.listed)}”)` : `astropy site registry, “${esc(c.listed)}”`}${src && M.date ? `, read ${esc(M.date)}` : ''}${c.tzNote ? `; time zone from the coordinates (${esc(c.tzNote)})` : ''}</dd>` : '') +
    '</dl>' + resourcesHtml(c);
  $('p-sside').innerHTML = camHtml(c);
  $('p-sbname').textContent = `${c ? c.name : 'your site'} · ${Math.abs(P.lat).toFixed(2)}°${P.lat >= 0 ? 'N' : 'S'} ${Math.abs(P.lon).toFixed(2)}°${P.lon >= 0 ? 'E' : 'W'}`;
}

// ---- the selected event: chart, sky track, numbers
/** Hand the selected event to the Run page as an observing sequence (src/core/sequence.js fromPlanEvent). */
function observeEvent(ev) {
  const c = curSite(), s = { ...site(), name: c ? c.name : 'Custom site', tz: c ? c.tz : timeZone() };
  try {
    const seq = fromPlanEvent(ev, s, { planMinAlt: P.minAlt, limits: { sunMax: Math.min(-12, P.sun + 6) } });
    localStorage.setItem('esl.sequence.handoff', JSON.stringify(seq));
    location.href = new URL('observe/run/?from=plan', siteRoot()).href;
  } catch (err) { status('Could not make a sequence: ' + err.message); }
}
function drawDetail() {
  const el = $('p-detail'), ev = A.selected;
  document.querySelectorAll('#p-list .sel').forEach((b) => { b.classList.remove('sel'); b.setAttribute('aria-pressed', 'false'); });
  if (!ev) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('has-detail'); return; }
  const i = A.shown.indexOf(ev), btn = i >= 0 && $('p-list').querySelector(`[data-i="${i}"]`);
  if (btn) { btn.classList.add('sel'); btn.setAttribute('aria-pressed', 'true'); }
  const t = ev.target, r = t.row, s = site(), q = encodeURIComponent(t.name), sm = ev.sigma * 1440, base = ev.baselineWanted, e = t.eph, K = KIND[ev.kind];
  const ref = e.ref || SOURCES.find((x) => x.id === e.cat).label, tsys = e.tsys || '';
  // what to observe: the region of interest (it already includes one sigma on each side), cut to what is dark and above the limit
  const want0 = ev.roiStart, want1 = ev.roiEnd, run0 = Math.max(want0, ev.ingressObs ? ev.ingress - ev.before : ev.obsStart ?? ev.ingress), run1 = Math.min(want1, ev.egressObs ? ev.egress + ev.after : ev.obsEnd ?? ev.egress);
  const row = (name, jd, alt, az, ok) => `<tr class="${ok ? '' : 'off'}"><td>${name}</td><td><b>${F.local(jd)}</b></td><td>${F.utc(jd)}</td><td>${alt.toFixed(0)}°</td><td>${compass(az)} ${az.toFixed(0)}°</td><td>${airmassText(alt)}</td><td>${ok ? '' : O.sunAltAz(jd, s).alt > P.sun ? 'not dark' : 'too low'}</td></tr>`;
  const at = (jd) => O.altAz(t.ra, t.dec, jd, s), okAt = (jd) => at(jd).alt >= P.minAlt && O.sunAltAz(jd, s).alt <= P.sun;
  const a0 = at(ev.roiStart), a1 = at(ev.roiEnd);
  const est = (k) => (r.est[k] ? ` <span class="est" title="${esc(RELATIONS[r.est[k].rel].name + ' [' + RELATIONS[r.est[k].rel].cite + ']' + (r.est[k].note ? '. ' + r.est[k].note : ''))}">estimated: ${esc(RELATIONS[r.est[k].rel].cite)}</span>` : '');
  const c = cls(ev);
  el.hidden = false; document.body.classList.add('has-detail');
  el.innerHTML = `<div class="d-head"><div><h2>${esc(t.name)} ${kindBadge(ev.kind)}</h2><div class="d-sub">Night of ${esc(F.day(O.noonBefore(ev.mid, s.lon)))} · ${esc(F.dayUtc(ev.mid))} UTC · orbit ${ev.epoch} since T₀</div></div><button class="d-close" type="button" aria-label="Close">✕</button></div>` +
    `<div class="d-roi ${c}"><div class="d-roi-top">${roiBar(ev)}<b>${pct(ev.roiCoverage)}%</b> of the region of interest observable</div>` +
    `<div>${c === 'full' ? `<b>Observable:</b> ${F.local(ev.roiStart)} – ${F.local(ev.roiEnd)} is dark and above ${P.minAlt}° throughout.` : `${c === 'short' ? `The ${isLong(ev) ? 'window' : K.word} itself is complete, but the ${base > 0 ? 'baseline' : 'timing margin'} is cut` : `Only ${pct(ev.coverage)}% of the ${isLong(ev) ? 'window' : K.word} can be observed`}. Lost: ${esc(lostText(ev, true))}.`}</div></div>` +
    `<div class="d-links"><a class="btn primary" href="${esc(skyUrl(ev))}">Sky view at this ${esc(K.word)}</a><button class="btn" type="button" id="d-observe" title="Make an observing sequence for this window (cooling, calibration, light frames between the start and the end) and open it in Run">Observe this event</button><a class="btn" href="../analyze/?planet=${q}">Analyze</a><a class="btn" href="../search/?planet=${q}">Catalogue entry</a>${single ? '' : `<a class="btn" href="?planet=${q}">All its events</a>`}</div>` +
    (t.hasErr && sm > 10 ? `<div class="d-flag ${sigClass(sm)}"><b>Timing uncertain by ± ${minutes(sm)} (1σ).</b> The ephemeris (${esc(ref)}) has drifted over ${Math.abs(ev.epoch)} orbits. ${ev.kind === 'transit' ? 'A mid-transit time from this event would tighten it: start early, end late.' : 'The region of interest is widened by this much on each side.'}</div>` : '') +
    `<canvas id="p-alt" class="p-canvas" aria-label="Altitude of the target through the night, with twilight, the region of interest, the ${esc(K.word)} and the Moon"></canvas>` +
    `<div class="d-legend">${legendHtml(false)}</div>` +
    `<table class="d-times"><tr><th></th><th>${esc(F.tzShort)}</th><th>UTC</th><th>Alt</th><th>Az</th><th>Air mass</th><th></th></tr>${ev.roiStart < ev.ingress - 1e-6 ? row('Region start', ev.roiStart, a0.alt, a0.az, okAt(ev.roiStart)) : ''}${row(K.start, ev.ingress, ev.altIngress, ev.azIngress, ev.ingressObs)}${row('Mid', ev.mid, ev.altMid, ev.azMid, okAt(ev.mid))}${row(K.end, ev.egress, ev.altEgress, ev.azEgress, ev.egressObs)}${ev.roiEnd > ev.egress + 1e-6 ? row('Region end', ev.roiEnd, a1.alt, a1.az, okAt(ev.roiEnd)) : ''}</table>` +
    `<div class="d-split"><figure class="d-sky"><canvas id="p-sky" class="p-canvas" aria-label="Track of the target across the sky"></canvas><figcaption>Looking up: zenith at the centre, north up, east left. White: the ${esc(K.word)}; bright: the region of interest; thin: the rest of the night.</figcaption></figure><dl class="d-facts">` +
    `<dt>Suggested run</dt><dd><b>${F.local(run0)} – ${F.local(run1)}</b> (${hours(run1 - run0)})${run0 > want0 + 1e-4 || run1 < want1 - 1e-4 ? ', cut short by twilight or the altitude limit' : ', covers the region of interest'}</dd>` +
    `<dt>Mid-time</dt><dd>BJD<sub>TDB</sub> ${ev.bjd.toFixed(5)} ${t.hasErr ? `± ${minutes(sm)}` : '(no errors quoted)'}</dd>` +
    `<dt>Ephemeris</dt><dd>${esc(ref)}: P = ${t.per} d${t.perErr ? ` ± ${(t.perErr * 86400).toPrecision(2)} s` : ''}, T₀ = ${t.tmid}${t.tmidErr ? ` ± ${minutes(t.tmidErr * 1440)}` : ''}<br><span class="dim">chosen as ${esc(e.how)}</span>${tsys && !/^BJD(-TDB)?$/.test(tsys) ? `<br><span class="warn">time system listed as ${esc(tsys)}, treated as BJD-TDB</span>` : ''}</dd>` +
    (ev.kind !== 'transit' ? `<dt>${esc(K.badge)}</dt><dd>${hours(ev.egress - ev.ingress)}, centre at phase ${ev.phase.toFixed(4)}${ev.kind === 'eclipse' || (ev.kind === 'phase' && P.phCenter === 'eclipse') ? `; e ${fin(t.ecc) ? '= ' + t.ecc : 'not catalogued'}${fin(t.omega) ? ', ω = ' + t.omega + '°' : ''}${ev.assumed ? ` <span class="warn">(${esc(ev.assumed)})</span>` : ''}${fin(t.teq) ? `; T<sub>eq</sub> ${Math.round(t.teq)} K` : ''}` : ''}</dd>` : '') +
    `<dt>Transit</dt><dd>${hours(t.t14)}${est('t14')}${fin(t.depth) ? `, depth ${(t.depth * 1000).toFixed(2)} ppt (${(t.depth * 1085.7).toFixed(1)} mmag)${est('depth')}` : ''}</dd>` +
    `<dt>Star</dt><dd>${fin(t.mag) ? `${t.band} = ${t.mag.toFixed(2)} · ` : ''}${hms(t.ra)} ${dms(t.dec)}</dd>` +
    `<dt>Dark baseline</dt><dd>${hours(ev.before)} before, ${hours(ev.after)} after${base > 0 ? ` (wanted ${P.base} h)` : ''}</dd>` +
    `<dt>Moon</dt><dd>${Math.round(100 * ev.moon.illum)}% lit, ${ev.moon.sep.toFixed(0)}° from the target, ${ev.moon.alt > 0 ? `${ev.moon.alt.toFixed(0)}° up` : 'below the horizon'} at mid-${esc(K.word)}</dd>` +
    `<dt>Score</dt><dd>${esc(scoreTip(ev.score).split('. A ranking')[0].replace(/^Score /, ''))}</dd>` +
    '</dl></div>';
  el.querySelector('.d-close').addEventListener('click', () => select(null));
  el.querySelector('#d-observe')?.addEventListener('click', () => observeEvent(ev));
  paintCharts();
}
function paintCharts() {
  const ev = A.selected, c1 = $('p-alt'), c2 = $('p-sky');
  if (!ev || !c1) return;
  const D = nightData(ev, site(), A.info.opts), w = Math.max(280, c1.parentElement.clientWidth - 2), h = Math.round(Math.min(320, Math.max(220, w * 0.52)));
  renderAltitude(prepareCanvas(c1, w, h), w, h, D, F);
  const size = Math.min(260, Math.max(200, Math.round(w * 0.46)));
  renderSkyTrack(prepareCanvas(c2, size, size), size, D);
}
function select(ev, from = null) {
  A.selected = ev && ev !== A.selected ? ev : null;
  drawDetail(); drawSite();
  // on a narrow screen the detail sits under the list: put it right after the chosen item
  if (A.selected && from && matchMedia('(max-width: 1100px)').matches) { (from.closest('tr') ? $('p-list') : from).after($('p-detail')); $('p-detail').scrollIntoView({ block: 'start', behavior: smooth() }); }
}

// ------------------------------------------------------------------------------------------------ form

function fillForm() {
  $('p-obs').innerHTML = groupSites(A.obs.sites).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</optgroup>`).join('') + '<option value="custom">Other: type coordinates below</option>';
  $('p-obs').value = String(P.obs);
  $('p-lat').value = P.lat; $('p-lon').value = P.lon; $('p-elev').value = P.elev;
  const btz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('p-tz').innerHTML = `<option value="site">observatory</option><option value="lon">longitude (mean solar)</option><option value="browser">this device (${esc(btz)})</option><option value="UTC">UTC</option>`;
  $('p-tz').value = P.tz; $('p-tz').querySelector('[value=site]').disabled = P.obs === 'custom';
  $('p-date').value = P.date === 'auto' ? isoDate(startNoon()) : P.date; $('p-nights').value = P.nights;
  $('p-minalt').value = P.minAlt; $('p-sun').value = String(P.sun); $('p-show').value = P.show; $('p-eph').value = P.eph;
  $('p-magmin').value = P.magMin ?? ''; $('p-magmax').value = P.magMax ?? ''; $('p-depth').value = P.depth || ''; $('p-base').value = P.base;
  for (const k of ['nea', 'toi', 'eu']) $('p-src-' + k).checked = !!P.src[k];
  $('p-terrain').checked = !!P.terrain;
  fillDisc();
  $('p-name').value = P.name; $('p-sort').value = P.sort;
  $('p-phspan').value = String(P.phSpan); $('p-phcenter').value = P.phCenter; $('p-phmax').value = P.phMaxPer; $('p-cfrom').value = P.cFrom; $('p-cto').value = P.cTo;
  fillKinds();
}
/** The discovery-method filter: a chip per group (colour, letter), with how many planets of it have transits to plan. */
function fillDisc() {
  const c = A.discCounts;
  $('p-disc').innerHTML = DM.GROUPS.map((g) => {
    const on = P.disc.includes(g.id), n = c ? c[g.id] : null, off = g.id === 'c' && !P.src.toi;
    const tip = `${g.label}: ${g.note}.` + (n ? ` ${n.targets.toLocaleString('en')} with a transit ephemeris${g.id === 'c' ? '' : `; ${n.none.toLocaleString('en')} more not seen to transit (nothing to plan)`}.` : '') + (off ? ' Tick “TESS candidates” to load them.' : '');
    return `<button type="button" class="dmc" data-g="${g.id}" aria-pressed="${on}" style="--c:${g.color}" title="${esc(tip)}"${off ? ' disabled' : ''}><i class="sw${g.candidate ? ' dash' : ''}">${g.short}</i><span>${n ? n.targets.toLocaleString('en') : ''}</span></button>`;
  }).join('');
  const r = c && c.r, t = c && c.t;
  $('p-disc-note').innerHTML = '';   // the long explanation of the chips was dropped: the chips' titles carry it
}
/** The event selector: which kinds are on, and the options of those that have any. */
function fillKinds() {
  document.querySelectorAll('#p-kinds [data-kind]').forEach((b) => { const on = P.events.includes(b.dataset.kind); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('p-phase-opts').hidden = !P.events.includes('phase'); $('p-custom-opts').hidden = !P.events.includes('custom');
}
/** Set the kinds of event to plan (at least one stays on). Returns the kinds now on. */
function setKinds(list) {
  const want = KINDS.filter((k) => list.includes(k));
  if (!want.length) throw new Error(`choose at least one of ${KINDS.join(', ')}`);
  P.events = want; fillKinds(); return want;
}
function chooseSite(id) {
  P.obs = id; P.chosen = true;
  const o = curSite();
  if (o) { P.lat = o.lat; P.lon = o.lon; P.elev = o.elev; P.tz = 'site'; } else if (P.tz === 'site') P.tz = 'lon';
  fillForm();
  if (o && globe) globe.lookAt(o.lat, o.lon);
}
const numOr = (v, d) => (v === '' || !fin(+v) ? d : +v);
let timer = 0;
function recompute(delay = 0, keepCleared = false) { if (!keepCleared) A.cleared = false; save(); clearTimeout(timer); timer = setTimeout(async () => { await ensureSources(); compute(); }, delay); }
function changed(e) {
  const id = e.target.id;
  if (id === 'p-scale') { P.scale = e.target.value; save(); drawNow(); return; }
  if (id === 'p-obs') chooseSite(e.target.value);
  else if (id === 'p-lat' || id === 'p-lon' || id === 'p-elev') {
    const lat = numOr($('p-lat').value, NaN), lon = numOr($('p-lon').value, NaN);
    if (!(Math.abs(lat) <= 90) || !(lon >= -180 && lon <= 360)) return;
    P.lat = lat; P.lon = lon > 180 ? lon - 360 : lon; P.elev = numOr($('p-elev').value, 0); P.chosen = true;
    if (P.obs !== 'custom') { P.obs = 'custom'; if (P.tz === 'site') P.tz = 'lon'; $('p-obs').value = 'custom'; $('p-tz').value = P.tz; $('p-tz').querySelector('[value=site]').disabled = true; }
  } else if (id === 'p-tz') P.tz = e.target.value;
  else if (id === 'p-date') P.date = e.target.value || 'auto';
  else if (id === 'p-nights') P.nights = Math.max(1, Math.min(90, Math.round(numOr(e.target.value, 3))));
  else if (id === 'p-minalt') P.minAlt = Math.max(0, Math.min(89, numOr(e.target.value, 30)));
  else if (id === 'p-sun') P.sun = +e.target.value;
  else if (id === 'p-show') P.show = e.target.value;
  else if (id === 'p-eph') { P.eph = e.target.value; makeTargets(); }
  else if (id === 'p-magmin') P.magMin = numOr(e.target.value, null);
  else if (id === 'p-magmax') P.magMax = numOr(e.target.value, null);
  else if (id === 'p-depth') P.depth = Math.max(0, numOr(e.target.value, 0));
  else if (id === 'p-base') P.base = Math.max(0, Math.min(6, numOr(e.target.value, 0)));
  else if (id.startsWith('p-src-')) { P.src[id.slice(6)] = e.target.checked; fillDisc(); }
  else if (id === 'p-terrain') { P.terrain = e.target.checked; save(); ensureHorizon(); }
  else if (id === 'p-name') P.name = e.target.value;
  else if (id === 'p-phspan') P.phSpan = +e.target.value;
  else if (id === 'p-phcenter') P.phCenter = e.target.value;
  else if (id === 'p-phmax') P.phMaxPer = Math.max(0.2, Math.min(30, numOr(e.target.value, 3)));
  else if (id === 'p-cfrom') P.cFrom = Math.max(0, Math.min(1, numOr(e.target.value, 0.4)));
  else if (id === 'p-cto') P.cTo = Math.max(0, Math.min(1, numOr(e.target.value, 0.6)));
  else return;
  recompute(e.type === 'input' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' ? 250 : 0);
}

$('p-form').addEventListener('input', changed);
$('p-form').addEventListener('change', changed);
$('p-siteform').addEventListener('input', changed);
$('p-siteform').addEventListener('change', changed);
$('p-sort').addEventListener('change', (e) => { P.sort = e.target.value; save(); draw(); });
$('p-disc').addEventListener('click', (e) => {
  const b = e.target.closest('[data-g]'); if (!b) return;
  const g = b.dataset.g; P.disc = DM.parseFilter(P.disc.includes(g) ? P.disc.replace(g, '') : P.disc + g); fillDisc(); recompute();
});
$('p-kinds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  const k = b.dataset.kind, on = P.events.includes(k);
  if (on && P.events.length === 1) return;                                     // one kind stays on
  setKinds(on ? P.events.filter((x) => x !== k) : [...P.events, k]); recompute();
});
$('p-tonight').addEventListener('click', () => { P.date = 'auto'; A.cleared = false; save(); fillForm(); compute(); });
$('p-resetall').addEventListener('click', resetAll);
$('p-reset').addEventListener('click', () => { for (const k of LIMIT_KEYS) P[k] = DEFAULTS[k]; fillForm(); recompute(); });
document.querySelector('.p-views').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (!b) return; P.view = b.dataset.view; save(); draw(); });
$('p-geo').addEventListener('click', () => {
  const msg = $('p-geo-msg');
  if (!navigator.geolocation) { msg.textContent = 'This browser has no location service.'; return; }
  msg.textContent = 'Asking the browser…';
  navigator.geolocation.getCurrentPosition((pos) => {
    P.lat = +pos.coords.latitude.toFixed(4); P.lon = +pos.coords.longitude.toFixed(4); P.elev = fin(pos.coords.altitude) ? Math.round(pos.coords.altitude) : 0;
    P.obs = 'custom'; P.tz = 'browser'; P.chosen = true; A.cleared = false; save(); fillForm(); compute(); if (globe) globe.lookAt(P.lat, P.lon);
    msg.textContent = 'Using this device\'s position (it stays in this browser).';
  }, (err) => { msg.textContent = err.code === 1 ? 'Permission was not given. Type the coordinates instead.' : 'The position could not be determined. Type the coordinates instead.'; }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600000 });
});
const pick = (e) => {
  if (e.target.closest('a, select, button, label')) return null;
  return e.target.closest('[data-i]');
};
$('p-list').addEventListener('click', (e) => {
  if (e.target.id === 'p-csv') return downloadCsv();
  if (e.target.id === 'p-retry') return recompute();
  const tog = e.target.closest('.ev-tog');
  if (tog) { const el = tog.closest('.ev'), ev = A.shown[+el.dataset.i], k = rowKey(ev), open = !A.open.has(k); open ? A.open.add(k) : A.open.delete(k); const nu = document.createElement('div'); nu.innerHTML = row(ev, +el.dataset.i); el.replaceWith(nu.firstChild); return; }
  const b = pick(e); if (b) select(A.shown[+b.dataset.i], b);
});
$('p-list').addEventListener('change', (e) => { if (e.target.id === 'p-eph2') { P.eph = e.target.value; $('p-eph').value = P.eph; makeTargets(); recompute(); } });
$('p-list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-i][role=button]')) { e.preventDefault(); select(A.shown[+e.target.dataset.i], e.target); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && A.selected) select(null); });
let rs = 0; window.addEventListener('resize', () => { cancelAnimationFrame(rs); rs = requestAnimationFrame(() => { paintCharts(); if (globe) globe.resize(); if (P.view === 'grid') { document.querySelectorAll('#p-list .tile').forEach((t) => delete t.dataset.done); watchTiles(); } }); });

async function start() {
  // on a narrow screen the settings start folded, except the site until one has been chosen; on a phone the globe
  // (a screen and a half tall there) starts folded too, so the list of events is not three screens down
  if (matchMedia('(max-width: 1100px)').matches) for (const id of ['p-g-dates', 'p-g-limits', 'p-g-targets'].concat(P.chosen ? ['p-sitebox'] : matchMedia('(max-width: 640px)').matches ? ['p-sitebox'] : [])) $(id).open = false;
  $('p-sitebox').addEventListener('toggle', () => { if ($('p-sitebox').open && globe) globe.resize(); });
  if (!['list', 'grid', 'eph'].includes(P.view)) P.view = 'list';
  if (!['roi', 'transit', 'partial'].includes(P.show)) P.show = 'transit';
  if (!Array.isArray(P.events) || !P.events.some((k) => KINDS.includes(k))) P.events = ['transit'];
  fillForm(); formatters(); initNow();
  if (single) {
    document.body.classList.add('single');
    $('p-title').textContent = 'Plan: ' + single;
    $('p-lead').innerHTML = `Next 12 months from your site · <a href="./">all planets</a>`;
    $('p-sort').value = P.sort = 'time';
    for (const id of ['p-magmin', 'p-magmax', 'p-depth']) { $(id).disabled = true; $(id).title = 'Does not apply to a single planet'; }
  }
  // the observatory list is small and decides the site: wait for it, then the catalogues
  const obs = loadObservatories(fetchJson).then((o) => {
    A.obs = o;
    if (P.obs !== 'custom' && !o.byId.has(P.obs)) { P.obs = FALLBACK_SITE.id; P.lat = FALLBACK_SITE.lat; P.lon = FALLBACK_SITE.lon; P.elev = FALLBACK_SITE.elev; }
    fillForm(); formatters();
    globe = createGlobe($('p-globe'), { onPick: (st) => { chooseSite(st.id); recompute(); } });
    globe.setLand(o.land); globe.setSites(o.sites); globe.resize(); globe.lookAt(P.lat, P.lon, false);
    $('p-zin').addEventListener('click', () => globe.zoomBy(1.4)); $('p-zout').addEventListener('click', () => globe.zoomBy(1 / 1.4));
    window.__plan.globe = globe;
    drawSite();
  });
  await Promise.all([obs, ensureSources()]);
  if (!A.loaded.nea) return;                                                  // showLoadError() has said why; Try again reloads it
  if (single && A.singleRow) { $('p-title').textContent = 'Plan: ' + A.singleRow.name; $('p-lead').innerHTML = `Next 12 months from your site (magnitude and depth limits off) · <a href="./">all planets</a>`; }
  else if (!single) $('p-lead').innerHTML = `<span title="NASA Exoplanet Archive snapshot used for every prediction">Catalogue ${esc(A.loaded.nea.meta.date)}</span> · ${A.obs.sites.length} observatories`;
  compute();
  if (single && A.events.length) { A.selected = A.events[0]; drawDetail(); drawSite(); }
}
start().catch((err) => { status('Could not load the catalogues: ' + err.message); console.error(err); });

// ---- window.__esl.plan: what the site's assistant drives (the contract is at the top of src/assistant/pages.js).
// The same settings the form changes, the list as computed, and the links of a transit; nothing else.
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra }), obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''), plain = (html) => html.replace(/<[^>]+>/g, '');
  const apply = async () => { A.cleared = false; save(); fillForm(); await ensureSources(); compute(); };
  const isoMin = (jd) => new Date(Math.round((jd - 2440587.5) * 1440) * 60000).toISOString().slice(0, 16) + 'Z';   // to the nearest minute, as the list shows
  const siteText = () => `${curSite() ? curSite().name : 'custom site'} (${Math.abs(P.lat).toFixed(3)}° ${P.lat >= 0 ? 'N' : 'S'}, ${Math.abs(P.lon).toFixed(3)}° ${P.lon >= 0 ? 'E' : 'W'}, ${Math.round(P.elev || 0)} m)`;
  const datesText = () => (single ? 'the next 12 months' : `${P.date === 'auto' ? 'tonight' : P.date}${A.info ? ` (first night ${F.day(A.info.jd0)}${P.nights > 1 ? `, last night ${F.day(A.info.jd0 + P.nights - 1)}` : ''})` : ''}, ${P.nights} night${P.nights > 1 ? 's' : ''}`);
  const evRow = (ev) => ({ index: A.shown.indexOf(ev) + 1, planet: ev.target.name, ...(ev.target.candidate ? { tess_candidate: 'not a confirmed planet' } : {}), event: ev.kind, event_label: KIND[ev.kind].badge, ...(ev.assumed ? { assumed: ev.assumed } : {}), night_of: F.day(O.noonBefore(ev.mid, P.lon)), ingress_utc: isoMin(ev.ingress), mid_utc: isoMin(ev.mid), egress_utc: isoMin(ev.egress),
    local_times: `${F.local(ev.ingress)} – ${F.local(ev.mid)} – ${F.local(ev.egress)} ${F.tzShort}`, observable: ev.full ? 'yes' : ev.transitFull ? `${KIND[ev.kind].word} complete, ${ev.baselineWanted > 0 ? 'baseline' : 'timing margin'} cut short` : `partial: ${pct(ev.coverage)}% of the ${KIND[ev.kind].word}`, region_observable_pct: +pct(ev.roiCoverage),
    timing_1sigma: ev.target.hasErr ? '± ' + minutes(ev.sigma * 1440) : 'unknown', altitude: `${deg(ev.altIngress)} → ${deg(ev.altMid)} → ${deg(ev.altEgress)}`, moon: `${Math.round(100 * ev.moon.illum)}% lit, ${deg(ev.moon.sep)} away`,
    depth_ppt: fin(ev.target.depth) ? (ev.target.depth * 1000).toFixed(1) : null, magnitude: fin(ev.target.mag) ? `${ev.target.band} ${ev.target.mag.toFixed(1)}` : null, conditions_of_100: ev.score.total.toFixed(0), expected_snr: ev.score.snr === null ? null : +ev.score.snr.toFixed(0) });
  const counts = () => { const full = A.events.filter((e) => e.full).length, short = A.events.filter((e) => !e.full && e.transitFull).length; return { events: kindsOn(), observable: full, observable_tess_candidates: A.events.filter((e) => e.full && e.target.candidate).length, short_baseline: short, partial: A.events.length - full - short, observable_by_event: Object.fromEntries(kindsOn().map((k) => [k, A.events.filter((e) => e.full && e.kind === k).length])), targets_searched: A.info ? A.info.ntargets : 0 }; };
  const pickEvent = (index) => { const ev = A.shown[Math.round(index) - 1]; if (!ev) throw new Error(`there is no event number ${index}: the list has ${A.shown.length} (plan_list_transits)`); return ev; };
  /** Why a named planet gives no transit in the list: unknown, or left out by a limit. */
  function whyNone() {
    const q = P.name.trim().toLowerCase(); if (!q || single) return undefined;
    const hits = A.targets.filter((t) => t.key.includes(q));
    if (!hits.length) { const r = findRow(A.rows, P.name); return r && !(r.v.transit && r.v.per > 0) ? `${r.name} is not known to transit (found by ${r.v.method || 'an unknown method'}): it has no transits to plan.` : `No transiting planet with an ephemeris matches "${P.name}" in the catalogues that are switched on.`; }
    const t = hits[0], why = [];
    if (!P.src[t.cat]) why.push(`its catalogue (${t.cat}) is switched off`);
    if (!P.disc.includes(t.group)) why.push(`its discovery method (${DM.groupInfo(t.group).label}) is filtered out`);
    if (P.depth > 0 && !(t.depth * 1000 >= P.depth)) why.push(`its depth (${fin(t.depth) ? (t.depth * 1000).toFixed(1) + ' ppt' : 'unknown'}) is under the limit of ${P.depth} ppt`);
    if (P.magMax != null && !(t.mag <= P.magMax)) why.push(`its magnitude (${fin(t.mag) ? t.mag.toFixed(1) : 'unknown'}) is fainter than the limit ${P.magMax}`);
    if (!(t.t14 > 0)) why.push('it has no transit duration');
    return why.length ? `${t.name} is left out because ${why.join(' and ')}: change the limits with plan_set_limits.` : `${t.name} has no transit that meets the limits in these nights from this site: try more nights (plan_set_dates) or "show": "partial" (plan_set_limits).`;
  }
  const eventsText = () => kindsOn().map((k) => k === 'phase' ? `phase-curve windows (${P.phSpan} orbit centred on the ${P.phCenter}, P ≤ ${P.phMaxPer} d)` : k === 'custom' ? `phase window ${P.cFrom}–${P.cTo}` : k + 's').join(', ');
  /** Choose which events to plan; options of the phase windows may come with it. */
  async function setEvents(list, o = {}) {
    if (o.phase_span !== undefined) P.phSpan = Math.max(0.05, Math.min(1, +o.phase_span));
    if (o.phase_center !== undefined) { if (!['eclipse', 'transit'].includes(o.phase_center)) throw new Error('phase_center is "eclipse" or "transit"'); P.phCenter = o.phase_center; }
    if (o.phase_max_period !== undefined) P.phMaxPer = Math.max(0.2, Math.min(30, +o.phase_max_period));
    if (o.custom_from !== undefined) P.cFrom = Math.max(0, Math.min(1, +o.custom_from));
    if (o.custom_to !== undefined) P.cTo = Math.max(0, Math.min(1, +o.custom_to));
    if (list !== undefined) setKinds((Array.isArray(list) ? list : [list]).map((k) => String(k).toLowerCase().replace(/s$/, '').replace(/^(secondary|occultation)$/, 'eclipse')));
    await apply();
    return { events: eventsText(), transits: counts() };
  }
  const tools = [
    { name: 'plan_set_events', core: true, description: 'Choose what to plan: transits (default), eclipses, phase-curve windows (a span of the orbit around the eclipse or the transit, for short-period planets) and custom windows between two orbital phases. Several can be on together; they are listed and scored together.',
      parameters: obj({ events: { type: 'array', items: { type: 'string', enum: KINDS }, description: 'Kinds of event to list, e.g. ["transit", "eclipse"].' }, phase_span: N('Phase-curve window length as a fraction of the orbit (0.25, 0.5, 0.75 or 1).', { minimum: 0.05, maximum: 1 }),
        phase_center: T('Centre of a phase-curve window.', { enum: ['eclipse', 'transit'] }), phase_max_period: N('Only planets with a period up to this many days get phase-curve windows (default 3).', { minimum: 0.2, maximum: 30 }),
        custom_from: N('Custom window start, orbital phase (0 = mid-transit).', { minimum: 0, maximum: 1 }), custom_to: N('Custom window end, orbital phase.', { minimum: 0, maximum: 1 }) }),
      run(a) { return setEvents(a.events, a); } },
    { name: 'plan_set_site', core: true, description: 'Choose where the observations are made: an observatory by name (for example "Kitt Peak", "La Silla", "Mauna Kea"), or coordinates only when the user gave coordinates (never coordinates you remember: the list has the right ones). The list of transits is recomputed.',
      parameters: obj({ observatory: T('Name or part of the name of an observatory in the site\'s list.'), lat: N('Latitude in degrees, north positive (with lon, instead of an observatory).', { minimum: -90, maximum: 90 }), lon: N('Longitude in degrees, east positive.', { minimum: -180, maximum: 360 }), elev: N('Elevation in metres.') }),
      async run({ observatory, lat, lon, elev }) {
        if (observatory) {
          const k = key(observatory), all = A.obs.sites, hit = all.find((o) => key(o.name) === k || String(o.id).toLowerCase() === String(observatory).toLowerCase()) || (() => { const m = all.filter((o) => key(o.name).includes(k) || (o.listed && key(o.listed).includes(k))); if (m.length > 1 && m.length <= 12) throw new Error(`several observatories match "${observatory}": ${m.map((o) => o.name).join('; ')}. Give the full name.`); return m[0]; })();
          if (!hit) throw new Error(`no observatory matches "${observatory}" among the ${all.length} listed. Give another name, or lat and lon.`);
          chooseSite(hit.id);
        } else if (fin(lat) && fin(lon)) { P.lat = lat; P.lon = lon > 180 ? lon - 360 : lon; P.elev = fin(elev) ? elev : 0; P.obs = 'custom'; P.chosen = true; if (P.tz === 'site') P.tz = 'lon'; }
        else throw new Error('give "observatory", or "lat" and "lon"');
        await apply(); if (globe) globe.lookAt(P.lat, P.lon);
        return { site: siteText(), time_zone: F.tzLabel, transits: counts() };
      } },
    { name: 'plan_set_dates', core: true, description: 'Choose the nights to plan, in ONE call: the first night and either how many nights or the last night. A range ("between February and April") is {"date": "February", "until": "April"}; a month alone ("January") is that whole month. Dates may be written as YYYY-MM-DD, "Jan 15", "January" or "tonight"; a date without a year is its next occurrence, and a past date is moved to the next year (planning is for nights to come). At most 90 nights at a time: a longer range is cut and the result says where to go on.',
      parameters: obj({ date: T('First night: YYYY-MM-DD (the evening date at the site), a month and day ("Jan 15"), a month ("January") or "tonight".'), until: T('Last night, written the same way ("July" means July 31). Use it for "between January and July".'), nights: { type: 'integer', description: 'Number of nights, 1 to 90 (instead of until).', minimum: 1, maximum: 90 }, allow_past: { type: 'boolean', description: 'Only when the user asks about past nights on purpose.' } }),
      async run({ date, until, nights, allow_past }, ctx = {}) {
        if (single) throw new Error('this page shows one planet for the next 12 months; navigate to plan without "planet" to choose dates');
        const notes = [];
        // the user named a range of months ("between January and July") and the call gives one end only: the user's range
        const said = until === undefined && nights === undefined ? ND.rangeInText(ctx.request) : null;
        if (said) { date = said.from; until = said.to; notes.push(`the request names ${said.from} to ${said.to}, so that whole range was planned`); }
        const rg = date !== undefined && until === undefined && /^\s*(?:between\s+|from\s+)?(.+?)\s+(?:to|and|until|through|thru|-|–)\s+(.+?)\s*$/i.exec(String(date));
        if (rg && !/^\d{4}-\d\d-\d\d$/.test(String(date).trim())) { date = rg[1]; until = rg[2]; }
        if (date !== undefined && until !== undefined) {
          const r = ND.resolveRange(date, until, new Date(clock.now()), { maxNights: 90, allowPast: !!allow_past });
          P.date = r.tonight ? 'auto' : r.first; P.nights = r.nights; if (r.note) notes.push(r.note);
        } else {
          if (date !== undefined) { const r = ND.resolveNight(date, new Date(clock.now()), { allowPast: !!allow_past }); P.date = r.tonight ? 'auto' : r.date; if (r.note) notes.push(r.note); }
          if (nights !== undefined) P.nights = Math.max(1, Math.min(90, Math.round(nights)));
          // a month on its own ("January"): the whole month, not the default week
          else if (until === undefined && date !== undefined && ND.isBareMonth(date)) { const r = ND.resolveRange(date, date, new Date(clock.now()), { maxNights: 90, allowPast: !!allow_past }); P.date = r.first; P.nights = r.nights; }
          else if (until !== undefined) { const r = ND.resolveRange(P.date === 'auto' ? 'tonight' : P.date, until, new Date(clock.now()), { maxNights: 90, allowPast: !!allow_past }); P.nights = r.nights; if (r.note) notes.push(r.note); }
        }
        await apply(); return { dates: datesText(), covers: `the nights of ${ND.spanText(P.date === 'auto' ? null : P.date, P.nights)} only: say so when the user asked about a longer range, or call plan_set_dates again with "until"`, transits: counts(), ...(notes.length ? { note: notes.join('; ') } : {}) };
      } },
    { name: 'plan_set_target', core: true, description: 'Show only the transits of planets whose name contains this text (for example "WASP-43 b"); an empty name shows every planet again. For one planet over a whole year, navigate to plan with {"planet": name} instead.',
      parameters: obj({ name: T('Planet or host name, or part of it; "" for all planets.') }, ['name']),
      async run({ name }) {
        if (single) throw new Error(`this page is already limited to ${single} for the next 12 months`);
        P.name = String(name).trim(); await apply();
        return { target: P.name || 'all planets', transits: counts(), note: A.events.length ? undefined : whyNone(), next: A.events.length ? 'plan_list_transits lists them.' : undefined };
      } },
    { name: 'plan_set_limits', description: 'Change what counts as observable and which planets are searched: minimum altitude, how dark it must be, baseline wanted before and after the transit, how much of a transit must be visible, magnitude and depth limits, catalogues.',
      parameters: obj({ min_altitude: N('Lowest altitude of the star in degrees (default 30).', { minimum: 0, maximum: 89 }), sun_altitude: N('The Sun must be below this, degrees: -18 astronomical, -12 nautical, -6 civil night.', { enum: [-18, -12, -6, -0.833] }), baseline_hours: N('Out-of-transit time wanted on each side, hours (0 to 6).', { minimum: 0, maximum: 6 }),
        show: T('roi: only transits whose whole region of interest is observable; transit: also those complete but with a short baseline; partial: also partial transits.', { enum: ['roi', 'transit', 'partial'] }), mag_max: N('Faintest magnitude (0 removes the limit).'), min_depth_ppt: N('Shallowest transit depth in parts per thousand (0 removes the limit).', { minimum: 0 }),
        candidates: { type: 'boolean', description: 'Include TESS candidates (TOIs; on by default, marked as candidates).' }, methods: { type: 'array', items: { type: 'string', enum: DM.GROUPS.map((g) => g.key) }, description: 'Discovery methods to plan (transit, rv, imaging, microlensing, other, toi). Only planets seen to transit have transits, whatever the method.' },
        terrain: { type: 'boolean', description: 'Use the terrain horizon of the site (elevation tiles) as well as the altitude limit.' }, reset: { type: 'boolean', description: 'true: back to the default limits first.' } }),
      async run(a) {
        if (a.reset) for (const k of LIMIT_KEYS) P[k] = DEFAULTS[k];
        if (a.min_altitude !== undefined) P.minAlt = a.min_altitude; if (a.sun_altitude !== undefined) P.sun = a.sun_altitude; if (a.baseline_hours !== undefined) P.base = a.baseline_hours; if (a.show !== undefined) P.show = a.show;
        if (a.mag_max !== undefined) P.magMax = a.mag_max > 0 ? a.mag_max : null; if (a.min_depth_ppt !== undefined) P.depth = a.min_depth_ppt; if (a.candidates !== undefined) P.src.toi = !!a.candidates;
        if (a.methods !== undefined) P.disc = DM.parseFilter(a.methods); if (a.terrain !== undefined) P.terrain = !!a.terrain;
        await apply(); if (P.terrain) { await ensureHorizon(); compute(); }
        return { limits: plain(criteria()), magnitude_limit: P.magMax, depth_limit_ppt: P.depth, showing: P.show, methods: DM.GROUPS.filter((g) => P.disc.includes(g.id)).map((g) => g.label), candidates_included: !!P.src.toi, terrain: P.terrain ? (A.horizon ? `skyline ${A.horizon.min.toFixed(1)} to ${A.horizon.max.toFixed(1)} deg` : A.horizonError || 'loading') : 'off', transits: counts(), note: A.events.length ? undefined : whyNone() };
      } },
    { name: 'plan_list_transits', core: true, readOnly: true, description: 'The events (transits, and eclipses or phase windows when plan_set_events has turned them on) found for the current site, nights, target and limits, as the page computed them: event type, times (UTC and local), whether each is observable, timing uncertainty, altitude, Moon. Quote these as returned.',
      parameters: obj({ limit: { type: 'integer', description: 'How many to return (default 10).', minimum: 1, maximum: 40 }, only: T('"observable" lists only those whose whole region of interest is observable (default: all that are shown).', { enum: ['observable', 'all'] }) }),
      run({ limit = 10, only = 'all' }) {
        const list = A.shown.filter((e) => only === 'all' || e.full);
        return { site: siteText(), dates: datesText(), events: eventsText(), observable_means: plain(criteria()), counts: counts(), transits: list.slice(0, limit).map(evRow), more: list.length > limit ? list.length - limit : undefined, note: list.length ? undefined : whyNone() || 'Nothing meets these limits.', next: list.length ? 'plan_open_transit {index, in} opens one in the sky view (observe), the analyzer (analyze) or the catalogue (search).' : undefined };
      } },
    { name: 'plan_open_transit', core: true, description: 'Open one transit of the list elsewhere: "observe" shows the sky at that transit from this site, "analyze" opens the planet in the analyzer, "search" its catalogue entry, "details" its panel on this page (suggested observing run, ephemeris used).',
      parameters: obj({ index: { type: 'integer', description: 'Number of the transit in plan_list_transits (1 = first).', minimum: 1 }, in: T('Where to open it.', { enum: ['observe', 'analyze', 'search', 'details'] }) }, ['index', 'in']),
      run({ index, in: where }) {
        const ev = pickEvent(index), t = ev.target;
        if (where === 'observe') return { transit: evRow(ev), navigate: { page: 'observe', params: Object.fromEntries(new URL(skyUrl(ev), location.href).searchParams) } };
        if (where === 'analyze' || where === 'search') return { transit: evRow(ev), navigate: { page: where, params: { planet: t.name } } };
        if (A.selected !== ev) select(ev);
        return { transit: evRow(ev), mid_bjd_tdb: ev.bjd.toFixed(5), ephemeris: `${t.eph.ref || t.eph.cat}: P = ${t.per} d, T0 = ${t.tmid}`, dark_baseline: `${hours(ev.before)} before, ${hours(ev.after)} after`, lost: ev.lost.length ? lostText(ev, true) : 'nothing: the whole region of interest is observable' };
      } },
    { name: 'plan_export_csv', description: 'Write the ephemerides and predicted times of the listed transits as a CSV file for the user (the page\'s own table).', parameters: obj({ name: T('File name (default plan_transits.csv).') }),
      async run({ name }, { files }) { if (!A.shown.length) throw new Error('the list is empty'); const w = await files.write(name || 'plan_transits.csv', ephCsv(), 'text/csv'); return { written: w.name, size_bytes: w.size, rows: A.shown.length }; } },
  ];
  (window.__esl = window.__esl || {}).plan = { tools, ready: () => !!A.info && !!F, setEvents, events: () => kindsOn(),
    list: (limit = 40) => A.shown.slice(0, limit).map(evRow),
    state: () => [`Site: ${siteText()}. Nights: ${datesText()}. Events: ${eventsText()}. Target filter: ${single ? single + ' (single-planet page)' : P.name ? `${P.name}: ONLY this planet is listed (left from earlier; for other planets clear it with plan_set_target {"name": ""})` : 'all planets'}.`, `Limits: ${plain(criteria())}; magnitude ≤ ${P.magMax ?? 'any'}, depth ≥ ${P.depth || 0} ppt; discovery methods: ${P.disc === DM.GROUP_IDS ? 'all' : DM.GROUPS.filter((g) => P.disc.includes(g.id)).map((g) => g.label).join(', ') || 'none'}; TESS candidates ${P.src.toi ? 'included (marked as candidates)' : 'off'}; terrain horizon ${P.terrain ? 'on' : 'off'}.`, A.info ? `Found: ${JSON.stringify(counts())}${A.selected ? `; details open for ${A.selected.target.name}` : ''}.` : 'The catalogues are still loading.'] };
}
