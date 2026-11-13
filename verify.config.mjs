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
      // Kit 1.0.0: one state at every width ('full'; no peek on compact).
      check(`[${vp.name}] ?station=aceabsar opens the panel (state full)`, ok && r.station === 'aceabsar' && r.state === 'full', JSON.stringify(r));
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
    // The phone drawer (390): ☰ opens it with the page inert and focus on
    // the drawer itself, not the search field (kit 0.21.2, K1: the field
    // raised the phone keyboard over the drawer); the search button still
    // opens it on the field. Esc closes it and focus returns to ☰. The
    // Boundaries chip toggles its layers.
    {
      const { page, close } = await open('', { ready: mosaicReady, viewport: { name: '390', width: 390, height: 844, touch: true } });
      const navH = await page.evaluate(() => Math.round(document.getElementById('navbar').getBoundingClientRect().height));
      check('[390] the phone bar is one row ≤ 64px', navH <= 64, `navH=${navH}`);
      await page.click('#btn-menu'); await page.waitForTimeout(400);
      const d = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'),
        mainInert: document.getElementById('main').inert, expanded: document.getElementById('btn-menu').getAttribute('aria-expanded'),
        focus: document.activeElement && document.activeElement.id }));
      check('[390] ☰ opens the drawer, the page inert', d.open && d.mainInert && d.expanded === 'true', JSON.stringify(d));
      check('[390] ☰ focuses the drawer, not the search field', d.focus === 'nav-drawer', JSON.stringify(d));
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      await page.click('#btn-search-toggle'); await page.waitForTimeout(400);
      const f = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement && document.activeElement.id }));
      check('[390] the search button opens the drawer on the field', f.open && f.focus === 'search-input', JSON.stringify(f));
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      await page.click('#btn-menu'); await page.waitForTimeout(400);
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      const e = await page.evaluate(() => ({ open: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement && document.activeElement.id }));
      check('[390] Esc closes the drawer, focus back on ☰', !e.open && e.focus === 'btn-menu', JSON.stringify(e));
      await close();
    }
    // The time controls (kit 1.0.0 .mco-controlbar): the day stepper, its
    // date/time readout and the direction cycle. Docked at the bottom of a
    // portrait phone (320, 390) and of the bar folded above 640px (768), at
    // the foot of the right-edge rail in short landscape (750×340), absent
    // on the desktop bar (1440), which keeps the date input and the
    // Direction select (Kyle, 2026-11-12). Every button shown and hittable,
    // ≥ 44px on touch; the readout reads "Mon D, YYYY, H:MM AM" whole. The
    // top bar stays one row ≤ 64px with no horizontal overflow (scrollWidth
    // against the viewport width, not innerWidth, which a mobile layout
    // viewport stretches to fit), ☰ within 16px of the right edge. Four taps
    // of the cycle visit N/E/S/W and return, with the drawer's select, the
    // URL and the label following.
    for (const vp of [{ name: '320', width: 320, height: 568, touch: true }, { name: '390', width: 390, height: 844, touch: true },
      { name: '750x340', width: 750, height: 340, touch: true }, { name: '768', width: 768, height: 1024, touch: true },
      { name: '1440', width: 1440, height: 900 }]) {
      const { page, close } = await open('?date=2026-11-12&time=12', { ready: mosaicReady, viewport: vp });
      const g = await page.evaluate((w) => {
        const hit = (el) => { if (!el || !el.getClientRects().length) return null; const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { ok: !!top && (top === el || el.contains(top)), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), b: Math.round(r.bottom), r: Math.round(r.right) }; };
        const cb = document.getElementById('controlbar');
        const nav = document.getElementById('navbar').getBoundingClientRect(), menu = document.getElementById('btn-menu').getBoundingClientRect();
        const ro = document.getElementById('rail-readout');
        return { bar: hit(cb), prev: hit(document.getElementById('btn-rail-prev')), next: hit(document.getElementById('btn-rail-next')),
          dir: hit(document.getElementById('btn-rail-dir')), readout: ro.getClientRects().length ? ro.innerText.replace(/\s*\n\s*/g, ' ') : null,
          readoutOverflow: ro.scrollWidth > ro.clientWidth + 1,
          navH: Math.round(nav.height), sw: document.documentElement.scrollWidth, vw: w, vh: innerHeight,
          tabbar: getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h').trim(),
          menuGap: Math.round(w - menu.right), label: document.getElementById('btn-rail-dir').textContent, sel: document.getElementById('dir-select').value };
      }, vp.width);
      if (vp.name === '1440') { check('[1440] no control bar on the desktop bar (the date input and Direction select stay)', !g.bar && !g.dir, JSON.stringify(g)); await close(); continue; }
      const btnsOk = [g.prev, g.next, g.dir].every((b) => b && b.ok && b.w >= 44 && b.h >= 44);
      check(`[${vp.name}] control bar: ‹ › and direction shown, hittable, ≥ 44px`, btnsOk, JSON.stringify(g));
      check(`[${vp.name}] readout reads "Nov 12, 2026, 12:00 PM", not clipped`, g.readout === 'Nov 12, 2026, 12:00 PM' && !g.readoutOverflow, JSON.stringify({ readout: g.readout, overflow: g.readoutOverflow }));
      if (vp.name === '750x340') {
        check('[750x340] control bar at the foot of the right rail', g.bar && g.bar.r === g.vw && g.bar.b === g.vh && g.bar.w <= 64 && g.tabbar === '0px', JSON.stringify(g.bar));
      } else {
        check(`[${vp.name}] control bar docked at the bottom, --tabbar-h = its height`, g.bar && g.bar.b === g.vh && g.bar.x === 0 && g.tabbar === g.bar.h + 'px', JSON.stringify({ bar: g.bar, tabbar: g.tabbar }));
        check(`[${vp.name}] the top bar is one row ≤ 64px, no overflow, ☰ ≤ 16px from the edge`, g.navH <= 64 && g.sw === g.vw && g.menuGap >= 0 && g.menuGap <= 16, JSON.stringify(g));
      }
      if (vp.name === '320' || vp.name === '750x340') {
        const seen = [];
        for (let i = 0; i < 4; i++) {
          await page.click('#btn-rail-dir'); await page.waitForTimeout(400);
          seen.push(await page.evaluate(() => ({ label: document.getElementById('btn-rail-dir').textContent, sel: document.getElementById('dir-select').value,
            url: new URLSearchParams(location.search).get('dir') || 'N', aria: document.getElementById('btn-rail-dir').getAttribute('aria-label') })));
        }
        const ok = seen.every((s) => s.label === s.sel && s.url === s.sel && s.aria.startsWith('Camera direction '))
          && new Set(seen.map((s) => s.sel)).size === 4 && seen[3].sel === g.sel;
        check(`[${vp.name}] four taps cycle the directions and return, select + URL in sync`, ok, JSON.stringify(seen.map((s) => s.label + s.sel + s.url)));
      }
      await close();
    }
    // Kit 1.0.0, the right-edge rail (844×390 and 750×340, touch): the bar
    // is a column at the right edge, ☰ then search then the control bar;
    // every rail button ≥ 44px and hittable; ☰ opens the drawer beside it
    // (its right edge on the rail's left), focus on the drawer.
    for (const vp of [{ name: '844x390', width: 844, height: 390, touch: true }, { name: '750x340', width: 750, height: 340, touch: true }]) {
      const { page, close } = await open('', { ready: mosaicReady, viewport: vp });
      const r = await page.evaluate(() => {
        const nav = document.getElementById('navbar').getBoundingClientRect();
        const ids = ['btn-menu', 'btn-search-toggle', 'btn-rail-prev', 'btn-rail-next', 'btn-rail-dir'];
        const b = ids.map((id) => { const el = document.getElementById(id), q = el.getBoundingClientRect();
          const top = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
          return { id, y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height), hit: !!top && (top === el || el.contains(top)) }; });
        return { navX: Math.round(nav.x), navR: Math.round(nav.right), navW: Math.round(nav.width), vw: innerWidth, b };
      });
      const order = r.b.every((x, i) => i === 0 || x.y > r.b[i - 1].y);
      check(`[${vp.name}] rail at the right edge, ☰ · search · ‹ · › · direction top to bottom, each ≥ 44px and hittable`,
        r.navR === r.vw && r.navW <= 64 && order && r.b.every((x) => x.hit && x.w >= 44 && x.h >= 44), JSON.stringify(r));
      await page.click('#btn-menu'); await page.waitForTimeout(500);
      const d = await page.evaluate(() => { const dr = document.getElementById('nav-drawer'), q = dr.getBoundingClientRect(), nav = document.getElementById('navbar').getBoundingClientRect();
        return { open: dr.classList.contains('is-open'), right: Math.round(q.right), navX: Math.round(nav.x), focus: document.activeElement && document.activeElement.id }; });
      check(`[${vp.name}] ☰ opens the drawer beside the rail, focus on the drawer`, d.open && Math.abs(d.right - d.navX) <= 1 && d.focus === 'nav-drawer', JSON.stringify(d));
      await close();
    }
    // Kit 1.0.0, the station panel: on a phone (390×844, 320×568, 750×340)
    // one state, the viewport less the bar(s): under the top bar and above
    // the control bar in portrait, left of the rail in landscape. The bar
    // and the control bar stay live (not inert), the rest is inert; the ×
    // is 44px, hittable, top right, and closes it. At 768 and 1440 it is
    // side-docked at the end edge with the map live. The panel header (title
    // + ×, no grip) is the same at every width.
    const headers = {};
    for (const vp of [{ name: '390', width: 390, height: 844, touch: true }, { name: '320', width: 320, height: 568, touch: true },
      { name: '750x340', width: 750, height: 340, touch: true }, { name: '768', width: 768, height: 1024, touch: true },
      { name: '1440', width: 1440, height: 900 }]) {
      const { page, close } = await open('?station=aceabsar', { ready: () => true, viewport: vp });
      const ok = await page.waitForFunction(sheetOpen, null, { timeout: 30000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const R = (el) => { const q = el.getBoundingClientRect(); return { x: Math.round(q.x), y: Math.round(q.y), r: Math.round(q.right), b: Math.round(q.bottom), w: Math.round(q.width), h: Math.round(q.height) }; };
        const s = document.getElementById('station-sheet'), nav = document.getElementById('navbar'), cb = document.getElementById('controlbar');
        const x = s.querySelector('[data-close-sheet]'), xr = x.getBoundingClientRect();
        const top = document.elementFromPoint(xr.x + xr.width / 2, xr.y + xr.height / 2);
        const rail = document.documentElement.classList.contains('is-rail');
        return { sheet: R(s), nav: R(nav), cb: cb.getClientRects().length ? R(cb) : null, vw: innerWidth, vh: innerHeight, rail,
          navInert: !!nav.closest('[inert]'), cbInert: !!cb.closest('[inert]'), mainInert: !!document.getElementById('main').closest('[inert]'),
          close: { ...R(x), hit: !!top && (top === x || x.contains(top)) },
          head: [...s.querySelector('.mco-sheet-head').children].filter((c) => c.getClientRects().length).map((c) => c.tagName + (c.matches('[data-close-sheet]') ? '[close]' : '') + (c.matches('.mco-sheet-grip') ? '[grip]' : '')).join(' ') };
      });
      headers[vp.name] = r.head;
      const phone = vp.width <= 640 || vp.height <= 560;
      const closeOk = r.close.hit && r.close.w >= 44 && r.close.h >= 44 && r.close.r >= r.sheet.r - 24 && r.close.y <= r.sheet.y + 24;
      if (phone) {
        const wantTop = r.rail ? 0 : r.nav.b, wantBottom = r.rail ? r.vh : (r.cb ? r.cb.y : r.vh), wantRight = r.rail ? r.nav.x : r.vw;
        check(`[${vp.name}] panel = the viewport less the bar(s), bar and control bar live, the rest inert`,
          ok && Math.abs(r.sheet.y - wantTop) <= 1 && Math.abs(r.sheet.b - wantBottom) <= 1 && r.sheet.x === 0 && Math.abs(r.sheet.r - wantRight) <= 1
          && !r.navInert && !r.cbInert && r.mainInert, JSON.stringify(r));
      } else {
        check(`[${vp.name}] panel side-docked at the end edge under the bar, map live`,
          ok && r.sheet.r === r.vw && r.sheet.x > 0 && Math.abs(r.sheet.y - r.nav.b) <= 1 && !r.mainInert, JSON.stringify(r));
      }
      check(`[${vp.name}] panel × is 44px, top right, hittable`, closeOk, JSON.stringify(r.close));
      await page.click('#station-sheet [data-close-sheet]'); await page.waitForTimeout(600);
      const after = await page.evaluate(() => ({ open: !document.getElementById('station-sheet').hidden && document.getElementById('station-sheet').dataset.state !== 'closed', station: new URLSearchParams(location.search).get('station') }));
      check(`[${vp.name}] × closes the panel`, !after.open && !after.station, JSON.stringify(after));
      await close();
    }
    check('panel header identical at 1440, 768 and 390 (title + ×, no grip)', headers['1440'] === headers['768'] && headers['768'] === headers['390'] && headers['390'] === 'H2 BUTTON[close]', JSON.stringify(headers));
    // Kit 1.0.0, ← / → step the day (initPhotoControls arrowKeys): from the
    // page and from a map a pointer focused; not from a field, not inside
    // the open station panel (its ← / → step stations and win), not with
    // ?kbd=off. At 1440 (the bar's stepper) and 390 (the control bar's).
    const dateNow = (page) => page.evaluate(() => document.getElementById('date-input').value);
    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844, touch: true }]) {
      const { page, close } = await open('?date=2026-11-10&time=12', { ready: mosaicReady, viewport: vp });
      const keys = await page.evaluate(() => ['btn-date-prev', 'btn-date-next', 'btn-rail-prev', 'btn-rail-next'].map((id) => document.getElementById(id).getAttribute('aria-keyshortcuts')).join(','));
      check(`[${vp.name}] day steppers carry aria-keyshortcuts`, keys === 'ArrowLeft,ArrowRight,ArrowLeft,ArrowRight', keys);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400);
      const d1 = await dateNow(page);
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
      const d2 = await dateNow(page);
      check(`[${vp.name}] ← / → step the day from the page`, d1 === '2026-11-09' && d2 === '2026-11-10', `${d1} ${d2}`);
      // A map a pointer focused: ← steps the day (not a pan).
      const box = await page.locator('#map canvas').boundingBox();
      await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.9); await page.waitForTimeout(400);
      await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400);
      const d3 = await dateNow(page);
      check(`[${vp.name}] after a click on the map, ← steps the day`, d3 === '2026-11-09', d3);
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
      if (vp.name === '1440') {
        await page.focus('#date-input'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400);
        const sel = await page.evaluate(() => ({ v: document.getElementById('date-input').value, url: new URLSearchParams(location.search).get('date') }));
        check('[1440] ← in the date field stays the field\'s (no day step)', sel.url === '2026-11-10', JSON.stringify(sel));
      }
      await close();
    }
    {
      // Inside the open panel ← / → step stations and the day stays put.
      const { page, close } = await open('?date=2026-11-10&time=12&station=acebozem&lng=-110&lat=46&zoom=6', { ready: () => { const s = document.getElementById('station-sheet'); return !!s && !s.hidden && s.dataset.state !== 'closed' && document.querySelectorAll('#photo-grid .photo-btn').length > 0; } });
      await page.focus('#btn-station-next'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({ date: document.getElementById('date-input').value, station: new URLSearchParams(location.search).get('station') }));
      check('[1440] in the open panel → steps the station, not the day', r.date === '2026-11-10' && r.station && r.station !== 'acebozem', JSON.stringify(r));
      await close();
    }
    {
      const { page, close } = await open('?kbd=off&date=2026-11-10&time=12', { ready: mosaicReady });
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ date: document.getElementById('date-input').value, keys: document.getElementById('btn-date-prev').getAttribute('aria-keyshortcuts') }));
      check('[1440] ?kbd=off: ← leaves the day alone, no aria-keyshortcuts', r.date === '2026-11-10' && r.keys === null, JSON.stringify(r));
      await close();
    }
    // Kit 1.0.0, the control bar under a (simulated) keyboard at 390: hidden
    // and --tabbar-h 0 while visualViewport is 300px shorter.
    {
      const { page, close } = await open('', { ready: mosaicReady, viewport: { name: '390', width: 390, height: 844, touch: true } });
      const k = await page.evaluate(() => new Promise((res) => {
        const vv = window.visualViewport; if (!vv) { res(null); return; }
        const h = document.documentElement.clientHeight - 300;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
        vv.dispatchEvent(new Event('resize'));
        setTimeout(() => {
          const cb = document.getElementById('controlbar');
          res({ kb: document.documentElement.classList.contains('kb-open'), shown: cb.getClientRects().length > 0,
            tabbar: getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h').trim() });
          delete vv.height; vv.dispatchEvent(new Event('resize'));
        }, 300);
      }));
      check('[390] the control bar hides under a keyboard (--tabbar-h 0)', !!k && k.kb && !k.shown && k.tabbar === '0px', JSON.stringify(k));
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
