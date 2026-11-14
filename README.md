# Mesonet Photo Explorer

A map of Montana Mesonet station photos, browsable by date, time and camera direction.

https://mesonet.climate.umt.edu/photos/

## Run it

```bash
python3 -m http.server -d docs 8000      # http://localhost:8000
Rscript mesonet-photo-explorer.R         # only when the grid changes: writes docs/grid.geojson
```

The page reads live data, so no other setup is needed.

## Deploy

Pushing `main` deploys. GitHub Pages publishes `docs/`, and the `mesonet_app` Caddyfile proxies it at `/photos/`.
`.github/workflows/preview.yml` commits `docs/preview.png` to `main` daily. Pull before you push.
`scripts/generate_preview.py` needs `?export=light&dir=W`, the 4 s delay and `#btn-export`. Keep all three.

## URL parameters

| Parameter | Values | What it does |
|---|---|---|
| `date` | `YYYY-MM-DD` | Photo date |
| `time` | `15` or `09:30` | Photo time, Mountain Time |
| `dir` | `N`, `E`, `S`, `W` | Camera direction (default `N`) |
| `station` | station id, e.g. `aceabsar` | Opens that station's photos |
| `lng`, `lat`, `zoom` | numbers | Map position |
| `overlay` | `counties` | Shows county and tribal boundaries |
| `theme` | `dark`, `light`, `high-contrast` | Color theme |
| `kbd` | `off` | Turns off the `/` and day-stepping arrow keys |
| `internal` or `view` | `1` or `internal` | Staff view: adds the instrument camera views |
| `export` | `light`, `dark` | Clicks Export after 4 s in that theme (social preview) |

## Data

- Stations: `https://mesonet2.climate.umt.edu/api/stations?type=json`
- Grid cells: `https://mesonet2.climate.umt.edu/api/stations/status?type=json` (`ace_grid`)
- Camera schedule: `https://data2.climate.umt.edu/mesonet/photos/schedule/schedule.json`, read by the kit's `MCO.photos`
- Photos: `https://data2.climate.umt.edu/mesonet/photos/webp/{thumb,large}/<station>/…webp`
- Grid geometry: `docs/grid.geojson`, from `mesonet-photo-explorer.R` and `data/`

Photos and the schedule come from the mesonet-cameras repo. This repo owns no AWS resources.

## Tests

There is no CI. From an mco-web-style checkout beside this one:

```bash
node --check ../mesonet-photo-explorer/docs/app.js
npx html-validate@9 ../mesonet-photo-explorer/docs/index.html
node tools/verify/head.mjs       --root ../mesonet-photo-explorer --page docs/index.html
node tools/verify/axe-matrix.mjs --config ../mesonet-photo-explorer/verify.config.mjs --root ../mesonet-photo-explorer --page docs/index.html
node tools/verify/keyboard.mjs   --config ../mesonet-photo-explorer/verify.config.mjs --root ../mesonet-photo-explorer --page docs/index.html
```

## Kit

`mco-web-style` 1.0.0, pinned with SRI in `docs/index.html`.

Design rules: mco-web-style/HOUSE-STYLE.md
