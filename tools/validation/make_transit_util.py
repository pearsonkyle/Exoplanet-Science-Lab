# Helpers shared by the generators: paths of the other interpreters and a runner for the ext_*.py scripts.
import json, os, subprocess, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PYANETI = os.path.join(ROOT, '.venv-validation/pyaneti-env/bin/python')
EXOTIC = '/Users/kpearson/miniconda3/envs/exotic/bin/python'

def run_ext(python, script, payload, extra=()):
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, 'in.json'), os.path.join(d, 'out.json')
        json.dump(payload, open(a, 'w'))
        r = subprocess.run([python, os.path.join(HERE, script), a, b, *extra], capture_output=True, text=True, cwd=d)
        if r.returncode != 0 or not os.path.exists(b):
            print(script, 'failed:', (r.stderr or r.stdout)[-600:]); return None
        return json.load(open(b))


def guarded(fn, timeout=120):
    """Run fn() in a forked child so that a compiled routine that exits or crashes cannot take the generator with it.
    Returns (value, None) or (None, 'what happened')."""
    import multiprocessing as mpc
    ctx = mpc.get_context('fork'); a, b = ctx.Pipe(False)
    def work():
        try: b.send(('ok', fn()))
        except Exception as ex: b.send(('err', f'{type(ex).__name__}: {str(ex)[:160]}'))
    pr = ctx.Process(target=work); pr.start()
    if a.poll(timeout):
        kind, val = a.recv(); pr.join(5)
        return (val, None) if kind == 'ok' else (None, val)
    pr.join(1)
    if pr.is_alive(): pr.kill(); return None, 'timed out'
    return None, f'process ended without a result (exit code {pr.exitcode})'
