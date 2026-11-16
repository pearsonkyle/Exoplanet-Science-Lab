// A tap equivalent of the title tooltip, on every page.
//
// With a mouse the browser shows `title` on hover; a finger never hovers. After a touch or pen tap on an element
// that has a title and is not itself a control, the text is shown in a small box beside it until the next tap,
// a scroll or Escape. A field inside a <label title> shows the label's note while it has the focus.
// Elements that do something when tapped (links, buttons, rows that open a detail) are left alone: what they
// open carries the same information.

const ACTIVE = 'a[href], button, select, input, textarea, summary, [role=button], [role=tab], [role=row], [role=columnheader], [data-i]';
let tip = null, lastPointer = 'mouse';

function hide() { if (tip) { tip.remove(); tip = null; } }
function show(el, text) {
  hide();
  tip = document.createElement('div'); tip.className = 'esl-tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = text;
  document.body.append(tip);
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const x = Math.max(8, Math.min(vw - t.width - 8, r.left + r.width / 2 - t.width / 2));
  const y = r.top - t.height - 8 >= 8 ? r.top - t.height - 8 : Math.min(vh - t.height - 8, r.bottom + 8);
  tip.style.left = x + 'px'; tip.style.top = Math.max(8, y) + 'px';
}

export function mountTips() {
  // every page: the plain pages, and the analyzer and the sky view, whose read-outs (derived quantities, the legend)
  // also explain themselves in a title
  if (typeof document === 'undefined' || !document.body || document.body.dataset.tips) return;
  document.body.dataset.tips = '1';
  document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; hide(); }, true);
  document.addEventListener('click', (e) => {
    if (lastPointer === 'mouse' || !(e.target instanceof Element)) return;
    const el = e.target.closest('[title]');
    if (!el || !el.title) return;
    const act = e.target.closest(ACTIVE);
    if (act && (el === act || el.contains(act) || act.contains(el))) return;
    if (el.closest('label') && el.closest('label').querySelector('input, select, textarea')) return;      // the focus handler below covers it
    show(el, el.title);
  });
  document.addEventListener('focusin', (e) => {
    if (lastPointer === 'mouse' || !(e.target instanceof Element) || !e.target.matches('input, select, textarea')) return;
    const lab = e.target.closest('label[title]');
    if (lab && lab.title) show(lab, lab.title);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
}
