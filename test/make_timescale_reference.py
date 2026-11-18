"""Reference values for test/timescale.test.mjs: time-scale offsets, MJD, GPS seconds, sidereal time and BJD_TDB
from astropy (ERFA), around leap seconds and across 1975-2030.

    .venv-phot/bin/python test/make_timescale_reference.py

Each instant is given as seconds since JD 2451545.0 counted in TAI, TT and TDB (astropy stretches the UTC
Julian date, its MJD and its Unix time over a leap-second day, so those are not compared on such a day). UT1 is set
equal to UTC (delta_ut1_utc = 0) because the code under test makes the same assumption; IERS
downloads are switched off so the output does not depend on the day it is made. Writes test/timescale_reference.json.
"""
import json
from pathlib import Path

import astropy
import numpy as np
from astropy import units as u
from astropy.coordinates import EarthLocation, SkyCoord
from astropy.time import Time
from astropy.utils import iers

iers.conf.auto_download = False
iers.conf.auto_max_age = None

INSTANTS = [
    "1975-06-15T12:00:00", "1980-01-06T00:00:00", "1985-06-30T23:59:59", "1985-07-01T00:00:00",
    "1999-12-31T23:59:59", "2000-01-01T12:00:00", "2008-12-31T23:59:59", "2009-01-01T00:00:00",
    "2012-06-30T23:59:59.5", "2012-07-01T00:00:00", "2016-12-31T23:59:59", "2016-12-31T23:59:60",
    "2017-01-01T00:00:00", "2021-03-20T09:37:00", "2024-02-29T18:00:00", "2026-11-18T22:00:00.250",
    "2030-07-01T03:30:00",
]
SITES = [("Kitt Peak", 31.9583, -111.5967, 2096), ("Paranal", -24.6272, -70.4042, 2635), ("Greenwich", 51.4769, 0.0, 46)]
TARGETS = [("HAT-P-32", 31.0428, 46.6878), ("WASP-12", 97.6366, 29.6723), ("south", 280.0, -70.0)]

rows = []
for s in INSTANTS:
    t = Time(s, scale="utc", format="isot")
    t.delta_ut1_utc = 0.0
    j2k = lambda tt: float(((tt.jd1 - 2451545.0) + tt.jd2) * 86400)     # seconds since JD 2451545.0 in that scale
    row = {"iso": s, "unix": None if s.endswith(":60") else float(t.unix), "mjd": float(t.mjd),
           "tai_s": j2k(t.tai), "tt_s": j2k(t.tt), "tdb_s": j2k(t.tdb),
           "gps_seconds": float(t.gps) if s >= "1980-01-06" else None,
           "lst": [], "bjd": []}
    if not s.endswith(":60"):
        for name, lat, lon, h in SITES:
            loc = EarthLocation.from_geodetic(lon * u.deg, lat * u.deg, h * u.m)
            tl = Time(s, scale="utc", location=loc); tl.delta_ut1_utc = 0.0
            row["lst"].append({"site": name, "lon": lon, "hours": float(tl.sidereal_time("apparent").hour)})
        for name, ra, dec in TARGETS:
            c = SkyCoord(ra * u.deg, dec * u.deg)
            tg = Time(s, scale="utc", location=EarthLocation.from_geocentric(0, 0, 0, unit=u.m))
            ltt = tg.light_travel_time(c, "barycentric", ephemeris="builtin")
            b = tg.tdb + ltt
            row["bjd"].append({"target": name, "ra": ra, "dec": dec, "bjd_tdb": float(b.jd1 + b.jd2)})
    rows.append(row)

out = {"made_by": "test/make_timescale_reference.py", "astropy": astropy.__version__, "numpy": np.__version__,
       "ut1": "UT1 = UTC", "ephemeris": "builtin (geocentre)", "rows": rows}
Path(__file__).with_name("timescale_reference.json").write_text(json.dumps(out, indent=1))
print(f"wrote {len(rows)} instants")
