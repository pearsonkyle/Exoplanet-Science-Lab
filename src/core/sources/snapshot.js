// Reader for the compact catalogue snapshots written by tools/build_catalog_table.py and tools/build_catalog_eu.py:
//   { v, source, table, url, date, nrows, columns: [[name, kind], ...], refs: [[label, url], ...], strs: [...], rows: [[cell, ...], ...] }
//   kind 'q' quantity: cell = value | [value, err1, err2, ref index, lim]   (err1 upper, err2 lower and negative, as the archive has them)
//   kind 's' string:   cell = index into strs       kind 'n': a number or string as is.      Missing cells are null or absent.

/** Wrap a snapshot. Returns { meta, rows, has(name), n(row, name), s(row, name), q(row, name) -> { v, lo, hi, ref, refUrl, lim } | null }. */
export function readSnapshot(snap) {
  if (!snap || snap.v !== 1 || !Array.isArray(snap.columns) || !Array.isArray(snap.rows)) throw new Error('catalogue snapshot: unknown format');
  const at = new Map(snap.columns.map(([name], i) => [name, i]));
  const { rows, columns, refs, strs, ...meta } = snap;
  const cell = (row, name) => { const i = at.get(name); return i === undefined ? null : row[i] ?? null; };
  return {
    meta, rows, has: (name) => at.has(name),
    n: cell,
    s: (row, name) => { const c = cell(row, name); return c == null ? null : strs[c] ?? null; },
    q: (row, name) => {
      const c = cell(row, name);
      if (c == null) return null;
      if (typeof c === 'number') return { v: c, lo: null, hi: null, ref: '', refUrl: '', lim: 0 };
      const [v, e1, e2, r, lim] = c, rf = r != null && refs[r] ? refs[r] : null;
      return { v, hi: e1 != null ? Math.abs(e1) : null, lo: e2 != null ? Math.abs(e2) : null, ref: rf ? rf[0] : '', refUrl: rf ? rf[1] : '', lim: lim || 0 };
    },
  };
}

/**
 * Copy quantities from a snapshot row into a record. map: { field: [column, scale = 1] }. Values flagged as limits
 * by the catalogue are stored in rec.lim (not in rec.v): an upper limit is not a measurement.
 */
export function mapQuantities(rec, snap, row, map) {
  for (const [field, [column, scale = 1]] of Object.entries(map)) {
    const q = snap.q(row, column);
    if (!q || !Number.isFinite(q.v)) continue;
    if (q.lim) { rec.lim[field] = { value: q.v * scale, sign: q.lim }; continue; }
    rec.v[field] = q.v * scale;
    if (q.lo != null || q.hi != null) rec.e[field] = [(q.lo ?? q.hi) * Math.abs(scale), (q.hi ?? q.lo) * Math.abs(scale)];
    if (q.ref) { rec.ref[field] = q.ref; if (q.refUrl) rec.refUrl[field] = q.refUrl; }
  }
  return rec;
}

/** An empty record: what every plug-in returns one of per catalogue row. */
export const newRecord = (src, name, host) => ({ src, id: src + ':' + name, name, host: host || '', aliases: [], hostAliases: [], v: {}, e: {}, ref: {}, refUrl: {}, lim: {}, info: {} });
