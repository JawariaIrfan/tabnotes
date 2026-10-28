// Unit tests for tabnotes/common.js (URL matching and note sanitizing).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require(path.join(__dirname, '..', 'tabnotes', 'common.js'));
const C = globalThis.TabNotesCommon;
const k = (u) => C.normalizeUrl(u);

test('normalizeUrl strips tracking params and fragments, sorts params', () => {
  assert.equal(k('https://Example.com/a/?utm_source=x&b=2&a=1&fbclid=z#frag').pageKey, 'example.com/a?a=1&b=2');
  assert.equal(k('http://example.com:80/').pageKey, 'example.com/');
  assert.equal(k('https://example.com:8443//x//y/').pageKey, 'example.com:8443/x/y');
  assert.equal(k('http://example.com/x').pageKey, k('https://example.com/x').pageKey);
  assert.notEqual(k('https://g.com/search?q=cats').pageKey, k('https://g.com/search?q=dogs').pageKey);
});

test('normalizeUrl keeps hash routes but not anchors', () => {
  assert.equal(k('https://app.io/#/route/a/').pageKey, 'app.io/#/route/a');
  assert.equal(k('https://app.io/#!/r').pageKey, 'app.io/#!/r');
  assert.equal(k('https://app.io/page#section').pageKey, 'app.io/page');
});

test('site keys ignore www. and unsupported URLs return null', () => {
  assert.equal(k('https://www.example.com/x').siteKey, 'example.com');
  assert.equal(k('chrome://extensions'), null);
  assert.equal(k('file:///C:/x.html'), null);
  assert.equal(k('not a url'), null);
});

test('noteMatches respects page and site scope', () => {
  const keys = k('https://www.example.com/p');
  const n = C.createNote('https://www.example.com/p', keys, { x: 1, y: 2, w: 3, h: 4 });
  assert.ok(C.noteMatches(n, keys));
  assert.ok(!C.noteMatches(n, k('https://example.com/q')));
  n.scope = 'site';
  assert.ok(C.noteMatches(n, k('https://example.com/q')));
  assert.ok(!C.noteMatches(n, k('https://docs.example.com/q')));
});

test('sanitizeNote rejects junk and unsafe hrefs', () => {
  assert.equal(C.sanitizeNote({ id: 'x' }), null);
  const n = C.createNote('https://a.com/', k('https://a.com/'), { x: 1, y: 2, w: 3, h: 4 });
  const s = C.sanitizeNote({ ...n, title: 5, items: [{ text: 'a', done: 'yes' }, null], href: 'javascript:alert(1)' });
  assert.equal(s.title, '');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].done, false);
  assert.equal(s.href, '');
});
