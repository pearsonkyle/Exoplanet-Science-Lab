// The offline copy: registers the service worker that tools/sw/build.mjs writes into the built site (dist/sw.js),
// asks it to save the rest of the site in the background once the page is idle, and offers a reload when a new
// version has been saved. Built site only: the Vite dev server has no sw.js (import.meta.env.PROD is false there).
//
// ?nosw on any page removes the worker and its caches (for development and for comparing with the network).

import { notify } from './net.js';

const isLocal = (h) => ['localhost', '127.0.0.1', '[::1]'].includes(h) || h.endsWith('.localhost');

/** The worker's view of the saved copy: { version, have, total, bytes } or null. */
export function offlineStatus() {
  const c = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!c) return Promise.resolve(null);
  return new Promise((res) => {
    const ch = new MessageChannel(), t = setTimeout(() => res(null), 3000);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data); };
    c.postMessage({ type: 'status' }, [ch.port2]);
  });
}

export function registerOffline(root) {
  const env = import.meta.env || {};
  if (!env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || window.__eslSW) return;
  window.__eslSW = true;
  if (new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.startsWith('esl-')).forEach((k) => caches.delete(k))).catch(() => {});
    return;
  }
  if (location.protocol !== 'https:' && !isLocal(location.hostname)) return;   // workers need a secure origin
  let asked = false;
  const offerReload = (reg) => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    notify('A new version of the site has been saved.', { sticky: true, action: { label: 'Reload', run: () => { asked = true; reg.waiting && reg.waiting.postMessage({ type: 'skip-waiting' }); } } });
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) location.reload(); });
  navigator.serviceWorker.register(new URL('sw.js', root).href, { scope: root.href }).then((reg) => {
    offerReload(reg);
    reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offerReload(reg); }); });
    // the rest of the site (catalogue snapshots, examples, docs: about 60 MB), unless the visitor asked to save data
    const conn = navigator.connection;
    if (conn && conn.saveData) return;
    const warm = () => navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage({ type: 'warm' }));
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1));
    const later = () => setTimeout(() => idle(warm, { timeout: 10000 }), 4000);
    if (document.readyState === 'complete') later(); else window.addEventListener('load', later, { once: true });
  }).catch((err) => console.warn('offline copy unavailable:', err && err.message));
}
