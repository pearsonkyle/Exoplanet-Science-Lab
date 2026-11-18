// The clock of the site: "now" corrected by the best time source that answers, with an honest uncertainty.
// Pages that show or use the present (Plan, Observe, Run) call clock.now() instead of Date.now().
//
// Sources, each measured with the interval method of src/core/clocksync.js:
//   https-date  the Date header of this site's own server (GitHub Pages / its CDN, or the dev server): no third
//               party, one HEAD request per probe, about 8 probes timed at second boundaries. The default.
//   https-ms    timeapi.io (millisecond answers, CORS open): asked only when the site's own Date header is missing.
//   helper      the local helper (`python -m esl.bridge`, http://localhost:11111/esl/time) with NTP / gpsd behind
//               it: asked only after the user has turned it on (localStorage esl.helper), because a page asking
//               localhost makes the browser show a local-network permission prompt.
//   serial-gps  a USB GPS through Web Serial (Chrome, Edge), after the user picks it (a user gesture is needed).
// Nothing answers: the system clock, and the badge says it is not checked.
//
//   clock.now() · clock.info() · clock.start() · clock.sync() · clock.connectGps() · clock.useHelper(url|null)
//   'esl-clock' events on window · mountClockBadge(el)
// Test hook: ?clockskew=<ms> pretends the computer's clock is that far off (tools and tests check the correction).

import { estimateOffset, nextProbeAt, chooseClock, describeClock } from '../core/clocksync.js';
import { nmeaStream, NMEA_LATENCY } from '../core/nmea.js';
import { leapCheck, jdFromMs } from '../core/timescale.js';

const hasWin = typeof window !== 'undefined';
const params = hasWin ? new URLSearchParams(location.search) : new URLSearchParams();
const SKEW = Number(params.get('clockskew')) || 0;
const sys = () => Date.now() + SKEW;                               // the computer's clock (with the test skew)
const HELPER_KEY = 'esl.helper', DEFAULT_HELPER = 'http://localhost:11111';
const RESYNC_MS = 10 * 60 * 1000;

const sources = new Map();                                          // id -> { source, label, offset, unc, at, detail }
let started = false, syncing = null, timer = null, gps = null;

const emit = () => { if (hasWin) window.dispatchEvent(new CustomEvent('esl-clock', { detail: info() })); };
const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - sys())));

function siteUrl() {
  const m = hasWin && document.querySelector('meta[name=esl-root]');
  return new URL((m && m.content) || './', document.baseURI);
}
export function helperUrl() { try { return localStorage.getItem(HELPER_KEY) || null; } catch { return null; } }

// probe a source n times; `ask` returns { server [ms], resolution, serverUnc, detail } or null
async function probe(ask, { n, resolution }) {
  const samples = []; let est = null, rtt = 150, detail = null;
  for (let i = 0; i < n; i++) {
    if (i) await sleepUntil(nextProbeAt(est, resolution, sys() + 20, rtt));
    const t0 = sys(); const a = await ask(); const t1 = sys();
    if (!a || !Number.isFinite(a.server)) { if (!samples.length) return null; break; }
    samples.push({ t0, t1, server: a.server, resolution: a.resolution ?? resolution, serverUnc: a.serverUnc || 0 });
    detail = a.detail || detail; rtt = Math.min(rtt, t1 - t0); est = estimateOffset(samples);
  }
  return est && { ...est, detail };
}

async function syncSiteDate() {
  const base = siteUrl();
  const ask = async () => {
    try {
      const r = await fetch(new URL('./?clock=' + Math.random().toString(36).slice(2), base), { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const d = r.headers.get('date');
      return d ? { server: Date.parse(d), resolution: 1000, detail: base.host } : null;
    } catch { return null; }
  };
  const e = await probe(ask, { n: 8, resolution: 1000 });
  if (e) sources.set('https-date', { source: 'https-date', label: `${e.detail} Date header`, offset: e.offset, unc: e.unc, at: sys(), detail: e });
  return !!e;
}
async function syncTimeApi() {
  const ask = async () => {
    try {
      const r = await fetch('https://timeapi.io/api/time/current/zone?timeZone=UTC', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const j = await r.json(); const t = Date.parse(j.dateTime.slice(0, 23) + 'Z');
      return Number.isFinite(t) ? { server: t, resolution: 1, detail: 'timeapi.io' } : null;
    } catch { return null; }
  };
  const e = await probe(ask, { n: 4, resolution: 1 });
  if (e) sources.set('https-ms', { source: 'https-ms', label: 'timeapi.io', offset: e.offset, unc: e.unc, at: sys(), detail: e });
  return !!e;
}
async function syncHelper() {
  const url = helperUrl(); if (!url) return false;
  let leap = null, kind = 'helper', label = 'local helper';
  const ask = async () => {
    try {
      const r = await fetch(new URL('/esl/time', url), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      leap = j.leap || null; kind = j.source === 'gps' || j.source === 'pps' ? 'helper-gps' : j.source === 'ntp' ? 'helper-ntp' : 'helper';
      label = `helper · ${j.label || j.source}`;
      // the helper's own uncertainty: its reference against the time it serves (unc = null: it could not check its clock)
      return { server: j.now * 1000, resolution: 0.001, serverUnc: Number.isFinite(j.unc) ? j.unc * 1000 : 1000, detail: j };
    } catch { return null; }
  };
  const e = await probe(ask, { n: 4, resolution: 0.001 });
  if (!e) { sources.delete('helper'); return false; }
  const lc = leap ? leapCheck(jdFromMs(sys() + e.offset), leap) : null;
  sources.set('helper', { source: kind, label, offset: e.offset, unc: e.unc, at: sys(), detail: e, leap: lc });
  return true;
}

/** Measure every enabled source now (one run at a time). */
export function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const [site] = await Promise.all([syncSiteDate(), syncHelper()]);
    if (!site) await syncTimeApi();
    syncing = null; emit();
  })();
  return syncing;
}

/** Start the service once per page: a first sync, then every 10 minutes and when the page is shown again. */
export function start() {
  if (started || !hasWin) return;
  started = true;
  sync();
  timer = setInterval(sync, RESYNC_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { const b = best(); if (!b.at || sys() - b.at > 60000) sync(); } });
}

function best() { return chooseClock([...sources.values()], sys()); }
/** Unix milliseconds, corrected. */
export const now = () => sys() + best().offset;
/** { source, label, offset [ms, reference minus this computer], unc [ms] (null: not checked), effUnc, at, text, skew, gps } */
export function info() {
  const b = best();
  return { ...b, text: describeClock(b), skew: SKEW, sources: [...sources.values()], gps: gps && gps.fix ? { ...gps.fix } : null, helper: helperUrl() };
}

/** Turn the local helper on (its base URL) or off (null), and re-sync. */
export function useHelper(url = DEFAULT_HELPER) {
  try { if (url) localStorage.setItem(HELPER_KEY, url); else localStorage.removeItem(HELPER_KEY); } catch { /* storage off */ }
  if (!url) sources.delete('helper');
  return sync();
}

/** Read a USB GPS through Web Serial (must be called from a click). Resolves when the port is open. */
export async function connectGps({ baudRate = 9600 } = {}) {
  if (!hasWin || !('serial' in navigator)) throw new Error('This browser has no Web Serial (use Chrome or Edge), or run the local helper with gpsd.');
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  const samples = [];
  gps = { port, fix: null, samples };
  const st = nmeaStream((p, at, burst) => {
    if (p.type === 'GGA' && p.valid) gps.fix = { lat: p.lat, lon: p.lon, alt: p.alt, sats: p.sats, hdop: p.hdop, at };
    if (!burst || !p.valid || !Number.isFinite(p.utcMs)) return;
    // the first sentence of a second arrives NMEA_LATENCY after the second it names
    samples.push({ t0: at - NMEA_LATENCY.max, t1: at - NMEA_LATENCY.min, server: p.utcMs, resolution: 0 });
    if (samples.length > 10) samples.shift();
    const e = estimateOffset(samples);
    if (e) { sources.set('serial-gps', { source: 'serial-gps', label: `USB GPS (${p.talker}${p.type})`, offset: e.offset, unc: e.unc, at: sys(), detail: e }); emit(); }
  });
  (async () => {
    const dec = new TextDecoderStream(); port.readable.pipeTo(dec.writable).catch(() => {});
    const reader = dec.readable.getReader();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; st.push(value, sys()); } }
    catch { /* unplugged */ }
    finally { sources.delete('serial-gps'); gps = null; emit(); }
  })();
}

/** A small clock badge: "±23 ms · example.github.io Date header"; click to measure again. */
export function mountClockBadge(el) {
  if (!el) return;
  el.classList.add('eslclock'); el.setAttribute('role', 'status'); el.tabIndex = 0;
  const draw = () => {
    const i = info();
    el.dataset.state = i.source === 'system' ? 'unchecked' : i.effUnc > 500 ? 'rough' : 'ok';
    el.textContent = '🕒 ' + i.text + (Math.abs(i.offset) >= 50 ? ` · this computer is ${Math.abs(i.offset / 1000).toFixed(Math.abs(i.offset) >= 5000 ? 1 : 2)} s ${i.offset > 0 ? 'slow' : 'fast'}` : '');
    const lines = i.sources.map((s) => `${s.label}: offset ${(s.offset / 1000).toFixed(3)} s ± ${(s.unc).toFixed(0)} ms`);
    const lc = i.sources.find((s) => s.leap && !s.leap.ok);
    el.title = (lines.length ? lines.join('\n') : 'No time source answered: the computer’s own clock is used.') + (lc ? '\n' + lc.leap.message : '') + '\nClick to measure again.';
  };
  el.addEventListener('click', () => { el.textContent = '🕒 measuring…'; sync(); });
  if (hasWin) window.addEventListener('esl-clock', draw);
  draw();
}

export const clock = { now, info, start, sync, connectGps, useHelper, helperUrl };
export default clock;
