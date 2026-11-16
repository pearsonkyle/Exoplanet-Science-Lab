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

## Python

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python"
```

See [Python package](./python).

## Next

- [A tour of the site](./site) · [Worked examples](./examples)
- [Assistant and your own LLM](./assistant) · [MCP server](./mcp)
- [Methods](../METHODS): what is computed and how well it is checked
