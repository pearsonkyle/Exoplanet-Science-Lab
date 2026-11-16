"""Reference for test/platesolve.test.mjs (src/core/platesolve.js).

Run with .venv-phot/bin/python (astropy 6, photutils, scipy); part B needs the network (VizieR).

A. WCS fitting: synthetic star lists made from known TAN and TAN-SIP solutions, fitted with
   astropy.wcs.utils.fit_wcs_from_points (proj_point fixed, CRPIX and CD fitted, SIP order 2 for the third case).
   The Node test fits the same lists and compares the pixel-to-sky mappings.
B. A real frame: the first frame of test/data/hatp32_exotic_sample.fits. The Gaia DR3 cone (VizieR I/355/gaiadr3,
   15 arcmin about HAT-P-32, G < 17) and the VSX cone are saved as the VizieR answers in
   test/data/platesolve_hatp32_catalogs.json so the test runs offline. The frame is solved here independently of the
   JavaScript: photutils DAOStarFinder for the stars, a brute-force search over rotation, parity and scale (2-D
   histogram of offsets) for the match, and fit_wcs_from_points for the WCS, iterated with 3-sigma clipping.
Writes test/platesolve_reference.json and test/data/platesolve_hatp32_catalogs.json.
"""
import json, time, urllib.request, urllib.parse
from pathlib import Path
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, Sip
from astropy.wcs.utils import fit_wcs_from_points
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.stats import sigma_clipped_stats
from photutils.detection import DAOStarFinder

HERE = Path(__file__).parent
rng = np.random.default_rng(20261116)


def make_wcs(crval, crpix, scale, rot_deg, mirror, sip=None):
    w = WCS(naxis=2)
    w.wcs.ctype = ['RA---TAN-SIP', 'DEC--TAN-SIP'] if sip else ['RA---TAN', 'DEC--TAN']
    w.wcs.crval = crval; w.wcs.crpix = crpix
    s = scale / 3600.0; t = np.radians(rot_deg); m = -1 if mirror else 1
    # north rot_deg from +y; m = -1: east toward -x (the usual sky view)
    w.wcs.cd = np.array([[m * s * np.cos(t), -s * np.sin(t)], [m * s * np.sin(t), s * np.cos(t)]])
    if sip:
        a = np.zeros((3, 3)); b = np.zeros((3, 3))
        for k, v in sip['a'].items(): a[int(k[0]), int(k[2])] = v
        for k, v in sip['b'].items(): b[int(k[0]), int(k[2])] = v
        w.sip = Sip(a, b, None, None, w.wcs.crpix)
    return w


cases = []
specs = [
    dict(name='linear, exact positions', crval=[150.1, 2.2], size=[2048, 1536], scale=1.2, rot=37.0, mirror=True, n=60, noise=0.0, sip=None, proj=[150.12, 2.19]),
    dict(name='linear, 0.15 px noise, Dec 78', crval=[263.5, 78.3], size=[3000, 2000], scale=0.85, rot=-121.0, mirror=False, n=80, noise=0.15, sip=None, proj=[263.4, 78.31]),
    dict(name='SIP order 2, 0.1 px noise', crval=[31.0, 46.7], size=[2400, 2400], scale=2.6, rot=91.5, mirror=True, n=150, noise=0.1, sip={'a': {'2_0': 3e-6, '1_1': -2e-6, '0_2': 1.5e-6}, 'b': {'2_0': -1e-6, '1_1': 2.5e-6, '0_2': 2e-6}}, proj=[31.02, 46.69]),
]
for sp in specs:
    W, H = sp['size']
    w = make_wcs(sp['crval'], [W / 2 + 0.5, H / 2 + 0.5], sp['scale'], sp['rot'], sp['mirror'], sp['sip'])
    x = rng.uniform(5, W - 5, sp['n']); y = rng.uniform(5, H - 5, sp['n'])
    ra, dec = w.all_pix2world(x, y, 0)
    xm = x + rng.normal(0, sp['noise'], sp['n']) if sp['noise'] else x
    ym = y + rng.normal(0, sp['noise'], sp['n']) if sp['noise'] else y
    pp = SkyCoord(sp['proj'][0] * u.deg, sp['proj'][1] * u.deg)
    fw = fit_wcs_from_points((xm, ym), SkyCoord(ra * u.deg, dec * u.deg), proj_point=pp, projection='TAN', sip_degree=2 if sp['sip'] else None)
    gx, gy = np.meshgrid(np.linspace(0, W - 1, 5), np.linspace(0, H - 1, 5)); gx = gx.ravel(); gy = gy.ravel()
    fr, fd = fw.all_pix2world(gx, gy, 0); tr, td = w.all_pix2world(gx, gy, 0)
    rr, rd = fw.all_pix2world(xm, ym, 0)
    res = SkyCoord(rr * u.deg, rd * u.deg).separation(SkyCoord(ra * u.deg, dec * u.deg)).arcsec
    out = dict(name=sp['name'], width=W, height=H, proj=sp['proj'], sipOrder=2 if sp['sip'] else 0, scale=sp['scale'], noise=sp['noise'],
               stars=[[float(a), float(b), float(c), float(d)] for a, b, c, d in zip(xm, ym, ra, dec)],
               astropy=dict(crpix=[float(v) for v in fw.wcs.crpix], cd=[float(v) for v in fw.wcs.cd.ravel()], rms=float(np.sqrt(np.mean(res ** 2)))),
               grid=[[float(a), float(b)] for a, b in zip(gx, gy)], gridAstropy=[[float(a), float(b)] for a, b in zip(fr, fd)], gridTruth=[[float(a), float(b)] for a, b in zip(tr, td)])
    if sp['sip']:
        out['astropy']['a'] = {f'{i}_{j}': float(fw.sip.a[i, j]) for i in range(3) for j in range(3) if 2 <= i + j <= 2}
        out['astropy']['b'] = {f'{i}_{j}': float(fw.sip.b[i, j]) for i in range(3) for j in range(3) if 2 <= i + j <= 2}
    cases.append(out)
    print(f"{sp['name']}: astropy rms {out['astropy']['rms']:.4f} arcsec")

# ---------------------------------------------------------------------------------------------------- B. real frame
TARGET = (31.04282266, 46.68783675)        # HAT-P-32 (CDS Sesame, Gaia DR3 position)
RADIUS, GMAX = 15.0, 17
BASE = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?'


def vizier(params):
    url = BASE + '&'.join(f'{k}={urllib.parse.quote(str(v))}' for k, v in params)
    with urllib.request.urlopen(url, timeout=90) as r:
        text = r.read().decode()
    keep = [l for l in text.splitlines() if not l.startswith('#') or l.startswith('#Table') or l.startswith('#Name') or l.startswith('#Title') or l.startswith('#Column')]
    return url, '\n'.join(keep) + '\n'


c = f'{TARGET[0]:.6f} +{TARGET[1]:.6f}'
gurl, gtsv = vizier([('-source', 'I/355/gaiadr3'), ('-c', c), ('-c.rm', f'{RADIUS:.2f}'), ('-out', 'Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,pmRA,pmDE,VarFlag'), ('-out.max', 2500), ('-sort', 'Gmag'), ('Gmag', f'<{GMAX}')])
vurl, vtsv = vizier([('-source', 'B/vsx/vsx'), ('-c', c), ('-c.rm', f'{RADIUS:.2f}'), ('-out', 'Name,RAJ2000,DEJ2000,Type,max,min,n_max'), ('-out.max', 500)])
cat_file = HERE / 'data' / 'platesolve_hatp32_catalogs.json'
cat_file.write_text(json.dumps(dict(made=time.strftime('%Y-%m-%d'), by='test/make_platesolve_reference.py', ra=TARGET[0], dec=TARGET[1], radius_arcmin=RADIUS, gmax=GMAX,
                                    gaia=dict(url=gurl, tsv=gtsv), vsx=dict(url=vurl, tsv=vtsv))))


def rows(tsv):
    lines = [l for l in tsv.splitlines() if l and not l.startswith('#')]
    cols = [c.strip() for c in lines[0].split('\t')]
    return [dict(zip(cols, [v.strip() for v in l.split('\t')])) for l in lines[3:]]


g = rows(gtsv)
gra = np.array([float(r['RA_ICRS']) for r in g]); gde = np.array([float(r['DE_ICRS']) for r in g]); gmag = np.array([float(r['Gmag']) for r in g])
print(f'Gaia: {len(g)} stars within {RADIUS} arcmin, G < {GMAX}')

hd = fits.open(HERE / 'data' / 'hatp32_exotic_sample.fits')[1]
img = hd.data.astype(float); Hh, Ww = img.shape; h = hd.header
mean, med, std = sigma_clipped_stats(img, sigma=3)
src = DAOStarFinder(fwhm=2.5, threshold=5 * std)(img - med)
src.sort('flux', reverse=True)
dx = np.array(src['xcentroid']); dy = np.array(src['ycentroid'])
print(f'DAOStarFinder: {len(src)} stars')

# brute force: project Gaia about the target with every rotation, parity and scale; the offset histogram's peak
xi_eta = SkyCoord(gra * u.deg, gde * u.deg).transform_to(SkyCoord(TARGET[0] * u.deg, TARGET[1] * u.deg).skyoffset_frame())
X = xi_eta.lon.arcsec; Y = xi_eta.lat.arcsec
nb, nd = int(np.sum(gmag < 15.5)), min(25, len(src))
best = None
for mir in (1, -1):
    for sc in np.arange(0.94, 1.0601, 0.02) * float(h['IM_SCALE']):
        for rot in np.radians(np.arange(0, 360, 1.0)):
            c_, s_ = np.cos(rot), np.sin(rot)
            # sky (arcsec) -> pixel offsets: inverse of X = sc (c u - s m v), Y = sc (s u + c m v)
            pu = (c_ * X[:nb] + s_ * Y[:nb]) / sc; pv = mir * (-s_ * X[:nb] + c_ * Y[:nb]) / sc
            ox = (dx[:nd, None] - pu[None, :]).ravel(); oy = (dy[:nd, None] - pv[None, :]).ravel()
            Hs, ex, ey = np.histogram2d(ox, oy, bins=[np.arange(-400, 400, 3), np.arange(-400, 400, 3)])
            k = np.unravel_index(np.argmax(Hs), Hs.shape)
            if best is None or Hs[k] > best[0]:
                best = (Hs[k], mir, sc, rot, ex[k[0]] + 1.5, ey[k[1]] + 1.5)
print('brute force: peak %d, mirror %d, scale %.3f, rotation %.1f deg' % (best[0], best[1], best[2], np.degrees(best[3])))
_, mir, sc, rot, ox, oy = best
c_, s_ = np.cos(rot), np.sin(rot)
px = (c_ * X + s_ * Y) / sc + ox; py = mir * (-s_ * X + c_ * Y) / sc + oy
allx, ally = np.array(src['xcentroid']), np.array(src['ycentroid'])
tol = 3.0
gcoord = SkyCoord(gra * u.deg, gde * u.deg)
for it in range(5):
    d = np.hypot(allx[:, None] - px[None, :], ally[:, None] - py[None, :])
    j = np.argmin(d, axis=1); ok = d[np.arange(len(allx)), j] < tol
    # one detected star per Gaia star
    _, first = np.unique(j[ok], return_index=True); idx = np.where(ok)[0][first]
    fw = fit_wcs_from_points((allx[idx], ally[idx]), gcoord[j[idx]], proj_point='center', projection='TAN')
    rr, rd = fw.all_pix2world(allx[idx], ally[idx], 0)
    res = SkyCoord(rr * u.deg, rd * u.deg).separation(gcoord[j[idx]]).arcsec
    keep = res < max(3 * np.sqrt(np.mean(res ** 2)), 0.3 * sc)
    fw = fit_wcs_from_points((allx[idx][keep], ally[idx][keep]), gcoord[j[idx]][keep], proj_point='center', projection='TAN')
    rr, rd = fw.all_pix2world(allx[idx][keep], ally[idx][keep], 0)
    res = SkyCoord(rr * u.deg, rd * u.deg).separation(gcoord[j[idx]][keep]).arcsec
    px, py = fw.all_world2pix(gra, gde, 0)
    tol = min(3.0, max(1.0, 3 * np.sqrt(np.mean(res ** 2)) / sc))
nm, rms = int(keep.sum()), float(np.sqrt(np.mean(res ** 2)))
tx, ty = fw.all_world2pix(TARGET[0], TARGET[1], 0)
gx, gy = np.meshgrid(np.linspace(0, Ww - 1, 5), np.linspace(0, Hh - 1, 5)); gx = gx.ravel(); gy = gy.ravel()
fr, fd = fw.all_pix2world(gx, gy, 0)
print(f'astropy solution: {nm} stars, rms {rms:.2f} arcsec; HAT-P-32 at pixel ({float(tx):.2f}, {float(ty):.2f})')
real = dict(frame='hatp32_exotic_sample.fits HDU 1', width=Ww, height=Hh, detected=len(src), nMatch=nm, rms=rms, target=[float(tx), float(ty)], targetSky=list(TARGET),
            crval=[float(v) for v in fw.wcs.crval], crpix=[float(v) for v in fw.wcs.crpix], cd=[float(v) for v in fw.wcs.cd.ravel()],
            grid=[[float(a), float(b)] for a, b in zip(gx, gy)], gridAstropy=[[float(a), float(b)] for a, b in zip(fr, fd)],
            bruteForce=dict(peak=int(best[0]), mirror=int(mir), scale=float(sc), rotation=float(np.degrees(rot))))
(HERE / 'platesolve_reference.json').write_text(json.dumps(dict(made=time.strftime('%Y-%m-%d'), by='test/make_platesolve_reference.py (astropy %s)' % __import__('astropy').__version__, fits=cases, real=real), indent=1))
print('wrote test/platesolve_reference.json and', cat_file.relative_to(HERE.parent))
