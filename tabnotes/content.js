// TabNotes content script: renders sticky notes for the current page inside a
// closed Shadow DOM and persists every change to chrome.storage.local.
(() => {
  'use strict';

  if (window.top !== window) return;

  const C = globalThis.TabNotesCommon;
  const NoteSaver = globalThis.TabNotesSaver;
  if (!C || !NoteSaver) return;

  // ---- single instance ------------------------------------------------------
  // This script can reach a page more than once: from the manifest and from the
  // service worker's fallback injection, or again after the extension was
  // updated/reloaded (the old copy stays in the page, disconnected). A DOM event
  // crosses those isolated worlds: a *live* copy cancels it and this one quits;
  // a disconnected copy tears itself down instead.
  if (!document.dispatchEvent(new CustomEvent('tabnotes:claim', { cancelable: true }))) return;

  const life = new AbortController(); // removes every page listener on teardown
  const on = (target, type, fn, opts) => target.addEventListener(type, fn, { ...opts, signal: life.signal });
  const timers = [];

  on(document, 'tabnotes:claim', (e) => {
    if (contextAlive()) e.preventDefault();
    else teardown();
  });

  function teardown() {
    life.abort();
    timers.forEach(clearInterval);
    foreignUiObserver.disconnect();
    hostEl.remove();
  }

  // Copies from older versions cannot answer the claim, but leave their UI in
  // the page (and may re-add it). Only this copy's UI may exist.
  const foreignUiObserver = new MutationObserver(() => removeForeignUi());
  function removeForeignUi() {
    for (const other of document.querySelectorAll('tabnotes-ui')) {
      if (other !== hostEl) other.remove();
    }
  }

  const RETRY_DELAY_MS = 3000;
  const MIN_W = 200;
  const MIN_H = 140;
  const DEFAULT_W = 260;
  const DEFAULT_H = 240;
  const MIN_VISIBLE_X = 60; // px of a note that always stays on screen horizontally
  const HEADER_H = 36;

  const state = {
    href: location.href,
    keys: C.normalizeUrl(location.href),
    hidden: false,
    showFab: true,
    dead: false,
    topZ: 1,
    ready: Promise.resolve(),
    loaded: false // first load of notes from storage finished
  };

  /** id -> NoteView for every note seen in this tab (mounted or not). */
  const views = new Map();
  /** ids deleted in this tab, so an in-flight load cannot resurrect them. */
  const deletedIds = new Set();

  // ---- DOM helpers --------------------------------------------------------

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v);
      }
    }
    if (children) for (const c of children) if (c) e.append(c);
    return e;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    grip: ['M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01'],
    minimize: ['M6 12h12'],
    restore: ['M6 15l6-6 6 6'],
    trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
    x: ['M7 7l10 10M17 7L7 17'],
    note: ['M5 4h14v10l-6 6H5z', 'M13 20v-6h6', 'M9 9h6'],
    plus: ['M12 7v10M7 12h10'],
    eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    eyeOff: ['M3 3l18 18', 'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9', 'M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2']
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name]) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function setIcon(button, name) {
    button.textContent = '';
    button.append(icon(name));
  }

  function viewportW() {
    return document.documentElement.clientWidth || window.innerWidth;
  }

  function viewportH() {
    return document.documentElement.clientHeight || window.innerHeight;
  }

  function clampSize(w, h) {
    const maxW = Math.max(MIN_W, viewportW() - 16);
    const maxH = Math.max(MIN_H, viewportH() - 16);
    return {
      w: Math.round(Math.min(Math.max(w, MIN_W), maxW)),
      h: Math.round(Math.min(Math.max(h, MIN_H), maxH))
    };
  }

  function clampPos(x, y, w) {
    const vw = viewportW();
    const vh = viewportH();
    return {
      x: Math.round(Math.min(Math.max(x, MIN_VISIBLE_X - w), vw - MIN_VISIBLE_X)),
      y: Math.round(Math.min(Math.max(y, 0), Math.max(0, vh - HEADER_H)))
    };
  }

  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // ---- Shadow DOM root ----------------------------------------------------

  const hostEl = document.createElement('tabnotes-ui');
  hostEl.style.cssText =
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;' +
    'width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;';
  const shadow = hostEl.attachShadow({ mode: 'closed' });

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .layer {
      position: fixed; inset: 0; pointer-events: none;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #3a3214;
      --paper: #fff7c2; --paper-dark: #fcec9c; --edge: #e8d376; --ink-soft: #7a6a22;
      --focus: #8a5f00; --danger: #b3261e;
    }
    .layer.hidden .note { display: none; }
    button, input, textarea { font: inherit; color: inherit; }
    :focus { outline: none; }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

    .note {
      position: fixed; pointer-events: auto; display: flex; flex-direction: column;
      background: var(--paper); border: 1px solid var(--edge); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(70, 55, 0, .16), 0 1px 3px rgba(70, 55, 0, .14);
      overflow: hidden; animation: tn-pop .18s ease-out;
      transition: box-shadow .15s ease, width .15s ease, height .15s ease;
    }
    .note.dragging, .note.resizing { transition: none; box-shadow: 0 14px 34px rgba(70, 55, 0, .26); }
    .note.dragging { cursor: grabbing; }
    @keyframes tn-pop { from { opacity: 0; transform: translateY(4px) scale(.97); } }

    .header {
      display: flex; align-items: center; gap: 2px; padding: 3px 4px 3px 2px;
      background: var(--paper-dark); border-bottom: 1px solid var(--edge);
      cursor: grab; user-select: none; flex: none; min-height: ${HEADER_H}px;
    }
    .title {
      flex: 1; min-width: 0; border: 0; background: transparent; font-weight: 600;
      padding: 4px 6px; border-radius: 6px; text-overflow: ellipsis; cursor: grab;
    }
    .title:hover { background: rgba(255, 255, 255, .35); }
    .title:focus { background: rgba(255, 255, 255, .7); cursor: text; }
    .title::placeholder, textarea::placeholder, .add-input::placeholder { color: #a8974f; }

    .icon-btn {
      flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
      background: transparent; color: #5e4f12; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background-color .12s ease, color .12s ease;
    }
    .icon-btn:hover { background: rgba(80, 60, 0, .1); }
    .icon-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .grip { cursor: grab; }
    .grip svg { stroke-width: 3.2; }
    .del.confirm { width: auto; padding: 0 8px; background: var(--danger); color: #fff; font-size: 12px; font-weight: 600; }

    .body { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 4px; display: flex; flex-direction: column; gap: 6px; }
    .text {
      display: block; width: 100%; min-height: 54px; resize: none; overflow: hidden;
      border: 0; border-radius: 6px; background: transparent; padding: 4px; white-space: pre-wrap;
    }
    .text:focus { background: rgba(255, 255, 255, .5); }

    .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
    .item { display: flex; align-items: center; gap: 6px; padding-left: 4px; border-radius: 6px; }
    .item:hover, .item:focus-within { background: rgba(255, 255, 255, .4); }
    .item input[type="checkbox"] { flex: none; width: 15px; height: 15px; margin: 0; accent-color: #9a6c00; cursor: pointer; }
    .itext, .add-input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 3px 4px; border-radius: 4px; }
    .item.done .itext { text-decoration: line-through; color: var(--ink-soft); }
    .icon-btn.small { width: 22px; height: 22px; opacity: 0; }
    .icon-btn.small svg { width: 13px; height: 13px; }
    .item:hover .icon-btn.small, .item:focus-within .icon-btn.small { opacity: 1; }
    .add-input:focus { background: rgba(255, 255, 255, .6); }

    .footer {
      flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 3px 18px 4px 8px; font-size: 11px; color: var(--ink-soft);
    }
    .scope {
      min-width: 0; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      border: 1px solid var(--edge); background: rgba(255, 255, 255, .45); border-radius: 999px;
      padding: 1px 8px; font-size: 11px; cursor: pointer;
    }
    .scope:hover { background: rgba(255, 255, 255, .8); }
    .status { white-space: nowrap; transition: opacity .3s ease; }
    .status.error { color: var(--danger); font-weight: 600; }

    .resize {
      position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
      background: linear-gradient(135deg, transparent 50%, rgba(120, 95, 0, .35) 50%, transparent 58%,
        transparent 68%, rgba(120, 95, 0, .35) 68%, transparent 76%);
      border-bottom-right-radius: 10px;
    }

    .note.min .body, .note.min .footer, .note.min .resize { display: none; }
    .note.min .header { border-bottom: 0; }

    .fab-wrap {
      position: fixed; right: 16px; bottom: 16px; pointer-events: auto;
      display: flex; align-items: center; gap: 6px; opacity: .6; transition: opacity .15s ease;
      z-index: 2000000000;
    }
    .fab-mini[hidden] { display: none; }
    .fab-wrap:hover, .fab-wrap:focus-within { opacity: 1; }
    .fab-wrap.off { display: none; }
    .fab, .fab-mini {
      position: relative; border-radius: 50%; border: 1px solid #dcbf45; cursor: pointer;
      background: #ffe57a; color: #4a3d0c; display: inline-flex; align-items: center; justify-content: center;
      box-shadow: 0 3px 10px rgba(70, 55, 0, .25); transition: transform .12s ease, background-color .12s ease;
    }
    .fab { width: 40px; height: 40px; }
    .fab-mini { width: 30px; height: 30px; background: #fff6cc; }
    .fab:hover, .fab-mini:hover { transform: translateY(-1px); background: #ffdc4f; }
    .fab svg, .fab-mini svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .fab-mini svg { width: 15px; height: 15px; }
    .badge {
      position: absolute; top: -5px; right: -5px; min-width: 17px; height: 17px; padding: 0 4px;
      border-radius: 9px; background: #4a3d0c; color: #fff; font-size: 10px; font-weight: 700;
      line-height: 17px; text-align: center;
    }
    .badge:empty { display: none; }

    .toast {
      position: fixed; right: 16px; bottom: 68px; max-width: min(340px, calc(100vw - 32px));
      padding: 9px 12px; border-radius: 8px; background: #3a3214; color: #fff; font-size: 12.5px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .25); pointer-events: none; z-index: 2000000001;
      opacity: 0; transform: translateY(6px); transition: opacity .2s ease, transform .2s ease;
    }
    .toast.show { opacity: 1; transform: none; pointer-events: auto; }
    .toast.error { background: var(--danger); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  `;

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (_) {
    shadow.append(el('style', { text: CSS }));
  }

  const layer = el('div', { class: 'layer' });
  shadow.append(layer);

  // Keep keystrokes typed into notes from triggering the host page's shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    shadow.addEventListener(type, (e) => e.stopPropagation());
  }

  // ---- Floating button, toast --------------------------------------------

  const badge = el('span', { class: 'badge', 'aria-hidden': 'true' });
  const fab = el('button', { class: 'fab', type: 'button', title: 'New sticky note (Alt+Shift+N)' }, [icon('note'), badge]);
  const eyeBtn = el('button', { class: 'fab-mini', type: 'button', title: 'Hide notes on this page (Alt+Shift+H)' });
  const fabWrap = el('div', { class: 'fab-wrap' }, [eyeBtn, fab]);
  const toast = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  layer.append(fabWrap, toast);

  fab.addEventListener('click', () => newNote());
  eyeBtn.addEventListener('click', () => setHidden(!state.hidden));

  let toastTimer = null;
  let saveErrorToast = false; // the visible toast is a "could not save" message
  function showToast(message, isError, sticky) {
    saveErrorToast = false;
    toast.textContent = message;
    toast.classList.toggle('error', Boolean(isError));
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toast.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => toast.classList.remove('show'), isError ? 6000 : 2500);
  }

  function showSaveError(message) {
    showToast(message, true);
    saveErrorToast = true;
  }

  /** Once saving works again, the "could not save" warning is no longer true. */
  function clearSaveError() {
    if (!saveErrorToast) return;
    saveErrorToast = false;
    clearTimeout(toastTimer);
    toast.classList.remove('show');
  }

  function markDead() {
    if (state.dead) return;
    state.dead = true;
    showToast('TabNotes was updated or reloaded. Reload this page to keep saving notes.', true, true);
  }

  // ---- Note view -----------------------------------------------------------

  class NoteView {
    constructor(note) {
      this.note = note;
      this.deleted = false;
      this.confirmTimer = null;
      this.confirming = false;
      this.endGesture = null; // set while a drag/resize is in progress
      this.saver = new NoteSaver({
        snapshot: () => JSON.parse(JSON.stringify(this.note)),
        write: (snapshot) => C.putNote(snapshot),
        remove: () => C.removeNote(this.note.id),
        isFatal: (err) => !contextAlive() || /context invalidated/i.test(String(err && err.message)),
        retryDelay: RETRY_DELAY_MS,
        onStatus: (status, err) => this.onSaveStatus(status, err)
      });
      this.build();
      this.renderAll();
    }

    build() {
      this.grip = el('button', {
        class: 'icon-btn grip', type: 'button',
        'aria-label': 'Move note. Arrow keys move it; hold Shift to move faster.',
        title: 'Drag to move (or focus and use arrow keys)'
      }, [icon('grip')]);
      this.titleInput = el('input', {
        class: 'title', type: 'text', placeholder: 'Untitled note',
        'aria-label': 'Note title', maxlength: String(C.LIMITS.title)
      });
      this.minBtn = el('button', { class: 'icon-btn', type: 'button' });
      this.delBtn = el('button', { class: 'icon-btn del', type: 'button' });
      this.header = el('div', { class: 'header' }, [this.grip, this.titleInput, this.minBtn, this.delBtn]);

      this.textArea = el('textarea', {
        class: 'text', rows: '2', placeholder: 'Write something…',
        'aria-label': 'Note text', maxlength: String(C.LIMITS.text)
      });
      this.list = el('ul', { class: 'items', 'aria-label': 'Checklist' });
      this.addInput = el('input', {
        class: 'add-input', type: 'text', placeholder: '+ Add checklist item',
        'aria-label': 'Add checklist item, press Enter to add', maxlength: String(C.LIMITS.itemText)
      });
      this.body = el('div', { class: 'body' }, [this.textArea, this.list, this.addInput]);

      this.scopeBtn = el('button', { class: 'scope', type: 'button' });
      this.status = el('span', { class: 'status' });
      this.footer = el('div', { class: 'footer' }, [this.scopeBtn, this.status]);

      this.resizer = el('div', {
        class: 'resize', role: 'button', tabindex: '0',
        'aria-label': 'Resize note. Arrow keys change the size.',
        title: 'Drag to resize (or focus and use arrow keys)'
      });

      this.root = el('section', { class: 'note', role: 'region' }, [this.header, this.body, this.footer, this.resizer]);
      this.bind();
    }

    bind() {
      this.titleInput.addEventListener('input', () => {
        this.note.title = this.titleInput.value;
        this.renderLabel();
        this.touch();
      });
      this.textArea.addEventListener('input', () => {
        this.note.text = this.textArea.value;
        this.autosize();
        this.touch();
      });
      this.titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          this.textArea.focus();
        }
      });

      this.addInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        const text = this.addInput.value.trim();
        if (!text) return;
        if (this.addItem(text, this.note.items.length, false)) this.addInput.value = '';
      });

      this.minBtn.addEventListener('click', () => this.setMinimized(!this.note.minimized));
      this.header.addEventListener('dblclick', (e) => {
        if (e.target === this.header) this.setMinimized(!this.note.minimized);
      });

      this.delBtn.addEventListener('click', () => this.onDeleteClick());
      this.delBtn.addEventListener('blur', () => this.cancelDelete());

      this.scopeBtn.addEventListener('click', () => {
        if (this.note.scope === 'site') {
          // Narrowing to "this page" binds the note to the page the user is on now.
          if (!state.keys) return;
          this.note.scope = 'page';
          this.note.pageKey = state.keys.pageKey;
          this.note.href = location.href;
        } else {
          this.note.scope = 'site';
        }
        this.renderScope();
        this.touch();
        refresh();
      });

      this.root.addEventListener('pointerdown', () => this.raise(), true);
      this.root.addEventListener('focusin', () => this.raise());
      this.root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.confirming) {
          e.preventDefault();
          this.cancelDelete();
          this.delBtn.focus();
        }
      });

      this.header.addEventListener('pointerdown', (e) => this.startDrag(e));
      this.grip.addEventListener('keydown', (e) => this.onArrowKey(e, 'move'));
      this.resizer.addEventListener('pointerdown', (e) => this.startResize(e));
      this.resizer.addEventListener('keydown', (e) => this.onArrowKey(e, 'resize'));
    }

    // -- rendering

    renderAll() {
      this.titleInput.value = this.note.title;
      this.textArea.value = this.note.text;
      this.list.textContent = '';
      for (const item of this.note.items) this.list.append(this.buildItem(item));
      this.renderLabel();
      this.renderScope();
      this.renderMinimized();
      this.applyGeometry();
      this.autosize();
      this.onSaveStatus(this.saver.status);
    }

    renderLabel() {
      this.root.setAttribute('aria-label', 'Sticky note: ' + (this.note.title.trim() || 'Untitled'));
    }

    renderScope() {
      const site = this.note.scope === 'site';
      this.scopeBtn.textContent = site ? 'Whole site · ' + this.note.siteKey : 'This page only';
      this.scopeBtn.setAttribute('aria-label',
        site
          ? 'Shown on every page of ' + this.note.siteKey + '. Click to show on this page only.'
          : 'Shown on this page only. Click to show on every page of ' + this.note.siteKey + '.');
      this.scopeBtn.title = site ? 'Click to show on this page only' : 'Click to show on the whole site';
    }

    renderMinimized() {
      const min = this.note.minimized;
      this.root.classList.toggle('min', min);
      setIcon(this.minBtn, min ? 'restore' : 'minimize');
      this.minBtn.setAttribute('aria-label', min ? 'Restore note' : 'Minimize note');
      this.minBtn.setAttribute('aria-expanded', String(!min));
      this.minBtn.title = min ? 'Restore' : 'Minimize';
      this.cancelDelete();
    }

    applyGeometry() {
      const size = clampSize(this.note.w, this.note.h);
      const width = this.note.minimized ? Math.min(size.w, 220) : size.w;
      const pos = clampPos(this.note.x, this.note.y, width);
      this.root.style.left = pos.x + 'px';
      this.root.style.top = pos.y + 'px';
      this.root.style.width = width + 'px';
      this.root.style.height = this.note.minimized ? 'auto' : size.h + 'px';
    }

    autosize() {
      if (!this.root.isConnected) return;
      this.textArea.style.height = 'auto';
      this.textArea.style.height = this.textArea.scrollHeight + 2 + 'px';
    }

    setStatus(text, isError) {
      this.status.textContent = text;
      this.status.classList.toggle('error', Boolean(isError));
    }

    raise() {
      if (this.root.style.zIndex !== String(state.topZ)) this.root.style.zIndex = String(++state.topZ);
    }

    hasFocus() {
      return this.root.contains(shadow.activeElement);
    }

    // -- checklist

    buildItem(item) {
      const li = el('li', { class: 'item' });
      li.classList.toggle('done', item.done);
      const cb = el('input', { type: 'checkbox', 'aria-label': 'Done' });
      cb.checked = item.done;
      const txt = el('input', {
        class: 'itext', type: 'text', 'aria-label': 'Checklist item', maxlength: String(C.LIMITS.itemText)
      });
      txt.value = item.text;
      const rm = el('button', {
        class: 'icon-btn small', type: 'button', 'aria-label': 'Remove checklist item', title: 'Remove item'
      }, [icon('x')]);

      cb.addEventListener('change', () => {
        item.done = cb.checked;
        li.classList.toggle('done', item.done);
        this.touch();
      });
      txt.addEventListener('input', () => {
        item.text = txt.value;
        this.touch();
      });
      txt.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          this.addItem('', this.note.items.indexOf(item) + 1, true);
        } else if (e.key === 'Backspace' && txt.value === '') {
          e.preventDefault();
          this.removeItem(item, li, true);
        }
      });
      rm.addEventListener('click', () => this.removeItem(item, li, false));

      li.append(cb, txt, rm);
      return li;
    }

    addItem(text, index, focus) {
      if (this.note.items.length >= C.LIMITS.items) {
        showToast('This checklist has reached its ' + C.LIMITS.items + '-item limit.', true);
        return false;
      }
      const item = { id: C.makeId(), text, done: false };
      this.note.items.splice(index, 0, item);
      const li = this.buildItem(item);
      this.list.insertBefore(li, this.list.children[index] || null);
      if (focus) li.querySelector('.itext').focus();
      this.touch();
      return true;
    }

    removeItem(item, li, focusPrevious) {
      const idx = this.note.items.indexOf(item);
      if (idx < 0) return;
      const prev = li.previousElementSibling;
      const next = li.nextElementSibling;
      this.note.items.splice(idx, 1);
      li.remove();
      const target = focusPrevious ? prev || next : next || prev;
      (target ? target.querySelector('.itext') : this.addInput).focus();
      this.touch();
    }

    // -- move / resize

    startDrag(e) {
      if (e.button !== 0) return;
      const t = e.target;
      // The title fills most of the header: dragging it moves the note, a plain
      // click starts editing. Once it is being edited it behaves like a normal field.
      const onTitle = t === this.titleInput;
      if (onTitle && shadow.activeElement === this.titleInput) return;
      if ((!onTitle && t.closest('input, textarea')) || (t.closest('button') && !t.closest('.grip'))) return;
      e.preventDefault();
      const onClick = onTitle ? () => this.titleInput.focus() : null;
      this.pointerGesture(e, this.header, 'dragging', this.note.x, this.note.y, (x, y) => {
        const width = this.root.offsetWidth;
        const p = clampPos(x, y, width);
        this.note.x = p.x;
        this.note.y = p.y;
      }, onClick);
    }

    startResize(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      this.pointerGesture(e, this.resizer, 'resizing', this.note.w, this.note.h, (w, h) => {
        const s = clampSize(w, h);
        this.note.w = s.w;
        this.note.h = s.h;
      });
    }

    pointerGesture(e, target, cls, baseA, baseB, apply, onClick) {
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      try {
        target.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      this.root.classList.add(cls);
      // Positions are only applied on screen while moving; one save happens when
      // the gesture ends (pointer up, cancel, lost capture, or page hidden).
      const onMove = (ev) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        moved = true;
        apply(baseA + dx, baseB + dy);
        this.applyGeometry();
      };
      const endEvents = ['pointerup', 'pointercancel', 'lostpointercapture'];
      const onEnd = (ev) => {
        if (this.endGesture !== onEnd) return; // already ended
        this.endGesture = null;
        target.removeEventListener('pointermove', onMove);
        for (const type of endEvents) target.removeEventListener(type, onEnd);
        this.root.classList.remove(cls);
        if (moved) {
          this.autosize();
          this.touch();
        } else if (onClick && ev && ev.type === 'pointerup') {
          onClick();
        }
      };
      if (this.endGesture) this.endGesture();
      this.endGesture = onEnd;
      target.addEventListener('pointermove', onMove);
      for (const type of endEvents) target.addEventListener(type, onEnd);
    }

    onArrowKey(e, mode) {
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = dirs[e.key];
      if (!d) return;
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      if (mode === 'move') {
        const p = clampPos(this.note.x + d[0] * step, this.note.y + d[1] * step, this.root.offsetWidth);
        this.note.x = p.x;
        this.note.y = p.y;
      } else {
        if (this.note.minimized) return;
        const s = clampSize(this.note.w + d[0] * step, this.note.h + d[1] * step);
        this.note.w = s.w;
        this.note.h = s.h;
        this.autosize();
      }
      this.applyGeometry();
      this.touch();
    }

    setMinimized(min) {
      this.note.minimized = min;
      this.renderMinimized();
      this.applyGeometry();
      if (!min) this.autosize();
      this.touch();
    }

    // -- persistence

    /**
     * Records an edit and starts a storage write immediately (see saver.js).
     * Called on every keystroke, checkbox, item change, scope/minimize change,
     * and once at the end of each drag or resize.
     */
    touch() {
      if (this.deleted) return;
      this.note.updatedAt = Math.max(Date.now(), this.note.updatedAt + 1);
      if (state.dead || !contextAlive()) {
        markDead();
        this.setStatus('Not saved', true);
        return;
      }
      this.saver.markChanged();
    }

    /** Commits an unfinished drag and pushes the newest state out right away. */
    flush() {
      if (this.endGesture) this.endGesture();
      this.saver.flushNow();
    }

    onSaveStatus(status, err) {
      if (this.deleted) return;
      if (status === 'saving') {
        this.setStatus('Saving…');
      } else if (status === 'saved') {
        this.setStatus(this.note.updatedAt ? 'Saved' : '');
        if (![...views.values()].some((v) => v.saver.status === 'failed')) clearSaveError();
      } else if (status === 'failed') {
        this.setStatus('Save failed', true);
        if (this.saver.stopped) markDead();
        else showSaveError('TabNotes could not save: ' + C.describeError(err) + ' Retrying…');
      }
    }

    // -- delete

    onDeleteClick() {
      if (!this.confirming) {
        this.confirming = true;
        this.delBtn.classList.add('confirm');
        this.delBtn.textContent = 'Delete?';
        this.delBtn.setAttribute('aria-label', 'Press again to permanently delete this note');
        clearTimeout(this.confirmTimer);
        this.confirmTimer = setTimeout(() => this.cancelDelete(), 4000);
        return;
      }
      this.remove();
    }

    cancelDelete() {
      clearTimeout(this.confirmTimer);
      this.confirming = false;
      this.delBtn.classList.remove('confirm');
      setIcon(this.delBtn, 'trash');
      this.delBtn.setAttribute('aria-label', 'Delete note');
      this.delBtn.title = 'Delete note';
    }

    /** Removes the view only (used when the note was deleted elsewhere). */
    detach() {
      if (this.endGesture) this.endGesture();
      this.deleted = true;
      this.saver.discard();
      const hadFocus = this.hasFocus();
      views.delete(this.note.id);
      this.root.remove();
      updateCount();
      if (hadFocus) fab.focus({ preventScroll: true });
    }

    remove() {
      const id = this.note.id;
      if (state.dead || !contextAlive()) {
        markDead();
        this.cancelDelete();
        return;
      }
      deletedIds.add(id);
      this.detach();
      // Removal is queued after any write still in flight, so it cannot be undone by one.
      this.saver.remove().catch((err) => {
        deletedIds.delete(id);
        this.deleted = false;
        views.set(id, this);
        this.cancelDelete();
        refresh();
        this.saver.restore();
        showToast('TabNotes could not delete the note: ' + C.describeError(err), true);
      });
    }
  }

  // ---- page-level operations ---------------------------------------------

  function mountedViews() {
    return [...views.values()].filter((v) => v.root.isConnected);
  }

  function updateCount() {
    const n = mountedViews().length;
    badge.textContent = n ? String(n) : '';
    fab.setAttribute('aria-label', 'New sticky note. ' + n + (n === 1 ? ' note' : ' notes') + ' on this page.');
    eyeBtn.hidden = n === 0;
  }

  /** Mounts notes that match the current URL and unmounts the rest. */
  function refresh() {
    for (const view of views.values()) {
      const show = !view.deleted && C.noteMatches(view.note, state.keys);
      if (show && !view.root.isConnected) {
        layer.insertBefore(view.root, fabWrap);
        view.applyGeometry();
        view.autosize();
      } else if (!show && view.root.isConnected) {
        view.flush();
        view.root.remove();
      }
    }
    updateCount();
  }

  async function loadNotes() {
    if (!state.keys) return;
    try {
      const notes = await C.getAllNotes();
      for (const note of notes) {
        if (views.has(note.id) || deletedIds.has(note.id)) continue;
        // Re-check against the URL as it is *now*; navigation may have happened during the await.
        if (!C.noteMatches(note, state.keys)) continue;
        views.set(note.id, new NoteView(note));
      }
      refresh();
    } catch (err) {
      if (!contextAlive()) markDead();
      else showToast('TabNotes could not load saved notes: ' + C.describeError(err), true, true);
    }
  }

  function newNote() {
    if (!state.keys) return;
    if (state.dead || !contextAlive()) {
      markDead();
      return;
    }
    if (state.hidden) setHidden(false);
    const vw = viewportW();
    const offset = (mountedViews().length % 6) * 26;
    const size = clampSize(Math.min(DEFAULT_W, vw - 32), DEFAULT_H);
    const pos = clampPos(vw - size.w - 80 - offset, 72 + offset, size.w);
    const note = C.createNote(location.href, state.keys, { x: pos.x, y: pos.y, w: size.w, h: size.h });
    const view = new NoteView(note);
    views.set(note.id, view);
    refresh();
    view.raise();
    view.touch();
    view.titleInput.focus({ preventScroll: true });
  }

  function setHidden(hidden) {
    state.hidden = hidden;
    if (hidden) {
      for (const v of views.values()) v.flush();
      // Move focus out of hidden notes so keyboard users are not stranded.
      if (layer.contains(shadow.activeElement) && !fabWrap.contains(shadow.activeElement)) eyeBtn.focus();
    }
    layer.classList.toggle('hidden', hidden);
    setIcon(eyeBtn, hidden ? 'eyeOff' : 'eye');
    eyeBtn.setAttribute('aria-pressed', String(hidden));
    eyeBtn.setAttribute('aria-label', hidden ? 'Show notes on this page' : 'Hide notes on this page');
    eyeBtn.title = (hidden ? 'Show' : 'Hide') + ' notes on this page (Alt+Shift+H)';
  }

  function setShowFab(show) {
    state.showFab = show !== false;
    fabWrap.classList.toggle('off', !state.showFab);
  }

  function flushAll() {
    for (const v of views.values()) v.flush();
  }

  function status() {
    return {
      ok: true,
      supported: Boolean(state.keys),
      count: mountedViews().length,
      hidden: state.hidden,
      siteKey: state.keys ? state.keys.siteKey : ''
    };
  }

  // ---- SPA navigation ------------------------------------------------------

  function onLocationMaybeChanged() {
    if (location.href === state.href) return;
    state.href = location.href;
    const keys = C.normalizeUrl(location.href);
    if (keys && state.keys && keys.pageKey === state.keys.pageKey) return;
    flushAll(); // persist edits made on the previous route before unmounting
    state.keys = keys;
    refresh(); // views stay cached, so returning to a route reuses unsaved state
    state.ready = loadNotes();
  }

  on(window, 'tabnotes:locationchange', onLocationMaybeChanged);
  on(window, 'popstate', onLocationMaybeChanged);
  on(window, 'hashchange', onLocationMaybeChanged);
  timers.push(setInterval(() => {
    onLocationMaybeChanged(); // fallback for navigations not reported by events
    mountHost();
  }, 1000));

  /** Attaches the UI to the page (again, if the page removed it) and watches for stale copies. */
  function mountHost() {
    const docEl = document.documentElement;
    if (!docEl) return;
    if (!hostEl.isConnected) docEl.append(hostEl);
    removeForeignUi();
    foreignUiObserver.observe(docEl, { childList: true });
  }

  let resizeFrame = 0;
  on(window, 'resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      for (const v of mountedViews()) v.applyGeometry();
    });
  });

  // Every edit is already being written; these hooks only make sure the newest
  // revision has been handed to Chrome before the page can be frozen or torn
  // down. visibilitychange fires first when a tab is closed, switched away from,
  // or the browser is minimized; pagehide/freeze cover navigation and bfcache.
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  on(window, 'pagehide', flushAll);
  on(document, 'freeze', flushAll);

  // ---- cross-tab sync and settings --------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let touched = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key === C.SETTINGS_KEY) {
        setShowFab(!change.newValue || change.newValue.showFab !== false);
        continue;
      }
      if (!key.startsWith(C.NOTE_PREFIX)) continue;
      const id = key.slice(C.NOTE_PREFIX.length);
      const view = views.get(id);
      if (!change.newValue) {
        if (view && !view.deleted) view.detach();
        continue;
      }
      const incoming = C.sanitizeNote(change.newValue);
      if (!incoming || deletedIds.has(id)) continue;
      if (view) {
        // Only accept strictly newer data, and never clobber a note being edited here.
        if (incoming.updatedAt > view.note.updatedAt && view.saver.idle && !view.endGesture && !view.hasFocus()) {
          view.note = incoming;
          view.renderAll();
          view.saver.acceptRemote();
          touched = true;
        }
      } else if (C.noteMatches(incoming, state.keys)) {
        views.set(id, new NoteView(incoming));
        touched = true;
      }
    }
    if (touched) refresh();
  });

  // ---- messages from popup / keyboard shortcuts --------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'tabnotes:ping': // answered at once, even while notes are still loading
        sendResponse({ ok: true, loaded: state.loaded });
        return undefined;
      case 'tabnotes:status':
        state.ready.then(() => sendResponse(status()));
        return true;
      case 'tabnotes:new':
        newNote();
        sendResponse(status());
        return undefined;
      case 'tabnotes:toggle':
        setHidden(!state.hidden);
        sendResponse(status());
        return undefined;
      default:
        return undefined;
    }
  });

  // ---- start -----------------------------------------------------------------

  setHidden(false);
  updateCount();
  mountHost();
  C.getSettings().then((s) => setShowFab(s.showFab)).catch(() => {});
  state.ready = loadNotes().then(() => {
    state.loaded = true;
  });
})();
