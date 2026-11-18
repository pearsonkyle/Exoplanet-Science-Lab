"""Reference for test/fitsheader.test.mjs: frames written by our FITS writer (test/fitsheader_sample.mjs) opened
with astropy, which checks the files and recomputes every derived number on its own.

    .venv-phot/bin/python test/make_fitsheader_reference.py

For each frame: astropy's fits.verify('exception') result, the cards as astropy reads them (long strings joined),
the pixel values' first entries, the MJD / JD of DATE-OBS / DATE-AVG, BJD_TDB at mid-exposure (builtin
ephemeris, geocentre), local apparent sidereal time, the geometric altitude / azimuth and sec z (AltAz with
pressure 0, i.e. no refraction), the Moon's separation, and pixel -> sky of the WCS with astropy.wcs.
UT1 = UTC and no IERS download, as in the code under test. Writes test/fitsheader_reference.json.
"""
import json
import subprocess
import tempfile
from pathlib import Path

import astropy
import numpy as np
from astropy import units as u
from astropy.coordinates import AltAz, EarthLocation, SkyCoord, get_body
from astropy.io import fits
from astropy.time import Time
from astropy.utils import iers
from astropy.wcs import WCS

iers.conf.auto_download = False
iers.conf.auto_max_age = None
HERE = Path(__file__).parent

with tempfile.TemporaryDirectory() as d:
    subprocess.run(["node", str(HERE / "fitsheader_sample.mjs"), d], check=True)
    inputs = json.loads((Path(d) / "inputs.json").read_text())
    out = []
    for i, case in enumerate(inputs):
        p = Path(d) / f"frame_{i}.fits"
        with fits.open(p) as hdul:
            try:
                hdul.verify("exception"); verify = "ok"
            except Exception as e:  # noqa: BLE001
                verify = str(e)
            h = hdul[0].header
            data = hdul[0].data
            cards = {k: h[k] for k in h.keys() if k not in ("COMMENT", "HISTORY", "")}
            row = {"name": case["name"], "verify": verify, "cards": {k: (v if isinstance(v, (int, float, str, bool)) else str(v)) for k, v in cards.items()},
                   "history": [str(x) for x in h.get("HISTORY", [])], "comment": [str(x) for x in h.get("COMMENT", [])],
                   "dtype": str(data.dtype), "shape": list(data.shape), "first": [float(x) for x in data.ravel()[:6]], "nbytes": p.stat().st_size}
        s = case["site"]
        loc = EarthLocation.from_geodetic(s["lon"] * u.deg, s["lat"] * u.deg, s["elev"] * u.m)
        t0 = Time(h["DATE-OBS"], scale="utc", location=loc); t0.delta_ut1_utc = 0.0
        tm = Time(h["DATE-AVG"], scale="utc", location=loc); tm.delta_ut1_utc = 0.0
        row["mjd_obs"] = float(t0.mjd); row["mjd_avg"] = float(tm.mjd); row["jd_avg"] = float(tm.jd)
        row["lst_hours"] = float(tm.sidereal_time("apparent").hour)
        tgt = case.get("target")
        if tgt:
            c = SkyCoord(tgt["ra"] * u.deg, tgt["dec"] * u.deg)
            tg = Time(h["DATE-AVG"], scale="utc", location=EarthLocation.from_geocentric(0, 0, 0, unit=u.m))
            b = tg.tdb + tg.light_travel_time(c, "barycentric", ephemeris="builtin")
            row["bjd_tdb"] = float(b.jd1 + b.jd2)
            aa = c.transform_to(AltAz(obstime=tm, location=loc, pressure=0 * u.hPa))
            row["alt"] = float(aa.alt.deg); row["az"] = float(aa.az.deg); row["secz"] = float(1 / np.sin(aa.alt.rad))
            moon = get_body("moon", tm, loc).transform_to(AltAz(obstime=tm, location=loc, pressure=0 * u.hPa))
            row["moonsep"] = float(aa.separation(moon).deg)
            row["ha_hours"] = float(((tm.sidereal_time("apparent").hour - tgt["ra"] / 15 + 12) % 24) - 12)
        if "CTYPE1" in h:
            w = WCS(h)
            px = [[0, 0], [h["NAXIS1"] - 1, 0], [0, h["NAXIS2"] - 1], [h["NAXIS1"] / 2, h["NAXIS2"] / 3]]
            row["wcs"] = [{"x": x, "y": y, "sky": [float(v) for v in w.pixel_to_world_values(x, y)]} for x, y in px]
            row["wcs_scale_arcsec"] = [float(v) * 3600 for v in np.sqrt((w.pixel_scale_matrix ** 2).sum(axis=0))]
        out.append(row)

ref = {"made_by": "test/make_fitsheader_reference.py", "astropy": astropy.__version__, "numpy": np.__version__, "ut1": "UT1 = UTC", "frames": out}
(HERE / "fitsheader_reference.json").write_text(json.dumps(ref, indent=1))
print(f"wrote {len(out)} frames; verify: {[r['verify'] for r in out]}")
