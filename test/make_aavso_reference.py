"""Reference for test/aavso.test.mjs: EXOTIC's own AAVSO report writer (exotic/output_files.py OutputFiles.aavso) run on
a fixed fit, read only, in the owner's conda environment. The report is written to a temporary directory and stored.

    /Users/kpearson/miniconda3/envs/exotic/bin/python -B test/make_aavso_reference.py      -> test/aavso_reference.json
"""
import json, os, tempfile, types
import numpy as np
import exotic
from exotic.output_files import OutputFiles
from exotic.utils import round_to_2

rng = np.random.default_rng(3)
n = 25
time = 2458107.6 + np.sort(rng.uniform(0, 0.25, n))
cases = []
for k, (tmid, tmidErr, rprs, rprsErr, inc, incErr, a1, a1Err, a2, a2Err) in enumerate([
        (2458107.71353888, 0.00071234, 0.156557, 0.0021, 87.991, 1.234, 7492.765, 12.5, -0.1216719, 0.0087),
        (2459642.6155, 3.3e-05, 0.0821, 0.00049, 89.5, 0.5, 1.0003, 0.00012, 0.0, 0.0),
        (2460001.25, 0.0125, 0.0995, 0.125, 85.0, 2.0, 2.5, 1.5, 0.125, 0.0625)]):
    # as in EXOTIC, the fit's numbers are numpy float64 (rounded by numpy's rules), the planet's priors Python floats
    fit = types.SimpleNamespace(parameters={k2: np.float64(v) for k2, v in {'tmid': tmid, 'rprs': rprs, 'inc': inc, 'a1': a1, 'a2': a2}.items()}, errors={k2: np.float64(v) for k2, v in {'tmid': tmidErr, 'rprs': rprsErr, 'inc': incErr, 'a1': a1Err, 'a2': a2Err}.items()},
                                time=time, data=1 + rng.normal(0, 3e-3, n), dataerr=np.full(n, 3e-3) + rng.uniform(0, 1e-4, n), airmass_model=1 + 0.01 * rng.normal(size=n))
    airm = 1.1 + 0.3 * rng.uniform(size=n)
    p = {'pName': 'HAT-P-32 b', 'sName': 'HAT-P-32', 'pPer': 2.15000825, 'pPerUnc': 1.3e-07, 'rprs': 0.14886, 'rprsUnc': 0.00048 if k != 2 else 0.0,
         'aRs': 5.344, 'aRsUnc': 0.04, 'inc': 88.98, 'incUnc': 0.68, 'ecc': 0.159 if k != 1 else 0.0}
    with tempfile.TemporaryDirectory() as d:
        i = {'save': d, 'date': '2017-12-20', 'aavso_num': 'KPEA', 'second_obs': 'ABC' if k else '', 'camera': 'CCD', 'pixel_bin': '1x1', 'exposure': 60.0 if k != 2 else 45.0,
             'notes': 'test report', 'filter': 'CV', 'filter_desc': 'Clear with V-band zero point', 'wl_min': 350.0 if k != 1 else None, 'wl_max': 850.0 if k != 1 else None}
        durs = [float(v) for v in 0.12 + 0.001 * rng.normal(size=50)]
        ld = [(0.5123, 0.0123), (-0.1234567, 0.05), (0.25, 0.125), (-0.04, 0.0)]
        comp = {'ra': '02:04:10.27', 'dec': '+46:41:16.2', 'x': '465.0', 'y': '183.0'} if k != 1 else None
        OutputFiles(fit, p, i, durs).aavso(comp, airm, *ld, 'abc123' if k == 2 else None)
        text = open(os.path.join(d, 'AAVSO_HAT-P-32 b_2017-12-20.txt'), encoding='utf-8').read()
    cases.append({'fit': {k2: float(v) for k2, v in fit.parameters.items()}, 'errors': {k2: float(v) for k2, v in fit.errors.items()}, 'time': time.tolist(), 'flux': fit.data.tolist(), 'err': fit.dataerr.tolist(), 'airmass': airm.tolist(), 'airmassModel': fit.airmass_model.tolist(),
                  'p': p, 'i': {k2: v for k2, v in i.items() if k2 != 'save'}, 'durations': durs, 'ld': ld, 'comp': comp, 'md5': 'abc123' if k == 2 else None, 'text': text})
rt = [[x, y, float(round_to_2(x, y))] for x, y in [(0.123456, 0.00123), (2.675, 0.5), (1234.5678, 0.0371), (0.000123456, 0.0), (-0.12345, 0.004), (0.5, 0.25), (2458107.71353888, 0.00071234), (1e-07, 3e-08)]]
json.dump({'generator': f'EXOTIC {exotic.__version__} (output_files.OutputFiles.aavso, utils.round_to_2)', 'version': exotic.__version__, 'cases': cases, 'round_to_2': rt}, open(os.path.join(os.path.dirname(__file__), 'aavso_reference.json'), 'w'))
print('3 reports,', sum(len(c['text']) for c in cases), 'characters')
