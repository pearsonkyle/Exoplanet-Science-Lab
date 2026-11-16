# Reference for the time-standard conversions of the light-curve reader (src/core/data.js, test/timestd.test.mjs):
# for targets and UTC dates, astropy's BJD_TDB and HJD_UTC of an event seen at the geocentre.
#   .venv-phot/bin/python test/make_timestd_reference.py   ->  test/timestd_reference.json
# BJD_TDB = JD_UTC + (TDB - UTC) + barycentric light-travel time; HJD_UTC = JD_UTC + heliocentric light-travel time.
# Offsets are stored in seconds from JD_UTC so float64 rounding of the dates (40 us near 2.46e6) does not enter.
import json, astropy
from astropy.time import Time
from astropy.coordinates import SkyCoord, EarthLocation, solar_system_ephemeris
import astropy.units as u
solar_system_ephemeris.set('builtin')
geo = EarthLocation.from_geocentric(0, 0, 0, unit=u.m)
rows = []
for (name, ra, dec) in [('HD 80606', 140.6569501, 50.6037764), ('51 Peg', 344.3675399, 20.7690958), ('WASP-18', 24.354311, -45.677887), ('ecliptic', 90.0, 23.4), ('HAT-P-32', 31.042786, 46.687869)]:
    c = SkyCoord(ra * u.deg, dec * u.deg, frame='icrs')
    for jd in [2451545.25, 2453000.7, 2455197.75, 2457754.6, 2458888.07, 2459500.33, 2460310.5, 2461000.9]:
        t = Time(jd, format='jd', scale='utc', location=geo)
        lb = t.light_travel_time(c, kind='barycentric', ephemeris='builtin').to(u.s).value
        lh = t.light_travel_time(c, kind='heliocentric', ephemeris='builtin').to(u.s).value
        tdb = ((t.tdb.jd1 - t.utc.jd1) + (t.tdb.jd2 - t.utc.jd2)) * 86400
        rows.append({'name': name, 'ra': ra, 'dec': dec, 'jd_utc': jd, 'bjd_tdb_minus_jd_utc_s': float(tdb + lb), 'hjd_utc_minus_jd_utc_s': float(lh)})
json.dump({'astropy': astropy.__version__, 'ephemeris': 'builtin', 'rows': rows}, open('test/timestd_reference.json', 'w'), indent=1)
print(len(rows), 'rows')
