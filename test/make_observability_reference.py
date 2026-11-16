#!/usr/bin/env python
"""Reference values for test/observability.test.mjs from astropy, written to test/observability_reference.json.

  .venv-plan/bin/python test/make_observability_reference.py

Needs astropy, numpy, scipy. astropy does the full chain here: ICRS -> AltAz with precession, nutation, aberration,
polar motion and UT1 - UTC from the IERS tables (pressure = 0: no refraction), its built-in ephemeris for the Sun
and Moon (ERFA epv00 / moon98), and barycentric light-travel times for BJD_TDB.
"""
import json, os, warnings
import numpy as np
import astropy
import astropy.units as u
from astropy.time import Time
from astropy.coordinates import SkyCoord, EarthLocation, AltAz, get_body, get_sun, solar_system_ephemeris
from astropy.utils import iers
from scipy.optimize import brentq

warnings.simplefilter('ignore')
iers.conf.iers_degraded_accuracy = 'warn'
solar_system_ephemeris.set('builtin')
rng = np.random.default_rng(20261115)

SITES = [('Mauna Kea', 19.8207, -155.4681, 4205), ('Paranal', -24.6272, -70.4042, 2635), ('Greenwich', 51.4769, 0.0005, 46),
         ('Tromso', 69.65, 18.96, 100), ('Sutherland', -32.376, 20.8107, 1798), ('Swarthmore', 39.907, -75.356, 65)]
loc = lambda s: EarthLocation(lat=s[1] * u.deg, lon=s[2] * u.deg, height=s[3] * u.m)

out = {'made_with': {'astropy': astropy.__version__}, 'sites': [dict(name=s[0], lat=s[1], lon=s[2], elev=s[3]) for s in SITES]}

# ---- positions: random site, time (2024 to 2031), target
pts = []
for i in range(400):
    si = int(rng.integers(len(SITES))); s = SITES[si]
    jd = float(rng.uniform(2460310.5, 2462867.5))
    ra, dec = float(rng.uniform(0, 360)), float(np.degrees(np.arcsin(rng.uniform(-1, 1))))
    t = Time(jd, format='jd', scale='utc'); L = loc(s); fr = AltAz(obstime=t, location=L)
    star = SkyCoord(ra * u.deg, dec * u.deg, frame='icrs').transform_to(fr)
    sun_g, moon_g = get_body('sun', t), get_body('moon', t)                    # geocentric (GCRS)
    sun = sun_g.transform_to(fr)
    moon_t = get_body('moon', t, L); moon = moon_t.transform_to(fr)             # topocentric
    # illuminated fraction from the geocentric vectors
    psi = sun_g.separation(moon_g).rad; rs, rm = sun_g.distance.to(u.km).value, moon_g.distance.to(u.km).value
    ph = np.arctan2(rs * np.sin(psi), rm - rs * np.cos(psi))
    tete_s, tete_m = sun_g.transform_to('tete'), moon_g.transform_to('tete')   # true equator and equinox of date
    pts.append(dict(site=si, jd=jd, ra=ra, dec=dec, alt=float(star.alt.deg), az=float(star.az.deg),
                    sun_alt=float(sun.alt.deg), sun_az=float(sun.az.deg), sun_ra=float(tete_s.ra.deg), sun_dec=float(tete_s.dec.deg), sun_dist=float(sun_g.distance.to(u.au).value),
                    moon_alt=float(moon.alt.deg), moon_az=float(moon.az.deg), moon_ra=float(tete_m.ra.deg), moon_dec=float(tete_m.dec.deg), moon_dist=float(rm),
                    moon_sep=float(SkyCoord(ra * u.deg, dec * u.deg, frame='icrs').transform_to(fr).separation(moon).deg),
                    moon_illum=float((1 + np.cos(ph)) / 2),
                    lmst=float(t.sidereal_time('mean', longitude=s[2] * u.deg).deg), gast=float(t.sidereal_time('apparent', 'greenwich').deg)))
out['points'] = pts

# ---- twilight: Sun altitude crossings found by root finding on astropy's altitude
tw = []
for i in range(36):
    si = i % len(SITES); s = SITES[si]; L = loc(s)
    day = int(rng.integers(2460310, 2462867))
    noon = np.floor(day + s[2] / 360) - s[2] / 360                              # local mean noon
    f = lambda jd, a: get_sun(Time(jd, format='jd', scale='utc')).transform_to(AltAz(obstime=Time(jd, format='jd', scale='utc'), location=L)).alt.deg - a
    rec = dict(site=si, noon=float(noon))
    grid = noon + np.arange(0, 1.0001, 10 / 1440)
    tt = Time(grid, format='jd', scale='utc')
    alts = get_sun(tt).transform_to(AltAz(obstime=tt, location=L)).alt.deg
    for name, a in (('sun', -0.833), ('civil', -6), ('nautical', -12), ('astronomical', -18)):
        d = alts - a; ev = mo = None
        for k in range(len(grid) - 1):
            if d[k] >= 0 > d[k + 1] and ev is None:
                ev = brentq(f, grid[k], grid[k + 1], args=(a,), xtol=1e-7)
            if d[k] < 0 <= d[k + 1] and ev is not None and mo is None:
                mo = brentq(f, grid[k], grid[k + 1], args=(a,), xtol=1e-7)
        rec[name] = [ev, mo]
    tw.append(rec)
out['twilight'] = tw

# ---- barycentric dynamical time: BJD_TDB of an event seen at JD_UTC from the geocentre
bj = []
for i in range(120):
    jd = float(rng.uniform(2453400.5, 2462867.5))                               # 2005 to 2031: crosses several leap seconds
    ra, dec = float(rng.uniform(0, 360)), float(np.degrees(np.arcsin(rng.uniform(-1, 1))))
    t = Time(jd, format='jd', scale='utc', location=EarthLocation.from_geocentric(0, 0, 0, unit=u.m))
    ltt = t.light_travel_time(SkyCoord(ra * u.deg, dec * u.deg, frame='icrs'), 'barycentric')
    b = t.tdb + ltt
    bj.append(dict(jd=jd, ra=ra, dec=dec, bjd_minus_jd_s=float(((b.jd1 - t.jd1) + (b.jd2 - t.jd2)) * 86400), tt_minus_utc=float((t.tt.jd1 - t.utc.jd1 + t.tt.jd2 - t.utc.jd2) * 86400)))
out['bjd'] = bj

json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'observability_reference.json'), 'w'))
print('wrote observability_reference.json:', len(pts), 'positions,', len(tw), 'nights,', len(bj), 'BJD conversions; astropy', astropy.__version__)
