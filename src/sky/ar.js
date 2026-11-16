// AR mode: the view follows the orientation of the phone (DeviceOrientation events). No DOM beyond the events.
//
// W3C convention: with alpha, beta, gamma the rotation R = Rz(alpha) Rx(beta) Ry(gamma) takes device axes (x to the
// right of the screen, y to its top, z out of the screen) to earth axes (x east, y north, z up). The camera looks
// out of the back of the phone, along -z of the device.
// Heading: Android gives an absolute alpha through `deviceorientationabsolute`; iOS gives a relative alpha and a
// separate `webkitCompassHeading`, which is used to keep an automatic azimuth offset. Compasses in phones are easily
// off by 10 to 20 degrees, so the user can add a correction by pointing at a known object (calibrate()).
const R = Math.PI / 180;

/** Device axes in earth coordinates: returns { x, y, z }, each [east, north, up]. */
export function deviceAxes(alphaDeg, betaDeg, gammaDeg) {
  const a = (alphaDeg || 0) * R, b = (betaDeg || 0) * R, g = (gammaDeg || 0) * R;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return {
    x: [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG],
    y: [-cB * sA, cA * cB, sB],
    z: [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG],
  };
}

/** View matrix rows (world -> camera; world x east, y up, z south) for a device orientation, the screen rotation
 *  in degrees (screen.orientation.angle) and an azimuth offset in radians added to every direction. */
export function viewFromOrientation(alphaDeg, betaDeg, gammaDeg, screenAngleDeg = 0, azOffset = 0) {
  const d = deviceAxes(alphaDeg, betaDeg, gammaDeg), t = screenAngleDeg * R, ct = Math.cos(t), st = Math.sin(t), co = Math.cos(azOffset), so = Math.sin(azOffset);
  const right = d.x.map((v, i) => ct * v - st * d.y[i]), up = d.x.map((v, i) => st * v + ct * d.y[i]), back = d.z;
  // rotate the azimuth by the offset (east/north plane), then [e, n, u] -> [e, u, -n]
  const world = (v) => { const e = v[0] * co + v[1] * so, n = -v[0] * so + v[1] * co; return [e, v[2], -n]; };
  return [...world(right), ...world(up), ...world(back)];
}

/** Azimuth (rad, from north through east) and altitude of the camera axis for view rows. */
export function viewCentre(rows) {
  const f = [-rows[6], -rows[7], -rows[8]];
  return { az: (Math.atan2(f[0], -f[2]) + 2 * Math.PI) % (2 * Math.PI), alt: Math.asin(Math.max(-1, Math.min(1, f[1]))) };
}

const lerpRows = (a, b, k) => {
  // blend and re-orthonormalise (right, up, back)
  const m = a.map((v, i) => v + (b[i] - v) * k), r = m.slice(0, 3), u = m.slice(3, 6);
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); }, dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const rn = norm(r), d = dot(u, rn), un = norm(u.map((x, i) => x - d * rn[i]));
  const bn = [rn[1] * un[2] - rn[2] * un[1], rn[2] * un[0] - rn[0] * un[2], rn[0] * un[1] - rn[1] * un[0]];
  return [...rn, ...un, ...bn];
};

export function createAR(onChange) {
  const st = { active: false, rows: null, autoOffset: 0, userOffset: 0, absolute: false, events: 0, last: null };
  const screenAngle = () => (screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : (typeof window.orientation === 'number' ? window.orientation : 0));
  const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
  function handle(e) {
    if (e.alpha == null && e.beta == null) return;
    // prefer the absolute stream when the browser has one
    if (e.type === 'deviceorientation' && st.absolute && !e.absolute) return;
    if (e.absolute || e.type === 'deviceorientationabsolute') st.absolute = true;
    st.events++; st.last = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    if (typeof e.webkitCompassHeading === 'number' && !(e.webkitCompassAccuracy < 0)) {
      // iOS: alpha is relative. The compass heading is that of the top of the phone lying flat, or of the back camera
      // when it is held up; make the same quantity from alpha and take the difference as the offset.
      const d = deviceAxes(e.alpha, e.beta, e.gamma), flat = Math.hypot(d.y[0], d.y[1]) > 0.5, v = flat ? d.y : d.z.map((x) => -x);
      const want = e.webkitCompassHeading * R, have = Math.atan2(v[0], v[1]), diff = wrap(want - have);
      st.autoOffset = st.events < 3 ? diff : st.autoOffset + 0.05 * wrap(diff - st.autoOffset);
    }
    const rows = viewFromOrientation(e.alpha, e.beta, e.gamma, screenAngle(), st.autoOffset + st.userOffset);
    // smooth the sensor noise; a jump of more than a quarter turn is taken as it is (blending opposite axes does not converge)
    const far = st.rows && (st.rows[0] * rows[0] + st.rows[1] * rows[1] + st.rows[2] * rows[2] < 0 || st.rows[3] * rows[3] + st.rows[4] * rows[4] + st.rows[5] * rows[5] < 0);
    st.rows = st.rows && !far ? lerpRows(st.rows, rows, 0.35) : rows;
    onChange && onChange(st.rows);
  }
  return {
    state: st,
    get supported() { return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window; },
    /** Ask for permission where the browser wants it (iOS 13+; must be called from a tap) and start listening. */
    async start() {
      if (!this.supported) throw new Error('This browser has no orientation sensors.');
      const D = window.DeviceOrientationEvent;
      if (typeof D.requestPermission === 'function') { const r = await D.requestPermission(); if (r !== 'granted') throw new Error('Motion and orientation access was not granted.'); }
      st.active = true; st.rows = null; st.events = 0; st.absolute = false;
      window.addEventListener('deviceorientationabsolute', handle, true); window.addEventListener('deviceorientation', handle, true);
    },
    stop() { st.active = false; window.removeEventListener('deviceorientationabsolute', handle, true); window.removeEventListener('deviceorientation', handle, true); },
    /** The camera axis is on an object whose true azimuth is `az` (rad): absorb the difference into the offset. */
    calibrate(az) {
      if (!st.rows) return false;
      st.userOffset = wrap(st.userOffset + az - viewCentre(st.rows).az);
      if (st.last) st.rows = viewFromOrientation(st.last.alpha, st.last.beta, st.last.gamma, screenAngle(), st.autoOffset + st.userOffset);
      onChange && onChange(st.rows); return true;
    },
    resetCalibration() { st.userOffset = 0; },
  };
}
