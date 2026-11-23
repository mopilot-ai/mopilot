// History page cursors remain on one immutable committed prefix, reject stale bounds, and preserve oversized strings across fragments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPage, createHistoryPages } from '../host/src/historyPage.mjs';
import { parseParams, helloParams, requireFeatures } from '../shared/host/schema.mjs';
import { HISTORY_CHARS } from '../shared/host/history.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
const saved = { generation: 'g', frames: [{ item: { text: 'old' } }, { item: { text: 'new' } }] };
const scope = { chatId: 'c', epoch: 1, generation: 'g', rev: 1, index: 0, offset: 0 };
test('read-only page pins its revision even if newer committed items exist, and empty history finishes', () => {
  assert.equal(historyPage(saved, scope).chunk, '{"text":"old"}\n');
  assert.equal(historyPage(saved, { ...scope, rev: 0 }).next, null);
  assert.equal(historyPage(saved, { ...scope, index: 1 }).chunk, '');
  assert.throws(() => createChatLog({ epoch: () => 1 }).history(scope), /cannot read saved/);
});
test('wrong generation, revision and fragment offsets refuse instead of changing which history is read', () => {
  for (const patch of [{ generation: 'another' }, { rev: 3 }, { index: 2 }, { index: 1, offset: 1 }, { offset: 999 }])
    assert.throws(
      () => historyPage(saved, { ...scope, ...patch }),
      (e: any) => e.code === 'history_changed',
    );
});
test('large Unicode and escaped item fragments join losslessly before the next item begins', () => {
  const value = { text: '🦊"\\\n'.repeat(HISTORY_CHARS) };
  const data = { generation: 'g', frames: [{ item: value }, { item: { end: true } }] };
  let cursor: any = { index: 0, offset: 0 },
    wire = '';
  while (cursor) {
    const page = historyPage(data, { ...scope, rev: 2, ...cursor });
    wire += page.chunk;
    cursor = page.next;
  }
  assert.deepEqual(
    wire
      .trimEnd()
      .split('\n')
      .map((s) => JSON.parse(s)),
    [value, { end: true }],
  );
});
test('history schema requires scoped integer cursors and an explicitly negotiated feature', () => {
  assert.deepEqual(parseParams('chat.history', scope), scope);
  for (const field of ['rev', 'index', 'offset'])
    for (const value of [-1, 1.5, undefined]) assert.throws(() => parseParams('chat.history', { ...scope, [field]: value }), /cursor/);
  for (const generation of [undefined, '', 'bad token', 3])
    assert.throws(() => parseParams('chat.history', { ...scope, generation }), /generation/);
  requireFeatures('chat.history', helloParams(), {});
  assert.throws(() => requireFeatures('chat.history', { features: ['epoch'] }, {}), /historyPages|Update/);
});

test('a journal reuses an item serialization across its fragment requests and rejects oversized items', () => {
  let count = 0;
  const pageOf = createHistoryPages((item: any) => {
    count++;
    return JSON.stringify(item);
  });
  const frames = [{ item: { text: 'a'.repeat(HISTORY_CHARS * 4) } }];
  let cursor: any = { index: 0, offset: 0 };
  while (cursor) cursor = pageOf({ generation: 'g', frames }, { ...scope, ...cursor }).next;
  assert.equal(count, 1);
  pageOf(saved, scope);
  assert.equal(count, 2, 'a changed item invalidates that cursor serialization');
  const tooLarge = createHistoryPages(() => 'x'.repeat(64 * 1024 * 1024 + 1));
  assert.throws(
    () => tooLarge(saved, scope),
    (e: any) => e.code === 'history_too_large',
  );
});

test('two interleaved chat readers each serialize their large item once', () => {
  let encodes = 0;
  const pageOf = createHistoryPages((item: any) => {
    encodes++;
    return JSON.stringify(item);
  });
  const a = { generation: 'g', frames: [{ item: { text: 'a'.repeat(HISTORY_CHARS * 3) } }] };
  const b = { generation: 'g', frames: [{ item: { text: 'b'.repeat(HISTORY_CHARS * 3) } }] };
  let ca: any = { index: 0, offset: 0 },
    cb: any = { index: 0, offset: 0 };
  while (ca || cb) {
    if (ca) ca = pageOf(a, { ...scope, chatId: 'a', ...ca }).next;
    if (cb) cb = pageOf(b, { ...scope, chatId: 'b', ...cb }).next;
  }
  assert.equal(encodes, 2, 'a second chat must not evict a fragment reader on every page');
});

test('history serialization LRU honors both entry and byte caps and refreshes recent entries', () => {
  let count = 0;
  const encode = (item: any) => {
    count++;
    return JSON.stringify(item);
  };
  const frames = [{ item: { text: 'fixed' } }];
  const data = { generation: 'g', frames };
  const pageOf = createHistoryPages(encode, { maxEntries: 2, maxBytes: 1000 });
  const read = (chatId: string) => pageOf(data, { ...scope, chatId });
  read('a');
  read('b');
  read('a');
  read('c');
  read('a');
  assert.equal(count, 3, 'the recently read a entry stays when c replaces b');
  read('b');
  assert.equal(count, 4, 'the evicted b entry must be encoded again');
  count = 0;
  const bytes = createHistoryPages(encode, { maxEntries: 4, maxBytes: 20 });
  bytes(data, { ...scope, chatId: 'a' });
  bytes(data, { ...scope, chatId: 'b' });
  bytes(data, { ...scope, chatId: 'a' });
  assert.equal(count, 3, 'byte pressure evicts even before the entry cap is reached');
  count = 0;
  const uncached = createHistoryPages(encode, { maxBytes: 1 });
  uncached(data, scope);
  uncached(data, scope);
  assert.equal(count, 2, 'an item larger than the cache budget is served without retention');
  const defaults = createHistoryPages(JSON.stringify, {});
  assert.equal(defaults(data, scope).next, null);
});
