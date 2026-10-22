/* ============================================================================
   Montana Mesonet Photo Explorer

   Consumes mco-web-style (window.MCO / MCO.map) — see index.html for the
   pinned + SRI kit tags. Classic script: the kit globals need no modules, and
   an external file lets the page ship a strict CSP without 'unsafe-inline'.

   App-owned (deliberately NOT in the kit — MIGRATING.md § kit-deferred):
   the photo-mosaic machinery (cover-crop + LRU cache, one image source per
   station cell), the gallery/lightbox dialogs and the branded PNG export.
   Since kit 0.9.0 the date stepper (MCO.initStepper) and the direction
   segments' <select> fallback (MCO.initSegmentedFallback) are the kit's, and
   since 0.14.0 so are the camera schedule, the slot and direction rules and
   the date / time / direction controls (MCO.photos.initPhotoControls).
   ========================================================================== */
(function () {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
// Station photos (the camera schedule, slots, directions, frame URLs and the
// date / time / direction controls) are the kit's MCO.photos (0.14.0), which
// reads data2.climate.umt.edu. This app keeps the station join, the mosaic,
// the landing-slot probe, the gallery and the export.
const P = MCO.photos;
const STATIONS_META   = "https://mesonet2.climate.umt.edu/api/stations?type=json";
const STATUS_META     = "https://mesonet2.climate.umt.edu/api/stations/status?type=json";
const GRID_URL        = "grid.geojson";
const DASH_URL        = (s) => `https://mesonet.climate.umt.edu/dash/${s}`;
// The export's wordmark comes from the pinned kit tag (HOUSE-STYLE §1 Logo:
// exports draw from the kit, never climate.umt.edu), loaded with CORS so the
// canvas stays exportable. KEEP the version in step with the kit tags in
// index.html. -on-light / -on-dark is picked by the card's own background.
const KIT_ASSETS      = "https://cdn.jsdelivr.net/gh/mt-climate-office/mco-web-style@0.14.0/assets/";
const WORDMARK_URL    = (onLight) => `${KIT_ASSETS}mco-wordmark-on-${onLight ? 'light' : 'dark'}.svg`;

// The public range is the kit's (website DECISIONS D7, D15): every direction
// from 2026-10-22, because before 2026-10-21 16:00 MT "N" was the pluviometer
// and "S" the snow stake. Never pass `since` for the public view. The staff
// view (?internal=1) keeps the history, from the network-wide start the old
// API reported; the schedule's `first_month` reaches back to 2016-12 for a
// few stations, but WebP coverage before this date is sparse.
const INTERNAL_SINCE = "2022-09-22";

const SEARCH_FLY_ZOOM    = 8.5;
const SEARCH_FLY_SPEED   = 1.4;
const SEARCH_MAX_RESULTS = 8;

// Landing-slot fallback. MCO.photos.latestSlot assumes a flat processing lag, but
// the mirror job publishes ~12×/day, so the newest expected slot is empty right
// after it turns over and then fills in gradually. Probe a spread sample of
// stations and pick the newest slot that is actually worth showing.
const SLOT_PROBE_SAMPLE = 12;   // stations probed per candidate slot
// A settled slot measures ~83% present (the remaining cameras are simply
// offline); a mid-mirror slot was observed climbing 0% → 50% → 59% over a few
// minutes. So "most of the sample" separates a finished slot from a partial one
// without needing to know how many cameras are live.
const SLOT_ACCEPT_RATIO = 0.6;
const SLOT_FALLBACK_MAX = 6;    // slots to walk back (≈2 days at 3 slots/day)

// localStorage (HOUSE-STYLE §4: app-private keys are mco-<app>-* prefixed and
// re-validated on read). LEGACY_SEEN_KEY was unprefixed before the kit
// migration — read-old/write-new so returning visitors don't re-see the intro.
const LS_SEEN     = 'mco-photos-seen-intro';
const LS_SEEN_OLD = 'mco-info-seen';
const LS_COUNTIES = 'mco-photos-counties';

// Fixed export layout dimensions (Montana framing / Playwright viewport). The PNG
// is rendered at EXPORT_SCALE× these for a crisp, high-resolution image.
const EXPORT_W = 1400, EXPORT_H = 700;
const EXPORT_SCALE = 2;   // → 2800×1400 output, independent of the device's DPR
// Photos are cover-cropped to a centered square before being warped into their
// (near-square) grid cell, so they fill the cell without aspect squish.
const CROP_SIZE = 320;
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const once = (m, ev) => new Promise((r) => m.once(ev, r));


// ── DOM refs ────────────────────────────────────────────────────────────────
const mainEl         = document.getElementById("main");
const dateInput      = document.getElementById("date-input");
const timeInput      = document.getElementById("time-input");
const tooltipEl      = document.getElementById("tooltip");
const searchInput    = document.getElementById("search-input");
const searchDropdown = document.getElementById("search-dropdown");
const infoModal      = document.getElementById("info-modal");
const modal          = document.getElementById("modal");
const lightbox       = document.getElementById("lightbox");

// Screen-reader announcements for what the WebGL mosaic shows (HOUSE-STYLE
// §5.1) go through the kit's one page announcer, MCO.announce (polite) — the
// hidden-table twin below carries the detail.

// ── State ─────────────────────────────────────────────────────────────────────
let _schedule = null;                 // MCO.photos schedule (loadData)
let controls  = null;                 // MCO.photos.initPhotoControls handle (loadData)
let showCounties;
let map;
let _activeFeatures = [];             // [{ station, name, coords:[4×[lng,lat]], centroid, id }]
let _featureByStation = new Map();
let _cellsFC = null;                  // GeoJSON FeatureCollection for the 'cells' source (numeric ids)
let _stationsList = [];               // search index: [{ station, name }]
let _stationOrder = [];               // station ids, alphabetical — the prev/next order in the dialogs
let _tribalFC = null, _stateFC = null, _countiesFC = null;
let _mapReady = false;
let _selectedStation = null;
let _refreshToken = 0;                // guards against stale async photo loads on rapid date-stepping
let _hoveredId = null;
let _photoState = new Map();          // station → true|false (has a photo for the current selection)
let _lastAnnounced = '';
const _cropCache = new Map();         // thumb URL → cover-cropped data URL

// ── URL state ─────────────────────────────────────────────────────────────────
const urlParams = MCO.urlParams();
const getLower  = (k) => MCO.getParamLower(k, urlParams);

const _initStation = getLower('station');

// Single-character shortcuts need an opt-out (WCAG 2.1.4). Re-emitted on
// replaceState so it sticks while browsing, but excluded from shared links.
const kbdShortcuts = getLower('kbd') !== 'off';

// Internal view (as in mesonet-umrb-build): a bare `?internal=1` or
// `?view=internal`. Deliberately has no button — you reach it by knowing the
// URL — and is not persisted to localStorage, so a shared machine never stays
// in it. Re-emitted by updateUrl so it sticks while browsing and in shared links.
const internalView = getLower('view') === 'internal' ||
  (urlParams.has('internal') && !['', '0', 'false', 'no', 'off'].includes(getLower('internal')));

// Headless export: ?export=light|dark forces the theme before the map is built.
// Set directly (not MCO.setTheme) so a CI screenshot run never persists a theme.
const _exportParam = urlParams.get('export');
if (_exportParam === 'light' || _exportParam === 'dark') {
  document.documentElement.dataset.theme = _exportParam;
}

// ── Selection helpers ─────────────────────────────────────────────────────────
// The selected slot: {date, time: "HH:MM", view, ms} from the kit's controls,
// where ms is the slot's UTC instant. Null until the schedule has loaded.
function sel() { return controls ? controls.state() : null; }
// "Oct 22, 2026 3:00 PM MT": every stamp a person reads is Mountain Time.
function stampOf(st) { return `${P.stampLabel(st.ms)} MT`; }
// Was `station` scheduled to shoot `dir` at the selected slot (period-aware)?
function shotAt(station, dir, st = sel()) {
  return !!(st && st.time && P.isShotAt(_schedule, station, dir, st.date, st.time));
}
function thumbUrl(station, dir, st = sel()) { return P.frameUrl(_schedule, station, dir, st.ms, 'thumb'); }
function largeUrl(station, dir, st = sel()) { return P.frameUrl(_schedule, station, dir, st.ms, 'large'); }

// Evenly-spaced sample, so a probe can't land entirely in one corner of the
// state (the mirror publishes per station, and outages can be regional).
function pickSpread(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Persisted values are re-validated exactly like URL params — another MCO app
// (or an older version of this one) shares the origin.
const _overlayParam = getLower("overlay");
showCounties = _overlayParam !== null
  ? _overlayParam === "counties"
  : MCO.lsGet(LS_COUNTIES) === "1";

// ── Grid-cell join helpers ────────────────────────────────────────────────────
// Normalise a grid-cell ID ("C-07" ↔ "C-7") so the API `ace_grid` matches grid.geojson.
function normCell(c) {
  const m = /^([A-Za-z]+)-0*(\d+)$/.exec((c || "").trim());
  return m ? `${m[1].toUpperCase()}-${+m[2]}` : (c || "").trim();
}
// Ray-casting point-in-polygon over a GeoJSON polygon's outer ring (lon/lat).
function pointInPolygon(pt, geom) {
  const ring = geom.coordinates[0];
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function quadCentroid(coords) {
  let x = 0, y = 0;
  for (const [lng, lat] of coords) { x += lng; y += lat; }
  return [x / coords.length, y / coords.length];
}

// ── Overlay paints ────────────────────────────────────────────────────────────
// Kit paints (MCO.map.overlayPaints) with one sanctioned strengthening: here
// the tribal fill lands over the photo mosaic rather than a neutral basemap, so
// it needs more presence to read. The kit documents exactly this override.
function tribalFillPaint() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return { ...MCO.map.overlayPaints().tribalFill, 'fill-opacity': dark ? 0.25 : 0.18 };
}

// ── Map init ──────────────────────────────────────────────────────────────────
// MapLibre 6 is ES-modules only, so it arrives asynchronously: the kit's
// MCO.map.loadMapLibre() imports it (SRI via the page's import map) and the
// map is built in initMap() once it has. Everything else on the page is wired
// at the top level and never waits on the library; the call is at the end of
// this file. Until initMap runs, `map` is undefined, so the handlers that can
// fire before it (theme, date/time/direction, boundaries) guard on it.
let zoomFloor = null;
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MCO.map.cartoStyleUrl(),
    ...MCO.map.initialCamera(urlParams),
  });
  MCO.map.addNavigation(map);                  // top-right, no compass
  MCO.map.addFitControl(map);                  // fused into the zoom group
  zoomFloor = MCO.map.installZoomFloor(map);   // snap-back + resize refit
  // A basemap style that 404s or hangs never fires 'load': the kit retries
  // it, then falls back to a blank style and shows a notice with Retry.
  MCO.map.watchBasemap(map, { styleUrl: MCO.map.cartoStyleUrl });
  // Every style.load — a theme switch, a basemap retry, the blank fallback —
  // wipes our sources and layers, so they are re-added each time, not once.
  // The first one precedes the data load; onMapLoad adds them then.
  map.on('style.load', () => { if (_mapReady) addCustomLayers(); });
  map.on('load', onMapLoad);
  map.on('moveend', () => { if (_mapReady) updateUrl(); });
  wireMapPointer();
}
// The library failed to import (offline, CDN down, an SRI mismatch): say so
// rather than leaving an empty map pane, and release the first-paint hold.
function onMapLibraryFail(err) {
  console.error(err);
  MCO.notice({
    tone: 'danger', text: 'The map library failed to load.',
    action: { label: 'Reload', onClick: () => location.reload() },
    container: document.getElementById('map-container'), place: 'over',
  });
  MCO.ready();
}

// ── Theme ─────────────────────────────────────────────────────────────────────
// The toggle only flips the theme and mirrors it into the URL; the map
// re-styles from the kit's mco:themechange event (0.9.0), so any future theme
// source re-styles it too. setStyle() wipes our sources and layers; they
// return on style.load (initMap). Before the library has arrived there is no
// map yet, and initMap reads the theme when it builds it.
MCO.initThemeToggle({
  button: document.getElementById('btn-theme'),
  iconSun: document.getElementById('icon-sun'),
  iconMoon: document.getElementById('icon-moon'),
  // 3-state (kit 0.10.0): dark → light → high contrast, so high contrast is
  // reachable from the page, not only by ?theme=. The label names the next.
  cycle: true,
  iconContrast: document.getElementById('icon-contrast'),
  onChange: () => updateUrl(),
});
document.addEventListener('mco:themechange', () => {
  if (map) map.setStyle(MCO.map.cartoStyleUrl());
});

// Walk back from the computed latest slot to the newest one that actually has
// photos, so the app never lands on a blank mosaic just because the mirror job
// hasn't published the current slot yet. Runs BEFORE the layers are added, so
// the mosaic paints once at the right slot instead of flashing empty. Probed
// crops land in _cropCache, so the render reuses them rather than refetching.
// The kit decides what was scheduled; whether the photos have landed is only
// known by asking for them, so the probe stays here.
async function resolveInitialTimestep() {
  if (!controls || controls.pinned || !_activeFeatures.length) return;
  const start = controls.state();
  if (!start.time) return;
  const ids = _activeFeatures.map(f => f.station);
  let date = start.date, time = start.time;
  let best = null;   // { date, time, hits } — newest wins ties

  for (let step = 0; step <= SLOT_FALLBACK_MAX; step++) {
    const st = { date, time, ms: P.toUtcMs(date, time) };
    // Probe the direction this slot would actually show (the kit's rule:
    // the wanted view if offered, else North, else the first).
    const offered = P.viewsForSlot(_schedule, date, time, { stations: ids });
    const dir   = P.resolveView(offered.length ? offered : _schedule.tokens, start.view).view;
    const valid = dir ? _activeFeatures.filter(f => shotAt(f.station, dir, st)) : [];
    if (valid.length) {
      const sample = pickSpread(valid, SLOT_PROBE_SAMPLE);
      const crops = await Promise.all(sample.map(f => loadCrop(thumbUrl(f.station, dir, st))));
      const hits = crops.filter(Boolean).length;
      // Good enough to show as-is — stop probing.
      if (hits >= Math.ceil(sample.length * SLOT_ACCEPT_RATIO)) {
        best = { date, time, hits };
        break;
      }
      // Otherwise keep looking: a half-published newest slot should lose to a
      // complete older one, but still beat showing nothing at all.
      if (!best || hits > best.hits) best = { date, time, hits };
    }
    const prev = P.previousSlot(_schedule, date, time);
    if (!prev) break;
    date = prev.date; time = prev.time;
  }

  // Nothing anywhere in range: keep the computed latest slot so the controls
  // still read "now", and let the empty state (and the sr-table's "No photo"
  // rows) speak for themselves.
  if (!best || !best.hits) return;
  if (best.date === start.date && best.time === start.time) return;

  // Silent: the first URL write and the first paint follow in onMapLoad.
  const landed = controls.set({ date: best.date, time: best.time }, { silent: true });
  if (!_exportParam) {
    MCO.showToast(`Showing the most recent photos, from ${stampOf(landed)}.`, 5000);
  }
}

async function onMapLoad() {
  await loadData();
  await resolveInitialTimestep();
  addCustomLayers();
  zoomFloor.refresh();
  _mapReady = true;

  // Deep-link to ?station=… , else publish a clean initial URL.
  if (_initStation && _featureByStation.has(_initStation)) {
    // The entry already names the station, so these replace, never push.
    if (urlParams.has('lng')) openModalByStation(_initStation, null, { push: false });
    else                      flyToAndOpen(_initStation, null, { push: false });
  } else {
    updateUrl();
  }
  // Headless export hook (scripts/generate_preview.py drives ?export=…).
  // The 4 s delay is part of that contract — don't shorten it.
  if (_exportParam) setTimeout(() => document.getElementById('btn-export').click(), 4000);
  // First meaningful state: layers added, landing slot settled, URL published
  // (kit 0.9.0 first-paint hold; the anti-flash snippet's 3 s timeout is the
  // backstop).
  MCO.ready();
}

// ── Data load ─────────────────────────────────────────────────────────────────
async function loadData() {
  let grid, allStations, statusRows;
  try {
    [grid, allStations, statusRows, _schedule] = await Promise.all([
      MCO.fetchJSON(GRID_URL),
      MCO.fetchJSON(STATIONS_META),
      MCO.fetchJSON(STATUS_META),
      // The kit drops every view this audience may not see at parse time:
      // the public gets N, E, S, W from 2026-10-22; staff get the rest too.
      P.load(internalView ? { internal: true, since: INTERNAL_SINCE } : {}),
    ]);
  } catch (err) {
    console.error(err);
    _schedule = null;
    MCO.showToast("Failed to load map data. Please refresh.", 6000);
    return;
  }

  // Assemble the live station set: active HydroMet stations that have photos,
  // each placed at its assigned grid cell (ace_grid) or the cell containing it.
  const cellByCode      = new Map(grid.features.map(f => [normCell(f.properties.cell), f]));
  const statusByStation = new Map(statusRows.map(r => [r.station, r]));
  const feats = [], cellFeats = [];
  let idc = 0;

  allStations.filter(s => s.sub_network === "HydroMet").forEach(s => {
    const st = statusByStation.get(s.station);
    if (!st || st.status !== "active") return;
    if (!_schedule.stations.has(s.station)) return;
    let cell = st.ace_grid ? cellByCode.get(normCell(st.ace_grid)) : null;
    if (!cell) cell = grid.features.find(f => pointInPolygon([s.longitude, s.latitude], f.geometry));
    if (!cell) return;
    const ring   = cell.geometry.coordinates[0];             // [NW, NE, SE, SW, close]
    const coords = [ring[0], ring[1], ring[2], ring[3]];     // image-source: [TL, TR, BR, BL]
    const id = idc++;
    feats.push({ station: s.station, name: s.name || s.station, coords, centroid: quadCentroid(coords), id });
    cellFeats.push({ type: "Feature", id, geometry: cell.geometry,
                     properties: { station: s.station, name: s.name || s.station } });
  });

  _activeFeatures   = feats;
  _featureByStation = new Map(feats.map(f => [f.station, f]));
  _cellsFC          = { type: "FeatureCollection", features: cellFeats };
  _stationsList     = feats.map(f => ({ station: f.station, name: f.name }))
                          .sort((a, b) => a.name.localeCompare(b.name));
  _stationOrder     = feats.map(f => f.station).sort();

  initControls();
}

// ── Date / time / direction controls (kit: MCO.photos.initPhotoControls) ──────
// The kit owns the group: the date bounds (the first public date, the newest
// cleared slot), the Time menu built per date from the schedule (today's
// slots that haven't cleared the processing lag are listed but disabled), the
// wanted time and direction kept sticky across days, the radio fieldset of
// directions and its <select> fallback, and the ▲/▼ day steppers (navbar and
// rail). Initial state: ?date / ?time / ?dir (validated) > the latest slot,
// North. Only directions some placed station shot at the selected slot are
// offered. A move the visitor did not ask for (a date before photos start, a
// time that day never offered or not in yet, a direction nobody shot) comes
// back as a roll, toasted once after stepping settles. It does not write the
// URL: updateUrl merges controls.params().
//
// The mosaic refresh waits until stepping stops, so a hold-to-repeat run
// paints once, at the end: on pointer release for a press or hold, or after a
// short pause for keyboard steps (key auto-repeat). A refresh mid-hold would
// starve the kit's repeat timer — it decodes and crops ~150 photos on the
// main thread.
const STEP_SETTLE_MS = 250;
let _stepSettle = null, _stepPending = false, _pointerHeld = false;
function settleSteps() {
  clearTimeout(_stepSettle); _stepSettle = null;
  if (!_stepPending) return;
  _stepPending = false;
  refreshMapImages();
}
document.addEventListener('pointerdown', () => { _pointerHeld = true; }, true);
for (const ev of ['pointerup', 'pointercancel']) {
  document.addEventListener(ev, () => { _pointerHeld = false; settleSteps(); }, true);
}

// The kit hands over each move separately, in one flush (a clamped date and
// a rolled time arrive together). One toast shows one message at a time, so
// a flush is joined into a single toast rather than letting the last one
// overwrite the rest. Not during ?export= (the headless preview job).
let _rollMsgs = [], _rollFlush = null;
function queueRollToast(r) {
  if (_exportParam) return;
  _rollMsgs.push(P.rollMessage(r));
  if (_rollFlush) return;
  _rollFlush = setTimeout(() => {
    MCO.showToast(_rollMsgs.join(' '), 4000 + 2000 * _rollMsgs.length);
    _rollMsgs = []; _rollFlush = null;
  }, 0);
}

function initControls() {
  controls = P.initPhotoControls({
    schedule: _schedule,
    date: dateInput,
    time: timeInput,
    steppers: [
      { prev: document.getElementById('btn-date-prev'), next: document.getElementById('btn-date-next') },
      { prev: document.getElementById('btn-rail-prev'), next: document.getElementById('btn-rail-next') },
    ],
    views: { group: document.getElementById('dir-btns'), select: document.getElementById('dir-select') },
    // The 1400 label edge, not the kit's default 1060: this bar no longer fits
    // its segments below it with the 0.10.0 lockup (index.html, Responsive).
    mq: '(max-width: 1400px)',
    stations: _activeFeatures.map(f => f.station),
    onRoll: queueRollToast,
    onChange: (st, ch) => {
      // The 'init' change fires inside initPhotoControls, before `controls`
      // is assigned; onMapLoad renders and writes the first URL after it.
      if (!controls || ch.source === 'init') return;
      if (ch.source === 'step') {
        updateUrl();
        _stepPending = true;
        clearTimeout(_stepSettle);
        if (!_pointerHeld) _stepSettle = setTimeout(settleSteps, STEP_SETTLE_MS);
        return;
      }
      updateUrl();
      refreshMapImages();
    },
  });
  updateRail();
}
// A tab left open past a slot's lag: re-read the bounds and today's slots as
// the menu is about to open (so 3:00 PM is selectable once it has cleared),
// and when the tab comes back into view.
for (const ev of ["focus", "pointerdown"]) {
  timeInput.addEventListener(ev, () => { if (controls) controls.refresh(); });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && controls) controls.refresh();
});

// Rail: one button steps through the directions the selected slot offers.
document.getElementById("btn-rail-dir").addEventListener("click", () => {
  if (!controls) return;
  const dirs = controls.views();
  const cur = controls.state().view;
  controls.set({ view: dirs[(dirs.indexOf(cur) + 1) % dirs.length] });
});

// ── Layers ────────────────────────────────────────────────────────────────────
function addLayerOnce(cfg) { if (!map.getLayer(cfg.id)) map.addLayer(cfg); }

async function preloadOverlay(sourceId, url, save) {
  try {
    const fc = await MCO.fetchJSON(url);
    save(fc);
    const src = map.getSource(sourceId);
    if (src) src.setData(fc);
  } catch { /* overlays are decorative — silent failure is fine */ }
}
function addOverlaySource(id, url, cachedFC, save) {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: cachedFC || url });
  if (!cachedFC) preloadOverlay(id, url, save);
}

// Add all custom sources + layers. Called on first load and re-called on every
// style.load (theme toggle, basemap retry or fallback), which wipes them. Stack, bottom → top:
// state frame → photo rasters → boundary overlays → cell borders/hit → labels.
//
// kit-override: no MCO.map.addHillshade here — the photo mosaic is the figure
// on this map, and relief under opaque photo rasters would only show in the
// untiled west while competing with the imagery elsewhere.
function addCustomLayers() {
  // CARTO draws its own dashed county boundaries from z9 — hide them so the
  // Boundaries toggle is the single county treatment (HOUSE-STYLE §7).
  if (map.getLayer('boundary_county')) {
    map.setLayoutProperty('boundary_county', 'visibility', 'none');
  }

  addOverlaySource('tribal',   'data/mt_reservations_simple.geojson', _tribalFC,   fc => _tribalFC   = fc);
  addOverlaySource('state',    'data/mt_state_simple.geojson',        _stateFC,    fc => _stateFC    = fc);
  addOverlaySource('counties', 'data/mt_counties_simple.geojson',     _countiesFC, fc => _countiesFC = fc);

  const paints = MCO.map.overlayPaints();

  // Montana boundary frame — sits below the photos, so it reads around the
  // edges of the mosaic. Always visible (not part of the boundaries toggle).
  addLayerOnce({ id: 'state-line', type: 'line', source: 'state',
                 layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: paints.stateLine });

  if (!map.getSource('cells')) map.addSource('cells', { type: 'geojson', data: _cellsFC });

  // One image source + raster layer per station cell. URLs are filled in by
  // refreshMapImages(); layers start hidden until their photo loads.
  for (const f of _activeFeatures) {
    const lid = 'photo-' + f.station;
    if (!map.getSource(lid)) map.addSource(lid, { type: 'image', url: BLANK_IMG, coordinates: f.coords });
    addLayerOnce({ id: lid, type: 'raster', source: lid,
                   layout: { visibility: 'none' },
                   paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } });
  }

  // Boundary overlays sit ABOVE the photos so they lightly overlay the mosaic.
  // County lines + tribal fill/line/labels are toggled together by the
  // "Boundaries" button (default off).
  const overlayVis = showCounties ? 'visible' : 'none';
  addLayerOnce({ id: 'counties-line', type: 'line', source: 'counties',
                 layout: { visibility: overlayVis }, paint: paints.countiesLine });
  addLayerOnce({ id: 'tribal-fill', type: 'fill', source: 'tribal',
                 layout: { visibility: overlayVis }, paint: tribalFillPaint() });
  addLayerOnce({ id: 'tribal-line', type: 'line', source: 'tribal',
                 layout: { visibility: overlayVis }, paint: paints.tribalLine });

  addLayerOnce({ id: 'cells-outline', type: 'line', source: 'cells',
                 paint: { 'line-color': MCO.cssVar('--border'), 'line-width': 0.8, 'line-opacity': 0.9 } });
  // Transparent fill on top for hit-testing + hover highlight (feature-state).
  // The highlight is the kit's selection color, read at paint time from
  // MCO.map.selectionPaint() (--selection-ring). That paint is a circle ring
  // and this is a fill, so only its color is taken. The old '#5aaee8'
  // fallback was the dark-theme value (wrong on light).
  addLayerOnce({ id: 'cells-fill', type: 'fill', source: 'cells',
                 paint: { 'fill-color': MCO.map.selectionPaint()['circle-stroke-color'],
                          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.32, 0] } });

  // Reservation labels on top, toggled with the rest of the boundary overlays.
  addLayerOnce({ id: 'tribal-label', type: 'symbol', source: 'tribal', minzoom: 6,
                 layout: { ...MCO.map.TRIBAL_LABEL_LAYOUT, visibility: overlayVis },
                 paint: paints.tribalLabelPaint });

  refreshMapImages();
}

// Cover-crop a loaded image to a centered square, returned as a data URL.
function coverCropToDataURL(img, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const s  = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth  - s) / 2;
  const sy = (img.naturalHeight - s) / 2;
  ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.9);
}
function cacheCrop(url, dataUrl) {
  _cropCache.set(url, dataUrl);
  if (_cropCache.size > 500) _cropCache.delete(_cropCache.keys().next().value);
}
// Load + crop a photo, resolving to its data URL (or null on 404). Caches result.
function loadCrop(url) {
  const cached = _cropCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { try { const d = coverCropToDataURL(img, CROP_SIZE); cacheCrop(url, d); resolve(d); }
                          catch { resolve(null); } };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Point every cell's photo at the current date/time/direction. Cells valid for
// the date get their outline + click target; missing individual photos hide the
// raster but keep the (empty, still-clickable) cell.
function refreshMapImages() {
  const st = sel();
  if (!map || !map.getLayer('cells-fill') || !st) return;
  const token = ++_refreshToken;

  const valid = _activeFeatures.filter(f => shotAt(f.station, st.view, st)).map(f => f.station);
  const validSet = new Set(valid);
  const filt = ['in', ['get', 'station'], ['literal', valid]];
  map.setFilter('cells-outline', filt);
  map.setFilter('cells-fill', filt);

  // Photo availability resolves asynchronously, so the sr-table twin starts
  // from the full cell list marked pending (null) and is re-rendered as loads
  // land — a single stalled image can't leave the twin empty or short.
  const state = new Map();
  let pending = 0;
  let renderTimer = null;
  const scheduleRender = () => {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (token === _refreshToken) renderSRTable();
    }, 400);
  };
  const finish = () => {
    if (token !== _refreshToken) return;
    clearTimeout(renderTimer); renderTimer = null;
    renderSRTable();
    announceMosaic();
  };

  for (const f of _activeFeatures) {
    if (!validSet.has(f.station)) continue;
    state.set(f.station, null);
  }
  _photoState = state;
  renderSRTable();

  for (const f of _activeFeatures) {
    const lid = 'photo-' + f.station;
    if (!map.getLayer(lid)) continue;
    if (!validSet.has(f.station)) { map.setLayoutProperty(lid, 'visibility', 'none'); continue; }
    pending++;
    const url = thumbUrl(f.station, st.view, st);
    loadCrop(url).then((dataUrl) => {
      if (token !== _refreshToken) return;   // superseded by a newer refresh
      state.set(f.station, !!dataUrl);
      if (map.getLayer(lid)) {
        if (dataUrl) {
          map.getSource(lid)?.updateImage({ url: dataUrl });
          map.setLayoutProperty(lid, 'visibility', 'visible');
        } else {
          map.setLayoutProperty(lid, 'visibility', 'none');
        }
      }
      if (--pending === 0) finish(); else scheduleRender();
    });
  }
  if (pending === 0) finish();
}

// Screen-reader table twin of the WebGL photo mosaic (HOUSE-STYLE §5.2): one
// row per drawn grid cell, rebuilt whenever the mosaic is. The kit's
// MCO.srTable owns the markup (an .sr-only wrapper inside <main>, after the
// map, a row-count caption, textContent-only cells, and a rebuild only when a
// row changed); the id stays for anything that hooks the table.
const srTwin = MCO.srTable({
  caption: 'Montana Mesonet station photos currently shown on the map',
  columns: [
    { key: 'station', label: 'Station', rowHeader: true, value: (f) => `${f.name} (${f.station})` },
    { key: 'dir', label: 'Camera direction', value: () => P.label(sel().view) },
    { key: 'photo', label: 'Photo (Mountain Time)', value: (f) => {
        const has = _photoState.get(f.station);   // null while its load is in flight
        return has === null ? 'Loading…' : has ? stampOf(sel()) : 'No photo';
      } },
  ],
  rowKey: (f) => f.station,
});
srTwin.element.querySelector('table').id = 'sr-photo-table';
function renderSRTable() {
  srTwin.render(_activeFeatures
    .filter(f => _photoState.has(f.station))
    .sort((a, b) => a.name.localeCompare(b.name)));
}

// Announce the mosaic's contents. Deduped against the last announcement so a
// theme switch (which re-adds layers and re-renders) stays silent.
function announceMosaic() {
  const st = sel();
  const total = _photoState.size;
  const withPhoto = [..._photoState.values()].filter(Boolean).length;
  const msg = total === 0
    ? `No station photos available for ${stampOf(st)}.`
    : `${withPhoto} of ${total} stations showing ${P.label(st.view)} photos ` +
      `for ${stampOf(st)}.`;
  if (msg === _lastAnnounced) return;
  _lastAnnounced = msg;
  MCO.announce(msg);
}

// ── Hover + click interaction ─────────────────────────────────────────────────
function clearHover() {
  map.getCanvas().style.cursor = '';
  if (_hoveredId !== null) { map.setFeatureState({ source: 'cells', id: _hoveredId }, { hover: false }); _hoveredId = null; }
  hideTooltip();
}
function wireMapPointer() {
  map.on('mousemove', (e) => {
    const feats = map.getLayer('cells-fill') ? map.queryRenderedFeatures(e.point, { layers: ['cells-fill'] }) : [];
    const f = feats[0] || null;
    if (f) {
      map.getCanvas().style.cursor = 'pointer';
      if (_hoveredId !== null && _hoveredId !== f.id) map.setFeatureState({ source: 'cells', id: _hoveredId }, { hover: false });
      _hoveredId = f.id;
      map.setFeatureState({ source: 'cells', id: _hoveredId }, { hover: true });
      showTooltip(e.originalEvent, f.properties.name);
    } else if (_hoveredId !== null) {
      clearHover();
    }
  });
  map.getCanvas().addEventListener('mouseleave', clearHover);

  map.on('click', (e) => {
    const feats = map.getLayer('cells-fill') ? map.queryRenderedFeatures(e.point, { layers: ['cells-fill'] }) : [];
    if (feats.length) openModalByStation(feats[0].properties.station);
  });
}

function showTooltip(ev, text) {
  tooltipEl.textContent = text;
  tooltipEl.classList.add("visible");
  tooltipEl.style.left = `${ev.clientX + 14}px`;
  tooltipEl.style.top  = `${ev.clientY + 14}px`;
}
function hideTooltip() { tooltipEl.classList.remove("visible"); }

// ── Search ────────────────────────────────────────────────────────────────────
// The combobox is the kit's MCO.initSearchBox (0.8.0): APG keyboard model,
// accent- and typo-tolerant ranking (MCO.searchModel), a disabled "No
// matches" option, polite result counts, and Esc that closes, then clears.
// The collapse-to-icon + overlay at ≤640px is the kit's MCO.initSearchCollapse
// (this app prototyped it). This app keeps what only it knows: the `/`
// shortcut, Esc closing the overlay once the field is empty, and which control
// the gallery should treat as its opener.
const btnSearchToggle = document.getElementById('btn-search-toggle');
const searchBox = MCO.initSearchBox({
  input: searchInput,
  listbox: searchDropdown,
  items: () => _stationsList.map(s => ({ id: s.station, label: s.name })),
  onSelect: selectStation,
  label: 'Stations',
  limit: SEARCH_MAX_RESULTS,
});
const searchCollapse = MCO.initSearchCollapse({
  wrap: document.getElementById('search-wrap'),
  toggle: btnSearchToggle,
  input: searchInput,
  onClose: () => searchBox.close(),
});
// The kit handles (and stops) the Esc that closes the list or clears the
// text; the one it passes through closes the overlay, one step at a time.
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && searchCollapse.isOpen()) {
    e.preventDefault();
    searchCollapse.close();
  }
});

function selectStation(stationId) {
  // Whichever control the user came from becomes the gallery's opener, so
  // closing the dialog returns them there. In collapsed mode that's the toggle
  // — the field itself is display:none once the overlay closes, and focusing a
  // hidden element silently drops focus to <body>.
  // In rail mode the field is in the drawer, which closes here — so the menu
  // button, which stays on screen, takes focus back when the gallery closes.
  const opener = navRail.isRail() ? btnMenu
               : searchCollapse.isCollapsed() ? btnSearchToggle : searchInput;
  searchCollapse.close({ restoreFocus: false });
  navRail.close({ restoreFocus: false });
  flyToAndOpen(stationId, opener);
}

function flyToAndOpen(stationId, opener, opts) {
  const f = _featureByStation.get(stationId);
  if (!f) { MCO.showToast('Station not found'); return; }
  map.flyTo({ center: f.centroid, zoom: SEARCH_FLY_ZOOM, speed: SEARCH_FLY_SPEED,
              animate: !MCO.reducedMotion() });
  map.once('moveend', () => openModalByStation(stationId, opener, opts));
}

// ── Photo gallery modal + lightbox ────────────────────────────────────────────
// Focus restore: capture the opener and hand focus back to it on close. A
// deep-linked open has no real opener, so focus falls back to <main> rather
// than being dropped on <body>.
function restoreFocus(el) {
  if (el && el.isConnected && el !== document.body && typeof el.focus === 'function') { el.focus(); return; }
  if (mainEl) mainEl.focus();
}

// Station stepping (←/→, the header and lightbox arrows, swipe in the
// lightbox). Order is alphabetical by station id. The candidate lists are
// recomputed per step so a date change is picked up without bookkeeping —
// ~200 ids is trivial. The gallery includes any station with at least one
// direction at the selected slot; the lightbox holds its direction fixed and
// skips stations that lack it.
function galleryStations(st) {
  return _stationOrder.filter(id => _schedule.tokens.some(d => shotAt(id, d, st)));
}
function lightboxStations(dir, st) {
  return _stationOrder.filter(id => shotAt(id, dir, st));
}
// Wrap-around step. A current id missing from the list (the date changed under
// it) restarts from the first entry.
function stepIn(list, current, delta) {
  const n = list.length;
  if (!n) return null;
  const i = list.indexOf(current);
  if (i < 0) return { id: list[0], index: 0, total: n, wrapped: false };
  const j = ((i + delta) % n + n) % n;
  return { id: list[j], index: j, total: n, wrapped: delta > 0 ? j < i : j > i };
}
function stepNote(r) {
  const wrap = !r.wrapped ? '' : r.index === 0 ? ' Wrapped to the first station.' : ' Wrapped to the last station.';
  return ` Station ${r.index + 1} of ${r.total}.${wrap}`;
}

const photoGrid = document.getElementById("photo-grid");
let _galleryOpener = null;

// Fill the gallery for a station. Runs at open and on every step; it owns the
// selected-station state and mirrors it into the URL, so a reload lands on the
// station the user stepped to. Returns the photo count for the announcement.
function renderGallery(stationId, { writeUrl = true } = {}) {
  const f = _featureByStation.get(stationId);
  if (!f) return 0;
  const st = sel();

  document.getElementById("modal-station-name").textContent = f.name;
  document.getElementById("modal-timestamp").textContent    = stampOf(st);

  const dashWrap = document.getElementById("modal-dash-link");
  dashWrap.innerHTML = "";
  const dashLink = document.createElement("a");
  dashLink.href = DASH_URL(stationId);
  dashLink.target = "_blank";
  dashLink.rel = "noopener";
  dashLink.textContent = `Open ${f.name} dashboard →`;
  dashWrap.append(dashLink);

  photoGrid.innerHTML = "";
  const validDirs = _schedule.tokens.filter(dir => shotAt(stationId, dir, st));
  const showEmpty = () => {
    const msg = document.createElement("p");
    msg.className = "photo-empty";
    msg.textContent = "No photos available for this station at the selected time.";
    photoGrid.append(msg);
  };
  if (validDirs.length === 0) showEmpty();
  validDirs.forEach(dir => {
    const dirName = P.label(dir);
    const card = document.createElement("div");
    card.className = "photo-card";
    // A real <button>, not a click handler on the <img>: the enlarge gesture
    // needs a keyboard twin and a focus target (HOUSE-STYLE §5.8).
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "photo-btn";
    btn.dataset.dir = dir;   // focus target for the lightbox after a station step rebuilds the grid
    btn.setAttribute("aria-label", `${dirName} view of ${f.name} — enlarge`);
    const img = document.createElement("img");
    img.alt = "";
    img.src = thumbUrl(stationId, dir, st);
    img.loading = "lazy";
    // A camera that was offline at this slot 404s: drop its card, and once the
    // last one is gone say so rather than leaving a silent empty grid — stepping
    // through stations lands here far more often than clicking the map did.
    img.addEventListener("error", () => {
      card.remove();
      if (!photoGrid.querySelector(".photo-card")) showEmpty();
    });
    btn.addEventListener("click", () => openLightbox(stationId, dir, btn));
    btn.append(img);
    const label = document.createElement("div");
    label.className = "photo-dir-label";
    label.textContent = dirName;
    card.append(btn, label);
    photoGrid.append(card);
  });

  _selectedStation = stationId;
  if (writeUrl) updateUrl();
  return validDirs.length;
}
// Opening the gallery from the map or search is drill-down (HOUSE-STYLE §4):
// it PUSHES a history entry, marked {mcoDetail}, so Back closes it and
// Forward reopens it. A deep link and a Forward replay pass push:false — their
// entry already names the station. Station steps inside the gallery or
// lightbox replace (renderGallery → updateUrl), so stepping never floods the
// history.
function openModalByStation(stationId, opener, { push = true } = {}) {
  const f = _featureByStation.get(stationId);
  if (!f) return;
  const n = renderGallery(stationId, { writeUrl: false });
  updateUrl(push ? { push: true, state: { mcoDetail: stationId } } : {});
  _galleryOpener = opener || document.activeElement;
  modal.showModal();
  document.getElementById("modal-close").focus();
  MCO.announce(n
    ? `Photo gallery for ${f.name} opened, ${n} photos.`
    : `Photo gallery for ${f.name} opened, no photos for this date.`);
}
// Focus stays where it is: the arrows live in the header, which isn't rebuilt.
function stepGalleryStation(delta) {
  const r = stepIn(galleryStations(sel()), _selectedStation, delta);
  if (!r) return;
  const n = renderGallery(r.id);
  MCO.announce(`Photo gallery for ${_featureByStation.get(r.id).name}, ${n} photos.${stepNote(r)}`);
}
// One close path for the button, Esc and backdrop click alike.
// The map deliberately never moves for a station step, not even on close —
// the user is browsing photos, not the map.
// Closing: if this gallery pushed its entry, step Back over it, so the
// dialog's own close (×, Esc, backdrop) and the browser's Back land on the
// same entry and the history never holds two "gallery closed" entries in a
// row; Forward reopens the gallery either way. When Back itself closed it
// (_closingFromHistory), the URL is already right and nothing is popped again.
let _closingFromHistory = false;
modal.addEventListener("close", () => {
  _selectedStation = null;
  if (_closingFromHistory) _closingFromHistory = false;
  else if (history.state && history.state.mcoDetail) history.back();
  else updateUrl();
  restoreFocus(_galleryOpener);
  _galleryOpener = null;
});
// Back / Forward (MCO.onUrlState): the only pushed entries are gallery
// openings, so all a history move does here is close or (re)open the gallery.
MCO.onUrlState((params) => {
  // The slot is replaced, never pushed, so it only differs here if an entry
  // was written by hand; follow it if so. Silent: the entry is already the
  // URL, and a write here would land on the entry being left.
  if (controls) {
    const cur = controls.state();
    const want = {
      date: P.isDate(params.get('date')) ? params.get('date') : cur.date,
      time: P.normalizeTime(params.get('time')) || cur.time,
      view: (params.get('dir') || P.DEFAULT_VIEW).toUpperCase(),
    };
    if (want.date !== cur.date || want.time !== cur.time || want.view !== cur.view) {
      controls.set(want, { silent: true });
      updateRail();
      refreshMapImages();
    }
  }
  const st = (params.get('station') || '').toLowerCase();
  if (st && _featureByStation.has(st)) {
    if (!modal.open) openModalByStation(st, null, { push: false });
    else if (st !== _selectedStation) renderGallery(st, { writeUrl: false });
  } else if (modal.open) {
    _closingFromHistory = true;
    _galleryStale = false;   // no re-render (and so no URL write) on the way out
    if (lightbox.open) lightbox.close();
    modal.close();
  }
});
document.getElementById("modal-close").addEventListener("click", () => modal.close());
modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
document.getElementById("btn-station-prev").addEventListener("click", () => stepGalleryStation(-1));
document.getElementById("btn-station-next").addEventListener("click", () => stepGalleryStation(+1));

const lightboxImg     = document.getElementById("lightbox-img");
const lightboxCaption = document.getElementById("lightbox-caption");
let _lightboxOpener  = null;
let _lightboxStation = null, _lightboxDir = null;
let _galleryStale    = false;   // the lightbox stepped away from the station the gallery shows

function showLightboxPhoto(stationId, dir) {
  const f = _featureByStation.get(stationId);
  const caption = `${f.name} · ${stampOf(sel())} · ${P.label(dir)}`;
  lightboxImg.src = largeUrl(stationId, dir);
  lightboxImg.alt = caption;
  lightboxCaption.textContent = caption;
  _lightboxStation = stationId;
  _lightboxDir     = dir;
  return caption;
}
function openLightbox(stationId, dir, opener) {
  showLightboxPhoto(stationId, dir);
  _lightboxOpener = opener || document.activeElement;
  lightbox.showModal();
}
// The gallery underneath is left alone until the lightbox closes — rebuilding
// seven thumbnails per keypress would make stepping sluggish. Only the state
// (selected station + URL) moves immediately.
function stepLightboxStation(delta) {
  const r = stepIn(lightboxStations(_lightboxDir, sel()), _lightboxStation, delta);
  if (!r) return;
  const caption = showLightboxPhoto(r.id, _lightboxDir);
  _selectedStation = r.id;
  _galleryStale    = true;
  updateUrl();
  MCO.announce(`${caption}.${stepNote(r)}`);
}
lightbox.addEventListener("close", () => {
  lightboxImg.src = BLANK_IMG;   // not "" — that re-requests the page itself
  if (_galleryStale) { renderGallery(_selectedStation); _galleryStale = false; }
  // The opener is gone if the grid was rebuilt for a new station: fall back to
  // the same direction's photo, then the close button. Never <main> — it is
  // inert while the gallery dialog is still open.
  const target = (_lightboxOpener && _lightboxOpener.isConnected) ? _lightboxOpener
    : (photoGrid.querySelector(`.photo-btn[data-dir="${_lightboxDir}"]`) || document.getElementById("modal-close"));
  restoreFocus(target);
  _lightboxOpener = null; _lightboxStation = null; _lightboxDir = null;
});
document.getElementById("lightbox-close").addEventListener("click", () => lightbox.close());
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.close(); });
document.getElementById("lightbox-prev").addEventListener("click", () => stepLightboxStation(-1));
document.getElementById("lightbox-next").addEventListener("click", () => stepLightboxStation(+1));

// ←/→ step stations in whichever dialog is open. The listeners sit on the
// dialogs themselves (siblings, not nested) so only the open one reacts. Arrow
// keys aren't printable characters, so this is outside the ?kbd=off opt-out
// (WCAG 2.1.4 covers letters, punctuation, numbers and symbols).
function arrowStepper(step) {
  return (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft")       { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(+1); }
  };
}
modal.addEventListener("keydown", arrowStepper(stepGalleryStation));
lightbox.addEventListener("keydown", arrowStepper(stepLightboxStation));

// Horizontal swipe on the enlarged photo steps stations — lightbox only; in
// the gallery grid it would fight vertical scrolling.
const SWIPE_MIN_PX = 50;
let _touchStart = null;
lightbox.addEventListener("touchstart", (e) => {
  const t = e.changedTouches[0];
  _touchStart = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
lightbox.addEventListener("touchend", (e) => {
  if (!_touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - _touchStart.x, dy = t.clientY - _touchStart.y;
  _touchStart = null;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= 2 * Math.abs(dy)) return;
  e.preventDefault();   // swallow the synthesized click, which would hit the backdrop-close handler
  stepLightboxStation(dx < 0 ? +1 : -1);
}, { passive: false });

// ── Info modal ────────────────────────────────────────────────────────────────
MCO.initInfoModal({ dialog: infoModal, trigger: document.getElementById("btn-info") });
// First-visit auto-open, suppressed over deep links (someone following a shared
// URL shouldn't land behind a help dialog) and in headless export runs. The
// seen flag is written at OPEN time so an unclosed dialog still counts.
const DEEP_LINK_PARAMS = ['station', 'date', 'time', 'dir', 'overlay', 'lng', 'export'];
const hasDeepLink = DEEP_LINK_PARAMS.some((k) => urlParams.has(k));
const seenIntro = MCO.lsGet(LS_SEEN) === '1' || MCO.lsGet(LS_SEEN_OLD) === '1';
if (!seenIntro && !hasDeepLink) {
  setTimeout(() => {
    if (!infoModal.open && !modal.open) infoModal.showModal();
    MCO.lsSet(LS_SEEN, '1');
  }, 350);
}

// ── Boundaries toggle (county lines + tribal nations, together) ───────────────
const BOUNDARY_LAYERS = ["counties-line", "tribal-fill", "tribal-line", "tribal-label"];
const btnCounties = document.getElementById("btn-counties");
btnCounties.setAttribute("aria-pressed", showCounties ? "true" : "false");
btnCounties.addEventListener("click", () => {
  showCounties = !showCounties;
  btnCounties.setAttribute("aria-pressed", showCounties ? "true" : "false");
  MCO.lsSet(LS_COUNTIES, showCounties ? "1" : "0");
  const vis = showCounties ? "visible" : "none";
  for (const lid of BOUNDARY_LAYERS) {
    if (map && map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", vis);
  }
  updateUrl();
});

// ── Share ─────────────────────────────────────────────────────────────────────
// Copy the current (deep-link) URL. Uses the async Clipboard API where available,
// with an execCommand fallback, and always surfaces a toast so the click has
// visible feedback even if the clipboard is blocked.
async function copyShareLink() {
  const url = location.href;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
      MCO.showToast("Link copied to clipboard!");
      return;
    }
  } catch { /* fall through to the execCommand fallback */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    MCO.showToast(ok ? "Link copied to clipboard!" : "Copy this link: " + url, ok ? undefined : 6000);
  } catch {
    MCO.showToast("Copy this link: " + url, 6000);
  }
}
document.getElementById("btn-share").addEventListener("click", copyShareLink);

// ── Landscape rail + drawer (kit 0.10.0) ──────────────────────────────────────
// On short landscape screens (MCO.viewport.RAIL_MQ) the navbar is the kit's
// left rail and the full control set lives in its drawer. MCO.initNavRail owns
// the disclosure: aria-expanded on the menu button, focus into the drawer on
// open (the search field first), everything else inert under the scrim, Esc /
// the scrim / the button to close with focus back on the button, and closing
// when a rotation leaves rail mode. The app keeps its three hand-offs (HOUSE-
// STYLE §3 Short landscape): `/` opens the drawer on the search field, a search
// result closes it without restoring focus, and Export / the info dialog close
// it first (the map has to be visible for them).
const btnMenu = document.getElementById('btn-menu');
const navRail = MCO.initNavRail({
  toggle: btnMenu,
  drawer: document.getElementById('nav-drawer'),
  scrim: document.getElementById('rail-scrim'),
  initialFocus: searchInput,
});
for (const id of ['btn-export', 'btn-info']) {
  document.getElementById(id).addEventListener('click', () => navRail.close({ restoreFocus: false }));
}

// Date/time/direction at a glance, since the drawer is usually closed.
// A function declaration with its own lookups: buildDirectionControls and
// updateUrl may call it before this part of the script has run.
function updateRail() {
  const railReadout = document.getElementById('rail-readout');
  const btnRailDir  = document.getElementById('btn-rail-dir');
  const st = sel();
  if (!st || !st.time) return;
  const d = new Date(`${st.date}T12:00:00Z`);
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  railReadout.replaceChildren(...[md, String(d.getUTCFullYear()), P.slotLabel(st.time)].map(t => {
    const span = document.createElement('span'); span.textContent = t; return span;
  }));
  btnRailDir.textContent = P.shortLabel(st.view);
  btnRailDir.setAttribute('aria-label', `Camera direction ${P.viewName(st.view)}. Switch to next direction`);
}

// ── Global keyboard shortcuts ─────────────────────────────────────────────────
// Single-character shortcuts are gated by ?kbd=off (WCAG 2.1.4). Esc is not a
// printable character, so the dialogs' native Esc handling stays live either way.
window.addEventListener("keydown", (e) => {
  if (!kbdShortcuts) return;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    // Rail mode: the field lives in the drawer.
    if (navRail.isRail()) { navRail.open(searchInput); return; }
    // Below 460px the field is collapsed — open the overlay instead of focusing
    // a hidden input (which would silently do nothing).
    if (searchCollapse.isCollapsed()) { searchCollapse.open(); return; }
    searchInput.focus();
    searchInput.select();
  }
});

// ── URL sync & social meta ────────────────────────────────────────────────────
// Tab and link card per HOUSE-STYLE §1 through the kit (MCO.setPageTitle /
// MCO.setSocialMeta): the tab stays the short name, matching the Explorer and
// UMRB Build maps; the card gets the date as its one detail ("October 9, 2026 ·
// Photos · Montana Mesonet"), with the time and direction in the description.
// The card image is the bot-regenerated preview.png (preview.yml), not the
// kit's og-card. og:url follows the shared state; the canonical link stays the
// static production one in index.html (no `canonical` passed — kit 0.11.2).
function updateSocialMeta() {
  const st = sel();
  if (!st || !st.time) return;
  const label = P.label(st.view);
  const dateFmt = MCO.formatDateStr(st.date);
  const timeFmt = `${P.slotLabel(st.time)} MT`;
  const desc  = `Montana weather station photos for ${dateFmt} at ${timeFmt}, ${label} direction. ` +
                `A service of the Montana Climate Office.`;
  MCO.setPageTitle({ short: 'Photos' });
  MCO.setSocialMeta({
    short: 'Photos', detail: dateFmt, description: desc,
    image: new URL("preview.png", location.href).href, imageWidth: 2800, imageHeight: 1400,
    imageAlt: 'Map of Montana Mesonet weather stations with station photos',
    url: location.href,
  });
  document.querySelector('meta[name="description"]')?.setAttribute("content", desc);
}
// Mirror state into the query string (HOUSE-STYLE §4). Defaults are elided —
// except date and time, which are always emitted on purpose: their "default"
// is the latest available timestep, so a link without them would show a
// different view tomorrow.
function updateUrl({ push = false, state } = {}) {
  // date, time ("15" on the hour, "09:30" otherwise) and dir (only away from
  // North) come from the kit's controls. Before the schedule has loaded (or
  // if it failed to), the incoming ones are carried through unchanged.
  const params = controls ? controls.params() : {};
  if (!controls) {
    for (const k of ['date', 'time', 'dir']) if (urlParams.has(k)) params[k] = urlParams.get(k);
  }
  if (showCounties) params.overlay = "counties";
  // Clean-URL defaults (HOUSE-STYLE §4): the theme only when it differs from
  // the OS preference a visitor with no choice would get, and the camera only
  // away from the default Montana extent. Old links carrying either still
  // work: the anti-flash script reads ?theme=, initialCamera reads the camera.
  const theme = MCO.getTheme();
  if (theme !== MCO.osTheme()) params.theme = theme;
  // With a gallery open the camera is always written: a reload or shared link
  // with ?station= and a camera opens the gallery in place, while a bare
  // ?station= link flies to the station first (map 'load' handler).
  if (_mapReady && map) {
    Object.assign(params, _selectedStation ? MCO.map.cameraParams(map) : MCO.map.cameraParamsIfDefault(map));
  }
  if (_selectedStation) params.station = _selectedStation;
  if (internalView) params.internal = '1';
  if (!kbdShortcuts) params.kbd = 'off';   // preserve the a11y opt-out across navigation
  if (push) MCO.pushUrlState(params, { state });
  else MCO.replaceUrlState(params);
  updateSocialMeta();
  updateRail();
}

// ── Export (PNG with MCO branding) ────────────────────────────────────────────
// App-local: the kit has no export module yet (MIGRATING.md § kit-deferred).
// Renders a fixed EXPORT_W×EXPORT_H MapLibre map off-screen so the output is
// identical regardless of the live viewport, composites the MCO logo, and
// downloads. ?export=1|light|dark drives this for the social-preview generator.
document.getElementById("btn-export").addEventListener("click", exportPNG);

async function exportPNG() {
  if (!_activeFeatures.length || !sel()) { MCO.showToast("Map not loaded yet."); return; }
  MCO.showToast("Exporting…");
  const W = EXPORT_W, H = EXPORT_H;

  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px;pointer-events:none;`;
  document.body.appendChild(holder);

  const xm = new maplibregl.Map({
    container: holder,
    style: MCO.map.cartoStyleUrl(),
    bounds: MCO.map.MT_FIT_BOUNDS,
    fitBoundsOptions: MCO.map.FIT_OPTS,
    interactive: false,
    attributionControl: false,
    // Required for getCanvas() readback. MapLibre 5+ reads it from
    // canvasContextAttributes; the old top-level option is ignored.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    pixelRatio: EXPORT_SCALE,      // render at 2× for a high-resolution PNG
    fadeDuration: 0,
  });

  try {
    await once(xm, 'load');
    const st = sel();
    const valid = _activeFeatures.filter(f => shotAt(f.station, st.view, st));
    const paints = MCO.map.overlayPaints();

    if (xm.getLayer('boundary_county')) xm.setLayoutProperty('boundary_county', 'visibility', 'none');

    // Montana boundary frame below the photos
    xm.addSource('state', { type: 'geojson', data: _stateFC || 'data/mt_state_simple.geojson' });
    xm.addLayer({ id: 'state-line', type: 'line', source: 'state',
                  layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: paints.stateLine });

    // Photos (awaited so the map is complete before capture)
    const crops = await Promise.all(valid.map(f => loadCrop(thumbUrl(f.station, st.view, st))));
    valid.forEach((f, i) => {
      if (!crops[i]) return;
      const sid = 'photo-' + f.station;
      xm.addSource(sid, { type: 'image', url: crops[i], coordinates: f.coords });
      xm.addLayer({ id: sid, type: 'raster', source: sid,
                    paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } });
    });

    // Boundary overlays lightly over the photos — only when the toggle is on.
    if (showCounties) {
      xm.addSource('counties', { type: 'geojson', data: _countiesFC || 'data/mt_counties_simple.geojson' });
      xm.addSource('tribal',   { type: 'geojson', data: _tribalFC   || 'data/mt_reservations_simple.geojson' });
      xm.addLayer({ id: 'counties-line', type: 'line', source: 'counties', paint: paints.countiesLine });
      xm.addLayer({ id: 'tribal-fill',   type: 'fill', source: 'tribal',   paint: tribalFillPaint() });
      xm.addLayer({ id: 'tribal-line',   type: 'line', source: 'tribal',   paint: paints.tribalLine });
    }

    // Cell borders on top
    const validIds = valid.map(f => f.station);
    xm.addSource('cells', { type: 'geojson', data: _cellsFC });
    xm.addLayer({ id: 'cells-outline', type: 'line', source: 'cells',
                  filter: ['in', ['get', 'station'], ['literal', validIds]],
                  paint: { 'line-color': MCO.cssVar('--border'), 'line-width': 0.8, 'line-opacity': 0.9 } });

    // Reservation labels on top — only when the toggle is on.
    if (showCounties) {
      xm.addLayer({ id: 'tribal-label', type: 'symbol', source: 'tribal', minzoom: 0,
                    layout: MCO.map.TRIBAL_LABEL_LAYOUT, paint: paints.tribalLabelPaint });
    }

    await once(xm, 'idle');

    const mc = xm.getCanvas();
    const canvas = document.createElement('canvas');
    canvas.width = mc.width; canvas.height = mc.height;   // 2× via pixelRatio
    const ctx = canvas.getContext('2d');
    ctx.drawImage(mc, 0, 0);
    // Draw the branding card in logical (EXPORT_W×EXPORT_H) coords, scaled up so
    // its text/shapes stay crisp at the higher output resolution.
    ctx.save();
    ctx.scale(canvas.width / W, canvas.height / H);
    await drawBranding(ctx, W, H);
    ctx.restore();

    canvas.toBlob((blob) => {
      if (!blob) { MCO.showToast("Export failed."); return; }
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {
        href: url, download: `mesonet-photos-${st.date}-${st.view}.png`,
      });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      MCO.showToast("Exported!");
    }, "image/png");
  } catch (err) {
    console.error(err);
    MCO.showToast("Export failed.");
  } finally {
    xm.remove();
    holder.remove();
  }
}

function loadImg(url) {
  return new Promise((res) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = url;
  });
}
function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}
// True when a CSS color is light enough that dark text reads on it (the card's
// background decides the wordmark twin, not the page theme). A 1×1 canvas
// normalises any CSS color the tokens may use; relative luminance per WCAG.
function isLightColor(color) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000'; c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.179;
}

// Branding card in the lower-left corner (over the basemap): the kit's MCO
// wordmark (its own "Montana Climate Office" text, so it isn't repeated in
// type), then the app name, the slot and direction, and the URL. Canvas can't
// read custom properties, so the tokens are resolved here (MIGRATING.md §
// gotchas). The wordmark keeps HOUSE-STYLE §1's clear space (≥15% of its
// height) and minimum size (40px tall).
async function drawBranding(ctx, W, H) {
  const cs = getComputedStyle(document.documentElement);
  const bgSurface = cs.getPropertyValue("--bg-surface").trim();
  const borderClr = cs.getPropertyValue("--border").trim();
  const accentLn  = cs.getPropertyValue("--accent-line").trim();
  const textMuted = cs.getPropertyValue("--text-muted").trim();
  const fontUi    = cs.getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";

  const MARK_H = 44, MARK_W = Math.round(MARK_H * 432 / 159);   // the SVG's 432×159 viewBox
  const BRAND_W = 340, BRAND_BOX_H = 72;
  const BX = 24, BY = H - 24 - BRAND_BOX_H, PAD = 14;
  const LX = BX + PAD, LY = BY + (BRAND_BOX_H - MARK_H) / 2;

  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = bgSurface;
  ctx.beginPath(); roundRectPath(ctx, BX, BY, BRAND_W, BRAND_BOX_H, 10); ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = borderClr; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  const mark = await loadImg(WORDMARK_URL(isLightColor(bgSurface)));
  if (mark) ctx.drawImage(mark, LX, LY, MARK_W, MARK_H);

  // Text column, a clear-space gap right of the mark.
  const TX = LX + MARK_W + Math.ceil(MARK_H * 0.15) + 6, TW = BX + BRAND_W - PAD - TX, midY = BY + BRAND_BOX_H / 2;
  ctx.textBaseline = "middle";
  ctx.fillStyle = accentLn;
  ctx.font = `700 13px ${fontUi}`;
  ctx.fillText("Mesonet Photo Explorer", TX, midY - 13, TW);
  ctx.fillStyle = textMuted;
  ctx.font = `400 11px ${fontUi}`;
  const st = sel();
  ctx.fillText(`${stampOf(st)} · ${P.label(st.view)}`, TX, midY + 3, TW);
  ctx.textAlign = "right";
  ctx.font = `italic 10px ${fontUi}`;
  ctx.fillText("climate.umt.edu", BX + BRAND_W - PAD, BY + BRAND_BOX_H - 9);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Last, so every control above is wired before the map exists.
MCO.map.loadMapLibre().then(initMap, onMapLibraryFail);
})();
