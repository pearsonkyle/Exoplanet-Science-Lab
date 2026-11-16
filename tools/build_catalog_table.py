#!/usr/bin/env python
"""Build the browsing tables of the Search and Plan pages from the NASA Exoplanet Archive.

  public/catalog-table/nea.json   one row per planet: the archive's composite table (pscomppars), where each value
                                  carries its own reference, plus the best-timed ephemeris pair from the `ps` table
  public/catalog-table/toi.json   TESS Objects of Interest (the archive's `toi` table)

The per-reference snapshot under public/catalog/ (tools/build_catalog.py) stays the source for the detail panel
and the analyzer; these tables exist because a browser should not fetch 133 shards to list 6,000 planets.

Ephemeris pair. pscomppars may take the period from one paper and the mid-transit time from another, and the
uncertainty of a predicted transit only means something for a pair fitted together. So for every planet the `ps`
rows that give P, sigma_P, T0 and sigma_T0 (none of them flagged as limits) are ranked by the predicted
uncertainty today, sqrt(sigma_T0^2 + (N sigma_P)^2) with N = (today - T0) / P, and the smallest one is stored as
eph_per / eph_tmid with its reference. The ranking trusts the quoted errors: a paper with optimistic errors wins.

Snapshot format (read by src/core/sources/snapshot.js), units as the archive gives them:
  { v, source, table, url, date, nrows, columns: [[name, kind], ...], refs: [[label, url], ...], strs: [...], rows: [[cell, ...], ...] }
  kind 'q' quantity: cell = value | [value, err1, err2] | [value, err1, err2, ref index] | [value, err1, err2, ref, lim]
  kind 's' string:   cell = index into strs      kind 'n' plain number or string as is.   Trailing nulls are dropped.

Usage: python tools/build_catalog_table.py [--out public/catalog-table] [--cache DIR]
Needs requests, pandas, numpy.
"""
import argparse, datetime, html, io, json, math, os, re, sys, urllib.parse

import numpy as np
import pandas as pd
import requests

TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'

# pscomppars quantities: value, err1, err2, lim, reflink
PC_Q = ['pl_orbper', 'pl_tranmid', 'pl_trandur', 'pl_trandep', 'pl_ratror', 'pl_ratdor', 'pl_imppar', 'pl_orbincl', 'pl_orbeccen',
        'pl_orblper', 'pl_rvamp', 'pl_bmassj', 'pl_radj', 'pl_eqt', 'pl_orbsmax', 'pl_insol',
        'st_teff', 'st_rad', 'st_mass', 'st_logg', 'st_met', 'st_lum']
PC_N = ['ra', 'dec', 'sy_dist', 'sy_vmag', 'sy_gaiamag', 'sy_tmag', 'sy_jmag', 'sy_kmag', 'disc_year',
        'tran_flag', 'rv_flag', 'ttv_flag', 'pl_controv_flag', 'cb_flag', 'sy_pnum', 'sy_snum']
PC_NAMES = ['pl_name', 'hostname', 'hd_name', 'hip_name', 'tic_id', 'gaia_dr3_id']
PC_S = ['discoverymethod', 'disc_facility', 'st_spectype', 'pl_bmassprov', 'pl_tranmid_systemref']

TOI_Q = ['pl_orbper', 'pl_tranmid', 'pl_trandurh', 'pl_trandep', 'pl_rade', 'st_teff', 'st_rad', 'st_logg', 'st_dist', 'st_tmag']
TOI_N = ['toi', 'tid', 'pl_pnum', 'ra', 'dec', 'pl_insol', 'pl_eqt', 'toi_created', 'rowupdate']
TOI_S = ['tfopwg_disp']

ANCHOR = re.compile(r'<a\s+[^>]*?href=(\S+?)(?:\s[^>]*)?>\s*(.*?)\s*</a>', re.S | re.I)


def tap(query, timeout=(20, 900)):
    r = requests.get(TAP + '?query=' + urllib.parse.quote(query) + '&format=csv', timeout=timeout)
    r.raise_for_status()
    if r.text.lstrip().startswith('<'):
        sys.exit('TAP error: ' + r.text[:400])
    return r.text


def fetch(name, query, cache):
    path = cache and os.path.join(cache, name + '.csv')
    if path and os.path.exists(path):
        return pd.read_csv(path, low_memory=False)
    text = tap(query)
    if path:
        open(path, 'w').write(text)
    return pd.read_csv(io.StringIO(text), low_memory=False)


def parse_ref(s):
    """'<a refstr=X href=URL target=ref> Pont et al. 2009 </a>' -> ('Pont et al. 2009', URL)."""
    if not isinstance(s, str) or not s.strip():
        return None
    m = ANCHOR.search(s)
    if m:
        url = html.unescape(m.group(1).strip('"\''))
        label = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', m.group(2)))).strip()
        return (label, url if url.startswith('http') else '')
    return (re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', s))).strip(), '')


def num(x):
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return int(f) if f == int(f) and abs(f) < 1e15 else f


class Table:
    def __init__(self):
        self.refs, self.strs = {}, {}

    def ref(self, s):
        p = parse_ref(s) if isinstance(s, str) else None
        if not p or not p[0]:
            return None
        return self.refs.setdefault(p, len(self.refs))

    def s(self, x):
        if not isinstance(x, str) or not x.strip():
            return None
        return self.strs.setdefault(x.strip(), len(self.strs))

    def q(self, v, e1=None, e2=None, ref=None, lim=None):
        v, e1, e2, lim = num(v), num(e1), num(e2), num(lim)
        if v is None:
            return None
        cell = [v, e1, e2, ref, lim if lim else None]
        while cell and cell[-1] is None:
            cell.pop()
        return cell[0] if len(cell) == 1 else cell


def trim(row):
    while row and row[-1] is None:
        row.pop()
    return row


def dump(o):
    return json.dumps(o, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def best_ephemeris(ps, jd_now):
    """planet -> (P, sP, T0, sT0, refname, tsys, predicted sigma today [d]) from the ps rows; see the module docstring."""
    d = ps.copy()
    for c in ('pl_orbper', 'pl_tranmid'):
        d[c + '_e'] = (d[c + 'err1'].abs() + d[c + 'err2'].abs()) / 2
        d[c + '_e'] = d[c + '_e'].fillna(d[c + 'err1'].abs()).fillna(d[c + 'err2'].abs())
    ok = (d.pl_orbper > 0) & (d.pl_orbper_e > 0) & (d.pl_tranmid > 2.4e6) & (d.pl_tranmid_e > 0)
    ok &= d.pl_orbperlim.fillna(0).eq(0) & d.pl_tranmidlim.fillna(0).eq(0)
    # a row whose period is more than 1% from the median of that planet's rows belongs to another planet (ExoFOP rows
    # attached to a sibling: HD 106315 c with 1221 d instead of 21.06 d); drop it
    med = d[ok].groupby('pl_name').pl_orbper.transform('median')
    ok &= ~((d.pl_orbper / med - 1).abs() > 0.01).reindex(d.index, fill_value=False)
    d = d[ok].copy()
    n = (jd_now - d.pl_tranmid) / d.pl_orbper
    d['sig'] = np.hypot(d.pl_tranmid_e, n * d.pl_orbper_e)
    d = d.sort_values(['pl_name', 'sig', 'pl_pubdate'], ascending=[True, True, False], kind='stable')
    out = {}
    for r in d.drop_duplicates('pl_name').itertuples(index=False):
        out[r.pl_name] = r
    return out


def default_ephemeris(ps):
    """planet -> the archive's default `ps` row (default_flag = 1) when it gives both a period and a mid-transit time (neither a limit)."""
    d = ps[(ps.default_flag == 1) & (ps.pl_orbper > 0) & (ps.pl_tranmid > 2.4e6) & ps.pl_orbperlim.fillna(0).eq(0) & ps.pl_tranmidlim.fillna(0).eq(0)]
    return {r.pl_name: r for r in d.drop_duplicates('pl_name').itertuples(index=False)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--out', default=os.path.join(here, '..', 'public', 'catalog-table'))
    ap.add_argument('--cache', help='folder for the downloaded CSVs (reused when present)')
    a = ap.parse_args()
    if a.cache:
        os.makedirs(a.cache, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    date = now.strftime('%Y-%m-%d')
    jd_now = now.timestamp() / 86400 + 2440587.5

    # ---------------------------------------------------------------- planets
    cols = list(PC_NAMES) + PC_S + PC_N
    for c in PC_Q:
        cols += [c, c + 'err1', c + 'err2', c + 'lim', c + '_reflink']
    pc = fetch('pscomppars', 'select ' + ','.join(cols) + ' from pscomppars', a.cache)
    ps = fetch('ps_ephem', 'select pl_name,pl_orbper,pl_orbpererr1,pl_orbpererr2,pl_orbperlim,pl_tranmid,pl_tranmiderr1,pl_tranmiderr2,'
               'pl_tranmidlim,pl_tsystemref,pl_refname,pl_pubdate,default_flag from ps', a.cache)
    print(f'pscomppars {len(pc)} rows; ps {len(ps)} rows')
    if len(pc) < 5000:
        sys.exit('suspiciously few planets; not writing a snapshot')
    eph = best_ephemeris(ps, jd_now)
    deph = default_ephemeris(ps)

    t = Table()
    columns = [[c, 'n'] for c in PC_NAMES] + [[c, 's'] for c in PC_S] + [[c, 'n'] for c in PC_N] + [[c, 'q'] for c in PC_Q] + \
              [['eph_per', 'q'], ['eph_tmid', 'q'], ['eph_tsys', 's'], ['eph_nrefs', 'n'], ['def_per', 'q'], ['def_tmid', 'q'], ['def_tsys', 's']]
    nref = ps[(ps.pl_orbper > 0) & (ps.pl_tranmid > 0)].groupby('pl_name').pl_refname.nunique()
    rows = []
    pc = pc.sort_values('pl_name', key=lambda s: s.str.lower(), kind='stable')
    for r in pc.itertuples(index=False):
        row = [getattr(r, c) if isinstance(getattr(r, c), str) else None for c in PC_NAMES]
        row += [t.s(getattr(r, c)) for c in PC_S]
        row += [num(getattr(r, c)) for c in PC_N]
        for c in PC_Q:
            row.append(t.q(getattr(r, c), getattr(r, c + 'err1'), getattr(r, c + 'err2'), t.ref(getattr(r, c + '_reflink')), getattr(r, c + 'lim')))
        e = eph.get(r.pl_name)
        if e is not None:
            ref = t.ref(e.pl_refname)
            row += [t.q(e.pl_orbper, e.pl_orbpererr1, e.pl_orbpererr2, ref), t.q(e.pl_tranmid, e.pl_tranmiderr1, e.pl_tranmiderr2, ref),
                    t.s(e.pl_tsystemref), num(nref.get(r.pl_name))]
        else:
            row += [None, None, None, None]
        e = deph.get(r.pl_name)
        if e is not None:
            ref = t.ref(e.pl_refname)
            row += [t.q(e.pl_orbper, e.pl_orbpererr1, e.pl_orbpererr2, ref), t.q(e.pl_tranmid, e.pl_tranmiderr1, e.pl_tranmiderr2, ref), t.s(e.pl_tsystemref)]
        rows.append(trim(row))
    out = dump({'v': 1, 'source': 'NASA Exoplanet Archive', 'table': 'pscomppars (composite parameters) + best ephemeris pair from ps',
                'url': TAP, 'date': date, 'nrows': len(rows), 'neph': len(eph), 'ndef': len(deph), 'columns': columns,
                'refs': [list(k) for k in t.refs], 'strs': list(t.strs), 'rows': rows})
    open(os.path.join(a.out, 'nea.json'), 'w', encoding='utf-8').write(out)
    ntr = int((pc.tran_flag == 1).sum())
    print(f'nea.json: {len(rows)} planets ({ntr} transiting), {len(eph)} with a paired ephemeris, {len(deph)} with a default-row ephemeris, {len(t.refs)} references, {len(out.encode()) / 1e6:.2f} MB')

    # ---------------------------------------------------------------- TOIs
    cols = TOI_N + TOI_S
    for c in TOI_Q:
        cols += [c, c + 'err1', c + 'err2']
    toi = fetch('toi', 'select ' + ','.join(cols) + ' from toi', a.cache)
    if len(toi) < 5000:
        sys.exit('suspiciously few TOIs; not writing a snapshot')
    toi = toi.sort_values('toi', kind='stable')
    t = Table()
    columns = [[c, 'n'] for c in TOI_N] + [[c, 's'] for c in TOI_S] + [[c, 'q'] for c in TOI_Q]
    rows = []
    for r in toi.itertuples(index=False):
        row = [getattr(r, c) if isinstance(getattr(r, c), str) else num(getattr(r, c)) for c in TOI_N]
        # dates as YYYY-MM-DD
        for k, c in enumerate(TOI_N):
            if c in ('toi_created', 'rowupdate') and isinstance(row[k], str):
                row[k] = row[k][:10]
        row += [t.s(getattr(r, c)) for c in TOI_S]
        row += [t.q(getattr(r, c), getattr(r, c + 'err1'), getattr(r, c + 'err2')) for c in TOI_Q]
        rows.append(trim(row))
    out = dump({'v': 1, 'source': 'NASA Exoplanet Archive', 'table': 'toi (TESS Objects of Interest, from ExoFOP-TESS)', 'url': TAP, 'date': date,
                'nrows': len(rows), 'columns': columns, 'refs': [], 'strs': list(t.strs), 'rows': rows})
    open(os.path.join(a.out, 'toi.json'), 'w', encoding='utf-8').write(out)
    print(f'toi.json: {len(rows)} TOIs, dispositions {toi.tfopwg_disp.value_counts(dropna=False).to_dict()}, {len(out.encode()) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
