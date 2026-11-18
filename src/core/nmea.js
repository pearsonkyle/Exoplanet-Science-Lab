// NMEA 0183 sentences from a GPS receiver (a USB "puck" read through Web Serial, gpsd's raw mode, a log file):
// time from RMC and ZDA, position and fix quality from GGA. Any talker (GP, GN, GL, GA, BD). No DOM.
//
// What a receiver's time is worth: the sentence for second S is sent after S, by a delay that depends on the
// receiver (tens to a few hundred ms) and is not in the sentence. Without the PPS pulse the clock is therefore
// good to that delay; clock.js counts it as an uncertainty (see `NMEA_LATENCY`), it is not a correction.

/** Delay [ms] between the second a sentence names and its first character arriving: the bound used when it is not measured. */
export const NMEA_LATENCY = { min: 0, max: 250 };

/** XOR checksum of the characters between '$' and '*', as two upper-case hex digits. */
export function nmeaChecksum(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}

const latlon = (v, hemi, degDigits) => {
  if (!v) return NaN;
  const d = +v.slice(0, degDigits), m = +v.slice(degDigits);
  const x = d + m / 60;
  return hemi === 'S' || hemi === 'W' ? -x : x;
};
const hms = (s) => { const m = /^(\d\d)(\d\d)(\d\d(?:\.\d+)?)$/.exec(s || ''); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 : NaN; };

/**
 * Parse one sentence. Returns null for anything that is not a well-formed sentence with a correct checksum
 * (a checksum is required: a serial line drops characters).
 * @returns { talker, type, fields, valid, utcMs?, timeOfDayMs?, lat?, lon?, alt?, fix?, sats?, hdop? }
 */
export function parseNmea(line) {
  const s = String(line).trim();
  const m = /^\$([A-Z]{2})([A-Z]{3}),(.*)\*([0-9A-Fa-f]{2})$/.exec(s);
  if (!m) return null;
  const body = s.slice(1, s.lastIndexOf('*'));
  if (nmeaChecksum(body) !== m[4].toUpperCase()) return null;
  const f = m[3].split(','), out = { talker: m[1], type: m[2], fields: f, valid: false };
  if (m[2] === 'RMC') {
    // hhmmss.ss, status A/V, lat, N/S, lon, E/W, speed, course, ddmmyy, ...
    const tod = hms(f[0]), d = /^(\d\d)(\d\d)(\d\d)$/.exec(f[8] || '');
    out.valid = f[1] === 'A';
    out.timeOfDayMs = tod;
    if (d && Number.isFinite(tod)) { const yy = +d[3]; out.utcMs = Date.UTC(yy < 80 ? 2000 + yy : 1900 + yy, +d[2] - 1, +d[1]) + tod; }
    out.lat = latlon(f[2], f[3], 2); out.lon = latlon(f[4], f[5], 3);
  } else if (m[2] === 'ZDA') {
    // hhmmss.ss, day, month, year (4 digits), local zone hours, minutes
    const tod = hms(f[0]);
    out.timeOfDayMs = tod;
    if (Number.isFinite(tod) && f[1] && f[2] && /^\d{4}$/.test(f[3] || '')) out.utcMs = Date.UTC(+f[3], +f[2] - 1, +f[1]) + tod;
    out.valid = Number.isFinite(out.utcMs);
  } else if (m[2] === 'GGA') {
    // hhmmss.ss, lat, N/S, lon, E/W, fix quality, satellites, HDOP, altitude, M, geoid separation, M, ...
    out.timeOfDayMs = hms(f[0]);
    out.lat = latlon(f[1], f[2], 2); out.lon = latlon(f[3], f[4], 3);
    out.fix = +f[5] || 0; out.sats = +f[6] || 0; out.hdop = f[7] === '' ? NaN : +f[7];
    out.alt = f[8] === '' ? NaN : +f[8];                       // above mean sea level (the geoid)
    out.valid = out.fix > 0;
  }
  return out;
}

/**
 * A reader for a stream of characters (Web Serial chunks): call push(text, arrivalMs) with each chunk and the local
 * time it arrived; it calls onSentence(parsed, arrivalMs of the sentence's first character) for each complete line.
 * The first sentence after a quiet gap of `gapMs` starts a new burst (the receiver's report of one second):
 * burst = true marks it, because its first character is the one closest to the second it reports.
 */
export function nmeaStream(onSentence, { gapMs = 200 } = {}) {
  let buf = '', firstAt = null, lastAt = -Infinity;
  return {
    push(text, at) {
      for (const ch of text) {
        if (buf === '' && ch !== '$') continue;
        if (buf === '') { firstAt = at; }
        if (ch === '\n' || ch === '\r') {
          const p = parseNmea(buf);
          if (p) { const burst = firstAt - lastAt > gapMs; onSentence(p, firstAt, burst); }
          lastAt = at; buf = '';
        } else buf += ch;
        if (buf.length > 120) buf = '';                       // longer than any NMEA sentence: noise
      }
    },
  };
}
