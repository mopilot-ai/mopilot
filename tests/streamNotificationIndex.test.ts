// Stream batching's item buckets preserve exact identities, flush ownership and bounded lookup work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamNotifications } from '../src/lib/streamNotifications.ts';

const TEXT = 'item/agentMessage/delta';
const THINK = 'item/reasoning/summaryTextDelta';
type Params = Record<string, unknown>;

function recorder(onDeliver?: (method: string, params: Params) => void) {
  const out: [string, Params][] = [];
  const paints: (() => void)[] = [];
  let cancels = 0;
  const stream = createStreamNotifications(
    (method, params) => {
      out.push([method, params]);
      onDeliver?.(method, params);
    },
    (paint) => {
      paints.push(paint);
      return () => {
        cancels++;
      };
    },
  );
  return {
    ...stream,
    out,
    paints,
    get cancels() {
      return cancels;
    },
  };
}

test('interleaved item lookup does not inspect other item identifiers', () => {
  const stream = recorder();
  let reads = 0;
  const items = 128;
  const rounds = 4;
  for (let round = 0; round < rounds; round++) {
    for (let item = 0; item < items; item++) {
      stream.emit(TEXT, {
        delta: String(round),
        get marker() {
          reads++;
          return true;
        },
        itemId: `item-${item}`,
      });
    }
  }
  assert.ok(reads <= items * rounds, `unrelated item comparisons caused ${reads} reads`);
  assert.equal(stream.paints.length, 1);
  stream.flush();
  assert.equal(stream.out.length, items);
  assert.deepEqual(
    stream.out.map(([, p]) => [p.itemId, p.delta]),
    Array.from({ length: items }, (_, i) => [`item-${i}`, '0123']),
  );
});

test('same item buckets retain every method, chat, turn, index and extra-field distinction', () => {
  const stream = recorder();
  const base = { threadId: 'chat', turnId: 'turn', itemId: 'same', summaryIndex: 0 };
  const records: [string, Params][] = [
    [TEXT, base],
    [THINK, base],
    [TEXT, { ...base, threadId: 'other' }],
    [TEXT, { ...base, turnId: 'other' }],
    [TEXT, { ...base, summaryIndex: 1 }],
    [TEXT, { ...base, optional: undefined }],
    [TEXT, { ...base, another: undefined }],
    [TEXT, { ...base, optional: null }],
  ];
  records.forEach(([method, fields], i) => stream.emit(method, { ...fields, delta: `${i}a` }));
  records.forEach(([method, fields], i) =>
    stream.emit(method, { delta: `${i}b`, ...Object.fromEntries(Object.entries(fields).reverse()) }),
  );
  stream.flush();
  assert.deepEqual(
    stream.out,
    records.map(([method, fields], i) => [method, { ...fields, delta: `${i}a${i}b` }]),
  );
});

test('opaque item keys retain Object.is semantics without serialization', () => {
  const stream = recorder();
  const object = {};
  const cycle: Params = {};
  cycle.self = cycle;
  const symbol = Symbol('item');
  const identifiers = [0, -0, NaN, '0', null, undefined, false, 12n, 'a:b"\\c', '__proto__', object, {}, cycle, symbol, Symbol('item')];
  for (const itemId of identifiers) stream.emit(TEXT, { itemId, delta: 'a' });
  for (const itemId of identifiers) stream.emit(TEXT, { itemId, delta: 'b' });
  stream.flush();
  assert.equal(stream.out.length, identifiers.length);
  identifiers.forEach((itemId, i) => {
    assert.ok(Object.is(stream.out[i][1].itemId, itemId));
    assert.equal(stream.out[i][1].delta, 'ab');
  });
});

test('missing and inherited item identifiers do not invent own identity fields', () => {
  const stream = recorder();
  stream.emit(TEXT, { delta: 'missing' });
  stream.emit(TEXT, { itemId: undefined, delta: 'own' });
  stream.emit(TEXT, Object.assign(Object.create({ itemId: 'inherited-one' }), { delta: '-first' }));
  stream.emit(TEXT, Object.assign(Object.create({ itemId: 'inherited-two' }), { delta: '-second' }));
  stream.emit(TEXT, { itemId: undefined, delta: '-again' });
  stream.flush();
  assert.deepEqual(stream.out, [
    [TEXT, { delta: 'missing-first-second' }],
    [TEXT, { itemId: undefined, delta: 'own-again' }],
  ]);
});

test('Object.is checks also remain authoritative for non-item fields', () => {
  const stream = recorder();
  const ref = {};
  const values = [0, -0, NaN, undefined, null, ref, {}, Symbol('extra')];
  for (const extra of values) stream.emit(TEXT, { itemId: 'shared', extra, delta: 'a' });
  for (const extra of values) stream.emit(TEXT, { extra, delta: 'b', itemId: 'shared' });
  stream.flush();
  assert.equal(stream.out.length, values.length);
  values.forEach((extra, i) => {
    assert.ok(Object.is(stream.out[i][1].extra, extra));
    assert.equal(stream.out[i][1].delta, 'ab');
  });
});

test('non-enumerable item identifiers are ignored like other non-enumerable fields', () => {
  const stream = recorder();
  stream.emit(TEXT, Object.defineProperty({ delta: 'a' }, 'itemId', { value: 'hidden-one' }));
  stream.emit(TEXT, Object.defineProperty({ delta: 'b' }, 'itemId', { value: 'hidden-two' }));
  stream.emit(TEXT, { delta: 'c' });
  stream.flush();
  assert.deepEqual(stream.out, [[TEXT, { delta: 'abc' }]]);
});

test('each flush retires buckets before delivery and reentrant emission starts a fresh batch', () => {
  const stream = recorder((_method, params) => {
    if (params.delta === 'first') stream.emit(TEXT, { itemId: 'same', delta: 'nested' });
  });
  const original = { itemId: 'same', delta: 'first' };
  stream.emit(TEXT, original);
  stream.flush();
  assert.equal(stream.out[0][1].delta, 'first');
  assert.deepEqual(original, { itemId: 'same', delta: 'first' });
  assert.equal(stream.paints.length, 2);
  assert.equal(stream.cancels, 1);
  stream.paints[1]();
  assert.deepEqual(
    stream.out.map(([, p]) => p.delta),
    ['first', 'nested'],
  );
  stream.emit(TEXT, { itemId: 'same', delta: 'third' });
  stream.emit('item/completed', { itemId: 'same' });
  stream.paints[0]();
  stream.flush();
  assert.deepEqual(
    stream.out.map(([method, p]) => [method, p.delta]),
    [
      [TEXT, 'first'],
      [TEXT, 'nested'],
      [TEXT, 'third'],
      ['item/completed', undefined],
    ],
  );
});

test('delivery failure cannot leave stale buckets that absorb later deltas', () => {
  const stream = recorder((_method, params) => {
    if (params.delta === 'throw') throw new Error('delivery failed');
  });
  stream.emit(TEXT, { itemId: 'same', delta: 'throw' });
  stream.emit(TEXT, { itemId: 'other', delta: 'discarded batch tail' });
  assert.throws(() => stream.flush(), /delivery failed/);
  stream.emit(TEXT, { itemId: 'same', delta: 'retry' });
  stream.emit(TEXT, { itemId: 'other', delta: 'fresh' });
  stream.flush();
  assert.deepEqual(
    stream.out.map(([, p]) => p.delta),
    ['throw', 'retry', 'fresh'],
  );
});

test('invalid fragments do not poison buckets or flush valid pending deltas', () => {
  const stream = recorder();
  stream.emit(TEXT, { itemId: 'same', delta: 'a' });
  for (const delta of [null, undefined, 3, [], {}]) stream.emit(TEXT, { itemId: 'same', delta });
  for (const summaryIndex of [-1, 0.5, NaN, 4096, null]) stream.emit(THINK, { itemId: 'same', delta: 'bad', summaryIndex });
  stream.emit(TEXT, { itemId: 'same', delta: '' });
  stream.emit(TEXT, { itemId: 'same', delta: 'b' });
  assert.equal(stream.out.length, 0);
  assert.equal(stream.paints.length, 1);
  stream.flush();
  assert.deepEqual(stream.out, [[TEXT, { itemId: 'same', delta: 'ab' }]]);
});
