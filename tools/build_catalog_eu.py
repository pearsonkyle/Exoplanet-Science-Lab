#!/usr/bin/env python
"""Build public/catalog-eu/planets.json from the Extrasolar Planets Encyclopaedia (exoplanet.eu).

exoplanet.eu offers its whole catalogue as one CSV (https://exoplanet.eu/catalog/csv/). The response carries no
Access-Control-Allow-Origin header (checked 2026-11-15), so a page on another origin cannot fetch it and the site
reads this snapshot instead.

Terms: the site footer says "Except where otherwise noted, content on this site is licensed under a Creative
Commons Attribution 4.0 International license", and its README asks for the acknowledgement "This research has
made use of data obtained from or tools provided by the portal exoplanet.eu of The Extrasolar Planets
Encyclopaedia." Both sentences are stored in the snapshot and shown by the Search page.

The format is the one of tools/build_catalog_table.py (read by src/core/sources/snapshot.js); values keep the
encyclopaedia's column names and units (masses and radii in Jupiter units, a in au, angles in degrees, times in JD,
K in m/s, distance in pc). Its error columns are magnitudes (error_min below, error_max above); they are stored as
[value, +error_max, -error_min] to match the archive's err1 / err2 convention. There is no reference per value in
the CSV, only the publication status of the planet.

Usage: python tools/build_catalog_eu.py [--out public/catalog-eu] [--csv cached.csv]
Needs requests, pandas.
"""
import argparse, datetime, io, json, math, os, sys

import pandas as pd
import requests

URL = 'https://exoplanet.eu/catalog/csv/'
LICENCE = 'Except where otherwise noted, content on this site is licensed under a Creative Commons Attribution 4.0 International license'
ACK = 'This research has made use of data obtained from or tools provided by the portal exoplanet.eu of The Extrasolar Planets Encyclopaedia.'

Q = ['mass', 'mass_sini', 'radius', 'orbital_period', 'semi_major_axis', 'eccentricity', 'inclination', 'omega', 'tperi', 'tconj', 'tzero_tr',
     'impact_parameter', 'k', 'temp_calculated', 'star_distance', 'star_metallicity', 'star_mass', 'star_radius', 'star_teff', 'star_age']
N = ['name', 'star_name', 'alternate_names', 'star_alternate_names', 'ra', 'dec', 'mag_v', 'mag_i', 'mag_j', 'mag_h', 'mag_k', 'discovered', 'updated',
     'temp_measured']
S = ['planet_status', 'publication', 'detection_type', 'mass_measurement_type', 'radius_measurement_type', 'star_sp_type']


def num(x):
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return int(f) if f == int(f) and abs(f) < 1e15 else f


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--out', default=os.path.join(here, '..', 'public', 'catalog-eu'))
    ap.add_argument('--csv', help='read this CSV instead of downloading (and write it if it does not exist)')
    a = ap.parse_args()
    if a.csv and os.path.exists(a.csv):
        text = open(a.csv, encoding='utf-8').read()
    else:
        r = requests.get(URL, timeout=(20, 300))
        r.raise_for_status()
        text = r.text
        if a.csv:
            open(a.csv, 'w', encoding='utf-8').write(text)
    df = pd.read_csv(io.StringIO(text), low_memory=False)
    print(f'{len(df)} rows, {len(df.columns)} columns')
    if len(df) < 5000 or 'orbital_period' not in df:
        sys.exit('unexpected download; not writing a snapshot')
    missing = [c for c in Q + N + S if c not in df]
    if missing:
        print('columns not in the download, dropped:', missing)
    q, n, s = [c for c in Q if c in df], [c for c in N if c in df], [c for c in S if c in df]
    strs = {}

    def sid(x):
        if not isinstance(x, str) or not x.strip():
            return None
        return strs.setdefault(x.strip(), len(strs))

    def quantity(r, c):
        v = num(getattr(r, c))
        if v is None:
            return None
        lo, hi = num(getattr(r, c + '_error_min', None)), num(getattr(r, c + '_error_max', None))
        if lo is None and hi is None:
            return v
        return [v, None if hi is None else abs(hi), None if lo is None else -abs(lo)]

    df = df.sort_values('name', key=lambda x: x.str.lower(), kind='stable')
    rows = []
    for r in df.itertuples(index=False):
        row = [(getattr(r, c).strip() if isinstance(getattr(r, c), str) else num(getattr(r, c))) for c in n]
        row += [sid(getattr(r, c)) for c in s] + [quantity(r, c) for c in q]
        while row and row[-1] is None:
            row.pop()
        rows.append(row)
    out = json.dumps({
        'v': 1, 'source': 'The Extrasolar Planets Encyclopaedia (exoplanet.eu)', 'table': 'catalogue CSV, all objects in the default download',
        'url': URL, 'date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'), 'licence': LICENCE, 'acknowledgement': ACK,
        'nrows': len(rows), 'columns': [[c, 'n'] for c in n] + [[c, 's'] for c in s] + [[c, 'q'] for c in q], 'refs': [], 'strs': list(strs), 'rows': rows,
    }, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    os.makedirs(a.out, exist_ok=True)
    open(os.path.join(a.out, 'planets.json'), 'w', encoding='utf-8').write(out)
    print(f'planets.json: {len(rows)} objects, status {df.planet_status.value_counts().to_dict()}, {len(out.encode()) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
