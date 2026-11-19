// Observing sequences: what to take, when, and when to stop. A sequence is plain JSON (format 'esl-sequence'),
// made from a Plan event (fromPlanEvent) or by hand; nextAction(seq, state, now, env) says what the camera should
// do next and advance(state, action, result) records what it did, so the Run page, esl.observe and the tests
// share one state machine and a simulated clock can run a whole night in milliseconds. No DOM.
//
// Order: cool the sensor (until within tolerance of the set point, or the waiting time runs out) -> calibration
// frames that are asked for before (bias, darks of the light exposure time, flats) -> wait for the window, the
// target above the altitude limit and the Sun below its limit -> light frames until the window ends, the target
// sets or the Sun rises -> calibration frames asked for after -> done. A light frame is started only if it ends
// inside the window. Near the meridian the sequence pauses once (German equatorial mounts flip there) unless the
// mount does not need it; the user resumes.

import { altAz, sunAltAz } from './observability.js';
import { jdFromMs, msFromJd } from './timescale.js';
import { hourAngle } from './timeformat.js';

export const SEQUENCE_FORMAT = 'esl-sequence', SEQUENCE_VERSION = 1;
const fin = Number.isFinite;

export const DEFAULTS = {
  exposure: { duration: 60, filter: '', gain: null, offset: null, bin: 1 },
  cooler: { on: true, setTemp: -10, tolerance: 1, waitMax: 600 },
  calibration: { bias: 15, darks: 10, flats: 0, flatDuration: 1, when: 'before' },
  limits: { minAlt: 25, sunMax: -12, meridian: 'pause', meridianWindowMin: 6 },
};

/** A complete sequence from partial settings (missing values from DEFAULTS); throws on what cannot work. */
export function makeSequence(o) {
  const s = {
    format: SEQUENCE_FORMAT, version: SEQUENCE_VERSION,
    id: o.id || `seq-${new Date(o.window?.start ?? Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${String(o.target?.name || 'target').replace(/[^\w]+/g, '').toLowerCase()}`,
    name: o.name || `${o.target?.name || 'Target'} ${o.window ? new Date(o.window.start).toISOString().slice(0, 10) : ''}`.trim(),
    target: o.target, site: o.site, window: o.window, planet: o.planet || null, event: o.event || null,
    exposure: { ...DEFAULTS.exposure, ...(o.exposure || {}) }, cooler: { ...DEFAULTS.cooler, ...(o.cooler || {}) },
    calibration: { ...DEFAULTS.calibration, ...(o.calibration || {}) }, limits: { ...DEFAULTS.limits, ...(o.limits || {}) },
    telescope: o.telescope || null, observer: o.observer || '',
  };
  const err = validateSequence(s);
  if (err.length) throw new Error('The sequence cannot run: ' + err.join('; '));
  return s;
}

/** What is wrong with a sequence (empty when it can run). */
export function validateSequence(s) {
  const e = [];
  if (!s || s.format !== SEQUENCE_FORMAT) e.push(`not an ${SEQUENCE_FORMAT} file`);
  if (!s.target || !fin(s.target.ra) || !fin(s.target.dec)) e.push('the target needs ra and dec in degrees');
  if (!s.site || !fin(s.site.lat) || !fin(s.site.lon)) e.push('the site needs lat and lon in degrees');
  if (!s.window || !fin(s.window.start) || !fin(s.window.end) || !(s.window.end > s.window.start)) e.push('the window needs start < end (Unix ms)');
  if (!(s.exposure?.duration > 0)) e.push('the exposure time must be positive');
  if (s.window && s.exposure && s.exposure.duration * 1000 > s.window.end - s.window.start) e.push('the exposure is longer than the window');
  for (const k of ['bias', 'darks', 'flats']) if (!(s.calibration?.[k] >= 0)) e.push(`calibration.${k} must be 0 or more`);
  return e;
}

/**
 * A sequence for an event of findObservableEvents (src/core/observability.js): its region of interest (baseline +
 * event + baseline) as the window, the target and the site; `settings` overrides exposure, cooler, calibration, limits.
 */
export function fromPlanEvent(ev, site, settings = {}) {
  const t = ev.target || {};
  const window = { start: msFromJd(ev.roiStart ?? ev.ingress), end: msFromJd(ev.roiEnd ?? ev.egress) };
  const kind = ev.kind || 'transit';
  return makeSequence({
    ...settings, window,
    name: settings.name || `${t.name || 'Target'} ${kind} ${new Date(msFromJd(ev.mid)).toISOString().slice(0, 10)}`,
    target: { name: t.name, ra: t.ra, dec: t.dec, mag: t.vmag ?? t.mag ?? null },
    site: { name: site.name || '', lat: site.lat, lon: site.lon, elev: site.elev || 0, tz: site.tz || null },
    planet: fin(t.per) && fin(t.tmid) ? { per: t.per, tmid: t.tmid, rprs: t.rprs ?? null, ars: t.ars ?? null, inc: t.inc ?? null, t14: t.t14 ?? null, name: t.name } : null,
    event: { kind, mid: msFromJd(ev.mid), ingress: msFromJd(ev.ingress), egress: msFromJd(ev.egress), epoch: ev.epoch ?? null },
    limits: { ...(settings.limits || {}), minAlt: settings.limits?.minAlt ?? Math.max(15, (settings.planMinAlt ?? 30) - 5) },
  });
}

/** Where things are at a time: target altitude (now and 10 min later), Sun altitude (now and later), hour angle [h]. */
export function envAt(seq, ms) {
  const s = { lat: seq.site.lat, lon: seq.site.lon, elev: seq.site.elev || 0 }, jd = jdFromMs(ms), jd2 = jdFromMs(ms + 600e3);
  return { alt: altAz(seq.target.ra, seq.target.dec, jd, s).alt, altSoon: altAz(seq.target.ra, seq.target.dec, jd2, s).alt,
    sun: sunAltAz(jd, s).alt, sunSoon: sunAltAz(jd2, s).alt, ha: hourAngle(ms, seq.site.lon, seq.target.ra) };
}

/** A fresh state. */
export const startState = () => ({ phase: 'cool', counts: { bias: 0, dark: 0, flat: 0, light: 0 }, coolSince: null, flipped: false, paused: null, stopped: null, log: [] });

/**
 * What to do next.
 * @param env  { ccdTemp } from the camera; the sky is computed here (envAt) unless env.sky is given
 * @returns { type: 'cool' | 'expose' | 'wait' | 'pause' | 'done', kind, duration, until (Unix ms), reason }
 */
export function nextAction(seq, st, now, env = {}) {
  if (st.stopped) return { type: 'done', reason: st.stopped };
  if (st.paused) return { type: 'pause', reason: st.paused };
  const C = seq.calibration, X = seq.exposure, L = seq.limits;
  const calib = (when) => {
    if (C.when !== when && C.when !== 'both') return null;
    const want = C.when === 'both' ? (k) => Math.ceil(C[k] / 2) * (when === 'before' ? 1 : 2) : (k) => C[k];
    if (st.counts.bias < want('bias')) return { type: 'expose', kind: 'bias', duration: 0, reason: `bias ${st.counts.bias + 1} of ${want('bias')}` };
    if (st.counts.dark < want('darks')) return { type: 'expose', kind: 'dark', duration: X.duration, reason: `dark ${st.counts.dark + 1} of ${want('darks')} (${X.duration} s, as the lights)` };
    if (st.counts.flat < want('flats')) return { type: 'expose', kind: 'flat', duration: C.flatDuration, reason: `flat ${st.counts.flat + 1} of ${want('flats')}` };
    return null;
  };
  switch (st.phase) {
    case 'cool': {
      if (!seq.cooler.on || !fin(env.ccdTemp)) return { type: 'advance', to: 'before', reason: seq.cooler.on ? 'the camera reports no temperature: not waiting for the cooler' : 'cooler off' };
      if (Math.abs(env.ccdTemp - seq.cooler.setTemp) <= seq.cooler.tolerance) return { type: 'advance', to: 'before', reason: `sensor at ${env.ccdTemp.toFixed(1)} °C` };
      const since = st.coolSince ?? now;
      if (now - since > seq.cooler.waitMax * 1000) return { type: 'advance', to: 'before', reason: `the sensor did not reach ${seq.cooler.setTemp} °C in ${seq.cooler.waitMax} s (now ${env.ccdTemp.toFixed(1)} °C): going on`, warn: true };
      return { type: 'cool', until: now + 5000, reason: `cooling: ${env.ccdTemp.toFixed(1)} °C, set point ${seq.cooler.setTemp} °C` };
    }
    case 'before': return calib('before') || { type: 'advance', to: 'wait', reason: 'calibration frames done' };
    case 'wait':
    case 'lights': {
      const sky = env.sky || envAt(seq, now), endBy = now + X.duration * 1000;
      if (now >= seq.window.end || endBy > seq.window.end) return { type: 'advance', to: 'after', reason: 'the window has ended' };
      const setting = sky.altSoon < sky.alt, dawn = sky.sunSoon > sky.sun;
      if (sky.alt < L.minAlt) return setting ? { type: 'advance', to: 'after', reason: `the target has set below ${L.minAlt}°` } : { type: 'wait', until: now + 60e3, reason: `the target is at ${sky.alt.toFixed(1)}°, waiting for ${L.minAlt}°` };
      if (sky.sun > L.sunMax) return dawn && st.counts.light ? { type: 'advance', to: 'after', reason: `the Sun is at ${sky.sun.toFixed(1)}°: dawn` } : { type: 'wait', until: now + 60e3, reason: `the Sun is at ${sky.sun.toFixed(1)}°, waiting for ${L.sunMax}°` };
      if (now < seq.window.start) return { type: 'wait', until: seq.window.start, reason: `waiting for the window (${new Date(seq.window.start).toISOString().slice(11, 16)} UTC)` };
      if (L.meridian === 'pause' && !st.flipped && Math.abs(sky.ha) * 60 < L.meridianWindowMin && st.counts.light) return { type: 'pause', reason: 'the target is at the meridian: flip the mount if it needs to, re-centre the target, then resume', meridian: true };
      return { type: 'expose', kind: 'light', duration: X.duration, reason: `light ${st.counts.light + 1}` };
    }
    case 'after': return calib('after') || { type: 'done', reason: 'sequence complete' };
    default: return { type: 'done', reason: `unknown phase ${st.phase}` };
  }
}

/** The state after an action (and its result for an exposure). Returns a new object. */
export function advance(st, action, now, result = {}) {
  const s = { ...st, counts: { ...st.counts }, log: st.log.concat([{ at: now, type: action.type, kind: action.kind, reason: action.reason, ...(action.warn ? { warn: true } : {}) }]) };
  if (action.type === 'advance') { s.phase = action.to === 'wait' ? 'lights' : action.to; if (action.to === 'before' && st.phase === 'cool') s.coolSince = null; }
  else if (action.type === 'cool') s.coolSince = st.coolSince ?? now;
  else if (action.type === 'expose' && !result.error) s.counts[action.kind] += 1;
  else if (action.type === 'pause') s.paused = action.reason;
  else if (action.type === 'done') s.stopped = action.reason;
  return s;
}
/** Resume after a pause (the meridian pause counts as done). */
export const resume = (st) => ({ ...st, paused: null, flipped: st.flipped || /meridian/.test(st.paused || '') });
/** Stop now: the rest of the sequence is skipped, calibration frames after included. */
export const stop = (st, reason = 'stopped by the observer') => ({ ...st, stopped: reason });

/** How many frames and how long, before running it (lights from the window; calibration as asked). */
export function sequenceSummary(seq) {
  const lights = Math.floor((seq.window.end - seq.window.start) / 1000 / (seq.exposure.duration + (seq.exposure.overhead ?? 2)));
  const C = seq.calibration;
  return { lights, bias: C.bias, darks: C.darks, flats: C.flats, hours: (seq.window.end - seq.window.start) / 3600e3,
    calibrationMinutes: (C.darks * seq.exposure.duration + C.flats * C.flatDuration + C.bias * 2) / 60 };
}
