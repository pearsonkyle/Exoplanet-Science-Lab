/** Approximate blackbody colour (display RGB) for an effective temperature. */
export function teffToRGB(T) {
  const t = Math.min(Math.max(T, 1500), 30000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
  const c = (v) => Math.min(Math.max(v, 0), 255) / 255;
  return [c(r), c(g), c(b)];
}
