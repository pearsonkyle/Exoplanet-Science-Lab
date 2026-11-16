// Immersive mode: the sky on a celestial sphere around the viewer, driven by three.js's WebXR manager.
//
// The renderer (renderer.js) is switched to its perspective mode, in which the same scene is drawn through
// three.js's view and projection matrices, once per eye, as directions at infinity. This module adds what the flat
// view draws on its 2D canvas and a headset cannot show: names and the target's reticle, as sprites on a sphere
// that follows the head (so that they do not shift against the stars when the viewer moves).
//
// Sessions are requested the way three.js's VRButton and ARButton do (navigator.xr.requestSession, then
// renderer.xr.setSession), from our own buttons so that they can be hidden where the browser has no WebXR or not
// that kind of session. 'immersive-vr' shows the whole scene; 'immersive-ar' leaves out the sky backdrop and draws
// a translucent ground, so the camera image shows through.
//
// Orientation: the reference space is 'local' (y up, -z where the viewer faced when the session began). A headset
// has no compass, so which way is north is a choice: the session starts with the viewer facing the azimuth that
// the flat view was centred on (or, for passthrough on a phone that reports a compass heading, the heading of the
// phone at that moment). setHeading() turns the sky afterwards.
//
// NOT TESTED on any headset or phone, nor in a WebXR emulator. What is tested is the perspective rendering itself,
// on an ordinary canvas (?xrdebug=1), against the stereographic view.
import { Group, Sprite, SpriteMaterial, CanvasTexture, LinearFilter, Vector3 } from 'three';

const DIST = 30;       // metres from the head to the label sphere
const FONT = '600 44px Inter, system-ui, sans-serif';

function textSprite(text, color) {
  const c = document.createElement('canvas'), g = c.getContext('2d'); g.font = FONT;
  const w = Math.ceil(g.measureText(text).width) + 24; c.width = w; c.height = 64;
  g.font = FONT; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = 8; g.strokeStyle = 'rgba(2,4,10,0.7)'; g.strokeText(text, 12, 34); g.fillStyle = color; g.fillText(text, 12, 34);
  const tex = new CanvasTexture(c); tex.minFilter = tex.magFilter = LinearFilter; tex.generateMipmaps = false;
  const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  s.userData.aspect = w / 64; s.renderOrder = 80; s.frustumCulled = false;
  return s;
}
function ringSprite(color) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.strokeStyle = 'rgba(2,4,10,0.8)'; g.lineWidth = 16; g.beginPath(); g.arc(128, 128, 70, 0, 7); g.stroke();
  g.strokeStyle = color; g.lineWidth = 8; g.beginPath(); g.arc(128, 128, 70, 0, 7); g.stroke();
  g.lineWidth = 8; g.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(128 + dx * 84, 128 + dy * 84); g.lineTo(128 + dx * 122, 128 + dy * 122); } g.stroke();
  const tex = new CanvasTexture(c); tex.minFilter = tex.magFilter = LinearFilter; tex.generateMipmaps = false;
  const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  s.userData.aspect = 1; s.renderOrder = 79; s.frustumCulled = false;
  return s;
}

export function createXR(R, { overlayRoot, onStart, onEnd, onSelect } = {}) {
  const renderer = R.renderer, group = new Group(), sprites = new Map(), tmp = new Vector3();
  group.visible = false; R.scene.add(group);
  const st = { session: null, kind: '', heading: 0 };

  const api = {
    state: st, group,
    get presenting() { return !!st.session; },
    /** Which immersive sessions this browser offers: { vr, ar }, both false without navigator.xr. */
    async supported() {
      const xr = typeof navigator !== 'undefined' && navigator.xr;
      if (!xr || !xr.isSessionSupported) return { vr: false, ar: false };
      const ask = (k) => xr.isSessionSupported(k).catch(() => false);
      const [vr, ar] = await Promise.all([ask('immersive-vr'), ask('immersive-ar')]);
      return { vr, ar };
    },
    /** Must be called from a user gesture. kind: 'vr' | 'ar'; heading: the azimuth (radians) the viewer is facing. */
    async start(kind, heading = 0) {
      if (st.session) return;
      const init = kind === 'ar' ? { optionalFeatures: ['local-floor', ...(overlayRoot ? ['dom-overlay'] : [])], ...(overlayRoot ? { domOverlay: { root: overlayRoot } } : {}) } : { optionalFeatures: ['local-floor'] };
      const session = await navigator.xr.requestSession(kind === 'ar' ? 'immersive-ar' : 'immersive-vr', init);
      st.session = session; st.kind = kind; st.heading = heading;
      renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local');
      R.setMode('perspective'); R.setHeading(heading); R.setPointScale(1.6);
      R.camera.matrix.identity(); R.camera.updateMatrixWorld(true);
      if (kind === 'ar') renderer.setClearColor(0x000000, 0);
      group.visible = true;
      session.addEventListener('end', () => {
        st.session = null; renderer.xr.enabled = false; group.visible = false; renderer.setClearColor(0x010207, 1);
        onEnd && onEnd(kind);
      });
      session.addEventListener('select', () => onSelect && onSelect());       // a controller trigger or a tap
      await renderer.xr.setSession(session);
      onStart && onStart(kind);
    },
    stop() { if (st.session) st.session.end(); },
    setHeading(h) { st.heading = h; R.setHeading(h); },
    /**
     * Show these labels: [{ key, text, dir: world direction, color, deg: height of the text in degrees, ring: bool }].
     * Sprites are made once per key and text and moved every frame. camera: the camera the scene is drawn with.
     */
    setLabels(list, camera) {
      const c = Math.cos(st.heading), s = Math.sin(st.heading), seen = new Set();
      camera.getWorldPosition(tmp); group.position.copy(tmp);
      for (const l of list) {
        const id = l.key + '|' + (l.ring ? '' : l.text); seen.add(id);
        let sp = sprites.get(id);
        if (!sp) { sp = l.ring ? ringSprite(l.color) : textSprite(l.text, l.color); sprites.set(id, sp); group.add(sp); }
        const h = DIST * Math.tan((l.deg || 1.3) * Math.PI / 180), d = l.dir;
        // the same rotation as the shaders' uView, then out to the label sphere; text sits to the right of its object
        sp.position.set((c * d[0] + s * d[2]) * DIST, d[1] * DIST, (-s * d[0] + c * d[2]) * DIST);
        sp.scale.set(h * sp.userData.aspect, h, 1);
        sp.center.set(l.ring || l.centre ? 0.5 : -0.12, 0.5);
        sp.visible = true;
      }
      for (const [id, sp] of sprites) if (!seen.has(id)) { if (sprites.size > 400) { group.remove(sp); sp.material.map.dispose(); sp.material.dispose(); sprites.delete(id); } else sp.visible = false; }
    },
  };
  return api;
}
