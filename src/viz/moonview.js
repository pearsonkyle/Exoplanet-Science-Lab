// Where a planet's moon is drawn in the system view (scene.js and fallback2d.js). No three.js and no DOM, so the
// placement can be checked in Node (test/scene.test.mjs). The geometry is the model's: core/exomoon.js.

import { moonPosition, planetPosition, moonOrbitPath } from '../core/exomoon.js';

const N_RING = 128;

/**
 * Prepare a moon for drawing. el: orbitElements() of its planet; moon: the moon's parameters as moonParamsFrom()
 * gives them ({ rmoon, permoon, phmoon, mmoon, imoon, mplanet, mstar, ... }) with the planet's rprs added.
 * Returns { params, ring: Float32Array(3 * 128) (the moon's orbit as offsets from the planet, stellar radii), sep }
 * or null when the planet has no moon or its orbit is not defined (no masses and no separation).
 */
export function moonForView(el, moon) {
  if (!el || !moon || !(moon.rmoon >= 0) || !(moon.permoon > 0)) return null;
  let ring;
  try { ring = moonOrbitPath(el, moon, el.tmid, N_RING, { center: 'none' }); } catch { return null; }
  const a = planetPosition(el, moon, el.tmid), b = moonPosition(el, moon, el.tmid), sep = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);   // in doubles: the ring is single precision
  if (!(sep > 0) || !Number.isFinite(sep) || !Number.isFinite(ring[0])) return null;
  return { params: moon, ring, sep };
}

/**
 * Positions at time t of a planet and its moon as drawn. k is how much the planet is enlarged on screen (drawn
 * radius / true radius; 1 at true scale): the moon's radius and its distance from the planet grow by the same
 * factor, so the pair stays to scale with itself. At k = 1 these are exactly the positions the light-curve model
 * uses. Writes out.planet, out.moon ([X, Y, Z], stellar radii) and out.rMoon; returns out.
 */
export function moonPlacement(el, mv, t, k = 1, out = { planet: [0, 0, 0], moon: [0, 0, 0], rMoon: 0 }) {
  planetPosition(el, mv.params, t, out.planet); moonPosition(el, mv.params, t, out.moon);
  for (let i = 0; i < 3; i++) out.moon[i] = out.planet[i] + k * (out.moon[i] - out.planet[i]);
  out.rMoon = k * mv.params.rmoon;
  return out;
}
