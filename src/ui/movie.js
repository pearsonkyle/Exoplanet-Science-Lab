// Record the system view and the light curve together as a video.
// A composite canvas is redrawn every frame and captured with MediaRecorder.

const TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function movieSupport() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  return type ? { type, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' } : null;
}

/** Frame sizes: landscape for video sites and slides, portrait for phone feeds (stories, reels, shorts), square for posts. */
export const MOVIE_FORMATS = {
  landscape: { label: 'Landscape 16:9', W: 1280, H: 720, top: 440, font: 1 },
  portrait: { label: 'Portrait 9:16', W: 1080, H: 1920, top: 1180, font: 1.7 },
  square: { label: 'Square 1:1', W: 1080, H: 1080, top: 640, font: 1.35 },
};

/**
 * o: { stage: () => HTMLCanvasElement, drawLC(ctx, w, h, t, fontScale), setTime(t), t0, t1, seconds, title, subtitle(t), onProgress(frac),
 *      format: key of MOVIE_FORMATS (default landscape) }
 * The system view fills the top of the frame (cropped at the sides when the frame is narrower than the view),
 * the light curve the bottom. Resolves with { blob, ext }.
 */
export function recordMovie(o) {
  const sup = movieSupport();
  if (!sup) return Promise.reject(new Error('this browser cannot record video from a canvas'));
  const F = MOVIE_FORMATS[o.format] || MOVIE_FORMATS.landscape, W = F.W, H = F.H, hTop = F.top, fps = 30, k = F.font;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const lc = document.createElement('canvas'); lc.width = W; lc.height = H - hTop;
  const lctx = lc.getContext('2d');
  const stream = cv.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: sup.type, videoBitsPerSecond: 6e6 * (W * H) / (1280 * 720) });
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
      o.drawLC(lctx, W, H - hTop, t, k);
      ctx.drawImage(lc, 0, hTop);
      ctx.fillStyle = '#ffffff'; ctx.font = `600 ${Math.round(22 * k)}px system-ui, sans-serif`; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
      ctx.fillText(o.title, 24 * k, 18 * k);
      ctx.font = `${Math.round(15 * k)}px ui-monospace, Menlo, monospace`; ctx.fillStyle = '#cfe6ff'; ctx.fillText(o.subtitle(t), 24 * k, 48 * k); ctx.shadowBlur = 0;
      o.setTime(t);
      if (o.onProgress) o.onProgress(frac);
      if (frac >= 1) { stopped = true; setTimeout(() => rec.stop(), 150); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
