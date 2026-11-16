#!/usr/bin/env python3
# Builds the static data of the sky view (observe/) under public/sky/. Standard library only.
#
#   python3 tools/build_sky_data.py [--cache DIR] [--maglim 8.0] [--only hosts]
#   (--only hosts rewrites hosts.json alone, without downloading the star data)
#
# Sources
#   Stars, star names, constellation lines and names: the data folder of d3-celestial by Olaf Frohn,
#     https://github.com/ofrohn/d3-celestial (BSD 3-Clause, copyright (c) 2015 Olaf Frohn). Its stars come from
#     XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012, VizieR V/137D); positions are J2000,
#     magnitudes are V, colours are B-V.
#   Exoplanet host stars: the snapshot of the NASA Exoplanet Archive already in public/catalog (tools/build_catalog.py);
#     their planets' discovery methods from the composite-table snapshot public/catalog-table/nea.json (discoverymethod,
#     disc_year), grouped as in src/sky/discovery.js (test/discovery.test.mjs checks that both agree).
#   TESS candidates: the TOI snapshot public/catalog-table/toi.json (the archive's `toi` table, from ExoFOP-TESS), the
#     TOIs whose TFOPWG disposition is PC or APC (or none): CP and KP are planets already in the archive's list, FP and
#     FA are not planets. A candidate on a star that already has confirmed planets (same TIC as the archive's tic_id)
#     is added to that star, unless its period is within 1% of one the archive gives (composite, best-timed pair or
#     default set) for one of the star's confirmed planets (then it is that planet under its TOI name and is dropped);
#     the others are stars of their own, named TOI-<number>.
#
# Outputs
#   stars.bin            'ESLS', uint32 length of a JSON header, the header (source, licence, record layout), padding
#                        to 4 bytes, then one 16-byte little-endian record per star, brightest first:
#                        float32 ra_deg, float32 dec_deg, int16 V*100, int16 (B-V)*1000 (32767 = unknown), uint32 HIP
#   starnames.json       { hip: "Proper name|designation" } for the stars that have either
#   constellations.json  line strings [ra, dec, ra, dec, ...] and label positions, J2000 degrees
#   hosts.json           [name, ra_deg, dec_deg, V or null, number of planets, discovery groups(, candidates)] per host
#                        star; the groups are letters t (transit), r (radial velocity), i (imaging), m (microlensing),
#                        o (other), the one that found most of its planets first (a tie: the one with the earliest
#                        planet), then c when the star has TESS candidates; '' if unknown. candidates (only on stars
#                        that have some): [TESS magnitude, TIC number, [[TOI, period d, its error, epoch BJD_TDB, its
#                        error, duration h, depth ppm, disposition], ...]] (null where not given; errors to 2 digits).
#                        Brightest first, by V, else by T.
import argparse, json, os, struct, sys, urllib.request, glob, datetime

BASE = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/'
FILES = ['stars.8.json', 'starnames.json', 'constellations.lines.json', 'constellations.json']
SOURCE = 'd3-celestial data (https://github.com/ofrohn/d3-celestial), from XHIP (Anderson & Francis 2012, VizieR V/137D)'
LICENCE = 'BSD 3-Clause, copyright (c) 2015 Olaf Frohn'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument('--cache', default=os.path.join(os.environ.get('TMPDIR', '/tmp'), 'esl-sky-cache'))
ap.add_argument('--maglim', type=float, default=8.0)
ap.add_argument('--only', choices=['all', 'hosts'], default='all')
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

if args.only != 'hosts':
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
    # discovery method of each planet, by host: the composite table (one row per planet)
    GROUP = {'transit': 't', 'radial velocity': 'r', 'imaging': 'i', 'microlensing': 'm'}
    by_host = {}
    nea_path = os.path.join(ROOT, 'public', 'catalog-table', 'nea.json')
    if os.path.exists(nea_path):
        with open(nea_path, encoding='utf-8') as f:
            nea = json.load(f)
        col = {c[0]: i for i, c in enumerate(nea['columns'])}
        for r in nea['rows']:
            m = r[col['discoverymethod']] if col['discoverymethod'] < len(r) else None
            m = nea['strs'][m] if isinstance(m, int) else (m or '')
            y = r[col['disc_year']] if col['disc_year'] < len(r) else None
            g = GROUP.get(m.strip().lower(), 'o' if m.strip() else '')
            if g:
                by_host.setdefault(r[col['hostname']], []).append((g, y if isinstance(y, (int, float)) else 9999))
    else:
        print('no public/catalog-table/nea.json: hosts.json without discovery methods', file=sys.stderr)

    def groups_of(name):
        pl = by_host.get(name) or []
        count = {g: sum(1 for x in pl if x[0] == g) for g in 'trimo'}
        first = {g: min([x[1] for x in pl if x[0] == g] or [9999]) for g in 'trimo'}
        return ''.join(sorted((g for g in 'trimo' if count[g]), key=lambda g: (-count[g], first[g], 'trimo'.index(g))))

    # the planets' periods by host and the hosts' TIC numbers, to place the TESS candidates
    tic_host, periods = {}, {}
    if os.path.exists(nea_path):
        q = lambda v: v[0] if isinstance(v, list) else v
        for r in nea['rows']:
            h = r[col['hostname']]
            tic = r[col['tic_id']] if col['tic_id'] < len(r) else None
            tic = nea['strs'][tic] if isinstance(tic, int) and nea['columns'][col['tic_id']][1] == 's' else tic
            if tic:
                try: tic_host[int(str(tic).replace('TIC', '').strip())] = h
                except ValueError: pass
            # every period the archive gives the planet (composite, best-timed pair, default set): one may be another planet's
            # a best-timed or default period more than 1% from the composite one is another planet's (src/core/sources/nea.js
            # ignores it the same way), so it is not used to match candidates either
            p0 = q(r[col['pl_orbper']]) if 'pl_orbper' in col and col['pl_orbper'] < len(r) else None
            for k in ('pl_orbper', 'eph_per', 'def_per'):
                p = q(r[col[k]]) if k in col and col[k] < len(r) else None
                if not (isinstance(p, (int, float)) and p > 0): continue
                if k != 'pl_orbper' and isinstance(p0, (int, float)) and p0 > 0 and abs(p / p0 - 1) > 0.01: continue
                periods.setdefault(h, []).append(p)

    # TESS candidates (PC, APC, no disposition) by TIC
    cand, cand_meta, dropped = {}, {}, {'known': 0, 'not_candidate': 0, 'no_position': 0, 'same_period': 0}
    toi_path = os.path.join(ROOT, 'public', 'catalog-table', 'toi.json')
    if os.path.exists(toi_path):
        with open(toi_path, encoding='utf-8') as f:
            toi = json.load(f)
        tc = {c[0]: i for i, c in enumerate(toi['columns'])}
        cell = lambda r, k: r[tc[k]] if tc[k] < len(r) else None
        val = lambda v: (v[0] if isinstance(v, list) else v) if isinstance(v, (list, int, float)) else None
        def err(v):
            if not isinstance(v, list) or len(v) < 3: return None
            e = [abs(x) for x in v[1:3] if isinstance(x, (int, float))]
            return float('%.2g' % (sum(e) / len(e))) if e else None
        rnd = lambda x, n: None if x is None else round(x, n)
        for r in toi['rows']:
            d = cell(r, 'tfopwg_disp'); d = toi['strs'][d] if isinstance(d, int) else (d or '')
            if d in ('CP', 'KP'): dropped['known'] += 1; continue
            if d not in ('PC', 'APC', ''): dropped['not_candidate'] += 1; continue
            ra, dec, tic = cell(r, 'ra'), cell(r, 'dec'), cell(r, 'tid')
            if ra is None or dec is None or tic is None: dropped['no_position'] += 1; continue
            per = val(cell(r, 'pl_orbper')); per = per if isinstance(per, (int, float)) and per > 0 else None
            host = tic_host.get(int(tic))
            if host and per and any(abs(per - p) / p < 0.01 for p in periods.get(host, [])): dropped['same_period'] += 1; continue
            label = 'TOI-%.2f' % cell(r, 'toi')
            dep = val(cell(r, 'pl_trandep'))
            cand.setdefault(int(tic), []).append([label, rnd(per, 7), err(cell(r, 'pl_orbper')), rnd(val(cell(r, 'pl_tranmid')), 5), err(cell(r, 'pl_tranmid')),
                                                  rnd(val(cell(r, 'pl_trandurh')), 3), None if dep is None else int(round(dep)), d or None])
            tm = val(cell(r, 'st_tmag'))
            cand_meta[int(tic)] = (round(ra, 4), round(dec, 4), None if tm is None else round(tm, 2), host, 'TOI-%d' % int(cell(r, 'toi')))
        print('TOI snapshot', toi.get('date'), ':', sum(len(v) for v in cand.values()), 'candidates on', len(cand), 'stars; left out:', dropped)
    else:
        print('no public/catalog-table/toi.json: hosts.json without TESS candidates', file=sys.stderr)

    hosts, skipped = [], 0
    for p in shards:
        with open(p, encoding='utf-8') as f:
            for h in json.load(f)['hosts']:
                sy = h.get('sy') or {}
                if sy.get('ra') is None or sy.get('dec') is None:
                    skipped += 1
                    continue
                v = sy.get('sy_vmag')
                hosts.append([h['n'], round(sy['ra'], 4), round(sy['dec'], 4), None if v is None else round(v, 2), len(h.get('pl') or []), groups_of(h['n'])])
    by_name = {r[0]: r for r in hosts}
    on_known, own = 0, 0
    for tic, cs in cand.items():
        ra, dec, tm, host, toi_host = cand_meta[tic]
        cs.sort()
        extra = [tm, tic, cs]
        if host and host in by_name:
            row = by_name[host]; row[5] = row[5] + 'c'; row.append(extra); on_known += 1
        else:
            hosts.append([toi_host, ra, dec, None, 0, 'c', extra]); own += 1
    mag = lambda r: r[3] if r[3] is not None else (r[6][0] if len(r) > 6 else None)
    hosts.sort(key=lambda r: (mag(r) is None, mag(r) or 0, r[0]))
    write_json('hosts.json', {'source': idx.get('source', 'NASA Exoplanet Archive') + ', via public/catalog (tools/build_catalog.py); TESS candidates: the archive\'s toi table (ExoFOP-TESS), via public/catalog-table/toi.json',
                              'catalogDate': idx.get('date'), 'toiDate': toi.get('date') if cand else None, 'built': today,
                              'format': '[host name, ra_deg, dec_deg, V magnitude or null, number of confirmed planets, discovery groups, (candidates)], brightest first (V, else TESS T); groups: t transit, r radial velocity, i imaging, m microlensing, o other (TTV, astrometry, timing, ...), the one that found most planets first, then c (TESS candidates); candidates: [TESS magnitude, TIC, [[TOI, period d, error, epoch BJD_TDB, error, duration h, depth ppm, TFOPWG disposition]]]', 'hosts': hosts})
    print(f'{len(hosts)} hosts, {skipped} without a position, {sum(1 for r in hosts if r[3] is None)} without V, {sum(1 for r in hosts if not r[5])} without a discovery method')
    print(f'TESS candidates: {own} stars of their own, {on_known} stars with confirmed planets too')
    print('hosts coloured by:', {g: sum(1 for r in hosts if r[5][:1] == g) for g in 'trimoc'}, 'with the group at all:', {g: sum(1 for r in hosts if g in r[5]) for g in 'trimoc'}, 'mixed:', sum(1 for r in hosts if len(r[5]) > 1))
