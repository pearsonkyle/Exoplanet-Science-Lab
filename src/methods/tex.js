// A small LaTeX-to-MathML converter for the Methods page. No dependency, no DOM: texToMathML(src) returns a string.
//
// The equations of src/methods/content.js are written once, in the LaTeX subset below; the page turns them into
// MathML (rendered natively by current Chromium, Firefox and Safari, so the site works offline) and
// tools/build_methods_md.mjs writes the same source between $$ ... $$ for docs/METHODS.md.
//
// Subset: \frac{}{}  \sqrt{}  \sqrt[n]{}  ^  _  {groups}  \left \right  \mathrm{} \text{} \mathbf{}  \bar{} \hat{} \dot{}
// Greek letters, \sum \prod \int \oint (limits by ^ and _), named functions (\ln \exp \sin ...), spacing (\, \; \quad),
// and the symbols in SYM. An unknown command throws, so a typo fails the build of docs/METHODS.md instead of
// reaching a reader.

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
// [character, element]
const SYM = {
  cdot: ['·', 'mo'], times: ['×', 'mo'], pm: ['±', 'mo'], le: ['≤', 'mo'], ge: ['≥', 'mo'], ne: ['≠', 'mo'], approx: ['≈', 'mo'], simeq: ['≃', 'mo'], sim: ['∼', 'mo'],
  propto: ['∝', 'mo'], equiv: ['≡', 'mo'], to: ['→', 'mo'], Rightarrow: ['⇒', 'mo'], Leftrightarrow: ['⇔', 'mo'], in: ['∈', 'mo'], cap: ['∩', 'mo'], cup: ['∪', 'mo'],
  ll: ['≪', 'mo'], gg: ['≫', 'mo'], partial: ['∂', 'mi'], infty: ['∞', 'mi'], star: ['★', 'mi'], odot: ['☉', 'mi'], oplus: ['⊕', 'mi'], ell: ['ℓ', 'mi'], dots: ['…', 'mo'], ldots: ['…', 'mo'],
  cdots: ['⋯', 'mo'], langle: ['⟨', 'mo'], rangle: ['⟩', 'mo'], lvert: ['|', 'mo'], rvert: ['|', 'mo'], circ: ['∘', 'mo'], prime: ['′', 'mo'], mid: ['|', 'mo'], lceil: ['⌈', 'mo'], rceil: ['⌉', 'mo'], lfloor: ['⌊', 'mo'], rfloor: ['⌋', 'mo'],
  notin: ['∉', 'mo'], leftarrow: ['←', 'mo'], mp: ['∓', 'mo'],
};
const BIG = { sum: '∑', prod: '∏', int: '∫', oint: '∮' };
const FUNCS = ['ln', 'log', 'exp', 'sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'sinh', 'sec', 'max', 'min', 'det', 'erfc'];
const SPACE = { ',': '0.17em', ';': '0.28em', ':': '0.22em', '!': '0', quad: '1em', qquad: '2em', ' ': '0.28em' };
const ACCENT = { bar: '¯', hat: '^', dot: '˙', tilde: '~' };

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function tokenize(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      i += m[0].length;
      if ((m[1] === 'text' || m[1] === 'mathrm' || m[1] === 'mathbf') && src[i] === '{') {
        // text commands keep their argument verbatim (spaces included)
        let depth = 1, j = i + 1; while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
        if (depth) throw new Error('tex: unbalanced braces in: ' + src);
        out.push({ t: 'raw', cmd: m[1], v: src.slice(i + 1, j - 1) }); i = j;
      } else out.push({ t: 'cmd', v: m[1] });
    } else if (/\s/.test(c)) i++;
    else if (/[0-9]/.test(c)) { const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i)); out.push({ t: 'num', v: m[0] }); i += m[0].length; }
    else if (/[A-Za-z]/.test(c)) { out.push({ t: 'id', v: c }); i++; }
    else { out.push({ t: 'ch', v: c }); i++; }
  }
  return out;
}

/** MathML (a string) for a LaTeX-subset expression. display: block or inline. */
export function texToMathML(src, { display = false } = {}) {
  const tk = tokenize(src); let p = 0;
  const peek = () => tk[p], is = (t, v) => tk[p] && tk[p].t === t && (v === undefined || tk[p].v === v);
  const row = (a) => (a.length === 1 ? a[0] : `<mrow>${a.join('')}</mrow>`);

  /** One argument: a braced group or a single atom. */
  function arg() {
    if (is('ch', '{')) { p++; const a = seq(true); return row(a); }
    return atom();
  }
  /** Is the token just consumed at the start of a group or right after an operator or an opening bracket? */
  const OPENERS = '=+-(,[{<>/*|^_', OPCMD = new Set(['left', 'cdot', 'times', 'pm', 'mp', 'le', 'ge', 'approx', 'sim', 'propto', 'equiv', 'to', 'in', 'leftarrow', 'quad', 'qquad', ',', ';', 'frac', 'sqrt']);
  const prefix = () => { const q = tk[p - 2]; return !q || (q.t === 'ch' && OPENERS.includes(q.v)) || (q.t === 'cmd' && (OPCMD.has(q.v) || BIG[q.v])); };
  function atom() {
    const t = tk[p++];
    if (!t) throw new Error('tex: unexpected end in: ' + src);
    if (t.t === 'num') return `<mn>${t.v}</mn>`;
    if (t.t === 'raw') return t.cmd === 'text' ? `<mtext>${esc(t.v)}</mtext>` : `<mi mathvariant="${t.cmd === 'mathbf' ? 'bold' : 'normal'}">${esc(t.v)}</mi>`;
    if (t.t === 'id') return `<mi>${t.v}</mi>`;
    if (t.t === 'ch') {
      if (t.v === '{') return row(seq(true));
      if (t.v === '-') return prefix() ? '<mo form="prefix" lspace="0" rspace="0">−</mo>' : '<mo>−</mo>';
      if (t.v === '+' && prefix()) return '<mo form="prefix" lspace="0" rspace="0">+</mo>';
      if (t.v === "'") return '<mo>′</mo>';
      if (t.v === '*') return '<mo>·</mo>';
      if ('()[]|'.includes(t.v)) return `<mo stretchy="false">${t.v}</mo>`;
      if (t.v === '/') return '<mo lspace="0" rspace="0">/</mo>';
      return `<mo>${esc(t.v)}</mo>`;
    }
    const c = t.v;
    if (c === 'frac') { const a = arg(), b = arg(); return `<mfrac>${a}${b}</mfrac>`; }
    if (c === 'sqrt') {
      if (is('ch', '[')) { p++; const idx = []; while (!is('ch', ']')) idx.push(atom()); p++; const a = arg(); return `<mroot>${a}${row(idx)}</mroot>`; }
      return `<msqrt>${arg()}</msqrt>`;
    }
    if (ACCENT[c]) return `<mover accent="true">${arg()}<mo>${ACCENT[c]}</mo></mover>`;
    if (c === 'left' || c === 'right') {
      const d = tk[p++]; const ch = d.t === 'cmd' ? (d.v === '{' || d.v === '}' ? d.v : (SYM[d.v] || ['|'])[0]) : d.v;
      return ch === '.' ? '' : `<mo fence="true" stretchy="true">${esc(ch)}</mo>`;
    }
    if (GREEK[c]) return `<mi>${GREEK[c]}</mi>`;
    if (SYM[c]) return `<${SYM[c][1]}>${SYM[c][0]}</${SYM[c][1]}>`;
    if (BIG[c]) return `<mo largeop="true">${BIG[c]}</mo>`;
    if (FUNCS.includes(c)) {
      // thin spaces as TeX sets them: before the name unless it starts a group or follows an operator, after it unless a bracket or a script follows
      const nx = tk[p], tight = !nx || (nx.t === 'ch' && '([^_}'.includes(nx.v)) || (nx.t === 'cmd' && nx.v === 'left');
      return `${prefix() ? '' : '<mspace width="0.17em"/>'}<mi>${c}</mi>${tight ? '' : '<mspace width="0.17em"/>'}`;
    }
    if (c in SPACE) return `<mspace width="${SPACE[c]}"/>`;
    if (c === '{' || c === '}') return `<mo stretchy="false">${c}</mo>`;
    if (c === '%') return '<mo>%</mo>';
    throw new Error(`tex: unknown command \\${c} in: ${src}`);
  }
  /** A sequence up to a closing brace (inGroup) or the end, with ^ and _ attached to the atom before them. */
  function seq(inGroup) {
    const out = [];
    while (p < tk.length) {
      if (is('ch', '}')) { if (!inGroup) throw new Error('tex: stray } in: ' + src); p++; return out; }
      const start = tk[p], big = start.t === 'cmd' && (start.v === 'sum' || start.v === 'prod' || start.v === 'max' || start.v === 'min');
      let base = atom(), sub = null, sup = null;
      while (is('ch', '_') || is('ch', '^')) { const k = tk[p++].v; const a = arg(); if (k === '_') sub = a; else sup = a; }
      if (start.t === 'cmd' && FUNCS.includes(start.v) && (sub || sup)) base = `<mi>${start.v}</mi>`, sub || sup ? (out.length ? out.push('<mspace width="0.17em"/>') : 0) : 0;
      if (sub && sup) base = big ? `<munderover>${base}${sub}${sup}</munderover>` : `<msubsup>${base}${sub}${sup}</msubsup>`;
      else if (sub) base = big ? `<munder>${base}${sub}</munder>` : `<msub>${base}${sub}</msub>`;
      else if (sup) base = big ? `<mover>${base}${sup}</mover>` : `<msup>${base}${sup}</msup>`;
      if (base) out.push(base);
      if (start.t === 'cmd' && FUNCS.includes(start.v) && (sub || sup) && tk[p] && !(tk[p].t === 'ch' && '(}'.includes(tk[p].v))) out.push('<mspace width="0.17em"/>');
    }
    if (inGroup) throw new Error('tex: missing } in: ' + src);
    return out;
  }
  const body = seq(false).join('');
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><semantics><mrow>${body}</mrow><annotation encoding="application/x-tex">${esc(src)}</annotation></semantics></math>`;
}
