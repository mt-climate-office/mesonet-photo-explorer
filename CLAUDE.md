# mesonet-photo-explorer

The Montana Mesonet Photo Explorer: a static MapLibre single-page app in `docs/`
(GitHub Pages root), plus `scripts/generate_preview.py`.

## House style

This app consumes mco-web-style (pinned + SRI in `docs/index.html`; currently
**v0.16.2**, with MapLibre GL **6.11.2** — check the tag in that file rather than trusting this line). Design tokens, a11y mandates, and interaction conventions: see
HOUSE-STYLE.md in https://github.com/mt-climate-office/mco-web-style — tokens
only (no raw hexes), `--accent` is fill-only, `aria-pressed` drives toggle
styling, canvas data needs a live region + sr-only table twin. To change shared
styling, change the kit and bump the pinned version here; never patch a local
copy.

App-local by deliberate kit decision (do NOT extract): the photo-mosaic
machinery, the gallery/lightbox dialogs, and the branded PNG export. Since kit
0.9.0 these are the kit's — don't re-grow local copies: the date steppers
(`MCO.initStepper`), the direction segments' `<select>` fallback
(`MCO.initSegmentedFallback`), the search combobox (`MCO.initSearchBox`),
the social/tab titles (`MCO.setSocialMeta` / `setPageTitle`), the announcer
(`MCO.announce`), the table twin (`MCO.srTable`), and the basemap failure
fallback (`MCO.map.watchBasemap`). Since kit 0.14.0 the station-photo layer is
the kit's too (`MCO.photos`, `photos/mco-photos.js`): the camera schedule, the
slot and direction rules, frame URLs, and the date / time / direction controls
(`MCO.photos.initPhotoControls`). The social card image stays the
bot-regenerated `docs/preview.png`, not the kit's og-card.

Marked kit-overrides in this app:
- **No hillshade** — the photo mosaic is the figure; relief under opaque photo
  rasters would only show in the untiled west while competing with the imagery.
- Navbar wraps at ≤1060px and lifts `.nav-meta` beside the brand there, so the
  controls get a full-width row. The brand itself collapses to the logo badge at
  ≤750px — that is the kit default, not an override. Search collapsing to an icon
  + overlay at ≤640px is the kit's `.mco-search-collapse` component (this app
  prototyped it; mesonet-status adopting it is what moved it into the kit).
- **Landscape rail** — prototyped here and adopted by the kit in 0.10.0
  (mco-web-style #38): `.mco-navbar[data-rail]` + `.mco-rail` +
  `.mco-nav-drawer` + `MCO.initNavRail`, at `MCO.viewport.RAIL_MQ`. The app
  keeps only its rail content (day ▲/▼, date/time readout, direction cycle)
  and how its control groups stack in the drawer, plus the three hand-offs:
  `/` opens the drawer on the search field, a search result closes it without
  restoring focus, Export / info close it first.

## Camera schedule source

Photo expectations come from the published camera schedule, not the Mesonet API:
`https://data2.climate.umt.edu/mesonet/photos/schedule/schedule.json` (`schema: 1`,
CORS `*`), written by `mesocam rollout publish` in the mesonet-cameras repo. Stations,
coordinates, status and `ace_grid` still come from the API at
`mesonet2.climate.umt.edu/api/...`.

**The kit reads it** (mco-web-style 0.14.0, `MCO.photos`; HOUSE-STYLE § "Station
photos"). This app no longer parses the schedule, builds the Time menu, picks
directions or converts Mountain time itself. What the kit does for it:

- `P.load(...)` parses the schedule into per-station view windows, once, with
  the audience filter applied as an allowlist. **Public: N, E, S, W over the full
  history** — `{fullHistory: true, since: PHOTOS_MIN_DATE}` (kit 0.15.0; website
  DECISIONS D16). The kit's default 2026-10-22 start (D7) is for the website's
  photo hero only; do not drop `fullHistory` here. Pre-cutover N and S (aimed at
  the pluviometer and the snow stake until 2026-10-21 16:00 MT) stay public and
  are labelled "North"/"South", as before. **Staff (`?internal=1` or
  `?view=internal`)**: `{internal: true, since: PHOTOS_MIN_DATE}`, every view but
  PARK. `PHOTOS_MIN_DATE` (2022-09-22) is the old API's network-wide start; the
  schedule's `first_month` reaches back to 2016-12 for a few stations, but
  coverage there is sparse. The internal flag is URL-only and unpersisted;
  `updateUrl` re-emits it.
- `P.isShotAt(schedule, sta, dir, date, time)` is **period-aware** (the slot's UTC
  instant picks the window), so history renders what was actually shot.
- `P.initPhotoControls` owns `#date-input`, `#time-input`, the two stepper pairs
  (navbar and rail) and the direction radio fieldset `#dir-btns` with its
  `#dir-select` fallback (1400px edge). The Time menu is built per date from the
  schedule (a slot is offered when at least half of the shooting stations shoot it;
  today's slots inside the 30-minute lag are listed but disabled). Directions are
  limited to those some *placed* station shot at the slot (`stations:` option).
  Wanted time and direction are sticky across days. Initial state: `?date` /
  `?time` / `?dir` (validated) > the latest cleared slot, North.
- Moves the visitor did not ask for (a date before photos start, a time that day
  never offered or not in yet, a direction nobody shot) come back as rolls; the app
  toasts `P.rollMessage(r)` via `onRoll` (not during `?export=`).
- It does not write the URL: `updateUrl` merges `controls.params()` (`date`, `time`
  as `15` or `09:30`, `dir` only away from N). `onChange` refreshes the mosaic,
  deferring it while a day stepper is held (`STEP_SETTLE_MS`, `_pointerHeld`).
- Frame URLs are `P.frameUrl(schedule, sta, dir, ms, 'thumb'|'large')`, from the
  schedule's `patterns`.

`arrivals.json` is deliberately not read: as published it is a stale snapshot.

Known upstream data oddity (fix in mesonet-cameras `data/rollout.json`, not here): the
legacy period for `acebozem`, `acetosto`, `acemidwa` lists E/N/S/SNOW/W, but the store
(and the old API) has N/NS/S/SS for them, so in the staff view their sky views are
hidden and their E/W/SNOW cells render empty for old dates. Two schedule stations
(`acehammo`, `acerattl`) are not HydroMet/active in the API and so are never placed.

## Landing-slot fallback

The kit's `latestSlot` assumes a flat 30-minute processing lag, but the upstream
mesonet-cameras job publishes several times a day — so the newest expected slot
is empty right after it turns over and then fills in gradually (observed climbing
0% → 50% → 75% over minutes; a settled slot measures ~83%, the rest being cameras
that are simply offline).

`resolveInitialTimestep()` therefore probes a spread sample of stations before
the layers are added and picks the newest slot worth showing: it accepts a slot
at ≥60% of the sample, otherwise walks back up to 6 slots (`P.previousSlot`) and takes the most
complete one, landing with `controls.set(…, {silent: true})`. **It only runs when
neither `?date` nor `?time` is present** (`controls.pinned`) — an explicit or
shared URL is never silently moved. If a run lands on an unexpected
date, this is why; `?date=`/`?time=` pins it.

The probed crops go into `_cropCache`, so the render reuses them. `?export=`
benefits too, which is the point: the social card used to be regenerable as a
blank map.

## Deploying — read before you push

Pushing `main` **is a production deploy, on two URLs**: GitHub Pages publishes
`/docs` from `main`, and the same page is reverse-proxied at
`mesonet.climate.umt.edu/photos/` (mesonet_app Caddyfile).

`.github/workflows/preview.yml` runs once daily and **commits `docs/preview.png`
back to `main`** — always pull/rebase before pushing, or you race it.

This repo owns no AWS resources and no photo processing: the pipeline lives in
mesonet-cameras, the bucket in mco-aws (`stacks/mco-mesonet-bucket`), the CDN in
mco-data-cdn.

`scripts/generate_preview.py` drives the live page headlessly via `?export=light&dir=W`
plus a 4-second delay before clicking `#btn-export`. That timing, the param, and
the button id are a contract — changing them silently breaks the social preview
in production. Run it locally against your changes first.

## Verification

There is no CI for the page. Before any push, run the manual gates from
mco-web-style `MIGRATING.md` § "Verification recipe": `node --check docs/app.js`,
`npx html-validate@9 docs/index.html`, and the kit's `tools/verify/` harness
against this repo's committed `verify.config.mjs`, in Chromium AND WebKit, from
a kit checkout beside this one:

    node tools/verify/head.mjs       --root ../mesonet-photo-explorer --page docs/index.html
    node tools/verify/axe-matrix.mjs --config ../mesonet-photo-explorer/verify.config.mjs --root ../mesonet-photo-explorer
    node tools/verify/keyboard.mjs   --config ../mesonet-photo-explorer/verify.config.mjs --root ../mesonet-photo-explorer

(The older untracked `consumer-verify.mjs` still works for its extra probes.)
Gotchas that have cost time here:
- MapLibre 6 is ES-modules only: `MCO.map.loadMapLibre()` imports it and the
  one-line import map in `<head>` carries its SRI. The import map's CSP hash is
  the kit's published one and holds only while it is copied byte for byte;
  `worker-src` needs **both** `blob:` and `https://unpkg.com` or the basemap
  draws and nothing else does. The map is built in `initMap()`, after the
  library arrives; handlers that can run before it guard on `map`.
- The anti-flash script's sha256 in the CSP is this page's own: recompute it
  (MIGRATING.md § Gotchas, python recipe) after any change to that script.
- The harness's `renderEvidence` must be a **function**, not a string — a string
  predicate is `eval`'d in-page and the CSP has no `'unsafe-eval'`.
- (Resolved by kit 0.7.0.) axe's color-contrast rule used to fetch the
  cross-origin Google Fonts stylesheet and trip the CSP, so console checks had
  to run before axe or filter `fonts.googleapis.com`. The fonts are kit-hosted
  now and there is no Google Fonts stylesheet to fetch; if a CSP error shows up
  during an axe run again, it is real.
- `connect-src` must include `data:`: MapLibre fetches an `image` source's url,
  and every photo is a cover-cropped canvas data URL. Without it the entire
  mosaic silently fails to paint.
- Stations with no photo at the selected timestep produce an error response from
  CloudFront. Those console errors are expected and identical on production. The
  code depends on the CDN: **404** from `data2.climate.umt.edu` (its OAC holds
  `s3:ListBucket`, so S3 can answer `NoSuchKey`), but **403** from the old
  photo-explorer distribution, which couldn't list and so hid existence. The
  harness classifies them out by URL, not by status.
