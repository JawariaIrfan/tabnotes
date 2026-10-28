# TabNotes – manual test checklist

Load the extension first (see README → Installation). Use normal websites, e.g.
`https://example.com`, `https://en.wikipedia.org/wiki/Sticky_note`, and an SPA such as
`https://github.com` (clicking around repo tabs) or `https://www.youtube.com`.

Tip: to inspect stored data, open `chrome://extensions`, click **service worker**
on the TabNotes card, and run `chrome.storage.local.get(null).then(console.log)`
in the console that opens.

Many of the checks below are also automated. See README → For developers
(`node --test tests/saver.test.js tests/common.test.js tests/readiness.test.js`,
`node tests/e2e-chrome.js` and `node tests/e2e-startup.js`).
This checklist covers what automation can't: your real profile, real sites, the
real toolbar popup, keyboard shortcuts, and how things look.

## 1. Basics
- [ ] On `https://example.com`, a small yellow button appears in the bottom-right corner.
- [ ] Clicking it creates a yellow note near the top-right; the title field has focus.
- [ ] Type a title, some multi-line text. Footer shows "Saving…" while typing and "Saved"
      within a moment of the last keystroke.
- [ ] The floating button badge shows `1`.
- [ ] Page styles are unaffected and the note looks the same on several different sites.

## 1b. Startup, restored and discarded tabs
Set Chrome to **Settings → On startup → Continue where you left off** for these.
- [ ] Open 3 websites with notes in separate tabs, quit Chrome (Ctrl+Shift+Q), start it
      again. Without refreshing, the active tab shows the yellow button and its notes.
- [ ] Immediately after Chrome starts, click the TabNotes toolbar icon. The popup shows
      "Loading TabNotes…" briefly, then "TabNotes ready" with the right note count.
      It never says "Unsupported page" on a normal website.
- [ ] Switch to each restored background tab: the button and notes appear without a refresh.
- [ ] Open `chrome://discards`, click **Urgent discard** on a background tab with notes,
      then switch to that tab: it reloads and shows the button and notes.
- [ ] Open the popup on `chrome://extensions`, the new-tab page, and the Chrome Web
      Store: it says "Unsupported page".
- [ ] With some websites open, click **Reload** for TabNotes on `chrome://extensions`, then
      go back to those tabs: each has exactly one button that works, with no refresh.
- [ ] Press Alt+Shift+N on a tab restored at startup: a note is created.

## 2. Persistence
- [ ] Refresh the page (F5): the note reappears with the same title, text, position, size.
- [ ] Close the tab, reopen `https://example.com`: the note is there.
- [ ] Fully quit Chrome (⋮ menu → Exit), reopen it, visit the page: the note is there.
- [ ] Restart Windows, open Chrome, visit the page: the note is there.
- [ ] Type a sentence and immediately refresh (F5 straight after the last key): the text was saved.
- [ ] Type a sentence and immediately close the tab (Ctrl+W straight after the last key),
      reopen the page: the whole sentence is there.
- [ ] Type a sentence and immediately quit Chrome (Ctrl+Shift+Q): after restarting, it's there.
- [ ] Drag a note and press Ctrl+W while still holding the mouse button: on reopen, the
      note is where it was when the tab closed.

## 3. Different URLs / matching
- [ ] `https://example.com/?utm_source=x&fbclid=y` shows the example.com note (tracking params ignored).
- [ ] `https://example.com/#section` shows the same note (fragment ignored).
- [ ] `http://example.com` shows the same note (scheme ignored).
- [ ] On Wikipedia, a note on `/wiki/Sticky_note` does **not** appear on `/wiki/Post-it_Note`.
- [ ] A page with a meaningful query (e.g. `https://www.google.com/search?q=cats` vs `?q=dogs`)
      keeps separate notes.
- [ ] Click the footer pill to switch a note to **Whole site**: it now appears on every
      `en.wikipedia.org` page. Switch it back to **This page only** while on another page:
      it now belongs to that page.

## 4. Multiple notes
- [ ] Create 3 notes on one page: they cascade so none is fully hidden; badge shows `3`.
- [ ] Edit each one; refresh; all three come back with their own content.
- [ ] Clicking a note brings it to the front.
- [ ] The popup shows "3 notes on this page".

## 5. Drag and resize
- [ ] Drag a note by its header to another spot; refresh; it stays there.
- [ ] Try dragging off-screen: at least the header stays reachable.
- [ ] Resize from the bottom-right corner; refresh; the size is kept.
- [ ] Make the browser window small: notes are pulled back into view.
- [ ] Keyboard: Tab to the ⋮⋮ grip, press arrow keys (and Shift+arrows) to move it;
      Tab to the corner handle and use arrows to resize. Refresh: changes persisted.

## 6. Checklists
- [ ] Type in "+ Add checklist item", press Enter: an item appears and the input clears.
- [ ] Tick an item: it is struck through. Refresh: still ticked.
- [ ] Edit an item's text; refresh; edit is saved.
- [ ] In an item, Enter inserts a new item below and focuses it.
- [ ] Backspace in an empty item removes it and focuses the previous item.
- [ ] The × button removes an item; refresh confirms removal.

## 7. Minimize, hide, deletion
- [ ] Minimize a note: only the header shows. Refresh: still minimized. Restore it.
- [ ] Eye button / popup "Hide notes" / Alt+Shift+H hides all notes; again shows them.
- [ ] Untick "Show floating note button" in the popup: button disappears on all open pages;
      notes remain. Tick it again.
- [ ] Click trash: it turns into a red "Delete?" button; wait 4 s, it reverts.
- [ ] Click trash twice: note disappears. Refresh: it does not come back.
- [ ] In the popup → **Manage all notes**, delete a note (confirm dialog): it vanishes from
      the open page that shows it too.

## 8. Management page
- [ ] Lists all notes, newest first, with scope, URL, checklist progress.
- [ ] Searching a word from a title, text, checklist item or URL filters the list.
- [ ] URL link opens the page in a new tab, and the note is there.
- [ ] Editing a note in a tab updates the list automatically.

## 9. SPA navigation
- [ ] On GitHub, add a note on a repo's **Code** tab. Click **Issues** (no full reload):
      the note disappears. Click **Code** (or press Back): the note reappears, exactly once.
- [ ] Type in a note and, without waiting, click an in-app link to another route, then
      come back: the text is still there. Refresh: still there.
- [ ] Press Back/Forward repeatedly: no duplicate notes appear; badge count stays correct.
- [ ] A **Whole site** note stays visible while navigating between routes.
- [ ] On a hash-routed app (`.../#/route-a` → `#/route-b`), notes are per route; plain
      `#anchor` links on a normal page do not hide notes.

## 10. Multiple tabs
- [ ] Open the same page in two tabs. Edit the note in tab A, then switch to tab B:
      tab B shows the update (it is not being edited there).
- [ ] Delete a note in tab A: it disappears from tab B.

## 11. Unsupported pages and errors
- [ ] On `chrome://extensions` or the new tab page, there's no button; the popup says
      TabNotes can't run on this page.
- [ ] Open a page, reload the extension on `chrome://extensions`, type in a note on that
      page: a red message asks you to refresh; after refreshing, saving works.
- [ ] (Optional) Simulate a storage failure: in the service worker console run
      `chrome.storage.local.set({big: 'x'.repeat(10470000)})` to nearly fill the 10 MB quota
      (lower the number if that call itself fails), then paste a long block of text into a note and
      edit a note: it shows "Save failed" and a red toast. Run
      `chrome.storage.local.remove('big')`: the note saves on the next retry.

## 12. Accessibility
- [ ] Every control is reachable with Tab and has a visible focus ring.
- [ ] Screen reader (Narrator: Ctrl+Win+Enter) announces button names such as
      "Minimize note", "Delete note", "Move note…".
- [ ] Typing in a note on YouTube or GitHub doesn't trigger site shortcuts (e.g. `k`, `s`, `/`).
- [ ] With Windows "Show animations" turned off, notes appear without animation.
