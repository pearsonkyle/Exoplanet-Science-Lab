"""UltraNest on the problems of the stress suite, as an independent reference for ln Z and for call counts.

    .venv-nest/bin/python test/stress_ultranest.py <problem id> [<id> ...] [--out file.json] [--slice] [--maxcalls N]

The likelihood is not re-implemented: a Node process (test/stress_like_server.mjs) evaluates the same
JavaScript function on the unit-cube points UltraNest proposes. UltraNest runs with its defaults
(ReactiveNestedSampler, MLFriends region sampling, 400 live points, frac_remain 0.01), or with
--slice its recommended step sampler (SliceSampler, nsteps = 2 d, region-oriented directions).
Setup:  python3 -m venv .venv-nest && .venv-nest/bin/pip install ultranest "numpy<2"
(With numpy 2.0.2, UltraNest 4.6.3 built from source on Python 3.9 runs but stalls: its region sampling
becomes inefficient after about 2500 iterations on every problem, even an uncorrelated 2-D Gaussian.)
Results of one pass over the suite are kept in test/stress_ultranest.json.
"""
import sys, json, struct, subprocess, time, os, logging
import numpy as np
import ultranest, ultranest.stepsampler

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
out = None; use_slice = False; maxcalls = 3000000; ids = []
i = 0
while i < len(args):
    if args[i] == '--out': out = args[i + 1]; i += 2
    elif args[i] == '--slice': use_slice = True; i += 1
    elif args[i] == '--maxcalls': maxcalls = int(float(args[i + 1])); i += 2
    else: ids.append(args[i]); i += 1

results = {}
for pid in ids:
    srv = subprocess.Popen(['node', os.path.join(here, 'stress_like_server.mjs'), pid], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    d = struct.unpack('<i', srv.stdout.read(4))[0]
    ncall = [0]
    def loglike(u):   # one point per call, as a plain (not vectorised) likelihood is used: batches would inflate the call count
        ncall[0] += 1
        srv.stdin.write(struct.pack('<i', 1) + np.ascontiguousarray(u, dtype='<f8').tobytes()); srv.stdin.flush()
        return struct.unpack('<d', srv.stdout.read(8))[0]
    logging.getLogger('ultranest').setLevel(logging.ERROR)
    np.random.seed(1)
    s = ultranest.ReactiveNestedSampler(['p%d' % k for k in range(d)], loglike, transform=None, vectorized=False, log_dir=None)
    if use_slice:
        s.stepsampler = ultranest.stepsampler.SliceSampler(nsteps=2 * d, generate_direction=ultranest.stepsampler.generate_mixture_random_direction)
    t0 = time.time()
    try:
        r = s.run(min_num_live_points=400, frac_remain=0.01, max_ncalls=maxcalls, show_status=False, viz_callback=False)
        res = dict(ncall=int(r['ncall']), sec=time.time() - t0, logz=float(r['logz']), logzerr=float(r['logzerr']), niter=int(r['niter']),
                   insertion_order=r.get('insertion_order_MWW_test', {}).get('converged'), mean_u=[float(x) for x in r['posterior']['mean']], sd_u=[float(x) for x in r['posterior']['stdev']],
                   ess=float(r['ess']), reached_max=bool(r['ncall'] >= maxcalls), mode='slice 2d' if use_slice else 'region')
    except Exception as e:  # noqa
        res = dict(error=repr(e), ncall=ncall[0], sec=time.time() - t0)
    srv.stdin.close(); srv.wait()
    results[pid] = res
    print(pid, json.dumps(res), flush=True)
    if out: json.dump(results, open(out, 'w'), indent=1)
