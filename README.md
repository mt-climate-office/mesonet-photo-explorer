# mesonet-photo-explorer

An interactive web map for browsing [Montana Mesonet](https://climate.umt.edu/mesonet/)
station photos by date, time, and camera direction.

**Live:** [mesonet.climate.umt.edu/photos](https://mesonet.climate.umt.edu/photos/) —
the canonical URL. The same page is also served from its GitHub Pages origin at
[mt-climate-office.github.io/mesonet-photo-explorer](https://mt-climate-office.github.io/mesonet-photo-explorer/).

A service of the [Montana Climate Office](https://climate.umt.edu).

---

## How it works

The explorer is a static single-page app in `docs/` (MapLibre GL JS, styled with
[mco-web-style](https://github.com/mt-climate-office/mco-web-style)), published by GitHub
Pages and reverse-proxied under `mesonet.climate.umt.edu/photos/`. It draws Montana as a
grid of cells and fills each one with a station's latest photo.

The grid *geometry* (`docs/grid.geojson`) is the only static piece — everything else is
read live on each page load:

| Source | Provides |
|--------|----------|
| `https://mesonet2.climate.umt.edu/api/stations` | Station list, network membership, names, coordinates |
| `https://mesonet2.climate.umt.edu/api/stations/status` | Per-station status and grid-cell (`ace_grid`) assignment |
| `https://data2.climate.umt.edu/mesonet/photos/schedule/schedule.json` | Per-station camera views, slot times, dated schedule periods, and first month with photos — published by [mesonet-cameras](https://github.com/mt-climate-office/mesonet-cameras) |
| `https://data2.climate.umt.edu/mesonet/photos/webp/{thumb,large}/<station>/<station>_<TOKEN>_<UTC>.webp` | The WebP photo store itself (thumbnails for the mosaic, large frames for the lightbox) — also produced by mesonet-cameras |

A station's cell appears once it is an active HydroMet station with photos online.
**Because no station data is baked into the map, new stations show up automatically —
nothing in this repo needs to be rebuilt when a station is added or removed.**

The schedule's dated periods make history render what was actually shot: a moved camera
shows its old views before the move and its new ones after. The UI exposes only the 09:00
and 15:00 Mountain Time slots for now, although the schedule records hourly capture for a
growing share of cameras.

**This repo owns no photo processing and no AWS resources.** The capture, WebP rendering
and schedule publishing live in
[mesonet-cameras](https://github.com/mt-climate-office/mesonet-cameras); the `mco-mesonet`
S3 bucket is managed by mco-aws (`stacks/mco-mesonet-bucket`); the `data2.climate.umt.edu`
CDN is managed by mco-data-cdn. This repo is the viewer, nothing more.

---

## Repository layout

```
docs/                          The explorer — published via GitHub Pages
  index.html                   Single-page app (markup, CSP, app-specific CSS)
  app.js                       App logic (classic script; uses window.MCO from mco-web-style)
  grid.geojson                 Grid-cell geometry
  data/                        Montana state / county / tribal boundary GeoJSON
  assets/                      Favicons + vendored MCO logo
  preview.png                  Social-share image (auto-generated daily)
scripts/
  generate_preview.py          Render preview.png from the live site (Playwright)
mesonet-photo-explorer.R       Generates docs/grid.geojson (static grid geometry)
data/                          Source grid shapefile (input to the R script)
.github/workflows/preview.yml  Daily social-preview regeneration
```

---

## Running locally

**Preview the explorer** — serve `docs/` and open it in a browser (it pulls live data from
the API and the CDN, so no other setup is needed):

```bash
python3 -m http.server -d docs 8000      # → http://localhost:8000
```

**Regenerate the grid geometry** — only when the grid definition changes:

```bash
Rscript mesonet-photo-explorer.R         # writes docs/grid.geojson
```

**Verify before pushing.** There is no CI for the page. Run the manual gates from
mco-web-style's `MIGRATING.md` § "Verification recipe": `node --check docs/app.js`,
`npx html-validate@9 docs/index.html`, and the app's `consumer-verify.mjs` harness
(untracked — install `playwright` and `@axe-core/playwright` with `--no-save`).

---

## Deploying

**Pushing `main` is a production deploy, on two URLs:** GitHub Pages publishes `/docs` from
`main`, and the same page is reverse-proxied at `mesonet.climate.umt.edu/photos/` (the
`mesonet_app` Caddyfile).

`.github/workflows/preview.yml` runs once a day (and on manual dispatch) and **commits
`docs/preview.png` back to `main`** — always pull/rebase before pushing, or you race it.

`scripts/generate_preview.py` drives the live page headlessly: it loads the Pages origin
with `?export=dark`, which clicks `#btn-export` after a 4-second delay and yields the PNG
as a download. That timing, the query parameter and the button id are a contract —
changing them silently breaks the social preview in production. Run the script locally
against your changes first:

```bash
pip install playwright
playwright install --with-deps chromium
python scripts/generate_preview.py
```

---

## Data source

Photos are captured by cameras at Montana Mesonet sites and served by the
[Montana Climate Office](https://climate.umt.edu). The explorer reads all station and
photo metadata live from the sources listed in [How it works](#how-it-works).
