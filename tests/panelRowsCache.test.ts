// The rows held between a phone's pages (electron/app/panelRowsCache.cjs): given back only for the history they were made from, and bounded by chats, bytes and idle time (#5379).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelRowsCache, MAX_CHATS, MAX_BYTES, IDLE_MS } = require('../electron/app/panelRowsCache.cjs');

const rows = (n: number, text = 'x') => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, role: 'user', text }));
const entry = (over: object = {}) => ({ rows: rows(3), stamp: 's1', variant: 'v1', omitted: false, ...over });

test('rows come back for the stamp and variant they were made from, and are dropped for any other', () => {
  const cache = createPanelRowsCache();
  cache.set('c', entry());
  assert.deepEqual(cache.get('c', 's1', 'v1'), { rows: rows(3), omitted: false });
  assert.equal(cache.get('c', 's2', 'v1'), null, 'the history changed: an append, a compaction, a rewrite');
  assert.equal(cache.size().chats, 0, 'and what was made from the old one is gone');
  cache.set('c', entry());
  assert.equal(cache.get('c', 's1', 'v2'), null, 'notes or a MoMo chat change what the rows are');
  assert.equal(cache.get('none', 's1', 'v1'), null);
  cache.set('c', entry({ omitted: true }));
  assert.equal(cache.get('c', 's1', 'v1')?.omitted, true);
});

test('a chat held again replaces its rows, and forget lets them go', () => {
  const cache = createPanelRowsCache();
  cache.set('c', entry());
  const before = cache.size().bytes;
  cache.set('c', entry({ rows: rows(6) }));
  assert.deepEqual(cache.size().chats, 1);
  assert.ok(cache.size().bytes > before && cache.size().bytes < 3 * before);
  cache.forget('c');
  assert.deepEqual(cache.size(), { chats: 0, bytes: 0 });
  cache.forget('never held');
  assert.deepEqual(cache.size(), { chats: 0, bytes: 0 });
});

test('the least recently used chat goes first when there are too many, and reading one keeps it', () => {
  const cache = createPanelRowsCache({ maxChats: 2 });
  cache.set('a', entry());
  cache.set('b', entry());
  assert.ok(cache.get('a', 's1', 'v1'));
  cache.set('c', entry());
  assert.equal(cache.get('b', 's1', 'v1'), null, 'b was the least recently used');
  assert.ok(cache.get('a', 's1', 'v1'));
  assert.ok(cache.get('c', 's1', 'v1'));
  assert.ok(MAX_CHATS >= 2);
});

test('the rows held together stay inside the byte bound, and rows over it by themselves are not held', () => {
  const one = JSON.stringify({ id: 'r0', role: 'user', text: 'x'.repeat(100) }).length;
  const cache = createPanelRowsCache({ maxBytes: one * 5 });
  cache.set('a', entry({ rows: rows(2, 'x'.repeat(100)) }));
  cache.set('b', entry({ rows: rows(2, 'x'.repeat(100)) }));
  assert.equal(cache.size().chats, 2);
  cache.set('c', entry({ rows: rows(2, 'x'.repeat(100)) }));
  assert.equal(cache.get('a', 's1', 'v1'), null, 'the oldest goes to make room');
  assert.ok(cache.size().bytes <= one * 5);
  cache.set('big', entry({ rows: rows(9, 'x'.repeat(100)) }));
  assert.equal(cache.get('big', 's1', 'v1'), null);
  assert.ok(MAX_BYTES > 0);
});

test('a chat nobody asked for within the idle time is let go, whether or not anything else is read', () => {
  let at = 1_000;
  const cache = createPanelRowsCache({ idleMs: 100, now: () => at });
  cache.set('a', entry());
  at += 90;
  assert.ok(cache.get('a', 's1', 'v1'), 'read in time: kept, and its time starts again');
  at += 90;
  assert.ok(cache.get('a', 's1', 'v1'));
  cache.set('b', entry());
  at += 150;
  cache.set('c', entry());
  assert.equal(cache.size().chats, 1, 'a and b were idle when c was set');
  assert.equal(cache.get('b', 's1', 'v1'), null);
  assert.ok(IDLE_MS > 0);
});
