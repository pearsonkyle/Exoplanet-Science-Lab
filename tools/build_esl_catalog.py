#!/usr/bin/env python
"""Build the ESL catalogue: one versioned, offline copy of the NASA Exoplanet Archive and exoplanet.eu, merged,
with gap-filled estimates and suggested priors for every planet.

    .venv-plan/bin/python tools/build_esl_catalog.py                  # download the three snapshots, then merge
    .venv-plan/bin/python tools/build_esl_catalog.py --no-download    # merge the snapshots already under public/
    .venv-plan/bin/python tools/build_esl_catalog.py --check          # verify public/esl-catalog against its manifest

Steps (each one a subprocess, stopped at the first failure):
  1  tools/build_catalog.py        -> public/catalog/        every published reference per planet (archive `ps` table)
  2  tools/build_catalog_table.py  -> public/catalog-table/  one row per planet (pscomppars) and the TOI table
  3  tools/build_catalog_eu.py     -> public/catalog-eu/     exoplanet.eu
  4  tools/merge_esl_catalog.mjs   -> public/esl-catalog/catalog.json   (Node 22; imports the site's own
     src/core/sources/index.js and src/core/catalog.js, so the merge, the reference selection and the priors are
     the ones the pages use, not a second implementation)
  5  this script                   -> public/esl-catalog/manifest.json  (versions, snapshot dates, counts, sizes,
     SHA-256 checksums, licences and acknowledgements, schema)

--no-download skips 1 to 3. --cache DIR is handed to the builders (as --csv DIR/ps.csv, --cache DIR,
--csv DIR/exoplanet_eu.csv): they REUSE any CSV already there, so use a fresh folder to get fresh data. Without
--cache a temporary folder is used and removed.

The merge depends only on its inputs, so running it twice gives the same catalog.json byte for byte; manifest.json
additionally carries the build date (UTC). Reader: src/core/sources/eslcatalog.js. Test: node test/eslcatalog.test.mjs.

Needs: Python 3.10+ (requests, pandas, numpy for steps 1 to 3; the standard library for the rest), Node 22,
and the network for steps 1 to 3 only.
"""
import argparse, datetime, gzip, hashlib, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SCHEMA = {
    'reader': 'src/core/sources/eslcatalog.js: readEslCatalog(json).get(name) -> { values, errors, src, ref, refUrl, lim, est, priors, priorsFrom }',
    'units': 'days (times are JD as the catalogue gives them, normally BJD_TDB), depth as a fraction, Jupiter units for the planet, '
             'solar units for the star, a in au, angles in degrees, K in m/s, temperatures in K, distance in pc (src/core/sources/fields.js)',
    'tables': {
        'snapshots': '{ nea, eu, ps }: date each source snapshot was taken',
        'credits': '[{ id, label, url, licence, acknowledgement }]',
        'sources': 'source ids; a planet\'s `c` is a bit mask over this list',
        'fields': '[[key, "n" number | "s" string, unit, description]]',
        'refs': '[[label, link]]; link is an ADS bibcode (https://ui.adsabs.harvard.edu/abs/<link>/abstract), a full URL or ""',
        'prov': '[[source index, ref index or -1]]: provenance of a value',
        'strs': 'interned strings: values of the string fields and notes of the estimates',
        'relations': '[[key, name, citation]]: the relations of src/core/relations.js used for estimates',
        'estInfo': '[[relation index, [field indices used], note index into strs or -1, chain 0|1 (built on another estimate)]]',
        'priorKeys': 'keys of suggestPriors (mplanet is the field `mass`)',
        'priorTypes': '["uniform", "normal"]',
        'priorWhy': '[[type index, why text]]',
        'bases': 'how the priors were made: transit | rv | all = systemFromRows(rows, {use}) on every published reference of the '
                 'NASA archive, centred on the chosen reference; merged = suggestPriors on the merged row (planets with no per-reference rows)',
    },
    'planet': {
        'n': 'name', 'h': 'host', 'c': 'bit mask over sources', 't': '1 when a catalogue lists transits',
        'a': 'names the other catalogues use, when different',
        'v': '[[prov, field, value, error, field, value, error, ...], ...] catalogue values grouped by provenance; error 0 = none, '
             'number = symmetric, [lower, upper]; for an "s" field the value indexes strs',
        'l': '[field, value, sign, source, ...] limits (not measurements; sign as the catalogue flags it)',
        'e': '[field, value, estInfo, ...] gap-filled estimates; never a field that has a catalogue value',
        'p': '[priorKey, a, b, priorWhy, ...]; uniform: a = min, b = max; normal: a = mean, b = std',
        'pb': '[basis, ref index of the reference chosen for the priors or -1, ref index of the stellar reference or -1]',
    },
    'rounding': 'periods, mid-transit times and their errors exactly as in the snapshots; other values 12 significant digits, '
                'errors 10; estimates and prior bounds 9 (priors on the period 15, on T_mid 16)',
    'oddities': 'neaNotInPs: planets of the composite table missing from the per-reference snapshot (priors then fall back to basis merged); '
                'chooseFailed: systemFromRows gave nothing for the planet (same fallback); emptyPriors: planets with no prior at all; '
                'nonFinitePriors / unusablePriors: priors suggestPriors returned that are not stored (not finite; uniform with min >= max or normal '
                'with zero width, from a catalogue value outside the physical range); duplicateNames: two rows with one name. Each: { n, first: up to 25 }',
    'notStored': 'the time-dependent `drift` column of buildTable, catalogue disagreements (`diff`), the match stage, '
                 'and the text explaining why a reference was chosen: recompute those with the site code from the snapshots',
}
TOI_NOTE = ('TESS Objects of Interest are not included: with them the file doubles (14.0 MB, 4.2 MB gzipped, measured '
            '2026-11-15 with `node tools/merge_esl_catalog.mjs --toi`), they are pipeline estimates with no reference, and '
            'public/catalog-table/toi.json already serves them offline. Pass --with-toi to include them.')


def run(cmd, what):
    print(f'\n--- {what}\n    {" ".join(cmd)}', flush=True)
    t = time.time()
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        sys.exit(f'{what} failed (exit code {r.returncode}); the ESL catalogue was not rebuilt')
    return time.time() - t


def describe(path):
    data = open(path, 'rb').read()
    return {'bytes': len(data), 'gzipBytes': len(gzip.compress(data, 9, mtime=0)), 'sha256': hashlib.sha256(data).hexdigest()}


def check(out):
    """Compare the files in `out` with manifest.json. Returns the number of problems."""
    mpath = os.path.join(out, 'manifest.json')
    if not os.path.exists(mpath):
        print('no manifest.json in', out)
        return 1
    man, bad = json.load(open(mpath)), 0
    for f in man['files']:
        p = os.path.join(out, f['name'])
        if not os.path.exists(p):
            print('missing', f['name']); bad += 1; continue
        d = describe(p)
        ok = d['bytes'] == f['bytes'] and d['sha256'] == f['sha256']
        print(('ok   ' if ok else 'FAIL ') + f'{f["name"]}  {d["bytes"]} bytes  sha256 {d["sha256"][:16]}...')
        bad += 0 if ok else 1
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--no-download', action='store_true', help='skip the three builders; merge the snapshots already under public/')
    ap.add_argument('--cache', help='folder for the downloaded CSVs, handed to the builders (files found there are reused)')
    ap.add_argument('--public', default=os.path.join(ROOT, 'public'), help='the site\'s public folder (snapshots are read from and written to it)')
    ap.add_argument('--out', help='output folder (default <public>/esl-catalog)')
    ap.add_argument('--node', default=os.environ.get('NODE', 'node'), help='Node executable (22 or later)')
    ap.add_argument('--with-toi', action='store_true', help='also include the TESS Objects of Interest (doubles the size)')
    ap.add_argument('--check', action='store_true', help='only verify the files against manifest.json')
    a = ap.parse_args()
    pub = os.path.abspath(a.public)
    out = os.path.abspath(a.out or os.path.join(pub, 'esl-catalog'))
    if a.check:
        sys.exit(1 if check(out) else 0)

    steps = []
    if not a.no_download:
        cache = a.cache or tempfile.mkdtemp(prefix='esl-catalog-')
        os.makedirs(cache, exist_ok=True)
        try:
            py = sys.executable
            for script, args, what in [
                ('build_catalog.py', ['--out', os.path.join(pub, 'catalog'), '--csv', os.path.join(cache, 'ps.csv')], 'NASA Exoplanet Archive, every reference (ps)'),
                ('build_catalog_table.py', ['--out', os.path.join(pub, 'catalog-table'), '--cache', cache], 'NASA Exoplanet Archive, composite table and TOIs'),
                ('build_catalog_eu.py', ['--out', os.path.join(pub, 'catalog-eu'), '--csv', os.path.join(cache, 'exoplanet_eu.csv')], 'exoplanet.eu'),
            ]:
                steps.append({'step': script, 'seconds': round(run([py, os.path.join(HERE, script)] + args, what), 1)})
        finally:
            if not a.cache:
                shutil.rmtree(cache, ignore_errors=True)

    os.makedirs(out, exist_ok=True)
    fd, stats_path = tempfile.mkstemp(prefix='esl-stats-', suffix='.json')
    os.close(fd)
    try:
        cmd = [a.node, os.path.join(HERE, 'merge_esl_catalog.mjs'), '--public', pub, '--out', out, '--stats', stats_path] + (['--toi'] if a.with_toi else [])
        steps.append({'step': 'merge_esl_catalog.mjs', 'seconds': round(run(cmd, 'merge (Node)'), 1)})
        stats = json.load(open(stats_path))
    finally:
        os.remove(stats_path)

    pkg = json.load(open(os.path.join(ROOT, 'package.json')))
    node_version = subprocess.run([a.node, '--version'], capture_output=True, text=True).stdout.strip()
    files = [{'name': stats['file'], 'description': 'the catalogue: dictionaries and one record per planet', **describe(os.path.join(out, stats['file']))}]
    c = stats['counts']
    manifest = {
        'format': stats['format'], 'formatVersion': stats['v'],
        'name': 'Exoplanet Science Lab catalogue',
        'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'software': {'name': pkg['name'], 'version': pkg['version'], 'homepage': pkg.get('homepage', ''),
                     'builder': 'tools/build_esl_catalog.py + tools/merge_esl_catalog.mjs', 'node': node_version, 'python': sys.version.split()[0]},
        'downloaded': not a.no_download,
        'snapshots': stats['snapshots'],
        'counts': {
            'planets': c['planets'], 'inNasaArchive': c['nea'], 'inExoplanetEu': c['eu'], 'matchedInBoth': c['both'],
            'nasaArchiveOnly': c['neaOnly'], 'exoplanetEuOnly': c['euOnly'], 'toi': c['toi'], 'transiting': c['transiting'],
            'withPriors': c['withPriors'], 'withEstimates': c['withEstimates'], 'withLimits': c['withLimits'],
            'values': c['values'], 'estimates': c['estimates'], 'priors': c['priors'],
            'priorsByBasis': c['priorsBasis'], 'estimatesByRelation': c['estimatesByRelation'],
            'matchStages': (c.get('match') or {}).get('byStage'), 'tables': c['tables'],
        },
        'oddities': stats['oddities'],
        'toi': 'included (--with-toi)' if a.with_toi else TOI_NOTE,
        'files': files,
        'licences': stats['credits'],
        'schema': SCHEMA,
        'steps': steps,
    }
    mpath = os.path.join(out, 'manifest.json')
    with open(mpath + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(mpath + '.tmp', mpath)

    print(f'\n{out}')
    for f in files:
        print(f'  {f["name"]:14s} {f["bytes"] / 1e6:6.2f} MB   {f["gzipBytes"] / 1e6:5.2f} MB gzipped   sha256 {f["sha256"]}')
    print(f'  manifest.json  {os.path.getsize(mpath) / 1e3:6.1f} kB')
    print(f'  {c["planets"]} planets: {c["both"]} in both catalogues, {c["neaOnly"]} NASA archive only, {c["euOnly"]} exoplanet.eu only; '
          f'{c["withPriors"]} with priors, {c["withEstimates"]} with at least one estimate')
    for k, v in stats['oddities'].items():
        if v['n']:
            print(f'  note: {k}: {v["n"]} ({", ".join(v["first"][:6])}{" ..." if v["n"] > 6 else ""})')


if __name__ == '__main__':
    main()
