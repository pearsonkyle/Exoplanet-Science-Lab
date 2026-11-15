// Record the system view and the light curve together as a video.
// A composite canvas is redrawn every frame and captured with MediaRecorder.

const TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function movieSupport() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  return type ? { type, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' } : null;
}

/**
 * o: { stage: () => HTMLCanvasElement, drawLC(ctx, w, h), setTime(t), t0, t1, seconds, title, subtitle(t), onProgress(frac) }
 * Resolves with { blob, ext }.
 */
export function recordMovie(o) {
  const sup = movieSupport();
  if (!sup) return Promise.reject(new Error('this browser cannot record video from a canvas'));
  const W = 1280, H = 720, hTop = 440, fps = 30;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const lc = document.createElement('canvas'); lc.width = W; lc.height = H - hTop;
  const lctx = lc.getContext('2d');
  const stream = cv.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: sup.type, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  return new Promise((resolve, reject) => {
    rec.onerror = (e) => reject(new Error(e.error ? e.error.message : 'recording failed'));
    rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); resolve({ blob: new Blob(chunks, { type: sup.type.split(';')[0] }), ext: sup.ext }); };
    let start = null, stopped = false;
    const frame = (now) => {
      if (stopped) return;
      if (start === null) { start = now; rec.start(250); }
      const frac = Math.min(1, (now - start) / (o.seconds * 1000)), t = o.t0 + (o.t1 - o.t0) * frac;
      // the view rendered the previous time step during this animation frame; copy it, then ask for the next
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const st = o.stage();
      if (st && st.width && st.height) { const s = Math.max(W / st.width, hTop / st.height), w = st.width * s, h = st.height * s; ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, hTop); ctx.clip(); try { ctx.drawImage(st, (W - w) / 2, (hTop - h) / 2, w, h); } catch { /* cross-origin canvases cannot occur here */ } ctx.restore(); }
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      o.drawLC(lctx, W, H - hTop, t);
      ctx.drawImage(lc, 0, hTop);
      ctx.fillStyle = '#ffffff'; ctx.font = '600 22px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
      ctx.fillText(o.title, 24, 18);
      ctx.font = '15px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#cfe6ff'; ctx.fillText(o.subtitle(t), 24, 48); ctx.shadowBlur = 0;
      o.setTime(t);
      if (o.onProgress) o.onProgress(frac);
      if (frac >= 1) { stopped = true; setTimeout(() => rec.stop(), 150); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
