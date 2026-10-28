// Unit tests for tabnotes/readiness.js: the popup/content-script readiness
// handshake and the fallback injection, against a scripted fake `chrome` API.
// Run from the project root:  node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require(path.join(__dirname, '..', 'tabnotes', 'readiness.js'));

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const FAST = { pollMs: 20, statusTimeoutMs: 150 };

/**
 * A fake tab + content script. `page.script` is null until TabNotes runs in the
 * page; it then answers ping at once and status once notes have loaded.
 */
function fakeChrome(tab, opts = {}) {
  const page = {
    script: opts.scriptPresent ? { loadedAt: Date.now() + (opts.notesLoadDelay || 0) } : null,
    closed: false
  };
  const calls = { sendMessage: [], executeScript: [] };
  const api = {
    tabs: {
      async get(id) {
        if (page.closed || id !== tab.id) throw new Error('No tab with id: ' + id);
        return { ...tab };
      },
      sendMessage(id, msg) {
        calls.sendMessage.push(msg.type);
        if (!page.script) return Promise.reject(new Error(NO_RECEIVER));
        if (msg.type === 'tabnotes:ping') return Promise.resolve({ ok: true, loaded: Date.now() >= page.script.loadedAt });
        const wait = Math.max(0, page.script.loadedAt - Date.now());
        return new Promise((r) => setTimeout(() => r({ ok: true, count: 2, hidden: false, siteKey: 'example.com' }), wait));
      }
    },
    scripting: {
      async executeScript(details) {
        calls.executeScript.push({ files: details.files, world: details.world || 'ISOLATED' });
        await new Promise((r) => setTimeout(r, 5));
        if (opts.injectError) throw new Error(opts.injectError);
        if (details.files.includes('content.js') && !opts.injectedScriptSilent) {
          page.script = { loadedAt: Date.now() + (opts.notesLoadDelay || 0) };
        }
        return [{ result: undefined }];
      }
    }
  };
  /** Runs fn(tab, page) after ms milliseconds, to script how the tab changes. */
  const at = (ms, fn) => setTimeout(() => fn(tab, page), ms);
  return { api, tab, page, calls, at };
}

const run = (api, tabId, extra = {}) => {
  const states = [];
  return R.resolvePageState(api, tabId, { ...FAST, deadlineMs: 3000, ...extra, onState: (s) => states.push(s) })
    .then((result) => ({ result, states }));
};

// ---- URL classification -------------------------------------------------------

test('unsupported URLs are recognised; normal websites are supported', () => {
  for (const url of [
    'chrome://extensions/', 'chrome://newtab/', 'chrome-extension://abc/popup.html', 'edge://settings',
    'about:blank', 'file:///C:/notes.html', 'view-source:https://example.com', 'data:text/html,hi',
    'devtools://devtools/bundled/inspector.html', 'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/category/extensions', '', 'not a url'
  ]) {
    assert.equal(R.isSupportedPageUrl(url), false, url);
  }
  for (const url of [
    'https://example.com/', 'http://localhost:3000/app', 'https://chrome.google.com/intl/en/chrome/',
    'https://www.google.com/search?q=webstore', 'https://github.com/a/b#readme'
  ]) {
    assert.equal(R.isSupportedPageUrl(url), true, url);
  }
});

test('unsupported page: answered from the URL, no messaging or injection attempted', async () => {
  const f = fakeChrome({ id: 1, status: 'complete', url: 'chrome://settings/' });
  const { result, states } = await run(f.api, 1);
  assert.equal(result.state, 'unsupported');
  assert.deepEqual(states, ['unsupported']);
  assert.equal(f.calls.sendMessage.length + f.calls.executeScript.length, 0);
});

test('page whose URL Chrome hides (no host access) is unsupported once loaded', async () => {
  const f = fakeChrome({ id: 1, status: 'complete' });
  const { result } = await run(f.api, 1);
  assert.equal(result.state, 'unsupported');
  assert.equal(f.calls.executeScript.length, 0);
});

test('a missing receiver on a supported page is never reported as unsupported', async () => {
  const f = fakeChrome({ id: 1, status: 'complete', url: 'https://example.com/' });
  const { result, states } = await run(f.api, 1);
  assert.equal(result.state, 'ready');
  assert.ok(!states.includes('unsupported'));
});

// ---- startup / restore / discard ----------------------------------------------

test('cold startup: popup opened while the restored page loads waits for the manifest script', async () => {
  const f = fakeChrome({ id: 7, status: 'loading', pendingUrl: 'https://example.com/a', url: '' });
  f.at(120, (tab) => {
    tab.url = 'https://example.com/a';
  });
  f.at(250, (_tab, page) => {
    page.script = { loadedAt: Date.now() + 30 }; // document_idle: content.js starts
  });
  f.at(320, (tab) => {
    tab.status = 'complete';
  });
  const { result, states } = await run(f.api, 7);
  assert.equal(result.state, 'ready');
  assert.deepEqual(states, ['loading', 'ready']);
  assert.equal(f.calls.executeScript.length, 0, 'no injection while the page was still loading');
});

test('popup opened before content.js initializes (page loading, no receiver yet)', async () => {
  const f = fakeChrome({ id: 2, status: 'loading', url: 'https://example.com/slow' });
  f.at(400, (tab, page) => {
    page.script = { loadedAt: Date.now() };
    tab.status = 'complete';
  });
  const { result, states } = await run(f.api, 2);
  assert.equal(result.state, 'ready');
  assert.deepEqual(states, ['loading', 'ready']);
  assert.ok(f.calls.sendMessage.length >= 2, 'it retried');
  assert.equal(f.calls.executeScript.length, 0);
});

test('restored tab that never received the content script gets it injected in manifest order', async () => {
  const f = fakeChrome({ id: 3, status: 'complete', url: 'https://example.com/restored' });
  const { result } = await run(f.api, 3);
  assert.equal(result.state, 'ready');
  assert.deepEqual(f.calls.executeScript, [
    { files: ['nav-hook.js'], world: 'MAIN' },
    { files: ['keyguard.js', 'common.js', 'saver.js', 'content.js'], world: 'ISOLATED' }
  ]);
});

test('restored background tab: the service-worker path injects only when the script is missing', async () => {
  const missing = fakeChrome({ id: 4, status: 'complete', url: 'https://example.com/bg' });
  assert.equal(await R.ensureInjected(missing.api, missing.tab), 'injected');
  const present = fakeChrome({ id: 5, status: 'complete', url: 'https://example.com/bg' }, { scriptPresent: true });
  assert.equal(await R.ensureInjected(present.api, present.tab), 'present');
  assert.equal(present.calls.executeScript.length, 0);
});

test('discarded tab becoming active: waits for the reload instead of injecting', async () => {
  const f = fakeChrome({ id: 6, status: 'unloaded', discarded: true, url: 'https://example.com/d' });
  f.at(150, (tab) => {
    tab.discarded = false;
    tab.status = 'loading';
  });
  f.at(300, (tab, page) => {
    page.script = { loadedAt: Date.now() };
    tab.status = 'complete';
  });
  const { result, states } = await run(f.api, 6);
  assert.equal(result.state, 'ready');
  assert.deepEqual(states, ['loading', 'ready']);
  assert.equal(f.calls.executeScript.length, 0);
});

test('ensureInjected skips discarded, loading and unsupported tabs', async () => {
  for (const tab of [
    { id: 1, status: 'complete', discarded: true, url: 'https://example.com/' },
    { id: 2, status: 'loading', url: 'https://example.com/' },
    { id: 3, status: 'complete', url: 'chrome://newtab/' },
    { id: 4, status: 'complete', url: 'https://chromewebstore.google.com/' },
    { id: 5, status: 'complete' }
  ]) {
    const f = fakeChrome(tab);
    assert.equal(await R.ensureInjected(f.api, tab), 'skipped', JSON.stringify(tab));
    assert.equal(f.calls.executeScript.length, 0);
  }
});

// ---- timing ---------------------------------------------------------------------

test('delayed status responses: keeps waiting (no injection) while the script is alive', async () => {
  // Script present but notes take 500 ms to load; status answers only then.
  const f = fakeChrome({ id: 8, status: 'complete', url: 'https://example.com/' }, { scriptPresent: true, notesLoadDelay: 500 });
  const { result, states } = await run(f.api, 8);
  assert.equal(result.state, 'ready');
  assert.deepEqual(states, ['loading', 'ready']);
  assert.equal(f.calls.executeScript.length, 0, 'a slow answer is not a missing script');
});

test('repeated popup openings share one injection', async () => {
  const f = fakeChrome({ id: 9, status: 'complete', url: 'https://example.com/' });
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => run(f.api, 9)));
  assert.ok(outcomes.every((o) => o.result.state === 'ready'));
  const contentInjections = f.calls.executeScript.filter((c) => c.files.includes('content.js'));
  assert.equal(contentInjections.length, 1);
  // Opening again later finds the running script and injects nothing.
  await run(f.api, 9);
  assert.equal(f.calls.executeScript.filter((c) => c.files.includes('content.js')).length, 1);
});

test('injection refused by Chrome: reports "failed" right away with the reason', async () => {
  const f = fakeChrome({ id: 10, status: 'complete', url: 'https://example.com/' }, { injectError: 'Cannot access contents of the page.' });
  const t0 = Date.now();
  const { result, states } = await run(f.api, 10);
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /Cannot access contents/);
  assert.deepEqual(states, ['loading', 'failed']);
  assert.ok(Date.now() - t0 < 1000);
});

test('a script that never answers ends in "failed" after the bounded wait', async () => {
  const f = fakeChrome({ id: 11, status: 'complete', url: 'https://example.com/' }, { injectedScriptSilent: true });
  const t0 = Date.now();
  const { result } = await run(f.api, 11, { deadlineMs: 600 });
  assert.equal(result.state, 'failed');
  assert.ok(Date.now() - t0 < 1500, 'gave up within the deadline');
  assert.equal(f.calls.executeScript.filter((c) => c.files.includes('content.js')).length, 1, 'injected once, not in a loop');
});

test('tab closed while waiting: "failed", not "unsupported"', async () => {
  const f = fakeChrome({ id: 12, status: 'loading', url: 'https://example.com/' });
  f.at(80, (_tab, page) => {
    page.closed = true;
  });
  const { result } = await run(f.api, 12);
  assert.equal(result.state, 'failed');
});

// ---- consistency with the manifest ------------------------------------------------

test('injected file lists match manifest.json content_scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tabnotes', 'manifest.json'), 'utf8'));
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  // Isolated scripts in the order Chrome runs them: document_start before document_idle.
  const order = { document_start: 0, document_end: 1, document_idle: 2 };
  const isolated = manifest.content_scripts
    .filter((c) => !c.world || c.world === 'ISOLATED')
    .sort((a, b) => order[a.run_at || 'document_idle'] - order[b.run_at || 'document_idle'])
    .flatMap((c) => c.js);
  assert.deepEqual(R.MAIN_WORLD_FILES, main.js);
  assert.deepEqual(R.ISOLATED_FILES, isolated);
  assert.equal(R.ISOLATED_FILES[0], 'keyguard.js', 'keyboard guard is injected before the content script');
  assert.deepEqual(manifest.host_permissions, main.matches, 'host access equals content-script matches (no extra warning)');
  assert.ok(manifest.permissions.includes('scripting'));
});
