// Service worker: keyboard shortcuts, and making sure TabNotes is running in
// every loaded http(s) tab. Chrome only injects manifest content scripts into
// pages that load *after* the extension is ready, so tabs that were already
// open at install/update/reload time, or whose injection was missed during
// startup or session restore, are fixed up here.
'use strict';

importScripts('readiness.js');
const R = self.TabNotesReadiness;

const COMMAND_MESSAGES = {
  'new-note': 'tabnotes:new',
  'toggle-notes': 'tabnotes:toggle'
};

function heal(tab) {
  return R.ensureInjected(chrome, tab).catch(() => 'failed');
}

async function healAllTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  await Promise.all(tabs.map(heal)); // discarded / loading / unsupported tabs are skipped
}

chrome.runtime.onInstalled.addListener(healAllTabs); // install, update, reload
chrome.runtime.onStartup.addListener(healAllTabs); // browser start with restored tabs

// A tab finished loading (including restored and reactivated discarded tabs):
// the manifest script should be there; inject only if it is not.
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status === 'complete') heal(tab);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(heal, () => {});
});
chrome.tabs.onReplaced.addListener((tabId) => {
  chrome.tabs.get(tabId).then(heal, () => {});
});

// The popup asks for injection here so concurrent popups share one attempt.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tabnotes:ensure' || sender.id !== chrome.runtime.id) return undefined;
  // Only TabNotes' own pages (the popup), not content scripts running in websites.
  if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) return undefined;
  chrome.tabs
    .get(msg.tabId)
    .then((tab) => R.ensureInjected(chrome, tab))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
    );
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const type = COMMAND_MESSAGES[command];
  if (!type) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) return;
    await heal(tab); // a restored tab may not have TabNotes yet
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    // Unsupported page (chrome://, Web Store) or a tab that is still loading.
  }
});
