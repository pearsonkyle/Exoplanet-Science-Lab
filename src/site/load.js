// Fetching a large JSON file with a progress report, for the catalogue snapshots (several MB each).
//
// fetchJsonProgress(url, onProgress) -> parsed JSON. onProgress({ received, total }) is called as bytes arrive:
// `received` counts decoded bytes; `total` is the file size when the server states it for an uncompressed
// response, otherwise 0 (a compressed response states the compressed size, which cannot be compared).

export async function fetchJsonProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!onProgress || !r.body || typeof r.body.getReader !== 'function') return r.json();
  const enc = r.headers.get('content-encoding'), total = !enc || enc === 'identity' ? Number(r.headers.get('content-length')) || 0 : 0;
  const reader = r.body.getReader(), chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); received += value.length;
    onProgress({ received, total });
  }
  const all = new Uint8Array(received);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(all));
}

/** "2.1 of 5.1 MB", or "2.1 MB" when the total is not known. */
export function progressText({ received, total }) {
  const mb = (b) => (b / 1048576).toFixed(1);
  return total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`;
}
