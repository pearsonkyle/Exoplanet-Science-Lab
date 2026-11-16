// The frame a planet's brightness map is drawn in on the 3D view (no three.js, so it can be tested in Node):
// substellar direction (toward the star), north (the orbit's pole) and east (north × substellar, the way a
// synchronously rotating surface turns). Longitude is measured east from the substellar point, latitude from the
// orbital plane, as in core/phasecurve.js temperatureMap and the Map view's globes (ui/phaseplot.js drawGlobe).
// The planet shader (shaders.js planetFrag, uSub / uNorth) does the same per pixel.

/** pos: planet position [X, Y, Z] (stellar radii, star at the origin); el: orbitElements. Returns { sub, north, east } unit vectors. */
export function mapFrame(pos, el) {
  const r = Math.hypot(pos[0], pos[1], pos[2]) || 1, sub = [-pos[0] / r, -pos[1] / r, -pos[2] / r], north = [0, el.sinI, el.cosI];
  const east = [north[1] * sub[2] - north[2] * sub[1], north[2] * sub[0] - north[0] * sub[2], north[0] * sub[1] - north[1] * sub[0]];
  const n = Math.hypot(...east) || 1;
  return { sub, north, east: east.map((x) => x / n) };
}

/** Longitude and latitude (degrees) of the map at the point whose outward direction is v (unit vector, world frame). */
export function mapLonLat(v, f) {
  const be = v[0] * f.east[0] + v[1] * f.east[1] + v[2] * f.east[2], bn = v[0] * f.north[0] + v[1] * f.north[1] + v[2] * f.north[2], bs = v[0] * f.sub[0] + v[1] * f.sub[1] + v[2] * f.sub[2];
  return { lon: (Math.atan2(be, bs) * 180) / Math.PI, lat: (Math.asin(Math.max(-1, Math.min(1, bn))) * 180) / Math.PI };
}
