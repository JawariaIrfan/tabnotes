'use strict';

const C = globalThis.TabNotesCommon;
const R = globalThis.TabNotesReadiness;
const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  loading: 'Loading TabNotes…',
  ready: 'TabNotes ready',
  unsupported: 'Unsupported page',
  failed: 'Unable to initialize TabNotes'
};

let tabId = null;
let run = 0; // ignores results from an earlier "Try again" attempt

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function showState(state) {
  $('page-state').dataset.state = state;
  $('page-state').textContent = STATE_TEXT[state];
  $('loading').hidden = state !== 'loading';
  $('supported').hidden = state !== 'ready';
  $('unsupported').hidden = state !== 'unsupported';
  $('failed').hidden = state !== 'failed';
}

function render(status) {
  showState('ready');
  $('count').textContent = String(status.count);
  $('count-label').textContent = status.count === 1 ? 'note on this page' : 'notes on this page';
  $('site').textContent = status.siteKey;
  $('toggle').textContent = status.hidden ? 'Show notes on this page' : 'Hide notes on this page';
  $('toggle').setAttribute('aria-pressed', String(status.hidden));
}

function showFailed(reason) {
  showState('failed');
  $('failed-reason').textContent =
    (reason || 'TabNotes did not respond on this page.') + ' Reloading the page usually fixes this.';
}

/** Injection runs in the service worker so several open popups share one attempt. */
async function requestInjection() {
  const res = await chrome.runtime.sendMessage({ type: 'tabnotes:ensure', tabId });
  if (!res || !res.ok) throw new Error((res && res.error) || 'no response from TabNotes');
}

async function connect() {
  const mine = ++run;
  showState('loading');
  if (tabId == null) {
    showFailed('Could not find the current tab.');
    return;
  }
  const result = await R.resolvePageState(chrome, tabId, {
    requestInjection,
    onState: (state) => {
      if (mine === run && state !== 'ready') showState(state);
    }
  });
  if (mine !== run) return;
  if (result.state === 'ready') render(result.status);
  else if (result.state === 'unsupported') showState('unsupported');
  else showFailed(result.reason);
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

  connect();

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

$('retry').addEventListener('click', () => connect());

$('reload').addEventListener('click', async () => {
  try {
    await chrome.tabs.reload(tabId);
    connect();
  } catch (err) {
    showError('Could not reload the page: ' + C.describeError(err));
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
