"""petitRADTRANS spectra of three planets (each shipped gas alone and in mixtures), as an independent radiative transfer reference for src/core/rtmodel.js.

Run:  .venv-rt/bin/python test/make_rt_reference.py        (writes test/rt_reference.json; environment: see
                                                            test/make_atmosphere_reference.py)
Needs ExoMolOP's R = 1000 k-tables of the twelve species in data-src/exomol/ (tools/opacity/README.md). The script links
them under data-src/prt_input_data/ with petitRADTRANS's file names, so petitRADTRANS downloads nothing; a case whose
file is absent is skipped and said so.

petitRADTRANS 3.4.0, correlated-k at R = 1000 with 16 g-points: the same k-tables src/core/opacity.js reads after
conversion (data-src/study/e1000g16), so a difference is in the radiative transfer and the mixing of species, not in
the line data. Rayleigh scattering by H2 and He is on; collision-induced absorption is off in both codes (their
CIA files differ; ours is checked against the HITRAN file itself in test/opacity.test.mjs).
Per case: transit radius with variable gravity, and emergent flux without scattering.
"""
import json, os
os.environ.setdefault('pRT_emcee_mode', 'True')   # no MPI
import h5py
import numpy as np
from petitRADTRANS.radtrans import Radtrans
import petitRADTRANS

HERE = os.path.dirname(os.path.abspath(__file__))
INPUT = os.path.join(os.path.dirname(HERE), 'data-src', 'prt_input_data')
GM_JUP, R_JUP, R_SUN, BAR = 1.32712440018e20 * 9.5459426398e-4, 7.1492e7, 6.957e8, 1e5
MASS = {'H2': 2.01588, 'He': 4.002602, 'H2O': 18.01528, 'CO2': 44.0095, 'CO': 28.0101, 'CH4': 16.0425, 'NH3': 17.03052, 'HCN': 27.0253,
        'SO2': 64.0638, 'H2S': 34.0809, 'Na': 22.98977, 'K': 39.0983, 'TiO': 63.8664, 'VO': 66.9409}
# species -> (isotopologue, line list): ExoMol's file is <isotopologue>__<list>.R1000_0.3-50mu.ktable.petitRADTRANS.h5
# (H2O: "__R1000"), petitRADTRANS's name for it is <species>__<list>.R1000_0.3-50mu
LISTS = {'H2O': ('1H2-16O', 'POKAZATEL'), 'CO2': ('12C-16O2', 'UCL-4000'), 'CO': ('12C-16O', 'Li2015'), 'CH4': ('12C-1H4', 'YT34to10'),
         'NH3': ('14N-1H3', 'CoYuTe'), 'HCN': ('1H-12C-14N', 'Harris'), 'SO2': ('32S-16O2', 'ExoAmes'), 'H2S': ('1H2-32S', 'AYT2'),
         'Na': ('23Na', 'Kurucz-Na'), 'K': ('39K', 'Kurucz-K'), 'TiO': ('48Ti-16O', 'Toto'), 'VO': ('51V-16O', 'VOMYT')}
TAIL = 'R1000_0.3-50mu.ktable.petitRADTRANS.h5'
NAMES = {s: f'{s}__{l}.R1000_0.3-50mu' for s, (_, l) in LISTS.items()}

def link(species):
    """Link ExoMol's file under petitRADTRANS's folder layout so that it downloads nothing. False when the file is absent."""
    iso, lst = LISTS[species]
    src = os.path.join(os.path.dirname(INPUT), 'exomol', f'{iso}__{lst}{"__" if species == "H2O" else "."}{TAIL}')
    if not os.path.exists(src): return False
    try: h5py.File(src, 'r').close()
    except OSError: return False   # still downloading
    d = os.path.join(INPUT, 'opacities', 'lines', 'correlated_k', species, iso); os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, f'{iso}__{lst}.{TAIL}')
    if not os.path.lexists(dst): os.symlink(os.path.relpath(src, d), dst)
    return True

WARM = dict(planet=dict(mplanet=0.28, rplanet=1.27, pRef=0.01), star=dict(rstar=0.9, teff=5400), tp=dict(kind='guillot', teq=1100, tint=100, kappaIR=1e-3, gamma=0.4))
# an ultra-hot Jupiter for the gases that need the heat; its spectra start at 0.35 micron, where they absorb
ULTRA = dict(planet=dict(mplanet=1.2, rplanet=1.75, pRef=0.01), star=dict(rstar=1.46, teff=6500), tp=dict(kind='guillot', teq=2300, tint=200, kappaIR=2e-3, gamma=0.3), range=[0.35, 12.0])
W4 = dict(H2O=1e-3, CO2=1e-5, CO=1e-3, CH4=1e-7)
CASES = {
    'warm': dict(WARM, vmr=W4),
    'hot': dict(planet=dict(mplanet=1.13, rplanet=1.13, pRef=0.01), star=dict(rstar=0.75, teff=5050), tp=dict(kind='guillot', teq=1600, tint=200, kappaIR=2e-3, gamma=0.3), vmr=dict(H2O=5e-4, CO2=1e-6, CO=5e-4, CH4=1e-6)),
    # one absorber alone: no mixing of species, so a difference there is in the radiative transfer itself
    'warm, H2O only': dict(WARM, vmr=dict(H2O=1e-3)),
    'warm, CO2 only': dict(WARM, vmr=dict(CO2=1e-5)), 'warm, CO only': dict(WARM, vmr=dict(CO=1e-3)), 'warm, CH4 only': dict(WARM, vmr=dict(CH4=1e-5)),
    # the eight gases added after the first four, alone, then in a mixture
    'warm, NH3 only': dict(WARM, vmr=dict(NH3=1e-5)), 'warm, HCN only': dict(WARM, vmr=dict(HCN=1e-5)),
    'warm, SO2 only': dict(WARM, vmr=dict(SO2=1e-5)), 'warm, H2S only': dict(WARM, vmr=dict(H2S=1e-4)),
    'warm, eight molecules': dict(WARM, vmr=dict(H2O=1e-3, CO2=1e-5, CO=1e-3, CH4=1e-6, NH3=1e-5, HCN=1e-6, SO2=1e-6, H2S=3e-5)),
    'ultra-hot, Na only': dict(ULTRA, vmr=dict(Na=1e-6)), 'ultra-hot, K only': dict(ULTRA, vmr=dict(K=1e-7)),
    'ultra-hot, TiO only': dict(ULTRA, vmr=dict(TiO=1e-7)), 'ultra-hot, VO only': dict(ULTRA, vmr=dict(VO=1e-8)),
    'ultra-hot, six absorbers': dict(ULTRA, vmr=dict(H2O=3e-4, CO=5e-4, Na=1e-6, K=1e-7, TiO=1e-7, VO=1e-8)),
    # aerosols on the four-molecule warm planet; `prt` holds petitRADTRANS's own arguments for the same thing
    'warm, cloud deck at 1 mbar': dict(WARM, vmr=W4, cloudTop=1e-3, prt=dict(opaque_cloud_top_pressure=1e-3)),
    # the same deck on four times as many layers: the two codes treat the ring just under the deck's top differently
    'warm, cloud deck at 1 mbar, 480 layers': dict(WARM, vmr=W4, cloudTop=1e-3, nlev=481, prt=dict(opaque_cloud_top_pressure=1e-3)),
    'warm, power-law haze': dict(WARM, vmr=W4, haze=dict(kappa350=0.05, slope=-2.0), prt=dict(power_law_opacity_350nm=0.05, power_law_opacity_coefficient=-2.0)),
    'warm, Rayleigh haze x 30': dict(WARM, vmr=W4, haze=dict(kappa350=None, slope=-4.0, rayleigh_times=30.0), prt=dict(haze_factor=30.0)),
    'warm, half-covered by a deck at 1 mbar': dict(WARM, vmr=W4, cloudTop=1e-3, cloudFraction=0.5, prt=dict(opaque_cloud_top_pressure=1e-3, cloud_fraction=0.5)),
}
HE_H2 = 0.17

sig = lambda v, n: float(f'{float(v):.{n}g}')

def guillot(p_bar, teq, tint, kappa, gamma, g, f=0.25):
    tau = kappa * p_bar * BAR / g
    s3 = np.sqrt(3.0)
    return (0.75 * tint**4 * (2 / 3 + tau) + 0.75 * 4 * teq**4 * f * (2 / 3 + 1 / (gamma * s3) + (gamma / s3 - 1 / (gamma * s3)) * np.exp(-gamma * tau * s3))) ** 0.25

pressures = np.logspace(-6, 2, 121)
out = dict(version=petitRADTRANS.__version__, pressures=[float(pressures[0]), float(pressures[-1]), len(pressures)], heH2=HE_H2, cases={})
for name, c in CASES.items():
    pressures = np.logspace(-6, 2, c.pop('nlev', 121))
    missing = [sp for sp in c['vmr'] if not link(sp)]
    if missing: print('SKIPPED', name, ': no complete k-table in data-src/exomol for', missing); continue
    rt_use = Radtrans(pressures=pressures, line_species=[NAMES[sp] for sp in c['vmr']], rayleigh_species=['H2', 'He'], gas_continuum_contributors=[],
                      wavelength_boundaries=c.get('range', [0.6, 12.0]), line_opacity_mode='c-k', path_input_data=INPUT)
    gm, r0 = GM_JUP * c['planet']['mplanet'], R_JUP * c['planet']['rplanet']
    g = gm / r0**2
    tp = c['tp']
    T = guillot(pressures, tp['teq'], tp['tint'], tp['kappaIR'], tp['gamma'], g)
    vmr = dict(c['vmr']); rest = 1 - sum(vmr.values()); vmr['H2'] = rest / (1 + HE_H2); vmr['He'] = rest - vmr['H2']
    mmw = sum(vmr[s] * MASS[s] for s in vmr)
    mf = {NAMES.get(s, s): np.full(len(pressures), vmr[s] * MASS[s] / mmw) for s in vmr}
    kw = dict(temperatures=T, mass_fractions=mf, mean_molar_masses=np.full(len(pressures), mmw), reference_gravity=g * 100)
    extra = c.pop('prt', {})
    if 'haze' in c:   # ours is a cross-section per molecule in units of H2's Rayleigh value at 0.35 micron
        s350 = 8.14e-13 / 3500.0**4 + 1.28e-6 / 3500.0**6 + 1.61 / 3500.0**8
        hz = c['haze']; c['haze'] = dict(factor=hz['kappa350'] * mmw * 1.66053906660e-24 / s350 if hz['kappa350'] else None, slope=hz['slope'], rayleigh_times=hz.get('rayleigh_times'))
    wl, radii, _ = rt_use.calculate_transit_radii(planet_radius=r0 * 100, reference_pressure=c['planet']['pRef'], variable_gravity=True, **kw, **extra)
    try: wl2, flux, _ = rt_use.calculate_flux(frequencies_to_wavelengths=True, **kw, **{k: v for k, v in extra.items() if k == 'opaque_cloud_top_pressure'})
    except TypeError as e: print('flux without the cloud arguments:', e); wl2, flux, _ = rt_use.calculate_flux(frequencies_to_wavelengths=True, **kw)
    order = np.argsort(wl)
    out['cases'][name] = dict(model=c, nlev=len(pressures), mmw=float(mmw), g=float(g),
                              wl=[sig(v, 9) for v in (wl * 1e4)[order]],   # 9 digits: 1e-5 ppm in depth, to keep the file small
                              depth=[sig(v, 9) for v in ((radii / 100 / (c['star']['rstar'] * R_SUN)) ** 2)[order]],
                              flux=[sig(v, 7) for v in (flux * 1e-7)[np.argsort(wl2)]])   # erg cm^-2 s^-1 cm^-1 -> W m^-2 micron^-1
    print(name, len(wl), 'bins', 'depth', out['cases'][name]['depth'][:2], 'flux', out['cases'][name]['flux'][-2:])
# ---- values of the source files themselves, for test/opacity.test.mjs ------------------------------------------------
import h5py
src = os.path.join(os.path.dirname(HERE), 'data-src')
with h5py.File(os.path.join(src, 'exomol', '1H2-16O__POKAZATEL__R1000_0.3-50mu.ktable.petitRADTRANS.h5'), 'r') as h:
    wn, k, p, t, w = h['bin_edges'][:], h['kcoeff'], h['p'][:], h['t'][:], h['weights'][:]
    edges = 1e4 / wn[::-1]
    rows = []
    # pressure and temperature nodes the shipped tables keep (every second one: even indices), then pressures between them
    for ip, it in ((10, 10), (16, 14), (4, 24), (9, 10), (15, 14), (5, 24)):
        kk = k[ip, it][::-1]                           # bins in ascending wavelength
        mean = (kk * w).sum(axis=1)                    # bin-mean cross-section of every R = 1000 bin
        for b in (140, 420, 700, 900):                 # merged bin b = source bins 5b .. 5b + 4
            rows.append(dict(kept=ip % 2 == 0, p=float(p[ip]), t=float(t[it]), bin=b, lo=float(edges[5 * b]), hi=float(edges[5 * b + 5]), mean=float(mean[5 * b:5 * b + 5].mean())))
    out['tables'] = dict(species='H2O', rows=rows, grid=[float(edges[0]), float(edges[-1]), len(edges) - 1])
# The source at temperature nodes the shipped tables drop (odd indices), at a pressure they keep, reduced as the
# shipped tables are (tools/opacity/build_opacity.py: 5 bins joined, 12 g-points, log mean): the mean over g of each bin.
# What the shipped table gives there by interpolation is compared with this in test/opacity.test.mjs.
import sys
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'tools', 'opacity'))
import build_opacity as B
bins = [int(v) for v in np.linspace(140, 740, 61)]   # merged bins, 0.6 to 12 micron
tin = dict(p=None, bins=bins, species={})
for sp in ('H2O', 'CO', 'CO2', 'CH4', 'TiO'):
    wl_e, p, t, k, nodes, w, doi = B.read_exomol_k(sp)
    tin['p'] = float(p[10]); its = (7, 9, 11, 13, 15, 17)
    means = []
    for it in its:
        red, gn, wn = B.rebin_k(k[10:11, it:it + 1], w, merge=5, ng=12, method='log')
        mean = (red[0, 0] * wn).sum(axis=-1)
        means.append([sig(mean[b], 6) for b in bins])
    tin['species'][sp] = dict(t=[float(t[i]) for i in its], mean=means)
    del k
out['tinterp'] = tin
def cia_at(pair, T, wl):
    path = os.path.join(src, 'hitran-cia', pair + '_2011.cia')
    with open(path) as f:
        while True:
            head = f.readline()
            if not head: return None
            n, Tb = int(head[40:47]), float(head[47:54])
            block = [f.readline() for _ in range(n)]
            if abs(Tb - T) < 1e-6:
                a = np.loadtxt(block)
                if a[0, 0] <= 1e4 / wl <= a[-1, 0]: return float(np.interp(1e4 / wl, a[:, 0], a[:, 1]))
out['cia'] = [dict(pair=pair, t=T, wl=wl, k=cia_at(pair, T, wl)) for pair in ('H2-H2', 'H2-He') for T in (500.0, 1000.0, 2000.0) for wl in (2.2, 5.0, 12.0)]
json.dump(out, open(os.path.join(HERE, 'rt_reference.json'), 'w'), separators=(',', ':'))
print('wrote rt_reference.json')
