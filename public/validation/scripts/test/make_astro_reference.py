# Reference values for test/astro.test.mjs, from astropy (ERFA) and the JPL DE432s ephemeris.
#
#   python3 -m venv .venv-sky && .venv-sky/bin/pip install astropy jplephem
#   .venv-sky/bin/python test/make_astro_reference.py          # writes test/astro_reference.json
#
# What is written, per random instant between 1975 and 2050 (fixed seed) plus a few fixed ones:
#   unix ms, TT-UTC (32.184 s + ERFA dat), GMST and GAST (ERFA gmst06 / gst06a with UT1 = UTC), the IAU 2006/2000A bias-precession-nutation
#   matrix, geocentric apparent places (true equator and equinox of date, astropy TETE frame) and distances of the
#   Sun, Moon and planets, the Moon's illuminated fraction from the ephemeris vectors, and for a few sites the
#   airless topocentric altitude and azimuth of those bodies and of some bright stars (which includes annual
#   aberration, about 20", that the JavaScript does not model).
# Refraction: ERFA refco (A tan z + B tan^3 z) for altitudes of 10 degrees and more.
# UT1 - UTC is forced to zero so that the file does not depend on IERS downloads; the JavaScript makes the same choice.
# A second file, test/astro_night_reference.json (written alone with --night): for a few sites and dates, the times
# at which the Sun's centre crosses -0.833, -6, -12 and -18 degrees (airless, topocentric) during the night that
# contains or follows the instant, and the rising, culmination and setting (airless altitude 0) of fixed ICRS
# positions, all by bisection on astropy's AltAz altitude.
import json, sys, os, warnings
import numpy as np
import erfa
from astropy import units as u
from astropy.time import Time
from astropy.utils import iers
from astropy.coordinates import EarthLocation, AltAz, SkyCoord, TETE, GCRS, get_body, solar_system_ephemeris, get_body_barycentric

warnings.simplefilter('ignore')
iers.conf.auto_download = False
iers.conf.auto_max_age = None
iers.conf.iers_degraded_accuracy = 'ignore'

EPH = 'de432s'
try:
    solar_system_ephemeris.set(EPH)
    get_body('mars', Time('2020-01-01'))
except Exception as exc:  # no network: the built-in ERFA series (Moon about 1", planets up to about 1')
    print('could not load', EPH, '->', exc, '; using the built-in ephemeris', file=sys.stderr)
    EPH = 'builtin'
    solar_system_ephemeris.set(EPH)

BODIES = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']
SITES = {'Tucson': (32.2226, -110.9747, 728.0), 'Greenwich': (51.4769, 0.0, 46.0), 'Sydney': (-33.8688, 151.2093, 20.0), 'Tromso': (69.6492, 18.9553, 10.0), 'Quito': (-0.1807, -78.4678, 2850.0)}
STARS = {'Sirius': (101.28715533, -16.71611586), 'Betelgeuse': (88.79293899, 7.40706400), 'Polaris': (37.95456067, 89.26410897), 'Vega': (279.23473479, 38.78368896),
         'Canopus': (95.98795783, -52.69566138), 'Alnilam': (84.05338894, -1.20191914), 'Antares': (247.35191542, -26.43200261), 'Sigma Oct': (317.19508, -88.95650)}

rng = np.random.default_rng(20261115)
t0, t1 = Time('1975-01-01T00:00:00', scale='utc').unix, Time('2050-01-01T00:00:00', scale='utc').unix
unix = sorted(np.round(rng.uniform(t0, t1, 60) * 1000) / 1000)
fixed = ['2026-01-15T05:00:00', '2000-01-01T12:00:00', '2024-04-08T18:18:00', '2017-08-21T17:25:00', '2035-09-02T01:55:00']
unix = list(unix) + [Time(s, scale='utc').unix for s in fixed]


def mk_time(ux):
    t = Time(ux, format='unix', scale='utc')
    t.delta_ut1_utc = 0.0
    return t


def bisect(f, a, b, tol=0.02):
    fa = f(a)
    while b - a > tol:
        m = 0.5 * (a + b); fm = f(m)
        if (fm < 0) == (fa < 0): a, fa = m, fm
        else: b = m
    return 0.5 * (a + b)


def crossings(f, t0, t1, step=600.0):
    out, a, fa = [], t0, f(t0)
    while a < t1:
        b = min(a + step, t1); fb = f(b)
        if (fa < 0) != (fb < 0): out.append((bisect(f, a, b), bool(fb > fa)))
        a, fa = b, fb
    return out


def night_reference():
    targets = {'HAT-P-32': (31.0427658, 46.6878404), 'WASP-12': (97.6366419, 29.6722662), 'TRAPPIST-1': (346.6263919, -5.0434618), 'Sirius': STARS['Sirius'], 'Vega': STARS['Vega'], 'Canopus': STARS['Canopus']}
    sites = {'Kitt Peak': (31.96, -111.6, 2096.0), 'Greenwich': SITES['Greenwich'], 'Sydney': SITES['Sydney'], 'Tromso': SITES['Tromso'], 'Mauna Kea': (19.8207, -155.4681, 4205.0)}
    dates = ['2026-11-16T04:00:00', '2026-06-21T12:00:00', '2027-03-20T00:00:00', '2040-12-21T20:00:00']
    out = []
    for sname, (lat, lon, h) in sites.items():
        loc = EarthLocation.from_geodetic(lon * u.deg, lat * u.deg, h * u.m)
        for d in dates:
            ux = Time(d, scale='utc').unix
            noon = (np.floor(ux / 86400 + lon / 360 - 0.5) + 0.5 - lon / 360) * 86400

            def sun_alt(x):
                t = mk_time(x)
                return get_body('sun', t, loc).transform_to(AltAz(obstime=t, location=loc, pressure=0 * u.hPa)).alt.deg
            c = {'site': sname, 'lat': lat, 'lon': lon, 'height': h, 'iso': d, 'ms': int(round(ux * 1000)), 'noon_ms': noon * 1000, 'sun': {}, 'stars': {}}
            for name, lim in (('sun', -0.833), ('civil', -6.0), ('nautical', -12.0), ('astronomical', -18.0)):
                cr = crossings(lambda x: sun_alt(x) - lim, noon, noon + 86400)
                sets = [x for x, rising in cr if not rising]; ev = sets[0] if sets else None
                rises = [x for x, rising in cr if rising and (ev is None or x > ev)]
                c['sun'][name] = {'evening': ev * 1000 if ev is not None else None, 'morning': rises[0] * 1000 if rises else None}
            for tn, (ra, dec) in targets.items():
                sc = SkyCoord(ra * u.deg, dec * u.deg, frame='icrs')

                def alt(x):
                    t = mk_time(x)
                    return sc.transform_to(AltAz(obstime=t, location=loc, pressure=0 * u.hPa)).alt.deg
                # culmination nearest the instant: the maximum of the altitude within half a sidereal day
                xs = np.linspace(ux - 43082.05, ux + 43082.05, 289); k = int(np.argmax([alt(x) for x in xs]))
                a, b = xs[max(k - 1, 0)], xs[min(k + 1, len(xs) - 1)]
                for _ in range(60):       # golden-section search
                    m1, m2 = b - 0.618034 * (b - a), a + 0.618034 * (b - a)
                    if alt(m1) > alt(m2): b = m2
                    else: a = m1
                culm = 0.5 * (a + b)
                cr = crossings(alt, culm - 43082.05, culm + 43082.05)
                rise = [x for x, r in cr if r and x < culm]; st = [x for x, r in cr if not r and x > culm]
                c['stars'][tn] = {'ra': ra, 'dec': dec, 'culmination': culm * 1000, 'alt_max': alt(culm), 'rise': rise[-1] * 1000 if rise else None, 'set': st[0] * 1000 if st else None,
                                  'at': [{'ms': int(round(x * 1000)), 'alt': alt(x), 'az': float(sc.transform_to(AltAz(obstime=mk_time(x), location=loc, pressure=0 * u.hPa)).az.deg)} for x in (ux, ux + 7200, ux + 18000)]}
            out.append(c)
            print(sname, d, c['sun']['civil'])
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'astro_night_reference.json')
    with open(path, 'w') as f:
        json.dump({'generator': 'test/make_astro_reference.py --night', 'astropy': __import__('astropy').__version__, 'ephemeris': EPH, 'note': 'UT1 = UTC; airless topocentric altitudes; times in Unix ms', 'cases': out}, f, separators=(',', ':'))
    print('wrote', path, os.path.getsize(path), 'bytes')


night_reference()
if '--night' in sys.argv:
    sys.exit(0)

cases = []
for ux in unix:
    t = mk_time(ux)
    tt = t.tt
    c = {'ms': int(round(ux * 1000)), 'iso': t.isot, 'jd_utc': t.jd, 'tt_minus_utc': 32.184 + float(erfa.dat(t.datetime.year, t.datetime.month, t.datetime.day, 0.0))}
    c['gmst'] = float(erfa.gmst06(t.jd1, t.jd2, tt.jd1, tt.jd2))      # UT1 = UTC
    c['gast'] = float(erfa.gst06a(t.jd1, t.jd2, tt.jd1, tt.jd2))
    c['npb'] = erfa.pnm06a(tt.jd1, tt.jd2).reshape(-1).tolist()
    c['bodies'] = {}
    for b in BODIES:
        g = get_body(b, t)                       # geocentric GCRS, light-time corrected
        a = g.transform_to(TETE(obstime=t))      # apparent, true equator and equinox of date
        c['bodies'][b] = {'ra': a.ra.rad, 'dec': a.dec.rad, 'dist_au': a.distance.to_value(u.au)}
    # illuminated fraction of the Moon from barycentric vectors: angle at the Moon between the Sun and the Earth
    pm, pe, ps = (get_body_barycentric(n, t).xyz.to_value(u.km) for n in ('moon', 'earth', 'sun'))
    v1, v2 = ps - pm, pe - pm
    c['moon_fraction'] = float((1 + np.dot(v1, v2) / np.linalg.norm(v1) / np.linalg.norm(v2)) / 2)
    c['sites'] = {}
    for name, (lat, lon, h) in SITES.items():
        loc = EarthLocation.from_geodetic(lon * u.deg, lat * u.deg, h * u.m)
        frame = AltAz(obstime=t, location=loc, pressure=0 * u.hPa)
        s = {'lat': lat, 'lon': lon, 'height': h, 'bodies': {}, 'stars': {}}
        for b in BODIES:
            aa = get_body(b, t, loc).transform_to(frame)
            s['bodies'][b] = {'alt': aa.alt.rad, 'az': aa.az.rad}
        for sn, (ra, dec) in STARS.items():
            aa = SkyCoord(ra * u.deg, dec * u.deg, frame='icrs').transform_to(frame)
            s['stars'][sn] = {'alt': aa.alt.rad, 'az': aa.az.rad}
        c['sites'][name] = s
    cases.append(c)

# refraction: ERFA's two-constant model at the JavaScript default conditions, apparent altitude -> refraction
A, B = erfa.refco(1010.0, 10.0, 0.5, 0.55)
refr = []
for alt in [10, 12, 15, 20, 30, 45, 60, 75, 89]:
    z = np.radians(90 - alt)
    refr.append({'alt_apparent_deg': alt, 'refraction_arcsec': float(np.degrees(A * np.tan(z) + B * np.tan(z) ** 3) * 3600)})

out = {'generator': 'test/make_astro_reference.py', 'astropy': __import__('astropy').__version__, 'erfa': erfa.__version__, 'ephemeris': EPH,
       'note': 'UT1 = UTC; apparent places in the true equator and equinox of date (TETE); alt/az airless (pressure 0)',
       'stars_icrs_deg': STARS, 'refraction': {'pressure_hpa': 1010.0, 'temp_c': 10.0, 'rh': 0.5, 'wavelength_um': 0.55, 'values': refr}, 'cases': cases}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'astro_reference.json')
with open(path, 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print('wrote', path, os.path.getsize(path), 'bytes,', len(cases), 'instants, ephemeris', EPH)
