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
    // Station deep links (both run at 1440 and at 390-touch): with a camera
    // in the URL the sheet opens in place; a bare ?station= flies there first
    // (MCO.map.flyToAndOpen) and then opens it. Station ids from the live
    // station list (mesonet2 /api/stations, active HydroMet with a camera).
    { name: 'station', query: '?station=acebozem&lng=-110&lat=46&zoom=6',
      ready: () => { const s = document.getElementById('station-sheet'); return !!s && !s.hidden && s.dataset.state !== 'closed' && document.querySelectorAll('#photo-grid .photo-btn').length > 0; } },
    { name: 'station-fly', query: '?station=aceabsar',
      ready: () => { const s = document.getElementById('station-sheet'); return !!s && !s.hidden && s.dataset.state !== 'closed' && new URLSearchParams(location.search).get('station') === 'aceabsar'; } },
    // The phone nav drawer open (390): the ready step presses ☰ and waits for
    // the drawer. Above compact ☰ is hidden and the drawer is the bar itself,
    // so at 1440 this is the default view again.
    { name: 'drawer', query: '',
      ready: () => {
        const d = document.getElementById('nav-drawer'), b = document.getElementById('btn-menu');
        if (!document.documentElement.classList.contains('is-compact')) return document.querySelectorAll('#sr-photo-table tbody tr').length > 100;
        if (!d.classList.contains('is-open') && b && b.offsetParent) b.click();
        return d.classList.contains('is-open');
      } },
    // A chip toggle: the ready step presses the Boundaries chip once and waits
    // for it to read pressed with the overlay in the URL.
    { name: 'chip', query: '',
      ready: () => {
        const c = document.getElementById('btn-counties');
        if (document.querySelectorAll('#sr-photo-table tbody tr').length < 100) return false;
        if (c.getAttribute('aria-pressed') !== 'true' && !c.dataset.verifyPressed) { c.dataset.verifyPressed = '1'; c.click(); }
        return c.getAttribute('aria-pressed') === 'true' && /overlay=counties/.test(location.search);
      } },
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
    // Drill-down history (HOUSE-STYLE §4), at 1440 and 390-touch: opening a
    // station from search pushes an entry, so Back closes the sheet (focus
    // back on its opener: the field at 1440, the bar's search button at 390,
    // whose field closed with the drawer) and Forward reopens it; the
    // sheet's own × steps Back over the entry rather than leaving a second.
    const sheetState = (page) => page.evaluate(() => {
      const s = document.getElementById('station-sheet');
      return {
        open: !!s && !s.hidden && s.dataset.state !== 'closed', state: s && s.dataset.state,
        focus: document.activeElement && document.activeElement.id,
        station: new URLSearchParams(location.search).get('station'), len: history.length,
        lightbox: document.getElementById('lightbox').open,
      };
    });
    const sheetOpen = () => { const s = document.getElementById('station-sheet'); return !!s && !s.hidden && s.dataset.state !== 'closed'; };
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844, touch: true }]) {
      const { page, close } = await open('', { ready: mosaicReady, viewport: vp });
      await page.keyboard.press('/');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'search-input', null, { timeout: 5000 }).catch(() => {});
      await page.keyboard.type('Bozeman');
      await page.keyboard.press('Enter');
      await page.waitForFunction(sheetOpen, null, { timeout: 20000 }).catch(() => {});
      const opened = await sheetState(page);
      check(`[${vp.name}] search opens the sheet and pushes ?station=`, opened.open && opened.station === 'acebozem', JSON.stringify(opened));
      // A photo enlarges in the lightbox; Esc closes only the lightbox.
      await page.click('#photo-grid .photo-btn').catch(() => {}); await page.waitForTimeout(500);
      const lb = await sheetState(page);
      check(`[${vp.name}] a photo opens the lightbox over the sheet`, lb.lightbox && lb.open, JSON.stringify(lb));
      await page.keyboard.press('Escape'); await page.waitForTimeout(500);
      const lb2 = await sheetState(page);
      check(`[${vp.name}] Esc closes the lightbox, the sheet stays`, !lb2.lightbox && lb2.open, JSON.stringify(lb2));
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(800);
      const back = await sheetState(page);
      const wantFocus = vp.touch ? 'btn-search-toggle' : 'search-input';
      check(`[${vp.name}] Back closes the sheet, focus returns to its opener`, !back.open && !back.station && back.focus === wantFocus, JSON.stringify(back));
      await page.goForward({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(800);
      const fwd = await sheetState(page);
      check(`[${vp.name}] Forward reopens the sheet`, fwd.open && fwd.station === 'acebozem', JSON.stringify(fwd));
      await page.click('#station-sheet [data-close-sheet]'); await page.waitForTimeout(800);
      const x = await sheetState(page);
      check(`[${vp.name}] × closes without a second pop or a new entry`, !x.open && !x.station && x.len === fwd.len, JSON.stringify(x));
      await close();
    }
    // A bare ?station= deep link opens the sheet at both widths (the kit's
    // flyToAndOpen waits for the map to be idle at the station).
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844, touch: true }]) {
      const { page, close } = await open('?station=aceabsar', { ready: () => true, viewport: vp });
      const ok = await page.waitForFunction(sheetOpen, null, { timeout: 20000 }).then(() => true).catch(() => false);
      const r = await sheetState(page);
      check(`[${vp.name}] ?station=aceabsar opens the sheet (${vp.touch ? 'peek' : 'end-docked'})`, ok && r.station === 'aceabsar' && r.state === (vp.touch ? 'peek' : 'full'), JSON.stringify(r));
      await close();
    }
    // A ?station= with no camera is announced (a notice over the map), not
    // dropped silently. arskeogh: in the live station list, not in the camera
    // schedule.
    {
      const { page, close } = await open('?station=arskeogh', { ready: mosaicReady });
      const r = await page.evaluate(() => ({ notice: (document.querySelector('#map-container .mco-notice') || {}).textContent || '',
        sheet: !document.getElementById('station-sheet').hidden }));
      check('?station=arskeogh (no camera) shows a notice and no sheet', /has no camera/.test(r.notice) && !r.sheet, JSON.stringify(r));
      await close();
    }
    // The phone drawer (390): ☰ opens it with the page inert, Esc closes it
    // and focus returns to ☰. The Boundaries chip toggles its layers.
    {
      const { page, close } = await open('', { ready: mosaicReady, viewport: { name: '390', width: 390, height: 844, touch: true } });
      const navH = await page.evaluate(() => Math.round(document.getElementById('navbar').getBoundingClientRect().height));
      check('[390] the phone bar is one row ≤ 64px', navH <= 64, `navH=${navH}`);
      await page.click('#btn-menu'); await page.waitForTimeout(400);
      const d = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'),
        mainInert: document.getElementById('main').inert, expanded: document.getElementById('btn-menu').getAttribute('aria-expanded') }));
      check('[390] ☰ opens the drawer, the page inert', d.open && d.mainInert && d.expanded === 'true', JSON.stringify(d));
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      const e = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement && document.activeElement.id }));
      check('[390] Esc closes the drawer, focus back on ☰', !e.open && e.focus === 'btn-menu', JSON.stringify(e));
      await close();
    }
    {
      const { page, close } = await open('', { ready: mosaicReady });
      await page.click('#btn-counties'); await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({ pressed: document.getElementById('btn-counties').getAttribute('aria-pressed'),
        chip: document.getElementById('btn-counties').classList.contains('mco-chip'), url: location.search }));
      check('Boundaries is a chip; pressing it shows the overlay (?overlay=counties)', r.chip && r.pressed === 'true' && /overlay=counties/.test(r.url), JSON.stringify(r));
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
