# Changelog

## Unreleased

### Fixed

- After Chrome started or restored tabs, the popup could say "TabNotes can't run
  on this page" on normal websites until the page was refreshed. The popup now
  waits for the page with a bounded readiness check and shows *Loading TabNotes…*,
  *TabNotes ready*, *Unsupported page*, or *Unable to initialize TabNotes*.
  Only the page address decides whether a page is unsupported.
- Tabs that were already open when TabNotes was installed, updated or reloaded,
  restored tabs that missed the content script, and reactivated discarded tabs
  now get TabNotes automatically, without a refresh.
- After an update or reload, the old copy of TabNotes left in open pages no longer
  leaves a second, non-working button behind.
- On sites with global keyboard handling (ChatGPT, Gmail, Notion and similar),
  typing in a note could go to the site instead (for example into ChatGPT's message
  box) or trigger site shortcuts. Keyboard, paste and IME events from notes now
  reach only the note, and a note field keeps focus if the site tries to take it
  back without you clicking elsewhere.

### Changed

- New permissions: `scripting`, and host access to `http`/`https` pages (the same
  pages the content script already ran on). Chrome shows the same single warning
  as before.
- Keyboard shortcuts also start TabNotes on a tab that doesn't have it yet.

## 1.0.0

First public release.

- Sticky notes on any http/https page, with title, text and checklist
- Several notes per page; drag, resize, minimize, hide, delete
- Per-note scope: this page only, or the whole site
- Instant auto-save to `chrome.storage.local` with Saving… / Saved / Save failed status
- Notes reappear after closing tabs and restarting Chrome or the computer
- Single-page-app navigation support (pushState, replaceState, back/forward, hash routes)
- Toolbar popup and a searchable "All notes" page
- Keyboard shortcuts: Alt+Shift+N (new note), Alt+Shift+H (hide/show)
- No network access, accounts, analytics or third-party code
