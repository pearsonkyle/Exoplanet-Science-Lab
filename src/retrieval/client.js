// A retrieval worker and the files it needs, for a page: the tables are fetched (from the browser's cache when the
// page has them already) and handed over, a fit reports its progress, and stop() ends the worker so that the fit
// stops at once. Used by the Retrieval page and by the Atmosphere page's fit.
import { siteRoot } from '../site/nav.js';
import { siteJson, fetchOr } from '../site/net.js';
import { retrievalNeeds } from '../core/atmoapi.js';

/**
 * createRetrievalClient({ onStatus(text) }) ->
 *   { ensure(model, free, species): loads what the model needs; simulate(model, spec, species) -> data set;
 *     run({ model, data, free, priors, sampler, merge, layers, band, species }, onProgress) -> { result, post, band, curve };
 *     stop(): ends a running fit (its promise rejects with an error whose `stopped` is true); busy(): bool }
 */
export function createRetrievalClient({ onStatus = () => {} } = {}) {
  let worker = null, index = null, loaded = new Set(), chem = false, extras = false, seq = 0, job = null, waiters = [];
  const root = () => new URL('opacity/', siteRoot());
  const start = () => {
    worker = new Worker(new URL('./retrieval.worker.js', import.meta.url), { type: 'module' }); loaded = new Set(); chem = false; extras = false;
    worker.onerror = (e) => { const j = job; job = null; if (j) j.fail(new Error(e.message || 'the retrieval worker failed')); };
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'loaded') { loaded = new Set(m.species); chem = m.chem; const w = waiters; waiters = []; for (const f of w) f(); return; }
      if (m.type === 'failed' && m.id == null) { const w = waiters; waiters = []; for (const f of w) f(new Error(m.message)); return; }
      if (!job || m.id !== job.id) return;
      if (m.type === 'progress') { job.progress(m); return; }
      const j = job; job = null;
      if (m.type === 'failed') j.fail(new Error(m.message)); else j.done(m);
    };
  };
  const told = () => new Promise((res, rej) => waiters.push((err) => (err ? rej(err) : res())));
  async function ensure(model, free = [], species = null) {
    if (!worker) start();
    index ??= await siteJson(new URL('index.json', root()), 'The opacity tables (opacity/index.json)');
    const need = retrievalNeeds({ model, free, species: species || (model.chemistry ? undefined : Object.keys(model.vmr || {})) }), names = [...need.lines, ...need.cia], want = index.tables.filter((t) => names.includes(t.species) && !loaded.has(t.species));
    const unknown = need.lines.filter((s) => !index.tables.some((t) => t.species === s)); if (unknown.length) throw new Error('there is no opacity table of ' + unknown.join(', '));
    if (want.length) {
      onStatus(`Loading the opacity ${want.length > 1 ? 'tables' : 'table'} of ${want.map((t) => t.species).join(', ')} …`);
      const buffers = await Promise.all(want.map((t) => fetchOr(String(new URL(t.file, root())), { what: `The opacity table of ${t.species}`, as: 'arrayBuffer', timeout: 120000 })));
      const w = told(); worker.postMessage({ type: 'tables', buffers }, buffers); await w;
    }
    if ((need.chem || free.some((k) => ['mh', 'co', 'logQuench'].includes(k))) && !chem) {
      onStatus('Loading the equilibrium chemistry table …');
      const buf = await fetchOr(String(new URL('chem/equilibrium.eslc', siteRoot())), { what: 'The equilibrium chemistry table', as: 'arrayBuffer', timeout: 120000 });
      const w = told(); worker.postMessage({ type: 'chem', buffer: buf }, [buf]); await w;
    }
    if (!extras) {
      extras = true;   // optional: without them the star is a blackbody and the JavaScript loop runs
      const [star, wasm] = await Promise.all([['stellar/phoenix.esls', 'The stellar spectra'], ['wasm/mix.wasm', 'The fast mixing kernel']].map(([f, what]) => fetchOr(String(new URL(f, siteRoot())), { what, as: 'arrayBuffer', timeout: 60000, fallback: null, quiet404: true }).catch(() => null)));
      if (star instanceof ArrayBuffer) worker.postMessage({ type: 'star', buffer: star }, [star]);
      if (wasm instanceof ArrayBuffer) worker.postMessage({ type: 'kernel', buffer: wasm }, [wasm]);
    }
  }
  const send = (msg, progress = () => {}) => new Promise((done, fail) => { if (job) { fail(new Error('a fit is already running on this page')); return; } const id = ++seq; job = { id, done, fail, progress }; worker.postMessage({ ...msg, id }); });
  return {
    ensure,
    async simulate(model, spec, species = null) { await ensure(model, [], species); return (await send({ type: 'simulate', model, spec, species })).set; },
    async run(spec, onProgress) { await ensure(spec.model, spec.free, spec.species || null); return send({ type: 'retrieve', band: 60, ...spec }, onProgress); },
    stop() { if (!job) return false; const j = job; job = null; worker.terminate(); worker = null; const e = new Error('the fit was stopped'); e.stopped = true; j.fail(e); return true; },
    busy: () => !!job,
  };
}
