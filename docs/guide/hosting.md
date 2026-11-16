# Hosting and custom domain

The site and these docs are static files. GitHub Actions builds both on every push to `main` and publishes them with GitHub Pages: the app at the root, the docs under `docs/`.

| | Without a custom domain | With exoplanet.science |
| --- | --- | --- |
| App | `https://pearsonkyle.github.io/Exoplanet-Science-Lab/` | `https://exoplanet.science/` |
| Docs | `https://pearsonkyle.github.io/Exoplanet-Science-Lab/docs/` | `https://exoplanet.science/docs/` |

## Turn on GitHub Pages (once)

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or run the **Pages** workflow by hand under **Actions**). The workflow `.github/workflows/pages.yml` builds the app (`npm run build`), the docs (`npm run docs:build`) and deploys `dist/`.

## Move exoplanet.science from Namecheap to GitHub Pages

The domain stays registered at Namecheap; only its DNS records point at GitHub.

1. **Verify the domain with GitHub** (protects it from takeover): GitHub → your profile **Settings → Pages → Add a domain** → `exoplanet.science`. GitHub shows a TXT record. In Namecheap: **Domain List → Manage → Advanced DNS → Add new record**:

   | Type | Host | Value |
   | --- | --- | --- |
   | TXT | `_github-pages-challenge-pearsonkyle` | the code GitHub shows |

   Wait a few minutes, then press **Verify** on GitHub.

2. **Point the domain at GitHub Pages.** Still in Advanced DNS, delete Namecheap's parking records (the `CNAME www → parkingpage.namecheap.com` and the `URL Redirect @`), then add:

   | Type | Host | Value |
   | --- | --- | --- |
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |
   | CNAME | `www` | `pearsonkyle.github.io.` |

3. **Tell the repository.** Repository **Settings → Pages → Custom domain**: `exoplanet.science` → Save. Then **Settings → Secrets and variables → Actions → Variables → New variable**: `PAGES_DOMAIN` = `exoplanet.science`, and re-run the Pages workflow: the docs are then built for `/docs/` at the root of the domain.

4. When the DNS check turns green (minutes to a few hours), tick **Enforce HTTPS**.

Check from a terminal: `dig exoplanet.science +short` should list the four `185.199.x.153` addresses.

## Any other static host

`npm run pages:build` writes the app and the docs to `dist/` (set `DOCS_BASE=/docs/` for a domain root). Upload `dist/` to Netlify, Cloudflare Pages, S3 or your own server; no server code or rewrite rules are needed.
