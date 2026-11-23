// What "Download everything" on the Atmosphere page puts in its zip: the model as it was run, every quantity the
// page plots as a CSV file, and a Python script (numpy + matplotlib only) that redraws the figures from them.
// Pure: bundleFiles(...) -> [{ name, data: string }]; no DOM, so test/bundle.test.mjs runs it in Node.
import { K_B, M_U } from '../core/atmosphere.js';
import { SPECIES_COLOURS } from './plots.js';

const num = (v, d = 6) => (v == null || !Number.isFinite(v) ? '' : v === 0 ? '0' : Math.abs(v) >= 1e-3 && Math.abs(v) < 1e5 ? String(+v.toPrecision(d)) : v.toExponential(d - 1));
const csv = (head, rows) => head.join(',') + '\n' + rows.map((r) => r.map((v) => (typeof v === 'number' ? num(v) : v ?? '')).join(',')).join('\n') + '\n';
const safe = (name) => name.replace(/[^A-Za-z0-9+-]/g, '_');

/**
 * b = { name, model (as sent to the worker), result (the worker's 'result' message), parts: { name: { depth, fpfs } },
 *       decades: [{ layer, p, t, wl, parts: [{ name, y }], total }] (opacityByAbsorber at one layer per decade of pressure),
 *       index (opacity/index.json), colour (colourData of the page), stamp (ISO time), page (URL) }
 */
export function bundleFiles(b) {
  const r = b.result, a = r.atm, n = a.n, nWl = r.wl.length, files = [], gases = Object.keys(a.species), partNames = Object.keys(b.parts || {});
  files.push({ name: 'model.json', data: JSON.stringify({ format: 'esl-atmosphere-model', version: 1, name: b.name, saved: b.stamp, page: b.page, model: b.model, climate: r.climate || null,
    tables: b.index ? { R: b.index.R, ng: b.index.ng, sources: b.index.tables.map((t) => ({ species: t.species, source: t.source, doi: t.doi, licence: t.licence })) } : null }, null, 1) + '\n' });
  // the spectrum, with the spectrum each gas would give alone
  files.push({ name: 'spectrum.csv', data: csv(['wavelength_micron', 'bin_lo_micron', 'bin_hi_micron', 'transit_depth', 'eclipse_depth', 'planet_flux_W_m2_micron', 'brightness_temperature_K', 'geometric_albedo_estimate', 'top_ray_optical_depth',
    ...partNames.map((p) => 'transit_depth_' + safe(p) + '_alone'), ...partNames.map((p) => 'eclipse_depth_' + safe(p) + '_alone')],
    Array.from({ length: nWl }, (_, i) => [r.wl[i], r.edges ? r.edges[i] : null, r.edges ? r.edges[i + 1] : null, r.depth[i], r.fpfs ? r.fpfs[i] : null, r.flux ? r.flux[i] : null, r.brightness ? r.brightness[i] : null, r.albedo ? r.albedo[i] : null, r.topTau ? r.topTau[i] : null,
      ...partNames.map((p) => b.parts[p].depth && b.parts[p].depth[i]), ...partNames.map((p) => b.parts[p].fpfs && b.parts[p].fpfs[i])])) });
  // structure and composition, one row per layer (top first)
  const io = a.ionization || {}, ions = ['Na', 'K', 'H'].filter((k) => io[k] && a.species[k]);
  files.push({ name: 'profile.csv', data: csv(['pressure_bar', 'temperature_K', ...(r.day ? ['temperature_day_K'] : []), ...(r.night ? ['temperature_night_K'] : []), 'altitude_km', 'gravity_m_s2', 'mean_molecular_weight', 'scale_height_km', ...gases.map((g) => 'vmr_' + safe(g)), ...ions.map((k) => 'vmr_' + k + '+')],
    Array.from({ length: n }, (_, j) => [a.pLay[j] / 1e5, a.tLay[j], ...(r.day ? [r.day.tLay[j]] : []), ...(r.night ? [r.night.tLay[j]] : []), (a.rLay[j] - a.rLev[n]) / 1e3, a.g[j], a.mu[j], (K_B * a.tLay[j]) / (a.mu[j] * M_U * a.g[j]) / 1e3,
      ...gases.map((g) => a.species[g][j]), ...ions.map((k) => (io[k].neutral[j] > 0 ? (a.species[k][j] * io[k].ion[j]) / io[k].neutral[j] : 0))])) });
  // opacity by absorber, as optical depth per scale height: one level per decade of pressure, every wavelength
  const dec = b.decades || [], names = [...new Set(dec.flatMap((d) => d.parts.map((p) => p.name)))], rows = [];
  for (const d of dec) { const H = (K_B * d.t) / (a.mu[d.layer] * M_U * a.g[d.layer]), col = Object.fromEntries(d.parts.map((p) => [p.name, p.y])); for (let i = 0; i < d.wl.length; i++) rows.push([d.p, d.t, d.wl[i], d.total[i] * H, ...names.map((k) => (col[k] ? col[k][i] * H : 0))]); }
  files.push({ name: 'opacity_by_absorber.csv', data: csv(['pressure_bar', 'temperature_K', 'wavelength_micron', 'all', ...names.map(safe)], rows) });
  // the two maps: transmittance of the limb at every level, and where the emission comes from in every layer
  const grid = (z, nP) => Array.from({ length: nWl }, (_, i) => [r.wl[i], ...Array.from({ length: nP }, (_, k) => +z[i * (n + 1) + k].toPrecision(4))]);
  if (r.trans) files.push({ name: 'limb_transmittance.csv', data: csv(['wavelength_micron', ...Array.from(a.pLev, (p) => 'P_' + num(p / 1e5, 4) + '_bar')], grid(r.trans, n + 1)) });
  if (r.contribution) files.push({ name: 'emission_contribution.csv', data: csv(['wavelength_micron', ...Array.from(a.pLay, (p) => 'P_' + num(p / 1e5, 4) + '_bar')], grid(r.contribution, n)) });
  // how the colour is made
  if (b.colour) {
    const c = b.colour;
    files.push({ name: 'colour.csv', data: csv(['wavelength_nm', 'cie_xbar', 'cie_ybar', 'cie_zbar', ...c.curves.map((k) => safe(k.name))], c.nm.map((v, i) => [v, c.cmf.x[i], c.cmf.y[i], c.cmf.z[i], ...c.curves.map((k) => k.y[i])])) });
    files.push({ name: 'colour.json', data: JSON.stringify({ swatches: c.swatches, how: 'X, Y, Z = sum over wavelength of spectrum x (xbar, ybar, zbar); linear sRGB = M (X, Y, Z) with M = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]; scaled to the brightest channel, then the sRGB transfer curve. Colour-matching functions: the analytic fits of Wyman, Sloan & Shirley (2013) to the CIE 1931 observer.' }, null, 1) + '\n' });
  }
  files.push({ name: 'colours_of_gases.json', data: JSON.stringify(SPECIES_COLOURS, null, 1) + '\n' });
  if (a.condensation) files.push({ name: 'clouds.json', data: JSON.stringify(a.condensation.clouds, null, 1) + '\n' });
  files.push({ name: 'figures.py', data: FIGURES_PY });
  files.push({ name: 'README.txt', data: readme(b, files.map((f) => f.name)) });
  return files;
}

function readme(b, names) {
  return `${b.name}: model atmosphere, Exoplanet Science Lab (Atmosphere page)
saved ${b.stamp} from ${b.page}

Files
  model.json                  the model as it was run (planet, star, temperature profile, gases, clouds), the result of the
                              self-consistent profile if one was solved, and the opacity tables with their sources and licences
  spectrum.csv                per wavelength bin: transit depth, eclipse depth (planet/star flux), planet flux, brightness
                              temperature, the estimated geometric albedo, and the spectrum each gas would give alone
  profile.csv                 per layer, top first: pressure, temperature, altitude above the bottom level, gravity, mean
                              molecular weight, scale height, and the volume mixing ratio of every gas (ions as name+)
  opacity_by_absorber.csv     optical depth per scale height of every absorber at every wavelength, at one level per
                              decade of pressure ("all" is their sum). The page's plot shows one of these levels
  limb_transmittance.csv      share of the starlight that passes the limb at each level (columns) and wavelength (rows)
  emission_contribution.csv   share of the emitted light that comes from each layer (rows sum to 1 with the bottom boundary)
  colour.csv, colour.json     the spectra the true-colour view is made from, the CIE 1931 colour-matching functions they
                              are weighed with, and the resulting sRGB colours
  colours_of_gases.json       the colour each gas has in every plot
  clouds.json                 where condensates form (only with "Condense and rain out")
  figures.py                  python figures.py   redraws the figures from these files (numpy and matplotlib)
In this zip: ${names.join(', ')}, README.txt

To run the model again
  Python:  import esl, json; m = json.load(open("model.json"))["model"]; r = esl.atmosphere(model=m)
  Node:    forwardModel(model, tables) of src/core/rtmodel.js (see docs/guide/atmosphere.md, "From a script")
The model is one-dimensional; its checks and limits are in docs/guide/validation.md, "Atmosphere".
The molecular opacity tables are derived from ExoMol data (CC BY-SA 4.0); cite the line lists named in model.json.
`;
}

const FIGURES_PY = `"""Redraws the figures of the Atmosphere page from the files next to this script.

    python figures.py          writes spectrum.png, structure.png, opacity.png, maps.png, colour.png

Needs numpy and matplotlib. Every number plotted is read from the CSV files; nothing is recomputed.
"""
import json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

COL = {k: v for k, v in json.load(open("colours_of_gases.json")).items() if v}
col = lambda name: COL.get(name.rstrip("+"), "0.4")
def table(path):
    with open(path) as f:
        head = f.readline().strip().split(",")
    return head, np.genfromtxt(path, delimiter=",", skip_header=1, filling_values=np.nan, ndmin=2)

model = json.load(open("model.json"))

# ---- spectrum --------------------------------------------------------------------------------------------------
h, s = table("spectrum.csv"); c = {k: s[:, i] for i, k in enumerate(h)}
fig, ax = plt.subplots(2, 1, figsize=(9, 7), sharex=True)
for a, key, lab in ((ax[0], "transit_depth", "transit depth (ppm)"), (ax[1], "eclipse_depth", "eclipse depth (ppm)")):
    for k in h:
        if k.startswith(key + "_") and k.endswith("_alone"):
            name = k[len(key) + 1:-6]
            a.plot(c["wavelength_micron"], 1e6 * c[k], lw=0.8, color=col(name), label=name)
    a.plot(c["wavelength_micron"], 1e6 * c[key], "k", lw=1.2, label="all")
    a.set_xscale("log"); a.set_ylabel(lab); a.legend(fontsize=7, ncol=6, frameon=False)
ax[1].set_xlabel("wavelength (micron)"); ax[0].set_title(model["name"])
fig.tight_layout(); fig.savefig("spectrum.png", dpi=160); plt.close(fig)

# ---- structure: temperature and composition ------------------------------------------------------------------------
h, p = table("profile.csv"); c = {k: p[:, i] for i, k in enumerate(h)}
fig, ax = plt.subplots(1, 2, figsize=(10, 4.5), sharey=True)
for k, style in (("temperature_K", "k-"), ("temperature_day_K", "C1--"), ("temperature_night_K", "C0--")):
    if k in c: ax[0].plot(c[k], c["pressure_bar"], style, label=k[:-2].replace("_", " "))
ax[0].set_xlabel("temperature (K)"); ax[0].set_ylabel("pressure (bar)"); ax[0].legend(fontsize=8, frameon=False)
for k in h:
    if k.startswith("vmr_") and np.nanmax(c[k]) > 1e-10:
        name = k[4:]; ax[1].plot(np.maximum(c[k], 1e-13), c["pressure_bar"], color=col(name), ls="--" if name.endswith("+") else "-", label=name)
ax[1].set_xscale("log"); ax[1].set_xlim(1e-10, 1.5); ax[1].set_xlabel("volume mixing ratio"); ax[1].legend(fontsize=7, ncol=3, frameon=False)
ax[0].set_yscale("log"); ax[0].invert_yaxis()
fig.tight_layout(); fig.savefig("structure.png", dpi=160); plt.close(fig)

# ---- opacity by absorber, one panel per decade of pressure ----------------------------------------------------------
h, o = table("opacity_by_absorber.csv"); levels = np.unique(o[:, 0])
fig, axs = plt.subplots(len(levels), 1, figsize=(9, 2.2 * len(levels)), sharex=True, squeeze=False)
for a, P in zip(axs[:, 0], levels):
    m = o[:, 0] == P
    for i, k in enumerate(h[4:], start=4):
        if np.nanmax(o[m, i]) > 1e-6: a.plot(o[m, 2], o[m, i], lw=0.8, color=col(k), label=k)
    a.plot(o[m, 2], o[m, 3], "k", lw=1.0, label="all"); a.axhline(1, color="0.5", ls=":", lw=0.8)
    a.set_xscale("log"); a.set_yscale("log"); a.set_ylim(1e-6, 1e8); a.set_ylabel("%.0e bar" % P, fontsize=8); a.legend(fontsize=6, ncol=8, frameon=False, loc="upper right")
axs[-1, 0].set_xlabel("wavelength (micron)"); fig.suptitle("optical depth per scale height", fontsize=10)
fig.tight_layout(); fig.savefig("opacity.png", dpi=140); plt.close(fig)

# ---- maps ---------------------------------------------------------------------------------------------------------------
maps = [(f, t) for f, t in (("limb_transmittance.csv", "transmittance of the limb"), ("emission_contribution.csv", "where the emission comes from")) if __import__("os").path.exists(f)]
fig, axs = plt.subplots(1, len(maps), figsize=(5.5 * len(maps), 4.2), squeeze=False)
for a, (f, title) in zip(axs[0], maps):
    h, z = table(f); P = np.array([float(k[2:-4]) for k in h[1:]])
    im = a.pcolormesh(z[:, 0], P, z[:, 1:].T, shading="auto", cmap="viridis"); fig.colorbar(im, ax=a)
    a.set_xscale("log"); a.set_yscale("log"); a.invert_yaxis(); a.set_xlabel("wavelength (micron)"); a.set_ylabel("pressure (bar)"); a.set_title(title, fontsize=10)
fig.tight_layout(); fig.savefig("maps.png", dpi=160); plt.close(fig)

# ---- colour ---------------------------------------------------------------------------------------------------------------
h, k = table("colour.csv"); sw = json.load(open("colour.json"))["swatches"]
fig, a = plt.subplots(figsize=(8, 3.8))
for i, (name, colr) in enumerate((("x-bar (red)", "#ff6b5b"), ("y-bar (green)", "#55c46a"), ("z-bar (blue)", "#5b8cff")), start=1):
    a.fill_between(k[:, 0], k[:, i], color=colr, alpha=0.18); a.plot(k[:, 0], k[:, i], color=colr, lw=1.2, label=name)
for i, name in enumerate(h[4:], start=4):
    if np.nanmax(k[:, i]) > 0: a.plot(k[:, 0], k[:, i] / np.nanmax(k[:, i]), lw=1.6, color="k", ls=("-", "--", ":")[(i - 4) % 3], label=name.replace("_", " ") + " (peak = 1)")
for j, w in enumerate(sw): a.add_patch(plt.Rectangle((0.02 + 0.16 * j, 0.88), 0.03, 0.07, transform=a.transAxes, color=[int(v) / 255 for v in w["rgb"][4:-1].split(",")], ec="0.5")); a.text(0.055 + 0.16 * j, 0.915, w["label"], transform=a.transAxes, fontsize=8, va="center")
a.set_xlabel("wavelength (nm)"); a.set_ylabel("response; spectrum"); a.set_ylim(0, 2.1); a.legend(fontsize=7, frameon=False, loc="center right")
fig.tight_layout(); fig.savefig("colour.png", dpi=160); plt.close(fig)
print("wrote spectrum.png, structure.png, opacity.png, maps.png, colour.png")
`;
