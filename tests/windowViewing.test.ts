// What main keeps of each window's view (electron/session/viewing.cjs): a report checked at the boundary, the chats any
// pane shows, and the chat the update restart reopens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseView, shownBy, primaryOf } = require('../electron/session/viewing.cjs');

test('B1/B3: a view report of the wrong shape is no view; ids are kept once, and the primary and focused chats count as shown', () => {
  for (const raw of [null, undefined, 'chat', 7, {}, { visible: 'chat' }, { visible: [] }, { visible: [7, ''], focused: '' }])
    assert.equal(parseView(raw), null);
  assert.deepEqual(parseView({ visible: ['a', 'b', 'a', 3], primary: 'a', focused: 'b', extra: true }), {
    visible: ['a', 'b'],
    primary: 'a',
    focused: 'b',
  });
  assert.deepEqual(parseView({ visible: ['a'], focused: 'side' }), { visible: ['a', 'side'], primary: null, focused: 'side' });
  assert.deepEqual(parseView({ visible: [], primary: 'p', focused: 'a' }), { visible: ['p', 'a'], primary: 'p', focused: 'a' });
  assert.deepEqual(parseView({ visible: ['a'], primary: 4, focused: 5 }), { visible: ['a'], primary: null, focused: null });
});

test("a window answers for every chat its panes show, and the restart reopens its primary pane's chat", () => {
  const viewedBy = new Map([[1, { visible: ['a', 'p'], primary: 'p', focused: 'a' }]]);
  assert.equal(shownBy(viewedBy, 1, 'p'), true);
  assert.equal(shownBy(viewedBy, 1, 'a'), true);
  assert.equal(shownBy(viewedBy, 1, 'b'), false);
  assert.equal(shownBy(viewedBy, 2, 'p'), false);
  assert.equal(primaryOf(viewedBy.get(1)), 'p');
  // home in the primary pane: nothing to reopen, though a split pane shows a chat
  assert.equal(primaryOf({ visible: ['a'], primary: null, focused: 'a' }), undefined);
  assert.equal(primaryOf(undefined), undefined);
});
