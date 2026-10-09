// verify.config.mjs — config for mco-web-style's tools/verify/ harness.
// Run from a kit checkout beside this repo, e.g.:
//   cd ../mco-web-style
//   node tools/verify/axe-matrix.mjs --config ../mesonet-photo-explorer/verify.config.mjs --root ../mesonet-photo-explorer
//   node tools/verify/keyboard.mjs   --config ../mesonet-photo-explorer/verify.config.mjs --root ../mesonet-photo-explorer
// (`root` below is resolved from the current directory, so pass --root when
// running from the kit.)

// Render evidence: the sr-table twin has one row per drawn grid cell, and every
// row has settled (no "Loading…") with at least one real photo stamp — i.e. the
// photos were fetched, cover-cropped and handed to the map, not just the grid.
// A FUNCTION, never a string: the page's CSP has no 'unsafe-eval'.
const mosaicReady = () => {
  const rows = [...document.querySelectorAll('#sr-photo-table tbody tr')];
  if (rows.length < 100) return false;
  const cells = rows.map((r) => (r.cells[2] && r.cells[2].textContent) || '');
  return !cells.some((c) => c === 'Loading…') && cells.some((c) => / MT$/.test(c));
};

export default {
  root: '.',
  page: 'docs/index.html',
  // Seed the intro as seen, so the first-visit dialog doesn't cover the map.
  storage: { 'mco-photos-seen-intro': '1' },
  settleMs: 2000,
  scenarios: [
    { name: 'default', query: '', ready: mosaicReady },
    // Pinned slot + a non-default direction + boundaries on (a deep link).
    { name: 'pinned', query: '?date=2026-09-01&time=15&dir=N&overlay=counties', ready: mosaicReady },
    // Station deep link: the gallery dialog opens over the map.
    { name: 'station', query: '?station=acebozem&lng=-110&lat=46&zoom=6', ready: () => document.getElementById('modal').open },
  ],
  exemptTargets: '',
  // A camera that was offline at the selected slot has no photo: the CDN
  // answers 404 and the browser logs a resource error. Expected, and identical
  // on production (CLAUDE.md § Verification). The console text carries no URL,
  // so the filter is by message; any other 404 shows up as a missing render
  // (the ready check) rather than here.
  allowProblems: ['status of 404', 'status of 403', 'Failed to load resource'],
  dialogOpener: '#btn-info',
  shortcuts: [{ key: '/', effect: () => document.activeElement && document.activeElement.id === 'search-input' }],
  probes: async ({ open, check }) => {
    // The social-preview contract (scripts/generate_preview.py): ?export=light&dir=W
    // clicks #btn-export after 4 s, which downloads a PNG.
    const { page, close } = await open('?export=light&dir=W', { ready: () => true, settleMs: 0 });
    let ok = false;
    try {
      const dl = await page.waitForEvent('download', { timeout: 60000 });
      ok = /\.png$/.test(dl.suggestedFilename());
    } catch { ok = false; }
    check('?export=light&dir=W downloads a PNG (social-preview contract)', ok);
    await close();
  },
};
