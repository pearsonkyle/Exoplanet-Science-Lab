"""Equilibrium chemistry grid for the Atmosphere page: volume mixing ratios of the gases the model uses, from FastChem
(Stock et al. 2018, 2022; Kitzmann et al. 2024), on a grid of temperature, pressure, metallicity and C/O.

Run:  .venv-rt/bin/python tools/chem/build_chem.py            (writes public/chem/equilibrium.eslc, 5 MB)
Needs data-src/fastchem/logK.dat and asplund_2021.dat (tools/chem/README.md). FastChem is GPL-3 and is only run here;
what ships is the table of abundances it computed.

Conventions
  - gas phase only: no condensation and no rain-out, so refractory species (TiO, VO, Na, K) stay in the gas at
    temperatures where they would have condensed, and water never forms clouds
  - metallicity [M/H]: every element heavier than helium scaled by 10^[M/H] from the solar values of Asplund et al.
    (2021); then C/O is set by changing oxygen at fixed carbon (the same choice as petitRADTRANS)
  - mixing ratios are number fractions of the whole gas (all species FastChem carries), so they sum to less than 1
    here: the table also holds the mean molecular weight of the whole gas

File format (ESLC): 'ESLC', uint32 version (1), uint32 header length, JSON header padded to 8 bytes, then uint16
values in the order [species][mh][co][p][t]: code 0 = below the floor, else log10(vmr) = lo + (code - 1) * step.
The last "species" is the mean molecular weight, stored as log10(mu / 100).
"""
import json, os, struct, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'data-src', 'fastchem')
ABUND, LOGK = 'asplund_2021.dat', 'logK.dat'
# our name -> FastChem's (Hill notation)
SPECIES = {'H2': 'H2', 'He': 'He', 'H': 'H', 'e-': 'e-', 'H-': 'H1-', 'H2O': 'H2O1', 'CO2': 'C1O2', 'CO': 'C1O1', 'CH4': 'C1H4', 'NH3': 'H3N1', 'HCN': 'C1H1N1_hcn',
           'SO2': 'O2S1', 'H2S': 'H2S1', 'Na': 'Na', 'K': 'K', 'TiO': 'O1Ti1', 'VO': 'O1V1', 'N2': 'N2'}
T_NODES = np.exp(np.linspace(np.log(300.0), np.log(4000.0), 40))
P_NODES = 10.0 ** np.linspace(-8, 2, 21)                       # bar
MH_NODES = np.array([-1.0, -0.5, 0.0, 0.5, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5])   # closer above 10 x solar, where the bulk gas changes
CO_NODES = np.array([0.1, 0.2, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.25, 1.5])        # closest around 1, where the chemistry turns over
LO, HI = -30.0, 0.0


def solar():
    """{element: log abundance on the H = 12 scale} from the abundance file."""
    out = {}
    for line in open(os.path.join(SRC, ABUND)):
        if line.startswith('#') or not line.strip(): continue
        el, v = line.split()[:2]; out[el] = float(v)
    return out


class Chem:
    """FastChem with the abundances of a metallicity and a C/O. mixing(T[K], P[bar]) -> ({name: vmr array}, mu array)."""
    def __init__(self):
        import pyfastchem
        self.pf = pyfastchem
        self.fc = pyfastchem.FastChem(os.path.join(SRC, ABUND), os.path.join(SRC, LOGK), 0)
        self.base = np.array(self.fc.getElementAbundances())
        n = self.fc.getElementNumber()
        self.el = [self.fc.getElementSymbol(i) for i in range(n)]
        self.idx = {}
        for ours, theirs in SPECIES.items():
            k = self.fc.getGasSpeciesIndex(theirs)
            if k == pyfastchem.FASTCHEM_UNKNOWN_SPECIES:
                alt = [self.fc.getGasSpeciesSymbol(j) for j in range(self.fc.getGasSpeciesNumber()) if self.fc.getGasSpeciesSymbol(j).startswith(theirs.split('_')[0])]
                raise SystemExit(f'FastChem has no species {theirs}; similar: {alt}')
            self.idx[ours] = k
        self.weights = np.array([self.fc.getGasSpeciesWeight(j) for j in range(self.fc.getGasSpeciesNumber())])

    def set(self, mh, co):
        a = self.base.copy()
        for i, el in enumerate(self.el):
            if el not in ('H', 'He', 'e-'): a[i] *= 10.0 ** mh
        iC, iO = self.el.index('C'), self.el.index('O')
        a[iO] = a[iC] / co
        self.fc.setElementAbundances(a)
        self.co_solar = self.base[iC] / self.base[iO]

    def mixing(self, T, P):
        i, o = self.pf.FastChemInput(), self.pf.FastChemOutput()
        i.temperature = [float(v) for v in T]; i.pressure = [float(v) for v in P]
        flag = self.fc.calcDensities(i, o)
        nd = np.array(o.number_densities); tot = nd.sum(axis=1)
        return {k: nd[:, j] / tot for k, j in self.idx.items()}, (nd * self.weights).sum(axis=1) / tot, flag


if __name__ == '__main__':
    c = Chem()
    names = list(SPECIES)
    nT, nP, nM, nC = len(T_NODES), len(P_NODES), len(MH_NODES), len(CO_NODES)
    out = np.zeros((len(names) + 1, nM, nC, nP, nT))
    TT, PP = np.meshgrid(T_NODES, P_NODES)          # [p][t]
    worst = 0
    for im, mh in enumerate(MH_NODES):
        for ic, co in enumerate(CO_NODES):
            c.set(mh, co)
            x, mu, flag = c.mixing(TT.ravel(), PP.ravel()); worst = max(worst, flag)
            for k, nm in enumerate(names): out[k, im, ic] = x[nm].reshape(nP, nT)
            out[-1, im, ic] = (mu / 100.0).reshape(nP, nT)
        print(f'[M/H] = {mh:+.1f} done', flush=True)
    step = (HI - LO) / 65534.0
    with np.errstate(divide='ignore'):
        lg = np.log10(out)
    code = np.where(lg < LO, 0, 1 + np.rint((np.clip(lg, LO, HI) - LO) / step)).astype('<u2')
    header = dict(kind='chemistry', version=1, species=names + ['mu'], t=[float(v) for v in T_NODES], p=[float(v) for v in P_NODES], mh=[float(v) for v in MH_NODES], co=[float(v) for v in CO_NODES],
                  order='species,mh,co,p,t', encoding=dict(type='u16', lo=LO, hi=HI), mu='log10(mu / 100)', co_solar=float(c.co_solar),
                  source='FastChem (Stock et al. 2018, 2022; Kitzmann et al. 2024), gas phase only; solar abundances of Asplund et al. (2021); C/O set by changing oxygen',
                  doi='10.1093/mnras/sty1531', licence='computed with FastChem (GPL-3); the table itself is data, shared under CC BY 4.0')
    js = json.dumps(header).encode()
    js += b' ' * ((8 - (12 + len(js)) % 8) % 8)
    path = os.path.join(ROOT, 'public', 'chem', 'equilibrium.eslc')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'ESLC'); f.write(struct.pack('<II', 1, len(js))); f.write(js); f.write(code.tobytes())
    print(f'wrote {path}: {os.path.getsize(path) / 1e6:.2f} MB, {code.size} values, worst FastChem flag {worst} (0 = converged), solar C/O {c.co_solar:.3f}')
