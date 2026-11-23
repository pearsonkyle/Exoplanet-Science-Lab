"""Candidate opacity tables for the resolution / size / speed study (tools/opacity/study.mjs reads them).

Run:  .venv-rt/bin/python tools/opacity/study.py          (writes data-src/study/<candidate>/<species>.eslo, about 1.5 GB)
Each candidate is a full set of tables for H2O, CO2, CO, CH4 plus H2-H2 and H2-He CIA on the candidate's grid.
  truth        the ExoMolOP R = 15000 cross-sections as they are (float32, all 27 x 22 nodes): the reference
  x<R>         sampled cross-sections at R points per e-fold of wavelength
  k<R>g<n>     k-tables at resolving power R with n g-points
  ...-u8, -f16 the same values in another encoding (default: uint16)
  ...-t2, -p2, -t2p2   every second temperature or pressure node
  e<R>g<n>     from ExoMolOP's own R = 1000 k-tables (made from the full line lists): 1000 / R bins joined, n
               g-points. e1000g16 is the source itself and the reference of the second half of the study.
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_opacity as B

OUT = os.path.join(B.SRC, 'study')
WL = (0.3, 30.0)
# from the R = 15000 cross-sections
CANDIDATES = {
    'truth': dict(kind='xsec', R=15000, encoding='f32'),
    'x1000': dict(kind='xsec', R=1000), 'x3000': dict(kind='xsec', R=3000), 'x10000': dict(kind='xsec', R=10000),
    'k100g8': dict(kind='ktable', R=100, ng=8), 'k300g4': dict(kind='ktable', R=300, ng=4), 'k300g8': dict(kind='ktable', R=300, ng=8),
    'k300g16': dict(kind='ktable', R=300, ng=16), 'k1000g8': dict(kind='ktable', R=1000, ng=8), 'k1000g16': dict(kind='ktable', R=1000, ng=16),
    'k300g8-u8': dict(kind='ktable', R=300, ng=8, encoding='u8'), 'k300g8-f16': dict(kind='ktable', R=300, ng=8, encoding='f16'),
    'k300g8-t2': dict(kind='ktable', R=300, ng=8, t_step=2), 'k300g8-p2': dict(kind='ktable', R=300, ng=8, p_step=2),
    'k300g8-t2p2': dict(kind='ktable', R=300, ng=8, t_step=2, p_step=2),
    'x3000-t2p2': dict(kind='xsec', R=3000, t_step=2, p_step=2),
}
# from ExoMolOP's own R = 1000 k-tables: e<R>g<n>, R = 1000 / merge
EXO = {
    'e1000g16': dict(merge=1, ng=16), 'e1000g8': dict(merge=1, ng=8),
    'e333g16': dict(merge=3, ng=16), 'e333g8': dict(merge=3, ng=8), 'e333g4': dict(merge=3, ng=4),
    'e200g16': dict(merge=5, ng=16), 'e200g8': dict(merge=5, ng=8), 'e91g8': dict(merge=11, ng=8), 'e91g16': dict(merge=11, ng=16),
    'e333g8-u8': dict(merge=3, ng=8, encoding='u8'), 'e333g8-f16': dict(merge=3, ng=8, encoding='f16'),
    'e333g8-t2': dict(merge=3, ng=8, t_step=2), 'e333g8-p2': dict(merge=3, ng=8, p_step=2), 'e333g8-t2p2': dict(merge=3, ng=8, t_step=2, p_step=2),
    'e333g8-t2p2-u8': dict(merge=3, ng=8, t_step=2, p_step=2, encoding='u8'), 'e333g8-t3p3-u8': dict(merge=3, ng=8, t_step=3, p_step=3, encoding='u8'),
    'e333g16-t2p2-u8': dict(merge=3, ng=16, t_step=2, p_step=2, encoding='u8'), 'e200g8-t2p2-u8': dict(merge=5, ng=8, t_step=2, p_step=2, encoding='u8'),
    # the value of k at the node instead of the mean over the node's interval
    'e1000g8-pt': dict(merge=1, ng=8, method='point'), 'e200g8-pt': dict(merge=5, ng=8, method='point'), 'e200g12-pt': dict(merge=5, ng=12, method='point'),
    'e200g16-pt': dict(merge=5, ng=16, method='point'), 'e200g12': dict(merge=5, ng=12), 'e200g10-pt': dict(merge=5, ng=10, method='point'),
    # what ships (tools/opacity/build_opacity.py defaults)
    'ship': dict(merge=5, ng=12, t_step=2, p_step=2, encoding='u8', method='log'), 'ship-u16': dict(merge=5, ng=12, t_step=2, p_step=2, method='log'),
    'ship-mean': dict(merge=5, ng=12, t_step=2, p_step=2, encoding='u8'),   # the first default: the mean of k over a node's interval
}

def main(which=None):
    path = os.path.join(OUT, 'sizes.json')
    sizes = json.load(open(path)) if os.path.exists(path) else {}
    todo = [n for n in CANDIDATES if not which or n in which]
    if todo:
        srcs = {sp: B.read_exomol(sp) for sp in B.STUDY_SPECIES}
        for name in todo:
            c = CANDIDATES[name]; d = os.path.join(OUT, name); sizes[name] = {}
            for sp, src in srcs.items():
                sizes[name][sp] = B.build_species(sp, os.path.join(d, sp + '.eslo'), c['kind'], c['R'], c.get('ng', 8), WL[0], WL[1], B.thin(len(src[2]), c.get('t_step', 1)), B.thin(len(src[1]), c.get('p_step', 1)), c.get('encoding', 'u16'), src=src)
            for pair in ('H2-H2', 'H2-He'):
                sizes[name][pair] = B.build_cia(pair, os.path.join(d, pair + '.eslo'), c['R'], WL[0], WL[1], c['kind'], 'f32' if name == 'truth' else 'u16')
            print(name, {k: round(v / 1e6, 2) for k, v in sizes[name].items()}, flush=True)
        del srcs
    todo = [n for n in EXO if not which or n in which]
    if todo:
        srcs = {sp: B.read_exomol_k(sp) for sp in B.STUDY_SPECIES}
        for name in todo:
            c = EXO[name]; d = os.path.join(OUT, name); sizes[name] = {}
            if name == 'e1000g16':   # the reference of test/rt_reference.test.mjs: every species whose source file is here
                for sp in B.EXOMOL:
                    if sp not in srcs and os.path.exists(os.path.join(B.SRC, 'exomol', B.EXOMOL[sp][0] + B.KTAB)):
                        one = B.read_exomol_k(sp)
                        sizes[name][sp] = B.build_species(sp, os.path.join(d, sp + '.eslo'), ng=c['ng'], t_idx=B.thin(len(one[2]), 1), p_idx=B.thin(len(one[1]), 1), encoding='u16', src=one, merge=1, method='mean'); del one
            for sp, src in srcs.items():
                sizes[name][sp] = B.build_species(sp, os.path.join(d, sp + '.eslo'), ng=c['ng'], t_idx=B.thin(len(src[2]), c.get('t_step', 1)), p_idx=B.thin(len(src[1]), c.get('p_step', 1)), encoding=c.get('encoding', 'u16'), src=src, merge=c['merge'], method=c.get('method', 'mean'))
            e = srcs['H2O'][0]; n = (len(e) - 1) // c['merge']
            for pair in ('H2-H2', 'H2-He'):
                sizes[name][pair] = B.build_cia(pair, os.path.join(d, pair + '.eslo'), wl_min=float(e[0]), wl_max=float(e[n * c['merge']]), n=n, encoding='u16')
            print(name, {k: round(v / 1e6, 2) for k, v in sizes[name].items()}, flush=True)
    json.dump(sizes, open(path, 'w'), indent=1)

if __name__ == '__main__':
    main(sys.argv[1:] or None)
