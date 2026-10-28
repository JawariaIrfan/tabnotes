// Decides whether TabNotes is running in a tab, and (re)injects it when a
// supported page never received the content script: tabs that were already
// open when the extension was installed/updated/reloaded, and pages whose
// manifest injection was missed during browser startup or session restore.
//
// Used by the background service worker (injection) and the popup (status).
// No browser globals are touched at load time, so it can be unit tested in Node
// with a fake `api` object shaped like `chrome`.
(function (root) {
  'use strict';

  // Must match manifest.json "content_scripts" (checked by tests/readiness.test.js):
  // the page-world history hook, then the isolated document_start keyboard
  // guard, then the isolated document_idle content script.
  const MAIN_WORLD_FILES = ['nav-hook.js'];
  const ISOLATED_FILES = ['keyguard.js', 'common.js', 'saver.js', 'content.js'];

  const STATE = Object.freeze({
    LOADING: 'loading', // supported page; TabNotes not answering yet
    READY: 'ready', // content script answered with its status
    UNSUPPORTED: 'unsupported', // browser-internal or restricted page
    FAILED: 'failed' // supported page, but TabNotes could not be started
  });

  /** http(s) pages except the Chrome Web Store, where extensions are blocked. */
  function isSupportedPageUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'chromewebstore.google.com') return false;
    if (host === 'chrome.google.com' && /^\/webstore(\/|$)/.test(u.pathname)) return false;
    return true;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  /** Resolves the content script's answer, or null if nothing (alive) answered in time. */
  async function ask(api, tabId, type, timeoutMs) {
    try {
      const res = await withTimeout(api.tabs.sendMessage(tabId, { type }), timeoutMs);
      return res && res.ok ? res : null;
    } catch (_) {
      return null; // "Receiving end does not exist", port closed, or timeout
    }
  }

  const ping = (api, tabId, timeoutMs = 500) => ask(api, tabId, 'tabnotes:ping', timeoutMs);

  /** Tab URL as far as Chrome reveals it (only for pages we have host access to). */
  function tabUrl(tab) {
    return (tab && (tab.url || tab.pendingUrl)) || '';
  }

  // One injection per tab at a time within this JS context (the service worker).
  const inFlight = new Map();

  /**
   * Makes sure the content script runs in a loaded, supported tab.
   * Returns 'present' | 'injected' | 'skipped'. Throws if injection fails.
   * Injecting twice is harmless: content.js steps aside if a live copy exists.
   */
  function ensureInjected(api, tab) {
    if (!tab || tab.id == null) return Promise.resolve('skipped');
    if (tab.discarded || tab.status !== 'complete' || !isSupportedPageUrl(tabUrl(tab))) {
      return Promise.resolve('skipped'); // loading pages get the manifest script themselves
    }
    if (inFlight.has(tab.id)) return inFlight.get(tab.id);
    const job = (async () => {
      if (await ping(api, tab.id)) return 'present';
      // Same order as the manifest: page-world history hook first, then the content script.
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: MAIN_WORLD_FILES, world: 'MAIN' });
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ISOLATED_FILES });
      return 'injected';
    })().finally(() => inFlight.delete(tab.id));
    inFlight.set(tab.id, job);
    return job;
  }

  /**
   * Popup-side readiness handshake with a bounded wait. Reports every state
   * change through onState and resolves with the final one:
   *   { state: 'ready', status } | { state: 'unsupported' } | { state: 'failed', reason }
   * A missing receiver never counts as "unsupported": only the URL decides that.
   */
  async function resolvePageState(api, tabId, opts = {}) {
    const deadlineMs = opts.deadlineMs == null ? 10000 : opts.deadlineMs;
    const pollMs = opts.pollMs == null ? 250 : opts.pollMs;
    const statusTimeoutMs = opts.statusTimeoutMs == null ? 1500 : opts.statusTimeoutMs;
    const requestInjection = opts.requestInjection || ((tab) => ensureInjected(api, tab));
    const onState = opts.onState || (() => {});
    const started = Date.now();
    let reported = null;
    let injectionAsked = false;
    let lastProblem = 'TabNotes did not respond.';
    const report = (state) => {
      if (state !== reported) onState((reported = state));
    };

    while (Date.now() - started < deadlineMs) {
      let tab;
      try {
        tab = await api.tabs.get(tabId);
      } catch (_) {
        return { state: STATE.FAILED, reason: 'The tab was closed.' };
      }
      const url = tabUrl(tab);
      const loading = tab.discarded || tab.status !== 'complete';

      if (url && !isSupportedPageUrl(url)) {
        report(STATE.UNSUPPORTED);
        return { state: STATE.UNSUPPORTED };
      }
      if (!url) {
        // Chrome hides the URL of pages TabNotes has no access to (chrome://, file://...).
        // A supported page always exposes its URL, so once loaded, this is final.
        if (!loading) {
          report(STATE.UNSUPPORTED);
          return { state: STATE.UNSUPPORTED };
        }
        report(STATE.LOADING);
        await sleep(pollMs);
        continue;
      }

      report(STATE.LOADING);
      const status = await ask(api, tabId, 'tabnotes:status', loading ? Math.min(400, statusTimeoutMs) : statusTimeoutMs);
      if (status) {
        report(STATE.READY);
        return { state: STATE.READY, status };
      }
      if (loading) {
        // Restored, discarded or still-loading tab: the manifest script arrives at document_idle.
        await sleep(pollMs);
        continue;
      }
      if (await ping(api, tabId, 300)) {
        // Running but still reading notes from storage (slow startup): keep waiting.
        lastProblem = 'TabNotes is running but did not finish loading notes.';
        await sleep(pollMs);
        continue;
      }
      if (!injectionAsked) {
        injectionAsked = true;
        try {
          await requestInjection(tab);
        } catch (err) {
          const reason = 'Chrome did not allow TabNotes to start on this page: ' + ((err && err.message) || err);
          report(STATE.FAILED);
          return { state: STATE.FAILED, reason };
        }
        continue;
      }
      await sleep(pollMs);
    }
    return { state: STATE.FAILED, reason: lastProblem };
  }

  root.TabNotesReadiness = Object.freeze({
    STATE,
    MAIN_WORLD_FILES,
    ISOLATED_FILES,
    isSupportedPageUrl,
    ping,
    ensureInjected,
    resolvePageState
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TabNotesReadiness;
})(typeof globalThis !== 'undefined' ? globalThis : this);
