# Independent reference for the whole-circle check of test/horizon.test.mjs: the horizon of two observatories
# (sites.json) computed again from the Terrarium tiles, with nothing of src/core/horizon.js:
#   - the PNGs decoded by Pillow (horizon.js and tiles.mjs have their own decoder),
#   - points along each azimuth from WGS84 geodesics (pyproj Geod.fwd; horizon.js marches great circles on a sphere),
#   - elevation angles from ECEF vectors on the WGS84 ellipsoid (pyproj, EPSG:4979 -> 4978) in the observer's
#     east-north-up frame, with refraction as a lift of k s / (2 R) (k = 0.13, s the distance; horizon.js draws a
#     straight ray over an Earth of radius R / (1 - k)),
#   - bilinear sampling across tile edges on a mosaic (horizon.js clamps inside a tile), steps of a quarter pixel or
#     0.4% of the distance (horizon.js: half a pixel or 0.8%).
# Two pyramids: "same" uses the zoom of horizon.js at each distance (the same tiles), "fine" one zoom more
# everywhere (four times the pixels: what the coarser zooms of the browser's pyramid lose). The march goes as far
# as horizon.js's rule (sea horizon of the eye + 100 km, 150 to 300 km), computed here from this ground.
#   ../../../../.venv-terrain/bin/python make_reference.py [tile cache folder]   (numpy, pyproj, pillow)
# Writes reference.json next to this file. Tiles missing from the cache are downloaded from the AWS Open Data
# Terrain Tiles (https://registry.opendata.aws/terrain-tiles/, attribution in src/core/horizon.js).
import json, math, os, sys, urllib.request
import numpy as np
from PIL import Image
from pyproj import Geod, Transformer

here = os.path.dirname(os.path.abspath(__file__))
cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TMPDIR', '/tmp'), 'esl-terrain-cache')
os.makedirs(cache, exist_ok=True)
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
K, R = 0.13, 6371008.8
geod, ecef = Geod(ellps='WGS84'), Transformer.from_crs('EPSG:4979', 'EPSG:4978', always_xy=True)
BANDS = {'same': [(13, 3000), (12, 8000), (10, 30000), (9, 75000), (8, 150000), (7, 300000)],
         'fine': [(14, 3000), (13, 8000), (11, 30000), (10, 75000), (9, 150000), (8, 300000)]}
tiles, fetched = {}, [0]


def tile(z, x, y):
    k = (z, x, y)
    if k not in tiles:
        path = os.path.join(cache, f'{z}-{x}-{y}.png')
        if not os.path.exists(path):
            urllib.request.urlretrieve(URL.format(z=z, x=x, y=y), path); fetched[0] += 1
        a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
        tiles[k] = a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768
    return tiles[k]


def sample(z, lat, lon):
    """Bilinear elevation at arrays of lat, lon (deg) on the mosaic of zoom z (pixel centres at half-integers)."""
    n = 256 * 2 ** z
    X = ((lon + 180) / 360) % 1 * n - 0.5
    Y = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n - 0.5
    x0, y0 = np.floor(X).astype(np.int64), np.floor(Y).astype(np.int64)
    fx, fy = X - x0, Y - y0
    def px(ix, iy):
        ix = ix % n
        out = np.empty(ix.shape)
        tx, ty = ix // 256, iy // 256
        for key in set(zip(tx.tolist(), ty.tolist())):
            m = (tx == key[0]) & (ty == key[1])
            out[m] = tile(z, key[0], key[1])[iy[m] % 256, ix[m] % 256]
        return out
    return (px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx) * (1 - fy) + (px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx) * fy


def pixel(lat, z):
    return 2 * math.pi * 6378137 * math.cos(math.radians(lat)) / (256 * 2 ** z)


def profile(site, bands, step=1.0):
    lat0, lon0, eye = site['lat'], site['lon'], site['eye']
    ground = float(sample(bands[0][0], np.array([lat0]), np.array([lon0]))[0])
    h0 = max(ground, site.get('elev', -1e9), 0) + eye
    Re = R / (1 - K)
    dmax = max(150000.0, min(300000.0, math.sqrt(2 * Re * h0) + 100000.0))
    # distances and the zoom used at each
    d, zs = [], []
    x = 60.0
    while x <= dmax:
        z = next((b[0] for b in bands if x <= b[1]), bands[-1][0])
        d.append(x); zs.append(z)
        x += max(0.25 * pixel(lat0, z), 0.004 * x)
    d, zs = np.array(d), np.array(zs)
    o = np.array(ecef.transform(lon0, lat0, h0))
    sl, cl, so, co = math.sin(math.radians(lat0)), math.cos(math.radians(lat0)), math.sin(math.radians(lon0)), math.cos(math.radians(lon0))
    east, north, up = np.array([-so, co, 0]), np.array([-sl * co, -sl * so, cl]), np.array([cl * co, cl * so, sl])
    dip = -math.degrees(math.acos(Re / (Re + h0)))
    alt, dist = [], []
    for az in np.arange(0, 360, step):
        lo, la, _ = geod.fwd(np.full(d.shape, lon0), np.full(d.shape, lat0), np.full(d.shape, az), d)
        h = np.empty(d.shape)
        for z in np.unique(zs):
            m = zs == z
            h[m] = sample(int(z), la[m], lo[m])
        h = np.maximum(h, 0.0)
        p = np.array(ecef.transform(lo, la, h)).T - o
        E, N, U = p @ east, p @ north, p @ up
        a = np.degrees(np.arctan2(U, np.hypot(E, N))) + np.degrees(K * d / (2 * R))
        i = int(np.argmax(a))
        alt.append(max(float(a[i]), dip)); dist.append(float(d[i]) if a[i] > dip else None)
    return {'ground': ground, 'eyeAt': h0, 'maxDist': dmax, 'samples': int(len(d)), 'alt': [round(v, 4) for v in alt], 'dist': [None if v is None else round(v) for v in dist]}


out = {'about': 'Horizon profiles from make_reference.py (WGS84 geodesics, Pillow, pyproj; see its header). alt: apparent elevation angle of the horizon in degrees, one per degree of azimuth from north through east.',
       'k': K, 'step': 1.0, 'sites': {}}
for s in json.load(open(os.path.join(here, 'sites.json')))['sites']:
    out['sites'][s['id']] = {}
    for name, bands in BANDS.items():
        p = profile(s, bands, s.get('step', 1.0))
        out['sites'][s['id']][name] = p
        print(s['id'], name, f"ground {p['ground']:.1f} m, march {p['maxDist'] / 1000:.0f} km, {p['samples']} samples a ray, horizon {min(p['alt']):.2f} to {max(p['alt']):.2f} deg, {len(tiles)} tiles read so far ({fetched[0]} downloaded)")
json.dump(out, open(os.path.join(here, 'reference.json'), 'w'), separators=(',', ':'))
