// End-to-end persistence test in a real Chrome, using only Node built-ins.
//
// Launches a separate headless Chrome with a throwaway profile, loads the
// unpacked extension over the DevTools protocol (pipe transport), drives a local
// test site, and reads back what actually reached chrome.storage.local.
//
//   node tests/e2e-chrome.js            (from the project root)
//   set CHROME_PATH=...                 to use another Chromium-based browser
//   set TABNOTES_EXT_DIR=...            to test another copy (e.g. an extracted release ZIP)
//
// Your normal Chrome profile is never touched.
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// TABNOTES_EXT_DIR lets the same test run against an unpacked release package.
const EXT_DIR = path.resolve(process.env.TABNOTES_EXT_DIR || path.join(__dirname, '..', 'tabnotes'));
const SHOTS_DIR = process.env.E2E_SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny CDP client over --remote-debugging-pipe -------------------------

class Browser {
  static async launch(profile) {
    const args = [
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1200,800',
      'about:blank'
    ];
    const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const b = new Browser(proc);
    await b.send('Browser.getVersion');
    return b;
  }

  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.buf = '';
    this.exited = new Promise((r) => proc.on('exit', r));
    proc.stdio[4].on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, method } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(method + ': ' + msg.error.message));
          else resolve(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      }
    });
    proc.stdio[4].on('error', () => {});
    proc.stdio[3].on('error', () => {});
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdio[3].write(JSON.stringify(msg) + '\0');
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this, sessionId, targetId);
  }

  async newPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const s = await this.attach(targetId);
    await s.send('Page.enable');
    await s.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (url) await s.goto(url);
    return s;
  }

  async close() {
    try {
      await this.send('Browser.close');
    } catch (_) {
      /* pipe may close first */
    }
    await this.exited;
  }

  kill() {
    this.proc.kill('SIGKILL'); // TerminateProcess on Windows: no shutdown, like a crash/power cut
    return this.exited;
  }
}

class Session {
  constructor(browser, sessionId, targetId) {
    Object.assign(this, { browser, sessionId, targetId });
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }

  async goto(url) {
    const loaded = new Promise((resolve) => {
      const l = (m) => {
        if (m.sessionId === this.sessionId && m.method === 'Page.loadEventFired') {
          this.browser.listeners.splice(this.browser.listeners.indexOf(l), 1);
          resolve();
        }
      };
      this.browser.listeners.push(l);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async waitForTabNotes() {
    for (let i = 0; i < 100; i++) {
      if (await this.eval('!!document.querySelector("tabnotes-ui")')) return;
      await sleep(50);
    }
    throw new Error('TabNotes content script did not load');
  }

  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async drag(x1, y1, x2, y2, steps = 25) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  }

  key(key, code, keyCode, text) {
    const p = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    return this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p, text })
      .then(() => this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }));
  }

  /** Types like a fast human: one character every `ms` milliseconds. */
  async typeHuman(text, ms) {
    for (const ch of text) {
      await this.send('Input.insertText', { text: ch });
      await sleep(ms);
    }
  }

  /** Types one character at a time without waiting between them. Resolves after the last one. */
  typeFast(text) {
    let last;
    for (const ch of text) last = this.send('Input.insertText', { text: ch });
    return last;
  }

  async screenshot(name) {
    if (!SHOTS_DIR) return;
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOTS_DIR, name + '.png'), Buffer.from(data, 'base64'));
  }

  async viewport() {
    return this.eval('({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })');
  }

  /** Clicks the floating "new note" button; the new note's title gets focus. */
  async newNote() {
    const { w, h } = await this.viewport();
    await this.click(w - 16 - 20, h - 16 - 20);
    await sleep(50);
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId });
  }
}

// ---- local test site --------------------------------------------------------

function startSite() {
  const page = `<!doctype html><meta charset="utf-8"><title>TabNotes e2e</title>
    <h1>TabNotes e2e page</h1><p>Path: <span id="p"></span></p>
    <script>document.getElementById('p').textContent = location.pathname;</script>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- test runner --------------------------------------------------------------

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log('  FAIL  ' + name + '\n        ' + err.message);
  }
}
function assertEq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log('Chrome not found at ' + CHROME + '. Set CHROME_PATH.');
    process.exit(2);
  }
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnotes-e2e-'));
  console.log('Chrome:', CHROME, '\nExtension:', EXT_DIR, '\nProfile:', profile, '\nSite:', base);

  let browser = await Browser.launch(profile);
  const version = await browser.send('Browser.getVersion');
  console.log('Browser:', version.product);
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });

  // An extension page lets us read chrome.storage.local and message tabs.
  let ext;
  async function openExtPage() {
    ext = await browser.newPage(`chrome-extension://${extId}/manage.html`);
    await ext.eval(`window.__changes = []; chrome.storage.onChanged.addListener((c) => {
      for (const k of Object.keys(c)) window.__changes.push(k); }); true`);
  }
  await openExtPage();
  const allNotes = async () =>
    Object.entries(await ext.eval('chrome.storage.local.get(null)'))
      .filter(([k]) => k.startsWith('note:'))
      .map(([, v]) => v);
  const notesFor = async (pathname) => (await allNotes()).filter((n) => n.pageKey === `127.0.0.1:${site.address().port}${pathname}`);
  const tabStatus = () => ext.eval(`(async () => {
    const own = (await chrome.tabs.getCurrent()).id;
    const out = [];
    for (const t of await chrome.tabs.query({})) {
      if (t.id === own) continue;
      try { out.push(await chrome.tabs.sendMessage(t.id, { type: 'tabnotes:status' })); } catch (_) {}
    }
    return out;
  })()`);

  const longText = (n) => Array.from({ length: n }, (_, i) => 'abcdefghij'[i % 10]).join('');
  const ENTER = ['Enter', 'Enter', 13, '\r'];

  console.log('\nScenarios:');

  // 1. Rapid typing, then the tab is closed right after the last keystroke.
  await check('rapid typing then immediate tab close (x10)', async () => {
    let ok = 0;
    for (let run = 0; run < 10; run++) {
      const p = await browser.newPage(`${base}/close-${run}`);
      await p.waitForTabNotes();
      await p.newNote();
      await p.typeFast('Run ' + run);
      await p.key(...ENTER);
      const text = longText(150 + run * 17);
      await p.typeFast(text); // resolves when the last char was processed by the page
      await p.close(); // no waiting at all
      await sleep(300);
      const [n] = await notesFor(`/close-${run}`);
      if (n && n.title === 'Run ' + run && n.text === text) ok++;
      else throw new Error(`run ${run}: stored ${n ? JSON.stringify({ title: n.title, len: n.text.length }) : 'nothing'}, typed ${text.length} chars`);
    }
    return ok + '/10 complete';
  });

  // 2. Typing then immediate full navigation away.
  await check('typing then immediate navigation to another site page', async () => {
    const p = await browser.newPage(`${base}/nav-a`);
    await p.waitForTabNotes();
    await p.newNote();
    const text = 'navigate ' + longText(120);
    await p.typeFast(text);
    await p.goto(`${base}/nav-b`);
    await sleep(200);
    const [n] = await notesFor('/nav-a');
    assertEq(n && n.title, text, 'stored title');
    await p.close();
  });

  // 3. SPA navigation: type, pushState immediately, back/forward, no duplicates.
  await check('SPA pushState right after typing; back/forward without duplicates', async () => {
    const p = await browser.newPage(`${base}/spa/1`);
    await p.waitForTabNotes();
    await p.newNote();
    const text = 'spa ' + longText(80);
    await p.typeFast(text);
    await p.eval(`history.pushState({}, '', '/spa/2'); true`);
    await sleep(200);
    const [n] = await notesFor('/spa/1');
    assertEq(n && n.title, text, 'stored title after pushState');
    let st = (await tabStatus()).find(Boolean);
    assertEq(st.count, 0, 'notes shown on /spa/2');
    for (let i = 0; i < 3; i++) {
      await p.eval('history.back(); true');
      await sleep(250);
      st = (await tabStatus()).find(Boolean);
      assertEq(st.count, 1, `notes shown after back #${i + 1}`);
      await p.eval('history.forward(); true');
      await sleep(250);
      st = (await tabStatus()).find(Boolean);
      assertEq(st.count, 0, `notes shown after forward #${i + 1}`);
    }
    await p.eval(`history.replaceState({}, '', '/spa/1'); true`);
    await sleep(250);
    st = (await tabStatus()).find(Boolean);
    assertEq(st.count, 1, 'notes shown after replaceState back to /spa/1');
    await p.close();
  });

  // 4. Multiple notes on one page.
  await check('multiple notes on one page each keep their own text', async () => {
    const p = await browser.newPage(`${base}/multi`);
    await p.waitForTabNotes();
    for (const t of ['first note', 'second note', 'third note']) {
      await p.newNote();
      await p.typeFast(t);
    }
    await p.close();
    await sleep(300);
    const titles = (await notesFor('/multi')).map((n) => n.title).sort();
    assertEq(titles, ['first note', 'second note', 'third note'], 'stored titles');
  });

  // 5. Checklist: add items, toggle a checkbox rapidly, close immediately.
  await check('checklist items + rapid checkbox toggles, then immediate close', async () => {
    const p = await browser.newPage(`${base}/check`);
    await p.waitForTabNotes();
    await p.newNote();
    await p.typeFast('List');
    await p.key(...ENTER); // -> text area
    await p.key('Tab', 'Tab', 9); // -> "+ Add checklist item"
    for (const item of ['milk', 'eggs', 'bread']) {
      await p.typeFast(item);
      await p.key(...ENTER);
    }
    // Shift+Tab x3: remove button -> item text -> checkbox of "bread"
    for (let i = 0; i < 3; i++) {
      await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    }
    const toggles = 7; // odd -> checked
    let last;
    for (let i = 0; i < toggles; i++) last = p.key(' ', 'Space', 32, ' ');
    await last;
    await p.close();
    await sleep(300);
    const [n] = await notesFor('/check');
    assertEq(n.items.map((i) => [i.text, i.done]), [['milk', false], ['eggs', false], ['bread', true]], 'stored checklist');
  });

  // 6. Drag: the position is saved once at the end, not on every mouse move.
  await check('drag saves only the final position', async () => {
    const p = await browser.newPage(`${base}/drag`);
    await p.waitForTabNotes();
    await p.newNote();
    await p.typeFast('drag me');
    await sleep(200);
    let [n] = await notesFor('/drag');
    await ext.eval('window.__changes.length = 0; true');
    // Grab the grip at the left of the header.
    await p.drag(n.x + 17, n.y + 18, 300, 400, 30);
    await sleep(300);
    const writes = await ext.eval(`window.__changes.filter((k) => k === ${JSON.stringify('note:' + n.id)}).length`);
    [n] = await notesFor('/drag');
    if (Math.abs(n.x - 283) > 2 || Math.abs(n.y - 382) > 2) throw new Error(`stored position ${n.x},${n.y}`);
    if (writes !== 1) throw new Error(`expected 1 storage write for a 30-step drag, saw ${writes}`);
    await p.close();
    return '30 mouse moves -> ' + writes + ' write';
  });

  // 7. Deletion (trash, then confirm), survives reload.
  await check('delete removes the note from storage and it stays gone after reload', async () => {
    const p = await browser.newPage(`${base}/delete`);
    await p.waitForTabNotes();
    await p.newNote();
    await p.typeFast('delete me ' + longText(40));
    await sleep(100);
    const [n] = await notesFor('/delete');
    const tx = n.x + n.w - 1 - 4 - 14;
    const ty = n.y + 1 + 18;
    await p.click(tx, ty); // shows "Delete?"
    await sleep(80);
    await p.click(tx, ty); // confirms
    await sleep(300);
    assertEq((await notesFor('/delete')).length, 0, 'notes stored after delete');
    await p.goto(`${base}/delete`);
    await p.waitForTabNotes();
    await sleep(300);
    assertEq((await tabStatus()).find(Boolean).count, 0, 'notes shown after reload');
    await p.close();
  });

  // 8. Storage failure: quota full -> "Save failed"; free space -> retried and "Saved".
  await check('storage full: save fails visibly, then recovers automatically', async () => {
    const p = await browser.newPage(`${base}/quota`);
    await p.waitForTabNotes();
    await p.newNote();
    await p.typeFast('quota test');
    await sleep(200);
    await ext.eval(`(async () => {
      const used = await chrome.storage.local.getBytesInUse(null);
      const room = chrome.storage.local.QUOTA_BYTES - used - 2000;
      await chrome.storage.local.set({ filler: 'x'.repeat(room) });
      return true;
    })()`);
    await p.key(...ENTER);
    const text = longText(3000); // needs more than the ~2 KB left
    await p.send('Input.insertText', { text });
    await sleep(400);
    let [n] = await notesFor('/quota');
    if (n.text === text) throw new Error('write unexpectedly succeeded while storage was full');
    await p.screenshot('quota-failed');
    await ext.eval(`chrome.storage.local.remove('filler').then(() => true)`);
    await sleep(3600); // retry interval is 3 s
    [n] = await notesFor('/quota');
    assertEq(n.text.length, text.length, 'stored text length after recovery');
    await p.screenshot('quota-recovered');
    await p.close();
  });

  // 9-12. Chrome shut down right after the last keystroke, then restarted.
  //   "quit"  = DevTools Browser.close: Chrome exits without giving pages a
  //             pagehide/visibilitychange (closest to Windows shutting down).
  //   "kill"  = process terminated, like a browser crash.
  //   "human" = one key every 40 ms (~300 words/min); "burst" = all keys at once,
  //             a worst case no real typist produces. Burst runs are informational.
  async function shutdownAfterTyping(slug, mode, burst) {
    const p = await browser.newPage(`${base}/${slug}`);
    await p.waitForTabNotes();
    await p.newNote();
    await sleep(100);
    const text = slug + ' ' + longText(60);
    if (burst) await p.typeFast(text);
    else await p.typeHuman(text, 40);
    if (mode === 'quit') await browser.close();
    else await browser.kill();
    browser = await Browser.launch(profile);
    await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
    await openExtPage();
    const [n] = await notesFor('/' + slug);
    const got = n ? n.title.length : 0;
    return { complete: got === text.length, summary: `${got}/${text.length} chars survived` };
  }

  await check('Chrome quit right after human-speed typing', async () => {
    const r = await shutdownAfterTyping('quit-human', 'quit', false);
    if (!r.complete) throw new Error(r.summary);
    return r.summary;
  });
  await check('Chrome killed right after human-speed typing', async () => {
    const r = await shutdownAfterTyping('kill-human', 'kill', false);
    if (!r.complete) throw new Error(r.summary);
    return r.summary;
  });
  await check('Chrome quit right after a burst of keystrokes (informational)', async () =>
    (await shutdownAfterTyping('quit-burst', 'quit', true)).summary);
  await check('Chrome killed right after a burst of keystrokes (informational)', async () =>
    (await shutdownAfterTyping('kill-burst', 'kill', true)).summary);

  await browser.close();
  site.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (_) {
    /* Chrome may still hold files briefly */
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
