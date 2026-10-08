# mesonet-photo-explorer

The Montana Mesonet Photo Explorer: a static MapLibre single-page app in `docs/`
(GitHub Pages root), plus `scripts/generate_preview.py`.

## House style

This app consumes mco-web-style (pinned + SRI in `docs/index.html`; currently
**v0.7.1** — check the tag in that file rather than trusting this line). Design tokens, a11y mandates, and interaction conventions: see
HOUSE-STYLE.md in https://github.com/mt-climate-office/mco-web-style — tokens
only (no raw hexes), `--accent` is fill-only, `aria-pressed` drives toggle
styling, canvas data needs a live region + sr-only table twin. To change shared
styling, change the kit and bump the pinned version here; never patch a local
copy.

App-local by deliberate kit decision (do NOT extract): the photo-mosaic
machinery, the gallery/lightbox dialogs, the date stepper, the direction
segments + `<select>` fallback, `updateSocialMeta`, and the branded PNG export.

Marked kit-overrides in this app:
- **No hillshade** — the photo mosaic is the figure; relief under opaque photo
  rasters would only show in the untiled west while competing with the imagery.
- Navbar wraps at ≤1060px and lifts `.nav-meta` beside the brand there, so the
  controls get a full-width row. The brand itself collapses to the logo badge at
  ≤750px — that is the kit default, not an override. Search collapsing to an icon
  + overlay at ≤640px is the kit's `.mco-search-collapse` component (this app
  prototyped it; mesonet-status adopting it is what moved it into the kit).

## Camera schedule source

Photo expectations come from the published camera schedule, not the Mesonet API:
`https://data2.climate.umt.edu/mesonet/photos/schedule/schedule.json` (`schema: 1`,
`max-age=60`, CORS `*`), written by `mesocam rollout publish` in the mesonet-cameras
repo. `/api/v2/photos` (Airtable-fed) had drifted from what the cameras shoot and is
gone from this app. Stations, coordinates, status and `ace_grid` still come from the
API, now at `mesonet2.climate.umt.edu/api/...` (same paths and schema).

`isValidForSlot(station, dir, dtStr)` is **period-aware**: the slot's UTC instant picks
the schedule period (`from <= t < until`), the token must be in that period's views,
the slot's local `HH:MM` must be in its `slots_local`, and the date must be on or after
`first_month + "-01"`. So a camera moved at 13:21 MT shows its old views at 09:00 and
its new ones at 15:00 that day, and history renders what was actually shot.

**The Time menu is built per selected date from the schedule** (`slotsForDate`): a slot
is offered on a date when at least half of the stations shooting anything that day shoot
it (period-aware, at that date's UTC instant). So dates before 2026-09-20 offer 09:00/15:00,
later dates 09:00/12:00/15:00, and the 2026-09-11..20 hourly pilot (~30 cameras) never
reaches the menu. The static `<option>`s in `index.html` are only a pre-load placeholder.
`computeMaxTimestep`, `previousSlot`, `clampDate` and `resolveInitialTimestep` all read
`slotsForDate`; `SLOT_FALLBACK_MAX` (6) is sized in slots (≈2 days at 3/day). Today's
not-yet-cleared slots are listed but `disabled` (grayed, no suffix, so the `<select>` keeps its width), and today is
unreachable until its first slot clears the lag (`dateInput.max` is refreshed by
`computeMaxTimestep`). Every date change funnels through `clampDate()`, which resolves the
time from the sticky preference `_wantedTime` (the last `?time`/user pick): wanted slot if
offered, else the next later one that day, else the last; a bare `?date=` lands on the
day's first slot. A move is toasted once — batched across a hold-to-repeat run
(`_pendingRoll`/`flushRoll`). `arrivals.json` in the same directory is deliberately NOT
read: as published it is a stale two-day snapshot; the hook point is noted in
`slotsForDate`. The date picker floor is the constant `PHOTOS_MIN_DATE` (2022-09-22, the
old API's network-wide start); the schedule's `first_month` reaches back to 2016-12 for a
few stations but coverage there is sparse.
**The direction controls are likewise fitted per slot** (`dirsForSlot`/`syncDirections`,
run by every `refreshMapImages`): a token is offered only if some placed station was
scheduled to shoot it at the selected slot, so the retired sky cameras' NS/SS vanish after
their last scheduled slot (acecrowa, 2026-09-29 16:38 MT). A direction the slot lacks falls
back to W (`DEFAULT_DIR`, toasted), and the sticky `_wantedDir` is restored when a slot offers it again.
`thumbPhotoUrl`/`largePhotoUrl` are hardcoded and must agree with the file's `patterns`.

Known upstream data oddity (fix in mesonet-cameras `data/rollout.json`, not here): the
legacy period for `acebozem`, `acetosto`, `acemidwa` lists E/N/S/SNOW/W, but the store
(and the old API) has N/NS/S/SS for them, so their sky views are hidden and their E/W/SNOW
cells render empty. Two schedule stations (`acehammo`, `acerattl`) are not HydroMet/active
in the API and so are never placed.

## Landing-slot fallback

`computeMaxTimestep` assumes a flat 30-minute processing lag, but the upstream
mesonet-cameras job publishes several times a day — so the newest expected slot
is empty right after it turns over and then fills in gradually (observed climbing
0% → 50% → 75% over minutes; a settled slot measures ~83%, the rest being cameras
that are simply offline).

`resolveInitialTimestep()` therefore probes a spread sample of stations before
the layers are added and picks the newest slot worth showing: it accepts a slot
at ≥60% of the sample, otherwise walks back up to 4 slots and takes the most
complete one. **It only runs when neither `?date` nor `?time` is present** — an
explicit or shared URL is never silently moved. If a run lands on an unexpected
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
`npx html-validate@9 docs/index.html`, and the app's `consumer-verify.mjs`
harness (untracked; install `playwright` + `@axe-core/playwright` with
`--no-save`). Gotchas that have cost time here:
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
