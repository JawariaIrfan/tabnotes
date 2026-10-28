// Real-Chrome regression tests for keyboard focus and typing isolation.
//
//   node tests/e2e-focus.js             (from the project root)
//
// A local "hostile" page reproduces what sites like ChatGPT, Gmail and Notion
// do with global handlers: redirect typing to their own composer when focus is
// not in an editable element, single-key shortcuts, paste/undo/IME interception,
// and pulling focus back to the composer after a click. Uses a separate headless
// Chrome with a throwaway profile; your own Chrome is never touched.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Browser, startSite, check, assertEq, results, sleep, CHROME, EXT_DIR } = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const cleanups = [];
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(d);
  return d;
};

const HOSTILE = `<!doctype html><meta charset="utf-8"><title>hostile</title>
<style>body{font:14px sans-serif;margin:20px} #composer{width:420px;height:70px;display:block}</style>
<h1>Hostile page</h1><p id="blank">Some page text.</p>
<textarea id="composer" placeholder="Message"></textarea>
<script>
  window.__hits = { redirect: 0, shortcut: 0, paste: 0, composition: 0, undo: 0 };
  const composer = document.getElementById('composer');
  const editable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  // ChatGPT-style "type anywhere": a printable key while nothing editable is focused goes to the composer.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (!editable(document.activeElement)) { window.__hits.redirect++; composer.focus(); }
  }, true);
  // Gmail-style single-key shortcuts that cancel the keystroke.
  document.addEventListener('keydown', (e) => {
    if (editable(document.activeElement)) return;
    if (['c', '/', 'j'].includes(e.key)) { window.__hits.shortcut++; e.preventDefault(); }
  }, true);
  // Editor-style interception of undo, paste and IME.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && document.activeElement !== composer) { window.__hits.undo++; e.preventDefault(); }
  }, true);
  document.addEventListener('paste', (e) => { if (document.activeElement !== composer) { window.__hits.paste++; e.preventDefault(); } }, true);
  document.addEventListener('compositionstart', () => { window.__hits.composition++; }, true);
  // "Click anywhere refocuses the composer", done asynchronously like many chat apps.
  document.addEventListener('click', (e) => {
    if (!editable(e.target) && e.target.tagName !== 'BUTTON' && e.target.id !== 'blank') setTimeout(() => composer.focus(), 30);
  }, true);
  if (location.search.includes('blockmousedown')) {
    // Some apps cancel mousedown on non-inputs so their editor keeps focus.
    document.addEventListener('mousedown', (e) => { if (!editable(e.target)) e.preventDefault(); }, true);
  }
  if (location.search.includes('stealloop')) {
    window.__stealing = false;
    window.__startStealing = () => { window.__stealing = true; const t = setInterval(() => composer.focus(), 50); setTimeout(() => clearInterval(t), 2000); };
  }
</script>`;

function siteHandler(req, res) {
  if (!req.url.startsWith('/hostile')) return false;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HOSTILE);
  return true;
}

const KEYS = {
  ' ': ['Space', 32], '/': ['Slash', 191], '!': ['Digit1', 49, 8], '.': ['Period', 190]
};
function keyInfo(ch) {
  if (KEYS[ch]) return { code: KEYS[ch][0], vk: KEYS[ch][1], mods: KEYS[ch][2] || 0 };
  if (/[a-z]/.test(ch)) return { code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), mods: 0 };
  if (/[A-Z]/.test(ch)) return { code: 'Key' + ch, vk: ch.charCodeAt(0), mods: 8 };
  if (/[0-9]/.test(ch)) return { code: 'Digit' + ch, vk: ch.charCodeAt(0), mods: 0 };
  throw new Error('no key info for ' + ch);
}

/** Real key presses (keyDown with text, then keyUp), like a keyboard. */
async function typeKeys(p, text) {
  for (const ch of text) {
    const { code, vk, mods } = keyInfo(ch);
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, text: ch, unmodifiedText: ch, modifiers: mods });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, modifiers: mods });
  }
}
async function press(p, key, code, vk, opts = {}) {
  const base = { key, code, windowsVirtualKeyCode: vk, modifiers: opts.modifiers || 0 };
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(opts.text ? { text: opts.text } : {}), ...(opts.commands ? { commands: opts.commands } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const ENTER = (p) => press(p, 'Enter', 'Enter', 13, { text: '\r' });
const TAB = (p, shift) => press(p, 'Tab', 'Tab', 9, { modifiers: shift ? 8 : 0 });
const BACKSPACE = (p) => press(p, 'Backspace', 'Backspace', 8);

async function setup(extDir, pagePath = '/hostile') {
  const b = await Browser.launch(tmp('tn-fx-'));
  const { id } = await b.send('Extensions.loadUnpacked', { path: extDir });
  const ext = await b.newPage(`chrome-extension://${id}/manage.html`);
  return { b, ext, id, pagePath };
}
async function openHostile(ctx, base, query = '') {
  const p = await ctx.b.newPage(base + ctx.pagePath + query);
  await p.waitForTabNotes();
  return p;
}
const notesOn = (ext, needle) => ext.eval(`chrome.storage.local.get(null).then((a) => Object.values(a)
  .filter((n) => n && n.id && n.href && n.href.includes(${JSON.stringify(needle)})))`);
const hits = (p) => p.eval('window.__hits');
const composerText = (p) => p.eval('document.getElementById("composer").value');
const active = (p) => p.eval('document.activeElement.tagName.toLowerCase() + (document.activeElement.id ? "#" + document.activeElement.id : "")');

/** Creates a note with the floating button; returns its stored geometry. */
async function newNote(p, ext, needle) {
  const before = (await notesOn(ext, needle)).map((n) => n.id);
  await p.newNote();
  await sleep(250);
  const n = (await notesOn(ext, needle)).find((x) => !before.includes(x.id));
  if (!n) throw new Error('note was not created');
  return n;
}
const textAreaPoint = (n) => [n.x + 30, n.y + 36 + 20];

function exportV100(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', 'v1.0.0', 'tabnotes/'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (!files.length) throw new Error('could not read tag v1.0.0 (run: git fetch --tags)');
  for (const f of files) {
    const dest = path.join(dir, path.relative('tabnotes', f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, execFileSync('git', ['-C', ROOT, 'show', `v1.0.0:${f}`], { maxBuffer: 1 << 24 }));
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log('Chrome not found at ' + CHROME + '. Set CHROME_PATH.');
    process.exit(2);
  }
  const site = await startSite(siteHandler);
  const base = `http://127.0.0.1:${site.address().port}`;
  console.log('Chrome:', CHROME, '\nExtension:', EXT_DIR, '\nSite:', base, '\n\nScenarios:');

  // 0. The bug exists without the fix (published v1.0.0 on the same hostile page).
  await check('baseline: v1.0.0 loses note typing to the page (bug reproduced)', async () => {
    const dir = tmp('tn-fx-v1-');
    exportV100(dir);
    const ctx = await setup(dir);
    const p = await openHostile(ctx, base, '?v1');
    const n = await newNote(p, ctx.ext, '?v1');
    await p.click(...textAreaPoint(n));
    await sleep(200);
    await typeKeys(p, 'hello');
    await sleep(300);
    const [stored] = await notesOn(ctx.ext, '?v1');
    const comp = await composerText(p);
    await ctx.b.close();
    if (stored.text === 'hello' && comp === '') throw new Error('v1.0.0 did NOT show the bug on this page');
    return `note text ${JSON.stringify(stored.text)}, page composer ${JSON.stringify(comp)}`;
  });

  const ctx = await setup(EXT_DIR);

  // 1. Title.
  await check('title: typing after creating a note goes into the title only', async () => {
    const p = await openHostile(ctx, base, '?title');
    await newNote(p, ctx.ext, '?title');
    await typeKeys(p, 'Shopping list');
    await sleep(300);
    const [n] = await notesOn(ctx.ext, '?title');
    assertEq(n.title, 'Shopping list', 'note title');
    assertEq(await composerText(p), '', 'page composer');
    assertEq(await hits(p), { redirect: 0, shortcut: 0, paste: 0, composition: 0, undo: 0 }, 'page handlers reached');
  });

  // 2-3. Text area, shortcut keys, click-anywhere refocus.
  await check('text area: click + type (incl. shortcut keys c / j) stays in the note despite async refocus', async () => {
    const p = await openHostile(ctx, base, '?text');
    const n = await newNote(p, ctx.ext, '?text');
    await p.click(...textAreaPoint(n));
    await sleep(250); // the page refocuses its composer 30 ms after the click
    const focused = await active(p);
    await typeKeys(p, 'call jo / Bob at 5!');
    await sleep(300);
    const [s] = await notesOn(ctx.ext, '?text');
    assertEq(s.text, 'call jo / Bob at 5!', 'note text');
    assertEq(await composerText(p), '', 'page composer');
    const h = await hits(p);
    assertEq([h.redirect, h.shortcut], [0, 0], 'page redirect/shortcut handlers reached');
    return 'focus after click + page refocus: ' + focused;
  });

  // 4. Checklist through the keyboard (Enter/Backspace are TabNotes' own key handlers).
  await check('checklist: add with Enter, edit, Backspace-remove all work', async () => {
    const p = await openHostile(ctx, base, '?list');
    const n = await newNote(p, ctx.ext, '?list');
    await p.click(...textAreaPoint(n));
    await sleep(200);
    await TAB(p); // text area -> "+ Add checklist item"
    await typeKeys(p, 'milk');
    await ENTER(p);
    await typeKeys(p, 'eggs');
    await ENTER(p);
    await TAB(p, true); // -> remove button of "eggs"
    await TAB(p, true); // -> "eggs" text (Chrome selects a field's text when tabbing into it)
    await press(p, 'End', 'End', 35);
    await typeKeys(p, 'x');
    await sleep(300);
    let [s] = await notesOn(ctx.ext, '?list');
    assertEq(s.items.map((i) => i.text), ['milk', 'eggsx'], 'items after add/edit');
    for (let i = 0; i < 6; i++) await BACKSPACE(p); // empties "eggsx", then removes the item
    await sleep(300);
    [s] = await notesOn(ctx.ext, '?list');
    assertEq(s.items.map((i) => i.text), ['milk'], 'items after Backspace on empty item');
    assertEq(await composerText(p), '', 'page composer');
  });

  // 5. Undo/redo and selection keep working inside the note; the page's undo handler is not reached.
  await check('undo (Ctrl+Z) and select-all work in the note; page handler not reached', async () => {
    const p = await openHostile(ctx, base, '?undo');
    const n = await newNote(p, ctx.ext, '?undo');
    await p.click(...textAreaPoint(n));
    await sleep(200);
    await typeKeys(p, 'abc');
    await press(p, 'z', 'KeyZ', 90, { modifiers: 2, commands: ['undo'] });
    await sleep(300);
    let [s] = await notesOn(ctx.ext, '?undo');
    if (s.text === 'abc') throw new Error('undo did not change the text');
    await typeKeys(p, 'xyz');
    await press(p, 'a', 'KeyA', 65, { modifiers: 2, commands: ['selectAll'] });
    await typeKeys(p, 'Q');
    await sleep(300);
    [s] = await notesOn(ctx.ext, '?undo');
    assertEq(s.text, 'Q', 'text after select-all + typing');
    assertEq((await hits(p)).undo, 0, 'page undo handler reached');
  });

  // 6. IME composition.
  await check('IME composition goes into the note; page composition handlers not reached', async () => {
    const p = await openHostile(ctx, base, '?ime');
    const n = await newNote(p, ctx.ext, '?ime');
    await p.click(...textAreaPoint(n));
    await sleep(200);
    await p.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await p.send('Input.insertText', { text: '日本' });
    await sleep(300);
    const [s] = await notesOn(ctx.ext, '?ime');
    assertEq(s.text, '日本', 'note text');
    assertEq((await hits(p)).composition, 0, 'page composition handlers reached');
    assertEq(await composerText(p), '', 'page composer');
  });

  // 7. Clicking outside gives the page its keyboard back.
  await check('clicking outside the note restores normal page typing and shortcuts', async () => {
    const p = await openHostile(ctx, base, '?outside');
    const n = await newNote(p, ctx.ext, '?outside');
    await p.click(...textAreaPoint(n));
    await sleep(200);
    await typeKeys(p, 'note');
    const box = await p.eval('(() => { const r = document.getElementById("composer").getBoundingClientRect(); return [r.x + 20, r.y + 20]; })()');
    await p.click(...box);
    await sleep(300);
    assertEq(await active(p), 'textarea#composer', 'focus after clicking the page composer');
    await typeKeys(p, 'hi there');
    const blank = await p.eval('(() => { const r = document.getElementById("blank").getBoundingClientRect(); return [r.x + 5, r.y + 5]; })()');
    await p.click(...blank);
    await sleep(300);
    await typeKeys(p, 'c'); // the page's own "type anywhere" handler works again
    await sleep(200);
    const [s] = await notesOn(ctx.ext, '?outside');
    assertEq(s.text, 'note', 'note text');
    assertEq(await composerText(p), 'hi therec', 'page composer');
    assertEq((await hits(p)).redirect, 1, 'page keyboard handler after leaving the note');
  });

  // 8. A page that keeps stealing focus: TabNotes gives up instead of fighting.
  await check('page that keeps stealing focus: at most 3 focus returns, no focus fight', async () => {
    const p = await openHostile(ctx, base, '?stealloop');
    const n = await newNote(p, ctx.ext, '?stealloop');
    await p.click(...textAreaPoint(n));
    await sleep(200);
    await p.eval(`window.__noteFocus = 0; document.addEventListener('focusin', (e) => {
      if (e.target.tagName === 'TABNOTES-UI') window.__noteFocus++; }, true); window.__startStealing(); true`);
    await sleep(2300);
    const returns = await p.eval('window.__noteFocus');
    if (returns > 3) throw new Error('TabNotes took focus back ' + returns + ' times');
    assertEq(await p.eval('1 + 1'), 2, 'page still responsive');
    return returns + ' focus returns while the page stole focus every 50 ms for 2 s';
  });

  // 9. Keyboard accessibility: grip arrow keys and Escape (TabNotes' own handlers via replay).
  await check('keyboard: grip arrow keys move the note; Esc cancels delete confirmation', async () => {
    const p = await openHostile(ctx, base, '?kbd');
    const n = await newNote(p, ctx.ext, '?kbd');
    await TAB(p, true); // title -> grip
    for (let i = 0; i < 3; i++) await press(p, 'ArrowLeft', 'ArrowLeft', 37);
    await sleep(300);
    const [moved] = await notesOn(ctx.ext, '?kbd');
    assertEq(moved.x, n.x - 30, 'x after 3 x ArrowLeft');
    await p.click(n.x - 30 + n.w - 19, n.y + 19); // trash -> "Delete?"
    await sleep(100);
    await press(p, 'Escape', 'Escape', 27);
    await sleep(100);
    await p.click(n.x - 30 + n.w - 19, n.y + 19); // first click again: only asks, so the note survives
    await sleep(300);
    assertEq((await notesOn(ctx.ext, '?kbd')).length, 1, 'notes after Esc + one click');
  });

  // 10. Page cancels mousedown: clicking a note field still focuses it.
  await check('page that cancels mousedown: clicking the note text area still focuses it', async () => {
    const p = await openHostile(ctx, base, '?blockmousedown');
    const n = await newNote(p, ctx.ext, '?blockmousedown');
    await p.click(...textAreaPoint(n));
    await sleep(250);
    await typeKeys(p, 'works');
    await sleep(300);
    const [s] = await notesOn(ctx.ext, '?blockmousedown');
    assertEq(s.text, 'works', 'note text');
    assertEq(await composerText(p), '', 'page composer');
  });

  // 11. Floating button, drag, resize still work on the hostile page.
  await check('floating button, drag and resize still work', async () => {
    const p = await openHostile(ctx, base, '?drag');
    const n = await newNote(p, ctx.ext, '?drag');
    await p.drag(n.x + 17, n.y + 18, n.x + 17 - 200, n.y + 18 + 100, 15);
    await sleep(300);
    let [s] = await notesOn(ctx.ext, '?drag');
    assertEq([s.x, s.y], [n.x - 200, n.y + 100], 'position after drag');
    await p.drag(s.x + s.w - 6, s.y + s.h - 6, s.x + s.w - 6 + 60, s.y + s.h - 6 + 40, 10);
    await sleep(300);
    [s] = await notesOn(ctx.ext, '?drag');
    assertEq([s.w, s.h], [n.w + 60, n.h + 40], 'size after resize');
  });

  await ctx.b.close();

  // 12. Known limitation: TabNotes injected into a page that was already open.
  await check('page open before TabNotes was installed (informational)', async () => {
    const b = await Browser.launch(tmp('tn-fx-'));
    const p = await b.newPage(base + '/hostile?late');
    const { id } = await b.send('Extensions.loadUnpacked', { path: EXT_DIR });
    const ext = await b.newPage(`chrome-extension://${id}/manage.html`);
    await b.send('Target.activateTarget', { targetId: p.targetId });
    await p.waitForTabNotes();
    const n = await newNote(p, ext, '?late');
    await p.click(...textAreaPoint(n));
    await sleep(250);
    await typeKeys(p, 'hello');
    await sleep(300);
    const [s] = await notesOn(ext, '?late');
    const comp = await composerText(p);
    // TabNotes should tell the user to reload; after the reload, typing is isolated.
    await sleep(300);
    await p.goto(base + '/hostile?late');
    await p.waitForTabNotes();
    const [again] = await notesOn(ext, '?late');
    await p.click(...textAreaPoint(again));
    await sleep(250);
    await typeKeys(p, 'world');
    await sleep(300);
    const [afterReload] = await notesOn(ext, '?late');
    await b.close();
    if (!afterReload.text.endsWith('world')) throw new Error('after reload, typing still went to the page: ' + JSON.stringify(afterReload.text));
    return `before reload: note ${JSON.stringify(s.text)}, page composer ${JSON.stringify(comp)}; after reload: note ${JSON.stringify(afterReload.text)}`;
  });

  site.close();
  for (const d of cleanups) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
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
