# The reference for test/asteroids.test.mjs: osculating elements of the brightest asteroids from the JPL Small-Body
# Database (the values bundled in src/core/asteroids.js are copied from its printout) and their geocentric
# astrometric RA and Dec (ICRF) and visual magnitude from JPL Horizons at a few dates around the epoch of the elements.
#   .venv/bin/python test/make_asteroid_reference.py        (needs the network; writes test/asteroid_reference.json)
# Horizons integrates the full solar system (DE441 and the big perturbers); the two-body propagation of the app does
# not, so the difference grows with the time from the epoch: that growth is what the test measures.
import json, os, urllib.parse, urllib.request, datetime

NUMBERS = [1, 2, 3, 4, 6, 7, 10, 15]          # Ceres, Pallas, Juno, Vesta, Hebe, Iris, Hygiea, Eunomia
JDS = [2461000.5, 2461200.5, 2461360.5, 2461420.5, 2461565.5]   # 2025-11-21, the SBDB epoch (2026-06-09), 2026-11-16, 2027-01-15, 2027-06-09 (00:00 UT)

def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode())

out = {'made': datetime.date.today().isoformat(), 'sbdb': 'https://ssd-api.jpl.nasa.gov/sbdb.api', 'horizons': 'https://ssd.jpl.nasa.gov/api/horizons.api',
       'note': 'Horizons OBSERVER table, CENTER 500@399 (geocentre), QUANTITIES 1 (astrometric RA, Dec, ICRF), 9 (APmag), 19 (r), 20 (delta); times UT', 'objects': []}
for n in NUMBERS:
    s = get('https://ssd-api.jpl.nasa.gov/sbdb.api?' + urllib.parse.urlencode({'sstr': str(n), 'phys-par': '1', 'full-prec': '1'}))
    el = {e['name']: float(e['value']) for e in s['orbit']['elements'] if e['value'] is not None}
    phys = {p['name']: p['value'] for p in s.get('phys_par', [])}
    H = float(phys['H']); G = float(phys['G']) if phys.get('G') else 0.15
    params = {'format': 'json', 'COMMAND': "'%d;'" % n, 'OBJ_DATA': 'NO', 'MAKE_EPHEM': 'YES', 'EPHEM_TYPE': 'OBSERVER', 'CENTER': "'500@399'",
              'TLIST': ' '.join("'%s'" % j for j in JDS), 'TLIST_TYPE': 'JD', 'QUANTITIES': "'1,9,19,20'", 'ANG_FORMAT': 'DEG', 'CSV_FORMAT': 'YES', 'EXTRA_PREC': 'YES'}
    h = get('https://ssd.jpl.nasa.gov/api/horizons.api?' + urllib.parse.urlencode(params))['result']
    body = h.split('$$SOE')[1].split('$$EOE')[0].strip().splitlines()
    rows = []
    for line, jd in zip(body, JDS):
        c = [x.strip() for x in line.split(',')]
        # date, (solar presence), (lunar presence), RA, Dec, APmag, S-brt, r, rdot, delta, deldot
        nums = [x for x in c[1:] if x not in ('', '*', 'C', 'N', 'A', 'm', 'r', 'e', 't', 's')]
        ra, dec, mag = float(nums[0]), float(nums[1]), float(nums[2])
        r, delta = float(nums[4]), float(nums[6])
        rows.append({'jd_ut': jd, 'ra': ra, 'dec': dec, 'vmag': mag, 'r': r, 'delta': delta})
    obj = {'number': n, 'name': s['object']['shortname'].split(' ', 1)[1], 'epoch_tdb': float(s['orbit']['epoch']), 'a': el['a'], 'e': el['e'], 'i': el['i'], 'node': el['om'],
           'peri': el['w'], 'M': el['ma'], 'n': el['n'], 'H': H, 'G': G, 'orbit_id': s['orbit']['orbit_id'], 'soln_date': s['orbit']['soln_date'], 'ephem': rows}
    out['objects'].append(obj)
    print(json.dumps([obj['name'], obj['epoch_tdb'], obj['a'], obj['e'], obj['i'], obj['node'], obj['peri'], obj['M'], obj['n'], H, G]) + ',')
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'asteroid_reference.json'), 'w') as f:
    json.dump(out, f, indent=1)
print('wrote test/asteroid_reference.json')
