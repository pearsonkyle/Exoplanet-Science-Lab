// The observatories the planner offers. The list itself is data: public/observatories/sites.json, built by
// tools/build_observatories.py from the astropy site registry and the Minor Planet Center's observatory codes
// (nothing typed from memory); public/observatories/resources.json holds the archive, all-sky camera and weather
// links that tools/crawl_observatories.py found working; land-110m.json the coastlines of the globe.

/** The site shown before the user has chosen one: Kitt Peak, as in sites.json (id 'kpno'). Used when the list cannot be loaded. */
export const FALLBACK_SITE = { id: 'kpno', name: 'Kitt Peak National Observatory, Arizona', lat: 31.96333, lon: -111.6, elev: 2120, tz: 'America/Phoenix', kind: 'pro', src: 'astropy' };
export const KIND_LABEL = { pro: 'professional observatory', net: 'network node', remote: 'remote hosting site' };

/**
 * Load the three files. fetchJson(path under public/) -> parsed JSON. A file that fails to load leaves its part
 * empty: the page still works with typed coordinates.
 * Returns { sites: [...], byId: Map, meta: sites.json without the list, resources: resources.json or null, land: rings }.
 */
export async function loadObservatories(fetchJson) {
  const get = (f) => fetchJson(f).catch(() => null);
  const [s, r, l] = await Promise.all([get('observatories/sites.json'), get('observatories/resources.json'), get('observatories/land-110m.json')]);
  const sites = s && Array.isArray(s.sites) ? s.sites : [FALLBACK_SITE];
  const { sites: _drop, ...meta } = s || {};
  return { sites, byId: new Map(sites.map((x) => [x.id, x])), meta, resources: r && r.sites ? r : null, land: l && l.rings ? l.rings : [], failed: !s };
}

/** Sites grouped for a menu: [[group label, [site, ...]], ...] by longitude band, west to east from Hawaii. */
export function groupSites(sites) {
  const bands = [['Hawaii and North America', (s) => s.lon < -30 && s.lat > 13], ['South America', (s) => s.lon < -30 && s.lat <= 13], ['Europe, Africa, Middle East', (s) => s.lon >= -30 && s.lon < 60], ['Asia and Oceania', (s) => s.lon >= 60]];
  return bands.map(([label, test]) => [label, sites.filter(test)]).filter(([, list]) => list.length);
}
