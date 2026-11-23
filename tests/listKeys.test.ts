// Stable React keys for lists without ids (src/lib/listKeys.ts): content keys that survive insertions and removals,
// and row ids for lists edited in place, so a removed row's input doesn't show the next row's text.
import { render } from './support/thread-kit.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useState } from 'react';
import { act } from 'react';
import { fingerprint, useRowIds, withKeys } from '../src/lib/listKeys.ts';

const keysOf = (items: string[]) => withKeys(items, (s) => s).map((k) => k.key);

test('withKeys: every key is unique, duplicates included, and each item keeps its position', () => {
  const keyed = withKeys(['a', 'b', 'a', 'a'], (s) => s);
  assert.deepEqual(
    keyed.map(({ item, index }) => [item, index]),
    [
      ['a', 0],
      ['b', 1],
      ['a', 2],
      ['a', 3],
    ],
  );
  assert.equal(new Set(keyed.map((k) => k.key)).size, 4);
  // content that looks like a counted key cannot collide with one
  assert.equal(new Set(keysOf(['x', 'x', '1:x', '0:1:x'])).size, 4);
  assert.deepEqual(
    withKeys([], (s: string) => s),
    [],
  );
});

test('withKeys: inserting or removing a row leaves the other rows their keys (an index key would shift)', () => {
  const before = keysOf(['first', 'second', 'third']);
  const removed = keysOf(['second', 'third']);
  assert.deepEqual(removed, before.slice(1));
  const inserted = keysOf(['zero', 'first', 'second', 'third']);
  assert.deepEqual(inserted.slice(1), before);
});

test('fingerprint: short values stay as they are; long ones become their length and start', () => {
  assert.equal(fingerprint('/tmp/shot.png'), '/tmp/shot.png');
  const long = `data:image/png;base64,${'A'.repeat(500)}`;
  assert.equal(fingerprint(long), `${long.length}:${long.slice(0, 120)}`);
  // equal fingerprints are still told apart by withKeys
  assert.equal(new Set(withKeys([long, long], fingerprint).map((k) => k.key)).size, 2);
});

/** An in-place list of inputs keyed by useRowIds, removing rows as the settings lists do. */
function Lines({ initial }: { initial: string[] }) {
  const [items, setItems] = useState(initial);
  const rows = useRowIds(items.length);
  return h(
    'div',
    null,
    items.map((v, i) =>
      h(
        'div',
        { key: rows.ids[i], className: 'line' },
        h('input', { value: v, readOnly: true }),
        h('button', {
          className: 'remove',
          onClick: () => {
            rows.remove(i);
            setItems(items.filter((_, j) => j !== i));
          },
        }),
      ),
    ),
    h('button', { className: 'add', onClick: () => setItems([...items, '']) }),
    h('button', { className: 'reset', onClick: () => setItems(['x']) }),
  );
}

test('useRowIds: a removed row takes its input with it; the next row keeps its own element', async () => {
  const v = await render(h(Lines, { initial: ['a', 'b', 'c'] }));
  const inputs = v.$$('input') as HTMLInputElement[];
  const [, b, c] = inputs;
  await act(async () => v.$$('.remove')[0].click());
  const after = v.$$('input') as HTMLInputElement[];
  assert.deepEqual(
    after.map((i) => i.value),
    ['b', 'c'],
  );
  // with index keys the first input would have been reused to show "b"
  assert.equal(after[0], b);
  assert.equal(after[1], c);
});

test('useRowIds: an added row gets a new id; a list replaced by a shorter one drops ids from the end', async () => {
  const v = await render(h(Lines, { initial: ['a'] }));
  const a = v.$('input');
  await act(async () => v.$('.add')!.click());
  assert.equal(v.$$('input').length, 2);
  assert.equal(v.$$('input')[0], a);
  await act(async () => v.$('.reset')!.click());
  assert.equal(v.$$('input').length, 1);
  assert.equal(v.$$('input')[0], a, 'the row that is left keeps its id');
  assert.equal((v.$('input') as HTMLInputElement).value, 'x');
});
