# Getting started

## Use it online

Open **[the app](https://pearsonkyle.github.io/Exoplanet-Science-Lab/)** (soon at exoplanet.science). Everything runs in your browser: files you open are never uploaded.

- **Analyze → Processed Data**: press **Start** for a worked example, or drop a light curve (CSV, AAVSO, EXOTIC, or a TESS/Kepler FITS table) on the Data tab.
- **Analyze → Photometry**: open a folder or a zip of FITS frames, or fetch TESS, Kepler and K2 pixels.
- **Plan**: choose your observatory and see the transits you can observe in the coming nights.

A one-minute tour starts the first time you visit; the **Project** checklist in the top bar walks you from choosing a target to the report.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or later and git.

```sh
git clone https://github.com/pearsonkyle/Exoplanet-Science-Lab.git
cd Exoplanet-Science-Lab
npm install
npm run dev            # http://localhost:5173
```

`npm run build` writes the static site to `dist/`; any static file server can host it (`npx vite preview`, or `python3 -m http.server -d dist`). Running locally over `http://localhost` is also the easiest way to let the assistant reach a model server on your network.

## Using it offline

After one visit with a connection, the whole site works with none: on a plane, in airplane mode, or at a telescope
with a bad link. The browser keeps a copy of every page, the worked examples, the catalogue snapshots, the sky data,
the sample FITS files and these docs (about 71 MB; the pages themselves, 8 MB, are saved first, the rest in the
background within a minute or so). With **Save data** turned on in your browser only the pages are saved, and the rest
as you open it. When you are offline the top bar says **Offline: using the saved copy**.

Live queries still need the internet: TESS, Kepler and K2 files from MAST, Gaia stars from VizieR for plate solving,
SIMBAD name lookups, radial velocities from VizieR, sky survey images, terrain, satellites, and the assistant's model
server if it is not on your computer. When one of them cannot be reached a small notice names it, and the rest of the
page carries on.

A new version of the site is saved next to the old one and used when you press **Reload** on the notice that offers it
(or the next time you open the site with no tab of it open). Add `?nosw` to any address to remove the saved copy.

**A copy on your own disk.** Build it and serve the folder with any static server:

```sh
DOCS_BASE=/docs/ npm run pages:build     # the app and the docs in dist/
npx serve dist                           # or: node tools/docs/serve.mjs dist 4173, or python3 -m http.server -d dist
```

and open the address it prints. Keep the `dist/` folder (zip it to move it to another computer). Serve it from the
root of the address (`http://localhost:3000/`, not a sub-folder), since the docs are built for `/docs/`. Opening
`dist/index.html` straight from the disk (`file://`) does not work: browsers refuse to run the site's modules and
workers from a file, and the page says so. A local server on `localhost` also gets the offline copy.

## Python

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python"
```

See [Python package](./python).

## Next

- [A tour of the site](./site) · [Worked examples](./examples)
- [Assistant and your own LLM](./assistant) · [MCP server](./mcp)
- [Methods](../METHODS): what is computed and how well it is checked
