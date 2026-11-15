#!/usr/bin/env python
"""Build the static system-parameter catalogue under public/catalog/ from the NASA Exoplanet Archive.

Why a snapshot: the archive's TAP service sends no CORS headers, so a browser cannot query it. This script
downloads the `ps` table (Planetary Systems: one row per planet per published reference, NOT only the
default_flag = 1 row) and writes

  public/catalog/index.json      names -> shard, for autocomplete and lookup (small, loaded once)
  public/catalog/shard-NNN.json  all rows of a group of hosts (one lookup fetches one of these)

Reader: src/core/catalog.js (`loadIndex`, `lookupHost`). The formats are described there and below.

Usage:  python tools/build_catalog.py [--out public/catalog] [--target-kb 110] [--csv cached.csv]
Needs requests, pandas, numpy.

Shard layout (compact: row arrays, trailing nulls dropped, columns ordered so the often-empty ones come last):
  { v, columns: [...], lim: [...], refs: [[label, url], ...], strs: [...],
    hosts: [ { n: hostname, sy: {ra, dec, sy_dist, ...}, pl: [planet names], r: [[...row...], ...] } ] }
  row[i] belongs to columns[i]. 'pl' indexes host.pl, 'pl_ref'/'st_ref' index refs, 'soltype',
  'pl_bmassprov', 'pl_tsystemref' index strs, 'lim' is a bit mask over the `lim` list (bit k set = the archive's
  <lim[k]>lim flag is non-zero, i.e. the value is an upper or lower limit, not a measurement).
Units are the archive's: pl_trandur in hours, pl_trandep in percent, pl_orbsmax in au, st_dens in g/cm^3,
pl_rvamp in m/s, pl_bmassj in Jupiter masses, angles in degrees, pl_tranmid in days (see pl_tsystemref).
"""
import argparse, datetime, html, io, json, math, os, re, sys, urllib.parse

import numpy as np
import pandas as pd
import requests

TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'

# value columns that come with err1 / err2 (and a lim flag) in the ps table
WITH_ERR = ['pl_orbper', 'pl_tranmid', 'pl_orbsmax', 'pl_ratdor', 'pl_ratror', 'pl_trandep', 'pl_trandur', 'pl_imppar',
            'pl_orbincl', 'pl_orbeccen', 'pl_orblper', 'pl_orbtper', 'pl_rvamp', 'pl_bmassj', 'pl_msinij', 'pl_radj', 'pl_eqt',
            'st_teff', 'st_logg', 'st_met', 'st_mass', 'st_rad', 'st_dens']
# per-row columns kept as they are (flags) or through a string table
FLAGS = ['default_flag', 'tran_flag', 'rv_flag', 'ttv_flag', 'pl_controv_flag']
STRS = ['soltype', 'pl_bmassprov', 'pl_tsystemref']
# system-level columns: identical for every row of a host in practice, stored once per host
SYSTEM = ['ra', 'dec', 'sy_dist', 'sy_disterr1', 'sy_disterr2', 'sy_vmag', 'sy_gaiamag', 'sy_tmag', 'sy_kmag', 'sy_pmra', 'sy_pmdec',
          'sy_snum', 'sy_pnum']
ID = ['pl_name', 'hostname', 'pl_letter', 'hd_name', 'hip_name', 'tic_id', 'pl_refname', 'st_refname', 'pl_pubdate']


def normalize(s):
    """Same rule as normalizeName in src/core/catalog.js."""
    return re.sub(r'[^a-z0-9]', '', str(s).lower())


def tap(query, fmt='csv', timeout=(20, 900)):
    r = requests.get(TAP + '?query=' + urllib.parse.quote(query) + '&format=' + fmt, timeout=timeout)
    r.raise_for_status()
    return r.text


ANCHOR = re.compile(r'<a\s+[^>]*?href=(\S+?)(?:\s[^>]*)?>\s*(.*?)\s*</a>', re.S | re.I)


def parse_ref(s):
    """'<a refstr=X href=URL target=ref> Pont et al. 2009 </a>' -> ('Pont et al. 2009', URL)."""
    if not isinstance(s, str) or not s.strip():
        return ('', '')
    m = ANCHOR.search(s)
    if m:
        url = html.unescape(m.group(1).strip('"\''))
        label = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', m.group(2)))).strip()
        return (label, url if url.startswith('http') else '')
    return (re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', s))).strip(), '')


def num(x):
    """JSON-ready number: None for NaN, ints stay ints, floats keep the archive's digits (shortest repr)."""
    if x is None:
        return None
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
    ap.add_argument('--out', default=os.path.join(here, '..', 'public', 'catalog'))
    ap.add_argument('--target-kb', type=float, default=110, help='aim for shards of about this size')
    ap.add_argument('--csv', help='read this CSV instead of downloading (and write it if it does not exist)')
    a = ap.parse_args()

    # which of the wanted columns does the archive actually have?
    have = set(re.findall(r'[a-z_0-9]+', tap("select column_name from TAP_SCHEMA.columns where table_name like 'ps'")))
    want = list(ID) + FLAGS + STRS + SYSTEM
    for c in WITH_ERR:
        want += [c, c + 'err1', c + 'err2', c + 'lim']
    missing = [c for c in want if c not in have]
    if missing:
        print('not in the ps table, dropped:', missing)
    cols = [c for c in want if c in have]

    if a.csv and os.path.exists(a.csv):
        text = open(a.csv).read()
    else:
        print(f'downloading {len(cols)} columns of ps ...')
        text = tap('select ' + ','.join(cols) + ' from ps')
        if a.csv:
            open(a.csv, 'w').write(text)
    df = pd.read_csv(io.StringIO(text), low_memory=False)
    print(f'{len(df)} rows, {df.pl_name.nunique()} planets, {df.hostname.nunique()} hosts')
    if len(df) < 30000:
        sys.exit('suspiciously few rows; not writing a snapshot')

    val = [c for c in WITH_ERR if c in df]
    limcols = [c for c in val if c + 'lim' in df]
    numeric = []
    for c in val:
        numeric += [c] + [c + s for s in ('err1', 'err2') if c + s in df]
    # most-filled first, so that dropping trailing nulls saves the most
    numeric.sort(key=lambda c: -df[c].notna().mean())
    head = ['pl', 'pl_ref', 'st_ref', 'pl_pubdate'] + [c for c in FLAGS if c in df] + ['lim'] + [c for c in STRS if c in df]
    columns = head + numeric

    # newest first within a planet, the archive default first among equals
    df['_key'] = df.hostname.map(normalize)
    df = df.sort_values(['_key', 'pl_name', 'pl_pubdate', 'default_flag'], ascending=[True, True, False, False], kind='stable')

    hosts = []          # (name, key, record builder inputs)
    for hostname, g in df.groupby('hostname', sort=False):
        hosts.append((hostname, g))
    hosts.sort(key=lambda h: normalize(h[0]))

    def host_record(hostname, g, refs, strs):
        def ref_id(s):
            p = parse_ref(s)
            if p not in refs:
                refs[p] = len(refs)
            return refs[p]

        def str_id(s):
            if not isinstance(s, str) or not s:
                return None
            if s not in strs:
                strs[s] = len(strs)
            return strs[s]
        pl = list(dict.fromkeys(g.pl_name))
        d = g[g.default_flag == 1]
        sy = {}
        for c in SYSTEM:
            if c not in g:
                continue
            # the default row's value when it has one, otherwise the first row that does
            s = pd.concat([d[c], g[c]]).dropna()
            if len(s):
                sy[c] = num(s.iloc[0])
        rows = []
        for r in g.itertuples(index=False):
            lim = 0
            for k, c in enumerate(limcols):
                v = getattr(r, c + 'lim')
                if v == v and v != 0:
                    lim |= 1 << k
            row = [pl.index(r.pl_name), ref_id(r.pl_refname), ref_id(r.st_refname), r.pl_pubdate if isinstance(r.pl_pubdate, str) else None]
            row += [num(getattr(r, c)) for c in FLAGS if c in df] + [lim] + [str_id(getattr(r, c)) for c in STRS if c in df]
            row += [num(getattr(r, c)) for c in numeric]
            while row and row[-1] is None:
                row.pop()
            rows.append(row)
        return {'n': hostname, 'sy': sy, 'pl': pl, 'r': rows}

    dump = lambda o: json.dumps(o, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    os.makedirs(a.out, exist_ok=True)
    for f in os.listdir(a.out):
        if re.fullmatch(r'shard-\d+\.json', f):
            os.remove(os.path.join(a.out, f))

    # pack hosts (alphabetical by normalised name) into shards of about the target size
    target = a.target_kb * 1024
    shards, cur, size = [], [], 0
    for hostname, g in hosts:
        est = len(dump(host_record(hostname, g, {}, {})))
        if cur and size + est > target:
            shards.append(cur); cur, size = [], 0
        cur.append((hostname, g)); size += est
    if cur:
        shards.append(cur)

    index_hosts, index_planets, total, sizes = [], [], 0, []
    for sid, members in enumerate(shards):
        refs, strs = {}, {}
        recs = []
        for hostname, g in members:
            recs.append(host_record(hostname, g, refs, strs))
            first = g.iloc[0]
            aliases = [str(first[c]) for c in ('hd_name', 'hip_name', 'tic_id') if c in g and isinstance(first[c], str) and normalize(first[c]) != normalize(hostname)]
            hi = len(index_hosts)
            index_hosts.append([hostname, sid] + aliases)
            for p, gp in g.groupby('pl_name', sort=False):
                # flags for the autocomplete: bit 0 transiting, bit 1 has radial velocities
                index_planets.append([p, hi, int(gp.tran_flag.max() > 0) | (int(gp.rv_flag.max() > 0) << 1)])
        out = dump({'v': 1, 'columns': columns, 'lim': limcols, 'refs': [list(k) for k in refs], 'strs': list(strs), 'hosts': recs})
        with open(os.path.join(a.out, f'shard-{sid:03d}.json'), 'w', encoding='utf-8') as f:
            f.write(out)
        sizes.append(len(out.encode())); total += len(out.encode())

    index = {
        'v': 1, 'source': 'NASA Exoplanet Archive, Planetary Systems (ps) table, all references', 'url': TAP,
        'date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'),
        'rows': int(len(df)), 'nplanets': len(index_planets), 'nhosts': len(index_hosts), 'nshards': len(shards),
        'shard': 'shard-{id}.json',                         # id zero-padded to 3 digits
        'hosts': index_hosts,                                # [hostname, shard, alias, alias, ...]
        'planets': index_planets,                            # [planet name, index into hosts, flags]
    }
    s = dump(index)
    with open(os.path.join(a.out, 'index.json'), 'w', encoding='utf-8') as f:
        f.write(s)
    print(f'index.json {len(s.encode()) / 1024:.0f} kB; {len(shards)} shards, {total / 1e6:.2f} MB in total, '
          f'median {np.median(sizes) / 1024:.0f} kB, largest {max(sizes) / 1024:.0f} kB; snapshot {index["date"]}')


if __name__ == '__main__':
    main()
