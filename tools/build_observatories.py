#!/usr/bin/env python
"""Build public/observatories/sites.json: the observatories the Plan page offers on its globe and in its list.

Nothing here is typed from memory. Coordinates and elevations come from two public lists; which observatories to
show, their display names and the networks they belong to are the curated part (SELECT below).

  astropy   the site registry behind astropy's EarthLocation.get_site_names(): the astropy-data file
            coordinates/sites.json, most of it converted from the IRAF observatory database (each entry names its
            own source, which is copied to the output). Geodetic latitude, longitude and elevation.
  mpc       the Minor Planet Center's list of observatory codes (ObsCodes.html): east longitude and the parallax
            constants rho cos(phi') and rho sin(phi') in Earth radii. They are converted here to geodetic latitude
            and height on the WGS84 ellipsoid. Constants given to 6 decimals fix the height to about 10 m, those
            given to 5 decimals to about 60 m, so `elev` of an MPC site is rounded to 10 m.

Time zones are not taken from either list (astropy labels Lowell, the MMT and Whipple "US/Mountain", which has
daylight saving time; Arizona has none): every site's IANA zone is looked up from its coordinates with the
`timezonefinder` package (timezone-boundary-builder polygons from OpenStreetMap). Where astropy's label names a
different zone the output says so (`tzNote`).

The script checks itself: every observatory that is in BOTH lists (CHECK below) is converted from its MPC
constants and compared with astropy's entry; the differences are printed and stored in the output.

It also writes land-110m.json, the coastlines the globe draws: the land polygons of Natural Earth at 1:110 million
(public domain, naturalearthdata.com), as rings of [lon, lat] in tenths of a degree.

Usage: python tools/build_observatories.py [--out public/observatories] [--cache DIR]
Needs requests and timezonefinder (pip install requests timezonefinder).
"""
import argparse, datetime, json, math, os, sys

ASTROPY_URLS = ['https://data.astropy.org/coordinates/sites.json', 'https://www.astropy.org/astropy-data/coordinates/sites.json',
                'https://raw.githubusercontent.com/astropy/astropy-data/gh-pages/coordinates/sites.json']
MPC_URL = 'https://www.minorplanetcenter.net/iau/lists/ObsCodes.html'
LAND_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson'
UA = 'ExoplanetScienceLab-observatory-list/1.0 (static site build; https://exoplanet.science)'

# (source, key or code, display name, kind, networks)
#   kind: 'pro' professional observatory, 'net' node of a robotic or education network, 'remote' hosting site used by
#   amateur and citizen-science observers (AAVSO, ExoClock, Exoplanet Watch observers rent or own telescopes there)
SELECT = [
    # ---- Hawaii and the Americas
    ('astropy', 'keck', 'Maunakea Observatories, Hawaii', 'pro', []),
    # astropy's 'haleakala' entry is 9 km east of the summit (longitude 203.831 against 203.742 for every MPC station there): the MPC position is used
    ('mpc', 'F65', 'Haleakala Observatories, Maui', 'net', ['LCO']),
    ('astropy', 'lick', 'Lick Observatory, California', 'pro', []),
    ('astropy', 'mwo', 'Mount Wilson Observatory, California', 'pro', []),
    ('mpc', '673', 'Table Mountain Observatory (JPL), California', 'pro', []),
    ('astropy', 'Palomar', 'Palomar Observatory, California', 'pro', []),
    ('astropy', 'mlo', 'Mount Laguna Observatory, California', 'pro', []),
    ('mpc', 'U69', 'Sierra Remote Observatories, California', 'remote', ['iTelescope']),
    ('astropy', 'kpno', 'Kitt Peak National Observatory, Arizona', 'pro', ['NOIRLab']),
    ('astropy', 'flwo', 'Fred L. Whipple Observatory, Arizona', 'net', ['MicroObservatory', 'MEarth', 'MINERVA']),
    ('astropy', 'lowell', 'Lowell Observatory, Anderson Mesa, Arizona', 'pro', []),
    ('astropy', 'dct', 'Lowell Discovery Telescope, Arizona', 'pro', []),
    ('astropy', 'mtbigelow', 'Catalina Station, Mount Bigelow, Arizona', 'pro', []),
    ('mpc', 'G84', 'Mount Lemmon SkyCenter, Arizona', 'pro', []),
    ('astropy', 'lbt', 'Mount Graham (LBT), Arizona', 'pro', []),
    ('astropy', 'winer', 'Winer Observatory, Arizona', 'remote', ['KELT']),
    ('mpc', 'G95', 'Hereford Arizona Observatory', 'remote', []),
    ('mpc', 'U94', 'Utah Desert Remote Observatories, Beryl Junction', 'remote', ['iTelescope']),
    ('astropy', 'apo', 'Apache Point Observatory, New Mexico', 'pro', []),
    ('mpc', 'H06', 'New Mexico Skies, Mayhill', 'remote', ['iTelescope']),
    ('mpc', 'H01', 'Magdalena Ridge Observatory, New Mexico', 'pro', []),
    ('astropy', 'mcdonald', 'McDonald Observatory, Texas', 'net', ['LCO']),
    ('mpc', '802', 'Harvard College Observatory, Cambridge', 'net', ['MicroObservatory']),
    ('mpc', 'W38', 'Dark Sky Observatory, North Carolina', 'pro', []),
    ('astropy', 'dao', 'Dominion Astrophysical Observatory, Canada', 'pro', []),
    ('mpc', '661', 'Rothney Astrophysical Observatory, Canada', 'pro', []),
    ('astropy', 'omm', 'Observatoire du Mont-Megantic, Canada', 'pro', []),
    ('astropy', 'spm', 'San Pedro Martir (OAN), Mexico', 'pro', ['SAINT-EX']),
    ('astropy', 'ctio', 'Cerro Tololo, Chile', 'net', ['LCO', 'NOIRLab']),
    ('astropy', 'gemini_south', 'Cerro Pachon (Gemini South, SOAR), Chile', 'pro', ['NOIRLab']),
    ('astropy', 'lasilla', 'La Silla Observatory (ESO), Chile', 'pro', ['ESO', 'TRAPPIST']),
    ('astropy', 'lco', 'Las Campanas Observatory, Chile', 'pro', []),
    ('astropy', 'paranal', 'Paranal Observatory (ESO), Chile', 'pro', ['ESO', 'SPECULOOS', 'NGTS']),
    ('astropy', 'oca', 'Cerro Armazones Observatory, Chile', 'pro', []),
    ('mpc', 'X07', 'Deep Sky Chile, Rio Hurtado', 'remote', ['iTelescope']),
    ('mpc', 'X02', 'El Sauce Observatory, Rio Hurtado, Chile', 'remote', []),
    ('mpc', 'G39', 'San Pedro de Atacama remote observatories, Chile', 'remote', []),
    ('mpc', '829', 'Complejo Astronomico El Leoncito, Argentina', 'pro', []),
    ('mpc', '821', 'Bosque Alegre, Cordoba, Argentina', 'pro', []),
    ('mpc', '874', 'Observatorio do Pico dos Dias, Brazil', 'pro', []),
    # ---- Europe, Africa, Middle East
    ('astropy', 'lapalma', 'Roque de los Muchachos, La Palma', 'pro', []),
    ('astropy', 'teide', 'Teide Observatory, Tenerife', 'net', ['LCO', 'SPECULOOS']),
    ('mpc', 'Z53', 'Oukaimeden Observatory (TRAPPIST-North), Morocco', 'pro', ['TRAPPIST']),
    ('astropy', 'CAHA', 'Calar Alto Observatory, Spain', 'pro', []),
    ('mpc', 'J86', 'Sierra Nevada Observatory, Spain', 'pro', []),
    ('astropy', 'OAJ', 'Javalambre Observatory, Spain', 'pro', []),
    ('mpc', 'C65', 'Montsec Observatory, Spain', 'pro', []),
    ('mpc', 'I89', 'Nerpio remote observatories, Spain', 'remote', ['iTelescope']),
    ('mpc', '586', 'Pic du Midi, France', 'pro', []),
    ('astropy', 'ohp', 'Observatoire de Haute-Provence, France', 'pro', []),
    ('mpc', 'R87', "Observatoire de la Cote d'Azur, France", 'pro', []),
    ('astropy', 'ekar', 'Asiago Cima Ekar, Italy', 'pro', []),
    ('mpc', '598', 'Loiano, Italy', 'pro', []),
    ('astropy', 'Wendelstein', 'Wendelstein Observatory, Germany', 'pro', []),
    ('mpc', '033', 'Tautenburg, Germany', 'pro', []),
    ('mpc', '557', 'Ondrejov Observatory, Czechia', 'pro', []),
    ('mpc', '056', 'Skalnate Pleso Observatory, Slovakia', 'pro', []),
    ('mpc', '461', 'Piszkesteto Station (Konkoly), Hungary', 'pro', []),
    ('mpc', '152', 'Moletai Astronomical Observatory, Lithuania', 'pro', []),
    ('mpc', '071', 'NAO Rozhen, Bulgaria', 'pro', []),
    ('mpc', 'L10', 'Kryoneri Observatory, Greece', 'pro', []),
    ('astropy', 'tug', 'TUBITAK National Observatory, Turkiye', 'pro', []),
    ('mpc', '095', 'Crimean Astrophysical Observatory, Nauchnyi', 'pro', []),
    ('mpc', '115', 'Special Astrophysical Observatory, Zelenchukskaya', 'pro', []),
    ('mpc', 'B18', 'Terskol Observatory, Caucasus', 'pro', []),
    ('mpc', '168', 'Kourovka Observatory, Urals', 'pro', []),
    ('astropy', 'wise', 'Wise Observatory, Israel', 'pro', []),
    ('mpc', 'M40', 'Kottamia Observatory, Egypt', 'pro', []),
    ('astropy', 'salt', 'SAAO Sutherland, South Africa', 'net', ['LCO', 'KELT']),
    ('mpc', '074', 'Boyden Observatory, South Africa', 'pro', []),
    ('mpc', 'L87', 'Hakos remote observatories, Namibia', 'remote', []),
    # ---- Asia and Oceania
    ('mpc', '188', 'Maidanak Observatory, Uzbekistan', 'pro', []),
    ('astropy', 'iao', 'Indian Astronomical Observatory, Hanle', 'pro', []),
    ('astropy', 'dot', 'Devasthal Observatory (ARIES), India', 'pro', []),
    ('astropy', 'vbo', 'Vainu Bappu Observatory, Kavalur, India', 'pro', []),
    ('mpc', 'N87', 'Nanshan Station (Xinjiang Observatory), China', 'pro', []),
    ('astropy', 'Lijiang', 'Lijiang Observatory, China', 'pro', []),
    ('astropy', 'BAO', 'Xinglong Observatory, China', 'pro', []),
    ('astropy', 'TNO', 'Thai National Observatory, Doi Inthanon', 'pro', []),
    ('mpc', 'D35', 'Lulin Observatory, Taiwan', 'pro', []),
    ('mpc', '344', 'Bohyunsan Observatory, Korea', 'pro', []),
    ('astropy', 'OAO', 'Okayama Observatory, Japan', 'pro', []),
    ('mpc', '381', 'Kiso Observatory, Japan', 'pro', []),
    ('mpc', 'D20', 'Zadko Observatory, Western Australia', 'pro', []),
    ('astropy', 'sso', 'Siding Spring Observatory, Australia', 'net', ['LCO', 'iTelescope']),
    ('mpc', 'E22', 'Mount Kent Observatory, Queensland', 'pro', ['MINERVA-Australis']),
    ('astropy', 'mso', 'Mount Stromlo Observatory, Australia', 'pro', []),
    ('mpc', 'Q54', 'Greenhill Observatory, Tasmania', 'pro', []),
    ('astropy', 'Otehiwai Observatory', 'Mount John Observatory, New Zealand', 'pro', []),
]
# (astropy key, MPC code) of the same observatory in both lists: the conversion from parallax constants is checked on these
CHECK = [('kpno', '695'), ('lapalma', '950'), ('paranal', '309'), ('lasilla', '809'), ('ctio', '807'), ('lick', '662'), ('mcdonald', '711'),
         ('CAHA', '493'), ('ohp', '511'), ('sso', '413'), ('teide', '954'), ('flwo', '696'), ('lco', '304'), ('apo', '705'), ('keck', 'T16'),
         ('salt', 'B31'), ('Otehiwai Observatory', '474'), ('haleakala', 'F65')]

A_KM, F = 6378.137, 1 / 298.257223563


def geodetic(rho_cos, rho_sin):
    """Parallax constants (Earth equatorial radii) -> (geodetic latitude deg, height m) on WGS84 (Bowring, iterated)."""
    p, z = rho_cos * A_KM, rho_sin * A_KM
    e2 = F * (2 - F)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(8):
        n = A_KM / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - e2 * n / (n + h)))
    n = A_KM / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return math.degrees(lat), (p / math.cos(lat) - n) * 1000


def parse_mpc(text):
    out = {}
    for line in text.splitlines():
        if len(line) < 31 or line.startswith(('Code', '<')):
            continue
        try:
            lon, c, s = float(line[4:13]), float(line[13:21]), float(line[21:30])
        except ValueError:
            continue                                   # spacecraft and roving observers have no constants
        digits = min(len(line[13:21].strip().split('.')[-1]), len(line[21:30].strip().split('.')[-1]))
        out[line[:3]] = dict(lon=lon, cos=c, sin=s, name=line[30:].strip(), digits=digits)
    return out


def get(urls, cache, name):
    import requests
    path = cache and os.path.join(cache, name)
    if path and os.path.exists(path):
        return open(path, encoding='utf-8').read(), 'cache:' + path
    last = None
    for u in urls:
        try:
            r = requests.get(u, timeout=(15, 60), headers={'User-Agent': UA})
            r.raise_for_status()
            if path:
                open(path, 'w', encoding='utf-8').write(r.text)
            return r.text, u
        except Exception as e:                          # try the mirror
            last = e
    sys.exit(f'could not fetch {name}: {last}')


def wrap(lon):
    return (lon + 180) % 360 - 180


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--out', default=os.path.join(here, '..', 'public', 'observatories'))
    ap.add_argument('--cache', help='folder for the two downloaded lists (reused when present)')
    a = ap.parse_args()
    if a.cache:
        os.makedirs(a.cache, exist_ok=True)
    from timezonefinder import TimezoneFinder
    from importlib.metadata import version
    tf = TimezoneFinder()
    from zoneinfo import ZoneInfo

    atext, aurl = get(ASTROPY_URLS, a.cache, 'sites.json')
    mtext, murl = get([MPC_URL], a.cache, 'ObsCodes.html')
    AS, MPC = json.loads(atext), parse_mpc(mtext)
    print(f'astropy: {len(AS)} sites from {aurl}; MPC: {len(MPC)} codes with coordinates from {murl}')
    if len(AS) < 80 or len(MPC) < 2000:
        sys.exit('unexpected downloads; not writing')

    def from_mpc(code):
        m = MPC[code]
        lat, h = geodetic(m['cos'], m['sin'])
        return lat, wrap(m['lon']), h, m

    now = datetime.datetime.now(datetime.timezone.utc)
    sites, seen = [], set()
    for src, key, name, kind, nets in SELECT:
        if src == 'astropy':
            s = AS[key]
            lat, lon, elev = float(s['latitude']), wrap(float(s['longitude'])), float(s['elevation'])
            rec = dict(id=key.lower().replace(' ', '_'), name=name, lat=round(lat, 5), lon=round(lon, 5), elev=round(elev), src='astropy', key=key,
                       listed=s['name'], origin=' '.join(str(s.get('source', '')).split())[:120])
            label = s.get('timezone')
        else:
            lat, lon, h, m = from_mpc(key)
            rec = dict(id='mpc' + key.lower(), name=name, lat=round(lat, 5), lon=round(lon, 5), elev=int(round(h / 10) * 10), src='mpc', key=key,
                       listed=m['name'], origin=f'parallax constants to {m["digits"]} decimals')
            label = None
        if rec['id'] in seen:
            sys.exit('duplicate id ' + rec['id'])
        seen.add(rec['id'])
        tz = tf.timezone_at(lat=lat, lng=lon)
        if not tz:
            sys.exit(f'no time zone for {name}')
        rec['tz'] = tz
        if label:
            # same zone if the two have the same UTC offset in January and in July of this year
            try:
                same = all(datetime.datetime(now.year, mth, 15, 12, tzinfo=ZoneInfo(tz)).utcoffset() == datetime.datetime(now.year, mth, 15, 12, tzinfo=ZoneInfo(label)).utcoffset() for mth in (1, 7))
            except Exception:
                same = False
            if not same:
                rec['tzNote'] = f'astropy labels it {label}'
        rec['kind'] = kind
        if nets:
            rec['nets'] = nets
        sites.append(rec)

    # ---- check: MPC constants -> geodetic against astropy for observatories in both lists
    def dist_km(la1, lo1, la2, lo2):
        d = math.radians
        x = math.sin(d(la2 - la1) / 2) ** 2 + math.cos(d(la1)) * math.cos(d(la2)) * math.sin(d(lo2 - lo1) / 2) ** 2
        return 2 * 6371 * math.asin(math.sqrt(x))
    checks = []
    for k, code in CHECK:
        s = AS[k]
        lat, lon, h, m = from_mpc(code)
        checks.append(dict(astropy=k, mpc=code, km=round(dist_km(float(s['latitude']), wrap(float(s['longitude'])), lat, lon), 2), dElev=round(h - float(s['elevation']))))
        print(f'  check {k:22s} vs {code} {m["name"][:38]:38s} {checks[-1]["km"]:6.2f} km  elevation {checks[-1]["dElev"]:+5d} m')
    worst_km, worst_h = max(c['km'] for c in checks), max(abs(c['dElev']) for c in checks)
    print(f'{len(checks)} observatories in both lists: worst horizontal difference {worst_km} km, worst elevation difference {worst_h} m')

    out = dict(v=1, date=now.strftime('%Y-%m-%d'), about='Observatories offered by the Plan page. Coordinates from the two sources below; names, kind and networks curated in tools/build_observatories.py.',
               sources=dict(
                   astropy=dict(name="astropy site registry (astropy-data coordinates/sites.json; mostly the IRAF observatory database)", url=ASTROPY_URLS[0], fetched=aurl, n=sum(1 for s in sites if s['src'] == 'astropy'), listed=len(AS)),
                   mpc=dict(name='Minor Planet Center list of observatory codes', url=MPC_URL, fetched=murl, n=sum(1 for s in sites if s['src'] == 'mpc'), listed=len(MPC),
                            note='geodetic latitude and height computed from the parallax constants on WGS84; elevation rounded to 10 m'),
                   tz=dict(name=f'timezonefinder {version("timezonefinder")} (timezone-boundary-builder, OpenStreetMap)', url='https://github.com/jannikmi/timezonefinder')),
               check=dict(what='MPC parallax constants converted to geodetic and compared with the astropy entry of the same observatory (telescopes on one mountain can be a kilometre apart)',
                          n=len(checks), worstKm=worst_km, worstElevM=worst_h, pairs=checks),
               kinds=dict(pro='professional observatory', net='node of a robotic or education network', remote='remote hosting site used by amateur and citizen-science observers'),
               sites=sites)
    os.makedirs(a.out, exist_ok=True)
    text = json.dumps(out, ensure_ascii=False, indent=1)
    open(os.path.join(a.out, 'sites.json'), 'w', encoding='utf-8').write(text)
    # ---- coastlines for the globe
    ltext, lurl = get([LAND_URL], a.cache, 'ne_110m_land.geojson')
    rings = []
    for f in json.loads(ltext)['features']:
        g = f['geometry']
        for poly in ([g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']):
            ring = poly[0]                                           # outer boundary; the 1:110m land has no lakes cut out
            flat, last = [], None
            for lon, lat in ring:
                q = (round(lon * 10), round(lat * 10))
                if q != last:
                    flat += q
                    last = q
            if len(flat) >= 8:
                rings.append(flat)
    land = json.dumps(dict(v=1, source='Natural Earth 1:110m land (ne_110m_land), public domain', url=LAND_URL, date=now.strftime('%Y-%m-%d'), unit='0.1 degree, [lon, lat, lon, lat, ...] per ring', rings=rings), separators=(',', ':'))
    open(os.path.join(a.out, 'land-110m.json'), 'w', encoding='utf-8').write(land)
    print(f'land-110m.json: {len(rings)} rings, {sum(len(r) for r in rings) // 2} points, {len(land) / 1e3:.1f} kB from {lurl}')
    kinds = {k: sum(1 for s in sites if s['kind'] == k) for k in ('pro', 'net', 'remote')}
    print(f'sites.json: {len(sites)} observatories ({out["sources"]["astropy"]["n"]} astropy, {out["sources"]["mpc"]["n"]} MPC; {kinds}); '
          f'{sum(1 for s in sites if "tzNote" in s)} time-zone labels of astropy corrected; {len(text.encode()) / 1e3:.1f} kB')


if __name__ == '__main__':
    main()
