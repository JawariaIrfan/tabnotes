'use strict';

const C = globalThis.TabNotesCommon;
const $ = (id) => document.getElementById(id);

let tabId = null;

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function render(status) {
  $('supported').hidden = false;
  $('unsupported').hidden = true;
  $('count').textContent = String(status.count);
  $('count-label').textContent = status.count === 1 ? 'note on this page' : 'notes on this page';
  $('site').textContent = status.siteKey;
  $('toggle').textContent = status.hidden ? 'Show notes on this page' : 'Hide notes on this page';
  $('toggle').setAttribute('aria-pressed', String(status.hidden));
}

function renderUnsupported() {
  $('supported').hidden = true;
  $('unsupported').hidden = false;
}

async function send(type) {
  return chrome.tabs.sendMessage(tabId, { type });
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
  } catch (_) {
    tabId = null;
  }

  if (tabId == null) {
    renderUnsupported();
  } else {
    try {
      const status = await send('tabnotes:status');
      if (status && status.ok && status.supported) render(status);
      else renderUnsupported();
    } catch (_) {
      // No content script answered: browser-internal page or page not reloaded.
      renderUnsupported();
    }
  }

  try {
    const settings = await C.getSettings();
    $('show-fab').checked = settings.showFab;
    const notes = await C.getAllNotes();
    $('total').textContent = '(' + notes.length + ' total)';
  } catch (err) {
    showError('Could not read saved notes: ' + C.describeError(err));
  }
}

$('new').addEventListener('click', async () => {
  try {
    await send('tabnotes:new');
    window.close(); // hand focus to the new note on the page
  } catch (err) {
    showError('Could not create a note: ' + C.describeError(err));
  }
});

$('toggle').addEventListener('click', async () => {
  try {
    render(await send('tabnotes:toggle'));
  } catch (err) {
    showError('Could not reach the page: ' + C.describeError(err));
  }
});

$('show-fab').addEventListener('change', async (e) => {
  try {
    await C.saveSettings({ showFab: e.target.checked });
  } catch (err) {
    e.target.checked = !e.target.checked;
    showError('Could not save the setting: ' + C.describeError(err));
  }
});

$('manage').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

init();
