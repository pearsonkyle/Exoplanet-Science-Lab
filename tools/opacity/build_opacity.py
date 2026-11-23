"""Build the app's opacity tables (ESLO files, src/core/opacity.js) from ExoMolOP and HITRAN source files.

Run:  .venv-rt/bin/python tools/opacity/build_opacity.py --help
Sources, in the untracked folder data-src/ (URLs and sizes in tools/opacity/README.md):
  data-src/exomol/*.ktable.petitRADTRANS.h5   ExoMolOP k-tables at R = 1000, 16 g-points, 0.3-50 micron, 27 T x 22 P
                                        (Chubb et al. 2021, A&A 646, A21; CC BY-SA 4.0). The source of what ships.
  data-src/exomol/*.xsec.TauREx.h5      ExoMolOP cross-sections at R = 15000 (same grid). Used by the study only:
                                        they overestimate absorption where lines are narrower than R = 15000
                                        (docs/guide/validation.md, Atmosphere)
  data-src/hitran-cia/*.cia             HITRAN collision-induced absorption (Karman et al. 2019, Icarus 328, 160)

Three kinds of table (see src/core/opacity.js for the file layout):
  xsec    the source cross-sections sampled at n points uniform in ln(wavelength): the nearest source point,
          no averaging (opacity sampling)
  ktable  k-coefficients. From the ExoMolOP k-tables (--from ktable, the default): `merge` neighbouring bins are
          joined (their k-distributions pooled and resorted) and the result is put on ng g-points. From the
          R = 15000 points (--from xsec): the sorted points of a bin define k(g). Each g-node stands for its weight
          interval: --method log (default) gives it exp of the mean of ln k there, --method mean the mean of k
          (which keeps the bin's mean opacity exactly), --method point the value at the node.
          Nodes: Gauss-Legendre, half on [0, 0.9] and half on [0.9, 1] (as in the ExoMolOP tables).
  cia     HITRAN CIA interpolated onto the wavelength grid, per temperature
"""
import argparse, json, os, struct, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, 'data-src')
LICENCE = 'CC BY-SA 4.0'

# species -> (file stem in data-src/exomol, line list); the path on exomol.com is in tools/opacity/README.md
EXOMOL = {
    'H2O': ('1H2-16O__POKAZATEL__', 'POKAZATEL (Polyansky et al. 2018)'),
    'CO2': ('12C-16O2__UCL-4000.', 'UCL-4000 (Yurchenko et al. 2020)'),
    'CO': ('12C-16O__Li2015.', 'Li2015 (Li et al. 2015)'),
    'CH4': ('12C-1H4__YT34to10.', 'YT34to10 (Yurchenko et al. 2017)'),
    'NH3': ('14N-1H3__CoYuTe.', 'CoYuTe (Coles et al. 2019)'),
    'HCN': ('1H-12C-14N__Harris.', 'Harris (Harris et al. 2006; Barber et al. 2014)'),
    'SO2': ('32S-16O2__ExoAmes.', 'ExoAmes (Underwood et al. 2016)'),
    'H2S': ('1H2-32S__AYT2.', 'AYT2 (Azzam et al. 2016)'),
    'Na': ('23Na__Kurucz-Na.', 'Kurucz lines with the resonance-doublet broadening of Allard et al. (2019)'),
    'K': ('39K__Kurucz-K.', 'Kurucz lines with the resonance-doublet broadening of Allard et al. (2016)'),
    'TiO': ('48Ti-16O__Toto.', 'Toto (McKemmish et al. 2019), 48Ti16O only'),
    'VO': ('51V-16O__VOMYT.', 'VOMYT (McKemmish et al. 2016)'),
}
DOI_FIX = {'CO2': '10.1093/mnras/staa1874'}   # Yurchenko et al. 2020, MNRAS 496, 5282 (UCL-4000)
STUDY_SPECIES = ['H2O', 'CO2', 'CO', 'CH4']   # the four whose R = 15000 cross-sections were also downloaded
XSEC, KTAB = 'R15000_0.3-50mu.xsec.TauREx.h5', 'R1000_0.3-50mu.ktable.petitRADTRANS.h5'


def split_gauss(ng, split=0.9):
    """Nodes and weights on [0, 1]: ng/2 Gauss-Legendre points on [0, split], ng/2 on [split, 1]."""
    x, w = np.polynomial.legendre.leggauss(ng // 2)
    lo, hi = 0.5 * split * (x + 1), split + 0.5 * (1 - split) * (x + 1)
    return np.concatenate([lo, hi]), np.concatenate([0.5 * split * w, 0.5 * (1 - split) * w])


def read_exomol(species):
    """Returns wl [micron, ascending], p [bar], t [K], xsec[p, t, wl] in cm^2 per molecule."""
    import h5py
    path = os.path.join(SRC, 'exomol', EXOMOL[species][0] + XSEC)
    with h5py.File(path, 'r') as h:
        wn, p, t, x = h['bin_edges'][:], h['p'][:], h['t'][:], h['xsecarr'][:]
        doi = h['DOI'][0]
    doi = doi.decode() if isinstance(doi, bytes) else str(doi)
    order = np.argsort(1e4 / wn)
    return 1e4 / wn[order], p, t, x[:, :, order], doi


def read_exomol_k(species):
    """ExoMolOP k-table: wavelength bin edges [micron, ascending], p [bar], t [K], k[p, t, bin, g] in cm^2 per
    molecule, g-nodes, weights, DOI."""
    import h5py
    with h5py.File(os.path.join(SRC, 'exomol', EXOMOL[species][0] + KTAB), 'r') as h:
        wn, k, p, t = h['bin_edges'][:], h['kcoeff'][:], h['p'][:], h['t'][:]
        nodes, weights, doi = h['samples'][:], h['weights'][:], h['DOI'][0]
    doi = doi.decode() if isinstance(doi, bytes) else str(doi)
    if not doi.startswith('10.'): doi = DOI_FIX.get(species, doi)   # ExoMol's CO2 file carries a placeholder
    return 1e4 / wn[::-1], p, t, k[:, :, ::-1, :], nodes, weights, doi


# Resonance lines of the alkali atoms: wavenumber [cm^-1] and absorption oscillator strength (NIST Atomic Spectra
# Database), in doublets. The strength of a line integrated over frequency is (pi e^2 / m_e c) f whatever its width.
RESONANCE = {
    'Na': [[(16956.170, 0.320), (16973.366, 0.641)], [(30266.99, 0.0045), (30272.58, 0.0090)]],
    'K': [[(12985.185, 0.333), (13042.896, 0.670)], [(24701.38, 0.00263), (24720.13, 0.00569)]],
}
ATOM_MASS = {'Na': 22.98977, 'K': 39.0983}
S_PER_F = 8.8523e-13   # pi e^2 / (m_e c^2) [cm]: integrated cross-section in cm^2 cm^-1 per unit oscillator strength


def repair_resonance(species, edges, p, t, k, weights, log=None):
    """Put the cores of the alkali resonance lines back on their physical strength.

    ExoMolOP's Na and K k-tables do not conserve line strength: integrated over the D lines the cross-section is right
    at 10 bar and grows as 1 / pressure below it (17 times too large at 0.1 bar, 1.7e5 times at 1e-5 bar for sodium at
    1000 K; tools/opacity/README.md has the table). The far wings scale with pressure as they should; the excess is
    in the bins that hold the line centres, as if a narrow core had been given the width of a grid step. Here, for
    every pressure and temperature at which a doublet's integrated strength exceeds 1.3 times (pi e^2 / m_e c) f, the
    bins within `half` cm^-1 of the doublet are replaced by the k-distribution of two Voigt profiles: Doppler width
    from the temperature, Lorentz width chosen so that the profile meets the table's own wings at the edge of the
    replaced region (so the wings, which carry Allard's broadening, are kept), strength from the oscillator strengths
    with stimulated emission. Each g-node gets the mean of k over its interval of g, so every bin's mean is the
    profile's. Returns the repaired k and a list of (doublet, p, t, strength ratio before, after, gamma)."""
    from scipy.special import wofz
    k = np.array(k, dtype=float); wn_edges = 1e4 / np.asarray(edges)   # descending wavenumber; bin b spans wn_edges[b+1]..wn_edges[b]
    centre = 0.5 * (wn_edges[:-1] + wn_edges[1:]); width = wn_edges[:-1] - wn_edges[1:]; cum = np.concatenate([[0.0], np.cumsum(weights)]); notes = []
    for pair in RESONANCE[species]:
        mid = np.mean([nu for nu, _ in pair]); half = 200.0 if pair[0][1] > 0.1 else 40.0
        reg = np.where(np.abs(centre - mid) < half)[0]
        if not len(reg): continue
        lo_b, hi_b = reg[0] - 1, reg[-1] + 1   # the bins just outside, on the blue (higher wavenumber: lower index) and red sides
        for it, T in enumerate(t):
            stim = [1 - np.exp(-1.438777 * nu / T) for nu, _ in pair]
            S = [S_PER_F * f * st for (nu, f), st in zip(pair, stim)]; s_phys = sum(S)
            sig = [nu * np.sqrt(1.380649e-16 * T / (ATOM_MASS[species] * 1.66053907e-24)) / 2.99792458e10 for nu, _ in pair]   # Doppler standard deviation [cm^-1]
            for ip, P in enumerate(p):
                mean = (k[ip, it, reg] * weights).sum(axis=1); s_tab = float((mean * width[reg]).sum())
                if not s_tab > 1.3 * s_phys: continue
                # Lorentz half-width from the table's wings beside the region: sigma = sum S gamma / (pi d^2)
                g = []
                for b in (lo_b, hi_b):
                    if 0 <= b < len(centre):
                        m_out = float((k[ip, it, b] * weights).sum()); den = sum(Si / (centre[b] - nu) ** 2 for Si, (nu, _) in zip(S, pair))
                        if m_out > 0: g.append(m_out * np.pi / den)
                gamma = float(np.exp(np.mean(np.log(g)))) if g else 1e-3 * P
                for b in reg:
                    a, c = wn_edges[b + 1], wn_edges[b]
                    # sample the bin: evenly, and densely about any line centre inside or near it
                    x = [np.linspace(a, c, 400)]
                    for (nu, _), sg in zip(pair, sig):
                        if a - 5 < nu < c + 5:
                            d = np.concatenate([[0.0], np.logspace(np.log10(min(sg, gamma) / 30), np.log10(max(c - a, 10.0)), 500)])
                            x += [nu + d, nu - d]
                    x = np.unique(np.clip(np.concatenate(x), a, c))
                    y = np.zeros_like(x)
                    for (nu, _), Si, sg in zip(pair, S, sig):
                        y += Si * wofz(((x - nu) + 1j * gamma) / (sg * np.sqrt(2))).real / (sg * np.sqrt(2 * np.pi))
                    # k-distribution: each sample stands for half the gaps to its neighbours
                    wx = np.empty_like(x); wx[1:-1] = 0.5 * (x[2:] - x[:-2]); wx[0] = 0.5 * (x[1] - x[0]); wx[-1] = 0.5 * (x[-1] - x[-2])
                    o = np.argsort(y); ys, ws = y[o], wx[o] / wx.sum(); cg = np.concatenate([[0.0], np.cumsum(ws)]); area = np.concatenate([[0.0], np.cumsum(ys * ws)])
                    A = np.interp(cum, cg, area)   # integral of k dg up to each node boundary (k is a step function of g)
                    k[ip, it, b] = np.maximum(np.diff(A) / np.diff(cum), 1e-300)
                after = float(((k[ip, it, reg] * weights).sum(axis=1) * width[reg]).sum())
                notes.append((round(float(mid)), float(P), float(T), s_tab / s_phys, after / s_phys, gamma))
    if log is not None and notes:
        for mid in sorted({n[0] for n in notes}):
            sel = [n for n in notes if n[0] == mid]; before = [n[3] for n in sel]; aft = [n[4] for n in sel]
            log(f'  {species} doublet at {mid} cm-1: {len(sel)} of {len(p) * len(t)} (P, T) nodes repaired; strength over the sum rule {min(before):.1f} to {max(before):.3g} before, {min(aft):.2f} to {max(aft):.2f} after')
    return k, notes


def rebin_k(k, weights, merge=1, ng=None, method='mean'):
    """Join `merge` neighbouring bins of k[..., bin, g] and put the result on ng split-Gauss g-points.
    Each bin's k(g) is a step function (value k_q over a width w_q). The pooled distribution of the joined bins is
    those steps, each bin with weight 1 / merge, sorted by k; a new node gets its mean over the node's interval."""
    ng = ng or k.shape[-1]
    nb = (k.shape[-2] // merge) * merge
    v = k[..., :nb, :].reshape(k.shape[:-2] + (nb // merge, merge * k.shape[-1]))
    w = np.tile(np.asarray(weights) / merge, merge)
    if merge == 1 and ng == k.shape[-1]:
        return v, *split_gauss(ng)
    order = np.argsort(v, axis=-1)
    vs = np.take_along_axis(v, order, axis=-1)
    ws = w[order]
    G = np.cumsum(ws, axis=-1)                       # right edge of each step
    nodes, wn = split_gauss(ng)
    if method == 'point':
        # the value of k(g) at each new node: log-linear between the midpoints of the sorted steps
        mid = G - 0.5 * ws
        out = np.zeros(v.shape[:-1] + (ng,))
        last = v.shape[-1] - 1
        lv = np.log(np.maximum(vs, 1e-300))
        for q in range(ng):
            i = np.clip((mid < nodes[q]).sum(axis=-1, keepdims=True), 1, last)
            g0, g1 = np.take_along_axis(mid, i - 1, -1), np.take_along_axis(mid, i, -1)
            f = np.clip((nodes[q] - g0) / np.maximum(g1 - g0, 1e-300), 0, 1)
            out[..., q] = np.exp(np.take_along_axis(lv, i - 1, -1) * (1 - f) + np.take_along_axis(lv, i, -1) * f)[..., 0]
        return out, nodes, wn
    edges = np.concatenate([[0], np.cumsum(wn)]); edges[-1] = 1.0
    last = v.shape[-1] - 1

    def interval_means(vals):
        """Mean of the step function `vals` (sorted like vs) over each new node's interval of g."""
        C = np.cumsum(vals * ws, axis=-1)            # integral up to the right edge of each step
        Cg = np.zeros(v.shape[:-1] + (ng + 1,))
        for q in range(1, ng + 1):
            i = np.minimum((G < edges[q] - 1e-12).sum(axis=-1, keepdims=True), last)   # the step that holds this g
            prevG = np.where(i > 0, np.take_along_axis(G, np.maximum(i - 1, 0), -1), 0.0)
            prevC = np.where(i > 0, np.take_along_axis(C, np.maximum(i - 1, 0), -1), 0.0)
            Cg[..., q] = (prevC + (edges[q] - prevG) * np.take_along_axis(vals, i, -1))[..., 0]
        return np.diff(Cg, axis=-1) / wn

    out = interval_means(vs)
    if method == 'log':
        # exp of the mean of ln k: an interval's transmittance follows its typical k, not its largest (the same choice
        # as `overlap` in src/core/opacity.js makes when species are combined). An interval that reaches down to
        # "no opacity" keeps the plain mean.
        tiny = 1e-45
        geo = np.exp(interval_means(np.log(np.maximum(vs, tiny))))
        out = np.where(interval_means((vs <= tiny).astype(float)) > 0, out, geo)
    # means over successive intervals of a sorted step function are sorted; rounding in the differences can break that by 1e-16
    return np.maximum.accumulate(out, axis=-1), nodes, wn


def log_points(wl_min, wl_max, n):
    return wl_min * np.exp(np.log(wl_max / wl_min) * np.arange(n) / max(1, n - 1))


def log_edges(wl_min, wl_max, n):
    return wl_min * np.exp(np.log(wl_max / wl_min) * np.arange(n + 1) / n)


def n_for(R, wl_min, wl_max):
    return int(round(R * np.log(wl_max / wl_min)))


def sample(wl_src, x, wl):
    """Nearest source point for every target wavelength."""
    i = np.clip(np.searchsorted(wl_src, wl), 1, len(wl_src) - 1)
    i = np.where(np.abs(wl_src[i - 1] - wl) < np.abs(wl_src[i] - wl), i - 1, i)
    return x[..., i]


def kdist(wl_src, x, edges, ng):
    """k-coefficients [..., bin, g] from the source points inside each bin."""
    nodes, weights = split_gauss(ng)
    G = np.concatenate([[0], np.cumsum(weights)]); G[-1] = 1.0
    out = np.zeros(x.shape[:-1] + (len(edges) - 1, ng))
    idx = np.searchsorted(wl_src, edges)
    for b in range(len(edges) - 1):
        a, c = idx[b], idx[b + 1]
        if c - a < 2:   # too few points: grey bin from the nearest point
            j = min(max(a, 0), len(wl_src) - 1)
            out[..., b, :] = x[..., j][..., None]
            continue
        s = np.sort(x[..., a:c], axis=-1)
        m = s.shape[-1]
        # cumulative integral of the sorted values as a piecewise-linear function of g (each sample holds 1/m)
        C = np.concatenate([np.zeros(s.shape[:-1] + (1,)), np.cumsum(s, axis=-1) / m], axis=-1)
        pos = G * m
        i0 = np.minimum(pos.astype(int), m - 1)
        frac = pos - i0
        Cg = C[..., i0] + frac * (C[..., i0 + 1] - C[..., i0])
        out[..., b, :] = np.diff(Cg, axis=-1) / weights
    return out, nodes, weights


CIA_FILES = {'H2-H2': 'H2-H2_2011', 'H2-He': 'H2-He_2011', 'N2-N2': 'N2-N2_2021', 'N2-CH4': 'N2-CH4_2024', 'N2-H2': 'N2-H2_2024'}
CIA_REFS = {   # the source of each file's main band, from HITRAN's CIA readme (hitran.org/data/CIA/CIA_Readme_2024.pdf)
    'H2-H2': ('Karman et al. 2019, Icarus 328, 160', '10.1016/j.icarus.2019.02.034'), 'H2-He': ('Karman et al. 2019, Icarus 328, 160', '10.1016/j.icarus.2019.02.034'),
    'N2-N2': ('Chistikov et al. 2019, J. Chem. Phys. 151, 194106 (far infrared); Baranov, Lafferty & Fraser 2005 and Lafferty et al. 1996 (fundamental); HITRAN: Karman et al. 2019', '10.1063/1.5125756'),
    'N2-CH4': ('Finenko et al. 2022, ApJS 258, 33; HITRAN2024: Terragni et al. 2025, JQSRT 347, 109631', '10.3847/1538-4365/ac36d3'),
    'N2-H2': ('HITRAN2024 CIA: Terragni et al. 2025, JQSRT 347, 109631', '10.1016/j.jqsrt.2025.109631')}


def read_cia(pair):
    """HITRAN .cia: returns t [K], wn [cm^-1], k[t, wn] in cm^5 per molecule pair (zero where not tabulated).

    A file holds several bands (for N2-N2: the far-infrared band at 70-400 K, the fundamental near 4.3 micron at
    228-363 K, the overtone near 2.1 micron at 200-330 K), each measured or computed at its own temperatures. Blocks
    whose wavenumber ranges overlap are one band. Each band is interpolated linearly in temperature between its own
    temperatures and held at its end values outside them; the bands are then added on the temperatures of the band
    that has the most. (Taking the temperatures of all blocks together, as an earlier version did, would interpolate a
    band toward zero at a temperature where only another band is tabulated.)"""
    path = os.path.join(SRC, 'hitran-cia', CIA_FILES[pair] + '.cia')
    temps, blocks = [], []
    with open(path) as f:
        while True:
            head = f.readline()
            if not head: break
            n, T = int(head[40:47]), float(head[47:54])
            arr = np.loadtxt([f.readline() for _ in range(n)])
            temps.append(T); blocks.append(arr)
    wn = np.unique(np.concatenate([b[:, 0] for b in blocks]))
    bands = []   # each: [lo, hi, {T: values on wn}]
    for T, b in sorted(zip(temps, blocks), key=lambda x: x[1][0, 0]):
        lo, hi, v = b[0, 0], b[-1, 0], np.interp(wn, b[:, 0], np.maximum(b[:, 1], 0), left=0, right=0)
        for band in bands:
            if lo <= band[1] and hi >= band[0]:
                band[0], band[1] = min(band[0], lo), max(band[1], hi)
                band[2][T] = np.maximum(band[2].get(T, 0), v); break
        else:
            bands.append([lo, hi, {T: v}])
    ts = np.array(sorted(max(bands, key=lambda x: len(x[2]))[2]))
    k = np.zeros((len(ts), len(wn)))
    for _, _, per in bands:
        bt = np.array(sorted(per)); stack = np.array([per[T] for T in bt])
        for i, T in enumerate(ts):
            j = np.clip(np.searchsorted(bt, T) - 1, 0, max(len(bt) - 2, 0))
            w = 0.0 if len(bt) == 1 else np.clip((T - bt[j]) / (bt[j + 1] - bt[j]), 0, 1)
            k[i] += stack[j] if len(bt) == 1 else (1 - w) * stack[j] + w * stack[j + 1]
    return ts, wn, k, [(float(lo), float(hi), len(per), float(min(per)), float(max(per))) for lo, hi, per in bands]


def write_eslo(path, header, logs, encoding='u16', lo=None, hi=None):
    """logs: log10 values in the order p, t, wl, g (-inf where there is no opacity)."""
    flat = np.asarray(logs, dtype=np.float64).ravel()
    fin = np.isfinite(flat)
    lo = float(flat[fin].min()) if lo is None else lo
    hi = float(flat[fin].max()) if hi is None else hi
    h = dict(header, encoding=dict(type=encoding, lo=lo, hi=hi), order='p,t,wl,g')
    js = json.dumps(h)
    while (12 + len(js.encode())) % 8: js += ' '
    if encoding == 'f16':
        body = flat.astype('<f2').tobytes()
    elif encoding == 'f32':
        body = flat.astype('<f4').tobytes()
    else:
        top = 65535 if encoding == 'u16' else 255
        q = np.zeros(len(flat), dtype='<u2' if encoding == 'u16' else 'u1')
        q[fin] = 1 + np.rint((np.clip(flat[fin], lo, hi) - lo) / ((hi - lo) or 1) * (top - 1)).astype(q.dtype)
        body = q.tobytes()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'ESLO' + struct.pack('<II', 1, len(js.encode())) + js.encode() + body)
    return os.path.getsize(path)


def safe_log10(x, floor, clamp=None):
    """log10, with -inf (no opacity) at or below `floor`. With `clamp`, values under it are raised to it first: a
    cross-section below 1e-30 cm^2 is transparent through any atmosphere, and a shorter range makes the integer
    steps finer."""
    if clamp is not None:
        x = np.where(x > floor, np.maximum(x, clamp), x)
    with np.errstate(divide='ignore'):
        out = np.log10(x)
    out[~(x > floor)] = -np.inf
    return out


def build_species(species, out, kind='ktable', R=300, ng=8, wl_min=0.3, wl_max=30.0, t_idx=None, p_idx=None, encoding='u16', floor=1e-40, src=None, merge=None, method='mean', repair=True):
    """merge given: from the ExoMolOP k-table (src = read_exomol_k(...)), keeping its wavelength range.
    Otherwise from the R = 15000 cross-sections (src = read_exomol(...)) on a grid of resolving power R."""
    if merge:
        edges, p, t, k, nodes0, w0, doi = src or read_exomol_k(species)
        if species in RESONANCE and repair:
            k, _ = repair_resonance(species, edges, p, t, k, w0, log=print)
        ti = np.arange(len(t)) if t_idx is None else np.asarray(t_idx)
        pi = np.arange(len(p)) if p_idx is None else np.asarray(p_idx)
        vals, nodes, weights = rebin_k(k[np.ix_(pi, ti)], w0, merge, ng, method)
        n = vals.shape[-2]
        fixed = ' (resonance-line cores recomputed to conserve line strength: tools/opacity/README.md)' if species in RESONANCE and repair else ''
        header = dict(kind='ktable', species=species, source=f'ExoMolOP {EXOMOL[species][1]}, R = 1000 k-table, {merge} bins joined, {ng} g-points' + fixed, doi=doi, licence=LICENCE,
                      wl=dict(min=float(edges[0]), max=float(edges[n * merge]), n=n), t=[float(v) for v in t[ti]], p=[float(v) for v in p[pi]],
                      ng=ng, nodes=[float(v) for v in nodes], weights=[float(v) for v in weights], units='log10 cm^2 per molecule')
        return write_eslo(out, header, safe_log10(vals, floor, 1e-30), encoding)
    wl_src, p, t, x, doi = src or read_exomol(species)
    ti = np.arange(len(t)) if t_idx is None else np.asarray(t_idx)
    pi = np.arange(len(p)) if p_idx is None else np.asarray(p_idx)
    x = x[np.ix_(pi, ti)]
    n = n_for(R, wl_min, wl_max)
    header = dict(kind=kind, species=species, source='ExoMolOP ' + EXOMOL[species][1] + ', R = 15000 cross-sections', doi=doi, licence=LICENCE,
                  wl=dict(min=wl_min, max=wl_max, n=n), t=[float(v) for v in t[ti]], p=[float(v) for v in p[pi]], units='log10 cm^2 per molecule')
    if kind == 'xsec':
        vals = sample(wl_src, x, log_points(wl_min, wl_max, n))[..., None]
        header['ng'] = 1
    else:
        vals, nodes, weights = kdist(wl_src, x, log_edges(wl_min, wl_max, n), ng)
        header.update(ng=ng, nodes=[float(v) for v in nodes], weights=[float(v) for v in weights])
    return write_eslo(out, header, safe_log10(vals, floor), encoding)


def build_cia(pair, out, R=300, wl_min=0.3, wl_max=30.0, kind='ktable', encoding='u16', t_max=4000.0, t_step=2, n=None):
    ts, wn, k, bands = read_cia(pair)
    keep = thin(len(np.where(ts <= t_max)[0]), t_step)
    n = n or n_for(R, wl_min, wl_max)
    if kind == 'xsec':
        wl = log_points(wl_min, wl_max, n)
        vals = np.array([np.interp(1e4 / wl, wn, k[i], left=0, right=0) for i in keep])
    else:   # mean over each bin (the CIA spectrum is smooth, so a grey value per bin is enough)
        e = log_edges(wl_min, wl_max, n)
        vals = np.zeros((len(keep), n))
        for a, i in enumerate(keep):
            fine = 1e4 / np.exp(np.linspace(np.log(e[0]), np.log(e[-1]), 8 * n + 1))
            v = np.interp(fine, wn, k[i], left=0, right=0)
            vals[a] = 0.5 * (v[:-1] + v[1:]).reshape(n, 8).mean(axis=1)
    ref = CIA_REFS[pair]
    header = dict(kind='cia', species=pair, source='HITRAN CIA ' + CIA_FILES[pair] + '.cia (' + ref[0] + ')', doi=ref[1], licence='HITRAN (see hitran.org; cite the reference and the original sources named in the file)', bands=[dict(wn=[b[0], b[1]], t=[b[3], b[4]]) for b in bands],
                  wl=dict(min=wl_min, max=wl_max, n=n), binned=kind != 'xsec', t=[float(v) for v in ts[keep]], ng=1, units='log10 cm^5 per molecule pair')
    return write_eslo(out, header, safe_log10(vals[None, :, :, None], 1e-60), encoding)


def thin(n, step):
    """Every step-th index, always keeping the last one (so the grid's range is unchanged)."""
    i = np.arange(n)[::step]
    return i if i[-1] == n - 1 else np.append(i, n - 1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--species', nargs='*', default=list(EXOMOL))
    ap.add_argument('--merge', type=int, default=5, help='ExoMolOP R = 1000 bins joined into one (5: R = 200)')
    ap.add_argument('--ng', type=int, default=12)
    ap.add_argument('--method', default='log', choices=['point', 'mean', 'log'], help='k at the new g-nodes: its value there, its mean over the node interval, or exp of the mean of ln k')
    ap.add_argument('--encoding', default='u8', choices=['u16', 'u8', 'f16'])
    ap.add_argument('--t-step', type=int, default=2, help='keep every n-th temperature node')
    ap.add_argument('--p-step', type=int, default=2, help='keep every n-th pressure node')
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'opacity'))
    ap.add_argument('--no-repair', action='store_true', help='keep the Na and K resonance-line cores as ExoMolOP has them (they do not conserve line strength below 10 bar)')
    ap.add_argument('--cia', nargs='*', default=None, help='build only these CIA pairs (e.g. N2-N2 N2-CH4 N2-H2) on the grid of the tables already in --out, and add them to index.json')
    a = ap.parse_args()
    if a.cia is not None:
        index = json.load(open(os.path.join(a.out, 'index.json')))
        with open(os.path.join(a.out, index['tables'][0]['file']), 'rb') as f:
            f.seek(8); n_head = int.from_bytes(f.read(4), 'little'); g = json.loads(f.read(n_head))['wl']
        for pair in a.cia:
            size = build_cia(pair, os.path.join(a.out, pair + '.eslo'), wl_min=g['min'], wl_max=g['max'], n=g['n'], encoding='u16', t_step=2 if pair.startswith('H2') else 1)
            ref = CIA_REFS[pair]
            index['tables'] = [t for t in index['tables'] if t['species'] != pair] + [dict(file=pair + '.eslo', species=pair, kind='cia', bytes=size, source='HITRAN collision-induced absorption, ' + CIA_FILES[pair] + '.cia (' + ref[0] + ')', doi=ref[1], licence='HITRAN')]
            print(f'{pair:7s} {size / 1e6:7.2f} MB')
        index['total'] = sum(t['bytes'] for t in index['tables'])
        json.dump(index, open(os.path.join(a.out, 'index.json'), 'w'), indent=1)
        raise SystemExit(0)
    total, grid, index = 0, None, []
    for sp in a.species:
        src = read_exomol_k(sp)
        size = build_species(sp, os.path.join(a.out, sp + '.eslo'), ng=a.ng, t_idx=thin(len(src[2]), a.t_step), p_idx=thin(len(src[1]), a.p_step), encoding=a.encoding, src=src, merge=a.merge, method=a.method, repair=not a.no_repair)
        n = (len(src[0]) - 1) // a.merge
        grid = (float(src[0][0]), float(src[0][n * a.merge]), n)
        total += size; print(f'{sp:5s} {size / 1e6:7.2f} MB')
        index.append(dict(file=sp + '.eslo', species=sp, kind='ktable', bytes=size, source='ExoMolOP (Chubb et al. 2021, A&A 646, A21), line list ' + EXOMOL[sp][1], doi=src[6], licence=LICENCE))
    if set(a.species) != set(EXOMOL):   # some gases only: put them into the index that is there, leave the rest
        old = json.load(open(os.path.join(a.out, 'index.json')))
        old['tables'] = [next((n for n in index if n['species'] == x['species']), x) for x in old['tables']]
        old['total'] = sum(x['bytes'] for x in old['tables'])
        json.dump(old, open(os.path.join(a.out, 'index.json'), 'w'), indent=1)
        print('index.json updated for', ', '.join(a.species)); raise SystemExit(0)
    for pair in ('H2-H2', 'H2-He'):
        size = build_cia(pair, os.path.join(a.out, pair + '.eslo'), wl_min=grid[0], wl_max=grid[1], n=grid[2], encoding='u16')
        total += size; print(f'{pair:5s} {size / 1e6:7.2f} MB')
        index.append(dict(file=pair + '.eslo', species=pair, kind='cia', bytes=size, source='HITRAN collision-induced absorption, ' + pair + '_2011.cia (Karman et al. 2019, Icarus 328, 160)', doi='10.1016/j.icarus.2019.02.034', licence='HITRAN'))
    # what the page loads, and the attribution it shows (ExoMol data are CC BY-SA 4.0: the tables carry that licence)
    json.dump(dict(R=round(1000 / a.merge), ng=a.ng, encoding=a.encoding, tables=index, total=total), open(os.path.join(a.out, 'index.json'), 'w'), indent=1)
    print(f'total {total / 1e6:.2f} MB in {a.out}')
