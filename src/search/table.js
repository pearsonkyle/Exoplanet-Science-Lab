// A virtualised table: only the rows in view are in the DOM, so tens of thousands of rows scroll smoothly.
// createTable(el, { rowHeight, cell(row, key) -> html, headCell(key) -> html, width(key), onSort(key), onSelect(row) })
// returns { setData(rows, cols, keepScroll), select(row), scrollTo(row), resize() }.

export function createTable(el, opt) {
  const H = opt.rowHeight;
  el.innerHTML = '<div class="vt-head" role="row"></div><div class="vt-body" role="rowgroup"></div>';
  const head = el.firstChild, body = el.lastChild;
  let rows = [], cols = [], selected = null, first = -1, last = -1, raf = 0;

  function draw(force) {
    raf = 0;
    const top = el.scrollTop, n = rows.length, a = Math.max(0, Math.floor(top / H) - 6), b = Math.min(n, Math.ceil((top + el.clientHeight) / H) + 6);
    if (!force && a === first && b === last) return;
    first = a; last = b;
    let html = '';
    for (let i = a; i < b; i++) {
      const r = rows[i];
      html += `<div class="vt-row${r === selected ? ' sel' : ''}" role="row" data-i="${i}" style="top:${i * H}px">`;
      for (const k of cols) html += opt.cell(r, k);
      html += '</div>';
    }
    body.innerHTML = n ? html : '<div class="vt-empty">No rows pass the filters.</div>';
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => draw(false)); };
  el.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  head.addEventListener('click', (e) => { const th = e.target.closest('.vt-th'); if (th) opt.onSort(th.dataset.key); });
  body.addEventListener('click', (e) => { const r = e.target.closest('.vt-row'); if (r) opt.onSelect(rows[+r.dataset.i]); });
  el.addEventListener('keydown', (e) => {
    if (!rows.length || !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    const page = Math.max(1, Math.floor(el.clientHeight / H) - 2), i = selected ? rows.indexOf(selected) : -1;
    if (e.key === 'Enter') { if (i < 0) opt.onSelect(rows[Math.floor(el.scrollTop / H)]); return; }
    const j = Math.min(rows.length - 1, Math.max(0, i + { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key]));
    if (j !== i) { opt.onSelect(rows[j]); api.scrollTo(rows[j]); }
  });

  const api = {
    setData(r, c, keepScroll) {
      rows = r; cols = c;
      const w = cols.reduce((s, k) => s + opt.width(k), 0);
      head.innerHTML = cols.map(opt.headCell).join(''); head.style.width = w + 'px';
      body.style.width = w + 'px'; body.style.height = Math.max(rows.length * H, 60) + 'px';
      if (!keepScroll) el.scrollTop = 0;
      draw(true);
    },
    select(row) { selected = row; draw(true); },
    scrollTo(row) {
      const i = rows.indexOf(row); if (i < 0) return;
      const y = i * H, hh = head.offsetHeight;
      if (y < el.scrollTop) el.scrollTop = y; else if (y + H > el.scrollTop + el.clientHeight - hh) el.scrollTop = y + H - el.clientHeight + hh;
      draw(true);
    },
    resize: schedule,
    visibleRange: () => [first, last],
  };
  return api;
}
