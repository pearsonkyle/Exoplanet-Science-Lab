// Observing sequences (src/core/sequence.js) run on a simulated clock through real nights: the transit of
// HAT-P-32 b seen from Kitt Peak (a Plan event of findObservableEvents), the window, altitude and Sun limits,
// the cooler, calibration before and after, the meridian pause. The reference is the sky itself
// (observability.js altAz / sunAltAz, checked against astropy in test/observability.test.mjs): no light frame may
// start or end where a limit says it must not.
import { makeSequence, fromPlanEvent, validateSequence, nextAction, advance, startState, resume, stop, envAt, sequenceSummary } from '../src/core/sequence.js';
import { findObservableEvents, jdFromDate } from '../src/core/observability.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const site = { name: 'Kitt Peak', lat: 31.9583, lon: -111.5967, elev: 2096, tz: 'America/Phoenix' };
// HAT-P-32 b (Wang et al. 2024 style numbers; only the timing matters here)
const hatp32 = { name: 'HAT-P-32 b', ra: 31.0428, dec: 46.6878, per: 2.15000815, tmid: 2455867.402743, t14: 0.1295, rprs: 0.1508, vmag: 11.3 };
const jd0 = jdFromDate(Date.UTC(2026, 10, 1)), jd1 = jdFromDate(Date.UTC(2026, 11, 1));
const evs = findObservableEvents([hatp32], site, { jd0, jd1, minAlt: 30, sunLimit: -18, baseline: 1 / 24 });
check('Plan finds HAT-P-32 b transits from Kitt Peak in November 2026 (whole region of interest above 30°, astronomical night)', evs.length >= 2, `${evs.length} events`);

function run(seq, { ccd = (t, st) => (st.phase === 'cool' ? 20 - (t - t00) / 1000 * 0.1 : seq.cooler.setTemp), start, resumeAfterPause = true, maxSteps = 100000 } = {}) {
  let st = startState(), t = start ?? seq.window.start - 3600e3; const exp = [], pauses = [];
  t00 = t;
  for (let i = 0; i < maxSteps; i++) {
    const a = nextAction(seq, st, t, { ccdTemp: ccd(t, st) });
    if (a.type === 'done') { st = advance(st, a, t); break; }
    if (a.type === 'expose') { exp.push({ kind: a.kind, start: t, end: t + a.duration * 1000, env: envAt(seq, t), envEnd: envAt(seq, t + a.duration * 1000) }); st = advance(st, a, t, {}); t += a.duration * 1000 + 2000; continue; }
    if (a.type === 'pause') { pauses.push({ t, reason: a.reason }); st = advance(st, a, t); if (!resumeAfterPause) break; t += 240e3; st = resume(st); continue; }
    st = advance(st, a, t);
    t = a.type === 'advance' ? t : Math.max(t + 1000, a.until);
  }
  return { st, exp, pauses, end: t };
}
let t00 = 0;

const ev = evs[0], seq = fromPlanEvent(ev, site, { exposure: { duration: 60 }, calibration: { bias: 10, darks: 5, flats: 0, when: 'before' }, limits: { meridian: 'none' } });   // the meridian pause has its own check below
check('fromPlanEvent: window = region of interest, target, site, planet', seq.window.start < seq.event.ingress && seq.window.end > seq.event.egress && seq.target.ra === hatp32.ra && seq.planet.per === hatp32.per && validateSequence(seq).length === 0, `${new Date(seq.window.start).toISOString()} to ${new Date(seq.window.end).toISOString()}`);
const r = run(seq);
const lights = r.exp.filter((e) => e.kind === 'light'), cal = r.exp.filter((e) => e.kind !== 'light');
check('order: cooling, then bias and darks, then lights', r.st.log[0].type === 'cool' && cal.length === 15 && cal.every((e) => e.start < lights[0].start) && cal.slice(0, 10).every((e) => e.kind === 'bias'));
check('no light frame outside the window', lights.every((e) => e.start >= seq.window.start && e.end <= seq.window.end), `${lights.length} lights`);
check('no light frame with the target below the limit or the Sun above it', lights.every((e) => e.env.alt >= seq.limits.minAlt && e.env.sun <= seq.limits.sunMax));
const cadence = (lights.at(-1).start - lights[0].start) / (lights.length - 1) / 1000;
check('lights cover the event and the window', lights[0].start - seq.window.start < 62e3 && seq.window.end - lights.at(-1).end < 62e3 + 2000 && Math.abs(cadence - 62) < 1e-9, `first ${(lights[0].start - seq.window.start) / 1000} s after the start, last ends ${(seq.window.end - lights.at(-1).end) / 1000} s before the end, cadence ${cadence} s`);
check('sequenceSummary predicts the number of lights', Math.abs(sequenceSummary(seq).lights - lights.length) <= 1, `${sequenceSummary(seq).lights} predicted, ${lights.length} taken`);
check('done, and says why', r.st.stopped === 'sequence complete' && r.st.counts.light === lights.length);

// the meridian: find an event that crosses it
const cross = evs.find((e) => { const s = fromPlanEvent(e, site); return envAt(s, s.window.start).ha * envAt(s, s.window.end).ha < 0; });
if (cross) {
  const s2 = fromPlanEvent(cross, site, { calibration: { bias: 0, darks: 0 }, limits: { meridian: 'pause' } }), r2 = run(s2);
  check('one pause at the meridian, then on', r2.pauses.length === 1 && /meridian/.test(r2.pauses[0].reason) && Math.abs(envAt(s2, r2.pauses[0].t).ha) * 60 < s2.limits.meridianWindowMin && r2.exp.some((e) => e.start > r2.pauses[0].t), `paused at HA ${(envAt(s2, r2.pauses[0].t).ha * 60).toFixed(1)} min`);
  const s3 = makeSequence({ ...s2, limits: { ...s2.limits, meridian: 'none' } });
  check('no pause when the mount does not flip', run(s3).pauses.length === 0);
} else console.log('skip meridian check: no event crosses the meridian this month');

// limits that end the night early: the target sets
{
  const s = makeSequence({ target: { name: 'low', ra: hatp32.ra, dec: hatp32.dec }, site, window: { start: seq.window.start, end: seq.window.start + 14 * 3600e3 }, calibration: { bias: 0, darks: 0 }, limits: { minAlt: 40, meridian: 'none' } });
  const r4 = run(s), last = r4.exp.at(-1);
  check('the target sets: stop, before the window ends', r4.st.stopped && r4.end < s.window.end && last.envEnd.alt >= 39.5 && /set|dawn/.test(r4.st.log.filter((l) => l.type === 'advance').map((l) => l.reason).join(' ')), r4.st.log.filter((l) => l.type === 'advance').map((l) => l.reason).join(' | '));
}
// starting in daylight: wait for the Sun
{
  const s = makeSequence({ target: { name: 'x', ra: hatp32.ra, dec: hatp32.dec }, site, window: { start: seq.window.start - 8 * 3600e3, end: seq.window.end }, calibration: { bias: 0, darks: 0 }, limits: { minAlt: 10, sunMax: -12, meridian: 'none' } });
  const r5 = run(s, { start: s.window.start });
  check('starting in daylight: no light frame until the Sun is below the limit', r5.exp.length > 0 && r5.exp.every((e) => e.env.sun <= -12) && r5.st.log.some((l) => /the Sun is at/.test(l.reason || '')));
}
// the cooler never gets there: wait at most waitMax, then go on with a warning
{
  const s = makeSequence({ ...seq, cooler: { on: true, setTemp: -30, tolerance: 1, waitMax: 120 } });
  const r6 = run(s, { ccd: () => -12 });
  const w = r6.st.log.find((l) => l.warn);
  check('cooler short of its set point: waits waitMax, then goes on and says so', w && /did not reach -30/.test(w.reason) && r6.exp.length > 0);
}
// darks after, and both
{
  const s = makeSequence({ ...seq, calibration: { bias: 4, darks: 4, flats: 2, when: 'after' } }), r7 = run(s), firstLight = r7.exp.findIndex((e) => e.kind === 'light');
  check('calibration after the lights', firstLight === 0 && r7.exp.slice(-10).map((e) => e.kind).join(',') === 'bias,bias,bias,bias,dark,dark,dark,dark,flat,flat');
}
// stop by hand
{
  let st = startState(); st = stop(st); check('stop: done at once', nextAction(seq, st, seq.window.start).type === 'done');
}
check('invalid sequences are refused with reasons', (() => { try { makeSequence({ target: { name: 'x' }, site, window: { start: 2, end: 1 } }); return false; } catch (e) { return /ra and dec/.test(e.message) && /start < end/.test(e.message); } })());

process.exit(ok ? 0 : 1);
