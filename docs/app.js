/* ============================================================================
   Montana Mesonet Photo Explorer

   Consumes mco-web-style (window.MCO / MCO.map) — see index.html for the
   pinned + SRI kit tags. Classic script: the kit globals need no modules, and
   an external file lets the page ship a strict CSP without 'unsafe-inline'.

   App-owned (deliberately NOT in the kit — MIGRATING.md § kit-deferred):
   the photo-mosaic machinery (cover-crop + LRU cache, one image source per
   station cell), the gallery/lightbox dialogs, the date stepper, the direction
   segments + <select> fallback, updateSocialMeta, and the branded PNG export.
   ========================================================================== */
(function () {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const CLOUDFRONT_BASE = "https://data2.climate.umt.edu/mesonet";       // WebP photos, thumb + large
// What each station photographs, at which Mountain wall-clock slots, since when
// — published by the mesonet-cameras repo (`mesocam rollout publish`), replacing
// the Airtable-fed /api/v2/photos list that had drifted from the cameras.
const SCHEDULE_URL    = `${CLOUDFRONT_BASE}/photos/schedule/schedule.json`;
const SCHEDULE_SCHEMA = 1;
const STATIONS_META   = "https://mesonet2.climate.umt.edu/api/stations?type=json";
const STATUS_META     = "https://mesonet2.climate.umt.edu/api/stations/status?type=json";
const GRID_URL        = "grid.geojson";
const DASH_URL        = (s) => `https://mesonet.climate.umt.edu/dash/${s}`;
const LOGO_URL        = "assets/mco-logo.png";   // vendored — never hot-link climate.umt.edu (HOUSE-STYLE §1)

const DIR_ORDER  = ["N", "S", "E", "W", "SNOW", "NS", "SS"];
const DIR_LABELS = { N: "North", S: "South", E: "East", W: "West", SNOW: "Snow", NS: "North Sky", SS: "South Sky" };
const DEFAULT_DIR = "W";
// Curated labels win over the schedule's `view` names (which are literally "NS"/
// "SS" for the sky cameras); a token the kit has never seen falls back to them.
function dirLabel(d) { return DIR_LABELS[d] || _viewNames[d] || d; }

// Earliest date the picker admits. The schedule's `first_month` reaches back to
// 2016-12 for a few stations, but WebP coverage before this is sparse; this is
// the network-wide start the old API reported, so landing behaviour is unchanged.
const PHOTOS_MIN_DATE = "2022-09-22";

const SEARCH_FLY_ZOOM    = 8.5;
const SEARCH_FLY_SPEED   = 1.4;
const SEARCH_MAX_RESULTS = 8;

// Processing lag: a slot's photos are assumed published this long after the
// wall-clock slot. computeMaxTimestep and the Time menu's disabled state both
// read it; the probe below covers the days the lag isn't flat.
const SLOT_LAG_MINUTES = 30;
// How far a "previous day with any slot" walk may go. The schedule has no gaps
// in practice; this only stops a loop over a hypothetical sparse stretch.
const SLOT_WALK_MAX_DAYS = 60;

// Landing-slot fallback. computeMaxTimestep assumes a flat processing lag, but
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

const cssVar = (n, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;
const once = (m, ev) => new Promise((r) => m.once(ev, r));

// Local-getter date shift. Deliberately NOT MCO.shiftDate: that reads its
// result back with toISOString() (UTC), which lands a day off for viewers in
// UTC+13/+14 and UTC−12. Kit defect reported separately.
function shiftDate(dateStr, deltaDays) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${MCO.pad2(d.getMonth() + 1)}-${MCO.pad2(d.getDate())}`;
}

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

// Which Mountain wall-clock times the Time <select> offers is decided per
// selected date from the schedule (slotsForDate, below). The static <option>s
// in index.html are only a placeholder — what the controls show until the
// schedule has loaded, or if it never does. Slot values are "HH:MM:SS"
// throughout this app; the schedule writes "HH:MM".
const _placeholderSlots = [...timeInput.options].map(o => o.value);

// Screen-reader announcements for what the WebGL mosaic shows (HOUSE-STYLE
// §5.1) go through the kit's one page announcer, MCO.announce (polite) — the
// hidden-table twin below carries the detail.

// ── State ─────────────────────────────────────────────────────────────────────
// Parsed schedule.json. Period bounds are epoch ms (`until` Infinity = current);
// each view maps a direction token to the Set of "HH:MM" slots it shoots, and
// `slots` is that period's union across views (what slotsForDate counts).
let _schedule  = {};                  // stationId → { firstDate: "YYYY-MM-DD", periods: [{ from, until, views: Map<token, Set<"HH:MM">>, slots: Set<"HH:MM"> }] }
let _slotCandidates = [];             // every "HH:MM" any view has ever shot, sorted — slotsForDate's candidate list
const _slotsByDate  = new Map();      // "YYYY-MM-DD" → ["HH:MM:SS", …] the menu offers that day (slotsForDate memo)
let _wantedTime  = null;              // "HH:MM:SS" the user or URL last chose explicitly; date changes resolve from it
let _pendingRoll = null;              // { from, to, reason } — a time move not yet announced (hold-to-repeat batches them)
let _allDirs   = [];                  // tokens present anywhere in the schedule, DIR_ORDER first, unknowns appended sorted
let _shownDirs = [];                  // the subset of _allDirs the direction controls currently offer (dirsForSlot)
let _wantedDir = null;                // token the user or URL last chose explicitly; slot changes resolve from it
let _viewNames = {};                  // token → the schedule's `view` name (label fallback for tokens DIR_LABELS lacks)
let currentDir;
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

// An explicit slot — a deep link, a shared URL, the export job — is never
// silently moved by the landing-slot fallback below.
const _slotPinnedByUrl = urlParams.has('date') || urlParams.has('time');

// Single-character shortcuts need an opt-out (WCAG 2.1.4). Re-emitted on
// replaceState so it sticks while browsing, but excluded from shared links.
const kbdShortcuts = getLower('kbd') !== 'off';

// Headless export: ?export=light|dark forces the theme before the map is built.
// Set directly (not MCO.setTheme) so a CI screenshot run never persists a theme.
const _exportParam = urlParams.get('export');
if (_exportParam === 'light' || _exportParam === 'dark') {
  document.documentElement.dataset.theme = _exportParam;
}

// ── Time helpers (Mountain Time — house convention for every stamp) ───────────
// "HH:MM[:SS]" → "9:00 AM" / "12:00 PM": the one 12-hour formatter, shared by
// the menu labels, the mosaic stamp, the toasts and the social meta.
function slotLabel(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${MCO.pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
function slotMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function asSlotValue(hhmm) { return hhmm.length === 5 ? `${hhmm}:00` : hhmm; }
// ?time= accepts "9", "09", "9:30" or "09:30:00"; anything else is ignored.
function normaliseTimeParam(v) {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(String(v ?? '').trim());
  if (!m || +m[1] > 23) return null;
  return `${MCO.pad2(+m[1])}:${m[2] || '00'}:${m[3] || '00'}`;
}

// The slots the Time menu offers on `dateStr`: those scheduled — period-aware,
// at that date's UTC instant of each slot — by at least half of the stations
// shooting anything that day. A majority rather than a union, so the Sep 2026
// hourly pilot (≈30 cameras for nine days) doesn't turn the menu into 24
// entries while the other ~120 cameras shot 09:00/15:00. Memoised per date (it
// doesn't depend on the clock). Slot-outer/station-inner on purpose: the one
// mtInstantMs call per candidate is then the whole Intl cost of a date.
// Before the schedule is parsed, the placeholder options stand in.
// (arrivals.json, the audit job's expected-vs-received snapshot, is not read:
// as published it is a stale two-day window. Were it live, this is where a
// "slot has actually landed" signal would join the schedule.)
function slotsForDate(dateStr) {
  if (!_slotCandidates.length) return _placeholderSlots.slice();
  let slots = _slotsByDate.get(dateStr);
  if (slots) return slots;
  const ids = Object.keys(_schedule).filter(id => dateStr >= _schedule[id].firstDate);
  const shooting = new Set();          // stations with ≥1 slot that day → the denominator
  const counts = [];                   // [ "HH:MM", stations ]
  for (const hhmm of _slotCandidates) {
    const dt = `${dateStr}T${hhmm}:00`;
    const t  = mtInstantMs(dt);
    // A wall-clock time that doesn't exist that day (02:00 on the spring-forward
    // day) or is ambiguous (01:00 on the fall-back day) reads back as something
    // else — skip it rather than key photos by a name no camera shot under.
    if (mtWallClock(t) !== dt) continue;
    let n = 0;
    for (const id of ids) {
      if (_schedule[id].periods.some(p => t >= p.from && t < p.until && p.slots.has(hhmm))) {
        n++; shooting.add(id);
      }
    }
    if (n) counts.push([hhmm, n]);
  }
  const need = Math.ceil(shooting.size / 2);
  slots = counts.filter(([, n]) => n >= need).map(([h]) => asSlotValue(h));
  // A sparse early-schedule day where nothing reaches a majority still needs a
  // menu: offer whatever anyone shot. Never leave the <select> empty — every
  // stamp in the app is built from its value.
  if (!slots.length) slots = counts.map(([h]) => asSlotValue(h));
  if (!slots.length) slots = _placeholderSlots.slice();
  _slotsByDate.set(dateStr, slots);
  return slots;
}

// Last offered slot of the newest day before `dateStr` that offers any.
function lastSlotBefore(dateStr) {
  let date = dateStr;
  for (let i = 0; i < SLOT_WALK_MAX_DAYS; i++) {
    date = shiftDate(date, -1);
    if (date < PHOTOS_MIN_DATE) break;
    const slots = slotsForDate(date);
    if (slots.length) return { date, time: slots[slots.length - 1] };
  }
  return null;
}

// Latest photo timestep whose slot the processing lag has cleared: the newest
// of today's slots at or before now − lag, else the last slot of the day
// before. Also the picker's forward bound — refreshed on every call, so today
// is unreachable until its first slot has cleared (no menu of all-disabled
// entries) and a tab left open past that moment can step forward into it.
function computeMaxTimestep(lagMinutes = SLOT_LAG_MINUTES) {
  const today  = MCO.todayMT();
  const thresh = slotMinutes(MCO.hhmmNowMT()) - lagMinutes;
  const cleared = slotsForDate(today).filter(t => slotMinutes(t) <= thresh);
  const ts = cleared.length
    ? { date: today, time: cleared[cleared.length - 1] }
    : (lastSlotBefore(today) || { date: today, time: slotsForDate(today)[0] });
  dateInput.max = ts.date;
  return ts;
}

// The slot immediately before {dateStr, timeStr}: the previous offered time that
// day, or the last offered time of the nearest earlier day with any.
function previousSlot(dateStr, timeStr) {
  const times = slotsForDate(dateStr);
  const i = times.indexOf(timeStr);
  if (i > 0)   return { date: dateStr, time: times[i - 1] };
  if (i === 0) return lastSlotBefore(dateStr);
  return null;   // unknown time value — don't guess
}

// Rebuild the Time menu for `dateStr`. Today's slots the lag hasn't cleared yet
// stay listed — the cadence is worth seeing — but disabled, with the reason in
// the label so it is spoken as well as greyed. The DOM is touched only when the
// rendered list would actually change (iOS's native picker loses its place
// otherwise), and options only ever become enabled over time, so a selection
// made earlier stays valid.
function syncTimeOptions(dateStr) {
  const today  = MCO.todayMT();
  const thresh = dateStr < today ? Infinity
               : dateStr > today ? -Infinity
               : slotMinutes(MCO.hhmmNowMT()) - SLOT_LAG_MINUTES;
  const want = slotsForDate(dateStr).map(t => ({ value: t, disabled: slotMinutes(t) > thresh }));
  const have = [...timeInput.options].map(o => ({ value: o.value, disabled: o.disabled }));
  if (JSON.stringify(want) === JSON.stringify(have)) return;
  const selected = timeInput.value;
  timeInput.replaceChildren(...want.map(({ value, disabled }) => {
    const o = document.createElement('option');
    o.value = value;
    o.disabled = disabled;
    o.textContent = slotLabel(value);   // disabled styling alone marks a pending slot
    return o;
  }));
  timeInput.value = selected;   // "" if it's gone — resolveTimeForDate always follows
}

// Which of the menu's enabled entries to show, given what was wanted: the
// wanted slot if it's there; else the next later one that day; else the last.
// `null` (a bare ?date=) means the day's first slot. `reason` tells a wanted
// slot that was never scheduled that day ('unscheduled') from one that is
// listed but not cleared yet ('pending').
function resolveTimeForDate(wantedTime) {
  const opts    = [...timeInput.options];
  const enabled = opts.filter(o => !o.disabled).map(o => o.value);
  if (!enabled.length) {                 // unreachable once the date is clamped to computeMaxTimestep().date
    const ts = computeMaxTimestep();
    return { time: ts.time, moved: wantedTime !== ts.time, reason: 'pending' };
  }
  if (wantedTime == null || enabled.includes(wantedTime)) {
    return { time: wantedTime ?? enabled[0], moved: false, reason: null };
  }
  const later = enabled.find(t => t > wantedTime);   // zero-padded HH:MM:SS compare
  return {
    time: later ?? enabled[enabled.length - 1],
    moved: true,
    reason: opts.some(o => o.value === wantedTime) ? 'pending' : 'unscheduled',
  };
}
function rollMessage({ from, to, reason }) {
  return reason === 'pending'
    ? `${slotLabel(from)} isn't available yet — showing ${slotLabel(to)}.`
    : `Time adjusted to ${slotLabel(to)} — ${slotLabel(from)} isn't scheduled on ${MCO.formatDateStr(dateInput.value)}.`;
}
// Announce a batched time move (hold-to-repeat collects them; see stepDate).
function flushRoll() {
  if (!_pendingRoll) return;
  if (!_exportParam) MCO.showToast(rollMessage(_pendingRoll), 5000);
  _pendingRoll = null;
}

// Evenly-spaced sample, so a probe can't land entirely in one corner of the
// state (the mirror publishes per station, and outages can be regional).
function pickSpread(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function getSelectedDateTime() { return `${dateInput.value}T${timeInput.value}`; }

// Photo filenames stamp the capture instant in UTC, but the capture schedule —
// and every control in this app — is a Montana wall clock, so the stamp runs
// −6h in MDT and −7h in MST and the conversion has to be DST-aware. Verified
// against the store in both seasons: 09:00 MT is …15:00:00Z after the March
// change and …16:00:00Z before it.
const _mtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: MCO.TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
// How far MT sits from UTC at the instant `t`, in ms.
function mtOffsetMs(t) {
  const p = {};
  for (const { type, value } of _mtParts.formatToParts(new Date(t))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
}
// MT wall clock ("2026-09-08T09:00:00") → the UTC instant it names, in epoch ms.
// Two passes, because the first offset is read at the wrong instant whenever the
// naive guess straddles a DST transition; re-reading at the corrected instant
// settles it. No ambiguous-hour handling: the offered slots sit hours clear of
// the 02:00 MT change, and slotsForDate drops any hourly-period candidate that
// doesn't round-trip through mtWallClock. Memoised one-deep: a mosaic refresh
// or a gallery step asks about the same slot hundreds of times in a row.
let _lastInstant = { dtStr: null, ms: 0 };
function mtInstantMs(dtStr) {
  if (dtStr === _lastInstant.dtStr) return _lastInstant.ms;
  const [date, time] = dtStr.split('T');
  const [Y, M, D]    = date.split('-').map(Number);
  const [h, m, s]    = time.split(':').map(Number);
  const wall = Date.UTC(Y, M - 1, D, h, m, s || 0);
  const o1   = mtOffsetMs(wall);
  const t1   = wall - o1;
  const t    = mtOffsetMs(t1) === o1 ? t1 : wall - mtOffsetMs(t1);
  _lastInstant = { dtStr, ms: t };
  return t;
}
// The inverse: epoch ms → the MT wall clock that names it, "YYYY-MM-DDTHH:MM:SS".
function mtWallClock(t) {
  const p = {};
  for (const { type, value } of _mtParts.formatToParts(new Date(t))) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${MCO.pad2(+p.hour % 24)}:${p.minute}:${p.second}`;
}
// …and as the basic-format ISO 8601 stamp the photo filenames carry:
// "2026-09-08T09:00:00" → "20260908T150000Z".
function utcStamp(dtStr) {
  return new Date(mtInstantMs(dtStr)).toISOString().replace(/[-:]/g, '').replace('.000', '');
}

// Key layout: <station>_<TOKEN>_<slot as UTC>.webp under photos/webp/{thumb,large}/.
// Kept hardcoded rather than templated from schedule.json's `patterns` — the
// verify harness classifies missing-photo 404s by this URL shape — so the two
// must be kept in agreement by hand if the store ever moves.
// 320×180 — the mosaic crop source and the gallery grid.
function thumbPhotoUrl(station, dtStr, direction) {
  return `${CLOUDFRONT_BASE}/photos/webp/thumb/${station}/${station}_${direction}_${utcStamp(dtStr)}.webp`;
}
// 1920×1080 — the lightbox only. Replaces the raw JPG the old layout served here.
function largePhotoUrl(station, dtStr, direction) {
  return `${CLOUDFRONT_BASE}/photos/webp/large/${station}/${station}_${direction}_${utcStamp(dtStr)}.webp`;
}
// The selected slot is a Mountain-Time wall clock, so it's formatted from its
// parts rather than parsed as an instant — but it still carries the MT label.
function formatDisplayTimestamp(dtStr) {
  const [date, time] = dtStr.split("T");
  return `${date} ${slotLabel(time)} MT`;
}
// True when `station` was scheduled to shoot `dir` at the Mountain wall-clock slot
// dtStr ("YYYY-MM-DDTHH:MM:SS") AND the store's coverage had begun. Period-aware:
// the slot's instant picks the schedule period, so a camera moved mid-day shows
// its old views at 09:00 and its new ones at 15:00, and history renders what
// was actually shot rather than the current plan.
function isValidForSlot(station, dir, dtStr) {
  const s = _schedule[station];
  if (!s || dtStr.slice(0, 10) < s.firstDate) return false;
  const hhmm = dtStr.slice(11, 16);
  const t = mtInstantMs(dtStr);
  return s.periods.some(p => t >= p.from && t < p.until && p.views.get(dir)?.has(hhmm));
}

// ── Date / direction initial values (URL > localStorage > default) ────────────
// Provisional, against the placeholder options: loadData() settles the slot for
// real once the schedule is parsed (and if the load fails, the controls at
// least read sensibly). A ?time= is the sticky preference from the start; a
// bare ?date= leaves it null so that day's first slot wins.
const _maxTs = computeMaxTimestep();
dateInput.value = urlParams.get("date") || _maxTs.date;
const _timeParam = normaliseTimeParam(urlParams.get("time"));
_wantedTime      = _timeParam;
timeInput.value  = _timeParam ?? _maxTs.time;
// Provisional: the real check is against the schedule's token set in loadData(),
// which runs before anything renders — so a token DIR_ORDER has never heard of
// isn't silently reset to DEFAULT_DIR here.
const _dirParam = (getLower("dir") || "").toUpperCase();
currentDir = /^[A-Z0-9]+$/.test(_dirParam) ? _dirParam : DEFAULT_DIR;
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
MCO.initThemeToggle({
  button: document.getElementById('btn-theme'),
  iconSun: document.getElementById('icon-sun'),
  iconMoon: document.getElementById('icon-moon'),
  onChange: () => {
    // setStyle() wipes our sources/layers — re-add them once the new basemap loads.
    // Before the library has arrived there is no map yet; initMap reads the
    // theme when it builds it.
    if (!map) { updateUrl(); return; }
    map.setStyle(MCO.map.cartoStyleUrl());
    map.once('style.load', () => { addCustomLayers(); });
    updateUrl();
  },
});

// Walk back from the computed latest slot to the newest one that actually has
// photos, so the app never lands on a blank mosaic just because the mirror job
// hasn't published the current slot yet. Runs BEFORE the layers are added, so
// the mosaic paints once at the right slot instead of flashing empty. Probed
// crops land in _cropCache, so the render reuses them rather than refetching.
async function resolveInitialTimestep() {
  if (_slotPinnedByUrl || !_activeFeatures.length) return;
  const startDate = dateInput.value, startTime = timeInput.value;
  let date = startDate, time = startTime;
  let best = null;   // { date, time, hits } — newest wins ties

  for (let step = 0; step <= SLOT_FALLBACK_MAX; step++) {
    const dt = `${date}T${time}`;
    // Probe the direction this slot would actually show (see syncDirections).
    const dir   = resolveDir(dirsForSlot(dt));
    const valid = _activeFeatures.filter(f => isValidForSlot(f.station, dir, dt));
    if (valid.length) {
      const sample = pickSpread(valid, SLOT_PROBE_SAMPLE);
      const crops = await Promise.all(
        sample.map(f => loadCrop(thumbPhotoUrl(f.station, dt, dir))));
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
    const prev = previousSlot(date, time);
    if (!prev || (dateInput.min && prev.date < dateInput.min)) break;
    date = prev.date; time = prev.time;
  }

  // Nothing anywhere in range: keep the computed latest slot so the controls
  // still read "now", and let the empty state (and the sr-table's "No photo"
  // rows) speak for themselves.
  if (!best || !best.hits) return;
  if (best.date === startDate && best.time === startTime) return;

  dateInput.value = best.date;
  syncTimeOptions(best.date);
  timeInput.value = best.time;
  _wantedTime     = best.time;
  if (!_exportParam) {
    MCO.showToast(
      `Showing photos from ${formatDisplayTimestamp(`${best.date}T${best.time}`)} — the most recent available.`,
      5000);
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
    if (urlParams.has('lng')) openModalByStation(_initStation);
    else                      flyToAndOpen(_initStation);
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
  let grid, allStations, statusRows, sched;
  try {
    [grid, allStations, statusRows, sched] = await Promise.all([
      MCO.fetchJSON(GRID_URL),
      MCO.fetchJSON(STATIONS_META),
      MCO.fetchJSON(STATUS_META),
      MCO.fetchJSON(SCHEDULE_URL),
    ]);
    if (!sched || sched.schema !== SCHEDULE_SCHEMA || typeof sched.stations !== 'object') {
      throw new Error(`schedule.json: unexpected schema ${sched && sched.schema}`);
    }
  } catch (err) {
    console.error(err);
    MCO.showToast("Failed to load map data. Please refresh.", 6000);
    return;
  }

  // Parse the schedule once. `from`/`until` carry explicit offsets, so Date.parse
  // is exact and DST-agnostic; every slot a view shoots is kept (which ones the
  // menu offers is decided per date by slotsForDate), and a view with none is
  // dropped. Deliberately unused: `patterns` (see thumbPhotoUrl), `zone`
  // (MCO.TZ), `snap_max_seconds`.
  const tokens = new Set(), candidates = new Set();
  for (const [id, st] of Object.entries(sched.stations)) {
    const periods = (st.periods || []).map(p => {
      const views = new Map(), slots = new Set();
      for (const [token, v] of Object.entries(p.views || {})) {
        const vs = new Set(v.slots_local || []);
        if (!vs.size) continue;
        views.set(token, vs);
        for (const s of vs) { slots.add(s); candidates.add(s); }
        tokens.add(token);
        _viewNames[token] ??= v.view;
      }
      return { from: Date.parse(p.from), until: p.until == null ? Infinity : Date.parse(p.until), views, slots };
    }).filter(p => p.views.size).sort((a, b) => a.from - b.from);
    if (!periods.length || !st.first_month) continue;
    _schedule[id] = { firstDate: `${st.first_month}-01`, periods };
  }
  _slotCandidates = [...candidates].sort();
  _slotsByDate.clear();

  // Assemble the live station set: active HydroMet stations that have photos,
  // each placed at its assigned grid cell (ace_grid) or the cell containing it.
  const cellByCode      = new Map(grid.features.map(f => [normCell(f.properties.cell), f]));
  const statusByStation = new Map(statusRows.map(r => [r.station, r]));
  const feats = [], cellFeats = [];
  let idc = 0;

  allStations.filter(s => s.sub_network === "HydroMet").forEach(s => {
    const st = statusByStation.get(s.station);
    if (!st || st.status !== "active") return;
    if (!(s.station in _schedule))     return;
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

  // Constrain the date picker, then settle the landing slot for real now that
  // the schedule is known: no URL slot → the newest cleared slot (the probe in
  // resolveInitialTimestep may still walk it back); ?date alone → that day's
  // first slot; a ?time that day never shot → rolled forward, and said so.
  dateInput.min = PHOTOS_MIN_DATE;
  if (!_slotPinnedByUrl) {
    const ts = computeMaxTimestep();
    dateInput.value = ts.date;
    _wantedTime     = ts.time;
  }
  _pendingRoll = clampDate() || _pendingRoll;
  flushRoll();

  // Build direction UI from every token the schedule has ever used, DIR_ORDER
  // first so the segments keep their familiar order.

  _allDirs = [
    ...DIR_ORDER.filter(d => tokens.has(d)),
    ...[...tokens].filter(d => !DIR_ORDER.includes(d)).sort(),
  ];
  if (!_allDirs.includes(currentDir)) currentDir = _allDirs.includes(DEFAULT_DIR) ? DEFAULT_DIR : _allDirs[0];
  _wantedDir = currentDir;
  syncDirections();
}

// The directions the controls offer at slot `dtStr`: those at least one placed
// station was scheduled to shoot then (period-aware, via isValidForSlot). So the
// retired sky cameras' NS/SS appear only for slots some camera still shot them.
// Never empty — a slot nobody shot keeps the full list rather than no controls.
function dirsForSlot(dtStr) {
  const dirs = _allDirs.filter(d => _activeFeatures.some(f => isValidForSlot(f.station, d, dtStr)));
  return dirs.length ? dirs : _allDirs.slice();
}
// Which offered direction to show: the wanted one if offered, else N, else the first.
function resolveDir(dirs) {
  return dirs.includes(_wantedDir) ? _wantedDir : dirs.includes(DEFAULT_DIR) ? DEFAULT_DIR : dirs[0];
}
// Fit the direction controls to the selected slot, moving off a direction the
// slot doesn't offer (and back onto the wanted one when it returns). Called by
// every render, so each date/time change lands here. Leaving the wanted
// direction is toasted; returning to it is not.
function syncDirections() {
  const dirs = dirsForSlot(getSelectedDateTime());
  const next = resolveDir(dirs);
  const from = currentDir;
  currentDir = next;
  if (dirs.join() !== _shownDirs.join()) {
    _shownDirs = dirs;
    buildDirectionControls(dirs);
  } else if (next !== from) {
    reflectDirection();
  }
  if (next === from) return;
  if (from === _wantedDir && !_exportParam) {
    MCO.showToast(`No ${dirLabel(from)} photos at this time — showing ${dirLabel(next)}.`, 5000);
  }
  if (_mapReady) updateUrl();   // before that, map.on('load') publishes the first URL
}

// ── Direction controls (segmented buttons + narrow-screen <select>) ───────────
function buildDirectionControls(allDirs) {
  const dirBtnsEl   = document.getElementById("dir-btns");
  const dirSelectEl = document.getElementById("dir-select");
  dirBtnsEl.innerHTML = "";
  dirSelectEl.innerHTML = "";
  allDirs.forEach(dir => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-btn seg-btn";
    btn.dataset.dir = dir;
    btn.textContent = dir === "SNOW" ? "Snow" : dir;
    // The visible glyph is an abbreviation — name the button properly for AT.
    btn.setAttribute("aria-label", dirLabel(dir));
    btn.setAttribute("aria-pressed", dir === currentDir ? "true" : "false");
    dirBtnsEl.append(btn);

    const opt = document.createElement("option");
    opt.value = dir;
    opt.textContent = dirLabel(dir);
    opt.selected = dir === currentDir;
    dirSelectEl.append(opt);
  });
  updateRail();
}
function reflectDirection() {
  document.querySelectorAll("#dir-btns .seg-btn").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.dir === currentDir ? "true" : "false"));
  const ds = document.getElementById("dir-select");
  if (ds) ds.value = currentDir;
  updateRail();
}
function setDirection(dir) {
  currentDir = _wantedDir = dir;
  reflectDirection();
  updateUrl();
  refreshMapImages();
}
document.getElementById("dir-btns").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn) setDirection(btn.dataset.dir);
});
document.getElementById("dir-select").addEventListener("change", (e) => setDirection(e.target.value));
// Rail: one button steps through the directions the selected slot offers.
document.getElementById("btn-rail-dir").addEventListener("click", () => {
  const dirs = dirsForSlot(getSelectedDateTime());
  setDirection(dirs[(dirs.indexOf(currentDir) + 1) % dirs.length]);
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
// setStyle() (theme toggle), which wipes them. Stack, bottom → top:
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
                 paint: { 'line-color': cssVar('--border', '#3a4558'), 'line-width': 0.8, 'line-opacity': 0.9 } });
  // Transparent fill on top for hit-testing + hover highlight (feature-state).
  addLayerOnce({ id: 'cells-fill', type: 'fill', source: 'cells',
                 paint: { 'fill-color': cssVar('--selection-ring', '#5aaee8'),
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
  if (!map || !map.getLayer('cells-fill')) return;
  syncDirections();
  const dt = getSelectedDateTime();
  const token = ++_refreshToken;

  const valid = _activeFeatures.filter(f => isValidForSlot(f.station, currentDir, dt)).map(f => f.station);
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
    const url = thumbPhotoUrl(f.station, dt, currentDir);
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
    { key: 'dir', label: 'Camera direction', value: () => dirLabel(currentDir) },
    { key: 'photo', label: 'Photo (Mountain Time)', value: (f) => {
        const has = _photoState.get(f.station);   // null while its load is in flight
        return has === null ? 'Loading…' : has ? formatDisplayTimestamp(getSelectedDateTime()) : 'No photo';
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
  const total = _photoState.size;
  const withPhoto = [..._photoState.values()].filter(Boolean).length;
  const msg = total === 0
    ? `No station photos available for ${formatDisplayTimestamp(getSelectedDateTime())}.`
    : `${withPhoto} of ${total} stations showing ${dirLabel(currentDir)} photos ` +
      `for ${formatDisplayTimestamp(getSelectedDateTime())}.`;
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
// App-local by design: the kit has deliberately not absorbed the search
// combobox yet (MIGRATING.md § kit-deferred). The collapse-to-icon behavior
// below is likewise app-local — a kit candidate if a second property wants it
// (admission rule: >= 2 MCO properties).
let _activeSearchIndex = -1;

// Collapse-to-icon + overlay is the kit's component as of v0.5.0, collapsing at
// the compact edge (≤640px) since v0.6.0. (This app
// prototyped it; mesonet-status became the second consumer, meeting the kit's
// admission rule). The kit owns the mechanics — open/close, focus in and out,
// outside-dismiss, and clearing state when the viewport widens. This app keeps
// what only it knows: Esc precedence against its own suggestions dropdown, the
// `/` shortcut, and which control the gallery should treat as its opener.
const btnSearchToggle = document.getElementById('btn-search-toggle');
const searchCollapse = MCO.initSearchCollapse({
  wrap: document.getElementById('search-wrap'),
  toggle: btnSearchToggle,
  input: searchInput,
  onClose: hideSearchDropdown,
});

function matchScore(s, q) {
  const n = s.name.toLowerCase(), id = s.station.toLowerCase();
  if (n === q || id === q) return 0;
  if (n.startsWith(q))     return 1;
  if (id.startsWith(q))    return 2;
  if (n.includes(q))       return 3;
  if (id.includes(q))      return 4;
  return Infinity;
}
function showSearchDropdown(rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (!q) { hideSearchDropdown(); return; }
  const matches = _stationsList
    .map(s => ({ s, score: matchScore(s, q) }))
    .filter(m => m.score < Infinity)
    .sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name))
    .slice(0, SEARCH_MAX_RESULTS)
    .map(m => m.s);
  searchDropdown.innerHTML = '';
  if (matches.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.setAttribute('aria-disabled', 'true');
    li.textContent = `No stations match "${rawQuery.trim()}"`;
    searchDropdown.appendChild(li);
    searchDropdown.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
    _activeSearchIndex = -1;
    return;
  }
  for (const s of matches) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.stationId = s.station;
    li.id = `search-opt-${s.station}`;
    const name = document.createElement('span');
    name.className = 'search-name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'search-meta';
    meta.textContent = s.station;
    li.append(name, meta);
    li.addEventListener('mousedown', (e) => { e.preventDefault(); selectStation(s.station); });
    searchDropdown.appendChild(li);
  }
  searchDropdown.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  _activeSearchIndex = -1;
  searchInput.removeAttribute('aria-activedescendant');
}
function hideSearchDropdown() {
  searchDropdown.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  _activeSearchIndex = -1;
  searchInput.removeAttribute('aria-activedescendant');
}
function selectStation(stationId) {
  hideSearchDropdown();
  searchInput.value = '';
  // Whichever control the user came from becomes the gallery's opener, so
  // closing the dialog returns them there. In collapsed mode that's the toggle
  // — the field itself is display:none once the overlay closes, and focusing a
  // hidden element silently drops focus to <body>.
  // In rail mode the field is in the drawer, which closes here — so the menu
  // button, which stays on screen, takes focus back when the gallery closes.
  const opener = RAIL_MQ.matches ? btnMenu
               : searchCollapse.isCollapsed() ? btnSearchToggle : searchInput;
  searchCollapse.close({ restoreFocus: false });
  closeDrawer({ restoreFocus: false });
  flyToAndOpen(stationId, opener);
}
function setActiveSearchItem(idx) {
  const items = searchDropdown.querySelectorAll('li');
  if (!items.length) return;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  _activeSearchIndex = idx;
  items.forEach((it, i) => it.classList.toggle('active', i === idx));
  items[idx].scrollIntoView({ block: 'nearest' });
  searchInput.setAttribute('aria-activedescendant', items[idx].id);
}
searchInput.addEventListener('input', () => showSearchDropdown(searchInput.value));
searchInput.addEventListener('focus', () => { if (searchInput.value) showSearchDropdown(searchInput.value); });
searchInput.addEventListener('blur',  () => setTimeout(hideSearchDropdown, 120));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Esc closes the dropdown first, then the overlay — one step at a time.
    if (!searchDropdown.hidden) { e.preventDefault(); searchInput.value = ''; hideSearchDropdown(); return; }
    if (searchCollapse.isOpen()) { e.preventDefault(); searchCollapse.close(); return; }
    searchInput.value = '';
    return;
  }
  if (searchDropdown.hidden) return;
  const items = searchDropdown.querySelectorAll('li');
  if (!items.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSearchItem(_activeSearchIndex + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSearchItem(_activeSearchIndex - 1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const idx = _activeSearchIndex >= 0 ? _activeSearchIndex : 0;
    if (items[idx].dataset.stationId) selectStation(items[idx].dataset.stationId);
  }
});

function flyToAndOpen(stationId, opener) {
  const f = _featureByStation.get(stationId);
  if (!f) { MCO.showToast('Station not found'); return; }
  map.flyTo({ center: f.centroid, zoom: SEARCH_FLY_ZOOM, speed: SEARCH_FLY_SPEED,
              animate: !MCO.reducedMotion() });
  map.once('moveend', () => openModalByStation(stationId, opener));
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
function galleryStations(dtStr) {
  return _stationOrder.filter(id => _allDirs.some(d => isValidForSlot(id, d, dtStr)));
}
function lightboxStations(dir, dtStr) {
  return _stationOrder.filter(id => isValidForSlot(id, dir, dtStr));
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
function renderGallery(stationId) {
  const f = _featureByStation.get(stationId);
  if (!f) return 0;
  const dtStr = getSelectedDateTime();

  document.getElementById("modal-station-name").textContent = f.name;
  document.getElementById("modal-timestamp").textContent    = formatDisplayTimestamp(dtStr);

  const dashWrap = document.getElementById("modal-dash-link");
  dashWrap.innerHTML = "";
  const dashLink = document.createElement("a");
  dashLink.href = DASH_URL(stationId);
  dashLink.target = "_blank";
  dashLink.rel = "noopener";
  dashLink.textContent = `Open ${f.name} dashboard →`;
  dashWrap.append(dashLink);

  photoGrid.innerHTML = "";
  const validDirs = _allDirs.filter(dir => isValidForSlot(stationId, dir, dtStr));
  const showEmpty = () => {
    const msg = document.createElement("p");
    msg.className = "photo-empty";
    msg.textContent = "No photos available for this station at the selected time.";
    photoGrid.append(msg);
  };
  if (validDirs.length === 0) showEmpty();
  validDirs.forEach(dir => {
    const dirName = dirLabel(dir);
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
    img.src = thumbPhotoUrl(stationId, dtStr, dir);
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
  updateUrl();
  return validDirs.length;
}
function openModalByStation(stationId, opener) {
  const f = _featureByStation.get(stationId);
  if (!f) return;
  const n = renderGallery(stationId);
  _galleryOpener = opener || document.activeElement;
  modal.showModal();
  document.getElementById("modal-close").focus();
  MCO.announce(n
    ? `Photo gallery for ${f.name} opened, ${n} photos.`
    : `Photo gallery for ${f.name} opened, no photos for this date.`);
}
// Focus stays where it is: the arrows live in the header, which isn't rebuilt.
function stepGalleryStation(delta) {
  const r = stepIn(galleryStations(getSelectedDateTime()), _selectedStation, delta);
  if (!r) return;
  const n = renderGallery(r.id);
  MCO.announce(`Photo gallery for ${_featureByStation.get(r.id).name}, ${n} photos.${stepNote(r)}`);
}
// One close path for the button, Esc and backdrop click alike.
// The map deliberately never moves for a station step, not even on close —
// the user is browsing photos, not the map.
modal.addEventListener("close", () => {
  _selectedStation = null;
  updateUrl();
  restoreFocus(_galleryOpener);
  _galleryOpener = null;
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
  const caption = `${f.name} · ${formatDisplayTimestamp(getSelectedDateTime())} · ${dirLabel(dir)}`;
  lightboxImg.src = largePhotoUrl(stationId, getSelectedDateTime(), dir);
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
  const r = stepIn(lightboxStations(_lightboxDir, getSelectedDateTime()), _lightboxStation, delta);
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

// ── Date / time controls ──────────────────────────────────────────────────────
dateInput.addEventListener("change", () => {
  _pendingRoll = clampDate() || _pendingRoll;
  flushRoll();
  updateUrl();
  refreshMapImages();
});
// A time the user picks is the sticky preference date changes resolve from.
// No clamp here: disabled options can't be chosen, and rebuilding the menu from
// inside its own change event would unsettle native pickers.
timeInput.addEventListener("change", () => { _wantedTime = timeInput.value; updateUrl(); refreshMapImages(); });
// A tab left open past a slot's lag: refresh the disabled state as the menu is
// about to open, so 3:00 PM is selectable once it has cleared.
for (const ev of ["focus", "pointerdown"]) {
  timeInput.addEventListener(ev, () => { if (_slotCandidates.length) syncTimeOptions(dateInput.value); });
}

// Every date change funnels through here: clamp the date to [min, max], rebuild
// the Time menu for it, and settle the time from the sticky preference. Returns
// a { from, to, reason } roll when the shown time had to move off what was
// wanted — the caller announces it, at once or once at the end of a
// hold-to-repeat run — else null.
function clampDate(wanted = _wantedTime) {
  if (dateInput.min && dateInput.value < dateInput.min) {
    dateInput.value = dateInput.min;
    if (!_exportParam) MCO.showToast(`Photos begin ${dateInput.min} — date adjusted.`);
  }
  const maxTs = computeMaxTimestep();
  if (dateInput.value > maxTs.date) {
    dateInput.value = maxTs.date;
    if (!_exportParam) MCO.showToast(`No photos yet for that date — showing ${MCO.formatDateStr(maxTs.date)}.`);
  }
  syncTimeOptions(dateInput.value);
  const before = timeInput.value;
  const { time, moved, reason } = resolveTimeForDate(wanted);
  timeInput.value = time;
  // Only a visible change is worth a toast: stepping through a 9/15 stretch
  // while wanting noon re-resolves to 3 PM every day, but says so once.
  return moved && time !== before ? { from: wanted, to: time, reason } : null;
}
function stepDate(delta) {
  const newDate = shiftDate(dateInput.value, delta);
  if (delta < 0 && dateInput.min && newDate < dateInput.min) { MCO.showToast("Already at the earliest available date."); return false; }
  if (delta > 0 && newDate > computeMaxTimestep().date)       { MCO.showToast("Already at the most recent available date."); return false; }
  dateInput.value = newDate;
  _pendingRoll = clampDate() || _pendingRoll;
  updateUrl();
  return true;
}
let _holdTimer = null, _holdInterval = null;
function startHold(delta) {
  if (!stepDate(delta)) return;
  _holdTimer = setTimeout(() => {
    _holdInterval = setInterval(() => { if (!stepDate(delta)) stopHold(); }, 120);
  }, 450);
}
function stopHold() {
  if (_holdTimer === null && _holdInterval === null) return;
  clearTimeout(_holdTimer); clearInterval(_holdInterval);
  _holdTimer = null; _holdInterval = null;
  flushRoll();
  refreshMapImages();
}
// The navbar stepper and the landscape rail's day buttons share one wiring.
function wireDateStep(btn, delta) {
  btn.addEventListener("mousedown",  (e) => { e.preventDefault(); startHold(delta); });
  btn.addEventListener("touchstart", (e) => { e.preventDefault(); startHold(delta); }, { passive: false });
  btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (stepDate(delta)) { flushRoll(); refreshMapImages(); } } });
}
wireDateStep(document.getElementById("btn-date-prev"), -1);
wireDateStep(document.getElementById("btn-date-next"), +1);
wireDateStep(document.getElementById("btn-rail-prev"), -1);
wireDateStep(document.getElementById("btn-rail-next"), +1);
document.addEventListener("mouseup", stopHold);
document.addEventListener("touchend", stopHold);
document.addEventListener("touchcancel", stopHold);

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

// ── Landscape rail + drawer (app-local prototype) ─────────────────────────────
// On short landscape screens the navbar is a left rail (CSS "RAIL MODE") and
// the full control set lives in a slide-out drawer. Disclosure semantics: the
// menu button carries aria-expanded; opening moves focus in and makes the map
// inert (it sits under a scrim); Esc, the scrim, or the button close it and
// focus returns to the button. KEEP IN SYNC with the CSS media query.
const RAIL_MQ    = window.matchMedia('(max-height: 560px) and (orientation: landscape)');
const navDrawer  = document.getElementById('nav-drawer');
const btnMenu    = document.getElementById('btn-menu');
const railScrim  = document.getElementById('rail-scrim');

function isDrawerOpen() { return navDrawer.classList.contains('is-open'); }
function openDrawer(focusEl) {
  navDrawer.classList.add('is-open');
  btnMenu.setAttribute('aria-expanded', 'true');
  railScrim.hidden = false;
  mainEl.inert = true;
  // display flips synchronously with the class, so the target is focusable now.
  (focusEl || navDrawer.querySelector('input, select, button')).focus();
}
function closeDrawer({ restoreFocus = true } = {}) {
  if (!isDrawerOpen()) return;
  navDrawer.classList.remove('is-open');
  btnMenu.setAttribute('aria-expanded', 'false');
  railScrim.hidden = true;
  mainEl.inert = false;
  if (restoreFocus) btnMenu.focus();
}
btnMenu.addEventListener('click', () => { if (isDrawerOpen()) closeDrawer(); else openDrawer(); });
railScrim.addEventListener('click', () => closeDrawer());
navDrawer.addEventListener('keydown', (e) => {
  // The search field consumes its own Esc first (dropdown, then overlay).
  if (e.key === 'Escape' && isDrawerOpen() && !e.defaultPrevented) { e.preventDefault(); closeDrawer(); }
});
// Leaving rail mode (rotation) turns the drawer back into the navbar row.
RAIL_MQ.addEventListener('change', () => closeDrawer({ restoreFocus: false }));
// Export and the dialogs need the map visible, so they close the drawer first.
for (const id of ['btn-export', 'btn-info']) {
  document.getElementById(id).addEventListener('click', () => closeDrawer({ restoreFocus: false }));
}

// Date/time/direction at a glance, since the drawer is usually closed.
// A function declaration with its own lookups: buildDirectionControls and
// updateUrl may call it before this part of the script has run.
function updateRail() {
  const railReadout = document.getElementById('rail-readout');
  const btnRailDir  = document.getElementById('btn-rail-dir');
  if (!dateInput.value || !timeInput.value) return;
  const d = new Date(`${dateInput.value}T12:00:00Z`);
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  railReadout.replaceChildren(...[md, String(d.getUTCFullYear()), slotLabel(timeInput.value)].map(t => {
    const span = document.createElement('span'); span.textContent = t; return span;
  }));
  btnRailDir.textContent = currentDir === 'SNOW' ? 'Snow' : currentDir;
  btnRailDir.setAttribute('aria-label', `Camera direction ${dirLabel(currentDir)}. Switch to next direction`);
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
    if (RAIL_MQ.matches) { openDrawer(searchInput); return; }
    // Below 460px the field is collapsed — open the overlay instead of focusing
    // a hidden input (which would silently do nothing).
    if (searchCollapse.isCollapsed()) { searchCollapse.open(); return; }
    searchInput.focus();
    searchInput.select();
  }
});

// ── URL sync & social meta ────────────────────────────────────────────────────
function updateSocialMeta() {
  const label = dirLabel(currentDir);
  const dateFmt = MCO.formatDateStr(dateInput.value);
  const timeFmt = `${slotLabel(timeInput.value)} MT`;
  const title = `Montana Mesonet Photos · ${dateFmt} · ${timeFmt} · ${label}`;
  const desc  = `Montana weather station photos for ${dateFmt} at ${timeFmt}, ${label} direction. ` +
                `A service of the Montana Climate Office.`;
  // The tab keeps the short site name ("Photos · MT Mesonet"), matching
  // the Explorer and UMRB Build maps; the dated title goes only to the social cards.
  document.title = "Photos · MT Mesonet";
  const previewUrl = new URL("preview.png", location.href).href;
  const set = (sel, content) => document.querySelector(sel)?.setAttribute("content", content);
  set('meta[property="og:title"]', title);
  set('meta[property="og:description"]', desc);
  set('meta[property="og:url"]', location.href);
  set('meta[property="og:image"]', previewUrl);
  set('meta[name="twitter:title"]', title);
  set('meta[name="twitter:description"]', desc);
  set('meta[name="twitter:image"]', previewUrl);
  set('meta[name="description"]', desc);
}
// Mirror state into the query string (HOUSE-STYLE §4). Defaults are elided —
// except date and time, which are always emitted on purpose: their "default"
// is the latest available timestep, so a link without them would show a
// different view tomorrow.
function updateUrl() {
  // Hour only while every slot is on the hour ("time=15"); "HH:MM" otherwise.
  const [h, m] = timeInput.value.split(":");
  const params = { date: dateInput.value, time: +m ? `${h}:${m}` : parseInt(h) };
  if (currentDir !== DEFAULT_DIR) params.dir = currentDir;
  if (showCounties) params.overlay = "counties";
  const theme = MCO.getTheme();
  if (theme) params.theme = theme;
  if (_mapReady && map) Object.assign(params, MCO.map.cameraParams(map));
  if (_selectedStation) params.station = _selectedStation;
  if (!kbdShortcuts) params.kbd = 'off';   // preserve the a11y opt-out across navigation
  MCO.replaceUrlState(params);
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
  if (!_activeFeatures.length) { MCO.showToast("Map not loaded yet."); return; }
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
    const dt = getSelectedDateTime();
    const valid = _activeFeatures.filter(f => isValidForSlot(f.station, currentDir, dt));
    const paints = MCO.map.overlayPaints();

    if (xm.getLayer('boundary_county')) xm.setLayoutProperty('boundary_county', 'visibility', 'none');

    // Montana boundary frame below the photos
    xm.addSource('state', { type: 'geojson', data: _stateFC || 'data/mt_state_simple.geojson' });
    xm.addLayer({ id: 'state-line', type: 'line', source: 'state',
                  layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: paints.stateLine });

    // Photos (awaited so the map is complete before capture)
    const crops = await Promise.all(valid.map(f => loadCrop(thumbPhotoUrl(f.station, dt, currentDir))));
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
                  paint: { 'line-color': cssVar('--border', '#3a4558'), 'line-width': 0.8, 'line-opacity': 0.9 } });

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
        href: url, download: `mesonet-photos-${dt.slice(0, 10)}-${currentDir}.png`,
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
// Branding card in the lower-left corner (over the basemap). Canvas can't read
// custom properties, so the tokens are resolved here (MIGRATING.md § gotchas).
async function drawBranding(ctx, W, H) {
  const cs = getComputedStyle(document.documentElement);
  const bgSurface = cs.getPropertyValue("--bg-surface").trim();
  const borderClr = cs.getPropertyValue("--border").trim();
  const accentLn  = cs.getPropertyValue("--accent-line").trim();
  const textMuted = cs.getPropertyValue("--text-muted").trim();
  const fontUi    = cs.getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";

  const BRAND_W = 280, BRAND_BOX_H = 80;
  const BX = 24, BY = H - 24 - BRAND_BOX_H, PAD = 12, LOGO = 52;
  const LX = BX + PAD, LY = BY + (BRAND_BOX_H - LOGO) / 2;

  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = bgSurface;
  ctx.beginPath(); roundRectPath(ctx, BX, BY, BRAND_W, BRAND_BOX_H, 10); ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = borderClr; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  const logoImg = await loadImg(LOGO_URL);
  if (logoImg) {
    ctx.save();
    ctx.beginPath(); roundRectPath(ctx, LX, LY, LOGO, LOGO, 8); ctx.clip();
    ctx.drawImage(logoImg, LX, LY, LOGO, LOGO);
    ctx.restore();
  }

  const TX = LX + LOGO + 10, TW = BX + BRAND_W - PAD - TX, midY = BY + BRAND_BOX_H / 2;
  ctx.textBaseline = "middle";
  ctx.fillStyle = accentLn;
  ctx.font = `700 13px ${fontUi}`;
  ctx.fillText("Mesonet Photo Explorer", TX, midY - 14, TW);
  ctx.fillStyle = textMuted;
  ctx.font = `400 11px ${fontUi}`;
  ctx.fillText("Montana Climate Office", TX, midY, TW);
  ctx.fillText(`${formatDisplayTimestamp(getSelectedDateTime())} · ${dirLabel(currentDir)}`, TX, midY + 13, TW);
  ctx.textAlign = "right";
  ctx.font = `italic 10px ${fontUi}`;
  ctx.fillText("climate.umt.edu", BX + BRAND_W - PAD, BY + BRAND_BOX_H - 7);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Last, so every control above is wired before the map exists.
MCO.map.loadMapLibre().then(initMap, onMapLibraryFail);
})();
