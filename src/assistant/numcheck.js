// The check made on every final answer of the assistant: the numbers it quotes must be numbers a tool returned.
// A language model drops uncertainties and now and then invents a conversion (hours from days, percent from a
// fraction); the app cannot stop it writing, but it can compare what was written with what the tools said and,
// when they differ, put the tools' own table under the answer. No DOM, no model: plain text in, a verdict out.
//
//   numbersIn(text)                 -> [{ raw, value, decimals, index }]   the numbers worth checking in a text
//   checkNumbers(reply, sources)    -> { ok, unsupported: [raw], bare: [{ value, full }] }
//   appendix(check, tables)         -> the Markdown put under the answer ('' when the answer passes)

const NUM = /[-+−]?\d[\d,]*(?:\.\d+)?(?:[eE][-+−]?\d+|\s[eE][-+−]\d+)?/g;
const clean = (raw) => raw.replace(/\s/g, '').replace(/−/g, '-').replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1').replace(/,+$/, '');
const decimalsOf = (s) => { const m = /\.(\d+)/.exec(s); return m ? m[1].length : 0; };

/**
 * The numbers of a text that a reader would take as a measurement. Left out, because they are not: integers below
 * 100 (counts, list numbers, "68%"), years, the digits of a name ("HD 80606", "WASP-43", "run #3", "ld0", "a2@2"),
 * and the digits of a file name or a date.
 */
export function numbersIn(text) {
  const out = [], s = String(text || '');
  for (const m of s.matchAll(NUM)) {
    let raw = m[0]; const i = m.index, before = s.slice(Math.max(0, i - 24), i), after = s.slice(i + raw.length, i + raw.length + 8);
    if (/[A-Za-z_#@]$/.test(before)) continue;                                  // part of a word or a key: ld0, #3, a2@2
    if (/\d\.$/.test(before) || (/^\.\d/.test(after) && raw.includes('.'))) continue;                                           // a dotted version: 4.3.1
    if (/\d[-/:]$/.test(before) || /^[-/:]\d/.test(after)) continue;             // dates and clock times: 2026-11-15, 21:40
    const c = clean(raw).replace(/^\+/, ''), value = Number(c);
    if (!Number.isFinite(value)) continue;
    const integer = !/[.eE]/.test(c), a = Math.abs(value);
    if (integer && a < 100) continue;
    if (integer && a >= 1900 && a <= 2100) continue;
    if (integer && /(?:^|[\s(])[A-Z][A-Za-z0-9]*[- ]$/.test(before)) continue;   // HD 80606, WASP-43, TOI 700
    out.push({ raw, value, decimals: decimalsOf(c), index: i });
  }
  return out;
}

/** Every numeric value of the tool results, the state card and the user's own words. */
function sourceValues(sources) {
  const exact = new Set(), list = [];
  for (const src of sources) for (const m of String(src || '').matchAll(NUM)) {
    const v = Math.abs(Number(clean(m[0]).replace(/^\+/, ''))); if (!Number.isFinite(v)) continue;
    if (!exact.has(v)) { exact.add(v); list.push(v); }
  }
  return { exact, list };
}
const TRIPLE = /(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?) \+(\d+(?:\.\d+)?(?:e[-+]?\d+)?) -(\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi;
const PM = /(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?) ± (\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi;

/**
 * Compare the numbers of a reply with those of its sources (strings: tool results, the state card, the request).
 * A number passes when a source holds the same value, or holds a value that rounds to it at the precision the
 * reply wrote. `bare` lists values a tool gave with an interval ("0.1487 +0.0011 -0.0010", "12.3 ± 0.2") that the
 * reply quotes without it.
 */
export function checkNumbers(reply, sources) {
  // "6.8 × 10^5" and "6.8 x 10⁵" are the same number as 6.8e+5
  const sup = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9, '⁻': '-', '⁺': '' };
  const text = String(reply || '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (m) => '^' + [...m].map((c) => sup[c]).join('')).replace(/(\d)\s*[×x*]\s*10\s*\^\s*\{?\(?([-+−]?\d+)\)?\}?/g, '$1e$2'), nums = numbersIn(text), S = sourceValues(sources), unsupported = [], bare = [];
  const grounded = (n) => { const a = Math.abs(n.value); if (S.exact.has(a)) return true; for (const v of S.list) if (Number(v.toFixed(Math.min(20, n.decimals))) === a && n.decimals > 0) return true; return false; };
  for (const n of nums) if (!grounded(n) && !unsupported.includes(n.raw)) unsupported.push(n.raw);
  const all = sources.join('\n'), seen = new Set();
  const near = (i, len, v) => [...text.slice(i + len, i + len + 70).matchAll(NUM)].some((m) => Math.abs(Number(clean(m[0]).replace(/^\+/, ''))) === v);
  const visit = (full, value, errs) => {
    if (seen.has(full)) return; seen.add(full);
    const v = Math.abs(Number(value)); if (!Number.isFinite(v)) return;
    const hits = nums.filter((n) => Math.abs(n.value) === v && n.decimals === decimalsOf(value)); if (!hits.length) return;
    // quoted somewhere with its interval is enough: the same value may be mentioned again in passing
    if (!hits.some((h) => errs.every((e) => near(h.index, h.raw.length, Math.abs(Number(e)))))) bare.push({ value: String(value), full });
  };
  for (const m of all.matchAll(TRIPLE)) visit(m[0], m[1], [m[2], m[3]]);
  for (const m of all.matchAll(PM)) visit(m[0], m[1], [m[2]]);
  return { ok: !unsupported.length && !bare.length, unsupported, bare };
}

/** What goes under an answer that failed the check: one sentence saying why, and the tools' own tables, verbatim. */
export function appendix(check, tables = []) {
  if (!check || check.ok) return '';
  const why = [];
  if (check.unsupported.length) why.push(`${check.unsupported.length === 1 ? 'the number' : 'the numbers'} ${check.unsupported.slice(0, 8).join(', ')}${check.unsupported.length > 8 ? ', …' : ''} ${check.unsupported.length === 1 ? 'does' : 'do'} not appear in any result the app returned`);
  if (check.bare.length) why.push(`${check.bare.slice(0, 6).map((b) => b.value).join(', ')} ${check.bare.length === 1 ? 'is' : 'are'} quoted without ${check.bare.length === 1 ? 'its' : 'their'} uncertainty`);
  const head = `**Checked by the app:** ${why.join('; ')}.`;
  if (!tables.length) return `\n\n---\n${head} Treat ${check.unsupported.length ? 'those figures' : 'the bare values'} as unverified.` + (check.bare.length ? ' As returned: ' + check.bare.slice(0, 6).map((b) => b.full).join('; ') + '.' : '');
  return `\n\n---\n${head} The values exactly as the app returned them:\n\n${tables.join('\n\n')}`;
}
