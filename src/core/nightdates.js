// Dates of observing nights as people (and language models) write them, resolved against today. No DOM.
//
//   resolveNight(text, today, { allowPast, end })  -> { date: 'YYYY-MM-DD', note? }
//     "2027-01-15", "Jan 15", "15 January", "January 15 2027", "01-15", "1/15", "January" (the 1st), "tonight"
//     A date written without a year is its next occurrence (today counts). A full date in the past is moved to the
//     same day of the next year that is not in the past, and the note says so, unless allowPast is set: planning is
//     for nights to come. With end: true a bare month means its last day ("until July" -> July 31).
//   resolveRange(from, to, today, { maxNights })   -> { first, last, nights, note? }
//     both ends resolved; the end is after the start (a year is added when a range like "Nov to Feb" wraps);
//     a span longer than maxNights is cut there, and the note says what is left.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNum = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
/** today as { y, m, d } from a Date (local calendar of the caller) or 'YYYY-MM-DD'. */
function ymd(today) {
  if (typeof today === 'string') { const [y, m, d] = today.split('-').map(Number); return { y, m, d }; }
  const t = today || new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
}
const monthOf = (s) => { const i = MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()); return i >= 0 ? i + 1 : 0; };

/** { y|null, m, d|null } from the text, or null when it is not a date. */
function parse(text) {
  const s = String(text).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s))) return { y: null, m: +m[1], d: +m[2] };                    // MM-DD, M/D
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return { y: +m[3], m: +m[1], d: +m[2] };          // M/D/YYYY
  if ((m = /^([a-z]{3,9})\.? (\d{1,2})(?: (\d{4}))?$/.exec(s)) && monthOf(m[1])) return { y: m[3] ? +m[3] : null, m: monthOf(m[1]), d: +m[2] };
  if ((m = /^(\d{1,2}) ([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(s)) && monthOf(m[2])) return { y: m[3] ? +m[3] : null, m: monthOf(m[2]), d: +m[1] };
  if ((m = /^([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(s)) && monthOf(m[1])) return { y: m[2] ? +m[2] : null, m: monthOf(m[1]), d: null };
  return null;
}

export function resolveNight(text, today = new Date(), { allowPast = false, end = false } = {}) {
  const t = ymd(today);
  if (/^(tonight|today|now|auto)$/i.test(String(text).trim())) return { date: iso(t.y, t.m, t.d), tonight: true };
  const p = parse(text);
  if (!p || p.m < 1 || p.m > 12) throw new Error(`"${text}" is not a date I can read: give YYYY-MM-DD, a month and day ("Jan 15"), a month ("July") or "tonight"`);
  const dayFor = (y) => (p.d === null ? (end ? daysIn(y, p.m) : 1) : Math.min(p.d, daysIn(y, p.m)));
  if (p.d !== null && p.d > daysIn(p.y || 2024, p.m)) throw new Error(`${text}: month ${p.m} has no day ${p.d}`);
  const now = dayNum(t.y, t.m, t.d);
  if (p.y === null) {
    // no year: the next time this day comes round (a whole month counts while any of it is still ahead)
    let y = t.y; const last = p.d === null ? daysIn(y, p.m) : dayFor(y);
    if (dayNum(y, p.m, last) < now) y++;
    let d = dayFor(y); if (y === t.y && p.d === null && !end && p.m === t.m) d = t.d;   // "November" in November: from today
    return { date: iso(y, p.m, d), ...(y !== t.y ? { note: `no year was given: ${iso(y, p.m, d)} is the next ${MONTHS[p.m - 1][0].toUpperCase() + MONTHS[p.m - 1].slice(1)}${p.d === null ? '' : ' ' + p.d} to come` } : {}) };
  }
  let y = p.y, d = dayFor(y);
  if (!allowPast && dayNum(y, p.m, d) < now) {
    const was = iso(y, p.m, d);
    while (dayNum(y, p.m, dayFor(y)) < now) y++;
    d = dayFor(y);
    return { date: iso(y, p.m, d), note: `${was} is in the past (today is ${iso(t.y, t.m, t.d)}): planned for ${iso(y, p.m, d)} instead` };
  }
  return { date: iso(y, p.m, d) };
}

export function resolveRange(from, to, today = new Date(), { maxNights = 90, allowPast = false } = {}) {
  const a = resolveNight(from, today, { allowPast }), notes = a.note ? [a.note] : [];
  let b = resolveNight(to, today, { allowPast, end: true });
  const [ay, am, ad] = a.date.split('-').map(Number);
  let [by, bm, bd] = b.date.split('-').map(Number);
  // the end before the start ("from November to February", or a bare end month resolved to this year): a year later
  while (dayNum(by, bm, bd) < dayNum(ay, am, ad)) { by++; bd = Math.min(bd, daysIn(by, bm)); }
  if (b.note && !/no year was given/.test(b.note)) notes.push(b.note);
  let nights = dayNum(by, bm, bd) - dayNum(ay, am, ad) + 1;
  const last = iso(by, bm, bd);
  if (nights > maxNights) {
    const cut = new Date(Date.UTC(ay, am - 1, ad + maxNights - 1)), cutIso = cut.toISOString().slice(0, 10);
    const next = new Date(Date.UTC(ay, am - 1, ad + maxNights)).toISOString().slice(0, 10);
    notes.push(`${a.date} to ${last} is ${nights} nights; the planner covers ${maxNights} at a time, so ${a.date} to ${cutIso} is planned now. For the rest, plan again from ${next}`);
    return { first: a.date, last: cutIso, nights: maxNights, requested_last: last, rest_from: next, note: notes.join('; ') };
  }
  return { first: a.date, last, nights, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

/** "January", "jan", "January 2027": a month without a day. */
export const isBareMonth = (text) => { const p = parse(text); return !!p && p.d === null; };
/** "2027-01-01 to 2027-01-31 (31 nights)" from a first night (null: tonight) and a count. */
export function spanText(first, nights, today = new Date()) {
  const f = first || resolveNight('tonight', today).date, [y, m, d] = f.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1, d + nights - 1)).toISOString().slice(0, 10);
  return nights > 1 ? `${f} to ${last} (${nights} nights)` : `${f} (1 night)`;
}

/**
 * A range of months in a sentence: "between January and July", "from Feb to April", "Jan-Jul", "January through March".
 * Returns { from, to } (the words as written) or null. Days are allowed ("from Jan 5 to Feb 10").
 */
export function rangeInText(text) {
  const M = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?', D = `(?:${M}(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${M}(?:\\s+\\d{4})?)`;
  const re = new RegExp(`(?:between|from)?\\s*(${D})\\s*(?:and|to|until|till|through|thru|-|–|—)\\s*(${D})`, 'i');
  const m = re.exec(String(text || ''));
  return m ? { from: m[1].trim(), to: m[2].trim() } : null;
}
