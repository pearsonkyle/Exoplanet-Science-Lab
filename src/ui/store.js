// Saved analyses, kept in this browser only (IndexedDB). Each record is an ESL session document
// (docs/FORMAT.md) with a little bookkeeping, so anything saved here can also be exported, opened
// by the Python package, or loaded on another machine. Nothing is sent anywhere.

const DB = 'exoplanet-science-lab', STORE = 'experiments', VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('this browser has no local database (IndexedDB)'));
    const rq = indexedDB.open(DB, VERSION);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error || new Error('could not open the local database'));
  });
}
const tx = async (mode, fn) => { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(STORE, mode), rq = fn(t.objectStore(STORE)); t.oncomplete = () => { db.close(); resolve(rq && rq.result); }; t.onerror = () => { db.close(); reject(t.error); }; }); };

/** One line about a session for lists: what was fitted and how it came out. */
export function describe(session) {
  const r = session.result, d = session.data || {}, parts = [];
  if (d.light_curve) parts.push(`${d.light_curve.time.length} photometric points`);
  if ((d.radial_velocity || []).length) parts.push(`${d.radial_velocity.reduce((a, x) => a + x.time.length, 0)} velocities`);
  if ((d.timing || []).length) parts.push(`${d.timing.length} mid-times`);
  const fit = r ? `${r.parameters.length} free · ln Z ${r.converged ? r.logZ.toFixed(1) + ' ± ' + r.logZerr.toFixed(1) : 'not converged'}` : `${session.fit.free.length} free · not run`;
  return `${session.planets.length} planet${session.planets.length > 1 ? 's' : ''} · ${parts.join(', ') || 'no data'} · ${fit}`;
}

/** Save a session under an id (a new id when none is given). Returns the stored record without the session body. */
export async function saveExperiment(session, { id, name } = {}) {
  const now = new Date().toISOString(), rec = { id: id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: name || session.title || session.name || 'Untitled', system: session.name, updated: now, created: now, summary: describe(session), hasResult: !!session.result, session };
  if (id) { const old = await getExperiment(id).catch(() => null); if (old) rec.created = old.created; }
  await tx('readwrite', (s) => s.put(rec));
  const { session: _, ...meta } = rec; return meta;
}
export const getExperiment = (id) => tx('readonly', (s) => s.get(id));
export const deleteExperiment = (id) => tx('readwrite', (s) => s.delete(id));
/** Every saved analysis, newest first, without the session bodies. */
export async function listExperiments() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.map(({ session, ...meta }) => meta).sort((a, b) => (a.updated < b.updated ? 1 : -1));
}
