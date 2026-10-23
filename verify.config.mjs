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
    { name: 'pinned', query: '?date=2026-09-01&time=15&dir=E&overlay=counties', ready: mosaicReady },
    // Staff view: history before the public range, instrument views offered.
    { name: 'internal', query: '?internal=1&date=2026-09-01&time=15', ready: mosaicReady },
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
    // Drill-down history (HOUSE-STYLE §4): opening the gallery pushes an entry,
    // so Back closes it (focus back on its opener) and Forward reopens it; the
    // dialog's own close steps Back over the entry rather than leaving a
    // second one.
    {
      const { page, close } = await open('', { ready: mosaicReady });
      const st = () => page.evaluate(() => ({
        open: document.getElementById('modal').open, focus: document.activeElement && document.activeElement.id,
        station: new URLSearchParams(location.search).get('station'), len: history.length,
      }));
      await page.keyboard.press('/');
      await page.keyboard.type('Bozeman');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('modal').open, null, { timeout: 20000 }).catch(() => {});
      const opened = await st();
      check('gallery open pushes ?station=', opened.open && opened.station === 'acebozem', JSON.stringify(opened));
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(600);
      const back = await st();
      check('Back closes the gallery, focus returns to its opener', !back.open && !back.station && back.focus === 'search-input', JSON.stringify(back));
      await page.goForward({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(800);
      const fwd = await st();
      check('Forward reopens the gallery', fwd.open && fwd.station === 'acebozem', JSON.stringify(fwd));
      await page.click('#modal-close'); await page.waitForTimeout(600);
      const x = await st();
      check('× closes without a second pop or a new entry', !x.open && !x.station && x.len === fwd.len, JSON.stringify(x));
      await close();
    }
    // Full public history (website D16, kit fullHistory): an old date stays put
    // and shows that date's North frame, pre-cutover N included.
    {
      const { page, close } = await open('?date=2026-09-01&time=15&dir=N', { ready: mosaicReady });
      const r = await page.evaluate(() => ({ date: document.getElementById('date-input').value,
        min: document.getElementById('date-input').min, url: new URLSearchParams(location.search).get('date'),
        dir: document.getElementById('dir-select').value,
        stamp: document.querySelector('#sr-photo-table tbody tr td:nth-child(3), #sr-photo-table tbody tr :nth-child(3)')?.textContent }));
      check('public ?date=2026-09-01&dir=N keeps the date and shows its North frames', r.date === '2026-09-01' && r.url === '2026-09-01' && r.dir === 'N' && r.min === '2022-09-22' && /Sep 1, 2026 3:00 PM MT/.test(r.stamp || ''), JSON.stringify(r));
      await close();
    }
    {
      const { page, close } = await open('?internal=1&date=2026-09-01&time=15', { ready: mosaicReady });
      const r = await page.evaluate(() => ({ date: document.getElementById('date-input').value,
        views: [...document.querySelectorAll('#dir-select option')].map((o) => o.value) }));
      check('?internal=1 keeps history and offers staff views', r.date === '2026-09-01' && r.views.some((v) => !['N', 'E', 'S', 'W'].includes(v)), JSON.stringify(r));
      await close();
    }
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
