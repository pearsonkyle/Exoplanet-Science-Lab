// What every figure of the site has in common, on screen and saved (docs/guide/style.md, "Figures").
// No DOM here: the render functions call these on whatever 2D context they are given.

/**
 * An axis label as the style guide writes it: "Quantity (unit)", sentence case, the unit in round brackets and in its
 * usual symbol. "wavelength (micron)" -> "Wavelength (µm)", "residual [%]" -> "Residual (%)". Labels that start with a
 * symbol or a known lower-case token (log10, x, λ, χ²) keep their first letter.
 */
export function axisLabel(s) {
  if (!s) return s;
  let t = String(s).replace(/\bmicrons?\b/g, 'µm').replace(/\[([^\]]+)\]\s*$/, '($1)');
  if (/^(log|ln|px\b|ppm\b|e\b|x\b|y\b|[a-z]\s?[=/(])/.test(t)) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "10" with a raised exponent, right-aligned at (x, y): superscript characters of a monospace font come out spaced apart. */
export function drawPow10(ctx, e, x, y) {
  const font = ctx.font, m = /(\d+(?:\.\d+)?)px/.exec(font), px = m ? Number(m[1]) : 11;
  const small = font.replace(/(\d+(?:\.\d+)?)px/, `${(px * 0.78).toFixed(1)}px`), exp = String(e).replace('-', '−');
  ctx.save(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.font = small; const w = ctx.measureText(exp).width; ctx.fillText(exp, x, y - px * 0.36);
  ctx.font = font; ctx.fillText('10', x - w - 1, y); ctx.restore();
}

/** Saved figures: drawn at this many device pixels per CSS pixel (a 900 px wide figure is 1800 px: 6 in at 300 dpi). */
export const EXPORT_SCALE = 2;
