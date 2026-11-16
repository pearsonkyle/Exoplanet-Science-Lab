// TESS candidates as analyzer sessions (src/ui/intro.js sessionFromTOI) from the TOI snapshot (public/catalog-table/toi.json
// read by src/core/sources/toi.js). The reference is the TOI row itself: depth = (Rp/R★)², the duration and period
// recomputed from the session's orbit (src/core/kepler.js derived) must give back the row's T14.
import { readFileSync } from 'node:fs';
import toi from '../src/core/sources/toi.js';
import { sessionFromTOI, parseTOIName } from '../src/ui/intro.js';
import { derived } from '../src/core/kepler.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const J = JSON.parse(readFileSync(new URL('../public/catalog-table/toi.json', import.meta.url))), R = toi.records(J).records;
check('names', JSON.stringify([parseTOIName('TOI-1234.01'), parseTOIName('toi 1234'), parseTOIName('TOI_270.2'), parseTOIName('HD 1')]) === '[{"host":1234,"planet":1},{"host":1234,"planet":null},{"host":270,"planet":2},null]');
const s = sessionFromTOI(R, 'TOI-101.01', J.date), r = R.find((x) => x.name === 'TOI-101.01');
const p = s.planets[0].values, d = derived({ ...p });
check('TOI-101.01: Rp/R★ from the depth, period and T0 as listed', Math.abs(p.rprs ** 2 - r.v.depth) / r.v.depth < 1e-3 && p.per === r.v.per && p.tmid === r.v.tmid, `Rp/R★ ${p.rprs}, depth ${r.v.depth}`);
check('TOI-101.01: the orbit gives back the listed duration', Math.abs(d.t14 - r.v.t14) / r.v.t14 < 0.03, `T14 ${(d.t14 * 24).toFixed(3)} h against ${(r.v.t14 * 24).toFixed(3)} h; a/R★ ${p.ars}, i ${p.inc}°`);
check('labelled a candidate', s.candidate && /TESS candidate/.test(s.title) && /TOI candidate/.test(s.note) && s.star.ra === r.v.ra);
const m = sessionFromTOI(R, 'TOI-270', J.date);
check('a host with several TOIs gives one planet each', m && m.planets.length >= 2 && m.planets.map((x) => x.letter).join('').startsWith('bc'), m ? m.planets.length + ' planets' : 'none');
check('an unknown TOI gives null', sessionFromTOI(R, 'TOI-999999.01', J.date) === null);
process.exit(ok ? 0 : 1);
