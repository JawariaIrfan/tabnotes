'use strict';

const C = globalThis.TabNotesCommon;
const $ = (id) => document.getElementById(id);

let notes = [];

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

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function haystack(note) {
  return [note.title, note.text, note.href, note.pageKey, note.siteKey, ...note.items.map((i) => i.text)]
    .join('\n')
    .toLowerCase();
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) {
    return '';
  }
}

function buildCard(note) {
  const where = note.scope === 'site' ? note.siteKey : note.pageKey;
  const link = C.isSupportedUrl(note.href)
    ? el('a', { href: note.href, target: '_blank', rel: 'noopener noreferrer', text: where })
    : el('span', { text: where });

  const doneCount = note.items.filter((i) => i.done).length;
  const meta = el('div', { class: 'meta' }, [
    el('span', { class: 'pill', text: note.scope === 'site' ? 'Whole site' : 'This page' }),
    note.items.length ? el('span', { text: doneCount + '/' + note.items.length + ' done' }) : null,
    note.minimized ? el('span', { text: 'Minimized' }) : null,
    el('span', { text: 'Edited ' + formatDate(note.updatedAt) })
  ]);

  const checklist = note.items.length
    ? el('ul', null, note.items.slice(0, 5).map((i) => el('li', { class: i.done ? 'done' : '', text: i.text || '(empty)' })))
    : null;
  const more = note.items.length > 5 ? el('span', { class: 'muted', text: '+' + (note.items.length - 5) + ' more items' }) : null;

  const del = el('button', {
    type: 'button',
    class: 'danger',
    text: 'Delete',
    'aria-label': 'Delete note "' + (note.title || 'Untitled') + '"'
  });
  del.addEventListener('click', () => deleteNote(note, del));

  return el('li', { class: 'card' }, [
    el('h2', { text: note.title.trim() || 'Untitled note' }),
    el('div', { class: 'url' }, [link]),
    meta,
    note.text ? el('p', { class: 'preview', text: note.text }) : null,
    checklist,
    more,
    el('div', { class: 'row' }, [del])
  ]);
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const visible = notes
    .filter((n) => {
      if (!terms.length) return true;
      const h = haystack(n);
      return terms.every((t) => h.includes(t));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const list = $('list');
  list.textContent = '';
  for (const n of visible) list.append(buildCard(n));

  const total = notes.length;
  $('summary').textContent = terms.length
    ? visible.length + ' of ' + total + ' notes match'
    : total + (total === 1 ? ' note' : ' notes');

  $('empty').hidden = visible.length > 0;
  $('empty').textContent = total === 0
    ? 'No notes yet. Open any website and click the yellow note button in the bottom-right corner.'
    : 'No notes match your search.';
}

async function load() {
  try {
    notes = await C.getAllNotes();
    showError('');
  } catch (err) {
    showError('Could not read notes from storage: ' + C.describeError(err));
  }
  render();
}

async function deleteNote(note, button) {
  const label = note.title.trim() || 'Untitled note';
  if (!confirm('Delete "' + label + '"? This cannot be undone.')) return;
  button.disabled = true;
  try {
    await C.removeNote(note.id);
    // storage.onChanged reloads the list.
  } catch (err) {
    button.disabled = false;
    showError('Could not delete the note: ' + C.describeError(err));
  }
}

let reloadTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k.startsWith(C.NOTE_PREFIX))) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 150);
});

$('search').addEventListener('input', render);

load();
