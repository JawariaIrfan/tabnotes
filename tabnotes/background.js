// Keyboard shortcuts only. Notes are created and stored by the content script.
'use strict';

const COMMAND_MESSAGES = {
  'new-note': 'tabnotes:new',
  'toggle-notes': 'tabnotes:toggle'
};

chrome.commands.onCommand.addListener(async (command) => {
  const type = COMMAND_MESSAGES[command];
  if (!type) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    // No content script on this tab (chrome:// page, Web Store, or page opened
    // before the extension was installed). Nothing to do.
  }
});
