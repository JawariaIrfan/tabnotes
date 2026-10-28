// Runs in the page's MAIN world so it can see the page's own history.pushState /
// replaceState calls (the isolated content-script world cannot). It only emits a
// DOM event; it never reads or sends page data.
(() => {
  'use strict';
  if (window.__tabNotesNavHook) return;
  Object.defineProperty(window, '__tabNotesNavHook', { value: true });

  const notify = () => {
    try {
      window.dispatchEvent(new Event('tabnotes:locationchange'));
    } catch (_) {
      /* ignore */
    }
  };

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  }
})();
