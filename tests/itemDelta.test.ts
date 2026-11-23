// A chat's items as a delta (shared/remote/itemDelta.mjs): the tag follows content, only what differs is sent, and a delta that cannot be put together is refused so the phone reads the whole chat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDelta, deltaOf, itemTag, knownOf, KNOWN_ITEMS } from '../shared/remote/itemDelta.mjs';

const item = (id: string, text = id) => ({ id, type: 'agentMessage', text });
const chat = (n: number) => Array.from({ length: n }, (_, i) => item(`i${i}`));

test('a tag follows content, not key order, and changes when the item does', () => {
  assert.equal(
    itemTag({ id: 'a', x: 1, y: { p: 1, q: [2, { b: 1, a: 2 }] } } as any),
    itemTag({ y: { q: [2, { a: 2, b: 1 }], p: 1 }, x: 1, id: 'a' } as any),
  );
  assert.notEqual(itemTag(item('a', 'one')), itemTag(item('a', 'two')));
  assert.match(itemTag(item('a')), /^[0-9a-f]{12}$/);
});

test('known names the last items that have an id', () => {
  const items = [...chat(50), { type: 'x' }, null as any];
  const known = knownOf(items);
  assert.equal(known.length, KNOWN_ITEMS - 2);
  assert.deepEqual(known.at(-1), ['i49', itemTag(item('i49'))]);
  assert.equal(knownOf(items, 3).length, 1);
});

test('nothing new sends no items; new and changed items come whole, in order', () => {
  const held = chat(5);
  assert.deepEqual(deltaOf(held, knownOf(held)), { order: ['i0', 'i1', 'i2', 'i3', 'i4'], changed: [] });
  const now = [...held.slice(0, 3), item('i3', 'grew'), item('i4'), item('i5'), item('i6')];
  const d = deltaOf(now, knownOf(held));
  assert.deepEqual(
    d.changed.map((i: any) => i.id),
    ['i3', 'i5', 'i6'],
  );
  assert.deepEqual(applyDelta(held, d), now);
});

test('a phone that holds nothing is sent everything, and an item with no id always comes', () => {
  const now = [item('a'), { type: 'note', text: 'n' }, item('b')];
  const d = deltaOf(now, []);
  assert.deepEqual(d.order, ['a', null, 'b']);
  assert.equal(d.changed.length, 3);
  assert.deepEqual(applyDelta([], d), now);
  const again = deltaOf(now, knownOf(now));
  assert.deepEqual(again.changed, [{ type: 'note', text: 'n' }]);
  assert.deepEqual(applyDelta(now, again), now);
});

test('a delta that cannot be put together is refused', () => {
  const held = chat(3);
  assert.equal(applyDelta(held, null as any), null);
  assert.equal(applyDelta(held, { order: 'x', changed: [] } as any), null);
  assert.equal(applyDelta(held, { order: ['i0', 'gone'], changed: [] }), null, 'an id the phone does not hold and was not sent');
  assert.equal(applyDelta(held, { order: [null], changed: [] }), null, 'an item with no id that was not sent');
  assert.equal(
    applyDelta(held, { order: ['i0'], changed: [{ type: 'stray' } as any] }),
    null,
    'an item sent that the order does not place',
  );
  assert.deepEqual(applyDelta([{ type: 'no id' } as any, ...held], { order: ['i1'], changed: [] }), [held[1]]);
});
