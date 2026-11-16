#!/usr/bin/env python3
# Builds the static data of the sky view (observe/) under public/sky/. Standard library only.
#
#   python3 tools/build_sky_data.py [--cache DIR] [--maglim 8.0]
#
# Sources
#   Stars, star names, constellation lines and names: the data folder of d3-celestial by Olaf Frohn,
#     https://github.com/ofrohn/d3-celestial (BSD 3-Clause, copyright (c) 2015 Olaf Frohn). Its stars come from
#     XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012, VizieR V/137D); positions are J2000,
#     magnitudes are V, colours are B-V.
#   Exoplanet host stars: the snapshot of the NASA Exoplanet Archive already in public/catalog (tools/build_catalog.py).
#
# Outputs
#   stars.bin            'ESLS', uint32 length of a JSON header, the header (source, licence, record layout), padding
#                        to 4 bytes, then one 16-byte little-endian record per star, brightest first:
#                        float32 ra_deg, float32 dec_deg, int16 V*100, int16 (B-V)*1000 (32767 = unknown), uint32 HIP
#   starnames.json       { hip: "Proper name|designation" } for the stars that have either
#   constellations.json  line strings [ra, dec, ra, dec, ...] and label positions, J2000 degrees
#   hosts.json           [name, ra_deg, dec_deg, V or null, number of planets] per host star
import argparse, json, os, struct, sys, urllib.request, glob, datetime

BASE = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/'
FILES = ['stars.8.json', 'starnames.json', 'constellations.lines.json', 'constellations.json']
SOURCE = 'd3-celestial data (https://github.com/ofrohn/d3-celestial), from XHIP (Anderson & Francis 2012, VizieR V/137D)'
LICENCE = 'BSD 3-Clause, copyright (c) 2015 Olaf Frohn'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument('--cache', default=os.path.join(os.environ.get('TMPDIR', '/tmp'), 'esl-sky-cache'))
ap.add_argument('--maglim', type=float, default=8.0)
args = ap.parse_args()
os.makedirs(args.cache, exist_ok=True)
out = os.path.join(ROOT, 'public', 'sky')
os.makedirs(out, exist_ok=True)
today = datetime.date.today().isoformat()


def get(name):
    path = os.path.join(args.cache, name)
    if not os.path.exists(path):
        print('downloading', BASE + name)
        urllib.request.urlretrieve(BASE + name, path)
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_json(name, obj):
    path = os.path.join(out, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{name}: {os.path.getsize(path)} bytes')


ra_of = lambda lon: round(lon % 360.0, 4)

# ---- stars
stars = []
for f in get('stars.8.json')['features']:
    mag = f['properties']['mag']
    if mag is None or mag > args.maglim:
        continue
    try:
        bv = int(round(float(f['properties']['bv']) * 1000))
        bv = max(-1000, min(4000, bv))
    except (TypeError, ValueError):
        bv = 32767
    lon, lat = f['geometry']['coordinates']
    stars.append((float(mag), lon % 360.0, float(lat), bv, int(f['id'])))
stars.sort()
header = {'source': SOURCE, 'licence': LICENCE, 'built': today, 'count': len(stars), 'maglim': args.maglim, 'epoch': 'J2000',
          'record': 'float32 ra_deg, float32 dec_deg, int16 V*100, int16 (B-V)*1000 (32767 = unknown), uint32 HIP; little-endian, brightest first', 'recordBytes': 16}
hj = json.dumps(header).encode('ascii')
hj += b' ' * (-len(hj) % 4)
with open(os.path.join(out, 'stars.bin'), 'wb') as f:
    f.write(b'ESLS' + struct.pack('<I', len(hj)) + hj)
    for mag, ra, dec, bv, hip in stars:
        f.write(struct.pack('<ffhhI', ra, dec, int(round(mag * 100)), bv, hip))
print(f'stars.bin: {os.path.getsize(os.path.join(out, "stars.bin"))} bytes, {len(stars)} stars to V = {args.maglim}, {sum(1 for s in stars if s[0] <= 6.5)} to 6.5')

# ---- names: "Proper|designation" (Bayer letter or Flamsteed number with the constellation, else nothing)
keep = {s[4] for s in stars}
names = {}
clean = lambda s: (s or '').replace(' ', ' ').strip()
for hip, n in get('starnames.json').items():
    if int(hip) not in keep:
        continue
    proper, con = clean(n.get('name')), clean(n.get('c'))
    des = clean(n.get('bayer')) or clean(n.get('flam')) or clean(n.get('var'))
    des = (des + ' ' + con).strip() if des else ''
    if proper or des:
        names[hip] = proper + '|' + des
write_json('starnames.json', {'source': SOURCE, 'licence': LICENCE, 'built': today, 'format': 'hip: "proper name|designation"', 'names': names})

# ---- constellations
lines = {}
for f in get('constellations.lines.json')['features']:
    lines[f['id']] = [[c for lon, lat in seg for c in (ra_of(lon), round(lat, 4))] for seg in f['geometry']['coordinates']]
labels = []
for f in get('constellations.json')['features']:
    lon, lat = f['geometry']['coordinates']
    labels.append([f['id'], f['properties']['name'], ra_of(lon), round(lat, 3), int(f['properties'].get('rank') or 3)])
write_json('constellations.json', {'source': SOURCE, 'licence': LICENCE, 'built': today, 'epoch': 'J2000',
                                   'format': 'lines: id -> list of polylines [ra, dec, ra, dec, ...] in degrees; labels: [id, name, ra, dec, rank]', 'lines': lines, 'labels': labels})

# ---- exoplanet host stars, from the archive snapshot (positions as given by the archive, ICRS)
shards = sorted(glob.glob(os.path.join(ROOT, 'public', 'catalog', 'shard-*.json')))
if not shards:
    print('no public/catalog shards: hosts.json not written', file=sys.stderr)
else:
    with open(os.path.join(ROOT, 'public', 'catalog', 'index.json'), encoding='utf-8') as f:
        idx = json.load(f)
    hosts, skipped = [], 0
    for p in shards:
        with open(p, encoding='utf-8') as f:
            for h in json.load(f)['hosts']:
                sy = h.get('sy') or {}
                if sy.get('ra') is None or sy.get('dec') is None:
                    skipped += 1
                    continue
                v = sy.get('sy_vmag')
                hosts.append([h['n'], round(sy['ra'], 4), round(sy['dec'], 4), None if v is None else round(v, 2), len(h.get('pl') or [])])
    hosts.sort(key=lambda r: (r[3] is None, r[3] or 0))
    write_json('hosts.json', {'source': idx.get('source', 'NASA Exoplanet Archive') + ', via public/catalog (tools/build_catalog.py)', 'catalogDate': idx.get('date'), 'built': today,
                              'format': '[host name, ra_deg, dec_deg, V magnitude or null, number of planets], brightest first', 'hosts': hosts})
    print(f'{len(hosts)} hosts, {skipped} without a position, {sum(1 for r in hosts if r[3] is None)} without V')
