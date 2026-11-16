// A guided walk through a page: one element is lit at a time with a short card beside it.
// startTour(steps, opts) -> { stop() }
//   step: { target: css selector | () => Element | null, title, text (html), before?: () => void | Promise, place?: 'auto'|'top'|'bottom'|'left'|'right' }
//   opts: { onEnd(finished: bool), label: string shown as "label · 3 of 12" }
// Keyboard: → or Enter next, ← back, Esc leaves. The page stays usable inside the lit element.

export function startTour(steps, opts = {}) {
  let i = 0, alive = true;
  const veil = document.createElement('div'); veil.className = 'tour-veil';
  const ring = document.createElement('div'); ring.className = 'tour-ring';
  const card = document.createElement('div'); card.className = 'tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
  document.body.append(veil, ring, card);
  const el = (s) => (typeof s.target === 'function' ? s.target() : s.target ? document.querySelector(s.target) : null);

  function place() {
    if (!alive) return;
    const s = steps[i], t = el(s), vw = window.innerWidth, vh = window.innerHeight;
    const r = t ? t.getBoundingClientRect() : null, has = r && r.width > 0 && r.height > 0;
    if (has) {
      const pad = 6, x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad), w = Math.min(vw - 8, r.width + 2 * pad), hgt = Math.min(vh - 8, r.height + 2 * pad);
      Object.assign(ring.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px' });
    } else ring.style.display = 'none';
    // the card goes where there is most room next to the lit element, and stays on screen
    const cw = Math.min(360, vw - 24); card.style.width = cw + 'px';
    const ch = card.offsetHeight || 180; let cx = (vw - cw) / 2, cy = (vh - ch) / 2;
    if (has) {
      const room = { bottom: vh - r.bottom, top: r.top, right: vw - r.right, left: r.left };
      const side = s.place && s.place !== 'auto' ? s.place : Object.entries(room).filter(([k, v]) => (k === 'left' || k === 'right' ? v > cw + 30 : v > ch + 30)).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || 'inside';
      if (side === 'bottom') { cy = r.bottom + 14; cx = r.left + r.width / 2 - cw / 2; }
      else if (side === 'top') { cy = r.top - ch - 14; cx = r.left + r.width / 2 - cw / 2; }
      else if (side === 'right') { cx = r.right + 14; cy = r.top + r.height / 2 - ch / 2; }
      else if (side === 'left') { cx = r.left - cw - 14; cy = r.top + r.height / 2 - ch / 2; }
      else { cx = r.left + r.width / 2 - cw / 2; cy = r.top + Math.min(r.height - ch - 16, Math.max(16, r.height * 0.12)); }   // a large element: sit inside it, near the top
    }
    card.style.left = Math.min(vw - cw - 12, Math.max(12, cx)) + 'px';
    card.style.top = Math.min(vh - ch - 12, Math.max(12, cy)) + 'px';
  }
  async function show(k) {
    i = Math.min(steps.length - 1, Math.max(0, k));
    const s = steps[i];
    if (s.before) { try { await s.before(); } catch { /* a step's preparation is best effort */ } }
    if (!alive) return;
    const t = el(s); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    card.innerHTML = `<div class="tour-step">${opts.label ? opts.label + ' · ' : ''}${i + 1} of ${steps.length}</div><h4>${s.title}</h4><div class="tour-text">${s.text}</div>
      <div class="tour-btns"><button class="chip small" data-a="skip">${i === steps.length - 1 ? 'Close' : 'Skip the tour'}</button><span></span>
      ${i > 0 ? '<button class="chip small" data-a="back">Back</button>' : ''}${i < steps.length - 1 ? '<button class="chip small tour-next" data-a="next">Next →</button>' : '<button class="chip small tour-next" data-a="done">Done</button>'}</div>`;
    card.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => ({ skip: () => stop(i === steps.length - 1), back: () => show(i - 1), next: () => show(i + 1), done: () => stop(true) })[b.dataset.a]()));
    requestAnimationFrame(() => { place(); setTimeout(place, 250); });   // again once panels have finished resizing
    const nx = card.querySelector('.tour-next'); if (nx) nx.focus({ preventScroll: true });
  }
  const onKey = (e) => { if (e.key === 'Escape') stop(false); else if (e.key === 'ArrowRight') show(i + 1); else if (e.key === 'ArrowLeft') show(i - 1); };
  const onResize = () => place();
  function stop(finished) {
    if (!alive) return; alive = false;
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
    veil.remove(); ring.remove(); card.remove();
    if (opts.onEnd) opts.onEnd(!!finished);
  }
  document.addEventListener('keydown', onKey, true); window.addEventListener('resize', onResize);
  show(0);
  return { stop: () => stop(false) };
}
