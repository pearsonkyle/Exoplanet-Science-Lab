# Independent reference for test/horizon.test.mjs: where a peak of known position and height appears from a
# viewpoint, from WGS84 geodesy (astropy EarthLocation -> geocentric vectors -> local east-north-up), not from the
# spherical ray march of src/core/horizon.js and not from the elevation tiles.
#   ../../../.venv-sky/bin/python make_reference.py      (writes reference.json next to this file)
# Refraction: a ray of curvature k / R is lifted at the eye by k d / (2 R); k = 0.13 as in horizon.js.
# Heights are above sea level; using them as ellipsoidal heights at both ends shifts both by the same geoid
# undulation to within a few metres over these distances.
import json, os
import numpy as np
from astropy.coordinates import EarthLocation
import astropy.units as u
here = os.path.dirname(os.path.abspath(__file__))
K, R, EYE = 0.13, 6371008.8, 2.0
out = {'k': K, 'eye': EYE, 'sites': {}}
for s in json.load(open(os.path.join(here, 'sites.json')))['sites']:
    p = s['peak']
    a = EarthLocation.from_geodetic(s['lon'] * u.deg, s['lat'] * u.deg, (s['height'] + EYE) * u.m)
    b = EarthLocation.from_geodetic(p['lon'] * u.deg, p['lat'] * u.deg, p['height'] * u.m)
    d = np.array([(b.x - a.x).to_value(u.m), (b.y - a.y).to_value(u.m), (b.z - a.z).to_value(u.m)])
    la, lo = np.radians(s['lat']), np.radians(s['lon'])
    e = np.array([-np.sin(lo), np.cos(lo), 0.0]); n = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)]); up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    E, N, U = d @ e, d @ n, d @ up
    ground = float(np.hypot(E, N))
    geometric = float(np.degrees(np.arctan2(U, ground)))
    out['sites'][s['id']] = {'bearing': float(np.degrees(np.arctan2(E, N)) % 360), 'distance': ground, 'geometric': geometric,
                             'apparent': geometric + float(np.degrees(K * ground / (2 * R)))}
    print(s['id'], out['sites'][s['id']])
json.dump(out, open(os.path.join(here, 'reference.json'), 'w'), indent=1)
