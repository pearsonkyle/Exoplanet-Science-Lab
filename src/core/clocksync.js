// How far this computer's clock is from a reference clock, from request/response pairs. Pure functions: the
// browser's clock service (src/site/clock.js), the Python package (esl.time) and the tests share them.
//
// A sample is one exchange: the request left at local time t0, the answer arrived at t1 (both in ms on the local
// clock), and the server said its clock read `server` (ms) somewhere in between, truncated to `resolution` ms
// (1000 for an HTTP Date header, 1 for a millisecond API, 0 for an exact time) and itself uncertain by `serverUnc`.
// The offset theta (reference minus local) then lies in
//     [server - t1 - serverUnc,  server + resolution - t0 + serverUnc]
// whatever the split of the round trip between the two directions. Intersecting these intervals over several
// samples (Marzullo-style) gives the offset and an honest bound; probing just around a second boundary
// (nextProbeAt) makes whole-second sources as good as the round trip. A sample whose interval does not overlap
// the others (a server hiccup, a sleep of the laptop) is dropped, the slowest first.

/** The interval of offsets [ms] allowed by one sample. */
export function sampleBounds({ t0, t1, server, resolution = 0, serverUnc = 0 }) {
  return { lo: server - t1 - serverUnc, hi: server + resolution - t0 + serverUnc, delay: t1 - t0 };
}

/**
 * Offset of the reference clock from the local one [ms] from samples.
 * @returns { offset, unc (half-width of the interval, ms), lo, hi, n: samples given, used, dropped, delay: smallest round trip, consistent }
 *          or null without samples
 */
export function estimateOffset(samples) {
  const b = samples.filter((s) => [s.t0, s.t1, s.server].every(Number.isFinite) && s.t1 >= s.t0).map((s) => ({ ...sampleBounds(s), s }));
  if (!b.length) return null;
  let use = b.slice().sort((x, y) => x.delay - y.delay), consistent = true;
  const inter = (list) => list.reduce((a, x) => ({ lo: Math.max(a.lo, x.lo), hi: Math.min(a.hi, x.hi) }), { lo: -Infinity, hi: Infinity });
  let I = inter(use);
  while (I.lo > I.hi && use.length > 1) { consistent = false; use = use.slice(0, -1); I = inter(use); }   // drop the slowest until they agree
  return { offset: 0.5 * (I.lo + I.hi), unc: 0.5 * (I.hi - I.lo), lo: I.lo, hi: I.hi, n: samples.length, used: use.length, dropped: b.length - use.length, delay: use[0].delay, consistent };
}

/**
 * When to send the next request to a source of `resolution` ms so that the server reads its clock at a tick of
 * that resolution (where a sample says most), given the current estimate (or null) and the round trip seen so far.
 * Returns a local time [ms] not earlier than `now`.
 */
export function nextProbeAt(est, resolution, now, rtt = 100) {
  if (!(resolution > 1) || !est) return now;
  const theta = est.offset, half = rtt / 2;
  // the server reads its clock about half a round trip after t0: local t0 + half + theta = k * resolution
  let k = Math.ceil((now + half + theta) / resolution);
  let t = k * resolution - theta - half;
  if (t < now) t += resolution;
  return t;
}

/** Uncertainty [ms] of an offset measured `ageMs` ago: a computer clock drifts by up to about 20 ppm (72 ms an hour). */
export const agedUncertainty = (unc, ageMs, drift = 20e-6) => unc + drift * Math.max(0, ageMs);

/** Sources in the order preferred when their uncertainties tie. */
export const SOURCE_RANK = ['gps-pps', 'helper-gps', 'helper-ntp', 'serial-gps', 'helper', 'https-ms', 'https-date', 'system'];

/**
 * The best clock from measured sources [{ source, offset, unc, at (local ms when measured), label }]: the smallest
 * uncertainty once ageing is counted; the system clock (offset 0, uncertainty unknown) when nothing has answered.
 */
export function chooseClock(sources, now) {
  const rank = (s) => { const i = SOURCE_RANK.indexOf(s.source); return i < 0 ? SOURCE_RANK.length : i; };
  const live = sources.filter((s) => s && Number.isFinite(s.offset) && Number.isFinite(s.unc))
    .map((s) => ({ ...s, effUnc: agedUncertainty(s.unc, now - (s.at ?? now)) }))
    .sort((a, b) => a.effUnc - b.effUnc || rank(a) - rank(b));
  return live[0] || { source: 'system', label: 'system clock', offset: 0, unc: null, effUnc: null, at: now };
}

/** A short text for a clock: "±12 ms · site Date header" / "system clock (not checked)". */
export function describeClock(c) {
  if (!c || c.source === 'system' || c.effUnc == null) return 'system clock (not checked)';
  const u = c.effUnc, us = u < 1 ? `${(u * 1000).toFixed(0)} µs` : u < 1000 ? `${u.toFixed(0)} ms` : `${(u / 1000).toFixed(1)} s`;
  return `±${us} · ${c.label || c.source}`;
}
