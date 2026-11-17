// Dates of observing nights resolved against today (src/core/nightdates.js): planning is for nights to come.
import { resolveNight, resolveRange, isBareMonth, spanText, rangeInText } from '../src/core/nightdates.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const T = '2026-11-16';   // a Monday in November, as when the request "transits between January and July" was made
const d = (x, o) => resolveNight(x, T, o).date;

check('a date without a year is its next occurrence', d('Jan 15') === '2027-01-15' && d('15 January') === '2027-01-15' && d('01-15') === '2027-01-15' && d('1/15') === '2027-01-15' && d('Dec 3') === '2026-12-03');
check('a bare month is its first day, next time it comes', d('January') === '2027-01-01' && d('July') === '2027-07-01' && d('December') === '2026-12-01');
check('this month without a day starts today', d('November') === '2026-11-16' && d('Nov 20') === '2026-11-20' && d('Nov 2') === '2027-11-02');
check('today and tonight', d('tonight') === T && d('today') === T && d('Nov 16') === T);
const past = resolveNight('2026-01-15', T);
check('a full date in the past moves to next year, with a note', past.date === '2027-01-15' && /in the past/.test(past.note), past.note);
check('a past date is kept when past dates are allowed', d('2026-01-15', { allowPast: true }) === '2026-01-15');
check('a full future date is kept as given', d('2027-03-04') === '2027-03-04' && d('March 4 2027') === '2027-03-04' && d('3/4/2027') === '2027-03-04');
check('29 February in a year without one becomes the 28th; a non-date is refused', d('Feb 29') === '2027-02-28' && (() => { try { resolveNight('Smarch 3', T); return false; } catch { return true; } })() && (() => { try { resolveNight('Apr 31', T); return false; } catch { return true; } })());
const r = resolveRange('January', 'July', T);
check('"between January and July" in November is next year, cut at 90 nights with the rest named', r.first === '2027-01-01' && r.requested_last === '2027-07-31' && r.nights === 90 && r.last === '2027-03-31' && r.rest_from === '2027-04-01' && /planned now/.test(r.note), r.note);
const w = resolveRange('Dec 20', 'Feb 10', T);
check('a range that wraps the year ends the next year', w.first === '2026-12-20' && w.last === '2027-02-10' && w.nights === 53);
const s = resolveRange('tonight', 'Nov 30', T);
check('tonight to the end of the month', s.first === T && s.last === '2026-11-30' && s.nights === 15);
const pr = resolveRange('2026-03-01', '2026-03-10', T);
check('a past range moves to next year as a whole', pr.first === '2027-03-01' && pr.last === '2027-03-10' && pr.nights === 10 && /in the past/.test(pr.note));
const jan = resolveRange('January', 'January', T);
check('a month alone is the whole month', isBareMonth('January') && isBareMonth('jan 2027') && !isBareMonth('Jan 3') && jan.first === '2027-01-01' && jan.last === '2027-01-31' && jan.nights === 31);
check('the span a plan covers, in words', spanText('2027-01-01', 31) === '2027-01-01 to 2027-01-31 (31 nights)' && spanText('2027-02-27', 3) === '2027-02-27 to 2027-03-01 (3 nights)' && spanText('2027-01-05', 1) === '2027-01-05 (1 night)');
const rt = (t) => JSON.stringify(rangeInText(t));
check('a range of months found in the user\'s words', rt('Which transits between January and July?') === '{"from":"January","to":"July"}' && rt('from Jan 5 to Feb 10') === '{"from":"Jan 5","to":"Feb 10"}' && rt('Jan-Jul please') === '{"from":"Jan","to":"Jul"}' && rangeInText('first week of March') === null && rangeInText('transits in May') === null);
const fa = resolveRange(rangeInText('between February and April.').from, rangeInText('between February and April.').to, T);
check('"between February and April." resolves to 1 Feb to 30 Apr next year', fa.first === '2027-02-01' && fa.last === '2027-04-30' && fa.nights === 89, JSON.stringify(fa));
process.exit(ok ? 0 : 1);
