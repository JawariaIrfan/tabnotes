// Shared helpers: URL normalization, note shape, and chrome.storage.local access.
// Loaded by the content script, the popup, and the management page.
(function (root) {
  'use strict';

  const NOTE_PREFIX = 'note:';
  const SETTINGS_KEY = 'settings';
  const DEFAULT_SETTINGS = Object.freeze({ showFab: true });

  const LIMITS = Object.freeze({
    title: 200,
    text: 20000,
    items: 200,
    itemText: 500
  });

  // Query parameters that identify a click/campaign, not page content.
  const TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid',
    'yclid', 'twclid', 'ttclid', 'li_fat_id', 'igshid', 'igsh', 'mc_cid',
    'mc_eid', '_ga', '_gl', '_hsenc', '_hsmi', 'mkt_tok', 'vero_id',
    'vero_conv', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid',
    'ref_src', 'ref_url', 'si'
  ]);
  const TRACKING_PREFIXES = ['utm_', 'pk_', 'hsa_', 'mtm_'];

  function isTrackingParam(name) {
    const n = name.toLowerCase();
    return TRACKING_PARAMS.has(n) || TRACKING_PREFIXES.some((p) => n.startsWith(p));
  }

  function isSupportedUrl(href) {
    try {
      const u = new URL(href);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  /**
   * Returns { pageKey, siteKey } for an http(s) URL, or null if unsupported.
   *  - scheme is ignored (http and https share notes)
   *  - host is lowercased; default ports are dropped by URL()
   *  - trailing slash and duplicate slashes in the path are collapsed
   *  - tracking parameters are removed; remaining params are sorted
   *  - the fragment is ignored, EXCEPT hash routes ("#/..." or "#!/...") used
   *    by hash-based single-page apps, which identify real pages
   *  - siteKey is the host without a leading "www."
   */
  function normalizeUrl(href) {
    let u;
    try {
      u = new URL(href);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    const host = u.host.toLowerCase();
    let path = u.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    const params = [];
    for (const [k, v] of u.searchParams) {
      if (!isTrackingParam(k)) params.push([k, v]);
    }
    params.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
    const qs = new URLSearchParams(params).toString();

    let hashRoute = '';
    if (/^#!?\//.test(u.hash)) {
      hashRoute = u.hash.length > 2 && u.hash.endsWith('/') ? u.hash.slice(0, -1) : u.hash;
      if (hashRoute === '#' || hashRoute === '#!') hashRoute = '';
    }

    return {
      pageKey: host + path + (qs ? '?' + qs : '') + hashRoute,
      siteKey: host.replace(/^www\./, '')
    };
  }

  function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function noteMatches(note, keys) {
    if (!note || !keys) return false;
    return note.scope === 'site' ? note.siteKey === keys.siteKey : note.pageKey === keys.pageKey;
  }

  function makeId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Date.now().toString(36) + '-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  function num(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /** Coerces anything read from storage into a well-formed note, or null. */
  function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
    if (typeof raw.pageKey !== 'string' || typeof raw.siteKey !== 'string') return null;
    const items = Array.isArray(raw.items) ? raw.items : [];
    return {
      id: raw.id,
      pageKey: raw.pageKey,
      siteKey: raw.siteKey,
      href: isSupportedUrl(raw.href) ? raw.href : '',
      scope: raw.scope === 'site' ? 'site' : 'page',
      title: str(raw.title, LIMITS.title),
      text: str(raw.text, LIMITS.text),
      items: items
        .slice(0, LIMITS.items)
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({
          id: typeof it.id === 'string' ? it.id : makeId(),
          text: str(it.text, LIMITS.itemText),
          done: it.done === true
        })),
      x: num(raw.x, 40),
      y: num(raw.y, 80),
      w: num(raw.w, 260),
      h: num(raw.h, 240),
      minimized: raw.minimized === true,
      createdAt: num(raw.createdAt, Date.now()),
      updatedAt: num(raw.updatedAt, 0)
    };
  }

  function createNote(href, keys, pos) {
    const now = Date.now();
    return {
      id: makeId(),
      pageKey: keys.pageKey,
      siteKey: keys.siteKey,
      href,
      scope: 'page',
      title: '',
      text: '',
      items: [],
      x: pos.x,
      y: pos.y,
      w: pos.w,
      h: pos.h,
      minimized: false,
      createdAt: now,
      updatedAt: now
    };
  }

  // ---- storage ----------------------------------------------------------

  function storage() {
    if (!root.chrome || !chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage is unavailable');
    }
    return chrome.storage.local;
  }

  async function getAllNotes() {
    const all = await storage().get(null);
    const notes = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(NOTE_PREFIX)) continue;
      const n = sanitizeNote(v);
      if (n) notes.push(n);
    }
    return notes;
  }

  function putNote(note) {
    return storage().set({ [NOTE_PREFIX + note.id]: note });
  }

  function removeNote(id) {
    return storage().remove(NOTE_PREFIX + id);
  }

  async function getSettings() {
    const res = await storage().get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY] || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = Object.assign(current, patch);
    await storage().set({ [SETTINGS_KEY]: next });
    return next;
  }

  function describeError(err) {
    const msg = err && err.message ? err.message : String(err);
    if (/quota/i.test(msg)) return 'Storage is full. Delete some notes to free space.';
    if (/context invalidated/i.test(msg)) return 'TabNotes was updated or reloaded. Reload this page to keep saving.';
    return msg;
  }

  root.TabNotesCommon = Object.freeze({
    NOTE_PREFIX,
    SETTINGS_KEY,
    LIMITS,
    isSupportedUrl,
    normalizeUrl,
    noteMatches,
    makeId,
    sanitizeNote,
    createNote,
    getAllNotes,
    putNote,
    removeNote,
    getSettings,
    saveSettings,
    describeError
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
