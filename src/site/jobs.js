// Long computations on any page of the site (a fit that takes an hour, a companion search, a reduction of hundreds of
// frames): one place that shows their progress and keeps them alive.
//   - a pill at the bottom left of every page: progress ring, what runs, elapsed time, an estimate of the time left,
//     Stop, and "Notify me" (a desktop notification at the end, asked for only when the user clicks it)
//   - the tab's title carries the percentage, so the run can be followed from another tab
//   - leaving the page (reload, close, a link) asks first while anything runs: the browser's own dialog
//   - the screen is kept awake while a job runs, where the browser allows it, so the machine does not sleep mid-run
//   - window.__eslJobs.running() / list() for the assistant, which must not navigate away from a running job
//
//   const job = startJob({ label: 'Fit of HD 80606 b', stop: () => …, show: () => … })
//   job.update({ fraction: 0.37, detail: 'iteration 4200 · ln Z −1555' }); job.finish('Fit finished'); job.fail('…')
//
// The time left is extrapolated from the recent rate of progress (the last two minutes), not the whole run, and is
// shown only once there is something to extrapolate; it is labelled "about" because a nested-sampling fraction is itself
// an estimate.

const jobs = new Map();
let seq = 0, pill = null, baseTitle = null, wake = null, notifyWanted = false, ticker = 0, guardOn = false;

const fmt = (s) => { if (!Number.isFinite(s)) return ''; s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(x).padStart(2, '0')} s` : `${x} s`; };
const left = (s) => (!Number.isFinite(s) ? '' : s > 3 * 3600 ? 'more than 3 h left' : s < 60 ? 'under a minute left' : `about ${fmt(Math.round(s / 60) * 60).replace(/ 00 s$/, '').replace(/ 0+ min$/, '')} left`);

/** Seconds left from the recent rate: the fraction gained over the last two minutes (at least the last 20 samples). */
export function etaSeconds(hist, now = Date.now()) {
  if (hist.length < 3) return NaN;
  const last = hist[hist.length - 1], f = last.f; if (!(f > 0.02) || f >= 1) return NaN;
  const since = now - 120000; let i = hist.length - 1; while (i > 0 && (hist[i - 1].t >= since || hist.length - i < 20)) i--;
  const a = hist[i], df = last.f - a.f, dt = (last.t - a.t) / 1000;
  if (!(df > 1e-4) || !(dt > 5)) return NaN;
  return ((1 - f) / df) * dt;
}

export function startJob({ label, stop = null, show = null } = {}) {
  ensureUI();
  const id = ++seq, job = { id, label: String(label || 'Working'), stop, show, t0: Date.now(), f: 0, detail: '', hist: [], state: 'running', msg: '' };
  jobs.set(id, job); guard(true); keepAwake(true); render();
  if (!ticker) ticker = setInterval(render, 1000);
  return {
    id,
    update({ fraction, detail } = {}) {
      if (job.state !== 'running') return;
      if (Number.isFinite(fraction)) { job.f = Math.min(1, Math.max(0, fraction)); job.hist.push({ t: Date.now(), f: job.f }); if (job.hist.length > 4000) job.hist.splice(0, 2000); }
      if (detail !== undefined) job.detail = String(detail);
    },
    finish(msg = 'Finished') { end(job, 'done', msg); },
    fail(msg = 'Failed') { end(job, 'failed', msg); },
  };
}
export const running = () => [...jobs.values()].some((j) => j.state === 'running');
export const list = () => [...jobs.values()].filter((j) => j.state === 'running').map((j) => ({ label: j.label, fraction: j.f, elapsed_s: (Date.now() - j.t0) / 1000, eta_s: etaSeconds(j.hist) }));
if (typeof window !== 'undefined') window.__eslJobs = { running, list };

function end(job, state, msg) {
  if (job.state !== 'running') return;
  job.state = state; job.msg = `${msg} · ${fmt((Date.now() - job.t0) / 1000)}`; job.f = state === 'done' ? 1 : job.f;
  if (!running()) { guard(false); keepAwake(false); clearInterval(ticker); ticker = 0; }
  if (typeof document !== 'undefined' && document.hidden) document.title = `${state === 'done' ? '✓' : '✕'} ${job.label} · ${baseTitle || document.title}`;
  if (notifyWanted && typeof Notification !== 'undefined' && Notification.permission === 'granted') { try { new Notification('Exoplanet Science Lab', { body: `${job.label}: ${job.msg}` }); } catch { /* not allowed here */ } }
  render();
  setTimeout(() => { jobs.delete(job.id); render(); }, state === 'done' ? 12000 : 30000);
}

// ---- keeping the run alive ------------------------------------------------------------------------------------
function onLeave(e) { if (!running()) return; e.preventDefault(); e.returnValue = ''; return ''; }
function guard(on) { if (typeof window === 'undefined' || on === guardOn) return; guardOn = on; if (on) window.addEventListener('beforeunload', onLeave); else window.removeEventListener('beforeunload', onLeave); }
async function keepAwake(on) {
  try {
    if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!on && wake) { await wake.release(); wake = null; }
  } catch { wake = null; /* not allowed (page hidden, or no support): the run still continues */ }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (running()) keepAwake(true); if (baseTitle && !running()) document.title = baseTitle; } });

// ---- the pill -------------------------------------------------------------------------------------------------
function ensureUI() {
  if (pill || typeof document === 'undefined') return;
  baseTitle = document.title;
  pill = document.createElement('div'); pill.className = 'esl-jobs'; pill.setAttribute('role', 'status'); pill.setAttribute('aria-live', 'polite');
  document.body.append(pill);
  pill.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const j = jobs.get(Number(b.dataset.id));
    if (b.dataset.act === 'stop' && j && j.stop) { b.disabled = true; b.textContent = 'Stopping…'; j.stop(); }
    else if (b.dataset.act === 'show' && j && j.show) j.show();
    else if (b.dataset.act === 'notify') { notifyWanted = true; if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().then(render); render(); }
  });
}
const ring = (f) => { const r = 9, c = 2 * Math.PI * r; return `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="3"/><circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 12 12)" stroke-linecap="round"/></svg>`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function render() {
  if (!pill) return;
  const all = [...jobs.values()];
  pill.hidden = !all.length;
  const run = all.filter((j) => j.state === 'running');
  if (baseTitle && !document.hidden) document.title = run.length ? `[${Math.round(100 * Math.min(...run.map((j) => j.f)))}%] ${baseTitle}` : baseTitle;
  const canNotify = typeof Notification !== 'undefined' && Notification.permission !== 'denied';
  pill.innerHTML = all.map((j) => {
    const el = (Date.now() - j.t0) / 1000, eta = j.state === 'running' && el > 15 ? etaSeconds(j.hist) : NaN;
    return `<div class="ej ${j.state}">${j.state === 'running' ? ring(j.f) : `<span class="ej-mark">${j.state === 'done' ? '✓' : '✕'}</span>`}
      <div class="ej-txt"><span class="ej-head"><b>${esc(j.label)}</b><span class="ej-pc">${j.state === 'running' ? Math.round(100 * j.f) + '%' : ''}</span></span>
      <small>${j.state === 'running' ? `${fmt(el)} elapsed${Number.isFinite(eta) ? ' · ' + left(eta) : ''}${j.detail ? ' · ' + esc(j.detail) : ''}` : esc(j.msg)}</small>
      ${j.state === 'running' ? '<small class="ej-keep">Keep this tab open until it finishes.</small>' : ''}</div>
      <div class="ej-act">${j.state === 'running' && j.show ? `<button type="button" data-act="show" data-id="${j.id}">Show</button>` : ''}${j.state === 'running' && j.stop ? `<button type="button" data-act="stop" data-id="${j.id}">Stop</button>` : ''}</div></div>`;
  }).join('') + (run.length && canNotify && !notifyWanted ? '<button type="button" class="ej-notify" data-act="notify">Notify me when done</button>' : run.length && notifyWanted ? '<small class="ej-note">You will be notified when it finishes.</small>' : '');
}
