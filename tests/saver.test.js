// Unit tests for tabnotes/saver.js. Run from the project root:  node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const NoteSaver = require(path.join(__dirname, '..', 'tabnotes', 'saver.js'));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake chrome.storage.local for one note. Each write resolves after `delay()`
 * ms; `failNext` makes writes reject. Records concurrency and landing order.
 */
function fakeStorage({ delay = () => Math.random() * 8 } = {}) {
  const s = {
    value: undefined,
    exists: false,
    landed: [], // revisions in the order they were applied
    started: 0,
    active: 0,
    maxActive: 0,
    fail: 0, // number of upcoming writes that should fail
    failWith: () => new Error('QUOTA_BYTES quota exceeded'),
    write(note) {
      s.started++;
      s.active++;
      s.maxActive = Math.max(s.maxActive, s.active);
      const shouldFail = s.fail > 0 ? (s.fail--, true) : false;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          s.active--;
          if (shouldFail) return reject(s.failWith());
          s.value = note;
          s.exists = true;
          s.landed.push(note.rev);
          resolve();
        }, delay());
      });
    },
    remove() {
      return new Promise((resolve) => setTimeout(() => {
        s.exists = false;
        s.value = undefined;
        resolve();
      }, delay()));
    }
  };
  return s;
}

function setup(opts = {}) {
  const store = fakeStorage(opts);
  const note = { rev: 0, text: '' };
  const statuses = [];
  const saver = new NoteSaver({
    snapshot: () => ({ ...note }),
    write: (n) => store.write(n),
    remove: () => store.remove(),
    retryDelay: opts.retryDelay == null ? 20 : opts.retryDelay,
    isFatal: opts.isFatal,
    onStatus: (s) => statuses.push(s)
  });
  const edit = (text) => {
    note.text = text;
    note.rev++;
    saver.markChanged();
  };
  return { store, note, saver, statuses, edit };
}

test('an edit dispatches a write synchronously (no debounce)', () => {
  const { store, edit } = setup();
  edit('a');
  assert.equal(store.started, 1, 'write must start in the same tick as the edit');
});

test('rapid typing: one write in flight at a time, writes land in order, final value is latest', async () => {
  const { store, saver, note, edit } = setup();
  let text = '';
  for (let i = 0; i < 500; i++) {
    text += String.fromCharCode(97 + (i % 26));
    edit(text);
    if (i % 7 === 0) await tick(Math.random() * 3); // irregular typing rhythm
  }
  await saver.settle();
  assert.equal(store.maxActive, 1, 'queued writes must never overlap');
  assert.deepEqual(store.landed, [...store.landed].sort((a, b) => a - b), 'revisions must land in order');
  assert.equal(store.value.text, text);
  assert.equal(store.value.rev, note.rev);
  assert.ok(store.started < 500, 'edits made during a write are coalesced into the next one');
  assert.equal(saver.status, 'saved');
});

/** Storage whose writes complete only when the test says so. */
function manualSetup() {
  const writes = []; // { note, resolve, reject }
  const stored = { value: undefined };
  const timers = [];
  const note = { text: '' };
  const statuses = [];
  const saver = new NoteSaver({
    snapshot: () => ({ ...note }),
    write: (n) => new Promise((resolve, reject) => {
      writes.push({
        note: n,
        resolve: () => { stored.value = n; resolve(); },
        reject
      });
    }),
    remove: () => Promise.resolve(),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
    onStatus: (s) => statuses.push(s)
  });
  const edit = (text) => {
    note.text = text;
    saver.markChanged();
  };
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));
  return { writes, stored, timers, saver, statuses, edit, flushMicrotasks };
}

test('"saved" is reported only after the latest revision is stored', async () => {
  const { writes, stored, saver, statuses, edit, flushMicrotasks } = manualSetup();
  edit('a');
  edit('ab'); // arrives while 'a' is in flight
  assert.equal(writes.length, 1);
  writes[0].resolve();
  await flushMicrotasks();
  assert.equal(stored.value.text, 'a');
  assert.equal(saver.status, 'saving', 'must not say saved while a newer edit is pending');
  assert.equal(writes.length, 2, 'newer edit is dispatched as soon as the previous write lands');
  writes[1].resolve();
  await flushMicrotasks();
  assert.equal(stored.value.text, 'ab');
  assert.equal(saver.status, 'saved');
  assert.deepEqual(statuses, ['saving', 'saved']);
});

test('rapid checkbox toggles: final stored state matches the last toggle', async () => {
  const store = fakeStorage();
  const note = { rev: 0, items: [{ done: false }, { done: false }] };
  const saver = new NoteSaver({
    snapshot: () => JSON.parse(JSON.stringify(note)),
    write: (n) => store.write(n),
    remove: () => store.remove()
  });
  for (let i = 0; i < 37; i++) {
    note.items[i % 2].done = !note.items[i % 2].done;
    note.rev++;
    saver.markChanged();
    if (i % 3 === 0) await tick(1);
  }
  await saver.settle();
  assert.deepEqual(store.value.items, note.items);
  assert.equal(store.maxActive, 1);
});

test('multiple notes save independently and concurrently', async () => {
  const a = setup();
  const b = setup();
  for (let i = 0; i < 50; i++) {
    a.edit('a' + i);
    b.edit('b' + i);
  }
  await Promise.all([a.saver.settle(), b.saver.settle()]);
  assert.equal(a.store.value.text, 'a49');
  assert.equal(b.store.value.text, 'b49');
});

test('flushNow dispatches the newest snapshot immediately even while a write is in flight', async () => {
  const { store, saver, edit } = setup({ delay: () => 10 });
  edit('a');
  edit('ab'); // queued behind 'a'
  assert.equal(store.started, 1);
  saver.flushNow(); // e.g. visibilitychange -> hidden
  assert.equal(store.started, 2, 'newest must be handed to storage without waiting');
  await saver.settle();
  assert.equal(store.value.text, 'ab');
  assert.equal(saver.status, 'saved');
});

test('flushNow: final value is newest even if storage applies the early copy out of order', async () => {
  // First write is slow, early (out-of-band) copy is fast, so it lands first.
  const delays = [30, 1];
  const { store, saver, edit } = setup({ delay: () => (delays.length ? delays.shift() : 1) });
  edit('a');
  edit('ab');
  saver.flushNow();
  await saver.settle();
  assert.equal(store.value.text, 'ab', 'queue must re-write the newest after the slow write lands');
});

test('flushNow when idle or already up to date does nothing', async () => {
  const { store, saver, edit } = setup();
  saver.flushNow();
  assert.equal(store.started, 0);
  edit('a');
  await saver.settle();
  saver.flushNow();
  assert.equal(store.started, 1);
});

test('storage failure: shows failed, keeps data, retries and recovers', async () => {
  const { writes, stored, timers, saver, statuses, edit, flushMicrotasks } = manualSetup();
  edit('important');
  writes[0].reject(new Error('QUOTA_BYTES quota exceeded'));
  await flushMicrotasks();
  assert.equal(saver.status, 'failed');
  assert.equal(stored.value, undefined);
  assert.equal(timers.filter(Boolean).length, 1, 'a retry is scheduled');

  timers.find(Boolean)(); // retry #1 fails too
  writes[1].reject(new Error('QUOTA_BYTES quota exceeded'));
  await flushMicrotasks();
  assert.equal(saver.status, 'failed');

  timers.filter(Boolean).at(-1)(); // retry #2 succeeds
  assert.equal(saver.status, 'failed', 'still failed until the write actually lands');
  writes[2].resolve();
  await flushMicrotasks();
  assert.equal(stored.value.text, 'important');
  assert.equal(saver.status, 'saved');
  assert.deepEqual(statuses, ['saving', 'failed', 'failed', 'saved']);
});

test('edit after a failure retries immediately instead of waiting for the timer', async () => {
  const { store, saver, edit } = setup({ retryDelay: 10000 });
  store.fail = 1;
  edit('a');
  await tick(10);
  assert.equal(saver.status, 'failed');
  edit('ab');
  await saver.settle();
  assert.equal(store.value.text, 'ab');
  assert.equal(saver.status, 'saved');
  saver.discard(); // clear the long retry timer
});

test('default retry timer works when setTimeout requires the global receiver (as in browsers)', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // Emulate the browser's "Illegal invocation" when called as a method of another object.
  globalThis.setTimeout = function (fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realSetTimeout(fn, ms);
  };
  globalThis.clearTimeout = function (id) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realClearTimeout(id);
  };
  try {
    const store = fakeStorage({ delay: () => 0 });
    store.fail = 1;
    const saver = new NoteSaver({
      snapshot: () => ({ text: 'x' }),
      write: (n) => store.write(n),
      remove: () => store.remove(),
      retryDelay: 1
    });
    saver.markChanged();
    for (let i = 0; i < 100 && saver.status !== 'saved'; i++) await tick(5);
    assert.equal(saver.status, 'saved', 'retry must run and succeed');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('fatal errors (extension reloaded) stop retrying', async () => {
  const { store, saver, edit } = setup({ retryDelay: 5, isFatal: () => true });
  store.fail = 100;
  edit('a');
  await tick(40);
  assert.equal(saver.stopped, true);
  assert.equal(store.started, 1);
});

test('delete waits for in-flight writes so the note is not recreated', async () => {
  const { store, saver, edit } = setup({ delay: () => 10 });
  edit('a');
  edit('ab');
  saver.flushNow();
  await saver.remove();
  await tick(30);
  assert.equal(store.exists, false);
  edit('abc'); // edits after deletion are ignored
  await tick(30);
  assert.equal(store.exists, false);
});

test('failed delete restores saving', async () => {
  const { store, saver, edit } = setup();
  edit('a');
  await saver.settle();
  store.remove = () => Promise.reject(new Error('boom'));
  await assert.rejects(saver.remove());
  saver.restore();
  edit('ab');
  await saver.settle();
  assert.equal(store.value.text, 'ab');
});

test('a write that throws synchronously is reported as a failure', async () => {
  const saver = new NoteSaver({
    snapshot: () => ({}),
    write: () => {
      throw new Error('Extension context invalidated.');
    },
    remove: () => Promise.resolve(),
    isFatal: (e) => /context invalidated/.test(e.message)
  });
  saver.markChanged();
  await saver.settle();
  assert.equal(saver.status, 'failed');
  assert.equal(saver.stopped, true);
});
