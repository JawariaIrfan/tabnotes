// Real-Chrome regression tests for startup, session restore, discarded tabs,
// popup readiness and duplicate-injection prevention.
//
//   node tests/e2e-startup.js           (from the project root)
//
// Uses a separate headless Chrome with throwaway profiles; your own Chrome and
// its data are never touched.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Browser, startSite, check, assertEq, results, sleep, CHROME, EXT_DIR } = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cleanups = [];

// /slow/... sends the start of the page, then holds the rest for 2.5 s, so the
// manifest content script (document_idle) cannot have run yet.
function siteHandler(req, res) {
  if (!req.url.startsWith('/slow')) return false;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write('<!doctype html><meta charset="utf-8"><title>slow</title><h1>Slow page</h1>' + ' '.repeat(2048));
  setTimeout(() => res.end('<p>done</p>'), 2500);
  return true;
}

/** Extension page with readiness.js loaded, used to drive the popup logic and read storage. */
async function openExtPage(browser, extId) {
  const ext = await browser.newPage(`chrome-extension://${extId}/manage.html`);
  await ext.eval(`new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'readiness.js';
    s.onload = () => resolve(true);
    s.onerror = reject;
    document.head.append(s);
  })`);
  return ext;
}

/** Runs the popup's readiness handshake for a tab, exactly as popup.js does. */
function resolveFromPopup(ext, tabId) {
  return ext.eval(`(async () => {
    const states = [];
    const t0 = Date.now();
    const result = await TabNotesReadiness.resolvePageState(chrome, ${tabId}, {
      onState: (s) => states.push(s),
      requestInjection: async () => {
        const res = await chrome.runtime.sendMessage({ type: 'tabnotes:ensure', tabId: ${tabId} });
        if (!res || !res.ok) throw new Error((res && res.error) || 'no response');
      }
    });
    return { state: result.state, count: result.status && result.status.count, reason: result.reason, states, ms: Date.now() - t0 };
  })()`);
}

const tabsInfo = (ext) => ext.eval(`chrome.tabs.query({}).then((ts) => ts.map((t) => ({
  id: t.id, url: t.url || t.pendingUrl || '', status: t.status, discarded: t.discarded, active: t.active })))`);
const tabIdFor = async (ext, needle) => {
  const t = (await tabsInfo(ext)).find((x) => x.url.includes(needle));
  if (!t) throw new Error('no tab for ' + needle);
  return t.id;
};

/** Counts TabNotes UIs in a tab via the DevTools target (page world). */
async function uiCount(browser, needle) {
  const { targetInfos } = await browser.send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'page' && x.url.includes(needle));
  if (!t) throw new Error('no target for ' + needle);
  const s = await browser.attach(t.targetId);
  return s.eval('document.querySelectorAll("tabnotes-ui").length');
}

async function waitFor(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn().catch((e) => e.message);
    if (last === true) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const storeNote = (ext, pageKey, title) => ext.eval(`chrome.storage.local.set({ 'note:${title}': {
  id: '${title}', pageKey: '${pageKey}', siteKey: '${pageKey.split('/')[0]}', href: 'http://${pageKey}',
  scope: 'page', title: '${title}', text: '', items: [], x: 40, y: 80, w: 260, h: 240,
  minimized: false, createdAt: 1, updatedAt: 1 } }).then(() => true)`);

/** The published v1.0.0 extension files, exactly as committed on main (LF endings). */
function exportV100(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', 'main', 'tabnotes/'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (!files.length) throw new Error('could not read main branch');
  for (const f of files) {
    const data = execFileSync('git', ['-C', ROOT, 'show', `main:${f}`], { maxBuffer: 1 << 24 });
    const dest = path.join(dir, path.relative('tabnotes', f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log('Chrome not found at ' + CHROME + '. Set CHROME_PATH.');
    process.exit(2);
  }
  const site = await startSite(siteHandler);
  const port = site.address().port;
  const base = `http://127.0.0.1:${port}`;
  const key = (p) => `127.0.0.1:${port}${p}`;
  console.log('Chrome:', CHROME, '\nExtension:', EXT_DIR, '\nSite:', base, '\n\nScenarios:');

  // ---------------------------------------------------------------------------
  // 1. Tabs open before TabNotes is ready (install, or restored tabs that never
  //    got the manifest script): the button appears without a refresh.
  await check('tabs open before TabNotes loads get it automatically (active + background)', async () => {
    const profile = tmp('tn-st-');
    cleanups.push(profile);
    const browser = await Browser.launch(profile);
    const pages = [];
    for (const p of ['/pre-1', '/pre-2', '/pre-3']) pages.push(await browser.newPage(base + p));
    await browser.send('Target.activateTarget', { targetId: pages[0].targetId }); // others are background tabs
    for (const pg of pages) assertEq(await pg.eval('document.querySelectorAll("tabnotes-ui").length'), 0, 'UI before install');
    const { id } = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
    for (const p of ['/pre-1', '/pre-2', '/pre-3']) {
      await waitFor(async () => (await uiCount(browser, p)) === 1, 5000, 'button in ' + p);
    }
    const ext = await openExtPage(browser, id);
    for (const p of ['/pre-1', '/pre-2', '/pre-3']) {
      const r = await resolveFromPopup(ext, await tabIdFor(ext, p));
      assertEq(r.state, 'ready', 'popup state for ' + p);
    }
    await browser.close();
    return '3/3 tabs show one button; popup says ready';
  });

  // ---------------------------------------------------------------------------
  // 2-3. Chrome cold start with session restore, including restored background tabs.
  // Branded Chrome 137+ ignores --load-extension, and extensions loaded over the
  // DevTools protocol are not kept in the profile, so here TabNotes starts only
  // after Chrome has restored the tabs: none of them got the manifest script.
  // That is the harder case; the usual order (extension first) is not reproducible here.
  await check('cold start + session restore, TabNotes ready after the tabs were restored', async () => {
    const profile = tmp('tn-st-');
    cleanups.push(profile);
    let browser = await Browser.launch(profile);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
    let ext = await openExtPage(browser, id);
    await storeNote(ext, key('/restore-1'), 'restored note');
    await ext.close();
    for (const p of ['/restore-1', '/restore-2', '/restore-3']) await browser.newPage(base + p);
    await sleep(3000); // let Chrome write its session file
    await browser.close();

    // Cold start that restores the previous session (same code path as "Continue
    // where you left off"); the unpacked extension starts with the profile.
    browser = await Browser.launch(profile, { urls: [], extraArgs: ['--restore-last-session'] });
    const { targetInfos } = await browser.send('Target.getTargets');
    const restored = targetInfos.filter((t) => t.type === 'page' && t.url.includes('/restore-')).map((t) => t.url);
    if (restored.length < 3) throw new Error('Chrome did not restore the session: ' + JSON.stringify(restored));
    const again = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
    assertEq(again.id, id, 'same extension id (same folder) so the stored note is still there');
    ext = await openExtPage(browser, id);
    const atStart = (await tabsInfo(ext)).filter((t) => t.url.includes('/restore-'))
      .map((t) => `${t.url.slice(-1)}:${t.active ? 'active' : 'bg'}/${t.discarded ? 'discarded' : t.status}`);
    const details = ['restored ' + atStart.join(' ')];
    for (const p of ['/restore-1', '/restore-2', '/restore-3']) {
      const tabId = await tabIdFor(ext, p);
      const t = (await tabsInfo(ext)).find((x) => x.id === tabId);
      if (t.discarded || t.status === 'unloaded') {
        // Lazily restored background tab: Chrome loads it when the user switches to it.
        await ext.eval(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
      }
      // The button must appear on its own, before anyone opens the popup.
      await waitFor(async () => (await uiCount(browser, p)) === 1, 6000, 'button without popup in ' + p);
      const r = await resolveFromPopup(ext, tabId);
      assertEq(r.state, 'ready', 'popup state for ' + p);
      details.push(`${p}: ${r.states.join('>')}${p === '/restore-1' ? ' notes=' + r.count : ''}`);
      if (p === '/restore-1') assertEq(r.count, 1, 'restored note shown');
    }
    await browser.close();
    return details.join('; ');
  });

  // ---------------------------------------------------------------------------
  const profile = tmp('tn-st-');
  cleanups.push(profile);
  let browser = await Browser.launch(profile);
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
  const ext = await openExtPage(browser, extId);

  // 4. Discarded tab becoming active.
  await check('discarded tab: button returns when the tab is activated again', async () => {
    await storeNote(ext, key('/discard'), 'discard note');
    await browser.newPage(base + '/discard');
    await browser.newPage(base + '/other'); // makes /discard a background tab
    const tabId = await tabIdFor(ext, '/discard');
    const discarded = await ext.eval(`chrome.tabs.discard(${tabId}).then((t) => ({ id: t.id, discarded: t.discarded }))`);
    assertEq(discarded.discarded, true, 'tab discarded');
    const newId = discarded.id; // Chrome may give the discarded tab a new id
    // Popup opened at the moment the user switches to the discarded tab (it starts reloading).
    const [r] = await Promise.all([
      resolveFromPopup(ext, newId),
      ext.eval(`chrome.tabs.update(${newId}, { active: true }).then(() => true)`)
    ]);
    assertEq(r.state, 'ready', 'popup state after activation');
    assertEq(r.count, 1, 'note shown after reactivation');
    await waitFor(async () => (await uiCount(browser, '/discard')) === 1, 5000, 'one button');
    return `popup states: ${r.states.join('>')} in ${r.ms} ms`;
  });

  // 5. Popup opened before content.js initializes (page still loading).
  await check('popup opened while the page is still loading shows Loading, then Ready', async () => {
    const pg = await browser.newPage();
    await pg.send('Page.navigate', { url: base + '/slow/popup-early' });
    await sleep(300);
    const tabId = await tabIdFor(ext, '/slow/popup-early');
    // What v1.0.0's popup did: one message, any error = "unsupported".
    const oldPopup = await ext.eval(`chrome.tabs.sendMessage(${tabId}, { type: 'tabnotes:status' })
      .then(() => 'answered', (e) => e.message)`);
    const r = await resolveFromPopup(ext, tabId);
    assertEq(r.state, 'ready', 'final state');
    assertEq(r.states, ['loading', 'ready'], 'states shown');
    if (r.ms < 1500) throw new Error('page was not actually slow: ' + r.ms + ' ms');
    return `v1.0.0 logic got "${oldPopup}" -> would show "unsupported"; now loading>ready after ${r.ms} ms`;
  });

  // 6. Delayed responses: slow page + repeated popups at different moments.
  await check('repeated popup openings during and after load all end Ready, one button', async () => {
    const pg = await browser.newPage();
    await pg.send('Page.navigate', { url: base + '/slow/repeat' });
    await sleep(200);
    const tabId = await tabIdFor(ext, '/slow/repeat');
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(resolveFromPopup(ext, tabId));
      await sleep(400); // popup opened again and again while the page loads
    }
    const out = await Promise.all(runs);
    if (!out.every((r) => r.state === 'ready')) throw new Error(JSON.stringify(out.map((r) => r.state)));
    assertEq(await uiCount(browser, '/slow/repeat'), 1, 'buttons');
    return out.map((r) => r.ms + 'ms').join(', ');
  });

  // 7. Duplicate-injection prevention.
  await check('injecting TabNotes again (x5, concurrently) keeps one button, one set of notes and listeners', async () => {
    await storeNote(ext, key('/dup'), 'dup note');
    const pg = await browser.newPage(base + '/dup');
    await pg.waitForTabNotes();
    const tabId = await tabIdFor(ext, '/dup');
    await ext.eval(`(async () => {
      const jobs = [];
      for (let i = 0; i < 5; i++) {
        jobs.push(chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['nav-hook.js'], world: 'MAIN' })
          .then(() => chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['keyguard.js', 'common.js', 'saver.js', 'content.js'] })));
        jobs.push(chrome.runtime.sendMessage({ type: 'tabnotes:ensure', tabId: ${tabId} }));
      }
      await Promise.all(jobs);
      return true;
    })()`);
    await sleep(500);
    assertEq(await pg.eval('document.querySelectorAll("tabnotes-ui").length'), 1, 'buttons');
    const r = await resolveFromPopup(ext, tabId);
    assertEq(r.count, 1, 'notes shown');
    // One click on the button must create exactly one note (duplicate listeners would create more).
    await pg.newNote();
    await pg.typeFast('typed after duplicates');
    await sleep(400);
    const notes = await ext.eval(`chrome.storage.local.get(null).then((all) => Object.values(all)
      .filter((n) => n && n.pageKey === '${key('/dup')}').map((n) => n.title))`);
    assertEq(notes.sort(), ['dup note', 'typed after duplicates'], 'notes stored for the page');
    // pushState must be reported once (the history hook is not wrapped repeatedly).
    const wraps = await pg.eval(`(() => { let n = 0; window.addEventListener('tabnotes:locationchange', () => n++);
      history.pushState({}, '', '/dup?x=1'); return n; })()`);
    assertEq(wraps, 1, 'locationchange events per pushState');
  });

  // 8. Unsupported URLs: no injection, popup says Unsupported.
  await check('unsupported pages: popup says Unsupported, nothing injected', async () => {
    const out = [];
    for (const url of ['chrome://version/', 'about:blank', 'data:text/html,<h1>data</h1>']) {
      const pg = await browser.newPage(url);
      await sleep(300);
      const tabs = await tabsInfo(ext);
      // Chrome hides URLs TabNotes has no access to, so find the tab via its DevTools target id.
      const { targetInfo } = await browser.send('Target.getTargetInfo', { targetId: pg.targetId });
      const tab = tabs.find((t) => t.url === targetInfo.url) ||
        tabs.filter((t) => !t.url).slice(-1)[0];
      const r = await resolveFromPopup(ext, tab.id);
      assertEq(r.state, 'unsupported', 'state for ' + url);
      assertEq(await pg.eval('document.querySelectorAll("tabnotes-ui").length'), 0, 'UI on ' + url);
      out.push(`${url.slice(0, 16)}: ${r.ms}ms`);
    }
    return out.join(', ');
  });

  await browser.close();

  // ---------------------------------------------------------------------------
  // 9. Upgrade from the published v1.0.0 with tabs open: the old, disconnected
  //    copy must not leave a second button behind (it re-adds its UI every second).
  await check('update from v1.0.0 with open tabs: one working button, notes kept', async () => {
    const extDir = tmp('tn-st-ext-');
    const prof = tmp('tn-st-');
    cleanups.push(extDir, prof);
    exportV100(extDir);
    const b = await Browser.launch(prof);
    const { id } = await b.send('Extensions.loadUnpacked', { path: extDir });
    let e = await b.newPage(`chrome-extension://${id}/manage.html`);
    await storeNote(e, key('/upgrade'), 'from v1');
    const pg = await b.newPage(base + '/upgrade');
    await pg.waitForTabNotes();
    // Install the new version over it (same folder => same extension id and storage).
    fs.cpSync(EXT_DIR, extDir, { recursive: true });
    const again = await b.send('Extensions.loadUnpacked', { path: extDir });
    assertEq(again.id, id, 'extension id after update');
    e = await openExtPage(b, id);
    const counts = [];
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      counts.push(await pg.eval('document.querySelectorAll("tabnotes-ui").length'));
    }
    if (counts.some((c) => c !== 1)) throw new Error('buttons over 3 s: ' + counts.join(','));
    const r = await resolveFromPopup(e, await tabIdFor(e, '/upgrade'));
    assertEq([r.state, r.count], ['ready', 1], 'state and notes');
    await pg.newNote();
    await pg.typeFast('after upgrade');
    await sleep(400);
    const titles = await e.eval(`chrome.storage.local.get(null).then((all) => Object.values(all)
      .filter((n) => n && n.pageKey === '${key('/upgrade')}').map((n) => n.title).sort())`);
    assertEq(titles, ['after upgrade', 'from v1'], 'notes after upgrade');
    // Reload again (new version over new version): the claim/teardown path.
    await b.send('Extensions.loadUnpacked', { path: extDir });
    await sleep(1500);
    assertEq(await pg.eval('document.querySelectorAll("tabnotes-ui").length'), 1, 'buttons after second reload');
    await b.close();
    return 'buttons each 0.5 s: ' + counts.join(',');
  });

  site.close();
  for (const dir of cleanups) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* Chrome may hold files briefly */
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
