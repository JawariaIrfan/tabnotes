// Shared helpers for the real-Chrome tests: a tiny DevTools-protocol client over
// --remote-debugging-pipe (Node built-ins only), a local test site, and a
// minimal pass/fail reporter.
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// TABNOTES_EXT_DIR lets the same test run against an unpacked release package.
const EXT_DIR = path.resolve(process.env.TABNOTES_EXT_DIR || path.join(__dirname, '..', '..', 'tabnotes'));
const SHOTS_DIR = process.env.E2E_SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny CDP client over --remote-debugging-pipe -------------------------

class Browser {
  /** `extraArgs` are added before the start URLs; `urls` replaces the default about:blank. */
  static async launch(profile, { extraArgs = [], urls = ['about:blank'] } = {}) {
    const args = [
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1200,800',
      ...extraArgs,
      ...urls
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
      // A stalled DevTools call fails the scenario instead of hanging the whole run.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(method + ': no answer from Chrome within 20 s'));
      }, 20000);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
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
    let done = false;
    let listener;
    const loaded = new Promise((resolve) => {
      listener = (m) => {
        if (m.sessionId === this.sessionId && m.method === 'Page.loadEventFired') resolve();
      };
      this.browser.listeners.push(listener);
    });
    // Chrome occasionally drops loadEventFired when a tab switches process (e.g.
    // about:blank -> chrome-extension://), so also poll the page's own state.
    const polled = (async () => {
      const deadline = Date.now() + 30000;
      while (!done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        const state = await Promise.race([
          this.eval('[document.readyState, location.href, !!window.__cdpOldDocument]').catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 1000))
        ]);
        if (state && state[0] === 'complete' && state[1] !== 'about:blank' && !state[2]) return;
      }
      if (!done) throw new Error('page did not finish loading: ' + url);
    })();
    try {
      // Mark the current document so polling only accepts the newly loaded one.
      await this.eval('window.__cdpOldDocument = true').catch(() => {});
      await this.send('Page.navigate', { url });
      await Promise.race([loaded, polled]);
    } finally {
      done = true;
      this.browser.listeners.splice(this.browser.listeners.indexOf(listener), 1);
    }
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

/** Serves a small page for every path. `handler(req, res)` may take over a request by returning true. */
function startSite(handler) {
  const page = `<!doctype html><meta charset="utf-8"><title>TabNotes e2e</title>
    <h1>TabNotes e2e page</h1><p>Path: <span id="p"></span></p>
    <script>document.getElementById('p').textContent = location.pathname;</script>`;
  const server = http.createServer((req, res) => {
    if (handler && handler(req, res)) return;
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

module.exports = { Browser, Session, startSite, check, assertEq, results, sleep, CHROME, EXT_DIR, SHOTS_DIR };
