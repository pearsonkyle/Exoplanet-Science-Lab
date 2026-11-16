// What the assistant can read about how the site computes things: the Methods document (src/methods/content.js,
// the same source as the Methods page and docs/METHODS.md) and the source code itself. No DOM; the tools in
// tools.js pass the content module and a way to read a source file.
//
//   explainMethod(content, { topic, query })  the best-matching Methods section(s) as plain text with the equations
//                                            in LaTeX ($...$, $$...$$), the code files, the limits and the checks
//   extractSymbol(source, name)              the full text of one function / const / class from a source file
//   SOURCE_FILE                              which files read_source may open (the site's own code only)

const BUDGET = 7000;
// the published Methods page, so the model links to the real address instead of inventing one (update with the domain)
export const METHODS_URL = 'https://pearsonkyle.github.io/Exoplanet-Science-Lab/methods/';            // characters of one answer: enough for a section, small enough for a small model
export const SOURCE_FILE = /^(src|mcp|tools|python\/esl)\/(?!.*\.\.)[A-Za-z0-9_/.-]+\.(js|mjs|py)$/;   // no '..': the site's own code only

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 1);
const STOP = new Set(['the', 'and', 'of', 'to', 'is', 'in', 'how', 'what', 'are', 'for', 'a', 'an', 'it', 'be', 'by', 'on', 'with', 'from', 'computed', 'calculated', 'calculate', 'compute', 'does', 'do', 'site', 'this', 'that']);

/** A block of a section (string, { eq }, { ul }, { h }, { table }) as Markdown with the TeX kept. */
function blockText(b) {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  if (b.eq) return `$$${b.eq}$$`;
  if (b.h) return `### ${b.h}`;
  if (b.ul) return b.ul.map((x) => '- ' + blockText(x)).join('\n');
  if (b.table) return [b.table.head.join(' | '), ...b.table.rows.map((r) => r.join(' | '))].join('\n');
  if (b.stub) return '';
  if (b.topic) return `(checks: Validation topic "${b.topic}")`;
  return '';
}
/** The site's inline markup made plain: {{code}} -> `code`, [@key] -> [key], (v:anchor) links -> their text. */
const plain = (s) => String(s).replace(/\{\{([^}]+)\}\}/g, '`$1`').replace(/\[@([^\]]+)\]/g, '[$1]').replace(/\[([^\]]+)\]\(v:[^)]+\)/g, '$1').replace(/\[([^\]]+)\]\(#[^)]+\)/g, '$1');

function sectionText(s) {
  const parts = [`## ${s.title}`, `Methods page: ${METHODS_URL}#${s.id}`];
  if (s.code && s.code.length) parts.push('Implemented in: ' + s.code.map((c) => '`' + c + '`').join(', '));
  for (const b of s.body || []) { const t = blockText(b); if (t) parts.push(t); }
  if (s.params && s.params.length) parts.push('### Parameters', ...s.params.map((p) => '- ' + (Array.isArray(p) ? p.join(' — ') : blockText(p))));
  if (s.limits && s.limits.length) parts.push('### Assumptions and limits', ...s.limits.map((l) => '- ' + blockText(l)));
  const checks = (s.checks || []).map(blockText).filter(Boolean); if (checks.length) parts.push('### Checks', ...checks.map((c) => '- ' + c));
  return plain(parts.join('\n\n'));
}

/** Score a section against the words of a request: title words count most, then code file names, then the text. */
function score(s, q) {
  if (!q.length) return 0;
  const title = new Set(words(s.title + ' ' + s.id)), code = new Set(words((s.code || []).join(' '))), body = words((s.body || []).map(blockText).join(' ') + ' ' + (s.limits || []).map(blockText).join(' '));
  const bag = new Map(); for (const w of body) bag.set(w, (bag.get(w) || 0) + 1);
  let sc = 0;
  for (const w of q) { if (title.has(w)) sc += 6; if (code.has(w)) sc += 3; const n = bag.get(w) || 0; if (n) sc += Math.min(4, 1 + Math.log2(n)); }
  return sc;
}

/**
 * The Methods text for a topic. With neither topic nor query: the list of sections (id, title, code files).
 * topic: a section id (exact) or words; query: the user's question in words. Returns { sections: [...], text } where
 * text is Markdown with LaTeX, cut to a budget, and `more` names the other sections that matched.
 */
export function explainMethod(content, { topic, query } = {}) {
  const S = content.SECTIONS || [];
  if (!topic && !query) return { sections: S.map((s) => ({ id: s.id, title: s.title, code: s.code || [] })), note: 'Call again with topic set to one of these ids, or with query in words.' };
  const exact = topic && S.find((s) => s.id === String(topic).trim());
  const q = words(`${exact ? '' : topic || ''} ${query || ''}`).filter((w) => !STOP.has(w));
  const ranked = exact ? [exact] : S.map((s) => ({ s, sc: score(s, q) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).map((x) => x.s);
  if (!ranked.length) return { found: false, sections: S.map((s) => ({ id: s.id, title: s.title })), note: 'Nothing matched those words: pick a section id from this list.' };
  let text = sectionText(ranked[0]);
  if (!exact && ranked[1] && text.length < BUDGET / 2) text += '\n\n' + sectionText(ranked[1]);
  const cut = text.length > BUDGET;
  return {
    found: true, section: ranked[0].id, title: ranked[0].title, code: ranked[0].code || [],
    text: cut ? text.slice(0, BUDGET) + '\n…(cut: ask for this section with a narrower query, or read the code with read_source)' : text,
    more: ranked.slice(exact ? 0 : 1, 6).filter((s) => s !== ranked[0]).map((s) => ({ id: s.id, title: s.title })),
    how_to_use: 'This is the site\'s own description: answer the user from it now. Quote its equations exactly (LaTeX between $...$ or $$...$$ renders in the chat); for a derivation, go step by step in symbols from these definitions and standard physics. Only if the user wants the code itself, call read_source once with a file from "code" and the function name.',
  };
}

/** Index of the character that closes the bracket opened at `open`, skipping strings, template literals and comments. */
function closeOf(src, open) {
  const pair = { '{': '}', '(': ')', '[': ']' }, stack = [src[open]];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++; continue; }
    if (pair[c]) stack.push(c);
    else if (c === '}' || c === ')' || c === ']') { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

/**
 * The text of one top-level symbol of a JavaScript (or Python) source file, with the comment block above it.
 * Returns { name, text, line } or { error, symbols } listing what the file defines.
 */
export function extractSymbol(src, name, { budget = 9000 } = {}) {
  const lines = src.split('\n');
  const py = /^\s*def |^\s*class /m.test(src) && !/^\s*(export )?function /m.test(src);
  const defs = [];
  lines.forEach((l, i) => {
    const m = py ? /^(?:def|class)\s+([A-Za-z_]\w*)/.exec(l) : /^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) defs.push({ name: m[1], line: i });
  });
  const d = defs.find((x) => x.name === name);
  if (!d) return { error: `no top-level "${name}" in this file`, symbols: defs.map((x) => x.name).slice(0, 200) };
  let first = d.line; while (first > 0 && /^\s*(\/\/|\*|\/\*\*|#)/.test(lines[first - 1])) first--;
  let text;
  if (py) {
    let end = d.line + 1; while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    text = lines.slice(first, end).join('\n');
  } else {
    const startChar = lines.slice(0, d.line).join('\n').length + (d.line ? 1 : 0), head = src.slice(startChar);
    // the body: the first { of a function or class, else the statement up to its semicolon at depth 0
    const fn = /^(?:export\s+)?(?:async\s+)?(?:function|class)/.test(head);
    let endChar;
    if (fn) { const o = src.indexOf('{', startChar); endChar = closeOf(src, o); }
    else {
      endChar = -1; for (let i = startChar; i < src.length; i++) { const c = src[i]; if ('{(['.includes(c)) { i = closeOf(src, i); if (i < 0) break; continue; } if (c === ';' || (c === '\n' && /^\S/.test(src[i + 1] || ''))) { endChar = i; break; } }
    }
    const pre = lines.slice(first, d.line).join('\n');
    text = (pre ? pre + '\n' : '') + src.slice(startChar, endChar < 0 ? startChar + budget : endChar + 1);
  }
  return { name, line: d.line + 1, text: text.length > budget ? text.slice(0, budget) + '\n…(cut)' : text };
}
