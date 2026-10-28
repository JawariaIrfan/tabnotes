# TabNotes

**Sticky notes that stay attached to web pages.** Put a note on any website, close
the tab, restart Chrome or your computer, and the note is waiting when you come back.

- Free, no account, no sign-up
- Works offline; nothing is ever sent anywhere. Notes are stored only in your
  browser on this device (`chrome.storage.local`)
- No ads, analytics, tracking, remote code, or third-party libraries
- Chrome Manifest V3, plain JavaScript/HTML/CSS

## Features

- **Notes on any website.** A small yellow button in the bottom-right corner creates a note.
- **Title, text and checklist** in every note.
- **Several notes per page.**
- **Move and resize.** Drag a note by its header, resize from the bottom-right corner.
- **Minimize, hide, delete.** Collapse a note to its title bar, hide all notes on
  a page temporarily, or delete a note (with confirmation).
- **This page or whole site.** Each note can belong to one page or to every page
  of a website.
- **Instant auto-save.** Every keystroke and change is written immediately. Each
  note shows *Saving…*, *Saved*, or *Save failed*.
- **Comes back automatically** when you revisit the page, after closing tabs or
  restarting Chrome or Windows.
- **Works in single-page apps** (GitHub, YouTube, Gmail-style sites) that change
  pages without a full reload.
- **Toolbar popup.** Note count for the current page, new note, hide/show, settings.
- **All notes page.** Search every note by title, text, checklist item or URL; open
  or delete notes.
- **Keyboard accessible**, with shortcuts, screen-reader labels, and reduced-motion support.

## Installation

TabNotes isn't on the Chrome Web Store. You install it from the release ZIP, which
takes about a minute.

1. Download **`TabNotes-v1.0.0.zip`** from the **Releases** page of this repository.
2. Create a permanent folder for it, for example `C:\Users\<you>\Documents\TabNotes`.
3. Extract the ZIP into that folder: right-click the ZIP → **Extract All…** → choose
   the folder. `manifest.json` should end up directly inside it.
4. In Chrome, go to `chrome://extensions`.
5. Turn on **Developer mode** (top-right).
6. Click **Load unpacked** and select the folder from step 2.
7. Optional: click the puzzle-piece icon in the toolbar and pin **TabNotes**.
8. Refresh tabs that were already open (F5). TabNotes only appears in pages loaded
   after installation.

> **Keep the folder where it is.** Chrome loads the extension from this folder on
> every start, and links your notes to the folder's location. If you move or
> delete the folder, the extension stops loading; reinstalling it from a different
> folder starts with an empty set of notes.

Chrome will say the extension can *"read and change all your data on all
websites"*. This is needed so notes can appear by themselves on any page you
revisit. TabNotes only reads the page address to find matching notes. It doesn't
read page content and has no network access.

Microsoft Edge, Brave and other Chromium browsers (version 111+) work the same way
(`edge://extensions`, `brave://extensions`).

## Usage

| What | How |
| --- | --- |
| New note | Yellow button at the bottom-right of the page, the toolbar popup, or **Alt+Shift+N** |
| Move | Drag the header. Keyboard: Tab to the ⋮⋮ grip, then arrow keys (Shift = bigger steps) |
| Resize | Drag the bottom-right corner. Keyboard: Tab to the corner handle, then arrow keys |
| Edit title | Click the title |
| Checklist | Type in *+ Add checklist item*, press Enter. In an item: Enter adds the next item, Backspace on an empty item removes it |
| Page or site | Click *This page only* / *Whole site* in the note footer |
| Minimize / restore | The – / ^ button, or double-click empty header space |
| Hide all notes on the page | Eye button beside the yellow button, the popup, or **Alt+Shift+H** (until reload) |
| Hide the yellow button | Untick *Show floating note button* in the popup |
| Delete | Trash icon, then *Delete?* within 4 seconds (Esc cancels) |
| See all notes | Popup → **Manage all notes**, or right-click the toolbar icon → **Options** |

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **Alt+Shift+N** | New note on the current page |
| **Alt+Shift+H** | Hide / show notes on the current page |

If another extension already uses one of these, Chrome leaves it unassigned. You
can set or change shortcuts at `chrome://extensions/shortcuts`.

### Which pages share a note

- `http://` and `https://` versions of a page share notes.
- `#section` anchors are ignored, but app routes like `#/inbox` count as separate pages.
- Tracking parameters (`utm_*`, `fbclid`, `gclid` and similar) are ignored. Other
  parameters matter, so `?q=cats` and `?q=dogs` have separate notes.
- *Whole site* notes match the same host with or without `www.`. Subdomains such as
  `docs.example.com` count as separate sites.

## Updating to a new version

Your notes are kept when you update **in place**:

1. Download the new release ZIP.
2. Extract it **into the same folder** you installed from, replacing the old files.
3. Go to `chrome://extensions` and click the **Reload** arrow on the TabNotes card.
4. Refresh open tabs. A page left open during the update shows a message asking you
   to refresh it before it can save again.

Don't remove the extension to update it. Removing it deletes its stored notes.

## Limitations

- **Saving is immediate, but not magic.** Each change is handed to Chrome within
  milliseconds, and closing a tab doesn't interrupt it. Chrome makes no durability
  promise for a sudden power cut, OS crash or forced shutdown, so the last
  keystrokes from the final moment before such an event can be lost.
- Notes don't run on browser pages (`chrome://`, the new-tab page, the Chrome Web
  Store), `file://` pages, Chrome's PDF viewer, or inside iframes.
- Notes are stored per browser profile on this device. There's no sync between
  computers, and no backup or export yet.
- Storage holds about 10 MB in total (thousands of notes). Each note is limited to
  a 200-character title, 20,000 characters of text and 200 checklist items.
- Note positions are relative to the browser window and are pulled back into view
  on smaller windows.
- Uninstalling the extension, or reinstalling it from a different folder, means your
  existing notes are no longer available to it.
- "Hide all notes" lasts until the page is reloaded.

## Privacy

TabNotes collects nothing. It has no server, makes no network requests, and its
only extension permission is `storage`. Note text, checklist items, the page
address, and the note's position are saved in your browser's extension storage
on your computer and nowhere else.

## For developers

```
tabnotes/          the extension itself (load this folder unpacked while developing)
scripts/build.js   builds dist/TabNotes-v<version>/ and dist/TabNotes-v<version>.zip
tests/             unit tests and a real-Chrome end-to-end test
TESTING.md         manual test checklist
CHANGELOG.md       release notes
```

Everything needs only [Node.js](https://nodejs.org) 18 or newer. There are no npm
packages to install.

```
node --test tests/saver.test.js tests/common.test.js
node tests/e2e-chrome.js
node scripts/build.js
```

- The unit tests cover the save queue (ordering, status, failures and retries,
  deletion) and URL matching.
- The end-to-end test starts a separate headless Chrome with a temporary profile
  (your own browser and notes are not touched), loads the extension, and checks
  persistence after closing tabs, navigating, quitting Chrome and more. Set
  `CHROME_PATH` to use a different Chromium browser, or `TABNOTES_EXT_DIR` to test
  an extracted release package.
- The build copies only the files listed in `scripts/build.js` and fails if a file
  referenced by the manifest is missing, an unlisted file is present, or a remote
  URL appears in the code. It also reads the ZIP back to verify it.

To release a new version: bump `version` in `tabnotes/manifest.json`, add a
`CHANGELOG.md` entry, run the tests, run the build, and attach
`dist/TabNotes-v<version>.zip` to a GitHub release.
