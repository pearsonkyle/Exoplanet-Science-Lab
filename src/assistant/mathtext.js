// Equations in the assistant's messages: find the TeX in a line of text and turn it into MathML with the Methods
// page's converter (src/methods/tex.js), which current browsers render natively. No DOM, no dependency.
//
//   mathSegments(text)  [{ text } | { math: true, display, tex }]: $...$ and \( \) inline, $$...$$ and \[ \] displayed.
//                       A dollar amount ("$5 and $10") is not math: an inline $ must not be followed by a space or a
//                       digit-only run, and the closing $ must not be preceded by a space or followed by a digit.
//                       Code spans (`...`) are left alone.
//   mathHtml(seg, esc)  the MathML of one math segment, or its TeX in a <code> when the converter does not know a
//                       command (models write more LaTeX than the Methods subset).

import { texToMathML } from '../methods/tex.js';

const RE = /(`[^`]*`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s\d.,]*\$)(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g;

export function mathSegments(text) {
  const out = []; let last = 0, m;
  const s = String(text);
  RE.lastIndex = 0;
  while ((m = RE.exec(s))) {
    if (m[1]) continue;                                           // a code span: stays text
    const inline = m[5] !== undefined;
    if (inline && /^\d[\d.,]*$/.test(m[5].trim())) continue;     // "$5$"-like money
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ math: true, display: !inline && m[4] === undefined, tex: (m[2] ?? m[3] ?? m[4] ?? m[5]).trim() });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.length ? out : [{ text: s }];
}

/** Common LaTeX a model writes that the Methods subset spells differently. */
const normalise = (tex) => tex
  .replace(/\\(?:operatorname|mathit|textrm|textit|mathsf)\{([^}]*)\}/g, '\\mathrm{$1}')
  .replace(/\\(?:displaystyle|textstyle|limits|nolimits)\b/g, '')
  .replace(/\\(dfrac|tfrac)\b/g, '\\frac')
  .replace(/\\(?:big|Big|bigg|Bigg)([lr]?)\b/g, '')
  .replace(/\\boldsymbol\{([^}]*)\}/g, '\\mathbf{$1}')
  .replace(/\\(leq|geq|neq)\b/g, (x, c) => ({ leq: '\\le', geq: '\\ge', neq: '\\ne' }[c]))
  .replace(/\\(?:quad|qquad)\b/g, (x) => x)
  .replace(/\\,|\\;|\\!/g, (x) => x);

export function mathHtml(seg, esc) {
  try { return texToMathML(normalise(seg.tex), { display: seg.display }); }
  catch { return `<code class="ai-tex${seg.display ? ' d' : ''}">${esc(seg.display ? `$$${seg.tex}$$` : `$${seg.tex}$`)}</code>`; }
}
