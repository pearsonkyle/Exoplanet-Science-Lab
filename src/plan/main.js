// Plan page: which transits can be observed from a site in a range of nights. Settings live in P (kept in
// localStorage); everything on screen is recomputed from P, the catalogue and the observatory list.
//
// "Observable" is judged on the region of interest of a transit (the baseline setting before ingress to the same
// after egress): see findObservableTransits in src/core/observability.js. Only those transits are set in bold.
import { siteRoot } from '../site/nav.js';
import { SOURCES, loadSources, buildTable, findRow } from '../core/sources/index.js';
import { RELATIONS } from '../core/relations.js';
import * as O from '../core/observability.js';
import { esc, minutes, hms, dms } from '../search/format.js';
import { FALLBACK_SITE, KIND_LABEL, loadObservatories, groupSites } from './sites.js';
import { nightFrame, nightData, renderAltitude, renderSkyTrack, prepareCanvas, airmassText, THEME } from './chart.js';
import { createGlobe, GLOBE_COLOURS } from './globe.js';

const $ = (id) => document.getElementById(id);
const fetchJson = async (file) => { const r = await fetch(new URL(file, siteRoot())); if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`); return r.json(); };
const STORE = 'esl.plan.v2', MAX_SHOWN = 300;
const fin = Number.isFinite;

// The defaults the owner asked for: altitude 30 deg, one hour of baseline each side, the Sun below -18 deg.
const DEFAULTS = { obs: FALLBACK_SITE.id, lat: FALLBACK_SITE.lat, lon: FALLBACK_SITE.lon, elev: FALLBACK_SITE.elev, tz: 'site', date: 'auto', nights: 3, minAlt: 30, sun: -18, base: 1, show: 'transit',
  magMin: null, magMax: 13, depth: 5, src: { nea: true, toi: false, eu: false }, eph: 'best', name: '', sort: 'time', view: 'list', chosen: false };
const LIMIT_KEYS = ['minAlt', 'sun', 'base', 'show', 'magMin', 'magMax', 'depth'];
const P = (() => { try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORE)) || {}) }; } catch { return { ...DEFAULTS }; } })();
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(P)); } catch { /* private mode */ } };
const single = new URLSearchParams(location.search).get('planet');          // ?planet=<name>: one planet, a year ahead

const A = { loaded: {}, loading: {}, rows: [], targets: [], events: [], shown: [], selected: null, singleRow: null, dark: null, darkKey: '', obs: { sites: [FALLBACK_SITE], byId: new Map([[FALLBACK_SITE.id, FALLBACK_SITE]]), meta: {}, resources: null, land: [] } };
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
    tzLabel: tz === 'UTC' ? 'UTC' : `${tz.replace(/^Etc\//, '').replace(/_/g, ' ')}${off && !/^Etc/.test(tz) ? ' (' + off.value.replace('GMT', 'UTC') + ')' : ''}`, span: (d) => minutes(d * 1440) };
  F.tzShort = F.tzLabel.split(' (')[0].split('/').pop();
  return F;
}
/** First local mean noon of the range: the noon of the chosen date at the site's longitude. */
function startNoon() {
  if (P.date === 'auto' || !/^\d{4}-\d\d-\d\d$/.test(P.date)) return O.noonBefore(O.jdFromDate(Date.now()), P.lon);
  const [y, m, d] = P.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5 - P.lon / 360;
}
const isoDate = (jd) => O.dateFromJd(jd + P.lon / 360).toISOString().slice(0, 10);     // calendar date of a local mean noon
const iso = (jd) => O.dateFromJd(Math.round(jd * 86400) / 86400).toISOString().replace(/\.\d+Z$/, 'Z');
const sunName = (s = P.sun) => (s <= -18 ? 'astronomical night' : s <= -12 ? 'nautical night' : s <= -6 ? 'civil night' : 'sunset to sunrise');

// ------------------------------------------------------------------------------------------------ targets and their ephemerides

const sig = (e) => (e ? (e[0] + e[1]) / 2 : 0);
/**
 * The ephemeris a row's transits are predicted from. Archive planets carry two (sources/nea.js): the pair with the
 * smallest predicted uncertainty today and the archive's default parameter set; P.eph says which is used.
 * Returns { per, tmid, perErr, tmidErr, hasErr, ref, tsys, cat, how, other: the ephemeris not chosen or null }.
 */
function ephemerisOf(r) {
  const v = r.v, cat = r.src.per, rec = r.recs[cat], E = cat === 'nea' && rec.info.ephemerides;
  if (E && E.best) {
    const use = E[P.eph] || E.best, other = use === E.best ? E.default : E.best, same = !other || (other.per === use.per && other.tmid === use.tmid);
    const how = use.kind === 'best' ? `smallest predicted uncertainty today among the ${rec.info.nEphemerisRefs || 'published'} references that give a period and an epoch with errors`
      : use.kind === 'default' ? 'the archive\'s default parameter set' : 'the archive\'s composite values' + (use.mixed ? ': the period and the epoch come from two papers' : '');
    return { ...use, cat, how, other: same ? null : other, sameAsOther: same && !!other };
  }
  return { kind: 'catalogue', per: v.per, tmid: v.tmid, perErr: sig(r.e.per), tmidErr: sig(r.e.tmid), hasErr: !!(r.e.per && r.e.tmid), ref: r.ref.per || '', tsys: (rec && rec.info.tsys) || '', cat,
    how: cat === 'toi' ? 'the TESS project\'s pipeline ephemeris' : 'the only ephemeris this catalogue gives', other: null };
}
function makeTargets() {
  const out = [];
  for (const r of A.rows) {
    const v = r.v;
    if (!v.transit || !(v.per > 0) || !fin(v.tmid) || !fin(v.ra) || !fin(v.dec)) continue;
    const cat = r.recs.nea ? 'nea' : r.recs.toi ? 'toi' : 'eu';
    if (cat === 'toi' && !/^Candidate/.test(v.status)) continue;                      // known planets are in the archive list; false positives are not targets
    const mf = fin(v.vmag) ? 'vmag' : fin(v.gmag) ? 'gmag' : fin(v.tmag) ? 'tmag' : null, e = ephemerisOf(r);
    out.push({ row: r, name: r.name, cat, ra: v.ra, dec: v.dec, per: e.per, tmid: e.tmid, perErr: e.perErr, tmidErr: e.tmidErr, hasErr: e.hasErr, eph: e,
      t14: v.t14 > 0 ? v.t14 : NaN, depth: v.depth, mag: mf ? v[mf] : NaN, band: mf ? { vmag: 'V', gmag: 'G', tmag: 'T' }[mf] : '', key: r.name.toLowerCase() });
  }
  A.targets = out;
}
async function ensureSources() {
  const want = single ? ['nea', 'eu', 'toi'] : ['nea', ...(P.src.toi ? ['toi'] : []), ...(P.src.eu ? ['eu'] : [])];
  const need = want.filter((id) => !A.loaded[id] && !A.loading[id]);
  if (!need.length) return false;
  need.forEach((id) => (A.loading[id] = true));
  status(`Loading ${need.map((id) => SOURCES.find((s) => s.id === id).label).join(', ')}…`);
  Object.assign(A.loaded, await loadSources(fetchJson, need));
  need.forEach((id) => delete A.loading[id]);
  A.rows = buildTable(A.loaded).rows;
  makeTargets();
  if (single) A.singleRow = findRow(A.rows, single);
  return true;
}

// ------------------------------------------------------------------------------------------------ compute

function compute() {
  if (!A.loaded.nea) return;
  formatters();
  const s = site(), n = single ? 365 : Math.max(1, Math.min(90, Math.round(P.nights) || 1)), jd0 = startNoon(), jd1 = jd0 + n;
  const opts = { jd0, jd1, minAlt: P.minAlt, sunLimit: P.sun, baseline: (P.base || 0) / 24, include: P.show };
  const key = [s.lat, s.lon, jd0, jd1, P.sun].join('|');
  if (A.darkKey !== key) { A.dark = O.darkIntervals(jd0 - 1.5, jd1 + 1.5, s, P.sun); A.darkKey = key; }
  opts.dark = A.dark;
  let targets, skipped = { noDuration: 0, noMag: 0 };
  if (single) targets = A.singleRow ? A.targets.filter((t) => t.row === A.singleRow) : [];
  else {
    const q = P.name.trim().toLowerCase();
    targets = A.targets.filter((t) => {
      if (!P.src[t.cat]) return false;
      if (q && !t.key.includes(q)) return false;
      if (P.depth > 0 && !(t.depth * 1000 >= P.depth)) return false;
      if ((P.magMax != null || P.magMin != null) && !fin(t.mag)) { skipped.noMag++; return false; }
      if (P.magMax != null && t.mag > P.magMax) return false;
      if (P.magMin != null && t.mag < P.magMin) return false;
      if (!(t.t14 > 0)) { skipped.noDuration++; return false; }
      return true;
    });
  }
  const t0 = performance.now();
  A.events = O.findObservableTransits(targets, s, opts);
  A.info = { n, jd0, jd1, ntargets: targets.length, skipped, ms: performance.now() - t0, opts };
  if (A.selected) A.selected = A.events.find((e) => e.target === A.selected.target && e.epoch === A.selected.epoch) || null;
  draw();
}

// ------------------------------------------------------------------------------------------------ small pieces

const status = (t) => { $('p-count').textContent = t; };
const sigClass = (m) => (!(m > 0) ? 'unk' : m < 5 ? 'good' : m < 30 ? 'warn' : 'bad');
const deg = (x) => Math.round(x) + '°';
const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
const hours = (d) => (d * 24 >= 9.95 ? (d * 24).toFixed(0) : (d * 24).toFixed(1)) + ' h';
const pct = (f) => (f >= 0.9995 ? '100' : Math.min(99, Math.round(100 * f)).toString());
const cls = (ev) => (ev.full ? 'full' : ev.transitFull ? 'short' : 'part');
/** Where a lost piece of the region of interest falls. */
const lostWhere = (ev, l) => (l.end <= ev.ingress + 1e-6 ? 'before ingress' : l.start >= ev.egress - 1e-6 ? 'after egress' : l.start >= ev.ingress - 1e-6 && l.end <= ev.egress + 1e-6 ? 'in transit' : l.start < ev.ingress ? 'from before ingress' : 'through egress');
const lostWhy = (l) => (l.why === 'twilight' ? 'twilight' : 'too low');
const lostText = (ev, long = false) => ev.lost.map((l) => `${minutes((l.end - l.start) * 1440)} ${lostWhy(l)} ${long ? lostWhere(ev, l) : lostWhere(ev, l).replace(/ (ingress|egress)$/, '')}${long ? ` (${F.local(l.start)}–${F.local(l.end)})` : ''}`).join(long ? '; ' : ' · ');
/** The region of interest as a bar: observable in green, lost pieces in the colour of their cause, the transit outlined. */
function roiBar(ev) {
  const w = ev.roiEnd - ev.roiStart, p = (t) => (100 * (t - ev.roiStart) / w).toFixed(1);
  return `<span class="roi-bar" aria-hidden="true">${ev.lost.map((l) => `<i class="${l.why === 'twilight' ? 'tw' : 'lo'}" style="left:${p(l.start)}%;width:${(100 * (l.end - l.start) / w).toFixed(1)}%"></i>`).join('')}<i class="tr" style="left:${p(ev.ingress)}%;width:${(100 * (ev.egress - ev.ingress) / w).toFixed(1)}%"></i></span>`;
}
/** The link to the sky view with this transit: the contract of observe/ (planet, t, lat, lon, elev, transit, err). */
function skyUrl(ev) {
  const sm = ev.target.hasErr ? `&err=${(ev.sigma * 1440).toFixed(2)}` : '';
  return `../observe/?planet=${encodeURIComponent(ev.target.name)}&t=${iso(ev.mid)}&lat=${+P.lat.toFixed(5)}&lon=${+P.lon.toFixed(5)}&elev=${Math.round(P.elev || 0)}&transit=${iso(ev.ingress)},${iso(ev.mid)},${iso(ev.egress)}${sm}`;
}
const criteria = () => `the whole region of interest, from <b>${P.base ? P.base + ' h before ingress to ' + P.base + ' h after egress' : 'ingress to egress (no baseline asked)'}</b>, with the star above <b>${P.minAlt}°</b> and the Sun below <b>${P.sun === -0.833 ? 'the horizon' : P.sun + '°'}</b>${P.sun <= -6 ? ` (${sunName()})` : ''}`;

// ------------------------------------------------------------------------------------------------ the list

const HEAD = '<div class="ev-head" aria-hidden="true"><span></span><span>Planet</span><span>Ingress – mid – egress</span><span>Region of interest</span><span>Timing ±1σ</span><span>Altitude in → mid → out</span><span>Dark before / after</span><span>Moon</span><span></span></div>';
function row(ev, i) {
  const t = ev.target, sm = ev.sigma * 1440, r = t.row, c = cls(ev), B = (P.base || 0) / 24;
  const tm = (jd, ok) => `<span class="${ok ? '' : 'off'}">${F.local(jd)}</span>`;
  const estT = r.est.t14, estD = r.est.depth;
  const word = c === 'full' ? 'observable' : c === 'short' ? 'short baseline' : `partial transit ${pct(ev.coverage)}%`;
  return `<div class="ev ${c}${ev === A.selected ? ' sel' : ''}" data-i="${i}" role="button" tabindex="0" aria-pressed="${ev === A.selected}">` +
    `<span class="ev-score" style="--s:${ev.score.total.toFixed(0)}" title="Conditions ${ev.score.total.toFixed(0)} of 100: coverage ${ev.score.coverage.toFixed(0)}/50, baseline ${ev.score.baseline.toFixed(0)}/20, altitude ${ev.score.altitude.toFixed(0)}/20, Moon ${ev.score.moon.toFixed(0)}/10"><b>${ev.score.total.toFixed(0)}</b></span>` +
    `<span class="c c-name"><span class="nm">${esc(t.name)}</span> <span class="tag ${t.cat}">${SOURCES.find((s) => s.id === t.cat).short}</span>` +
    `<small>${fin(t.mag) ? `${t.band} ${t.mag.toFixed(1)} · ` : ''}${fin(t.depth) ? `<span class="${estD ? 'est' : ''}">${estD ? '~' : ''}${(t.depth * 1000).toFixed(1)} ppt</span> · ` : ''}<span class="${estT ? 'est' : ''}">${estT ? '~' : ''}${hours(t.t14)}</span></small></span>` +
    `<span class="c c-time" data-l="Ingress – mid – egress (${esc(F.tzShort)})"><span class="v">${tm(ev.ingress, ev.ingressObs)} <i>–</i> ${F.local(ev.mid)} <i>–</i> ${tm(ev.egress, ev.egressObs)}</span><small>UTC ${F.utc(ev.ingress)} – ${F.utc(ev.mid)} – ${F.utc(ev.egress)}</small></span>` +
    `<span class="c c-roi" data-l="Region of interest" title="${esc(`Region of interest ${F.local(ev.roiStart)} to ${F.local(ev.roiEnd)}: ${pct(ev.roiCoverage)}% observable` + (ev.lost.length ? '. Lost: ' + lostText(ev, true) : ''))}"><span class="v">${roiBar(ev)}<b>${pct(ev.roiCoverage)}%</b></span><small><b>${word}</b> ${ev.full ? `${F.local(ev.roiStart)} – ${F.local(ev.roiEnd)}` : '· ' + esc(lostText(ev))}</small></span>` +
    `<span class="ev-more"><span class="c c-sig ${sigClass(sm)}" data-l="Timing ±1σ" title="1-sigma uncertainty of the predicted mid-transit time, from the errors on T0 and P over ${Math.abs(ev.epoch)} orbits (${esc(t.eph.ref || 'no reference')})"><span class="v">${t.hasErr ? '± ' + minutes(sm) : '± ?'}</span><small>${Math.abs(ev.epoch)} orbits</small></span>` +
    `<span class="c c-alt" data-l="Altitude in → mid → out"><span class="v">${deg(ev.altIngress)} → ${deg(ev.altMid)} → ${deg(ev.altEgress)}</span><small>${compass(ev.azIngress)} ${deg(ev.azIngress)} → ${compass(ev.azEgress)} ${deg(ev.azEgress)}</small></span>` +
    `<span class="c c-base${B > 0 && (ev.before < B - 1e-6 || ev.after < B - 1e-6) ? ' shortb' : ''}" data-l="Dark before / after"><span class="v">${hours(ev.before)} / ${hours(ev.after)}</span><small>wanted ${P.base || 0} h each</small></span>` +
    `<span class="c c-moon${ev.moon.alt > 0 && ev.moon.sep < 30 && ev.moon.illum > 0.5 ? ' close' : ''}" data-l="Moon"><span class="v">${Math.round(100 * ev.moon.illum)}% · ${deg(ev.moon.sep)}</span><small>${ev.moon.alt > 0 ? 'up, ' + deg(ev.moon.alt) : 'below horizon'}</small></span>` +
    `<span class="c c-go"><a href="${esc(skyUrl(ev))}" title="Open the sky view at mid-transit from this site">Sky&nbsp;view</a></span></span></div>`;
}

function nightHeader(noon) {
  const s = site(), tw = O.twilight(noon, s), d = A.dark.find(([a, b]) => b > noon && a < noon + 1), ill = O.moonIllumination(noon + 0.5);
  return `<h2 class="night"><b>Night of ${esc(F.day(noon))}</b><span>${d ? `${sunName()} ${F.local(Math.max(d[0], noon))} – ${F.local(Math.min(d[1], noon + 1))} (${hours(Math.min(d[1], noon + 1) - Math.max(d[0], noon))})` : 'the Sun does not get that low'}` +
    `${tw.sun.evening ? ` · sunset ${F.local(tw.sun.evening)}` : ''}${tw.sun.morning ? ` · sunrise ${F.local(tw.sun.morning)}` : ''} · Moon ${Math.round(100 * ill.fraction)}% ${ill.waxing ? 'waxing' : 'waning'}</span></h2>`;
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
    `<div class="t-head"><span class="nm">${esc(t.name)}</span><span class="t-roi ${c}" title="${esc(ev.lost.length ? 'Lost: ' + lostText(ev, true) : 'The whole region of interest is observable')}">${pct(ev.roiCoverage)}%</span></div>` +
    `<div class="t-sub">${F.local(ev.ingress)} – ${F.local(ev.mid)} – ${F.local(ev.egress)}${fin(t.mag) ? ` · ${t.band} ${t.mag.toFixed(1)}` : ''}${fin(t.depth) ? ` · ${(t.depth * 1000).toFixed(1)} ppt` : ''}${t.hasErr ? ` · ± ${minutes(ev.sigma * 1440)}` : ''}</div>` +
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
function legendHtml(short) {
  return `<span><i class="k-sky" style="background:${THEME.sky[0]}"></i>day</span><span><i class="k-sky" style="background:${THEME.sky[1]}"></i>civil</span><span><i class="k-sky" style="background:${THEME.sky[2]}"></i>nautical</span><span><i class="k-sky" style="background:${THEME.sky[3]}"></i>astronomical</span><span><i class="k-sky" style="background:${THEME.sky[4]}"></i>night</span>` +
    '<span><i class="k-line"></i>target (bold: observable)</span><span><i class="k-roi"></i>region of interest</span><span><i class="k-in"></i>ingress, egress</span><span><i class="k-mid"></i>mid</span><span><i class="k-lim"></i>altitude limit</span><span><i class="k-moon"></i>Moon</span>' +
    '<span><i class="k-ok"></i>observable</span><span><i class="k-tw"></i>lost to twilight</span><span><i class="k-lo"></i>lost to altitude</span>' + (short ? '' : '<span><i class="k-sig"></i>± 1σ timing</span>');
}

// ------------------------------------------------------------------------------------------------ the ephemerides in use

/** One record per listed transit: the ephemeris it was predicted from and what that gives at its epoch. */
function ephemerisRows() {
  return A.shown.map((ev) => {
    const t = ev.target, e = t.eph, o = e.other;
    let dOther = null;
    if (o) { const n = Math.round((ev.bjd - o.tmid) / o.per); dOther = (o.tmid + n * o.per - ev.bjd) * 1440; }
    return { ev, planet: t.name, catalogue: SOURCES.find((s) => s.id === e.cat).label, reference: e.ref || '', t0: e.tmid, t0Err: e.tmidErr || null, tsys: e.tsys || '', per: e.per, perErr: e.perErr || null,
      epoch: ev.epoch, bjd: ev.bjd, utc: iso(ev.mid), sigmaMin: t.hasErr ? ev.sigma * 1440 : null, how: e.how, kind: e.kind, otherRef: o ? o.ref : '', dOther, otherSigma: o && o.hasErr ? O.midTimeUncertainty(Math.round((ev.bjd - o.tmid) / o.per), o.tmidErr, o.perErr) * 1440 : null };
  });
}
const num = (x, d) => (x == null || !fin(x) ? '' : d == null ? String(x) : x.toFixed(d));
const errDays = (x) => (x ? (x < 1e-4 ? x.toExponential(1) : x.toPrecision(2)).replace(/e-0?/, 'e−') : '—');
function ephTable() {
  const R = ephemerisRows(), nBest = R.filter((r) => r.kind === 'best').length, nDef = R.filter((r) => r.kind === 'default').length, nComp = R.filter((r) => r.kind === 'composite').length, nCat = R.filter((r) => r.kind === 'catalogue').length;
  const big = R.filter((r) => r.dOther != null && r.sigmaMin != null && Math.abs(r.dOther) > 3 * Math.hypot(r.sigmaMin, r.otherSigma || 0) && Math.abs(r.dOther) > 2).length;
  const tsys = (s) => (!s ? '<span class="warn" title="The catalogue does not say; treated as BJD-TDB">not stated</span>' : /^BJD(-TDB)?$/.test(s) ? esc(s) + (s === 'BJD' ? '<span class="warn" title="BJD without a time scale: treated as BJD-TDB (UTC would be 69 s earlier)">*</span>' : '') : `<span class="warn" title="Not converted: treated as BJD-TDB">${esc(s)}</span>`);
  const otherName = P.eph === 'best' ? 'archive default' : 'best-timed pair';
  return '<div class="eph-intro"><p>These are the ephemerides the times on this page are computed from: <b>T<sub>mid</sub>(N) = T₀ + N·P</b>, with <b>σ = √(σ<sub>T₀</sub>² + (N·σ<sub>P</sub>)²)</b> (T₀ and P taken as uncorrelated). ' +
    (P.eph === 'best' ? `For NASA archive planets the period and epoch are the pair, from <b>one</b> reference, that gives the <b>smallest predicted uncertainty today</b> (${nBest} of the ${R.length} listed transits)` : `For NASA archive planets the period and epoch are those of <b>the archive's default parameter set</b> (${nDef} of the ${R.length} listed transits)`) +
    (nComp ? `; ${nComp} use the archive's composite values because no single reference qualifies` : '') + (nCat ? `; ${nCat} come from a catalogue with one ephemeris only` : '') +
    `. Choosing by quoted errors favours papers with optimistic errors, so the other choice is shown for comparison in the last columns${big ? `: <span class="warn">${big} listed transit${big === 1 ? '' : 's'} differ${big === 1 ? 's' : ''} from the ${otherName} by more than 3σ and 2 minutes</span>` : ''}. ` +
    'Time systems are shown as the catalogue labels them and are <b>not converted</b>: all are treated as BJD<sub>TDB</sub>. These are literature values, not yet validated by ESL\'s own fits.</p>' +
    `<div class="eph-ctl"><label>Ephemeris used <select id="p-eph2"><option value="best"${P.eph === 'best' ? ' selected' : ''}>best-timed pair (smallest predicted σ today)</option><option value="default"${P.eph === 'default' ? ' selected' : ''}>the archive's default parameter set</option></select></label><button type="button" class="btn" id="p-csv">Download CSV</button></div></div>` +
    '<div class="eph-scroll"><table class="eph"><thead><tr><th class="l">Planet</th><th class="l">Reference</th><th>T₀</th><th>± d</th><th class="l">Time system</th><th>Period d</th><th>± d</th><th>N</th><th>Predicted mid BJD</th><th class="l">UTC</th><th>σ mid</th>' +
    `<th class="l sep">${otherName}: reference</th><th>Δ mid</th></tr></thead><tbody>` +
    R.map((r, i) => `<tr data-i="${i}" class="${r.ev === A.selected ? 'sel' : ''}"><td class="l nm">${esc(r.planet)} <span class="tag ${r.ev.target.cat}">${SOURCES.find((s) => s.id === r.ev.target.cat).short}</span></td><td class="l" title="${esc(r.how)}">${esc(r.reference || '—')}${r.kind === 'composite' ? ' <span class="warn" title="' + esc(r.how) + '">composite</span>' : ''}</td>` +
      `<td>${num(r.t0)}</td><td>${errDays(r.t0Err)}</td><td class="l">${tsys(r.tsys)}</td><td>${num(r.per)}</td><td>${errDays(r.perErr)}</td><td>${r.epoch}</td><td>${r.bjd.toFixed(5)}</td><td class="l">${r.utc.replace('T', ' ').slice(0, 16)}</td>` +
      `<td class="${sigClass(r.sigmaMin)}">${r.sigmaMin == null ? '?' : '± ' + minutes(r.sigmaMin)}</td><td class="l sep">${r.otherRef ? esc(r.otherRef) : r.ev.target.eph.sameAsOther ? '<span class="dim">the same</span>' : '<span class="dim">—</span>'}</td>` +
      `<td class="${r.dOther != null && r.sigmaMin != null && Math.abs(r.dOther) > 3 * Math.hypot(r.sigmaMin, r.otherSigma || 0) && Math.abs(r.dOther) > 2 ? 'warn' : ''}">${r.dOther == null ? '' : (r.dOther >= 0 ? '+' : '−') + minutes(Math.abs(r.dOther))}</td></tr>`).join('') + '</tbody></table></div>';
}
function ephCsv() {
  const q = (s) => (/[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s ?? ''));
  const head = ['planet', 'catalogue', 'reference', 'chosen_by', 'T0', 'T0_err_d', 'time_system_as_listed', 'treated_as', 'period_d', 'period_err_d', 'epoch_N', 'predicted_mid_BJD', 'predicted_mid_UTC', 'sigma_mid_min',
    'ingress_UTC', 'egress_UTC', 'other_choice_reference', 'other_minus_this_min', 'other_sigma_mid_min', 'roi_observable_fraction'];
  const lines = ephemerisRows().map((r) => [r.planet, r.catalogue, r.reference, r.how, r.t0, r.t0Err ?? '', r.tsys, 'BJD_TDB', r.per, r.perErr ?? '', r.epoch, r.bjd.toFixed(6), r.utc, r.sigmaMin == null ? '' : r.sigmaMin.toFixed(3),
    iso(r.ev.ingress), iso(r.ev.egress), r.otherRef, r.dOther == null ? '' : r.dOther.toFixed(3), r.otherSigma == null ? '' : r.otherSigma.toFixed(3), r.ev.roiCoverage.toFixed(4)].map(q).join(','));
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
  const I = A.info;
  const ev = A.events.slice();
  if (P.sort === 'score') ev.sort((a, b) => b.score.total - a.score.total || a.mid - b.mid);
  else if (P.sort === 'sigma') ev.sort((a, b) => (b.target.hasErr ? b.sigma : -1) - (a.target.hasErr ? a.sigma : -1) || a.mid - b.mid);
  else if (P.sort === 'depth') ev.sort((a, b) => (b.target.depth || 0) - (a.target.depth || 0) || a.mid - b.mid);
  else if (P.sort === 'mag') ev.sort((a, b) => (fin(a.target.mag) ? a.target.mag : 99) - (fin(b.target.mag) ? b.target.mag : 99) || a.mid - b.mid);
  A.shown = ev.slice(0, MAX_SHOWN);
  const nFull = ev.filter((e) => e.full).length, nShort = ev.filter((e) => !e.full && e.transitFull).length, nPart = ev.length - nFull - nShort, drift = ev.filter((e) => e.sigma * 1440 > 10).length;
  $('p-count').innerHTML = `<b>${nFull} observable transit${nFull === 1 ? '' : 's'}</b>` + (nShort ? ` <span class="more">+ ${nShort} with a short baseline</span>` : '') + (nPart ? ` <span class="more">+ ${nPart} partial</span>` : '') +
    `<span class="of">${single ? ' in the next 12 months' : ` · ${I.ntargets.toLocaleString('en')} targets · ${I.n} night${I.n > 1 ? 's' : ''}`}</span>`;
  let html;
  if (!ev.length) html = `<p class="p-empty">${single && !A.singleRow ? `No planet called “${esc(single)}” in the catalogues.` : single && A.singleRow && !(A.singleRow.v.t14 > 0 && A.singleRow.v.per > 0 && fin(A.singleRow.v.tmid)) ? `${esc(A.singleRow.name)} has no transit ephemeris (period, mid-transit time and duration) in the catalogues, so its transits cannot be predicted.` : `No transit meets these limits. ${P.show === 'roi' ? 'List transits with a short baseline too, l' : 'L'}oosen the magnitude or depth limit, lower the altitude limit or add nights.`}</p>`;
  else if (P.view === 'grid') html = GRID_LEGEND() + byNight(tile, (h) => `<div class="tiles">${h}</div>`);
  else if (P.view === 'eph') html = ephTable();
  else html = HEAD + byNight(row);
  if (ev.length > MAX_SHOWN) html += `<p class="p-empty">Showing the first ${MAX_SHOWN} of ${ev.length}. Narrow the limits or sort differently to see the rest.</p>`;
  const list = $('p-list');
  list.className = 'p-list v-' + P.view; list.innerHTML = html;
  if (P.view === 'grid' && ev.length) watchTiles();
  document.querySelectorAll('.p-views button').forEach((b) => { const on = b.dataset.view === P.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });

  const notes = [`<span class="crit"><b>Observable</b> = ${criteria()}. Only those transits are in bold; for the others the bar shows what is lost (<i class="k-tw"></i> twilight, <i class="k-lo"></i> too low).</span>`];
  if (!P.chosen && !single) notes.push(`Showing <b>${esc(FALLBACK_SITE.name)}</b> until you pick an observatory or use your location.`);
  if (drift) notes.push(`<span class="hl">${drift} of these transits ${drift === 1 ? 'has' : 'have'} a predicted time uncertain by more than 10 minutes.</span> A new mid-transit time is what fixes that: sort by “least certain timing first”.`);
  if (I.skipped.noMag) notes.push(`${I.skipped.noMag} target${I.skipped.noMag === 1 ? '' : 's'} without a magnitude ${I.skipped.noMag === 1 ? 'is' : 'are'} left out by the magnitude limit.`);
  if (I.skipped.noDuration) notes.push(`${I.skipped.noDuration} target${I.skipped.noDuration === 1 ? ' has' : 's have'} no transit duration and none could be derived.`);
  const unk = ev.filter((e) => !e.target.hasErr).length; if (unk) notes.push(`${unk} have no errors on the period or epoch, so their timing uncertainty is unknown (± ?).`);
  notes.push('Times are converted from BJD<sub>TDB</sub> to UTC at the Earth; altitudes are geometric (no refraction); values marked <span class="est">~</span> are estimated.');
  $('p-note').innerHTML = notes.join(' ');
  summaries();
  drawSite();
  drawDetail();
}

function summaries() {
  const c = curSite();
  $('p-site-sum').textContent = `${c ? c.name : 'custom'} · ${Math.abs(P.lat).toFixed(2)}°${P.lat >= 0 ? 'N' : 'S'} ${Math.abs(P.lon).toFixed(2)}°${P.lon >= 0 ? 'E' : 'W'}`;
  $('p-dates-sum').textContent = single ? 'next 12 months' : `${F.day(startNoon())} + ${A.info ? A.info.n : P.nights} night${P.nights > 1 ? 's' : ''}`;
  $('p-limits-sum').textContent = `alt ≥ ${P.minAlt}° · Sun ≤ ${P.sun === -0.833 ? '0' : P.sun}° · ${P.base} h`;
  $('p-targets-sum').textContent = ['nea', 'toi', 'eu'].filter((k) => P.src[k]).map((k) => SOURCES.find((x) => x.id === k).short).join(' + ') || 'none';
  $('p-crit').innerHTML = `A transit counts as observable when ${criteria()}.`;
}

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
  const jd = A.selected ? A.selected.mid : I ? I.jd0 + 0.5 : O.jdFromDate(Date.now());
  if (globe) {
    globe.set({ jd, selected: c ? c.id : null, user: c ? null : { lat: P.lat, lon: P.lon } });
    $('p-gcap').innerHTML = `Night side at <b>${esc(F.local(jd))}</b> ${esc(F.tzShort)} (${iso(jd).slice(0, 16).replace('T', ' ')} UTC), ${A.selected ? `mid-transit of ${esc(A.selected.target.name)}` : 'the middle of the first night'}.` +
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
    `<dt>Position</dt><dd>${Math.abs(P.lat).toFixed(4)}° ${P.lat >= 0 ? 'N' : 'S'}, ${Math.abs(P.lon).toFixed(4)}° ${P.lon >= 0 ? 'E' : 'W'}, ${Math.round(P.elev || 0)} m</dd>` +
    `<dt>Time zone</dt><dd>${esc(F.tzLabel)}</dd>` +
    (tw ? `<dt>First night</dt><dd>${d ? `${sunName()} <b>${F.local(Math.max(d[0], I.jd0))} – ${F.local(Math.min(d[1], I.jd0 + 1))}</b> (${hours(Math.min(d[1], I.jd0 + 1) - Math.max(d[0], I.jd0))})` : 'the Sun does not get that low'}${tw.sun.evening ? `, sunset ${F.local(tw.sun.evening)}` : ''}${tw.sun.morning ? `, sunrise ${F.local(tw.sun.morning)}` : ''}</dd>` : '') +
    (c ? `<dt>Coordinates from</dt><dd>${c.src === 'mpc' ? `Minor Planet Center observatory code ${esc(c.key)} (“${esc(c.listed)}”)` : `astropy site registry, “${esc(c.listed)}”`}${src && M.date ? `, read ${esc(M.date)}` : ''}${c.tzNote ? `; time zone from the coordinates (${esc(c.tzNote)})` : ''}</dd>` : '') +
    '</dl>' + resourcesHtml(c);
  $('p-sside').innerHTML = camHtml(c);
  $('p-sbname').textContent = `${c ? c.name : 'your site'} · ${Math.abs(P.lat).toFixed(2)}°${P.lat >= 0 ? 'N' : 'S'} ${Math.abs(P.lon).toFixed(2)}°${P.lon >= 0 ? 'E' : 'W'}`;
}

// ---- the selected transit: chart, sky track, numbers
function drawDetail() {
  const el = $('p-detail'), ev = A.selected;
  document.querySelectorAll('#p-list .sel').forEach((b) => { b.classList.remove('sel'); b.setAttribute('aria-pressed', 'false'); });
  if (!ev) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('has-detail'); return; }
  const i = A.shown.indexOf(ev), btn = i >= 0 && $('p-list').querySelector(`[data-i="${i}"]`);
  if (btn) { btn.classList.add('sel'); btn.setAttribute('aria-pressed', 'true'); }
  const t = ev.target, r = t.row, s = site(), q = encodeURIComponent(t.name), sm = ev.sigma * 1440, base = (P.base || 0) / 24, e = t.eph;
  const ref = e.ref || SOURCES.find((x) => x.id === e.cat).label, tsys = e.tsys || '';
  // what to observe: the region of interest and one sigma on each side, cut to what is dark and above the limit
  const want0 = ev.roiStart - ev.sigma, want1 = ev.roiEnd + ev.sigma, run0 = Math.max(want0, ev.ingressObs ? ev.ingress - ev.before : ev.obsStart ?? ev.ingress), run1 = Math.min(want1, ev.egressObs ? ev.egress + ev.after : ev.obsEnd ?? ev.egress);
  const row = (name, jd, alt, az, ok) => `<tr class="${ok ? '' : 'off'}"><td>${name}</td><td><b>${F.local(jd)}</b></td><td>${F.utc(jd)}</td><td>${alt.toFixed(0)}°</td><td>${compass(az)} ${az.toFixed(0)}°</td><td>${airmassText(alt)}</td><td>${ok ? '' : O.sunAltAz(jd, s).alt > P.sun ? 'not dark' : 'too low'}</td></tr>`;
  const at = (jd) => O.altAz(t.ra, t.dec, jd, s), okAt = (jd) => at(jd).alt >= P.minAlt && O.sunAltAz(jd, s).alt <= P.sun;
  const a0 = at(ev.roiStart), a1 = at(ev.roiEnd);
  const est = (k) => (r.est[k] ? ` <span class="est" title="${esc(RELATIONS[r.est[k].rel].name + ' [' + RELATIONS[r.est[k].rel].cite + ']' + (r.est[k].note ? '. ' + r.est[k].note : ''))}">estimated: ${esc(RELATIONS[r.est[k].rel].cite)}</span>` : '');
  const c = cls(ev);
  el.hidden = false; document.body.classList.add('has-detail');
  el.innerHTML = `<div class="d-head"><div><h2>${esc(t.name)}</h2><div class="d-sub">Night of ${esc(F.day(O.noonBefore(ev.mid, s.lon)))} · ${esc(F.dayUtc(ev.mid))} UTC · orbit ${ev.epoch} since T₀</div></div><button class="d-close" type="button" aria-label="Close">✕</button></div>` +
    `<div class="d-roi ${c}"><div class="d-roi-top">${roiBar(ev)}<b>${pct(ev.roiCoverage)}%</b> of the region of interest observable</div>` +
    `<div>${c === 'full' ? `<b>Observable:</b> ${F.local(ev.roiStart)} – ${F.local(ev.roiEnd)} is dark and above ${P.minAlt}° throughout.` : `${c === 'short' ? 'The transit itself is complete, but the baseline is cut' : `Only ${pct(ev.coverage)}% of the transit can be observed`}. Lost: ${esc(lostText(ev, true))}.`}</div></div>` +
    `<div class="d-links"><a class="btn primary" href="${esc(skyUrl(ev))}">Sky view at this transit</a><a class="btn" href="../analyze/?planet=${q}">Analyze</a><a class="btn" href="../search/?planet=${q}">Catalogue entry</a>${single ? '' : `<a class="btn" href="?planet=${q}">All its transits</a>`}</div>` +
    (t.hasErr && sm > 10 ? `<div class="d-flag ${sigClass(sm)}"><b>Timing uncertain by ± ${minutes(sm)} (1σ).</b> The ephemeris (${esc(ref)}) has drifted over ${Math.abs(ev.epoch)} orbits. A mid-transit time from this event would tighten it: start early, end late.</div>` : '') +
    '<canvas id="p-alt" class="p-canvas" aria-label="Altitude of the target through the night, with twilight, the region of interest, the transit and the Moon"></canvas>' +
    `<div class="d-legend">${legendHtml(false)}</div>` +
    `<table class="d-times"><tr><th></th><th>${esc(F.tzShort)}</th><th>UTC</th><th>Alt</th><th>Az</th><th>Air mass</th><th></th></tr>${base > 0 ? row(`−${P.base} h`, ev.roiStart, a0.alt, a0.az, okAt(ev.roiStart)) : ''}${row('Ingress', ev.ingress, ev.altIngress, ev.azIngress, ev.ingressObs)}${row('Mid', ev.mid, ev.altMid, ev.azMid, okAt(ev.mid))}${row('Egress', ev.egress, ev.altEgress, ev.azEgress, ev.egressObs)}${base > 0 ? row(`+${P.base} h`, ev.roiEnd, a1.alt, a1.az, okAt(ev.roiEnd)) : ''}</table>` +
    '<div class="d-split"><figure class="d-sky"><canvas id="p-sky" class="p-canvas" aria-label="Track of the target across the sky"></canvas><figcaption>Looking up: zenith at the centre, north up, east left. White: the transit; bright: the region of interest; thin: the rest of the night.</figcaption></figure><dl class="d-facts">' +
    `<dt>Suggested run</dt><dd><b>${F.local(run0)} – ${F.local(run1)}</b> (${hours(run1 - run0)})${run0 > want0 + 1e-4 || run1 < want1 - 1e-4 ? ', cut short by twilight or the altitude limit' : ', covers the baseline and ± 1σ'}</dd>` +
    `<dt>Mid-time</dt><dd>BJD<sub>TDB</sub> ${ev.bjd.toFixed(5)} ${t.hasErr ? `± ${minutes(sm)}` : '(no errors quoted)'}</dd>` +
    `<dt>Ephemeris</dt><dd>${esc(ref)}: P = ${t.per} d${t.perErr ? ` ± ${(t.perErr * 86400).toPrecision(2)} s` : ''}, T₀ = ${t.tmid}${t.tmidErr ? ` ± ${minutes(t.tmidErr * 1440)}` : ''}<br><span class="dim">chosen as ${esc(e.how)}</span>${tsys && !/^BJD(-TDB)?$/.test(tsys) ? `<br><span class="warn">time system listed as ${esc(tsys)}, treated as BJD-TDB</span>` : ''}</dd>` +
    `<dt>Transit</dt><dd>${hours(t.t14)}${est('t14')}${fin(t.depth) ? `, depth ${(t.depth * 1000).toFixed(2)} ppt (${(t.depth * 1085.7).toFixed(1)} mmag)${est('depth')}` : ''}</dd>` +
    `<dt>Star</dt><dd>${fin(t.mag) ? `${t.band} = ${t.mag.toFixed(2)} · ` : ''}${hms(t.ra)} ${dms(t.dec)}</dd>` +
    `<dt>Dark baseline</dt><dd>${hours(ev.before)} before, ${hours(ev.after)} after${P.base > 0 ? ` (wanted ${P.base} h)` : ''}</dd>` +
    `<dt>Moon</dt><dd>${Math.round(100 * ev.moon.illum)}% lit, ${ev.moon.sep.toFixed(0)}° from the target, ${ev.moon.alt > 0 ? `${ev.moon.alt.toFixed(0)}° up` : 'below the horizon'} at mid-transit</dd>` +
    `<dt>Conditions</dt><dd>${ev.score.total.toFixed(0)} / 100 = coverage ${ev.score.coverage.toFixed(0)}/50 + baseline ${ev.score.baseline.toFixed(0)}/20 + altitude ${ev.score.altitude.toFixed(0)}/20 + Moon ${ev.score.moon.toFixed(0)}/10</dd>` +
    '</dl></div>';
  el.querySelector('.d-close').addEventListener('click', () => select(null));
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
  if (A.selected && from && matchMedia('(max-width: 1100px)').matches) { (from.closest('tr') ? $('p-list') : from).after($('p-detail')); $('p-detail').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
}

// ------------------------------------------------------------------------------------------------ form

function fillForm() {
  $('p-obs').innerHTML = groupSites(A.obs.sites).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</optgroup>`).join('') + '<option value="custom">Other: type coordinates below</option>';
  $('p-obs').value = String(P.obs);
  $('p-lat').value = P.lat; $('p-lon').value = P.lon; $('p-elev').value = P.elev;
  const btz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('p-tz').innerHTML = `<option value="site">the observatory's time zone</option><option value="lon">mean solar zone of the longitude</option><option value="browser">this device's zone (${esc(btz)})</option><option value="UTC">UTC</option>`;
  $('p-tz').value = P.tz; $('p-tz').querySelector('[value=site]').disabled = P.obs === 'custom';
  $('p-date').value = P.date === 'auto' ? isoDate(startNoon()) : P.date; $('p-nights').value = P.nights;
  $('p-minalt').value = P.minAlt; $('p-sun').value = String(P.sun); $('p-show').value = P.show; $('p-eph').value = P.eph;
  $('p-magmin').value = P.magMin ?? ''; $('p-magmax').value = P.magMax ?? ''; $('p-depth').value = P.depth || ''; $('p-base').value = P.base;
  for (const k of ['nea', 'toi', 'eu']) $('p-src-' + k).checked = !!P.src[k];
  $('p-name').value = P.name; $('p-sort').value = P.sort;
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
function recompute(delay = 0) { save(); clearTimeout(timer); timer = setTimeout(async () => { await ensureSources(); compute(); }, delay); }
function changed(e) {
  const id = e.target.id;
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
  else if (id.startsWith('p-src-')) P.src[id.slice(6)] = e.target.checked;
  else if (id === 'p-name') P.name = e.target.value;
  else return;
  recompute(e.type === 'input' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' ? 250 : 0);
}

$('p-form').addEventListener('input', changed);
$('p-form').addEventListener('change', changed);
$('p-sort').addEventListener('change', (e) => { P.sort = e.target.value; save(); draw(); });
$('p-tonight').addEventListener('click', () => { P.date = 'auto'; save(); fillForm(); compute(); });
$('p-reset').addEventListener('click', () => { for (const k of LIMIT_KEYS) P[k] = DEFAULTS[k]; fillForm(); recompute(); });
document.querySelector('.p-views').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (!b) return; P.view = b.dataset.view; save(); draw(); });
$('p-geo').addEventListener('click', () => {
  const msg = $('p-geo-msg');
  if (!navigator.geolocation) { msg.textContent = 'This browser has no location service.'; return; }
  msg.textContent = 'Asking the browser…';
  navigator.geolocation.getCurrentPosition((pos) => {
    P.lat = +pos.coords.latitude.toFixed(4); P.lon = +pos.coords.longitude.toFixed(4); P.elev = fin(pos.coords.altitude) ? Math.round(pos.coords.altitude) : 0;
    P.obs = 'custom'; P.tz = 'browser'; P.chosen = true; save(); fillForm(); compute(); if (globe) globe.lookAt(P.lat, P.lon);
    msg.textContent = 'Using this device\'s position (it stays in this browser).';
  }, (err) => { msg.textContent = err.code === 1 ? 'Permission was not given. Type the coordinates instead.' : 'The position could not be determined. Type the coordinates instead.'; }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600000 });
});
const pick = (e) => {
  if (e.target.closest('a, select, button, label')) return null;
  return e.target.closest('[data-i]');
};
$('p-list').addEventListener('click', (e) => {
  if (e.target.id === 'p-csv') return downloadCsv();
  const b = pick(e); if (b) select(A.shown[+b.dataset.i], b);
});
$('p-list').addEventListener('change', (e) => { if (e.target.id === 'p-eph2') { P.eph = e.target.value; $('p-eph').value = P.eph; makeTargets(); recompute(); } });
$('p-list').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-i][role=button]')) { e.preventDefault(); select(A.shown[+e.target.dataset.i], e.target); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && A.selected) select(null); });
let rs = 0; window.addEventListener('resize', () => { cancelAnimationFrame(rs); rs = requestAnimationFrame(() => { paintCharts(); if (globe) globe.resize(); if (P.view === 'grid') { document.querySelectorAll('#p-list .tile').forEach((t) => delete t.dataset.done); watchTiles(); } }); });

async function start() {
  // on a phone the settings start folded, except the site until one has been chosen
  if (matchMedia('(max-width: 1100px)').matches) for (const id of ['p-g-dates', 'p-g-limits', 'p-g-targets'].concat(P.chosen ? ['p-g-site', 'p-sitebox'] : [])) $(id).open = false;
  $('p-sitebox').addEventListener('toggle', () => { if ($('p-sitebox').open && globe) globe.resize(); });
  if (!['list', 'grid', 'eph'].includes(P.view)) P.view = 'list';
  if (!['roi', 'transit', 'partial'].includes(P.show)) P.show = 'transit';
  fillForm(); formatters();
  if (single) {
    document.body.classList.add('single');
    $('p-title').textContent = 'Plan: ' + single;
    $('p-lead').innerHTML = `Observable transits of <b>${esc(single)}</b> in the next 12 months from your site. <a href="./">All planets</a>`;
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
  if (single && A.singleRow) { $('p-title').textContent = 'Plan: ' + A.singleRow.name; $('p-lead').innerHTML = `Observable transits of <b>${esc(A.singleRow.name)}</b> in the next 12 months from your site. The magnitude and depth limits do not apply here. <a href="./">All planets</a>`; }
  else if (!single) $('p-lead').textContent = `Transits you can observe from your site: when, how high, how dark, and how well the time is known. Catalogue snapshot ${A.loaded.nea.meta.date}; ${A.obs.sites.length} observatories.`;
  compute();
  if (single && A.events.length) { A.selected = A.events[0]; drawDetail(); drawSite(); }
}
start().catch((err) => { status('Could not load the catalogues: ' + err.message); console.error(err); });
