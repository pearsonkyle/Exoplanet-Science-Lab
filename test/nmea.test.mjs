// NMEA parsing (src/core/nmea.js) against published example sentences: the RMC and GGA examples of
// http://www.gpsinformation.org/dale/nmea.htm (Dale DePriest; 1994-03-23 12:35:19 UTC, 48°07.038' N 11°31.000' E,
// 545.4 m) whose checksums 6A and 47 are given there, and the ZDA example of the NovAtel OEM7 manual
// ($GPZDA,143042.00,25,08,2005,,*6E: 2005-08-25 14:30:42 UTC).
import { parseNmea, nmeaChecksum, nmeaStream } from '../src/core/nmea.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const RMC = '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A';
const GGA = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
const ZDA = '$GPZDA,143042.00,25,08,2005,,*6E';

check('checksums of the published examples', nmeaChecksum(RMC.slice(1, -3)) === '6A' && nmeaChecksum(GGA.slice(1, -3)) === '47' && nmeaChecksum(ZDA.slice(1, -3)) === '6E');
const r = parseNmea(RMC);
check('RMC: date and time', r.valid && r.utcMs === Date.UTC(1994, 2, 23, 12, 35, 19), new Date(r.utcMs).toISOString());
check('RMC: position', Math.abs(r.lat - (48 + 7.038 / 60)) < 1e-12 && Math.abs(r.lon - (11 + 31 / 60)) < 1e-12, `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`);
const g = parseNmea(GGA);
check('GGA: fix, satellites, altitude', g.valid && g.fix === 1 && g.sats === 8 && g.hdop === 0.9 && g.alt === 545.4 && Math.abs(g.lat - 48.1173) < 1e-12);
const z = parseNmea(ZDA);
check('ZDA: date and time with hundredths', z.valid && z.utcMs === Date.UTC(2005, 7, 25, 14, 30, 42), new Date(z.utcMs).toISOString());
check('a GNSS talker (GN) and a fractional second', parseNmea('$GNZDA,235959.25,31,12,2016,00,00*' + nmeaChecksum('GNZDA,235959.25,31,12,2016,00,00')).utcMs === Date.UTC(2016, 11, 31, 23, 59, 59, 250));
check('wrong checksum, no checksum, void fix', parseNmea(RMC.replace('*6A', '*6B')) === null && parseNmea(RMC.slice(0, -3)) === null && parseNmea('$GPRMC,123519,V,,,,,,,230394,,*' + nmeaChecksum('GPRMC,123519,V,,,,,,,230394,,')).valid === false);
check('southern and western hemispheres', (() => { const b = 'GPRMC,000000,A,3354.000,S,07030.000,W,0,0,010125,,'; const p = parseNmea('$' + b + '*' + nmeaChecksum(b)); return Math.abs(p.lat + 33.9) < 1e-12 && Math.abs(p.lon + 70.5) < 1e-12 && p.utcMs === Date.UTC(2025, 0, 1); })());

// a stream in odd chunks: sentences split across chunks, the burst flag on the first of each second
{
  const got = [];
  const st = nmeaStream((p, at, burst) => got.push({ type: p.type, at, burst }));
  const sec = (t) => [RMC + '\r\n', GGA + '\r\n'].join('');
  const text1 = 'noise' + sec(), text2 = sec();
  st.push(text1.slice(0, 30), 1000); st.push(text1.slice(30), 1003);
  st.push(text2, 2001);
  check('stream: lines across chunks, first character time, burst start', got.length === 4 && got[0].at === 1000 && got[0].burst && !got[1].burst && got[2].burst && got[2].at === 2001,
    JSON.stringify(got));
}

process.exit(ok ? 0 : 1);
