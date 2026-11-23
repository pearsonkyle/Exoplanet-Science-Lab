"""FastChem at points off the nodes of the shipped chemistry grid, for test/chemistry.test.mjs (-> chem_reference.json).
Run:  .venv-rt/bin/python test/make_chem_reference.py     (needs data-src/fastchem, see tools/chem/README.md)
Also the elemental budget at each point (carbon and oxygen in the species the table keeps, over the total), and the
escape example of the owner's Exoplanet-Mass-Fractionation notes.
"""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'tools', 'chem'))
import build_chem as B

c = B.Chem()
rng = np.random.default_rng(7)
pts = []
for k in range(160):
    pts.append(dict(t=float(np.exp(rng.uniform(np.log(400), np.log(3400)))), p=float(10 ** rng.uniform(-7, 1.5)), mh=float(rng.uniform(-0.9, 2.4)), co=float(rng.uniform(0.15, 1.4))))
# named points people quote
pts += [dict(t=1000.0, p=1.0, mh=0.0, co=0.589), dict(t=1500.0, p=1e-3, mh=0.0, co=0.589), dict(t=2500.0, p=1e-2, mh=0.0, co=0.589), dict(t=800.0, p=1e-2, mh=1.0, co=0.589), dict(t=1200.0, p=1e-2, mh=0.0, co=1.2)]
for q in pts:
    c.set(q['mh'], q['co'])
    x, mu, flag = c.mixing([q['t']], [q['p']])
    q['x'] = {k: float(v[0]) for k, v in x.items()}; q['mu'] = float(mu[0]); q['flag'] = int(flag)
    a = np.array(c.fc.getElementAbundances()); iC, iO, iH = c.el.index('C'), c.el.index('O'), c.el.index('H')
    q['elements'] = dict(C=float(a[iC]), O=float(a[iO]), H=float(a[iH]))
# ---- our own solution of the same problem, for the H-He-C-N-O gas --------------------------------------------------
# Independent of FastChem's solver: the law of mass action for 15 species built from H, C, N, O (helium inert), with
# the equilibrium constants of logK.dat (ln K = a1/T + a2 ln T + a3 + a4 T + a5 T^2 for formation from the atoms,
# partial pressures in bar), element conservation and the total pressure, solved by Newton iteration in the
# logarithms of the four atomic partial pressures (scipy.optimize.root). It shares FastChem's constants and nothing else.
from scipy.optimize import root
OWN = {'H2': dict(H=2), 'H2O1': dict(H=2, O=1), 'C1O1': dict(C=1, O=1), 'C1O2': dict(C=1, O=2), 'C1H4': dict(C=1, H=4), 'H3N1': dict(H=3, N=1), 'C1H1N1_hcn': dict(C=1, H=1, N=1),
       'N2': dict(N=2), 'H1O1': dict(H=1, O=1), 'C2H2': dict(C=2, H=2), 'O2': dict(O=2)}
coef = {}
lines = open(os.path.join(B.SRC, B.LOGK)).read().split('\n')
for i, line in enumerate(lines):
    name = line.split(' ')[0]
    if name in OWN and ':' in line: coef[name] = [float(v) for v in lines[i + 1].split()]
EL = ['H', 'C', 'N', 'O']
def own_solution(T, P, abund):   # abund: {H, He, C, N, O} number abundances; returns {name: vmr}
    lnK = {k: a[0] / T + a[1] * np.log(T) + a[2] + a[3] * T + a[4] * T * T for k, a in coef.items()}
    def partial(u):
        p = {e: np.exp(u[i]) for i, e in enumerate(EL)}
        for k, comp in OWN.items(): p[k] = np.exp(lnK[k] + sum(n * u[EL.index(e)] for e, n in comp.items()))
        return p
    def resid(u):
        p = partial(u); tot = {e: p[e] + sum(comp.get(e, 0) * p[k] for k, comp in OWN.items()) for e in EL}
        p_he = abund['He'] / abund['H'] * tot['H']
        return [np.log(tot['C'] / tot['H']) - np.log(abund['C'] / abund['H']), np.log(tot['N'] / tot['H']) - np.log(abund['N'] / abund['H']),
                np.log(tot['O'] / tot['H']) - np.log(abund['O'] / abund['H']), np.log((sum(p.values()) + p_he) / P)]
    best = None
    for start in ([np.log(P) - 8, -40, -40, -40], [np.log(P) - 2, -25, -25, -25], [np.log(P), -15, -15, -15], [np.log(P) - 15, -60, -60, -60]):
        sol = root(resid, start, method='lm', options=dict(xtol=1e-13, maxiter=4000))
        r = np.abs(resid(sol.x)).max()
        if best is None or r < best[0]: best = (r, sol.x)
    p = partial(best[1]); tot_h = p['H'] + sum(comp.get('H', 0) * p[k] for k, comp in OWN.items()); p['He'] = abund['He'] / abund['H'] * tot_h
    return {k: float(v / P) for k, v in p.items()}, float(best[0])
names = {'H2': 'H2', 'H2O1': 'H2O', 'C1O1': 'CO', 'C1O2': 'CO2', 'C1H4': 'CH4', 'H3N1': 'NH3', 'C1H1N1_hcn': 'HCN', 'N2': 'N2', 'H': 'H', 'He': 'He'}
for q in pts:
    if q['mh'] > 1.0 or q['t'] > 3000: continue
    c.set(q['mh'], q['co']); a = np.array(c.fc.getElementAbundances())
    x, res = own_solution(q['t'], q['p'], {e: float(a[c.el.index(e)]) for e in ('H', 'He', 'C', 'N', 'O')})
    q['own'] = {names[k]: v for k, v in x.items() if k in names}; q['own_residual'] = res
    # FastChem on the same reduced problem: every element but H, He, C, N, O removed
    b = a.copy()
    for i, el in enumerate(c.el):
        if el not in ('H', 'He', 'C', 'N', 'O', 'e-'): b[i] = 1e-40
    c.fc.setElementAbundances(b)
    xr, _, _ = c.mixing([q['t']], [q['p']]); q['chon'] = {k: float(v[0]) for k, v in xr.items() if k in q['own']}
out_k = {k: coef[k][0] for k in ('H2', 'C1O1', 'N2', 'H1O1')}
json.dump(dict(points=pts, co_solar=float(c.co_solar), a1=out_k), open(os.path.join(HERE, 'chem_reference.json'), 'w'))
print('wrote chem_reference.json', len(pts), 'points')
