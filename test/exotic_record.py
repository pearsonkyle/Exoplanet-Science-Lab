# Records what EXOTIC itself does on its sample data (HAT-P-32 b, 142 MicroObservatory frames), by running EXOTIC's
# own main() headless with four of its functions wrapped (fit_centroid, aperPhot, fit_lightcurve, transformation).
#   unzip EXOTIC_sampledata-1.0.0.zip -d /tmp/esl_exotic_sample
#   copy EXOTIC's inits.json to /tmp/esl_exotic_run/inits.json with: the FITS and save directories set, "Plate Solution? (y/n)": "n",
#   "Add Comparison Stars from AAVSO? (y/n)": "n", comparison stars [[465, 183], [512, 263]], pre-reduced file null
#   cd /tmp/esl_exotic_run && MPLBACKEND=Agg /Users/kpearson/miniconda3/envs/exotic/bin/python -B exotic_record.py inits.json < /dev/null
# (-red inits -ov: complete reduction from the inits file without querying the NASA Exoplanet Archive; no prompts.)
# Writes rec.npz and rec.json there; test/make_exotic_photometry_reference.py turns them into the committed reference.
# Nothing was installed or changed in the exotic conda environment for this (EXOTIC 2026 working copy, astropy 6.1.7,
# numpy 1.26.4, photutils 2.0.2, scipy 1.14.1). Takes about 8 minutes, most of it EXOTIC's own nested-sampling fit.
import sys, json, numpy as np, time
import matplotlib; matplotlib.use('Agg')
import exotic.exotic as ex
rec = {'centroid': [], 'aper': [], 'fits': [], 'tform': []}
_fc = ex.fit_centroid
def fc(data, pos, starIndex, *a, **k):
    r = _fc(data, pos, starIndex, *a, **k)
    # also the un-overridden Gaussian fit centre, for comparison
    r2 = _fc(data, pos, starIndex, weightedcenter=False) if k.get('weightedcenter', True) else r
    rec['centroid'].append([int(starIndex), float(pos[0]), float(pos[1])] + [float(v) for v in r] + [float(r2[0]), float(r2[1])])
    return r
ex.fit_centroid = fc
_ap = ex.aperPhot
def ap(data, starIndex, xc, yc, r=5, dr=5):
    out = _ap(data, starIndex, xc, yc, r, dr)
    rec['aper'].append([int(starIndex), float(xc), float(yc), float(r), float(dr), float(out[0]), float(out[1])])
    return out
ex.aperPhot = ap
_fl = ex.fit_lightcurve
def fl(times, tFlux, cFlux, airmass, ld, pDict, jd_times=None):
    t0 = time.time(); out = _fl(times, tFlux, cFlux, airmass, ld, pDict, jd_times)
    f = out[0]
    if f is not None:
        rec['fits'].append({'n': int(len(f.time)), 'nin': int(len(times)), 'std': float(f.residuals.std() / np.median(f.data)), 'pars': {k: float(f.parameters[k]) for k in ('rprs', 'tmid', 'inc', 'a1', 'a2')}, 'nocomp': bool(np.sum(cFlux) == len(cFlux)), 'ms': 1000 * (time.time() - t0)})
        rec['last'] = {'time': f.time.tolist(), 'data': f.data.tolist(), 'err': f.dataerr.tolist(), 'airmass': f.airmass.tolist(), 'model': f.model.tolist(), 'transit': f.transit.tolist(), 'prior': {k: float(v) for k, v in f.prior.items()}, 'bounds': {k: [float(x) for x in v] for k, v in f.bounds.items()}}
        rec.setdefault('inputs', {'times': np.asarray(times).tolist(), 'airmass': np.asarray(airmass).tolist(), 'jd': np.asarray(jd_times).tolist(), 'ld': [float(x) for x in ld], 'pDict': {k: (float(v) if isinstance(v, (int, float, np.floating)) else str(v)) for k, v in pDict.items()}})
    else: rec['fits'].append(None)
    return out
ex.fit_lightcurve = fl
_tf = ex.transformation
def tf(image_data, file_name, roi=1):
    r = _tf(image_data, file_name, roi)
    rec['tform'].append([str(file_name), float(r.scale), float(r.rotation), float(r.translation[0]), float(r.translation[1])])
    return r
ex.transformation = tf
sys.argv = ['exotic', '-red', sys.argv[1], '-ov']
try:
    ex.main()
finally:
    np.savez_compressed('/tmp/esl_exotic_run/rec.npz', centroid=np.array(rec['centroid']), aper=np.array(rec['aper']))
    json.dump({k: rec[k] for k in rec if k not in ('centroid', 'aper')}, open('/tmp/esl_exotic_run/rec.json', 'w'))
