// Keyboard isolation for the TabNotes UI. Runs at document_start, before any
// page script, so its window capture-phase listeners are the first to see each
// keyboard, IME and clipboard event.
//
// Why: inside the note UI's (closed) shadow root, the page sees every event as
// coming from the <tabnotes-ui> host element, and document.activeElement is
// that host, which does not look editable. Global handlers on the page (site
// shortcuts, "type anywhere to focus the composer", paste interceptors) would
// therefore act on keystrokes meant for a note, before TabNotes ever saw them.
//
// What: only events whose target is the TabNotes host are affected. The page's
// handlers for them are skipped; keyboard events are replayed inside the note UI
// so TabNotes' own key handling still runs. Nothing is prevented by default, so
// typing, selection, copy/paste, undo/redo and IME composition work normally.
// Events anywhere else on the page are never touched.
(function () {
  'use strict';
  if (window.top !== window || globalThis.TabNotesKeyGuard) return;

  const REPLAYED = ['keydown', 'keypress', 'keyup'];
  const SHIELDED = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'copy', 'cut', 'paste'];

  // True when registered before the page's own scripts ran (the normal case).
  // False when injected into an already-loaded page, where earlier page
  // listeners on window still run first.
  const early = document.readyState === 'loading';

  let host = null;
  let replay = null;
  let outsidePointerAt = 0;

  const fromNotes = (e) => host !== null && e.target === host;

  for (const type of REPLAYED) {
    window.addEventListener(type, (e) => {
      if (!fromNotes(e)) return;
      e.stopImmediatePropagation();
      if (replay) replay(e);
    }, true);
  }
  for (const type of SHIELDED) {
    window.addEventListener(type, (e) => {
      if (fromNotes(e)) e.stopImmediatePropagation();
    }, true);
  }
  // Remember real clicks/taps outside the notes: focus leaving a note right
  // after one is the user's choice, not the page taking focus.
  window.addEventListener('pointerdown', (e) => {
    if (e.isTrusted && !fromNotes(e)) outsidePointerAt = Date.now();
  }, true);

  globalThis.TabNotesKeyGuard = Object.freeze({
    early,
    /** Called by content.js with its host element and a function that replays a key event inside the UI. */
    attach(el, fn) {
      host = el;
      replay = fn;
    },
    detach(el) {
      if (host === el) {
        host = null;
        replay = null;
      }
    },
    pointerOutsideWithin(ms) {
      return Date.now() - outsidePointerAt < ms;
    }
  });
})();
