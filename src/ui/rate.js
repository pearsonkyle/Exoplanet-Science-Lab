// The animation's rate: simulated time per second of real time, on a logarithmic slider of round steps
// (30 s/s up to 100 d/s). defaultRate() picks a step from the system: slow enough to watch a transit, or an
// eclipse's ingress when the planet's own light is in the model, or the whole orbit when that is what loops.

const MIN = 1 / 1440, HOUR = 1 / 24;
/** Steps in days of simulated time per real second. */
export const RATE_STEPS = [0.5 * MIN, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 1, 2, 5, 10, 20, 50, 100];

/** "15 min/s", "3 h/s", "2 d/s" for a rate in days per second. */
export function rateLabel(r) {
  const s = r * 86400;
  if (s < 60) return `${Math.round(s)} s/s`;
  if (s < 3600) return `${Math.round(s / 60)} min/s`;
  if (s < 86400) return `${+(s / 3600).toFixed(s < 7200 ? 1 : 0)} h/s`;
  return `${+(r).toFixed(r < 10 ? 1 : 0)} d/s`;
}

/** Index of the step nearest (in log) to a rate in days per second. */
export function nearestStep(r) {
  if (!(r > 0)) return 7;
  let best = 0, bd = Infinity;
  RATE_STEPS.forEach((x, i) => { const d = Math.abs(Math.log(x / r)); if (d < bd) { bd = d; best = i; } });
  return best;
}

/**
 * Default step for a system. ev: { per, t14, t23, e14, e23 } in days (eventTimes / deriveSystem); loop: 'transit' | 'orbit';
 * eclipse: the planet's own light is in the model (watch its eclipse ingress rather than the transit).
 * Transit: about 12 s for the whole transit. Eclipse: about 5 s for the ingress. Orbit: about 20 s per orbit.
 */
export function defaultStep({ per, t14, t23, e14, e23 }, loop = 'transit', eclipse = false) {
  if (loop === 'orbit' || !(t14 > 0)) return nearestStep(per / 20);
  if (eclipse && e14 > 0) { const ing = 0.5 * (e14 - (e23 > 0 ? e23 : 0)); if (ing > 0) return nearestStep(ing / 5); }
  return nearestStep(t14 / 12);
}
