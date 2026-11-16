# Runs one adapter from codes.py on one case in a process of its own, because some compiled kernels can take the
# interpreter down (PyAstronomy's occultnl does for small planets):  python ext_isolated.py <adapter name>  < case.json  > flux.json
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, codes
c = json.load(sys.stdin)
y = codes.LC[sys.argv[1]](c, np.asarray(c['t'], float))
sys.stdout.write('\nRESULT ' + json.dumps(None if y is None else np.asarray(y, float).tolist()))
